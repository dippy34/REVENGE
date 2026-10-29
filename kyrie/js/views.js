/* Kyrie: create flow, deck page, print. */
(function () {
  const V = (R.views = R.views || {});
  const KIND_LABEL = { term: 'Term', qa: 'Q&A', cloze: 'Blank', acronym: 'Acronym', list: 'List' };
  R.KIND_LABEL = KIND_LABEL;

  // Standard page header: breadcrumbs, title, subtitle, actions on the right.
  R.pageHead = ({ crumbs = [], title, sub = '', actions = '' }) => `
    <div class="page-head">
      ${crumbs.length ? `<nav class="crumbs">${crumbs.map(([label, href]) => (href ? `<a href="${href}">${R.esc(label)}</a>` : `<span>${R.esc(label)}</span>`)).join(R.icon('chevron', 14))}</nav>` : ''}
      <div class="page-head-row">
        <div class="grow"><h1>${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
      </div>
    </div>`;

  R.bindDrop = function bindDrop(zone, onFiles) {
    const input = R.$('[data-file]', zone);
    zone.addEventListener('click', (e) => {
      if (e.target.closest('button,label,a')) return;
      input.click();
    });
    zone.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === zone) {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      if (input.files.length) onFiles(Array.from(input.files));
      input.value = '';
    });
    let depth = 0;
    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      zone.classList.add('over');
    });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('dragleave', () => {
      if (--depth <= 0) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) onFiles(files);
    });
  };

  R.dropzone = (big = true) => `
    <div class="dropzone ${big ? '' : 'dz-compact'}" data-drop tabindex="0" role="button" aria-label="Upload study material">
      <div class="dz-icon">${R.icon('upload', big ? 24 : 20)}</div>
      <div class="dz-text">
        <div class="dz-title">${big ? 'Upload your study material' : 'Add files'}</div>
        <div class="dz-sub">Drag files here or <span class="link">browse</span>. PDF, Word, PowerPoint, photos, text or CSV.</div>
      </div>
      <input type="file" multiple accept="${R.parse.accept}" hidden data-file>
    </div>`;

  // Dropping files anywhere on the page starts a new deck.
  R.bindGlobalDrop = () => {
    let over = false;
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        if (!over) document.body.classList.add('dragging');
        over = true;
      }
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) {
        over = false;
        document.body.classList.remove('dragging');
      }
    });
    window.addEventListener('drop', (e) => {
      over = false;
      document.body.classList.remove('dragging');
      if (e.defaultPrevented) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      e.preventDefault();
      if (R.onFilesDropped) R.onFilesDropped(files);
      else {
        R.pending = { files };
        location.hash = '#/new';
      }
    });
  };

  /* ================= CREATE ================= */

  V.create = (root, params) => {
    const into = params.into ? R.store.deck(params.into) : null;
    const pending = R.pending || { files: [] };
    R.pending = null;
    const sources = []; // { id, name, status, text, images, deck, note, error }
    const st = {
      title: into ? into.title : '',
      subject: params.subject || '',
      engine: 'local',
      count: 'auto',
      focus: '',
      text: '',
      busy: false,
      result: null,
      abort: null,
    };

    root.innerHTML = `
      ${R.pageHead({
        crumbs: into ? [['Library', '#/library'], [into.title, `#/deck/${into.id}`], ['Add material']] : [['Library', '#/library'], ['New deck']],
        title: into ? 'Add material' : 'New deck',
        sub: into ? `New cards will be added to ${R.esc(into.title)}.` : 'Add your files or paste your notes. Kyrie reads them and writes the cards.',
      })}
      <div class="create" data-stage></div>`;
    const stage = R.$('[data-stage]', root);

    R.onFilesDropped = (files) => addFiles(files);
    R.onLeave = () => {
      R.onFilesDropped = null;
      st.abort?.abort();
    };

    function addFiles(files) {
      if (st.result) return;
      for (const f of files) {
        const s = { id: R.uid(), name: f.name, size: f.size, status: 'reading', text: '', images: [] };
        sources.push(s);
        R.parse
          .file(f, (msg) => {
            s.note = msg;
            drawSources();
          })
          .then((r) => {
            Object.assign(s, r, { status: 'ready' });
            if (!st.title && !r.deck) st.title = guessTitle(r);
            drawSources();
            drawOptions();
          })
          .catch((e) => {
            s.status = 'error';
            s.error = e.message || 'Could not read this file';
            drawSources();
            drawOptions();
          });
      }
      drawSources();
      drawOptions();
    }

    function guessTitle(r) {
      const h = (r.text || '').match(/^#{1,3}\s+(.{3,60})$/m);
      if (h) return h[1].trim();
      return r.name
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // Easter egg: "631" in the paste box opens the 631 site, served by this same server
    // (POST /631 sets the cookie, see server.mjs; it is the only way in). The screen goes black from the box outward
    // and the name decodes itself before the page changes.
    function warp(from) {
      st.text = '';
      from.value = '';
      from.blur();
      const r = from.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'warp';
      el.style.setProperty('--x', `${r.left + r.width / 2}px`);
      el.style.setProperty('--y', `${r.top + r.height / 2}px`);
      el.innerHTML = '<span class="warp-name" aria-hidden="true"></span>';
      document.body.append(el);
      const name = el.firstChild;
      const target = '631cb8a9';
      const hex = '0123456789abcdef';
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const start = performance.now();
      const opened = fetch('/631', { method: 'POST', credentials: 'same-origin' }).then((r) => r.ok, () => false);
      const tick = setInterval(() => {
        const locked = ((performance.now() - start - 450) / 650) * target.length; // left to right
        name.textContent = [...target].map((c, i) => (i < locked ? c : hex[(Math.random() * 16) | 0])).join('');
      }, 40);
      // Coming back with the back button restores this page from cache: drop the overlay.
      addEventListener('pageshow', () => el.remove(), { once: true });
      setTimeout(() => {
        opened.then((ok) => {
          clearInterval(tick);
          if (ok) return location.assign('/');
          el.remove(); // the server said no (or is not running the site): stay on Kyrie
        });
      }, reduced ? 300 : 1500);
    }

    function drawInput() {
      stage.innerHTML = `
        <div class="create-main">
          <section class="panel">
            <div class="panel-head"><h2>Material</h2><span class="muted small" data-total></span></div>
            <div class="panel-body">
              ${R.dropzone(false)}
              <div class="sources" data-sources></div>
              <div class="field mt">
                <span>Or paste text</span>
                <textarea class="input textarea" data-text placeholder="Paste notes, a study guide, an article, or a vocabulary list (one &quot;term: definition&quot; per line)">${R.esc(st.text)}</textarea>
              </div>
            </div>
          </section>
          <section class="panel tips">
            <div class="panel-head"><h2>Tips for better cards</h2></div>
            <ul class="tip-list">
              <li><strong>Vocabulary lists work best.</strong> One term per line, like <code>Osmosis: movement of water across a membrane</code>.</li>
              <li><strong>Headings help.</strong> A heading followed by bullet points becomes a "name them" card.</li>
              <li><strong>Q&amp;A is kept as is.</strong> A question on one line and its answer on the next becomes a card.</li>
              <li><strong>Photos of handwriting</strong> read best with Claude as the card maker.</li>
            </ul>
          </section>
        </div>
        <aside class="create-side" data-options></aside>`;
      R.bindDrop(R.$('[data-drop]', stage), addFiles);
      const ta = R.$('[data-text]', stage);
      ta.addEventListener('input', () => {
        if (ta.value.trim() === '631') return warp(ta);
        st.text = ta.value;
        drawTotal();
        drawOptions();
      });
      drawSources();
      drawOptions();
    }

    function drawTotal() {
      const n = sources.reduce((t, s) => t + (s.text?.length || 0), 0) + st.text.length;
      const el = R.$('[data-total]', stage);
      if (el) el.textContent = n ? `${n.toLocaleString()} characters` : '';
    }

    function drawSources() {
      drawTotal();
      const box = R.$('[data-sources]', stage);
      if (!box) return;
      box.innerHTML = sources
        .map(
          (s) => `<div class="source ${s.status}">
          <div class="source-ic">${R.icon(s.images?.length && !s.text ? 'image' : 'file', 18)}</div>
          <div class="source-main"><div class="source-name">${R.esc(s.name)}</div>
            <div class="source-sub">${
              s.status === 'reading'
                ? `<span class="spinner sm"></span> ${R.esc(s.note || 'Reading...')}`
                : s.status === 'error'
                ? R.esc(s.error)
                : s.deck
                ? `Kyrie deck · ${R.esc(s.note)}`
                : [s.note, s.text ? `${s.text.length.toLocaleString()} characters` : s.images?.length ? 'ready to read' : 'no text found'].filter(Boolean).join(' · ')
            }</div></div>
          ${s.status === 'ready' ? `<span class="source-ok">${R.icon('check', 16)}</span>` : ''}
          <button class="icon-btn" data-rm="${s.id}" aria-label="Remove">${R.icon('x', 16)}</button>
        </div>`
        )
        .join('');
      R.$$('[data-rm]', box).forEach((b) =>
        b.addEventListener('click', () => {
          const i = sources.findIndex((s) => s.id === b.dataset.rm);
          if (i >= 0) sources.splice(i, 1);
          drawSources();
          drawOptions();
        })
      );
    }

    function drawOptions() {
      const box = R.$('[data-options]', stage);
      if (!box) return;
      const ready = sources.filter((s) => s.status === 'ready');
      const reading = sources.some((s) => s.status === 'reading');
      const hasImages = ready.some((s) => s.images?.length);
      const hasContent = ready.some((s) => s.text || s.images?.length || s.deck) || st.text.trim().length > 20;
      const aiOn = R.ai.enabled();
      const subjects = R.store.subjects();
      box.innerHTML = `
        <section class="panel sticky">
          <div class="panel-head"><h2>Deck settings</h2></div>
          <div class="panel-body">
            ${
              into
                ? ''
                : `<label class="field"><span>Name</span><input class="input" data-title placeholder="e.g. Biology Unit 3" value="${R.esc(st.title)}"></label>
            <label class="field"><span>Subject <em class="muted">(optional)</em></span><input class="input" data-subject list="subject-list" placeholder="e.g. Biology" value="${R.esc(st.subject)}">
              <datalist id="subject-list">${subjects.map((x) => `<option value="${R.esc(x)}">`).join('')}</datalist></label>`
            }
            <div class="field"><span>Card maker</span>
              <div class="engine">
                <button class="engine-opt ${st.engine === 'local' ? 'on' : ''}" data-engine="local">
                  <span class="radio"></span><div><div class="engine-top">Built-in</div><div class="engine-sub">Free, private, works offline.</div></div></button>
                <button class="engine-opt ${st.engine === 'ai' ? 'on' : ''}" data-engine="ai">
                  <span class="radio"></span><div><div class="engine-top">Claude</div><div class="engine-sub">${aiOn ? 'Best for messy notes and handwriting, with harder quiz options.' : 'Not available on this site right now.'}</div></div></button>
              </div>
            </div>
            <div class="field"><span>Number of cards</span>
              <div class="seg">${['auto', 10, 25, 50, 100].map((n) => `<button class="seg-btn ${st.count === n ? 'on' : ''}" data-count="${n}">${n === 'auto' ? 'Auto' : n}</button>`).join('')}</div>
            </div>
            ${st.engine === 'ai' ? `<label class="field"><span>Focus on <em class="muted">(optional)</em></span><input class="input" data-focus placeholder="e.g. dates and people, chapter 4 only" value="${R.esc(st.focus)}"></label>` : ''}
            ${hasImages && st.engine === 'local' ? `<p class="note">${R.icon('info', 15)} Photos and scanned pages are read with on-device text recognition. Claude reads them more accurately.</p>` : ''}
            <button class="btn btn-primary btn-lg w100" data-go ${!hasContent || reading || st.busy ? 'disabled' : ''}>
              ${st.busy ? '<span class="spinner"></span> Working...' : reading ? '<span class="spinner"></span> Reading files...' : 'Create cards'}</button>
            <div class="progress-note" data-progress>${!hasContent && !reading ? 'Add a file or paste some text to start.' : ''}</div>
          </div>
        </section>`;
      R.$('[data-title]', box)?.addEventListener('input', (e) => (st.title = e.target.value));
      R.$('[data-subject]', box)?.addEventListener('input', (e) => (st.subject = e.target.value));
      R.$('[data-focus]', box)?.addEventListener('input', (e) => (st.focus = e.target.value));
      R.$$('[data-engine]', box).forEach((b) =>
        b.addEventListener('click', () => {
          if (b.dataset.engine === 'ai' && !R.ai.enabled()) return R.toast('Claude is not available on this site right now. The built-in card maker still works.', 'info', 4500);
          st.engine = b.dataset.engine;
          R.store.setSettings({ engine: st.engine });
          drawOptions();
        })
      );
      R.$$('[data-count]', box).forEach((b) =>
        b.addEventListener('click', () => {
          st.count = b.dataset.count === 'auto' ? 'auto' : +b.dataset.count;
          drawOptions();
        })
      );
      R.$('[data-go]', box).addEventListener('click', run);
    }

    const progress = (msg) => {
      const p = R.$('[data-progress]', stage);
      if (p) p.textContent = msg;
    };

    async function run() {
      const ready = sources.filter((s) => s.status === 'ready');
      const decks = ready.filter((s) => s.deck);
      const material = ready.filter((s) => !s.deck);
      if (st.text.trim()) material.push({ name: 'Pasted text', text: st.text });

      // Imported Kyrie decks skip generation.
      if (decks.length && !material.some((m) => m.text || m.images?.length)) {
        let last;
        for (const s of decks) {
          if (into) {
            into.cards.push(...s.deck.cards.map((c) => R.newCard({ ...c, id: R.uid(), s: null })));
            R.store.upsert(into);
            last = into;
          } else last = R.store.upsert(R.newDeck(s.deck.title, s.deck.cards.map((c) => ({ ...c, s: null })), [], s.deck.subject || st.subject));
        }
        R.toast('Deck imported', 'ok');
        location.hash = `#/deck/${last.id}`;
        return;
      }

      st.busy = true;
      drawOptions();
      try {
        let result;
        if (st.engine === 'ai' && R.ai.enabled()) {
          st.abort = new AbortController();
          result = await R.ai.generate(material, { count: st.count, focus: st.focus, status: progress, signal: st.abort.signal });
        } else {
          let text = material.map((m) => m.text).filter(Boolean).join('\n\n');
          const imgs = material.flatMap((m) => m.images || []);
          if (imgs.length) text += '\n\n' + (await R.parse.ocr(imgs, progress));
          progress('Finding key ideas');
          await new Promise((r) => setTimeout(r, 30));
          result = R.gen.generate(text, { max: st.count === 'auto' ? 0 : st.count, fallbackTitle: st.title });
        }
        for (const s of decks) result.cards.push(...s.deck.cards.map((c) => R.newCard({ ...c, id: R.uid(), s: null })));
        if (!result.cards.length) throw new Error("Couldn't find anything to make cards from. Try adding more text, or use a vocabulary list like \"term: definition\".");
        if (!st.title) st.title = result.title;
        st.result = result;
        drawReview();
      } catch (e) {
        if (e.name !== 'AbortError') R.toast(e.message || 'Something went wrong', 'error', 7000);
      }
      st.busy = false;
      st.abort = null;
      if (!st.result) drawOptions();
    }

    function drawReview() {
      const cards = st.result.cards;
      const counts = () => cards.reduce((m, c) => ((m[c.kind] = (m[c.kind] || 0) + 1), m), {});
      stage.innerHTML = `
        <div class="review">
          <div class="review-bar panel">
            <div class="grow">
              <h2 data-count>${R.plural(cards.length, 'card')} ready to review</h2>
              <div class="muted small" data-kinds></div>
            </div>
            <button class="btn btn-ghost" data-back>${R.icon('left', 16)} Back</button>
            <button class="btn btn-primary" data-save>${into ? 'Add to deck' : 'Save deck'}</button>
          </div>
          ${
            into
              ? ''
              : `<div class="review-fields"><label class="field"><span>Name</span><input class="input" data-title value="${R.esc(st.title)}"></label>
              <label class="field"><span>Subject</span><input class="input" data-subject list="subject-list2" value="${R.esc(st.subject)}" placeholder="Optional">
              <datalist id="subject-list2">${R.store.subjects().map((x) => `<option value="${R.esc(x)}">`).join('')}</datalist></label></div>`
          }
          <div class="edit-table">
            <div class="edit-head"><span>#</span><span>Front</span><span>Back</span><span>Type</span><span></span></div>
            <div data-list></div>
          </div>
          <button class="btn btn-ghost" data-add>${R.icon('plus', 16)} Add a card</button>
        </div>`;
      const list = R.$('[data-list]', stage);
      const header = () => {
        R.$('[data-count]', stage).textContent = `${R.plural(cards.length, 'card')} ready to review`;
        R.$('[data-kinds]', stage).textContent = Object.entries(counts())
          .map(([k, n]) => `${n} ${KIND_LABEL[k] || k}`)
          .join(' · ') + '. Edit anything before you save.';
      };
      const draw = () => {
        list.innerHTML = cards
          .map(
            (c, i) => `<div class="edit-row" data-i="${i}">
            <div class="edit-n">${i + 1}</div>
            <textarea class="input autosize" data-f="front" rows="1" placeholder="Front">${R.esc(c.front)}</textarea>
            <textarea class="input autosize" data-f="back" rows="1" placeholder="Back">${R.esc(c.back)}</textarea>
            <span class="chip">${KIND_LABEL[c.kind] || c.kind}</span>
            <button class="icon-btn" data-del aria-label="Delete card">${R.icon('trash', 16)}</button>
          </div>`
          )
          .join('');
        R.$$('.autosize', list).forEach(autosize);
        header();
      };
      draw();
      list.addEventListener('input', (e) => {
        const row = e.target.closest('[data-i]');
        if (!row || !e.target.dataset.f) return;
        cards[+row.dataset.i][e.target.dataset.f] = e.target.value;
        autosize(e.target);
      });
      list.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (!del) return;
        cards.splice(+del.closest('[data-i]').dataset.i, 1);
        draw();
      });
      R.$('[data-title]', stage)?.addEventListener('input', (e) => (st.title = e.target.value));
      R.$('[data-subject]', stage)?.addEventListener('input', (e) => (st.subject = e.target.value));
      R.$('[data-add]', stage).addEventListener('click', () => {
        cards.push(R.newCard({ front: '', back: '', kind: 'term' }));
        draw();
        R.$$('[data-f="front"]', list).pop().focus();
      });
      R.$('[data-back]', stage).addEventListener('click', () => {
        st.result = null;
        drawInput();
      });
      R.$('[data-save]', stage).addEventListener('click', () => {
        const good = cards.filter((c) => c.front.trim() && c.back.trim()).map((c) => ({ ...c, front: c.front.trim(), back: c.back.trim() }));
        if (!good.length) return R.toast('Add at least one card with both sides filled in', 'error');
        const srcs = sources.filter((s) => s.status === 'ready').map((s) => ({ name: s.name, size: s.size || 0 }));
        if (st.text.trim()) srcs.push({ name: 'Pasted text', size: st.text.length });
        let deck;
        if (into) {
          into.cards.push(...good.map(R.newCard));
          into.sources = [...(into.sources || []), ...srcs];
          deck = R.store.upsert(into);
          R.toast(`Added ${R.plural(good.length, 'card')}`, 'ok');
        } else {
          deck = R.store.upsert(R.newDeck(st.title.trim() || st.result.title, good, srcs, st.subject.trim()));
          R.toast('Deck saved', 'ok');
        }
        R.store.saveNow();
        location.hash = `#/deck/${deck.id}`;
      });
    }

    drawInput();
    if (pending.files?.length) addFiles(pending.files);
    // Default to Claude once we know the site has it (unless the student picked the built-in maker).
    R.ai.ready.then(() => {
      if (R.ai.enabled() && R.store.settings().engine !== 'local' && !st.busy && !st.result) st.engine = 'ai';
      if (!st.result) drawOptions();
    });
  };

  function autosize(t) {
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 2 + 'px';
  }

  /* ================= DECK ================= */

  const MODES = [
    { id: 'flash', icon: 'cards', title: 'Flashcards', desc: 'Flip cards and rate yourself. Reviews are scheduled for you.' },
    { id: 'learn', icon: 'learn', title: 'Learn', desc: 'Multiple choice first, then typed answers, until it sticks.' },
    { id: 'test', icon: 'test', title: 'Practice test', desc: 'A graded test with mixed question types.' },
    { id: 'sprint', icon: 'clock', title: 'Sprint', desc: 'Type answers against the clock. Streaks add time.', game: true },
    { id: 'match', icon: 'grid', title: 'Match', desc: 'Pair every term with its answer against the clock.', game: true },
    { id: 'comet', icon: 'rocket', title: 'Comet Run', desc: 'Dodge comets. Crash and you have to answer a question.', game: true },
    { id: 'blitz', icon: 'zap', title: 'Lightning', desc: '60 seconds of true or false. Keep your streak alive.', game: true },
  ];
  R.MODES = MODES;

  V.deck = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    R.store.touch(deck);
    const s = R.srs.summary(deck);
    const tab = ['study', 'cards', 'activity'].includes(params.tab) ? params.tab : 'study';
    const filter = { q: '', show: 'all' };

    root.innerHTML = `
      ${R.pageHead({
        crumbs: [['Library', '#/library'], ...(deck.subject ? [[deck.subject, `#/library?subject=${encodeURIComponent(deck.subject)}`]] : []), [deck.title]],
        title: R.esc(deck.title),
        sub: `${R.plural(s.total, 'card')} · Created ${new Date(deck.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${deck.sources?.length ? ` · From ${R.esc(deck.sources.slice(0, 2).map((x) => x.name).join(', '))}${deck.sources.length > 2 ? ` and ${deck.sources.length - 2} more` : ''}` : ''}`,
        actions: `
          <a class="btn btn-ghost" href="#/new?into=${deck.id}">${R.icon('plus', 16)} Add material</a>
          <div class="menu-wrap">
            <button class="btn btn-ghost btn-icon" data-menu aria-label="More options">${R.icon('dots', 18)}</button>
            <div class="menu" data-menu-list hidden>
              <button data-act="details">${R.icon('edit', 16)} Rename or change subject</button>
              <button data-act="export">${R.icon('download', 16)} Export deck file</button>
              <button data-act="csv">${R.icon('file', 16)} Export as text (Quizlet, Anki)</button>
              <button data-act="print">${R.icon('print', 16)} Print cards</button>
              <hr>
              <button data-act="reset">${R.icon('refresh', 16)} Reset progress</button>
              <button data-act="delete" class="danger">${R.icon('trash', 16)} Delete deck</button>
            </div>
          </div>
          <a class="btn btn-primary" href="#/deck/${deck.id}/${s.due ? 'flash?due=1' : 'learn'}">${s.due ? `Review ${s.due} due` : s.new === s.total ? 'Start studying' : 'Keep studying'}</a>`,
      })}

      <div class="kpis">
        <div class="kpi"><div class="kpi-l">Mastery</div><div class="kpi-n">${s.pct}%</div>
          <div class="bar"><i class="m" style="width:${(s.mastered / Math.max(1, s.total)) * 100}%"></i><i class="l" style="width:${(s.learning / Math.max(1, s.total)) * 100}%"></i></div></div>
        <div class="kpi"><div class="kpi-l"><i class="dot m"></i>Mastered</div><div class="kpi-n">${s.mastered}</div></div>
        <div class="kpi"><div class="kpi-l"><i class="dot l"></i>Learning</div><div class="kpi-n">${s.learning}</div></div>
        <div class="kpi"><div class="kpi-l"><i class="dot n"></i>Not started</div><div class="kpi-n">${s.new}</div></div>
        <div class="kpi"><div class="kpi-l">${R.icon('clock', 14)} Due now</div><div class="kpi-n">${s.due}</div></div>
      </div>

      <div class="tabs" role="tablist">
        ${[['study', 'Study'], ['cards', `Cards <span class="tab-n">${s.total}</span>`], ['activity', 'Activity']]
          .map(([k, l]) => `<a class="tab ${tab === k ? 'on' : ''}" href="#/deck/${deck.id}?tab=${k}" role="tab">${l}</a>`)
          .join('')}
      </div>
      <div data-tab></div>`;

    const body = R.$('[data-tab]', root);

    if (tab === 'study') {
      body.innerHTML = `
        <h3 class="group-title">Study</h3>
        <div class="mode-grid">${MODES.filter((m) => !m.game).map(modeTile).join('')}</div>
        <h3 class="group-title">Games</h3>
        <div class="mode-grid four">${MODES.filter((m) => m.game).map(modeTile).join('')}</div>`;
    } else if (tab === 'cards') {
      body.innerHTML = `
        <div class="toolbar">
          <div class="seg seg-sm" data-show>
            ${[['all', 'All'], ['starred', 'Starred'], ['hard', 'Struggling'], ['new', 'Not started']].map(([k, l]) => `<button class="seg-btn ${k === 'all' ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}
          </div>
          <div class="search">${R.icon('search', 16)}<input class="input" placeholder="Search cards" data-q></div>
          <button class="btn btn-ghost" data-addcard>${R.icon('plus', 16)} New card</button>
        </div>
        <div class="table card-table">
          <div class="tr th"><span></span><span>Front</span><span>Back</span><span>Type</span><span>Status</span><span></span></div>
          <div data-cards></div>
        </div>`;
      const listEl = R.$('[data-cards]', body);
      const drawCards = () => {
        const q = filter.q.toLowerCase();
        const list = deck.cards.filter((c) => {
          if (q && !(c.front + ' ' + c.back).toLowerCase().includes(q)) return false;
          if (filter.show === 'starred') return c.starred;
          if (filter.show === 'hard') return c.s.lapses > 0 && R.srs.state(c) !== 'mastered';
          if (filter.show === 'new') return !c.s.seen;
          return true;
        });
        const stateLabel = { new: 'Not started', learning: 'Learning', mastered: 'Mastered' };
        listEl.innerHTML = list.length
          ? list
              .map((c) => {
                const stt = R.srs.state(c);
                return `<div class="tr" data-id="${c.id}">
              <button class="icon-btn sm ${c.starred ? 'starred' : ''}" data-star aria-label="Star">${R.icon('star', 15)}</button>
              <span class="td-front">${R.esc(c.front).replace(/_{3,}/g, '<span class="blank sm"></span>')}</span>
              <span class="td-back">${R.esc(c.back)}</span>
              <span><span class="chip">${KIND_LABEL[c.kind] || c.kind}</span></span>
              <span class="status ${stt}"><i class="dot ${stt[0]}"></i>${stateLabel[stt]}</span>
              <button class="icon-btn sm" data-edit aria-label="Edit">${R.icon('edit', 15)}</button>
            </div>`;
              })
              .join('')
          : `<div class="empty-small">${filter.show === 'starred' ? 'No starred cards yet. Star the ones you want to drill, then study them from Flashcards.' : 'No cards match.'}</div>`;
      };
      drawCards();
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-id]');
        if (!row) return;
        const card = deck.cards.find((c) => c.id === row.dataset.id);
        if (e.target.closest('[data-star]')) {
          card.starred = !card.starred;
          R.store.upsert(deck);
          drawCards();
        } else if (e.target.closest('[data-edit]')) editCard(deck, card, drawCards);
      });
      R.$('[data-q]', body).addEventListener('input', (e) => {
        filter.q = e.target.value;
        drawCards();
      });
      R.$$('[data-show] .seg-btn', body).forEach((b) =>
        b.addEventListener('click', () => {
          filter.show = b.dataset.v;
          R.$$('[data-show] .seg-btn', body).forEach((x) => x.classList.toggle('on', x === b));
          drawCards();
        })
      );
      R.$('[data-addcard]', body).addEventListener('click', () => editCard(deck, null, () => R.route()));
    } else {
      const hist = R.store.history().filter((h) => h.deck === deck.id);
      const best = [
        ['Practice test', R.store.best(`test:${deck.id}`), (v) => `${v}%`],
        ['Sprint', R.store.best(`sprint:${deck.id}`), (v) => `${v.toLocaleString()} pts`],
        ['Match', R.store.best(`match:${deck.id}`), (v) => R.fmtTime(v)],
        ['Comet Run', R.store.best(`comet:${deck.id}`), (v) => v.toLocaleString()],
        ['Lightning', R.store.best(`blitz:${deck.id}`), (v) => `${v} pts`],
      ];
      const hardest = deck.cards.filter((c) => c.s.lapses).sort((a, b) => b.s.lapses - a.s.lapses).slice(0, 6);
      body.innerHTML = `
        <div class="two-col">
          <section class="panel">
            <div class="panel-head"><h2>Recent sessions</h2></div>
            ${hist.length ? `<div class="feed">${hist.slice(0, 15).map(R.feedItem).join('')}</div>` : '<div class="empty-small">No sessions yet. Finish a study mode or game and it shows up here.</div>'}
          </section>
          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>Personal bests</h2></div>
              <div class="best-list">${best.map(([l, v, f]) => `<div class="best"><span>${l}</span><strong>${v == null ? '<span class="muted">-</span>' : f(v)}</strong></div>`).join('')}</div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Hardest cards</h2></div>
              ${hardest.length ? `<div class="hard-list">${hardest.map((c) => `<div class="hard"><span>${R.esc(c.front).replace(/_{3,}/g, '____')}</span><span class="chip chip-due">${R.plural(c.s.lapses, 'miss', 'misses')}</span></div>`).join('')}</div>` : '<div class="empty-small">Nothing missed yet.</div>'}
            </section>
          </div>
        </div>`;
    }

    function modeTile(m) {
      return `<a class="mode-tile" data-tilt="7" href="#/deck/${deck.id}/${m.id}">
        <div class="mode-ic">${R.icon(m.icon, 20)}</div>
        <div class="grow"><h3>${m.title}</h3><p>${m.desc}</p></div>
        ${R.icon('chevron', 18, 'mode-chev')}</a>`;
    }

    const menuBtn = R.$('[data-menu]', root);
    const menu = R.$('[data-menu-list]', root);
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    const closeMenu = () => (menu.hidden = true);
    document.addEventListener('click', closeMenu);
    R.onLeave = () => document.removeEventListener('click', closeMenu);
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      menu.hidden = true;
      const fname = deck.title.replace(/[^\w\- ]+/g, '').trim() || 'deck';
      if (act === 'details') editDetails(deck);
      if (act === 'export') R.download(`${fname}.kyrie.json`, JSON.stringify({ kyrie: 1, title: deck.title, subject: deck.subject || '', cards: deck.cards.map(({ s, ...c }) => c) }, null, 1));
      if (act === 'csv') R.download(`${fname}.txt`, deck.cards.map((c) => `${c.front.replace(/\s+/g, ' ')}\t${c.back.replace(/\s+/g, ' ')}`).join('\n'), 'text/plain');
      if (act === 'print') location.hash = `#/deck/${deck.id}/print`;
      if (act === 'reset' && (await R.confirm('Reset progress?', 'Every card goes back to "not started". Your cards are kept.', 'Reset'))) {
        deck.cards.forEach((c) => (c.s = R.newCard({}).s));
        R.store.upsert(deck);
        R.route();
      }
      if (act === 'delete' && (await R.confirm(`Delete "${deck.title}"?`, `This removes the deck and its ${deck.cards.length} cards from this browser. Export it first if you might want it back.`))) {
        R.store.remove(deck.id);
        R.toast('Deck deleted');
        location.hash = '#/library';
      }
    });
  };

  function editDetails(deck) {
    const m = R.modal(`
      <div class="modal-head"><h3 class="modal-title">Deck details</h3><button class="icon-btn" data-close aria-label="Close">${R.icon('x')}</button></div>
      <label class="field"><span>Name</span><input class="input" data-name value="${R.esc(deck.title)}"></label>
      <label class="field"><span>Subject</span><input class="input" data-subject list="subj-dl" value="${R.esc(deck.subject || '')}" placeholder="e.g. History">
        <datalist id="subj-dl">${R.store.subjects().map((x) => `<option value="${R.esc(x)}">`).join('')}</datalist></label>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save</button></div>`);
    R.$('[data-ok]', m.el).addEventListener('click', () => {
      const name = R.$('[data-name]', m.el).value.trim();
      if (!name) return R.toast('Give the deck a name', 'error');
      deck.title = name;
      deck.subject = R.$('[data-subject]', m.el).value.trim();
      R.store.upsert(deck);
      m.close();
      R.route();
    });
  }

  function editCard(deck, card, after) {
    const isNew = !card;
    const c = card || R.newCard({ front: '', back: '', kind: 'term' });
    const m = R.modal(`
      <div class="modal-head"><h3 class="modal-title">${isNew ? 'New card' : 'Edit card'}</h3><button class="icon-btn" data-close aria-label="Close">${R.icon('x')}</button></div>
      <label class="field"><span>Front <em class="muted">(term, question, or a sentence with _____ for a blank)</em></span><textarea class="input textarea sm" data-f="front">${R.esc(c.front)}</textarea></label>
      <label class="field"><span>Back <em class="muted">(the answer)</em></span><textarea class="input textarea sm" data-f="back">${R.esc(c.back)}</textarea></label>
      <label class="field"><span>Explanation <em class="muted">(optional, shown after answering)</em></span><input class="input" data-f="explain" value="${R.esc(c.explain)}"></label>
      <div class="modal-actions">
        ${isNew ? '' : `<button class="btn btn-ghost danger mr-auto" data-del>${R.icon('trash', 16)} Delete</button>`}
        <button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save</button>
      </div>`);
    setTimeout(() => R.$('[data-f="front"]', m.el).focus(), 50);
    R.$('[data-ok]', m.el).addEventListener('click', () => {
      const front = R.$('[data-f="front"]', m.el).value.trim();
      const back = R.$('[data-f="back"]', m.el).value.trim();
      if (!front || !back) return R.toast('Fill in both sides', 'error');
      c.front = front;
      c.back = back;
      c.explain = R.$('[data-f="explain"]', m.el).value.trim();
      c.kind = /_{3,}/.test(front) ? 'cloze' : /\?$/.test(front) ? 'qa' : c.kind === 'cloze' ? 'term' : c.kind;
      if (!/_{3,}/.test(front)) c.distractors = c.kind === 'cloze' ? [] : c.distractors;
      if (isNew) deck.cards.push(c);
      R.store.upsert(deck);
      m.close();
      after?.();
    });
    R.$('[data-del]', m.el)?.addEventListener('click', () => {
      deck.cards = deck.cards.filter((x) => x.id !== c.id);
      R.store.upsert(deck);
      m.close();
      R.route();
    });
  }

  /* ================= PRINT ================= */

  V.print = (root, params) => {
    const deck = R.store.deck(params.id);
    if (!deck) return V.notFound(root);
    root.innerHTML = `
      <div class="no-print">${R.pageHead({
        crumbs: [['Library', '#/library'], [deck.title, `#/deck/${deck.id}`], ['Print']],
        title: 'Print cards',
        sub: 'Print and cut along the dashed lines, or fold each row down the middle so the answer is on the back.',
        actions: `<button class="btn btn-primary" onclick="window.print()">${R.icon('print', 16)} Print</button>`,
      })}</div>
      <h1 class="print-title">${R.esc(deck.title)}</h1>
      <div class="print-grid">${deck.cards
        .map((c) => `<div class="print-card"><div class="pc-f">${R.esc(c.front).replace(/_{3,}/g, '________')}</div><div class="pc-b">${R.esc(c.back)}</div></div>`)
        .join('')}</div>`;
  };

  V.notFound = (root) => {
    root.innerHTML = `<div class="empty"><h2>Deck not found</h2><p class="muted">It may have been deleted, or it was made in a different browser.</p><a class="btn btn-primary" href="#/library">Go to library</a></div>`;
  };

  V.editCard = editCard;
})();
