// Squads: the units the commander orders as one. A squad moves in formation (each member routed to its own slot about
// the destination), attacks as one (when its target falls, the target's squadmates are next), and is reinforced at its
// side's base. Its members can be mechs, vehicles or infantry, and its spacing suits them.
import type { ScenarioSquad } from '../../assets';
import type { SeaUnit, World } from './world';

/** Metres between members in formation, by the squad's largest kind of unit. */
const SPACING = { mech: 18, vehicle: 14, infantry: 6 } as const;

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
  /** Infantry that have stood still long enough are dug in (harder to hit, behind sandbags). */
  dugIn = false;
  stillFor = 0;
  /** What a logistics squad's truck is busy with (building, unloading, filling up), for the HUD. */
  task: string | null = null;

  /** Its truck carries supply. */
  get isLogistics(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.supply !== null);
  }

  /** The Karnov can carry it: infantry, or a supply truck on its cargo arm. */
  get airliftable(): boolean {
    return this.isInfantry || this.isLogistics;
  }

  /** Everyone left in it is on foot (it can dig in, and be airlifted). */
  get isInfantry(): boolean {
    const alive = this.alive;
    return alive.length > 0 && alive.every((u) => u.kind === 'infantry');
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

  /** Members alive against its full size, weighted by their armour left (0..1). */
  get strength(): number {
    let s = 0;
    for (const u of this.units) if (u.alive) s += u.combat?.integrity ?? 1;
    return s / this.spec.units.length;
  }

  get missing(): number {
    return this.spec.units.length - this.alive.length;
  }

  /** The middle of its living members, or null when none are left. */
  centroid(): [number, number] | null {
    const alive = this.alive;
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
    const kinds = new Set(this.alive.map((u) => u.kind));
    return kinds.has('mech') ? SPACING.mech : kinds.has('vehicle') ? SPACING.vehicle : SPACING.infantry;
  }

  /** What it's doing, in a word or two, for the HUD. */
  status(now: number): string {
    if (this.respawnAt !== null) return `back in ${Math.max(0, Math.ceil(this.respawnAt - now))} s`;
    const alive = this.alive;
    if (this.airborne) return alive.some((u) => u.embarked) ? 'airlifted' : 'awaiting the Karnov';
    if (this.isLogistics) {
      const supply = `supply ${Math.floor(alive[0]!.supply ?? 0)}`;
      return this.task ? `${this.task} · ${supply}` : alive.some((u) => u.route.length) ? `moving · ${supply}` : supply;
    }
    if (this.dugIn) return alive.some((u) => u.target && u.target.alive) ? 'dug in, fighting' : 'dug in';
    if (alive.some((u) => u.target && u.combat && u.target.alive)) return 'fighting';
    if (this.order.kind === 'retreat') return 'falling back';
    if (alive.some((u) => u.route.length)) return 'moving';
    if (this.order.kind === 'attack') return 'attacking';
    return 'holding';
  }

  /**
   * Move in formation to a point: each member to a slot about it, the nearest members taking the middle slots. Returns
   * how many members have a way there.
   */
  move(world: World, x: number, z: number, retreat = false): number {
    this.order = retreat ? { kind: 'retreat', x, z } : { kind: 'move', x, z };
    const alive = this.alive.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const slots = formationSlots(alive.length, this.spacing);
    let routed = 0;
    alive.forEach((u, i) => {
      const [sx, sz] = world.openNear(x + slots[i]![0], z + slots[i]![1], u.moveClass);
      const grid = world.gridFor(u);
      const route = grid ? grid.findPath(u.x, u.z, sx, sz) : [[sx, sz] as [number, number]];
      // A move order ends an attack order; the squad still fires at what it passes.
      u.attackOrder = null;
      u.engaging = false;
      u.leash = { x, z };
      // No way there: it stops rather than carry on with the old order.
      if (route) {
        u.walkTo(route);
        routed++;
      } else u.stop();
    });
    return routed;
  }

  attack(target: SeaUnit): void {
    this.order = { kind: 'attack', target };
    for (const u of this.alive) {
      if (!u.combat) continue;
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
