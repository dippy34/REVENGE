import { describe, expect, it } from 'vitest';
import { currentSource, initialPlayback, reduce, type Action, type PlaybackState } from '../../src/player/machine';
import type { PlaybackSource } from '../../src/core/types';

const src = (provider: PlaybackSource['provider'], kind: 'full' | 'preview' = 'full'): PlaybackSource => ({ provider, kind, delivery: 'audio', engine: 'audio', label: provider, url: `/api/music/audio/${provider}/1` });
const run = (actions: Action[], start: PlaybackState = initialPlayback()) => actions.reduce(reduce, start);

describe('playback state machine', () => {
  it('goes idle → resolving → loading → playing', () => {
    const s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('audius')] },
      { type: 'ENGINE_LOADING', token: 1 },
      { type: 'PLAYING', token: 1 },
    ]);
    expect(s.status).toBe('playing');
    expect(s.trackId).toBe('a');
    expect(currentSource(s)?.provider).toBe('audius');
  });

  it('ignores late results and events from a previous load (rapid switching)', () => {
    const s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'LOAD', token: 2, trackId: 'b', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('deezer')] },
      { type: 'PLAYING', token: 1 },
      { type: 'ENDED', token: 1 },
      { type: 'TIME', token: 1, position: 99 },
    ]);
    expect(s.trackId).toBe('b');
    expect(s.status).toBe('resolving');
    expect(s.candidates).toEqual([]);
    expect(s.position).toBe(0);
  });

  it('never goes backwards to an older token', () => {
    const s = run([
      { type: 'LOAD', token: 5, trackId: 'new', autoplay: true },
      { type: 'LOAD', token: 3, trackId: 'old', autoplay: true },
    ]);
    expect(s.trackId).toBe('new');
  });

  it('fails over to the next candidate on a recoverable error', () => {
    const s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('youtube'), src('deezer', 'preview')] },
      { type: 'SOURCE_FAILED', token: 1, reason: 'embedding disabled', recoverable: true },
    ]);
    expect(s.status).toBe('loading');
    expect(currentSource(s)?.provider).toBe('deezer');
    expect(s.failed.map((f) => f.source.provider)).toEqual(['youtube']);
  });

  it('errors when the last candidate fails', () => {
    const s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('audius')] },
      { type: 'SOURCE_FAILED', token: 1, reason: 'network', recoverable: true },
    ]);
    expect(s.status).toBe('error');
    expect(s.error).toBe('network');
  });

  it('errors with a clear message when nothing can play the track', () => {
    const s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [] },
    ]);
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/No playable source/);
  });

  it('tracks buffering, pause and end', () => {
    let s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('audius')] },
      { type: 'PLAYING', token: 1 },
      { type: 'WAITING', token: 1 },
    ]);
    expect(s.status).toBe('buffering');
    s = run([{ type: 'PLAYING', token: 1 }, { type: 'PAUSED', token: 1 }], s);
    expect(s.status).toBe('paused');
    s = run([{ type: 'ENDED', token: 1 }], s);
    expect(s.status).toBe('ended');
    // A pause after the end does not resurrect the track.
    expect(reduce(s, { type: 'PAUSED', token: 1 }).status).toBe('ended');
  });

  it('records intent and the autoplay-blocked state', () => {
    let s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('youtube')] },
      { type: 'NEEDS_GESTURE', token: 1 },
    ]);
    expect(s.status).toBe('paused');
    expect(s.needsGesture).toBe(true);
    s = reduce(s, { type: 'PAUSE_INTENT' });
    expect(s.intent).toBe('pause');
    s = reduce(s, { type: 'PLAYING', token: 1 });
    expect(s.needsGesture).toBe(false);
  });

  it('lets the user pick another source', () => {
    let s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: false },
      { type: 'RESOLVED', token: 1, candidates: [src('audius'), src('youtube')] },
      { type: 'PLAYING', token: 1 },
    ]);
    s = reduce(s, { type: 'SELECT_SOURCE', token: 1, index: 1 });
    expect(s.status).toBe('loading');
    expect(currentSource(s)?.provider).toBe('youtube');
    expect(s.intent).toBe('play');
    expect(reduce(s, { type: 'SELECT_SOURCE', token: 1, index: 9 })).toBe(s);
  });

  it('STOP resets and invalidates outstanding events', () => {
    let s = run([
      { type: 'LOAD', token: 1, trackId: 'a', autoplay: true },
      { type: 'RESOLVED', token: 1, candidates: [src('audius')] },
    ]);
    s = reduce(s, { type: 'STOP' });
    expect(s.status).toBe('idle');
    expect(reduce(s, { type: 'PLAYING', token: 1 }).status).toBe('idle');
  });
});
