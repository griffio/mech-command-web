import { createModule } from '../gpu-util';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import haze from '../shaders/haze.wgsl?raw';
import noiseChunk from '../shaders/noise.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import shadowChunk from '../shaders/shadow.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import mapWgsl from '../map/map.wgsl?raw';
import { MapGround } from '../map/map-ground';
import type { ShadowMap } from '../ships/shadow-map';
import type { Camera } from '../camera';
import { visibleArc, type Arc } from './ocean-cull';
import type { OceanField } from './ocean-field';
import surfaceWgsl from './ocean_surface.wgsl?raw';

// Keep in sync with ocean_surface.wgsl.
const GRID_SEGS = 384;
const NEAR_RINGS = 64;
const NEAR_R0 = 2;
const FAR_GROWTH = 1.0235;
const MAX_RADIUS = 40_000;
/** Bands of quads nearest the camera that are always drawn whole: displaced vertices this near can swing far round in azimuth. */
const NEAR_FULL_BANDS = 16;

export interface OceanSurfaceOptions {
  device: GPUDevice;
  sceneBuffer: GPUBuffer;
  field: OceanField;
  skyView: GPUTexture;
  cloudLut: GPUTexture;
  envSampler: GPUSampler;
  noiseView: GPUTextureView;
  noiseSampler: GPUSampler;
  shadow: ShadowMap;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
  /** Anisotropic filtering of the wave textures (1, 2 or 4): the main cost of looking along the sea at the horizon. */
  anisotropy?: number;
}

function ringCount(): number {
  let rings = NEAR_RINGS;
  let r = NEAR_R0 + NEAR_RINGS;
  while (r < MAX_RADIUS) {
    r *= FAR_GROWTH;
    rings++;
  }
  return rings + 1;
}

export class OceanSurface {
  private readonly indexBuffer: GPUBuffer;
  /** Indices of the near bands (ring-major, drawn whole), then of the far bands laid out segment by segment (a column of quads each). */
  private readonly nearCount: number;
  private readonly farStride: number;
  private readonly nearBands: number;
  /** The segments of the far bands drawn this frame. */
  arc: Arc = { from: 0, count: GRID_SEGS };
  private groundGroup: GPUBindGroup;

  private constructor(
    device: GPUDevice,
    private readonly field: OceanField,
    private readonly pipeline: GPURenderPipeline,
    private readonly sceneGroup: GPUBindGroup,
    private readonly envGroup: GPUBindGroup,
    private readonly waveGroups: [GPUBindGroup, GPUBindGroup],
    private readonly makeGroundGroup: (map: MapGround) => GPUBindGroup,
    map: MapGround,
  ) {
    this.groundGroup = makeGroundGroup(map);
    const rings = ringCount();
    const bands = rings - 1;
    const indices = new Uint32Array(bands * GRID_SEGS * 6);
    let o = 0;
    const quad = (i: number, j: number): void => {
      const j1 = (j + 1) % GRID_SEGS;
      const v00 = i * GRID_SEGS + j;
      const v01 = i * GRID_SEGS + j1;
      const v10 = (i + 1) * GRID_SEGS + j;
      const v11 = (i + 1) * GRID_SEGS + j1;
      indices.set([v00, v10, v01, v01, v10, v11], o);
      o += 6;
    };
    // The near bands ring by ring, then the far bands segment by segment, so that an arc of the circle is one or two index ranges.
    this.nearBands = Math.min(NEAR_FULL_BANDS, bands);
    for (let i = 0; i < this.nearBands; i++) for (let j = 0; j < GRID_SEGS; j++) quad(i, j);
    this.nearCount = o;
    for (let j = 0; j < GRID_SEGS; j++) for (let i = this.nearBands; i < bands; i++) quad(i, j);
    this.farStride = (bands - this.nearBands) * 6;
    this.indexBuffer = device.createBuffer({
      label: 'ocean-indices',
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);
  }

  static async create(opts: OceanSurfaceOptions): Promise<OceanSurface> {
    const { device, field } = opts;
    const module = await createModule(device, 'ocean-surface', common, scene, skyMap, env, noiseChunk, haze, shadowChunk, mapWgsl, surfaceWgsl);
    const pipeline = device.createRenderPipeline({
      label: 'ocean-surface',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: opts.colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
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
        { binding: 1, resource: opts.cloudLut.createView() },
        { binding: 2, resource: opts.envSampler },
        { binding: 3, resource: opts.noiseView },
        { binding: 4, resource: opts.noiseSampler },
      ],
    });
    const waveSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: opts.anisotropy ?? 4,
    });
    const arrayView = (t: GPUTexture) => t.createView({ dimension: '2d-array' });
    const waveGroup = (i: number) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 0, resource: arrayView(field.dispTextures[i]!) },
          { binding: 1, resource: arrayView(field.derivTexture) },
          { binding: 2, resource: waveSampler },
        ],
      });
    // Group 3: the sun's shadow map, then the map's ground (the sea floor seen through shallow water).
    const makeGroundGroup = (map: MapGround) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(3),
        entries: [{ binding: 0, resource: opts.shadow.view }, { binding: 1, resource: opts.shadow.sampler }, ...map.entries()],
      });
    return new OceanSurface(device, field, pipeline, sceneGroup, envGroup, [waveGroup(0), waveGroup(1)], makeGroundGroup, MapGround.empty(device));
  }

  /** The ground under the sea: its heights decide where the sea floor shows through. */
  setMap(map: MapGround): void {
    this.groundGroup = this.makeGroundGroup(map);
  }

  /**
   * Settle which arc of the grid the camera can see this frame (call before `draw`). `waveAmplitude` bounds the sea's rise and fall and
   * `maxSideways` how far the waves carry a vertex horizontally, both in metres; `wholeCircle` draws all of it (for comparison).
   */
  setView(camera: Camera, waveAmplitude: number, maxSideways: number, wholeCircle = false): void {
    this.arc = wholeCircle
      ? { from: 0, count: GRID_SEGS }
      : visibleArc({
          forward: camera.forward,
          tanHalfFovY: camera.tanHalfFovY,
          aspect: camera.aspect,
          cameraHeight: camera.position[1],
          waveAmplitude,
          maxSideways,
          innerRadius: NEAR_R0 + this.nearBands,
          segments: GRID_SEGS,
        });
  }

  /** The share of the grid's vertices drawn this frame, 0..1. */
  get drawnFraction(): number {
    const total = this.nearCount + GRID_SEGS * this.farStride;
    return (this.nearCount + this.arc.count * this.farStride) / total;
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setBindGroup(1, this.envGroup);
    pass.setBindGroup(2, this.waveGroups[this.field.currentIndex]!);
    pass.setBindGroup(3, this.groundGroup);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    // The near sea all round, then the arc of the far sea the camera can see (in two pieces when it wraps past the last segment).
    pass.drawIndexed(this.nearCount);
    const { from, count } = this.arc;
    if (count <= 0) return;
    const base = this.nearCount;
    const stride = this.farStride;
    if (count >= GRID_SEGS) {
      pass.drawIndexed(GRID_SEGS * stride, 1, base);
      return;
    }
    const first = Math.min(count, GRID_SEGS - from);
    pass.drawIndexed(first * stride, 1, base + from * stride);
    if (count > first) pass.drawIndexed((count - first) * stride, 1, base);
  }

  destroy(): void {
    this.indexBuffer.destroy();
  }
}
