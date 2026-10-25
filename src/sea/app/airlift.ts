// Airlift: MC2's Karnov VTOL (tgl/karnov, with its hover, landing and take-off animations) flies an infantry squad from
// wherever it is to where it's sent. It lifts off from the squad's base, lands by the squad, takes it aboard, flies
// over everything at a safe height, sets it down and goes home. Infantry are slow and keep to land, so this is how they
// cross water or reach a far point in time. One flight per squad; the Karnov can't be shot down, and the squad can't be
// hurt while aboard.
import type { PaintScheme } from '../../paint.ts';
import type { Squad } from './squads';
import { bearing, type SeaUnit, type World } from './world';

/**
 * The Karnov's own clips fly it near the ground (tgl/karnov*.ase, in metres): it hovers 17 m up with its cargo arm down
 * to load and unload; landing glides in from 96 m back and 90 m up; take-off climbs out to 90 m up, 61 m on and 23 m to
 * the side. Between them it cruises at the height those start and end at.
 */
const HOVER_POSE_M = 85 / 5.01;
const CRUISE_M = 450 / 5.01 - HOVER_POSE_M;
const LAND_FROM: [number, number] = [6 / 5.01, -483 / 5.01];
const TAKEOFF_TO: [number, number] = [116 / 5.01, 308 / 5.01];
/** Cruising speed, metres a second. */
const SPEED_MS = 60;
/** Seconds hovering to load or unload. */
const LOAD_S = 2;
/** Squads within this of their base board without the Karnov flying out to them first. */
const AT_BASE_M = 120;
/** Spacing of the squad about the landing spot when it gets off, metres. */
const UNLOAD_SPACING = 6;
/** The Karnov's clips carry it this far from its position, so it's culled by this radius, metres. */
const REACH_M = 120;

type Phase = 'take-off' | 'to-pickup' | 'land-pickup' | 'load' | 'to-drop' | 'land-drop' | 'unload' | 'home';

interface Flight {
  squad: Squad;
  craft: SeaUnit;
  phase: Phase;
  pickup: [number, number];
  drop: [number, number];
  base: { x: number; z: number };
  timer: number;
  /** Where it goes after taking off. */
  next: Phase;
}

export class Airlift {
  private readonly flights: Flight[] = [];

  constructor(
    private readonly world: World,
    /** The Karnov's model (null if the converter didn't export it: then there is no airlift). */
    private readonly model: string | null,
  ) {}

  get available(): boolean {
    return this.model !== null;
  }

  /** The squad has a Karnov coming for it, or is aboard one. */
  flying(squad: Squad): boolean {
    return squad.airborne;
  }

  /** Where a squad's Karnov is taking it, if it has one. */
  destination(squad: Squad): [number, number] | null {
    return this.flights.find((f) => f.squad === squad)?.drop ?? null;
  }

  /**
   * Set a squad's flight down somewhere else, if it hasn't started landing where it was going (the AI waves off a landing
   * zone that has turned hot). False if it has, or the squad isn't flying.
   */
  redirect(squad: Squad, x: number, z: number): boolean {
    const f = this.flights.find((f) => f.squad === squad);
    const going = f?.phase === 'take-off' ? f.next : f?.phase;
    if (!f || going === 'land-drop' || going === 'unload' || going === 'home') return false;
    f.drop = this.world.openNear(x, z, 'ground');
    squad.order = { kind: 'move', x: f.drop[0], z: f.drop[1] };
    return true;
  }

  /**
   * Send a Karnov from the squad's base to fly it to a point. False when there's no airlift, the squad is already
   * flying, or nobody in it is left.
   */
  async request(squad: Squad, base: { x: number; z: number }, paint: PaintScheme, x: number, z: number): Promise<boolean> {
    const at = squad.centroid();
    if (!this.model || !at || this.flying(squad)) return false;
    const pickup = this.world.openNear(at[0], at[1], 'ground');
    const drop = this.world.openNear(x, z, 'ground');
    // The flight is booked before the Karnov is made, so a second request can't slip in meanwhile.
    const flight: Flight = { squad, craft: null as unknown as SeaUnit, phase: 'take-off', pickup, drop, base, timer: 0, next: 'to-pickup' };
    this.flights.push(flight);
    squad.airborne = true;
    squad.hold();
    squad.order = { kind: 'move', x: drop[0], z: drop[1] };
    // A squad at its base is picked up there: the Karnov comes in to land by it. Otherwise it takes off from the base.
    const atBase = Math.hypot(at[0] - base.x, at[1] - base.z) < AT_BASE_M;
    const start = atBase ? pickup : [base.x, base.z];
    const craft = await this.world.spawn({
      model: this.model,
      info: null,
      kind: 'vehicle',
      name: 'Karnov',
      team: squad.team,
      x: start[0],
      z: start[1],
      rotation: bearing(base, atBase ? { x: drop[0], z: drop[1] } : { x: pickup[0], z: pickup[1] }),
      paint,
      stats: null,
      gunnery: 0,
    });
    craft.instance.radius = REACH_M;
    this.world.units.push(craft);
    flight.craft = craft;
    if (atBase) this.land(flight, 'land-pickup');
    else this.takeOff(flight, 'to-pickup');
    return true;
  }

  update(dt: number): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      if (!f.craft) continue; // still being made
      if (this.step(f, dt)) {
        this.world.remove(f.craft);
        this.flights.splice(i, 1);
      }
    }
  }

  /** Advance one flight; true when it's home and done. */
  private step(f: Flight, dt: number): boolean {
    const craft = f.craft;
    // Passengers ride along (so the squad's letter follows the flight).
    for (const u of f.squad.alive) {
      if (!u.embarked) continue;
      u.x = craft.x;
      u.z = craft.z;
    }
    switch (f.phase) {
      case 'take-off':
        // The take-off clip ends 90 m up and well on: carry on from there.
        if (!craft.clipDone) return false;
        this.offset(craft, TAKEOFF_TO);
        craft.altitude = CRUISE_M;
        craft.play('hover', 0);
        f.phase = f.next;
        return false;
      case 'to-pickup':
        if (this.fly(craft, f.pickup, dt)) this.land(f, 'land-pickup');
        return false;
      case 'land-pickup':
        if (craft.clipDone) this.hover(f, 'load');
        return false;
      case 'load':
        f.timer += dt;
        if (f.timer < LOAD_S) return false;
        for (const u of f.squad.alive) {
          u.embarked = true;
          u.route = [];
          u.target = null;
          u.attackOrder = null;
        }
        // Nobody left to carry: go home.
        if (!f.squad.alive.length) f.squad.airborne = false;
        this.takeOff(f, f.squad.alive.length ? 'to-drop' : 'home');
        return false;
      case 'to-drop':
        if (this.fly(craft, f.drop, dt)) this.land(f, 'land-drop');
        return false;
      case 'land-drop':
        if (craft.clipDone) this.hover(f, 'unload');
        return false;
      case 'unload':
        f.timer += dt;
        if (f.timer < LOAD_S) return false;
        this.unload(f);
        this.takeOff(f, 'home');
        return false;
      case 'home':
        return this.fly(craft, [f.base.x, f.base.z], dt, false);
    }
  }

  /**
   * Cruise toward a point; true on reaching the spot the landing clip starts from (96 m short of it, on the line in), or
   * the point itself when it isn't going to land there.
   */
  private fly(craft: SeaUnit, to: [number, number], dt: number, landing = true): boolean {
    const heading = bearing(craft, { x: to[0], z: to[1] });
    const r = (heading * Math.PI) / 180;
    const [ax, az] = landing ? [to[0] - Math.sin(r) * -LAND_FROM[1], to[1] - Math.cos(r) * -LAND_FROM[1]] : to;
    const dx = ax - craft.x;
    const dz = az - craft.z;
    const d = Math.hypot(dx, dz);
    craft.rotation = heading;
    const step = Math.min(d, SPEED_MS * dt);
    if (d > 1e-3) {
      craft.x += (dx / d) * step;
      craft.z += (dz / d) * step;
    }
    return d - step < 0.5;
  }

  /** Put the Karnov at the landing spot, facing in, and play its landing (which starts where it cruised to). */
  private land(f: Flight, phase: Phase): void {
    const craft = f.craft;
    const spot = phase === 'land-pickup' ? f.pickup : f.drop;
    craft.rotation = bearing(craft, { x: spot[0], z: spot[1] });
    craft.x = spot[0];
    craft.z = spot[1];
    craft.altitude = 0;
    craft.play('land', 0, true);
    this.phase(f, phase);
  }

  private hover(f: Flight, phase: Phase): void {
    f.craft.play('hover', 0);
    this.phase(f, phase);
  }

  private takeOff(f: Flight, next: Phase): void {
    f.craft.altitude = 0;
    f.craft.play('takeoff', 0, true);
    f.next = next;
    this.phase(f, 'take-off');
  }

  private phase(f: Flight, phase: Phase): void {
    f.phase = phase;
    f.timer = 0;
  }

  /** Move the Karnov by an offset in its own frame (its model's x and z, z ahead). */
  private offset(craft: SeaUnit, [mx, mz]: [number, number]): void {
    const r = (craft.rotation * Math.PI) / 180;
    craft.x += mx * Math.cos(r) + mz * Math.sin(r);
    craft.z += -mx * Math.sin(r) + mz * Math.cos(r);
  }

  /** The squad gets off in a ring about the landing spot, facing the way the Karnov came. */
  private unload(f: Flight): void {
    const riders = f.squad.alive.filter((u) => u.embarked);
    riders.forEach((u, i) => {
      const a = (i / Math.max(riders.length, 1)) * Math.PI * 2;
      const r = i === 0 ? 0 : UNLOAD_SPACING;
      [u.x, u.z] = this.world.openNear(f.drop[0] + Math.cos(a) * r, f.drop[1] + Math.sin(a) * r, u.moveClass);
      u.rotation = f.craft.rotation;
      u.embarked = false;
      u.leash = { x: f.drop[0], z: f.drop[1] };
    });
    f.squad.order = { kind: 'hold' };
    // It's down: the Karnov flies home on its own.
    f.squad.airborne = false;
  }
}
