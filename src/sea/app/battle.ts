// The fighting on the WebGPU page, on MC2's rules (sim/combat.ts): every quarter second each unit picks a target, closes
// on it if it must, and fires every weapon that is loaded, in range, in sight and pointing the right way. Shots fly as
// they do in MC2 (lasers at once, shells and missiles at their speeds) and do their damage when they land. Destroyed
// units fall, blow up and burn.
import type { CombatEffects } from '../render/fx/combat-effects';
import type { Blast, MechLocation } from '../../assets';
import { ATTACK_RADIUS, COMBAT_TICK, FIRE_ARC, SIGHT_RANGE, arcOf, bestRange, inRange, type HitReport, type WeaponMount } from '../sim/combat';
import { Rng } from '../sim/rng';
import { aimShare, settle, suppress, SUPPRESSION } from './suppression';
import { PLAYER_TEAM, bearing, wrapDegrees, type SeaUnit, type World } from './world';

type V3 = [number, number, number];

const NOTHING_SEEN: ReadonlySet<SeaUnit> = new Set();

/** Units close to this share of their best range before they stop to fight. */
const CLOSE_TO = 0.85;
/** At most this many route searches each combat tick (a long one costs 10-20 ms). */
const ROUTES_PER_TICK = 2;
/** Seconds between a unit's route searches while it closes on a target. */
const REROUTE_S = 2;
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

/** A sound the fight makes, and where (the battle's sounds pick MC2's for it). */
export type Noise =
  | { kind: 'fire'; weapon: number; at: V3; by: SeaUnit }
  | { kind: 'impact'; weapon: number; at: V3; on: SeaUnit; by: SeaUnit }
  | { kind: 'blast'; blast: Blast; at: V3; on: SeaUnit };

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
  onDestroyed: (u: SeaUnit, by: SeaUnit) => void = () => {};
  /** Called when a shot damages a unit that survives it (the radio: under attack). */
  onHit: (u: SeaUnit, by: SeaUnit) => void = () => {};
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
  private readonly nextRoute = new Map<SeaUnit, number>();
  private readonly nextSmoke = new Map<SeaUnit, number>();

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
    this.nextRoute.clear();
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
      this.chooseTarget(u);
      this.close(u);
      this.shoot(u);
    }
    this.judge();
  }

  /** Who sees whom: within sight range, with no ground in between. A team shares what its units see. */
  private look(units: SeaUnit[]): void {
    this.seen.clear();
    this.sight.clear();
    for (const u of units) {
      this.sight.set(u, new Set());
      if (!this.seen.has(u.team)) this.seen.set(u.team, new Set());
    }
    const terrain = this.world.terrain;
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        if (a.team === b.team || Math.hypot(a.x - b.x, a.z - b.z) > SIGHT_RANGE) continue;
        if (terrain.blocked(a.x, a.eyeY, a.z, b.x, b.eyeY, b.z)) continue;
        this.sight.get(a)!.add(b);
        this.sight.get(b)!.add(a);
        this.seen.get(a.team)!.add(b);
        this.seen.get(b.team)!.add(a);
      }
    }
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
    const near = (t: SeaUnit) => t.alive && !!seen?.has(t) && Math.hypot(t.x - u.x, t.z - u.z) <= ATTACK_RADIUS;
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
   * Units under an attack order, and every enemy unit with a target (near where its squad was sent), walk until they are
   * within their best range and see the target. The player's other units hold where they are (or keep to the route they
   * were given) and fire at what comes into range.
   */
  private close(u: SeaUnit): void {
    if (u.kind === 'structure') return; // turrets and tents stay put
    const t = u.target;
    const leashed = !u.leash || !t || Math.hypot(t.x - u.leash.x, t.z - u.leash.z) <= LEASH_M;
    const hunting = u.attackOrder !== null || (u.team !== PLAYER_TEAM && leashed);
    if (!t || !hunting) {
      if (u.engaging) u.stop();
      return;
    }
    if (u.route.length && !u.engaging) return; // walking where the player sent it
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    if (d <= bestRange(u.combat!.weapons) * CLOSE_TO && this.sees(u, t)) {
      if (u.engaging) u.stop();
      return;
    }
    if (this.time < (this.nextRoute.get(u) ?? 0) || this.routes >= ROUTES_PER_TICK) return;
    const end = u.route[u.route.length - 1];
    if (u.engaging && end && Math.hypot(end[0] - t.x, end[1] - t.z) < 15) return; // still headed the right way
    this.routes++;
    this.nextRoute.set(u, this.time + REROUTE_S);
    const grid = this.world.gridFor(u);
    const route = grid ? grid.findPath(u.x, u.z, t.x, t.z) : [[t.x, t.z] as [number, number]];
    if (route) {
      u.walkTo(route);
      u.engaging = true;
    }
  }

  /** Fire every weapon that can: loaded, in range, in sight (an LRM may use a teammate's), and aimed at the target. */
  private shoot(u: SeaUnit): void {
    const t = u.target;
    const combat = u.combat!;
    if (!t || !t.alive) return;
    if (Math.abs(wrapDegrees(bearing(u, t) - u.aimYaw)) > FIRE_ARC) return;
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    const own = this.sees(u, t);
    const spotted = this.seen.get(u.team)?.has(t) ?? false;
    for (const w of combat.weapons) {
      if (!combat.ready(w, this.time) || !inRange(w.def.range, d)) continue;
      if (!own && !(w.def.indirect && spotted)) continue;
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
    if (def.kind === 'energy') {
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

  private destroyed(t: SeaUnit, by: SeaUnit, report: HitReport): void {
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
    this.fx.explosion(at, t.kind === 'mech' ? 1 : 0.75);
    this.onNoise({ kind: 'blast', blast: t.kind === 'mech' ? 'mech' : t.kind === 'structure' ? 'structure' : 'vehicle', at, on: t });
    if (report.exploded) this.fx.explosion(at, 0.8);
    this.wrecks.push({ unit: t, since: this.time, nextPuff: this.time + 0.3, drawn: false });
    const side = (u: SeaUnit) => (u.team === PLAYER_TEAM ? '' : 'enemy ');
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
      this.fx.burning([c[0], c[1] - w.unit.instance.model.radius * 0.3, c[2]], 1.2 - (age / BURN_S) * 0.8);
    }
    // Live mechs that have lost much of their armour smoke.
    for (const u of this.world.units) {
      if (!u.alive || u.hidden || !u.combat || u.combat.integrity > 0.55 || this.time < (this.nextSmoke.get(u) ?? 0)) continue;
      this.nextSmoke.set(u, this.time + 0.35);
      const at = u.nodePosition('smoke_torso') ?? u.nodePosition('joint_torso') ?? [...u.instance.center];
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
    const reach = u.instance.model.radius * 0.35;
    return [c[0] + Math.sin(r) * reach, c[1] + u.instance.model.radius * 0.2, c[2] + Math.cos(r) * reach];
  }

  private hitPoint(t: SeaUnit, location: string): V3 {
    const node = HIT_NODE[location];
    const p = node ? t.nodePosition(node) : null;
    if (p) return p;
    const c = t.instance.center;
    const r = t.instance.model.radius;
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
