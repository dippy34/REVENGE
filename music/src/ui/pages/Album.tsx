import { route } from '../../app/router';
import { api } from '../../core/http';
import { albumMenu, artistHref, playlistMenu } from '../actions';
import { ErrorState, SkeletonRows } from '../components/Cards';
import { ActionBar, Hero } from '../components/Hero';
import { TrackList } from '../components/TrackList';
import { formatTotal, useAsync } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';

export default function AlbumPage() {
  const id = route.value.params.id;
  const { data: album, loading, error, reload } = useAsync((signal) => api.album(id, signal), [id]);

  if (loading && !album) {
    return (
      <div class="m-page">
        <div class="m-hero is-ghost" />
        <SkeletonRows />
      </div>
    );
  }
  if (error || !album) return <ErrorState message={(error ?? 'this album could not be found').toLowerCase()} retry={reload} />;

  const tracks = album.tracks ?? [];
  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const kind = album.type ?? 'album';
  const context = { type: 'album' as const, id: album.id, title: album.title };

  return (
    <div class="m-page">
      <Hero
        kicker={`${kind}${album.year ? ` · ${album.year}` : ''}`}
        title={album.title}
        art={album.artwork}
        seed={album.id}
        meta={
          <>
            {album.artists.map((a, i) => (
              <>
                {i ? ', ' : ''}
                <a href={artistHref(a)} class="m-strong">
                  {a.name}
                </a>
              </>
            ))}
            {tracks.length ? (
              <span>
                {' '}
                · {tracks.length} song{tracks.length === 1 ? '' : 's'}
                {total ? ` · ${formatTotal(total)}` : ''}
              </span>
            ) : null}
          </>
        }
      />
      <ActionBar tracks={tracks} context={context}>
        {tracks.length ? (
          <button type="button" class="pill" aria-haspopup="menu" onClick={(e) => openMenu(playlistMenu(tracks), e.currentTarget as HTMLElement, 'add to playlist')}>
            <Icon name="plus" size={15} />
            <span>save to playlist</span>
          </button>
        ) : null}
        <button type="button" class="ib is-big" aria-label="More options" onClick={(e) => openMenu(albumMenu(album, tracks), e.currentTarget as HTMLElement)}>
          <Icon name="more" size={20} />
        </button>
      </ActionBar>
      {tracks.length ? <TrackList tracks={tracks} context={context} showAlbum={false} showArt={false} numbered /> : <p class="m-notice">&gt; no track list for this release.</p>}
    </div>
  );
}
