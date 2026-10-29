import { useEffect, useRef, useState } from 'preact/hooks';
import { href, link, navigate, route } from '../../app/router';
import { api } from '../../core/http';
import type { SearchResults } from '../../core/types';
import { play } from '../actions';
import { Artwork } from '../components/Artwork';
import { Ava } from '../components/Ava';
import { AlbumCard, ArtistCard, EmptyState, ErrorState, Shelf, SkeletonRows } from '../components/Cards';
import { SecHead } from '../components/Fx';
import { TrackList } from '../components/TrackList';
import { formatCount, songs, useAsync, useDebounced } from '../hooks';
import { Icon } from '../icons';

type Filter = 'all' | 'tracks' | 'artists' | 'albums';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'tracks', label: 'songs' },
  { id: 'artists', label: 'artists' },
  { id: 'albums', label: 'albums' },
];

/** ?type= from the address; anything unknown shows everything. */
function readFilter(v: string | null): Filter {
  if (v === 'songs') return 'tracks';
  return FILTERS.some((f) => f.id === v) ? (v as Filter) : 'all';
}

function searchHref(q: string, filter: Filter): string {
  return href('/search', { q: q || undefined, type: q && filter !== 'all' ? filter : undefined });
}

function TopResult({ results, query }: { results: SearchResults; query: string }) {
  const q = query.trim().toLowerCase();
  const track = results.tracks[0];
  // An artist wins only when the query names them and they are not just a
  // namesake of the top song (an obscure act called "Blinding Lights").
  const artist = results.artists.find(
    (a) => a.name.toLowerCase() === q && (!track || track.artists[0]?.name.toLowerCase() === q || (a.fans ?? 0) > 50_000 || track.title.toLowerCase() !== q),
  );
  if (artist) {
    return (
      <a class="m-top-hit" href={link.artist(artist.id)} data-cursor="open">
        <Ava name={artist.name} size="xl" />
        <span class="m-top-hit-k">// artist{artist.fans ? ` · ${formatCount(artist.fans)} fans` : ''}</span>
        <span class="m-top-hit-t">{artist.name}</span>
      </a>
    );
  }
  if (!track) return null;
  return (
    <div class="m-top-hit">
      <Artwork art={track.artwork} seed={track.id} alt="" />
      <span class="m-top-hit-k">// song · {track.artists.map((a) => a.name).join(', ')}</span>
      <span class="m-top-hit-t">{track.title}</span>
      <button type="button" class="pill is-solid" data-cursor="play" aria-label={`Play ${track.title}`} onClick={() => play(results.tracks, 0, { type: 'search', title: `Search: ${query}` })}>
        <Icon name="play" size={14} /> play
      </button>
    </div>
  );
}

export default function Search() {
  const r = route.value;
  const [input, setInput] = useState(r.query.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>(readFilter(r.query.get('type')));
  const query = useDebounced(input.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when navigation changes ?q= (e.g. an artist link with no page).
  useEffect(() => {
    const q = r.query.get('q') ?? '';
    if (q !== input.trim()) setInput(q);
    const t = readFilter(r.query.get('type'));
    if (t !== filter) setFilter(t);
  }, [r.query.toString()]);

  useEffect(() => {
    if (!r.query.get('q')) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query !== (r.query.get('q') ?? '')) navigate(searchHref(query, filter), true);
  }, [query]);

  // One request: the server searches every catalog and merges the answers.
  const found = useAsync((signal) => (query ? api.search(query, signal) : Promise.resolve(null)), [query]);
  const results = query ? (found.data ?? null) : null;
  const loading = !!query && found.loading;
  const ctx = { type: 'search' as const, title: `Search: ${query}` };
  const nothing = results && !loading && !results.tracks.length && !results.artists.length && !results.albums.length;

  return (
    <div class="m-page m-search">
      <form class="m-q-wrap" role="search" onSubmit={(e) => (e.preventDefault(), inputRef.current?.blur())}>
        <div class="m-q">
          <span class="m-prompt" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={inputRef}
            type="search"
            value={input}
            placeholder="search songs, artists, albums"
            aria-label="Search songs, artists and albums"
            autoComplete="off"
            spellcheck={false}
            autocapitalize="off"
            enterKeyHint="search"
            maxLength={120}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          />
          {loading ? <span class="m-spin" aria-label="searching" /> : null}
          {input ? (
            <button type="button" class="ib" aria-label="Clear search" onClick={() => (setInput(''), inputRef.current?.focus())}>
              ×
            </button>
          ) : null}
        </div>
      </form>

      {query ? (
        <div class="m-chips" role="tablist" aria-label="Filter results">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              class={`pill is-small${filter === f.id ? ' is-on' : ''}`}
              onClick={() => {
                setFilter(f.id);
                navigate(searchHref(query, f.id), true);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div aria-live="polite" class="sr">
        {loading ? 'Searching…' : results ? `${songs(results.tracks.length)}, ${results.artists.length} artists, ${results.albums.length} albums` : ''}
      </div>

      {!query ? <EmptyState title="type to search. songs tagged full play all the way through; 30s are previews." /> : null}
      {query && found.error ? <ErrorState message={`${found.error.toLowerCase()}.`} retry={found.reload} /> : null}
      {nothing ? <EmptyState title={`nothing for “${query}”. check the spelling or try fewer words.`} /> : null}
      {loading && !results ? <SkeletonRows count={6} /> : null}

      {results && filter === 'all' ? (
        <>
          {results.tracks.length || results.artists.length ? (
            <div class="m-search-top">
              <section class="m-section">
                <SecHead title="top result" />
                <TopResult results={results} query={query} />
              </section>
              <section class="m-section">
                <SecHead
                  title="songs"
                  count={results.tracks.length}
                  extra={
                    results.tracks.length > 5 ? (
                      <button type="button" class="pill is-small" onClick={() => (setFilter('tracks'), navigate(searchHref(query, 'tracks'), true))}>
                        all
                      </button>
                    ) : null
                  }
                />
                <TrackList tracks={results.tracks} limit={5} context={ctx} showAlbum={false} />
              </section>
            </div>
          ) : null}
          {results.artists.length ? (
            <Shelf title="artists" id="artists" count={results.artists.length}>
              {results.artists.map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
            </Shelf>
          ) : null}
          {results.albums.length ? (
            <Shelf title="albums" id="albums" count={results.albums.length}>
              {results.albums.map((a) => (
                <AlbumCard key={a.id} album={a} />
              ))}
            </Shelf>
          ) : null}
        </>
      ) : null}

      {results && filter === 'tracks' ? <TrackList tracks={results.tracks} context={ctx} /> : null}
      {results && filter === 'artists' ? (
        <div class="m-grid">
          {results.artists.map((a) => (
            <ArtistCard key={a.id} artist={a} />
          ))}
        </div>
      ) : null}
      {results && filter === 'albums' ? (
        <div class="m-grid">
          {results.albums.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
