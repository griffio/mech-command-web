// The music: MC2's tunes (sound/music/*.m4a, encoded by tools/convert.ts from sound/musicNN.wav). The mission's own
// tune opens the match; after it come the ambient tune while it's quiet, and the combat tunes one after another while
// the player's squads fight. A fight starting fades the ambient tune over to a combat tune at once; once a fight has
// been over a while, the combat tune playing finishes before the ambient comes back. The win or lose tune ends it.
// MC2 left its music to each mission's script, so when each plays is this project's rule.
//
// A tune is decoded whole (a minute of stereo is some 20 MB), and only the one playing and the one coming are kept.
import type { SoundFile } from '../../assets';
import type { Sound } from './sound';

const FADE_S = 1.5;
/** The combat tunes carry on until this long after the player's squads last fought, seconds. */
const FIGHT_LINGERS_S = 25;
const MUSIC_KEY = 'mech-command:music';

type Mode = 'mission' | 'calm' | 'combat' | 'ended';

export class Music {
  private playing: { source: AudioBufferSourceNode; gain: GainNode; tune: number } | null = null;
  /** What's playing (null before the match's music has started). */
  private mode: Mode | null = null;
  /** The tune being fetched to play next (a newer choice replaces it). */
  private wanted: number | null = null;
  private lastFight = -Infinity;
  private combatIndex = 0;
  private readonly decoded = new Map<number, Promise<AudioBuffer | null>>();
  /** Tunes that wouldn't load (not tried again). */
  private readonly broken = new Set<number>();
  private on = true;

  constructor(
    private readonly sound: Sound,
    private readonly set: NonNullable<SoundFile['music']>,
    /** The mission's own tune, which opens it. */
    private readonly missionTune: number,
  ) {
    try {
      this.on = localStorage.getItem(MUSIC_KEY) !== '0';
    } catch {
      // No storage: music starts on.
    }
  }

  get isOn(): boolean {
    return this.on;
  }

  setOn(on: boolean): void {
    this.on = on;
    try {
      localStorage.setItem(MUSIC_KEY, on ? '1' : '0');
    } catch {
      // Not remembered, then.
    }
    if (!on) this.stop();
  }

  /** The player's squads are fighting: the combat tunes. */
  fighting(): void {
    this.lastFight = this.sound.ctx.currentTime;
    if (this.mode === 'calm' && this.audible) {
      this.mode = 'combat';
      this.play(this.nextCombat());
    }
  }

  /** The match is over: the win or lose tune, once. */
  ended(won: boolean): void {
    this.mode = 'ended';
    if (this.audible) this.play(won ? this.set.won : this.set.lost);
  }

  /** Start once sound can be heard, and stop while it can't (muted, or paused for a survey). */
  update(): void {
    if (!this.audible) {
      if (this.playing || this.wanted !== null) this.stop();
      return;
    }
    if (this.playing || this.wanted !== null) return;
    if (this.mode !== null) return this.next();
    this.mode = 'mission';
    this.play(this.set.tracks[this.missionTune] ? this.missionTune : this.set.calm);
  }

  private get audible(): boolean {
    return this.on && this.sound.live;
  }

  /** A tune has ended: the next, by whether the player's squads have been fighting. */
  private next(): void {
    if (this.mode === 'ended' || !this.audible) return;
    const fighting = this.sound.ctx.currentTime - this.lastFight < FIGHT_LINGERS_S;
    this.mode = fighting ? 'combat' : 'calm';
    this.play(fighting ? this.nextCombat() : this.set.calm);
  }

  private nextCombat(): number {
    return this.set.combat[this.combatIndex++ % this.set.combat.length]!;
  }

  /** Fade over to a tune (once it's fetched and decoded). */
  private play(tune: number): void {
    if (!this.set.tracks[tune] || this.broken.has(tune)) return;
    this.wanted = tune;
    void this.load(tune).then((buffer) => {
      if (this.wanted !== tune) return;
      this.wanted = null;
      if (!buffer) this.broken.add(tune);
      if (!buffer || !this.audible) return;
      this.fadeOut();
      const ctx = this.sound.ctx;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_S);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain).connect(this.sound.musicOut);
      source.start();
      const entry = { source, gain, tune };
      this.playing = entry;
      source.onended = () => {
        if (this.playing !== entry) return;
        this.playing = null;
        this.next();
      };
      // Keep only this tune decoded.
      for (const t of this.decoded.keys()) if (t !== tune) this.decoded.delete(t);
    });
  }

  private load(tune: number): Promise<AudioBuffer | null> {
    let b = this.decoded.get(tune);
    if (!b) {
      b = this.sound.decode(this.set.tracks[tune]!);
      this.decoded.set(tune, b);
    }
    return b;
  }

  private fadeOut(): void {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    const t = this.sound.ctx.currentTime;
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.setValueAtTime(p.gain.gain.value, t);
    p.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
    p.source.stop(t + FADE_S);
  }

  private stop(): void {
    this.wanted = null;
    this.fadeOut();
  }
}
