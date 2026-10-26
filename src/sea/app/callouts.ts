// What the player hears and reads as a match goes. Their squads answer orders over the radio in their pilots' voices
// (MC2's lines: acknowledged, can't do that, can't get there) and call out contacts, attacks, being pinned down, enemy
// strikes coming in, mines, crippling damage, kills and finished refits. Betty announces points taken, forward bases
// and the artillery piece (MC2's guard tower) under attack or lost, supply and mines run out, strikes ready, and the
// result, over the win or lose tune; the support desk says what's on its way. Refused orders and alerts also show in
// the middle of the screen, with MC2's buzz or alarm.
//
// MC2 says these lines when it does (code/tacordr.cpp, warrior.cpp, mech.cpp, mover.cpp); how often a squad repeats
// itself is this project's own choice, so that a long fight isn't a running commentary.
import type { RadioMessage, SupportLine } from '../../assets';
import type { Attacker } from './battle';
import { DEPLOY_NAMES, type Deploy } from './deploy';
import type { Fob } from './logistics';
import type { Match, MatchSignal } from './match';
import type { Music } from './music';
import type { Notice } from './notice';
import type { Sound } from './sound';
import { CALL_IN_NAMES } from './support';
import type { Squad } from './squads';
import { PLAYER_TEAM, type OrderReport, type SeaUnit, type World } from './world';

/** A squad says it's under attack when an attack starts: after this long without being hit, seconds. */
const UNDER_ATTACK_QUIET_S = 25;
/** An enemy squad that has been out of sight this long is a new contact when it's seen again, seconds. */
const CONTACT_FORGET_S = 40;
/** Seconds between one squad's reports of kills. */
const KILL_QUIET_S = 8;
/** Betty warns of a forward base under attack again after this long without it being hit, seconds. */
const BASE_ATTACK_QUIET_S = 30;
/** The alarm for a point being taken sounds again after this long without anyone taking it, seconds. */
const POINT_ALERT_QUIET_S = 30;
/** Armour and structure left below which a mech or vehicle reports itself crippled (it can again once refitted). */
const CRIPPLED = 0.35;
/** A squad that has lost this much reports when a refit has made it whole again. */
const REFIT_REPORT_BELOW = 0.95;
const WHOLE = 0.99;
/** A squad says it's pinned down at most this often, seconds; that it's hitting mines, likewise. */
const PINNED_QUIET_S = 20;
const MINES_QUIET_S = 15;
/** What the support desk says for each support unit on its way. */
const SUPPORT_LINE: Record<Deploy, SupportLine> = { artilleryPiece: 'artillery', scout: 'scout', minelayer: 'minelayer' };
const POLL_S = 0.25;

export class Callouts {
  private readonly lastHit = new Map<Squad, number>();
  private readonly lastSeen = new Map<Squad, number>();
  private readonly lastKill = new Map<Squad, number>();
  private readonly lastBaseAlert = new Map<Fob | SeaUnit, number>();
  private readonly lastPointAlert = new Map<number, number>();
  private readonly crippled = new Set<SeaUnit>();
  private readonly damaged = new Set<Squad>();
  private readonly pinned = new Set<Squad>();
  private readonly lastPinned = new Map<Squad, number>();
  private readonly lastMine = new Map<Squad, number>();
  private nextPoll = 0;

  constructor(
    private readonly world: World,
    private readonly match: Match,
    private readonly sound: Sound | null,
    private readonly music: Music | null,
    private readonly notice: Notice,
  ) {
    world.onOrders = (reports) => this.ordered(reports);
    world.onRefused = (why) => this.refused(why, null);
    world.onSelect = () => sound?.effect('select');
    world.battle.onHit = (u) => this.hit(u);
    match.onSignal = (s) => this.signal(s);
  }

  /** An order that can't be carried out: the notice, the buzz, and the squad saying so. */
  refused(why: string, squad: Squad | null, message: RadioMessage = 'illegalOrder'): void {
    this.notice.show(why, 'refused');
    this.sound?.effect('invalid');
    if (squad) this.say(squad, message);
  }

  /** Look over the player's side for what's worth a word: new contacts, crippled units, finished refits, points at risk. */
  update(): void {
    const t = this.match.time;
    if (t < this.nextPoll) return;
    this.nextPoll = t + POLL_S;
    this.contacts(t);
    this.condition(t);
    this.pointsAtRisk(t);
  }

  private ordered(reports: OrderReport[]): void {
    const refused = reports.filter((r) => r.refused);
    const done = reports.find((r) => !r.refused);
    if (refused.length) {
      // When none of the squads could, one of them says why.
      const r = refused[0]!;
      this.refused(refused.map((q) => q.refused).join(' · '), done ? null : r.squad, r.order === 'move' ? 'moveBlocked' : 'illegalOrder');
    }
    if (!done) return;
    if (done.order === 'move' || done.order === 'airlift' || done.order === 'build' || done.order === 'mines') this.sound?.effect('place');
    // MC2 answers an attack order either way, at even odds (tacordr.cpp).
    this.say(done.squad, done.order === 'attack' && Math.random() < 0.5 ? 'targetAck' : 'ack');
    const pinned = reports.filter((r) => !r.refused && r.order === 'move' && r.squad.pinned).map((r) => r.squad.name);
    if (pinned.length) this.notice.show(`${pinned.join(' and ')} ${pinned.length > 1 ? 'are' : 'is'} pinned down: moving once the fire slackens`);
  }

  private hit(u: SeaUnit): void {
    if (u.team !== PLAYER_TEAM) return;
    const t = this.match.time;
    const fob = this.match.logistics?.fobs.find((f) => f.hq === u || f.turret === u);
    // The artillery piece is MC2's guard tower: Betty has its lines.
    const guard = fob ?? (u.squad?.support === 'artilleryPiece' ? u : null);
    if (guard) {
      if (t - (this.lastBaseAlert.get(guard) ?? -Infinity) > BASE_ATTACK_QUIET_S) {
        this.notice.show(fob ? 'Your forward base is under attack' : 'Your artillery piece is under attack', 'alert');
        this.sound?.announce('baseAttacked');
      }
      this.lastBaseAlert.set(guard, t);
      return;
    }
    const q = u.squad;
    if (!q) return;
    // A squad sent to attack knows it's in a fight.
    if (t - (this.lastHit.get(q) ?? -Infinity) > UNDER_ATTACK_QUIET_S && q.order.kind !== 'attack') this.say(q, 'underAttack');
    this.lastHit.set(q, t);
  }

  private signal(s: MatchSignal): void {
    const own = 'team' in s && s.team === PLAYER_TEAM;
    switch (s.kind) {
      case 'destroyed':
        return this.destroyed(s.unit, s.by);
      case 'captured':
        if (!own) return;
        this.notice.show(`${s.point.name} captured`);
        return this.sound?.announce('objective');
      case 'lost':
        if (own) this.notice.show(`${s.point.name} lost`, 'alert');
        return;
      case 'ended':
        this.music?.ended(s.winner === PLAYER_TEAM);
        return this.sound?.announce(s.winner === PLAYER_TEAM ? 'won' : 'lost');
      case 'fobBuilt':
        if (!own) return;
        this.notice.show('Forward base ready');
        return this.sound?.effect('place');
      case 'built':
        if (!own) return;
        this.notice.show(s.what === 'turret' ? 'Turret ready' : 'Wall up: the enemy has to go round it, or shoot it down');
        return this.sound?.effect('place');
      case 'fobLost':
        if (!own) return this.notice.show('Enemy forward base destroyed');
        this.notice.show('Your forward base was destroyed', 'alert');
        return this.sound?.announce('baseDestroyed');
      case 'outOfSupply':
        if (!own) return;
        this.notice.show(s.squad ? `${s.squad.name} is empty: send it to base to fill up` : 'A forward base is out of supply', 'alert');
        return this.sound?.announce('supplyGone');
      case 'strikeReady':
        if (!own) return;
        this.notice.show(`${CALL_IN_NAMES[s.call]} ready`);
        return this.sound?.announce(s.call === 'sensor' ? 'probeReady' : 'strikeReady');
      case 'strikeCalled':
        return this.strikeCalled(s);
      case 'towerContact':
        if (!own) return;
        this.notice.show('Sensor tower contact: the red blips are what it picks up');
        return this.sound?.announce('towerContact');
      case 'towerLost':
        if (!own) return this.notice.show('Enemy sensor tower destroyed');
        this.notice.show('Your sensor tower was destroyed', 'alert');
        return this.sound?.announce('towerDestroyed');
      case 'deployCalled':
        if (!own) return;
        this.notice.show(`${DEPLOY_NAMES[s.what]} on its way by VTOL`);
        this.sound?.effect('place');
        return this.sound?.support(SUPPORT_LINE[s.what]);
      case 'deployed':
        if (!own) return;
        return this.notice.show(
          s.what === 'minelayer'
            ? `${s.squad.name} is down: select it and press Lay mines`
            : s.what === 'scout'
              ? `${s.squad.name} is down: send it ahead to see for the rest`
              : `${s.squad.name} is down: its Long Tom shells what your side sees within 180 m`,
        );
      case 'deployReady':
        if (own) this.notice.show(`${DEPLOY_NAMES[s.what]} ready`);
        return;
      case 'deployLost':
        if (!own) return;
        if (s.what !== 'artilleryPiece') return this.notice.show(`Your ${DEPLOY_NAMES[s.what].toLowerCase()} is lost`, 'alert');
        this.notice.show('Your artillery piece was destroyed', 'alert');
        return this.sound?.announce('baseDestroyed');
      case 'minesGone':
        if (!own) return;
        this.notice.show(`${s.squad.name} has laid its last mine: send it to base to load more`, 'alert');
        return this.sound?.announce('minesGone');
      case 'mineHit': {
        const q = s.unit.squad;
        if (!own || !q || this.match.time - (this.lastMine.get(q) ?? -Infinity) < MINES_QUIET_S) return;
        this.lastMine.set(q, this.match.time);
        return this.say(q, 'hittingMines');
      }
    }
  }

  /** The player's strike on its way; or the enemy's, coming down near the player's units. */
  private strikeCalled(s: Extract<MatchSignal, { kind: 'strikeCalled' }>): void {
    const name = CALL_IN_NAMES[s.call];
    if (s.call === 'sensor') {
      // The enemy's probes go unseen.
      if (s.team !== PLAYER_TEAM) return;
      this.notice.show('Sensor probe down: red blips show what it picks up inside the ring, which shrinks as it fades');
      this.sound?.effect('place');
      return this.sound?.support('probe');
    }
    if (s.team === PLAYER_TEAM) {
      this.notice.show(`${name} on the way: it hits everything inside the ring`);
      this.sound?.effect('place');
      return this.sound?.support('airstrike');
    }
    if (!s.seen) return;
    this.notice.show(`Incoming enemy ${name.toLowerCase()}! Get clear of the red ring`, 'alert');
    this.sound?.effect('alarm');
    // The squad of the player's nearest it says so, if it's in the way.
    const inReach = this.match
      .side(PLAYER_TEAM)
      .squads.map((q) => ({ q, c: q.centroid() }))
      .filter((e): e is { q: Squad; c: [number, number] } => e.c !== null && Math.hypot(e.c[0] - s.x, e.c[1] - s.z) <= s.reach)
      .sort((a, b) => Math.hypot(a.c[0] - s.x, a.c[1] - s.z) - Math.hypot(b.c[0] - s.x, b.c[1] - s.z));
    if (inReach[0]) this.say(inReach[0].q, 'underStrike');
  }

  private destroyed(unit: SeaUnit, by: Attacker): void {
    const q = unit.squad;
    if (unit.team === PLAYER_TEAM) {
      if (!q) return;
      // A mech's pilot ejects as it goes down (a helicopter's goes down with it).
      if (unit.kind === 'mech' && !unit.flies) this.say(q, 'ejecting');
      // Its soldiers all gone (an APC left over doesn't count); a support unit's loss has its own word.
      if (!unit.carrier && !q.riders.length && !q.support) this.notice.show(`${q.name} has been wiped out`, 'alert');
      return;
    }
    // Soldiers fall too often to report each one.
    if (by.team !== PLAYER_TEAM || !by.squad || unit.kind === 'infantry') return;
    const t = this.match.time;
    if (t - (this.lastKill.get(by.squad) ?? -Infinity) < KILL_QUIET_S) return;
    this.lastKill.set(by.squad, t);
    // A helicopter isn't a mech kill (code/warrior.cpp).
    this.say(by.squad, unit.kind === 'mech' && !unit.flies ? 'mechDead' : unit.kind === 'structure' ? 'buildingDead' : 'vehicleDead');
  }

  /**
   * An enemy squad seen (or picked up by sensors) for the first time in a while: the squad of ours nearest it reports
   * the contact.
   */
  private contacts(t: number): void {
    const sight = this.world.battle.seenBy(PLAYER_TEAM);
    const sensed = this.match.sensors.sensed(PLAYER_TEAM);
    const seen = { has: (u: SeaUnit) => sight.has(u) || sensed.has(u) };
    const own = this.match.side(PLAYER_TEAM).squads.filter((q) => q.alive.length);
    for (const side of this.match.sides) {
      if (side.team === PLAYER_TEAM) continue;
      for (const enemy of side.squads) {
        const spotted = enemy.alive.find((u) => seen.has(u));
        if (!spotted) continue;
        const last = this.lastSeen.get(enemy);
        this.lastSeen.set(enemy, t);
        if (last !== undefined && t - last < CONTACT_FORGET_S) continue;
        const nearest = own
          .map((q) => ({ q, d: Math.hypot(q.centroid()![0] - spotted.x, q.centroid()![1] - spotted.z) }))
          .sort((a, b) => a.d - b.d)[0];
        if (nearest) this.say(nearest.q, 'sensorContact');
      }
    }
  }

  /** Crippling damage, squads pinned down, and refits that have made a squad whole again. */
  private condition(t: number): void {
    for (const q of this.match.side(PLAYER_TEAM).squads) {
      if (q.pinned && !this.pinned.has(q)) {
        this.pinned.add(q);
        if (t - (this.lastPinned.get(q) ?? -Infinity) > PINNED_QUIET_S) {
          this.lastPinned.set(q, t);
          this.notice.show(`${q.name} is pinned down`, 'alert');
          this.say(q, 'underAttack');
        }
      } else if (!q.pinned) this.pinned.delete(q);
      let worst = 1;
      for (const u of q.alive) {
        const integrity = u.combat?.integrity ?? 1;
        worst = Math.min(worst, integrity);
        if (u.kind !== 'mech' && u.kind !== 'vehicle') continue;
        if (integrity < CRIPPLED && !this.crippled.has(u)) {
          this.crippled.add(u);
          this.say(q, 'crippled');
        } else if (integrity > CRIPPLED + 0.2) this.crippled.delete(u);
      }
      for (const u of this.crippled) if (!u.alive) this.crippled.delete(u);
      if (worst < REFIT_REPORT_BELOW) this.damaged.add(q);
      else if (worst >= WHOLE && q.missing === 0 && this.damaged.delete(q)) this.say(q, 'refitDone');
    }
  }

  /** The enemy standing on one of the player's points with nobody of theirs there: the alarm. */
  private pointsAtRisk(t: number): void {
    const enemy = this.match.sides.find((s) => s.team !== PLAYER_TEAM)!.team;
    const next = this.match.capturable(enemy);
    this.match.points.forEach((p, i) => {
      if (p.owner !== PLAYER_TEAM || i !== next || !p.present[enemy] || p.present[PLAYER_TEAM]) return;
      const last = this.lastPointAlert.get(i) ?? -Infinity;
      this.lastPointAlert.set(i, t);
      if (t - last <= POINT_ALERT_QUIET_S) return;
      this.notice.show(`The enemy is taking ${p.name}`, 'alert');
      this.sound?.effect('alarm');
    });
  }

  private say(q: Squad, message: RadioMessage): void {
    this.sound?.say(q, q.spec.voice, message);
  }
}
