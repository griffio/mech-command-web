// MC2 combat data: the component table (objects/compbas.csv, mclib/cmponent.cpp), mech stats files
// (objects/<mech>.csv, code/mech.cpp BattleMech::init), vehicle object files (code/gvehicl.cpp) and pilot profiles
// (missions/warriors/<profile>.fit). Rules that are code, not data, live in src/sea/sim/combat.ts.
import type { Fit } from './fit.ts';
import type { SourceData } from './srcdata.ts';

export type RangeClass = 'short' | 'medium' | 'long';
export type WeaponKind = 'energy' | 'ballistic' | 'missile';

export interface WeaponDef {
  id: number;
  name: string;
  kind: WeaponKind;
  range: RangeClass;
  damage: number;
  /** Seconds between shots. */
  recycle: number;
  /** Component id of its ammunition, or null for unlimited (energy weapons, the MG Array). */
  ammo: number | null;
  /** Streak missiles: a miss launches nothing and spends no ammunition. */
  streak: boolean;
  /** LRMs may fire without their own line of sight when a teammate sees the target. */
  indirect: boolean;
}

export interface AmmoDef {
  id: number;
  name: string;
  shotsPerPack: number;
  /** Damage per round left in a pack when it explodes. */
  explosive: number;
}

export type MechLocation = 'HD' | 'CT' | 'LT' | 'RT' | 'LA' | 'RA' | 'LL' | 'RL';
export type ArmorLocation = MechLocation | 'RCT' | 'RLT' | 'RRT';

/**
 * One component in a location, and what a critical hit to it destroys. A critical hit picks a component with odds by
 * its size in crit slots (mech.cpp calcCriticalHit).
 */
export type SlotContent = ({ kind: 'engine' } | { kind: 'cockpit' } | { kind: 'weapon'; index: number } | { kind: 'ammo'; ammo: number } | { kind: 'other' }) & {
  size: number;
};

export interface MechStats {
  name: string;
  tonnage: number;
  /** Design top speed, m/s (the walking speed comes from the animation data). */
  runSpeed: number;
  /** How far the torso turns either way from the legs, degrees, and how fast, degrees a second. */
  torsoYaw: number;
  torsoYawRate: number;
  armor: Record<ArmorLocation, number>;
  structure: Record<MechLocation, number>;
  weapons: { id: number; location: MechLocation }[];
  /** Rounds per ammunition component id. */
  ammo: Record<number, number>;
  /** The components in each location, in slot order. */
  slots: Record<MechLocation, SlotContent[]>;
}

export type VehicleLocation = 'front' | 'left' | 'right' | 'rear' | 'turret';

export interface VehicleStats {
  name: string;
  tonnage: number;
  speed: number;
  /** A hovercraft crosses water, deep or shallow ([General] HoverCraft). */
  hover: boolean;
  /** Refit points it carries (a repair truck's 500): the supply a truck brings. */
  refitPoints: number;
  /** How far the turret turns either way, degrees (0: the hull must face the target). */
  turretYaw: number;
  armor: Record<VehicleLocation, number>;
  structure: Record<VehicleLocation, number>;
  weapons: { id: number }[];
  ammo: Record<number, number>;
}

const MECH_LOCATIONS: MechLocation[] = ['HD', 'CT', 'LT', 'RT', 'LA', 'RA', 'LL', 'RL'];
/** CSV columns of each location (mech.cpp stupidNewSageColumns), 1-based; the rear torsos follow in 10-12. */
const LOCATION_COLUMN: Record<ArmorLocation, number> = { HD: 2, LA: 3, RA: 4, LT: 5, RT: 6, CT: 7, LL: 8, RL: 9, RLT: 10, RRT: 11, RCT: 12 };
/** Each Armor Plating component adds 32 points split by these shares, truncated (mech.cpp:295-306). */
const PLATING_SHARE: Record<ArmorLocation, number> = { HD: 0, CT: 0.17, LT: 0.125, RT: 0.125, LA: 0.12, RA: 0.12, LL: 0.13, RL: 0.13, RCT: 0.03, RLT: 0.02, RRT: 0.02 };
const PLATING_ID = 25;
const VARIANT_ROWS = 97;
/** Ids of the LRM racks the game treats as indirect-fire weapons (gamesys.fit IndirectFireWeaponComponentIndex). */
const INDIRECT_FIRE = new Set([120, 123, 130, 160]);

export class ComponentTable {
  readonly weapons = new Map<number, WeaponDef>();
  readonly ammo = new Map<number, AmmoDef>();
  private readonly types = new Map<number, string>();
  private readonly sizes = new Map<number, number>();

  constructor(csv: string) {
    for (const row of parseCsv(csv).slice(1)) {
      const id = parseInt(row[0] ?? '', 10);
      if (!Number.isFinite(id)) continue;
      const type = (row[1] ?? '').trim();
      this.types.set(id, type);
      this.sizes.set(id, num(row[3]));
      const name = (row[2] ?? '').trim();
      if (type === 'Ammo') {
        this.ammo.set(id, { id, name, shotsPerPack: num(row[4]), explosive: num(row[7]) });
      } else if (type.endsWith('Weapon')) {
        const ammoType = (row[19] ?? '').trim().toLowerCase();
        const ammoId = parseInt(row[22] ?? '', 10);
        this.weapons.set(id, {
          id,
          name,
          kind: type === 'EnergyWeapon' ? 'energy' : type === 'BallisticWeapon' ? 'ballistic' : 'missile',
          range: ((row[10] ?? 'short').trim().toLowerCase() as RangeClass) || 'short',
          damage: num(row[7]),
          recycle: num(row[4]),
          ammo: ammoType === '0' || ammoType === 'na' || !ammoId ? null : ammoId,
          streak: ammoType === 'st' || (parseInt(row[20] ?? '0', 10) & 1) === 1,
          indirect: INDIRECT_FIRE.has(id),
        });
      }
    }
  }

  type(id: number): string {
    return this.types.get(id) ?? '';
  }

  /** Crit slots the component fills. */
  size(id: number): number {
    return this.sizes.get(id) ?? 0;
  }
}

/** Variant 0 of a mech's stats file. */
export function readMechStats(csv: string, components: ComponentTable): MechStats {
  const rows = parseCsv(csv);
  const cell = (r: number, c: number) => (rows[r - 1]?.[c - 1] ?? '').trim();
  const v = 0;
  const off = v * VARIANT_ROWS;
  const structure = Object.fromEntries(MECH_LOCATIONS.map((l) => [l, num(cell(17, LOCATION_COLUMN[l]))])) as Record<MechLocation, number>;
  const baseArmor = Object.fromEntries(Object.entries(LOCATION_COLUMN).map(([l, c]) => [l, num(cell(18, c))])) as Record<ArmorLocation, number>;

  // The items list, and which location's crit slots hold each item.
  const items: { id: number; row: number }[] = [];
  for (let it = 0; it < 72; it++) {
    const r = 26 + off + it;
    if (!cell(r, 1).startsWith('Item')) break;
    items.push({ id: parseInt(cell(r, 5), 10), row: r });
  }
  const slotItems = Object.fromEntries(MECH_LOCATIONS.map((l) => [l, [] as number[]])) as Record<MechLocation, number[]>;
  for (let s = 0; s < 12; s++) {
    for (const l of MECH_LOCATIONS) {
      const value = cell(102 + off + s, LOCATION_COLUMN[l]);
      if (value !== '' && Number.isFinite(parseInt(value, 10))) slotItems[l].push(parseInt(value, 10));
    }
  }
  const locationOf = (item: number): MechLocation | null => MECH_LOCATIONS.find((l) => slotItems[l].includes(item)) ?? null;

  let plates = 0;
  const weapons: MechStats['weapons'] = [];
  const weaponIndexOfItem = new Map<number, number>();
  const ammo: Record<number, number> = {};
  items.forEach(({ id }, item) => {
    if (!Number.isFinite(id) || id === 255 || id === 0) return;
    if (id === PLATING_ID) plates++;
    else if (components.weapons.has(id)) {
      const location = locationOf(item);
      if (!location) return;
      weaponIndexOfItem.set(item, weapons.length);
      weapons.push({ id, location });
    } else if (components.ammo.has(id)) {
      ammo[id] = (ammo[id] ?? 0) + components.ammo.get(id)!.shotsPerPack;
    }
  });
  const armor = Object.fromEntries(
    Object.entries(baseArmor).map(([l, a]) => [l, Math.trunc(a + PLATING_SHARE[l as ArmorLocation] * 32 * plates)]),
  ) as Record<ArmorLocation, number>;

  const slots = Object.fromEntries(
    MECH_LOCATIONS.map((l) => [
      l,
      slotItems[l].map((item): SlotContent => {
        const id = items[item]?.id ?? 0;
        const type = components.type(id);
        const size = components.size(id);
        if (type === 'Engine') return { kind: 'engine', size };
        if (type === 'Cockpit') return { kind: 'cockpit', size };
        if (weaponIndexOfItem.has(item)) return { kind: 'weapon', index: weaponIndexOfItem.get(item)!, size };
        if (components.ammo.has(id)) return { kind: 'ammo', ammo: id, size };
        return { kind: 'other', size };
      }),
    ]),
  ) as Record<MechLocation, SlotContent[]>;

  return {
    name: cell(3, 2),
    tonnage: num(cell(3, 5)),
    runSpeed: num(cell(7, 5)),
    torsoYaw: num(cell(9, 5)),
    torsoYawRate: num(cell(8, 5)),
    armor,
    structure,
    weapons,
    ammo,
    slots,
  };
}

/** A ground vehicle's object file. */
export function readVehicleStats(fit: Fit, components: ComponentTable): VehicleStats {
  const sections: [VehicleLocation, string][] = [
    ['front', 'Front'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['rear', 'Rear'],
    ['turret', 'Turret'],
  ];
  const weapons: VehicleStats['weapons'] = [];
  const ammo: Record<number, number> = {};
  for (let i = 0; i < 64; i++) {
    const id = fit.num(`Item:${i}`, 'MasterID', -1);
    if (id < 0) continue;
    if (components.weapons.has(id)) weapons.push({ id });
    else if (components.ammo.has(id)) ammo[id] = (ammo[id] ?? 0) + components.ammo.get(id)!.shotsPerPack;
  }
  return {
    name: fit.str('ObjectType', 'Name'),
    tonnage: fit.num('General', 'CurTonnage'),
    speed: fit.num('VehicleDynamics', 'MaxVelocity'),
    hover: fit.bool('General', 'HoverCraft'),
    refitPoints: Math.max(0, fit.num('General', 'RefitPoints')),
    turretYaw: fit.num('VehicleDynamics', 'MaxTurretYaw'),
    armor: Object.fromEntries(sections.map(([k, s]) => [k, fit.num(s, 'MaxArmorPoints')])) as Record<VehicleLocation, number>,
    structure: Object.fromEntries(sections.map(([k, s]) => [k, fit.num(s, 'CurInternalStructure', fit.num('InternalStructure', s, 1))])) as Record<
      VehicleLocation,
      number
    >,
    weapons,
    ammo,
  };
}

/** An air or artillery strike (objects/artbig.fit, artsml.fit: [Artillery], code/artlry.cpp), in seconds and metres. */
export interface StrikeStats {
  /** Seconds from the call to the strike landing. */
  timeToImpact: number;
  /** Damage of each hit. */
  damage: number;
  /** Units within the major range take the major number of hits, those within the minor range the minor number. */
  majorRange: number;
  majorHits: number;
  minorRange: number;
  minorHits: number;
  /** Where its explosions burst about the spot, and when (the engine reads but doesn't use these; the game does). */
  explosions: { delay: number; x: number; z: number }[];
  /** Up to this far further each way, at random. */
  scatter: number;
}

export function readStrike(fit: Fit): StrikeStats {
  const n = fit.num('Artillery', 'NumExplosions', 0);
  const explosions: StrikeStats['explosions'] = [];
  // NumExplosions counts beyond the first: ARTBig lists 13, numbered 0..12.
  for (let i = 0; i <= n; i++) {
    if (fit.get('Artillery', `ExplosionDelay${i}`) === undefined) continue;
    explosions.push({
      delay: fit.num('Artillery', `ExplosionDelay${i}`),
      x: fit.num('Artillery', `ExplosionOffsetX${i}`),
      // MC2's y is north; the game's z is south.
      z: -fit.num('Artillery', `ExplosionOffsetY${i}`),
    });
  }
  return {
    timeToImpact: fit.num('Artillery', 'NominalTimeToImpact', 7),
    damage: fit.num('Artillery', 'NominalDamage'),
    majorRange: fit.num('Artillery', 'nominalMajorRange'),
    majorHits: fit.num('Artillery', 'nominalMajorHits'),
    minorRange: fit.num('Artillery', 'nominalMinorRange'),
    minorHits: fit.num('Artillery', 'nominalMinorHits'),
    explosions,
    scatter: fit.num('Artillery', 'ExplosionRandomOffsetX', 0),
  };
}

/**
 * A turret's object file ([TurretData]): its damage level as structure on every side (no armour), its weapons
 * (WeaponType, WeaponType1, ...) with ammunition that never runs out, and its gunner's skill.
 */
export function readTurretStats(fit: Fit, components: ComponentTable): { stats: VehicleStats; gunnery: number } {
  const hp = fit.num('TurretData', 'DmgLevel', 20);
  const sides: VehicleLocation[] = ['front', 'left', 'right', 'rear', 'turret'];
  const weapons: VehicleStats['weapons'] = [];
  const ammo: Record<number, number> = {};
  for (const key of ['WeaponType', 'WeaponType1', 'WeaponType2', 'WeaponType3']) {
    const id = fit.num('TurretData', key, -1);
    const w = components.weapons.get(id);
    if (!w) continue;
    weapons.push({ id });
    if (w.ammo !== null) ammo[w.ammo] = 1e6;
  }
  return {
    stats: {
      name: fit.str('ObjectType', 'Name'),
      tonnage: fit.num('TurretData', 'Tonnage'),
      speed: 0,
      hover: false,
      refitPoints: 0,
      turretYaw: 360,
      armor: Object.fromEntries(sides.map((s) => [s, 0])) as Record<VehicleLocation, number>,
      structure: Object.fromEntries(sides.map((s) => [s, hp])) as Record<VehicleLocation, number>,
      weapons,
      ammo,
    },
    gunnery: fit.num('TurretData', 'PilotSkill', 50),
  };
}

/** A pilot's gunnery skill: the base chance to hit, in percent (code/warrior.cpp, Mover::calcAttackChance). */
export function readGunnery(src: SourceData, profile: string): number | null {
  const rel = `missions/warriors/${profile}.fit`;
  if (!src.has(rel)) return null;
  return src.fit(rel).num('Skills', 'Gunnery', 40);
}

function num(s: string | undefined): number {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : 0;
}

/** A plain CSV reader: commas, double-quoted fields with doubled quotes inside. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
