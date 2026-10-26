// Logistics, after Squad: supply trucks (MC2's repair truck, its 500 refit points carried as supply) build forward bases
// where the fight is and keep them supplied. A forward base is MC2's HQ tent behind sandbags, guarded by an autocannon
// turret, with a sensor tower behind it (sensors.ts). A side's wiped-out squads come back at the one nearest the front, squads there reinforce and refit (paid for in
// supply), and the Karnov flies from it. Destroy the tent and the base is gone. The main base works the same way, free.
//
// Trucks need no orders but where to go: one standing at the main base fills up, one standing at a forward base unloads
// into it, and one told to build drives to the spot and builds when it gets there (another order calls the build off).
// The player sees where their truck is going to build, how long it has left, and, while choosing a spot, where it can't.
//
// A truck also builds, for supply, a turret (the forward base's) anywhere, or a stretch of wall: two of MC2's light wall
// pieces end to end, across the way the enemy comes. As in MC2, a wall closes the ground it stands on (to everything
// but aircraft) but neither sight nor fire, and comes down to damage (objects/davionlightwall.fit: SetImpassable,
// blockLineOfFire FALSE, DmgLevel 30). Units shoot at walls only when ordered to. A wall that would cut a point or a
// base off from anywhere it can now be reached from, for any way of moving, can't be built: walls hinder, they don't
// seal (so the AI, which never breaks through one, is never shut out).
import type { ScenarioLogistics, VehicleStats } from '../../assets';
import type { PaintScheme } from '../../paint.ts';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { MoveClass } from '../sim/move-grid';
import type { Squad } from './squads';
import type { Match } from './match';
import { TOWER_STRUCTURE } from './sensors';
import { bearing, PLAYER_TEAM, type SeaUnit, type World } from './world';

/** Squads within this of a forward base reinforce and refit there, metres. */
export const FOB_RADIUS = 60;
/** A forward base must be this far from its side's base and other forward bases, and from the enemy's base. */
const FOB_SPACING = 300;
const ENEMY_BASE_SPACING = 250;
/** What a truck builds. */
export type BuildKind = 'fob' | 'turret' | 'wall';
export const BUILD_NAMES: Record<BuildKind, string> = { fob: 'forward base', turret: 'turret', wall: 'wall' };
/** The most of each a side keeps standing (walls by the stretch). */
const MAX_BUILT: Record<BuildKind, number> = { fob: 3, turret: 6, wall: 6 };
/** Seconds a truck takes to build one, standing at the spot. */
const BUILD_S: Record<BuildKind, number> = { fob: 15, turret: 10, wall: 8 };
/** Supply a turret and a stretch of wall cost (a forward base's is the scenario's). */
const TURRET_COST = 100;
const WALL_COST = 50;
/** A stretch of wall is this many of MC2's wall pieces end to end, and each takes this much damage to bring down. */
const WALL_PIECES = 2;
const WALL_STRUCTURE = 30;
/** The truck builds a wall standing this far back from it, metres. */
const WALL_STAND_M = 18;
/** Ways of moving a wall mustn't cut anything off for. */
const SEALED: MoveClass[] = ['mech', 'hover', 'ground'];
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
  kind: BuildKind;
  x: number;
  z: number;
  /** Which way it faces (a wall runs across it), MC2 degrees. */
  facing: number;
  /** Where the truck stands to build it. */
  stand: [number, number];
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
  /** Each side's wall piece: its model, and its two ends along its length (metres from its origin). */
  private readonly wallPieces = new Map<number, { path: string; ends: [number, number] }>();
  /** Stretches of wall standing, and the cells each piece closes. */
  private readonly walls: { team: number; pieces: { unit: SeaUnit; cells: number[] }[] }[] = [];
  /** Turrets trucks have built. */
  private readonly turrets: SeaUnit[] = [];
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
    for (const side of this.match.sides) {
      const key = side.spec.wall;
      const path = key ? this.world.propPath(key) : null;
      const ends = key ? await this.world.propLength(key) : null;
      if (!path || !ends) continue;
      await this.world.prepareWreck(path);
      this.wallPieces.set(side.team, { path, ends });
    }
  }

  /** Supply a build costs. */
  price(kind: BuildKind): number {
    return kind === 'fob' ? this.spec.fobCost : kind === 'turret' ? TURRET_COST : WALL_COST;
  }

  /** The scenario gives the side's trucks this to build. */
  canBuild(team: number, kind: BuildKind): boolean {
    return kind === 'fob' ? !!this.hqPath : kind === 'turret' ? !!this.spec.turret : this.wallPieces.has(team);
  }

  /** How many of a kind a side has standing. */
  private built(team: number, kind: BuildKind): number {
    if (kind === 'fob') return this.fobs.filter((f) => f.team === team).length;
    if (kind === 'turret') return this.turrets.filter((t) => t.team === team && t.alive).length;
    return this.walls.filter((w) => w.team === team && w.pieces.some((p) => p.unit.alive)).length;
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

  /** Why a side can't build this at a point, or null if it can. */
  whyNot(team: number, kind: BuildKind, x: number, z: number): string | null {
    const own = this.match.side(team);
    const most = MAX_BUILT[kind];
    if (this.built(team, kind) >= most) return `${most} ${BUILD_NAMES[kind]}${kind === 'wall' ? ' stretche' : ''}s is the most a side can keep`;
    for (const s of this.match.sides) {
      if (s.team !== team && Math.hypot(x - s.base.x, z - s.base.z) < ENEMY_BASE_SPACING) return "too close to the enemy's base";
    }
    if (kind === 'fob') {
      if (Math.hypot(x - own.base.x, z - own.base.z) < FOB_SPACING) return 'too close to the main base';
      if (this.fobs.some((f) => f.team === team && Math.hypot(x - f.x, z - f.z) < FOB_SPACING)) return 'too close to another forward base';
    }
    if (kind === 'wall') {
      const plan = this.wallPlan(team, x, z);
      if (!plan) return 'there are no walls in this scenario';
      if (this.world.grids && !this.world.grids.ground.openGround(plan.cells)) return 'a wall goes on open ground, clear of water and buildings';
      const cut = this.cuts(plan.cells);
      if (cut) return `it would cut ${cut} off (walls can slow the enemy, not shut anyone out)`;
    }
    return null;
  }

  /** Why a logistics squad can't build this anywhere just now, or null if it can. */
  whyNotNow(squad: Squad, kind: BuildKind = 'fob'): string | null {
    const truck = squad.alive[0];
    if (!truck || truck.supply === null) return `${squad.name} has no truck`;
    if (squad.airborne) return `${squad.name} is with the Karnov`;
    if (!this.canBuild(squad.team, kind)) return `there's no ${BUILD_NAMES[kind]} to build in this scenario`;
    const cost = this.price(kind);
    if (truck.supply < cost) return `${squad.name} carries ${Math.floor(truck.supply)} supply, and a ${BUILD_NAMES[kind]} takes ${cost}: fill up at base`;
    const most = MAX_BUILT[kind];
    if (this.built(squad.team, kind) >= most) return `${most} ${BUILD_NAMES[kind]}${kind === 'wall' ? ' stretche' : ''}s is the most a side can keep`;
    return null;
  }

  /** Send a logistics squad to build something at a point. Null when it's on its way; otherwise why it can't. */
  orderBuild(squad: Squad, kind: BuildKind, x: number, z: number): string | null {
    const now = this.whyNotNow(squad, kind);
    if (now) return now;
    const [sx, sz] = this.world.openNear(x, z, 'ground');
    const why = this.whyNot(squad.team, kind, sx, sz);
    if (why) return `can't build there: ${why}`;
    const facing = this.facing(squad.team, sx, sz);
    // A wall is built from behind it.
    const back = ((facing + 180) * Math.PI) / 180;
    const stand: [number, number] = kind === 'wall' ? this.world.openNear(sx + Math.sin(back) * WALL_STAND_M, sz + Math.cos(back) * WALL_STAND_M, 'ground') : [sx, sz];
    const truck = squad.alive[0]!;
    if (this.world.grids && !this.world.grids.ground.connected(truck.x, truck.z, stand[0], stand[1])) return `${squad.name} can't drive there: airlift it over first`;
    this.cancel(squad, null);
    const radius = kind === 'fob' ? FOB_RADIUS : kind === 'turret' ? 12 : this.wallLength(squad.team) / 2;
    const site = squad.team === PLAYER_TEAM ? this.world.markerRing(SITE_COLOR, sx, sz, radius).then((m) => this.world.addMarker(m, sx, sz, 1)) : null;
    this.builds.set(squad, { kind, x: sx, z: sz, facing, stand, progress: 0, site });
    squad.move(this.world, stand[0], stand[1]);
    return null;
  }

  /**
   * Which way a build at a spot faces: toward the next point along the lane on the enemy's side of the one nearest it
   * (or the enemy's base past the last), the way the enemy comes. A wall runs across it.
   */
  facing(team: number, x: number, z: number): number {
    const points = this.match.points;
    let k = 0;
    points.forEach((p, i) => {
      if (Math.hypot(p.x - x, p.z - z) < Math.hypot(points[k]!.x - x, points[k]!.z - z)) k = i;
    });
    const next = points[team === 0 ? k + 1 : k - 1] ?? this.match.sides.find((s) => s.team !== team)!.base;
    return bearing({ x, z }, next);
  }

  /** A stretch of wall's length, metres. */
  private wallLength(team: number): number {
    const piece = this.wallPieces.get(team);
    return piece ? (piece.ends[1] - piece.ends[0]) * WALL_PIECES : 0;
  }

  /** Where a stretch of wall centred on a spot goes: each piece's place and ends, and the cells it closes. */
  private wallPlan(team: number, x: number, z: number): { pieces: { x: number; z: number; a: [number, number]; b: [number, number] }[]; rotation: number; cells: number[] } | null {
    const piece = this.wallPieces.get(team);
    if (!piece) return null;
    const rotation = (this.facing(team, x, z) + 90) % 360;
    const r = (rotation * Math.PI) / 180;
    const [dx, dz] = [Math.sin(r), Math.cos(r)];
    const [lo, hi] = piece.ends;
    const length = hi - lo;
    const pieces = [];
    const cells = new Set<number>();
    for (let i = 0; i < WALL_PIECES; i++) {
      // Along the wall from its middle: where this piece's near end goes, then its origin back from there.
      const start = (i - WALL_PIECES / 2) * length;
      const a: [number, number] = [x + dx * start, z + dz * start];
      const b: [number, number] = [a[0] + dx * length, a[1] + dz * length];
      pieces.push({ x: a[0] - dx * lo, z: a[1] - dz * lo, a, b });
      for (const c of this.world.grids?.ground.cellsAlong(a[0], a[1], b[0], b[1]) ?? []) cells.add(c);
    }
    return { pieces, rotation, cells: [...cells] };
  }

  /**
   * The place (a point, or a side's base) these cells, closed, would cut off from somewhere it can now be reached from,
   * for any way of moving; or null.
   */
  private cuts(cells: number[]): string | null {
    const grids = this.world.grids;
    if (!grids) return null;
    const places = [
      ...this.match.sides.map((s) => ({ name: `${s.team === PLAYER_TEAM ? 'your' : "the enemy's"} base`, x: s.base.x, z: s.base.z })),
      ...this.match.points.map((p) => ({ name: p.name, x: p.x, z: p.z })),
    ];
    for (const cls of SEALED) {
      const g = grids[cls];
      const linked = places.flatMap((a, i) => places.slice(i + 1).filter((b) => g.connected(a.x, a.z, b.x, b.z)).map((b) => [a, b] as const));
      g.close(cells);
      const broken = linked.find(([a, b]) => !g.connected(a.x, a.z, b.x, b.z));
      g.reopen(cells);
      if (broken) return (broken.find((p) => !p.name.endsWith('base')) ?? broken[0]).name;
    }
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
   * While the player picks where to build (team), ring the places it can't go: about the enemy's base, and for a
   * forward base about each of their own bases too. Null takes the rings down.
   */
  async showNoBuild(team: number | null, kind: BuildKind = 'fob'): Promise<void> {
    this.noBuildShown = team !== null;
    for (const r of this.noBuild) this.world.removeMarker(r);
    this.noBuild = [];
    if (team === null) return;
    const zones: [number, number, number][] = [];
    for (const s of this.match.sides) {
      if (s.team !== team) zones.push([s.base.x, s.base.z, ENEMY_BASE_SPACING]);
      else if (kind === 'fob') zones.push([s.base.x, s.base.z, FOB_SPACING]);
    }
    if (kind === 'fob') for (const f of this.fobs) if (f.team === team) zones.push([f.x, f.z, FOB_SPACING]);
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
    return b && b.progress > 0 ? Math.ceil(BUILD_S[b.kind] - b.progress) : null;
  }

  /** How many turrets, or stretches of wall, a side has standing within `r` of a point. */
  standing(team: number, kind: 'turret' | 'wall', x: number, z: number, r: number): number {
    const near = (u: SeaUnit) => u.alive && Math.hypot(u.x - x, u.z - z) <= r;
    if (kind === 'turret') return this.turrets.filter((t) => t.team === team && near(t)).length;
    return this.walls.filter((w) => w.team === team && w.pieces.some((p) => near(p.unit))).length;
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
          const [sx, sz] = build.stand;
          if (o.kind !== 'move' || Math.hypot(o.x - sx, o.z - sz) > 1) {
            this.cancel(squad, 'called off');
            continue;
          }
          if (Math.hypot(truck.x - sx, truck.z - sz) > ARRIVED_M) {
            if (still) this.cancel(squad, "called off: the truck couldn't get to the spot");
            continue;
          }
          if (!still) continue;
          if (build.progress === 0) truck.play('deploy', 0.3, true);
          build.progress += dt;
          const time = BUILD_S[build.kind];
          const left = Math.ceil(time - build.progress);
          squad.task = `building, ${left} s`;
          truck.job = { share: Math.min(build.progress / time, 1), label: `Building · ${left} s` };
          if (build.progress < time) continue;
          this.cancel(squad, null);
          truck.play('idle', 0.3);
          const cost = this.price(build.kind);
          const why = this.whyNot(side.team, build.kind, build.x, build.z) ?? (truck.supply < cost ? 'not enough supply' : null);
          if (why) {
            this.match.onEvent(`${squad.name} couldn't build: ${why}`, side.team);
            continue;
          }
          truck.supply -= cost;
          if (build.kind === 'fob') void this.raise(side.team, build.x, build.z, side.paint);
          else if (build.kind === 'turret') void this.raiseTurret(side.team, build.x, build.z, build.facing, side.paint);
          else void this.raiseWall(side.team, build.x, build.z, side.paint);
          // Out of the way of what it built (a wall's builder stands clear already).
          if (build.kind !== 'wall') {
            const back = ((build.facing + 180) * Math.PI) / 180;
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
    // A wall piece knocked down opens its ground again.
    for (let i = this.walls.length - 1; i >= 0; i--) {
      const wall = this.walls[i]!;
      for (let k = wall.pieces.length - 1; k >= 0; k--) {
        const piece = wall.pieces[k]!;
        if (piece.unit.alive) continue;
        for (const cls of SEALED) this.world.grids?.[cls].reopen(piece.cells);
        wall.pieces.splice(k, 1);
      }
      if (!wall.pieces.length) this.walls.splice(i, 1);
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

  /** A turret on its own, facing the way the enemy comes. */
  private async raiseTurret(team: number, x: number, z: number, facing: number, paint: PaintScheme): Promise<void> {
    const turret = await this.world.spawnType(this.spec.turret, team, x, z, facing, 50, paint);
    if (!turret) return;
    this.world.units.push(turret);
    this.turrets.push(turret);
    this.match.onEvent(`${this.match.side(team).name} built a turret`, team);
    this.match.onSignal({ kind: 'built', what: 'turret', team });
  }

  /**
   * A stretch of wall, its pieces end to end across the way the enemy comes: they close the ground under them, and
   * whoever was on their way through goes round.
   */
  private async raiseWall(team: number, x: number, z: number, paint: PaintScheme): Promise<void> {
    const plan = this.wallPlan(team, x, z);
    const piece = this.wallPieces.get(team);
    if (!plan || !piece) return;
    const wall: (typeof this.walls)[number] = { team, pieces: [] };
    const closed = new Set<number>();
    for (const p of plan.pieces) {
      const unit = await this.world.spawn({
        model: piece.path,
        info: null,
        kind: 'structure',
        name: 'Wall',
        team,
        x: p.x,
        z: p.z,
        rotation: plan.rotation,
        paint,
        stats: null,
        gunnery: 0,
        custom: structureStats('Wall', WALL_STRUCTURE),
      });
      unit.wall = true;
      this.world.units.push(unit);
      const cells = this.world.grids?.ground.cellsAlong(p.a[0], p.a[1], p.b[0], p.b[1]) ?? [];
      for (const cls of SEALED) this.world.grids?.[cls].close(cells);
      for (const c of cells) closed.add(c);
      wall.pieces.push({ unit, cells });
    }
    // Kept from here on (the pieces are made one after another, and an empty wall would be cleared away).
    this.walls.push(wall);
    this.world.reroute(closed);
    this.match.onEvent(`${this.match.side(team).name} built a wall`, team);
    this.match.onSignal({ kind: 'built', what: 'wall', team });
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
    losFactor: 1,
    mines: 0,
    armor: { front: 0, left: 0, right: 0, rear: 0, turret: 0 },
    structure: sides,
    weapons: [],
    ammo: {},
  };
}
