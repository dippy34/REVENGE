// chat.test.mjs: the chat's routes over real HTTP, with a test owner password.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChat, cleanText } from './chat.mjs';

const OWNER_PW = 'test-' + crypto.randomBytes(6).toString('hex');

// t: the test, so a failed check still closes the server (an open stream
// would keep the run waiting)
async function start(t, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  const chat = createChat(Object.assign({ dir, ownerPassword: OWNER_PW, limits: { saveMs: 10 } }, opts));
  const server = http.createServer((req, res) => chat.handle(req, res));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  let stopped = null;
  const stop = () => stopped || (stopped = (chat.close(), server.closeAllConnections(), new Promise((ok) => server.close(ok))));
  t.after(stop);
  return { dir, chat, base, stop };
}

// one browser: keeps its cookies
function client(base) {
  const jar = {};
  function keep(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  const cookie = () => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async post(p, body) {
      const res = await fetch(`${base}/api/chat/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() }, body: JSON.stringify(body || {}) });
      keep(res);
      return { status: res.status, body: await res.json() };
    },
    async raw(p, type, buf) {
      const res = await fetch(`${base}/api/chat/${p}`, { method: 'POST', headers: { 'content-type': type, cookie: cookie() }, body: buf });
      keep(res);
      return { status: res.status, body: await res.json() };
    },
    async fetch(p) {
      return fetch(`${base}/api/chat/${p}`, { headers: { cookie: cookie() } });
    },
    async get(p) {
      const res = await fetch(`${base}/api/chat/${p}`, { headers: { cookie: cookie() } });
      keep(res);
      return { status: res.status, body: await res.json() };
    },
    // the events of a stream until `until` returns true for one of them
    async events(room, until, ms = 3000) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms);
      const res = await fetch(`${base}/api/chat/stream?room=${room}`, { headers: { cookie: cookie() }, signal: ac.signal });
      if (res.status !== 200) { clearTimeout(timer); return { status: res.status, list: [] }; }
      const list = [];
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.+)$/m.exec(block);
            if (ev && data) list.push({ event: ev[1], data: JSON.parse(data[1]) });
          }
          if (list.some(until)) break;
        }
      } catch (e) { /* timed out */ }
      clearTimeout(timer);
      ac.abort();
      return { status: 200, list };
    }
  };
}

test('names: free, reserved, the owner, taken', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  assert.equal((await a.post('hello', { name: 'zed' })).body.state, 'free');
  assert.equal((await a.post('hello', { name: 'admin' })).body.state, 'bad');
  assert.equal((await a.post('hello', { name: 'a b' })).body.state, 'bad');
  assert.equal((await a.post('hello', { name: '631' })).body.state, 'owner');
  assert.equal((await a.post('guest', { name: 'Zed' })).status, 200);
  const b = client(s.base);
  assert.equal((await b.post('hello', { name: 'zed' })).body.state, 'taken');
  assert.equal((await b.post('guest', { name: 'ZED' })).status, 409);
  await s.stop();
});

test('accounts: sign up, log out, log back in, wrong passwords run out', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  assert.equal((await a.post('signup', { name: 'mira', password: 'abc' })).status, 400); // too short
  const up = await a.post('signup', { name: 'mira', password: 'hunter22' });
  assert.equal(up.status, 200);
  assert.equal(up.body.me.kind, 'account');
  assert.equal((await a.get('me')).body.me.name, 'mira');
  await a.post('logout');
  assert.equal((await a.get('me')).status, 401);
  assert.equal((await client(s.base).post('hello', { name: 'MIRA' })).body.state, 'account');
  assert.equal((await a.post('login', { name: 'mira', password: 'nope' })).status, 401);
  assert.equal((await a.post('login', { name: 'Mira', password: 'hunter22' })).status, 200);
  const c = client(s.base);
  for (let i = 0; i < 6; i++) assert.equal((await c.post('login', { name: 'mira', password: 'x' + i })).status, 401);
  assert.equal((await c.post('login', { name: 'mira', password: 'hunter22' })).status, 429);
  await s.stop();
});

test('a guest claims their name with a password', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  await a.post('guest', { name: 'pip' });
  const c = await a.post('claim', { password: 'secret1' });
  assert.equal(c.body.me.kind, 'account');
  await a.post('logout');
  assert.equal((await a.post('login', { name: 'pip', password: 'secret1' })).status, 200);
  await s.stop();
});

test('the owner signs in as 631 only with the server’s password', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  assert.equal((await a.post('login', { name: '631', password: 'Wrong123' })).status, 401);
  const ok = await a.post('login', { name: '631', password: OWNER_PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.me.owner, true);
  await s.stop();
  const off = await start(t, { ownerPassword: '' });
  assert.equal((await client(off.base).post('login', { name: '631', password: OWNER_PW })).status, 403);
  await off.stop();
});

test('global: messages arrive live with the sender’s title, and are cleaned', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  const o = client(s.base);
  await a.post('guest', { name: 'ann' });
  await o.post('login', { name: '631', password: OWNER_PW });
  const watching = a.events('global', (e) => e.event === 'msg' && e.data.name === '631');
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal((await a.post('send', { room: 'global', text: '  hi‮ there \n\n\n\n yo ' })).status, 200);
  assert.equal((await o.post('send', { room: 'global', text: 'welcome' })).status, 200);
  const { list } = await watching;
  const hello = list.find((e) => e.event === 'hello');
  assert.ok(hello && hello.data.room.global);
  const mine = list.find((e) => e.event === 'msg' && e.data.name === 'ann');
  assert.equal(mine.data.text, 'hi there\n\nyo');
  assert.equal(mine.data.role, 'guest');
  assert.equal(list.find((e) => e.event === 'msg' && e.data.name === '631').data.role, 'owner');
  assert.equal((await a.post('send', { room: 'global', text: 'x'.repeat(900) })).status, 429); // too soon after the last
  await s.stop();
});

test('rooms: public and private, the password, admins and their powers', async (t) => {
  const s = await start(t);
  const boss = client(s.base);
  const kid = client(s.base);
  const own = client(s.base);
  await boss.post('guest', { name: 'boss' });
  await kid.post('guest', { name: 'kid' });
  await own.post('login', { name: '631', password: OWNER_PW });

  const priv = (await boss.post('create', { name: 'secret club', password: 'pw1' })).body.room;
  assert.equal(priv.private, true);
  assert.equal(priv.you.admin, true);
  const pub = (await boss.post('create', { name: 'open room' })).body.room;
  assert.equal(pub.private, false);

  const list = (await kid.get('rooms')).body.rooms;
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.id === priv.id).in, false);
  assert.equal(list.find((r) => r.id === pub.id).in, true);

  assert.equal((await kid.post('join', { room: priv.id })).body.error, 'password');
  assert.equal((await kid.post('join', { room: priv.id, password: 'nope' })).status, 401);
  assert.equal((await kid.events(priv.id, () => true)).status, 403);
  assert.equal((await kid.post('join', { room: priv.id, password: 'pw1' })).status, 200);
  assert.equal((await kid.post('send', { room: priv.id, text: 'in!' })).status, 200);
  // the owner walks in without the password
  assert.equal((await own.post('join', { room: priv.id })).status, 200);
  assert.equal((await own.events(priv.id, (e) => e.event === 'hello')).list[0].data.msgs.length, 1);

  const kidId = (await kid.get('me')).body.me.id;
  const bossId = (await boss.get('me')).body.me.id;
  // not an admin: no powers
  assert.equal((await kid.post('mod', { action: 'kick', room: priv.id, target: bossId })).status, 403);
  // made admin, kid can rename but not remove the creator's admin
  assert.equal((await boss.post('mod', { action: 'admin', room: priv.id, target: kidId })).status, 200);
  assert.equal((await kid.post('mod', { action: 'rename', room: priv.id, name: 'club' })).status, 200);
  assert.equal((await kid.post('mod', { action: 'unadmin', room: priv.id, target: bossId })).status, 403);
  // the creator kicks kid out; kid has to wait
  assert.equal((await boss.post('mod', { action: 'kick', room: priv.id, target: kidId })).status, 200);
  assert.equal((await kid.post('join', { room: priv.id, password: 'pw1' })).body.error, 'kicked');
  // removing the password makes it public
  assert.equal((await boss.post('mod', { action: 'password', room: priv.id, password: '' })).status, 200);
  assert.equal((await kid.get('rooms')).body.rooms.find((r) => r.id === priv.id).private, false);
  // only the creator (or the owner) deletes a room
  assert.equal((await own.post('mod', { action: 'deleteroom', room: pub.id })).status, 200);
  assert.equal((await kid.get('rooms')).body.rooms.length, 1);
  await s.stop();
});

test('the owner warns, mutes and bans; a ban follows the device', async (t) => {
  const s = await start(t);
  const own = client(s.base);
  const bad = client(s.base);
  await own.post('login', { name: '631', password: OWNER_PW });
  await bad.post('guest', { name: 'troll' });
  const id = (await bad.get('me')).body.me.id;
  // only the owner
  const other = client(s.base);
  await other.post('guest', { name: 'other' });
  assert.equal((await other.post('mod', { action: 'ban', target: id })).status, 403);

  assert.equal((await own.post('mod', { action: 'warn', target: id, reason: 'be nice' })).status, 200);
  assert.deepEqual((await bad.get('me')).body.me.warn.reason, 'be nice');
  await bad.post('ack');
  assert.equal((await bad.get('me')).body.me.warn, null);

  assert.equal((await own.post('mod', { action: 'mute', target: id, minutes: 5 })).status, 200);
  assert.equal((await bad.post('send', { room: 'global', text: 'hey' })).body.error, 'muted');
  await own.post('mod', { action: 'unmute', target: id });
  assert.equal((await bad.post('send', { room: 'global', text: 'hey' })).status, 200);

  assert.equal((await own.post('mod', { action: 'ban', target: id, reason: 'spam' })).status, 200);
  assert.equal((await bad.get('me')).body.me.banned.reason, 'spam');
  assert.equal((await bad.post('send', { room: 'global', text: 'hey' })).status, 403);
  // a fresh name from the same device is still banned
  await bad.post('logout');
  assert.equal((await bad.post('guest', { name: 'troll2' })).body.error, 'banned');
  assert.equal((await own.get('bans')).body.bans[0].name, 'troll');
  assert.equal((await other.get('bans')).status, 403);
  await own.post('mod', { action: 'unban', target: id });
  assert.equal((await bad.post('guest', { name: 'troll2' })).status, 200);
  // nobody can ban the owner
  assert.equal((await own.post('mod', { action: 'ban', target: 'owner' })).status, 400);
  await s.stop();
});

// the smallest real PNG: 1x1, one black pixel
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d4944415478da63600000000200015e0c2a2e0000000049454e44ae426082', 'hex');

test('pictures: real images only, served back as images, removable, reset by the owner', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  const own = client(s.base);
  await a.post('guest', { name: 'ivy' });
  await own.post('login', { name: '631', password: OWNER_PW });
  const id = (await a.get('me')).body.me.id;
  assert.equal((await a.raw('picture', 'image/svg+xml', Buffer.from('<svg/>'))).status, 415);
  assert.equal((await a.raw('picture', 'image/png', Buffer.from('<html>not a png</html>'))).status, 400);
  assert.equal((await a.raw('picture', 'image/png', Buffer.alloc(70 * 1024, 1))).status, 413);
  const up = await a.raw('picture', 'image/png', PNG);
  assert.equal(up.status, 200);
  assert.ok(up.body.me.av > 0);
  const got = await a.fetch(`picture?u=${id}&v=${up.body.me.av}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  assert.equal((await a.post('profile', { bio: ' hi\nthere ' })).body.me.bio, 'hi there');
  // the owner resets it
  assert.equal((await own.post('mod', { action: 'wipe', target: id })).status, 200);
  assert.equal((await a.get('me')).body.me.av, 0);
  assert.equal((await a.fetch(`picture?u=${id}&v=1`)).status, 404);
  assert.equal(fs.readdirSync(path.join(s.dir, 'pictures')).length, 0);
  // and people remove their own
  await a.raw('picture', 'image/png', PNG);
  assert.equal((await a.post('profile', { removePicture: true })).body.me.av, 0);
});

test('everything is kept across a restart', async (t) => {
  const s = await start(t);
  const a = client(s.base);
  await a.post('signup', { name: 'keeper', password: 'pass1234' });
  const room = (await a.post('create', { name: 'kept', password: 'k' })).body.room;
  await a.post('send', { room: room.id, text: 'still here' });
  s.chat.flush();
  await s.stop();
  const again = await start(t, { dir: s.dir });
  const b = client(again.base);
  assert.equal((await b.post('login', { name: 'keeper', password: 'pass1234' })).status, 200);
  const hello = (await b.events(room.id, (e) => e.event === 'hello')).list[0];
  assert.equal(hello.data.msgs[0].text, 'still here');
  assert.equal(hello.data.room.you.creator, true);
  await again.stop();
});

test('cleanText keeps text, drops tricks', () => {
  assert.equal(cleanText('a​b', 10), 'ab');
  assert.equal(cleanText('é́́́', 10), 'é́');
  assert.equal(cleanText('one\ntwo', 20, true), 'one two');
  assert.equal(cleanText('😀'.repeat(5), 3), '😀😀😀');
});

test('cross-site posts and wrong content types are refused', async (t) => {
  const s = await start(t);
  const r1 = await fetch(`${s.base}/api/chat/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"name":"x1"}' });
  assert.equal(r1.status, 403);
  const r2 = await fetch(`${s.base}/api/chat/guest`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x1"}' });
  assert.equal(r2.status, 415);
  await s.stop();
});
