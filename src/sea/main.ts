// The MC2 map on the dreadnought game's WebGPU sea and sky (the ocean-experiment branch): the ground, the sea and
// its surf, the sky, and MC2's buildings, trees, mechs and vehicles with the sun's shadows.
//
// MC2 world units become metres (5.01 units a metre); the sea level is the mission's water elevation. Axes
// follow the dreadnought game: x east, y up, z south (north is -z), which is also what the three.js viewer uses.
import '../style.css';
import { ASSET_ROOT, loadBinary, loadJson, type MapInfo, type Scenario } from '../assets.ts';
import { OrbitControls } from './app/orbit-controls';
import { runBattleSurvey } from './app/battle-survey';
import { runPacingSurvey } from './app/pacing-survey';
import { PerfSurvey, SEA_STEPS } from './app/perf-survey';
import { initGpu } from './platform/gpu-device';
import { CanvasSizer } from './platform/resize';
import { Camera } from './render/camera';
import { MapGround } from './render/map/map-ground';
import { RenderScaleController } from './render/render-scale';
import { DEFAULT_SEA, SeaRenderer, type SeaQuality } from './render/sea-renderer';
import { SurfLines } from './sim/terrain/surf';
import { Terrain } from './sim/terrain/terrain';
import { mc2TerrainGrid, upsampleGrid } from './app/mc2-map';
import { CommanderAI } from './app/match';
import { MatchHud } from './app/match-hud';
import { UnitBars } from './app/unit-bars';
import { PLAYER_TEAM, World, type SeaUnit } from './app/world';

/** The dreadnought game's pixel budget: a Retina iPad canvas is about 5.6 MP, more than the sea needs. */
const MAX_PIXELS = 3_600_000;
/** Camera distances (metres from what it looks at) over which the sun's shadows fade out. */
const SHADOW_FADE_START_M = 700;
const SHADOW_FADE_END_M = 1000;

const status = document.getElementById('status')!;
const selection = document.getElementById('selection')!;
const stats = document.getElementById('stats')!;
const setStatus = (text: string) => (status.textContent = text);

/** The scenarios (scenarios/*.json), played on their maps; `?scenario=none` shows the mission's own units instead. */
const SCENARIOS = Object.values(import.meta.glob<Scenario>('../../scenarios/*.json', { eager: true, import: 'default' }));

async function main() {
  const q = new URLSearchParams(location.search);
  const quality: SeaQuality = { oceanSize: q.get('q') === 'B' ? 128 : 256, msaa: q.get('msaa') === '1' ? 1 : 4 };
  const fixedScale = q.has('scale') ? Number(q.get('scale')) : null;
  // Debugging: run the world this many times as fast (whole steps).
  const speed = Math.max(1, Math.round(Number(q.get('speed') ?? 1)));

  const canvas = document.getElementById('sea') as HTMLCanvasElement;
  let deviceLost = false;
  const init = await initGpu((reason) => {
    deviceLost = true;
    setStatus(`The GPU device was lost (${reason}). Reload the page.`);
  });
  if (!init.ok) {
    // No WebGPU here (an older browser, or plain HTTP from another device): the WebGL viewer shows the same map.
    location.replace(`viewer.html?fallback=${encodeURIComponent(init.reason)}`);
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
  const scenario = q.get('scenario') === 'none' ? null : (SCENARIOS.find((s) => s.map === mapName) ?? null);
  const world = await World.load(sea, terrain, info, dir, setStatus, scenario);

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.5;
  // A match opens over the player's base, a little toward the first point; otherwise on the mission's camera.
  const base = world.match?.side(PLAYER_TEAM).base;
  const first = world.match?.points[0];
  const start: [number, number, number] =
    base && first ? [base.x + (first.x - base.x) * 0.3, 0, base.z + (first.z - base.z) * 0.3] : [info.camera.x / upm, 0, -info.camera.y / upm];
  const controls = new OrbitControls(
    canvas,
    camera,
    { target: start, distance: 340, yawDeg: 0, pitchDeg: 42 },
    { minDistance: 40, maxDistance: 2400, minPitchDeg: 8, maxPitchDeg: 88, halfExtent: (grid.nx / 2) * grid.cell },
  );
  controls.groundAt = (x, z) => terrain.heightAt(x, z);

  mountOrders(canvas, camera, world);
  const bars = new UnitBars(document.getElementById('bars')!);
  const hud = world.match
    ? new MatchHud(world, world.match, document.getElementById('match')!, document.getElementById('squads')!, document.getElementById('bars')!, (x, z) => {
        controls.target = [x, 0, z];
      })
    : null;
  if (world.match) {
    document.body.classList.add('match');
    const match = world.match;
    match.onEvent = (text, team) => {
      logEvent(text, team);
      if (match.winner !== null) setStatus(text);
    };
  }
  world.battle.onEvent = (text, team) => {
    logEvent(text, team);
    if (world.battle.outcome) setStatus(text);
  };

  const sizer = new CanvasSizer(canvas, gpu.device.limits.maxTextureDimension2D, (w, h) => sea.resize(w, h), MAX_PIXELS);
  if (fixedScale !== null) sizer.renderScale = fixedScale;
  const scaler = new RenderScaleController();
  // The survey measures from fixed views, so runs can be compared: the opening view over the player's lance, and the
  // whole map zoomed out, which is mostly sea.
  const opening = { target: [info.camera.x / upm, 0, -info.camera.y / upm] as [number, number, number], distance: 340, yawDeg: 0, pitchDeg: 42 };
  const view = (v: typeof opening) => () => {
    controls.target = [...v.target];
    controls.distance = v.distance;
    controls.yawDeg = v.yawDeg;
    controls.pitchDeg = v.pitchDeg;
  };
  const survey = new PerfSurvey(sea, (scale) => (sizer.renderScale = scale), () => sizer.width * sizer.height);
  const seaViews = [
    { name: 'opening', apply: view(opening) },
    { name: 'zoomed-out', apply: view({ target: [0, 0, 0], distance: 2300, yawDeg: 0, pitchDeg: 62 }) },
  ];
  let before: typeof opening | null = null;
  const restoreScale = () => {
    if (fixedScale === null) sizer.renderScale = scaler.scale;
  };
  mountSurveyPanel(() => ({
    map: mapName,
    userAgent: navigator.userAgent,
    adapter: { vendor: gpu.adapterInfo.vendor, architecture: gpu.adapterInfo.architecture },
    devicePixelRatio: window.devicePixelRatio,
    quality,
    canvas: `${sizer.width}x${sizer.height}`,
    land: sea.landStats,
    oceanDrawnFraction: Math.round(sea.oceanArc.drawnFraction * 100) / 100,
    objects: { props: world.propCount, units: world.units.length, drawn: sea.models.drawnInstances, shadowCasters: sea.models.shadowInstances },
  }), [
    {
      button: 'perf-run',
      kind: 'sea-survey',
      intro: "Sea survey: don't touch the screen for about three minutes.",
      run: async (log) => ({ rows: await survey.run({ views: seaViews, steps: SEA_STEPS }, log) }),
      start: () => {
        before = { target: [...controls.target], distance: controls.distance, yawDeg: controls.yawDeg, pitchDeg: controls.pitchDeg };
      },
      done: () => {
        restoreScale();
        if (before) view(before)();
      },
    },
    {
      button: 'perf-pacing',
      kind: 'pacing-survey',
      intro: "Pacing survey: the opening view in real time, nine ways. Don't touch the screen for about two minutes.",
      run: (log) => runPacingSurvey(survey, sea, view(opening), log),
      start: () => {
        before = { target: [...controls.target], distance: controls.distance, yawDeg: controls.yawDeg, pitchDeg: controls.pitchDeg };
      },
      done: () => {
        restoreScale();
        if (before) view(before)();
      },
    },
    {
      button: 'perf-battle',
      kind: 'battle-survey',
      intro: "Battle survey: every unit in one fight. Don't touch the screen for about four minutes.",
      run: async (log) => ({ ...(await runBattleSurvey(survey, world, sea, (v) => view(v)(), log)) }),
      done: restoreScale,
    },
  ]);

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
    const simStart = performance.now();
    for (let i = 0; i < speed; i++) world.update(dt, !survey.running || survey.worldLive);
    if (!survey.quietHud) {
      bars.update(world, camera, canvas.clientWidth, canvas.clientHeight);
      hud?.update(camera, canvas.clientWidth, canvas.clientHeight);
    }
    const simMs = performance.now() - simStart;
    // The shadow map covers what the camera looks at, growing in 25% steps as it zooms out (so it doesn't shimmer). The
    // shadows fade out between 700 and 1000 m: from further off a tree's shadow is a pixel or two, and the map's own
    // shadows are baked into its colour map anyway. Past the fade there is no shadow pass at all.
    const reach = Math.min(Math.max(controls.distance * 1.1, 120), 1100);
    const fade = Math.min(Math.max((controls.distance - SHADOW_FADE_START_M) / (SHADOW_FADE_END_M - SHADOW_FADE_START_M), 0), 1);
    const strength = 1 - fade * fade * (3 - 2 * fade);
    sea.shadowFocus =
      strength > 0 ? { x: controls.target[0], z: controls.target[2], half: 1.25 ** Math.ceil(Math.log(reach) / Math.log(1.25)), strength } : null;
    // Normally one frame per refresh; the survey renders several to saturate the GPU and expose real cost.
    const repeats = survey.repeats;
    const encodeStart = performance.now();
    for (let i = 0; i < repeats; i++) sea.frame(dt / repeats, camera);
    const cpuMs = (performance.now() - encodeStart) / repeats;
    survey.onFrame(frameMs, cpuMs, simMs);
    if (fixedScale === null && !survey.running) {
      const next = scaler.sample(frameMs, dt);
      if (next !== null) sizer.renderScale = next;
    }

    fpsFrames++;
    if (now - fpsSince > 500 && !survey.quietHud) {
      const fps = (fpsFrames * 1000) / (now - fpsSince);
      const gpuMs = sea.gpuTimes?.total;
      stats.textContent =
        `${fps.toFixed(0)} fps · ${sizer.width}×${sizer.height} (scale ${sizer.renderScale.toFixed(2)}) · ` +
        `JS ${cpuMs.toFixed(1)} ms${gpuMs ? ` · GPU ~${gpuMs.toFixed(1)} ms` : ''} · ocean ${quality.oceanSize}² · ` +
        `${Math.round(sea.oceanArc.drawnFraction * 100)}% of the sea grid · land ${sea.landStats.tiles} tiles · ` +
        `${sea.models.drawnInstances} objects drawn, ${sea.models.shadowInstances} casting shadows`;
      selection.textContent = describeSelection(world);
      fpsFrames = 0;
      fpsSince = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  Object.assign(window, { sea: { sea, camera, controls, terrain, sizer, survey, world, CommanderAI } });
}

/**
 * Orders by touch or mouse. A tap on one of the player's mechs selects it alone; a long press (or a shift-click) adds it
 * to the selection or takes it out. A tap on another unit shows what it is. A tap on the ground sends the selection
 * there. Drags and two-finger gestures belong to the camera and are never taps.
 */
function mountOrders(canvas: HTMLCanvasElement, camera: Camera, world: World) {
  const LONG_PRESS_MS = 450;
  const SLOP_PX = 8;
  const pointers = new Set<number>();
  let press: { x: number; y: number; t: number; timer: number; handled: boolean; cancelled: boolean } | null = null;
  const pickAt = (x: number, y: number) => {
    const rect = canvas.getBoundingClientRect();
    return world.pick(camera, ((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1, rect.height);
  };
  const cancel = () => {
    if (press) {
      window.clearTimeout(press.timer);
      press.cancelled = true;
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    // Only the primary button (or a finger) gives orders; the right button turns the camera.
    if (pointers.size > 1 || e.button !== 0) return cancel();
    const p = { x: e.clientX, y: e.clientY, t: performance.now(), timer: 0, handled: false, cancelled: false };
    p.timer = window.setTimeout(() => {
      if (p.cancelled) return;
      const hit = pickAt(p.x, p.y);
      if (hit && !Array.isArray(hit)) {
        world.tapUnit(hit, true);
        p.handled = true;
      }
    }, LONG_PRESS_MS);
    press = p;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) cancel();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    const p = press;
    if (!p || e.type === 'pointercancel') return cancel();
    window.clearTimeout(p.timer);
    press = null;
    if (p.cancelled || p.handled || Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) return;
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) return;
    if (Array.isArray(hit)) {
      // With Airlift pressed, the tap is where the Karnov drops the selected infantry; with Build FOB, where the
      // selected truck builds a forward base.
      if (airlift.getAttribute('aria-pressed') === 'true') {
        world.orderAirlift(hit[0], hit[1]);
        airlift.setAttribute('aria-pressed', 'false');
      } else if (build.getAttribute('aria-pressed') === 'true') {
        const why = world.orderBuildFob(hit[0], hit[1]);
        if (why) logEvent(`Can't build a forward base there: ${why}`, PLAYER_TEAM);
        build.setAttribute('aria-pressed', 'false');
      } else world.orderMove(hit[0], hit[1]);
    } else world.tapUnit(hit, e.shiftKey);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const run = document.getElementById('cmd-run') as HTMLButtonElement;
  const airlift = document.getElementById('cmd-airlift') as HTMLButtonElement;
  const build = document.getElementById('cmd-build') as HTMLButtonElement;
  // Each is a mode for the next tap on the ground; pressing one lets go of the other.
  for (const [button, other] of [[airlift, build], [build, airlift]] as const) {
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      other.setAttribute('aria-pressed', 'false');
    });
  }
  // Airlift is offered while the selection has something the Karnov can carry; Build FOB while it has a supply truck.
  const offer = (button: HTMLButtonElement, on: boolean) => {
    if (button.hidden === on) button.hidden = !on;
    if (!on) button.setAttribute('aria-pressed', 'false');
  };
  window.setInterval(() => {
    const squads = [...world.selectedSquads];
    offer(airlift, !!world.match?.airlift.available && squads.some((q) => q.airliftable && !q.airborne));
    offer(build, !!world.match?.logistics && squads.some((q) => q.isLogistics && !q.airborne));
  }, 250);
  document.getElementById('cmd-all')!.addEventListener('click', () => world.selectAll());
  document.getElementById('cmd-stop')!.addEventListener('click', () => world.stopSelected());
  run.addEventListener('click', () => {
    const on = run.getAttribute('aria-pressed') !== 'true';
    run.setAttribute('aria-pressed', String(on));
    world.setRunning(on);
  });
}

function describeSelection(world: World): string {
  const u = world.inspected;
  if (u) {
    const who = `${u.team === PLAYER_TEAM ? '' : 'Enemy '}${u.name} (${u.squad ? `squad ${u.squad.name}, ` : ''}${u.kind})`;
    if (!u.alive) return `${who}: destroyed, ${u.combat?.dead ?? ''}`;
    const fob = world.match?.logistics?.fobs.find((f) => f.hq === u);
    if (fob) return `${u.team === PLAYER_TEAM ? '' : 'Enemy '}forward base · ${percent(u)} · supply ${Math.floor(fob.supply)}`;
    const attackers = [...world.selected].filter((s) => s.attackOrder === u).length;
    return `${who} · ${percent(u)}${attackers ? ` · ${attackers} of yours attacking` : ''}`;
  }
  if (world.match) {
    const squads = [...world.selectedSquads];
    if (!squads.length) return 'Tap a squad (or its card below) to select it';
    const hint = 'tap the ground to move, an enemy to attack';
    if (squads.length > 1) return `Squads ${squads.map((q) => q.name).join(', ')} · ${hint}`;
    const q = squads[0]!;
    const alive = q.alive;
    const members = alive.length === 1 ? describeUnit(world, alive[0]!) : alive.map((m) => `${m.name} ${percent(m)}`).join(', ');
    return `${q.name} (${q.spec.role}): ${members || 'none left'} · ${q.status(world.match.time)} · ${hint}`;
  }
  const units = [...world.selected];
  if (!units.length) return 'Tap one of your mechs to select it, or Select all';
  const hint = `tap the ground to move ${units.length > 1 ? 'them' : 'it'}, an enemy to attack`;
  if (units.length === 1) return `${describeUnit(world, units[0]!)} · ${hint}`;
  return `${units.map((u) => `${u.name} ${percent(u)}`).join(', ')} · ${hint}`;
}

/** Name, armour left, working weapons, ammunition, and what it's shooting at. */
function describeUnit(world: World, u: SeaUnit): string {
  const c = u.combat;
  if (!c) return u.name;
  const parts = [`${u.name} ${percent(u)}`];
  if (c.weapons.length) parts.push(`${c.weapons.filter((w) => !w.destroyed).length}/${c.weapons.length} weapons`);
  if (u.supply !== null) parts.push(`supply ${Math.floor(u.supply)}`);
  const ammo = [...c.ammo].map(([id, rounds]) => `${world.ammoName(id)} ${Math.floor(rounds)}`).join(', ');
  if (ammo) parts.push(ammo);
  if (u.target) parts.push(`${u.attackOrder ? 'attacking' : 'firing at'} ${u.target.name}, ${Math.round(Math.hypot(u.target.x - u.x, u.target.z - u.z))} m`);
  return parts.join(' · ');
}

function percent(u: SeaUnit): string {
  return u.combat ? `${Math.round(u.combat.integrity * 100)}%` : '';
}

/** A line in the battle log, which fades after a while (the newest at the bottom, a few at most). */
function logEvent(text: string, team: number) {
  const log = document.getElementById('log')!;
  const line = document.createElement('div');
  line.textContent = text;
  line.className = team === PLAYER_TEAM ? 'own' : 'enemy';
  log.append(line);
  while (log.children.length > 5) log.firstElementChild!.remove();
  window.setTimeout(() => line.remove(), 9000);
}

/** A survey the panel can run: its button, the report's kind, and what it measures (fields added to the report). */
interface SurveyKind {
  button: string;
  kind: string;
  intro: string;
  run(log: (line: string) => void): Promise<Record<string, unknown>>;
  start?(): void;
  done?(): void;
}

/** The panel's buttons run a survey each and POST the report to the dev server (see vite.config.ts). */
function mountSurveyPanel(context: () => Record<string, unknown>, kinds: SurveyKind[]) {
  const panel = document.getElementById('perf')!;
  const labelInput = document.getElementById('perf-label') as HTMLInputElement;
  const buttons = kinds.map((k) => document.getElementById(k.button) as HTMLButtonElement);
  const log = document.getElementById('perf-status')!;
  // Reports go to the dev server (vite.config.ts); a published build has none, so there the panel waits for ?perf.
  if (!import.meta.env.DEV && !new URLSearchParams(location.search).has('perf')) return;
  try {
    labelInput.value = localStorage.getItem('perf-label') ?? '';
  } catch {
    // Storage can be unavailable (private browsing); the label just isn't remembered.
  }
  panel.hidden = false;
  kinds.forEach((k, i) => buttons[i]!.addEventListener('click', async () => {
    const label = labelInput.value.trim();
    try {
      localStorage.setItem('perf-label', label);
    } catch {
      // See above.
    }
    for (const b of buttons) b.disabled = true;
    document.body.classList.add('perf-running');
    log.textContent = k.intro + '\n';
    k.start?.();
    try {
      const result = await k.run((line) => (log.textContent += line + '\n'));
      const report = { label, createdAt: new Date().toISOString(), kind: k.kind, ...context(), ...result };
      const res = await fetch(`${import.meta.env.BASE_URL}api/perf`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      log.textContent += res.ok ? `Sent. Saved on the server as ${((await res.json()) as { file: string }).file}` : `Couldn't send the report: HTTP ${res.status}`;
    } catch (err) {
      log.textContent += `Survey failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      for (const b of buttons) b.disabled = false;
      document.body.classList.remove('perf-running');
      k.done?.();
    }
  }));
}

main().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err instanceof Error ? err.message : err}`);
});
