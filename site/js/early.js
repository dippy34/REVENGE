/* early.js: loaded blocking in <head> so it runs before first paint.
   Marks JS as available and decides whether the boot screen plays,
   so the menu never flashes underneath it. Keep this file tiny. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  if (root.getAttribute('data-page') !== 'menu') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Boot plays on the first visit only. If storage is blocked we cannot
  // remember the visit, so we skip it rather than replay it every load.
  var seen = true;
  try { seen = localStorage.getItem('boot') === '1'; } catch (e) { /* blocked */ }
  if (!seen) root.classList.add('boot');
})();
