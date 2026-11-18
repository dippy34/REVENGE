/* blank.js: "about:blank" in the other menu opens the site again in a new tab
   whose address bar reads about:blank. That tab holds only a frame of the
   site filling the window, and this tab moves on to a neutral page, so no tab
   shows the address and its history keeps none of the site's pages. It hides
   the site from the screen, not from network monitoring.

   The new tab's about:blank page shares this page's origin and inherits its
   CSP, so it is built with DOM calls only: no inline styles or scripts, and
   the frame is 'self'. Nothing in it relies on this page's code after this
   tab has left, so it keeps working on its own (iPad Safari included). */
(function () {
  'use strict';

  var item = document.querySelector('[data-blank]');
  if (!item) return;

  var NEUTRAL = 'https://www.google.com/';
  var label = item.querySelector('.label');
  var tag = item.querySelector('.item-tag');

  // Inside the blank tab already: the top window is that about:blank page.
  var inside = false;
  try { inside = window.top !== window && window.top.location.href === 'about:blank'; } catch (e) { /* not ours */ }
  if (inside && tag) tag.textContent = 'on';

  // Shake, and scramble the label to a short message and back (as locked rows do).
  function say(msg) {
    item.classList.remove('is-denied');
    void item.offsetWidth; // restart the animation
    item.classList.add('is-denied');
    if (!label || !window.fx || item._busy) return;
    var name = label._final || label.textContent;
    item._busy = true;
    label._final = msg;
    window.fx.scramble(label, { duration: 300 });
    setTimeout(function () {
      label._final = name;
      window.fx.scramble(label, { duration: 300 });
      item._busy = false;
    }, 1400);
  }
  item.addEventListener('animationend', function (e) {
    if (e.animationName === 'denied') item.classList.remove('is-denied');
  });

  function css(el, text) { el.style.cssText = text; }
  function add(doc, parent, tagName, attrs) {
    var el = doc.createElement(tagName);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    parent.appendChild(el);
    return el;
  }

  function launch() {
    // Must run straight from the tap or click, or the pop-up blocker steps in.
    var w = window.open('about:blank', '_blank');
    if (!w) return say('allow pop-ups');
    var d;
    try {
      d = w.document;
      add(d, d.head, 'meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' });
      add(d, d.head, 'meta', { name: 'color-scheme', content: 'dark' });
      add(d, d.head, 'meta', { name: 'referrer', content: 'no-referrer' });
      css(d.documentElement, 'height:100%;background:#000');
      css(d.body, 'margin:0;height:100%;overflow:hidden;background:#000');
      var f = d.createElement('iframe');
      f.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture; gamepad; clipboard-write; screen-wake-lock');
      f.setAttribute('allowfullscreen', '');
      css(f, 'position:fixed;top:0;left:0;width:100%;height:100%;border:0;margin:0;padding:0;display:block;background:#000');
      f.src = location.href.replace(/#.*$/, '');
      d.body.appendChild(f);
    } catch (e) {
      // could not build it (should not happen: same origin): leave nothing half-made
      try { w.close(); } catch (err) { /* gone */ }
      return say('blocked');
    }
    try { w.focus(); } catch (e) { /* fine */ }
    location.replace(NEUTRAL);
  }

  item.addEventListener('click', function (e) {
    e.preventDefault();
    if (inside) say('already on');
    else launch();
  });
})();
