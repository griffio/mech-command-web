/**
 * Ship wake geometry, pure and GPU-free. A ship leaves a path history; the wake is rebuilt every frame as
 * ribbons (turbulent foam trail, Kelvin wedge lines, and foam along the hull and bow) that the renderer
 * rasterises into a world-space wake map the ocean shader samples.
 *
 * Vertices are (x, z, across, foam, kind): world position, -1..1 across the ribbon, foam strength 0..1, and the
 * kind (0 = turbulent trail and hull foam, 1 = Kelvin wedge line) which selects the wake-map channel.
 * Ribbons are emitted as plain triangle lists so one vertex buffer holds everything.
 */
export interface WakeSample {
  x: number;
  z: number;
  /** Simulation time the ship's stern was here, seconds. */
  t: number;
  /** Speed (m/s, magnitude) and engine power fraction at that moment. */
  speed: number;
  power: number;
}

export const WAKE_FLOATS_PER_VERTEX = 5;
export const KIND_TRAIL = 0;
export const KIND_KELVIN = 1;
/** Half the angle of the Kelvin wedge: tan(19.47 degrees). */
export const KELVIN_TAN = 0.35355;

export class WakeHistory {
  readonly samples: WakeSample[] = [];

  constructor(
    /** Minimum distance between samples, metres. */
    private readonly spacing = 1.6,
    /** Samples older than this are dropped, seconds. */
    private readonly maxAge = 110,
  ) {}

  /** Record the stern position. Adds a sample only once the ship has moved `spacing` metres. */
  record(x: number, z: number, t: number, speed: number, power: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < this.spacing) return;
    if (!last && Math.abs(speed) < 0.2) return;
    this.samples.push({ x, z, t, speed: Math.abs(speed), power });
    while (this.samples.length > 0 && t - this.samples[0]!.t > this.maxAge) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export interface WakeShip {
  /** Beam, metres: the wake starts about this wide. */
  beam: number;
  /** Speed at which foam saturates, m/s. */
  referenceSpeed: number;
}

/** Output buffer with a vertex capacity; builders stop (never overflow) when full. */
export class VertexSink {
  count = 0;
  /** Subtracted from x and z as vertices are written, so the buffer holds small window-relative numbers. */
  originX = 0;
  originZ = 0;
  constructor(readonly data: Float32Array) {}

  get capacity(): number {
    return Math.floor(this.data.length / WAKE_FLOATS_PER_VERTEX);
  }

  push(x: number, z: number, across: number, foam: number, kind = KIND_TRAIL): void {
    if (this.count >= this.capacity) return;
    const o = this.count * WAKE_FLOATS_PER_VERTEX;
    this.data[o] = x - this.originX;
    this.data[o + 1] = z - this.originZ;
    this.data[o + 2] = across;
    this.data[o + 3] = foam;
    this.data[o + 4] = kind;
    this.count++;
  }

  reset(): void {
    this.count = 0;
  }
}

interface RibbonPoint {
  x: number;
  z: number;
  halfWidth: number;
  foam: number;
}

export interface RibbonOptions {
  /** Widest a strip across the ribbon may be, metres. Wide ribbons are split so they can follow a swell. */
  maxStrip?: number;
  /** Shortest segment along the path, metres. */
  minStep?: number;
  /** Segments are also at least this fraction of the local width long (wide, old parts need fewer cuts). */
  stepPerWidth?: number;
}

/**
 * Emit a ribbon along `points` (oldest first) as a strip grid. The path is thinned so segment length grows with
 * the ribbon's width, and the width is split into strips of at most `maxStrip` metres: the renderer lifts each
 * vertex onto the wave surface, so a ribbon with only two vertices across would pass under a swell crest between
 * them. Tangents come from neighbouring kept points.
 */
export function emitRibbon(
  sink: VertexSink,
  points: readonly RibbonPoint[],
  kind = KIND_TRAIL,
  opts: RibbonOptions = {},
): void {
  if (points.length < 2) return;
  const maxStrip = opts.maxStrip ?? 5;
  const minStep = opts.minStep ?? 1.6;
  const stepPerWidth = opts.stepPerWidth ?? 0.3;

  const kept: RibbonPoint[] = [points[0]!];
  let acc = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const q = points[i - 1]!;
    acc += Math.hypot(p.x - q.x, p.z - q.z);
    if (acc + 1e-6 >= Math.max(minStep, stepPerWidth * 2 * p.halfWidth)) {
      kept.push(p);
      acc = 0;
    }
  }
  kept.push(points[points.length - 1]!);
  if (kept.length < 2) return;

  const normals: [number, number][] = kept.map((_, i) => {
    const a = kept[Math.max(i - 1, 0)]!;
    const b = kept[Math.min(i + 1, kept.length - 1)]!;
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    return [-tz / l, tx / l];
  });

  let widest = 0;
  for (const p of kept) widest = Math.max(widest, p.halfWidth * 2);
  const strips = Math.min(Math.max(Math.ceil(widest / maxStrip), 1), 16);

  const at = (i: number, a: number): [number, number] => {
    const p = kept[i]!;
    const n = normals[i]!;
    return [p.x + n[0] * p.halfWidth * a, p.z + n[1] * p.halfWidth * a];
  };
  for (let i = 0; i < kept.length - 1; i++) {
    const p0 = kept[i]!;
    const p1 = kept[i + 1]!;
    for (let j = 0; j < strips; j++) {
      const a0 = -1 + (2 * j) / strips;
      const a1 = -1 + (2 * (j + 1)) / strips;
      const [x00, z00] = at(i, a0);
      const [x01, z01] = at(i, a1);
      const [x10, z10] = at(i + 1, a0);
      const [x11, z11] = at(i + 1, a1);
      sink.push(x00, z00, a0, p0.foam, kind);
      sink.push(x01, z01, a1, p0.foam, kind);
      sink.push(x10, z10, a0, p1.foam, kind);
      sink.push(x01, z01, a1, p0.foam, kind);
      sink.push(x11, z11, a1, p1.foam, kind);
      sink.push(x10, z10, a0, p1.foam, kind);
    }
  }
}

/**
 * The trailing wake: a widening, fading foam ribbon along the path (strongest right behind the stern). The two
 * Kelvin wedge lines that spread at 19.5 degrees either side of the track are optional and off by default: they
 * cost vertices and read as noise at gameplay distances.
 */
export function buildWake(sink: VertexSink, history: WakeHistory, now: number, ship: WakeShip, kelvin = false): void {
  const s = history.samples;
  if (s.length < 2) return;

  // Oldest to newest; the newest end is at the stern.
  const trail: RibbonPoint[] = [];
  const kelvinL: RibbonPoint[] = [];
  const kelvinR: RibbonPoint[] = [];
  let arc = 0;
  const arcAt: number[] = new Array<number>(s.length).fill(0);
  for (let i = s.length - 2; i >= 0; i--) {
    arc += Math.hypot(s[i + 1]!.x - s[i]!.x, s[i + 1]!.z - s[i]!.z);
    arcAt[i] = arc;
  }

  for (let i = 0; i < s.length; i++) {
    const p = s[i]!;
    const age = Math.max(now - p.t, 0);
    const speedFrac = Math.min(p.speed / ship.referenceSpeed, 1);
    const strength = Math.min(Math.pow(speedFrac, 0.7) * 0.85 + p.power * 0.25, 1);
    const decay = Math.exp(-age / 48);
    // Prop wash: extra-strong, narrower foam in the first seconds.
    const wash = 1 + 0.6 * Math.exp(-age / 5);
    trail.push({
      x: p.x,
      z: p.z,
      halfWidth: ship.beam * 0.42 + 0.3 * age,
      foam: Math.min(strength * decay * wash, 1),
    });

    if (!kelvin) continue;
    // Kelvin wedge: lines at 19.5 degrees to the track, fading with distance and age.
    const d = arcAt[i]!;
    // Kelvin lines have their own channel and threshold in the shader, so their strength is not squashed.
    const kFoam = 0.9 * strength * Math.exp(-age / 42) * (1 / (1 + 0.01 * d));
    const half = 1.0 + 0.03 * d;
    const prev = s[Math.max(i - 1, 0)]!;
    const next = s[Math.min(i + 1, s.length - 1)]!;
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    const off = KELVIN_TAN * d;
    kelvinL.push({ x: p.x - nx * off, z: p.z - nz * off, halfWidth: half, foam: kFoam });
    kelvinR.push({ x: p.x + nx * off, z: p.z + nz * off, halfWidth: half, foam: kFoam });
  }
  emitRibbon(sink, trail);
  if (kelvin) {
    emitRibbon(sink, kelvinL, KIND_KELVIN);
    emitRibbon(sink, kelvinR, KIND_KELVIN);
  }
}

export interface HullFoamShip {
  length: number;
  /** Waterline half-breadth at a ship-space x (metres from amidships, +x bow). */
  halfBreadthAt: (x: number) => number;
  /** Speed as a fraction of the speed at which foam saturates, 0..1. */
  speedFraction: number;
}

/**
 * Foam along the hull at the waterline and a heavier bow wave. Positions are built in ship space and placed with
 * the ship's world position and heading (compass degrees).
 */
export function buildHullFoam(sink: VertexSink, x: number, z: number, headingDeg: number, ship: HullFoamShip): void {
  const speed = ship.speedFraction;
  if (speed < 0.03) return;
  const h = (headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const sx = Math.cos(h);
  const sz = Math.sin(h);
  const toWorld = (lx: number, lz: number): [number, number] => [x + fx * lx + sx * lz, z + fz * lx + sz * lz];

  const bow = ship.length * 0.5;
  for (const side of [-1, 1]) {
    const pts: RibbonPoint[] = [];
    const steps = 22;
    for (let i = 0; i <= steps; i++) {
      // From a little ahead of the stem back to the quarter.
      const lx = bow + 2.5 - (i / steps) * (ship.length * 0.78);
      const hb = ship.halfBreadthAt(Math.min(lx, bow * 0.998));
      const along = (lx + bow) / ship.length; // 0 stern .. 1 bow
      // Heaviest on the bow shoulders, thinning toward amidships, a little again at the stern.
      const bowWave = Math.exp(-((1 - along) * ship.length) / 18);
      const sternWave = 0.25 * Math.exp(-(along * ship.length) / 14);
      const foam = Math.min(Math.pow(speed, 1.1) * (0.28 + 0.95 * bowWave + sternWave), 1);
      const [wx, wz] = toWorld(lx, side * (hb + 0.5 + 1.6 * bowWave * speed));
      pts.push({ x: wx, z: wz, halfWidth: 1.4 + 2.4 * bowWave * speed, foam });
    }
    emitRibbon(sink, pts);
  }
}
