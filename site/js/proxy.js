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
   Works only on the server in server/, not on a static host. */
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
  var form = document.getElementById('p-form');
  var input = document.getElementById('p-url');
  var start = document.getElementById('p-start');
  var status = document.getElementById('p-status');
  var quick = document.getElementById('p-quick');
  var keyForm = document.getElementById('p-key');
  var keyIn = document.getElementById('p-key-in');
  var iframe = document.getElementById('p-frame');
  var back = document.getElementById('p-back');
  var fwd = document.getElementById('p-fwd');
  var reload = document.getElementById('p-reload');
  var toastEl = document.getElementById('p-toast');

  var frame = null;
  var pending = null; // a url asked for before we were ready

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked */ }
    return null;
  }

  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2600);
  }

  function say(msg, bad) {
    status.textContent = msg;
    status.classList.toggle('is-bad', !!bad);
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
    open: function (url) { try { frame.go(url); } catch (e) { toast('could not open that address'); } },
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
          if (cur && document.activeElement !== input && input.value !== cur) input.value = cur;
        }, 600);
      });
    },
    open: function (url) {
      rhSession().then(function (id) { iframe.src = '/' + id + '/' + url; }, function (e) { toast(e.message || 'could not open that address'); });
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
            if (document.activeElement !== input) input.value = url;
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
    iframe.hidden = true;
    iframe.removeAttribute('src');
    start.hidden = false;
    back.disabled = fwd.disabled = reload.disabled = true;
    input.value = '';
    input.focus();
  }

  function open(raw) {
    var url = toUrl(raw);
    if (!url) return;
    input.value = url;
    input.blur();
    if (!engine.ready()) { pending = url; return; }
    start.hidden = true;
    iframe.hidden = false;
    root.classList.add('browsing');
    back.disabled = fwd.disabled = reload.disabled = false;
    engine.open(url);
  }

  function connect(key) {
    say('connecting');
    return engine.connect(key).then(function () {
      say('search, or type a web address above.');
      quick.hidden = false;
      if (pending) { var p = pending; pending = null; open(p); }
    }, function (err) {
      say('the proxy could not start: ' + (err && err.message || 'unknown error'), true);
    });
  }

  function askKey(wrong) {
    keyForm.hidden = false;
    say(wrong ? 'that key did not work.' : 'locked', !!wrong);
    keyIn.value = '';
    keyIn.focus();
  }

  function init() {
    QUICK.forEach(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p-btn';
      b.textContent = q[0];
      b.addEventListener('click', function () { open(q[1]); });
      quick.appendChild(b);
    });

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
    say('checking');
    engine.check(k).then(function (ok) {
      if (!ok) return askKey(true);
      store('p-key', k);
      keyForm.hidden = true;
      connect(k);
    }, function (e) { say(e.message || 'could not check the key', true); });
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); open(input.value); });
  input.addEventListener('focus', function () { input.select(); });
  back.addEventListener('click', function () { engine.back(); });
  fwd.addEventListener('click', function () { engine.forward(); });
  reload.addEventListener('click', function () { engine.reload(); });
  document.getElementById('p-home').addEventListener('click', showStart);
  document.getElementById('p-full').addEventListener('click', function () {
    var el = iframe.hidden ? root : iframe;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  });

  // /proxy/?go=<url> opens straight away (used for escaped links)
  var go = new URLSearchParams(location.search).get('go');
  if (go) {
    history.replaceState(null, '', location.pathname);
    pending = toUrl(go);
    input.value = pending;
  }
  init();
})();
