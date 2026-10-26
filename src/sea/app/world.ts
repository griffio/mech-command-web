// MC2's buildings, trees and units on the WebGPU page, in metres (MC2 units / 5.01) and the dreadnought game's axes
// (x east, y up, z south): placement, the two sides, selection, move orders routed over MC2's movement map, and attack
// orders (the fighting itself is Battle's). With a scenario the units come in squads and play a match (match.ts);
// without one they are the mission's own.
import {
  ASSET_ROOT,
  loadBinary,
  loadJson,
  type CombatFile,
  type MapInfo,
  type MechInfo,
  type ObjectsFile,
  type Scenario,
  type UnitsFile,
} from '../../assets.ts';
import { PLAYER_PAINT, paintFromMission, paintKey, type PaintScheme } from '../../paint.ts';
import type { Camera } from '../render/camera';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { SeaRenderer } from '../render/sea-renderer';
import { parseGlb, type ModelData } from '../models/glb';
import { AFFINE_FLOATS, Animator, mulAffine, placement, restPose } from '../models/pose';
import type { StrikeStats, VehicleStats } from '../../assets.ts';
import { FIRE_ARC, MechCombat, SIGHT_RANGE, VehicleCombat } from '../sim/combat';
import { MoveGrid, type MoveClass } from '../sim/move-grid';
import type { Terrain } from '../sim/terrain/terrain';
import { Battle } from './battle';
import type { BuildKind } from './logistics';
import { Match } from './match';
import { formationSlots, type Squad } from './squads';

const TURN_RATE = 120; // degrees per second
/** Every ground vehicle walks at this, metres a second (gamesys.fit WalkSpeed); running, at its MaxVelocity (code/gvehicl.cpp). */
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
/** Infantry are drawn this much larger than life, so a commander can find them among mechs eight times their height. */
const INFANTRY_SCALE = 1.8;
/** Metres between squads side by side when several are sent to one place. */
const SQUAD_SPACING = 40;
/** Names for unit types whose object files name them poorly. */
const TYPE_NAMES: Record<string, string> = {
  infantry: 'Trooper',
  poweredarmor: 'Elemental',
  lrmcarrier: 'LRM Carrier',
  harasser: 'Harasser',
  repairtruck: 'Supply truck',
  apc1: 'APC',
  heavyapc: 'Troop transport',
  mediumautocannonturret: 'Autocannon turret',
  guardtower: 'Artillery piece',
  minelayer: 'Minelayer',
  scoutcopter: 'Scout copter',
};

/** A structure (a turret, a forward base's tent) stays where it's put. */
export type UnitKind = 'mech' | 'vehicle' | 'infantry' | 'structure';

/**
 * Units keep this far from the next one's own, metres: in MC2 each mover takes a cell of the movement map (8.5 m), so
 * none stands inside another. Soldiers, in squads of up to six, keep closer; a structure keeps its footprint.
 */
const PERSONAL_M: Record<Exclude<UnitKind, 'structure'>, number> = { mech: 4.3, vehicle: 4.3, infantry: 1.5 };
/** How fast units crowding one another shuffle apart, metres a second; one on the move gives way three times as much. */
const SPACE_OUT_MS = 6;
const MOVING_GIVES = 3;
/**
 * A unit standing with a target turns its whole body to it once it's further off its front than this, degrees (MC2's
 * pivot to target, BattleMech::pivotTo and GroundVehicle's; gamesys FireArc), so it meets its target with its front.
 */
const PIVOT_ARC: Record<Exclude<UnitKind, 'structure'>, number> = { mech: 25, vehicle: 25, infantry: 45 };
/**
 * One with no torso or turret to turn (the Centipede, Elementals) fires only within FIRE_ARC of its front, so turns
 * sooner than that: within the fire arc, less this margin, degrees.
 */
const PIVOT_MARGIN = 2.5;

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
  /** Node index by name, lower case (the models differ: joint_root, Joint_root): weapon mounts, the cockpit, the torso. */
  nodes: Map<string, number>;
  /** The GLB it was made from (its wreck is drawn from it too). */
  modelPath: string;
  /** Its bounding radius, metres: the model's, or a helicopter's body's (see bodyRadius). */
  size: number;
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
  /** Its squad, when it plays in a scenario. */
  squad: Squad | null = null;
  /** Its scenario unit type ("atlas", "infantry"), which its replacement takes. */
  typeKey: string | null = null;
  /** Out of the player's side's sight (fog of war): not drawn, not picked. */
  hidden = false;
  /** Where its squad was sent: an AI unit chases only targets near it. */
  leash: { x: number; z: number } | null = null;
  /** Height above the ground (or the sea) it flies at, metres: the Karnov's. */
  altitude = 0;
  /** Aboard a transport: out of the fight, not drawn; it rides at the transport's position. */
  embarked = false;
  /** A supply truck's load, and how much it holds (null for anything else). */
  supply: number | null = null;
  supplyCapacity: number | null = null;
  /** A minelayer's mines, and how many it holds (null for anything else); laying them as it goes (mines.ts). */
  mines: number | null = null;
  minesCapacity: number | null = null;
  laying = false;
  /** How suppressed it is by fire landing about it, 0..1 (suppression.ts), and when it last was (game time). */
  suppression = 0;
  suppressedAt = -Infinity;
  /** A soldier pinned down by fire: on the ground, not moving until it slackens. */
  pinned = false;
  /** A piece of wall (logistics.ts): it closes the ground it stands on, and is shot at only when ordered. */
  wall = false;
  /** A job it's part-way through (a truck building a forward base), shown over it: the share done, and what it is. */
  job: { share: number; label: string } | null = null;
  /**
   * A helicopter's flight: on the ground (MC2 starts them landed), lifting off, in the air, or setting down (MC2's park
   * gestures). It moves and fires only in the air; on the ground it takes off when it has somewhere to go or something
   * to fight.
   */
  flight: 'parked' | 'takingOff' | 'flying' | 'landing' = 'flying';
  /** Its bounding radius, metres (see UnitBody). */
  readonly size: number;
  /** A soldier's body is gone when he dies (there's no wreck to leave). */
  private gone = false;
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
  private readonly rootNode: number;

  constructor(
    readonly name: string,
    readonly kind: UnitKind,
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
    this.size = body.size;
    this.torsoNode = body.nodes.get('joint_torso') ?? -1;
    this.rootNode = body.nodes.get('joint_root') ?? -1;
  }

  get alive(): boolean {
    return this.combat?.alive ?? true;
  }

  /** A unit the player can give orders to. */
  get commandable(): boolean {
    return this.team === PLAYER_TEAM && this.combat !== null && this.alive && this.kind !== 'structure';
  }

  /**
   * How it gets about: a mech wades the shallows, a helicopter (a mech that flies) goes anywhere, a hovercraft crosses
   * water, the rest keep to land and fords.
   */
  get moveClass(): MoveClass {
    const stats = this.combat?.stats;
    if (this.kind === 'mech') return stats && 'air' in stats && stats.air ? 'air' : 'mech';
    return stats && 'hover' in stats && stats.hover ? 'hover' : 'ground';
  }

  /** Its squad's APC (see carriers.ts). */
  get carrier(): boolean {
    return this.typeKey !== null && this.squad?.spec.carrier === this.typeKey;
  }

  /** A helicopter. */
  get flies(): boolean {
    return this.moveClass === 'air';
  }

  /** It never moves: a structure, or a vehicle with no speed (MC2's artillery piece, an emplacement). */
  get immobile(): boolean {
    const stats = this.combat?.stats;
    return this.kind === 'structure' || (this.kind === 'vehicle' && !!stats && 'speed' in stats && stats.speed <= 0);
  }

  /** How far it sees, metres: the usual (gamesys MaxVisualRange) times its LOSFactor (code/team.cpp). */
  get sightRange(): number {
    return SIGHT_RANGE * (this.combat?.stats.losFactor ?? 1);
  }

  /** A helicopter on the ground, or on its way up or down: it neither moves nor fires. */
  get grounded(): boolean {
    return this.flight !== 'flying' && this.flies;
  }

  /** Where its weapons point: the torso's facing on a mech, the turret's on a vehicle (MC2 degrees). */
  get aimYaw(): number {
    return this.rotation + this.twist;
  }

  /** How far the torso or turret turns either way, degrees (0: the hull must face the target). */
  get twistLimit(): number {
    const stats = this.combat?.stats;
    if (!stats) return 0;
    // A helicopter's torso may turn 120 degrees (MaxTorsoYaw), at 0 degrees a second (TorsoYawRate): it never does.
    if ('torsoYaw' in stats) return stats.torsoYawRate > 0 ? stats.torsoYaw : 0;
    return stats.turretYaw;
  }

  private get twistRate(): number {
    const stats = this.combat?.stats;
    return stats && 'torsoYawRate' in stats ? stats.torsoYawRate : TURRET_RATE;
  }

  /** A node's position in the world, metres (null if the model has no such node). */
  nodePosition(name: string): V3 | null {
    const k = this.nodes.get(name.toLowerCase());
    if (k === undefined) return null;
    const m = this.instance.matrices;
    const o = k * AFFINE_FLOATS;
    return [m[o + 3]!, m[o + 7]!, m[o + 11]!];
  }

  /** Height its pilot sees from, metres above the sea. */
  get eyeY(): number {
    return this.instance.center[1] + this.size * 0.25;
  }

  get clipName(): string {
    return this.animator?.clipName ?? '';
  }

  get clips(): string[] {
    return this.animator?.clips ?? [];
  }

  /** Footprint radius, metres (for the selection ring and picking). */
  get radius(): number {
    return this.size * 0.55;
  }

  /** Play a clip, looping unless `once` (then it holds its last frame: see clipDone). */
  play(name: string, fade = 0.2, once = false): void {
    // A helicopter on the ground, or on its way up or down, plays that.
    if (this.grounded) return;
    this.animator?.play(name, fade, 0, !once);
  }

  /** Set a helicopter down where it is, unless it's going somewhere (it takes off again when it is). */
  land(): void {
    if (this.flight !== 'flying' || !this.flies || this.route.length) return;
    this.flight = 'landing';
    this.animator?.play('standToPark', 0.3, 0, false);
  }

  /** Put a helicopter on the ground, as MC2 starts them. */
  park(): void {
    this.flight = 'parked';
    this.animator?.play('standToPark', 0, Infinity, false);
  }

  /** A clip played once has reached its end. */
  get clipDone(): boolean {
    return this.animator?.finished ?? true;
  }

  /** The waypoints it has still to reach. */
  get ahead(): [number, number][] {
    return this.route.slice(this.routeIndex);
  }

  walkTo(points: [number, number][]): void {
    this.route = points;
    this.routeIndex = 0;
  }

  stop(): void {
    this.route = [];
    this.engaging = false;
    this.laying = false;
    this.play('idle');
  }

  /** Fall (backward when the killing shot came from the front) and stop fighting. */
  die(fromFront: boolean): void {
    this.route = [];
    this.target = null;
    this.attackOrder = null;
    this.engaging = false;
    if (this.kind === 'infantry') this.gone = true;
    // A helicopter on the ground (or on its way up or down) is wrecked where it stands; one in the air falls out of it.
    else if (this.grounded) this.animator?.play('standToPark', 0.3, Infinity, false);
    // The models' destroyed gestures carry no keys; the falls they match frame for frame do.
    else this.animator?.play(fromFront ? 'fallBackward' : 'fallForward', 0.15, 0, false);
  }

  /** A dead mech has finished falling (a vehicle has nothing to play). */
  get fallen(): boolean {
    return !this.animator || this.animator.finished;
  }

  /**
   * Speed from the gesture data (MC2 gives it in metres a second already); vehicles all move alike (MC2's walk), but an
   * APC, with no guns to bring to bear, at its top speed (MC2's run); infantry at theirs.
   */
  get speed(): number {
    const stats = this.combat?.stats;
    if (this.immobile) return 0;
    if (this.kind === 'infantry') return stats && 'speed' in stats ? stats.speed : 5;
    if (this.kind === 'vehicle') return this.carrier && stats && 'speed' in stats ? stats.speed : VEHICLE_SPEED;
    return this.info?.clips[this.running ? 'run' : 'walk']?.startVelocity ?? 10;
  }

  /** `move` false keeps the unit where it is (still animating): the perf survey wants the same picture throughout. */
  update(dt: number, terrain: Terrain, move = true): void {
    if (move && this.alive && !this.embarked) {
      if (this.flies) this.lift();
      // Pinned soldiers stay down, and go on where they were going once the fire slackens. A helicopter on the ground
      // (or on its way up or down) waits.
      if (!this.grounded) {
        if (this.route.length && !this.pinned) this.steer(dt);
        else if (this.target) this.faceTarget(dt);
      }
      if (this.pinned) this.play('idle');
      this.aim(dt);
    }
    this.animator?.update(dt);
    this.instance.visible = !this.hidden && !this.gone && !this.embarked;
    // Mechs, infantry and tracks wade; hovercraft and anything flying go over the water.
    const ground = terrain.heightAt(this.x, this.z);
    const y = (this.moveClass === 'hover' || this.flies || this.altitude > 0 ? Math.max(ground, 0) : ground) + this.altitude;
    placement(this.frame, this.x, y, this.z, (this.rotation * Math.PI) / 180, this.scale);
    const nodes = this.animator?.matrices ?? this.rest;
    const out = this.instance.matrices;
    for (let k = 0; k < this.instance.model.nodeCount; k++) mulAffine(out, k * AFFINE_FLOATS, this.frame, 0, nodes, k * AFFINE_FLOATS);
    this.instance.center[0] = this.x;
    // A helicopter's body is wherever its gestures have lifted its root to.
    this.instance.center[1] = this.flies && this.rootNode >= 0 ? out[this.rootNode * AFFINE_FLOATS + 7]! : y + this.size * 0.5;
    this.instance.center[2] = this.z;
  }

  /**
   * A helicopter on the ground takes off when it has somewhere to go or something to fight; taking off and landing end
   * with their gestures.
   */
  private lift(): void {
    if (this.flight === 'parked' && (this.route.length || this.target?.alive)) {
      this.flight = 'takingOff';
      this.animator?.play('parkToStand', 0.2, 0, false);
    } else if ((this.flight === 'takingOff' || this.flight === 'landing') && this.clipDone) {
      this.flight = this.flight === 'takingOff' ? 'flying' : 'parked';
      if (this.flight === 'flying') this.animator?.play('idle', 0.2);
    }
  }

  /** Standing, turn the hull toward the target (see PIVOT_ARC); a turret keeps its footing and turns its gun. */
  private faceTarget(dt: number): void {
    const t = this.target!;
    const rel = wrapDegrees(bearing(this, t) - this.rotation);
    const slack = this.kind === 'structure' ? Math.max(this.twistLimit - 10, 5) : Math.min(PIVOT_ARC[this.kind], this.twistLimit + FIRE_ARC - PIVOT_MARGIN);
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
    // Infantry move at a run (their top speed is a running pace); vehicles' clips aren't for driving.
    if (this.kind === 'mech' || this.kind === 'infantry') this.play(this.running || this.kind === 'infantry' ? 'run' : 'walk');
    // Turn in place first when the next waypoint is well off to the side.
    if (Math.abs(diff) < 30) {
      const step = Math.min(distance, this.speed * dt);
      const r = (this.rotation * Math.PI) / 180;
      this.x += Math.sin(r) * step;
      this.z += Math.cos(r) * step;
    }
  }
}

/** An order the player gave one of their squads, and whether it was carried out (if not, why not). */
export interface OrderReport {
  squad: Squad;
  order: 'move' | 'airlift' | 'attack' | 'stop' | 'build' | 'mines';
  refused: string | null;
}

export class World {
  readonly units: SeaUnit[] = [];
  /** The player's units chosen to receive orders. */
  readonly selected = new Set<SeaUnit>();
  /** A unit tapped to look at that isn't the player's (shown in the HUD, not ordered). */
  inspected: SeaUnit | null = null;
  /** With a scenario, the squads the player has selected (the selection is their living members). */
  readonly selectedSquads = new Set<Squad>();
  propCount = 0;
  /** The movement map for mechs (and for anything that just needs a place to stand). */
  readonly grid: MoveGrid | null;
  /** The movement map for each way of moving. */
  readonly grids: Record<MoveClass, MoveGrid> | null;
  /** The fighting: targets, fire, damage and wrecks. */
  battle!: Battle;
  /** The scenario's match, if one is being played. */
  match: Match | null = null;
  /** Gunnery added to a side's pilots as they're spawned, by team (the difficulty, Match.setDifficulty). */
  readonly gunneryBonus = new Map<number, number>();
  /** The player's orders to their squads, as they're given (the radio answers them). */
  onOrders: (reports: OrderReport[]) => void = () => {};
  /** An order that went to no squad, and why (nothing able to carry it out was selected). */
  onRefused: (why: string) => void = () => {};
  /** The player picked squads. */
  onSelect: () => void = () => {};
  /** Draw the rings under the selection and the unit looked at (the Capture button leaves them out of its picture). */
  showRings = true;
  private rings: ModelInstance[] = [];
  private ringModel: GpuModel | null = null;
  private inspectRing: ModelInstance | null = null;
  private readonly glbs = new Map<string, Promise<ModelData>>();
  private readonly wrecks = new Map<string, Promise<GpuModel>>();
  /** Units' models by GLB, paint and scale: every unit of a type and side shares one (and its textures). */
  private readonly unitModels = new Map<string, Promise<GpuModel>>();
  /** Rest poses of marker props (flags), by model. */
  private readonly markerRest = new Map<GpuModel, Float32Array>();
  private readonly ringFrame = new Float32Array(AFFINE_FLOATS);
  private readonly markerFrame = new Float32Array(AFFINE_FLOATS);

  private constructor(
    private readonly sea: SeaRenderer,
    readonly terrain: Terrain,
    private readonly info: MapInfo,
    private readonly unitsFile: UnitsFile,
    private readonly combatFile: CombatFile,
    grids: Record<MoveClass, MoveGrid> | null,
  ) {
    this.grids = grids;
    this.grid = grids?.mech ?? null;
  }

  private get scale(): number {
    return 1 / this.info.worldUnitsPerMeter;
  }

  static async load(
    sea: SeaRenderer,
    terrain: Terrain,
    info: MapInfo,
    mapDir: string,
    progress: (text: string) => void,
    scenario: Scenario | null = null,
  ): Promise<World> {
    const [objects, unitsFile, combatFile, cells] = await Promise.all([
      loadJson<ObjectsFile>(mapDir + 'objects.json'),
      loadJson<UnitsFile>(mapDir + 'units.json'),
      loadJson<CombatFile>(mapDir + 'combat.json'),
      info.move ? loadBinary(mapDir + info.move.file) : Promise.resolve(null),
    ]);
    // The movement map covers the same square as the terrain: side * 128 MC2 units.
    const extent = (info.side * info.worldUnitsPerVertex) / info.worldUnitsPerMeter;
    const move = info.move;
    const grid = (moveClass: MoveClass) =>
      new MoveGrid(new Uint32Array(cells!), move!.width, move!.height, extent / move!.width, [-extent / 2, -extent / 2], moveClass, (x, z) =>
        terrain.depthAt(x, z),
      );
    const grids = cells && move ? { mech: grid('mech'), hover: grid('hover'), ground: grid('ground'), air: grid('air') } : null;
    const world = new World(sea, terrain, info, unitsFile, combatFile, grids);
    world.battle = new Battle(world, sea.fx);
    progress('Loading buildings and trees…');
    await world.placeProps(objects);
    progress('Loading units…');
    if (scenario && unitsFile.types) {
      world.match = await Match.start(world, scenario);
    } else {
      await world.placeMissionUnits();
    }
    // Each type's wreck now, while loading: built at a unit's death, its texture upload stalls the frame.
    const wrecked = Object.values(unitsFile.types ?? {}).filter((t) => t.kind !== 'infantry').map((t) => t.model);
    await Promise.all([...new Set([...wrecked, ...world.units.filter((u) => u.combat && u.kind !== 'infantry').map((u) => u.modelPath)])].map((path) => world.wreckModel(path)));
    world.ringModel = await world.sea.models.addModel(selectionRing('selection-ring', [0.35, 1, 0.3, 1]), { scale: 1, unlit: true, gain: 1.4, castsShadow: false });
    world.inspectRing = world.sea.models.addInstance(
      await world.sea.models.addModel(selectionRing('inspect-ring', [1, 0.3, 0.2, 1]), { scale: 1, unlit: true, gain: 1.4, castsShadow: false }),
    );
    if (world.match) {
      const first = world.match.side(PLAYER_TEAM).squads[0];
      if (first) world.selectSquad(first, false);
    } else {
      const first = world.units.find((u) => u.commandable);
      if (first) world.selected.add(first);
    }
    return world;
  }

  /** The mission's own units, plus the showcase mechs (Atlas, Madcat) beside the player's lance. */
  private async placeMissionUnits(): Promise<void> {
    const { unitsFile } = this;
    await Promise.all(
      unitsFile.units.map(async (u) => {
        const paint = u.player ? PLAYER_PAINT : paintFromMission(u.colors);
        const info = u.kind === 'mech' ? (unitsFile.mechs[u.model] ?? null) : null;
        // The stats file's name (Werewolf, Bushwacker) reads better than the object file's (werewolf, BushWacker).
        const unit = await this.spawn({
          model: info ? info.model : `models/props/${u.model}.glb`,
          info,
          kind: u.kind,
          name: u.csv || u.name,
          team: u.team,
          x: u.x * this.scale,
          z: -u.y * this.scale,
          rotation: u.rotation,
          paint,
          stats: u.stats,
          gunnery: u.gunnery,
        });
        this.units.push(unit);
      }),
    );
    const lead = this.units.find((u) => u.commandable);
    for (const [i, key] of unitsFile.showcase.entries()) {
      const [x, z] = this.openNear((lead?.x ?? 0) + (i ? 1 : -1) * 2.2 * FORMATION_SPACING, (lead?.z ?? 0) + FORMATION_SPACING);
      const info = unitsFile.mechs[key] ?? null;
      if (!info) continue;
      // Their pilots are regulars (the mission gives them none).
      const unit = await this.spawn({
        model: info.model,
        info,
        kind: 'mech',
        name: key.charAt(0).toUpperCase() + key.slice(1),
        team: PLAYER_TEAM,
        x,
        z,
        rotation: lead?.rotation ?? 0,
        paint: i % 2 ? PLAYER_PAINT : paintFromMission(['#3a5f8f', '#c8c8c8', '#202830']),
        stats: key,
        gunnery: 40,
      });
      this.units.push(unit);
    }
  }

  /**
   * Make a unit at a point (world metres), with its stats from combat.json (`stats` is their key). Units of one model,
   * paint and size share their GPU model. The caller adds it to `units`.
   */
  async spawn(o: {
    model: string;
    info: MechInfo | null;
    kind: UnitKind;
    name: string;
    team: number;
    x: number;
    z: number;
    rotation: number;
    paint: PaintScheme;
    stats: string | null;
    gunnery: number;
    /** Stats of its own, for something no object file describes (a forward base's tent). */
    custom?: VehicleStats;
  }): Promise<SeaUnit> {
    const data = await this.glb(o.model);
    const scale = this.scale * (o.kind === 'infantry' ? INFANTRY_SCALE : 1);
    const cacheKey = `${o.model}|${paintKey(o.paint)}|${scale}`;
    let model = this.unitModels.get(cacheKey);
    if (!model) {
      model = this.sea.models.addModel(data, { scale, paint: o.paint, gain: GAIN });
      this.unitModels.set(cacheKey, model);
    }
    const animator = data.clips.size ? new Animator(data) : null;
    const rest = restPose(data);
    const gpuModel = await model;
    const flies = o.kind === 'mech' && !!(o.stats && this.combatFile.mechs[o.stats]?.air);
    const body: UnitBody = {
      instance: this.sea.models.addInstance(gpuModel),
      animator,
      rest,
      info: o.info,
      scale,
      nodes: new Map(data.nodes.map((n, i) => [n.name.toLowerCase(), i])),
      modelPath: o.model,
      size: flies ? bodyRadius(data, rest) * scale : gpuModel.radius,
    };
    const gunnery = o.gunnery + (this.gunneryBonus.get(o.team) ?? 0);
    const combat = o.custom ? new VehicleCombat(o.custom, this.combatFile.weapons, gunnery) : this.combatant(o.kind, o.stats, gunnery);
    const unit = new SeaUnit(o.name, o.kind, o.team, body, combat, o.x, o.z, o.rotation);
    if (flies) unit.park();
    else if (animator) {
      animator.play('idle', 0, Math.random() * 3); // out of step, so a lance does not breathe in unison
    }
    unit.update(0, this.terrain);
    return unit;
  }

  /** A scenario unit type at a point (the caller adds it to `units`), or null if the converter didn't export it. */
  async spawnType(type: string, team: number, x: number, z: number, rotation: number, gunnery: number, paint: PaintScheme): Promise<SeaUnit | null> {
    const t = this.unitsFile.types?.[type];
    if (!t) return null;
    const unit = await this.spawn({
      model: t.model,
      info: t.kind === 'mech' ? (this.unitsFile.mechs[type] ?? null) : null,
      kind: t.kind,
      name: TYPE_NAMES[type] ?? t.name.charAt(0).toUpperCase() + t.name.slice(1),
      team,
      x,
      z,
      rotation,
      paint,
      stats: t.stats,
      gunnery: t.gunnery ?? gunnery,
    });
    unit.typeKey = type;
    // A truck that carries refit points carries them as supply, full to begin with; a minelayer its mines.
    const vehicle = t.stats && t.kind === 'vehicle' ? this.combatFile.vehicles[t.stats] : undefined;
    if (vehicle && vehicle.refitPoints > 0) unit.supply = unit.supplyCapacity = vehicle.refitPoints;
    if (vehicle && vehicle.mines > 0) unit.mines = unit.minesCapacity = vehicle.mines;
    return unit;
  }

  /** A scenario type's weight, tons. */
  typeTonnage(type: string): number {
    const t = this.unitsFile.types?.[type];
    if (!t?.stats) return 0;
    return (t.kind === 'mech' ? this.combatFile.mechs[t.stats]?.tonnage : this.combatFile.vehicles[t.stats]?.tonnage) ?? 0;
  }

  /** The converter exported this scenario unit type. */
  hasType(type: string): boolean {
    return !!this.unitsFile.types?.[type];
  }

  typeKind(type: string): UnitKind {
    return this.unitsFile.types?.[type]?.kind ?? 'vehicle';
  }

  /**
   * A ring `radius` metres across marking the ground about a point (a capture point, a base), lying on the terrain
   * however it slopes. Stand it with addMarker(model, x, z, 1).
   */
  markerRing(color: [number, number, number, number], x: number, z: number, radius: number, width = 3): Promise<GpuModel> {
    const base = Math.max(this.terrain.heightAt(x, z), 0);
    // A little above the ground, so the coarser meshes of distant land don't swallow it.
    const lift = (a: number, r: number) => Math.max(this.terrain.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r), 0) - base + 1.5;
    // Its own name: the renderer shares models by name, and every ring is shaped to its own ground.
    const name = `marker-ring ${x} ${z} ${radius} ${width} ${color.join(',')}`;
    return this.sea.models.addModel(selectionRing(name, color, 1 - width / radius, radius, lift), { scale: 1, unlit: true, gain: 1.4, castsShadow: false });
  }

  /**
   * A small flat ring `radius` metres across (a mine), one model however many stand on the ground; stand it with
   * addMarker(model, x, z, 1).
   */
  smallMarker(name: string, color: [number, number, number, number], radius: number, inner = 0.4): Promise<GpuModel> {
    return this.sea.models.addModel(selectionRing(name, color, inner, radius, () => 0.4), { scale: 1, unlit: true, gain: 1.2, castsShadow: false });
  }

  /** A scenario prop's GLB, by object file name or appearance (flags, sandbags, the Karnov), or null. */
  propPath(key: string): string | null {
    return this.unitsFile.props?.[key.toLowerCase()] ?? null;
  }

  /** A scenario prop's reach along its own z axis, metres from its origin (a wall piece's two ends), or null. */
  async propLength(key: string): Promise<[number, number] | null> {
    const path = this.propPath(key);
    if (!path) return null;
    const data = await this.glb(path);
    let min = Infinity;
    let max = -Infinity;
    for (const p of data.primitives) {
      for (let i = 2; i < p.positions.length; i += 3) {
        min = Math.min(min, p.positions[i]!);
        max = Math.max(max, p.positions[i]!);
      }
    }
    return Number.isFinite(min) ? [min * this.scale, max * this.scale] : null;
  }

  /** Units whose way on goes through these cells (a wall just went up there) find another, or stop. */
  reroute(cells: ReadonlySet<number>): void {
    for (const u of this.units) {
      if (!u.alive || u.embarked || u.flies || !u.route.length) continue;
      const grid = this.gridFor(u);
      const ahead = u.ahead;
      if (!grid || !ahead.length) continue;
      let from: [number, number] = [u.x, u.z];
      const cut = ahead.some((p) => {
        const hit = grid.crosses(from[0], from[1], p[0], p[1], cells);
        from = p;
        return hit;
      });
      if (!cut) continue;
      const end = ahead[ahead.length - 1]!;
      const route = grid.findPath(u.x, u.z, end[0], end[1]);
      if (route) u.walkTo(route);
      else u.stop();
    }
  }

  /** A scenario prop's model (a flag), by object file name, or null if it wasn't exported. */
  async propModel(key: string): Promise<GpuModel | null> {
    const path = this.unitsFile.props?.[key.toLowerCase()];
    if (!path) return null;
    const data = await this.glb(path);
    const model = await this.sea.models.addModel(data, { scale: this.scale, gain: GAIN });
    this.markerRest.set(model, restPose(data));
    return model;
  }

  /**
   * Stand a marker on the ground: a ring `scale` metres in radius, or a prop at its own size (scale omitted), turned
   * `rotation` degrees.
   */
  addMarker(model: GpuModel, x: number, z: number, scale = this.scale, rotation = 0): ModelInstance {
    const inst = this.sea.models.addInstance(model);
    this.placeMarker(inst, x, z, rotation, scale);
    inst.radius = Math.max(inst.radius, scale === this.scale ? model.radius : scale);
    return inst;
  }

  /** Put a marker (addMarker) somewhere, turned `rotation` degrees: a strike's marker spins. */
  placeMarker(inst: ModelInstance, x: number, z: number, rotation: number, scale = this.scale): void {
    const model = inst.model;
    const y = this.terrain.heightAt(x, z);
    placement(this.markerFrame, x, Math.max(y, 0) + 0.3, z, (rotation * Math.PI) / 180, scale);
    const rest = this.markerRest.get(model);
    for (let k = 0; k < model.nodeCount; k++) {
      if (rest) mulAffine(inst.matrices, k * AFFINE_FLOATS, this.markerFrame, 0, rest, k * AFFINE_FLOATS);
      else inst.matrices.set(this.markerFrame, k * AFFINE_FLOATS);
    }
    inst.center[0] = x;
    inst.center[1] = y;
    inst.center[2] = z;
  }

  /** The scale MC2's models are drawn at (they're in its world units), times `times`. */
  modelScale(times = 1): number {
    return this.scale * times;
  }

  /** An MC2 strike's numbers (objects/<name>.fit), if the converter exported them. */
  strikeStats(name: string): StrikeStats | null {
    return this.combatFile.strikes?.[name.toLowerCase()] ?? null;
  }

  replaceMarker(old: ModelInstance, model: GpuModel, x: number, z: number, scale?: number): ModelInstance {
    this.removeMarker(old);
    return this.addMarker(model, x, z, scale);
  }

  removeMarker(inst: ModelInstance): void {
    this.sea.models.removeInstance(inst);
  }

  private combatant(kind: UnitKind, stats: string | null, gunnery: number): MechCombat | VehicleCombat | null {
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

  /** The player's squads, when playing a scenario. */
  get playerSquads(): Squad[] {
    return this.match?.side(PLAYER_TEAM).squads ?? [];
  }

  /** Select a squad (its living members, now and as they're replaced), or add it to the selection or take it out. */
  selectSquad(squad: Squad, add: boolean): void {
    this.inspected = null;
    if (!add) this.selectedSquads.clear();
    if (add && this.selectedSquads.has(squad)) this.selectedSquads.delete(squad);
    else this.selectedSquads.add(squad);
    this.syncSelection();
    this.onSelect();
  }

  /** With a scenario the selection is the selected squads' living members. */
  private syncSelection(): void {
    if (!this.match) return;
    this.selected.clear();
    for (const q of this.selectedSquads) for (const u of q.alive) this.selected.add(u);
  }

  /** A unit was destroyed: it can no longer be selected, and the battle log has said so. */
  unitDied(unit: SeaUnit): void {
    this.selected.delete(unit);
    if (this.inspected === unit) this.inspected = null;
  }

  /** Make a model's wreck ahead of time (built when a unit dies, its texture upload would stall the frame). */
  async prepareWreck(path: string): Promise<void> {
    await this.wreckModel(path);
  }

  /** The burnt-out look of a model, made once per model. */
  private wreckModel(path: string): Promise<GpuModel> {
    let model = this.wrecks.get(path);
    if (!model) {
      model = this.glb(path).then((data) => this.sea.models.addModel(data, { scale: this.scale, paint: WRECK_PAINT, gain: WRECK_GAIN }));
      this.wrecks.set(path, model);
    }
    return model;
  }

  /** Draw a destroyed unit as a burnt-out wreck, keeping its pose (and its matrix slots). */
  async makeWreck(unit: SeaUnit): Promise<void> {
    const model = await this.wreckModel(unit.modelPath);
    const pose = unit.instance.matrices.slice();
    const center = [...unit.instance.center];
    this.sea.models.removeInstance(unit.instance);
    const wreck = this.sea.models.addInstance(model);
    wreck.matrices.set(pose);
    wreck.center.splice(0, 3, ...center);
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
    if (unit.squad) return this.selectSquad(unit.squad, add);
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
    if (this.match) {
      for (const q of this.playerSquads) if (q.alive.length) this.selectedSquads.add(q);
      this.syncSelection();
      return this.onSelect();
    }
    for (const u of this.units) if (u.commandable) this.selected.add(u);
  }

  /** Stop walking and drop any attack order (the mechs still fire at what comes into range). */
  stopSelected(): void {
    if (this.match) {
      const squads = [...this.selectedSquads].filter((q) => q.alive.length);
      for (const q of squads) if (!q.airborne) q.hold();
      if (squads.length) this.onOrders(squads.map((q) => ({ squad: q, order: 'stop', refused: q.airborne ? `${q.name} is with the Karnov` : null })));
      return;
    }
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
    if (this.match) {
      const reports: OrderReport[] = [];
      for (const q of this.selectedSquads) {
        if (!q.alive.length) continue;
        const why = q.airborne ? `${q.name} is with the Karnov` : q.alive.some((u) => u.combat?.weapons.length) ? null : `${q.name} has no weapons`;
        if (!why) q.attack(target);
        reports.push({ squad: q, order: 'attack', refused: why });
      }
      if (reports.length) this.onOrders(reports);
      return reports.filter((r) => !r.refused).length;
    }
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
    if (this.match) return this.orderSquadsMove(x, z);
    const units = [...this.selected].filter((u) => u.kind === 'mech');
    if (!units.length) return 0;
    units.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const slots = formationSlots(units.length, FORMATION_SPACING);
    let routed = 0;
    units.forEach((u, i) => {
      const [sx, sz] = this.openNear(x + slots[i]![0], z + slots[i]![1], u.moveClass);
      const grid = this.gridFor(u);
      const route = grid ? grid.findPath(u.x, u.z, sx, sz) : [[sx, sz] as [number, number]];
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

  /** Send the selected logistics squads to build something (a forward base, a turret, a wall) at a point. */
  orderBuild(kind: BuildKind, x: number, z: number): void {
    const logistics = this.match?.logistics;
    if (!logistics) return this.onRefused('there are no supply trucks in this scenario');
    const squads = [...this.selectedSquads].filter((q) => q.isLogistics);
    if (!squads.length) return this.onRefused('select a supply truck first');
    this.onOrders(squads.map((q) => ({ squad: q, order: 'build', refused: logistics.orderBuild(q, kind, x, z) })));
  }

  /** Why none of the selected squads could build this just now, or null if one can. */
  whyNoBuild(kind: BuildKind): string | null {
    const logistics = this.match?.logistics;
    if (!logistics) return 'there are no supply trucks in this scenario';
    const squads = [...this.selectedSquads].filter((q) => q.isLogistics);
    if (!squads.length) return 'select a supply truck first';
    const why = squads.map((q) => logistics.whyNotNow(q, kind));
    return why.every((w) => w) ? why[0]! : null;
  }

  /** Airlift the selected infantry squads to a point (the rest of the selection goes there on its own feet). */
  orderAirlift(x: number, z: number): number {
    return this.orderSquadsMove(x, z, true);
  }

  /** Send the selected squads' minelayers to a point, laying mines on their way. */
  orderLayMines(x: number, z: number): void {
    const squads = [...this.selectedSquads].filter((q) => q.minelayer);
    if (!squads.length || !this.match) return this.onRefused('select a minelayer first');
    this.onOrders(
      squads.map((q) => {
        const why = q.airborne ? `${q.name} is with the Karnov` : (q.minelayer!.mines ?? 0) < 1 ? `${q.name} has no mines left: send it to base to load more` : null;
        return { squad: q, order: 'mines', refused: why ?? (this.match!.layMines(q, x, z) ? null : `${q.name} can't get there`) };
      }),
    );
  }

  /**
   * Send the selected squads to a point, side by side across their line of advance (the squad nearest the point in the
   * middle), each in its own formation. Infantry that can't get there on foot (or are told to fly) are airlifted; those
   * with an APC ride in it when that's quicker.
   */
  private orderSquadsMove(x: number, z: number, airlift = false): number {
    const selected = [...this.selectedSquads].filter((q) => q.alive.length);
    // An artillery piece stays where it's put: it says so only when nothing else was sent.
    const squads = selected.filter((q) => !q.immobile);
    if (!squads.length) {
      if (selected.length) this.onOrders(selected.map((q) => ({ squad: q, order: 'move', refused: `${q.name} is an emplacement: it can't move` })));
      return 0;
    }
    let cx = 0;
    let cz = 0;
    for (const q of squads) {
      const [qx, qz] = q.centroid()!;
      cx += qx / squads.length;
      cz += qz / squads.length;
    }
    const d = Math.hypot(x - cx, z - cz) || 1;
    const [px, pz] = [-(z - cz) / d, (x - cx) / d];
    squads.sort((a, b) => dist(a.centroid()!, x, z) - dist(b.centroid()!, x, z));
    const reports = squads.map((q, i): OrderReport => {
      // A squad waiting for its Karnov, or aboard it, goes where the Karnov takes it.
      if (q.airborne) return { squad: q, order: airlift ? 'airlift' : 'move', refused: `${q.name} is with the Karnov` };
      const o = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * SQUAD_SPACING;
      const [tx, tz] = [x + px * o, z + pz * o];
      const c = q.centroid()!;
      const walkable = this.grids?.ground.connected(c[0], c[1], tx, tz) ?? true;
      if (q.airliftable && (airlift || !walkable) && this.match?.airliftSquad(q, tx, tz)) return { squad: q, order: 'airlift', refused: null };
      return { squad: q, order: 'move', refused: this.match!.moveSquad(q, tx, tz) ? null : `${q.name} can't get there` };
    });
    this.onOrders(reports);
    return reports.filter((r) => !r.refused).length;
  }

  update(dt: number, move = true): void {
    if (move) {
      this.battle.update(dt);
      this.match?.update(dt);
    }
    for (const u of this.units) u.update(dt, this.terrain, move);
    if (move) this.spaceOut(dt);
    this.syncSelection();
    this.updateRings();
  }

  /**
   * Units standing inside one another's room (PERSONAL_M) shuffle apart, never onto ground they can't stand on; a
   * structure doesn't move. One walking to a spot another stands on stops beside it instead. Helicopters in the air keep
   * apart only from one another, a rotor's breadth (their size).
   */
  private spaceOut(dt: number): void {
    // A wall keeps its own footprint on the movement map.
    const units = this.units.filter((u) => u.alive && u.combat && !u.embarked && u.altitude === 0 && !u.wall);
    const room = (u: SeaUnit) => (u.kind === 'structure' ? u.radius : u.flies ? u.size * 0.5 : PERSONAL_M[u.kind]);
    const gives = (u: SeaUnit) => (u.kind === 'structure' || (u.flies && u.grounded) ? 0 : u.route.length && !u.pinned ? MOVING_GIVES : 1);
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        if (a.flies !== b.flies) continue;
        const need = room(a) + room(b);
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (Math.abs(dx) >= need || Math.abs(dz) >= need) continue;
        const d = Math.hypot(dx, dz);
        if (d >= need) continue;
        for (const [w, s] of [[a, b], [b, a]] as const) {
          const end = w.route[w.route.length - 1];
          if (end && !s.route.length && Math.hypot(end[0] - s.x, end[1] - s.z) < need && Math.hypot(end[0] - w.x, end[1] - w.z) < need + ARRIVE_M) w.stop();
        }
        const [ga, gb] = [gives(a), gives(b)];
        if (!ga && !gb) continue;
        const angle = d > 1e-3 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2;
        const push = Math.min(need - d, SPACE_OUT_MS * dt);
        this.nudge(a, -Math.cos(angle) * push * (ga / (ga + gb)), -Math.sin(angle) * push * (ga / (ga + gb)));
        this.nudge(b, Math.cos(angle) * push * (gb / (ga + gb)), Math.sin(angle) * push * (gb / (ga + gb)));
      }
    }
  }

  private nudge(u: SeaUnit, dx: number, dz: number): void {
    if (!dx && !dz) return;
    const grid = this.gridFor(u);
    if (grid && !grid.open(...grid.cellOf(u.x + dx, u.z + dz))) return;
    u.x += dx;
    u.z += dz;
  }

  /**
   * What a tap at normalised device coordinates hits: a unit, or the ground (world x, z), or nothing. A unit counts if
   * the tap is within its footprint or `slopPx` screen pixels of its middle (a soldier is a few pixels tall), given the
   * view's height in pixels.
   */
  pick(camera: Camera, ndcX: number, ndcY: number, viewHeightPx = 800, slopPx = 16): SeaUnit | [number, number] | null {
    const o = camera.position;
    const d = camera.rayThrough(ndcX, ndcY);
    const metresPerPixel = (2 * camera.tanHalfFovY) / viewHeightPx;
    let best: SeaUnit | null = null;
    let bestT = Infinity;
    for (const u of this.units) {
      // A tap on a wreck, a Karnov, or anything the player can't see, is a tap on the ground.
      if (!u.alive || u.hidden || u.embarked || !u.combat) continue;
      const c = u.instance.center;
      const t = (c[0] - o[0]) * d[0] + (c[1] - o[1]) * d[1] + (c[2] - o[2]) * d[2];
      if (t <= 0 || t >= bestT) continue;
      const miss = Math.hypot(o[0] + d[0] * t - c[0], o[1] + d[1] * t - c[1], o[2] + d[2] * t - c[2]);
      if (miss < Math.max(u.size * 0.6, t * metresPerPixel * slopPx)) {
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

  /** The movement map a unit routes over. */
  gridFor(u: SeaUnit): MoveGrid | null {
    return this.grids?.[u.moveClass] ?? null;
  }

  /** How units of a scenario type get about. */
  typeMoveClass(type: string): MoveClass {
    const t = this.unitsFile.types?.[type];
    if (!t) return 'mech';
    if (t.kind === 'mech') return t.stats && this.combatFile.mechs[t.stats]?.air ? 'air' : 'mech';
    return t.stats && this.combatFile.vehicles[t.stats]?.hover ? 'hover' : 'ground';
  }

  /**
   * The nearest point a unit of a movement class can stand on (the point itself if it's open, else the centre of the
   * nearest open cell).
   */
  openNear(x: number, z: number, moveClass: MoveClass = 'mech'): [number, number] {
    const grid = this.grids?.[moveClass];
    if (!grid) return [x, z];
    const [r, c] = grid.cellOf(x, z);
    if (grid.open(r, c)) return [x, z];
    const cell = grid.nearestOpen(x, z);
    return cell ? grid.centre(cell[0], cell[1]) : [x, z];
  }

  /** A green ring under each selected unit (from a pool that grows as needed) and a red one under an inspected unit. */
  private updateRings(): void {
    if (!this.ringModel) return;
    const marked = this.showRings ? [...this.selected].filter((u) => !u.embarked) : [];
    while (this.rings.length < marked.length) this.rings.push(this.sea.models.addInstance(this.ringModel));
    this.rings.forEach((ring, i) => this.placeRing(ring, marked[i]));
    if (this.inspectRing) this.placeRing(this.inspectRing, (this.showRings && this.inspected) || undefined);
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

/**
 * A helicopter's bounding radius about its root, in the model's units, as the renderer measures a model about its origin
 * (with its margin for gestures): a helicopter's gestures lift the root to its flying height, which the model's own
 * radius takes in.
 */
function bodyRadius(data: ModelData, rest: Float32Array): number {
  const root = Math.max(data.nodes.findIndex((n) => n.name.toLowerCase() === 'joint_root'), 0) * AFFINE_FLOATS;
  const [rx, ry, rz] = [rest[root + 3]!, rest[root + 7]!, rest[root + 11]!];
  let radius = 0;
  for (const p of data.primitives) {
    const m = rest.subarray(p.node * AFFINE_FLOATS, p.node * AFFINE_FLOATS + AFFINE_FLOATS);
    for (let k = 0; k < p.positions.length; k += 3) {
      const [x, y, z] = [p.positions[k]!, p.positions[k + 1]!, p.positions[k + 2]!];
      radius = Math.max(
        radius,
        Math.hypot(m[0]! * x + m[1]! * y + m[2]! * z + m[3]! - rx, m[4]! * x + m[5]! * y + m[6]! * z + m[7]! - ry, m[8]! * x + m[9]! * y + m[10]! * z + m[11]! - rz),
      );
    }
  }
  return radius * 1.3;
}

/** Degrees wrapped to -180..180. */
export function wrapDegrees(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** MC2 heading from one unit to another, degrees. */
export function bearing(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
}

function dist(p: [number, number], x: number, z: number): number {
  return Math.hypot(p[0] - x, p[1] - z);
}

/**
 * A ring of radius `inner`..1 times `size` on the ground, for marking units (scaled to each one's footprint) and
 * places; `lift(angle, radius)` raises its edge (to follow the terrain).
 */
function selectionRing(
  name: string,
  color: [number, number, number, number],
  inner = 0.85,
  size = 1,
  lift: (a: number, r: number) => number = () => 0,
): ModelData {
  // A unit's ring is small; a place's has a vertex every 5 m or so of its edge, to follow the ground.
  const segments = size > 4 ? Math.min(512, Math.max(128, Math.round((size * 2 * Math.PI) / 5))) : 48;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    positions.push(c * inner * size, lift(a, inner * size), s * inner * size, c * size, lift(a, size), s * size);
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
