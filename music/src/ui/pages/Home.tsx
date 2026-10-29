import { link } from '../../app/router';
import { svc } from '../../app/services';
import { api } from '../../core/http';
import { play } from '../actions';
import { AlbumCard, ErrorState, Shelf, SkeletonShelf, TrackCard } from '../components/Cards';
import { useDecode } from '../components/Fx';
import { useAsync } from '../hooks';
import { Icon } from '../icons';

/** Home: your playlists, then the server's charts. */
export default function Home() {
  const playlists = svc().library.playlists.value;
  const title = useDecode<HTMLHeadingElement>('music');
  const home = useAsync((signal) => api.home(signal), []);
  const d = home.data;

  return (
    <div class="m-page m-home">
      <header class="m-home-head">
        <h1 class="m-h1" ref={title}>
          music
        </h1>
        <p class="m-lede">&gt; search anything. the server finds it and picks how it plays: full tracks first, 30-second previews last.</p>
      </header>

      <nav class="m-quick" aria-label="your playlists">
        {playlists.slice(0, 4).map((pl, i) => (
          <div key={pl.id} class="m-quick-item">
            <a class="m-quick-link" href={link.playlist(pl.id)}>
              <span class="m-quick-n">{String(i + 1).padStart(2, '0')}</span>
              <span class="m-quick-k">{pl.name}</span>
              <span class="m-quick-c">{pl.tracks.length}</span>
            </a>
            {pl.tracks.length ? (
              <button type="button" class="m-quick-play" aria-label={`Play ${pl.name}`} data-cursor="play" onClick={() => play(pl.tracks, 0, { type: 'playlist', id: pl.id, title: pl.name })}>
                <Icon name="play" size={12} />
              </button>
            ) : null}
          </div>
        ))}
        <div class="m-quick-item">
          <a class="m-quick-link" href="#/library">
            <span class="m-quick-n">{String(Math.min(playlists.length, 4) + 1).padStart(2, '0')}</span>
            <span class="m-quick-k">{playlists.length ? 'all playlists' : 'make a playlist'}</span>
            <span class="m-quick-c">local</span>
          </a>
        </div>
      </nav>

      {home.error && !d ? <ErrorState message={`${home.error.toLowerCase()}.`} retry={home.reload} /> : null}
      {d?.tracks.length ? (
        <Shelf title="top songs" subtitle="> the chart right now" id="chart" count={d.tracks.length}>
          {d.tracks.map((t, i) => (
            <TrackCard key={t.id} track={t} tracks={d.tracks} index={i} context={{ type: 'chart', title: 'Top songs' }} />
          ))}
        </Shelf>
      ) : null}
      {d?.albums.length ? (
        <Shelf title="top albums" id="albums" count={d.albums.length}>
          {d.albums.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </Shelf>
      ) : null}
      {d?.full.length ? (
        <Shelf title="full tracks" subtitle="> trending on audius, free to play in full" id="full" count={d.full.length}>
          {d.full.map((t, i) => (
            <TrackCard key={t.id} track={t} tracks={d.full} index={i} context={{ type: 'chart', title: 'Full tracks' }} />
          ))}
        </Shelf>
      ) : null}
      {home.loading && !d ? (
        <>
          <SkeletonShelf />
          <SkeletonShelf />
        </>
      ) : null}
    </div>
  );
}
