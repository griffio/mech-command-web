// A line of text in the middle of the screen, under the match bar: why an order was refused, alerts (a point being
// taken, a base under attack), news (a base built), and while a command waits for a tap on the ground, what to tap.
// A passing message shows for a few seconds over the waiting hint, then the hint comes back.

export type NoticeTone = 'info' | 'refused' | 'alert';

const SHOW_MS = 3500;

export class Notice {
  private hintText: string | null = null;
  private timer = 0;

  constructor(private readonly el: HTMLElement) {}

  show(text: string, tone: NoticeTone = 'info'): void {
    window.clearTimeout(this.timer);
    this.set(text, tone);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.set(this.hintText, 'info');
    }, SHOW_MS);
  }

  /** What to do next, shown until it's cleared (null); passing messages show over it. */
  hint(text: string | null): void {
    this.hintText = text;
    if (!this.timer) this.set(text, 'info');
  }

  private set(text: string | null, tone: NoticeTone): void {
    this.el.textContent = text ?? '';
    this.el.className = tone;
    this.el.hidden = !text;
  }
}
