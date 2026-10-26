// MC2's combat rules, on the data tools/convert.ts exports (combat.json): range bands, the chance to hit, where a shot
// lands, and what it breaks. From the original code: weaponInRange and calcAttackChance (code/mover.cpp), fireWeapon,
// calcHitLocation, handleWeaponHit, destroyBodyLocation and calcCriticalHit (code/mech.cpp), their GroundVehicle
// versions (code/gvehicl.cpp), and the constants in missions/gamesys.fit. There is no heat: the original compiles it out.
// Movement, range and target size don't change the chance to hit either; only the pilot's gunnery does.
import type { ArmorLocation, MechLocation, MechStats, RangeClass, SlotContent, VehicleLocation, VehicleStats, WeaponDef } from '../../assets';
import type { Rng } from './rng';

/** Seconds between combat decisions (gamesys CombatUpdateFrequency). */
export const COMBAT_TICK = 0.25;
/** The furthest a unit sees, metres (gamesys MaxVisualRange). */
export const SIGHT_RANGE = 225;
/** Without an order to attack it, a target further than this is dropped, metres (gamesys DefaultAttackRadius). */
export const ATTACK_RADIUS = 275;
/** A weapon fires at a target within this many degrees of where it points (half of gamesys FireArc). */
export const FIRE_ARC = 12.5;

/** Weapon range bands, metres (gamesys WeaponRanges). */
const RANGE_BANDS: Record<RangeClass, [number, number]> = { short: [0, 60], medium: [30, 120], long: [60, 180] };
/** Slack on both ends of a band: the diagonal of a movement-map cell (mclib/move.cpp MapCellDiagonal), metres. */
const RANGE_SLACK = 12.07;
/** The distances a unit may want to fight from, metres (gamesys WeaponRanges OptimalRangePoints): see bestRange. */
const OPTIMAL_RANGE_POINTS = [20, 45, 100, 100, 160];

export function inRange(range: RangeClass, distance: number): boolean {
  const [min, max] = RANGE_BANDS[range];
  return distance > min - RANGE_SLACK && distance <= max + RANGE_SLACK;
}

export type Arc = 'front' | 'left' | 'right' | 'rear';

/**
 * Which side of a unit at (x, z) facing `rotation` a shot from (fromX, fromZ) strikes. MC2 rotations are degrees, the
 * unit facing (sin r, cos r) in x (east) and z (south). For a mech this is the legs' facing, not the torso's.
 */
export function arcOf(x: number, z: number, rotation: number, fromX: number, fromZ: number): Arc {
  const r = (rotation * Math.PI) / 180;
  const fx = Math.sin(r);
  const fz = Math.cos(r);
  const vx = fromX - x;
  const vz = fromZ - z;
  // Facing south, a unit's left hand points east: its left is (fz, -fx).
  const theta = (Math.atan2(vx * fz - vz * fx, vx * fx + vz * fz) * 180) / Math.PI;
  if (Math.abs(theta) <= 45) return 'front';
  if (theta > 45 && theta < 135) return 'left';
  if (theta < -45 && theta > -135) return 'right';
  return 'rear';
}

/** A whole number in [0, n), as the original's RandomNumber. */
function roll(rng: Rng, n: number): number {
  return Math.floor(rng.next() * n);
}

export interface WeaponMount {
  def: WeaponDef;
  /** Where on a mech it's mounted (null on a vehicle). */
  location: MechLocation | null;
  /** Game time it can fire again, seconds. */
  readyAt: number;
  destroyed: boolean;
}

export type KillCause =
  | 'centre torso destroyed'
  | 'head destroyed'
  | 'legs destroyed'
  | 'engine destroyed'
  | 'cockpit destroyed'
  | 'pilot killed'
  | 'armour breached';

/** What one hit did. */
export interface HitReport {
  location: string;
  /** Locations it destroyed, the struck one first. */
  destroyed: string[];
  /** Components a critical hit destroyed ('engine', a weapon's name, ...). */
  criticals: string[];
  /** Ammunition that blew up. */
  exploded: boolean;
}

/** One side's unit in a fight: its weapons and ammunition, and (in a subclass) its armour. */
export abstract class Combatant {
  readonly weapons: WeaponMount[];
  /** Rounds left by ammunition component id. */
  readonly ammo = new Map<number, number>();
  /** Why it died, or null while it fights. */
  dead: KillCause | null = null;

  constructor(
    weapons: { def: WeaponDef; location: MechLocation | null }[],
    private readonly fullAmmo: Record<number, number>,
    /** The pilot's gunnery: the chance to hit, percent (the difficulty can raise it during a match). */
    public gunnery: number,
  ) {
    this.weapons = weapons.map((w) => ({ ...w, readyAt: 0, destroyed: false }));
    this.rearm(0);
  }

  /** Full ammunition, and every weapon ready at `now`. */
  rearm(now: number): void {
    for (const [id, rounds] of Object.entries(this.fullAmmo)) this.ammo.set(Number(id), rounds);
    for (const w of this.weapons) w.readyAt = now;
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /** Loaded and working (ignoring range, sight and aim). */
  ready(w: WeaponMount, now: number): boolean {
    return w.readyAt <= now && this.armed(w);
  }

  /** Working, with rounds left (ignoring when it can fire next). */
  armed(w: WeaponMount): boolean {
    return !w.destroyed && (w.def.ammo === null || (this.ammo.get(w.def.ammo) ?? 0) > 0);
  }

  /**
   * Fire a ready weapon: roll to hit, start its recycle (hit or miss), and spend a round, except on a Streak miss, which
   * launches nothing. True when it hits. `modifier` scales the gunnery before the clamp: 1 in MC2's rules, where nothing
   * else counts; the scenarios make small targets and infantry in cover harder to hit.
   */
  fire(w: WeaponMount, now: number, rng: Rng, modifier = 1): boolean {
    const chance = Math.trunc(Math.min(Math.max(this.gunnery * modifier, 5), 95));
    const hit = roll(rng, 100) < chance;
    w.readyAt = now + w.def.recycle;
    if ((hit || !w.def.streak) && w.def.ammo !== null) this.ammo.set(w.def.ammo, (this.ammo.get(w.def.ammo) ?? 0) - 1);
    return hit;
  }

  /**
   * Refit at a base (the scenarios' rule; MC2 has repair bays and trucks): a `rate` share of full armour, structure and
   * ammunition comes back a second. A location whose structure is whole again gets its components and weapons back.
   */
  refit(dt: number, rate: number): void {
    if (!this.alive) return;
    for (const [id, full] of Object.entries(this.fullAmmo)) {
      const key = Number(id);
      this.ammo.set(key, Math.min(full, (this.ammo.get(key) ?? 0) + full * rate * dt));
    }
    this.repair(rate * dt);
  }

  protected abstract repair(share: number): void;

  /** Damage it can still take, as a share of new (0..1). */
  abstract get integrity(): number;
  /** Where a shot striking this arc lands. */
  abstract hitLocation(arc: Arc, rng: Rng): string;
  /** Damage a location (one hitLocation gave). */
  abstract takeHit(location: string, damage: number, rng: Rng): HitReport;

  protected kill(cause: KillCause): void {
    if (this.dead === null) this.dead = cause;
  }
}

/** Middle-section hit tables by arc, percent (gamesys MechHitSectionTable; weapon fire always strikes the middle). */
const MECH_HIT_TABLE: Record<Arc, [ArmorLocation, number][]> = {
  front: [['HD', 2], ['CT', 20], ['LT', 15], ['RT', 15], ['LA', 12], ['RA', 12], ['LL', 12], ['RL', 12]],
  rear: [['HD', 2], ['LA', 12], ['RA', 12], ['LL', 12], ['RL', 12], ['RCT', 20], ['RLT', 15], ['RRT', 15]],
  left: [['HD', 2], ['CT', 15], ['LT', 20], ['RT', 12], ['LA', 20], ['RA', 8], ['LL', 19], ['RL', 4]],
  right: [['HD', 2], ['CT', 15], ['LT', 12], ['RT', 20], ['LA', 8], ['RA', 20], ['LL', 4], ['RL', 19]],
};
/** The rear torsos' armour covers the front torsos' structure. */
const ARMOR_BODY: Record<ArmorLocation, MechLocation> = {
  HD: 'HD', CT: 'CT', LT: 'LT', RT: 'RT', LA: 'LA', RA: 'RA', LL: 'LL', RL: 'RL', RCT: 'CT', RLT: 'LT', RRT: 'RT',
};
const REAR_ARMOR: Partial<Record<MechLocation, ArmorLocation>> = { CT: 'RCT', LT: 'RLT', RT: 'RRT' };
/** Where damage left over from a destroyed location goes, onto its front armour (gamesys TransferDamageTable). */
const TRANSFER: Partial<Record<MechLocation, MechLocation>> = { LA: 'LT', LL: 'LT', RA: 'RT', RL: 'RT', LT: 'CT', RT: 'CT' };
/** A d100 under these gives 0, 1, 2 critical hits; over the last, 3 in a torso, or the whole head or limb (gamesys). */
const CRITICAL_TABLE = [58, 83, 97];
const LOCATION_NAME: Record<ArmorLocation, string> = {
  HD: 'head', CT: 'centre torso', LT: 'left torso', RT: 'right torso', LA: 'left arm', RA: 'right arm', LL: 'left leg', RL: 'right leg',
  RCT: 'rear centre torso', RLT: 'rear left torso', RRT: 'rear right torso',
};
/** Wounds that kill a pilot (code/warrior.cpp). */
const DEADLY_WOUNDS = 6;
const BODY_LOCATIONS: MechLocation[] = ['HD', 'CT', 'LT', 'RT', 'LA', 'RA', 'LL', 'RL'];
const ARMOR_LOCATIONS: ArmorLocation[] = [...BODY_LOCATIONS, 'RCT', 'RLT', 'RRT'];

export class MechCombat extends Combatant {
  readonly armor: Record<ArmorLocation, number>;
  readonly structure: Record<MechLocation, number>;
  wounds = 0;
  /**
   * Its centre torso gave way to the hit that first broke into it: MC2 blows such a mech apart (code/mech.cpp,
   * destroyBodyLocation: it explodes within the moment of centerTorsoBlowTime), where one whose centre torso is worn
   * through, or that falls to anything else, is only disabled, and can be recovered (recovery.ts).
   */
  blownApart = false;
  private hits = 0;
  /** The hit that first broke into its centre torso's structure (-1 until one has). */
  private centreBrokenBy = -1;
  private readonly components: Record<MechLocation, (SlotContent & { hit: boolean })[]>;
  private readonly maxTotal: number;

  constructor(
    readonly stats: MechStats,
    weapons: Record<string, WeaponDef>,
    /** An ammunition's damage a round, and its rounds a pack (a ton: compbas.csv). */
    private readonly explosive: (ammo: number) => { perRound: number; perPack: number },
    gunnery: number,
  ) {
    super(
      stats.weapons.map((w) => ({ def: weapons[w.id]!, location: w.location })),
      stats.ammo,
      gunnery,
    );
    this.armor = { ...stats.armor };
    this.structure = { ...stats.structure };
    this.components = Object.fromEntries(Object.entries(stats.slots).map(([l, list]) => [l, list.map((c) => ({ ...c, hit: false }))])) as Record<
      MechLocation,
      (SlotContent & { hit: boolean })[]
    >;
    this.maxTotal = sum(stats.armor) + sum(stats.structure);
  }

  get integrity(): number {
    return this.alive ? (sum(this.armor) + sum(this.structure)) / this.maxTotal : 0;
  }

  /**
   * How far its sensors pick up enemies out of sight, metres: none once a critical hit has taken them out or their
   * location is gone (code/contact.cpp: a disabled sensor sees nothing).
   */
  get sensorRange(): number {
    if (!this.alive || this.stats.sensorRange <= 0) return 0;
    for (const l of Object.keys(this.components) as MechLocation[]) {
      if (this.components[l].some((c) => c.kind === 'sensor' && (c.hit || this.structure[l] <= 0))) return 0;
    }
    return this.stats.sensorRange;
  }

  /**
   * It has armour, structure or ammunition to make up, but for arms it has lost (Mover::needsRefit, code/mover.cpp).
   */
  get needsRefit(): boolean {
    if (!this.alive) return false;
    if (ARMOR_LOCATIONS.some((l) => !this.armGone(l) && this.armor[l] < this.stats.armor[l])) return true;
    if (BODY_LOCATIONS.some((l) => !this.armGone(l) && this.structure[l] < this.stats.structure[l])) return true;
    return Object.entries(this.stats.ammo).some(([id, full]) => (this.ammo.get(Number(id)) ?? 0) < full);
  }

  /**
   * One cycle of a repair truck's work (Mover::refit, code/mover.cpp): of the cycle's `points`, a third goes to armour
   * and structure, shared evenly among the locations short of either (a point of armour or structure for a point:
   * gamesys RefitVehicleArmorCost, RefitVehicleInternalCost), and a third to ammunition, shared among the kinds short
   * (a ton for a point: RefitVehiclePointsToAmmo). Arms it has lost aren't mended, nor components a critical hit has
   * taken out. Returns the points used, at most `available`.
   */
  fieldRefit(available: number, points: number): number {
    if (!this.alive) return 0;
    const share = points / 3;
    let left = available;
    const armour = ARMOR_LOCATIONS.filter((l) => !this.armGone(l) && this.armor[l] < this.stats.armor[l]);
    const structure = BODY_LOCATIONS.filter((l) => !this.armGone(l) && this.structure[l] < this.stats.structure[l]);
    const repairs = armour.length + structure.length;
    for (const l of armour) {
      const used = Math.min(share / repairs, left, this.stats.armor[l] - this.armor[l]);
      this.armor[l] += used;
      left -= used;
    }
    for (const l of structure) {
      const used = Math.min(share / repairs, left, this.stats.structure[l] - this.structure[l]);
      this.structure[l] += used;
      left -= used;
    }
    const short = Object.entries(this.stats.ammo).filter(([id, full]) => (this.ammo.get(Number(id)) ?? 0) < full);
    for (const [key, full] of short) {
      const id = Number(key);
      const perTon = Math.max(this.explosive(id).perPack, 1);
      const have = this.ammo.get(id) ?? 0;
      const used = Math.min(share / short.length, left, (full - have) / perTon);
      this.ammo.set(id, Math.min(full, have + used * perTon));
      left -= used;
    }
    return available - left;
  }

  /**
   * Made whole from a disabled mech's wreck by a recovery team (Mover::recover, code/mover.cpp): its structure mended
   * but for arms it lost, every component working again (those arms' aside), its armour and ammunition as they were,
   * and a new pilot.
   */
  recoverFrom(wreck: MechCombat): void {
    for (const l of ARMOR_LOCATIONS) this.armor[l] = wreck.armor[l];
    for (const [id, rounds] of wreck.ammo) this.ammo.set(id, rounds);
    for (const l of ['LA', 'RA'] as const) {
      if (wreck.structure[l] > 0) continue;
      this.structure[l] = 0;
      this.armor[l] = 0;
      for (const c of this.components[l]) c.hit = true;
      for (const w of this.weapons) if (w.location === l) w.destroyed = true;
    }
  }

  /** An arm (or its armour) the mech has lost: MC2 mends neither. */
  private armGone(l: ArmorLocation): boolean {
    return (l === 'LA' || l === 'RA') && this.structure[l] <= 0;
  }

  /** The location's armour and structure as a share of new (a destroyed location is 0). */
  locationIntegrity(l: MechLocation): number {
    const rear = REAR_ARMOR[l];
    const now = this.armor[l] + this.structure[l] + (rear ? this.armor[rear] : 0);
    const max = this.stats.armor[l] + this.stats.structure[l] + (rear ? this.stats.armor[rear] : 0);
    return max ? now / max : 0;
  }

  protected repair(share: number): void {
    for (const l of Object.keys(this.armor) as ArmorLocation[]) this.armor[l] = Math.min(this.stats.armor[l], this.armor[l] + this.stats.armor[l] * share);
    for (const l of Object.keys(this.structure) as MechLocation[]) {
      const max = this.stats.structure[l];
      if (this.structure[l] >= max) continue;
      this.structure[l] = Math.min(max, this.structure[l] + max * share);
      if (this.structure[l] < max) continue;
      for (const c of this.components[l]) c.hit = false;
      for (const w of this.weapons) if (w.location === l) w.destroyed = false;
    }
  }

  hitLocation(arc: Arc, rng: Rng): ArmorLocation {
    let r = roll(rng, 100);
    for (const [location, percent] of MECH_HIT_TABLE[arc]) {
      if (r < percent) return location;
      r -= percent;
    }
    return 'CT';
  }

  takeHit(location: string, damage: number, rng: Rng): HitReport {
    const report: HitReport = { location: LOCATION_NAME[location as ArmorLocation], destroyed: [], criticals: [], exploded: false };
    this.hits++;
    if (ARMOR_BODY[location as ArmorLocation] === 'HD' && damage >= 2) this.wound(1);
    this.damage(location as ArmorLocation, damage, rng, report);
    return report;
  }

  /** Armour, then structure (with a chance of critical hits while the location holds), then the next location in. */
  private damage(location: ArmorLocation, amount: number, rng: Rng, report: HitReport): void {
    if (!this.alive) return;
    const body = ARMOR_BODY[location];
    let left = amount;
    if (this.armor[location] > 0) {
      if (left <= this.armor[location]) {
        this.armor[location] -= left;
        return;
      }
      left -= this.armor[location];
      this.armor[location] = 0;
    }
    if (this.structure[body] > 0) {
      if (body === 'CT' && this.centreBrokenBy < 0) this.centreBrokenBy = this.hits;
      if (left < this.structure[body]) {
        this.structure[body] -= left;
        this.critical(body, rng, report);
        return;
      }
      left -= this.structure[body];
      this.destroy(body, report);
    }
    const next = TRANSFER[body];
    if (next && left > 0) this.damage(next, left, rng, report);
  }

  private critical(body: MechLocation, rng: Rng, report: HitReport): void {
    const components = this.components[body];
    const spaces = components.reduce((s, c) => s + c.size, 0);
    if (!spaces) return;
    const r = roll(rng, 100);
    if (r < CRITICAL_TABLE[0]!) return;
    const torso = body === 'CT' || body === 'LT' || body === 'RT';
    const count = r < CRITICAL_TABLE[1]! ? 1 : r < CRITICAL_TABLE[2]! ? 2 : torso ? 3 : 0;
    if (!count) return this.destroy(body, report);
    for (let i = 0; i < count && this.alive; i++) {
      let pick = roll(rng, spaces);
      const c = components.find((c) => (pick -= c.size) < 0);
      if (!c || c.hit) continue;
      c.hit = true;
      if (c.kind === 'engine') {
        report.criticals.push('engine');
        this.kill('engine destroyed');
      } else if (c.kind === 'cockpit') {
        report.criticals.push('cockpit');
        this.kill('cockpit destroyed');
      } else if (c.kind === 'weapon') {
        const w = this.weapons[c.index];
        if (w && !w.destroyed) {
          w.destroyed = true;
          report.criticals.push(w.def.name);
        }
      } else if (c.kind === 'ammo') {
        this.explode(body, c.ammo, report);
      }
    }
  }

  /** A pack's remaining rounds go off inside the location; CASE vents what the structure doesn't take. */
  private explode(body: MechLocation, ammo: number, report: HitReport): void {
    const { perRound, perPack } = this.explosive(ammo);
    const rounds = Math.min(this.ammo.get(ammo) ?? 0, perPack);
    if (rounds <= 0) return;
    this.ammo.set(ammo, (this.ammo.get(ammo) ?? 0) - rounds);
    report.exploded = true;
    report.criticals.push('ammunition');
    this.wound(2);
    const blast = rounds * perRound;
    if (body === 'CT' && this.centreBrokenBy < 0) this.centreBrokenBy = this.hits;
    if (blast >= this.structure[body]) this.destroy(body, report);
    else this.structure[body] -= blast;
  }

  private destroy(body: MechLocation, report: HitReport): void {
    this.structure[body] = 0;
    this.armor[body] = 0;
    const rear = REAR_ARMOR[body];
    if (rear) this.armor[rear] = 0;
    for (const w of this.weapons) if (w.location === body) w.destroyed = true;
    report.destroyed.push(LOCATION_NAME[body]);
    // A side torso takes its arm with it.
    if (body === 'LT' && this.structure.LA > 0) this.destroy('LA', report);
    if (body === 'RT' && this.structure.RA > 0) this.destroy('RA', report);
    if (body === 'CT') {
      if (this.alive && this.centreBrokenBy === this.hits) this.blownApart = true;
      this.kill('centre torso destroyed');
    }
    if (body === 'HD') this.kill('head destroyed');
    if (this.structure.LL <= 0 && this.structure.RL <= 0) this.kill('legs destroyed');
  }

  private wound(n: number): void {
    this.wounds += n;
    if (this.wounds >= DEADLY_WOUNDS) this.kill('pilot killed');
  }
}

export class VehicleCombat extends Combatant {
  readonly armor: Record<VehicleLocation, number>;
  readonly structure: Record<VehicleLocation, number>;

  constructor(
    readonly stats: VehicleStats,
    weapons: Record<string, WeaponDef>,
    gunnery: number,
  ) {
    super(
      stats.weapons.map((w) => ({ def: weapons[w.id]!, location: null })),
      stats.ammo,
      gunnery,
    );
    this.armor = { ...stats.armor };
    this.structure = { ...stats.structure };
  }

  /** A vehicle dies when any one side gives way, so this is its weakest side. */
  get integrity(): number {
    if (!this.alive) return 0;
    const sides = Object.keys(this.armor) as VehicleLocation[];
    return Math.min(...sides.map((s) => (this.armor[s] + this.structure[s]) / (this.stats.armor[s] + this.stats.structure[s] || 1)));
  }

  protected repair(share: number): void {
    for (const l of Object.keys(this.armor) as VehicleLocation[]) {
      this.armor[l] = Math.min(this.stats.armor[l], this.armor[l] + this.stats.armor[l] * share);
      this.structure[l] = Math.min(this.stats.structure[l], this.structure[l] + this.stats.structure[l] * share);
    }
  }

  /** The turret takes a shot when the average of two d100 rolls is 70 or more (17.7%); otherwise the side it struck. */
  hitLocation(arc: Arc, rng: Rng): VehicleLocation {
    return (roll(rng, 100) + roll(rng, 100)) / 2 >= 70 ? 'turret' : arc;
  }

  /** Armour, then structure; a vehicle is destroyed when any location's structure is gone. No transfer, no criticals. */
  takeHit(location: string, damage: number): HitReport {
    const l = location as VehicleLocation;
    const report: HitReport = { location: l, destroyed: [], criticals: [], exploded: false };
    if (!this.alive) return report;
    let left = damage;
    if (this.armor[l] > 0) {
      if (left <= this.armor[l]) {
        this.armor[l] -= left;
        return report;
      }
      left -= this.armor[l];
      this.armor[l] = 0;
    }
    this.structure[l] = Math.max(this.structure[l] - left, 0);
    if (this.structure[l] <= 0) {
      report.destroyed.push(l);
      this.kill('armour breached');
    }
    return report;
  }
}

/**
 * The distance a unit wants to fight from, metres (Mover::calcFireRanges, code/mover.cpp): of MC2's range points, the
 * one where its working, loaded weapons do the most damage a second (a weapon counts at a point above the least of its
 * band and up to the most), the further on a tie. A brawler with only short-range weapons wants 20 m, an LRM carrier
 * 160. 0 when it has nothing to fire.
 */
export function bestRange(unit: Combatant): number {
  let best = 0;
  let bestRate = 0;
  for (const d of OPTIMAL_RANGE_POINTS) {
    let rate = 0;
    for (const w of unit.weapons) {
      const [min, max] = RANGE_BANDS[w.def.range];
      if (unit.armed(w) && d > min && d <= max) rate += w.def.damage / w.def.recycle;
    }
    if (rate > 0 && rate >= bestRate - 1e-6) {
      best = d;
      bestRate = rate;
    }
  }
  return best;
}

/** The furthest a unit's working, loaded weapons reach, metres (Mover::getMaxFireRange); 0 when it has none. */
export function maxRange(unit: Combatant): number {
  let most = 0;
  for (const w of unit.weapons) if (unit.armed(w)) most = Math.max(most, RANGE_BANDS[w.def.range][1]);
  return most;
}

function sum(record: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(record)) s += v;
  return s;
}
