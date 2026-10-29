import type { Track } from './types';

export function primaryArtist(track: Pick<Track, 'artists'>): string {
  return track.artists[0]?.name ?? '';
}

export function artistLine(track: Pick<Track, 'artists'>): string {
  return track.artists.map((a) => a.name).join(', ');
}
