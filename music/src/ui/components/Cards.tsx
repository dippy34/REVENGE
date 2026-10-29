import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { api } from '../../core/http';
import type { Album, Artist, Track } from '../../core/types';
import { link, navigate } from '../../app/router';
import { svc } from '../../app/services';
import { albumMenu, play } from '../actions';
import { formatCount } from '../hooks';
import { Icon } from '../icons';
import { openMenu } from '../overlays';
import { Artwork } from './Artwork';
import { Ava } from './Ava';
import { Empty, Noise, SecHead } from './Fx';
import { AvailabilityBadge } from './TrackList';

/** A titled horizontal row of cards. */
export function Shelf({ title, subtitle, children, href, id, count }: { title: string; subtitle?: string; children: ComponentChildren; href?: string; id?: string; count?: number }) {
  const row = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => row.current?.scrollBy({ left: dir * (row.current.clientWidth - 80), behavior: 'smooth' });
  const headingId = id ? `shelf-${id}` : undefined;
  return (
    <section class="m-shelf" aria-labelledby={headingId}>
      <SecHead
        title={title}
        id={headingId}
        count={count}
        sub={subtitle}
        extra={
          <span class="m-shelf-nav">
            {href ? (
              <a class="m-more-link" href={href}>
                all
              </a>
            ) : null}
            <button type="button" class="ib" aria-label={`Scroll ${title} left`} onClick={() => scroll(-1)}>
              <Icon name="chevronLeft" size={16} />
            </button>
            <button type="button" class="ib" aria-label={`Scroll ${title} right`} onClick={() => scroll(1)}>
              <Icon name="chevronRight" size={16} />
            </button>
          </span>
        }
      />
      <div class="m-shelf-row" ref={row}>
        {children}
      </div>
    </section>
  );
}

function Card({ href, title, sub, cover, onPlay, onMenu, label, kind }: {
  href: string;
  title: string;
  sub?: ComponentChildren;
  cover: ComponentChildren;
  onPlay?: () => void;
  onMenu?: (e: MouseEvent) => void;
  label: string;
  kind?: string;
}) {
  return (
    <article class={`m-card${kind ? ` is-${kind}` : ''}`} onContextMenu={(e) => onMenu && (e.preventDefault(), onMenu(e))}>
      <a class="m-card-link" href={href} aria-label={label} data-cursor="open">
        <div class="m-cover">
          {cover}
          <span class="m-cover-tag" aria-hidden="true">
            &gt; open
          </span>
        </div>
        <h3 class="m-card-title">{title}</h3>
        {sub ? <p class="m-card-sub">{sub}</p> : null}
      </a>
      {onPlay ? (
        <button type="button" class="m-card-play" aria-label={`Play ${title}`} data-cursor="play" onClick={onPlay}>
          <Icon name="play" size={16} />
        </button>
      ) : null}
    </article>
  );
}

export function AlbumCard({ album }: { album: Album }) {
  const playAlbum = async () => {
    const full = album.tracks?.length ? album : await api.album(album.id).catch(() => null);
    if (full?.tracks?.length) play(full.tracks, 0, { type: 'album', id: album.id, title: album.title });
    else navigate(link.album(album.id));
  };
  const kind = album.type === 'single' || album.type === 'ep' ? album.type : 'album';
  return (
    <Card
      href={link.album(album.id)}
      title={album.title}
      label={`${album.title}, ${kind} by ${album.artists.map((a) => a.name).join(', ')}`}
      sub={`${album.year ? `${album.year} · ` : ''}${album.artists.map((a) => a.name).join(', ')}`}
      cover={<Artwork art={album.artwork} seed={album.id} alt="" />}
      onPlay={() => void playAlbum()}
      onMenu={(e) => openMenu(albumMenu(album), { x: e.clientX, y: e.clientY })}
    />
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  return (
    <Card
      href={link.artist(artist.id)}
      title={artist.name}
      label={`${artist.name}, artist`}
      kind="artist"
      sub={artist.fans ? `${formatCount(artist.fans)} fans` : 'artist'}
      cover={
        <div class="m-ava-box">
          <Ava name={artist.name} size="lg" />
        </div>
      }
    />
  );
}

export function TrackCard({ track, tracks, index, context }: { track: Track; tracks: Track[]; index: number; context?: Parameters<typeof play>[2] }) {
  const current = svc().player.currentTrack.value?.id === track.id;
  return (
    <article class={`m-card${current ? ' is-current' : ''}`}>
      <button type="button" class="m-card-link" data-cursor="play" onClick={() => play(tracks, index, context)} aria-label={`Play ${track.title} by ${track.artists.map((a) => a.name).join(', ')}`}>
        <div class="m-cover">
          <Artwork art={track.artwork} seed={track.id} alt="" />
          <span class="m-cover-tag" aria-hidden="true">
            {current ? '> now' : '> play'}
          </span>
        </div>
        <h3 class="m-card-title">{track.title}</h3>
        <p class="m-card-sub">
          <AvailabilityBadge track={track} /> {track.artists.map((a) => a.name).join(', ')}
        </p>
      </button>
    </article>
  );
}

export function SkeletonShelf({ round }: { round?: boolean }) {
  return (
    <section class="m-shelf is-ghost" aria-hidden="true">
      <div class="sec-head">
        <span class="ghost-line is-title" />
        <span class="sec-rule" />
      </div>
      <div class="m-shelf-row">
        {Array.from({ length: 6 }, (_, i) => (
          <div class={`m-card${round ? ' is-artist' : ''}`} key={i}>
            <div class="m-cover ghost-box">{i === 0 ? <Noise /> : null}</div>
            <span class="ghost-line" />
            <span class="ghost-line is-short" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div class="m-rows is-ghost" aria-hidden="true">
      <Noise />
      {Array.from({ length: count }, (_, i) => (
        <div class="m-row" key={i}>
          <span class="m-idx">
            <span class="m-n">{String(i + 1).padStart(2, '0')}</span>
          </span>
          <span class="m-main">
            <span class="ghost-line" />
            <span class="ghost-line is-short" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { icon?: string; title: string; children?: ComponentChildren }) {
  return <Empty text={title.toLowerCase()}>{children}</Empty>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Empty text={message} bad>
      {retry ? (
        <button type="button" class="pill" onClick={retry}>
          <Icon name="history" size={14} /> try again
        </button>
      ) : null}
    </Empty>
  );
}
