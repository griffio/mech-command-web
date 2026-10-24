// The MC2 sounds the game plays: pilots' radio lines, Betty's announcements, and interface effects.
//
// Radio messages follow sound/radio.csv (code/radio.cpp reads it): each message has a priority (0 most urgent), a
// shelf life in seconds (a line not yet said by then is dropped), a number of ways of saying it, and the line of the
// pilot's list (sound/<voice>.rsp) where its files start. Betty's lines are numbered by their order in sound/betty.rsp
// (the BETTY_* numbers of mclib/sounds.h).
import type { SourceData } from './srcdata.ts';

/** The radio messages the game uses, by MC2's names for them. */
export const RADIO = {
  ack: 'RADIO_ACK',
  targetAck: 'RADIO_TARGET_ACK',
  illegalOrder: 'RADIO_ILLEGAL_ORDER',
  moveBlocked: 'RADIO_MOVE_BLOCKED',
  underAttack: 'RADIO_UNDER_ATTACK',
  crippled: 'RADIO_CRIPPLED',
  refitDone: 'RADIO_REFIT_DONE',
  ejecting: 'RADIO_EJECTING',
  mechDead: 'RADIO_MECH_DEAD',
  vehicleDead: 'RADIO_VEHICLE_DEAD',
  buildingDead: 'RADIO_BUILDING_DEAD',
  sensorContact: 'RADIO_SENSOR_CONTACT',
} as const;
export type RadioMessage = keyof typeof RADIO;

/** Betty's lines the game uses, by their BETTY_* number (mclib/sounds.h). */
export const BETTY = {
  /** BETTY_MISSION_WON */
  won: 18,
  /** BETTY_MISSION_LOST */
  lost: 11,
  /** BETTY_OBJECTIVE_COMPLETE: a point taken. */
  objective: 4,
  /** BETTY_GUARDATTACK: a guard tower (a forward base's turret, or its tent) under attack. */
  baseAttacked: 40,
  /** BETTY_GUARDDESSTROYED */
  baseDestroyed: 41,
  /** BETTY_REPAIR_GONE: a repair vehicle (or bay) out of refit points, which is what supply is. */
  supplyGone: 51,
} as const;
export type BettyLine = keyof typeof BETTY;

/** Interface effects, by file under sound/ (named in sound/sound.rsp, MC2's effects list). */
export const EFFECTS = {
  select: 'sfx_int_select.wav',
  invalid: 'sfx_int_invalid.wav',
  on: 'sfx_int_click_on.wav',
  off: 'sfx_int_click_off.wav',
  place: 'sfx_int_map_place.wav',
  alarm: 'sfx_alarm.wav',
} as const;
export type Effect = keyof typeof EFFECTS;

/** sound.json: what the converter shipped, with paths relative to the sound folder. */
export interface SoundFile {
  radio: Record<RadioMessage, { priority: number; shelfLife: number }>;
  /** Each voice's ways of saying each message (a voice may lack some). */
  voices: Record<string, Partial<Record<RadioMessage, string[]>>>;
  betty: Partial<Record<BettyLine, string>>;
  effects: Partial<Record<Effect, string>>;
}

/** The lists the sound files are found by (fetched before the files themselves). */
export function soundLists(voices: string[]): string[] {
  return ['sound/radio.csv', 'sound/betty.rsp', ...voices.map((v) => `sound/${v}.rsp`)];
}

/**
 * What the game ships from the source data for these voices (pilot1..pilot26: sound/pilots/<voice>): the manifest,
 * and each file's path in the source by its path under the sound folder.
 */
export function soundSet(src: SourceData, voices: string[]): { manifest: SoundFile; files: Map<string, string> } {
  const files = new Map<string, string>();
  const ship = (rel: string): string | null => {
    const actual = src.actual(`sound/${rel.replace(/\\/g, '/')}`);
    if (!actual) return null;
    const out = actual.slice('sound/'.length).toLowerCase();
    files.set(out, actual);
    return out;
  };
  const lines = (rel: string) =>
    src.has(rel)
      ? src
          .text(rel)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const table = new Map<string, { priority: number; shelfLife: number; styles: number; first: number }>();
  for (const row of lines('sound/radio.csv').slice(1)) {
    const f = row.split(',');
    table.set(f[0]!, { priority: Number(f[1]), shelfLife: Number(f[2]), styles: Math.max(1, Number(f[4])), first: Number(f[9]) });
  }
  const radio = {} as SoundFile['radio'];
  for (const [key, name] of Object.entries(RADIO) as [RadioMessage, string][]) {
    const t = table.get(name);
    radio[key] = { priority: t?.priority ?? 4, shelfLife: t?.shelfLife || 3 };
  }
  const voiceFiles: SoundFile['voices'] = {};
  for (const voice of voices) {
    const list = lines(`sound/${voice}.rsp`);
    const said: Partial<Record<RadioMessage, string[]>> = {};
    for (const [key, name] of Object.entries(RADIO) as [RadioMessage, string][]) {
      const t = table.get(name);
      if (!t) continue;
      const ways = list
        .slice(t.first, t.first + t.styles)
        .map(ship)
        .filter((p): p is string => p !== null);
      if (ways.length) said[key] = ways;
    }
    voiceFiles[voice] = said;
  }
  const bettyList = lines('sound/betty.rsp');
  const betty: SoundFile['betty'] = {};
  for (const [key, n] of Object.entries(BETTY) as [BettyLine, number][]) {
    const p = bettyList[n] ? ship(bettyList[n]!) : null;
    if (p) betty[key] = p;
  }
  const effects: SoundFile['effects'] = {};
  for (const [key, file] of Object.entries(EFFECTS) as [Effect, string][]) {
    const p = ship(file);
    if (p) effects[key] = p;
  }
  return { manifest: { radio, voices: voiceFiles, betty, effects }, files };
}
