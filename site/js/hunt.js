/* hunt.js: the client side of the signal (docs/07-hunt.md). Loaded with
   defer on every page and on /rx/. Generic: every word a player reads
   comes from the server; nothing here knows any stage's content.

   Inert unless a frequency is live or a receiver (pass) is stored: then
   it makes no requests beyond one status check, changes nothing in the
   page and listens to nothing but the session event recorder.

     window.hunt          the stable API for pages (CONTRACT 12.3)
     window.huntQ         functions queued before this ran: fn(hunt)
     window.huntEvQ       event codes queued before this ran
     window 'hunt:ready'  once the status is known (detail: the API)
     window 'hunt:cert'   after a certificate check changed the result

   Storage (all optional, all wrapped): localStorage hunt.<kind>.<f>,
   sessionStorage hunt.st (status cache), hunt.ev (event ring), hunt.cv
   (certificate check cache). Passes, certificates and codes only ever
   travel in POST bodies. textContent only, never innerHTML. */
(function () {
  'use strict';

  // production Ed25519 public key (base64url, public); written by
  // tools/hunt-keys.mjs --write-pub
  var PUB = '';

  var root = document.documentElement;
  var page = root.getAttribute('data-page') || '';
  var API = '/api/hunt/';
  var BASE = (function () {
    try { return new URL('../', document.currentScript.src).href; } catch (e) { return '/'; }
  })();
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var mqCoarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };

  var loadT = Date.now();
  var F_RE = /^(freq|int)-\d{2}[a-z]?$/;
  var B64U = /^[A-Za-z0-9_-]*$/;

  // engine defaults (CONTRACT 7.8), used only when no answer came back
  var SAY = {
    limit: 'the air is saturated. try again later.',
    lost: 'that did not come through.',
    nopass: 'no receiver.',
    off: 'the band is empty.',
    invalid: 'that did not come through.'
  };

  function noop() {}
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function make(tag, cls, parent, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function reduced() {
    var f = window.fx;
    return f && f.reduced ? f.reduced() : !!mqReduce.matches;
  }
  function later(ms, fn) { return setTimeout(fn, ms); }

  /* ---------- storage ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try {
      if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      return true;
    } catch (e) { return false; }
  }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) {
    try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* blocked */ }
  }
  function parse(s) { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
  function lsJson(k) { return parse(lsGet(k)); }
  function lsPut(k, v) { return lsSet(k, v == null ? null : JSON.stringify(v)); }
  function ssJson(k) { return parse(ssGet(k)); }
  function ssPut(k, v) { ssSet(k, v == null ? null : JSON.stringify(v)); }
  function lsKeys(prefix) {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) { /* blocked */ }
    return out;
  }

  /* ---------- bytes, base64url, canonical JSON, hashes ---------- */

  function utf8(s) {
    if (window.TextEncoder) return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function unutf8(b) {
    if (window.TextDecoder) return new TextDecoder('utf-8', { fatal: true }).decode(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  }
  function b64uDec(s) {
    if (typeof s !== 'string' || !B64U.test(s) || s.length % 4 === 1) return null;
    var t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    try {
      var bin = atob(t), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  function b64uEnc(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function hexOf(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function hexBytes(h) {
    if (!/^([0-9a-f]{2})*$/.test(h)) return null;
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  // canonical JSON (CONTRACT 4.1): sorted keys, no whitespace, integers only
  function canon(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') {
      if (!isFinite(v) || Math.floor(v) !== v || Math.abs(v) > 9007199254740991) throw new Error('canon');
      return String(v);
    }
    if (t === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (t === 'object') {
      var ks = Object.keys(v).sort(), parts = [];
      for (var i = 0; i < ks.length; i++) {
        if (v[ks[i]] === undefined) throw new Error('canon');
        parts.push(JSON.stringify(ks[i]) + ':' + canon(v[ks[i]]));
      }
      return '{' + parts.join(',') + '}';
    }
    throw new Error('canon');
  }
  function subtle() { return window.crypto && window.crypto.subtle ? window.crypto.subtle : null; }
  function sha256hex(s) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('nocrypto'));
    return c.digest('SHA-256', typeof s === 'string' ? utf8(s) : s).then(hexOf);
  }
  function hmacHex(keyBytes, msg) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('nocrypto'));
    return c.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) {
      return c.sign('HMAC', k, utf8(msg));
    }).then(hexOf);
  }

  // a signed token's payload, without checking the signature
  function tokenPayload(str, prefix) {
    if (typeof str !== 'string') return null;
    var p = str.split('.');
    if (p.length !== 3 || p[0] !== prefix || !p[1] || !p[2]) return null;
    var raw = b64uDec(p[1]);
    if (!raw || !b64uDec(p[2])) return null;
    var obj;
    try { obj = JSON.parse(unutf8(raw)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || obj.v !== 1 || !F_RE.test(obj.f || '')) return null;
    return obj;
  }
  function passPayload(str) {
    var p = tokenPayload(str, 'p1');
    return p && p.k === 'pass' && typeof p.id === 'string' ? p : null;
  }
  function certPayload(str) {
    var p = tokenPayload(str, 'c1');
    return p && p.k === 'cert' ? p : null;
  }

  /* ---------- the session event ring (CONTRACT 9.2) ---------- */

  var AREAS = ['menu', 'yt', 'games', 'proxy', 'stats', '404', 'ghost'];
  var EGGS = ['shatter', 'ghost', 'console', 'konami', 'matrix', 'hello', 'digest', 'roll', 'askew',
    'snake', 'idle', 'clock', 'jelly', 'rm', 'reel'];
  var TINTS = ['mono', 'green', 'pink', 'cyan', 'amber', 'violet', 'chaos', 'gold', 'signal'];
  var TIERS = ['high', 'mid', 'low'];
  var CMDS = ['help', 'eggs', 'clear', 'tint', 'fx', 'matrix', 'ghost', 'talk', 'ai', 'wake', 'reboot',
    'whoami', 'date', 'sudo', 'exit', 'ls', 'cd', 'cat', 'echo', 'hello', 'rm', 'history'];
  var ALIAS = { '?': 'help', cls: 'clear', su: 'sudo', quit: 'exit', q: 'exit', hi: 'hello' };
  var ARGS = {
    ls: ['-a', '-la', '-al'],
    cd: ['~', '/', '..', 'youtube', 'games', 'proxy', '.ghost', 'ghost'],
    fx: ['high', 'mid', 'low', 'auto'],
    tint: TINTS
  };
  var ROUTES = ['start', 'home', 'shorts', 'watch', 'search', 'channel', 'subs', 'library'];
  var FIXED = ['game:open', 'game:close', 'proxy:browse', 'proxy:home', 'stats:refused',
    'ghost:clear', 'ghost:help', 'ghost:whoami', 'ghost:exit', 'ghost:signal', 'ghost:turn',
    'saver:on', 'saver:off', 'snake:start', 'snake:over', 'vis:hidden', 'vis:shown'];
  var CLS = ['playing', 'browsing', 'egg-askew', 'egg-roll', 'egg-rm', 'egg-wobble', 'egg-rev', 'egg-quake'];

  function has(arr, v) { return arr.indexOf(v) >= 0; }

  // the known form of a code, or null
  function evCode(code) {
    if (typeof code !== 'string' || code.length > 32) return null;
    var p = code.split(':');
    switch (p[0]) {
      case 'nav': return p.length === 2 && (has(AREAS, p[1]) || p[1] === 'rx') ? code : null;
      case 'egg': return p.length === 2 && has(EGGS, p[1]) ? code : null;
      case 'tint': return p.length === 2 && has(TINTS, p[1]) ? code : null;
      case 'fx': return p.length === 2 && has(TIERS, p[1]) ? code : null;
      case 'route': return p.length === 2 && has(ROUTES, p[1]) ? code : null;
      case 'cmd': {
        if (p.length < 2) return null;
        var name = own(ALIAS, p[1]) ? ALIAS[p[1]] : p[1];
        if (!has(CMDS, name)) return null;
        if (p.length === 2) return 'cmd:' + name;
        var arg = p.slice(2).join(':');
        return own(ARGS, name) && has(ARGS[name], arg) ? 'cmd:' + name + ':' + arg : null;
      }
      case 'snake': {
        if (p.length !== 2) return null;
        if (p[1] === 'start' || p[1] === 'over') return code;
        var n = /^\d{1,2}$/.test(p[1]) ? +p[1] : -1;
        return n >= 5 && n <= 95 && n % 5 === 0 ? 'snake:' + n : null;
      }
      default: return has(FIXED, code) ? code : null;
    }
  }

  var ringMem = null;
  var pageCount = { cmd: 0, turn: 0, back: 0 };
  function ring() {
    var r = ssJson('hunt.ev');
    if (!Array.isArray(r)) r = ringMem || [];
    return r.filter(function (c) { return evCode(c) === c; }).slice(-24);
  }
  function event(code) {
    var c = evCode(code);
    if (!c) return;
    var r = ring();
    r.push(c);
    r = r.slice(-24);
    ringMem = r;
    ssPut('hunt.ev', r);
    if (c.indexOf('cmd:') === 0) pageCount.cmd++;
    else if (c === 'ghost:turn') pageCount.turn++;
    else if (c === 'vis:shown') pageCount.back++;
    probeSoon();
  }

  /* ---------- status (CONTRACT 8.1, 12.1) ---------- */

  var S = {
    status: null,     // the last status body
    at: 0,            // local time it was fetched
    skew: 0,          // hunt clock minus local clock
    speed: 1,         // sandbox clock speed estimate
    known: false,
    fns: [],
    block: {},        // endpoint -> local time until which it is backed off
    cv: {},           // f -> verified cert payload | null
    cvDone: false
  };

  function huntNow() {
    var st = S.status;
    if (!st || typeof st.now !== 'number') return Date.now();
    if (S.speed !== 1) return st.now + (Date.now() - S.at) * S.speed;
    return Date.now() + S.skew;
  }

  function liveList() {
    var st = S.status;
    if (!st || !st.on || !Array.isArray(st.live)) return [];
    return st.live.filter(function (l) { return l && F_RE.test(l.f || ''); }).sort(function (a, b) {
      return (b.n | 0) - (a.n | 0);
    });
  }
  function coldList() {
    var st = S.status;
    if (!st || !st.on || !Array.isArray(st.cold)) return [];
    return st.cold.filter(function (c) { return c && F_RE.test(c.f || ''); }).sort(function (a, b) {
      return (b.n | 0) - (a.n | 0);
    });
  }
  function live() { return liveList().length > 0; }
  function newest() { return liveList()[0] || null; }

  function passFor(f) { return f ? lsGet('hunt.pass.' + f) : null; }
  function storedPassFs() {
    return lsKeys('hunt.pass.').map(function (k) { return k.slice(10); }).filter(function (f) { return F_RE.test(f); });
  }
  // the frequency whose receiver we use: newest live with a pass, then cold
  function curF() {
    var l = liveList(), c = coldList(), i;
    for (i = 0; i < l.length; i++) if (passFor(l[i].f)) return l[i].f;
    for (i = 0; i < c.length; i++) if (passFor(c[i].f)) return c[i].f;
    return null;
  }
  function storePass(str) {
    var p = passPayload(str);
    if (!p) return null;
    lsSet('hunt.pass.' + p.f, str);
    return p;
  }
  function storeCert(str) {
    var p = certPayload(str);
    if (!p) return null;
    lsSet('hunt.cert.' + p.f, str);
    verifyAll();
    return p;
  }

  function setStatus(body, at) {
    S.status = body && typeof body === 'object' ? body : { v: 1, on: false };
    S.at = at;
    S.skew = typeof S.status.now === 'number' ? S.status.now - at : 0;
  }

  function markKnown() {
    if (S.known) return;
    S.known = true;
    var fns = S.fns.splice(0);
    for (var i = 0; i < fns.length; i++) run(fns[i]);
    dispatch('hunt:ready', api);
    afterStatus();
  }
  function run(fn) { try { fn(api); } catch (e) { /* one hook failing must not stop the rest */ } }
  function ready(fn) {
    if (typeof fn !== 'function') return;
    if (S.known) run(fn); else S.fns.push(fn);
  }
  function dispatch(name, detail) {
    var ev;
    try { ev = new CustomEvent(name, { detail: detail }); } catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent(name, false, false, detail);
    }
    window.dispatchEvent(ev);
  }

  function retryAfter(res) {
    var s = parseInt(res.headers.get('retry-after'), 10);
    return (isFinite(s) && s > 0 ? Math.min(s, 3600) : 30) * 1000;
  }

  function getStatus(force) {
    var c = ssJson('hunt.st');
    if (!force && c && c.at && c.body) {
      var ttl = c.body.on && !c.err ? 120000 : 900000, age = Date.now() - c.at;
      if (age >= 0 && age < ttl) {
        setStatus(c.body, c.at);
        return Promise.resolve(S.status);
      }
    }
    if (S.block.status > Date.now()) return Promise.resolve(S.status || { v: 1, on: false });
    var at = Date.now();
    return fetch(API + 'status', { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      if (res.status === 429) {
        S.block.status = Date.now() + retryAfter(res);
        throw new Error('limit');
      }
      if (!res.ok) throw new Error('off');
      return res.json();
    }).then(function (body) {
      if (!body || body.v !== 1) throw new Error('off');
      var prevNow = S.status && S.status.now, prevAt = S.at;
      setStatus(body, at);
      // the sandbox clock may run faster than real time: estimate it
      if (body.sandbox && prevNow && Date.now() - prevAt > 5000) {
        var sp = (body.now - prevNow) / (at - prevAt);
        S.speed = isFinite(sp) && sp > 1.5 ? Math.round(sp * 10) / 10 : 1;
      } else if (!body.sandbox) S.speed = 1;
      ssPut('hunt.st', { at: at, body: body, ss: (c && c.ss) || null });
      return headStart(body, at);
    }).catch(function () {
      if (!S.status) setStatus({ v: 1, on: false }, at);
      ssPut('hunt.st', { at: at, body: S.status, err: 1 });
      return S.status;
    });
  }

  // inside the head-start window of the next frequency, and only then,
  // ask again with a qualifying certificate (CONTRACT 8.1)
  function headStart(body, at) {
    var nx = body && body.on && body.next;
    if (!nx || !F_RE.test(nx.f || '') || typeof nx.opensAt !== 'string') return Promise.resolve(body);
    var opens = Date.parse(nx.opensAt), hs = (nx.headStartHours | 0) * 3600000, t = huntNow();
    if (!(t >= opens - hs && t < opens)) return Promise.resolve(body);
    return qualifyingCert(nx.n | 0).then(function (cert) {
      if (!cert) return body;
      return post('status', { cert: cert }).then(function (b2) {
        if (b2 && b2.v === 1 && b2.on) {
          setStatus(b2, at);
          var c = ssJson('hunt.st') || {};
          ssPut('hunt.st', { at: at, body: b2, ss: c.ss || null });
        }
        return S.status;
      });
    });
  }
  function qualifyingCert(n) {
    return verifyAll().then(function () {
      var ks = Object.keys(S.cv);
      for (var i = 0; i < ks.length; i++) {
        var p = S.cv[ks[i]];
        if (p && p.n === n - 1 && p.kind === 'frequency' && !p.late) return lsGet('hunt.cert.' + ks[i]);
      }
      return null;
    });
  }

  /* ---------- calls ---------- */

  function post(ep, body, opts) {
    var key = ep.split('/')[0];
    if (S.block[key] > Date.now()) return Promise.resolve({ ok: false, error: 'limit', say: SAY.limit });
    var init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      credentials: 'same-origin'
    };
    if (opts && opts.keepalive) init.keepalive = true;
    return fetch(API + ep, init).then(function (res) {
      if (res.status === 429) S.block[key] = Date.now() + retryAfter(res);
      return res.json().catch(function () { return null; }).then(function (j) {
        if (j && typeof j === 'object') {
          if (res.status === 429) j.error = 'limit';
          return j;
        }
        if (res.status === 429) return { ok: false, error: 'limit', say: SAY.limit };
        if (res.status === 404) return { ok: false, error: 'off', say: SAY.off };
        return { ok: false, error: 'lost', say: SAY.lost };
      });
    }, function () {
      return { ok: false, error: 'lost', say: SAY.lost };
    });
  }

  // re-issued passes and certificates are kept; anything that changes
  // progress drops the cached state summary
  function absorb(j) {
    if (!j || typeof j !== 'object') return j;
    if (typeof j.pass === 'string') storePass(j.pass);
    if (typeof j.cert === 'string') storeCert(j.cert);
    if (j.pass || j.unlocked || j.result === 'correct' || j.result === 'cleared' || j.result === 'took') dropState();
    return j;
  }

  function call(ep, body, opts) {
    body = body || {};
    if (!own(body, 'pass')) {
      var p = passFor((opts && opts.f) || curF());
      if (p) body.pass = p;
    }
    return post(ep, body, opts).then(absorb);
  }

  /* ---------- cached state summary (for probes and the 404 hook) ---------- */

  function stateSum(f) {
    var c = ssJson('hunt.st');
    var s = c && c.ss;
    return s && s.f === f && Date.now() - s.at < 300000 && Date.now() >= s.at ? s : null;
  }
  function putState(f, j) {
    var c = ssJson('hunt.st');
    if (!c) return;
    c.ss = {
      f: f,
      at: Date.now(),
      stages: (j.stages || []).map(function (s) { return { id: s.id, type: s.type, state: s.state }; })
    };
    ssPut('hunt.st', c);
  }
  function dropState() {
    var c = ssJson('hunt.st');
    if (c && c.ss) { c.ss = null; ssPut('hunt.st', c); }
  }
  function getState(f, force) {
    f = f || curF();
    if (!f) return Promise.resolve(null);
    if (!force) {
      var s = stateSum(f);
      if (s) return Promise.resolve(s);
    }
    return call('state', {}, { f: f }).then(function (j) {
      if (!j || !j.ok) return null;
      putState(f, j);
      api._u.lastState = j;
      return stateSum(f) || { f: f, stages: j.stages || [] };
    });
  }
  function openOf(sum, type) {
    if (!sum) return null;
    for (var i = 0; i < sum.stages.length; i++) {
      var s = sum.stages[i];
      if (s.type === type && s.state === 'open') return s;
    }
    return null;
  }

  /* ---------- certificates (CONTRACT 12.4) ---------- */

  function loopback() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  }
  // which key checks certificates on this page: the production key, or the
  // status's sandbox key on a loopback host
  function keyNow() {
    var st = S.status;
    if (st && st.sandbox === true && loopback() && typeof st.pub === 'string' && st.pub.length === 43) {
      return { pub: st.pub, sb: true };
    }
    return { pub: PUB, sb: false };
  }

  var verifying = null;
  function verifyAll() {
    if (verifying) return verifying;
    var ks = lsKeys('hunt.cert.');
    var prev = JSON.stringify(S.cv);
    var next = {};
    var jobs = ks.map(function (k) {
      var f = k.slice(10);
      return verifyCert(lsGet(k)).then(function (p) { if (p && p.f === f) next[f] = p; else next[f] = null; });
    });
    verifying = Promise.all(jobs).then(function () {
      S.cv = next;
      S.cvDone = true;
      verifying = null;
      if (JSON.stringify(next) !== prev) dispatch('hunt:cert', api);
    }, function () { verifying = null; });
    return verifying;
  }

  function verifyCert(str) {
    var p = certPayload(str);
    if (!p) return Promise.resolve(null);
    var seg = str.split('.');
    var k = keyNow();
    try {
      if (b64uEnc(utf8(canon(p))) !== seg[1]) return Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
    if (k.sb ? p.sb !== 1 : own(p, 'sb')) return Promise.resolve(null);
    var cache = ssJson('hunt.cv') || {};
    return sha256hex(k.pub + '|' + str).then(function (h) {
      if (own(cache, h)) return cache[h] ? p : null;
      return checkSig(k.pub, seg, str).then(function (ok) {
        cache = ssJson('hunt.cv') || {};
        cache[h] = ok ? 1 : 0;
        ssPut('hunt.cv', cache);
        return ok ? p : null;
      });
    }, function () {
      // no WebCrypto here at all (an insecure context): the server checks
      return serverVerify(str).then(function (ok) { return ok ? p : null; });
    });
  }

  function checkSig(pub, seg, str) {
    var c = subtle(), key = b64uDec(pub), sig = b64uDec(seg[2]);
    if (!c || !key || key.length !== 32 || !sig) return serverVerify(str);
    var data = utf8('da|c1|' + seg[1]);
    var imported;
    try {
      imported = c.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    } catch (e) { return serverVerify(str); }
    return imported.then(function (kk) {
      return c.verify({ name: 'Ed25519' }, kk, sig, data).then(function (ok) { return !!ok; }, function () { return false; });
    }, function () {
      // older engines without Ed25519 in WebCrypto
      return serverVerify(str);
    });
  }
  function serverVerify(str) {
    return post('verify', { cert: str }).then(function (j) {
      return !!(j && j.ok && j.payload && j.payload.k === 'cert');
    });
  }

  function solver() {
    var n = 0, gold = false;
    Object.keys(S.cv).forEach(function (f) {
      var p = S.cv[f];
      if (!p) return;
      n++;
      if (p.unlit === 1 && !p.late) gold = true;
    });
    return { any: n > 0, gold: gold, n: n };
  }
  function certOf(f) { return f && S.cv[f] ? S.cv[f] : null; }

  /* ---------- the API's small helpers ---------- */

  function tell(surface) {
    var st = S.status;
    if (!live() || !st.tells || !own(st.tells, surface)) return null;
    return st.tells[surface] || null;
  }
  function lines(where) {
    var st = S.status;
    if (!live() || !st) return [];
    var ln = st.lines || {}, out = [];
    var errata = Array.isArray(ln.errata) ? ln.errata : [], drip = Array.isArray(ln.drip) ? ln.drip : [];
    if (where === '404') {
      var t = tell('e404');
      if (t) out.push(t);
      out = out.concat(errata, drip);
    } else if (where === 'boot') {
      out = drip.slice();
    }
    return out.filter(function (s) { return typeof s === 'string' && s; });
  }
  function shape() {
    var st = S.status;
    if (!live() || !st.door || typeof st.door.shape !== 'string') return null;
    try { return new RegExp(st.door.shape); } catch (e) { return null; }
  }

  function goTo(href) {
    var a = make('a', null, document.body);
    a.href = href;
    a.hidden = true;
    a.click();
    later(0, function () { if (a.parentNode) a.parentNode.removeChild(a); });
  }
  function goRx() { goTo(BASE + 'rx/'); }

  function door(line) {
    var st = S.status, d = st && st.door;
    if (!d || !live()) return Promise.resolve({ ok: false, say: SAY.off });
    var body = { line: String(line || '').slice(0, 200) };
    var l = liveList().filter(function (x) { return x.f === d.f; })[0];
    var go = l && l.early ? qualifyingCert(l.n | 0) : Promise.resolve(null);
    return go.then(function (cert) {
      if (cert) body.cert = cert;
      return post('door', body);
    }).then(function (j) {
      j = j || {};
      if (j.ok && typeof j.pass === 'string' && storePass(j.pass)) {
        dropState();
        later(900, goRx);
        return { ok: true, say: j.say || '' };
      }
      return { ok: false, say: j.say || SAY.lost };
    });
  }

  function code() {
    var p = passPayload(passFor(curF()) || '');
    return p ? p.id : null;
  }
  function recover(c) {
    var clean = String(c || '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9_-]{22}$/.test(clean)) return Promise.resolve({ ok: false, say: SAY.invalid });
    return post('recover', { code: clean }).then(function (j) {
      j = j || {};
      if (j.ok && typeof j.pass === 'string' && storePass(j.pass)) {
        dropState();
        return { ok: true, say: j.say || '' };
      }
      return { ok: false, say: j.say || SAY.invalid };
    });
  }

  function signal(text) {
    var f = curF();
    if (!f) return Promise.resolve({ result: 'nopass', say: SAY.nopass, lines: [] });
    return call('answer', { text: String(text || '').slice(0, 200) }, { f: f }).then(function (j) {
      j = j || {};
      var ls = Array.isArray(j.lines) ? j.lines.filter(function (s) { return typeof s === 'string'; }) : [];
      if (j.result === 'warm' && ls.length) lsPut('hunt.gloss.' + f, ls);
      return { result: j.result || j.error || 'lost', say: j.say || SAY.lost, lines: ls, stage: j.stage || null, unlocked: j.unlocked || [] };
    });
  }

  function report() {
    var f = curF();
    if (!f) return Promise.resolve([SAY.nopass]);
    return call('state', {}, { f: f }).then(function (j) {
      if (!j || !j.ok) return [(j && j.say) || SAY.lost];
      putState(f, j);
      var head = (j.title || f) + ' · day ' + j.day + (j.late ? ' · late' : '') + (j.sandbox ? ' · sandbox' : '');
      var out = [head];
      (j.stages || []).forEach(function (s) {
        var t = s.id + '  ' + (s.title || '—') + '  ';
        if (s.state === 'solved') t += 'received, day ' + s.solved;
        else if (s.state === 'open') t += 'open' + (s.answers && typeof s.answers.left === 'number' ? ', ' + s.answers.left + ' left today' : '');
        else t += 'nothing yet';
        out.push(t);
      });
      if (j.floor && !j.floor.ok && typeof j.floor.day === 'number') out.push('the last step waits for day ' + j.floor.day);
      out.push('the receiver: /rx/');
      return out;
    });
  }

  function whoami() {
    var s = solver();
    if (!s.any) return null;
    return 'a listener. ' + (s.n === 1 ? 'one frequency' : s.n + ' frequencies') + ' received' + (s.gold ? ', unlit.' : '.');
  }
  function eggRow() {
    var l = newest();
    var t = tell('eggs16');
    if (l && t) return { label: t, done: !!certOf(l.f) };
    var fs = Object.keys(S.cv).filter(function (f) { return S.cv[f]; }).sort();
    if (fs.length) return { label: fs[fs.length - 1].replace('-', ' ') + ' received', done: true };
    return null;
  }

  /* ---------- stylesheet and scripts on demand ---------- */

  var cssOn = false;
  function ensureCss() {
    if (cssOn || document.querySelector('link[data-hunt]')) { cssOn = true; return; }
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = BASE + 'css/hunt.css';
    l.setAttribute('data-hunt', '');
    document.head.appendChild(l);
    cssOn = true;
  }
  var scripts = {};
  function loadScript(name, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (scripts[name]) return scripts[name];
    scripts[name] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = BASE + 'js/' + name;
      s.async = true;
      s.onload = function () { if (!globalName || window[globalName]) res(window[globalName]); else rej(new Error('missing')); };
      s.onerror = function () { delete scripts[name]; rej(new Error('missing')); };
      document.head.appendChild(s);
    });
    return scripts[name];
  }

  /* ---------- fragments drawn as ASCII hexes ---------- */

  // axial (q, r): one glyph per cell, rows staggered by half a cell
  function asciiHex(cells, blank) {
    if (!cells || !cells.length) return '';
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, i;
    var pts = [];
    for (i = 0; i < cells.length; i++) {
      var c = cells[i], x = (2 * c.q + c.r) * 2, y = c.r;
      pts.push([x, y, String(c.g == null ? '?' : c.g).charAt(0) || '?']);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    var rows = [];
    for (i = 0; i <= maxY - minY; i++) rows.push(new Array(maxX - minX + 2).join(' ').split(''));
    for (i = 0; i < pts.length; i++) rows[pts[i][1] - minY][pts[i][0] - minX] = pts[i][2];
    void blank;
    return rows.map(function (r) { return r.join('').replace(/\s+$/, ''); }).join('\n');
  }

  var AREA_NAME = { menu: 'menu', yt: 'youtube', games: 'games', proxy: 'proxy', stats: 'stats', '404': 'a dead end', ghost: 'ghost' };

  /* ---------- probes (CONTRACT 9.1, 9.4) ---------- */

  var P = {
    on: false, timer: 0, soon: 0, every: 15000, base: 15000, sent: [], shown: {}, f: null,
    lastInput: Date.now(), p4: null, busy: false
  };

  function probeStart(f) {
    if (P.on || page === 'rx' || !has(AREAS, page)) return;
    P.on = true;
    P.f = f;
    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (n) {
      window.addEventListener(n, function () { P.lastInput = Date.now(); }, { passive: true, capture: true });
    });
    if (page === '404') {
      var path = location.pathname.toLowerCase().replace(/\/+$/, '');
      sha256hex(path).then(function (h) { P.p4 = h.slice(0, 8); }, noop);
    }
    var wait = Math.max(0, 3000 - (Date.now() - loadT));
    P.timer = later(wait, probeTick);
  }
  function probeSoon() {
    if (!P.on) return;
    clearTimeout(P.soon);
    P.soon = later(1200, function () { probe(); });
  }
  function probeTick() {
    clearTimeout(P.timer);
    probe();
    P.timer = later(P.every, probeTick);
  }

  function int(v, a, b) { v = v | 0; return v < a ? a : v > b ? b : v; }
  function five(sec) { return Math.floor(int(sec, 0, 3600) / 5) * 5; }
  function shown(el) { return !!(el && !el.hidden && el.getClientRects().length); }

  function collect() {
    var f = { a: page };
    var tint = ssGet('fx.tint');
    f.tint = has(TINTS, tint) ? tint : 'mono';
    var t = root.getAttribute('data-fx');
    if (has(TIERS, t)) f.fx = t;
    f.rm = reduced() ? 1 : 0;
    f.ptr = mqCoarse.matches ? 'coarse' : 'fine';
    var w = window.innerWidth;
    f.vw = w < 400 ? 'xs' : w < 720 ? 's' : w < 1100 ? 'm' : 'l';
    f.or = window.innerHeight >= window.innerWidth ? 'p' : 'l';
    var eggs = parse(lsGet('eggs'));
    f.eggs = Array.isArray(eggs) ? eggs.filter(function (e, i) { return has(EGGS, e) && eggs.indexOf(e) === i; }) : [];
    f.dwell = five((Date.now() - loadT) / 1000);
    f.idle = five((Date.now() - P.lastInput) / 1000);
    f.vis = int(pageCount.back, 0, 20);
    var de = document.documentElement, max = Math.max(0, (de.scrollHeight || 0) - window.innerHeight);
    f.scr = max > 0 ? int(Math.floor((window.scrollY || 0) / max * 10), 0, 10) : 0;
    f.cls = CLS.filter(function (c) { return root.classList.contains(c); });
    f.saver = document.querySelector('.egg-saver') ? 1 : 0;
    f.con = document.querySelector('.egg-con.is-open') ? 1 : 0;
    f.cmdn = int(pageCount.cmd, 0, 50);
    f.snhi = int(parseInt(lsGet('eggs.snake'), 10) || 0, 0, 99);
    f.ev = ring();
    if (page === '404') {
      var box = document.querySelector('.egg-snake');
      var on = !!box && !box.classList.contains('is-over');
      f.snon = on ? 1 : 0;
      var sc = box && box.querySelector('.egg-snake-top b');
      f.snake = on && sc ? int(parseInt(sc.textContent, 10) || 0, 0, 99) : 0;
      if (P.p4) f.p4 = P.p4;
      f.p4n = int(location.pathname.split('/').filter(Boolean).length, 0, 9);
    } else if (page === 'yt') {
      var head = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
      if (has(ROUTES, head)) f.r = head;
    } else if (page === 'games') {
      f.gp = root.classList.contains('playing') ? 1 : 0;
      var favs = parse(lsGet('g-favs'));
      f.gfav = Array.isArray(favs) ? int(favs.length, 0, 50) : 0;
      var fb = document.getElementById('g-fav');
      f.gtab = fb && fb.getAttribute('aria-pressed') === 'true' ? 'fav' : 'all';
    } else if (page === 'proxy') {
      f.pb = root.classList.contains('browsing') ? 1 : 0;
      var pe = lsGet('p-engine');
      if (pe === 'scramjet' || pe === 'rammerhead') f.pe = pe === 'rammerhead' ? 'rh' : 'sj';
      else {
        var pill = document.getElementById('p-engine');
        var pt = pill ? pill.textContent.trim() : '';
        if (pt === 'standard mode') f.pe = 'sj';
        else if (pt === 'safari mode') f.pe = 'rh';
      }
    } else if (page === 'stats') {
      if (shown(document.getElementById('s-board'))) f.sk = 'board';
      else if (shown(document.getElementById('s-key'))) f.sk = 'prompt';
      var msg = document.getElementById('s-msg');
      f.sw = msg && /\S/.test(msg.textContent || '') && shown(msg) ? 1 : 0;
    } else if (page === 'ghost') {
      var gs = document.getElementById('gh-state');
      var gst = gs && gs.getAttribute('data-state');
      if (has(['wait', 'awake', 'asleep', 'thinking', 'speaking', 'lost'], gst)) f.gst = gst;
      var via = '';
      try { via = (new URLSearchParams(location.search).get('via') || '').toLowerCase(); } catch (e) { /* old engine */ }
      f.gvia = has(['mask', 'knock', 'console', 'ghost', 'talk', 'ai', 'wake', 'cd', 'logo', 'hold'], via) ? via : 'none';
      f.gturn = int(pageCount.turn, 0, 20);
    }
    return f;
  }

  function probe() {
    if (!P.on || P.busy || document.hidden) return;
    if (S.block.probe > Date.now()) return;
    var t = Date.now();
    P.sent = P.sent.filter(function (x) { return t - x < 60000; });
    if (P.sent.length >= 6) return;
    var pass = passFor(P.f);
    if (!pass) return;
    P.sent.push(t);
    P.busy = true;
    post('probe', { pass: pass, facts: collect() }).then(function (j) {
      P.busy = false;
      if (j && j.error === 'limit') {
        P.every = Math.min(P.every * 2, 300000);
        clearTimeout(P.timer);
        P.timer = later(Math.max(P.every, (S.block.probe || 0) - Date.now()), probeTick);
        return;
      }
      if (!j || !j.ok) return;
      P.every = P.base;
      var rooms = Array.isArray(j.rooms) ? j.rooms : [];
      rooms.forEach(function (rm) {
        if (!rm || !rm.frag || !Array.isArray(rm.frag.cells) || !has(AREAS, rm.area)) return;
        var frags = lsJson('hunt.frags.' + P.f) || {};
        frags[rm.area] = rm.frag;
        lsPut('hunt.frags.' + P.f, frags);
        if (P.shown[rm.area]) return;
        P.shown[rm.area] = 1;
        overlay(rm);
      });
    });
  }

  /* ---------- the fragment overlay (CONTRACT 12.6) ---------- */

  var ov = { el: null, q: [], t: 0 };
  function overlay(rm) {
    if (ov.el) { ov.q.push(rm); return; }
    ensureCss();
    var el = ov.el = make('aside', 'hunt-ov' + (reduced() ? ' is-still' : ''), document.body);
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'a fragment');
    var head = make('p', 'hunt-ov-head', el);
    make('span', 'hunt-ov-mark', head, '·');
    make('span', null, head, AREA_NAME[rm.area] || rm.area);
    var close = make('button', 'hunt-ov-x', head, 'x');
    close.type = 'button';
    close.setAttribute('aria-label', 'dismiss');
    close.addEventListener('click', dismiss);
    var pre = make('pre', 'hunt-ov-frag', el, asciiHex(rm.frag.cells));
    pre.setAttribute('aria-label', 'fragment of ' + rm.frag.cells.length + ' cells');
    if (typeof rm.say === 'string' && rm.say) make('p', 'hunt-ov-say', el, rm.say);
    make('p', 'hunt-ov-foot', el, 'kept on the receiver');
    ov.t = later(12000, dismiss);
  }
  function dismiss() {
    clearTimeout(ov.t);
    var el = ov.el;
    if (!el) return;
    var done = function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      ov.el = null;
      if (ov.q.length) overlay(ov.q.shift());
    };
    if (reduced()) { done(); return; }
    el.classList.add('is-out');
    later(420, done);
  }

  /* ---------- the 404 hook (CONTRACT 12.7) ---------- */

  var M = { on: false, box: null, run: null, stage: null, plain: null, device: 'key', host: null };
  var KEYDIR = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 };

  function mount404(stageEl, key, plain) {
    if (M.on) {
      if (M.run && M.run.ext && own(KEYDIR, key)) M.run.ext(KEYDIR[key]);
      return true;
    }
    if (!stageEl) return false;
    var f = curF();
    var sum = f && stateSum(f);
    var sk = openOf(sum, 'final') || openOf(sum, 'run');
    if (!sk) return false;
    ensureCss();
    M.on = true;
    M.f = f;
    M.stage = sk;
    M.plain = plain;
    M.host = stageEl;
    M.device = mqCoarse.matches ? 'touch' : 'key';
    var cv = stageEl.querySelector('canvas[data-obj]');
    M.cv = cv;
    if (cv) cv.classList.add('hunt-hide');
    var box = M.box = make('div', 'hunt-404', stageEl);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'the snake stirs');
    box.setAttribute('data-lock', '');
    // over the broken mask, like the plain snake
    var s = stageEl.getBoundingClientRect(), r = cv ? cv.getBoundingClientRect() : s;
    var w = Math.max(Math.min(r.width, 420), Math.min(window.innerWidth - 32, 340));
    box.style.left = Math.max(0, r.left - s.left + (r.width - w) / 2).toFixed(0) + 'px';
    box.style.top = (r.top - s.top + r.height / 2).toFixed(0) + 'px';
    box.style.width = w.toFixed(0) + 'px';
    M.onKey = function (e) {
      if (e.key !== 'Escape') return;
      if (M.run && !(M.run.isDone && M.run.isDone())) return;
      e.preventDefault();
      e.stopPropagation();
      close404();
    };
    window.addEventListener('keydown', M.onKey, true);
    chooser();
    return true;
  }

  function close404() {
    if (M.run && M.run.stop) M.run.stop();
    M.run = null;
    if (M.box && M.box.parentNode) M.box.parentNode.removeChild(M.box);
    if (M.cv) M.cv.classList.remove('hunt-hide');
    if (M.onKey) window.removeEventListener('keydown', M.onKey, true);
    M.on = false;
    M.box = null;
  }

  function btn(parent, label, fn, cls) {
    var b = make('button', 'hunt-btn' + (cls ? ' ' + cls : ''), parent, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function chooser(note) {
    var box = M.box;
    box.className = 'hunt-404';
    box.textContent = '';
    make('p', 'hunt-404-head', box, M.stage.type === 'final' ? 'the field is waiting.' : 'the snake is not alone.');
    if (note) make('p', 'hunt-404-note', box, note);
    var list = make('div', 'hunt-404-list', box);
    var first = btn(list, 'possessed (ranked)', function () { start404('ranked'); }, 'is-hi');
    btn(list, 'practice', function () { start404('practice'); });
    btn(list, 'plain snake', function () {
      var p = M.plain;
      close404();
      if (typeof p === 'function') p();
    });
    var dev = btn(list, 'input: ' + (M.device === 'touch' ? 'touch' : 'keys'), function () {
      M.device = M.device === 'touch' ? 'key' : 'touch';
      dev.textContent = 'input: ' + (M.device === 'touch' ? 'touch' : 'keys');
    }, 'is-dim');
    if (mqCoarse.matches) make('p', 'hunt-404-note', box, 'desktop recommended.');
    make('p', 'hunt-404-foot', box, mqCoarse.matches ? 'the receiver keeps the rules: /rx/' : 'esc leaves · the receiver keeps the rules: /rx/');
    try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
  }

  function bestLat(f, device) {
    var b = lsJson('hunt.best.' + f) || {};
    return b.lat && typeof b.lat[device] === 'number' ? b.lat[device] : null;
  }
  function saveLat(f, device, ms) {
    var b = lsJson('hunt.best.' + f) || {};
    b.lat = b.lat || {};
    b.lat[device] = ms;
    lsPut('hunt.best.' + f, b);
  }

  function start404(mode) {
    var box = M.box;
    box.textContent = '';
    make('p', 'hunt-404-head', box, 'listening...');
    Promise.all([
      loadScript('hunt-sim.js', 'huntSim'),
      loadScript('hunt-run.js', 'huntRun'),
      call('stage', { stage: M.stage.id }, { f: M.f })
    ]).then(function (r) {
      if (!M.on) return;
      var j = r[2];
      if (!j || !j.ok || !j.data || !j.data.cfg) { chooser((j && j.say) || SAY.lost); return; }
      if (j.state !== 'open') { dropState(); chooser(j.say || SAY.lost); return; }
      var d = j.data;
      if (mode === 'ranked' && j.type === 'final') {
        if (d.floor && d.floor.ok === false) { chooser('not yet.'); return; }
        if (d.attempts && d.attempts.cooldownUntil && d.attempts.cooldownUntil > huntNow()) { chooser('it is still settling.'); return; }
        if (d.attempts && d.attempts.left === 0) { chooser('nothing more on this band today.'); return; }
      }
      var lat = bestLat(M.f, M.device);
      var go = function (ms) {
        if (!M.on) return;
        box.textContent = '';
        box.className = 'hunt-404 is-full';
        M.run = window.huntRun.mount(box, {
          stage: M.stage.id, type: j.type, mode: mode, data: d, device: M.device, f: M.f,
          lat: ms || 0, startRing: 0,
          onEnd: function (res) { after404(mode, res); }
        });
      };
      if (j.type === 'final' && mode === 'ranked' && lat == null) {
        box.className = 'hunt-404 is-full';
        box.textContent = '';
        window.huntRun.calibrate(box, function (ms) {
          if (typeof ms === 'number') saveLat(M.f, M.device, ms);
          go(ms);
        });
        return;
      }
      go(lat);
    }, function () {
      if (M.on) chooser('the band could not load the run.');
    });
  }

  function after404(mode, res) {
    if (!M.on) return;
    var box = M.box;
    var foot = make('div', 'hunt-404-list hunt-404-after', box);
    btn(foot, 'again', function () { var r = M.run; M.run = null; if (r && r.stop) r.stop(); start404(mode); }, 'is-hi');
    btn(foot, mode === 'ranked' ? 'practice' : 'ranked', function () {
      var r = M.run; M.run = null; if (r && r.stop) r.stop(); start404(mode === 'ranked' ? 'practice' : 'ranked');
    });
    btn(foot, 'leave', function () { close404(); }, 'is-dim');
    btn(foot, 'receiver', goRx, 'is-dim');
    if (res && (res.result === 'cleared' || res.result === 'took')) dropState();
  }

  /* ---------- start ---------- */

  function afterStatus() {
    verifyAll();
    var f = curF();
    if (!f) return;
    var isLive = liveList().some(function (l) { return l.f === f; });
    // the 404 hook and the probes read a summary of the receiver's state;
    // other pages only need it while the band is live
    if (!isLive && page !== '404') return;
    getState(f).then(function (sum) {
      if (isLive && sum && openOf(sum, 'rooms')) probeStart(f);
    });
  }

  function boot() {
    var go = function () { getStatus(false).then(markKnown, markKnown); };
    var c = ssJson('hunt.st');
    if (c && c.at && c.body && Date.now() - c.at >= 0 && Date.now() - c.at < (c.body.on && !c.err ? 120000 : 900000)) {
      go();
      return;
    }
    var idle = function () {
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 2000 });
      else go();
    };
    var onLoad = function () { later(1000, idle); };
    if (document.readyState === 'complete') onLoad(); else window.addEventListener('load', onLoad);
  }

  var api = {
    ready: ready,
    live: live,
    tell: tell,
    lines: lines,
    shape: shape,
    door: door,
    pass: function () { return !!curF(); },
    code: code,
    recover: recover,
    goRx: goRx,
    signal: signal,
    report: report,
    event: event,
    solver: solver,
    whoami: whoami,
    eggRow: eggRow,
    mount404: mount404,
    call: call,
    cert: certOf,
    // for hunt-rx.js and hunt-run.js only; not a stable interface
    _u: {
      BASE: BASE, page: page, lsGet: lsGet, lsSet: lsSet, lsJson: lsJson, lsPut: lsPut, lsKeys: lsKeys,
      ssJson: ssJson, ssPut: ssPut, passFor: passFor, passPayload: passPayload, certPayload: certPayload,
      storePass: storePass, storeCert: storeCert, curF: curF, now: huntNow, status: function () { return S.status; },
      speed: function () { return S.speed; }, refresh: function () { return getStatus(true); },
      getState: getState, putState: putState, dropState: dropState, verifyAll: verifyAll, verifyCert: verifyCert,
      sha256hex: sha256hex, hmacHex: hmacHex, hexBytes: hexBytes, b64uDec: b64uDec, b64uEnc: b64uEnc, utf8: utf8,
      canon: canon, asciiHex: asciiHex, ensureCss: ensureCss, loadScript: loadScript, liveList: liveList,
      coldList: coldList, reduced: reduced, coarse: function () { return !!mqCoarse.matches; },
      saveLat: saveLat, bestLat: bestLat, evCode: evCode, ring: ring, collect: collect, SAY: SAY,
      loopback: loopback, keyNow: keyNow, AREA_NAME: AREA_NAME, lastState: null
    }
  };

  window.hunt = api;

  // the recorder works at once; the queues drain now
  var evq = window.huntEvQ;
  window.huntEvQ = { push: function () { for (var i = 0; i < arguments.length; i++) event(arguments[i]); } };
  if (evq && evq.length) for (var i = 0; i < evq.length; i++) event(evq[i]);
  var fq = window.huntQ;
  window.huntQ = { push: function () { for (var i = 0; i < arguments.length; i++) ready(arguments[i]); } };
  if (fq && fq.length) for (var j = 0; j < fq.length; j++) ready(fq[j]);

  // what the recorder sees by itself
  if (has(AREAS, page) || page === 'rx') event('nav:' + page);
  document.addEventListener('visibilitychange', function () { event(document.hidden ? 'vis:hidden' : 'vis:shown'); });
  if (page === 'yt') {
    var lastRoute = null;
    var onRoute = function () {
      var head = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
      if (head !== lastRoute && has(ROUTES, head)) { lastRoute = head; event('route:' + head); }
    };
    window.addEventListener('hashchange', onRoute);
    onRoute();
  }
  if ((page === 'games' || page === 'proxy') && window.MutationObserver) {
    var cls = page === 'games' ? 'playing' : 'browsing';
    var was = root.classList.contains(cls);
    new MutationObserver(function () {
      var now = root.classList.contains(cls);
      if (now === was) return;
      was = now;
      event(page === 'games' ? (now ? 'game:open' : 'game:close') : (now ? 'proxy:browse' : 'proxy:home'));
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }
  if (page === 'stats' && window.MutationObserver) {
    var watchMsg = function () {
      var m = document.getElementById('s-msg');
      if (!m) return;
      var had = /\S/.test(m.textContent || '');
      new MutationObserver(function () {
        var now = /\S/.test(m.textContent || '');
        if (now && !had) event('stats:refused');
        had = now;
      }).observe(m, { childList: true, characterData: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchMsg); else watchMsg();
  }

  boot();
})();
