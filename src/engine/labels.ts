import type { BodyKind } from '../data/types.ts';

export interface LabelInput {
  id: string;
  name: string;
  kind: BodyKind;
}

export interface LabelFrame {
  id: string;
  x: number;
  y: number;
  /** Lower draws first and wins overlaps. */
  priority: number;
  /** Marker ring radius in px (grows with the body's disk). */
  ring: number;
  opacity: number;
}

interface Item {
  el: HTMLButtonElement;
  width: number;
  shown: boolean;
}

/**
 * Body names drawn as DOM elements over the canvas: crisp text, CSS styling and
 * native pointer events. Overlapping labels are culled by priority each frame.
 */
export class LabelLayer {
  private readonly items = new Map<string, Item>();
  private selected: string | null = null;
  private hovered: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    bodies: LabelInput[],
    handlers: { select: (id: string) => void; focus: (id: string) => void; hover: (id: string | null) => void },
  ) {
    for (const b of bodies) {
      const el = document.createElement('button');
      el.className = `label kind-${b.kind}`;
      el.type = 'button';
      el.tabIndex = -1;
      el.innerHTML = `<span class="label-ring"></span><span class="label-name"></span>`;
      (el.lastElementChild as HTMLElement).textContent = b.name;
      el.style.display = 'none';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.select(b.id);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        handlers.focus(b.id);
      });
      el.addEventListener('pointerenter', () => handlers.hover(b.id));
      el.addEventListener('pointerleave', () => handlers.hover(null));
      root.appendChild(el);
      this.items.set(b.id, { el, width: 18 + b.name.length * 7.2, shown: false });
    }
  }

  setState(selected: string | null, hovered: string | null) {
    if (selected !== this.selected) {
      if (this.selected) this.items.get(this.selected)?.el.classList.remove('selected');
      if (selected) this.items.get(selected)?.el.classList.add('selected');
      this.selected = selected;
    }
    if (hovered !== this.hovered) {
      if (this.hovered) this.items.get(this.hovered)?.el.classList.remove('hovered');
      if (hovered) this.items.get(hovered)?.el.classList.add('hovered');
      this.hovered = hovered;
    }
  }

  setVisible(visible: boolean) {
    this.root.style.display = visible ? '' : 'none';
  }

  update(frames: LabelFrame[]) {
    frames.sort((a, b) => a.priority - b.priority);
    const placed: Array<[number, number, number, number]> = [];
    const visible = new Set<string>();
    for (const f of frames) {
      const item = this.items.get(f.id);
      if (!item) continue;
      const x0 = f.x + f.ring + 2;
      const rect: [number, number, number, number] = [x0 - 6, f.y - 9, x0 + item.width, f.y + 9];
      const force = f.id === this.selected || f.id === this.hovered;
      if (!force && placed.some((p) => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1])) continue;
      placed.push(rect);
      visible.add(f.id);
      const el = item.el;
      if (!item.shown) {
        el.style.display = '';
        item.shown = true;
      }
      el.style.transform = `translate3d(${f.x.toFixed(1)}px, ${f.y.toFixed(1)}px, 0)`;
      el.style.setProperty('--ring', `${Math.max(5, f.ring).toFixed(1)}px`);
      el.style.opacity = f.opacity.toFixed(2);
    }
    for (const [id, item] of this.items) {
      if (item.shown && !visible.has(id)) {
        item.el.style.display = 'none';
        item.shown = false;
      }
    }
  }
}
