// MC2's buildings, trees and units on the WebGPU page, in metres (MC2 units / 5.01) and the dreadnought game's axes
// (x east, y up, z south): placement, the two sides, selection, move orders routed over MC2's movement map, and attack
// orders (the fighting itself is Battle's).
import { ASSET_ROOT, loadBinary, loadJson, type CombatFile, type MapInfo, type MechInfo, type ObjectsFile, type UnitsFile } from '../../assets.ts';
import { PLAYER_PAINT, paintFromMission, type PaintScheme } from '../../paint.ts';
import type { Camera } from '../render/camera';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { SeaRenderer } from '../render/sea-renderer';
import { parseGlb, type ModelData } from '../models/glb';
import { AFFINE_FLOATS, Animator, mulAffine, placement, restPose } from '../models/pose';
import { MechCombat, VehicleCombat } from '../sim/combat';
import { MoveGrid } from '../sim/move-grid';
import type { Terrain } from '../sim/terrain/terrain';
import { Battle } from './battle';

const TURN_RATE = 120; // degrees per second
/** Every ground vehicle moves at this, metres a second (gamesys.fit). */
const VEHICLE_SPEED = 9;
/** How fast a vehicle's turret turns, degrees a second. */
const TURRET_RATE = 180;
const ARRIVE_M = 4;
/** The land's colour map is shown at this brightness (map-ground DEFAULT_MAP_LOOK); models match it. */
const GAIN = 1.35;
/** Metres between mechs in a group's formation at its destination. */
const FORMATION_SPACING = 16;
/** The player's own side (team 0 in the mission file). */
export const PLAYER_TEAM = 0;
/** Paint for burnt-out wrecks: every team colour goes to soot. */
const WRECK_PAINT: PaintScheme = { red: '#2b2724', green: '#2b2724', blue: '#2b2724' };
const WRECK_GAIN = 0.55;

/** How a unit is drawn. */
export interface UnitBody {
  instance: ModelInstance;
  animator: Animator | null;
  rest: Float32Array;
  info: MechInfo | null;
  scale: number;
  /** Node index by name: weapon mounts, the cockpit, the torso joint. */
  nodes: Map<string, number>;
  /** The GLB it was made from (its wreck is drawn from it too). */
  modelPath: string;
}

type V3 = [number, number, number];

export class SeaUnit {
  /** Waypoints still to walk, world x and z (metres); empty when standing. */
  route: [number, number][] = [];
  running = false;
  /** Whom it shoots at, chosen each combat tick (see Battle). */
  target: SeaUnit | null = null;
  /** An enemy the player ordered it to attack: it closes in and stays on it until one of them is destroyed. */
  attackOrder: SeaUnit | null = null;
  /** The route is the battle's (closing on a target), not the player's. */
  engaging = false;
  /** Torso twist (mechs) or turret angle (vehicles) from the hull, degrees. */
  twist = 0;
  instance: ModelInstance;
  readonly info: MechInfo | null;
  readonly modelPath: string;
  private routeIndex = 0;
  private turning = false;
  private readonly frame = new Float32Array(AFFINE_FLOATS);
  private readonly animator: Animator | null;
  private readonly rest: Float32Array;
  private readonly scale: number;
  private readonly nodes: Map<string, number>;
  private readonly torsoNode: number;

  constructor(
    readonly name: string,
    readonly kind: 'mech' | 'vehicle',
    readonly team: number,
    body: UnitBody,
    /** Its armour, weapons and pilot; null for a unit that has no stats (it can't fight or be hurt). */
    readonly combat: MechCombat | VehicleCombat | null,
    public x: number,
    public z: number,
    /** MC2 rotation, degrees: the unit faces (sin r, cos r) in x, z (0 faces south). */
    public rotation: number,
  ) {
    this.instance = body.instance;
    this.animator = body.animator;
    this.rest = body.rest;
    this.info = body.info;
    this.scale = body.scale;
    this.nodes = body.nodes;
    this.modelPath = body.modelPath;
    this.torsoNode = body.nodes.get('joint_torso') ?? -1;
  }

  get alive(): boolean {
    return this.combat?.alive ?? true;
  }

  /** A unit the player can give orders to. */
  get commandable(): boolean {
    return this.team === PLAYER_TEAM && this.kind === 'mech' && this.alive;
  }

  /** Where its weapons point: the torso's facing on a mech, the turret's on a vehicle (MC2 degrees). */
  get aimYaw(): number {
    return this.rotation + this.twist;
  }

  /** How far the torso or turret turns either way, degrees (0: the hull must face the target). */
  private get twistLimit(): number {
    const stats = this.combat?.stats;
    if (!stats) return 0;
    return 'torsoYaw' in stats ? stats.torsoYaw : stats.turretYaw;
  }

  private get twistRate(): number {
    const stats = this.combat?.stats;
    return stats && 'torsoYawRate' in stats ? stats.torsoYawRate : TURRET_RATE;
  }

  /** A node's position in the world, metres (null if the model has no such node). */
  nodePosition(name: string): V3 | null {
    const k = this.nodes.get(name);
    if (k === undefined) return null;
    const m = this.instance.matrices;
    const o = k * AFFINE_FLOATS;
    return [m[o + 3]!, m[o + 7]!, m[o + 11]!];
  }

  /** Height its pilot sees from, metres above the sea. */
  get eyeY(): number {
    return this.instance.center[1] + this.instance.model.radius * 0.25;
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
    this.engaging = false;
    this.play('idle');
  }

  /** Fall (backward when the killing shot came from the front) and stop fighting. */
  die(fromFront: boolean): void {
    this.route = [];
    this.target = null;
    this.attackOrder = null;
    this.engaging = false;
    // The models' destroyed gestures carry no keys; the falls they match frame for frame do.
    this.animator?.play(fromFront ? 'fallBackward' : 'fallForward', 0.15, 0, false);
  }

  /** A dead mech has finished falling (a vehicle has nothing to play). */
  get fallen(): boolean {
    return !this.animator || this.animator.finished;
  }

  /** Speed from the gesture data (MC2 gives it in metres a second already); vehicles all move alike. */
  get speed(): number {
    if (this.kind === 'vehicle') return VEHICLE_SPEED;
    return this.info?.clips[this.running ? 'run' : 'walk']?.startVelocity ?? 10;
  }

  /** `move` false keeps the unit where it is (still animating): the perf survey wants the same picture throughout. */
  update(dt: number, terrain: Terrain, move = true): void {
    if (move && this.alive) {
      if (this.route.length) this.steer(dt);
      else if (this.target) this.faceTarget(dt);
      this.aim(dt);
    }
    this.animator?.update(dt);
    // Mechs wade; vehicles (the hovercraft, at least) ride on the water.
    const ground = terrain.heightAt(this.x, this.z);
    const y = this.kind === 'vehicle' ? Math.max(ground, 0) : ground;
    placement(this.frame, this.x, y, this.z, (this.rotation * Math.PI) / 180, this.scale);
    const nodes = this.animator?.matrices ?? this.rest;
    const out = this.instance.matrices;
    for (let k = 0; k < this.instance.model.nodeCount; k++) mulAffine(out, k * AFFINE_FLOATS, this.frame, 0, nodes, k * AFFINE_FLOATS);
    this.instance.center[0] = this.x;
    this.instance.center[1] = y + this.instance.model.radius * 0.5;
    this.instance.center[2] = this.z;
  }

  /** Standing, turn the hull toward the target when the torso (or turret) can't reach it. */
  private faceTarget(dt: number): void {
    const t = this.target!;
    const rel = wrapDegrees(bearing(this, t) - this.rotation);
    const slack = Math.max(this.twistLimit - 10, 5);
    if (Math.abs(rel) > slack) {
      this.rotation = (this.rotation + Math.sign(rel) * Math.min(Math.abs(rel), TURN_RATE * dt) + 360) % 360;
      this.play('walk');
      this.turning = true;
    } else if (this.turning) {
      this.turning = false;
      this.play('idle');
    }
  }

  /** Turn the torso (or turret) toward the target, within its limits; with none, back to the front. */
  private aim(dt: number): void {
    const limit = this.twistLimit;
    const want = this.target ? Math.min(Math.max(wrapDegrees(bearing(this, this.target) - this.rotation), -limit), limit) : 0;
    const diff = wrapDegrees(want - this.twist);
    this.twist = wrapDegrees(this.twist + Math.sign(diff) * Math.min(Math.abs(diff), this.twistRate * dt));
    if (this.torsoNode >= 0) this.animator?.setTwist(this.torsoNode, (this.twist * Math.PI) / 180);
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
    this.turning = false;
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
  /** The fighting: targets, fire, damage and wrecks. */
  battle!: Battle;
  private rings: ModelInstance[] = [];
  private ringModel: GpuModel | null = null;
  private inspectRing: ModelInstance | null = null;
  private readonly glbs = new Map<string, Promise<ModelData>>();
  private readonly wrecks = new Map<string, Promise<GpuModel>>();
  private readonly ringFrame = new Float32Array(AFFINE_FLOATS);

  private constructor(
    private readonly sea: SeaRenderer,
    readonly terrain: Terrain,
    private readonly info: MapInfo,
    private readonly unitsFile: UnitsFile,
    private readonly combatFile: CombatFile,
    grid: MoveGrid | null,
  ) {
    this.grid = grid;
  }

  private get scale(): number {
    return 1 / this.info.worldUnitsPerMeter;
  }

  static async load(sea: SeaRenderer, terrain: Terrain, info: MapInfo, mapDir: string, progress: (text: string) => void): Promise<World> {
    const [objects, unitsFile, combatFile, cells] = await Promise.all([
      loadJson<ObjectsFile>(mapDir + 'objects.json'),
      loadJson<UnitsFile>(mapDir + 'units.json'),
      loadJson<CombatFile>(mapDir + 'combat.json'),
      info.move ? loadBinary(mapDir + info.move.file) : Promise.resolve(null),
    ]);
    // The movement map covers the same square as the terrain: side * 128 MC2 units.
    const extent = (info.side * info.worldUnitsPerVertex) / info.worldUnitsPerMeter;
    const grid =
      cells && info.move ? new MoveGrid(new Uint32Array(cells), info.move.width, info.move.height, extent / info.move.width, [-extent / 2, -extent / 2]) : null;
    const world = new World(sea, terrain, info, unitsFile, combatFile, grid);
    world.battle = new Battle(world, sea.fx);
    progress('Loading buildings and trees…');
    await world.placeProps(objects);
    progress('Loading units…');
    await Promise.all(
      unitsFile.units.map(async (u) => {
        const paint = u.player ? PLAYER_PAINT : paintFromMission(u.colors);
        // The stats file's name (Werewolf, Bushwacker) reads better than the object file's (werewolf, BushWacker).
        const unit = await world.spawn(u.model, u.kind, u.csv || u.name, u.team, u.x * world.scale, -u.y * world.scale, u.rotation, paint, {
          stats: u.stats,
          gunnery: u.gunnery,
        });
        world.units.push(unit);
      }),
    );
    // The showcase mechs (Atlas, Madcat) join the player's lance beside its first mech.
    const lead = world.units.find((u) => u.commandable);
    for (const [i, key] of unitsFile.showcase.entries()) {
      const [x, z] = world.openNear((lead?.x ?? 0) + (i ? 1 : -1) * 2.2 * FORMATION_SPACING, (lead?.z ?? 0) + FORMATION_SPACING);
      const paint = i % 2 ? PLAYER_PAINT : paintFromMission(['#3a5f8f', '#c8c8c8', '#202830']);
      const name = key.charAt(0).toUpperCase() + key.slice(1);
      // Their pilots are regulars (the mission gives them none).
      world.units.push(await world.spawn(key, 'mech', name, PLAYER_TEAM, x, z, lead?.rotation ?? 0, paint, { stats: key, gunnery: 40 }));
    }
    world.ringModel = await world.sea.models.addModel(selectionRing('selection-ring', [0.35, 1, 0.3, 1]), { scale: 1, unlit: true, gain: 1.4 });
    world.inspectRing = world.sea.models.addInstance(
      await world.sea.models.addModel(selectionRing('inspect-ring', [1, 0.3, 0.2, 1]), { scale: 1, unlit: true, gain: 1.4 }),
    );
    const first = world.units.find((u) => u.commandable);
    if (first) world.selected.add(first);
    return world;
  }

  /** Put a mech or vehicle on the map (world metres), with its stats from combat.json (`fight.stats` is their key). */
  async spawn(
    key: string,
    kind: 'mech' | 'vehicle',
    name: string,
    team: number,
    x: number,
    z: number,
    rotation: number,
    paint: PaintScheme,
    fight: { stats: string | null; gunnery: number },
  ): Promise<SeaUnit> {
    const info = kind === 'mech' ? (this.unitsFile.mechs[key] ?? null) : null;
    const modelPath = info ? info.model : `models/props/${key}.glb`;
    const data = await this.glb(modelPath);
    const model = await this.sea.models.addModel(data, { scale: this.scale, paint, gain: GAIN });
    const animator = data.clips.size ? new Animator(data) : null;
    const body: UnitBody = {
      instance: this.sea.models.addInstance(model),
      animator,
      rest: restPose(data),
      info,
      scale: this.scale,
      nodes: new Map(data.nodes.map((n, i) => [n.name, i])),
      modelPath,
    };
    const unit = new SeaUnit(name, kind, team, body, this.combatant(kind, fight.stats, fight.gunnery), x, z, rotation);
    if (animator) {
      animator.play('idle', 0, Math.random() * 3); // out of step, so a lance does not breathe in unison
    }
    unit.update(0, this.terrain);
    return unit;
  }

  private combatant(kind: 'mech' | 'vehicle', stats: string | null, gunnery: number): MechCombat | VehicleCombat | null {
    const c = this.combatFile;
    if (kind === 'mech') {
      const s = stats ? c.mechs[stats] : undefined;
      if (!s) return null;
      return new MechCombat(s, c.weapons, (id) => ({ perRound: c.ammo[id]?.explosive ?? 0, perPack: c.ammo[id]?.shotsPerPack ?? 0 }), gunnery);
    }
    const s = stats ? c.vehicles[stats] : undefined;
    return s ? new VehicleCombat(s, c.weapons, gunnery) : null;
  }

  /** Ammunition's short name: AC10, LRM5, Streak SRM2. */
  ammoName(id: number): string {
    const name = this.combatFile.ammo[id]?.name ?? String(id);
    return name.match(/\(([^)]+)\)/)?.[1] ?? name.replace(/( Rack| Pack)? Ammo$/, '');
  }

  /** A unit was destroyed: it can no longer be selected, and the battle log has said so. */
  unitDied(unit: SeaUnit): void {
    this.selected.delete(unit);
    if (this.inspected === unit) this.inspected = null;
  }

  /** Draw a destroyed unit as a burnt-out wreck, keeping its pose. */
  async makeWreck(unit: SeaUnit): Promise<void> {
    let model = this.wrecks.get(unit.modelPath);
    if (!model) {
      model = this.glb(unit.modelPath).then((data) => this.sea.models.addModel(data, { scale: this.scale, paint: WRECK_PAINT, gain: WRECK_GAIN }));
      this.wrecks.set(unit.modelPath, model);
    }
    const wreck = this.sea.models.addInstance(await model);
    wreck.matrices.set(unit.instance.matrices);
    wreck.center.splice(0, 3, ...unit.instance.center);
    this.sea.models.removeInstance(unit.instance);
    unit.instance = wreck;
  }

  remove(unit: SeaUnit): void {
    this.units.splice(this.units.indexOf(unit), 1);
    this.sea.models.removeInstance(unit.instance);
    this.selected.delete(unit);
    if (this.inspected === unit) this.inspected = null;
  }

  /**
   * Tap on a unit: the player's own replace the selection (or toggle in it when `add`). An enemy is attacked by the
   * selection, if there is one, and shown in the HUD.
   */
  tapUnit(unit: SeaUnit, add: boolean): void {
    if (!unit.commandable) {
      this.inspected = unit;
      if (unit.team !== PLAYER_TEAM && unit.alive && this.selected.size) this.orderAttack(unit);
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

  /** Stop walking and drop any attack order (the mechs still fire at what comes into range). */
  stopSelected(): void {
    for (const u of this.selected) {
      u.attackOrder = null;
      u.stop();
    }
  }

  setRunning(running: boolean): void {
    for (const u of this.selected) u.running = running;
  }

  /** Send the selection after an enemy: each closes to its best range and fires until one of them is destroyed. */
  orderAttack(target: SeaUnit): number {
    let ordered = 0;
    for (const u of this.selected) {
      if (!u.combat) continue;
      u.attackOrder = target;
      u.target = target;
      // It replaces any move order; the battle routes it toward the target on its next tick.
      if (u.route.length) u.stop();
      ordered++;
    }
    return ordered;
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
        // A move order ends an attack order; the mech still fires at what it passes.
        u.attackOrder = null;
        u.engaging = false;
        u.walkTo(route);
        routed++;
      }
    });
    return routed;
  }

  update(dt: number, move = true): void {
    if (move) this.battle.update(dt);
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
      if (!u.alive) continue; // a tap on a wreck is a tap on the ground
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
  openNear(x: number, z: number): [number, number] {
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

/** Degrees wrapped to -180..180. */
export function wrapDegrees(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** MC2 heading from one unit to another, degrees. */
export function bearing(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
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
