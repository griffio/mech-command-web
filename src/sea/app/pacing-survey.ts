// The pacing survey: why the WebGPU page shows about 57 frames a second on the iPad where the WebGL viewer holds 60,
// though a frame costs its GPU about 4 ms. It plays the opening view in real time, one frame per refresh, with the
// units standing, once as it is and once with each suspect taken away, down to a frame that only clears the screen.
// A variant that comes out at a steady 60 is the culprit (or, if only the bare frame does, it's the work as a whole).
import type { SeaDebugFlags, SeaRenderer } from '../render/sea-renderer';
import type { LiveSample, PerfSurvey } from './perf-survey';

const SAMPLE_MS = 12_000;
const FLOOR: Partial<SeaDebugFlags> = {
  skipOceanDraw: true,
  freezeOcean: true,
  skipBloom: true,
  skipClouds: true,
  skipTerrain: true,
  skipProps: true,
  skipUnits: true,
  skipShadows: true,
  skipFx: true,
};

interface Variant {
  name: string;
  flags: Partial<SeaDebugFlags>;
  quietHud?: boolean;
  scale?: number;
}

const VARIANTS: Variant[] = [
  { name: 'as is', flags: {} },
  { name: 'no GPU timer', flags: { skipTimer: true } },
  { name: 'no HUD updates', flags: {}, quietHud: true },
  { name: 'no matrix upload', flags: { skipMatrixUpload: true } },
  { name: 'resolution 50%', flags: {}, scale: 0.5 },
  { name: 'floor: sky + composite only', flags: FLOOR },
  { name: 'floor, no timer/HUD/upload', flags: { ...FLOOR, skipTimer: true, skipMatrixUpload: true }, quietHud: true },
  { name: 'bare frame: clear only', flags: { bareFrame: true }, quietHud: true },
  { name: 'as is (end)', flags: {} },
];

export interface PacingSample extends LiveSample {
  name: string;
}

export async function runPacingSurvey(survey: PerfSurvey, sea: SeaRenderer, showOpening: () => void, log: (line: string) => void): Promise<{ samples: PacingSample[] }> {
  showOpening();
  const defaults = { ...sea.debug };
  const samples: PacingSample[] = [];
  try {
    for (const v of VARIANTS) {
      Object.assign(sea.debug, defaults, v.flags);
      survey.quietHud = !!v.quietHud;
      const s = await survey.sampleLive({ maxMs: SAMPLE_MS, worldLive: false, scale: v.scale ?? 1 });
      samples.push({ name: v.name, ...s });
      log(
        `${v.name.padEnd(28)} ${s.fps.toFixed(1).padStart(5)} fps  refresh p50 ${s.intervalMs.p50.toFixed(0)} p95 ${s.intervalMs.p95.toFixed(0)} ` +
          `max ${s.intervalMs.max.toFixed(0)} ms  ${s.over20} over 20 ms  JS p50 ${s.jsMs.p50.toFixed(1)} ms`,
      );
    }
  } finally {
    Object.assign(sea.debug, defaults);
    survey.quietHud = false;
  }
  return { samples };
}
