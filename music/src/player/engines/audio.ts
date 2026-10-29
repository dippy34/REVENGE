import { audioAllowed } from '../../core/config';
import type { PlaybackSource } from '../../core/types';
import type { EngineCaps, EngineListener, LoadOptions, PlaybackEngine } from './engine';

/**
 * <audio>-based engine for everything that is not YouTube: Audius, Internet
 * Archive, Commons, Jamendo and previews (all streamed by our relay), and the
 * visitor's own files (blob: URLs).
 */

const STALL_MS = 20000;

export class AudioEngine implements PlaybackEngine {
  readonly id = 'audio' as const;
  private el: HTMLAudioElement;
  private token = 0;
  private listener: EngineListener = () => {};
  private stallTimer?: ReturnType<typeof setTimeout>;
  private limit?: number;
  private wantPlay = false;

  constructor(el?: HTMLAudioElement) {
    this.el = el ?? new Audio();
    this.el.preload = 'auto';
    this.el.setAttribute('playsinline', '');
    const on = (type: string, fn: () => void) => this.el.addEventListener(type, fn);
    on('playing', () => {
      this.clearStall();
      this.emit({ type: 'playing' });
    });
    on('pause', () => {
      if (!this.el.ended) this.emit({ type: 'paused' });
    });
    on('waiting', () => {
      this.emit({ type: 'waiting' });
      this.armStall();
    });
    on('stalled', () => this.armStall());
    on('canplay', () => this.clearStall());
    on('ended', () => this.emit({ type: 'ended' }));
    on('timeupdate', () => {
      const position = this.el.currentTime;
      const duration = this.limitedDuration();
      this.emit({ type: 'time', position, duration });
      if (this.limit && position >= this.limit) {
        this.el.pause();
        this.emit({ type: 'ended' });
      }
    });
    on('durationchange', () => this.emit({ type: 'time', position: this.el.currentTime, duration: this.limitedDuration() }));
    on('error', () => {
      if (!this.el.getAttribute('src')) return;
      this.clearStall();
      const err = this.el.error;
      const reason =
        err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? 'This source could not be played (unsupported or unavailable)'
          : err?.code === MediaError.MEDIA_ERR_NETWORK
            ? 'Network error while streaming'
            : err?.code === MediaError.MEDIA_ERR_DECODE
              ? 'The audio could not be decoded'
              : 'The source failed to load';
      this.emit({ type: 'error', reason, recoverable: true });
    });
  }

  /** Exposed for tests and debugging. */
  get element(): HTMLAudioElement {
    return this.el;
  }

  caps(): EngineCaps {
    return { seek: true, volume: true, visual: false, background: true };
  }

  setListener(listener: EngineListener): void {
    this.listener = listener;
  }

  private emit(event: Parameters<EngineListener>[1]): void {
    this.listener(this.token, event);
  }

  private limitedDuration(): number {
    const d = Number.isFinite(this.el.duration) ? this.el.duration : 0;
    return this.limit && d ? Math.min(d, this.limit) : d;
  }

  private armStall(): void {
    this.clearStall();
    const token = this.token;
    this.stallTimer = setTimeout(() => {
      if (token === this.token && this.wantPlay) this.listener(token, { type: 'error', reason: 'The stream stopped responding', recoverable: true });
    }, STALL_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  load(source: PlaybackSource, token: number, opts: LoadOptions): void {
    this.token = token;
    this.clearStall();
    const url = source.url ?? '';
    if (!audioAllowed(url)) {
      queueMicrotask(() => this.listener(token, { type: 'error', reason: 'Blocked an untrusted audio address', recoverable: true }));
      return;
    }
    this.limit = source.durationLimit;
    this.wantPlay = opts.autoplay;
    this.el.volume = opts.volume;
    this.el.muted = opts.muted;
    this.el.src = url;
    this.emit({ type: 'loading' });
    if (opts.startAt > 0) {
      const seekOnce = () => {
        this.el.removeEventListener('loadedmetadata', seekOnce);
        if (token === this.token) this.el.currentTime = Math.min(opts.startAt, Math.max(0, (this.el.duration || opts.startAt) - 1));
      };
      this.el.addEventListener('loadedmetadata', seekOnce);
    }
    this.armStall();
    if (opts.autoplay) this.play();
  }

  play(): void {
    this.wantPlay = true;
    const token = this.token;
    const p = this.el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((error: DOMException) => {
        if (token !== this.token) return;
        if (error?.name === 'NotAllowedError') this.listener(token, { type: 'needs-gesture' });
        else if (error?.name !== 'AbortError') this.listener(token, { type: 'error', reason: 'Playback could not start', recoverable: true });
      });
    }
  }

  pause(): void {
    this.wantPlay = false;
    this.clearStall();
    this.el.pause();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const max = this.limitedDuration() || seconds;
    this.el.currentTime = Math.max(0, Math.min(seconds, max - 0.25));
  }

  setVolume(volume: number): void {
    this.el.volume = Math.max(0, Math.min(1, volume));
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted;
  }

  stop(): void {
    this.wantPlay = false;
    this.clearStall();
    this.token = -1;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }

  position(): number {
    return this.el.currentTime || 0;
  }

  duration(): number {
    return this.limitedDuration();
  }
}
