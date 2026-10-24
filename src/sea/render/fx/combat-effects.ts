// The look of MC2-style combat, from two primitives: particles (flashes, sparks, smoke, dust, fire) and beams (lasers,
// PPCs). Sizes are metres for 10-15 m mechs; colours linear; brightness 1 is sunlit white.
import { Rng } from '../../sim/rng';
import type { BeamRenderer } from './beams';
import { GLOW, PUFF, type ParticleSystem } from './particles';

type V3 = [number, number, number];

export class CombatEffects {
  private readonly rng = new Rng(0x6d633221);

  constructor(
    private readonly particles: ParticleSystem,
    private readonly beams: BeamRenderer,
  ) {}

  muzzleFlash(at: V3, size = 1, color: V3 = [1, 0.75, 0.4]): void {
    this.glow(at, 2.2 * size, 0.6 * size, 0.09, color, 6);
  }

  /** A laser: a straight beam that holds for a moment, and the spot it burns. */
  laser(from: V3, to: V3, color: V3, width = 0.6, hit = true): void {
    this.beams.add({ from, to, width, color, brightness: 3.5, life: 0.28, core: 14 });
    this.glow(from, 1.6 * width + 0.6, 0.4, 0.12, color, 5);
    if (hit) {
      this.glow(to, 2.5 * width + 1, 0.6, 0.2, color, 6);
      this.sparks(to, 6, color);
    }
  }

  /** A PPC: a thick blue-white bolt and a crackling flash where it lands. */
  ppc(from: V3, to: V3, hit = true): void {
    const blue: V3 = [0.45, 0.65, 1];
    this.beams.add({ from, to, width: 1.7, color: blue, brightness: 5, life: 0.32, core: 6 });
    this.glow(from, 2.4, 0.6, 0.15, blue, 7);
    if (hit) {
      this.glow(to, 5, 1.2, 0.3, blue, 8);
      this.sparks(to, 12, [0.6, 0.8, 1]);
    }
  }

  /** A shell or bullet in flight, as a moving streak of light that lasts until it arrives. */
  tracer(from: V3, to: V3, speed: number, color: V3 = [1, 0.8, 0.45], size = 0.7): void {
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    const life = len / speed;
    this.particles.spawn({
      x: from[0], y: from[1], z: from[2],
      vx: (d[0]! / len) * speed, vy: (d[1]! / len) * speed, vz: (d[2]! / len) * speed,
      size0: size, size1: size, life, r: color[0], g: color[1], b: color[2], alpha: 5, kind: GLOW, fadePow: 0.2,
    });
  }

  /** The head of a missile in flight (call each frame at its position) and the smoke it leaves. */
  missile(at: V3, smoke = true): void {
    this.glow(at, 1.1, 0.5, 0.06, [1, 0.7, 0.35], 6);
    if (smoke) {
      this.particles.spawn({
        x: at[0], y: at[1], z: at[2], vx: this.jitter(0.6), vy: 0.3 + this.jitter(0.3), vz: this.jitter(0.6),
        size0: 0.7, size1: 3.2, life: 1.4 + this.rng.next(), r: 0.82, g: 0.82, b: 0.8, alpha: 0.5, kind: PUFF,
        drag: 0.5, gravity: -0.4, wind: 0.3, spin: this.jitter(1), fadeIn: 0.05, fadePow: 1.4,
      });
    }
  }

  /** A hit on a unit: a flash, sparks and a puff of smoke, scaled to the damage (1 = an average shot). */
  hit(at: V3, scale = 1, color: V3 = [1, 0.65, 0.3]): void {
    this.glow(at, 2.8 * scale, 1, 0.14, color, 6);
    this.sparks(at, Math.round(6 + 6 * scale), [1, 0.75, 0.4]);
    this.smoke(at, 1.5 * scale, 4 * scale, 1.6, 0.35, [0.28, 0.27, 0.26]);
  }

  /** A miss landing on the ground: a burst of dust (or spray on the water). */
  groundHit(at: V3, scale = 1, onWater = false): void {
    const color: V3 = onWater ? [0.85, 0.9, 0.95] : [0.48, 0.4, 0.3];
    for (let i = 0; i < 4; i++) {
      this.particles.spawn({
        x: at[0], y: at[1] + 0.3, z: at[2], vx: this.jitter(3), vy: 4 + this.rng.next() * 5, vz: this.jitter(3),
        size0: 1.2 * scale, size1: 4.5 * scale, life: 1.2 + this.rng.next() * 0.8, r: color[0], g: color[1], b: color[2],
        alpha: onWater ? 0.6 : 0.5, kind: PUFF, drag: 1.4, gravity: 6, spin: this.jitter(1), fadePow: 1.6, dieAtSea: onWater,
      });
    }
  }

  /** A mech or vehicle blowing up: a fireball, debris sparks, and a column of black smoke. */
  explosion(at: V3, scale = 1): void {
    for (let i = 0; i < 6; i++) {
      const o: V3 = [at[0] + this.jitter(2 * scale), at[1] + this.rng.next() * 3 * scale, at[2] + this.jitter(2 * scale)];
      this.particles.spawn({
        x: o[0], y: o[1], z: o[2], vx: this.jitter(4), vy: 3 + this.rng.next() * 4, vz: this.jitter(4),
        size0: 4 * scale, size1: 11 * scale, life: 0.5 + this.rng.next() * 0.4, r: 1, g: 0.42, b: 0.12, alpha: 3.5, kind: GLOW,
        drag: 2, gravity: -2, fadePow: 1.2,
      });
    }
    this.sparks(at, 30, [1, 0.7, 0.35], 30);
    for (let i = 0; i < 8; i++) {
      this.smoke([at[0] + this.jitter(3 * scale), at[1] + 2 * scale, at[2] + this.jitter(3 * scale)], 4 * scale, 16 * scale, 4 + this.rng.next() * 3, 0.55, [0.12, 0.11, 0.1]);
    }
  }

  /** Flames and smoke off a wreck (call a few times a second while it burns). */
  burning(at: V3, intensity = 1): void {
    this.glow([at[0] + this.jitter(1.5), at[1] + this.rng.next() * 2, at[2] + this.jitter(1.5)], 2.5 * intensity, 1, 0.5, [1, 0.5, 0.18], 3);
    this.smoke(at, 2 * intensity, 9 * intensity, 4, 0.4, [0.13, 0.12, 0.11]);
  }

  private glow(at: V3, size0: number, size1: number, life: number, color: V3, brightness: number): void {
    this.particles.spawn({ x: at[0], y: at[1], z: at[2], size0, size1, life, r: color[0], g: color[1], b: color[2], alpha: brightness, kind: GLOW, fadePow: 1.5 });
  }

  private sparks(at: V3, count: number, color: V3, speed = 14): void {
    for (let i = 0; i < count; i++) {
      this.particles.spawn({
        x: at[0], y: at[1], z: at[2], vx: this.jitter(speed), vy: this.rng.next() * speed * 0.8, vz: this.jitter(speed),
        size0: 0.35, size1: 0.15, life: 0.35 + this.rng.next() * 0.4, r: color[0], g: color[1], b: color[2], alpha: 6, kind: GLOW,
        drag: 1.2, gravity: 9.8, dieAtSea: true,
      });
    }
  }

  private smoke(at: V3, size0: number, size1: number, life: number, alpha: number, color: V3): void {
    this.particles.spawn({
      x: at[0], y: at[1], z: at[2], vx: this.jitter(0.8), vy: 1.2 + this.rng.next(), vz: this.jitter(0.8),
      size0, size1, life, r: color[0], g: color[1], b: color[2], alpha, kind: PUFF,
      drag: 0.6, gravity: -0.6, wind: 0.25, spin: this.jitter(0.6), fadeIn: 0.15, fadePow: 1.3,
    });
  }

  private jitter(amount: number): number {
    return (this.rng.next() * 2 - 1) * amount;
  }
}
