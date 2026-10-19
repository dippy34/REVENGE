/* proxy.js: the browser shell around Scramjet. The page registers the
   service worker, loads Scramjet and the libcurl transport from /proxy/sj/,
   and opens sites in an iframe. All traffic leaves through /proxy/wisp/
   on this same server. Works only on the server in server/, not on a
   static host. */
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
    if (!frame) { pending = url; return; }
    start.hidden = true;
    iframe.hidden = false;
    root.classList.add('browsing');
    back.disabled = fwd.disabled = reload.disabled = false;
    try { frame.go(url); } catch (e) { toast('could not open that address'); }
  }

  function connect(key) {
    say('connecting');
    return boot(key).then(function () {
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

    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      say('this browser cannot run the proxy here (it needs https).', true);
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
      return tryKey(saved).then(function (ok) {
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
    tryKey(k).then(function (ok) {
      if (!ok) return askKey(true);
      store('p-key', k);
      keyForm.hidden = true;
      connect(k);
    });
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); open(input.value); });
  input.addEventListener('focus', function () { input.select(); });
  back.addEventListener('click', function () { if (frame) frame.back(); });
  fwd.addEventListener('click', function () { if (frame) frame.forward(); });
  reload.addEventListener('click', function () { if (frame) frame.reload(); });
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
