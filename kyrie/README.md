# Kyrie

A study app: upload your study material and it builds flashcards, quizzes, practice tests and games from it.

It is a standalone static site, separate from the rest of this repo. There is no build step, no server code and no account.

## Run it

```bash
cd kyrie
npm install
npm start
```

Then go to http://localhost:8130. Opening `index.html` directly also works, but without the server the Claude card maker is unavailable (the built-in one still works).

## Claude for everyone

Visitors never need their own key. `server.mjs` holds the site owner's Anthropic API key and makes the cards; the browser only sends the study material to `/api/cards`.

- Put the key in `kyrie/.env` (copy `.env.example`): `ANTHROPIC_API_KEY=sk-ant-...`. If `.env` has no key, the server uses `ANTHROPIC_API_KEY` from the environment. `.env` is ignored by git.
- The key never reaches the browser, and the endpoint only makes flashcards (the server writes the prompt), so it can't be used as a free general-purpose Claude.
- Limits protect the balance: one deck at a time per visitor, 8 per visitor per hour, 60 per hour for everyone, and `KYRIE_DAILY_MAX` (default 150) per day. Requests from other websites are refused.
- `KYRIE_MODEL` picks the model (default `claude-opus-5-5`; `claude-haiku-5-5` is far cheaper). Opus 5.5 is $4 per million input tokens and $20 per million output tokens.
- `KYRIE_MOCK=1` returns sample cards without calling Claude, for testing.
- The server listens on 127.0.0.1 by default. To put it on the internet, run it behind a reverse proxy such as Caddy (`reverse_proxy 127.0.0.1:8130`); the per-visitor limits read the proxy's `X-Forwarded-For`.

## What it does

- **Upload anything:** PDF (including scanned pages), Word `.docx`, PowerPoint `.pptx`, photos of notes, `.txt` / `.md`, `.csv` / `.tsv` (Quizlet-style term lists), `.html`, `.rtf`, or pasted text. Drop files anywhere on the page.
- **Card maker:**
  - **Instant** (built in, free, works offline): finds definitions (`Term: definition`, "X is…", "X refers to…", "…is called X"), Q&A pairs, acronyms, heading + bullet lists, then turns the most testable remaining sentences (dates, numbers, names, key terms) into fill-in-the-blank cards with believable wrong answers. Photos and scanned PDFs are read with on-device text recognition (OCR).
  - **Claude**: provided by the site (see below). Claude reads the material (including photos of handwriting) and writes the cards, plus three wrong answers and a short explanation for each.
- **Review before saving:** edit, delete or add cards.
- **Study modes:**
  - **Flashcards:** flip, rate Again / Hard / Good / Easy. Spaced repetition schedules each card's next review.
  - **Learn:** adaptive rounds that start with multiple choice and move to typed answers. Missed cards come back in the same round.
  - **Practice test:** a graded test with multiple choice, true/false and written questions, a letter grade, and a "retest the misses" button.
  - **Match:** race the clock pairing terms with answers.
  - **Comet Run** (game): dodge comets and grab stars. Crash and you answer a question; get it wrong and you lose a heart. Blue orbs are bonus questions.
  - **Lightning** (game): 60 seconds of true/false with a streak multiplier.
- **Intro and tour:** first-time visitors see an intro page (animated app preview, feature tiles, how it works), then a short interactive tour (flip a card, answer a question). Help → "Take the tour" opens it again; nothing in either is saved as study data.
- **Pages:** Home (today's goal, due reviews, this week, recent activity), Library (search, subjects, sort, grid or list), each deck (Study, Cards and Activity tabs), Progress (activity heatmap, streaks, mastery by deck, personal bests), Settings and Help.
- **Everything else:** mastered / learning / new counts, due-card reviews, day streak, starred cards, read-aloud, light/dark theme, export (Kyrie deck file, tab-separated text for Quizlet/Anki), print, and full backup/restore.

## Live at kyriestudy.com

Kyrie runs on the same Hetzner box as the 631 site, from the same checkout
(`/opt/revenge`), as the `kyrie` systemd service on `127.0.0.1:8130` behind Caddy.
DNS at IONOS: `A @` and `A www` set to `157.180.67.116`, no `AAAA` records.
After `server/setup-native.sh` has run once, as root on the box:

```sh
DOMAIN='kyriestudy.com, www.kyriestudy.com' bash /opt/revenge/kyrie/setup-native.sh
```

The first run also needs `ANTHROPIC_API_KEY=...` (or it borrows the 631 site's key
from `/etc/revenge.env`); it is saved in `/etc/kyrie.env`. Re-run the same command
to update to the latest `main`.

## Data and privacy

Decks and progress are saved in the browser's `localStorage` (key `kyrie.v1`), so they stay on that device and browser. Use Settings → Back up everything to move them. Study material leaves the browser only when the student picks Claude as the card maker; it goes to this site's server and from there to Anthropic, and is not stored.

The PDF, Word, PowerPoint and OCR readers load from a CDN the first time a file of that type is added.

## Files

```
kyrie/
  index.html
  css/app.css      design system and every screen (light + dark)
  js/util.js       DOM/text helpers, icons, sound, toasts, modal
  js/store.js      localStorage persistence, spaced repetition
  js/parse.js      file readers (PDF, DOCX, PPTX, CSV, images, OCR)
  js/generate.js   built-in card generator
  js/ai.js         asks this site's server for Claude-written cards
  server.mjs       serves the app and /api/cards (holds the API key, enforces limits),
                   and the 631 site behind its door (../server/app.mjs, ../site)
  setup-native.sh  installs or updates Kyrie on the box (see above)
  js/quiz.js       builds questions (multiple choice, true/false, written) from cards
  js/ui.js         shared question card, settings, theme
  js/views.js      create flow, deck page, print
  js/pages.js      home, library, progress, settings, help
  js/intro.js      intro page and first-run tour
  js/modes.js      flashcards, learn, practice test
  js/games.js      match, comet run, lightning
  js/app.js        router and startup
```
