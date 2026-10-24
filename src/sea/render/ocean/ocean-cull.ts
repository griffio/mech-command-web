import type { Vec3 } from '../../math/vec3';

/**
 * Which part of the sea's polar grid can be in view. The grid is centred on the camera and goes all the way round, but the camera
 * looks one way: with a level view only a third of the circle can show, and the rest is clipped after its vertices have been shaded
 * (three wave-texture fetches each). The arc is found conservatively on the CPU, so that the renderer can leave the rest undrawn.
 */
export interface ArcView {
  /** Unit forward direction of the camera (x east, y up, z south). */
  forward: Vec3;
  tanHalfFovY: number;
  aspect: number;
  /** Height of the camera above the still-water plane, metres. */
  cameraHeight: number;
  /** How far the waves rise above and fall below the still-water plane, metres. */
  waveAmplitude: number;
  /** How far a vertex can be carried sideways by the waves' horizontal displacement, metres. */
  maxSideways: number;
  /** Radius of the innermost ring that is culled (the rings within are always drawn whole), metres. */
  innerRadius: number;
  /** Segments round the circle. */
  segments: number;
}

/** Segments [from, from + count) of the circle, wrapping past the last; count = segments is the whole of it. */
export interface Arc {
  from: number;
  count: number;
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** Slack beyond the geometry: the camera's shake, the horizon's drop, float rounding. */
const SLACK = 3 * DEG;

/** The arc of the grid's segments that the view can touch. */
export function visibleArc(v: ArcView): Arc {
  const segs = v.segments;
  const all: Arc = { from: 0, count: segs };
  const none: Arc = { from: 0, count: 0 };
  const [fx, fy, fz] = v.forward;
  const pitch = Math.atan2(fy, Math.hypot(fx, fz));
  // The frustum lies within a cone about the forward direction of half its diagonal angle.
  const cone = Math.atan(v.tanHalfFovY * Math.hypot(1, v.aspect));
  // Seen from the camera, the sea at any one azimuth, from the innermost culled ring out to the horizon, spans these elevations.
  const r = Math.max(v.innerRadius, 0.5);
  const eLo = Math.min(Math.atan2(-v.waveAmplitude - v.cameraHeight, r), 0);
  const eHi = Math.max(Math.atan2(v.waveAmplitude - v.cameraHeight, r), 0);
  // The arc is rounded out to whole quads, and a vertex of the innermost culled ring can wander this far in azimuth when displaced.
  const reach = cone + SLACK + TAU / segs + Math.asin(Math.min(v.maxSideways / r, 1));
  if (reach >= Math.PI) return all;
  // The point of that span nearest the forward direction lies at the forward pitch (clamped into the span); the azimuth difference
  // at which it leaves the cone follows from the spherical law of cosines.
  const e = Math.min(Math.max(pitch, eLo), eHi);
  const denom = Math.cos(pitch) * Math.cos(e);
  if (denom < 1e-9) return pitch < 0 ? all : none;
  const q = (Math.cos(reach) - Math.sin(pitch) * Math.sin(e)) / denom;
  if (q <= -1) return all;
  if (q >= 1) return none;
  const half = Math.acos(q);
  // The grid's angle: a vertex sits at (cos a, sin a) * radius in camera-relative (x, z).
  const azimuth = Math.atan2(fz, fx);
  const segAngle = TAU / segs;
  const from = Math.floor((azimuth - half) / segAngle);
  const to = Math.ceil((azimuth + half) / segAngle);
  const count = to - from;
  if (count >= segs) return all;
  return { from: ((from % segs) + segs) % segs, count };
}

/** Whether segment `seg` lies within the arc. */
export function arcContains(arc: Arc, seg: number, segments: number): boolean {
  const d = ((seg - arc.from) % segments + segments) % segments;
  return d < arc.count;
}
