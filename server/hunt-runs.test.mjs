// hunt-runs.test.mjs: ranked runs. A stub sim covers the protocol and accounting; one test
// uses the real hunt-sim.js to prove the engine speaks its API. Everything is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as lib from './hunt-lib.mjs';
import { startHunt, OPEN, DOOR_LINE } from './hunt-fixture.mjs';

const DAY = 86400000;
const F = 'freq-01';
const require = createRequire(import.meta.url);

// a scripted stand-in: a run "wins" at winAt ticks, "dies" at dieAt; plausibility fails after 50 turns
function stubSim() {
  return {
    version: 1,
    bind(cfg, ctx) { return Object.assign({}, cfg, { bound: ctx.grid.cells }); },
    create(cfg, o) { return { cfg, device: o.device, tick: 0, seeds: [], ended: false, won: false, turns: 0, rings: 0 }; },
    feed(st) { st.turns++; return true; },
    seed(st, hex) { if (!/^[0-9a-f]{32}$/.test(hex)) return false; st.seeds.push(hex); return true; },
    need(st) { return st.seeds.length; },
    step(st) {
      st.tick++;
      if (st.cfg.winAt && st.tick >= st.cfg.winAt) { st.ended = true; st.won = true; st.rings = st.cfg.rings; }
      else if (st.cfg.dieAt && st.tick >= st.cfg.dieAt) st.ended = true;
      return 0;
    },
    result(st) { return { rings: st.rings, won: st.won, ended: st.ended, ticks: st.tick, eats: 0, draws: st.seeds.length }; },
    judge(st, goal) { return !!goal.pass && st.won; },
    stats(st) { return { turns: st.turns, minGap: 99, reacts: [], nearMiss: 0, perfect: 0, ticks: st.tick, moves: st.tick, feeds: 0 }; },
    plausible(stats) { return stats.turns > 50 ? 'rate' : null; }
  };
}
const RUN = { rings: 2, breakTicks: 3, maxTicks: 200, maxDraws: 6, winAt: 30 };
const FINAL = { rings: 1, breakTicks: 0, maxTicks: 200, maxDraws: 6, winAt: 30 };
const opts = (extra) => Object.assign({ sim: stubSim(), packs: [{ runCfg: RUN, finalCfg: FINAL, goal: { pass: true }, noBind: true }] }, extra || {});

async function player(S) {
  const r = await S.call('door', { line: DOOR_LINE });
  const pl = { tok: r.json.pass, p: S.payload(r.json.pass) };
  pl.L = lib.H.lineage(S.K.state, F, pl.p.id, 4);
  return pl;
}
function solved(S, pl, ids) {
  const c = S.X.ctxOf(pl.p, null);
  const rec = S.X.ensureRec(c);
  for (const id of ids) S.X.solveStage(c, rec, S.X.packs.get(F).byId.get(id));
  return rec;
}
// start a ranked run; returns { r, run, real0 }
async function start(S, pl, stage, device = 'key') {
  S.setReal(S.clk.real + 5000);
  const real0 = S.clk.real;
  const r = await S.call('run/start', { pass: pl.tok, stage, device, lat: 0 });
  return { r, run: r.json.run, real0, tickMs: r.json.tickMs };
}
// end a run after `ticks` ticks of real time have passed
async function end(S, pl, h, { upto = 29, log, ms, local } = {}) {
  S.setReal(h.real0 + (ms == null ? (upto + 1) * h.tickMs : ms));
  const body = { pass: pl.tok, run: h.run, upto, log: log || [[0, 9], [0, 9]] };
  if (local) body.local = local;
  return S.call('run/end', body);
}

test('start: only open run/final stages, valid device, sim present', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await start(S, pl, 's5')).r.json.error, 'locked');           // not open yet
  solved(S, pl, ['s1', 's4']);
  assert.equal((await start(S, pl, 's1')).r.json.error, 'locked');           // not a run stage
  S.setReal(S.clk.real + 5000);
  assert.equal((await S.call('run/start', { pass: pl.tok, stage: 's5', device: 'brain', lat: 0 })).json.error, 'invalid');
  const h = await start(S, pl, 's5');
  assert.equal(h.r.json.ok, true);
  assert.equal(h.r.json.tickMs, 40);
  assert.equal(h.r.json.maxTicks, 200);
  assert.equal(h.r.json.ahead, 1);
  assert.equal(h.r.json.seeds.length, 2);
  assert.match(h.r.json.commit, /^[0-9a-f]{64}$/);
  assert.equal((await start(S, pl, 's5')).r.json.error, 'busy');             // one run at a time per pass
  const none = await startHunt({ packs: [{ runCfg: RUN, noBind: true }] });
  t.after(() => none.stop());
  const q = await player(none);
  solved(none, q, ['s1', 's4']);
  assert.equal((await start(none, q, 's5')).r.json.error, 'off');            // no sim loaded
});

test('a cleared run: solves the stage, earns a lantern under par, reveals a secret that matches the commit', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const h = await start(S, pl, 's5');
  const r = await end(S, pl, h);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.result, 'cleared');
  assert.equal(r.json.rings, 2);
  assert.equal(r.json.par, true);
  assert.equal(r.json.lantern, true);
  assert.deepEqual(r.json.unlocked, ['s6']);
  assert.equal(S.payload(r.json.pass).s & 16, 16);
  assert.equal(lib.runCommit(h.run, r.json.reveal), h.r.json.commit);
  assert.equal(lib.drawSeed(Buffer.from(r.json.reveal, 'hex'), 0), h.r.json.seeds[0]);
  assert.equal(lib.drawSeed(Buffer.from(r.json.reveal, 'hex'), 1), h.r.json.seeds[1]);
  const st = await S.call('state', { pass: r.json.pass });
  assert.equal(st.json.lanterns.have, 1);
  assert.equal(st.json.unlit, true);                                          // a lantern earned is not a lantern used
  assert.equal((await S.call('run/end', { pass: pl.tok, run: h.run, upto: 29, log: [] })).json.error, 'rejected');   // single use
});

test('a run that is not cleared is "failed"; over par earns nothing', async (t) => {
  const S = await startHunt(opts({ packs: [{ runCfg: Object.assign({}, RUN, { winAt: 0, dieAt: 20 }), noBind: true }] }));
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  let h = await start(S, pl, 's5');
  let r = await end(S, pl, h, { upto: 19 });
  assert.equal(r.json.result, 'failed');
  assert.equal(r.json.lantern, false);
  assert.equal(r.json.pass, undefined);
  const S2 = await startHunt(opts());
  t.after(() => S2.stop());
  const q = await player(S2);
  solved(S2, q, ['s1', 's4']);
  h = await start(S2, q, 's5');
  r = await end(S2, q, h, { ms: 6000 });                                      // par is 5000 ms
  assert.equal(r.json.result, 'cleared');
  assert.equal(r.json.par, false);
  assert.equal(r.json.lantern, false);
});

test('uploads are checked: shape, order, seeds, real time', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const bad = async (log, o = {}) => {
    const h = await start(S, pl, 's5');
    const r = await end(S, pl, h, Object.assign({ log }, o));
    assert.equal(r.json.error, 'rejected', JSON.stringify(log));
    assert.equal((await end(S, pl, h)).json.error, 'rejected');               // the run was voided
  };
  await bad([[0, 9], [0, 9], [0, 9]]);                                         // a third seed was never revealed
  await bad([[5, 1], [3, 1]]);                                                 // ticks go backwards
  await bad([[0, 9], [0, 7]]);                                                 // an unknown code
  await bad([[4, 1], [4, 2], [4, 3]]);                                         // three directions in one tick
  await bad([[40, 1]], { upto: 29 });                                          // an entry past `upto`
  await bad([[0, 9], [60, 9]], { upto: 120, ms: 5000 });                       // a seed fed long after it was revealed
  await bad([[0, 9]], { upto: 150, ms: 200 });                                 // far ahead of real time
  await bad([[0, 9]], { upto: 29, ms: 400000 });                               // far behind real time
});

test('/run/seed continues the run and reveals the next seed only when it is needed', async (t) => {
  const S = await startHunt(opts({ packs: [{ runCfg: Object.assign({}, RUN, { winAt: 60 }), noBind: true }] }));
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const h = await start(S, pl, 's5');
  S.setReal(h.real0 + 11 * 40);
  const r1 = await S.call('run/seed', { pass: pl.tok, run: h.run, upto: 10, log: [[0, 9], [0, 9]] });
  assert.equal(r1.json.ok, true);
  assert.deepEqual(Object.keys(r1.json.seeds), ['2']);                         // two supplied, one ahead
  S.setReal(h.real0 + 11 * 40 + 100);
  const tooSoon = await S.call('run/seed', { pass: pl.tok, run: h.run, upto: 12, log: [] });
  assert.equal(tooSoon.json.error, 'rejected');                                // uploads need a gap (and the run is voided)
  const h2 = await start(S, pl, 's5');
  S.setReal(h2.real0 + 11 * 40);
  assert.equal((await S.call('run/seed', { pass: pl.tok, run: h2.run, upto: 10, log: [[0, 9], [0, 9]] })).json.ok, true);
  S.setReal(h2.real0 + 25 * 40);
  const r2 = await S.call('run/seed', { pass: pl.tok, run: h2.run, upto: 24, log: [[12, 9]] });
  assert.deepEqual(Object.keys(r2.json.seeds), ['3']);
  S.setReal(h2.real0 + 61 * 40);
  const fin = await S.call('run/end', { pass: pl.tok, run: h2.run, upto: 60, log: [] });
  assert.equal(fin.json.result, 'cleared');
  assert.equal(lib.drawSeed(Buffer.from(fin.json.reveal, 'hex'), 3), r2.json.seeds['3']);
});

test('a plausibility failure is "implausible" and counted (counts only)', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const h = await start(S, pl, 's5');
  const log = [[0, 9], [0, 9]];
  for (let k = 1; k <= 60; k++) log.push([Math.floor((k - 1) / 2), k % 4]);   // two turns a tick for 30 ticks
  const r = await end(S, pl, h, { log });
  assert.equal(r.json.result, 'implausible');
  assert.equal(r.json.pass, undefined);
  assert.equal(S.X.fstate(S.X.packs.get(F)).rej.s5, 1);
});

test('a run left to expire is rejected; a hidden tab still ends the run, accounted as failed', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  let h = await start(S, pl, 's5');
  S.setReal(h.real0 + 2 * 3600000);
  assert.equal((await S.call('run/end', { pass: pl.tok, run: h.run, upto: 29, log: [] })).json.error, 'rejected');
  h = await start(S, pl, 's5');
  const r = await end(S, pl, h, { upto: 9, local: 'hidden', log: [[0, 9], [0, 9]] });
  assert.equal(r.json.result, 'failed');                                       // not over, but the harness stopped it
  assert.equal((await end(S, pl, await start(S, pl, 's5'), { upto: 9, local: 'weird' })).json.error, 'rejected');
});

test('ranked runs have a daily budget per pass', async (t) => {
  const S = await startHunt(opts({ packs: [{ runCfg: RUN, noBind: true, limits: { run: { rankedPerDay: 2 } } }] }));
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  for (let i = 0; i < 2; i++) { const h = await start(S, pl, 's5'); assert.equal(h.r.json.ok, true); await end(S, pl, h); }
  assert.equal((await start(S, pl, 's5')).r.json.error, 'budget');
  S.day(4);
  assert.equal((await start(S, pl, 's5')).r.json.ok, true);
});

test('final: not before the floor day; took -> certificate; the answer has exactly the contract fields', async (t) => {
  const S = await startHunt(opts());
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4', 's5']);
  assert.equal((await start(S, pl, 's6')).r.json.error, 'early');              // day 3 < floor day 8
  S.day(8);
  const h = await start(S, pl, 's6');
  assert.equal(h.r.json.ok, true);
  const r = await end(S, pl, h);
  assert.deepEqual(Object.keys(r.json).sort(), ['cert', 'ok', 'pass', 'result', 'reveal', 'say']);
  assert.equal(r.json.result, 'took');
  const cert = S.payload(r.json.cert);
  assert.equal(cert.k, 'cert');
  assert.equal(cert.unlit, 1);
  assert.equal(cert.day, 8);
  assert.equal(cert.late, 0);
  assert.equal((await S.call('cert', { pass: r.json.pass })).json.cert, r.json.cert);
  assert.equal((await start(S, pl, 's6')).r.json.error, 'locked');             // solved: no more attempts
});

test('final: "nottaken" starts a cooldown and spends the day\'s attempts; no rings, ticks or times ever leave', async (t) => {
  const S = await startHunt(opts({ packs: [{ runCfg: RUN, finalCfg: Object.assign({}, FINAL, { winAt: 0, dieAt: 15 }), goal: { pass: true }, noBind: true }] }));
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4', 's5']);
  S.day(8);
  let h = await start(S, pl, 's6');
  let r = await end(S, pl, h, { upto: 14 });
  assert.deepEqual(Object.keys(r.json).sort(), ['ok', 'result', 'reveal', 'say']);
  assert.equal(r.json.result, 'nottaken');
  assert.equal(r.json.say, 'it did not take.');
  const cool = await start(S, pl, 's6');
  assert.equal(cool.r.json.error, 'cooldown');
  assert.ok(cool.r.json.until > S.clk.now);
  S.setNow(S.clk.now + 21 * 60000);
  h = await start(S, pl, 's6');
  assert.equal(h.r.json.ok, true);
  r = await end(S, pl, h, { upto: 14 });
  assert.equal(r.json.result, 'nottaken');
  S.setNow(S.clk.now + 21 * 60000);
  assert.equal((await start(S, pl, 's6')).r.json.error, 'budget');             // two attempts a day
  const st = await S.call('stage', { pass: pl.tok, stage: 's6' });
  assert.equal(st.json.data.attempts.left, 0);
});

test('late mode: runs are still replayed and checked, nothing is stored', async (t) => {
  const S = await startHunt(opts({ now: OPEN + 40 * DAY }));
  t.after(() => S.stop());
  const pl = await player(S);
  pl.tok = (await S.call('sandbox/pass', {})).json && pl.tok;
  const c = S.X.ctxOf(pl.p, null);
  // late progress rides on the pass: re-issue it with s1 and s4 solved
  pl.tok = S.X.reissue(c, 1 | 8, 0);
  pl.p = S.payload(pl.tok);
  const h = await start(S, pl, 's5');
  const r = await end(S, pl, h);
  assert.equal(r.json.result, 'cleared');
  assert.equal(S.payload(r.json.pass).s & 16, 16);
  assert.equal(Object.keys(S.X.fstate(S.X.packs.get(F)).recs).length, 0);
  assert.equal((await start(S, { tok: r.json.pass }, 's5')).r.json.ok, true);  // no budget in late mode
});

test('bound stages get the pass\'s own drawn grid in their cfg; the base grid never appears', async (t) => {
  const S = await startHunt(Object.assign(opts(), { packs: [{ runCfg: RUN, finalCfg: FINAL, goal: { pass: true } }] }));
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const d = S.X.drawOf({ P: S.X.packs.get(F), id: pl.p.id }, S.X.packs.get(F).byId.get('s4'));
  const st = await S.call('stage', { pass: pl.tok, stage: 's5' });
  assert.equal(st.json.data.cfg.bound, d.grid);
  assert.equal(JSON.stringify(st.json).includes(d.lin.sec.grid), d.lin.sec.grid === d.grid);
});

test('the real hunt-sim.js: a run dies on its own and the engine accounts for it', async (t) => {
  const sim = require('../site/js/hunt-sim.js');
  const S = await startHunt({ sim, packs: [{ runCfg: sim.demoCfg('run'), finalCfg: sim.demoCfg('final'), goal: sim.demoGoal(), noBind: true }] });
  t.after(() => S.stop());
  const pl = await player(S);
  solved(S, pl, ['s1', 's4']);
  const h = await start(S, pl, 's5');
  assert.equal(h.r.json.ok, true);
  const cfg = sim.demoCfg('run');
  // play the same run locally: supply the seeds as the harness would, never steer, so the snake meets a wall
  const st = sim.create(cfg, { device: 'key' });
  const seeds = h.r.json.seeds.slice();
  let supplied = 0, tk = 0;
  const log = [];
  for (; tk < 2000; tk++) {
    while (supplied < seeds.length && supplied <= sim.need(st)) { sim.seed(st, seeds[supplied]); log.push([tk, 9]); supplied++; }
    sim.step(st);
    if (sim.result(st).ended) break;
  }
  assert.ok(sim.result(st).ended);
  const upto = tk;
  S.setReal(h.real0 + (upto + 1) * h.tickMs);
  const r = await S.call('run/end', { pass: pl.tok, run: h.run, upto, log });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(r.json.result, 'failed');
  assert.equal(lib.runCommit(h.run, r.json.reveal), h.r.json.commit);
});
