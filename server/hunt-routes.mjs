// hunt-routes.mjs: the player-facing routes of the engine (CONTRACT 8.1-8.5, 8.10-8.12, 8.15).
// Everything here is generic; every word, answer and datum comes from the pack.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './hunt-lib.mjs';

const { H } = lib;
const DAY = 86400000;
const isInt = (x) => Number.isSafeInteger(x);
const STAGE_RE = /^s[1-9]$/;

// per-address limit for a group: the address ceiling, and a network ceiling four times higher
export function addrLimit(group, limitOf, windowMs) {
  return (X, a) => {
    const n = limitOf(X.LIM);
    return X.hit('i|' + group + '|' + a.ip, n, windowMs) || X.hit('n|' + group + '|' + a.net, n * 4, windowMs);
  };
}
export const readPass = (X, c) => X.hit('p|read|' + c.rk, c.P.lim.read.passPerMin, 60000);

function hasHash(list, h) {
  let ok = false;
  const hb = Buffer.from(h);
  for (const x of list) {
    const xb = Buffer.from(x);
    if (xb.length === hb.length && crypto.timingSafeEqual(xb, hb)) ok = true;
  }
  return ok;
}

export function newestLive(X, t) {
  let best = null;
  for (const P of X.packs.values()) if (X.phaseOf(P, t) === 'live' && (!best || P.openMs > best.openMs)) best = P;
  return best;
}

export function installRoutes(X) {
  const R = X.routes;
  const { K, lib: L } = X;

  /* ----- status (8.1) ----- */
  R['status'] = {
    methods: ['GET', 'POST'],
    addr: addrLimit('status', (lim) => lim.status.ipPerMin, 60000),
    fn(X, c, b) {
      const t = X.now();
      const cert = b && typeof b.cert === 'string' ? X.verifyCert(b.cert) : null;
      const live = [], cold = [], early = [];
      let next = null;
      for (const P of X.packs.values()) {
        const ph = X.phaseOf(P, t);
        if (ph === 'live') live.push(P);
        else if (ph === 'cold') cold.push(P);
        else {
          if (!next || P.openMs < next.openMs) next = P;
          const hs = P.pack.schedule.headStartHours * 3600000;
          if (cert && cert.kind === 'frequency' && !cert.late && cert.n === P.n - 1 && hs > 0 && t >= P.openMs - hs) early.push(P);
        }
      }
      const entry = (P, e) => ({ f: P.f, n: P.n, kind: P.kind, title: P.pack.title, opensAt: P.pack.schedule.opensAt,
        coldAt: P.pack.schedule.coldAt, day: X.dayOf(P, t), floorDay: P.pack.schedule.floorDay, early: !!e });
      const out = { v: 1, on: true, now: t, sandbox: X.sandbox,
        live: live.map((P) => entry(P, false)).concat(early.map((P) => entry(P, true))),
        next: next ? { f: next.f, n: next.n, opensAt: next.pack.schedule.opensAt, headStartHours: next.pack.schedule.headStartHours } : null,
        cold: cold.map((P) => {
          const F = X.fstate(P);
          let walk = false;
          try { walk = fs.existsSync(path.join(X.packDir, P.f + '.walk-public.sealed')); } catch (e) { walk = false; }
          return { f: P.f, n: P.n, wall: F.wall.slice(), walk, tally: P.pack.public.tally ? Object.assign({}, F.tally) : null };
        }),
        tells: null, door: null, lines: { errata: [], drip: [] }, wall: [] };
      const head = live.concat(early).sort((a, b) => b.openMs - a.openMs)[0] || null;
      if (head) {
        out.tells = head.pack.public.tells || null;
        out.door = { f: head.f, shape: head.pack.public.door.shape };
        const day = X.dayOf(head, t);
        out.lines.errata = head.pack.public.errata.filter((e) => e.fromDay <= day).map((e) => e.text);
        const F = X.fstate(head);
        for (const st of head.stages) {
          if (F.solved[st.id]) continue;
          for (const d of st.drip) if (d.afterDays <= day) out.lines.drip.push(d.text);
        }
        out.wall = X.fstate(head).wall.slice();
      } else if (cold.length) {
        out.wall = X.fstate(cold.sort((a, b) => b.openMs - a.openMs)[0]).wall.slice();
      }
      if (X.sandbox) out.pub = K.pubB64;
      return out;
    }
  };

  /* ----- door (8.2) ----- */
  R['door'] = {
    methods: ['POST'],
    addr: addrLimit('door', (lim) => lim.door.ipPerHour, 3600000),
    fn(X, c, b, req, addr) {
      const t = X.now();
      const line = typeof b.line === 'string' ? b.line.slice(0, 200) : '';
      const wn = L.norm(line, 'words');
      const cert = typeof b.cert === 'string' ? X.verifyCert(b.cert) : null;
      const fallback = newestLive(X, t);
      if (!wn) return { ok: false, say: X.say(fallback, 'door_no') };
      for (const P of X.packs.values()) {
        const ph = X.phaseOf(P, t);
        let hsPass = false;
        if (ph === 'upcoming') {
          const hs = P.pack.schedule.headStartHours * 3600000;
          if (!(cert && cert.kind === 'frequency' && !cert.late && cert.n === P.n - 1 && hs > 0 && t >= P.openMs - hs)) continue;
          hsPass = true;
        }
        let re;
        try { re = new RegExp(P.pack.public.door.shape); } catch (e) { continue; }
        if (!re.test(line)) continue;
        if (!hasHash(P.pack.door.hmac, H.door(K.content, P.f, wn))) continue;
        if (X.hit('i|mint|' + addr.ip, X.LIM.door.mintPerIpDay, DAY) || X.hit('n|mint|' + addr.net, X.LIM.door.mintPerNetDay, DAY)) {
          return [429, { ok: false, error: 'limit', say: X.say(P, 'limit') }, { 'retry-after': '3600' }];
        }
        if (hsPass) {
          const key = H.headStart(K.state, P.f, cert.id);
          const F = X.fstate(P);
          if ((F.hs[key] || 0) >= P.lim.door.headStartPerCert) return X.fail(P, 'limit');
          F.hs[key] = (F.hs[key] || 0) + 1;
          X.saveSoon();
        }
        const m = X.mintPass(P, t, { hs: hsPass });
        return { ok: true, f: P.f, pass: m.token, say: X.say(P, 'door_ok') };
      }
      return { ok: false, say: X.say(fallback, 'door_no') };
    }
  };

  /* ----- helpers for state and stage ----- */
  function echoInfo(c, st, rec, state) {
    const e = st.echo;
    const claimed = rec && rec.h[st.id] ? rec.h[st.id] : 0;
    if (state === 'locked' || claimed >= 3) return { claimed, next: null, at: null };
    const k = claimed + 1;
    if (c.late) return { claimed, next: k, at: null };
    const at = X.openDayOf(c, st, rec) + e.first + (k - 1) * e.every;
    return { claimed, next: k, at: at <= c.day ? null : at };
  }
  function answersLeft(c, st, rec) {
    if (c.late) return 99;
    const used = rec && rec.a[c.day] && rec.a[c.day][st.id] ? rec.a[c.day][st.id] : 0;
    return Math.max(0, st.answers.perDay - used);
  }
  function stageList(c, rec, bits) {
    return c.P.stages.map((st) => {
      const state = X.stageStateOf(c, st, bits);
      const row = { id: st.id, n: st.n, type: st.type, title: state === 'locked' ? null : st.title, state,
        opened: state === 'locked' ? null : X.openDayOf(c, st, rec),
        solved: state === 'solved' ? (rec && rec.s[st.id] !== undefined ? rec.s[st.id] : c.day) : null,
        notBefore: st.notBefore, echo: echoInfo(c, st, rec, state) };
      if (st.answers && st.type !== 'run') row.answers = { left: state === 'open' ? answersLeft(c, st, rec) : 0 };
      return row;
    });
  }
  function floorOf(c) {
    const fd = c.P.pack.schedule.floorDay;
    return { day: fd, ok: fd === null || c.late || c.day >= fd };
  }

  /* ----- state (8.3) ----- */
  R['state'] = {
    methods: ['POST'], pass: true, passLim: readPass,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c) {
      const P = c.P;
      const rec = c.late ? null : X.getRec(P, c.id);
      const bits = X.progressBits(c);
      const solved = X.freqSolved(c, bits);
      const F = X.fstate(P);
      const out = { ok: true, f: P.f, n: P.n, title: P.pack.title, kind: P.kind, day: c.day, late: c.late, sandbox: X.sandbox,
        stages: stageList(c, rec, bits),
        lanterns: { have: rec ? Math.max(0, rec.lt - rec.lu) : 0, used: rec ? rec.lu : 0 },
        unlit: X.unlitOf(c, rec), cert: solved,
        wall: { eligible: !!(c.live && solved && !(rec && rec.w) && P.pack.public.wall.size > 0 && F.wall.length < P.pack.public.wall.size), signed: !!(rec && rec.w) },
        tally: { open: !!(c.live && solved && P.pack.public.tally), voted: !!(rec && rec.t) },
        floor: floorOf(c) };
      if (bits !== c.pass.s || (rec && (Object.keys(rec.h).length || rec.lu) && !c.pass.h)) {
        const used = rec && (Object.keys(rec.h).length > 0 || rec.lu > 0);
        out.pass = X.reissue(c, bits, c.pass.h || used);
      }
      return out;
    }
  };

  /* ----- stage (8.4) ----- */
  R['stage'] = {
    methods: ['POST'], pass: true, passLim: readPass,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c, b) {
      const P = c.P;
      const st = typeof b.stage === 'string' && STAGE_RE.test(b.stage) ? P.byId.get(b.stage) : null;
      if (!st) return X.fail(P, 'locked');
      const rec = c.late ? null : X.getRec(P, c.id);
      const bits = X.progressBits(c);
      const state = X.stageStateOf(c, st, bits);
      if (state === 'locked') return X.fail(P, 'locked');
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      const open = X.openDayOf(c, st, rec);
      const data = X.gate(lin.pub, c.day, open, c.late);
      const out = { ok: true, id: st.id, n: st.n, type: st.type, title: st.title, state, day: c.day, late: c.late, data, echoes: [] };
      TYPE[st.type](X, c, st, lin, rec, data, b, out);
      if (rec && rec.h[st.id]) {
        for (let k = 1; k <= rec.h[st.id]; k++) out.echoes.push({ tier: k, text: X.renderFor(c, st, lin.hints[k - 1]) });
      }
      return out;
    }
  };

  const TYPE = {
    broadcast(X, c, st, lin, rec, data, b) {
      const sch = lin.pub.schedule, sec = lin.sec, P = c.P;
      const t = c.t, today = c.day;
      const L_ = H.lineage(K.state, P.f, c.id, P.V);
      const air = (d, occ, reel) => {
        const start = P.openMs + d * DAY + sch.offsets[occ] * 60000;
        return { day: d, occ, reel, start, end: start + sch.dur * 60000 };
      };
      const list = [];
      for (let d = Math.max(0, today - 1); d <= today + 1; d++) for (let o = 0; o < 3; o++) list.push(air(d, o, d % sch.reels));
      if (c.pass.hs) {
        const start = P.openMs - P.pack.schedule.headStartHours * 3600000 + sch.offsets[0] * 60000;
        list.push({ day: -1, occ: 0, reel: 0, start, end: start + sch.dur * 60000 });
      }
      const cur = list.find((a) => a.start <= t && t < a.end) || null;
      const nxt = list.filter((a) => a.start > t).sort((a, b2) => a.start - b2.start)[0] || null;
      data.now = { state: cur ? 'live' : 'idle', next: nxt ? nxt.start : null, airing: cur ? { day: cur.day, occ: cur.occ, start: cur.start, end: cur.end } : null };
      data.live = null;
      if (cur) {
        const ids = sec.reels[cur.reel] || [];
        const k = Math.floor((t - cur.start) / (sch.slot * 1000));
        if (k >= 0 && k < ids.length && sec.frames[ids[k]]) {
          data.live = { day: cur.day, occ: cur.occ, slot: k, of: ids.length, id: ids[k], lines: sec.frames[ids[k]].lines.slice(), until: cur.start + (k + 1) * sch.slot * 1000 };
        }
      }
      data.rec = [];
      const frames = (reel, d, clean) => (sec.reels[reel] || []).map((id, k) => ({ slot: k, id,
        lines: clean ? sec.frames[id].lines.slice() : L.degrade(sec.frames[id].lines, sec.degrade.permille, K.content, 'deg|' + P.f + '|' + L_ + '|' + id + '|' + d, sec.degrade.noise) }));
      if (c.late) {
        for (let r = 0; r < sch.reels; r++) data.rec.push({ day: r, reel: r, frames: frames(r, r, true) });
      } else {
        const since = isInt(b.since) ? b.since : today - 6;
        const from = Math.max(0, since);
        for (let d = from; d <= Math.min(today, from + 6); d++) {
          const opens = P.openMs + d * DAY + (sch.offsets[0] + sch.dur + sch.recAfter) * 60000;
          if (t < opens) continue;
          data.rec.push({ day: d, reel: d % sch.reels, frames: frames(d % sch.reels, d, false) });
        }
      }
    },
    log() {},
    rooms() {},
    planchette(X, c, st, lin, rec, data) {
      const d = X.drawOf(c, st);
      data.givens = d.givens;
      const day = c.day;
      if (c.late) { data.today = { day, used: 0, left: 99, carried: 0, closed: false, commit: null }; return; }
      const used = rec && rec.q[day] ? rec.q[day] : 0;
      const closed = used > 0 && !X.askedMem.peek(c.rk + '|' + day);
      const carried = rec && rec.cq ? rec.cq : 0;
      const perDay = lin.pub.perDay;
      const lie = H.lie(K.state, c.P.f, c.id, day, perDay);
      data.today = { day, used, left: closed ? carried : Math.max(0, perDay - used) + carried, carried, closed,
        commit: L.lieCommit(c.P.f, day, lie.slot, lie.salt) };
    },
    run(X, c, st, lin, rec, data) {
      const cfg = X.boundCfg(c, st, lin);
      if (cfg !== undefined) data.cfg = cfg; else delete data.cfg;
      data.lanterns = { have: rec ? Math.max(0, rec.lt - rec.lu) : 0, used: rec ? rec.lu : 0 };
    },
    final(X, c, st, lin, rec, data) {
      const cfg = X.boundCfg(c, st, lin);
      if (cfg !== undefined) data.cfg = cfg; else delete data.cfg;
      data.floor = floorOf(c);
      const at = lin.pub.attempts;
      const until = X.coolMem.peek(c.rk);
      data.attempts = c.late ? { left: 99, cooldownUntil: null }
        : { left: Math.max(0, at.perDay - (rec && rec.x[c.day] ? rec.x[c.day] : 0)), cooldownUntil: until && until > c.t ? until : null };
      if (c.late || (rec && rec.g && rec.g[st.id])) data.gloss = lin.sec.gloss.slice();
    }
  };
  X.TYPE = TYPE;

  /* ----- answer (8.5) ----- */
  R['answer'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('answer', (lim) => lim.answer.ipPerHour, 3600000),
    fn(X, c, b) {
      const P = c.P;
      if (c.phase === 'upcoming') return X.fail(P, 'early');
      if (typeof b.text !== 'string' || !b.text.length || b.text.length > 200) return X.fail(P, 'invalid');
      const bits = X.progressBits(c);
      const named = b.stage === undefined ? null : (typeof b.stage === 'string' ? P.byId.get(b.stage) || false : false);
      if (named === false) return X.fail(P, 'locked');
      if (named && (!named.answers || X.stageStateOf(c, named, bits) === 'locked')) return X.fail(P, 'locked');
      const cands = named ? [named] : P.stages.filter((s) => s.answers && X.stageStateOf(c, s, bits) !== 'locked');
      if (!cands.length) return X.fail(P, 'locked');
      const pm = X.passMem.get(c.rk) || X.passMem.set(c.rk, {});
      const tr = X.real();
      if (pm.ansAt && tr - pm.ansAt < P.lim.answer.minGapMs) return [429, { ok: false, error: 'limit', say: X.say(P, 'limit') }, { 'retry-after': '2' }];
      pm.ansAt = tr;
      let rec = c.late ? null : X.getRec(P, c.id);
      if (!c.late && rec && rec.a[c.day] && (rec.a[c.day]['*'] || 0) >= P.lim.answer.passPerDay) {
        return [429, { ok: false, error: 'limit', say: X.say(P, 'limit') }, { 'retry-after': '3600' }];
      }
      const Ln = H.lineage(K.state, P.f, c.id, P.V);
      const found = { correct: null, solved: null, warm: null, foreign: null };
      let compared = 0, nonEmpty = 0, budget = false, lastSt = named;
      for (const st of cands) {
        const t = L.normStage(b.text, st.norm);
        if (!t) continue;
        nonEmpty++;
        const lin = st.lineages[Ln];
        const own = () => {
          if (st.type === 'planchette') {
            const d = X.drawOf(c, st);
            return hasHash([H.answer(K.content, P.f, st.id, Ln, L.norm(d.grid, 'glyph', d.spec.alphabet))], H.answer(K.content, P.f, st.id, Ln, t));
          }
          return hasHash(lin.ans, H.answer(K.content, P.f, st.id, Ln, t));
        };
        if (bits & X.bitOfStage(st)) { if (own()) found.solved = found.solved || st; continue; }
        if (!c.late) {
          const used = rec && rec.a[c.day] && rec.a[c.day][st.id] ? rec.a[c.day][st.id] : 0;
          if (used >= st.answers.perDay) { budget = true; continue; }
          rec = X.ensureRec(c);
          const a = rec.a[c.day] || (rec.a[c.day] = {});
          a[st.id] = (a[st.id] || 0) + 1;
          a['*'] = (a['*'] || 0) + 1;
          X.saveSoon();
        }
        compared++;
        lastSt = st;
        if (own()) { found.correct = st; break; }
        if (hasHash(lin.warm, H.warm(K.content, P.f, st.id, Ln, t))) { found.warm = found.warm || st; continue; }
        if (st.foreign === 1) {
          for (let l2 = 0; l2 < P.V; l2++) {
            if (l2 !== Ln && hasHash(st.lineages[l2].ans, H.answer(K.content, P.f, st.id, l2, t))) { found.foreign = found.foreign || st; break; }
          }
        }
      }
      const leftOf = (st) => (st && st.answers ? answersLeft(c, st, c.late ? null : X.getRec(P, c.id)) : undefined);
      if (found.correct) {
        const st = found.correct;
        if (!c.late && st.notBefore !== null && c.day < st.notBefore) return { ok: true, result: 'early', stage: st.id, say: X.say(P, 'early'), left: leftOf(st) };
        let unlocked = [], token, bits2;
        if (c.late) {
          bits2 = bits | X.bitOfStage(st);
          const opened = (y, bb) => y.requires.every((id) => bb & X.bitOfStage(P.byId.get(id)));
          unlocked = P.stages.filter((y) => !(bits2 & X.bitOfStage(y)) && opened(y, bits2) && !opened(y, bits)).map((y) => y.id);
          token = X.reissue(c, bits2, c.pass.h);
        } else {
          rec = X.ensureRec(c);
          unlocked = X.solveStage(c, rec, st);
          bits2 = c.pass.s | X.recBits(P, rec);
          token = X.reissue(c, bits2, c.pass.h || Object.keys(rec.h).length > 0 || rec.lu > 0);
        }
        return { ok: true, result: 'correct', stage: st.id, say: X.say(P, 'correct'), unlocked, pass: token, left: leftOf(st) };
      }
      if (found.solved) return { ok: true, result: 'solved', stage: found.solved.id, say: X.say(P, 'solved') };
      if (found.warm) {
        const st = found.warm;
        const out = { ok: true, result: 'warm', stage: st.id, say: X.say(P, 'warm'), left: leftOf(st) };
        if (st.type === 'final') {
          out.lines = st.lineages[Ln].sec.gloss.slice();
          if (!c.late) { rec = X.ensureRec(c); rec.g = rec.g || {}; rec.g[st.id] = 1; X.saveSoon(); }
        }
        return out;
      }
      if (found.foreign) return { ok: true, result: 'foreign', say: X.say(P, 'foreign'), left: leftOf(found.foreign) };
      if (!compared) {
        if (!nonEmpty) return X.fail(P, 'invalid');
        if (budget) return X.fail(P, 'budget');
      }
      return { ok: true, result: 'wrong', say: X.say(P, 'wrong'), left: leftOf(lastSt) };
    }
  };

  /* ----- echo (8.10) ----- */
  R['echo'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    passLim: readPass,
    fn(X, c, b) {
      const P = c.P;
      if (c.phase === 'upcoming') return X.fail(P, 'early');
      const st = typeof b.stage === 'string' && STAGE_RE.test(b.stage) ? P.byId.get(b.stage) : null;
      const bits = X.progressBits(c);
      if (!st || X.stageStateOf(c, st, bits) === 'locked') return X.fail(P, 'locked');
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      let rec = c.late ? null : X.getRec(P, c.id);
      const info = echoInfo(c, st, rec, X.stageStateOf(c, st, bits));
      if (!b.claim) {
        const echoes = [];
        for (let k = 1; k <= info.claimed; k++) echoes.push({ tier: k, text: X.renderFor(c, st, lin.hints[k - 1]) });
        return { ok: true, echoes, next: info.next, at: info.at };
      }
      if (c.late) {
        const k = isInt(b.tier) && b.tier >= 1 && b.tier <= 3 ? b.tier : 1;
        return { ok: true, tier: k, text: X.renderFor(c, st, lin.hints[k - 1]), pass: X.reissue(c, bits, c.pass.h), unlit: false };
      }
      if (info.next === null) return X.fail(P, 'budget');
      const lantern = !!b.lantern;
      if (lantern) {
        if (st.type === 'run') return X.fail(P, 'locked');
        if (!rec || rec.lt - rec.lu < 1) return X.fail(P, 'locked');
      } else if (info.at !== null) return { ok: false, error: 'early', say: X.say(P, 'early'), at: info.at };
      rec = X.ensureRec(c);
      if (lantern) rec.lu++;
      rec.h[st.id] = info.next;
      X.saveSoon();
      return { ok: true, tier: info.next, text: X.renderFor(c, st, lin.hints[info.next - 1]),
        pass: X.reissue(c, c.pass.s | X.recBits(P, rec), 1), unlit: false };
    }
  };

  /* ----- cert (8.11) and verify (8.12) ----- */
  R['cert'] = {
    methods: ['POST'], pass: true, passLim: readPass,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c) {
      const bits = X.progressBits(c);
      if (!X.freqSolved(c, bits)) return X.fail(c.P, 'locked');
      return { ok: true, cert: X.issueCert(c, bits) };
    }
  };
  R['verify'] = {
    methods: ['POST'],
    addr: addrLimit('verify', (lim) => lim.verify.ipPerMin, 60000),
    fn(X, c, b) {
      const p = typeof b.cert === 'string' ? X.verifyCert(b.cert) : null;
      return p ? { ok: true, payload: p } : { ok: false };
    }
  };

  /* ----- recover (8.15) ----- */
  R['recover'] = {
    methods: ['POST'],
    addr: addrLimit('recover', (lim) => lim.recover.ipPerHour, 3600000),
    fn(X, c, b) {
      const t = X.now();
      const code = typeof b.code === 'string' ? b.code.replace(/\s+/g, '') : '';
      const P = typeof b.f === 'string' && lib.F_RE.test(b.f) ? X.packs.get(b.f) : newestLive(X, t);
      if (!P || X.phaseOf(P, t) !== 'live' || !/^[A-Za-z0-9_-]{22}$/.test(code)) return X.fail(P, 'invalid');
      const rec = X.getRec(P, code);
      if (!rec) return X.fail(P, 'invalid');
      const used = Object.keys(rec.h).length > 0 || rec.lu > 0;
      const payload = { v: 1, k: 'pass', f: P.f, id: code, d: rec.d0, s: X.recBits(P, rec), h: used ? 1 : 0 };
      if (X.sandbox) payload.sb = 1;
      return { ok: true, pass: L.sign('p1', payload, K.priv), say: X.say(P, 'recovered') };
    }
  };
}
