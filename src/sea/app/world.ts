// MC2's buildings, trees and units on the WebGPU sea page: the same placements as the three.js viewer (src/props.ts,
// src/units.ts), in metres (MC2 units / 5.01) and the dreadnought game's axes (x east, y up, z south).
import { ASSET_ROOT, loadJson, type MapInfo, type MechInfo, type ObjectsFile, type UnitsFile } from '../../assets.ts';
import { PLAYER_PAINT, paintFromMission, type PaintScheme } from '../../paint.ts';
import type { Camera } from '../render/camera';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { SeaRenderer } from '../render/sea-renderer';
import { parseGlb, type ModelData } from '../models/glb';
import { AFFINE_FLOATS, Animator, mulAffine, placement, restPose } from '../models/pose';
import type { Terrain } from '../sim/terrain/terrain';

const TURN_RATE = 120; // degrees per second
const ARRIVE_M = 5;
/** The land's colour map is shown at this brightness (map-ground DEFAULT_MAP_LOOK); models match it. */
const GAIN = 1.35;

export class SeaUnit {
  /** Patrol or destination, world x and z (metres); empty when standing. */
  route: [number, number][] = [];
  loopRoute = false;
  running = false;
  private routeIndex = 0;
  private readonly frame = new Float32Array(AFFINE_FLOATS);

  constructor(
    readonly name: string,
    readonly kind: 'mech' | 'vehicle',
    readonly instance: ModelInstance,
    private readonly animator: Animator | null,
    private readonly rest: Float32Array,
    readonly info: MechInfo | null,
    private readonly scale: number,
    public x: number,
    public z: number,
    /** MC2 rotation, degrees: the unit faces (sin r, cos r) in x, z (0 faces south). */
    public rotation: number,
  ) {}

  get clipName(): string {
    return this.animator?.clipName ?? '';
  }

  get clips(): string[] {
    return this.animator?.clips ?? [];
  }

  /** Footprint radius, metres (for the selection ring and picking). */
  get radius(): number {
    return this.instance.model.radius * 0.55;
  }

  play(name: string, fade = 0.2): void {
    this.animator?.play(name, fade);
  }

  walkTo(points: [number, number][], loop = false): void {
    this.route = points;
    this.routeIndex = 0;
    this.loopRoute = loop;
  }

  stop(): void {
    this.route = [];
    this.play('idle');
  }

  /** Speed from the gesture data: MC2 gives it in metres a second already. */
  get speed(): number {
    return this.info?.clips[this.running ? 'run' : 'walk']?.startVelocity ?? 10;
  }

  update(dt: number, terrain: Terrain): void {
    if (this.route.length && this.kind === 'mech') this.steer(dt);
    this.animator?.update(dt);
    const y = terrain.heightAt(this.x, this.z);
    placement(this.frame, this.x, y, this.z, (this.rotation * Math.PI) / 180, this.scale);
    const nodes = this.animator?.matrices ?? this.rest;
    const out = this.instance.matrices;
    for (let k = 0; k < this.instance.model.nodeCount; k++) mulAffine(out, k * AFFINE_FLOATS, this.frame, 0, nodes, k * AFFINE_FLOATS);
    this.instance.center[0] = this.x;
    this.instance.center[1] = y + this.instance.model.radius * 0.5;
    this.instance.center[2] = this.z;
  }

  private steer(dt: number): void {
    const [tx, tz] = this.route[this.routeIndex]!;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const distance = Math.hypot(dx, dz);
    if (distance < ARRIVE_M) {
      this.routeIndex++;
      if (this.routeIndex >= this.route.length) {
        if (!this.loopRoute) {
          this.stop();
          return;
        }
        this.routeIndex = 0;
      }
      return;
    }
    const desired = (Math.atan2(dx, dz) * 180) / Math.PI;
    const diff = ((desired - this.rotation + 540) % 360) - 180;
    this.rotation = (this.rotation + Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt) + 360) % 360;
    this.play(this.running ? 'run' : 'walk');
    // Turn in place first when the target is well off to the side.
    if (Math.abs(diff) < 30) {
      const step = Math.min(distance, this.speed * dt);
      const r = (this.rotation * Math.PI) / 180;
      this.x += Math.sin(r) * step;
      this.z += Math.cos(r) * step;
    }
  }
}

export class World {
  readonly units: SeaUnit[] = [];
  readonly showcase: SeaUnit[] = [];
  selected: SeaUnit | null = null;
  propCount = 0;
  private ring: ModelInstance | null = null;
  private readonly glbs = new Map<string, Promise<ModelData>>();
  private readonly ringFrame = new Float32Array(AFFINE_FLOATS);

  private constructor(
    private readonly sea: SeaRenderer,
    private readonly terrain: Terrain,
    private readonly info: MapInfo,
    private readonly unitsFile: UnitsFile,
  ) {}

  private get scale(): number {
    return 1 / this.info.worldUnitsPerMeter;
  }

  static async load(sea: SeaRenderer, terrain: Terrain, info: MapInfo, mapDir: string, progress: (text: string) => void): Promise<World> {
    const [objects, unitsFile] = await Promise.all([loadJson<ObjectsFile>(mapDir + 'objects.json'), loadJson<UnitsFile>(mapDir + 'units.json')]);
    const world = new World(sea, terrain, info, unitsFile);
    progress('Loading buildings and trees…');
    await world.placeProps(objects);
    progress('Loading units…');
    await Promise.all(
      unitsFile.units.map(async (u) => {
        const unit = await world.spawn(u.model, u.kind, u.name, u.x * world.scale, -u.y * world.scale, u.rotation, u.player ? PLAYER_PAINT : paintFromMission(u.colors));
        world.units.push(unit);
      }),
    );
    // The showcase mechs patrol a loop of dry land beside the opening view, as in the three.js viewer.
    const loop = landLoop(terrain, info.camera.x * world.scale - 50, -info.camera.y * world.scale - 30, 84);
    const half = Math.floor(loop.length / 2);
    for (const [i, key] of unitsFile.showcase.entries()) {
      const [x, z] = loop[(i * half) % loop.length]!;
      const paint = i % 2 ? PLAYER_PAINT : paintFromMission(['#3a5f8f', '#c8c8c8', '#202830']);
      const unit = await world.spawn(key, 'mech', key, x, z, 0, paint);
      unit.walkTo(rotate(loop, i * half), true);
      world.units.push(unit);
      world.showcase.push(unit);
    }
    world.ring = world.sea.models.addInstance(await world.sea.models.addModel(ringModel(), { scale: 1, unlit: true, gain: 1.4 }));
    world.select(world.showcase[0] ?? world.units[0] ?? null);
    return world;
  }

  /** Put a mech or vehicle on the map (world metres). */
  async spawn(key: string, kind: 'mech' | 'vehicle', name: string, x: number, z: number, rotation: number, paint: PaintScheme): Promise<SeaUnit> {
    const info = kind === 'mech' ? (this.unitsFile.mechs[key] ?? null) : null;
    const data = await this.glb(info ? info.model : `models/props/${key}.glb`);
    const model = await this.sea.models.addModel(data, { scale: this.scale, paint, gain: GAIN });
    const animator = data.clips.size ? new Animator(data) : null;
    const unit = new SeaUnit(name, kind, this.sea.models.addInstance(model), animator, restPose(data), info, this.scale, x, z, rotation);
    if (animator) {
      animator.play('idle', 0, Math.random() * 3); // out of step, so a lance does not breathe in unison
    }
    unit.update(0, this.terrain);
    return unit;
  }

  remove(unit: SeaUnit): void {
    this.units.splice(this.units.indexOf(unit), 1);
    this.sea.models.removeInstance(unit.instance);
    if (this.selected === unit) this.select(this.showcase[0] ?? null);
  }

  select(unit: SeaUnit | null): void {
    this.selected = unit;
  }

  update(dt: number): void {
    for (const u of this.units) u.update(dt, this.terrain);
    const ring = this.ring;
    if (!ring) return;
    const sel = this.selected;
    ring.visible = sel !== null;
    if (sel) {
      placement(this.ringFrame, sel.x, this.terrain.heightAt(sel.x, sel.z) + 0.4, sel.z, 0, sel.radius);
      ring.matrices.set(this.ringFrame);
      ring.center[0] = sel.x;
      ring.center[1] = this.terrain.heightAt(sel.x, sel.z);
      ring.center[2] = sel.z;
      ring.radius = sel.radius;
    }
  }

  /** What a tap at normalised device coordinates hits: a unit, or the ground (world x, z), or nothing. */
  pick(camera: Camera, ndcX: number, ndcY: number): SeaUnit | [number, number] | null {
    const o = camera.position;
    const d = camera.rayThrough(ndcX, ndcY);
    let best: SeaUnit | null = null;
    let bestT = Infinity;
    for (const u of this.units) {
      const c = u.instance.center;
      const t = (c[0] - o[0]) * d[0] + (c[1] - o[1]) * d[1] + (c[2] - o[2]) * d[2];
      if (t <= 0 || t >= bestT) continue;
      const miss = Math.hypot(o[0] + d[0] * t - c[0], o[1] + d[1] * t - c[1], o[2] + d[2] * t - c[2]);
      if (miss < u.instance.model.radius * 0.6) {
        best = u;
        bestT = t;
      }
    }
    if (best) return best;
    // March to the ground (the sea counts: mechs wade), then halve the last step a few times.
    const above = (t: number) => o[1] + d[1] * t - Math.max(this.terrain.heightAt(o[0] + d[0] * t, o[2] + d[2] * t), 0);
    let prev = 0;
    for (let t = 2; t < 8000; t += Math.max(2, t * 0.01)) {
      if (above(t) <= 0) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        return [o[0] + d[0] * hi, o[2] + d[2] * hi];
      }
      prev = t;
    }
    return null;
  }

  private async placeProps(objects: ObjectsFile): Promise<void> {
    const byModel = new Map<number, ObjectsFile['instances']>();
    for (const inst of objects.instances) byModel.set(inst[0], [...(byModel.get(inst[0]) ?? []), inst]);
    const frame = new Float32Array(AFFINE_FLOATS);
    await Promise.all(
      [...byModel].map(async ([mi, list]) => {
        const data = await this.glb(objects.models[mi]!);
        const model: GpuModel = await this.sea.models.addModel(data, { scale: this.scale, gain: GAIN });
        const rest = restPose(data);
        for (const [, ux, uy, , rot] of list) {
          const x = ux * this.scale;
          const z = -uy * this.scale;
          const y = this.terrain.heightAt(x, z);
          const inst = this.sea.models.addInstance(model);
          placement(frame, x, y, z, (rot * Math.PI) / 180, this.scale);
          for (let k = 0; k < model.nodeCount; k++) mulAffine(inst.matrices, k * AFFINE_FLOATS, frame, 0, rest, k * AFFINE_FLOATS);
          inst.center[0] = x;
          inst.center[1] = y;
          inst.center[2] = z;
          this.propCount++;
        }
      }),
    );
  }

  private glb(path: string): Promise<ModelData> {
    let entry = this.glbs.get(path);
    if (!entry) {
      entry = fetch(ASSET_ROOT + path).then(async (res) => {
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return parseGlb(await res.arrayBuffer(), path.split('/').pop()!.replace('.glb', ''));
      });
      this.glbs.set(path, entry);
    }
    return entry;
  }
}

/** A flat ring of radius 0.85..1 on the ground, for marking the selected unit (scaled to its footprint). */
function ringModel(): ModelData {
  const segments = 48;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85, Math.cos(a), 0, Math.sin(a));
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const count = positions.length / 3;
  return {
    name: 'selection-ring',
    nodes: [{ name: 'ring', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    materials: [{ name: 'ring', image: null, color: [0.35, 1, 0.3, 1], alphaCutoff: null, doubleSided: true }],
    primitives: [
      {
        node: 0,
        material: 0,
        positions: new Float32Array(positions),
        normals: new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
        uvs: new Float32Array(count * 2),
        indices: new Uint32Array(indices),
      },
    ],
    clips: new Map(),
  };
}

/** Points on a circle that are above water, in order, for a patrol loop (world metres). */
function landLoop(terrain: Terrain, cx: number, cz: number, radius: number): [number, number][] {
  for (let r = radius; r > 12; r *= 0.75) {
    const points: [number, number][] = [];
    for (let a = 0; a < 360; a += 30) {
      const x = cx + Math.cos((a * Math.PI) / 180) * r;
      const z = cz + Math.sin((a * Math.PI) / 180) * r;
      if (terrain.heightAt(x, z) > 0.5) points.push([x, z]);
    }
    if (points.length >= 6) return points;
  }
  return [
    [cx, cz],
    [cx + 20, cz],
  ];
}

function rotate<T>(list: T[], by: number): T[] {
  return list.slice(by).concat(list.slice(0, by));
}
