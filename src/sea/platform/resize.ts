/**
 * Keeps the canvas backing store at css size x devicePixelRatio x renderScale, clamped to the device limit
 * and to a pixel budget (a retina desktop canvas can be 13 M pixels, far more than an iGPU can shade).
 * The render-scale controller changes `renderScale` at runtime to hold frame rate.
 */
export class CanvasSizer {
  width = 1;
  height = 1;
  private scale = 1;
  private readonly observer: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly maxDimension: number,
    private readonly onResize: (width: number, height: number) => void,
    private readonly maxPixels = Number.POSITIVE_INFINITY,
  ) {
    this.observer = new ResizeObserver(() => this.apply());
    this.observer.observe(canvas);
    this.apply();
  }

  get renderScale(): number {
    return this.scale;
  }

  set renderScale(value: number) {
    const clamped = Math.min(Math.max(value, 0.3), 1);
    if (clamped === this.scale) return;
    this.scale = clamped;
    this.apply();
  }

  dispose(): void {
    this.observer.disconnect();
  }

  private apply(): void {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.max(1, Math.round(this.canvas.clientWidth * dpr * this.scale));
    let h = Math.max(1, Math.round(this.canvas.clientHeight * dpr * this.scale));
    const pixels = w * h;
    if (pixels > this.maxPixels) {
      const f = Math.sqrt(this.maxPixels / pixels);
      w = Math.max(1, Math.floor(w * f));
      h = Math.max(1, Math.floor(h * f));
    }
    w = Math.min(this.maxDimension, w);
    h = Math.min(this.maxDimension, h);
    if (w === this.width && h === this.height && this.canvas.width === w) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.onResize(w, h);
  }
}
