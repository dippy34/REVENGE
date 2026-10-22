// hunt-env.mjs: shared by the hunt tools. Finds the repo root and reads the HUNT_ secrets
// from the environment and from env files by looking ONLY at lines that start with HUNT_.
// Nothing here prints a value, and no other line of an env file is ever returned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAMES = ['HUNT_KEY', 'HUNT_HMAC', 'HUNT_SIGN_KEY', 'HUNT_SEED'];
export const RUNTIME = ['HUNT_KEY', 'HUNT_HMAC', 'HUNT_SIGN_KEY'];
const LINE = /^(HUNT_[A-Z_]+)=(.*)$/;

const here = path.dirname(fileURLToPath(import.meta.url));

// --root <dir> (tests, other checkouts); default: the repo this file lives in
export function rootOf(argv) {
  const i = argv.indexOf('--root');
  return path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(here, '..'));
}
export const paths = (root) => ({
  root,
  serverEnv: path.join(root, 'server', '.env'),
  sealEnv: path.join(root, 'hunt', 'seal.env'),
  packDir: path.join(root, 'server', 'hunt'),
  site: path.join(root, 'site'),
  huntJs: path.join(root, 'site', 'js', 'hunt.js')
});

export function flag(argv, name) { return argv.includes(name); }
export function opt(argv, name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}

const unquote = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');

// { NAME: value } for the HUNT_ lines of one file (a missing file is empty)
export function scanEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

// Where each secret is: process environment first, then server/.env (runtime secrets)
// and hunt/seal.env (the seed). -> { values: {NAME: v}, where: {NAME: 'env'|'server/.env'|'hunt/seal.env'},
// strays: names found in a file where they do not belong (HUNT_SEED in server/.env) }
export function loadSecrets(root, env = process.env) {
  const p = paths(root);
  const se = scanEnvFile(p.serverEnv), ss = scanEnvFile(p.sealEnv);
  const values = {}, where = {}, strays = [];
  for (const n of NAMES) {
    if (env[n]) { values[n] = env[n]; where[n] = 'env'; continue; }
    if (n === 'HUNT_SEED') {
      if (ss[n]) { values[n] = ss[n]; where[n] = 'hunt/seal.env'; }
      if (se[n]) strays.push(n);
      continue;
    }
    if (se[n]) { values[n] = se[n]; where[n] = 'server/.env'; }
  }
  return { values, where, strays, seedOnlyInServerEnv: !!(se.HUNT_SEED && !ss.HUNT_SEED && !env.HUNT_SEED) };
}

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

// append NAME=value to an env file, creating it with mode 0600 (existing modes are kept)
export function appendLine(file, name, value) {
  ensureDir(file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
  if (text === null) { fs.writeFileSync(file, name + '=' + value + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600); return; }
  fs.appendFileSync(file, (text.length && !text.endsWith('\n') ? '\n' : '') + name + '=' + value + '\n');
}

// rewrite a file atomically, keeping its mode: each HUNT_ line is replaced or dropped by fn(name, value)
// (return a string to replace the value, null to drop the line, undefined to keep it)
export function rewriteHuntLines(file, fn) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { /* keep default */ }
  let changed = false;
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i].replace(/\r$/, ''));
    if (!m) { out.push(lines[i]); continue; }
    const r = fn(m[1], unquote(m[2]));
    if (r === undefined) out.push(lines[i]);
    else if (r === null) changed = true;
    else { out.push(m[1] + '=' + r); changed = true; }
  }
  if (!changed) return false;
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, out.join('\n'), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return true;
}

export function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }
