/* chat.js: the chat page (server: server/chat.mjs). Three places: global
   (everyone in one room), rooms (join one, or make one and run it as its
   admin) and you (your picture, a line about yourself, a password for
   your name).
   The little guy, the site's hex with eyes, asks for names and passwords,
   lets you into private rooms and delivers the owner's warnings.

   Live updates come over one EventSource per open room. Everything people
   type is put on the page with textContent, never as markup. */
(function () {
  'use strict';

  // no slash right after "chat" in any path written here: Kyrie renames
  // page paths that end in it (server/app.mjs, rename)
  var API = '/api/chat';

  var root = document.documentElement;
  var body = document.getElementById('ch-body');
  var tabs = document.getElementById('ch-tabs');
  var meBtn = document.getElementById('ch-me');
  var where = document.getElementById('ch-where');
  var layer = document.getElementById('ch-layer');
  var toastEl = document.getElementById('ch-toast');

  var S = {
    me: null,
    limits: { msg: 500, bio: 120, room: 32, picture: 64 * 1024 },
    room: null,      // the open room's meta (from the server)
    roomId: '',
    es: null,
    online: [],
    view: ''
  };

  /* ---------- small helpers ---------- */

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function btn(cls, parent, text, onClick) {
    var b = el('button', cls, parent, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function calm() {
    if (window.fx && window.fx.reduced) return window.fx.reduced();
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // { status, body }; a network failure is status 0 with a message
  function api(path, data) {
    var init = { credentials: 'same-origin', cache: 'no-store' };
    if (data !== undefined) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(data);
    }
    return fetch(API + '/' + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; });
    }, function () {
      return { status: 0, body: { error: 'offline', message: 'can’t reach the chat. check your connection.' } };
    });
  }
  function msgOf(r, fallback) { return (r.body && r.body.message) || fallback || 'something went wrong.'; }

  var toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2800);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(at) {
    var d = new Date(at), t = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === t.toDateString()) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function day(at) {
    var d = new Date(at);
    return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  /* ---------- faces ---------- */

  // someone's picture in the square, or the first letter of their name
  function face(parent, who, cls) {
    var box = el('span', 'ch-icon' + (cls ? ' ' + cls : ''), parent);
    fillFace(box, who);
    return box;
  }
  function fillFace(box, who) {
    var letter = (who.name || '?').charAt(0).toUpperCase();
    box.textContent = '';
    box.classList.remove('is-letter');
    function plain() { box.textContent = letter; box.classList.add('is-letter'); }
    if (!who.av) return plain();
    var img = el('img', '', box);
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', plain);
    img.src = API + '/picture?u=' + encodeURIComponent(who.id) + '&v=' + who.av;
  }

  // A chosen photo becomes a 128px square, cropped from the middle, before
  // it leaves the device (WebP, or JPEG where the browser can't make WebP).
  var SIDE = 128;
  function shrink(f) {
    return new Promise(function (ok, no) {
      if (f.type && !/^image\//.test(f.type)) return no('pick a picture.');
      if (f.size > 25 * 1024 * 1024) return no('that file is too big.');
      var fr = new FileReader();
      fr.onerror = function () { no('couldn\u2019t read that file.'); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { no('that picture won\u2019t open here. try a png or a jpeg.'); };
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = c.height = SIDE;
          var g = c.getContext('2d');
          g.fillStyle = '#000';
          g.fillRect(0, 0, SIDE, SIDE);
          g.imageSmoothingQuality = 'high';
          var s = Math.min(img.naturalWidth, img.naturalHeight);
          g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, SIDE, SIDE);
          c.toBlob(function (w) {
            if (w && w.type === 'image/webp' && w.size <= S.limits.picture) return ok(w);
            c.toBlob(function (j) {
              if (j && j.size <= S.limits.picture) ok(j);
              else no('that picture is too big.');
            }, 'image/jpeg', 0.86);
          }, 'image/webp', 0.86);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(f);
    });
  }

  /* ---------- the little guy ---------- */

  var SVG = 'http://www.w3.org/2000/svg';
  var EYES = {
    '': ['M10 14.5h4.5', 'M17.5 14.5H22'],
    happy: ['M10 15.6l2.25-2.4 2.25 2.4', 'M17.5 15.6l2.25-2.4 2.25 2.4'],
    no: ['M10.4 13l3.7 3M10.4 16l3.7-3', 'M17.9 13l3.7 3M17.9 16l3.7-3'],
    think: ['M10 13.2h4.5', 'M17.5 13.2H22']
  };
  function path(d, cls, w, parent) {
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    if (cls) p.setAttribute('class', cls);
    p.setAttribute('stroke-width', w);
    parent.appendChild(p);
    return p;
  }

  // a face and a speech bubble; say(text, mood) types the line in
  function makeGuy(parent, big) {
    var wrap = el('div', 'guy' + (big ? ' is-big' : ''), parent);
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'guy-face');
    path('M16 3.5 27 9.75v12.5L16 28.5 5 22.25V9.75Z', 'guy-hex', 2, svg);
    var eyeL = path(EYES[''][0], 'guy-eye', 2.4, svg);
    var eyeR = path(EYES[''][1], 'guy-eye', 2.4, svg);
    wrap.appendChild(svg);
    var bubble = el('p', 'guy-say', wrap);
    bubble.setAttribute('aria-live', 'polite');
    var typing = 0;
    function say(text, mood) {
      mood = mood || '';
      var eyes = EYES[mood] || EYES[''];
      eyeL.setAttribute('d', eyes[0]);
      eyeR.setAttribute('d', eyes[1]);
      wrap.classList.remove('is-no', 'is-happy', 'is-think');
      void wrap.offsetWidth; // restart the shake
      if (mood) wrap.classList.add('is-' + mood);
      clearInterval(typing);
      if (calm()) { bubble.textContent = text; return; }
      var chars = Array.from(text), i = 0;
      bubble.textContent = '';
      typing = setInterval(function () {
        i += 2;
        bubble.textContent = chars.slice(0, i).join('');
        if (i >= chars.length) clearInterval(typing);
      }, 16);
    }
    return { el: wrap, say: say };
  }

  /* ---------- the layer: one dialog at a time ---------- */

  var layerClose = null;
  var lastFocus = null;
  function openLayer(cls, label, onClose) {
    closeLayer();
    lastFocus = document.activeElement;
    layer.hidden = false;
    layer.textContent = '';
    var box = el('div', 'ch-dialog ' + (cls || ''), layer);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label || 'dialog');
    layerClose = onClose || null;
    return box;
  }
  function closeLayer() {
    if (layer.hidden) return;
    layer.hidden = true;
    layer.textContent = '';
    var fn = layerClose;
    layerClose = null;
    if (fn) fn();
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  layer.addEventListener('click', function (e) { if (e.target === layer && layerClose !== false) closeLayer(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !layer.hidden && layerClose !== false) { e.preventDefault(); closeLayer(); }
  });

  // The little guy asks something. o: say, mood, input {type, placeholder,
  // max}, ok, cancel, check(value) -> Promise of an error line or '' (the
  // dialog stays open and he answers with the error), yay (said before it
  // closes). Resolves with the value, or null when cancelled.
  function ask(o) {
    return new Promise(function (done) {
      var finished = false;
      var box = openLayer('is-guy', 'the little guy', o.cancel ? function () { if (!finished) { finished = true; done(null); } } : false);
      var form = el('form', 'guy-form', box);
      form.setAttribute('autocomplete', 'off');
      var g = makeGuy(form, true);
      g.say(o.say, o.mood);
      var input = null;
      if (o.input) {
        input = el('input', 'ch-input guy-in', form);
        input.type = o.input.type || 'text';
        input.placeholder = o.input.placeholder || '';
        input.maxLength = o.input.max || 100;
        input.spellcheck = false;
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('aria-label', o.input.placeholder || 'answer');
      }
      var row = el('div', 'guy-row', form);
      var ok = el('button', 'ch-btn is-solid', row, o.ok || 'ok');
      ok.type = 'submit';
      if (o.cancel) btn('ch-btn', row, o.cancel, function () { closeLayer(); });
      function finish(v) {
        if (finished) return;
        finished = true;
        closeLayer();
        done(v);
      }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = input ? input.value : true;
        if (input && !v) { g.say(o.empty || 'type something first.', 'no'); input.focus(); return; }
        if (!o.check) return finish(v);
        ok.disabled = true;
        g.say('hmm…', 'think');
        o.check(v).then(function (err) {
          ok.disabled = false;
          if (!err) {
            if (!o.yay) return finish(v);
            g.say(o.yay, 'happy');
            setTimeout(function () { finish(v); }, calm() ? 200 : 750);
            return;
          }
          g.say(err, 'no');
          if (input) { input.focus(); input.select(); }
        });
      });
      setTimeout(function () { (input || ok).focus(); }, 30);
    });
  }

  /* ---------- signed out: the little guy asks for a name ---------- */

  function startScreen() {
    disconnect();
    S.me = null;
    tabs.hidden = true;
    meBtn.hidden = true;
    where.textContent = '';
    body.textContent = '';
    var wrap = el('section', 'ch-start', body);
    var g = makeGuy(wrap, true);
    var form = el('form', 'ch-start-form', wrap);
    form.setAttribute('autocomplete', 'off');
    var input = el('input', 'ch-input', form);
    var row = el('div', 'guy-row', form);
    var go = el('button', 'ch-btn is-solid', row, 'enter');
    go.type = 'submit';
    var alt = el('div', 'guy-row', form);
    alt.hidden = true;
    var back = btn('ch-link', form, 'pick another name', function () { step('name'); });
    var name = '';
    var mode = 'name';

    function step(m, line, mood) {
      mode = m;
      alt.hidden = true;
      alt.textContent = '';
      row.hidden = false;
      input.hidden = false;
      back.hidden = m === 'name';
      input.value = m === 'name' ? name : '';
      input.type = m === 'name' ? 'text' : 'password';
      input.maxLength = m === 'name' ? 20 : 72;
      input.placeholder = m === 'name' ? 'your name' : 'password';
      input.setAttribute('aria-label', input.placeholder);
      go.textContent = m === 'name' ? 'enter' : m === 'newpw' ? 'make it mine' : 'sign in';
      if (m === 'name') g.say(line || 'hey. what should we call you?', mood);
      if (m === 'owner') g.say('631? prove it. what’s the password?', 'think');
      if (m === 'login') g.say(line || 'that name has a password. what is it?', mood);
      if (m === 'newpw') g.say('pick a password for ' + name + '. 4 characters or more.');
      if (m === 'choose') {
        g.say('nice. chat as a guest, or lock the name with a password so it’s yours?', 'happy');
        row.hidden = true;
        input.hidden = true;
        alt.hidden = false;
        btn('ch-btn', alt, 'chat as a guest', function () { submitGuest(); });
        btn('ch-btn is-solid', alt, 'make it mine', function () { step('newpw'); });
      }
      setTimeout(function () { if (!input.hidden) input.focus(); }, 30);
    }

    function done(r, yay) {
      if (r.status === 200) {
        g.say(yay, 'happy');
        setTimeout(boot, calm() ? 150 : 700);
        return;
      }
      go.disabled = false;
      g.say(msgOf(r), 'no');
    }
    function submitGuest() {
      api('guest', { name: name }).then(function (r) { done(r, 'hi ' + name + '. come on in.'); });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (mode === 'name') {
        if (!v) { g.say('type a name first.', 'no'); return; }
        name = v;
        go.disabled = true;
        g.say('hmm…', 'think');
        api('hello', { name: v }).then(function (r) {
          go.disabled = false;
          var st = r.body.state;
          if (r.status !== 200) return g.say(msgOf(r), 'no');
          if (st === 'bad') return g.say(r.body.message, 'no');
          if (st === 'taken') return g.say('someone’s using that name right now. try another.', 'no');
          if (st === 'owner') return step('owner');
          if (st === 'account') return step('login');
          step('choose');
        });
        return;
      }
      if (!input.value) { g.say('type the password first.', 'no'); return; }
      go.disabled = true;
      g.say('hmm…', 'think');
      if (mode === 'newpw') {
        api('signup', { name: name, password: input.value }).then(function (r) { done(r, name + ' is yours now. welcome.'); });
      } else {
        api('login', { name: name, password: input.value }).then(function (r) {
          done(r, mode === 'owner' ? 'welcome back, owner.' : 'welcome back, ' + name + '.');
          if (r.status !== 200) { input.value = ''; input.focus(); }
        });
      }
    });
    step('name');
  }

  /* ---------- signed in ---------- */

  function boot() {
    api('me').then(function (r) {
      if (r.status === 401) return startScreen();
      if (r.status !== 200) return offline(msgOf(r));
      S.me = r.body.me;
      S.limits = r.body.limits || S.limits;
      if (S.me.banned) return bannedScreen(S.me.banned.reason);
      tabs.hidden = false;
      meBtn.hidden = false;
      showMe();
      if (S.me.warn) showWarn(S.me.warn);
      route();
    });
  }

  function offline(text) {
    disconnect();
    body.textContent = '';
    var wrap = el('section', 'ch-start', body);
    makeGuy(wrap, true).say(text || 'can’t reach the chat.', 'no');
    btn('ch-btn', wrap, 'try again', boot);
  }

  function bannedScreen(reason) {
    disconnect();
    tabs.hidden = true;
    meBtn.hidden = true;
    closeLayer();
    body.textContent = '';
    var wrap = el('section', 'ch-start is-banned', body);
    makeGuy(wrap, true).say('you’ve been banned from the chat.' + (reason ? ' reason: ' + reason : ''), 'no');
    var a = el('a', 'ch-btn', wrap, 'back to the menu');
    a.href = '../';
  }

  function showWarn(w) {
    ask({ say: 'warning from the owner: ' + (w.reason || 'knock it off.'), mood: 'no', ok: 'got it' }).then(function () {
      api('ack', {});
      if (S.me) S.me.warn = null;
    });
  }

  // the top-right button: your picture, your name, your title
  function showMe() {
    meBtn.textContent = '';
    face(meBtn, S.me, 'is-sm');
    el('span', 'ch-me-name', meBtn, S.me.name);
    if (S.me.owner) el('span', 'ch-title is-owner', meBtn, 'owner');
    else if (S.me.kind === 'guest') el('span', 'ch-title is-guest', meBtn, 'guest');
    meBtn.setAttribute('aria-label', 'you: ' + S.me.name);
  }
  meBtn.addEventListener('click', function () { youPanel(); });

  /* ---------- where you are ---------- */

  function route() {
    if (!S.me) return;
    var h = location.hash.slice(1);
    var m = /^room\/([a-z0-9]{10})$/.exec(h);
    var tab = h === 'rooms' || m ? 'rooms' : 'global';
    Array.prototype.forEach.call(tabs.querySelectorAll('.ch-tab'), function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    closeLayer();
    if (h === 'rooms') return showRooms();
    if (m) return enterRoom(m[1]);
    openRoom('global');
  }
  window.addEventListener('hashchange', route);

  function go(hash) {
    if (location.hash === '#' + hash) route();
    else location.hash = hash;
  }

  /* ---------- the room list ---------- */

  function showRooms() {
    disconnect();
    S.view = 'rooms';
    where.textContent = '/rooms';
    body.textContent = '';
    var wrap = el('section', 'ch-rooms', body);
    var head = el('div', 'ch-rooms-head', wrap);
    el('h1', 'ch-h', head, '// rooms');
    var count = el('span', 'ch-count', head);
    var make = btn('ch-btn is-solid', head, '+ new room');
    var formWrap = el('div', 'ch-new', wrap);
    formWrap.hidden = true;
    var list = el('div', 'ch-list', wrap);
    list.setAttribute('role', 'list');

    make.addEventListener('click', function () {
      formWrap.hidden = !formWrap.hidden;
      if (!formWrap.hidden) formWrap.querySelector('input').focus();
    });
    newRoomForm(formWrap);

    function fill() {
      api('rooms').then(function (r) {
        if (S.view !== 'rooms') return;
        if (r.status === 401) return startScreen();
        list.textContent = '';
        if (r.status !== 200) { el('p', 'ch-empty', list, '> ' + msgOf(r)); return; }
        count.textContent = r.body.online + ' online';
        var rooms = r.body.rooms;
        if (!rooms.length) { el('p', 'ch-empty', list, '> no rooms yet. make the first one.'); return; }
        rooms.forEach(function (room) {
          var b = btn('ch-roomrow', list, '', function () { joinRoom(room); });
          b.setAttribute('role', 'listitem');
          b.setAttribute('data-cursor', room.private && !room.in ? 'locked' : 'open');
          var top = el('span', 'ch-roomrow-top', b);
          el('span', 'ch-roomrow-name', top, room.name);
          el('span', 'ch-tag' + (room.private ? ' is-private' : ''), top, room.private ? 'private' : 'public');
          if (room.admin) el('span', 'ch-title is-admin', top, 'admin');
          if (room.banned) el('span', 'ch-tag is-bad', top, 'banned');
          var meta = el('span', 'ch-roomrow-meta', b);
          el('span', room.online ? 'is-live' : '', meta, room.online + ' online');
          if (room.by) el('span', '', meta, 'by ' + room.by);
          el('span', 'ch-roomrow-go', b, room.private && !room.in ? '→ password' : '→ join');
        });
      });
    }
    S.refreshRooms = fill;
    fill();
  }

  function newRoomForm(parent) {
    var form = el('form', 'ch-new-form', parent);
    form.setAttribute('autocomplete', 'off');
    el('p', 'ch-h is-sm', form, '// new room');
    var name = el('input', 'ch-input', form);
    name.placeholder = 'room name';
    name.maxLength = S.limits.room;
    name.setAttribute('aria-label', 'room name');
    var lockRow = el('label', 'ch-check', form);
    var lock = el('input', '', lockRow);
    lock.type = 'checkbox';
    el('span', '', lockRow, 'needs a password (a private room)');
    var pw = el('input', 'ch-input', form);
    pw.type = 'text';
    pw.placeholder = 'room password';
    pw.maxLength = 72;
    pw.hidden = true;
    pw.setAttribute('aria-label', 'room password');
    lock.addEventListener('change', function () { pw.hidden = !lock.checked; if (lock.checked) pw.focus(); });
    var row = el('div', 'guy-row', form);
    var ok = el('button', 'ch-btn is-solid', row, 'create');
    ok.type = 'submit';
    var note = el('p', 'ch-note', form, 'you’ll be its admin: you can make others admins, kick people and change the password.');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (lock.checked && !pw.value) { note.textContent = '> type a password, or untick the box.'; pw.focus(); return; }
      ok.disabled = true;
      api('create', { name: name.value, password: lock.checked ? pw.value : '' }).then(function (r) {
        ok.disabled = false;
        if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return; }
        go('room/' + r.body.room.id);
      });
    });
  }

  // a private room asks for its password through the little guy
  function joinRoom(room) {
    if (room.in || !room.private) return go('room/' + room.id);
    ask({
      say: room.name + ' is private. what’s the password?',
      mood: 'think',
      input: { type: 'password', placeholder: 'room password', max: 72 },
      empty: 'type the password first.',
      ok: 'enter',
      cancel: 'never mind',
      yay: 'that’s it. you’re in.',
      check: function (v) {
        return api('join', { room: room.id, password: v }).then(function (r) {
          if (r.status === 200) return '';
          if (r.body.error === 'wrong') return 'nope. that’s not it.';
          return msgOf(r);
        });
      }
    }).then(function (v) { if (v !== null) go('room/' + room.id); });
  }

  // a room link opened directly: join first (asking for a password if needed)
  function enterRoom(id) {
    api('join', { room: id }).then(function (r) {
      if (r.status === 200) return openRoom(id);
      if (r.body.error === 'password') {
        disconnect();
        body.textContent = '';
        return joinRoom({ id: id, name: 'this room', private: true, in: false });
      }
      if (r.status === 401 && r.body.error === 'signin') return startScreen();
      toast(msgOf(r));
      go('rooms');
    });
  }

  /* ---------- a room (global is one too) ---------- */

  var R = null; // the open room's elements

  function openRoom(id) {
    disconnect();
    S.view = 'room';
    S.roomId = id;
    S.room = null;
    S.online = [];
    where.textContent = id === 'global' ? '/global' : '/rooms';
    body.textContent = '';
    var wrap = el('section', 'ch-room', body);
    var head = el('div', 'ch-roomhead', wrap);
    var title = el('h1', 'ch-h ch-roomname', head, id === 'global' ? '// global' : '// …');
    var tags = el('span', 'ch-roomtags', head);
    var peopleBtn = btn('ch-btn is-quiet ch-online', head, '● 0 online');
    var tools = btn('ch-btn is-quiet', head, 'room ⚙');
    tools.hidden = true;
    var main = el('div', 'ch-roommain', wrap);
    var log = el('div', 'ch-log', main);
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', 'messages');
    log.tabIndex = 0;
    var people = el('aside', 'ch-people', main);
    people.setAttribute('aria-label', 'online now');
    var newer = btn('ch-newer', main, 'new messages ↓', function () { toBottom(true); });
    newer.hidden = true;
    var status = el('p', 'ch-status', wrap);
    var form = el('form', 'ch-form', wrap);
    form.setAttribute('autocomplete', 'off');
    el('span', 'ch-prompt', form, '>').setAttribute('aria-hidden', 'true');
    var input = el('textarea', 'ch-in', form);
    input.rows = 1;
    input.maxLength = S.limits.msg;
    input.placeholder = 'say something';
    input.setAttribute('aria-label', 'message');
    input.setAttribute('enterkeyhint', 'send');
    var countEl = el('span', 'ch-left', form);
    var send = el('button', 'ch-btn is-solid', form, 'send');
    send.type = 'submit';

    R = { id: id, title: title, tags: tags, peopleBtn: peopleBtn, tools: tools, log: log, people: people, newer: newer, status: status, input: input, send: send, count: countEl, msgs: null };

    // wide screens show who is online until the button hides it; phones
    // the other way round (chat.css)
    var wide = window.matchMedia('(min-width: 821px)');
    function peopleShown() { return main.classList.contains('is-flipped') !== wide.matches; }
    peopleBtn.setAttribute('aria-expanded', peopleShown() ? 'true' : 'false');
    peopleBtn.addEventListener('click', function () {
      main.classList.toggle('is-flipped');
      peopleBtn.setAttribute('aria-expanded', peopleShown() ? 'true' : 'false');
    });
    tools.addEventListener('click', roomPanel);
    log.addEventListener('scroll', function () { if (nearBottom()) newer.hidden = true; });

    function grow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 132) + 'px';
      var left = S.limits.msg - input.value.length;
      countEl.textContent = left < 80 ? String(left) : '';
    }
    input.addEventListener('input', grow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || send.disabled) return;
      send.disabled = true;
      api('send', { room: id, text: input.value }).then(function (r) {
        send.disabled = false;
        if (r.status === 200) { input.value = ''; grow(); input.focus(); return; }
        if (r.body.error === 'muted') { S.me.muteUntil = r.body.until || 0; muteState(); }
        else if (r.body.error === 'banned') return boot();
        toast(msgOf(r));
      });
    });

    connect(id);
    setTimeout(function () { input.focus(); }, 30);
  }

  function nearBottom() { return R && R.log.scrollHeight - R.log.scrollTop - R.log.clientHeight < 80; }
  function toBottom(smooth) {
    if (!R) return;
    R.log.scrollTo({ top: R.log.scrollHeight, behavior: smooth && !calm() ? 'smooth' : 'auto' });
    R.newer.hidden = true;
  }

  function roomHead() {
    var r = S.room;
    if (!R || !r) return;
    where.textContent = r.global ? '/global' : '/' + r.name;
    R.title.textContent = r.global ? '// global' : '// ' + r.name;
    R.tags.textContent = '';
    if (r.global) el('span', 'ch-tag', R.tags, 'everyone');
    else el('span', 'ch-tag' + (r.private ? ' is-private' : ''), R.tags, r.private ? 'private' : 'public');
    if (!r.global && r.you.admin && !r.you.owner) el('span', 'ch-title is-admin', R.tags, 'you’re admin');
    R.tools.hidden = r.global ? !r.you.owner : !r.you.admin;
  }

  function muteState() {
    if (!R) return;
    var until = S.me && S.me.muteUntil;
    var muted = until && until > Date.now();
    R.input.disabled = !!muted;
    R.send.disabled = !!muted;
    R.input.placeholder = muted ? 'you’re muted until ' + clock(until) : 'say something';
    if (muted) setTimeout(muteState, Math.min(until - Date.now() + 500, 2147483000));
  }

  /* ---------- messages ---------- */

  function canDelete(m) { return S.me && (m.uid === S.me.id || (S.room && S.room.you.admin)); }

  function msgRow(m, prev) {
    var cont = prev && prev.uid === m.uid && m.at - prev.at < 5 * 60e3 && prev.role === m.role;
    var row = el('div', 'ch-msg' + (cont ? ' is-cont' : '') + (S.me && m.uid === S.me.id ? ' is-me' : '') + (m.role === 'owner' ? ' is-owner' : ''));
    row.setAttribute('data-id', m.id);
    var ic = btn('ch-icon', row, '', function () { userCard(m.uid); });
    ic.setAttribute('aria-label', 'about ' + m.name);
    if (cont) ic.tabIndex = -1;
    else fillFace(ic, { id: m.uid, name: m.name, av: m.av });
    var main = el('div', 'ch-msg-main', row);
    if (!cont) {
      var head = el('div', 'ch-msg-head', main);
      btn('ch-name', head, m.name, function () { userCard(m.uid); });
      if (m.role) el('span', 'ch-title is-' + m.role, head, m.role);
      el('time', 'ch-time', head, clock(m.at)).setAttribute('datetime', new Date(m.at).toISOString());
    }
    el('p', 'ch-text', main, m.text);
    if (canDelete(m)) {
      var x = btn('ch-del', row, '×', function () { deleteMsg(m); });
      x.setAttribute('aria-label', 'delete this message');
      x.title = 'delete';
    }
    return row;
  }

  function addMsg(m) {
    if (!R || !R.msgs) return;
    var stick = nearBottom() || (S.me && m.uid === S.me.id);
    if (!R.msgs.length) R.log.textContent = '';
    R.msgs.push(m);
    R.log.appendChild(msgRow(m, R.msgs[R.msgs.length - 2]));
    if (R.msgs.length > 250) { R.msgs.shift(); R.log.removeChild(R.log.firstChild); }
    if (stick) toBottom(false);
    else R.newer.hidden = false;
  }

  // the whole log again (a new room, a clear, a deleted message); keeps
  // the reader's place unless they were at the bottom
  function fillLog(msgs) {
    if (!R) return;
    var stick = !R.msgs || nearBottom();
    var top = R.log.scrollTop;
    R.msgs = msgs.slice(-250);
    R.log.textContent = '';
    if (!R.msgs.length) el('p', 'ch-empty', R.log, S.room && S.room.global ? '> nobody’s said anything yet. say hi.' : '> nothing here yet. say something.');
    R.msgs.forEach(function (m, i) { R.log.appendChild(msgRow(m, R.msgs[i - 1])); });
    if (stick) toBottom(false);
    else R.log.scrollTop = top;
  }

  function deleteMsg(m) {
    api('mod', { action: 'delete', room: S.roomId, msg: m.id }).then(function (r) { if (r.status !== 200) toast(msgOf(r)); });
  }

  /* ---------- who is here ---------- */

  function fillPeople(list) {
    if (!R) return;
    S.online = list;
    R.peopleBtn.textContent = '● ' + list.length + ' online';
    R.people.textContent = '';
    el('p', 'ch-h is-sm', R.people, '// online now');
    list.forEach(function (p) {
      var b = btn('ch-person', R.people, '', function () { userCard(p.id); });
      face(b, p, 'is-sm');
      el('span', 'ch-person-name', b, p.name);
      if (p.role) el('span', 'ch-title is-' + p.role, b, p.role);
    });
  }

  /* ---------- live updates ---------- */

  function disconnect() {
    if (S.es) { S.es.close(); S.es = null; }
    R = null;
    S.refreshRooms = null;
  }

  function connect(id) {
    var es = new EventSource(API + '/stream?room=' + encodeURIComponent(id));
    S.es = es;
    function on(name, fn) {
      es.addEventListener(name, function (e) {
        if (S.es !== es) return;
        var d;
        try { d = JSON.parse(e.data); } catch (err) { return; }
        fn(d);
      });
    }
    on('hello', function (d) {
      S.me = d.me;
      showMe();
      if (S.me.banned) return bannedScreen(S.me.banned.reason);
      S.room = d.room;
      roomHead();
      fillLog(d.msgs);
      fillPeople(d.online);
      muteState();
      if (R) R.status.textContent = '';
    });
    on('msg', addMsg);
    on('del', function (d) {
      if (R && R.msgs) fillLog(R.msgs.filter(function (m) { return m.id !== d.id; }));
    });
    on('clear', function () { fillLog([]); });
    on('online', function (d) { fillPeople(d.users); });
    on('room', function (d) { S.room = d; roomHead(); });
    on('rooms', function () { if (S.refreshRooms) S.refreshRooms(); });
    on('warn', function (d) { showWarn(d); });
    on('mute', function (d) {
      S.me.muteUntil = d.until;
      muteState();
      if (d.until) ask({ say: 'the owner muted you until ' + clock(d.until) + '.', mood: 'no', ok: 'ok' });
    });
    on('ban', function (d) { bannedScreen(d.reason); });
    on('gone', function (d) {
      es.close();
      if (S.es === es) S.es = null;
      var why = d.why;
      if (why === 'banned') return;
      if (why === 'elsewhere') { if (R) R.status.textContent = '> the chat is open in too many tabs. reload to use this one.'; return; }
      var line = why === 'kicked' ? 'you got kicked from this room. you can come back in a few minutes.'
        : why === 'roombanned' ? 'you’re banned from this room.'
        : why === 'deleted' ? 'this room was deleted.' : 'you left the room.';
      ask({ say: line, mood: 'no', ok: 'ok' }).then(function () { go('rooms'); });
    });
    es.onerror = function () {
      if (S.es !== es) return;
      if (es.readyState === 2) {
        // refused (signed out, banned, no longer allowed in): find out which
        S.es = null;
        api('me').then(function (r) {
          if (r.status === 401) return startScreen();
          if (r.status === 0) return offline();
          if (r.body.me && r.body.me.banned) return bannedScreen(r.body.me.banned.reason);
          toast('you can’t get into that room.');
          go('rooms');
        });
      } else if (R) R.status.textContent = '> reconnecting…';
    };
  }

  /* ---------- profile cards and powers ---------- */

  function userCard(uid) {
    api('user?id=' + encodeURIComponent(uid) + '&room=' + encodeURIComponent(S.roomId || '')).then(function (r) {
      if (r.status !== 200) return toast(msgOf(r));
      var u = r.body.user;
      var box = openLayer('is-card', u.name);
      var top = el('div', 'ch-card-top', box);
      face(top, u, 'is-lg');
      var who = el('div', 'ch-card-who', top);
      var nm = el('p', 'ch-card-name', who, u.name);
      if (u.role) el('span', 'ch-title is-' + u.role, nm, u.role);
      el('p', 'ch-card-meta', who, (u.online ? '● online · ' : '') + (u.kind === 'guest' ? 'guest' : u.kind === 'owner' ? 'runs this place' : 'member') + ' since ' + day(u.created));
      el('p', 'ch-card-bio' + (u.bio ? '' : ' is-empty'), box, u.bio || 'no description yet.');
      if (u.mod) {
        var m = u.mod;
        el('p', 'ch-card-mod', box, '// warnings ' + m.warns + (m.muteUntil ? ' · muted until ' + clock(m.muteUntil) : '') + (m.banned !== null ? ' · banned' + (m.banned ? ': ' + m.banned : '') : ''));
      }
      var acts = el('div', 'ch-card-acts', box);
      var me = S.me, room = S.room;
      var self = me && u.id === me.id;
      if (room && !room.global && room.you.admin && !self && u.role !== 'owner') {
        if (u.role === 'admin') { if (room.you.creator) btn('ch-btn', acts, 'remove admin', modAct('unadmin', u)); }
        else btn('ch-btn', acts, 'make admin', modAct('admin', u));
        if (u.role !== 'admin' || room.you.creator) {
          btn('ch-btn', acts, 'kick', modAct('kick', u));
          btn('ch-btn is-bad', acts, 'ban from room', modAct('roomban', u));
        }
      }
      if (room && !room.global && room.you.admin && u.roomBanned) btn('ch-btn', acts, 'unban from room', modAct('roomunban', u));
      if (me && me.owner && !self) {
        var o = el('div', 'ch-card-acts is-owner', box);
        el('p', 'ch-h is-sm', o, '// owner');
        btn('ch-btn', o, 'warn', function () {
          reasonFor('warn ' + u.name + '. what for?').then(function (why) { if (why !== null) modAct('warn', u, { reason: why })(); });
        });
        if (u.mod && u.mod.muteUntil) btn('ch-btn', o, 'unmute', modAct('unmute', u));
        else {
          btn('ch-btn', o, 'mute 10 min', modAct('mute', u, { minutes: 10 }));
          btn('ch-btn', o, 'mute 1 hour', modAct('mute', u, { minutes: 60 }));
        }
        if (u.mod && u.mod.banned !== null) btn('ch-btn', o, 'unban', modAct('unban', u));
        else {
          btn('ch-btn is-bad', o, 'ban', function () {
            reasonFor('ban ' + u.name + ' from the whole chat? say why.').then(function (why) { if (why !== null) modAct('ban', u, { reason: why })(); });
          });
        }
        btn('ch-btn', o, 'remove picture + description', modAct('wipe', u));
      }
      if (!acts.children.length) acts.remove();
      btn('ch-btn is-quiet ch-card-x', box, 'close', closeLayer);
    });
  }

  function reasonFor(line) {
    return ask({ say: line, mood: 'think', input: { placeholder: 'reason', max: 200 }, empty: 'give a reason.', ok: 'send', cancel: 'cancel' });
  }

  var DONE = {
    admin: 'made admin.', unadmin: 'not an admin anymore.', kick: 'kicked for 5 minutes.', roomban: 'banned from this room.',
    roomunban: 'unbanned from this room.', warn: 'warned.', mute: 'muted.', unmute: 'unmuted.', ban: 'banned from the chat.',
    unban: 'unbanned.', wipe: 'picture and description removed.'
  };
  function modAct(action, u, extra) {
    return function () {
      var data = { action: action, room: S.roomId, target: u.id };
      if (extra) for (var k in extra) data[k] = extra[k];
      api('mod', data).then(function (r) {
        if (r.status !== 200) return toast(msgOf(r));
        closeLayer();
        toast(u.name + ': ' + DONE[action]);
      });
    };
  }

  // the room's settings, for its admins (and the owner)
  function roomPanel() {
    var room = S.room;
    if (!room) return;
    var box = openLayer('is-panel', 'room settings');
    el('p', 'ch-h', box, room.global ? '// global' : '// ' + room.name);
    var note = el('p', 'ch-note', box, '');
    function run(data, after) {
      data.room = room.id;
      return api('mod', data).then(function (r) {
        if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return false; }
        note.textContent = '> ' + after;
        return true;
      });
    }
    if (!room.global) {
      var nameForm = el('form', 'ch-row', box);
      var nm = el('input', 'ch-input', nameForm);
      nm.value = room.name;
      nm.maxLength = S.limits.room;
      nm.setAttribute('aria-label', 'room name');
      el('button', 'ch-btn', nameForm, 'rename').type = 'submit';
      nameForm.addEventListener('submit', function (e) { e.preventDefault(); run({ action: 'rename', name: nm.value }, 'renamed.'); });

      el('p', 'ch-h is-sm', box, room.private ? '// private: people need the password' : '// public: anyone can join');
      var pwForm = el('form', 'ch-row', box);
      var pw = el('input', 'ch-input', pwForm);
      pw.placeholder = room.private ? 'new password' : 'set a password';
      pw.maxLength = 72;
      pw.setAttribute('aria-label', 'room password');
      el('button', 'ch-btn', pwForm, room.private ? 'change' : 'make private').type = 'submit';
      pwForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!pw.value) { note.textContent = '> type a password first.'; return; }
        run({ action: 'password', password: pw.value }, 'password set. people already in stay in.').then(function (ok) { if (ok) pw.value = ''; });
      });
      if (room.private) btn('ch-btn', box, 'remove the password (make public)', function () { run({ action: 'password', password: '' }, 'it’s public now.'); });

      if (room.admins.length) {
        el('p', 'ch-h is-sm', box, '// admins');
        var admins = el('div', 'ch-admins', box);
        room.admins.forEach(function (a) {
          var line = el('div', 'ch-admin', admins);
          el('span', '', line, a.name);
          if (room.you.creator && !(a.id === S.me.id)) btn('ch-btn is-quiet', line, 'remove', function () { run({ action: 'unadmin', target: a.id }, a.name + ' is not an admin anymore.'); });
        });
        el('p', 'ch-note', box, 'tap someone’s name in the chat to make them admin.');
      }
    }
    el('p', 'ch-h is-sm', box, '// danger');
    btn('ch-btn', box, 'clear all messages', function () {
      ask({ say: 'clear every message in ' + (room.global ? 'global' : room.name) + '?', mood: 'think', ok: 'clear them', cancel: 'cancel' }).then(function (v) {
        if (v) api('mod', { action: 'clear', room: room.id }).then(function (r) { toast(r.status === 200 ? 'cleared.' : msgOf(r)); });
      });
    });
    if (!room.global && room.you.creator) {
      btn('ch-btn is-bad', box, 'delete this room', function () {
        ask({ say: 'delete ' + room.name + ' for everyone? this can’t be undone.', mood: 'no', ok: 'delete it', cancel: 'keep it' }).then(function (v) {
          if (v) api('mod', { action: 'deleteroom', room: room.id }).then(function (r) { if (r.status !== 200) toast(msgOf(r)); });
        });
      });
    }
    btn('ch-btn is-quiet ch-card-x', box, 'close', closeLayer);
  }

  /* ---------- you ---------- */

  function youPanel() {
    var me = S.me;
    if (!me) return;
    var box = openLayer('is-panel', 'you');
    el('p', 'ch-h', box, '// you');
    var top = el('div', 'ch-card-top', box);
    var big = face(top, me, 'is-lg');
    var who = el('div', 'ch-card-who', top);
    var nm = el('p', 'ch-card-name', who, me.name);
    if (me.owner) el('span', 'ch-title is-owner', nm, 'owner');
    el('p', 'ch-card-meta', who, me.owner ? 'you run this place.' : me.kind === 'guest' ? 'guest: the name is yours until you leave for a week.' : 'your name is yours.');
    var note = el('p', 'ch-note', box, '');

    el('p', 'ch-h is-sm', box, '// your picture');
    var picRow = el('div', 'ch-row', box);
    var file = el('input', '', picRow);
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/gif,image/*';
    file.hidden = true;
    var pick = btn('ch-btn is-solid', picRow, me.av ? 'change picture' : 'upload a picture', function () { file.click(); });
    var drop = btn('ch-btn', picRow, 'remove', function () {
      api('profile', { removePicture: true }).then(function (r) {
        if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return; }
        S.me = r.body.me;
        showMe();
        fillFace(big, S.me);
        drop.hidden = true;
        pick.textContent = 'upload a picture';
        note.textContent = '> picture removed.';
      });
    });
    drop.hidden = !me.av;
    el('p', 'ch-note is-keep', box, 'it’s cropped to a square from the middle. everyone in the chat sees it.');
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      pick.disabled = true;
      note.textContent = '> shrinking it…';
      shrink(f).then(function (blob) {
        note.textContent = '> sending…';
        return fetch(API + '/picture', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type }, body: blob })
          .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); });
      }).then(function (r) {
        pick.disabled = false;
        if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return; }
        S.me = r.body.me;
        showMe();
        fillFace(big, S.me);
        drop.hidden = false;
        pick.textContent = 'change picture';
        note.textContent = '> looking good.';
      }, function (err) {
        pick.disabled = false;
        note.textContent = '> ' + (typeof err === 'string' ? err : 'couldn’t send that. try again.');
      });
    });

    el('p', 'ch-h is-sm', box, '// about you');
    var bioForm = el('form', 'ch-row', box);
    var bio = el('input', 'ch-input', bioForm);
    bio.value = me.bio || '';
    bio.maxLength = S.limits.bio;
    bio.placeholder = 'a little description';
    bio.setAttribute('aria-label', 'description');
    el('button', 'ch-btn', bioForm, 'save').type = 'submit';
    bioForm.addEventListener('submit', function (e) {
      e.preventDefault();
      api('profile', { bio: bio.value }).then(function (r) {
        if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return; }
        S.me = r.body.me;
        note.textContent = '> saved.';
      });
    });

    if (me.kind === 'guest') {
      el('p', 'ch-h is-sm', box, '// keep your name');
      var claimForm = el('form', 'ch-row', box);
      var pw = el('input', 'ch-input', claimForm);
      pw.type = 'password';
      pw.placeholder = 'a password (4+ characters)';
      pw.maxLength = 72;
      pw.setAttribute('aria-label', 'password for your name');
      el('button', 'ch-btn is-solid', claimForm, 'make it mine').type = 'submit';
      claimForm.addEventListener('submit', function (e) {
        e.preventDefault();
        api('claim', { password: pw.value }).then(function (r) {
          if (r.status !== 200) { note.textContent = '> ' + msgOf(r); return; }
          S.me = r.body.me;
          showMe();
          closeLayer();
          toast(me.name + ' is yours now. sign in with it any time.');
        });
      });
    }

    if (me.owner) {
      el('p', 'ch-h is-sm', box, '// banned');
      var bans = el('div', 'ch-admins', box);
      api('bans').then(function (r) {
        if (r.status !== 200) return;
        if (!r.body.bans.length) { el('p', 'ch-note', bans, 'nobody.'); return; }
        r.body.bans.forEach(function (b) {
          var line = el('div', 'ch-admin', bans);
          var who = el('span', 'ch-admin-who', line);
          face(who, b, 'is-sm');
          el('span', '', who, b.name + (b.reason ? ' · ' + b.reason : ''));
          btn('ch-btn is-quiet', line, 'unban', function () {
            api('mod', { action: 'unban', target: b.id }).then(function (r2) {
              if (r2.status === 200) line.remove();
              else note.textContent = '> ' + msgOf(r2);
            });
          });
        });
      });
    }

    var foot = el('div', 'guy-row', box);
    btn('ch-btn', foot, 'log out', function () {
      api('logout', {}).then(function () { closeLayer(); history.replaceState(null, '', location.pathname); startScreen(); });
    });
    btn('ch-btn is-quiet', foot, 'close', closeLayer);
  }

  boot();
})();
