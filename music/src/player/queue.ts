import type { Track } from '../core/types';

/**
 * Pure queue model. Every function returns a new state; nothing mutates.
 *
 * - `items` is the play order. `index` points at the current item (-1 when empty).
 * - Items added with "Add to queue" are flagged `queued` and play before the
 *   rest of the context, in the order they were added (like Spotify's "Next up").
 * - Shuffle reorders only the items after the current one and remembers the
 *   original order so turning it off restores it.
 */

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueItem {
  uid: string;
  track: Track;
  queued?: boolean;
}

export interface QueueContext {
  type: 'album' | 'playlist' | 'artist' | 'search' | 'liked' | 'history' | 'radio' | 'local' | 'chart' | 'other';
  id?: string;
  title: string;
}

export interface QueueState {
  items: QueueItem[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** uids in pre-shuffle order, set while shuffle is on. */
  original: string[] | null;
  context?: QueueContext;
}

export const emptyQueue = (): QueueState => ({ items: [], index: -1, shuffle: false, repeat: 'off', original: null });

let counter = 0;
export function makeUid(): string {
  counter += 1;
  return `q${Date.now().toString(36)}${counter.toString(36)}`;
}

const wrap = (tracks: Track[], queued = false): QueueItem[] => tracks.map((track) => ({ uid: makeUid(), track, queued: queued || undefined }));

export type Rng = () => number;

export function shuffled<T>(items: T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function current(state: QueueState): QueueItem | undefined {
  return state.index >= 0 ? state.items[state.index] : undefined;
}

export function upcoming(state: QueueState): QueueItem[] {
  return state.items.slice(state.index + 1);
}

export function played(state: QueueState): QueueItem[] {
  return state.index > 0 ? state.items.slice(0, state.index) : [];
}

/** Replaces the queue with a new context, starting at `start`. */
export function setQueue(state: QueueState, tracks: Track[], start = 0, context?: QueueContext, rng: Rng = Math.random): QueueState {
  if (!tracks.length) return { ...emptyQueue(), shuffle: state.shuffle, repeat: state.repeat };
  const items = wrap(tracks);
  const startIndex = Math.min(Math.max(start, 0), items.length - 1);
  if (!state.shuffle) return { ...state, items, index: startIndex, original: null, context };
  const first = items[startIndex];
  const rest = shuffled(items.filter((_, i) => i !== startIndex), rng);
  return { ...state, items: [first, ...rest], index: 0, original: items.map((i) => i.uid), context };
}

/** Index after the current item and any items already in "Next up". */
function nextUpEnd(state: QueueState): number {
  let i = state.index + 1;
  while (i < state.items.length && state.items[i].queued) i += 1;
  return i;
}

export function playNext(state: QueueState, tracks: Track[]): QueueState {
  if (!tracks.length) return state;
  const added = wrap(tracks, true);
  if (state.index < 0) return { ...state, items: [...state.items, ...added], index: state.items.length ? state.index : -1, original: appendOriginal(state, added, 0) };
  const at = state.index + 1;
  const items = [...state.items.slice(0, at), ...added, ...state.items.slice(at)];
  return { ...state, items, original: insertOriginal(state, added) };
}

export function addToQueue(state: QueueState, tracks: Track[]): QueueState {
  if (!tracks.length) return state;
  const added = wrap(tracks, true);
  if (state.index < 0) return { ...state, items: [...state.items, ...added], original: appendOriginal(state, added, state.items.length) };
  const at = nextUpEnd(state);
  const items = [...state.items.slice(0, at), ...added, ...state.items.slice(at)];
  return { ...state, items, original: insertOriginal(state, added) };
}

/** Appends tracks at the very end (used by autoplay radio). */
export function appendTracks(state: QueueState, tracks: Track[]): QueueState {
  if (!tracks.length) return state;
  const added = wrap(tracks);
  return { ...state, items: [...state.items, ...added], original: state.original ? [...state.original, ...added.map((a) => a.uid)] : null };
}

function appendOriginal(state: QueueState, added: QueueItem[], _at: number): string[] | null {
  return state.original ? [...state.original, ...added.map((a) => a.uid)] : null;
}

/** Queued items keep their spot right after the current track when unshuffling. */
function insertOriginal(state: QueueState, added: QueueItem[]): string[] | null {
  if (!state.original) return null;
  const cur = current(state);
  const pos = cur ? state.original.indexOf(cur.uid) + 1 : state.original.length;
  return [...state.original.slice(0, pos), ...added.map((a) => a.uid), ...state.original.slice(pos)];
}

export function removeAt(state: QueueState, index: number): QueueState {
  if (index < 0 || index >= state.items.length) return state;
  const removed = state.items[index];
  const items = state.items.filter((_, i) => i !== index);
  let newIndex = state.index;
  if (index < state.index) newIndex -= 1;
  else if (index === state.index) newIndex = Math.min(state.index, items.length - 1);
  return { ...state, items, index: items.length ? newIndex : -1, original: state.original?.filter((u) => u !== removed.uid) ?? null };
}

export function moveItem(state: QueueState, from: number, to: number): QueueState {
  if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return state;
  const items = [...state.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  let index = state.index;
  if (from === state.index) index = to;
  else if (from < state.index && to >= state.index) index -= 1;
  else if (from > state.index && to <= state.index) index += 1;
  return { ...state, items, index };
}

export function jumpTo(state: QueueState, index: number): QueueState {
  if (index < 0 || index >= state.items.length) return state;
  return { ...state, index };
}

export interface Step {
  state: QueueState;
  /** False when playback should stop (end of queue, repeat off). */
  moved: boolean;
  /** True when the same item should restart (repeat one on auto-advance). */
  restart: boolean;
}

/**
 * Advances. `auto` is true when a track ended by itself: repeat-one then
 * replays the same item; a manual "next" always moves on.
 */
export function next(state: QueueState, auto: boolean): Step {
  if (!state.items.length) return { state, moved: false, restart: false };
  if (auto && state.repeat === 'one') return { state, moved: true, restart: true };
  if (state.index + 1 < state.items.length) return { state: { ...state, index: state.index + 1 }, moved: true, restart: false };
  if (state.repeat === 'all' || (!auto && state.repeat === 'one')) {
    if (state.items.length === 1) return { state, moved: true, restart: true };
    return { state: { ...state, index: 0 }, moved: true, restart: false };
  }
  return { state, moved: false, restart: false };
}

export function previous(state: QueueState): Step {
  if (!state.items.length) return { state, moved: false, restart: false };
  if (state.index > 0) return { state: { ...state, index: state.index - 1 }, moved: true, restart: false };
  if (state.repeat === 'all' && state.items.length > 1) return { state: { ...state, index: state.items.length - 1 }, moved: true, restart: false };
  return { state, moved: true, restart: true };
}

export function setShuffle(state: QueueState, on: boolean, rng: Rng = Math.random): QueueState {
  if (on === state.shuffle) return state;
  if (on) {
    const before = state.items.slice(0, state.index + 1);
    const after = shuffled(state.items.slice(state.index + 1), rng);
    return { ...state, shuffle: true, items: [...before, ...after], original: state.items.map((i) => i.uid) };
  }
  if (!state.original) return { ...state, shuffle: false };
  const cur = current(state);
  const byUid = new Map(state.items.map((i) => [i.uid, i]));
  const ordered = state.original.map((u) => byUid.get(u)).filter((i): i is QueueItem => !!i);
  // Items added while shuffled but missing from `original` go to the end.
  const seen = new Set(ordered.map((i) => i.uid));
  for (const item of state.items) if (!seen.has(item.uid)) ordered.push(item);
  const index = cur ? ordered.findIndex((i) => i.uid === cur.uid) : -1;
  return { ...state, shuffle: false, items: ordered, index, original: null };
}

export function cycleRepeat(state: QueueState): QueueState {
  const order: RepeatMode[] = ['off', 'all', 'one'];
  return { ...state, repeat: order[(order.indexOf(state.repeat) + 1) % order.length] };
}

export function clearUpcoming(state: QueueState): QueueState {
  const keep = state.items.slice(0, state.index + 1);
  const keepIds = new Set(keep.map((i) => i.uid));
  return { ...state, items: keep, original: state.original?.filter((u) => keepIds.has(u)) ?? null };
}

/** Serializable form for persistence. */
export function serialize(state: QueueState): { trackIds: string[]; queued: boolean[]; index: number; shuffle: boolean; repeat: RepeatMode; context?: QueueContext } {
  return {
    trackIds: state.items.map((i) => i.track.id),
    queued: state.items.map((i) => !!i.queued),
    index: state.index,
    shuffle: state.shuffle,
    repeat: state.repeat,
    context: state.context,
  };
}
