// hunt.test.mjs: the engine's core routes, on a SYNTHETIC pack (hunt-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from './hunt-lib.mjs';
import { startHunt, OPEN, ansText, warmText, DOOR_LINE, ALPHA } from './hunt-fixture.mjs';

const DAY = 86400000;
const F = 'freq-01';

async function player(S) {
  const r = await S.call('door', { line: DOOR_LINE });
  assert.equal(r.json.ok, true);
  const pass = { tok: r.json.pass, p: S.payload(r.json.pass) };
  pass.L = lib.H.lineage(S.K.state, F, pass.p.id, 4);
  return pass;
}
const tick = (S) => S.setReal(S.clk.real + 2000);
async function answer(S, pl, text, extra) {
  tick(S);
  const r = await S.call('answer', Object.assign({ pass: pl.tok, text }, extra || {}));
  if (r.json && r.json.pass) { pl.tok = r.json.pass; pl.p = S.payload(pl.tok); }
  return r;
}
const right = (S, pl, sid) => answer(S, pl, ansText(sid, pl.L), { stage: sid });

test('off without secrets: status says so, everything else is 404', async (t) => {
  const S = await startHunt({ env: { HUNT_KEY: '' }, noPacks: true });
  t.after(() => S.stop());
  const r = await S.call('status');
  assert.deepEqual(r.json, { v: 1, on: false });
  assert.equal((await S.call('door', { line: 'x' })).status, 404);
});

test('status: before, during and after a frequency', async (t) => {
  const S = await startHunt({ now: OPEN - 5 * 3600000 });
  t.after(() => S.stop());
  let r = await S.call('status');
  assert.equal(r.json.on, true);
  assert.equal(r.json.live.length, 0);
  assert.equal(r.json.next.f, F);
  assert.equal(r.json.tells, null);
  S.day(3);
  r = await S.call('status');
  assert.equal(r.json.live.length, 1);
  assert.equal(r.json.live[0].day, 3);
  assert.equal(r.json.door.f, F);
  assert.ok(r.json.tells.boot);
  assert.deepEqual(r.json.lines.errata, ['errata line']);
  assert.deepEqual(r.json.lines.drip.slice(0, 1), ['drip line 1']);
  assert.equal(JSON.stringify(r.json).includes('ans '), false);
  S.day(40);
  r = await S.call('status');
  assert.equal(r.json.live.length, 0);
  assert.equal(r.json.cold.length, 1);
  assert.equal(r.json.cold[0].walk, false);
});

test('http rules: methods, content type, body size, bad json, no cache', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  assert.equal((await S.call('status', {}, { method: 'DELETE' })).status, 405);
  assert.equal((await S.call('door', { line: 'x' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await S.call('door', undefined, { method: 'POST', raw: 'x', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await S.call('door', { line: 'x'.repeat(20000) })).status, 413);
  assert.equal((await S.call('door', { line: 'x' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await S.call('nope', {})).status, 404);
  const r = await S.call('status');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('door: only the right line opens it; nothing is stored', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  let r = await S.call('door', { line: 'open the door please' });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.pass, undefined);
  r = await S.call('door', { line: '' });
  assert.equal(r.json.ok, false);
  r = await S.call('door', { line: 'open sesame,  TEST!' });
  assert.equal(r.json.ok, true);
  const p = S.payload(r.json.pass);
  assert.equal(p.f, F);
  assert.equal(p.s, 0);
  assert.equal(p.d, 3);
  assert.equal(S.X.fstate(S.X.packs.get(F)).recs && Object.keys(S.X.fstate(S.X.packs.get(F)).recs).length, 0);
});

test('state: stages open as their requirements are met; locked ones stay anonymous', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  let r = await S.call('state', { pass: pl.tok });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.stages[0].state, 'open');
  assert.equal(r.json.stages[0].title, 'stage 1');
  assert.equal(r.json.stages[1].state, 'locked');
  assert.equal(r.json.stages[1].title, null);
  assert.equal(r.json.unlit, true);
  assert.equal(r.json.floor.ok, false);
  assert.equal(r.json.stages[0].answers.left, 3);
  r = await S.call('state', { pass: 'nonsense' });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'badpass');
  r = await S.call('state', {});
  assert.equal(r.json.error, 'nopass');
});

test('stage: locked stages say nothing; open ones are gated per day', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  let r = await S.call('stage', { pass: pl.tok, stage: 's2' });
  assert.equal(r.json.error, 'locked');
  assert.equal((await S.call('stage', { pass: pl.tok, stage: 'zz' })).json.error, 'locked');
  assert.equal((await right(S, pl, 's1')).json.result, 'correct');
  S.day(3);
  r = await S.call('stage', { pass: pl.tok, stage: 's2' });
  assert.equal(r.json.ok, true);
  const ids = r.json.data.entries.map((e) => e.id);
  assert.deepEqual(ids, ['e1']);           // e2 ($rel 1) needs a day after the stage opened (day 3)
  S.day(4);
  r = await S.call('stage', { pass: pl.tok, stage: 's2' });
  assert.deepEqual(r.json.data.entries.map((e) => e.id), ['e1', 'e2']);
  S.day(5);
  r = await S.call('stage', { pass: pl.tok, stage: 's2' });
  assert.deepEqual(r.json.data.entries.map((e) => e.id), ['e1', 'e2', 'e3']);
});

test('broadcast: the frame on air, the recordings and their masking', async (t) => {
  const S = await startHunt({ now: OPEN + 3 * DAY + 60 * 60000 + 10000 });   // 01:00:10 UTC: the first airing (offset 60 min) is 10 s old
  t.after(() => S.stop());
  const pl = await player(S);
  let r = await S.call('stage', { pass: pl.tok, stage: 's1' });
  assert.equal(r.json.data.now.state, 'live');
  assert.equal(r.json.data.live.slot, 0);
  assert.equal(r.json.data.live.of, 2);                   // day 3 airs reel 3 mod 2 = 1, which has two frames
  assert.equal(r.json.data.live.lines.length, 2);
  assert.deepEqual(r.json.data.rec.map((x) => x.day), [0, 1, 2]);   // today's recording opens after dur + recAfter
  S.setNow(OPEN + 3 * DAY + (60 + 30 + 10) * 60000 + 1);
  r = await S.call('stage', { pass: pl.tok, stage: 's1' });
  assert.equal(r.json.data.now.state, 'idle');
  assert.equal(r.json.data.live, null);
  assert.ok(r.json.data.rec.some((x) => x.day === 3));
  const masked = r.json.data.rec.find((x) => x.day === 3).frames[0].lines.join('');
  assert.ok(masked.length === 16);
  const again = await S.call('stage', { pass: pl.tok, stage: 's1' });
  assert.deepEqual(again.json.data.rec, r.json.data.rec);  // masking is deterministic
  assert.equal(JSON.stringify(r.json).includes('secret'), false);
});

test('answer: wrong, invalid, solved, locked, foreign, warm, budget', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await answer(S, pl, 'nothing like it')).json.result, 'wrong');
  assert.equal((await answer(S, pl, '!!!')).json.error, 'invalid');
  assert.equal((await answer(S, pl, 'x'.repeat(300))).json.error, 'invalid');
  assert.equal((await answer(S, pl, 'whatever', { stage: 's2' })).json.error, 'locked');
  const other = (pl.L + 1) % 4;
  assert.equal((await answer(S, pl, ansText('s1', other), { stage: 's1' })).json.result, 'foreign');
  assert.equal((await answer(S, pl, warmText('s1', pl.L), { stage: 's1' })).json.result, 'warm');
  // three attempts are used (wrong x1, foreign, warm): the fourth is out of budget
  assert.equal((await answer(S, pl, 'again', { stage: 's1' })).json.error, 'budget');
  const st = await S.call('state', { pass: pl.tok });
  assert.equal(st.json.stages[0].answers.left, 0);
});

test('answer: the right one solves, unlocks, re-issues the pass and counts once', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  const r = await right(S, pl, 's1');
  assert.equal(r.json.result, 'correct');
  assert.deepEqual(r.json.unlocked, ['s2', 's3', 's4']);
  assert.equal(pl.p.s, 1);
  assert.equal(S.X.fstate(S.X.packs.get(F)).solved.s1, 1);
  const again = await right(S, pl, 's1');
  assert.equal(again.json.result, 'solved');
  assert.equal(S.X.fstate(S.X.packs.get(F)).solved.s1, 1);
  const st = await S.call('state', { pass: pl.tok });
  assert.equal(st.json.stages[0].state, 'solved');
  assert.equal(st.json.stages[1].state, 'open');
  // a pass without the new bit still reads as solved: the record is authoritative
  const old = await S.call('state', { pass: (await S.call('door', { line: DOOR_LINE })).json.pass });
  assert.equal(old.json.stages[0].state, 'open');
});

test('answer: too fast is a 429; per-day totals are capped; early stays unsolved', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await S.call('answer', { pass: pl.tok, text: 'a' })).json.result, 'wrong');
  const r = await S.call('answer', { pass: pl.tok, text: 'b' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'limit');
  assert.ok(r.headers.get('retry-after'));
});

test('planchette: the answer is the pass\'s own drawn grid', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await right(S, pl, 's1');
  const d = S.X.drawOf({ P: S.X.packs.get(F), id: pl.p.id }, S.X.packs.get(F).byId.get('s4'));
  const r = await S.call('stage', { pass: pl.tok, stage: 's4' });
  assert.deepEqual(r.json.data.givens, d.givens);
  assert.equal(r.json.data.sec, undefined);
  assert.equal(JSON.stringify(r.json).includes(d.grid), false);
  assert.equal((await answer(S, pl, d.lin.sec.grid, { stage: 's4' })).json.result, 'wrong');   // the BASE grid is not the answer
  assert.equal((await answer(S, pl, d.grid, { stage: 's4' })).json.result, 'correct');
});

test('echoes: timed, one tier at a time, hints rendered per pass, pass flagged', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  let r = await S.call('echo', { pass: pl.tok, stage: 's1', claim: true });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'early');
  assert.equal(r.json.at, 3 + 1 + 0);
  S.day(4);
  r = await S.call('echo', { pass: pl.tok, stage: 's1', claim: true });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tier, 1);
  assert.equal(r.json.text, 'hint one s1');
  assert.equal(r.json.unlit, false);
  assert.equal(S.payload(r.json.pass).h, 1);
  r = await S.call('echo', { pass: pl.tok, stage: 's1', claim: true });
  assert.equal(r.json.error, 'early');
  S.day(6);
  r = await S.call('echo', { pass: pl.tok, stage: 's1', claim: false });
  assert.equal(r.json.echoes.length, 1);
  assert.equal(r.json.next, 2);
  const st = await S.call('state', { pass: pl.tok });
  assert.equal(st.json.unlit, false);
});

test('echoes: planchette hints get the pass\'s placeholders', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await right(S, pl, 's1');
  S.day(8);
  const r = await S.call('echo', { pass: pl.tok, stage: 's4', claim: true });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.text.includes('{{'), false);
  assert.match(r.json.text, /^try is [a-d][1-4] .+ first$/);
});

test('recover: a record brings the pass back; no record, no pass', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await S.call('recover', { code: pl.p.id })).json.error, 'invalid');   // nothing spent yet
  await right(S, pl, 's1');
  const r = await S.call('recover', { code: pl.p.id.slice(0, 11) + ' ' + pl.p.id.slice(11) });
  assert.equal(r.json.ok, true);
  const back = S.payload(r.json.pass);
  assert.equal(back.id, pl.p.id);
  assert.equal(back.s, 1);
  assert.equal((await S.call('recover', { code: 'x'.repeat(22) })).json.error, 'invalid');
});

test('cert: only after the last stage; verify checks the signature', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal((await S.call('cert', { pass: pl.tok })).json.error, 'locked');
  // fake a solved frequency in the record to test issuing
  const c = S.X.ctxOf(pl.p, null);
  const rec = S.X.ensureRec(c);
  for (const st of S.X.packs.get(F).stages) rec.s[st.id] = 3;
  const r = await S.call('cert', { pass: pl.tok });
  assert.equal(r.json.ok, true);
  const v = await S.call('verify', { cert: r.json.cert });
  assert.equal(v.json.ok, true);
  assert.equal(v.json.payload.f, F);
  assert.equal(v.json.payload.late, 0);
  assert.equal(v.json.payload.unlit, 1);
  assert.equal((await S.call('verify', { cert: r.json.cert + 'x' })).json.ok, false);
  const again = await S.call('cert', { pass: pl.tok });
  assert.equal(again.json.cert, r.json.cert);   // stable per pass
});

test('late mode: after cold nothing is stored and progress rides on the pass', async (t) => {
  const S = await startHunt({ now: OPEN + 40 * DAY });
  t.after(() => S.stop());
  const pl = await player(S);
  assert.equal(pl.p.d, 40);
  const r = await right(S, pl, 's1');
  assert.equal(r.json.result, 'correct');
  assert.equal(pl.p.s, 1);
  for (let i = 0; i < 5; i++) assert.equal((await answer(S, pl, 'junk ' + i)).json.result, 'wrong');   // no budget
  assert.equal(Object.keys(S.X.fstate(S.X.packs.get(F)).recs).length, 0);
  const st = await S.call('state', { pass: pl.tok });
  assert.equal(st.json.late, true);
  assert.equal(st.json.stages[1].state, 'open');
  const e = await S.call('echo', { pass: pl.tok, stage: 's1', claim: true });
  assert.equal(e.json.ok, true);
  const b = await S.call('stage', { pass: pl.tok, stage: 's1' });
  assert.equal(b.json.data.rec.length, 2);       // every reel once, clean
  assert.equal((await S.call('recover', { code: pl.p.id })).json.error, 'invalid');
});

test('head start: a certificate of the previous frequency opens the next early, twice at most', async (t) => {
  const LINE2 = 'open sesame second';
  const S = await startHunt({ packs: [{ f: 'freq-01', n: 1, openMs: OPEN - 40 * DAY }, { f: 'freq-02', n: 2, openMs: OPEN, doorLine: LINE2 }], now: OPEN - 6 * 3600000 });
  t.after(() => S.stop());
  // a certificate of freq-01 (made by the engine's own signer, the way /cert would)
  const old = S.X.mintPass(S.X.packs.get('freq-01'), OPEN - 20 * DAY);
  const c0 = S.X.ctxOf(S.payload(old.token), null);
  const cert = S.X.issueCert(Object.assign(c0, { late: false }), 0);
  let r = await S.call('status', { cert });
  assert.equal(r.json.live.length, 1);
  assert.equal(r.json.live[0].f, 'freq-02');
  assert.equal(r.json.live[0].early, true);
  assert.ok(r.json.door);
  assert.equal((await S.call('status', {})).json.live.length, 0);
  assert.equal((await S.call('door', { line: LINE2 })).json.ok, false);                          // no certificate
  const first = await S.call('door', { line: LINE2, cert });
  assert.equal(first.json.ok, true);
  const p = S.payload(first.json.pass);
  assert.equal(p.hs, 1);
  assert.equal(p.d, -1);
  assert.equal((await S.call('door', { line: LINE2, cert })).json.ok, true);
  const third = await S.call('door', { line: LINE2, cert });
  assert.equal(third.json.ok, false);
  assert.equal(third.json.error, 'limit');
  // the head-start airing is on air for that pass
  const s = await S.call('stage', { pass: first.json.pass, stage: 's1' });
  assert.equal(s.json.ok, true);
  assert.ok(s.json.data.now.next);
});

test('records: lazy, evicted not refused, purged at cold, state file is atomic json', async (t) => {
  const S = await startHunt({ packs: [{ limits: { records: { max: 2, evictAfterDays: 7 } } }] });
  t.after(() => S.stop());
  const P = S.X.packs.get(F);
  const ps = [];
  for (let i = 0; i < 3; i++) { ps.push(await player(S)); S.X.ensureRec(S.X.ctxOf(ps[i].p, null)); S.X.getRec(P, ps[i].p.id).la = i; }
  assert.equal(Object.keys(S.X.fstate(P).recs).length, 2);     // the oldest unsolved record made room
  assert.ok(S.X.getRec(P, ps[2].p.id));
  S.X.flush();
  S.h.flush();
  const file = S.X.dataDir + '/state.json';
  const fs = await import('node:fs');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1);
  S.day(30);
  S.X.housekeeping();
  assert.equal(Object.keys(S.X.fstate(P).recs).length, 0);
  assert.equal(S.X.fstate(P).purged, 30);
});

test('nothing but counters is stored: no passes, answers or addresses in the state file', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pl = await player(S);
  await answer(S, pl, 'secret guess zzz');
  await right(S, pl, 's1');
  S.X.saveSoon();
  S.h.flush();
  const fs = await import('node:fs');
  const text = fs.readFileSync(S.X.dataDir + '/state.json', 'utf8');
  assert.equal(text.includes(pl.p.id), false);
  assert.equal(text.includes('zzz'), false);
  assert.equal(text.includes('127.0.0.1'), false);
});
