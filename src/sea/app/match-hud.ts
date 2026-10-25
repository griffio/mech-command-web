// The match's HUD: both sides' tickets and the lane of capture points along the top (a tap on a point looks at it),
// a card per squad of the player's along the bottom (a tap selects it, a second tap looks at it, shift adds), and each
// squad's letter floating over it in the world (the enemy's only while the player's side can see one of them).
import type { Camera } from '../render/camera';
import { TEAM_COLOR, type Match } from './match';
import type { Squad } from './squads';
import { PLAYER_TEAM, type World } from './world';

/** HUD text refreshes this often (the floating letters follow every frame). */
const REFRESH_S = 0.1;

export class MatchHud {
  private readonly points: { el: HTMLButtonElement; fill: HTMLElement; tag: HTMLElement }[] = [];
  private readonly cards = new Map<Squad, { el: HTMLButtonElement; bar: HTMLElement; status: HTMLElement; count: HTMLElement }>();
  private readonly markers = new Map<Squad, { el: HTMLDivElement; shown: boolean }>();
  private readonly ownTickets: HTMLElement;
  private readonly enemyTickets: HTMLElement;
  private readonly ndc: [number, number] = [0, 0];
  private nextRefresh = 0;

  constructor(
    private readonly world: World,
    private readonly match: Match,
    bar: HTMLElement,
    squads: HTMLElement,
    overlay: HTMLElement,
    private readonly lookAt: (x: number, z: number) => void,
  ) {
    bar.hidden = false;
    squads.hidden = false;
    // The HUD text sits above the cards, however many rows they wrap to.
    new ResizeObserver(() => document.body.style.setProperty('--cards-height', `${squads.offsetHeight}px`)).observe(squads);
    const own = match.side(PLAYER_TEAM);
    const enemy = match.sides.find((s) => s.team !== PLAYER_TEAM)!;
    this.ownTickets = tickets(bar, own.name, 'own');
    const lane = document.createElement('div');
    lane.className = 'lane';
    bar.append(lane);
    this.enemyTickets = tickets(bar, enemy.name, 'enemy');
    for (const p of match.points) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'point';
      const fill = document.createElement('span');
      fill.className = 'fill';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      el.append(fill, name, tag);
      el.addEventListener('click', () => this.lookAt(p.x, p.z));
      lane.append(el);
      this.points.push({ el, fill, tag });
    }
    for (const squad of own.squads) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'squad';
      el.innerHTML = `<b>${squad.letter}</b><span class="title">${squad.name} <small>${squad.spec.role}</small></span><span class="bar"><i></i></span><span class="count"></span><span class="status"></span>`;
      el.addEventListener('click', (e) => {
        const c = squad.centroid();
        // A tap on the only selected squad looks at it; otherwise it selects it (shift adds or removes).
        if (!e.shiftKey && c && world.selectedSquads.size === 1 && world.selectedSquads.has(squad)) this.lookAt(c[0], c[1]);
        else world.selectSquad(squad, e.shiftKey);
      });
      squads.append(el);
      this.cards.set(squad, { el, bar: el.querySelector('.bar i')!, status: el.querySelector('.status')!, count: el.querySelector('.count')! });
    }
    for (const side of match.sides) {
      for (const squad of side.squads) {
        const el = document.createElement('div');
        el.className = `squad-marker ${side.team === PLAYER_TEAM ? 'own' : 'enemy'}`;
        el.textContent = squad.letter;
        el.hidden = true;
        overlay.append(el);
        this.markers.set(squad, { el, shown: false });
      }
    }
  }

  update(camera: Camera, width: number, height: number): void {
    this.placeMarkers(camera, width, height);
    if (this.match.time < this.nextRefresh) return;
    this.nextRefresh = this.match.time + REFRESH_S;
    const own = this.match.side(PLAYER_TEAM);
    const enemy = this.match.sides.find((s) => s.team !== PLAYER_TEAM)!;
    this.ownTickets.textContent = String(Math.max(0, own.tickets));
    this.enemyTickets.textContent = String(Math.max(0, enemy.tickets));
    const active = [this.match.capturable(0), this.match.capturable(1)];
    this.match.points.forEach((p, i) => {
      const { el, fill, tag } = this.points[i]!;
      const v = p.value;
      fill.style.left = v >= 0 ? '0' : 'auto';
      fill.style.right = v < 0 ? '0' : 'auto';
      fill.style.width = `${Math.abs(v) * 100}%`;
      fill.style.background = TEAM_COLOR[v >= 0 ? 0 : 1]!;
      el.style.borderColor = p.owner === null ? '#9aa0a6' : TEAM_COLOR[p.owner]!;
      el.classList.toggle('active', active.includes(i));
      const [a, b] = p.present;
      tag.textContent = a && b ? 'contested' : a ? `${a} of yours` : b ? `${b} enemy` : '';
    });
    for (const [squad, card] of this.cards) {
      card.el.classList.toggle('selected', this.world.selectedSquads.has(squad));
      card.el.classList.toggle('lost', !squad.alive.length);
      card.el.classList.toggle('pinned', squad.pinned);
      card.bar.style.width = `${Math.round(squad.strength * 100)}%`;
      card.count.textContent = `${squad.alive.length}/${squad.spec.units.length}`;
      card.status.textContent = squad.status(this.match.time);
    }
  }

  /** Each squad's letter over its middle; the enemy's only while the player's side sees one of its members. */
  private placeMarkers(camera: Camera, width: number, height: number): void {
    const seen = this.world.battle.seenBy(PLAYER_TEAM);
    for (const [squad, m] of this.markers) {
      const alive = squad.alive.filter((u) => squad.team === PLAYER_TEAM || seen.has(u));
      let show = alive.length > 0;
      if (show) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (const u of alive) {
          x += u.x / alive.length;
          z += u.z / alive.length;
          y = Math.max(y, u.instance.center[1] + u.instance.model.radius * 0.7);
        }
        show = camera.project(x, y + 4, z, this.ndc) && Math.abs(this.ndc[0]) < 1.05 && Math.abs(this.ndc[1]) < 1.05;
        if (show) {
          m.el.style.transform = `translate(${(((this.ndc[0] + 1) / 2) * width).toFixed(1)}px, ${(((1 - this.ndc[1]) / 2) * height).toFixed(1)}px)`;
          m.el.classList.toggle('selected', this.world.selectedSquads.has(squad));
          m.el.classList.toggle('pinned', squad.pinned);
        }
      }
      if (show !== m.shown) {
        m.el.hidden = !show;
        m.shown = show;
      }
    }
  }
}

function tickets(parent: HTMLElement, name: string, cls: string): HTMLElement {
  const box = document.createElement('div');
  box.className = `tickets ${cls}`;
  box.title = `${name}: tickets`;
  const value = document.createElement('span');
  box.append(value);
  parent.append(box);
  return value;
}
