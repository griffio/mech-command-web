import { createModule } from '../gpu-util';
import { createCloudNoise } from './noise-texture';
import clouds from '../shaders/clouds.wgsl?raw';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import noiseChunk from '../shaders/noise.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import atmoLib from './atmo_lib.wgsl?raw';
import cloudLutWgsl from './cloud_lut.wgsl?raw';
import multiscatterWgsl from './multiscatter.wgsl?raw';
import skyWgsl from './sky.wgsl?raw';
import skyAmbientWgsl from './sky_ambient.wgsl?raw';
import skyViewWgsl from './sky_view.wgsl?raw';
import transmittanceWgsl from './transmittance.wgsl?raw';

const TRANS_SIZE = [256, 64] as const;
const MS_SIZE = [32, 32] as const;
const SKY_SIZE = [256, 128] as const;

export interface AtmosphereOptions {
  device: GPUDevice;
  sceneBuffer: GPUBuffer;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

/**
 * Atmosphere resources: transmittance and multiple-scattering LUTs (built once), the sky-view LUT (rebuilt
 * when the sun moves), a cloud LUT and a sky-ambient reduction (every frame), plus the sky draw.
 */
export class Atmosphere {
  readonly skyView: GPUTexture;
  readonly cloudLut: GPUTexture;
  readonly ambientBuffer: GPUBuffer;
  /** Linear, wraps around in azimuth (u) and clamps in elevation (v). */
  readonly envSampler: GPUSampler;
  /** Baked tileable noise shared by the sky and the ocean foam (group 1, bindings 3-4 in those shaders). */
  readonly noiseView: GPUTextureView;
  readonly noiseSampler: GPUSampler;

  private constructor(
    private readonly device: GPUDevice,
    private readonly trans: GPUTexture,
    private readonly ms: GPUTexture,
    skyView: GPUTexture,
    cloudLut: GPUTexture,
    ambientBuffer: GPUBuffer,
    envSampler: GPUSampler,
    private readonly skyViewPipeline: GPUComputePipeline,
    private readonly skyViewBindGroups: GPUBindGroup[],
    private readonly cloudPipeline: GPUComputePipeline,
    private readonly cloudBindGroups: GPUBindGroup[],
    private readonly ambientPipeline: GPUComputePipeline,
    private readonly ambientBindGroups: GPUBindGroup[],
    private readonly skyPipeline: GPURenderPipeline,
    private readonly skyBindGroups: GPUBindGroup[],
    noiseView: GPUTextureView,
    noiseSampler: GPUSampler,
  ) {
    this.noiseView = noiseView;
    this.noiseSampler = noiseSampler;
    this.skyView = skyView;
    this.cloudLut = cloudLut;
    this.ambientBuffer = ambientBuffer;
    this.envSampler = envSampler;
  }

  static async create(opts: AtmosphereOptions): Promise<Atmosphere> {
    const { device, sceneBuffer } = opts;
    const lutUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const makeLut = (label: string, size: readonly [number, number]) =>
      device.createTexture({ label, size: [size[0], size[1]], format: 'rgba16float', usage: lutUsage });
    const trans = makeLut('atmo-transmittance', TRANS_SIZE);
    const ms = makeLut('atmo-multiscatter', MS_SIZE);
    const skyView = makeLut('atmo-sky-view', SKY_SIZE);
    const cloudLut = makeLut('atmo-cloud-lut', SKY_SIZE);

    const noise = createCloudNoise(device);
    const noiseView = noise.texture.createView();
    const lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const envSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });
    const ambientBuffer = device.createBuffer({
      label: 'sky-ambient',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const [transMod, msMod, skyViewMod, cloudMod, ambientMod, skyMod] = await Promise.all([
      createModule(device, 'transmittance', common, atmoLib, transmittanceWgsl),
      createModule(device, 'multiscatter', common, atmoLib, multiscatterWgsl),
      createModule(device, 'sky-view', common, scene, skyMap, atmoLib, skyViewWgsl),
      createModule(device, 'cloud-lut', common, scene, skyMap, noiseChunk, clouds, cloudLutWgsl),
      createModule(device, 'sky-ambient', common, skyMap, env, skyAmbientWgsl),
      createModule(device, 'sky', common, scene, skyMap, env, noiseChunk, clouds, skyWgsl),
    ]);

    const compute = (label: string, module: GPUShaderModule) =>
      device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
    const transPipeline = compute('transmittance', transMod);
    const msPipeline = compute('multiscatter', msMod);
    const skyViewPipeline = compute('sky-view', skyViewMod);
    const cloudPipeline = compute('cloud-lut', cloudMod);
    const ambientPipeline = compute('sky-ambient', ambientMod);

    const skyPipeline = device.createRenderPipeline({
      label: 'sky',
      layout: 'auto',
      vertex: { module: skyMod, entryPoint: 'vs' },
      fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: opts.colorFormat }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: opts.sampleCount },
    });

    const sceneEntry = (): GPUBindGroupEntry => ({ binding: 0, resource: { buffer: sceneBuffer } });
    const group = (pipeline: GPUComputePipeline | GPURenderPipeline, index: number, entries: GPUBindGroupEntry[]) =>
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });

    const skyViewBindGroups = [
      group(skyViewPipeline, 0, [sceneEntry()]),
      group(skyViewPipeline, 1, [
        { binding: 0, resource: trans.createView() },
        { binding: 1, resource: ms.createView() },
        { binding: 2, resource: lutSampler },
        { binding: 3, resource: skyView.createView() },
      ]),
    ];
    const cloudBindGroups = [
      group(cloudPipeline, 0, [sceneEntry()]),
      group(cloudPipeline, 1, [
        { binding: 0, resource: cloudLut.createView() },
        { binding: 3, resource: noiseView },
        { binding: 4, resource: noise.sampler },
      ]),
    ];
    // The ambient shader only uses group 1; group 0 must be set explicitly to the pipeline's empty layout,
    // otherwise the scene group left over from the previous dispatch is incompatible with it.
    const ambientBindGroups = [
      group(ambientPipeline, 0, []),
      group(ambientPipeline, 1, [
        { binding: 0, resource: skyView.createView() },
        { binding: 1, resource: cloudLut.createView() },
        { binding: 2, resource: envSampler },
        { binding: 3, resource: { buffer: ambientBuffer } },
      ]),
    ];
    // The sky shader evaluates clouds per pixel and never reads the cloud LUT, so its (auto) layout has no
    // binding 1; it does read the baked cloud noise (bindings 3-4).
    const skyBindGroups = [
      group(skyPipeline, 0, [sceneEntry()]),
      group(skyPipeline, 1, [
        { binding: 0, resource: skyView.createView() },
        { binding: 2, resource: envSampler },
        { binding: 3, resource: noiseView },
        { binding: 4, resource: noise.sampler },
      ]),
    ];

    // Static LUTs: independent of the sun, built once.
    const transBind = group(transPipeline, 0, [{ binding: 0, resource: trans.createView() }]);
    const msBind = group(msPipeline, 0, [
      { binding: 0, resource: trans.createView() },
      { binding: 1, resource: lutSampler },
      { binding: 2, resource: ms.createView() },
    ]);
    const encoder = device.createCommandEncoder({ label: 'atmosphere-static' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(transPipeline);
    pass.setBindGroup(0, transBind);
    pass.dispatchWorkgroups(TRANS_SIZE[0] / 8, TRANS_SIZE[1] / 8);
    pass.setPipeline(msPipeline);
    pass.setBindGroup(0, msBind);
    pass.dispatchWorkgroups(MS_SIZE[0], MS_SIZE[1]);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return new Atmosphere(
      device,
      trans,
      ms,
      skyView,
      cloudLut,
      ambientBuffer,
      envSampler,
      skyViewPipeline,
      skyViewBindGroups,
      cloudPipeline,
      cloudBindGroups,
      ambientPipeline,
      ambientBindGroups,
      skyPipeline,
      skyBindGroups,
      noiseView,
      noise.sampler,
    );
  }

  /** Rebuild the sky-view LUT. Call when the sun direction changed. */
  encodeSkyView(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.skyViewPipeline);
    this.skyViewBindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
    pass.dispatchWorkgroups(SKY_SIZE[0] / 8, SKY_SIZE[1] / 8);
  }

  /** Bake clouds, then reduce sky + clouds into the ambient colour. Every frame (clouds drift). */
  encodeCloudsAndAmbient(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.cloudPipeline);
    this.cloudBindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
    pass.dispatchWorkgroups(SKY_SIZE[0] / 8, SKY_SIZE[1] / 8);

    pass.setPipeline(this.ambientPipeline);
    this.ambientBindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
    pass.dispatchWorkgroups(1);
  }

  drawSky(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.skyPipeline);
    this.skyBindGroups.forEach((bg, i) => pass.setBindGroup(i, bg));
    pass.draw(3);
  }

  destroy(): void {
    for (const t of [this.trans, this.ms, this.skyView, this.cloudLut]) t.destroy();
    this.ambientBuffer.destroy();
    void this.device;
  }
}
