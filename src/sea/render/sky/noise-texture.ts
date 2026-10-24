import { Rng } from '../../sim/rng';

/**
 * Smooth value noise baked into a tileable texture: `cells` x `cells` random lattice values, interpolated with
 * a smoothstep, one byte per texel. The cloud shader samples it with bilinear filtering and repeat addressing,
 * so each noise octave costs one texture fetch instead of four hashes and an interpolation.
 */
export function generateTileableNoise(size: number, cells: number, seed: number): Uint8Array {
  const rng = new Rng(seed);
  const lattice = new Float64Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  const at = (x: number, y: number) => lattice[(y % cells) * cells + (x % cells)]!;

  const out = new Uint8Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    const uy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const ux = tx * tx * (3 - 2 * tx);
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
      out[y * size + x] = Math.round((a + (b - a) * uy) * 255);
    }
  }
  return out;
}

export const CLOUD_NOISE_SIZE = 512;
/** Lattice cells across the texture; the shader divides lattice units by this. Keep in sync with clouds.wgsl. */
export const CLOUD_NOISE_CELLS = 32;

export function createCloudNoise(device: GPUDevice): { texture: GPUTexture; sampler: GPUSampler } {
  const texture = device.createTexture({
    label: 'cloud-noise',
    size: [CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    generateTileableNoise(CLOUD_NOISE_SIZE, CLOUD_NOISE_CELLS, 90210),
    { bytesPerRow: CLOUD_NOISE_SIZE },
    [CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE],
  );
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  return { texture, sampler };
}
