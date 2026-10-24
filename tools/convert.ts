// Converts one MC2 mission and the models it uses into web-friendly assets.
//
//   npm run convert -- --mission mc2_01
//
// Output (under --out, default public/assets):
//   manifest.json
//   maps/<mission>/map.json        terrain size, lighting, water, camera start
//   maps/<mission>/elevation.bin   Float32 side*side heights, row 0 = north edge
//   maps/<mission>/move.bin        Uint32 movement-map cells (mclib/move.h MapCell)
//   maps/<mission>/colormap.webp   pre-lit terrain colour map
//   maps/<mission>/objects.json    placed buildings, trees, props
//   maps/<mission>/units.json      mission units, mech animation metadata, and the scenarios' unit types and props
//   maps/<mission>/combat.json     weapons, ammunition, and each unit type's armour and loadout
//   models/props/*.glb, models/mechs/*.glb
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { parseAse } from './lib/ase.ts';
import type { Fit } from './lib/fit.ts';
import {
  ObjectClass,
  WORLD_UNITS_PER_METER,
  WORLD_UNITS_PER_VERTEX,
  collectMissionModels,
  readMission,
  type ModelSpec,
} from './lib/mission.ts';
import { ComponentTable, readGunnery, readMechStats, readVehicleStats, type MechStats, type VehicleStats } from './lib/combat-data.ts';
import { buildModel, TextureLibrary } from './lib/model.ts';
import { readScenarios, scenarioNeeds } from './lib/scenario.ts';
import { SourceData } from './lib/srcdata.ts';
import { decodeTga } from './lib/tga.ts';

const { values } = parseArgs({
  options: {
    mission: { type: 'string', default: 'mc2_01' },
    // Mechs to convert in addition to the mission's own (shown in the viewer's showcase).
    'extra-mechs': { type: 'string', default: 'atlas,madcat' },
    src: { type: 'string', default: 'vendor/mc2srcdata' },
    out: { type: 'string', default: 'public/assets' },
    // Use the remaster's 4x textures fetched by `npm run fetch-data -- --upscaled`.
    upscaled: { type: 'boolean', default: false },
    'upscaled-src': { type: 'string', default: 'vendor/upscaled' },
    // Largest sizes to ship. A 5120² colour map needs ~140 MB of GPU memory, too much for an iPad.
    'colormap-size': { type: 'string', default: '2560' },
    'texture-size': { type: 'string', default: '512' },
  },
});
const missionName = values.mission!;
const extraMechs = values['extra-mechs']!.split(',').map((m) => m.trim()).filter(Boolean);
const out = values.out!;

const write = (rel: string, data: string | Uint8Array) => {
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return data.length;
};
const json = (rel: string, value: unknown) => write(rel, JSON.stringify(value));
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

const src = new SourceData(values.src!);
const upscaled = values.upscaled && existsSync(values['upscaled-src']!) ? new SourceData(values['upscaled-src']!) : null;
if (values.upscaled && !upscaled) console.warn(`--upscaled: ${values['upscaled-src']} not found, using the original textures`);
if (!src.has(`missions/${missionName}.fit`)) {
  console.error(`missions/${missionName}.fit not found under ${values.src}. Run: npm run fetch-data -- --mission ${missionName}`);
  process.exit(1);
}

const mission = readMission(src, missionName);
const fit = mission.fit;
const mapDir = `maps/${missionName}`;
const { side, elevation } = mission.terrain;
console.log(`${missionName}: ${side}x${side} terrain, ${mission.objects.length} objects, ${mission.parts.length} units`);

// --- Terrain -----------------------------------------------------------------

write(`${mapDir}/elevation.bin`, new Uint8Array(elevation.buffer));
if (mission.move) write(`${mapDir}/move.bin`, new Uint8Array(mission.move.cells.buffer));

const image = async (rel: string, file: string, format: 'webp' | 'png', maxSize = Infinity) => {
  const from = upscaled?.has(rel) ? upscaled : src.has(rel) ? src : null;
  if (!from) return null;
  const tga = decodeTga(from.read(rel));
  let pipeline = sharp(Buffer.from(tga.data), { raw: { width: tga.width, height: tga.height, channels: 4 } });
  const size = Math.min(tga.width, maxSize);
  if (size < tga.width) pipeline = pipeline.resize(size, Math.round((tga.height * size) / tga.width), { kernel: 'lanczos3' });
  pipeline = format === 'webp' ? pipeline.webp({ quality: 90 }) : pipeline.png({ compressionLevel: 9 });
  write(`${mapDir}/${file}`, await pipeline.toBuffer());
  if (from === upscaled) console.log(`  ${file}: upscaled ${tga.width}² source, shipped at ${size}²`);
  return { file, width: size, height: Math.round((tga.height * size) / tga.width) };
};

const colormap = await image(`textures/${missionName}.burnin.tga`, 'colormap.webp', 'webp', Number(values['colormap-size']));
const detail = await image(`textures/${missionName}.detail.tga`, 'detail.png', 'png');
const water = await image(`textures/${missionName}.water.tga`, 'water.png', 'png');
if (!colormap) throw new Error(`textures/${missionName}.burnin.tga is missing`);

let minElevation = Infinity;
let maxElevation = -Infinity;
for (const e of elevation) {
  minElevation = Math.min(minElevation, e);
  maxElevation = Math.max(maxElevation, e);
}

const rgb = (f: Fit, section: string, prefix: string) => [
  f.num(section, `${prefix}Red`) / 255,
  f.num(section, `${prefix}Green`) / 255,
  f.num(section, `${prefix}Blue`) / 255,
];
// mclib/camera.cpp: direction towards the sun in world axes (x east, y north, z up).
const yaw = (fit.num('Cameras', 'LightDirYaw') + 45) * (Math.PI / 180);
const pitch = fit.num('Cameras', 'LightDirPitch', 45) * (Math.PI / 180);
const sun = [Math.cos(yaw), Math.sin(yaw), Math.sin(pitch)];
const sunLength = Math.hypot(sun[0], sun[1], sun[2]);

json(`${mapDir}/map.json`, {
  name: missionName,
  side,
  worldUnitsPerVertex: WORLD_UNITS_PER_VERTEX,
  worldUnitsPerMeter: WORLD_UNITS_PER_METER,
  elevation: { file: 'elevation.bin', min: minElevation, max: maxElevation },
  colormap,
  detail: detail && { ...detail, tiling: fit.num('Terrain', 'DetailTextureTilingFactor', 30) },
  // mclib/quad.cpp: per-vertex water alpha by depth below the surface. Shallow
  // when within alphaDepth, deep (opaque in mc2_01) beyond 3 * alphaDepth.
  water: {
    elevation: fit.num('Water', 'Elevation'),
    alphaDepth: fit.num('Water', 'AlphaDepth', 15),
    alpha: ['AlphaShallow', 'AlphaMiddle', 'AlphaDeep'].map((k) => round((fit.num('Water', k) >>> 24) / 255, 3)),
    texture: water && { ...water, tiling: fit.num('Terrain', 'WaterTextureTilingFactor', 48) },
  },
  light: {
    sun: sun.map((v) => round(v / sunLength, 4)),
    color: rgb(fit, 'Cameras', 'DayLight').map((v) => round(v, 3)),
    ambient: rgb(fit, 'Cameras', 'DayAmbient').map((v) => round(v, 3)),
  },
  camera: {
    x: fit.num('Cameras', 'PositionX'),
    y: fit.num('Cameras', 'PositionY'),
    rotation: fit.num('Cameras', 'StartRotation'),
  },
  move: mission.move && { file: 'move.bin', width: mission.move.width, height: mission.move.height },
});

// --- Models ------------------------------------------------------------------

// The scenarios' units (mechs by their stats file, the rest by object file) and props join the mission's.
const needs = scenarioNeeds(readScenarios(missionName));
const scenarioMechs = needs.units.filter((u) => src.has(`objects/${u}.csv`));
const scenarioObjects = [...needs.units.filter((u) => !scenarioMechs.includes(u)), ...needs.props];
const models = collectMissionModels(src, mission, [...new Set([...extraMechs, ...scenarioMechs])], scenarioObjects, needs.appearances);
const textures = new TextureLibrary(src, { upscaled, maxSize: Number(values['texture-size']) });
const modelPath = (spec: ModelSpec) => `models/${spec.kind === 'mech' ? 'mechs' : 'props'}/${spec.key}.glb`;
// A vehicle keeps its nodes only when it has clips to move them (infantry); otherwise it's one rigid piece.
const mechMeta: Record<string, unknown> = {};
let totalBytes = 0;

for (const spec of models.specs.values()) {
  const base = parseAse(src.text(spec.base));
  const clips = spec.clips.map((c) => ({ name: c.clip, ase: parseAse(src.text(c.file)) }));
  const flatten = spec.kind === 'prop' || (spec.kind === 'vehicle' && !clips.length);
  const { glb, stats } = await buildModel({ name: spec.key, base, clips, flatten }, textures);
  totalBytes += write(modelPath(spec), glb);

  if (spec.kind === 'mech') {
    // Gesture speeds (metres/second) and lengths, for matching movement to animation.
    const ini = src.fit(spec.ini);
    const clipMeta: Record<string, unknown> = {};
    spec.clips.forEach((c, i) => {
      const ase = clips[i].ase;
      const section = `Gestures${c.gesture}`;
      clipMeta[c.clip] = {
        frames: ase.lastFrame - ase.firstFrame + 1,
        fps: ase.frameSpeed,
        startVelocity: c.gesture >= 0 ? ini.num(section, 'StartVel') : 0,
        endVelocity: c.gesture >= 0 ? ini.num(section, 'EndVel') : 0,
      };
    });
    mechMeta[spec.key] = { model: modelPath(spec), clips: clipMeta };
  }
  console.log(
    `  ${modelPath(spec).padEnd(34)} ${String(stats.triangles).padStart(5)} tris (${String(stats.cutoutTriangles).padStart(4)} cut-out)  ` +
      `${String(stats.clips).padStart(2)} clips  ${(glb.length / 1024).toFixed(0).padStart(5)} KB`,
  );
}

// --- Placements ----------------------------------------------------------------

const modelKeys = [...models.specs.keys()];
const modelIndex = new Map(modelKeys.map((k, i) => [k, i]));
const placed = mission.objects.filter((o) => models.objectModels.get(o.type));
json(`${mapDir}/objects.json`, {
  models: modelKeys.map((k) => modelPath(models.specs.get(k)!)),
  // [model index, x, y, z, rotation (degrees), team]
  instances: placed.map((o) => [
    modelIndex.get(models.objectModels.get(o.type)!)!,
    round(o.x),
    round(o.y),
    round(o.z),
    round(o.rotation),
    o.team,
  ]),
});

// --- Combat data ---------------------------------------------------------------
// Weapons from the component table; each mech's stats file (its CSVFile); each vehicle's object file; pilots' gunnery.
const components = new ComponentTable(src.text('objects/compbas.csv'));
const mechStats: Record<string, MechStats> = {};
const vehicleStats: Record<string, VehicleStats> = {};
const statsFor = (kind: 'mech' | 'vehicle', csv: string, fitName: string): string | null => {
  if (kind === 'mech') {
    const key = csv.toLowerCase();
    if (!mechStats[key] && src.has(`objects/${key}.csv`)) mechStats[key] = readMechStats(src.text(`objects/${key}.csv`), components);
    return mechStats[key] ? key : null;
  }
  const key = fitName.replace(/\.fit$/i, '').toLowerCase();
  if (!vehicleStats[key]) vehicleStats[key] = readVehicleStats(src.fit(`objects/${fitName}`), components);
  return key;
};

const units = mission.parts.flatMap((p, i) => {
  const key = models.partModels[i];
  if (!key) return [];
  const info = models.infos.get(p.objectNumber)!;
  // A vehicle whose model walks is infantry.
  const walks = models.specs.get(key)?.clips.some((c) => c.clip === 'walk');
  const kind = info.cls === ObjectClass.Mech ? 'mech' : walks ? 'infantry' : 'vehicle';
  const profile = mission.profiles.get(p.pilot);
  return [
    {
      model: key,
      kind,
      name: info.name,
      csv: p.csv,
      stats: statsFor(kind === 'mech' ? 'mech' : 'vehicle', p.csv, info.fitName),
      gunnery: (profile && readGunnery(src, profile)) ?? 40,
      x: round(p.x),
      y: round(p.y),
      rotation: round(p.rotation),
      team: p.team,
      player: p.player,
      colors: p.colors.map((c) => '#' + (c & 0xffffff).toString(16).padStart(6, '0')),
    },
  ];
});
const showcase = extraMechs.map((m) => m.toLowerCase()).filter((m) => m in mechMeta);
for (const m of showcase) statsFor('mech', m, '');
// The scenarios' unit types: a mech walks on its gestures; a vehicle whose model walks (has a walk clip) is infantry.
const types: Record<string, { kind: 'mech' | 'vehicle' | 'infantry'; name: string; model: string; stats: string | null }> = {};
for (const u of needs.units) {
  if (scenarioMechs.includes(u)) {
    const meta = mechMeta[u] as { model: string } | undefined;
    const stats = statsFor('mech', u, '');
    if (meta) types[u] = { kind: 'mech', name: (stats && mechStats[stats]?.name) || u, model: meta.model, stats };
    continue;
  }
  const spec = models.specs.get(models.extraModels.get(u) ?? '');
  if (!spec) continue;
  const fitName = src.actual(`objects/${u}.fit`)!.split('/').pop()!;
  types[u] = {
    kind: spec.clips.some((c) => c.clip === 'walk') ? 'infantry' : 'vehicle',
    name: src.fit(`objects/${fitName}`).str('ObjectType', 'Name') || u,
    model: modelPath(spec),
    stats: statsFor('vehicle', '', fitName),
  };
}
const props = Object.fromEntries(
  [...needs.props, ...needs.appearances].flatMap((p) => {
    const spec = models.specs.get(models.extraModels.get(p) ?? '');
    return spec ? [[p, modelPath(spec)]] : [];
  }),
);
json(`${mapDir}/units.json`, { mechs: mechMeta, units, showcase, types, props });
const usedWeapons = new Set([...Object.values(mechStats), ...Object.values(vehicleStats)].flatMap((s) => s.weapons.map((w) => w.id)));
json(`${mapDir}/combat.json`, {
  weapons: Object.fromEntries([...usedWeapons].map((id) => [id, components.weapons.get(id)])),
  ammo: Object.fromEntries([...components.ammo].filter(([id]) => [...Object.values(mechStats), ...Object.values(vehicleStats)].some((s) => id in s.ammo))),
  mechs: mechStats,
  vehicles: vehicleStats,
});
json('manifest.json', { maps: [missionName] });

console.log(
  `${models.specs.size} models (${(totalBytes / 1024 / 1024).toFixed(1)} MB), ${placed.length}/${mission.objects.length} objects placed, ${units.length}/${mission.parts.length} units`,
);
for (const [reason, n] of models.unresolved) console.warn(`  skipped ${n}x ${reason}`);
if (textures.missing.size) console.warn(`  missing textures: ${[...textures.missing].join(', ')}`);
if (upscaled) console.log(`  ${textures.upscaledCount} model textures from the 4x upscales`);
