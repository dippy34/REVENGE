/* Kyrie: Flashcards, Learn and Practice test. */
(function () {
  const V = (R.views = R.views || {});
  const fmt = (s) => R.esc(s).replace(/_{3,}/g, '<span class="blank"></span>');

  /* ================= FLASHCARDS ================= */

  V.flash = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    const opt = { shuffle: false, reverse: false, starred: !!params.starred };
    const onlyDue = !!params.due;
    let queue = [];
    let i = 0;
    let flipped = false;
    const tally = { again: 0, hard: 0, good: 0, easy: 0 };

    function build() {
      let cards = deck.cards.slice();
      if (opt.starred) cards = cards.filter((c) => c.starred);
      if (onlyDue) cards = cards.filter((c) => c.s.seen && R.srs.isDue(c));
      else {
        // Due first, then new, then the rest by how soon they're due.
        const rank = (c) => (c.s.seen && R.srs.isDue(c) ? 0 : !c.s.seen ? 1 : 2);
        cards.sort((a, b) => rank(a) - rank(b) || a.s.due - b.s.due);
      }
      if (opt.shuffle) cards = R.shuffle(cards);
      queue = cards;
      i = 0;
    }
    build();

    root.innerHTML = `
      ${R.modeHeader(deck, onlyDue ? 'Review due cards' : 'Flashcards', 'cards', `
        <button class="icon-btn ${opt.shuffle ? 'on' : ''}" data-shuffle title="Shuffle">${R.icon('shuffle', 18)}</button>
        <button class="icon-btn" data-reverse title="Show the answer side first">${R.icon('rotate', 18)}</button>`)}
      <div class="flash-wrap">
        <div class="prog"><div class="prog-bar"><i data-bar></i></div><span data-count></span></div>
        <div class="flash-stage" data-stage></div>
        <div class="flash-controls" data-controls></div>
        <div class="kbd-hint hide-sm"><kbd>Space</kbd> flip · <kbd>1</kbd>-<kbd>4</kbd> rate · <kbd>←</kbd><kbd>→</kbd> browse · <kbd>S</kbd> star</div>
      </div>`;
    const stage = R.$('[data-stage]', root);
    const controls = R.$('[data-controls]', root);

    function draw() {
      R.$('[data-bar]', root).style.width = `${queue.length ? (i / queue.length) * 100 : 100}%`;
      R.$('[data-count]', root).textContent = queue.length ? `${Math.min(i + 1, queue.length)} / ${queue.length}` : '';
      if (!queue.length) {
        stage.innerHTML = `<div class="done-card card pad">${R.icon('check', 28)}<h2>${onlyDue ? 'Nothing due right now' : opt.starred ? 'No starred cards' : 'No cards'}</h2><p class="muted">${onlyDue ? 'You are all caught up. Come back later, or keep going with Learn.' : 'Star cards from the deck page to drill them here.'}</p><div class="row gap center"><a class="btn btn-ghost" href="#/deck/${deck.id}">Back to deck</a><a class="btn btn-primary" href="#/deck/${deck.id}/learn">Learn mode</a></div></div>`;
        controls.innerHTML = '';
        return;
      }
      if (i >= queue.length) return finish();
      const c = queue[i];
      flipped = false;
      const frontSide = opt.reverse ? c.back : c.front;
      const backSide = opt.reverse ? c.front : c.back;
      const label = opt.reverse ? 'Answer' : R.quiz.LABEL[c.kind] || 'Term';
      stage.innerHTML = `
        <div class="flip" data-flip tabindex="0" aria-label="Flashcard, press space to flip">
          <div class="flip-inner">
            <div class="face front">
              <div class="face-top"><span class="q-label">${label}</span>
                <span class="row gap-sm"><button class="icon-btn" data-say="front" title="Read aloud">${R.icon('volume', 16)}</button>
                <button class="icon-btn ${c.starred ? 'starred' : ''}" data-star title="Star">${R.icon('star', 16)}</button></span></div>
              <div class="face-text ${frontSide.length > 140 ? 'long' : ''}">${fmt(frontSide)}</div>
              ${c.hint && !opt.reverse ? `<div class="face-hint">${R.esc(c.hint)}</div>` : ''}
              <div class="face-tap">Click or press space to flip</div>
            </div>
            <div class="face back">
              <div class="face-top"><span class="q-label">${opt.reverse ? 'Prompt' : 'Answer'}</span>
                <button class="icon-btn" data-say="back" title="Read aloud">${R.icon('volume', 16)}</button></div>
              <div class="face-text ${backSide.length > 140 ? 'long' : ''}">${fmt(backSide)}</div>
              ${c.explain && c.explain !== c.front ? `<div class="face-hint">${R.esc(c.explain)}</div>` : ''}
            </div>
          </div>
        </div>`;
      const flip = R.$('[data-flip]', stage);
      flip.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        toggle();
      });
      R.$('[data-star]', stage).addEventListener('click', star);
      R.$$('[data-say]', stage).forEach((b) => b.addEventListener('click', () => R.speak(b.dataset.say === 'front' ? frontSide : backSide)));
      drawControls();
    }

    function drawControls() {
      const c = queue[i];
      if (!flipped) {
        controls.innerHTML = `
          <button class="icon-btn lg" data-prev ${i === 0 ? 'disabled' : ''} aria-label="Previous">${R.icon('left', 20)}</button>
          <button class="btn btn-primary btn-lg flip-btn" data-show>Show answer</button>
          <button class="icon-btn lg" data-skip aria-label="Next">${R.icon('right', 20)}</button>`;
        R.$('[data-show]', controls).addEventListener('click', toggle);
        R.$('[data-prev]', controls).addEventListener('click', () => go(-1));
        R.$('[data-skip]', controls).addEventListener('click', () => go(1));
      } else {
        const g = [
          ['again', 'Again', 0],
          ['hard', 'Hard', 1],
          ['good', 'Good', 2],
          ['easy', 'Easy', 3],
        ];
        controls.innerHTML = `<div class="rate">${g
          .map(([k, l, n]) => `<button class="rate-btn ${k}" data-g="${n}"><kbd>${n + 1}</kbd><strong>${l}</strong><span>${R.srs.preview(c, n)}</span></button>`)
          .join('')}</div>`;
        R.$$('[data-g]', controls).forEach((b) => b.addEventListener('click', () => rate(+b.dataset.g)));
      }
    }

    function toggle() {
      flipped = !flipped;
      R.$('[data-flip]', stage)?.classList.toggle('flipped', flipped);
      R.sound('flip');
      drawControls();
    }
    function go(d) {
      i = R.clamp(i + d, 0, queue.length - 1);
      draw();
    }
    function star() {
      const c = queue[i];
      c.starred = !c.starred;
      R.store.upsert(deck);
      R.$('[data-star]', stage)?.classList.toggle('starred', c.starred);
    }
    function rate(g) {
      const c = queue[i];
      R.srs.rate(c, g);
      tally[['again', 'hard', 'good', 'easy'][g]]++;
      if (g === 0) {
        // See it again a few cards later.
        const at = Math.min(queue.length, i + 4);
        queue.splice(at, 0, c);
      }
      R.store.upsert(deck);
      i++;
      const el = R.$('[data-flip]', stage);
      if (el) {
        el.classList.add(g === 0 ? 'out-left' : 'out-right');
        setTimeout(draw, 180);
      } else draw();
    }

    function finish() {
      R.$('[data-bar]', root).style.width = '100%';
      const reviewed = tally.again + tally.hard + tally.good + tally.easy;
      if (reviewed) R.confetti();
      if (reviewed) R.store.addHistory({ type: 'flash', deck: deck.id, title: deck.title, detail: `Reviewed ${R.plural(reviewed, 'card')}` });
      R.sound('win');
      const s = R.srs.summary(deck);
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic">${R.icon('trophy', 30)}</div>
        <h2>Session complete</h2>
        <p class="muted">You reviewed ${R.plural(reviewed, 'card')}. ${s.mastered} of ${s.total} are now mastered.</p>
        <div class="tally"><span class="again">${tally.again} again</span><span class="hard">${tally.hard} hard</span><span class="good">${tally.good} good</span><span class="easy">${tally.easy} easy</span></div>
        <div class="row gap center wrap"><button class="btn btn-ghost" data-again>${R.icon('refresh', 16)} Go again</button><a class="btn btn-primary" href="#/deck/${deck.id}/learn">${R.icon('learn', 16)} Quiz me</a></div>
      </div>`;
      controls.innerHTML = '';
      R.$('[data-again]', stage).addEventListener('click', () => {
        Object.keys(tally).forEach((k) => (tally[k] = 0));
        build();
        draw();
      });
    }

    R.$('[data-shuffle]', root).addEventListener('click', (e) => {
      opt.shuffle = !opt.shuffle;
      e.currentTarget.classList.toggle('on', opt.shuffle);
      build();
      draw();
    });
    R.$('[data-reverse]', root).addEventListener('click', (e) => {
      opt.reverse = !opt.reverse;
      e.currentTarget.classList.toggle('on', opt.reverse);
      draw();
    });

    const onKey = (e) => {
      if (e.target.closest('input,textarea,[contenteditable]') || e.metaKey || e.ctrlKey) return;
      if (i >= queue.length) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        toggle();
      } else if (flipped && /^[1-4]$/.test(e.key)) rate(+e.key - 1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key.toLowerCase() === 's') star();
    };
    document.addEventListener('keydown', onKey);
    R.onLeave = () => document.removeEventListener('keydown', onKey);
    draw();
  };

  /* ================= LEARN ================= */

  V.learn = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    const canMC = deck.cards.length >= 3;
    const opts = { typed: true };
    let items; // { card, level } level 0 -> 1 after MC, 2 after typed (done)
    let round = [];
    let roundNo = 0;
    let roundRight = 0;
    let current = null;

    function setup() {
      let pool = deck.cards.filter((c) => R.srs.state(c) !== 'mastered');
      if (!pool.length) pool = deck.cards.slice();
      // Struggling cards first, then new.
      pool.sort((a, b) => b.s.lapses - a.s.lapses || a.s.seen - b.s.seen);
      items = pool.map((card) => ({ card, level: canMC ? 0 : 1 }));
      roundNo = 0;
    }
    const goal = () => (opts.typed ? 2 : 1);

    root.innerHTML = `
      ${R.modeHeader(deck, 'Learn', 'learn', `<label class="toggle-inline"><input type="checkbox" class="switch sm" data-typed checked> <span class="hide-sm">Typed answers</span></label>`)}
      <div class="learn-wrap">
        <div class="learn-prog" data-lp></div>
        <div class="q-stage" data-stage></div>
      </div>`;
    const stage = R.$('[data-stage]', root);
    R.$('[data-typed]', root).addEventListener('change', (e) => {
      opts.typed = e.target.checked;
      if (!opts.typed) items.forEach((it) => (it.level = Math.min(it.level, 1)));
      drawProgress();
      if (!current) nextRound();
    });

    function drawProgress() {
      const done = items.filter((it) => it.level >= goal()).length;
      const mid = items.filter((it) => it.level > (canMC ? 0 : 1) && it.level < goal()).length;
      const total = items.length;
      R.$('[data-lp]', root).innerHTML = `
        <div class="lp-bar"><i class="m" style="width:${(done / total) * 100}%"></i><i class="l" style="width:${(mid / total) * 100}%"></i></div>
        <div class="lp-legend"><span><i class="dot m"></i>${done} learned</span><span><i class="dot l"></i>${mid} getting there</span><span><i class="dot n"></i>${total - done - mid} to go</span></div>`;
    }

    function nextRound() {
      const left = items.filter((it) => it.level < goal());
      if (!left.length) return finish();
      roundNo++;
      roundRight = 0;
      round = left.slice(0, 7);
      ask();
    }

    function ask() {
      drawProgress();
      const it = round.shift();
      if (!it) return roundSummary();
      current = it;
      const type = it.level === 0 ? (Math.random() < 0.25 && canMC ? 'tf' : 'mc') : 'written';
      const q = R.quiz.make(it.card, deck, type);
      R.ask(q, stage, {
        onDone: (ok) => {
          R.srs.record(it.card, ok);
          R.store.upsert(deck);
          if (ok) {
            roundRight++;
            it.level++;
          } else {
            it.level = Math.max(canMC ? 0 : 1, it.level - 1);
            if (round.length) round.splice(Math.min(round.length, 2), 0, it); // see it again this round
            else round.push(it);
          }
          current = null;
          ask();
        },
      });
    }

    function roundSummary() {
      drawProgress();
      const done = items.filter((it) => it.level >= goal()).length;
      if (done === items.length) return finish();
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic blue">${R.icon('target', 28)}</div>
        <h2>Round ${roundNo} done</h2>
        <p class="muted">${done} of ${items.length} learned. Keep going, the next round mixes in what you missed.</p>
        <button class="btn btn-primary btn-lg" data-next>Continue <kbd>Enter</kbd></button>
      </div>`;
      const go = () => {
        document.removeEventListener('keydown', key);
        nextRound();
      };
      const key = (e) => e.key === 'Enter' && (e.preventDefault(), go());
      R.$('[data-next]', stage).addEventListener('click', go);
      setTimeout(() => document.addEventListener('keydown', key), 50);
      R.onLeave = () => document.removeEventListener('keydown', key);
    }

    function finish() {
      drawProgress();
      R.confetti();
      R.store.addHistory({ type: 'learn', deck: deck.id, title: deck.title, detail: `Learned ${R.plural(items.length, 'card')}` });
      R.sound('win');
      stage.innerHTML = `<div class="done-card card pad">
        <div class="done-ic">${R.icon('trophy', 30)}</div>
        <h2>You learned ${R.plural(items.length, 'card')}!</h2>
        <p class="muted">Spaced repetition will bring them back right before you'd forget. Lock it in with a practice test.</p>
        <div class="row gap center wrap"><button class="btn btn-ghost" data-again>${R.icon('refresh', 16)} Learn again</button><a class="btn btn-primary" href="#/deck/${deck.id}/test">${R.icon('test', 16)} Take a test</a></div>
      </div>`;
      R.$('[data-again]', stage).addEventListener('click', () => {
        setup();
        items.forEach((it) => (it.level = canMC ? 0 : 1));
        nextRound();
      });
    }

    setup();
    nextRound();
  };

  /* ================= PRACTICE TEST ================= */

  V.test = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    const max = deck.cards.length;
    const cfg = { n: Math.min(20, max), types: { mc: max >= 3, written: true, tf: max >= 2 }, only: params.cards ? params.cards.split(',') : null };

    root.innerHTML = `${R.modeHeader(deck, 'Practice test', 'test')}<div class="test-wrap" data-stage></div>`;
    const stage = R.$('[data-stage]', root);

    function setupScreen() {
      stage.innerHTML = `<div class="card pad test-setup">
        <h2>Set up your test</h2>
        <label class="field"><span>Questions <strong data-nv>${cfg.n}</strong> <em class="muted">of ${max}</em></span>
          <input type="range" class="range" min="1" max="${max}" value="${cfg.n}" data-n></label>
        <div class="field"><span>Question types</span>
          <div class="checks">
            ${[['mc', 'Multiple choice'], ['written', 'Written'], ['tf', 'True / false']]
              .map(([k, l]) => `<label class="check ${k !== 'written' && max < 3 && k === 'mc' ? 'disabled' : ''}"><input type="checkbox" data-t="${k}" ${cfg.types[k] ? 'checked' : ''} ${k === 'mc' && max < 3 ? 'disabled' : ''}><span>${l}</span></label>`)
              .join('')}
          </div></div>
        <button class="btn btn-primary btn-lg w100" data-start>${R.icon('play', 16)} Start test</button>
      </div>`;
      const n = R.$('[data-n]', stage);
      n.addEventListener('input', () => {
        cfg.n = +n.value;
        R.$('[data-nv]', stage).textContent = cfg.n;
      });
      R.$$('[data-t]', stage).forEach((c) => c.addEventListener('change', () => (cfg.types[c.dataset.t] = c.checked)));
      R.$('[data-start]', stage).addEventListener('click', () => {
        const types = Object.keys(cfg.types).filter((k) => cfg.types[k]);
        if (!types.length) return R.toast('Pick at least one question type', 'error');
        start(types);
      });
    }

    function start(types) {
      let pool = cfg.only ? deck.cards.filter((c) => cfg.only.includes(c.id)) : deck.cards;
      const cards = R.sample(pool, cfg.only ? pool.length : cfg.n);
      // Spread the types evenly, then group them like a real test.
      const qs = cards.map((c, k) => R.quiz.make(c, deck, types[k % types.length]));
      const order = { mc: 0, tf: 1, written: 2 };
      qs.sort((a, b) => order[a.type] - order[b.type]);
      const t0 = Date.now();
      const answers = {};
      const sectionName = { mc: 'Multiple choice', tf: 'True or false', written: 'Written' };
      let lastType = null;
      stage.innerHTML = `
        <div class="test-paper">
          <div class="test-title"><h2>${R.esc(deck.title)}</h2><span class="muted">${R.plural(qs.length, 'question')}</span></div>
          ${qs
            .map((q, k) => {
              const head = q.type !== lastType ? `<h3 class="test-section">${sectionName[q.type]}</h3>` : '';
              lastType = q.type;
              let body = '';
              if (q.type === 'mc') body = `<div class="t-choices">${q.choices.map((c, ci) => `<label class="t-choice"><input type="radio" name="q${k}" value="${ci}"><span class="t-letter">${'ABCDEFG'[ci]}</span><span>${fmt(c)}</span></label>`).join('')}</div>`;
              else if (q.type === 'tf') body = `<div class="t-shown">${fmt(q.shown)}</div><div class="t-choices two"><label class="t-choice"><input type="radio" name="q${k}" value="1"><span>True</span></label><label class="t-choice"><input type="radio" name="q${k}" value="0"><span>False</span></label></div>`;
              else body = `<input class="input" name="q${k}" placeholder="${R.esc(q.ask)}" autocomplete="off" spellcheck="false">`;
              return `${head}<div class="t-q" data-k="${k}"><div class="t-num">${k + 1}</div><div class="t-main"><div class="t-label">${R.esc(q.label)}</div><div class="t-prompt">${fmt(q.prompt)}</div>${body}<div class="t-result"></div></div></div>`;
            })
            .join('')}
        </div>
        <div class="test-bar"><span data-answered>0 of ${qs.length} answered</span><button class="btn btn-primary" data-submit>Submit test</button></div>`;
      const paper = R.$('.test-paper', stage);
      const count = () => {
        qs.forEach((q, k) => {
          const el = paper.querySelector(`[name="q${k}"]${q.type === 'written' ? '' : ':checked'}`);
          answers[k] = el ? el.value : '';
        });
        const n = Object.values(answers).filter((v) => v !== '').length;
        R.$('[data-answered]', stage).textContent = `${n} of ${qs.length} answered`;
        return n;
      };
      paper.addEventListener('input', count);
      paper.addEventListener('change', count);
      R.$('[data-submit]', stage).addEventListener('click', async () => {
        const n = count();
        if (n < qs.length && !(await R.confirm('Submit with blanks?', `${qs.length - n} questions are unanswered and will be marked wrong.`, 'Submit'))) return;
        grade(qs, answers, Date.now() - t0);
      });
      window.scrollTo({ top: 0 });
    }

    function grade(qs, answers, ms) {
      let right = 0;
      const missed = [];
      qs.forEach((q, k) => {
        const v = answers[k];
        let ok = false;
        if (v !== '') ok = R.quiz.check(q, q.type === 'mc' ? +v : q.type === 'tf' ? v === '1' : v).ok;
        if (ok) right++;
        else missed.push(q.card.id);
        R.srs.record(q.card, ok);
        const box = paper().querySelector(`[data-k="${k}"]`);
        box.classList.add(ok ? 'ok' : 'bad');
        box.querySelectorAll('input').forEach((x) => (x.disabled = true));
        if (q.type === 'mc') box.querySelectorAll('.t-choice')[q.correct].classList.add('right');
        if (q.type === 'tf') box.querySelectorAll('.t-choice')[q.truth ? 0 : 1].classList.add('right');
        R.$('.t-result', box).innerHTML = ok
          ? `<span class="t-ok">${R.icon('check', 15)} Correct</span>`
          : `<span class="t-bad">${R.icon('x', 15)} ${v === '' ? 'Unanswered' : 'Incorrect'}</span><span class="t-correct">Answer: ${fmt(q.answer)}</span>${q.explain && q.explain !== q.prompt ? `<span class="t-explain">${R.esc(q.explain)}</span>` : ''}`;
      });
      R.store.upsert(deck);
      const pct = Math.round((right / qs.length) * 100);
      const letter = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';
      const msg = pct === 100 ? 'Perfect score!' : pct >= 90 ? 'Outstanding.' : pct >= 75 ? 'Solid work. Review the misses below.' : pct >= 50 ? 'Getting there. Drill the misses and try again.' : 'Keep at it. Learn mode will help these stick.';
      if (pct >= 80) R.confetti();
      R.sound(pct >= 60 ? 'win' : 'bad');
      R.store.setBest(`test:${deck.id}`, pct);
      R.store.addHistory({ type: 'test', deck: deck.id, title: deck.title, score: pct, detail: `${right} of ${qs.length} correct, grade ${letter}` });
      stage.insertAdjacentHTML(
        'afterbegin',
        `<div class="card pad score-card grade-${letter}">
          <div class="score-ring">${R.ring(pct, 120, 10)}<div><strong>${pct}%</strong><span>${right} / ${qs.length}</span></div></div>
          <div class="grow"><div class="score-letter">${letter}</div><h2>${msg}</h2><p class="muted">Finished in ${R.fmtTime(ms)}.${missed.length ? ` You missed ${R.plural(missed.length, 'question')}.` : ''}</p>
          <div class="row gap wrap">
            ${missed.length ? `<a class="btn btn-primary" href="#/deck/${deck.id}/test?cards=${missed.join(',')}">${R.icon('target', 16)} Retest the misses</a>` : ''}
            <button class="btn btn-ghost" data-new>${R.icon('refresh', 16)} New test</button>
            <a class="btn btn-ghost" href="#/deck/${deck.id}">Back to deck</a></div></div>
        </div>`
      );
      R.$('.test-bar', stage).remove();
      R.$('[data-new]', stage).addEventListener('click', () => {
        cfg.only = null;
        const target = `#/deck/${deck.id}/test`;
        if (location.hash === target) R.route();
        else location.hash = target;
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    const paper = () => R.$('.test-paper', stage);

    if (cfg.only) start(Object.keys(cfg.types).filter((k) => cfg.types[k]));
    else setupScreen();
  };
})();
