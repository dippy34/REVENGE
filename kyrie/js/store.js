/* Kyrie: local persistence and spaced repetition. Everything lives in this browser. */
(function () {
  const KEY = 'kyrie.v1';
  const DEFAULT_SETTINGS = {
    theme: 'light',
    sound: true,
    goal: 20, // reviews per day
    name: '',
    engine: 'auto', // auto: Claude when this site has it, otherwise the built-in generator
  };

  let data = { v: 1, decks: [], settings: { ...DEFAULT_SETTINGS }, stats: { days: {}, best: {}, history: [] } };
  let saveTimer = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        data = {
          ...data,
          ...parsed,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          stats: { days: {}, best: {}, history: [], ...(parsed.stats || {}) },
        };
      }
    } catch (_) {
      /* private mode or corrupt data: start fresh in memory */
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      R.toast('Could not save: browser storage is full or blocked. Export your decks to keep them.', 'error', 6000);
    }
  }
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  };
  window.addEventListener('beforeunload', saveNow);

  R.store = {
    load,
    save,
    saveNow,
    decks: () => data.decks,
    deck: (id) => data.decks.find((d) => d.id === id),
    settings: () => data.settings,
    setSettings(patch) {
      Object.assign(data.settings, patch);
      save();
    },
    upsert(deck) {
      deck.updated = Date.now();
      const i = data.decks.findIndex((d) => d.id === deck.id);
      if (i >= 0) data.decks[i] = deck;
      else data.decks.unshift(deck);
      save();
      return deck;
    },
    remove(id) {
      data.decks = data.decks.filter((d) => d.id !== id);
      save();
    },
    touch(deck) {
      deck.opened = Date.now();
      save();
    },
    logStudy(n = 1) {
      const d = R.today();
      data.stats.days[d] = (data.stats.days[d] || 0) + n;
      save();
    },
    studiedToday: () => data.stats.days[R.today()] || 0,
    days: () => data.stats.days,
    totalReviews: () => Object.values(data.stats.days).reduce((a, b) => a + b, 0),
    // Finished sessions (tests, games, flashcard runs) for the activity feed.
    addHistory(entry) {
      data.stats.history.unshift({ t: Date.now(), ...entry });
      data.stats.history.length = Math.min(data.stats.history.length, 200);
      save();
    },
    history: () => data.stats.history,
    subjects: () => [...new Set(data.decks.map((d) => d.subject).filter(Boolean))].sort(),
    wipe() {
      data = { v: 1, decks: [], settings: { ...DEFAULT_SETTINGS }, stats: { days: {}, best: {}, history: [] } };
      saveNow();
    },
    streak() {
      let n = 0;
      const day = new Date();
      if (!data.stats.days[R.today()]) day.setDate(day.getDate() - 1); // today not started yet still keeps the streak
      for (;;) {
        const k = day.toISOString().slice(0, 10);
        if (!data.stats.days[k]) break;
        n++;
        day.setDate(day.getDate() - 1);
      }
      return n;
    },
    best: (key) => data.stats.best[key],
    setBest(key, val, lowerIsBetter = false) {
      const cur = data.stats.best[key];
      const better = cur == null || (lowerIsBetter ? val < cur : val > cur);
      if (better) {
        data.stats.best[key] = val;
        save();
      }
      return better;
    },
  };

  R.newDeck = (title, cards = [], sources = [], subject = '') => ({
    id: R.uid(),
    title: title || 'Untitled deck',
    subject,
    created: Date.now(),
    updated: Date.now(),
    opened: Date.now(),
    hue: Math.floor(Math.random() * 360),
    sources,
    cards: cards.map(R.newCard),
  });

  R.newCard = (c) => ({
    id: c.id || R.uid(),
    front: String(c.front || '').trim(),
    back: String(c.back || '').trim(),
    kind: c.kind || 'term',
    cat: c.cat || '',
    hint: c.hint || '',
    explain: c.explain || '',
    distractors: Array.isArray(c.distractors) ? c.distractors.filter(Boolean).slice(0, 4) : [],
    starred: !!c.starred,
    s: c.s || { due: 0, iv: 0, ease: 2.5, reps: 0, lapses: 0, streak: 0, seen: 0, right: 0 },
  });

  /* ---------- spaced repetition (SM-2 flavoured) ---------- */
  const DAY = 86400000;

  R.srs = {
    // grade: 0 again, 1 hard, 2 good, 3 easy
    rate(card, grade) {
      card.s = R.srs.next(card.s, grade);
      R.store.logStudy();
    },
    // Label for the button: when would this card come back?
    preview(card, grade) {
      const iv = R.srs.next(card.s, grade).iv;
      if (iv === 0) return '1 min';
      if (iv < 1) return `${Math.round(iv * 24)} hr`;
      if (iv < 30) return `${Math.round(iv)} day${Math.round(iv) === 1 ? '' : 's'}`;
      if (iv < 365) return `${Math.round(iv / 30)} mo`;
      return `${(iv / 365).toFixed(1)} yr`;
    },
    next(s0, grade) {
      const s = { ...s0 };
      s.seen++;
      s.last = Date.now();
      if (grade === 0) {
        s.lapses++;
        s.streak = 0;
        s.iv = 0;
        s.ease = Math.max(1.3, s.ease - 0.2);
        s.due = Date.now() + 60 * 1000;
      } else {
        s.right++;
        s.streak++;
        if (grade === 1) {
          s.iv = Math.max(0.5, s.iv * 1.2);
          s.ease = Math.max(1.3, s.ease - 0.15);
        } else if (grade === 2) {
          s.iv = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.iv * s.ease * 10) / 10;
        } else {
          s.iv = s.reps === 0 ? 4 : Math.round(s.iv * s.ease * 1.3 * 10) / 10;
          s.ease += 0.15;
        }
        s.reps++;
        s.due = Date.now() + s.iv * DAY;
      }
      return s;
    },
    // Quiz and game answers feed the same schedule, more gently than a flashcard rating.
    record(card, ok) {
      const s = card.s;
      if (ok) {
        if (s.due <= Date.now()) return R.srs.rate(card, 2);
        s.seen++;
        s.right++;
        s.streak++;
      } else {
        s.seen++;
        s.streak = 0;
        s.lapses++;
        s.due = Date.now();
        s.iv = Math.min(s.iv, 1);
      }
      R.store.logStudy();
    },
    isDue: (card) => card.s.due <= Date.now(),
    state(card) {
      const s = card.s;
      if (!s.seen) return 'new';
      if (s.streak >= 3 || s.iv >= 7) return 'mastered';
      return 'learning';
    },
    summary(deck) {
      const out = { new: 0, learning: 0, mastered: 0, due: 0, total: deck.cards.length };
      for (const c of deck.cards) {
        out[R.srs.state(c)]++;
        if (c.s.seen && R.srs.isDue(c)) out.due++;
      }
      out.pct = out.total ? Math.round(((out.mastered + out.learning * 0.4) / out.total) * 100) : 0;
      return out;
    },
  };
})();
