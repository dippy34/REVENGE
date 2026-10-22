// hunt-play.test.mjs: probes, planchette, reveal, wall, tally, walkthrough, sandbox (synthetic pack).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './hunt-lib.mjs';
import { createHunt } from './hunt.mjs';
import { startHunt, makePack, OPEN, ansText, DOOR_LINE, ALPHA, testEnv } from './hunt-fixture.mjs';

const DAY = 86400000;
const F = 'freq-01';

async function player(S) {
  const r = await S.call('door', { line: DOOR_LINE });
  assert.equal(r.json.ok, true);
  const pl = { tok: r.json.pass, p: S.payload(r.json.pass) };
  pl.L = lib.H.lineage(S.K.state, F, pl.p.id, 4);
  return pl;
}
const tick = (S, ms = 4000) => S.setReal(S.clk.real + ms);
async function right(S, pl, sid) {
  tick(S);
  const r = await S.call('answer', { pass: pl.tok, text: ansText(sid, pl.L), stage: sid });
  assert.equal(r.json.result, 'correct');
  pl.tok = r.json.pass; pl.p = S.payload(pl.tok);
}
const drawOf = (S, pl) => S.X.drawOf({ P: S.X.packs.get(F), id: pl.p.id }, S.X.packs.get(F).byId.get('s4'));

// every single-cell question that is NOT forced for this pass (so it is answered yes or no)
function openQuestions(S, pl) {
  const d = drawOf(S, pl);
  const sp = S.X.packs.get(F).spaces.get('s4|' + d.L);
  const out = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (const g of ALPHA) {
    const q = 'is ' + 'abcd'[r] + (c + 1) + ' ' + g;
    const p = lib.planchette.parse(q, d.spec);
    if (!p.ok) continue;
    if (!lib.planchette.forced(p, d.spec, Object.assign({}, sp, { iso: d.iso }))) out.push({ q, truth: lib.planchette.truth(p, d.grid, d.spec) });
  }
  return { d, qs: out };
}

test('probe: only a matching snapshot returns the fragment, only while the stage is open', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  tick(S);
  let r = await S.call('probe', { pass: pl.tok, facts: { a: 'menu', rm: 1 } });
  assert.deepEqual(r.json, { ok: true, rooms: [] });                 // stage 3 is not open yet
  await right(S, pl, 's1');
  tick(S);
  r = await S.call('probe', { pass: pl.tok, facts: { a: 'menu', rm: 0 } });
  assert.deepEqual(r.json.rooms, []);
  tick(S);
  r = await S.call('probe', { pass: pl.tok, facts: { a: 'yt', rm: 1 } });
  assert.deepEqual(r.json.rooms, []);
  tick(S);
  r = await S.call('probe', { pass: pl.tok, facts: { a: 'menu', rm: 1, junk: 5, h: 99 } });
  assert.equal(r.json.rooms.length, 1);
  assert.equal(r.json.rooms[0].frag.id, 'fr' + pl.L);
  assert.equal(r.json.rooms[0].say, 'room says ' + pl.L);
  assert.equal(JSON.stringify(r.json).includes('cond'), false);
  const fast = await S.call('probe', { pass: pl.tok, facts: { a: 'menu', rm: 1 } });
  assert.equal(fast.status, 429);
});

test('ask: answers are the pass\'s truth, repeats are silence, the lie is the committed slot', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await right(S, pl, 's1');
  const { qs } = openQuestions(S, pl);
  assert.ok(qs.length >= 3);
  const asked = [];
  for (let i = 0; i < 3; i++) {
    const r = await S.call('ask', { pass: pl.tok, q: qs[i].q });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.i, i);
    assert.equal(r.json.used, i + 1);
    assert.match(r.json.commit, /^[0-9a-f]{64}$/);
    asked.push(r.json);
  }
  assert.equal((await S.call('ask', { pass: pl.tok, q: qs[3].q })).json.error, 'budget');
  const st = await S.call('stage', { pass: pl.tok, stage: 's4' });
  assert.equal(st.json.data.today.left, 0);
  // solve, then check the reveal against the commit and the answers
  const d = drawOf(S, pl);
  tick(S);
  const ok = await S.call('answer', { pass: pl.tok, text: d.grid, stage: 's4' });
  assert.equal(ok.json.result, 'correct');
  pl.tok = ok.json.pass;
  const rv = await S.call('reveal', { pass: pl.tok });
  assert.equal(rv.json.ok, true);
  assert.equal(rv.json.days.length, 1);
  const { slot, salt, day } = rv.json.days[0];
  assert.equal(lib.lieCommit(F, day, slot, salt), asked[0].commit);
  for (let i = 0; i < 3; i++) {
    const want = i === slot ? (qs[i].truth ? 'no' : 'yes') : (qs[i].truth ? 'yes' : 'no');
    assert.equal(asked[i].a, want);
  }
});

test('ask: repeats and forced questions are silence; grammar errors are free', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await right(S, pl, 's1');
  const d = drawOf(S, pl);
  const given = d.givens[0];
  const forcedQ = 'is ' + 'abcd'[given.r] + (given.c + 1) + ' ' + given.g;
  let r = await S.call('ask', { pass: pl.tok, q: forcedQ });
  assert.equal(r.json.a, 'silence');
  assert.equal(r.json.used, 1);                                   // silence still costs a question
  r = await S.call('ask', { pass: pl.tok, q: 'tell me everything' });
  assert.equal(r.json.error, 'grammar');
  r = await S.call('ask', { pass: pl.tok, q: 'is z9 %' });
  assert.equal(r.json.error, 'grammar');
  const st = await S.call('stage', { pass: pl.tok, stage: 's4' });
  assert.equal(st.json.data.today.used, 1);                       // the grammar errors did not count
  r = await S.call('ask', { pass: pl.tok, q: '  ' + forcedQ.toUpperCase() });
  assert.equal(r.json.a, 'silence');                              // same canonical form, asked again
});

test('ask: a restart closes the day and carries the unused questions, truthfully', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await right(S, pl, 's1');
  const { qs } = openQuestions(S, pl);
  assert.equal((await S.call('ask', { pass: pl.tok, q: qs[0].q })).json.ok, true);
  S.X.askedMem.delete(pl.p.id && S.X.ctxOf(pl.p, null).rk + '|' + S.X.ctxOf(pl.p, null).day);   // "restart": the memory is gone
  let r = await S.call('ask', { pass: pl.tok, q: qs[1].q });
  assert.equal(r.json.error, 'closed');
  assert.equal(r.json.carried, 2);
  r = await S.call('ask', { pass: pl.tok, q: qs[1].q });
  assert.equal(r.json.error, 'closed');                           // still closed, nothing added twice
  assert.equal(r.json.carried, 2);
  S.day(4);
  const answers = [];
  for (let i = 0; i < 5; i++) {
    r = await S.call('ask', { pass: pl.tok, q: qs[i + 1].q });
    assert.equal(r.json.ok, true, 'question ' + i);
    answers.push(r.json.a);
  }
  assert.equal((await S.call('ask', { pass: pl.tok, q: qs[7].q })).json.error, 'budget');
  const rv = await (async () => { // the two carried questions (indexes 3 and 4) are never the lie
    const st = await S.call('stage', { pass: pl.tok, stage: 's4' });
    return st.json.data.today;
  })();
  assert.equal(rv.left, 0);
  for (let i = 3; i < 5; i++) assert.equal(answers[i], qs[i + 1].truth ? 'yes' : 'no');
});

test('reveal: locked until the planchette is solved; late mode is truthful and unlimited', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await S.call('reveal', { pass: pl.tok })).json.error, 'locked');
  const late = await startHunt({ now: OPEN + 40 * DAY });
  t.after(() => late.stop());
  const lp = await player(late);
  await right(late, lp, 's1');
  const { qs } = openQuestions(late, lp);
  for (let i = 0; i < 8; i++) {
    const r = await late.call('ask', { pass: lp.tok, q: qs[i].q });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.a, qs[i].truth ? 'yes' : 'no');
    assert.equal(r.json.left, 99);
  }
});

async function solvedPlayer(S) {
  const pl = await player(S);
  const rec = S.X.ensureRec(S.X.ctxOf(pl.p, null));
  for (const st of S.X.packs.get(F).stages) rec.s[st.id] = 3;
  return pl;
}

test('wall: one handle per solved pass, filtered, capped, one per address per day', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const a = await solvedPlayer(S), b = await solvedPlayer(S);
  const fresh = await player(S);
  assert.equal((await S.call('wall', { pass: fresh.tok, handle: 'abc' })).json.error, 'locked');
  assert.equal((await S.call('wall', { pass: a.tok, handle: 'ab' })).json.error, 'invalid');
  assert.equal((await S.call('wall', { pass: a.tok, handle: 'bad' })).json.error, 'invalid');
  let r = await S.call('wall', { pass: a.tok, handle: 'abc' });
  assert.deepEqual(r.json.wall, [{ h: 'ABC', day: 3 }]);
  assert.equal((await S.call('wall', { pass: a.tok, handle: 'xyz' })).json.error, 'closed');   // once
  assert.equal((await S.call('wall', { pass: b.tok, handle: 'xyz' })).json.error, 'limit');    // same address, same day
  S.day(4);
  r = await S.call('wall', { pass: b.tok, handle: 'xyz' });
  assert.equal(r.json.ok, true);
  const st = await S.call('status');
  assert.deepEqual(st.json.wall.map((x) => x.h), ['ABC', 'XYZ']);
});

test('tally: one vote per solved pass, known options only, counted privately', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const a = await solvedPlayer(S);
  assert.equal((await S.call('tally', { pass: a.tok, choice: 'zzz' })).json.error, 'invalid');
  assert.equal((await S.call('tally', { pass: a.tok, choice: 'a' })).json.ok, true);
  assert.equal((await S.call('tally', { pass: a.tok, choice: 'b' })).json.error, 'closed');
  assert.deepEqual(S.X.fstate(S.X.packs.get(F)).tally, { a: 1 });
  assert.equal((await S.call('status')).json.cold.length, 0);      // totals only show after cold
});

test('walkthrough: locked before cold; after cold it renders per pass; missing file stays locked', async (t) => {
  const S = await startHunt({ now: OPEN + 40 * DAY });
  t.after(() => S.stop());
  const P = S.X.packs.get(F);
  let r = await S.call('walkthrough', { f: F });
  assert.equal(r.json.error, 'locked');                            // no file yet
  const obj = { v: 1, f: F, stages: { s1: { title: 'one', method: 'm1', lineages: [0, 1, 2, 3].map((i) => ({ detail: 'detail ' + i })) },
    s4: { title: 'four', method: 'm4', lineages: [0, 1, 2, 3].map(() => ({ detail: 'grid:\n{{grid}}' })) } } };
  const env = lib.sealJson(obj, lib.walkpubKey(S.K.aes, F, P.pack.schedule.coldAt), { kind: 'walkpub', f: F, kid: S.K.kid });
  fs.writeFileSync(path.join(S.X.packDir, F + '.walk-public.sealed'), lib.writeEnvelope(env));
  S.X.walkCache.clear();
  r = await S.call('walkthrough', { f: F });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.stages.map((x) => x.id), ['s1', 's4']);
  assert.equal(r.json.stages[0].detail, undefined);                 // no pass, no detail
  const pl = await player(S);
  r = await S.call('walkthrough', { f: F, pass: pl.tok });
  assert.equal(r.json.stages[0].detail, 'detail ' + pl.L);
  assert.equal(r.json.stages[1].detail, 'grid:\n' + drawOf(S, pl).grid.match(/.{4}/g).join('\n'));
  const before = await startHunt({ now: OPEN + 3 * DAY });
  t.after(() => before.stop());
  fs.writeFileSync(path.join(before.X.packDir, F + '.walk-public.sealed'), lib.writeEnvelope(env));
  assert.equal((await before.call('walkthrough', { f: F })).json.error, 'locked');   // never before cold
});

test('sandbox: the guards refuse a production-like setup', () => {
  const base = testEnv({ HUNT_SANDBOX: '1' });
  const mk = (extra, o) => () => createHunt(Object.assign({ env: Object.assign({}, base, extra), host: '127.0.0.1', quiet: true, noTimers: true,
    dataDir: path.join(process.env.TMPDIR || '/tmp', 'hunt-sandbox-guard') }, o || {}));
  assert.throws(mk({ NODE_ENV: 'production' }), /production/);
  assert.throws(mk({}, { host: '0.0.0.0' }), /host/);
  assert.throws(mk({ STATS_DIR: '/data' }), /statsdir/);
  assert.throws(mk({}, { dataDir: path.join(process.env.TMPDIR || '/tmp', 'hunt') }), /datadir/);
  assert.throws(mk({ HUNT_DATA_DIR: undefined }, { dataDir: path.join(process.env.TMPDIR || '/tmp', 'other') }), /datadir/);
});

test('sandbox: admin routes need loopback, no forwarding headers and the token; passes never cross modes', async (t) => {
  const S = await startHunt({ sandbox: true });
  t.after(() => S.stop());
  const tok = { 'x-hunt-admin': S.X.adminToken };
  assert.equal((await S.call('sandbox/info')).status, 404);                                  // no token
  assert.equal((await S.call('sandbox/info', undefined, { headers: { 'x-hunt-admin': 'x'.repeat(40) } })).status, 404);
  assert.equal((await S.call('sandbox/info', undefined, { headers: Object.assign({ 'x-forwarded-for': '1.2.3.4' }, tok) })).status, 404);
  const info = await S.call('sandbox/info', undefined, { headers: tok });
  assert.equal(info.json.ok, true);
  assert.equal(info.json.dataDir, 'hunt-sandbox-t');
  const st = await S.call('status');
  assert.equal(st.json.sandbox, true);
  assert.equal(st.json.pub, S.K.pubB64);
  const mint = await S.call('sandbox/pass', { f: F }, { headers: tok });
  const p = S.payload(mint.json.pass);
  assert.equal(p.sb, 1);
  const jump = await S.call('sandbox/jump', { pass: mint.json.pass, stage: 's5' }, { headers: tok });
  const state = await S.call('state', { pass: jump.json.pass });
  assert.deepEqual(state.json.stages.map((x) => x.state), ['solved', 'open', 'open', 'solved', 'open', 'locked']);
  assert.equal(JSON.stringify(jump.json).includes('grid'), false);
  const clock = await S.call('sandbox/clock', { to: '2030-02-01T00:00:00Z', speed: 60 }, { headers: tok });
  assert.equal(clock.json.speed, 60);
  assert.equal(new Date(clock.json.now).getUTCFullYear(), 2030);
  // a sandbox pass means nothing to a production engine with the same secrets, and vice versa
  const prod = await startHunt({ env: Object.assign({}, S.env, { HUNT_SANDBOX: '' }) });
  t.after(() => prod.stop());
  assert.equal((await prod.call('state', { pass: mint.json.pass })).status, 401);
  assert.equal((await prod.call('sandbox/info', undefined, { headers: tok })).status, 404);
  const real = await prod.call('door', { line: DOOR_LINE });
  assert.equal((await S.call('state', { pass: real.json.pass })).status, 401);
});
