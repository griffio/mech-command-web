// Mission data: missions/<name>.fit (units, lighting) and missions/<name>.pak
// (terrain grid, placed objects, movement map), plus the chain from object
// type numbers to the model files they use.
import type { Fit } from './fit.ts';
import { readPak } from './pak.ts';
import type { SourceData } from './srcdata.ts';

export const WORLD_UNITS_PER_VERTEX = 128; // mclib/terrain.cpp
export const WORLD_UNITS_PER_METER = 5.01; // mclib/terrain.cpp

/** code/dobjtype.h ObjectTypeClass */
export const ObjectClass = {
  Tree: 0,
  Building: 1,
  Mech: 2,
  Vehicle: 3,
  TerrainObject: 11,
  Bridge: 15,
  TreeBuilding: 18,
  TrainCar: 20,
  Turret: 21,
  Gate: 22,
} as const;

/** Gesture file suffixes (mclib/mech3d.cpp MechAnimationNames) and the clip names we give them. */
export const MECH_GESTURES: { suffix: string; clip: string; gesture: number }[] = [
  { suffix: 'StandToPark', clip: 'standToPark', gesture: 0 },
  { suffix: 'ParkToStand', clip: 'parkToStand', gesture: 1 },
  { suffix: 'STtoWK', clip: 'standToWalk', gesture: 3 },
  { suffix: 'Walk', clip: 'walk', gesture: 4 },
  { suffix: 'WKtoRN', clip: 'walkToRun', gesture: 6 },
  { suffix: 'Run', clip: 'run', gesture: 7 },
  { suffix: 'RNToWK', clip: 'runToWalk', gesture: 8 },
  { suffix: 'WKtoST', clip: 'walkToStand', gesture: 10 },
  { suffix: 'LimpLeft', clip: 'limpLeft', gesture: 11 },
  { suffix: 'LimpRight', clip: 'limpRight', gesture: 12 },
  { suffix: 'Idle', clip: 'idle', gesture: 13 },
  { suffix: 'FallBackward', clip: 'fallBackward', gesture: 14 },
  { suffix: 'FallForward', clip: 'fallForward', gesture: 15 },
  { suffix: 'HitFront', clip: 'hitFront', gesture: 16 },
  { suffix: 'HitBack', clip: 'hitBack', gesture: 17 },
  { suffix: 'HitLeft', clip: 'hitLeft', gesture: 18 },
  { suffix: 'HitRight', clip: 'hitRight', gesture: 19 },
  { suffix: 'Jump', clip: 'jump', gesture: 20 },
  { suffix: 'GetupBack', clip: 'getupBack', gesture: 21 },
  { suffix: 'GetupFront', clip: 'getupFront', gesture: 22 },
  { suffix: 'FallBackwardDam', clip: 'destroyedBackward', gesture: -1 },
  { suffix: 'FallForwardDam', clip: 'destroyedForward', gesture: -1 },
];

export interface Terrain {
  /** Vertices per side; the grid is side x side, row 0 at the north edge. */
  side: number;
  elevation: Float32Array;
  terrainType: Uint8Array;
}

export interface TerrainObject {
  type: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  damage: number;
  team: number;
}

export interface MissionPart {
  objectNumber: number;
  x: number;
  y: number;
  rotation: number;
  team: number;
  commander: number;
  player: boolean;
  /** ARGB as stored in the mission: base and two highlight colours. */
  colors: [number, number, number];
  csv: string;
  /** Index of the [WarriorN] section that pilots it. */
  pilot: number;
}

export interface MoveMap {
  width: number;
  height: number;
  cells: Uint32Array;
}

export interface Mission {
  name: string;
  fit: Fit;
  terrain: Terrain;
  objects: TerrainObject[];
  parts: MissionPart[];
  move: MoveMap | null;
  /** Pilot profile (missions/warriors/<profile>.fit) of each [WarriorN] section, by N. */
  profiles: Map<number, string>;
}

export function readMission(src: SourceData, name: string): Mission {
  const fit = src.fit(`missions/${name}.fit`);
  const packets = readPak(src.read(`missions/${name}.pak`));

  // Packet 0: side x side PostcompVertex records of 32 bytes (mclib/vertex.h).
  const grid = packets[0];
  const side = Math.round(Math.sqrt(grid.length / 32));
  if (side * side * 32 !== grid.length) throw new Error(`${name}: terrain packet is not a square grid`);
  const elevation = new Float32Array(side * side);
  const terrainType = new Uint8Array(side * side);
  for (let i = 0; i < side * side; i++) {
    elevation[i] = grid.readFloatLE(i * 32 + 12);
    terrainType[i] = grid.readUInt32LE(i * 32 + 24);
  }

  // Packet 1: placed terrain objects (code/objmgr.cpp countTerrainObjects).
  const objPacket = packets[1];
  const objects: TerrainObject[] = [];
  const count = objPacket.readInt32LE(0);
  const stride = count ? (objPacket.length - 4) / count : 0;
  for (let i = 0; i < count; i++) {
    const o = 4 + i * stride;
    objects.push({
      type: objPacket.readInt32LE(o),
      x: objPacket.readFloatLE(o + 4),
      y: objPacket.readFloatLE(o + 8),
      z: objPacket.readFloatLE(o + 12),
      rotation: objPacket.readFloatLE(o + 16),
      damage: objPacket.readInt32LE(o + 20),
      team: objPacket.readInt32LE(o + 24),
    });
  }

  // Packets 4..7: movement map height, width, planet, cells (mclib/move.cpp MissionMap::init).
  let move: MoveMap | null = null;
  if (packets[4]?.length === 4 && packets[7]) {
    const height = packets[4].readInt32LE(0);
    const width = packets[5].readInt32LE(0);
    const cells = packets[7];
    if (cells.length === width * height * 4) {
      move = { width, height, cells: new Uint32Array(cells.buffer.slice(cells.byteOffset, cells.byteOffset + cells.length)) };
    }
  }

  const parts: MissionPart[] = [];
  const numParts = fit.num('Parts', 'NumParts');
  for (let i = 1; i <= numParts; i++) {
    const s = `Part${i}`;
    if (!fit.has(s) || fit.num(s, 'Exists', 1) === 0) continue;
    parts.push({
      objectNumber: fit.num(s, 'ObjectNumber'),
      x: fit.num(s, 'PositionX'),
      y: fit.num(s, 'PositionY'),
      rotation: fit.num(s, 'Rotation'),
      team: fit.num(s, 'TeamID'),
      commander: fit.num(s, 'CommanderID'),
      player: fit.bool(s, 'PlayerPart'),
      colors: [fit.num(s, 'BaseColor') >>> 0, fit.num(s, 'HighlightColor1') >>> 0, fit.num(s, 'HighlightColor2') >>> 0],
      csv: fit.str(s, 'CSVFile'),
      pilot: fit.num(s, 'Pilot', i),
    });
  }
  const profiles = new Map<number, string>();
  for (let i = 1; i <= fit.num('Warriors', 'NumWarriors'); i++) {
    const profile = fit.get(`Warrior${i}`, 'Profile');
    if (profile) profiles.set(i, profile);
  }

  return { name, fit, terrain: { side, elevation, terrainType }, objects, parts, move, profiles };
}

// ---------------------------------------------------------------------------
// Object type -> appearance -> model files.

export interface ObjectInfo {
  fitName: string;
  cls: number;
  name: string;
  appearance: string;
}

export function readObjectInfo(src: SourceData, list: string[], typeNumber: number): ObjectInfo | null {
  const fitName = list[typeNumber];
  if (!fitName || fitName.startsWith('<') || !src.has(`objects/${fitName}`)) return null;
  const fit = src.fit(`objects/${fitName}`);
  return {
    fitName,
    cls: fit.num('ObjectClass', 'ObjectTypeNum', -1),
    name: fit.str('ObjectType', 'Name'),
    appearance: fit.str('ObjectType', 'AppearanceName'),
  };
}

/**
 * Clip names for a ground vehicle's animations, by `[Animation:N]` index: stand, walk and run (infantry), and deploy (the
 * repair truck opening up); the Karnov VTOL's are hover, land and take off (tgl/karnov.ini).
 */
const VEHICLE_CLIPS = ['idle', 'walk', 'run', 'deploy'];

/** Infantry walk on a walk clip of their own (a vehicle's "walk" is its still model). */
export function walks(spec: ModelSpec): boolean {
  return spec.clips.some((c) => c.clip === 'walk' && c.file !== spec.base);
}
/**
 * Aircraft whose clips carry their own flight (by appearance: its [Animation:N] in order): the Karnov's hover, landing
 * and take-off, the aerospace fighters' bombing run (MC2's air strikes), and the VTOL's flight in to drop a vehicle off
 * and out again.
 */
const AIRCRAFT_CLIPS: Record<string, string[]> = {
  karnov: ['hover', 'land', 'takeoff'],
  slayer: ['bombrun'],
  shilone: ['bombrun'],
  vtol: ['dropoff'],
};

export interface ModelSpec {
  /** Output key and file stem: the appearance name, lower case. */
  key: string;
  /**
   * A prop is flattened into one node. A mech has gesture clips. A vehicle keeps its nodes when its appearance has
   * animations (infantry walk and run), and is flattened otherwise.
   */
  kind: 'prop' | 'mech' | 'vehicle';
  appearance: string;
  /** Repository-relative .ase path of LOD 0. */
  base: string;
  clips: { clip: string; gesture: number; file: string }[];
  ini: string;
}

export function modelSpec(src: SourceData, appearance: string, kind: ModelSpec['kind']): ModelSpec | null {
  const ini = src.actual(`tgl/${appearance}.ini`);
  if (!ini) return null;
  const fit = src.fit(ini);
  // Most appearances name LOD 0 as FileName0; ground vehicles with animations (infantry) as plain FileName.
  const fileName = fit.str('TGLData', 'FileName0') || fit.str('TGLData', 'FileName');
  const base = fileName ? src.actual(`tgl/${fileName}.ase`) : null;
  if (!base) return null;
  const clips: ModelSpec['clips'] = [];
  if (kind === 'mech') {
    for (const g of MECH_GESTURES) {
      const file = src.actual(`tgl/${appearance}${g.suffix}.ase`);
      if (file) clips.push({ clip: g.clip, gesture: g.gesture, file });
    }
  } else if (kind === 'vehicle') {
    (AIRCRAFT_CLIPS[appearance.toLowerCase()] ?? VEHICLE_CLIPS).forEach((clip, n) => {
      const name = fit.str(`Animation:${n}`, 'AnimationName');
      const file = name ? src.actual(`tgl/${name}.ase`) : null;
      if (file) clips.push({ clip, gesture: -1, file });
    });
  }
  return { key: appearance.toLowerCase(), kind, appearance, base, clips, ini };
}

export interface MissionModels {
  /** Per terrain object type number: model key, or null when it has no model. */
  objectModels: Map<number, string | null>;
  /** Per mission part index: model key, or null. */
  partModels: (string | null)[];
  specs: Map<string, ModelSpec>;
  infos: Map<number, ObjectInfo | null>;
  /** Per extra object file name (lower case), or appearance: model key, or null. */
  extraModels: Map<string, string | null>;
  /** Reason -> number of placements affected. */
  unresolved: Map<string, number>;
}

/**
 * `extraMechs`: appearance names (e.g. "atlas") to include even if the mission does not use them. `extraObjects`:
 * object file names (e.g. "infantry", "davionflag") likewise, for vehicles, infantry and props.
 */
export function collectMissionModels(
  src: SourceData,
  mission: Mission,
  extraMechs: string[] = [],
  extraObjects: string[] = [],
  /** Appearances with no object file of their own (the Karnov), as animated vehicles. */
  extraAppearances: string[] = [],
): MissionModels {
  const list = src.objectList();
  const infos = new Map<number, ObjectInfo | null>();
  const info = (n: number) => {
    if (!infos.has(n)) infos.set(n, readObjectInfo(src, list, n));
    return infos.get(n)!;
  };
  const specs = new Map<string, ModelSpec>();
  const unresolved = new Map<string, number>();
  const skip = (reason: string) => {
    unresolved.set(reason, (unresolved.get(reason) ?? 0) + 1);
    return null;
  };
  const resolveInfo = (i: ObjectInfo, kind: ModelSpec['kind']): string | null => {
    const key = i.appearance.toLowerCase();
    if (specs.has(key)) return key;
    const spec = modelSpec(src, i.appearance, kind);
    if (!spec) return skip(`${i.fitName}: appearance "${i.appearance}" has no tgl ini/ase`);
    specs.set(key, spec);
    return key;
  };
  const kindOf = (cls: number | undefined): ModelSpec['kind'] => (cls === ObjectClass.Mech ? 'mech' : cls === ObjectClass.Vehicle ? 'vehicle' : 'prop');
  const resolve = (n: number, kind: ModelSpec['kind']): string | null => {
    const i = info(n);
    if (!i || !i.appearance) return skip(`object type ${n} (${list[n] ?? '?'}): no appearance`);
    return resolveInfo(i, kind);
  };

  const objectModels = new Map<number, string | null>();
  for (const o of mission.objects) {
    if (!objectModels.has(o.type)) objectModels.set(o.type, resolve(o.type, 'prop'));
    else if (objectModels.get(o.type) === null) resolve(o.type, 'prop');
  }
  const partModels = mission.parts.map((p) => resolve(p.objectNumber, kindOf(info(p.objectNumber)?.cls)));
  const extraModels = new Map<string, string | null>();
  for (const name of extraObjects) {
    const fitName = src.actual(`objects/${name}.fit`);
    const fit = fitName ? src.fit(fitName) : null;
    const i: ObjectInfo | null = fit
      ? { fitName: name, cls: fit.num('ObjectClass', 'ObjectTypeNum', -1), name: fit.str('ObjectType', 'Name'), appearance: fit.str('ObjectType', 'AppearanceName') }
      : null;
    extraModels.set(name, i?.appearance ? resolveInfo(i, kindOf(i.cls)) : skip(`extra object "${name}" has no object file or appearance`));
  }
  for (const appearance of extraAppearances) {
    extraModels.set(appearance, resolveInfo({ fitName: appearance, cls: ObjectClass.Vehicle, name: appearance, appearance }, 'vehicle'));
  }
  for (const appearance of extraMechs) {
    const spec = modelSpec(src, appearance, 'mech');
    if (spec) specs.set(spec.key, spec);
    else skip(`extra mech "${appearance}" has no tgl ini/ase`);
  }
  return { objectModels, partModels, specs, infos, extraModels, unresolved };
}

/**
 * Drops the mission's placed turrets (ObjectClass.Turret) from its objects. The game places a map's objects as scenery,
 * so a turret line would stand about never firing; the multiplayer maps have dozens. Returns how many went.
 */
export function dropPlacedTurrets(src: SourceData, mission: Mission): number {
  const list = src.objectList();
  const turret = new Map<number, boolean>();
  const isTurret = (type: number) => {
    if (!turret.has(type)) turret.set(type, readObjectInfo(src, list, type)?.cls === ObjectClass.Turret);
    return turret.get(type)!;
  };
  const before = mission.objects.length;
  mission.objects = mission.objects.filter((o) => !isTurret(o.type));
  return before - mission.objects.length;
}
