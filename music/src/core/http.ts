import type { Album, ArtistPage, HomePage, PlaybackSource, SearchResults } from './types';

/**
 * The only thing the browser talks to: the music backend on this origin
 * (server/music.mjs). It searches, builds every page and decides how each
 * song plays; this file just asks. Answers are cached by the browser for a
 * few minutes (the server sends Cache-Control), so nothing is cached here.
 */

export const API_BASE = '/api/music';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function messageFor(status: number): string {
  if (status === 404) return 'Not found';
  if (status === 429) return 'Too many requests. Wait a moment and try again';
  if (status === 503) return 'The catalog is busy. Try again in a moment';
  return 'The music server couldn’t answer';
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${path}`, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError('Can’t reach the music server', 0);
  }
  if (!res.ok) throw new ApiError(messageFor(res.status), res.status);
  return (await res.json()) as T;
}

const id = (s: string) => encodeURIComponent(s);

export const api = {
  home: (signal?: AbortSignal) => get<HomePage>('home', signal),
  search: (q: string, signal?: AbortSignal) => get<SearchResults>(`search?q=${encodeURIComponent(q)}`, signal),
  album: (albumId: string, signal?: AbortSignal) => get<Album>(`album/${id(albumId)}`, signal),
  artist: (artistId: string, signal?: AbortSignal) => get<ArtistPage>(`artist/${id(artistId)}`, signal),
  /** How a song plays, best first. */
  play: async (trackId: string, signal?: AbortSignal) => (await get<{ sources: PlaybackSource[] }>(`play/${id(trackId)}`, signal)).sources,
};
