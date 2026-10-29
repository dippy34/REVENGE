import { useState } from 'preact/hooks';
import type { Album, Track } from '../core/types';
import { svc } from '../app/services';
import { link, navigate } from '../app/router';
import type { QueueContext } from '../player/queue';
import { songs } from './hooks';
import { closeDialog, openDialog, type MenuItem } from './overlays';
import { toast } from './toast';

/** Shared user actions used across pages, menus and keyboard shortcuts. */

export function play(tracks: Track[], index: number, context?: QueueContext): void {
  svc().player.playTracks(tracks, index, context);
}

export function artistHref(a: { id?: string; name: string }): string {
  return a.id ? link.artist(a.id) : link.search(a.name);
}

export function addToPlaylist(playlistId: string, tracks: Track[]): void {
  const lib = svc().library;
  const p = lib.getPlaylist(playlistId);
  if (!p) return;
  const added = lib.addToPlaylist(playlistId, tracks);
  if (added === 0) toast(tracks.length === 1 ? `already in “${p.name}”` : `those songs are already in “${p.name}”`);
  else toast(`added ${added === 1 ? 'to' : `${added} songs to`} “${p.name}”`, { tone: 'success', action: { label: 'open', run: () => navigate(link.playlist(p.id)) } });
  if (!lib.saving.value) toast('this browser isn’t saving, so playlists last only until you close it', { tone: 'error' });
}

function NameForm({ initial, initialDesc = '', submit, label, cta }: { initial: string; initialDesc?: string; submit: (name: string, description: string) => void; label: string; cta: string }) {
  const [name, setName] = useState(initial);
  const [desc, setDesc] = useState(initialDesc);
  return (
    <form
      class="m-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) submit(name.trim(), desc.trim());
      }}
    >
      <label class="m-field">
        <span>{`// ${label.toLowerCase()}`}</span>
        <input value={name} maxLength={100} required onInput={(e) => setName((e.target as HTMLInputElement).value)} autoComplete="off" spellcheck={false} />
      </label>
      <label class="m-field">
        <span>// description (optional)</span>
        <textarea value={desc} maxLength={300} rows={2} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
      </label>
      <div class="m-form-actions">
        <button type="button" class="pill" onClick={closeDialog}>
          cancel
        </button>
        <button type="submit" class="pill is-solid">
          {cta.toLowerCase()}
        </button>
      </div>
    </form>
  );
}

export function createPlaylistDialog(tracks: Track[] = [], goTo = !tracks.length): void {
  const count = svc().library.playlists.value.length;
  openDialog('new playlist', () => (
    <NameForm
      initial={`playlist ${String(count + 1).padStart(2, '0')}`}
      label="name"
      cta="create"
      submit={(name, description) => {
        const p = svc().library.createPlaylist(name, tracks, description || undefined);
        closeDialog();
        toast(tracks.length ? `created “${p.name}” with ${songs(tracks.length)}` : `created “${p.name}”`, { tone: 'success' });
        if (goTo) navigate(link.playlist(p.id));
      }}
    />
  ));
}

export function renamePlaylistDialog(id: string): void {
  const p = svc().library.getPlaylist(id);
  if (!p) return;
  openDialog('edit details', () => (
    <NameForm
      initial={p.name}
      initialDesc={p.description}
      label="name"
      cta="save"
      submit={(name, description) => {
        svc().library.updatePlaylist(id, { name, description: description || undefined });
        closeDialog();
      }}
    />
  ));
}

export function confirmDialog(title: string, message: string, cta: string, run: () => void, danger = true): void {
  openDialog(title, (close) => (
    <div class="m-form">
      <p class="m-dialog-text">{`> ${message.toLowerCase()}`}</p>
      <div class="m-form-actions">
        <button type="button" class="pill" onClick={close}>
          cancel
        </button>
        <button
          type="button"
          class={`pill ${danger ? 'is-danger' : 'is-solid'}`}
          onClick={() => {
            close();
            run();
          }}
        >
          {cta}
        </button>
      </div>
    </div>
  ));
}

/** "new playlist…" plus every playlist, for a menu or submenu. */
export function playlistMenu(tracks: Track[]): MenuItem[] {
  const playlists = svc().library.playlists.value;
  return [
    { label: 'new playlist…', icon: 'plus', run: () => createPlaylistDialog(tracks) },
    ...(playlists.length ? [{ separator: true, label: 'sp' } as MenuItem] : []),
    ...playlists.slice(0, 30).map((p) => ({ label: p.name, run: () => addToPlaylist(p.id, tracks) })),
  ];
}

export function trackMenu(track: Track, opts: { playlistId?: string; playlistIndex?: number; queueIndex?: number; context?: QueueContext } = {}): MenuItem[] {
  const s = svc();
  const artists = track.artists.filter((a) => a.name);
  const items: MenuItem[] = [
    { label: 'play', icon: 'play', run: () => play([track], 0, opts.context) },
    { label: 'play next', icon: 'queue', run: () => (s.player.playNext([track]), toast('playing next', { ms: 1800 })) },
    { label: 'add to queue', icon: 'plus', run: () => (s.player.addToQueue([track]), toast('added to the queue', { ms: 1800 })) },
    { separator: true, label: 's1' },
    { label: 'add to playlist', icon: 'library', submenu: playlistMenu([track]) },
  ];
  if (opts.playlistId !== undefined && opts.playlistIndex !== undefined) {
    items.push({ label: 'remove from this playlist', icon: 'trash', run: () => s.library.removeFromPlaylist(opts.playlistId!, opts.playlistIndex!) });
  }
  if (opts.queueIndex !== undefined) {
    items.push({ label: 'remove from queue', icon: 'trash', run: () => s.player.removeFromQueue(opts.queueIndex!) });
  }
  if (artists.length || track.album?.id) items.push({ separator: true, label: 's2' });
  if (artists.length === 1) items.push({ label: 'go to artist', icon: 'user', href: artistHref(artists[0]) });
  else if (artists.length > 1) items.push({ label: 'go to artist', icon: 'user', submenu: artists.map((a) => ({ label: a.name, href: artistHref(a) })) });
  if (track.album?.id) items.push({ label: 'go to album', icon: 'disc', href: link.album(track.album.id) });
  return items;
}

export function albumMenu(album: Album, tracks?: Track[]): MenuItem[] {
  const s = svc();
  const items: MenuItem[] = [];
  if (tracks?.length) {
    items.push({ label: 'add to queue', icon: 'queue', run: () => (s.player.addToQueue(tracks), toast(`added ${songs(tracks.length)} to the queue`)) });
    items.push({ label: 'add to playlist', icon: 'library', submenu: playlistMenu(tracks) });
  }
  if (album.artists[0]) items.push({ label: 'go to artist', icon: 'user', href: artistHref(album.artists[0]) });
  return items;
}
