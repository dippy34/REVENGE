import { describe, expect, it } from 'vitest';
import * as Q from '../../src/player/queue';
import type { Track } from '../../src/core/types';

const t = (n: number): Track => ({ id: `au:${n}`, title: `Song ${n}`, artists: [{ name: 'A' }], origin: 'au' });
const tracks = (n: number) => Array.from({ length: n }, (_, i) => t(i + 1));
const ids = (s: Q.QueueState) => s.items.map((i) => i.track.id);
/** Deterministic RNG for shuffle tests. */
const seeded = (seed = 42) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe('queue', () => {
  it('sets a queue starting at an index', () => {
    const s = Q.setQueue(Q.emptyQueue(), tracks(5), 2, { type: 'album', title: 'X' });
    expect(s.index).toBe(2);
    expect(Q.current(s)?.track.id).toBe('au:3');
    expect(Q.upcoming(s).map((i) => i.track.id)).toEqual(['au:4', 'au:5']);
    expect(s.context?.title).toBe('X');
  });

  it('play next inserts right after the current track', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(3), 0);
    s = Q.playNext(s, [t(10)]);
    s = Q.playNext(s, [t(11)]);
    expect(ids(s)).toEqual(['au:1', 'au:11', 'au:10', 'au:2', 'au:3']);
  });

  it('add to queue keeps user-queued items in order before the context', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(3), 0);
    s = Q.addToQueue(s, [t(10)]);
    s = Q.addToQueue(s, [t(11)]);
    expect(ids(s)).toEqual(['au:1', 'au:10', 'au:11', 'au:2', 'au:3']);
    expect(s.items[1].queued).toBe(true);
  });

  it('advances, stops at the end with repeat off', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(2), 0);
    let step = Q.next(s, true);
    expect(step.moved).toBe(true);
    s = step.state;
    expect(s.index).toBe(1);
    step = Q.next(s, true);
    expect(step.moved).toBe(false);
  });

  it('repeat all wraps around; repeat one restarts on auto-advance only', () => {
    let s: Q.QueueState = { ...Q.setQueue(Q.emptyQueue(), tracks(3), 2), repeat: 'all' };
    expect(Q.next(s, true).state.index).toBe(0);
    s = { ...s, repeat: 'one' };
    const auto = Q.next(s, true);
    expect(auto.restart).toBe(true);
    expect(auto.state.index).toBe(2);
    const manual = Q.next({ ...s, index: 0 }, false);
    expect(manual.state.index).toBe(1);
    expect(manual.restart).toBe(false);
  });

  it('cycles repeat off → all → one → off', () => {
    let s = Q.emptyQueue();
    s = Q.cycleRepeat(s);
    expect(s.repeat).toBe('all');
    s = Q.cycleRepeat(s);
    expect(s.repeat).toBe('one');
    s = Q.cycleRepeat(s);
    expect(s.repeat).toBe('off');
  });

  it('previous goes back, or restarts at the first track', () => {
    const s = Q.setQueue(Q.emptyQueue(), tracks(3), 1);
    expect(Q.previous(s).state.index).toBe(0);
    const first = Q.previous({ ...s, index: 0 });
    expect(first.restart).toBe(true);
  });

  it('shuffle keeps the current track and played items, and restores order when turned off', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(8), 2);
    const original = ids(s);
    s = Q.setShuffle(s, true, seeded());
    expect(s.shuffle).toBe(true);
    expect(Q.current(s)?.track.id).toBe('au:3');
    expect(ids(s).slice(0, 3)).toEqual(original.slice(0, 3));
    expect([...ids(s)].sort()).toEqual([...original].sort());
    expect(ids(s)).not.toEqual(original);
    s = Q.setShuffle(s, false);
    expect(ids(s)).toEqual(original);
    expect(Q.current(s)?.track.id).toBe('au:3');
  });

  it('items queued while shuffled survive unshuffling, right after the current track', () => {
    let s = Q.setShuffle(Q.setQueue(Q.emptyQueue(), tracks(5), 0), true, seeded(7));
    s = Q.addToQueue(s, [t(99)]);
    s = Q.setShuffle(s, false);
    expect(ids(s)).toEqual(['au:1', 'au:99', 'au:2', 'au:3', 'au:4', 'au:5']);
  });

  it('setQueue with shuffle on puts the chosen track first', () => {
    const s = Q.setQueue({ ...Q.emptyQueue(), shuffle: true }, tracks(6), 3, undefined, seeded());
    expect(s.index).toBe(0);
    expect(Q.current(s)?.track.id).toBe('au:4');
    expect(s.original).toHaveLength(6);
  });

  it('moves items and keeps the current index pointing at the same track', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(5), 2);
    s = Q.moveItem(s, 4, 0);
    expect(ids(s)).toEqual(['au:5', 'au:1', 'au:2', 'au:3', 'au:4']);
    expect(Q.current(s)?.track.id).toBe('au:3');
    s = Q.moveItem(s, 3, 4);
    expect(Q.current(s)?.track.id).toBe('au:3');
    expect(s.index).toBe(4);
  });

  it('removes items before, at and after the current one', () => {
    let s = Q.setQueue(Q.emptyQueue(), tracks(5), 2);
    s = Q.removeAt(s, 0);
    expect(Q.current(s)?.track.id).toBe('au:3');
    s = Q.removeAt(s, s.index);
    expect(Q.current(s)?.track.id).toBe('au:4');
    s = Q.removeAt(s, 99);
    expect(s.items).toHaveLength(3);
  });

  it('clears upcoming items only', () => {
    const s = Q.clearUpcoming(Q.setQueue(Q.emptyQueue(), tracks(5), 1));
    expect(ids(s)).toEqual(['au:1', 'au:2']);
  });

  it('serializes to ids', () => {
    const s = Q.addToQueue(Q.setQueue(Q.emptyQueue(), tracks(2), 0), [t(3)]);
    const out = Q.serialize(s);
    expect(out.trackIds).toEqual(['au:1', 'au:3', 'au:2']);
    expect(out.queued).toEqual([false, true, false]);
  });
});
