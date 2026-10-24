import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Connect, type Plugin } from 'vite';

const REPORT_DIR = fileURLToPath(new URL('./perf-reports/', import.meta.url));
const MAX_REPORT_BYTES = 2_000_000;

/**
 * Receives the JSON report the viewer's "Run perf test" button POSTs to
 * /api/perf and saves it under perf-reports/. Works with `vite` and `vite preview`.
 */
function perfReports(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPORT_BYTES) {
        res.statusCode = 413;
        res.end();
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let report: PerfReportSummary;
      try {
        report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.end('invalid JSON');
        return;
      }
      const label =
        String(report.label || 'device')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'device';
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`;
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(REPORT_DIR + name, JSON.stringify(report, null, 2));
      console.log(`\nperf report from "${report.label || 'device'}" saved to perf-reports/${name}`);
      for (const s of report.scenarios ?? []) {
        console.log(`  ${s.name.padEnd(22)} ${s.fps.toFixed(1).padStart(6)} fps   p95 ${s.frameMs.p95.toFixed(1)} ms`);
      }
      // The sea page's survey: per-frame GPU cost of each configuration, from each fixed view.
      for (const r of report.rows ?? []) {
        const range = r.costLowMs !== undefined ? `${r.costLowMs.toFixed(2)}-${(r.costHighMs ?? r.costMs).toFixed(2)}` : r.costMs.toFixed(2);
        console.log(`  ${(r.view ?? '').padEnd(12)} ${r.name.padEnd(30)} ${range.padStart(11)} ms${r.clipped ? '*' : ' '}  (${r.deltaMs >= 0 ? '+' : ''}${r.deltaMs.toFixed(2)})`);
      }
      // The pacing survey: the opening view in real time, as it is and with each suspect taken away.
      for (const s of report.samples ?? []) {
        console.log(
          `  ${s.name.padEnd(28)} ${s.fps.toFixed(1).padStart(5)} fps, refresh p95 ${s.intervalMs.p95.toFixed(0)} ms, ` +
            `max ${s.intervalMs.max.toFixed(0)} ms, ${s.over20} over 20 ms`,
        );
      }
      // The battle survey in real time: the units standing, then the fight.
      for (const [name, live] of [['standing', report.standing], ['live fight', report.live]] as const) {
        if (!live) continue;
        console.log(
          `  ${name}: ${live.seconds.toFixed(0)} s at ${live.fps.toFixed(1)} fps, refresh p99 ${live.intervalMs.p99.toFixed(1)} ms, ` +
            `${live.over20} frames over 20 ms, JavaScript p50 ${live.jsMs.p50.toFixed(2)} ms max ${live.jsMs.max.toFixed(1)} ms`,
        );
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ file: `perf-reports/${name}` }));
    });
  };
  return {
    name: 'perf-reports',
    configureServer: (server) => void server.middlewares.use('/api/perf', handler),
    configurePreviewServer: (server) => void server.middlewares.use('/api/perf', handler),
  };
}

interface LiveSummary {
  seconds: number;
  fps: number;
  intervalMs: { p95: number; p99: number; max: number };
  over20: number;
  jsMs: { p50: number; max: number };
}

interface PerfReportSummary {
  label?: string;
  scenarios?: { name: string; fps: number; frameMs: { p95: number } }[];
  standing?: LiveSummary;
  samples?: (LiveSummary & { name: string })[];
  live?: LiveSummary;
  rows?: { view?: string; name: string; costMs: number; costLowMs?: number; costHighMs?: number; deltaMs: number; clipped: boolean }[];
}

export default defineConfig(({ mode }) => ({
  // `npm run dev:https` serves over HTTPS with a self-signed certificate. WebGPU
  // only exists in secure contexts, so the perf test can only probe it that way
  // from another device on the LAN.
  plugins: [perfReports(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: { host: true },
  // Converted game data lives in public/assets, so keep Vite's bundle out of that folder.
  build: {
    target: 'es2022',
    assetsDir: 'static',
    chunkSizeWarningLimit: 1500,
    // Two pages: the WebGPU game, and the three.js (WebGL) viewer it falls back to.
    rollupOptions: { input: { main: 'index.html', viewer: 'viewer.html' } },
  },
}));
