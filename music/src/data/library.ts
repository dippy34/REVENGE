import { signal } from '@preact/signals';
import type { Track } from '../core/types';

/**
 * Playlists, saved in this browser only (localStorage). Each playlist keeps a
 * copy of its songs, so it opens and plays without rebuilding anything.
 */

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  tracks: Track[];
  createdAt: number;
  updatedAt: number;
}

const KEY = 'm.playlists';
const MAX_TRACKS = 2000;

/** localStorage that never throws: private windows and full storage just don't save. */
export const store = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key: string, value: unknown): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isTrack(t: unknown): t is Track {
  const o = t as Partial<Track> | null;
  return !!o && typeof o.id === 'string' && /^(dz|au):/.test(o.id) && typeof o.title === 'string' && Array.isArray(o.artists);
}

/** Drops anything in storage that isn't a playlist we wrote. */
export function cleanPlaylists(raw: unknown): Playlist[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.tracks))
    .map((p) => ({
      id: p.id,
      name: String(p.name).slice(0, 100),
      description: typeof p.description === 'string' ? p.description.slice(0, 300) : undefined,
      tracks: p.tracks.filter(isTrack).slice(0, MAX_TRACKS),
      createdAt: Number(p.createdAt) || Date.now(),
      updatedAt: Number(p.updatedAt) || Date.now(),
    }));
}

export class Library {
  readonly playlists = signal<Playlist[]>(cleanPlaylists(store.read(KEY, [])));
  /** False after the browser refused to save (private window, storage full). */
  readonly saving = signal(true);

  private commit(list: Playlist[]): void {
    this.playlists.value = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    this.saving.value = store.write(KEY, this.playlists.value);
  }

  /** Edits one playlist and moves it to the top. */
  private change(id: string, fn: (p: Playlist) => Playlist): void {
    const p = this.getPlaylist(id);
    if (!p) return;
    this.commit([{ ...fn(p), updatedAt: Date.now() }, ...this.playlists.value.filter((x) => x.id !== id)]);
  }

  createPlaylist(name: string, tracks: Track[] = [], description?: string): Playlist {
    const now = Date.now();
    const p: Playlist = { id: uuid(), name: name.slice(0, 100), description, tracks: tracks.slice(0, MAX_TRACKS), createdAt: now, updatedAt: now };
    this.commit([p, ...this.playlists.value]);
    return p;
  }

  getPlaylist(id: string): Playlist | undefined {
    return this.playlists.value.find((p) => p.id === id);
  }

  updatePlaylist(id: string, patch: { name?: string; description?: string }): void {
    this.change(id, (p) => ({ ...p, ...patch }));
  }

  deletePlaylist(id: string): void {
    this.commit(this.playlists.value.filter((p) => p.id !== id));
  }

  /** Adds the songs not already in the playlist; returns how many were added. */
  addToPlaylist(id: string, tracks: Track[]): number {
    const p = this.getPlaylist(id);
    if (!p) return 0;
    const have = new Set(p.tracks.map((t) => t.id));
    const fresh = tracks.filter((t) => !have.has(t.id));
    if (fresh.length) this.change(id, (x) => ({ ...x, tracks: [...x.tracks, ...fresh].slice(0, MAX_TRACKS) }));
    return fresh.length;
  }

  removeFromPlaylist(id: string, index: number): void {
    this.change(id, (p) => ({ ...p, tracks: p.tracks.filter((_, i) => i !== index) }));
  }

  movePlaylistTrack(id: string, from: number, to: number): void {
    this.change(id, (p) => {
      const tracks = [...p.tracks];
      const [moved] = tracks.splice(from, 1);
      if (moved) tracks.splice(Math.max(0, Math.min(tracks.length, to)), 0, moved);
      return { ...p, tracks };
    });
  }

  playlistTracks(id: string): Track[] {
    return this.getPlaylist(id)?.tracks ?? [];
  }
}
