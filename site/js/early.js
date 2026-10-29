/* early.js: loaded blocking in <head> so it runs before first paint.
   Marks JS as available, decides whether the boot screen plays (so the
   menu never flashes underneath it), whether this page was reached
   through one of our own transitions (so the power-on curtain is there
   from the very first frame), and which effects tier the page starts on
   (html[data-fx], so a weak device never paints the heavy version first).
   Keep this file tiny. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // fx.js sets this one-shot flag (a timestamp) right before it navigates
  // here. A stale one, left by a page that never read it, is ignored.
  var arrived = false;
  try {
    var at = +sessionStorage.getItem('fx.in');
    if (at) {
      sessionStorage.removeItem('fx.in');
      arrived = Math.abs(Date.now() - at) < 5000;
    }
  } catch (e) { /* blocked */ }

  // Boot plays on the first visit to the menu only. If storage is blocked
  // we cannot remember the visit, so we skip it rather than replay it.
  var boot = false;
  if (root.getAttribute('data-page') === 'menu' && !calm) {
    var seen = true;
    try { seen = localStorage.getItem('boot') === '1'; } catch (e) { /* blocked */ }
    boot = !seen;
  }

  if (boot) root.classList.add('boot');
  else if (arrived && !calm) root.classList.add('fx-in');

  /* ---------- effects tier ---------- */

  // high = everything, mid = lighter, low = near-still. Order of authority:
  // ?fx=low|mid|high|auto in the URL (kept as the override; auto clears
  // it), the stored
  // override (fx.tier.force), the measured tier cached by fx.js (fx.tier,
  // for 3 days and the same screen class), and on a first visit a guess
  // from device hints. fx.js measures and corrects it after load.
  // xlow (extra low) is only ever picked: it runs as low with html.fx-xlow
  var TIERS = { high: 1, mid: 1, low: 1, xlow: 1 };
  var MAX_AGE = 3 * 864e5;
  var force = null, tier = null, src = 'hint', ls = null, weak = false;
  try { ls = window.localStorage; } catch (e) { /* blocked */ }

  var q = /[?&]fx=(xlow|low|mid|high|auto)(?:&|#|$)/.exec(location.search);
  if (q && ls) {
    try {
      // auto: forget the override and the measurement, measure again
      if (q[1] === 'auto') { ls.removeItem('fx.tier.force'); ls.removeItem('fx.tier'); }
      else ls.setItem('fx.tier.force', q[1]);
    } catch (e) { /* full or blocked */ }
  }
  if (q && q[1] !== 'auto') force = q[1];
  else if (!q && ls) {
    try { force = ls.getItem('fx.tier.force'); } catch (e) { force = null; }
  }
  if (!TIERS[force]) force = null;

  // phone / tablet-or-laptop / large, from the screen rather than the
  // window, so resizing a window does not count as a new device
  var sw = (window.screen && screen.width) || window.innerWidth || 0;
  var sh = (window.screen && screen.height) || window.innerHeight || 0;
  var sc = Math.min(sw, sh) < 600 ? 's' : Math.max(sw, sh) <= 1440 ? 'm' : 'l';

  // Device hints, each worth a point or two; none decides on its own.
  function mq(s) { return !!(window.matchMedia && window.matchMedia(s).matches); }
  var nav = navigator, score = 0;
  var cores = nav.hardwareConcurrency || 0, mem = nav.deviceMemory || 0;
  if (cores && cores <= 2) score -= 2; else if (cores && cores <= 4) score -= 1;
  if (mem && mem <= 2) score -= 2; else if (mem && mem <= 4) score -= 1;
  if (nav.connection && nav.connection.saveData) score -= 2;
  if (mq('(prefers-reduced-transparency: reduce)')) score -= 1;
  if (mq('(pointer: coarse)') && Math.min(sw, sh) < 600) score -= 1;
  var guess = score >= -1 ? 'high' : score >= -3 ? 'mid' : 'low';

  if (force) {
    tier = force;
    src = 'force';
  } else if (ls) {
    try {
      var c = JSON.parse(ls.getItem('fx.tier') || 'null');
      if (c && TIERS[c.tier] && c.sc === sc && Date.now() - c.at < MAX_AGE && c.at <= Date.now() + 6e4) {
        tier = c.tier;
        src = 'cache';
        weak = !!c.weak; // measured where no canvas ran; fx.js checks again
      }
    } catch (e) { /* bad entry: measure again */ }
  }
  if (!tier) tier = guess;
  if (tier === 'xlow') {
    // extra low: the low tier, and nothing moves (no boot, no curtain)
    tier = 'low';
    root.classList.add('fx-xlow');
    root.classList.remove('boot', 'fx-in');
  }

  root.setAttribute('data-fx', tier);
  // read once by fx.js, which owns the tier from here on
  root._fxBoot = { tier: tier, src: src, hint: score, guess: guess, sc: sc, weak: weak };
})();
