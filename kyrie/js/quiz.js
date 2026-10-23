/* Kyrie: builds questions from cards for Learn, Test and the games. */
(function () {
  const LABEL = {
    term: 'Term',
    qa: 'Question',
    cloze: 'Fill in the blank',
    acronym: 'What does it stand for?',
    list: 'Name them',
  };

  // Which side the student sees and which side they answer with.
  function sides(card, reverse) {
    if (card.kind === 'term' && reverse) return { prompt: card.back, answer: card.front, label: 'Definition', ask: 'Which term is this?' };
    return { prompt: card.front, answer: card.back, label: LABEL[card.kind] || 'Term', ask: card.kind === 'term' ? 'Pick the definition' : card.kind === 'cloze' ? 'Which fits the blank?' : 'Pick the answer' };
  }

  function wrongAnswers(card, deck, answer, reverse, n = 3) {
    const ans = R.norm(answer);
    const out = [];
    const push = (x) => {
      if (!x || out.length >= n) return;
      const k = R.norm(x);
      if (!k || k === ans || out.some((o) => R.norm(o) === k)) return;
      out.push(x);
    };
    if (!reverse) R.shuffle(card.distractors || []).forEach(push);
    const others = deck.cards.filter((c) => c.id !== card.id);
    const field = (c) => (reverse && c.kind === 'term' ? c.front : c.back);
    const same = others.filter((c) => c.kind === card.kind && (card.kind !== 'cloze' || !card.cat || c.cat === card.cat));
    const sorted = (list) => R.shuffle(list).sort((a, b) => Math.abs(field(a).length - answer.length) - Math.abs(field(b).length - answer.length));
    sorted(same).slice(0, 6).forEach((c) => push(field(c)));
    sorted(others).forEach((c) => push(field(c)));
    return out;
  }

  function make(card, deck, type, opts = {}) {
    const reverse = opts.reverse ?? (card.kind === 'term' && Math.random() < (type === 'written' ? 0.7 : 0.45));
    const sd = sides(card, reverse);
    const q = { id: R.uid(), card, type, reverse, prompt: sd.prompt, label: sd.label, ask: sd.ask, answer: sd.answer, explain: card.explain || '' };
    if (type === 'mc') {
      const wrong = wrongAnswers(card, deck, sd.answer, reverse, opts.choices ? opts.choices - 1 : 3);
      q.choices = R.shuffle([sd.answer, ...wrong]);
      q.correct = q.choices.indexOf(sd.answer);
    } else if (type === 'tf') {
      const wrong = wrongAnswers(card, deck, sd.answer, reverse, 1)[0];
      q.truth = !wrong || Math.random() < 0.5;
      q.shown = q.truth ? sd.answer : wrong;
      q.ask = 'True or false?';
    } else {
      q.ask = reverse ? 'Type the term' : card.kind === 'cloze' ? 'Type the missing word' : card.kind === 'list' ? 'Type the items, separated by commas' : 'Type the answer';
    }
    return q;
  }

  function check(q, value) {
    if (q.type === 'mc') return { ok: value === q.correct };
    if (q.type === 'tf') return { ok: value === q.truth };
    if (q.card.kind === 'list') {
      const want = q.answer.split(/;\s*/).map(R.norm).filter(Boolean);
      const got = String(value).split(/[,;\n]+|\band\b/).map(R.norm).filter(Boolean);
      const hits = want.filter((w) => got.some((g) => R.isCorrect(g, w).ok)).length;
      return { ok: hits === want.length, close: hits >= Math.ceil(want.length / 2), sim: hits / want.length };
    }
    return R.isCorrect(value, q.answer);
  }

  // Pick a type that suits the card and the deck (MC needs enough cards to make options).
  function autoType(card, deck, allowed = ['mc', 'written', 'tf']) {
    const enough = deck.cards.length >= 3 || (card.distractors || []).length >= 2;
    const pool = allowed.filter((t) => (t === 'mc' || t === 'tf' ? enough : true));
    if (!pool.length) return 'written';
    const st = R.srs.state(card);
    if (st === 'new' && pool.includes('mc')) return 'mc';
    if (card.kind === 'list' && pool.includes('mc')) return 'mc';
    return pool[(Math.random() * pool.length) | 0];
  }

  R.quiz = { make, check, autoType, sides, LABEL };
})();
