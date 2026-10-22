// hunt-tools.test.mjs: the hunt tools, run as real processes against a throwaway repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lib from './hunt-lib.mjs';
import { tmpRoot, run, TOOLS } from './hunt-tools-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mode = (root, rel) => fs.statSync(path.join(root, rel)).mode & 0o777;
const secretsIn = (root) => {
  const vals = [];
  for (const rel of ['server/.env', 'hunt/seal.env']) {
    try { for (const l of read(root, rel).split('\n')) { const m = /^HUNT_[A-Z_]+=(.+)$/.exec(l); if (m) vals.push(m[1]); } } catch (e) { /* none */ }
  }
  return vals;
};

test('keys: creates the four secrets in the right files, 0600, names only', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = run('hunt-keys.mjs', [], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /added: HUNT_KEY, HUNT_HMAC, HUNT_SIGN_KEY, HUNT_SEED/);
  const env = read(root, 'server/.env');
  assert.match(env, /^HUNT_KEY=/m);
  assert.match(env, /^HUNT_HMAC=/m);
  assert.match(env, /^HUNT_SIGN_KEY=/m);
  assert.equal(/HUNT_SEED/.test(env), false);                    // the seed never goes in server/.env
  assert.match(read(root, 'hunt/seal.env'), /^HUNT_SEED=/m);
  assert.equal(mode(root, 'server/.env'), 0o600);
  assert.equal(mode(root, 'hunt/seal.env'), 0o600);
  for (const v of secretsIn(root)) { assert.equal(r.all.includes(v), false); assert.ok(lib.parseSecret(v)); }
  assert.match(run('hunt-keys.mjs', [], root).out, /nothing to add/);
});

test('keys: --check says where each is; flags a stray seed and malformed values', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  let r = run('hunt-keys.mjs', ['--check'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /HUNT_KEY: present in server\/\.env, well formed/);
  assert.match(r.out, /HUNT_SEED: present in hunt\/seal\.env, well formed/);
  fs.appendFileSync(path.join(root, 'server/.env'), 'HUNT_SEED=' + lib.newSecret() + '\n');
  r = run('hunt-keys.mjs', ['--check'], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /HUNT_SEED is in server\/\.env/);
  fs.writeFileSync(path.join(root, 'hunt/seal.env'), 'HUNT_SEED=short\n');
  assert.match(run('hunt-keys.mjs', ['--check'], root).out, /NOT well formed/);
});

test('keys: --move-seed keeps every other line, and the file mode', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = lib.newSecret();
  fs.writeFileSync(path.join(root, 'server/.env'), 'ANTHROPIC_API_KEY=sk-not-a-real-key\nHUNT_SEED=' + seed + '\nPORT=8080\n', { mode: 0o640 });
  fs.chmodSync(path.join(root, 'server/.env'), 0o640);
  const r = run('hunt-keys.mjs', ['--move-seed'], root);
  assert.equal(r.code, 0);
  assert.equal(r.all.includes(seed), false);
  assert.equal(r.all.includes('sk-not-a-real-key'), false);
  assert.equal(read(root, 'server/.env'), 'ANTHROPIC_API_KEY=sk-not-a-real-key\nPORT=8080\n');
  assert.equal(mode(root, 'server/.env'), 0o640);
  assert.match(read(root, 'hunt/seal.env'), new RegExp('^HUNT_SEED=' + seed + '$', 'm'));
  assert.match(run('hunt-keys.mjs', ['--move-seed'], root).out, /not in server/);
});

test('keys: --public and --write-pub use the production key; no PUB line is a clear error', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  const pub = run('hunt-keys.mjs', ['--public'], root).out.trim();
  assert.equal(pub.length, 43);
  const env = Object.fromEntries(read(root, 'server/.env').split('\n').filter(Boolean).map((l) => l.split('=')));
  assert.equal(lib.deriveKeys({ HUNT_KEY: env.HUNT_KEY, HUNT_HMAC: env.HUNT_HMAC, HUNT_SIGN_KEY: env.HUNT_SIGN_KEY }, false).pubB64, pub);
  assert.equal(run('hunt-keys.mjs', ['--write-pub'], root).code, 0);
  assert.match(read(root, 'site/js/hunt.js'), new RegExp("var PUB = '" + pub + "';"));
  fs.writeFileSync(path.join(root, 'site/js/hunt.js'), 'nothing here\n');
  assert.equal(run('hunt-keys.mjs', ['--write-pub'], root).code, 1);
  assert.equal(run('hunt-keys.mjs', ['--public'], tmpRoot()).code, 1);        // no secrets at all
});

test('keys: --rotate changes one secret; the dangerous ones refuse without --force', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  const before = read(root, 'server/.env');
  const r = run('hunt-keys.mjs', ['--rotate', 'HUNT_HMAC'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /HUNT_HMAC regenerated/);
  const after = read(root, 'server/.env');
  assert.notEqual(after, before);
  assert.equal(after.split('\n').filter((l) => l.startsWith('HUNT_KEY=')).join(), before.split('\n').filter((l) => l.startsWith('HUNT_KEY=')).join());
  assert.equal(secretsIn(root).some((v) => r.all.includes(v)), false);
  assert.equal(run('hunt-keys.mjs', ['--rotate', 'NOPE'], root).code, 1);
  // a sealed pack on disk makes HUNT_KEY and HUNT_SEED rotation refuse
  fs.mkdirSync(path.join(root, 'server/hunt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/hunt/freq-01.pack'), '{}\n');
  assert.equal(run('hunt-keys.mjs', ['--rotate', 'HUNT_SEED'], root).code, 1);
  assert.equal(run('hunt-keys.mjs', ['--rotate', 'HUNT_KEY'], root).code, 1);
  assert.equal(run('hunt-keys.mjs', ['--rotate', 'HUNT_SEED', '--force'], root).code, 0);
});

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

test('sandbox: starts a loopback sandbox, strips production settings, hides the admin token', async (t) => {
  const port = await freePort();
  const env = Object.assign({}, process.env, { NODE_ENV: 'production', STATS_DIR: '/nonexistent', ANTHROPIC_API_KEY: 'sk-not-real', HUNT_SEED: lib.newSecret(),
    HUNT_KEY: lib.newSecret(), HUNT_HMAC: lib.newSecret(), HUNT_SIGN_KEY: lib.newSecret() });
  const dataDir = path.join(here, '.data', 'hunt-sandbox-' + port);
  const child = spawn(process.execPath, [path.join(TOOLS, 'hunt-sandbox.mjs'), '--port', String(port), '--speed', '60', '--start', '2030-01-07T00:00:00Z', '--fresh'], { env });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const t0 = Date.now();
  while (!/sandbox ready/.test(output) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
  assert.match(output, /sandbox ready: http:\/\/127\.0\.0\.1:/);
  const token = fs.readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  assert.equal(fs.statSync(path.join(dataDir, 'admin-token')).mode & 0o777, 0o600);
  assert.equal(output.includes(token), false);                      // the token never reaches the terminal
  assert.match(output, /HUNT SANDBOX ON: clock x60 from 2030-01-07/);
  const st = await (await fetch('http://127.0.0.1:' + port + '/api/hunt/status')).json();
  assert.equal(st.on, true);
  assert.equal(st.sandbox, true);
  assert.equal(st.pub.length, 43);
  assert.equal((await fetch('http://127.0.0.1:' + port + '/api/hunt/sandbox/info')).status, 404);
  const info = await (await fetch('http://127.0.0.1:' + port + '/api/hunt/sandbox/info', { headers: { 'x-hunt-admin': token } })).json();
  assert.equal(info.ok, true);
  assert.equal(info.speed, 60);
  assert.equal(info.dataDir, 'hunt-sandbox-' + port);
  // the mock AI is on and the real key is gone
  const ai = await (await fetch('http://127.0.0.1:' + port + '/api/ai/status')).json();
  assert.equal(ai.awake, true);
});

test('sandbox: refuses to start without the runtime secrets', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = run('hunt-sandbox.mjs', ['--port', '8199'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /HUNT_KEY is missing/);
});

/* ---------- hunt-open ---------- */

import crypto from 'node:crypto';
import * as open from '../tools/hunt-open.mjs';
import { startHunt, makePack, testEnv, keysOf, DOOR_LINE } from './hunt-fixture.mjs';

function walkFile(root, f, huntKey, stages, wrap) {
  const env = lib.wrapWalk(stages, lib.walkKeyMaster(huntKey, f), { f, wrap: 'key', kdf: null, srcHash: 'a'.repeat(64) });
  fs.mkdirSync(path.join(root, 'server/hunt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/hunt', f + '.walkthrough.sealed'), JSON.stringify(env) + '\n');
  return env;
}
const STAGES = { s0: { method: 'm0', lineages: [{ detail: 'd0a' }, { detail: 'd0b' }, { detail: 'd0c' }, { detail: 'd0d' }] },
  s1: { method: 'm1', lineages: [0, 1, 2, 3].map((i) => ({ detail: 'detail ' + i })) } };

test('open: a key-wrapped file refuses to open; a passphrase re-wraps every stage and opens exactly one', () => {
  const key = crypto.randomBytes(32);
  const env = lib.wrapWalk(STAGES, lib.walkKeyMaster(key, 'freq-01'), { f: 'freq-01', wrap: 'key', kdf: null, srcHash: 'b'.repeat(64) });
  assert.throws(() => open.openStage(env, key, 'whatever whatever 1', 's1'), /unset/);
  assert.throws(() => open.setPassphrase(env, key, 'short'), /short/);
  const locked = open.setPassphrase(env, key, 'correct horse battery staple');
  assert.equal(locked.wrap, 'pass');
  assert.equal(locked.kdf.alg, 'scrypt');
  assert.equal(locked.srcHash, 'b'.repeat(64));
  assert.equal(open.openStage(locked, key, 'correct horse battery staple', 's1').method, 'm1');
  assert.throws(() => open.openStage(locked, key, 'correct horse battery stapl', 's1'), /badpass/);
  assert.throws(() => open.openStage(locked, crypto.randomBytes(32), 'correct horse battery staple', 's1'), /badpass/);   // the passphrase alone is not enough
  assert.throws(() => open.openStage(locked, key, 'correct horse battery staple', 's9'), /nostage/);
  // changing the passphrase needs the old one
  assert.throws(() => open.setPassphrase(locked, key, 'another long passphrase', 'wrong wrong wrong wrong'));
  const again = open.setPassphrase(locked, key, 'another long passphrase', 'correct horse battery staple');
  assert.equal(open.openStage(again, key, 'another long passphrase', 's0').method, 'm0');
  assert.throws(() => open.openStage(again, key, 'correct horse battery staple', 's0'), /badpass/);
});

test('open: the detail is rendered for the pass exactly like the engine renders it', async (t) => {
  const S = await startHunt();
  t.after(() => S.stop());
  const pack = makePack({ K: S.K });
  const pl = { id: lib.b64u.enc(crypto.randomBytes(16)) };
  const text = 'rows:\n{{grid}}\ngivens: {{givens}}';
  const stage = { method: 'm', lineages: [0, 1, 2, 3].map(() => ({ detail: text })) };
  const got = open.detailFor(pack, S.K, pl, stage);
  const want = S.X.renderFor({ P: S.X.packs.get('freq-01'), id: pl.id }, { type: 'x' }, text);
  assert.equal(got.detail, want);
  assert.equal(got.lineage, lib.H.lineage(S.K.state, 'freq-01', pl.id, 4));
  assert.equal(got.detail.includes('{{'), false);
});

test('open: --list shows ids; --stage and --set-passphrase refuse without a terminal or a passphrase wrap', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  const env = Object.fromEntries(read(root, 'server/.env').split('\n').filter(Boolean).map((l) => l.split('=')));
  walkFile(root, 'freq-01', lib.parseSecret(env.HUNT_KEY), STAGES);
  assert.equal(run('hunt-open.mjs', ['freq-01', '--list'], root).out, 's0\ns1\n');
  let r = run('hunt-open.mjs', ['freq-01', '--stage', 's1'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /set a passphrase first/);
  r = run('hunt-open.mjs', ['freq-01', '--set-passphrase'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a terminal/);
  // after a passphrase wrap, --stage still refuses without a TTY
  const wrapped = open.setPassphrase(open.readWalk(path.join(root, 'server/hunt/freq-01.walkthrough.sealed')), lib.parseSecret(env.HUNT_KEY), 'correct horse battery staple');
  fs.writeFileSync(path.join(root, 'server/hunt/freq-01.walkthrough.sealed'), JSON.stringify(wrapped));
  r = run('hunt-open.mjs', ['freq-01', '--stage', 's1'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a terminal/);
  assert.equal(r.all.includes('m1'), false);
});

test('open: --restore-src writes the backup back, keeps existing files unless forced, refuses path tricks', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run('hunt-keys.mjs', [], root);
  const env = Object.fromEntries(read(root, 'server/.env').split('\n').filter(Boolean).map((l) => l.split('=')));
  const key = lib.parseSecret(env.HUNT_KEY);
  const files = { 'CONTRACT.md': Buffer.from('contract').toString('base64'), 'freq-01/freq.mjs': Buffer.from('export default {}').toString('base64') };
  const src = lib.sealJson({ v: 1, f: 'freq-01', files, at: '2030-01-01T00:00:00.000Z' }, key, { kind: 'src', f: 'freq-01', kid: lib.kidOf(env.HUNT_KEY) });
  fs.mkdirSync(path.join(root, 'server/hunt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/hunt/freq-01.src.sealed'), lib.writeEnvelope(src));
  let r = run('hunt-open.mjs', ['freq-01', '--restore-src'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /restored 2 files/);
  assert.equal(read(root, 'hunt/freq-01/freq.mjs'), 'export default {}');
  fs.writeFileSync(path.join(root, 'hunt/CONTRACT.md'), 'edited');
  r = run('hunt-open.mjs', ['freq-01', '--restore-src'], root);
  assert.match(r.out, /restored 0 files, kept 2 existing/);
  assert.equal(read(root, 'hunt/CONTRACT.md'), 'edited');
  assert.match(run('hunt-open.mjs', ['freq-01', '--restore-src', '--force'], root).out, /restored 2 files/);
  assert.equal(read(root, 'hunt/CONTRACT.md'), 'contract');
  const evil = lib.sealJson({ v: 1, f: 'freq-01', files: { '../escape.txt': 'eA==' }, at: 'x' }, key, { kind: 'src', f: 'freq-01', kid: lib.kidOf(env.HUNT_KEY) });
  fs.writeFileSync(path.join(root, 'server/hunt/freq-01.src.sealed'), lib.writeEnvelope(evil));
  assert.equal(run('hunt-open.mjs', ['freq-01', '--restore-src', '--force'], root).code, 1);
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
});
