// hunt-synth.mjs: builds a throwaway repo with a SYNTHETIC frequency (every word is a random
// placeholder) so the seal tool can be tested end to end. Test helper only; no real content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const LIB = pathToFileURL(path.join(here, 'hunt-lib.mjs')).href;

const FREQ = (extra) => `
export default {
  f: 'freq-91', n: 1, kind: 'frequency', title: 'synthetic', lineages: 4, rev: 1,
  schedule: { opensAt: '2030-01-07T00:00:00Z', liveDays: 28, floorDay: 8, headStartHours: 12 },
  hex: { radius: 3 }, glyphs: { carrier: 'abcdefghijklmnopqrstuvwxyz', mark: 'xyz' },
  entrance: 's0-entrance', stages: ['s1-a', 's2-b', 's3-c', 's4-p', 's5-r', 's6-m'], meta: 's6-m',
  code(ctx) { const L = 'abcdefghijklmnopqrstuvwxyz'.split(''); ctx.rng.shuffle(L); const data = L.join('');
    const map = {}; for (let i = 0; i < 26; i++) map[data[i]] = 'abcdefghijklmnopqrstuvwxyz'[i];
    return { unit: 1, order: data + '012', data, dead: '012', map }; },
  ban: { facts: ['stats'], events: [] }, say: {}, errata: [], wall: { size: 10, block: [] }, tally: null, limits: {},
  dials: { s4: { pool: 6 } }
${extra || ''}};
`;

const word = (rng, n, pre) => pre + Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz'[rng.int(20)]).join('');
const COMMON = `
const word = (rng, n, pre) => pre + Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz'[rng.int(20)]).join('');
const ok = (id) => ({ ok: true, checks: [{ id, ok: true }] });
`;
void word;

// stage plugin source for the simple reasoning types
const SIMPLE = (id, n, type, requires, packPub, packSec) => `
${COMMON}
export default {
  id: '${id}', n: ${n}, type: '${type}', title: 'stage ${n}', requires: ${JSON.stringify(requires)}, notBefore: null,
  norm: { mode: 'alnum' }, echo: { first: 1, every: 2 }, needs: [], deps: [], 
  drip: () => [{ afterDays: 2, text: 'a note for stage ${n}' }],
  generate(ctx) { const a = word(ctx.rng, 8, 'zq${n}'), w = word(ctx.rng, 8, 'zw${n}');
    return { answers: [a], warm: [w], hints: [], out: { a, lineage: ctx.lineage, mark: ctx.mark } }; },
  validate() { return ok('${id}.ok'); }, markCheck() { return ok('${id}.mark'); },
  pack(gen, ctx) { return { pub: ${packPub}, sec: ${packSec}, hints: ['look near ' + word(ctx.rng, 6, 'hn'), 'look nearer ' + word(ctx.rng, 6, 'hm'), 'look at the thing'], warm: gen.warm }; },
  walkthrough(gen) { return { method: 'method for ${id}', detail: 'the answer is ' + gen.answers[0] }; }
};
`;

export function files(opts = {}) {
  const f = {};
  f['freq.mjs'] = FREQ(opts.freqExtra);
  f['stages/s0-entrance.mjs'] = `
${COMMON}
export default { id: 's0', n: 0, type: 'entrance', title: 'entrance', deps: [],
  generate() { return { tells: { boot: { k: 'band', v: 'clear' }, ghostIntro: { k: 'band', v: 'open' }, eggs16: 'the band', ghostPill: 'band', ghostHelp: 'try the band', e404: 'try a band', tear: '~#~' },
    doorLines: ['open sesame zeta nine'], shape: ${JSON.stringify(opts.shape || '^open sesame')}, out: {} }; },
  validate() { return ok('s0.ok'); },
  walkthrough() { return { method: 'knock', detail: 'say the line' }; } };
`;
  f['stages/s1-a.mjs'] = SIMPLE('s1', 1, 'broadcast', [],
    `{ intro: ['s1 intro ' + word(ctx.rng, 8, 'in')], schedule: { offsets: [60, 600, 1200], dur: 30, slot: 60, recAfter: 10, reels: 1 }, frame: { rows: 2, cols: 8 }, glyphs: 'abcd', notes: [] }`,
    `{ reels: [['f1']], frames: { f1: { lines: [word(ctx.rng, 8, 'fa'), word(ctx.rng, 8, 'fb')] } }, degrade: { permille: 300, noise: '.' } }`);
  f['stages/s2-b.mjs'] = SIMPLE('s2', 2, 'log', ['s1'],
    `{ intro: ['s2 intro ' + word(ctx.rng, 8, 'in')], entries: [{ id: 'e1', title: 'one', lines: ['entry ' + word(ctx.rng, 8, 'en')], claims: [] }] }`, `{}`);
  f['stages/s3-c.mjs'] = SIMPLE('s3', 3, 'rooms', ['s1'],
    `{ intro: ['s3 intro ' + word(ctx.rng, 8, 'in')], index: [{ area: 'menu', text: 'room ' + word(ctx.rng, 6, 'rm') }], board: { radius: 2, given: [], blocked: [], lit: [], rules: [], read: '' } }`,
    `{ rooms: [{ area: 'menu', cond: { f: 'rm', eq: 1 }, frag: { id: 'fr', cells: [{ q: 0, r: 0, g: 'a' }] }, say: 'say ' + word(ctx.rng, 6, 'sy') }] }`);
  f['stages/s4-p.mjs'] = `
${COMMON}
import * as lib from ${JSON.stringify(LIB)};
const ALPHA = '#%&*';
const BASE = '#%&*' + '%&*#' + '&*#%' + '*#%&';
const GIVENS = [{ r: 0, c: 0, g: '#' }, { r: 1, c: 1, g: '&' }, { r: 2, c: 2, g: '#' }];
export default { id: 's4', n: 4, type: 'planchette', title: 'stage 4', requires: ['s1'], notBefore: null, norm: { mode: 'glyph', alphabet: ALPHA },
  echo: { first: 1, every: 2 }, needs: [], deps: [], drip: () => [],
  generate(ctx) {
    const spec = { rows: 4, cols: 4, alphabet: ALPHA, givens: GIVENS, perDay: 3, latin: 1 };
    const cand = [], seen = new Set();
    while (cand.length < 40) {
      const p = (n) => ctx.rng.shuffle(Array.from({ length: n }, (_, i) => i));
      const is = { t: ctx.rng.chance(500) ? 1 : 0, r: p(4), c: p(4), g: p(4).map((i) => ALPHA[i]).join('') };
      const k = JSON.stringify(is);
      if (seen.has(k) || !lib.planchette.isoOk(is, spec) || (!is.t && is.r.every((x, i) => x === i) && is.c.every((x, i) => x === i) && is.g === ALPHA)) continue;
      seen.add(k); cand.push(is);
    }
    return { answers: [], warm: [], hints: [], out: { grid: { rows: 4, cols: 4, alphabet: ALPHA, cells: BASE }, givens: GIVENS, candidates: cand, count: lib.planchette.spaceIdx(spec).n } }; },
  validate() { return ok('s4.ok'); }, markCheck() { return ok('s4.mark'); },
  pack(gen, ctx) { return { pub: { intro: ['s4 intro ' + word(ctx.rng, 8, 'in')], rows: 4, cols: 4, alphabet: ALPHA, latin: 1, rules: [], perDay: 3, silence: [], board: [] },
    sec: { grid: gen.out.grid.cells, givens: gen.out.givens, count: gen.out.count, pool: gen.out.pool },
    hints: ['try {{q:is a1 #}} first', 'look at {{cells:2}}', 'think'], warm: [] }; },
  walkthrough() { return { method: 'method for s4', detail: 'the grid is\\n{{grid}}' }; } };
`;
  f['stages/s5-r.mjs'] = `
${COMMON}
export default { id: 's5', n: 5, type: 'run', title: 'stage 5', requires: ['s4'], notBefore: null, bind: { grid: 's4' }, answers: null,
  norm: { mode: 'alnum' }, echo: { first: 1, every: 2 }, needs: ['s4'], deps: [], drip: () => [],
  accepts: () => true, poolOk: () => ${opts.poolOk === false ? 'false' : 'true'},
  generate() { return { answers: [], warm: [], hints: [], out: {} }; },
  validate() { return ok('s5.ok'); }, markCheck() { return ok('s5.mark'); },
  pack(gen, ctx) { return { pub: { intro: ['s5 intro ' + word(ctx.rng, 8, 'in')], cfg: { rings: 2, breakTicks: 3, maxTicks: 200, maxDraws: 6 }, rings: [], tickMs: { key: 40, touch: 60 }, pars: { key: 5000, touch: 9000 }, practice: 1 },
    sec: { plaus: { key: { minGapMs: 40, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 }, touch: { minGapMs: 60, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 } } }, hints: ['one', 'two', 'three'], warm: [] }; },
  walkthrough() { return { method: 'method for s5', detail: 'play' }; } };
`;
  f['stages/s6-m.mjs'] = `
${COMMON}
export default { id: 's6', n: 6, type: 'final', title: 'stage 6', requires: ['s5'], notBefore: 8, bind: { grid: 's4' }, answers: { perDay: 6 },
  norm: { mode: 'alnum' }, echo: { first: 1, every: 2 }, needs: ['s5'], deps: ['js/extra.js'], drip: () => [],
  planMarks(ctx) { const m = {}; for (const id of ['s1', 's2', 's3', 's4', 's5']) m[id] = { cell: [ctx.rng.int(3), ctx.rng.int(3)], dir: ctx.rng.int(6), glyphs: 'xyz'.slice(0, 2 + ctx.rng.int(2)) }; return m; },
  generate(ctx) { const w = word(ctx.rng, 10, 'zm'); return { answers: [w], warm: [w], hints: [], out: {} }; },
  validate() { return ok('s6.ok'); }, markCheck() { return ok('s6.mark'); },
  pack(gen, ctx) { return { pub: { intro: ['s6 intro ' + word(ctx.rng, 8, 'in')], cfg: { rings: 1, breakTicks: 0, maxTicks: 200, maxDraws: 6 }, tickMs: { key: 40, touch: 60 }, attempts: { perDay: 2, cooldownMin: 20 }, calibrate: 1, marks: [] },
    sec: { goal: { all: [] }, plaus: { key: { minGapMs: 40, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 }, touch: { minGapMs: 60, maxTurnRate: 900, minReactMs: 0, maxPerfect: 1000, maxNearMiss: 1000 } }, gloss: ['gloss'] },
    hints: ['one', 'two', 'three'], warm: gen.warm }; },
  walkthrough(gen) { return { method: 'method for s6', detail: 'say ' + gen.answers[0] }; } };
`;
  return f;
}

// -> the root of a fresh repo, ready for the seal tool (secrets created, key written to hunt.js)
export function makeRepo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-seal-'));
  const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  for (const d of ['server', 'docs', 'tools']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const js of ['eggs', 'fx', 'ghost', 'menu', 'hunt-rx', 'hunt-run']) w('site/js/' + js + '.js', '// ' + js + '\n');
  w('site/js/hunt.js', "(function () {\n  var PUB = '';\n})();\n");
  fs.copyFileSync(path.join(REPO, 'site/js/hunt-sim.js'), path.join(root, 'site/js/hunt-sim.js'));
  w('site/js/extra.js', '// a dependency\n');
  for (const h of ['index.html', '404.html', 'ghost/index.html']) w('site/' + h, '<!doctype html>\n');
  w('README.md', '# synthetic\n');
  if (!opts.noIgnore) w('.gitignore', '/hunt/\nserver/.data/\n.env\n');
  w('hunt/CONTRACT.md', 'contract\n');
  for (const [rel, text] of Object.entries(files(opts))) w('hunt/freq-91/' + rel, text);
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init', '--allow-empty'], { cwd: root });
  return root;
}
