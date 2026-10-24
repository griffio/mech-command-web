// MC2's sounds through Web Audio (sound/sound.json and its WAVs, written by tools/convert.ts): the squads' radio, Betty,
// and the interface's clicks and buzzes.
//
// The radio works as MC2's does (code/gamesound.cpp): one line at a time, the most urgent first, and a line not said
// within its shelf life is dropped. A squad already waiting to say something more urgent doesn't queue a lesser line,
// and a message somebody is already waiting to say isn't queued again (unless it's one of the most urgent). Betty
// speaks on the same channel, ahead of all but the most urgent radio.
//
// Browsers start sound only after the first tap or key, so nothing is queued before then.
import { ASSET_ROOT, loadJson, type BettyLine, type Effect, type RadioMessage, type SoundFile } from '../../assets';

const MAX_QUEUED = 8;
const BETTY_PRIORITY = 1;
const BETTY_SHELF_S = 8;
/** Quiet between one line and the next, seconds. */
const GAP_S = 0.2;
const RADIO_GAIN = 1;
const EFFECT_GAIN = 0.45;
const MUTED_KEY = 'mech-command:muted';

interface Line {
  /** Who says it: a squad, or Betty. */
  speaker: unknown;
  message: string;
  priority: number;
  /** performance.now() seconds after which it's no longer worth saying. */
  expires: number;
  file: string;
}

export class Sound {
  private readonly ctx = new AudioContext();
  private readonly out: GainNode;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly queue: Line[] = [];
  private speaking: Line | null = null;
  private source: AudioBufferSourceNode | null = null;
  private muted = false;
  /** Off while a perf survey runs. */
  enabled = true;

  /** The game's sounds, or null if the converter didn't write them (or the browser has no Web Audio). */
  static async load(): Promise<Sound | null> {
    if (typeof AudioContext === 'undefined') return null;
    const file = await loadJson<SoundFile>('sound/sound.json').catch(() => null);
    return file ? new Sound(file) : null;
  }

  private constructor(private readonly file: SoundFile) {
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    try {
      this.muted = localStorage.getItem(MUTED_KEY) === '1';
    } catch {
      // No storage (a private window): sound starts on.
    }
    this.out.gain.value = this.muted ? 0 : 1;
    // Play through the silent switch, as a game's sound should (Safari's Audio Session API, where there is one).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    // Sound may start on a tap, click or key: the first, and the first after iOS has suspended it (in the background).
    const unlock = () => {
      if (this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const type of ['pointerup', 'touchend', 'keydown']) window.addEventListener(type, unlock, true);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.out.gain.value = muted ? 0 : 1;
    try {
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    } catch {
      // Not remembered, then.
    }
    if (muted) {
      this.queue.length = 0;
      this.source?.stop();
    }
  }

  /** Fetch and decode every file now, so the first time a line is said it isn't late. */
  async preload(): Promise<void> {
    const f = this.file;
    const all = [
      ...Object.values(f.effects),
      ...Object.values(f.betty),
      ...Object.values(f.voices).flatMap((v) => Object.values(v).flat()),
    ].filter((p): p is string => !!p);
    for (const path of all) await this.buffer(path);
  }

  /** An interface effect, now. */
  effect(name: Effect): void {
    const path = this.file.effects[name];
    if (!path || !this.live) return;
    void this.buffer(path).then((b) => b && this.play(b, EFFECT_GAIN));
  }

  /** A squad says a radio message in its voice (one of the ways the voice has of saying it). */
  say(speaker: unknown, voice: string | undefined, message: RadioMessage): void {
    const ways = voice ? this.file.voices[voice]?.[message] : undefined;
    if (!ways?.length || !this.live) return;
    const { priority, shelfLife } = this.file.radio[message];
    this.enqueue({ speaker, message, priority, expires: now() + shelfLife, file: ways[Math.floor(Math.random() * ways.length)]! });
  }

  /** Betty announces something. */
  announce(line: BettyLine): void {
    const file = this.file.betty[line];
    if (!file || !this.live) return;
    this.enqueue({ speaker: 'betty', message: `betty:${line}`, priority: BETTY_PRIORITY, expires: now() + BETTY_SHELF_S, file });
  }

  private get live(): boolean {
    return this.enabled && !this.muted && this.ctx.state === 'running';
  }

  private enqueue(line: Line): void {
    for (const q of this.queue) {
      if ((q.speaker === line.speaker && line.priority > q.priority) || (q.priority > 1 && q.message === line.message)) return;
    }
    // Nor straight after itself.
    if (this.speaking && this.speaking.message === line.message && line.priority > 1) return;
    const at = this.queue.findIndex((q) => q.priority > line.priority);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, line);
    if (this.queue.length > MAX_QUEUED) this.queue.pop();
    this.next();
  }

  private next(): void {
    if (this.speaking) return;
    let line = this.queue.shift();
    while (line && line.expires < now()) line = this.queue.shift();
    if (!line) return;
    this.speaking = line;
    void this.buffer(line.file).then((b) => {
      if (!b || !this.live) {
        this.speaking = null;
        return this.next();
      }
      const source = this.play(b, RADIO_GAIN);
      this.source = source;
      source.onended = () => {
        this.source = null;
        window.setTimeout(() => {
          this.speaking = null;
          this.next();
        }, GAP_S * 1000);
      };
    });
  }

  private play(buffer: AudioBuffer, gain: number): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    source.connect(g).connect(this.out);
    source.start();
    return source;
  }

  private buffer(path: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(path);
    if (!b) {
      b = fetch(`${ASSET_ROOT}sound/${path}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: HTTP ${r.status}`))))
        .then((data) => this.ctx.decodeAudioData(data))
        .catch((e: unknown) => {
          console.warn('sound', e);
          return null;
        });
      this.buffers.set(path, b);
    }
    return b;
  }
}

function now(): number {
  return performance.now() / 1000;
}
