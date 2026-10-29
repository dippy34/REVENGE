// chat.mjs: the chat (site/chat/, "chat" under the menu's other). One global
// room, rooms anyone can open (public, or private behind a password), guests
// and accounts, room admins, and the owner (the 631 account) with powers over
// the whole chat.
//
//   POST /api/chat/hello    {name}             is it free, an account, the owner or in use?
//   POST /api/chat/guest    {name}             chat under a name, no password
//   POST /api/chat/signup   {name, password}   a name of your own (an account)
//   POST /api/chat/login    {name, password}   back into an account; 631 is the owner
//   POST /api/chat/claim    {password}         a guest keeps their name as an account
//   POST /api/chat/logout
//   GET  /api/chat/me                          who you are (401 when nobody)
//   POST /api/chat/profile  {bio, removePicture?}
//   POST /api/chat/picture  the raw image (PNG, JPEG or WebP, 64 KB at most)
//   GET  /api/chat/picture?u=&v=               someone's picture
//   GET  /api/chat/rooms                       the room list
//   POST /api/chat/create   {name, password?}  you become its admin
//   POST /api/chat/join     {room, password?}  a private room asks once
//   POST /api/chat/send     {room, text}
//   GET  /api/chat/stream?room=                server-sent events for one room
//   GET  /api/chat/user?id=&room=              a profile card
//   GET  /api/chat/bans                        the owner's list of banned people
//   POST /api/chat/mod      {action, ...}      room admins and the owner (see mod())
//   POST /api/chat/ack                         a warning was read
//
// Signing in sets an HttpOnly session cookie (chat_s); another (chat_d) marks
// the device, so a ban covers the devices the person used. Bans never go by
// IP address: a whole school shares one.
//
// Kept in <dir>/chat.json (written a few seconds after a change): accounts
// (name, scrypt hash, bio), guests (until a week unseen), hashed sessions,
// rooms with their last 100 messages, bans, warnings and mutes; people's
// pictures sit beside it in pictures/ (one per person, 64 KB at most, the
// page shrinks them to a square before sending). Nothing else is logged.
//
// The owner signs in as 631 with ownerPassword (CHAT_OWNER_PASSWORD on the
// server, never in this repository). Without one, nobody can sign in as 631.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clientIp, visitorKey } from './ai.mjs';

// Pictures are only ever served as one of these, never sniffed or as markup
// (so no SVG): the first bytes must match the type sent.
const PICTURE_TYPES = {
  'image/png': { ext: 'png', ok: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  'image/jpeg': { ext: 'jpg', ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', ok: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' }
};
const USER_ID = /^(u[0-9a-f]{16}|owner)$/;
export const OWNER = 'owner'; // the owner's user id
const OWNER_NAME = '631';
const GLOBAL = 'global';
const RESERVED = new Set(['631', 'owner', 'admin', 'admins', 'mod', 'mods', 'moderator', 'system', 'staff', 'guest', 'everyone', 'kyrie', 'chat']);
const NAME_OK = /^[A-Za-z0-9_.-]{2,20}$/;
const ROOM_ID = /^[a-z0-9]{10}$/;

export const LIMITS = {
  msgLen: 500, msgLines: 12, bioLen: 120, roomName: 32, reasonLen: 200, keep: 100,
  burst: 5, burstMs: 5000, gapMs: 350,      // messages per person
  roomsPerUser: 5, rooms: 300,
  streamsPerUser: 8,
  guestTtl: 7 * 864e5, sessionTtl: 30 * 864e5, roomTtl: 14 * 864e5,
  tries: 6, triesMs: 15 * 60e3,             // wrong passwords per name (or room) and visitor
  ownerTries: 30, ownerTriesMs: 60 * 60e3,  // wrong owner passwords from everyone together
  signups: 120, signupsMs: 60 * 60e3,       // new names per visitor (a school is one visitor)
  bodyBytes: 4096,
  pictureBytes: 64 * 1024, pictures: 20, picturesMs: 60 * 60e3, // per person
  saveMs: 3000,
};

/* ---------- small helpers ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(pw, salt) {
  return new Promise((ok, fail) => crypto.scrypt(String(pw), salt, 32, SCRYPT, (e, k) => (e ? fail(e) : ok(k))));
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return { s: salt.toString('base64'), h: (await scrypt(pw, salt)).toString('base64') };
}
function hashPwSync(pw) {
  const salt = crypto.randomBytes(16);
  return { s: salt.toString('base64'), h: crypto.scryptSync(String(pw), salt, 32, SCRYPT).toString('base64') };
}
const DUMMY = { s: crypto.randomBytes(16).toString('base64'), h: crypto.randomBytes(32).toString('base64') };
// Same work whether or not there is anything to check against.
async function checkPw(pw, rec) {
  const r = rec || DUMMY;
  const k = await scrypt(pw, Buffer.from(r.s, 'base64'));
  const h = Buffer.from(r.h, 'base64');
  return !!rec && h.length === k.length && crypto.timingSafeEqual(h, k);
}

const rid = (n) => crypto.randomBytes(n).toString('hex');
const roomId = () => Array.from(crypto.randomBytes(10), (b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
const keyOf = (name) => String(name || '').trim().toLowerCase();

// No markup ever: the page writes text with textContent. This only trims
// what would break a line or the layout (controls, bidi tricks, piles of
// combining marks, runs of blank lines).
export function cleanText(s, max, oneLine) {
  let t = String(s == null ? '' : s).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/([̀-ͯ҉᪰-᫿⃐-⃿]{2})[̀-ͯ҉᪰-᫿⃐-⃿]+/g, '$1');
  t = oneLine ? t.replace(/\s+/g, ' ') : t.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n');
  t = t.trim();
  return Array.from(t).slice(0, max).join('').trim();
}

function nameError(name) {
  if (!name) return 'type a name first.';
  if (name.length < 2 || name.length > 20) return 'names are 2 to 20 characters.';
  if (!NAME_OK.test(name)) return 'only letters, numbers, dots, dashes and underscores.';
  if (RESERVED.has(name.toLowerCase())) return 'that name is reserved. pick another.';
  return '';
}
const pwError = (pw, min) => (typeof pw !== 'string' || pw.length < min ? `passwords are at least ${min} characters.` :
  pw.length > 72 ? 'that password is too long.' : '');

function readBody(req, max) {
  return readBuffer(req, max).then((b) => b.toString('utf8'));
}
function readBuffer(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; reject(Object.assign(new Error('too large'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function json(res, status, obj, cookies) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) };
  if (cookies && cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}
const fail = (res, status, error, message, extra) => json(res, status, Object.assign({ error, message }, extra));

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// A sliding count per key: true once max is reached within ms.
function counter() {
  const m = new Map();
  return {
    over(k, max, ms, t) {
      const e = m.get(k);
      return !!e && t - e.at < ms && e.n >= max;
    },
    bump(k, ms, t) {
      const e = m.get(k);
      if (!e || t - e.at >= ms) m.set(k, { at: t, n: 1 });
      else e.n++;
    },
    reset(k) { m.delete(k); },
    prune(t, ms) { for (const [k, e] of m) if (t - e.at >= ms) m.delete(k); }
  };
}

/* ---------- the chat ---------- */

export function createChat(opts = {}) {
  const dir = path.resolve(opts.dir || '.');
  const file = path.join(dir, 'chat.json');
  const lim = Object.assign({}, LIMITS, opts.limits);
  const now = opts.now || Date.now;
  const ownerRec = opts.ownerPassword ? hashPwSync(opts.ownerPassword) : null;

  let db = load();
  const names = new Map(); // lowercase name -> user id
  for (const u of Object.values(db.users)) if (u.id !== OWNER) names.set(u.key, u.id);

  const fails = counter();     // wrong passwords: name|visitor, room|user
  const ownerFails = counter();
  const signups = counter();   // new names per visitor
  const hellos = counter();
  const uploads = counter();   // new pictures per person
  const sent = new Map();      // user id -> times of their recent messages
  const streams = new Set();   // { uid, room, res }
  const presenceTimers = new Map();

  /* ---------- storage ---------- */

  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      // unreadable (not missing): keep it aside rather than write over it
      if (e.code !== 'ENOENT') try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch (e2) { /* gone */ }
    }
    if (!d || typeof d !== 'object') d = {};
    for (const k of ['users', 'sessions', 'rooms', 'devBans']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
    const t = now();
    if (!d.users[OWNER]) d.users[OWNER] = { id: OWNER, name: OWNER_NAME, key: OWNER_NAME, kind: 'owner', av: 0, bio: '', created: t, seen: t, warns: [] };
    if (!d.rooms[GLOBAL]) d.rooms[GLOBAL] = { id: GLOBAL, name: 'global', by: OWNER, created: t, last: t, admins: [], members: [], bans: [], kicks: {}, pass: null, msgs: [] };
    for (const r of Object.values(d.rooms)) {
      for (const k of ['admins', 'members', 'bans', 'msgs']) if (!Array.isArray(r[k])) r[k] = [];
      if (!r.kicks || typeof r.kicks !== 'object') r.kicks = {};
    }
    for (const u of Object.values(d.users)) if (!Array.isArray(u.warns)) u.warns = [];
    return d;
  }

  let saveTimer = null;
  let dirty = false;
  function save() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, lim.saveMs);
    if (saveTimer.unref) saveTimer.unref();
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (e) { dirty = true; /* try again with the next change */ }
  }

  /* ---------- who is asking ---------- */

  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('base64url');
  const secure = (req) => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
  const cookie = (req, name, val, maxAge) => `${name}=${val}; Path=/api/chat; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure(req)}`;
  const visitor = (req) => visitorKey(clientIp(req));

  function sessionOf(req) {
    const t = parseCookies(req).chat_s;
    if (!t || t.length > 100) return null;
    const h = hashToken(t);
    const s = db.sessions[h];
    if (!s) return null;
    if (now() - s.at > lim.sessionTtl || !db.users[s.uid]) { delete db.sessions[h]; save(); return null; }
    return { hash: h, s };
  }
  function whoami(req) {
    const found = sessionOf(req);
    if (!found) return null;
    const u = db.users[found.s.uid];
    const t = now();
    found.s.at = t;
    u.seen = t;
    return u;
  }
  function devOf(req) {
    const d = parseCookies(req).chat_d;
    return d && /^[0-9a-f]{32}$/.test(d) ? d : '';
  }
  function startSession(req, u) {
    const set = [];
    let dev = devOf(req);
    if (!dev) {
      dev = rid(16);
      set.push(cookie(req, 'chat_d', dev, 400 * 86400));
    }
    const t = crypto.randomBytes(32).toString('base64url');
    db.sessions[hashToken(t)] = { uid: u.id, at: now(), dev };
    set.push(cookie(req, 'chat_s', t, lim.sessionTtl / 1000));
    save();
    return set;
  }
  const devBanned = (req) => { const d = devOf(req); return !!(d && db.devBans[d]); };

  /* ---------- what people see ---------- */

  const isOwner = (u) => u.id === OWNER;
  const isAdmin = (u, r) => isOwner(u) || (r.id !== GLOBAL && r.admins.includes(u.id));
  const isCreator = (u, r) => isOwner(u) || (r.id !== GLOBAL && r.by === u.id);
  function roleIn(u, r) {
    if (isOwner(u)) return 'owner';
    if (r && r.id !== GLOBAL && r.admins.includes(u.id)) return 'admin';
    return u.kind === 'guest' ? 'guest' : '';
  }
  function canSee(u, r) {
    if (!r) return false;
    if (isOwner(u)) return true;
    if (r.bans.includes(u.id)) return false;
    if (r.id === GLOBAL || !r.pass) return true;
    return r.members.includes(u.id) || r.admins.includes(u.id);
  }
  function meOf(u) {
    return {
      id: u.id, name: u.name, kind: u.kind, av: u.av || 0, bio: u.bio || '', owner: isOwner(u),
      muteUntil: u.muteUntil && u.muteUntil > now() ? u.muteUntil : 0,
      warn: u.pendingWarn || null,
      banned: u.banned && !isOwner(u) ? { reason: u.banned.reason || '' } : null
    };
  }
  function roomMeta(r, u) {
    const creator = db.users[r.by];
    return {
      id: r.id, name: r.name, global: r.id === GLOBAL, private: !!r.pass,
      by: creator ? creator.name : '',
      admins: r.admins.map((id) => db.users[id]).filter(Boolean).map((a) => ({ id: a.id, name: a.name })),
      you: { admin: isAdmin(u, r), creator: isCreator(u, r), owner: isOwner(u) }
    };
  }
  function onlineIn(roomId) {
    const r = db.rooms[roomId];
    const seen = new Set();
    const out = [];
    for (const s of streams) {
      if (s.room !== roomId || seen.has(s.uid)) continue;
      seen.add(s.uid);
      const u = db.users[s.uid];
      if (u) out.push({ id: u.id, name: u.name, av: u.av || 0, role: roleIn(u, r) });
    }
    const rank = { owner: 0, admin: 1, '': 2, guest: 3 };
    return out.sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
  }
  const onlineCount = (roomId) => new Set([...streams].filter((s) => !roomId || s.room === roomId).map((s) => s.uid)).size;

  /* ---------- live events ---------- */

  function write(s, event, data) {
    try { s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closing */ }
  }
  function toRoom(roomId, event, data) { for (const s of streams) if (s.room === roomId) write(s, event, data); }
  function toUser(uid, event, data) { for (const s of streams) if (s.uid === uid) write(s, event, data); }
  function toAll(event, data) { for (const s of streams) write(s, event, data); }
  // a room changed for everyone in it (each sees their own powers)
  function roomChanged(r) { for (const s of streams) if (s.room === r.id) write(s, 'room', roomMeta(r, db.users[s.uid] || { id: '' })); }
  // tell a person's streams in a room (or all their streams) why, then close them
  function endStreams(uid, roomId, why) {
    for (const s of [...streams]) {
      if (s.uid !== uid || (roomId && s.room !== roomId)) continue;
      write(s, 'gone', { why });
      streams.delete(s);
      try { s.res.end(); } catch (e) { /* gone */ }
      presence(s.room);
    }
  }
  function presence(roomId) {
    if (presenceTimers.has(roomId)) return;
    const t = setTimeout(() => {
      presenceTimers.delete(roomId);
      toRoom(roomId, 'online', { users: onlineIn(roomId) });
    }, 250);
    if (t.unref) t.unref();
    presenceTimers.set(roomId, t);
  }

  function stream(req, res, url) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const r = db.rooms[url.searchParams.get('room') || GLOBAL];
    if (!r) return fail(res, 404, 'gone', 'that room is gone.');
    if (!canSee(u, r)) return fail(res, 403, 'locked', 'you are not in that room.');
    const mine = [...streams].filter((s) => s.uid === u.id);
    if (mine.length >= lim.streamsPerUser) endStreams(u.id, mine[0].room, 'elsewhere');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const s = { uid: u.id, room: r.id, res };
    streams.add(s);
    write(s, 'hello', { me: meOf(u), room: roomMeta(r, u), msgs: r.msgs, online: onlineIn(r.id) });
    presence(r.id);
    const beat = setInterval(() => { try { res.write(': \n\n'); } catch (e) { /* closing */ } }, 25e3);
    if (beat.unref) beat.unref();
    const done = () => {
      clearInterval(beat);
      if (streams.delete(s)) presence(r.id);
    };
    req.on('close', done);
    res.on('close', done);
  }

  /* ---------- signing in ---------- */

  function hello(req, res, body) {
    const t = now();
    const v = visitor(req);
    if (hellos.over(v, 120, 60e3, t)) return fail(res, 429, 'slow', 'slow down a little.');
    hellos.bump(v, 60e3, t);
    const name = String(body.name || '').trim();
    if (name.toLowerCase() === OWNER_NAME) return json(res, 200, { state: 'owner' });
    const bad = nameError(name);
    if (bad) return json(res, 200, { state: 'bad', message: bad });
    const id = names.get(keyOf(name));
    if (!id) return json(res, 200, { state: 'free' });
    return json(res, 200, { state: db.users[id].kind === 'account' ? 'account' : 'taken' });
  }

  async function newUser(req, res, body, kind) {
    const t = now();
    const v = visitor(req);
    const name = String(body.name || '').trim();
    const bad = nameError(name);
    if (bad) return fail(res, 400, 'name', bad);
    if (names.has(keyOf(name))) return fail(res, 409, 'taken', 'someone already has that name.');
    if (devBanned(req)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    if (kind === 'account') {
      const pwBad = pwError(body.password, 4);
      if (pwBad) return fail(res, 400, 'password', pwBad);
    }
    if (signups.over(v, lim.signups, lim.signupsMs, t)) return fail(res, 429, 'slow', 'too many new names from here. try again later.');
    signups.bump(v, lim.signupsMs, t);
    const pw = kind === 'account' ? await hashPw(body.password) : null;
    if (names.has(keyOf(name))) return fail(res, 409, 'taken', 'someone already has that name.'); // taken while hashing
    const u = { id: 'u' + rid(8), name, key: keyOf(name), kind, av: 0, bio: '', created: t, seen: t, warns: [] };
    if (pw) u.pw = pw;
    db.users[u.id] = u;
    names.set(u.key, u.id);
    json(res, 200, { me: meOf(u) }, startSession(req, u));
  }

  async function login(req, res, body) {
    const t = now();
    const k = keyOf(body.name);
    const fk = `${k}|${visitor(req)}`;
    const owner = k === OWNER_NAME;
    if (fails.over(fk, lim.tries, lim.triesMs, t) || (owner && ownerFails.over('owner', lim.ownerTries, lim.ownerTriesMs, t))) {
      return fail(res, 429, 'slow', 'too many wrong passwords. wait a few minutes.');
    }
    if (owner && !ownerRec) return fail(res, 403, 'off', 'the owner sign-in is not set up on this server.');
    const u = owner ? db.users[OWNER] : db.users[names.get(k)];
    const rec = owner ? ownerRec : u && u.kind === 'account' ? u.pw : null;
    const ok = await checkPw(String(body.password || ''), rec);
    if (!ok || !u) {
      fails.bump(fk, lim.triesMs, t);
      if (owner) ownerFails.bump('owner', lim.ownerTriesMs, t);
      return fail(res, 401, 'wrong', 'wrong password.');
    }
    fails.reset(fk);
    if (!owner && devBanned(req)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    u.seen = t;
    json(res, 200, { me: meOf(u) }, startSession(req, u));
  }

  async function claim(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.kind !== 'guest') return fail(res, 400, 'already', 'that name is already yours.');
    const pwBad = pwError(body.password, 4);
    if (pwBad) return fail(res, 400, 'password', pwBad);
    u.pw = await hashPw(body.password);
    u.kind = 'account';
    save();
    json(res, 200, { me: meOf(u) });
  }

  function logout(req, res) {
    const found = sessionOf(req);
    if (found) { delete db.sessions[found.hash]; save(); }
    json(res, 200, { ok: true }, [cookie(req, 'chat_s', '', 0)]);
  }

  function me(req, res) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    json(res, 200, { me: meOf(u), limits: { msg: lim.msgLen, bio: lim.bioLen, room: lim.roomName, picture: lim.pictureBytes } });
  }

  function profile(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    if (body.bio !== undefined) u.bio = cleanText(body.bio, lim.bioLen, true);
    if (body.removePicture) dropPicture(u);
    save();
    for (const s of streams) if (s.uid === u.id) presence(s.room);
    json(res, 200, { me: meOf(u) });
  }

  /* ---------- pictures ---------- */

  // One file per person, named by their id; av (the time it was sent) is
  // the version in its address, so a new one shows at once.
  const picDir = path.join(dir, 'pictures');
  const pictureFile = (u) => path.join(picDir, `${u.id}.${(PICTURE_TYPES[u.avType] || { ext: 'x' }).ext}`);
  function dropPicture(u) {
    if (u.av) try { fs.unlinkSync(pictureFile(u)); } catch (e) { /* already gone */ }
    u.av = 0;
    delete u.avType;
    for (const s of streams) if (s.uid === u.id) presence(s.room);
  }

  async function upload(req, res) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const kind = PICTURE_TYPES[type];
    if (!kind) return fail(res, 415, 'type', 'pictures have to be png, jpeg or webp.');
    const t = now();
    if (uploads.over(u.id, lim.pictures, lim.picturesMs, t)) return fail(res, 429, 'slow', 'too many new pictures. try again later.');
    let buf;
    try { buf = await readBuffer(req, lim.pictureBytes); } catch (e) {
      if (e.code === 413) { res.setHeader('connection', 'close'); return fail(res, 413, 'big', 'that picture is too big.'); }
      return; // the client went away
    }
    if (!kind.ok(buf)) return fail(res, 400, 'image', 'that doesn\u2019t look like a picture.');
    uploads.bump(u.id, lim.picturesMs, t);
    try {
      fs.mkdirSync(picDir, { recursive: true });
      if (u.av && u.avType !== type) fs.rmSync(pictureFile(u), { force: true });
      u.avType = type;
      const file = pictureFile(u);
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { return fail(res, 500, 'disk', 'couldn\u2019t save that. try again.'); }
    u.av = t;
    save();
    for (const s of streams) if (s.uid === u.id) presence(s.room);
    json(res, 200, { me: meOf(u) });
  }

  // served only as the image type it was checked as, sandboxed, and cached
  // briefly so a picture the owner removes is gone within minutes
  function picture(req, res, url) {
    const id = url.searchParams.get('u') || '';
    const u = USER_ID.test(id) ? db.users[id] : null;
    if (!u || !u.av || !PICTURE_TYPES[u.avType]) return fail(res, 404, 'none', 'no picture.');
    fs.readFile(pictureFile(u), (err, buf) => {
      if (err) return fail(res, 404, 'none', 'no picture.');
      res.writeHead(200, {
        'content-type': u.avType,
        'content-length': buf.length,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin'
      });
      res.end(buf);
    });
  }

  /* ---------- rooms ---------- */

  function rooms(req, res) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    const list = Object.values(db.rooms).filter((r) => r.id !== GLOBAL).map((r) => ({
      id: r.id, name: r.name, private: !!r.pass, online: onlineCount(r.id),
      by: (db.users[r.by] || {}).name || '', last: r.last || r.created,
      in: canSee(u, r),
      admin: isAdmin(u, r) && !isOwner(u), banned: r.bans.includes(u.id)
    })).sort((a, b) => b.online - a.online || b.last - a.last);
    json(res, 200, { rooms: list, online: onlineCount(''), global: onlineCount(GLOBAL) });
  }

  async function create(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const name = cleanText(body.name, lim.roomName, true);
    if (name.length < 2) return fail(res, 400, 'name', 'room names are 2 to 32 characters.');
    const all = Object.values(db.rooms);
    if (!isOwner(u) && all.filter((r) => r.by === u.id).length >= lim.roomsPerUser) {
      return fail(res, 400, 'many', `you already have ${lim.roomsPerUser} rooms. delete one first.`);
    }
    if (all.length > lim.rooms) return fail(res, 503, 'full', 'there are too many rooms right now.');
    let pass = null;
    if (body.password) {
      const pwBad = pwError(body.password, 1);
      if (pwBad) return fail(res, 400, 'password', pwBad);
      pass = await hashPw(body.password);
    }
    const t = now();
    const r = { id: roomId(), name, by: u.id, created: t, last: t, admins: [u.id], members: [u.id], bans: [], kicks: {}, pass, msgs: [] };
    db.rooms[r.id] = r;
    save();
    toAll('rooms', {});
    json(res, 200, { room: roomMeta(r, u) });
  }

  async function join(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const r = ROOM_ID.test(String(body.room)) ? db.rooms[body.room] : null;
    if (!r) return fail(res, 404, 'gone', 'that room is gone.');
    const t = now();
    if (!isOwner(u)) {
      if (r.bans.includes(u.id)) return fail(res, 403, 'roombanned', 'you are banned from this room.');
      if (r.kicks[u.id] > t) return fail(res, 403, 'kicked', 'you were kicked. try again in a few minutes.');
    }
    if (canSee(u, r)) return json(res, 200, { room: roomMeta(r, u) });
    if (!body.password) return fail(res, 401, 'password', 'this room has a password.');
    const fk = `${r.id}|${u.id}`;
    if (fails.over(fk, lim.tries, lim.triesMs, t)) return fail(res, 429, 'slow', 'too many wrong passwords. wait a few minutes.');
    if (!(await checkPw(String(body.password), r.pass))) {
      fails.bump(fk, lim.triesMs, t);
      return fail(res, 401, 'wrong', 'wrong password.');
    }
    fails.reset(fk);
    if (!r.members.includes(u.id)) r.members.push(u.id);
    save();
    json(res, 200, { room: roomMeta(r, u) });
  }

  function send(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const t = now();
    if (u.muteUntil > t) return fail(res, 403, 'muted', 'you are muted for now.', { until: u.muteUntil });
    const r = db.rooms[String(body.room || GLOBAL)];
    if (!r) return fail(res, 404, 'gone', 'that room is gone.');
    if (!canSee(u, r)) return fail(res, 403, 'locked', 'you are not in that room.');
    let text = cleanText(body.text, lim.msgLen);
    const lines = text.split('\n');
    if (lines.length > lim.msgLines) text = lines.slice(0, lim.msgLines).join('\n');
    if (!text) return fail(res, 400, 'empty', 'type something first.');
    const times = (sent.get(u.id) || []).filter((x) => t - x < lim.burstMs);
    if (times.length >= lim.burst || (times.length && t - times[times.length - 1] < lim.gapMs)) {
      return fail(res, 429, 'slow', 'slow down a little.');
    }
    times.push(t);
    sent.set(u.id, times);
    const m = { id: rid(6), at: t, uid: u.id, name: u.name, av: u.av || 0, role: roleIn(u, r), text };
    r.msgs.push(m);
    if (r.msgs.length > lim.keep) r.msgs.splice(0, r.msgs.length - lim.keep);
    r.last = t;
    save();
    toRoom(r.id, 'msg', m);
    json(res, 200, { id: m.id });
  }

  function ack(req, res) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    delete u.pendingWarn;
    save();
    json(res, 200, { ok: true });
  }

  /* ---------- people ---------- */

  function userCard(req, res, url) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    const t = db.users[url.searchParams.get('id') || ''];
    if (!t) return fail(res, 404, 'gone', 'they are gone.');
    const r = db.rooms[url.searchParams.get('room') || ''] || null;
    const card = {
      id: t.id, name: t.name, kind: t.kind, av: t.av || 0, bio: t.bio || '', created: t.created,
      role: roleIn(t, r), online: [...streams].some((s) => s.uid === t.id),
      roomBanned: !!(r && r.bans.includes(t.id))
    };
    if (isOwner(u)) {
      card.mod = { warns: t.warns.length, banned: t.banned ? t.banned.reason || '' : null, muteUntil: t.muteUntil > now() ? t.muteUntil : 0 };
    }
    json(res, 200, { user: card });
  }

  function bans(req, res) {
    const u = whoami(req);
    if (!u || !isOwner(u)) return fail(res, 403, 'owner', 'only the owner can see that.');
    const list = Object.values(db.users).filter((x) => x.banned)
      .map((x) => ({ id: x.id, name: x.name, av: x.av || 0, at: x.banned.at, reason: x.banned.reason || '' }))
      .sort((a, b) => b.at - a.at);
    json(res, 200, { bans: list });
  }

  /* ---------- moderation ---------- */

  // Room admins: delete messages, clear, make admins, kick (5 minutes),
  // ban from the room, set or remove the password, rename. The room's
  // creator also removes admins and deletes the room. The owner can do all
  // of that in every room, plus warn, mute, ban and unban anyone from the
  // whole chat, and wipe a profile.
  async function mod(req, res, body) {
    const u = whoami(req);
    if (!u) return fail(res, 401, 'signin', 'sign in first.');
    if (u.banned && !isOwner(u)) return fail(res, 403, 'banned', 'you are banned from the chat.');
    const a = String(body.action || '');
    const r = body.room ? db.rooms[String(body.room)] : null;
    const tg = body.target ? db.users[String(body.target)] : null;
    const t = now();
    const no = () => fail(res, 403, 'power', 'you can’t do that here.');
    const needRoom = () => (r ? false : (fail(res, 404, 'gone', 'that room is gone.'), true));
    const needTarget = () => (tg ? false : (fail(res, 404, 'gone', 'they are gone.'), true));
    const ok = (extra) => { save(); json(res, 200, Object.assign({ ok: true }, extra)); };
    const reason = cleanText(body.reason, lim.reasonLen, true);

    switch (a) {
      case 'delete': {
        if (needRoom()) return;
        const i = r.msgs.findIndex((m) => m.id === body.msg);
        if (i < 0) return fail(res, 404, 'gone', 'that message is gone.');
        if (r.msgs[i].uid !== u.id && !isAdmin(u, r)) return no();
        r.msgs.splice(i, 1);
        toRoom(r.id, 'del', { id: body.msg });
        return ok();
      }
      case 'clear':
        if (needRoom()) return;
        if (!isAdmin(u, r)) return no();
        r.msgs = [];
        toRoom(r.id, 'clear', {});
        return ok();
      case 'admin':
        if (needRoom() || needTarget()) return;
        if (!isAdmin(u, r) || r.id === GLOBAL || isOwner(tg)) return no();
        if (r.bans.includes(tg.id)) return fail(res, 400, 'banned', 'unban them from the room first.');
        if (!r.admins.includes(tg.id)) r.admins.push(tg.id);
        if (!r.members.includes(tg.id)) r.members.push(tg.id);
        roomChanged(r);
        presence(r.id);
        return ok();
      case 'unadmin':
        if (needRoom() || needTarget()) return;
        if (!isCreator(u, r) || (tg.id === r.by && !isOwner(u))) return no();
        r.admins = r.admins.filter((id) => id !== tg.id);
        roomChanged(r);
        presence(r.id);
        return ok();
      case 'kick':
      case 'roomban': {
        if (needRoom() || needTarget()) return;
        if (!isAdmin(u, r) || r.id === GLOBAL || isOwner(tg) || tg.id === u.id) return no();
        if (r.admins.includes(tg.id) && !isCreator(u, r)) return no(); // admins can't remove admins
        r.members = r.members.filter((id) => id !== tg.id);
        r.admins = r.admins.filter((id) => id !== tg.id);
        if (a === 'kick') r.kicks[tg.id] = t + 5 * 60e3;
        else if (!r.bans.includes(tg.id)) r.bans.push(tg.id);
        endStreams(tg.id, r.id, a === 'kick' ? 'kicked' : 'roombanned');
        roomChanged(r);
        return ok();
      }
      case 'roomunban':
        if (needRoom() || needTarget()) return;
        if (!isAdmin(u, r)) return no();
        r.bans = r.bans.filter((id) => id !== tg.id);
        return ok();
      case 'password': {
        if (needRoom()) return;
        if (!isAdmin(u, r) || r.id === GLOBAL) return no();
        const pw = typeof body.password === 'string' ? body.password : '';
        if (pw) {
          const pwBad = pwError(pw, 1);
          if (pwBad) return fail(res, 400, 'password', pwBad);
          r.pass = await hashPw(pw);
          for (const s of streams) if (s.room === r.id && !r.members.includes(s.uid)) r.members.push(s.uid);
        } else r.pass = null;
        roomChanged(r);
        toAll('rooms', {});
        return ok();
      }
      case 'rename': {
        if (needRoom()) return;
        if (!isAdmin(u, r) || r.id === GLOBAL) return no();
        const name = cleanText(body.name, lim.roomName, true);
        if (name.length < 2) return fail(res, 400, 'name', 'room names are 2 to 32 characters.');
        r.name = name;
        roomChanged(r);
        toAll('rooms', {});
        return ok();
      }
      case 'deleteroom':
        if (needRoom()) return;
        if (!isCreator(u, r) || r.id === GLOBAL) return no();
        for (const s of [...streams]) if (s.room === r.id) endStreams(s.uid, r.id, 'deleted');
        delete db.rooms[r.id];
        toAll('rooms', {});
        return ok();
    }

    // the owner's powers over the whole chat
    if (!isOwner(u)) return no();
    if (needTarget()) return;
    if (isOwner(tg)) return fail(res, 400, 'self', 'not on yourself.');
    switch (a) {
      case 'warn':
        tg.warns.push({ at: t, reason });
        tg.pendingWarn = { at: t, reason };
        toUser(tg.id, 'warn', tg.pendingWarn);
        return ok({ warns: tg.warns.length });
      case 'mute': {
        const min = Math.max(1, Math.min(10080, Math.round(Number(body.minutes) || 10)));
        tg.muteUntil = t + min * 60e3;
        toUser(tg.id, 'mute', { until: tg.muteUntil });
        return ok({ until: tg.muteUntil });
      }
      case 'unmute':
        tg.muteUntil = 0;
        toUser(tg.id, 'mute', { until: 0 });
        return ok();
      case 'ban':
        tg.banned = { at: t, reason };
        for (const s of Object.values(db.sessions)) if (s.uid === tg.id && s.dev) db.devBans[s.dev] = { uid: tg.id, at: t };
        toUser(tg.id, 'ban', { reason });
        endStreams(tg.id, '', 'banned');
        return ok();
      case 'unban':
        delete tg.banned;
        for (const [d, b] of Object.entries(db.devBans)) if (b.uid === tg.id) delete db.devBans[d];
        return ok();
      case 'wipe':
        dropPicture(tg);
        tg.bio = '';
        for (const s of streams) if (s.uid === tg.id) presence(s.room);
        return ok();
      default:
        return fail(res, 400, 'action', 'unknown action.');
    }
  }

  /* ---------- upkeep ---------- */

  // hourly: old sessions, guests unseen for a week (and their names),
  // rooms quiet for two weeks with nobody in them, finished kicks
  function sweep() {
    const t = now();
    const live = new Set([...streams].map((s) => s.uid));
    for (const [h, s] of Object.entries(db.sessions)) if (t - s.at > lim.sessionTtl || !db.users[s.uid]) delete db.sessions[h];
    for (const u of Object.values(db.users)) {
      if (u.kind !== 'guest' || live.has(u.id) || t - (u.seen || 0) < lim.guestTtl || u.banned) continue;
      dropPicture(u);
      delete db.users[u.id];
      if (names.get(u.key) === u.id) names.delete(u.key);
      for (const [h, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[h];
    }
    for (const r of Object.values(db.rooms)) {
      for (const [id, until] of Object.entries(r.kicks)) if (until <= t) delete r.kicks[id];
      if (r.id !== GLOBAL && t - (r.last || r.created) > lim.roomTtl && !onlineCount(r.id)) delete db.rooms[r.id];
    }
    for (const c of [fails, ownerFails, signups, hellos, uploads]) c.prune(t, 2 * 60 * 60e3);
    for (const [id, times] of sent) if (!times.length || t - times[times.length - 1] > lim.burstMs) sent.delete(id);
    save();
  }
  const sweeper = setInterval(sweep, 60 * 60e3);
  if (sweeper.unref) sweeper.unref();

  /* ---------- routes ---------- */

  const POSTS = {
    hello, login, claim, logout, profile, create, join, send, ack, mod, picture: upload,
    guest: (req, res, body) => newUser(req, res, body, 'guest'),
    signup: (req, res, body) => newUser(req, res, body, 'account')
  };
  const GETS = { me, rooms, stream, user: userCard, bans, picture };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const name = url.pathname.replace(/^\/api\/chat\/?/, '');
    try {
      if (req.method === 'GET') {
        const fn = GETS[name];
        return fn ? fn(req, res, url) : fail(res, 404, 'nope', 'not found.');
      }
      if (req.method !== 'POST') return fail(res, 405, 'method', 'not allowed.');
      const fn = POSTS[name];
      if (!fn) return fail(res, 404, 'nope', 'not found.');
      // Browsers send JSON cross-site only after a CORS preflight, which this
      // server never grants, so other sites cannot act for someone signed in.
      const site = String(req.headers['sec-fetch-site'] || '');
      if (site && site !== 'same-origin' && site !== 'none') return fail(res, 403, 'forbidden', 'not from here.');
      if (name === 'picture') return await upload(req, res);
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return fail(res, 415, 'type', 'send json.');
      let body;
      try { body = JSON.parse((await readBody(req, lim.bodyBytes)) || '{}'); } catch (e) {
        if (e.code === 413) { res.setHeader('connection', 'close'); return fail(res, 413, 'big', 'that is too long.'); }
        return fail(res, 400, 'bad', 'that did not look right.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad', 'that did not look right.');
      return await fn(req, res, body);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, 'oops', 'something broke. try again.');
    }
  }

  return {
    handle,
    flush,
    summary: () => `chat owner sign-in ${ownerRec ? 'on' : 'off'}`,
    close() {
      clearInterval(sweeper);
      for (const s of streams) try { s.res.end(); } catch (e) { /* gone */ }
      streams.clear();
      flush();
    }
  };
}
