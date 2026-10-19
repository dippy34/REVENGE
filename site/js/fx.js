/* fx.js: shared visual effects, self-written, no dependencies.
   Everything here is decoration. Pages stay usable if it never runs.
   Exposes window.fx = { scramble, glitch, rain } for page scripts. */
(function () {
  'use strict';

  var root = document.documentElement;
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqFine = window.matchMedia('(hover: hover) and (pointer: fine)');
  function reduced() { return mqReduce.matches; }
  function onChange(mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); }
  function noop() {}

  // Glyph pools. SYM only uses characters the bundled font has, so text
  // keeps its width while scrambling. The canvas can use anything.
  var HEX = '0123456789abcdef';
  var SYM = HEX + '#%&*+=<>/\\|_-:;';
  var RAIN = HEX + HEX + '░▒▓▚▞╳┼│─·';
  var NOISE = HEX + '░▒▓';

  function pick(pool) { return pool.charAt((Math.random() * pool.length) | 0); }

  function make(tag, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  /* ---------- text scramble ---------- */

  // Churns the text of `el` through random glyphs, then resolves it left to
  // right back to the original. The original is cached on first use.
  function scramble(el, opts) {
    opts = opts || {};
    if (el._final == null) el._final = el.textContent;
    var final = el._final;
    if (el._raf) cancelAnimationFrame(el._raf);
    if (reduced()) { el.textContent = final; return; }

    var dur = opts.duration || 600;
    var pool = opts.pool || SYM;
    var n = final.length;
    var start = performance.now();
    var last = -Infinity;
    var at = [];
    for (var i = 0; i < n; i++) {
      at[i] = dur * (0.25 + 0.75 * (i / n)) * (0.7 + Math.random() * 0.3);
    }

    (function frame(now) {
      // ~22fps updates read as a terminal rather than a smooth tween
      if (now - last >= 45) {
        last = now;
        var t = now - start;
        var out = '';
        var done = true;
        for (var j = 0; j < n; j++) {
          var c = final.charAt(j);
          if (c === ' ' || t >= at[j]) out += c;
          else { out += pick(pool); done = false; }
        }
        el.textContent = out;
        if (done) { el._raf = 0; return; }
      }
      el._raf = requestAnimationFrame(frame);
    })(start);
  }

  /* ---------- glitch ---------- */

  function glitch(el) {
    if (reduced() || el.classList.contains('is-glitching')) return;
    el.classList.add('is-glitching');
    setTimeout(function () { el.classList.remove('is-glitching'); }, 520);
  }

  // [data-digest] blocks: hex churns and the block glitches on hover/focus,
  // then settles back to the same digest. Big headings also glitch on idle.
  function initDigests() {
    var blocks = document.querySelectorAll('[data-digest]');
    Array.prototype.forEach.call(blocks, function (block) {
      var hex = block.querySelector('[data-churn]');
      var g = block.classList.contains('glitch') ? block : block.querySelector('.glitch');
      function go() {
        if (g) glitch(g);
        if (hex) scramble(hex, { duration: 520, pool: NOISE });
      }
      block.addEventListener('pointerenter', go);
      block.addEventListener('focusin', go);
    });

    var idle = document.querySelector('.digest.glitch');
    if (!idle) return;
    (function later() {
      setTimeout(function () {
        if (!document.hidden) glitch(idle);
        later();
      }, 5000 + Math.random() * 5000);
    })();
  }

  function initScrambleOnHover() {
    var targets = document.querySelectorAll('[data-scramble]');
    Array.prototype.forEach.call(targets, function (el) {
      var host = el.closest('a, button, [tabindex]') || el;
      function go() { scramble(el, { duration: 380 }); }
      host.addEventListener('pointerenter', go);
      host.addEventListener('focus', go);
    });
  }

  // One "decrypt" pass over headings and labels when the page appears.
  function intro() {
    var els = document.querySelectorAll('[data-churn], [data-scramble]');
    Array.prototype.forEach.call(els, function (el, i) {
      setTimeout(function () {
        scramble(el, { duration: 700, pool: el.hasAttribute('data-churn') ? NOISE : SYM });
      }, i * 70);
    });
  }

  /* ---------- falling-glyph background ---------- */

  var rain = (function () {
    var cv = document.getElementById('rain');
    var ctx = cv && cv.getContext && cv.getContext('2d', { alpha: false });
    if (!ctx) return { pause: noop, resume: noop };

    var SIZE = 15;           // glyph cell in CSS px
    var STEP = 1000 / 24;    // frame budget: 24fps is plenty for this
    var cols = [];
    var w = 0, h = 0, raf = 0, last = 0, paused = false;

    function resize() {
      var nw = window.innerWidth, nh = window.innerHeight;
      // mobile URL bars resize the viewport constantly; ignore small jumps
      if (nw === w && Math.abs(nh - h) < 120) return;
      w = nw; h = nh;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.font = SIZE + 'px M, ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'top';
      cols = [];
      for (var i = 0, n = Math.ceil(w / SIZE); i < n; i++) cols.push(column(true));
      if (reduced()) still();
    }

    function column(fresh) {
      return {
        row: fresh ? -Math.floor(Math.random() * (h / SIZE)) : -Math.floor(2 + Math.random() * 24),
        speed: 0.25 + Math.random() * 0.75, // rows advanced per frame
        acc: 0,
        on: Math.random() < 0.6
      };
    }

    function draw() {
      // fade the previous frame; the leftovers become the trails
      ctx.fillStyle = 'rgba(0,0,0,0.085)';
      ctx.fillRect(0, 0, w, h);
      var rows = h / SIZE;
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (!c.on) {
          if (Math.random() < 0.004) c.on = true;
          continue;
        }
        c.acc += c.speed;
        if (c.acc < 1) continue;
        c.acc -= 1;
        c.row += 1;
        if (c.row >= 0) {
          ctx.fillStyle = Math.random() < 0.08 ? '#fff' : '#b8b8b8';
          ctx.fillText(pick(RAIN), i * SIZE, c.row * SIZE);
        }
        if (c.row > rows + 4) cols[i] = column(false);
      }
    }

    // reduced motion: a single sparse frame, no animation at all
    function still() {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#6a6a6a';
      for (var i = 0; i < cols.length; i++) {
        for (var r = 0, rows = Math.ceil(h / SIZE); r < rows; r++) {
          if (Math.random() < 0.05) ctx.fillText(pick(HEX), i * SIZE, r * SIZE);
        }
      }
    }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (now - last < STEP) return;
      last = now;
      draw();
    }
    function start() {
      if (raf || paused || document.hidden || reduced()) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    // never burn CPU in a background tab
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(resize, 150);
    });
    onChange(mqReduce, function () {
      if (reduced()) { stop(); still(); } else start();
    });

    resize();
    start();
    return {
      pause: function () { paused = true; stop(); },
      resume: function () { paused = false; start(); }
    };
  })();

  /* ---------- cursor ---------- */

  function initCursor() {
    if (!mqFine.matches || reduced()) return;
    var dot = make('div', 'cur cur-dot');
    var ring = make('div', 'cur cur-ring');
    document.body.appendChild(dot);
    document.body.appendChild(ring);
    root.classList.add('has-cursor');

    var x = 0, y = 0, rx = 0, ry = 0, raf = 0, shown = false;
    function show(on) {
      dot.classList.toggle('on', on);
      ring.classList.toggle('on', on);
    }
    function tick() {
      // the ring trails the dot
      rx += (x - rx) * 0.2;
      ry += (y - ry) * 0.2;
      ring.style.transform = 'translate3d(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px,0)';
      raf = Math.abs(x - rx) + Math.abs(y - ry) > 0.3 ? requestAnimationFrame(tick) : 0;
    }

    document.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
      if (!shown) {
        rx = x; ry = y; shown = true;
        show(true);
        root.classList.add('has-pointer');
      }
      dot.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: true });

    // relatedTarget is null when the pointer leaves the window (or enters
    // the video frame, which is another document)
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) { show(false); shown = false; }
    });

    // grow over anything clickable; step aside for text fields and the
    // video frame, which draw their own cursors
    var HOT = 'a[href], button, [role="link"], label';
    document.addEventListener('pointerover', function (e) {
      var tgt = e.target;
      if (!tgt.closest) return;
      var off = tgt.tagName === 'IFRAME' || !!tgt.closest('input, textarea');
      dot.classList.toggle('off', off);
      ring.classList.toggle('off', off);
      ring.classList.toggle('is-hot', !!tgt.closest(HOT));
    });
    document.addEventListener('pointerdown', function () { ring.classList.add('is-down'); });
    document.addEventListener('pointerup', function () { ring.classList.remove('is-down'); });
  }

  /* ---------- session clock ---------- */

  function initClock() {
    var el = document.querySelector('[data-clock]');
    if (!el) return;
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function paint() {
      var s = Math.floor(performance.now() / 1000);
      el.textContent = 't+' + pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
    }
    paint();
    setInterval(paint, 1000);
  }

  /* ---------- boot screen ---------- */

  // Runs only when early.js set html.boot (first visit, motion allowed).
  // Any key, click or tap skips it.
  function boot(done) {
    if (!root.classList.contains('boot')) { done(); return; }
    try { localStorage.setItem('boot', '1'); } catch (e) { /* blocked */ }

    var lines = [
      ['init shell', 'ok'],
      ['mount /fx', 'ok'],
      ['cookies', 'none'],
      ['routes', '1/3 open'],
      ['link', 'ready']
    ];
    var box = make('div', 'boot');
    var log = make('div', 'boot-log');
    var skip = make('div', 'boot-skip');
    box.setAttribute('aria-hidden', 'true');
    skip.textContent = 'any key to skip';
    box.appendChild(log);
    box.appendChild(skip);
    document.body.appendChild(box);

    var i = 0, timer = 0, finished = false, clock = 0;
    function row(key, val) {
      clock += 0.08 + Math.random() * 0.05;
      var stamp = ('     ' + clock.toFixed(3)).slice(-7);
      var dots = new Array(Math.max(3, 18 - key.length)).join('.');
      var line = make('div');
      var ok = make('span', 'ok');
      line.textContent = '[' + stamp + '] ' + key + ' ' + dots + ' ';
      ok.textContent = val;
      line.appendChild(ok);
      log.appendChild(line);
    }
    function next() {
      if (i < lines.length) {
        row(lines[i][0], lines[i][1]);
        i++;
        timer = setTimeout(next, 140 + Math.random() * 110);
      } else {
        var last = make('div');
        last.textContent = '> 631cb8a9';
        log.appendChild(last);
        timer = setTimeout(finish, 450);
      }
    }
    function skipNow(e) {
      // swallow the skipping keypress so it does not also drive the menu
      if (e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); }
      finish();
    }
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('keydown', skipNow, true);
      window.removeEventListener('pointerdown', skipNow, true);
      box.classList.add('is-done');
      root.classList.remove('boot');
      setTimeout(function () { box.remove(); }, 400);
      done();
    }
    window.addEventListener('keydown', skipNow, true);
    window.addEventListener('pointerdown', skipNow, true);
    timer = setTimeout(next, 220);
  }

  /* ---------- transitions between sections ---------- */

  function initNav() {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target || a.hasAttribute('download') || reduced()) return;
      var url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      e.preventDefault();
      root.classList.add('leaving');
      setTimeout(function () { location.href = url.href; }, 240);
    });
    // back/forward cache restores the page as it was left: undo the fade
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) root.classList.remove('leaving');
    });
  }

  /* ---------- start ---------- */

  initClock();
  initCursor();
  initNav();
  initDigests();
  initScrambleOnHover();
  boot(intro);

  window.fx = { scramble: scramble, glitch: glitch, rain: rain };
})();
