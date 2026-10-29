import { useEffect, useRef } from 'preact/hooks';
import { svc } from '../../app/services';
import { link } from '../../app/router';
import type { PlaybackSource } from '../../core/types';
import { artistHref, playlistMenu, trackMenu } from '../actions';
import { Artwork } from '../components/Artwork';
import { fx, useDecode } from '../components/Fx';
import { useMedia } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';
import { nowPlayingOpen, nowPlayingTab, panel, setPanel } from '../state';
import { ProgressBar, statusText, TransportControls, VolumeControl } from './PlayerControls';
import { QueueView } from './QueueView';

function kindLabel(s: PlaybackSource): string {
  return s.kind === 'preview' ? '30s preview' : 'full';
}

/** Where the song is playing from, as the server chose it. */
function SourceNote() {
  const p = svc().player;
  const source = p.source.value;
  const st = p.playback.value;
  if (st.status === 'error') {
    return (
      <p class="m-note is-bad" role="status">
        &gt; {(st.error ?? '').toLowerCase()}
      </p>
    );
  }
  if (!source) return null;
  return (
    <p class={`m-note${source.kind === 'preview' ? ' is-prev' : ''}`}>
      <b>{kindLabel(source)}</b> · {source.label.toLowerCase()}
    </p>
  );
}

const TABS = [
  { id: 'nowplaying', label: 'now' },
  { id: 'queue', label: 'queue' },
] as const;

/** Side panel on wide screens: now / queue. */
export function RightPanel() {
  const tab = panel.value;
  const p = svc().player;
  const track = p.currentTrack.value;
  if (!tab) return null;
  return (
    <aside class="m-side" aria-label="Side panel">
      <div class="m-side-tabs" role="tablist" aria-label="Side panel">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={`m-side-tab${tab === t.id ? ' is-on' : ''}`} onClick={() => setPanel(t.id)}>
            {`[${t.label}]`}
          </button>
        ))}
        <button type="button" class="ib m-side-x" aria-label="Close side panel" onClick={() => setPanel(null)}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div class="m-side-body" role="tabpanel">
        {tab === 'nowplaying' ? (
          track ? (
            <div class="m-side-now">
              <Artwork art={track.artwork} size="large" seed={track.id} alt="" class="m-side-art" />
              <h2 class="m-side-t">{track.title}</h2>
              <p class="m-side-a">
                {track.artists.map((a, i) => (
                  <>
                    {i ? ', ' : ''}
                    <a href={artistHref(a)}>{a.name}</a>
                  </>
                ))}
              </p>
              <SourceNote />
              {track.album?.id ? (
                <a class="m-side-link" href={link.album(track.album.id)}>
                  &gt; {track.album.title}
                </a>
              ) : null}
            </div>
          ) : (
            <div class="m-side-empty">&gt; nothing playing_</div>
          )
        ) : (
          <QueueView />
        )}
      </div>
    </aside>
  );
}

/** Full-screen now playing. On touch screens, swipe down to close. */
export function NowPlaying() {
  const open = nowPlayingOpen.value;
  const p = svc().player;
  const track = p.currentTrack.value;
  const q = p.queue.value;
  const tab = nowPlayingTab.value;
  const desktop = useMedia('(min-width: 761px)');
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; t: number } | null>(null);
  const title = useDecode<HTMLHeadingElement>(open && track ? track.title : '');

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('.m-np-close')?.focus();
    fx()?.hold(true); // freeze the rain behind a full-screen layer
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.m-menu, .m-dialog')) nowPlayingOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      fx()?.hold(false);
      prev?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (open && !track) nowPlayingOpen.value = false;
  }, [open, track]);

  if (!open || !track) return null;
  const status = statusText();
  const glow = track.artwork?.small ?? track.artwork?.medium;

  return (
    <div
      class="m-np"
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title}`}
      ref={ref}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.m-slider, .m-np-sheet, button, a')) return;
        start.current = { y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (s && e.clientY - s.y > 90 && Date.now() - s.t < 700) nowPlayingOpen.value = false;
      }}
    >
      {glow ? (
        <div class="m-np-glow" aria-hidden="true">
          <img src={glow} alt="" referrerpolicy="no-referrer" />
        </div>
      ) : null}
      <header class="m-np-head">
        <button type="button" class="ib m-np-close" aria-label="Close now playing" onClick={() => (nowPlayingOpen.value = false)}>
          <Icon name="chevronDown" size={22} />
        </button>
        <p class="m-np-ctx">
          <span>// playing from</span>
          <b>{(q.context?.title ?? 'your queue').toLowerCase()}</b>
        </p>
        <button type="button" class="ib" aria-label="More options" onClick={(e) => openMenu(trackMenu(track), e.currentTarget as HTMLElement)}>
          <Icon name="more" size={20} />
        </button>
      </header>
      <div class={`m-np-body${tab && desktop ? ' with-side' : ''}`}>
        <div class="m-np-main">
          <div class="m-np-visual">
            <Artwork art={track.artwork} size="large" seed={track.id} alt="" eager />
          </div>
          <div class="m-np-meta">
            <div class="m-np-text">
              <h2 class="m-np-t" ref={title}>
                {track.title}
              </h2>
              <p class="m-np-a">
                {track.artists.map((a, i) => (
                  <>
                    {i ? ', ' : ''}
                    <a href={artistHref(a)} onClick={() => (nowPlayingOpen.value = false)}>
                      {a.name}
                    </a>
                  </>
                ))}
              </p>
            </div>
            <button type="button" class="ib is-big" aria-label="Add to a playlist" aria-haspopup="menu" onClick={(e) => openMenu(playlistMenu([track]), e.currentTarget as HTMLElement, 'add to playlist')}>
              <Icon name="plus" size={22} />
            </button>
          </div>
          <ProgressBar />
          <TransportControls size="lg" />
          <div class="m-np-status" aria-live="polite">
            {status}
          </div>
          <div class="m-np-tools">
            {desktop ? <VolumeControl /> : null}
            <span class="m-np-tabs">
              <button type="button" class={`pill${tab === 'queue' ? ' is-on' : ''}`} aria-pressed={tab === 'queue'} onClick={() => (nowPlayingTab.value = tab === 'queue' ? null : 'queue')}>
                queue
              </button>
            </span>
          </div>
          <SourceNote />
        </div>
        {tab ? (
          <div class="m-np-sheet" role="region" aria-label={tab}>
            {!desktop ? (
              <div class="m-np-sheet-head">
                <b>{`// ${tab}`}</b>
                <button type="button" class="ib" aria-label="Close" onClick={() => (nowPlayingTab.value = null)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : null}
            <QueueView />
          </div>
        ) : null}
      </div>
    </div>
  );
}
