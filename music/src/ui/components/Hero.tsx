import type { ComponentChildren } from 'preact';
import type { Artwork as ArtworkT, Track } from '../../core/types';
import type { QueueContext } from '../../player/queue';
import { svc } from '../../app/services';
import { play } from '../actions';
import { Icon } from '../icons';
import { Artwork } from './Artwork';
import { Ava } from './Ava';
import { useDecode } from './Fx';

/**
 * Page header: "// kind" kicker, a title that decodes in, the cover (or an
 * identicon for artists) and a grayscale glow of the cover behind it, since a
 * cover used as decoration is always gray on this site.
 */
export function Hero({ kicker, title, art, seed, artist, meta, children }: {
  kicker: string;
  title: string;
  art?: ArtworkT;
  seed: string;
  artist?: boolean;
  meta?: ComponentChildren;
  children?: ComponentChildren;
  icon?: string;
}) {
  const ref = useDecode<HTMLHeadingElement>(title);
  const glow = art?.small ?? art?.medium;
  return (
    <header class="m-hero">
      {glow ? (
        <div class="m-hero-glow" aria-hidden="true">
          <img src={glow} alt="" referrerpolicy="no-referrer" />
        </div>
      ) : null}
      <div class="m-hero-art">
        {artist ? (
          <div class="m-ava-box is-hero">
            <Ava name={title} size="xl" />
          </div>
        ) : (
          <Artwork art={art} size="large" seed={seed} alt="" eager />
        )}
      </div>
      <div class="m-hero-text">
        <p class="m-kicker">{`// ${kicker.toLowerCase()}`}</p>
        <h1 class={`m-h1${title.length > 40 ? ' is-long' : ''}`} ref={ref}>
          {title}
        </h1>
        {meta ? <div class="m-meta">{meta}</div> : null}
        {children}
      </div>
    </header>
  );
}

/** Play, shuffle and extra actions for a list of songs. */
export function ActionBar({ tracks, context, children }: { tracks: Track[]; context: QueueContext; children?: ComponentChildren }) {
  const p = svc().player;
  const q = p.queue.value;
  const st = p.playback.value;
  const isThis = !!context.id && q.context?.id === context.id && q.context?.type === context.type;
  const playing = isThis && (st.status === 'playing' || st.status === 'buffering' || (st.status === 'loading' && st.intent === 'play'));
  return (
    <div class="m-actions">
      <button
        type="button"
        class="pill is-solid is-big"
        aria-label={playing ? 'Pause' : `Play ${context.title}`}
        data-cursor={playing ? 'pause' : 'play'}
        disabled={!tracks.length}
        onClick={() => (isThis ? p.togglePlay() : play(tracks, 0, context))}
      >
        <Icon name={playing ? 'pause' : 'play'} size={15} />
        <span>{playing ? 'pause' : 'play'}</span>
      </button>
      <button
        type="button"
        class="pill"
        aria-label={`Shuffle ${context.title}`}
        disabled={!tracks.length}
        onClick={() => {
          if (!p.queue.value.shuffle) p.toggleShuffle();
          play(tracks, Math.floor(Math.random() * tracks.length), context);
        }}
      >
        <Icon name="shuffle" size={15} />
        <span>shuffle</span>
      </button>
      {children}
    </div>
  );
}
