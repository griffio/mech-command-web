import type { GpuTimer } from '../gpu-timer';
import { createModule } from '../gpu-util';
import postWgsl from './post.wgsl?raw';

/** Level 0 is a quarter of the screen (one 4x4 downsample pass), then halving: fewer, cheaper passes. */
const BLOOM_LEVELS = 4;
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

interface PassBinding {
  uniform: GPUBuffer;
  bindGroup: GPUBindGroup;
}

/** HDR scene target, dual-filter bloom, and the AgX tone-mapped composite to the swapchain. */
export class PostProcess {
  hdrTexture!: GPUTexture;
  private bloom: GPUTexture[] = [];
  private bloomViews: GPUTextureView[] = [];
  private down: PassBinding[] = [];
  private up: PassBinding[] = [];
  private composite!: PassBinding;
  private readonly uniformData = new Float32Array(8);
  private size: [number, number] = [0, 0];
  private hdrSceneView!: GPUTextureView;
  /** What the pass uniforms were last written with; they are written again only when it changes (or the targets are remade). */
  private written: { exposure: number; bloom: number; composite: number } | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly sampler: GPUSampler,
    private readonly downFirst: GPURenderPipeline,
    private readonly downPipeline: GPURenderPipeline,
    private readonly upPipeline: GPURenderPipeline,
    private readonly compositePipeline: GPURenderPipeline,
  ) {}

  static async create(device: GPUDevice, canvasFormat: GPUTextureFormat): Promise<PostProcess> {
    const module = await createModule(device, 'post', postWgsl);
    const fragmentStage = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: fragmentStage, buffer: { type: 'uniform' } },
        { binding: 1, visibility: fragmentStage, texture: { sampleType: 'float' } },
        { binding: 2, visibility: fragmentStage, sampler: { type: 'filtering' } },
        { binding: 3, visibility: fragmentStage, texture: { sampleType: 'float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = (entry: string, format: GPUTextureFormat, additive = false) =>
      device.createRenderPipeline({
        label: entry,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: entry,
          targets: [
            {
              format,
              blend: additive
                ? {
                    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    return new PostProcess(
      device,
      layout,
      sampler,
      pipeline('fs_down_first', HDR_FORMAT),
      pipeline('fs_down', HDR_FORMAT),
      pipeline('fs_up', HDR_FORMAT, true),
      pipeline('fs_composite', canvasFormat),
    );
  }

  get hdrView(): GPUTextureView {
    return this.hdrSceneView;
  }

  resize(width: number, height: number): void {
    this.hdrTexture?.destroy();
    for (const t of this.bloom) t.destroy();
    for (const p of [...this.down, ...this.up, this.composite]) p?.uniform.destroy();
    this.size = [width, height];

    const make = (label: string, w: number, h: number) =>
      this.device.createTexture({
        label,
        size: [w, h],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.hdrTexture = make('hdr-scene', width, height);
    this.bloom = [];
    const dims: [number, number][] = [];
    let w = width;
    let h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const shift = i === 0 ? 2 : 1;
      w = Math.max(1, w >> shift);
      h = Math.max(1, h >> shift);
      dims.push([w, h]);
      this.bloom.push(make(`bloom-${i}`, w, h));
    }
    this.bloomViews = this.bloom.map((t) => t.createView());

    const hdrView = this.hdrTexture.createView();
    this.hdrSceneView = hdrView;
    this.written = null;
    const bind = (src: GPUTextureView, other: GPUTextureView): PassBinding => {
      const uniform = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: src },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: other },
        ],
      });
      return { uniform, bindGroup };
    };

    this.down = [];
    this.up = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? hdrView : this.bloomViews[i - 1]!;
      this.down.push(bind(src, hdrView));
    }
    // up[i] reads level i+1 and adds into level i.
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) this.up.push(bind(this.bloomViews[i + 1]!, hdrView));
    this.composite = bind(hdrView, this.bloomViews[0]!);
    this.dims = dims;
  }

  private dims: [number, number][] = [];

  private writeUniform(p: PassBinding, exposure: number, bloom: number, srcW: number, srcH: number): void {
    const d = this.uniformData;
    d[0] = exposure;
    d[1] = bloom;
    d[2] = 160; // clamp bloom input (post-exposure) so the sun disc cannot swamp the frame
    d[3] = 0;
    d[4] = 1 / srcW;
    d[5] = 1 / srcH;
    this.device.queue.writeBuffer(p.uniform, 0, d);
  }

  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    exposure: number,
    bloomStrength: number,
    timer: GpuTimer | null = null,
    bloomEnabled = true,
  ): void {
    const [w, h] = this.size;
    const levelSize = (i: number) => this.dims[i]!;

    const compositeBloom = bloomEnabled ? bloomStrength : 0;
    const last = this.written;
    if (!last || last.exposure !== exposure || last.bloom !== bloomStrength || last.composite !== compositeBloom) {
      this.writeUniform(this.down[0]!, exposure, bloomStrength, w, h);
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        const [sw, sh] = levelSize(i - 1);
        this.writeUniform(this.down[i]!, exposure, bloomStrength, sw, sh);
      }
      for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
        const [sw, sh] = levelSize(i + 1);
        this.writeUniform(this.up[i]!, exposure, bloomStrength, sw, sh);
      }
      this.writeUniform(this.composite, exposure, compositeBloom, w, h);
      this.written = { exposure, bloom: bloomStrength, composite: compositeBloom };
    }

    const fullscreen = (
      view: GPUTextureView,
      pipeline: GPURenderPipeline,
      binding: PassBinding,
      load: GPULoadOp,
      timing?: GPURenderPassTimestampWrites,
    ) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        timestampWrites: timing,
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding.bindGroup);
      pass.draw(3);
      pass.end();
    };

    if (bloomEnabled) {
      fullscreen(this.bloomViews[0]!, this.downFirst, this.down[0]!, 'clear', timer?.render('post', 'begin'));
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        fullscreen(this.bloomViews[i]!, this.downPipeline, this.down[i]!, 'clear');
      }
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        fullscreen(this.bloomViews[i]!, this.upPipeline, this.up[i]!, 'load');
      }
    }
    fullscreen(target, this.compositePipeline, this.composite, 'clear', timer?.render('post', bloomEnabled ? 'end' : 'both'));
  }
}
