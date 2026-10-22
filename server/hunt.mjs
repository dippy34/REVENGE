// hunt.mjs: the signal's engine and every /api/hunt/* route (docs/07-hunt.md).
//
// Generic: it loads sealed packs (server/hunt/*.pack, AES-256-GCM) and serves each
// frequency by its schedule. Every word a player reads and every answer, condition,
// grid and goal comes from a pack; nothing here knows any stage's content.
//
//   GET  /api/hunt/status              what is on the air (POST {cert} inside a head start)
//   POST /api/hunt/door                {line, cert?} -> a pass
//   POST /api/hunt/state|stage         progress, one stage's data
//   POST /api/hunt/answer|probe|ask    answers, page snapshots, planchette questions
//   POST /api/hunt/reveal|echo|cert|verify|wall|tally|walkthrough|recover
//   POST /api/hunt/run/start|seed|end  ranked runs of the skill stages
//   /api/hunt/sandbox/*                sandbox only, loopback + admin token
//
// Privacy: no logging of requests, answers, questions, probes, run inputs or addresses.
// The only persistent state is one small file of counters keyed by HMAC(pass id), at day
// granularity, purged when a frequency goes cold (see docs/07-hunt.md, "Privacy").
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as lib from './hunt-lib.mjs';
import { clientIp, visitorKey } from './ai.mjs';
import { validatePack, specOf } from './hunt-pack.mjs';
import { installRoutes } from './hunt-routes.mjs';
import { installPlay } from './hunt-play.mjs';
import { installRuns } from './hunt-runs.mjs';

const { b64u, H, F_RE } = lib;
export { validatePack, specOf };
const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const TYPES = ['broadcast', 'log', 'rooms', 'planchette', 'run', 'final'];

export const LIMITS = {
  door: { ipPerHour: 120, netPerHour: 600, mintPerIpDay: 300, mintPerNetDay: 2000, headStartPerCert: 2 },
  records: { max: 200000, evictAfterDays: 7 },
  read: { passPerMin: 60, ipPerMin: 600 },
  answer: { passPerDay: 48, ipPerHour: 1200, minGapMs: 1500 },
  probe: { minGapMs: 3000, passPerDay: 1500, ipPerMin: 240, window: 12, maxRepeat: 3 },
  ask: { ipPerHour: 600 },
  run: { rankedPerDay: 30, ipPerHour: 300, maxLog: 20000, maxBody: 65536, ttlMs: 3600000,
    concurrent: 1, maxActive: 300, ipActive: 6, uploadGapMs: 200, feedSlackMs: 2000, ahead: 1,
    ipUploadPerMin: 1200, staleMs: 60000 },
  final: { perDay: 4, cooldownMin: 20 },
  verify: { ipPerMin: 120 },
  wall: { ipPerHour: 10, ipPerDay: 1 },
  recover: { ipPerHour: 10 },
  body: { maxBytes: 16384 },
  status: { ipPerMin: 240 },
  mem: { passes: 100000, addrs: 100000, asked: 50000, probes: 100000 }
};

export const SAY = {
  correct: 'the needle holds.', warm: 'that is a step, not the end.',
  wrong: 'static.', foreign: 'that signal belongs to another listener.',
  solved: 'already received.', early: 'not yet.',
  limit: 'the air is saturated. try again later.', cooldown: 'it is still settling.',
  budget: 'nothing more on this band today.', closed: 'the board rests until the next utc day.',
  took: 'it took.', nottaken: 'it did not take.',
  cleared: 'the rings are quiet.', failed: 'the snake slipped.',
  rejected: 'that run did not come through.',
  implausible: 'the band could not follow that run (a timing check).',
  locked: 'nothing on this band yet.',
  nopass: 'no receiver.', badpass: 'that receiver is not ours.',
  off: 'the band is empty.', cold: 'this frequency has gone cold.',
  door_ok: 'the needle catches.', door_no: 'only static on that band.',
  invalid: 'that did not come through.', recovered: 'the receiver is yours again.',
  busy: 'one run at a time.', gone: 'that frequency is off the air.',
  grammar: 'the planchette does not understand that.', lost: 'that did not come through.'
};

const FWD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/* ---------- small helpers ---------- */

class Lru {
  constructor(max) { this.max = Math.max(1, max | 0); this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  peek(k) { return this.m.get(k); }
  set(k, v) {
    this.m.delete(k); this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return v;
  }
  delete(k) { this.m.delete(k); }
  get size() { return this.m.size; }
  keys() { return this.m.keys(); }
  entries() { return this.m.entries(); }
}

// fixed windows: 0 when allowed (and counted), else seconds until the window ends
function hit(store, key, limit, windowMs, t) {
  if (!(limit > 0)) return 0;
  let w = store.get(key);
  if (!w || t - w.t0 >= windowMs || t < w.t0) w = store.set(key, { t0: t, n: 0 });
  if (w.n >= limit) return Math.max(1, Math.ceil((w.t0 + windowMs - t) / 1000));
  w.n++;
  return 0;
}

function mergeLimits(base, over) {
  const out = {};
  for (const g of Object.keys(base)) {
    out[g] = Object.assign({}, base[g]);
    const o = over && over[g];
    if (o && typeof o === 'object') for (const k of Object.keys(o)) if (Number.isFinite(o[k])) out[g][k] = o[k];
  }
  return out;
}

const isInt = (x) => Number.isSafeInteger(x);
const isStr = (x, max) => typeof x === 'string' && x.length <= max;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const hex32 = (x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
const isoMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN);
const bitOf = (st) => 1 << (st.n - 1);

function netOf(vk) {
  if (vk.endsWith('::/64')) return vk.split(':').slice(0, 3).join(':') + '::/48';
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(vk);
  return m ? m[1] + '.0/24' : vk;
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; }
}

function utcParts(t) {
  const d = new Date(t);
  return { h: d.getUTCHours(), mi: d.getUTCMinutes(), dw: d.getUTCDay() };
}

/* ---------- the engine ---------- */


export function createHunt(o = {}) {
  const env = o.env || process.env;
  const siteDir = path.resolve(o.siteDir || path.join(here, '..', 'site'));
  const sandbox = env.HUNT_SANDBOX === '1';
  const host = o.host == null ? String(env.HOST || '127.0.0.1') : String(o.host);
  const log = (s) => { if (!o.quiet) console.log(s); };

  const prodData = path.resolve(env.STATS_DIR || path.join(here, '.data'), 'hunt');
  const dataDir = path.resolve(o.dataDir || env.HUNT_DATA_DIR || (sandbox ? path.join(here, '.data', 'hunt-sandbox') : prodData));
  const packDir = path.resolve(o.packDir || env.HUNT_PACK_DIR || path.join(here, 'hunt'));

  if (sandbox) {
    const why = String(env.NODE_ENV || '').toLowerCase() === 'production' ? 'production'
      : !LOOPBACK_HOSTS.has(host) ? 'host'
      : env.STATS_DIR ? 'statsdir'
      : (dataDir === prodData || !path.basename(dataDir).startsWith('hunt-sandbox')) ? 'datadir' : '';
    if (why) throw new Error('hunt: refusing HUNT_SANDBOX (' + why + ')');
  }

  const K = lib.deriveKeys({ HUNT_KEY: env.HUNT_KEY || '', HUNT_HMAC: env.HUNT_HMAC || '', HUNT_SIGN_KEY: env.HUNT_SIGN_KEY || '' }, sandbox);
  if (K && env.HUNT_SEED) log('hunt: HUNT_SEED is set here; only the sealing machine needs it');

  /* ----- clocks ----- */
  const clk = { base: 0, at: Date.now(), speed: 1 };
  if (sandbox) {
    const sp = Number(env.HUNT_CLOCK_SPEED);
    clk.speed = Number.isFinite(sp) && sp >= 1 && sp <= 100000 ? sp : 1;
    const st = env.HUNT_CLOCK_START ? Date.parse(env.HUNT_CLOCK_START) : NaN;
    clk.base = Number.isFinite(st) ? st : Date.now();
  }
  const now = () => (o.clock ? o.clock() : sandbox ? Math.floor(clk.base + (Date.now() - clk.at) * clk.speed) : Date.now());
  const real = () => (o.realClock ? o.realClock() : Date.now());

  /* ----- admin token (sandbox only) ----- */
  let adminToken = '';
  if (sandbox) {
    const t = String(env.HUNT_SANDBOX_TOKEN || '');
    adminToken = t.length >= 32 ? t : b64u.enc(crypto.randomBytes(24));
    console.log('HUNT SANDBOX ON: clock x' + clk.speed + ' from ' + new Date(clk.base).toISOString() + ', data in ' +
      path.basename(dataDir) + ', admin token ' + adminToken + '. never use this in production.');
  }

  /* ----- the sim (optional) ----- */
  let sim = o.sim || null;
  if (!sim) {
    try { sim = createRequire(import.meta.url)(path.join(siteDir, 'js', 'hunt-sim.js')); } catch (e) { sim = null; }
  }

  /* ----- state ----- */
  const stateFile = path.join(dataDir, 'state.json');
  let state = { v: 1, freqs: {} };
  let dirty = false;
  const memRecs = new Map();      // records that did not fit (memory only)
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (isObj(s) && s.v === 1 && isObj(s.freqs)) state = s;
  } catch (e) { /* first start */ }

  function fstate(P) {
    const f = state.freqs[P.f] || (state.freqs[P.f] = {});
    if (!isObj(f.recs)) f.recs = {};
    for (const k of ['solved', 'rej', 'hs', 'tally']) if (!isObj(f[k])) f[k] = {};
    if (!Array.isArray(f.wall)) f.wall = [];
    if (f.purged === undefined) f.purged = null;
    return f;
  }
  function saveSoon() { dirty = true; }
  function flush() {
    if (!dirty || !K) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = stateFile + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
      dirty = false;
    } catch (e) { console.log('hunt: internal error (state)'); }
  }

  /* ----- limits and memory-only stores ----- */
  const LIM = mergeLimits(LIMITS, null);
  const mem = LIM.mem;
  const rl = new Lru(mem.addrs * 4);          // fixed windows
  const passMem = new Lru(mem.passes);        // per pass: last answer/probe times, probe counters
  const askedMem = new Lru(mem.asked);        // recKey|day -> Set(canon)
  const coolMem = new Lru(mem.passes);        // recKey -> final cooldown end
  const warmMem = new Lru(mem.passes);        // recKey|stage -> 1 (a warm answer was heard)
  const wallMarks = new Lru(mem.addrs);       // addr|day
  const runs = new Map();                     // run id -> run
  const runByPass = new Map();                // recKey -> run id
  let salt = { day: -1, key: crypto.randomBytes(16) };
  function dailySalt() {
    const d = Math.floor(real() / DAY);
    if (d !== salt.day) salt = { day: d, key: crypto.randomBytes(16) };
    return salt.key;
  }
  function addrOf(req) {
    const vk = visitorKey(clientIp(req));
    const k = dailySalt();
    return { ip: lib.hmacHex(k, 'a|' + vk).slice(0, 24), net: lib.hmacHex(k, 'n|' + netOf(vk)).slice(0, 24) };
  }
  // 0 when allowed (counted), else seconds to wait
  function hitWin(key, limit, windowMs) { return hit(rl, key, limit, windowMs, real()); }

  /* ----- packs ----- */
  const packs = new Map();       // f -> P
  const files = new Map();       // file name -> { f, mtime } | { skip: mtime }
  const walkCache = new Map();   // f -> opened public walkthrough | null
  function packSummary() {
    return Array.from(packs.values()).map((P) => P.f);
  }

  function buildRuntime(pack, file, mtime) {
    const P = {
      f: pack.f, n: pack.n, kind: pack.kind, pack, file, mtime,
      V: pack.lineages,
      openMs: isoMs(pack.schedule.opensAt), coldMs: isoMs(pack.schedule.coldAt),
      stages: pack.stages, byId: new Map(pack.stages.map((s) => [s.id, s])),
      lim: mergeLimits(LIMITS, pack.limits), spaces: new Map(), draws: null
    };
    P.final = pack.stages.find((s) => s.type === 'final') || pack.stages[pack.stages.length - 1];
    return P;
  }

  function enumerate(P) {
    for (const st of P.stages) {
      if (st.type !== 'planchette') continue;
      for (let L = 0; L < P.V; L++) {
        const lin = st.lineages[L];
        if (!lin.pub.latin) continue;
        const sp = lib.planchette.spaceIdx(specOf(lin));
        if (sp.over || sp.n !== lin.sec.count || sp.n > lib.SPACE_MAX) return false;
        P.spaces.set(st.id + '|' + L, sp);
      }
    }
    return true;
  }

  function frozenCheck(P) {
    for (const [rel, h] of Object.entries(P.pack.frozen)) {
      const file = path.resolve(siteDir, rel);
      if (!file.startsWith(siteDir + path.sep)) continue;
      if (sha256File(file) !== h) log('hunt: ' + P.f + ' frozen file changed since seal: ' + rel);
    }
  }

  function scanPacks() {
    if (!K) return;
    let names = [];
    try { names = fs.readdirSync(packDir).filter((n) => n.endsWith('.pack')); } catch (e) { names = []; }
    const seen = new Set(names);
    for (const name of names) {
      const file = path.join(packDir, name);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch (e) { continue; }
      const had = files.get(name);
      if (had && had.mtime === mtime) continue;
      const skip = (why) => { files.set(name, { skip: true, mtime }); if (!had || !had.skip) log('hunt: skipped ' + name + ' (' + why + ')'); };
      try {
        const env_ = lib.readEnvelope(fs.readFileSync(file, 'utf8'));
        if (env_.kind !== 'pack' || !isStr(env_.f, 16) || !F_RE.test(env_.f) || name !== env_.f + '.pack') return skip('name');
        if (env_.kid !== K.kid) return skip('other key');
        const pack = lib.openJson(env_, K.aes, { kind: 'pack', f: env_.f, kid: K.kid });
        const bad = validatePack(pack);
        if (bad || pack.f !== env_.f) return skip(bad || 'id');
        const P = buildRuntime(pack, name, mtime);
        if (!enumerate(P)) return skip('space');
        packs.set(P.f, P);
        files.set(name, { f: P.f, mtime });
        walkCache.delete(P.f);
        frozenCheck(P);
        log('hunt: loaded ' + P.f + ' (' + P.V + ' lineages, ' + P.stages.length + ' stages)');
      } catch (e) { skip('unreadable'); }
    }
    for (const [name, v] of files) {
      if (!seen.has(name)) { files.delete(name); if (v.f && packs.get(v.f) && packs.get(v.f).file === name) packs.delete(v.f); }
    }
  }

  /* ----- phases, days ----- */
  const phaseOf = (P, t) => (t < P.openMs ? 'upcoming' : t < P.coldMs ? 'live' : 'cold');
  const dayOf = (P, t) => Math.floor((t - P.openMs) / DAY);
  const bitOfStage = (st) => 1 << (st.n - 1);
  const say = (P, code) => ((P && P.pack.public.say && P.pack.public.say[code]) || SAY[code] || '');

  /* ----- housekeeping ----- */
  function housekeeping() {
    const t = now();
    for (const P of packs.values()) {
      const F = fstate(P);
      const day = dayOf(P, t);
      if (t >= P.coldMs && F.purged == null) {
        F.recs = {}; F.hs = {}; F.purged = day;
        memRecs.clear();
        dirty = true;
        continue;
      }
      if (t < P.coldMs) {
        for (const k of Object.keys(F.recs)) {
          const r = F.recs[k];
          if (!Object.keys(r.s || {}).length && r.la <= day - P.lim.records.evictAfterDays) { delete F.recs[k]; dirty = true; }
        }
      }
    }
    if (X.runSweep) X.runSweep();
    flush();
  }

  /* ----- records (7.3) ----- */
  function recKey(P, id) { return lib.H.rec(K.state, P.f, id); }
  function getRec(P, id) {
    const k = recKey(P, id);
    return fstate(P).recs[k] || memRecs.get(P.f + '|' + k) || null;
  }
  function pruneRec(rec, day) {
    for (const k of ['a', 'r', 'x']) {
      const m = rec[k];
      if (!m) continue;
      for (const d of Object.keys(m)) if (+d !== day) delete m[d];
    }
  }
  function ensureRec(c) {
    const P = c.P;
    let rec = getRec(P, c.id);
    if (rec) { rec.la = c.day; pruneRec(rec, c.day); dirty = true; return rec; }
    rec = { d0: c.pass.d, la: c.day, o: {}, s: {}, h: {}, lt: 0, lu: 0, q: {}, a: {}, r: {}, x: {} };
    const bits = c.pass.s;
    for (const st of P.stages) if (bits & bitOfStage(st)) rec.s[st.id] = c.day;
    for (const st of P.stages) {
      const open = st.requires.every((id) => rec.s[id] !== undefined);
      if (!st.requires.length) rec.o[st.id] = c.pass.d;
      else if (open || rec.s[st.id] !== undefined) rec.o[st.id] = c.day;
    }
    const F = fstate(P);
    const key = recKey(P, c.id);
    if (Object.keys(F.recs).length >= P.lim.records.max) {
      let oldest = null;
      for (const k of Object.keys(F.recs)) {
        const r = F.recs[k];
        if (Object.keys(r.s).length) continue;
        if (!oldest || r.la < F.recs[oldest].la) oldest = k;
      }
      if (oldest) { delete F.recs[oldest]; F.recs[key] = rec; } else memRecs.set(P.f + '|' + key, rec);
    } else F.recs[key] = rec;
    dirty = true;
    return rec;
  }
  function recBits(P, rec) {
    let b = 0;
    if (rec) for (const st of P.stages) if (rec.s[st.id] !== undefined) b |= bitOfStage(st);
    return b;
  }

  /* ----- pass context ----- */
  function mintPass(P, t, extra) {
    const id = b64u.enc(crypto.randomBytes(16));
    const d = extra && extra.hs ? -1 : dayOf(P, t);
    const payload = { v: 1, k: 'pass', f: P.f, id, d, s: 0, h: 0 };
    if (sandbox) payload.sb = 1;
    if (extra && extra.hs) payload.hs = 1;
    return { payload, token: lib.sign('p1', payload, K.priv) };
  }
  function reissue(c, bits, h) {
    const p = { v: 1, k: 'pass', f: c.P.f, id: c.id, d: c.pass.d, s: bits, h: h ? 1 : 0 };
    if (sandbox) p.sb = 1;
    if (c.pass.hs) p.hs = 1;
    return lib.sign('p1', p, K.priv);
  }
  function ctxOf(payload, req) {
    const P = packs.get(payload.f);
    if (!P) return null;
    const t = now();
    const phase = phaseOf(P, t);
    return { P, pass: payload, id: payload.id, t, day: dayOf(P, t), phase, late: phase === 'cold', live: phase === 'live', rk: recKey(P, payload.id), req };
  }
  function verifyPass(str) {
    if (typeof str !== 'string' || !str) return { err: 'nopass' };
    const p = lib.verifyToken(str, K.pub, { loaded: (f) => packs.has(f), sandbox });
    if (!p || p.k !== 'pass') return { err: 'badpass' };
    return { payload: p };
  }
  function verifyCert(str) {
    const p = lib.verifyToken(str, K.pub, { loaded: (f) => packs.has(f), sandbox });
    return p && p.k === 'cert' ? p : null;
  }

  /* ----- progress ----- */
  function progressBits(c) {
    return c.late ? c.pass.s : (c.pass.s | recBits(c.P, getRec(c.P, c.id)));
  }
  function stageOpen(c, st, bits) {
    return st.requires.every((id) => bits & bitOfStage(c.P.byId.get(id)));
  }
  function stageStateOf(c, st, bits) {
    if (bits & bitOfStage(st)) return 'solved';
    return stageOpen(c, st, bits) ? 'open' : 'locked';
  }
  function openDayOf(c, st, rec) {
    if (c.late) return c.day;
    if (rec && rec.o[st.id] !== undefined) return rec.o[st.id];
    return st.requires.length ? c.day : c.pass.d;
  }
  function solveStage(c, rec, st) {
    const F = fstate(c.P);
    const first = rec.s[st.id] === undefined;
    rec.s[st.id] = c.day;
    if (first) F.solved[st.id] = (F.solved[st.id] || 0) + 1;
    const unlocked = [];
    for (const y of c.P.stages) {
      if (rec.o[y.id] === undefined && y.requires.every((id) => rec.s[id] !== undefined)) { rec.o[y.id] = c.day; unlocked.push(y.id); }
    }
    dirty = true;
    return unlocked;
  }
  function unlitOf(c, rec) {
    if (c.late) return false;
    const used = rec && (Object.keys(rec.h).length > 0 || rec.lu > 0);
    return !used && !c.pass.h;
  }
  function freqSolved(c, bits) { return !!(bits & bitOfStage(c.P.final)); }
  function issueCert(c, bits) {
    const rec = c.late ? null : getRec(c.P, c.id);
    const solvedDay = rec && rec.s[c.P.final.id] !== undefined ? rec.s[c.P.final.id] : c.day;
    const p = { v: 1, k: 'cert', f: c.P.f, n: c.P.n, kind: c.P.kind, id: lib.H.certId(K.state, c.P.f, c.id),
      day: solvedDay, unlit: !c.late && unlitOf(c, rec) ? 1 : 0, late: c.late ? 1 : 0 };
    if (sandbox) p.sb = 1;
    return lib.sign('c1', p, K.priv);
  }

  /* ----- gating, hints, per-pass draws ----- */
  function gate(v, day, openDay, late) {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (isObj(x) && !late) {
          if (isInt(x.$day) && day < x.$day) continue;
          if (isInt(x.$rel) && day < openDay + x.$rel) continue;
        }
        out.push(gate(x, day, openDay, late));
      }
      return out;
    }
    if (isObj(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = gate(v[k], day, openDay, late);
      return out;
    }
    return v;
  }
  // the pass's drawn grid of a planchette stage (10.5)
  function drawOf(c, st) {
    const L = lib.H.lineage(K.state, c.P.f, c.id, c.P.V);
    const lin = st.lineages[L];
    const spec = specOf(lin);
    const pool = lin.sec.pool;
    const iso = pool[lib.H.draw(K.state, c.P.f, st.id, c.id, pool.length)];
    return { L, lin, spec, iso,
      grid: lib.planchette.iso(lin.sec.grid, spec, iso),
      givens: lib.planchette.isoGivens(lin.sec.givens, spec, iso) };
  }
  function planchetteStage(P) { return P.stages.find((s) => s.type === 'planchette') || null; }
  function renderFor(c, st, text) {
    if (st.type !== 'planchette' && !/\{\{(grid|givens)\}\}/.test(text)) return text;
    const ps = st.type === 'planchette' ? st : planchetteStage(c.P);
    if (!ps) return text;
    const d = drawOf(c, ps);
    return lib.planchette.render(text, { spec: d.spec, iso: d.iso, grid: d.grid, givens: d.givens, cellsSeed: lib.H.hintCells(K.state, c.P.f, ps.id, c.id) });
  }
  // cfg of a run/final stage, bound to the pass's drawn grid when the stage says so
  function boundCfg(c, st, lin) {
    const cfg = lin.pub.cfg;
    if (!st.bind) return cfg;
    if (!sim || !sim.bind) return undefined;
    const ps = c.P.byId.get(st.bind.grid);
    const d = drawOf(c, ps);
    return sim.bind(cfg, { grid: { rows: d.spec.rows, cols: d.spec.cols, alphabet: d.spec.alphabet, cells: d.grid } });
  }

  const X = {
    env, siteDir, packDir, sandbox, dataDir, K, LIM, mem, now, real, clk, adminToken, sim, state, packs, fstate, saveSoon, flush,
    rl, passMem, askedMem, coolMem, warmMem, wallMarks, runs, runByPass, memRecs, walkCache,
    hit: hitWin, addrOf, say, phaseOf, dayOf, bitOfStage, getRec, ensureRec, recBits, recKey, mintPass, reissue, ctxOf,
    verifyPass, verifyCert, progressBits, stageOpen, stageStateOf, openDayOf, solveStage, unlitOf, freqSolved, issueCert,
    gate, drawOf, planchetteStage, renderFor, boundCfg, log, lib, utcParts, HOUR_MS: 3600000, DAY,
    fail: (P, code, status, extra) => [status || 200, Object.assign({ ok: false, error: code, say: say(P, code) }, extra || {})],
    routes: Object.create(null),
    setClock(base, speed) { clk.base = base; clk.at = Date.now(); clk.speed = speed; },
    scanPacks, housekeeping
  };
  installRoutes(X);
  installPlay(X);
  installRuns(X);

  /* ----- http ----- */
  const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  function send(res, code, body, extra) {
    if (res.headersSent) return res.end();
    res.writeHead(code, Object.assign({}, HEADERS, extra || {}));
    res.end(JSON.stringify(body));
  }
  const off = (res) => send(res, 404, { ok: false, error: 'off', say: SAY.off });

  function adminOk(req) {
    const peer = (req.socket && req.socket.remoteAddress) || '';
    if (!LOOPBACK_PEERS.has(peer)) return false;
    for (const h of FWD_HEADERS) if (req.headers[h] !== undefined) return false;
    const a = Buffer.from(String(req.headers['x-hunt-admin'] || ''));
    const b = Buffer.from(adminToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function readJson(req, max) {
    return new Promise((resolve) => {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) return resolve({ code: 415 });
      const sf = req.headers['sec-fetch-site'];
      if (sf !== undefined && sf !== 'same-origin' && sf !== 'none') return resolve({ code: 403 });
      let size = 0, done = false;
      const chunks = [];
      req.on('data', (ch) => {
        if (done) return;
        size += ch.length;
        if (size > max) { done = true; chunks.length = 0; resolve({ code: 413 }); return; }
        chunks.push(ch);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(isObj(b) ? { body: b } : { code: 400 });
        } catch (e) { resolve({ code: 400 }); }
      });
      req.on('error', () => { if (!done) { done = true; resolve({ code: 400 }); } });
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const name = url.pathname.replace(/^\/api\/hunt\//, '');
    if (!K) {
      if (name === 'status' && req.method === 'GET') return send(res, 200, { v: 1, on: false });
      return off(res);
    }
    const def = X.routes[name];
    if (!def || (def.sandbox && !sandbox)) return off(res);
    if ((def.admin || (def.adminInSandbox && sandbox)) && !adminOk(req)) return off(res);
    if (!def.methods.includes(req.method)) return send(res, 405, { ok: false, error: 'method' }, { allow: def.methods.join(', ') });
    const addr = addrOf(req);
    const lim = def.addr ? def.addr(X, addr) : 0;
    if (lim) return send(res, 429, { ok: false, error: 'limit', say: SAY.limit }, { 'retry-after': String(lim) });
    let body = {};
    if (req.method === 'POST') {
      const r = await readJson(req, def.maxBody || LIM.body.maxBytes);
      if (r.code) {
        // an oversized body: answer, then drop the connection (the rest of the upload is not read)
        if (r.code === 413) res.once('finish', () => req.destroy());
        return send(res, r.code, { ok: false, error: 'invalid', say: SAY.invalid }, r.code === 413 ? { connection: 'close' } : undefined);
      }
      body = r.body;
    }
    let c = null;
    if (def.pass) {
      const v = verifyPass(body.pass);
      if (v.err) return send(res, 401, { ok: false, error: v.err, say: SAY[v.err] });
      c = ctxOf(v.payload, req);
      if (!c) return send(res, 401, { ok: false, error: 'badpass', say: SAY.badpass });
      c.addr = addr;
      const pl = def.passLim ? def.passLim(X, c) : 0;
      if (pl) return send(res, 429, { ok: false, error: 'limit', say: say(c.P, 'limit') }, { 'retry-after': String(pl) });
    }
    const out = await def.fn(X, c, body, req, addr);
    if (Array.isArray(out)) return send(res, out[0], out[1], out[2]);
    return send(res, 200, out);
  }

  async function handle(req, res) {
    try { await route(req, res); } catch (e) {
      console.log('hunt: internal error (' + ((e && e.name) || 'Error') + ')');
      try { send(res, 500, { ok: false, error: 'lost', say: SAY.lost }); } catch (x) { /* gone */ }
    }
  }

  function summary() {
    if (!K) return 'hunt off';
    if (!packs.size) return 'hunt: no packs';
    const t = now();
    const parts = [];
    for (const P of packs.values()) {
      const ph = phaseOf(P, t);
      parts.push(P.f + ' ' + (ph === 'live' ? 'live day ' + dayOf(P, t) : ph));
    }
    return 'hunt: ' + packs.size + (packs.size === 1 ? ' pack, ' : ' packs, ') + parts.join(', ');
  }

  /* ----- start ----- */
  scanPacks();
  housekeeping();
  const timers = [];
  if (K && !o.noTimers) {
    timers.push(setInterval(flush, 30000), setInterval(housekeeping, 600000), setInterval(scanPacks, 60000));
    for (const tm of timers) tm.unref();
  }
  function close() { for (const tm of timers) clearInterval(tm); flush(); }

  return { handle, flush, summary, close, _x: X };
}
