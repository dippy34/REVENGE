// hunt-play.mjs: probes, planchette questions, reveal, wall, tally, walkthrough and the
// sandbox admin routes (CONTRACT 8.6-8.8, 8.13, 8.14, 7.9). Generic, like the rest.
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './hunt-lib.mjs';
import { addrLimit, readPass } from './hunt-routes.mjs';

const { H } = lib;
const DAY = 86400000;
const STAGE_RE = /^s[1-9]$/;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

export function installPlay(X) {
  const R = X.routes;
  const K = X.K;

  const openStage = (c, type) => {
    const bits = X.progressBits(c);
    return c.P.stages.find((st) => st.type === type && X.stageStateOf(c, st, bits) === 'open') || null;
  };

  /* ----- probe (8.6) ----- */
  R['probe'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('probe', (lim) => lim.probe.ipPerMin, 60000),
    passLim(X, c) {
      const lim = c.P.lim.probe;
      const pm = X.passMem.get(c.rk) || X.passMem.set(c.rk, {});
      const tr = X.real();
      if (pm.probeAt && tr - pm.probeAt < lim.minGapMs) return Math.max(1, Math.ceil((lim.minGapMs - (tr - pm.probeAt)) / 1000));
      pm.probeAt = tr;
      const dk = Math.floor(tr / DAY);
      if (!pm.pd || pm.pd.d !== dk) pm.pd = { d: dk, n: 0 };
      if (++pm.pd.n > lim.passPerDay) return 3600;
      return 0;
    },
    fn(X, c, b) {
      if (c.phase === 'upcoming') return { ok: true, rooms: [] };
      const st = openStage(c, 'rooms');
      if (!st || !isObj(b.facts)) return { ok: true, rooms: [] };
      const lin = st.lineages[H.lineage(K.state, c.P.f, c.id, c.P.V)];
      const u = X.utcParts(c.t);
      const hits = lib.facts.probe(lin.sec.rooms, b.facts, { h: u.h, mi: u.mi, dw: u.dw, day: Math.max(-1, Math.min(400, c.day)) }, c.P.lim.probe);
      return { ok: true, rooms: hits.map((r) => ({ area: r.area, frag: r.frag, say: r.say })) };
    }
  };

  /* ----- ask (8.7) ----- */
  function spaceOf(c, st, d) {
    const sp = c.P.spaces.get(st.id + '|' + d.L);
    return sp ? { n: sp.n, cells: sp.cells, data: sp.data, iso: d.iso } : null;
  }
  const lieOf = (c, day, perDay) => {
    const l = H.lie(K.state, c.P.f, c.id, day, perDay);
    return { slot: l.slot, salt: l.salt, commit: lib.lieCommit(c.P.f, day, l.slot, l.salt) };
  };
  R['ask'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('ask', (lim) => lim.ask.ipPerHour, 3600000),
    fn(X, c, b) {
      const P = c.P;
      if (c.phase === 'upcoming') return X.fail(P, 'early');
      const st = X.planchetteStage(P);
      if (!st || X.stageStateOf(c, st, X.progressBits(c)) !== 'open') return X.fail(P, 'locked');
      if (typeof b.q !== 'string' || b.q.length > 200) return X.fail(P, 'grammar');
      const d = X.drawOf(c, st);
      const parsed = lib.planchette.parse(b.q, d.spec);
      if (!parsed.ok) return X.fail(P, 'grammar');
      const sp = spaceOf(c, st, d);
      const forced = (p) => lib.planchette.forced(p, d.spec, sp);
      const day = c.day, perDay = d.lin.pub.perDay;
      if (c.late) {
        const a = lib.planchette.answer(parsed, d.grid, d.spec, { asked: null, isLie: false, forced });
        return { ok: true, a, canon: parsed.canon, i: 0, used: 0, left: 99, day, commit: null };
      }
      const rec = X.ensureRec(c);
      const used = rec.q[day] || 0;
      const key = c.rk + '|' + day;
      let asked = X.askedMem.get(key);
      // a day already begun, with no memory of its questions (restart, eviction): it is closed
      if (used > 0 && used < perDay && !asked) {
        rec.cq = (rec.cq || 0) + (perDay - used);
        rec.cqd = day + 1;
        rec.q[day] = perDay;
        X.saveSoon();
        return X.fail(P, 'closed', 200, { carried: rec.cq });
      }
      const regular = used < perDay;
      const carried = rec.cq > 0 && day >= (rec.cqd || 0);
      if (!regular && !carried) {
        return rec.cqd === day + 1 ? X.fail(P, 'closed', 200, { carried: rec.cq || 0 }) : X.fail(P, 'budget');
      }
      if (!asked) asked = X.askedMem.set(key, new Set());
      const lie = lieOf(c, day, perDay);
      const i = used;
      const isLie = regular && i === lie.slot;
      const a = lib.planchette.answer(parsed, d.grid, d.spec, { asked, isLie, forced });
      asked.add(parsed.canon);
      rec.q[day] = used + 1;
      if (!regular) rec.cq--;
      X.saveSoon();
      const left = Math.max(0, perDay - (used + 1)) + (rec.cq > 0 && day >= (rec.cqd || 0) ? rec.cq : 0);
      return { ok: true, a, canon: parsed.canon, i, used: used + 1, left, day, commit: lie.commit };
    }
  };

  /* ----- reveal (8.8) ----- */
  R['reveal'] = {
    methods: ['POST'], pass: true, passLim: readPass,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c) {
      const P = c.P;
      const st = X.planchetteStage(P);
      const bits = X.progressBits(c);
      if (!st || !(c.late || (bits & X.bitOfStage(st)))) return X.fail(P, 'locked');
      if (c.late) return { ok: true, days: [] };
      const rec = X.getRec(P, c.id);
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      const days = [];
      if (rec) {
        for (const k of Object.keys(rec.q).map(Number).sort((a, b) => a - b)) {
          if (!(rec.q[k] > 0)) continue;
          const l = H.lie(K.state, P.f, c.id, k, lin.pub.perDay);
          days.push({ day: k, slot: l.slot, salt: l.salt });
        }
      }
      return { ok: true, days };
    }
  };

  /* ----- wall and tally (8.13) ----- */
  R['wall'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('wall', (lim) => lim.wall.ipPerHour, 3600000),
    fn(X, c, b, req, addr) {
      const P = c.P;
      if (!c.live || P.pack.public.wall.size < 1) return X.fail(P, 'closed');
      const bits = X.progressBits(c);
      if (!X.freqSolved(c, bits)) return X.fail(P, 'locked');
      const h = typeof b.handle === 'string' ? b.handle.toUpperCase() : '';
      if (!/^[A-Z]{3}$/.test(h) || P.pack.wall.block.includes(h)) return X.fail(P, 'invalid');
      const F = X.fstate(P);
      const rec = X.ensureRec(c);
      if (rec.w || F.wall.length >= P.pack.public.wall.size) return X.fail(P, 'closed');
      const mk = addr.ip + '|' + c.day;
      if (X.wallMarks.peek(mk) && X.wallMarks.peek(mk) >= P.lim.wall.ipPerDay) return X.fail(P, 'limit');
      X.wallMarks.set(mk, (X.wallMarks.peek(mk) || 0) + 1);
      F.wall.push({ h, day: c.day });
      rec.w = 1;
      X.saveSoon();
      return { ok: true, wall: F.wall.slice() };
    }
  };
  R['tally'] = {
    methods: ['POST'], pass: true, passLim: readPass,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c, b) {
      const P = c.P;
      const tally = P.pack.public.tally;
      if (!c.live || !tally) return X.fail(P, 'closed');
      if (!X.freqSolved(c, X.progressBits(c))) return X.fail(P, 'locked');
      if (typeof b.choice !== 'string' || !tally.options.some((o) => o.id === b.choice)) return X.fail(P, 'invalid');
      const rec = X.ensureRec(c);
      if (rec.t) return X.fail(P, 'closed');
      const F = X.fstate(P);
      F.tally[b.choice] = (F.tally[b.choice] || 0) + 1;
      rec.t = 1;
      X.saveSoon();
      return { ok: true };
    }
  };

  /* ----- walkthrough (8.14): only after cold; in the sandbox an admin route ----- */
  R['walkthrough'] = {
    methods: ['POST'], adminInSandbox: true,
    addr: addrLimit('read', (lim) => lim.read.ipPerMin, 60000),
    fn(X, c, b) {
      const P = typeof b.f === 'string' && lib.F_RE.test(b.f) ? X.packs.get(b.f) : null;
      if (!P) return X.fail(null, 'locked');
      const t = X.now();
      if (X.phaseOf(P, t) !== 'cold') return X.fail(P, 'locked');
      let w = X.walkCache.get(P.f);
      if (w === undefined) {
        try {
          const env = lib.readEnvelope(fs.readFileSync(path.join(X.packDir, P.f + '.walk-public.sealed'), 'utf8'));
          w = lib.openJson(env, lib.walkpubKey(K.aes, P.f, P.pack.schedule.coldAt), { kind: 'walkpub', f: P.f });
        } catch (e) { w = null; }
        X.walkCache.set(P.f, w);
      }
      if (!w || !isObj(w.stages)) return X.fail(P, 'locked');
      let cc = null;
      if (typeof b.pass === 'string') {
        const v = X.verifyPass(b.pass);
        if (v.payload && v.payload.f === P.f) cc = X.ctxOf(v.payload, null);
      }
      const L_ = cc ? H.lineage(K.state, P.f, cc.id, P.V) : -1;
      const stages = Object.keys(w.stages).sort().map((id) => {
        const s = w.stages[id];
        const out = { id, title: String(s.title || ''), method: String(s.method || '') };
        if (cc && s.lineages && s.lineages[L_]) {
          const st = P.byId.get(id) || { type: 'x' };
          out.detail = X.renderFor(cc, st, String(s.lineages[L_].detail || ''));
        }
        return out;
      });
      return { ok: true, stages };
    }
  };

  /* ----- sandbox admin routes (7.9): never reveal answers, conditions, grids or goals ----- */
  if (X.sandbox) {
    R['sandbox/pass'] = {
      methods: ['POST'], admin: true, sandbox: true,
      fn(X, c, b) {
        const P = typeof b.f === 'string' ? X.packs.get(b.f) : null;
        if (!P) return X.fail(null, 'gone', 404);
        const t = X.now();
        const m = X.mintPass(P, t, { hs: false });
        if (m.payload.d < -1) { m.payload.d = -1; return { ok: true, pass: lib.sign('p1', m.payload, K.priv) }; }
        return { ok: true, pass: m.token };
      }
    };
    R['sandbox/jump'] = {
      methods: ['POST'], admin: true, sandbox: true, pass: true,
      fn(X, c, b) {
        const P = c.P;
        const st = typeof b.stage === 'string' && STAGE_RE.test(b.stage) ? P.byId.get(b.stage) : null;
        if (!st) return X.fail(P, 'locked');
        const need = new Set();
        const walk = (s) => { for (const id of s.requires) { if (!need.has(id)) { need.add(id); walk(P.byId.get(id)); } } };
        walk(st);
        const rec = X.ensureRec(c);
        for (const s of P.stages) if (need.has(s.id) && rec.s[s.id] === undefined) X.solveStage(c, rec, s);
        if (rec.o[st.id] === undefined) rec.o[st.id] = c.day;
        X.saveSoon();
        return { ok: true, pass: X.reissue(c, c.pass.s | X.recBits(P, rec), c.pass.h) };
      }
    };
    R['sandbox/clock'] = {
      methods: ['POST'], admin: true, sandbox: true,
      fn(X, c, b) {
        const to = typeof b.to === 'string' ? Date.parse(b.to) : NaN;
        const sp = Number(b.speed);
        X.setClock(Number.isFinite(to) ? to : X.now(), Number.isFinite(sp) && sp >= 1 && sp <= 100000 ? sp : X.clk.speed);
        return { ok: true, now: X.now(), speed: X.clk.speed };
      }
    };
    R['sandbox/info'] = {
      methods: ['GET'], admin: true, sandbox: true,
      fn(X) { return { ok: true, now: X.now(), speed: X.clk.speed, dataDir: path.basename(X.dataDir) }; }
    };
  }
}
