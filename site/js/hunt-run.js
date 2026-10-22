/* hunt-run.js: the run harness for skill stages (CONTRACT 11.6, 12.8).
   Loaded on demand by hunt.js (the 404 hook) and hunt-rx.js (practice on
   the receiver). Plays window.huntSim (hunt-sim.js) at a fixed step:

     huntRun.mount(el, { stage, type, mode: 'practice'|'ranked', data, device: 'key'|'touch',
                         f, lat, startRing, onEnd(result) }) -> { stop(), pause(), ext(code), isDone() }
     huntRun.calibrate(el, done(latMs | null))

   Tick t is committed at start + (t+1)*tickMs + grace (grace = min(lat,
   tickMs)); a harness that falls behind runs catch-up ticks. Inputs go
   to the next uncommitted tick, at most two a tick. Ranked runs feed each
   server seed at the next uncommitted tick (logged as code 9), upload the
   new log entries after every draw and at least every 5 s, and end
   locally (still reported) when the tab hides, loses focus for more than
   a second, or throws. Practice uses local random seeds, never calls the
   server, and can start at any ring and pause. The sim is drawn only
   through view(); the client never reads the cfg's rules. */
(function () {
  'use strict';

  var root = document.documentElement;
  var DIR = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3 };
  var GAP = 300;          // ms between uploads (the server wants at least 200)
  var EVERY = 5000;       // upload at least this often
  var CATCHUP = 600;      // ticks run in one go at most before drawing

  function H() { return window.hunt || null; }
  function U() { var h = H(); return h && h._u ? h._u : null; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function make(tag, cls, parent, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function button(parent, label, fn, cls) {
    var b = make('button', 'hunt-btn' + (cls ? ' ' + cls : ''), parent, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function now() { return performance.now(); }
  function typing(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    return !!(t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }
  function clock(ms) {
    ms = Math.max(0, ms | 0);
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + d;
  }
  function rndHex() {
    var b = new Uint8Array(16), s = '';
    window.crypto.getRandomValues(b);
    for (var i = 0; i < 16; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function call(ep, body, f, opts) {
    var h = H();
    if (!h || !h.call) return Promise.resolve({ ok: false, error: 'lost' });
    var o = { f: f };
    if (opts && opts.keepalive) o.keepalive = true;
    return h.call(ep, body, o);
  }

  // rows of text from a view, whichever way the sim lays its cells out
  function rowsOf(v) {
    var c = v && v.cells;
    if (!Array.isArray(c)) return [];
    if (v.rows && v.cols && c.length === v.rows * v.cols && c.length !== v.rows) {
      var out = [];
      for (var r = 0; r < v.rows; r++) out.push(c.slice(r * v.cols, (r + 1) * v.cols).join(''));
      return out;
    }
    return c.map(function (x) { return String(x); });
  }

  /* ---------- screen locks ---------- */

  var locks = 0;
  function lockPage(on) {
    if (on) { if (!locks++) root.classList.add('hunt-lock'); return; }
    if (locks && !--locks) root.classList.remove('hunt-lock');
  }
  function wake(R, on) {
    if (on) {
      if (R.wl || !navigator.wakeLock || !navigator.wakeLock.request) return;
      // a page whose permissions policy forbids it: do not even ask
      var pp = document.permissionsPolicy || document.featurePolicy;
      try { if (pp && pp.allowsFeature && !pp.allowsFeature('screen-wake-lock')) return; } catch (e) { /* old engine */ }
      try {
        navigator.wakeLock.request('screen').then(function (l) {
          if (R.ended || R.paused || R.stopped) { try { l.release(); } catch (e) { /* gone */ } return; }
          R.wl = l;
        }, function () { /* not allowed here */ });
      } catch (e) { /* not allowed here */ }
      return;
    }
    if (R.wl) { try { R.wl.release(); } catch (e) { /* gone */ } R.wl = null; }
  }

  /* ---------- the run ---------- */

  function mount(el, o) {
    o = o || {};
    var sim = window.huntSim;
    var u = U();
    var ranked = o.mode === 'ranked';
    var device = o.device === 'touch' ? 'touch' : 'key';
    var data = o.data || {};
    var cfg = data.cfg;
    var EV = (sim && sim.EV) || { EAT: 1, RING: 2, DIE: 4, MARK: 8, WIN: 16, DRAW: 32, END: 64 };
    var tickMs = data.tickMs && data.tickMs[device] > 0 ? data.tickMs[device] | 0 : 120;
    var nRings = (Array.isArray(data.rings) && data.rings.length) ||
      (cfg && (Array.isArray(cfg.rings) ? cfg.rings.length : cfg.rings | 0)) || 1;
    var R = {
      st: null, t: 0, upto: -1, log: [], sentIdx: 0, sentUpto: -1, seeds: {}, supplied: 0, queue: [],
      start: 0, grace: 0, tickMs: tickMs, maxTicks: (cfg && cfg.maxTicks) || 1e9, maxDraws: (cfg && cfg.maxDraws) || 1e6,
      running: false, ended: false, paused: false, stopped: false, voided: false, runId: null, commit: null,
      inflight: null, needUp: false, lastUpAt: 0, upT: 0, pumpT: 0, blurT: 0, wl: null,
      own: { c: -1, at: 0 }, pausedAt: 0, drawn: ''
    };
    var stats = [];

    el.classList.add('hunt-run-host');
    var box = make('div', 'hunt-run', el);
    box.setAttribute('role', 'application');
    box.setAttribute('aria-roledescription', 'game');
    box.setAttribute('aria-label', (ranked ? 'ranked run' : 'practice run') + (o.type === 'final' ? ' on the field' : ''));
    box.setAttribute('data-lock', '');
    box.tabIndex = 0;
    var hud = make('p', 'hunt-run-hud', box);
    var grid = make('pre', 'hunt-run-grid', box);
    grid.setAttribute('aria-hidden', 'true');
    var msg = make('p', 'hunt-run-msg', box);
    msg.setAttribute('aria-live', 'polite');
    var panel = make('div', 'hunt-run-panel', box);
    var foot = make('p', 'hunt-run-foot', box);

    if (!sim || !cfg || typeof sim.create !== 'function') {
      msg.textContent = 'the run could not load.';
      return { stop: noopStop, pause: noop, ext: noop, isDone: function () { return true; } };
    }

    function noop() {}
    function noopStop() { if (box.parentNode) box.parentNode.removeChild(box); }

    function create(startRing) {
      var opts = { device: device };
      if (!ranked && startRing > 0) opts.startRing = startRing;
      R.st = sim.create(cfg, opts);
    }

    function ringLabel(h) {
      if (!h || typeof h.ring !== 'number') return '';
      return 'ring ' + Math.max(1, Math.min(h.ring, h.rings || nRings)) + '/' + (h.rings || nRings);
    }

    function fit() {
      var v = R.st ? sim.view(R.st) : null;
      var cols = (v && v.cols) || (cfg && cfg.cols) || 30, rows = (v && v.rows) || (cfg && cfg.rows) || 20;
      var w = Math.max(120, box.clientWidth - 8);
      var full = el.classList.contains('is-full');
      var hAvail = Math.max(160, (full ? window.innerHeight : Math.min(window.innerHeight, 720)) - 170);
      var fs = Math.min(18, w / (cols * 0.62 + 1), hAvail / (rows * 1.15 + 1));
      grid.style.fontSize = Math.max(6, Math.floor(fs * 10) / 10) + 'px';
    }

    // one row of text, split into runs of the same attribute
    function paintRows(rows, attr) {
      var key = rows.join('\n') + '\u0001' + (attr ? attr.join('') : '');
      if (key === R.drawn) return;
      R.drawn = key;
      if (!attr || attr.length !== rows.length) { grid.textContent = rows.join('\n'); return; }
      var frag = document.createDocumentFragment();
      for (var y = 0; y < rows.length; y++) {
        var line = rows[y], at = String(attr[y] || ''), i = 0;
        while (i < line.length) {
          var a = at.charAt(i) || ' ', j = i + 1;
          while (j < line.length && (at.charAt(j) || ' ') === a) j++;
          var text = line.slice(i, j);
          if (a === ' ') frag.appendChild(document.createTextNode(text));
          else make('span', 'hunt-a-' + (a === 'd' || a === 'h' || a === 'w' ? a : 'x'), frag, text);
          i = j;
        }
        if (y < rows.length - 1) frag.appendChild(document.createTextNode('\n'));
      }
      grid.textContent = '';
      grid.appendChild(frag);
    }

    function draw() {
      if (!R.st) return null;
      var v = sim.view(R.st, R.paused ? { pause: true } : undefined);
      paintRows(rowsOf(v), Array.isArray(v.attr) ? v.attr : null);
      var h = v.hud || {};
      var parts = [];
      var rl = ringLabel(h);
      if (rl) parts.push(rl);
      if (typeof h.score === 'number') parts.push('score ' + h.score + (typeof h.goal === 'number' ? '/' + h.goal : ''));
      if (typeof h.len === 'number') parts.push('len ' + h.len);
      parts.push(clock((typeof h.tick === 'number' ? h.tick : R.t) * R.tickMs));
      parts.push(ranked ? 'ranked' : (R.paused ? 'paused' : 'practice'));
      hud.textContent = parts.join(' \u00b7 ');
      var m = typeof v.msg === 'string' ? v.msg : '';
      if (msg.textContent !== m && !(R.ended && ranked)) msg.textContent = m;
      box.setAttribute('data-state', R.paused ? 'paused' : (v.state || ''));
      return v;
    }

    /* ----- input ----- */

    function input(code, mine) {
      if (!R.running || R.ended || R.paused) return;
      if (mine) R.own = { c: code, at: now() };
      if (R.queue.length >= (device === 'touch' ? 4 : 3)) return;
      R.queue.push(code);
    }
    // the same direction delivered again by the page (the 404's own key
    // and swipe handlers call back into the hook): ignore the echo
    function ext(code) {
      if (R.own.c === code && now() - R.own.at < 150) return;
      input(code, false);
    }

    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (typing(e.target)) return;
      if (!box.isConnected) return;
      var k = e.key;
      if (own(DIR, k)) {
        if (!R.running) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) input(DIR[k], true);
        return;
      }
      if (!ranked && (k === ' ' || k === 'p' || k === 'P' || k === 'Escape') && (R.running || R.paused)) {
        e.preventDefault();
        e.stopPropagation();
        if (R.paused) resume(); else pause();
      }
    }
    window.addEventListener('keydown', onKey, true);

    var ts = null;
    function onTouchStart(e) {
      if (e.touches.length !== 1) { ts = null; return; }
      ts = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    function onTouchMove(e) {
      if (R.running && e.cancelable) e.preventDefault();
    }
    function onTouchEnd(e) {
      if (!ts || !R.running) { ts = null; return; }
      var t = e.changedTouches[0], dx = t.clientX - ts.x, dy = t.clientY - ts.y;
      ts = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
      input(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0), true);
    }
    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchmove', onTouchMove, { passive: false });
    box.addEventListener('touchend', onTouchEnd, { passive: true });

    function onVis() {
      if (!document.hidden) {
        if (!ranked && R.running && !R.paused) wake(R, true);
        return;
      }
      if (!R.running || R.ended) return;
      if (ranked) finish('hidden'); else pause();
    }
    function onBlur() {
      if (!R.running || R.ended) return;
      clearTimeout(R.blurT);
      R.blurT = setTimeout(function () {
        if (document.hasFocus && document.hasFocus()) return;
        if (ranked) finish('blur'); else pause();
      }, 1000);
    }
    function onFocus() { clearTimeout(R.blurT); }
    function onHide() {
      if (R.running && !R.ended) { if (ranked) finish('hidden'); else pause(); }
    }
    function onResize() { fit(); }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('resize', onResize);
    window.addEventListener('pagehide', onHide);

    /* ----- the clock ----- */

    function tick() {
      if (ranked) {
        while (own(R.seeds, R.supplied) && R.supplied < R.maxDraws) {
          sim.seed(R.st, R.seeds[R.supplied]);
          R.log.push([R.t, 9]);
          R.supplied++;
        }
      } else {
        while (R.supplied <= sim.need(R.st) + 1 && R.supplied < R.maxDraws) {
          sim.seed(R.st, rndHex());
          R.supplied++;
        }
      }
      var fed = 0;
      while (R.queue.length && fed < 2) {
        var c = R.queue.shift();
        sim.feed(R.st, c);
        if (ranked) R.log.push([R.t, c]);
        fed++;
      }
      var ev = sim.step(R.st) | 0;
      R.upto = R.t;
      R.t++;
      if (ev & EV.DRAW) R.needUp = true;
      if (ev) {
        var s = sim.view(R.st).state;
        if (s === 'over' || s === 'won' || s === 'end') return true;
      }
      return R.t >= R.maxTicks;
    }

    function pump() {
      R.pumpT = 0;
      if (!R.running || R.ended || R.paused) return;
      var due = Math.floor((now() - R.start - R.grace) / R.tickMs);
      var n = 0, over = false;
      try {
        while (R.t < due && n < CATCHUP && !over) { over = tick(); n++; }
      } catch (err) {
        finish(ranked ? 'error' : null, true);
        return;
      }
      draw();
      if (over) { finish(null); return; }
      if (ranked && (R.needUp || now() - R.lastUpAt >= EVERY)) upload();
      var next = R.start + R.grace + (R.t + 1) * R.tickMs - now();
      R.pumpT = setTimeout(pump, n >= CATCHUP ? 0 : Math.max(0, Math.min(next, 250)));
    }

    /* ----- ranked: uploads and the end ----- */

    function upload() {
      if (!ranked || R.ended || R.voided || !R.runId) return;
      if (R.inflight) { R.needUp = true; return; }
      var since = now() - R.lastUpAt;
      if (since < GAP) {
        if (!R.upT) R.upT = setTimeout(function () { R.upT = 0; upload(); }, GAP - since);
        return;
      }
      if (R.upto < 0) return;
      var entries = R.log.slice(R.sentIdx), upto = R.upto;
      var prev = { idx: R.sentIdx, upto: R.sentUpto };
      R.sentIdx = R.log.length;
      R.sentUpto = upto;
      R.needUp = false;
      R.lastUpAt = now();
      R.inflight = call('run/seed', { run: R.runId, upto: upto, log: entries }, o.f).then(function (j) {
        R.inflight = null;
        if (R.ended) return;
        if (j && j.ok) {
          var sd = j.seeds || {};
          Object.keys(sd).forEach(function (k) {
            if (/^\d{1,6}$/.test(k) && /^[0-9a-f]{32}$/.test(sd[k])) R.seeds[+k] = sd[k];
          });
          if (R.needUp) upload();
          return;
        }
        if (j && j.error === 'lost') {
          // nothing arrived: send the same entries again with the next upload
          R.sentIdx = prev.idx;
          R.sentUpto = prev.upto;
          R.needUp = true;
          return;
        }
        voidRun(j || {});
      });
    }

    function voidRun(j) {
      R.voided = true;
      stopClock();
      draw();
      showEnd({ ok: false, result: j.error || 'rejected', say: j.say || 'that run did not come through.' });
    }

    function stopClock() {
      if (R.paused) lockPage(true);   // pause already released the lock once
      R.running = false;
      clearTimeout(R.pumpT);
      clearTimeout(R.upT);
      clearTimeout(R.blurT);
      wake(R, false);
      lockPage(false);
    }

    function finish(local, crashed) {
      if (R.ended) return;
      R.ended = true;
      var wasRunning = R.running;
      stopClock();
      try { draw(); } catch (e) { /* keep the last frame */ }
      if (!ranked) {
        if (wasRunning || R.paused) practiceEnd(crashed);
        return;
      }
      if (R.voided || !R.runId) return;
      msg.textContent = 'listening...';
      var send = function () {
        var body = { run: R.runId, upto: Math.max(0, R.upto), log: R.log.slice(R.sentIdx) };
        if (local) body.local = local;
        return call('run/end', body, o.f, { keepalive: !!local });
      };
      (R.inflight || Promise.resolve()).then(send, send).then(function (j) { showEnd(j || {}); });
    }

    function practiceEnd(crashed) {
      var v = sim.view(R.st), res = sim.result(R.st) || {};
      var ms = (res.ticks || R.t) * R.tickMs;
      if (crashed) msg.textContent = 'the run stopped.';
      var line = (res.won ? 'cleared' : 'ended') + ' · ' + (typeof res.rings === 'number' ? res.rings + '/' + nRings + ' rings' : '') +
        ' · ' + clock(ms);
      try {
        stats.push({ device: device, rings: res.rings | 0, won: res.won ? 1 : 0, ticks: res.ticks | 0, tickMs: R.tickMs, stats: sim.stats(R.st) });
      } catch (e) { /* stats are optional */ }
      saveBest('practice', { rings: res.rings | 0, won: res.won ? 1 : 0, ms: ms });
      endScreen([line], v);
      if (o.onEnd) o.onEnd({ mode: 'practice', result: res.won ? 'cleared' : 'failed', rings: res.rings | 0, ms: ms });
    }

    function saveBest(kind, r) {
      var u2 = U();
      if (!u2 || !o.f || !o.stage) return;
      var b = u2.lsJson('hunt.best.' + o.f) || {};
      var s = b[o.stage] = b[o.stage] || {};
      var cur = s[kind];
      var better = !cur || (r.won && !cur.won) || (r.won === cur.won && (r.rings > cur.rings || (r.rings === cur.rings && r.ms < cur.ms)));
      if (better) { r.at = Date.now(); s[kind] = r; u2.lsPut('hunt.best.' + o.f, b); }
    }

    function showEnd(j) {
      if (ranked) msg.textContent = '';
      var lines = [];
      var res = j.result || j.error || 'rejected';
      lines.push(j.say || (res === 'lost' ? 'that did not come through.' : res));
      if (o.type !== 'final' && j.ok) {
        if (typeof j.rings === 'number') lines.push(j.rings + '/' + nRings + ' rings' + (typeof j.ms === 'number' ? ' · ' + clock(j.ms) : ''));
        if (j.par) lines.push('under par.');
        if (j.lantern) lines.push('a lantern is lit.');
        if (typeof j.rings === 'number') saveBest('ranked', { rings: j.rings, won: res === 'cleared' ? 1 : 0, ms: j.ms | 0 });
      }
      if (j.ok && res === 'took') lines.push('the receiver has your certificate.');
      endScreen(lines, null);
      if (j.ok && typeof j.reveal === 'string') checkSeals(j.reveal);
      if (o.onEnd) o.onEnd({ mode: 'ranked', result: res, ok: !!j.ok, say: j.say || '', unlocked: j.unlocked || [] });
    }

    // the commit and every seed, checked against the revealed secret
    function checkSeals(secretHex) {
      var u2 = U(), key = u2 && u2.hexBytes(secretHex);
      if (!u2 || !key || !R.commit) return;
      var line = make('p', 'hunt-run-seal', panel, 'checking the seals...');
      u2.sha256hex('run|' + R.runId + '|' + secretHex).then(function (h) {
        if (h !== R.commit) return false;
        var ks = Object.keys(R.seeds);
        return Promise.all(ks.map(function (k) {
          return u2.hmacHex(key, 'draw|' + k).then(function (x) { return x.slice(0, 32) === R.seeds[k]; });
        })).then(function (all) { return all.every(Boolean); });
      }).then(function (ok) {
        line.textContent = ok ? 'the seals hold: every draw was fixed before the run.' : 'a seal does not match.';
      }, function () { line.textContent = 'the seals could not be checked here.'; });
    }

    function endScreen(lines, v) {
      void v;
      panel.textContent = '';
      var out = make('div', 'hunt-run-end', panel);
      lines.forEach(function (l) { if (l) make('p', null, out, l); });
      if (!ranked) {
        var bar = make('div', 'hunt-run-bar', panel);
        button(bar, 'again', function () { restart(); }, 'is-hi');
        statsButton(bar);
      }
      foot.textContent = ranked ? '' : 'practice never reaches the server.';
    }

    function statsButton(bar) {
      var st = U() && U().status();
      if (!st || !st.sandbox || !stats.length) return;
      button(bar, 'export practice stats', function () {
        var blob = JSON.stringify({ v: 1, kind: 'practice-stats', stage: o.stage || null, at: new Date().toISOString(), runs: stats }, null, 1);
        try {
          var a = make('a', null, document.body);
          a.href = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
          a.download = 'practice-stats-' + (o.stage || 'run') + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        } catch (e) {
          var ta = make('textarea', 'hunt-ta', panel);
          ta.readOnly = true;
          ta.value = blob;
        }
      }, 'is-dim');
    }

    /* ----- start, pause, stop ----- */

    function begin() {
      R.running = true;
      R.start = now();
      R.grace = Math.max(0, Math.min(o.lat | 0, R.tickMs));
      lockPage(true);
      wake(R, true);
      panel.textContent = '';
      if (!ranked) {
        var bar = make('div', 'hunt-run-bar', panel);
        button(bar, 'pause', function () { if (R.paused) resume(); else pause(); });
        button(bar, 'stop', function () { finish(null); }, 'is-dim');
      }
      foot.textContent = (device === 'touch' ? 'swipe to steer' : 'arrows or wasd steer') +
        (ranked ? ' · leaving this tab ends the run' : ' · ' + (device === 'touch' ? 'pause below' : 'p or space pauses'));
      try { box.focus({ preventScroll: true }); } catch (e) { /* old engine */ }
      try { box.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old engine */ }
      fit();
      draw();
      pump();
    }

    function countdown(n, then) {
      if (R.stopped) return;
      if (n <= 0) { then(); return; }
      msg.textContent = String(n);
      setTimeout(function () { countdown(n - 1, then); }, 650);
    }

    function startRanked() {
      panel.textContent = '';
      countdown(3, function () {
        msg.textContent = 'listening...';
        call('run/start', { stage: o.stage, device: device, lat: Math.max(0, Math.min(o.lat | 0, 1000)) }, o.f).then(function (j) {
          if (R.stopped) return;
          if (!j || !j.ok || typeof j.run !== 'string') {
            R.ended = true;
            msg.textContent = '';
            showEnd({ ok: false, result: (j && j.error) || 'lost', say: (j && j.say) || 'that did not come through.' });
            return;
          }
          R.runId = j.run;
          R.commit = typeof j.commit === 'string' ? j.commit : null;
          if (j.tickMs > 0) R.tickMs = j.tickMs | 0;
          if (j.maxTicks > 0) R.maxTicks = j.maxTicks | 0;
          if (j.maxDraws > 0) R.maxDraws = j.maxDraws | 0;
          (Array.isArray(j.seeds) ? j.seeds : []).forEach(function (s, k) {
            if (/^[0-9a-f]{32}$/.test(s)) R.seeds[k] = s;
          });
          R.lastUpAt = now();
          msg.textContent = '';
          begin();
        });
      });
    }

    function pause() {
      if (ranked || !R.running || R.paused || R.ended) return;
      R.paused = true;
      R.pausedAt = now();
      clearTimeout(R.pumpT);
      wake(R, false);
      lockPage(false);
      draw();
      var b = panel.querySelector('.hunt-btn');
      if (b) b.textContent = 'resume';
    }
    function resume() {
      if (!R.paused || R.ended) return;
      R.paused = false;
      R.start += now() - R.pausedAt;
      wake(R, true);
      lockPage(true);
      var b = panel.querySelector('.hunt-btn');
      if (b) b.textContent = 'pause';
      pump();
    }

    function ready() {
      create(o.startRing | 0);
      fit();
      draw();
      panel.textContent = '';
      var bar = make('div', 'hunt-run-bar', panel);
      var sel = null;
      if (!ranked && nRings > 1) {
        var lab = make('label', 'hunt-run-ring', bar);
        make('span', null, lab, 'start at ring ');
        sel = make('select', 'hunt-sel', lab);
        for (var i = 0; i < nRings; i++) {
          var op = make('option', null, sel, String(i + 1));
          op.value = String(i);
        }
        sel.value = String(o.startRing | 0);
        sel.addEventListener('change', function () { o.startRing = +sel.value; create(+sel.value); draw(); });
      }
      var go = button(bar, ranked ? 'start the ranked run' : 'start', function () {
        if (ranked) startRanked(); else begin();
      }, 'is-hi');
      msg.textContent = '';
      foot.textContent = ranked ? 'ranked: from the first ring, no pause; the server replays it.' : 'practice: local, unlimited.';
      try { go.focus({ preventScroll: true }); } catch (e) { /* old engine */ }
    }

    function restart() {
      R.t = 0; R.upto = -1; R.log = []; R.sentIdx = 0; R.sentUpto = -1; R.seeds = {}; R.supplied = 0; R.queue = [];
      R.running = false; R.ended = false; R.paused = false; R.voided = false;
      ready();
    }

    function stop() {
      if (R.stopped) return;
      if (R.running && !R.ended) finish(ranked ? 'error' : null);
      R.stopped = true;
      stopClock();
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', onHide);
      if (box.parentNode) box.parentNode.removeChild(box);
      el.classList.remove('hunt-run-host');
    }

    ready();
    return {
      stop: stop,
      pause: pause,
      ext: ext,
      isDone: function () { return R.ended || R.stopped || !R.running; }
    };
  }

  /* ---------- calibration: a short beat test ---------- */

  function calibrate(el, done) {
    var BEAT = 600, N = 10, LEAD = 1200;
    var box = make('div', 'hunt-cal', el);
    box.setAttribute('role', 'application');
    box.setAttribute('data-lock', '');
    box.tabIndex = 0;
    make('p', 'hunt-run-hud', box, 'calibration');
    make('p', 'hunt-cal-say', box, 'press any key or tap here on every beat.');
    var ind = make('pre', 'hunt-cal-beat', box, '[   ]');
    ind.setAttribute('aria-hidden', 'true');
    var cnt = make('p', 'hunt-cal-n', box, '');
    cnt.setAttribute('aria-live', 'polite');
    var bar = make('div', 'hunt-run-bar', box);
    var t0 = 0, presses = [], timers = [], over = false;

    function finish(ms) {
      if (over) return;
      over = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey, true);
      box.removeEventListener('pointerdown', onPtr);
      if (box.parentNode) box.parentNode.removeChild(box);
      done(ms);
    }
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e.target)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
      if (!t0) return;
      e.preventDefault();
      e.stopPropagation();
      presses.push(now());
    }
    function onPtr(e) {
      if (!t0 || (e.target && e.target.closest && e.target.closest('button'))) return;
      presses.push(now());
    }
    window.addEventListener('keydown', onKey, true);
    box.addEventListener('pointerdown', onPtr);
    button(bar, 'skip', function () { finish(null); }, 'is-dim');

    function result() {
      var beats = [];
      for (var i = 2; i < N; i++) beats.push(t0 + i * BEAT);
      var offs = [];
      presses.forEach(function (p) {
        var best = null;
        beats.forEach(function (b) { if (best === null || Math.abs(p - b) < Math.abs(best)) best = p - b; });
        if (best !== null && best > -250 && best < 400) offs.push(best);
      });
      if (offs.length < 4) {
        cnt.textContent = 'too few beats caught. try again or skip.';
        bar.textContent = '';
        button(bar, 'again', function () { var p = el; finish2(); calibrate(p, done); }, 'is-hi');
        button(bar, 'skip', function () { finish(null); }, 'is-dim');
        return;
      }
      offs.sort(function (a, b) { return a - b; });
      var med = offs[offs.length >> 1];
      var lat = Math.max(0, Math.min(250, Math.round(med)));
      cnt.textContent = 'grace ' + lat + ' ms';
      bar.textContent = '';
      button(bar, 'continue', function () { finish(lat); }, 'is-hi');
    }
    function finish2() {
      over = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey, true);
      if (box.parentNode) box.parentNode.removeChild(box);
    }

    timers.push(setTimeout(function () {
      t0 = now();
      for (var i = 0; i < N; i++) {
        (function (k) {
          timers.push(setTimeout(function () {
            ind.textContent = '[ # ]';
            cnt.textContent = 'beat ' + (k + 1) + '/' + N;
            timers.push(setTimeout(function () { ind.textContent = '[   ]'; }, 140));
          }, k * BEAT));
        })(i);
      }
      timers.push(setTimeout(result, N * BEAT + 300));
    }, LEAD));
    try { box.focus({ preventScroll: true }); } catch (e) { /* old engine */ }
  }

  window.huntRun = { mount: mount, calibrate: calibrate };
})();
