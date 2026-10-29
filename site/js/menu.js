/* menu.js: keyboard control, locked entries and the "other" sub-menu on the
   index (and the single way-back row on the 404). Without JS the entries are
   plain links and still work, and #other swaps the lists with CSS alone. */
(function () {
  'use strict';

  var root = document.documentElement;
  var main = document.querySelector('.menu:not(.menu-sub)');
  var sub = document.getElementById('other');
  var opener = document.querySelector('[data-other]');
  if (!main) return;

  function visible() {
    var list = sub && sub.classList.contains('is-open') ? sub : main;
    return Array.prototype.slice.call(list.querySelectorAll('.item'));
  }

  function focusAt(i) {
    var items = visible();
    var n = items.length;
    items[((i % n) + n) % n].focus();
  }

  // A locked entry shakes and briefly scrambles into "soon", then back.
  function deny(item) {
    var label = item.querySelector('.label');
    item.classList.remove('is-denied');
    void item.offsetWidth; // restart the animation
    item.classList.add('is-denied');
    if (!label || !window.fx || item._soon) return;
    var name = label._final || label.textContent;
    item._soon = true;
    label._final = 'soon';
    window.fx.scramble(label, { duration: 300 });
    setTimeout(function () {
      label._final = name;
      window.fx.scramble(label, { duration: 300 });
      item._soon = false;
    }, 900);
  }

  function activate(item) {
    if (item.classList.contains('is-locked')) deny(item);
    else item.click();
  }

  /* ---------- other: swap the lists in place ---------- */

  var swapping = false;
  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  function rows(list) { return Array.prototype.slice.call(list.children); }

  // from leaves (rows struck and torn off), to arrives (rows print in).
  function swap(from, to, origin, then) {
    var fx = window.fx;
    var calm = !fx || fx.reduced();
    timers.forEach(clearTimeout);
    timers = [];
    swapping = true;
    if (fx && !calm && origin) {
      var r = origin.getBoundingClientRect();
      fx.burst(r.left + r.width * 0.3, r.top + r.height / 2, 1.6);
      fx.glitch(document.querySelector('.digest'));
      var shell = document.querySelector('.shell');
      if (shell) {
        shell.classList.add('is-tear');
        later(function () { shell.classList.remove('is-tear'); }, 220);
      }
    }
    var out = rows(from);
    out.forEach(function (li, i) {
      li.style.setProperty('--o', String(i));
      var label = li.querySelector('.label');
      if (label && fx && !calm) fx.scramble(label, { duration: 320 });
    });
    from.classList.add('is-leaving');
    later(function () {
      from.classList.remove('is-leaving');
      from.classList.add('is-gone');
      if (from === sub) from.classList.remove('is-open');
      to.classList.remove('is-gone');
      if (to === sub) to.classList.add('is-open');
      rows(to).forEach(function (li, i) {
        li.style.setProperty('--d', (0.04 + i * 0.09).toFixed(2) + 's');
        var label = li.querySelector('.label');
        if (label && fx && !calm) later(function () { fx.decode(label, { duration: 420 }); }, 40 + i * 90);
      });
      void to.offsetWidth; // restart the entrance
      to.classList.add('is-entering');
      later(function () {
        to.classList.remove('is-entering');
        swapping = false;
      }, 900);
      if (then) then();
    }, calm ? 0 : 300 + out.length * 55);
  }

  function isOpen() { return !!sub && sub.classList.contains('is-open'); }

  function open(origin, viaKey) {
    if (!sub || isOpen() || swapping) return;
    if (location.hash !== '#other') history.pushState({ other: 1 }, '', '#other');
    opener.setAttribute('aria-expanded', 'true');
    swap(main, sub, origin, function () {
      var first = sub.querySelector('.item');
      if (first && viaKey) first.focus();
    });
  }

  function close(origin, viaKey) {
    if (!isOpen() || swapping) return;
    opener.setAttribute('aria-expanded', 'false');
    swap(sub, main, origin, function () {
      if (viaKey) opener.focus();
    });
  }

  if (sub && opener) {
    // Arriving at /#other (a shared link, or reload) opens it straight away.
    if (location.hash === '#other') {
      main.classList.add('is-gone');
      sub.classList.add('is-open');
      opener.setAttribute('aria-expanded', 'true');
    }
    opener.addEventListener('click', function (e) {
      e.preventDefault();
      open(opener, e.detail === 0);
    });
    sub.querySelector('[data-back]').addEventListener('click', function (e) {
      e.preventDefault();
      // step back through history when we pushed #other ourselves
      if (history.state && history.state.other) history.back();
      else {
        history.replaceState(null, '', location.pathname + location.search);
        close(e.currentTarget, e.detail === 0);
      }
    });
    window.addEventListener('popstate', function () {
      if (location.hash === '#other') open(opener, false);
      else close(sub.querySelector('[data-back]'), document.activeElement && sub.contains(document.activeElement));
    });
  }

  /* ---------- keyboard ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (root.classList.contains('boot') || root.classList.contains('egg-busy')) return;
    var items = visible();
    var i = items.indexOf(document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        focusAt(i + 1);
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        focusAt(i < 0 ? items.length - 1 : i - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(items.length - 1);
        break;
      case 'Escape':
      case 'Backspace':
      case 'ArrowLeft':
      case 'h':
        if (!isOpen()) break;
        e.preventDefault();
        sub.querySelector('[data-back]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
        break;
      case 'ArrowRight':
      case 'l':
        if (document.activeElement !== opener) break;
        e.preventDefault();
        open(opener, true);
        break;
      default:
        // 1..n jumps straight to a numbered entry (not "back")
        var numbered = items.filter(function (it) { return !it.hasAttribute('data-back'); });
        var n = parseInt(e.key, 10);
        if (n >= 1 && n <= numbered.length) {
          e.preventDefault();
          numbered[n - 1].focus();
          activate(numbered[n - 1]);
        }
    }
  });

  Array.prototype.slice.call(document.querySelectorAll('.menu .item')).forEach(function (item) {
    // one highlighted row at a time: the mouse takes over from the keyboard
    item.addEventListener('pointerenter', function (e) {
      var cur = document.activeElement;
      if (e.pointerType === 'mouse' && cur !== item && cur && cur.classList && cur.classList.contains('item')) cur.blur();
    });
    if (!item.classList.contains('is-locked')) return;
    item.addEventListener('click', function () { deny(item); });
    item.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        deny(item);
      }
    });
    item.addEventListener('animationend', function (e) {
      if (e.animationName === 'denied') item.classList.remove('is-denied');
    });
  });
})();
