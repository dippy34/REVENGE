import { computed, signal } from '@preact/signals';
import { api, isAbort } from '../core/http';
import { artistLine } from '../core/match';
import type { Availability, EngineId, PlaybackSource, Track } from '../core/types';
import { store } from '../data/library';
import { settings, updateSettings } from '../data/settings';
import { toast } from '../ui/toast';
import type { PlaybackEngine, EngineEvent } from './engines/engine';
import { currentSource, initialPlayback, reduce, type Action, type PlaybackState } from './machine';
import * as Q from './queue';

/**
 * Orchestrates playback: the queue (pure), the state machine (pure) and the
 * engines (side effects). The server decides how each song plays
 * (api.play); this tries its answers in order and moves on when one fails.
 * All async work is tagged with the load token, so a user mashing "next" can
 * never end up with two tracks playing or a stale track's state on screen.
 */

const QUEUE_KEY = 'm.queue';
const QUEUE_KEEP = 300;
const SOURCES_MS = 10 * 60_000;

export interface ControllerDeps {
  engines: Record<EngineId, PlaybackEngine>;
}

/** What each song turned out to play as, keyed by track id; read by the song tags. */
export const availability = signal<Map<string, Availability>>(new Map());

function noteAvailability(trackId: string, value: Availability): void {
  if (availability.value.get(trackId) === value) return;
  const map = new Map(availability.value);
  map.set(trackId, value);
  availability.value = map;
}

export class PlayerController {
  readonly queue = signal<Q.QueueState>(Q.emptyQueue());
  readonly playback = signal<PlaybackState>(initialPlayback());
  readonly currentTrack = computed(() => Q.current(this.queue.value)?.track);
  readonly source = computed(() => currentSource(this.playback.value));

  private tokenCounter = 0;
  private resolveAbort?: AbortController;
  private active?: PlaybackEngine;
  private lastPositionSave = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private skipTimer?: ReturnType<typeof setTimeout>;
  private sources = new Map<string, { at: number; list: PlaybackSource[] }>();

  constructor(private readonly deps: ControllerDeps) {
    for (const engine of Object.values(deps.engines)) {
      engine.setListener((token, event) => this.onEngine(engine, token, event));
    }
    this.setupMediaSession();
  }

  // --- state helpers ------------------------------------------------------

  private dispatch(action: Action): PlaybackState {
    const next = reduce(this.playback.value, action);
    if (next !== this.playback.value) this.playback.value = next;
    return next;
  }

  private setQueue(state: Q.QueueState): void {
    this.queue.value = state;
    this.persistSoon();
  }

  get engine(): PlaybackEngine | undefined {
    return this.active;
  }

  capabilities() {
    const src = this.source.value;
    if (!src) return { seek: false, volume: true, visual: false, background: true };
    return this.deps.engines[src.engine].caps(src);
  }

  // --- public API ---------------------------------------------------------

  playTracks(tracks: Track[], start = 0, context?: Q.QueueContext): void {
    if (!tracks.length) return;
    this.setQueue(Q.setQueue(this.queue.value, tracks, start, context));
    void this.loadCurrent(true, 0);
  }

  playTrack(track: Track, context?: Q.QueueContext): void {
    this.playTracks([track], 0, context);
  }

  togglePlay(): void {
    const st = this.playback.value;
    if (st.status === 'playing' || st.status === 'buffering' || (st.status === 'loading' && st.intent === 'play')) this.pause();
    else this.play();
  }

  play(): void {
    const st = this.playback.value;
    if (!Q.current(this.queue.value)) return;
    if (st.status === 'idle' || st.status === 'error' || !this.active) {
      void this.loadCurrent(true, st.status === 'idle' ? st.position : 0);
      return;
    }
    if (st.status === 'ended') {
      this.dispatch({ type: 'PLAY_INTENT' });
      this.active.seek(0);
      this.active.play();
      return;
    }
    this.dispatch({ type: 'PLAY_INTENT' });
    if (st.status === 'resolving') return; // will autoplay when resolved
    this.active.play();
  }

  pause(): void {
    this.dispatch({ type: 'PAUSE_INTENT' });
    this.active?.pause();
  }

  next(): void {
    const step = Q.next(this.queue.value, false);
    if (!step.moved) {
      toast('You’ve reached the end of the queue.');
      return;
    }
    this.setQueue(step.state);
    void this.loadCurrent(true, 0);
  }

  previous(): void {
    const pos = this.active?.position() ?? this.playback.value.position;
    if (pos > 3 && this.active && this.capabilities().seek) {
      this.seek(0);
      return;
    }
    const step = Q.previous(this.queue.value);
    if (!step.moved) return;
    if (step.restart) {
      this.seek(0);
      return;
    }
    this.setQueue(step.state);
    void this.loadCurrent(true, 0);
  }

  seek(seconds: number): void {
    if (!this.active || !this.capabilities().seek) return;
    this.active.seek(seconds);
    this.dispatch({ type: 'TIME', token: this.playback.value.token, position: seconds });
  }

  seekBy(delta: number): void {
    this.seek(Math.max(0, (this.active?.position() ?? 0) + delta));
  }

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    updateSettings({ volume: v, muted: v === 0 ? settings.value.muted : false });
    this.active?.setVolume(v);
    if (v > 0) this.active?.setMuted(false);
  }

  toggleMute(): void {
    const muted = !settings.value.muted;
    updateSettings({ muted });
    this.active?.setMuted(muted);
  }

  toggleShuffle(): void {
    this.setQueue(Q.setShuffle(this.queue.value, !this.queue.value.shuffle));
  }

  cycleRepeat(): void {
    this.setQueue(Q.cycleRepeat(this.queue.value));
  }

  playNext(tracks: Track[]): void {
    const wasEmpty = !Q.current(this.queue.value);
    this.setQueue(Q.playNext(this.queue.value, tracks));
    if (wasEmpty) {
      this.setQueue(Q.jumpTo(this.queue.value, 0));
      void this.loadCurrent(true, 0);
    }
  }

  addToQueue(tracks: Track[]): void {
    const wasEmpty = !Q.current(this.queue.value);
    this.setQueue(Q.addToQueue(this.queue.value, tracks));
    if (wasEmpty) {
      this.setQueue(Q.jumpTo(this.queue.value, 0));
      void this.loadCurrent(true, 0);
    }
  }

  removeFromQueue(index: number): void {
    const wasCurrent = index === this.queue.value.index;
    this.setQueue(Q.removeAt(this.queue.value, index));
    if (wasCurrent) {
      if (Q.current(this.queue.value)) void this.loadCurrent(this.playback.value.intent === 'play', 0);
      else this.stop();
    }
  }

  moveInQueue(from: number, to: number): void {
    this.setQueue(Q.moveItem(this.queue.value, from, to));
  }

  jumpTo(index: number): void {
    if (index === this.queue.value.index) {
      this.play();
      return;
    }
    this.setQueue(Q.jumpTo(this.queue.value, index));
    void this.loadCurrent(true, 0);
  }

  clearUpcoming(): void {
    this.setQueue(Q.clearUpcoming(this.queue.value));
  }

  stop(): void {
    this.resolveAbort?.abort();
    this.active?.stop();
    this.active = undefined;
    this.dispatch({ type: 'STOP' });
    this.updateMediaSession();
  }

  // --- loading ------------------------------------------------------------

  /** The server's answer for a song, remembered for a few minutes. */
  private async sourcesFor(track: Track, signal: AbortSignal): Promise<PlaybackSource[]> {
    const hit = this.sources.get(track.id);
    if (hit && Date.now() - hit.at < SOURCES_MS) return hit.list;
    const list = await api.play(track.id, signal);
    this.sources.set(track.id, { at: Date.now(), list });
    if (this.sources.size > 200) this.sources.delete(this.sources.keys().next().value!);
    return list;
  }

  private async loadCurrent(autoplay: boolean, startAt: number): Promise<void> {
    const item = Q.current(this.queue.value);
    clearTimeout(this.skipTimer);
    if (!item) {
      this.stop();
      return;
    }
    const track = item.track;
    const token = ++this.tokenCounter;
    this.resolveAbort?.abort();
    const abort = new AbortController();
    this.resolveAbort = abort;
    // Pause (not stop) the current engine so an embed does not flash away when the next track uses it too.
    this.active?.pause();
    this.dispatch({ type: 'LOAD', token, trackId: track.id, autoplay, position: startAt });
    this.updateMediaSession();

    let candidates: PlaybackSource[];
    try {
      candidates = await this.sourcesFor(track, abort.signal);
    } catch (error) {
      if (isAbort(error) || token !== this.playback.value.token) return;
      this.dispatch({ type: 'RESOLVE_FAILED', token, error: 'Could not look up this song.' });
      this.onUnplayable(token, track);
      return;
    }
    if (token !== this.playback.value.token) return;
    const st = this.dispatch({ type: 'RESOLVED', token, candidates });
    if (st.status === 'error') {
      noteAvailability(track.id, 'unavailable');
      this.onUnplayable(token, track);
      return;
    }
    this.startCandidate(token);
  }

  private startCandidate(token: number): void {
    const st = this.playback.value;
    if (st.token !== token) return;
    const source = currentSource(st);
    if (!this.currentTrack.value || !source) return;
    const engine = this.deps.engines[source.engine];
    if (this.active && this.active !== engine) this.active.stop();
    this.active = engine;
    this.dispatch({ type: 'ENGINE_LOADING', token });
    engine.load(source, token, { autoplay: st.intent === 'play', startAt: st.position, volume: settings.value.volume, muted: settings.value.muted });
    this.updateMediaSession();
  }

  private onUnplayable(token: number, track: Track): void {
    // Nothing can play this track: release whatever was loaded before.
    this.active?.stop();
    this.active = undefined;
    const hasNext = Q.upcoming(this.queue.value).length > 0 || this.queue.value.repeat === 'all';
    if (!hasNext) {
      toast(`Couldn’t play “${track.title}”.`, { tone: 'error' });
      return;
    }
    toast(`Couldn’t play “${track.title}”. Skipping to the next song.`, { tone: 'error' });
    this.skipTimer = setTimeout(() => {
      if (token !== this.playback.value.token) return;
      const step = Q.next(this.queue.value, false);
      if (step.moved && !step.restart) {
        this.setQueue(step.state);
        void this.loadCurrent(true, 0);
      }
    }, 1800);
  }

  // --- engine events ------------------------------------------------------

  private onEngine(engine: PlaybackEngine, token: number, event: EngineEvent): void {
    if (engine !== this.active || token !== this.playback.value.token) return;
    switch (event.type) {
      case 'loading':
        this.dispatch({ type: 'ENGINE_LOADING', token });
        break;
      case 'playing': {
        this.dispatch({ type: 'PLAYING', token });
        const track = this.currentTrack.value;
        const source = this.source.value;
        if (track && source) noteAvailability(track.id, source.kind === 'preview' ? 'preview' : source.delivery === 'embed' ? 'embed' : 'full');
        if (this.playback.value.intent === 'pause') engine.pause(); // the user paused while it was starting
        break;
      }
      case 'paused':
        this.dispatch({ type: 'PAUSED', token });
        break;
      case 'waiting':
        this.dispatch({ type: 'WAITING', token });
        break;
      case 'time':
        this.onTime(token, event.position, event.duration);
        break;
      case 'ended':
        this.dispatch({ type: 'ENDED', token });
        this.onEnded(token);
        break;
      case 'needs-gesture':
        this.dispatch({ type: 'NEEDS_GESTURE', token });
        if (engine.id === 'youtube') toast('Tap play on the video to start it. Your browser needs a tap inside YouTube’s player.', { ms: 6000 });
        else toast('Press play to start. Your browser blocked automatic playback.', { ms: 5000 });
        break;
      case 'error': {
        const st = this.dispatch({ type: 'SOURCE_FAILED', token, reason: event.reason, recoverable: event.recoverable });
        if (st.status === 'loading') {
          const nextSource = currentSource(st);
          if (nextSource) toast(`${event.reason}. Trying ${nextSource.label} instead.`, { ms: 3500 });
          this.startCandidate(token);
        } else if (st.status === 'error') {
          const track = this.currentTrack.value;
          if (track) this.onUnplayable(token, track);
        }
        break;
      }
    }
  }

  private onTime(token: number, position: number, duration: number): void {
    const st = this.playback.value;
    // Throttle UI updates to ~5 per second.
    if (Math.abs(position - st.position) >= 0.2 || (duration && Math.abs(duration - st.duration) > 0.5)) {
      this.dispatch({ type: 'TIME', token, position, duration });
      this.updatePositionState();
    }
    if (Date.now() - this.lastPositionSave > 5000) {
      this.lastPositionSave = Date.now();
      this.persistSoon(0);
    }
  }

  private onEnded(token: number): void {
    const step = Q.next(this.queue.value, true);
    if (step.moved && step.restart) {
      if (token === this.playback.value.token) void this.loadCurrent(true, 0); // repeat one
      return;
    }
    if (step.moved) {
      this.setQueue(step.state);
      void this.loadCurrent(true, 0);
    }
  }

  // --- persistence (this browser only) -------------------------------------

  private persistSoon(delay = 800): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), delay);
  }

  private persist(): void {
    const q = this.queue.value;
    const start = Math.max(0, q.index - 50);
    const items = q.items.slice(start, start + QUEUE_KEEP);
    store.write(QUEUE_KEY, {
      tracks: items.map((i) => i.track),
      queued: items.map((i) => !!i.queued),
      index: q.index - start,
      shuffle: q.shuffle,
      repeat: q.repeat,
      context: q.context,
      position: this.active?.position() ?? this.playback.value.position,
    });
  }

  /** Restores the last queue paused at its last position. Nothing autoplays. */
  restore(): void {
    const saved = store.read<{ tracks?: Track[]; queued?: boolean[]; index?: number; shuffle?: boolean; repeat?: Q.RepeatMode; position?: number; context?: Q.QueueContext } | null>(QUEUE_KEY, null);
    const tracks = Array.isArray(saved?.tracks) ? saved.tracks.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.artists)) : [];
    if (!saved || !tracks.length) return;
    const items: Q.QueueItem[] = tracks.map((track, i) => ({ uid: Q.makeUid(), track, queued: saved.queued?.[i] || undefined }));
    const index = Math.min(Math.max(0, Number(saved.index) || 0), items.length - 1);
    const repeat = saved.repeat === 'all' || saved.repeat === 'one' ? saved.repeat : 'off';
    this.queue.value = { items, index, shuffle: !!saved.shuffle, repeat, original: null, context: saved.context };
    this.playback.value = { ...initialPlayback(), trackId: items[index].track.id, position: Math.max(0, Number(saved.position) || 0), duration: items[index].track.duration ?? 0 };
    this.updateMediaSession();
  }

  // --- media session ------------------------------------------------------

  private setupMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      ['seekbackward', (d) => this.seekBy(-(d.seekOffset ?? 10))],
      ['seekforward', (d) => this.seekBy(d.seekOffset ?? 10)],
      ['seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime)],
      ['stop', () => this.pause()],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    }
  }

  private updateMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const track = this.currentTrack.value;
    const ms = navigator.mediaSession;
    if (!track) {
      ms.metadata = null;
      ms.playbackState = 'none';
      return;
    }
    const art = track.artwork;
    const artwork = [
      art?.small && { src: art.small, sizes: '250x250' },
      art?.medium && { src: art.medium, sizes: '500x500' },
      art?.large && { src: art.large, sizes: '1000x1000' },
    ].filter(Boolean) as MediaImage[];
    try {
      ms.metadata = new MediaMetadata({ title: track.title, artist: artistLine(track), album: track.album?.title ?? '', artwork });
    } catch {
      /* MediaMetadata unsupported */
    }
    const st = this.playback.value;
    ms.playbackState = st.status === 'playing' || st.status === 'buffering' ? 'playing' : st.status === 'idle' ? 'none' : 'paused';
  }

  private lastPositionState = 0;
  private updatePositionState(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const st = this.playback.value;
    navigator.mediaSession.playbackState = st.status === 'playing' || st.status === 'buffering' ? 'playing' : 'paused';
    if (Date.now() - this.lastPositionState < 1000 || !st.duration) return;
    this.lastPositionState = Date.now();
    try {
      navigator.mediaSession.setPositionState({ duration: st.duration, position: Math.min(st.position, st.duration), playbackRate: 1 });
    } catch {
      /* invalid state */
    }
  }
}
