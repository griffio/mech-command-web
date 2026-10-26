// Advance and Secure, after the game Squad: a lane of capture points taken in order, a ticket pool per side, squads
// that respawn and refit at their side's base, and fog of war. Rules of this project's own (scenarios/*.json), on top of
// MC2's combat.
//
// Points: the first side holds the lane from its end (points 0, 1, ...), the second from the other. A side can take
// only the first point beyond the ones it holds; standing in a point's circle with nobody from the other side there
// moves it toward you (an enemy's point goes neutral first, losing its owner tickets). Tickets go with every unit lost
// and every point lost; a side loses when its tickets run out, or when the other side holds every point.
//
// Infantry are slow and keep to land: a Karnov airlifts them (airlift.ts), and trucks and tracked vehicles across
// water; a squad with an APC rides it on long moves (carriers.ts). Infantry that stand still a while dig in
// behind sandbags, and are much harder to hit. Fire pins soldiers down (suppression.ts): pinned, they don't count
// toward taking a point. Supply trucks build forward bases where squads come back, reinforce and
// refit nearer the front (logistics.ts). Sensors pick up the enemy beyond sight (sensors.ts). A side calls in strikes
// (support.ts), and support units by VTOL: an artillery piece, a scout, a minelayer (deploy.ts, mines.ts).
import type { Scenario, ScenarioSide } from '../../assets';
import { PLAYER_PAINT, paintFromMission, type PaintScheme } from '../../paint.ts';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import { SIGHT_RANGE, bestRange } from '../sim/combat';
import { Airlift } from './airlift';
import type { Attacker } from './battle';
import { Carriers } from './carriers';
import { DEPLOYS, Deployments, type Deploy } from './deploy';
import { FOB_RADIUS, Logistics, type ServicePoint } from './logistics';
import { Minefields } from './mines';
import { Sensors } from './sensors';
import { Squad } from './squads';
import { CALL_INS, Support, type CallIn } from './support';
import { PLAYER_TEAM, bearing, type SeaUnit, type World } from './world';

/** Seconds for one unit to take a neutral point; more units are quicker, up to three times as quick. */
const CAPTURE_S = 25;
const MAX_CAPTURE_SPEEDUP = 3;
/** An uncontested point drifts back to whoever holds it at this share of the capture rate. */
const DRIFT = 0.5;
const POINT_TICKETS = 15;
/** Squads within this of their base reinforce and refit. */
export const BASE_RADIUS = 110;
const REINFORCE_S = 8;
/** Share of a unit's armour, structure and ammunition restored a second at the base. */
const REFIT_RATE = 0.04;
/** Seconds before a wiped-out squad comes back: longer for mechs. */
const RESPAWN_S = { mech: 45, other: 25 };
/** Seconds infantry must stand still to dig in. */
const DIG_IN_S = 8;
/** The AI flies its infantry to goals further than this on foot (or out of reach on foot), metres. */
const AI_AIRLIFT_M = 450;
/**
 * Where the AI sets its infantry down: out of sight of every enemy it has seen in the last minute (their sight range,
 * and a margin), and out of reach of whoever holds an enemy point or is in a point (as the HUD shows the player): they
 * may be anywhere in its circle, and the longest weapon reaches 180 m (gamesys WeaponRanges). It looks for a spot on
 * rings about the goal, and looks again while the Karnov is on its way.
 */
const LZ_CLEAR_M = SIGHT_RANGE + 25;
const LZ_HELD_POINT_M = 200;
const INTEL_S = 60;
const LZ_RING_M = 50;
const LZ_RINGS = 9;
const LZ_BEARINGS = 16;
/**
 * Infantry go in on such a point with the armour: once a mech or vehicle squad attacking it is no more than this further
 * from it than they are, metres.
 */
const INFANTRY_LEAD_M = 100;
/** Bodies are cleared after this; wrecks after the second. */
const CLEAR_INFANTRY_S = 4;
/** What the AI wants under a strike before it calls one (see CommanderAI.callStrikes). */
const STRIKE_WORTH: Record<Exclude<CallIn, 'sensor'>, number> = { artillery: 4, airstrike: 6 };
/**
 * Where the AI wants its support: the artillery piece this far behind the point it holds at the front, on the far side
 * from the enemy's way in (its Long Tom reaches 180 m: over the point and the ground before it), its scout this far short of the point it's attacking (it
 * sees 270 m), and its minelayer's lines of mines across the way the enemy comes to the point it holds: this many, this
 * far apart beyond the point's circle, and this long, metres. It sends the minelayer home to load more below the least.
 */
const ARTILLERY_BACK_M = 110;
const SCOUT_STANDOFF_M = 160;
const MINE_LINES = 3;
const MINE_LINE_GAP_M = 25;
const MINE_LINE_HALF_M = 55;
const MIN_MINES = 20;
const CLEAR_WRECK_S = 150;

/**
 * How much better the AI's pilots shoot than the scenario has them, by the player's choice: gunnery points, which are the
 * chance to hit itself. Easy is the scenario as written, where the player's pilots are the better (45 to 55 against 38
 * to 42). A new player starts on Normal (see the README for how matches the AI plays against itself have gone).
 */
export const DIFFICULTY = { easy: 0, normal: 5, hard: 10 } as const;
export type Difficulty = keyof typeof DIFFICULTY;
export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

export const TEAM_COLOR: Record<number, string> = { 0: '#4fa3ff', 1: '#ff5a4a' };
const RING_COLOR: Record<string, [number, number, number, number]> = {
  0: [0.3, 0.62, 1, 1],
  1: [1, 0.33, 0.27, 1],
  none: [0.82, 0.82, 0.82, 1],
};

export interface CapturePoint {
  name: string;
  x: number;
  z: number;
  radius: number;
  /** -1 (the second side's) .. +1 (the first side's). */
  value: number;
  owner: number | null;
  /** Units of each side in its circle, as of the last update. */
  present: [number, number];
}

/** What happened, for the radio and the notices (the battle log has its own words for these, from onEvent). */
export type MatchSignal =
  | { kind: 'destroyed'; unit: SeaUnit; by: Attacker }
  | { kind: 'captured' | 'lost'; point: CapturePoint; team: number }
  | { kind: 'ended'; winner: number }
  | { kind: 'fobBuilt' | 'fobLost'; team: number }
  /** A side's truck built a turret or a stretch of wall. */
  | { kind: 'built'; what: 'turret' | 'wall'; team: number }
  /** A truck (its squad) or a forward base (squad null) has run out of supply. */
  | { kind: 'outOfSupply'; team: number; squad: Squad | null }
  /** A side can call a strike again; a side has called one (`seen` by the player: theirs, or near their units). */
  | { kind: 'strikeReady'; team: number; call: CallIn }
  | { kind: 'strikeCalled'; team: number; call: CallIn; x: number; z: number; reach: number; seen: boolean }
  /** A side's sensor towers have picked up the enemy after a quiet while; a side's sensor tower was destroyed. */
  | { kind: 'towerContact' | 'towerLost'; team: number }
  /** A side's support unit: sent for, ready to be, lost; set down by its VTOL. */
  | { kind: 'deployCalled'; team: number; what: Deploy; x: number; z: number }
  | { kind: 'deployReady' | 'deployLost'; team: number; what: Deploy }
  | { kind: 'deployed'; team: number; what: Deploy; squad: Squad }
  /** A side's minelayer has laid its last mine; a side's unit has set off a mine. */
  | { kind: 'minesGone'; team: number; squad: Squad }
  | { kind: 'mineHit'; team: number; unit: SeaUnit };

export interface Side {
  team: number;
  name: string;
  tickets: number;
  base: { x: number; z: number };
  paint: PaintScheme;
  squads: Squad[];
  spec: ScenarioSide;
}

export class Match {
  readonly sides: Side[];
  readonly points: CapturePoint[];
  winner: number | null = null;
  /** Kills aren't reported here (the battle does that); captures, losses, reinforcements and the result are. */
  onEvent: (text: string, team: number) => void = () => {};
  onSignal: (signal: MatchSignal) => void = () => {};
  time = 0;
  difficulty: Difficulty = 'easy';
  /** AI commanders, by team (the player's side has none, unless a test adds one). */
  readonly commanders = new Map<number, CommanderAI>();
  readonly airlift: Airlift;
  /** Squads' APCs. */
  readonly carriers: Carriers;
  /** Each side's sensors and what they pick up. */
  readonly sensors: Sensors;
  /** Supply trucks and forward bases, when the scenario has them. */
  logistics: Logistics | null = null;
  /** Strikes the sides call in, when the scenario has them. */
  support: Support | null = null;
  /** Support units the sides call in by VTOL, when the scenario has them. */
  readonly deployments: Deployments | null = null;
  /** The mines the sides' minelayers have laid. */
  readonly mines: Minefields;
  /** The sandbags dug-in squads shelter behind (null if the converter didn't export them). */
  private garrisonModel: GpuModel | null = null;
  private readonly sandbags = new Map<Squad, ModelInstance>();
  /** Each point's ring in each colour (shaped to its ground), by point index and holder. */
  private readonly ringModels = new Map<string, GpuModel>();
  private readonly flagModels = new Map<number, GpuModel | null>();
  private readonly pointRings: ModelInstance[] = [];
  private readonly pointFlags: (ModelInstance | null)[] = [];
  private readonly dead = new Map<SeaUnit, number>();
  private spawning = 0;

  private constructor(
    private readonly world: World,
    readonly scenario: Scenario,
  ) {
    this.airlift = new Airlift(world, scenario.transport ? world.propPath(scenario.transport) : null);
    this.carriers = new Carriers(world);
    this.carriers.onEvent = (text, team) => this.onEvent(text, team);
    this.sensors = new Sensors(world, this);
    this.mines = new Minefields(world, this);
    this.sides = scenario.sides.map((s) => ({
      team: s.team,
      name: s.name,
      tickets: scenario.tickets,
      base: s.base,
      paint: s.team === PLAYER_TEAM ? PLAYER_PAINT : paintFromMission(s.colors ?? ['#7a7a7a', '#c8c8c8', '#303030']),
      squads: s.squads.map((q, i) => new Squad(s.team, String.fromCharCode(65 + i), q)),
      spec: s,
    }));
    if (scenario.support) {
      this.deployments = new Deployments(world, this, scenario.support);
      for (const side of this.sides) this.deployments.addSquads(side);
    }
    const n = scenario.points.length;
    this.points = scenario.points.map((p, i) => ({
      ...p,
      radius: scenario.pointRadius,
      value: i === 0 ? 1 : i === n - 1 ? -1 : 0,
      owner: i === 0 ? 0 : i === n - 1 ? 1 : null,
      present: [0, 0],
    }));
  }

  /** Put the scenario's squads on the map at their bases, and mark the points. */
  static async start(world: World, scenario: Scenario): Promise<Match> {
    const match = new Match(world, scenario);
    for (const [i, p] of match.points.entries()) {
      for (const key of ['0', '1', 'none']) match.ringModels.set(`${i}:${key}`, await world.markerRing(RING_COLOR[key]!, p.x, p.z, p.radius));
    }
    for (const side of match.sides) match.flagModels.set(side.team, await world.propModel(side.spec.flag));
    if (scenario.garrison) match.garrisonModel = await world.propModel(scenario.garrison);
    if (scenario.logistics) {
      match.logistics = new Logistics(world, match, scenario.logistics, BASE_RADIUS);
      await match.logistics.load();
    }
    if (scenario.support) {
      match.support = new Support(world, match, scenario.support);
      await match.support.load();
    }
    await match.sensors.load(scenario.support?.marker ?? null);
    for (const p of match.points) {
      match.pointRings.push(world.addMarker(match.ringModels.get(`${match.pointRings.length}:none`)!, p.x, p.z, 1));
      match.pointFlags.push(null);
    }
    match.points.forEach((_, i) => match.showOwner(i));
    for (const side of match.sides) {
      const ring = await world.markerRing(RING_COLOR[String(side.team)]!, side.base.x, side.base.z, BASE_RADIUS);
      world.addMarker(ring, side.base.x, side.base.z, 1);
      // Support units come later, by VTOL.
      await Promise.all(side.squads.map((squad, i) => (squad.support ? null : match.deploy(side, squad, i))));
    }
    world.battle.onDestroyed = (u, by) => match.lost(u, by);
    world.battle.judgeOutcome = false;
    match.commanders.set(1, new CommanderAI(match, world, 1));
    return match;
  }

  side(team: number): Side {
    return this.sides.find((s) => s.team === team)!;
  }

  /** The enemy's pilots shoot better or worse (see DIFFICULTY): those in the field now, and those yet to come. */
  setDifficulty(difficulty: Difficulty): void {
    const change = DIFFICULTY[difficulty] - DIFFICULTY[this.difficulty];
    this.difficulty = difficulty;
    for (const side of this.sides) {
      if (side.team === PLAYER_TEAM) continue;
      this.world.gunneryBonus.set(side.team, DIFFICULTY[difficulty]);
      for (const u of this.world.units) if (u.team === side.team && u.combat) u.combat.gunnery += change;
    }
  }

  /** The point a side can take next (the first beyond those it holds), or null. */
  capturable(team: number): number | null {
    const n = this.points.length;
    if (team === 0) {
      const k = this.points.findIndex((p) => p.owner !== 0);
      return k < 0 ? null : k;
    }
    for (let k = n - 1; k >= 0; k--) if (this.points[k]!.owner !== 1) return k;
    return null;
  }

  /** The last point a side holds toward the other's end (the one it must defend), or null. */
  frontier(team: number): number | null {
    const n = this.points.length;
    const k = this.capturable(team);
    const f = team === 0 ? (k ?? n) - 1 : (k ?? -1) + 1;
    return f >= 0 && f < n && this.points[f]!.owner === team ? f : null;
  }

  update(dt: number): void {
    if (this.winner !== null) return;
    this.time += dt;
    this.airlift.update(dt);
    this.carriers.update(dt);
    this.logistics?.update(dt);
    this.support?.update(dt);
    this.deployments?.update();
    this.mines.update(dt);
    this.sensors.update(dt);
    this.capture(dt);
    this.garrison(dt);
    this.supply(dt);
    this.clearDead();
    this.fog();
    for (const ai of this.commanders.values()) ai.update();
    this.judge();
  }

  /** A unit died: its side pays for it in tickets. */
  private lost(u: SeaUnit, by: Attacker): void {
    this.dead.set(u, this.time);
    const side = this.sides.find((s) => s.team === u.team);
    if (side) side.tickets -= ticketCost(u);
    this.onSignal({ kind: 'destroyed', unit: u, by });
    this.carriers.lost(u, by);
  }

  /**
   * Send a squad to a point: in its APC when that's quicker (carriers.ts), else on its own feet, wheels or tracks.
   * Returns how many members have a way there.
   */
  moveSquad(squad: Squad, x: number, z: number, retreat = false): number {
    if (this.carriers.ride(squad, x, z, retreat)) return squad.alive.length;
    return squad.move(this.world, x, z, retreat);
  }

  /**
   * Units in a point's circle take it; helicopters can't (code/warrior.cpp: canCapture), nor can buildings or an
   * artillery piece (which would hold it for good).
   */
  private capture(dt: number): void {
    const counts = this.points.map(() => [0, 0] as [number, number]);
    for (const u of this.world.units) {
      if (!u.alive || !u.combat || u.embarked || u.pinned || u.flies || u.immobile || (u.team !== 0 && u.team !== 1)) continue;
      this.points.forEach((p, i) => {
        if (Math.hypot(u.x - p.x, u.z - p.z) <= p.radius) counts[i]![u.team]!++;
      });
    }
    const can = [this.capturable(0), this.capturable(1)];
    this.points.forEach((p, i) => {
      const [a, b] = counts[i]!;
      p.present = [a, b];
      const rate = (n: number) => (Math.min(1 + 0.5 * (n - 1), MAX_CAPTURE_SPEEDUP) / CAPTURE_S) * dt;
      if (a > 0 && b > 0) return; // contested
      if (a > 0 && can[0] === i) p.value = Math.min(p.value + rate(a), 1);
      else if (b > 0 && can[1] === i) p.value = Math.max(p.value - rate(b), -1);
      else {
        const home = p.owner === 0 ? 1 : p.owner === 1 ? -1 : 0;
        const step = (DRIFT / CAPTURE_S) * dt;
        p.value = p.value < home ? Math.min(p.value + step, home) : Math.max(p.value - step, home);
      }
      const was = p.owner;
      if (p.value >= 1) p.owner = 0;
      else if (p.value <= -1) p.owner = 1;
      else if ((p.owner === 0 && p.value <= 0) || (p.owner === 1 && p.value >= 0)) p.owner = null;
      if (p.owner === was) return;
      this.showOwner(i);
      if (was !== null) {
        this.side(was).tickets -= POINT_TICKETS;
        this.onEvent(`${p.name} lost by ${this.side(was).name} (−${POINT_TICKETS} tickets)`, was);
        this.onSignal({ kind: 'lost', point: p, team: was });
      }
      if (p.owner !== null) {
        this.onEvent(`${this.side(p.owner).name} captured ${p.name}`, p.owner);
        this.onSignal({ kind: 'captured', point: p, team: p.owner });
      }
    });
  }

  /** Send a squad's minelayer to a point, laying mines on its way (mines.ts). Returns how many of it have a way there. */
  layMines(squad: Squad, x: number, z: number): number {
    const routed = squad.move(this.world, x, z);
    for (const u of squad.alive) if (u.mines !== null && u.mines >= 1 && u.route.length) u.laying = true;
    return routed;
  }

  /** Fly a squad of infantry to a point, if the airlift can; false if it can't (it has no Karnov, or is flying). */
  airliftSquad(squad: Squad, x: number, z: number): boolean {
    if (!squad.airliftable || !this.airlift.available || squad.airborne) return false;
    const side = this.side(squad.team);
    // The Karnov flies from whichever of the side's bases is nearest the squad.
    const at = squad.centroid()!;
    const from = this.logistics?.departure(side.team, at[0], at[1]) ?? side.base;
    // Out of its APC first: the Karnov takes the APC too.
    this.carriers.cancel(squad);
    void this.airlift.request(squad, from, side.paint, x, z);
    if (squad.team === PLAYER_TEAM) this.onEvent(`${squad.name}: the Karnov is on its way`, squad.team);
    return true;
  }

  /** Infantry that have stood still a while dig in behind sandbags; moving off (or boarding) gives it up. */
  private garrison(dt: number): void {
    for (const side of this.sides) {
      for (const squad of side.squads) {
        const alive = squad.riders;
        const still = squad.isInfantry && !squad.airborne && !squad.ride && alive.every((u) => !u.route.length && !u.embarked);
        // Pinned down, they can't dig in (but a squad already dug in stays so).
        const pinned = alive.some((u) => u.pinned);
        squad.stillFor = still ? squad.stillFor + (pinned && !squad.dugIn ? 0 : dt) : 0;
        const dug = still && squad.stillFor >= DIG_IN_S;
        if (dug === squad.dugIn) continue;
        squad.dugIn = dug;
        const old = this.sandbags.get(squad);
        if (old) this.world.removeMarker(old);
        this.sandbags.delete(squad);
        const c = squad.centroid();
        if (dug && c && this.garrisonModel) this.sandbags.set(squad, this.world.addMarker(this.garrisonModel, c[0], c[1]));
        if (dug && side.team === PLAYER_TEAM) this.onEvent(`${squad.name} dug in`, side.team);
      }
    }
  }

  /**
   * Wiped-out squads come back after a while, at the forward base nearest the front that can pay for them (else the
   * main base); a support unit doesn't (another can be called in: deploy.ts). Squads at a base get their missing
   * members back and refit: free at the main base, for supply at a forward one. A minelayer loads mines as it refits.
   */
  private supply(dt: number): void {
    for (const side of this.sides) {
      side.squads.forEach((squad, i) => {
        const alive = squad.alive;
        if (squad.support && !alive.length) return;
        // Wiped out: its APC, if that's left, goes back to the base to meet it.
        if (!squad.riders.length && this.spawning === 0) {
          if (squad.respawnAt === null) {
            squad.respawnAt = this.time + (squad.spec.units.some((t) => this.world.typeKind(t) === 'mech') ? RESPAWN_S.mech : RESPAWN_S.other);
            if (alive.length && !squad.airborne) squad.move(this.world, side.base.x, side.base.z);
          } else if (this.time >= squad.respawnAt) {
            squad.respawnAt = null;
            const { point, why } = this.respawnPoint(side, squad);
            void this.deploy(side, squad, i, Infinity, point);
            this.onEvent(`${side.name}: squad ${squad.name} back at ${point.fob ? 'a forward base' : 'base'}${why ? ` (${why})` : ''}`, side.team);
          }
          return;
        }
        const point = this.logistics?.pointFor(side.team, alive) ?? (alive.every((u) => Math.hypot(u.x - side.base.x, u.z - side.base.z) <= BASE_RADIUS) ? this.mainBase(side) : null);
        if (!point || alive.some((u) => u.embarked)) return;
        // Helicopters with nothing to do set down at a base (and take off again when they have).
        for (const u of alive) if (!u.target && !u.attackOrder) u.land();
        if (!point.fob || this.logistics!.pay(point, this.logistics!.refitCost(alive) * dt)) for (const u of alive) refit(u, dt);
        else this.logistics!.short(point.fob, squad, 'refit');
        if (squad.missing > 0 && this.time >= squad.reinforceAt && this.spawning === 0) {
          const next = this.missingTypes(squad)[0]!;
          if (!this.logistics || this.logistics.pay(point, this.logistics.costOf(next))) {
            squad.reinforceAt = this.time + REINFORCE_S;
            void this.deploy(side, squad, i, 1, point);
          } else if (point.fob) this.logistics.short(point.fob, squad, 'reinforce');
        }
      });
    }
  }

  private mainBase(side: Side): ServicePoint {
    return { x: side.base.x, z: side.base.z, radius: BASE_RADIUS, fob: null };
  }

  /**
   * Where a wiped-out squad comes back, paid for: trucks always at the main base (to fill up). For the player, why it
   * isn't a forward base when there is one.
   */
  private respawnPoint(side: Side, squad: Squad): { point: ServicePoint; why: string | null } {
    const L = this.logistics;
    if (!L || squad.spec.units.every((t) => t === L.spec.truck)) return { point: this.mainBase(side), why: null };
    const cost = squad.spec.units.reduce((s, t) => s + L.costOf(t), 0);
    const point = L.respawnPoint(side.team, cost);
    L.pay(point, cost);
    const fobs = L.fobs.filter((f) => f.team === side.team);
    if (point.fob || !fobs.length || side.team !== PLAYER_TEAM) return { point, why: null };
    const why =
      fobs.length === 1
        ? `the forward base has ${Math.floor(fobs[0]!.supply)} of the ${cost} supply it takes`
        : `no forward base has the ${cost} supply it takes`;
    return { point, why };
  }

  /** The unit types a squad is missing (its APC last). */
  private missingTypes(squad: Squad): string[] {
    const types = squad.spec.units.slice();
    for (const u of squad.riders) {
      const k = types.indexOf(u.typeKey ?? '');
      if (k >= 0) types.splice(k, 1);
    }
    if (squad.spec.carrier && !squad.carrier) types.push(squad.spec.carrier);
    return types;
  }

  /** Spawn a squad's missing members (or `limit` of them) at a base, in its formation's place. */
  private async deploy(side: Side, squad: Squad, index: number, limit = Infinity, at: ServicePoint = this.mainBase(side)): Promise<void> {
    const types = this.missingTypes(squad);
    const toward = this.points[side.team === 0 ? 0 : this.points.length - 1]!;
    const facing = bearing(at, toward);
    // Squads stand side by side across the main base, facing the lane; at a forward base, about its tent.
    const across = ((facing + 90) * Math.PI) / 180;
    const squads = side.squads.filter((q) => !q.support).length;
    const offset = at.fob ? (index % 3 - 1) * 20 : (index - (squads - 1) / 2) * 34;
    const back = at.fob ? FOB_RADIUS * 0.5 : 0;
    const cx = at.x + Math.sin(across) * offset - Math.sin((facing * Math.PI) / 180) * back;
    const cz = at.z + Math.cos(across) * offset - Math.cos((facing * Math.PI) / 180) * back;
    this.spawning++;
    try {
      for (const [k, type] of types.slice(0, limit).entries()) {
        const r = Math.floor(k / 3);
        const c = (k % 3) - 1;
        const spacing = this.world.typeKind(type) === 'infantry' ? 6 : 16;
        const [x, z] = this.world.openNear(
          cx + Math.sin(across) * c * spacing - Math.sin((facing * Math.PI) / 180) * r * spacing,
          cz + Math.cos(across) * c * spacing - Math.cos((facing * Math.PI) / 180) * r * spacing,
          this.world.typeMoveClass(type),
        );
        const unit = await this.world.spawnType(type, side.team, x, z, facing, squad.spec.gunnery, side.paint);
        if (!unit) continue;
        unit.squad = squad;
        squad.units.push(unit);
        this.world.units.push(unit);
      }
    } finally {
      this.spawning--;
    }
  }

  /** Clear away bodies and old wrecks (and drop them from their squads). */
  private clearDead(): void {
    for (const [u, at] of this.dead) {
      if (this.time - at < (u.kind === 'infantry' ? CLEAR_INFANTRY_S : CLEAR_WRECK_S)) continue;
      this.dead.delete(u);
      if (u.squad) u.squad.units.splice(u.squad.units.indexOf(u), 1);
      this.world.remove(u);
    }
  }

  /** The player sees only the enemies their side sees (and the wrecks of the ones it destroyed). */
  private fog(): void {
    const seen = this.world.battle.seenBy(PLAYER_TEAM);
    // Aircraft (no stats) are seen from afar, and walls are always there to see.
    for (const u of this.world.units) u.hidden = u.team !== PLAYER_TEAM && u.alive && !!u.combat && !u.wall && !seen.has(u);
  }

  private judge(): void {
    for (const side of this.sides) {
      const other = this.sides.find((s) => s !== side)!;
      if (side.tickets <= 0) this.end(other.team, `${side.name} ran out of tickets`);
      else if (this.points.every((p) => p.owner === side.team)) this.end(side.team, `${side.name} holds every point`);
      if (this.winner !== null) return;
    }
  }

  private end(winner: number, reason: string): void {
    this.winner = winner;
    this.onEvent(`${winner === PLAYER_TEAM ? 'Victory' : 'Defeat'}: ${reason}`, winner);
    this.onSignal({ kind: 'ended', winner });
  }

  /** Recolour a point's ring and raise its holder's flag. */
  private showOwner(i: number): void {
    const p = this.points[i]!;
    const ring = this.world.replaceMarker(this.pointRings[i]!, this.ringModels.get(`${i}:${p.owner === null ? 'none' : p.owner}`)!, p.x, p.z, 1);
    this.pointRings[i] = ring;
    const old = this.pointFlags[i];
    if (old) this.world.removeMarker(old);
    const flag = p.owner === null ? null : this.flagModels.get(p.owner);
    this.pointFlags[i] = flag ? this.world.addMarker(flag, p.x, p.z, 1) : null;
  }
}

/** A unit at a base refits; a minelayer loads mines too. */
function refit(u: SeaUnit, dt: number): void {
  u.combat?.refit(dt, REFIT_RATE);
  if (u.mines !== null && u.minesCapacity) u.mines = Math.min(u.minesCapacity, u.mines + u.minesCapacity * REFIT_RATE * dt);
}

/** Somewhere to keep this far from. */
interface Threat {
  x: number;
  z: number;
  clear: number;
}

/** How far a spot is outside the nearest threat's distance, metres (negative inside it). */
function clearance(at: [number, number], threats: Threat[]): number {
  let c = Infinity;
  for (const t of threats) c = Math.min(c, Math.hypot(t.x - at[0], t.z - at[1]) - t.clear);
  return c;
}

/**
 * What losing a unit costs its side: a mech by its weight, a helicopter or power armour two, a soldier or a vehicle one.
 * MC2's vehicles go down to a hit or two (7 points a side, against a mech's hundreds), like soldiers; at more, a side
 * with armour bleeds tickets for it. A helicopter has a light mech's armour but no structure behind it.
 */
function ticketCost(u: SeaUnit): number {
  const stats = u.combat?.stats;
  // A forward base's loss is charged when its tent falls (logistics.ts); a turret costs nothing.
  if (u.kind === 'structure') return 0;
  if (u.flies) return 2;
  if (u.kind === 'mech') return Math.max(4, Math.round((stats?.tonnage ?? 40) / 10));
  if (u.kind === 'infantry') return (stats?.tonnage ?? 1) > 2 ? 2 : 1;
  return 1;
}

/**
 * A simple commander for a side: most squads go for the point it can take next, the rest hold the point it must keep,
 * fire-support squads stand off behind the attack, and squads that have lost most of their strength fall back to
 * the base to reinforce and refit. Infantry are flown in short of the enemy, out of its sight, and go in on a point the
 * enemy is at with the mechs and vehicles, not ahead of them; so do its helicopters, which would otherwise get there
 * first. It drops a sensor probe on the point it's attacking when its sensors don't reach there.
 */
export class CommanderAI {
  private nextThink = 0;
  /** Where it last saw each enemy (that has weapons), and when. */
  private readonly sightings = new Map<SeaUnit, { x: number; z: number; at: number }>();
  /** Squads it has flying, and the goals they're for. */
  private readonly lifts = new Map<Squad, [number, number]>();
  /** Its minelayer's work: the point it's mining the way to, the lines laid, and whether it's laying one. */
  private readonly minePlan = new Map<Squad, { point: number; lines: number; laying: boolean }>();

  constructor(
    private readonly match: Match,
    private readonly world: World,
    readonly team: number,
  ) {}

  update(): void {
    if (this.match.time < this.nextThink) return;
    this.nextThink = this.match.time + 5;
    this.watch();
    this.waveOff();
    const side = this.match.side(this.team);
    const target = this.match.capturable(this.team);
    const hold = this.match.frontier(this.team);
    const ready = side.squads.filter((q) => q.alive.length && q.respawnAt === null);
    for (const q of ready.filter((q) => q.isLogistics)) this.supplyRun(q);
    this.callStrikes();
    this.probe();
    this.callSupport(ready);
    for (const q of ready.filter((q) => q.support === 'scout')) this.scout(q, target ?? hold);
    for (const q of ready.filter((q) => q.support === 'minelayer')) this.mine(q, hold);
    const squads = ready.filter((q) => !q.isLogistics && !q.support);
    const threats = this.threats();
    const attackers = Math.ceil(squads.length * 0.65);
    squads
      .sort((a, b) => b.strength - a.strength)
      .forEach((squad, i) => {
        // Fall back when badly hurt; stay until whole again.
        if (squad.airborne) return;
        if (squad.assignment === -1 && (squad.missing > 0 || squad.strength < 0.9)) return;
        if (squad.strength < 0.35) return this.send(squad, -1, side.base.x, side.base.z, true);
        const index = i < attackers || hold === null ? target : hold;
        if (index === null) return;
        const p = this.match.points[index]!;
        // Fire support stands off on its own side of the point.
        const standOff = squad.alive.every((u) => u.combat && bestRange(u.combat) >= 150) ? 130 : 0;
        const d = Math.hypot(side.base.x - p.x, side.base.z - p.z) || 1;
        const x = p.x + ((side.base.x - p.x) / d) * standOff;
        const z = p.z + ((side.base.z - p.z) / d) * standOff;
        if (index === target && this.waitForArmour(squad, index, threats)) return;
        this.send(squad, index, x, z, false);
      });
  }

  /**
   * The supply truck: build a forward base a little back from the point under attack (if it has the supply and none is
   * near there), fill up at the main base when it's run low, and otherwise unload at the forward base that needs it most.
   */
  private supplyRun(squad: Squad): void {
    const L = this.match.logistics;
    const truck = squad.alive[0];
    if (!L || !truck || truck.supply === null || squad.airborne || L.ordered(squad)) return;
    const side = this.match.side(this.team);
    const own = L.fobs.filter((f) => f.team === this.team);
    const target = this.match.capturable(this.team);
    const idle = !truck.route.length;
    // A turret for the point it holds at the front comes first: it's cheap, and it keeps what's been won.
    if (this.fortify(squad, truck, true)) return;
    if (target !== null && truck.supply >= L.spec.fobCost) {
      const p = this.match.points[target]!;
      const d = Math.hypot(side.base.x - p.x, side.base.z - p.z) || 1;
      const [sx, sz] = this.world.openNear(p.x + ((side.base.x - p.x) / d) * 220, p.z + ((side.base.z - p.z) / d) * 220, 'ground');
      if (!own.some((f) => Math.hypot(f.x - sx, f.z - sz) < 400) && !L.whyNot(this.team, 'fob', sx, sz)) {
        if (!this.world.grids?.ground.connected(truck.x, truck.z, sx, sz)) this.match.airliftSquad(squad, sx, sz);
        else L.orderBuild(squad, 'fob', sx, sz);
        return;
      }
    }
    if (this.fortify(squad, truck)) return;
    const goal = truck.supply < 100 ? side.base : own.filter((f) => f.supply < 1000).sort((a, b) => a.supply - b.supply)[0];
    if (!goal || !idle || Math.hypot(truck.x - goal.x, truck.z - goal.z) < 20) return;
    if (!this.world.grids?.ground.connected(truck.x, truck.z, goal.x, goal.z)) this.match.airliftSquad(squad, goal.x, goal.z);
    else squad.move(this.world, goal.x, goal.z);
  }

  /**
   * Fortify the point it holds at the front, while the truck can drive there: two turrets in its circle (or only the
   * first), then a stretch of wall across the way to it from the enemy. True if the truck is off to build one.
   */
  private fortify(squad: Squad, truck: SeaUnit, first = false): boolean {
    const L = this.match.logistics!;
    const hold = this.match.frontier(this.team);
    if (hold === null) return false;
    const p = this.match.points[hold]!;
    const reach = (x: number, z: number) => !this.world.grids || this.world.grids.ground.connected(truck.x, truck.z, x, z);
    const supply = truck.supply ?? 0;
    if (L.standing(this.team, 'turret', p.x, p.z, p.radius + 30) < (first ? 1 : 2) && supply >= L.price('turret')) {
      const a = Math.random() * Math.PI * 2;
      const [x, z] = this.world.openNear(p.x + Math.sin(a) * p.radius * 0.5, p.z + Math.cos(a) * p.radius * 0.5, 'ground');
      if (reach(x, z) && !L.whyNot(this.team, 'turret', x, z) && !L.orderBuild(squad, 'turret', x, z)) return true;
    }
    if (first) return false;
    if (L.standing(this.team, 'wall', p.x, p.z, p.radius + 80) < 1 && supply >= L.price('wall')) {
      const r = (L.facing(this.team, p.x, p.z) * Math.PI) / 180;
      const [x, z] = this.world.openNear(p.x + Math.sin(r) * (p.radius + 20), p.z + Math.cos(r) * (p.radius + 20), 'ground');
      if (reach(x, z) && !L.whyNot(this.team, 'wall', x, z) && !L.orderBuild(squad, 'wall', x, z)) return true;
    }
    return false;
  }

  /**
   * Call in what strikes are ready, each on the enemies it knows of (sees, or its sensors pick up) bunched up most
   * (worth a mech 3, a vehicle or a turret 2,
   * a soldier 1, those within the strike's minor range half), when they're worth enough and none of its own are
   * within its reach.
   */
  private callStrikes(): void {
    const S = this.match.support;
    if (!S) return;
    for (const call of CALL_INS) {
      const stats = S.stats(call);
      if (call === 'sensor' || !stats || S.readyIn(this.team, call) > 0) continue;
      const seen = this.known().filter((u) => u.alive && !u.embarked);
      const own = this.world.units.filter((u) => u.team === this.team && u.alive && u.combat && !u.embarked);
      // Helicopters in the air are out of a strike's reach, and walls aren't worth one.
      const worth = (u: SeaUnit) => (u.wall || (u.flies && u.flight !== 'parked') ? 0 : u.kind === 'mech' ? 3 : u.kind === 'infantry' ? 1 : 2);
      let best: SeaUnit | null = null;
      let bestScore = STRIKE_WORTH[call];
      for (const c of seen) {
        if (own.some((o) => Math.hypot(o.x - c.x, o.z - c.z) <= stats.minorRange + 15)) continue;
        let score = 0;
        for (const e of seen) {
          const d = Math.hypot(e.x - c.x, e.z - c.z);
          if (d <= stats.minorRange) score += worth(e) * (d <= stats.majorRange ? 1 : 0.5);
        }
        if (score >= bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) S.call(this.team, call, best.x, best.z);
    }
  }

  /**
   * A sensor probe, when it has one, on the point it's attacking (or else the one it holds at the front) if its sensors
   * don't reach that already.
   */
  private probe(): void {
    const S = this.match.support;
    if (!S?.available('sensor') || S.readyIn(this.team, 'sensor') > 0) return;
    for (const k of [this.match.capturable(this.team), this.match.frontier(this.team)]) {
      const p = k === null ? null : this.match.points[k]!;
      if (p && !this.match.sensors.covers(this.team, p.x, p.z)) return void S.call(this.team, 'sensor', p.x, p.z);
    }
  }

  /**
   * Call in its support as it's ready, where its squads can see: the artillery piece behind the point it holds at the
   * front, away from the enemy's way in (or on the point), the minelayer on the point (or with a squad of its, the one
   * nearest home first, to drive there from), the scout with the squad nearest the point it's attacking.
   */
  private callSupport(ready: Squad[]): void {
    const D = this.match.deployments;
    if (!D) return;
    const hold = this.match.frontier(this.team);
    const target = this.match.capturable(this.team);
    const goal = target === null ? null : this.match.points[target]!;
    const toGoal = (q: Squad) => (goal ? Math.hypot(q.centroid()![0] - goal.x, q.centroid()![1] - goal.z) : 0);
    const squads = ready.filter((q) => !q.support && !q.airborne && q.centroid());
    for (const kind of DEPLOYS) {
      if (!D.available(kind) || D.readyIn(this.team, kind) > 0) continue;
      const spots: [number, number][] = [];
      if (kind !== 'scout' && hold !== null) {
        const p = this.match.points[hold]!;
        const a = (this.towardEnemy(hold) * Math.PI) / 180;
        const back = kind === 'artilleryPiece' ? ARTILLERY_BACK_M : 0;
        spots.push([p.x - Math.sin(a) * back, p.z - Math.cos(a) * back], [p.x, p.z]);
      }
      if (kind === 'scout') spots.push(...squads.sort((a, b) => toGoal(a) - toGoal(b)).map((q) => q.centroid()!));
      if (kind === 'minelayer') spots.push(...squads.sort((a, b) => toGoal(b) - toGoal(a)).map((q) => q.centroid()!));
      for (const [x, z] of spots) if (!D.call(this.team, kind, x, z)) break;
    }
  }

  /** Its scout watches the point it's attacking from short of it, on its own side; hurt badly, it goes home. */
  private scout(squad: Squad, index: number | null): void {
    const side = this.match.side(this.team);
    if (squad.strength < 0.35) return this.send(squad, -1, side.base.x, side.base.z, true);
    if (squad.assignment === -1 && squad.strength < 0.9) return;
    if (index === null) return;
    const p = this.match.points[index]!;
    const d = Math.hypot(side.base.x - p.x, side.base.z - p.z) || 1;
    const back = Math.min(SCOUT_STANDOFF_M, d);
    this.send(squad, index, p.x + ((side.base.x - p.x) / d) * back, p.z + ((side.base.z - p.z) / d) * back, false);
  }

  /**
   * Its minelayer lays lines of mines across the way the enemy comes to the point it holds at the front: to one end of
   * a line, then along it, the next a little further out. Short of mines, it goes home to load, until it's full.
   */
  private mine(squad: Squad, hold: number | null): void {
    const layer = squad.minelayer;
    if (!layer || squad.airborne || layer.laying) return;
    const side = this.match.side(this.team);
    const mines = layer.mines ?? 0;
    if (mines < MIN_MINES || (squad.assignment === -1 && mines < (layer.minesCapacity ?? 0))) {
      this.minePlan.delete(squad);
      if (squad.assignment !== -1 || (!layer.route.length && Math.hypot(layer.x - side.base.x, layer.z - side.base.z) > BASE_RADIUS * 0.7)) {
        this.send(squad, -1, side.base.x, side.base.z, false);
      }
      return;
    }
    if (hold === null) return;
    let plan = this.minePlan.get(squad);
    if (!plan || plan.point !== hold) {
      plan = { point: hold, lines: 0, laying: false };
      this.minePlan.set(squad, plan);
    }
    // A line laid (or broken off).
    if (plan.laying) {
      plan.laying = false;
      plan.lines++;
    }
    if (plan.lines >= MINE_LINES || layer.route.length) return;
    const p = this.match.points[hold]!;
    const a = (this.towardEnemy(hold) * Math.PI) / 180;
    const off = p.radius + MINE_LINE_GAP_M * (plan.lines + 1);
    const [cx, cz] = [p.x + Math.sin(a) * off, p.z + Math.cos(a) * off];
    // Across the way: alternate ends, so each line starts where the last ended.
    const w = plan.lines % 2 ? -1 : 1;
    const ends = [-w, w].map((s) => this.world.openNear(cx + Math.cos(a) * MINE_LINE_HALF_M * s, cz - Math.sin(a) * MINE_LINE_HALF_M * s, 'ground'));
    const [start, end] = [ends[0]!, ends[1]!];
    squad.assignment = hold;
    if (Math.hypot(layer.x - start[0], layer.z - start[1]) > 15) {
      squad.move(this.world, start[0], start[1]);
      return;
    }
    if (this.match.layMines(squad, end[0], end[1])) plan.laying = true;
    else plan.lines++;
  }

  /** The bearing from a point toward the enemy: to the next point on the enemy's side, or the enemy's base. */
  private towardEnemy(index: number): number {
    const p = this.match.points[index]!;
    const next = this.match.points[this.team === 0 ? index + 1 : index - 1];
    return bearing(p, next ?? this.match.sides.find((s) => s.team !== this.team)!.base);
  }

  /** The enemies it knows of now: those its side sees, and those its sensors pick up. */
  private known(): SeaUnit[] {
    return [...new Set([...this.world.battle.seenBy(this.team), ...this.match.sensors.sensed(this.team)])];
  }

  /** Note where it sees (or its sensors pick up) enemies, and forget those dead or not heard of for a while. */
  private watch(): void {
    const now = this.match.time;
    for (const u of this.known()) if (u.alive && u.combat?.weapons.length) this.sightings.set(u, { x: u.x, z: u.z, at: now });
    for (const [u, s] of this.sightings) if (!u.alive || now - s.at > INTEL_S) this.sightings.delete(u);
  }

  /**
   * Infantry and helicopters don't go in on a point the enemy holds, is in, or has been seen near, ahead of their side's
   * mechs and vehicles: they wait out of the enemy's sight (infantry dig in) until a squad of those attacking it is
   * nearly as near it as they are, then go in with it. True if the squad waits (or goes to wait somewhere).
   */
  private waitForArmour(squad: Squad, index: number, threats: Threat[]): boolean {
    const p = this.match.points[index]!;
    const c = squad.centroid();
    if (!(squad.isInfantry || squad.isAir) || !c || clearance([p.x, p.z], threats) >= 0) return false;
    const armour = this.match.side(this.team).squads.filter((q) => !q.isInfantry && !q.isLogistics && !q.isAir && !q.support);
    if (!armour.length) return false;
    const toPoint = (q: Squad) => {
      const at = q.centroid();
      return at ? Math.hypot(at[0] - p.x, at[1] - p.z) : Infinity;
    };
    const lead = Math.min(...armour.filter((q) => q.assignment === index && q.respawnAt === null && !q.airborne).map(toPoint));
    if (lead <= toPoint(squad) + INFANTRY_LEAD_M) return false;
    // Already on its way (in, or to wait): carry on.
    if (squad.assignment === index && squad.alive.some((u) => u.route.length || u.attackOrder)) return false;
    // Out of the enemy's sight, and not far off: wait here.
    if (clearance(c, threats) >= 0 && toPoint(squad) <= AI_AIRLIFT_M) {
      squad.assignment = index;
      return true;
    }
    const lz = this.landingZone(c, p.x, p.z);
    if (!lz?.safe) return false;
    this.send(squad, index, lz.at[0], lz.at[1], false);
    return true;
  }

  /** A flight whose landing zone has turned hot goes to a safe one for its goal instead, if there is one. */
  private waveOff(): void {
    const threats = this.threats();
    for (const [squad, [x, z]] of this.lifts) {
      const drop = this.match.airlift.destination(squad);
      const from = squad.centroid();
      if (!squad.airborne || !drop || !from) {
        this.lifts.delete(squad);
        continue;
      }
      if (clearance(drop, threats) >= 0) continue;
      const lz = this.landingZone(from, x, z);
      if (lz?.safe) this.match.airlift.redirect(squad, lz.at[0], lz.at[1]);
    }
  }

  /** What to land clear of: the enemies it has seen lately, the points the enemy holds, and those it's in. */
  private threats(): Threat[] {
    const threats = [...this.sightings.values()].map((s) => ({ x: s.x, z: s.z, clear: LZ_CLEAR_M }));
    for (const p of this.match.points) {
      const held = p.owner !== null && p.owner !== this.team;
      if (held || p.present.some((n, team) => team !== this.team && n > 0)) threats.push({ x: p.x, z: p.z, clear: p.radius + LZ_HELD_POINT_M });
    }
    return threats;
  }

  /**
   * Where to set infantry flying from `from` down for a goal: the spot nearest it, on the side they come from, that's
   * clear of the enemy (see LZ_CLEAR_M) and that they can walk to it from. With no such spot, the one clearest of the
   * enemy (`safe` false).
   */
  private landingZone(from: [number, number], x: number, z: number): { at: [number, number]; safe: boolean } | null {
    const ground = this.world.grids?.ground;
    const threats = this.threats();
    let best: { at: [number, number]; safe: boolean } | null = null;
    let bestCost = Infinity;
    let bestClearance = -Infinity;
    for (let ring = 0; ring <= LZ_RINGS; ring++) {
      const r = ring * LZ_RING_M;
      // A safe spot nearer than this ring can't be beaten by one on it.
      if (best?.safe && r > bestCost) break;
      for (let i = 0; i < (ring ? LZ_BEARINGS : 1); i++) {
        const a = (i / LZ_BEARINGS) * Math.PI * 2;
        const at = this.world.openNear(x + Math.cos(a) * r, z + Math.sin(a) * r, 'ground');
        if (ground && !ground.connected(at[0], at[1], x, z)) continue;
        const clear = clearance(at, threats);
        if (clear >= 0) {
          // Walking from it to the goal, and a little for flying further: land on the near side.
          const cost = Math.hypot(at[0] - x, at[1] - z) + 0.25 * Math.hypot(at[0] - from[0], at[1] - from[1]);
          if (cost < bestCost) [best, bestCost] = [{ at, safe: true }, cost];
        } else if (!best?.safe && clear > bestClearance) [best, bestClearance] = [{ at, safe: false }, clear];
      }
    }
    return best;
  }

  /**
   * Order a squad to a place, unless it already has that job and is there or on its way. Infantry fly to goals they
   * can't reach on foot, or that are far (unless their APC can drive them): set down short of the goal, clear of the
   * enemy, to walk in from there.
   */
  private send(squad: Squad, assignment: number, x: number, z: number, retreat: boolean): void {
    const c = squad.centroid();
    // Fighting what it met on the way counts as busy: it goes on once that's settled.
    const busy = squad.alive.some((u) => u.route.length || u.attackOrder || (u.target && this.world.battle.sees(u, u.target)));
    if (squad.assignment === assignment && (busy || (c && Math.hypot(c[0] - x, c[1] - z) < 45))) return;
    squad.assignment = assignment;
    const [tx, tz] = [x + (Math.random() - 0.5) * 30, z + (Math.random() - 0.5) * 30];
    const far = c && Math.hypot(c[0] - tx, c[1] - tz) > AI_AIRLIFT_M;
    const unreachable = c && this.world.grids && !this.world.grids.ground.connected(c[0], c[1], tx, tz);
    const rides = !unreachable && this.match.carriers.quicker(squad, tx, tz);
    // Falling back flies only when there's no way home on foot, and straight home. Vehicles drive whatever the distance,
    // and fly only across water (the LRM carriers, from the Liao base's island).
    if (squad.airliftable && c && (unreachable || (squad.isInfantry && far && !retreat && !rides))) {
      const lz = retreat ? { at: [tx, tz] as [number, number], safe: true } : this.landingZone(c, tx, tz);
      // A far goal is worth the flight only to a safe spot that saves a good walk; one out of reach on foot, to the
      // clearest spot there is.
      const saves = lz && Math.hypot(c[0] - tx, c[1] - tz) - Math.hypot(lz.at[0] - tx, lz.at[1] - tz) >= AI_AIRLIFT_M / 2;
      if (lz && (unreachable || (lz.safe && saves)) && this.match.airliftSquad(squad, lz.at[0], lz.at[1])) {
        this.lifts.set(squad, [tx, tz]);
        return;
      }
    }
    this.match.moveSquad(squad, tx, tz, retreat);
  }
}
