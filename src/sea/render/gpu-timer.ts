export type GpuPhase = 'sky' | 'ocean' | 'shadow' | 'scene' | 'post';
const PHASES: readonly GpuPhase[] = ['sky', 'ocean', 'shadow', 'scene', 'post'];
const SLOTS = 3;

export type GpuTimes = Record<GpuPhase, number> & { total: number };

/**
 * Per-phase GPU time from timestamp queries (when the device has `timestamp-query`). Results arrive a few
 * frames late through a small ring of readback buffers, so it never stalls the frame. Times are smoothed.
 *
 * Phases that did not run in a frame (for example shadows with the sun down) are skipped when reading back,
 * and the corresponding time decays to zero.
 */
export class GpuTimer {
  readonly times: GpuTimes = { sky: 0, ocean: 0, shadow: 0, scene: 0, post: 0, total: 0 };

  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly slots: { buffer: GPUBuffer; busy: boolean; mask: number }[];
  private written = 0;
  private slot = -1;
  private seeded = false;

  private constructor(device: GPUDevice) {
    const count = PHASES.length * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count });
    this.resolveBuffer = device.createBuffer({
      label: 'timestamp-resolve',
      size: count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.slots = Array.from({ length: SLOTS }, (_, i) => ({
      buffer: device.createBuffer({
        label: `timestamp-read-${i}`,
        size: count * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      busy: false,
      mask: 0,
    }));
  }

  static create(device: GPUDevice): GpuTimer | null {
    return device.features.has('timestamp-query') ? new GpuTimer(device) : null;
  }

  private index(phase: GpuPhase): number {
    return PHASES.indexOf(phase) * 2;
  }

  /** Timestamp writes bracketing one whole compute pass. */
  compute(phase: GpuPhase): GPUComputePassTimestampWrites {
    this.written |= 1 << PHASES.indexOf(phase);
    return { querySet: this.querySet, beginningOfPassWriteIndex: this.index(phase), endOfPassWriteIndex: this.index(phase) + 1 };
  }

  /** Timestamp writes for a render pass: the start, the end, or (for single-pass phases) both. */
  render(phase: GpuPhase, edge: 'begin' | 'end' | 'both' = 'both'): GPURenderPassTimestampWrites {
    this.written |= 1 << PHASES.indexOf(phase);
    const w: GPURenderPassTimestampWrites = { querySet: this.querySet };
    if (edge !== 'end') w.beginningOfPassWriteIndex = this.index(phase);
    if (edge !== 'begin') w.endOfPassWriteIndex = this.index(phase) + 1;
    return w;
  }

  /** Call once at the end of encoding, before `finish()`. */
  resolve(encoder: GPUCommandEncoder): void {
    this.slot = this.slots.findIndex((s) => !s.busy);
    if (this.slot < 0) {
      this.written = 0;
      return; // all readbacks still in flight: skip this frame's sample
    }
    const s = this.slots[this.slot]!;
    encoder.resolveQuerySet(this.querySet, 0, PHASES.length * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, s.buffer, 0, PHASES.length * 16);
    s.busy = true;
    s.mask = this.written;
    this.written = 0;
  }

  /** Call right after `queue.submit`. Reads back asynchronously. */
  afterSubmit(): void {
    const index = this.slot;
    this.slot = -1;
    if (index < 0) return;
    const s = this.slots[index]!;
    void s.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const q = new BigUint64Array(s.buffer.getMappedRange().slice(0));
        s.buffer.unmap();
        this.accept(q, s.mask);
        s.busy = false;
      },
      () => {
        s.busy = false;
      },
    );
  }

  private accept(q: BigUint64Array, mask: number): void {
    const blend = this.seeded ? 0.15 : 1;
    let total = 0;
    PHASES.forEach((phase, i) => {
      let ms = 0;
      if (mask & (1 << i)) {
        const begin = q[i * 2]!;
        const end = q[i * 2 + 1]!;
        // Zero or reversed stamps mean the pass did not write (or the counter wrapped): ignore.
        if (end > begin) ms = Number(end - begin) / 1e6;
      }
      this.times[phase] += (ms - this.times[phase]) * blend;
      total += this.times[phase];
    });
    this.times.total = total;
    this.seeded = true;
  }
}
