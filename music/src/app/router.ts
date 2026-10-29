import { signal } from '@preact/signals';

/**
 * Hash router (#/album/dz:123). Hash URLs work identically on Cloudflare
 * Pages, the Node server and any static host, with no rewrite rules.
 */

export type RouteName = 'home' | 'search' | 'library' | 'playlist' | 'album' | 'artist' | 'notfound';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
  query: URLSearchParams;
  path: string;
}

const PATTERNS: [RouteName, RegExp, string[]][] = [
  ['home', /^\/?$/, []],
  ['search', /^\/search$/, []],
  ['library', /^\/library$/, []],
  ['playlist', /^\/playlist\/([^/]+)$/, ['id']],
  ['album', /^\/album\/([^/]+)$/, ['id']],
  ['artist', /^\/artist\/([^/]+)$/, ['id']],
];

export function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const query = new URLSearchParams(queryPart);
  for (const [name, re, keys] of PATTERNS) {
    const m = path.match(re);
    if (!m) continue;
    const params: Record<string, string> = {};
    keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { name, params, query, path };
  }
  return { name: 'notfound', params: {}, query, path };
}

export const route = signal<Route>(parse(typeof location !== 'undefined' ? location.hash : ''));

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString() : '';
  return `#${path}${q ? `?${q}` : ''}`;
}

export const link = {
  album: (id: string) => href(`/album/${encodeURIComponent(id)}`),
  artist: (id: string) => href(`/artist/${encodeURIComponent(id)}`),
  playlist: (id: string) => href(`/playlist/${encodeURIComponent(id)}`),
  search: (q?: string) => href('/search', { q }),
  artistByName: (name: string) => href('/search', { q: name, type: 'artists' }),
};

export function navigate(hashOrPath: string, replace = false): void {
  const target = hashOrPath.startsWith('#') ? hashOrPath : `#${hashOrPath}`;
  if (replace) {
    history.replaceState(history.state, '', target);
    route.value = parse(target);
  } else if (location.hash !== target) {
    location.hash = target;
  }
}

/** Scroll position per route, restored on back/forward. */
const scrollPositions = new Map<string, number>();
export function rememberScroll(key: string, top: number): void {
  scrollPositions.set(key, top);
  if (scrollPositions.size > 50) scrollPositions.delete(scrollPositions.keys().next().value!);
}
export function recallScroll(key: string): number {
  return scrollPositions.get(key) ?? 0;
}

export function startRouter(): void {
  window.addEventListener('hashchange', () => {
    route.value = parse(location.hash);
  });
}
