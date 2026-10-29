import { useRef } from 'preact/hooks';
import { svc } from '../../app/services';
import { link } from '../../app/router';
import { artistHref, playlistMenu, trackMenu } from '../actions';
import { Artwork } from '../components/Artwork';
import { Icon } from '../icons';
import { openMenu } from '../overlays';
import { nowPlayingOpen, panel, togglePanel } from '../state';
import { isBusy, PlayButton, ProgressBar, statusText, TransportControls, VolumeControl } from './PlayerControls';

function NowInfo() {
  const p = svc().player;
  const track = p.currentTrack.value;
  if (!track) {
    return (
      <div class="m-now is-empty">
        <span class="m-now-art" aria-hidden="true" />
        <span class="m-now-text">
          <span class="m-now-t">nothing playing_</span>
          <span class="m-now-a">search for a song</span>
        </span>
      </div>
    );
  }
  return (
    <div class="m-now" onContextMenu={(e) => (e.preventDefault(), openMenu(trackMenu(track), { x: e.clientX, y: e.clientY }))}>
      <button type="button" class="m-now-art" aria-label="Open now playing" data-cursor="expand" onClick={() => (nowPlayingOpen.value = true)}>
        <Artwork art={track.artwork} size="small" seed={track.id} alt="" />
      </button>
      <span class="m-now-text">
        {track.album?.id ? (
          <a class="m-now-t" href={link.album(track.album.id)}>
            {track.title}
          </a>
        ) : (
          <span class="m-now-t">{track.title}</span>
        )}
        <span class="m-now-a">
          {track.artists.map((a, i) => (
            <>
              {i ? ', ' : ''}
              <a href={artistHref(a)}>{a.name}</a>
            </>
          ))}
        </span>
      </span>
      <button type="button" class="ib" aria-label="Add to a playlist" aria-haspopup="menu" title="add to playlist" onClick={(e) => openMenu(playlistMenu([track]), e.currentTarget as HTMLElement, 'add to playlist')}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

/** The bottom bar on desktop and tablets. */
export function PlayerBar() {
  const status = statusText();
  const tab = panel.value;
  return (
    <footer class="m-bar" aria-label="Player">
      <NowInfo />
      <div class="m-mid">
        <TransportControls />
        <ProgressBar />
        <div class="m-status" aria-live="polite">
          {status}
        </div>
      </div>
      <div class="m-right">
        <button type="button" class={`ib m-pt${tab === 'nowplaying' ? ' is-on' : ''}`} aria-label="Now playing panel" aria-pressed={tab === 'nowplaying'} title="now playing" onClick={() => togglePanel('nowplaying')}>
          <Icon name="disc" size={17} />
        </button>
        <button type="button" class={`ib m-pt${tab === 'queue' ? ' is-on' : ''}`} aria-label="Queue" aria-pressed={tab === 'queue'} title="queue (q)" onClick={() => togglePanel('queue')}>
          <Icon name="queue" size={17} />
        </button>
        <VolumeControl />
        <button type="button" class="ib" aria-label="Full screen player" title="full screen" onClick={() => (nowPlayingOpen.value = true)}>
          <Icon name="expand" size={17} />
        </button>
      </div>
    </footer>
  );
}

/** Phones: a compact player above the tabs. Swipe left or right to skip, up to open. */
export function MiniPlayer() {
  const p = svc().player;
  const track = p.currentTrack.value;
  const st = p.playback.value;
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  if (!track) return null;
  const pct = st.duration ? Math.min(100, (st.position / st.duration) * 100) : 0;
  return (
    <div
      class={`m-mini${isBusy() ? ' is-busy' : ''}`}
      onPointerDown={(e) => (start.current = { x: e.clientX, y: e.clientY, t: Date.now() })}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 600) {
          if (dx < 0) p.next();
          else p.previous();
        } else if (dy < -40 && Math.abs(dy) > Math.abs(dx)) nowPlayingOpen.value = true;
      }}
    >
      <button type="button" class="m-mini-open" aria-label={`Open now playing: ${track.title}`} onClick={() => (nowPlayingOpen.value = true)}>
        <Artwork art={track.artwork} size="small" seed={track.id} alt="" />
        <span class="m-mini-text">
          <span class="m-mini-t">{track.title}</span>
          <span class="m-mini-a">{statusText() ?? track.artists.map((a) => a.name).join(', ')}</span>
        </span>
      </button>
      <PlayButton size="sm" />
      <span class="m-mini-prog" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
