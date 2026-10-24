// An RTS camera over the map for the dreadnought Camera: it circles a point on the ground.
//   Mouse: left-drag pans, right-drag (or shift-drag) turns and tilts, the wheel zooms.
//   Touch: one finger pans, two fingers pinch to zoom, twist to turn and slide up or down together to tilt.
import type { Camera } from '../render/camera';

export interface OrbitLimits {
  minDistance: number;
  maxDistance: number;
  minPitchDeg: number;
  maxPitchDeg: number;
  /** The target stays within this square about the origin (metres). */
  halfExtent: number;
}

export class OrbitControls {
  /** The point looked at, world metres (x east, y up, z south). */
  target: [number, number, number];
  distance: number;
  /** Compass heading the camera looks along (0 north, 90 east). */
  yawDeg: number;
  /** How far the camera looks down, degrees. */
  pitchDeg: number;
  /** Ground height under a point, so the target rides the land. */
  groundAt: (x: number, z: number) => number = () => 0;

  private readonly pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
  private pinch: { distance: number; angle: number; midY: number } | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: Camera,
    init: { target: [number, number, number]; distance: number; yawDeg: number; pitchDeg: number },
    private readonly limits: OrbitLimits,
  ) {
    this.target = [...init.target];
    this.distance = init.distance;
    this.yawDeg = init.yawDeg;
    this.pitchDeg = init.pitchDeg;
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Place the camera for this frame. */
  update(): void {
    const l = this.limits;
    this.distance = clamp(this.distance, l.minDistance, l.maxDistance);
    this.pitchDeg = clamp(this.pitchDeg, l.minPitchDeg, l.maxPitchDeg);
    this.target[0] = clamp(this.target[0], -l.halfExtent, l.halfExtent);
    this.target[2] = clamp(this.target[2], -l.halfExtent, l.halfExtent);
    this.target[1] = Math.max(this.groundAt(this.target[0], this.target[2]), 0);
    const yaw = rad(this.yawDeg);
    const pitch = rad(this.pitchDeg);
    // Forward is (sin yaw cos pitch, -sin pitch, -cos yaw cos pitch); the camera stands back along it.
    const back = this.distance;
    this.camera.position = [
      this.target[0] - Math.sin(yaw) * Math.cos(pitch) * back,
      this.target[1] + Math.sin(pitch) * back,
      this.target[2] + Math.cos(yaw) * Math.cos(pitch) * back,
    ];
    this.camera.lookAt(this.target[0], this.target[1], this.target[2]);
  }

  /** Metres of ground one screen pixel spans at the target. */
  private metresPerPixel(): number {
    return (2 * this.distance * Math.tan(rad(this.camera.fovYDeg) / 2)) / Math.max(this.element.clientHeight, 1);
  }

  private pan(dx: number, dy: number): void {
    const s = this.metresPerPixel();
    const yaw = rad(this.yawDeg);
    // Screen right is (cos yaw, sin yaw) on the ground; screen up is the heading (sin yaw, -cos yaw). The ground follows
    // the finger, so the target moves the other way: back along right, and forward along the heading as the finger goes down.
    this.target[0] += (-dx * Math.cos(yaw) + dy * Math.sin(yaw)) * s;
    this.target[2] += (-dx * Math.sin(yaw) - dy * Math.cos(yaw)) * s;
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.element.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    this.pinch = this.pointers.size === 2 ? this.pinchState() : null;
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      if (p.button === 2 || p.shift) {
        this.yawDeg -= dx * 0.25;
        this.pitchDeg += dy * 0.2;
      } else {
        this.pan(dx, dy);
      }
      return;
    }
    if (this.pointers.size === 2 && this.pinch) {
      const now = this.pinchState();
      this.distance *= this.pinch.distance / Math.max(now.distance, 1);
      this.yawDeg -= ((now.angle - this.pinch.angle) * 180) / Math.PI;
      this.pitchDeg += (now.midY - this.pinch.midY) * 0.2;
      this.pinch = now;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size === 2 ? this.pinchState() : null;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance *= Math.exp(e.deltaY * 0.0012);
  };

  private pinchState(): { distance: number; angle: number; midY: number } {
    const [a, b] = [...this.pointers.values()];
    return {
      distance: Math.hypot(b!.x - a!.x, b!.y - a!.y),
      angle: Math.atan2(b!.y - a!.y, b!.x - a!.x),
      midY: (a!.y + b!.y) / 2,
    };
  }
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
