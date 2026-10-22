#!/usr/bin/env node
// hunt-keys.mjs: creates and checks the signal's secrets (docs/07-hunt.md, "Secrets").
//
//   node tools/hunt-keys.mjs                add any missing secrets (names printed, never values)
//   node tools/hunt-keys.mjs --check        which exist, where, and whether they are well formed
//   node tools/hunt-keys.mjs --move-seed    move HUNT_SEED out of server/.env into hunt/seal.env
//   node tools/hunt-keys.mjs --public       print the production public key (public)
//   node tools/hunt-keys.mjs --write-pub    put that key into site/js/hunt.js
//   node tools/hunt-keys.mjs --rotate NAME [--force]
//
// HUNT_KEY, HUNT_HMAC and HUNT_SIGN_KEY live in server/.env (and on the server). HUNT_SEED
// lives only in hunt/seal.env on the machine that seals content, never deployed.
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../server/hunt-lib.mjs';
import * as E from './hunt-env.mjs';

const argv = process.argv.slice(2);
const root = E.rootOf(argv);
const P = E.paths(root);
const out = (s) => process.stdout.write(s + '\n');

function wellFormed(name, v) { return !!lib.parseSecret(v); }

function check() {
  const s = E.loadSecrets(root);
  let bad = false;
  for (const n of E.NAMES) {
    if (!(n in s.values)) { out(n + ': missing'); bad = true; continue; }
    const ok = wellFormed(n, s.values[n]);
    out(n + ': present in ' + s.where[n] + (ok ? ', well formed' : ', NOT well formed (needs base64url of 32 bytes)'));
    if (!ok) bad = true;
  }
  if (s.strays.length) { out('warning: HUNT_SEED is in server/.env; run: node tools/hunt-keys.mjs --move-seed'); bad = true; }
  process.exit(bad ? 1 : 0);
}

function add() {
  const s = E.loadSecrets(root);
  const added = [];
  for (const n of E.RUNTIME) {
    if (n in s.values) continue;
    E.appendLine(P.serverEnv, n, lib.newSecret());
    added.push(n);
  }
  if (!('HUNT_SEED' in s.values)) {
    if (s.seedOnlyInServerEnv) out('HUNT_SEED is in server/.env; run: node tools/hunt-keys.mjs --move-seed');
    else { E.appendLine(P.sealEnv, 'HUNT_SEED', lib.newSecret()); added.push('HUNT_SEED'); }
  }
  out(added.length ? 'added: ' + added.join(', ') : 'nothing to add');
}

function moveSeed() {
  const se = E.scanEnvFile(P.serverEnv), ss = E.scanEnvFile(P.sealEnv);
  if (!se.HUNT_SEED) { out('HUNT_SEED is not in server/.env'); return; }
  if (!ss.HUNT_SEED) E.appendLine(P.sealEnv, 'HUNT_SEED', se.HUNT_SEED);
  E.rewriteHuntLines(P.serverEnv, (n) => (n === 'HUNT_SEED' ? null : undefined));
  out('HUNT_SEED moved to hunt/seal.env');
}

function keys() {
  const s = E.loadSecrets(root);
  const k = lib.deriveKeys({ HUNT_KEY: s.values.HUNT_KEY || '', HUNT_HMAC: s.values.HUNT_HMAC || '', HUNT_SIGN_KEY: s.values.HUNT_SIGN_KEY || '' }, false);
  if (!k) E.die('the three runtime secrets are missing or malformed (run: node tools/hunt-keys.mjs)');
  return k;
}

function writePub() {
  const pub = keys().pubB64;
  let text;
  try { text = fs.readFileSync(P.huntJs, 'utf8'); } catch (e) { E.die('site/js/hunt.js not found'); }
  const re = /var PUB = '[A-Za-z0-9_-]*';/;
  if (!re.test(text)) E.die("site/js/hunt.js has no `var PUB = '...';` line");
  fs.writeFileSync(P.huntJs, text.replace(re, "var PUB = '" + pub + "';"));
  out('public key written to site/js/hunt.js');
}

// is any frequency live right now? (packs are opened with the current key; unreadable ones are ignored)
function anyLive() {
  const s = E.loadSecrets(root);
  const key = lib.parseSecret(s.values.HUNT_KEY || '');
  let names = [];
  try { names = fs.readdirSync(P.packDir).filter((n) => n.endsWith('.pack')); } catch (e) { return { packs: 0, live: false }; }
  let live = false;
  for (const n of names) {
    if (!key) continue;
    try {
      const env = lib.readEnvelope(fs.readFileSync(path.join(P.packDir, n), 'utf8'));
      const pack = lib.openJson(env, key, { kind: 'pack', f: env.f });
      const t = Date.now();
      if (t >= Date.parse(pack.schedule.opensAt) && t < Date.parse(pack.schedule.coldAt)) live = true;
    } catch (e) { /* not ours */ }
  }
  return { packs: names.length, live };
}

function rotate() {
  const i = argv.indexOf('--rotate');
  const name = argv[i + 1];
  if (!E.NAMES.includes(name)) E.die('rotate which? one of ' + E.NAMES.join(', '));
  const force = E.flag(argv, '--force');
  const state = anyLive();
  const why = {
    HUNT_HMAC: 'every pass in the wild, every answer check and every record key would stop working',
    HUNT_SIGN_KEY: 'every pass and certificate in the wild would stop verifying (and the public key in site/js/hunt.js changes)',
    HUNT_KEY: 'every sealed pack, backup and walkthrough would stop opening: re-seal them all',
    HUNT_SEED: 'every generated puzzle would change: only before anything is sealed'
  }[name];
  if (!force) {
    if ((name === 'HUNT_HMAC' || name === 'HUNT_SIGN_KEY') && state.live) E.die('refusing: a frequency is live. ' + why + '. Use --force if you mean it.');
    if (name === 'HUNT_SEED' && state.packs > 0) E.die('refusing: sealed packs exist. ' + why + '. Use --force if you mean it.');
    if (name === 'HUNT_KEY' && state.packs > 0) E.die('refusing: sealed packs exist. ' + why + '. Use --force if you mean it.');
  }
  const file = name === 'HUNT_SEED' ? P.sealEnv : P.serverEnv;
  const fresh = lib.newSecret();
  const had = E.scanEnvFile(file)[name] !== undefined;
  if (had) E.rewriteHuntLines(file, (n) => (n === name ? fresh : undefined)); else E.appendLine(file, name, fresh);
  out(name + ' regenerated. ' + why + '.');
}

if (E.flag(argv, '--check')) check();
else if (E.flag(argv, '--move-seed')) moveSeed();
else if (E.flag(argv, '--public')) out(keys().pubB64);
else if (E.flag(argv, '--write-pub')) writePub();
else if (E.flag(argv, '--rotate')) rotate();
else add();
