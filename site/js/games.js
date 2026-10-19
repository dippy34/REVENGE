/* games.js: the games grid. The list and covers come from GitHub raw, the
   game itself is loaded inside games/play.html (sandboxed, no storage access
   to this site). Favourites live in localStorage on this device only. */
(function () {
  'use strict';

  var RAW = 'https://raw.githubusercontent.com/gn-math/';
  var LIST = RAW + 'assets/main/zones.json';
  var COVERS = RAW + 'covers/main';
  var CHUNK = 60;

  var view = document.getElementById('view');
  var input = document.getElementById('g-q');
  var favBtn = document.getElementById('g-fav');
  var count = document.getElementById('g-count');
  var player = document.getElementById('player');
  var frame = document.getElementById('p-frame');
  var pname = document.getElementById('p-name');

  var games = [];
  var shown = [];
  var rendered = 0;
  var favOnly = false;
  var favs = [];
  try { favs = JSON.parse(localStorage.getItem('g-favs') || '[]'); } catch (e) { /* blocked */ }
  if (!Array.isArray(favs)) favs = [];

  function saveFavs() {
    try { localStorage.setItem('g-favs', JSON.stringify(favs)); } catch (e) { /* blocked */ }
  }

  // Keep only entries we can safely build URLs from.
  function clean(list) {
    var out = [];
    list.forEach(function (z) {
      if (!z || typeof z.name !== 'string' || typeof z.url !== 'string' || typeof z.id !== 'number') return;
      if (z.id < 0 || z.url.indexOf('{HTML_URL}/') !== 0) return; // skips the discord ad
      var file = z.url.slice('{HTML_URL}/'.length);
      if (!/^[A-Za-z0-9_.-]{1,80}\.html$/.test(file)) return;
      if (typeof z.cover !== 'string' || z.cover.indexOf('{COVER_URL}/') !== 0) return;
      var cover = z.cover.slice('{COVER_URL}/'.length);
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(cover)) return;
      out.push({ id: z.id, name: z.name.slice(0, 120), file: file, cover: COVERS + '/' + cover });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  function card(g) {
    var li = document.createElement('li');
    li.className = 'g-card';
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
    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'g-star';
    star.setAttribute('aria-label', 'save ' + g.name);
    var on = favs.indexOf(g.id) !== -1;
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
    star.textContent = on ? '★' : '☆';
    star.addEventListener('click', function () {
      var i = favs.indexOf(g.id);
      if (i === -1) favs.push(g.id); else favs.splice(i, 1);
      saveFavs();
      if (favOnly) refresh(); else {
        var now = i === -1;
        star.setAttribute('aria-pressed', now ? 'true' : 'false');
        star.textContent = now ? '★' : '☆';
      }
    });
    li.append(open, star);
    return li;
  }

  var grid = null;
  var more = null;

  function renderMore() {
    var end = Math.min(rendered + CHUNK, shown.length);
    var frag = document.createDocumentFragment();
    for (; rendered < end; rendered++) frag.appendChild(card(shown[rendered]));
    grid.appendChild(frag);
    if (more) more.hidden = rendered >= shown.length;
  }

  function refresh() {
    var q = input.value.trim().toLowerCase();
    shown = games.filter(function (g) {
      return (!q || g.name.toLowerCase().indexOf(q) !== -1) && (!favOnly || favs.indexOf(g.id) !== -1);
    });
    count.textContent = shown.length + ' / ' + games.length;
    view.textContent = '';
    rendered = 0;
    if (!shown.length) {
      var p = document.createElement('p');
      p.className = 'g-empty';
      p.textContent = favOnly && !q ? 'nothing saved yet' : 'no matches';
      view.appendChild(p);
      return;
    }
    grid = document.createElement('ul');
    grid.className = 'g-grid';
    grid.style.cssText = 'list-style:none;margin:0;padding:0';
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'g-fav';
    more.style.cssText = 'display:block;margin:24px auto 0';
    more.textContent = 'show more';
    more.addEventListener('click', renderMore);
    view.append(grid, more);
    renderMore();
  }

  function play(g) {
    pname.textContent = g.name;
    frame.src = 'play.html#' + encodeURIComponent(g.file);
    player.hidden = false;
    document.documentElement.classList.add('playing');
    document.getElementById('p-close').focus();
  }

  function close() {
    player.hidden = true;
    frame.src = 'about:blank';
    document.documentElement.classList.remove('playing');
  }

  document.getElementById('p-close').addEventListener('click', close);
  document.getElementById('p-full').addEventListener('click', function () {
    if (frame.requestFullscreen) frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !player.hidden && !document.fullscreenElement) close();
  });
  document.getElementById('g-search').addEventListener('submit', function (e) { e.preventDefault(); });
  input.addEventListener('input', refresh);
  favBtn.addEventListener('click', function () {
    favOnly = !favOnly;
    favBtn.setAttribute('aria-pressed', favOnly ? 'true' : 'false');
    refresh();
  });

  function load() {
    fetch(LIST, { referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (list) {
        games = clean(list);
        if (!games.length) throw new Error('empty');
        refresh();
      })
      .catch(function () {
        view.textContent = '';
        var p = document.createElement('p');
        p.className = 'g-empty';
        p.textContent = 'could not load the game list. ';
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'g-fav';
        b.textContent = 'retry';
        b.addEventListener('click', function () { view.textContent = 'loading'; load(); });
        p.appendChild(b);
        view.appendChild(p);
      });
  }
  load();
})();
