import { useState } from 'preact/hooks';
import type { Artwork as ArtworkT } from '../../core/types';

interface Props {
  art?: ArtworkT;
  size?: 'small' | 'medium' | 'large';
  alt?: string;
  seed: string;
  class?: string;
  eager?: boolean;
}

/**
 * Cover art. Covers keep their colour, like the YouTube section's thumbnails;
 * the interface around them stays black and white. Without a cover: a dark
 * square with a hex digest of the id, in the site's style. Keyed by the id,
 * so a player moving on to the next song drops the old cover at once instead
 * of showing it (or skipping its failed candidates) until the new one loads.
 */
export function Artwork(props: Props) {
  return <Cover key={props.seed} {...props} />;
}

function Cover({ art, size = 'medium', alt = '', seed, class: cls, eager }: Props) {
  const candidates = [size === 'large' ? art?.large : undefined, size !== 'small' ? art?.medium : undefined, art?.small, art?.medium, art?.large].filter(
    (u, i, all): u is string => !!u && all.indexOf(u) === i,
  );
  const [failed, setFailed] = useState(0);
  const [ok, setOk] = useState(false);
  const src = candidates[failed];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const digest = (h >>> 0).toString(16).padStart(8, '0');
  return (
    <div class={`art${cls ? ` ${cls}` : ''}${src && ok ? ' is-ok' : ''}`}>
      {src ? (
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerpolicy="no-referrer"
          onLoad={() => setOk(true)}
          onError={() => {
            setOk(false);
            setFailed((n) => n + 1);
          }}
          draggable={false}
        />
      ) : null}
      {!src || !ok ? (
        <span class="art-none" aria-hidden="true">
          {digest}
        </span>
      ) : null}
    </div>
  );
}
