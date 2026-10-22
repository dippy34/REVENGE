// hunt-pack.mjs: the schema check for a decrypted pack (CONTRACT 6). Pure: no I/O, no secrets.
// Used by the engine when it loads a pack and by the seal tool before it writes one. Every
// message is a short generic reason; no content ever appears in it.
import * as lib from './hunt-lib.mjs';

const { F_RE } = lib;
const DAY = 86400000;
const TYPES = ['broadcast', 'log', 'rooms', 'planchette', 'run', 'final'];
const isInt = (x) => Number.isSafeInteger(x);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const hex32 = (x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
const isoMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN);

/* ---------- pack checks (no content in any message) ---------- */

const PRINTABLE = /^[\x20-\x7e]*$/;
const isStr = (x, max) => typeof x === 'string' && x.length <= max;
const hexList = (a) => Array.isArray(a) && a.length <= 4096 && a.every(hex32);
const TELL_KEYS = ['boot', 'ghostIntro', 'eggs16', 'ghostPill', 'ghostHelp', 'e404', 'tear'];

function tellsOk(t) {
  if (t == null) return true;
  if (!isObj(t)) return false;
  for (const k of TELL_KEYS) {
    const v = t[k];
    if (v === undefined) continue;
    if (k === 'boot' || k === 'ghostIntro') {
      if (!isObj(v) || !isStr(v.k, 64) || !isStr(v.v, 64) || !PRINTABLE.test(v.k + v.v)) return false;
    } else if (!isStr(v, 64) || !PRINTABLE.test(v)) return false;
  }
  return true;
}

// Returns null when the pack is usable, else a short generic reason (never any content).
export function validatePack(p) {
  if (!isObj(p) || p.v !== 1) return 'shape';
  if (!isStr(p.f, 16) || !F_RE.test(p.f)) return 'id';
  if (!isInt(p.n) || p.n < 0 || (p.kind !== 'frequency' && p.kind !== 'interlude')) return 'kind';
  if (!isStr(p.title, 64) || !isInt(p.rev) || !isInt(p.lineages) || p.lineages < 4 || p.lineages > 8) return 'header';
  const s = p.schedule;
  if (!isObj(s)) return 'schedule';
  const o = isoMs(s.opensAt), c = isoMs(s.coldAt);
  if (!(o > 0) || !(c > o) || o % DAY !== 0) return 'dates';
  if (!(s.floorDay === null || (isInt(s.floorDay) && s.floorDay >= 0)) || !isInt(s.headStartHours) || s.headStartHours < 0 || s.headStartHours > 72) return 'schedule';
  const pub = p.public;
  if (!isObj(pub) || !tellsOk(pub.tells)) return 'public';
  if (!isObj(pub.door) || !isStr(pub.door.shape, 200)) return 'door';
  try { new RegExp(pub.door.shape); } catch (e) { return 'door'; }
  if (pub.say !== undefined && !(isObj(pub.say) && Object.values(pub.say).every((x) => isStr(x, 160)))) return 'say';
  if (!Array.isArray(pub.errata) || !pub.errata.every((e) => isObj(e) && isInt(e.fromDay) && isStr(e.text, 400))) return 'errata';
  if (!isObj(pub.wall) || !isInt(pub.wall.size) || pub.wall.size < 0 || pub.wall.size > 100) return 'wall';
  if (pub.tally !== null && !(isObj(pub.tally) && Array.isArray(pub.tally.options) &&
      pub.tally.options.every((x) => isObj(x) && isStr(x.id, 16) && /^[a-z0-9_-]+$/.test(x.id) && isStr(x.text, 80)))) return 'tally';
  if (!isObj(p.door) || !hexList(p.door.hmac)) return 'door';
  if (!isObj(p.limits) || !isObj(p.wall) || !Array.isArray(p.wall.block) || !p.wall.block.every((x) => /^[A-Z]{3}$/.test(x))) return 'limits';
  if (!isObj(p.frozen) || !Object.entries(p.frozen).every(([k, v]) => isStr(k, 200) && /^[0-9a-f]{64}$/.test(v))) return 'frozen';
  if (!Array.isArray(p.stages) || p.stages.length < 1 || p.stages.length > 9) return 'stages';
  let size = 0;
  for (let i = 0; i < p.stages.length; i++) {
    const st = p.stages[i];
    const id = 's' + (i + 1);
    if (!isObj(st) || st.id !== id || st.n !== i + 1 || !TYPES.includes(st.type) || !isStr(st.title, 80)) return 'stage ' + id;
    if (!Array.isArray(st.requires) || !st.requires.every((r) => typeof r === 'string' && p.stages.findIndex((x) => x.id === r) >= 0 && r < id)) return 'requires ' + id;
    if (!(st.notBefore === null || (isInt(st.notBefore) && st.notBefore >= 0))) return 'notBefore ' + id;
    if (!isObj(st.norm) || !lib.NORM_MODES.includes(st.norm.mode) || (st.norm.mode === 'glyph' && !isStr(st.norm.alphabet, 16))) return 'norm ' + id;
    if (!isObj(st.echo) || !isInt(st.echo.first) || !isInt(st.echo.every) || st.echo.first < 0 || st.echo.every < 1) return 'echo ' + id;
    if (!(st.answers === null || (isObj(st.answers) && isInt(st.answers.perDay) && st.answers.perDay >= 1 && st.answers.perDay <= 200))) return 'answers ' + id;
    if (st.foreign !== 0 && st.foreign !== 1) return 'foreign ' + id;
    if (!(st.bind === null || (isObj(st.bind) && typeof st.bind.grid === 'string' && p.stages.some((x) => x.id === st.bind.grid && x.type === 'planchette')))) return 'bind ' + id;
    if (!Array.isArray(st.drip) || !st.drip.every((d) => isObj(d) && isInt(d.afterDays) && isStr(d.text, 400))) return 'drip ' + id;
    if (!Array.isArray(st.lineages) || st.lineages.length !== p.lineages) return 'lineages ' + id;
    for (const L of st.lineages) {
      if (!isObj(L) || !isObj(L.pub) || !isObj(L.sec) || !hexList(L.ans) || !hexList(L.warm)) return 'lineage ' + id;
      if (!Array.isArray(L.hints) || L.hints.length !== 3 || !L.hints.every((h) => isStr(h, 600))) return 'hints ' + id;
      const len = JSON.stringify(L.pub).length;
      size += len + JSON.stringify(L.sec).length;
      if (len > 262144) return 'size ' + id;
      if (st.type === 'planchette') {
        const r = planchetteOk(L, st);
        if (r) return r + ' ' + id;
      }
    }
  }
  if (size > 4194304) return 'size';
  return null;
}

function planchetteOk(L, st) {
  const pub = L.pub, sec = L.sec;
  if (!isInt(pub.rows) || !isInt(pub.cols) || !isStr(pub.alphabet, 16) || !isInt(pub.perDay) || pub.perDay < 1 || pub.perDay > 50) return 'planchette';
  if (typeof sec.grid !== 'string' || sec.grid.length !== pub.rows * pub.cols || !isInt(sec.count) || !Array.isArray(sec.givens) || !Array.isArray(sec.pool)) return 'planchette';
  if (sec.pool.length < 1 || sec.pool.length > 1024) return 'planchette';
  const spec = specOf(L);
  if (!lib.planchette.specOk(spec)) return 'planchette';
  for (const g of sec.givens) if (!isObj(g) || !isInt(g.r) || !isInt(g.c) || typeof g.g !== 'string') return 'planchette';
  for (const is of sec.pool) if (!lib.planchette.isoOk(is, spec)) return 'planchette';
  return null;
}

// the planchette spec of one lineage (the BASE grid's givens; the engine maps them per pass)
export function specOf(L) {
  return { rows: L.pub.rows, cols: L.pub.cols, alphabet: L.pub.alphabet, givens: L.sec.givens, perDay: L.pub.perDay, latin: L.pub.latin ? 1 : 0 };
}

