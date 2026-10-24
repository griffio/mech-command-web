/**
 * CPU-side layout of the `Scene` uniform in shaders/scene.wgsl: 25 vec4 slots (400 bytes).
 * Keep SLOT in sync with that struct. The final `ambient` slot is written by the GPU each frame
 * (a compute pass copies it in), so the CPU upload stops before it.
 */
export const SLOT = {
  viewProj: 0, // 4 slots, mat4x4
  camRight: 4, // xyz right, w = tan(fovY/2) * aspect
  camUp: 5, // xyz up, w = tan(fovY/2)
  camFwd: 6, // xyz forward, w = near
  camPos: 7, // xyz world position (m), w = looped time (s)
  sunDir: 8, // xyz toward the sun, w = angular radius (rad)
  sunIrr: 9, // rgb sunlight irradiance at sea level (perpendicular), w = exposure
  screen: 10, // width, height, 1/width, 1/height
  ocean: 11, // x choppiness, y significant wave height, z unused, w visibility (km)
  ocean2: 12, // reserved
  cascade: 13, // 3 slots: x 1/length, y camUV.x, z camUV.y, w texel size (m)
  cloud: 16, // x coverage, y altitude (m), z wind offset x (m), w wind offset z (m)
  cloudSun: 17, // rgb sunlight colour at cloud altitude
  atmo: 18, // x sun elevation sine, y haze multiplier
  shadowViewProj: 19, // 4 slots, mat4x4 (camera-relative world -> shadow clip)
  shadow: 23, // x enabled, y texel size (uv), z normal offset (m), w depth bias
  ambient: 24, // GPU-written: cosine-weighted mean sky radiance
} as const;

export const SCENE_VEC4_COUNT = 25;
export const SCENE_BYTES = SCENE_VEC4_COUNT * 16;
export const SCENE_AMBIENT_BYTE_OFFSET = SLOT.ambient * 16;
export const SCENE_UPLOAD_FLOATS = SLOT.ambient * 4;

export class SceneBlock {
  readonly data = new Float32Array(SCENE_VEC4_COUNT * 4);

  vec4(slot: number, x: number, y: number, z: number, w: number): void {
    const o = slot * 4;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = w;
  }

  mat4(slot: number, m: Float32Array): void {
    this.data.set(m, slot * 4);
  }
}
