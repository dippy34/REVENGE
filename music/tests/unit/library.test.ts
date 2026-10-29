import { beforeEach, describe, expect, it } from 'vitest';
import { cleanPlaylists, Library, store } from '../../src/data/library';
import { sanitizeSettings } from '../../src/data/settings';
import type { Track } from '../../src/core/types';

const t = (n: number): Track => ({ id: `dz:${n}`, title: `Song ${n}`, artists: [{ name: `Artist ${n % 3}` }], origin: 'dz', duration: 180 });

beforeEach(() => localStorage.clear());

describe('playlists in this browser', () => {
  it('creates, edits, reorders and deletes playlists, and survives a reload', () => {
    const lib = new Library();
    const p = lib.createPlaylist('Mix', [t(1), t(2)]);
    expect(lib.addToPlaylist(p.id, [t(2), t(3)])).toBe(1); // t(2) is already there
    lib.movePlaylistTrack(p.id, 2, 0);
    expect(lib.playlistTracks(p.id).map((x) => x.id)).toEqual(['dz:3', 'dz:1', 'dz:2']);
    lib.removeFromPlaylist(p.id, 1);
    lib.updatePlaylist(p.id, { name: 'Renamed', description: 'late night' });

    const again = new Library();
    expect(again.getPlaylist(p.id)?.name).toBe('Renamed');
    expect(again.playlistTracks(p.id).map((x) => x.id)).toEqual(['dz:3', 'dz:2']);

    again.deletePlaylist(p.id);
    expect(new Library().playlists.value).toEqual([]);
  });

  it('keeps the most recently changed playlist first', () => {
    const lib = new Library();
    const a = lib.createPlaylist('A');
    lib.createPlaylist('B');
    lib.addToPlaylist(a.id, [t(1)]);
    expect(lib.playlists.value.map((p) => p.name)[0]).toBe('A');
  });

  it('ignores anything in storage it did not write', () => {
    expect(cleanPlaylists('nope')).toEqual([]);
    const cleaned = cleanPlaylists([{ id: 'x', name: 'ok', tracks: [t(1), { id: 'javascript:1', title: 'x', artists: [] }, null] }, { id: 1, name: 'bad', tracks: [] }]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].tracks.map((x) => x.id)).toEqual(['dz:1']);
    store.write('m.playlists', '{');
    expect(new Library().playlists.value).toEqual([]);
  });

  it('says so when the browser refuses to save', () => {
    const lib = new Library();
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      lib.createPlaylist('X');
      expect(lib.saving.value).toBe(false);
      expect(lib.playlists.value).toHaveLength(1); // still usable until the tab closes
    } finally {
      localStorage.setItem = setItem;
    }
  });
});

describe('settings', () => {
  it('keeps only a sane volume and mute flag', () => {
    expect(sanitizeSettings({ volume: 0.3, muted: true, evil: 1 })).toEqual({ volume: 0.3, muted: true });
    expect(sanitizeSettings({ volume: 7 })).toEqual({ volume: 0.8, muted: false });
    expect(sanitizeSettings(null)).toEqual({ volume: 0.8, muted: false });
  });
});
