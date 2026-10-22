/* ghost.js: the hidden terminal at /ghost/. Talks to /api/ai on this
   origin (server/ai.mjs), which streams the reply back as server-sent
   events: data: {"t": "..."} chunks, then {"done": true} or {"error": ...}.
   The conversation lives in this page's memory only (never in storage) and
   at most the last 20 messages are sent. Network text is rendered with
   textContent only. Uses window.fx when it is there (mask, glitch,
   reduced motion) and works without it. */
(function () {
  'use strict';

  var root = document.documentElement;
  var log = document.getElementById('gh-log');
  var form = document.getElementById('gh-form');
  var input = document.getElementById('gh-in');
  var sendBtn = document.getElementById('gh-send');
  var sendT = document.getElementById('gh-send-t');
  var count = document.getElementById('gh-count');
  var stateEl = document.getElementById('gh-state');
  var stateT = document.getElementById('gh-state-t');
  var back = document.getElementById('gh-back');
  if (!log || !form || !input) return;

  var MAX_SEND = 20;     // messages per request
  var MAX_CHARS = 4000;  // per message
  var MAX_TOTAL = 24000; // per request
  var RAMP = '.:-=+*#';

  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return window.fx && window.fx.reduced ? window.fx.reduced() : mqReduce.matches; }
  function mask() { return window.fx && window.fx.obj ? window.fx.obj : null; }
  function wake(on) {
    var m = mask();
    if (m && typeof m.wake === 'function') m.wake(on);
    // done talking: one slow blink (it also redraws a still mask on low tier)
    if (!on && m && typeof m.blink === 'function') setTimeout(m.blink, 140);
    root.classList.toggle('gh-speaking', !!on);
  }
  // the mask jerks, and the words that carry the bad news glitch
  function glitch(el) {
    var m = mask();
    if (m && typeof m.glitch === 'function') m.glitch();
    var t = el && el.classList.contains('gh-line') ? el.lastChild : el;
    if (t && window.fx && window.fx.glitch) {
      t.setAttribute('data-text', t.textContent);
      window.fx.glitch(t);
    }
  }

  /* ---------- the hunt ---------- */

  // hunt.js loads after this file and is inert unless a frequency is live
  // or a receiver exists. Nothing from it ever reaches /api/ai: /signal
  // goes to the hunt only, and the solver greeting is chosen here.
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
  function huntLive() { return !!huntDo('live'); }
  function huntTell(surface) { return huntLive() ? huntDo('tell', surface) : null; }

  /* ---------- state ---------- */

  var convo = [];      // {role, content}, what the ghost remembers
  var sent = [];       // the visitor's own lines, for up / down recall
  var recall = -1;
  var awake = false;
  var busy = false;    // a reply is on its way
  var ctrl = null;     // AbortController of the open request
  var stopped = false; // the visitor pressed stop

  var LOST = 'the signal was lost. try again.';
  // what the ghost itself says when the server turns a turn down (by the
  // server's error code); anything else is the line failing, shown as '!'
  var VOICE = {
    refused: "i can't help with that one.",
    busy: 'one thing at a time.',
    slow: 'too many words too fast. give me a few minutes.',
    crowded: 'the line is crowded. try me again soon.',
    overloaded: 'the line is crowded. try me again soon.',
    tired: "i'm tired. come back tomorrow.",
    timeout: 'i lost the thread. ask again.',
    bad: "that didn't come through right."
  };

  var LABELS = { wait: 'tuning', awake: 'awake', asleep: 'asleep', thinking: 'listening', speaking: 'speaking', lost: 'no signal' };
  function setState(s) {
    stateEl.setAttribute('data-state', s);
    stateT.textContent = LABELS[s] || s;
  }

  /* ---------- transcript ---------- */

  function make(tag, cls, parent, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }

  // follow the newest line unless the visitor scrolled up to read
  var stick = true;
  log.addEventListener('scroll', function () {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  }, { passive: true });
  function follow(force) {
    if (force || stick) log.scrollTop = log.scrollHeight;
  }

  // A system line, small and dim. Gutter marks: '>' is only ever you
  // (and the commands you typed), '\u00b7' is the machine, '!' is the line
  // itself failing. The ghost's own words sit under its name.
  function sys(text, cls, mark) {
    var p = make('p', 'gh-line' + (cls ? ' ' + cls : ''), log);
    make('span', 'gh-mark', p, mark || '\u00b7').setAttribute('aria-hidden', 'true');
    make('span', 'gh-text', p, text);
    follow(true);
    return p;
  }

  function youSaid(text) {
    var p = make('div', 'gh-msg is-you', log);
    make('span', 'gh-mark', p, '>').setAttribute('aria-hidden', 'true');
    var body = make('div', 'gh-text', p, text);
    make('span', 'sr', p, ' (you)');
    follow(true);
    return { el: p, body: body };
  }

  // a ghost line; its text node grows while the reply streams in
  function ghostSays() {
    var p = make('div', 'gh-msg is-ghost', log);
    make('span', 'gh-mark', p, 'ghost').setAttribute('aria-hidden', 'true');
    make('span', 'sr', p, 'ghost: ');
    var body = make('div', 'gh-text', p);
    var node = document.createTextNode('');
    body.appendChild(node);
    var caret = make('span', 'gh-caret', body);
    caret.setAttribute('aria-hidden', 'true');
    p.setAttribute('aria-busy', 'true');
    follow(true);
    return { el: p, body: body, node: node, caret: caret };
  }

  // the ghost saying something that is not a reply (a refusal, a limit),
  // optionally after a small [tag]; returns the span that may glitch
  function ghostNote(text, tag, line) {
    if (!line) {
      line = ghostSays();
      line.body.textContent = '';
    }
    line.el.classList.add('is-note');
    line.el.removeAttribute('aria-busy');
    if (tag) make('span', 'gh-tag', line.body, '[' + tag + '] ');
    var say = make('span', 'gh-say', line.body, text);
    follow(true);
    return say;
  }

  // Once a reply is complete: lines indented by four spaces (or a tab)
  // become code rows, the rest stays as plain text.
  function settle(line, text) {
    line.body.textContent = '';
    var parts = String(text).split('\n');
    var block = null;
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (/^( {4}|\t)/.test(s)) {
        if (!block) block = make('span', 'gh-code', line.body);
        make('span', 'gh-code-l', block, s.replace(/^( {4}|\t)/, '') || ' ');
      } else {
        block = null;
        // a code block starts on its own row, so no newline before it
        var nl = i < parts.length - 1 && !/^( {4}|\t)/.test(parts[i + 1]);
        line.body.appendChild(document.createTextNode(s + (nl ? '\n' : '')));
      }
    }
    line.el.removeAttribute('aria-busy');
  }

  /* ---------- thinking glyph ---------- */

  // a small signal meter that breathes while the ghost thinks
  function thinking() {
    var p = make('div', 'gh-msg is-ghost is-thinking', log);
    make('span', 'gh-mark', p, 'ghost').setAttribute('aria-hidden', 'true');
    var body = make('div', 'gh-text', p);
    var meter = make('span', 'gh-meter', body, '.......');
    meter.setAttribute('aria-hidden', 'true');
    make('span', 'gh-think-t', body, 'listening');
    follow(true);
    var t0 = performance.now(), timer = 0;
    function tick() {
      var t = (performance.now() - t0) / 1000, s = '';
      for (var i = 0; i < 7; i++) {
        var v = 0.5 + 0.5 * Math.sin(t * 5.2 - i * 0.9) * Math.sin(t * 1.3 + i * 0.4);
        s += RAMP.charAt(Math.max(0, Math.min(RAMP.length - 1, (v * RAMP.length) | 0)));
      }
      meter.textContent = s;
    }
    if (!reduced()) timer = setInterval(tick, 90);
    return {
      el: p,
      stop: function () {
        clearInterval(timer);
        if (p.parentNode) p.parentNode.removeChild(p);
      }
    };
  }

  /* ---------- typewriter ---------- */

  // Text arrives in bursts; this reveals it at a steady pace that speeds up
  // when it falls behind, so it never lags far. Reduced motion: at once.
  function writer(line) {
    var queue = '', shown = '', raf = 0, onDrain = null;
    function frame() {
      raf = 0;
      if (!queue) { if (onDrain) { var f = onDrain; onDrain = null; f(); } return; }
      var n = Math.max(2, Math.ceil(queue.length / 14));
      var chunk = queue.slice(0, n);
      queue = queue.slice(n);
      shown += chunk;
      line.node.appendData(chunk);
      follow(false);
      raf = requestAnimationFrame(frame);
    }
    return {
      push: function (s) {
        if (reduced() || document.hidden) {
          shown += queue + s;
          line.node.appendData(queue + s);
          queue = '';
          follow(false);
          return;
        }
        queue += s;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      // call fn once everything queued is on screen
      drain: function (fn) {
        if (!queue && !raf) return fn();
        onDrain = fn;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      // flush now (stop pressed, page hidden)
      flush: function () {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (queue) { line.node.appendData(queue); shown += queue; queue = ''; }
        if (onDrain) { var f = onDrain; onDrain = null; f(); }
      },
      text: function () { return shown + queue; }
    };
  }

  /* ---------- input ---------- */

  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
    var n = input.value.length;
    if (n > MAX_CHARS - 400) {
      count.hidden = false;
      count.textContent = n + '/' + MAX_CHARS;
    } else count.hidden = true;
  }
  input.addEventListener('input', function () { recall = -1; grow(); if (!busy) idleArm(); });

  input.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      stop();
      return;
    }
    // up / down walk through what you sent, only while the line is empty or
    // already showing a recalled line, so editing multi-line text still works
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sent.length && !e.shiftKey) {
      var recalled = recall >= 0 && input.value === sent[recall];
      if (input.value && !recalled) return;
      if (e.key === 'ArrowUp') recall = recall < 0 ? sent.length - 1 : Math.max(0, recall - 1);
      else {
        if (recall < 0) return;
        recall = recall + 1 >= sent.length ? -1 : recall + 1;
      }
      e.preventDefault();
      input.value = recall >= 0 ? sent[recall] : '';
      grow();
      var end = input.value.length;
      try { input.setSelectionRange(end, end); } catch (err) { /* old engines */ }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && busy && document.activeElement !== input) stop();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) stop(); else submit();
  });

  function setBusy(on) {
    busy = on;
    sendT.textContent = on ? 'stop' : 'send';
    sendBtn.classList.toggle('is-stop', on);
    sendBtn.setAttribute('data-cursor', on ? 'stop' : 'send');
    form.classList.toggle('is-busy', on);
  }

  /* ---------- commands ---------- */

  function leave() {
    // through the link, so fx.js plays the power-off on the way out
    if (back) back.click();
    else location.href = '../';
  }

  // /signal: words for the signal, never for the ghost (no convo, no AI)
  var SIG_MAX = 200;
  function isSignal(text) { return /^\s*\/signal(\s|$)/i.test(text); }
  function signal(raw) {
    huntEv('ghost:signal');
    if (raw.length > SIG_MAX || raw.indexOf('\n') >= 0) {
      sys('too long for this line: one line, ' + SIG_MAX + ' characters at most.', 'is-dim');
      return;
    }
    var text = raw.replace(/^\s*\/signal/i, '').replace(/\s+/g, ' ').trim();
    var h = hunt(), done = false;
    function off() { if (done) return; done = true; sys('nothing on this line.', 'is-dim'); }
    function go(api) {
      if (done) return;
      done = true;
      api = api || h;
      var open = false;
      try { open = !!(api.live() || api.pass()); } catch (e) { open = false; }
      if (!open) { sys('nothing on this line.', 'is-dim'); return; }
      var lost = function () { sys('that did not come through.', 'is-signal'); };
      if (!text) {
        var r = huntDo('report');
        if (!r || typeof r.then !== 'function') { lost(); return; }
        r.then(function (lines) {
          lines = Array.isArray(lines) ? lines : [];
          for (var i = 0; i < lines.length && i < 24; i++) if (typeof lines[i] === 'string') sys(lines[i], 'is-signal');
        }, lost);
        return;
      }
      sys('this goes to the signal, not the ghost.', 'is-dim');
      var q = huntDo('signal', text);
      if (!q || typeof q.then !== 'function') { lost(); return; }
      q.then(function (res) {
        res = res || {};
        if (typeof res.say === 'string' && res.say) sys(res.say, 'is-signal');
        var more = Array.isArray(res.lines) ? res.lines : [];
        for (var i = 0; i < more.length && i < 6; i++) if (typeof more[i] === 'string') sys(more[i], 'is-signal');
        if (!res.say && !more.length) lost();
      }, lost);
    }
    if (!h || typeof h.ready !== 'function') { off(); return; }
    setTimeout(off, 4000); // the hunt never said whether anything is live
    try { h.ready(go); } catch (e) { off(); }
  }

  function command(cmd) {
    var c = cmd.toLowerCase().replace(/\s+/g, ' ').trim();
    if (isSignal(cmd)) { signal(cmd.replace(/\s+$/, '')); return; }
    if (c === '/clear') {
      huntEv('ghost:clear');
      convo = [];
      log.textContent = '';
      sys('cleared. the ghost forgot everything.', 'is-dim');
      return;
    }
    if (c === '/exit' || c === '/quit' || c === '/q') {
      huntEv('ghost:exit');
      sys('disconnecting...', 'is-dim');
      setTimeout(leave, reduced() ? 0 : 280);
      return;
    }
    if (c === '/help' || c === '/?') {
      huntEv('ghost:help');
      var live = huntLive();
      sys('/clear   forget this conversation');
      sys('/exit    back to ~');
      sys('/help    this list');
      if (live) sys('/signal  <words>  send words to the signal, not the ghost');
      sys('esc      stop the ghost mid-sentence');
      sys('up/down  recall what you sent');
      var extra = live ? huntTell('ghostHelp') : null;
      if (typeof extra === 'string' && extra) sys(extra);
      return;
    }
    if (c === '/whoami') { huntEv('ghost:whoami'); sys(huntDo('whoami') || 'nobody.'); return; }
    sys('unknown command: ' + c.slice(0, 40) + '. try /help', 'is-dim');
  }

  /* ---------- talking ---------- */

  // the part of the conversation that is sent: at most 20 messages and
  // 24000 characters, starting with one of yours
  function payload() {
    var list = convo.slice(-MAX_SEND);
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].content.length;
    while (list.length && (list[0].role !== 'user' || total > MAX_TOTAL)) {
      total -= list[0].content.length;
      list.shift();
    }
    return { messages: list };
  }

  function clip(s) {
    return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS - 4) + ' ...' : s;
  }

  function submit() {
    if (busy) {
      sendBtn.classList.remove('is-nudge');
      void sendBtn.offsetWidth; // restart the animation
      sendBtn.classList.add('is-nudge');
      return;
    }
    var text = input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    input.value = '';
    recall = -1;
    grow();
    // /signal is always a command (any length), so it never reaches the ghost
    if (isSignal(text) || (text.charAt(0) === '/' && text.indexOf('\n') < 0 && text.length < 40)) {
      sys(text.length > SIG_MAX ? text.slice(0, SIG_MAX) + ' ...' : text, 'is-cmd', '>');
      command(text);
      return;
    }
    huntEv('ghost:turn');
    if (!sent.length || sent[sent.length - 1] !== text) sent.push(text);
    if (sent.length > 50) sent.shift();
    var mine = youSaid(text);
    if (!awake) {
      // maybe it woke up since the page loaded
      checkStatus(function (ok) {
        if (ok) ask(text, mine);
        else {
          mine.el.classList.add('is-lost');
          glitch(sys('the ghost is asleep. it cannot hear you.', 'is-err', '!'));
        }
      });
      return;
    }
    ask(text, mine);
  }

  function stop() {
    if (!busy) return;
    stopped = true;
    if (ctrl) ctrl.abort();
  }

  function ask(text, mine) {
    quiet();
    convo.push({ role: 'user', content: text });
    setBusy(true);
    setState('thinking');
    stopped = false;
    var think = thinking();
    var line = null, w = null, finished = false;
    ctrl = window.AbortController ? new AbortController() : null;

    function start() {
      if (line) return;
      think.stop();
      line = ghostSays();
      w = writer(line);
      setState('speaking');
      wake(true);
    }

    // the ghost said nothing usable: forget your line too, so the
    // conversation still alternates
    function undo() {
      var last = convo[convo.length - 1];
      if (last && last.role === 'user' && last.content === text) convo.pop();
    }

    function finish(result) {
      if (finished) return;
      finished = true;
      ctrl = null;
      var after = function () {
        var said = w ? w.text() : '';
        if (line && line.caret.parentNode) line.caret.parentNode.removeChild(line.caret);
        if (result.ok && said) {
          convo.push({ role: 'assistant', content: clip(said) });
          settle(line, said);
          if (result.cut) sys('(the signal cut off there)', 'is-dim');
          notify();
        } else if (result.stopped && said.trim()) {
          convo.push({ role: 'assistant', content: clip(said) });
          settle(line, said);
          sys('(interrupted)', 'is-dim');
        } else {
          undo();
          think.stop();
          var voice = VOICE[result.code];
          if (line && result.discard) {
            // a refusal: the partial reply is withdrawn, the ghost says why
            line.body.textContent = '';
            line.el.classList.add('is-withdrawn');
            glitch(ghostNote(voice || result.message || VOICE.refused, 'withdrawn', line));
            voice = '';
          } else if (line && said) {
            // it broke off: the words stay readable but are not remembered
            settle(line, said);
            line.el.classList.add('is-cut');
            make('span', 'gh-tag', line.body, ' [lost]');
          } else if (line && line.el.parentNode) {
            line.el.parentNode.removeChild(line.el);
          }
          if (result.stopped) sys('(interrupted)', 'is-dim');
          else {
            if (!said && !result.discard) mine.el.classList.add('is-lost');
            if (voice) glitch(ghostNote(voice));
            else if (!result.discard) glitch(sys(result.message || LOST, 'is-err', '!'));
          }
          notify();
        }
        if (line) line.el.removeAttribute('aria-busy');
        wake(false);
        setBusy(false);
        if (result.asleep) goAsleep(); else setState('awake');
        follow(false);
        idleArm();
      };
      if (w && result.ok) w.drain(after);
      else { if (w) w.flush(); after(); }
    }

    var body = JSON.stringify(payload());
    var opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      cache: 'no-store',
      credentials: 'same-origin'
    };
    if (ctrl) opts.signal = ctrl.signal;

    fetch('/api/ai', opts).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!res.ok || type.indexOf('text/event-stream') < 0) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (res.status === 503 || j.error === 'asleep') return finish({ asleep: true, message: 'the ghost fell asleep.' });
          finish({ code: String(j.error || ''), message: typeof j.message === 'string' ? j.message.slice(0, 160) : LOST });
        });
      }
      return read(res);
    }).catch(function () {
      finish(stopped ? { stopped: true } : { code: 'lost', message: LOST });
    });

    function read(res) {
      if (!res.body || !res.body.getReader) {
        // no streaming support: take the whole answer at once
        return res.text().then(function (t) { t.split('\n\n').forEach(handle); if (!finished) ended(); });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf) handle(buf);
            if (!finished) ended();
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          var cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            handle(buf.slice(0, cut));
            buf = buf.slice(cut + 2);
          }
          if (!finished) return pump();
          try { reader.cancel(); } catch (e) { /* closed */ }
        });
      }
      return pump();
    }

    // the stream closed without saying it was done: keep what arrived,
    // marked as cut off
    function ended() {
      finish(line ? { ok: true, cut: true } : { code: 'lost', message: LOST });
    }

    // one server-sent event block
    function handle(block) {
      if (finished) return;
      var lines = block.split('\n'), data = '';
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).replace(/^ /, '');
      }
      if (!data) return; // a keep-alive comment
      var ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      if (typeof ev.t === 'string') {
        start();
        w.push(ev.t);
      } else if (ev.done) {
        finish({ ok: true, cut: !!ev.cut });
      } else if (ev.error) {
        finish({
          code: String(ev.error),
          asleep: ev.error === 'asleep',
          discard: !!ev.discard,
          message: typeof ev.message === 'string' ? ev.message.slice(0, 160) : ''
        });
      }
    }
  }

  /* ---------- waking up ---------- */

  function checkStatus(cb) {
    fetch('/api/ai/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { awake: false, missing: true }; })
      .then(function (j) {
        awake = !!(j && j.awake === true);
        if (awake) setState('awake');
        cb(awake, j && j.missing);
      })
      .catch(function () { awake = false; cb(false, true); });
  }

  function goAsleep() {
    awake = false;
    setState('asleep');
    input.placeholder = 'the ghost is asleep. /exit to leave';
  }

  // how the visitor got here (eggs.js passes ?via=); only known words
  var VIA = {
    mask: 'three knocks. fine. i am awake.',
    knock: 'three knocks. fine. i am awake.',
    console: 'you typed my name. not many do.',
    ghost: 'you typed my name. not many do.',
    talk: 'you wanted to talk. so talk.',
    ai: 'you typed my name. not many do.',
    wake: 'you asked me to wake. i did.',
    cd: 'you walked in like you knew the way.',
    logo: 'you held on long enough. i noticed.',
    hold: 'you held on long enough. i noticed.'
  };
  var via = '';
  try {
    via = (new URLSearchParams(location.search).get('via') || '').toLowerCase();
  } catch (e) { /* old engines */ }
  if (!/^[a-z]{1,12}$/.test(via)) via = '';

  // The opening: a few boot lines, then the ghost (or its absence).
  var introRows = [];
  function intro() {
    var lines = [['connection established'], ['signal', '...'], ['ghost', '...']];
    var rows = introRows;
    var calm = reduced();
    var i = 0;
    function row() {
      if (i >= 1 && i < lines.length) {
        rows.push(sys(lines[i][0] + ' ' + dots(lines[i][0]) + ' ' + lines[i][1], 'is-boot'));
      } else if (i === 0) rows.push(sys(lines[0][0], 'is-boot'));
      i++;
      if (i < lines.length) setTimeout(row, calm ? 0 : 160);
    }
    row();
    var minWait = calm ? 0 : 520, t0 = Date.now();
    checkStatus(function (ok, missing) {
      setTimeout(function () {
        var sig = rows[1] && rows[1].lastChild, gh = rows[2] && rows[2].lastChild;
        if (sig) sig.textContent = 'signal ' + dots('signal') + ' ' + (ok ? 'weak' : missing ? 'lost' : 'none');
        if (gh) gh.textContent = 'ghost ' + dots('ghost') + ' ' + (ok ? 'awake' : 'asleep');
        if (ok) greet();
        else sleeping(missing);
        input.disabled = false;
        sendBtn.disabled = false;
        if (!('ontouchstart' in window)) input.focus({ preventScroll: true });
      }, Math.max(0, minWait - (Date.now() - t0)));
    });
  }
  function dots(word) { return new Array(Math.max(3, 16 - word.length)).join('.'); }

  // the hunt's intro row, right under the ghost row
  function huntIntro() {
    var t = huntTell('ghostIntro');
    if (!t || typeof t.k !== 'string' || typeof t.v !== 'string') return;
    var tries = 0;
    (function put() {
      var gh = introRows[2];
      if (!gh) { if (++tries < 25) setTimeout(put, 200); return; }
      if (gh.parentNode !== log) return; // cleared meanwhile
      var p = sys(t.k + ' ' + dots(t.k) + ' ' + t.v, 'is-boot');
      log.insertBefore(p, gh.nextSibling);
    })();
  }

  // The state pill: while a frequency is live it sometimes reads the
  // hunt's word for a moment (reduced motion: shown after the label).
  function huntPill() {
    var word = huntTell('ghostPill');
    if (typeof word !== 'string' || !word) return;
    if (reduced()) {
      make('span', 'gh-pill', stateEl, word);
      return;
    }
    function flick() {
      var w = huntTell('ghostPill');
      if (typeof w !== 'string' || !w) return;
      if (!document.hidden) {
        stateT.textContent = w;
        stateEl.classList.add('is-pill');
        setTimeout(function () {
          stateEl.classList.remove('is-pill');
          if (stateT.textContent !== w) return; // the state moved on meanwhile
          var st = stateEl.getAttribute('data-state');
          stateT.textContent = LABELS[st] || st;
        }, 1500);
      }
      setTimeout(flick, 18000 + Math.random() * 4000);
    }
    setTimeout(flick, 18000 + Math.random() * 4000);
  }
  huntReady(function () { huntIntro(); huntPill(); });

  // A verified solver certificate changes the greeting, here only. Without
  // one stored this decides at once, exactly as before.
  var SOLVED = [
    "you again. i don't remember you, but the quiet does.",
    'the static leans away from you. i wonder why.',
    'you walked out of the noise once. sit a while.'
  ];
  function holder() { var s = huntDo('solver'); return !!(s && s.any); }
  function certStored() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('hunt.cert.') === 0) return true;
      }
    } catch (e) { /* blocked */ }
    return false;
  }
  function solverThen(cb) {
    if (!certStored()) { cb(false); return; }
    if (holder()) { cb(true); return; }
    var done = false;
    function end() {
      if (done) return;
      done = true;
      window.removeEventListener('hunt:cert', check);
      cb(holder());
    }
    function check() { if (holder()) end(); }
    window.addEventListener('hunt:cert', check);
    huntReady(check);
    setTimeout(end, 1500);
  }

  // the first words are typed like a reply, without asking the server
  function greet() {
    solverThen(function (solver) {
      if (busy) return; // you already spoke: that reply owns the screen
      greetNow(solver);
    });
  }
  function greetNow(solver) {
    var text = (VIA[via] ? VIA[via] + '\n\n' : solver ? '' : "oh. someone's here.\n\n") +
      (solver ? SOLVED[(Math.random() * SOLVED.length) | 0] + '\n\n' : '') +
      'ask me anything. i forget it all when you leave.';
    wake(true);
    setState('speaking');
    aside(text, '', reduced() ? 0 : 120, function () {
      if (busy) return; // you already spoke: that reply owns the state now
      wake(false);
      setState('awake');
      idleArm();
    });
  }

  /* ---------- asides: words that never reach the server ---------- */

  // The greeting and the idle lines are typed like replies but are not part
  // of the conversation. Speaking yourself finishes them at once.
  var talking = null;
  function aside(text, cls, delay, done) {
    var line = ghostSays();
    if (cls) line.el.classList.add(cls);
    var w = writer(line);
    var me = { w: w, timer: 0 };
    talking = me;
    function end() {
      settle(line, text);
      if (talking === me) talking = null;
      if (done) done();
    }
    function go() {
      me.timer = 0;
      w.push(text);
      w.drain(end);
    }
    if (delay) me.timer = setTimeout(go, delay); else go();
    me.flush = function () {
      if (me.timer) { clearTimeout(me.timer); go(); }
      w.flush();
    };
  }
  function quiet() {
    clearTimeout(idleTimer);
    if (talking) talking.flush();
  }

  // Left alone for a while, the ghost says something on its own: twice at
  // most, never while you type, never to the server.
  var IDLE = ['still there?', 'the static is loud tonight.', 'i can wait. i am good at waiting.', 'take your time. nobody else is here.'];
  var idleTimer = 0, idleN = 0, idleLast = -1;
  function idleArm() {
    clearTimeout(idleTimer);
    if (idleN >= 2 || !awake) return;
    idleTimer = setTimeout(idleSpeak, idleN ? 120000 : 45000);
  }
  function idleSpeak() {
    if (busy || talking || !awake) return;
    if (document.hidden || input.value) { idleArm(); return; }
    var i = (Math.random() * IDLE.length) | 0;
    if (i === idleLast) i = (i + 1) % IDLE.length;
    idleLast = i;
    idleN++;
    aside(IDLE[i], 'is-idle', 0, function () {
      var m = mask();
      if (m && typeof m.blink === 'function') m.blink();
      idleArm();
    });
  }

  // a reply that lands while the tab is hidden shows in its title
  var TITLE = document.title, unseen = 0;
  function notify() {
    if (!document.hidden) return;
    unseen++;
    document.title = TITLE + ' (' + unseen + ')';
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !unseen) return;
    unseen = 0;
    document.title = TITLE;
    var m = mask();
    if (m && typeof m.blink === 'function') m.blink();
  });

  function sleeping(missing) {
    goAsleep();
    if (missing) setState('lost');
    var p = make('p', 'gh-sleep', log);
    make('span', 'gh-sleep-h', p, 'the ghost is asleep.');
    make('span', 'gh-sleep-s', p, missing
      ? 'it cannot be reached from here.'
      : 'nobody has given it a voice yet. come back later.');
    follow(true);
  }

  /* ---------- phones: keep the input above the keyboard ---------- */

  var vv = window.visualViewport;
  function fit() {
    if (!vv) return;
    root.style.setProperty('--gh-vh', Math.round(vv.height) + 'px');
    root.style.setProperty('--gh-vt', Math.round(vv.offsetTop) + 'px');
    follow(false);
  }
  if (vv) {
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }

  /* ---------- start ---------- */

  input.disabled = true;
  sendBtn.disabled = true;
  intro();
})();
