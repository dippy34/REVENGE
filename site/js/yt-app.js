/* yt-app.js: the YouTube section, a hash-routed single page.
     #/start            build (or rebuild) your feed
     #/home             the feed, with a Shorts shelf
     #/shorts[/id]      the Shorts reel
     #/watch/id[/t]     a video
     #/search/query     search results
     #/channel/UCid     a channel
     #/subs             latest from your subscriptions
     #/library          interests, likes, history, subscriptions
   Data comes from yt-api.js, taste from yt-profile.js. Anything that came
   from the network is rendered with textContent only, never as HTML. */
(function () {
  'use strict';

  var api = window.ytApi;
  var me = window.ytProfile;
  var root = document.documentElement;
  var view = document.getElementById('view');
  var toastEl = document.getElementById('yt-toast');
  var searchForm = document.getElementById('yt-search');
  var searchInput = document.getElementById('yt-q');
  var navLinks = document.querySelectorAll('[data-nav]');

  var ID = /^[A-Za-z0-9_-]{11}$/;
  var CH = /^UC[A-Za-z0-9_-]{22}$/;
  var EMBED = 'https://www.youtube-nocookie.com/embed/';
  var EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  var PER_TOPIC = 12;   // videos taken from each topic per feed batch
  var TOPICS = 4;       // topics per feed batch
  var SUGGEST = [
    'minecraft', 'fortnite', 'gaming', 'music', 'hip hop', 'football', 'basketball', 'f1',
    'cars', 'cooking', 'science', 'space', 'tech', 'coding', 'anime', 'movies',
    'comedy', 'skateboarding', 'fitness', 'art', 'history', 'nature', 'chess', 'speedruns'
  ];

  var known = {};     // id -> the richest record seen this session
  var cleanup = [];   // teardown for the current view: players, observers, listeners
  var feed, reel, shelf;
  resetFeed();

  function resetFeed() {
    feed = { items: [], buffer: {}, cursor: {}, busy: false, dry: 0, scroll: 0 };
    reel = { items: [], buffer: {}, cursor: {}, i: 0, busy: false };
    shelf = null;
  }

  /* ---------- tiny DOM helper ---------- */

  // h('a', { class, text, href, onclick, ... }, ...children)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) put(el, arguments[i]);
    return el;
  }

  // icon('M..'): a stroked 24x24 line icon from one or more path strings
  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < arguments.length; i++) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', arguments[i]);
      svg.appendChild(p);
    }
    return svg;
  }

  // add(el, ...children): nodes, strings, arrays of them; null is skipped
  function add(el) {
    for (var i = 1; i < arguments.length; i++) put(el, arguments[i]);
  }

  function put(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(function (k) { put(el, k); });
    else el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }

  function mount() {
    view.textContent = '';
    put(view, Array.prototype.slice.call(arguments));
  }

  var toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }

  /* ---------- records ---------- */

  var FIELDS = ['title', 'channel', 'channelId', 'duration', 'views', 'published', 'thumb', 'likes', 'subscribers', 'handle'];

  // One canonical object per video id, filled in as better data arrives.
  // `src` is the topic that brought the video in, for the profile.
  function remember(v, src) {
    var r = known[v.id] || (known[v.id] = { id: v.id, short: false, src: '' });
    FIELDS.forEach(function (f) { if (v[f]) r[f] = v[f]; });
    if (v.short) r.short = true;
    if (src && !r.src) r.src = src;
    return r;
  }

  function initial(name) {
    return (String(name || '').replace(/^@/, '').charAt(0) || '·').toUpperCase();
  }

  function line() {
    return Array.prototype.filter.call(arguments, Boolean).join(' · ');
  }

  // rough age in seconds from "3 days ago", for sorting subscriptions
  function age(text) {
    var m = /(\d+)\s*(second|minute|hour|day|week|month|year)/.exec(text || '');
    if (!m) return Infinity;
    return +m[1] * { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2]];
  }

  /* ---------- pasted links ---------- */

  var HOSTS = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'
  ];
  var NOT_IDS = ['videoseries', 'live_stream'];

  // A watch, youtu.be, shorts, embed or live link -> { id, start }, else null.
  function parseLink(s) {
    var u;
    try { u = new URL(s.indexOf('://') > 0 ? s : 'https://' + s); } catch (e) { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
    if (HOSTS.indexOf(u.hostname) < 0) return null;
    var parts = u.pathname.split('/').filter(Boolean);
    var id = null;
    if (u.hostname === 'youtu.be') {
      if (parts.length === 1) id = parts[0];
    } else if (parts.length === 1 && parts[0] === 'watch') {
      id = u.searchParams.get('v');
    } else if (parts.length === 2 && /^(shorts|embed|live)$/.test(parts[0])) {
      id = parts[1];
    }
    if (!id || !ID.test(id) || NOT_IDS.indexOf(id) >= 0) return null;
    return { id: id, start: parseStart(u.searchParams.get('t') || u.searchParams.get('start')), short: parts[0] === 'shorts' };
  }

  // "90", "90s", "1m30s", "1h2m3s" -> seconds
  function parseStart(t) {
    var m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(t || '');
    if (!m) return 0;
    var n = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return n > 0 && n < 360000 ? n : 0;
  }

  // Search box input that is really a video: a link, or a bare id that
  // has a digit, - or _ in it (so an 11-letter word still searches).
  function asVideo(s) {
    if (/\s/.test(s)) return null;
    if (ID.test(s)) return /[0-9_-]/.test(s) ? { id: s, start: 0 } : null;
    return /[./]/.test(s) ? parseLink(s) : null;
  }

  /* ---------- the player ---------- */

  function frame(id, opts) {
    var q = new URLSearchParams({
      autoplay: '1', rel: '0', playsinline: '1', iv_load_policy: '3',
      enablejsapi: '1', origin: location.origin
    });
    if (opts.start) q.set('start', String(opts.start));
    if (opts.loop) { q.set('loop', '1'); q.set('playlist', id); }
    var f = document.createElement('iframe');
    f.title = 'video player';
    // Restrictive: no popups, forms, top navigation, downloads or sensors.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    // YouTube refuses embeds that send no Referer at all (error 153), so
    // this frame alone sends the bare origin: no path, no query.
    f.setAttribute('referrerpolicy', 'strict-origin');
    f.src = EMBED + id + '?' + q.toString(); // last, so every restriction applies
    return f;
  }

  // Listen to the embed's own progress messages (enablejsapi=1) without
  // loading YouTube's iframe API script: say "listening", then read the
  // infoDelivery messages it posts back. Returns a stop function.
  function track(f, onState) {
    var heard = false;
    var ping = setInterval(function () {
      if (heard) { clearInterval(ping); return; }
      if (f.contentWindow) {
        f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), EMBED_ORIGIN);
      }
    }, 750);
    function onMessage(e) {
      if (e.origin !== EMBED_ORIGIN || e.source !== f.contentWindow) return;
      var d;
      try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return; }
      if (!d || typeof d !== 'object') return;
      heard = true;
      var info = d.info && typeof d.info === 'object' ? d.info : {};
      onState({ time: num(info.currentTime), duration: num(info.duration) });
    }
    window.addEventListener('message', onMessage);
    return function () {
      clearInterval(ping);
      window.removeEventListener('message', onMessage);
    };
  }

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  /* ---------- building blocks ---------- */

  function ghosts(n, cls) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(h('div', { class: cls + ' is-ghost', 'aria-hidden': 'true' },
        h('div', { class: 'thumb' }), h('div', { class: 'ghost-line' }), h('div', { class: 'ghost-line is-short' })));
    }
    return out;
  }

  function problem(text, retry) {
    return h('div', { class: 'yt-empty' },
      h('p', { text: text }),
      retry ? h('button', { class: 'pill', type: 'button', text: 'try again', onclick: retry }) : null);
  }

  function hideCard(v, box) {
    me.hide(v);
    box.classList.add('is-gone');
    setTimeout(function () { box.remove(); }, 260);
    toast('removed. you will see less like this.');
  }

  function img(v) {
    return h('img', {
      src: api.thumb(v), alt: '', loading: 'lazy', decoding: 'async',
      onerror: function (e) { e.target.classList.add('is-broken'); }
    });
  }

  // seen: watched-id set from the profile, computed once per render
  function videoCard(v, seen, opts) {
    v = remember(v);
    opts = opts || {};
    var watched = seen && seen[v.id];
    var box = h('div', { class: 'card' + (opts.row ? ' is-row' : '') + (watched ? ' is-seen' : '') },
      h('a', { class: 'card-link', href: (v.short ? '#/shorts/' : '#/watch/') + v.id },
        h('div', { class: 'thumb' },
          img(v),
          v.duration ? h('span', { class: 'dur', text: v.duration }) : null,
          watched ? h('span', { class: 'seen', text: 'watched' }) : null),
        h('div', { class: 'card-meta' },
          opts.row ? null : h('span', { class: 'ava', 'aria-hidden': 'true', text: initial(v.channel) }),
          h('div', { class: 'card-text' },
            h('h3', { class: 'card-title', text: v.title || 'untitled' }),
            h('p', { class: 'card-sub', text: opts.row ? v.channel : line(v.channel, v.views, v.published) }),
            opts.row ? h('p', { class: 'card-sub', text: line(v.views, v.published) }) : null))));
    box.appendChild(h('button', {
      class: 'card-x', type: 'button', title: 'not interested',
      'aria-label': 'not interested: ' + (v.title || v.id),
      onclick: function () { hideCard(v, box); }
    }, '×'));
    return box;
  }

  // Shorts open in the reel, which continues with the rest of `list`.
  function shortCard(v, list) {
    v = remember(v);
    return h('a', {
      class: 'short', href: '#/shorts/' + v.id,
      onclick: function () { seedReel(list, v.id); }
    },
      h('div', { class: 'short-thumb' }, img(v)),
      h('p', { class: 'short-title', text: v.title || 'untitled' }),
      v.views ? h('p', { class: 'short-sub', text: v.views }) : null);
  }

  function shortsShelf(items, title) {
    if (!items.length) return null;
    return h('section', { class: 'shelf', 'aria-label': title },
      h('h2', { class: 'yt-h', text: title }),
      h('div', { class: 'shelf-row' }, items.map(function (v) { return shortCard(v, items); })));
  }

  // Infinite scroll: call load() whenever `tail` nears the viewport.
  // load resolves false when there is nothing more.
  function infinite(tail, load) {
    var busy = false;
    var done = false;
    // Geometry decides, not the observer's first report, which some
    // browsers get wrong for elements already on screen at load.
    function near() {
      return tail.isConnected && tail.getBoundingClientRect().top < window.innerHeight + 700;
    }
    var io = new IntersectionObserver(function () { if (near()) go(); }, { rootMargin: '700px 0px' });
    function go() {
      if (busy || done) return;
      busy = true;
      tail.textContent = '';
      tail.appendChild(h('span', { class: 'spin', text: 'loading' }));
      load().then(function (more) {
        busy = false;
        tail.textContent = '';
        if (more === false) { done = true; io.disconnect(); return; }
        // page still short of the bottom? keep filling
        if (!done && near()) go();
      }, function (err) {
        busy = false;
        tail.textContent = '';
        tail.appendChild(problem((err && err.message) || 'something went wrong', go));
      });
    }
    io.observe(tail);
    requestAnimationFrame(function () { if (near()) go(); });
    cleanup.push(function () { done = true; io.disconnect(); });
  }

  /* ---------- feed batches ---------- */

  // Take `count` videos for a topic, from leftovers first, fetching the
  // topic's next page when they run low.
  function take(state, topic, filter, count) {
    var buf = state.buffer[topic] || (state.buffer[topic] = []);
    if (buf.length >= count || state.cursor[topic] === null) return Promise.resolve(buf.splice(0, count));
    return api.search(topic, filter, state.cursor[topic] || '').then(function (r) {
      state.cursor[topic] = r.next; // null once the topic runs dry
      r.items.forEach(function (v) { buf.push(remember(v, topic)); });
      return buf.splice(0, count);
    });
  }

  // One list per topic slot. A topic picked twice is fetched twice in a
  // row (page 1, then page 2), never in parallel. onTopic(topic, n, err)
  // reports progress for the build log.
  function batch(state, topics, filter, per, onTopic) {
    var counts = {};
    topics.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    var names = Object.keys(counts);
    var lists = [];
    var failed = 0;
    return Promise.all(names.map(function (t) {
      var got = 0;
      var chain = Promise.resolve();
      for (var i = 0; i < counts[t]; i++) {
        chain = chain.then(function () {
          return take(state, t, filter, per).then(function (l) { lists.push(l); got += l.length; });
        });
      }
      return chain.then(function () {
        if (onTopic) onTopic(t, got);
      }, function (err) {
        failed++;
        if (onTopic) onTopic(t, 0, err);
      });
    })).then(function () {
      if (failed === names.length) throw new Error('the search service is not answering right now');
      return lists;
    });
  }

  function moreFeed(onTopic) {
    var exclude = {};
    feed.items.forEach(function (v) { exclude[v.id] = 1; });
    return batch(feed, me.pickTopics(TOPICS), 'videos', PER_TOPIC, onTopic).then(function (lists) {
      var fresh = me.interleave(lists, exclude);
      feed.items = feed.items.concat(fresh);
      feed.dry = fresh.length ? 0 : feed.dry + 1;
      return fresh;
    });
  }

  function moreShorts() {
    if (reel.busy) return Promise.resolve([]);
    reel.busy = true;
    var exclude = {};
    reel.items.forEach(function (v) { exclude[v.id] = 1; });
    return batch(reel, me.pickTopics(2), 'shorts', 8).then(function (lists) {
      var fresh = me.interleave(lists, exclude);
      reel.items = reel.items.concat(fresh);
      return fresh;
    }).finally(function () { reel.busy = false; });
  }

  function seedReel(list, id) {
    var ids = {};
    reel.items.forEach(function (v) { ids[v.id] = 1; });
    var head = list.filter(function (v) { return !ids[v.id]; });
    reel.items = head.concat(reel.items);
    reel.i = Math.max(0, reel.items.findIndex(function (v) { return v.id === id; }));
  }

  /* ---------- views ---------- */

  // #/start: type what you like, then the first batch is built live.
  function start() {
    setNav('');
    window.scrollTo(0, 0);
    var chosen = me.interests();
    var input = h('input', {
      id: 'like-q', type: 'text', maxlength: '60', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'off', enterkeyhint: 'enter', placeholder: 'type a topic'
    });
    var mine = h('div', { class: 'chips' });
    var none = h('p', { class: 'picks-empty', text: 'nothing yet. type a topic above or tap one below.' });
    var bars = [h('i'), h('i'), h('i')];
    var meterText = h('span');
    var ideas = h('div', { class: 'chips is-ideas' });
    var goText = h('span', { text: 'build my feed' });
    var go = h('button', { class: 'btn-go', type: 'button' }, goText, icon('M5 12h14', 'M13 6l6 6-6 6'));
    var hint = h('p', { class: 'build-hint' });
    var log = h('div', { class: 'build-log', 'aria-live': 'polite' });

    function addLike(s) {
      String(s).split(',').forEach(function (part) {
        var k = part.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
        if (k && chosen.indexOf(k) < 0 && chosen.length < 20) chosen.push(k);
      });
      paint();
    }
    function paint() {
      mine.textContent = '';
      ideas.textContent = '';
      chosen.forEach(function (c) {
        mine.appendChild(h('button', {
          class: 'chip is-on', type: 'button', 'aria-label': 'remove ' + c,
          onclick: function () { chosen.splice(chosen.indexOf(c), 1); paint(); }
        }, c, h('span', { class: 'chip-mark', 'aria-hidden': 'true', text: '×' })));
      });
      SUGGEST.forEach(function (s) {
        if (chosen.indexOf(s) >= 0) return;
        ideas.appendChild(h('button', { class: 'chip', type: 'button', onclick: function () { addLike(s); } },
          h('span', { class: 'chip-plus', 'aria-hidden': 'true', text: '+' }), s));
      });
      none.hidden = chosen.length > 0;
      bars.forEach(function (b, i) { b.className = i < chosen.length ? 'on' : ''; });
      meterText.textContent = chosen.length + ' picked';
      go.disabled = !chosen.length;
      hint.textContent = chosen.length >= 3 ? 'nice mix. ready when you are.' :
        chosen.length ? 'add ' + (3 - chosen.length) + ' more for a better mix' : 'pick at least one topic';
    }
    function say(text, cls) {
      log.appendChild(h('div', { class: cls || '', text: text }));
    }
    function build() {
      go.disabled = true;
      input.disabled = true;
      log.textContent = '';
      me.create(chosen);
      resetFeed();
      say('> building your feed');
      moreFeed(function (topic, n, err) {
        say('  ' + topic + ' ' + new Array(Math.max(3, 22 - topic.length)).join('.') + ' ' + (err ? 'failed' : n + ' videos'), err ? 'is-bad' : '');
      }).then(function (items) {
        say('> ' + items.length + ' videos ready', 'is-ok');
        setTimeout(function () { location.replace('#/home'); }, 650);
      }, function (err) {
        say('> ' + err.message, 'is-bad');
        go.disabled = false;
        input.disabled = false;
        goText.textContent = 'try again';
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addLike(input.value);
        input.value = '';
      }
    });
    go.addEventListener('click', build);

    mount(h('section', { class: 'start' },
      h('h1', { class: 'yt-h1', text: 'what are you into?' }),
      h('p', { class: 'start-sub', text: 'pick a few topics and we will build your feed from them. it keeps learning from what you watch.' }),
      h('div', { class: 'start-field' },
        h('label', { class: 'sr', for: 'like-q', text: 'add a topic' }),
        h('span', { class: 'start-prompt' }, icon('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm16 16 4.5 4.5')),
        input,
        h('button', { class: 'pill is-solid', type: 'button', text: 'add', onclick: function () { addLike(input.value); input.value = ''; input.focus(); } })),
      h('div', { class: 'picks' },
        h('div', { class: 'picks-head' },
          h('p', { class: 'start-label', text: 'your picks' }),
          h('div', { class: 'meter', 'aria-hidden': 'true' }, bars, meterText)),
        none,
        mine),
      log,
      h('p', { class: 'start-label', text: 'popular topics' }),
      ideas,
      h('div', { class: 'start-go' }, h('div', { class: 'start-go-in' }, hint, go))));
    paint();
    input.focus();
  }

  // #/home: Shorts shelf + the feed, endless.
  function home() {
    var shelfBox = h('div', { class: 'shelf-slot' });
    var grid = h('div', { class: 'grid' });
    var tail = h('div', { class: 'tail' });
    mount(shelfBox, grid, tail);
    var seen = me.watched();

    function append(items) {
      items.forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
    }
    if (feed.items.length) {
      append(feed.items);
      var y = feed.scroll;
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    } else {
      add(grid, ghosts(8, 'card'));
    }

    if (shelf) {
      add(shelfBox, shortsShelf(shelf, 'shorts'));
    } else {
      batch(reel, me.pickTopics(2), 'shorts', 6).then(function (lists) {
        shelf = me.interleave(lists, {}).slice(0, 12);
        seedReel(shelf, shelf.length ? shelf[0].id : '');
        if (shelfBox.isConnected) add(shelfBox, shortsShelf(shelf, 'shorts'));
      }).catch(function () { /* no shelf is fine */ });
    }

    infinite(tail, function () {
      if (feed.dry > 2) return Promise.resolve(false);
      return moreFeed().then(function (items) {
        Array.prototype.slice.call(grid.querySelectorAll('.is-ghost')).forEach(function (g) { g.remove(); });
        append(items);
        return true;
      });
    });
    cleanup.push(function () { feed.scroll = window.scrollY; });
  }

  // #/watch/id: player, actions, up next.
  function watch(id, startAt) {
    window.scrollTo(0, 0);
    var v = remember({ id: id });
    var f = frame(id, { start: startAt });
    var title = h('h1', { class: 'w-title' });
    var ava = h('span', { class: 'ava', 'aria-hidden': 'true' });
    var chName = h('a', { class: 'w-channel' });
    var chSubs = h('span', { class: 'w-subs' });
    var subBtn = h('button', { class: 'pill is-solid', type: 'button' });
    var likeBtn = h('button', { class: 'pill', type: 'button' });
    var hideBtn = h('button', { class: 'pill', type: 'button', text: 'not interested' });
    var stats = h('p', { class: 'w-stats' });
    var nextList = h('div', { class: 'w-list' }, ghosts(6, 'card is-row'));

    mount(h('div', { class: 'watch' },
      h('div', { class: 'w-main' },
        h('div', { class: 'w-screen' }, f),
        title,
        h('div', { class: 'w-row' },
          h('div', { class: 'w-owner' }, ava, h('div', { class: 'w-who' }, chName, chSubs)),
          h('div', { class: 'w-actions' }, subBtn, likeBtn, hideBtn)),
        stats),
      h('aside', { class: 'w-next', 'aria-label': 'up next' }, h('h2', { class: 'yt-h', text: 'up next' }), nextList)));
    root.classList.add('playing');

    function paint() {
      document.title = '~/v';
      title.textContent = v.title || 'video';
      ava.textContent = initial(v.channel);
      chName.textContent = v.channel || ' ';
      if (v.channelId) chName.setAttribute('href', '#/channel/' + v.channelId);
      chSubs.textContent = v.subscribers || '';
      var liked = me.isLiked(v.id);
      likeBtn.textContent = (liked ? 'liked' : 'like') + (v.likes ? ' · ' + v.likes : '');
      likeBtn.setAttribute('aria-pressed', String(liked));
      var subbed = v.channelId && me.isSubbed(v.channelId);
      subBtn.textContent = subbed ? 'subscribed' : 'subscribe';
      subBtn.setAttribute('aria-pressed', String(!!subbed));
      subBtn.disabled = !v.channelId;
      subBtn.classList.toggle('is-solid', !subbed);
      stats.textContent = line(v.views, v.published);
    }

    likeBtn.addEventListener('click', function () {
      toast(me.toggleLike(v) ? 'liked. more like this.' : 'like removed.');
      paint();
    });
    subBtn.addEventListener('click', function () {
      if (!v.channelId) return;
      toast(me.toggleSub(v.channelId, v.channel) ? 'subscribed to ' + (v.channel || 'channel') + '.' : 'unsubscribed.');
      paint();
    });
    hideBtn.addEventListener('click', function () {
      me.hide(v);
      toast('got it. you will see less like this.');
      location.hash = '#/home';
    });

    paint();
    me.signal('open', v);
    me.addHistory(v);

    // watched for a minute, or half of a short video: that counts
    var credited = false;
    cleanup.push(track(f, function (s) {
      if (!credited && s.time > 0 && s.time >= Math.min(60, (s.duration || 120) * 0.5)) {
        credited = true;
        me.signal('watch', v);
      }
    }));

    function upNext() {
      var q = v.src || v.channel || String(v.title || '').split(/\s+/).slice(0, 4).join(' ') || 'popular';
      api.search(q, 'videos').then(function (r) {
        var exclude = {};
        exclude[v.id] = 1;
        var items = me.interleave([r.items.map(function (x) { return remember(x, q); })], exclude).slice(0, 15);
        var seen = me.watched();
        nextList.textContent = '';
        items.forEach(function (x) { nextList.appendChild(videoCard(x, seen, { row: true })); });
        if (!items.length) nextList.appendChild(problem('nothing up next.'));
      }, function (err) {
        nextList.textContent = '';
        nextList.appendChild(problem(err.message, upNext));
      });
    }

    if (v.title && v.channelId) upNext();
    else {
      api.details([id]).then(function (d) {
        if (d[id]) {
          v = remember(d[id]);
          paint();
          me.addHistory(v);
        }
        upNext();
      });
    }
  }

  // #/shorts[/id]: one Short at a time, vertical, endless.
  function shorts(startId) {
    window.scrollTo(0, 0);
    if (startId && !reel.items.some(function (v) { return v.id === startId; })) {
      seedReel([remember({ id: startId, short: true })], startId);
    } else if (startId) {
      reel.i = reel.items.findIndex(function (v) { return v.id === startId; });
    }

    var stage = h('div', { class: 'reel-stage' });
    var title = h('p', { class: 'reel-title' });
    var chName = h('a', { class: 'reel-channel' });
    var likeBtn = h('button', { class: 'pill', type: 'button' });
    var subBtn = h('button', { class: 'pill is-solid', type: 'button' });
    var hideBtn = h('button', { class: 'pill', type: 'button', text: 'not interested' });
    var prevBtn = h('button', { class: 'pill reel-arrow', type: 'button', 'aria-label': 'previous short', text: '↑' });
    var nextBtn = h('button', { class: 'pill reel-arrow', type: 'button', 'aria-label': 'next short', text: '↓' });
    var box = h('section', { class: 'reel', 'aria-label': 'shorts' },
      h('div', { class: 'reel-col' }, stage, h('div', { class: 'reel-info' }, title, chName)),
      h('div', { class: 'reel-side' }, prevBtn, nextBtn, likeBtn, subBtn, hideBtn));
    mount(box);

    var cur = null;
    var stop = null;
    var shownAt = 0;
    var best = 0;
    var dur = 0;
    var looped = false;

    // Decide what the Short we are leaving tells us about taste: watched
    // through (or looped) is a like-lite, swiped away within 3s is a skip,
    // anything in between is mild interest.
    function judge() {
      if (!cur) return;
      if (looped || (dur && best >= dur * 0.8)) me.signal('watch', cur);
      else if (Date.now() - shownAt < 3000) me.signal('skip', cur);
      else me.signal('open', cur);
    }

    function paint() {
      if (!cur) return;
      title.textContent = cur.title || '';
      chName.textContent = cur.channel || '';
      if (cur.channelId) chName.setAttribute('href', '#/channel/' + cur.channelId);
      else chName.removeAttribute('href');
      var liked = me.isLiked(cur.id);
      likeBtn.textContent = liked ? 'liked' : 'like';
      likeBtn.setAttribute('aria-pressed', String(liked));
      var subbed = cur.channelId && me.isSubbed(cur.channelId);
      subBtn.textContent = subbed ? 'subscribed' : 'subscribe';
      subBtn.disabled = !cur.channelId;
      subBtn.classList.toggle('is-solid', !subbed);
      prevBtn.disabled = reel.i === 0;
    }

    // Shorts search results carry no channel; look them up in small batches.
    function fillChannels() {
      var ids = reel.items.slice(reel.i, reel.i + 8)
        .filter(function (v) { return !v.channelId; })
        .map(function (v) { return v.id; });
      if (!ids.length) return;
      api.details(ids).then(function (d) {
        Object.keys(d).forEach(function (k) { remember(d[k]); });
        paint();
      });
    }

    function show(i) {
      judge();
      if (stop) stop();
      if (!reel.items.length) {
        stage.textContent = '';
        stage.appendChild(problem('no shorts yet.', function () { moreShorts().then(function () { show(0); }); }));
        return;
      }
      reel.i = Math.max(0, Math.min(i, reel.items.length - 1));
      cur = reel.items[reel.i];
      history.replaceState(null, '', '#/shorts/' + cur.id);
      shownAt = Date.now();
      best = 0;
      dur = 0;
      looped = false;
      var f = frame(cur.id, { loop: true });
      stage.textContent = '';
      stage.appendChild(f);
      root.classList.add('playing');
      stop = track(f, function (s) {
        if (s.duration) dur = s.duration;
        if (dur && best >= dur * 0.8 && s.time < 1) looped = true;
        if (s.time > best) best = s.time;
      });
      me.addHistory(cur);
      paint();
      fillChannels();
      if (reel.items.length - reel.i < 4) moreShorts().then(paint, function () {});
    }

    function step(d) {
      if (d > 0 && reel.i >= reel.items.length - 1) {
        moreShorts().then(function () { if (reel.i < reel.items.length - 1) show(reel.i + 1); });
        return;
      }
      show(reel.i + d);
    }

    likeBtn.addEventListener('click', function () {
      if (cur) toast(me.toggleLike(cur) ? 'liked. more like this.' : 'like removed.');
      paint();
    });
    subBtn.addEventListener('click', function () {
      if (!cur || !cur.channelId) return;
      toast(me.toggleSub(cur.channelId, cur.channel) ? 'subscribed to ' + (cur.channel || 'channel') + '.' : 'unsubscribed.');
      paint();
    });
    hideBtn.addEventListener('click', function () {
      if (!cur) return;
      me.hide(cur);
      reel.items.splice(reel.i, 1);
      cur = null;
      toast('got it. you will see less like this.');
      show(reel.i);
    });
    prevBtn.addEventListener('click', function () { step(-1); });
    nextBtn.addEventListener('click', function () { step(1); });

    // keys, wheel and swipes outside the player move through the reel
    function onKey(e) {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
    }
    var wheelAt = 0;
    function onWheel(e) {
      if (Math.abs(e.deltaY) < 30 || Date.now() - wheelAt < 700) return;
      wheelAt = Date.now();
      e.preventDefault();
      step(e.deltaY > 0 ? 1 : -1);
    }
    var touchY = null;
    function onTouchStart(e) { touchY = e.touches[0].clientY; }
    function onTouchEnd(e) {
      if (touchY == null) return;
      var dy = touchY - e.changedTouches[0].clientY;
      touchY = null;
      if (Math.abs(dy) > 60) step(dy > 0 ? 1 : -1);
    }
    document.addEventListener('keydown', onKey);
    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchend', onTouchEnd, { passive: true });
    cleanup.push(function () {
      judge();
      if (stop) stop();
      document.removeEventListener('keydown', onKey);
    });

    if (reel.items.length) show(reel.i);
    else {
      stage.appendChild(h('span', { class: 'spin', text: 'loading' }));
      moreShorts().then(function () { if (box.isConnected) show(0); }, function (err) {
        stage.textContent = '';
        stage.appendChild(problem(err.message, function () { route(); }));
      });
    }
  }

  // #/search/query
  function results(q) {
    q = q.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!q) { location.replace('#/home'); return; }
    window.scrollTo(0, 0);
    searchInput.value = q;
    me.searched(q);
    var shelfBox = h('div', { class: 'shelf-slot' });
    var grid = h('div', { class: 'grid' }, ghosts(8, 'card'));
    var tail = h('div', { class: 'tail' });
    mount(h('h1', { class: 'yt-h1', text: q }), shelfBox, grid, tail);
    var next = '';
    var first = true;
    var seen = me.watched();
    infinite(tail, function () {
      if (!first && !next) return Promise.resolve(false);
      return api.search(q, 'all', next).then(function (r) {
        var items = r.items.map(function (v) { return remember(v, q); });
        if (first) {
          grid.textContent = '';
          add(shelfBox, shortsShelf(items.filter(function (v) { return v.short; }).slice(0, 12), 'shorts'));
          if (!items.length) grid.appendChild(problem('no results for that.'));
        }
        first = false;
        items.filter(function (v) { return !v.short; }).forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
        next = r.next || '';
        return !!next;
      });
    });
  }

  // #/channel/UCid
  function channelPage(id) {
    window.scrollTo(0, 0);
    var head = h('header', { class: 'ch-head' }, h('span', { class: 'spin', text: 'loading' }));
    var shelfBox = h('div', { class: 'shelf-slot' });
    var grid = h('div', { class: 'grid' });
    var tail = h('div', { class: 'tail' });
    mount(head, shelfBox, grid, tail);
    var next = '';
    var first = true;
    var seen = me.watched();

    function paintHead(info) {
      var subbed = me.isSubbed(id);
      var btn = h('button', { class: 'pill' + (subbed ? '' : ' is-solid'), type: 'button', text: subbed ? 'subscribed' : 'subscribe' });
      btn.addEventListener('click', function () {
        toast(me.toggleSub(id, info.title) ? 'subscribed to ' + (info.title || 'channel') + '.' : 'unsubscribed.');
        paintHead(info);
      });
      head.textContent = '';
      add(head,
        h('span', { class: 'ava is-big', 'aria-hidden': 'true', text: initial(info.title) }),
        h('div', { class: 'ch-who' },
          h('h1', { class: 'yt-h1', text: info.title || 'channel' }),
          h('p', { class: 'card-sub', text: line(info.handle, info.subscribers, info.videos) })),
        btn);
    }

    infinite(tail, function () {
      if (!first && !next) return Promise.resolve(false);
      return api.channel(id, 'videos', next).then(function (r) {
        if (first) paintHead(r.info);
        first = false;
        r.items.forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
        next = r.next || '';
        return !!next;
      });
    });
    api.channel(id, 'shorts').then(function (r) {
      if (shelfBox.isConnected) add(shelfBox, shortsShelf(r.items.slice(0, 12), 'shorts'));
    }, function () { /* channels without Shorts are fine */ });
  }

  // #/subs: newest uploads across your subscriptions.
  function subs() {
    window.scrollTo(0, 0);
    var list = me.subs();
    if (!list.length) {
      mount(h('h1', { class: 'yt-h1', text: 'subscriptions' }),
        problem('no subscriptions yet. subscribe from any video or channel.'));
      return;
    }
    var grid = h('div', { class: 'grid' }, ghosts(8, 'card'));
    mount(h('h1', { class: 'yt-h1', text: 'subscriptions' }),
      h('div', { class: 'chips' }, list.map(function (s) {
        return h('a', { class: 'chip', href: '#/channel/' + s.id, text: s.name || 'channel' });
      })),
      grid);
    Promise.all(list.slice(0, 12).map(function (s) {
      return api.channel(s.id, 'videos').then(function (r) { return r.items.slice(0, 8); }, function () { return []; });
    })).then(function (lists) {
      var all = [].concat.apply([], lists);
      all.sort(function (a, b) { return age(a.published) - age(b.published); });
      var seen = me.watched();
      grid.textContent = '';
      all.slice(0, 60).forEach(function (v) { grid.appendChild(videoCard(v, seen)); });
      if (!all.length) grid.appendChild(problem('could not load your subscriptions right now.', subs));
    });
  }

  // #/library: what this browser knows about you, and the off switches.
  function library() {
    window.scrollTo(0, 0);
    var seen = me.watched();
    var likes = me.likes();
    var hist = me.history();
    var subsList = me.subs();

    function grid(items) {
      return h('div', { class: 'grid is-small' }, items.map(function (v) { return videoCard(v, seen); }));
    }
    function section(title, action, body) {
      return h('section', { class: 'lib' },
        h('div', { class: 'lib-head' }, h('h2', { class: 'yt-h', text: title }), action), body);
    }

    mount(
      h('h1', { class: 'yt-h1', text: 'library' }),
      section('your interests',
        h('a', { class: 'pill', href: '#/start', text: 'edit & rebuild' }),
        h('div', { class: 'chips' }, me.interests().map(function (s) { return h('span', { class: 'chip is-on', text: s }); }))),
      section('liked', null,
        likes.length ? grid(likes.slice(0, 24)) : problem('nothing liked yet.')),
      section('history',
        hist.length ? h('button', { class: 'pill', type: 'button', text: 'clear history', onclick: function () {
          me.clear('history');
          toast('history cleared.');
          library();
        } }) : null,
        hist.length ? grid(hist.slice(0, 24)) : problem('nothing watched yet.')),
      section('subscriptions', null,
        subsList.length ? h('div', { class: 'chips' }, subsList.map(function (s) {
          return h('span', { class: 'chip is-on' },
            h('a', { href: '#/channel/' + s.id, text: s.name || 'channel' }),
            h('button', { type: 'button', class: 'chip-x', 'aria-label': 'unsubscribe from ' + (s.name || 'channel'), text: '×', onclick: function () {
              me.toggleSub(s.id, s.name);
              library();
            } }));
        })) : problem('no subscriptions yet.')),
      section('this browser', null,
        h('div', { class: 'yt-empty' },
          h('p', { text: 'your interests, likes, subscriptions and history are stored only in this browser.' }),
          h('button', { class: 'pill', type: 'button', text: 'forget everything', onclick: function () {
            me.forget();
            resetFeed();
            toast('everything forgotten.');
            location.hash = '#/start';
          } }))));
  }

  /* ---------- routing ---------- */

  function setNav(name) {
    Array.prototype.forEach.call(navLinks, function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return ''; }
  }

  function route() {
    cleanup.splice(0).forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } });
    root.classList.remove('playing');
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var head = parts[0] || 'home';
    var building = !me.exists() || head === 'start';
    document.body.classList.toggle('is-start', building);
    if (building) return start();
    setNav(head);
    if (head === 'home') return home();
    if (head === 'shorts') return shorts(ID.test(parts[1]) ? parts[1] : '');
    if (head === 'watch' && ID.test(parts[1])) return watch(parts[1], parseInt(parts[2], 10) || 0);
    if (head === 'search') return results(decode(parts.slice(1).join('/')));
    if (head === 'channel' && CH.test(parts[1])) return channelPage(parts[1]);
    if (head === 'subs') return subs();
    if (head === 'library') return library();
    location.replace('#/home');
  }

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    if (!q) return;
    var link = asVideo(q);
    if (link) {
      searchInput.value = '';
      location.hash = (link.short ? '#/shorts/' + link.id : '#/watch/' + link.id + (link.start ? '/' + link.start : ''));
    } else {
      location.hash = '#/search/' + encodeURIComponent(q.slice(0, 100));
    }
    searchInput.blur();
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.body.classList.contains('is-start')) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  try { localStorage.removeItem('yt.recent'); } catch (e) { /* old phase-2 list */ }
  window.addEventListener('hashchange', route);
  route();
})();
