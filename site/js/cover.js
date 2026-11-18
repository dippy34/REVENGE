/* cover.js: the cover page (cover/), where early.js sends the first page a
   tab opens on curiovale.com. The address bar goes straight back to that
   page, the picture stays for ten seconds, then the page loads for real
   (early.js lets it through: this tab has had its cover). Loaded blocking
   in <head>, so the address is back before anything paints. */
(function () {
  'use strict';

  var to = '/';
  try {
    to = sessionStorage.getItem('cover.to') || '/';
    sessionStorage.removeItem('cover.to');
  } catch (e) { /* storage blocked: the menu */ }
  // only a path on this site
  if (to.charAt(0) !== '/' || to.charAt(1) === '/' || to.charAt(1) === '\\') to = '/';

  var back = false;
  try {
    history.replaceState(null, '', to);
    back = true;
  } catch (e) { /* the address stays cover/ */ }

  setTimeout(function () {
    // a reload, not a replace: the same address with a #hash would not load again
    if (back) location.reload();
    else location.replace(to);
  }, 10000);
})();
