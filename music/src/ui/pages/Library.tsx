import { link, navigate, route } from '../../app/router';
import { svc } from '../../app/services';
import { confirmDialog, createPlaylistDialog, renamePlaylistDialog } from '../actions';
import { EmptyState, ErrorState } from '../components/Cards';
import { ActionBar, Hero } from '../components/Hero';
import { TrackList } from '../components/TrackList';
import { formatTotal, songs } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';
import { toast } from '../toast';

/** Your playlists. They live only in this browser. */
export default function Library() {
  const s = svc();
  const playlists = s.library.playlists.value;
  return (
    <div class="m-page">
      <header class="m-page-head">
        <h1 class="m-h1">playlists</h1>
        <div class="m-actions is-tight">
          <button type="button" class="pill is-solid" onClick={() => createPlaylistDialog()}>
            <Icon name="plus" size={15} /> new playlist
          </button>
        </div>
      </header>
      {!s.library.saving.value ? <p class="m-notice is-bad">&gt; this browser isn’t saving data, so playlists last only until you close it.</p> : null}
      {playlists.length ? (
        <ul class="m-list">
          {playlists.map((p, i) => (
            <li key={p.id}>
              <a href={link.playlist(p.id)}>
                <span class="m-list-n">{String(i + 1).padStart(2, '0')}</span>
                <span class="m-list-t">{p.name}</span>
                <span class="m-list-s">{songs(p.tracks.length)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="no playlists yet. they’re saved in this browser only.">
          <button type="button" class="pill is-solid" onClick={() => createPlaylistDialog()}>
            <Icon name="plus" size={15} /> new playlist
          </button>
        </EmptyState>
      )}
    </div>
  );
}

export function PlaylistPage() {
  const id = route.value.params.id;
  const s = svc();
  const playlist = s.library.playlists.value.find((p) => p.id === id);
  if (!playlist) return <ErrorState message="this playlist doesn’t exist in this browser" />;
  const tracks = playlist.tracks;
  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const context = { type: 'playlist' as const, id: playlist.id, title: playlist.name };
  const menu = (anchor: HTMLElement) =>
    openMenu(
      [
        { label: 'edit details', icon: 'edit', run: () => renamePlaylistDialog(id) },
        { label: 'add to queue', icon: 'queue', disabled: !tracks.length, run: () => (s.player.addToQueue(tracks), toast(`added ${songs(tracks.length)} to the queue`)) },
        { separator: true, label: 's' },
        {
          label: 'delete playlist',
          icon: 'trash',
          danger: true,
          run: () =>
            confirmDialog('delete playlist?', `“${playlist.name}” will be deleted from this browser.`, 'delete', () => {
              s.library.deletePlaylist(id);
              navigate('#/library');
              toast('playlist deleted');
            }),
        },
      ],
      anchor,
    );
  return (
    <div class="m-page">
      <Hero
        kicker="playlist"
        title={playlist.name}
        art={tracks.find((t) => t.artwork)?.artwork}
        seed={playlist.id}
        meta={
          <span>
            {songs(tracks.length)}
            {total ? ` · ${formatTotal(total)}` : ''}
          </span>
        }
      >
        {playlist.description ? <p class="m-desc">{playlist.description}</p> : null}
        <button type="button" class="m-textbtn" onClick={() => renamePlaylistDialog(id)}>
          &gt; edit details
        </button>
      </Hero>
      <ActionBar tracks={tracks} context={context}>
        <button type="button" class="ib is-big" aria-label="Playlist options" onClick={(e) => menu(e.currentTarget as HTMLElement)}>
          <Icon name="more" size={20} />
        </button>
      </ActionBar>
      {tracks.length ? (
        <>
          <p class="m-subh">&gt; drag the handle, or focus a song and press alt + up/down, to reorder</p>
          <TrackList tracks={tracks} context={context} playlistId={playlist.id} reorderable onMove={(from, to) => s.library.movePlaylistTrack(id, from, to)} />
        </>
      ) : (
        <EmptyState title="empty. use the + on any song to add it here.">
          <a class="pill" href="#/search">
            &gt; find songs
          </a>
        </EmptyState>
      )}
    </div>
  );
}

export function NotFound() {
  return (
    <EmptyState title="nothing here.">
      <a class="pill" href="#/">
        &gt; home
      </a>
    </EmptyState>
  );
}
