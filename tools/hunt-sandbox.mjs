#!/usr/bin/env node
// hunt-sandbox.mjs: a local copy of the server with the hunt in sandbox mode, for playtests
// and calibration (docs/07-hunt.md, "Sandbox"). Never use it as a real server.
//
//   node tools/hunt-sandbox.mjs [--port 8095] [--speed 1] [--start 2026-10-26T00:00:00Z] [--fresh]
//
// It starts `node server/server.mjs` with HUNT_SANDBOX=1 on 127.0.0.1, its own data directory
// (server/.data/hunt-sandbox-<port>), the mock AI, a fresh admin token (written to that
// directory, mode 0600, and hidden from this tool's output) and the three runtime secrets.
// NODE_ENV, STATS_DIR, HUNT_SEED and the Anthropic key are removed from the child's environment.
// Ctrl-C stops only this tool's own child.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as lib from '../server/hunt-lib.mjs';
import * as E from './hunt-env.mjs';

const argv = process.argv.slice(2);
const root = E.rootOf(argv);
const P = E.paths(root);
const port = Number(E.opt(argv, '--port', '8095'));
const speed = Number(E.opt(argv, '--speed', '1'));
const start = E.opt(argv, '--start', '');
if (!Number.isInteger(port) || port < 1024 || port > 65535) E.die('--port must be 1024..65535');
if (!(speed >= 1 && speed <= 100000)) E.die('--speed must be 1..100000');
if (start && !Number.isFinite(Date.parse(start))) E.die('--start must be an ISO date');

const s = E.loadSecrets(root);
for (const n of E.RUNTIME) if (!lib.parseSecret(s.values[n] || '')) E.die(n + ' is missing or malformed (run: node tools/hunt-keys.mjs)');

const dataDir = path.join(root, 'server', '.data', 'hunt-sandbox-' + port);
if (E.flag(argv, '--fresh')) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const token = lib.b64u.enc(crypto.randomBytes(24));
const tokenFile = path.join(dataDir, 'admin-token');
fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);

const env = Object.assign({}, process.env);
for (const k of Object.keys(env)) if (k.startsWith('HUNT_')) delete env[k];
for (const k of ['NODE_ENV', 'STATS_DIR', 'STATS_KEY', 'ANTHROPIC_API_KEY', 'ACCESS_KEY']) delete env[k];
Object.assign(env, {
  HUNT_SANDBOX: '1', HOST: '127.0.0.1', PORT: String(port), HUNT_CLOCK_SPEED: String(speed),
  HUNT_DATA_DIR: dataDir, AI_MOCK: '1', RH_PORT: env.RH_PORT || '8082', HUNT_SANDBOX_TOKEN: token,
  HUNT_KEY: s.values.HUNT_KEY, HUNT_HMAC: s.values.HUNT_HMAC, HUNT_SIGN_KEY: s.values.HUNT_SIGN_KEY
});
if (start) env.HUNT_CLOCK_START = new Date(Date.parse(start)).toISOString();

const child = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;
const hide = (buf) => String(buf).split(token).join('<admin token: see ' + path.relative(root, tokenFile) + '>');
function forward(stream, sink) {
  let acc = '';
  stream.on('data', (d) => {
    acc += d;
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      sink.write(hide(line) + '\n');
      if (!announced && /listening on/.test(line)) {
        announced = true;
        process.stdout.write('\nsandbox ready: http://127.0.0.1:' + port + '/   (receiver: /rx/)\n' +
          'clock x' + speed + (start ? ' from ' + env.HUNT_CLOCK_START : ' from now') + '\n' +
          'admin routes (loopback + x-hunt-admin header): /api/hunt/sandbox/pass | jump | clock | info\n' +
          'admin token file: ' + path.relative(root, tokenFile) + ' (mode 0600; blind testers never get it)\n' +
          'Ctrl-C stops this sandbox only.\n');
      }
    }
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);
child.on('exit', (code, sig) => { process.exit(code == null ? (sig ? 1 : 0) : code); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } });
