import './style.css';
import GUI, { type Controller } from 'lil-gui';
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Timer,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import {
  ASSET_ROOT,
  loadBinary,
  loadJson,
  worldToThree,
  type MapInfo,
  type ObjectsFile,
  type UnitsFile,
} from './assets.ts';
import { PLAYER_PAINT, paintFromMission } from './models.ts';
import { FrameRecorder, mountPerfPanel, type Scenario } from './perf.ts';
import { createProps } from './props.ts';
import { Terrain } from './terrain.ts';
import { createUnit, type Unit } from './units.ts';

const status = document.getElementById('status')!;
const fallbackReason = new URLSearchParams(location.search).get('fallback');
if (fallbackReason) {
  document.getElementById('fallback')!.textContent =
    fallbackReason === 'insecure-context'
      ? 'WebGPU needs HTTPS: this is the WebGL viewer. For the full game run npm run dev:https and open the https:// address.'
      : 'This browser has no WebGPU, so this is the WebGL viewer (the full game needs Safari 26, or a recent Chrome or Edge).';
}
const stats = document.getElementById('stats')!;
const setStatus = (text: string) => (status.textContent = text);

/** Milestones (ms since navigation) for the perf report. */
const load: Record<string, number> = {};
const mark = (name: string) => (load[name] = Math.round(performance.now()));

async function main() {
  const manifest = await loadJson<{ maps: string[] }>('manifest.json').catch(() => null);
  if (!manifest) {
    setStatus('No converted assets found. Run: npm run fetch-data && npm run convert');
    return;
  }
  const mapName = new URLSearchParams(location.search).get('map') ?? manifest.maps[0];
  const dir = `maps/${mapName}/`;

  setStatus(`Loading ${mapName}…`);
  const [info, objects, unitsFile] = await Promise.all([
    loadJson<MapInfo>(dir + 'map.json'),
    loadJson<ObjectsFile>(dir + 'objects.json'),
    loadJson<UnitsFile>(dir + 'units.json'),
  ]);
  const elevation = new Float32Array(await loadBinary(dir + info.elevation.file));
  mark('mapData');

  // --- Renderer, scene, camera --------------------------------------------------
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const sky = new Color(0xb8c6cc);
  const scene = new Scene();
  scene.background = sky;
  scene.fog = new Fog(sky, 9000, 18000);

  const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 10, 30000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 120;
  controls.maxDistance = 9000;
  controls.maxPolarAngle = (80 * Math.PI) / 180;

  // MC2 lights objects with ambient + sun * N.L. three.js Lambert divides by
  // pi, so intensities are scaled by pi to land on the same values.
  const sunDir = worldToThree(...info.light.sun);
  const sun = new DirectionalLight(new Color(...info.light.color), Math.PI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target, new AmbientLight(new Color(...info.light.ambient), Math.PI));
  const shadows = new ShadowFollower(sun, sunDir);

  // --- Terrain -----------------------------------------------------------------
  const textureLoader = new TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const loadTexture = async (file: string | undefined, srgb = true): Promise<Texture | null> => {
    if (!file) return null;
    const t = await textureLoader.loadAsync(ASSET_ROOT + dir + file);
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.anisotropy = maxAniso;
    return t;
  };
  const [colormap, detail, water] = await Promise.all([
    loadTexture(info.colormap.file),
    loadTexture(info.detail?.file, false),
    loadTexture(info.water.texture?.file),
  ]);
  const terrain = new Terrain(info, elevation, { colormap: colormap!, detail, water });
  scene.add(terrain.mesh, terrain.shadowLayer);
  if (terrain.water) scene.add(terrain.water);
  mark('terrain');

  const start = worldToThree(info.camera.x, info.camera.y, terrain.heightAt(info.camera.x, info.camera.y));
  const resetCamera = () => {
    controls.target.copy(start);
    camera.position.copy(start).add(new Vector3(0, 900, 1100));
    controls.update();
  };
  resetCamera();

  // --- Props and units -------------------------------------------------------------
  setStatus('Loading buildings and trees…');
  const props = await createProps(objects, (x, y) => terrain.heightAt(x, y));
  scene.add(props);
  mark('props');

  setStatus('Loading units…');
  const units: Unit[] = [];
  const addUnit = (unit: Unit) => {
    units.push(unit);
    scene.add(unit.root);
    unit.update(0, terrain);
    return unit;
  };
  const removeUnit = (unit: Unit) => {
    units.splice(units.indexOf(unit), 1);
    scene.remove(unit.root);
    unit.mixer?.stopAllAction();
  };
  await Promise.all(
    unitsFile.units.map(async (u) =>
      addUnit(
        await createUnit(
          { ...u, paint: u.player ? PLAYER_PAINT : paintFromMission(u.colors) },
          unitsFile,
          info.worldUnitsPerMeter,
        ),
      ),
    ),
  );

  // Showcase mechs next to the starting camera, on a patrol loop over dry land.
  const patrol = landLoop(terrain, info.camera.x - 250, info.camera.y + 150, 420);
  const showcase: Unit[] = [];
  for (const [i, key] of unitsFile.showcase.entries()) {
    const [x, y] = patrol[(i * Math.floor(patrol.length / 2)) % patrol.length] ?? [info.camera.x, info.camera.y];
    const unit = addUnit(
      await createUnit(
        { model: key, kind: 'mech', name: key, x, y, rotation: 0, paint: i % 2 ? PLAYER_PAINT : paintFromMission(['#3a5f8f', '#c8c8c8', '#202830']) },
        unitsFile,
        info.worldUnitsPerMeter,
      ),
    );
    unit.walkTo(rotate(patrol, i * Math.floor(patrol.length / 2)), true);
    showcase.push(unit);
  }
  mark('units');

  // --- Selection ------------------------------------------------------------------
  const ring = new Mesh(
    new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ color: 0x7dff6a, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  ring.renderOrder = 2;
  scene.add(ring);

  const state = {
    unit: '',
    animation: '',
    run: false,
    follow: false,
    patrol: () => selected && selected.walkTo(rotate(patrol, 0), true),
    stop: () => selected?.stop(),
    props: true,
    units: true,
    water: true,
    shadows: true,
    shadowStrength: terrain.shadowLayer.material.opacity,
    detail: terrain.detailStrength.value,
    spawn: unitsFile.showcase[0] ?? Object.keys(unitsFile.mechs)[0],
    spawnHere: async () => {
      const t = controls.target;
      const unit = addUnit(
        await createUnit(
          { model: state.spawn, kind: 'mech', name: state.spawn, x: t.x, y: -t.z, rotation: 0, paint: PLAYER_PAINT },
          unitsFile,
          info.worldUnitsPerMeter,
        ),
      );
      select(unit);
    },
    resetCamera,
  };

  const gui = new GUI({ title: `MC2 viewer · ${mapName}` });
  if (window.innerWidth < 720) gui.close();
  const selFolder = gui.addFolder('Selected unit');
  selFolder.add(state, 'unit').name('unit').disable().listen();
  let animationCtl: Controller = selFolder.add(state, 'animation', []);
  selFolder.add(state, 'run').name('run instead of walk').onChange((v: boolean) => selected && (selected.running = v));
  selFolder.add(state, 'patrol').name('patrol loop');
  selFolder.add(state, 'stop');
  selFolder.add(state, 'follow').name('camera follows');
  const spawnFolder = gui.addFolder('Spawn');
  spawnFolder.add(state, 'spawn', Object.keys(unitsFile.mechs)).name('mech');
  spawnFolder.add(state, 'spawnHere').name('spawn at view centre');
  const viewFolder = gui.addFolder('View');
  viewFolder.add(state, 'props').name('buildings & trees').onChange((v: boolean) => (props.visible = v));
  viewFolder.add(state, 'units').onChange((v: boolean) => units.forEach((u) => (u.root.visible = v)));
  viewFolder.add(state, 'water').onChange((v: boolean) => terrain.water && (terrain.water.visible = v));
  viewFolder.add(state, 'shadows').onChange((v: boolean) => {
    sun.castShadow = v;
    terrain.shadowLayer.visible = v;
  });
  viewFolder
    .add(state, 'shadowStrength', 0, 1, 0.05)
    .name('shadow strength')
    .onChange((v: number) => (terrain.shadowLayer.material.opacity = v));
  viewFolder.add(state, 'detail', 0, 1, 0.05).name('ground detail').onChange((v: number) => (terrain.detailStrength.value = v));
  viewFolder.add(state, 'resetCamera').name('reset camera');

  let selected: Unit | null = null;
  function select(unit: Unit) {
    selected = unit;
    state.unit = `${unit.name} (${unit.kind})`;
    state.run = unit.running;
    ring.scale.setScalar(unit.radius);
    const names = [...unit.clips.keys()];
    state.animation = unit.clipName;
    animationCtl.destroy();
    animationCtl = selFolder
      .add(state, 'animation', names.length ? names : ['(static)'])
      .name('animation')
      .listen()
      .onChange((name: string) => {
        unit.route = []; // stop walking so the clip plays in place
        unit.play(name);
      });
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
  if (showcase[0]) select(showcase[0]);

  // Tap a unit to select it; tap the ground to send the selected mech there.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let down: { x: number; y: number; t: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 400) return;
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(units.filter((u) => u.root.visible).map((u) => u.root), true)[0];
    if (hit) {
      let o: typeof hit.object | null = hit.object;
      while (o && !o.userData.unit) o = o.parent;
      if (o) return select(o.userData.unit as Unit);
    }
    const ground = raycaster.intersectObject(terrain.mesh)[0];
    if (ground && selected?.kind === 'mech') selected.walkTo([[ground.point.x, -ground.point.z]]);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- Loop -----------------------------------------------------------------------
  // Compile every shader up front (in parallel where the browser allows) so the
  // first seconds of the map don't stutter.
  setStatus('Preparing shaders…');
  await renderer.compileAsync(scene, camera);
  mark('shaders');
  setStatus('');
  const timer = new Timer();
  const followDelta = new Vector3();
  const recorder = new FrameRecorder();
  let frames = 0;
  let statsTime = 0;
  const frame = (time: number) => {
    const frameStart = performance.now();
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    for (const u of units) u.update(dt, terrain);
    terrain.update(dt);
    if (selected) {
      ring.position.copy(selected.root.position).y += 2;
      ring.visible = selected.root.visible;
      state.animation = selected.clipName;
      if (state.follow) {
        followDelta.copy(selected.root.position).sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
        controls.target.add(followDelta);
        camera.position.add(followDelta);
      }
    }
    controls.update();
    shadows.update(controls.target, camera.position.distanceTo(controls.target));
    renderer.render(scene, camera);
    recorder.record(time, performance.now() - frameStart);

    frames++;
    statsTime += dt;
    if (statsTime > 0.5) {
      const r = renderer.info.render;
      stats.textContent = `${Math.round(frames / statsTime)} fps · ${r.calls} draws · ${(r.triangles / 1000).toFixed(0)}k tris`;
      frames = 0;
      statsTime = 0;
    }
  };
  renderer.setAnimationLoop(frame);
  Object.assign(window, { viewer: { scene, camera, controls, terrain, units, renderer } });

  // --- Perf test --------------------------------------------------------------------
  const setShadows = (on: boolean) => {
    state.shadows = on;
    sun.castShadow = on;
    terrain.shadowLayer.visible = on;
  };
  const look = (x: number, y: number, offset: Vector3) => {
    worldToThree(x, y, terrain.heightAt(x, y), controls.target);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  };
  const crowd: Unit[] = [];
  const scenarios: Scenario[] = [
    {
      name: 'start',
      description: 'Opening view',
      setup: () => {
        setShadows(true);
        resetCamera();
      },
    },
    {
      name: 'start-no-shadows',
      description: 'Opening view without shadows',
      setup: () => setShadows(false),
      teardown: () => setShadows(true),
    },
    {
      name: 'start-pixel-ratio-1',
      description: 'Opening view at one render pixel per screen point',
      setup: () => renderer.setPixelRatio(1),
      teardown: () => renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)),
    },
    { name: 'airfield', description: 'Close over the airfield buildings', setup: () => look(3150, -250, new Vector3(-300, 700, 700)) },
    { name: 'overview', description: 'Zoomed out over the whole map', setup: () => look(0, 0, new Vector3(0, 6500, 5500)) },
    {
      name: 'mech-close',
      description: 'Following a walking Atlas up close',
      setup: () => {
        const unit = showcase[0] ?? units[0];
        select(unit);
        state.follow = true;
        const p = unit.root.position;
        controls.target.copy(p);
        camera.position.copy(p).add(new Vector3(120, 110, 170));
        controls.update();
      },
      teardown: () => void (state.follow = false),
    },
    {
      name: 'crowd-24',
      description: 'Opening view with 24 extra walking mechs',
      setup: async () => {
        resetCamera();
        const kinds = Object.keys(unitsFile.mechs);
        for (let i = 0; i < 24; i++) {
          const x = info.camera.x - 500 + (i % 6) * 160;
          const y = info.camera.y + 200 + Math.floor(i / 6) * 160;
          const unit = await createUnit(
            { model: kinds[i % kinds.length], kind: 'mech', name: kinds[i % kinds.length], x, y, rotation: i * 37, paint: PLAYER_PAINT },
            unitsFile,
            info.worldUnitsPerMeter,
          );
          unit.walkTo([[x + 120, y], [x + 120, y + 120], [x, y + 120], [x, y]], true);
          crowd.push(addUnit(unit));
        }
        await renderer.compileAsync(scene, camera);
      },
      teardown: () => {
        crowd.splice(0).forEach(removeUnit);
        resetCamera();
      },
    },
  ];
  mountPerfPanel({
    renderer,
    recorder,
    scenarios,
    pauseRendering: () => renderer.setAnimationLoop(null),
    resumeRendering: () => renderer.setAnimationLoop(frame),
    app: {
      map: mapName,
      colormap: `${info.colormap.width}x${info.colormap.height}`,
      objects: objects.instances.length,
      units: unitsFile.units.length + showcase.length,
      shadowMapSize: sun.shadow.mapSize.x,
      antialias: true,
    },
    load,
  });
}

/**
 * Keeps the sun's shadow map centred on what the camera looks at. The map is
 * 12,800 units across, far too large for one sharp shadow map, so the shadow box
 * covers the view centre and grows as the camera zooms out. The centre snaps
 * to whole shadow-map texels so shadow edges don't crawl while panning.
 */
class ShadowFollower {
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly center = new Vector3();
  private half = 0;

  constructor(
    private readonly sun: DirectionalLight,
    private readonly toSun: Vector3,
  ) {
    this.toSun.normalize();
    this.right.crossVectors(new Vector3(0, 1, 0), this.toSun).normalize();
    this.up.crossVectors(this.toSun, this.right).normalize();
  }

  update(target: Vector3, viewDistance: number) {
    // Grow in 25% steps rather than continuously, so zooming doesn't shimmer either.
    const half = 1.25 ** Math.ceil(Math.log(MathUtils.clamp(viewDistance * 1.2, 600, 5000)) / Math.log(1.25));
    const camera = this.sun.shadow.camera;
    if (half !== this.half) {
      this.half = half;
      camera.left = camera.bottom = -half;
      camera.right = camera.top = half;
      camera.near = 10;
      camera.far = 12000;
      camera.updateProjectionMatrix();
    }
    const texel = (2 * half) / this.sun.shadow.mapSize.x;
    const snap = (v: number) => Math.round(v / texel) * texel;
    this.center
      .copy(this.right)
      .multiplyScalar(snap(target.dot(this.right)))
      .addScaledVector(this.up, snap(target.dot(this.up)))
      .addScaledVector(this.toSun, target.dot(this.toSun));
    this.sun.target.position.copy(this.center);
    this.sun.position.copy(this.center).addScaledVector(this.toSun, 6000);
  }
}

/** Points on a circle that are above water, in order, for a patrol loop. */
function landLoop(terrain: Terrain, cx: number, cy: number, radius: number): [number, number][] {
  for (let r = radius; r > 60; r *= 0.75) {
    const points: [number, number][] = [];
    for (let a = 0; a < 360; a += 30) {
      const x = cx + Math.cos((a * Math.PI) / 180) * r;
      const y = cy + Math.sin((a * Math.PI) / 180) * r;
      if (!terrain.isUnderwater(x, y)) points.push([x, y]);
    }
    if (points.length >= 6) return points;
  }
  return [
    [cx, cy],
    [cx + 100, cy],
  ];
}

function rotate<T>(list: T[], by: number): T[] {
  return list.slice(by).concat(list.slice(0, by));
}

main().catch((err) => {
  console.error(err);
  setStatus(`Failed to load: ${err instanceof Error ? err.message : err}`);
});
