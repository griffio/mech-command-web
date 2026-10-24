// The MC2 sounds the game plays: pilots' radio lines, Betty's announcements, interface effects, weapons and
// explosions, and music.
//
// Radio messages follow sound/radio.csv (code/radio.cpp reads it): each message has a priority (0 most urgent), a
// shelf life in seconds (a line not yet said by then is dropped), a number of ways of saying it, and the line of the
// pilot's list (sound/<voice>.rsp) where its files start. Betty's lines are numbered by their order in sound/betty.rsp
// (the BETTY_* numbers of mclib/sounds.h).
//
// Effects are MC2's sound bites (sound/sound.snd: each bite's file, as a line of sound/sound.rsp, and its volume). A
// weapon's firing sound is the engine's: its Special FX ID (objects/compbas.csv) is a row of objects/effects.csv, whose
// object number names the bolt's file (objects/object2.rsp), whose FiringSoundFX is the bite. The bolts name no hit
// explosion (HitEffect=0), so a shot's impact is this project's pick of MC2's hit explosion objects (achit.fit,
// lrmhit.fit, ...) by the effects table's hit effect, each with its own bite. Units blow up with the effects table's mech
// and vehicle explosions, and critical hits with its critical hit explosion.
//
// Music is MC2's tunes, numbered as in mclib/sounds.h (sound/musicNN.wav): the mission's own (its scenarioTuneNum) to
// open, ambient while it's quiet, the combat tunes while the player's squads fight, and the win or lose tune.
import type { Fit } from './fit.ts';
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

/** Things that blow up, and the explosion each gets. */
export type Blast = 'mech' | 'vehicle' | 'structure' | 'crit';
const BLAST_EFFECTS: Record<Exclude<Blast, 'structure'>, string> = {
  mech: 'mech destruct explosion',
  vehicle: 'vehicle explosion',
  crit: 'mech critical hit explosion',
};
/** A building falling (sound.snd's "Building Collapses"): the forward base's tent. */
const STRUCTURE_BITE = 73;

/** The hit explosion object (objects/*.fit) for each of the effects table's hit effects. */
const HIT_OBJECTS: Record<string, string> = {
  generic_hit: 'laserhit.fit',
  flamer_hit: 'flamhit.fit',
  ppc_hit: 'ppchit.fit',
  missile_hit: 'srmhit.fit',
  gauss_hit: 'gshit.fit',
  mg_hit: 'mgunhit.fit',
  ac_10_hit: 'achit.fit',
  ac_20_hit: 'ac20hit.fit',
  tbolt_hit: 'thunderbolthit.fit',
  long_tom_hit: 'longtomhit.fit',
};

/** MC2's tunes the game plays, by number (mclib/sounds.h), besides the mission's own. */
export const MUSIC = {
  /** BACKGROUND_AMBIENT */
  calm: 21,
  /** COMBAT_TUNE_0..5 */
  combat: [14, 15, 16, 17, 18, 19],
  /** WIN_TUNE_0 */
  won: 8,
  /** LOSE_TUNE_0 */
  lost: 9,
} as const;

/** A sound bite: its file, and how loud MC2 plays it (0..1). */
export interface Cue {
  file: string;
  gain: number;
}

/** sound.json: what the converter shipped, with paths relative to the sound folder. */
export interface SoundFile {
  radio: Record<RadioMessage, { priority: number; shelfLife: number }>;
  /** Each voice's ways of saying each message (a voice may lack some). */
  voices: Record<string, Partial<Record<RadioMessage, string[]>>>;
  betty: Partial<Record<BettyLine, string>>;
  effects: Partial<Record<Effect, string>>;
  /** Each weapon's firing sound and impact, by its component id. */
  weapons: Record<string, { fire?: Cue; hit?: Cue }>;
  blasts: Partial<Record<Blast, Cue>>;
  /** The tunes shipped, by number (null when the converter had no ffmpeg to encode them); `mission` is each mission's. */
  music: { tracks: Record<string, string>; mission: Record<string, number>; calm: number; combat: number[]; won: number; lost: number } | null;
}

/** The lists the sound files are found by (fetched before the files themselves). */
export function soundLists(voices: string[]): string[] {
  return ['sound/radio.csv', 'sound/betty.rsp', 'sound/sound.snd', 'sound/sound.rsp', ...voices.map((v) => `sound/${v}.rsp`)];
}

/** A mission's own tune (its [Music] scenarioTuneNum), which opens it. */
export function missionTune(missionFit: Fit): number {
  return missionFit.num('Music', 'scenarioTuneNum', 0);
}

/**
 * What the game ships from the source data for these voices (pilot1..pilot26: sound/pilots/<voice>), weapons (by
 * component id; every weapon when not given) and a mission's tune: the manifest; each file to copy, by its path under
 * the sound folder; and each tune to encode, likewise.
 */
export function soundSet(
  src: SourceData,
  voices: string[],
  mission: { name: string; tune: number },
  weaponIds?: Set<number>,
): { manifest: SoundFile; files: Map<string, string>; tunes: Map<string, string> } {
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

  // Sound bites: sound.snd's [SoundBiteN] gives the line of sound.rsp and the volume.
  const rsp = lines('sound/sound.rsp');
  const snd = src.has('sound/sound.snd') ? src.fit('sound/sound.snd') : null;
  const bite = (n: number): Cue | null => {
    if (!snd || !n || !snd.has(`SoundBite${n}`)) return null;
    const name = rsp[snd.num(`SoundBite${n}`, 'soundId', -1)]?.trim();
    const file = name && !name.startsWith('<') ? ship(name) : null;
    return file ? { file, gain: snd.num(`SoundBite${n}`, 'volume', 1) } : null;
  };
  const objects = src.has('objects/object2.rsp') ? src.objectList() : [];
  const objectFit = (name: string | undefined): Fit | null => (name && src.has(`objects/${name}`) ? src.fit(`objects/${name}`) : null);
  const effectRows = lines('objects/effects.csv').map((l) => l.split(','));
  const weapons: SoundFile['weapons'] = {};
  for (const row of lines('objects/compbas.csv').slice(1).map((l) => l.split(','))) {
    if (!/Weapon$/.test(row[1] ?? '') || (weaponIds && !weaponIds.has(Number(row[0])))) continue;
    // The effects table's first line is its heading; its rows follow in order.
    const fx = effectRows[Number(row[21]) + 1];
    if (!fx) continue;
    const bolt = objectFit(objects[Number(fx[4])]);
    const fire = bolt ? bite(anyNum(bolt, 'FiringSoundFX')) : null;
    const hitObject = objectFit(HIT_OBJECTS[(fx[3] ?? '').trim().toLowerCase()]);
    const hit = hitObject ? bite(anyNum(hitObject, 'SoundEffectId')) : null;
    if (fire || hit) weapons[row[0]!] = { ...(fire && { fire }), ...(hit && { hit }) };
  }
  const blasts: SoundFile['blasts'] = {};
  for (const [key, effect] of Object.entries(BLAST_EFFECTS) as [Blast, string][]) {
    const fx = effectRows.find((r) => r[6]?.trim().toLowerCase() === effect);
    const explosion = fx ? objectFit(objects[Number(fx[4])]) : null;
    const cue = explosion ? bite(anyNum(explosion, 'SoundEffectId')) : null;
    if (cue) blasts[key] = cue;
  }
  const structure = bite(STRUCTURE_BITE);
  if (structure) blasts.structure = structure;

  // Tunes, encoded by the converter to AAC (the originals are MS ADPCM, which browsers don't all play).
  const tunes = new Map<string, string>();
  const tracks: Record<string, string> = {};
  for (const n of [mission.tune, MUSIC.calm, ...MUSIC.combat, MUSIC.won, MUSIC.lost]) {
    const from = src.actual(`sound/music${String(n).padStart(2, '0')}.wav`);
    if (!from) continue;
    const out = `music/music${String(n).padStart(2, '0')}.m4a`;
    tunes.set(out, from);
    tracks[n] = out;
  }
  const music = { tracks, mission: { [mission.name]: mission.tune }, ...MUSIC, combat: [...MUSIC.combat] };
  return { manifest: { radio, voices: voiceFiles, betty, effects, weapons, blasts, music }, files, tunes };
}

/** A key's number from whichever section of the file has it (MC2's object files put these in different ones). */
function anyNum(fit: Fit, key: string): number {
  for (const section of fit.sections.keys()) {
    const v = fit.num(section, key, NaN);
    if (Number.isFinite(v)) return v;
  }
  return 0;
}
