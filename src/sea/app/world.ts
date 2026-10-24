// MC2's buildings, trees and units on the WebGPU page, in metres (MC2 units / 5.01) and the dreadnought game's axes
// (x east, y up, z south): placement, the two sides, selection, and move orders routed over MC2's movement map.
import { ASSET_ROOT, loadBinary, loadJson, type MapInfo, type MechInfo, type ObjectsFile, type UnitsFile } from '../../assets.ts';
import { PLAYER_PAINT, paintFromMission, type PaintScheme } from '../../paint.ts';
import type { Camera } from '../render/camera';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { SeaRenderer } from '../render/sea-renderer';
import { parseGlb, type ModelData } from '../models/glb';
import { AFFINE_FLOATS, Animator, mulAffine, placement, restPose } from '../models/pose';
import { MoveGrid } from '../sim/move-grid';
import type { Terrain } from '../sim/terrain/terrain';

const TURN_RATE = 120; // degrees per second
const ARRIVE_M = 4;
/** The land's colour map is shown at this brightness (map-ground DEFAULT_MAP_LOOK); models match it. */
const GAIN = 1.35;
/** Metres between mechs in a group's formation at its destination. */
const FORMATION_SPACING = 16;
/** The player's own side (team 0 in the mission file). */
export const PLAYER_TEAM = 0;

export class SeaUnit {
  /** Waypoints still to walk, world x and z (metres); empty when standing. */
  route: [number, number][] = [];
  running = false;
  private routeIndex = 0;
  private readonly frame = new Float32Array(AFFINE_FLOATS);

  constructor(
    readonly name: string,
    readonly kind: 'mech' | 'vehicle',
    readonly team: number,
    readonly instance: ModelInstance,
    private readonly animator: Animator | null,
    private readonly rest: Float32Array,
    readonly info: MechInfo | null,
    private readonly scale: number,
    public x: number,
    public z: number,
    /** MC2 rotation, degrees: the unit faces (sin r, cos r) in x, z (0 faces south). */
    public rotation: number,
  ) {}

  /** A unit the player can give orders to. */
  get commandable(): boolean {
    return this.team === PLAYER_TEAM && this.kind === 'mech';
  }

  get clipName(): string {
    return this.animator?.clipName ?? '';
  }

  get clips(): string[] {
    return this.animator?.clips ?? [];
  }

  /** Footprint radius, metres (for the selection ring and picking). */
  get radius(): number {
    return this.instance.model.radius * 0.55;
  }

  play(name: string, fade = 0.2): void {
    this.animator?.play(name, fade);
  }

  walkTo(points: [number, number][]): void {
    this.route = points;
    this.routeIndex = 0;
  }

  stop(): void {
    this.route = [];
    this.play('idle');
  }

  /** Speed from the gesture data: MC2 gives it in metres a second already. */
  get speed(): number {
    return this.info?.clips[this.running ? 'run' : 'walk']?.startVelocity ?? 10;
  }

  /** `move` false keeps the unit where it is (still animating): the perf survey wants the same picture throughout. */
  update(dt: number, terrain: Terrain, move = true): void {
    if (move && this.route.length && this.kind === 'mech') this.steer(dt);
    this.animator?.update(dt);
    const y = terrain.heightAt(this.x, this.z);
    placement(this.frame, this.x, y, this.z, (this.rotation * Math.PI) / 180, this.scale);
    const nodes = this.animator?.matrices ?? this.rest;
    const out = this.instance.matrices;
    for (let k = 0; k < this.instance.model.nodeCount; k++) mulAffine(out, k * AFFINE_FLOATS, this.frame, 0, nodes, k * AFFINE_FLOATS);
    this.instance.center[0] = this.x;
    this.instance.center[1] = y + this.instance.model.radius * 0.5;
    this.instance.center[2] = this.z;
  }

  private steer(dt: number): void {
    const [tx, tz] = this.route[this.routeIndex]!;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const distance = Math.hypot(dx, dz);
    if (distance < ARRIVE_M) {
      this.routeIndex++;
      if (this.routeIndex >= this.route.length) this.stop();
      return;
    }
    const desired = (Math.atan2(dx, dz) * 180) / Math.PI;
    const diff = ((desired - this.rotation + 540) % 360) - 180;
    this.rotation = (this.rotation + Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt) + 360) % 360;
    this.play(this.running ? 'run' : 'walk');
    // Turn in place first when the next waypoint is well off to the side.
    if (Math.abs(diff) < 30) {
      const step = Math.min(distance, this.speed * dt);
      const r = (this.rotation * Math.PI) / 180;
      this.x += Math.sin(r) * step;
      this.z += Math.cos(r) * step;
    }
  }
}

export class World {
  readonly units: SeaUnit[] = [];
  /** The player's units chosen to receive orders. */
  readonly selected = new Set<SeaUnit>();
  /** A unit tapped to look at that isn't the player's (shown in the HUD, not ordered). */
  inspected: SeaUnit | null = null;
  propCount = 0;
  readonly grid: MoveGrid | null;
  private rings: ModelInstance[] = [];
  private ringModel: GpuModel | null = null;
  private inspectRing: ModelInstance | null = null;
  private readonly glbs = new Map<string, Promise<ModelData>>();
  private readonly ringFrame = new Float32Array(AFFINE_FLOATS);

  private constructor(
    private readonly sea: SeaRenderer,
    private readonly terrain: Terrain,
    private readonly info: MapInfo,
    private readonly unitsFile: UnitsFile,
    grid: MoveGrid | null,
  ) {
    this.grid = grid;
  }

  private get scale(): number {
    return 1 / this.info.worldUnitsPerMeter;
  }

  static async load(sea: SeaRenderer, terrain: Terrain, info: MapInfo, mapDir: string, progress: (text: string) => void): Promise<World> {
    const [objects, unitsFile, cells] = await Promise.all([
      loadJson<ObjectsFile>(mapDir + 'objects.json'),
      loadJson<UnitsFile>(mapDir + 'units.json'),
      info.move ? loadBinary(mapDir + info.move.file) : Promise.resolve(null),
    ]);
    // The movement map covers the same square as the terrain: side * 128 MC2 units.
    const extent = (info.side * info.worldUnitsPerVertex) / info.worldUnitsPerMeter;
    const grid =
      cells && info.move ? new MoveGrid(new Uint32Array(cells), info.move.width, info.move.height, extent / info.move.width, [-extent / 2, -extent / 2]) : null;
    const world = new World(sea, terrain, info, unitsFile, grid);
    progress('Loading buildings and trees…');
    await world.placeProps(objects);
    progress('Loading units…');
    await Promise.all(
      unitsFile.units.map(async (u) => {
        const paint = u.player ? PLAYER_PAINT : paintFromMission(u.colors);
        // The stats file's name (Werewolf, Bushwacker) reads better than the object file's (werewolf, BushWacker).
        const unit = await world.spawn(u.model, u.kind, u.csv || u.name, u.team, u.x * world.scale, -u.y * world.scale, u.rotation, paint);
        world.units.push(unit);
      }),
    );
    // The showcase mechs (Atlas, Madcat) join the player's lance beside its first mech.
    const lead = world.units.find((u) => u.commandable);
    for (const [i, key] of unitsFile.showcase.entries()) {
      const [x, z] = world.openNear((lead?.x ?? 0) + (i ? 1 : -1) * 2.2 * FORMATION_SPACING, (lead?.z ?? 0) + FORMATION_SPACING);
      const paint = i % 2 ? PLAYER_PAINT : paintFromMission(['#3a5f8f', '#c8c8c8', '#202830']);
      const name = key.charAt(0).toUpperCase() + key.slice(1);
      world.units.push(await world.spawn(key, 'mech', name, PLAYER_TEAM, x, z, lead?.rotation ?? 0, paint));
    }
    world.ringModel = await world.sea.models.addModel(selectionRing('selection-ring', [0.35, 1, 0.3, 1]), { scale: 1, unlit: true, gain: 1.4 });
    world.inspectRing = world.sea.models.addInstance(
      await world.sea.models.addModel(selectionRing('inspect-ring', [1, 0.3, 0.2, 1]), { scale: 1, unlit: true, gain: 1.4 }),
    );
    const first = world.units.find((u) => u.commandable);
    if (first) world.selected.add(first);
    return world;
  }

  /** Put a mech or vehicle on the map (world metres). */
  async spawn(key: string, kind: 'mech' | 'vehicle', name: string, team: number, x: number, z: number, rotation: number, paint: PaintScheme): Promise<SeaUnit> {
    const info = kind === 'mech' ? (this.unitsFile.mechs[key] ?? null) : null;
    const data = await this.glb(info ? info.model : `models/props/${key}.glb`);
    const model = await this.sea.models.addModel(data, { scale: this.scale, paint, gain: GAIN });
    const animator = data.clips.size ? new Animator(data) : null;
    const unit = new SeaUnit(name, kind, team, this.sea.models.addInstance(model), animator, restPose(data), info, this.scale, x, z, rotation);
    if (animator) {
      animator.play('idle', 0, Math.random() * 3); // out of step, so a lance does not breathe in unison
    }
    unit.update(0, this.terrain);
    return unit;
  }

  remove(unit: SeaUnit): void {
    this.units.splice(this.units.indexOf(unit), 1);
    this.sea.models.removeInstance(unit.instance);
    this.selected.delete(unit);
    if (this.inspected === unit) this.inspected = null;
  }

  /** Tap on a unit: the player's own replace the selection (or toggle in it when `add`); others are only inspected. */
  tapUnit(unit: SeaUnit, add: boolean): void {
    if (!unit.commandable) {
      this.inspected = unit;
      return;
    }
    this.inspected = null;
    if (add) {
      if (this.selected.has(unit)) this.selected.delete(unit);
      else this.selected.add(unit);
    } else {
      this.selected.clear();
      this.selected.add(unit);
    }
  }

  selectAll(): void {
    this.inspected = null;
    for (const u of this.units) if (u.commandable) this.selected.add(u);
  }

  stopSelected(): void {
    for (const u of this.selected) u.stop();
  }

  setRunning(running: boolean): void {
    for (const u of this.selected) u.running = running;
  }

  /**
   * Send the selected mechs to a point: each gets a slot in a formation about it (the nearest mechs to the point taking
   * the slots nearest its middle), moved onto open ground, and a route there over the movement map.
   */
  orderMove(x: number, z: number): number {
    const units = [...this.selected].filter((u) => u.kind === 'mech');
    if (!units.length) return 0;
    units.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const slots = formationSlots(units.length, FORMATION_SPACING);
    let routed = 0;
    units.forEach((u, i) => {
      const [sx, sz] = this.openNear(x + slots[i]![0], z + slots[i]![1]);
      const route = this.grid ? this.grid.findPath(u.x, u.z, sx, sz) : [[sx, sz] as [number, number]];
      if (route) {
        u.walkTo(route);
        routed++;
      }
    });
    return routed;
  }

  update(dt: number, move = true): void {
    for (const u of this.units) u.update(dt, this.terrain, move);
    this.updateRings();
  }

  /** What a tap at normalised device coordinates hits: a unit, or the ground (world x, z), or nothing. */
  pick(camera: Camera, ndcX: number, ndcY: number): SeaUnit | [number, number] | null {
    const o = camera.position;
    const d = camera.rayThrough(ndcX, ndcY);
    let best: SeaUnit | null = null;
    let bestT = Infinity;
    for (const u of this.units) {
      const c = u.instance.center;
      const t = (c[0] - o[0]) * d[0] + (c[1] - o[1]) * d[1] + (c[2] - o[2]) * d[2];
      if (t <= 0 || t >= bestT) continue;
      const miss = Math.hypot(o[0] + d[0] * t - c[0], o[1] + d[1] * t - c[1], o[2] + d[2] * t - c[2]);
      if (miss < u.instance.model.radius * 0.6) {
        best = u;
        bestT = t;
      }
    }
    if (best) return best;
    // March to the ground (the sea counts: mechs wade), then halve the last step a few times.
    const above = (t: number) => o[1] + d[1] * t - Math.max(this.terrain.heightAt(o[0] + d[0] * t, o[2] + d[2] * t), 0);
    let prev = 0;
    for (let t = 2; t < 8000; t += Math.max(2, t * 0.01)) {
      if (above(t) <= 0) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        return [o[0] + d[0] * hi, o[2] + d[2] * hi];
      }
      prev = t;
    }
    return null;
  }

  /** The nearest point a mech can stand on (the point itself if it's open, else the centre of the nearest open cell). */
  private openNear(x: number, z: number): [number, number] {
    const grid = this.grid;
    if (!grid) return [x, z];
    const [r, c] = grid.cellOf(x, z);
    if (grid.open(r, c)) return [x, z];
    const cell = grid.nearestOpen(x, z);
    return cell ? grid.centre(cell[0], cell[1]) : [x, z];
  }

  /** A green ring under each selected unit (from a pool that grows as needed) and a red one under an inspected unit. */
  private updateRings(): void {
    if (!this.ringModel) return;
    const marked = [...this.selected];
    while (this.rings.length < marked.length) this.rings.push(this.sea.models.addInstance(this.ringModel));
    this.rings.forEach((ring, i) => this.placeRing(ring, marked[i]));
    if (this.inspectRing) this.placeRing(this.inspectRing, this.inspected ?? undefined);
  }

  private placeRing(ring: ModelInstance, u: SeaUnit | undefined): void {
    ring.visible = u !== undefined;
    if (!u) return;
    const y = this.terrain.heightAt(u.x, u.z);
    placement(this.ringFrame, u.x, Math.max(y, 0) + 0.4, u.z, 0, u.radius);
    ring.matrices.set(this.ringFrame);
    ring.center[0] = u.x;
    ring.center[1] = y;
    ring.center[2] = u.z;
    ring.radius = u.radius;
  }

  private async placeProps(objects: ObjectsFile): Promise<void> {
    const byModel = new Map<number, ObjectsFile['instances']>();
    for (const inst of objects.instances) byModel.set(inst[0], [...(byModel.get(inst[0]) ?? []), inst]);
    const frame = new Float32Array(AFFINE_FLOATS);
    await Promise.all(
      [...byModel].map(async ([mi, list]) => {
        const data = await this.glb(objects.models[mi]!);
        const model: GpuModel = await this.sea.models.addModel(data, { scale: this.scale, gain: GAIN });
        const rest = restPose(data);
        for (const [, ux, uy, , rot] of list) {
          const x = ux * this.scale;
          const z = -uy * this.scale;
          const y = this.terrain.heightAt(x, z);
          const inst = this.sea.models.addInstance(model);
          placement(frame, x, y, z, (rot * Math.PI) / 180, this.scale);
          for (let k = 0; k < model.nodeCount; k++) mulAffine(inst.matrices, k * AFFINE_FLOATS, frame, 0, rest, k * AFFINE_FLOATS);
          inst.center[0] = x;
          inst.center[1] = y;
          inst.center[2] = z;
          this.propCount++;
        }
      }),
    );
  }

  private glb(path: string): Promise<ModelData> {
    let entry = this.glbs.get(path);
    if (!entry) {
      entry = fetch(ASSET_ROOT + path).then(async (res) => {
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return parseGlb(await res.arrayBuffer(), path.split('/').pop()!.replace('.glb', ''));
      });
      this.glbs.set(path, entry);
    }
    return entry;
  }
}

/** Offsets for `count` units about a point: the middle, then rings of six, twelve, ... `spacing` apart. */
function formationSlots(count: number, spacing: number): [number, number][] {
  const slots: [number, number][] = [[0, 0]];
  for (let ring = 1; slots.length < count; ring++) {
    const around = ring * 6;
    for (let k = 0; k < around && slots.length < count; k++) {
      const a = (k / around) * Math.PI * 2 + ring * 0.4;
      slots.push([Math.cos(a) * ring * spacing, Math.sin(a) * ring * spacing]);
    }
  }
  return slots;
}

/** A flat ring of radius 0.85..1 on the ground, for marking units (scaled to each one's footprint). */
function selectionRing(name: string, color: [number, number, number, number]): ModelData {
  const segments = 48;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85, Math.cos(a), 0, Math.sin(a));
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const count = positions.length / 3;
  return {
    name,
    nodes: [{ name: 'ring', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    materials: [{ name: 'ring', image: null, color, alphaCutoff: null, doubleSided: true }],
    primitives: [
      {
        node: 0,
        material: 0,
        positions: new Float32Array(positions),
        normals: new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
        uvs: new Float32Array(count * 2),
        indices: new Uint32Array(indices),
      },
    ],
    clips: new Map(),
  };
}
