/* Kyrie: games. Match, Comet Run (crash and you answer a question) and Lightning. */
(function () {
  const V = (R.views = R.views || {});
  const fmt = (s) => R.esc(s).replace(/_{3,}/g, '<span class="blank sm"></span>');

  // Favor cards the student is weakest on, but keep some variety.
  function pickCard(deck, avoid) {
    const weight = (c) => (R.srs.state(c) === 'mastered' ? 1 : c.s.lapses ? 4 : !c.s.seen ? 3 : 2);
    const pool = deck.cards.filter((c) => c !== avoid);
    const list = pool.length ? pool : deck.cards;
    let total = list.reduce((t, c) => t + weight(c), 0);
    let r = Math.random() * total;
    for (const c of list) if ((r -= weight(c)) <= 0) return c;
    return list[0];
  }

  function tooSmall(root, deck, need, name) {
    root.innerHTML = `${R.modeHeader(deck, name, 'grid')}<div class="done-card card pad">${R.icon('cards', 28)}<h2>Add a few more cards</h2><p class="muted">${name} needs at least ${need} cards in the deck.</p><a class="btn btn-primary" href="#/new?into=${deck.id}">Add material</a></div>`;
  }

  /* ================= MATCH ================= */

  V.match = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    if (deck.cards.length < 3) return tooSmall(root, deck, 3, 'Match');
    const pairs = Math.min(innerWidth < 640 ? 5 : 6, deck.cards.length);
    let timer = null;
    let t0 = 0;
    let penalty = 0;

    root.innerHTML = `${R.modeHeader(deck, 'Match', 'grid', `<div class="match-time">${R.icon('clock', 16)}<span data-time>0.0s</span></div>`)}<div class="match-wrap" data-stage></div>`;
    const stage = R.$('[data-stage]', root);

    function intro() {
      const best = R.store.best(`match:${deck.id}`);
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic orange">${R.icon('grid', 28)}</div>
        <h2>Match every pair</h2>
        <p class="muted">Tap a term, then its answer. Wrong matches add 1 second. ${best ? `Your best: <strong>${R.fmtTime(best)}</strong>` : 'Set your first record.'}</p>
        <button class="btn btn-primary btn-lg" data-go>${R.icon('play', 16)} Start</button></div>`;
      R.$('[data-go]', stage).addEventListener('click', play);
    }

    function play() {
      const cards = R.sample(deck.cards, pairs);
      const tiles = R.shuffle(cards.flatMap((c) => [{ id: c.id, text: c.front, side: 'f' }, { id: c.id, text: c.back, side: 'b' }]));
      stage.innerHTML = `<div class="match-grid cols-${tiles.length > 10 ? 4 : 'auto'}">${tiles
        .map((t, k) => `<button class="tile ${t.side}" data-k="${k}"><span>${R.esc(t.text.length > 140 ? t.text.slice(0, 137) + '…' : t.text).replace(/_{3,}/g, '______')}</span></button>`)
        .join('')}</div>`;
      let sel = null;
      let left = cards.length;
      penalty = 0;
      t0 = performance.now();
      clearInterval(timer);
      timer = setInterval(() => (R.$('[data-time]', root).textContent = R.fmtTime(performance.now() - t0 + penalty)), 100);
      stage.addEventListener('click', function onClick(e) {
        const b = e.target.closest('.tile');
        if (!b || b.classList.contains('gone')) return;
        const t = tiles[+b.dataset.k];
        if (!sel) {
          sel = { b, t };
          b.classList.add('sel');
          R.sound('tick');
          return;
        }
        if (sel.b === b) {
          b.classList.remove('sel');
          sel = null;
          return;
        }
        if (sel.t.id === t.id && sel.t.side !== t.side) {
          R.sound('good');
          const card = deck.cards.find((c) => c.id === t.id);
          R.srs.record(card, true);
          [sel.b, b].forEach((x) => x.classList.add('match-ok'));
          const pair = [sel.b, b];
          setTimeout(() => pair.forEach((x) => x.classList.add('gone')), 260);
          sel = null;
          if (--left === 0) {
            stage.removeEventListener('click', onClick);
            setTimeout(win, 400);
          }
        } else {
          R.sound('bad');
          penalty += 1000;
          const pair = [sel.b, b];
          pair.forEach((x) => x.classList.add('match-bad'));
          setTimeout(() => pair.forEach((x) => x.classList.remove('match-bad', 'sel')), 450);
          sel = null;
        }
      });
    }

    function win() {
      clearInterval(timer);
      const ms = performance.now() - t0 + penalty;
      R.store.upsert(deck);
      const record = R.store.setBest(`match:${deck.id}`, Math.round(ms), true);
      R.store.addHistory({ type: 'match', deck: deck.id, title: deck.title, detail: `Matched in ${R.fmtTime(ms)}` });
      R.confetti();
      R.sound('win');
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic orange">${R.icon('trophy', 30)}</div>
        <h2>${R.fmtTime(ms)}${record ? ' <span class="pill pill-hot">New record</span>' : ''}</h2>
        <p class="muted">${penalty ? `Includes ${penalty / 1000}s of penalties. ` : 'No mistakes! '}Best: ${R.fmtTime(R.store.best(`match:${deck.id}`))}</p>
        <div class="row gap center"><a class="btn btn-ghost" href="#/deck/${deck.id}">Done</a><button class="btn btn-primary" data-again>${R.icon('refresh', 16)} Play again</button></div></div>`;
      R.$('[data-again]', stage).addEventListener('click', play);
    }

    R.onLeave = () => clearInterval(timer);
    intro();
  };

  /* ================= COMET RUN ================= */

  V.comet = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    if (deck.cards.length < 2) return tooSmall(root, deck, 2, 'Comet Run');

    root.innerHTML = `${R.modeHeader(deck, 'Comet Run', 'rocket', `<button class="icon-btn" data-pause title="Pause (P)">${R.icon('pause', 18)}</button>`)}
      <div class="game-wrap">
        <div class="game" data-game>
          <canvas data-canvas></canvas>
          <div class="hud">
            <div class="hud-score"><span data-score>0</span><small>score</small></div>
            <div class="hud-mid" data-level></div>
            <div class="hud-hearts" data-hearts></div>
          </div>
          <div class="game-overlay" data-overlay></div>
        </div>
        <div class="kbd-hint hide-sm">Move with your mouse, <kbd>←</kbd><kbd>→</kbd> or <kbd>A</kbd><kbd>D</kbd> · Grab <span class="dot-star"></span> stars for points · Blue <span class="dot-orb"></span> orbs are bonus questions</div>
      </div>`;

    const canvas = R.$('[data-canvas]', root);
    const ctx = canvas.getContext('2d');
    const gameEl = R.$('[data-game]', root);
    const overlay = R.$('[data-overlay]', root);
    let W = 0;
    let H = 0;
    let raf = 0;
    let last = 0;
    let running = false;
    let paused = false;
    const keys = {};
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const bg = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), z: R.rand(0.2, 1) }));
    let g; // game state

    function resize() {
      const r = gameEl.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (g) g.ship.y = H - 60;
    }

    function reset() {
      g = {
        t: 0,
        score: 0,
        hearts: 3,
        ship: { x: W / 2, y: H - 60, tx: W / 2, vx: 0 },
        comets: [],
        stars: [],
        orbs: [],
        parts: [],
        spawn: 0,
        starSpawn: 1.2,
        orbSpawn: 14,
        shield: 0,
        flash: 0,
        right: 0,
        asked: 0,
        missed: new Map(),
        lastCard: null,
      };
      drawHud();
    }

    const level = () => 1 + Math.floor(g.t / 20);
    function drawHud() {
      R.$('[data-score]', root).textContent = Math.floor(g.score).toLocaleString();
      R.$('[data-level]', root).textContent = `Level ${level()}`;
      R.$('[data-hearts]', root).innerHTML = [0, 1, 2].map((k) => `<span class="${k < g.hearts ? 'on' : ''}">${R.icon('heart', 18)}</span>`).join('');
    }

    function spawnComet() {
      const lv = level();
      const r = R.rand(14, 30) * (W < 500 ? 0.8 : 1);
      g.comets.push({ x: R.rand(r, W - r), y: -r - 10, r, vy: R.rand(130, 200) + lv * 32, vx: R.rand(-30, 30), rot: R.rand(0, 6), vr: R.rand(-2, 2), seed: Math.random() });
    }

    function burst(x, y, color, n = 26, speed = 260) {
      if (reduced) n = Math.min(n, 8);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const s = Math.random() * speed;
        g.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: R.rand(0.4, 0.9), max: 0.9, color });
      }
    }

    function update(dt) {
      g.t += dt;
      g.score += dt * (10 + level() * 4);
      const s = g.ship;
      if (keys.left) s.tx -= 520 * dt;
      if (keys.right) s.tx += 520 * dt;
      s.tx = R.clamp(s.tx, 22, W - 22);
      const prevX = s.x;
      s.x += (s.tx - s.x) * Math.min(1, dt * 14);
      s.vx = (s.x - prevX) / Math.max(dt, 0.001);
      if (g.shield > 0) g.shield -= dt;
      if (g.flash > 0) g.flash -= dt;

      g.spawn -= dt;
      if (g.spawn <= 0) {
        spawnComet();
        g.spawn = Math.max(0.22, 0.95 - level() * 0.08) * R.rand(0.6, 1.2);
      }
      g.starSpawn -= dt;
      if (g.starSpawn <= 0) {
        g.stars.push({ x: R.rand(20, W - 20), y: -20, vy: R.rand(110, 160), spin: 0 });
        g.starSpawn = R.rand(1.4, 2.6);
      }
      g.orbSpawn -= dt;
      if (g.orbSpawn <= 0) {
        g.orbs.push({ x: R.rand(30, W - 30), y: -24, vy: 120, pulse: 0 });
        g.orbSpawn = R.rand(16, 24);
      }

      for (const c of g.comets) {
        c.y += c.vy * dt;
        c.x += c.vx * dt;
        c.rot += c.vr * dt;
      }
      g.comets = g.comets.filter((c) => c.y < H + 60 && c.x > -60 && c.x < W + 60);
      for (const st of g.stars) {
        st.y += st.vy * dt;
        st.spin += dt * 3;
      }
      for (const o of g.orbs) {
        o.y += o.vy * dt;
        o.pulse += dt * 4;
      }
      for (const p of g.parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.life -= dt;
      }
      g.parts = g.parts.filter((p) => p.life > 0);

      // Collisions (ship hitbox is a circle a bit smaller than the drawing, to feel fair).
      const hit = (x, y, r) => Math.hypot(x - s.x, y - s.y) < r + 14;
      g.stars = g.stars.filter((st) => {
        if (hit(st.x, st.y, 12)) {
          g.score += 50;
          burst(st.x, st.y, '#fcd34d', 12, 140);
          R.sound('tick');
          return false;
        }
        return st.y < H + 30;
      });
      for (const o of g.orbs) {
        if (!o.taken && hit(o.x, o.y, 14)) {
          o.taken = true;
          burst(o.x, o.y, '#60a5fa', 18, 180);
          return question('bonus');
        }
      }
      g.orbs = g.orbs.filter((o) => !o.taken && o.y < H + 30);
      if (g.shield <= 0) {
        for (const c of g.comets) {
          if (hit(c.x, c.y, c.r * 0.82)) {
            burst(s.x, s.y, '#fb923c', 40, 320);
            burst(c.x, c.y, '#94a3b8', 20, 200);
            g.comets = g.comets.filter((x) => x !== c);
            g.flash = 0.25;
            R.sound('boom');
            return question('crash');
          }
        }
      }
    }

    function drawComet(c) {
      ctx.save();
      ctx.translate(c.x, c.y);
      // tail
      const tail = ctx.createLinearGradient(0, 0, -c.vx * 0.25, -c.vy * 0.35);
      tail.addColorStop(0, 'rgba(251,146,60,0.55)');
      tail.addColorStop(1, 'rgba(251,146,60,0)');
      ctx.fillStyle = tail;
      ctx.beginPath();
      ctx.moveTo(-c.r * 0.8, 0);
      ctx.lineTo(-c.vx * 0.25, -c.vy * 0.35);
      ctx.lineTo(c.r * 0.8, 0);
      ctx.fill();
      ctx.rotate(c.rot);
      const body = ctx.createRadialGradient(-c.r * 0.3, -c.r * 0.3, c.r * 0.1, 0, 0, c.r);
      body.addColorStop(0, '#cbd5e1');
      body.addColorStop(1, '#475569');
      ctx.fillStyle = body;
      ctx.beginPath();
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        const rr = c.r * (0.82 + 0.18 * Math.sin(k * 2.3 + c.seed * 10));
        k ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30,41,59,0.45)';
      ctx.beginPath();
      ctx.arc(c.r * 0.25, c.r * 0.1, c.r * 0.22, 0, 7);
      ctx.arc(-c.r * 0.3, c.r * 0.35, c.r * 0.12, 0, 7);
      ctx.fill();
      ctx.restore();
    }

    function drawStar(x, y, r, spin) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(spin);
      ctx.fillStyle = '#fcd34d';
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = k % 2 ? r * 0.45 : r;
        k ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function draw() {
      const grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, '#08122b');
      grd.addColorStop(1, '#122650');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
      for (const b of bg) {
        const y = (b.y * H + (g.t * 40 * b.z)) % H;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + b.z * 0.6})`;
        ctx.fillRect(b.x * W, y, b.z * 2, b.z * 2);
      }
      for (const st of g.stars) drawStar(st.x, st.y, 11, st.spin);
      for (const o of g.orbs) {
        const pr = 13 + Math.sin(o.pulse) * 2;
        ctx.save();
        ctx.shadowColor = '#60a5fa';
        ctx.shadowBlur = 22;
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(o.x, o.y, pr, 0, 7);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.font = '700 15px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', o.x, o.y + 1);
        ctx.restore();
      }
      for (const c of g.comets) drawComet(c);

      // ship
      const s = g.ship;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(R.clamp(s.vx / 2400, -0.35, 0.35));
      const flame = 10 + Math.random() * 8;
      const fl = ctx.createLinearGradient(0, 12, 0, 18 + flame);
      fl.addColorStop(0, '#fde68a');
      fl.addColorStop(1, 'rgba(249,115,22,0)');
      ctx.fillStyle = fl;
      ctx.beginPath();
      ctx.moveTo(-7, 12);
      ctx.lineTo(0, 16 + flame);
      ctx.lineTo(7, 12);
      ctx.fill();
      ctx.shadowColor = '#60a5fa';
      ctx.shadowBlur = 18;
      const hull = ctx.createLinearGradient(0, -22, 0, 16);
      hull.addColorStop(0, '#ffffff');
      hull.addColorStop(1, '#bfdbfe');
      ctx.fillStyle = hull;
      ctx.beginPath();
      ctx.moveTo(0, -22);
      ctx.quadraticCurveTo(10, -6, 16, 14);
      ctx.lineTo(0, 8);
      ctx.lineTo(-16, 14);
      ctx.quadraticCurveTo(-10, -6, 0, -22);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#2563eb';
      ctx.beginPath();
      ctx.ellipse(0, -6, 4, 6, 0, 0, 7);
      ctx.fill();
      if (g.shield > 0) {
        ctx.strokeStyle = `rgba(96,165,250,${0.4 + 0.4 * Math.sin(g.t * 16)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, -2, 30, 0, 7);
        ctx.stroke();
      }
      ctx.restore();

      for (const p of g.parts) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
      if (g.flash > 0) {
        ctx.fillStyle = `rgba(239,68,68,${g.flash})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function loop(t) {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000 || 0);
      last = t;
      if (!running || paused) {
        if (g.flash > 0) g.flash -= dt;
        return draw();
      }
      update(dt);
      draw();
      drawHud();
    }

    // The core idea: a crash (or a bonus orb) stops the game and you have to answer.
    function question(why) {
      running = false;
      const card = pickCard(deck, g.lastCard);
      g.lastCard = card;
      g.asked++;
      // Mostly multiple choice: the game should stay fast. Lists are never typed here.
      const type = deck.cards.length < 3 ? 'written' : card.kind === 'list' || Math.random() < 0.8 ? 'mc' : 'written';
      const q = R.quiz.make(card, deck, type);
      overlay.innerHTML = `<div class="ov-panel ${why}">
        <div class="ov-head">${
          why === 'crash'
            ? `${R.icon('zap', 18)} <strong>You crashed!</strong> <span>Answer right to keep your heart.</span>`
            : `${R.icon('sparkles', 18)} <strong>Bonus question</strong> <span>Right answer: +250 and a shield.</span>`
        }</div>
        <div data-q></div></div>`;
      overlay.classList.add('show');
      R.ask(q, R.$('[data-q]', overlay), {
        showSpeak: false,
        onDone: (ok) => {
          R.srs.record(card, ok);
          R.store.upsert(deck);
          if (ok) g.right++;
          else g.missed.set(card.id, card);
          if (why === 'crash') {
            if (!ok) g.hearts--;
            g.shield = 2.6;
            g.comets = g.comets.filter((c) => c.y < g.ship.y - 180);
          } else if (ok) {
            g.score += 250;
            g.shield = 5;
          }
          overlay.classList.remove('show');
          overlay.innerHTML = '';
          drawHud();
          if (g.hearts <= 0) return over();
          countdown();
        },
      });
    }

    function countdown() {
      let n = 3;
      overlay.innerHTML = `<div class="ov-count">${n}</div>`;
      overlay.classList.add('show', 'clear');
      const tick = () => {
        n--;
        if (n <= 0) {
          overlay.classList.remove('show', 'clear');
          overlay.innerHTML = '';
          running = true;
          return;
        }
        overlay.innerHTML = `<div class="ov-count">${n}</div>`;
        R.sound('tick');
        g.cd = setTimeout(tick, 450);
      };
      g.cd = setTimeout(tick, 450);
    }

    function start() {
      reset();
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      countdown();
    }

    function intro() {
      reset();
      const best = R.store.best(`comet:${deck.id}`);
      overlay.innerHTML = `<div class="ov-panel ov-center">
        <div class="ov-title">${R.icon('rocket', 26)}<h2>Comet Run</h2></div>
        <p>Dodge the comets and grab the stars. Crash, and you'll have to answer a question from <strong>${R.esc(deck.title)}</strong>. Get it right to keep your heart. Three wrong answers and the run is over.</p>
        ${best ? `<p class="muted">Best score: <strong>${best.toLocaleString()}</strong></p>` : ''}
        <button class="btn btn-primary btn-lg" data-start>${R.icon('play', 16)} Launch</button></div>`;
      overlay.classList.add('show');
      R.$('[data-start]', overlay).addEventListener('click', start);
    }

    function over() {
      running = false;
      const score = Math.floor(g.score);
      const record = R.store.setBest(`comet:${deck.id}`, score);
      R.store.addHistory({ type: 'comet', deck: deck.id, title: deck.title, score, detail: `${score.toLocaleString()} points, ${g.right} of ${g.asked} answered right` });
      R.sound(record ? 'win' : 'bad');
      if (record) R.confetti();
      const missed = [...g.missed.values()];
      overlay.innerHTML = `<div class="ov-panel ov-center">
        <div class="ov-title">${R.icon('trophy', 26)}<h2>${score.toLocaleString()}${record ? ' <span class="pill pill-hot">New best</span>' : ''}</h2></div>
        <p class="muted">You answered ${g.right} of ${g.asked} questions correctly and reached level ${level()}.</p>
        ${missed.length ? `<div class="ov-missed"><div class="q-label">Review these</div>${missed.slice(0, 5).map((c) => `<div class="ov-miss"><span>${fmt(c.front)}</span><strong>${R.esc(c.back)}</strong></div>`).join('')}</div>` : ''}
        <div class="row gap center wrap"><a class="btn btn-ghost" href="#/deck/${deck.id}">Done</a><button class="btn btn-primary btn-lg" data-start>${R.icon('refresh', 16)} Fly again</button></div></div>`;
      overlay.classList.add('show');
      R.$('[data-start]', overlay).addEventListener('click', start);
    }

    function togglePause(force) {
      if (!running && !paused) return;
      paused = force ?? !paused;
      if (paused) {
        overlay.innerHTML = `<div class="ov-panel ov-center"><h2>Paused</h2><button class="btn btn-primary btn-lg" data-resume>${R.icon('play', 16)} Resume</button></div>`;
        overlay.classList.add('show');
        R.$('[data-resume]', overlay).addEventListener('click', () => togglePause(false));
      } else {
        overlay.classList.remove('show');
        overlay.innerHTML = '';
      }
    }

    const move = (clientX) => {
      const r = canvas.getBoundingClientRect();
      if (g) g.ship.tx = clientX - r.left;
    };
    canvas.addEventListener('mousemove', (e) => move(e.clientX));
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      move(e.touches[0].clientX);
    }, { passive: false });
    canvas.addEventListener('touchstart', (e) => move(e.touches[0].clientX), { passive: true });
    const kd = (e) => {
      if (e.target.closest('input,textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') (keys.left = true), e.preventDefault();
      if (k === 'arrowright' || k === 'd') (keys.right = true), e.preventDefault();
      if (k === 'p' || k === 'escape') togglePause();
    };
    const ku = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') keys.left = false;
      if (k === 'arrowright' || k === 'd') keys.right = false;
    };
    const vis = () => document.hidden && running && togglePause(true);
    const onModal = () => running && togglePause(true);
    document.addEventListener('kyrie:modal', onModal);
    document.addEventListener('keydown', kd);
    document.addEventListener('keyup', ku);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('resize', resize);
    R.$('[data-pause]', root).addEventListener('click', () => togglePause());
    R.onLeave = () => {
      cancelAnimationFrame(raf);
      clearTimeout(g?.cd);
      document.removeEventListener('keydown', kd);
      document.removeEventListener('keyup', ku);
      document.removeEventListener('visibilitychange', vis);
      document.removeEventListener('kyrie:modal', onModal);
      window.removeEventListener('resize', resize);
    };

    resize();
    intro();
    raf = requestAnimationFrame(loop);
  };

  /* ================= LIGHTNING ================= */

  V.blitz = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    if (deck.cards.length < 3) return tooSmall(root, deck, 3, 'Lightning');
    const LEN = 60;
    let timer = null;
    let st;

    root.innerHTML = `${R.modeHeader(deck, 'Lightning', 'zap')}<div class="blitz-wrap" data-stage></div>`;
    const stage = R.$('[data-stage]', root);

    function intro() {
      const best = R.store.best(`blitz:${deck.id}`);
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic yellow">${R.icon('zap', 28)}</div>
        <h2>60 seconds. True or false.</h2>
        <p class="muted">Every right answer in a row raises your multiplier. A wrong answer costs 3 seconds. ${best ? `Best: <strong>${best}</strong>` : ''}</p>
        <button class="btn btn-primary btn-lg" data-go>${R.icon('play', 16)} Go</button>
        <div class="kbd-hint hide-sm"><kbd>←</kbd> or <kbd>F</kbd> false · <kbd>→</kbd> or <kbd>T</kbd> true</div></div>`;
      R.$('[data-go]', stage).addEventListener('click', play);
    }

    function play() {
      st = { left: LEN, score: 0, streak: 0, best: 0, right: 0, total: 0, q: null, lock: false, end: performance.now() + LEN * 1000 };
      stage.innerHTML = `
        <div class="blitz">
          <div class="blitz-top">
            <div class="blitz-time"><div class="bt-bar"><i data-tbar></i></div><span data-t>60</span></div>
            <div class="blitz-score"><span data-s>0</span><small data-mult>x1</small></div>
          </div>
          <div class="blitz-card card" data-card></div>
          <div class="blitz-btns">
            <button class="blitz-btn no" data-v="0">${R.icon('x', 22)} False</button>
            <button class="blitz-btn yes" data-v="1">${R.icon('check', 22)} True</button>
          </div>
        </div>`;
      R.$$('[data-v]', stage).forEach((b) => b.addEventListener('click', () => answer(b.dataset.v === '1')));
      next();
      clearInterval(timer);
      timer = setInterval(tick, 100);
    }

    function tick() {
      st.left = Math.max(0, (st.end - performance.now()) / 1000);
      R.$('[data-t]', stage).textContent = Math.ceil(st.left);
      R.$('[data-tbar]', stage).style.width = `${(st.left / LEN) * 100}%`;
      R.$('.blitz-time', stage).classList.toggle('low', st.left < 10);
      if (st.left <= 0) finish();
    }

    function next() {
      const card = pickCard(deck, st.q?.card);
      st.q = R.quiz.make(card, deck, 'tf');
      st.lock = false;
      const el = R.$('[data-card]', stage);
      el.className = 'blitz-card card';
      el.innerHTML = `<div class="q-label">${R.esc(st.q.label)}</div><div class="bc-prompt">${fmt(st.q.prompt)}</div><div class="bc-sep">${R.icon('right', 16)}</div><div class="bc-shown">${fmt(st.q.shown)}</div>`;
    }

    function answer(v) {
      if (!st || st.lock || st.left <= 0) return;
      st.lock = true;
      st.total++;
      const ok = v === st.q.truth;
      R.srs.record(st.q.card, ok);
      const el = R.$('[data-card]', stage);
      if (ok) {
        st.right++;
        st.streak++;
        st.best = Math.max(st.best, st.streak);
        const mult = 1 + Math.min(4, Math.floor(st.streak / 3));
        st.score += 10 * mult;
        R.sound('good');
        el.classList.add('flash-ok');
      } else {
        st.streak = 0;
        st.end -= 3000;
        R.sound('bad');
        el.classList.add('flash-bad');
        el.insertAdjacentHTML('beforeend', `<div class="bc-correct">${st.q.truth ? 'It was true' : `Actually: ${fmt(st.q.answer)}`}</div>`);
      }
      R.$('[data-s]', stage).textContent = st.score;
      R.$('[data-mult]', stage).textContent = `x${1 + Math.min(4, Math.floor(st.streak / 3))}`;
      setTimeout(() => st.left > 0 && next(), ok ? 280 : 1100);
    }

    function finish() {
      clearInterval(timer);
      R.store.upsert(deck);
      const record = R.store.setBest(`blitz:${deck.id}`, st.score);
      R.store.addHistory({ type: 'blitz', deck: deck.id, title: deck.title, score: st.score, detail: `${st.score} points, ${st.right} of ${st.total} right` });
      if (record && st.score) R.confetti();
      R.sound('win');
      const acc = st.total ? Math.round((st.right / st.total) * 100) : 0;
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic yellow">${R.icon('zap', 28)}</div>
        <h2>${st.score} points${record && st.score ? ' <span class="pill pill-hot">New best</span>' : ''}</h2>
        <div class="tally"><span class="good">${st.right} right</span><span class="again">${st.total - st.right} wrong</span><span class="easy">${acc}% accuracy</span><span class="hard">best streak ${st.best}</span></div>
        <div class="row gap center"><a class="btn btn-ghost" href="#/deck/${deck.id}">Done</a><button class="btn btn-primary" data-again>${R.icon('refresh', 16)} Again</button></div></div>`;
      R.$('[data-again]', stage).addEventListener('click', play);
      st = null;
    }

    const kd = (e) => {
      if (!st) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 't') answer(true);
      if (k === 'arrowleft' || k === 'f') answer(false);
    };
    document.addEventListener('keydown', kd);
    R.onLeave = () => {
      clearInterval(timer);
      document.removeEventListener('keydown', kd);
    };
    intro();
  };
})();
