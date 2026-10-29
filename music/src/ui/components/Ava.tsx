/**
 * Hex identicons for artists, drawn from the name, the same as the YouTube
 * section's channel avatars: no photos, no faces, one less host.
 */

function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

function prng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const HEX_PTS = '14,1.6 24.74,7.8 24.74,20.2 14,26.4 3.26,20.2 3.26,7.8';
const cell = (x: number, y: number) => `M${(7 + x * 2.8).toFixed(1)} ${(7 + y * 2.8).toFixed(1)}h2.8v2.8h-2.8z`;
const memo = new Map<string, { a: string; b: string }>();

function shape(key: string): { a: string; b: string } {
  const hit = memo.get(key);
  if (hit) return hit;
  const rnd = prng(hash(key));
  let a = '';
  let b = '';
  let on = 0;
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (rnd() < 0.5) continue;
      const d = cell(x, y) + (x < 2 ? cell(4 - x, y) : '');
      if (rnd() < 0.3) b += d;
      else a += d;
      on += 1;
    }
  }
  if (on < 4) a += cell(2, 1) + cell(2, 2) + cell(2, 3) + cell(1, 2) + cell(3, 2);
  const out = { a, b };
  memo.set(key, out);
  return out;
}

export function Ava({ name, size, class: cls }: { name: string; size?: 'xs' | 'md' | 'lg' | 'xl'; class?: string }) {
  const key = String(name || '').trim().toLowerCase();
  const { a, b } = key ? shape(key) : { a: '', b: '' };
  return (
    <svg viewBox="0 0 28 28" class={`ava${size ? ` is-${size}` : ''}${key ? '' : ' is-blank'}${cls ? ` ${cls}` : ''}`} aria-hidden="true" focusable="false">
      <polygon class="ava-hex" points={HEX_PTS} vector-effect="non-scaling-stroke" />
      {a ? <path class="ava-a" d={a} /> : null}
      {b ? <path class="ava-b" d={b} /> : null}
    </svg>
  );
}
