// MC2's movement map (mclib/move.h MapCell, mclib/move.cpp MoveMap::setUp) and an A* pathfinder over it, for each way
// of moving: mechs wade the shallows (MC2's own rule), hovercraft cross any water, ground vehicles and infantry keep
// to land and fords, and helicopters fly over all of it (MC2's move level 2). Ground vehicles and hovercraft (MC2's
// infantry are ground vehicles too) keep to the roads.
//
// The map is 3 cells to a terrain tile: 300 x 300 cells of 8.5 m for mc2_01, row 0 at the north edge, laid over the
// same square as the terrain. World positions are the WebGPU page's metres (x east, z south).

const PASSABLE = 1 << 10;
const OFFMAP = 1 << 9;
const SHALLOW = 1 << 26;
const DEEP = 1 << 27;
const FOREST = 1 << 28;
const ROAD = 1 << 25;

/**
 * Relative costs. The engine's clear cost is a cell's length over the mover's top speed times 50 (about 28 for a
 * 15 m/s mech) and a forest cell adds 50 (mclib/move.cpp MoveMap::forestCost): forest is about 2.8 times clear ground.
 */
const CLEAR = 1;
const FOREST_EXTRA = 1.8;
/**
 * A road cell costs a quarter of clear ground to whatever follows roads (MOVEPARAM_FOLLOW_ROADS, which every
 * GroundVehicle sets, code/gvehicl.cpp): routes keep to them. They're no quicker to drive. The search's estimate counts
 * clear ground, so a route takes a road that goes its way rather than going far round to one.
 */
const ROAD_COST = CLEAR / 4;
const BLOCKED = Infinity;
const DIAGONAL = Math.SQRT2;
/** Ground vehicles and infantry ford water this deep at most, metres. */
const FORD_M = 1;

/** How a unit gets about: walking (wading the shallows), hovering over water, on wheels, tracks or foot, or flying. */
export type MoveClass = 'mech' | 'hover' | 'ground' | 'air';

export class MoveGrid {
  /** Cost to enter each cell for a mech (Infinity: blocked). */
  readonly cost: Float32Array;
  /** Metres from the west and north edges of the map to the grid's first cell edge. */
  readonly x0: number;
  readonly z0: number;

  /** Connected region of each open cell (-1 blocked), worked out on first use. */
  private regions: Int32Array | null = null;

  constructor(
    cells: Uint32Array,
    readonly width: number,
    readonly height: number,
    /** Metres per cell. */
    readonly cell: number,
    /** World x, z of the north-west corner. */
    origin: [number, number],
    readonly moveClass: MoveClass = 'mech',
    /** Water depth at a world point, metres (0 on land): for fords. */
    depthAt: (x: number, z: number) => number = () => 0,
  ) {
    [this.x0, this.z0] = origin;
    this.cost = new Float32Array(width * height);
    for (let i = 0; i < cells.length; i++) {
      const d = cells[i]!;
      let c: number;
      if (d & OFFMAP) c = BLOCKED;
      else if (moveClass === 'air') c = CLEAR;
      else if (moveClass === 'hover' && d & (SHALLOW | DEEP)) c = CLEAR;
      // Mechs wade shallow water and are kept out of deep water (MOVEPARAM_WATER_SHALLOW, mclib/move.cpp:4886).
      else if (d & DEEP || !(d & PASSABLE)) c = BLOCKED;
      else c = (d & ROAD && (moveClass === 'ground' || moveClass === 'hover') ? ROAD_COST : CLEAR) + (d & FOREST ? FOREST_EXTRA : 0);
      if (moveClass === 'ground' && c < BLOCKED) {
        const [x, z] = this.centre(Math.floor(i / width), i % width);
        if (depthAt(x, z) > FORD_M) c = BLOCKED;
      }
      this.cost[i] = c;
    }
  }

  /** Can a unit of this class get from one world point to the other (each moved to its nearest open cell)? */
  connected(ax: number, az: number, bx: number, bz: number): boolean {
    const a = this.nearestOpen(ax, az);
    const b = this.nearestOpen(bx, bz);
    if (!a || !b) return false;
    const regions = this.regions ?? this.label();
    return regions[a[0] * this.width + a[1]] === regions[b[0] * this.width + b[1]];
  }

  /** Flood-fill the open cells into connected regions (four neighbours, as a route never cuts a blocked corner). */
  private label(): Int32Array {
    const { width, height } = this;
    const regions = new Int32Array(width * height).fill(-1);
    const stack: number[] = [];
    let next = 0;
    for (let start = 0; start < regions.length; start++) {
      if (regions[start] !== -1 || this.cost[start]! >= BLOCKED) continue;
      regions[start] = next;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop()!;
        const r = (i / width) | 0;
        const c = i % width;
        for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]] as const) {
          if (!this.open(nr, nc)) continue;
          const k = nr * width + nc;
          if (regions[k] === -1) {
            regions[k] = next;
            stack.push(k);
          }
        }
      }
      next++;
    }
    this.regions = regions;
    return regions;
  }

  cellOf(x: number, z: number): [number, number] {
    return [Math.floor((z - this.z0) / this.cell), Math.floor((x - this.x0) / this.cell)];
  }

  /** World x, z of a cell's centre. */
  centre(row: number, col: number): [number, number] {
    return [this.x0 + (col + 0.5) * this.cell, this.z0 + (row + 0.5) * this.cell];
  }

  /** Is the ground at a world point woodland (where infantry find cover)? */
  forestAt(x: number, z: number): boolean {
    const [r, c] = this.cellOf(x, z);
    return this.open(r, c) && this.cost[r * this.width + c]! > CLEAR;
  }

  open(row: number, col: number): boolean {
    return row >= 0 && col >= 0 && row < this.height && col < this.width && this.cost[row * this.width + col]! < BLOCKED;
  }

  /** The open cell nearest a world point (searching outwards in rings), or null if none within `maxRings`. */
  nearestOpen(x: number, z: number, maxRings = 40): [number, number] | null {
    const [r0, c0] = this.cellOf(x, z);
    if (this.open(r0, c0)) return [r0, c0];
    for (let ring = 1; ring <= maxRings; ring++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring || !this.open(r0 + dr, c0 + dc)) continue;
          const d = dr * dr + dc * dc;
          if (d < bestD) {
            bestD = d;
            best = [r0 + dr, c0 + dc];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * A route for a mech from one world point to another: A* over the cells (8 neighbours, no cutting the corners of
   * blocked cells), then pulled tight so it only turns where something is in the way. Returns world waypoints ending at
   * the goal (or at the open cell nearest it), or null when the goal can't be reached.
   */
  findPath(fromX: number, fromZ: number, toX: number, toZ: number): [number, number][] | null {
    const start = this.nearestOpen(fromX, fromZ);
    const goal = this.nearestOpen(toX, toZ);
    if (!start || !goal) return null;
    const { width, height, cost } = this;
    const n = width * height;
    const startI = start[0] * width + start[1];
    const goalI = goal[0] * width + goal[1];
    // In plain sight: the search would pull its route tight to this one leg anyway.
    if (this.clearLine(startI, goalI)) return [this.open(...this.cellOf(toX, toZ)) ? [toX, toZ] : this.centre(goal[0], goal[1])];
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const h = (i: number) => {
      const dr = Math.abs(((i / width) | 0) - goal[0]);
      const dc = Math.abs((i % width) - goal[1]);
      return (dr + dc + (DIAGONAL - 2) * Math.min(dr, dc)) * CLEAR;
    };
    g[startI] = 0;
    heap.push(startI, h(startI));
    while (heap.size) {
      const i = heap.pop();
      if (i === goalI) break;
      if (closed[i]) continue;
      closed[i] = 1;
      const r = (i / width) | 0;
      const c = i % width;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
          const j = nr * width + nc;
          const step = cost[j]!;
          if (step === BLOCKED || closed[j]) continue;
          // No squeezing diagonally between two blocked cells' corners.
          if (dr && dc && (cost[r * width + nc] === BLOCKED || cost[nr * width + c] === BLOCKED)) continue;
          const tentative = g[i]! + step * (dr && dc ? DIAGONAL : 1);
          if (tentative < g[j]!) {
            g[j] = tentative;
            came[j] = i;
            heap.push(j, tentative + h(j));
          }
        }
      }
    }
    if (startI !== goalI && came[goalI] === -1) return null;

    const cells: number[] = [];
    for (let i = goalI; i !== -1; i = came[i]!) cells.push(i);
    cells.reverse();
    // String-pull: from each kept cell, skip ahead to the furthest cell in plain sight.
    const kept: number[] = [cells[0]!];
    let k = 0;
    while (k < cells.length - 1) {
      let next = k + 1;
      for (let m = cells.length - 1; m > k + 1; m--) {
        if (this.clearLine(cells[k]!, cells[m]!)) {
          next = m;
          break;
        }
      }
      kept.push(cells[next]!);
      k = next;
    }
    const route = kept.slice(1).map((i) => this.centre((i / width) | 0, i % width));
    // End at the point asked for when it is itself open ground, not at its cell's centre.
    if (this.open(...this.cellOf(toX, toZ))) route[route.length - 1] = [toX, toZ];
    return route.length ? route : [[toX, toZ]];
  }

  /** A straight walk from one point to the other crosses only open ground (see clearLine): no search needed. */
  straight(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    const start = this.nearestOpen(fromX, fromZ);
    const goal = this.nearestOpen(toX, toZ);
    return !!start && !!goal && this.clearLine(start[0] * this.width + start[1], goal[0] * this.width + goal[1]);
  }

  /**
   * Whether a straight walk between two cells' centres crosses only open cells of no greater cost than the cheapest of
   * its ends (so pulling a route tight never drags it through forest it was routed around).
   */
  private clearLine(a: number, b: number): boolean {
    const { width, cost } = this;
    let r0 = (a / width) | 0;
    let c0 = a % width;
    const r1 = (b / width) | 0;
    const c1 = b % width;
    const limit = Math.min(cost[a]!, cost[b]!) + 1e-3;
    const dr = Math.abs(r1 - r0);
    const dc = Math.abs(c1 - c0);
    const sr = r0 < r1 ? 1 : -1;
    const sc = c0 < c1 ? 1 : -1;
    let err = dc - dr;
    // A supercover walk: every cell the line touches, including both cells at a diagonal step.
    for (;;) {
      if (cost[r0 * width + c0]! > limit) return false;
      if (r0 === r1 && c0 === c1) return true;
      const e2 = 2 * err;
      if (e2 > -dr && e2 < dc) {
        if (cost[r0 * width + c0 + sc]! > limit || cost[(r0 + sr) * width + c0]! > limit) return false;
      }
      if (e2 > -dr) {
        err -= dr;
        c0 += sc;
      }
      if (e2 < dc) {
        err += dc;
        r0 += sr;
      }
    }
  }
}

/** A binary min-heap of (item, priority), with duplicates allowed (stale entries are skipped by the caller). */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      items[i] = items[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const { items, keys } = this;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (items.length) {
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[m]! >= lastKey) break;
        items[i] = items[m]!;
        keys[i] = keys[m]!;
        i = m;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}
