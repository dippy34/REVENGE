import { useState } from 'preact/hooks';
import { route } from '../../app/router';
import { api } from '../../core/http';
import { AlbumCard, ErrorState, Shelf, SkeletonRows } from '../components/Cards';
import { SecHead } from '../components/Fx';
import { ActionBar, Hero } from '../components/Hero';
import { TrackList } from '../components/TrackList';
import { formatCount, useAsync } from '../hooks';

export default function ArtistPage() {
  const id = route.value.params.id;
  const { data, loading, error, reload } = useAsync((signal) => api.artist(id, signal), [id]);
  const [showAll, setShowAll] = useState(false);

  if (loading && !data) {
    return (
      <div class="m-page">
        <div class="m-hero is-ghost" />
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (error || !data) return <ErrorState message={(error ?? 'this artist could not be found').toLowerCase()} retry={reload} />;

  const { artist, topTracks, albums } = data;
  const context = { type: 'artist' as const, id: artist.id, title: artist.name };
  const singles = albums.filter((a) => a.type === 'single' || a.type === 'ep');
  const full = albums.filter((a) => !(a.type === 'single' || a.type === 'ep'));

  return (
    <div class="m-page">
      <Hero kicker={artist.origin === 'au' ? 'artist · audius' : 'artist'} title={artist.name} seed={artist.id} artist meta={artist.fans ? <span>{formatCount(artist.fans)} fans</span> : null} />
      <ActionBar tracks={topTracks} context={context} />
      {topTracks.length ? (
        <section class="m-section">
          <SecHead
            title={artist.origin === 'au' ? 'tracks' : 'popular'}
            count={topTracks.length}
            extra={
              topTracks.length > 5 ? (
                <button type="button" class="pill is-small" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'less' : 'all'}
                </button>
              ) : null
            }
          />
          <TrackList tracks={topTracks} limit={showAll ? 50 : 5} context={context} showAlbum />
        </section>
      ) : null}
      {full.length ? (
        <Shelf title="albums" id="albums" count={full.length}>
          {full.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </Shelf>
      ) : null}
      {singles.length ? (
        <Shelf title="singles & eps" id="singles" count={singles.length}>
          {singles.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </Shelf>
      ) : null}
      {!topTracks.length && !albums.length ? <p class="m-notice">&gt; no songs or releases listed for {artist.name}.</p> : null}
    </div>
  );
}
