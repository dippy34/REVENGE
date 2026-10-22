// hunt-sim.test.mjs: the shared skill-stage simulation (site/js/hunt-sim.js). Synthetic cfgs only
// (huntSim.demoCfg), no content: determinism, golden traces, integer-only state, replay versus
// live play, input and seed rules, draw deferral, breaks, bind purity, the goal language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sim = createRequire(import.meta.url)(path.join(here, '..', 'site', 'js', 'hunt-sim.js'));
const { CODES, EV } = sim;

// the golden traces pinned here as well as in the module (a change to either must be deliberate)
const GOLDEN = ['10f57c40', 'ef7c51f8', 'ee2b157f', '63156ad0'];

function seeds(n, salt) { return sim._.demoSeeds(n, salt); }
function walkInts(v, where, seen = new Set()) {
  if (typeof v === 'number') { assert.ok(Number.isInteger(v), 'non-integer at ' + where); return; }
  if (v === null || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  if (ArrayBuffer.isView(v)) { for (let i = 0; i < v.length; i++) assert.ok(Number.isInteger(v[i]), 'non-integer at ' + where + '[' + i + ']'); return; }
  for (const k of Object.keys(v)) walkInts(v[k], where + '.' + k, seen);
}
function canonInts(v) {
  if (typeof v === 'number') return Number.isInteger(v);
  if (Array.isArray(v)) return v.every(canonInts);
  if (v && typeof v === 'object') return Object.values(v).every(canonInts);
  return typeof v === 'string' || typeof v === 'boolean' || v === null;
}
// play with the module's own autopilot, then return the live state and its log
function auto(kind, salt, opts = { device: 'key' }, hold = 0, lazy = 0) {
  return sim._.autoplay(sim.demoCfg(kind), seeds(80, salt), opts, 6000, hold, lazy);
}

test('module shape', () => {
  assert.equal(typeof sim.version, 'number');
  assert.deepEqual(CODES, { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3, SEED: 9 });
  assert.deepEqual(EV, { EAT: 1, RING: 2, DIE: 4, MARK: 8, WIN: 16, DRAW: 32, END: 64 });
  for (const f of ['bind', 'create', 'feed', 'seed', 'need', 'step', 'view', 'result', 'judge', 'stats', 'hash', 'replay', 'selfTest', 'demoCfg', 'plausible', 'demoGoal']) {
    assert.equal(typeof sim[f], 'function', f);
  }
  const c = sim.demoCfg();
  for (const k of ['rings', 'breakTicks', 'maxTicks', 'maxDraws']) assert.ok(Number.isInteger(c[k]), k + ' is an int (CONTRACT 11.2)');
  assert.ok(c.rings >= 1 && c.ringDefs.length === c.rings);
  assert.ok(JSON.stringify(c).length < 32768);
  assert.ok(canonInts(c), 'cfg holds integers, strings, arrays and objects only');
});

test('golden traces from selfTest', () => {
  const r = sim.selfTest();
  assert.equal(r.ok, true);
  assert.deepEqual(r.hashes, GOLDEN);
  // and they really exercise the rules: rings, the ghost, fading food, cinders, the final field
  const a = auto('run', 1);
  assert.equal(sim.view(a.st).state, 'won');
  assert.equal(a.st.s.cleared, 3);
  const d = auto('run', 6, { device: 'key', startRing: 1 }, 30, 1);
  const kinds = new Set(); for (let i = 0; i < d.st.s.tr.length; i += 4) kinds.add(d.st.s.tr[i]);
  assert.ok(kinds.has(8), 'a food faded');
  assert.ok(d.st.s.ncinder >= 1, 'a cinder was left');
  assert.ok(kinds.has(5), 'the ghost woke');
  const f = auto('final', 3);
  assert.equal(sim.view(f.st).state, 'end');
});

test('determinism: same seeds and log give the same state, twice and in replay', () => {
  for (const [kind, salt, opts] of [['run', 1, { device: 'key' }], ['run', 4, { device: 'touch', startRing: 1 }], ['final', 3, { device: 'key' }]]) {
    const live = auto(kind, salt, opts);
    const s = seeds(80, salt);
    const r1 = sim.replay(sim.demoCfg(kind), s, live.log, 6000, opts);
    const r2 = sim.replay(sim.demoCfg(kind), s, live.log, 6000, opts);
    assert.equal(r1.hash, r2.hash);
    assert.equal(r1.hash, sim.hash(live.st), 'replay equals live play');
    assert.deepEqual(r1.result, sim.result(live.st));
    assert.match(r1.hash, /^[0-9a-f]{8}$/);
    // a different seed set gives another run
    const r3 = sim.replay(sim.demoCfg(kind), seeds(80, salt + 100), live.log, 6000, opts);
    assert.notEqual(r3.hash, r1.hash);
  }
});

test('replay equals stepping by hand', () => {
  const live = auto('run', 1);
  const s = seeds(80, 1);
  const st = sim.create(sim.demoCfg('run'), { device: 'key' });
  let next = 0, li = 0;
  const ringTicks = [];
  for (let t = 0; t < 6000; t++) {
    while (li < live.log.length && live.log[li][0] === t) {
      const [, code] = live.log[li++];
      if (code === 9) sim.seed(st, s[next++]); else sim.feed(st, code);
    }
    const ev = sim.step(st);
    if (ev & EV.RING) ringTicks.push(st.s.t);
    if (st.s.state > 1) break;
  }
  const r = sim.replay(sim.demoCfg('run'), s, live.log, 6000, { device: 'key' });
  assert.equal(sim.hash(st), r.hash);
  assert.deepEqual(ringTicks, r.ringTicks);
  assert.equal(r.end, 'won');
});

test('state is integers only, all the way through a run', () => {
  const live = auto('run', 1);
  walkInts(live.st.s, 's');
  walkInts(live.st.k.rings ? { ...live.st.k, rings: 0 } : live.st.k, 'k');
  const f = auto('final', 3);
  walkInts(f.st.s, 's');
  const sx = sim.stats(f.st);
  for (const k of ['turns', 'minGap', 'nearMiss', 'perfect', 'ticks', 'moves', 'feeds']) assert.ok(Number.isInteger(sx[k]), k);
  assert.ok(sx.reacts.every(Number.isInteger));
});

test('inputs: reversal and repeats refused, two queued at most, applied in order', () => {
  const st = sim.create(sim.demoCfg('run'), { device: 'key' });
  assert.equal(st.s.dir, CODES.RIGHT);
  assert.equal(sim.feed(st, CODES.LEFT), false, 'reversal');
  assert.equal(sim.feed(st, CODES.RIGHT), false, 'repeat');
  assert.equal(sim.feed(st, 7), false, 'unknown code');
  assert.equal(sim.feed(st, CODES.UP), true);
  assert.equal(sim.feed(st, CODES.DOWN), false, 'reversal of the queued one');
  assert.equal(sim.feed(st, CODES.LEFT), true);
  assert.equal(sim.feed(st, CODES.DOWN), false, 'queue full');
  // through the break, then the two queued turns land on the first two moves
  for (let i = 0; i < 4; i++) sim.seed(st, seeds(4, 9)[i]);
  const dirs = [];
  for (let t = 0; t < 200 && dirs.length < 2; t++) { const before = st.s.moves; sim.step(st); if (st.s.moves > before) dirs.push(st.s.dir); }
  assert.deepEqual(dirs, [CODES.UP, CODES.LEFT]);
});

test('seeds: in index order, malformed ones refused, none past maxDraws', () => {
  const cfg = sim.demoCfg('run');
  const st = sim.create(cfg, {});
  assert.equal(sim.seed(st, 'xyz'), false);
  assert.equal(sim.seed(st, '0123456789ABCDEF0123456789abcdef'), false, 'uppercase hex is not canonical');
  assert.equal(sim.need(st), 0);
  const many = seeds(cfg.maxDraws + 2, 5);
  let okN = 0;
  for (const h of many) if (sim.seed(st, h)) okN++;
  assert.equal(okN, cfg.maxDraws);
  // swapping two seeds changes the run: draw k reads seed k only
  const live = auto('run', 1);
  const s = seeds(80, 1), sw = s.slice();
  [sw[0], sw[1]] = [sw[1], sw[0]];
  assert.notEqual(sim.replay(cfg, sw, live.log, 6000, {}).hash, sim.replay(cfg, s, live.log, 6000, {}).hash);
});

test('draw deferral: nothing appears until the seed is supplied, then at the start of that tick', () => {
  const st = sim.create(sim.demoCfg('run'), { device: 'key' });
  const brk = sim.demoCfg('run').breakTicks;
  for (let t = 0; t < brk + 6; t++) sim.step(st);
  assert.equal(st.s.state, 0, 'the break is over');
  assert.equal(st.s.food, -1, 'no seed, no food');
  assert.equal(sim.need(st), 0);
  sim.seed(st, seeds(1, 3)[0]);
  const ev = sim.step(st);
  assert.ok(ev & EV.DRAW, 'the draw happens on the tick the seed arrives');
  assert.ok(st.s.food >= 0);
  assert.equal(sim.need(st), 1);
  // the same seed always puts the food in the same place, whenever it arrives
  const st2 = sim.create(sim.demoCfg('run'), { device: 'key' });
  for (let i = 0; i < brk + 6; i++) sim.step(st2);
  sim.seed(st2, seeds(1, 3)[0]);
  sim.step(st2);
  assert.equal(st2.s.food, st.s.food);
});

test('breaks: the run opens with one, every cleared ring is followed by one, the last ring wins', () => {
  const cfg = sim.demoCfg('run');
  const st = sim.create(cfg, {});
  assert.equal(sim.view(st).state, 'break');
  for (let i = 0; i < cfg.breakTicks - 1; i++) { sim.step(st); assert.equal(sim.view(st).state, 'break'); }
  sim.step(st);
  assert.equal(sim.view(st).state, 'run');
  // a full clear: RING per ring, MARK at the mark ring's break, WIN at the end
  const live = auto('run', 1), s = seeds(80, 1);
  const st2 = sim.create(cfg, { device: 'key' });
  let next = 0, li = 0, rings = 0, marks = 0, won = 0;
  for (let t = 0; t < 6000 && st2.s.state <= 1; t++) {
    while (li < live.log.length && live.log[li][0] === t) { const [, c] = live.log[li++]; if (c === 9) sim.seed(st2, s[next++]); else sim.feed(st2, c); }
    const ev = sim.step(st2);
    if (ev & EV.RING) {
      rings++;
      if (st2.s.state === 1) {
        assert.equal(sim.view(st2).state, 'break');
        assert.equal(st2.s.brk, cfg.breakTicks, 'a full break after the ring');
        const head = st2.s.body[st2.s.bh];
        assert.equal(head, cfg.start.y * cfg.w + cfg.start.x, 'the snake waits at the start');
      }
    }
    if (ev & EV.MARK) marks++;
    if (ev & EV.WIN) won++;
  }
  assert.equal(rings, cfg.rings);
  assert.equal(cfg.ringDefs.length, cfg.rings);
  assert.equal(marks, 1);
  assert.equal(won, 1);
  assert.equal(sim.result(st2).won, true);
});

test('practice start ring', () => {
  const st = sim.create(sim.demoCfg('run'), { startRing: 2 });
  assert.equal(sim.view(st).hud.ring, 3);
  const st2 = sim.create(sim.demoCfg('run'), { startRing: 99 });
  assert.equal(sim.view(st2).hud.ring, 3, 'clamped to the last ring');
  assert.equal(sim.view(sim.create(sim.demoCfg('run'), {})).hud.ring, 1);
});

test('devices: the ring goal follows the device, nothing else does', () => {
  const k = sim.view(sim.create(sim.demoCfg('run'), { device: 'key' }));
  const t = sim.view(sim.create(sim.demoCfg('run'), { device: 'touch' }));
  assert.equal(k.hud.goal, sim.demoCfg('run').ringDefs[0].goal.key);
  assert.equal(t.hud.goal, sim.demoCfg('run').ringDefs[0].goal.touch);
  assert.deepEqual(k.cells, t.cells);
});

test('bind: pure, deterministic, from the grid, small', () => {
  const base = sim._.demoBase('run');
  const before = JSON.stringify(base);
  const grid = { rows: 5, cols: 5, alphabet: 'abcde', cells: 'abcdebcdeacdeabdeabceabcd' };
  const a = sim.bind(base, { grid }), b = sim.bind(base, { grid });
  assert.equal(JSON.stringify(base), before, 'input untouched');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(JSON.stringify(a).length < 32768);
  assert.ok(canonInts(a));
  assert.deepEqual(a.grid, grid);
  // another grid, another arena
  const g2 = { ...grid, cells: 'edcbadcbaecbaedbaedcaedcb' };
  assert.notDeepEqual(sim.bind(base, { grid: g2 }).map, a.map);
  // a bad grid or none: unchanged; an already bound cfg binds no further
  assert.equal(sim.bind(base, { grid: { rows: 5, cols: 5, alphabet: 'ab', cells: 'x' } }), base);
  assert.equal(sim.bind(base, {}), base);
  assert.equal(sim.bind(a, { grid: g2 }), a);
  assert.ok(!('motifs' in a) && Array.isArray(a.map) && Array.isArray(a.seams));
  // the unbound demo cfg is bound from its motifs: each tile's walls are drawn in that tile's glyph
  const raw = sim.demoCfg('run');
  const W = raw.w, tw = raw.tile.w, th = raw.tile.h;
  for (let y = 0; y < raw.h; y++) for (let x = 0; x < W; x++) {
    const ch = raw.map[y][x];
    if (ch !== '.') assert.equal(ch, raw.grid.cells[((y / th) | 0) * 5 + ((x / tw) | 0)]);
  }
});

test('view: shape, the mark on its break, on end screens and on pause', () => {
  const cfg = sim.demoCfg('run');
  const st = sim.create(cfg, {});
  const v = sim.view(st);
  assert.equal(v.cells.length, v.rows);
  assert.ok(v.cells.every((l) => l.length === v.cols));
  assert.equal(v.attr.length, v.rows);
  assert.ok(v.attr.every((l) => l.length === v.cols));
  assert.equal(v.rows, cfg.h + 2);
  assert.equal(v.cols, cfg.w + 2);
  const glyphs = cfg.mark.cells.map((c) => c[2]);
  const hasMark = (vv) => glyphs.every((g) => vv.cells.join('').includes(g)) && vv.cells.join('').includes('·');
  assert.equal(sim.view(st, { pause: true }).msg !== null, true);
  assert.ok(hasMark(sim.view(st, { pause: true })), 'pause screen');
  // die at once: the end screen shows it
  const st2 = sim.create(cfg, {});
  for (let t = 0; t < 400 && st2.s.state <= 1; t++) { sim.feed(st2, CODES.DOWN); sim.step(st2); }
  assert.equal(sim.view(st2).state, 'over');
  const end = sim.view(st2);
  const markRows = end.cells.filter((l) => l.includes('·')).length;
  assert.ok(markRows >= 3, 'end screen carries the hex figure');
  assert.ok(end.cells.some((l) => l.includes('X')), 'where it died');
});

test('final field: stones, the hollow, the bell, the dormant ghost', () => {
  const cfg = sim.demoCfg('final');
  assert.equal(cfg.kind, 'final');
  assert.ok(cfg.field.stones.every((s) => typeof s.g === 'string'), 'bind labels the stones');
  const st = sim.create(cfg, {});
  const v0 = sim.view(st).cells.join('\n');
  assert.ok(v0.includes('¤'), 'the ghost sleeps in its den');
  assert.ok(v0.includes('O'), 'the hollow');
  // nothing done: the bell ends the run
  const st2 = sim.create(cfg, {});
  let ev = 0;
  for (let t = 0; t < 5000 && st2.s.state <= 1; t++) {
    if (st2.s.state === 0 && st2.s.mt === 1) {
      const s = st2.s, k = st2.k, h = s.body[s.bh], x = h % k.W, y = (h / k.W) | 0;
      // circle the bottom-left corner region safely: right along the bottom, never further
      const d = [CODES.RIGHT, CODES.UP, CODES.LEFT, CODES.DOWN].find((dd) => !sim._.deadly(st2, x + sim._.DX[dd], y + sim._.DY[dd]) && k.hollow !== (y + sim._.DY[dd]) * k.W + x + sim._.DX[dd] && dd !== ((s.dir + 2) & 3));
      if (d !== undefined && d !== s.dir) sim.feed(st2, d);
    }
    ev |= sim.step(st2);
  }
  assert.ok(['end', 'over'].includes(sim.view(st2).state));
  // a run ended by the bell is `end` with cause bell
  if (sim.view(st2).state === 'end') assert.ok(sim.judge(st2, { ended: ['bell', 'hollow'] }));
});

test('judge: the goal language on a finished demo run', () => {
  const f = auto('final', 3);
  const st = f.st;
  assert.equal(sim.view(st).state, 'end');
  // the run's own trace, read back through the language
  const touches = [];
  for (let i = 0; i < st.s.tr.length; i += 4) if (st.s.tr[i] === 2) touches.push(st.s.tr[i + 3]);
  assert.ok(touches.length >= 1);
  assert.equal(sim.judge(st, { ended: ['hollow'] }), true);
  assert.equal(sim.judge(st, { ended: ['bell', 'wraith'] }), false);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'is', list: touches }), true);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'is', list: touches.slice(1) }), false);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'has', list: [touches[touches.length - 1]] }), true);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'first', v: touches[0] }), true);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'last', v: touches[touches.length - 1] }), true);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'count', cmp: 'eq', n: touches.length }), true);
  assert.equal(sim.judge(st, { trace: { k: 'eat' }, op: 'count', cmp: 'eq', n: st.s.eats }), true);
  assert.equal(sim.judge(st, { final: 'eats', cmp: 'eq', n: st.s.eats }), true);
  assert.equal(sim.judge(st, { final: 'len', cmp: 'gt', n: 999 }), false);
  assert.equal(sim.judge(st, { trace: { k: 'ring' }, op: 'none' }), true);
  assert.equal(sim.judge(st, { not: { ended: ['wall'] } }), true);
  assert.equal(sim.judge(st, { any: [{ ended: ['wall'] }, { ended: ['hollow'] }] }), true);
  assert.equal(sim.judge(st, { all: [{ ended: ['hollow'] }, { ended: ['wall'] }] }), false);
  assert.equal(sim.judge(st, { all: [] }), false, 'an empty conjunction never holds');
  // grid-bound values and lists resolve on the bound grid
  const g = st.cfg.grid, gi = (r, c) => g.alphabet.indexOf(g.cells[r * 5 + c]);
  const row0 = [0, 1, 2, 3, 4].map((c) => gi(0, c));
  const isRow0 = sim.judge(st, { trace: { k: 'touch' }, op: 'is', list: { row: 0 } });
  assert.equal(isRow0, JSON.stringify(touches) === JSON.stringify(row0));
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'is', list: { cat: [touches.slice(0, 1), { tail: touches }] } }), true);
  assert.equal(sim.judge(st, { trace: { k: 'touch' }, op: 'is', list: { rev: { rev: touches } } }), true);
  assert.equal(sim.judge(st, { trace: { k: 'tile', v: { cell: [4, 0] } }, op: 'count', cmp: 'gte', n: 0 }), true);
  const tiles = sim.judge(st, { trace: { k: 'tile', firsts: 1, by: 'key' }, op: 'count', cmp: 'gte', n: 1 });
  assert.equal(tiles, true);
  // the demo goal (touch in the first row's order, then rest) is a well-formed goal
  assert.equal(typeof sim.judge(st, sim.demoGoal()), 'boolean');
  // garbage never throws and never holds
  for (const bad of [null, 1, 'x', {}, { all: 'x' }, { trace: { k: 'nope' }, op: 'is', list: [] }, { trace: { k: 'touch' }, op: 'what' }, { final: 'nope', cmp: 'eq', n: 1 }, { trace: { k: 'touch' }, op: 'is', list: { row: 99 } }]) {
    assert.equal(sim.judge(st, bad), false);
  }
  // an unfinished run never takes
  const st0 = sim.create(sim.demoCfg('final'), {});
  assert.equal(sim.judge(st0, { not: { ended: ['wall'] } }), false);
});

test('a goal never changes the dynamics or the result', () => {
  const live = auto('final', 3);
  const h = sim.hash(live.st), r = JSON.stringify(sim.result(live.st)), sx = JSON.stringify(sim.stats(live.st));
  for (const g of [sim.demoGoal(), { ended: ['bell'] }, { trace: { k: 'touch' }, op: 'is', list: { row: 2 } }]) sim.judge(live.st, g);
  assert.equal(sim.hash(live.st), h);
  assert.equal(JSON.stringify(sim.result(live.st)), r);
  assert.equal(JSON.stringify(sim.stats(live.st)), sx);
  // the result fields carry nothing about a goal
  assert.deepEqual(Object.keys(sim.result(live.st)).sort(), ['draws', 'eats', 'ended', 'rings', 'ticks', 'won']);
});

test('maxTicks ends a run with cause max', () => {
  const cfg = { ...sim.demoCfg('run'), maxTicks: 14 };
  const r = sim.replay(cfg, [], [], 1000, {});
  assert.equal(r.end, 'max');
  assert.equal(r.result.ended, true);
});

test('plausible: the engine rule in one place', () => {
  const ok = { turns: 100, minGap: 6, reacts: [12, 14, 15, 16, 20], nearMiss: 10, perfect: 100, ticks: 6000 };
  const P = { minGapMs: 30, maxTurnRate: 90, minReactMs: 100, maxPerfect: 450, maxNearMiss: 600 };
  assert.equal(sim.plausible(ok, P, 16), null);
  assert.equal(sim.plausible({ ...ok, minGap: 1 }, P, 16), 'gap');
  assert.equal(sim.plausible({ ...ok, turns: 1000 }, P, 16), 'rate');
  assert.equal(sim.plausible({ ...ok, reacts: [1, 1, 1, 1, 1] }, P, 16), 'react');
  assert.equal(sim.plausible({ ...ok, perfect: 900 }, P, 16), 'perfect');
  assert.equal(sim.plausible({ ...ok, nearMiss: 900 }, P, 16), 'near');
  assert.equal(sim.plausible(ok, { ...P, minReactMs: 0, minGapMs: 0 }, 16), null);
  // a perfect bot (every turn fed on its move's own tick) is caught
  const st = sim.create(sim.demoCfg('run'), {});
  for (let i = 0; i < 80; i++) sim.seed(st, seeds(80, 7)[i]);
  for (let t = 0; t < 6000 && st.s.state <= 1; t++) {
    if (st.s.state === 0 && st.s.mt === 1) {
      const s = st.s, k = st.k, h = s.body[s.bh], x = h % k.W, y = (h / k.W) | 0;
      const d = [s.dir, (s.dir + 1) & 3, (s.dir + 3) & 3].find((dd) => !sim._.deadly(st, x + sim._.DX[dd], y + sim._.DY[dd]));
      if (d !== undefined && d !== s.dir) sim.feed(st, d);
    }
    sim.step(st);
  }
  const sx = sim.stats(st);
  assert.ok(sx.turns >= 20);
  assert.ok(sx.perfect > 450, 'every turn on its own move tick');
  assert.equal(sim.plausible(sx, { ...P, maxTurnRate: 0 }, 16), 'perfect');
});

test('demo cfgs carry no content', () => {
  const s = JSON.stringify([sim.demoCfg('run'), sim.demoCfg('final'), sim.demoGoal()]);
  assert.ok(/demo/.test(s));
  assert.equal(sim.demoCfg('run').grid.alphabet, 'abcde', 'a synthetic alphabet, not the site glyph set');
});
