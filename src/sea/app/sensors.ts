// Sensors (MC2's code/contact.cpp): besides what its units see (225 m, with the ground in the way), a side picks up the
// enemy within its sensors' reach whatever is in between. MC2 calls these sensor contacts and draws them as blips: where
// something is, not what. Nothing fires at a contact (weapons need sight), but a strike can be called on one, and the
// AI counts them as sightings.
//
// The sensors: mechs that carry better than standard ones (the Raven's Advanced, 550 m; the Werewolf's Extended, 400 m),
// lost to a critical hit; a forward base's sensor tower (MC2's, 550 m); and sensor probes, called in like a strike (MC2's
// artsns: 800 m about the spot, shrinking steadily to nothing over two minutes). A unit carrying ECM (the Raven) isn't
// picked up, only seen.
import type { StrikeStats } from '../../assets';
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import { MechCombat } from '../sim/combat';
import type { Match } from './match';
import { PLAYER_TEAM, type SeaUnit, type World } from './world';

/** A sensor tower's reach, metres, and its damage level (objects/liaosensortower.fit SensorRange, DmgLevel). */
export const TOWER_RANGE = 550;
export const TOWER_STRUCTURE = 11;
/** Seconds between sweeps. */
const SWEEP_S = 0.5;
/** The player's probe's ring shows its reach to the next this many metres (ring models are made once and kept). */
const RING_STEP_M = 100;
const RING_COLOR: [number, number, number, number] = [0.45, 0.9, 0.75, 1];
/** The probe's marker, drawn this large and spinning (Support's, for a strike). */
const MARKER_SIZE = 2;
const MARKER_SPIN_DEG_S = 45;
/** A side's towers picking someone up after this many seconds with nobody is announced. */
const TOWER_QUIET_S = 60;

interface Probe {
  team: number;
  x: number;
  z: number;
  range: number;
  time: number;
  since: number;
  marker: ModelInstance | null;
  ring: ModelInstance | null;
  ringRadius: number;
}

interface Source {
  x: number;
  z: number;
  range: number;
  tower: boolean;
}

export class Sensors {
  private readonly contacts = new Map<number, Set<SeaUnit>>();
  private readonly towers = new Set<SeaUnit>();
  private readonly probes: Probe[] = [];
  /** Whom each side's towers had last sweep, and when they last had anyone. */
  private readonly towerHeld = new Map<number, Set<SeaUnit>>();
  private readonly towerBusy = new Map<number, number>();
  private readonly rings = new Map<string, Promise<GpuModel>>();
  private marker: GpuModel | null = null;
  private sweepIn = 0;
  private spin = 0;

  constructor(
    private readonly world: World,
    private readonly match: Match,
  ) {}

  async load(marker: string | null): Promise<void> {
    if (marker) this.marker = await this.world.propModel(marker);
  }

  /** A sensor tower watches for its side until it's destroyed. */
  addTower(u: SeaUnit): void {
    this.towers.add(u);
  }

  /** A side's sensor probe lands at a spot. */
  probe(team: number, x: number, z: number, stats: StrikeStats): void {
    const p: Probe = { team, x, z, range: stats.sensorRange, time: stats.sensorTime, since: this.match.time, marker: null, ring: null, ringRadius: 0 };
    this.probes.push(p);
    if (team === PLAYER_TEAM && this.marker) p.marker = this.world.addMarker(this.marker, x, z, this.world.modelScale(MARKER_SIZE));
    this.sweep();
  }

  /** The enemies a side's sensors pick up, in sight or not, as of the last sweep. */
  sensed(team: number): ReadonlySet<SeaUnit> {
    return this.contacts.get(team) ?? NOTHING;
  }

  /** A side's sensors reach a spot. */
  covers(team: number, x: number, z: number): boolean {
    return this.sources(team).some((s) => Math.hypot(s.x - x, s.z - z) <= s.range);
  }

  update(dt: number): void {
    this.spin = (this.spin + MARKER_SPIN_DEG_S * dt) % 360;
    for (let i = this.probes.length - 1; i >= 0; i--) {
      const p = this.probes[i]!;
      if (p.marker) this.world.placeMarker(p.marker, p.x, p.z, this.spin, this.world.modelScale(MARKER_SIZE));
      const reach = this.reach(p);
      if (reach > 0) {
        if (p.team === PLAYER_TEAM) void this.showRing(p, Math.ceil(reach / RING_STEP_M) * RING_STEP_M);
        continue;
      }
      if (p.marker) this.world.removeMarker(p.marker);
      if (p.ring) this.world.removeMarker(p.ring);
      p.ringRadius = -1;
      this.probes.splice(i, 1);
    }
    for (const t of this.towers) {
      if (t.alive) continue;
      this.towers.delete(t);
      this.match.onSignal({ kind: 'towerLost', team: t.team });
    }
    this.sweepIn -= dt;
    if (this.sweepIn > 0) return;
    this.sweepIn = SWEEP_S;
    this.sweep();
  }

  /** What each side's sensors pick up now; a side's towers that pick someone up after a quiet while say so. */
  private sweep(): void {
    for (const side of this.match.sides) {
      const sources = this.sources(side.team);
      const found = new Set<SeaUnit>();
      const byTowers = new Set<SeaUnit>();
      for (const u of this.world.units) {
        if (u.team === side.team || !u.alive || !u.combat || u.embarked || u.kind === 'structure') continue;
        if (u.combat instanceof MechCombat && u.combat.stats.ecm) continue;
        for (const s of sources) {
          if (Math.hypot(s.x - u.x, s.z - u.z) > s.range) continue;
          found.add(u);
          if (s.tower) byTowers.add(u);
        }
      }
      this.contacts.set(side.team, found);
      const held = this.towerHeld.get(side.team);
      this.towerHeld.set(side.team, byTowers);
      const fresh = [...byTowers].some((u) => !held?.has(u));
      if (fresh && this.match.time - (this.towerBusy.get(side.team) ?? -Infinity) > TOWER_QUIET_S) this.match.onSignal({ kind: 'towerContact', team: side.team });
      if (byTowers.size) this.towerBusy.set(side.team, this.match.time);
    }
  }

  /** A side's sensors and their reach: mechs with working sensors better than standard, towers, probes. */
  private sources(team: number): Source[] {
    const sources: Source[] = [];
    for (const u of this.world.units) {
      if (u.team !== team || !u.alive || u.embarked) continue;
      if (this.towers.has(u)) sources.push({ x: u.x, z: u.z, range: TOWER_RANGE, tower: true });
      else if (u.combat instanceof MechCombat && u.combat.sensorRange > 1) sources.push({ x: u.x, z: u.z, range: u.combat.sensorRange, tower: false });
    }
    for (const p of this.probes) if (p.team === team) sources.push({ x: p.x, z: p.z, range: this.reach(p), tower: false });
    return sources;
  }

  /** A probe's reach now: it shrinks steadily from its full reach to nothing (code/artlry.cpp). */
  private reach(p: Probe): number {
    return Math.max(0, p.range * (1 - (this.match.time - p.since) / p.time));
  }

  /** The player's probe's ring at a radius (one step at a time, as it shrinks). */
  private async showRing(p: Probe, radius: number): Promise<void> {
    if (p.ringRadius === radius || p.ringRadius < 0) return;
    p.ringRadius = radius;
    const key = `${p.x} ${p.z} ${radius}`;
    let model = this.rings.get(key);
    if (!model) {
      model = this.world.markerRing(RING_COLOR, p.x, p.z, radius, 4);
      this.rings.set(key, model);
    }
    const m = await model;
    // Shrunk again, or gone, meanwhile.
    if (p.ringRadius !== radius) return;
    const ring = this.world.addMarker(m, p.x, p.z, 1);
    if (p.ring) this.world.removeMarker(p.ring);
    p.ring = ring;
  }
}

const NOTHING: ReadonlySet<SeaUnit> = new Set();
