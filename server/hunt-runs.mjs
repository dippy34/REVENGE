// hunt-runs.mjs: ranked runs of the skill stages (CONTRACT 8.9, 11.4, 11.5).
//
// The engine keeps each active run's own live sim state and continues it with every upload,
// so a later log can never rewrite an earlier one and the replay costs one pass over the
// run. Seeds are revealed one draw ahead of need. The real clock bounds how fast a run may
// be played. Nothing here logs inputs, times or addresses.
import crypto from 'node:crypto';
import * as lib from './hunt-lib.mjs';
import { addrLimit } from './hunt-routes.mjs';

const { H } = lib;
const isInt = (x) => Number.isSafeInteger(x);
const STAGE_RE = /^s[1-9]$/;
const DEVICES = ['key', 'touch'];
const LOCALS = ['hidden', 'blur', 'error'];

export function installRuns(X) {
  const R = X.routes;
  const K = X.K;
  const L = X.LIM.run;
  const ipRuns = new Map();     // address key -> active runs

  function dropRun(run) {
    if (!run || run.gone) return;
    run.gone = true;
    X.runs.delete(run.id);
    if (X.runByPass.get(run.rk) === run.id) X.runByPass.delete(run.rk);
    const n = (ipRuns.get(run.ip) || 1) - 1;
    if (n > 0) ipRuns.set(run.ip, n); else ipRuns.delete(run.ip);
  }
  X.runSweep = () => {
    const t = X.real();
    for (const run of Array.from(X.runs.values())) if (t >= run.expires) dropRun(run);
  };

  const fail = (P, code, extra) => X.fail(P, code, 200, extra);

  /* ----- start ----- */
  R['run/start'] = {
    methods: ['POST'], pass: true,
    addr: addrLimit('runstart', (lim) => lim.run.ipPerHour, 3600000),
    fn(X, c, b, req, addr) {
      const P = c.P, sim = X.sim;
      if (!sim) return fail(P, 'off');
      if (c.phase === 'upcoming') return fail(P, 'early');
      const st = typeof b.stage === 'string' && STAGE_RE.test(b.stage) ? P.byId.get(b.stage) : null;
      if (!st || (st.type !== 'run' && st.type !== 'final')) return fail(P, 'locked');
      const bits = X.progressBits(c);
      const state = X.stageStateOf(c, st, bits);
      if (state === 'locked' || (st.type === 'final' && state === 'solved')) return fail(P, 'locked');
      if (!DEVICES.includes(b.device)) return fail(P, 'invalid');
      const lat = isInt(b.lat) ? Math.max(0, Math.min(2000, b.lat)) : 0;
      X.runSweep();
      const mine = X.runByPass.get(c.rk);
      if (mine && X.runs.get(mine)) return fail(P, 'busy');
      if (X.runs.size >= P.lim.run.maxActive || (ipRuns.get(addr.ip) || 0) >= P.lim.run.ipActive) return fail(P, 'busy');
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      const floorOk = c.late || ((st.notBefore === null || c.day >= st.notBefore) &&
        (st.type !== 'final' || P.pack.schedule.floorDay === null || c.day >= P.pack.schedule.floorDay));
      if (!floorOk) return fail(P, 'early');
      let rec = null;
      if (!c.late) {
        rec = X.ensureRec(c);
        if (st.type === 'final') {
          const until = X.coolMem.peek(c.rk);
          if (until && until > c.t) return fail(P, 'cooldown', { until });
          if ((rec.x[c.day] || 0) >= lin.pub.attempts.perDay) return fail(P, 'budget');
          rec.x[c.day] = (rec.x[c.day] || 0) + 1;
        } else {
          if ((rec.r[c.day] || 0) >= P.lim.run.rankedPerDay) return fail(P, 'budget');
          rec.r[c.day] = (rec.r[c.day] || 0) + 1;
        }
        X.saveSoon();
      }
      const cfg = X.boundCfg(c, st, lin);
      if (cfg === undefined || !isInt(cfg.maxTicks) || !isInt(cfg.maxDraws)) return fail(P, 'off');
      const tickMs = lin.pub.tickMs[b.device];
      const id = lib.b64u.enc(crypto.randomBytes(12));
      const secret = crypto.randomBytes(32);
      const secretHex = secret.toString('hex');
      const first = Math.min(P.lim.run.ahead, cfg.maxDraws - 1);
      const seeds = [];
      for (let k = 0; k <= first; k++) seeds.push(lib.drawSeed(secret, k));
      const tr = X.real();
      const run = { id, rk: c.rk, ip: addr.ip, f: P.f, stage: st.id, type: st.type, device: b.device, lat, secret, secretHex,
        tickMs, maxTicks: cfg.maxTicks, maxDraws: cfg.maxDraws, sim: sim.create(cfg, { device: b.device }),
        upto: -1, revealed: seeds.length, revealAt: seeds.map(() => 0), supplied: 0, logCount: 0,
        startReal: tr, lastUpload: 0, expires: tr + P.lim.run.ttlMs, ended: false, endTick: null, gone: false };
      X.runs.set(id, run);
      X.runByPass.set(c.rk, id);
      ipRuns.set(addr.ip, (ipRuns.get(addr.ip) || 0) + 1);
      return { ok: true, run: id, tickMs, maxTicks: cfg.maxTicks, maxDraws: cfg.maxDraws, ahead: P.lim.run.ahead,
        commit: lib.runCommit(id, secretHex), seeds };
    }
  };

  /* ----- an upload: checks, then continue the stored run (11.4) ----- */
  // returns null when fine, else the error code ('rejected'); fills run.* on success
  function advance(c, run, b) {
    const P = c.P, sim = X.sim;
    const tr = X.real();
    if (run.ended || tr >= run.expires) return 'rejected';
    const upto = b.upto;
    if (!isInt(upto) || upto <= run.upto || upto > run.maxTicks - 1) return 'rejected';
    const log = b.log;
    if (!Array.isArray(log) || run.logCount + log.length > P.lim.run.maxLog || log.length > 4 * (upto - run.upto) + 8) return 'rejected';
    if (run.lastUpload && tr - run.lastUpload < P.lim.run.uploadGapMs) return 'rejected';
    // real time: a client can never be ahead of the clock, and may not lag far behind it
    const T = (upto + 1) * run.tickMs;
    const elapsed = tr - run.startReal;
    if (elapsed < T * 0.97 - 1000 || elapsed > T + Math.max(5000, T / 50) + 1500) return 'rejected';
    // shape: entries ordered inside (prevUpto, upto], at most two directions per tick, seeds only as revealed
    let cur = null, dirs = 0, nine = 0, last = run.upto;
    for (const e of log) {
      if (!Array.isArray(e) || e.length !== 2 || !isInt(e[0]) || !isInt(e[1])) return 'rejected';
      const tk = e[0], code = e[1];
      if (tk <= run.upto || tk > upto || tk < last) return 'rejected';
      if (tk !== cur) { cur = tk; dirs = 0; }
      if (code === 9) { if (run.supplied + ++nine > run.revealed) return 'rejected'; }
      else if (code >= 0 && code <= 3) { if (++dirs > 2) return 'rejected'; }
      else return 'rejected';
      last = tk;
    }
    // seeds must be supplied soon after they were revealed
    const slack = Math.ceil(P.lim.run.feedSlackMs / run.tickMs);
    let k = run.supplied;
    for (const e of log) if (e[1] === 9) { if (e[0] > run.revealAt[k] + slack) return 'rejected'; k++; }
    // advance the stored state through the upload
    let i = 0;
    for (let t = run.upto + 1; t <= upto; t++) {
      while (i < log.length && log[i][0] === t) {
        const code = log[i][1];
        if (code === 9) { if (!sim.seed(run.sim, lib.drawSeed(run.secret, run.supplied))) return 'rejected'; run.supplied++; } else sim.feed(run.sim, code);
        i++;
      }
      sim.step(run.sim);
      if (sim.result(run.sim).ended) { run.ended = true; run.endTick = t; break; }
    }
    run.upto = run.ended ? run.endTick : upto;
    run.logCount += log.length;
    run.lastUpload = tr;
    return null;
  }

  function loadRun(c, b) {
    const run = typeof b.run === 'string' ? X.runs.get(b.run) : null;
    if (!run || run.gone || run.rk !== c.rk) return null;
    if (X.real() >= run.expires) { dropRun(run); return null; }
    return run;
  }
  const rejected = (c, run) => { dropRun(run); return fail(c.P, 'rejected'); };

  /* ----- seed ----- */
  R['run/seed'] = {
    methods: ['POST'], pass: true, maxBody: L.maxBody,
    addr: addrLimit('runup', (lim) => lim.run.ipUploadPerMin, 60000),
    fn(X, c, b) {
      const run = loadRun(c, b);
      if (!run) return fail(c.P, 'rejected');
      if (advance(c, run, b)) return rejected(c, run);
      const P = c.P;
      const seeds = {};
      if (!run.ended) {
        const want = Math.min(Math.max(X.sim.need(run.sim) - 1, 0) + P.lim.run.ahead, run.maxDraws - 1);
        while (run.revealed <= want) {
          seeds[run.revealed] = lib.drawSeed(run.secret, run.revealed);
          run.revealAt[run.revealed] = run.upto;
          run.revealed++;
        }
      }
      return { ok: true, seeds };
    }
  };

  /* ----- end ----- */
  R['run/end'] = {
    methods: ['POST'], pass: true, maxBody: L.maxBody,
    addr: addrLimit('runup', (lim) => lim.run.ipUploadPerMin, 60000),
    fn(X, c, b) {
      const P = c.P, sim = X.sim;
      const run = loadRun(c, b);
      if (!run) return fail(P, 'rejected');
      const local = b.local !== undefined;
      if (local && !LOCALS.includes(b.local)) return rejected(c, run);
      // the final upload (an empty one is fine when the run already ended on its own)
      const log = Array.isArray(b.log) ? b.log : null;
      const nothingNew = log && log.length === 0 && run.ended && b.upto === run.upto;
      if (!nothingNew && advance(c, run, b)) return rejected(c, run);
      if (!local && !run.ended) return rejected(c, run);
      const st = P.byId.get(run.stage);
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      const elapsed = Math.max(0, X.real() - run.startReal);
      const stats = sim.stats(run.sim);
      const plaus = lin.sec.plaus && lin.sec.plaus[run.device];
      const bad = plaus && sim.plausible ? sim.plausible(stats, plaus, run.tickMs) : null;
      const res = sim.result(run.sim);
      const reveal = run.secretHex;
      dropRun(run);
      const F = X.fstate(P);
      const rec = c.late ? null : X.ensureRec(c);
      if (bad) {
        F.rej[st.id] = (F.rej[st.id] || 0) + 1;
        X.saveSoon();
        if (st.type === 'final') return finalOut(c, st, rec, 'implausible', reveal, false);
        return { ok: true, result: 'implausible', say: X.say(P, 'implausible'), reveal };
      }
      if (st.type === 'final') {
        const took = !!(run.ended && sim.judge(run.sim, lin.sec.goal));
        return finalOut(c, st, rec, took ? 'took' : 'nottaken', reveal, took);
      }
      // a run stage: every ring cleared
      const cleared = !!(res.won && run.ended);
      const out = { ok: true, result: cleared ? 'cleared' : 'failed', say: X.say(P, cleared ? 'cleared' : 'failed'),
        rings: res.rings | 0, ms: elapsed, par: false, lantern: false, reveal };
      if (!cleared) return out;
      const par = lin.pub.pars && lin.pub.pars[run.device];
      out.par = isInt(par) && elapsed < par;
      const bits = X.progressBits(c);
      if (c.late) {
        const b2 = bits | X.bitOfStage(st);
        out.unlocked = P.stages.filter((y) => !(b2 & X.bitOfStage(y)) && y.requires.every((id) => b2 & X.bitOfStage(P.byId.get(id))) &&
          !y.requires.every((id) => bits & X.bitOfStage(P.byId.get(id)))).map((y) => y.id);
        out.pass = X.reissue(c, b2, c.pass.h);
        return out;
      }
      out.unlocked = [];
      if (!(bits & X.bitOfStage(st))) out.unlocked = X.solveStage(c, rec, st);
      if (out.par && rec.lt < 3) { rec.lt++; out.lantern = true; }
      X.saveSoon();
      out.pass = X.reissue(c, c.pass.s | X.recBits(P, rec), c.pass.h || Object.keys(rec.h).length > 0 || rec.lu > 0);
      return out;
    }
  };

  // final stages answer with exactly these fields and nothing else (CONTRACT 8.9)
  function finalOut(c, st, rec, result, reveal, took) {
    const P = c.P;
    const out = { ok: true, result, say: X.say(P, result), reveal };
    if (took) {
      const bits = X.progressBits(c);
      let token;
      if (c.late) token = X.reissue(c, bits | X.bitOfStage(st), c.pass.h);
      else {
        X.solveStage(c, rec, st);
        token = X.reissue(c, c.pass.s | X.recBits(P, rec), c.pass.h || Object.keys(rec.h).length > 0 || rec.lu > 0);
      }
      out.pass = token;
      out.cert = X.issueCert(c, 0);
    } else if (result === 'nottaken' && !c.late) {
      const lin = st.lineages[H.lineage(K.state, P.f, c.id, P.V)];
      X.coolMem.set(c.rk, c.t + lin.pub.attempts.cooldownMin * 60000);
    }
    return out;
  }
}
