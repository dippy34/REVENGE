/* eggs.js: hidden extras, all optional and all reversible. Nothing here
   is needed to use the site, and nothing fires while you type in a field,
   or on links, buttons, cards and players.

     shatter     rapid clicks on empty background crack the glass, the
                 last one shatters it and the screen reboots in a colour
                 (green, pink, cyan, amber, violet, chaos, back to mono)
     ghost       the sleeping mask on the menu (click it three times), or
                 hold the small hex logo on other pages: a door to /ghost/
     console     ` or ~ drops a terminal (help lists the commands); on
                 touch, hold a finger on empty background for a second,
                 or tap the menu's small hex logo five times
     konami      up up down down left right left right b a (on touch:
                 eight swipes, then two taps)
     words       typed anywhere outside a field: matrix, hello, the digest
     youtube     search "do a barrel roll" or "askew"
     404         left / right or a swipe starts a snake
     idle        about 90 s without input: a screensaver
     clock       five clicks on the menu clock
     extras      drag across the title, rm -rf / in the console, and a
                 very long Shorts session

   Found eggs live in localStorage `eggs` (ids only); the tint for this
   session in sessionStorage `fx.tint`. Uses window.fx when it is there
   (decode, glitch, burst, tier, obj) and degrades when it is not. Colour
   is allowed inside a mode the visitor triggered, nowhere else. */
(function () {
  'use strict';

  var root = document.documentElement;
  var page = root.getAttribute('data-page') || '';
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqFine = window.matchMedia('(hover: hover) and (pointer: fine)');
  var mqCoarse = window.matchMedia('(pointer: coarse)');

  // the site root, from this script's own address (works under a subpath)
  var BASE = (function () {
    try { return new URL('../', document.currentScript.src).href; } catch (e) { return '/'; }
  })();

  var HEX = '0123456789abcdef';
  var SYM = HEX + '#%&*+=<>/\\|_-:;';
  var DIGEST = '631cb8a9';

  function noop() {}
  function now() { return performance.now(); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(pool) { return pool.charAt((Math.random() * pool.length) | 0); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function make(tag, cls, parent) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }
  function quiet(el) { el.setAttribute('aria-hidden', 'true'); return el; }
  function later(ms, fn) { return setTimeout(fn, ms); }

  function fx() { return window.fx || null; }
  function reduced() {
    var f = fx();
    return f && f.reduced ? f.reduced() : mqReduce.matches;
  }
  function tier() {
    var f = fx();
    var t = f && f.tier ? f.tier() : root.getAttribute('data-fx');
    return t === 'low' || t === 'mid' ? t : 'high';
  }
  // particle counts and the like, scaled to what the device can take
  function amount(n) {
    var t = tier();
    return Math.max(1, Math.round(n * (t === 'low' ? 0.3 : t === 'mid' ? 0.6 : 1)));
  }
  function fps() { return tier() === 'low' ? 20 : 30; }
  function glitchEl(el) { var f = fx(); if (el && f && f.glitch) f.glitch(el); }
  function decodeEl(el, opts) {
    var f = fx();
    if (el && f && f.decode) f.decode(el, opts); else if (opts && opts.done) opts.done();
  }
  function obj() { var f = fx(); return f && f.obj ? f.obj : null; }

  // The hunt (hunt.js, loaded after this file): inert unless a frequency
  // is live or a receiver exists. Events queue until it has run; every
  // call is guarded, so a missing or broken hunt.js changes nothing here.
  function hunt() { return window.hunt || null; }
  function huntEv(c) {
    var h = hunt();
    if (h && h.event) { try { h.event(c); } catch (e) { /* ignore */ } return; }
    var q = window.huntEvQ = window.huntEvQ || [];
    if (q.length >= 48 && q.shift) q.shift(); // never grows without hunt.js
    q.push(c);
  }
  function huntDo(name, a, b, c) {
    var h = hunt();
    if (!h || typeof h[name] !== 'function') return null;
    try { return h[name](a, b, c); } catch (e) { return null; }
  }
  function huntReady(fn) { (window.huntQ = window.huntQ || []).push(fn); }
  function objCall(name, arg) {
    var o = obj();
    if (o && typeof o[name] === 'function') return o[name](arg);
    return null;
  }

  // While a full-screen egg covers the page, the page's own rain has no
  // reason to run. fx.hold() if fx.js has it; otherwise the rain is paused
  // only where nothing else drives it (menu, 404) and resumed only when
  // eggs.js was the one that paused it. Calls nest.
  var held = 0, heldRain = false;
  function holdPage(on) {
    var f = fx();
    if (!f) return;
    if (on) {
      if (held++) return;
      if (typeof f.hold === 'function') { f.hold(true); heldRain = true; }
      else if (f.rain && (page === 'menu' || page === '404')) { f.rain.pause(); heldRain = true; }
      return;
    }
    if (!held || --held) return;
    if (!heldRain) return;
    heldRain = false;
    if (typeof f.hold === 'function') f.hold(false); else f.rain.resume();
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) {
    try {
      if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { /* blocked */ }
  }

  // typing in a field (or the console): no egg may fire
  function typing(t) {
    t = t || document.activeElement;
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    return !!(t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }
  // the boot screen or a page transition owns the screen
  function busy() {
    return root.classList.contains('boot') || root.classList.contains('leaving');
  }
  // a video, a game or a proxied page is open
  function absorbed() {
    return root.classList.contains('playing') || root.classList.contains('browsing');
  }

  // A full-screen canvas, capped DPR, sized once (eggs are short-lived).
  function canvasLayer(cls) {
    var cv = quiet(make('canvas', 'egg-layer ' + cls, document.body));
    var dpr = Math.min(window.devicePixelRatio || 1, tier() === 'high' ? 1.5 : 1);
    var w = window.innerWidth, h = window.innerHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cv: cv, ctx: ctx, w: w, h: h };
  }

  // A frame loop at a capped rate that stops in background tabs. fn gets
  // (elapsed ms, frames since last call) and returns false to stop.
  function loop(fn) {
    var raf = 0, start = now(), last = 0, step = 1000 / fps(), dead = false;
    function frame(t) {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < step - 2) return;
      var k = last ? clamp((t - last) / step, 1, 4) : 1;
      last = t;
      if (fn(t - start, k) === false) stop();
    }
    function stop() { dead = true; cancelAnimationFrame(raf); }
    raf = requestAnimationFrame(frame);
    return stop;
  }

  /* ---------- tracker ---------- */

  var EGGS = [
    ['shatter', 'broke the glass'],
    ['ghost', 'woke the ghost'],
    ['console', 'found the console'],
    ['konami', 'overdrive'],
    ['matrix', 'followed the rain'],
    ['hello', 'said hello'],
    ['digest', 'tried to crack it'],
    ['roll', 'did a barrel roll'],
    ['askew', 'knocked it askew'],
    ['snake', 'woke the snake'],
    ['idle', 'fell asleep'],
    ['clock', 'turned back time'],
    ['jelly', 'wobbled the title'],
    ['rm', 'deleted everything'],
    ['reel', 'scrolled too far']
  ];
  var N = EGGS.length;

  function foundList() {
    var raw = lsGet('eggs'), out = [];
    try {
      var a = JSON.parse(raw || '[]');
      if (Array.isArray(a)) {
        for (var i = 0; i < a.length; i++) {
          if (typeof a[i] === 'string' && nameOf(a[i]) && out.indexOf(a[i]) < 0) out.push(a[i]);
        }
      }
    } catch (e) { /* broken: start over */ }
    return out;
  }
  function nameOf(id) {
    for (var i = 0; i < EGGS.length; i++) if (EGGS[i][0] === id) return EGGS[i][1];
    return '';
  }
  function has(id) { return foundList().indexOf(id) >= 0; }

  // first time only: remember it and say so
  function mark(id) {
    huntEv('egg:' + id);
    var list = foundList();
    if (list.indexOf(id) >= 0) return false;
    list.push(id);
    lsSet('eggs', JSON.stringify(list));
    toast([['', 'egg found '], ['b', '[' + list.length + '/' + N + ']'], ['em', '  ' + nameOf(id)]], 3800);
    return true;
  }

  /* ---------- toasts ---------- */

  var toastBox = null;
  // parts: a string, or [[tag, text], ...] with tag '' / 'b' / 'em'
  function toast(parts, life) {
    if (!toastBox) {
      toastBox = make('div', 'egg-toasts', document.body);
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
    }
    life = life || 3200;
    var t = make('div', 'egg-toast', toastBox);
    t.style.setProperty('--life', (life / 1000).toFixed(2) + 's');
    var p = quiet(make('span', '', t));
    p.textContent = '>';
    var body = make('span', '', t);
    if (typeof parts === 'string') parts = [['', parts]];
    for (var i = 0; i < parts.length; i++) {
      var el = parts[i][0] ? make(parts[i][0], '', body) : document.createTextNode('');
      el.textContent = parts[i][1];
      if (!parts[i][0]) body.appendChild(el);
    }
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    later(life, function () {
      t.classList.add('is-out');
      later(320, function () { t.remove(); });
    });
    return t;
  }

  /* ---------- tint ---------- */

  // Each finished shatter moves one step along this list; mono ends it.
  var ORDER = ['green', 'pink', 'cyan', 'amber', 'violet', 'chaos', 'mono'];
  var LABEL = {
    green: 'phosphor green', pink: 'hot pink', cyan: 'cyan', amber: 'amber',
    violet: 'ultraviolet', chaos: 'chaos', gold: 'gold', mono: 'mono'
  };
  var tintEl = null;

  function tintNow() {
    var t = ssGet('fx.tint');
    return LABEL[t] && t !== 'mono' ? t : 'mono';
  }
  // instant: no fade (used on page load, before anything is seen)
  function setTint(name, instant) {
    if (!LABEL[name]) name = 'mono';
    ssSet('fx.tint', name === 'mono' ? null : name);
    if (name === 'mono') {
      if (tintEl) {
        tintEl.classList.remove('is-on');
        var old = tintEl;
        tintEl = null;
        later(instant ? 0 : 800, function () { old.remove(); });
      }
      return;
    }
    if (!tintEl) {
      tintEl = quiet(make('div', 'egg-layer egg-tint', document.body));
      if (instant) tintEl.classList.add('is-now');
    }
    tintEl.setAttribute('data-tint', name);
    if (instant) {
      tintEl.classList.add('is-on');
      // let the first frame settle, then allow fades again
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { if (tintEl) tintEl.classList.remove('is-now'); });
      });
    } else {
      void tintEl.offsetWidth;
      tintEl.classList.add('is-on');
    }
  }
  // the tint really changed (shatter, console): tell the hunt
  function tintTo(name, instant) {
    var was = tintNow();
    setTint(name, instant);
    if (tintNow() !== was) huntEv('tint:' + tintNow());
  }
  // A verified solver certificate adds the signal tint. A session already
  // in it (from another page) comes back once the certificate checks out.
  function syncSolver() {
    var s = huntDo('solver');
    if (s && s.any) {
      if (LABEL.signal) return;
      LABEL.signal = 'signal';
      if (ssGet('fx.tint') === 'signal' && !tintEl) setTint('signal', true);
    } else if (LABEL.signal) {
      delete LABEL.signal;
      if (tintEl && tintEl.getAttribute('data-tint') === 'signal') setTint('mono', false);
    }
  }
  function nextTint() {
    var i = ORDER.indexOf(tintNow());
    // mono (or gold, set from the console) starts the cycle again
    if (i < 0 || i === ORDER.length - 1) return ORDER[0];
    return ORDER[i + 1];
  }

  /* ---------- reboot moment ---------- */

  // black, a CRT line, two lines of text, then the page again
  function reboot(lines, mid, done) {
    var calm = reduced();
    var box = quiet(make('div', 'egg-layer egg-reboot', document.body));
    var p = make('p', '', box);
    for (var i = 0; i < lines.length; i++) {
      var b = make(i ? 'b' : 'span', '', p);
      b.textContent = lines[i] + (i < lines.length - 1 ? '\n' : '');
    }
    void box.offsetWidth;
    box.classList.add('is-on');
    later(calm ? 520 : 200, function () {
      if (mid) mid();
      if (!calm) decodeEl(p, { duration: 420 });
    });
    later(calm ? 1500 : 1150, function () {
      box.classList.add('is-out');
      later(650, function () {
        box.remove();
        if (done) done();
      });
    });
  }

  /* ---------- shatter ---------- */

  // What counts as empty background: a click whose target is a plain
  // layout box (no text of its own) with nothing interactive or content
  // around it, up to <body>.
  var NOT_BG = 'a, button, input, textarea, select, label, summary, details, form, nav, header, iframe, video, img, svg, pre, code, dialog, ' +
    '[role], [tabindex]:not([tabindex="-1"]), [contenteditable], [data-lock], [data-cursor], [draggable="true"], ' +
    '[class*="card"], [class*="tile"], [class*="chip"], [class*="player"], [class*="frame"], [class*="toast"], ' +
    '[class*="shelf"], [class*="reel"], [class*="bar"], [class*="menu"], [class*="egg-"]';
  function isBackground(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t === document.body || t === root) return true;
    if (t.id === 'rain') return true;
    if (/^(CANVAS|SPAN|B|I|EM|STRONG|P|H1|H2|H3|H4|SMALL|LI)$/.test(t.tagName)) return false;
    for (var c = t.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return false;
    }
    for (var el = t; el && el !== document.body; el = el.parentElement) {
      if (el.matches(NOT_BG)) return false;
    }
    return true;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var GOAL = 10;
  var sh = { n: 0, last: 0, glass: null, heal: 0, busy: false };

  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function glass() {
    if (sh.glass && sh.glass.isConnected) return sh.glass;
    sh.glass = svgEl('svg', { 'class': 'egg-layer egg-glass', 'aria-hidden': 'true', width: '100%', height: '100%' }, document.body);
    return sh.glass;
  }
  // a jagged line from (x, y) along angle a for length len
  function jag(x, y, a, len, parts) {
    var d = 'M' + x.toFixed(1) + ' ' + y.toFixed(1), pts = [[x, y]];
    for (var i = 1; i <= parts; i++) {
      var r = len * i / parts, aa = a + rand(-0.16, 0.16);
      var px = x + Math.cos(aa) * r, py = y + Math.sin(aa) * r;
      d += 'L' + px.toFixed(1) + ' ' + py.toFixed(1);
      pts.push([px, py]);
    }
    return { d: d, pts: pts };
  }
  function strokes(g, d, web, delay) {
    var cls = web ? ['k-shade', 'k-web'] : ['k-shade', 'k-glow', 'k-line'];
    for (var i = 0; i < cls.length; i++) {
      var p = svgEl('path', { d: d, pathLength: 1, 'class': cls[i] }, g);
      if (delay) p.style.animationDelay = delay + 'ms';
    }
  }
  // One impact: radial fractures that grow with every click in the run,
  // joined by web strands once the glass is under real stress.
  function crack(x, y, n) {
    var g = svgEl('g', {}, glass());
    var spokes = Math.min(4 + Math.ceil(n * 0.7), 11);
    var reach = 34 + n * n * 5.5 + rand(0, 30);
    var off = rand(0, 6.283), lines = [];
    for (var i = 0; i < spokes; i++) {
      var a = off + i * 6.283 / spokes + rand(-0.25, 0.25);
      var j = jag(x, y, a, reach * rand(0.55, 1.15), 3 + ((Math.random() * 3) | 0));
      strokes(g, j.d, false, 0);
      lines.push(j.pts);
    }
    if (n >= 3) {
      var rings = n >= 7 ? 3 : n >= 5 ? 2 : 1;
      for (var r = 1; r <= rings; r++) {
        for (var s = 0; s < lines.length; s++) {
          var A = lines[s], B = lines[(s + 1) % lines.length];
          var ia = Math.min(r, A.length - 1), ib = Math.min(r, B.length - 1);
          if (Math.random() < 0.18) continue;
          var mx = (A[ia][0] + B[ib][0]) / 2 + rand(-6, 6), my = (A[ia][1] + B[ib][1]) / 2 + rand(-6, 6);
          strokes(g, 'M' + A[ia][0].toFixed(1) + ' ' + A[ia][1].toFixed(1) + 'Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + B[ib][0].toFixed(1) + ' ' + B[ib][1].toFixed(1), true, 120 + r * 50);
        }
      }
    }
    svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: (1.5 + n * 0.25).toFixed(1) }, g);
    if (!reduced()) {
      sh.glass.classList.remove('is-jolt');
      void sh.glass.getBoundingClientRect();
      sh.glass.classList.add('is-jolt');
    }
  }
  // the glass heals if the clicking stops
  function heal() {
    var g = sh.glass;
    sh.n = 0;
    root.classList.remove('egg-tapping');
    if (!g) return;
    sh.glass = null;
    g.classList.add('is-heal');
    later(950, function () { g.remove(); });
  }

  function onBackgroundClick(e) {
    if (ateClick) { ateClick = false; return; }
    if (sh.busy || busy() || e.button !== 0 || !isBackground(e.target)) return;
    if (mask.hit && mask.hit.contains(e.target)) return;
    var t = now();
    sh.n = t - sh.last < 900 ? sh.n + 1 : 1;
    sh.last = t;
    clearTimeout(sh.heal);
    // a run has started: fast taps must not zoom, for its length only
    root.classList.add('egg-tapping');
    var x = e.clientX, y = e.clientY;
    if (sh.n >= GOAL) {
      shatter(x, y);
      return;
    }
    crack(x, y, sh.n);
    sh.heal = later(1700, heal);
  }

  // Shards: the screen cut into wedges around the impact (rings x
  // spokes), each one falling, turning and fading on its own.
  function shards(x, y) {
    var L = canvasLayer('egg-shards'), ctx = L.ctx, W = L.w, H = L.h;
    // low keeps enough wedges to read as glass (they are cheap to draw)
    // and saves on rings, static and frame rate instead
    var lo = tier() === 'low';
    var spokes = lo ? 10 : tier() === 'mid' ? 13 : 16, rings = lo ? 3 : 5;
    var far = Math.sqrt(Math.max(x, W - x) * Math.max(x, W - x) + Math.max(y, H - y) * Math.max(y, H - y)) + 40;
    var rad = [0];
    for (var r = 1; r <= rings; r++) rad.push(far * Math.pow(r / rings, 1.5) * rand(0.9, 1.05));
    var ang = [];
    for (var s = 0; s < spokes; s++) ang.push(s * 6.283 / spokes + rand(-0.12, 0.12));
    var list = [];
    function pt(ri, ai) {
      var a = ang[ai % spokes] + (ai >= spokes ? 6.283 : 0);
      return [x + Math.cos(a) * rad[ri], y + Math.sin(a) * rad[ri]];
    }
    for (var ri = 0; ri < rings; ri++) {
      for (var ai = 0; ai < spokes; ai++) {
        var poly = ri === 0 ? [[x, y], pt(1, ai), pt(1, ai + 1)] : [pt(ri, ai), pt(ri + 1, ai), pt(ri + 1, ai + 1), pt(ri, ai + 1)];
        var cx = 0, cy = 0;
        for (var q = 0; q < poly.length; q++) { cx += poly[q][0]; cy += poly[q][1]; }
        cx /= poly.length;
        cy /= poly.length;
        var dx = cx - x, dy = cy - y, dd = Math.sqrt(dx * dx + dy * dy) || 1;
        for (var q2 = 0; q2 < poly.length; q2++) { poly[q2][0] -= cx; poly[q2][1] -= cy; }
        list.push({
          p: poly, x: cx, y: cy,
          vx: dx / dd * rand(1.5, 5) * (1 + ri * 0.2), vy: dy / dd * rand(1, 4) - rand(1, 4),
          r: 0, vr: rand(-0.09, 0.09), a: lo ? rand(0.03, 0.08) : rand(0.05, 0.14), delay: ri * 70 + rand(0, 60)
        });
      }
    }
    loop(function (el, k) {
      ctx.clearRect(0, 0, W, H);
      var live = false;
      for (var i = 0; i < list.length; i++) {
        var S = list[i];
        if (el > S.delay) {
          S.vy += 0.55 * k;
          S.x += S.vx * k;
          S.y += S.vy * k;
          S.r += S.vr * k;
        }
        if (S.y - 400 > H) continue;
        live = true;
        var fade = clamp(1 - (el - 600) / 900, 0, 1);
        ctx.save();
        ctx.translate(S.x, S.y);
        ctx.rotate(S.r);
        ctx.beginPath();
        ctx.moveTo(S.p[0][0], S.p[0][1]);
        for (var j = 1; j < S.p.length; j++) ctx.lineTo(S.p[j][0], S.p[j][1]);
        ctx.closePath();
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(255,255,255,' + S.a.toFixed(3) + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.75)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      if (!live || el > 1700) { L.cv.remove(); return false; }
    });
  }

  // TV static for a few frames: a tiny noise image scaled up
  function staticBurst(ms) {
    var cv = quiet(make('canvas', 'egg-layer egg-static', document.body));
    cv.width = 160;
    cv.height = 100;
    var ctx = cv.getContext('2d'), img = ctx.createImageData(160, 100), d = img.data;
    loop(function (el) {
      for (var i = 0; i < d.length; i += 4) {
        var v = Math.random() < 0.5 ? 0 : (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      if (el > ms) { cv.remove(); return false; }
    });
  }

  function hardGlitch(ms) {
    var els = document.querySelectorAll('.digest, h1, .yt-path, .g-path, .s-path, .p-crumb');
    var end = now() + ms;
    (function again() {
      for (var i = 0; i < els.length; i++) glitchEl(els[i]);
      objCall('glitch');
      if (now() < end) later(140, again);
    })();
  }

  function shatter(x, y) {
    sh.busy = true;
    sh.n = 0;
    clearTimeout(sh.heal);
    root.classList.remove('egg-tapping');
    var to = nextTint();
    var lines = to === 'mono' ? ['> reboot', 'mono restored.'] : ['> reboot', 'tint: ' + LABEL[to]];
    var g = sh.glass;
    sh.glass = null;
    if (reduced()) {
      if (g) { g.classList.add('is-heal'); later(950, function () { g.remove(); }); }
      reboot(lines, function () { tintTo(to, true); }, function () { sh.busy = false; mark('shatter'); });
      return;
    }
    if (g) g.remove();
    var f = fx();
    if (f && f.burst) f.burst(x, y, 3);
    var flash = quiet(make('div', 'egg-layer egg-flash', document.body));
    later(520, function () { flash.remove(); });
    if (tier() !== 'low') staticBurst(320);
    shards(x, y);
    hardGlitch(600);
    if (tier() !== 'low') {
      root.classList.add('egg-quake');
      later(450, function () { root.classList.remove('egg-quake'); });
    }
    later(620, function () {
      reboot(lines, function () { tintTo(to, true); }, function () {
        sh.busy = false;
        mark('shatter');
        if (to === 'mono') degauss();
      });
    });
  }

  // The end of the cycle: a CRT degauss, a fast hue ripple and a wobble
  // that settle into white. Not on low, not under reduced motion.
  function degauss() {
    if (reduced() || tier() === 'low') return;
    var d = quiet(make('div', 'egg-layer egg-degauss', document.body));
    root.classList.add('egg-wobble');
    later(950, function () { d.remove(); root.classList.remove('egg-wobble'); });
  }

  /* ---------- ghost door ---------- */

  var doorOpen = false;
  // Wake whatever face this page has, whisper, then power off into the
  // ghost's page through fx.js's own transition (a real link click).
  function door(via, at) {
    if (doorOpen) return;
    doorOpen = true;
    mark('ghost');
    objCall('wake', true);
    whisper("> who's there?", at);
    later(reduced() ? 900 : 1500, function () {
      var a = make('a', 'egg-door', document.body);
      a.href = BASE + 'ghost/?via=' + encodeURIComponent(via);
      a.tabIndex = -1;
      quiet(a);
      a.click();
      // the transition is gone after a back/forward restore: allow again
      later(3000, function () { doorOpen = false; a.remove(); });
    });
  }

  function whisper(text, at, soft) {
    var p = quiet(make('p', 'egg-whisper' + (soft ? ' is-soft' : ''), document.body));
    var x = at ? at[0] : window.innerWidth / 2, y = at ? at[1] : window.innerHeight / 2;
    p.style.left = clamp(x, 110, window.innerWidth - 110).toFixed(0) + 'px';
    p.style.top = clamp(y, 20, window.innerHeight - 40).toFixed(0) + 'px';
    p.textContent = text;
    decodeEl(p, { duration: 520 });
    later(2500, function () { p.remove(); });
  }

  function floatGlyph(x, y, ch, cls) {
    var s = quiet(make('span', 'egg-glyph' + (cls ? ' ' + cls : ''), document.body));
    s.textContent = ch;
    s.style.left = x.toFixed(0) + 'px';
    s.style.top = y.toFixed(0) + 'px';
    s.style.setProperty('--dx', rand(-26, 26).toFixed(0) + 'px');
    later(cls === 'is-snore' ? 2700 : 1400, function () { s.remove(); });
  }

  // The menu's mask is asleep. An invisible circle sits over it (the
  // canvas itself lets clicks through) and answers each click; the third
  // within a few seconds wakes it.
  var mask = { hit: null, cv: null, n: 0, last: 0 };
  function initMask() {
    var cv = document.querySelector('canvas[data-obj="mark"]');
    var stage = cv && cv.parentElement;
    if (!cv || !stage) return;
    mask.cv = cv;
    var hit = quiet(make('div', 'egg-mask', null));
    hit.setAttribute('data-cursor', '?');
    stage.insertBefore(hit, cv.nextSibling);
    mask.hit = hit;
    place();
    window.addEventListener('resize', function () { later(200, place); });
    window.addEventListener('load', place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    stage.addEventListener('pointerenter', place);
    later(2600, place); // after the boot or the entrance has settled

    hit.addEventListener('click', function (e) {
      if (busy() || doorOpen) return;
      place();
      var t = now();
      mask.n = t - mask.last < 3500 ? mask.n + 1 : 1;
      mask.last = t;
      var r = hit.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      if (mask.n >= 3) {
        mask.n = 0;
        door('mask', [cx, r.top + r.height * 0.86]);
        return;
      }
      var eye = eyes();
      if (mask.n === 1) {
        objCall('blink');
        floatGlyph(eye[0] + 18, eye[1], 'z');
        later(240, function () { floatGlyph(eye[0] + 34, eye[1] - 14, 'z'); });
      } else {
        objCall('glitch');
        objCall('blink');
        floatGlyph(eye[0] + 18, eye[1], '?');
        whisper('hm?', [cx, r.top + r.height * 0.86], true);
      }
    });
  }
  // a point just above and right of the mask's eyes, from its live box
  function eyes() {
    var o = obj(), r = null;
    if (o && typeof o.rect === 'function') {
      try { r = o.rect(); } catch (e) { r = null; }
    }
    if (!r || !r.width) r = mask.hit.getBoundingClientRect();
    return [r.left + r.width * 0.56, r.top + r.height * 0.4];
  }
  // The mask snores: after a while with no input, a faint z drifts up
  // from it. The only hint a touch visitor gets that it can be woken.
  function snore() {
    if (!mask.hit || doorOpen || busy() || con.open || sh.busy || rainOn) return;
    var e = eyes();
    floatGlyph(e[0] + 18, e[1], 'z', 'is-snore');
    later(900, function () { if (!idle.on) floatGlyph(e[0] + 32, e[1] - 12, 'z', 'is-snore'); });
  }
  // the circle follows the canvas' box (its CSS differs on phones)
  function place() {
    if (!mask.hit) return;
    var o = obj(), r = null;
    if (o && typeof o.rect === 'function') {
      try { r = o.rect(); } catch (e) { r = null; }
    }
    if (!r || !r.width) r = mask.cv.getBoundingClientRect();
    var s = mask.hit.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var d = Math.min(r.width, r.height) * 0.74;
    var st = mask.hit.style;
    st.left = (r.left - s.left + (r.width - d) / 2).toFixed(1) + 'px';
    st.top = (r.top - s.top + (r.height - d) / 2).toFixed(1) + 'px';
    st.width = st.height = d.toFixed(1) + 'px';
  }

  // Pages without the mask: hold the small hex logo for 1.5 s.
  var LOGOS = '.yt-logo, .g-back, .s-back, .p-logo, .is-lost a.home';
  var hold = { el: null, t: 0, x: 0, y: 0, ate: null };
  function initHold() {
    document.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || doorOpen) return;
      var el = e.target.closest && e.target.closest(LOGOS);
      if (!el) return;
      cancelHold();
      hold.el = el;
      hold.x = e.clientX;
      hold.y = e.clientY;
      el.classList.add('egg-hold');
      hold.t = later(1500, function () {
        var r = el.getBoundingClientRect();
        el.classList.remove('egg-hold');
        el.classList.add('egg-awake');
        hold.ate = el; // the click that ends this press must not navigate
        hold.el = null;
        door('logo', [r.left + r.width / 2 + 90, r.bottom + 18]);
      });
    });
    document.addEventListener('pointermove', function (e) {
      if (hold.el && Math.abs(e.clientX - hold.x) + Math.abs(e.clientY - hold.y) > 14) cancelHold();
    }, { passive: true });
    document.addEventListener('pointerup', function () { if (hold.el) cancelHold(); });
    document.addEventListener('pointercancel', cancelHold);
    // long-press menus on touch
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest && e.target.closest(LOGOS) && (hold.el || hold.ate)) e.preventDefault();
    });
    window.addEventListener('click', function (e) {
      if (!hold.ate) return;
      if (hold.ate.contains(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      hold.ate = null;
    }, true);
  }
  function cancelHold() {
    clearTimeout(hold.t);
    if (hold.el) hold.el.classList.remove('egg-hold');
    hold.el = null;
  }

  /* ---------- console ---------- */

  var con = { el: null, log: null, input: null, open: false, hist: [], hi: 0, back: null };

  function buildConsole() {
    var el = make('div', 'egg-con', document.body);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'console');
    var head = quiet(make('div', 'egg-con-head', el));
    var l = make('span', '', head), r = make('span', '', head);
    l.textContent = '~/console';
    r.textContent = 'help · esc closes';
    con.log = make('div', 'egg-con-log', el);
    con.log.setAttribute('aria-live', 'polite');
    // touch screens have no keyboard until the field is tapped: a row of
    // commands to tap instead (shown on coarse pointers only, by CSS)
    var chips = make('div', 'egg-con-chips', el);
    ['help', 'eggs', 'tint mono', 'ghost', 'matrix', 'hello', 'exit'].forEach(function (c) {
      var b = make('button', '', chips);
      b.type = 'button';
      b.textContent = c;
      b.addEventListener('click', function () { run(c); });
    });
    var row = make('form', 'egg-con-row', el);
    row.setAttribute('autocomplete', 'off');
    quiet(make('span', '', row)).textContent = '>';
    var lab = make('label', 'sr', row);
    lab.textContent = 'console command';
    lab.htmlFor = 'egg-con-in';
    var input = make('input', '', row);
    input.id = 'egg-con-in';
    input.type = 'text';
    input.maxLength = 120;
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('enterkeyhint', 'go');
    con.el = el;
    con.input = input;

    row.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value;
      input.value = '';
      run(v);
    });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation(); // page shortcuts never see console keys
      // the key itself, not its position: on other layouts that key types
      // characters someone may want in a command
      if (e.key === 'Escape' || e.key === '`' || e.key === '~') {
        e.preventDefault();
        closeConsole();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!con.hist.length) return;
        con.hi = clamp(con.hi + (e.key === 'ArrowUp' ? -1 : 1), 0, con.hist.length);
        input.value = con.hist[con.hi] || '';
      } else if (e.key === 'Tab' && input.value && !/\s/.test(input.value)) {
        e.preventDefault();
        var m = (huntDo('pass') ? COMMANDS.concat('rx') : COMMANDS).filter(function (c) { return c.indexOf(input.value) === 0; });
        if (m.length === 1) input.value = m[0] + ' ';
        else if (m.length) say(m.join('  '), 'is-dim');
      }
    });
    say('nobody@631cb8a9 ~ % type help', 'is-dim');
  }

  function openConsole() {
    if (!con.el) buildConsole();
    if (con.open) return;
    con.open = true;
    con.back = document.activeElement;
    con.el.classList.add('is-open');
    // no focus on touch: it would throw the on-screen keyboard over the page
    if (!mqCoarse.matches) con.input.focus({ preventScroll: true });
    mark('console');
  }
  function closeConsole() {
    if (!con.open) return;
    con.open = false;
    con.el.classList.remove('is-open');
    con.input.blur();
    var b = con.back;
    con.back = null;
    if (b && b.focus && b.isConnected && b !== document.body) b.focus({ preventScroll: true });
  }
  function say(text, cls) {
    var d = make('div', cls || '', con.log);
    d.textContent = text;
    while (con.log.children.length > 200) con.log.firstChild.remove();
    con.log.scrollTop = con.log.scrollHeight;
    return d;
  }

  var COMMANDS = ['help', 'eggs', 'clear', 'tint', 'fx', 'matrix', 'ghost', 'talk', 'ai', 'wake', 'reboot',
    'whoami', 'date', 'sudo', 'exit', 'ls', 'cd', 'cat', 'echo', 'hello', 'rm', 'history'];

  function tintNames() {
    var t = ORDER.slice();
    if (has('konami')) t.splice(6, 0, 'gold');
    if (LABEL.signal) t.splice(t.length - 1, 0, 'signal');
    return t;
  }

  // console commands the hunt hears about (CONTRACT 9.2): the name after
  // aliases, plus the argument when it is one of a few fixed words
  var ALIAS = { '?': 'help', cls: 'clear', su: 'sudo', quit: 'exit', q: 'exit', hi: 'hello' };
  var ARGS = {
    ls: ['-a', '-la', '-al'],
    cd: ['~', '/', '..', 'youtube', 'games', 'proxy', '.ghost', 'ghost'],
    fx: ['high', 'mid', 'low', 'auto'],
    tint: ['mono', 'green', 'pink', 'cyan', 'amber', 'violet', 'chaos', 'gold', 'signal']
  };
  function cmdEv(cmd, arg) {
    var name = ALIAS[cmd] || cmd;
    if (COMMANDS.indexOf(name) < 0) return;
    var a = name === 'cd' && arg !== '/' ? arg.replace(/\/$/, '') : arg;
    huntEv('cmd:' + name + (ARGS[name] && ARGS[name].indexOf(a) >= 0 ? ':' + a : ''));
  }

  // A line in the door's published shape goes to the hunt, nothing else
  // ever does. Only while a frequency is live (shape() is null otherwise).
  function doorLine(line) {
    var re = huntDo('shape');
    if (!re || typeof re.test !== 'function') return false;
    var hit = false;
    try { re.lastIndex = 0; hit = re.test(line.toLowerCase()); } catch (e) { hit = false; }
    if (!hit) return false;
    say('listening...', 'is-dim');
    var p = huntDo('door', line);
    var fail = function () { say('that did not come through.', 'is-dim'); };
    if (!p || typeof p.then !== 'function') { fail(); return true; }
    p.then(function (r) {
      r = r || {};
      if (typeof r.say === 'string' && r.say) say(r.say, r.ok ? 'is-hi' : ''); else if (!r.ok) fail();
      if (r.ok) closeConsole(); // the hunt navigates to the receiver
    }, fail);
    return true;
  }

  function run(raw) {
    var line = String(raw || '').replace(/\s+/g, ' ').trim();
    say('> ' + line, 'is-in');
    if (!line) return;
    con.hist.push(line);
    if (con.hist.length > 30) con.hist.shift();
    con.hi = con.hist.length;
    var args = line.toLowerCase().split(' ');
    var cmd = args[0], arg = args[1] || '';
    cmdEv(cmd, arg);
    switch (cmd) {
      case 'help':
      case '?':
        [
          'help            this list',
          'eggs            what you have found',
          'clear           wipe the screen',
          'tint <name>     ' + tintNames().join(' '),
          'fx <tier>       high mid low auto  (now ' + tier() + ')',
          'matrix          follow the rain',
          'ghost           knock. something sleeps in the mask',
          'reboot          power cycle',
          'whoami · date · ls · echo · sudo · exit'
        ].forEach(function (s) { say(s); });
        break;
      case 'eggs':
        var got = foundList();
        say('found ' + got.length + '/' + N, 'is-hi');
        EGGS.forEach(function (e, i) {
          var on = got.indexOf(e[0]) >= 0;
          say((i < 9 ? '0' : '') + (i + 1) + '  ' + (on ? '[x] ' + e[1] : '[ ] ???'), on ? '' : 'is-dim');
        });
        var r16 = huntDo('eggRow');
        if (r16 && r16.label) say('16  ' + (r16.done ? '[x] ' : '[ ] ') + r16.label, r16.done ? '' : 'is-dim');
        break;
      case 'clear':
      case 'cls':
        con.log.textContent = '';
        break;
      case 'tint':
        if (!arg) { say('tint: ' + tintNow() + '. try ' + tintNames().join(' ')); break; }
        if (arg === 'gold' && !has('konami')) { say('tint: gold is locked.', 'is-bad'); break; }
        if (!LABEL[arg]) { say('tint: no such colour. try ' + tintNames().join(' '), 'is-bad'); break; }
        tintTo(arg, false);
        say('tint: ' + LABEL[arg] + '.');
        break;
      case 'fx':
        var f = fx();
        if (!arg) { say('fx: tier ' + tier() + '.'); break; }
        if (!/^(high|mid|low|auto)$/.test(arg)) { say('fx: high, mid, low or auto.', 'is-bad'); break; }
        if (!f || !f.setTier) { say('fx: tiers are not available here.', 'is-bad'); break; }
        f.setTier(arg);
        say('fx: ' + (arg === 'auto' ? 'auto, now ' + tier() : 'tier ' + arg + ', kept') + '.');
        break;
      case 'matrix':
        closeConsole();
        later(320, matrix);
        break;
      case 'ghost':
      case 'talk':
      case 'ai':
      case 'wake':
        say('knocking...', 'is-dim');
        later(500, function () { say('someone answered.', 'is-hi'); });
        later(900, function () { closeConsole(); door(cmd); });
        break;
      case DIGEST:
        // the typed-word egg, for screens without a keyboard
        say('cracking...', 'is-dim');
        later(400, function () { closeConsole(); crackDigest(); });
        break;
      case 'reboot':
        lsSet('boot', '0');
        try { localStorage.removeItem('boot'); } catch (e) { /* blocked */ }
        say(reduced() ? 'reboot: motion is reduced, so the boot stays off.' : 'rebooting...', 'is-dim');
        later(600, function () { closeConsole(); follow(BASE); });
        break;
      case 'whoami':
        say(huntDo('whoami') || 'nobody.');
        break;
      case 'date':
        say(new Date().toString().toLowerCase().replace(/ \(.*\)$/, ''));
        break;
      case 'sudo':
      case 'su':
        say('nice try.', 'is-hi');
        break;
      case 'exit':
      case 'quit':
      case 'q':
        closeConsole();
        break;
      case 'ls':
        say(arg === '-a' || arg === '-la' || arg === '-al' ? '.  ..  .ghost/  youtube/  games/  proxy/' : 'youtube/  games/  proxy/');
        break;
      case 'cd':
        var to = { '~': '', '/': '', '..': '', youtube: 'youtube/', games: 'games/', proxy: 'proxy/', '.ghost': 'ghost/', ghost: 'ghost/' };
        var dir = arg.replace(/\/$/, '') || '~';
        if (!(dir in to)) { say('cd: ' + dir + ': no such directory', 'is-bad'); break; }
        if (to[dir] === 'ghost/') { closeConsole(); door('cd'); break; }
        closeConsole();
        follow(BASE + to[dir]);
        break;
      case 'cat':
        say(arg ? 'cat: ' + arg + ': it ran away.' : 'meow.');
        break;
      case 'echo':
        say(line.slice(5));
        break;
      case 'hello':
      case 'hi':
        say('hello.');
        hello();
        break;
      case 'history':
        con.hist.forEach(function (h, i) { say(('  ' + (i + 1)).slice(-3) + '  ' + h, 'is-dim'); });
        break;
      case 'rm':
        if (/-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(arg) && (args[2] === '/' || args[2] === '/*' || args[2] === '~')) wipe();
        else say('rm: refusing to remove anything small.', 'is-bad');
        break;
      case 'rx':
        // the receiver, only while one exists; otherwise not a command
        if (huntDo('pass')) { closeConsole(); huntDo('goRx'); break; }
        /* falls through */
      default:
        if (doorLine(line)) break;
        say(cmd + ': command not found', 'is-bad');
    }
  }

  // navigate through fx.js's power-off, like any link on the page
  function follow(href) {
    var a = quiet(make('a', 'egg-door', document.body));
    a.href = href;
    a.tabIndex = -1;
    a.click();
    later(3000, function () { a.remove(); });
  }

  // rm -rf /: the console deletes the site, line by line, then doesn't
  function wipe() {
    var paths = ['/youtube', '/games', '/proxy', '/css', '/js', '/assets/fonts', '/fx', '/the ghost', '/you'];
    var calm = reduced();
    paths.forEach(function (p, i) {
      later(90 + i * 110, function () { say('removed ' + p, 'is-dim'); });
    });
    later(220, function () { root.classList.add('egg-rm'); holdPage(true); });
    later(90 + paths.length * 110 + 500, function () {
      say('...', 'is-dim');
      if (!calm) hardGlitch(300);
    });
    later(90 + paths.length * 110 + 1300, function () {
      root.classList.remove('egg-rm');
      holdPage(false);
      say('just kidding. nothing was deleted.', 'is-hi');
      mark('rm');
    });
  }

  /* ---------- matrix, overdrive ---------- */

  var rainOn = false;
  // Full-screen falling glyphs over the page. colour = css colour of the
  // trails; dense = konami's flood (faster, white, shorter).
  function glyphRain(ms, colour, head, dense, done) {
    if (rainOn) return;
    rainOn = true;
    // the matrix sits above the tint (it keeps its own green); the
    // konami flood stays under it and takes the tint's colour
    var L = canvasLayer('egg-rain' + (dense ? '' : ' is-top')), ctx = L.ctx, W = L.w, H = L.h;
    holdPage(true);
    var size = tier() === 'low' ? 24 : tier() === 'mid' ? 19 : 16;
    var cols = Math.ceil(W / size), drops = [];
    for (var i = 0; i < cols; i++) drops.push({ y: -rand(0, H / size) * (dense ? 0.3 : 1), v: rand(0.5, 1) * (dense ? 1.6 : 1) });
    var pool = HEX + ':.=*+-<>|';
    ctx.font = size + 'px M, ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    void L.cv.offsetWidth;
    L.cv.classList.add('is-on');
    var fading = false;

    function end() {
      L.cv.classList.remove('is-on');
      later(950, function () { L.cv.remove(); rainOn = false; holdPage(false); if (done) done(); });
    }
    if (reduced()) {
      // one still field of glyphs, faded in and out
      ctx.fillStyle = 'rgba(0,0,0,.9)';
      ctx.fillRect(0, 0, W, H);
      for (var c = 0; c < cols; c++) {
        for (var r = 0; r < H / size; r++) {
          if (Math.random() < 0.45) continue;
          ctx.globalAlpha = rand(0.08, 0.7);
          ctx.fillStyle = colour;
          ctx.fillText(pick(pool), c * size, r * size);
        }
      }
      later(ms, end);
      return;
    }
    loop(function (el, k) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = dense ? 'rgba(0,0,0,.14)' : 'rgba(0,0,0,.08)';
      ctx.fillRect(0, 0, W, H);
      for (var i2 = 0; i2 < cols; i2++) {
        var d = drops[i2], row = Math.floor(d.y), px = i2 * size;
        if (row !== d.r) {
          // the old head turns into trail, a fresh bright glyph leads
          if (d.r != null && d.r >= 0) {
            ctx.fillStyle = '#000';
            ctx.fillRect(px, d.r * size, size, size);
            ctx.fillStyle = colour;
            ctx.fillText(d.g, px, d.r * size);
          }
          d.g = pick(pool);
          d.r = row;
          if (row >= 0) {
            ctx.fillStyle = '#000';
            ctx.fillRect(px, row * size, size, size);
            ctx.fillStyle = head;
            ctx.fillText(d.g, px, row * size);
          }
        }
        d.y += d.v * k * (dense ? 1.4 : 1);
        if (row * size > H && Math.random() < 0.06 * k) { d.y = -rand(0, 8); d.r = null; }
      }
      if (!fading && el > ms - 900) { fading = true; end(); }
      if (!L.cv.isConnected) return false;
    });
  }

  function matrix() {
    if (busy() || rainOn) return;
    mark('matrix');
    glyphRain(8000, '#22ff66', '#d8ffe4', false);
  }

  // glyph confetti from the middle of the screen
  function confetti() {
    var L = canvasLayer('egg-rain is-on'), ctx = L.ctx, W = L.w, H = L.h;
    var n = amount(150), list = [];
    var cols = ['#fff', '#fff', '#d6d6d6', '#ffd04a', '#ffe08a'];
    for (var i = 0; i < n; i++) {
      var a = rand(0, 6.283), v = rand(4, 15);
      list.push({ x: W / 2, y: H / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: rand(0, 6), vr: rand(-0.3, 0.3), c: cols[i % cols.length], g: pick(SYM), s: rand(12, 26) | 0 });
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    loop(function (el, k) {
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = clamp(1 - (el - 1500) / 700, 0, 1);
      for (var j = 0; j < list.length; j++) {
        var P = list[j];
        P.vy += 0.32 * k;
        P.vx *= 0.985;
        P.x += P.vx * k;
        P.y += P.vy * k;
        P.r += P.vr * k;
        ctx.save();
        ctx.translate(P.x, P.y);
        ctx.rotate(P.r);
        ctx.fillStyle = P.c;
        ctx.font = P.s + 'px M, ui-monospace, Menlo, monospace';
        ctx.fillText(P.g, 0, 0);
        ctx.restore();
      }
      if (el > 2200) { L.cv.remove(); return false; }
    });
  }

  var KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
  var kPos = 0;
  function overdrive() {
    var first = !has('konami');
    mark('konami');
    toast(first ? [['b', 'overdrive.'], ['em', '  tint gold unlocked']] : [['b', 'overdrive.']], 3400);
    if (reduced()) return;
    var f = fx();
    if (f && f.burst) f.burst(window.innerWidth / 2, window.innerHeight / 2, 4);
    if (!rainOn) glyphRain(2800, 'rgba(255,255,255,.8)', '#fff', true);
    // low: the flood and the burst are enough, no second full-screen canvas
    if (tier() !== 'low') confetti();
    hardGlitch(1300);
    if (tier() !== 'low') {
      root.classList.add('egg-quake');
      later(450, function () { root.classList.remove('egg-quake'); });
    }
  }

  /* ---------- typed words ---------- */

  var typed = '', typedAt = 0;
  function hello() {
    mark('hello');
    toast('hello.', 2600);
    objCall('blink');
    var logos = document.querySelectorAll('.home, .yt-logo, .g-back, .s-back, .p-logo');
    Array.prototype.forEach.call(logos, function (l) {
      l.classList.remove('egg-wink');
      void l.getBoundingClientRect();
      l.classList.add('egg-wink');
      later(600, function () { l.classList.remove('egg-wink'); });
    });
  }

  // The digest "cracks": hex churns, a log fills a bar, and the answer is
  // only ever "nice try." It never decodes to a word.
  var cracking = false;
  function crackDigest() {
    if (cracking) return;
    cracking = true;
    mark('digest');
    var h = document.querySelector('.digest [data-churn]');
    var host = h ? h.closest('.title') || h.parentNode.parentNode : null;
    var log = quiet(make('p', 'egg-crack' + (host ? '' : ' is-float'), host || document.body));
    var calm = reduced(), step = 0, steps = 16;
    var orig = h ? (h._final != null ? h._final : h.textContent) : '';
    var block = h ? h.closest('.digest') : null;
    function paint(pct, word) {
      var n = Math.round(pct / 100 * 20);
      log.textContent = '';
      var a = make('span', '', log);
      a.textContent = 'cracking sha256 ' + '[' + new Array(n + 1).join('#') + new Array(21 - n).join('.') + '] ' + ('  ' + pct).slice(-3) + '%\n';
      var b = make('b', '', log);
      b.textContent = word;
    }
    var id = setInterval(function () {
      step++;
      var pct = Math.min(100, Math.round(step / steps * 100));
      var guess = '';
      for (var i = 0; i < 8; i++) guess += pick(HEX);
      paint(pct, 'try ' + guess + ' ... no');
      if (h && !calm) {
        if (h._raf) { cancelAnimationFrame(h._raf); h._raf = 0; }
        var s = '';
        for (var j = 0; j < orig.length; j++) s += pick(HEX);
        h.textContent = s;
      }
      if (step % 5 === 0 && block) glitchEl(block);
      if (step < steps) return;
      clearInterval(id);
      paint(100, 'nice try.');
      if (h) {
        h.textContent = 'nice try.';
        if (block) { block.setAttribute('data-text', 'nice try.'); glitchEl(block); }
      }
      later(1900, function () {
        if (h) {
          h.textContent = orig;
          h._final = orig;
          h._shown = orig;
          if (block) block.setAttribute('data-text', orig);
          var f = fx();
          if (f && f.scramble && !calm) f.scramble(h, { duration: 500, pool: HEX });
        }
        log.remove();
        cracking = false;
      });
    }, calm ? 160 : 110);
  }

  function checkWords() {
    if (/matrix$/.test(typed)) { typed = ''; matrix(); }
    else if (/hello$/.test(typed)) { typed = ''; hello(); }
    // not on the proxy: its digits open quick links before the word is done
    else if (page !== 'proxy' && typed.slice(-DIGEST.length) === DIGEST) { typed = ''; crackDigest(); }
  }

  /* ---------- keyboard ---------- */

  // Runs first (window, capture): the console key, the snake, and keeping
  // menu.js from jumping to entry 3 or 1 while the digest is being typed.
  function onKeyCapture(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (con.open && con.el.contains(e.target)) return; // the console's own keys
    if (busy()) return;
    // the stats key field focuses itself and would swallow the console
    // key forever: let it through while that one field is still empty
    if ((e.key === '`' || e.key === '~') && keyField(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openConsole();
      return;
    }
    if (typing(e.target)) return;
    if (e.key === '`' || e.key === '~' || e.code === 'Backquote') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (con.open) closeConsole(); else openConsole();
      return;
    }
    if (snake.on) { snakeKey(e); return; }
    // left / right only: up and down stay menu.js's way to the link
    if (page === '404' && !e.repeat && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !(document.activeElement && document.activeElement.closest && document.activeElement.closest('.menu'))) {
      // the hunt's run (or its chooser) owns the keys while mounted: let
      // them through to it untouched
      if (startSnake(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (page !== 'proxy' && /^[1-9]$/.test(e.key) && now() - typedAt < 1500) {
      var tail = typed.slice(-7) + e.key;
      for (var i = 2; i <= Math.min(tail.length, DIGEST.length); i++) {
        if (DIGEST.indexOf(tail.slice(-i)) === 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // still record it: the bubble listener will not see this key
          onWordKey(e);
          return;
        }
      }
    }
  }

  function konamiFeed(k) {
    if (k === KONAMI[kPos]) {
      kPos++;
      if (kPos === KONAMI.length) { kPos = 0; overdrive(); }
    } else {
      kPos = k === KONAMI[0] ? 1 : 0;
    }
  }

  function keyField(t) {
    return !!(t && t.tagName === 'INPUT' && !t.value && t.id === 's-key-in');
  }

  function onWordKey(e) {
    var k = e.key.toLowerCase();
    konamiFeed(k);
    // words
    if (k.length === 1) {
      var t = now();
      if (t - typedAt > 2000) typed = '';
      typedAt = t;
      typed = (typed + k).slice(-16);
      checkWords();
    }
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
    if (con.open || typing(e.target) || busy() || snake.on) return;
    onWordKey(e);
  }

  /* ---------- youtube: barrel roll, askew, the long reel ---------- */

  function initTube() {
    var shorts = {}, count = 0;
    function query() {
      var m = /^#\/search\/(.*)$/.exec(location.hash);
      if (!m) return null;
      try { return decodeURIComponent(m[1]).replace(/\s+/g, ' ').trim().toLowerCase(); } catch (e) { return null; }
    }
    function origin() {
      root.style.transformOrigin = '50% ' + (window.scrollY + window.innerHeight / 2).toFixed(0) + 'px';
    }
    function onRoute(first) {
      var q = query();
      if (q !== 'askew' && root.classList.contains('egg-askew')) {
        root.classList.remove('egg-askew');
        later(520, function () { if (!root.classList.contains('egg-askew') && !root.classList.contains('egg-roll')) root.style.transformOrigin = ''; });
      }
      if (q === 'askew') {
        origin();
        root.classList.add('egg-askew');
        mark('askew');
      } else if (q === 'do a barrel roll' && !first) {
        mark('roll');
        if (reduced()) { toast('a barrel roll, sitting still.', 2600); return; }
        // spin the results, not the skeletons: wait (2.5 s at most) until
        // the search has rendered real cards
        // (the old view dims out first, so the first look is a bit later)
        var hash = location.hash, waited = 350;
        later(350, function ready() {
          if (location.hash !== hash) return;
          var real = document.querySelector('.card:not(.is-ghost), .short:not(.is-ghost)');
          if (waited < 2500 && (document.querySelector('.is-ghost') || !real)) {
            waited += 100;
            later(100, ready);
            return;
          }
          roll();
        });
      }
      var s = /^#\/shorts\/([\w-]{6,})/.exec(location.hash);
      if (s && !shorts[s[1]]) {
        shorts[s[1]] = 1;
        count++;
        if (count === 30) {
          toast('touch grass.', 3200);
          mark('reel');
        }
      }
    }
    function roll() {
      origin();
      root.classList.remove('egg-roll');
      void root.offsetWidth;
      root.classList.add('egg-roll');
      later(1150, function () { root.classList.remove('egg-roll'); if (!root.classList.contains('egg-askew')) root.style.transformOrigin = ''; });
    }
    window.addEventListener('hashchange', function () { onRoute(false); });
    onRoute(true);
  }

  /* ---------- 404 snake ---------- */

  var snake = { on: false, box: null, pre: null, top: null, foot: null, cv: null };
  var DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };

  function snakeBest() { return parseInt(lsGet('eggs.snake'), 10) || 0; }
  function hintSnake(over) {
    if (mqFine.matches) return over ? 'game over · arrow to retry · esc quits' : 'arrows steer · esc quits';
    return over ? 'over · swipe to retry' : 'swipe · tap 404 to quit';
  }
  // a swipe takes longer than a key press: a slower start on touch
  function snakeStep() {
    var base = mqFine.matches ? 125 : 170;
    return Math.max(Math.round(base * 0.52), base - snake.score * 3);
  }

  // true when the hunt took the stage instead of the plain snake
  function startSnake(key) {
    var cv = document.querySelector('canvas[data-obj]');
    var stage = cv ? cv.parentElement : document.querySelector('.stage');
    if (!stage) return false;
    if (huntDo('mount404', stage, key, function () { realStart(key); })) return true;
    realStart(key);
    return false;
  }

  function realStart(key) {
    var cv = document.querySelector('canvas[data-obj]');
    var stage = cv ? cv.parentElement : document.querySelector('.stage');
    if (!stage || snake.on) return;
    mark('snake');
    snake.on = true;
    snake.cv = cv;
    var box = snake.box = make('div', 'egg-snake', stage);
    box.setAttribute('role', 'img');
    var r = cv ? cv.getBoundingClientRect() : stage.getBoundingClientRect(), s = stage.getBoundingClientRect();
    var mob = window.innerWidth <= 720;
    var w = Math.max(r.width, mob ? Math.min(window.innerWidth - 32, 340) : 300), h = Math.max(r.height, 260);
    box.style.left = (r.left - s.left + (r.width - w) / 2).toFixed(0) + 'px';
    box.style.top = (r.top - s.top + (r.height - h) / 2).toFixed(0) + 'px';
    box.style.width = w.toFixed(0) + 'px';
    box.style.height = h.toFixed(0) + 'px';
    if (cv) cv.classList.add('egg-hide');
    snake.top = make('p', 'egg-snake-top', box);
    snake.pre = make('pre', '', box);
    snake.foot = make('p', 'egg-snake-foot', box);
    snake.foot.textContent = hintSnake(false);
    // grid size from the font: one cell per character
    var probe = make('span', '', snake.pre);
    probe.textContent = '0000000000';
    var cw = probe.getBoundingClientRect().width / 10 || 8, ch = probe.getBoundingClientRect().height || 16;
    probe.remove();
    snake.cols = clamp(Math.floor((w - 24) / cw) - 2, 12, 40);
    snake.rows = clamp(Math.floor((h - 90) / ch) - 2, 8, 22);
    resetSnake(DIRS[key] || [1, 0]);
  }

  function resetSnake(dir) {
    var cx = (snake.cols / 2) | 0, cy = (snake.rows / 2) | 0;
    snake.body = [[cx, cy], [cx - dir[0], cy - dir[1]], [cx - 2 * dir[0], cy - 2 * dir[1]]];
    snake.dir = dir;
    snake.next = dir;
    snake.score = 0;
    snake.over = false;
    snake.box.classList.remove('is-over');
    huntEv('snake:start');
    food();
    drawSnake();
    clearInterval(snake.timer);
    snake.timer = setInterval(tickSnake, snakeStep());
  }

  function food() {
    var free;
    do {
      free = [(Math.random() * snake.cols) | 0, (Math.random() * snake.rows) | 0];
    } while (snake.body.some(function (b) { return b[0] === free[0] && b[1] === free[1]; }));
    snake.food = free;
  }

  function tickSnake() {
    if (document.hidden) return;
    snake.dir = snake.next;
    var hd = snake.body[0], nx = hd[0] + snake.dir[0], ny = hd[1] + snake.dir[1];
    var hitSelf = snake.body.some(function (b, i) { return i < snake.body.length - 1 && b[0] === nx && b[1] === ny; });
    if (nx < 0 || ny < 0 || nx >= snake.cols || ny >= snake.rows || hitSelf) {
      snakeOver();
      return;
    }
    snake.body.unshift([nx, ny]);
    if (nx === snake.food[0] && ny === snake.food[1]) {
      snake.score++;
      if (snake.score % 5 === 0 && snake.score <= 95) huntEv('snake:' + snake.score);
      food();
      // a little faster every few bites
      if (snake.score % 4 === 0) {
        clearInterval(snake.timer);
        snake.timer = setInterval(tickSnake, snakeStep());
      }
    } else {
      snake.body.pop();
    }
    drawSnake();
  }

  function drawSnake() {
    var C = snake.cols, R = snake.rows, grid = [], i;
    for (i = 0; i < R; i++) grid.push(new Array(C + 1).join(' ').split(''));
    grid[snake.food[1]][snake.food[0]] = '\u0000'; // drawn below, brighter
    for (i = snake.body.length - 1; i >= 0; i--) {
      var b = snake.body[i];
      if (b[1] >= 0 && b[1] < R && b[0] >= 0 && b[0] < C) grid[b[1]][b[0]] = i ? 'o' : '@';
    }
    var edge = '+' + new Array(C + 1).join('-') + '+';
    var out = [edge];
    for (i = 0; i < R; i++) out.push('|' + grid[i].join('') + '|');
    out.push(edge);
    // text before the food, the food as a glowing <b>, text after it
    var all = out.join('\n').split('\u0000');
    snake.pre.textContent = all[0];
    if (all.length > 1) {
      make('b', '', snake.pre).textContent = '*';
      snake.pre.appendChild(document.createTextNode(all[1]));
    }
    var best = Math.max(snakeBest(), snake.score);
    snake.top.textContent = '';
    var a = make('span', '', snake.top);
    a.textContent = 'snake  score ';
    make('b', '', snake.top).textContent = ('0' + snake.score).slice(-2);
    var c = make('span', '', snake.top);
    c.textContent = '  hi ' + ('0' + best).slice(-2);
    snake.box.setAttribute('aria-label', 'snake, score ' + snake.score + ', best ' + best);
  }

  function snakeOver() {
    clearInterval(snake.timer);
    snake.over = true;
    huntEv('snake:over');
    if (snake.score > snakeBest()) lsSet('eggs.snake', String(snake.score));
    snake.box.classList.add('is-over');
    drawSnake();
    snake.foot.textContent = hintSnake(true);
  }

  function quitSnake() {
    clearInterval(snake.timer);
    if (snake.score > snakeBest()) lsSet('eggs.snake', String(snake.score));
    if (snake.box) snake.box.remove();
    if (snake.cv) snake.cv.classList.remove('egg-hide');
    snake.on = false;
    snake.box = null;
  }

  function steer(d) {
    if (!d) return;
    if (snake.over) {
      snake.foot.textContent = hintSnake(false);
      resetSnake(d);
      return;
    }
    // no turning straight back into yourself
    if (d[0] === -snake.dir[0] && d[1] === -snake.dir[1]) return;
    snake.next = d;
  }

  function snakeKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      quitSnake();
      return;
    }
    var d = DIRS[e.key] || DIRS[e.key.toLowerCase()];
    if (d) {
      e.preventDefault();
      e.stopImmediatePropagation();
      steer(d);
    }
  }

  // Swipes and taps on touch screens: on the 404 they start and steer
  // the snake; anywhere else they can spell the konami code (eight swipes,
  // then two taps for b and a).
  function initSwipe() {
    var sx = 0, sy = 0, st = 0, on = false, onLink = false;
    document.addEventListener('touchstart', function (e) {
      on = false;
      if (e.touches.length !== 1 || typing(e.target) || busy() || con.open) return;
      onLink = !!(e.target.closest && e.target.closest('a, button'));
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = now();
      on = true;
    }, { passive: true });
    // no page bounce while playing (a blocking listener, so 404 only:
    // anywhere else it would hold up scrolling)
    if (page === '404') {
      document.addEventListener('touchmove', function (e) {
        if (snake.on && e.cancelable) e.preventDefault();
      }, { passive: false });
    }
    document.addEventListener('touchend', function (e) {
      if (!on) return;
      on = false;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      var far = Math.max(Math.abs(dx), Math.abs(dy));
      if (far < 12 && now() - st < 350) {
        // a tap is b, then a, once the arrows are in
        if (!snake.on && kPos >= 8) konamiFeed(KONAMI[kPos]);
        return;
      }
      if (far < 34) return;
      var key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
      if (page === '404') {
        if (snake.on) steer(DIRS[key]);
        else if (!onLink) startSnake(key);
        return;
      }
      konamiFeed(key.toLowerCase());
    }, { passive: true });
    // on touch, a tap on the big 404 quits
    document.addEventListener('click', function (e) {
      if (snake.on && e.target.closest && e.target.closest('.digest')) quitSnake();
    });
  }

  function init404() {
    var sub = document.querySelector('.is-lost .sub');
    if (sub) {
      var p = quiet(make('p', 'egg-hint', null));
      p.textContent = 'the ghost moved it.';
      sub.parentNode.insertBefore(p, sub.nextSibling);
      later(2400, function () { decodeEl(p, { duration: 900 }); });
      // the hunt's lines (a tell, errata, hints for everyone), plain text
      // under that one; none at all when nothing is live
      var t0 = now();
      huntReady(function (h) {
        var add = [];
        try { add = (h && h.lines && h.lines('404')) || []; } catch (e) { add = []; }
        var after = p;
        for (var i = 0; i < add.length && i < 8; i++) {
          if (typeof add[i] !== 'string' || !add[i]) continue;
          var q = make('p', 'egg-hint', null);
          q.textContent = add[i];
          after.parentNode.insertBefore(q, after.nextSibling);
          after = q;
          if (!reduced()) later(Math.max(0, 2400 - (now() - t0)) + 140 * (i + 1), decodeEl.bind(null, q, { duration: 900 }));
        }
      });
    }
  }

  /* ---------- console on touch ---------- */

  // A phone has no backtick: hold a finger still on empty background for
  // a second, or tap the menu's small hex logo five times quickly.
  var ateClick = false;
  function initTouchConsole() {
    var t = 0, x = 0, y = 0;
    function cancel() { clearTimeout(t); t = 0; }
    document.addEventListener('pointerdown', function (e) {
      cancel();
      if (e.pointerType === 'mouse' || !e.isPrimary || con.open || busy() || snake.on) return;
      if (!isBackground(e.target) || (mask.hit && mask.hit.contains(e.target))) return;
      x = e.clientX;
      y = e.clientY;
      t = later(1000, function () {
        t = 0;
        if (sh.busy || con.open) return;
        ateClick = true; // the release must not crack the glass
        later(800, function () { ateClick = false; });
        openConsole();
      });
    }, true);
    document.addEventListener('pointermove', function (e) {
      if (t && Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 12) cancel();
    }, { passive: true, capture: true });
    document.addEventListener('pointerup', cancel, true);
    document.addEventListener('pointercancel', cancel, true);

    var logo = page === 'menu' ? document.querySelector('.top .home') : null;
    if (!logo) return;
    var n = 0, last = 0;
    logo.addEventListener('click', function () {
      var tt = now();
      n = tt - last < 600 ? n + 1 : 1;
      last = tt;
      if (n < 5) return;
      n = 0;
      openConsole();
    });
  }

  /* ---------- idle screensaver ---------- */

  var IDLE = 90000;
  var idle = { last: now(), on: false, el: null, stop: noop };
  function poke() {
    idle.last = now();
    if (idle.on) stopSaver();
  }
  function saverAllowed() {
    return !document.hidden && !absorbed() && !busy() && !con.open && !snake.on && !sh.busy && !rainOn &&
      !document.fullscreenElement;
  }
  function startSaver() {
    if (idle.on || !saverAllowed()) return;
    idle.on = true;
    huntEv('saver:on');
    mark('idle');
    holdPage(true);
    var box = idle.el = quiet(make('div', 'egg-layer egg-saver', document.body));
    var cv = make('canvas', '', box);
    var W = window.innerWidth, H = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, tier() === 'high' ? 1.5 : 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    void box.offsetWidth;
    box.classList.add('is-on');

    var S = W < 600 ? 1.6 : 2.2, MW = 32 * S, MH = 32 * S + 34; // mark plus the digest under it
    var x = rand(0, W - MW), y = rand(0, H - MH), vx = 1.6, vy = 1.2, trail = [], drop = 0;
    var hex = new Path2D('M16 3.5 27 9.75v12.5L16 28.5 5 22.25V9.75Z');
    var eyes = new Path2D('M10 14.5h4.5M17.5 14.5H22');
    var maxTrail = tier() === 'low' ? 10 : tier() === 'mid' ? 22 : 36;
    function paint(t) {
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '13px M, ui-monospace, Menlo, monospace';
      for (var i = 0; i < trail.length; i++) {
        var g = trail[i], age = (t - g.t) / 3200;
        if (age >= 1) continue;
        ctx.globalAlpha = (1 - age) * 0.5;
        ctx.fillStyle = '#fff';
        ctx.fillText(g.c, g.x, g.y);
      }
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(S, S);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(255,255,255,.8)';
      ctx.shadowBlur = 10;
      ctx.stroke(hex);
      ctx.lineWidth = 2.4;
      ctx.stroke(eyes);
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.font = '14px M, ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#fff';
      ctx.fillText(DIGEST, x + MW / 2, y + 32 * S + 18);
    }
    if (reduced()) {
      // still: a new resting place every few seconds, faded in
      paint(now());
      var iv = setInterval(function () {
        box.classList.remove('is-on');
        later(1400, function () {
          if (!idle.on) return;
          x = rand(0, W - MW);
          y = rand(0, H - MH);
          paint(now());
          box.classList.add('is-on');
        });
      }, 10000);
      idle.stop = function () { clearInterval(iv); };
      return;
    }
    idle.stop = loop(function (el, k) {
      var t = now();
      x += vx * k;
      y += vy * k;
      var hitX = false, hitY = false;
      if (x <= 0 || x >= W - MW) { vx = -vx; x = clamp(x, 0, W - MW); hitX = true; }
      if (y <= 0 || y >= H - MH) { vy = -vy; y = clamp(y, 0, H - MH); hitY = true; }
      if (hitX && hitY) toast('corner.', 2400); // the one everybody waits for
      if (t - drop > 110) {
        drop = t;
        trail.push({ x: x + MW / 2 + rand(-12, 12), y: y + MH / 2 + rand(-12, 12), c: pick(HEX), t: t });
        if (trail.length > maxTrail) trail.shift();
      }
      paint(t);
    });
  }
  function stopSaver() {
    idle.on = false;
    huntEv('saver:off');
    idle.stop();
    idle.stop = noop;
    holdPage(false);
    var el = idle.el;
    idle.el = null;
    if (!el) return;
    el.classList.add('is-out');
    later(220, function () { el.remove(); });
  }
  function initIdle() {
    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (ev) {
      window.addEventListener(ev, poke, { passive: true, capture: true });
    });
    var beat = 0;
    setInterval(function () {
      var still = now() - idle.last;
      if (idle.on) return;
      if (still > IDLE) startSaver();
      else if (page === 'menu' && still > 24000 && ++beat % 2 === 0 && saverAllowed()) snore();
    }, 3000);
    document.addEventListener('visibilitychange', function () { if (document.hidden) poke(); });
  }

  /* ---------- clock ---------- */

  // Five quick clicks on the menu clock: ten seconds counting backwards,
  // in hex.
  function initClock() {
    var el = document.querySelector('[data-clock]');
    if (!el) return;
    var n = 0, last = 0, on = false;
    el.addEventListener('click', function () {
      if (on) return;
      var t = now();
      n = t - last < 700 ? n + 1 : 1;
      last = t;
      if (n < 5) return;
      n = 0;
      on = true;
      mark('clock');
      var out = make('b', 'egg-clk', el);
      // From the time it shows (seconds since load), in hex bytes, down
      // to zero in about three seconds. Then the punchline: it underflows
      // to ff:ff:ff and keeps falling, fast.
      var v = Math.floor(now() / 1000), calm = reduced(), under = false;
      var tick = calm ? 250 : clamp(Math.round(3000 / Math.max(v, 1)), 60, 300);
      var step = Math.max(1, Math.round(v / (3000 / tick)));
      function h2(x) { return ('0' + (x & 255).toString(16)).slice(-2); }
      function show(x) {
        var hh = Math.floor(x / 3600), mm = Math.floor(x / 60) % 60, ss = x % 60;
        if (under) { hh = x >> 16; mm = x >> 8; ss = x; }
        out.textContent = 't-' + h2(hh) + ':' + h2(mm) + ':' + h2(ss);
      }
      var iv = 0;
      function paint() {
        show(v);
        if (under) { v = (v - (calm ? 1 : 7)) & 0xffffff; return; }
        if (v === 0) {
          under = true;
          v = 0xffffff;
          clearInterval(iv);
          glitchEl(el);
          iv = setInterval(paint, calm ? 250 : 40);
          return;
        }
        v = Math.max(0, v - step);
      }
      el.classList.add('egg-rev');
      paint();
      iv = setInterval(paint, tick);
      later(10000, function () {
        clearInterval(iv);
        out.remove();
        el.classList.remove('egg-rev');
        glitchEl(el);
        on = false;
      });
    });
  }

  /* ---------- jelly title ---------- */

  // Press on the big title and drag across it: it wobbles like jelly.
  function initJelly() {
    var d = document.querySelector('.digest');
    if (!d) return;
    var down = false, path = 0, px = 0, py = 0, t0 = 0, fired = false;
    // no text selection while dragging across it (the sr copy stays)
    d.addEventListener('mousedown', function (e) { if (e.button === 0) e.preventDefault(); });
    d.addEventListener('pointerdown', function (e) {
      down = true;
      fired = false;
      path = 0;
      px = e.clientX;
      py = e.clientY;
      t0 = now();
    });
    document.addEventListener('pointermove', function (e) {
      if (!down || fired) return;
      path += Math.abs(e.clientX - px) + Math.abs(e.clientY - py);
      px = e.clientX;
      py = e.clientY;
      if (path > 150 && now() - t0 < 1400) {
        fired = true;
        mark('jelly');
        if (reduced()) return;
        d.classList.remove('egg-jelly');
        void d.offsetWidth;
        d.classList.add('egg-jelly');
        later(1000, function () { d.classList.remove('egg-jelly'); });
      }
    }, { passive: true });
    document.addEventListener('pointerup', function () { down = false; });
    document.addEventListener('pointercancel', function () { down = false; });
  }

  /* ---------- start ---------- */

  // the tint first, so a tinted session never shows a mono frame
  if (tintNow() !== 'mono') setTint(tintNow(), true);
  huntReady(syncSolver);
  window.addEventListener('hunt:cert', syncSolver);

  window.addEventListener('keydown', onKeyCapture, true);
  window.addEventListener('keydown', onKey);
  document.addEventListener('click', onBackgroundClick);
  initHold();
  initIdle();
  initSwipe();
  initTouchConsole();
  if (page === 'menu') initMask();
  if (page === 'menu' || page === '404') { initClock(); initJelly(); }
  if (page === '404') init404();
  if (page === 'yt') initTube();

  // for the curious, from devtools: what has been found, and a way to
  // pretend nobody touched anything for a while
  window.eggs = {
    found: function () { return foundList().slice(); },
    idle: function (ms) { idle.last = now() - (ms || IDLE); }
  };
})();
