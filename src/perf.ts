// On-device performance test. Runs a fixed list of scenes, measures frame
// pacing and main-thread cost in each, collects device and GPU capabilities,
// and POSTs the report as JSON to the dev server (/api/perf, see vite.config.ts).
import { Vector2, type WebGLRenderer } from 'three';

const SETTLE_MS = 1500;
const MEASURE_MS = 5000;

export interface Scenario {
  name: string;
  description: string;
  setup(): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

/** Collects one sample per rendered frame while a measurement is running. */
export class FrameRecorder {
  private intervals: number[] | null = null;
  private cpu: number[] = [];
  private last = 0;

  /** Called from the render loop: rAF timestamp, and ms spent in update + render. */
  record(time: number, cpuMs: number) {
    if (!this.intervals) return;
    if (this.last) {
      this.intervals.push(time - this.last);
      this.cpu.push(cpuMs);
    }
    this.last = time;
  }

  start() {
    this.intervals = [];
    this.cpu = [];
    this.last = 0;
  }

  stop() {
    const result = { intervals: this.intervals ?? [], cpu: this.cpu };
    this.intervals = null;
    return result;
  }
}

export interface PerfHost {
  renderer: WebGLRenderer;
  recorder: FrameRecorder;
  scenarios: Scenario[];
  /** Pause and resume the viewer's render loop (to measure the display's own refresh rate). */
  pauseRendering(): void;
  resumeRendering(): void;
  /** Map and asset details to include in the report. */
  app: Record<string, unknown>;
  /** performance.now() milestones from page load. */
  load: Record<string, number>;
}

export async function runPerfTest(host: PerfHost, label: string, progress: (text: string) => void) {
  progress('Measuring display refresh…');
  const displayRefreshHz = await measureDisplayRefresh(host);
  const scenarios = [];
  for (const [i, scenario] of host.scenarios.entries()) {
    progress(`${i + 1}/${host.scenarios.length} ${scenario.description}… (don't touch the screen)`);
    try {
      await scenario.setup();
      await sleep(SETTLE_MS);
      host.recorder.start();
      await sleep(MEASURE_MS);
      const samples = host.recorder.stop();
      const info = host.renderer.info;
      const buffer = host.renderer.getDrawingBufferSize(new Vector2());
      scenarios.push({
        name: scenario.name,
        description: scenario.description,
        ...summarise(samples.intervals, samples.cpu),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        drawingBuffer: `${buffer.x}x${buffer.y}`,
        pixelRatio: host.renderer.getPixelRatio(),
      });
    } finally {
      host.recorder.stop();
      await scenario.teardown?.();
    }
  }
  progress('Collecting device details…');
  return {
    label,
    createdAt: new Date().toISOString(),
    app: host.app,
    device: await deviceInfo(host.renderer),
    load: host.load,
    displayRefreshHz,
    scenarios,
  };
}

export type PerfReport = Awaited<ReturnType<typeof runPerfTest>>;

function summarise(intervals: number[], cpu: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = (p: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  const total = intervals.reduce((a, b) => a + b, 0);
  const cpuSorted = [...cpu].sort((a, b) => a - b);
  return {
    frames: intervals.length,
    fps: round(total ? (intervals.length * 1000) / total : 0),
    frameMs: { median: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: round(sorted[sorted.length - 1] ?? 0) },
    /** Frames that took longer than two 60 Hz refreshes. */
    framesOver33ms: intervals.filter((t) => t > 33.4).length,
    /**
     * JavaScript time per frame (scene update + issuing draw calls). When fps is
     * low but this is small, the GPU is the bottleneck.
     */
    cpuMs: {
      mean: round(cpu.reduce((a, b) => a + b, 0) / Math.max(cpu.length, 1)),
      p95: round(cpuSorted[Math.floor(cpuSorted.length * 0.95)] ?? 0),
    },
  };
}

async function measureDisplayRefresh(host: PerfHost): Promise<number> {
  host.pauseRendering();
  const intervals: number[] = [];
  await new Promise<void>((resolve) => {
    let last = 0;
    const tick = (t: number) => {
      if (last) intervals.push(t - last);
      last = t;
      if (intervals.length < 90) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  host.resumeRendering();
  const median = intervals.sort((a, b) => a - b)[intervals.length >> 1];
  return Math.round(1000 / median);
}

// Minimal WebGPU shapes, to avoid a dependency on @webgpu/types.
interface GpuAdapter {
  features: Iterable<string>;
  limits: Record<string, number>;
  info?: { vendor: string; architecture: string; device: string; description: string };
}
interface GpuNavigator {
  gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapter | null> };
}

async function deviceInfo(renderer: WebGLRenderer) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const extensions = gl.getSupportedExtensions() ?? [];
  const nav = navigator as Navigator & { deviceMemory?: number } & GpuNavigator;
  return {
    userAgent: navigator.userAgent,
    // iPadOS reports "MacIntel" with touch points > 1.
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory ?? null,
    screen: {
      width: screen.width,
      height: screen.height,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
    },
    isSecureContext: window.isSecureContext,
    webgl: {
      version: gl.getParameter(gl.VERSION),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxSamples: gl.getParameter(gl.MAX_SAMPLES),
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      // Compressed formats decide what a texture pipeline should ship (ASTC on Apple GPUs).
      extensions: extensions.filter((e) =>
        /compressed_texture|color_buffer_float|texture_float_linear|timer_query|clip_control|depth_clamp/.test(e),
      ),
    },
    webgpu: await webgpuInfo(nav),
  };
}

async function webgpuInfo(nav: GpuNavigator) {
  if (!nav.gpu) {
    return {
      available: false,
      reason: window.isSecureContext ? 'navigator.gpu is missing' : 'not a secure context: WebGPU needs HTTPS (npm run dev:https)',
    };
  }
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'requestAdapter returned null' };
    const limitNames = [
      'maxTextureDimension2D',
      'maxStorageBufferBindingSize',
      'maxStorageTexturesPerShaderStage',
      'maxComputeWorkgroupStorageSize',
      'maxComputeInvocationsPerWorkgroup',
      'maxComputeWorkgroupSizeX',
      'maxComputeWorkgroupsPerDimension',
    ];
    return {
      available: true,
      adapter: adapter.info
        ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }
        : null,
      features: [...adapter.features].sort(),
      limits: Object.fromEntries(limitNames.map((n) => [n, adapter.limits[n]])),
    };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

/** POSTs the report to the dev server; resolves to the saved file name. */
export async function sendReport(report: PerfReport): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/perf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { file: string }).file;
}

/** Wires up the on-screen panel (#perf in index.html). */
export function mountPerfPanel(host: PerfHost) {
  const panel = document.getElementById('perf')!;
  const labelInput = document.getElementById('perf-label') as HTMLInputElement;
  const button = document.getElementById('perf-run') as HTMLButtonElement;
  const statusLine = document.getElementById('perf-status')!;
  const results = document.getElementById('perf-results') as HTMLTableElement;
  try {
    labelInput.value = localStorage.getItem('perf-label') ?? '';
  } catch {
    // Storage can be unavailable (private browsing); the label just isn't remembered.
  }
  panel.hidden = false;

  button.addEventListener('click', async () => {
    const label = labelInput.value.trim();
    try {
      localStorage.setItem('perf-label', label);
    } catch {
      // See above.
    }
    button.disabled = true;
    document.body.classList.add('perf-running');
    results.replaceChildren();
    let report: PerfReport | null = null;
    try {
      report = await runPerfTest(host, label, (text) => (statusLine.textContent = text));
      showResults(results, report);
      statusLine.textContent = 'Sending…';
      const file = await sendReport(report);
      statusLine.textContent = `Sent. Saved on the server as ${file}`;
    } catch (err) {
      statusLine.textContent = `Couldn't ${report ? 'send' : 'finish'} the test: ${err instanceof Error ? err.message : err}. `;
      if (report) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        link.download = 'perf-report.json';
        link.textContent = 'Download the JSON instead';
        statusLine.append(link);
      }
    } finally {
      button.disabled = false;
      document.body.classList.remove('perf-running');
    }
  });
}

function showResults(table: HTMLTableElement, report: PerfReport) {
  const row = (cells: (string | number)[], header = false) => {
    const tr = table.insertRow();
    for (const c of cells) {
      const cell = document.createElement(header ? 'th' : 'td');
      cell.textContent = String(c);
      tr.append(cell);
    }
  };
  // p95: 95th-percentile frame time; JS: mean script time per frame (both ms).
  row(['Scene', 'fps', 'p95', 'JS', 'draws'], true);
  for (const s of report.scenarios) row([s.name, s.fps, s.frameMs.p95, s.cpuMs.mean, s.drawCalls]);
  const caption = table.createCaption();
  caption.textContent = `Times in ms · display ${report.displayRefreshHz} Hz`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number) => Math.round(v * 10) / 10;
