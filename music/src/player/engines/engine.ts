import type { EngineId, PlaybackSource } from '../../core/types';

export interface EngineCaps {
  seek: boolean;
  volume: boolean;
  /** Shows video or a widget that must stay visible while playing. */
  visual: boolean;
  /** Keeps playing when the tab is hidden or the screen locks (best effort). */
  background: boolean;
}

export type EngineEvent =
  | { type: 'loading' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'waiting' }
  | { type: 'ended' }
  | { type: 'time'; position: number; duration: number }
  | { type: 'error'; reason: string; recoverable: boolean }
  | { type: 'needs-gesture' };

export interface LoadOptions {
  autoplay: boolean;
  startAt: number;
  volume: number;
  muted: boolean;
}

export type EngineListener = (token: number, event: EngineEvent) => void;

/**
 * A player implementation. Every event is tagged with the token passed to
 * load(), so the controller can ignore events from a previous track.
 */
export interface PlaybackEngine {
  readonly id: EngineId;
  caps(source?: PlaybackSource): EngineCaps;
  load(source: PlaybackSource, token: number, opts: LoadOptions): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** Stops and releases the current media. */
  stop(): void;
  position(): number;
  duration(): number;
  setListener(listener: EngineListener): void;
}
