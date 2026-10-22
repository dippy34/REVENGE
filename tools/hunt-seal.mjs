#!/usr/bin/env node
// hunt-seal.mjs: generate, validate, leak-check and seal one frequency (docs/07-hunt.md, "Sealing").
//
//   node tools/hunt-seal.mjs <f>                       generate, check everything, then write server/hunt/<f>.*
//   node tools/hunt-seal.mjs <f> --check               the same, without writing
//   node tools/hunt-seal.mjs <f> --check --only s2,s3  validate only these stages (never writes)
//   node tools/hunt-seal.mjs <f> --allow s2[,s3]       stages that may differ from the existing pack (errata)
//   node tools/hunt-seal.mjs <f> --against <file>      compare with that pack instead of server/hunt/<f>.pack
//   node tools/hunt-seal.mjs <f> --leaks               leak scan only
//   node tools/hunt-seal.mjs <f> --frozen              compare site files with the sealed pack's frozen hashes
//
// Output is a table of stages and counts, then PASS or FAIL; a failing check prints its id, the stage,
// the lineage number and a non-spoiler note, never content. hunt/<f>/out/report.json carries the same.
// Nothing is written when anything fails. It never opens or prints a walkthrough.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as lib from '../server/hunt-lib.mjs';
import { validatePack } from '../server/hunt-pack.mjs';
import * as kit from './hunt-kit.mjs';
import * as E from './hunt-env.mjs';
import * as K_ from './hunt-checks.mjs';

const DAY = 86400000;
const { H } = lib;
const C = kit.check;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const FOREIGN = new Set(['broadcast', 'log', 'rooms']);
const DEFAULT_ANSWERS = { broadcast: 12, log: 12, rooms: 12, planchette: 2, final: 6, run: null };
const BASE_FROZEN = ['js/eggs.js', 'js/fx.js', 'js/ghost.js', 'js/menu.js', 'js/hunt.js', 'js/hunt-rx.js', 'js/hunt-run.js', 'js/hunt-sim.js', 'index.html', '404.html', 'ghost/index.html'];

/* ---------- generation ---------- */

async function importDefault(file) { return (await import(pathToFileURL(file).href)).default; }

export async function loadFrequency(root, f) {
  const dir = path.join(root, 'hunt', f);
  const freq = await importDefault(path.join(dir, 'freq.mjs'));
  if (!freq || freq.f !== f) throw new Error('the manifest does not describe ' + f);
  const load = (stem) => importDefault(path.join(dir, 'stages', stem + '.mjs'));
  const entrance = await load(freq.entrance);
  const stages = [];
  for (const stem of freq.stages) stages.push(await load(stem));
  const metaPlugin = freq.meta === freq.entrance ? entrance : stages.find((p, i) => freq.stages[i] === freq.meta) || await load(freq.meta);
  const deps = new Set();
  for (const p of [entrance, ...stages]) for (const d of p.deps || []) deps.add(d);
  try {
    for (const name of fs.readdirSync(path.join(dir, 'model')).filter((n) => n.endsWith('.mjs'))) {
      const m = await import(pathToFileURL(path.join(dir, 'model', name)).href);
      for (const d of m.deps || []) deps.add(d);
    }
  } catch (e) { /* no models */ }
  return { freq, entrance, stages, metaPlugin, deps: Array.from(deps).sort() };
}

// One full generation of every lineage. Deterministic given the seed. -> { code, marks[L], gens[L][id], ent[L], ctxF }
export function generateAll(F, seed, root, maxAttempts = 20) {
  const { freq, entrance, stages, metaPlugin } = F;
  const f = freq.f, V = freq.lineages;
  const site = path.join(root, 'site');
  const dialsOf = (id) => (freq.dials && freq.dials[id]) || {};
  const ctxF = { f, kit, freq, lineages: V, site, dials: freq.dials || {}, rng: kit.stream(seed, f, 'code') };
  const code = freq.code(ctxF);
  const mk = (p, L, extra) => Object.assign({ f, lineage: L, lineages: V, kit, freq, site, code, dials: dialsOf(p.id),
    rng: kit.stream(seed, f, p.id, L, extra.attempt || 0), prev: {}, mark: null, attempt: 0 }, extra);
  const marks = [], gens = [], ent = [], attemptsAll = [];
  const usedGrids = new Map();   // planchette stage -> every drawn grid already taken by an earlier lineage
  for (let L = 0; L < V; L++) {
    marks[L] = metaPlugin.planMarks(mk(metaPlugin, L, { attempt: 0 }));
    ent[L] = entrance.generate(mk(entrance, L, { attempt: 0 }));
    const g = {}, attempts = {};
    let i = 0, guard = 0;
    const outs = () => Object.fromEntries(Object.keys(g).map((id) => [id, g[id].out]));
    while (i < stages.length) {
      if (++guard > stages.length * (maxAttempts + 2) * 4) throw new Error('generation did not settle (lineage ' + L + ')');
      const p = stages[i];
      const att = attempts[p.id] || 0;
      const ctx = mk(p, L, { attempt: att, mark: marks[L][p.id] || null, prev: outs() });
      if (typeof p.accepts === 'function') {
        const target = p.bind ? p.bind.grid : (p.needs && p.needs[p.needs.length - 1]);
        if (target && g[target] && !p.accepts(g[target].out, ctx)) {
          attempts[target] = (attempts[target] || 0) + 1;
          if (attempts[target] > maxAttempts) throw new Error(p.id + ' vetoed ' + target + ' ' + maxAttempts + ' times (lineage ' + L + ')');
          const j = stages.findIndex((s) => s.id === target);
          for (let k = j; k < stages.length; k++) delete g[stages[k].id];
          i = j;
          continue;
        }
      }
      const gen = p.generate(ctx);
      if (gen.out && Array.isArray(gen.out.candidates)) {
        const dial = dialsOf(p.id).pool || 256;
        const down = stages.filter((q) => q.bind && q.bind.grid === p.id && typeof q.poolOk === 'function');
        const spec = { rows: gen.out.grid.rows, cols: gen.out.grid.cols, alphabet: gen.out.grid.alphabet, givens: gen.out.givens || [] };
        const pool = [];
        const taken = usedGrids.get(p.id) || new Set();
        for (const is of gen.out.candidates) {
          const drawn = lib.planchette.iso(gen.out.grid.cells, spec, is);
          if (taken.has(drawn)) continue;   // another lineage already owns this drawn grid
          if (down.every((q) => q.poolOk(drawn, mk(q, L, { attempt: 0, mark: marks[L][q.id] || null, prev: Object.assign(outs(), { [p.id]: gen.out }) })))) pool.push(is);
          if (pool.length >= dial) break;
        }
        if (pool.length < dial) {
          attempts[p.id] = att + 1;
          if (attempts[p.id] > maxAttempts) throw new Error(p.id + ': too few usable draws after ' + maxAttempts + ' attempts (lineage ' + L + ')');
          continue;
        }
        gen.out.pool = pool;
        usedGrids.set(p.id, new Set([...taken, ...pool.map((is) => lib.planchette.iso(gen.out.grid.cells, spec, is))]));
      }
      g[p.id] = gen;
      i++;
    }
    gens[L] = g;
    attemptsAll[L] = attempts;
  }
  return { code, marks, gens, ent, ctxF, mk, attempts: attemptsAll };
}

/* ---------- assembly ---------- */

export function assemble(F, run, secrets, K, root) {
  const { freq, entrance, stages } = F;
  const f = freq.f, V = freq.lineages;
  const open = Date.parse(freq.schedule.opensAt);
  const liveDays = freq.schedule.liveDays;
  const doorLines = run.ent[0].doorLines, shape = run.ent[0].shape, tells = run.ent[0].tells;
  const entConsistent = run.ent.every((e) => lib.canon(e.tells) === lib.canon(tells) && e.shape === shape && lib.canon(e.doorLines) === lib.canon(doorLines));
  const stagePacks = stages.map((p) => {
    const st = { id: p.id, n: p.n, type: p.type, title: p.title, requires: p.requires, notBefore: p.notBefore === undefined ? null : p.notBefore,
      norm: p.norm, echo: p.echo, answers: p.answers !== undefined ? p.answers : (DEFAULT_ANSWERS[p.type] === null ? null : { perDay: DEFAULT_ANSWERS[p.type] }),
      foreign: FOREIGN.has(p.type) ? 1 : 0, bind: p.bind || null, drip: p.drip(run.ctxF), lineages: [] };
    st.lineages = Array.from({ length: V }, (_, L) => {
      const gen = run.gens[L][p.id];
      const ctx = run.mk(p, L, { attempt: run.attempts[L][p.id] || 0, mark: run.marks[L][p.id] || null, prev: Object.fromEntries(Object.keys(run.gens[L]).map((id) => [id, run.gens[L][id].out])) });
      const pk = p.pack(gen, ctx);
      const ans = (p.type === 'planchette' || p.type === 'run' || p.type === 'final') ? [] :
        Array.from(new Set(gen.answers.map((a) => H.answer(K.content, f, p.id, L, lib.normStage(a, p.norm))))).sort();
      const warm = Array.from(new Set((pk.warm || []).map((w) => H.warm(K.content, f, p.id, L, lib.normStage(w, p.norm))))).sort();
      return { pub: pk.pub, sec: pk.sec, ans, warm, hints: pk.hints };
    });
    return st;
  });
  const frozen = {};
  for (const rel of [...BASE_FROZEN, ...F.deps]) { const h = K_.sha256file(path.join(root, 'site', rel)); if (h) frozen[rel] = h; }
  const pack = {
    v: 1, f, n: freq.n, kind: freq.kind, title: freq.title, lineages: V, rev: freq.rev,
    sealedAt: '1970-01-01T00:00:00.000Z', srcHash: '0'.repeat(64),
    schedule: { opensAt: iso(open), coldAt: iso(open + liveDays * DAY), floorDay: freq.schedule.floorDay === undefined ? null : freq.schedule.floorDay, headStartHours: freq.schedule.headStartHours },
    public: { tells, door: { shape }, say: freq.say || {}, errata: freq.errata || [], wall: { size: (freq.wall && freq.wall.size) || 0 }, tally: freq.tally || null },
    door: { hmac: doorLines.map((l) => H.door(K.content, f, lib.norm(l, 'words'))) },
    stages: stagePacks, limits: freq.limits || {}, wall: { block: (freq.wall && freq.wall.block) || [] }, frozen
  };
  return { pack, doorLines, shape, tells, entConsistent };
}

// the owner's and the public walkthrough objects (one method per stage, a detail per lineage)
export function walkthroughs(F, run) {
  const { entrance, stages, freq } = F;
  const V = freq.lineages;
  const per = (p) => Array.from({ length: V }, (_, L) => {
    const gen = p.id === entrance.id ? { out: run.ent[L].out, ...run.ent[L] } : run.gens[L][p.id];
    const ctx = run.mk(p, L, { attempt: run.attempts[L][p.id] || 0, mark: run.marks[L][p.id] || null, prev: Object.fromEntries(Object.keys(run.gens[L]).map((id) => [id, run.gens[L][id].out])) });
    return p.walkthrough(gen, ctx);
  });
  const owner = {}, pub = {};
  let methodsAgree = true;
  for (const p of [entrance, ...stages]) {
    const w = per(p);
    if (!w.every((x) => x.method === w[0].method)) methodsAgree = false;
    owner[p.id] = { method: w[0].method, lineages: w.map((x) => ({ detail: x.detail })), notes: '' };
    pub[p.id] = { title: p.title, method: w[0].method, lineages: w.map((x) => ({ detail: x.detail })) };
  }
  return { owner, pub, methodsAgree };
}

/* ---------- the whole check ---------- */

class Report {
  constructor() { this.rows = []; }
  add(scope, lineage, checks) { for (const c of checks) this.rows.push({ scope, lineage, id: c.id, ok: !!c.ok, note: c.note, n: c.n }); }
  get failed() { return this.rows.filter((r) => !r.ok); }
}

export async function runSeal(opts) {
  const root = opts.root;
  const f = opts.f;
  const P = E.paths(root);
  const report = new Report();
  const out = { ok: false, report, wrote: [], messages: [] };
  const fail = (scope, id, note) => report.add(scope, null, [C(id, false, note)]);

  const s = E.loadSecrets(root, opts.env || process.env);
  for (const n of E.RUNTIME) if (!lib.parseSecret(s.values[n] || '')) fail('keys', 'keys.' + n, n + ' is missing or malformed');
  if (s.seedOnlyInServerEnv) fail('keys', 'keys.seed', 'HUNT_SEED is only in server/.env: run hunt-keys --move-seed');
  else if (!lib.parseSecret(s.values.HUNT_SEED || '')) fail('keys', 'keys.HUNT_SEED', 'HUNT_SEED is missing or malformed');
  if (report.failed.length) return out;
  const K = lib.deriveKeys({ HUNT_KEY: s.values.HUNT_KEY, HUNT_HMAC: s.values.HUNT_HMAC, HUNT_SIGN_KEY: s.values.HUNT_SIGN_KEY }, false);
  const seed = lib.parseSecret(s.values.HUNT_SEED);
  const secrets = { HUNT_KEY: s.values.HUNT_KEY, HUNT_HMAC: s.values.HUNT_HMAC, HUNT_SIGN_KEY: s.values.HUNT_SIGN_KEY, HUNT_SEED: s.values.HUNT_SEED };

  report.add('repo', null, K_.hygieneChecks(root, f));
  if (report.failed.length) return out;

  let F;
  try { F = await loadFrequency(root, f); } catch (e) { fail('manifest', 'manifest.load', 'could not load the manifest or a plugin (' + (e && e.message ? e.message.slice(0, 100) : 'error') + ')'); return out; }
  const freq = F.freq, V = freq.lineages;
  report.add('manifest', null, [C('manifest.lineages', Number.isInteger(V) && V >= 4 && V <= 8, 'lineages in 4..8', V)]);

  // frozen-only mode
  if (opts.frozen) {
    let pack;
    try { pack = lib.openJson(lib.readEnvelope(fs.readFileSync(opts.against || path.join(P.packDir, f + '.pack'), 'utf8')), K.aes, { kind: 'pack', f }); } catch (e) { fail('frozen', 'frozen.pack', 'no readable sealed pack'); return out; }
    const changed = Object.entries(pack.frozen).filter(([rel, h]) => K_.sha256file(path.join(P.site, rel)) !== h).map(([rel]) => rel);
    report.add('frozen', null, [C('frozen.unchanged', changed.length === 0, changed.length ? 'changed: ' + changed.join(', ') : 'no frozen file changed', Object.keys(pack.frozen).length)]);
    out.ok = report.failed.length === 0;
    return out;
  }

  let run, run2;
  try { run = generateAll(F, seed, root); } catch (e) { fail('generate', 'generate.run', 'generation failed: ' + (e && e.message ? e.message.slice(0, 120) : 'error')); return out; }
  report.add('generate', null, [
    C('code.real', lib.canon(run.code) !== lib.canon(kit.demoCode()), 'the glyph code is not the development stub'),
    C('marks.real', run.marks.every((m) => lib.canon(m) !== lib.canon(kit.demoMarks(freq.hex.radius))), 'the marks are not the development stub')
  ]);

  // plugin validators and the mark checks
  const only = opts.only;
  const wanted = (id) => !only || only.has(id);
  const vctx = (p, L) => run.mk(p, L, { attempt: run.attempts[L][p.id] || 0, mark: run.marks[L][p.id] || null,
    prev: Object.fromEntries(Object.keys(run.gens[L]).map((id) => [id, run.gens[L][id].out])), rng: kit.stream(seed, f, p.id, L, 'validate') });
  for (let L = 0; L < V; L++) {
    const ent = run.ent[L];
    if (wanted(F.entrance.id)) {
      const ctx = run.mk(F.entrance, L, { attempt: 0 });
      report.add(F.entrance.id, L, F.entrance.validate({ out: ent.out, ...ent }, ctx).checks);
    }
    for (const p of F.stages) {
      if (!wanted(p.id)) continue;
      const gen = run.gens[L][p.id];
      report.add(p.id, L, p.validate(gen, vctx(p, L)).checks);
      if (typeof p.markCheck === 'function' && run.marks[L][p.id]) report.add(p.id, L, p.markCheck(gen, run.marks[L][p.id], vctx(p, L)).checks);
    }
  }
  if (only) {
    // plugin notes are printed: make sure the generated answers are known terms so any note that holds one is withheld
    const items = [];
    for (let L = 0; L < V; L++) for (const p of F.stages) for (const x of [...(run.gens[L][p.id].answers || []), ...(run.gens[L][p.id].warm || [])]) items.push({ text: x, cat: 'answer', norm: true });
    out.terms = K_.leakTerms(items, secrets);
    out.ok = false; out.partial = true; return out;
  }

  // assembly, schema and the global checks
  const A = assemble(F, run, secrets, K, root);
  const walks = walkthroughs(F, run);
  report.add('global', null, [
    C('entrance.consistent', A.entConsistent, 'tells, door shape and door lines are the same for every lineage'),
    C('walkthrough.methods', walks.methodsAgree, 'one method per stage across lineages')
  ]);
  const bad = validatePack(A.pack);
  report.add('global', null, [C('pack.schema', bad === null, bad || 'every field fits the schema')]);
  const gstages = F.stages.map((p) => ({ id: p.id, type: p.type, norm: p.norm, lineages: Array.from({ length: V }, (_, L) => {
    const gen = run.gens[L][p.id];
    const stPack = A.pack.stages.find((x) => x.id === p.id).lineages[L];
    const warm = (p.pack(gen, vctx(p, L)).warm) || [];
    const lin = { answers: gen.answers || [], warm, hints: stPack.hints };
    if (p.type === 'planchette') {
      const spec = { rows: gen.out.grid.rows, cols: gen.out.grid.cols, alphabet: gen.out.grid.alphabet, givens: gen.out.givens || [] };
      lin.answers = [];
      lin.drawn = gen.out.pool.map((is) => lib.planchette.iso(gen.out.grid.cells, spec, is));
      lin.renderedHints = [];
      for (let d = 0; d < Math.min(64, gen.out.pool.length); d++) for (const h of stPack.hints) {
        lin.renderedHints.push(lib.planchette.render(h, { spec, iso: gen.out.pool[d], grid: lin.drawn[d], givens: lib.planchette.isoGivens(spec.givens, spec, gen.out.pool[d]), cellsSeed: Buffer.alloc(32, d) }));
      }
      lin.answers = lin.drawn;
    }
    return lin;
  }) }));
  // planchette: base grids are distinct across lineages and no drawn grid of one equals another lineage's
  const pl = gstages.find((x) => x.type === 'planchette');
  if (pl) {
    let distinct = true;
    const owner = new Map();
    pl.lineages.forEach((lin, L) => { for (const g of lin.drawn) { if (owner.has(g) && owner.get(g) !== L) distinct = false; owner.set(g, L); } });
    report.add(pl.id, null, [C('planchette.draws-distinct', distinct, 'no drawn grid is shared between lineages')]);
  }
  report.add('answers', null, K_.answerChecks(gstages.map((x) => (x.type === 'planchette' ? Object.assign({}, x, { lineages: x.lineages.map((l) => Object.assign({}, l, { answers: l.answers.slice(0, 1) })) }) : x))));
  report.add('hints', null, K_.hintChecks(gstages));
  report.add('placeholders', null, K_.placeholderChecks(A.pack.stages));
  report.add('chain', null, K_.chainChecks(A.pack.stages));
  report.add('schedule', null, K_.scheduleChecks(A.pack, freq.schedule.liveDays));
  report.add('tells', null, K_.tellsChecks(A.tells));
  report.add('door', null, K_.doorChecks(A.shape, A.doorLines));
  const banned = new Set((freq.ban && freq.ban.facts) || []), bannedEv = new Set((freq.ban && freq.ban.events) || []);
  let banHit = 0;
  for (const st of A.pack.stages) if (st.type === 'rooms') for (const lin of st.lineages) for (const r of lin.sec.rooms || []) {
    const lv = lib.facts.leaves(r.cond);
    for (const x of lv.facts) if (banned.has(x)) banHit++;
    for (const x of lv.events) if (bannedEv.has(x)) banHit++;
  }
  report.add('bans', null, [C('bans.rooms', banHit === 0, 'no room condition uses a banned fact or event', banHit)]);
  // the public key in the client equals the one derived from the signing key
  let clientPub = '';
  try { clientPub = (/var PUB = '([A-Za-z0-9_-]*)';/.exec(fs.readFileSync(P.huntJs, 'utf8')) || [])[1] || ''; } catch (e) { clientPub = ''; }
  report.add('global', null, [C('pub.matches', clientPub === K.pubB64, 'site/js/hunt.js carries the public key of HUNT_SIGN_KEY (hunt-keys --write-pub)')]);
  // the simulation's own golden traces
  let simOk = false;
  try { simOk = !!createRequire(import.meta.url)(path.join(P.site, 'js', 'hunt-sim.js')).selfTest().ok; } catch (e) { simOk = false; }
  report.add('global', null, [C('sim.selftest', simOk, 'hunt-sim.js passes its built-in golden traces')]);
  report.add('names', null, K_.nameChecks(root, A.pack));
  report.add('global', null, [C('frozen.present', Object.keys(A.pack.frozen).length >= BASE_FROZEN.length, 'every frozen file exists', Object.keys(A.pack.frozen).length)]);

  // determinism: a second generation must give the identical canonical pack
  try { run2 = generateAll(F, seed, root); } catch (e) { run2 = null; }
  const A2 = run2 ? assemble(F, run2, secrets, K, root) : null;
  report.add('global', null, [C('determinism', !!A2 && lib.canon(A2.pack) === lib.canon(A.pack), 'two generations give the identical pack')]);

  // errata: stages already sealed must not change unless allowed
  const againstFile = opts.against || path.join(P.packDir, f + '.pack');
  if (fs.existsSync(againstFile)) {
    let old = null;
    try { old = lib.openJson(lib.readEnvelope(fs.readFileSync(againstFile, 'utf8')), K.aes, { kind: 'pack', f }); } catch (e) { old = null; }
    if (!old) report.add('errata', null, [C('errata.readable', false, 'the existing pack could not be opened with HUNT_KEY')]);
    else {
      const diff = K_.differences(A.pack, old, opts.allow || new Set());
      report.add('errata', null, [C('errata.unchanged', diff.length === 0, diff.length ? 'changed and not allowed: ' + diff.join(', ') : 'nothing changed outside --allow', diff.length)]);
    }
  }

  // no stage answer or warm form appears in the pack's own text
  let plain = 0;
  for (const st of A.pack.stages) for (let L = 0; L < V; L++) {
    const gs = gstages.find((x) => x.id === st.id).lineages[L];
    const forms = (st.type === 'planchette' ? [] : [...gs.answers, ...gs.warm]).map((a) => lib.normStage(a, st.norm)).filter((n) => n.length >= 4);
    if (!forms.length) continue;
    K_.strings({ pub: st.lineages[L].pub, sec: st.lineages[L].sec, hints: st.lineages[L].hints }, (p, text) => {
      const n = lib.normStage(text, st.norm);
      if (forms.some((x) => n.includes(x))) plain++;
    });
  }
  K_.strings(A.pack.public, () => {});
  report.add('global', null, [C('pack.no-plaintext', plain === 0, 'no answer or warm form appears in the pack\'s own text', plain)]);

  // the leak scan
  const items = [];
  const addAll = (v, cat) => K_.strings(v, (_, t) => items.push({ text: t, cat, norm: false }));
  for (let L = 0; L < V; L++) for (const p of F.stages) {
    const gs = gstages.find((x) => x.id === p.id).lineages[L];
    if (p.type !== 'planchette') for (const a of gs.answers) items.push({ text: a, cat: 'answer', norm: true });
    for (const w of gs.warm) items.push({ text: w, cat: 'answer', norm: true });
    if (p.type === 'planchette') for (const g of gs.drawn) items.push({ text: g, cat: 'grid', norm: false });
  }
  for (const l of A.doorLines) items.push({ text: l, cat: 'door', norm: true });
  addAll(A.pack.public, 'public');
  for (const st of A.pack.stages) { addAll(st.drip, 'drip'); for (const lin of st.lineages) { addAll(lin.pub, 'content'); addAll(lin.sec, 'content'); addAll(lin.hints, 'hint'); } }
  addAll(walks.owner, 'walkthrough');
  const terms = K_.leakTerms(items.filter((x) => !(x.cat === 'content' && /^(rows|cols)$/.test(x.text))), secrets);
  const hits = K_.scanRepo(root, terms);
  const cats = Array.from(new Set(hits.map((h) => h.cat))).sort();
  report.add('leaks', null, [C('leaks.none', hits.length === 0, hits.length ? hits.slice(0, 20).map((h) => h.where + ' [' + h.cat + ']').join('; ') : 'nothing found outside the sealed files', hits.length)]);
  void cats;
  out.terms = terms;
  if (opts.leaksOnly) { out.ok = report.failed.length === 0; return out; }

  out.pack = A.pack; out.walks = walks;
  out.ok = report.failed.length === 0;
  if (!out.ok || opts.check) return out;

  // seal and write (nothing is written above this line)
  const srcFiles = {};
  const huntDir = path.join(root, 'hunt');
  const add = (abs) => { srcFiles[path.relative(huntDir, abs).split(path.sep).join('/')] = fs.readFileSync(abs).toString('base64'); };
  const walkDir = (d, skip) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (skip(p, e)) continue; if (e.isDirectory()) walkDir(p, skip); else add(p); } };
  if (fs.existsSync(path.join(huntDir, 'CONTRACT.md'))) add(path.join(huntDir, 'CONTRACT.md'));
  if (fs.existsSync(path.join(huntDir, 'bot'))) walkDir(path.join(huntDir, 'bot'), () => false);
  walkDir(path.join(huntDir, f), (p, e) => e.isDirectory() && ['out', 'dev'].includes(e.name) && path.dirname(p) === path.join(huntDir, f));
  const at = iso(opts.now ? opts.now() : Date.now());
  A.pack.sealedAt = at;
  A.pack.srcHash = sha(lib.canon(srcFiles));
  const walkHash = sha(lib.canon(walks.owner));
  const write = (name, text) => { const dest = path.join(P.packDir, name); fs.mkdirSync(P.packDir, { recursive: true }); const tmp = dest + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, dest); out.wrote.push('server/hunt/' + name); };
  write(f + '.pack', lib.writeEnvelope(lib.sealJson(A.pack, K.aes, { kind: 'pack', f, kid: K.kid })));
  write(f + '.src.sealed', lib.writeEnvelope(lib.sealJson({ v: 1, f, files: srcFiles, at }, K.aes, { kind: 'src', f, kid: K.kid })));
  // the owner's walkthrough: keep an existing passphrase wrap when nothing changed
  const walkFile = path.join(P.packDir, f + '.walkthrough.sealed');
  let keep = false;
  try { const cur = JSON.parse(fs.readFileSync(walkFile, 'utf8')); keep = cur.wrap === 'pass' && cur.srcHash === walkHash; } catch (e) { keep = false; }
  if (!keep) {
    write(f + '.walkthrough.sealed', JSON.stringify(lib.wrapWalk(walks.owner, lib.walkKeyMaster(K.aes, f), { f, wrap: 'key', kdf: null, srcHash: walkHash })) + '\n');
    out.messages.push('walkthrough re-wrapped with HUNT_KEY: run hunt-open --set-passphrase before you read it');
  }
  const cold = A.pack.schedule.coldAt;
  write(f + '.walk-public.sealed', lib.writeEnvelope(lib.sealJson({ v: 1, f, stages: walks.pub }, lib.walkpubKey(K.aes, f, cold), { kind: 'walkpub', f, kid: K.kid })));
  return out;
}


/* ---------- output ---------- */

export function render(res, f) {
  const lines = [];
  const byScope = new Map();
  for (const r of res.report.rows) {
    const k = r.scope;
    if (!byScope.has(k)) byScope.set(k, { ok: 0, bad: 0 });
    byScope.get(k)[r.ok ? 'ok' : 'bad']++;
  }
  lines.push('seal ' + f);
  lines.push('scope'.padEnd(14) + 'passed'.padStart(8) + 'failed'.padStart(8));
  for (const [k, v] of byScope) lines.push(String(k).padEnd(14) + String(v.ok).padStart(8) + String(v.bad).padStart(8));
  const holds = (note) => (res.terms || []).some((t) => t.s.length >= 6 && String(note).toLowerCase().includes(t.s));
  for (const r of res.report.failed) lines.push('FAIL ' + r.id + ' [' + r.scope + (r.lineage != null ? ' lineage ' + r.lineage : '') + ']' + (r.note ? ': ' + (holds(r.note) ? '[note withheld]' : r.note) : ''));
  lines.push(res.partial ? 'PARTIAL (checked only the stages asked for; nothing written)' : res.ok ? 'PASS' : 'FAIL');
  for (const m of res.messages) lines.push(m);
  for (const w of res.wrote) lines.push('wrote ' + w);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const f = argv[0];
  if (!f || f.startsWith('--') || !lib.F_RE.test(f)) E.die('usage: node tools/hunt-seal.mjs <freq-id> [--check] [--only s2,s3] [--allow s2] [--against file] [--leaks] [--frozen]');
  const root = E.rootOf(argv);
  const list = (n) => { const v = E.opt(argv, n, ''); return v ? new Set(v.split(',').map((x) => x.trim()).filter(Boolean)) : null; };
  const res = await runSeal({ root, f, check: E.flag(argv, '--check'), only: list('--only'), allow: list('--allow'), against: E.opt(argv, '--against', ''),
    leaksOnly: E.flag(argv, '--leaks'), frozen: E.flag(argv, '--frozen') });
  const text = render(res, f);
  // belt and braces: the printed report must not contain any content string
  let safe = text;
  for (const t of res.terms || []) if (t.s.length >= 6 && safe.toLowerCase().includes(t.s)) safe = safe.split('\n').map((l) => (l.toLowerCase().includes(t.s) ? '[line withheld]' : l)).join('\n');
  process.stdout.write(safe + '\n');
  try {
    const outDir = path.join(root, 'hunt', f, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ f, ok: res.ok, rows: res.report.rows.map((r) => Object.assign({}, r, { note: r.note && (res.terms || []).some((t) => t.s.length >= 6 && String(r.note).toLowerCase().includes(t.s)) ? '[withheld]' : r.note })) }, null, 1) + '\n');
  } catch (e) { /* the report is a convenience */ }
  process.exit(res.ok || (res.partial && res.report.failed.length === 0) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => E.die('failed: ' + (e && e.message ? e.message : 'error')));
