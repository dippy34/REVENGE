import { useRef, useState } from 'preact/hooks';
import { svc } from '../../app/services';
import type { QueueItem } from '../../player/queue';
import { artistHref, trackMenu } from '../actions';
import { Artwork } from '../components/Artwork';
import { AvailabilityBadge } from '../components/TrackList';
import { formatTime } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';

function Row({ item, index, current, onGrip, dragging, drop }: { item: QueueItem; index: number; current?: boolean; onGrip?: (e: PointerEvent) => void; dragging?: boolean; drop?: 'before' | 'after' | null }) {
  const p = svc().player;
  const t = item.track;
  return (
    <div
      class={`m-qrow${current ? ' is-current' : ''}${dragging ? ' is-lifted' : ''}${drop ? ` drop-${drop}` : ''}`}
      role="listitem"
      tabIndex={0}
      data-index={index}
      onDblClick={() => p.jumpTo(index)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') p.jumpTo(index);
        if (e.key === 'Delete' || e.key === 'Backspace') p.removeFromQueue(index);
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const to = index + (e.key === 'ArrowUp' ? -1 : 1);
          const q = p.queue.value;
          if (to > q.index && to < q.items.length) p.moveInQueue(index, to);
        }
      }}
      onContextMenu={(e) => (e.preventDefault(), openMenu(trackMenu(t, { queueIndex: current ? undefined : index }), { x: e.clientX, y: e.clientY }))}
      aria-label={`${t.title} by ${t.artists.map((a) => a.name).join(', ')}`}
    >
      {onGrip ? (
        <span class="m-grip" aria-hidden="true" onPointerDown={(e) => onGrip(e as unknown as PointerEvent)}>
          <Icon name="grip" size={16} />
        </span>
      ) : null}
      <button type="button" class="m-qart" aria-label={`Play ${t.title}`} onClick={() => p.jumpTo(index)}>
        <Artwork art={t.artwork} size="small" seed={t.id} alt="" />
      </button>
      <div class="m-qtext">
        <span class="m-qt">{t.title}</span>
        <span class="m-qa">
          <AvailabilityBadge track={t} compact />
          {t.artists.map((a, i) => (
            <>
              {i ? ', ' : ''}
              <a href={artistHref(a)} tabIndex={-1}>
                {a.name}
              </a>
            </>
          ))}
        </span>
      </div>
      <span class="m-dur">{t.duration ? formatTime(t.duration) : ''}</span>
      {!current ? (
        <button type="button" class="ib m-qx" aria-label={`Remove ${t.title} from queue`} onClick={() => p.removeFromQueue(index)}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** The play queue: now playing, "Next up" (user-queued) and the rest of the context. */
export function QueueView() {
  const p = svc().player;
  const q = p.queue.value;
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const current = q.items[q.index];
  const upcoming = q.items.map((item, i) => ({ item, i })).filter(({ i }) => i > q.index);
  const queued = upcoming.filter(({ item }) => item.queued);
  const rest = upcoming.filter(({ item }) => !item.queued);

  const onGrip = (e: PointerEvent, from: number) => {
    e.preventDefault();
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('.m-qrow[data-index]') ?? [])].filter((r) => Number(r.dataset.index) > q.index);
    let over = from;
    setDrag({ from, over });
    const move = (ev: PointerEvent) => {
      const hit = rows.find((r) => {
        const rect = r.getBoundingClientRect();
        return ev.clientY >= rect.top && ev.clientY < rect.bottom;
      });
      if (hit) over = Number(hit.dataset.index);
      else if (rows.length && ev.clientY > rows[rows.length - 1].getBoundingClientRect().bottom) over = Number(rows[rows.length - 1].dataset.index);
      setDrag({ from, over });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (over !== from) p.moveInQueue(from, over);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const drop = (i: number) => (drag && drag.over === i && drag.from !== i ? (drag.over > drag.from ? 'after' : 'before') : null);

  if (!current) {
    return (
      <div class="m-side-empty">&gt; queue empty_ play something, or use “add to queue” on any song.</div>
    );
  }

  return (
    <div class="m-queue" ref={list}>
      <h3 class="m-qh">// now playing</h3>
      <div role="list" aria-label="Now playing">
        <Row item={current} index={q.index} current />
      </div>
      {queued.length ? (
        <>
          <h3 class="m-qh">// next in queue</h3>
          <div role="list" aria-label="Next in queue">
            {queued.map(({ item, i }) => (
              <Row key={item.uid} item={item} index={i} onGrip={(e) => onGrip(e, i)} dragging={drag?.from === i} drop={drop(i)} />
            ))}
          </div>
        </>
      ) : null}
      {rest.length ? (
        <>
          <div class="m-qh-row">
            <h3 class="m-qh">{`// next from ${(q.context?.title ?? 'your selection').toLowerCase()}`}</h3>
            <button type="button" class="pill is-small" onClick={() => p.clearUpcoming()}>
              clear
            </button>
          </div>
          <div role="list" aria-label="Up next">
            {rest.slice(0, 300).map(({ item, i }) => (
              <Row key={item.uid} item={item} index={i} onGrip={(e) => onGrip(e, i)} dragging={drag?.from === i} drop={drop(i)} />
            ))}
          </div>
          {rest.length > 300 ? <p class="m-qmore">+ {rest.length - 300} more</p> : null}
        </>
      ) : (
        <p class="m-qmore">
          {svc().player.queue.value.repeat === 'all' ? '> repeat is on: the queue starts over after this song' : '> nothing else queued. autoplay can add similar songs (settings)'}
        </p>
      )}
    </div>
  );
}
