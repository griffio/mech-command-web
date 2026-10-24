import {
  cascadeBands,
  generateH0,
  packSpectrum,
  type SpectrumParams,
  type WaveMode,
} from '../../sim/ocean/spectrum';
import { buoyancyModesOf, cascadeSeed, OCEAN_LOOP_SECONDS } from '../../sim/ocean/waves';
import { Rng } from '../../sim/rng';
import { createModule } from '../gpu-util';
import assembleWgsl from './ocean_assemble.wgsl?raw';
import evolveWgsl from './ocean_evolve.wgsl?raw';
import fftWgsl from './ocean_fft_lines.wgsl?raw';
import mipWgsl from './ocean_mip.wgsl?raw';
import simWgsl from './ocean_sim.wgsl?raw';

/** Seconds after which the whole wave field repeats (frequencies are quantised to this loop). */
export { OCEAN_LOOP_SECONDS } from '../../sim/ocean/waves';

export interface OceanFieldOptions {
  device: GPUDevice;
  /** FFT resolution per cascade; a power of two (64..256). */
  size: number;
  /** Tile length (m) of each cascade, longest first (1 to 4 cascades). */
  lengths: readonly number[];
}

export interface FoamSettings {
  /** Jacobian below which foam is born. */
  bias: number;
  /** Per-cascade foam gain. */
  gains: readonly number[];
  /** Seconds for foam to fade by 1/e. */
  persistence: number;
}

/**
 * The GPU wave field: initial spectra, per-frame evolution, batched inverse FFTs, and the displacement /
 * derivative texture arrays (with mips) the surface shader samples. No rendering happens here, so it also
 * runs in tests.
 */
/** The Sim uniform block as it is filled each frame (16 floats; see `encode`). */
const SIM_SCRATCH = new Float32Array(16);

export class OceanField {
  readonly size: number;
  readonly cascades: number;
  readonly lengths: readonly number[];
  readonly levels: number;
  readonly w0 = (2 * Math.PI) / OCEAN_LOOP_SECONDS;
  /** Ping-pong displacement arrays (foam persists by reading the previous one). */
  readonly dispTextures: [GPUTexture, GPUTexture];
  readonly derivTexture: GPUTexture;

  /**
   * The strongest long waves of the current sea, for CPU-side buoyancy. They are the same waves the GPU
   * transforms (same spectrum, phase and quantised frequency), so ships sit on the water you see.
   */
  waveModes: WaveMode[] = [];

  private current = 0;
  private readonly spectrumBuffer: GPUBuffer;
  private readonly simBuffer: GPUBuffer;
  private readonly fftBuffers: [GPUBuffer, GPUBuffer];
  private readonly fftUniforms: GPUBuffer[] = [];
  private readonly evolveBindGroup: GPUBindGroup;
  private readonly fftBindGroups: GPUBindGroup[] = [];
  private readonly assembleBindGroups: [GPUBindGroup, GPUBindGroup];
  private readonly mipBindGroups: { disp: [GPUBindGroup[], GPUBindGroup[]]; deriv: GPUBindGroup[] };

  private constructor(
    private readonly device: GPUDevice,
    opts: OceanFieldOptions,
    private readonly pipelines: {
      evolve: GPUComputePipeline;
      fft: GPUComputePipeline;
      assemble: GPUComputePipeline;
      mip: GPUComputePipeline;
    },
  ) {
    this.size = opts.size;
    this.lengths = opts.lengths;
    this.cascades = opts.lengths.length;
    this.levels = Math.log2(opts.size) + 1;
    const n = this.size;
    const jobs = this.cascades * 4;

    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const makeArray = (label: string) =>
      device.createTexture({
        label,
        size: [n, n, this.cascades],
        format: 'rgba16float',
        mipLevelCount: this.levels,
        usage: texUsage,
      });
    this.dispTextures = [makeArray('ocean-disp-0'), makeArray('ocean-disp-1')];
    this.derivTexture = makeArray('ocean-deriv');

    this.spectrumBuffer = device.createBuffer({
      label: 'ocean-spectrum',
      size: this.cascades * n * n * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.simBuffer = device.createBuffer({
      label: 'ocean-sim',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fftUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    this.fftBuffers = [
      device.createBuffer({ label: 'ocean-fft-a', size: jobs * n * n * 8, usage: fftUsage }),
      device.createBuffer({ label: 'ocean-fft-b', size: jobs * n * n * 8, usage: fftUsage }),
    ];

    this.evolveBindGroup = device.createBindGroup({
      layout: pipelines.evolve.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.simBuffer } },
        { binding: 1, resource: { buffer: this.spectrumBuffer } },
        { binding: 2, resource: { buffer: this.fftBuffers[0] } },
      ],
    });

    // Inverse 2D FFT in two dispatches: every row (A -> B), then every column (B -> A), each line transformed
    // entirely in workgroup memory. The result ends in buffer A, where the assemble pass reads it.
    const axes: [GPUBuffer, GPUBuffer][] = [
      [this.fftBuffers[0], this.fftBuffers[1]],
      [this.fftBuffers[1], this.fftBuffers[0]],
    ];
    axes.forEach(([from, to], axis) => {
      const uniform = device.createBuffer({
        label: `ocean-fft-params-${axis}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniform, 0, new Uint32Array([n, axis, 1, 0]));
      this.fftUniforms.push(uniform);
      this.fftBindGroups.push(
        device.createBindGroup({
          layout: pipelines.fft.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: from } },
            { binding: 2, resource: { buffer: to } },
          ],
        }),
      );
    });

    const mip0 = (t: GPUTexture) => t.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 });
    const assemble = (cur: number) =>
      device.createBindGroup({
        layout: pipelines.assemble.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.simBuffer } },
          { binding: 1, resource: { buffer: this.fftBuffers[0] } },
          { binding: 2, resource: mip0(this.dispTextures[1 - cur]!) },
          { binding: 3, resource: mip0(this.dispTextures[cur]!) },
          { binding: 4, resource: mip0(this.derivTexture) },
        ],
      });
    this.assembleBindGroups = [assemble(0), assemble(1)];

    const mipChain = (t: GPUTexture): GPUBindGroup[] => {
      const groups: GPUBindGroup[] = [];
      for (let l = 0; l < this.levels - 1; l++) {
        groups.push(
          device.createBindGroup({
            layout: pipelines.mip.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: t.createView({ dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 }) },
              { binding: 1, resource: t.createView({ dimension: '2d-array', baseMipLevel: l + 1, mipLevelCount: 1 }) },
            ],
          }),
        );
      }
      return groups;
    };
    this.mipBindGroups = {
      disp: [mipChain(this.dispTextures[0]), mipChain(this.dispTextures[1])],
      deriv: mipChain(this.derivTexture),
    };
  }

  static async create(opts: OceanFieldOptions): Promise<OceanField> {
    const { device } = opts;
    const [evolveMod, fftMod, assembleMod, mipMod] = await Promise.all([
      createModule(device, 'ocean-evolve', simWgsl, evolveWgsl),
      createModule(device, 'ocean-fft', fftWgsl),
      createModule(device, 'ocean-assemble', simWgsl, assembleWgsl),
      createModule(device, 'ocean-mip', mipWgsl),
    ]);
    const pipeline = (label: string, module: GPUShaderModule) =>
      device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
    return new OceanField(device, opts, {
      evolve: pipeline('ocean-evolve', evolveMod),
      fft: pipeline('ocean-fft', fftMod),
      assemble: pipeline('ocean-assemble', assembleMod),
      mip: pipeline('ocean-mip', mipMod),
    });
  }

  /** Index into `dispTextures` holding the most recently assembled frame. */
  get currentIndex(): number {
    return this.current;
  }

  /** Generate fresh spectra for the given sea state (deterministic per seed) and upload them. */
  setSea(params: SpectrumParams, seed: number): void {
    const n = this.size;
    const bands = cascadeBands(n, this.lengths);
    const packed = new Float32Array(this.cascades * n * n * 4);
    bands.forEach((band, c) => {
      const h0 = generateH0(n, band, params, new Rng(cascadeSeed(seed, c)));
      packed.set(packSpectrum(h0, n), c * n * n * 4);
      // The waves a ship floats on: the same modes the headless harnesses take from this spectrum (see sim/ocean/waves.ts).
      if (c === 0) this.waveModes = buoyancyModesOf(h0, n, this.lengths);
    });
    this.setPackedSpectrum(packed);
  }

  /** Upload spectra already in the (h0.re, h0.im, conj(h0(-k)).re, .im) layout. */
  setPackedSpectrum(packed: Float32Array): void {
    this.device.queue.writeBuffer(this.spectrumBuffer, 0, packed.buffer as ArrayBuffer, packed.byteOffset, packed.byteLength);
  }

  /**
   * Record one frame of wave-field work into a compute pass: evolve, inverse FFT, assemble (with foam
   * persistence), and mip generation. The new frame lands in `dispTextures[currentIndex]`.
   */
  encode(
    pass: GPUComputePassEncoder,
    loopedTime: number,
    choppiness: number,
    foam: FoamSettings,
    dt: number,
  ): void {
    const n = this.size;
    const foamDecay = Math.exp(-Math.max(dt, 0) / Math.max(foam.persistence, 0.05));
    // The Sim block, filled in place (the same 16 floats every frame: nothing to allocate).
    const sd = SIM_SCRATCH;
    sd.fill(0);
    sd[0] = loopedTime;
    sd[1] = this.w0;
    sd[2] = choppiness;
    sd[3] = foamDecay;
    for (let c = 0; c < this.cascades; c++) {
      sd[4 + c] = this.lengths[c]!;
      sd[8 + c] = foam.gains[c] ?? 0;
    }
    sd[12] = n;
    sd[13] = this.cascades;
    sd[14] = foam.bias;
    this.device.queue.writeBuffer(this.simBuffer, 0, sd);
    this.current = 1 - this.current;
    const cur = this.current;

    const groups = n / 8;
    pass.setPipeline(this.pipelines.evolve);
    pass.setBindGroup(0, this.evolveBindGroup);
    pass.dispatchWorkgroups(groups, groups, this.cascades);

    pass.setPipeline(this.pipelines.fft);
    const jobs = this.cascades * 4;
    for (const bg of this.fftBindGroups) {
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(n, jobs);
    }

    pass.setPipeline(this.pipelines.assemble);
    pass.setBindGroup(0, this.assembleBindGroups[cur]!);
    pass.dispatchWorkgroups(groups, groups, this.cascades);

    pass.setPipeline(this.pipelines.mip);
    const chains = [this.mipBindGroups.disp[cur]!, this.mipBindGroups.deriv];
    for (const chain of chains) {
      chain.forEach((bg, l) => {
        const size = Math.max(n >> (l + 1), 1);
        const g = Math.ceil(size / 8);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(g, g, this.cascades);
      });
    }
  }

  /** Cascade uniform rows for the scene block: (1/L, camUV.x, camUV.y, texel size). Float64 camera reduced mod L. */
  cascadeUniforms(camX: number, camZ: number): [number, number, number, number][] {
    return this.lengths.map((len) => {
      const frac = (v: number) => ((v % len) + len) / len % 1;
      return [1 / len, frac(camX), frac(camZ), len / this.size];
    });
  }

  destroy(): void {
    for (const t of [...this.dispTextures, this.derivTexture]) t.destroy();
    for (const b of [this.spectrumBuffer, this.simBuffer, ...this.fftBuffers, ...this.fftUniforms]) b.destroy();
  }
}
