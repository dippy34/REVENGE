// hunt-seal.test.mjs: the seal tool end to end, on a SYNTHETIC frequency in a throwaway repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as lib from './hunt-lib.mjs';
import { createHunt } from './hunt.mjs';
import { makeRepo } from './hunt-synth.mjs';
import { run } from './hunt-tools-kit.mjs';

const F = 'freq-91';
function repo(t, opts) {
  const root = makeRepo(opts);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run('hunt-keys.mjs', [], root).code, 0);
  assert.equal(run('hunt-keys.mjs', ['--write-pub'], root).code, 0);
  return root;
}
const seal = (root, args = []) => run('hunt-seal.mjs', [F, ...args], root);
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const envOf = (root) => Object.fromEntries(read(root, 'server/.env').split('\n').filter((l) => /^HUNT_/.test(l)).map((l) => l.split('=')));
const packOf = (root) => {
  const e = envOf(root);
  return lib.openJson(lib.readEnvelope(read(root, 'server/hunt/' + F + '.pack')), lib.parseSecret(e.HUNT_KEY), { kind: 'pack', f: F });
};

test('seal: a synthetic frequency passes, writes four sealed files, prints no content', (t) => {
  const root = repo(t);
  const r = seal(root);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /\nPASS\n/);
  for (const n of ['pack', 'src.sealed', 'walkthrough.sealed', 'walk-public.sealed']) assert.ok(fs.existsSync(path.join(root, 'server/hunt', F + '.' + n)), n);
  assert.match(r.out, /walkthrough re-wrapped with HUNT_KEY/);
  assert.equal(/zq\d[a-z]{6,}|zw\d[a-z]{6,}|zm[a-z]{6,}/.test(r.all), false);   // none of the generated answers
  assert.ok(fs.existsSync(path.join(root, 'hunt', F, 'out', 'report.json')));
  const p = packOf(root);
  assert.equal(p.f, F);
  assert.equal(p.lineages, 4);
  assert.deepEqual(p.stages.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5', 's6']);
  assert.equal(p.schedule.coldAt, '2030-02-04T00:00:00.000Z');
  assert.equal(p.stages[0].foreign, 1);
  assert.equal(p.stages[3].foreign, 0);
  assert.equal(p.stages[3].lineages[0].sec.pool.length, 6);               // the pool dial
  assert.equal(JSON.stringify(p).includes('the answer is'), false);        // no walkthrough text in the pack
  assert.ok(p.frozen['js/extra.js']);                                      // a plugin dep is frozen
  assert.ok(p.frozen['js/hunt-sim.js']);
});

test('seal: the sealed pack loads in the engine and the door and a stage answer work', async (t) => {
  const root = repo(t);
  assert.equal(seal(root).code, 0);
  const e = envOf(root);
  const h = createHunt({ env: { HUNT_KEY: e.HUNT_KEY, HUNT_HMAC: e.HUNT_HMAC, HUNT_SIGN_KEY: e.HUNT_SIGN_KEY, NODE_ENV: 'test' }, siteDir: path.join(root, 'site'), packDir: path.join(root, 'server/hunt'),
    dataDir: path.join(root, 'data'), host: '127.0.0.1', quiet: true, noTimers: true, clock: () => Date.UTC(2030, 0, 7, 1, 1), realClock: () => 1000000 });
  t.after(() => h.close());
  assert.match(h.summary(), /freq-91 live day 0/);
  const X = h._x;
  assert.equal(X.packs.size, 1);
  // the plaintext answer comes from regenerating with the same seed, the way the seal did
  const { loadFrequency, generateAll } = await import('../tools/hunt-seal.mjs');
  const F_ = await loadFrequency(root, F);
  const seed = lib.parseSecret(read(root, 'hunt/seal.env').trim().split('=')[1]);
  const gen = generateAll(F_, seed, root);
  const P = X.packs.get(F);
  const m = X.mintPass(P, Date.UTC(2030, 0, 7, 1, 1));
  const pass = X.verifyPass(m.token).payload;
  const L = lib.H.lineage(X.K.state, F, pass.id, 4);
  const c = X.ctxOf(pass, null);
  assert.equal(X.stageStateOf(c, P.byId.get('s1'), 0), 'open');
  const ans = gen.gens[L].s1.answers[0];
  const hashOk = P.byId.get('s1').lineages[L].ans.includes(lib.H.answer(X.K.content, F, 's1', L, lib.normStage(ans, { mode: 'alnum' })));
  assert.equal(hashOk, true);
  assert.equal(P.pack.door.hmac.includes(lib.H.door(X.K.content, F, lib.norm('open sesame zeta nine', 'words'))), true);
});

test('seal: --check writes nothing; a second seal is deterministic and keeps the pack stages identical', (t) => {
  const root = repo(t);
  const r = seal(root, ['--check']);
  assert.equal(r.code, 0, r.all);
  assert.equal(fs.existsSync(path.join(root, 'server/hunt', F + '.pack')), false);
  assert.equal(seal(root).code, 0);
  const a = packOf(root);
  const again = seal(root);
  assert.equal(again.code, 0, again.all);
  const b = packOf(root);
  assert.equal(lib.canon(a.stages), lib.canon(b.stages));
  assert.equal(lib.canon(a.door), lib.canon(b.door));
});

/* ---------- failure paths: each check must really stop a bad seal ---------- */

const edit = (root, rel, fn) => { const p = path.join(root, 'hunt', F, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
async function answersOf(root) {
  const { loadFrequency, generateAll } = await import('../tools/hunt-seal.mjs');
  const F_ = await loadFrequency(root, F);
  const seed = lib.parseSecret(read(root, 'hunt/seal.env').trim().split('=')[1]);
  return generateAll(F_, seed, root);
}
const failed = (r, id) => r.code === 1 && new RegExp('FAIL ' + id.replace('.', '\\.')).test(r.out);
const noPack = (root) => !fs.existsSync(path.join(root, 'server/hunt', F + '.pack'));

test('seal: refuses without keys, or with the seed only in server/.env', (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let r = seal(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /keys\.HUNT_KEY/);
  run('hunt-keys.mjs', [], root);
  fs.appendFileSync(path.join(root, 'server/.env'), 'HUNT_SEED=' + read(root, 'hunt/seal.env').split('=')[1].trim() + '\n');
  fs.rmSync(path.join(root, 'hunt/seal.env'));
  r = seal(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /move-seed/);
});

test('seal: repo hygiene: hunt/ must be ignored and server/.env too', (t) => {
  const root = makeRepo({ noIgnore: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  run('hunt-keys.mjs', ['--write-pub'], root);
  const r = seal(root);
  assert.ok(failed(r, 'repo.private-ignored'), r.out);
  assert.ok(noPack(root));
});

test('seal: the answer in a site file, or in an uncommitted change, is a leak, and nothing is written or printed', async (t) => {
  const root = repo(t);
  const g = await answersOf(root);
  const secret = g.gens[0].s1.answers[0];
  fs.writeFileSync(path.join(root, 'site/js/oops.js'), '// remember ' + secret + ' for later\n');
  let r = seal(root);
  assert.ok(failed(r, 'leaks.none'), r.out);
  assert.match(r.out, /site\/js\/oops\.js:1 \[answer\]/);
  assert.equal(r.all.includes(secret), false);
  assert.equal(JSON.stringify(read(root, 'hunt/freq-91/out/report.json')).includes(secret), false);
  assert.ok(noPack(root));
  fs.rmSync(path.join(root, 'site/js/oops.js'));
  fs.writeFileSync(path.join(root, 'README.md'), '# synthetic ' + g.gens[1].s2.answers[0] + '\n');
  r = seal(root);
  assert.ok(failed(r, 'leaks.none'), r.out);
  assert.match(r.out, /README\.md:1 \[answer\]/);
  assert.match(r.out, /git diff \[answer\]/);
});

test('seal: a secret anywhere outside server/.env is a leak', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'docs/notes.md'), 'key ' + envOf(root).HUNT_HMAC + '\n');
  const r = seal(root);
  assert.ok(failed(r, 'leaks.none'), r.out);
  assert.match(r.out, /docs\/notes\.md:1 \[secret:HUNT_HMAC\]/);
  assert.equal(r.all.includes(envOf(root).HUNT_HMAC), false);
});

test('seal: errata safety: a changed stage fails unless it is allowed, and nothing else may move', (t) => {
  const root = repo(t);
  assert.equal(seal(root).code, 0);
  const before = read(root, 'server/hunt/' + F + '.pack');
  edit(root, 'stages/s2-b.mjs', (s) => s.replace("title: 'stage 2'", "title: 'stage two'"));
  let r = seal(root);
  assert.ok(failed(r, 'errata.unchanged'), r.out);
  assert.match(r.out, /changed and not allowed: s2/);
  assert.equal(read(root, 'server/hunt/' + F + '.pack'), before);          // untouched on failure
  assert.equal(seal(root, ['--allow', 's1']).code, 1);                      // allowing another stage does not help
  r = seal(root, ['--allow', 's2']);
  assert.equal(r.code, 0, r.out);
  assert.notEqual(read(root, 'server/hunt/' + F + '.pack'), before);
  assert.equal(packOf(root).stages[1].title, 'stage two');
  // an explicit --against pack is compared instead
  const copy = path.join(root, 'old.pack');
  fs.copyFileSync(path.join(root, 'server/hunt/' + F + '.pack'), copy);
  edit(root, 'stages/s3-c.mjs', (s) => s.replace("title: 'stage 3'", "title: 'stage three'"));
  assert.ok(failed(seal(root, ['--check', '--against', copy]), 'errata.unchanged'));
});

test('seal: weak or colliding answers, leaky hints and bad doors are caught', (t) => {
  let root = repo(t);
  edit(root, 'stages/s1-a.mjs', (s) => s.replace("const a = word(ctx.rng, 8, 'zq1')", "const a = 'zq1samesame'"));
  assert.ok(failed(seal(root, ['--check']), 'answers.distinct'));
  root = repo(t);
  edit(root, 'stages/s1-a.mjs', (s) => s.replace("const a = word(ctx.rng, 8, 'zq1')", "const a = word(ctx.rng, 1, 'z')"));
  assert.ok(failed(seal(root, ['--check']), 'answers.long'));
  root = repo(t);
  edit(root, 'stages/s2-b.mjs', (s) => s.replace("'look at the thing']", "'it is ' + gen.answers[0]]"));
  assert.ok(failed(seal(root, ['--check']), 'hints.clean'));
  root = repo(t, { shape: '.' });
  assert.ok(failed(seal(root, ['--check']), 'door.collisions'));
  root = repo(t);
  edit(root, 'stages/s0-entrance.mjs', (s) => s.replace("tear: '~#~'", "tear: 'no signal'"));
  assert.ok(failed(seal(root, ['--check']), 'tells.vocabulary'));
});

test('seal: a failing plugin check surfaces by id, stage and lineage; notes that hold content are withheld', async (t) => {
  const root = repo(t);
  const g = await answersOf(root);
  const secret = g.gens[0].s3.answers[0];
  edit(root, 'stages/s3-c.mjs', (s) => s.replace("validate() { return ok('s3.ok'); }", "validate(gen) { return { ok: false, checks: [{ id: 's3.demo', ok: false, note: 'because ' + gen.answers[0] }] }; }"));
  const r = seal(root, ['--check']);
  assert.ok(failed(r, 's3.demo'), r.out);
  assert.match(r.out, /\[s3 lineage 0\]/);
  assert.equal(r.all.includes(secret), false);
  assert.match(r.out, /note withheld/);
});

test('seal: the client\'s public key must be the signing key\'s', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'site/js/hunt.js'), "var PUB = '" + 'A'.repeat(43) + "';\n");
  assert.ok(failed(seal(root, ['--check']), 'pub.matches'));
});

test('seal: pool selection must find enough usable draws, or generation fails clearly', (t) => {
  const root = repo(t, { poolOk: false });
  const r = seal(root, ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /generate\.run/);
  assert.match(r.out, /too few usable draws/);
});

test('seal: --only validates just those stages and never writes; --frozen finds changed site files', (t) => {
  const root = repo(t);
  let r = seal(root, ['--only', 's2,s3']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PARTIAL/);
  assert.ok(noPack(root));
  assert.equal(seal(root).code, 0);
  r = seal(root, ['--frozen']);
  assert.equal(r.code, 0, r.out);
  fs.appendFileSync(path.join(root, 'site/js/eggs.js'), '// edited\n');
  r = seal(root, ['--frozen']);
  assert.ok(failed(r, 'frozen.unchanged'), r.out);
  assert.match(r.out, /js\/eggs\.js/);
});

test('seal: an existing passphrase wrap is kept when the walkthrough did not change', async (t) => {
  const root = repo(t);
  assert.equal(seal(root).code, 0);
  const open = await import('../tools/hunt-open.mjs');
  const file = path.join(root, 'server/hunt/' + F + '.walkthrough.sealed');
  const key = lib.parseSecret(envOf(root).HUNT_KEY);
  fs.writeFileSync(file, JSON.stringify(open.setPassphrase(open.readWalk(file), key, 'correct horse battery staple')) + '\n');
  const wrapped = fs.readFileSync(file, 'utf8');
  const r = seal(root);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.includes('re-wrapped'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), wrapped);
  edit(root, 'stages/s4-p.mjs', (s) => s.replace("method: 'method for s4'", "method: 'a changed method'"));
  const r2 = seal(root, ['--allow', 's4']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /re-wrapped with HUNT_KEY/);
  assert.equal(open.readWalk(file).wrap, 'key');
});

test('leak terms: engine words, glyph runs and filler are not content; answers, grids and real lines still are', async () => {
  const K = await import('../tools/hunt-checks.mjs');
  const kit = await import('../tools/hunt-kit.mjs');
  const items = [
    { text: 'cmd:tint:pink', cat: 'content' }, { text: 'snake:start', cat: 'content' }, { text: 'hollow', cat: 'content' },
    { text: kit.GLYPHS.sym.slice(0, 5), cat: 'content' }, { text: '........', cat: 'content' }, { text: '#..#', cat: 'content' },
    { text: 'the lamp hums twice over the stair', cat: 'content' }, { text: 'qz7w-v9x3-k2', cat: 'content' },
    { text: kit.GLYPHS.sym.slice(0, 5), cat: 'grid' }, { text: 'zqxwvbfnmt', cat: 'answer', norm: true }, { text: 'qjxzvqjxzvqj', cat: 'grid' }
  ];
  const got = new Set(K.leakTerms(items, {}).map((t) => t.s));
  for (const gone of ['cmd:tint:pink', 'snake:start', 'hollow', '........', '#..#']) assert.ok(!got.has(gone), 'not a leak term: ' + gone);
  for (const kept of ['the lamp hums twice over the stair', 'qz7w-v9x3-k2', 'zqxwvbfnmt', 'qjxzvqjxzvqj']) assert.ok(got.has(kept), 'still a leak term: ' + kept);
  // a glyph run is dropped as stage content but kept when it is a planchette grid
  const asContent = K.leakTerms([items[3]], {}).length, asGrid = K.leakTerms([items[8]], {}).length;
  assert.equal(asContent, 0);
  assert.equal(asGrid, 1);
});
