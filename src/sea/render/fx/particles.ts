import { createModule } from '../gpu-util';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import haze from '../shaders/haze.wgsl?raw';
import noiseChunk from '../shaders/noise.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import particlesWgsl from './particles.wgsl?raw';

export const MAX_PARTICLES = 4096;
/** Glows placed afresh every world update (missile heads), drawn after the particles. */
const MAX_TRANSIENT = 512;
const TRANSIENT_FLOATS = 8;
const FLOATS_PER_INSTANCE = 12;

export const PUFF = 0;
export const GLOW = 1;
/** A flat film lying on the water (an oil slick): drawn as a horizontal ragged patch, not a billboard. */
export const FILM = 2;

/** Groups of particles that can be switched off together: the default layer is always drawn. */
export const LAYER_DEFAULT = 0;
export const LAYER_FUNNEL = 1;
export const LAYER_GUNSMOKE = 2;
const LAYERS = 4;
/** How quickly a layer fades out or back in, per second. */
const LAYER_FADE_RATE = 3;

/** What to spawn. Positions are world metres (float64); velocities m/s; colours linear. */
export interface ParticleDesc {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Diameter at birth and at death, metres. */
  size0: number;
  size1: number;
  life: number;
  r: number;
  g: number;
  b: number;
  /** Puff opacity, or glow intensity. */
  alpha: number;
  kind?: typeof PUFF | typeof GLOW | typeof FILM;
  /** Velocity decay, 1/s. */
  drag?: number;
  /** Downward acceleration, m/s^2 (negative rises). */
  gravity?: number;
  /** How quickly the particle is carried to the wind's velocity, 1/s. */
  wind?: number;
  spin?: number;
  /** Seconds to fade in, and the exponent of the fade-out. */
  fadeIn?: number;
  fadePow?: number;
  /** Kill the particle when it reaches the sea (spray falling back). */
  dieAtSea?: boolean;
  /** Which layer it belongs to (default LAYER_DEFAULT). */
  layer?: number;
  /** Ride the sea: its height is the water's here, plus this many metres (its vertical motion is ignored). For what floats. */
  seaOffset?: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size0: number;
  size1: number;
  age: number;
  life: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  kind: number;
  drag: number;
  gravity: number;
  wind: number;
  rot: number;
  spin: number;
  fadeIn: number;
  fadePow: number;
  dieAtSea: boolean;
  layer: number;
  seed: number;
  d2: number;
  /** Height above the water it floats at, or NaN when it does not ride the sea. */
  float: number;
}

export interface ParticleSystemOptions {
  device: GPUDevice;
  sceneBuffer: GPUBuffer;
  skyView: GPUTexture;
  envSampler: GPUSampler;
  noiseView: GPUTextureView;
  noiseSampler: GPUSampler;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

/**
 * CPU-simulated particles drawn as instanced billboards. A few thousand at most, so the simulation and the per-frame
 * upload are cheap, and the sorting back to front that alpha blending needs is done here too. Dead particles are kept
 * for reuse, so a busy battle doesn't make garbage for the collector to stop the page over.
 */
export class ParticleSystem {
  /** Wind velocity the smoke and spray are carried along at, m/s. */
  wind: [number, number] = [0, 0];
  /** The height of the water at a point, for the particles that float on it. */
  seaHeight: ((x: number, z: number) => number) | null = null;

  private readonly live: Particle[] = [];
  private readonly pool: Particle[] = [];
  /** Where the search for a particle to give way starts when the system is full; it rolls on. */
  private evictAt = 0;
  private readonly transient = new Float64Array(MAX_TRANSIENT * TRANSIENT_FLOATS);
  private transientCount = 0;
  private readonly staging = new Float32Array((MAX_PARTICLES + MAX_TRANSIENT) * FLOATS_PER_INSTANCE);
  private readonly buffer: GPUBuffer;
  private count = 0;
  private seedCounter = 1;
  /** How much of each layer shows now and how much it is heading for, 0..1. */
  private readonly layerShown = new Array<number>(LAYERS).fill(1);
  private readonly layerWanted = new Array<number>(LAYERS).fill(1);

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly sceneGroup: GPUBindGroup,
    private readonly envGroup: GPUBindGroup,
  ) {
    this.buffer = device.createBuffer({
      label: 'particles',
      size: this.staging.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  static async create(opts: ParticleSystemOptions): Promise<ParticleSystem> {
    const { device } = opts;
    const module = await createModule(device, 'particles', common, scene, skyMap, env, noiseChunk, haze, particlesWgsl);
    const pipeline = device.createRenderPipeline({
      label: 'particles',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: FLOATS_PER_INSTANCE * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x4' },
              { shaderLocation: 2, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: opts.colorFormat,
            // Premultiplied: puffs return (rgb * a, a); glows return (rgb, 0) and so add light without hiding anything.
            blend: {
              color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: opts.sampleCount },
    });
    const sceneGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: opts.sceneBuffer } }],
    });
    const envGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: opts.skyView.createView() },
        { binding: 2, resource: opts.envSampler },
        { binding: 3, resource: opts.noiseView },
        { binding: 4, resource: opts.noiseSampler },
      ],
    });
    return new ParticleSystem(device, pipeline, sceneGroup, envGroup);
  }

  get active(): number {
    return this.live.length;
  }

  /** How many particles went into the last frame's draw (those of a hidden layer do not). */
  get drawn(): number {
    return this.count;
  }

  /** Fade a layer out or back in. */
  setLayerVisible(layer: number, visible: boolean): void {
    this.layerWanted[layer] = visible ? 1 : 0;
  }

  clear(): void {
    for (const p of this.live) this.pool.push(p);
    this.live.length = 0;
    this.count = 0;
    this.transientCount = 0;
  }

  spawn(d: ParticleDesc): void {
    let p: Particle;
    if (this.live.length >= MAX_PARTICLES) {
      p = this.victim();
    } else {
      p = this.pool.pop() ?? newParticle();
      this.live.push(p);
    }
    p.x = d.x;
    p.y = d.y;
    p.z = d.z;
    p.vx = d.vx ?? 0;
    p.vy = d.vy ?? 0;
    p.vz = d.vz ?? 0;
    p.size0 = d.size0;
    p.size1 = d.size1;
    p.age = 0;
    p.life = d.life;
    p.r = d.r;
    p.g = d.g;
    p.b = d.b;
    p.alpha = d.alpha;
    p.kind = d.kind ?? PUFF;
    p.drag = d.drag ?? 0;
    p.gravity = d.gravity ?? 0;
    p.wind = d.wind ?? 0;
    p.rot = (this.seedCounter * 2.399963) % (Math.PI * 2);
    p.spin = d.spin ?? 0;
    p.fadeIn = d.fadeIn ?? 0;
    p.fadePow = d.fadePow ?? 1;
    p.dieAtSea = d.dieAtSea ?? false;
    p.layer = d.layer ?? LAYER_DEFAULT;
    p.seed = (this.seedCounter++ * 0.6180339887) % 1;
    p.d2 = 0;
    p.float = d.seaOffset ?? Number.NaN;
  }

  /** Full: of a few particles from a rolling start, the one furthest through its life gives way (no list shifting). */
  private victim(): Particle {
    const live = this.live;
    const n = live.length;
    let best = live[this.evictAt % n]!;
    for (let k = 1; k < 4; k++) {
      const p = live[(this.evictAt + k) % n]!;
      if (p.age / p.life > best.age / best.life) best = p;
    }
    this.evictAt = (this.evictAt + 4) % n;
    return best;
  }

  /** Forget the glows added since the last call (a missile's head is placed afresh every world update). */
  clearTransients(): void {
    this.transientCount = 0;
  }

  /** A glow drawn as it is until clearTransients(), with no simulation and nothing kept: a missile's head. */
  addTransientGlow(x: number, y: number, z: number, size: number, r: number, g: number, b: number, brightness: number): void {
    if (this.transientCount >= MAX_TRANSIENT) return;
    const t = this.transient;
    const o = this.transientCount++ * TRANSIENT_FLOATS;
    t[o] = x;
    t[o + 1] = y;
    t[o + 2] = z;
    t[o + 3] = size;
    t[o + 4] = r;
    t[o + 5] = g;
    t[o + 6] = b;
    t[o + 7] = brightness;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    for (let i = 0; i < LAYERS; i++) {
      const step = LAYER_FADE_RATE * dt;
      this.layerShown[i] = this.layerShown[i]! + Math.min(Math.max(this.layerWanted[i]! - this.layerShown[i]!, -step), step);
    }
    const [wx, wz] = this.wind;
    let w = 0;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.pool.push(p);
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      p.vz *= k;
      if (p.wind > 0) {
        const c = 1 - Math.exp(-p.wind * dt);
        p.vx += (wx - p.vx) * c;
        p.vz += (wz - p.vz) * c;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
      if (p.float === p.float) p.y = (this.seaHeight ? this.seaHeight(p.x, p.z) : 0) + p.float;
      else if (p.dieAtSea && p.y < 0 && p.vy < 0) {
        this.pool.push(p);
        continue;
      }
      this.live[w++] = p;
    }
    this.live.length = w;
  }

  /** Pack, sort back to front and upload for this frame's camera. */
  prepare(camX: number, camY: number, camZ: number): void {
    const live = this.live;
    for (const p of live) {
      const dx = p.x - camX;
      const dy = p.y - camY;
      const dz = p.z - camZ;
      p.d2 = dx * dx + dy * dy + dz * dz;
    }
    live.sort((a, b) => b.d2 - a.d2);
    const f = this.staging;
    let o = 0;
    let n = 0;
    for (const p of live) {
      const shown = this.layerShown[p.layer]!;
      if (shown <= 0.004) continue;
      n++;
      const t = p.age / p.life;
      const ease = 1 - (1 - t) * (1 - t);
      const fade = (p.fadeIn > 0 ? Math.min(p.age / p.fadeIn, 1) : 1) * Math.pow(1 - t, p.fadePow);
      f[o++] = p.x - camX;
      f[o++] = p.y - camY;
      f[o++] = p.z - camZ;
      f[o++] = p.size0 + (p.size1 - p.size0) * ease;
      f[o++] = p.r;
      f[o++] = p.g;
      f[o++] = p.b;
      f[o++] = p.alpha * fade * shown;
      f[o++] = p.rot;
      f[o++] = p.kind;
      f[o++] = p.seed;
      f[o++] = 0;
    }
    // The transient glows go last, unsorted: they are additive, so only a puff in front of one would be wrong (it shows
    // through), and a missile's head barely lasts long enough to be seen that way.
    const t = this.transient;
    for (let i = 0; i < this.transientCount; i++) {
      const s = i * TRANSIENT_FLOATS;
      f[o++] = t[s]! - camX;
      f[o++] = t[s + 1]! - camY;
      f[o++] = t[s + 2]! - camZ;
      f[o++] = t[s + 3]!;
      f[o++] = t[s + 4]!;
      f[o++] = t[s + 5]!;
      f[o++] = t[s + 6]!;
      f[o++] = t[s + 7]!;
      f[o++] = 0;
      f[o++] = GLOW;
      f[o++] = (i * 0.6180339887) % 1;
      f[o++] = 0;
      n++;
    }
    this.count = n;
    if (this.count > 0) this.device.queue.writeBuffer(this.buffer, 0, f, 0, this.count * FLOATS_PER_INSTANCE);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setBindGroup(1, this.envGroup);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(6, this.count);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

function newParticle(): Particle {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size0: 0, size1: 0, age: 0, life: 0, r: 0, g: 0, b: 0, alpha: 0, kind: PUFF, drag: 0,
    gravity: 0, wind: 0, rot: 0, spin: 0, fadeIn: 0, fadePow: 1, dieAtSea: false, layer: LAYER_DEFAULT, seed: 0, d2: 0, float: Number.NaN,
  };
}
