// The fighting on the WebGPU page, on MC2's rules (sim/combat.ts): every quarter second each unit picks a target, keeps
// to the distance it fights best from, and fires every weapon that is loaded, in range, in sight and pointing the right
// way. Shots fly as they do in MC2 (lasers at once, shells and missiles at their speeds) and do their damage when they
// land. Destroyed units fall, blow up and burn.
import type { CombatEffects } from '../render/fx/combat-effects';
import type { Blast, MechLocation, StrikeStats, WeaponDef } from '../../assets';
import { ATTACK_RADIUS, COMBAT_TICK, FIRE_ARC, arcOf, bestRange, inRange, maxRange, type Arc, type HitReport, type WeaponMount } from '../sim/combat';
import { Rng } from '../sim/rng';
import { aimShare, settle, suppress, SUPPRESSION } from './suppression';
import type { Squad } from './squads';
import { PLAYER_TEAM, bearing, wrapDegrees, type SeaUnit, type World } from './world';

type V3 = [number, number, number];

const NOTHING_SEEN: ReadonlySet<SeaUnit> = new Set();

/**
 * MC2's attack movement (MechWarrior's movement update, code/warrior.cpp; Mover::calcMoveGoal, code/mover.cpp): once a
 * second a unit fighting looks at how far it is from its target. Further than a terrain vertex (25.6 m) either way from
 * the distance it wants to fight from (bestRange), or out of sight of the target, it goes to a spot on a ring at that
 * distance about the target: too far, it closes; too near, it backs off.
 */
const KEEP_RANGE_M = 25.6;
/** Seconds between a unit's looks (gamesys MovementUpdateFrequency). */
const MOVE_UPDATE_S = 1;
/** Spots on the ring it chooses among, and the movement-map cell MC2's goal map scores them by, metres. */
const RING_SPOTS = 16;
const CELL_M = 8.53;
/** This project's addition to the goal map: a spot it can see the target from is worth this many cells' walk. */
const SPOT_SIGHT_CELLS = 25;
/**
 * MC2's enemy AI keeps moving while it fights (MechWarrior keepMoving; off for the player's units): at range, it walks to
 * another spot on the ring, with a 60% chance each second. Calmer here: after a pause, a step part of the way round the
 * ring, mostly the same way as the last, so it circles its target.
 */
const CIRCLE_PAUSE_S: [number, number] = [1.5, 4];
const CIRCLE_STEP_DEG: [number, number] = [25, 60];
const CIRCLE_TURN_BACK = 0.25;
/** MC2 scores its spots at random when it moves on like this; here up to this many cells' walk, so steps vary. */
const CIRCLE_RANDOM_CELLS = 5;
/** At most this many route searches each combat tick (a long one costs 10-20 ms); a straight walk needs none. */
const ROUTES_PER_TICK = 2;
/** Seconds a wreck burns. */
const BURN_S = 40;
/** An AI unit chases only targets within this of where its squad was sent, metres. */
const LEASH_M = 180;
/**
 * The scenarios' rule (MC2 has none: only gunnery counts): soldiers are hard to hit, power armour less so, and woods
 * make infantry harder still. Shares of the firer's gunnery.
 */
const INFANTRY_HIT = { trooper: 0.5, armoured: 0.7, cover: 0.6, dugIn: 0.6 };
/** Seconds between puffs of a missile's smoke trail. */
const SMOKE_INTERVAL_S = 0.04;
/** Flight speeds, metres a second (the original's bolt files); lasers and PPCs are instant. */
const SPEED = { autocannon: 550, heavyAutocannon: 500, mg: 900, srm: 200, lrm: 250 };

/** Where on a mech each weapon location fires from, and where a hit to each armour location shows. */
const MOUNT_NODE: Record<MechLocation, string> = {
  HD: 'cockpit', CT: 'weapon_centertorso', LT: 'weapon_lefttorso', RT: 'weapon_righttorso', LA: 'weapon_leftarm', RA: 'weapon_rightarm',
  LL: 'joint_llleg', RL: 'joint_rlleg',
};
const HIT_NODE: Record<string, string> = {
  'head': 'cockpit', 'centre torso': 'weapon_centertorso', 'rear centre torso': 'weapon_centertorso', 'left torso': 'weapon_lefttorso',
  'rear left torso': 'weapon_lefttorso', 'right torso': 'weapon_righttorso', 'rear right torso': 'weapon_righttorso',
  'left arm': 'weapon_leftarm', 'right arm': 'weapon_rightarm', 'left leg': 'joint_llleg', 'right leg': 'joint_rlleg',
};

/** Who did the damage: a unit, or a strike a side called in (which has no unit of its own). */
export interface Attacker {
  team: number;
  name: string;
  x: number;
  z: number;
  squad?: Squad | null;
}

/** A sound the fight makes, and where (the battle's sounds pick MC2's for it). */
export type Noise =
  | { kind: 'fire'; weapon: number; at: V3; by: SeaUnit }
  | { kind: 'impact'; weapon: number; at: V3; on: SeaUnit; by: SeaUnit }
  | { kind: 'blast'; blast: Blast; at: V3; on: SeaUnit }
  /** A helicopter taking off (`up`) or setting down. */
  | { kind: 'lift'; up: boolean; at: V3; on: SeaUnit }
  /** A strike on its way (5.5 s out, as the engine plays it), and each of its bursts as it lands. */
  | { kind: 'incoming' | 'burst'; at: V3 }
  /** A VTOL flying support in (and out again), and setting it down (`drop`). */
  | { kind: 'vtol'; drop: boolean; at: V3 };

/** The arcs a strike's hits come from: any side, at random. */
const ARCS: Arc[] = ['front', 'left', 'right', 'rear'];
/** The scenarios' rule: dug-in soldiers take this share of a strike's damage (they're behind sandbags). */
const STRIKE_DUG_IN = 0.5;
/** A strike's burst suppresses as a shot of this much damage (suppression.ts gives strikes their own reach). */
const BURST_SUPPRESSION = { kind: 'missile', damage: 10, name: 'strike' } as const;
/**
 * The scenarios' rule (MC2's guns fire regardless): a Long Tom holds fire while any of its own side is within this of
 * where its shell would burst, beyond the burst's own reach, metres.
 */
const AREA_CLEAR_M = 10;
/** How high a Long Tom's shell climbs (its bolt's ArcEffect), metres: this, and a share of the distance. */
const SHELL_LOFT_M = 15;
const SHELL_LOFT_SHARE = 0.3;

/** Damage on its way: it lands at `at` (game time) unless its target is already gone. */
interface Payload {
  at: number;
  weapon: WeaponMount['def'];
  attacker: SeaUnit;
  target: SeaUnit;
  /** Null for a miss. */
  location: string | null;
  damage: number;
  point: V3;
  /** Show the impact when it lands (shells); lasers and missiles draw their own. */
  impact: boolean;
  /** How big the impact looks (1 = an average hit). */
  scale: number;
}

/**
 * A missile in flight, drawn each frame. A rack's lead missile carries the rack's payload, trails the smoke and makes the
 * impact; the rest of the rack fly beside it with their heads alight.
 */
interface Missile {
  from: V3;
  to: V3;
  launch: number;
  arrive: number;
  /** Height of its arc above the straight line, metres (LRMs loft, SRMs fly flat). */
  loft: number;
  payload: Payload | null;
  hit: boolean;
  lead: boolean;
  /** Game time of its next puff of smoke (lead missiles only). */
  smokeAt: number;
  /** A Long Tom's shell (an area-effect weapon's): it bursts where it lands, on whoever is about. */
  shell?: { weapon: WeaponDef; by: SeaUnit; target: SeaUnit };
}

interface Wreck {
  unit: SeaUnit;
  since: number;
  nextPuff: number;
  drawn: boolean;
}

export class Battle {
  time = 0;
  /** 'won' when every enemy is destroyed, 'lost' when every one of the player's mechs is. */
  outcome: 'won' | 'lost' | null = null;
  /** Things worth telling the player: kills, lost limbs, the outcome. */
  onEvent: (text: string, team: number) => void = () => {};
  /** Shots land and show, but do no damage (the battle survey's steady fight). */
  immortal = false;
  /** Called when a unit is destroyed, and by whom (a match charges its side tickets, and the radio reports kills). */
  onDestroyed: (u: SeaUnit, by: Attacker) => void = () => {};
  /** Called when a shot damages a unit that survives it (the radio: under attack). */
  onHit: (u: SeaUnit, by: Attacker) => void = () => {};
  /** Called for each weapon fired, shot landed and unit blown up (the battle's sounds). */
  onNoise: (n: Noise) => void = () => {};
  /** Decide the battle when one side is wiped out (a match decides its own). */
  judgeOutcome = true;
  private tickIn = 0;
  private routes = 0;
  private readonly rng = new Rng(0x4d433221);
  private readonly payloads: Payload[] = [];
  private readonly missiles: Missile[] = [];
  private readonly wrecks: Wreck[] = [];
  /** Enemies each team sees (any of its units in sight of them). */
  private readonly seen = new Map<number, Set<SeaUnit>>();
  /** Whom each unit sees itself. */
  private readonly sight = new Map<SeaUnit, Set<SeaUnit>>();
  /** When each unit fighting next looks at where it stands (see KEEP_RANGE_M). */
  private readonly nextMove = new Map<SeaUnit, number>();
  /** When each enemy unit at range next steps round its target, and which way it's going round (1 or -1). */
  private readonly circleAt = new Map<SeaUnit, number>();
  private readonly orbit = new Map<SeaUnit, number>();
  private readonly nextSmoke = new Map<SeaUnit, number>();
  /** Each helicopter's flight as of the last tick (see lifting). */
  private readonly flights = new Map<SeaUnit, SeaUnit['flight']>();

  constructor(
    private readonly world: World,
    private readonly fx: CombatEffects,
  ) {}

  update(dt: number): void {
    this.time += dt;
    this.tickIn -= dt;
    if (this.tickIn <= 0) {
      this.tickIn += COMBAT_TICK;
      this.tick();
    }
    this.land();
    this.fly();
    this.burn();
    settle(this.world.units, dt, this.time);
  }

  /** Forget shots in flight, routes and the outcome (the battle survey restages the fight). */
  reset(): void {
    this.payloads.length = 0;
    this.missiles.length = 0;
    this.seen.clear();
    this.sight.clear();
    this.nextMove.clear();
    this.circleAt.clear();
    this.flights.clear();
    this.outcome = null;
    this.tickIn = 0;
  }

  /** Shells, missiles and wrecks in play (for the battle survey). */
  get counts(): { shells: number; missiles: number; wrecks: number } {
    return { shells: this.payloads.length, missiles: this.missiles.length, wrecks: this.wrecks.length };
  }

  /** Enemies a team's units see (as of the last combat tick). */
  seenBy(team: number): ReadonlySet<SeaUnit> {
    return this.seen.get(team) ?? NOTHING_SEEN;
  }

  /** Does `a` see `b` (as of the last combat tick)? */
  sees(a: SeaUnit, b: SeaUnit): boolean {
    return this.sight.get(a)?.has(b) ?? false;
  }

  private tick(): void {
    const units = this.world.units.filter((u) => u.alive && u.combat && !u.embarked);
    this.look(units);
    this.routes = 0;
    for (const u of units) {
      if (u.flies) this.lifting(u);
      // Nothing to shoot with (a truck, an APC, a tent): nothing to aim at.
      if (u.combat!.weapons.length) this.chooseTarget(u);
      else u.target = null;
      this.close(u);
      this.shoot(u);
    }
    this.judge();
  }

  /**
   * Who sees whom: within its sight range (a scout's is longer: SeaUnit.sightRange), with no ground in between. A team
   * shares what its units see.
   */
  private look(units: SeaUnit[]): void {
    this.seen.clear();
    this.sight.clear();
    for (const u of units) {
      this.sight.set(u, new Set());
      if (!this.seen.has(u.team)) this.seen.set(u.team, new Set());
    }
    const terrain = this.world.terrain;
    const reach = units.map((u) => u.sightRange);
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (a.team === b.team || d > Math.max(reach[i]!, reach[j]!)) continue;
        if (terrain.blocked(a.x, a.eyeY, a.z, b.x, b.eyeY, b.z)) continue;
        // A wall is seen, but keeps no lookout.
        if (!a.wall && d <= reach[i]!) {
          this.sight.get(a)!.add(b);
          this.seen.get(a.team)!.add(b);
        }
        if (!b.wall && d <= reach[j]!) {
          this.sight.get(b)!.add(a);
          this.seen.get(b.team)!.add(a);
        }
      }
    }
  }

  /**
   * A helicopter taking off or setting down raises dust under it (spray over water: MC2's helicopter dust cloud) and is
   * heard as it starts.
   */
  private lifting(u: SeaUnit): void {
    const was = this.flights.get(u);
    this.flights.set(u, u.flight);
    if (u.flight !== 'takingOff' && u.flight !== 'landing') return;
    const ground = this.world.terrain.heightAt(u.x, u.z);
    const at: V3 = [u.x, Math.max(ground, 0), u.z];
    this.fx.groundHit(at, 1.1, ground < 0);
    if (was !== undefined && was !== u.flight) this.onNoise({ kind: 'lift', up: u.flight === 'takingOff', at, on: u });
  }

  /** An ordered target, else the one it has while it's still seen and near enough, else the nearest enemy seen. */
  private chooseTarget(u: SeaUnit): void {
    // An attack order on a unit that falls passes to the nearest of its squadmates the side can see.
    if (u.attackOrder && !u.attackOrder.alive) u.attackOrder = this.nextInSquad(u, u.attackOrder);
    if (u.attackOrder) {
      u.target = u.attackOrder;
      return;
    }
    const seen = this.seen.get(u.team);
    // Walls are shot at only when a unit is ordered to. One that can't move (an artillery piece, a turret) looks only
    // at what its weapons reach from where it stands (the Long Tom can't fire under 60 m).
    const reach = (d: number) => !u.immobile || u.combat!.weapons.some((w) => inRange(w.def.range, d));
    const near = (t: SeaUnit) => {
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      return t.alive && !t.wall && !!seen?.has(t) && d <= ATTACK_RADIUS && reach(d);
    };
    if (u.target && near(u.target)) return;
    let best: SeaUnit | null = null;
    let bestD = Infinity;
    for (const t of seen ?? []) {
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      if (d < bestD && near(t)) {
        best = t;
        bestD = d;
      }
    }
    u.target = best;
  }

  private nextInSquad(u: SeaUnit, fallen: SeaUnit): SeaUnit | null {
    const seen = this.seen.get(u.team);
    let best: SeaUnit | null = null;
    for (const m of fallen.squad?.alive ?? []) {
      if (seen?.has(m) && (!best || Math.hypot(m.x - u.x, m.z - u.z) < Math.hypot(best.x - u.x, best.z - u.z))) best = m;
    }
    return best;
  }

  /**
   * Units under an attack order, and every enemy unit with a target near where its squad was sent (or within its reach on
   * the way there), fight from the distance they want to (see KEEP_RANGE_M), and the enemy's circle their targets (those
   * that can turn their guns). The player's other units hold where they are (or keep to the route they were given) and
   * fire at what comes into range.
   */
  private close(u: SeaUnit): void {
    if (u.immobile || u.pinned) return; // turrets, tents and artillery pieces stay put; pinned soldiers stay down
    const t = u.target;
    const combat = u.combat!;
    const range = bestRange(combat);
    if (!t || !range || !this.hunting(u, t)) {
      if (u.engaging) u.stop();
      this.circleAt.delete(u);
      return;
    }
    if (u.route.length && !u.engaging) {
      // Walking where it was sent: the player's units carry on, firing as they pass, and so do the enemy's falling back.
      // The enemy's others stop to fight what they meet within reach (MC2's alarms turn a move into an attack).
      if (!this.aiRun(u) || u.squad?.order.kind === 'retreat' || !this.within(u, t)) return;
      u.stop();
    }
    if (this.time < (this.nextMove.get(u) ?? 0)) return;
    this.nextMove.set(u, this.time + MOVE_UPDATE_S);
    const end = u.engaging ? u.route[u.route.length - 1] : undefined;
    let spot: [number, number] | null;
    if (end) {
      // On its way to a spot: carry on while that's still about the right distance from the target.
      if (Math.abs(Math.hypot(end[0] - t.x, end[1] - t.z) - range) <= KEEP_RANGE_M) return;
      spot = this.ringSpot(u, t, range);
    } else if (Math.abs(Math.hypot(t.x - u.x, t.z - u.z) - range) <= KEEP_RANGE_M && this.sees(u, t)) {
      // At range: the player's units hold, the enemy's step round the target after a pause; but not one whose guns
      // face only ahead (no turret or torso to turn), which can't fire while it drives across the target's front.
      if (!this.aiRun(u) || !u.twistLimit) return;
      const at = this.circleAt.get(u);
      if (at === undefined) this.circleAt.set(u, this.time + CIRCLE_PAUSE_S[0] + Math.random() * (CIRCLE_PAUSE_S[1] - CIRCLE_PAUSE_S[0]));
      if (at === undefined || this.time < at) return;
      spot = this.circleSpot(u, t, range);
    } else spot = this.ringSpot(u, t, range);
    if (spot) this.walk(u, spot);
  }

  /** Whether a unit goes after its target: on an attack order; or the enemy's, near where it was sent or within reach. */
  private hunting(u: SeaUnit, t: SeaUnit): boolean {
    if (u.attackOrder) return true;
    // A scout keeps its distance: it fires at what comes near, and goes after it only when ordered.
    if (!this.aiRun(u) || u.squad?.support === 'scout') return false;
    const leashed = !u.leash || Math.hypot(t.x - u.leash.x, t.z - u.leash.z) <= LEASH_M;
    return leashed || (u.squad?.order.kind !== 'retreat' && this.within(u, t));
  }

  /**
   * The AI runs its side, so it fights by the AI's rules above: the enemy's units, and the player's when a test gives
   * their side an AI commander too (so a match the AI plays against itself is a fair one).
   */
  private aiRun(u: SeaUnit): boolean {
    return u.team !== PLAYER_TEAM || (this.world.match?.commanders.has(u.team) ?? false);
  }

  /** The target is in sight and within reach of the unit's weapons. */
  private within(u: SeaUnit, t: SeaUnit): boolean {
    return this.sees(u, t) && Math.hypot(t.x - u.x, t.z - u.z) <= maxRange(u.combat!);
  }

  /**
   * A spot on the ring at `range` about a target to fight it from, scored as MC2's goal map scores cells: somewhere
   * other than where the unit stands, a point off for each cell further from it, a hundred off where a squadmate is
   * going; and (this project's) a good deal for seeing the target from there. Only open ground it can walk to. `arc`
   * keeps to bearings from the target between two angles (degrees), each spot scored a little at random. With no spot,
   * the open ground nearest the ring's near side.
   */
  private ringSpot(u: SeaUnit, t: SeaUnit, range: number, arc?: [number, number]): [number, number] | null {
    const grid = this.world.gridFor(u);
    const terrain = this.world.terrain;
    const eye = u.eyeY - terrain.heightAt(u.x, u.z);
    const mates = (u.squad?.alive ?? []).filter((m) => m !== u).map((m) => m.route[m.route.length - 1] ?? [m.x, m.z]);
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < RING_SPOTS; i++) {
      const a = (((arc ? arc[0] + ((arc[1] - arc[0]) * i) / (RING_SPOTS - 1) : (360 * i) / RING_SPOTS) * Math.PI) / 180);
      const x = t.x + Math.sin(a) * range;
      const z = t.z + Math.cos(a) * range;
      const away = Math.hypot(x - u.x, z - u.z);
      if (away < CELL_M) continue;
      if (grid && (!grid.open(...grid.cellOf(x, z)) || !grid.connected(u.x, u.z, x, z))) continue;
      let score = -away / CELL_M;
      if (mates.some(([mx, mz]) => Math.hypot(mx - x, mz - z) < CELL_M * 1.5)) score -= 100;
      if (!terrain.blocked(x, terrain.heightAt(x, z) + eye, z, t.x, t.eyeY, t.z)) score += SPOT_SIGHT_CELLS;
      if (arc) score += Math.random() * CIRCLE_RANDOM_CELLS;
      if (score > bestScore) {
        best = [x, z];
        bestScore = score;
      }
    }
    if (best || arc) return best;
    const d = Math.hypot(u.x - t.x, u.z - t.z) || 1;
    const near = this.world.openNear(t.x + ((u.x - t.x) / d) * range, t.z + ((u.z - t.z) / d) * range, u.moveClass);
    return !grid || grid.connected(u.x, u.z, near[0], near[1]) ? near : null;
  }

  /** The enemy's step round its target: part of the way round the ring, mostly the way it went last time. */
  private circleSpot(u: SeaUnit, t: SeaUnit, range: number): [number, number] | null {
    let way = this.orbit.get(u) ?? (Math.random() < 0.5 ? 1 : -1);
    if (Math.random() < CIRCLE_TURN_BACK) way = -way;
    const from = bearing(t, u);
    for (const w of [way, -way]) {
      const spot = this.ringSpot(u, t, range, [from + w * CIRCLE_STEP_DEG[0], from + w * CIRCLE_STEP_DEG[1]]);
      if (!spot) continue;
      this.orbit.set(u, w);
      return spot;
    }
    return null;
  }

  /** Walk a fighting unit to a spot (a search for a route around what's in the way waits its turn). */
  private walk(u: SeaUnit, [x, z]: [number, number]): void {
    const grid = this.world.gridFor(u);
    if (grid && !grid.straight(u.x, u.z, x, z)) {
      if (this.routes >= ROUTES_PER_TICK) {
        this.nextMove.set(u, this.time + COMBAT_TICK);
        return;
      }
      this.routes++;
    }
    const route = grid ? grid.findPath(u.x, u.z, x, z) : [[x, z] as [number, number]];
    if (!route) return;
    u.walkTo(route);
    u.engaging = true;
    this.circleAt.delete(u);
  }

  /**
   * Fire every weapon that can: loaded, in range, in sight (an LRM may use a teammate's), and aimed at the target. A
   * helicopter fires only in the air.
   */
  private shoot(u: SeaUnit): void {
    const t = u.target;
    const combat = u.combat!;
    if (!t || !t.alive || u.grounded) return;
    if (Math.abs(wrapDegrees(bearing(u, t) - u.aimYaw)) > FIRE_ARC) return;
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    const own = this.sees(u, t);
    const spotted = this.seen.get(u.team)?.has(t) ?? false;
    for (const w of combat.weapons) {
      if (!combat.ready(w, this.time) || !inRange(w.def.range, d)) continue;
      if (!own && !(w.def.indirect && spotted)) continue;
      if (w.def.area && this.friendsNear(u.team, t.x, t.z, w.def.area.radius + AREA_CLEAR_M)) continue;
      const hit = combat.fire(w, this.time, this.rng, this.hitModifier(t) * aimShare(u));
      this.launch(u, t, w, hit, d);
    }
  }

  /** The look of one shot, and its damage on the way. A Streak that misses never launches. */
  private launch(u: SeaUnit, t: SeaUnit, w: WeaponMount, hit: boolean, distance: number): void {
    const def = w.def;
    if (!hit && def.streak) return;
    const location = hit ? t.combat!.hitLocation(arcOf(t.x, t.z, t.rotation, u.x, u.z), this.rng) : null;
    const point = location ? this.hitPoint(t, location) : this.missPoint(t);
    const from = this.muzzle(u, w);
    this.onNoise({ kind: 'fire', weapon: def.id, at: from, by: u });
    const scale = Math.min(Math.max(def.damage / 4, 0.4), 2);
    const payload = (at: number, impact: boolean): Payload => ({ at, weapon: def, attacker: u, target: t, location, damage: def.damage, point, impact, scale });
    const name = def.name.toLowerCase();
    if (def.area) {
      // A Long Tom's shell, lobbed high and slow at the target, which it follows: it bursts where it lands, hit or miss.
      this.fx.muzzleFlash(from, 2);
      const arrive = this.time + (distance * 1.1) / def.area.speed;
      const shell = { weapon: def, by: u, target: t };
      this.missiles.push({ from, to: point, launch: this.time, arrive, loft: SHELL_LOFT_M + distance * SHELL_LOFT_SHARE, payload: null, hit, lead: true, smokeAt: this.time, shell });
    } else if (def.kind === 'energy') {
      if (name.includes('ppc')) this.fx.ppc(from, point, hit);
      else this.fx.laser(from, point, laserColor(def.id), name.includes('large') ? 0.9 : 0.55, hit);
      if (!hit) this.fx.groundHit(point, 0.5, this.world.terrain.heightAt(point[0], point[2]) < 0);
      this.payloads.push(payload(this.time, false));
    } else if (def.kind === 'ballistic') {
      const mg = name.includes('mg');
      const speed = mg ? SPEED.mg : name.includes('heavy') ? SPEED.heavyAutocannon : SPEED.autocannon;
      this.fx.muzzleFlash(from, mg ? 0.5 : 1.2 * scale);
      for (let i = 0; i < (mg ? 3 : 1); i++) {
        const to: V3 = mg ? [point[0] + this.jitter(0.8), point[1] + this.jitter(0.8), point[2] + this.jitter(0.8)] : point;
        this.fx.tracer(from, to, speed, undefined, mg ? 0.35 : 0.6 + 0.3 * scale);
      }
      this.payloads.push(payload(this.time + distance / speed, true));
    } else {
      // A rack fires one hit roll and one lot of damage; its missiles are for the eye.
      const lrm = def.indirect;
      const count = lrm ? 5 : 2;
      const speed = lrm ? SPEED.lrm : SPEED.srm;
      for (let i = 0; i < count; i++) {
        const spread = hit ? 1.2 : 4;
        const to: V3 = [point[0] + this.jitter(spread), point[1] + (hit ? this.jitter(1) : 0), point[2] + this.jitter(spread)];
        if (!hit) to[1] = Math.max(this.world.terrain.heightAt(to[0], to[2]), 0);
        const launch = this.time + i * 0.07;
        const arrive = launch + (distance * (lrm ? 1.15 : 1.02)) / speed;
        this.missiles.push({
          from: [from[0] + this.jitter(0.4), from[1] + this.jitter(0.4), from[2] + this.jitter(0.4)],
          to,
          launch,
          arrive,
          loft: lrm ? 8 + distance * 0.18 : 1 + this.rng.next() * 1.5,
          payload: i === 0 ? payload(arrive, false) : null,
          hit,
          lead: i === 0,
          smokeAt: launch,
        });
      }
    }
  }

  /** Damage whose time has come. */
  private land(): void {
    let w = 0;
    for (const p of this.payloads) {
      if (p.at > this.time) this.payloads[w++] = p;
      else this.strike(p);
    }
    this.payloads.length = w;
  }

  /** Move the missiles (heads alight, the leads trailing smoke), and blow up the ones that arrive. */
  private fly(): void {
    this.fx.beginUpdate();
    let w = 0;
    for (const m of this.missiles) {
      const t = m.shell?.target;
      if (t?.alive) m.to = [t.x, Math.max(this.world.terrain.heightAt(t.x, t.z), 0), t.z];
      if (this.time >= m.arrive && m.shell) {
        this.shellLands(m.shell, m.to);
        continue;
      }
      if (this.time >= m.arrive) {
        if (!m.lead) this.fx.pop(m.to);
        else if (m.hit) this.fx.hit(m.to, 0.7);
        else this.fx.groundHit(m.to, 0.7, this.world.terrain.heightAt(m.to[0], m.to[2]) < 0);
        if (m.payload) this.strike(m.payload);
        continue;
      }
      this.missiles[w++] = m;
      if (this.time < m.launch) continue;
      const f = (this.time - m.launch) / (m.arrive - m.launch);
      const x = m.from[0] + (m.to[0] - m.from[0]) * f;
      const y = m.from[1] + (m.to[1] - m.from[1]) * f + m.loft * 4 * f * (1 - f);
      const z = m.from[2] + (m.to[2] - m.from[2]) * f;
      this.fx.missileHead(x, y, z);
      if (m.lead && this.time >= m.smokeAt) {
        this.fx.missileSmoke(x, y, z);
        m.smokeAt = this.time + SMOKE_INTERVAL_S;
      }
    }
    this.missiles.length = w;
  }

  /** A shot lands: the impact, then the damage, and what that breaks. */
  private strike(p: Payload): void {
    const t = p.target;
    // A laser that misses hits nothing to hear.
    if (p.location || p.weapon.kind !== 'energy') this.onNoise({ kind: 'impact', weapon: p.weapon.id, at: p.point, on: t, by: p.attacker });
    // Hit or miss, it keeps heads down where it lands.
    suppress(this.world.units, p.weapon, p.point[0], p.point[2], p.attacker, this.time, this.world.grid);
    if (p.impact) {
      if (p.location) this.fx.hit(p.point, p.scale);
      else this.fx.groundHit(p.point, 0.5 * p.scale + 0.3, this.world.terrain.heightAt(p.point[0], p.point[2]) < 0);
    }
    if (!p.location || !t.alive || !t.combat || this.immortal) return;
    const report = t.combat.takeHit(p.location, p.damage, this.rng);
    if (!t.alive) this.destroyed(t, p.attacker, report);
    else {
      this.wounded(t, report, p.point);
      this.onHit(t, p.attacker);
    }
  }

  private wounded(t: SeaUnit, report: HitReport, point: V3): void {
    if (report.exploded) this.fx.explosion(point, 0.45);
    else if (report.destroyed.length) this.fx.explosion(point, 0.3);
    if (report.exploded || report.destroyed.length) this.onNoise({ kind: 'blast', blast: 'crit', at: point, on: t });
    if (report.destroyed.length && t.kind === 'mech') this.onEvent(`${t.name} lost its ${report.destroyed.join(' and ')}`, t.team);
  }

  private hitModifier(t: SeaUnit): number {
    if (t.kind !== 'infantry') return 1;
    const size = (t.combat?.stats.tonnage ?? 1) <= 1 ? INFANTRY_HIT.trooper : INFANTRY_HIT.armoured;
    const cover = this.world.grid?.forestAt(t.x, t.z) ? INFANTRY_HIT.cover : 1;
    return size * cover * (t.squad?.dugIn ? INFANTRY_HIT.dugIn : 1) * (t.pinned ? SUPPRESSION.prone : 1);
  }

  /**
   * A strike lands at (x, z) (code/artlry.cpp, ArtilleryType::handleCollision): every unit on the ground within its minor
   * range takes its minor number of hits, within its major range the major number, each of its damage, on the location
   * a hit from a side at random would land. Turrets and tents are hit only within the major range, aircraft not at all
   * (helicopters only on the ground). It hits friend and foe alike.
   */
  bombard(x: number, z: number, s: StrikeStats, by: Attacker): void {
    // Mines about it go off (code/artlry.cpp).
    this.world.match?.mines.setOff(x, z, s.minorRange);
    if (this.immortal) return;
    for (const t of [...this.world.units]) {
      if (!this.underBlast(t)) continue;
      const r = Math.hypot(t.x - x, t.z - z);
      if (r > s.minorRange || (t.kind === 'structure' && r > s.majorRange)) continue;
      const hits = r <= s.majorRange ? s.majorHits : s.minorHits;
      const damage = s.damage * (t.kind === 'infantry' && t.squad?.dugIn ? STRIKE_DUG_IN : 1);
      for (let i = 0; i < hits && t.alive; i++) this.harm(t, this.strikeLocation(t), damage, by);
    }
  }

  /**
   * A Long Tom's shell lands: it bursts on the target if it's still there (it followed it down), else where it was
   * going. Every unit on the ground within the burst's reach takes its damage, in hits of its explosion's chunk size,
   * each where a strike's hit would land (code/carnage.cpp, ExplosionType::handleCollision); friend and foe alike, and
   * dug-in soldiers half, as for a strike. Mines about it go off.
   */
  private shellLands(shell: NonNullable<Missile['shell']>, to: V3): void {
    const { weapon, by } = shell;
    const area = weapon.area!;
    const [x, z] = [to[0], to[2]];
    const ground = this.world.terrain.heightAt(x, z);
    const at: V3 = [x, Math.max(ground, 0) + 1.5, z];
    this.fx.explosion(at, 1.4);
    this.fx.groundHit(at, 1.4, ground < 0);
    this.onNoise({ kind: 'impact', weapon: weapon.id, at, on: shell.target, by });
    suppress(this.world.units, weapon, x, z, by, this.time, this.world.grid);
    this.world.match?.mines.setOff(x, z, area.radius);
    if (this.immortal) return;
    for (const t of [...this.world.units]) {
      if (!this.underBlast(t) || Math.hypot(t.x - x, t.z - z) > area.radius) continue;
      const damage = area.damage * (t.kind === 'infantry' && t.squad?.dugIn ? STRIKE_DUG_IN : 1);
      for (let left = damage; left > 0 && t.alive; left -= area.chunk) this.harm(t, this.strikeLocation(t), Math.min(area.chunk, left), by);
    }
  }

  /**
   * A mine goes off under a unit (code/mech.cpp, gvehicl.cpp mineCheck): its damage to a mech's legs (MC2's bottom hit
   * section: either leg), or a vehicle's front (or its turret, as a shot with nobody behind it lands).
   */
  mine(t: SeaUnit, damage: number, by: Attacker): void {
    const ground = this.world.terrain.heightAt(t.x, t.z);
    const at: V3 = [t.x, Math.max(ground, 0) + 1, t.z];
    this.fx.explosion(at, 0.6);
    this.fx.groundHit(at, 0.8, ground < 0);
    this.onNoise({ kind: 'blast', blast: 'mine', at, on: t });
    if (!t.alive || !t.combat || this.immortal) return;
    const location = t.kind === 'mech' ? (this.rng.next() < 0.5 ? 'LL' : 'RL') : t.combat.hitLocation('front', this.rng);
    this.harm(t, location, damage, by, false);
  }

  /** A mine set off by a blast, with nobody on it. */
  mineBurst(x: number, z: number): void {
    const ground = this.world.terrain.heightAt(x, z);
    const at: V3 = [x, Math.max(ground, 0) + 1, z];
    this.fx.explosion(at, 0.5);
    this.onNoise({ kind: 'burst', at });
  }

  /** Where a hit from no particular side lands (a strike's, a shell's burst): from a side at random. */
  private strikeLocation(t: SeaUnit): string {
    return t.combat!.hitLocation(ARCS[Math.floor(this.rng.next() * ARCS.length)]!, this.rng);
  }

  /** On the ground (or a helicopter parked there), where a blast reaches it. */
  private underBlast(t: SeaUnit): boolean {
    return t.alive && !!t.combat && !t.embarked && t.altitude <= 0 && !(t.flies && t.flight !== 'parked');
  }

  /** Damage to one location, and what comes of it; `heard` false keeps it off the radio's under-attack calls. */
  private harm(t: SeaUnit, location: string, damage: number, by: Attacker, heard = true): void {
    const report = t.combat!.takeHit(location, damage, this.rng);
    if (!t.alive) this.destroyed(t, by, report);
    else {
      this.wounded(t, report, [t.x, t.instance.center[1], t.z]);
      if (heard) this.onHit(t, by);
    }
  }

  /** One of a side's units on the ground is within this of a point. */
  private friendsNear(team: number, x: number, z: number, r: number): boolean {
    return this.world.units.some((f) => f.team === team && this.underBlast(f) && Math.hypot(f.x - x, f.z - z) <= r);
  }

  /** A unit is killed outright, by whoever did it (soldiers aboard an APC that's destroyed: carriers.ts). */
  kill(t: SeaUnit, by: Attacker): void {
    if (!t.alive || !t.combat || this.immortal) return;
    const report = t.combat.takeHit(t.combat.hitLocation('front', this.rng), 1e6, this.rng);
    if (!t.alive) this.destroyed(t, by, report);
  }

  /** One of a strike's bursts: the explosion, its sound, and heads down about it (everyone's: it's no one's shot). */
  burst(x: number, z: number, scale: number): void {
    const ground = this.world.terrain.heightAt(x, z);
    const at: V3 = [x, Math.max(ground, 0) + 1.5, z];
    this.fx.explosion(at, scale);
    this.fx.groundHit(at, scale, ground < 0);
    this.onNoise({ kind: 'burst', at });
    suppress(this.world.units, BURST_SUPPRESSION, x, z, { team: -1 }, this.time, this.world.grid);
  }

  /** A strike is on its way to (x, z): for the battle's sounds. */
  incoming(x: number, z: number): void {
    this.onNoise({ kind: 'incoming', at: [x, Math.max(this.world.terrain.heightAt(x, z), 0), z] });
  }

  /** A VTOL bringing support to (x, z), or setting it down there: for the battle's sounds. */
  vtol(x: number, z: number, drop: boolean): void {
    this.onNoise({ kind: 'vtol', drop, at: [x, Math.max(this.world.terrain.heightAt(x, z), 0), z] });
  }

  private destroyed(t: SeaUnit, by: Attacker, report: HitReport): void {
    t.die(arcOf(t.x, t.z, t.rotation, by.x, by.z) === 'front');
    this.world.unitDied(t);
    this.onDestroyed(t, by);
    for (const u of this.world.units) if (u.target === t) u.target = null;
    if (t.kind === 'infantry') {
      // A soldier just falls: a puff of dust where he stood, and no wreck (and no line in the log).
      this.fx.groundHit([t.x, t.instance.center[1] - 1, t.z], 0.35);
      return;
    }
    const at = t.nodePosition('weapon_centertorso') ?? [...t.instance.center];
    // A helicopter blows up as a vehicle does (code/mech.cpp: VEHICLE_EXPLOSION_ID).
    const mech = t.kind === 'mech' && !t.flies;
    this.fx.explosion(at, mech ? 1 : 0.75);
    this.onNoise({ kind: 'blast', blast: t.flies ? 'helicopter' : mech ? 'mech' : t.kind === 'structure' ? 'structure' : 'vehicle', at, on: t });
    this.flights.delete(t);
    if (report.exploded) this.fx.explosion(at, 0.8);
    this.wrecks.push({ unit: t, since: this.time, nextPuff: this.time + 0.3, drawn: false });
    const side = (u: { team: number }) => (u.team === PLAYER_TEAM ? '' : 'enemy ');
    this.onEvent(`${capital(side(by))}${by.name} destroyed ${side(t)}${t.name} (${t.combat!.dead})`, by.team);
  }

  /** Wrecks burn for a while (fiercely at first), and are redrawn as burnt-out hulks once they've fallen. */
  private burn(): void {
    // A wreck is forgotten once it's burnt out and drawn as a hulk.
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i]!;
      if (w.drawn && this.time - w.since > BURN_S) this.wrecks.splice(i, 1);
    }
    for (const w of this.wrecks) {
      if (!w.drawn && w.unit.fallen) {
        w.drawn = true;
        void this.world.makeWreck(w.unit);
      }
      const age = this.time - w.since;
      if (age > BURN_S || this.time < w.nextPuff) continue;
      w.nextPuff = this.time + 0.25;
      const c = w.unit.instance.center;
      this.fx.burning([c[0], c[1] - w.unit.size * 0.3, c[2]], 1.2 - (age / BURN_S) * 0.8);
    }
    // Live mechs that have lost much of their armour smoke.
    for (const u of this.world.units) {
      if (!u.alive || u.hidden || !u.combat || u.combat.integrity > 0.55 || this.time < (this.nextSmoke.get(u) ?? 0)) continue;
      this.nextSmoke.set(u, this.time + 0.35);
      const at = u.nodePosition('smoke_torso') ?? u.nodePosition('smoke_body') ?? u.nodePosition('joint_torso') ?? [...u.instance.center];
      this.fx.damaged(at, 1.4 - u.combat.integrity);
    }
  }

  /** Every enemy destroyed, or every one of the player's mechs. */
  private judge(): void {
    if (this.outcome || !this.judgeOutcome) return;
    const fighting = this.world.units.filter((u) => u.combat);
    if (!fighting.some((u) => u.team !== PLAYER_TEAM && u.alive)) this.outcome = 'won';
    else if (!fighting.some((u) => u.team === PLAYER_TEAM && u.kind === 'mech' && u.alive)) this.outcome = 'lost';
    if (this.outcome) this.onEvent(this.outcome === 'won' ? 'Every enemy is destroyed: mission complete' : 'Your lance is destroyed', PLAYER_TEAM);
  }

  private muzzle(u: SeaUnit, w: WeaponMount): V3 {
    const node = w.location ? u.nodePosition(MOUNT_NODE[w.location]) : null;
    if (node) return node;
    // A vehicle's guns: on top, toward where its turret points.
    const c = u.instance.center;
    const r = (u.aimYaw * Math.PI) / 180;
    const reach = u.size * 0.35;
    return [c[0] + Math.sin(r) * reach, c[1] + u.size * 0.2, c[2] + Math.cos(r) * reach];
  }

  private hitPoint(t: SeaUnit, location: string): V3 {
    const node = HIT_NODE[location];
    const p = node ? t.nodePosition(node) : null;
    if (p) return p;
    const c = t.instance.center;
    const r = t.size;
    return [c[0] + this.jitter(r * 0.2), c[1] + (location === 'turret' ? r * 0.25 : this.jitter(r * 0.1)), c[2] + this.jitter(r * 0.2)];
  }

  /** A miss lands on the ground about five metres from the target. */
  private missPoint(t: SeaUnit): V3 {
    const a = this.rng.next() * Math.PI * 2;
    const d = 4 + this.rng.next() * 4;
    const x = t.x + Math.cos(a) * d;
    const z = t.z + Math.sin(a) * d;
    return [x, Math.max(this.world.terrain.heightAt(x, z), 0), z];
  }

  private jitter(amount: number): number {
    return (this.rng.next() * 2 - 1) * amount;
  }
}

/** Laser colours by weapon: red, the ER lasers redder and violet, the large laser green (as MC2 draws them). */
function laserColor(id: number): V3 {
  switch (id) {
    case 140:
      return [0.25, 1, 0.35];
    case 143:
      return [1, 0.2, 0.4];
    case 152:
      return [0.8, 0.3, 1];
    default:
      return [1, 0.15, 0.1];
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
