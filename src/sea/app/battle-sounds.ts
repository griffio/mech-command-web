// The battle's sounds: weapons firing, shots landing and units blowing up, each with MC2's sound for it
// (tools/lib/sound.ts says which) as loud as MC2 plays it. A sound fades with its distance from what the camera looks
// at, and with the camera's own distance (zoomed out, the fight is quieter), and is panned to the side of the screen
// it's on. The player hears what their side can see: an unseen enemy's guns are silent, though its shots landing on
// the player's units aren't. The player's squads fighting brings in the combat music.
import type { Camera } from '../render/camera';
import type { Battle, Noise } from './battle';
import type { Music } from './music';
import type { Sound } from './sound';
import { PLAYER_TEAM, type SeaUnit } from './world';

/** Full volume within this of the listener, silent beyond the second, metres (MC2's maxSoundDistance is 560 m). */
const NEAR_M = 120;
const FAR_M = 700;
/** How much of the camera's distance from what it looks at counts toward a sound's. */
const HEIGHT_SHARE = 0.4;
/** How far to one side a sound at the screen's edge is panned. */
const PAN = 0.75;
/** MC2 played no sound for a shot landing; here it does, a little under the shot's own. */
const IMPACT_SHARE = 0.7;

export class BattleSounds {
  private x = 0;
  private z = 0;
  private height = 0;
  private readonly ndc: [number, number] = [0, 0];

  constructor(
    battle: Battle,
    private readonly sound: Sound,
    private readonly music: Music | null,
    private readonly camera: Camera,
  ) {
    battle.onNoise = (n) => this.noise(n);
  }

  /** Where the player listens from: the point the camera looks at, and the camera's distance from it. */
  listen(target: readonly number[], distance: number): void {
    this.x = target[0]!;
    this.z = target[2]!;
    this.height = distance;
  }

  private noise(n: Noise): void {
    const file = this.sound.file;
    let cue;
    if (n.kind === 'fire') {
      if (own(n.by)) this.music?.fighting();
      if (!heard(n.by)) return;
      cue = file.weapons?.[n.weapon]?.fire;
    } else if (n.kind === 'impact') {
      if (own(n.on)) this.music?.fighting();
      if (!heard(n.on) && !heard(n.by)) return;
      cue = file.weapons?.[n.weapon]?.hit;
    } else {
      if (!heard(n.on)) return;
      cue = file.blasts?.[n.blast];
    }
    if (!cue) return;
    const d = Math.hypot(n.at[0] - this.x, n.at[2] - this.z, this.height * HEIGHT_SHARE);
    const gain = (d <= NEAR_M ? 1 : Math.max(0, 1 - (d - NEAR_M) / (FAR_M - NEAR_M)) ** 2) * (n.kind === 'impact' ? IMPACT_SHARE : 1);
    if (gain <= 0) return;
    const onScreen = this.camera.project(n.at[0], n.at[1], n.at[2], this.ndc);
    this.sound.effectAt(cue, gain, onScreen ? Math.max(-1, Math.min(1, this.ndc[0])) * PAN : 0);
  }
}

function own(u: SeaUnit): boolean {
  return u.team === PLAYER_TEAM;
}

/** The player's side hears its own units, and the enemies it can see. */
function heard(u: SeaUnit): boolean {
  return own(u) || !u.hidden;
}
