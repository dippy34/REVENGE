/* stats.js: the private stats page. Reads /api/stats with the stats key
   (kept in localStorage on this device) and draws it. Text only, no
   innerHTML from the data. Refreshes every 30 s while the tab is open. */
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

  try { key = localStorage.getItem('s-key') || ''; } catch (e) { /* blocked */ }

  var NAMES = { '/': 'menu', '/games/': 'games', '/proxy/': 'proxy', '/stats/': 'stats' };
  function pageName(p) {
    if (NAMES[p]) return NAMES[p];
    var m = /^\/youtube\/(\w+)$/.exec(p);
    if (m) return 'youtube · ' + m[1];
    return p;
  }

  var num = function (n) { return Number(n || 0).toLocaleString(); };
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
    msg.textContent = text || '';
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
    rows.forEach(function (r) {
      var li = document.createElement('li');
      li.style.setProperty('--w', Math.max(2, Math.round(r[1] / max * 100)) + '%');
      var s = document.createElement('span');
      s.textContent = label ? label(r[0]) : r[0];
      s.title = r[0];
      var b = document.createElement('b');
      b.textContent = num(r[1]);
      li.append(s, b);
      el.appendChild(li);
    });
  }

  function chart(days) {
    var box = $('s-chart');
    box.textContent = '';
    tip.hidden = true;
    var max = Math.max.apply(null, days.map(function (d) { return d.visitors; }).concat([1]));
    var step = Math.ceil(days.length / 8);
    days.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 's-bar' + (d.visitors ? '' : ' is-zero');
      var text = dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' +
        num(d.visitors) + ' visitors · ' + num(d.visits) + ' visits · ' + num(d.views) + ' page views · ' + num(d.plays) + ' games';
      b.setAttribute('aria-label', text);
      var bar = document.createElement('i');
      bar.style.height = (d.visitors / max * 100) + '%';
      b.appendChild(bar);
      if ((days.length - 1 - i) % step === 0) {
        var em = document.createElement('em');
        em.textContent = dayLabel(d.day);
        b.appendChild(em);
      }
      var on = function () {
        Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('is-on'); });
        b.classList.add('is-on');
        tip.textContent = text;
        tip.hidden = false;
      };
      b.addEventListener('mouseenter', on);
      b.addEventListener('focus', on);
      b.addEventListener('click', on);
      box.appendChild(b);
    });
  }

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
      li.append(t, s);
      el.appendChild(li);
    });
  }

  function draw(s, chartDays) {
    $('t-visitors').textContent = num(s.totals.visitors);
    $('t-visits').textContent = num(s.totals.visits);
    $('t-views').textContent = num(s.totals.views);
    $('t-plays').textContent = num(s.totals.plays);
    $('t-per').textContent = s.totals.visits ? (s.totals.views / s.totals.visits).toFixed(1) + ' per visit' : 'pages opened';
    $('s-online').textContent = num(s.online);
    $('h-daily').textContent = 'unique visitors per day' + (s.range < 7 ? ' (last 14 days)' : '');
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
      form.hidden = true;
      board.hidden = false;
      tabs.hidden = false;
      $('s-live').hidden = false;
      draw(r[0], (r[1] || r[0]).days);
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
