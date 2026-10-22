/* games.js: the games grid. Two sources are merged:
   - our own games from the R2 bucket: games/semag.json lists them, and the
     server relays them under /semag/ (only on the main server)
   - the gn-math catalog: list, covers and game files. On the main server they
     come through /jsgh/ (jsDelivr blocks gn-math; GitHub raw is text/plain).
     On a static host they fall back to raw.githubusercontent.com.
   Saved games live in localStorage on this device only.
   The look (skeletons, reveals, the player's mount screen) is decoration:
   it uses window.fx when it is there and stays quiet under reduced motion. */
(function () {
  'use strict';

  var RAW = 'https://raw.githubusercontent.com/gn-math/';
  var LIST = RAW + 'assets/main/zones.json';
  var COVERS = RAW + 'covers/main';
  var CHUNK = 60;
  var HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.9 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.3 0 5.6 3.2 4.4 6.6-1.7 4.8-9.2 9.4-9.2 9.4z"/></svg>';
  var HEX = '0123456789abcdef';

  var root = document.documentElement;
  var view = document.getElementById('view');
  var top = document.getElementById('g-top');
  var input = document.getElementById('g-q');
  var hits = document.getElementById('g-hits');
  var pathEl = document.getElementById('g-path');
  var loadBar = document.getElementById('g-load');
  var tabBar = document.getElementById('g-tab-bar');
  var allBtn = document.getElementById('g-all');
  var favBtn = document.getElementById('g-fav');
  var favN = document.getElementById('g-favn');
  var player = document.getElementById('player');
  var frame = document.getElementById('p-frame');
  var pname = document.getElementById('p-name');
  var psrc = document.getElementById('p-src');
  var psave = document.getElementById('p-save');
  var live = document.getElementById('g-live');

  var games = [];
  var shown = [];
  var rendered = 0;
  var favOnly = false;
  var playing = null;
  var saveBtns = {};
  var lastTitle = '';
  var opener = null;
  var openerY = 0;
  var liveT = 0;
  var favs = [];
  try { favs = JSON.parse(localStorage.getItem('g-favs') || '[]'); } catch (e) { /* blocked */ }
  if (!Array.isArray(favs)) favs = [];

  /* ---------- helpers ---------- */

  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return window.fx && window.fx.reduced ? window.fx.reduced() : mqReduce.matches; }
  // fx.decode, plus a safety net: the real text is always back after 2 s
  function decode(el, opts) {
    if (!window.fx || !window.fx.decode || reduced()) return;
    var text = el.textContent;
    window.fx.decode(el, opts || {});
    clearTimeout(el._g);
    el._g = setTimeout(function () { if (el.textContent !== text) el.textContent = text; }, 2000);
  }

  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function hexByte() { return HEX.charAt((Math.random() * 16) | 0) + HEX.charAt((Math.random() * 16) | 0); }
  function noise(n) { var s = ''; for (var i = 0; i < n; i++) s += hexByte() + (i < n - 1 ? ' ' : ''); return s; }
  function bar(p, w) {
    var n = Math.round(p * w);
    return '[' + new Array(n + 1).join('#') + new Array(w - n + 1).join('.') + ']';
  }

  // A hex mask in ASCII, as on the YouTube pages: flat eyes for "nothing",
  // crossed eyes for "something went wrong".
  var ART = {
    empty: ['   ________', '  /        \\', ' /  ==  ==  \\', ' \\          /', '  \\________/'].join('\n'),
    error: ['   ________', '  /        \\', ' /  ><  ><  \\', ' \\   ____   /', '  \\________/'].join('\n')
  };

  function isFav(id) { return favs.indexOf(id) !== -1; }

  function toggleFav(id) {
    var i = favs.indexOf(id);
    if (i === -1) favs.push(id); else favs.splice(i, 1);
    try { localStorage.setItem('g-favs', JSON.stringify(favs)); } catch (e) { /* blocked */ }
    favN.textContent = favs.length || '';
    return i === -1;
  }

  function setSave(btn, on, name) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', (on ? 'unsave ' : 'save ') + name);
    btn.title = on ? 'saved' : 'save';
  }

  /* ---------- loading the lists ---------- */

  function serverConfig() {
    return fetch('/proxy/config.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('static host'); return r.json(); })
      .catch(function () { return {}; });
  }

  // Keep only entries we can safely build URLs from. Featured games go first.
  function clean(list, covers) {
    var out = [];
    list.forEach(function (z) {
      if (!z || typeof z.name !== 'string' || typeof z.url !== 'string' || typeof z.id !== 'number') return;
      if (z.id < 0 || z.name.indexOf('[!]') === 0) return; // ads and notices, not games
      if (z.url.indexOf('{HTML_URL}/') !== 0) return;
      var file = z.url.slice('{HTML_URL}/'.length);
      if (!/^[A-Za-z0-9_.-]{1,80}\.html$/.test(file)) return;
      if (typeof z.cover !== 'string' || z.cover.indexOf('{COVER_URL}/') !== 0) return;
      var cover = z.cover.slice('{COVER_URL}/'.length);
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(cover)) return;
      out.push({ id: z.id, name: z.name.slice(0, 120), src: 'play.html#' + encodeURIComponent(file), cover: covers + '/' + cover, hot: z.featured === true, from: 'gn', file: file });
    });
    return out;
  }

  // A path inside a game's folder, e.g. "img/icon.png": clean segments only
  function okPath(p) {
    if (p.length > 160) return false;
    return p.split('/').every(function (s) {
      return s && s !== '.' && s !== '..' && !/[\\\u0000-\u001f]/.test(s);
    });
  }

  // Our own games. Only offered when the main server is there to relay them.
  function loadOwn() {
    return serverConfig()
      .then(function (cfg) {
        if (!cfg.semag) throw new Error('no relay');
        return fetch('semag.json');
      })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (list) {
        var out = [];
        list.forEach(function (z) {
          if (!z || typeof z.n !== 'string' || typeof z.d !== 'string' || typeof z.i !== 'string') return;
          if (!/^[A-Za-z0-9._-]{1,80}$/.test(z.d) || !okPath(z.i)) return;
          out.push({
            id: 's:' + z.d,
            name: z.n.slice(0, 120),
            src: '/semag/' + z.d + '/index.html',
            cover: '/semag/' + z.d + '/' + z.i.split('/').map(encodeURIComponent).join('/'),
            hot: false,
            from: 'r2',
            file: z.d + '/index.html'
          });
        });
        return out;
      })
      .catch(function () { return []; });
  }

  function loadCatalog() {
    return serverConfig().then(function (cfg) {
      var list = cfg.jsgh ? '/jsgh/gn-math/assets@main/zones.json' : LIST;
      var covers = cfg.jsgh ? '/jsgh/gn-math/covers@main' : COVERS;
      return fetch(list, { referrerPolicy: 'no-referrer', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (raw) { return clean(raw, covers); });
    }).catch(function () { return []; });
  }

  // Same game in both sources: keep the gn-math version, hide our R2 copy.
  // If the catalog did not load, every R2 game shows.
  function merge(own, catalog) {
    var seen = {};
    var key = function (n) { return n.toLowerCase().replace(/[^a-z0-9]/g, ''); };
    catalog.forEach(function (g) { seen[key(g.name)] = 1; });
    var all = catalog.concat(own.filter(function (g) { return !seen[key(g.name)]; }));
    all.sort(function (a, b) { return (b.hot - a.hot) || a.name.localeCompare(b.name); });
    all.forEach(function (g, i) { g.n = i + 1; });
    return all;
  }

  /* ---------- scroll-in reveal ---------- */

  // Tiles fade up a few at a time as they scroll in.
  var revealIO = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    var k = 0;
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      var d = Math.min(k++, 11);
      revealIO.unobserve(el);
      el.style.setProperty('--d', String(d));
      el.classList.add('is-in');
      setTimeout(function () {
        el.classList.remove('rv', 'is-in');
        el.style.removeProperty('--d');
      }, 800 + d * 45);
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

  /* ---------- grid ---------- */

  // Mix tile sizes in the full list; search results and saved stay uniform.
  function size(i) {
    if (input.value.trim() || favOnly) return '';
    if (i % 9 === 0) return ' is-big';
    if (i % 9 === 5) return ' is-wide';
    return '';
  }

  function coverOk(e) { e.target.classList.add('is-ok'); }
  function coverBad(e) {
    e.target.classList.add('is-broken');
    if (e.target.parentNode) e.target.parentNode.classList.add('is-broken');
  }

  function card(g, i) {
    var li = document.createElement('li');
    li.className = 'g-card' + size(i);
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'g-open';
    var img = document.createElement('img');
    img.className = 'g-cover';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('load', coverOk);
    img.addEventListener('error', coverBad);
    img.src = g.cover;
    var glyph = make('span', 'g-glyph', g.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toLowerCase() || '??');
    glyph.setAttribute('aria-hidden', 'true');
    var tag = make('span', 'g-play', '> play');
    tag.setAttribute('aria-hidden', 'true');
    var idx = make('span', 'g-idx', pad(g.n || i + 1, 4));
    if (g.hot) idx.appendChild(make('b', null, '*'));
    idx.setAttribute('aria-hidden', 'true');
    var foot = make('span', 'g-foot');
    var name = make('span', 'g-name', g.name);
    var src = make('span', 'g-src', g.from || 'gn');
    src.setAttribute('aria-hidden', 'true');
    foot.append(name, src);
    open.append(img, glyph, idx, tag, foot);
    open.addEventListener('click', function () { play(g); });
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'g-save';
    save.innerHTML = HEART;
    setSave(save, isFav(g.id), g.name);
    save.addEventListener('click', function () {
      var on = toggleFav(g.id);
      if (favOnly && !on) refresh(); else setSave(save, on, g.name);
    });
    saveBtns[g.id] = save;
    li.append(open, save);
    return reveal(li);
  }

  var grid = null;
  var more = null;
  var moreN = null;

  function renderMore() {
    var end = Math.min(rendered + CHUNK, shown.length);
    var frag = document.createDocumentFragment();
    for (; rendered < end; rendered++) frag.appendChild(card(shown[rendered], rendered));
    grid.appendChild(frag);
    more.hidden = rendered >= shown.length;
    moreN.textContent = rendered + '/' + shown.length;
  }

  // "// all games [1118] ------ gn-math 970  r2 148"
  function head(title, count, parts) {
    var box = make('div', 'g-head');
    var h = make('h2', null, title);
    var n = make('span', 'g-count', String(count));
    n.setAttribute('aria-label', count + (count === 1 ? ' game' : ' games'));
    var rule = make('span', 'g-rule');
    rule.setAttribute('aria-hidden', 'true');
    var tags = make('span', 'g-tags');
    tags.setAttribute('aria-hidden', 'true');
    (parts || []).forEach(function (p) {
      if (!p[1]) return;
      var t = make('span', 'g-tag', p[0] + ' ');
      t.appendChild(make('b', null, String(p[1])));
      tags.appendChild(t);
    });
    box.append(h, n, rule, tags);
    return box;
  }

  // act = { label, fn, hint }: a square key under the message (and a dim hint)
  function problem(lines, text, retry, act) {
    var box = make('div', 'g-empty-box' + (retry ? ' is-bad' : ''));
    var art = make('pre', 'g-ascii', retry ? ART.error : ART.empty);
    art.setAttribute('aria-hidden', 'true');
    var log = make('pre', 'g-elog');
    log.setAttribute('aria-hidden', 'true');
    log.textContent = lines.join('\n');
    var p = make('p', null, text);
    box.append(art, log, p);
    if (act && act.hint) box.appendChild(make('p', 'g-hint', act.hint));
    if (retry) act = { label: 'try again', fn: retry };
    if (act) {
      var b = make('button', 'g-more', act.label);
      b.type = 'button';
      b.addEventListener('click', act.fn);
      box.appendChild(b);
    }
    return box;
  }

  function setPath(q) {
    pathEl.textContent = q ? 'search' : favOnly ? 'saved' : 'all';
  }

  function refresh() {
    if (revealIO) revealIO.disconnect();
    var raw = input.value.trim();
    var q = raw.toLowerCase();
    shown = games.filter(function (g) {
      return (!q || g.name.toLowerCase().indexOf(q) !== -1) && (!favOnly || isFav(g.id));
    });
    view.textContent = '';
    rendered = 0;
    saveBtns = {};
    setPath(q);
    hits.textContent = q ? shown.length + (shown.length === 1 ? ' hit' : ' hits') : '';

    var gn = 0;
    shown.forEach(function (g) { if (g.from === 'gn') gn++; });
    var title = q ? 'results' : favOnly ? 'saved' : 'all games';
    var box = head(title, shown.length, [['gn-math', gn], ['r2', shown.length - gn]]);
    view.appendChild(box);
    // decode the heading only when it changes, not on every keystroke
    if (title !== lastTitle) decode(box.firstChild);
    lastTitle = title;
    hits.classList.toggle('is-zero', !!q && !shown.length);

    if (!shown.length) {
      if (favOnly && !q) {
        view.appendChild(problem(['> ls ~/g/saved', 'total 0'], 'nothing saved yet.', null,
          { label: 'browse all', fn: function () { setTab(false); allBtn.focus(); }, hint: '> hint: tap the heart on any game' }));
      } else {
        view.appendChild(problem(['> grep -i "' + raw + '" ~/g/' + (favOnly ? 'saved' : 'all'), '0 matches'], 'no games match "' + raw + '"', null,
          { label: 'clear search', fn: function () { input.value = ''; refresh(); input.focus(); } }));
      }
      return;
    }
    grid = document.createElement('ul');
    grid.className = 'g-grid';
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'g-more';
    more.appendChild(make('span', null, 'show more'));
    moreN = make('span', 'g-more-n');
    moreN.setAttribute('aria-hidden', 'true');
    more.appendChild(moreN);
    more.addEventListener('click', renderMore);
    view.append(grid, more);
    renderMore();
  }

  // Placeholder tiles with the same layout while the lists load.
  function ghosts() {
    if (revealIO) revealIO.disconnect();
    view.textContent = '';
    var box = make('div', 'g-head is-ghost');
    box.append(make('h2', null, 'all games'), make('span', 'g-count', '----'), make('span', 'g-rule'));
    box.setAttribute('aria-hidden', 'true');
    var log = make('p', 'g-wait', '> fetching catalog');
    log.setAttribute('role', 'status');
    var ul = make('ul', 'g-grid');
    ul.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 24; i++) {
      var li = make('li', 'g-card is-ghost' + size(i));
      li.style.setProperty('--i', String(i % 12));
      var b = make('span', 'g-open');
      b.appendChild(make('span', 'g-noise', noise(6)));
      li.appendChild(b);
      ul.appendChild(li);
    }
    view.append(box, log, ul);
  }

  // the result count for screen readers, once typing pauses
  function announce() {
    clearTimeout(liveT);
    liveT = setTimeout(function () {
      var q = input.value.trim();
      live.textContent = !q ? '' : shown.length ? shown.length + (shown.length === 1 ? ' game' : ' games') : 'no matches';
    }, 400);
  }

  /* ---------- tabs and top bar ---------- */

  // the white block under all / saved slides to the pressed one
  function moveTab() {
    var b = favOnly ? favBtn : allBtn;
    if (!b.offsetWidth) return;
    tabBar.style.width = b.offsetWidth + 'px';
    tabBar.style.transform = 'translateX(' + (b.offsetLeft - 3) + 'px)';
    tabBar.classList.add('on');
  }

  function setTab(fav) {
    favOnly = fav;
    allBtn.setAttribute('aria-pressed', fav ? 'false' : 'true');
    favBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    moveTab();
    refresh();
  }

  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      top.classList.toggle('is-scrolled', window.scrollY > 8);
    });
  }

  /* ---------- player and its mount screen ---------- */

  var bootEl = document.getElementById('p-boot');
  var bootBg = document.getElementById('p-boot-bg');
  var bootName = document.getElementById('p-boot-name');
  var bootLog = document.getElementById('p-boot-log');
  var bootBar = document.getElementById('p-boot-bar');
  var bootPct = document.getElementById('p-boot-pct');
  var bootSt = document.getElementById('p-boot-st');
  var bootAct = document.getElementById('p-boot-act');
  bootBg.addEventListener('load', function () { bootBg.classList.add('is-ok'); });
  var boot = { on: false, p: 0, t0: 0, lines: [], tick: 0, poll: 0, cap: 0, hide: 0 };

  function bootDraw() {
    bootBar.textContent = bar(boot.p, 24);
    bootPct.textContent = Math.round(boot.p * 100) + '%';
  }

  var mqSmall = window.matchMedia('(max-width: 480px)');
  function bootLine(s) {
    boot.lines.push(s);
    while (boot.lines.length > (mqSmall.matches ? 4 : 6)) boot.lines.shift();
    bootLog.textContent = boot.lines.join('\n');
  }

  function bootStop() {
    clearInterval(boot.tick);
    clearTimeout(boot.poll);
    clearTimeout(boot.cap);
    clearTimeout(boot.hide);
    boot.on = false;
  }

  function bootStart(g) {
    bootStop();
    boot.on = true;
    boot.p = 0.04;
    boot.t0 = Date.now();
    boot.lines = [];
    bootEl.hidden = false;
    bootEl.classList.remove('is-done', 'is-bad');
    bootAct.hidden = true;
    bootBg.classList.remove('is-ok');
    bootBg.src = g.cover;
    bootName.textContent = g.name;
    bootSt.textContent = 'loading';
    decode(bootName);
    bootLine('> mount ' + (g.from === 'r2' ? '/semag/' : '/jsgh/') + g.file);
    bootLine('> relay ' + (g.from === 'r2' ? 'r2 bucket' : 'gn-math'));
    bootLine('0x0000  ' + noise(8));
    bootLine('0x0040  ' + noise(8));
    bootDraw();
    var calm = reduced();
    var step = 0;
    // Progress is an estimate: it creeps toward 90% until the frame is ready.
    boot.tick = setInterval(function () {
      boot.p += (0.9 - boot.p) * (calm ? 0.05 : 0.035);
      bootDraw();
      if (!calm && ++step % 3 === 0) bootLine('0x' + pad(((step / 3 + 1) * 64).toString(16), 4) + '  ' + noise(8));
    }, calm ? 400 : 90);
    // A game that keeps loading on its own gets the stage after 20 s.
    boot.cap = setTimeout(bootReady, 20000);
  }

  function bootReady() {
    if (!boot.on) return;
    // a short settle after the frame is ready, so the game gets to paint
    var wait = Math.max(reduced() ? 250 : 450, 650 - (Date.now() - boot.t0));
    bootStop();
    boot.hide = setTimeout(function () {
      boot.p = 1;
      bootDraw();
      bootLine('> exec ' + (playing ? playing.file : ''));
      bootSt.textContent = 'ready';
      bootEl.classList.add('is-done');
      boot.hide = setTimeout(function () { bootEl.hidden = true; }, reduced() ? 0 : 520);
    }, wait);
  }

  function bootFail() {
    bootStop();
    bootEl.hidden = false;
    bootEl.classList.add('is-bad');
    bootLine('> error: could not load this game');
    bootSt.textContent = 'could not load this game';
    bootAct.hidden = false;
    document.getElementById('p-retry').focus();
  }

  // play.html shows #g-wait while it fetches the game, then writes the game
  // over itself. Read the frame (same origin) to tell loading, failed, ready.
  function frameState() {
    try {
      var w = frame.contentWindow;
      var d = frame.contentDocument;
      if (!w || !d || w.location.href === 'about:blank') return 'blank';
      var first = d.body && d.body.firstElementChild;
      if (first && /^(could not load this game|bad id)$/.test(first.textContent.trim())) return 'bad';
      if (d.getElementById('g-wait')) return 'wait';
      return 'ok';
    } catch (e) { return 'ok'; }
  }

  function checkFrame() {
    if (!boot.on || !playing) return;
    var s = frameState();
    if (s === 'ok') bootReady();
    else if (s === 'bad') bootFail();
    else if (s === 'wait') boot.poll = setTimeout(checkFrame, 200);
  }
  frame.addEventListener('load', checkFrame);

  // everything behind the player is out of reach while it is open
  function setInert(on) {
    top.toggleAttribute('inert', on);
    view.toggleAttribute('inert', on);
  }

  function play(g) {
    var a = document.activeElement;
    opener = a && a !== document.body && !player.contains(a) ? a : null;
    openerY = window.scrollY;
    playing = g;
    if (window.hit) window.hit.game(g.name);
    pname.textContent = g.name;
    psrc.textContent = g.from === 'r2' ? 'r2' : 'gn-math';
    psave.innerHTML = HEART;
    setSave(psave, isFav(g.id), g.name);
    bootStart(g);
    frame.src = g.src;
    player.hidden = false;
    setInert(true);
    root.classList.add('playing');
    decode(pname);
    document.getElementById('p-close').focus();
  }

  function close() {
    var g = playing;
    bootStop();
    player.hidden = true;
    frame.src = 'about:blank';
    setInert(false);
    root.classList.remove('playing');
    // the heart may have changed in the player
    if (g && favOnly) refresh();
    else if (g && saveBtns[g.id]) setSave(saveBtns[g.id], isFav(g.id), g.name);
    playing = null;
    giveBack(g);
  }

  // Focus goes back to the tile the game was opened from (or its rebuilt
  // twin), with a short bracket lock so the eye finds it again.
  function giveBack(g) {
    var el = opener && opener.isConnected ? opener : null;
    if (!el && g && saveBtns[g.id]) el = saveBtns[g.id].parentNode.querySelector('.g-open');
    opener = null;
    if (Math.abs(window.scrollY - openerY) > 1) window.scrollTo(0, openerY);
    if (!el) { view.focus({ preventScroll: true }); return; }
    el.focus({ preventScroll: true });
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    if (el.classList.contains('g-open')) {
      el.classList.remove('is-back');
      void el.offsetWidth;
      el.classList.add('is-back');
      clearTimeout(el._b);
      el._b = setTimeout(function () { el.classList.remove('is-back'); }, 1100);
    }
  }

  function retry() {
    if (!playing) return;
    var g = playing;
    bootStart(g);
    frame.src = 'about:blank';
    setTimeout(function () { if (playing === g) frame.src = g.src; }, 30);
  }

  function fullscreen() {
    if (frame.requestFullscreen) frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  }

  /* ---------- wiring ---------- */

  document.getElementById('p-close').addEventListener('click', close);
  document.getElementById('p-back').addEventListener('click', close);
  document.getElementById('p-retry').addEventListener('click', retry);
  psave.addEventListener('click', function () {
    if (playing) setSave(psave, toggleFav(playing.id), playing.name);
  });
  document.getElementById('p-full').addEventListener('click', fullscreen);
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape' && !player.hidden && !document.fullscreenElement) close();
    else if (e.key === 'Escape' && player.hidden && t === input && input.value) { input.value = ''; refresh(); announce(); }
    else if (e.ctrlKey || e.metaKey || e.altKey || typing) return;
    else if (e.key === '/' && player.hidden) { e.preventDefault(); input.focus(); input.select(); }
    else if ((e.key === 'f' || e.key === 'F') && !player.hidden) fullscreen();
  });
  document.getElementById('g-search').addEventListener('submit', function (e) { e.preventDefault(); });
  input.addEventListener('input', function () { refresh(); announce(); });
  allBtn.addEventListener('click', function () { setTab(false); });
  favBtn.addEventListener('click', function () { setTab(true); });
  favN.textContent = favs.length || '';
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', moveTab);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTab);
  moveTab();

  function load() {
    ghosts();
    loadBar.classList.add('on');
    Promise.all([loadOwn(), loadCatalog()]).then(function (lists) {
      games = merge(lists[0], lists[1]);
      if (!games.length) throw new Error('empty');
      loadBar.classList.remove('on');
      refresh();
    }).catch(function () {
      loadBar.classList.remove('on');
      view.textContent = '';
      view.appendChild(problem(['> fetch ~/g/catalog', 'error: no response'], 'could not load the game list.', function () { view.textContent = ''; load(); }));
    });
  }
  load();
})();
