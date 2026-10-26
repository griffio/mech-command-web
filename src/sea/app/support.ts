// Strikes a side calls in on a spot (the scenario's support): artillery, and an air strike flown by an aerospace fighter
// on its bombing run. Their numbers are MC2's (objects/artsml.fit, artbig.fit; code/artlry.cpp): a strike lands 7
// seconds after the call; every unit within its reach takes hits (Battle.bombard), friend and foe alike. The air strike's
// fighter (MC2's Slayer) starts its bombing-run animation 2.5 seconds before it lands, as the engine starts it, and the
// engine's incoming whoosh plays 5.5 seconds out. Meanwhile MC2's marker spins on the spot and a ring shows the strike's
// reach. When it lands its bursts spread over that ground, in the pattern its file gives (the engine reads it but draws
// one effect instead).
//
// A sensor probe (MC2's artsns, its sensor strike) is called the same way, anywhere, and lands at once: it leaves a sensor
// on the spot (sensors.ts) instead of doing damage.
//
// The rules for calling are this project's: a side calls a strike where one of its units can see, or its sensors reach,
// then waits a while for the next. The player sees an enemy strike coming when it's near their units.
import type { ScenarioStrike, ScenarioSupport, StrikeStats } from '../../assets';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import { SIGHT_RANGE } from '../sim/combat';
import type { Attacker } from './battle';
import type { Match } from './match';
import { PLAYER_TEAM, type SeaUnit, type World } from './world';

export type CallIn = 'artillery' | 'airstrike' | 'sensor';
export const CALL_INS: CallIn[] = ['artillery', 'airstrike', 'sensor'];
export const CALL_IN_NAMES: Record<CallIn, string> = { artillery: 'Artillery', airstrike: 'Air strike', sensor: 'Sensor probe' };

/** Seconds out the engine plays the incoming whoosh, and starts the fighter's bombing run (code/artlry.cpp). */
const WHOOSH_S = 5.5;
const BOMB_RUN_S = 2.5;
/** The bombing run's animation carries the fighter some 200 m either side of the spot. */
const BOMBER_REACH_M = 260;
/** MC2's marker is 8 m across: drawn larger, to be seen from the RTS camera. */
const MARKER_SIZE = 2.5;
const MARKER_SPIN_DEG_S = 90;
/** How big a burst looks (the air strike's bigger), and how much its spot wanders. */
const BURST_SCALE: Record<CallIn, number> = { artillery: 1.1, airstrike: 1.5, sensor: 0 };
/** The player sees an enemy strike coming when one of their units is within this of its reach, metres. */
const WARN_M = 60;
const RING_COLOR: Record<'own' | 'enemy', [number, number, number, number]> = { own: [1, 0.74, 0.3, 1], enemy: [1, 0.3, 0.25, 1] };

interface Strike {
  team: number;
  call: CallIn;
  x: number;
  z: number;
  stats: StrikeStats;
  /** Match time it lands. */
  lands: number;
  by: Attacker;
  marker: ModelInstance | null;
  ring: Promise<ModelInstance> | null;
  bomber: SeaUnit | null;
  /** Its fighter is being made (spawning is asynchronous). */
  launching: boolean;
  whooshed: boolean;
  flown: boolean;
  landed: boolean;
  /** Its bursts still to come (match time, place). */
  bursts: { at: number; x: number; z: number }[];
}

export class Support {
  private readonly strikes: Strike[] = [];
  /** Match time each side's strike of each kind is ready again, and whether that has been said. */
  private readonly readyAt = new Map<string, number>();
  private readonly announced = new Set<string>();
  private marker: GpuModel | null = null;
  private spin = 0;

  constructor(
    private readonly world: World,
    private readonly match: Match,
    readonly spec: ScenarioSupport,
  ) {
    for (const side of match.sides) {
      for (const call of CALL_INS) {
        const s = this.callSpec(call);
        if (s) this.readyAt.set(`${side.team}:${call}`, s.first);
      }
    }
  }

  async load(): Promise<void> {
    this.marker = await this.world.propModel(this.spec.marker);
  }

  /** The scenario has this strike, and the converter exported its numbers. */
  available(call: CallIn): boolean {
    return this.stats(call) !== null;
  }

  stats(call: CallIn): StrikeStats | null {
    const s = this.callSpec(call);
    return s ? this.world.strikeStats(s.strike) : null;
  }

  /** Seconds until a side can call this strike again (0: now). */
  readyIn(team: number, call: CallIn): number {
    return Math.max(0, (this.readyAt.get(`${team}:${call}`) ?? Infinity) - this.match.time);
  }

  /** Why a side can't call this strike on a spot just now, or null if it can. */
  whyNot(team: number, call: CallIn, x: number, z: number): string | null {
    if (!this.available(call)) return `there's no ${CALL_IN_NAMES[call].toLowerCase()} in this scenario`;
    const wait = this.readyIn(team, call);
    if (wait > 0) return `${CALL_IN_NAMES[call]} is ready in ${Math.ceil(wait)} s`;
    if (call !== 'sensor' && !this.spotted(team, x, z) && !this.match.sensors.covers(team, x, z)) {
      return `none of your squads can see there, and no sensor of yours reaches it: a strike needs someone watching the spot`;
    }
    return null;
  }

  /** Call a strike on a spot; why not, if it can't be. */
  call(team: number, call: CallIn, x: number, z: number): string | null {
    const why = this.whyNot(team, call, x, z);
    if (why) return why;
    const stats = this.stats(call)!;
    this.readyAt.set(`${team}:${call}`, this.match.time + this.callSpec(call)!.cooldown);
    this.announced.delete(`${team}:${call}`);
    if (call === 'sensor') {
      this.match.sensors.probe(team, x, z, stats);
      this.match.onSignal({ kind: 'strikeCalled', team, call, x, z, reach: stats.sensorRange, seen: team === PLAYER_TEAM });
      return null;
    }
    const strike: Strike = {
      team,
      call,
      x,
      z,
      stats,
      lands: this.match.time + stats.timeToImpact,
      by: { team, name: CALL_IN_NAMES[call], x, z, squad: null },
      marker: null,
      ring: null,
      bomber: null,
      launching: false,
      whooshed: false,
      flown: false,
      landed: false,
      bursts: [],
    };
    this.strikes.push(strike);
    // The player sees their own strikes on the way, and the enemy's that threaten their units.
    const seen = team === PLAYER_TEAM || this.threatens(strike, PLAYER_TEAM);
    if (seen) this.show(strike);
    this.match.onSignal({ kind: 'strikeCalled', team, call, x, z, reach: stats.minorRange, seen });
    return null;
  }

  update(dt: number): void {
    this.spin = (this.spin + MARKER_SPIN_DEG_S * dt) % 360;
    const now = this.match.time;
    for (const [key, at] of this.readyAt) {
      if (now < at || this.announced.has(key)) continue;
      this.announced.add(key);
      const [team, call] = key.split(':') as [string, CallIn];
      this.match.onSignal({ kind: 'strikeReady', team: Number(team), call });
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i]!;
      const left = s.lands - now;
      if (s.marker) this.world.placeMarker(s.marker, s.x, s.z, this.spin, this.world.modelScale(MARKER_SIZE));
      if (!s.whooshed && left <= WHOOSH_S) {
        s.whooshed = true;
        this.world.battle.incoming(s.x, s.z);
      }
      if (!s.flown && left <= BOMB_RUN_S) {
        s.flown = true;
        void this.fly(s);
      }
      if (!s.landed && left <= 0) this.land(s);
      for (let b = s.bursts.length - 1; b >= 0; b--) {
        const burst = s.bursts[b]!;
        if (now < burst.at) continue;
        this.world.battle.burst(burst.x, burst.z, BURST_SCALE[s.call]);
        s.bursts.splice(b, 1);
      }
      if (s.bomber?.clipDone) {
        this.world.remove(s.bomber);
        s.bomber = null;
      }
      if (s.landed && !s.bursts.length && !s.bomber && !s.launching) this.strikes.splice(i, 1);
    }
  }

  private callSpec(call: CallIn): ScenarioStrike | undefined {
    return this.spec[call];
  }

  /** One of the side's units sees the spot (is within sight range of it). */
  private spotted(team: number, x: number, z: number): boolean {
    return this.world.units.some((u) => u.team === team && u.alive && u.combat && !u.embarked && Math.hypot(u.x - x, u.z - z) <= SIGHT_RANGE);
  }

  /** A side's units are near enough a strike's reach to see it coming. */
  threatens(s: { x: number; z: number; stats: StrikeStats }, team: number): boolean {
    return this.world.units.some((u) => u.team === team && u.alive && u.combat && !u.embarked && Math.hypot(u.x - s.x, u.z - s.z) <= s.stats.minorRange + WARN_M);
  }

  /** The spinning marker on the spot, and a ring at the strike's reach. */
  private show(s: Strike): void {
    if (this.marker) s.marker = this.world.addMarker(this.marker, s.x, s.z, this.world.modelScale(MARKER_SIZE));
    const color = RING_COLOR[s.team === PLAYER_TEAM ? 'own' : 'enemy'];
    s.ring = this.world.markerRing(color, s.x, s.z, s.stats.minorRange, 2).then((m) => this.world.addMarker(m, s.x, s.z, 1));
  }

  /** The fighter's bombing run: its animation carries it in over the spot from the caller's side, and away. */
  private async fly(s: Strike): Promise<void> {
    const bomber = this.callSpec(s.call)?.bomber;
    const path = bomber ? this.world.propPath(bomber) : null;
    if (!path) return;
    s.launching = true;
    const side = this.match.side(s.team);
    // The run goes along the model's x axis: turn it so it comes from the side's base.
    const d = Math.hypot(s.x - side.base.x, s.z - side.base.z) || 1;
    const [hx, hz] = [(s.x - side.base.x) / d, (s.z - side.base.z) / d];
    const rotation = (Math.atan2(-hz, hx) * 180) / Math.PI;
    const craft = await this.world.spawn({
      model: path,
      info: null,
      kind: 'vehicle',
      name: bomber!,
      team: s.team,
      x: s.x,
      z: s.z,
      rotation,
      paint: side.paint,
      stats: null,
      gunnery: 0,
    });
    craft.instance.radius = BOMBER_REACH_M;
    craft.play('bombrun', 0, true);
    this.world.units.push(craft);
    s.bomber = craft;
    s.launching = false;
  }

  /** It lands: the damage all at once, as the engine does it, then its bursts over the ground. */
  private land(s: Strike): void {
    s.landed = true;
    this.world.battle.bombard(s.x, s.z, s.stats, s.by);
    const now = this.match.time;
    const scatter = () => (Math.random() * 2 - 1) * s.stats.scatter;
    s.bursts = s.stats.explosions.map((e) => ({ at: now + e.delay, x: s.x + e.x + scatter(), z: s.z + e.z + scatter() }));
    if (s.marker) this.world.removeMarker(s.marker);
    s.marker = null;
    void s.ring?.then((r) => this.world.removeMarker(r));
    s.ring = null;
  }
}
