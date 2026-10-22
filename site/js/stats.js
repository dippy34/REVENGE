/* stats.js: the private stats page. Reads /api/stats with the stats key
   (kept in localStorage on this device) and draws it. Text only, no
   innerHTML from the data. Refreshes every 30 s while the tab is open.
   Drawn as a HUD: numbers tick up, bars are blocks, lists carry ASCII
   share bars. All of that is instant under reduced motion. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('s-key');
  var input = $('s-key-in');
  var msg = $('s-msg');
  var board = $('s-board');
  var tabs = $('s-tabs');
  var tip = $('s-tip');
  var range = 7;
  var key = '';
  var timer = 0;
  var root = document.documentElement;
  var drawnRange = 0;
  var onIdx = -1; // the chart day picked last, kept across refreshes

  try { key = localStorage.getItem('s-key') || ''; } catch (e) { /* blocked */ }

  var NAMES = { '/': 'menu', '/games/': 'games', '/proxy/': 'proxy', '/stats/': 'stats' };
  function pageName(p) {
    if (NAMES[p]) return NAMES[p];
    var m = /^\/youtube\/(\w+)$/.exec(p);
    if (m) return 'youtube · ' + m[1];
    return p;
  }

  var num = function (n) { return Number(n || 0).toLocaleString(); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function calm() {
    if (window.fx && window.fx.reduced) return window.fx.reduced();
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- hud pieces ---------- */

  // counts up from the number shown before (0 the first time)
  function count(el, n) {
    n = Number(n || 0);
    var from = el._n || 0;
    el._n = n;
    cancelAnimationFrame(el._raf);
    if (calm() || from === n) { el.textContent = num(n); return; }
    var t0 = performance.now(), dur = 900;
    (function frame(t) {
      var k = Math.min(1, (t - t0) / dur);
      k = 1 - Math.pow(1 - k, 3);
      el.textContent = num(Math.round(from + (n - from) * k));
      if (k < 1) el._raf = requestAnimationFrame(frame);
    })(t0);
  }

  // a row of tiny bars under each total, one per day of the chart
  function spark(el, days, field) {
    el.textContent = '';
    var max = Math.max.apply(null, days.map(function (d) { return d[field] || 0; }).concat([1]));
    days.forEach(function (d) {
      var b = document.createElement('i');
      b.style.height = Math.max(4, (d[field] || 0) / max * 100) + '%';
      if (!d[field]) b.className = 'is-zero';
      el.appendChild(b);
    });
  }

  // [######....] from a share of the top row
  function asciiBar(share) {
    var k = Math.max(1, Math.round(share * 10));
    return '[' + new Array(k + 1).join('#') + new Array(11 - k).join('.') + ']';
  }
  var dayLabel = function (ds, opts) {
    var d = new Date(ds + 'T12:00:00');
    return d.toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric' });
  };

  function get(r) {
    return fetch('/api/stats?range=' + r, { headers: { authorization: 'Bearer ' + key }, cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401) throw new Error('key');
        if (res.status === 404) throw new Error('off');
        if (!res.ok) throw new Error('http');
        return res.json();
      });
  }

  function showForm(text) {
    clearInterval(timer);
    board.hidden = true;
    tabs.hidden = true;
    $('s-live').hidden = true;
    form.hidden = false;
    root.classList.remove('s-open');
    if (window.fx) window.fx.rain.resume();
    msg.textContent = text || '';
    msg.classList.toggle('is-bad', !!text);
    form.classList.remove('is-wrong');
    if (text) {
      void form.offsetWidth; // restart the shake
      form.classList.add('is-wrong');
    }
    input.focus();
  }

  function list(el, rows, label) {
    el.textContent = '';
    if (!rows.length) {
      var e = document.createElement('li');
      e.className = 's-empty';
      e.textContent = 'nothing yet';
      el.appendChild(e);
      return;
    }
    var max = rows[0][1] || 1;
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      li.style.setProperty('--i', Math.min(i, 12));
      var n = document.createElement('em');
      n.textContent = pad(i + 1);
      var s = document.createElement('span');
      s.textContent = label ? label(r[0]) : r[0];
      s.title = r[0];
      var bar = document.createElement('code');
      bar.setAttribute('aria-hidden', 'true');
      bar.textContent = asciiBar(r[1] / max);
      var b = document.createElement('b');
      b.textContent = num(r[1]);
      li.append(n, s, bar, b);
      el.appendChild(li);
    });
  }

  // One Tab stop for the whole chart (roving tabindex): the picked day,
  // or today. Arrow keys, Home and End move along the days.
  function chart(days) {
    var box = $('s-chart');
    var hadFocus = box.contains(document.activeElement);
    if (onIdx >= days.length) onIdx = -1;
    var cur = onIdx >= 0 ? onIdx : days.length - 1;
    box.textContent = '';
    tip.hidden = true;
    var max = Math.max.apply(null, days.map(function (d) { return d.visitors; }).concat([1]));
    var step = Math.ceil(days.length / 8);
    var lag = Math.min(14, 560 / days.length);
    $('s-ymax').textContent = num(max);
    $('s-ymid').textContent = max > 1 ? num(Math.round(max / 2)) : '';
    box.classList.toggle('is-dense', days.length > 31);
    days.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 's-bar' + (d.visitors ? '' : ' is-zero');
      var text = dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' +
        num(d.visitors) + ' visitors · ' + num(d.visits) + ' visits · ' + num(d.views) + ' page views · ' + num(d.plays) + ' games';
      b.setAttribute('aria-label', text);
      b.tabIndex = i === cur ? 0 : -1;
      var bar = document.createElement('i');
      bar.style.height = (d.visitors / max * 100) + '%';
      bar.style.setProperty('--d', Math.round(i * lag) + 'ms');
      b.appendChild(bar);
      if (d.visitors === max && d.visitors) b.classList.add('is-peak');
      if ((days.length - 1 - i) % step === 0) {
        var em = document.createElement('em');
        // every other label, counted from today, can drop out on phones
        if (((days.length - 1 - i) / step) % 2) em.className = 'is-alt';
        em.textContent = dayLabel(d.day);
        b.appendChild(em);
      }
      var on = function () {
        Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('is-on'); c.tabIndex = -1; });
        b.classList.add('is-on');
        b.tabIndex = 0;
        onIdx = i;
        tip.textContent = text;
        tip.hidden = false;
      };
      b.addEventListener('mouseenter', on);
      b.addEventListener('focus', on);
      b.addEventListener('click', on);
      box.appendChild(b);
    });
    // a refresh redraws the bars; keep the picked day and the focus on it
    var picked = box.children[cur];
    if (onIdx >= 0 && picked) {
      if (hadFocus) picked.focus({ preventScroll: true });
      else picked.click();
    } else if (hadFocus && picked) {
      picked.focus({ preventScroll: true });
    }
  }

  // arrows scrub the chart; focusing a bar updates the readout
  $('s-chart').addEventListener('keydown', function (e) {
    var bars = this.children, i = Array.prototype.indexOf.call(bars, e.target), n = -1;
    if (i < 0) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = Math.min(bars.length - 1, i + 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = bars.length - 1;
    if (n < 0) return;
    e.preventDefault();
    bars[n].focus();
  });

  function feed(rows) {
    var el = $('l-recent');
    el.textContent = '';
    if (!rows.length) {
      var e = document.createElement('li');
      e.className = 's-empty';
      e.textContent = 'nothing since the server last started';
      el.appendChild(e);
      return;
    }
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var t = document.createElement('time');
      var d = new Date(r.t);
      t.dateTime = d.toISOString();
      t.textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      var s = document.createElement('span');
      s.textContent = r.g ? 'played ' + r.g : 'opened ' + pageName(r.p) + (r.r ? ' (from ' + r.r + ')' : '');
      if (r.g) li.className = 'is-play';
      li.append(t, s);
      el.appendChild(li);
    });
  }

  function draw(s, chartDays) {
    count($('t-visitors'), s.totals.visitors);
    count($('t-visits'), s.totals.visits);
    count($('t-views'), s.totals.views);
    count($('t-plays'), s.totals.plays);
    $('t-per').textContent = s.totals.visits ? (s.totals.views / s.totals.visits).toFixed(1) + ' per visit' : 'pages opened';
    count($('s-online'), s.online);
    $('h-daily').textContent = 'unique visitors per day' + (s.range < 7 ? ' (last 14 days)' : '');
    ['visitors', 'visits', 'views', 'plays'].forEach(function (f) { spark($('k-' + f), chartDays, f); });
    // bars grow in on the first draw and on a new range, not on refreshes
    var box = $('s-chart');
    if (drawnRange !== range) onIdx = -1;
    box.classList.toggle('is-in', drawnRange !== range && !calm());
    drawnRange = range;
    chart(chartDays);
    list($('l-pages'), s.pages, pageName);
    list($('l-games'), s.games);
    list($('l-refs'), s.refs);
    feed(s.recent);
  }

  function load() {
    var jobs = [get(range)];
    if (range < 7) jobs.push(get(14));
    return Promise.all(jobs).then(function (r) {
      var first = board.hidden;
      var fromForm = form.contains(document.activeElement);
      form.hidden = true;
      board.hidden = false;
      tabs.hidden = false;
      $('s-live').hidden = false;
      draw(r[0], (r[1] || r[0]).days);
      if (first) {
        root.classList.add('s-open');
        // the login box is gone: start Tab at the top bar, on the range keys
        if (fromForm) tabs.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
        if (window.fx) {
          window.fx.rain.pause();
          var hs = board.querySelectorAll('h2, .s-tile span');
          for (var i = 0; i < hs.length; i++) window.fx.decode(hs[i], { delay: 80 + i * 50, duration: 460 });
        }
      }
    }).catch(function (e) {
      if (e.message === 'key') {
        try { localStorage.removeItem('s-key'); } catch (x) { /* blocked */ }
        key = '';
        showForm('that key did not work.');
      } else if (e.message === 'off') {
        showForm('stats are switched off on this server.');
      } else if (board.hidden) {
        showForm('could not reach the server. this page only works on the main site.');
      }
    });
  }

  function start() {
    load();
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) load(); }, 30000);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    key = input.value.trim();
    if (!key) return;
    try { localStorage.setItem('s-key', key); } catch (x) { /* blocked */ }
    msg.textContent = 'checking';
    msg.classList.remove('is-bad');
    form.classList.remove('is-wrong');
    start();
  });

  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-range]');
    if (!b) return;
    range = Number(b.getAttribute('data-range'));
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (x) {
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    load();
  });

  if (key) start(); else showForm('');
})();
