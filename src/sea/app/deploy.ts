// Support units a side calls in, after MC2's support menu (code/controlgui.cpp, missiongui.cpp): its guard tower (in
// truth an artillery piece: objects/guardtower.fit, a 40-tonne Long Tom that never moves), its scout (a light
// helicopter, objects/scoutcopter.fit, that sees 20% further than most: LOSFactor 1.2), its minelayer
// (objects/minelayer.fit: mines.ts) and its repair vehicle (objects/repairtruck.fit, the supply trucks' own, its refit
// points for mending mechs in the field: repairs.ts). As the engine does it, a VTOL (tgl/vtol, its drop-off animation)
// flies the unit in to a spot the side can see, on dry, open ground, sets it down 145 frames in and flies off; the
// unit's crew are MC2's support pilots (missions/warriors/pmwguardtower.fit and the others), talking in MC2's voices for
// them (sound/pilota..pilotd), and the support desk says what's coming. Its recovery team is recovery.ts.
//
// MC2 buys these with resource points. Here, as with strikes, a side has one of each at a time: the first is ready a
// while into the match, and the next a while after the last is lost. Each comes as a squad of one, which the player
// orders like any other.
import type { ScenarioDeploy, ScenarioSupport } from '../../assets';
import type { Match, Side } from './match';
import { Squad } from './squads';
import { bearing, type SeaUnit, type World } from './world';

export type Deploy = 'artilleryPiece' | 'scout' | 'minelayer' | 'repairVehicle';
export const DEPLOYS: Deploy[] = ['artilleryPiece', 'scout', 'minelayer', 'repairVehicle'];
export const DEPLOY_NAMES: Record<Deploy, string> = { artilleryPiece: 'Artillery piece', scout: 'Scout', minelayer: 'Minelayer', repairVehicle: 'Repair vehicle' };
/** What the repair vehicle is called (it's the supply trucks' own: MC2's repair truck). */
const REPAIR_TRUCK = 'Repair truck';
/** The squad each makes: its name, and its role on its card. */
const SQUADS: Record<Deploy, { name: string; role: string }> = {
  artilleryPiece: { name: 'Long Tom', role: 'Artillery piece' },
  scout: { name: 'Pegasus', role: 'Scout copter' },
  minelayer: { name: 'Sapper', role: 'Minelayer' },
  repairVehicle: { name: 'Wrench', role: 'Repair vehicle' },
};
/** The VTOL sets the unit down this far into its animation (code/missiongui.cpp: frame 145 at 30 a second), of 300. */
const DROP_S = 145 / 30;
const VTOL_S = 300 / 30;
/** Its animation carries it about 100 m off and 90 m up (tgl/vtol_dropoff.ase), so it's culled by this radius, metres. */
const VTOL_REACH_M = 150;
/** It's set down on the open ground nearest the spot, if that's no further off than this, metres. */
const OPEN_M = 30;

interface Slot {
  kind: Deploy;
  team: number;
  spec: ScenarioDeploy;
  squad: Squad;
  /** Match time it can be called (Infinity while it's out or on its way). */
  readyAt: number;
  announced: boolean;
  /** The VTOL bringing it, and where to. */
  drop: { x: number; z: number; at: number; vtol: SeaUnit | null; dropped: boolean } | null;
}

export class Deployments {
  private readonly slots: Slot[] = [];

  constructor(
    private readonly world: World,
    private readonly match: Match,
    private readonly spec: ScenarioSupport,
  ) {}

  /** Make each side's squad for each support unit the scenario has (at the end of its squads; empty until called). */
  addSquads(side: Side): void {
    for (const kind of DEPLOYS) {
      const d = this.spec[kind];
      if (!d || !this.spec.vtol || !this.world.propPath(this.spec.vtol) || !this.world.hasType(d.unit)) continue;
      const { name, role } = SQUADS[kind];
      const squad = new Squad(side.team, String.fromCharCode(65 + side.squads.length), { name, role, units: [d.unit], gunnery: d.gunnery, voice: d.voice });
      squad.support = kind;
      side.squads.push(squad);
      this.slots.push({ kind, team: side.team, spec: d, squad, readyAt: d.first, announced: false, drop: null });
    }
  }

  /** The scenario has this support (and the converter exported what it needs). */
  available(kind: Deploy): boolean {
    return this.slots.some((s) => s.kind === kind);
  }

  /** It's out, or on its way. */
  out(team: number, kind: Deploy): boolean {
    const slot = this.slot(team, kind);
    return !!slot && slot.readyAt === Infinity;
  }

  /** Seconds until a side can call it (0: now; Infinity while one is out). */
  readyIn(team: number, kind: Deploy): number {
    const slot = this.slot(team, kind);
    return slot ? Math.max(0, slot.readyAt - this.match.time) : Infinity;
  }

  /** A side's squad for it. */
  squad(team: number, kind: Deploy): Squad | null {
    return this.slot(team, kind)?.squad ?? null;
  }

  /** Why a side can't have it brought to a spot just now, or null if it can. */
  whyNot(team: number, kind: Deploy, x: number, z: number): string | null {
    const slot = this.slot(team, kind);
    const name = DEPLOY_NAMES[kind];
    if (!slot) return `there's no ${name.toLowerCase()} in this scenario`;
    if (slot.readyAt === Infinity) return `your ${name.toLowerCase()} is already out (${slot.squad.name})`;
    const wait = this.readyIn(team, kind);
    if (wait > 0) return `${name} is ready in ${Math.ceil(wait)} s`;
    if (!this.world.teamSees(team, x, z)) return `none of your squads can see there: the VTOL sets down only where they can`;
    if (this.world.terrain.heightAt(x, z) < 0) return `the VTOL can't set the ${name.toLowerCase()} down in the water`;
    const [sx, sz] = this.world.openNear(x, z, 'ground');
    if (Math.hypot(sx - x, sz - z) > OPEN_M) return `the VTOL needs open ground to set the ${name.toLowerCase()} down on`;
    return null;
  }

  /** Have the VTOL bring it to a spot; why not, if it can't. */
  call(team: number, kind: Deploy, x: number, z: number): string | null {
    const why = this.whyNot(team, kind, x, z);
    if (why) return why;
    const slot = this.slot(team, kind)!;
    const [sx, sz] = this.world.openNear(x, z, 'ground');
    slot.readyAt = Infinity;
    slot.announced = false;
    slot.squad.inbound = true;
    slot.squad.order = { kind: 'hold' };
    const drop: NonNullable<Slot['drop']> = { x: sx, z: sz, at: this.match.time + DROP_S, vtol: null, dropped: false };
    slot.drop = drop;
    void this.fly(slot, drop);
    this.match.onSignal({ kind: 'deployCalled', team, what: kind, x: sx, z: sz });
    return null;
  }

  update(): void {
    const now = this.match.time;
    for (const slot of this.slots) {
      const drop = slot.drop;
      if (drop) {
        if (!drop.dropped && now >= drop.at) {
          drop.dropped = true;
          void this.setDown(slot, drop);
        }
        // Gone once it's flown off again (or, if it never showed, once it would have).
        if (drop.dropped && !slot.squad.inbound && (drop.vtol ? drop.vtol.clipDone : now > drop.at - DROP_S + VTOL_S)) {
          if (drop.vtol) this.world.remove(drop.vtol);
          slot.drop = null;
        }
        continue;
      }
      // Lost: the next is on its way after a while.
      if (slot.readyAt === Infinity && !slot.squad.alive.length) {
        slot.readyAt = now + slot.spec.cooldown;
        this.match.onSignal({ kind: 'deployLost', team: slot.team, what: slot.kind });
      }
      if (now >= slot.readyAt && !slot.announced) {
        slot.announced = true;
        this.match.onSignal({ kind: 'deployReady', team: slot.team, what: slot.kind });
      }
    }
  }

  private slot(team: number, kind: Deploy): Slot | undefined {
    return this.slots.find((s) => s.team === team && s.kind === kind);
  }

  /** The VTOL comes in from the side's base (its animation flies in from behind it) and plays its drop-off. */
  private async fly(slot: Slot, drop: NonNullable<Slot['drop']>): Promise<void> {
    const path = this.spec.vtol ? this.world.propPath(this.spec.vtol) : null;
    if (!path) return;
    const side = this.match.side(slot.team);
    const vtol = await this.world.spawn({
      model: path,
      info: null,
      kind: 'vehicle',
      name: 'VTOL',
      team: slot.team,
      x: drop.x,
      z: drop.z,
      rotation: bearing(side.base, drop),
      paint: side.paint,
      stats: null,
      gunnery: 0,
    });
    vtol.instance.radius = VTOL_REACH_M;
    vtol.play('dropoff', 0, true);
    this.world.units.push(vtol);
    // Made too late to be seen doing it: it's done.
    if (slot.drop !== drop) return this.world.remove(vtol);
    drop.vtol = vtol;
    this.world.battle.vtol(drop.x, drop.z, false);
  }

  /** The unit is down, facing the enemy's end of the lane, and joins its squad. */
  private async setDown(slot: Slot, drop: NonNullable<Slot['drop']>): Promise<void> {
    const side = this.match.side(slot.team);
    const enemy = this.match.sides.find((s) => s !== side)!;
    const type = slot.spec.unit;
    const [x, z] = this.world.openNear(drop.x, drop.z, this.world.typeMoveClass(type));
    const name = slot.kind === 'repairVehicle' ? REPAIR_TRUCK : undefined;
    const unit = await this.world.spawnType(type, slot.team, x, z, bearing(drop, enemy.base), slot.spec.gunnery, side.paint, name);
    slot.squad.inbound = false;
    if (!unit) {
      slot.readyAt = this.match.time + slot.spec.cooldown;
      return;
    }
    // A repair truck's refit points are for repairs here, not supply.
    if (slot.kind === 'repairVehicle') {
      [unit.repairPoints, unit.repairCapacity] = [unit.supply, unit.supplyCapacity];
      unit.supply = unit.supplyCapacity = null;
    }
    unit.squad = slot.squad;
    slot.squad.units.push(unit);
    this.world.units.push(unit);
    this.world.battle.vtol(x, z, true);
    this.match.onSignal({ kind: 'deployed', team: slot.team, what: slot.kind, squad: slot.squad });
  }
}
