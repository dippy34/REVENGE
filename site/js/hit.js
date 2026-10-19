/* hit.js: counts this page view on our own server (server/stats.mjs).
   Sends only the page, the name of the site the visitor came from, and the
   name of a game when one is opened. No cookies, nothing stored here.
   On YouTube only the section counts (home, shorts, ...), never what was
   searched or watched. The proxy page never reports where it browses. */
(function () {
  'use strict';

  function send(d) {
    try {
      var body = JSON.stringify(d);
      if (navigator.sendBeacon && navigator.sendBeacon('/api/p', new Blob([body], { type: 'application/json' }))) return;
      fetch('/api/p', { method: 'POST', body: body, keepalive: true, headers: { 'content-type': 'application/json' } })
        .catch(function () {});
    } catch (e) { /* counting must never break the page */ }
  }

  function referrer() {
    try {
      var h = new URL(document.referrer).hostname;
      return h && h !== location.hostname ? h : '';
    } catch (e) { return ''; }
  }

  var yt = /^\/youtube\/?$/.test(location.pathname);
  function page() {
    if (!yt) return location.pathname;
    var section = (location.hash.split('/')[1] || 'home').replace(/[^a-z]/gi, '').slice(0, 20);
    return '/youtube/' + (section || 'home');
  }

  var last = '';
  function view(ref) {
    var p = page();
    if (p === last) return;
    last = p;
    send(ref ? { p: p, r: ref } : { p: p });
  }

  view(referrer());
  if (yt) window.addEventListener('hashchange', function () { view(''); });

  window.hit = {
    game: function (name) { send({ p: location.pathname, g: String(name).slice(0, 120) }); }
  };
})();
