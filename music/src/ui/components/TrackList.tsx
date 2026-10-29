import { useRef, useState } from 'preact/hooks';
import type { Availability, Track } from '../../core/types';
import { svc } from '../../app/services';
import { link } from '../../app/router';
import { availability } from '../../player/controller';
import type { QueueContext } from '../../player/queue';
import { artistHref, play, playlistMenu, trackMenu } from '../actions';
import { formatTime, useMedia } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';
import { Artwork } from './Artwork';

/** Source tags, terminal style: what will actually play. */
const LABELS: Record<Availability, { text: string; title: string; cls: string } | null> = {
  full: { text: 'full', title: 'Full track', cls: 'is-full' },
  embed: { text: 'full', title: 'Full track, played through YouTube', cls: 'is-full' },
  preview: { text: '30s', title: 'Only a 30-second preview was found', cls: 'is-prev' },
  unavailable: { text: 'n/a', title: 'No playable source found', cls: 'is-na' },
};

export function availabilityOf(track: Track): Availability | undefined {
  return availability.value.get(track.id) ?? track.availability;
}

export function AvailabilityBadge({ track }: { track: Track; compact?: boolean }) {
  const known = availabilityOf(track);
  const label = known ? LABELS[known] : null;
  if (!label) return null;
  return (
    <span class={`tag ${label.cls}`} title={label.title}>
      {label.text}
    </span>
  );
}

function Equalizer() {
  return (
    <span class="eq" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

interface Props {
  tracks: Track[];
  context?: QueueContext;
  showAlbum?: boolean;
  showArt?: boolean;
  numbered?: boolean;
  playlistId?: string;
  reorderable?: boolean;
  onMove?: (from: number, to: number) => void;
  limit?: number;
  label?: string;
}

/** Songs as terminal rows, with keyboard support, menus and drag reordering. */
export function TrackList({ tracks, context, showAlbum = true, showArt = true, numbered = false, playlistId, reorderable, onMove, limit, label }: Props) {
  const s = svc();
  const current = s.player.currentTrack.value;
  const st = s.player.playback.value;
  const playing = st.status === 'playing' || st.status === 'buffering' || (st.status === 'loading' && st.intent === 'play');
  const mobile = useMedia('(max-width: 760px)');
  const shown = limit ? tracks.slice(0, limit) : tracks;
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const start = (i: number) => {
    if (current?.id === shown[i].id) s.player.togglePlay();
    else play(tracks, i, context);
  };

  // Pointer-based reordering works with mouse, pen and touch.
  const onGripDown = (e: PointerEvent, from: number) => {
    if (!reorderable || !onMove) return;
    e.preventDefault();
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('.m-row') ?? [])];
    let over = from;
    setDrag({ from, over });
    const move = (ev: PointerEvent) => {
      const y = ev.clientY;
      let idx = rows.findIndex((r) => {
        const rect = r.getBoundingClientRect();
        return y < rect.top + rect.height / 2;
      });
      if (idx < 0) idx = rows.length - 1;
      else if (idx > from) idx -= 1;
      over = Math.max(0, Math.min(rows.length - 1, idx));
      setDrag({ from, over });
      if (y < 90) window.scrollBy(0, -12);
      else if (y > window.innerHeight - 110) window.scrollBy(0, 12);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (over !== from) onMove(from, over);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  if (!shown.length) return null;
  return (
    <div class={`m-rows${showAlbum && !mobile ? ' with-album' : ''}${showArt ? ' with-art' : ''}${reorderable ? ' with-grip' : ''}${drag ? ' is-dragging' : ''}`} role="list" aria-label={label ?? 'songs'} ref={listRef}>
      {shown.map((t, i) => {
        const isCurrent = current?.id === t.id;
        const drop = drag && drag.over === i && drag.from !== i ? (drag.over > drag.from ? ' drop-after' : ' drop-before') : '';
        const n = numbered ? (t.trackNumber ?? i + 1) : i + 1;
        return (
          <div
            key={`${t.id}-${i}`}
            role="listitem"
            class={`m-row${isCurrent ? ' is-current' : ''}${drag?.from === i ? ' is-lifted' : ''}${drop}`}
            onDblClick={() => !mobile && start(i)}
            onClick={(e) => {
              if (mobile && !(e.target as HTMLElement).closest('button, a')) start(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(trackMenu(t, { playlistId, playlistIndex: playlistId ? i : undefined, context }), { x: e.clientX, y: e.clientY }, t.title);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter') start(i);
              if (reorderable && onMove && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
                if (to >= 0 && to < shown.length) {
                  onMove(i, to);
                  requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>('.m-row')[to]?.focus());
                }
              }
            }}
            tabIndex={0}
            aria-current={isCurrent ? 'true' : undefined}
            aria-label={`${t.title} by ${t.artists.map((a) => a.name).join(', ')}`}
          >
            {reorderable ? (
              <span class="m-grip" onPointerDown={(e) => onGripDown(e as unknown as PointerEvent, i)} title="drag to reorder (or alt + up/down)" aria-hidden="true">
                <Icon name="grip" size={16} />
              </span>
            ) : null}
            <span class="m-idx">
              <span class="m-n">{isCurrent && playing ? <Equalizer /> : String(n).padStart(2, '0')}</span>
              {!mobile ? (
                <button type="button" class="m-rowplay" data-cursor={isCurrent && playing ? 'pause' : 'play'} aria-label={isCurrent && playing ? `Pause ${t.title}` : `Play ${t.title}`} onClick={() => start(i)}>
                  <Icon name={isCurrent && playing ? 'pause' : 'play'} size={14} />
                </button>
              ) : null}
            </span>
            {showArt ? <Artwork art={t.artwork} size="small" seed={t.id} class="m-rowart" alt="" /> : null}
            <span class="m-main">
              <span class="m-title">
                {t.title}
                {t.explicit ? (
                  <span class="m-e" title="explicit" aria-label="explicit">
                    e
                  </span>
                ) : null}
              </span>
              <span class="m-sub">
                <AvailabilityBadge track={t} />
                {t.artists.map((a, j) => (
                  <>
                    {j > 0 ? ', ' : ''}
                    {mobile ? (
                      // On phones the whole row plays; artists are in the menu.
                      <span>{a.name}</span>
                    ) : (
                      <a href={artistHref(a)} onClick={(e) => e.stopPropagation()} tabIndex={-1}>
                        {a.name}
                      </a>
                    )}
                  </>
                ))}
              </span>
            </span>
            {showAlbum && !mobile ? (
              <span class="m-alb">
                {t.album?.id ? (
                  <a href={link.album(t.album.id)} tabIndex={-1}>
                    {t.album.title}
                  </a>
                ) : (
                  t.album?.title ?? ''
                )}
              </span>
            ) : null}
            <button
              type="button"
              class="ib m-like"
              aria-label={`Add ${t.title} to a playlist`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                openMenu(playlistMenu([t]), e.currentTarget as HTMLElement, 'add to playlist');
              }}
            >
              <Icon name="plus" size={15} />
            </button>
            <span class="m-dur">{t.duration ? formatTime(t.duration) : ''}</span>
            <button
              type="button"
              class="ib m-more"
              aria-label={`More options for ${t.title}`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                openMenu(trackMenu(t, { playlistId, playlistIndex: playlistId ? i : undefined, context }), e.currentTarget as HTMLElement, t.title);
              }}
            >
              <Icon name="more" size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
