/* Kyrie: depth. Cards that lean toward the pointer, the intro's hero that stands
   up as you scroll, and numbers that count up when they come into view. All of it
   is off with reduced motion, and the tilt only runs for a mouse or trackpad. */
(function () {
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');

  /* ---------- tilt: any element with data-tilt (value = degrees at the edge) ---------- */

  let cur = null;
  let rect = null;
  let last = null;
  let raf = 0;

  function rest(el) {
    el.classList.remove('tilting');
    for (const k of ['--rx', '--ry', '--mx', '--my']) el.style.removeProperty(k);
  }
  function lean() {
    raf = 0;
    if (!cur || !last) return;
    rect ||= cur.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (last.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (last.clientY - rect.top) / rect.height));
    const max = Number(cur.dataset.tilt) || 6;
    cur.style.setProperty('--rx', `${((0.5 - y) * max).toFixed(2)}deg`);
    cur.style.setProperty('--ry', `${((x - 0.5) * max).toFixed(2)}deg`);
    cur.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    cur.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  }
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' || calm.matches || !fine.matches) return;
      const el = e.target.closest ? e.target.closest('[data-tilt]') : null;
      if (el !== cur) {
        if (cur) rest(cur);
        cur = el;
        rect = null; // measured flat, before it leans
        if (el) el.classList.add('tilting');
      }
      if (!cur) return;
      last = e;
      raf ||= requestAnimationFrame(lean);
    },
    { passive: true }
  );
  const drop = () => {
    if (cur) rest(cur);
    cur = null;
  };
  document.addEventListener('mouseout', (e) => !e.relatedTarget && drop());
  window.addEventListener('scroll', () => (rect = null), { passive: true });
  window.addEventListener('hashchange', drop);

  /* ---------- the intro's hero: lies back, stands up as you scroll ---------- */

  R.hero3d = (stage, area) => {
    if (!stage) return () => {};
    if (calm.matches) {
      stage.style.setProperty('--hp', '1');
      return () => {};
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = stage.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.9)));
      stage.style.setProperty('--hp', (1 - (1 - p) * (1 - p)).toFixed(3)); // ease out
    };
    const onScroll = () => (frame ||= requestAnimationFrame(measure));
    const onMove = (e) => {
      if (e.pointerType !== 'mouse' || !fine.matches) return;
      const r = area.getBoundingClientRect();
      stage.style.setProperty('--px', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
      stage.style.setProperty('--py', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
    };
    const onOut = () => {
      stage.style.setProperty('--px', '0');
      stage.style.setProperty('--py', '0');
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    area.addEventListener('pointermove', onMove);
    area.addEventListener('pointerleave', onOut);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  };

  /* ---------- numbers that count up: data-count="94" ---------- */

  R.countUp = (root) => {
    const els = R.$$('[data-count]', root);
    const run = (el) => {
      const to = Number(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      if (calm.matches) return (el.textContent = to + suffix);
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 1400);
        el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + suffix;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (!('IntersectionObserver' in window)) return els.forEach(run), () => {};
    const io = new IntersectionObserver((entries) => entries.forEach((en) => en.isIntersecting && (run(en.target), io.unobserve(en.target))), { threshold: 0.6 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  };

  /* ---------- a fanned stack of cards, for empty states and the intro ---------- */

  R.deck3d = (front = ['Term', 'Mitochondria'], cls = '') =>
    `<div class="deck3d ${cls}" aria-hidden="true"><div class="deck3d-in">
      <div class="d3 d3-a"></div><div class="d3 d3-b"></div>
      <div class="d3 d3-c"><span>${R.esc(front[0])}</span><b>${R.esc(front[1])}</b><em>Tap to flip</em></div>
    </div></div>`;
})();
