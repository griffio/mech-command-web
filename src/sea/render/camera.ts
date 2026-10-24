import { mulMat4, reverseZProjection, viewFromBasis } from '../math/mat4';
import { cross, degToRad, normalize, type Vec3 } from '../math/vec3';

/**
 * Camera with a float64 world position. The GPU only ever sees camera-relative coordinates
 * (the view matrix has no translation), so 40 km maps stay precise in float32.
 *
 * Heading convention matches the rest of the game: yaw 0 looks north (-z), 90 looks east (+x).
 */
const EARTH_RADIUS = 6371000;

export class Camera {
  position: Vec3 = [0, 25, 0];
  yawDeg = 0;
  pitchDeg = 0;
  /** A shake added to the aim when the view is built (see CameraShake); the camera's own yaw and pitch are left as they were. */
  shakeYawDeg = 0;
  shakePitchDeg = 0;
  fovYDeg = 60;
  near = 0.3;

  readonly viewProj = new Float32Array(16);
  readonly view = new Float32Array(16);
  private readonly proj = new Float32Array(16);

  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];
  forward: Vec3 = [0, 0, -1];
  tanHalfFovY = 1;
  aspect = 1;

  /** Aim at a world point (yaw/pitch only; the camera keeps its position). */
  lookAt(x: number, y: number, z: number): void {
    const dx = x - this.position[0];
    const dy = y - this.position[1];
    const dz = z - this.position[2];
    this.yawDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
    this.pitchDeg = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  }

  /**
   * Project a world point to normalised device coordinates (x right, y up, both -1..1 on screen), allowing for the
   * curvature of the Earth exactly as the shaders do. Returns false when the point is behind the camera.
   */
  project(wx: number, wy: number, wz: number, out: [number, number]): boolean {
    const rx = wx - this.position[0];
    const rz = wz - this.position[2];
    const ry = wy - this.position[1] - (rx * rx + rz * rz) / (2 * EARTH_RADIUS);
    const m = this.viewProj;
    const w = m[3]! * rx + m[7]! * ry + m[11]! * rz + m[15]!;
    if (w <= 1e-4) return false;
    out[0] = (m[0]! * rx + m[4]! * ry + m[8]! * rz + m[12]!) / w;
    out[1] = (m[1]! * rx + m[5]! * ry + m[9]! * rz + m[13]!) / w;
    return true;
  }

  /** Unit direction of the view ray through a normalised-device-coordinate point. */
  rayThrough(ndcX: number, ndcY: number): Vec3 {
    const tanY = this.tanHalfFovY;
    const x = ndcX * tanY * this.aspect;
    const y = ndcY * tanY;
    return normalize([
      this.forward[0] + this.right[0] * x + this.up[0] * y,
      this.forward[1] + this.right[1] * x + this.up[1] * y,
      this.forward[2] + this.right[2] * x + this.up[2] * y,
    ]);
  }

  update(aspect: number): void {
    this.aspect = aspect;
    const yaw = degToRad(this.yawDeg + this.shakeYawDeg);
    const pitch = degToRad(Math.min(Math.max(this.pitchDeg + this.shakePitchDeg, -89), 89));
    this.forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    this.right = normalize(cross(this.forward, [0, 1, 0]));
    this.up = cross(this.right, this.forward);
    this.tanHalfFovY = Math.tan(degToRad(this.fovYDeg) / 2);

    viewFromBasis(this.right, this.up, this.forward, this.view);
    reverseZProjection(degToRad(this.fovYDeg), aspect, this.near, this.proj);
    mulMat4(this.proj, this.view, this.viewProj);
  }
}
