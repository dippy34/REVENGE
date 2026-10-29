/* Kyrie: Sprint. A timed, typed drill in the style of a graded practice: a clock,
   one prompt at a time, type the answer, Enter. Kyrie's own twists: a streak
   multiplier that also adds time, one free retry on a typo, wrong answers typed
   correctly before moving on and brought back later in the round, a live pace
   against your best, and a round of only your mistakes at the end. */
(function () {
  const V = (R.views = R.views || {});
  const LENGTHS = [60, 120, 180, 300];
  const fmt = (s) => R.esc(s).replace(/_{3,}/g, '<span class="blank sm"></span>');
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;
  // Accents count: compare everything except case, spacing and punctuation.
  const exact = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const multFor = (streak) => (streak >= 10 ? 4 : streak >= 6 ? 3 : streak >= 3 ? 2 : 1);

  V.sprint = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    // Lists are too slow to type against a clock; use them only if nothing else is left.
    const usable = deck.cards.filter((c) => c.kind !== 'list' && c.front && c.back);
    const pool = usable.length >= 2 ? usable : deck.cards;
    if (pool.length < 2) {
      root.innerHTML = `${R.modeHeader(deck, 'Sprint', 'clock')}<div class="done-card">${R.icon('cards', 28)}<h2>Add a few more cards</h2><p class="muted">Sprint needs at least 2 cards in the deck.</p><a class="btn btn-primary" href="#/new?into=${deck.id}">Add material</a></div>`;
      return;
    }

    const prefKey = 'kyrie.pref.sprint';
    const opt = Object.assign({ len: 120, side: 'term', strict: false }, (() => {
      try {
        return JSON.parse(localStorage.getItem(prefKey)) || {};
      } catch (_) {
        return {};
      }
    })());
    const savePref = () => {
      try {
        localStorage.setItem(prefKey, JSON.stringify(opt));
      } catch (_) {}
    };

    root.innerHTML = `${R.modeHeader(deck, 'Sprint', 'clock', `<button class="icon-btn" data-pause title="Pause (Esc)" hidden>${R.icon('pause', 18)}</button>`)}<div class="sprint-wrap" data-stage></div>`;
    const stage = R.$('[data-stage]', root);
    const pauseBtn = R.$('[data-pause]', root);
    let st = null;
    let timer = null;

    // Which side to show and which to type, for one card under the chosen setting.
    function ask(card) {
      const reverse = card.kind === 'term' && (opt.side === 'term' || (opt.side === 'mix' && Math.random() < 0.5));
      return R.quiz.make(card, deck, 'written', { reverse });
    }
    const answers = () => pool.map((c) => (c.kind === 'term' && opt.side === 'term' ? c.front : opt.side === 'mix' ? c.front + c.back : c.back)).join(' ');
    // Letters a US keyboard does not have, for the accent bar (á é ñ ü ¿ ...).
    const accents = () => [...new Set((answers().match(/[^\x00-\x7F]/gu) || []).filter((ch) => /[\p{L}¿¡]/u.test(ch)).map((ch) => ch.toLowerCase()))].sort().slice(0, 16);

    // Weak cards first, but every card gets its turn before any repeats.
    function shuffled(cards) {
      const w = (c) => (R.srs.state(c) === 'mastered' ? 1 : c.s.lapses ? 3 : !c.s.seen ? 2.2 : 1.6);
      return cards.map((c) => ({ c, k: Math.random() ** (1 / w(c)) })).sort((a, b) => b.k - a.k).map((x) => x.c);
    }

    /* ---------- setup ---------- */

    function setup() {
      clearInterval(timer);
      pauseBtn.hidden = true;
      const best = R.store.best(`sprint:${deck.id}`);
      const hasAccents = accents().length > 0;
      const seg = (name, items) =>
        `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button class="seg-btn ${String(opt[name]) === String(v) ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>`;
      const termDeck = pool.some((c) => c.kind === 'term');
      stage.innerHTML = `<div class="done-card sprint-setup">
        <div class="done-ic">${R.icon('clock', 28)}</div>
        <h2>Sprint</h2>
        <p class="muted">Type as many answers as you can before the clock runs out. Five right in a row adds five seconds.</p>
        <div class="sp-opts">
          <label>Time</label>${seg('len', LENGTHS.map((s) => [s, clock(s)]))}
          ${termDeck ? `<label>Answer with</label>${seg('side', [['term', 'Term'], ['def', 'Definition'], ['mix', 'Mixed']])}` : ''}
          ${hasAccents ? `<label>Accents</label>${seg('strict', [['false', 'Forgiving'], ['true', 'Must match']])}` : ''}
        </div>
        ${best ? `<p class="muted small">Best: <strong>${best.toLocaleString()}</strong> points</p>` : ''}
        <button class="btn btn-primary btn-lg" data-go>${R.icon('play', 16)} Start</button>
        <div class="kbd-hint hide-sm"><kbd>Enter</kbd> check · <kbd>Tab</kbd> hint · <kbd>Esc</kbd> pause</div></div>`;
      R.$$('[data-seg]', stage).forEach((s) =>
        s.addEventListener('click', (e) => {
          const b = e.target.closest('[data-v]');
          if (!b) return;
          const name = s.dataset.seg;
          opt[name] = name === 'len' ? Number(b.dataset.v) : name === 'strict' ? b.dataset.v === 'true' : b.dataset.v;
          savePref();
          R.$$('[data-v]', s).forEach((x) => x.classList.toggle('on', x === b));
        })
      );
      R.$('[data-go]', stage).addEventListener('click', () => play(pool));
    }

    /* ---------- the drill ---------- */

    function play(cards, label = '') {
      st = {
        cards,
        queue: shuffled(cards),
        len: opt.len,
        end: performance.now() + opt.len * 1000,
        left: opt.len,
        paused: false,
        score: 0,
        right: 0,
        total: 0,
        streak: 0,
        bestStreak: 0,
        bonus: 0,
        q: null,
        phase: 'ask', // ask | retry | fix (type the right answer to move on)
        hinted: 0,
        mistakes: new Map(),
        best: R.store.best(`sprint:${deck.id}`) || 0,
        label,
      };
      const keys = accents();
      stage.innerHTML = `
        <div class="sprint">
          <div class="sp-top">
            <div class="sp-clock" data-clock>${clock(st.len)}</div>
            <div class="sp-bar"><i data-bar></i></div>
            <div class="sp-stats">
              <div><strong data-right>0</strong><span>correct</span></div>
              <div><strong data-total>0</strong><span>attempted</span></div>
              <div><strong data-acc>–</strong><span>accuracy</span></div>
            </div>
          </div>
          <div class="sp-card" data-card>
            <div class="sp-meta"><span class="q-label" data-label></span><span class="sp-streak" data-streak></span></div>
            <div class="sp-prompt" data-prompt></div>
            <div class="sp-feedback" data-fb></div>
          </div>
          <form class="sp-form" data-form autocomplete="off">
            <input class="input input-lg sp-input" data-input placeholder="Type your answer" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button class="btn btn-primary btn-lg" data-check>Check</button>
          </form>
          ${keys.length ? `<div class="sp-keys" data-keys>${keys.map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>` : ''}
          <div class="sp-foot">
            <span class="sp-score"><strong data-score>0</strong> points <span class="sp-mult" data-mult></span></span>
            <span class="sp-pace" data-pace></span>
            <span class="row gap-sm"><button class="btn btn-text btn-sm" type="button" data-hint>Hint</button><button class="btn btn-text btn-sm" type="button" data-skip>Skip</button></span>
          </div>
        </div>`;
      const input = R.$('[data-input]', stage);
      R.$('[data-form]', stage).addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
      });
      R.$('[data-hint]', stage).addEventListener('click', hint);
      R.$('[data-skip]', stage).addEventListener('click', skip);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          hint();
        }
      });
      R.$('[data-keys]', stage)?.addEventListener('mousedown', (e) => {
        const b = e.target.closest('[data-k]');
        if (!b) return;
        e.preventDefault(); // keep the caret in the input
        const ch = e.shiftKey ? b.dataset.k.toUpperCase() : b.dataset.k;
        const [a, z] = [input.selectionStart, input.selectionEnd];
        input.setRangeText(ch, a, z, 'end');
        input.focus();
      });
      pauseBtn.hidden = false;
      next();
      clearInterval(timer);
      timer = setInterval(tick, 100);
    }

    function next() {
      if (!st.queue.length) st.queue = shuffled(st.cards);
      const card = st.queue.shift();
      st.q = ask(card);
      st.phase = 'ask';
      st.hinted = 0;
      const el = R.$('[data-card]', stage);
      el.classList.remove('right', 'wrong', 'close', 'shake');
      R.$('[data-label]', stage).textContent = st.q.ask;
      R.$('[data-prompt]', stage).innerHTML = fmt(st.q.prompt);
      R.$('[data-prompt]', stage).classList.toggle('long', st.q.prompt.length > 120);
      R.$('[data-fb]', stage).innerHTML = '';
      const input = R.$('[data-input]', stage);
      input.value = '';
      input.placeholder = 'Type your answer';
      input.focus({ preventScroll: true });
      draw();
    }

    function correct(value) {
      const res = R.quiz.check(st.q, value);
      if (res.ok && opt.strict && exact(value) !== exact(st.q.answer) && R.norm(value) === R.norm(st.q.answer)) return { ok: false, close: true, accent: true };
      return res;
    }

    function submit() {
      if (!st || st.paused || st.left <= 0) return;
      const input = R.$('[data-input]', stage);
      const value = input.value.trim();
      const el = R.$('[data-card]', stage);
      const fb = R.$('[data-fb]', stage);
      if (!value) return;

      if (st.phase === 'fix') {
        // A wrong answer is typed correctly once before moving on.
        if (R.quiz.check(st.q, value).ok) next();
        else {
          el.classList.remove('shake');
          void el.offsetWidth;
          el.classList.add('shake');
        }
        return;
      }

      if (st.phase === 'done') return; // already marked, the next prompt is on its way
      const res = correct(value);
      if (!res.ok && res.close && st.phase === 'ask') {
        // one free retry on a typo or a missing accent
        st.phase = 'retry';
        el.classList.add('close');
        fb.innerHTML = `<span class="sp-close">${res.accent ? 'Check your accents.' : 'So close! Check the spelling.'}</span>`;
        input.select();
        R.sound('tick');
        return;
      }

      st.total++;
      R.srs.record(st.q.card, res.ok);
      if (res.ok) {
        st.right++;
        st.streak++;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        const m = multFor(st.streak);
        const pts = Math.round((10 * m) / (st.hinted ? 2 : 1));
        st.score += pts;
        el.classList.remove('close', 'wrong');
        el.classList.add('right');
        fb.innerHTML = `<span class="sp-plus">+${pts}${m > 1 ? ` · ×${m}` : ''}</span>`;
        R.sound('good');
        if (st.streak % 5 === 0) {
          st.end += 5000;
          st.bonus += 5;
          fb.innerHTML += ` <span class="sp-time">+5 seconds</span>`;
        }
        draw();
        setTimeout(() => st && st.left > 0 && !st.paused && st.phase !== 'fix' && next(), 380);
        st.phase = 'done';
      } else miss(value);
    }

    function miss(value) {
      const el = R.$('[data-card]', stage);
      const fb = R.$('[data-fb]', stage);
      const input = R.$('[data-input]', stage);
      st.streak = 0;
      st.mistakes.set(st.q.card.id, { q: st.q, typed: value });
      // the card comes back a few prompts later in this round
      st.queue.splice(Math.min(st.queue.length, 3 + ((Math.random() * 3) | 0)), 0, st.q.card);
      el.classList.remove('close', 'right');
      el.classList.add('wrong', 'shake');
      setTimeout(() => el.classList.remove('shake'), 400);
      fb.innerHTML = `${value ? `<span class="sp-yours">${R.esc(value)}</span>` : ''}<span class="sp-answer">${R.esc(st.q.answer)}</span>`;
      R.sound('bad');
      const short = st.q.answer.length <= 48;
      st.phase = short ? 'fix' : 'done';
      input.value = '';
      input.placeholder = short ? 'Type the right answer to continue' : 'Press Enter to continue';
      if (!short) {
        const go = (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          input.removeEventListener('keydown', go);
          next();
        };
        input.addEventListener('keydown', go);
      }
      draw();
    }

    function hint() {
      if (!st || st.phase === 'done' || st.paused) return;
      const ans = st.q.answer;
      st.hinted = Math.min(ans.length, st.hinted + Math.max(1, Math.ceil(ans.length / 6)));
      const input = R.$('[data-input]', stage);
      input.value = ans.slice(0, st.hinted);
      input.focus();
      R.$('[data-fb]', stage).innerHTML = '<span class="sp-close">Hints halve the points for this one.</span>';
    }

    function skip() {
      if (!st || st.phase === 'done' || st.phase === 'fix' || st.paused) return;
      st.total++;
      R.srs.record(st.q.card, false);
      miss('');
    }

    function draw() {
      R.$('[data-right]', stage).textContent = st.right;
      R.$('[data-total]', stage).textContent = st.total;
      R.$('[data-acc]', stage).textContent = st.total ? `${Math.round((st.right / st.total) * 100)}%` : '–';
      R.$('[data-score]', stage).textContent = st.score.toLocaleString();
      const m = multFor(st.streak);
      R.$('[data-mult]', stage).textContent = m > 1 ? `×${m}` : '';
      R.$('[data-streak]', stage).innerHTML = st.streak >= 2 ? `${R.icon('flame', 14)} ${st.streak} in a row` : '';
    }

    function tick() {
      if (st.paused) return;
      st.left = Math.max(0, (st.end - performance.now()) / 1000);
      const total = st.len + st.bonus;
      const c = R.$('[data-clock]', stage);
      c.textContent = clock(Math.ceil(st.left));
      c.classList.toggle('low', st.left <= 10);
      R.$('[data-bar]', stage).style.width = `${(st.left / total) * 100}%`;
      // pace: where this run is heading, against the best
      const used = total - st.left;
      if (used > 8 && st.score) {
        const pace = Math.round((st.score / used) * total);
        R.$('[data-pace]', stage).innerHTML = st.best ? `On pace for <strong>${pace.toLocaleString()}</strong> · best ${st.best.toLocaleString()}` : `On pace for <strong>${pace.toLocaleString()}</strong>`;
        R.$('[data-pace]', stage).classList.toggle('ahead', !!st.best && pace > st.best);
      }
      if (st.left <= 0) finish();
    }

    function pause(force) {
      if (!st || st.left <= 0) return;
      const on = force ?? !st.paused;
      if (on === st.paused) return;
      st.paused = on;
      if (on) {
        st.left = Math.max(0, (st.end - performance.now()) / 1000);
        stage.querySelector('.sprint').classList.add('paused');
        stage.querySelector('.sprint').insertAdjacentHTML('beforeend', `<div class="sp-paused" data-paused><h2>Paused</h2><button class="btn btn-primary btn-lg" data-resume>${R.icon('play', 16)} Resume</button></div>`);
        R.$('[data-resume]', stage).addEventListener('click', () => pause(false));
      } else {
        st.end = performance.now() + st.left * 1000;
        stage.querySelector('.sprint').classList.remove('paused');
        R.$('[data-paused]', stage)?.remove();
        R.$('[data-input]', stage).focus();
      }
    }

    function finish() {
      clearInterval(timer);
      pauseBtn.hidden = true;
      const done = st;
      st = null;
      R.store.upsert(deck);
      const record = done.score > 0 && R.store.setBest(`sprint:${deck.id}`, done.score);
      const acc = done.total ? Math.round((done.right / done.total) * 100) : 0;
      R.store.addHistory({ type: 'sprint', deck: deck.id, title: deck.title, score: done.score, detail: `${done.right} of ${done.total} correct (${acc}%) in ${clock(done.len)}${done.label ? `, ${done.label}` : ''}` });
      R.sound(record ? 'win' : 'good');
      if (record) R.confetti();
      const missed = [...done.mistakes.values()];
      stage.innerHTML = `<div class="done-card sprint-done">
        <div class="done-ic">${R.icon('trophy', 28)}</div>
        <h2>${done.right} correct${record ? ' <span class="pill pill-hot">New best</span>' : ''}</h2>
        <div class="ov-stats sp-result">
          <div><strong>${done.score.toLocaleString()}</strong><span>points</span></div>
          <div><strong>${acc}%</strong><span>accuracy</span></div>
          <div><strong>${done.total}</strong><span>attempted</span></div>
          <div><strong>${done.bestStreak}</strong><span>best streak</span></div>
          <div><strong>+${done.bonus}s</strong><span>time earned</span></div>
        </div>
        ${
          missed.length
            ? `<div class="ov-missed sp-missed"><div class="q-label">Your mistakes</div>${missed
                .map(({ q, typed }) => `<div class="ov-miss"><span>${fmt(q.prompt)}</span>${typed ? `<em>${R.esc(typed)}</em>` : '<em class="skip">skipped</em>'}<strong>${R.esc(q.answer)}</strong></div>`)
                .join('')}</div>`
            : '<p class="muted">No mistakes. Clean run.</p>'
        }
        <div class="row gap center wrap">
          <a class="btn btn-ghost" href="#/deck/${deck.id}">Done</a>
          ${missed.length ? `<button class="btn btn-ghost" data-mistakes>${R.icon('refresh', 16)} Practice my mistakes</button>` : ''}
          <button class="btn btn-primary btn-lg" data-again>${R.icon('play', 16)} Go again</button>
        </div></div>`;
      R.$('[data-again]', stage).addEventListener('click', () => play(pool));
      R.$('[data-mistakes]', stage)?.addEventListener('click', () => {
        const cards = missed.map((m) => m.q.card);
        play(cards.length >= 2 ? cards : [...cards, ...shuffled(pool.filter((c) => !cards.includes(c))).slice(0, 2 - cards.length)], 'mistakes only');
      });
    }

    const onKey = (e) => {
      if (e.key === 'Escape' && st) {
        e.preventDefault();
        pause();
      }
    };
    const vis = () => document.hidden && st && pause(true);
    pauseBtn.addEventListener('click', () => pause());
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', vis);
    R.onLeave = () => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', vis);
    };

    setup();
  };
})();
