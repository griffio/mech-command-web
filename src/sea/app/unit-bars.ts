// Health bars over units, as HTML laid over the canvas: shown for the player's selection, the unit being looked at,
// and any unit that has taken damage. The bar is armour and structure left (a vehicle's weakest side).
import type { Camera } from '../render/camera';
import { PLAYER_TEAM, type SeaUnit, type World } from './world';

export class UnitBars {
  private readonly bars = new Map<SeaUnit, { el: HTMLDivElement; fill: HTMLDivElement; shown: boolean; width: number }>();
  private readonly ndc: [number, number] = [0, 0];

  constructor(private readonly root: HTMLElement) {}

  update(world: World, camera: Camera, width: number, height: number): void {
    for (const u of world.units) {
      const combat = u.combat;
      if (!combat) continue;
      const integrity = combat.integrity;
      const want = u.alive && !u.hidden && !u.embarked && (world.selected.has(u) || world.inspected === u || integrity < 0.999);
      const bar = want ? this.bar(u) : this.bars.get(u);
      if (!bar) continue;
      if (!u.alive) {
        // The dead don't come back (a squad's replacements are new units): drop the bar.
        bar.el.remove();
        this.bars.delete(u);
        continue;
      }
      const c = u.instance.center;
      const onScreen = want && camera.project(c[0], c[1] + u.instance.model.radius * 0.6, c[2], this.ndc) && Math.abs(this.ndc[0]) < 1.1 && Math.abs(this.ndc[1]) < 1.1;
      if (onScreen !== bar.shown) {
        bar.el.hidden = !onScreen;
        bar.shown = onScreen;
      }
      if (!onScreen) continue;
      const x = ((this.ndc[0] + 1) / 2) * width;
      const y = ((1 - this.ndc[1]) / 2) * height;
      bar.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      const w = Math.round(integrity * 100);
      if (w !== bar.width) {
        bar.width = w;
        bar.fill.style.width = `${w}%`;
        bar.fill.style.background = integrity > 0.6 ? '#5fd35f' : integrity > 0.3 ? '#e8c547' : '#e8553f';
      }
    }
  }

  private bar(u: SeaUnit) {
    let bar = this.bars.get(u);
    if (!bar) {
      const el = document.createElement('div');
      el.className = `unit-bar ${u.team === PLAYER_TEAM ? 'own' : 'enemy'}`;
      const fill = document.createElement('div');
      el.append(fill);
      this.root.append(el);
      bar = { el, fill, shown: true, width: -1 };
      this.bars.set(u, bar);
    }
    return bar;
  }
}
