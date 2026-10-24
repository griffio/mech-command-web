// The battle survey: every unit on the map in one fight, to measure what a battle costs. The units are placed on the
// most open dry ground there is, the player's mechs in a line facing the enemy's block 110 m off. First come the
// survey's stressed rows, with nobody able to be hurt so the fire stays steady (and the enemy closes in); then the
// fight is restaged and played in real time until one side is destroyed.
import type { SeaRenderer } from '../render/sea-renderer';
import type { LiveSample, PerfSurvey, SurveyRow, SurveyStep, SurveyView } from './perf-survey';
import { PLAYER_TEAM, type SeaUnit, type World } from './world';

/** From the player's line to the enemy's nearest column, metres. */
const GAP_M = 110;
const SPACING_M = 14;
const ENEMY_ROWS = 5;
/** Half the arena's size, metres: it must be open, dry ground (east-west, north-south). */
const HALF_X_M = 95;
const HALF_Z_M = 45;
/** The real-time fight stops this long after one side is destroyed (to see the wrecks burn), or at the cap. */
const AFTERMATH_MS = 6000;
const LIVE_CAP_MS = 100_000;
/** Real time with the units standing, before the fight: the page's frame pacing with nothing happening. */
const STANDING_MS = 10_000;

const BATTLE_STEPS: SurveyStep[] = [
  { name: 'baseline: standing', scale: 1, flags: {}, everyView: true },
  { name: 'baseline: fighting', scale: 1, flags: {}, live: true, everyView: true },
  { name: 'fighting, effects not drawn', scale: 1, flags: { skipFx: true }, live: true, everyView: true },
  { name: 'fighting, no sun shadows', scale: 1, flags: { skipShadows: true }, live: true },
  { name: 'fighting, resolution 75%', scale: 0.75, flags: {}, live: true },
  { name: 'baseline: fighting (end)', scale: 1, flags: {}, live: true, everyView: true },
];

export interface CameraView {
  target: [number, number, number];
  distance: number;
  yawDeg: number;
  pitchDeg: number;
}

export interface BattleSurveyResult {
  arena: { x: number; z: number; units: number };
  rows: SurveyRow[];
  standing: LiveSample;
  live: LiveSample & { outcome: string | null; destroyed: number };
}

export async function runBattleSurvey(
  survey: PerfSurvey,
  world: World,
  sea: SeaRenderer,
  setView: (v: CameraView) => void,
  log: (line: string) => void,
): Promise<BattleSurveyResult> {
  const arena = findArena(world);
  const fighters = world.units.filter((u) => u.combat && u.alive);
  log(`Arena at (${arena.x.toFixed(0)}, ${arena.z.toFixed(0)}): ${fighters.length} units, nobody can be hurt for now`);
  stage(world, arena);
  world.battle.immortal = true;
  const views: SurveyView[] = [
    { name: 'battle', apply: () => setView({ target: [arena.x, 0, arena.z], distance: 300, yawDeg: 0, pitchDeg: 45 }) },
    { name: 'battle-close', apply: () => setView({ target: [arena.x, 0, arena.z], distance: 130, yawDeg: 0, pitchDeg: 32 }) },
  ];
  let rows: SurveyRow[];
  try {
    rows = await survey.run({ views, steps: BATTLE_STEPS }, log);
  } finally {
    world.battle.immortal = false;
  }

  stage(world, arena);
  views[0]!.apply();
  const counters = () => ({ ...sea.fxCounts, ...world.battle.counts });
  log('Real time, one frame per refresh at full resolution: 10 s standing…');
  const standing = await survey.sampleLive({ maxMs: STANDING_MS, counters, worldLive: false });
  log(describe(standing));
  log('…then the fight, until one side is destroyed');
  let decidedAt: number | null = null;
  const live = await survey.sampleLive({
    maxMs: LIVE_CAP_MS,
    done: () => {
      if (world.battle.outcome && decidedAt === null) decidedAt = performance.now();
      return decidedAt !== null && performance.now() - decidedAt > AFTERMATH_MS;
    },
    counters,
  });
  const destroyed = fighters.filter((u) => !u.alive).length;
  log(`${describe(live)}; ${destroyed} destroyed, ${world.battle.outcome ?? 'undecided'}`);
  log('Reload the page to play the mission again.');
  return {
    arena: { x: arena.x, z: arena.z, units: fighters.length },
    rows,
    standing,
    live: { ...live, outcome: world.battle.outcome, destroyed },
  };
}

function describe(s: LiveSample): string {
  return (
    `${s.seconds.toFixed(0)} s, ${s.fps.toFixed(1)} fps: refresh p50 ${s.intervalMs.p50.toFixed(1)} / p99 ${s.intervalMs.p99.toFixed(1)} / ` +
    `max ${s.intervalMs.max.toFixed(1)} ms, ${s.over20} over 20 ms, ${s.over33} over 33 ms; JavaScript p50 ${s.jsMs.p50.toFixed(2)} / ` +
    `max ${s.jsMs.max.toFixed(1)} ms; peaks ${Object.entries(s.peaks).map(([k, v]) => `${k} ${v}`).join(', ')}`
  );
}

/** The centre of the box of open, dry, unforested ground with the fewest bad cells in it (the first such, scanning). */
function findArena(world: World): { x: number; z: number } {
  const g = world.grid;
  if (!g) return { x: 0, z: 0 };
  const { width, height } = g;
  // A summed-area table of good cells, so each candidate box is four lookups.
  const sat = new Int32Array((width + 1) * (height + 1));
  for (let r = 0; r < height; r++) {
    let rowSum = 0;
    for (let c = 0; c < width; c++) {
      const [x, z] = g.centre(r, c);
      if (g.open(r, c) && g.cost[r * width + c]! <= 1.0001 && world.terrain.heightAt(x, z) > 1) rowSum++;
      sat[(r + 1) * (width + 1) + c + 1] = sat[r * (width + 1) + c + 1]! + rowSum;
    }
  }
  const hx = Math.ceil(HALF_X_M / g.cell);
  const hz = Math.ceil(HALF_Z_M / g.cell);
  let best = { r: height >> 1, c: width >> 1, score: -1 };
  for (let r = hz; r < height - hz; r += 2) {
    for (let c = hx; c < width - hx; c += 2) {
      const r0 = r - hz;
      const r1 = r + hz + 1;
      const c0 = c - hx;
      const c1 = c + hx + 1;
      const w = width + 1;
      const score = sat[r1 * w + c1]! - sat[r0 * w + c1]! - sat[r1 * w + c0]! + sat[r0 * w + c0]!;
      if (score > best.score) best = { r, c, score };
    }
  }
  const [x, z] = g.centre(best.r, best.c);
  return { x, z };
}

/** The player's mechs in a line on the west, facing east; every enemy in a block on the east, facing west. */
function stage(world: World, arena: { x: number; z: number }): void {
  const fighters = world.units.filter((u) => u.combat && u.alive);
  const own = fighters.filter((u) => u.team === PLAYER_TEAM);
  const enemies = fighters.filter((u) => u.team !== PLAYER_TEAM);
  const columns = Math.ceil(enemies.length / ENEMY_ROWS);
  const westX = arena.x - (GAP_M + (columns - 1) * SPACING_M) / 2;
  own.forEach((u, i) => place(world, u, westX, arena.z + (i - (own.length - 1) / 2) * 16, 90));
  enemies.forEach((u, i) => {
    const col = Math.floor(i / ENEMY_ROWS);
    const row = i % ENEMY_ROWS;
    place(world, u, westX + GAP_M + col * SPACING_M, arena.z + (row - (ENEMY_ROWS - 1) / 2) * SPACING_M, 270);
  });
  world.battle.reset();
  for (const u of fighters) u.combat!.rearm(world.battle.time);
}

function place(world: World, u: SeaUnit, x: number, z: number, rotation: number): void {
  [u.x, u.z] = world.openNear(x, z);
  u.rotation = rotation;
  u.twist = 0;
  u.attackOrder = null;
  u.target = null;
  u.stop();
}
