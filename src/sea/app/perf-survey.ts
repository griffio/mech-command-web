// Taken from the dreadnought game (src/app/perf-survey.ts at 5a27af7), with the ship, battle and smoke steps removed,
// and changed to measure from fixed camera views and to bound each cost within a sixth of itself. Its steps come in
// plans: the sea survey's, and the battle survey's (see battle-survey.ts), which also records a fight in real time.
import type { SeaDebugFlags, SeaRenderer } from '../render/sea-renderer';

export interface SurveyRow {
  /** The camera view the row was measured from (see SurveyView). */
  view: string;
  name: string;
  scale: number;
  pixels: number;
  /** Frames rendered per display refresh during this step (stress multiplier). */
  repeats: number;
  /** Display refreshes per second actually achieved. */
  fps: number;
  /** Milliseconds per display refresh. */
  intervalMs: number;
  /**
   * What one frame costs: the true value lies between costLowMs and costHighMs. The display only shows whole refreshes,
   * so an interval can be up to one refresh longer than the GPU's work; costMs is the middle of the range.
   */
  costMs: number;
  costLowMs: number;
  costHighMs: number;
  /** costMs minus the nearest earlier baseline's in the same view: what turning this feature off saved (negative). */
  deltaMs: number;
  /** JavaScript time to encode and submit one frame, ms. */
  cpuMs: number;
  /** JavaScript time to move, animate and fight the units, once per display refresh, ms. */
  simMs: number;
  /** True when even the repeat cap could not stretch the interval to the target, so the range is wider. */
  clipped: boolean;
  /** Sum of per-phase GPU timestamps; on tile-based GPUs these overlap, so treat as a relative hint only. */
  timestampSumMs: number | null;
}

/** A camera view the survey measures from; `apply` puts the camera there. */
export interface SurveyView {
  name: string;
  apply(): void;
}

export interface SurveyStep {
  name: string;
  scale: number;
  flags: Partial<SeaDebugFlags>;
  /** Measured from every view (otherwise only from the first). */
  everyView?: boolean;
  /** The units move and fight during the step; otherwise the world holds still, so every row sees the same picture. */
  live?: boolean;
}

/** What to measure: steps, each from the views it asks for. */
export interface SurveyPlan {
  views: SurveyView[];
  steps: SurveyStep[];
}

/** Percentiles of a per-frame series, ms. */
export interface Spread {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Frames at one frame per refresh, as played. */
export interface LiveSample {
  seconds: number;
  frames: number;
  fps: number;
  /** Time between display refreshes. */
  intervalMs: Spread;
  /** Refreshes that took longer than 20 ms (a dropped frame at 60 Hz) and longer than 33 ms (two or more). */
  over20: number;
  over33: number;
  /** JavaScript per refresh: the units' update and the frame's encoding together. */
  jsMs: Spread;
  simMs: Spread;
  /** The largest value each counter reached. */
  peaks: Record<string, number>;
}

// Each row turns one thing off (or changes the resolution); what it saves against a baseline near it, in the same view,
// is that thing's cost. Baselines recur because a tablet throttles as it warms and late rows drift.
export const SEA_STEPS: SurveyStep[] = [
  { name: 'baseline', scale: 1, flags: {}, everyView: true },
  { name: 'ocean field frozen (no FFT)', scale: 1, flags: { freezeOcean: true }, everyView: true },
  { name: 'no sea surface drawn', scale: 1, flags: { skipOceanDraw: true }, everyView: true },
  { name: 'no land drawn', scale: 1, flags: { skipTerrain: true } },
  { name: 'no buildings or trees', scale: 1, flags: { skipProps: true }, everyView: true },
  { name: 'no units', scale: 1, flags: { skipUnits: true }, everyView: true },
  { name: 'no sun shadows', scale: 1, flags: { skipShadows: true }, everyView: true },
  { name: 'baseline (middle)', scale: 1, flags: {}, everyView: true },
  { name: 'no sky drawn', scale: 1, flags: { skipSkyDraw: true } },
  { name: 'no bloom', scale: 1, flags: { skipBloom: true } },
  { name: 'resolution 75%', scale: 0.75, flags: {}, everyView: true },
  { name: 'resolution 50%', scale: 0.5, flags: {} },
  {
    name: 'floor: sky + composite only',
    scale: 1,
    flags: { skipOceanDraw: true, freezeOcean: true, skipBloom: true, skipClouds: true, skipTerrain: true, skipProps: true, skipUnits: true, skipShadows: true },
  },
  { name: 'baseline (end)', scale: 1, flags: {}, everyView: true },
];

const WARMUP_MS = 1800;
const MEASURE_MS = 3200;
/** A re-measure with more repeats only needs a short warm-up: the configuration has not changed. */
const REMEASURE_WARMUP_MS = 700;
/**
 * Stress until one interval spans this many display refreshes. The display rounds each interval up to whole refreshes,
 * so the cost is known to within one refresh in this many: a sixth.
 */
const TARGET_REFRESHES = 6;
const MAX_REPEATS = 160;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Measures what each feature costs on the device it runs on.
 *
 * A vsync-locked display hides cost: every configuration reads 60 fps until it fails. So the survey renders each frame
 * several times per refresh (`repeats`), enough that an interval spans several refreshes; then interval / repeats is
 * the per-frame cost, give or take one refresh / repeats. The frame loop must call `onFrame` every refresh and render
 * `repeats` times.
 */
export class PerfSurvey {
  running = false;
  /** Frames the main loop should render per display refresh right now. */
  repeats = 1;
  /** The main loop should move and fight the units (while running; outside a survey they always do). */
  worldLive = false;
  private frames = 0;
  private intervalSum = 0;
  private intervalMin = Infinity;
  private cpuSum = 0;
  private simSum = 0;
  private live: { interval: number[]; js: number[]; sim: number[]; peaks: Record<string, number>; counters: () => Record<string, number> } | null =
    null;

  constructor(
    private readonly sea: SeaRenderer,
    private readonly setScale: (scale: number) => void,
    private readonly pixelCount: () => number,
  ) {}

  /** Called every display refresh: its interval, JavaScript to encode one frame, and to update the world once. */
  onFrame(intervalMs: number, cpuMsPerFrame: number, simMs = 0): void {
    this.frames++;
    this.intervalSum += intervalMs;
    this.intervalMin = Math.min(this.intervalMin, intervalMs);
    this.cpuSum += cpuMsPerFrame;
    this.simSum += simMs;
    const live = this.live;
    if (live) {
      live.interval.push(intervalMs);
      live.js.push(simMs + cpuMsPerFrame * this.repeats);
      live.sim.push(simMs);
      for (const [k, v] of Object.entries(live.counters())) live.peaks[k] = Math.max(live.peaks[k] ?? 0, v);
    }
  }

  private async measure(warmupMs = WARMUP_MS): Promise<{ fps: number; intervalMs: number; minMs: number; cpuMs: number; simMs: number }> {
    await wait(warmupMs);
    this.frames = 0;
    this.intervalSum = 0;
    this.intervalMin = Infinity;
    this.cpuSum = 0;
    this.simSum = 0;
    const t0 = performance.now();
    await wait(MEASURE_MS);
    const seconds = (performance.now() - t0) / 1000;
    const n = Math.max(this.frames, 1);
    return { fps: this.frames / seconds, intervalMs: this.intervalSum / n, minMs: this.intervalMin, cpuMs: this.cpuSum / n, simMs: this.simSum / n };
  }

  /**
   * Play in real time, one frame per refresh at full resolution, until `done` or `maxMs`, and return how the frames
   * went. `counters` is sampled every frame for its peaks (particles, beams). With `worldLive` false the units only
   * stand and breathe: what the page's frame pacing is with nothing happening.
   */
  async sampleLive(maxMs: number, done: () => boolean, counters: () => Record<string, number>, worldLive = true): Promise<LiveSample> {
    this.running = true;
    this.worldLive = worldLive;
    this.repeats = 1;
    this.setScale(1);
    const live = { interval: [] as number[], js: [] as number[], sim: [] as number[], peaks: {} as Record<string, number>, counters };
    const t0 = performance.now();
    try {
      await wait(300); // let the new resolution settle before counting
      live.interval.length = live.js.length = live.sim.length = 0;
      this.live = live;
      while (performance.now() - t0 < maxMs && !done()) await wait(100);
    } finally {
      this.live = null;
      this.worldLive = false;
      this.running = false;
    }
    const seconds = live.interval.reduce((s, v) => s + v, 0) / 1000;
    return {
      seconds,
      frames: live.interval.length,
      fps: live.interval.length / Math.max(seconds, 1e-3),
      intervalMs: spread(live.interval),
      over20: live.interval.filter((v) => v > 20).length,
      over33: live.interval.filter((v) => v > 33.4).length,
      jsMs: spread(live.js),
      simMs: spread(live.sim),
      peaks: live.peaks,
    };
  }

  async run(plan: SurveyPlan, log: (line: string) => void): Promise<SurveyRow[]> {
    this.running = true;
    const { views, steps } = plan;
    const flags = this.sea.debug;
    const defaults = { ...flags };
    const rows: SurveyRow[] = [];
    try {
      // Calibrate on the first view: the display's refresh, and roughly what a frame costs.
      Object.assign(flags, defaults);
      views[0]?.apply();
      this.setScale(1);
      this.worldLive = !!steps[0]?.live;
      this.repeats = 1;
      const probe = await this.measure();
      const refreshMs = Math.min(Math.max(probe.minMs, 4), 1000 / 50);
      const target = TARGET_REFRESHES * refreshMs;
      let estimate = probe.intervalMs; // cost of one frame, at most
      log(`calibration: display ${(1000 / refreshMs).toFixed(0)} Hz, ${probe.fps.toFixed(1)} fps at 1 frame per refresh`);

      for (const [v, view] of views.entries()) {
        view.apply();
        for (const step of steps.filter((s) => v === 0 || s.everyView)) {
          Object.assign(flags, defaults, step.flags);
          this.setScale(step.scale);
          this.worldLive = !!step.live;
          // Start from the last row's cost, then re-measure until an interval spans the target number of refreshes.
          let used = clampRepeats(Math.ceil((target * 1.15) / Math.max(estimate, 0.05)));
          this.repeats = used;
          let m = await this.measure();
          for (let tries = 0; m.intervalMs < target * 0.95 && used < MAX_REPEATS && tries < 3; tries++) {
            used = clampRepeats(Math.ceil((used * target * 1.15) / Math.max(m.intervalMs, 1)));
            this.repeats = used;
            m = await this.measure(REMEASURE_WARMUP_MS);
          }
          const high = m.intervalMs / used;
          const low = Math.max(m.intervalMs - refreshMs, 0) / used;
          const costMs = (high + low) / 2;
          estimate = high;
          const baseline = rows.findLast((r) => r.view === view.name && r.name.startsWith('baseline'))?.costMs ?? costMs;
          const row: SurveyRow = {
            view: view.name,
            name: step.name,
            scale: step.scale,
            pixels: this.pixelCount(),
            repeats: used,
            fps: m.fps,
            intervalMs: m.intervalMs,
            costMs,
            costLowMs: low,
            costHighMs: high,
            deltaMs: costMs - baseline,
            cpuMs: m.cpuMs,
            simMs: m.simMs,
            clipped: m.intervalMs < target * 0.95,
            timestampSumMs: this.sea.gpuTimes?.total ?? null,
          };
          rows.push(row);
          log(
            `${view.name.padEnd(10)} ${row.name.padEnd(28)} ${low.toFixed(2)}-${high.toFixed(2)} ms${row.clipped ? '*' : ' '} ` +
              `(${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs.toFixed(2)})  x${used}  cpu ${row.cpuMs.toFixed(2)} ms` +
              (step.live ? `  sim ${row.simMs.toFixed(2)} ms` : ''),
          );
        }
      }
      log('* = even the repeat cap could not stretch the interval to the target, so the range is wider');
    } finally {
      Object.assign(flags, defaults);
      this.repeats = 1;
      this.worldLive = false;
      this.running = false;
    }
    return rows;
  }
}

function spread(values: number[]): Spread {
  if (!values.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(Math.floor(q * s.length), s.length - 1)]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1]! };
}

function clampRepeats(n: number): number {
  return Math.min(Math.max(n, 1), MAX_REPEATS);
}
