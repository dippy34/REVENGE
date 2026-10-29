import type { PlaybackSource } from '../../core/types';
import { setEmbedActive, ytContainer } from '../surface';
import type { EngineCaps, EngineListener, LoadOptions, PlaybackEngine } from './engine';

/**
 * YouTube's no-cookie embed, driven by its postMessage protocol
 * (enablejsapi=1) without loading YouTube's iframe API script, the same way
 * the YouTube section does. The player stays visible with YouTube's own
 * controls; we only send play, pause, seek, volume and load commands.
 */

const EMBED = 'https://www.youtube-nocookie.com/embed/';
const ORIGIN = 'https://www.youtube-nocookie.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const ERRORS: Record<number, string> = {
  2: 'YouTube rejected the video id',
  5: 'YouTube’s player could not play this video in the browser',
  100: 'The video was removed or made private',
  101: 'The owner does not allow this video to be embedded',
  150: 'The owner does not allow this video to be embedded',
  153: 'YouTube needs a referrer to play this video',
};

/** 127.0.0.1, 192.168.x.x, [::1] and so on. */
export function onIpAddress(host = location.hostname): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

export class YouTubeEngine implements PlaybackEngine {
  readonly id = 'youtube' as const;
  private frame: HTMLIFrameElement | null = null;
  private token = 0;
  private listener: EngineListener = () => {};
  private heard = false;
  private ready = false;
  private ping?: ReturnType<typeof setInterval>;
  private gestureTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private state = -1;
  private time = 0;
  private dur = 0;
  private wantPlay = false;
  private volume = 0.8;
  private muted = false;
  private currentVideo = '';
  /** Called with a video id that cannot be embedded, so it is never offered again. */
  onBlocked: (videoId: string) => void = () => {};

  constructor() {
    window.addEventListener('message', this.onMessage);
  }

  caps(): EngineCaps {
    return { seek: true, volume: true, visual: true, background: false };
  }

  setListener(listener: EngineListener): void {
    this.listener = listener;
  }

  private emit(event: Parameters<EngineListener>[1]): void {
    this.listener(this.token, event);
  }

  private post(message: Record<string, unknown>): void {
    this.frame?.contentWindow?.postMessage(JSON.stringify(message), ORIGIN);
  }

  private command(func: string, args: unknown[] = []): void {
    this.post({ event: 'command', func, args, id: 1, channel: 'widget' });
  }

  private makeFrame(videoId: string, opts: LoadOptions): HTMLIFrameElement {
    const q = new URLSearchParams({
      autoplay: opts.autoplay ? '1' : '0',
      rel: '0',
      playsinline: '1',
      iv_load_policy: '3',
      enablejsapi: '1',
      origin: location.origin,
    });
    if (opts.startAt > 0) q.set('start', String(Math.floor(opts.startAt)));
    const f = document.createElement('iframe');
    f.title = 'video player';
    // Restrictive: no popups, forms, top navigation, downloads or sensors.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    // YouTube refuses embeds that send no Referer at all (error 153), so this
    // frame alone sends the bare origin: no path, no query.
    f.setAttribute('referrerpolicy', 'strict-origin');
    f.addEventListener('load', () => this.startListening());
    f.src = `${EMBED}${videoId}?${q}`; // last, so every restriction applies
    return f;
  }

  private startListening(): void {
    this.heard = false;
    clearInterval(this.ping);
    const say = () => {
      if (this.heard) return clearInterval(this.ping);
      this.post({ event: 'listening', id: 1, channel: 'widget' });
    };
    say();
    this.ping = setInterval(say, 750);
  }

  private onMessage = (e: MessageEvent): void => {
    if (!this.frame || e.origin !== ORIGIN || e.source !== this.frame.contentWindow) return;
    let d: { event?: string; info?: unknown } | null = null;
    try {
      d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;
    if (!this.heard) {
      this.heard = true;
      clearTimeout(this.silenceTimer);
    }
    const info = d.info;
    if (d.event === 'onReady' || d.event === 'initialDelivery') {
      if (!this.ready) {
        this.ready = true;
        this.applyVolume();
      }
    }
    if (d.event === 'onError') return this.onError(num(info));
    if (d.event === 'onStateChange') return this.onState(num(info));
    if (info && typeof info === 'object') {
      const o = info as Record<string, unknown>;
      if (typeof o.playerState === 'number' && o.playerState !== this.state) this.onState(o.playerState);
      if (typeof o.duration === 'number' && o.duration > 0) this.dur = o.duration;
      if (typeof o.currentTime === 'number') {
        this.time = o.currentTime;
        this.emit({ type: 'time', position: this.time, duration: this.dur });
      }
    }
  };

  private onState(state: number): void {
    if (state === this.state) return;
    this.state = state;
    switch (state) {
      case 1:
        clearTimeout(this.gestureTimer);
        this.emit({ type: 'playing' });
        break;
      case 2:
        this.emit({ type: 'paused' });
        break;
      case 3:
        this.emit({ type: 'waiting' });
        break;
      case 0:
        this.emit({ type: 'ended' });
        break;
      default:
        break;
    }
  }

  private onError(code: number): void {
    clearTimeout(this.gestureTimer);
    // YouTube refuses every embed on a page opened by bare IP address (it
    // answers 101/150), so on an IP the video itself is not to blame.
    if (onIpAddress() && [101, 150, 152, 153].includes(code)) {
      this.emit({ type: 'error', reason: 'YouTube does not play videos on a page opened by IP address: open the site by its name', recoverable: true });
      return;
    }
    if ([2, 100, 101, 150].includes(code) && this.currentVideo) this.onBlocked(this.currentVideo);
    this.emit({ type: 'error', reason: ERRORS[code] ?? `YouTube error ${code}`, recoverable: true });
  }

  private applyVolume(): void {
    this.command('setVolume', [Math.round(this.volume * 100)]);
    this.command(this.muted ? 'mute' : 'unMute');
  }

  /** Mobile browsers may refuse to start an embed without a tap inside it. */
  private armGesture(): void {
    clearTimeout(this.gestureTimer);
    const token = this.token;
    this.gestureTimer = setTimeout(() => {
      if (token !== this.token || !this.wantPlay) return;
      if (this.state !== 1 && this.state !== 3) this.listener(token, { type: 'needs-gesture' });
    }, 5000);
  }

  load(source: PlaybackSource, token: number, opts: LoadOptions): void {
    this.token = token;
    this.wantPlay = opts.autoplay;
    this.volume = opts.volume;
    this.muted = opts.muted;
    this.state = -1;
    this.time = opts.startAt;
    this.dur = 0;
    const videoId = source.videoId ?? '';
    this.currentVideo = videoId;
    if (!VIDEO_ID.test(videoId)) {
      queueMicrotask(() => this.listener(token, { type: 'error', reason: 'Invalid YouTube video', recoverable: true }));
      return;
    }
    setEmbedActive('youtube');
    this.emit({ type: 'loading' });
    if (this.frame && this.ready) {
      this.command(opts.autoplay ? 'loadVideoById' : 'cueVideoById', [{ videoId, startSeconds: opts.startAt || 0 }]);
      this.applyVolume();
    } else {
      this.ready = false;
      this.frame = this.makeFrame(videoId, opts);
      ytContainer().replaceChildren(this.frame);
    }
    if (!opts.autoplay) this.emit({ type: 'paused' });
    else this.armGesture();
    // A player that never answers (blocked, offline) counts as a failed source.
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (token === this.token && !this.heard) this.listener(token, { type: 'error', reason: 'YouTube’s player did not respond', recoverable: true });
    }, 15000);
  }

  play(): void {
    this.wantPlay = true;
    this.command('playVideo');
    this.armGesture();
  }

  pause(): void {
    this.wantPlay = false;
    clearTimeout(this.gestureTimer);
    this.command('pauseVideo');
  }

  seek(seconds: number): void {
    this.command('seekTo', [Math.max(0, seconds), true]);
    this.time = seconds;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.command('setVolume', [Math.round(this.volume * 100)]);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.command(muted ? 'mute' : 'unMute');
  }

  stop(): void {
    this.wantPlay = false;
    this.token = -1;
    clearTimeout(this.gestureTimer);
    clearTimeout(this.silenceTimer);
    clearInterval(this.ping);
    this.frame?.remove();
    this.frame = null;
    this.ready = false;
    this.heard = false;
    setEmbedActive(null);
  }

  position(): number {
    return this.time;
  }

  duration(): number {
    return this.dur;
  }
}
