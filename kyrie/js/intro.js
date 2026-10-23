/* Kyrie: the intro page and the first-run tour. Neither saves any study data. */
(function () {
  const V = (R.views = R.views || {});
  const I = (name, size = 20) => R.icon(name, size);

  const DEMO = [
    ['Photosynthesis', 'How plants turn light into chemical energy'],
    ['Mitochondria', 'Where cellular respiration produces ATP'],
    ['Treaty of Paris', 'The 1783 agreement that ended the Revolutionary War'],
  ];

  // Fade sections in as they scroll into view.
  function reveal(root) {
    const els = R.$$('.reveal', root);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('in'));
      return () => {};
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && (en.target.classList.add('in'), io.unobserve(en.target))),
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }

  // The flashcard in the hero mockup flips on its own.
  function autoFlip(el, ms = 2600) {
    if (!el) return () => {};
    let i = 0;
    let flipped = false;
    const set = () => {
      R.$('.mini-face.front div', el).textContent = DEMO[i][0];
      R.$('.mini-face.back div', el).textContent = DEMO[i][1];
    };
    set();
    const t = setInterval(() => {
      flipped = !flipped;
      el.classList.toggle('flipped', flipped);
      if (!flipped) setTimeout(() => ((i = (i + 1) % DEMO.length), set()), 260);
    }, ms);
    return () => clearInterval(t);
  }

  const cometArt = `
    <svg class="comet-art" viewBox="0 0 320 200" aria-hidden="true">
      <defs><linearGradient id="tail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb923c" stop-opacity="0"/><stop offset="1" stop-color="#fb923c" stop-opacity=".6"/></linearGradient></defs>
      ${Array.from({ length: 34 }, (_, k) => `<circle cx="${(k * 97) % 320}" cy="${(k * 53) % 200}" r="${k % 3 ? 0.8 : 1.4}" fill="#fff" opacity="${0.3 + (k % 4) * 0.15}"/>`).join('')}
      <g class="c1"><path d="M70 -10 L84 34 L56 34 Z" fill="url(#tail)"/><circle cx="70" cy="40" r="13" fill="#94a3b8"/><circle cx="74" cy="38" r="3" fill="#64748b"/></g>
      <g class="c2"><path d="M232 -30 L242 8 L222 8 Z" fill="url(#tail)"/><circle cx="232" cy="14" r="9" fill="#94a3b8"/></g>
      <g class="c3"><path d="M150 -60 L160 -22 L140 -22 Z" fill="url(#tail)"/><circle cx="150" cy="-16" r="10" fill="#94a3b8"/></g>
      <g transform="translate(160 160)"><path d="M0 -20 Q9 -6 14 12 L0 7 L-14 12 Q-9 -6 0 -20Z" fill="#fff"/><ellipse cx="0" cy="-5" rx="3.5" ry="5" fill="#0071e3"/><path d="M-6 12 L0 26 L6 12Z" fill="#fbbf24" class="flame"/></g>
      <g transform="translate(250 120)"><path d="M0 -11 L3 -3 L11 -3 L5 2 L7 10 L0 5 L-7 10 L-5 2 L-11 -3 L-3 -3Z" fill="#fcd34d"/></g>
    </svg>`;

  /* ================= INTRO ================= */

  V.intro = (root) => {
    root.innerHTML = `
      <section class="i-hero">
        <p class="i-eyebrow reveal">Kyrie</p>
        <h1 class="i-title reveal">Study anything.<br><span>Remember everything.</span></h1>
        <p class="i-sub reveal">Turn your notes, slides and textbooks into flashcards, quizzes, practice tests and games. In seconds.</p>
        <div class="i-cta reveal">
          <button class="btn btn-primary btn-pill" data-start>Get started</button>
          <a class="i-more" href="#how" data-scroll="how">See how it works ${I('chevron', 15)}</a>
        </div>
        <div class="hero-stage reveal">
          <div class="float float-a"><div class="float-ic grade">A</div><div><strong>Practice test</strong><span>94% · 47 of 50 correct</span></div></div>
          <div class="float float-b"><div class="float-ic">${I('flame', 18)}</div><div><strong>12-day streak</strong><span>Today's goal is done</span></div></div>
          <div class="device">
            <div class="device-bar"><span class="dots"><i></i><i></i><i></i></span><span class="device-title">Biology · Flashcards</span><span></span></div>
            <div class="device-body">
              <div class="mini-top"><div class="mini-prog"><i></i></div><span>8 / 21</span></div>
              <div class="mini-card"><div class="mini-flip" data-autoflip>
                <div class="mini-face front"><span class="mini-label">Term</span><div></div><em>Tap to flip</em></div>
                <div class="mini-face back"><span class="mini-label">Answer</span><div></div></div>
              </div></div>
              <div class="mini-rate"><span class="again">Again<small>1 min</small></span><span class="hard">Hard<small>12 hr</small></span><span class="good">Good<small>3 days</small></span><span class="easy">Easy<small>1 wk</small></span></div>
            </div>
          </div>
        </div>
      </section>

      <section class="i-band white" id="how">
        <div class="i-wrap">
          <p class="i-kicker reveal">Upload</p>
          <h2 class="i-h2 reveal">Drop it in.<br>Kyrie does the rest.</h2>
          <p class="i-lead reveal">PDFs, Word documents, PowerPoint slides, photos of your notes, or anything you can paste. Kyrie finds the terms, definitions, dates and key ideas, and writes the cards for you.</p>
          <div class="flow reveal">
            <div class="flow-files">
              <div class="file-chip"><b class="pdf">PDF</b><span>Chapter 7 · The Cell.pdf</span></div>
              <div class="file-chip"><b class="ppt">PPT</b><span>Lecture 12 slides.pptx</span></div>
              <div class="file-chip"><b class="doc">DOC</b><span>Study guide.docx</span></div>
              <div class="file-chip"><b class="img">IMG</b><span>Whiteboard photo.jpg</span></div>
            </div>
            <div class="flow-arrow">${I('right', 22)}</div>
            <div class="flow-cards">
              <div class="gen-card"><span>Term</span><strong>Mitochondria</strong><em>Where cellular respiration produces ATP</em></div>
              <div class="gen-card"><span>Fill in the blank</span><strong>Cells divide by _____ to make two identical cells.</strong><em>mitosis</em></div>
              <div class="gen-card"><span>Q&amp;A</span><strong>What does the cell membrane control?</strong><em>What enters and leaves the cell</em></div>
            </div>
          </div>
        </div>
      </section>

      <section class="i-band">
        <div class="i-wrap">
          <p class="i-kicker reveal">Study</p>
          <h2 class="i-h2 reveal">Six ways to learn it.<br>One place to keep it.</h2>
          <div class="bento">
            <div class="btile tile-wide reveal">
              <div class="tile-text"><h3>Flashcards that know when you'll forget.</h3><p>Rate each card and Kyrie schedules the next review. Hard cards come back sooner. Easy ones wait.</p></div>
              <div class="timeline"><span><i></i>1 min</span><span><i></i>1 day</span><span><i></i>3 days</span><span><i></i>1 week</span><span><i></i>1 month</span></div>
            </div>
            <div class="btile reveal">
              <div class="tile-ic">${I('learn', 22)}</div>
              <h3>Learn</h3><p>Starts with multiple choice. Ends with you typing the answer from memory.</p>
            </div>
            <div class="btile reveal">
              <div class="score-mini"><strong>94%</strong><span>Grade A</span></div>
              <h3>Practice tests</h3><p>Mixed questions, graded the moment you finish, with every answer explained.</p>
            </div>
            <div class="btile tile-dark tile-wide reveal">
              <div class="tile-text"><h3>Crash, then answer.</h3><p>In Comet Run, every crash is a question. Get it right and you keep flying.</p></div>
              ${cometArt}
            </div>
            <div class="btile reveal">
              <div class="tile-ic">${I('zap', 22)}</div>
              <h3>Match and Lightning</h3><p>Race the clock pairing terms, or survive 60 seconds of true or false.</p>
            </div>
            <div class="btile reveal">
              <div class="tile-ic">${I('shield', 22)}</div>
              <h3>Private by design</h3><p>No account. Your decks and progress stay on your device.</p>
            </div>
            <div class="btile reveal">
              <div class="tile-ic">${I('image', 22)}</div>
              <h3>Reads your handwriting</h3><p>With Claude as the card maker, even messy notes and photos become clean cards.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="i-band white">
        <div class="i-wrap">
          <h2 class="i-h2 center reveal">From notes to studying<br>in three steps.</h2>
          <div class="steps3">
            <div class="reveal"><b>1</b><h3>Add your material</h3><p>Drag in files or paste your notes. Several at once is fine.</p></div>
            <div class="reveal"><b>2</b><h3>Check the cards</h3><p>Edit, delete or add anything before you save the deck.</p></div>
            <div class="reveal"><b>3</b><h3>Study your way</h3><p>Flashcards, quizzes, tests and games, all from the same deck.</p></div>
          </div>
        </div>
      </section>

      <section class="i-final">
        <h2 class="i-h2 reveal">Your next test<br>starts here.</h2>
        <button class="btn btn-primary btn-pill reveal" data-start>Get started</button>
        <p class="i-foot reveal">Free to use. No account needed.</p>
      </section>`;

    const stopReveal = reveal(root);
    const stopFlip = autoFlip(R.$('[data-autoflip]', root));
    R.onLeave = () => {
      stopReveal();
      stopFlip();
    };
    R.$$('[data-start]', root).forEach((b) =>
      b.addEventListener('click', () => {
        R.store.setSettings({ introSeen: true });
        R.tour({ then: '#/new' });
      })
    );
    R.$('[data-scroll]', root).addEventListener('click', (e) => {
      e.preventDefault();
      R.$('#how', root).scrollIntoView({ behavior: 'smooth' });
    });
  };

  /* ================= TOUR ================= */

  const STEPS = [
    {
      title: 'Welcome to Kyrie',
      text: 'A quick look at how it works. It takes less than a minute.',
      art: `<div class="t-logo">${R.logo(64)}</div>`,
    },
    {
      title: 'Add your material',
      text: 'Drop in PDFs, slides, Word documents or photos of your notes, or paste text. You can add several files at once.',
      art: `<div class="t-files">
        <div class="file-chip"><b class="pdf">PDF</b><span>Chapter 7.pdf</span></div>
        <div class="file-chip"><b class="ppt">PPT</b><span>Lecture slides.pptx</span></div>
        <div class="file-chip"><b class="img">IMG</b><span>Notes photo.jpg</span></div></div>`,
    },
    {
      title: 'Check your cards',
      text: 'Kyrie writes the cards. Look them over and fix anything before you save. Try it: tap the card to flip it.',
      art: `<div class="t-card" data-flip tabindex="0" role="button" aria-label="Flip the card"><div class="mini-flip">
        <div class="mini-face front"><span class="mini-label">Term</span><div>Osmosis</div><em>Tap to flip</em></div>
        <div class="mini-face back"><span class="mini-label">Answer</span><div>Water moving across a membrane</div></div></div></div>`,
      mount(el) {
        const card = R.$('[data-flip]', el);
        const flip = () => {
          R.$('.mini-flip', card).classList.toggle('flipped');
          R.sound('flip');
        };
        card.addEventListener('click', flip);
        card.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), flip()));
      },
    },
    {
      title: 'Quiz yourself',
      text: 'Learn mode and practice tests turn your cards into questions. Give this one a try.',
      art: `<div class="t-quiz"><div class="t-q">Which organelle produces most of a cell's energy?</div>
        <div class="t-opts">${['Nucleus', 'Mitochondria', 'Ribosome'].map((o, i) => `<button data-o="${i}">${o}</button>`).join('')}</div></div>`,
      mount(el) {
        R.$$('[data-o]', el).forEach((b) =>
          b.addEventListener('click', () => {
            const ok = b.dataset.o === '1';
            R.$$('[data-o]', el).forEach((x) => {
              x.disabled = true;
              if (x.dataset.o === '1') x.classList.add('right');
            });
            if (!ok) b.classList.add('wrong');
            R.sound(ok ? 'good' : 'bad');
            R.$('.t-q', el).textContent = ok ? 'Correct. That is how every question works.' : 'Not quite. Kyrie always shows you the answer.';
          })
        );
      },
    },
    {
      title: 'Mistakes become questions',
      text: 'In Comet Run, dodge the comets and grab the stars. Crash, and you answer a question to keep flying.',
      art: `<div class="t-comet">${cometArt}</div>`,
    },
    {
      title: "You're ready",
      text: 'Kyrie keeps track of what you know and brings cards back right before you would forget them. Make your first deck to begin.',
      art: `<div class="t-ready">${['cards', 'learn', 'test', 'grid', 'rocket', 'zap'].map((i) => `<span>${I(i, 22)}</span>`).join('')}</div>`,
      last: true,
    },
  ];

  R.tour = ({ then } = {}) => {
    let i = 0;
    const wrap = R.h(`<div class="tour-wrap" role="dialog" aria-modal="true" aria-label="Kyrie tour">
      <div class="tour">
        <button class="tour-x" data-x aria-label="Close tour">${I('x', 18)}</button>
        <div class="tour-art" data-art></div>
        <div class="tour-copy"><h2 data-title></h2><p data-text></p></div>
        <div class="tour-foot">
          <div class="tour-dots">${STEPS.map((_, k) => `<i data-dot="${k}"></i>`).join('')}</div>
          <div class="tour-btns"><button class="btn btn-text" data-back>Back</button><button class="btn btn-primary btn-pill-sm" data-next>Continue</button></div>
        </div>
      </div></div>`);
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('in'));

    const draw = (dir = 1) => {
      const s = STEPS[i];
      const art = R.$('[data-art]', wrap);
      art.classList.remove('slide-l', 'slide-r');
      void art.offsetWidth;
      art.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
      art.innerHTML = s.art;
      R.$('[data-title]', wrap).textContent = s.title;
      R.$('[data-text]', wrap).textContent = s.text;
      R.$$('[data-dot]', wrap).forEach((d, k) => d.classList.toggle('on', k === i));
      R.$('[data-back]', wrap).style.visibility = i ? 'visible' : 'hidden';
      R.$('[data-next]', wrap).textContent = s.last ? (then ? 'Make my first deck' : 'Done') : i === 0 ? 'Show me' : 'Continue';
      s.mount?.(art);
    };
    const close = (go) => {
      R.store.setSettings({ tourDone: true });
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.remove('in');
      setTimeout(() => wrap.remove(), 220);
      if (go && then) location.hash = then;
    };
    const next = () => (i === STEPS.length - 1 ? close(true) : ((i += 1), draw(1)));
    const back = () => i > 0 && ((i -= 1), draw(-1));
    const onKey = (e) => {
      if (e.key === 'Escape') close(true);
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    R.$('[data-next]', wrap).addEventListener('click', next);
    R.$('[data-back]', wrap).addEventListener('click', back);
    R.$('[data-x]', wrap).addEventListener('click', () => close(true));
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(true));
    document.addEventListener('keydown', onKey, true);
    draw(1);
    setTimeout(() => R.$('[data-next]', wrap).focus({ preventScroll: true }), 60);
  };
})();
