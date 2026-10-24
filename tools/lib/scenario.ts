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
}

export interface ScenarioSide {
  team: number;
  name: string;
  /** Object file of the flag raised over the points it holds. */
  flag: string;
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
export function scenarioNeeds(scenarios: Scenario[]): { units: string[]; props: string[]; appearances: string[] } {
  const units = new Set<string>();
  const props = new Set<string>();
  const appearances = new Set<string>();
  for (const s of scenarios) {
    if (s.transport) appearances.add(s.transport.toLowerCase());
    if (s.garrison) props.add(s.garrison.toLowerCase());
    for (const side of s.sides) {
      props.add(side.flag.toLowerCase());
      for (const squad of side.squads) for (const u of squad.units) units.add(u.toLowerCase());
    }
  }
  return { units: [...units], props: [...props], appearances: [...appearances] };
}
