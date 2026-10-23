/* Kyrie: the built-in card generator. Runs entirely in the browser, no account or key needed.
   It reads study text the way a student skims it: definitions, term lists, Q&A, acronyms,
   headings with bullet lists, then turns the most testable remaining sentences into fill-in-the-blanks. */
(function () {
  const STOP = new Set(
    ('a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up upon very was we were what when where which while who whom why will with would you your yours yourself also however therefore thus may might must shall within without among across along around per via each every either neither many much one two three first second third new used use using make made like well often usually called known include includes including such based given within').split(' ')
  );
  const GENERIC = new Set('result results problem answer goal reason idea point thing things way key difference purpose role first second last main example examples part type types process thing area areas fact name number amount way ways time times people person place system'.split(' '));
  const PRONOUN_START = /^(it|this|that|these|those|they|he|she|we|you|i|there|here|such|which|what|who|one|some|many|most|each|all|both|another|its|their|his|her|our|my|your|however|also|so|then|thus|therefore)\b/i;
  const PREP_START = /^(in|on|at|by|for|during|after|before|when|if|because|although|though|while|since|as|with|without|from|to|of|unlike|like|despite|once|until|whereas|between|among|under|over)\b/i;
  const AUX = /\b(can|will|would|should|may|might|must|has|have|had|do|does|did|could|not)\b/i;
  const GENERIC_HEAD = /^(chapter|unit|lesson|section|part|module|week|day|page|table of contents|contents|introduction|summary|review|notes?|overview|conclusion|references|bibliography|vocab(ulary)?|key (terms|events|ideas|concepts|people|dates|points|facts)|important (terms|events|people|dates)|timeline|background|glossary|questions?|answers?|exercises?|homework|objectives?|learning objectives|agenda|outline)\b|^\d+(\.\d+)*$/i;
  const BAD_TERM = /^(note|notes|example|examples|e\.?g|i\.?e|figure|fig|table|page|date|name|answer|question|q|a|step \d+|source|sources|see|tip|warning|important|remember|reminder|hint|url|link|email|class|teacher|period|due|total)$/i;
  const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const words = (s) => s.trim().split(/\s+/).filter(Boolean);
  const stripMd = (s) => s.replace(/\*\*|__/g, '').replace(/`/g, '').trim();
  const trimEnd = (s) => s.replace(/[\s.;,:]+$/, '').trim();
  const stripLead = (s) => s.replace(/^\s*(?:[-*+•>]|\d{1,3}[.)]|[a-z][.)]|\(\w\))\s+/, '');
  const cleanTerm = (s) => cap(stripMd(s).replace(/^(the|a|an)\s+/i, '').replace(/^["'“”]+|["'“”]+$/g, '').trim());
  const LEAD_ADVERB = /^(together|collectively|overall|in short|in general|in summary|basically|essentially|thus|so|therefore|hence|similarly|likewise|finally|also)\s*,?\s+/i;
  const cleanDef = (s) => cap(trimEnd(stripMd(s).replace(LEAD_ADVERB, '')));

  function normalize(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/ /g, ' ')
      .replace(/­/g, '')
      .replace(/^[ \t]*[•▪●◦‣⁃■∙➢✓✔o§]\s+/gm, '- ')
      .replace(/^[ \t]*\*\*\s*[\u2022\u25AA\u25CF\u25E6\u2023\u2043\uf0b7\u25A0\u2219\u27A2\u2713\u2714]\s*/gm, '- **')
      .replace(/(\w)-\n(\w)/g, '$1$2')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  function splitSentences(par) {
    const ABBR = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|ca|Fig|No|Inc|Ltd|Co|Corp|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mt|Ft|Gen|Gov|Sen|Rep|Pres|Rev|cf|al)\./g;
    let s = par
      .replace(ABBR, '$1․')
      .replace(/\b(e)\.(g)\./gi, '$1․$2․')
      .replace(/\b(i)\.(e)\./gi, '$1․$2․')
      .replace(/\b([A-HJ-UWYZ])\.(?=\s?[A-Z]\.|\s[A-Z][a-z])/g, '$1․')
      .replace(/(\d)\.(\d)/g, '$1․$2');
    return s
      .split(/(?<=[.!?])["')\]]?\s+(?=["'(\[]?[A-Z0-9])/)
      .map((x) => x.replace(/․/g, '.').trim())
      .filter((x) => x.length > 0);
  }

  // Do the acronym letters appear in order through the phrase, starting at its first letter?
  function acronymFits(acr, phrase) {
    const p = phrase.toLowerCase();
    const a = acr.replace(/s$/, '').toLowerCase();
    if (p[0] !== a[0]) return false;
    let i = 0;
    for (const ch of p) if (ch === a[i]) i++;
    return i === a.length;
  }

  function findAcronyms(text) {
    const out = [];
    const re = /((?:[A-Za-z][\w'-]*\s+){0,7}[A-Za-z][\w'-]*)\s+\(([A-Z][A-Za-z]{1,9})\)/g;
    let m;
    while ((m = re.exec(text))) {
      const acr = m[2];
      if ((acr.match(/[A-Z]/g) || []).length < 2) continue;
      const ws = m[1].split(/\s+/);
      for (let k = 1; k <= ws.length; k++) {
        const phrase = ws.slice(-k).join(' ');
        if (k >= Math.ceil(acr.replace(/s$/, '').length / 3) && acronymFits(acr, phrase)) {
          if (!PRONOUN_START.test(phrase) && !/^(the|a|an|and|of)$/i.test(ws[ws.length - k])) out.push({ acr, phrase: cap(phrase) });
          break;
        }
      }
    }
    return out;
  }

  function keywordCounts(text) {
    const counts = new Map();
    for (const w of text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
      if (STOP.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    return counts;
  }

  /* ---------- line-level patterns ---------- */

  const LINE_DEF = /^(?:\*\*)?([^:\t=]{1,90}?)(?:\*\*)?\s*(\t+|:\s+|\s[-–—]{1,2}\s|\s=\s|\s→\s|\s->\s)\s*(.+)$/;
  const BOLD_LEAD = /^\*\*(.{1,70}?)\*\*\s*[:\-–—,]?\s*(.{4,})$/;
  const Q_LINE = /^(?:Q(?:uestion)?\s*\d*\s*[:.)\-]|\d{1,3}[.)])?\s*(.{8,240}\?)\s*$/i;
  const A_LINE = /^(?:A(?:ns(?:wer)?)?\s*[:.)\-])\s*(.+)$/i;
  const HEADING_MD = /^#{1,6}\s+(.+)$/;

  function isHeadingLine(line, prev, next) {
    if (HEADING_MD.test(line)) return true;
    const w = words(line);
    if (w.length > 7 || line.length > 70) return false;
    if (/[.,;:!?]$/.test(line) || /^[-*+]\s/.test(line)) return false;
    if (prev && prev.trim()) return false;
    const caps = w.filter((x) => /^[A-Z0-9]/.test(x)).length;
    return line === line.toUpperCase() ? /[A-Z]{3}/.test(line) : caps >= Math.ceil(w.length * 0.6) && next !== undefined;
  }

  function validTerm(term, sepKind, bulleted, bold) {
    const t = stripMd(term).trim();
    const w = words(t);
    if (!/[a-z]/i.test(t) || /https?:|www\./i.test(t)) return false;
    if (BAD_TERM.test(t) || GENERIC_HEAD.test(t)) return false;
    if (w.length > (sepKind === 'dash' ? 5 : 7)) return false;
    if (/[.!?]$/.test(t)) return false;
    if (sepKind === 'dash' && !bulleted && !bold && w.length > 4) return false;
    if (PRONOUN_START.test(t) && w.length > 1) return false;
    if (/^\d+$/.test(t)) return false;
    return true;
  }

  /* ---------- sentence-level definition ---------- */

  const DEF_SENT = /^(.{2,70}?)\s+(is defined as|are defined as|is known as|are known as|refers to|refer to|is the term for|is the name for|is a term for|means|is|are|was|were)\s+(.+)$/i;
  const CALLED_SENT = /^(.{12,}?)\s+(?:is|are|was|were)\s+(?:called|known as|termed|referred to as|named)\s+["']?([^,;]{2,60}?)["']?$/i;
  const STRONG_VERB = /defined as|known as|refers? to|term for|name for|means/i;
  const WHEN_SENT = /^(.{2,60}?)\s+(?:occurs|happens|takes place|is what happens|is when)\s+when\s+(.{10,})$/i;
  const MARKER = /\b(that|which|who|whose|where|by which|in which|used|stored|made|found|formed|located|caused|produced|consisting|containing|responsible)\b/i;
  const validSubject = (subj) => {
    const sw = words(subj.replace(/^(the|a|an)\s+/i, ''));
    return sw.length >= 1 && sw.length <= 6 && !PRONOUN_START.test(subj) && !PREP_START.test(subj) && !AUX.test(subj) && !/[,;()]/.test(subj);
  };
  const DEF_REST_START = /^(a|an|the|one|any|made|composed|used|found|located|responsible|considered|defined|known|when|where|how|what|important|essential|commonly|typically|usually|generally|often|primarily|mainly|basically|any|either|each|made up|formed|caused|created|the process|the study)\b/i;

  function sentenceDef(sentence, known) {
    const s = trimEnd(stripMd(stripLead(sentence)));
    if (s.length < 12 || s.length > 420 || /\?$/.test(sentence)) return null;
    let m = s.match(WHEN_SENT);
    if (m && validSubject(m[1])) return { front: cleanTerm(m[1]), back: 'When ' + trimEnd(m[2]), kind: 'term', score: 4 };
    m = s.replace(LEAD_ADVERB, '').match(CALLED_SENT);
    if (m && !PRONOUN_START.test(m[1]) && !PREP_START.test(m[1]) && words(m[2]).length <= 5) {
      return { front: cleanTerm(m[2]), back: cleanDef(m[1]), kind: 'term', score: 4 };
    }
    m = s.match(DEF_SENT);
    if (!m) return null;
    const [, subj, verb, restRaw] = m;
    const rest = restRaw.replace(/^also\s+/i, '');
    const sw = words(subj.replace(/^(the|a|an)\s+/i, ''));
    if (!sw.length || sw.length > 6) return null;
    if (PRONOUN_START.test(subj) || PREP_START.test(subj) || AUX.test(subj) || /[,;()]/.test(subj)) return null;
    if (/^not\b/i.test(rest) || words(rest).length < 3) return null;
    if (/\b(I|we|you|me|my|our)\b/.test(rest) && !/\bwe\b/i.test(subj)) return null;
    let score = 0;
    const strong = STRONG_VERB.test(verb);
    if (strong) score += 3;
    else if (/^(a|an|the|one|any)\b/i.test(rest)) score += 2;
    else if (DEF_REST_START.test(rest)) score += 1;
    if (!strong && sw.length <= 2 && !GENERIC.has(sw[sw.length - 1].toLowerCase())) score += 1;
    if (!strong && MARKER.test(rest) && words(rest).length >= 5) score += 1;
    const termNorm = R.norm(subj);
    if (known.has(termNorm)) score += 2;
    if (sw.length === 1 && GENERIC.has(sw[0].toLowerCase())) score -= 3;
    if (sw.length === 1 && STOP.has(sw[0].toLowerCase())) score -= 3;
    if (/^(the|a|an)\s+\w+$/i.test(subj) && GENERIC.has(sw[0].toLowerCase())) score -= 2;
    if (rest.length > 260) score -= 1;
    if (score < 2) return null;
    return { front: cleanTerm(subj), back: cleanDef(rest), kind: 'term', score };
  }

  /* ---------- fill-in-the-blank ---------- */

  function clozeCandidates(sentence, known, kw) {
    const c = [];
    const add = (text, cat, score, idx) => {
      text = text.trim();
      if (!text || text.length > 50) return;
      c.push({ text, cat, score, idx });
    };
    const lower = sentence.toLowerCase();
    for (const [norm, label] of known) {
      if (norm.length < 3) continue;
      const i = lower.indexOf(label.toLowerCase());
      if (i >= 0 && !/\w/.test(sentence[i - 1] || '') && !/\w/.test(sentence[i + label.length] || '')) {
        const inParens = sentence[i - 1] === '(' && sentence[i + label.length] === ')';
        add(sentence.substr(i, label.length), 'term', (inParens ? 1 : 5) + Math.min(2, words(label).length * 0.4), i);
      }
    }
    let m;
    const yr = /\b(1[0-9]{3}|20[0-9]{2})(s)?\b/g;
    while ((m = yr.exec(sentence))) add(m[0], 'year', 4.5, m.index);
    const num = /\b\d[\d,]*(?:\.\d+)?\s?(?:%|°[CF]?|(?:percent|million|billion|trillion|thousand|hundred|km|kg|g|mg|m|cm|mm|miles?|years?|days?|hours?|degrees?|feet|ft|meters?|liters?|L|mL|kcal|calories|times|x)\b)/gi;
    while ((m = num.exec(sentence))) if (!/^(1[0-9]{3}|20[0-9]{2})$/.test(m[0])) add(m[0], 'num', 3.6, m.index);
    const names = /(?:^|[^.!?]\s)((?:[A-Z][a-z]+|[A-Z]{2,})(?:\s+(?:of|the|de|du|von|van|da|la|al|and)?\s*(?:[A-Z][a-z]+|[A-Z]{2,}))*)/g;
    while ((m = names.exec(sentence))) {
      const t = m[1];
      const idx = m.index + m[0].indexOf(t);
      if (idx === 0 || /^(I|The|A|An|In|On|At|It|This|That|These|Those)$/.test(t) || MONTHS.test(t)) continue;
      add(t, 'name', 3 + Math.min(1.5, words(t).length * 0.5), idx);
    }
    for (const w of sentence.match(/\b[a-z][a-z-]{5,}\b/g) || []) {
      const n = kw.get(w.toLowerCase()) || 0;
      if (n >= 2) add(w, 'word', 1.5 + Math.min(1.5, n / 4), lower.indexOf(w.toLowerCase()));
    }
    return c.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  }

  // Similar-looking wrong answers for a blank, so multiple choice is a real choice.
  function clozeDistractors(answer, cat, pools) {
    const out = new Set();
    const ans = R.norm(answer);
    if (cat === 'year') {
      const y = parseInt(answer, 10);
      const suffix = /s$/.test(answer) ? 's' : '';
      const docYears = R.shuffle(pools.year.filter((x) => R.norm(x) !== ans && /s$/.test(x) === !!suffix && Math.abs(parseInt(x, 10) - y) < 120));
      for (const x of docYears) if (out.size < 2) out.add(x);
      const steps = suffix ? [10, 20, -10, -20, 30] : R.shuffle([1, 2, 3, 4, 5, 7, 10, 12, 15, -1, -2, -3, -5, -8, -10, -12]);
      for (const d of steps) if (out.size < 4) out.add(String(y + d) + suffix);
    } else if (cat === 'num') {
      const m = answer.match(/^([\d,]*\.?\d+)(.*)$/);
      const docNums = R.shuffle(pools.num.filter((x) => R.norm(x) !== ans && x.replace(/[\d,.\s]/g, '') === answer.replace(/[\d,.\s]/g, '')));
      for (const x of docNums) if (out.size < 2) out.add(x);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        const dec = (m[1].split('.')[1] || '').length;
        for (const f of R.shuffle([0.5, 2, 1.5, 0.75, 3, 1.25, 10, 0.1, 0.6, 1.3])) {
          if (out.size >= 4) break;
          let v = (n * f).toFixed(dec);
          if (m[1].includes(',')) v = Number(v).toLocaleString('en-US');
          if (v !== m[1] && !(/%|percent/.test(m[2]) && Number(v) > 100)) out.add(v + m[2]);
        }
      }
    } else {
      // Same kind of answer first (terms for terms, names for names), then the nearest other kind.
      const order = cat === 'name' ? [pools.name, pools.term] : cat === 'term' ? [pools.term, pools.name] : [pools.word, pools.term];
      for (const pool of order) {
        const ok = pool.filter((x) => R.norm(x) !== ans && !R.norm(x).includes(ans) && !ans.includes(R.norm(x)));
        const byLen = R.shuffle(ok).sort((a, b) => Math.abs(a.length - answer.length) - Math.abs(b.length - answer.length));
        for (const x of byLen.slice(0, 6)) if (out.size < 4) out.add(x);
      }
    }
    const seen = new Set([ans]);
    return [...out].filter((x) => !seen.has(R.norm(x)) && seen.add(R.norm(x))).slice(0, 4);
  }

  /* ---------- main ---------- */

  function generate(rawText, opts = {}) {
    const text = normalize(rawText || '');
    const lines = text.split('\n').map((l) => l.trim());
    const cards = [];
    const usedLines = new Set();
    const known = new Map(); // norm(term) -> original label, for cloze targeting and scoring
    const headings = [];
    let title = '';

    const addCard = (c) => {
      if (!c.front || !c.back || c.back.length < 2) return;
      if (R.norm(c.front) === R.norm(c.back)) return;
      if (c.back.length > 420) c.back = c.back.slice(0, 400).replace(/\s\S*$/, '') + '…';
      cards.push(c);
      if (c.kind === 'term' || c.kind === 'acronym') known.set(R.norm(c.front), c.front);
    };

    // Pass 1: structured lines.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const prev = lines[i - 1];
      const next = lines[i + 1];

      if (isHeadingLine(line, prev, next)) {
        const h = stripMd(line.replace(/^#+\s*/, ''));
        headings.push({ i, text: h });
        const named = h.replace(/^(chapter|unit|lesson|section|part|module|week|topic)\s*[\w.]+\s*[:.\-–—]\s*/i, '');
        if (!title && named && words(named).length <= 10 && !GENERIC_HEAD.test(named)) title = named;
        usedLines.add(i);
        continue;
      }

      // Q: ... / A: ...  or a question on its own line followed by its answer
      const q = line.match(Q_LINE);
      if (q) {
        let j = i + 1;
        while (j < lines.length && !lines[j] && j - i < 3) j++;
        const nl = lines[j] || '';
        let ans = nl.match(A_LINE)?.[1];
        if (!ans && nl && !/\?$/.test(nl) && !isHeadingLine(nl, '', lines[j + 1])) {
          // A question on its own line answered by the line after it.
          ans = splitSentences(stripLead(nl)).slice(0, 2).join(' ');
          if (ans.length > 320) ans = splitSentences(ans)[0];
        }
        if (ans && ans.length <= 360) {
          addCard({ front: stripMd(q[1]), back: cleanDef(ans), kind: 'qa' });
          usedLines.add(i).add(j);
          i = j;
          continue;
        }
      }

      const bulleted = /^(?:[-*+]|\d{1,3}[.)])\s/.test(line);
      const body = stripLead(line);

      let m = body.match(BOLD_LEAD);
      if (m && validTerm(m[1], 'bold', bulleted, true)) {
        let def = m[2].replace(/^(is|are|was|were|refers to|means|is defined as)\s+/i, '');
        def = appendWrapped(def, i);
        addCard({ front: cleanTerm(m[1]), back: cleanDef(def), kind: 'term' });
        usedLines.add(i);
        continue;
      }

      m = body.match(LINE_DEF);
      if (m) {
        const sep = m[2].includes('\t') ? 'tab' : m[2].includes(':') ? 'colon' : m[2].includes('=') ? 'eq' : m[2].includes('>') || m[2].includes('→') ? 'arrow' : 'dash';
        const bold = /^\*\*/.test(body);
        const def = m[3].trim();
        if (validTerm(m[1], sep, bulleted, bold) && def.length >= 2 && !/^\/\//.test(def) && !(sep === 'colon' && /^\d/.test(def) && def.length < 6)) {
          if (sep !== 'dash' || words(def).length >= 2) {
            // Formulas keep their case ("F = ma" must not become "Ma").
            const back = sep === 'eq' ? trimEnd(stripMd(appendWrapped(def, i))) : cleanDef(appendWrapped(def, i));
            addCard({ front: sep === 'eq' ? stripMd(m[1]).trim() : cleanTerm(m[1]), back, kind: 'term' });
            usedLines.add(i);
            continue;
          }
        }
      }
    }

    // Continuation of a wrapped definition line ("Term: starts here\ncontinues here.")
    function appendWrapped(def, i) {
      let j = i + 1;
      while (!/[.!?]$/.test(def) && lines[j] && /^[a-z(]/.test(lines[j]) && !LINE_DEF.test(lines[j]) && def.length < 300) {
        def += ' ' + lines[j];
        usedLines.add(j);
        j++;
      }
      return def;
    }

    // Heading followed by short bullets -> "list" card ("Causes of WW1" -> four items).
    for (let h = 0; h < headings.length; h++) {
      const { i, text: head } = headings[h];
      if (GENERIC_HEAD.test(head) || words(head).length > 8) continue;
      const items = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      while (j < lines.length && /^(?:[-*+]|\d{1,3}[.)])\s/.test(lines[j])) {
        if (!usedLines.has(j)) items.push(stripMd(stripLead(lines[j])));
        else items.push(null);
        j++;
      }
      const clean = items.filter(Boolean);
      if (clean.length >= 2 && clean.length <= 8 && clean.length === items.length && clean.every((x) => words(x).length <= 7)) {
        addCard({ front: head, back: clean.map(trimEnd).join('; '), kind: 'list', hint: `${clean.length} items` });
        for (let k = i + 1; k < j; k++) usedLines.add(k);
      }
    }

    // Pass 2: prose. Join wrapped lines into paragraphs, then split into sentences.
    const paragraphs = [];
    let buf = [];
    let headFor = null;
    let lastHead = null;
    for (let i = 0; i <= lines.length; i++) {
      const l = lines[i];
      const heading = headings.find((x) => x.i === i);
      if (heading) lastHead = heading.text;
      if (l === undefined || !l || usedLines.has(i) || /^(?:[-*+]|\d{1,3}[.)])\s/.test(l)) {
        if (buf.length) paragraphs.push({ text: buf.join(' '), head: headFor });
        buf = [];
        if (l && !usedLines.has(i)) paragraphs.push({ text: stripLead(l), head: lastHead, bullet: true });
        continue;
      }
      if (!buf.length) headFor = lastHead;
      buf.push(l);
    }

    const sentences = [];
    const usedHeads = new Set();
    for (const p of paragraphs) {
      const ss = splitSentences(p.text);
      ss.forEach((s, k) => sentences.push({ s, head: p.head, first: k === 0 && !p.bullet }));
    }

    const fullText = text.replace(/\*\*/g, '');
    for (const a of findAcronyms(fullText)) {
      if (!known.has(R.norm(a.acr))) addCard({ front: a.acr, back: a.phrase, kind: 'acronym', hint: 'What does it stand for?' });
    }

    const defSentences = new Set();
    for (const it of sentences) {
      const d = sentenceDef(it.s, known);
      if (d && !known.has(R.norm(d.front))) {
        addCard({ ...d, explain: '' });
        defSentences.add(it.s);
      } else if (it.first && it.head && !usedHeads.has(it.head) && !GENERIC_HEAD.test(it.head) && words(it.head).length <= 5 && !known.has(R.norm(it.head))) {
        // "Mitosis\nA type of cell division that..." -> heading as the term
        const m = it.s.match(/^(?:it|this|these|they)\s+(?:is|are|was|were|refers to|means)\s+(.{12,})$/i);
        if (m && !/\b(I|we|you)\b/.test(m[1]) && m[1].length < 300) {
          addCard({ front: it.head, back: cleanDef(m[1]), kind: 'term' });
          usedHeads.add(it.head);
          defSentences.add(it.s);
        }
      }
    }

    // Pools of answer-shaped things in this document, for cloze distractors.
    const kw = keywordCounts(fullText);
    const pools = { year: [], num: [], name: [], term: [...known.values()], word: [] };
    const scored = [];
    for (const it of sentences) {
      const s = stripMd(it.s);
      const cands = clozeCandidates(s, known, kw);
      for (const c of cands) if (pools[c.cat] && !pools[c.cat].some((x) => x.toLowerCase() === c.text.toLowerCase())) pools[c.cat].push(c.text);
      if (s.length < 35 || s.length > 260 || /\?$/.test(s) || /^[^a-z]*$/.test(s)) continue;
      const best = cands.find((c) => c.text.length < s.length * 0.55);
      if (!best) continue;
      let score = best.score + Math.min(2, cands.length * 0.3);
      if (PRONOUN_START.test(s)) score -= 1.5;
      if (defSentences.has(it.s) && best.cat === 'term') continue; // already a term card
      if (defSentences.has(it.s)) score -= 2.5;
      if (/\b(I|you|we)\b/.test(s)) score -= 1.5;
      scored.push({ s, best, score, head: it.head });
    }

    const termCount = cards.length;
    const maxCloze = opts.max ? Math.max(0, opts.max - termCount) : Math.max(12, Math.round(termCount * 0.8) + 10);
    const seenAnswers = new Map();
    scored.sort((a, b) => b.score - a.score);
    let clozes = 0;
    for (const x of scored) {
      if (clozes >= maxCloze || x.score < 2) break;
      if ((x.best.cat === 'name' || x.best.cat === 'word') && pools[x.best.cat].length < 3) continue; // no believable wrong answers
      const key = R.norm(x.best.text);
      if ((seenAnswers.get(key) || 0) >= 2) continue;
      seenAnswers.set(key, (seenAnswers.get(key) || 0) + 1);
      const before = x.s.slice(0, x.best.idx);
      const after = x.s.slice(x.best.idx + x.best.text.length);
      addCard({
        front: (before + '_____' + after).trim(),
        back: x.best.text,
        kind: 'cloze',
        cat: x.best.cat,
        explain: x.s,
        distractors: clozeDistractors(x.best.text, x.best.cat, pools),
      });
      clozes++;
    }

    // De-duplicate and cap.
    const seen = new Set();
    let out = cards.filter((c) => {
      const k = c.kind + '|' + R.norm(c.front);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (opts.max && out.length > opts.max) out = out.slice(0, opts.max);

    return {
      title: title || opts.fallbackTitle || 'My study deck',
      cards: out.map(R.newCard),
      stats: { sentences: sentences.length, terms: termCount, cloze: clozes },
    };
  }

  R.gen = { generate, splitSentences, keywordCounts, normalize };
})();
