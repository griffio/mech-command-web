// Logistics, after Squad: supply trucks (MC2's repair truck, its 500 refit points carried as supply) build forward bases
// where the fight is and keep them supplied. A forward base is MC2's HQ tent behind sandbags, guarded by an autocannon
// turret, with a sensor tower behind it (sensors.ts). A side's wiped-out squads come back at the one nearest the front, squads there reinforce and refit (paid for in
// supply), and the Karnov flies from it. Destroy the tent and the base is gone. The main base works the same way, free.
//
// Trucks need no orders but where to go: one standing at the main base fills up, one standing at a forward base unloads
// into it, and one told to build drives to the spot and builds when it gets there (another order calls the build off).
// The player sees where their truck is going to build, how long it has left, and, while choosing a spot, where it can't.
import type { ScenarioLogistics, VehicleStats } from '../../assets';
import type { PaintScheme } from '../../paint.ts';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { Squad } from './squads';
import type { Match } from './match';
import { TOWER_STRUCTURE } from './sensors';
import { bearing, PLAYER_TEAM, type SeaUnit, type World } from './world';

/** Squads within this of a forward base reinforce and refit there, metres. */
export const FOB_RADIUS = 60;
/** A forward base must be this far from its side's base and other forward bases, and from the enemy's base. */
const FOB_SPACING = 300;
const ENEMY_BASE_SPACING = 250;
const MAX_FOBS = 3;
/** Seconds a truck takes to build one, standing at the spot. */
const BUILD_S = 15;
/** Supply a forward base can hold, and how fast trucks fill up or unload, a second. */
const FOB_CAPACITY = 1500;
const TRANSFER_PER_S = 100;
/** A truck counts as at a place within this of it, metres. */
const ARRIVED_M = 25;
/** The tent's structure on each side (no armour): a few volleys bring it down. */
const HQ_STRUCTURE = 60;
const FOB_LOST_TICKETS = 10;
/** Supply refitting costs a forward base, a second per unit being refitted. */
const REFIT_SUPPLY_PER_S = 1;
const SITE_COLOR: [number, number, number, number] = [0.62, 0.82, 1, 1];
const NO_BUILD_COLOR: [number, number, number, number] = [0.95, 0.26, 0.2, 1];

export interface Fob {
  team: number;
  x: number;
  z: number;
  supply: number;
  hq: SeaUnit;
  turret: SeaUnit | null;
  decor: ModelInstance[];
  /** It has run out of supply for something it was asked for (said once, until a truck brings more). */
  dry: boolean;
}

/** Somewhere a squad can reinforce and refit: its side's main base (free), or a forward base (paid for in supply). */
export interface ServicePoint {
  x: number;
  z: number;
  radius: number;
  fob: Fob | null;
}

interface Build {
  x: number;
  z: number;
  progress: number;
  /** The ring marking where the player's truck is going to build. */
  site: Promise<ModelInstance> | null;
}

export class Logistics {
  readonly fobs: Fob[] = [];
  private readonly builds = new Map<Squad, Build>();
  private wallModel: GpuModel | null = null;
  private hqPath: string | null = null;
  private towerPath: string | null = null;
  private readonly rings = new Map<Fob, ModelInstance>();
  /** Rings shown while the player picks a spot: where a forward base can't go. */
  private noBuild: ModelInstance[] = [];
  private noBuildShown = false;
  private readonly noBuildModels = new Map<string, Promise<GpuModel>>();

  constructor(
    private readonly world: World,
    private readonly match: Match,
    readonly spec: ScenarioLogistics,
    private readonly baseRadius: number,
  ) {}

  async load(): Promise<void> {
    this.wallModel = await this.world.propModel(this.spec.wall);
    this.hqPath = this.world.propPath(this.spec.hq);
    if (this.hqPath) await this.world.prepareWreck(this.hqPath);
    this.towerPath = this.spec.tower ? this.world.propPath(this.spec.tower) : null;
    if (this.towerPath) await this.world.prepareWreck(this.towerPath);
  }

  /** Supply it costs to bring back a unit of a type at a forward base (a mech by its weight). */
  costOf(type: string): number {
    const kind = this.world.typeKind(type);
    const tons = this.world.typeTonnage(type);
    if (kind === 'mech') return Math.round(tons * 2);
    if (kind === 'infantry') return tons > 2 ? 25 : 10;
    if (kind === 'vehicle') return type === this.spec.truck ? 0 : 40;
    return 0;
  }

  /** Why a side can't build a forward base at a point, or null if it can. */
  whyNot(team: number, x: number, z: number): string | null {
    const own = this.match.side(team);
    if (this.fobs.filter((f) => f.team === team).length >= MAX_FOBS) return `${MAX_FOBS} forward bases is the most a side can keep`;
    if (Math.hypot(x - own.base.x, z - own.base.z) < FOB_SPACING) return 'too close to the main base';
    if (this.fobs.some((f) => f.team === team && Math.hypot(x - f.x, z - f.z) < FOB_SPACING)) return 'too close to another forward base';
    for (const s of this.match.sides) {
      if (s.team !== team && Math.hypot(x - s.base.x, z - s.base.z) < ENEMY_BASE_SPACING) return "too close to the enemy's base";
    }
    return null;
  }

  /** Why a logistics squad can't build a forward base anywhere just now, or null if it can. */
  whyNotNow(squad: Squad): string | null {
    const truck = squad.alive[0];
    if (!truck || truck.supply === null) return `${squad.name} has no truck`;
    if (squad.airborne) return `${squad.name} is with the Karnov`;
    if (truck.supply < this.spec.fobCost) return `${squad.name} carries ${Math.floor(truck.supply)} supply, and a forward base takes ${this.spec.fobCost}: fill up at base`;
    if (this.fobs.filter((f) => f.team === squad.team).length >= MAX_FOBS) return `${MAX_FOBS} forward bases is the most a side can keep`;
    return null;
  }

  /** Send a logistics squad to build a forward base at a point. Null when it's on its way; otherwise why it can't. */
  orderBuild(squad: Squad, x: number, z: number): string | null {
    const now = this.whyNotNow(squad);
    if (now) return now;
    const [sx, sz] = this.world.openNear(x, z, 'ground');
    const why = this.whyNot(squad.team, sx, sz);
    if (why) return `can't build there: ${why}`;
    const truck = squad.alive[0]!;
    if (this.world.grids && !this.world.grids.ground.connected(truck.x, truck.z, sx, sz)) return `${squad.name} can't drive there: airlift it over first`;
    this.cancel(squad, null);
    const site = squad.team === PLAYER_TEAM ? this.world.markerRing(SITE_COLOR, sx, sz, FOB_RADIUS).then((m) => this.world.addMarker(m, sx, sz, 1)) : null;
    this.builds.set(squad, { x: sx, z: sz, progress: 0, site });
    squad.move(this.world, sx, sz);
    return null;
  }

  /** Call off a squad's build (saying why, for the player's), and take down its site ring. */
  private cancel(squad: Squad, why: string | null): void {
    const build = this.builds.get(squad);
    if (!build) return;
    this.builds.delete(squad);
    void build.site?.then((ring) => this.world.removeMarker(ring));
    const truck = squad.alive[0];
    if (truck) truck.job = null;
    if (why && squad.team === PLAYER_TEAM) this.match.onEvent(`${squad.name}: forward base ${why}`, squad.team);
  }

  /**
   * While the player picks where to build (team), ring the places a forward base can't go: about each of their bases
   * and about the enemy's. Null takes the rings down.
   */
  async showNoBuild(team: number | null): Promise<void> {
    this.noBuildShown = team !== null;
    for (const r of this.noBuild) this.world.removeMarker(r);
    this.noBuild = [];
    if (team === null) return;
    const zones: [number, number, number][] = [];
    for (const s of this.match.sides) zones.push([s.base.x, s.base.z, s.team === team ? FOB_SPACING : ENEMY_BASE_SPACING]);
    for (const f of this.fobs) if (f.team === team) zones.push([f.x, f.z, FOB_SPACING]);
    const models = await Promise.all(zones.map(([x, z, r]) => this.noBuildModel(x, z, r)));
    // Taken down (or asked for again) meanwhile.
    if (!this.noBuildShown || this.noBuild.length) return;
    this.noBuild = models.map((m, i) => this.world.addMarker(m, zones[i]![0], zones[i]![1], 1));
  }

  private noBuildModel(x: number, z: number, r: number): Promise<GpuModel> {
    const key = `${x} ${z} ${r}`;
    let model = this.noBuildModels.get(key);
    if (!model) {
      model = this.world.markerRing(NO_BUILD_COLOR, x, z, r, 5);
      this.noBuildModels.set(key, model);
    }
    return model;
  }

  /** A forward base couldn't pay for a squad's refit or reinforcement: say so, once until it's supplied again. */
  short(fob: Fob, squad: Squad, what: 'refit' | 'reinforce'): void {
    if (fob.dry) return;
    fob.dry = true;
    if (fob.team !== PLAYER_TEAM) return;
    this.match.onEvent(`Forward base out of supply: ${squad.name} can't ${what} there until a truck brings more`, fob.team);
    this.match.onSignal({ kind: 'outOfSupply', team: fob.team, squad: null });
  }

  /** The squad has a build to do (it may still be driving there). */
  ordered(squad: Squad): boolean {
    return this.builds.has(squad);
  }

  /** Seconds left on a squad's build, or null if it isn't building (or is still driving there). */
  building(squad: Squad): number | null {
    const b = this.builds.get(squad);
    return b && b.progress > 0 ? Math.ceil(BUILD_S - b.progress) : null;
  }

  /** The main base and forward bases of a side. */
  servicePoints(team: number): ServicePoint[] {
    const base = this.match.side(team).base;
    return [{ x: base.x, z: base.z, radius: this.baseRadius, fob: null }, ...this.fobs.filter((f) => f.team === team).map((fob) => ({ x: fob.x, z: fob.z, radius: FOB_RADIUS, fob }))];
  }

  /** The point every one of these units stands within, if there is one. */
  pointFor(team: number, units: SeaUnit[]): ServicePoint | null {
    if (!units.length) return null;
    return this.servicePoints(team).find((p) => units.every((u) => Math.hypot(u.x - p.x, u.z - p.z) <= p.radius)) ?? null;
  }

  /** Where a wiped-out squad comes back: the forward base nearest the front that can pay for it, else the main base. */
  respawnPoint(team: number, cost: number): ServicePoint {
    const points = this.servicePoints(team);
    const front = this.match.capturable(team);
    const p = front === null ? null : this.match.points[front]!;
    const forward = points
      .filter((s) => s.fob && s.fob.supply >= cost)
      .sort((a, b) => (p ? Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z) : 0));
    return forward[0] ?? points[0]!;
  }

  /** Take supply from a forward base (the main base pays nothing); false if it hasn't enough. */
  pay(point: ServicePoint, amount: number): boolean {
    if (!point.fob) return true;
    if (point.fob.supply < amount) return false;
    point.fob.supply -= amount;
    return true;
  }

  /** What refitting a squad's units costs a second at a forward base (for those not already whole). */
  refitCost(units: SeaUnit[]): number {
    return units.filter((u) => u.combat && u.combat.integrity < 0.999).length * REFIT_SUPPLY_PER_S;
  }

  /** Where the Karnov flies from to reach a point: the nearest of the side's bases. */
  departure(team: number, x: number, z: number): { x: number; z: number } {
    return this.servicePoints(team).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0]!;
  }

  update(dt: number): void {
    for (const side of this.match.sides) {
      for (const squad of side.squads) {
        const truck = squad.alive[0];
        if (!squad.isLogistics || !truck || truck.supply === null) {
          this.cancel(squad, squad.alive.length ? null : 'called off: the truck was destroyed');
          continue;
        }
        squad.task = null;
        const still = !truck.route.length && !truck.embarked;
        const build = this.builds.get(squad);
        if (build) {
          // Another order (a move elsewhere, Stop, an airlift) calls it off.
          const o = squad.order;
          if (o.kind !== 'move' || Math.hypot(o.x - build.x, o.z - build.z) > 1) {
            this.cancel(squad, 'called off');
            continue;
          }
          if (Math.hypot(truck.x - build.x, truck.z - build.z) > ARRIVED_M) {
            if (still) this.cancel(squad, "called off: the truck couldn't get to the spot");
            continue;
          }
          if (!still) continue;
          if (build.progress === 0) truck.play('deploy', 0.3, true);
          build.progress += dt;
          const left = Math.ceil(BUILD_S - build.progress);
          squad.task = `building, ${left} s`;
          truck.job = { share: Math.min(build.progress / BUILD_S, 1), label: `Building · ${left} s` };
          if (build.progress < BUILD_S) continue;
          this.cancel(squad, null);
          truck.play('idle', 0.3);
          const why = this.whyNot(side.team, build.x, build.z) ?? (truck.supply < this.spec.fobCost ? 'not enough supply' : null);
          if (why) this.match.onEvent(`${squad.name} couldn't build: ${why}`, side.team);
          else {
            truck.supply -= this.spec.fobCost;
            void this.raise(side.team, build.x, build.z, side.paint);
            // Out of the tent's way, still inside the base (where it unloads what it has left).
            const back = (bearing(this.match.sides.find((s) => s.team !== side.team)!.base, build) * Math.PI) / 180;
            squad.move(this.world, build.x + Math.sin(back) * 25, build.z + Math.cos(back) * 25);
          }
          continue;
        }
        if (!still) continue;
        const at = this.pointFor(side.team, [truck]);
        if (!at) continue;
        if (!at.fob && truck.supply < (truck.supplyCapacity ?? 0)) {
          truck.supply = Math.min(truck.supplyCapacity ?? 0, truck.supply + TRANSFER_PER_S * dt);
          squad.task = 'filling up';
        } else if (at.fob && truck.supply > 0 && at.fob.supply < FOB_CAPACITY) {
          const amount = Math.min(truck.supply, FOB_CAPACITY - at.fob.supply, TRANSFER_PER_S * dt);
          truck.supply -= amount;
          at.fob.supply += amount;
          at.fob.dry = false;
          squad.task = 'unloading';
          if (truck.supply <= 0 && side.team === PLAYER_TEAM) {
            this.match.onEvent(`${squad.name} has unloaded everything: send it to base to fill up`, side.team);
            this.match.onSignal({ kind: 'outOfSupply', team: side.team, squad });
          }
        }
      }
    }
    // A base whose tent falls is gone (its turret fights on until it's destroyed too).
    for (let i = this.fobs.length - 1; i >= 0; i--) {
      const fob = this.fobs[i]!;
      if (fob.hq.alive) continue;
      this.fobs.splice(i, 1);
      for (const d of fob.decor) this.world.removeMarker(d);
      const ring = this.rings.get(fob);
      if (ring) this.world.removeMarker(ring);
      this.rings.delete(fob);
      const side = this.match.side(fob.team);
      side.tickets -= FOB_LOST_TICKETS;
      this.match.onEvent(`${side.name} lost a forward base (−${FOB_LOST_TICKETS} tickets)`, fob.team);
      this.match.onSignal({ kind: 'fobLost', team: fob.team });
    }
  }

  /** Put up a forward base: the tent, its sensor tower behind, sandbags either side, the turret in front, and its ring. */
  private async raise(team: number, x: number, z: number, paint: PaintScheme): Promise<void> {
    if (!this.hqPath) return;
    // It faces the enemy's base.
    const enemy = this.match.sides.find((s) => s.team !== team)!.base;
    const facing = bearing({ x, z }, enemy);
    const r = (facing * Math.PI) / 180;
    const hq = await this.world.spawn({
      model: this.hqPath,
      info: null,
      kind: 'structure',
      name: 'Forward base',
      team,
      x,
      z,
      rotation: facing,
      paint,
      stats: null,
      gunnery: 0,
      custom: structureStats('Forward base', HQ_STRUCTURE),
    });
    this.world.units.push(hq);
    if (this.towerPath) {
      const [sx, sz] = this.world.openNear(x - Math.sin(r) * 16, z - Math.cos(r) * 16, 'ground');
      const tower = await this.world.spawn({
        model: this.towerPath,
        info: null,
        kind: 'structure',
        name: 'Sensor tower',
        team,
        x: sx,
        z: sz,
        rotation: facing,
        paint,
        stats: null,
        gunnery: 0,
        custom: structureStats('Sensor tower', TOWER_STRUCTURE),
      });
      this.world.units.push(tower);
      this.match.sensors.addTower(tower);
    }
    const [tx, tz] = this.world.openNear(x + Math.sin(r) * 18, z + Math.cos(r) * 18, 'ground');
    const turret = await this.world.spawnType(this.spec.turret, team, tx, tz, facing, 50, paint);
    if (turret) this.world.units.push(turret);
    const decor: ModelInstance[] = [];
    if (this.wallModel) {
      for (const side of [-1, 1]) {
        const a = r + (side * Math.PI) / 2;
        decor.push(this.world.addMarker(this.wallModel, x + Math.sin(a) * 12, z + Math.cos(a) * 12, undefined, facing));
      }
    }
    const fob: Fob = { team, x, z, supply: 0, hq, turret, decor, dry: false };
    this.fobs.push(fob);
    const color: [number, number, number, number] = team === 0 ? [0.3, 0.62, 1, 1] : [1, 0.33, 0.27, 1];
    this.rings.set(fob, this.world.addMarker(await this.world.markerRing(color, x, z, FOB_RADIUS), x, z, 1));
    this.match.onEvent(`${this.match.side(team).name} built a forward base`, team);
    this.match.onSignal({ kind: 'fobBuilt', team });
  }
}

/** A building's stats (the tent, the sensor tower): structure on every side and no armour, no weapons. */
function structureStats(name: string, structure: number): VehicleStats {
  const sides = { front: structure, left: structure, right: structure, rear: structure, turret: structure };
  return {
    name,
    tonnage: 10,
    speed: 0,
    hover: false,
    refitPoints: 0,
    turretYaw: 0,
    armor: { front: 0, left: 0, right: 0, rear: 0, turret: 0 },
    structure: sides,
    weapons: [],
    ammo: {},
  };
}
