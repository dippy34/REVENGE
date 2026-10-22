/* yt-api.js: client for this origin's YouTube API (search, channel
   tabs, video details). The server talks to YouTube; this page does not
   contact nova-hub or any other search host.
   Everything that comes back is someone else's data, so it is treated as
   untrusted: ids are checked against strict patterns, text is trimmed, and
   the UI only ever renders it as text. Results are cached in localStorage
   for a short while so repeat views do not hammer the server. */
(function () {
  'use strict';

  var BASE = '/api/';
  var TIMEOUT = 12000;
  var CACHE_KEY = 'yt.cache';
  var CACHE_MAX = 40;                 // entries; each is a trimmed result list
  var TTL_SEARCH = 30 * 60 * 1000;    // feeds should feel fresh
  var TTL_DETAILS = 6 * 3600 * 1000;  // titles and channels rarely change
  var MAX_QUERY = 100;

  var ID = /^[A-Za-z0-9_-]{11}$/;
  var CH = /^UC[A-Za-z0-9_-]{22}$/;
  var TOKEN = /^[A-Za-z0-9_%=.+\/-]{1,4096}$/;
  var DURATION = /^\d{1,3}(:\d{2}){1,2}$/;

  function str(v, max) {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  // Only thumbnails of this exact video on YouTube's image host are kept.
  function thumbOf(v) {
    var u = str(v.thumbnail, 600);
    return u.indexOf('https://i.ytimg.com/vi/' + v.id + '/') === 0 ? u : '';
  }

  // One clean video record, or null when the id is not a real video id.
  function clean(v, forceShort) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !ID.test(v.id)) return null;
    var dur = str(v.duration, 12);
    var short = forceShort || v.isShort === true;
    return {
      id: v.id,
      title: str(v.title, 200),
      channel: str(v.channel, 100),
      channelId: CH.test(v.channelId) ? v.channelId : '',
      duration: DURATION.test(dur) ? dur : '',
      views: str(v.views, 40),
      published: str(v.published, 40),
      short: short,
      thumb: short ? thumbOf(v) : ''
    };
  }

  function cleanList(list, forceShort) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 60; i++) {
      var v = clean(list[i], forceShort);
      if (v) out.push(v);
    }
    return out;
  }

  function token(t) {
    return typeof t === 'string' && TOKEN.test(t) ? t : null;
  }

  /* ---------- small localStorage cache ---------- */

  function cacheRead() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
  }

  function cacheGet(key, ttl) {
    var c = cacheRead()[key];
    return c && Date.now() - c.t < ttl ? c.d : null;
  }

  function cacheSet(key, data) {
    var all = cacheRead();
    var now = Date.now();
    all[key] = { t: now, d: data };
    var keys = Object.keys(all).sort(function (a, b) { return all[b].t - all[a].t; });
    keys.slice(CACHE_MAX).forEach(function (k) { delete all[k]; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) { /* full or blocked */ }
  }

  /* ---------- fetch ---------- */

  var inflight = {};

  // GET path?params, shape the JSON, cache the shaped result.
  function get(path, params, shape, ttl) {
    var key = path + '?' + new URLSearchParams(params).toString();
    var hit = cacheGet(key, ttl);
    if (hit) return Promise.resolve(hit);
    if (inflight[key]) return inflight[key];

    function once() {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT);
      return fetch(BASE + key, {
        signal: ctl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' }
      })
        .then(function (r) {
          if (!r.ok) throw new Error('search service answered ' + r.status);
          return r.json();
        })
        .then(function (json) {
          if (!json || json.success === false) throw new Error('search service returned an error');
          return json;
        })
        .catch(function (err) {
          throw new Error(err && err.name === 'AbortError' ? 'search service timed out' : (err && err.message) || 'search service unreachable');
        })
        .finally(function () { clearTimeout(timer); });
    }

    // YouTube times out now and then (502/504); one retry fixes most.
    var p = once()
      .catch(function () {
        return new Promise(function (ok) { setTimeout(ok, 700); }).then(once);
      })
      .then(function (json) {
        var data = shape(json);
        cacheSet(key, data);
        return data;
      })
      .finally(function () { delete inflight[key]; });
    inflight[key] = p;
    return p;
  }

  /* ---------- endpoints ---------- */

  // filter: 'videos' (no Shorts), 'shorts', or 'all'
  function search(query, filter, next) {
    var q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
    var params = { q: q, filter: filter === 'all' ? 'all' : filter };
    if (next) params.continuation = next;
    return get('tube-search', params, function (j) {
      var items = cleanList(j.videos, filter === 'shorts');
      if (filter === 'videos') items = items.filter(function (v) { return !v.short; });
      if (filter === 'shorts') items = items.filter(function (v) { return v.short; });
      return { items: items, next: token(j.continuation) };
    }, TTL_SEARCH);
  }

  // tab: 'videos' or 'shorts'
  function channel(id, tab, next) {
    if (!CH.test(id)) return Promise.reject(new Error('bad channel id'));
    var params = { channel: id, tab: tab === 'shorts' ? 'shorts' : 'videos' };
    if (next) params.continuation = next;
    return get('tube-search', params, function (j) {
      var c = j.channel || {};
      var items = cleanList(j.videos, tab === 'shorts');
      items.forEach(function (v) {
        if (!v.channelId) v.channelId = id;
        if (!v.channel) v.channel = str(c.title, 100);
      });
      return {
        info: {
          id: id,
          title: str(c.title, 100),
          handle: str(c.handle, 60),
          subscribers: str(c.subscribers, 40),
          videos: str(c.videoCount, 40)
        },
        items: items,
        next: token(j.continuation)
      };
    }, TTL_SEARCH);
  }

  // Up to 8 ids per request; returns { id: details } for the ones found.
  function details(ids) {
    var list = (ids || []).filter(function (id) { return ID.test(id); });
    var chunks = [];
    for (var i = 0; i < list.length; i += 8) chunks.push(list.slice(i, i + 8));
    return Promise.all(chunks.map(function (chunk) {
      return get('tube-video', { ids: chunk.join(',') }, function (j) {
        var out = {};
        (Array.isArray(j.videos) ? j.videos : []).forEach(function (v) {
          if (!v || !ID.test(v.id) || v.error) return;
          out[v.id] = {
            id: v.id,
            title: str(v.title, 200),
            channel: str(v.channel, 100),
            channelId: CH.test(v.channelId) ? v.channelId : '',
            handle: str(v.handle, 60),
            subscribers: str(v.subscribers, 40),
            likes: str(v.likes, 20),
            views: str(v.views, 40),
            published: str(v.published, 40)
          };
        });
        return out;
      }, TTL_DETAILS).catch(function () { return {}; });
    })).then(function (parts) {
      return parts.reduce(function (all, part) {
        Object.keys(part).forEach(function (k) { all[k] = part[k]; });
        return all;
      }, {});
    });
  }

  // Thumbnails are built from the id (small, no tracking params) except
  // Shorts, whose vertical frame only exists at the URL the API gave us.
  function thumb(v) {
    if (v.short && v.thumb) return v.thumb;
    return 'https://i.ytimg.com/vi/' + v.id + (v.short ? '/hqdefault.jpg' : '/mqdefault.jpg');
  }

  // srcset for a video's 16:9 thumbnail: the light size plus a sharper one
  // for dense screens. Same host, same video; the browser picks one. Shorts
  // keep their single vertical frame. (Read-only helper for the UI.)
  function thumbSet(v) {
    if (!v || v.short || !ID.test(v.id)) return '';
    var base = 'https://i.ytimg.com/vi/' + v.id + '/';
    return base + 'mqdefault.jpg 320w, ' + base + 'hqdefault.jpg 480w';
  }

  window.ytApi = { search: search, channel: channel, details: details, thumb: thumb, thumbSet: thumbSet };
})();
