/**
 * Dynamic resolution: keeps the frame rate at the display's rate by scaling the render resolution.
 *
 * It trusts only the frame time. GPU timestamp queries were tried and rejected: on Apple's tile-based GPUs the
 * per-pass timestamps overlap, so their sum exceeded the frame time while the display held 60 fps, and the
 * controller dutifully crushed the resolution to its floor. Frame time cannot lie that way.
 *
 * The catch with frame time on a vsync-locked display is that it never shows headroom (it cannot go below the
 * refresh interval). So after a quiet spell the controller *probes* one step up, keeps it if the frame rate
 * holds, and undoes it (and probes less often) if not. Cost is roughly proportional to pixel count (scale
 * squared), so reductions use the square root of the overrun.
 */
export class RenderScaleController {
  scale: number;
  /** Number of resolution changes so far (shown on the HUD to expose oscillation). */
  changes = 0;

  private sumMs = 0;
  private frames = 0;
  private windowSeconds = 0;
  private cooldown = 0;
  private quietWindows = 0;
  private probeEvery = 3;
  private probing = false;
  private beforeProbeMs = 0;

  constructor(
    private readonly minScale = 0.5,
    private readonly maxScale = 1,
    initial = 1,
    private readonly targetMs = 15,
    private readonly windowLength = 1,
  ) {
    this.scale = Math.min(Math.max(initial, minScale), maxScale);
  }

  /** Feed one frame. Returns the new scale when it changed, otherwise null. */
  sample(frameMs: number, dtSeconds: number): number | null {
    // A frame of a second or more was the tab in the background or a dialog, not the renderer: it says nothing about the cost of a
    // frame, so the window starts again. A shorter hitch (a shader compiled, the garbage collected) is capped, so that one of them
    // cannot pull a whole window's average over the line.
    if (!(frameMs < 1000)) {
      this.sumMs = 0;
      this.frames = 0;
      this.windowSeconds = 0;
      return null;
    }
    this.sumMs += Math.min(Math.max(frameMs, 0), this.targetMs * 4);
    this.frames++;
    this.windowSeconds += dtSeconds;
    if (this.windowSeconds < this.windowLength) return null;

    const avg = this.sumMs / this.frames;
    this.sumMs = 0;
    this.frames = 0;
    this.windowSeconds = 0;

    // A probe that made frames slower is undone immediately, and probing backs off.
    if (this.probing) {
      this.probing = false;
      // Failed means: slow enough that the normal rule would reduce anyway, and worse than before the probe.
      if (avg > this.targetMs * 1.15 && avg > this.beforeProbeMs * 1.03) {
        this.probeEvery = Math.min(this.probeEvery * 2, 48);
        return this.set(this.scale - 0.05, 2);
      }
      this.probeEvery = Math.max(Math.floor(this.probeEvery / 2), 3); // it held: keep climbing quickly
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return null;
    }

    if (avg > this.targetMs * 1.15) {
      const factor = Math.min(Math.max(Math.sqrt(this.targetMs / avg), 0.75), 0.97);
      this.quietWindows = 0;
      return this.set(this.scale * factor, 2);
    }
    if (this.scale >= this.maxScale) return null;

    // A display faster than the target shows plain headroom.
    if (avg < this.targetMs * 0.75) {
      this.quietWindows = 0;
      return this.set(this.scale * 1.08, 2);
    }
    this.quietWindows++;
    if (this.quietWindows >= this.probeEvery) {
      this.quietWindows = 0;
      this.probing = true;
      this.beforeProbeMs = avg;
      return this.set(this.scale + 0.05, 1);
    }
    return null;
  }

  private set(value: number, cooldownWindows: number): number | null {
    const next = Math.round(Math.min(Math.max(value, this.minScale), this.maxScale) * 20) / 20;
    if (next === this.scale) {
      this.probing = false;
      return null;
    }
    this.scale = next;
    this.cooldown = cooldownWindows;
    this.changes++;
    return next;
  }
}
