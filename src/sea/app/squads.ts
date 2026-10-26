// Squads: the units the commander orders as one. A squad moves in formation (each member routed to its own slot about
// the destination), attacks as one (when its target falls, the target's squadmates are next), and is reinforced at its
// side's base. Its members can be mechs, vehicles or infantry, and its spacing suits them. A squad of soldiers may have
// an APC to carry them (carriers.ts); on foot, they have it follow on behind. A side's support (an artillery piece, a
// scout, a minelayer: deploy.ts) comes as a squad of one, by VTOL.
import type { ScenarioSquad } from '../../assets';
import type { Deploy } from './deploy';
import type { SeaUnit, World } from './world';

/** A squad this suppressed says so on its card. */
const SUPPRESSED = 0.3;

/** Metres between members in formation, by the squad's largest kind of unit. */
const SPACING = { mech: 18, vehicle: 14, infantry: 6 } as const;
/** A squad's APC waits this far behind where its soldiers go, on the side it comes from, metres. */
const CARRIER_BEHIND_M = 40;

export type SquadOrder =
  | { kind: 'hold' }
  | { kind: 'move'; x: number; z: number }
  | { kind: 'attack'; target: SeaUnit }
  | { kind: 'retreat'; x: number; z: number };

export class Squad {
  /** Its members, living and dead (the dead are dropped when their bodies are cleared away). */
  readonly units: SeaUnit[] = [];
  order: SquadOrder = { kind: 'hold' };
  /** Game time a wiped-out squad comes back at its base, or null. */
  respawnAt: number | null = null;
  /** Game time the next missing member joins while it's at its base. */
  reinforceAt = 0;
  /** The AI commander's current job for it (a point index, or -1 to fall back to base). */
  assignment: number | null = null;
  /** A Karnov is coming for it, or carrying it. */
  airborne = false;
  /** Riding its APC (carriers.ts): waiting for it to come, getting in, or aboard; null on foot. */
  ride: 'waiting' | 'boarding' | 'aboard' | null = null;
  /** Infantry that have stood still long enough are dug in (harder to hit, behind sandbags). */
  dugIn = false;
  stillFor = 0;
  /** What a logistics squad's truck is busy with (building, unloading, filling up), for the HUD. */
  task: string | null = null;
  /** The support it is (deploy.ts), which doesn't come back at a base when it's lost; null for the scenario's squads. */
  support: Deploy | null = null;
  /** A VTOL is bringing it. */
  inbound = false;

  /** Its truck carries supply. */
  get isLogistics(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.supply !== null);
  }

  /**
   * The Karnov can carry it: what keeps to land and fords (infantry, a supply truck, tracked vehicles like the LRM
   * carrier), so can be cut off by water. Mechs wade and hovercraft cross it.
   */
  get airliftable(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.kind === 'infantry' || (u.kind === 'vehicle' && u.moveClass === 'ground'));
  }

  /** Everyone left in it stays where it's put (an artillery piece). */
  get immobile(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.immobile);
  }

  /** Its minelayer, while it has one. */
  get minelayer(): SeaUnit | null {
    return this.units.find((u) => u.alive && u.mines !== null) ?? null;
  }

  /** Everyone left in it flies (helicopters: they can't take a point). */
  get isAir(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.flies);
  }

  /** Everyone left in it, but its APC, is on foot (it can dig in, and be airlifted). */
  get isInfantry(): boolean {
    const riders = this.riders;
    return riders.length > 0 && riders.every((u) => u.kind === 'infantry');
  }

  /** Its APC, while it has one. */
  get carrier(): SeaUnit | null {
    return this.units.find((u) => u.alive && u.carrier) ?? null;
  }

  /** Its living members but its APC (the soldiers it carries). */
  get riders(): SeaUnit[] {
    return this.units.filter((u) => u.alive && !u.carrier);
  }

  constructor(
    readonly team: number,
    readonly letter: string,
    readonly spec: ScenarioSquad,
  ) {}

  get name(): string {
    return this.spec.name;
  }

  get alive(): SeaUnit[] {
    return this.units.filter((u) => u.alive);
  }

  /** Members alive (but its APC) against its full size, weighted by their armour left (0..1). */
  get strength(): number {
    let s = 0;
    for (const u of this.riders) s += u.combat?.integrity ?? 1;
    return s / this.spec.units.length;
  }

  /** Members it's short of, its APC among them. */
  get missing(): number {
    return this.spec.units.length - this.riders.length + (this.spec.carrier && !this.carrier ? 1 : 0);
  }

  /** The most suppressed of its members, but its APC (0..1). */
  get suppression(): number {
    let s = 0;
    for (const u of this.riders) s = Math.max(s, u.suppression);
    return s;
  }

  /** At least half of it (not counting its APC) is pinned down. */
  get pinned(): boolean {
    const alive = this.riders;
    return alive.length > 0 && alive.filter((u) => u.pinned).length * 2 >= alive.length;
  }

  /** The middle of its living members (but its APC, while it has others), or null when none are left. */
  centroid(): [number, number] | null {
    const riders = this.riders;
    const alive = riders.length ? riders : this.alive;
    if (!alive.length) return null;
    let x = 0;
    let z = 0;
    for (const u of alive) {
      x += u.x;
      z += u.z;
    }
    return [x / alive.length, z / alive.length];
  }

  get spacing(): number {
    const kinds = new Set(this.riders.map((u) => u.kind));
    return kinds.has('mech') ? SPACING.mech : kinds.has('vehicle') ? SPACING.vehicle : SPACING.infantry;
  }

  /** What it's doing, in a word or two, for the HUD. */
  status(now: number): string {
    if (this.respawnAt !== null) return `back in ${Math.max(0, Math.ceil(this.respawnAt - now))} s`;
    const alive = this.alive;
    if (!alive.length) return this.inbound ? 'on its way by VTOL' : this.support ? 'not called in' : 'wiped out';
    if (this.airborne) return alive.some((u) => u.embarked) ? 'airlifted' : 'awaiting the Karnov';
    if (this.ride) return this.ride === 'aboard' ? 'in the APC' : this.ride === 'boarding' ? 'boarding the APC' : 'waiting for the APC';
    if (this.isLogistics) {
      const supply = `supply ${Math.floor(alive[0]!.supply ?? 0)}`;
      return this.task ? `${this.task} · ${supply}` : alive.some((u) => u.route.length) ? `moving · ${supply}` : supply;
    }
    if (this.pinned) return this.dugIn ? 'dug in, pinned down' : 'pinned down';
    const suppressed = this.suppression >= SUPPRESSED ? ', suppressed' : '';
    if (this.dugIn) return (alive.some((u) => u.target && u.target.alive) ? 'dug in, fighting' : 'dug in') + suppressed;
    if (alive.some((u) => u.target && u.combat && u.target.alive)) return 'fighting' + suppressed;
    if (this.order.kind === 'retreat') return 'falling back';
    if (alive.some((u) => u.flight === 'takingOff')) return 'taking off';
    const layer = this.minelayer;
    if (layer) return `${layer.laying ? 'laying mines' : layer.route.length ? 'moving' : 'holding'} · ${Math.floor(layer.mines ?? 0)} mines`;
    if (this.immobile) return 'emplaced';
    if (alive.some((u) => u.route.length)) return 'moving';
    if (this.order.kind === 'attack') return 'attacking';
    if (alive.every((u) => u.flight === 'parked')) return 'landed';
    return 'holding';
  }

  /**
   * Move in formation to a point: each member to a slot about it, the nearest members taking the middle slots, and its
   * APC to wait behind them. Returns how many members have a way there.
   */
  move(world: World, x: number, z: number, retreat = false): number {
    this.order = retreat ? { kind: 'retreat', x, z } : { kind: 'move', x, z };
    const riders = this.riders;
    // An artillery piece stays where it's put.
    const members = (riders.length ? riders : this.alive).filter((u) => !u.immobile).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const slots = formationSlots(members.length, this.spacing);
    let routed = 0;
    members.forEach((u, i) => {
      if (go(world, u, x + slots[i]![0], z + slots[i]![1], x, z)) routed++;
    });
    if (riders.length) this.park(world, x, z);
    return routed;
  }

  /**
   * Send its APC to wait behind a point its soldiers go to, on the side the APC comes from (or `from`'s). False if it
   * has none, or no way there.
   */
  park(world: World, x: number, z: number, from: [number, number] | null = null): boolean {
    const c = this.carrier;
    if (!c) return false;
    const [fx, fz] = from ?? [c.x, c.z];
    const d = Math.hypot(fx - x, fz - z) || 1;
    const back = Math.min(d, CARRIER_BEHIND_M);
    return go(world, c, x + ((fx - x) / d) * back, z + ((fz - z) / d) * back, x, z);
  }

  attack(target: SeaUnit): void {
    this.order = { kind: 'attack', target };
    for (const u of this.alive) {
      if (!u.combat?.weapons.length) continue;
      u.attackOrder = target;
      u.target = target;
      u.leash = null;
      // It replaces any move order; the battle routes it toward the target on its next tick.
      if (u.route.length) u.stop();
    }
  }

  hold(): void {
    this.order = { kind: 'hold' };
    for (const u of this.alive) {
      u.attackOrder = null;
      u.stop();
    }
  }
}

/**
 * Route a member to a spot (moved onto ground it can stand on) for a squad sent to (x, z). False when there's no way
 * there: it stops rather than carry on with an old order.
 */
function go(world: World, u: SeaUnit, sx: number, sz: number, x: number, z: number): boolean {
  [sx, sz] = world.openNear(sx, sz, u.moveClass);
  const grid = world.gridFor(u);
  const route = grid ? grid.findPath(u.x, u.z, sx, sz) : [[sx, sz] as [number, number]];
  // A move order ends an attack order (and a minelayer's laying); the squad still fires at what it passes.
  u.attackOrder = null;
  u.engaging = false;
  u.laying = false;
  u.leash = { x, z };
  if (route) u.walkTo(route);
  else u.stop();
  return !!route;
}

/** Offsets for `count` units about a point: the middle, then rings of six, twelve, ... `spacing` apart. */
export function formationSlots(count: number, spacing: number): [number, number][] {
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
