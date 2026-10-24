// The frame: sky, FFT sea, MC2 land, surf and wakes, then post-processing.
//
// Taken from the dreadnought game (github.com/griffio/dreadnought-game, src/render/sea-renderer.ts at 5a27af7)
// with the ships, gunnery effects and particles removed, and the MC2 map's ground (map/) added: the land wears
// MC2's pre-lit colour map and the sea shows the sea floor through shallow water.
import { degToRad } from '../math/vec3';
import type { GpuContext } from '../platform/gpu-device';
import { compassToWaveDir, heightFromModes } from '../sim/ocean/spectrum';
import { CASCADE_LENGTHS, DEFAULT_WAVE_SPEC } from '../sim/ocean/waves';
import type { Camera } from './camera';
import { GpuTimer, type GpuTimes } from './gpu-timer';
import type { MapGround } from './map/map-ground';
import { OCEAN_LOOP_SECONDS, OceanField, type FoamSettings } from './ocean/ocean-field';
import { OceanSurface } from './ocean/ocean-surface';
import { PostProcess } from './post/post';
import { SCENE_BYTES, SCENE_AMBIENT_BYTE_OFFSET, SCENE_UPLOAD_FLOATS, SLOT, SceneBlock } from './scene-block';
import { BeamRenderer } from './fx/beams';
import { CombatEffects } from './fx/combat-effects';
import { ParticleSystem } from './fx/particles';
import { ModelRenderer } from './models/model-renderer';
import { ShadowMap, sunShadowMatrix } from './ships/shadow-map';
import { Atmosphere } from './sky/atmosphere';
import { TerrainRenderer } from './terrain/terrain-renderer';
import { SurfLines } from '../sim/terrain/surf';
import type { Terrain } from '../sim/terrain/terrain';
import { WakeRibbons } from './wake/wake-ribbons';
import { buildHullFoam, buildWake, VertexSink, type WakeHistory, type WakeShip } from '../sim/ships/wake';
import { exposureStops, sunlightAt } from './sky/atmosphere-cpu';

export interface SeaParams {
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  /** Wind speed at 10 m (m/s). */
  windSpeed: number;
  /** Compass heading the waves travel toward. */
  waveHeadingDeg: number;
  fetchKm: number;
  cloudCover: number;
  cloudAltitudeM: number;
  /** Cloud drift speed (m/s) along the wave heading. */
  cloudDriftMs: number;
  visibilityKm: number;
  exposureBias: number;
  choppiness: number;
  bloom: number;
  seed: number;
}

export const DEFAULT_SEA: SeaParams = {
  sunElevationDeg: 37,
  sunAzimuthDeg: 34,
  ...DEFAULT_WAVE_SPEC,
  cloudCover: 0.35,
  cloudAltitudeM: 1800,
  cloudDriftMs: 6,
  visibilityKm: 30,
  exposureBias: 0,
  choppiness: 1.0,
  bloom: 0.08,
};

export interface SeaQuality {
  /** FFT resolution per cascade. */
  oceanSize: 128 | 256;
  msaa: 1 | 4;
  /** Anisotropic filtering of the wave textures. */
  anisotropy?: 1 | 2 | 4;
}

const SUN_ANGULAR_RADIUS = 0.00465;
const BASE_EXPOSURE = 3.2;
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const FOAM: FoamSettings = { bias: 0.92, gains: [1.2, 2.2, 0.9], persistence: 3.0 };
/** The sun's shadow map: buildings, trees and units cast into it; the land, the sea and the models receive it. */
const SHADOW_SIZE = 2048;

/** Something that leaves a wake: its path history, hull shape and current state. */
export interface WakeSource {
  history: WakeHistory;
  ship: WakeShip;
  hull: { length: number; halfBreadthAt: (x: number) => number };
  state(): { x: number; z: number; headingDeg: number; speed: number };
}

/** Switches for measuring what each feature costs (the performance survey flips these). */
export interface SeaDebugFlags {
  skipFx: boolean;
  skipProps: boolean;
  skipUnits: boolean;
  skipShadows: boolean;
  skipBloom: boolean;
  freezeOcean: boolean;
  skipOceanDraw: boolean;
  skipSkyDraw: boolean;
  skipClouds: boolean;
  skipTerrain: boolean;
  /** Draw the whole circle of the sea's grid, not only the arc the camera can see. */
  oceanWholeCircle: boolean;
}

/** Wakes farther than this from the camera are not built (they would be a few pixels). */
const WAKE_RANGE_M = 1800;

/** Surf is laid along the shores this far from the camera. */
const SURF_RANGE_M = 4500;

/** Cloud LUT and sky ambient refresh every this many frames: clouds drift a fraction of a degree per second. */
const CLOUD_REFRESH_FRAMES = 4;

export class SeaRenderer {
  params: SeaParams;
  /** Clock (s) the sea, the clouds and the wake ages run on. */
  time = 0;
  /** Pins the sea and clouds at one moment (screenshots, comparisons). */
  frozenTime: number | null = null;
  /**
   * Where the sun's shadow map is centred (world x, z), how far it reaches either side (metres), and how strong the
   * shadows are (0..1, faded out as the camera zooms out); the app sets it each frame. Null: no shadows, no shadow pass.
   */
  shadowFocus: { x: number; z: number; half: number; strength: number } | null = null;
  readonly debug: SeaDebugFlags = {
    skipFx: false,
    skipProps: false,
    skipUnits: false,
    skipShadows: false,
    skipBloom: false,
    freezeOcean: false,
    skipOceanDraw: false,
    skipSkyDraw: false,
    skipClouds: false,
    skipTerrain: false,
    oceanWholeCircle: false,
  };

  private readonly context: GPUCanvasContext;
  private readonly scene = new SceneBlock();
  private readonly sceneBuffer: GPUBuffer;
  private msaaColor: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private msaaView: GPUTextureView | null = null;
  private depthView: GPUTextureView | null = null;
  private width = 1;
  private height = 1;
  private lastSun = { elev: Number.NaN, az: Number.NaN };
  private sunIrr: [number, number, number] = [0, 0, 0];
  private cloudSun: [number, number, number] = [0, 0, 0];
  private skyDirty = true;
  private frameCounter = 0;
  private clock = 0;
  private readonly timer: GpuTimer | null;
  private readonly wakeSources: WakeSource[] = [];
  private readonly wakeSink: VertexSink;
  private surf: SurfLines | null = null;
  private readonly shadowMatrix = new Float32Array(16);
  /** Weapon fire, hits, explosions and smoke. */
  readonly fx: CombatEffects;

  private constructor(
    private readonly gpu: GpuContext,
    canvas: HTMLCanvasElement,
    private readonly quality: SeaQuality,
    private readonly atmosphere: Atmosphere,
    private readonly field: OceanField,
    private readonly surface: OceanSurface,
    private readonly post: PostProcess,
    private readonly wake: WakeRibbons,
    private readonly land: TerrainRenderer,
    /** MC2's buildings, trees, mechs and vehicles. */
    readonly models: ModelRenderer,
    private readonly particles: ParticleSystem,
    private readonly beams: BeamRenderer,
    private readonly shadow: ShadowMap,
    sceneBuffer: GPUBuffer,
    params: SeaParams,
  ) {
    this.params = params;
    this.sceneBuffer = sceneBuffer;
    this.wakeSink = new VertexSink(wake.staging);
    this.fx = new CombatEffects(particles, beams);
    particles.seaHeight = (x, z) => this.waveHeightAt(x, z);
    this.timer = GpuTimer.create(gpu.device);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not acquire a webgpu canvas context');
    this.context = context;
    this.context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
  }

  static async create(gpu: GpuContext, canvas: HTMLCanvasElement, quality: SeaQuality, params: SeaParams = DEFAULT_SEA): Promise<SeaRenderer> {
    const { device } = gpu;
    const sceneBuffer = device.createBuffer({ label: 'scene', size: SCENE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const targets = { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT, sampleCount: quality.msaa };
    const atmosphere = await Atmosphere.create({ device, sceneBuffer, ...targets });
    const field = await OceanField.create({ device, size: quality.oceanSize, lengths: CASCADE_LENGTHS });
    const shadow = new ShadowMap(device, SHADOW_SIZE);
    const env = { skyView: atmosphere.skyView, envSampler: atmosphere.envSampler, noiseView: atmosphere.noiseView, noiseSampler: atmosphere.noiseSampler };
    const surface = await OceanSurface.create({
      device,
      sceneBuffer,
      field,
      cloudLut: atmosphere.cloudLut,
      shadow,
      anisotropy: quality.anisotropy,
      ...env,
      ...targets,
    });
    const wake = await WakeRibbons.create({ device, sceneBuffer, field, ...env, ...targets });
    const land = await TerrainRenderer.create({ device, sceneBuffer, shadow, ...env, ...targets });
    const models = await ModelRenderer.create({ device, sceneBuffer, skyView: atmosphere.skyView, envSampler: atmosphere.envSampler, shadow, ...targets });
    const particles = await ParticleSystem.create({ device, sceneBuffer, ...env, ...targets });
    const beams = await BeamRenderer.create({ device, sceneBuffer, ...targets });
    const post = await PostProcess.create(device, gpu.canvasFormat);
    const renderer = new SeaRenderer(gpu, canvas, quality, atmosphere, field, surface, post, wake, land, models, particles, beams, shadow, sceneBuffer, {
      ...params,
    });
    renderer.regenerateSea();
    return renderer;
  }

  /** Re-seed the wave spectra from the current wind settings (call after changing wind, heading, fetch, seed). */
  regenerateSea(): void {
    const p = this.params;
    this.field.setSea({ windSpeed: p.windSpeed, waveDirRad: compassToWaveDir(p.waveHeadingDeg), fetchM: p.fetchKm * 1000, gamma: 3.3 }, p.seed);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.msaaColor?.destroy();
    this.depth?.destroy();
    const sampleCount = this.quality.msaa;
    this.msaaColor =
      sampleCount > 1
        ? this.gpu.device.createTexture({ label: 'scene-color-msaa', size: [width, height], format: HDR_FORMAT, sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT })
        : null;
    this.depth = this.gpu.device.createTexture({ label: 'scene-depth', size: [width, height], format: DEPTH_FORMAT, sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaView = this.msaaColor?.createView() ?? null;
    this.depthView = this.depth.createView();
    this.post.resize(width, height);
  }

  /** The arc of the sea's grid drawn this frame, and the share of its vertices that is. */
  get oceanArc(): { from: number; count: number; drawnFraction: number } {
    return { ...this.surface.arc, drawnFraction: this.surface.drawnFraction };
  }

  /** Particles and beams alive. */
  get fxCounts(): { particles: number; beams: number } {
    return { particles: this.particles.active, beams: this.beams.active };
  }

  /** Smoothed GPU milliseconds per phase, or null when the device has no timestamp queries. */
  get gpuTimes(): GpuTimes | null {
    return this.timer ? this.timer.times : null;
  }

  addWake(source: WakeSource): void {
    this.wakeSources.push(source);
  }

  removeWake(source: WakeSource): void {
    const i = this.wakeSources.indexOf(source);
    if (i >= 0) this.wakeSources.splice(i, 1);
  }

  /** Put an MC2 map in the world: the land's meshes, the shoreline's surf, and the ground the sea and land are drawn with. */
  setMap(terrain: Terrain, ground: MapGround, surf: SurfLines = new SurfLines(terrain)): void {
    this.land.setTerrain(terrain);
    this.land.setMap(ground);
    this.surface.setMap(ground);
    this.surf = surf;
  }

  /** What the land cost in the last frame: tiles and triangles drawn. */
  get landStats(): { tiles: number; triangles: number } {
    return { tiles: this.land.tilesDrawn, triangles: this.land.trianglesDrawn };
  }

  /** Water surface height (m) at a world position, from the same long waves the GPU renders. */
  waveHeightAt(x: number, z: number): number {
    return heightFromModes(this.field.waveModes, x, z, this.time);
  }

  /** Significant wave height estimate (m) used only for shading; the real field comes from the spectrum. */
  private estimateHs(): number {
    const { windSpeed: u, fetchKm } = this.params;
    const fetchLimited = 0.0016 * u * Math.sqrt((fetchKm * 1000) / 9.81);
    return Math.min(fetchLimited, 0.0246 * u * u);
  }

  frame(dtSeconds: number, camera: Camera): void {
    const { device } = this.gpu;
    const p = this.params;
    this.clock += dtSeconds;
    const now = this.frozenTime ?? this.clock;
    const seaDt = Math.max(now - this.time, 0);
    this.time = now;
    const loopedTime = this.time % OCEAN_LOOP_SECONDS;

    // Sun.
    const e = degToRad(p.sunElevationDeg);
    const a = degToRad(p.sunAzimuthDeg);
    const sunDir: [number, number, number] = [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
    if (p.sunElevationDeg !== this.lastSun.elev || p.sunAzimuthDeg !== this.lastSun.az) {
      this.lastSun = { elev: p.sunElevationDeg, az: p.sunAzimuthDeg };
      this.sunIrr = sunlightAt(2, p.sunElevationDeg);
      this.cloudSun = sunlightAt(p.cloudAltitudeM, p.sunElevationDeg);
      this.skyDirty = true;
    }
    const exposure = BASE_EXPOSURE * 2 ** (exposureStops(p.sunElevationDeg) + p.exposureBias);

    // Scene uniform.
    const s = this.scene;
    const tanY = camera.tanHalfFovY;
    s.mat4(SLOT.viewProj, camera.viewProj);
    s.vec4(SLOT.camRight, ...camera.right, tanY * camera.aspect);
    s.vec4(SLOT.camUp, ...camera.up, tanY);
    s.vec4(SLOT.camFwd, ...camera.forward, camera.near);
    s.vec4(SLOT.camPos, camera.position[0], camera.position[1], camera.position[2], loopedTime);
    s.vec4(SLOT.sunDir, ...sunDir, SUN_ANGULAR_RADIUS);
    s.vec4(SLOT.sunIrr, ...this.sunIrr, exposure);
    s.vec4(SLOT.screen, this.width, this.height, 1 / this.width, 1 / this.height);
    s.vec4(SLOT.ocean, p.choppiness, this.estimateHs(), 0, p.visibilityKm);
    this.field.cascadeUniforms(camera.position[0], camera.position[2]).forEach((row, i) => s.vec4(SLOT.cascade + i, ...row));
    const drift = p.cloudDriftMs * this.time;
    const heading = degToRad(p.waveHeadingDeg);
    s.vec4(SLOT.cloud, p.cloudCover, p.cloudAltitudeM, Math.sin(heading) * drift, -Math.cos(heading) * drift);
    s.vec4(SLOT.cloudSun, ...this.cloudSun, 0);
    s.vec4(SLOT.atmo, Math.sin(e), 1, 0, 0);

    // The sun's shadow, framed on what the camera looks at. The depth range covers the land's heights and whatever stands
    // on it across the box, seen slantwise along the sun.
    const focus = this.shadowFocus;
    const shadowOn = focus !== null && focus.strength > 0 && !this.debug.skipShadows && sunDir[1] > 0.02;
    if (shadowOn) {
      const depthHalf = focus.half * 1.2 + 100;
      sunShadowMatrix(sunDir, [focus.x, 0, focus.z], camera.position, focus.half, depthHalf, SHADOW_SIZE, this.shadowMatrix);
      s.mat4(SLOT.shadowViewProj, this.shadowMatrix);
      const texelWorld = (2 * focus.half) / SHADOW_SIZE;
      s.vec4(SLOT.shadow, Math.min(focus.strength, 1), 1 / SHADOW_SIZE, texelWorld * 2.5, 0.4 / (2 * depthHalf));
    } else {
      s.vec4(SLOT.shadow, 0, 1 / SHADOW_SIZE, 0, 0);
    }

    // Wakes and surf: rebuilt every frame, relative to the camera.
    const sink = this.wakeSink;
    sink.reset();
    sink.originX = camera.position[0];
    sink.originZ = camera.position[2];
    for (const src of this.wakeSources) {
      const st = src.state();
      if (Math.hypot(st.x - camera.position[0], st.z - camera.position[2]) > WAKE_RANGE_M) continue;
      buildWake(sink, src.history, this.time, src.ship);
      buildHullFoam(sink, st.x, st.z, st.headingDeg, {
        length: src.hull.length,
        halfBreadthAt: src.hull.halfBreadthAt,
        speedFraction: Math.min(Math.abs(st.speed) / src.ship.referenceSpeed, 1),
      });
    }
    if (this.surf && !this.debug.skipTerrain) this.surf.emit(sink, camera.position[0], camera.position[2], SURF_RANGE_M, this.time);
    this.wake.setVertices(sink.count);

    device.queue.writeBuffer(this.sceneBuffer, 0, s.data, 0, SCENE_UPLOAD_FLOATS);
    this.land.update(camera);
    // Casters within reach of the shadow box: it is tilted along the sun, so things up-sun of it can still throw shade in.
    const reach = shadowOn ? { x: focus.x, z: focus.z, reach: focus.half * 1.45 + 80 } : null;
    this.models.update(camera, reach, !this.debug.skipUnits, !this.debug.skipProps);
    // Effects age even when they aren't drawn, so they don't pile up meanwhile.
    const drawFx = !this.debug.skipFx;
    this.particles.update(dtSeconds);
    this.beams.update(dtSeconds);
    if (drawFx) {
      this.particles.prepare(camera.position[0], camera.position[1], camera.position[2]);
      this.beams.prepare(camera.position[0], camera.position[1], camera.position[2]);
    }

    // The sea's grid is drawn only where the camera can see it.
    const hs = this.estimateHs();
    this.surface.setView(camera, hs + 1, (hs + 1) * p.choppiness + 1, this.debug.oceanWholeCircle);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const refreshClouds = !this.debug.skipClouds && this.frameCounter % CLOUD_REFRESH_FRAMES === 0;
    if (this.skyDirty || refreshClouds) {
      const skyPass = encoder.beginComputePass({ label: 'sky', timestampWrites: this.timer?.compute('sky') });
      if (this.skyDirty) {
        this.atmosphere.encodeSkyView(skyPass);
        this.skyDirty = false;
      }
      if (refreshClouds) this.atmosphere.encodeCloudsAndAmbient(skyPass);
      skyPass.end();
    }
    if (!this.debug.freezeOcean) {
      const oceanPass = encoder.beginComputePass({ label: 'ocean', timestampWrites: this.timer?.compute('ocean') });
      this.field.encode(oceanPass, loopedTime, p.choppiness, FOAM, seaDt);
      oceanPass.end();
    }
    encoder.copyBufferToBuffer(this.atmosphere.ambientBuffer, 0, this.sceneBuffer, SCENE_AMBIENT_BYTE_OFFSET, 16);

    if (shadowOn) {
      const shadowPass = encoder.beginRenderPass({
        label: 'sun-shadow',
        colorAttachments: [],
        timestampWrites: this.timer?.render('shadow'),
        depthStencilAttachment: { view: this.shadow.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      this.models.drawShadow(shadowPass);
      shadowPass.end();
    }

    const hdrView = this.post.hdrView;
    const msaa = this.msaaColor;
    const pass = encoder.beginRenderPass({
      label: 'scene',
      timestampWrites: this.timer?.render('scene'),
      colorAttachments: [
        {
          view: msaa ? this.msaaView! : hdrView,
          resolveTarget: msaa ? hdrView : undefined,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: msaa ? 'discard' : 'store',
        },
      ],
      depthStencilAttachment: { view: this.depthView!, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    if (!this.debug.skipSkyDraw) this.atmosphere.drawSky(pass);
    if (!this.debug.skipOceanDraw) this.surface.draw(pass);
    if (!this.debug.skipTerrain) this.land.draw(pass);
    this.models.draw(pass);
    // Foam is blended over the sea after everything solid, tested against the land's and the models' depth.
    this.wake.draw(pass);
    if (drawFx) {
      this.particles.draw(pass);
      this.beams.draw(pass);
    }
    pass.end();

    this.post.encode(encoder, this.context.getCurrentTexture().createView(), exposure, p.bloom, this.timer, !this.debug.skipBloom);
    this.timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer?.afterSubmit();
    this.frameCounter++;
  }
}
