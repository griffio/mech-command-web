// APCs: a squad of soldiers may have its own (the scenario's `carrier`: MC2's APC or troop transport, both unarmed) to
// drive it on long moves. MC2 has the makings of this, compiled out (code/tacordr.cpp, TACTICAL_ORDER_LOAD_INTO_CARRIER
// and DEPLOY_ELEMENTALS: Elementals walk to a carrier that has stopped within 200 units, 40 m, of them, it holds ten,
// and they get out round it 10 m off); when to ride, and getting out under fire, are this project's own.
//
// Sent somewhere its APC gets it to sooner than it would walk (counting the APC's drive to fetch it), the squad waits
// while the APC comes, walks to it and gets in, and rides there at the APC's top speed, keeping to the roads. It gets
// out there, or as soon as fire lands about the APC or the side sees an enemy near it: then it goes on on foot, and the
// APC backs off the way it came. Any other order (Stop, an attack, an airlift) gets it out where it is. If the APC is
// destroyed with them aboard, each has an even chance of getting out alive.
import type { Attacker } from './battle';
import type { Squad, SquadOrder } from './squads';
import { PLAYER_TEAM, type SeaUnit, type World } from './world';

/** Moves shorter than this are walked, metres. */
const RIDE_MIN_M = 200;
/** A squad rides when that gets it there in under this share of the time it takes to walk. */
const QUICKER = 0.75;
/** The APC stops this near the squad for it to get in, metres (MC2: 200 units). */
const BOARD_M = 40;
/** A soldier this near the APC gets in, metres (units keep apart: an APC's room and a soldier's are 6 m). */
const BOARD_REACH_M = 10;
/** Seconds after they set off for it that everyone still out gets in anyway (MC2: five, for faster Elementals). */
const BOARD_S = 12;
/** Seconds getting in takes, for reckoning whether to ride. */
const BOARD_ESTIMATE_S = 10;
/** Seats (code/gvehicl.h MAX_TOADS). */
const CAPACITY = 10;
/** They get out in a ring this far about the APC, metres (MC2: 50 units). */
const UNLOAD_RING_M = 10;
/** The APC stops and they get out when the side sees an enemy with weapons this near it, metres. */
const CONTACT_M = 150;
/** After they get out under fire, the APC drives this far back the way it came, metres. */
const BACK_OFF_M = 80;
/** Each soldier aboard an APC that's destroyed dies with this chance. */
const LOST_ABOARD = 0.5;

type Phase = 'fetch' | 'board' | 'drive';

interface Ride {
  squad: Squad;
  apc: SeaUnit;
  phase: Phase;
  to: [number, number];
  retreat: boolean;
  /** The order the ride carries out: any other given the squad ends it. */
  order: SquadOrder;
  /** Game time the soldiers set off for the APC (boarding), or it set off with them (driving). */
  since: number;
  /** Where it set off with them aboard. */
  from: [number, number];
}

export class Carriers {
  /** Things worth telling the player (their squads getting out under fire, or losing men aboard). */
  onEvent: (text: string, team: number) => void = () => {};
  private readonly rides = new Map<Squad, Ride>();
  private time = 0;

  constructor(private readonly world: World) {}

  /**
   * Does the squad's APC get it to a point sooner than it walks there? Only soldiers ride, with nobody already in a
   * fight near them, and only where the APC can drive to them and on to the point.
   */
  quicker(squad: Squad, x: number, z: number): boolean {
    const apc = squad.carrier;
    const riders = squad.riders;
    const c = squad.centroid();
    if (!apc || !c || squad.airborne || !riders.length || riders.length > CAPACITY || !squad.isInfantry) return false;
    const d = Math.hypot(x - c[0], z - c[1]);
    if (d < RIDE_MIN_M) return false;
    const grid = this.world.gridFor(apc);
    if (grid && (!grid.connected(apc.x, apc.z, c[0], c[1]) || !grid.connected(c[0], c[1], x, z))) return false;
    if (this.contact(squad.team, c[0], c[1]) || this.contact(squad.team, apc.x, apc.z)) return false;
    const walk = d / Math.min(...riders.map((u) => u.speed));
    const fetch = Math.max(0, Math.hypot(apc.x - c[0], apc.z - c[1]) - BOARD_M) / apc.speed;
    return fetch + BOARD_ESTIMATE_S + d / apc.speed < QUICKER * walk;
  }

  /**
   * Send a squad to a point in its APC: if that's quicker (see quicker), or it's aboard already. False if it walks (and
   * anyone aboard has got out).
   */
  ride(squad: Squad, x: number, z: number, retreat: boolean): boolean {
    const current = this.rides.get(squad);
    const apc = squad.carrier;
    const aboard = current?.phase === 'drive';
    const grid = apc && this.world.gridFor(apc);
    const go = aboard ? !grid || grid.connected(apc.x, apc.z, x, z) : this.quicker(squad, x, z);
    if (!apc || !go) {
      if (current) this.end(current);
      return false;
    }
    const order: SquadOrder = retreat ? { kind: 'retreat', x, z } : { kind: 'move', x, z };
    squad.order = order;
    const ride: Ride = current ?? { squad, apc, phase: 'fetch', to: [x, z], retreat, order, since: this.time, from: [apc.x, apc.z] };
    Object.assign(ride, { to: [x, z], retreat, order });
    this.rides.set(squad, ride);
    if (aboard) this.drive(ride);
    else if (!current) this.fetch(ride);
    return true;
  }

  /** Get a squad out of its APC where it is (a Karnov is coming for it). */
  cancel(squad: Squad): void {
    const ride = this.rides.get(squad);
    if (ride) this.end(ride);
  }

  /** A unit was destroyed: if it was an APC with soldiers aboard, they get out of the wreck, each with an even chance. */
  lost(u: SeaUnit, by: Attacker): void {
    const ride = [...this.rides.values()].find((r) => r.apc === u);
    if (!ride) return;
    const { squad } = ride;
    const aboard = squad.riders.filter((r) => r.embarked);
    this.end(ride);
    let killed = 0;
    for (const r of aboard) {
      if (Math.random() >= LOST_ABOARD) continue;
      this.world.battle.kill(r, by);
      killed++;
    }
    if (aboard.length && squad.team === PLAYER_TEAM) this.onEvent(`${squad.name}: ${killed ? `${killed} of ${aboard.length} lost aboard the ${u.name}` : `all out of the ${u.name}`}`, squad.team);
    // The rest go on on foot.
    if (squad.riders.length) squad.move(this.world, ride.to[0], ride.to[1], ride.retreat);
  }

  update(dt: number): void {
    this.time += dt;
    for (const ride of [...this.rides.values()]) {
      const { squad, apc } = ride;
      const riders = squad.riders;
      // Another order, or a Karnov, takes over; or there's nobody left to carry.
      if (squad.order !== ride.order || squad.airborne || !apc.alive || !riders.length) {
        this.end(ride);
        continue;
      }
      for (const u of riders) {
        if (!u.embarked) continue;
        u.x = apc.x;
        u.z = apc.z;
      }
      if (ride.phase === 'fetch') {
        const c = squad.centroid()!;
        if (!apc.route.length || Math.hypot(apc.x - c[0], apc.z - c[1]) <= BOARD_M) this.board(ride);
      } else if (ride.phase === 'board') {
        const late = this.time - ride.since > BOARD_S;
        for (const u of riders) if (!u.embarked && (late || Math.hypot(u.x - apc.x, u.z - apc.z) <= BOARD_REACH_M)) this.embark(u, apc);
        if (riders.every((u) => u.embarked)) {
          ride.from = [apc.x, apc.z];
          this.drive(ride);
        }
      } else if (apc.suppressedAt >= ride.since || this.contact(squad.team, apc.x, apc.z)) {
        this.unload(ride, true);
      } else if (!apc.route.length) this.unload(ride, false);
    }
  }

  /** The APC drives to the squad, which waits for it. */
  private fetch(ride: Ride): void {
    const { squad, apc } = ride;
    const c = squad.centroid()!;
    for (const u of squad.riders) {
      u.attackOrder = null;
      u.stop();
      u.leash = { x: c[0], z: c[1] };
    }
    squad.ride = 'waiting';
    ride.phase = 'fetch';
    if (Math.hypot(apc.x - c[0], apc.z - c[1]) <= BOARD_M || !this.route(apc, c[0], c[1])) this.board(ride);
  }

  /** The APC stops, and the soldiers walk to it. */
  private board(ride: Ride): void {
    const { squad, apc } = ride;
    apc.stop();
    for (const u of squad.riders) if (!u.embarked && !this.route(u, apc.x, apc.z)) this.embark(u, apc);
    squad.ride = 'boarding';
    ride.phase = 'board';
    ride.since = this.time;
  }

  private embark(u: SeaUnit, apc: SeaUnit): void {
    u.embarked = true;
    u.route = [];
    u.target = null;
    u.attackOrder = null;
    u.x = apc.x;
    u.z = apc.z;
  }

  /** Everyone's aboard: drive to where the squad is going. */
  private drive(ride: Ride): void {
    ride.squad.ride = 'aboard';
    ride.phase = 'drive';
    ride.since = this.time;
    if (!this.route(ride.apc, ride.to[0], ride.to[1])) ride.apc.stop();
  }

  /**
   * They get out round the APC and go on to where they were going (on foot from wherever it stopped); it waits behind
   * them there, or, stopped under fire, backs off the way it came.
   */
  private unload(ride: Ride, underFire: boolean): void {
    const { squad, apc, to, from } = ride;
    this.end(ride);
    squad.move(this.world, to[0], to[1], ride.retreat);
    if (underFire) {
      const d = Math.hypot(from[0] - apc.x, from[1] - apc.z) || 1;
      const back = Math.min(d, BACK_OFF_M);
      if (!this.route(apc, apc.x + ((from[0] - apc.x) / d) * back, apc.z + ((from[1] - apc.z) / d) * back)) apc.stop();
      if (squad.team === PLAYER_TEAM) this.onEvent(`${squad.name}: out of the ${apc.name} under fire`, squad.team);
    } else squad.park(this.world, to[0], to[1], from);
  }

  /** The ride is over: anyone aboard gets out in a ring about the APC, which stops, and the squad is on its own feet. */
  private end(ride: Ride): void {
    const { squad, apc } = ride;
    this.rides.delete(squad);
    squad.ride = null;
    if (apc.alive) apc.stop();
    const aboard = squad.riders.filter((u) => u.embarked);
    // The Karnov has them now (it lands for the squad wherever it is).
    if (squad.airborne && apc.embarked) return;
    aboard.forEach((u, i) => {
      const a = (i / aboard.length) * Math.PI * 2 + (apc.rotation * Math.PI) / 180;
      [u.x, u.z] = this.world.openNear(apc.x + Math.sin(a) * UNLOAD_RING_M, apc.z + Math.cos(a) * UNLOAD_RING_M, u.moveClass);
      u.rotation = apc.rotation;
      u.embarked = false;
    });
  }

  /** Route a unit to a point over its movement map; false if there's no way there. */
  private route(u: SeaUnit, x: number, z: number): boolean {
    const [sx, sz] = this.world.openNear(x, z, u.moveClass);
    const grid = this.world.gridFor(u);
    const route = grid ? grid.findPath(u.x, u.z, sx, sz) : [[sx, sz] as [number, number]];
    if (!route) return false;
    u.engaging = false;
    u.walkTo(route);
    return true;
  }

  /** The side sees an enemy with weapons within CONTACT_M of a point. */
  private contact(team: number, x: number, z: number): boolean {
    for (const e of this.world.battle.seenBy(team)) if (e.alive && e.combat?.weapons.length && Math.hypot(e.x - x, e.z - z) < CONTACT_M) return true;
    return false;
  }
}
