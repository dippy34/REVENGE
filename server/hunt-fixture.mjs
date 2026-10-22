// hunt-fixture.mjs: a small SYNTHETIC pack for the engine's tests. Nothing here is real
// content: every word is an obvious placeholder, and the real hunt never uses this file.
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './hunt-lib.mjs';

const { H } = lib;
const DAY = 86400000;
export const OPEN = Date.UTC(2030, 0, 7);   // a Monday far in the future
export const ALPHA = '#%&*';
export const DOOR_LINE = 'open sesame test';

export function testEnv(extra) {
  return Object.assign({ NODE_ENV: 'test', HUNT_KEY: lib.newSecret(), HUNT_HMAC: lib.newSecret(), HUNT_SIGN_KEY: lib.newSecret() }, extra);
}
export function keysOf(env, sandbox) {
  return lib.deriveKeys({ HUNT_KEY: env.HUNT_KEY, HUNT_HMAC: env.HUNT_HMAC, HUNT_SIGN_KEY: env.HUNT_SIGN_KEY }, !!sandbox);
}

// the plaintext answer a test types for a stage and lineage
export const ansText = (sid, L) => 'ans ' + sid + ' x' + L;
export const warmText = (sid, L) => 'warm ' + sid + ' x' + L;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function perm(n, rnd) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const BASE_GRID = '#%&*' + '%&*#' + '&*#%' + '*#%&';
export const BASE_GIVENS = [{ r: 0, c: 0, g: '#' }, { r: 1, c: 1, g: '&' }, { r: 2, c: 2, g: '#' }];

function pool(n, spec, seed) {
  const rnd = lcg(seed), out = [], seen = new Set();
  while (out.length < n) {
    const is = { t: rnd() < 0.5 ? 1 : 0, r: perm(4, rnd), c: perm(4, rnd), g: perm(4, rnd).map((i) => ALPHA[i]).join('') };
    const key = JSON.stringify(is);
    const ident = !is.t && is.r.every((x, i) => x === i) && is.c.every((x, i) => x === i) && is.g === ALPHA;
    if (ident || seen.has(key) || !lib.planchette.isoOk(is, spec)) continue;
    seen.add(key); out.push(is);
  }
  return out;
}

// opts: { K, f, n, V, openMs, liveDays, floorDay, headStartHours, kind }
export function makePack(opts) {
  const K = opts.K, f = opts.f || 'freq-01', V = opts.V || 4;
  const openMs = opts.openMs == null ? OPEN : opts.openMs;
  const floorDay = opts.floorDay === undefined ? 8 : opts.floorDay;
  const spec = { rows: 4, cols: 4, alphabet: ALPHA, givens: BASE_GIVENS, perDay: 3, latin: 1 };
  const count = lib.planchette.spaceIdx(spec).n;
  const ansHash = (sid, L, mode) => H.answer(K.content, f, sid, L, lib.norm(ansText(sid, L), mode || 'alnum'));
  const warmHash = (sid, L) => H.warm(K.content, f, sid, L, lib.norm(warmText(sid, L), 'alnum'));
  const common = (id, n, type, requires, extra) => Object.assign({
    id, n, type, title: 'stage ' + n, requires, notBefore: null,
    norm: { mode: 'alnum' }, echo: { first: 1, every: 2 }, answers: { perDay: 3 }, foreign: 1, bind: null,
    drip: [{ afterDays: 2, text: 'drip line ' + n }]
  }, extra);
  const lineages = (fn) => Array.from({ length: V }, (_, L) => fn(L));
  const hints = (id) => ['hint one ' + id, 'hint two ' + id, 'hint three ' + id];
  const frames = { f1: ['abcdefgh', 'hgfedcba'], f2: ['aabbccdd', 'ddccbbaa'], f3: ['abababab', 'babababa'], f4: ['cdcdcdcd', 'dcdcdcdc'], f5: ['abcdabcd', 'dcbadcba'] };
  const stages = [
    common('s1', 1, 'broadcast', [], { lineages: lineages((L) => ({
      pub: { intro: ['intro 1'], schedule: { offsets: [60, 600, 1200], dur: 30, slot: 60, recAfter: 10, reels: 2 }, frame: { rows: 2, cols: 8 }, glyphs: 'abcd', notes: [] },
      sec: { reels: [['f1', 'f2', 'f3'], ['f4', 'f5']], frames: Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, { lines: v }])), degrade: { permille: 400, noise: '.' } },
      ans: [ansHash('s1', L)], warm: [warmHash('s1', L)], hints: hints('s1') })) }),
    common('s2', 2, 'log', ['s1'], { lineages: lineages((L) => ({
      pub: { intro: ['intro 2'], entries: [{ id: 'e1', title: 'one', lines: ['a'], claims: [] }, { id: 'e2', $rel: 1, title: 'two', lines: ['b'] }, { id: 'e3', $day: 5, title: 'three', lines: ['c'] }] },
      sec: {}, ans: [ansHash('s2', L)], warm: [warmHash('s2', L)], hints: hints('s2') })) }),
    common('s3', 3, 'rooms', ['s1'], { lineages: lineages((L) => ({
      pub: { intro: ['intro 3'], index: [{ area: 'menu', text: 'room text' }], board: { radius: 2, given: [], blocked: [], lit: [], rules: [], read: '' } },
      sec: { rooms: [{ area: 'menu', cond: { f: 'rm', eq: 1 }, frag: { id: 'fr' + L, cells: [{ q: 0, r: 0, g: 'a' }] }, say: 'room says ' + L }] },
      ans: [ansHash('s3', L)], warm: [warmHash('s3', L)], hints: hints('s3') })) }),
    common('s4', 4, 'planchette', ['s1'], { answers: { perDay: 2 }, foreign: 0, norm: { mode: 'glyph', alphabet: ALPHA }, lineages: lineages((L) => ({
      pub: { intro: ['intro 4'], rows: 4, cols: 4, alphabet: ALPHA, latin: 1, rules: ['r'], perDay: 3, silence: ['s'], board: [] },
      sec: { grid: BASE_GRID, givens: BASE_GIVENS, count, pool: pool(24, spec, 1000 + L) },
      ans: [], warm: [], hints: ['try {{q:is a1 #}} first', 'look at {{cells:2}}', 'hint three s4'] })) }),
    common('s5', 5, 'run', ['s4'], { answers: null, foreign: 0, bind: opts.noBind ? null : { grid: 's4' }, lineages: lineages(() => ({
      pub: { intro: ['intro 5'], cfg: opts.runCfg || { rings: 2, breakTicks: 3, maxTicks: 200, maxDraws: 6 }, rings: [{ rule: 'r', goal: { key: 'g', touch: 'g' } }, { rule: 'r', goal: { key: 'g', touch: 'g' } }],
        tickMs: { key: 40, touch: 60 }, pars: { key: 5000, touch: 9000 }, practice: 1 },
      sec: { plaus: { key: { minGapMs: 40, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 }, touch: { minGapMs: 60, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 } } },
      ans: [], warm: [], hints: hints('s5') })) }),
    common('s6', 6, 'final', ['s5'], { answers: { perDay: 3 }, foreign: 0, notBefore: floorDay, bind: opts.noBind ? null : { grid: 's4' }, lineages: lineages((L) => ({
      pub: { intro: ['intro 6'], cfg: opts.finalCfg || { rings: 1, breakTicks: 0, maxTicks: 200, maxDraws: 6 }, tickMs: { key: 40, touch: 60 }, attempts: { perDay: 2, cooldownMin: 20 }, calibrate: 1, marks: [] },
      sec: { goal: opts.goal || { all: [] }, plaus: { key: { minGapMs: 40, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 }, touch: { minGapMs: 60, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 } }, gloss: ['gloss line ' + L] },
      ans: [], warm: [warmHash('s6', L)], hints: hints('s6') })) })
  ];
  const liveDays = opts.liveDays || 28;
  return {
    v: 1, f, n: opts.n == null ? 1 : opts.n, kind: opts.kind || 'frequency', title: 'test band', lineages: V, rev: 1,
    sealedAt: '2030-01-01T00:00:00.000Z', srcHash: 'a'.repeat(64),
    schedule: { opensAt: new Date(openMs).toISOString(), coldAt: new Date(openMs + liveDays * DAY).toISOString(), floorDay, headStartHours: opts.headStartHours == null ? 12 : opts.headStartHours },
    public: {
      tells: { boot: { k: 'k', v: 'v' }, ghostIntro: { k: 'k', v: 'v' }, eggs16: 'x', ghostPill: 'x', ghostHelp: 'x', e404: 'x', tear: 'x' },
      door: { shape: '^open sesame' }, say: {}, errata: [{ fromDay: 3, text: 'errata line' }],
      wall: { size: 3 }, tally: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }
    },
    door: { hmac: [H.door(K.content, f, lib.norm(opts.doorLine || DOOR_LINE, 'words'))] },
    stages, limits: opts.limits || {}, wall: { block: ['BAD'] }, frozen: {}
  };
}

export function writePack(dir, pack, K) {
  fs.mkdirSync(dir, { recursive: true });
  const env = lib.sealJson(pack, K.aes, { kind: 'pack', f: pack.f, kid: K.kid });
  fs.writeFileSync(path.join(dir, pack.f + '.pack'), lib.writeEnvelope(env));
}

/* ---------- a running engine for tests ---------- */

import os from 'node:os';
import http from 'node:http';
import { createHunt } from './hunt.mjs';

// opts: { packs: [packOpts...], sandbox, sim, env (extra), now (ms), noPacks }
// -> { h, X, K, env, call(path, body, opts), pass(payload), setNow(ms), setReal(ms), stop() }
export async function startHunt(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-test-'));
  const sandbox = !!opts.sandbox;
  const env = testEnv(Object.assign({}, opts.sandbox ? { HUNT_SANDBOX: '1' } : {}, opts.env || {}));
  const K = keysOf(env, sandbox);
  const packDir = path.join(dir, 'packs');
  const dataDir = path.join(dir, sandbox ? 'hunt-sandbox-t' : 'data');
  const specs = opts.packs || [{}];
  if (!opts.noPacks) for (const s of specs) writePack(packDir, makePack(Object.assign({ K }, s)), K);
  const clk = { now: opts.now == null ? OPEN + 3 * DAY + 61 * 60000 : opts.now, real: 1000000 };
  const h = createHunt({ env, siteDir: path.join(dir, 'site'), packDir, dataDir, host: '127.0.0.1', quiet: true, noTimers: true,
    sim: opts.sim || null, clock: () => clk.now, realClock: () => clk.real });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/hunt/')) return h.handle(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  async function call(p, body, o = {}) {
    const method = o.method || (body === undefined ? 'GET' : 'POST');
    const headers = Object.assign(body === undefined ? {} : { 'content-type': 'application/json' }, o.headers || {});
    const r = await fetch('http://127.0.0.1:' + port + '/api/hunt/' + p, { method, headers, body: body === undefined ? undefined : (o.raw || JSON.stringify(body)) });
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { status: r.status, json, headers: r.headers };
  }
  return {
    h, X: h._x, K, env, dir, call, port, clk,
    payload: (tok) => lib.verifyToken(tok, K.pub, { sandbox }),
    setNow: (ms) => { clk.now = ms; }, setReal: (ms) => { clk.real = ms; },
    day: (d, minutes = 61) => { clk.now = OPEN + d * DAY + minutes * 60000; },
    async stop() { h.close(); await new Promise((r) => { server.closeAllConnections(); server.close(r); }); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
