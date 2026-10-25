// Suppression: this project's rule, after the game Squad (MC2 has none: a shot's chance is its pilot's gunnery alone,
// and a miss does nothing). Every shot that lands, hit or miss, suppresses the shooter's enemies near where it lands: by
// its damage, more for missiles' explosions and machine-gun bursts, less for beams; soldiers take it fully, vehicles
// less than half, mechs a quarter. It fades a little after the fire stops.
//
// A suppressed unit aims worse. Soldiers suppressed enough are pinned: they go to ground (a little harder to hit), stop
// where they are, don't count toward taking a point, and stay down until the fire has slackened well off. Soldiers dug
// in behind sandbags, or in woods, take less of it.
import type { WeaponMount } from '../sim/combat';
import type { MoveGrid } from '../sim/move-grid';
import type { SeaUnit, UnitKind } from './world';

export const SUPPRESSION = {
  /** Suppression from a point of damage landing right by a soldier in the open (1 is full). */
  perDamage: 0.04,
  /** By kind of shot: missiles' explosions, shells, a machine gun's burst, beams, a called-in strike's bursts. */
  weapon: { missile: 2, shell: 1, mg: 3, beam: 0.6, strike: 2 },
  /** How far from where it lands a shot suppresses, metres (fading to nothing there). */
  radius: { missile: 10, shell: 6, mg: 5, beam: 4, strike: 30 },
  /** Share a unit takes, by kind. */
  takes: { infantry: 1, vehicle: 0.4, mech: 0.25, structure: 0 } satisfies Record<UnitKind, number>,
  /** Share soldiers take dug in, and in woods. */
  dugIn: 0.4,
  cover: 0.7,
  /** Seconds after the last shot before it fades, and how much fades a second then. */
  holdS: 2,
  fadePerS: 0.15,
  /** Soldiers are pinned at this much, and get up again once it's below the second. */
  pinAt: 0.6,
  releaseAt: 0.3,
  /** Share of its chance to hit a unit loses at full suppression, by kind. */
  aimLoss: { infantry: 0.6, vehicle: 0.5, mech: 0.4, structure: 0 } satisfies Record<UnitKind, number>,
  /** Share of the chance to hit a pinned soldier (they're on the ground). */
  prone: 0.8,
};

type Shot = keyof typeof SUPPRESSION.weapon;
/** What suppress() needs of a weapon (a strike's burst passes as a missile). */
type WeaponDef = Pick<WeaponMount['def'], 'kind' | 'damage' | 'name'>;

function shotKind(w: WeaponDef): Shot {
  if (w.name === 'strike') return 'strike';
  if (w.kind === 'missile') return 'missile';
  if (w.kind === 'energy') return 'beam';
  return w.name.toLowerCase().includes('mg') ? 'mg' : 'shell';
}

/** A shot from `by` lands at `at` (x, z): its enemies near there are suppressed. */
export function suppress(units: readonly SeaUnit[], w: WeaponDef, x: number, z: number, by: { team: number }, now: number, grid: MoveGrid | null): void {
  const kind = shotKind(w);
  const radius = SUPPRESSION.radius[kind];
  const amount = w.damage * SUPPRESSION.perDamage * SUPPRESSION.weapon[kind];
  for (const u of units) {
    if (u.team === by.team || !u.alive || !u.combat || u.embarked) continue;
    const d = Math.hypot(u.x - x, u.z - z);
    if (d >= radius) continue;
    let share = SUPPRESSION.takes[u.kind] * (1 - d / radius);
    if (u.kind === 'infantry') {
      if (u.squad?.dugIn) share *= SUPPRESSION.dugIn;
      else if (grid?.forestAt(u.x, u.z)) share *= SUPPRESSION.cover;
    }
    if (share <= 0) continue;
    u.suppression = Math.min(1, u.suppression + amount * share);
    u.suppressedAt = now;
  }
}

/** Suppression fades once the fire stops; soldiers are pinned, and get up again. */
export function settle(units: readonly SeaUnit[], dt: number, now: number): void {
  for (const u of units) {
    if (!u.alive) {
      u.suppression = 0;
      u.pinned = false;
      continue;
    }
    if (u.suppression > 0 && now - u.suppressedAt > SUPPRESSION.holdS) u.suppression = Math.max(0, u.suppression - SUPPRESSION.fadePerS * dt);
    if (u.kind !== 'infantry') continue;
    if (!u.pinned && u.suppression >= SUPPRESSION.pinAt) u.pinned = true;
    else if (u.pinned && u.suppression < SUPPRESSION.releaseAt) u.pinned = false;
  }
}

/** The share of its chance to hit that a unit's suppression leaves it. */
export function aimShare(u: SeaUnit): number {
  return 1 - SUPPRESSION.aimLoss[u.kind] * u.suppression;
}
