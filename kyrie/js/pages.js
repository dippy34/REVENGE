/* Kyrie: home, library, progress, settings and help pages. */
(function () {
  const V = (R.views = R.views || {});
  const TYPE = {
    flash: ['cards', 'Flashcards'],
    learn: ['learn', 'Learn'],
    test: ['test', 'Practice test'],
    sprint: ['clock', 'Sprint'],
    match: ['grid', 'Match'],
    comet: ['rocket', 'Comet Run'],
    blitz: ['zap', 'Lightning'],
  };
  const DAY = 86400000;
  const dayKey = (d) => d.toISOString().slice(0, 10);

  R.feedItem = (h) => {
    const [icon, label] = TYPE[h.type] || ['cards', h.type];
    return `<a class="feed-item" href="#/deck/${h.deck}">
      <div class="feed-ic">${R.icon(icon, 16)}</div>
      <div class="grow"><div class="feed-title">${label} <span class="muted">·</span> ${R.esc(h.title)}</div><div class="feed-sub">${R.esc(h.detail || '')}</div></div>
      <div class="feed-time">${R.timeAgo(h.t)}</div></a>`;
  };

  function weekBars() {
    const days = R.store.days();
    const out = [];
    for (let k = 6; k >= 0; k--) {
      const d = new Date(Date.now() - k * DAY);
      out.push({ label: d.toLocaleDateString(undefined, { weekday: 'short' }), n: days[dayKey(d)] || 0, today: k === 0 });
    }
    const max = Math.max(R.store.settings().goal || 20, ...out.map((x) => x.n));
    return `<div class="week">${out
      .map((x) => `<div class="week-col ${x.today ? 'today' : ''}" title="${x.n} reviews"><div class="week-n">${x.n || ''}</div><div class="week-bar"><i style="height:${(x.n / max) * 100}%"></i></div><div class="week-l">${x.label}</div></div>`)
      .join('')}</div>`;
  }

  function longestStreak() {
    const keys = Object.keys(R.store.days()).filter((k) => R.store.days()[k]).sort();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const k of keys) {
      const t = new Date(k + 'T00:00:00Z').getTime();
      run = prev !== null && t - prev === DAY ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    }
    return best;
  }

  const greeting = () => {
    const h = new Date().getHours();
    const name = R.store.settings().name?.trim();
    return `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}${name ? `, ${R.esc(name)}` : ''}`;
  };

  /* ================= HOME ================= */

  V.home = (root) => {
    const decks = R.store.decks();
    if (!decks.length) return welcome(root);

    const sums = decks.map((d) => ({ d, s: R.srs.summary(d) }));
    const tot = sums.reduce((t, { s }) => ((t.cards += s.total), (t.mastered += s.mastered), (t.due += s.due), t), { cards: 0, mastered: 0, due: 0 });
    const goal = R.store.settings().goal || 20;
    const today = R.store.studiedToday();
    const due = sums.filter((x) => x.s.due).sort((a, b) => b.s.due - a.s.due);
    const recent = sums.slice().sort((a, b) => (b.d.opened || b.d.updated) - (a.d.opened || a.d.updated)).slice(0, 4);
    const nextDue = decks.flatMap((d) => d.cards.filter((c) => c.s.seen && c.s.due > Date.now()).map((c) => c.s.due)).sort((a, b) => a - b)[0];
    const hist = R.store.history().slice(0, 6);

    root.innerHTML = `
      ${R.pageHead({
        title: greeting(),
        sub: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
        actions: `<a class="btn btn-primary" href="#/new">${R.icon('plus', 16)} New deck</a>`,
      })}
      <div class="kpis">
        <div class="kpi" data-tilt="8"><div class="kpi-l">${R.icon('target', 14)} Today's goal</div><div class="kpi-n">${today}<span class="kpi-of"> / ${goal}</span></div>
          <div class="bar"><i class="m" style="width:${Math.min(100, (today / goal) * 100)}%"></i></div></div>
        <div class="kpi" data-tilt="8"><div class="kpi-l">${R.icon('flame', 14)} Day streak</div><div class="kpi-n">${R.store.streak()}</div></div>
        <div class="kpi" data-tilt="8"><div class="kpi-l">${R.icon('clock', 14)} Due now</div><div class="kpi-n">${tot.due}</div></div>
        <div class="kpi" data-tilt="8"><div class="kpi-l">${R.icon('trophy', 14)} Mastered</div><div class="kpi-n">${tot.mastered}<span class="kpi-of"> / ${tot.cards}</span></div></div>
      </div>
      <div class="two-col">
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>Due for review</h2>${due.length ? `<span class="muted small">${R.plural(tot.due, 'card')}</span>` : ''}</div>
            ${
              due.length
                ? `<div class="rows">${due
                    .slice(0, 6)
                    .map(
                      ({ d, s }) => `<div class="row-item">
                  <div class="grow"><a class="row-title" href="#/deck/${d.id}">${R.esc(d.title)}</a><div class="row-sub">${d.subject ? `${R.esc(d.subject)} · ` : ''}${R.plural(s.due, 'card')} due</div></div>
                  <a class="btn btn-ghost btn-sm" href="#/deck/${d.id}/flash?due=1">Review</a></div>`
                    )
                    .join('')}</div>`
                : `<div class="empty-small">${R.icon('check', 18)}<div>You're all caught up.${nextDue ? ` Next review ${nextDue - Date.now() < DAY ? 'later today' : `on ${new Date(nextDue).toLocaleDateString(undefined, { weekday: 'long' })}`}.` : ''}</div></div>`
            }
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Continue studying</h2><a class="small" href="#/library">View library</a></div>
            <div class="rows">${recent
              .map(
                ({ d, s }) => `<div class="row-item">
                <div class="grow"><a class="row-title" href="#/deck/${d.id}">${R.esc(d.title)}</a>
                  <div class="row-sub">${d.subject ? `${R.esc(d.subject)} · ` : ''}${R.plural(s.total, 'card')} · ${s.pct}% known</div>
                  <div class="bar thin"><i class="m" style="width:${(s.mastered / Math.max(1, s.total)) * 100}%"></i><i class="l" style="width:${(s.learning / Math.max(1, s.total)) * 100}%"></i></div></div>
                <a class="btn btn-ghost btn-sm" href="#/deck/${d.id}/learn">Study</a></div>`
              )
              .join('')}</div>
          </section>
        </div>
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>This week</h2><a class="small" href="#/progress">Progress</a></div>
            <div class="panel-body">${weekBars()}</div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Recent activity</h2></div>
            ${hist.length ? `<div class="feed">${hist.map(R.feedItem).join('')}</div>` : '<div class="empty-small">Finished sessions will show up here.</div>'}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Quick add</h2></div>
            <div class="panel-body">${R.dropzone(false)}</div>
          </section>
        </div>
      </div>`;
    R.bindDrop(R.$('[data-drop]', root), (files) => {
      R.pending = { files };
      location.hash = '#/new';
    });
  };

  function welcome(root) {
    const formats = [
      ['file', 'PDF'],
      ['file', 'Word'],
      ['file', 'PowerPoint'],
      ['image', 'Photos'],
      ['list', 'CSV and text'],
      ['paste', 'Pasted notes'],
    ];
    root.innerHTML = `
      <div class="first">
        ${R.deck3d(['Term', 'Your first card'])}
        <h1 class="first-title">Make your first deck.</h1>
        <p class="first-sub">Add notes, slides or a study guide. Kyrie writes the flashcards, quizzes and tests.</p>
        ${R.dropzone(true)}
        <div class="first-alt"><a href="#/new">Paste your notes instead</a><span class="sep"></span><button class="link-btn" data-tour>Take the tour</button></div>
        <div class="first-formats">${formats.map(([i, t]) => `<span>${R.icon(i, 16)}${t}</span>`).join('')}</div>
      </div>`;
    R.$('[data-drop]', root).dataset.tilt = '3';
    R.bindDrop(R.$('[data-drop]', root), (files) => {
      R.pending = { files };
      location.hash = '#/new';
    });
    R.$('[data-tour]', root).addEventListener('click', () => R.tour());
  }

  /* ================= LIBRARY ================= */

  const pref = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem('kyrie.pref.' + k);
      localStorage.setItem('kyrie.pref.' + k, v);
    } catch (_) {}
  };

  V.library = (root, params) => {
    const decks = R.store.decks();
    const subjects = R.store.subjects();
    const st = { q: '', subject: params.subject || '', sort: pref('sort') || 'recent', view: pref('view') || 'grid' };
    const cardCount = decks.reduce((t, d) => t + d.cards.length, 0);

    root.innerHTML = `
      ${R.pageHead({
        title: 'Library',
        sub: decks.length ? `${R.plural(decks.length, 'deck')} · ${R.plural(cardCount, 'card')}` : 'Your decks will live here.',
        actions: `<a class="btn btn-primary" href="#/new">${R.icon('plus', 16)} New deck</a>`,
      })}
      ${
        decks.length
          ? `<div class="toolbar">
        <div class="search">${R.icon('search', 16)}<input class="input" placeholder="Search decks" data-q></div>
        ${subjects.length ? `<select class="input select-sm" data-subject><option value="">All subjects</option>${subjects.map((x) => `<option ${x === st.subject ? 'selected' : ''}>${R.esc(x)}</option>`).join('')}</select>` : ''}
        <select class="input select-sm" data-sort>
          ${[['recent', 'Recently studied'], ['name', 'Name'], ['due', 'Most due'], ['progress', 'Least mastered'], ['created', 'Newest']].map(([k, l]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="seg seg-sm view-toggle">
          <button class="seg-btn ${st.view === 'grid' ? 'on' : ''}" data-view="grid" aria-label="Grid view">${R.icon('grid', 15)}</button>
          <button class="seg-btn ${st.view === 'list' ? 'on' : ''}" data-view="list" aria-label="List view">${R.icon('list', 15)}</button>
        </div>
      </div>
      <div data-out></div>`
          : `<div class="empty panel">${R.deck3d(['Term', 'Your first card'])}<h2>No decks yet</h2><p class="muted">Upload notes, slides or a study guide and Kyrie will make your first deck.</p><a class="btn btn-primary" href="#/new">${R.icon('plus', 16)} New deck</a></div>`
      }`;
    if (!decks.length) return;

    const out = R.$('[data-out]', root);
    function draw() {
      let list = decks.map((d) => ({ d, s: R.srs.summary(d) }));
      if (st.subject) list = list.filter((x) => x.d.subject === st.subject);
      if (st.q) list = list.filter((x) => (x.d.title + ' ' + (x.d.subject || '')).toLowerCase().includes(st.q.toLowerCase()));
      const sorters = {
        recent: (a, b) => (b.d.opened || b.d.updated) - (a.d.opened || a.d.updated),
        name: (a, b) => a.d.title.localeCompare(b.d.title),
        due: (a, b) => b.s.due - a.s.due,
        progress: (a, b) => a.s.pct - b.s.pct,
        created: (a, b) => b.d.created - a.d.created,
      };
      list.sort(sorters[st.sort]);
      if (!list.length) {
        out.innerHTML = '<div class="empty-small panel">No decks match.</div>';
        return;
      }
      if (st.view === 'grid') {
        out.innerHTML = `<div class="deck-grid">${list
          .map(
            ({ d, s }) => `<a class="deck-card" data-tilt="7" href="#/deck/${d.id}">
            <div class="deck-card-top">${d.subject ? `<span class="chip">${R.esc(d.subject)}</span>` : '<span></span>'}${s.due ? `<span class="chip chip-due">${s.due} due</span>` : ''}</div>
            <h3>${R.esc(d.title)}</h3>
            <div class="deck-meta">${R.plural(s.total, 'card')} · studied ${R.timeAgo(d.opened || d.updated)}</div>
            <div class="deck-foot"><div class="bar thin grow"><i class="m" style="width:${(s.mastered / Math.max(1, s.total)) * 100}%"></i><i class="l" style="width:${(s.learning / Math.max(1, s.total)) * 100}%"></i></div><span class="deck-pct">${s.pct}%</span></div>
          </a>`
          )
          .join('')}</div>`;
      } else {
        out.innerHTML = `<div class="table deck-table">
          <div class="tr th"><span>Name</span><span>Subject</span><span>Cards</span><span>Mastery</span><span>Due</span><span>Last studied</span></div>
          ${list
            .map(
              ({ d, s }) => `<a class="tr" href="#/deck/${d.id}">
              <span class="td-front">${R.esc(d.title)}</span><span class="muted">${R.esc(d.subject || '-')}</span><span>${s.total}</span>
              <span class="td-bar"><div class="bar thin"><i class="m" style="width:${(s.mastered / Math.max(1, s.total)) * 100}%"></i><i class="l" style="width:${(s.learning / Math.max(1, s.total)) * 100}%"></i></div><span>${s.pct}%</span></span>
              <span>${s.due ? `<span class="chip chip-due">${s.due}</span>` : '<span class="muted">0</span>'}</span><span class="muted">${R.timeAgo(d.opened || d.updated)}</span></a>`
            )
            .join('')}</div>`;
      }
    }
    draw();
    R.$('[data-q]', root).addEventListener('input', (e) => ((st.q = e.target.value), draw()));
    R.$('[data-subject]', root)?.addEventListener('change', (e) => ((st.subject = e.target.value), draw()));
    R.$('[data-sort]', root).addEventListener('change', (e) => {
      st.sort = e.target.value;
      pref('sort', st.sort);
      draw();
    });
    R.$$('[data-view]', root).forEach((b) =>
      b.addEventListener('click', () => {
        st.view = b.dataset.view;
        pref('view', st.view);
        R.$$('[data-view]', root).forEach((x) => x.classList.toggle('on', x === b));
        draw();
      })
    );
  };

  /* ================= PROGRESS ================= */

  V.progress = (root) => {
    const decks = R.store.decks();
    const days = R.store.days();
    const sums = decks.map((d) => ({ d, s: R.srs.summary(d) }));
    const mastered = sums.reduce((t, x) => t + x.s.mastered, 0);
    const cards = sums.reduce((t, x) => t + x.s.total, 0);

    // 20-week heatmap, weeks as columns starting on Sunday.
    const WEEKS = 20;
    const end = new Date();
    const start = new Date(end.getTime() - ((WEEKS - 1) * 7 + end.getDay()) * DAY);
    const cells = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
      const n = days[dayKey(new Date(t))] || 0;
      cells.push({ n, t, lvl: n === 0 ? 0 : n < 10 ? 1 : n < 25 ? 2 : n < 50 ? 3 : 4 });
    }
    const activeDays = Object.values(days).filter(Boolean).length;

    const bests = [];
    for (const d of decks) {
      for (const [key, label, fmt, low] of [
        ['test', 'Practice test', (v) => `${v}%`],
        ['sprint', 'Sprint', (v) => `${v.toLocaleString()} pts`],
        ['match', 'Match', (v) => R.fmtTime(v), true],
        ['comet', 'Comet Run', (v) => v.toLocaleString()],
        ['blitz', 'Lightning', (v) => `${v} pts`],
      ]) {
        const v = R.store.best(`${key}:${d.id}`);
        if (v != null) bests.push({ label, deck: d, v, text: fmt(v), low });
      }
    }

    root.innerHTML = `
      ${R.pageHead({ title: 'Progress', sub: 'Everything you have studied in this browser.' })}
      <div class="kpis">
        <div class="kpi"><div class="kpi-l">Total reviews</div><div class="kpi-n">${R.store.totalReviews().toLocaleString()}</div></div>
        <div class="kpi"><div class="kpi-l">Current streak</div><div class="kpi-n">${R.plural(R.store.streak(), 'day')}</div></div>
        <div class="kpi"><div class="kpi-l">Longest streak</div><div class="kpi-n">${R.plural(longestStreak(), 'day')}</div></div>
        <div class="kpi"><div class="kpi-l">Days studied</div><div class="kpi-n">${activeDays}</div></div>
        <div class="kpi"><div class="kpi-l">Cards mastered</div><div class="kpi-n">${mastered}<span class="kpi-of"> / ${cards}</span></div></div>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Activity</h2><span class="muted small">Last ${WEEKS} weeks</span></div>
        <div class="panel-body">
          <div class="heat-wrap"><div class="heat" style="grid-template-columns: repeat(${Math.ceil(cells.length / 7)}, 13px)">
            ${cells.map((c) => `<i class="h${c.lvl}" title="${new Date(c.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${R.plural(c.n, 'review')}"></i>`).join('')}
          </div></div>
          <div class="heat-legend"><span>Less</span><i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><span>More</span></div>
        </div>
      </section>
      <div class="two-col">
        <section class="panel">
          <div class="panel-head"><h2>Mastery by deck</h2></div>
          ${
            sums.length
              ? `<div class="rows">${sums
                  .sort((a, b) => b.s.pct - a.s.pct)
                  .map(
                    ({ d, s }) => `<div class="row-item"><div class="grow"><a class="row-title" href="#/deck/${d.id}">${R.esc(d.title)}</a>
                  <div class="bar thin"><i class="m" style="width:${(s.mastered / Math.max(1, s.total)) * 100}%"></i><i class="l" style="width:${(s.learning / Math.max(1, s.total)) * 100}%"></i></div></div><strong class="row-num">${s.pct}%</strong></div>`
                  )
                  .join('')}</div>`
              : '<div class="empty-small">No decks yet.</div>'
          }
        </section>
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>Personal bests</h2></div>
            ${bests.length ? `<div class="best-list">${bests.map((b) => `<div class="best"><span>${b.label} <span class="muted">· ${R.esc(b.deck.title)}</span></span><strong>${b.text}</strong></div>`).join('')}</div>` : '<div class="empty-small">Play a game or take a test to set one.</div>'}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>History</h2></div>
            ${R.store.history().length ? `<div class="feed">${R.store.history().slice(0, 12).map(R.feedItem).join('')}</div>` : '<div class="empty-small">No sessions yet.</div>'}
          </section>
        </div>
      </div>`;
  };

  /* ================= SETTINGS ================= */

  V.settings = (root) => {
    const s = R.store.settings();
    root.innerHTML = `
      ${R.pageHead({ title: 'Settings', sub: 'Changes save automatically.' })}
      <div class="settings-page">
        <section class="panel">
          <div class="panel-head"><h2>Profile</h2></div>
          <div class="panel-body">
            <label class="field"><span>Your name</span><input class="input" data-name placeholder="Used for the greeting on Home" value="${R.esc(s.name || '')}"></label>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Studying</h2></div>
          <div class="panel-body">
            <div class="field"><span>Daily goal (reviews)</span>
              <div class="seg">${[10, 20, 30, 50, 100].map((n) => `<button class="seg-btn ${s.goal === n ? 'on' : ''}" data-goal="${n}">${n}</button>`).join('')}</div>
            </div>
            <label class="switch-row"><div><strong>Sound effects</strong><div class="muted small">Short sounds for right and wrong answers.</div></div><input type="checkbox" class="switch" data-sound ${s.sound ? 'checked' : ''}></label>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Appearance</h2></div>
          <div class="panel-body">
            <div class="seg">${['light', 'dark', 'system'].map((t) => `<button class="seg-btn ${s.theme === t ? 'on' : ''}" data-theme-opt="${t}">${R.icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'sliders', 15)} ${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Claude</h2><span class="chip" data-ai-chip>Checking…</span></div>
          <div class="panel-body"><p class="muted small" data-ai-text></p></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Your data</h2></div>
          <div class="panel-body">
            <p class="muted small mb">Decks and progress are stored in this browser only. Back them up to move them to another device or browser.</p>
            <div class="row gap wrap">
              <button class="btn btn-ghost" data-export>${R.icon('download', 16)} Back up everything</button>
              <label class="btn btn-ghost">${R.icon('upload', 16)} Restore from backup<input type="file" accept=".json" data-restore hidden></label>
              <button class="btn btn-ghost danger" data-wipe>${R.icon('trash', 16)} Delete all data</button>
            </div>
          </div>
        </section>
      </div>`;

    R.ai.ready.then(() => {
      const on = R.ai.enabled();
      const chip = R.$('[data-ai-chip]', root);
      if (!chip) return;
      chip.textContent = on ? 'Available' : 'Not available';
      chip.classList.toggle('chip-ok', on);
      R.$('[data-ai-text]', root).textContent = on
        ? 'Claude can write your cards on this site, at no cost to you. Choose Claude or the built-in card maker each time you make a deck.'
        : 'Claude is not set up on this site right now. The built-in card maker works offline and is always free.';
    });
    const saved = () => R.toast('Saved', 'ok', 1400);
    R.$('[data-name]', root).addEventListener('change', (e) => {
      R.store.setSettings({ name: e.target.value.trim() });
      saved();
    });
    R.$$('[data-goal]', root).forEach((b) =>
      b.addEventListener('click', () => {
        R.store.setSettings({ goal: +b.dataset.goal });
        R.$$('[data-goal]', root).forEach((x) => x.classList.toggle('on', x === b));
      })
    );
    R.$('[data-sound]', root).addEventListener('change', (e) => R.store.setSettings({ sound: e.target.checked }));
    R.$$('[data-theme-opt]', root).forEach((b) =>
      b.addEventListener('click', () => {
        R.store.setSettings({ theme: b.dataset.themeOpt });
        R.$$('[data-theme-opt]', root).forEach((x) => x.classList.toggle('on', x === b));
        R.applyTheme();
      })
    );
    R.$('[data-export]', root).addEventListener('click', () => {
      R.download(`kyrie-backup-${R.today()}.json`, JSON.stringify({ kyrieBackup: 1, decks: R.store.decks() }, null, 1));
    });
    R.$('[data-restore]', root).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const decks = j.kyrieBackup || j.recallBackup ? j.decks : j.kyrie || j.recall ? [j] : null;
        if (!decks) throw new Error();
        let n = 0;
        for (const d of decks) {
          if (d.id && R.store.deck(d.id)) continue;
          R.store.upsert({ ...R.newDeck(d.title, [], d.sources || [], d.subject || ''), ...d, cards: d.cards.map(R.newCard) });
          n++;
        }
        R.toast(`Restored ${R.plural(n, 'deck')}`, 'ok');
      } catch (_) {
        R.toast('That file is not a Kyrie backup', 'error');
      }
    });
    R.$('[data-wipe]', root).addEventListener('click', async () => {
      if (!(await R.confirm('Delete all data?', 'Every deck, card, score and setting in this browser will be removed. This cannot be undone.', 'Delete everything'))) return;
      R.store.wipe();
      R.applyTheme();
      R.toast('All data deleted');
      location.hash = '#/';
    });
  };

  /* ================= HELP ================= */

  V.help = (root) => {
    const faq = [
      ['Do I need an account?', 'No. Kyrie saves your decks and progress in your browser. Your material only leaves your device when you choose Claude as the card maker, and then only to write the cards. It is not stored.'],
      ['Where are my decks saved?', 'In this browser on this device. Clearing your browser data deletes them, so use Settings → Back up everything now and then. To use another device, restore the backup there.'],
      ['Built-in or Claude?', 'Both are free to use. The built-in card maker works offline and is instant. Claude takes a little longer but understands messy notes and handwriting, and writes harder quiz options.'],
      ['How does review scheduling work?', 'When you rate a flashcard, Kyrie picks when to show it again: in a minute if you missed it, then a day, three days, a week and so on as you keep getting it right. Quiz and game answers count too.'],
      ['Why did a file give me no cards?', 'Kyrie needs readable text. Scanned PDFs and photos are read with text recognition, which can miss things. Clear definitions ("Term: meaning") always work best.'],
      ['Can I bring in my Quizlet sets?', 'Yes. In Quizlet, export a set as text with a tab between term and definition, save it as a .txt or .tsv file, and upload it.'],
    ];
    const keys = [
      ['Flashcards', 'Space', 'Flip the card'],
      ['Flashcards', '1 2 3 4', 'Rate Again, Hard, Good, Easy'],
      ['Flashcards', '← →', 'Previous or next card'],
      ['Flashcards', 'S', 'Star the card'],
      ['Learn, games', '1 to 4', 'Pick an answer'],
      ['Learn, games', 'Enter', 'Check, then continue'],
      ['Comet Run', '← → or A D', 'Steer (or use the mouse)'],
      ['Comet Run', 'P or Esc', 'Pause'],
      ['Lightning', '← or F / → or T', 'False / True'],
    ];
    root.innerHTML = `
      ${R.pageHead({ title: 'Help', sub: 'How Kyrie works, what it can read, and shortcuts.' })}
      <div class="help">
        <section class="panel help-start">
          <div class="panel-body row gap wrap">
            <div class="grow"><h2>New to Kyrie?</h2><p class="muted small">A one-minute walkthrough of how everything works.</p></div>
            <button class="btn btn-ghost" data-intro>View the intro</button>
            <button class="btn btn-primary" data-tour>Take the tour</button>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Supported files</h2></div>
          <div class="table help-table">
            <div class="tr th"><span>Format</span><span>What Kyrie reads</span></div>
            <div class="tr"><span><strong>PDF</strong></span><span>All the text. Scanned pages are read with text recognition.</span></div>
            <div class="tr"><span><strong>Word (.docx)</strong></span><span>Text, headings, bold terms, lists and two-column tables.</span></div>
            <div class="tr"><span><strong>PowerPoint (.pptx)</strong></span><span>Slide titles, bullet points and speaker notes.</span></div>
            <div class="tr"><span><strong>Photos</strong></span><span>Printed or handwritten notes (handwriting works best with Claude).</span></div>
            <div class="tr"><span><strong>CSV, TSV, TXT, MD</strong></span><span>Term lists (term, definition) and plain notes.</span></div>
            <div class="tr"><span><strong>Kyrie deck (.json)</strong></span><span>Decks exported from Kyrie, imported as they are.</span></div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Card types</h2></div>
          <div class="table help-table">
            <div class="tr"><span><strong>Term</strong></span><span>A word or concept on the front, its definition on the back.</span></div>
            <div class="tr"><span><strong>Q&amp;A</strong></span><span>A question and its answer.</span></div>
            <div class="tr"><span><strong>Blank</strong></span><span>A sentence from your notes with the key word removed.</span></div>
            <div class="tr"><span><strong>List</strong></span><span>A heading and the items under it ("Name the 4 causes of…").</span></div>
            <div class="tr"><span><strong>Acronym</strong></span><span>An abbreviation and what it stands for.</span></div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Study modes</h2></div>
          <div class="rows">${R.MODES.map((m) => `<div class="row-item"><div class="mode-ic sm">${R.icon(m.icon, 16)}</div><div class="grow"><div class="row-title">${m.title}${m.game ? ' <span class="chip">Game</span>' : ''}</div><div class="row-sub">${m.desc}</div></div></div>`).join('')}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Keyboard shortcuts</h2></div>
          <div class="table help-table keys">
            ${keys.map(([w, k, d]) => `<div class="tr"><span class="muted">${w}</span><span>${k.split(' ').map((x) => (x.length <= 3 || /^[←→]$/.test(x) ? `<kbd>${x}</kbd>` : `<span class="muted">${x}</span>`)).join(' ')}</span><span>${d}</span></div>`).join('')}
          </div>
        </section>
        <section class="panel faq">
          <div class="panel-head"><h2>Questions</h2></div>
          ${faq.map(([q, a]) => `<details><summary>${q}${R.icon('chevron', 16)}</summary><p>${a}</p></details>`).join('')}
        </section>
      </div>`;
    R.$('[data-tour]', root).addEventListener('click', () => R.tour());
    R.$('[data-intro]', root).addEventListener('click', () => (location.hash = '#/intro'));
  };
})();
