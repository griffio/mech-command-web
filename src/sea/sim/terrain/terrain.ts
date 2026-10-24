/** Radius of the earth, metres: the same one the renderer drops distant things by and the gunnery's horizon uses. */
export const EARTH_RADIUS = 6371000;

/** A height above or below the sea, in metres, on a square lattice of samples. */
export interface TerrainGrid {
  /** World position of the first sample (the south-west... that is, the minimum x and z corner), metres. */
  x0: number;
  z0: number;
  /** Metres between samples. */
  cell: number;
  /** Samples along x and z. */
  nx: number;
  nz: number;
  /** Heights, row by row in z then x: positive is land, negative is the depth of the sea floor. */
  heights: Float32Array;
}

/** Heights at or above this are land: the sea washes the rest. */
export const SHORE = 0.25;

/** One line of the coast: two world points. */
export type CoastSegment = readonly [number, number, number, number];

/**
 * The ground under the fight: islands and headlands above the sea, and the sea floor below it. It answers what the guns and
 * the helm need to know: how high the land is, how deep the water is, whether land lies between two points, and where a shell
 * strikes it. Beyond the edge of the grid is open sea.
 */
export class Terrain {
  readonly x0: number;
  readonly z0: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  /** Depth of the open sea beyond the grid, metres (a positive number). */
  readonly openDepth: number;
  /** The highest land, metres. */
  readonly maxHeight: number;

  constructor(grid: TerrainGrid, openDepth = 60) {
    this.x0 = grid.x0;
    this.z0 = grid.z0;
    this.cell = grid.cell;
    this.nx = grid.nx;
    this.nz = grid.nz;
    this.heights = grid.heights;
    this.openDepth = openDepth;
    let top = 0;
    for (const h of grid.heights) if (h > top) top = h;
    this.maxHeight = top;
  }

  get x1(): number {
    return this.x0 + (this.nx - 1) * this.cell;
  }
  get z1(): number {
    return this.z0 + (this.nz - 1) * this.cell;
  }

  private sample(ix: number, iz: number): number {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -this.openDepth;
    return this.heights[iz * this.nx + ix]!;
  }

  /** Height of the ground (or the sea floor, negative) at a point, metres: a bilinear blend of the four samples about it. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.x0) / this.cell;
    const fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.nx - 1 || fz >= this.nz - 1) return this.sample(Math.round(fx), Math.round(fz));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const row = iz * this.nx + ix;
    const h = this.heights;
    const a = h[row]! * (1 - tx) + h[row + 1]! * tx;
    const b = h[row + this.nx]! * (1 - tx) + h[row + this.nx + 1]! * tx;
    return a * (1 - tz) + b * tz;
  }

  isLand(x: number, z: number): boolean {
    return this.heightAt(x, z) > SHORE;
  }

  /** How deep the water is at a point, metres; 0 on land. */
  depthAt(x: number, z: number): number {
    return Math.max(-this.heightAt(x, z), 0);
  }

  /** Slope of the ground at a point: the unit normal, y up. */
  normalAt(x: number, z: number): [number, number, number] {
    const e = this.cell;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const l = Math.hypot(dx, 2 * e, dz);
    return [-dx / l, (2 * e) / l, -dz / l];
  }

  /**
   * Is there land between the two points, on the straight line of sight, with the earth's curve taken into account? `ay` and
   * `by` are heights above the sea. The sea itself is not tested (the horizon formulas see to that): only the ground.
   */
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const d = Math.hypot(dx, dz);
    if (d < 1) return false;
    // A line that stays above the highest ground, allowing for the bulge of the earth, cannot be blocked.
    const bulgeMax = (d * d) / (8 * EARTH_RADIUS);
    if (Math.min(ay, by) > this.maxHeight + bulgeMax) return false;
    const n = Math.max(Math.ceil(d / (this.cell * 0.7)), 2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const h = this.heightAt(ax + dx * t, az + dz * t);
      if (h <= SHORE) continue;
      // The ground rises into the line by the curve of the earth between the ends.
      const rise = (d * d * t * (1 - t)) / (2 * EARTH_RADIUS);
      if (h + rise > ay + (by - ay) * t) return true;
    }
    return false;
  }

  /**
   * Where a shell going from p0 to p1 first strikes the ground, or null. Water is not ground: a shell that reaches the sea
   * is the shell world's business. `t` is how far along the step it struck (0..1).
   */
  segmentHit(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): { x: number; y: number; z: number; t: number } | null {
    if (y0 > this.maxHeight && y1 > this.maxHeight) return null;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(Math.ceil(len / (this.cell * 0.5)), 1);
    let prevOver = y0 - Math.max(this.heightAt(x0, z0), 0);
    if (prevOver <= 0 && this.heightAt(x0, z0) <= SHORE) prevOver = 1;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = y0 + (y1 - y0) * t;
      const g = this.heightAt(x, z);
      if (g <= SHORE) {
        prevOver = y;
        continue;
      }
      const over = y - g;
      if (over <= 0) {
        // Crossed the ground in this sub-step: interpolate where.
        const f = prevOver > 0 ? prevOver / (prevOver - over) : 0;
        const tt = (i - 1 + f) / n;
        const hx = x0 + (x1 - x0) * tt;
        const hz = z0 + (z1 - z0) * tt;
        return { x: hx, y: Math.max(this.heightAt(hx, hz), 0), z: hz, t: tt };
      }
      prevOver = over;
    }
    return null;
  }

  /**
   * Level the ground about a point for a gun site: within `radius` of (cx, cz) the land is made flat at the height it has
   * there, and it blends back into the hillside over the next `margin` metres. Call before anything has been built from the
   * heights.
   */
  flatten(cx: number, cz: number, radius: number, margin: number): number {
    const level = Math.max(this.heightAt(cx, cz), 1);
    const reach = radius + margin;
    const ix0 = Math.max(Math.floor((cx - reach - this.x0) / this.cell), 0);
    const ix1 = Math.min(Math.ceil((cx + reach - this.x0) / this.cell), this.nx - 1);
    const iz0 = Math.max(Math.floor((cz - reach - this.z0) / this.cell), 0);
    const iz1 = Math.min(Math.ceil((cz + reach - this.z0) / this.cell), this.nz - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = Math.hypot(this.x0 + ix * this.cell - cx, this.z0 + iz * this.cell - cz);
        if (d >= reach) continue;
        const w = d <= radius ? 1 : 1 - (d - radius) / margin;
        const k = w * w * (3 - 2 * w);
        const i = iz * this.nx + ix;
        this.heights[i] = this.heights[i]! * (1 - k) + level * k;
      }
    }
    return level;
  }

  /** The coastline as line segments (the zero contour of the heights), by marching squares. */
  coast(level = 0): CoastSegment[] {
    const out: CoastSegment[] = [];
    const { nx, nz, cell, x0, z0, heights } = this;
    const edge = (ax: number, az: number, ha: number, bx: number, bz: number, hb: number): [number, number] => {
      const f = (level - ha) / (hb - ha || 1e-9);
      return [x0 + (ax + (bx - ax) * f) * cell, z0 + (az + (bz - az) * f) * cell];
    };
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const h00 = heights[iz * nx + ix]!;
        const h10 = heights[iz * nx + ix + 1]!;
        const h01 = heights[(iz + 1) * nx + ix]!;
        const h11 = heights[(iz + 1) * nx + ix + 1]!;
        let code = 0;
        if (h00 > level) code |= 1;
        if (h10 > level) code |= 2;
        if (h11 > level) code |= 4;
        if (h01 > level) code |= 8;
        if (code === 0 || code === 15) continue;
        // Crossing points on the four edges: bottom (z = iz), right, top (z = iz+1), left.
        const bottom = () => edge(ix, iz, h00, ix + 1, iz, h10);
        const right = () => edge(ix + 1, iz, h10, ix + 1, iz + 1, h11);
        const top = () => edge(ix, iz + 1, h01, ix + 1, iz + 1, h11);
        const left = () => edge(ix, iz, h00, ix, iz + 1, h01);
        const seg = (a: [number, number], b: [number, number]) => out.push([a[0], a[1], b[0], b[1]]);
        switch (code) {
          case 1:
          case 14:
            seg(left(), bottom());
            break;
          case 2:
          case 13:
            seg(bottom(), right());
            break;
          case 3:
          case 12:
            seg(left(), right());
            break;
          case 4:
          case 11:
            seg(right(), top());
            break;
          case 6:
          case 9:
            seg(bottom(), top());
            break;
          case 7:
          case 8:
            seg(left(), top());
            break;
          case 5:
            seg(left(), top());
            seg(bottom(), right());
            break;
          case 10:
            seg(left(), bottom());
            seg(right(), top());
            break;
        }
      }
    }
    return out;
  }
}

/** Join the loose segments of a coast into polylines (shared ends are matched to the nearest metre). */
export function chainCoast(segments: readonly CoastSegment[], tolerance = 0.5): [number, number][][] {
  const key = (x: number, z: number) => `${Math.round(x / tolerance)},${Math.round(z / tolerance)}`;
  const byEnd = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
      const list = byEnd.get(k);
      if (list) list.push(i);
      else byEnd.set(k, [i]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const lines: [number, number][][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const s = segments[i]!;
    const line: [number, number][] = [
      [s[0], s[1]],
      [s[2], s[3]],
    ];
    // Grow at the tail, then at the head.
    for (const atTail of [true, false]) {
      for (;;) {
        const end = atTail ? line[line.length - 1]! : line[0]!;
        const next = (byEnd.get(key(end[0], end[1])) ?? []).find((j) => !used[j]);
        if (next === undefined) break;
        used[next] = true;
        const n = segments[next]!;
        const startsHere = key(n[0], n[1]) === key(end[0], end[1]);
        const far: [number, number] = startsHere ? [n[2], n[3]] : [n[0], n[1]];
        if (atTail) line.push(far);
        else line.unshift(far);
      }
    }
    lines.push(line);
  }
  return lines;
}
