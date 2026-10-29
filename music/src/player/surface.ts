import { signal } from '@preact/signals';

/**
 * Where the YouTube embed lives.
 *
 * Songs from YouTube play through its no-cookie embed with the video out of
 * sight: the player sits in one fixed-position host element, outside the UI
 * tree (moving an <iframe> in the DOM reloads it), that is transparent and
 * lets every click through. It only shows when a phone will not start the
 * player without a tap inside it: the UI then mounts the dock (Video.tsx)
 * and the host is laid over the dock's slot until the song plays.
 */

const MIN = 200;

/** Which embed (if any) is loaded. */
export const embedActive = signal<'youtube' | null>(null);

let slot: HTMLElement | null = null;
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

/** The dock's placeholder: while one is mounted, the player is shown over it. */
export function registerSlot(el: HTMLElement): () => void {
  slot = el;
  schedule();
  return () => {
    if (slot === el) slot = null;
    schedule();
  };
}

function layout(): void {
  frame = 0;
  const h = surfaceHost();
  const kind = embedActive.value;
  h.hidden = !kind;
  if (!kind) return;
  const rect = slot?.isConnected ? slot.getBoundingClientRect() : null;
  const away = !rect || rect.width < 2 || rect.height < 2;
  h.classList.toggle('is-away', away);
  h.inert = away; // nothing to tab into or read out while it is out of sight
  if (away) {
    // Still laid out, at YouTube's minimum size, so it keeps playing.
    Object.assign(h.style, { left: 'auto', top: 'auto', right: '0px', bottom: '0px', width: `${MIN}px`, height: `${MIN}px` });
    return;
  }
  Object.assign(h.style, {
    left: `${Math.round(rect.left)}px`,
    top: `${Math.round(rect.top)}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${Math.round(Math.max(MIN, rect.width))}px`,
    height: `${Math.round(Math.max(MIN, rect.height))}px`,
  });
  // Keep tracking while shown: the dock moves with the window and its animation.
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
