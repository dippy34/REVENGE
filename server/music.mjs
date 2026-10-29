// music.mjs: the music player's backend, everything under /api/music/.
//
// The browser only draws pages and plays sound. This server does the rest:
// it searches the catalogs, builds every page (home, search, album, artist),
// decides how each song plays, and streams cover art and audio through
// itself, so catalogs and CDNs see the server's IP, never a visitor's.
//
// How a song plays, best first (play/{id} answers with the list):
//   1. Audius: the full track, for songs that come from Audius
//   2. YouTube's no-cookie player: the full song, found with the YouTube
//      section's own search (tube.mjs). The player stays on screen.
//   3. Deezer: a licensed 30-second preview
//
// Routes (GET/HEAD, same-origin only, per-visitor limits):
//   home                        charts, plus trending full tracks
//   search?q=                   tracks, albums, artists
//   album/{dz:id}               an album and its tracks
//   artist/{dz:id|au:id}        an artist, top tracks, albums
//   play/{dz:id|au:id}          how that song plays
//   img?u=                      Deezer cover art
//   img/audius/track/{id}/{size}
//   audio/audius/{id}           full Audius track (range requests pass through)
//   audio/deezer/{id}           30-second Deezer preview
//
// It is not a general proxy: every catalog URL is built here; media follows
// redirects only to the hosts allowed for that route and only to public
// addresses (checked at connect time); responses must have the expected
// type; images are capped at 8 MB. Nothing is logged or written to disk.
// Catalog answers and video matches stay in memory for minutes to a day.
//
// Env (optional):
//   MUSIC_DISABLE_YOUTUBE=1  songs play from Audius and previews only
import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { clientIp, visitorKey } from './ai.mjs';
import { search as tubeSearch } from './tube.mjs';

const UA = 'm631/1.0';
const AUDIUS_APP = 'm631';
const DEEZER = 'https://api.deezer.com';
const AUDIUS = 'https://api.audius.co/v1';
const JSON_MAX = 2 * 1024 * 1024;
const IMG_MAX = 8 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 600;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const LIMIT_JSON = 300; // per visitor per minute
const LIMIT_MEDIA = 900; // audio seeks are separate range requests
const PREVIEW_SECONDS = 30;
const VIDEO_TTL = 86400; // a song's YouTube match, seconds

const DZ_ID = /^\d{1,15}$/;
const AU_ID = /^[A-Za-z0-9]{2,20}$/;
const IMG_HOSTS = ['cdn-images.dzcdn.net', 'e-cdns-images.dzcdn.net'];
const AUDIO_TYPE = /^(audio\/|application\/octet-stream)/i;

/* ---------- small helpers ---------- */

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({ 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }, headers));
  res.end(body);
}

function json(res, status, value, extra) {
  const body = Buffer.from(JSON.stringify(value));
  send(res, status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 ? 'private, max-age=300' : 'no-store', 'content-length': body.length }, extra), body);
}

class Upstream extends Error {
  constructor(status, error, retry) {
    super(error);
    this.status = status;
    this.retry = retry;
  }
}

/* ---------- address checks ---------- */

const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32]]) PRIVATE.addSubnet(a, p, 'ipv6');

export function isPublic(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) return !PRIVATE.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return !PRIVATE.check(ip, 'ipv6');
  return false;
}

// Resolves and refuses private addresses at connect time.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((a) => isPublic(a.address));
    if (!ok.length) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export function hostOk(host, allow) {
  const h = String(host).toLowerCase();
  return allow.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a));
}

/* ---------- shaping catalog answers ---------- */
// Everything the browser gets is built here, as plain text and our own URLs.

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (v && Array.isArray(v.data) ? v.data : Array.isArray(v) ? v : []);
const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const dzId = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? String(v) : typeof v === 'string' && DZ_ID.test(v) ? v : '');
const auId = (v) => (typeof v === 'string' && AU_ID.test(v) ? v : '');
const yearOf = (v) => {
  const m = /^(\d{4})/.exec(str(v, 20));
  return m ? Number(m[1]) : undefined;
};

/** A Deezer CDN image as a URL on this origin; anything else is dropped. */
export function img(url) {
  if (typeof url !== 'string') return undefined;
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || !hostOk(u.hostname, IMG_HOSTS)) return undefined;
  return `/api/music/img?u=${encodeURIComponent(u.toString())}`;
}

function dzArt(o, prefix) {
  const small = img(o[`${prefix}_medium`]) || img(o[`${prefix}_small`]);
  const medium = img(o[`${prefix}_big`]) || small;
  const large = img(o[`${prefix}_xl`]) || medium;
  return large ? { small: small || medium || large, medium: medium || large, large } : undefined;
}

function md5Art(md5) {
  if (!/^[a-f0-9]{32}$/.test(md5 || '')) return undefined;
  const base = `https://e-cdns-images.dzcdn.net/images/cover/${md5}`;
  return { small: img(`${base}/250x250-000000-80-0-0.jpg`), medium: img(`${base}/500x500-000000-80-0-0.jpg`), large: img(`${base}/1000x1000-000000-80-0-0.jpg`) };
}

function dzPerson(p) {
  const o = obj(p);
  const name = str(o.name);
  if (!name) return null;
  const id = dzId(o.id);
  return id ? { id: `dz:${id}`, name } : { name };
}

export function dzTrack(raw, album) {
  const t = obj(raw);
  const id = dzId(t.id);
  const title = str(t.title);
  if (!id || !title || t.readable === false) return null;
  const a = obj(t.album);
  const people = Array.isArray(t.contributors) && t.contributors.length ? t.contributors : [t.artist];
  const artists = people.map(dzPerson).filter(Boolean);
  const albumId = dzId(a.id) || (album ? album.id.slice(3) : '');
  return {
    id: `dz:${id}`,
    title,
    artists: artists.length ? artists : [{ name: 'Unknown artist' }],
    album: albumId ? { id: `dz:${albumId}`, title: str(a.title) || (album ? album.title : '') } : undefined,
    duration: num(t.duration),
    artwork: dzArt(a, 'cover') || md5Art(t.md5_image || a.md5_image) || (album ? album.artwork : undefined),
    explicit: t.explicit_lyrics === true || undefined,
    trackNumber: num(t.track_position),
    origin: 'dz',
  };
}

const ALBUM_TYPES = { album: 'album', single: 'single', ep: 'ep', compile: 'compilation' };

export function dzAlbum(raw) {
  const a = obj(raw);
  const id = dzId(a.id);
  const title = str(a.title);
  if (!id || !title) return null;
  const artist = dzPerson(a.artist);
  return {
    id: `dz:${id}`,
    title,
    artists: artist ? [artist] : [],
    artwork: dzArt(a, 'cover') || md5Art(a.md5_image),
    year: yearOf(a.release_date),
    trackCount: num(a.nb_tracks),
    type: ALBUM_TYPES[a.record_type] || 'album',
    origin: 'dz',
  };
}

export function dzArtist(raw) {
  const a = obj(raw);
  const id = dzId(a.id);
  const name = str(a.name);
  if (!id || !name) return null;
  return { id: `dz:${id}`, name, fans: num(a.nb_fan), origin: 'dz' };
}

export function auTrack(raw) {
  const t = obj(raw);
  const id = auId(t.id);
  const title = str(t.title);
  if (!id || !title || t.is_streamable === false || t.is_stream_gated === true || t.is_delete === true) return null;
  const user = obj(t.user);
  const userId = auId(user.id);
  const name = str(user.name) || str(user.handle) || 'Unknown artist';
  const art = (size) => `/api/music/img/audius/track/${id}/${size}`;
  return {
    id: `au:${id}`,
    title,
    artists: [userId ? { id: `au:${userId}`, name } : { name }],
    duration: num(t.duration),
    artwork: t.artwork ? { small: art('150x150'), medium: art('480x480'), large: art('1000x1000') } : undefined,
    year: yearOf(t.release_date),
    origin: 'au',
    availability: 'full',
  };
}

export function auArtist(raw) {
  const u = obj(raw);
  const id = auId(u.id);
  const name = str(u.name) || str(u.handle);
  if (!id || !name) return null;
  return { id: `au:${id}`, name, fans: num(u.follower_count), origin: 'au' };
}

/* ---------- matching a song to a YouTube video ---------- */

export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function clockSeconds(s) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// Words that mark a different recording than the one asked for.
const OTHER_TAKE = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'reverb', 'nightcore', '8d', 'reaction', 'tutorial', 'lesson', '1 hour', 'extended', 'acoustic', 'mashup'];

/**
 * How well a YouTube search result matches a song; below 1 is no match.
 * song: { title, artist, duration }
 */
export function scoreVideo(v, song) {
  if (!v || v.isShort || !/^[A-Za-z0-9_-]{11}$/.test(v.id || '')) return -1;
  const title = ` ${fold(v.title)} `;
  const channel = fold(v.channel);
  const words = fold(song.title).split(' ').filter(Boolean);
  if (!words.length) return -1;
  const hit = words.filter((w) => title.includes(` ${w} `)).length / words.length;
  if (hit < 0.6) return -1;
  let score = hit * 2;
  const artist = fold(song.artist);
  // the artist's own channel (also "ArtistVEVO") beats a re-upload that only names them
  if (artist && channel.replace(/ /g, '').includes(artist.replace(/ /g, ''))) score += 2;
  else if (artist && title.includes(` ${artist} `)) score += 0.5;
  else score -= 2;
  if (/ topic$/.test(channel)) score += 3; // YouTube's own "Artist - Topic" audio uploads
  if (/ official (audio|video) | audio /.test(title)) score += 1;
  if (/ lyrics? /.test(title)) score -= 1; // the right recording, but usually not the artist's upload
  const asked = ` ${fold(song.title)} `;
  for (const w of OTHER_TAKE) if (title.includes(` ${w} `) && !asked.includes(` ${w} `)) score -= 4;
  const secs = clockSeconds(v.duration);
  if (song.duration && secs) {
    // music videos often run long with an intro, so up to 90 s is allowed
    const diff = Math.abs(secs - song.duration);
    if (diff > 90) return -1;
    score += diff <= 3 ? 3 : diff <= 10 ? 2 : diff <= 30 ? 0 : -2;
  }
  return score;
}

/** The best two matches, best first. */
export function pickVideos(videos, song) {
  return (Array.isArray(videos) ? videos : [])
    .map((v) => ({ v, s: scoreVideo(v, song) }))
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .map((x) => x.v.id);
}

/* ---------- media ---------- */

export function createMusic({ env = process.env, fetchImpl = (...a) => fetch(...a), ytSearch = tubeSearch } = {}) {
  const cache = new Map();
  let cacheBytes = 0;
  const inflight = new Map();
  const buckets = new Map();
  let bucketReset = Date.now() + 60_000;
  const salt = crypto.randomBytes(16);

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      cache.delete(key);
      cacheBytes -= hit.body.length;
      return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, value) {
    const old = cache.get(key);
    if (old) cacheBytes -= old.body.length;
    cache.set(key, value);
    cacheBytes += value.body.length;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
      const [k, v] = cache.entries().next().value;
      cache.delete(k);
      cacheBytes -= v.body.length;
    }
  }

  // Identical calls in flight share one request.
  function shared(key, run) {
    if (inflight.has(key)) return inflight.get(key);
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function limited(req, kind) {
    const now = Date.now();
    if (now > bucketReset) {
      buckets.clear();
      bucketReset = now + 60_000;
    }
    const id = crypto.createHmac('sha256', salt).update(kind + visitorKey(clientIp(req))).digest('hex').slice(0, 24);
    const n = (buckets.get(id) || 0) + 1;
    buckets.set(id, n);
    return n > (kind === 'media' ? LIMIT_MEDIA : LIMIT_JSON) ? Math.ceil((bucketReset - now) / 1000) : 0;
  }

  /** JSON from a catalog, cached in memory. Throws Upstream on any failure. */
  async function getJson(url, ttl) {
    const hit = cacheGet(url);
    if (hit) return JSON.parse(hit.body.toString('utf8'));
    const body = await shared(url, async () => {
      let r;
      try {
        r = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
      } catch {
        throw new Upstream(502, 'upstream_unreachable');
      }
      if (r.status === 404) throw new Upstream(404, 'not_found');
      if (r.status === 429 || r.status === 503) throw new Upstream(503, 'upstream_busy', r.headers.get('retry-after') || '2');
      if (!r.ok) throw new Upstream(502, 'upstream_error');
      if (!/json|javascript/.test(r.headers.get('content-type') || '')) throw new Upstream(502, 'unexpected_format');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > JSON_MAX) throw new Upstream(502, 'too_large');
      cacheSet(url, { body: buf, expires: Date.now() + ttl * 1000 });
      return buf;
    });
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Upstream(502, 'unexpected_format');
    }
    return data;
  }

  async function deezer(path, params, ttl = 300) {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const data = await getJson(`${DEEZER}/${path}${qs}`, ttl);
    // Deezer answers errors with 200 and an error object.
    const err = obj(data).error;
    if (err) {
      const code = obj(err).code;
      if (code === 800) throw new Upstream(404, 'not_found');
      if (code === 4) throw new Upstream(503, 'upstream_busy', '5');
      throw new Upstream(502, 'upstream_error');
    }
    return data;
  }

  function audius(path, params, ttl = 300) {
    return getJson(`${AUDIUS}/${path}?${new URLSearchParams(Object.assign({}, params, { app_name: AUDIUS_APP }))}`, ttl);
  }

  const settled = (r) => (r.status === 'fulfilled' ? r.value : null);
  function allFailed(results) {
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  }

  /* --- pages --- */

  async function home() {
    const results = await Promise.allSettled([
      deezer('chart/0/tracks', { limit: 30 }, 1800),
      deezer('chart/0/albums', { limit: 18 }, 1800),
      audius('tracks/trending', { limit: 18 }, 1800),
    ]);
    allFailed(results);
    const [tracks, albums, trending] = results.map(settled);
    return {
      tracks: list(tracks).map((t) => dzTrack(t)).filter(Boolean),
      albums: list(albums).map(dzAlbum).filter(Boolean),
      full: list(trending).map(auTrack).filter(Boolean),
    };
  }

  async function search(q) {
    const results = await Promise.allSettled([
      deezer('search/track', { q, limit: 30 }),
      deezer('search/album', { q, limit: 12 }),
      deezer('search/artist', { q, limit: 8 }),
      audius('tracks/search', { query: q, limit: 10 }),
    ]);
    allFailed(results);
    const [tracks, albums, artists, full] = results.map(settled);
    return {
      tracks: [...list(tracks).map((t) => dzTrack(t)), ...list(full).map(auTrack)].filter(Boolean),
      albums: list(albums).map(dzAlbum).filter(Boolean),
      artists: list(artists).map(dzArtist).filter(Boolean),
    };
  }

  async function album(n) {
    const raw = await deezer(`album/${n}`, null, 3600);
    const out = dzAlbum(raw);
    if (!out) throw new Upstream(404, 'not_found');
    let tracks = list(obj(raw).tracks);
    if (out.trackCount && tracks.length < out.trackCount) {
      const more = await deezer(`album/${n}/tracks`, { limit: 500 }, 3600).catch(() => null);
      if (list(more).length) tracks = list(more);
    }
    out.tracks = tracks.map((t) => dzTrack(t, out)).filter(Boolean);
    return out;
  }

  async function artist(prefix, n) {
    if (prefix === 'au') {
      const [user, tracks] = await Promise.all([audius(`users/${n}`, {}, 3600), audius(`users/${n}/tracks`, { limit: 50 }, 3600).catch(() => null)]);
      const a = auArtist(obj(user).data);
      if (!a) throw new Upstream(404, 'not_found');
      return { artist: a, topTracks: list(tracks).map(auTrack).filter(Boolean), albums: [] };
    }
    const [info, top, albums] = await Promise.all([
      deezer(`artist/${n}`, null, 3600),
      deezer(`artist/${n}/top`, { limit: 20 }, 3600).catch(() => null),
      deezer(`artist/${n}/albums`, { limit: 100 }, 3600).catch(() => null),
    ]);
    const a = dzArtist(info);
    if (!a) throw new Upstream(404, 'not_found');
    return { artist: a, topTracks: list(top).map((t) => dzTrack(t)).filter(Boolean), albums: list(albums).map(dzAlbum).filter(Boolean) };
  }

  /** YouTube video ids for a song, best first; [] when nothing matches. */
  async function videosFor(song) {
    if (env.MUSIC_DISABLE_YOUTUBE === '1') return [];
    const key = `yt:${fold(song.artist)}|${fold(song.title)}|${Math.round(song.duration || 0)}`;
    const hit = cacheGet(key);
    if (hit) return JSON.parse(hit.body.toString('utf8'));
    return shared(key, async () => {
      let found;
      try {
        found = await ytSearch(`${song.artist} - ${song.title}`.slice(0, 100), 'videos');
      } catch {
        return []; // not cached: the next play tries again
      }
      const ids = pickVideos(found && found.videos, song);
      cacheSet(key, { body: Buffer.from(JSON.stringify(ids)), expires: Date.now() + VIDEO_TTL * 1000 });
      return ids;
    });
  }

  async function play(prefix, n) {
    if (prefix === 'au') {
      return { sources: [{ provider: 'audius', kind: 'full', delivery: 'audio', engine: 'audio', label: 'Audius', url: `/api/music/audio/audius/${n}` }] };
    }
    const raw = await deezer(`track/${n}`, null, 3600);
    const track = dzTrack(raw);
    if (!track) throw new Upstream(404, 'not_found');
    const sources = [];
    const ids = await videosFor({ title: track.title, artist: track.artists[0].name, duration: track.duration });
    for (const videoId of ids) sources.push({ provider: 'youtube', kind: 'full', delivery: 'embed', engine: 'youtube', label: 'YouTube', videoId });
    if (str(obj(raw).preview, 2000)) {
      sources.push({ provider: 'deezer', kind: 'preview', delivery: 'audio', engine: 'audio', label: 'Deezer preview', url: `/api/music/audio/deezer/${n}`, durationLimit: PREVIEW_SECONDS });
    }
    return { sources };
  }

  /* --- media streaming --- */

  function openUpstream(urlStr, headers, allow, hops = 0) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(urlStr);
      } catch {
        return reject(new Error('bad url'));
      }
      if (u.protocol !== 'https:' || u.username || u.password || !allow(u)) return reject(new Error('host not allowed'));
      const req = https.get(u, { headers, lookup: safeLookup, timeout: 12_000 }, (up) => {
        if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
          up.resume();
          if (hops >= 4) return reject(new Error('too many redirects'));
          return resolve(openUpstream(new URL(up.headers.location, u).toString(), headers, allow, hops + 1));
        }
        resolve(up);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  async function pipeMedia(req, res, url, { allow, kind }) {
    const headers = { 'user-agent': UA, accept: kind === 'image' ? 'image/*' : 'audio/*,*/*;q=0.5' };
    const range = req.headers.range;
    if (kind === 'audio' && typeof range === 'string' && /^bytes=\d{0,15}-\d{0,15}$/.test(range)) headers.range = range;
    let up;
    try {
      up = await openUpstream(url, headers, allow);
    } catch {
      return json(res, 502, { error: 'media_unreachable' });
    }
    const status = up.statusCode || 502;
    if (status === 416) {
      up.resume();
      return send(res, 416, { 'content-range': up.headers['content-range'] || '' }, '');
    }
    if (status !== 200 && status !== 206) {
      up.resume();
      return json(res, status === 404 ? 404 : 502, { error: 'media_error', status });
    }
    let type = String(up.headers['content-type'] || '');
    const ok = kind === 'image' ? /^image\//i.test(type) : AUDIO_TYPE.test(type);
    if (!ok) {
      up.resume();
      return json(res, 502, { error: 'unexpected_media_type' });
    }
    if (kind === 'audio' && /octet-stream/i.test(type)) type = 'audio/mpeg';
    if (kind === 'image' && Number(up.headers['content-length'] || 0) > IMG_MAX) {
      up.destroy();
      return json(res, 502, { error: 'too_large' });
    }
    const out = {
      'content-type': type,
      'cache-control': kind === 'image' ? 'public, max-age=86400' : 'private, max-age=3600',
      'accept-ranges': kind === 'audio' ? 'bytes' : 'none',
    };
    if (up.headers['content-length']) out['content-length'] = up.headers['content-length'];
    if (up.headers['content-range']) out['content-range'] = up.headers['content-range'];
    res.writeHead(status, Object.assign({ 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }, out));
    if (req.method === 'HEAD') {
      up.destroy();
      return res.end();
    }
    let seen = 0;
    up.setTimeout(30_000, () => up.destroy());
    up.on('data', (chunk) => {
      seen += chunk.length;
      if (kind === 'image' && seen > IMG_MAX) up.destroy();
    });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
    up.pipe(res);
  }

  const anyPublic = (u) => u.protocol === 'https:';
  const hosts = (allow) => (u) => hostOk(u.hostname, allow);

  async function media(req, res, parts, sp) {
    const [kind, provider, ...rest] = parts;
    if (kind === 'img' && !provider) {
      const u = sp.get('u') || '';
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        return json(res, 400, { error: 'bad_params' });
      }
      if (u.length > 1200 || parsed.protocol !== 'https:' || !hostOk(parsed.hostname, IMG_HOSTS)) return json(res, 400, { error: 'host_not_allowed' });
      return pipeMedia(req, res, parsed.toString(), { allow: hosts(IMG_HOSTS), kind: 'image' });
    }
    if (kind === 'img' && provider === 'audius') {
      const [type, id, size] = rest;
      if (type !== 'track' || !auId(id) || !['150x150', '480x480', '1000x1000'].includes(size)) return json(res, 400, { error: 'bad_params' });
      const data = await audius(`tracks/${id}`, {}, 3600).catch(() => null);
      const src = obj(obj(obj(data).data).artwork)[size];
      if (typeof src !== 'string') return json(res, 404, { error: 'no_artwork' });
      // Audius artwork lives on operator-run content nodes: any public host, images only.
      return pipeMedia(req, res, src, { allow: anyPublic, kind: 'image' });
    }
    const [id] = rest;
    if (kind === 'audio' && provider === 'audius' && auId(id)) {
      // The API redirects to an operator-run content node: any public host, audio only.
      return pipeMedia(req, res, `${AUDIUS}/tracks/${id}/stream?app_name=${AUDIUS_APP}`, { allow: anyPublic, kind: 'audio' });
    }
    if (kind === 'audio' && provider === 'deezer' && DZ_ID.test(id || '')) {
      // Always a fresh preview link: Deezer signs them for about 15 minutes.
      const data = await deezer(`track/${id}`, null, 120).catch(() => null);
      const preview = str(obj(data).preview, 2000);
      if (!preview) return json(res, 404, { error: 'no_preview' });
      return pipeMedia(req, res, preview, { allow: hosts(['*.dzcdn.net']), kind: 'audio' });
    }
    return json(res, kind === 'audio' || kind === 'img' ? 400 : 404, { error: 'bad_params' });
  }

  /* --- entry point --- */

  function crossOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return true;
      } catch {
        return true;
      }
    }
    const site = req.headers['sec-fetch-site'];
    return !!site && site !== 'same-origin' && site !== 'none';
  }

  /** `dz:123` or `au:AbC` -> [prefix, native id]; null when neither. */
  function splitId(id) {
    const m = /^(dz|au):(.+)$/.exec(id || '');
    if (!m) return null;
    if (m[1] === 'dz' ? !DZ_ID.test(m[2]) : !AU_ID.test(m[2])) return null;
    return [m[1], m[2]];
  }

  async function page(parts, sp) {
    const [name, id] = parts;
    if (name === 'home' && parts.length === 1) return home();
    if (name === 'search' && parts.length === 1) {
      const q = str(sp.get('q'), 120);
      if (!q) throw new Upstream(400, 'bad_params');
      return search(q);
    }
    const ref = parts.length === 2 ? splitId(id) : null;
    if (!ref) throw new Upstream(404, 'not_found');
    if (name === 'album' && ref[0] === 'dz') return album(ref[1]);
    if (name === 'artist') return artist(ref[0], ref[1]);
    if (name === 'play') return play(ref[0], ref[1]);
    throw new Upstream(404, 'not_found');
  }

  async function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD' }, '');
      if (crossOrigin(req)) return json(res, 403, { error: 'cross_origin_forbidden' });
      const url = new URL(req.url, 'http://x');
      let parts;
      try {
        parts = url.pathname.replace(/^\/api\/music\/?/, '').split('/').map((s) => decodeURIComponent(s));
      } catch {
        return json(res, 400, { error: 'bad_path' });
      }
      if (parts.some((p) => p === '..' || p.includes('\0'))) return json(res, 400, { error: 'bad_path' });
      const isMedia = parts[0] === 'img' || parts[0] === 'audio';
      const retry = limited(req, isMedia ? 'media' : 'json');
      if (retry) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(retry) });
      if (isMedia) return await media(req, res, parts, url.searchParams);
      const value = await page(parts, url.searchParams);
      // A song's sources can change (a new video match); pages can be kept a few minutes.
      return json(res, 200, value, parts[0] === 'play' ? { 'cache-control': 'no-store' } : undefined);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof Upstream) return json(res, e.status, { error: e.message }, e.retry ? { 'retry-after': e.retry } : undefined);
      json(res, 500, { error: 'internal_error' });
    }
  }

  return { handle };
}
