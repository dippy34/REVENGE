// hunt-lib.mjs: the shared primitives of the signal (docs/07-hunt.md).
//
// Node built-ins only. Used by the engine (hunt.mjs), the tools (tools/hunt-*.mjs) and
// the private content generators, so every party computes formats, keys and hashes the
// same way. Generic: no content lives here.
//
//   b64u, canon                    base64url and canonical JSON (integers only)
//   sealJson / openJson            AES-256-GCM envelopes (packs, source backup, walk-public)
//   secrets / deriveKeys           the HUNT_* secrets and the per-mode key split
//   edFromSeed / sign / verifyToken    Ed25519 passes ("p1") and certificates ("c1")
//   walk*                          the owner's two-factor walkthrough envelope
//   norm, H, lieCommit, runCommit, drawSeed    normalisation and keyed hashes
//   degrade                        deterministic masking of broadcast recordings
//   rng                            sfc32, identical to tools/hunt-kit.mjs
//   facts                          the probe fact schema, hygiene and the condition matcher
//   planchette                     the question grammar, candidate spaces, silence, isos
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const F_RE = /^(freq|int)-\d{2}[a-z]?$/;
export const STAGE_RE = /^s[1-9]$/;
const B64U_RE = /^[A-Za-z0-9_-]*$/;

/* ---------- base64url and canonical JSON ---------- */

export const b64u = {
  enc(buf) { return Buffer.from(buf).toString('base64url'); },
  // strict: only the url-safe alphabet, no padding, and the canonical encoding
  dec(str) {
    if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new Error('b64u');
    const b = Buffer.from(str, 'base64url');
    if (b.toString('base64url') !== str) throw new Error('b64u');
    return b;
  }
};

function plainObject(v) {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// JSON with sorted keys (code-unit order) at every level and no whitespace. Strings,
// booleans, null, arrays, plain objects and safe integers only.
export function canon(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error('canon: not an integer');
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (!plainObject(v)) throw new Error('canon: not a plain object');
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    default: throw new Error('canon: ' + typeof v);
  }
}

export function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
export function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
export function hmacHex(key, msg) { return hmac(key, msg).toString('hex'); }

/* ---------- secrets and keys (CONTRACT 3) ---------- */

export const SECRET_NAMES = ['HUNT_KEY', 'HUNT_HMAC', 'HUNT_SIGN_KEY', 'HUNT_SEED'];

// a well formed secret: base64url of exactly 32 bytes
export function parseSecret(str) {
  if (typeof str !== 'string') return null;
  try {
    const b = b64u.dec(str.trim());
    return b.length === 32 ? b : null;
  } catch (e) { return null; }
}
export function newSecret() { return b64u.enc(crypto.randomBytes(32)); }

export function kidOf(keyString) { return sha256hex('kid|' + keyString).slice(0, 8); }

// The engine's keys for one mode (CONTRACT 3). `strs` holds the env strings.
export function deriveKeys(strs, sandbox) {
  const key = parseSecret(strs.HUNT_KEY), mac = parseSecret(strs.HUNT_HMAC), sig = parseSecret(strs.HUNT_SIGN_KEY);
  if (!key || !mac || !sig) return null;
  const state = sandbox ? hmac(mac, 'da|sandbox|state') : mac;
  const seed = sandbox ? hmac(sig, 'da|sandbox|sign') : sig;
  const ed = edFromSeed(seed);
  return {
    aes: key, kid: kidOf(strs.HUNT_KEY.trim()),
    content: mac, state,
    priv: ed.priv, pub: ed.pub, pubRaw: ed.raw, pubB64: b64u.enc(ed.raw)
  };
}

/* ---------- sealed envelopes (CONTRACT 4.2) ---------- */

function aad(kind, f) { return Buffer.from('da|' + kind + '|' + f + '|1', 'utf8'); }

// key: a 32-byte Buffer; meta: { kind, f, kid }
export function sealJson(obj, key, meta) {
  const { kind, f, kid } = meta;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(kind, f));
  const pt = zlib.gzipSync(Buffer.from(canon(obj), 'utf8'));
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return { v: 1, kind, f, alg: 'A256GCM', kid, iv: b64u.enc(iv), ct: b64u.enc(ct), tag: b64u.enc(c.getAuthTag()) };
}

export function openJson(env, key, meta) {
  const { kind, f, kid } = meta;
  if (!env || typeof env !== 'object' || env.v !== 1 || env.alg !== 'A256GCM') throw new Error('envelope');
  if (env.kind !== kind || env.f !== f) throw new Error('aad');
  if (kid !== undefined && env.kid !== kid) throw new Error('kid');
  const iv = b64u.dec(env.iv), tag = b64u.dec(env.tag);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad(kind, f));
  d.setAuthTag(tag);
  const pt = Buffer.concat([d.update(b64u.dec(env.ct)), d.final()]);
  return JSON.parse(zlib.gunzipSync(pt, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
}

export function readEnvelope(text) {
  const env = JSON.parse(text);
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('envelope');
  return env;
}
export function writeEnvelope(env) { return JSON.stringify(env) + '\n'; }

/* ---------- Ed25519 tokens (CONTRACT 4.3) ---------- */

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function edFromSeed(seed) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const der = pub.export({ format: 'der', type: 'spki' });
  return { priv, pub, raw: Buffer.from(der.subarray(der.length - 32)) };
}
export function edPubFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
}

function signedBytes(prefix, seg) { return Buffer.from('da|' + prefix + '|' + seg, 'utf8'); }

export function sign(prefix, payload, signKey) {
  const seg = b64u.enc(Buffer.from(canon(payload), 'utf8'));
  const sig = crypto.sign(null, signedBytes(prefix, seg), signKey);
  return prefix + '.' + seg + '.' + b64u.enc(sig);
}

const PASS_KEYS = new Set(['v', 'k', 'f', 'id', 'd', 's', 'h', 'sb', 'hs']);
const CERT_KEYS = new Set(['v', 'k', 'f', 'n', 'kind', 'id', 'day', 'unlit', 'late', 'sb']);
const isInt = (x) => Number.isSafeInteger(x);
const bit = (x) => x === 0 || x === 1;

function shapeOk(p) {
  if (p.k === 'pass') {
    for (const k of Object.keys(p)) if (!PASS_KEYS.has(k)) return false;
    return typeof p.id === 'string' && p.id.length === 22 && B64U_RE.test(p.id) &&
      isInt(p.d) && p.d >= -1 && p.d <= 100000 && isInt(p.s) && p.s >= 0 && p.s < 1024 && bit(p.h) &&
      (p.hs === undefined || p.hs === 1);
  }
  for (const k of Object.keys(p)) if (!CERT_KEYS.has(k)) return false;
  return typeof p.id === 'string' && p.id.length === 16 && B64U_RE.test(p.id) && isInt(p.n) &&
    (p.kind === 'frequency' || p.kind === 'interlude') && isInt(p.day) && bit(p.unlit) && bit(p.late);
}

// payload | null. pub: a KeyObject or the raw 32-byte key.
export function verifyToken(str, pub, opts = {}) {
  if (typeof str !== 'string' || str.length > 2048) return null;
  const parts = str.split('.');
  if (parts.length !== 3) return null;
  const [prefix, seg, sigS] = parts;
  if (prefix !== 'p1' && prefix !== 'c1') return null;
  let payload, sig;
  try {
    const raw = b64u.dec(seg);
    sig = b64u.dec(sigS);
    if (sig.length !== 64) return null;
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (b64u.enc(Buffer.from(canon(payload), 'utf8')) !== seg) return null;
  } catch (e) { return null; }
  if (payload.v !== 1) return null;
  if (prefix === 'p1' ? payload.k !== 'pass' : payload.k !== 'cert') return null;
  if (typeof payload.f !== 'string' || !F_RE.test(payload.f)) return null;
  if (opts.loaded && !opts.loaded(payload.f)) return null;
  if (opts.sandbox ? payload.sb !== 1 : payload.sb !== undefined) return null;
  if (!shapeOk(payload)) return null;
  try {
    const key = Buffer.isBuffer(pub) ? edPubFromRaw(pub) : pub;
    if (!crypto.verify(null, signedBytes(prefix, seg), key, sig)) return null;
  } catch (e) { return null; }
  return payload;
}

/* ---------- the owner's walkthrough (CONTRACT 4.4, 4.5) ---------- */

export const WALK_KDF = { alg: 'scrypt', N: 131072, r: 8, p: 1 };

export function walkKeyMaster(huntKey, f) { return hmac(huntKey, 'walk|' + f); }

// master = HMAC(scrypt(passphrase, salt), keyMaster): needs both the passphrase and HUNT_KEY
export function walkPassMaster(passphrase, kdf, keyMaster) {
  if (!kdf || kdf.alg !== 'scrypt') throw new Error('kdf');
  const s = crypto.scryptSync(Buffer.from(String(passphrase).normalize('NFC'), 'utf8'), b64u.dec(kdf.salt), 32,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 2 ** 28 });
  return hmac(s, keyMaster);
}

function walkStageKey(master, sid) { return hmac(master, 'walk-stage|' + sid); }

// stagesObj: { s0: { method, lineages: [{ detail }], notes }, ... }
// meta: { f, wrap: 'key'|'pass', kdf, srcHash }
export function wrapWalk(stagesObj, master, meta) {
  const stages = {};
  for (const sid of Object.keys(stagesObj).sort()) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', walkStageKey(master, sid), iv);
    c.setAAD(Buffer.from('da|walk|' + meta.f + '|' + sid, 'utf8'));
    const ct = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(canon(stagesObj[sid]), 'utf8'))), c.final()]);
    stages[sid] = { iv: b64u.enc(iv), ct: b64u.enc(ct), tag: b64u.enc(c.getAuthTag()) };
  }
  return { v: 2, kind: 'walk', f: meta.f, wrap: meta.wrap, kdf: meta.kdf || null, srcHash: meta.srcHash, stages };
}

export function unwrapStage(env, master, sid) {
  if (!env || env.v !== 2 || env.kind !== 'walk' || !env.stages || !env.stages[sid]) throw new Error('stage');
  const s = env.stages[sid];
  const d = crypto.createDecipheriv('aes-256-gcm', walkStageKey(master, sid), b64u.dec(s.iv));
  d.setAAD(Buffer.from('da|walk|' + env.f + '|' + sid, 'utf8'));
  d.setAuthTag(b64u.dec(s.tag));
  const pt = Buffer.concat([d.update(b64u.dec(s.ct)), d.final()]);
  return JSON.parse(zlib.gunzipSync(pt).toString('utf8'));
}

export function walkpubKey(huntKey, f, coldAt) { return hmac(huntKey, 'walkpub|' + f + '|' + coldAt); }

/* ---------- normalisation (CONTRACT 5.1) ---------- */

export const NORM_MODES = ['alnum', 'alpha', 'digits', 'words', 'glyph'];

export function norm(text, mode = 'alnum', alphabet = '') {
  const s = String(text == null ? '' : text).slice(0, 200).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  switch (mode || 'alnum') {
    case 'alnum': return s.replace(/[^a-z0-9]/g, '');
    case 'alpha': return s.replace(/[^a-z]/g, '');
    case 'digits': return s.replace(/[^0-9]/g, '');
    case 'words': return s.replace(/[^a-z0-9]+/g, ' ').trim();
    case 'glyph': {
      const al = String(alphabet || '').toLowerCase();
      let out = '';
      for (const ch of s) if (al.includes(ch)) out += ch;
      return out;
    }
    default: throw new Error('norm mode');
  }
}
export function normStage(text, n) { return norm(text, (n && n.mode) || 'alnum', (n && n.alphabet) || ''); }

/* ---------- keyed hashes (CONTRACT 5.2) ---------- */

const hex32 = (key, msg) => hmacHex(key, msg).slice(0, 32);
export const H = {
  answer: (K, f, stage, L, n) => hex32(K, 'ans|' + f + '|' + stage + '|' + L + '|' + n),
  warm: (K, f, stage, L, n) => hex32(K, 'warm|' + f + '|' + stage + '|' + L + '|' + n),
  door: (K, f, n) => hex32(K, 'door|' + f + '|' + n),
  rec: (K, f, passId) => hex32(K, 'rec|' + f + '|' + passId),
  lineage: (K, f, passId, V) => hmac(K, 'lin|' + f + '|' + passId).readUInt32BE(0) % V,
  draw: (K, f, stage, passId, n) => hmac(K, 'draw|' + f + '|' + stage + '|' + passId).readUInt32BE(0) % n,
  certId: (K, f, passId) => b64u.enc(hmac(K, 'cert|' + f + '|' + passId).subarray(0, 12)),
  lie: (K, f, passId, day, perDay) => {
    const b = hmac(K, 'lie|' + f + '|' + passId + '|' + day);
    return { slot: b.readUInt32BE(0) % (perDay + 1), salt: b.subarray(4, 12).toString('hex') };
  },
  headStart: (K, fNew, certId) => hex32(K, 'hs|' + fNew + '|' + certId),
  hintCells: (K, f, stage, passId) => hmac(K, 'hc|' + f + '|' + stage + '|' + passId)
};
export function lieCommit(f, day, slot, salt) { return sha256hex('lie|' + f + '|' + day + '|' + slot + '|' + salt); }
export function runCommit(runId, secretHex) { return sha256hex('run|' + runId + '|' + secretHex); }
export function drawSeed(secret, k) { return hmac(secret, 'draw|' + k).subarray(0, 16).toString('hex'); }

/* ---------- degrade (CONTRACT 5.3) ---------- */

// label = 'deg|<f>|<L>|<frameId>|<day>'. The k-th non-space character (row-major) uses
// keystream bytes 3k..3k+2; spaces are never masked.
export function degrade(lines, permille, hmacKey, label, noise) {
  let total = 0;
  for (const line of lines) for (const ch of line) if (ch !== ' ') total++;
  const blocks = [];
  for (let i = 0; i * 32 < total * 3; i++) blocks.push(hmac(hmacKey, label + '|' + i));
  const ks = Buffer.concat(blocks);
  const nz = Array.from(String(noise || ''));
  let k = 0;
  return lines.map((line) => {
    let out = '';
    for (const ch of line) {
      if (ch === ' ') { out += ch; continue; }
      const b0 = ks[3 * k], b1 = ks[3 * k + 1], b2 = ks[3 * k + 2];
      k++;
      out += nz.length && ((b0 << 8) | b1) % 1000 < permille ? nz[b2 % nz.length] : ch;
    }
    return out;
  });
}

/* ---------- rng: sfc32, the same stream as tools/hunt-kit.mjs ---------- */

export function rng(buf) {
  let a = buf.readUInt32LE(0), b = buf.readUInt32LE(4), c = buf.readUInt32LE(8), d = buf.readUInt32LE(12);
  function u32() {
    const t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const t = (t0 + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  }
  for (let i = 0; i < 12; i++) u32();
  const api = {
    u32,
    int(n) { if (n < 1 || n > 2 ** 32) throw new Error('range'); const lim = 2 ** 32 - (2 ** 32 % n); let x; do x = u32(); while (x >= lim); return x % n; },
    chance(permille) { return api.int(1000) < permille; },
    pick(arr) { return arr[api.int(arr.length)]; },
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = api.int(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
    fork(label) { const out = Buffer.alloc(16); for (let i = 0; i < 4; i++) out.writeUInt32LE(u32(), i * 4); return rng(hmac(out, label)); }
  };
  return api;
}

/* ---------- probe facts (CONTRACT 9) ---------- */

const AREAS = ['menu', 'yt', 'games', 'proxy', 'stats', '404', 'ghost'];
const EGGS = ['shatter', 'ghost', 'console', 'konami', 'matrix', 'hello', 'digest', 'roll', 'askew',
  'snake', 'idle', 'clock', 'jelly', 'rm', 'reel'];
const TINTS = ['mono', 'green', 'pink', 'cyan', 'amber', 'violet', 'chaos', 'gold', 'signal'];
const TIERS = ['high', 'mid', 'low'];
const CMDS = ['help', 'eggs', 'clear', 'tint', 'fx', 'matrix', 'ghost', 'talk', 'ai', 'wake', 'reboot',
  'whoami', 'date', 'sudo', 'exit', 'ls', 'cd', 'cat', 'echo', 'hello', 'rm', 'history'];
const CMD_ARGS = {
  ls: ['-a', '-la', '-al'],
  cd: ['~', '/', '..', 'youtube', 'games', 'proxy', '.ghost', 'ghost'],
  fx: ['high', 'mid', 'low', 'auto'],
  tint: TINTS
};
const ROUTES = ['start', 'home', 'shorts', 'watch', 'search', 'channel', 'subs', 'library'];
const CLASSES = ['playing', 'browsing', 'egg-askew', 'egg-roll', 'egg-rm', 'egg-wobble', 'egg-rev', 'egg-quake'];
const GVIA = ['mask', 'knock', 'console', 'ghost', 'talk', 'ai', 'wake', 'cd', 'logo', 'hold', 'none'];
const GHOST_CMDS = ['clear', 'help', 'whoami', 'exit', 'signal', 'turn'];

function buildCodes() {
  const out = [];
  for (const a of AREAS.concat(['rx'])) out.push('nav:' + a);
  for (const e of EGGS) out.push('egg:' + e);
  for (const t of TINTS) out.push('tint:' + t);
  for (const t of TIERS) out.push('fx:' + t);
  for (const c of CMDS) out.push('cmd:' + c);
  for (const c of Object.keys(CMD_ARGS)) for (const a of CMD_ARGS[c]) out.push('cmd:' + c + ':' + a);
  for (const r of ROUTES) out.push('route:' + r);
  out.push('game:open', 'game:close', 'proxy:browse', 'proxy:home', 'stats:refused');
  for (const g of GHOST_CMDS) out.push('ghost:' + g);
  out.push('saver:on', 'saver:off', 'snake:start', 'snake:over');
  for (let s = 5; s <= 95; s += 5) out.push('snake:' + s);
  out.push('vis:hidden', 'vis:shown');
  return out;
}
const CODES = buildCodes();
const CODESET = new Set(CODES);
const BOUND = { route: 'yt', game: 'games', proxy: 'proxy', stats: 'stats', ghost: 'ghost', snake: '404' };

// kind: enum | int | set | list | hex8; server: overwritten from the hunt clock
const SCHEMA = {
  a: { kind: 'enum', values: AREAS },
  h: { kind: 'int', min: 0, max: 23, step: 1, server: true },
  mi: { kind: 'int', min: 0, max: 59, step: 1, server: true },
  dw: { kind: 'int', min: 0, max: 6, step: 1, server: true },
  day: { kind: 'int', min: -1, max: 400, step: 1, server: true },
  tint: { kind: 'enum', values: TINTS },
  fx: { kind: 'enum', values: TIERS },
  rm: { kind: 'int', min: 0, max: 1, step: 1 },
  ptr: { kind: 'enum', values: ['fine', 'coarse'] },
  vw: { kind: 'enum', values: ['xs', 's', 'm', 'l'] },
  or: { kind: 'enum', values: ['p', 'l'] },
  eggs: { kind: 'set', values: EGGS },
  dwell: { kind: 'int', min: 0, max: 3600, step: 5 },
  idle: { kind: 'int', min: 0, max: 3600, step: 5 },
  vis: { kind: 'int', min: 0, max: 20, step: 1 },
  scr: { kind: 'int', min: 0, max: 10, step: 1 },
  cls: { kind: 'set', values: CLASSES },
  saver: { kind: 'int', min: 0, max: 1, step: 1 },
  con: { kind: 'int', min: 0, max: 1, step: 1 },
  cmdn: { kind: 'int', min: 0, max: 50, step: 1 },
  snon: { kind: 'int', min: 0, max: 1, step: 1, areas: ['404'] },
  snake: { kind: 'int', min: 0, max: 99, step: 1, areas: ['404'] },
  snhi: { kind: 'int', min: 0, max: 99, step: 1 },
  ev: { kind: 'list', values: CODES, max: 24 },
  r: { kind: 'enum', values: ROUTES, areas: ['yt'] },
  gp: { kind: 'int', min: 0, max: 1, step: 1, areas: ['games'] },
  gfav: { kind: 'int', min: 0, max: 50, step: 1, areas: ['games'] },
  gtab: { kind: 'enum', values: ['all', 'fav'], areas: ['games'] },
  pb: { kind: 'int', min: 0, max: 1, step: 1, areas: ['proxy'] },
  pe: { kind: 'enum', values: ['sj', 'rh'], areas: ['proxy'] },
  sk: { kind: 'enum', values: ['prompt', 'board'], areas: ['stats'] },
  sw: { kind: 'int', min: 0, max: 1, step: 1, areas: ['stats'] },
  p4: { kind: 'hex8', areas: ['404'] },
  p4n: { kind: 'int', min: 0, max: 9, step: 1, areas: ['404'] },
  gst: { kind: 'enum', values: ['wait', 'awake', 'asleep', 'thinking', 'speaking', 'lost'], areas: ['ghost'] },
  gvia: { kind: 'enum', values: GVIA, areas: ['ghost'] },
  gturn: { kind: 'int', min: 0, max: 20, step: 1, areas: ['ghost'] }
};
const FACT_KEYS = Object.keys(SCHEMA);

function validCode(c) { return typeof c === 'string' && CODESET.has(c); }
function areaOf(code) {
  const i = code.indexOf(':');
  return BOUND[i < 0 ? code : code.slice(0, i)] || null;
}
function inDomain(key, v) {
  const d = SCHEMA[key];
  if (!d) return false;
  switch (d.kind) {
    case 'enum': return typeof v === 'string' && d.values.includes(v);
    case 'int': return Number.isInteger(v) && v >= d.min && v <= d.max && (v - d.min) % d.step === 0;
    case 'hex8': return typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);
    case 'set': return Array.isArray(v) && v.every((x) => d.values.includes(x)) && new Set(v).size === v.length;
    case 'list': return Array.isArray(v) && v.length <= d.max && v.every(validCode);
    default: return false;
  }
}

// step 1 of 9.5: unknown keys and out-of-domain values dropped (the caller overwrites
// the server facts afterwards)
function clean(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of FACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    let v = raw[k];
    if (k === 'ev' && Array.isArray(v)) v = v.filter(validCode).slice(-SCHEMA.ev.max);
    if (SCHEMA[k].kind === 'set' && Array.isArray(v)) v = Array.from(new Set(v.filter((x) => SCHEMA[k].values.includes(x))));
    if (inDomain(k, v)) out[k] = v;
  }
  return out;
}

// steps 2-3 of 9.5: { ok, ev } (ok false = implausible, answered like a no-match)
function hygiene(ev, area, lim) {
  const L = lim || { window: 12, maxRepeat: 3 };
  const w = (Array.isArray(ev) ? ev : []).filter(validCode).slice(-L.window);
  const n = new Map();
  for (const c of w) {
    n.set(c, (n.get(c) || 0) + 1);
    if (n.get(c) > L.maxRepeat) return { ok: false, ev: w };
  }
  let cur = null;
  for (const c of w) {
    if (c.startsWith('nav:')) { cur = c.slice(4); continue; }
    const b = areaOf(c);
    if (b && cur !== null && cur !== b) return { ok: false, ev: w };
  }
  if (cur !== null && cur !== area) return { ok: false, ev: w };
  return { ok: true, ev: w };
}

// 9.3: a leaf whose fact is missing is false
function match(c, f) {
  if (!c || typeof c !== 'object') return false;
  if (Array.isArray(c.all)) return c.all.every((x) => match(x, f));
  if (Array.isArray(c.any)) return c.any.some((x) => match(x, f));
  if (c.not) return !match(c.not, f);
  const v = f ? f[c.f] : undefined;
  if (v === undefined || v === null) return false;
  if ('eq' in c) return v === c.eq;
  if ('ne' in c) return v !== c.ne;
  if ('in' in c) return Array.isArray(c.in) && c.in.includes(v);
  if ('gte' in c) return typeof v === 'number' && v >= c.gte;
  if ('lte' in c) return typeof v === 'number' && v <= c.lte;
  if ('has' in c) return Array.isArray(v) && v.includes(c.has);
  if ('size' in c) {
    if (!Array.isArray(v)) return false;
    const s = c.size || {};
    return (s.gte === undefined || v.length >= s.gte) && (s.lte === undefined || v.length <= s.lte);
  }
  if ('seq' in c) {
    if (!Array.isArray(v) || !Array.isArray(c.seq)) return false;
    let i = 0;
    for (const x of v) if (i < c.seq.length && x === c.seq[i]) i++;
    return i === c.seq.length;
  }
  if ('run' in c) {
    if (!Array.isArray(v) || !Array.isArray(c.run)) return false;
    const k = c.run.length;
    outer: for (let i = 0; i + k <= v.length; i++) {
      for (let j = 0; j < k; j++) if (v[i + j] !== c.run[j]) continue outer;
      return true;
    }
    return false;
  }
  if ('last' in c) return Array.isArray(v) && v.length > 0 && v[v.length - 1] === c.last;
  if ('count' in c) {
    if (!Array.isArray(v)) return false;
    const q = c.count || {};
    let k = 0;
    for (const x of v) if (x === q.code) k++;
    return (q.gte === undefined || k >= q.gte) && (q.lte === undefined || k <= q.lte);
  }
  return false;
}

// the fact keys and event codes a condition reads (for the seal's ban check)
function leaves(c, out = { facts: new Set(), events: new Set() }) {
  if (!c || typeof c !== 'object') return out;
  if (Array.isArray(c.all)) c.all.forEach((x) => leaves(x, out));
  else if (Array.isArray(c.any)) c.any.forEach((x) => leaves(x, out));
  else if (c.not) leaves(c.not, out);
  else if (typeof c.f === 'string') {
    out.facts.add(c.f);
    if (c.f === 'ev') {
      for (const k of ['seq', 'run']) if (Array.isArray(c[k])) c[k].forEach((x) => out.events.add(x));
      if (typeof c.last === 'string') out.events.add(c.last);
      if (c.count && typeof c.count.code === 'string') out.events.add(c.count.code);
      for (const k of ['eq', 'ne', 'has']) if (typeof c[k] === 'string') out.events.add(c[k]);
      if (Array.isArray(c.in)) c.in.forEach((x) => typeof x === 'string' && out.events.add(x));
    }
  }
  return out;
}

// the server's whole order for one probe: clean, overwrite time, hygiene, then match
// every room. `time` = { h, mi, dw, day }. Returns the matching rooms.
function probe(rooms, raw, time, lim) {
  const f = clean(raw);
  Object.assign(f, time);
  if (!f.a) return [];
  const hy = hygiene(f.ev || [], f.a, lim);
  if (!hy.ok) return [];
  if (f.ev) f.ev = hy.ev;
  return rooms.filter((r) => (r.area === '*' || r.area === f.a) && match(r.cond, f));
}

export const facts = {
  SCHEMA, FACT_KEYS, AREAS, EGGS, TINTS, TIERS, CMDS, CMD_ARGS, ROUTES, CLASSES, GVIA, GHOST_CMDS,
  CODES, BOUND, validCode, areaOf, inDomain, clean, hygiene, match, leaves, probe
};
export { match };

/* ---------- planchette (CONTRACT 10) ---------- */

const ROWS_AZ = 'abcdefghi';
export const SPACE_MAX = 200000;

function cellName(r, c) { return ROWS_AZ[r] + (c + 1); }

function specOk(spec) {
  return spec && isInt(spec.rows) && isInt(spec.cols) && spec.rows >= 2 && spec.rows <= 9 && spec.cols >= 2 && spec.cols <= 9 &&
    typeof spec.alphabet === 'string' && spec.alphabet.length >= 2 && spec.alphabet.length <= 8 &&
    new Set(spec.alphabet).size === spec.alphabet.length && /^[\x21-\x7e]+$/.test(spec.alphabet) && !/[A-Za-z0-9]/.test(spec.alphabet);
}

// "b4" -> [1, 3] | null
function parseCell(tok, spec) {
  const m = /^([a-i])([1-9])$/.exec(tok || '');
  if (!m) return null;
  const r = ROWS_AZ.indexOf(m[1]), c = +m[2] - 1;
  return r < spec.rows && c < spec.cols ? [r, c] : null;
}
function parseNum(tok) { return /^(0|[1-9]\d?)$/.test(tok || '') ? +tok : null; }

// text -> { ok:true, canon, form, args } | { ok:false, error }
function parse(text, spec) {
  if (!specOk(spec)) return { ok: false, error: 'the board is not set' };
  if (typeof text !== 'string' || text.length > 200) return { ok: false, error: 'too long' };
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return { ok: false, error: 'empty' };
  const w = t.split(' ');
  const A = spec.alphabet;
  const glyph = (tok) => (typeof tok === 'string' && tok.length === 1 && A.includes(tok) ? tok : null);
  const gi = (g) => A.indexOf(g);
  const fail = (error) => ({ ok: false, error });
  const unknownGlyph = (tok) => (typeof tok === 'string' && tok.length === 1 && !/[a-z0-9]/.test(tok) ? 'unknown glyph' : 'unknown form');

  if (w[0] === 'is') {
    const a = parseCell(w[1], spec);
    if (!a) return fail(/^[a-z][0-9]$/.test(w[1] || '') ? 'no such cell' : 'unknown form');
    if (w.length === 3) {
      const g = glyph(w[2]);
      if (!g) return fail(unknownGlyph(w[2]));
      return { ok: true, form: 'cell', args: { r: a[0], c: a[1], g }, canon: 'is ' + cellName(a[0], a[1]) + ' ' + g };
    }
    if (w.length === 4 && w[2] === 'in') {
      const set = Array.from(w[3]);
      for (const g of set) if (!A.includes(g)) return fail('unknown glyph');
      if (new Set(set).size !== set.length) return fail('repeated glyph');
      if (set.length < 2 || set.length > A.length - 1) return fail('glyph set size');
      const G = set.sort((x, y) => gi(x) - gi(y)).join('');
      return { ok: true, form: 'set', args: { r: a[0], c: a[1], G }, canon: 'is ' + cellName(a[0], a[1]) + ' in ' + G };
    }
    if (w.length === 4 && w[2] === 'same') {
      const b = parseCell(w[3], spec);
      if (!b) return fail('no such cell');
      if (a[0] === b[0] && a[1] === b[1]) return fail('same cell twice');
      const [x, y] = [a, b].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      return { ok: true, form: 'same', args: { a: x, b: y }, canon: 'is ' + cellName(x[0], x[1]) + ' same ' + cellName(y[0], y[1]) };
    }
    if (w.length === 6 && w[3] === 'or' && w[0] === 'is') {
      const ga = glyph(w[2]), b = parseCell(w[4], spec), gb = glyph(w[5]);
      if (!ga || !gb) return fail('unknown glyph');
      if (!b) return fail('no such cell');
      if (a[0] === b[0] && a[1] === b[1]) return fail('same cell twice');
      const [x, y] = [[a[0], a[1], ga], [b[0], b[1], gb]].sort((p, q) => p[0] - q[0] || p[1] - q[1] || gi(p[2]) - gi(q[2]));
      return {
        ok: true, form: 'or', args: { a: [x[0], x[1]], ga: x[2], b: [y[0], y[1]], gb: y[2] },
        canon: 'is ' + cellName(x[0], x[1]) + ' ' + x[2] + ' or ' + cellName(y[0], y[1]) + ' ' + y[2]
      };
    }
    return fail('unknown form');
  }
  if (w[0] === 'count') {
    // count <g> in row <R> | col <C> | all  is|over|under <n>
    const g = glyph(w[1]);
    if (!g) return fail(w.length > 1 ? unknownGlyph(w[1]) : 'unknown form');
    if (w[2] !== 'in') return fail('unknown form');
    let where, i = 0, k, max;
    if (w[3] === 'all') { where = 'all'; k = 4; max = spec.rows * spec.cols; }
    else if (w[3] === 'row') {
      where = 'row'; i = ROWS_AZ.indexOf(w[4] || '');
      if (!/^[a-i]$/.test(w[4] || '') || i >= spec.rows) return fail('no such row');
      k = 5; max = spec.cols;
    } else if (w[3] === 'col') {
      where = 'col'; i = /^[1-9]$/.test(w[4] || '') ? +w[4] - 1 : -1;
      if (i < 0 || i >= spec.cols) return fail('no such column');
      k = 5; max = spec.rows;
    } else return fail('unknown form');
    if (w.length !== k + 2) return fail('unknown form');
    const op = w[k];
    if (op !== 'is' && op !== 'over' && op !== 'under') return fail('unknown form');
    const n = parseNum(w[k + 1]);
    if (n === null || n > max) return fail('bad number');
    const scope = where === 'all' ? 'all' : where === 'row' ? 'row ' + ROWS_AZ[i] : 'col ' + (i + 1);
    return { ok: true, form: 'count', args: { g, where, i, op, n }, canon: 'count ' + g + ' in ' + scope + ' ' + op + ' ' + n };
  }
  if (w[0] === 'in') {
    // in row <R> is <g> left of <g> | in col <C> is <g> above <g>
    if (w[1] === 'row' && w.length === 8 && w[3] === 'is' && w[5] === 'left' && w[6] === 'of') {
      const i = ROWS_AZ.indexOf(w[2]);
      if (!/^[a-i]$/.test(w[2]) || i >= spec.rows) return fail('no such row');
      const g1 = glyph(w[4]), g2 = glyph(w[7]);
      if (!g1 || !g2) return fail('unknown glyph');
      if (g1 === g2) return fail('same glyph twice');
      return { ok: true, form: 'order', args: { where: 'row', i, g1, g2 }, canon: 'in row ' + w[2] + ' is ' + g1 + ' left of ' + g2 };
    }
    if (w[1] === 'col' && w.length === 7 && w[3] === 'is' && w[5] === 'above') {
      const i = /^[1-9]$/.test(w[2]) ? +w[2] - 1 : -1;
      if (i < 0 || i >= spec.cols) return fail('no such column');
      const g1 = glyph(w[4]), g2 = glyph(w[6]);
      if (!g1 || !g2) return fail('unknown glyph');
      if (g1 === g2) return fail('same glyph twice');
      return { ok: true, form: 'order', args: { where: 'col', i, g1, g2 }, canon: 'in col ' + (i + 1) + ' is ' + g1 + ' above ' + g2 };
    }
    return fail('unknown form');
  }
  return fail('unknown form');
}

// truth of a parsed question; at(r, c) -> glyph index
function truthAt(p, spec, at) {
  const A = spec.alphabet, gi = (g) => A.indexOf(g), a = p.args;
  switch (p.form) {
    case 'cell': return at(a.r, a.c) === gi(a.g);
    case 'set': { const v = at(a.r, a.c); return v >= 0 && a.G.includes(A[v]); }
    case 'same': return at(a.a[0], a.a[1]) === at(a.b[0], a.b[1]);
    case 'or': return at(a.a[0], a.a[1]) === gi(a.ga) || at(a.b[0], a.b[1]) === gi(a.gb);
    case 'count': {
      const g = gi(a.g);
      let k = 0;
      for (let r = 0; r < spec.rows; r++) {
        if (a.where === 'row' && r !== a.i) continue;
        for (let c = 0; c < spec.cols; c++) {
          if (a.where === 'col' && c !== a.i) continue;
          if (at(r, c) === g) k++;
        }
      }
      return a.op === 'is' ? k === a.n : a.op === 'over' ? k > a.n : k < a.n;
    }
    case 'order': {
      const g1 = gi(a.g1), g2 = gi(a.g2), len = a.where === 'row' ? spec.cols : spec.rows;
      let i1 = -1, i2 = -1;
      for (let k = 0; k < len; k++) {
        const v = a.where === 'row' ? at(a.i, k) : at(k, a.i);
        if (v === g1 && i1 < 0) i1 = k;
        if (v === g2 && i2 < 0) i2 = k;
      }
      return i1 >= 0 && i2 >= 0 && i1 < i2;
    }
    default: throw new Error('form');
  }
}
function truth(p, grid, spec) {
  const A = spec.alphabet;
  return truthAt(p, spec, (r, c) => A.indexOf(grid[r * spec.cols + c]));
}

// Every grid of a latin spec consistent with its givens, as glyph-index rows in one
// Uint8Array: { n, cells, data, over }. over: the enumeration passed `max`.
function spaceIdx(spec, max = SPACE_MAX) {
  if (!specOk(spec)) throw new Error('spec');
  const R = spec.rows, C = spec.cols, A = spec.alphabet, K = A.length, N = R * C;
  if (!spec.latin || R !== C || C !== K) throw new Error('space needs a latin spec');
  const fixed = new Int8Array(N).fill(-1);
  for (const g of spec.givens || []) {
    if (!isInt(g.r) || !isInt(g.c) || g.r < 0 || g.c < 0 || g.r >= R || g.c >= C || A.indexOf(g.g) < 0) throw new Error('given');
    fixed[g.r * C + g.c] = A.indexOf(g.g);
  }
  const chunks = [];
  let cur = new Uint8Array(N * 4096), used = 0, n = 0, over = false;
  const g = new Uint8Array(N), rowM = new Uint16Array(R), colM = new Uint16Array(C);
  function rec(k) {
    if (over) return;
    if (k === N) {
      if (n >= max) { over = true; return; }
      if (used + N > cur.length) { chunks.push(cur.subarray(0, used)); cur = new Uint8Array(N * 4096); used = 0; }
      cur.set(g, used); used += N; n++;
      return;
    }
    const r = (k / C) | 0, c = k % C;
    for (let v = 0; v < K; v++) {
      if (fixed[k] >= 0 && fixed[k] !== v) continue;
      const b = 1 << v;
      if (rowM[r] & b || colM[c] & b) continue;
      g[k] = v; rowM[r] |= b; colM[c] |= b;
      rec(k + 1);
      rowM[r] &= ~b; colM[c] &= ~b;
    }
  }
  rec(0);
  chunks.push(cur.subarray(0, used));
  const data = new Uint8Array(n * N);
  let off = 0;
  for (const ch of chunks) { data.set(ch, off); off += ch.length; }
  return { n, cells: N, data, over };
}
function space(spec) {
  const s = spaceIdx(spec);
  const out = [];
  for (let i = 0; i < s.n; i++) {
    let str = '';
    for (let p = 0; p < s.cells; p++) str += spec.alphabet[s.data[i * s.cells + p]];
    out.push(str);
  }
  return out;
}

function isoOk(iso, spec) {
  if (!iso || typeof iso !== 'object' || (iso.t !== 0 && iso.t !== 1)) return false;
  if (iso.t === 1 && spec.rows !== spec.cols) return false;
  const perm = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => isInt(x) && x >= 0 && x < n) && new Set(a).size === n;
  return perm(iso.r, spec.rows) && perm(iso.c, spec.cols) && typeof iso.g === 'string' && iso.g.length === spec.alphabet.length &&
    Array.from(iso.g).every((x) => spec.alphabet.includes(x)) && new Set(iso.g).size === iso.g.length;
}

// view of a base space through an iso: at(i, r, c) -> glyph index in the drawn grid
function isoMap(spec, iso) {
  const R = spec.rows, C = spec.cols;
  const src = new Int32Array(R * C), gmap = new Int8Array(spec.alphabet.length);
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const x = iso ? iso.r[i] : i, y = iso ? iso.c[j] : j;
    src[i * C + j] = iso && iso.t ? y * C + x : x * C + y;
  }
  for (let k = 0; k < gmap.length; k++) gmap[k] = iso ? spec.alphabet.indexOf(iso.g[k]) : k;
  return { src, gmap };
}

// space: an array of grid strings, or a spaceIdx() result (optionally with .iso, the
// pass's draw: then the questions are about the drawn grids)
function forced(p, spec, sp) {
  if (!sp) return false;
  if (Array.isArray(sp)) {
    if (!sp.length) return true;
    const t0 = truth(p, sp[0], spec);
    for (let i = 1; i < sp.length; i++) if (truth(p, sp[i], spec) !== t0) return false;
    return true;
  }
  if (!sp.n) return true;
  const { src, gmap } = isoMap(spec, sp.iso || null), C = spec.cols, N = sp.cells, data = sp.data;
  let off = 0;
  const at = (r, c) => gmap[data[off + src[r * C + c]]];
  const t0 = truthAt(p, spec, at);
  for (let i = 1; i < sp.n; i++) {
    off = i * N;
    if (truthAt(p, spec, at) !== t0) return false;
  }
  return true;
}

// ctx = { asked: Set(canon), isLie: bool, forced: (parsed) -> bool }
function answer(p, grid, spec, ctx = {}) {
  if (ctx.asked && ctx.asked.has(p.canon)) return 'silence';
  if (ctx.forced && ctx.forced(p)) return 'silence';
  let v = truth(p, grid, spec);
  if (ctx.isLie) v = !v;
  return v ? 'yes' : 'no';
}

// 10.5: D[i][j] = G(B'[r[i]][c[j]]), B' = transpose(B) when t
function iso(gridString, spec, is) {
  if (!isoOk(is, spec)) throw new Error('iso');
  const { src, gmap } = isoMap(spec, is), A = spec.alphabet;
  let out = '';
  for (let p = 0; p < src.length; p++) out += A[gmap[A.indexOf(gridString[src[p]])]];
  return out;
}
function isoCell(rc, is) {
  let [R, C] = rc;
  if (is.t) [R, C] = [C, R];
  return [is.r.indexOf(R), is.c.indexOf(C)];
}
function isoGivens(givens, spec, is) {
  if (!isoOk(is, spec)) throw new Error('iso');
  const G = (x) => is.g[spec.alphabet.indexOf(x)];
  return givens.map((x) => { const [r, c] = isoCell([x.r, x.c], is); return { r, c, g: G(x.g) }; })
    .sort((a, b) => a.r - b.r || a.c - b.c);
}

// 10.6: a canonical base question mapped through the pass's iso, as canonical text
const MAP_FORMS = ['cell', 'set', 'same', 'or', 'count'];
function mapQ(canonText, spec, is) {
  const p = parse(canonText, spec);
  if (!p.ok || !MAP_FORMS.includes(p.form)) throw new Error('placeholder form');
  const G = (x) => is.g[spec.alphabet.indexOf(x)], a = p.args;
  let t;
  switch (p.form) {
    case 'cell': { const [r, c] = isoCell([a.r, a.c], is); t = 'is ' + cellName(r, c) + ' ' + G(a.g); break; }
    case 'set': { const [r, c] = isoCell([a.r, a.c], is); t = 'is ' + cellName(r, c) + ' in ' + Array.from(a.G).map(G).join(''); break; }
    case 'same': { const x = isoCell(a.a, is), y = isoCell(a.b, is); t = 'is ' + cellName(x[0], x[1]) + ' same ' + cellName(y[0], y[1]); break; }
    case 'or': { const x = isoCell(a.a, is), y = isoCell(a.b, is); t = 'is ' + cellName(x[0], x[1]) + ' ' + G(a.ga) + ' or ' + cellName(y[0], y[1]) + ' ' + G(a.gb); break; }
    default: {
      if (a.where === 'all') { t = 'count ' + G(a.g) + ' in all ' + a.op + ' ' + a.n; break; }
      const isRow = (a.where === 'row') !== !!is.t;
      const i = isRow ? is.r.indexOf(a.i) : is.c.indexOf(a.i);
      t = 'count ' + G(a.g) + ' in ' + (isRow ? 'row ' + ROWS_AZ[i] : 'col ' + (i + 1)) + ' ' + a.op + ' ' + a.n;
    }
  }
  return parse(t, spec).canon;
}

function placeholderForms(text) {
  const out = [];
  String(text).replace(/\{\{q:([^}]+)\}\}/g, (_, c) => { out.push(c); return ''; });
  return out;
}

// hint and walkthrough placeholders, rendered for one pass.
// r = { spec, iso, grid (drawn), givens (drawn), cellsSeed (32-byte Buffer) }
function render(text, r) {
  let s = String(text);
  if (!r || !r.spec) return s;
  if (r.iso) s = s.replace(/\{\{q:([^}]+)\}\}/g, (_, c) => mapQ(c, r.spec, r.iso));
  if (r.grid) {
    s = s.replace(/\{\{cells:(\d+)\}\}/g, (_, n) => {
      const given = new Set((r.givens || []).map((x) => x.r * r.spec.cols + x.c));
      const pool = [];
      for (let k = 0; k < r.spec.rows * r.spec.cols; k++) if (!given.has(k)) pool.push(k);
      rng(r.cellsSeed || Buffer.alloc(32)).shuffle(pool);
      return pool.slice(0, +n).sort((a, b) => a - b)
        .map((k) => cellName((k / r.spec.cols) | 0, k % r.spec.cols) + ' ' + r.grid[k]).join(', ');
    });
    s = s.replace(/\{\{grid\}\}/g, () => {
      const rows = [];
      for (let i = 0; i < r.spec.rows; i++) rows.push(r.grid.slice(i * r.spec.cols, (i + 1) * r.spec.cols));
      return rows.join('\n');
    });
    s = s.replace(/\{\{givens\}\}/g, () => (r.givens || []).map((x) => cellName(x.r, x.c) + ' ' + x.g).join(', '));
  }
  return s;
}

export const planchette = {
  ROWS: ROWS_AZ, cellName, specOk, parse, truth, space, spaceIdx, forced, answer, iso, isoOk, isoGivens, isoMap,
  mapQ, placeholderForms, render
};
