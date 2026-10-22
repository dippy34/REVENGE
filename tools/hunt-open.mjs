#!/usr/bin/env node
// hunt-open.mjs: the OWNER's walkthrough reader (docs/07-hunt.md, "The owner's walkthrough").
//
//   node tools/hunt-open.mjs <f> --set-passphrase   re-wrap the walkthrough under a passphrase only you know
//   node tools/hunt-open.mjs <f> --list             stage ids only
//   node tools/hunt-open.mjs <f> --stage s2         open ONE stage (asks for the passphrase, then your pass)
//   node tools/hunt-open.mjs <f> --restore-src [--force]   decrypt the source backup back into hunt/
//
// It needs a terminal: passphrases and passes are typed or pasted at a hidden prompt, never
// passed as arguments or environment variables, and it refuses to run without a TTY. Nothing
// in the build or seal process ever runs --stage. Opening a stage reads that stage only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from '../server/hunt-lib.mjs';
import * as E from './hunt-env.mjs';

export const MIN_PASSPHRASE = 16;
const DAY = 86400000;
void DAY;

/* ---------- pure functions (exported for the tests) ---------- */

export function readWalk(file) {
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!env || env.v !== 2 || env.kind !== 'walk' || !env.stages) throw new Error('not a walkthrough file');
  return env;
}

// the master for the file's current wrap
export function masterFor(env, huntKey, passphrase) {
  const km = lib.walkKeyMaster(huntKey, env.f);
  if (env.wrap === 'key') return km;
  if (env.wrap === 'pass') return lib.walkPassMaster(passphrase, env.kdf, km);
  throw new Error('wrap');
}

// -> a new envelope, every stage re-wrapped under the two-factor master of `newPass`
export function setPassphrase(env, huntKey, newPass, oldPass) {
  if (String(newPass).length < MIN_PASSPHRASE) throw new Error('short');
  const old = masterFor(env, huntKey, oldPass);
  const stages = {};
  for (const sid of Object.keys(env.stages)) stages[sid] = lib.unwrapStage(env, old, sid);
  const km = lib.walkKeyMaster(huntKey, env.f);
  const kdf = Object.assign({}, lib.WALK_KDF, { salt: lib.b64u.enc(crypto.randomBytes(16)) });
  return lib.wrapWalk(stages, lib.walkPassMaster(newPass, kdf, km), { f: env.f, wrap: 'pass', kdf, srcHash: env.srcHash });
}

// one stage, opened with the passphrase (refuses while the file is only key-wrapped)
export function openStage(env, huntKey, passphrase, sid) {
  if (env.wrap !== 'pass') throw new Error('unset');
  if (!env.stages[sid]) throw new Error('nostage');
  try { return lib.unwrapStage(env, masterFor(env, huntKey, passphrase), sid); } catch (e) { throw new Error('badpass'); }
}

// the lineage entry for one pass, with {{grid}} / {{givens}} rendered with the pass's own draw
export function detailFor(pack, K, passPayload, stageObj) {
  const f = pack.f;
  const L = lib.H.lineage(K.state, f, passPayload.id, pack.lineages);
  const entry = stageObj.lineages && stageObj.lineages[L];
  if (!entry) return { lineage: L, detail: '' };
  let text = String(entry.detail || '');
  const ps = pack.stages.find((s) => s.type === 'planchette');
  if (ps && /\{\{(grid|givens)\}\}/.test(text)) {
    const lin = ps.lineages[L];
    const spec = { rows: lin.pub.rows, cols: lin.pub.cols, alphabet: lin.pub.alphabet, givens: lin.sec.givens, perDay: lin.pub.perDay, latin: lin.pub.latin ? 1 : 0 };
    const iso = lin.sec.pool[lib.H.draw(K.state, f, ps.id, passPayload.id, lin.sec.pool.length)];
    text = lib.planchette.render(text, { spec, iso, grid: lib.planchette.iso(lin.sec.grid, spec, iso), givens: lib.planchette.isoGivens(lin.sec.givens, spec, iso),
      cellsSeed: lib.H.hintCells(K.state, f, ps.id, passPayload.id) });
  }
  return { lineage: L, detail: text };
}

// -> { written, skipped } counts; refuses to overwrite unless force
export function restoreSrc(env, huntKey, huntDir, force) {
  const obj = lib.openJson(env, huntKey, { kind: 'src', f: env.f });
  let written = 0, skipped = 0;
  for (const rel of Object.keys(obj.files)) {
    const dest = path.resolve(huntDir, rel);
    if (!dest.startsWith(path.resolve(huntDir) + path.sep)) throw new Error('path');
    if (fs.existsSync(dest) && !force) { skipped++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(obj.files[rel], 'base64'));
    written++;
  }
  return { written, skipped };
}

/* ---------- the terminal ---------- */

function ask(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) E.die('refusing: this needs a terminal (a TTY). Run it yourself, in a terminal.');
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1); else if (ch >= ' ') buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const f = argv[0];
  if (!f || f.startsWith('--') || !lib.F_RE.test(f)) E.die('usage: node tools/hunt-open.mjs <freq-id> --set-passphrase | --list | --stage sN | --restore-src [--force]');
  const root = E.rootOf(argv);
  const P = E.paths(root);
  const s = E.loadSecrets(root);
  const huntKey = lib.parseSecret(s.values.HUNT_KEY || '');
  const walkFile = path.join(P.packDir, f + '.walkthrough.sealed');

  if (E.flag(argv, '--list')) {
    const env = readWalk(walkFile);
    process.stdout.write(Object.keys(env.stages).sort().join('\n') + '\n');
    return;
  }
  if (!huntKey) E.die('HUNT_KEY is missing or malformed');

  if (E.flag(argv, '--restore-src')) {
    const env = lib.readEnvelope(fs.readFileSync(path.join(P.packDir, f + '.src.sealed'), 'utf8'));
    const r = restoreSrc(env, huntKey, path.join(root, 'hunt'), E.flag(argv, '--force'));
    process.stdout.write('restored ' + r.written + ' files' + (r.skipped ? ', kept ' + r.skipped + ' existing (use --force to overwrite)' : '') + '\n');
    return;
  }

  const env = readWalk(walkFile);
  if (E.flag(argv, '--set-passphrase')) {
    let oldPass = '';
    if (env.wrap === 'pass') oldPass = await ask('current passphrase (not shown): ');
    const p1 = await ask('new passphrase, at least ' + MIN_PASSPHRASE + ' characters, not shown (try four or more random words): ');
    if (p1.length < MIN_PASSPHRASE) E.die('too short: at least ' + MIN_PASSPHRASE + ' characters');
    const p2 = await ask('again: ');
    if (p1 !== p2) E.die('the two did not match; nothing changed');
    let next;
    try { next = setPassphrase(env, huntKey, p1, oldPass); } catch (e) { E.die('that is not the current passphrase; nothing changed'); }
    const tmp = walkFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n');
    fs.renameSync(tmp, walkFile);
    process.stdout.write('walkthrough locked with your passphrase. keep it: nobody, including this tool, can recover it.\n');
    return;
  }

  const sid = E.opt(argv, '--stage', '');
  if (!sid) E.die('say what to do: --set-passphrase, --list, --stage sN or --restore-src');
  if (env.wrap !== 'pass') E.die('set a passphrase first: node tools/hunt-open.mjs ' + f + ' --set-passphrase');
  if (!s.values.HUNT_HMAC) E.die('HUNT_HMAC is missing');
  const pass = await ask('passphrase (not shown): ');
  let stage;
  try { stage = openStage(env, huntKey, pass, sid); } catch (e) {
    E.die(e.message === 'nostage' ? 'no such stage' : 'that passphrase does not open this stage.');
  }
  process.stdout.write('\n' + sid + ' method:\n' + String(stage.method || '') + '\n');
  const tok = (await ask('\nyour pass for the detail (paste it; not shown; empty to skip): ')).trim();
  if (!tok) return;
  const K = lib.deriveKeys({ HUNT_KEY: s.values.HUNT_KEY, HUNT_HMAC: s.values.HUNT_HMAC, HUNT_SIGN_KEY: s.values.HUNT_SIGN_KEY || '' }, false);
  const payload = K && lib.verifyToken(tok, K.pub, { loaded: () => true, sandbox: false });
  if (!payload || payload.f !== f) E.die('that pass is not a production pass of ' + f);
  let pack;
  try { pack = lib.openJson(lib.readEnvelope(fs.readFileSync(path.join(P.packDir, f + '.pack'), 'utf8')), huntKey, { kind: 'pack', f }); } catch (e) { pack = null; }
  if (!pack) E.die('the pack is missing, so the detail cannot be matched to your pass');
  const d = detailFor(pack, K, payload, stage);
  process.stdout.write('\ndetail for your pass:\n' + d.detail + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => E.die('failed: ' + (e && e.message ? e.message : 'error')));
