/* hunt-rx.js: the receiver at /rx/ (CONTRACT 12.5). Generic and data
   driven: it renders whatever the server serves for each stage type
   (broadcast, log, rooms, planchette, run, final) and keeps the player's
   own working material (tape, fragments, marks, notes, transcript) in
   this browser only. No stage content lives in this file.

   Needs hunt.js (window.hunt); loads hunt-sim.js and hunt-run.js on
   demand for practice. textContent only, never innerHTML. */
(function () {
  'use strict';

  var h = window.hunt;
  if (!h || !h._u) return;
  var u = h._u;
  var root = document.documentElement;
  var main = document.getElementById('rx-body');
  var clockEl = document.getElementById('rx-clock');
  var sbEl = document.getElementById('rx-sb');
  if (!main) return;

  var SQ3 = Math.sqrt(3);
  var DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  var DIRN = ['e', 'ne', 'nw', 'w', 'sw', 'se'];
  var ROWL = 'abcdefghi';
  var DAY = 86400000;

  var R = {
    f: null, st: null, sel: null, stage: null, view: null, pollT: 0, statePollT: 0, statusT: 0,
    notes: {}, temp: false, busy: false, practice: null
  };

  /* ---------- small helpers ---------- */

  function make(tag, cls, parent, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function btn(parent, label, fn, cls) {
    var b = make('button', 'hunt-btn' + (cls ? ' ' + cls : ''), parent, label);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }
  function panel(parent, title, cls) {
    var s = make('section', 'rx-panel' + (cls ? ' ' + cls : ''), parent);
    if (title) make('h2', 'rx-h', s, title);
    return s;
  }
  function lines(parent, arr, cls) {
    if (!Array.isArray(arr)) return;
    arr.forEach(function (t) { if (typeof t === 'string') make('p', cls || 'rx-p', parent, t); });
  }
  function pre(parent, arr, cls) {
    var p = make('pre', 'rx-pre' + (cls ? ' ' + cls : ''), parent);
    p.textContent = Array.isArray(arr) ? arr.join('\n') : String(arr || '');
    return p;
  }
  function tag(parent, text, cls) { return make('span', 'rx-tag' + (cls ? ' ' + cls : ''), parent, text); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function utcHM(ms) { var d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function utcHMS(ms) { var d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); }
  var WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var MO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function utcDate(ms) { var d = new Date(ms); return WD[d.getUTCDay()] + ' ' + pad(d.getUTCDate()) + ' ' + MO[d.getUTCMonth()]; }
  function span(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    s %= 60;
    return (d ? d + 'd ' : '') + (d || hh ? hh + 'h ' : '') + pad(m) + 'm ' + pad(s) + 's';
  }
  function mmss(ms) { ms = Math.max(0, ms | 0); var s = Math.round(ms / 1000); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); }
  // a countdown that the clock keeps current
  function countdown(parent, at, prefix, after) {
    var el = make('span', 'rx-cd', parent);
    el.setAttribute('data-at', String(at));
    el.setAttribute('data-pre', prefix || '');
    el.setAttribute('data-after', after || 'now');
    tickCd(el, u.now());
    return el;
  }
  function tickCd(el, t) {
    var at = +el.getAttribute('data-at');
    el.textContent = at > t ? el.getAttribute('data-pre') + span(at - t) : el.getAttribute('data-after');
  }
  function copy(text, note) {
    var done = function (ok) { if (note) note.textContent = ok ? 'copied.' : 'select it and copy.'; };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback(text)); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(fallback(text));
  }
  function fallback(text) {
    var ta = make('textarea', 'sr', document.body);
    ta.value = text;
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function textBox(parent, value, rows) {
    var ta = make('textarea', 'hunt-ta', parent);
    ta.readOnly = true;
    ta.rows = rows || 3;
    ta.value = value;
    ta.spellcheck = false;
    ta.addEventListener('focus', function () { ta.select(); });
    return ta;
  }
  function group4(s) { return s.replace(/(.{4})(?=.)/g, '$1 '); }

  function store(kind) { return u.lsJson('hunt.' + kind + '.' + R.f); }
  function put(kind, v) { u.lsPut('hunt.' + kind + '.' + R.f, v); }

  function saveNotes() { put('notes', R.notes); }
  var notesT = 0;
  function saveNotesSoon() { clearTimeout(notesT); notesT = setTimeout(saveNotes, 400); }
  function nb(stage) { var n = R.notes[stage]; if (!n || typeof n !== 'object') n = R.notes[stage] = {}; return n; }

  function hex() {
    return {
      add: function (a, b) { return [a[0] + b[0], a[1] + b[1]]; },
      rot: function (a, n) { var q = a[0], r = a[1]; n = ((n % 6) + 6) % 6; for (var i = 0; i < n; i++) { var t = q; q = q + r; r = -t; } return [q, r]; },
      dist: function (a) { return (Math.abs(a[0]) + Math.abs(a[0] + a[1]) + Math.abs(a[1])) / 2; },
      spiral: function (radius) {
        var out = [[0, 0]];
        for (var k = 1; k <= radius; k++) {
          var c = [DIRS[4][0] * k, DIRS[4][1] * k];
          for (var i = 0; i < 6; i++) for (var j = 0; j < k; j++) { out.push(c); c = [c[0] + DIRS[i][0], c[1] + DIRS[i][1]]; }
        }
        return out;
      }
    };
  }
  var HX = hex();

  /* ---------- clock ---------- */

  function startClock() {
    var tick = function () {
      var t = u.now(), st = u.status();
      if (clockEl) clockEl.textContent = utcHMS(t) + ' utc';
      if (sbEl) {
        var sb = !!(st && st.sandbox);
        sbEl.hidden = !sb;
        if (sb) sbEl.textContent = 'sandbox' + (u.speed() !== 1 ? ' · clock x' + u.speed() : '');
      }
      var cds = document.querySelectorAll('.rx-cd[data-at]');
      for (var i = 0; i < cds.length; i++) tickCd(cds[i], t);
    };
    tick();
    setInterval(tick, 500);
    // the sandbox clock may run fast: keep it in step with the server
    setInterval(function () {
      var st = u.status();
      if (st && st.sandbox && !document.hidden) u.refresh();
    }, 30000);
  }

  /* ---------- storage that may not last ---------- */

  function checkStorage(then) {
    var ok = u.lsSet('hunt.tmp', '1') && u.lsGet('hunt.tmp') === '1';
    u.lsSet('hunt.tmp', null);
    R.temp = !ok;
    if (!ok || !navigator.storage || !navigator.storage.estimate) { then(); return; }
    navigator.storage.estimate().then(function (e) {
      if (e && typeof e.quota === 'number' && e.quota < 200 * 1024 * 1024) R.temp = true;
      then();
    }, then);
  }
  function tempWarn(parent) {
    if (!R.temp) return;
    var w = make('div', 'rx-warn', parent);
    w.setAttribute('role', 'note');
    make('p', null, w, 'this browser may not keep the receiver (a private window or a guest session?).');
    make('p', 'rx-dim', w, 'export it, or keep the recovery code somewhere safe.');
  }

  /* ---------- start ---------- */

  function boot() {
    startClock();
    checkStorage(function () {
      R.f = u.curF();
      if (!R.f) { empty(); return; }
      R.notes = store('notes') || {};
      var m = /^#(s\d)$/.exec(location.hash);
      if (m) R.sel = m[1];
      loadState(true);
    });
    window.addEventListener('resize', function () { if (R.view && R.view.resize) R.view.resize(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && R.f) loadState(false); });
  }

  function clear() {
    clearTimeout(R.pollT);
    if (R.practice) { try { R.practice.stop(); } catch (e) { /* gone */ } R.practice = null; }
    main.textContent = '';
  }

  /* ---------- no receiver ---------- */

  function empty(note) {
    clear();
    var box = make('div', 'rx-empty', main);
    // say plainly what this page is: nothing here is a puzzle, the way in is elsewhere
    var big = make('p', 'rx-big', box, 'the band is empty.');
    var why = make('p', 'rx-p', box, '');
    var fill = function () {
      var on = false;
      try { on = !!h.live(); } catch (e) { on = false; }
      big.textContent = on ? 'not tuned in yet.' : 'the band is empty.';
      why.textContent = on ? 'this page opens by itself once you find the way in. the way in is somewhere on the site, not here.' : 'nothing is on air right now.';
    };
    fill();
    try { h.ready(fill); } catch (e) { /* no status yet */ }
    if (note) make('p', 'rx-dim', box, note);
    tempWarn(box);
    // moving a receiver between browsers is rare: kept out of the way
    var more = make('details', 'rx-det', box);
    make('summary', null, more, 'already tuned in on another browser or phone?');
    box = more;
    var a = panel(box, 'paste a receiver');
    make('p', 'rx-dim', a, 'a receiver string from another browser (it starts with p1.), or a certificate (c1.).');
    var ta = make('textarea', 'hunt-ta', a);
    ta.rows = 3;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'receiver or certificate string');
    var res = make('p', 'rx-say', a);
    btn(a, 'load', function () {
      var s = ta.value.replace(/\s+/g, '');
      if (u.passPayload(s)) {
        u.storePass(s);
        u.dropState();
        res.textContent = 'loaded.';
        restart();
      } else if (u.certPayload(s)) {
        u.storeCert(s);
        res.textContent = 'certificate kept. it counts once it checks out.';
      } else res.textContent = 'that is not a receiver.';
    }, 'is-hi');
    var b = panel(box, 'recover with a code');
    make('p', 'rx-dim', b, 'the recovery code of a receiver (works while its frequency is live).');
    var inp = make('input', 'hunt-in', b);
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.maxLength = 40;
    inp.setAttribute('aria-label', 'recovery code');
    var res2 = make('p', 'rx-say', b);
    btn(b, 'recover', function () {
      res2.textContent = 'listening...';
      h.recover(inp.value).then(function (j) {
        res2.textContent = j.say || '';
        if (j.ok) setTimeout(restart, 600);
      });
    }, 'is-hi');
    certPanels(box, null);
  }

  function restart() {
    R.f = u.curF();
    R.st = null;
    R.stage = null;
    if (!R.f) { empty(); return; }
    R.notes = store('notes') || {};
    loadState(true);
  }

  /* ---------- the receiver ---------- */

  function loadState(full) {
    if (R.busy) return;
    R.busy = true;
    h.call('state', {}, { f: R.f }).then(function (j) {
      R.busy = false;
      if (!j || !j.ok) {
        if (j && (j.error === 'badpass' || j.error === 'nopass')) { badPass(j.say); return; }
        if (!R.st) { empty((j && j.say) || 'the band could not be reached.'); return; }
        return;
      }
      u.putState(R.f, j);
      var prev = R.st;
      R.st = j;
      var changed = !prev || JSON.stringify(prev.stages) !== JSON.stringify(j.stages) || prev.cert !== j.cert;
      if (full || changed) render();
      clearTimeout(R.statePollT);
      R.statePollT = setTimeout(function () { if (!document.hidden) loadState(false); }, 120000);
    });
  }

  function badPass(say) {
    clear();
    var box = make('div', 'rx-empty', main);
    make('p', 'rx-big', box, say || 'that receiver is not ours.');
    make('p', 'rx-dim', box, 'it may belong to another server, or to the sandbox.');
    forgetPanel(box);
  }

  function render() {
    clear();
    var j = R.st;
    var head = make('div', 'rx-head', main);
    var t = make('p', 'rx-title', head);
    make('b', null, t, j.title || R.f);
    make('span', 'rx-dim', t, '  ' + R.f + ' · day ' + j.day);
    if (j.late) tag(t, 'late');
    if (j.sandbox) tag(t, 'sandbox');
    if (j.floor && typeof j.floor.day === 'number' && !j.floor.ok) {
      var fl = make('p', 'rx-dim', head, 'the last step waits for day ' + j.floor.day + ' ');
      var at = dayStart(j.floor.day);
      if (at) countdown(fl, at, '(in ', 'now');
      if (at) fl.appendChild(document.createTextNode(at > u.now() ? ')' : ''));
    }
    var st = u.status();
    var errata = st && st.lines && Array.isArray(st.lines.errata) ? st.lines.errata : [];
    if (errata.length) {
      var er = make('div', 'rx-errata', main);
      errata.forEach(function (e) { make('p', null, er, 'errata · ' + e); });
    }
    tempWarn(main);
    savePrompt(main);

    var grid = make('div', 'rx-grid', main);
    var side = make('div', 'rx-side', grid);
    var nav = make('nav', 'rx-stages', side);
    nav.setAttribute('aria-label', 'stages');
    var stages = j.stages || [];
    if (!R.sel || !stages.some(function (s) { return s.id === R.sel && s.state !== 'locked'; })) {
      var first = stages.filter(function (s) { return s.state === 'open'; })[0] || stages.filter(function (s) { return s.state !== 'locked'; })[0];
      R.sel = first ? first.id : null;
    }
    stages.forEach(function (s) { stageItem(nav, s); });
    var view = make('section', 'rx-stage', grid);
    view.id = 'rx-stage';
    view.setAttribute('aria-live', 'polite');
    var extra = make('div', 'rx-extra', side);
    lanternPanel(extra);
    wallPanel(extra);
    tallyPanel(extra);
    walkPanel(extra);
    receiverPanel(extra);
    certPanels(extra, j);
    if (R.sel) openStage(R.sel); else make('p', 'rx-dim', view, 'nothing on this band yet.');
  }

  function dayStart(day) {
    var st = u.status(), f = R.f;
    var all = (st && (st.live || []).concat(st.cold || [])) || [];
    var e = all.filter(function (x) { return x && x.f === f && x.opensAt; })[0];
    var o = e ? Date.parse(e.opensAt) : NaN;
    return isFinite(o) ? o + day * DAY : 0;
  }

  function stageItem(nav, s) {
    var b = make('button', 'rx-st is-' + s.state + (s.id === R.sel ? ' is-sel' : ''), nav);
    b.type = 'button';
    b.disabled = s.state === 'locked';
    b.setAttribute('aria-pressed', s.id === R.sel ? 'true' : 'false');
    var top = make('span', 'rx-st-top', b);
    make('span', 'rx-st-id', top, s.id);
    make('span', 'rx-st-t', top, s.title || '—');
    make('span', 'rx-st-state', top, s.state === 'solved' ? 'received' : s.state === 'open' ? 'open' : 'locked');
    var meta = [];
    if (s.state === 'locked') meta.push('nothing on this band yet.');
    if (typeof s.opened === 'number') meta.push('opened day ' + s.opened);
    if (typeof s.solved === 'number') meta.push('received day ' + s.solved);
    if (s.state === 'open' && s.answers && typeof s.answers.left === 'number') meta.push(s.answers.left + ' left today');
    if (s.state === 'open' && s.echo) {
      if (s.echo.next != null && s.echo.at == null) meta.push('echo ' + s.echo.next + ' ready');
      else if (s.echo.next != null && s.echo.at != null) meta.push('echo ' + s.echo.next + ' on day ' + s.echo.at);
    }
    if (s.state === 'open' && s.type === 'final' && s.notBefore != null && R.st && R.st.day < s.notBefore) meta.push('not before day ' + s.notBefore);
    make('span', 'rx-st-meta', b, meta.join(' · '));
    b.addEventListener('click', function () {
      if (R.sel === s.id) return;
      R.sel = s.id;
      try { history.replaceState(null, '', '#' + s.id); } catch (e) { location.hash = s.id; }
      var all = document.querySelectorAll('.rx-st');
      for (var i = 0; i < all.length; i++) {
        all[i].classList.remove('is-sel');
        all[i].setAttribute('aria-pressed', 'false');
      }
      b.classList.add('is-sel');
      b.setAttribute('aria-pressed', 'true');
      openStage(s.id);
    });
  }

  function stateOf(id) {
    var ss = (R.st && R.st.stages) || [];
    for (var i = 0; i < ss.length; i++) if (ss[i].id === id) return ss[i];
    return null;
  }

  /* ---------- one stage ---------- */

  function openStage(id, keep) {
    clearTimeout(R.pollT);
    if (R.practice) { try { R.practice.stop(); } catch (e) { /* gone */ } R.practice = null; }
    var view = document.getElementById('rx-stage');
    if (!view) return;
    if (!keep) { view.textContent = ''; make('p', 'rx-dim', view, 'listening...'); }
    h.call('stage', { stage: id }, { f: R.f }).then(function (j) {
      if (R.sel !== id) return;
      if (!j || !j.ok) {
        view.textContent = '';
        make('p', 'rx-say', view, (j && j.say) || 'that did not come through.');
        return;
      }
      if (keep && R.view && R.view.id === id && R.view.update) { R.stage = j; R.view.update(j); schedule(j); return; }
      R.stage = j;
      view.textContent = '';
      var hd = make('header', 'rx-stage-head', view);
      make('span', 'rx-st-id', hd, j.id);
      make('h1', 'rx-stage-t', hd, j.title || '');
      make('span', 'rx-st-state', hd, j.state === 'solved' ? 'received' : j.state);
      var body = make('div', 'rx-stage-body', view);
      var fn = RENDER[j.type];
      R.view = fn ? fn(body, j) : null;
      if (R.view) R.view.id = id;
      if (!fn) make('p', 'rx-dim', body, 'this receiver cannot show that band yet.');
      var s = stateOf(id);
      if (j.type !== 'run' && j.type !== 'planchette' && s && s.state === 'open' && s.answers) answerBox(view, j, s);
      echoPanel(view, j, s);
      notesBox(view, j.id);
      schedule(j);
    });
  }

  function schedule(j) {
    clearTimeout(R.pollT);
    if (j.type !== 'broadcast') return;
    var n = j.data && j.data.now, live = n && n.state === 'live';
    var wait = live ? 10000 : 60000;
    var t = u.now();
    if (j.data && j.data.live && j.data.live.until > t) wait = Math.min(wait, j.data.live.until - t + 600);
    if (n && n.next > t) wait = Math.min(wait, n.next - t + 600);
    R.pollT = setTimeout(function () { if (!document.hidden) openStage(j.id, true); else schedule(j); }, Math.max(2000, wait));
  }

  /* ---------- the answer box ---------- */

  function transmit(stage, text, out, then) {
    out.textContent = 'listening...';
    return h.call('answer', { text: String(text).slice(0, 200), stage: stage }, { f: R.f }).then(function (j) {
      j = j || {};
      out.textContent = '';
      make('span', 'rx-say-l', out, j.say || (j.result || j.error || ''));
      var ls = Array.isArray(j.lines) ? j.lines : [];
      if (j.result === 'warm' && ls.length) put('gloss', ls);
      ls.forEach(function (l) { make('span', 'rx-say-g', out, l); });
      if (then) then(j);
      if (j.result === 'correct' || j.result === 'solved' || (j.unlocked && j.unlocked.length)) loadState(true);
      else if (typeof j.left === 'number') {
        var s = stateOf(stage);
        if (s && s.answers) s.answers.left = j.left;
      }
      return j;
    });
  }

  function answerBox(view, j, s) {
    var p = panel(view, 'transmit', 'rx-answer');
    make('p', 'rx-dim', p, 'this goes to the signal, nowhere else. ' + (typeof s.answers.left === 'number' ? s.answers.left + ' left today.' : ''));
    var form = make('form', 'rx-form', p);
    form.setAttribute('autocomplete', 'off');
    var inp = make('input', 'hunt-in', form);
    inp.type = 'text';
    inp.maxLength = 200;
    inp.spellcheck = false;
    inp.setAttribute('aria-label', 'words for the signal');
    var go = make('button', 'hunt-btn is-hi', form, 'transmit');
    go.type = 'submit';
    var out = make('p', 'rx-say', p);
    out.setAttribute('aria-live', 'polite');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!inp.value.trim()) return;
      go.disabled = true;
      transmit(j.id, inp.value, out, function (r) {
        go.disabled = false;
        if (r.result === 'warm' && j.type === 'final') openStage(j.id);
      });
    });
  }

  /* ---------- echoes and lanterns ---------- */

  function echoPanel(view, j, s) {
    var claimed = Array.isArray(j.echoes) ? j.echoes : [];
    var e = s && s.echo;
    if (!claimed.length && !(s && s.state === 'open' && e)) return;
    var p = panel(view, 'echoes', 'rx-echo');
    claimed.forEach(function (x) {
      var row = make('div', 'rx-echo-row', p);
      make('span', 'rx-echo-n', row, 'echo ' + x.tier);
      make('p', 'rx-p', row, x.text || '');
    });
    if (!s || s.state !== 'open' || !e || e.next == null) return;
    var lt = R.st.lanterns || { have: 0, used: 0 };
    var spare = (lt.have | 0) - (lt.used | 0);
    var bar = make('div', 'rx-row', p);
    var note = make('p', 'rx-dim', p, 'an echo or a lantern means the certificate will not be unlit.');
    if (e.at == null) {
      claimBtn(bar, j.id, 'claim echo ' + e.next, false, note);
    } else {
      make('span', 'rx-dim', bar, 'echo ' + e.next + ' on day ' + e.at + ' ');
      var at = dayStart(e.at);
      if (at) countdown(bar, at, '(in ', 'now');
      if (spare > 0 && j.type !== 'run') claimBtn(bar, j.id, 'use a lantern for echo ' + e.next, true, note);
    }
  }
  function claimBtn(bar, id, label, lantern, note) {
    var b = btn(bar, label, function () {
      if (!b.classList.contains('is-arm')) {
        b.classList.add('is-arm');
        b.textContent = 'sure? ' + label;
        return;
      }
      b.disabled = true;
      var body = { stage: id, claim: true };
      if (lantern) body.lantern = true;
      h.call('echo', body, { f: R.f }).then(function (r) {
        if (r && r.ok) { loadState(true); return; }
        b.disabled = false;
        b.classList.remove('is-arm');
        b.textContent = label;
        note.textContent = (r && r.say) || 'not yet.';
      });
    });
    return b;
  }

  function notesBox(view, id) {
    var p = panel(view, 'notes', 'rx-notes');
    var ta = make('textarea', 'hunt-ta', p);
    ta.rows = 4;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'your notes for this stage, kept in this browser');
    ta.value = typeof nb(id).text === 'string' ? nb(id).text : '';
    ta.addEventListener('input', function () { nb(id).text = ta.value.slice(0, 20000); saveNotesSoon(); });
    make('p', 'rx-dim', p, 'kept in this browser only.');
  }

  /* ---------- renderers ---------- */

  var RENDER = {};

  /* broadcast: schedule, legend, live frame, recordings, tape */
  RENDER.broadcast = function (el, j) {
    var d = j.data || {};
    lines(el, d.intro);
    var sc = d.schedule || {};
    var sp = panel(el, 'schedule (utc)', 'rx-sched');
    if (Array.isArray(sc.offsets)) {
      var day0 = Math.floor(u.now() / DAY) * DAY;
      make('p', 'rx-p', sp, 'airings: ' + sc.offsets.map(function (m) { return utcHM(day0 + m * 60000); }).join(', ') +
        (sc.dur ? ' · ' + sc.dur + ' min each' : ''));
    }
    var facts = [];
    if (sc.slot) facts.push('one frame on air every ' + sc.slot + ' s');
    if (sc.reels) facts.push(sc.reels + ' reels, one a day in turn');
    if (sc.recAfter != null) facts.push('the day’s recording opens ' + sc.recAfter + ' min after its first airing ends');
    if (facts.length) make('p', 'rx-dim', sp, facts.join(' · '));
    var nowEl = make('p', 'rx-p rx-onair', sp);

    var gl = typeof d.glyphs === 'string' ? d.glyphs : '';
    if (gl) {
      var lp = panel(el, 'carrier legend', 'rx-legend');
      var row = make('div', 'rx-glyphs', lp);
      row.setAttribute('aria-label', 'the carrier glyphs in legend order');
      for (var i = 0; i < gl.length; i++) make('span', 'rx-glyph', row, gl.charAt(i));
    }
    lines(el, d.notes, 'rx-p rx-note');

    var livePanel = panel(el, 'on air', 'rx-live');
    var liveBody = make('div', null, livePanel);
    var recPanel = panel(el, 'recordings', 'rx-rec');
    var recBody = make('div', null, recPanel);
    var tapePanel = panel(el, 'tape', 'rx-tape');
    var tapeBody = make('div', null, tapePanel);
    var cols = d.frame && d.frame.cols ? d.frame.cols : 32;

    function tape() { var t = store('tape'); return t && typeof t === 'object' ? t : {}; }
    function keep(id, fr, q) {
      var t = tape();
      if (t[id] && t[id].q === 'live' && q !== 'live') return false;
      var prev = t[id];
      t[id] = { lines: fr.lines, q: q, day: fr.day, slot: fr.slot, at: Date.now() };
      if (prev && typeof prev.o === 'number') t[id].o = prev.o;
      put('tape', t);
      return true;
    }
    function frameLabel(fr, q) {
      return 'day ' + fr.day + ' · slot ' + (fr.slot + 1) + (q ? ' · ' + q : '');
    }
    function framePre(parent, ls) {
      var p = pre(parent, ls, 'rx-frame');
      p.style.setProperty('--cols', String(cols));
      return p;
    }

    function drawNow(dd) {
      nowEl.textContent = '';
      var n = dd.now || {};
      if (n.state === 'live' && n.airing) {
        nowEl.appendChild(document.createTextNode('on air now · ends '));
        countdown(nowEl, n.airing.end, 'in ', 'now');
      } else if (n.next) {
        nowEl.appendChild(document.createTextNode('next airing ' + utcDate(n.next) + ' ' + utcHM(n.next) + ' utc · '));
        countdown(nowEl, n.next, 'in ', 'starting');
      } else nowEl.textContent = 'no airing ahead.';
    }
    function drawLive(dd) {
      liveBody.textContent = '';
      var lv = dd.live;
      if (!lv || !Array.isArray(lv.lines)) {
        make('p', 'rx-dim', liveBody, 'nothing on air right now. the receiver checks again on its own.');
        return;
      }
      var fr = { day: lv.day, slot: lv.slot, lines: lv.lines };
      var fresh = keep(lv.id, fr, 'live');
      var top = make('p', 'rx-dim', liveBody, 'frame ' + (lv.slot + 1) + '/' + lv.of + ' · airing ' + (lv.occ + 1) + ' of day ' + lv.day + ' · next frame ');
      countdown(top, lv.until, 'in ', 'now');
      framePre(liveBody, lv.lines);
      make('p', 'rx-dim', liveBody, (fresh ? 'caught to the tape' : 'already on the tape') + ' · ' + lv.id);
      if (fresh) drawTape();
    }
    function drawRec(dd) {
      recBody.textContent = '';
      var rec = Array.isArray(dd.rec) ? dd.rec : [];
      if (!rec.length) { make('p', 'rx-dim', recBody, 'no recording has opened yet.'); return; }
      rec.slice().sort(function (a, b) { return b.day - a.day; }).forEach(function (r) {
        var det = make('details', 'rx-det', recBody);
        make('summary', null, det, 'day ' + r.day + ' · reel ' + (r.reel + 1) + ' · ' + (r.frames || []).length + ' frames');
        var bar = make('div', 'rx-row', det);
        btn(bar, 'all to the tape', function () {
          (r.frames || []).forEach(function (fr) { keep(fr.id, { day: r.day, slot: fr.slot, lines: fr.lines }, 'rec'); });
          drawTape();
        });
        (r.frames || []).forEach(function (fr) {
          var box = make('div', 'rx-frame-box', det);
          var lab = make('p', 'rx-dim', box, frameLabel({ day: r.day, slot: fr.slot }, '') + ' · ' + fr.id + ' ');
          btn(lab, 'to the tape', function () { keep(fr.id, { day: r.day, slot: fr.slot, lines: fr.lines }, 'rec'); drawTape(); }, 'is-small');
          framePre(box, fr.lines);
        });
      });
    }
    function ordered() {
      var t = tape(), ids = Object.keys(t);
      ids.sort(function (a, b) {
        var A = t[a], B = t[b];
        var oa = typeof A.o === 'number' ? A.o : 1e9, ob = typeof B.o === 'number' ? B.o : 1e9;
        return oa - ob || (A.at || 0) - (B.at || 0);
      });
      return { t: t, ids: ids };
    }
    function reorder(ids) {
      var t = tape();
      ids.forEach(function (id, i) { if (t[id]) t[id].o = i; });
      put('tape', t);
      drawTape();
    }
    function drawTape() {
      tapeBody.textContent = '';
      var x = ordered(), t = x.t, ids = x.ids;
      if (!ids.length) { make('p', 'rx-dim', tapeBody, 'the tape is empty. frames caught on air or kept from a recording land here.'); return; }
      var bar = make('div', 'rx-row', tapeBody);
      make('span', 'rx-dim', bar, ids.length + ' frames · order: ');
      btn(bar, 'by airing', function () {
        reorder(ids.slice().sort(function (a, b) { return (t[a].day - t[b].day) || (t[a].slot - t[b].slot); }));
      }, 'is-small');
      btn(bar, 'by catch', function () {
        reorder(ids.slice().sort(function (a, b) { return (t[a].at || 0) - (t[b].at || 0); }));
      }, 'is-small');
      btn(bar, 'export as text', function () {
        var out = ['# tape ' + R.f + ' (' + ids.length + ' frames)'];
        ids.forEach(function (id) {
          out.push('-- ' + id + ' · ' + frameLabel(t[id], t[id].q));
          out = out.concat(t[id].lines || []);
        });
        var ex = tapeBody.querySelector('.rx-export');
        if (ex) ex.remove();
        var wrap = make('div', 'rx-export', tapeBody);
        var ta = textBox(wrap, out.join('\n'), 8);
        var note = make('p', 'rx-dim', wrap);
        btn(wrap, 'copy', function () { copy(ta.value, note); }, 'is-small');
        tapeBody.insertBefore(wrap, bar.nextSibling);
      }, 'is-small');
      ids.forEach(function (id, i) {
        var e = t[id];
        var box = make('div', 'rx-frame-box', tapeBody);
        var lab = make('p', 'rx-dim', box, (i + 1) + '. ' + id + ' · ' + frameLabel(e, e.q) + ' ');
        var mv = function (k) {
          var arr = ids.slice(), to = i + k;
          if (to < 0 || to >= arr.length) return;
          arr.splice(to, 0, arr.splice(i, 1)[0]);
          reorder(arr);
          var again = tapeBody.querySelectorAll('.rx-frame-box')[to];
          var b2 = again && again.querySelector(k < 0 ? '.is-up' : '.is-down');
          if (b2) b2.focus();
        };
        var up = btn(lab, 'up', function () { mv(-1); }, 'is-small is-up');
        up.setAttribute('aria-label', 'move ' + id + ' up');
        var dn = btn(lab, 'down', function () { mv(1); }, 'is-small is-down');
        dn.setAttribute('aria-label', 'move ' + id + ' down');
        btn(lab, 'drop', function () {
          var tt = tape();
          delete tt[id];
          put('tape', tt);
          drawTape();
        }, 'is-small is-dim');
        framePre(box, e.lines);
      });
    }

    drawNow(d);
    drawLive(d);
    drawRec(d);
    drawTape();
    return {
      update: function (jj) {
        var dd = jj.data || {};
        drawNow(dd);
        drawLive(dd);
        var openDets = recBody.querySelectorAll('details[open]').length;
        if (!openDets) drawRec(dd);
      }
    };
  };

  /* log: entries, claims with pins, local marks, the grid entry */
  RENDER.log = function (el, j) {
    var d = j.data || {};
    lines(el, d.intro);
    var s = stateOf(j.id);
    var opened = s && typeof s.opened === 'number' ? s.opened : null;
    var n = nb(j.id);
    n.m = n.m && typeof n.m === 'object' ? n.m : {};
    var entries = Array.isArray(d.entries) ? d.entries : [];
    entries.forEach(function (e) {
      var art = make('article', 'rx-entry', el);
      var hd = make('h3', 'rx-entry-t', art, e.title || e.id || '');
      var fresh = (typeof e.$day === 'number' && e.$day === j.day) ||
        (typeof e.$rel === 'number' && opened != null && opened + e.$rel === j.day && e.$rel > 0);
      if (fresh) tag(hd, 'new');
      lines(art, e.lines);
      if (Array.isArray(e.claims)) {
        var ul = make('ol', 'rx-claims', art);
        e.claims.forEach(function (c) { claim(ul, e, c); });
      }
      if (e.grid) logicGrid(art, e);
      if (e.sig) make('p', 'rx-sig', art, e.sig);
    });
    if (!entries.length) make('p', 'rx-dim', el, 'no entries yet.');

    function mark(parent, key, labelText) {
      var bar = make('span', 'rx-marks', parent);
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'your mark for ' + labelText);
      [['t', 'true'], ['f', 'false'], ['', '?']].forEach(function (m) {
        var b = btn(bar, m[1], function () {
          n.m[key] = m[0];
          saveNotesSoon();
          var bs = bar.querySelectorAll('button');
          for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', bs[i] === b ? 'true' : 'false');
        }, 'is-small');
        b.setAttribute('aria-pressed', (n.m[key] || '') === m[0] ? 'true' : 'false');
      });
    }
    function claim(ul, e, c) {
      var li = make('li', 'rx-claim', ul);
      var pin = make('p', 'rx-pin', li);
      make('span', 'rx-pin-k', pin, 'pin');
      make('span', null, pin, c.pin || '');
      if (c.touch === 0) tag(pin, 'desktop');
      make('p', 'rx-claim-t', li, c.text || '');
      var key = (e.id || '') + '/' + (c.id || '');
      var row = make('div', 'rx-row', li);
      mark(row, key, 'this claim');
      var inp = make('input', 'hunt-in is-small', row);
      inp.type = 'text';
      inp.placeholder = 'what you saw';
      inp.spellcheck = false;
      inp.maxLength = 200;
      inp.setAttribute('aria-label', 'what you observed for this claim');
      n.o = n.o && typeof n.o === 'object' ? n.o : {};
      inp.value = n.o[key] || '';
      inp.addEventListener('input', function () { n.o[key] = inp.value; saveNotesSoon(); });
    }
    function logicGrid(art, e) {
      var g = e.grid;
      if (g.title) make('h4', 'rx-grid-t', art, g.title);
      var rows = Array.isArray(g.rows) ? g.rows : [], cols = Array.isArray(g.cols) ? g.cols : [];
      var wrap = make('div', 'rx-table-wrap', art);
      var tb = make('table', 'rx-table', wrap);
      var cap = make('caption', 'sr', tb, g.title || 'grid');
      void cap;
      var tr = make('tr', null, make('thead', null, tb));
      make('th', null, tr, '');
      cols.forEach(function (c) { var th = make('th', null, tr, c); th.scope = 'col'; });
      var body = make('tbody', null, tb);
      n.g = n.g && typeof n.g === 'object' ? n.g : {};
      rows.forEach(function (r, ri) {
        var rr = make('tr', null, body);
        var th = make('th', null, rr, r);
        th.scope = 'row';
        cols.forEach(function (c, ci) {
          var td = make('td', null, rr);
          var key = (e.id || '') + '/' + ri + ',' + ci;
          var b = make('button', 'rx-cell', td);
          b.type = 'button';
          var show = function () {
            var v = n.g[key] || '';
            b.textContent = v === 'o' ? 'o' : v === 'x' ? 'x' : '·';
            b.setAttribute('aria-label', r + ', ' + c + ': ' + (v === 'o' ? 'yes' : v === 'x' ? 'no' : 'unknown'));
          };
          show();
          b.addEventListener('click', function () {
            var v = n.g[key] || '';
            n.g[key] = v === '' ? 'o' : v === 'o' ? 'x' : '';
            show();
            saveNotesSoon();
          });
        });
      });
      if (Array.isArray(g.statements)) {
        var ol = make('ol', 'rx-claims', art);
        g.statements.forEach(function (st) {
          var li = make('li', 'rx-claim', ol);
          make('p', 'rx-claim-t', li, st.text || '');
          var row = make('div', 'rx-row', li);
          mark(row, (e.id || '') + '/s/' + (st.id || ''), 'this statement');
        });
      }
      if (g.note) make('p', 'rx-dim', art, g.note);
    }
    return null;
  };

  /* rooms: index, fragments found, the hex workbench */
  RENDER.rooms = function (el, j) {
    var d = j.data || {};
    lines(el, d.intro);
    var frags = store('frags') || {};
    if (Array.isArray(d.index) && d.index.length) {
      var ip = panel(el, 'index', 'rx-index');
      var ul = make('ul', 'rx-list', ip);
      d.index.forEach(function (x) {
        var li = make('li', null, ul);
        make('span', 'rx-area', li, u.AREA_NAME[x.area] || x.area || '');
        make('span', null, li, x.text || '');
        if (frags[x.area]) tag(li, 'found');
      });
    }
    var board = d.board || {};
    var n = nb(j.id);
    n.bench = n.bench && typeof n.bench === 'object' ? n.bench : {};
    var place = n.bench;
    var fp = panel(el, 'fragments', 'rx-frags');
    var fl = make('div', 'rx-frag-list', fp);
    var list = Object.keys(frags).filter(function (a) { return frags[a] && Array.isArray(frags[a].cells); });
    if (!list.length) make('p', 'rx-dim', fl, 'none yet. a room shows its fragment when you stand in it the right way.');
    var sel = null;

    var wp = panel(el, 'workbench', 'rx-bench');
    lines(wp, board.rules, 'rx-p rx-note');
    var tools = make('div', 'rx-row rx-bench-tools', wp);
    var selNote = make('span', 'rx-dim', tools, 'pick a fragment, then a cell.');
    var tb = make('div', 'rx-row', wp);
    var rotL = btn(tb, 'rotate ↺', function () { turn(1); }, 'is-small');
    var rotR = btn(tb, 'rotate ↻', function () { turn(5); }, 'is-small');
    var moves = DIRN.map(function (nm, k) { return btn(tb, nm, function () { move(k); }, 'is-small'); });
    var rm = btn(tb, 'lift', function () { if (sel) { delete place[sel]; saveNotesSoon(); redraw(); } }, 'is-small is-dim');
    var stage = make('div', 'rx-hex', wp);
    stage.setAttribute('role', 'grid');
    stage.setAttribute('aria-label', 'the hex board');
    var warn = make('p', 'rx-dim', wp);
    make('p', 'rx-dim', wp, 'keys: r / shift+r rotate, arrows move (shift with up / down for the other diagonal), delete lifts.');
    if (board.read) make('p', 'rx-p rx-note', wp, board.read);

    var radius = board.radius | 0;
    var cells = HX.spiral(radius);
    var K = function (q, r) { return q + ',' + r; };
    var given = {}, blocked = {}, lit = {};
    (board.given || []).forEach(function (c) { given[K(c.q, c.r)] = String(c.g); });
    (board.blocked || []).forEach(function (c) { blocked[K(c.q, c.r)] = 1; });
    (board.lit || []).forEach(function (c) { lit[K(c.q, c.r)] = 1; });
    var btns = {};
    var fragById = {};
    list.forEach(function (a) { fragById[frags[a].id || a] = { area: a, frag: frags[a] }; });

    list.forEach(function (a) {
      var fr = frags[a], id = fr.id || a;
      var b = make('button', 'rx-frag', fl);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      make('span', 'rx-area', b, u.AREA_NAME[a] || a);
      make('pre', 'rx-frag-pre', b, u.asciiHex(fr.cells));
      b.setAttribute('data-id', id);
      b.addEventListener('click', function () { select(sel === id ? null : id); });
    });

    function cellsOf(id) {
      var x = fragById[id], p = place[id];
      if (!x || !p) return [];
      var cs = x.frag.cells, o = cs[0];
      return cs.map(function (c) {
        var rel = HX.rot([c.q - o.q, c.r - o.r], p.rot | 0);
        return { q: rel[0] + p.q, r: rel[1] + p.r, g: String(c.g) };
      });
    }
    function select(id) {
      sel = id;
      var bs = fl.querySelectorAll('.rx-frag');
      for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', bs[i].getAttribute('data-id') === id ? 'true' : 'false');
      selNote.textContent = id ? (u.AREA_NAME[fragById[id].area] || fragById[id].area) + ' selected' + (place[id] ? '' : ': pick a cell to lay it down') : 'pick a fragment, then a cell.';
      redraw();
    }
    function turn(k) {
      if (!sel || !place[sel]) return;
      place[sel].rot = ((place[sel].rot | 0) + k) % 6;
      saveNotesSoon();
      redraw();
    }
    function move(k) {
      if (!sel || !place[sel]) return;
      place[sel].q += DIRS[k][0];
      place[sel].r += DIRS[k][1];
      saveNotesSoon();
      redraw();
    }
    function size() {
      var w = Math.min(stage.parentNode.clientWidth || 320, 520);
      return Math.max(14, Math.min(30, Math.floor(w / (SQ3 * (2 * radius + 1)) - 0.5)));
    }
    function build() {
      stage.textContent = '';
      btns = {};
      var s = size(), W = SQ3 * s, Hh = 2 * s;
      var span = (2 * radius + 1);
      stage.style.width = Math.ceil(W * span) + 'px';
      stage.style.height = Math.ceil(1.5 * s * 2 * radius + Hh) + 'px';
      stage.style.setProperty('--hx-w', W.toFixed(2) + 'px');
      stage.style.setProperty('--hx-h', Hh.toFixed(2) + 'px');
      stage.style.fontSize = Math.max(11, Math.round(s * 0.62)) + 'px';
      cells.forEach(function (c, i) {
        var k = K(c[0], c[1]);
        var b = make('button', 'rx-hx', stage);
        b.type = 'button';
        b.setAttribute('data-k', k);
        b.setAttribute('role', 'gridcell');
        var x = s * SQ3 * (c[0] + c[1] / 2) + (W * span) / 2 - W / 2;
        var y = s * 1.5 * (c[1] + radius);
        b.style.left = x.toFixed(1) + 'px';
        b.style.top = y.toFixed(1) + 'px';
        make('i', null, b);
        make('span', null, b);
        b.tabIndex = i === 0 ? 0 : -1;
        b.addEventListener('click', function () { tap(c); });
        btns[k] = b;
      });
      redraw();
    }
    function tap(c) {
      if (sel && !place[sel]) {
        place[sel] = { q: c[0], r: c[1], rot: 0 };
        saveNotesSoon();
        select(sel);
        return;
      }
      // pick up whatever lies there, or move the selection to it
      var here = Object.keys(place).filter(function (id) {
        return fragById[id] && cellsOf(id).some(function (x) { return x.q === c[0] && x.r === c[1]; });
      });
      if (here.length && here.indexOf(sel) < 0) { select(here[here.length - 1]); return; }
      if (sel && place[sel]) { place[sel].q = c[0]; place[sel].r = c[1]; saveNotesSoon(); redraw(); }
    }
    function redraw() {
      var cover = {}, off = 0, bad = 0;
      Object.keys(place).forEach(function (id) {
        if (!fragById[id]) return;
        cellsOf(id).forEach(function (x) {
          var k = K(x.q, x.r);
          if (HX.dist([x.q, x.r]) > radius) { off++; return; }
          (cover[k] = cover[k] || []).push({ id: id, g: x.g });
        });
      });
      Object.keys(btns).forEach(function (k) {
        var b = btns[k], cv = cover[k] || [], g = '';
        var cls = ['rx-hx'];
        if (lit[k]) cls.push('is-lit');
        if (blocked[k]) cls.push('is-blocked');
        if (own(given, k)) { cls.push('is-given'); g = given[k]; }
        var gs = cv.map(function (x) { return x.g; });
        if (own(given, k)) gs.push(given[k]);
        var uniq = gs.filter(function (x, i) { return gs.indexOf(x) === i; });
        if (cv.length) cls.push('is-on');
        if (cv.some(function (x) { return x.id === sel; })) cls.push('is-sel');
        if (uniq.length > 1 || (cv.length && blocked[k])) { cls.push('is-bad'); bad++; g = '!'; }
        else if (uniq.length) g = uniq[0];
        b.className = cls.join(' ');
        b.lastChild.textContent = g;
        b.setAttribute('aria-label', 'cell ' + k + (lit[k] ? ', lit' : '') + (blocked[k] ? ', blocked' : '') +
          (own(given, k) ? ', given' : '') + (g ? ', ' + (g === '!' ? 'conflict' : g) : ', empty'));
      });
      warn.textContent = (off ? off + ' cell' + (off > 1 ? 's' : '') + ' off the board. ' : '') + (bad ? bad + ' cell' + (bad > 1 ? 's' : '') + ' in conflict.' : '');
      var on = !!(sel && place[sel]);
      rotL.disabled = rotR.disabled = rm.disabled = !on;
      moves.forEach(function (m) { m.disabled = !on; });
    }
    stage.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'r' || k === 'R') { e.preventDefault(); turn(e.shiftKey || k === 'R' ? 5 : 1); return; }
      if (k === 'Delete' || k === 'Backspace') { if (sel) { e.preventDefault(); delete place[sel]; saveNotesSoon(); redraw(); } return; }
      var dir = k === 'ArrowRight' ? 0 : k === 'ArrowLeft' ? 3 : k === 'ArrowUp' ? (e.shiftKey ? 2 : 1) : k === 'ArrowDown' ? (e.shiftKey ? 5 : 4) : -1;
      if (dir < 0) return;
      e.preventDefault();
      if (sel && place[sel]) { move(dir); return; }
      // no piece in hand: arrows walk the focus over the board
      var cur = document.activeElement && document.activeElement.getAttribute('data-k');
      if (!cur) return;
      var p = cur.split(',').map(Number), nx = [p[0] + DIRS[dir][0], p[1] + DIRS[dir][1]];
      var nb2 = btns[K(nx[0], nx[1])];
      if (nb2) {
        Object.keys(btns).forEach(function (kk) { btns[kk].tabIndex = -1; });
        nb2.tabIndex = 0;
        nb2.focus();
      }
    });

    if (radius > 0) build(); else make('p', 'rx-dim', wp, 'the board has not arrived.');
    return { resize: function () { if (radius > 0) build(); } };
  };

  /* planchette: budget, composer, transcript, grid editor, seals */
  RENDER.planchette = function (el, j) {
    var d = j.data || {};
    lines(el, d.intro);
    var rows = d.rows | 0, cols = d.cols | 0, al = typeof d.alphabet === 'string' ? d.alphabet : '';
    var s = stateOf(j.id);
    if (Array.isArray(d.rules) && d.rules.length) { var rp = panel(el, 'rules'); lines(rp, d.rules); }
    if (Array.isArray(d.silence) && d.silence.length) { var sp = panel(el, 'silence'); lines(sp, d.silence); }
    if (Array.isArray(d.board) && d.board.length) pre(el, d.board, 'rx-art');

    var td = d.today || {};
    var tp = panel(el, 'today', 'rx-today');
    var budget = make('p', 'rx-p', tp);
    function drawBudget(t) {
      budget.textContent = 'day ' + t.day + ' · asked ' + (t.used | 0) + ' · left ' + (t.left | 0) + (t.carried ? ' (with ' + t.carried + ' carried)' : '');
    }
    drawBudget(td);
    if (td.closed) make('p', 'rx-dim', tp, 'the board rests until the next utc day.');
    if (td.commit) make('p', 'rx-dim rx-mono', tp, 'today’s seal ' + String(td.commit).slice(0, 16) + '…');

    var cells = [];
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) cells.push(ROWL.charAt(r) + (c + 1));

    // the composer: pick the parts, or type the question
    var cp = panel(el, 'ask', 'rx-ask');
    if (j.state !== 'open') make('p', 'rx-dim', cp, 'the planchette is still.');
    var form = make('div', 'rx-compose', cp);
    var kind = selectOf(form, 'form', [
      ['cell', 'is <cell> <glyph>'], ['set', 'is <cell> in <glyphs>'], ['same', 'is <cell> same <cell>'],
      ['or', 'is <cell> <glyph> or <cell> <glyph>'], ['count', 'count <glyph> in ...'], ['order', 'in row / col ... left of / above ...']
    ]);
    var parts = make('div', 'rx-row rx-parts', form);
    var q = make('input', 'hunt-in rx-q', cp);
    q.type = 'text';
    q.maxLength = 120;
    q.spellcheck = false;
    q.setAttribute('aria-label', 'the question');
    var askRow = make('div', 'rx-row', cp);
    var ask = btn(askRow, 'ask', null, 'is-hi');
    var said = make('p', 'rx-say', cp);
    said.setAttribute('aria-live', 'polite');
    ask.disabled = j.state !== 'open';

    function selectOf(parent, label, opts) {
      var lab = make('label', 'rx-pick', parent);
      make('span', 'sr', lab, label);
      var se = make('select', 'hunt-sel', lab);
      opts.forEach(function (o) { var op = make('option', null, se, o[1]); op.value = o[0]; });
      se.addEventListener('change', compose);
      return se;
    }
    function opt(list) { return list.map(function (x) { return [x, x]; }); }
    var P = {};
    function buildParts() {
      parts.textContent = '';
      P = {};
      var k = kind.value;
      var gl = opt(al.split(''));
      var rl = opt(ROWL.slice(0, rows).split('')), cl = [];
      for (var i = 1; i <= cols; i++) cl.push([String(i), String(i)]);
      if (k === 'cell') { P.c1 = selectOf(parts, 'cell', opt(cells)); P.g1 = selectOf(parts, 'glyph', gl); }
      if (k === 'set') {
        P.c1 = selectOf(parts, 'cell', opt(cells));
        P.set = make('span', 'rx-set', parts);
        P.set.setAttribute('role', 'group');
        P.set.setAttribute('aria-label', 'glyphs');
        al.split('').forEach(function (g) {
          var b = btn(P.set, g, function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); compose(); }, 'is-small rx-g');
          b.setAttribute('aria-pressed', 'false');
          b.setAttribute('data-g', g);
        });
      }
      if (k === 'same') { P.c1 = selectOf(parts, 'cell', opt(cells)); P.c2 = selectOf(parts, 'cell', opt(cells)); P.c2.selectedIndex = Math.min(1, cells.length - 1); }
      if (k === 'or') {
        P.c1 = selectOf(parts, 'cell', opt(cells)); P.g1 = selectOf(parts, 'glyph', gl);
        P.c2 = selectOf(parts, 'cell', opt(cells)); P.g2 = selectOf(parts, 'glyph', gl);
        P.c2.selectedIndex = Math.min(1, cells.length - 1);
      }
      if (k === 'count') {
        P.g1 = selectOf(parts, 'glyph', gl);
        P.sc = selectOf(parts, 'where', [['row', 'in row'], ['col', 'in col'], ['all', 'in all']]);
        P.rr = selectOf(parts, 'row', rl);
        P.cc = selectOf(parts, 'col', cl);
        P.cmp = selectOf(parts, 'comparison', [['is', 'is'], ['over', 'over'], ['under', 'under']]);
        var nn = [];
        for (var x = 0; x <= rows * cols; x++) nn.push([String(x), String(x)]);
        P.n = selectOf(parts, 'number', nn);
      }
      if (k === 'order') {
        P.sc = selectOf(parts, 'where', [['row', 'in row'], ['col', 'in col']]);
        P.rr = selectOf(parts, 'row', rl);
        P.cc = selectOf(parts, 'col', cl);
        P.g1 = selectOf(parts, 'glyph', gl);
        P.g2 = selectOf(parts, 'glyph', gl);
        P.g2.selectedIndex = Math.min(1, al.length - 1);
      }
      compose();
    }
    function compose() {
      var k = kind.value, t = '';
      if (P.sc) {
        P.rr.parentNode.hidden = P.sc.value !== 'row';
        P.cc.parentNode.hidden = P.sc.value !== 'col';
      }
      if (k === 'cell') t = 'is ' + P.c1.value + ' ' + P.g1.value;
      else if (k === 'set') {
        var gs = '';
        var bs = P.set.querySelectorAll('button[aria-pressed="true"]');
        for (var i = 0; i < bs.length; i++) gs += bs[i].getAttribute('data-g');
        t = 'is ' + P.c1.value + ' in ' + gs;
      } else if (k === 'same') t = 'is ' + P.c1.value + ' same ' + P.c2.value;
      else if (k === 'or') t = 'is ' + P.c1.value + ' ' + P.g1.value + ' or ' + P.c2.value + ' ' + P.g2.value;
      else if (k === 'count') t = 'count ' + P.g1.value + ' in ' + (P.sc.value === 'row' ? 'row ' + P.rr.value : P.sc.value === 'col' ? 'col ' + P.cc.value : 'all') + ' ' + P.cmp.value + ' ' + P.n.value;
      else if (k === 'order') t = P.sc.value === 'row' ? 'in row ' + P.rr.value + ' is ' + P.g1.value + ' left of ' + P.g2.value : 'in col ' + P.cc.value + ' is ' + P.g1.value + ' above ' + P.g2.value;
      q.value = t;
    }
    kind.removeEventListener('change', compose);
    kind.addEventListener('change', buildParts);
    if (rows && cols && al) buildParts();

    function askNow() {
      var text = q.value.trim();
      if (!text || ask.disabled) return;
      ask.disabled = true;
      said.textContent = 'listening...';
      h.call('ask', { q: text }, { f: R.f }).then(function (a) {
        ask.disabled = j.state !== 'open';
        if (!a || !a.ok) { said.textContent = (a && a.say) || 'that did not come through.'; return; }
        said.textContent = '';
        make('b', 'rx-ans', said, a.a);
        make('span', 'rx-dim', said, '  ' + (a.canon || text));
        var tr = store('ask') || [];
        tr.push({ day: a.day, i: a.i, q: a.canon || text, a: a.a, commit: a.commit });
        put('ask', tr.slice(-2000));
        drawBudget({ day: a.day, used: a.used, left: a.left, carried: td.carried });
        drawTranscript();
      });
    }
    ask.addEventListener('click', askNow);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); askNow(); } });

    var tp2 = panel(el, 'transcript', 'rx-transcript');
    var tbody = make('div', null, tp2);
    function drawTranscript() {
      tbody.textContent = '';
      var tr = store('ask') || [];
      if (!tr.length) { make('p', 'rx-dim', tbody, 'no questions yet.'); return; }
      var byDay = {};
      tr.forEach(function (x) { (byDay[x.day] = byDay[x.day] || []).push(x); });
      Object.keys(byDay).map(Number).sort(function (a, b) { return b - a; }).forEach(function (dd) {
        var det = make('details', 'rx-det', tbody);
        if (dd === td.day) det.open = true;
        var list = byDay[dd];
        make('summary', null, det, 'day ' + dd + ' · ' + list.length + ' asked');
        var ol = make('ol', 'rx-tr', det);
        list.forEach(function (x) {
          var li = make('li', null, ol);
          make('span', 'rx-tr-i', li, '#' + ((x.i | 0) + 1));
          make('span', 'rx-tr-q', li, x.q);
          make('b', 'rx-ans', li, x.a);
        });
        if (list[0] && list[0].commit) make('p', 'rx-dim rx-mono', det, 'seal ' + String(list[0].commit).slice(0, 24) + '…');
      });
    }
    drawTranscript();

    // the grid editor
    var gp = panel(el, 'your grid', 'rx-gridp');
    var nn2 = nb(j.id);
    var total = rows * cols;
    var g0 = typeof nn2.grid === 'string' && nn2.grid.length === total ? nn2.grid.split('') : new Array(total + 1).join('.').split('');
    var giv = {};
    (Array.isArray(d.givens) ? d.givens : []).forEach(function (x) { giv[x.r * cols + x.c] = String(x.g); g0[x.r * cols + x.c] = String(x.g); });
    var tbl = make('div', 'rx-pg', gp);
    tbl.setAttribute('role', 'grid');
    tbl.setAttribute('aria-label', 'your grid');
    tbl.style.gridTemplateColumns = '22px repeat(' + cols + ', minmax(34px, 44px))';
    var gb = [];
    make('span', 'rx-pg-h', tbl, '');
    for (var cc = 0; cc < cols; cc++) make('span', 'rx-pg-h', tbl, String(cc + 1));
    for (var rr = 0; rr < rows; rr++) {
      make('span', 'rx-pg-h', tbl, ROWL.charAt(rr));
      for (var c2 = 0; c2 < cols; c2++) {
        (function (idx) {
          var b = make('button', 'rx-pg-c' + (own(giv, idx) ? ' is-given' : ''), tbl);
          b.type = 'button';
          b.setAttribute('role', 'gridcell');
          b.tabIndex = idx === 0 ? 0 : -1;
          b.addEventListener('click', function () {
            if (own(giv, idx)) return;
            var cur = al.indexOf(g0[idx]);
            g0[idx] = cur + 1 >= al.length ? '.' : al.charAt(cur + 1);
            paint();
          });
          b.addEventListener('keydown', function (e) {
            var k = e.key, r0 = Math.floor(idx / cols), c0 = idx % cols, to = -1;
            if (k === 'ArrowRight') to = c0 + 1 < cols ? idx + 1 : -1;
            else if (k === 'ArrowLeft') to = c0 > 0 ? idx - 1 : -1;
            else if (k === 'ArrowDown') to = r0 + 1 < rows ? idx + cols : -1;
            else if (k === 'ArrowUp') to = r0 > 0 ? idx - cols : -1;
            else if (!own(giv, idx) && (k === 'Backspace' || k === 'Delete' || k === '.' || k === ' ')) { e.preventDefault(); g0[idx] = '.'; paint(); return; }
            else if (!own(giv, idx) && k.length === 1 && al.indexOf(k) >= 0) { e.preventDefault(); g0[idx] = k; paint(); return; }
            else if (!own(giv, idx) && /^[1-9]$/.test(k) && +k <= al.length) { e.preventDefault(); g0[idx] = al.charAt(+k - 1); paint(); return; }
            else return;
            e.preventDefault();
            if (to >= 0) { gb[idx].tabIndex = -1; gb[to].tabIndex = 0; gb[to].focus(); }
          });
          gb[idx] = b;
        })(rr * cols + c2);
      }
    }
    var gnote = make('p', 'rx-dim', gp, 'click a cell to cycle its glyph, or focus it and type the glyph (or 1-' + al.length + '). givens are fixed.');
    void gnote;
    var gbar = make('div', 'rx-row', gp);
    var send = btn(gbar, 'transmit the grid', function () {
      if (g0.indexOf('.') >= 0) return;
      send.disabled = true;
      transmit(j.id, g0.join(''), gout, function () { send.disabled = false; paint(); });
    }, 'is-hi');
    btn(gbar, 'clear', function () {
      for (var i = 0; i < total; i++) if (!own(giv, i)) g0[i] = '.';
      paint();
    }, 'is-dim');
    var gout = make('p', 'rx-say', gp);
    gout.setAttribute('aria-live', 'polite');
    if (s && s.answers && typeof s.answers.left === 'number') make('p', 'rx-dim', gp, s.answers.left + ' grid guesses left today.');
    function paint() {
      var dup = {};
      if (d.latin) {
        for (var i = 0; i < total; i++) {
          if (g0[i] === '.') continue;
          for (var k2 = 0; k2 < total; k2++) {
            if (k2 === i || g0[k2] !== g0[i]) continue;
            if (Math.floor(k2 / cols) === Math.floor(i / cols) || k2 % cols === i % cols) { dup[i] = 1; break; }
          }
        }
      }
      for (var x = 0; x < total; x++) {
        var b = gb[x];
        b.textContent = g0[x] === '.' ? '·' : g0[x];
        b.classList.toggle('is-dup', !!dup[x]);
        b.setAttribute('aria-label', ROWL.charAt(Math.floor(x / cols)) + (x % cols + 1) + ': ' + (g0[x] === '.' ? 'empty' : g0[x]) + (own(giv, x) ? ', given' : '') + (dup[x] ? ', repeats' : ''));
      }
      nn2.grid = g0.join('');
      saveNotesSoon();
      send.disabled = j.state !== 'open' || g0.indexOf('.') >= 0;
    }
    paint();

    // after solving: open the daily seals and check them against the transcript
    if (j.state === 'solved' || j.late) {
      var sealP = panel(el, 'the seals', 'rx-seals');
      make('p', 'rx-dim', sealP, 'every day’s lie was fixed before you asked. check it.');
      var so = make('div', null, sealP);
      btn(sealP, 'check the seals', function () {
        so.textContent = 'listening...';
        h.call('reveal', {}, { f: R.f }).then(function (rv) {
          so.textContent = '';
          if (!rv || !rv.ok) { make('p', 'rx-say', so, (rv && rv.say) || 'not yet.'); return; }
          var tr = store('ask') || [];
          var days = Array.isArray(rv.days) ? rv.days : [];
          if (!days.length) { make('p', 'rx-dim', so, 'no sealed days to check.'); return; }
          days.forEach(function (x) {
            var line = make('p', 'rx-p', so, 'day ' + x.day + ' · checking...');
            var mine = tr.filter(function (t) { return t.day === x.day; });
            u.sha256hex('lie|' + R.f + '|' + x.day + '|' + x.slot + '|' + x.salt).then(function (hh) {
              var c = mine[0] && mine[0].commit;
              var lie = mine.filter(function (t) { return (t.i | 0) === x.slot; })[0];
              var what = x.slot >= (d.perDay | 0) ? 'no lie that day' :
                lie ? (lie.a === 'silence' ? 'the lie fell on a silence: no lie that day' : 'the keeper answered #' + (x.slot + 1) + ' (' + lie.q + ')') : 'the lie slot was never reached';
              line.textContent = 'day ' + x.day + ' · ' + (!c ? 'no seal kept here' : c === hh ? 'the seal holds' : 'the seal does not match') + ' · ' + what;
            }, function () { line.textContent = 'day ' + x.day + ' · the seals cannot be checked in this browser'; });
          });
        });
      });
    }
    return null;
  };

  /* run: rings and goals per device, pars, practice here, ranked at a dead end */
  function deviceNow() { return u.coarse() ? 'touch' : 'key'; }
  var DEVNAME = { key: 'keys', touch: 'touch' };
  function deadEnd(parent, type) {
    var p = panel(parent, type === 'final' ? 'the real run' : 'ranked', 'rx-ranked');
    var a = make('a', 'hunt-btn is-hi rx-link', p, type === 'final' ? 'go to a dead end' : 'ranked: go to a dead end');
    a.href = u.BASE + 'dead-end';
    make('p', 'rx-dim', p, 'on any missing page, press left or right (or swipe) to wake the snake. ranked runs are replayed by the server' +
      (type === 'final' ? '.' : '; a clear under par lights a lantern.'));
  }
  function practicePanel(parent, j) {
    var p = panel(parent, 'practice here', 'rx-practice');
    var bar = make('div', 'rx-row', p);
    var dev = deviceNow();
    var lab = make('label', 'rx-pick', bar);
    make('span', null, lab, 'input ');
    var se = make('select', 'hunt-sel', lab);
    ['key', 'touch'].forEach(function (k) { var o = make('option', null, se, DEVNAME[k]); o.value = k; });
    se.value = dev;
    var host = make('div', 'rx-run-host', p);
    var go = btn(bar, 'practice', function () {
      if (R.practice) { R.practice.stop(); R.practice = null; go.textContent = 'practice'; return; }
      go.disabled = true;
      Promise.all([u.loadScript('hunt-sim.js', 'huntSim'), u.loadScript('hunt-run.js', 'huntRun')]).then(function () {
        go.disabled = false;
        go.textContent = 'close practice';
        R.practice = window.huntRun.mount(host, {
          stage: j.id, type: j.type, mode: 'practice', data: j.data, device: se.value, f: R.f,
          lat: u.bestLat(R.f, se.value) || 0, startRing: 0, onEnd: function () { bestLine(); }
        });
      }, function () {
        go.disabled = false;
        host.textContent = 'the practice field could not load.';
      });
    }, 'is-hi');
    var best = make('p', 'rx-dim', p);
    function bestLine() {
      var b = (store('best') || {})[j.id] || {};
      var t = [];
      if (b.practice) t.push('best practice: ' + b.practice.rings + ' rings, ' + mmss(b.practice.ms));
      if (b.ranked) t.push('best ranked: ' + b.ranked.rings + ' rings, ' + mmss(b.ranked.ms));
      best.textContent = t.join(' · ');
    }
    bestLine();
    make('p', 'rx-dim', p, 'practice is local and unlimited: pick the starting ring, pause any time.');
  }

  RENDER.run = function (el, j) {
    var d = j.data || {};
    var dev = deviceNow();
    make('p', 'rx-note-b', el, 'desktop recommended.' + (dev === 'touch' ? ' touch has its own goals and pars.' : ''));
    lines(el, d.intro);
    var rp = panel(el, 'rings', 'rx-rings');
    var ol = make('ol', 'rx-ringlist', rp);
    (Array.isArray(d.rings) ? d.rings : []).forEach(function (r, i) {
      var li = make('li', null, ol);
      make('span', 'rx-ring-n', li, 'ring ' + (i + 1));
      make('span', 'rx-ring-rule', li, r.rule || '');
      var g = r.goal || {};
      ['key', 'touch'].forEach(function (k) {
        if (g[k] == null) return;
        var s = make('span', 'rx-ring-goal' + (k === dev ? ' is-mine' : ''), li, DEVNAME[k] + ': ' + g[k]);
        void s;
      });
    });
    var pp = panel(el, 'pace', 'rx-pace');
    ['key', 'touch'].forEach(function (k) {
      var parts = [DEVNAME[k]];
      if (d.tickMs && d.tickMs[k]) parts.push('a step every ' + d.tickMs[k] + ' ms');
      if (d.pars && d.pars[k]) parts.push('par ' + mmss(d.pars[k]));
      make('p', 'rx-p' + (k === dev ? '' : ' rx-dim'), pp, parts.join(' · '));
    });
    var lt = d.lanterns || (R.st && R.st.lanterns);
    if (lt) make('p', 'rx-dim', pp, 'lanterns lit: ' + (lt.have | 0) + ' · used: ' + (lt.used | 0));
    if (d.practice !== 0) practicePanel(el, j);
    if (j.state === 'open' || j.late) deadEnd(el, 'run');
    return null;
  };

  RENDER.final = function (el, j) {
    var d = j.data || {};
    var dev = deviceNow();
    make('p', 'rx-note-b', el, 'desktop recommended.');
    lines(el, d.intro);
    if (Array.isArray(d.marks) && d.marks.length) { var mp = panel(el, 'marks'); lines(mp, d.marks); }
    var ap = panel(el, 'the field', 'rx-field');
    if (d.floor && typeof d.floor.day === 'number') {
      if (d.floor.ok) make('p', 'rx-p', ap, 'the field accepts runs.');
      else {
        var fl = make('p', 'rx-p', ap, 'the field opens on day ' + d.floor.day);
        var at = dayStart(d.floor.day);
        if (at) { fl.appendChild(document.createTextNode(' (' + utcDate(at) + ' 00:00 utc, ')); countdown(fl, at, 'in ', 'now'); fl.appendChild(document.createTextNode(')')); }
      }
    }
    if (d.attempts) {
      var at2 = make('p', 'rx-p', ap, 'attempts left today: ' + (d.attempts.left | 0));
      if (d.attempts.cooldownUntil && d.attempts.cooldownUntil > u.now()) {
        at2.appendChild(document.createTextNode(' · settling, '));
        countdown(at2, d.attempts.cooldownUntil, '', 'settled');
      }
    }
    if (d.tickMs) {
      ['key', 'touch'].forEach(function (k) {
        if (d.tickMs[k]) make('p', 'rx-p' + (k === dev ? '' : ' rx-dim'), ap, DEVNAME[k] + ' · a step every ' + d.tickMs[k] + ' ms');
      });
    }
    var gloss = Array.isArray(d.gloss) && d.gloss.length ? d.gloss : store('gloss');
    if (Array.isArray(gloss) && gloss.length) {
      if (Array.isArray(d.gloss) && d.gloss.length) put('gloss', d.gloss);
      var gp = panel(el, 'what the rulebook means', 'rx-gloss');
      lines(gp, gloss);
    }
    var cp = panel(el, 'calibration', 'rx-cal');
    var lat = make('p', 'rx-dim', cp);
    var showLat = function () {
      var a = u.bestLat(R.f, 'key'), b = u.bestLat(R.f, 'touch');
      lat.textContent = 'grace: keys ' + (a == null ? 'not set' : a + ' ms') + ' · touch ' + (b == null ? 'not set' : b + ' ms');
    };
    showLat();
    var calHost = make('div', 'rx-run-host', cp);
    btn(cp, 'calibrate', function () {
      u.loadScript('hunt-run.js', 'huntRun').then(function () {
        calHost.textContent = '';
        window.huntRun.calibrate(calHost, function (ms) {
          if (typeof ms === 'number') u.saveLat(R.f, deviceNow(), ms);
          showLat();
        });
      });
    });
    practicePanel(el, j);
    if (j.state === 'open' || j.late) deadEnd(el, 'final');
    return null;
  };

  /* ---------- side panels ---------- */

  function lanternPanel(parent) {
    var lt = R.st.lanterns;
    if (!lt || (!lt.have && !lt.used)) {
      if (R.st.unlit === false) make('p', 'rx-dim rx-side-note', parent, 'echoes used: the certificate will not be unlit.');
      return;
    }
    var p = panel(parent, 'lanterns', 'rx-lant');
    make('p', 'rx-p', p, (lt.have | 0) + ' lit · ' + (lt.used | 0) + ' used');
    make('p', 'rx-dim', p, R.st.unlit ? 'unlit so far.' : 'echoes used: the certificate will not be unlit.');
  }

  function wallPanel(parent) {
    var w = R.st.wall || {};
    var st = u.status();
    var wall = (st && Array.isArray(st.wall)) ? st.wall : [];
    if (!w.eligible && !w.signed && !wall.length) return;
    var p = panel(parent, 'the wall', 'rx-wall');
    if (wall.length) {
      var ol = make('ol', 'rx-walllist', p);
      wall.forEach(function (x) { make('li', null, ol, x.h + '  day ' + x.day); });
    }
    if (w.signed) { make('p', 'rx-dim', p, 'your handle is on the wall.'); return; }
    if (!w.eligible) return;
    make('p', 'rx-dim', p, 'three letters, a-z. optional, public, permanent.');
    var row = make('form', 'rx-row', p);
    var inp = make('input', 'hunt-in rx-handle', row);
    inp.maxLength = 3;
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.setAttribute('aria-label', 'your three-letter handle');
    var go = make('button', 'hunt-btn is-hi', row, 'sign');
    go.type = 'submit';
    var out = make('p', 'rx-say', p);
    row.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = inp.value.toUpperCase();
      if (!/^[A-Z]{3}$/.test(v)) { out.textContent = 'three letters, a-z.'; return; }
      go.disabled = true;
      h.call('wall', { handle: v }, { f: R.f }).then(function (j) {
        go.disabled = false;
        out.textContent = (j && j.say) || (j && j.ok ? 'signed.' : 'that did not come through.');
        if (j && j.ok) { u.refresh(); loadState(true); }
      });
    });
  }

  function tallyPanel(parent) {
    var t = R.st.tally || {};
    if (!t.open || t.voted) return;
    var opts = Array.isArray(t.options) ? t.options : [];
    if (!opts.length) return;
    var p = panel(parent, 'an ending', 'rx-tally');
    var out = make('p', 'rx-say', p);
    opts.forEach(function (o) {
      btn(p, o.text || o.id, function () {
        h.call('tally', { choice: o.id }, { f: R.f }).then(function (j) {
          out.textContent = (j && j.say) || (j && j.ok ? 'kept.' : 'that did not come through.');
          if (j && j.ok) loadState(true);
        });
      });
    });
  }

  function walkPanel(parent) {
    var st = u.status();
    var c = st && Array.isArray(st.cold) ? st.cold.filter(function (x) { return x.f === R.f; })[0] : null;
    if (!c || !c.walk) return;
    var p = panel(parent, 'the walkthrough', 'rx-walk');
    make('p', 'rx-dim', p, 'this frequency has gone cold. the method of every stage, with your own receiver’s details.');
    var out = make('div', null, p);
    btn(p, 'open it', function () {
      out.textContent = 'listening...';
      h.call('walkthrough', { f: R.f }, { f: R.f }).then(function (j) {
        out.textContent = '';
        if (!j || !j.ok) { make('p', 'rx-say', out, (j && j.say) || 'not yet.'); return; }
        (j.stages || []).forEach(function (s) {
          var det = make('details', 'rx-det', out);
          make('summary', null, det, s.id + ' · ' + (s.title || ''));
          make('p', 'rx-p rx-pre-wrap', det, s.method || '');
          if (s.detail) make('p', 'rx-p rx-pre-wrap', det, s.detail);
        });
      });
    });
  }

  function receiverPanel(parent) {
    var p = panel(parent, 'receiver', 'rx-recv');
    var pass = u.passFor(R.f);
    var pl = u.passPayload(pass || '');
    make('p', 'rx-dim', p, R.f + (pl && pl.sb ? ' · sandbox' : '') + (pl && typeof pl.d === 'number' ? ' · tuned in on day ' + pl.d : ''));
    var out = make('div', 'rx-recv-out', p);
    var bar = make('div', 'rx-row', p);
    btn(bar, 'export', function () {
      out.textContent = '';
      make('p', 'rx-dim', out, 'your receiver. paste it on another browser’s /rx/ to carry on there. keep it private.');
      var ta = textBox(out, u.passFor(R.f) || '', 3);
      var note = make('p', 'rx-dim', out);
      btn(out, 'copy', function () { copy(ta.value, note); }, 'is-small');
      markSaved();
    }, 'is-small');
    btn(bar, 'import', function () {
      out.textContent = '';
      var ta = make('textarea', 'hunt-ta', out);
      ta.rows = 3;
      ta.spellcheck = false;
      ta.setAttribute('aria-label', 'receiver string');
      var note = make('p', 'rx-say', out);
      btn(out, 'load', function () {
        var s = ta.value.replace(/\s+/g, '');
        var pp = u.passPayload(s);
        if (!pp) { note.textContent = 'that is not a receiver.'; return; }
        u.storePass(s);
        u.dropState();
        note.textContent = 'loaded.';
        setTimeout(restart, 300);
      }, 'is-small is-hi');
    }, 'is-small');
    btn(bar, 'recovery code', function () {
      out.textContent = '';
      var c = h.code();
      if (!c) { make('p', 'rx-dim', out, 'no code for this receiver.'); return; }
      make('p', 'rx-code', out, group4(c));
      make('p', 'rx-dim', out, 'this code is as private as the receiver itself: anyone who has it can spend your attempts. it brings the receiver back while the frequency is live.');
      var note = make('p', 'rx-dim', out);
      var b2 = make('div', 'rx-row', out);
      btn(b2, 'copy', function () { copy(c, note); }, 'is-small');
      btn(b2, 'hide', function () { out.textContent = ''; }, 'is-small is-dim');
      markSaved();
    }, 'is-small');
    forgetPanel(p);
  }

  function forgetPanel(parent) {
    var bar = make('div', 'rx-row', parent);
    var b = btn(bar, 'forget this receiver', function () {
      if (!b.classList.contains('is-arm')) {
        b.classList.add('is-arm');
        b.textContent = 'sure? forget ' + R.f + ' in this browser';
        return;
      }
      ['pass', 'cert', 'tape', 'frags', 'ask', 'notes', 'best', 'gloss', 'saved'].forEach(function (k) { u.lsSet('hunt.' + k + '.' + R.f, null); });
      u.dropState();
      u.verifyAll();
      R.f = null;
      restart();
    }, 'is-small is-dim');
  }

  function certPanels(parent, st) {
    var ks = u.lsKeys('hunt.cert.');
    var want = st && st.cert && R.f && !u.lsGet('hunt.cert.' + R.f);
    if (!ks.length && !want) return;
    var p = panel(parent, 'certificate', 'rx-cert');
    ks.forEach(function (k) {
      var f = k.slice(10), str = u.lsGet(k), pl = u.certPayload(str || '');
      if (!pl) return;
      var row = make('div', 'rx-cert-row', p);
      var ok = h.cert(f);
      var t = make('p', 'rx-p', row, f + ' · day ' + pl.day + (pl.unlit ? ' · unlit' : '') + (pl.late ? ' · late' : '') + (pl.sb ? ' · sandbox' : ''));
      tag(t, ok ? 'verified' : 'unverified', ok ? 'is-hi' : '');
      var out = make('div', null, row);
      var bar = make('div', 'rx-row', row);
      btn(bar, 'export', function () {
        out.textContent = '';
        var ta = textBox(out, str, 3);
        var note = make('p', 'rx-dim', out);
        btn(out, 'copy', function () { copy(ta.value, note); }, 'is-small');
      }, 'is-small');
      btn(bar, 'check', function () {
        t.lastChild.textContent = 'checking';
        u.verifyAll().then(function () {
          var v = h.cert(f);
          t.lastChild.textContent = v ? 'verified' : 'unverified';
          t.lastChild.className = 'rx-tag' + (v ? ' is-hi' : '');
        });
      }, 'is-small');
    });
    if (want) {
      var bar2 = make('div', 'rx-row', p);
      var note = make('p', 'rx-say', p);
      btn(bar2, 'collect the certificate', function () {
        h.call('cert', {}, { f: R.f }).then(function (j) {
          note.textContent = (j && j.ok) ? 'kept.' : ((j && j.say) || 'not yet.');
          if (j && j.ok) setTimeout(function () { render(); }, 300);
        });
      }, 'is-hi is-small');
    }
    var bar3 = make('div', 'rx-row', p);
    btn(bar3, 'import a certificate', function () {
      var ta = make('textarea', 'hunt-ta', p);
      ta.rows = 3;
      ta.spellcheck = false;
      ta.setAttribute('aria-label', 'certificate string');
      var note2 = make('p', 'rx-say', p);
      btn(p, 'keep', function () {
        var s = ta.value.replace(/\s+/g, '');
        if (!u.certPayload(s)) { note2.textContent = 'that is not a certificate.'; return; }
        u.storeCert(s);
        note2.textContent = 'kept. checking...';
        u.verifyAll().then(function () { if (R.st) render(); else empty(); });
      }, 'is-small is-hi');
    }, 'is-small is-dim');
  }

  window.addEventListener('hunt:cert', function () {
    var tags = document.querySelectorAll('.rx-cert-row .rx-tag');
    if (tags.length && R.st) render();
  });

  /* ---------- after a solve: keep the receiver safe ---------- */

  function solvedIds() {
    return ((R.st && R.st.stages) || []).filter(function (s) { return s.state === 'solved'; }).map(function (s) { return s.id; });
  }
  function markSaved() {
    var ids = solvedIds();
    put('saved', ids);
    var pr = document.querySelector('.rx-prompt');
    if (pr) pr.remove();
  }
  function savePrompt(parent) {
    var saved = store('saved') || [];
    var fresh = solvedIds().filter(function (id) { return saved.indexOf(id) < 0; });
    if (!fresh.length) return;
    var p = make('div', 'rx-prompt', parent);
    p.setAttribute('role', 'note');
    make('p', null, p, 'received. this receiver lives only in this browser: export it, or keep its recovery code.');
    var bar = make('div', 'rx-row', p);
    btn(bar, 'export', function () {
      var b = document.querySelector('.rx-recv .hunt-btn');
      if (b) { b.click(); b.scrollIntoView({ block: 'center', behavior: u.reduced() ? 'auto' : 'smooth' }); }
    }, 'is-small is-hi');
    btn(bar, 'recovery code', function () {
      var bs = document.querySelectorAll('.rx-recv .hunt-btn');
      if (bs[2]) { bs[2].click(); bs[2].scrollIntoView({ block: 'center', behavior: u.reduced() ? 'auto' : 'smooth' }); }
    }, 'is-small');
    btn(bar, 'done', markSaved, 'is-small is-dim');
  }

  h.ready(boot);
})();
