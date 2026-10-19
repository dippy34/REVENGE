/* menu.js: keyboard control and locked entries on the index.
   Without JS the live entries are plain links and still work. */
(function () {
  'use strict';

  var items = Array.prototype.slice.call(document.querySelectorAll('.menu .item'));
  if (!items.length) return;

  function focusAt(i) {
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

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.documentElement.classList.contains('boot')) return;
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
      default:
        // 1..n jumps straight to an entry
        var n = parseInt(e.key, 10);
        if (n >= 1 && n <= items.length) {
          e.preventDefault();
          items[n - 1].focus();
          activate(items[n - 1]);
        }
    }
  });

  items.forEach(function (item) {
    if (!item.classList.contains('is-locked')) return;
    item.addEventListener('click', function () { deny(item); });
    item.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        deny(item);
      }
    });
    item.addEventListener('animationend', function () { item.classList.remove('is-denied'); });
  });
})();
