/* proxy.js: the browser shell around the proxy. Two engines sit behind the
   same address bar, back / forward / reload and quick links:

   scramjet   rewrites pages in the browser with a service worker. Fast and
              the best on Chrome and Firefox, but it leans on features Safari
              does not fully have.
   rammerhead rewrites pages on the server, so the browser only gets ordinary
              pages. Used on Safari and on every iPhone / iPad browser (they
              all run Safari's engine).

   The engine is chosen from the browser; the pill in the top bar (or
   ?engine=scramjet / ?engine=rammerhead) overrides it and is remembered.
   Works only on the server in server/, not on a static host. The terminal
   look (decoding address, loading line, quick tiles) is decoration on top
   and calms down under reduced motion.

   proxy/media/ (movies in the menu) runs this same file with no browser around the page: its
   <html data-site> names the one site it opens. The site loads behind a
   loading screen, is reloaded once as soon as it has loaded (the first load
   through the proxy sometimes comes up broken), then takes the window. It
   stays on that site: a page anywhere else (an ad's redirect) is left at once
   for the last page that was on it. */
(function () {
  'use strict';

  var SEARCH = 'https://duckduckgo.com/?q=';
  var QUICK = [
    ['google', 'https://www.google.com'],
    ['duckduckgo', 'https://duckduckgo.com'],
    ['wikipedia', 'https://www.wikipedia.org'],
    ['reddit', 'https://www.reddit.com'],
    ['discord', 'https://discord.com/app'],
    ['spotify', 'https://open.spotify.com']
  ];

  var root = document.documentElement;
  var only = root.getAttribute('data-site'); // media/: the one site, no browser shell

  // media/ has no toolbar or quick links: loose stand-ins take their place
  function el(id, tag) { return document.getElementById(id) || document.createElement(tag || 'div'); }
  var form = el('p-form', 'form');
  var input = el('p-url', 'input');
  var start = document.getElementById('p-start');
  var status = document.getElementById('p-status');
  var quick = el('p-quick');
  var keyForm = document.getElementById('p-key');
  var keyIn = document.getElementById('p-key-in');
  var iframe = document.getElementById('p-frame');
  var back = el('p-back', 'button');
  var fwd = el('p-fwd', 'button');
  var reload = el('p-reload', 'button');
  var toastEl = document.getElementById('p-toast');
  var title = document.getElementById('p-h1');
  var crumb = el('p-crumb-h', 'span');

  var frame = null;
  var pending = null; // a url asked for before we were ready

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked */ }
    return null;
  }

  function calm() {
    if (window.fx && window.fx.reduced) return window.fx.reduced();
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // the toast's lower edge drains while it is up; is-a / is-b restart it
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.className = 'p-toast on ' + (toastEl.classList.contains('is-a') ? 'is-b' : 'is-a');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2600);
  }

  // busy shows a spinner glyph and a caret; bad turns it into an error block
  function say(msg, bad, busy) {
    status.textContent = msg;
    status.classList.toggle('is-bad', !!bad);
    status.classList.toggle('is-busy', !!busy);
    start.classList.toggle('is-bad', !!bad);
  }

  /* ---------- address bar ---------- */

  // A new address prints in from noise, left to right, unless the field
  // is being edited. Focusing it settles the text at once.
  var NOISE = '0123456789abcdef#%&*+=<>/\\|_-:;';
  var addr = '', addrRaf = 0;
  function settleAddr() {
    if (!addrRaf) return;
    cancelAnimationFrame(addrRaf);
    addrRaf = 0;
    input.value = addr;
  }
  // the toolbar crumb reads ~/p/<host> while a site is open
  function setCrumb(url) {
    var host = '';
    try { host = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch (e) { /* not a url */ }
    crumb.textContent = host ? '/' + host : '';
  }

  function showAddr(url) {
    settleAddr();
    addr = url;
    setCrumb(url);
    if (calm() || url.length > 180) { input.value = url; return; }
    var t0 = performance.now(), last = 0;
    var dur = Math.min(1000, Math.max(420, url.length * 24));
    (function frame(t) {
      if (t - last >= 40) {
        last = t;
        var k = Math.floor((t - t0) / dur * url.length), out = url.slice(0, Math.max(0, k));
        for (var i = Math.max(0, k); i < url.length; i++) {
          out += i < k + 14 ? NOISE.charAt((Math.random() * NOISE.length) | 0) : '';
        }
        input.value = out;
        if (k >= url.length) { addrRaf = 0; input.value = url; return; }
      }
      addrRaf = requestAnimationFrame(frame);
    })(t0);
  }

  // a light runs along the toolbar's lower edge until the frame loads
  var loadTimer;
  function loading(on, ms) {
    clearTimeout(loadTimer);
    root.classList.toggle('p-loading', !!on);
    if (on) loadTimer = setTimeout(function () { root.classList.remove('p-loading'); }, ms || 20000);
  }

  // "cats" -> search, "example.com" -> https://example.com
  function toUrl(s) {
    s = s.trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
    return SEARCH + encodeURIComponent(s);
  }

  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { ok(); };
      s.onerror = function () { fail(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function wispUrl(key) {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
      '/proxy/wisp/' + (key ? encodeURIComponent(key) + '/' : '');
  }

  // Opens and closes one socket to check the key before anything else.
  function tryKey(key) {
    return new Promise(function (ok) {
      var ws;
      try { ws = new WebSocket(wispUrl(key)); } catch (e) { return ok(false); }
      var done = false;
      function end(v) { if (done) return; done = true; try { ws.close(); } catch (e) { /* ignore */ } ok(v); }
      ws.onopen = function () { end(true); };
      ws.onerror = function () { end(false); };
      setTimeout(function () { end(false); }, 8000);
    });
  }

  /* ---------- which engine ---------- */

  // Safari, and anything on an iPhone / iPad (Apple makes every browser there
  // use Safari's engine; iPadOS even reports itself as a Mac, hence the touch test).
  function isWebKit() {
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua);
    return ios || safari;
  }

  var forced = new URLSearchParams(location.search).get('engine');
  if (forced === 'scramjet' || forced === 'rammerhead') store('p-engine', forced);
  var saved = store('p-engine');
  var auto = isWebKit() ? 'rammerhead' : 'scramjet';
  var which = saved === 'scramjet' || saved === 'rammerhead' ? saved : auto;
  var enginePill = document.getElementById('p-engine');
  if (enginePill) {
    enginePill.textContent = which === 'rammerhead' ? 'safari mode' : 'standard mode';
    enginePill.title = (which === 'rammerhead' ? 'Rammerhead engine' : 'Scramjet engine') +
      (which === auto ? ' (picked for your browser). ' : ' (set by you). ') + 'Click to switch.';
    enginePill.addEventListener('click', function () {
      store('p-engine', which === 'rammerhead' ? 'scramjet' : 'rammerhead');
      location.replace(location.pathname);
    });
  }

  /* ---------- the two engines ---------- */

  var scramjetEngine = {
    check: tryKey,
    connect: function (key) { return boot(key); },
    open: function (url) { try { frame.go(url); } catch (e) { loading(false); toast('could not open that address'); } },
    back: function () { if (frame) frame.back(); },
    forward: function () { if (frame) frame.forward(); },
    reload: function () { if (frame) frame.reload(); },
    ready: function () { return !!frame; }
  };

  var rhId = '';
  var rhKey = '';
  var rhTimer = 0;

  // A session id is 32 letters and digits. Rammerhead keeps the cookies of the
  // sites you visit under it, in memory on the server, for 30 minutes idle.
  function rhCreate() {
    return fetch('/newsession' + (rhKey ? '?pwd=' + encodeURIComponent(rhKey) : ''), { cache: 'no-store' }).then(function (r) {
      if (r.status === 403) throw new Error('key');
      if (r.status === 429) throw new Error('too many sessions, try again in a few minutes');
      if (!r.ok) throw new Error('the safari engine is not answering (' + r.status + ')');
      return r.text();
    }).then(function (t) {
      t = t.trim();
      if (!/^[a-z0-9]{32}$/i.test(t)) throw new Error('unexpected answer from the safari engine');
      // keep addresses readable (Rammerhead scrambles them by default)
      return fetch('/editsession?id=' + t + '&enableShuffling=0' + (rhKey ? '&pwd=' + encodeURIComponent(rhKey) : ''), { cache: 'no-store' })
        .then(function () { rhId = t; store('rh-id', t); return t; });
    });
  }

  function rhSession() {
    var id = rhId || store('rh-id');
    if (!id || !/^[a-z0-9]{32}$/i.test(id)) return rhCreate();
    return fetch('/sessionexists?id=' + id, { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) { if (t === 'exists') { rhId = id; return id; } return rhCreate(); }, rhCreate);
  }

  // what the proxied page's address really is: /<session>/<address>
  function rhCurrent() {
    try {
      var l = iframe.contentWindow.location;
      var m = /^\/[a-z0-9]{32}\/(.+)$/i.exec(l.pathname + l.search + l.hash);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  var rhEngine = {
    check: function (key) {
      rhKey = key;
      return rhCreate().then(function () { return true; }, function (e) {
        if (e.message === 'key') return false;
        throw e;
      });
    },
    connect: function (key) {
      rhKey = key;
      return rhSession().then(function () {
        clearInterval(rhTimer);
        rhTimer = setInterval(function () {
          if (iframe.hidden) return;
          var cur = rhCurrent();
          stayHome(cur);
          if (cur && document.activeElement !== input && input.value !== cur) input.value = cur;
        }, 600);
      });
    },
    open: function (url) {
      rhSession().then(function (id) { iframe.src = '/' + id + '/' + url; }, function (e) { loading(false); toast(e.message || 'could not open that address'); });
    },
    back: function () { try { iframe.contentWindow.history.back(); } catch (e) { /* cross-origin or gone */ } },
    forward: function () { try { iframe.contentWindow.history.forward(); } catch (e) { /* cross-origin or gone */ } },
    reload: function () { try { iframe.contentWindow.location.reload(); } catch (e) { /* cross-origin or gone */ } },
    ready: function () { return !!rhId; }
  };

  var engine = which === 'rammerhead' ? rhEngine : scramjetEngine;

  function registerSw() {
    return navigator.serviceWorker.register('/proxy/sw.js', { scope: '/proxy/', updateViaCache: 'none' })
      .then(function (reg) {
        return navigator.serviceWorker.ready.then(function () {
          if (reg.active) return reg.active;
          var sw = reg.installing || reg.waiting;
          return new Promise(function (ok) {
            sw.addEventListener('statechange', function () { if (sw.state === 'activated') ok(sw); });
          });
        });
      });
  }

  function boot(key) {
    return registerSw().then(function (sw) {
      return loadScript('/proxy/sj/scramjet.js')
        .then(function () { return loadScript('/proxy/sj/controller.api.js'); })
        .then(function () { return loadScript('/proxy/sj/scramjet-utils.js'); })
        .then(function () { return loadScript('/proxy/sj/libcurl.js'); })
        .then(function () {
          var api = window.$scramjetController;
          api.config.prefix = '/proxy/~/';
          api.config.injectPath = '/proxy/sj/controller.inject.js';
          api.config.wasmPath = '/proxy/sj/scramjet.wasm';
          api.config.scramjetPath = '/proxy/sj/scramjet.js';
          var transport = new window.LibcurlTransport.LibcurlClient({ wisp: wispUrl(key) });
          var controller = new api.Controller({ serviceworker: sw, transport: transport });
          return controller.wait().then(function () { return controller; });
        });
    }).then(function (controller) {
      var u = window.$scramjetUtils;
      frame = controller.createFrame(iframe, {
        plugins: [
          new u.HttpCachePlugin(),
          new u.UrlWatcherPlugin(function (url) {
            url = String(url);
            stayHome(url);
            if (document.activeElement === input || url === addr) return;
            showAddr(url);
            if (!root.classList.contains('p-loading')) loading(true, 1200);
          }),
          // "open in new tab" and window.open come back into this shell
          new u.CatchEscapedLinksPlugin(function (url) {
            return new URL('/proxy/?go=' + encodeURIComponent(url.href), location.origin);
          })
        ]
      });
      return frame;
    });
  }

  function showStart() {
    root.classList.remove('browsing');
    loading(false);
    iframe.hidden = true;
    iframe.removeAttribute('src');
    start.hidden = false;
    back.disabled = fwd.disabled = reload.disabled = true;
    settleAddr();
    addr = '';
    setCrumb('');
    input.value = '';
    input.focus();
    if (window.fx) { window.fx.rain.resume(); window.fx.decode(title, { duration: 520 }); }
  }

  function open(raw) {
    var url = toUrl(raw);
    if (!url) return;
    input.blur();
    showAddr(url);
    if (!engine.ready()) { pending = url; return; }
    iframe.hidden = false;
    if (only) watchOnly(); else showFrame();
    back.disabled = fwd.disabled = reload.disabled = false;
    loading(true);
    engine.open(url);
  }

  function showFrame() {
    start.hidden = true;
    root.classList.add('browsing');
    if (window.fx) window.fx.rain.pause();
  }

  /* ---------- media/: one site, reloaded once, then shown ---------- */

  // The frame's document, once it is the site's (not the empty first page).
  function frameDoc() {
    try {
      var d = iframe.contentDocument;
      return d && d.location.href !== 'about:blank' ? d : null;
    } catch (e) { return null; }
  }

  // The frame stays on the one site. Its ads can send the whole page to an ad (a
  // "tab-under": in a normal browser the site moves to a new tab and the old tab
  // shows the ad, but here there is only the one), which then loads forever. Any
  // page off the site's own host is left at once for the last page that was on it.
  var onlyHost = only ? new URL(only).hostname.replace(/^www\./, '') : '';
  var lastHome = only, bouncedAt = 0;
  function stayHome(url) {
    if (!onlyHost || !/^https?:/i.test(url || '')) return;
    var host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return; }
    if (host === onlyHost || host.slice(-onlyHost.length - 1) === '.' + onlyHost) { lastHome = url; return; }
    if (Date.now() - bouncedAt < 3000) return; // one at a time, never a loop
    bouncedAt = Date.now();
    toast('skipped an ad');
    engine.open(lastHome);
  }

  var firstDoc = null, seen = null, seenAt = 0, watchTimer = 0, giveUp = 0;
  function watchOnly() {
    say('loading ' + new URL(only).hostname.replace(/^www\./, ''), false, true);
    clearInterval(watchTimer);
    watchTimer = setInterval(function () {
      var d = frameDoc();
      if (!d || d.readyState === 'loading') return;
      if (!firstDoc) {
        // the site has just loaded (or sat half-loaded for 5 s): once more,
        // now that everything is warm
        if (d !== seen) { seen = d; seenAt = Date.now(); }
        if (d.readyState !== 'complete' && Date.now() - seenAt < 5000) return;
        firstDoc = d;
        say('almost there', false, true);
        engine.reload();
      } else if (d !== firstDoc) {
        reveal();
      }
    }, 120);
    // a site that never finishes loading still shows, as it is
    giveUp = setTimeout(reveal, 25000);
  }

  function reveal() {
    clearInterval(watchTimer);
    clearTimeout(giveUp);
    loading(false);
    showFrame();
    try { iframe.focus(); } catch (e) { /* gone */ }
  }

  /* ---------- quick links ---------- */

  function piece(tag, cls, text, parent) {
    var el = document.createElement(tag);
    el.className = cls;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  // the same line arrow the menu rows use
  var SVG = 'http://www.w3.org/2000/svg';
  function arrow(parent) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    var path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M3 12h16M13.5 6.5 19 12l-5.5 5.5');
    svg.appendChild(path);
    parent.appendChild(svg);
  }

  // terminal tiles: index, [ name ], host, arrow; keys 1-6 open them
  function buildQuick() {
    QUICK.forEach(function (q, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p-q';
      b.setAttribute('aria-label', q[0]);
      b.setAttribute('data-cursor', 'open');
      b.style.setProperty('--i', i);
      piece('span', 'p-q-i', (i < 9 ? '0' : '') + (i + 1), b).setAttribute('aria-hidden', 'true');
      var n = piece('span', 'p-q-n', '', b);
      piece('span', 'p-q-b', '[', n);
      piece('span', 'p-q-t', q[0], n).setAttribute('data-scramble', '');
      piece('span', 'p-q-b', ']', n);
      piece('span', 'p-q-h', new URL(q[1]).hostname.replace(/^www\./, ''), b);
      var a = piece('span', 'p-q-a', '', b);
      a.setAttribute('aria-hidden', 'true');
      arrow(a);
      b.addEventListener('click', function () { open(q[1]); });
      quick.appendChild(b);
    });
  }

  function showQuick() {
    quick.hidden = false;
    if (!window.fx) return;
    var names = quick.querySelectorAll('.p-q-t');
    for (var i = 0; i < names.length; i++) window.fx.decode(names[i], { delay: 120 + i * 70, duration: 420 });
    window.fx.glitch(title);
  }

  function connect(key) {
    say('connecting', false, true);
    return engine.connect(key).then(function () {
      if (!only) say('search, or type a web address above.');
      showQuick();
      if (pending) { var p = pending; pending = null; open(p); }
    }, function (err) {
      say('the proxy could not start: ' + (err && err.message || 'unknown error'), true);
    });
  }

  function askKey(wrong) {
    keyForm.hidden = false;
    say(wrong ? 'that key did not work.' : 'locked', !!wrong);
    keyForm.classList.remove('is-wrong');
    if (wrong) {
      void keyForm.offsetWidth; // restart the shake
      keyForm.classList.add('is-wrong');
    }
    keyIn.value = '';
    keyIn.focus();
  }

  function init() {
    buildQuick();

    if (engine === scramjetEngine && (!('serviceWorker' in navigator) || !window.isSecureContext)) {
      say('this browser cannot run the standard mode here. try safari mode (top right).', true);
      return;
    }

    // config.json only exists on our own server, not on a static host
    fetch('/proxy/config.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('static');
      return r.json();
    }).then(function (cfg) {
      if (!cfg.key) return connect('');
      var saved = store('p-key');
      if (!saved) return askKey(false);
      return engine.check(saved).then(function (ok) {
        if (ok) return connect(saved);
        store('p-key', null);
        askKey(true);
      });
    }).catch(function () {
      say('the proxy only works on the main server, not on this mirror.', true);
    });
  }

  keyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var k = keyIn.value.trim();
    if (!k) return;
    say('checking', false, true);
    engine.check(k).then(function (ok) {
      if (!ok) return askKey(true);
      store('p-key', k);
      keyForm.hidden = true;
      connect(k);
    }, function (e) { say(e.message || 'could not check the key', true); });
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); settleAddr(); open(input.value); });
  input.addEventListener('focus', function () { settleAddr(); input.select(); });
  iframe.addEventListener('load', function () { loading(false); });
  back.addEventListener('click', function () { if (engine.ready()) { loading(true, 8000); engine.back(); } });
  fwd.addEventListener('click', function () { if (engine.ready()) { loading(true, 8000); engine.forward(); } });
  reload.addEventListener('click', function () { if (engine.ready()) { loading(true); engine.reload(); } });

  // on the start screen: 1-6 open a quick link, / jumps to the address bar
  document.addEventListener('keydown', function (e) {
    if (only || start.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === '/') { e.preventDefault(); input.focus(); return; }
    var n = Number(e.key);
    if (!quick.hidden && n >= 1 && n <= QUICK.length) {
      var b = quick.children[n - 1];
      b.focus();
      open(QUICK[n - 1][1]);
    }
  });
  el('p-home', 'button').addEventListener('click', showStart);
  el('p-full', 'button').addEventListener('click', function () {
    var el = iframe.hidden ? root : iframe;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  });

  // /proxy/?go=<url> opens straight away (used for escaped links); media/ opens its site
  var go = new URLSearchParams(location.search).get('go');
  if (only) {
    pending = only;
  } else if (go) {
    history.replaceState(null, '', location.pathname);
    pending = toUrl(go);
    addr = input.value = pending;
  }
  init();
})();
