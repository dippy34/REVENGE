/* Kyrie: router, navigation and startup. */
(function () {
  const TITLES = { library: 'Library', progress: 'Progress', settings: 'Settings', help: 'Help', create: 'New deck' };
  const NAV_FOR = { home: 'home', intro: 'home', library: 'library', deck: 'library', create: 'new', progress: 'progress', settings: 'settings', help: 'help' };

  const setMenu = (open) => {
    document.body.classList.toggle('menu-open', open);
    R.$('[data-nav-toggle]').setAttribute('aria-expanded', String(open));
  };

  R.route = () => {
    const [path, qs] = location.hash.replace(/^#/, '').split('?');
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    let view = 'home';
    let m;
    if ((m = path.match(/^\/deck\/([\w-]+)\/(flash|learn|test|match|comet|blitz|print)$/))) [params.id, view] = [m[1], m[2]];
    else if ((m = path.match(/^\/deck\/([\w-]+)$/))) [params.id, view] = [m[1], 'deck'];
    else if ((m = path.match(/^\/(library|progress|settings|help|new|intro)$/))) view = m[1] === 'new' ? 'create' : m[1];
    // First visit: the intro instead of an empty home page.
    if (view === 'home' && !R.store.decks().length && !R.store.settings().introSeen) view = 'intro';

    R.onLeave?.();
    R.onLeave = null;
    R._ask?.destroy();
    R._ask = null;
    R.onFilesDropped = null;
    try {
      speechSynthesis.cancel();
    } catch (_) {}
    const root = R.$('#view');
    root.className = `view view-${view}`;
    document.body.dataset.view = view;
    (R.views[view] || R.views.home)(root, params);
    root.classList.add('enter');

    const deck = params.id && R.store.deck(params.id);
    document.title = deck ? `${deck.title} · Kyrie` : TITLES[view] ? `${TITLES[view]} · Kyrie` : 'Kyrie';
    const nav = NAV_FOR[view] || 'library';
    R.$$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
    setMenu(false);
  };

  document.addEventListener('DOMContentLoaded', () => {
    R.store.load();
    R.applyTheme();
    R.ai.check();
    R.bindGlobalDrop();
    R.$('[data-nav-toggle]').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
    // The bar gets its hairline once the page scrolls under it.
    const onScroll = () => document.body.classList.toggle('scrolled', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    window.addEventListener('hashchange', () => {
      R.route();
      window.scrollTo({ top: 0 });
    });
    R.route();
  });
})();
