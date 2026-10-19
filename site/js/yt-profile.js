/* yt-profile.js: the visitor's own YouTube data and the recommendation
   profile. All of it lives in this browser's localStorage and never leaves
   it; the only thing that goes out is the search phrases the feed asks for.

   How the feed learns:
   - Topics are search phrases. You seed them when you build your feed;
     searching adds new ones; words that keep showing up in titles you watch
     and like get promoted to topics on their own.
   - Channels carry their own weight from watching, liking, subscribing.
   - Every weight halves every two weeks, so the feed follows what you
     like now, not last month.
   - Each batch of the home feed picks 4 topics (stronger topics more often,
     weaker ones still get a chance), takes ~12 videos per topic, deals them
     out one from each in turn, drops duplicates, hidden videos and channels
     you keep rejecting, and pushes anything you have watched to the bottom. */
(function () {
  'use strict';

  var K = {
    profile: 'yt.profile',
    likes: 'yt.likes',
    subs: 'yt.subs',
    history: 'yt.history',
    hidden: 'yt.hidden'
  };
  var DAY = 864e5;
  var HALF_LIFE = 14 * DAY;
  var SEED = 5;          // starting weight of a topic you typed in
  var SEARCHED = 2.5;    // a search counts as a fresh interest
  var PROMOTE = 6;       // a title word this strong becomes a topic
  var BLOCKED = -3;      // a channel this low is left out of feeds
  var MAX = { topics: 60, words: 400, channels: 200, likes: 500, history: 300, hidden: 500, subs: 300 };

  // What each signal is worth. topic: the search phrase the video came from;
  // ch: its channel; words: words in its title.
  var SIGNALS = {
    open:        { topic: 0.5,  ch: 0.5,  words: 0.3 },
    watch:       { topic: 1,    ch: 1.5,  words: 1 },
    skip:        { topic: -0.5, ch: -0.6, words: -0.3 },
    like:        { topic: 2,    ch: 3,    words: 2 },
    unlike:      { topic: -2,   ch: -3,   words: -2 },
    subscribe:   { topic: 0,    ch: 6,    words: 0 },
    unsubscribe: { topic: 0,    ch: -6,   words: 0 },
    hide:        { topic: -1,   ch: -3,   words: -1 }
  };

  // Words too generic to say anything about taste.
  var STOP = {};
  ('the and for you with this that from are was how what why when who all new official video videos ' +
   'shorts short part full my your our his her its they them one two three out not can get got has have ' +
   'had will just but into about best top most more than then day days year years time ever every episode ' +
   'live music hd 4k me we he she it of to in on at by is be do did does so if or an no yes too very really ' +
   'make made making first last only tried try watch world people thing things dont cant ft feat vs ' +
   'challenge reaction react trailer clip clips highlights moments funny compilation update news ' +
   'official video lyric lyrics audio version edit edition ultimate insane crazy huge every hour hours minutes')
    .split(' ').forEach(function (w) { STOP[w] = 1; });

  /* ---------- storage ---------- */

  function read(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* blocked */ }
  }

  function list(key) {
    var v = read(key, []);
    return Array.isArray(v) ? v : [];
  }

  /* ---------- weights ---------- */

  function now() { return Date.now(); }

  function decayed(e, t) {
    if (!e || typeof e.w !== 'number' || typeof e.t !== 'number') return 0;
    return e.w * Math.pow(0.5, Math.max(0, t - e.t) / HALF_LIFE);
  }

  function bump(map, key, delta, extra) {
    if (!key || !delta) return;
    var t = now();
    var e = map[key] || {};
    var w = Math.max(-20, Math.min(50, decayed(e, t) + delta));
    map[key] = Object.assign(e, extra || {}, { w: +w.toFixed(3), t: t });
  }

  // Keep the strongest `max` entries (by absolute weight).
  function trim(map, max) {
    var t = now();
    var keys = Object.keys(map);
    if (keys.length <= max) return;
    keys.sort(function (a, b) { return Math.abs(decayed(map[b], t)) - Math.abs(decayed(map[a], t)); });
    keys.slice(max).forEach(function (k) { delete map[k]; });
  }

  function topicKey(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function words(title) {
    var seen = {};
    return String(title || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(function (w) {
        if (w.length < 3 || w.length > 24 || STOP[w] || /^\d+$/.test(w) || seen[w]) return false;
        seen[w] = 1;
        return true;
      })
      .slice(0, 8);
  }

  /* ---------- profile ---------- */

  function load() {
    var p = read(K.profile, null);
    if (!p || p.v !== 1 || typeof p.topics !== 'object') return null;
    p.words = p.words || {};
    p.channels = p.channels || {};
    return p;
  }

  function save(p) {
    trim(p.topics, MAX.topics);
    trim(p.words, MAX.words);
    trim(p.channels, MAX.channels);
    write(K.profile, p);
  }

  function exists() { return !!load(); }

  // Start (or restart) the profile from the interests you typed.
  function create(interests) {
    var old = load();
    var p = { v: 1, topics: {}, words: old ? old.words : {}, channels: old ? old.channels : {} };
    interests.forEach(function (s) {
      var k = topicKey(s);
      if (k) p.topics[k] = { w: SEED, t: now(), seed: true };
    });
    save(p);
  }

  function interests() {
    var p = load();
    if (!p) return [];
    return Object.keys(p.topics).filter(function (k) { return p.topics[k].seed; });
  }

  function searched(q) {
    var p = load();
    var k = topicKey(q);
    if (!p || !k) return;
    bump(p.topics, k, SEARCHED);
    save(p);
  }

  // Record a signal about a video: { id, title, channel, channelId, src }.
  function signal(type, v) {
    var s = SIGNALS[type];
    var p = load();
    if (!s || !p || !v) return;
    if (v.src && p.topics[v.src]) bump(p.topics, v.src, s.topic);
    if (v.channelId) bump(p.channels, v.channelId, s.ch, { name: v.channel || '' });
    words(v.title).forEach(function (w) {
      bump(p.words, w, s.words);
      // a word that keeps coming up in what you watch becomes its own topic
      if (s.words > 0 && decayed(p.words[w], now()) >= PROMOTE && !p.topics[w]) {
        p.topics[w] = { w: PROMOTE / 2, t: now(), learned: true };
      }
    });
    save(p);
  }

  function channelWeight(id) {
    var p = load();
    return p && id ? decayed(p.channels[id], now()) : 0;
  }

  // n search phrases for the next batch. Weighted sampling without
  // replacement; the +0.5 floor gives weaker topics a real chance.
  function pickTopics(n) {
    var p = load();
    var t = now();
    var pool = p ? Object.keys(p.topics).map(function (k) {
      return { k: k, w: decayed(p.topics[k], t) };
    }).filter(function (x) { return x.w > 0.25; }) : [];
    if (!pool.length) pool = ['music', 'gaming', 'science', 'comedy'].map(function (k) { return { k: k, w: 1 }; });

    var picks = [];
    while (picks.length < n && pool.length) {
      var total = pool.reduce(function (sum, x) { return sum + x.w + 0.5; }, 0);
      var r = Math.random() * total;
      for (var i = 0; i < pool.length; i++) {
        r -= pool[i].w + 0.5;
        if (r <= 0 || i === pool.length - 1) {
          picks.push(pool.splice(i, 1)[0].k);
          break;
        }
      }
    }
    // fewer topics than slots: repeat them; the feed asks for their next page
    for (var j = 0; picks.length < n; j++) picks.push(picks[j]);
    return picks;
  }

  // Deal lists out one from each in turn, drop duplicates (also against
  // `exclude`), hidden videos and rejected channels, then push watched
  // videos to the bottom, keeping order otherwise.
  function interleave(lists, exclude) {
    var seen = Object.assign({}, exclude || {});
    var hidden = idSet(K.hidden);
    var watched = idSet(K.history);
    var p = load();
    var t = now();
    var fresh = [];
    var old = [];
    var longest = lists.reduce(function (m, l) { return Math.max(m, l.length); }, 0);
    for (var i = 0; i < longest; i++) {
      for (var j = 0; j < lists.length; j++) {
        var v = lists[j][i];
        if (!v || seen[v.id] || hidden[v.id]) continue;
        if (p && v.channelId && decayed(p.channels[v.channelId], t) <= BLOCKED) continue;
        seen[v.id] = 1;
        (watched[v.id] ? old : fresh).push(v);
      }
    }
    return fresh.concat(old);
  }

  /* ---------- lists: likes, subscriptions, history, hidden ---------- */

  function idSet(key) {
    var out = {};
    list(key).forEach(function (x) { out[typeof x === 'string' ? x : x.id] = 1; });
    return out;
  }

  function slim(v) {
    return { id: v.id, title: v.title || '', channel: v.channel || '', channelId: v.channelId || '', short: !!v.short, t: now() };
  }

  function addHistory(v) {
    var h = list(K.history).filter(function (x) { return x.id !== v.id; });
    h.unshift(slim(v));
    write(K.history, h.slice(0, MAX.history));
  }

  function isLiked(id) { return !!idSet(K.likes)[id]; }

  function toggleLike(v) {
    var l = list(K.likes);
    var on = !l.some(function (x) { return x.id === v.id; });
    l = l.filter(function (x) { return x.id !== v.id; });
    if (on) l.unshift(slim(v));
    write(K.likes, l.slice(0, MAX.likes));
    signal(on ? 'like' : 'unlike', v);
    return on;
  }

  function isSubbed(channelId) {
    return list(K.subs).some(function (x) { return x.id === channelId; });
  }

  function toggleSub(channelId, name) {
    var s = list(K.subs);
    var on = !s.some(function (x) { return x.id === channelId; });
    s = s.filter(function (x) { return x.id !== channelId; });
    if (on) s.unshift({ id: channelId, name: name || '', t: now() });
    write(K.subs, s.slice(0, MAX.subs));
    signal(on ? 'subscribe' : 'unsubscribe', { channelId: channelId, channel: name });
    return on;
  }

  function hide(v) {
    var h = list(K.hidden).filter(function (id) { return id !== v.id; });
    h.unshift(v.id);
    write(K.hidden, h.slice(0, MAX.hidden));
    signal('hide', v);
  }

  function clear(which) {
    try { localStorage.removeItem(K[which]); } catch (e) { /* blocked */ }
  }

  // Forget everything this page ever stored.
  function forget() {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('yt.') === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* blocked */ }
  }

  window.ytProfile = {
    exists: exists,
    create: create,
    interests: interests,
    searched: searched,
    signal: signal,
    channelWeight: channelWeight,
    pickTopics: pickTopics,
    interleave: interleave,
    watched: function () { return idSet(K.history); },
    history: function () { return list(K.history); },
    addHistory: addHistory,
    likes: function () { return list(K.likes); },
    isLiked: isLiked,
    toggleLike: toggleLike,
    subs: function () { return list(K.subs); },
    isSubbed: isSubbed,
    toggleSub: toggleSub,
    hide: hide,
    clear: clear,
    forget: forget
  };
})();
