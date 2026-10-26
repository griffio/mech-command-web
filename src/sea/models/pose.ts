// Poses a model's node tree from its animation clips, as model-space affine matrices: 3 rows of 4 floats per node
// (rotation and scale in the 3x3, translation in the fourth column), the layout the model shader reads.
import type { ModelClip, ModelData, ModelTrack } from './glb';

export const AFFINE_FLOATS = 12;

interface Playing {
  clip: ModelClip;
  time: number;
  loop: boolean;
}

export class Animator {
  /** Model-space matrix of every node, AFFINE_FLOATS each. */
  readonly matrices: Float32Array;
  clipName = '';
  private current: Playing | null = null;
  private previous: Playing | null = null;
  private fade = 0;
  private fadeLength = 0;
  private readonly t: Float32Array;
  private readonly r: Float32Array;
  private readonly t2: Float32Array;
  private readonly r2: Float32Array;
  private readonly local = new Float32Array(AFFINE_FLOATS);
  private twistNode = -1;
  private twistAngle = 0;

  constructor(private readonly model: ModelData) {
    const n = model.nodes.length;
    this.matrices = new Float32Array(n * AFFINE_FLOATS);
    this.t = new Float32Array(n * 3);
    this.r = new Float32Array(n * 4);
    this.t2 = new Float32Array(n * 3);
    this.r2 = new Float32Array(n * 4);
    this.pose();
  }

  get clips(): string[] {
    return [...this.model.clips.keys()];
  }

  /**
   * Switch to a clip, blending from the one playing over `fade` seconds. A clip that doesn't `loop` holds its last frame
   * (from the first if `startTime` is past its end). Unknown names are ignored.
   */
  play(name: string, fade = 0.2, startTime = 0, loop = true): void {
    const clip = this.model.clips.get(name);
    if (!clip || name === this.clipName) return;
    this.previous = this.current && fade > 0 ? this.current : null;
    this.fade = 0;
    this.fadeLength = fade;
    this.current = { clip, time: loop ? startTime % Math.max(clip.duration, 1e-3) : Math.min(startTime, clip.duration), loop };
    this.clipName = name;
  }

  /** A clip played once has reached its end. */
  get finished(): boolean {
    return !!this.current && !this.current.loop && this.current.time >= this.current.clip.duration;
  }

  /** Turn one node (and so everything it carries) about the model's up axis, radians: a mech's torso twist. */
  setTwist(node: number, angle: number): void {
    this.twistNode = node;
    this.twistAngle = angle;
  }

  update(dt: number): void {
    if (this.current) advance(this.current, dt);
    if (this.previous) {
      advance(this.previous, dt);
      this.fade += dt;
      if (this.fade >= this.fadeLength) this.previous = null;
    }
    this.pose();
  }

  private pose(): void {
    const { nodes } = this.model;
    restInto(this.model, this.t, this.r);
    if (this.current) sampleInto(this.current, this.t, this.r);
    if (this.previous) {
      restInto(this.model, this.t2, this.r2);
      sampleInto(this.previous, this.t2, this.r2);
      blend(this.t2, this.r2, this.t, this.r, Math.min(this.fade / Math.max(this.fadeLength, 1e-3), 1));
    }
    const m = this.matrices;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      trsAffine(this.local, 0, this.t, i * 3, this.r, i * 4, node.scale);
      if (node.parent < 0) m.set(this.local, i * AFFINE_FLOATS);
      else mulAffine(m, i * AFFINE_FLOATS, m, node.parent * AFFINE_FLOATS, this.local, 0);
      if (i === this.twistNode && this.twistAngle !== 0) yawInPlace(m, i * AFFINE_FLOATS, this.twistAngle);
    }
  }
}

function advance(playing: Playing, dt: number): void {
  const length = Math.max(playing.clip.duration, 1e-3);
  playing.time = playing.loop ? (playing.time + dt) % length : Math.min(playing.time + dt, length);
}

/** Rotate an affine matrix's axes about the y axis by `angle` radians, keeping its origin where it is. */
function yawInPlace(m: Float32Array, o: number, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let col = 0; col < 3; col++) {
    const x = m[o + col]!;
    const z = m[o + 8 + col]!;
    m[o + col] = c * x + s * z;
    m[o + 8 + col] = -s * x + c * z;
  }
}

/** The model's rest pose (no clip), for models that never move. */
export function restPose(model: ModelData): Float32Array {
  return new Animator(model).matrices;
}

function restInto(model: ModelData, t: Float32Array, r: Float32Array): void {
  model.nodes.forEach((n, i) => {
    t.set(n.translation, i * 3);
    r.set(n.rotation, i * 4);
  });
}

function sampleInto(playing: Playing, t: Float32Array, r: Float32Array): void {
  for (const track of playing.clip.tracks) sampleTrack(track, playing.time, track.path === 'translation' ? t : r);
}

/** Linear keys (normalised-lerp for rotations, whose neighbouring keys the converter keeps in one hemisphere). */
function sampleTrack(track: ModelTrack, time: number, out: Float32Array): void {
  const { times, values } = track;
  const width = track.path === 'translation' ? 3 : 4;
  const o = track.node * width;
  const n = times.length;
  if (n === 1 || time <= times[0]!) {
    for (let k = 0; k < width; k++) out[o + k] = values[k]!;
    return;
  }
  if (time >= times[n - 1]!) {
    for (let k = 0; k < width; k++) out[o + k] = values[(n - 1) * width + k]!;
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid;
    else hi = mid;
  }
  const f = (time - times[lo]!) / (times[hi]! - times[lo]!);
  for (let k = 0; k < width; k++) out[o + k] = values[lo * width + k]! * (1 - f) + values[hi * width + k]! * f;
  if (width === 4) normaliseQuat(out, o);
}

/** Blend pose (t0, r0) into (t1, r1): w = 0 keeps the first, 1 the second. */
function blend(t0: Float32Array, r0: Float32Array, t1: Float32Array, r1: Float32Array, w: number): void {
  for (let i = 0; i < t1.length; i++) t1[i] = t0[i]! * (1 - w) + t1[i]! * w;
  for (let q = 0; q < r1.length; q += 4) {
    const sign = r0[q]! * r1[q]! + r0[q + 1]! * r1[q + 1]! + r0[q + 2]! * r1[q + 2]! + r0[q + 3]! * r1[q + 3]! < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) r1[q + k] = r0[q + k]! * (1 - w) + sign * r1[q + k]! * w;
    normaliseQuat(r1, q);
  }
}

function normaliseQuat(q: Float32Array, o: number): void {
  const l = Math.hypot(q[o]!, q[o + 1]!, q[o + 2]!, q[o + 3]!) || 1;
  q[o] /= l;
  q[o + 1] /= l;
  q[o + 2] /= l;
  q[o + 3] /= l;
}

/** out[o..o+12] = translate(t) * rotate(q) * scale(s), as 3 rows of 4. */
export function trsAffine(
  out: Float32Array,
  o: number,
  t: ArrayLike<number>,
  to: number,
  q: ArrayLike<number>,
  qo: number,
  s: ArrayLike<number> = [1, 1, 1],
): void {
  const x = q[qo]!;
  const y = q[qo + 1]!;
  const z = q[qo + 2]!;
  const w = q[qo + 3]!;
  out[o] = (1 - 2 * (y * y + z * z)) * s[0]!;
  out[o + 1] = 2 * (x * y - w * z) * s[1]!;
  out[o + 2] = 2 * (x * z + w * y) * s[2]!;
  out[o + 3] = t[to]!;
  out[o + 4] = 2 * (x * y + w * z) * s[0]!;
  out[o + 5] = (1 - 2 * (x * x + z * z)) * s[1]!;
  out[o + 6] = 2 * (y * z - w * x) * s[2]!;
  out[o + 7] = t[to + 1]!;
  out[o + 8] = 2 * (x * z - w * y) * s[0]!;
  out[o + 9] = 2 * (y * z + w * x) * s[1]!;
  out[o + 10] = (1 - 2 * (x * x + y * y)) * s[2]!;
  out[o + 11] = t[to + 2]!;
}

/** out = a * b for affine 3x4 matrices (out may alias a but not b). */
export function mulAffine(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row++) {
    const a0 = a[ao + row * 4]!;
    const a1 = a[ao + row * 4 + 1]!;
    const a2 = a[ao + row * 4 + 2]!;
    const a3 = a[ao + row * 4 + 3]!;
    for (let col = 0; col < 4; col++) {
      r[row * 4 + col] = a0 * b[bo + col]! + a1 * b[bo + 4 + col]! + a2 * b[bo + 8 + col]! + (col === 3 ? a3 : 0);
    }
  }
  for (let k = 0; k < 12; k++) out[o + k] = r[k]!;
}

/** An instance's placement: translate (x, y, z) * rotate about y by `yaw` radians * uniform `scale`. */
export function placement(out: Float32Array, x: number, y: number, z: number, yaw: number, scale: number): void {
  const c = Math.cos(yaw) * scale;
  const s = Math.sin(yaw) * scale;
  out.set([c, 0, s, x, 0, scale, 0, y, -s, 0, c, z]);
}
