import { WAKE_FLOATS_PER_VERTEX } from '../../sim/ships/wake';
import { createModule } from '../gpu-util';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import haze from '../shaders/haze.wgsl?raw';
import noiseChunk from '../shaders/noise.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import type { OceanField } from '../ocean/ocean-field';
import ribbonWgsl from './wake_ribbons.wgsl?raw';

export const MAX_WAKE_VERTICES = 40_000;

export interface WakeRibbonsOptions {
  device: GPUDevice;
  sceneBuffer: GPUBuffer;
  field: OceanField;
  skyView: GPUTexture;
  envSampler: GPUSampler;
  noiseView: GPUTextureView;
  noiseSampler: GPUSampler;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

/**
 * Ship wakes as foam ribbons on the water: a trailing wake, and foam along the hull and bow. Rebuilt on the CPU
 * every frame from the ship's path (a few thousand vertices) and drawn after the ocean with alpha blending.
 */
export class WakeRibbons {
  /** Fill with window-relative vertices (see VertexSink) then call `setVertices`. */
  readonly staging = new Float32Array(MAX_WAKE_VERTICES * WAKE_FLOATS_PER_VERTEX);
  private vertexCount = 0;
  private readonly vertexBuffer: GPUBuffer;

  private constructor(
    private readonly device: GPUDevice,
    private readonly field: OceanField,
    private readonly pipeline: GPURenderPipeline,
    private readonly sceneGroup: GPUBindGroup,
    private readonly envGroup: GPUBindGroup,
    private readonly waveGroups: [GPUBindGroup, GPUBindGroup],
  ) {
    this.vertexBuffer = device.createBuffer({
      label: 'wake-ribbons',
      size: this.staging.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  static async create(opts: WakeRibbonsOptions): Promise<WakeRibbons> {
    const { device, field } = opts;
    const module = await createModule(device, 'wake-ribbons', common, scene, skyMap, env, noiseChunk, haze, ribbonWgsl);
    const pipeline = device.createRenderPipeline({
      label: 'wake-ribbons',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: WAKE_FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32' },
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
            blend: {
              color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
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
    // The shader reads the sky colour for haze (not the cloud LUT), so its layout has bindings 0, 2, 3 and 4.
    const envGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: opts.skyView.createView() },
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
    });
    const waveGroup = (i: number) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 0, resource: field.dispTextures[i]!.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: waveSampler },
        ],
      });
    return new WakeRibbons(device, field, pipeline, sceneGroup, envGroup, [waveGroup(0), waveGroup(1)]);
  }

  /** Upload `count` vertices from `staging`. */
  setVertices(count: number): void {
    this.vertexCount = Math.min(count, MAX_WAKE_VERTICES);
    if (this.vertexCount > 0) {
      this.device.queue.writeBuffer(this.vertexBuffer, 0, this.staging, 0, this.vertexCount * WAKE_FLOATS_PER_VERTEX);
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.vertexCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setBindGroup(1, this.envGroup);
    pass.setBindGroup(2, this.waveGroups[this.field.currentIndex]!);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  destroy(): void {
    this.vertexBuffer.destroy();
  }
}
