// hunt-checks.mjs: the seal tool's global checks (CONTRACT 14.2.1-14.2.3). Pure functions plus the
// repo scan. Reports carry check ids, stage ids, lineage numbers and counts: never content.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as lib from '../server/hunt-lib.mjs';
import * as kit from './hunt-kit.mjs';

export const DIGEST = '631cb8a9';
export const REASONING = ['broadcast', 'log', 'rooms', 'planchette', 'final'];
// words the /ghost/ page already uses for its states: engine lines and tells must not reuse them
export const GHOST_WORDS = ['tuning', 'no signal', 'weak signal', 'signal weak', 'asleep', 'awake', 'speaking', 'thinking', 'listening'];
const TELL_KEYS = ['boot', 'ghostIntro', 'eggs16', 'ghostPill', 'ghostHelp', 'e404', 'tear'];
const PRINTABLE = /^[\x20-\x7e]*$/;
const PLAIN = /^[A-Za-z0-9 .,:;'!?_-]+$/;

export const C = kit.check;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sha256file = (file) => { try { return sha(fs.readFileSync(file)); } catch (e) { return null; } };

// every string leaf of a value: cb(pathString, text)
export function strings(v, cb, p = '') {
  if (typeof v === 'string') cb(p, v);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, cb, p + '[' + i + ']'));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) strings(v[k], cb, p ? p + '.' + k : k);
}

/* ---------- tells and the door ---------- */

export function tellsChecks(tells) {
  const out = [];
  const have = TELL_KEYS.every((k) => tells && tells[k] !== undefined);
  out.push(C('tells.present', have, 'all seven surfaces', TELL_KEYS.length));
  if (!have) return out;
  const all = [];
  for (const k of TELL_KEYS) {
    const v = tells[k];
    const parts = k === 'boot' || k === 'ghostIntro' ? [v.k, v.v] : [v];
    for (const s of parts) all.push({ k, s: String(s) });
  }
  out.push(C('tells.length', all.every((x) => x.s.length >= 1 && x.s.length <= 64 && PRINTABLE.test(x.s)), 'at most 64 printable ASCII characters each'));
  const plain = new Set(all.filter((x) => PLAIN.test(x.s)).map((x) => x.k));
  out.push(C('tells.plain', plain.size >= 4, 'at least four plain-text surfaces', plain.size));
  const low = all.map((x) => x.s.toLowerCase()).join(' | ');
  out.push(C('tells.vocabulary', !GHOST_WORDS.some((w) => low.includes(w)), 'no reuse of the ghost page\'s state words'));
  return out;
}

// the door shape must accept every door line and none of the lines the console already handles
export function doorChecks(shape, lines) {
  const out = [];
  let re = null;
  try { re = new RegExp(shape); } catch (e) { re = null; }
  out.push(C('door.shape', !!re, 'the shape is a valid pattern'));
  if (!re) return out;
  out.push(C('door.accepts', lines.length > 0 && lines.every((l) => re.test(l)), 'matches every accepted line', lines.length));
  const known = [];
  const F = lib.facts;
  for (const c of F.CMDS) {
    known.push(c);
    for (const a of (F.CMD_ARGS && F.CMD_ARGS[c]) || []) known.push(c + ' ' + a);
  }
  for (const t of F.TINTS) known.push('tint ' + t);
  for (const t of F.TIERS) known.push('fx ' + t);
  known.push('rm -rf /', 'echo hello', 'cd games', 'ls -a', DIGEST, 'hello', 'matrix');
  out.push(C('door.collisions', !known.some((l) => re.test(l)), 'matches no existing console line', known.length));
  return out;
}

/* ---------- schedule ---------- */

export function scheduleChecks(pack, liveDays) {
  const out = [];
  const bad = [];
  const days = (p, v) => { if (!Number.isInteger(v) || v < 0 || v >= liveDays) bad.push(p); };
  const s = pack.schedule;
  if (s.floorDay !== null) days('floorDay', s.floorDay);
  for (const e of pack.public.errata) if (e.fromDay >= liveDays) bad.push('errata');
  for (const st of pack.stages) {
    if (st.notBefore !== null) days(st.id + '.notBefore', st.notBefore);
    for (const d of st.drip) days(st.id + '.drip', d.afterDays);
    for (let L = 0; L < st.lineages.length; L++) {
      strings(st.lineages[L].pub, () => {});
      const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          if ('$day' in v) days(st.id + '.$day', v.$day);
          if ('$rel' in v) days(st.id + '.$rel', v.$rel);
          Object.values(v).forEach(walk);
        }
      };
      walk(st.lineages[L].pub);
    }
  }
  out.push(C('schedule.inside', bad.length === 0, 'every day value falls inside the live period', bad.length));
  return out;
}

/* ---------- the stage graph ---------- */

export function chainChecks(stages) {
  const out = [];
  const byId = new Map(stages.map((s) => [s.id, s]));
  let ok = true;
  for (const s of stages) for (const r of s.requires) if (!byId.has(r) || byId.get(r).n >= s.n) ok = false;
  out.push(C('chain.acyclic', ok, 'requirements point at earlier stages'));
  // reachable from the door: every stage has a path of requirements ending at a stage with none
  const reach = (s, seen = new Set()) => (seen.has(s.id) ? true : (seen.add(s.id), s.requires.length === 0 || s.requires.every((r) => byId.get(r) && reach(byId.get(r), seen))));
  out.push(C('chain.reachable', stages.every((s) => reach(s)), 'every stage is reachable from the door'));
  const needs = (s, id, seen = new Set()) => (s.requires.includes(id) || s.requires.some((r) => !seen.has(r) && byId.get(r) && (seen.add(r), needs(byId.get(r), id, seen))));
  const binds = stages.filter((s) => s.bind);
  out.push(C('chain.bind', binds.every((s) => byId.get(s.bind.grid) && byId.get(s.bind.grid).type === 'planchette' && needs(s, s.bind.grid)),
    'every bind names a planchette stage the binding stage requires', binds.length));
  return out;
}

/* ---------- answers, warm forms and hints (per generated lineage) ---------- */
// stages: [{ id, type, norm, lineages: [{ answers: [string], warm: [string], hints: [string], drawn?: [gridString] }] }]
export function answerChecks(stages, common) {
  const out = [];
  const words = common || kit.COMMON || new Set();
  const nn = (st, t) => lib.normStage(t, st.norm);
  for (const st of stages) {
    if (!REASONING.includes(st.type)) continue;
    const seen = new Map();
    let distinct = true, long = true, rare = true, any = true;
    st.lineages.forEach((lin, L) => {
      const forms = st.type === 'final' ? lin.warm : lin.answers;
      if (!forms || !forms.length) { any = false; return; }
      for (const raw of forms) {
        const n = nn(st, raw);
        if (!n || (n.length < 6 && st.type !== 'planchette')) long = false;
        if (words.has(n)) rare = false;
        if (seen.has(n) && seen.get(n) !== L) distinct = false;
        seen.set(n, L);
      }
    });
    out.push(C('answers.present', any, st.id, st.lineages.length));
    out.push(C('answers.distinct', distinct, st.id + ': distinct across lineages'));
    out.push(C('answers.long', long, st.id + ': at least 6 characters'));
    out.push(C('answers.common', rare, st.id + ': not a common word on its own'));
  }
  // no answer equals another stage's answer or any warm form (within one lineage; planchette grids excluded)
  const L = stages.length ? stages[0].lineages.length : 0;
  let collide = false;
  for (let l = 0; l < L; l++) {
    const all = new Map();
    for (const st of stages) {
      const forms = [...(st.lineages[l].answers || []), ...(st.lineages[l].warm || [])];
      for (const raw of forms) {
        const n = nn(st, raw);
        if (!n || st.type === 'planchette') continue;
        if (all.has(n) && all.get(n) !== st.id) collide = true;
        all.set(n, st.id);
      }
    }
  }
  out.push(C('answers.collisions', !collide, 'no answer or warm form is shared between stages'));
  return out;
}

export function hintChecks(stages) {
  const out = [];
  for (const st of stages) {
    let three = true, clean = true;
    st.lineages.forEach((lin) => {
      if (!Array.isArray(lin.hints) || lin.hints.length !== 3) three = false;
      const forms = [...(lin.answers || []), ...(lin.warm || [])].map((a) => lib.normStage(a, st.norm)).filter((n) => n.length >= 4);
      const texts = st.type === 'planchette' ? (lin.renderedHints || []) : (lin.hints || []);
      for (const h of texts) {
        const nh = lib.normStage(h, st.norm);
        if (forms.some((f) => nh.includes(f))) clean = false;
      }
    });
    out.push(C('hints.three', three, st.id + ': three tiers per lineage'));
    out.push(C('hints.clean', clean, st.id + ': no hint contains the answer'));
  }
  return out;
}

// planchette hint placeholders use only the allowed forms (CONTRACT 10.6)
export function placeholderChecks(stages) {
  const out = [];
  for (const st of stages) {
    if (st.type !== 'planchette') continue;
    let ok = true;
    for (const lin of st.lineages) for (const h of lin.hints || []) {
      for (const m of String(h).matchAll(/\{\{([a-z]+)(?::([^}]*))?\}\}/g)) {
        if (m[1] === 'cells') { if (!/^\d+$/.test(m[2] || '')) ok = false; }
        else if (m[1] === 'q') { if (!/^(is |count )/.test(m[2] || '')) ok = false; }
        else ok = false;
      }
    }
    out.push(C('placeholders.allowed', ok, st.id + ': only {{q:...}} (not order) and {{cells:n}}'));
  }
  return out;
}

/* ---------- repo hygiene (read-only git) ---------- */

export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
export function hygieneChecks(root, f) {
  const out = [];
  const a = git(root, ['check-ignore', '-q', 'hunt/CONTRACT.md']);
  out.push(C('repo.private-ignored', a.code === 0, 'hunt/ is gitignored (fix .gitignore)'));
  const b = git(root, ['check-ignore', '-q', 'server/hunt/' + f + '.pack']);
  out.push(C('repo.sealed-tracked', b.code === 1, 'server/hunt/ is not ignored, so sealed files can be committed'));
  const e = git(root, ['check-ignore', '-q', 'server/.env']);
  out.push(C('repo.env-ignored', e.code === 0, 'server/.env is gitignored'));
  return out;
}

/* ---------- the pack against an earlier one (errata safety, 14.2.3) ---------- */

const PLUGIN_LEVEL = ['id', 'n', 'type', 'title', 'requires', 'notBefore', 'norm', 'echo', 'answers', 'foreign', 'bind', 'drip'];
export function differences(next, old, allow) {
  const changed = new Set();
  const byId = new Map(old.stages.map((s) => [s.id, s]));
  for (const st of next.stages) {
    const o = byId.get(st.id);
    if (!o) { changed.add(st.id); continue; }
    for (const k of PLUGIN_LEVEL) if (lib.canon(st[k]) !== lib.canon(o[k])) changed.add(st.id);
    if (st.lineages.length !== o.lineages.length) changed.add(st.id);
    else for (let L = 0; L < st.lineages.length; L++) {
      for (const k of ['pub', 'sec', 'ans', 'warm', 'hints']) if (lib.canon(st.lineages[L][k]) !== lib.canon(o.lineages[L][k])) changed.add(st.id);
    }
  }
  for (const o of old.stages) if (!next.stages.some((s) => s.id === o.id)) changed.add(o.id);
  for (const k of ['f', 'n', 'kind', 'title', 'lineages']) if (lib.canon(next[k]) !== lib.canon(old[k])) changed.add('(' + k + ')');
  for (const k of ['schedule', 'door', 'wall']) if (lib.canon(next[k]) !== lib.canon(old[k])) changed.add('(' + k + ')');
  if (lib.canon(next.public && { ...next.public, errata: 0 }) !== lib.canon(old.public && { ...old.public, errata: 0 })) changed.add('(public)');
  return Array.from(changed).filter((x) => !allow.has(x)).sort();
}

/* ---------- the leak scan (14.2.2) ---------- */

// words the scan must find nowhere outside the sealed files: [{ s: lowercase string, cat, mode: 'sub'|'word' }]
// the engine's own vocabulary and plain common words say nothing about content, so they are not leak terms
// (fact keys, event codes and the sim's end causes too: room conditions and goals are written in them)
let VOCAB = null;
function vocabulary() {
  if (VOCAB) return VOCAB;
  const F = lib.facts;
  const v = new Set(['broadcast', 'log', 'rooms', 'planchette', 'run', 'final']);
  for (const k of ['AREAS', 'TINTS', 'TIERS', 'EGGS', 'CMDS', 'ROUTES', 'CLASSES', 'GVIA', 'GHOST_CMDS', 'FACT_KEYS', 'CODES']) for (const x of F[k] || []) v.add(String(x).toLowerCase());
  try {
    const sim = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'js', 'hunt-sim.js'));
    for (const x of (sim._ && sim._.CAUSES) || []) if (x) v.add(String(x).toLowerCase());
  } catch (e) { /* no sim: its words stay leak terms */ }
  VOCAB = v;
  return v;
}
// Strings in a stage's own pub/sec that carry no content: a run of the site's public glyph sets
// (an alphabet such as "#%&*+") and filler patterns of at most two symbols ("......", "#..#").
const GLYPH_RUNS = [kit.GLYPHS.hex, kit.GLYPHS.sym, kit.GLYPHS.hex + kit.GLYPHS.sym];
const STRUCTURAL = new Set(['content', 'public']);
function structuralOnly(t) {
  if (GLYPH_RUNS.some((g) => g.includes(t))) return true;
  return !/[a-z0-9]/.test(t) && new Set(t).size <= 2;
}
export function leakTerms(items, secrets) {
  const out = new Map();
  const vocab = vocabulary();
  const common = kit.COMMON || new Set();
  const add = (s, cat) => {
    const t = String(s).toLowerCase();
    if (t.length < 4) return;
    if (!cat.startsWith('secret:') && (vocab.has(t) || (/^[a-z]+$/.test(t) && common.has(t)))) return;
    if (STRUCTURAL.has(cat) && structuralOnly(t)) return;
    const key = t;
    if (!out.has(key)) out.set(key, { s: t, cat, word: t.length < 6 });
  };
  for (const { text, cat, norm } of items) {
    if (typeof text !== 'string') continue;
    add(text, cat);
    if (norm && /[a-z0-9]/i.test(text)) {
      const n = lib.norm(text, 'alnum');
      if (n.length >= 6 && n !== text.toLowerCase()) out.set('n:' + n, { s: n, cat, word: false, normalised: true });
    }
  }
  for (const [name, v] of Object.entries(secrets)) {
    if (!v) continue;
    add(v, 'secret:' + name);
    try { const b = lib.parseSecret(v); if (b) { add(b.toString('hex'), 'secret:' + name); add(b.toString('base64'), 'secret:' + name); } } catch (e) { /* skip */ }
  }
  return Array.from(out.values());
}

class Index {
  constructor(terms) {
    this.by = new Map();
    for (const t of terms) {
      const k = t.s.slice(0, 4);
      if (!this.by.has(k)) this.by.set(k, []);
      this.by.get(k).push(t);
    }
  }
  // the categories found in one line
  scan(line) {
    const low = line.toLowerCase();
    const found = new Set();
    const norm = lib.norm(line, 'alnum');
    for (const [text, normalised] of [[low, false], [norm, true]]) {
      for (let i = 0; i + 4 <= text.length; i++) {
        const c = this.by.get(text.slice(i, i + 4));
        if (!c) continue;
        for (const t of c) {
          if (!!t.normalised !== normalised) continue;
          if (!text.startsWith(t.s, i)) continue;
          if (t.word) {
            const before = i === 0 ? '' : text[i - 1], after = text[i + t.s.length] || '';
            if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
          }
          found.add(t.cat);
        }
      }
    }
    return found;
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.data', '.cache']);
function walkFiles(dir, out, skip) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.isFile() && (e.name === '.env' || e.name.startsWith('.env.local'))) continue;   // the gitignored secrets file
    const p = path.join(dir, e.name);
    if (skip && skip(p, e)) continue;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(p, out, skip); } else if (e.isFile()) out.push(p);
  }
}
function textOf(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  if (buf.length > 8 * 1024 * 1024) return null;
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

// -> [{ where: 'path:line' | 'commit abc1234', cat }]  (never the matched text)
export function scanRepo(root, terms, opts = {}) {
  const idx = new Index(terms);
  const hits = [];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const files = [];
  for (const d of ['site', 'server', 'tools', 'docs', '.github']) {
    walkFiles(path.join(root, d), files, (p, e) => {
      const r = rel(p);
      if (d === 'server' && (r === 'server/hunt' || r.startsWith('server/hunt/')) && /\.(pack|sealed)$|\.gitkeep$/.test(r)) return true;
      return false;
    });
  }
  files.push(path.join(root, 'README.md'));
  for (const f of files) {
    const text = textOf(f);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) for (const cat of idx.scan(lines[i])) hits.push({ where: rel(f) + ':' + (i + 1), cat });
  }
  // the ghost's prompt is plain text inside ai.mjs; it was scanned above with server/
  if (opts.git !== false) {
    for (const [label, args] of [['git diff', ['diff']], ['git diff --cached', ['diff', '--cached']], ['git log', ['log', '-p', 'main..HEAD']]]) {
      const g = git(root, args);
      if (g.code !== 0 && label === 'git log') continue;
      let commit = '';
      for (const line of g.out.split('\n')) {
        const m = /^commit ([0-9a-f]{7})/.exec(line);
        if (m) commit = m[1];
        if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) continue;
        for (const cat of idx.scan(line.slice(1))) hits.push({ where: label + (commit ? ' ' + commit : ''), cat });
      }
    }
    const u = git(root, ['ls-files', '--others', '--exclude-standard']);
    for (const f of u.out.split('\n').filter(Boolean)) for (const cat of idx.scan(f)) hits.push({ where: 'untracked path ' + f, cat });
  }
  return hits;
}

// the internal name nowhere in site/, and nothing in the pack that pairs the digest with a hash name
export function nameChecks(root, pack) {
  const out = [];
  const files = [];
  walkFiles(path.join(root, 'site'), files);
  let n = 0;
  for (const f of files) { const t = textOf(f); if (t && /revenge/i.test(t)) n++; }
  out.push(C('name.site', n === 0, 'the internal name appears nowhere in site/', n));
  let bad = 0;
  const visit = (_, s) => { if (/revenge/i.test(s) || (s.toLowerCase().includes(DIGEST) && /sha-?\d*|md5|hash/i.test(s))) bad++; };
  strings(pack.public, visit);
  for (const st of pack.stages) for (const lin of st.lineages) strings(lin.pub, visit);
  out.push(C('name.pack', bad === 0, 'no public string names the site or pairs the digest with a hash', bad));
  return out;
}
