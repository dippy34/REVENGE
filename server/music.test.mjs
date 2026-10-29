// music.test.mjs: the music backend's page building, song-to-video matching
// and request handling. No network: catalogs and YouTube search are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMusic, dzTrack, dzAlbum, auTrack, img, scoreVideo, pickVideos, clockSeconds, hostOk, isPublic } from './music.mjs';

const ok = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

// Answers by URL path; anything unknown is an empty list.
function stub(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const hit = Object.entries(routes).find(([path]) => u.pathname === path);
    if (!hit) return ok({ data: [] });
    return typeof hit[1] === 'function' ? hit[1](u) : ok(hit[1]);
  };
  return { calls, fetchImpl };
}

async function serve(fetchImpl, ytSearch = async () => ({ videos: [] }), env = {}) {
  const music = createMusic({ env, fetchImpl, ytSearch });
  const server = http.createServer((req, res) => music.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, get: (p, init) => fetch(base + p, init), close: () => new Promise((r) => server.close(r)) };
}

const COVER = 'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg';
const DZ_TRACK = { id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224, readable: true, preview: 'https://cdnt-preview.dzcdn.net/x.mp3', artist: { id: 27, name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery', cover_big: COVER } };

test('shapes Deezer and Audius records into plain text and our own URLs', () => {
  const t = dzTrack(DZ_TRACK);
  assert.equal(t.id, 'dz:3135556');
  assert.deepEqual(t.artists, [{ id: 'dz:27', name: 'Daft Punk' }]);
  assert.deepEqual(t.album, { id: 'dz:302127', title: 'Discovery' });
  assert.equal(t.artwork.medium, `/api/music/img?u=${encodeURIComponent(COVER)}`);
  assert.equal(dzTrack({ ...DZ_TRACK, readable: false }), null, 'unreadable tracks are dropped');
  assert.equal(dzTrack({ id: 'x', title: 'y' }), null);
  const album = dzAlbum({ id: 302127, title: 'Discovery', record_type: 'compile', release_date: '2001-03-07', nb_tracks: 14, artist: { id: 27, name: 'Daft Punk' } });
  assert.equal(album.type, 'compilation');
  assert.equal(album.year, 2001);
  assert.equal(dzTrack({ id: 1, title: 'a\u0000b' }, album).album.title, 'Discovery', 'album tracks borrow the album');
  assert.equal(auTrack({ id: 'D7KyD', title: 'x', is_stream_gated: true }), null, 'gated Audius tracks are dropped');
  const au = auTrack({ id: 'D7KyD', title: 'Lo-fi', duration: 100, user: { id: 'nlGNe', name: 'Someone' }, artwork: { '150x150': 'https://x' } });
  assert.equal(au.availability, 'full');
  assert.equal(au.artwork.small, '/api/music/img/audius/track/D7KyD/150x150');
  assert.equal(img('https://evil.example/x.jpg'), undefined);
  assert.equal(img('http://e-cdns-images.dzcdn.net/x.jpg'), undefined);
});

test('matches a song to the right YouTube video', () => {
  const song = { title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 };
  const topic = { id: 'aaaaaaaaaaa', title: 'Blinding Lights', channel: 'The Weeknd - Topic', duration: '3:20' };
  const video = { id: 'bbbbbbbbbbb', title: 'The Weeknd - Blinding Lights (Official Video)', channel: 'TheWeekndVEVO', duration: '4:22' };
  const live = { id: 'ccccccccccc', title: 'The Weeknd - Blinding Lights (Live)', channel: 'The Weeknd', duration: '3:25' };
  const cover = { id: 'ddddddddddd', title: 'Blinding Lights cover', channel: 'Someone Else', duration: '3:19' };
  const short = { id: 'eeeeeeeeeee', title: 'Blinding Lights', channel: 'The Weeknd', duration: '0:30', isShort: true };
  const other = { id: 'fffffffffff', title: 'Save Your Tears', channel: 'The Weeknd - Topic', duration: '3:35' };
  assert.ok(scoreVideo(topic, song) > scoreVideo(live, song));
  assert.ok(scoreVideo(cover, song) < 1);
  assert.equal(scoreVideo(short, song), -1);
  assert.equal(scoreVideo(other, song), -1);
  assert.deepEqual(pickVideos([cover, short, live, video, topic, other], song), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.deepEqual(pickVideos([{ ...topic, duration: '9:00' }], song), [], 'a very different length is another recording');
  assert.equal(clockSeconds('1:02:03'), 3723);
  assert.equal(clockSeconds('soon'), 0);
});

test('address and host checks', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPublic(ip), false, ip);
  for (const ip of ['1.1.1.1', '2606:4700::1111']) assert.equal(isPublic(ip), true, ip);
  assert.ok(hostOk('cdnt-preview.dzcdn.net', ['*.dzcdn.net']));
  assert.ok(!hostOk('dzcdn.net.evil.com', ['*.dzcdn.net']));
});

test('builds home, search, album and artist pages on the server', async (t) => {
  const { calls, fetchImpl } = stub({
    '/chart/0/tracks': { data: [DZ_TRACK] },
    '/chart/0/albums': { data: [{ id: 302127, title: 'Discovery' }] },
    '/v1/tracks/trending': { data: [{ id: 'D7KyD', title: 'Lo-fi', user: { id: 'nlGNe', name: 'Someone' } }] },
    '/search/track': { data: [DZ_TRACK] },
    '/search/artist': { data: [{ id: 27, name: 'Daft Punk', nb_fan: 5 }] },
    '/album/302127': { id: 302127, title: 'Discovery', nb_tracks: 2, tracks: { data: [{ id: 1, title: 'One More Time' }] } },
    '/album/302127/tracks': { data: [{ id: 1, title: 'One More Time' }, { id: 2, title: 'Aerodynamic' }] },
    '/artist/27': { id: 27, name: 'Daft Punk' },
    '/artist/27/top': { data: [DZ_TRACK] },
  });
  const s = await serve(fetchImpl);
  t.after(s.close);
  const home = await (await s.get('/api/music/home')).json();
  assert.equal(home.tracks[0].id, 'dz:3135556');
  assert.equal(home.albums[0].id, 'dz:302127');
  assert.equal(home.full[0].id, 'au:D7KyD');
  const found = await (await s.get('/api/music/search?q=daft%20punk')).json();
  assert.deepEqual(found.tracks.map((x) => x.id), ['dz:3135556']);
  assert.equal(found.artists[0].name, 'Daft Punk');
  const album = await (await s.get('/api/music/album/dz:302127')).json();
  assert.deepEqual(album.tracks.map((x) => x.title), ['One More Time', 'Aerodynamic'], 'long albums fetch the full track list');
  const artist = await (await s.get('/api/music/artist/dz:27')).json();
  assert.equal(artist.artist.name, 'Daft Punk');
  assert.equal(artist.topTracks.length, 1);
  const before = calls.length;
  await s.get('/api/music/artist/dz:27');
  assert.equal(calls.length, before, 'a repeat page is served from memory');
});

test('decides how a song plays: YouTube first, then the preview', async (t) => {
  const { fetchImpl } = stub({ '/track/3135556': DZ_TRACK });
  const queries = [];
  const ytSearch = async (q) => {
    queries.push(q);
    return { videos: [{ id: 'aaaaaaaaaaa', title: 'Harder, Better, Faster, Stronger', channel: 'Daft Punk - Topic', duration: '3:45' }] };
  };
  const s = await serve(fetchImpl, ytSearch);
  t.after(s.close);
  const res = await s.get('/api/music/play/dz:3135556');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { sources } = await res.json();
  assert.deepEqual(sources.map((x) => [x.engine, x.kind]), [['youtube', 'full'], ['audio', 'preview']]);
  assert.equal(sources[0].videoId, 'aaaaaaaaaaa');
  assert.equal(sources[1].url, '/api/music/audio/deezer/3135556');
  await s.get('/api/music/play/dz:3135556');
  assert.equal(queries.length, 1, 'the video match is remembered');
  assert.deepEqual(queries, ['Daft Punk - Harder, Better, Faster, Stronger']);
  const au = await (await s.get('/api/music/play/au:D7KyD')).json();
  assert.deepEqual(au.sources[0], { provider: 'audius', kind: 'full', delivery: 'audio', engine: 'audio', label: 'Audius', url: '/api/music/audio/audius/D7KyD' });
  const off = await serve(fetchImpl, ytSearch, { MUSIC_DISABLE_YOUTUBE: '1' });
  t.after(off.close);
  assert.deepEqual((await (await off.get('/api/music/play/dz:3135556')).json()).sources.map((x) => x.provider), ['deezer']);
});

test('refuses cross-origin, non-GET, bad ids and odd hosts without calling out', async (t) => {
  const { calls, fetchImpl } = stub({});
  const s = await serve(fetchImpl);
  t.after(s.close);
  assert.equal((await s.get('/api/music/home', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.get('/api/music/home', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await s.get('/api/music/home', { method: 'POST' })).status, 405);
  assert.equal((await s.get('/api/music/search')).status, 400);
  assert.equal((await s.get('/api/music/album/dz:abc')).status, 404);
  assert.equal((await s.get('/api/music/album/au:D7KyD')).status, 404);
  assert.equal((await s.get('/api/music/play/yt:aaaaaaaaaaa')).status, 404);
  assert.equal((await s.get('/api/music/deezer/search?q=x')).status, 404, 'no raw catalog relay any more');
  assert.equal((await s.get(`/api/music/img?u=${encodeURIComponent('https://evil.example/x.jpg')}`)).status, 400);
  assert.equal((await s.get(`/api/music/img?u=${encodeURIComponent('http://169.254.169.254/latest')}`)).status, 400);
  assert.equal((await s.get('/api/music/audio/deezer/..%2F..%2Fetc')).status, 400);
  assert.equal((await s.get('/api/music/audio/archive/x/y.mp3')).status, 400);
  assert.equal(calls.length, 0, 'nothing reached a catalog');
});

test('passes catalog trouble through', async (t) => {
  const { fetchImpl } = stub({
    '/track/1': { error: { type: 'DataException', code: 800 } },
    '/album/2': () => new Response('busy', { status: 429, headers: { 'retry-after': '3' } }),
    '/artist/3': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const s = await serve(fetchImpl);
  t.after(s.close);
  assert.equal((await s.get('/api/music/play/dz:1')).status, 404);
  const busy = await s.get('/api/music/album/dz:2');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '3');
  assert.equal((await s.get('/api/music/artist/dz:3')).status, 502);
});

test('rate limits each visitor', async (t) => {
  const { fetchImpl } = stub({});
  const s = await serve(fetchImpl);
  t.after(s.close);
  let last = 200;
  for (let i = 0; i < 305 && last !== 429; i += 1) last = (await s.get('/api/music/search?q=x')).status;
  assert.equal(last, 429);
});
