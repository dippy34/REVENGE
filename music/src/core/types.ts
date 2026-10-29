/**
 * The shapes the server sends. server/music.mjs builds every one of them, so
 * the browser only renders them. Strings are plain text: the UI renders them
 * as text, never as HTML.
 */

/** Where a record comes from: Deezer (the catalog) or Audius (full tracks). */
export type Origin = 'dz' | 'au';

export interface Artwork {
  small?: string;
  medium?: string;
  large?: string;
}

export interface ArtistRef {
  /** `dz:27` or `au:nlGNe` when the artist has a page. */
  id?: string;
  name: string;
}

export interface AlbumRef {
  id?: string;
  title: string;
}

/** Which player implementation can play a source. */
export type EngineId = 'audio' | 'youtube';

/**
 * One way to play a song, as the server decided it (`/api/music/play/{id}`).
 *
 * - `full` + `audio`: a complete file streamed through our server.
 * - `full` + `embed`: YouTube's official no-cookie player. It stays visible
 *   while it plays.
 * - `preview`: a 30-second clip Deezer licenses for previews.
 */
export interface PlaybackSource {
  provider: 'audius' | 'youtube' | 'deezer';
  kind: 'full' | 'preview';
  delivery: 'audio' | 'embed';
  engine: EngineId;
  /** Human label, e.g. "YouTube" or "Deezer preview". */
  label: string;
  url?: string;
  videoId?: string;
  /** Seconds; previews stop here. */
  durationLimit?: number;
}

export type Availability = 'full' | 'embed' | 'preview' | 'unavailable';

export interface Track {
  id: string;
  title: string;
  artists: ArtistRef[];
  album?: AlbumRef;
  /** Seconds. */
  duration?: number;
  artwork?: Artwork;
  explicit?: boolean;
  trackNumber?: number;
  year?: number;
  origin: Origin;
  /** Known before playing for Audius tracks; learned while playing for the rest. */
  availability?: Availability;
}

export interface Artist {
  id: string;
  name: string;
  fans?: number;
  origin: Origin;
}

export type AlbumType = 'album' | 'single' | 'ep' | 'compilation';

export interface Album {
  id: string;
  title: string;
  artists: ArtistRef[];
  artwork?: Artwork;
  year?: number;
  trackCount?: number;
  type?: AlbumType;
  origin: Origin;
  tracks?: Track[];
}

export interface ArtistPage {
  artist: Artist;
  topTracks: Track[];
  albums: Album[];
}

export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

export interface HomePage {
  /** Deezer's chart. */
  tracks: Track[];
  albums: Album[];
  /** Trending on Audius: full tracks. */
  full: Track[];
}
