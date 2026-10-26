// Repairs in the field, after MC2's repair vehicle (objects/repairtruck.fit, called in by VTOL: deploy.ts) and its refit
// order (code/tacordr.cpp TACTICAL_ORDER_REFIT; Mover::refit, code/mover.cpp). Sent to a mech, the truck drives up to
// within 30 m of it (gamesys RefitRange); the mech powers down, and 3 s later the truck opens up (its deploy gesture)
// and works on it a cycle a second (RefitTime), each cycle spending up to 30 of its refit points (RefitAmount): a third
// on armour and structure, a third on ammunition (sim/combat.ts fieldRefit). The mech powers up again once it's whole,
// or the truck has run out of points, or either of them is given another order. MC2 mends mechs only, and neither arms
// they've lost nor components a critical hit has taken out.
//
// This project's rules: a truck is sent to a squad and sees to each of its mechs in turn, the nearest first (following
// the squad if it's on the move), until another order to either squad calls it off; and an empty truck loads its points
// again at a base (MC2's is spent), as a minelayer loads mines.
import type { Match } from './match';
import type { Squad, SquadOrder } from './squads';
import type { SeaUnit, World } from './world';

/** The truck works on a mech within this of it, metres (gamesys RefitRange). */
const REFIT_RANGE_M = 30;
/** It stops this far short of the mech, metres. */
const STAND_OFF_M = 14;
/** Seconds between the mech powering down and the work starting (code/tacordr.cpp), and between cycles (RefitTime). */
const POWER_DOWN_S = 3;
const CYCLE_S = 1;
/** Refit points a cycle can use (gamesys RefitAmount). */
const CYCLE_POINTS = 30;
/** Seconds between the truck's looks for a way to a mech that has moved. */
const REROUTE_S = 2;
/** Routes it tries to a mech standing still before it gives up on it (it stands where a truck can't get near). */
const TRIES = 3;

interface Job {
  truck: Squad;
  target: Squad;
  /** Each squad's order when the truck was sent: another to either calls the job off. */
  order: SquadOrder;
  targetOrder: SquadOrder;
  /** The mech it's seeing to, and how far along: driving to it, waiting for it to power down, at work. */
  mech: SeaUnit | null;
  stage: 'drive' | 'powerDown' | 'work';
  timer: number;
  rerouteAt: number;
  /** Routes it has tried to the mech while it stood still. */
  tries: number;
  /** Mechs it couldn't get to (it passes over them). */
  unreachable: Set<SeaUnit>;
  /** Mechs it has mended. */
  mended: number;
}

/** What happened, for the radio and the notices. */
export type RepairSignal =
  /** One of the squad's mechs is mended. */
  | { kind: 'repaired'; team: number; squad: Squad; unit: SeaUnit }
  /** The truck has seen to every mech of the squad's it could (`mended` of them). */
  | { kind: 'repairsDone'; team: number; squad: Squad; truck: Squad; mended: number }
  /** The truck has run out of refit points (`squad` was being mended). */
  | { kind: 'repairGone'; team: number; squad: Squad; truck: Squad };

export class Repairs {
  private readonly jobs = new Map<Squad, Job>();

  constructor(
    private readonly world: World,
    private readonly match: Match,
  ) {}

  /** The mechs of a squad's that a repair truck can mend: on the ground, out of their APC, with something to make up. */
  mendable(squad: Squad): SeaUnit[] {
    return squad.alive.filter((u) => u.kind === 'mech' && !u.flies && !u.embarked && u.combat && 'needsRefit' in u.combat && u.combat.needsRefit);
  }

  /** Why a repair vehicle's squad can't be sent to mend another squad just now, or null if it can. */
  whyNot(truck: Squad, target: Squad): string | null {
    const u = truck.repairer;
    if (!u) return `${truck.name} has no repair vehicle`;
    if (truck.airborne) return `${truck.name} is with the Karnov`;
    if ((u.repairPoints ?? 0) < 1) return `${truck.name} has no refit points left: send it to base to load more`;
    if (target.team !== truck.team) return 'the repair vehicle mends only your own mechs';
    if (!target.alive.some((m) => m.kind === 'mech' && !m.flies)) return `the repair vehicle mends mechs only, and ${target.name} has none`;
    if (!this.mendable(target).length) return `${target.name} needs no repairs (lost arms stay lost)`;
    const grid = this.world.gridFor(u);
    const c = target.centroid()!;
    if (grid && !grid.connected(u.x, u.z, c[0], c[1])) return `${truck.name} can't get to ${target.name}`;
    return null;
  }

  /** Send a repair vehicle's squad to mend another squad's mechs; why not, if it can't. */
  order(truck: Squad, target: Squad): string | null {
    const why = this.whyNot(truck, target);
    if (why) return why;
    this.end(truck);
    truck.hold();
    const order: SquadOrder = { kind: 'repair', squad: target };
    truck.order = order;
    this.jobs.set(truck, { truck, target, order, targetOrder: target.order, mech: null, stage: 'drive', timer: 0, rerouteAt: 0, tries: 0, unreachable: new Set(), mended: 0 });
    return null;
  }

  /** The squad its repair vehicle is mending, if it's at it. */
  mending(truck: Squad): Squad | null {
    return this.jobs.get(truck)?.target ?? null;
  }

  /** A repair vehicle is seeing to this squad. */
  beingMended(squad: Squad): boolean {
    return [...this.jobs.values()].some((j) => j.target === squad);
  }

  update(dt: number): void {
    for (const job of [...this.jobs.values()]) this.step(job, dt);
  }

  private step(job: Job, dt: number): void {
    const truck = job.truck.repairer;
    // Another order to either squad, or the truck lost or airlifted, calls it off.
    if (!truck || job.truck.order !== job.order || job.target.order !== job.targetOrder || job.truck.airborne) return this.end(job.truck);
    if ((truck.repairPoints ?? 0) <= 0) {
      this.match.onSignal({ kind: 'repairGone', team: job.truck.team, squad: job.target, truck: job.truck });
      return this.end(job.truck);
    }
    let mech = job.mech;
    // The mech it was seeing to is gone.
    if (mech && (!mech.alive || mech.embarked)) {
      this.release(job);
      mech = null;
    }
    if (!mech) {
      mech = this.next(job, truck);
      if (!mech) {
        this.match.onSignal({ kind: 'repairsDone', team: job.truck.team, squad: job.target, truck: job.truck, mended: job.mended });
        return this.end(job.truck);
      }
      Object.assign(job, { mech, stage: 'drive', timer: 0, rerouteAt: 0, tries: 0 });
    }
    job.truck.task = `mending ${mech.name} (${job.target.name})`;
    switch (job.stage) {
      case 'drive': {
        const d = Math.hypot(mech.x - truck.x, mech.z - truck.z);
        // It waits for a mech on the move to stop.
        if (d <= REFIT_RANGE_M && !mech.route.length) {
          truck.stop();
          mech.powerDown();
          job.stage = 'powerDown';
          job.timer = POWER_DOWN_S;
          return;
        }
        if (d <= REFIT_RANGE_M || this.match.time < job.rerouteAt) return;
        job.rerouteAt = this.match.time + REROUTE_S;
        const end = truck.route[truck.route.length - 1];
        if (end && Math.hypot(end[0] - mech.x, end[1] - mech.z) <= REFIT_RANGE_M - 4) return;
        if (!mech.route.length && !truck.route.length) job.tries++;
        if (job.tries > TRIES || !this.driveTo(truck, mech)) {
          job.unreachable.add(mech);
          job.mech = null;
        }
        return;
      }
      case 'powerDown':
        job.timer -= dt;
        if (job.timer > 0) return;
        job.stage = 'work';
        job.timer = CYCLE_S;
        truck.play('deploy', 0.3, true);
        this.world.battle.repairSound('repair', mech.x, mech.z);
        return;
      case 'work': {
        job.timer -= dt;
        if (job.timer > 0) return;
        job.timer += CYCLE_S;
        const combat = mech.combat;
        if (!combat || !('fieldRefit' in combat)) return this.release(job);
        const used = combat.fieldRefit(truck.repairPoints ?? 0, CYCLE_POINTS);
        truck.repairPoints = Math.max(0, (truck.repairPoints ?? 0) - used);
        if (combat.needsRefit && truck.repairPoints > 0) return;
        if (!combat.needsRefit) {
          job.mended++;
          this.match.onSignal({ kind: 'repaired', team: mech.team, squad: job.target, unit: mech });
        }
        this.release(job);
        return;
      }
    }
  }

  /** The nearest of the squad's mechs that needs mending, that it can get to. */
  private next(job: Job, truck: SeaUnit): SeaUnit | null {
    const left = this.mendable(job.target).filter((u) => !job.unreachable.has(u));
    left.sort((a, b) => Math.hypot(a.x - truck.x, a.z - truck.z) - Math.hypot(b.x - truck.x, b.z - truck.z));
    return left[0] ?? null;
  }

  /** Route the truck to stand by the mech, on its own side of it. False if there's no way there. */
  private driveTo(truck: SeaUnit, mech: SeaUnit): boolean {
    const d = Math.hypot(truck.x - mech.x, truck.z - mech.z) || 1;
    const [x, z] = this.world.openNear(mech.x + ((truck.x - mech.x) / d) * STAND_OFF_M, mech.z + ((truck.z - mech.z) / d) * STAND_OFF_M, truck.moveClass);
    const grid = this.world.gridFor(truck);
    const route = grid ? grid.findPath(truck.x, truck.z, x, z) : [[x, z] as [number, number]];
    if (!route) return false;
    truck.walkTo(route);
    return true;
  }

  /** Done with the mech it was seeing to: the mech powers up, the truck closes up. */
  private release(job: Job): void {
    const mech = job.mech;
    if (mech?.alive && mech.power !== 'on') mech.powerUp();
    if (job.stage === 'work') job.truck.repairer?.play('deploy', 0.3, true, true);
    job.mech = null;
    job.stage = 'drive';
  }

  /** Call off a truck's job (if it has one), and leave it holding where it is. */
  private end(truck: Squad): void {
    const job = this.jobs.get(truck);
    if (!job) return;
    this.release(job);
    this.jobs.delete(truck);
    truck.task = null;
    if (truck.order === job.order) truck.order = { kind: 'hold' };
  }
}
