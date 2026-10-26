// The recovery team, after MC2's (code/missiongui.cpp: beginVtol and updateVTol for its support vehicle 147; and
// Mover::recover, code/mover.cpp). Called on the wreck of a mech that was disabled rather than blown apart (MC2: its
// pilot killed, its head, legs or engine gone, or its centre torso worn through rather than blown in at one blow), that
// the side can see, whoever's it was: a Karnov comes in over it on its landing gesture, hovers there with its recovery
// beam on it for 5 s (gamesys RecoverTime), and flies off, leaving it mended: its structure whole again but for arms it
// had lost, every component working, its armour and ammunition as they were, and a new pilot at its controls. It gets
// up to fight for the side that recovered it. A wreck that blasts finish off meanwhile is beyond recovery.
//
// MC2 buys this with resource points. Here, as with strikes, a side has one at a time: the first is ready a while into
// the match, the next a while after the Karnov has mended one. A mech of the side's own goes back to its squad if
// that's short of it, and gives back the tickets it cost (this project's rule: Squad's medics revive the fallen); any
// other joins the side's salvage squad, a lance at most.
import type { ScenarioRecovery } from '../../assets';
import type { Match, Side } from './match';
import { Squad } from './squads';
import { bearing, type SeaUnit, type World } from './world';

/** Seconds the Karnov hovers over the wreck before it's mended (gamesys RecoverTime). */
const RECOVER_S = 5;
/** Seconds between redraws of its beam. */
const BEAM_S = 0.3;
/** Its beam comes from its cargo arm, this high over the ground, metres (it hovers 17 m up: airlift.ts). */
const BEAM_FROM_M = 13;
/** The Karnov's clips carry it this far from its position, so it's culled by this radius, metres (airlift.ts). */
const REACH_M = 120;
/** The salvage squad is a lance at most. */
const SALVAGE_MAX = 4;

interface Flight {
  wreck: SeaUnit;
  craft: SeaUnit | null;
  phase: 'landing' | 'hover' | 'leaving';
  timer: number;
  beamAt: number;
  /** It mended the wreck (the next is ready after the cooldown; a flight that couldn't leaves it ready again). */
  mended: boolean;
}

interface Slot {
  team: number;
  readyAt: number;
  announced: boolean;
  flight: Flight | null;
  /** The mechs it has brought back that have no squad of their own to go to. */
  salvage: Squad;
}

export class Recovery {
  private readonly slots: Slot[] = [];

  constructor(
    private readonly world: World,
    private readonly match: Match,
    private readonly spec: ScenarioRecovery,
    /** The Karnov's model (the scenario's transport): with none, there's no recovery team. */
    private readonly karnov: string | null,
  ) {}

  /** Make each side's salvage squad (at the end of its squads; empty until a mech is brought back to it). */
  addSquads(side: Side): void {
    if (!this.karnov) return;
    const squad = new Squad(side.team, String.fromCharCode(65 + side.squads.length), {
      name: 'Salvage',
      role: 'Recovered mechs',
      units: [],
      gunnery: this.spec.gunnery,
      voice: this.spec.voice,
    });
    squad.salvage = true;
    side.squads.push(squad);
    this.slots.push({ team: side.team, readyAt: this.spec.first, announced: false, flight: null, salvage: squad });
  }

  get available(): boolean {
    return this.slots.length > 0;
  }

  /** Seconds until a side can call it (0: now; Infinity while its Karnov is out). */
  readyIn(team: number): number {
    const slot = this.slot(team);
    if (!slot) return Infinity;
    return slot.flight ? Infinity : Math.max(0, slot.readyAt - this.match.time);
  }

  /** A Karnov is on its way to this wreck, or over it. */
  recovering(u: SeaUnit): boolean {
    return this.slots.some((s) => s.flight?.wreck === u);
  }

  /** Why a side can't have this wreck recovered just now (null: a tap on no disabled mech's wreck), or null if it can. */
  whyNot(team: number, wreck: SeaUnit | null): string | null {
    const slot = this.slot(team);
    if (!slot) return `there's no recovery team in this scenario`;
    if (slot.flight) return 'your recovery team is already out';
    const wait = this.readyIn(team);
    if (wait > 0) return `Recovery team is ready in ${Math.ceil(wait)} s`;
    if (!wreck?.salvage || wreck.alive) return `tap the wreck of a disabled mech (one that isn't burnt out)`;
    if (this.recovering(wreck)) return `the enemy's recovery team is already on that one`;
    if (!this.world.teamSees(team, wreck.x, wreck.z)) return `none of your squads can see it: the recovery team goes only where they can`;
    if (!this.home(slot, wreck)) return `your salvage squad is full (a lance)`;
    return null;
  }

  /** Send a side's Karnov to recover a wreck; why not, if it can't. */
  call(team: number, wreck: SeaUnit | null): string | null {
    const why = this.whyNot(team, wreck);
    if (why || !wreck) return why;
    const slot = this.slot(team)!;
    const flight: Flight = { wreck, craft: null, phase: 'landing', timer: 0, beamAt: 0, mended: false };
    slot.flight = flight;
    slot.announced = false;
    void this.fly(slot, flight);
    this.match.onSignal({ kind: 'recoveryCalled', team, unit: wreck });
    return null;
  }

  update(dt: number): void {
    const now = this.match.time;
    for (const slot of this.slots) {
      const f = slot.flight;
      if (f) {
        if (f.craft) this.step(slot, f, dt);
        continue;
      }
      if (now >= slot.readyAt && !slot.announced) {
        slot.announced = true;
        this.match.onSignal({ kind: 'recoveryReady', team: slot.team });
      }
    }
  }

  private slot(team: number): Slot | undefined {
    return this.slots.find((s) => s.team === team);
  }

  /** Where a recovered mech goes: back to its own squad if that's short of it, else the salvage squad if it has room. */
  private home(slot: Slot, wreck: SeaUnit): { squad: Squad; own: boolean } | null {
    const own = wreck.team === slot.team ? wreck.squad : null;
    if (own && !own.support && wreck.typeKey) {
      const wanted = own.spec.units.filter((t) => t === wreck.typeKey).length;
      const have = own.riders.filter((u) => u.typeKey === wreck.typeKey).length;
      if (have < wanted) return { squad: own, own: true };
    }
    return slot.salvage.alive.length < SALVAGE_MAX ? { squad: slot.salvage, own: false } : null;
  }

  /** The Karnov comes in over the wreck's cockpit from the side's base, on its landing gesture. */
  private async fly(slot: Slot, f: Flight): Promise<void> {
    const side = this.match.side(slot.team);
    const at = f.wreck.nodePosition('cockpit') ?? [f.wreck.x, 0, f.wreck.z];
    const craft = await this.world.spawn({
      model: this.karnov!,
      info: null,
      kind: 'vehicle',
      name: 'Karnov',
      team: slot.team,
      x: at[0],
      z: at[2],
      rotation: bearing(side.base, { x: at[0], z: at[2] }),
      paint: side.paint,
      stats: null,
      gunnery: 0,
    });
    craft.instance.radius = REACH_M;
    craft.play('land', 0, true);
    this.world.units.push(craft);
    f.craft = craft;
    this.world.battle.repairSound('salvage', at[0], at[2]);
  }

  private step(slot: Slot, f: Flight, dt: number): void {
    const craft = f.craft!;
    // The wreck finished off (or cleared away) before it was mended: the Karnov flies off.
    const lost = !f.wreck.salvage || !this.world.units.includes(f.wreck);
    switch (f.phase) {
      case 'landing':
        if (lost) return this.leave(f);
        if (!craft.clipDone) return;
        craft.play('hover', 0);
        f.phase = 'hover';
        f.timer = RECOVER_S;
        this.world.battle.repairSound('beam', craft.x, craft.z);
        return;
      case 'hover': {
        if (lost) return this.leave(f);
        f.timer -= dt;
        f.beamAt -= dt;
        if (f.beamAt <= 0) {
          f.beamAt = BEAM_S;
          const ground = Math.max(this.world.terrain.heightAt(craft.x, craft.z), 0);
          this.world.battle.recoveryBeam([craft.x, ground + BEAM_FROM_M, craft.z], [...f.wreck.instance.center]);
        }
        if (f.timer > 0) return;
        void this.recover(slot, f);
        return this.leave(f);
      }
      case 'leaving':
        if (!craft.clipDone) return;
        this.world.remove(craft);
        slot.flight = null;
        slot.readyAt = f.mended ? this.match.time + this.spec.cooldown : this.match.time;
        return;
    }
  }

  private leave(f: Flight): void {
    if (f.phase === 'leaving') return;
    f.phase = 'leaving';
    f.craft!.play('takeoff', 0, true);
    if (!f.mended) this.match.onSignal({ kind: 'recoveryFailed', team: f.craft!.team });
  }

  /** The wreck is mended: a mech of its type stands up in its place, for the side, in the squad it goes to. */
  private async recover(slot: Slot, f: Flight): Promise<void> {
    const wreck = f.wreck;
    const home = this.home(slot, wreck);
    const type = wreck.typeKey;
    if (!home || !type) return;
    f.mended = true;
    const side = this.match.side(slot.team);
    const unit = await this.world.spawnType(type, slot.team, wreck.x, wreck.z, wreck.rotation, home.own ? home.squad.spec.gunnery : this.spec.gunnery, side.paint);
    if (!unit) return;
    if (unit.combat && 'recoverFrom' in unit.combat && wreck.combat && 'recoverFrom' in wreck.combat) unit.combat.recoverFrom(wreck.combat);
    const tickets = home.own ? this.match.ticketCost(wreck) : 0;
    const from = wreck.team;
    this.match.forget(wreck);
    unit.squad = home.squad;
    home.squad.units.push(unit);
    if (home.squad.salvage) home.squad.spec.units.push(type);
    this.world.units.push(unit);
    unit.powerUp(wreck.fellBackward ? 'getupBack' : 'getupFront');
    side.tickets += tickets;
    // A squad that was wiped out isn't any more.
    home.squad.respawnAt = null;
    this.match.onSignal({ kind: 'recovered', team: slot.team, unit, squad: home.squad, from, tickets });
  }
}
