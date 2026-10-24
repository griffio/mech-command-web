// Mission units: animated mechs (with simple waypoint walking) and static vehicles.
import { AnimationMixer, Box3, Group, LoopRepeat, Vector3, type AnimationAction, type AnimationClip } from 'three';
import { worldToThree, type MechInfo, type UnitsFile } from './assets.ts';
import { loadModel, paintedClone, type PaintScheme } from './models.ts';
import type { Terrain } from './terrain.ts';

const TURN_RATE = 120; // degrees per second
const ARRIVE_DISTANCE = 24; // world units

export class Unit {
  /** Placed on the terrain; rotation.y is the MC2 facing (0 = facing south). */
  readonly root = new Group();
  readonly mixer: AnimationMixer | null;
  readonly clips: Map<string, AnimationClip>;
  /** Radius of the footprint, for the selection ring. */
  readonly radius: number;
  clipName = '';
  /** Patrol route in MC2 world coordinates; empty when standing still. */
  route: [number, number][] = [];
  loopRoute = false;
  running = false;
  private routeIndex = 0;
  private action: AnimationAction | null = null;

  constructor(
    readonly name: string,
    readonly kind: 'mech' | 'vehicle',
    model: Group,
    clips: AnimationClip[],
    readonly info: MechInfo | null,
    private readonly worldUnitsPerMeter: number,
    public x: number,
    public y: number,
    /** Degrees, MC2 convention: facing = (sin r, -cos r) in world x/y. */
    public rotation: number,
  ) {
    this.root.add(model);
    this.root.userData.unit = this;
    this.clips = new Map(clips.map((c) => [c.name, c]));
    this.mixer = clips.length ? new AnimationMixer(model) : null;
    const size = new Box3().setFromObject(model).getSize(new Vector3());
    this.radius = Math.max(size.x, size.z) * 0.6;
  }

  play(name: string, fade = 0.2) {
    const clip = this.clips.get(name);
    if (!clip || !this.mixer || name === this.clipName) return;
    const next = this.mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
    if (this.action) next.crossFadeFrom(this.action, fade, false);
    this.action = next;
    this.clipName = name;
  }

  /** Walks (or runs) through the points; loops back to the first when `loop`. */
  walkTo(points: [number, number][], loop = false) {
    this.route = points;
    this.routeIndex = 0;
    this.loopRoute = loop;
  }

  stop() {
    this.route = [];
    if (this.clips.has('idle')) this.play('idle');
  }

  /** Movement speed from the gesture data (metres/second) in world units. */
  get speed(): number {
    const clip = this.info?.clips[this.running ? 'run' : 'walk'];
    return (clip?.startVelocity ?? 10) * this.worldUnitsPerMeter;
  }

  update(dt: number, terrain: Terrain) {
    if (this.route.length && this.kind === 'mech') this.steer(dt);
    worldToThree(this.x, this.y, terrain.heightAt(this.x, this.y), this.root.position);
    this.root.rotation.y = (this.rotation * Math.PI) / 180;
    this.mixer?.update(dt);
  }

  private steer(dt: number) {
    const [tx, ty] = this.route[this.routeIndex];
    const dx = tx - this.x;
    const dy = ty - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance < ARRIVE_DISTANCE) {
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
    const desired = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const diff = ((desired - this.rotation + 540) % 360) - 180;
    const turn = Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
    this.rotation = (this.rotation + turn + 360) % 360;
    this.play(this.running ? 'run' : 'walk');
    // Turn in place first when the target is well off to the side.
    if (Math.abs(diff) < 30) {
      const step = Math.min(distance, this.speed * dt);
      const r = (this.rotation * Math.PI) / 180;
      this.x += Math.sin(r) * step;
      this.y -= Math.cos(r) * step;
    }
  }
}

export interface UnitSpec {
  model: string;
  kind: 'mech' | 'vehicle';
  name: string;
  x: number;
  y: number;
  rotation: number;
  paint: PaintScheme;
}

export async function createUnit(spec: UnitSpec, units: UnitsFile, worldUnitsPerMeter: number): Promise<Unit> {
  const info = spec.kind === 'mech' ? units.mechs[spec.model] : null;
  const gltf = await loadModel(info ? info.model : `models/props/${spec.model}.glb`);
  const model = paintedClone(gltf.scene, spec.paint) as Group;
  model.traverse((o) => (o.castShadow = o.receiveShadow = true));
  const unit = new Unit(spec.name, spec.kind, model, gltf.animations, info, worldUnitsPerMeter, spec.x, spec.y, spec.rotation);
  if (unit.clips.has('idle')) unit.play('idle', 0);
  // Desynchronise idle loops so a lance does not breathe in unison.
  unit.mixer?.update(Math.random() * 3);
  return unit;
}
