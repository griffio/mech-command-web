// The MC2 map on the dreadnought game's WebGPU sea and sky (the ocean-experiment branch): the ground, the sea and
// its surf, the sky, and MC2's buildings, trees, mechs and vehicles with the sun's shadows.
//
// MC2 world units become metres (5.01 units a metre); the sea level is the mission's water elevation. Axes
// follow the dreadnought game: x east, y up, z south (north is -z), which is also what the three.js viewer uses.
import '../style.css';
import { ASSET_ROOT, loadBinary, loadJson, type MapInfo } from '../assets.ts';
import { OrbitControls } from './app/orbit-controls';
import { PerfSurvey, type SurveyRow } from './app/perf-survey';
import { initGpu } from './platform/gpu-device';
import { CanvasSizer } from './platform/resize';
import { Camera } from './render/camera';
import { MapGround } from './render/map/map-ground';
import { RenderScaleController } from './render/render-scale';
import { DEFAULT_SEA, SeaRenderer, type SeaQuality } from './render/sea-renderer';
import { SurfLines } from './sim/terrain/surf';
import { Terrain } from './sim/terrain/terrain';
import { mc2TerrainGrid, upsampleGrid } from './app/mc2-map';
import { World } from './app/world';

/** The dreadnought game's pixel budget: a Retina iPad canvas is about 5.6 MP, more than the sea needs. */
const MAX_PIXELS = 3_600_000;

const status = document.getElementById('status')!;
const selection = document.getElementById('selection')!;
const stats = document.getElementById('stats')!;
const setStatus = (text: string) => (status.textContent = text);

async function main() {
  const q = new URLSearchParams(location.search);
  const quality: SeaQuality = { oceanSize: q.get('q') === 'B' ? 128 : 256, msaa: q.get('msaa') === '1' ? 1 : 4 };
  const fixedScale = q.has('scale') ? Number(q.get('scale')) : null;

  const canvas = document.getElementById('sea') as HTMLCanvasElement;
  let deviceLost = false;
  const init = await initGpu((reason) => {
    deviceLost = true;
    setStatus(`The GPU device was lost (${reason}). Reload the page.`);
  });
  if (!init.ok) {
    setStatus(init.reason === 'insecure-context' ? `${init.message} Start the dev server with npm run dev:https.` : init.message);
    return;
  }
  const { gpu } = init;

  const manifest = await loadJson<{ maps: string[] }>('manifest.json').catch(() => null);
  if (!manifest) {
    setStatus('No converted assets found. Run: npm run fetch-data && npm run convert');
    return;
  }
  const mapName = q.get('map') ?? manifest.maps[0]!;
  const dir = `maps/${mapName}/`;
  setStatus(`Loading ${mapName}…`);
  const info = await loadJson<MapInfo>(dir + 'map.json');
  const image = async (file: string) => {
    const res = await fetch(ASSET_ROOT + dir + file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  };
  const [elevation, colormap, detail] = await Promise.all([
    loadBinary(dir + info.elevation.file).then((b) => new Float32Array(b)),
    image(info.colormap.file),
    info.detail ? image(info.detail.file) : Promise.resolve(null),
  ]);

  // MC2 units to metres, heights relative to the sea. The land is meshed (and its surf laid) on a grid twice as fine as
  // MC2's, blended between its samples; the sea reads the original heights for the sea floor.
  const upm = info.worldUnitsPerMeter;
  const grid = mc2TerrainGrid(info, elevation);
  const terrain = new Terrain(upsampleGrid(grid, 2), 40);
  const surf = new SurfLines(new Terrain(upsampleGrid(grid, 4), 40), { band: 9, foam: 0.42, swing: 0.2, spatialPhase: true });
  const ground = MapGround.create(gpu.device, {
    heights: grid.heights,
    side: grid.nx,
    cell: grid.cell,
    x0: grid.x0,
    z0: grid.z0,
    colormap,
    detail,
    detailTiling: info.detail?.tiling ?? 30,
  });

  // The mission's sun (MC2 world: x east, y north, z up), so the sky agrees with the shadows baked into the colour map.
  const [sx, sy, sz] = info.light.sun;
  const sun = {
    sunElevationDeg: (Math.asin(Math.min(Math.max(sz, -1), 1)) * 180) / Math.PI,
    sunAzimuthDeg: ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360,
  };
  setStatus('Building the sea…');
  const sea = await SeaRenderer.create(gpu, canvas, quality, { ...DEFAULT_SEA, ...sun });
  sea.setMap(terrain, ground, surf);
  const world = await World.load(sea, terrain, info, dir, setStatus);

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.5;
  const controls = new OrbitControls(
    canvas,
    camera,
    { target: [info.camera.x / upm, 0, -info.camera.y / upm], distance: 340, yawDeg: 0, pitchDeg: 42 },
    { minDistance: 40, maxDistance: 2400, minPitchDeg: 8, maxPitchDeg: 88, halfExtent: (grid.nx / 2) * grid.cell },
  );
  controls.groundAt = (x, z) => terrain.heightAt(x, z);

  // Tap a unit to select it; tap the ground to send the selected mech there.
  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 400) return;
    const rect = canvas.getBoundingClientRect();
    const hit = world.pick(camera, ((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    if (!hit) return;
    if (Array.isArray(hit)) {
      if (world.selected?.kind === 'mech') world.selected.walkTo([hit]);
    } else {
      world.select(hit);
    }
  });

  const sizer = new CanvasSizer(canvas, gpu.device.limits.maxTextureDimension2D, (w, h) => sea.resize(w, h), MAX_PIXELS);
  if (fixedScale !== null) sizer.renderScale = fixedScale;
  const scaler = new RenderScaleController();
  const survey = new PerfSurvey(sea, (scale) => (sizer.renderScale = scale), () => sizer.width * sizer.height);
  mountSurveyPanel(survey, () => ({
    kind: 'sea-survey',
    map: mapName,
    userAgent: navigator.userAgent,
    adapter: { vendor: gpu.adapterInfo.vendor, architecture: gpu.adapterInfo.architecture },
    devicePixelRatio: window.devicePixelRatio,
    quality,
    canvas: `${sizer.width}x${sizer.height}`,
    land: sea.landStats,
    oceanDrawnFraction: Math.round(sea.oceanArc.drawnFraction * 100) / 100,
    objects: { props: world.propCount, units: world.units.length, drawn: sea.models.drawnInstances, shadowCasters: sea.models.shadowInstances },
  }), () => {
    if (fixedScale === null) sizer.renderScale = scaler.scale;
  });

  setStatus('');
  let last = performance.now();
  let fpsFrames = 0;
  let fpsSince = last;
  const frame = (now: number) => {
    if (deviceLost) return;
    const frameMs = now - last;
    const dt = Math.min(Math.max(frameMs / 1000, 0), 0.1);
    last = now;
    controls.update();
    camera.update(canvas.clientWidth / Math.max(canvas.clientHeight, 1));
    world.update(dt);
    // The shadow map covers what the camera looks at, growing in 25% steps as it zooms out (so it doesn't shimmer).
    const reach = Math.min(Math.max(controls.distance * 1.1, 120), 1300);
    sea.shadowFocus = { x: controls.target[0], z: controls.target[2], half: 1.25 ** Math.ceil(Math.log(reach) / Math.log(1.25)) };
    // Normally one frame per refresh; the survey renders several to saturate the GPU and expose real cost.
    const repeats = survey.repeats;
    const encodeStart = performance.now();
    for (let i = 0; i < repeats; i++) sea.frame(dt / repeats, camera);
    const cpuMs = (performance.now() - encodeStart) / repeats;
    survey.onFrame(frameMs, cpuMs);
    if (fixedScale === null && !survey.running) {
      const next = scaler.sample(frameMs, dt);
      if (next !== null) sizer.renderScale = next;
    }

    fpsFrames++;
    if (now - fpsSince > 500) {
      const fps = (fpsFrames * 1000) / (now - fpsSince);
      const gpuMs = sea.gpuTimes?.total;
      stats.textContent =
        `${fps.toFixed(0)} fps · ${sizer.width}×${sizer.height} (scale ${sizer.renderScale.toFixed(2)}) · ` +
        `JS ${cpuMs.toFixed(1)} ms${gpuMs ? ` · GPU ~${gpuMs.toFixed(1)} ms` : ''} · ocean ${quality.oceanSize}² · ` +
        `${Math.round(sea.oceanArc.drawnFraction * 100)}% of the sea grid · land ${sea.landStats.tiles} tiles · ` +
        `${sea.models.drawnInstances} objects drawn, ${sea.models.shadowInstances} casting shadows`;
      const sel = world.selected;
      selection.textContent = sel ? `Selected: ${sel.name} (${sel.kind})${sel.kind === 'mech' ? ' · tap the ground to walk there' : ''}` : '';
      fpsFrames = 0;
      fpsSince = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  Object.assign(window, { sea: { sea, camera, controls, terrain, sizer, survey, world } });
}

/** The panel's button runs the survey and POSTs the report to the dev server (see vite.config.ts). */
function mountSurveyPanel(survey: PerfSurvey, context: () => Record<string, unknown>, done: () => void) {
  const panel = document.getElementById('perf')!;
  const labelInput = document.getElementById('perf-label') as HTMLInputElement;
  const button = document.getElementById('perf-run') as HTMLButtonElement;
  const log = document.getElementById('perf-status')!;
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
    log.textContent = "Sea survey: don't touch the screen for about two minutes.\n";
    let rows: SurveyRow[] = [];
    try {
      rows = await survey.run((line) => (log.textContent += line + '\n'));
      const report = { label, createdAt: new Date().toISOString(), ...context(), rows };
      const res = await fetch(`${import.meta.env.BASE_URL}api/perf`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      log.textContent += res.ok ? `Sent. Saved on the server as ${((await res.json()) as { file: string }).file}` : `Couldn't send the report: HTTP ${res.status}`;
    } catch (err) {
      log.textContent += `Survey failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      button.disabled = false;
      document.body.classList.remove('perf-running');
      done();
    }
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err instanceof Error ? err.message : err}`);
});
