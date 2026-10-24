import { cross, dot, normalize, type Vec3 } from '../../math/vec3';

/** 16-bit depth: half the memory traffic of 32-bit, and 7 mm steps over the 440 m shadow volume. */
export const SHADOW_FORMAT: GPUTextureFormat = 'depth16unorm';

/**
 * Matrix taking camera-relative positions to the sun's orthographic shadow clip space (column-major into `out`).
 *
 * The frustum is a box of +/- `half` metres across the light and +/- `depthHalf` along it, centred on `focus`
 * (world, float64). The centre snaps to whole shadow texels in world space so shadows do not shimmer as the
 * ship moves. Depth runs 0 (sun side) to 1 (far side); x and y span -1..1.
 */
export function sunShadowMatrix(
  sunDir: Vec3,
  focus: Vec3,
  cameraPos: Vec3,
  half: number,
  depthHalf: number,
  mapSize: number,
  out: Float32Array,
): void {
  const L = normalize(sunDir);
  const away: Vec3 = [-L[0], -L[1], -L[2]]; // direction light travels
  const hint: Vec3 = Math.abs(L[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const R = normalize(cross(hint, L));
  const U = cross(L, R);
  const texel = (2 * half) / mapSize;

  const cx = Math.floor(dot(focus, R) / texel) * texel;
  const cy = Math.floor(dot(focus, U) / texel) * texel;
  const cz = dot(focus, away);

  // For a camera-relative point q, the world point is q + cameraPos.
  const tx = dot(cameraPos, R) - cx;
  const ty = dot(cameraPos, U) - cy;
  const tz = dot(cameraPos, away) - (cz - depthHalf);

  const rows: [Vec3, number, number][] = [
    [R, tx, half],
    [U, ty, half],
    [away, tz, 2 * depthHalf],
  ];
  out.fill(0);
  rows.forEach(([axis, offset, scale], r) => {
    out[0 * 4 + r] = axis[0] / scale;
    out[1 * 4 + r] = axis[1] / scale;
    out[2 * 4 + r] = axis[2] / scale;
    out[3 * 4 + r] = offset / scale;
  });
  out[3 * 4 + 3] = 1;
}

/**
 * One orthographic sun shadow map framed on the player ship. It is rendered by the ship shadow pass and read
 * by the ship and ocean shaders (so the sea shows the ship's shadow).
 */
export class ShadowMap {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  /** Comparison sampler with hardware bilinear PCF. */
  readonly sampler: GPUSampler;

  constructor(
    device: GPUDevice,
    readonly size: number,
  ) {
    this.texture = device.createTexture({
      label: 'sun-shadow',
      size: [size, size],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.view = this.texture.createView();
    this.sampler = device.createSampler({
      label: 'shadow-compare',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  destroy(): void {
    this.texture.destroy();
  }
}
