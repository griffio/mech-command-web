// Laser and PPC beams (see beams.wgsl): short-lived, a few hundred at most, rebuilt and uploaded each frame.
import { createModule } from '../gpu-util';
import common from '../shaders/common.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import beamsWgsl from './beams.wgsl?raw';

export interface BeamDesc {
  /** World metres. */
  from: [number, number, number];
  to: [number, number, number];
  width: number;
  /** Linear colour, and brightness (1 = sunlit white). */
  color: [number, number, number];
  brightness: number;
  /** Seconds the beam lasts; it fades over the last third. */
  life: number;
  /** How narrow the white core is (larger is narrower). */
  core?: number;
}

const MAX_BEAMS = 256;
const FLOATS = 12;

export class BeamRenderer {
  private readonly beams: (BeamDesc & { age: number })[] = [];
  private readonly staging = new Float32Array(MAX_BEAMS * FLOATS);
  private readonly buffer: GPUBuffer;
  private count = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly sceneGroup: GPUBindGroup,
  ) {
    this.buffer = device.createBuffer({ label: 'beams', size: this.staging.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  static async create(opts: {
    device: GPUDevice;
    sceneBuffer: GPUBuffer;
    colorFormat: GPUTextureFormat;
    depthFormat: GPUTextureFormat;
    sampleCount: number;
  }): Promise<BeamRenderer> {
    const { device } = opts;
    const module = await createModule(device, 'beams', common, scene, beamsWgsl);
    const pipeline = device.createRenderPipeline({
      label: 'beams',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: FLOATS * 4,
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
            blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample: { count: opts.sampleCount },
    });
    const sceneGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: opts.sceneBuffer } }] });
    return new BeamRenderer(device, pipeline, sceneGroup);
  }

  add(beam: BeamDesc): void {
    if (this.beams.length >= MAX_BEAMS) this.beams.shift();
    this.beams.push({ ...beam, age: 0 });
  }

  update(dt: number): void {
    let w = 0;
    for (const b of this.beams) {
      b.age += dt;
      if (b.age < b.life) this.beams[w++] = b;
    }
    this.beams.length = w;
  }

  /** Pack this frame's beams relative to the camera and upload them. */
  prepare(camX: number, camY: number, camZ: number): void {
    const f = this.staging;
    let o = 0;
    for (const b of this.beams) {
      const t = b.age / b.life;
      const fade = t < 2 / 3 ? 1 : 1 - (t - 2 / 3) * 3;
      f.set(
        [
          b.from[0] - camX, b.from[1] - camY, b.from[2] - camZ, b.width,
          b.to[0] - camX, b.to[1] - camY, b.to[2] - camZ, b.brightness * fade,
          b.color[0], b.color[1], b.color[2], b.core ?? 12,
        ],
        o,
      );
      o += FLOATS;
    }
    this.count = this.beams.length;
    if (this.count) this.device.queue.writeBuffer(this.buffer, 0, f, 0, this.count * FLOATS);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.count) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(6, this.count);
  }
}
