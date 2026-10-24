/** Column-major 4x4 matrices in Float32Array(16), matching WGSL mat4x4<f32>. */
export type Mat4 = Float32Array;

/** out = a * b. `out` must not alias `a` or `b`. */
export function mulMat4(a: Mat4, b: Mat4, out: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/**
 * Infinite-far, reversed-Z perspective for WebGPU clip space (z in [0,1]): the near plane maps to 1 and
 * infinity to 0. Pair it with depth clear 0 and compare 'greater'; precision is excellent over tens of km.
 */
export function reverseZProjection(fovYRadians: number, aspect: number, near: number, out: Mat4): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = near;
  return out;
}

/** Rotation-only view matrix from an orthonormal camera basis (the camera sits at the origin). */
export function viewFromBasis(
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  forward: readonly [number, number, number],
  out: Mat4,
): Mat4 {
  out[0] = right[0];
  out[1] = up[0];
  out[2] = -forward[0];
  out[3] = 0;
  out[4] = right[1];
  out[5] = up[1];
  out[6] = -forward[1];
  out[7] = 0;
  out[8] = right[2];
  out[9] = up[2];
  out[10] = -forward[2];
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

export function identityMat4(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function translationMat4(x: number, y: number, z: number, out: Mat4): Mat4 {
  identityMat4(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

/** Rotation about +y by `angle` (right-handed: +x turns toward -z). */
export function rotationYMat4(angle: number, out: Mat4): Mat4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  identityMat4(out);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

/** Rotation about +z by `angle` (right-handed: +x turns toward +y). */
export function rotationZMat4(angle: number, out: Mat4): Mat4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  identityMat4(out);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

/** Matrix whose columns are the given basis vectors and position. */
export function fromBasis(
  x: readonly [number, number, number],
  y: readonly [number, number, number],
  z: readonly [number, number, number],
  p: readonly [number, number, number],
  out: Mat4,
): Mat4 {
  out.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, p[0], p[1], p[2], 1]);
  return out;
}

/** Orthographic projection to WebGPU clip space (z in [0,1]), looking down -z. */
export function orthographicMat4(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
  out: Mat4,
): Mat4 {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = 1 / (near - far);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = near / (near - far);
  out[15] = 1;
  return out;
}
