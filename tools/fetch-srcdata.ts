// Fetches the part of alariq/mc2srcdata that one mission needs, using a sparse,
// blobless clone (the full repository is ~1.2 GB; one mission is a few MB).
//
//   npm run fetch-data -- --mission mc2_01 [--upscaled]
//
// --upscaled also pulls the remaster's 4x textures for the same files out of
// its v0.3 release zips (2.7 GB in total) using range requests, so only the
// entries this mission needs are downloaded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAse } from './lib/ase.ts';
import { collectMissionModels, readMission } from './lib/mission.ts';
import { RemoteZip } from './lib/remote-zip.ts';
import { readScenarios, scenarioNeeds } from './lib/scenario.ts';
import { missionTune, soundLists, soundSet } from './lib/sound.ts';
import { SourceData } from './lib/srcdata.ts';

const REPO = 'https://github.com/alariq/mc2srcdata.git';
const UPSCALED_RELEASE = 'https://github.com/ThranduilsRing/mc2-opengl-remastered/releases/download/v0.3-release/';

const { values } = parseArgs({
  options: {
    mission: { type: 'string', default: 'mc2_01' },
    // Mechs to convert in addition to the mission's own (shown in the viewer's showcase).
    'extra-mechs': { type: 'string', default: 'atlas,madcat' },
    dest: { type: 'string', default: 'vendor/mc2srcdata' },
    upscaled: { type: 'boolean', default: false },
    'upscaled-dest': { type: 'string', default: 'vendor/upscaled' },
  },
});
const mission = values.mission!;
const extraMechs = values['extra-mechs']!.split(',').map((m) => m.trim()).filter(Boolean);
const dest = values.dest!;

const git = (args: string[], input?: string) =>
  execFileSync('git', ['-C', dest, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });

if (!existsSync(join(dest, '.git'))) {
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`cloning ${REPO} (sparse, no blobs) into ${dest}`);
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO, dest], { stdio: 'inherit' });
  git(['sparse-checkout', 'set', '--no-cone', '/README.md']);
}

const listing = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
const tree = new SourceData(dest, listing);

const checkout = (label: string, paths: string[]) => {
  const wanted = [...new Set(paths)].filter((p) => !existsSync(join(dest, p)));
  console.log(`${label}: ${wanted.length} new file(s)`);
  if (!wanted.length) return;
  const patterns = wanted.map((p) => '/' + p.replace(/([[\]*?!#\\ ])/g, '\\$1')).join('\n') + '\n';
  git(['sparse-checkout', 'add', '--stdin'], patterns);
};

// 1. Object definitions, appearance INIs and the mission itself.
const lower = (p: string) => p.toLowerCase();
checkout(
  'definitions',
  listing.filter((p) => {
    const l = lower(p);
    return (
      (l.startsWith('objects/') && (l.endsWith('.fit') || l.endsWith('.csv') || l === 'objects/object2.rsp')) ||
      (/^tgl\/[^/]+\.ini$/.test(l)) ||
      l === `missions/${mission}.fit` ||
      l === `missions/${mission}.pak` ||
      l.startsWith(`textures/${mission}.`)
    );
  }),
);

// 2. The pilots' profiles (their gunnery is the chance to hit), then model geometry and animation for everything the
//    mission places.
const missionData = readMission(tree, mission);
checkout(
  'pilots',
  [...new Set(missionData.profiles.values())].map((p) => tree.actual(`missions/warriors/${p}.fit`)).filter((p): p is string => p !== null),
);
// The scenarios' units (mechs by their stats file, the rest by object file) and props join the mission's.
const needs = scenarioNeeds(readScenarios(mission));
const scenarioMechs = needs.units.filter((u) => tree.has(`objects/${u}.csv`));
const scenarioObjects = [...needs.units.filter((u) => !scenarioMechs.includes(u)), ...needs.props];
const models = collectMissionModels(tree, missionData, [...new Set([...extraMechs, ...scenarioMechs])], scenarioObjects, needs.appearances);
const aseFiles = [...models.specs.values()].flatMap((s) => [s.base, ...s.clips.map((c) => c.file)]);
checkout('models', aseFiles);

// 3. Textures referenced by the LOD 0 meshes.
const textures = new Set<string>();
for (const spec of models.specs.values()) {
  for (const slot of parseAse(tree.text(spec.base)).textures) {
    const rel = tree.actual(`tgl/128/${slot}`) ?? tree.actual(`tgl/128/${slot}.tga`);
    if (rel) textures.add(rel);
  }
}
checkout('textures', [...textures]);

// 4. Sounds: the radio and effects tables and the lists the files are named in, then the squads' voices, Betty, the
//    effects, weapons and explosions, and the tunes.
checkout('sound lists', soundLists(needs.voices).map((p) => tree.actual(p)).filter((p): p is string => p !== null));
const sounds = soundSet(tree, needs.voices, { name: mission, tune: missionTune(missionData.fit) });
checkout('sounds', [...sounds.files.values(), ...sounds.tunes.values()]);

for (const [reason, n] of models.unresolved) console.warn(`  skipped ${n}x ${reason}`);
console.log(`done: ${models.specs.size} models for ${mission}`);

// 5. Optional 4x upscales: the terrain colour map and the model textures.
if (values.upscaled) {
  const upDest = values['upscaled-dest']!;
  const [tglZip, ...burninZips] = await Promise.all(
    ['mc2-tgl.zip', 'mc2-burnins-4x-pt1.zip', 'mc2-burnins-4x-pt2.zip'].map((f) => RemoteZip.open(UPSCALED_RELEASE + f)),
  );
  const wanted: { zip: RemoteZip; member: string; out: string }[] = [];
  const colormap = `data/textures/${mission}.burnin.tga`;
  const burninZip = burninZips.find((z) => z.entries.has(colormap));
  if (burninZip) wanted.push({ zip: burninZip, member: colormap, out: `textures/${mission}.burnin.tga` });
  else console.warn(`  no upscaled colour map for ${mission}`);
  for (const rel of textures) {
    const member = `data/tgl/${basename(rel).toLowerCase()}`;
    if (tglZip.entries.has(member)) wanted.push({ zip: tglZip, member, out: `tgl/${basename(rel).toLowerCase()}` });
    else console.warn(`  no upscaled version of ${rel}`);
  }

  const todo = wanted.filter((w) => !existsSync(join(upDest, w.out)));
  console.log(`upscaled: ${todo.length} of ${wanted.length} file(s) to download`);
  let bytes = 0;
  const worker = async () => {
    for (let w = todo.shift(); w; w = todo.shift()) {
      const data = await w.zip.extract(w.member);
      mkdirSync(dirname(join(upDest, w.out)), { recursive: true });
      writeFileSync(join(upDest, w.out), data);
      bytes += data.length;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`upscaled: done (${(bytes / 1e6).toFixed(1)} MB written to ${upDest})`);
}
