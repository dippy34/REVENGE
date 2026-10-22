/* yt-app.js: the YouTube section, a hash-routed single page.
     #/start            build (or rebuild) your feed
     #/home             the feed, with a Shorts shelf
     #/shorts[/id]      the Shorts reel
     #/watch/id[/t]     a video
     #/search/query     search results
     #/channel/UCid     a channel
     #/subs             latest from your subscriptions
     #/library          interests, likes, history, subscriptions
   Data comes from yt-api.js, taste from yt-profile.js. Anything that came
   from the network is rendered with textContent only, never as HTML.
   The look is drawn here too: identicon avatars and channel banners are
   generated (SVG, canvas), cards reveal as they scroll in, routes cross
   over with a short sweep. fx.js effects are used when they are there,
   and reduced motion switches the movement off. */
(function () {
  'use strict';

  var rawApi = window.ytApi;
  var me = window.ytProfile;
  var root = document.documentElement;
  var view = document.getElementById('view');
  var topBar = document.querySelector('.yt-top');
  var toastEl = document.getElementById('yt-toast');
  var toastText = document.getElementById('yt-toast-t');
  var toastBar = document.getElementById('yt-toast-bar');
  var searchForm = document.getElementById('yt-search');
  var searchInput = document.getElementById('yt-q');
  var navLinks = document.querySelectorAll('[data-nav]');
  var navBar = document.getElementById('yt-nav-bar');
  var pathEl = document.getElementById('yt-path');
  var loadBar = document.getElementById('yt-load');
  var sweepEl = document.getElementById('yt-sweep');
  var flashEl = document.getElementById('yt-flash');
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ID = /^[A-Za-z0-9_-]{11}$/;
  var CH = /^UC[A-Za-z0-9_-]{22}$/;
  var EMBED = 'https://www.youtube-nocookie.com/embed/';
  var EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  var PER_TOPIC = 12;   // videos taken from each topic per feed batch
  var TOPICS = 4;       // topics per feed batch
  var SUGGEST = [
    'minecraft', 'fortnite', 'gaming', 'music', 'hip hop', 'football', 'basketball', 'f1',
    'cars', 'cooking', 'science', 'space', 'tech', 'coding', 'anime', 'movies',
    'comedy', 'skateboarding', 'fitness', 'art', 'history', 'nature', 'chess', 'speedruns'
  ];
  var ROUTES = { start: 1, home: 1, shorts: 1, watch: 1, search: 1, channel: 1, subs: 1, library: 1 };

  var known = {};     // id -> the richest record seen this session
  var cleanup = [];   // teardown for the current view: players, observers, listeners
  var feed, reel, shelf;
  resetFeed();

  function resetFeed() {
    feed = { items: [], buffer: {}, cursor: {}, busy: false, dry: 0, scroll: 0 };
    reel = { items: [], buffer: {}, cursor: {}, i: 0, busy: false };
    shelf = null;
  }

  /* ---------- tiny DOM helper ---------- */

  // h('a', { class, text, href, onclick, ... }, ...children)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) put(el, arguments[i]);
    return el;
  }

  // add(el, ...children): nodes, strings, arrays of them; null is skipped
  function add(el) {
    for (var i = 1; i < arguments.length; i++) put(el, arguments[i]);
  }

  function put(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(function (k) { put(el, k); });
    else el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }

  function mount() {
    view.textContent = '';
    put(view, Array.prototype.slice.call(arguments));
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    return el;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // 75 -> "01:15", 3725 -> "1:02:05"
  function clock(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor(t / 60) % 60;
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(t % 60);
  }

  // Playback readout for the HUD, fed by the embed's own progress messages.
  // Not every message carries both numbers, so the last known ones are kept.
  function playHud(timeEl, barEl, s) {
    if (s.duration) timeEl._dur = s.duration;
    if (s.time > 0) timeEl._t = s.time;
    var d = timeEl._dur;
    var t = Math.min(timeEl._t || 0, d || 0);
    if (!d) return;
    // a day-long "duration" is a live stream's rewind window, not a length
    if (d >= 86400) { timeEl.textContent = 'live'; d = t = 1; }
    else timeEl.textContent = clock(t) + ' / ' + clock(d);
    barEl.style.width = (t / d * 100).toFixed(2) + '%';
    barEl.parentNode.classList.add('on');
  }
  function rep(c, n) { return n > 0 ? new Array(n + 1).join(c) : ''; }
  function hex(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '0123456789abcdef'.charAt((Math.random() * 16) | 0);
    return s;
  }

  /* ---------- effects ---------- */

  function reduced() {
    var fx = window.fx;
    return fx && typeof fx.reduced === 'function' ? !!fx.reduced() : mqReduce.matches;
  }

  // Set an element's text and decode it in from noise, left to right:
  // fx.decode when the shell has it, a small local version otherwise.
  var NOISE = '0123456789abcdef#%&*+=<>/\\|_-:;';
  function decodeIn(el, text) {
    el.textContent = text;
    if (!text || reduced()) return;
    var dur = Math.min(900, 320 + text.length * 12);
    var fx = window.fx;
    if (fx && typeof fx.decode === 'function') {
      // fx.decode stops on an element that is not in the page yet, and
      // most of ours are built before they are mounted: start it once the
      // current task has put them in (a microtask, so before any paint)
      var go = function () {
        if (!el.isConnected || el.textContent !== text) return;
        el._final = null; // the text is new; let fx read it again
        fx.decode(el, { duration: dur });
      };
      if (el.isConnected) go(); else Promise.resolve().then(go);
      return;
    }
    var n = text.length;
    var t0 = performance.now();
    var last = -Infinity;
    if (el._ytDec) cancelAnimationFrame(el._ytDec);
    (function frame(now) {
      if (now - last >= 45) {
        last = now;
        var k = Math.floor((now - t0) / dur * n);
        if (k >= n) { el.textContent = text; el._ytDec = 0; return; }
        var out = text.slice(0, k);
        for (var i = k; i < n; i++) {
          out += text.charAt(i) === ' ' ? ' ' : NOISE.charAt((Math.random() * NOISE.length) | 0);
        }
        el.textContent = out;
      }
      el._ytDec = requestAnimationFrame(frame);
    })(t0);
  }

  // restart a CSS animation that hangs off a class
  function restart(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // a quick pulse on a button that just changed state
  function pop(b) {
    if (!reduced()) restart(b, 'is-pop');
  }

  // count up to n (two digits at least), starting on the next frame so
  // the element is in the page by then
  function tickUp(el, n) {
    el.textContent = pad(reduced() ? n : 0);
    if (reduced() || !n) return;
    var dur = 650 + Math.min(n, 60) * 8;
    var t0 = 0;
    requestAnimationFrame(function frame(now) {
      if (!t0) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = pad(Math.round(n * (1 - Math.pow(1 - p, 3))));
      if (p < 1 && el.isConnected) requestAnimationFrame(frame);
    });
  }

  // Cards and Shorts fade up as they scroll in, a few at a time.
  var revealIO = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    var k = 0;
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      var d = Math.min(k++, 9);
      revealIO.unobserve(el);
      el.style.setProperty('--d', String(d));
      el.classList.add('is-in');
      setTimeout(function () {
        el.classList.remove('rv', 'is-in');
        el.style.removeProperty('--d');
      }, 800 + d * 50);
    });
  }, { rootMargin: '0px 0px -24px 0px' }) : null;

  // the low effects tier (html[data-fx], set by the shell) skips it
  function reveal(el) {
    if (revealIO && !reduced() && document.documentElement.getAttribute('data-fx') !== 'low') {
      el.classList.add('rv');
      revealIO.observe(el);
    }
    return el;
  }

  /* ---------- network activity line ---------- */

  // The thin line under the top bar runs while any request is open.
  var pending = 0;
  function netBusy(d) {
    pending = Math.max(0, pending + d);
    if (loadBar) loadBar.classList.toggle('on', pending > 0);
  }
  function tracked(fn) {
    return function () {
      netBusy(1);
      return fn.apply(rawApi, arguments).finally(function () { netBusy(-1); });
    };
  }
  var api = {
    search: tracked(rawApi.search),
    channel: tracked(rawApi.channel),
    details: tracked(rawApi.details),
    thumb: rawApi.thumb,
    thumbSet: rawApi.thumbSet || function () { return ''; }
  };

  /* ---------- toast ---------- */

  var toastTimer = 0;
  function toast(text) {
    toastText.textContent = text;
    toastEl.classList.add('on');
    restart(toastBar, 'run');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }

  /* ---------- icons ---------- */

  // 24px line icons, drawn with createElementNS (no markup strings).
  var ICONS = {
    like: 'M7.5 10.5V20H4v-9.5h3.5Zm0 0L11 3.5c1.4 0 2.5 1.1 2.5 2.5v3h4.7a2 2 0 0 1 2 2.3l-1.2 6.9a2.2 2.2 0 0 1-2.2 1.8H7.5',
    plus: 'M12 5v14M5 12h14',
    check: 'm5 12.5 4.5 4.5L19 7',
    hide: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM6 6l12 12',
    up: 'M12 19V5m-6 6 6-6 6 6',
    down: 'M12 5v14m-6-6 6 6 6-6',
    left: 'm14.5 5.5-6.5 6.5 6.5 6.5',
    right: 'm9.5 5.5 6.5 6.5-6.5 6.5',
    retry: 'M19 12a7 7 0 1 1-2.05-4.95M19 4.5v4h-4',
    clear: 'M5 7h14M10 7V4.5h4V7m-7 0 .8 12.5h8.4L17 7',
    edit: 'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4'
  };
  var FILLED = { liked: 'like' };

  function icon(name) {
    var filled = FILLED[name];
    var s = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6',
      'stroke-linejoin': 'round', class: 'ico', 'aria-hidden': 'true', focusable: 'false'
    });
    s.appendChild(svgEl('path', { d: ICONS[filled || name], fill: filled ? 'currentColor' : null }));
    return s;
  }

  // pill button with an icon and a label that can change later
  function pillBtn(ico, label, cls) {
    var b = h('button', { class: 'pill has-ico' + (cls ? ' ' + cls : ''), type: 'button' },
      icon(ico), h('span', { class: 'lbl', text: label }));
    b._ico = ico;
    return b;
  }

  // reel button: square icon over a small label
  function reelBtn(ico, label, aria) {
    var b = h('button', { class: 'rbtn', type: 'button', 'aria-label': aria || null },
      h('span', { class: 'rbtn-ico' }, icon(ico)), h('span', { class: 'rbtn-lbl lbl', text: label }));
    b._ico = ico;
    return b;
  }

  function setBtn(b, ico, label) {
    var old = b.querySelector('.ico');
    if (old && b._ico !== ico) old.parentNode.replaceChild(icon(ico), old);
    b._ico = ico;
    b.querySelector('.lbl').textContent = label;
  }

  /* ---------- identicons ---------- */

  // Every channel gets a small symmetric 5x5 glyph in two grays inside
  // the hex frame, derived from its name. Deterministic, no images.
  function hash(s) {
    var x = 2166136261;
    for (var i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 16777619);
    }
    return x >>> 0;
  }

  function prng(seed) {
    var x = seed || 0x9e3779b9;
    return function () {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  var HEX_PTS = '14,1.6 24.74,7.8 24.74,20.2 14,26.4 3.26,20.2 3.26,7.8';
  var avaCache = {};

  function cell(x, y) { return 'M' + (7 + x * 2.8).toFixed(1) + ' ' + (7 + y * 2.8).toFixed(1) + 'h2.8v2.8h-2.8z'; }

  function drawAvatar(key) {
    var s = svgEl('svg', { viewBox: '0 0 28 28', class: 'ava' + (key ? '' : ' is-blank'), 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svgEl('polygon', { class: 'ava-hex', points: HEX_PTS, 'vector-effect': 'non-scaling-stroke' }));
    if (!key) return s;
    var rnd = prng(hash(key));
    var a = '';
    var b = '';
    var on = 0;
    for (var y = 0; y < 5; y++) {
      for (var x = 0; x < 3; x++) {
        if (rnd() < 0.5) continue;
        var d = cell(x, y) + (x < 2 ? cell(4 - x, y) : '');
        if (rnd() < 0.3) b += d; else a += d;
        on++;
      }
    }
    if (on < 4) a += cell(2, 1) + cell(2, 2) + cell(2, 3) + cell(1, 2) + cell(3, 2);
    if (a) s.appendChild(svgEl('path', { class: 'ava-a', d: a }));
    if (b) s.appendChild(svgEl('path', { class: 'ava-b', d: b }));
    return s;
  }

  // avatar(name, 'xs' | 'md' | 'xl'); an empty name gives a blank frame
  function avatar(name, size) {
    var key = String(name || '').replace(/^@/, '').trim().toLowerCase();
    var tpl = avaCache[key] || (avaCache[key] = drawAvatar(key));
    var el = tpl.cloneNode(true);
    if (size) el.classList.add('is-' + size);
    return el;
  }

  /* ---------- channel banner ---------- */

  // An ASCII-shaded field seeded by the channel id, so every channel gets
  // its own banner without loading an image. It decodes in from noise
  // once (30fps, under a second) and is redrawn still on resize.
  var RAMP = ' .,:-=+*#%@';
  var HEXC = '0123456789abcdef';

  function banner(id) {
    var box = h('div', { class: 'ch-banner', 'aria-hidden': 'true' });
    var cv = document.createElement('canvas');
    box.appendChild(cv);
    box.appendChild(h('span', { class: 'ch-banner-id', text: id }));
    var ctx = cv.getContext && cv.getContext('2d');
    var rnd = prng(hash(id));
    var waves = [];
    for (var i = 0; i < 4; i++) waves.push([0.04 + rnd() * 0.2, (rnd() - 0.5) * 1.2, rnd() * 6.283]);
    var cx = 0.25 + rnd() * 0.6;
    var cy = 0.2 + rnd() * 0.5;
    var jit = [];
    for (var j = 0; j < 64; j++) jit.push(rnd() * 0.14);
    var CW = 10;
    var CHT = 15;
    var w = 0;
    var ht = 0;
    var raf = 0;
    var t0 = 0;
    var last = 0;
    var onResize = null;

    // A phone banner is only ~37 columns wide: sample the waves as if it
    // were 72 wide and pull the bright spot toward the middle, so the
    // field still fills the strip behind the avatar instead of reading empty.
    function level(x, y, cols, rows) {
      var narrow = cols < 72;
      var sx = narrow ? 72 / cols : 1;
      var v = 0;
      for (var k = 0; k < 4; k++) v += Math.sin(x * sx * waves[k][0] + y * waves[k][1] + waves[k][2]);
      v = v / 8 + 0.5;
      var dx = x / cols - (narrow ? 0.5 + (cx - 0.5) * 0.4 : cx);
      var dy = (y / rows - cy) * 0.5;
      var spot = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * (narrow ? 1.7 : 2.3));
      return Math.max(0, Math.min(0.999, v * 0.72 + spot * spot * 0.62 - 0.08));
    }

    function size() {
      w = box.clientWidth;
      ht = box.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(ht * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // p: how far the decode front has travelled, 0..1
    function draw(p) {
      ctx.fillStyle = '#040404';
      ctx.fillRect(0, 0, w, ht);
      ctx.font = '12px M, ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'top';
      var cols = Math.ceil(w / CW);
      var rows = Math.ceil(ht / CHT);
      for (var y = 0; y < rows; y++) {
        var edge = p * 1.16 - jit[y % 64];
        for (var x = 0; x < cols; x++) {
          var fx = x / cols;
          if (fx > edge) {
            if (fx < edge + 0.035) {
              ctx.fillStyle = '#cfcfcf';
              ctx.fillText(HEXC.charAt((Math.random() * 16) | 0), x * CW, y * CHT);
            }
            continue;
          }
          var l = level(x, y, cols, rows);
          var c = RAMP.charAt((l * RAMP.length) | 0);
          if (c === ' ') continue;
          var g = (30 + l * l * 196) | 0;
          ctx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
          ctx.fillText(c, x * CW, y * CHT);
        }
      }
    }

    function frame(now) {
      if (!box.isConnected) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return;
      last = now;
      var p = Math.min(1, (now - t0) / 900);
      draw(p);
      if (p >= 1) { cancelAnimationFrame(raf); raf = 0; }
    }

    return {
      el: box,
      start: function () {
        if (!ctx) return;
        size();
        if (!w || !ht) return;
        if (reduced()) draw(1);
        else { t0 = performance.now(); raf = requestAnimationFrame(frame); }
        var timer = 0;
        onResize = function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            if (raf || !box.isConnected) return;
            size();
            draw(1);
          }, 200);
        };
        window.addEventListener('resize', onResize);
      },
      stop: function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (onResize) window.removeEventListener('resize', onResize);
      }
    };
  }

  /* ---------- records ---------- */

  var FIELDS = ['title', 'channel', 'channelId', 'duration', 'views', 'published', 'thumb', 'likes', 'subscribers', 'handle'];

  // One canonical object per video id, filled in as better data arrives.
  // `src` is the topic that brought the video in, for the profile.
  function remember(v, src) {
    var r = known[v.id] || (known[v.id] = { id: v.id, short: false, src: '' });
    FIELDS.forEach(function (f) { if (v[f]) r[f] = v[f]; });
    if (v.short) r.short = true;
    if (src && !r.src) r.src = src;
    return r;
  }

  function line() {
    return Array.prototype.filter.call(arguments, Boolean).join(' · ');
  }

  // rough age in seconds from "3 days ago", for sorting subscriptions
  function age(text) {
    var m = /(\d+)\s*(second|minute|hour|day|week|month|year)/.exec(text || '');
    if (!m) return Infinity;
    return +m[1] * { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2]];
  }

  /* ---------- pasted links ---------- */

  var HOSTS = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'
  ];
  var NOT_IDS = ['videoseries', 'live_stream'];

  // A watch, youtu.be, shorts, embed or live link -> { id, start }, else null.
  function parseLink(s) {
    var u;
    try { u = new URL(s.indexOf('://') > 0 ? s : 'https://' + s); } catch (e) { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
    if (HOSTS.indexOf(u.hostname) < 0) return null;
    var parts = u.pathname.split('/').filter(Boolean);
    var id = null;
    if (u.hostname === 'youtu.be') {
      if (parts.length === 1) id = parts[0];
    } else if (parts.length === 1 && parts[0] === 'watch') {
      id = u.searchParams.get('v');
    } else if (parts.length === 2 && /^(shorts|embed|live)$/.test(parts[0])) {
      id = parts[1];
    }
    if (!id || !ID.test(id) || NOT_IDS.indexOf(id) >= 0) return null;
    return { id: id, start: parseStart(u.searchParams.get('t') || u.searchParams.get('start')), short: parts[0] === 'shorts' };
  }

  // "90", "90s", "1m30s", "1h2m3s" -> seconds
  function parseStart(t) {
    var m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(t || '');
    if (!m) return 0;
    var n = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return n > 0 && n < 360000 ? n : 0;
  }

  // Search box input that is really a video: a link, or a bare id that
  // has a digit, - or _ in it (so an 11-letter word still searches).
  function asVideo(s) {
    if (/\s/.test(s)) return null;
    if (ID.test(s)) return /[0-9_-]/.test(s) ? { id: s, start: 0 } : null;
    return /[./]/.test(s) ? parseLink(s) : null;
  }

  /* ---------- the player ---------- */

  function frame(id, opts) {
    var q = new URLSearchParams({
      autoplay: '1', rel: '0', playsinline: '1', iv_load_policy: '3',
      enablejsapi: '1', origin: location.origin
    });
    if (opts.start) q.set('start', String(opts.start));
    if (opts.loop) { q.set('loop', '1'); q.set('playlist', id); }
    var f = document.createElement('iframe');
    f.title = 'video player';
    // Restrictive: no popups, forms, top navigation, downloads or sensors.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    // YouTube refuses embeds that send no Referer at all (error 153), so
    // this frame alone sends the bare origin: no path, no query.
    f.setAttribute('referrerpolicy', 'strict-origin');
    f.src = EMBED + id + '?' + q.toString(); // last, so every restriction applies
    return f;
  }

  // Listen to the embed's own progress messages (enablejsapi=1) without
  // loading YouTube's iframe API script: say "listening", then read the
  // infoDelivery messages it posts back. Returns a stop function.
  function track(f, onState) {
    var heard = false;
    var ping = setInterval(function () {
      if (heard) { clearInterval(ping); return; }
      if (f.contentWindow) {
        f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), EMBED_ORIGIN);
      }
    }, 750);
    function onMessage(e) {
      if (e.origin !== EMBED_ORIGIN || e.source !== f.contentWindow) return;
      var d;
      try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return; }
      if (!d || typeof d !== 'object') return;
      heard = true;
      var info = d.info && typeof d.info === 'object' ? d.info : {};
      onState({ time: num(info.currentTime), duration: num(info.duration) });
    }
    window.addEventListener('message', onMessage);
    return function () {
      clearInterval(ping);
      window.removeEventListener('message', onMessage);
    };
  }

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  /* ---------- building blocks ---------- */

  // section heading: "// title  [n]  ------  extra"
  function secHead(title, count, extra) {
    // aria-label: the hover scramble rewrites the text, never the name
    var t = h('h2', { class: 'yt-h', 'aria-label': title, 'data-scramble': true });
    decodeIn(t, title);
    return h('div', { class: 'sec-head' },
      t,
      count || null,
      h('span', { class: 'sec-rule', 'aria-hidden': 'true' }),
      extra || null);
  }

  function tags(list) {
    var box = h('div', { class: 'tags' });
    list.forEach(function (t) { if (t) box.appendChild(h('span', { class: 'tag', text: t })); });
    return box;
  }

  function noise() {
    return h('span', { class: 'ghost-noise', text: '> fetch 0x' + hex(6) });
  }

  // Loading placeholders, laid out like the real thing.
  // kind: 'card' (grid), 'row' (up next) or 'short' (shelf)
  function ghosts(n, kind) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var g;
      if (kind === 'short') {
        g = h('div', { class: 'short is-ghost', 'aria-hidden': 'true' },
          h('div', { class: 'short-thumb' }, noise()),
          h('div', { class: 'ghost-line' }), h('div', { class: 'ghost-line is-short' }));
      } else {
        var row = kind === 'row';
        g = h('div', { class: 'card is-ghost' + (row ? ' is-row' : ''), 'aria-hidden': 'true' },
          h('div', { class: 'card-link' },
            row ? h('span', { class: 'card-n', text: pad(i + 1) }) : null,
            h('div', { class: 'thumb' }, noise()),
            h('div', { class: 'card-meta' },
              row ? null : h('span', { class: 'ghost-ava' }),
              h('div', { class: 'card-text' },
                h('div', { class: 'ghost-line' }), h('div', { class: 'ghost-line is-short' })))));
      }
      g.style.setProperty('--i', String(i));
      out.push(g);
    }
    return out;
  }

  function ghostShelf() {
    return h('section', { class: 'shelf is-ghost-shelf', 'aria-hidden': 'true' },
      secHead('shorts'),
      h('div', { class: 'shelf-wrap at-start' }, h('div', { class: 'shelf-row' }, ghosts(10, 'short'))));
  }

  // A hex mask in ASCII: flat eyes when there is simply nothing,
  // crossed eyes when something went wrong.
  var ART = {
    empty: ['   ________', '  /        \\', ' /  ==  ==  \\', ' \\          /', '  \\________/'].join('\n'),
    error: ['   ________', '  /        \\', ' /  ><  ><  \\', ' \\   ____   /', '  \\________/'].join('\n')
  };

  function problem(text, retry) {
    return h('div', { class: 'yt-empty' + (retry ? ' is-bad' : '') },
      h('pre', { class: 'ascii', 'aria-hidden': 'true', text: retry ? ART.error : ART.empty }),
      h('p', { text: text }),
      retry ? h('button', { class: 'pill has-ico', type: 'button', onclick: retry }, icon('retry'), h('span', { class: 'lbl', text: 'try again' })) : null);
  }

  function hideCard(v, box) {
    me.hide(v);
    box.classList.add('is-gone');
    setTimeout(function () { box.remove(); }, 260);
    toast('removed. you will see less like this.');
  }

  function imgOk(e) { e.target.classList.add('is-ok'); }
  function imgBad(e) {
    e.target.classList.add('is-broken');
    if (e.target.parentNode) e.target.parentNode.classList.add('is-broken');
  }

  // how wide a thumbnail is drawn, so srcset picks the right size
  var SIZES = {
    card: '(max-width: 600px) calc(100vw - 32px), (max-width: 1100px) 45vw, 340px',
    small: '(max-width: 720px) 45vw, 240px',
    row: '(max-width: 720px) 132px, 168px'
  };

  function img(v, kind) {
    var set = api.thumbSet(v);
    return h('img', {
      src: api.thumb(v), srcset: set || null, sizes: set ? SIZES[kind] || SIZES.card : null,
      alt: '', loading: 'lazy', decoding: 'async', onload: imgOk, onerror: imgBad
    });
  }

  // seen: watched-id set from the profile, computed once per render
  // opts: { row: compact "up next" row, n: its number, small: library grid }
  function videoCard(v, seen, opts) {
    v = remember(v);
    opts = opts || {};
    var watched = seen && seen[v.id];
    var stats = line(v.views, v.published);
    var box = h('div', { class: 'card' + (opts.row ? ' is-row' : '') + (watched ? ' is-seen' : '') },
      h('a', { class: 'card-link', href: (v.short ? '#/shorts/' : '#/watch/') + v.id },
        opts.row ? h('span', { class: 'card-n', 'aria-hidden': 'true', text: pad(opts.n || 0) }) : null,
        h('div', { class: 'thumb' },
          img(v, opts.row ? 'row' : opts.small ? 'small' : 'card'),
          h('span', { class: 'thumb-tag', 'aria-hidden': 'true', text: v.short ? '> short' : '> play' }),
          v.duration ? h('span', { class: 'dur', text: v.duration }) : null,
          watched ? h('span', { class: 'seen' }, h('span', { class: 'sr', text: 'watched' })) : null),
        h('div', { class: 'card-meta' },
          opts.row ? null : avatar(v.channel),
          h('div', { class: 'card-text' },
            h('h3', { class: 'card-title', text: v.title || 'untitled' }),
            v.channel ? h('p', { class: 'card-sub', text: v.channel }) : null,
            stats ? h('p', { class: 'card-sub is-stats', text: stats }) : null))));
    box.appendChild(h('button', {
      class: 'card-x', type: 'button', title: 'not interested', 'data-cursor': 'hide',
      'aria-label': 'not interested: ' + (v.title || v.id),
      onclick: function () { hideCard(v, box); }
    }, '×'));
    return reveal(box);
  }

  // Shorts open in the reel, which continues with the rest of `list`.
  function shortCard(v, list, i) {
    v = remember(v);
    return reveal(h('a', {
      class: 'short', href: '#/shorts/' + v.id,
      onclick: function () { seedReel(list, v.id); }
    },
      h('div', { class: 'short-thumb' },
        img(v, 'short'),
        h('span', { class: 'short-n', 'aria-hidden': 'true', text: pad(i + 1) }),
        // bottom strip: a dark first frame still reads as a designed tile
        h('span', { class: 'short-foot', 'aria-hidden': 'true' },
          h('span', { class: 'short-kind', text: '9:16' }),
          v.duration ? h('span', { class: 'short-dur', text: v.duration }) : null),
        h('span', { class: 'thumb-tag', 'aria-hidden': 'true', text: '> play' })),
      h('p', { class: 'short-title', text: v.title || 'untitled' }),
      v.views ? h('p', { class: 'short-sub', text: v.views }) : null));
  }

  // A row of Shorts with edge fades and, on desktop, scroll buttons.
  function shortsShelf(items, title) {
    if (!items.length) return null;
    var row = h('div', { class: 'shelf-row' }, items.map(function (v, i) { return shortCard(v, items, i); }));
    var wrap = h('div', { class: 'shelf-wrap at-start' }, row);
    var prev = h('button', { class: 'shelf-btn', type: 'button', 'aria-label': 'scroll shorts left', disabled: true, onclick: function () { nudge(-1); } }, icon('left'));
    var next = h('button', { class: 'shelf-btn', type: 'button', 'aria-label': 'scroll shorts right', onclick: function () { nudge(1); } }, icon('right'));
    function nudge(d) {
      row.scrollBy({ left: d * row.clientWidth * 0.8, behavior: reduced() ? 'auto' : 'smooth' });
    }
    function edges() {
      var x = row.scrollLeft;
      var max = row.scrollWidth - row.clientWidth;
      wrap.classList.toggle('at-start', x <= 2);
      wrap.classList.toggle('at-end', x >= max - 2);
      prev.disabled = x <= 2;
      next.disabled = x >= max - 2;
    }
    row.addEventListener('scroll', edges, { passive: true });
    requestAnimationFrame(edges);
    return h('section', { class: 'shelf', 'aria-label': title },
      secHead(title, h('span', { class: 'sec-n', text: pad(items.length) }), h('div', { class: 'shelf-nav' }, prev, next)),
      wrap);
  }

  // Infinite scroll: call load() whenever `tail` nears the viewport.
  // load resolves false when there is nothing more. eager: load the first
  // page right away (the grid only holds placeholders, which on a phone
  // can push the tail far below the screen).
  function infinite(tail, load, eager) {
    var busy = false;
    var done = false;
    // Geometry decides, not the observer's first report, which some
    // browsers get wrong for elements already on screen at load.
    function near() {
      return tail.isConnected && tail.getBoundingClientRect().top < window.innerHeight + 700;
    }
    var io = new IntersectionObserver(function () { if (near()) go(); }, { rootMargin: '700px 0px' });
    function go() {
      if (busy || done) return;
      busy = true;
      tail.textContent = '';
      tail.appendChild(h('span', { class: 'spin', text: 'loading' }));
      load().then(function (more) {
        busy = false;
        tail.textContent = '';
        if (more === false) {
          done = true;
          io.disconnect();
          tail.appendChild(h('p', { class: 'tail-end', text: 'end' }));
          return;
        }
        // page still short of the bottom? keep filling
        if (!done && near()) go();
      }, function (err) {
        busy = false;
        tail.textContent = '';
        tail.appendChild(problem((err && err.message) || 'something went wrong', go));
      });
    }
    io.observe(tail);
    requestAnimationFrame(function () { if (eager || near()) go(); });
    cleanup.push(function () { done = true; io.disconnect(); });
  }

  /* ---------- feed batches ---------- */

  // Take `count` videos for a topic, from leftovers first, fetching the
  // topic's next page when they run low.
  function take(state, topic, filter, count) {
    var buf = state.buffer[topic] || (state.buffer[topic] = []);
    if (buf.length >= count || state.cursor[topic] === null) return Promise.resolve(buf.splice(0, count));
    return api.search(topic, filter, state.cursor[topic] || '').then(function (r) {
      state.cursor[topic] = r.next; // null once the topic runs dry
      r.items.forEach(function (v) { buf.push(remember(v, topic)); });
      return buf.splice(0, count);
    });
  }

  // One list per topic slot. A topic picked twice is fetched twice in a
  // row (page 1, then page 2), never in parallel. onTopic(topic, n, err)
  // reports progress for the build log.
  function batch(state, topics, filter, per, onTopic) {
    var counts = {};
    topics.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    var names = Object.keys(counts);
    var lists = [];
    var failed = 0;
    return Promise.all(names.map(function (t) {
      var got = 0;
      var chain = Promise.resolve();
      for (var i = 0; i < counts[t]; i++) {
        chain = chain.then(function () {
          return take(state, t, filter, per).then(function (l) { lists.push(l); got += l.length; });
        });
      }
      return chain.then(function () {
        if (onTopic) onTopic(t, got);
      }, function (err) {
        failed++;
        if (onTopic) onTopic(t, 0, err);
      });
    })).then(function () {
      if (failed === names.length) throw new Error('the search service is not answering right now');
      return lists;
    });
  }

  function moreFeed(onTopic) {
    var exclude = {};
    feed.items.forEach(function (v) { exclude[v.id] = 1; });
    return batch(feed, me.pickTopics(TOPICS), 'videos', PER_TOPIC, onTopic).then(function (lists) {
      var fresh = me.interleave(lists, exclude);
      feed.items = feed.items.concat(fresh);
      feed.dry = fresh.length ? 0 : feed.dry + 1;
      return fresh;
    });
  }

  function moreShorts() {
    if (reel.busy) return Promise.resolve([]);
    reel.busy = true;
    var exclude = {};
    reel.items.forEach(function (v) { exclude[v.id] = 1; });
    return batch(reel, me.pickTopics(2), 'shorts', 8).then(function (lists) {
      var fresh = me.interleave(lists, exclude);
      reel.items = reel.items.concat(fresh);
      return fresh;
    }).finally(function () { reel.busy = false; });
  }

  function seedReel(list, id) {
    var ids = {};
    reel.items.forEach(function (v) { ids[v.id] = 1; });
    var head = list.filter(function (v) { return !ids[v.id]; });
    reel.items = head.concat(reel.items);
    reel.i = Math.max(0, reel.items.findIndex(function (v) { return v.id === id; }));
  }

  /* ---------- views ---------- */

  // #/start: type what you like, then the first batch is built live.
  function start() {
    setNav('');
    window.scrollTo(0, 0);
    var chosen = me.interests();
    var input = h('input', {
      id: 'like-q', type: 'text', maxlength: '60', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'off', enterkeyhint: 'enter', placeholder: 'type a topic'
    });
    var title = h('h1', { class: 'yt-h1 start-title' });
    var mine = h('div', { class: 'chips is-mine' });
    var none = h('p', { class: 'picks-empty', text: 'nothing yet. type a topic above or tap one below.' });
    var meterText = h('span', { class: 'meter-n' });
    var ideas = h('div', { class: 'chips is-ideas is-stagger' });
    var goLbl = h('span', { class: 'lbl', text: 'build my feed' });
    var go = h('button', { class: 'btn-go', type: 'button' }, goLbl, h('span', { class: 'go-spin', 'aria-hidden': 'true' }), icon('right'));
    var addBtn = h('button', { class: 'pill is-solid', type: 'button', text: 'add', onclick: function () { addLike(input.value); input.value = ''; input.focus(); } });
    var hint = h('p', { class: 'build-hint' });
    var meter = h('span', { class: 'build-meter', 'aria-hidden': 'true' });
    var log = h('div', { class: 'build-log', 'aria-live': 'polite' });
    var fresh = '';      // the chip just added pops in
    var painted = false;
    var timers = [];
    var waitRow = null;
    var busy = false;    // while the first batch is built nothing can change
    var section = null;
    cleanup.push(function () { timers.forEach(clearInterval); });

    function addLike(s) {
      if (busy) return;
      String(s).split(',').forEach(function (part) {
        var k = part.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
        if (k && chosen.indexOf(k) < 0 && chosen.length < 20) { chosen.push(k); fresh = k; }
      });
      paint();
    }
    function paint() {
      if (painted) ideas.classList.remove('is-stagger');
      painted = true;
      mine.textContent = '';
      ideas.textContent = '';
      chosen.forEach(function (c) {
        mine.appendChild(h('button', {
          class: 'chip is-on' + (c === fresh ? ' is-new' : ''), type: 'button', 'aria-label': 'remove ' + c,
          onclick: function () { if (!busy) { chosen.splice(chosen.indexOf(c), 1); paint(); } }
        }, c, h('span', { class: 'chip-mark', 'aria-hidden': 'true', text: '×' })));
      });
      fresh = '';
      var n = 0;
      SUGGEST.forEach(function (s) {
        if (chosen.indexOf(s) >= 0) return;
        var chip = h('button', { class: 'chip', type: 'button', 'aria-label': 'add ' + s, onclick: function () { addLike(s); } },
          h('span', { class: 'chip-plus', 'aria-hidden': 'true', text: '+' }), s);
        chip.style.setProperty('--i', String(n++));
        ideas.appendChild(chip);
      });
      none.hidden = chosen.length > 0;
      meterText.textContent = chosen.length + ' picked';
      go.disabled = !chosen.length;
      hint.textContent = chosen.length >= 3 ? 'nice mix. ready when you are.' :
        chosen.length ? 'add ' + (3 - chosen.length) + ' more for a better mix' : 'pick at least one topic';
      var k = Math.min(3, chosen.length);
      meter.textContent = '[' + rep('#', k) + rep('.', 3 - k) + ']';
      meter.classList.toggle('is-full', k >= 3);
    }

    /* the build log: one row per topic, each with an ascii bar that fills;
       narrower columns on a phone so a row never runs off the panel */
    var narrow = window.matchMedia('(max-width: 480px)').matches;
    var W = narrow ? 8 : 12;      // bar cells
    var KEY = narrow ? 15 : 21;   // name + dot leader
    function say(text, cls) {
      var row = h('div', { class: 'log-row' + (cls ? ' ' + cls : ''), text: text });
      log.insertBefore(row, waitRow);
      return row;
    }
    function fill(bar, ch) {
      if (reduced()) { bar.textContent = '[' + rep(ch, W) + ']'; return; }
      var k = 0;
      var t = setInterval(function () {
        k++;
        bar.textContent = '[' + rep(ch, k) + rep('.', W - k) + ']';
        if (k >= W) clearInterval(t);
      }, 32);
      timers.push(t);
    }
    function entry(key, value, bad) {
      if (key.length > KEY - 3) key = key.slice(0, KEY - 4) + '…';
      var bar = h('span', { class: 'log-bar', 'aria-hidden': 'true', text: '[' + rep('.', W) + ']' });
      log.insertBefore(h('div', { class: 'log-row' + (bad ? ' is-bad' : '') },
        '  ' + key + ' ' + rep('.', Math.max(2, KEY - key.length)) + ' ',
        bar,
        h('span', { class: 'log-n', text: ' ' + value })), waitRow);
      fill(bar, bad ? '-' : '#');
    }
    // a spinner row while the search service answers (decoration only)
    function waiting(on) {
      if (!on) {
        if (waitRow) waitRow.remove();
        waitRow = null;
        return;
      }
      var spin = h('span', { class: 'log-spin', text: '|' });
      var bar = h('span', { class: 'log-bar' });
      waitRow = h('div', { class: 'log-row is-wait', 'aria-hidden': 'true' }, '  ', spin, ' querying ', bar);
      log.appendChild(waitRow);
      var i = 0;
      var span = W - 3;
      function tick() {
        if (!spin.isConnected) { clearInterval(t); return; }
        spin.textContent = '|/-\\'.charAt(i % 4);
        var p = i % (2 * span);
        if (p > span) p = 2 * span - p;
        bar.textContent = '[' + rep('.', p) + '###' + rep('.', span - p) + ']';
        i++;
      }
      tick();
      if (reduced()) return;
      var t = setInterval(tick, 90);
      timers.push(t);
    }

    // lock the picks while building; the bar shows what is going on
    function setBusy(on) {
      busy = on;
      section.classList.toggle('is-building', on);
      go.classList.toggle('is-busy', on);
      go.setAttribute('aria-busy', on ? 'true' : 'false');
      input.disabled = on;
      addBtn.disabled = on;
      Array.prototype.forEach.call(section.querySelectorAll('.chip'), function (c) { c.disabled = on; });
    }

    function build() {
      if (busy || !chosen.length) return;
      setBusy(true);
      go.disabled = true;
      goLbl.textContent = 'building';
      hint.textContent = 'fetching videos…';
      var done = 0;
      log.textContent = '';
      waitRow = null;
      me.create(chosen);
      resetFeed();
      say('> building your feed', 'is-head');
      entry('profile', chosen.length + (chosen.length === 1 ? ' interest' : ' interests'));
      waiting(true);
      log.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      moreFeed(function (topic, n, err) {
        if (!section.isConnected) return;
        entry(topic, err ? 'failed' : n + ' videos', !!err);
        done++;
        hint.textContent = 'fetching… ' + done + (done === 1 ? ' topic' : ' topics') + ' in';
      }).then(function (items) {
        // the person left #/start mid-build: the feed is saved, but stay where they went
        if (!section.isConnected) return;
        waiting(false);
        say('> ' + items.length + ' videos ready', 'is-ok');
        go.classList.remove('is-busy');
        go.classList.add('is-ready');
        goLbl.textContent = 'ready';
        hint.textContent = 'opening your feed';
        restart(flashEl, 'on');
        setTimeout(function () {
          if (section.isConnected) location.replace('#/home');
        }, reduced() ? 400 : 850);
      }, function (err) {
        if (!section.isConnected) return;
        waiting(false);
        say('> ' + err.message, 'is-bad');
        setBusy(false);
        go.disabled = false;
        goLbl.textContent = 'try again';
        hint.textContent = 'that did not work. check the log and try again.';
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addLike(input.value);
        input.value = '';
      }
    });
    go.addEventListener('click', build);

    section = h('section', { class: 'start' },
      h('p', { class: 'start-kicker', 'aria-hidden': 'true' },
        h('span', { class: 'start-step', text: chosen.length ? 'rebuild' : 'setup' }),
        h('span', { text: chosen.length ? 'profile: ' + chosen.length + ' interests' : 'profile: none' })),
      title,
      h('p', { class: 'start-sub', text: 'pick a few topics and we will build your feed from them. it keeps learning from what you watch.' }),
      h('div', { class: 'start-field' },
        h('label', { class: 'sr', for: 'like-q', text: 'add a topic' }),
        h('span', { class: 'start-prompt', 'aria-hidden': 'true', text: '>' }),
        input,
        addBtn),
      h('div', { class: 'picks' },
        h('div', { class: 'picks-head' },
          h('div', { class: 'start-label' }, h('span', { text: 'your picks' })),
          h('div', { class: 'meter', 'aria-hidden': 'true' }, meter, meterText)),
        none,
        mine),
      log,
      h('div', { class: 'start-label' }, h('span', { text: 'popular topics' }), h('span', { class: 'sec-rule', 'aria-hidden': 'true' })),
      ideas,
      h('div', { class: 'start-go' }, h('div', { class: 'start-go-in' }, hint, go)));
    mount(section);
    paint();
    decodeIn(title, 'what are you into?');
    // on a phone the keyboard would cover the page, so only focus with a mouse
    if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
  }

  // #/home: Shorts shelf + the feed, endless.
  function home() {
    var shelfBox = h('div', { class: 'shelf-slot' });
    var count = h('span', { class: 'sec-n' });
    var mix = h('div', { class: 'tags feed-mix', 'aria-hidden': 'true' });
    var grid = h('div', { class: 'grid' });
    var tail = h('div', { class: 'tail' });
    var shown = 0;
    var bySrc = {};
    mount(shelfBox, secHead('feed', count, mix), grid, tail);
    var seen = me.watched();

    // which topics the cards on screen came from, strongest first
    function append(items) {
      items.forEach(function (v) {
        grid.appendChild(videoCard(v, seen));
        if (v.src) bySrc[v.src] = (bySrc[v.src] || 0) + 1;
      });
      shown += items.length;
      count.textContent = shown ? pad(shown) : '';
      mix.textContent = '';
      Object.keys(bySrc).sort(function (a, b) { return bySrc[b] - bySrc[a]; }).slice(0, 5).forEach(function (k) {
        mix.appendChild(h('span', { class: 'tag' }, k + ' ', h('b', { text: String(bySrc[k]) })));
      });
    }
    if (feed.items.length) {
      append(feed.items);
      var y = feed.scroll;
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    } else {
      add(grid, ghosts(8, 'card'));
    }

    if (shelf) {
      add(shelfBox, shortsShelf(shelf, 'shorts'));
    } else {
      add(shelfBox, ghostShelf());
      batch(reel, me.pickTopics(2), 'shorts', 6).then(function (lists) {
        shelf = me.interleave(lists, {}).slice(0, 12);
        seedReel(shelf, shelf.length ? shelf[0].id : '');
        if (shelfBox.isConnected) {
          shelfBox.textContent = '';
          add(shelfBox, shortsShelf(shelf, 'shorts'));
        }
      }).catch(function () { shelfBox.textContent = ''; /* no shelf is fine */ });
    }

    infinite(tail, function () {
      if (feed.dry > 2) return Promise.resolve(false);
      return moreFeed().then(function (items) {
        Array.prototype.slice.call(grid.querySelectorAll('.is-ghost')).forEach(function (g) { g.remove(); });
        append(items);
        return true;
      });
    }, !feed.items.length);
    cleanup.push(function () { feed.scroll = window.scrollY; });
  }

  // #/watch/id: player, actions, up next.
  function watch(id, startAt) {
    window.scrollTo(0, 0);
    var v = remember({ id: id });
    var f = frame(id, { start: startAt });
    var title = h('h1', { class: 'w-title' });
    var avaSlot = h('span', { class: 'w-ava' });
    var chName = h('a', { class: 'w-channel' });
    var chSubs = h('span', { class: 'w-subs' });
    var subBtn = pillBtn('plus', 'subscribe', 'is-solid');
    var likeBtn = pillBtn('like', 'like');
    var hideBtn = pillBtn('hide', 'not interested');
    var stats = h('div', { class: 'w-stats' });
    var nextCount = h('span', { class: 'sec-n' });
    var nextList = h('div', { class: 'w-list' }, ghosts(6, 'row'));
    var timeEl = h('span', { class: 'w-time' });
    var progEl = h('i');
    // the video's own thumbnail, gray and blurred, as a glow behind the frame
    var amb = h('img', { alt: '', src: api.thumb({ id: id }), decoding: 'async', onload: imgOk, onerror: imgBad });

    mount(h('div', { class: 'watch' },
      h('div', { class: 'w-main' },
        h('div', { class: 'w-hud' },
          h('div', { class: 'w-amb', 'aria-hidden': 'true' }, amb),
          h('div', { class: 'w-cap', 'aria-hidden': 'true' },
            h('span', {}, '> play ', h('b', { text: id }), timeEl), h('span', { class: 'w-cap-r', text: 'no-cookie · sandboxed' })),
          h('div', { class: 'w-screen' }, f),
          h('div', { class: 'w-prog', 'aria-hidden': 'true' }, progEl),
          h('span', { class: 'w-br', 'aria-hidden': 'true' })),
        title,
        h('div', { class: 'w-row' },
          h('div', { class: 'w-owner' }, avaSlot, h('div', { class: 'w-who' }, chName, chSubs)),
          h('div', { class: 'w-actions' }, subBtn, likeBtn, hideBtn)),
        stats),
      h('aside', { class: 'w-next', 'aria-label': 'up next' }, secHead('up next', nextCount), nextList)));
    root.classList.add('playing');

    var settled = !!(v.title && v.channelId); // nothing left to look up
    var shownTitle = null;
    var shownCh = null;
    function paint() {
      document.title = '~/v';
      var t = v.title || (settled ? 'video' : '');
      if (t !== shownTitle) {
        shownTitle = t;
        decodeIn(title, t);
      }
      if (shownCh !== (v.channel || '')) {
        shownCh = v.channel || '';
        avaSlot.textContent = '';
        avaSlot.appendChild(avatar(v.channel, 'md'));
      }
      chName.textContent = v.channel || (settled ? ' ' : '');
      if (v.channelId) chName.setAttribute('href', '#/channel/' + v.channelId);
      chSubs.textContent = v.subscribers || '';
      var liked = me.isLiked(v.id);
      setBtn(likeBtn, liked ? 'liked' : 'like', (liked ? 'liked' : 'like') + (v.likes ? ' · ' + v.likes : ''));
      likeBtn.setAttribute('aria-pressed', String(liked));
      var subbed = v.channelId && me.isSubbed(v.channelId);
      setBtn(subBtn, subbed ? 'check' : 'plus', subbed ? 'subscribed' : 'subscribe');
      subBtn.setAttribute('aria-pressed', String(!!subbed));
      subBtn.disabled = !v.channelId;
      subBtn.classList.toggle('is-solid', !subbed);
      stats.textContent = '';
      add(stats, tags([v.views, v.published]));
      // the topic that brought this video into the feed
      if (v.src) stats.firstChild.appendChild(h('span', { class: 'tag is-via', text: 'via ' + v.src }));
    }

    likeBtn.addEventListener('click', function () {
      toast(me.toggleLike(v) ? 'liked. more like this.' : 'like removed.');
      paint();
      pop(likeBtn);
    });
    subBtn.addEventListener('click', function () {
      if (!v.channelId) return;
      toast(me.toggleSub(v.channelId, v.channel) ? 'subscribed to ' + (v.channel || 'channel') + '.' : 'unsubscribed.');
      paint();
      pop(subBtn);
    });
    hideBtn.addEventListener('click', function () {
      me.hide(v);
      toast('got it. you will see less like this.');
      location.hash = '#/home';
    });

    paint();
    me.signal('open', v);
    me.addHistory(v);

    // watched for a minute, or half of a short video: that counts
    var credited = false;
    cleanup.push(track(f, function (s) {
      playHud(timeEl, progEl, s);
      if (!credited && s.time > 0 && s.time >= Math.min(60, (s.duration || 120) * 0.5)) {
        credited = true;
        me.signal('watch', v);
      }
    }));

    function upNext() {
      var q = v.src || v.channel || String(v.title || '').split(/\s+/).slice(0, 4).join(' ') || 'popular';
      api.search(q, 'videos').then(function (r) {
        var exclude = {};
        exclude[v.id] = 1;
        var items = me.interleave([r.items.map(function (x) { return remember(x, q); })], exclude).slice(0, 15);
        var seen = me.watched();
        nextList.textContent = '';
        items.forEach(function (x, i) { nextList.appendChild(videoCard(x, seen, { row: true, n: i + 1 })); });
        nextCount.textContent = items.length ? pad(items.length) : '';
        if (!items.length) nextList.appendChild(problem('nothing up next.'));
      }, function (err) {
        nextList.textContent = '';
        nextList.appendChild(problem(err.message, upNext));
      });
    }

    if (settled) upNext();
    else {
      api.details([id]).then(function (d) {
        if (d[id]) v = remember(d[id]);
        settled = true;
        paint();
        if (d[id]) me.addHistory(v);
        upNext();
      });
    }
  }

  // #/shorts[/id]: one Short at a time, vertical, endless.
  function shorts(startId) {
    window.scrollTo(0, 0);
    if (startId && !reel.items.some(function (v) { return v.id === startId; })) {
      seedReel([remember({ id: startId, short: true })], startId);
    } else if (startId) {
      reel.i = reel.items.findIndex(function (v) { return v.id === startId; });
    }

    var stage = h('div', { class: 'reel-stage' });
    var idx = h('span', { class: 'reel-idx' });
    var prog = h('i');
    var timeEl = h('span', { class: 'reel-time' });
    var playEl = h('i');
    var title = h('p', { class: 'reel-title' });
    var avaSlot = h('span', { class: 'reel-ava' });
    var chName = h('a', { class: 'reel-channel' });
    // the Short's own frame, gray and blurred, behind everything
    var amb = h('img', { alt: '', decoding: 'async', onload: imgOk, onerror: imgBad });
    var likeBtn = reelBtn('like', 'like');
    var subBtn = reelBtn('plus', 'subscribe');
    var hideBtn = reelBtn('hide', 'hide', 'not interested');
    var prevBtn = reelBtn('up', 'prev', 'previous short');
    var nextBtn = reelBtn('down', 'next', 'next short');
    var box = h('section', { class: 'reel', 'aria-label': 'shorts' },
      h('div', { class: 'reel-amb', 'aria-hidden': 'true' }, amb),
      h('div', { class: 'reel-col' },
        h('div', { class: 'reel-top', 'aria-hidden': 'true' },
          idx, timeEl, h('span', { class: 'reel-keys' }, h('kbd', { text: 'j' }), h('kbd', { text: 'k' }), ' or scroll')),
        h('div', { class: 'reel-prog', 'aria-hidden': 'true' }, prog),
        h('div', { class: 'reel-frame' }, stage,
          h('div', { class: 'reel-play', 'aria-hidden': 'true' }, playEl),
          h('span', { class: 'reel-br', 'aria-hidden': 'true' })),
        h('div', { class: 'reel-info' }, title, h('div', { class: 'reel-by' }, avaSlot, chName))),
      h('div', { class: 'reel-side' }, prevBtn, nextBtn, likeBtn, subBtn, hideBtn));
    mount(box);

    var cur = null;
    var stop = null;
    var shownAt = 0;
    var best = 0;
    var dur = 0;
    var looped = false;
    var shownCh = null;

    // Decide what the Short we are leaving tells us about taste: watched
    // through (or looped) is a like-lite, swiped away within 3s is a skip,
    // anything in between is mild interest.
    function judge() {
      if (!cur) return;
      if (looped || (dur && best >= dur * 0.8)) me.signal('watch', cur);
      else if (Date.now() - shownAt < 3000) me.signal('skip', cur);
      else me.signal('open', cur);
    }

    function paint() {
      if (!cur) return;
      title.textContent = cur.title || '';
      if (shownCh !== (cur.channel || '')) {
        shownCh = cur.channel || '';
        avaSlot.textContent = '';
        if (shownCh) avaSlot.appendChild(avatar(shownCh, 'xs'));
      }
      chName.textContent = cur.channel || '';
      if (cur.channelId) chName.setAttribute('href', '#/channel/' + cur.channelId);
      else chName.removeAttribute('href');
      var liked = me.isLiked(cur.id);
      setBtn(likeBtn, liked ? 'liked' : 'like', liked ? 'liked' : 'like');
      likeBtn.setAttribute('aria-pressed', String(liked));
      var subbed = cur.channelId && me.isSubbed(cur.channelId);
      setBtn(subBtn, subbed ? 'check' : 'plus', subbed ? 'subscribed' : 'subscribe');
      subBtn.setAttribute('aria-pressed', String(!!subbed));
      subBtn.disabled = !cur.channelId;
      subBtn.classList.toggle('is-cta', !subbed);
      prevBtn.disabled = reel.i === 0;
      likeBtn.disabled = hideBtn.disabled = false;
      stage.classList.remove('is-wait');
      idx.textContent = '';
      add(idx, h('b', { text: pad(reel.i + 1) }), ' / ' + pad(reel.items.length));
      prog.style.width = ((reel.i + 1) / Math.max(1, reel.items.length) * 100).toFixed(1) + '%';
    }

    // Shorts search results carry no channel; look them up in small batches.
    function fillChannels() {
      var ids = reel.items.slice(reel.i, reel.i + 8)
        .filter(function (v) { return !v.channelId; })
        .map(function (v) { return v.id; });
      if (!ids.length) return;
      api.details(ids).then(function (d) {
        Object.keys(d).forEach(function (k) { remember(d[k]); });
        paint();
      });
    }

    // the new Short slides in from the side it came from
    function slide(dir) {
      if (reduced()) return;
      stage.classList.remove('is-up', 'is-down', 'is-fade');
      void stage.offsetWidth;
      stage.classList.add(dir > 0 ? 'is-up' : dir < 0 ? 'is-down' : 'is-fade');
    }

    function show(i, dir) {
      judge();
      if (stop) stop();
      if (!reel.items.length) {
        stage.textContent = '';
        stage.appendChild(problem('no shorts yet.', function () { moreShorts().then(function () { show(0, 0); }); }));
        return;
      }
      reel.i = Math.max(0, Math.min(i, reel.items.length - 1));
      cur = reel.items[reel.i];
      history.replaceState(null, '', '#/shorts/' + cur.id);
      shownAt = Date.now();
      best = 0;
      dur = 0;
      looped = false;
      var f = frame(cur.id, { loop: true });
      var poster = api.thumb(cur);
      stage.textContent = '';
      stage.appendChild(h('img', { class: 'reel-poster', alt: '', src: poster, decoding: 'async', onerror: imgBad }));
      stage.appendChild(f);
      slide(dir);
      if (amb.getAttribute('src') !== poster) {
        amb.classList.remove('is-ok');
        amb.src = poster;
      }
      root.classList.add('playing');
      timeEl.textContent = '';
      timeEl._dur = timeEl._t = 0;
      playEl.style.width = '0';
      playEl.parentNode.classList.remove('on');
      stop = track(f, function (s) {
        playHud(timeEl, playEl, s);
        if (s.duration) dur = s.duration;
        if (dur && best >= dur * 0.8 && s.time < 1) looped = true;
        if (s.time > best) best = s.time;
      });
      me.addHistory(cur);
      paint();
      fillChannels();
      if (reel.items.length - reel.i < 4) moreShorts().then(paint, function () {});
    }

    function step(d) {
      if (d > 0 && reel.i >= reel.items.length - 1) {
        moreShorts().then(function () { if (reel.i < reel.items.length - 1) show(reel.i + 1, 1); });
        return;
      }
      show(reel.i + d, d);
    }

    likeBtn.addEventListener('click', function () {
      if (cur) toast(me.toggleLike(cur) ? 'liked. more like this.' : 'like removed.');
      paint();
      pop(likeBtn);
    });
    subBtn.addEventListener('click', function () {
      if (!cur || !cur.channelId) return;
      toast(me.toggleSub(cur.channelId, cur.channel) ? 'subscribed to ' + (cur.channel || 'channel') + '.' : 'unsubscribed.');
      paint();
      pop(subBtn);
    });
    hideBtn.addEventListener('click', function () {
      if (!cur) return;
      me.hide(cur);
      reel.items.splice(reel.i, 1);
      cur = null;
      toast('got it. you will see less like this.');
      show(reel.i, 1);
    });
    prevBtn.addEventListener('click', function () { step(-1); });
    nextBtn.addEventListener('click', function () { step(1); });

    // keys, wheel and swipes outside the player move through the reel
    function onKey(e) {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
    }
    var wheelAt = 0;
    function onWheel(e) {
      if (Math.abs(e.deltaY) < 30 || Date.now() - wheelAt < 700) return;
      wheelAt = Date.now();
      e.preventDefault();
      step(e.deltaY > 0 ? 1 : -1);
    }
    var touchY = null;
    function onTouchStart(e) { touchY = e.touches[0].clientY; }
    function onTouchEnd(e) {
      if (touchY == null) return;
      var dy = touchY - e.changedTouches[0].clientY;
      touchY = null;
      if (Math.abs(dy) > 60) step(dy > 0 ? 1 : -1);
    }
    document.addEventListener('keydown', onKey);
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchend', onTouchEnd, { passive: true });
    cleanup.push(function () {
      judge();
      if (stop) stop();
      document.removeEventListener('keydown', onKey);
    });

    if (reel.items.length) show(reel.i, 0);
    else {
      // nothing to act on until the first Short arrives
      prevBtn.disabled = likeBtn.disabled = subBtn.disabled = hideBtn.disabled = true;
      stage.classList.add('is-wait');
      stage.appendChild(h('span', { class: 'spin', text: 'loading' }));
      moreShorts().then(function () { if (box.isConnected) show(0, 0); }, function (err) {
        stage.textContent = '';
        stage.appendChild(problem(err.message, function () { route(); }));
      });
    }
  }

  // #/search/query
  function results(q) {
    q = q.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!q) { location.replace('#/home'); return; }
    window.scrollTo(0, 0);
    searchInput.value = q;
    me.searched(q);
    var qEl = h('h1', { class: 'yt-h1 q-text' });
    var count = h('span', { class: 'q-count' });
    var shelfBox = h('div', { class: 'shelf-slot' });
    var grid = h('div', { class: 'grid' }, ghosts(8, 'card'));
    var tail = h('div', { class: 'tail' });
    mount(h('header', { class: 'q-head' },
      h('p', { class: 'q-label', 'aria-hidden': 'true', text: '> search' }), qEl, count),
      shelfBox, grid, tail);
    decodeIn(qEl, q);
    var next = '';
    var first = true;
    var total = 0;
    var seen = me.watched();
    infinite(tail, function () {
      if (!first && !next) return Promise.resolve(false);
      return api.search(q, 'all', next).then(function (r) {
        var items = r.items.map(function (v) { return remember(v, q); });
        if (first) {
          grid.textContent = '';
          add(shelfBox, shortsShelf(items.filter(function (v) { return v.short; }).slice(0, 12), 'shorts'));
          if (!items.length) grid.appendChild(problem('no results for that.'));
        }
        first = false;
        items.filter(function (v) { return !v.short; }).forEach(function (v) { grid.appendChild(videoCard(v, seen)); total++; });
        count.textContent = total ? total + (total === 1 ? ' result' : ' results') : '';
        next = r.next || '';
        return !!next;
      });
    }, true);
  }

  // #/channel/UCid
  function channelPage(id) {
    window.scrollTo(0, 0);
    var art = banner(id);
    var head = h('header', { class: 'ch-head is-wait' },
      h('span', { class: 'ghost-ava is-xl' }),
      h('div', { class: 'ch-who' }, h('div', { class: 'ghost-line is-title' }), h('div', { class: 'ghost-line is-short' })));
    var shelfBox = h('div', { class: 'shelf-slot' });
    var grid = h('div', { class: 'grid' }, ghosts(8, 'card'));
    var tail = h('div', { class: 'tail' });
    mount(h('div', { class: 'ch-top' }, art.el, head), shelfBox, grid, tail);
    art.start();
    cleanup.push(art.stop);
    var next = '';
    var first = true;
    var named = false;
    var shownInfo = {};
    var seen = me.watched();

    function paintHead(info) {
      shownInfo = info;
      var subbed = me.isSubbed(id);
      var btn = pillBtn(subbed ? 'check' : 'plus', subbed ? 'subscribed' : 'subscribe', subbed ? '' : 'is-solid');
      btn.setAttribute('aria-pressed', String(subbed));
      btn.addEventListener('click', function () {
        toast(me.toggleSub(id, info.title) ? 'subscribed to ' + (info.title || 'channel') + '.' : 'unsubscribed.');
        paintHead(info);
      });
      var name = h('h1', { class: 'yt-h1' });
      head.textContent = '';
      head.classList.remove('is-wait');
      add(head,
        avatar(info.title || id, 'xl'),
        h('div', { class: 'ch-who' }, name, tags([info.handle, info.subscribers, info.videos])),
        btn);
      if (named) name.textContent = info.title || 'channel';
      else { named = true; decodeIn(name, info.title || 'channel'); }
    }

    infinite(tail, function () {
      if (!first && !next) return Promise.resolve(false);
      return api.channel(id, 'videos', next).then(function (r) {
        if (first) {
          grid.textContent = '';
          // repaint only when this answer knows more than the first one
          if (!named || (r.info.videos && !shownInfo.videos)) paintHead(r.info);
          if (!r.items.length) grid.appendChild(problem('no videos here.'));
        }
        first = false;
        r.items.forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
        next = r.next || '';
        return !!next;
      });
    }, true);
    api.channel(id, 'shorts').then(function (r) {
      if (!shelfBox.isConnected) return;
      // the Shorts tab often answers first: show the header from it
      if (!named && r.info.title) paintHead(r.info);
      add(shelfBox, shortsShelf(r.items.slice(0, 12), 'shorts'));
    }, function () { /* channels without Shorts are fine */ });
  }

  // #/subs: newest uploads across your subscriptions.
  function subs() {
    window.scrollTo(0, 0);
    var list = me.subs();
    var title = h('h1', { class: 'yt-h1' });
    if (!list.length) {
      mount(title, problem('no subscriptions yet. subscribe from any video or channel.'));
      decodeIn(title, 'subscriptions');
      return;
    }
    var count = h('span', { class: 'sec-n' });
    var grid = h('div', { class: 'grid' }, ghosts(8, 'card'));
    mount(title,
      h('div', { class: 'chips is-subs' }, list.map(function (s) {
        return h('a', { class: 'chip has-ava', href: '#/channel/' + s.id },
          avatar(s.name || s.id, 'xs'), h('span', { text: s.name || 'channel' }));
      })),
      secHead('latest', count),
      grid);
    decodeIn(title, 'subscriptions');
    Promise.all(list.slice(0, 12).map(function (s) {
      return api.channel(s.id, 'videos').then(function (r) { return r.items.slice(0, 8); }, function () { return []; });
    })).then(function (lists) {
      var all = [].concat.apply([], lists);
      all.sort(function (a, b) { return age(a.published) - age(b.published); });
      var seen = me.watched();
      grid.textContent = '';
      all.slice(0, 60).forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
      count.textContent = all.length ? pad(Math.min(60, all.length)) : '';
      if (!all.length) grid.appendChild(problem('could not load your subscriptions right now.', subs));
    });
  }

  // an ascii bar per topic: how strongly the feed leans toward it
  function weightChart(list) {
    var W = 20;
    var max = list.reduce(function (m, x) { return Math.max(m, x.w); }, 0) || 1;
    var rows = list.map(function (x) {
      var n = Math.max(1, Math.round(x.w / max * W));
      var bar = h('span', { class: 'bar-v', 'aria-hidden': 'true', text: '[' + rep('.', W) + ']' });
      if (reduced()) bar.textContent = '[' + rep('#', n) + rep('.', W - n) + ']';
      else {
        var k = 0;
        var t = setInterval(function () {
          k++;
          bar.textContent = '[' + rep('#', Math.min(k, n)) + rep('.', W - Math.min(k, n)) + ']';
          if (k >= n || !bar.isConnected) clearInterval(t);
        }, 28);
      }
      return h('div', { class: 'bar-row' },
        h('span', { class: 'bar-k', text: x.k }),
        bar,
        h('span', { class: 'bar-w', text: x.w.toFixed(1) }),
        h('span', { class: 'bar-t', text: x.seed ? 'typed' : x.learned ? 'learned' : 'searched' }));
    });
    return h('div', { class: 'bars' }, rows);
  }

  // how much this page keeps in localStorage (read only)
  function storedTag() {
    var keys = 0;
    var bytes = 0;
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('yt.') !== 0) return;
        keys++;
        bytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
      });
    } catch (e) { return null; }
    return h('span', { class: 'tag' }, h('b', { text: (bytes / 1024).toFixed(1) + ' kb' }), ' in ' + keys + (keys === 1 ? ' key' : ' keys'));
  }

  function tile(n, label) {
    var num = h('span', { class: 'tile-n', text: '00' });
    tickUp(num, n);
    return h('div', { class: 'tile' }, num, h('span', { class: 'tile-k', text: label }));
  }

  // #/library: what this browser knows about you, and the off switches.
  function library() {
    window.scrollTo(0, 0);
    var seen = me.watched();
    var likes = me.likes();
    var hist = me.history();
    var subsList = me.subs();
    var mine = me.interests();
    var weights = me.topics ? me.topics().filter(function (t) { return t.w > 0.05; }).slice(0, 10) : [];
    var title = h('h1', { class: 'yt-h1' });

    function grid(items) {
      return h('div', { class: 'grid is-small' }, items.map(function (v) { return videoCard(v, seen, { small: true }); }));
    }
    function section(name, n, action, body) {
      return h('section', { class: 'lib' },
        secHead(name, n ? h('span', { class: 'sec-n', text: pad(n) }) : null, action), body);
    }

    mount(
      title,
      h('div', { class: 'tiles' },
        tile(mine.length, 'interests'), tile(likes.length, 'liked'),
        tile(hist.length, 'watched'), tile(subsList.length, 'subscribed')),
      section('your interests', 0,
        h('a', { class: 'pill', href: '#/start', text: 'edit & rebuild' }),
        h('div', { class: 'chips' }, mine.map(function (s) { return h('span', { class: 'chip is-on', text: s }); }))),
      weights.length ? section('topic weights', 0, null, weightChart(weights)) : null,
      section('liked', likes.length, null,
        likes.length ? grid(likes.slice(0, 24)) : problem('nothing liked yet.')),
      section('history', hist.length,
        hist.length ? h('button', { class: 'pill has-ico', type: 'button', onclick: function () {
          me.clear('history');
          toast('history cleared.');
          library();
        } }, icon('clear'), h('span', { class: 'lbl', text: 'clear history' })) : null,
        hist.length ? grid(hist.slice(0, 24)) : problem('nothing watched yet.')),
      section('subscriptions', subsList.length, null,
        subsList.length ? h('div', { class: 'chips' }, subsList.map(function (s) {
          return h('span', { class: 'chip is-on has-ava' },
            avatar(s.name || s.id, 'xs'),
            h('a', { href: '#/channel/' + s.id, text: s.name || 'channel' }),
            h('button', { type: 'button', class: 'chip-x', 'aria-label': 'unsubscribe from ' + (s.name || 'channel'), text: '×', onclick: function () {
              me.toggleSub(s.id, s.name);
              library();
            } }));
        })) : problem('no subscriptions yet.')),
      section('this browser', 0, null,
        h('div', { class: 'lib-note' },
          h('p', { text: 'your interests, likes, subscriptions and history are stored only in this browser.' }),
          storedTag(),
          h('button', { class: 'pill is-danger', type: 'button', text: 'forget everything', onclick: function () {
            me.forget();
            resetFeed();
            toast('everything forgotten.');
            location.hash = '#/start';
          } }))));
    decodeIn(title, 'library');
  }

  /* ---------- routing ---------- */

  function setNav(name) {
    Array.prototype.forEach.call(navLinks, function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    placeNavBar();
  }

  // the bar under the active tab slides to it
  function placeNavBar() {
    if (!navBar) return;
    var a = document.querySelector('.yt-nav [aria-current="page"]');
    navBar.classList.toggle('on', !!a);
    if (!a) return;
    navBar.style.width = a.offsetWidth + 'px';
    navBar.style.transform = 'translateX(' + a.offsetLeft + 'px)';
  }

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return ''; }
  }

  // the bit after the route in the top bar path: an id or the query
  function pathTail(head, parts) {
    var t = '';
    if (head === 'watch' && ID.test(parts[1])) t = parts[1];
    if (head === 'shorts' && ID.test(parts[1])) t = parts[1];
    if (head === 'channel' && CH.test(parts[1])) t = parts[1].slice(0, 8) + '…';
    if (head === 'search') {
      t = decode(parts.slice(1).join('/')).replace(/\s+/g, ' ').trim();
      if (t.length > 18) t = t.slice(0, 17) + '…';
    }
    return t ? '/' + t : '';
  }

  function route() {
    cleanup.splice(0).forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } });
    if (revealIO) revealIO.disconnect();
    clearTimeout(outTimer);
    view.classList.remove('is-out');
    root.classList.remove('playing');
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var head = parts[0] || 'home';
    var building = !me.exists() || head === 'start';
    document.body.classList.toggle('is-start', building);
    // with no profile yet there is nothing to browse; a rebuild keeps the bar
    document.body.classList.toggle('is-first', !me.exists());
    if (pathEl) pathEl.textContent = building ? 'start' : ROUTES[head] ? head + pathTail(head, parts) : 'home';
    // the glyph rain only falls behind the build screen
    var rain = window.fx && window.fx.rain;
    if (rain) { if (building) rain.resume(); else rain.pause(); }
    dispatch(head, parts, building);
    view.setAttribute('aria-label', building ? 'build your feed' : ROUTES[head] ? head : 'home');
    // the link that was activated is gone now: keep keyboard and screen
    // reader focus in the page instead of dropping it to <body>
    var a = document.activeElement;
    if (routed && (!a || a === document.body || !a.isConnected)) {
      try { view.focus({ preventScroll: true }); } catch (e) { view.focus(); }
    }
    routed = true;
    if (!reduced()) {
      restart(view, 'is-in');
      restart(sweepEl, 'on');
    }
  }

  function dispatch(head, parts, building) {
    if (building) return start();
    setNav(head);
    if (head === 'home') return home();
    if (head === 'shorts') return shorts(ID.test(parts[1]) ? parts[1] : '');
    if (head === 'watch' && ID.test(parts[1])) return watch(parts[1], parseInt(parts[2], 10) || 0);
    if (head === 'search') return results(decode(parts.slice(1).join('/')));
    if (head === 'channel' && CH.test(parts[1])) return channelPage(parts[1]);
    if (head === 'subs') return subs();
    if (head === 'library') return library();
    location.replace('#/home');
  }

  // The old view dims out for a beat, then the new one comes in.
  var outTimer = 0;
  var routed = false;   // the first route leaves focus where the page starts
  function onHash() {
    clearTimeout(outTimer);
    if (reduced()) { route(); return; }
    view.classList.add('is-out');
    outTimer = setTimeout(route, 140);
  }

  view.addEventListener('animationend', function (e) {
    if (e.target === view) view.classList.remove('is-in');
  });

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    if (!q) return;
    var link = asVideo(q);
    if (link) {
      searchInput.value = '';
      location.hash = (link.short ? '#/shorts/' + link.id : '#/watch/' + link.id + (link.start ? '/' + link.start : ''));
    } else {
      location.hash = '#/search/' + encodeURIComponent(q.slice(0, 100));
    }
    searchInput.blur();
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.body.classList.contains('is-first')) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // top bar: a brighter edge once the page scrolls under it
  var scrolled = false;
  window.addEventListener('scroll', function () {
    var s = window.scrollY > 6;
    if (s !== scrolled) {
      scrolled = s;
      topBar.classList.toggle('is-scrolled', s);
    }
  }, { passive: true });

  var navTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(navTimer);
    navTimer = setTimeout(placeNavBar, 150);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeNavBar);

  // a phone-width field cannot fit the whole hint
  var mqNarrow = window.matchMedia('(max-width: 420px)');
  function placeholder() {
    searchInput.placeholder = mqNarrow.matches ? 'search or paste url' : 'search or paste a link';
  }
  placeholder();
  if (mqNarrow.addEventListener) mqNarrow.addEventListener('change', placeholder);

  try { localStorage.removeItem('yt.recent'); } catch (e) { /* old phase-2 list */ }
  window.addEventListener('hashchange', onHash);
  route();
})();
