import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTube, search, channel, videoDetails } from './tube.mjs';

const ID = /^[A-Za-z0-9_-]{11}$/;
const CH = /^UC[A-Za-z0-9_-]{22}$/;

test('search returns videos with real ids', async () => {
  const r = await search('minecraft', 'videos', '');
  assert.ok(r.videos.length >= 5, 'expected several videos, got ' + r.videos.length);
  const v = r.videos[0];
  assert.match(v.id, ID);
  assert.ok(v.title);
  assert.equal(v.isShort, false);
  assert.ok(r.continuation);
});

test('search shorts marks items as shorts', async () => {
  const r = await search('minecraft', 'shorts', '');
  assert.ok(r.videos.length >= 3, 'expected shorts, got ' + r.videos.length);
  assert.ok(r.videos.every((v) => v.isShort === true));
  assert.match(r.videos[0].id, ID);
});

test('channel videos include the channel title', async () => {
  const r = await channel('UC_x5XG1OV2P6uZZ5FSM9Ttw', 'videos', '');
  assert.match(r.channel.title, /google/i);
  assert.ok(r.videos.length >= 5);
  assert.match(r.videos[0].id, ID);
  assert.match(r.videos[0].channelId || 'UC_x5XG1OV2P6uZZ5FSM9Ttw', CH);
});

test('video details for a known id', async () => {
  const list = await videoDetails(['dQw4w9WgXcQ']);
  assert.equal(list.length, 1);
  const v = list[0];
  assert.equal(v.id, 'dQw4w9WgXcQ');
  assert.match(v.title, /never gonna give you up/i);
  assert.match(v.channel, /rick astley/i);
  assert.match(v.channelId, CH);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: JSON.parse(body) });
      });
    }).on('error', reject);
  });
}

test('HTTP handlers match the client contract', async (t) => {
  const tube = createTube();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/tube-search') return tube.handleSearch(req, res);
    if (p === '/api/tube-video') return tube.handleVideo(req, res);
    res.writeHead(404); res.end();
  });
  t.after(() => new Promise((r) => server.close(r)));
  const port = await listen(server);

  const s = await get(port, '/api/tube-search?q=chess&filter=videos');
  assert.equal(s.status, 200);
  assert.equal(s.json.success, true);
  assert.ok(Array.isArray(s.json.videos) && s.json.videos.length > 0);
  assert.match(s.json.videos[0].id, ID);

  const bad = await get(port, '/api/tube-search');
  assert.equal(bad.json.success, false);

  const v = await get(port, '/api/tube-video?ids=dQw4w9WgXcQ');
  assert.equal(v.status, 200);
  assert.equal(v.json.success, true);
  assert.match(v.json.videos[0].title, /never gonna/i);
});
