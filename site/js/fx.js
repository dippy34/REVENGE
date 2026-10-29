/* fx.js: shared visual effects, self-written, no dependencies.
   Everything here is decoration. Pages stay usable if it never runs.

   window.fx, for page scripts:
     scramble(el, opts)   churn the text, then resolve back to it
     decode(el, opts)     one-shot reveal from noise, left to right
     glitch(el)           short sliced-offset glitch
     reduced()            true when the visitor prefers reduced motion
     rain.pause() / rain.resume() / rain.burst(x, y, strength)
     burst(x, y, strength)  the same shockwave (strength 1 = a click)
     tier()               'high' | 'mid' | 'low', the effects level
                          (extra low runs as 'low'; level() tells them apart)
     level()              tier(), or 'xlow' for extra low
     setTier(t)           'high' | 'mid' | 'low' | 'xlow' (kept) or 'auto'
                          (forget and measure again); every change sets
                          html[data-fx] and fires window 'fx:tier'; into
                          or out of 'xlow' reloads the page
     perf()               what the tier was decided from (debugging)
     hold(on)             freeze the rain and the mask (and the tier
                          watchdog) while something covers the screen;
                          separate from rain.pause(), which pages use per
                          route. html.egg-busy also pauses the watchdog.
     obj.glitch() / obj.blink() / obj.wake(on) / obj.rect()
                          the ASCII mask; rect() is its box or null
   Delegated, so it also works on elements added later:
     [data-scramble]      churns when it (or the control around it) is
                          hovered or focused
     a[href], button, [role=link], label, [data-lock]
                          the cursor locks corner brackets onto it
     [data-nolock]        no lock inside; the ring just grows
     [data-cursor="txt"]  tiny label next to the cursor
   Also: canvas#rain and canvas[data-obj] on any page, [data-tilt],
   [data-digest] / [data-churn], [data-decode], [data-clock], [data-potato]. */
(function () {
  'use strict';

  var root = document.documentElement;
  var page = root.getAttribute('data-page') || '';
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqFine = window.matchMedia('(hover: hover) and (pointer: fine)');
  // extra low (html.fx-xlow, picked in the potato menu) counts as reduced motion
  function reduced() { return mqReduce.matches || root.classList.contains('fx-xlow'); }
  function onChange(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else if (mq.addListener) mq.addListener(fn);
  }
  function noop() {}
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function now() { return performance.now(); }

  // Glyph pools. SYM only uses characters the bundled font has, so text
  // keeps its width while scrambling. GLY is the rain's atlas order.
  var HEX = '0123456789abcdef';
  var SYM = HEX + '#%&*+=<>/\\|_-:;';
  var GLY = HEX + ':.=*+-<>|';

  function pick(pool) { return pool.charAt((Math.random() * pool.length) | 0); }

  function make(tag, cls, parent) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }
  function quiet(el) { el.setAttribute('aria-hidden', 'true'); return el; }
  function tr(x, y) { return 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'; }

  /* ---------- the hunt ---------- */

  // hunt.js loads after this file and stays inert unless a frequency is
  // live or a receiver exists. Events queue until it has run; every call is
  // guarded, so without it nothing here changes.
  function hunt() { return window.hunt || null; }
  function huntEv(c) {
    var h = hunt();
    if (h && h.event) { try { h.event(c); } catch (e) { /* ignore */ } return; }
    var q = window.huntEvQ = window.huntEvQ || [];
    if (q.length >= 48 && q.shift) q.shift();
    q.push(c);
  }
  function huntDo(name, a) {
    var h = hunt();
    if (!h || typeof h[name] !== 'function') return null;
    try { return h[name](a); } catch (e) { return null; }
  }
  function huntReady(fn) { (window.huntQ = window.huntQ || []).push(fn); }

  /* ---------- shared pointer ---------- */

  // One listener feeds the cursor, the rain lens, the tilt and the glyph
  // object. nx / ny run from -1 to 1 across the viewport.
  var ptr = { x: -9999, y: -9999, nx: 0, ny: 0, on: false };
  var ptrFns = [];
  document.addEventListener('pointermove', function (e) {
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    ptr.nx = clamp(e.clientX / (window.innerWidth || 1) * 2 - 1, -1, 1);
    ptr.ny = clamp(e.clientY / (window.innerHeight || 1) * 2 - 1, -1, 1);
    ptr.on = e.pointerType === 'mouse';
    for (var i = 0; i < ptrFns.length; i++) ptrFns[i](e);
  }, { passive: true });
  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget) ptr.on = false;
  });

  /* ---------- effects tier ---------- */

  // early.js picked a starting tier before first paint (html[data-fx]):
  // the visitor's override, a cached measurement, or a guess from device
  // hints. Here a guess is measured (a short probe after load) and every
  // tier is watched (a light check every few seconds that only ever steps
  // down, so it never ping-pongs). Effects read tier() and subscribe with
  // onTier(); CSS keys off html[data-fx].
  var ORDER = ['low', 'mid', 'high'];
  var tb = root._fxBoot || {};
  var tierNow = ORDER.indexOf(tb.tier) < 0 ? 'high' : tb.tier;
  var tierSrc = tb.src || 'hint';
  var tierFns = [];
  var perfLog = { start: tierNow, src: tierSrc, hint: tb.hint || 0, bench: null, probe: null, watch: null, steps: [] };
  root.setAttribute('data-fx', tierNow);

  function tier() { return tierNow; }
  // the level the visitor sees: a tier, or 'xlow' (extra low: the low tier
  // with nothing moving, html.fx-xlow; only ever picked, never measured)
  function level() { return root.classList.contains('fx-xlow') ? 'xlow' : tierNow; }
  function onTier(fn) { tierFns.push(fn); }
  function hi() { return tierNow === 'high'; }
  function lo() { return tierNow === 'low'; }
  function applyTier(t, why) {
    if (ORDER.indexOf(t) < 0 || t === tierNow) return;
    perfLog.steps.push(tierNow + '>' + t + ' ' + why + ' @' + Math.round(now()) + 'ms');
    tierNow = t;
    root.setAttribute('data-fx', t);
    for (var i = 0; i < tierFns.length; i++) {
      try { tierFns[i](t); } catch (e) { /* one effect failing must not stop the rest */ }
    }
    var ev;
    try { ev = new CustomEvent('fx:tier', { detail: t }); } catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('fx:tier', false, false, t);
    }
    window.dispatchEvent(ev);
    huntEv('fx:' + t);
  }
  // weak: measured on a page that draws no canvas, so the frames said
  // little about our effects; the next page with the mask measures again
  function remember(t, weak) {
    var c = { tier: t, at: Date.now(), sc: tb.sc || '' };
    if (weak) c.weak = true;
    try { localStorage.setItem('fx.tier', JSON.stringify(c)); } catch (e) { /* blocked */ }
  }
  // A kept choice ('high' / 'mid' / 'low' / 'xlow') wins until 'auto', which
  // also forgets the measurement and probes again from the hints. Extra low
  // changes what reduced() says, which effects read as they start, so going
  // into or out of it reloads the page.
  function setTier(t) {
    var wasX = root.classList.contains('fx-xlow');
    if (t === 'auto') {
      try {
        localStorage.removeItem('fx.tier.force');
        localStorage.removeItem('fx.tier');
      } catch (e) { /* blocked */ }
      if (wasX) { location.reload(); return; }
      tierSrc = 'hint';
      applyTier(tb.guess || 'high', 'auto');
      probe(300);
      return;
    }
    if (t !== 'xlow' && ORDER.indexOf(t) < 0) return;
    try { localStorage.setItem('fx.tier.force', t); } catch (e) { /* blocked */ }
    if (t === 'xlow' || wasX) { location.reload(); return; }
    tierSrc = 'force';
    applyTier(t, 'set');
  }

  // Time spent drawing the canvases, so the meter can tell "our effects are
  // expensive here" apart from a browser that simply runs at 30 Hz.
  var costMs = 0;
  function cost(t0) { costMs += now() - t0; }

  // A fixed bit of arithmetic, the second fastest of five runs (~0.8 ms
  // on a fast laptop, up to ~2 when it is busy, 2.5-3.5 at 4x slower,
  // 4-5.5 at 6x): a rough CPU
  // speed that does not depend on which effects happen to be running. It
  // runs in an idle moment and drops the slowest runs, so a page still
  // busy loading (the games list, the feed) cannot make the device look
  // slower than it is; not the very fastest, which can dodge the stalls
  // a throttled or busy CPU really has.
  function bench() {
    var runs = [], x = 0;
    for (var r = 0; r < 5; r++) {
      var t0 = now(), a = [];
      for (var i = 0; i < 100000; i++) {
        x += Math.sqrt(i) * Math.sin(i * 0.01);
        if ((i & 63) === 0) a.push(x);
      }
      a.sort(function (p, q) { return p - q; });
      runs.push(now() - t0);
    }
    runs.sort(function (p, q) { return p - q; });
    return x === 0.5 ? 0 : runs[1]; // keep x alive for the optimiser
  }

  // Frame times for `ms`, then cb(stats). Deltas are clipped so a stall
  // or a hidden tab cannot dominate; a hidden tab voids the sample.
  function sample(ms, cb) {
    var ts = [], t0 = now(), c0 = costMs, lt = 0, po = null, gone = false;
    try {
      po = new PerformanceObserver(function (l) {
        var es = l.getEntries();
        for (var i = 0; i < es.length; i++) lt += es[i].duration;
      });
      po.observe({ type: 'longtask' });
    } catch (e) { po = null; }
    function hid() { gone = true; }
    document.addEventListener('visibilitychange', hid);
    requestAnimationFrame(function f(t) {
      ts.push(t);
      if (t - t0 < ms && !gone) { requestAnimationFrame(f); return; }
      if (po) po.disconnect();
      document.removeEventListener('visibilitychange', hid);
      var span = now() - t0;
      if (gone || ts.length < 8) { cb(null); return; }
      var d = [];
      for (var i = 1; i < ts.length; i++) d.push(Math.min(250, ts[i] - ts[i - 1]));
      d.sort(function (p, q) { return p - q; });
      var sum = 0;
      for (var j = 0; j < d.length; j++) sum += d[j];
      // the refresh interval this browser is really giving us (60 / 120
      // Hz, or 30 in a power-saving mode), and how many frames miss it.
      // slow counts the frames a person would see drop: late, and at
      // least ~24 ms (so a 120 Hz screen sliding to 60 is not a stutter)
      var base = clamp(d[(d.length * 0.1) | 0], 6, 40), late = 0, slow = 0;
      var lag = Math.max(base * 1.5 + 2, 24);
      for (var k = 0; k < d.length; k++) {
        if (d[k] > base * 1.5 + 2) late++;
        if (d[k] > lag) slow++;
      }
      cb({
        mean: sum / d.length,
        med: d[d.length >> 1],
        p90: d[(d.length * 0.9) | 0],
        p95: d[Math.min(d.length - 1, (d.length * 0.95) | 0)],
        base: base,
        lag: lag,
        jank: late / d.length,
        slow: slow / d.length,
        cost: (costMs - c0) / span,
        long: lt / span
      });
    });
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function brief(s) {
    return s && { mean: r2(s.mean), med: r2(s.med), p90: r2(s.p90), p95: r2(s.p95), base: r2(s.base), jank: r2(s.jank), slow: r2(s.slow), cost: r2(s.cost), long: r2(s.long) };
  }

  // Run fn once the page has a quiet moment (or after a while anyway);
  // Safari has no requestIdleCallback.
  function whenIdle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 1200);
  }

  // First visit (or after 'auto'): hints + CPU speed + two seconds of
  // frames decide the tier, which is then cached for a few days. The CPU
  // check waits for an idle moment so page-load work does not skew it.
  function probe(delay) {
    setTimeout(function () {
      if (tierSrc !== 'hint') return;
      whenIdle(function () {
        if (tierSrc !== 'hint') return;
        var b = bench();
        perfLog.bench = r2(b);
        sample(2000, function (s) {
          if (tierSrc !== 'hint') return;
          if (!s) { probe(1500); return; }
          perfLog.probe = brief(s);
          var drew = s.cost > 0;
          // device hints never decide alone: a quick CPU with clean frames
          // caps what they can take away
          var clean = drew && b <= 2.4 && s.jank < 0.1 && s.cost < 0.15 && s.long < 0.1;
          var p = clean ? Math.max(tb.hint || 0, -2) : (tb.hint || 0);
          p -= b > 3.6 ? 3 : b > 2.4 ? 2 : b > 2 ? 1 : 0;
          p -= s.cost > 0.35 ? 2 : s.cost > 0.2 ? 1 : 0;
          p -= s.jank > 0.35 ? 2 : s.jank > 0.15 ? 1 : 0;
          p -= s.long > 0.25 ? 1 : 0;
          // clearly smooth and quick while our canvases were drawing: let
          // one weak hint go (a page that draws none proves nothing)
          if (drew && b <= 2 && s.jank < 0.05 && s.cost < 0.08 && s.long < 0.05) p += 1;
          perfLog.points = p;
          var t = p >= -1 ? 'high' : p >= -3 ? 'mid' : 'low';
          tierSrc = 'probe';
          applyTier(t, 'probe');
          // a quick CPU that still fell short was probably a busy moment:
          // keep the result provisional so the next mask page measures again
          remember(t, !drew || (t !== 'high' && b < 3));
          onMeasured();
        });
      });
    }, delay);
  }

  // Something full-screen on top (an easter egg, a reboot screen) can ask
  // for the rain and the mask to stand still, and the watchdog to look
  // away, without touching a page's own rain.pause() state.
  var held = false, holdFns = [];
  function hold(on) {
    on = !!on;
    if (on === held) return;
    held = on;
    root.classList.toggle('fx-held', on);
    for (var i = 0; i < holdFns.length; i++) {
      try { holdFns[i](on); } catch (e) { /* keep going */ }
    }
  }
  // frames that are not ours to judge: a video, a game, a proxied page,
  // an egg that owns the screen, a frozen shell, leaving
  function busy() {
    var c = root.classList;
    return held || document.hidden || c.contains('playing') || c.contains('browsing') ||
      c.contains('leaving') || c.contains('egg-busy');
  }

  // Afterwards: two seconds out of every five. Two bad samples in a row
  // step down one tier (and cache it); stepping back up waits for the
  // next measurement in a few days. A sample is bad when frames are slow
  // on average, or when a steady few of them visibly drop (a feed that
  // stutters while it scrolls), or our canvases eat the frame. A short
  // burst (a click shockwave, one egg) cannot fill two samples in a row.
  // Nothing is judged while busy() (those frames are not ours), or when
  // the visitor picked a tier.
  function judge(s) {
    return s.jank > 0.3 || s.mean > s.base * 1.5 || s.cost > 0.35 || s.long > 0.3 ||
      (s.p95 > s.lag && (s.slow > 0.07 || s.long > 0.05));
  }
  function watchdog() {
    var bad = 0, rest = 0;
    (function next() {
      setTimeout(function () {
        if (tierSrc === 'force' || tierSrc === 'hint' || lo() || reduced() || busy()) { next(); return; }
        sample(2000, function (s) {
          // an egg or a video that started during the sample voids it
          if (s && !busy() && tierSrc !== 'force' && tierSrc !== 'hint') {
            perfLog.watch = brief(s);
            if (rest > 0) rest--;
            else if (judge(s)) bad++;
            else bad = 0;
            if (bad >= 2) {
              bad = 0;
              rest = 2; // let the lighter effects settle before judging again
              var t = ORDER[Math.max(0, ORDER.indexOf(tierNow) - 1)];
              applyTier(t, 'watchdog');
              remember(t);
            }
          }
          next();
        });
      }, 3000);
    })();
  }

  /* ---------- text: scramble and decode ---------- */

  // Churns the text of `el` through random glyphs, then resolves it left to
  // right back to the original. The original is cached on first use, and
  // picked up again if something else changed the text since.
  function scramble(el, opts) {
    if (!el) return;
    opts = opts || {};
    stopDecode(el);
    if (el._final == null || (!el._raf && el._shown != null && el.textContent !== el._shown)) {
      el._final = el.textContent;
    }
    var final = el._final;
    if (el._raf) cancelAnimationFrame(el._raf);
    el._raf = 0;
    if (reduced()) {
      el.textContent = final;
      el._shown = final;
      if (opts.done) opts.done();
      return;
    }

    var dur = (opts.duration || 600) * (lo() ? 0.6 : 1);
    var pool = opts.pool || SYM;
    var n = final.length;
    var start = now();
    var last = -Infinity;
    var at = [];
    for (var i = 0; i < n; i++) {
      at[i] = dur * (0.25 + 0.75 * (i / n)) * (0.7 + Math.random() * 0.3);
    }

    (function frame(t0) {
      // ~22fps updates read as a terminal rather than a smooth tween
      if (t0 - last >= 45) {
        last = t0;
        var t = t0 - start;
        var out = '';
        var done = true;
        for (var j = 0; j < n; j++) {
          var c = final.charAt(j);
          if (c === ' ' || t >= at[j]) out += c;
          else { out += pick(pool); done = false; }
        }
        el.textContent = out;
        if (done) {
          el._raf = 0;
          el._shown = final;
          if (opts.done) opts.done();
          return;
        }
      }
      el._raf = requestAnimationFrame(frame);
    })(start);
  }

  function stopDecode(el) {
    var d = el && el._dec;
    if (!d) return;
    el._dec = null;
    cancelAnimationFrame(d.raf);
    for (var i = 0; i < d.nodes.length; i++) d.nodes[i].nodeValue = d.finals[i];
  }

  // One-shot reveal: every character starts as noise and settles, left to
  // right, into the real text. Walks all text nodes, so markup inside stays
  // intact. opts: duration, delay (noise churns meanwhile), pool, done.
  function decode(el, opts) {
    if (!el) return;
    opts = opts || {};
    stopDecode(el);
    if (el._raf) {
      cancelAnimationFrame(el._raf);
      el._raf = 0;
      if (el._final != null) el.textContent = el._final;
    }
    var nodes = [], finals = [], total = 0, n;
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    while ((n = walk.nextNode())) {
      if (!/\S/.test(n.nodeValue)) continue;
      nodes.push(n);
      finals.push(n.nodeValue);
      total += n.nodeValue.length;
    }
    if (!el.firstElementChild) {
      el._final = el.textContent;
      el._shown = el._final;
    }
    if (!nodes.length || reduced()) {
      if (opts.done) opts.done();
      return;
    }

    var dur = (opts.duration || clamp(total * 32, 420, 1300)) * (lo() ? 0.6 : 1);
    var pool = opts.pool || SYM;
    var at = [], k = 0;
    for (var i = 0; i < nodes.length; i++) {
      at[i] = [];
      for (var j = 0; j < finals[i].length; j++, k++) {
        at[i][j] = dur * (0.12 + 0.88 * (k / total)) * (0.78 + Math.random() * 0.22);
      }
    }
    var d = { nodes: nodes, finals: finals, raf: 0 };
    el._dec = d;
    var start = now() + (opts.delay || 0);
    var last = -Infinity;

    function paint(t) {
      var done = true;
      for (var a = 0; a < nodes.length; a++) {
        var f = finals[a], out = '';
        for (var b = 0; b < f.length; b++) {
          var c = f.charAt(b);
          if (c === ' ' || c === '\n' || t >= at[a][b]) out += c;
          else { out += pick(pool); done = false; }
        }
        nodes[a].nodeValue = out;
      }
      return done;
    }
    paint(-1); // noise right away, so the real text never flashes first
    var born = now(), prev = born;
    (function frame(t0) {
      if (el._dec !== d) return;
      if (!el.isConnected) {
        // built before it was inserted: hold the reveal until it shows up,
        // and never leave noise behind if it never does
        start += t0 - prev;
        prev = t0;
        if (t0 - born > 4000) { stopDecode(el); if (opts.done) opts.done(); return; }
        d.raf = requestAnimationFrame(frame);
        return;
      }
      prev = t0;
      if (t0 - last >= 45) {
        last = t0;
        if (paint(t0 - start)) {
          el._dec = null;
          if (opts.done) opts.done();
          return;
        }
      }
      d.raf = requestAnimationFrame(frame);
    })(now());
  }

  /* ---------- glitch ---------- */

  function glitch(el) {
    if (!el || reduced() || el.classList.contains('is-glitching')) return;
    if (!el.hasAttribute('data-text')) el.setAttribute('data-text', (el.textContent || '').trim());
    el.classList.add('is-glitching');
    setTimeout(function () { el.classList.remove('is-glitching'); }, 520);
  }

  /* ---------- delegated hover scramble ---------- */

  // [data-scramble] works on elements added at any time: hovering or
  // focusing the control around it (or the element itself) churns it.
  var HOST = 'a[href], button, [role="link"], [role="button"], label, [tabindex]:not([tabindex="-1"])';
  function hostOf(t) {
    if (!t || !t.closest) return null;
    return t.closest(HOST) || t.closest('[data-scramble]');
  }
  // The visible text of a control, skipping aria-hidden parts and reading
  // a label that is mid-scramble as the word it resolves to.
  function nameOf(host) {
    var out = '', n;
    var walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
    while ((n = walk.nextNode())) {
      var p = n.parentNode, hid = p.closest && p.closest('[aria-hidden="true"]');
      if (hid && host.contains(hid)) continue;
      out += p._raf && p._final != null ? p._final : n.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // While the labels churn, the control keeps its real name for screen
  // readers: a temporary aria-label, removed again once the text settles.
  function holdName(host, ms) {
    if (!host.matches(HOST)) return;
    if (!host._fxName) {
      if (host.hasAttribute('aria-label') || host.hasAttribute('aria-labelledby')) return;
      var nm = nameOf(host);
      if (!nm) return;
      host.setAttribute('aria-label', nm);
      host._fxName = nm;
    }
    clearTimeout(host._fxT);
    host._fxT = setTimeout(function () {
      if (host.getAttribute('aria-label') === host._fxName) host.removeAttribute('aria-label');
      host._fxName = null;
    }, ms + 120);
  }

  function churnHost(host, from) {
    if (from && from.nodeType === 1 && host.contains(from)) return; // moved inside it
    var list = host.hasAttribute('data-scramble') ? [host] : [];
    var inner = host.querySelectorAll('[data-scramble]');
    for (var i = 0; i < inner.length; i++) {
      // skip labels that belong to a nested control of their own
      if (hostOf(inner[i]) === host || hostOf(inner[i]) === inner[i]) list.push(inner[i]);
    }
    var go = [];
    for (var j = 0; j < list.length; j++) if (!list[j]._dec) go.push(list[j]);
    // still decoding in: its text is noise, so leave the name alone
    if (go.length && go.length === list.length) holdName(host, 380);
    for (var k = 0; k < go.length; k++) scramble(go[k], { duration: 380 });
  }
  function initScramble() {
    function on(e) {
      var h = hostOf(e.target);
      if (h) churnHost(h, e.relatedTarget);
    }
    document.addEventListener('pointerover', on);
    document.addEventListener('focusin', on);
  }

  /* ---------- falling-glyph background ---------- */

  // Three depth layers of glyph trails, drawn from a pre-rendered glyph
  // atlas (drawImage is far cheaper than fillText). Heads glow, trails
  // mutate, glyphs near the pointer swell and brighten (a lens), layers
  // drift against the pointer for parallax, and a click sends a shockwave
  // through them. 30fps at most, paused in background tabs, and a single
  // still frame under reduced motion. Lower tiers thin the layers out,
  // drop the lens and the frame rate (low barely moves, but a shockwave
  // still plays at full rate while it lasts).
  var rain = (function () {
    var cv = document.getElementById('rain');
    var ctx = cv && cv.getContext && cv.getContext('2d', { alpha: false });
    if (!ctx) return { pause: noop, resume: noop, burst: noop };

    var LENS = 150;
    var WAVE = 1100; // ms a shockwave lives; it travels ~1px per ms
    var LAYERS = [
      { size: 11, alpha: 0.16, speed: [0.16, 0.36], density: 0.5, len: [12, 30], par: 5 },
      { size: 15, alpha: 0.32, speed: [0.26, 0.56], density: 0.27, len: [9, 22], par: 11 },
      { size: 21, alpha: 0.44, speed: [0.42, 0.8], density: 0.06, len: [6, 14], par: 22 }
    ];
    // per tier: share of each layer's drops, frames per second, lens
    var TQ = {
      high: { dens: [1, 1, 1], fps: 30, lens: true },
      mid: { dens: [0.4, 0.65, 1], fps: 24, lens: false },
      low: { dens: [0.14, 0.45, 1], fps: 8, lens: false }
    };
    var atlas = [], drops = [], waves = [];
    var w = 0, h = 0, dpr = 1, raf = 0, last = 0, paused = false;
    var px = 0, py = 0; // smoothed parallax, -1..1

    function glyph() {
      return Math.random() < 0.82 ? (Math.random() * 16) | 0 : 16 + ((Math.random() * (GLY.length - 16)) | 0);
    }

    // Row 0: plain white glyphs. Row 1: the same with a halo, for heads.
    function buildAtlas() {
      atlas = LAYERS.map(function (L) {
        var s = L.size, pad = Math.ceil(s * 0.7);
        var cw = Math.ceil(s * 0.62) + pad * 2, ch = Math.ceil(s * 1.2) + pad * 2;
        var c = document.createElement('canvas');
        c.width = Math.ceil(cw * GLY.length * dpr);
        c.height = Math.ceil(ch * 2 * dpr);
        var g = c.getContext('2d');
        g.scale(dpr, dpr);
        g.font = s + 'px M, ui-monospace, Menlo, monospace';
        g.textBaseline = 'top';
        g.fillStyle = '#fff';
        for (var i = 0; i < GLY.length; i++) g.fillText(GLY.charAt(i), i * cw + pad, pad);
        g.shadowColor = 'rgba(255,255,255,.95)';
        g.shadowBlur = s * 0.8 * dpr; // shadows ignore the transform
        for (var j = 0; j < GLY.length; j++) {
          g.fillText(GLY.charAt(j), j * cw + pad, ch + pad);
          g.fillText(GLY.charAt(j), j * cw + pad, ch + pad);
        }
        return { c: c, cw: cw, ch: ch, sw: cw * dpr, sh: ch * dpr };
      });
    }

    function drop(li, fresh) {
      var L = LAYERS[li], len = rand(L.len[0], L.len[1]) | 0;
      var d = {
        li: li,
        x: ((Math.random() * Math.ceil(w / L.size)) | 0) * L.size,
        row: fresh ? ((Math.random() * (h / L.size + len)) | 0) - len : -((Math.random() * 24) | 0) - 2,
        speed: rand(L.speed[0], L.speed[1]),
        acc: 0,
        len: len,
        g: []
      };
      for (var k = 0; k < len; k++) d.g.push(glyph());
      return d;
    }

    function want(li) {
      return Math.round(w / LAYERS[li].size * LAYERS[li].density * TQ[tierNow].dens[li]);
    }
    function populate() {
      drops = [];
      for (var li = 0; li < LAYERS.length; li++) {
        for (var i = 0, n = want(li); i < n; i++) drops.push(drop(li, true));
      }
    }
    // a tier change trims or tops up each layer, keeping what is falling
    function refit() {
      var have = [0, 0, 0], kept = [];
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i];
        if (have[d.li] < want(d.li)) { kept.push(d); have[d.li]++; }
      }
      for (var li = 0; li < LAYERS.length; li++) {
        for (var n = want(li); have[li] < n; have[li]++) kept.push(drop(li, true));
      }
      drops = kept;
    }

    // advance by k frames' worth (k is 1 at a steady 30fps)
    function step(k) {
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i];
        d.acc += d.speed * k;
        while (d.acc >= 1) {
          d.acc -= 1;
          d.row += 1;
          d.g.unshift(glyph());
          d.g.pop();
        }
        // trails mutate in place, a glyph here and there
        if (Math.random() < 0.3) d.g[1 + ((Math.random() * (d.len - 1)) | 0)] = glyph();
        if ((d.row - d.len) * LAYERS[d.li].size > h) drops[i] = drop(d.li, false);
      }
    }

    function paint(t, live) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (!atlas.length) return;
      for (var q = waves.length - 1; q >= 0; q--) if (t - waves[q].t > WAVE) waves.splice(q, 1);
      var nw = live ? waves.length : 0;
      var lens = live && ptr.on && TQ[tierNow].lens;
      var lx = ptr.x, ly = ptr.y, R2 = LENS * LENS;

      for (var i = 0; i < drops.length; i++) {
        var d = drops[i], L = LAYERS[d.li], A = atlas[d.li], s = L.size;
        var cx = d.x + px * L.par + s * 0.31;
        var oy = py * L.par * 0.5 + s * 0.6;
        var near = lens && Math.abs(cx - lx) < LENS;
        for (var k = 0; k < d.len; k++) {
          var cy = (d.row - k) * s + oy;
          if (cy < -s * 2 || cy > h + s) continue;
          var fade = 1 - k / d.len;
          var a = k === 0 ? Math.min(1, L.alpha * 2.3) : L.alpha * fade * fade;
          var sc = 1, dx = 0, dy = 0;
          if (near) {
            var ex = cx - lx, ey = cy - ly, e2 = ex * ex + ey * ey;
            if (e2 < R2) {
              var f = 1 - Math.sqrt(e2) / LENS;
              f *= f;
              a += f * 0.42;
              sc = 1 + f * 0.45;
            }
          }
          for (var v = 0; v < nw; v++) {
            var W = waves[v], age = (t - W.t) / WAVE;
            var wx = cx - W.x, wy = cy - W.y, dist = Math.sqrt(wx * wx + wy * wy);
            var band = Math.abs(dist - age * WAVE);
            if (band < 70) {
              var p = (1 - band / 70) * (1 - age) * W.s;
              a += p * 0.9;
              sc += p * 0.35;
              if (dist > 1) { dx += wx / dist * p * 14; dy += wy / dist * p * 14; }
            }
          }
          if (k > 0 && Math.random() < 0.004) a += 0.5; // a stray bright glyph
          if (a < 0.012) continue;
          ctx.globalAlpha = a > 1 ? 1 : a;
          var dw = A.cw * sc, dh = A.ch * sc;
          ctx.drawImage(A.c, d.g[k] * A.sw, k === 0 ? A.sh : 0, A.sw, A.sh, cx + dx - dw / 2, cy + dy - dh / 2, dw, dh);
        }
      }

      // the shockwave's own faint ring
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      for (var m = 0; m < nw; m++) {
        var V = waves[m], ag = (t - V.t) / WAVE;
        ctx.globalAlpha = Math.min(0.5, 0.12 * V.s) * (1 - ag);
        ctx.beginPath();
        ctx.arc(V.x, V.y, Math.max(1, ag * WAVE), 0, 6.2832);
        ctx.stroke();
      }
    }

    function still() {
      populate();
      paint(0, false);
    }

    function loop(t) {
      raf = requestAnimationFrame(loop);
      // a shockwave always plays smoothly, whatever the tier
      var fps = waves.length ? 30 : TQ[tierNow].fps, STEP = 1000 / fps;
      if (t - last < STEP - 2) return;
      var k = last ? clamp((t - last) / STEP, 1, 4) : 1;
      if (waves.length && fps !== TQ[tierNow].fps) k = clamp(k * TQ[tierNow].fps / 30, 0.1, 4);
      last = t;
      var t0 = now();
      px += ((ptr.on ? -ptr.nx : 0) - px) * 0.05;
      py += ((ptr.on ? -ptr.ny : 0) - py) * 0.05;
      step(k);
      paint(t, true);
      cost(t0);
    }
    function start() {
      if (raf || paused || held || document.hidden || reduced()) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function resize() {
      var nw = window.innerWidth, nh = window.innerHeight;
      // mobile URL bars resize the viewport constantly; ignore small jumps
      if (nw === w && Math.abs(nh - h) < 120) return;
      w = nw;
      h = nh;
      var nd = Math.min(window.devicePixelRatio || 1, hi() ? 1.5 : 1);
      cv.width = Math.round(w * nd);
      cv.height = Math.round(h * nd);
      ctx.setTransform(nd, 0, 0, nd, 0, 0);
      if (nd !== dpr || !atlas.length) {
        dpr = nd;
        buildAtlas();
      }
      if (reduced()) still(); else populate();
    }

    // strength 1 is a click; eggs may send bigger ones (capped)
    function burst(x, y, strength) {
      if (!raf) return;
      var s = clamp(+strength || 1, 0.2, 3);
      waves.push({ x: x, y: y, t: now(), s: s });
      if (waves.length > 4) waves.shift();
    }

    // never burn CPU in a background tab
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(resize, 150);
    });
    window.addEventListener('pointerdown', function (e) { burst(e.clientX, e.clientY); }, { passive: true });
    onChange(mqReduce, function () {
      if (reduced()) { stop(); still(); } else start();
    });
    holdFns.push(function (on) { if (on) stop(); else start(); });
    onTier(function () {
      if (Math.min(window.devicePixelRatio || 1, hi() ? 1.5 : 1) !== dpr) {
        w = 0; // sharper or softer canvas: size it again from scratch
        resize();
      } else {
        refit();
        if (reduced()) paint(0, false);
      }
    });
    // the atlas was drawn with a fallback font if M was still loading
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        buildAtlas();
        if (reduced()) paint(0, false);
      });
    }

    resize();
    start();
    return {
      pause: function () { paused = true; stop(); },
      resume: function () { paused = false; start(); },
      burst: burst
    };
  })();

  /* ---------- glyph object ---------- */

  // The hex mark as a solid: an extruded hexagon ring with two eye bars,
  // sampled into points once, then rotated, z-buffered and shaded into
  // ASCII every frame (the spinning-donut method). It sways, leans toward
  // the pointer, blinks, sometimes spins once, and glitches on cue.
  // data-obj="broken" (404) jerks, tears and has crossed-out eyes.
  // Tiers: mid draws coarser glyphs at 20fps without the eye glow; low
  // holds one still pose and only moves for a blink, a glitch or while
  // it is awake.
  var obj = (function () {
    var cv = document.querySelector('canvas[data-obj]');
    var ctx = cv && cv.getContext && cv.getContext('2d');
    if (!ctx) return { glitch: noop, blink: noop, wake: noop, rect: function () { return null; } };

    var broken = cv.getAttribute('data-obj') === 'broken';
    var RAMP = '.,:;-=+*#%@';
    var TONE = ['#2f2f2f', '#535353', '#808080', '#b4b4b4', '#fff'];
    var CAM = 3.6, EY = 0.12;
    var PX = -1.7, PY = 1.9, PZ = 3.1; // point light, upper left, in front

    var faces = [], lines = [];
    var W = 0, H = 0, dpr = 1, fs = 10, cw = 6, ch = 11, cols = 0, rows = 0;
    var zb, lb, eb, offs, pocket;
    var raf = 0, last = 0, drawn = false;
    var tx = 0, ty = 0;
    var spinAt = now() + rand(6000, 9000), SPIN = 1900;
    var blinkAt = now() + rand(2200, 4200);
    var glitchTo = 0;
    var awake = false, actTo = 0, phase = rand(0, 60), pt = 0, FPS = { high: 30, mid: 20, low: 15 };
    // a verified solver certificate: 1 open, steady eyes and a faint halo;
    // 2 the same in gold (an unlit solve). Never on the broken mask.
    var solver = 0, GOLD = '#ffd04a';

    function font() { return fs + 'px M, ui-monospace, Menlo, monospace'; }
    function hexIn(x, y, r) {
      var ax = Math.abs(x);
      return ax <= r * 0.8660254 && Math.abs(y) + ax * 0.5773503 <= r;
    }
    function verts(r) {
      var v = [];
      for (var i = 0; i < 6; i++) {
        var a = Math.PI / 2 - i * Math.PI / 3;
        v.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return v;
    }
    function face(pts, nx, ny, nz, eye) {
      if (pts.length) faces.push({ p: new Float32Array(pts), n: [nx, ny, nz], eye: eye });
    }
    // one side wall between two outline points; sign flips it inward
    function wall(a, b, D, s, sign) {
      var ex = b[0] - a[0], ey = b[1] - a[1], len = Math.sqrt(ex * ex + ey * ey);
      var pts = [], steps = Math.ceil(len / s);
      for (var i = 0; i <= steps; i++) {
        for (var z = -D; z <= D + 1e-6; z += s) pts.push(a[0] + ex * i / steps, a[1] + ey * i / steps, z);
      }
      face(pts, -ey / len * sign, ex / len * sign, 0, 0);
    }
    // an eye: a small box (w x h, centred on cx, cy, turned by ang) that
    // stands a little proud of the ring
    function slab(cx, cy, w, h, ang, s) {
      var x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2, z0 = -0.12, z1 = 0.25, x, y, z;
      var c = Math.cos(ang), n = Math.sin(ang);
      var P = [[], [], [], [], [], []];
      function put(k, px, py, pz) { P[k].push(cx + px * c - py * n, cy + px * n + py * c, pz); }
      for (x = x0; x <= x1 + 1e-6; x += s) for (y = y0; y <= y1 + 1e-6; y += s) { put(0, x, y, z1); put(1, x, y, z0); }
      for (x = x0; x <= x1 + 1e-6; x += s) for (z = z0; z <= z1 + 1e-6; z += s) { put(2, x, y1, z); put(3, x, y0, z); }
      for (y = y0; y <= y1 + 1e-6; y += s) for (z = z0; z <= z1 + 1e-6; z += s) { put(4, x0, y, z); put(5, x1, y, z); }
      face(P[0], 0, 0, 1, 1);
      face(P[1], 0, 0, -1, 1);
      face(P[2], -n, c, 0, 1);
      face(P[3], n, -c, 0, 1);
      face(P[4], -c, -n, 0, 1);
      face(P[5], c, n, 0, 1);
    }
    function build(s) {
      faces = [];
      var R = 1, r = 0.8, D = 0.16, pf = [], pb = [];
      for (var x = -R; x <= R; x += s) {
        for (var y = -R; y <= R; y += s) {
          if (hexIn(x, y, R) && !hexIn(x, y, r)) { pf.push(x, y, D); pb.push(x, y, -D); }
        }
      }
      face(pf, 0, 0, 1, 0);
      face(pb, 0, 0, -1, 0);
      var vo = verts(R), vi = verts(r);
      for (var i = 0; i < 6; i++) {
        wall(vo[i], vo[(i + 1) % 6], D, s, 1);
        wall(vi[i], vi[(i + 1) % 6], D, s, -1);
      }
      if (broken) {
        // crossed-out eyes
        slab(-0.3, EY, 0.4, 0.085, Math.PI / 4, s);
        slab(-0.3, EY, 0.4, 0.085, -Math.PI / 4, s);
        slab(0.3, EY, 0.4, 0.085, Math.PI / 4, s);
        slab(0.3, EY, 0.4, 0.085, -Math.PI / 4, s);
      } else {
        slab(-0.3, EY, 0.36, 0.19, 0, s);
        slab(0.3, EY, 0.36, 0.19, 0, s);
      }
    }

    function resize() {
      var nw = cv.clientWidth, nh = cv.clientHeight;
      if (!nw || !nh || (nw === W && nh === H)) return;
      W = nw;
      H = nh;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fs = (W >= 440 ? 10 : W >= 300 ? 8 : 7) + (hi() ? 0 : 2);
      ctx.font = font();
      ctx.textBaseline = 'top';
      cw = ctx.measureText('0').width || fs * 0.6;
      ch = fs * 1.1;
      cols = Math.floor(W / cw);
      rows = Math.floor(H / ch);
      zb = new Float32Array(cols * rows);
      lb = new Float32Array(cols * rows);
      eb = new Uint8Array(cols * rows);
      offs = new Int8Array(rows);
      lines = [];
      for (var q = 0; q < TONE.length; q++) lines.push(new Array(cols));
      build(0.5 * cw / (0.4 * Math.min(W, H)));
      pocket = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.min(W, H) * 0.5);
      pocket.addColorStop(0, 'rgba(0,0,0,.8)');
      pocket.addColorStop(0.7, 'rgba(0,0,0,.45)');
      pocket.addColorStop(1, 'rgba(0,0,0,0)');
      if (!raf) render(now(), !reduced());
    }

    function render(t, live) {
      if (!cols || !rows) return;
      var t0 = now();
      // low tier: one frozen moment of the sway, no lean, no idle moves;
      // awake: the sway runs three times as fast
      var frozen = live && lo() && !awake;
      if (live) {
        if (pt) phase += Math.min(100, Math.max(0, t - pt)) / 1000 * (frozen ? 0 : awake ? 3 : 1);
        pt = t;
      }
      var sec = phase;
      if (live && !frozen) {
        tx += ((ptr.on ? ptr.nx : 0) - tx) * 0.05;
        ty += ((ptr.on ? ptr.ny : 0) - ty) * 0.05;
      } else if (frozen) {
        tx = ty = 0;
      }
      // pose: slow sway + lean toward the pointer + an occasional full spin
      var spin = 0;
      if (frozen && spinAt < t) spinAt = t + rand(10000, 16000);
      if (live && t > spinAt) {
        var q = (t - spinAt) / SPIN;
        if (q >= 1) spinAt = t + rand(10000, 16000);
        else spin = (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2) * Math.PI * 2;
      }
      var amp = awake ? 1.25 : 1;
      var yaw = live ? 0.5 * amp * Math.sin(sec * 0.33) + tx * 0.6 + spin : 0.42;
      var pitch = live ? 0.15 * amp * Math.sin(sec * 0.21) + ty * 0.4 - 0.06 : -0.14;
      var roll = live ? 0.05 * amp * Math.sin(sec * 0.17) : 0.03;
      if (broken && live && !frozen && Math.random() < 0.025) { yaw += rand(-0.6, 0.6); roll += rand(-0.2, 0.2); }

      // blink: the eye bars flatten for ~170ms, sometimes twice (on low
      // only when asked); awake: the eyes open wide and never blink
      var bl = 1;
      if (awake) bl = 1.3;
      else if (solver) bl = 1.12;
      else if (live && t > blinkAt) {
        var bq = (t - blinkAt) / 170;
        if (bq >= 1) blinkAt = t + (lo() ? 1e9 : Math.random() < 0.2 ? 240 : rand(3200, 6800));
        else bl = 1 - Math.sin(bq * Math.PI) * 0.92;
      }

      // M = Rz(roll) * Rx(pitch) * Ry(yaw)
      var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      var cr = Math.cos(roll), sr = Math.sin(roll);
      var a10 = sp * sy, a12 = -sp * cy;
      var m00 = cr * cy - sr * a10, m01 = -sr * cp, m02 = cr * sy - sr * a12;
      var m10 = sr * cy + cr * a10, m11 = cr * cp, m12 = sr * sy + cr * a12;
      var m20 = -cp * sy, m21 = sp, m22 = cp * cy;

      zb.fill(0);
      var F = 0.4 * Math.min(W, H) * CAM, hw = W / 2, hh = H / 2;
      for (var f = 0; f < faces.length; f++) {
        var fc = faces[f], n = fc.n;
        var nx = m00 * n[0] + m01 * n[1] + m02 * n[2];
        var ny = m10 * n[0] + m11 * n[1] + m12 * n[2];
        var nz = m20 * n[0] + m21 * n[1] + m22 * n[2];
        if (nz < -0.08) continue; // facing away
        var p = fc.p, eye = fc.eye;
        for (var i = 0; i < p.length; i += 3) {
          var x = p[i], y = p[i + 1], z = p[i + 2];
          if (eye) y = EY + (y - EY) * bl;
          var X = m00 * x + m01 * y + m02 * z;
          var Y = m10 * x + m11 * y + m12 * z;
          var Z = m20 * x + m21 * y + m22 * z;
          var iz = 1 / (CAM - Z);
          var u = hw + X * F * iz, v = hh - Y * F * iz;
          if (u < 0 || v < 0) continue;
          var c = (u / cw) | 0, r = (v / ch) | 0;
          if (c >= cols || r >= rows) continue;
          var k = r * cols + c;
          if (iz > zb[k]) {
            // diffuse from a point light, so flat faces still shade across
            var qx = PX - X, qy = PY - Y, qz = PZ - Z;
            var dl = nx * qx + ny * qy + nz * qz;
            var lum = 0.12 + (dl > 0 ? 0.95 * dl / Math.sqrt(qx * qx + qy * qy + qz * qz) : 0);
            zb[k] = iz;
            lb[k] = lum * (0.55 + 0.45 * iz * CAM); // nearer reads brighter
            eb[k] = eye;
          }
        }
      }

      var glitchy = live && t < glitchTo;
      if (broken && live && !frozen && !glitchy && Math.random() < 0.05) { glitchTo = t + rand(80, 200); glitchy = true; }
      if (glitchy) {
        for (var g = 0; g < rows; g++) offs[g] = Math.random() < 0.16 ? ((Math.random() * 13) | 0) - 6 : 0;
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = pocket;
      ctx.fillRect(0, 0, W, H);
      reticle(live ? sec : 0);
      // a soft scan band drifts down through the glyphs
      var band = live ? ((t / 5600) % 1.5 - 0.25) * rows : -99;
      var nR = RAMP.length;
      for (var row = 0; row < rows; row++) {
        var used = 0, base = row * cols, lift = Math.abs(row - band) < 1.6;
        for (var t2 = 0; t2 < lines.length; t2++) lines[t2].fill(' ');
        for (var col = 0; col < cols; col++) {
          var kk = base + col;
          if (!zb[kk]) continue;
          var L = lb[kk], ri = (L * nR) | 0, tone, chr;
          if (ri >= nR) ri = nR - 1;
          if (eb[kk]) {
            tone = 4;
            var eyeMin = awake ? 9 : solver ? 8 : 7;
            chr = RAMP.charAt(ri < eyeMin ? eyeMin : ri);
          } else {
            tone = ri < 3 ? 0 : ri < 6 ? 1 : ri < 9 ? 2 : 3;
            if (lift && tone < 3) tone++;
            chr = RAMP.charAt(ri);
          }
          lines[tone][col] = chr;
          used |= 1 << tone;
        }
        if (!used) continue;
        var off = glitchy ? offs[row] * cw : 0;
        for (var tn = 0; tn < lines.length; tn++) {
          if (!(used & (1 << tn))) continue;
          ctx.fillStyle = tn === 4 && solver === 2 ? GOLD : TONE[tn];
          // the eye glow is the priciest part: high tier, or while awake
          var glow = tn === 4 && (awake || hi());
          if (glow) {
            ctx.shadowColor = solver === 2 ? 'rgba(255,208,74,.85)' : awake ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.7)';
            ctx.shadowBlur = (awake ? 14 : 7) * dpr;
          }
          ctx.fillText(lines[tn].join(''), off, row * ch);
          if (glow) ctx.shadowBlur = 0;
        }
      }
      if (!drawn) {
        drawn = true;
        cv.classList.add('is-on');
      }
      if (live) cost(t0);
    }

    // a faint scope around the object: a slowly turning dashed ring and
    // four ticks on a still one
    function reticle(sec) {
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.485;
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#262626';
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, sec * 0.05, sec * 0.05 + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#2c2c2c';
      ctx.beginPath();
      for (var i = 0; i < 4; i++) {
        var a = i * Math.PI / 2 + Math.PI / 4;
        var ca = Math.cos(a), sa = Math.sin(a);
        ctx.moveTo(cx + Math.cos(a - 0.09) * (R - 6), cy + Math.sin(a - 0.09) * (R - 6));
        ctx.arc(cx, cy, R - 6, a - 0.09, a + 0.09);
        ctx.moveTo(cx + ca * (R - 14), cy + sa * (R - 14));
        ctx.lineTo(cx + ca * (R - 6), cy + sa * (R - 6));
      }
      ctx.stroke();
      if (solver) {
        // the solver's halo: one faint, steady ring inside the scope
        ctx.strokeStyle = solver === 2 ? 'rgba(255,208,74,.3)' : 'rgba(255,255,255,.26)';
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // low tier: nothing to animate between acts, so the loop stops after
    // drawing the still pose once more
    function idle(t) { return lo() && !awake && t > actTo && t > glitchTo; }
    function loop(t) {
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / FPS[tierNow] - 2) return;
      last = t;
      render(t, true);
      if (idle(t)) stop();
    }
    function start() {
      if (raf || held || document.hidden || reduced()) return;
      if (idle(now())) { render(now(), true); return; }
      raf = requestAnimationFrame(loop);
    }
    function act(ms) {
      actTo = Math.max(actTo, now() + ms);
      start();
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(resize, 150);
    });
    onChange(mqReduce, function () {
      if (reduced()) { stop(); render(now(), false); } else start();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { W = 0; resize(); });
    }
    onTier(function () {
      W = 0; // glyph size follows the tier
      stop();
      resize();
      start();
    });
    holdFns.push(function (on) {
      if (on) stop();
      else { pt = 0; start(); } // no jump in the sway after the pause
    });

    function syncSolver() {
      if (broken) return;
      var s = huntDo('solver'), next = s && s.any ? (s.gold ? 2 : 1) : 0;
      if (next === solver) return;
      solver = next;
      if (!cols || !rows) return;
      if (reduced()) render(now(), false); else act(60);
    }
    huntReady(syncSolver);
    window.addEventListener('hunt:cert', syncSolver);

    resize();
    start();
    return {
      glitch: function () {
        if (reduced()) return;
        glitchTo = now() + 420;
        act(460);
      },
      blink: function () {
        if (reduced() || awake || solver) return;
        blinkAt = now();
        act(260);
      },
      // eyes wide and bright, faster sway, until wake(false)
      wake: function (on) {
        on = !!on;
        if (on === awake) return;
        awake = on;
        if (reduced()) { render(now(), false); return; }
        if (on) start(); else act(60);
      },
      // its box on screen, or null when it is not showing
      rect: function () {
        if (!cv.isConnected) return null;
        var r = cv.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, x: r.left, y: r.top };
      }
    };
  })();

  /* ---------- digests ---------- */

  // [data-digest] blocks: the hex churns and the block glitches on hover /
  // focus, then settles back to the same digest. The big heading also
  // glitches on idle (more often on the 404).
  function initDigests() {
    var blocks = document.querySelectorAll('[data-digest]');
    Array.prototype.forEach.call(blocks, function (block) {
      var hexes = block.querySelectorAll('[data-churn]');
      var g = block.classList.contains('glitch') ? block : block.querySelector('.glitch');
      function go() {
        if (g) glitch(g);
        for (var i = 0; i < hexes.length; i++) scramble(hexes[i], { duration: 560, pool: HEX });
        obj.glitch();
      }
      block.addEventListener('pointerenter', go);
      block.addEventListener('focusin', go);
    });

    var idle = document.querySelector('.digest.glitch');
    if (!idle) return;
    var lost = page === '404';
    (function later() {
      setTimeout(function () {
        if (!document.hidden && !root.classList.contains('boot')) {
          glitch(idle);
          if (lost || Math.random() < 0.5) obj.glitch();
        }
        later();
      }, lost ? rand(2200, 4800) : rand(5000, 10000));
    })();
  }

  /* ---------- pointer tilt ---------- */

  // [data-tilt] elements get --tx / --ty (-1..1), eased toward the pointer.
  // CSS decides what to do with them.
  // Off on the low tier: every step repaints the title's wide glow.
  function initTilt() {
    var els = document.querySelectorAll('[data-tilt]');
    if (!els.length || !mqFine.matches || reduced()) return;
    var tx = 0, ty = 0, raf = 0;
    function tick() {
      var gx = lo() ? 0 : ptr.nx, gy = lo() ? 0 : ptr.ny;
      tx += (gx - tx) * (lo() ? 1 : 0.08);
      ty += (gy - ty) * (lo() ? 1 : 0.08);
      for (var i = 0; i < els.length; i++) {
        els[i].style.setProperty('--tx', tx.toFixed(3));
        els[i].style.setProperty('--ty', ty.toFixed(3));
      }
      raf = Math.abs(gx - tx) + Math.abs(gy - ty) > 0.002 ? requestAnimationFrame(tick) : 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(tick); }
    ptrFns.push(function () { if (!lo()) kick(); });
    onTier(kick);
  }

  /* ---------- cursor ---------- */

  // A crosshair dot and a trailing ring. Over anything clickable the ring
  // folds away and four corner brackets lock onto the control's box. All of
  // it is delegated, so content added later behaves the same. Rects are
  // read on pointerover / scroll / resize (and at most every 180ms while
  // moving), never inside the animation frame. On the low tier it is a
  // plain dot and ring: no lock-on, no ripple.
  var HOT = 'a[href], button, [role="link"], [role="button"], label, summary, [data-lock]';
  var BIG_W = 560, BIG_H = 440, ARM = 9;

  function initCursor() {
    if (!mqFine.matches || reduced()) return;
    var body = document.body;
    var dot = quiet(make('div', 'cur cur-dot', body));
    var ring = quiet(make('div', 'cur cur-ring', body));
    var cs = ['tl', 'tr', 'bl', 'br'].map(function (k) { return quiet(make('div', 'cur cur-c ' + k, body)); });
    var tag = quiet(make('div', 'cur cur-tag', body));
    var rips = [0, 1, 2].map(function () { return quiet(make('div', 'cur cur-rip', body)); });
    var parts = [dot, ring, tag].concat(cs);
    root.classList.add('has-cursor');

    var x = 0, y = 0, rx = 0, ry = 0, raf = 0, shown = false, down = false;
    var lock = null, box = null, bx = [0, 0, 0, 0], measured = 0, ripN = 0, tagText = '';
    var tagW = 0, tagH = 0;

    function each(cls, on) {
      for (var i = 0; i < parts.length; i++) parts[i].classList.toggle(cls, on);
    }
    function measure() {
      measured = now();
      if (!lock) return;
      if (!lock.isConnected) { setLock(null, false); return; }
      var r = lock.getBoundingClientRect();
      if (!r.width || !r.height) { setLock(null, false); return; }
      box = [r.left - 5, r.top - 5, r.right + 5, r.bottom + 5];
    }
    function setLock(el, dim) {
      if (el !== lock) {
        lock = el;
        box = null;
        if (el) measure();
        var on = !!lock;
        dot.classList.toggle('is-lock', on);
        ring.classList.toggle('is-lock', on);
        for (var i = 0; i < 4; i++) cs[i].classList.toggle('is-lock', on);
      }
      for (var j = 0; j < 4; j++) cs[j].classList.toggle('is-dim', !!dim);
    }
    function label(s) {
      s = (s || '').slice(0, 24);
      if (s === tagText) return;
      tagText = s;
      tag.classList.toggle('is-show', !!s);
      if (s) {
        tag._final = s;
        tag.textContent = s;
        tagW = tag.offsetWidth;
        tagH = tag.offsetHeight;
        scramble(tag, { duration: 240 });
      }
    }
    // While locked the label rides the brackets instead of the dot: beside a
    // wide row (so it never lands on the next row's line), tucked into the
    // bottom-right corner of a card, under a small control; flipped to the
    // other side when the viewport edge is near.
    function placeTag() {
      var vw = window.innerWidth, vh = window.innerHeight, tx, ty;
      var w = bx[2] - bx[0], h = bx[3] - bx[1];
      if (w > h * 3) {
        tx = bx[2] + 8;
        if (tx + tagW > vw - 4) tx = bx[0] - 8 - tagW;
        ty = (bx[1] + bx[3] - tagH) / 2;
      } else if (h >= tagH + 40 && w >= tagW + 40) {
        tx = bx[2] - 10 - tagW;
        ty = bx[3] - 10 - tagH;
      } else {
        tx = Math.min(bx[0], vw - 4 - tagW);
        ty = bx[3] + 6;
        if (ty + tagH > vh - 4) ty = bx[1] - 6 - tagH;
      }
      tag.style.transform = tr(Math.max(4, tx), ty);
    }

    function tick() {
      raf = 0;
      rx += (x - rx) * 0.22;
      ry += (y - ry) * 0.22;
      var moving = Math.abs(x - rx) + Math.abs(y - ry) > 0.3;
      var goal = box || [rx - 15, ry - 15, rx + 15, ry + 15];
      var k = box ? 0.3 : 0.5, sh = down && box ? 3 : 0;
      for (var i = 0; i < 4; i++) {
        var d = goal[i] + (i < 2 ? sh : -sh) - bx[i];
        bx[i] += d * k;
        if (Math.abs(d) > 0.3) moving = true;
      }
      ring.style.transform = tr(rx, ry);
      cs[0].style.transform = tr(bx[0], bx[1]);
      cs[1].style.transform = tr(bx[2] - ARM, bx[1]);
      cs[2].style.transform = tr(bx[0], bx[3] - ARM);
      cs[3].style.transform = tr(bx[2] - ARM, bx[3] - ARM);
      if (box && tagText) placeTag();
      if (moving) raf = requestAnimationFrame(tick);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(tick); }

    ptrFns.push(function (e) {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
      if (!shown) {
        rx = x;
        ry = y;
        bx = [x - 15, y - 15, x + 15, y + 15];
        shown = true;
        each('on', true);
        root.classList.add('has-pointer');
      }
      dot.style.transform = tr(x, y);
      if (!box) tag.style.transform = tr(x + 14, y + 24);
      if (lock && now() - measured > 180) measure();
      kick();
    });

    // relatedTarget is null when the pointer leaves the window (or enters
    // the video frame, which is another document)
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) { each('on', false); shown = false; }
    });

    // lock onto clickable things; step aside for text fields and the video
    // frame, which draw their own cursors
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      var t = e.target;
      if (!t || !t.closest) return;
      var off = t.tagName === 'IFRAME' || !!t.closest('input, textarea, select, [contenteditable="true"]');
      each('off', off);
      var hot = t.closest(HOT), lk = lo() ? null : hot;
      if (lk && lk.closest('[data-nolock]')) lk = null;
      if (lk) {
        var r = lk.getBoundingClientRect();
        if (r.width > BIG_W || r.height > BIG_H) lk = null;
      }
      setLock(lk, lk && (lk.disabled || lk.getAttribute('aria-disabled') === 'true'));
      ring.classList.toggle('is-hot', !!hot && !lk);
      var c = t.closest('[data-cursor]');
      label(c && !off ? c.getAttribute('data-cursor') : '');
      kick();
    });

    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      down = true;
      ring.classList.add('is-down');
      if (lo()) { kick(); return; }
      var rp = rips[ripN++ % rips.length];
      rp.style.transform = tr(e.clientX, e.clientY);
      rp.className = 'cur cur-rip ' + (rp.classList.contains('is-a') ? 'is-b' : 'is-a');
      kick();
    }, { passive: true });
    document.addEventListener('pointerup', function () {
      down = false;
      ring.classList.remove('is-down');
      kick();
    });

    function remeasure() { if (lock) { measure(); kick(); } }
    window.addEventListener('scroll', remeasure, { passive: true, capture: true });
    window.addEventListener('resize', remeasure);
    window.addEventListener('hashchange', function () {
      setLock(null, false);
      ring.classList.remove('is-hot');
      label('');
      kick();
    });
    onTier(function () {
      if (lo() && lock) {
        setLock(null, false);
        ring.classList.add('is-hot');
        kick();
      }
    });
  }

  /* ---------- overlays ---------- */

  // Corner brackets on every page; the interference line only on the menu
  // and the 404, where nothing is being read or watched, and only on the
  // high tier.
  function initOverlays() {
    var frame = quiet(make('div', 'fx fx-frame', document.body));
    for (var i = 0; i < 4; i++) make('i', '', frame);
    if (page !== 'menu' && page !== '404') return;

    var band = quiet(make('div', 'fx fx-tear', document.body));
    var shell = document.querySelector('.shell');
    function fire() {
      if (hi() && !document.hidden && !reduced() && !root.classList.contains('boot') && !root.classList.contains('leaving')) {
        band.style.setProperty('--y', rand(6, 90).toFixed(1) + 'vh');
        band.style.setProperty('--h', rand(1.2, 6).toFixed(1) + 'vh');
        band.className = 'fx fx-tear ' + (band.classList.contains('is-a') ? 'is-b' : 'is-a');
        var tear = huntDo('tell', 'tear');
        if (typeof tear === 'string' && tear && Math.random() < 1 / 3) tearGlyphs(tear);
        if (shell && Math.random() < 0.6) {
          shell.classList.add('is-tear');
          setTimeout(function () { shell.classList.remove('is-tear'); }, 220);
        }
      }
      setTimeout(fire, rand(6000, 14000));
    }
    setTimeout(fire, rand(3500, 6500));

    // the hunt's glyph burst, inside the band for as long as it shows
    var glyphs = null;
    function tearGlyphs(text) {
      if (glyphs) glyphs.remove();
      var s = glyphs = quiet(make('span', '', band));
      var st = s.style;
      st.position = 'absolute';
      st.top = '0';
      st.bottom = '0';
      st.left = rand(3, 45).toFixed(1) + '%';
      st.right = '0';
      st.display = 'flex';
      st.alignItems = 'center';
      st.overflow = 'hidden';
      st.whiteSpace = 'pre';
      st.font = '12px M, ui-monospace, Menlo, monospace';
      st.letterSpacing = '.18em';
      st.color = '#fff';
      st.textShadow = '0 0 6px rgba(255,255,255,.7)';
      s.textContent = text;
      setTimeout(function () { if (glyphs === s) glyphs = null; s.remove(); }, 240);
    }
  }

  /* ---------- session clock ---------- */

  // One span per character, so a digit that changes can flash on its own.
  function initClock() {
    var el = document.querySelector('[data-clock]');
    if (!el) return;
    var cells = [], prev = '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function paint() {
      var s = Math.floor(now() / 1000);
      var str = 't+' + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
      if (str.length !== cells.length) {
        el.textContent = '';
        cells = [];
        for (var i = 0; i < str.length; i++) cells.push(make('span', '', el));
        prev = '';
      }
      for (var j = 0; j < str.length; j++) {
        var c = str.charAt(j);
        if (c === prev.charAt(j)) continue;
        cells[j].textContent = c;
        if (prev) cells[j].className = cells[j].className === 'tk-a' ? 'tk-b' : 'tk-a';
      }
      prev = str;
      setTimeout(paint, 1000 - (now() % 1000) + 8);
    }
    paint();
  }

  /* ---------- potato mode ---------- */

  // [data-potato]: the effects level, beside the clock. Below max it reads
  // "potato mode" and stands out (and says so once per visit when the site
  // picked it); clicked, it opens a menu that says why, tags the level the
  // measurement recommends for this device, and lets the visitor pick one
  // (kept) or hand it back to auto.
  var LEVELS = [
    ['high', 'max', 'everything on'],
    ['mid', 'medium', 'less rain, fewer glows'],
    ['low', 'low', 'thin, slow rain, a still mask, no glows'],
    ['xlow', 'extra low', 'nothing moves at all']
  ];
  function nameOf(t) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i][0] === t) return LEVELS[i][1];
    return t;
  }
  // what the measurement says this device should run, whatever is picked
  function recommended() {
    if (tierSrc !== 'force') return tierNow;
    try {
      var c = JSON.parse(localStorage.getItem('fx.tier') || 'null');
      if (c && ORDER.indexOf(c.tier) >= 0 && c.sc === tb.sc && Date.now() - c.at < 3 * 864e5) return c.tier;
    } catch (e) { /* blocked or bad entry */ }
    return tb.guess || 'high';
  }
  var onMeasured = function () {};

  function initPotato() {
    var btn = document.querySelector('[data-potato]');
    if (!btn) return;
    var box = null;

    function line(cls, text, parent) {
      var p = make('p', cls, parent);
      p.textContent = text;
      return p;
    }
    function status(lv, rec, auto) {
      if (lv === 'high') {
        if (auto) return 'your device runs every effect.';
        return rec === 'high' ? 'you picked max.' : 'you picked max. it may lag on this device: ' + nameOf(rec) + ' is recommended.';
      }
      if (auto) return 'your device is running on potato mode: it couldn’t draw every effect smoothly, so the site turned them down to stop lag.';
      return 'you’re on potato mode because you picked ' + nameOf(lv) + '.' +
        (ORDER.indexOf(rec) > ORDER.indexOf(lv) || lv === 'xlow' ? ' this device can run ' + nameOf(rec) + '.' : '');
    }
    function row(parent, cls, on, mark, name, desc, tag, pick) {
      var b = make('button', cls + (on ? ' is-on' : ''), parent);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      make('span', 'potato-mark', b).textContent = mark;
      var n = make('span', 'potato-name', b);
      n.textContent = name;
      if (tag) make('span', 'potato-rec', n).textContent = tag;
      make('span', 'potato-desc', b).textContent = desc;
      b.addEventListener('click', pick);
    }
    function render() {
      box.textContent = '';
      var lv = level(), rec = recommended(), auto = tierSrc !== 'force';
      line('potato-h', '// effects', box);
      line('potato-say', status(lv, rec, auto), box);
      var list = make('div', 'potato-levels', box);
      LEVELS.forEach(function (L) {
        row(list, 'potato-lv', L[0] === lv, L[0] === lv ? '>' : '', L[1], L[2], L[0] === rec ? 'recommended' : '', function () {
          if (L[0] !== lv || auto) setTier(L[0]);
          if (box) render();
        });
      });
      row(box, 'potato-auto', auto, auto ? '[x]' : '[ ]', 'auto', 'the site picks for this device and checks again every few days', '', function () {
        if (!auto) setTier('auto');
        if (box) render();
      });
    }
    function close() {
      if (!box) return;
      box.remove();
      box = null;
      btn.setAttribute('aria-expanded', 'false');
    }
    function open() {
      tip(false);
      box = make('div', 'potato-menu', btn.parentNode);
      box.id = 'potato-menu';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'effects level');
      render();
      btn.setAttribute('aria-expanded', 'true');
      var on = box.querySelector('.potato-lv.is-on');
      if (on) on.focus();
    }

    // once per visit, when the site (not the visitor) turned things down
    var tipEl = null, tipTimer = 0;
    function tip(show) {
      if (!show) {
        clearTimeout(tipTimer);
        if (tipEl) { tipEl.remove(); tipEl = null; }
        return;
      }
      if (tipEl || box) return;
      try {
        if (sessionStorage.getItem('fx.potato')) return;
        sessionStorage.setItem('fx.potato', '1');
      } catch (e) { return; }
      tipEl = make('p', 'potato-tip', btn.parentNode);
      tipEl.setAttribute('role', 'status');
      tipEl.textContent = 'heads up: your device is running on potato mode';
      tipTimer = setTimeout(function () { tip(false); }, 6000);
    }

    function sync() {
      var potato = level() !== 'high';
      btn.classList.toggle('is-potato', potato);
      btn.textContent = potato ? 'potato mode' : 'effects: max';
      if (box) render();
    }
    // a guess is still being measured ('hint'): wait for the measurement
    function measured() {
      sync();
      if (level() !== 'high' && tierSrc !== 'force' && tierSrc !== 'hint') setTimeout(function () { tip(true); }, 900);
    }

    btn.setAttribute('aria-controls', 'potato-menu');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', function () { if (box) close(); else open(); });
    document.addEventListener('click', function (e) {
      if (box && !box.contains(e.target) && !btn.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (box && e.key === 'Escape') { close(); btn.focus(); }
    });
    onTier(measured);
    onMeasured = measured;
    btn.hidden = false;
    measured();
  }

  /* ---------- boot screen ---------- */

  // Runs only when early.js set html.boot (first visit, motion allowed).
  // About 2.3 s: a power-on line opens into a log, a hex dump and progress
  // bars, the digest decodes in the middle, then a flash into the menu.
  // Any key, click or tap skips it.
  function boot(done) {
    if (!root.classList.contains('boot')) { done(); return; }
    try { localStorage.setItem('boot', '1'); } catch (e) { /* blocked */ }

    var box = quiet(make('div', 'boot', document.body));
    var scr = make('div', 'boot-scr', box);
    var bars = make('div', 'boot-bars', scr);
    var dump = make('div', 'boot-dump', scr);
    var log = make('div', 'boot-log', scr);
    var mark = bootMark(box);
    var pct = make('div', 'boot-pct', box);
    var dig = make('div', 'boot-digest', box);
    make('div', 'boot-line', box);
    var flash = make('div', 'boot-flash', box);
    var skip = make('div', 'boot-skip', box);
    skip.textContent = mqFine.matches ? 'any key to skip' : 'tap to skip';
    dig.textContent = '631cb8a9';

    var timers = [], loops = [], finished = false, landed = false, clock = 0;
    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function every(ms, fn) { loops.push(setInterval(fn, ms)); }

    // log lines
    var lines = [
      ['power', 'on'],
      ['crt sync', 'locked'],
      ['init shell', 'ok'],
      ['mount /fx', 'ok'],
      ['glyph atlas', String(GLY.length)],
      ['cookies', 'none'],
      ['trackers', 'none'],
      ['storage', 'local'],
      ['routes', '3/3 open'],
      ['ghost', 'asleep'],
      ['link', 'ready']
    ];
    function row(key, val) {
      clock += 0.04 + Math.random() * 0.05;
      var stamp = ('     ' + clock.toFixed(3)).slice(-7);
      var dots = new Array(Math.max(3, 16 - key.length)).join('.');
      var line = make('div', '', log);
      var ok = make('span', 'ok');
      line.textContent = '[' + stamp + '] ' + key + ' ' + dots + ' ';
      ok.textContent = val;
      line.appendChild(ok);
      return line;
    }
    // The hunt's row (and any hints for everyone) goes right under the
    // ghost row: in order when the status is already known, or slotted in
    // there when it arrives while the log is still on screen.
    var ghostRow = null, ghostClock = 0, huntDone = false;
    function huntRows() {
      if (huntDone || !ghostRow || finished) return;
      var tell = huntDo('tell', 'boot'), drip = huntDo('lines', 'boot') || [], add = [];
      if (tell && typeof tell.k === 'string' && typeof tell.v === 'string') add.push([tell.k, tell.v]);
      for (var i = 0; i < drip.length && i < 4; i++) if (typeof drip[i] === 'string' && drip[i]) add.push([drip[i], null]);
      if (!add.length) return;
      huntDone = true;
      var after = ghostRow, inOrder = !ghostRow.nextSibling, c = ghostClock;
      add.forEach(function (r) {
        c += inOrder ? 0.04 + Math.random() * 0.05 : 0.006;
        var line = make('div', '', null);
        line.textContent = '[' + ('     ' + c.toFixed(3)).slice(-7) + '] ' + r[0] + (r[1] == null ? '' : ' ' + new Array(Math.max(3, 16 - r[0].length)).join('.') + ' ');
        if (r[1] != null) make('span', 'ok', line).textContent = r[1];
        log.insertBefore(line, after.nextSibling);
        after = line;
      });
      if (inOrder) clock = c;
    }
    huntReady(huntRows);
    lines.forEach(function (l, i) {
      at(240 + i * 88, function () {
        if (i && lines[i - 1][0] === 'ghost') huntRows();
        var line = row(l[0], l[1]);
        if (l[0] === 'ghost') { ghostRow = line; ghostClock = clock; }
      });
    });

    // progress bars, filling in uneven jumps
    var BAR = 20;
    [['shell', 260], ['fx', 420], ['link', 640]].forEach(function (b) {
      var el = make('div', '', bars), name = make('span', '', el), fill = make('b', '', el), rest = make('span', '', el);
      name.textContent = (b[0] + '      ').slice(0, 7) + '[';
      var p = 0;
      function paint() {
        var n = Math.round(p / 100 * BAR);
        fill.textContent = new Array(n + 1).join('#');
        rest.textContent = new Array(BAR - n + 1).join('.') + '] ' + ('  ' + Math.round(p)).slice(-3) + '%';
      }
      paint();
      at(b[1], function () {
        var id = setInterval(function () {
          p = Math.min(100, p + rand(4, 17));
          paint();
          if (p >= 100) clearInterval(id);
        }, 40);
        loops.push(id);
      });
    });

    // hex dump scrolling up the right side (the left on phones)
    var bytes = window.innerWidth < 720 ? 8 : 16, addr = (Math.random() * 4096) | 0, kept = [];
    function hexByte() { return pick(HEX) + pick(HEX); }
    at(200, function () {
      every(lo() ? 90 : 38, function () {
        var hx = [], tx = '';
        for (var i = 0; i < bytes; i++) {
          hx.push(hexByte());
          tx += pick('..::-=+*#%');
        }
        addr = (addr + bytes) & 0xffff;
        var el = make('div', '', dump);
        el.textContent = ('000' + addr.toString(16)).slice(-4) + '  ' + hx.join(' ') + '  ' + tx;
        kept.push(el);
        if (kept.length > 64) kept.shift().remove();
      });
    });

    // a load counter under the mark
    var shown = 0;
    pct.textContent = '000';
    at(260, function () {
      every(30, function () {
        shown = Math.min(100, shown + rand(1, 6));
        pct.textContent = ('00' + Math.round(shown)).slice(-3);
      });
    });

    // the digest decodes in, flies to the menu title's spot, and a flash
    // hands over to the menu
    at(1380, function () {
      mark.classList.add('is-out');
      pct.classList.add('is-out');
      scr.classList.add('is-dim');
      dig.classList.add('on');
      decode(dig, { duration: 600, pool: HEX });
    });
    at(1990, function () {
      var to = document.querySelector('.digest [data-churn]');
      var a = dig.getBoundingClientRect(), b = to && to.getBoundingClientRect();
      if (!b || !a.width || !b.width) return;
      landed = true;
      dig.classList.add('is-landing');
      dig.style.transform = 'translate(' + (b.left - a.left).toFixed(1) + 'px,' + (b.top - a.top).toFixed(1) + 'px) translate(-50%,-50%) scale(' + (b.width / a.width).toFixed(4) + ')';
    });
    at(2250, function () { flash.classList.add('on'); });
    at(2320, finish);

    function skipNow(e) {
      // swallow the skipping keypress so it does not also drive the menu
      if (e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); }
      finish();
    }
    function finish() {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      loops.forEach(clearInterval);
      window.removeEventListener('keydown', skipNow, true);
      window.removeEventListener('pointerdown', skipNow, true);
      box.classList.add('is-done');
      // after a full run the title is already in place: no second entrance
      if (landed) root.classList.add('booted');
      root.classList.remove('boot');
      setTimeout(function () { box.remove(); }, 420);
      done();
    }
    window.addEventListener('keydown', skipNow, true);
    window.addEventListener('pointerdown', skipNow, true);
  }

  // The hex mark as inline SVG for the boot screen: outline, eyes, and two
  // tick rings turning opposite ways.
  function bootMark(parent) {
    var NS = 'http://www.w3.org/2000/svg';
    function el(tag, attrs, to) {
      var n = document.createElementNS(NS, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      to.appendChild(n);
      return n;
    }
    var svg = el('svg', { viewBox: '-6 -6 44 44', fill: 'none', stroke: 'currentColor', 'class': 'boot-mark' }, parent);
    el('circle', { cx: 16, cy: 16, r: 21, 'stroke-width': 0.6, 'stroke-dasharray': '0.5 2.2', 'class': 'boot-ring' }, svg);
    el('circle', { cx: 16, cy: 16, r: 18.4, 'stroke-width': 0.4, 'stroke-dasharray': '6 3 1 3', 'class': 'boot-ring is-in' }, svg);
    el('path', { d: 'M16 3.5 27 9.75v12.5L16 28.5 5 22.25V9.75Z', 'stroke-width': 1, pathLength: 1, 'class': 'boot-hex' }, svg);
    el('path', { d: 'M10 14.5h4.5', 'stroke-width': 1.6, 'class': 'boot-eye' }, svg);
    el('path', { d: 'M17.5 14.5H22', 'stroke-width': 1.6, 'class': 'boot-eye' }, svg);
    return svg;
  }

  // One decode pass over headings and labels when the page appears, timed
  // to the CSS entrance (menu rows print in from about 0.36s).
  function intro() {
    var base = root.classList.contains('fx-in') ? 240 : 60;
    var booted = root.classList.contains('booted');
    var els = document.querySelectorAll('[data-churn], [data-decode], [data-scramble]');
    var j = 0;
    Array.prototype.forEach.call(els, function (el) {
      var churn = el.hasAttribute('data-churn');
      if (churn && booted) return; // the boot screen already decoded it
      // the stagger stops growing after a few, so long pages never wait
      decode(el, {
        delay: churn ? base : base + 260 + Math.min(j++, 6) * 100,
        duration: churn ? 900 : 520,
        pool: churn ? HEX : SYM
      });
    });
  }

  /* ---------- transitions between sections ---------- */

  var curtainEl = null;
  function curtain() {
    if (!curtainEl) {
      curtainEl = quiet(make('div', 'fx fx-curtain', document.body));
      make('i', 'ct', curtainEl);
      make('i', 'cb', curtainEl);
      make('i', 'cl', curtainEl);
    }
    return curtainEl;
  }

  // Leave with a CRT power-off, and tell the next page (sessionStorage,
  // read by early.js) to power on from the same line.
  function go(href, from) {
    if (root.classList.contains('leaving')) return;
    var item = from && from.closest && from.closest('.item');
    if (item) item.classList.add('is-go');
    root.classList.add('leaving');
    curtain().className = 'fx fx-curtain is-closing';
    try { sessionStorage.setItem('fx.in', String(Date.now())); } catch (e) { /* blocked */ }
    // low tier: the curtain is a quick fade (fx.css)
    setTimeout(function () { location.href = href; }, lo() ? 170 : 430);
  }

  function initNav() {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target || a.hasAttribute('download') || reduced()) return;
      var url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      e.preventDefault();
      go(url.href, a);
    });
    // back/forward cache restores the page as it was left: power it back on
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      root.classList.remove('leaving');
      var gone = document.querySelectorAll('.is-go');
      for (var i = 0; i < gone.length; i++) gone[i].classList.remove('is-go');
      try { sessionStorage.removeItem('fx.in'); } catch (err) { /* blocked */ }
      if (curtainEl) {
        curtainEl.className = 'fx fx-curtain is-opening';
        setTimeout(function () { curtainEl.className = 'fx fx-curtain'; }, 520);
      }
    });
  }

  /* ---------- start ---------- */

  initClock();
  initPotato();
  initCursor();
  initNav();
  initScramble();
  initDigests();
  initTilt();
  initOverlays();
  boot(intro);
  // a cached tier measured on a page without canvases is checked again,
  // once, on the first page that has the mask
  if (tierSrc === 'cache' && tb.weak && document.querySelector('canvas[data-obj]') && !reduced()) {
    tierSrc = 'hint';
    perfLog.src = 'recheck';
  }
  if (tierSrc === 'hint') probe(250);
  watchdog();
  if (root.classList.contains('fx-in')) {
    setTimeout(function () { root.classList.remove('fx-in'); }, 1100);
  }

  window.fx = {
    scramble: scramble,
    decode: decode,
    glitch: glitch,
    reduced: reduced,
    rain: rain,
    burst: function (x, y, s) { rain.burst(x, y, s); },
    obj: obj,
    tier: tier,
    level: level,
    setTier: setTier,
    hold: hold,
    perf: function () {
      var why = tierNow + ' (' + (tierSrc === 'force' ? 'picked by you' : tierSrc === 'cache' ? 'remembered' :
        tierSrc === 'probe' ? 'measured' : 'guessed from the device') + ')' +
        (perfLog.bench !== null ? ', cpu ' + perfLog.bench + ' ms' : '') +
        ', hints ' + perfLog.hint + (perfLog.points !== undefined ? ', score ' + perfLog.points : '') +
        (perfLog.steps.length ? ', last change ' + perfLog.steps[perfLog.steps.length - 1] : '');
      return JSON.parse(JSON.stringify({ tier: tierNow, src: tierSrc, why: why, held: held, start: perfLog.start, startSrc: perfLog.src, hint: perfLog.hint, bench: perfLog.bench, points: perfLog.points, probe: perfLog.probe, watch: perfLog.watch, steps: perfLog.steps }));
    }
  };
})();
