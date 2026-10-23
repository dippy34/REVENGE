/* Kyrie: shared UI pieces (question card, progress ring, theme, settings). */
(function () {
  const blanked = (s) => R.esc(s).replace(/_{3,}/g, '<span class="blank" aria-label="blank"></span>');

  R.ring = (pct, size = 44, stroke = 4) => {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" class="ring-bg"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>`;
  };

  // Header strip used by every study mode.
  R.modeHeader = (deck, title, icon, right = '') => `
    <div class="mode-head">
      <a class="btn btn-ghost btn-sm" href="#/deck/${deck.id}">${R.icon('left', 16)}<span class="hide-sm">${R.esc(deck.title)}</span></a>
      <div class="mode-title">${R.icon(icon, 18)}<span>${title}</span></div>
      <div class="mode-right">${right}</div>
    </div>`;

  /* One question with answer handling. Calls onDone(correct) when the student moves on. */
  R.ask = (q, mount, { onDone, autoNext = true, showSpeak = true, timed = false } = {}) => {
    let answered = false;
    let verdict = false;
    let timer = null;
    const el = R.h(`
      <div class="q q-${q.type}">
        <div class="q-top">
          <span class="q-label">${R.esc(q.label)}</span>
          ${showSpeak ? `<button class="icon-btn" data-speak title="Read aloud">${R.icon('volume', 16)}</button>` : ''}
        </div>
        <div class="q-prompt ${q.prompt.length > 160 ? 'q-long' : ''}">${blanked(q.prompt)}</div>
        ${q.type === 'tf' ? `<div class="q-shown"><span class="q-label">Answer shown</span><div>${R.esc(q.shown)}</div></div>` : ''}
        <div class="q-ask">${R.esc(q.ask)}</div>
        <div class="q-body"></div>
        <div class="q-feedback" aria-live="polite"></div>
      </div>`);
    const body = R.$('.q-body', el);
    const fb = R.$('.q-feedback', el);

    if (q.type === 'mc') {
      body.innerHTML = `<div class="choices">${q.choices
        .map((c, i) => `<button class="choice" data-i="${i}"><kbd>${i + 1}</kbd><span>${blanked(c)}</span></button>`)
        .join('')}</div>`;
      R.$$('.choice', body).forEach((b) => b.addEventListener('click', () => answer(+b.dataset.i)));
    } else if (q.type === 'tf') {
      body.innerHTML = `<div class="choices two">
        <button class="choice" data-v="1"><kbd>1</kbd><span>True</span></button>
        <button class="choice" data-v="0"><kbd>2</kbd><span>False</span></button></div>`;
      R.$$('.choice', body).forEach((b) => b.addEventListener('click', () => answer(b.dataset.v === '1')));
    } else {
      body.innerHTML = `<form class="written" autocomplete="off">
          <input class="input input-lg" name="a" placeholder="Type your answer" autocapitalize="off" spellcheck="false" />
          <button class="btn btn-primary" type="submit">Check</button>
        </form>
        <button class="link-btn" data-idk>I don't know</button>`;
      const form = R.$('form', body);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = form.a.value.trim();
        if (v) answer(v);
      });
      R.$('[data-idk]', body).addEventListener('click', () => answer(''));
      setTimeout(() => form.a.focus({ preventScroll: true }), 30);
    }

    R.$('[data-speak]', el)?.addEventListener('click', () => R.speak(q.prompt));

    function answer(value) {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      const res = value === '' ? { ok: false } : R.quiz.check(q, value);
      verdict = res.ok;
      R.sound(res.ok ? 'good' : 'bad');
      el.classList.add(res.ok ? 'is-right' : 'is-wrong');

      if (q.type === 'mc') {
        R.$$('.choice', body).forEach((b, i) => {
          b.disabled = true;
          if (i === q.correct) b.classList.add('right');
          else if (i === value) b.classList.add('wrong');
        });
      } else if (q.type === 'tf') {
        R.$$('.choice', body).forEach((b) => {
          b.disabled = true;
          const v = b.dataset.v === '1';
          if (v === q.truth) b.classList.add('right');
          else if (v === value) b.classList.add('wrong');
        });
      } else {
        const input = R.$('input', body);
        input.disabled = true;
        input.classList.add(res.ok ? 'right' : 'wrong');
        R.$('[data-idk]', body).remove();
        R.$('button[type=submit]', body).remove();
      }

      const tfNote = q.type === 'tf' && !q.truth ? `<div class="fb-answer"><span>Correct answer</span>${blanked(q.answer)}</div>` : '';
      const explain = q.explain && q.explain !== q.prompt ? `<div class="fb-explain">${R.esc(q.explain)}</div>` : '';
      if (res.ok) {
        fb.innerHTML = `<div class="fb fb-ok">${R.icon('check', 18)}<div><strong>${['Correct!', 'Nice!', 'Exactly.', 'You got it.'][(Math.random() * 4) | 0]}</strong>
          ${q.type === 'written' && R.norm(value) !== R.norm(q.answer) ? `<div class="fb-answer"><span>Exact answer</span>${R.esc(q.answer)}</div>` : ''}${tfNote}${explain}</div></div>`;
      } else {
        fb.innerHTML = `<div class="fb fb-bad">${R.icon('x', 18)}<div><strong>${value === '' ? "Here's the answer" : res.close ? 'Almost there' : 'Not quite'}</strong>
          ${q.type !== 'tf' || q.truth ? `<div class="fb-answer"><span>Correct answer</span>${blanked(q.answer)}</div>` : tfNote}${explain}
          ${q.type === 'written' && value !== '' ? `<button class="link-btn" data-override>I was right, count it</button>` : ''}</div></div>`;
      }
      fb.insertAdjacentHTML('beforeend', `<div class="fb-actions"><button class="btn btn-primary" data-next>Continue <kbd>Enter</kbd></button></div>`);
      R.$('[data-next]', fb).addEventListener('click', next);
      R.$('[data-override]', fb)?.addEventListener('click', () => {
        verdict = true;
        next();
      });
      if (res.ok && autoNext) timer = setTimeout(next, q.type === 'written' && R.norm(value) !== R.norm(q.answer) ? 1800 : 950);
      else setTimeout(() => R.$('[data-next]', fb)?.focus({ preventScroll: true }), 30);
    }

    let done = false;
    function next() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      destroy();
      onDone?.(verdict);
    }

    function onKey(e) {
      if (e.target.closest?.('input,textarea') && e.key !== 'Enter') return;
      if (!answered) {
        if (q.type === 'mc' && /^[1-9]$/.test(e.key) && +e.key <= q.choices.length) answer(+e.key - 1);
        if (q.type === 'tf' && (e.key === '1' || e.key.toLowerCase() === 't')) answer(true);
        if (q.type === 'tf' && (e.key === '2' || e.key.toLowerCase() === 'f')) answer(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        next();
      }
    }
    // Ignore the Enter that submitted a written answer.
    setTimeout(() => document.addEventListener('keydown', onKey), 0);
    function destroy() {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    }

    mount.innerHTML = '';
    mount.appendChild(el);
    R._ask?.destroy();
    R._ask = { destroy, answer, el, q };
    return R._ask;
  };

  /* ---------- theme ---------- */
  R.applyTheme = () => {
    document.documentElement.setAttribute('data-theme', R.store.settings().theme || 'light');
  };

  /* ---------- settings ---------- */
  R.openSettings = () => (location.hash = '#/settings');
})();
