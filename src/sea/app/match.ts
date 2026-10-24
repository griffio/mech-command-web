// Advance and Secure, after the game Squad: a lane of capture points taken in order, a ticket pool per side, squads
// that respawn and refit at their side's base, and fog of war. Rules of this project's own (scenarios/*.json), on top of
// MC2's combat.
//
// Points: the first side holds the lane from its end (points 0, 1, ...), the second from the other. A side can take
// only the first point beyond the ones it holds; standing in a point's circle with nobody from the other side there
// moves it toward you (an enemy's point goes neutral first, losing its owner tickets). Tickets go with every unit lost
// and every point lost; a side loses when its tickets run out, or when the other side holds every point.
//
// Infantry are slow and keep to land: a Karnov airlifts them (airlift.ts). Infantry that stand still a while dig in
// behind sandbags, and are much harder to hit.
import type { Scenario, ScenarioSide } from '../../assets';
import { PLAYER_PAINT, paintFromMission, type PaintScheme } from '../../paint.ts';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import { bestRange } from '../sim/combat';
import { Airlift } from './airlift';
import { Squad } from './squads';
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
/** Bodies are cleared after this; wrecks after the second. */
const CLEAR_INFANTRY_S = 4;
const CLEAR_WRECK_S = 150;

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
  time = 0;
  /** AI commanders, by team (the player's side has none, unless a test adds one). */
  readonly commanders = new Map<number, CommanderAI>();
  readonly airlift: Airlift;
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
    this.sides = scenario.sides.map((s) => ({
      team: s.team,
      name: s.name,
      tickets: scenario.tickets,
      base: s.base,
      paint: s.team === PLAYER_TEAM ? PLAYER_PAINT : paintFromMission(s.colors ?? ['#7a7a7a', '#c8c8c8', '#303030']),
      squads: s.squads.map((q, i) => new Squad(s.team, String.fromCharCode(65 + i), q)),
      spec: s,
    }));
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
    for (const p of match.points) {
      match.pointRings.push(world.addMarker(match.ringModels.get(`${match.pointRings.length}:none`)!, p.x, p.z, 1));
      match.pointFlags.push(null);
    }
    match.points.forEach((_, i) => match.showOwner(i));
    for (const side of match.sides) {
      const ring = await world.markerRing(RING_COLOR[String(side.team)]!, side.base.x, side.base.z, BASE_RADIUS);
      world.addMarker(ring, side.base.x, side.base.z, 1);
      await Promise.all(side.squads.map((squad, i) => match.deploy(side, squad, i)));
    }
    world.battle.onDestroyed = (u) => match.lost(u);
    world.battle.judgeOutcome = false;
    match.commanders.set(1, new CommanderAI(match, world, 1));
    return match;
  }

  side(team: number): Side {
    return this.sides.find((s) => s.team === team)!;
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
    this.capture(dt);
    this.garrison(dt);
    this.supply(dt);
    this.clearDead();
    this.fog();
    for (const ai of this.commanders.values()) ai.update();
    this.judge();
  }

  /** A unit died: its side pays for it in tickets. */
  private lost(u: SeaUnit): void {
    this.dead.set(u, this.time);
    const side = this.sides.find((s) => s.team === u.team);
    if (side) side.tickets -= ticketCost(u);
  }

  private capture(dt: number): void {
    const counts = this.points.map(() => [0, 0] as [number, number]);
    for (const u of this.world.units) {
      if (!u.alive || !u.combat || u.embarked || (u.team !== 0 && u.team !== 1)) continue;
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
      }
      if (p.owner !== null) this.onEvent(`${this.side(p.owner).name} captured ${p.name}`, p.owner);
    });
  }

  /** Fly a squad of infantry to a point, if the airlift can; false if it can't (it has no Karnov, or is flying). */
  airliftSquad(squad: Squad, x: number, z: number): boolean {
    if (!squad.isInfantry || !this.airlift.available || squad.airborne) return false;
    const side = this.side(squad.team);
    void this.airlift.request(squad, side.base, side.paint, x, z);
    if (squad.team === PLAYER_TEAM) this.onEvent(`${squad.name}: the Karnov is on its way`, squad.team);
    return true;
  }

  /** Infantry that have stood still a while dig in behind sandbags; moving off (or boarding) gives it up. */
  private garrison(dt: number): void {
    for (const side of this.sides) {
      for (const squad of side.squads) {
        const alive = squad.alive;
        const still = squad.isInfantry && !squad.airborne && alive.every((u) => !u.route.length && !u.embarked);
        squad.stillFor = still ? squad.stillFor + dt : 0;
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

  /** Wiped-out squads come back after a while; squads at their base get their missing members back and refit. */
  private supply(dt: number): void {
    for (const side of this.sides) {
      side.squads.forEach((squad, i) => {
        const alive = squad.alive;
        if (!alive.length && this.spawning === 0) {
          if (squad.respawnAt === null) {
            squad.respawnAt = this.time + (squad.spec.units.some((t) => this.world.typeKind(t) === 'mech') ? RESPAWN_S.mech : RESPAWN_S.other);
          } else if (this.time >= squad.respawnAt) {
            squad.respawnAt = null;
            void this.deploy(side, squad, i);
            this.onEvent(`${side.name}: squad ${squad.name} back at base`, side.team);
          }
          return;
        }
        const atBase = alive.length > 0 && alive.every((u) => Math.hypot(u.x - side.base.x, u.z - side.base.z) <= BASE_RADIUS);
        if (!atBase) return;
        for (const u of alive) u.combat?.refit(dt, REFIT_RATE);
        if (squad.missing > 0 && this.time >= squad.reinforceAt && this.spawning === 0) {
          squad.reinforceAt = this.time + REINFORCE_S;
          void this.deploy(side, squad, i, 1);
        }
      });
    }
  }

  /** Spawn a squad's missing members (or `limit` of them) at its side's base, in its formation's place. */
  private async deploy(side: Side, squad: Squad, index: number, limit = Infinity): Promise<void> {
    const types = squad.spec.units.slice();
    for (const u of squad.alive) {
      const k = types.indexOf(u.typeKey ?? '');
      if (k >= 0) types.splice(k, 1);
    }
    const toward = this.points[side.team === 0 ? 0 : this.points.length - 1]!;
    const facing = bearing(side.base, toward);
    // Squads stand side by side across the base, facing the lane.
    const across = ((facing + 90) * Math.PI) / 180;
    const offset = (index - (side.squads.length - 1) / 2) * 34;
    const cx = side.base.x + Math.sin(across) * offset;
    const cz = side.base.z + Math.cos(across) * offset;
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
    // Aircraft (no stats) are seen from afar.
    for (const u of this.world.units) u.hidden = u.team !== PLAYER_TEAM && u.alive && !!u.combat && !seen.has(u);
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

/** What losing a unit costs its side: a mech by its weight, power armour two, a soldier or a vehicle less. */
function ticketCost(u: SeaUnit): number {
  const stats = u.combat?.stats;
  if (u.kind === 'mech') return Math.max(4, Math.round((stats?.tonnage ?? 40) / 10));
  if (u.kind === 'infantry') return (stats?.tonnage ?? 1) > 2 ? 2 : 1;
  return 3;
}

/**
 * A simple commander for a side: most squads go for the point it can take next, the rest hold the point it must keep,
 * fire-support squads stand off behind the attack, and squads that have lost most of their strength fall back to
 * the base to reinforce and refit.
 */
export class CommanderAI {
  private nextThink = 0;

  constructor(
    private readonly match: Match,
    private readonly world: World,
    readonly team: number,
  ) {}

  update(): void {
    if (this.match.time < this.nextThink) return;
    this.nextThink = this.match.time + 5;
    const side = this.match.side(this.team);
    const target = this.match.capturable(this.team);
    const hold = this.match.frontier(this.team);
    const squads = side.squads.filter((q) => q.alive.length && q.respawnAt === null);
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
        const standOff = squad.alive.every((u) => u.combat && bestRange(u.combat.weapons) >= 150) ? 130 : 0;
        const d = Math.hypot(side.base.x - p.x, side.base.z - p.z) || 1;
        const x = p.x + ((side.base.x - p.x) / d) * standOff;
        const z = p.z + ((side.base.z - p.z) / d) * standOff;
        this.send(squad, index, x, z, false);
      });
  }

  /**
   * Order a squad to a place, unless it already has that job and is there or on its way. Infantry fly to goals they
   * can't reach on foot, or that are far.
   */
  private send(squad: Squad, assignment: number, x: number, z: number, retreat: boolean): void {
    const c = squad.centroid();
    const busy = squad.alive.some((u) => u.route.length || u.attackOrder);
    if (squad.assignment === assignment && (busy || (c && Math.hypot(c[0] - x, c[1] - z) < 45))) return;
    squad.assignment = assignment;
    const [tx, tz] = [x + (Math.random() - 0.5) * 30, z + (Math.random() - 0.5) * 30];
    const far = c && Math.hypot(c[0] - tx, c[1] - tz) > AI_AIRLIFT_M;
    const unreachable = c && this.world.grids && !this.world.grids.ground.connected(c[0], c[1], tx, tz);
    // Falling back flies only when there's no way home on foot.
    if (squad.isInfantry && (unreachable || (far && !retreat)) && this.match.airliftSquad(squad, tx, tz)) return;
    squad.move(this.world, tx, tz, retreat);
  }
}
