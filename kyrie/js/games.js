/* Kyrie: games. Match, Comet Run (crash and you answer a question; levels, power-ups,
   star chains) and Lightning. */
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

  // Every level (15 seconds) is a new sector of space with its own sky and an event.
  // Ice comets are there from the start; levels 2 and 3 each add a new kind.
  const SECTORS = [
    ['#08122b', '#122650', '56,130,246'],
    ['#04161c', '#0b3340', '45,212,191'],
    ['#170d08', '#3a1d0f', '251,146,60'],
    ['#06140f', '#0f3326', '74,222,128'],
    ['#0b0f1f', '#232c47', '148,163,184'],
  ];
  const KINDS = {
    rock: { from: 1, w: 6, body: ['#cbd5e1', '#475569'], tail: '251,146,60' },
    ice: { from: 1, w: 2.2, body: ['#ecfeff', '#3b82a0'], tail: '125,211,252' },
    streak: { from: 2, w: 1.6, body: ['#fff7ed', '#ea580c'], tail: '253,186,116', name: 'streaks, watch the top for the warning' },
    boulder: { from: 3, w: 1.1, body: ['#a8a29e', '#292524'], tail: '168,162,158', name: 'boulders, the blaster needs three hits' },
  };
  const EVENTS = [
    ['starfall', 'Star shower', 'grab as many as you can'],
    ['belt', 'Asteroid belt', 'find the gap'],
    ['swarm', 'Meteor swarm', 'small and fast'],
  ];
  const POWERS = {
    magnet: { label: 'Magnet', color: '#ff5a5f', time: 8 },
    blaster: { label: 'Blaster', color: '#34d399', time: 6 },
    slow: { label: 'Slow motion', color: '#38bdf8', time: 5 },
  };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => `rgb(${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * k)).join(',')})`;

  V.comet = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    if (deck.cards.length < 2) return tooSmall(root, deck, 2, 'Comet Run');

    root.innerHTML = `${R.modeHeader(deck, 'Comet Run', 'rocket', `<button class="icon-btn" data-pause title="Pause (P)">${R.icon('pause', 18)}</button>`)}
      <div class="game-wrap">
        <div class="game" data-game>
          <canvas data-canvas></canvas>
          <div class="hud">
            <div class="hud-score"><span data-score>0</span><small data-combo>score</small></div>
            <div class="hud-mid" data-level></div>
            <div class="hud-hearts" data-hearts></div>
          </div>
          <div class="game-overlay" data-overlay></div>
        </div>
        <div class="kbd-hint hide-sm">Move with your mouse, <kbd>←</kbd><kbd>→</kbd> or <kbd>A</kbd><kbd>D</kbd> · Chain <span class="dot-star"></span> stars for a multiplier · Capsules are power-ups · Blue <span class="dot-orb"></span> orbs are bonus questions</div>
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
    let hudKey = '';
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
        lv: 1,
        score: 0,
        hearts: 3,
        ship: { x: W / 2, y: H - 60, tx: W / 2, vx: 0 },
        comets: [],
        stars: [],
        orbs: [],
        caps: [],
        shots: [],
        parts: [],
        pops: [],
        spawn: 0,
        starSpawn: 1.2,
        orbSpawn: 9,
        capSpawn: 3,
        warm: false,
        fire: 0,
        pw: { magnet: 0, blaster: 0, slow: 0 },
        shield: 0,
        flash: 0,
        shake: 0,
        sector: 0,
        prevSector: 0,
        skyFade: 1,
        ev: null,
        banner: null,
        combo: 0,
        bestCombo: 0,
        closes: 0,
        blasted: 0,
        right: 0,
        asked: 0,
        qStreak: 0,
        missed: new Map(),
        lastCard: null,
      };
      hudKey = '';
      drawHud();
    }

    const level = () => 1 + Math.floor(g.t / 15);
    const mult = () => Math.min(5, 1 + Math.floor(g.combo / 4));

    function drawHud() {
      R.$('[data-score]', root).textContent = Math.floor(g.score).toLocaleString();
      const m = mult();
      const key = `${level()}|${g.hearts}|${m}|${g.combo}`;
      if (key === hudKey) return;
      hudKey = key;
      R.$('[data-level]', root).textContent = `Level ${level()}`;
      const combo = R.$('[data-combo]', root);
      combo.textContent = m > 1 ? `×${m} combo` : g.combo > 1 ? `${g.combo} in a row` : 'score';
      combo.classList.toggle('hot', m > 1);
      R.$('[data-hearts]', root).innerHTML = [0, 1, 2].map((k) => `<span class="${k < g.hearts ? 'on' : ''}">${R.icon('heart', 18)}</span>`).join('');
    }

    function pop(x, y, text, color = '#fff', big = false) {
      g.pops.push({ x, y, text, color, big, life: big ? 1.6 : 1.1 });
    }

    function pickKind() {
      const lv = level();
      const list = Object.entries(KINDS).filter(([, k]) => k.from <= lv);
      let r = Math.random() * list.reduce((t, [, k]) => t + k.w, 0);
      for (const [name, k] of list) if ((r -= k.w) <= 0) return name;
      return 'rock';
    }

    function spawnComet(kind, opts = {}) {
      const lv = level();
      const k = W < 500 ? 0.8 : 1;
      const c = { kind, rot: R.rand(0, 6), vr: R.rand(-2, 2), seed: Math.random(), hp: 1, vx: R.rand(-30, 30) };
      if (kind === 'boulder') Object.assign(c, { r: R.rand(40, 52) * k, vy: R.rand(80, 110) + lv * 10, hp: 3, vx: R.rand(-12, 12), vr: R.rand(-0.6, 0.6) });
      else if (kind === 'streak') Object.assign(c, { r: R.rand(9, 12) * k, vy: 460 + lv * 26, vx: 0, warn: 0.85 });
      else if (kind === 'ice') Object.assign(c, { r: R.rand(14, 22) * k, vy: R.rand(110, 150) + lv * 22, vx: 0, f: R.rand(1.6, 2.4), ph: R.rand(0, 6) });
      else Object.assign(c, { r: R.rand(14, 30) * k, vy: R.rand(130, 200) + lv * 32 });
      if (kind === 'ice') c.zig = Math.max(0, Math.min(R.rand(50, 100), W / 2 - c.r - 10));
      const margin = c.r + (c.zig || 0);
      c.x = c.bx = R.rand(margin, Math.max(margin, W - margin));
      c.y = -c.r - 10;
      Object.assign(c, opts);
      g.comets.push(c);
      return c;
    }

    // A wall of rocks with one gap in it.
    function belt() {
      const gap = Math.max(130, W * 0.2);
      const gx = R.rand(gap / 2 + 12, W - gap / 2 - 12);
      const r = W < 500 ? 13 : 16;
      for (let x = r; x < W; x += r * 2.3) {
        if (Math.abs(x - gx) > gap / 2) spawnComet('rock', { x, bx: x, r, vy: 150 + level() * 12, vx: 0, vr: R.rand(-1, 1) });
      }
    }

    function levelUp(lv) {
      g.lv = lv;
      g.prevSector = g.sector;
      g.sector = (lv - 1) % SECTORS.length;
      g.skyFade = 0;
      const ev = EVENTS[(lv - 1) % EVENTS.length]; // level 1 already had a star shower
      g.ev = { kind: ev[0], t: ev[0] === 'belt' ? 4.4 : ev[0] === 'starfall' ? 6 : 7, rows: 2, next: 0.6 };
      const unlock = Object.values(KINDS).find((k) => k.from === lv);
      g.banner = { title: `Level ${lv}`, sub: `${ev[1]}: ${ev[2]}`, extra: unlock ? `New: ${unlock.name}` : '', t: 3.2 };
      R.sound('good');
    }

    function burst(x, y, color, n = 26, speed = 260) {
      if (reduced) n = Math.min(n, 8);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const s = Math.random() * speed;
        g.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: R.rand(0.4, 0.9), max: 0.9, color });
      }
    }

    function smash(c, pts, label) {
      g.comets = g.comets.filter((x) => x !== c);
      burst(c.x, c.y, KINDS[c.kind].body[0], c.kind === 'boulder' ? 34 : 18, c.kind === 'boulder' ? 280 : 200);
      g.score += pts;
      pop(c.x, c.y, label || `+${pts}`, '#e2e8f0');
    }

    function update(dt) {
      const lv = level();
      if (lv !== g.lv) levelUp(lv);
      const wdt = g.pw.slow > 0 ? dt * 0.45 : dt; // slow motion slows the world, not you
      g.t += dt;
      g.score += dt * (10 + lv * 4);
      const s = g.ship;
      if (keys.left) s.tx -= 520 * dt;
      if (keys.right) s.tx += 520 * dt;
      s.tx = R.clamp(s.tx, 22, W - 22);
      const prevX = s.x;
      s.x += (s.tx - s.x) * Math.min(1, dt * 14);
      s.vx = (s.x - prevX) / Math.max(dt, 0.001);
      for (const k of ['shield', 'flash', 'shake']) if (g[k] > 0) g[k] -= dt;
      for (const k in g.pw) if (g.pw[k] > 0) g.pw[k] -= dt;
      if (g.skyFade < 1) g.skyFade = Math.min(1, g.skyFade + dt / 2);
      if (g.banner && (g.banner.t -= dt) <= 0) g.banner = null;
      if (!g.warm && g.t > 6) {
        g.warm = true;
        g.ev = { kind: 'starfall', t: 4 };
        pop(W / 2, H * 0.4, 'Star shower!', '#fcd34d', true);
      }

      // the level's event
      const ev = g.ev;
      if (ev) {
        ev.t -= wdt;
        if (ev.kind === 'belt' && ev.rows > 0 && (ev.next -= wdt) <= 0) {
          belt();
          ev.rows--;
          ev.next = 1.9;
        }
        if (ev.t <= 0) g.ev = null;
      }
      const evKind = g.ev?.kind;

      g.spawn -= wdt;
      if (g.spawn <= 0 && evKind !== 'belt') {
        const swarm = evKind === 'swarm';
        const c = spawnComet(swarm ? 'rock' : pickKind());
        if (swarm) (c.r *= 0.6), (c.vy *= 1.15);
        g.spawn = Math.max(0.22, 0.95 - lv * 0.08) * R.rand(0.6, 1.2) * (swarm ? 0.38 : 1);
      }
      g.starSpawn -= wdt;
      if (g.starSpawn <= 0) {
        g.stars.push({ x: R.rand(20, W - 20), y: -20, vy: R.rand(110, 160), spin: 0 });
        g.starSpawn = evKind === 'starfall' ? 0.17 : R.rand(1.4, 2.6);
      }
      g.orbSpawn -= wdt;
      if (g.orbSpawn <= 0) {
        g.orbs.push({ x: R.rand(30, W - 30), y: -24, vy: 120, pulse: 0 });
        g.orbSpawn = R.rand(16, 24);
      }
      g.capSpawn -= wdt;
      if (g.capSpawn <= 0) {
        const kinds = Object.keys(POWERS).filter((k) => g.pw[k] <= 0);
        g.caps.push({ x: R.rand(30, W - 30), y: -24, vy: 115, bob: 0, kind: R.shuffle(kinds.length ? kinds : Object.keys(POWERS))[0] });
        g.capSpawn = R.rand(11, 16);
      }

      for (const c of g.comets) {
        if (c.warn > 0) {
          c.warn -= wdt;
          continue;
        }
        c.y += c.vy * wdt;
        if (c.zig) {
          c.ph += c.f * wdt;
          c.x = c.bx + Math.sin(c.ph) * c.zig;
        } else c.x += c.vx * wdt;
        c.rot += c.vr * wdt;
      }
      g.comets = g.comets.filter((c) => c.y < H + 70 && c.x > -70 && c.x < W + 70);
      const pull = g.pw.magnet > 0;
      for (const st of g.stars) {
        st.y += st.vy * wdt;
        st.spin += dt * 3;
        if (pull && Math.hypot(st.x - s.x, st.y - s.y) < 280) {
          st.x += (s.x - st.x) * Math.min(1, dt * 5);
          st.y += (s.y - st.y) * Math.min(1, dt * 5);
        }
      }
      for (const o of g.orbs) {
        o.y += o.vy * wdt;
        o.pulse += dt * 4;
      }
      for (const c of g.caps) {
        c.y += c.vy * wdt;
        c.bob += dt * 3;
      }
      for (const p of g.parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.life -= dt;
      }
      g.parts = g.parts.filter((p) => p.life > 0);
      for (const p of g.pops) {
        p.y -= dt * (p.big ? 30 : 46);
        p.life -= dt;
      }
      g.pops = g.pops.filter((p) => p.life > 0);

      // blaster: twin shots that break comets
      if (g.pw.blaster > 0 && (g.fire -= dt) <= 0) {
        g.shots.push({ x: s.x - 7, y: s.y - 16 }, { x: s.x + 7, y: s.y - 16 });
        g.fire = 0.13;
      }
      for (const sh of g.shots) sh.y -= 900 * dt;
      g.shots = g.shots.filter((sh) => {
        if (sh.y < -20) return false;
        const c = g.comets.find((c) => !(c.warn > 0) && Math.hypot(c.x - sh.x, c.y - sh.y) < c.r);
        if (!c) return true;
        if (--c.hp <= 0) {
          g.blasted++;
          smash(c, c.kind === 'boulder' ? 100 : 25);
          R.sound('tick');
        } else burst(sh.x, sh.y, '#a7f3d0', 6, 120);
        return false;
      });

      // Collisions (ship hitbox is a circle a bit smaller than the drawing, to feel fair).
      const hit = (x, y, r) => Math.hypot(x - s.x, y - s.y) < r + 14;
      g.stars = g.stars.filter((st) => {
        if (hit(st.x, st.y, 12)) {
          g.combo++;
          g.bestCombo = Math.max(g.bestCombo, g.combo);
          const m = mult();
          g.score += 50 * m;
          pop(st.x, st.y - 10, m > 1 ? `+${50 * m}  ×${m}` : '+50', '#fcd34d');
          burst(st.x, st.y, '#fcd34d', 12, 140);
          R.sound('tick');
          return false;
        }
        if (st.y > H + 30) {
          g.combo = 0; // a missed star breaks the chain
          return false;
        }
        return true;
      });
      g.caps = g.caps.filter((c) => {
        if (hit(c.x, c.y, 16)) {
          const p = POWERS[c.kind];
          g.pw[c.kind] = p.time;
          burst(c.x, c.y, p.color, 22, 200);
          pop(c.x, c.y - 14, p.label, p.color, true);
          R.sound('good');
          return false;
        }
        return c.y < H + 30;
      });
      for (const o of g.orbs) {
        if (!o.taken && hit(o.x, o.y, 14)) {
          o.taken = true;
          burst(o.x, o.y, '#60a5fa', 18, 180);
          return question('bonus');
        }
      }
      g.orbs = g.orbs.filter((o) => !o.taken && o.y < H + 30);
      for (const c of [...g.comets]) {
        if (c.warn > 0) continue;
        const d = Math.hypot(c.x - s.x, c.y - s.y);
        if (g.shield > 0) {
          if (d < c.r + 30) smash(c, 10); // the shield breaks what it touches
          continue;
        }
        if (d < c.r * 0.82 + 14) {
          burst(s.x, s.y, '#fb923c', 40, 320);
          burst(c.x, c.y, '#94a3b8', 20, 200);
          g.comets = g.comets.filter((x) => x !== c);
          g.flash = 0.25;
          g.shake = 0.4;
          g.combo = 0;
          R.sound('boom');
          return question('crash');
        }
        // flying close past a comet is worth a little
        if (d < c.r * 0.82 + 40 && c.y < s.y) c.close = true;
        if (c.close && !c.paid && c.y - c.r > s.y + 16) {
          c.paid = true;
          g.closes++;
          g.score += 30;
          pop(s.x, s.y - 46, 'Close call +30', '#e2e8f0');
        }
      }
    }

    function drawComet(c) {
      const kd = KINDS[c.kind];
      if (c.warn > 0) {
        // a streak announces itself before it drops
        if (Math.sin(c.warn * 28) > -0.2) {
          ctx.save();
          ctx.translate(c.x, 22);
          ctx.fillStyle = '#fb923c';
          ctx.beginPath();
          ctx.moveTo(0, -11);
          ctx.lineTo(11, 9);
          ctx.lineTo(-11, 9);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#1c1917';
          ctx.font = '800 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('!', 0, 7);
          ctx.restore();
        }
        return;
      }
      ctx.save();
      ctx.translate(c.x, c.y);
      const vx = c.zig ? Math.cos(c.ph) * c.zig * c.f : c.vx;
      const len = c.kind === 'streak' ? 0.22 : 0.35;
      const tail = ctx.createLinearGradient(0, 0, -vx * 0.25, -c.vy * len);
      tail.addColorStop(0, `rgba(${kd.tail},0.6)`);
      tail.addColorStop(1, `rgba(${kd.tail},0)`);
      ctx.fillStyle = tail;
      ctx.beginPath();
      ctx.moveTo(-c.r * 0.8, 0);
      ctx.lineTo(-vx * 0.25, -c.vy * len);
      ctx.lineTo(c.r * 0.8, 0);
      ctx.fill();
      ctx.rotate(c.rot);
      const body = ctx.createRadialGradient(-c.r * 0.3, -c.r * 0.3, c.r * 0.1, 0, 0, c.r);
      body.addColorStop(0, kd.body[0]);
      body.addColorStop(1, kd.body[1]);
      ctx.fillStyle = body;
      ctx.beginPath();
      const n = c.kind === 'boulder' ? 12 : 9;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rr = c.r * (0.82 + 0.18 * Math.sin(k * 2.3 + c.seed * 10));
        k ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = c.kind === 'ice' ? 'rgba(255,255,255,0.35)' : 'rgba(30,41,59,0.45)';
      ctx.beginPath();
      ctx.arc(c.r * 0.25, c.r * 0.1, c.r * 0.22, 0, 7);
      ctx.arc(-c.r * 0.3, c.r * 0.35, c.r * 0.12, 0, 7);
      if (c.kind === 'boulder') ctx.arc(-c.r * 0.2, -c.r * 0.42, c.r * 0.15, 0, 7);
      ctx.fill();
      if (c.kind === 'boulder' && c.hp < 3) {
        // cracks show the hits it has taken
        ctx.strokeStyle = 'rgba(253,186,116,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-c.r * 0.5, -c.r * 0.1);
        ctx.lineTo(0, c.r * 0.05);
        ctx.lineTo(c.r * 0.2, c.r * 0.5);
        if (c.hp < 2) {
          ctx.moveTo(0, c.r * 0.05);
          ctx.lineTo(c.r * 0.55, -c.r * 0.3);
        }
        ctx.stroke();
      }
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

    // power-up capsule: a colored disc with a small white symbol
    function drawCap(c) {
      const p = POWERS[c.kind];
      const y = c.y + Math.sin(c.bob) * 3;
      ctx.save();
      ctx.translate(c.x, y);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 16;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = ctx.fillStyle = '#fff';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (c.kind === 'magnet') {
        ctx.arc(0, -1, 6, Math.PI, 0, true);
        ctx.moveTo(-6, -1);
        ctx.lineTo(-6, -6);
        ctx.moveTo(6, -1);
        ctx.lineTo(6, -6);
        ctx.stroke();
      } else if (c.kind === 'blaster') {
        ctx.moveTo(-4, 6);
        ctx.lineTo(-4, -6);
        ctx.moveTo(4, 6);
        ctx.lineTo(4, -6);
        ctx.stroke();
      } else {
        ctx.arc(0, 0, 7, 0, 7);
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -4.5);
        ctx.moveTo(0, 0);
        ctx.lineTo(3.5, 1.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function draw() {
      // sky: fades into the next sector's colors on every level
      const a = SECTORS[g.prevSector];
      const b = SECTORS[g.sector];
      const k = g.skyFade;
      const grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, mix(a[0], b[0], k));
      grd.addColorStop(1, mix(a[1], b[1], k));
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
      // two slow nebula clouds give the sky some depth
      for (const [i, [nx, ny, nr]] of [[0.22, 0.3, 0.55], [0.78, 0.65, 0.45]].entries()) {
        const x = (nx + Math.sin(g.t * 0.05 + i * 2) * 0.05) * W;
        const y = (ny + Math.cos(g.t * 0.04 + i) * 0.05) * H;
        const neb = ctx.createRadialGradient(x, y, 0, x, y, nr * W);
        neb.addColorStop(0, `rgba(${b[2]},${0.16 * k})`);
        neb.addColorStop(1, `rgba(${b[2]},0)`);
        ctx.fillStyle = neb;
        ctx.fillRect(0, 0, W, H);
      }
      const slow = g.pw.slow > 0 ? 0.4 : 1;
      for (const st of bg) {
        const y = (st.y * H + g.t * 40 * st.z * slow) % H;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + st.z * 0.6})`;
        ctx.fillRect(st.x * W, y, st.z * 2, st.z * 2);
      }

      ctx.save();
      if (g.shake > 0 && !reduced) ctx.translate(R.rand(-1, 1) * g.shake * 16, R.rand(-1, 1) * g.shake * 16);
      for (const st of g.stars) drawStar(st.x, st.y, 11, st.spin);
      for (const c of g.caps) drawCap(c);
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
      ctx.fillStyle = '#6ee7b7';
      for (const sh of g.shots) ctx.fillRect(sh.x - 1.5, sh.y - 9, 3, 14);

      // ship
      const s = g.ship;
      ctx.save();
      ctx.translate(s.x, s.y);
      if (g.pw.magnet > 0) {
        ctx.strokeStyle = `rgba(255,90,95,${0.18 + 0.1 * Math.sin(g.t * 6)})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 8]);
        ctx.beginPath();
        ctx.arc(0, 0, 46 + Math.sin(g.t * 6) * 4, 0, 7);
        ctx.stroke();
        ctx.setLineDash([]);
      }
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
      ctx.shadowColor = g.pw.blaster > 0 ? '#34d399' : '#60a5fa';
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
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of g.pops) {
        ctx.globalAlpha = Math.min(1, p.life * 2);
        ctx.fillStyle = p.color;
        ctx.font = `${p.big ? 700 : 600} ${p.big ? 17 : 14}px Inter, system-ui, sans-serif`;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      if (g.pw.slow > 0) {
        ctx.fillStyle = 'rgba(56,189,248,0.07)';
        ctx.fillRect(0, 0, W, H);
      }

      // active power-ups, each with a bar that runs down
      const active = Object.keys(POWERS).filter((k) => g.pw[k] > 0);
      let px = W / 2 - (active.length * 118 - 8) / 2;
      for (const kName of active) {
        const p = POWERS[kName];
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        roundRect(px, 56, 110, 26, 13);
        ctx.fill();
        ctx.fillStyle = p.color;
        roundRect(px, 56, 110 * Math.max(0, g.pw[kName] / p.time), 26, 13);
        ctx.globalAlpha = 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.font = '600 12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, px + 55, 69);
        px += 118;
      }

      // level banner
      if (g.banner) {
        const bn = g.banner;
        const alpha = Math.min(1, (3.2 - bn.t) * 3, bn.t * 2);
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = `700 ${W < 500 ? 30 : 42}px Inter, system-ui, sans-serif`;
        ctx.fillText(bn.title, W / 2, H * 0.36);
        ctx.font = `600 ${W < 500 ? 14 : 17}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(bn.sub, W / 2, H * 0.36 + (W < 500 ? 30 : 38));
        if (bn.extra) {
          ctx.fillStyle = '#fcd34d';
          ctx.fillText(bn.extra, W / 2, H * 0.36 + (W < 500 ? 54 : 66));
        }
        ctx.globalAlpha = 1;
      }

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
      const t0 = performance.now();
      // Mostly multiple choice: the game should stay fast. Lists are never typed here.
      const type = deck.cards.length < 3 ? 'written' : card.kind === 'list' || Math.random() < 0.8 ? 'mc' : 'written';
      const q = R.quiz.make(card, deck, type);
      const streak = g.qStreak ? ` <span>${g.qStreak} right in a row so far.</span>` : '';
      overlay.innerHTML = `<div class="ov-panel ${why}">
        <div class="ov-head">${
          why === 'crash'
            ? `${R.icon('zap', 18)} <strong>You crashed!</strong> <span>Answer right to keep your heart.</span>`
            : `${R.icon('sparkles', 18)} <strong>Bonus question</strong> <span>Right answer: +250 and a shield.</span>`
        }${streak}</div>
        <div data-q></div></div>`;
      overlay.classList.add('show');
      R.ask(q, R.$('[data-q]', overlay), {
        showSpeak: false,
        onDone: (ok) => {
          R.srs.record(card, ok);
          R.store.upsert(deck);
          const s = g.ship;
          if (ok) {
            g.right++;
            g.qStreak++;
            // right answers pay, more for a fast one and for a run of them
            const quick = performance.now() - t0 < 6000;
            const pts = (why === 'crash' ? 100 : 250) + (quick ? 100 : 0) + 50 * (g.qStreak - 1);
            g.score += pts;
            pop(s.x, s.y - 70, `${why === 'crash' ? 'Saved' : 'Bonus'} +${pts}`, '#86efac', true);
            if (quick) pop(s.x, s.y - 48, 'Quick answer', '#bbf7d0');
          } else {
            g.qStreak = 0;
            g.missed.set(card.id, card);
          }
          if (why === 'crash') {
            if (!ok) g.hearts--;
            g.shield = 2.6;
            g.comets = g.comets.filter((c) => c.y < s.y - 180);
          } else if (ok) g.shield = 5;
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
      g.banner = { title: 'Level 1', sub: 'Dodge the comets, chain the stars', extra: 'Fly into a capsule for a power-up', t: 3.2 };
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      countdown();
    }

    function intro() {
      reset();
      const best = R.store.best(`comet:${deck.id}`);
      overlay.innerHTML = `<div class="ov-panel ov-center">
        <div class="ov-title">${R.icon('rocket', 26)}<h2>Comet Run</h2></div>
        <p>Dodge the comets and chain the stars for a multiplier. Crash, and you'll have to answer a question from <strong>${R.esc(deck.title)}</strong>. Get it right to keep your heart. Three wrong answers and the run is over.</p>
        <div class="ov-powers">${Object.values(POWERS)
          .map((p) => `<span><i style="background:${p.color}"></i>${p.label}</span>`)
          .join('')}<span><i class="orb"></i>Bonus question</span></div>
        <p class="muted small">Every 15 seconds a new level: new comets, a new sky and an event.</p>
        ${best ? `<p class="muted">Best score: <strong>${best.toLocaleString()}</strong></p>` : ''}
        <button class="btn btn-primary btn-lg" data-start>${R.icon('play', 16)} Launch</button></div>`;
      overlay.classList.add('show');
      R.$('[data-start]', overlay).addEventListener('click', start);
    }

    function over() {
      running = false;
      const score = Math.floor(g.score);
      const record = R.store.setBest(`comet:${deck.id}`, score);
      R.store.addHistory({ type: 'comet', deck: deck.id, title: deck.title, score, detail: `${score.toLocaleString()} points, level ${level()}, ${g.right} of ${g.asked} answered right` });
      R.sound(record ? 'win' : 'bad');
      if (record) R.confetti();
      const missed = [...g.missed.values()];
      const stats = [
        [level(), 'level reached'],
        [`${g.right}/${g.asked}`, 'answered right'],
        [g.bestCombo, 'best star chain'],
        [g.closes, 'close calls'],
        [g.blasted, 'comets blasted'],
      ];
      overlay.innerHTML = `<div class="ov-panel ov-center">
        <div class="ov-title">${R.icon('trophy', 26)}<h2>${score.toLocaleString()}${record ? ' <span class="pill pill-hot">New best</span>' : ''}</h2></div>
        <div class="ov-stats">${stats.map(([n, l]) => `<div><strong>${n}</strong><span>${l}</span></div>`).join('')}</div>
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
