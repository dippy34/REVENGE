/* games.js: the games grid. Two sources are merged:
   - our own games from the R2 bucket: games/semag.json lists them, and the
     server relays them under /semag/ (only on the main server)
   - the gn-math catalog: list and covers from GitHub raw, loaded inside
     games/play.html
   Saved games live in localStorage on this device only. */
(function () {
  'use strict';

  var RAW = 'https://raw.githubusercontent.com/gn-math/';
  var LIST = RAW + 'assets/main/zones.json';
  var COVERS = RAW + 'covers/main';
  var CHUNK = 60;
  var HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.9 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.3 0 5.6 3.2 4.4 6.6-1.7 4.8-9.2 9.4-9.2 9.4z"/></svg>';

  var view = document.getElementById('view');
  var input = document.getElementById('g-q');
  var allBtn = document.getElementById('g-all');
  var favBtn = document.getElementById('g-fav');
  var favN = document.getElementById('g-favn');
  var player = document.getElementById('player');
  var frame = document.getElementById('p-frame');
  var pname = document.getElementById('p-name');
  var psave = document.getElementById('p-save');

  var games = [];
  var shown = [];
  var rendered = 0;
  var favOnly = false;
  var playing = null;
  var favs = [];
  try { favs = JSON.parse(localStorage.getItem('g-favs') || '[]'); } catch (e) { /* blocked */ }
  if (!Array.isArray(favs)) favs = [];

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

  // Keep only entries we can safely build URLs from. Featured games go first.
  function clean(list) {
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
      out.push({ id: z.id, name: z.name.slice(0, 120), src: 'play.html#' + encodeURIComponent(file), cover: COVERS + '/' + cover, hot: z.featured === true });
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
    return fetch('/proxy/config.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('static host'); return r.json(); })
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
            hot: false
          });
        });
        return out;
      })
      .catch(function () { return []; });
  }

  function loadCatalog() {
    return fetch(LIST, { referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(clean)
      .catch(function () { return []; });
  }

  // Same game in both sources: keep the gn-math version, hide our R2 copy.
  // If the catalog did not load, every R2 game shows.
  function merge(own, catalog) {
    var seen = {};
    var key = function (n) { return n.toLowerCase().replace(/[^a-z0-9]/g, ''); };
    catalog.forEach(function (g) { seen[key(g.name)] = 1; });
    var all = catalog.concat(own.filter(function (g) { return !seen[key(g.name)]; }));
    all.sort(function (a, b) { return (b.hot - a.hot) || a.name.localeCompare(b.name); });
    return all;
  }

  // Mix tile sizes in the full list; search results and saved stay uniform.
  function size(i) {
    if (input.value.trim() || favOnly) return '';
    if (i % 9 === 0) return ' is-big';
    if (i % 9 === 5) return ' is-wide';
    return '';
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
    img.src = g.cover;
    var name = document.createElement('span');
    name.className = 'g-name';
    name.textContent = g.name;
    open.append(img, name);
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
    li.append(open, save);
    return li;
  }

  var grid = null;
  var more = null;

  function renderMore() {
    var end = Math.min(rendered + CHUNK, shown.length);
    var frag = document.createDocumentFragment();
    for (; rendered < end; rendered++) frag.appendChild(card(shown[rendered], rendered));
    grid.appendChild(frag);
    more.hidden = rendered >= shown.length;
  }

  function refresh() {
    var q = input.value.trim().toLowerCase();
    shown = games.filter(function (g) {
      return (!q || g.name.toLowerCase().indexOf(q) !== -1) && (!favOnly || isFav(g.id));
    });
    view.textContent = '';
    rendered = 0;

    var head = document.createElement('div');
    head.className = 'g-head';
    var h = document.createElement('h2');
    h.textContent = q ? 'results' : favOnly ? 'saved' : 'all games';
    var n = document.createElement('span');
    n.textContent = shown.length + (shown.length === 1 ? ' game' : ' games');
    head.append(h, n);
    view.appendChild(head);

    if (!shown.length) {
      var p = document.createElement('p');
      p.className = 'g-empty';
      p.textContent = favOnly && !q ? 'nothing saved yet. tap the heart on a game to keep it here.' : 'no games match "' + input.value.trim() + '"';
      view.appendChild(p);
      return;
    }
    grid = document.createElement('ul');
    grid.className = 'g-grid';
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'g-more';
    more.textContent = 'show more';
    more.addEventListener('click', renderMore);
    view.append(grid, more);
    renderMore();
  }

  function setTab(fav) {
    favOnly = fav;
    allBtn.setAttribute('aria-pressed', fav ? 'false' : 'true');
    favBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    refresh();
  }

  function play(g) {
    playing = g;
    pname.textContent = g.name;
    psave.innerHTML = HEART;
    setSave(psave, isFav(g.id), g.name);
    frame.src = g.src;
    player.hidden = false;
    document.documentElement.classList.add('playing');
    document.getElementById('p-close').focus();
  }

  function close() {
    player.hidden = true;
    frame.src = 'about:blank';
    document.documentElement.classList.remove('playing');
    if (playing) refresh(); // the heart may have changed in the player
    playing = null;
  }

  document.getElementById('p-close').addEventListener('click', close);
  psave.addEventListener('click', function () {
    if (playing) setSave(psave, toggleFav(playing.id), playing.name);
  });
  document.getElementById('p-full').addEventListener('click', function () {
    if (frame.requestFullscreen) frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !player.hidden && !document.fullscreenElement) close();
  });
  document.getElementById('g-search').addEventListener('submit', function (e) { e.preventDefault(); });
  input.addEventListener('input', refresh);
  allBtn.addEventListener('click', function () { setTab(false); });
  favBtn.addEventListener('click', function () { setTab(true); });
  favN.textContent = favs.length || '';

  function load() {
    Promise.all([loadOwn(), loadCatalog()]).then(function (lists) {
      games = merge(lists[0], lists[1]);
      if (!games.length) throw new Error('empty');
      refresh();
    }).catch(function () {
      view.textContent = '';
      var p = document.createElement('p');
      p.className = 'g-empty';
      p.textContent = 'could not load the game list. ';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-more';
      b.textContent = 'try again';
      b.addEventListener('click', function () { view.textContent = ''; load(); });
      p.appendChild(b);
      view.appendChild(p);
    });
  }
  load();
})();
