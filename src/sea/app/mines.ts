// Minefields, after MC2's minelayer (code/gvehicl.cpp, mech.cpp mineCheck). Sent to lay mines, a minelayer drives where
// it's sent leaving a mine in each movement-map cell it passes through: one each half second (gamesys MineWaitTime) in a
// cell it hasn't just mined, until its 160 (its object file's MineLayer) are gone. A mine goes off under a mech or a
// vehicle of more than 35 tonnes (soldiers, light machines and helicopters pass over it), doing 12 damage (gamesys
// [Mine] BaseDamage) to a mech's legs or a vehicle's front, and is spent. A strike or a Long Tom shell bursting about
// mines sets them off (code/carnage.cpp, artlry.cpp). Everyone sees every mine (MC2: "EVERYONE CAN SEE MINES"), and no
// route goes round them (MC2's mine avoidance is compiled out): it's for the commander to steer clear.
//
// This project's rules: a side's own mines don't go off under its own units (MC2's go off under anyone but a
// minelayer), and a minelayer loads mines again at a base as the others refit.
import type { GpuModel, ModelInstance } from '../render/models/model-renderer';
import type { MoveGrid } from '../sim/move-grid';
import type { Attacker } from './battle';
import type { Match } from './match';
import type { SeaUnit, World } from './world';

/** Seconds a minelayer spends in a cell before it lays a mine there (gamesys [Mine] MineWaitTime). */
const MINE_WAIT_S = 0.5;
/** Damage a mine does (gamesys [Mine] BaseDamage). */
const MINE_DAMAGE = 12;
/** Only what weighs more than this sets a mine off, tonnes (mech.cpp, gvehicl.cpp mineCheck). */
const TRIGGER_TONNES = 35;
/** Seconds between looks for units on mines. */
const CHECK_S = 0.1;
/** How a mine looks: a small red ring on the ground, this many metres in radius. */
const MINE_RADIUS_M = 1.8;
const MINE_COLOR: [number, number, number, number] = [0.85, 0.12, 0.05, 1];

interface Mine {
  team: number;
  x: number;
  z: number;
  marker: ModelInstance | null;
}

export class Minefields {
  /** Mines by movement-map cell (a cell holds one). */
  private readonly mines = new Map<number, Mine>();
  /** Each minelayer laying: the last cell it mined, and its time toward the next. */
  private readonly layers = new Map<SeaUnit, { cell: number; time: number }>();
  private model: Promise<GpuModel> | null = null;
  private checkIn = 0;

  constructor(
    private readonly world: World,
    private readonly match: Match,
  ) {}

  /** Mines a side has laid that are still there. */
  count(team: number): number {
    let n = 0;
    for (const m of this.mines.values()) if (m.team === team) n++;
    return n;
  }

  /** Every mine still there (where, and whose). */
  all(): { team: number; x: number; z: number }[] {
    return [...this.mines.values()].map(({ team, x, z }) => ({ team, x, z }));
  }

  update(dt: number): void {
    const grid = this.world.grid;
    if (!grid) return;
    for (const u of this.world.units) {
      if (u.mines === null) continue;
      if (!u.alive || !u.laying || !u.route.length || u.mines < 1) {
        this.layers.delete(u);
        continue;
      }
      const cell = index(grid, u.x, u.z);
      const state = this.layers.get(u) ?? { cell: -1, time: 0 };
      this.layers.set(u, state);
      // As the engine does it: the time counts only in a cell it hasn't just mined, and starts again with each mine.
      if (cell === state.cell) continue;
      state.time += dt;
      if (state.time <= MINE_WAIT_S) continue;
      state.cell = cell;
      state.time = 0;
      this.lay(grid, u.team, cell);
      u.mines--;
      if (u.mines >= 1) continue;
      u.laying = false;
      if (u.squad) this.match.onSignal({ kind: 'minesGone', team: u.team, squad: u.squad });
    }
    this.checkIn -= dt;
    if (this.checkIn > 0 || !this.mines.size) return;
    this.checkIn = CHECK_S;
    for (const u of [...this.world.units]) {
      if (!this.triggers(u)) continue;
      const cell = index(grid, u.x, u.z);
      const mine = this.mines.get(cell);
      if (!mine || mine.team === u.team) continue;
      this.remove(cell, mine);
      const by: Attacker = { team: mine.team, name: 'Mine', x: mine.x, z: mine.z, squad: null };
      this.world.battle.mine(u, MINE_DAMAGE, by);
      this.match.onSignal({ kind: 'mineHit', team: u.team, unit: u });
    }
  }

  /** A blast at (x, z) sets off the mines within `radius` of it. */
  setOff(x: number, z: number, radius: number): void {
    for (const [cell, mine] of this.mines) {
      if (Math.hypot(mine.x - x, mine.z - z) > radius) continue;
      this.remove(cell, mine);
      this.world.battle.mineBurst(mine.x, mine.z);
    }
  }

  /** A mech or a vehicle heavy enough, on the ground, that isn't a minelayer itself. */
  private triggers(u: SeaUnit): boolean {
    if (!u.alive || !u.combat || u.embarked || u.flies || u.mines !== null || u.immobile) return false;
    if (u.kind !== 'mech' && u.kind !== 'vehicle') return false;
    return u.combat.stats.tonnage > TRIGGER_TONNES;
  }

  /** A mine in a cell (it takes the place of any there). */
  private lay(grid: MoveGrid, team: number, cell: number): void {
    const old = this.mines.get(cell);
    if (old) this.remove(cell, old);
    const [x, z] = grid.centre(Math.floor(cell / grid.width), cell % grid.width);
    const mine: Mine = { team, x, z, marker: null };
    this.mines.set(cell, mine);
    this.model ??= this.world.smallMarker('mine', MINE_COLOR, MINE_RADIUS_M);
    void this.model.then((m) => {
      // Gone off meanwhile.
      if (this.mines.get(cell) === mine) mine.marker = this.world.addMarker(m, x, z, 1);
    });
  }

  private remove(cell: number, mine: Mine): void {
    this.mines.delete(cell);
    if (mine.marker) this.world.removeMarker(mine.marker);
    mine.marker = null;
  }
}

function index(grid: MoveGrid, x: number, z: number): number {
  const [r, c] = grid.cellOf(x, z);
  return r * grid.width + c;
}
