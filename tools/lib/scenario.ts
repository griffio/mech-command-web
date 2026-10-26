// Scenarios: game modes laid over a converted map (scenarios/*.json), written for this project, not taken from MC2.
// The converter reads them to know which extra units and props to export; the game reads them to set up the match.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScenarioPoint {
  name: string;
  /** World metres: x east, z south (the game's axes). */
  x: number;
  z: number;
}

export interface ScenarioSquad {
  name: string;
  role: string;
  /**
   * Unit types: a mech's stats file name (objects/<type>.csv, e.g. "atlas"), or an object file name for vehicles and
   * infantry (objects/<type>.fit, e.g. "centipede", "infantry").
   */
  units: string[];
  /** The pilots' gunnery: the chance to hit, percent. */
  gunnery: number;
  /** Whose voice it talks in over the radio: an MC2 pilot's sounds (sound/pilots/pilot1..pilot26). */
  voice?: string;
  /**
   * An APC that carries its soldiers on long moves (an object file name: "apc1", "heavyapc"). It comes with the squad,
   * and is replaced at a base like a member.
   */
  carrier?: string;
}

export interface ScenarioSide {
  team: number;
  name: string;
  /** Object file of the flag raised over the points it holds. */
  flag: string;
  /** Object file of the wall its supply trucks build ("davionlightwall"). */
  wall?: string;
  /** Where its squads start, reinforce and repair (world metres). */
  base: { x: number; z: number };
  /** Paint (base, highlight 1, highlight 2); the player's side wears the player's paint. */
  colors?: [string, string, string];
  squads: ScenarioSquad[];
}

/** Advance and Secure: points taken in order along a lane, a ticket pool per side. */
export interface Scenario {
  name: string;
  map: string;
  tickets: number;
  pointRadius: number;
  /** In order from the first side's end of the lane to the second's. */
  points: ScenarioPoint[];
  sides: ScenarioSide[];
  /** The appearance of the VTOL that airlifts infantry ("karnov"). */
  transport: string;
  /** Object file of the prop dug-in infantry shelter behind ("sandbagbunker"). */
  garrison: string;
  logistics?: ScenarioLogistics;
  /** Strikes each side can call in. */
  support?: ScenarioSupport;
}

/** A strike (or a sensor probe) a side calls in on a spot, then waits for again. */
export interface ScenarioStrike {
  /** MC2's strike (objects/<strike>.fit: its damage, reach and time to arrive): "artsml", "artbig"; "artsns" probes. */
  strike: string;
  /** Seconds into the match before the first, and between one and the next. */
  first: number;
  cooldown: number;
  /** The appearance of the aerospace fighter that flies the bombing run ("slayer"); none for artillery. */
  bomber?: string;
}

export interface ScenarioSupport {
  /** The appearance spinning on the spot until it lands ("airstrikemarker"). */
  marker: string;
  artillery?: ScenarioStrike;
  airstrike?: ScenarioStrike;
  /** A sensor probe: it picks up the enemy about the spot for a while (MC2's sensor strike). */
  sensor?: ScenarioStrike;
}

/** Supply trucks and the forward bases they build (all object file names). */
export interface ScenarioLogistics {
  /** The supply truck (its RefitPoints are the supply it carries). */
  truck: string;
  /** The forward base's headquarters (a tent): destroy it and the base is gone. */
  hq: string;
  /** The turret that guards a forward base. */
  turret: string;
  /** Sandbags about the base. */
  wall: string;
  /** The sensor tower that watches about a forward base. */
  tower?: string;
  /** Supply a forward base costs to build. */
  fobCost: number;
}

export function readScenarios(map: string, dir = 'scenarios'): Scenario[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Scenario).filter((s) => s.map === map);
}

/** Every unit type, prop object and bare appearance the scenarios use. */
export function scenarioNeeds(scenarios: Scenario[]): {
  units: string[];
  props: string[];
  appearances: string[];
  voices: string[];
  strikes: string[];
} {
  const units = new Set<string>();
  const props = new Set<string>();
  const appearances = new Set<string>();
  const voices = new Set<string>();
  const strikes = new Set<string>();
  for (const s of scenarios) {
    if (s.transport) appearances.add(s.transport.toLowerCase());
    if (s.support) {
      appearances.add(s.support.marker.toLowerCase());
      for (const call of [s.support.artillery, s.support.airstrike, s.support.sensor]) {
        if (!call) continue;
        strikes.add(call.strike.toLowerCase());
        if (call.bomber) appearances.add(call.bomber.toLowerCase());
      }
    }
    if (s.garrison) props.add(s.garrison.toLowerCase());
    if (s.logistics) {
      units.add(s.logistics.truck.toLowerCase());
      units.add(s.logistics.turret.toLowerCase());
      props.add(s.logistics.hq.toLowerCase());
      props.add(s.logistics.wall.toLowerCase());
      if (s.logistics.tower) props.add(s.logistics.tower.toLowerCase());
    }
    for (const side of s.sides) {
      props.add(side.flag.toLowerCase());
      if (side.wall) props.add(side.wall.toLowerCase());
      for (const squad of side.squads) {
        for (const u of squad.units) units.add(u.toLowerCase());
        if (squad.carrier) units.add(squad.carrier.toLowerCase());
        if (squad.voice) voices.add(squad.voice.toLowerCase());
      }
    }
  }
  return { units: [...units], props: [...props], appearances: [...appearances], voices: [...voices], strikes: [...strikes] };
}
