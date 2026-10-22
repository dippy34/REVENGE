// hunt-kit.mjs: the generator kit for the signal's content plugins (docs/07-hunt.md).
//
// Public and generic: a seeded random stream, hex-board geometry, the font-safe glyph
// sets, report helpers, a common-word test used to reject weak answers, and two
// obviously synthetic development stubs. It holds no content. Plugins and the seal
// tool import it; the server never does (server/hunt-lib.mjs carries its own copy of
// the random stream, and a test proves the two agree).
//
// COMMON is built when this module loads, from the dictionary files of the machine
// that runs it (HUNT_DICT, else /usr/share/dict). It is a frequency sample, not a
// shipped list: a word counts as common when it is a component of several compound
// entries of the dictionary's compound list, plus the dictionary's connectives.
// Without those files it is empty and COMMON_INFO.size is 0 (the seal warns).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sub(seed, ...labels) {             // seed: Buffer; returns a 32-byte Buffer
  return crypto.createHmac('sha256', seed).update(labels.join('|')).digest();
}
export function rng(buf) {                          // sfc32 over the first 16 bytes (LE words)
  let a = buf.readUInt32LE(0), b = buf.readUInt32LE(4), c = buf.readUInt32LE(8), d = buf.readUInt32LE(12);
  function u32() {
    const t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const t = (t0 + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  }
  for (let i = 0; i < 12; i++) u32();
  const api = {
    u32,
    int(n) { if (n < 1 || n > 2 ** 32) throw new Error('range'); const lim = 2 ** 32 - (2 ** 32 % n); let x; do x = u32(); while (x >= lim); return x % n; },
    chance(permille) { return api.int(1000) < permille; },
    pick(arr) { return arr[api.int(arr.length)]; },
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = api.int(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
    fork(label) { const out = Buffer.alloc(16); for (let i = 0; i < 4; i++) out.writeUInt32LE(u32(), i * 4); return rng(sub(out, label)); }
  };
  return api;
}
export function stream(seed, ...labels) { return rng(sub(seed, ...labels)); }
export const hex = {
  DIRS: [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]],   // axial (q, r); 0 = east, counter-clockwise
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  scale: (a, k) => [a[0] * k, a[1] * k],
  rot: (a, n) => { let [q, r] = a; for (let i = 0; i < ((n % 6) + 6) % 6; i++) [q, r] = [q + r, -q]; return [q, r]; },  // 60 degrees CCW per step
  dist: (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[0] + a[1] - b[0] - b[1]) + Math.abs(a[1] - b[1])) / 2,
  inside: (a, radius) => hex.dist(a, [0, 0]) <= radius,
  key: (a) => a[0] + ',' + a[1],
  ring(k) { if (k === 0) return [[0, 0]]; const out = []; let c = hex.scale(hex.DIRS[4], k);
            for (let i = 0; i < 6; i++) for (let j = 0; j < k; j++) { out.push(c); c = hex.add(c, hex.DIRS[i]); } return out; },
  spiral(radius) { let out = []; for (let k = 0; k <= radius; k++) out = out.concat(hex.ring(k)); return out; },
  line(a, dir, n) { const out = []; let c = a; for (let i = 0; i < n; i++) { out.push(c); c = hex.add(c, hex.DIRS[dir]); } return out; }
};
export const GLYPHS = { hex: '0123456789abcdef', sym: '#%&*+=<>/\\|_-:;' };   // the font-safe sets fx.js uses
export function check(id, ok, note, n) { return { id, ok: !!ok, note, n }; }
export function report(checks) { return { ok: checks.every((c) => c.ok), checks }; }

/* ---------- the common-word sample ---------- */

// Rules (generic): lowercase a-z entries of the main word list, 2 to 12 letters, that
// occur as a separate component in at least MIN_PARTS entries of the compound list;
// plus every lowercase single word of the connectives list.
const MIN_PARTS = 5;
function buildCommon() {
  const dir = process.env.HUNT_DICT || '/usr/share/dict';
  const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { return null; } };
  const main = read('web2') || read('words');
  const compounds = read('web2a');
  const out = new Set();
  if (main) {
    const known = new Set();
    for (const w of main.split('\n')) if (/^[a-z]{2,12}$/.test(w)) known.add(w);
    if (compounds) {
      const parts = new Map();
      for (const line of compounds.split('\n')) {
        const seen = new Set();
        for (const p of line.toLowerCase().split(/[^a-z]+/)) {
          if (!p || seen.has(p) || !known.has(p)) continue;
          seen.add(p);
          parts.set(p, (parts.get(p) || 0) + 1);
        }
      }
      for (const [w, n] of parts) if (n >= MIN_PARTS) out.add(w);
    }
    const conn = read('connectives');
    if (conn) for (const w of conn.split('\n')) if (/^[a-z]{2,12}$/.test(w.trim())) out.add(w.trim());
  }
  const sorted = Array.from(out).sort();
  const hash = crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
  return { set: new Set(sorted), info: { source: main ? dir : null, size: sorted.length, hash } };
}
const built = buildCommon();
export const COMMON = built.set;
export const COMMON_INFO = built.info;

/* ---------- development stubs (never valid in a real seal) ---------- */

// A fixed, obviously synthetic code over GLYPHS.hex + GLYPHS.sym: the legend is the two
// sets in order, the first 26 are data glyphs mapped to 'a'..'z' in order, the last five
// are dead air. The seal fails when a manifest's code equals this.
export function demoCode() {
  const order = GLYPHS.hex + GLYPHS.sym;
  const data = order.slice(0, 26);
  const dead = order.slice(26);
  const map = {};
  for (let i = 0; i < 26; i++) map[data[i]] = String.fromCharCode(97 + i);
  return { unit: 1, order, data, dead, map };
}

// Five fixed marks inside a radius-r board (r >= 2), pairwise disjoint, glyphs from
// GLYPHS.sym. The seal fails when a lineage's planned marks equal these.
export function demoMarks(radius) {
  const r = Math.max(2, radius | 0);
  return {
    s1: { cell: [-r, 0], dir: 0, glyphs: '#%&' },
    s2: { cell: [0, -r], dir: 5, glyphs: '*+' },
    s3: { cell: [r, -r], dir: 4, glyphs: '=<' },
    s4: { cell: [0, r], dir: 3, glyphs: '>/' },
    s5: { cell: [r, 0], dir: 2, glyphs: '|_' }
  };
}
