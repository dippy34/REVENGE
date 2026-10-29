import { signal } from '@preact/signals';

/**
 * The visible surface for the YouTube embed.
 *
 * YouTube's terms require the player to stay visible, and moving an
 * <iframe> in the DOM reloads it. So there is exactly one fixed-position host
 * element, outside the UI tree, that is laid over whichever "slot" the UI
 * currently shows (the Now Playing view, the side panel, or the floating
 * dock). When an embed is active the surface is always on screen at 200×200
 * CSS pixels or larger.
 */

export type SlotName = 'nowplaying' | 'panel' | 'dock';

const PRIORITY: Record<SlotName, number> = { nowplaying: 3, panel: 2, dock: 1 };
const MIN = 200;

/** Which embed (if any) is active. The UI shows the dock when no other slot is visible. */
export const embedActive = signal<'youtube' | null>(null);
/** Name of the slot the surface is attached to. */
export const activeSlot = signal<SlotName | null>(null);

const slots = new Map<SlotName, HTMLElement>();
let host: HTMLDivElement | null = null;
let frame = 0;

export function surfaceHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'm-embed';
  host.setAttribute('aria-label', 'Video player');
  host.hidden = true;
  const yt = document.createElement('div');
  yt.className = 'm-embed-yt';
  const ytInner = document.createElement('div');
  ytInner.id = 'm-yt-player';
  yt.appendChild(ytInner);
  host.append(yt);
  document.body.appendChild(host);
  return host;
}

export function ytContainer(): HTMLElement {
  surfaceHost();
  return document.getElementById('m-yt-player') ?? (host!.querySelector('.m-embed-yt') as HTMLElement);
}

export function registerSlot(name: SlotName, el: HTMLElement): () => void {
  slots.set(name, el);
  schedule();
  return () => {
    if (slots.get(name) === el) slots.delete(name);
    schedule();
  };
}

function visible(el: HTMLElement): DOMRect | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return null;
  return r;
}

function layout(): void {
  frame = 0;
  const h = surfaceHost();
  const kind = embedActive.value;
  if (!kind) {
    if (!h.hidden) h.hidden = true;
    if (activeSlot.value) activeSlot.value = null;
    return;
  }
  let best: { name: SlotName; rect: DOMRect } | null = null;
  for (const [name, el] of slots) {
    const rect = visible(el);
    if (rect && (!best || PRIORITY[name] > PRIORITY[best.name])) best = { name, rect };
  }
  if (activeSlot.value !== (best?.name ?? null)) activeSlot.value = best?.name ?? null;
  h.dataset.kind = kind;
  if (!best) {
    // No slot yet (e.g. the dock is mounting): park it bottom-right, still visible.
    Object.assign(h.style, { left: 'auto', top: 'auto', right: '16px', bottom: '96px', width: 'min(356px, calc(100vw - 24px))', height: '200px' });
  } else {
    const { rect } = best;
    const width = Math.max(MIN, rect.width);
    const height = Math.max(MIN, rect.height);
    Object.assign(h.style, { left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`, right: 'auto', bottom: 'auto', width: `${Math.round(width)}px`, height: `${Math.round(height)}px` });
  }
  h.hidden = false;
  h.classList.toggle('is-yt', kind === 'youtube');
  // Keep tracking while active: slots move with scrolling, panels and animations.
  frame = requestAnimationFrame(layout);
}

export function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(layout);
}

export function setEmbedActive(kind: 'youtube' | null): void {
  embedActive.value = kind;
  schedule();
}
