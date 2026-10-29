import type { PlaybackSource } from '../core/types';

/**
 * Playback state machine.
 *
 * Every load gets a new `token`. Engine events and async results carry the
 * token they belong to, and the reducer drops anything whose token is stale.
 * That is what keeps rapid track switching race-free: a slow resolution or a
 * late "playing" event from the previous track can never change the state of
 * the current one.
 *
 *   idle ──LOAD──▶ resolving ──RESOLVED──▶ loading ──PLAYING──▶ playing ⇄ paused
 *                      │                     │  ▲                 │
 *                      │                     │  └──FAILOVER(next)─┤ (recoverable error)
 *                      └────NO SOURCES───────┴──────▶ error ◀─────┘ (no sources left)
 *   playing ──WAITING──▶ buffering ──PLAYING──▶ playing;  playing ──ENDED──▶ ended
 */

export type Status = 'idle' | 'resolving' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface PlaybackState {
  status: Status;
  token: number;
  trackId?: string;
  candidates: PlaybackSource[];
  candidateIndex: number;
  /** Sources that failed for this track during this load. */
  failed: { source: PlaybackSource; reason: string }[];
  position: number;
  duration: number;
  /** What the user wants: drives autoplay after loading. */
  intent: 'play' | 'pause';
  error?: string;
  /** The embedded player needs a tap inside it before it can start (mobile autoplay rules). */
  needsGesture: boolean;
}

export type Action =
  | { type: 'LOAD'; token: number; trackId: string; autoplay: boolean; position?: number }
  | { type: 'RESOLVED'; token: number; candidates: PlaybackSource[] }
  | { type: 'RESOLVE_FAILED'; token: number; error: string }
  | { type: 'ENGINE_LOADING'; token: number }
  | { type: 'PLAYING'; token: number }
  | { type: 'PAUSED'; token: number }
  | { type: 'WAITING'; token: number }
  | { type: 'TIME'; token: number; position: number; duration?: number }
  | { type: 'ENDED'; token: number }
  | { type: 'SOURCE_FAILED'; token: number; reason: string; recoverable: boolean }
  | { type: 'NEEDS_GESTURE'; token: number }
  | { type: 'SELECT_SOURCE'; token: number; index: number }
  | { type: 'PLAY_INTENT' }
  | { type: 'PAUSE_INTENT' }
  | { type: 'STOP' };

export const initialPlayback = (): PlaybackState => ({
  status: 'idle',
  token: 0,
  candidates: [],
  candidateIndex: 0,
  failed: [],
  position: 0,
  duration: 0,
  intent: 'pause',
  needsGesture: false,
});

export function currentSource(state: PlaybackState): PlaybackSource | undefined {
  return state.candidates[state.candidateIndex];
}

export function reduce(state: PlaybackState, action: Action): PlaybackState {
  // Intents and STOP are not tied to a load.
  switch (action.type) {
    case 'PLAY_INTENT':
      return { ...state, intent: 'play' };
    case 'PAUSE_INTENT':
      return { ...state, intent: 'pause' };
    case 'STOP':
      return { ...initialPlayback(), token: state.token + 1 };
    case 'LOAD':
      if (action.token <= state.token) return state;
      return {
        ...initialPlayback(),
        status: 'resolving',
        token: action.token,
        trackId: action.trackId,
        intent: action.autoplay ? 'play' : 'pause',
        position: action.position ?? 0,
      };
    default:
      break;
  }

  if (action.token !== state.token) return state; // stale event from an earlier load

  switch (action.type) {
    case 'RESOLVED':
      if (state.status !== 'resolving') return state;
      if (!action.candidates.length) return { ...state, status: 'error', candidates: [], error: 'No playable source was found for this song.' };
      return { ...state, status: 'loading', candidates: action.candidates, candidateIndex: 0 };
    case 'RESOLVE_FAILED':
      if (state.status !== 'resolving') return state;
      return { ...state, status: 'error', error: action.error };
    case 'ENGINE_LOADING':
      return state.status === 'error' || state.status === 'ended' ? state : { ...state, status: 'loading', needsGesture: false };
    case 'PLAYING':
      if (state.status === 'resolving' || state.status === 'error') return state;
      return { ...state, status: 'playing', needsGesture: false, error: undefined };
    case 'PAUSED':
      if (state.status === 'resolving' || state.status === 'error' || state.status === 'ended') return state;
      return { ...state, status: 'paused' };
    case 'WAITING':
      if (state.status !== 'playing') return state;
      return { ...state, status: 'buffering' };
    case 'TIME':
      return { ...state, position: action.position, duration: action.duration && action.duration > 0 ? action.duration : state.duration };
    case 'ENDED':
      if (state.status === 'resolving' || state.status === 'error') return state;
      return { ...state, status: 'ended' };
    case 'NEEDS_GESTURE':
      if (state.status === 'playing') return state;
      return { ...state, status: 'paused', needsGesture: true };
    case 'SOURCE_FAILED': {
      const source = currentSource(state);
      const failed = source ? [...state.failed, { source, reason: action.reason }] : state.failed;
      const nextIndex = state.candidateIndex + 1;
      if (action.recoverable && nextIndex < state.candidates.length) {
        return { ...state, status: 'loading', candidateIndex: nextIndex, failed, position: 0, duration: 0, needsGesture: false };
      }
      return { ...state, status: 'error', failed, error: action.reason };
    }
    case 'SELECT_SOURCE':
      if (action.index < 0 || action.index >= state.candidates.length) return state;
      return { ...state, status: 'loading', candidateIndex: action.index, intent: 'play', position: 0, duration: 0, error: undefined, needsGesture: false };
    default:
      return state;
  }
}

export function isActive(state: PlaybackState): boolean {
  return state.status === 'playing' || state.status === 'buffering' || (state.status === 'loading' && state.intent === 'play');
}
