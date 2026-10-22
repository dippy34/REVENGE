# 07 - The signal (DEAD AIR)

A puzzle hunt that runs across the whole site. Each **frequency** is a chain of stages that
needs real deduction, real execution, or both; a new one opens every second Monday and stays
live for 28 days, with short **interludes** in between. Nothing is added to the menu: while a
frequency is live, a few existing surfaces read slightly differently, and working out what
they point to opens the way in.

This page describes the engine and how to run it. It contains no puzzle content and never
will: content, answers and walkthroughs exist only encrypted in the repo and in a private,
gitignored folder on the builder's machine.

## Pieces

| Piece | What it does |
|---|---|
| `server/hunt.mjs` | the engine and every `/api/hunt/*` route |
| `server/hunt-lib.mjs` | shared primitives: sealing, signing, answer hashing, the question grammar, probe matching |
| `server/hunt-routes.mjs`, `hunt-play.mjs`, `hunt-runs.mjs` | the routes, split by job: status / door / state / stage / answer / echo / certificate / recover; probes / planchette questions / wall / tally / walkthrough / sandbox admin; ranked runs of the skill stages |
| `server/hunt-fixture.mjs` | a synthetic pack and a running test engine, for the tests only (no real content) |
| `server/hunt/<id>.pack` | one frequency's content, AES-256-GCM encrypted (committed; ciphertext only) |
| `server/hunt/<id>.src.sealed` | encrypted backup of the private content source |
| `server/hunt/<id>.walkthrough.sealed` | the owner's encrypted walkthrough (see "The owner's walkthrough") |
| `server/hunt/<id>.walk-public.sealed` | the walkthrough published when the frequency goes cold; the server does not open it before then |
| `site/js/hunt.js`, `site/css/hunt.css` | the client: inert unless a frequency is live or the visitor holds a pass |
| `site/rx/` + `site/js/hunt-rx.js` | the hidden receiver page and its generic stage views |
| `site/js/hunt-run.js` | the harness for skill stages (practice and ranked runs) |
| `site/js/hunt-sim.js` | a deterministic integer simulation, the same file in the browser and on the server |
| `tools/hunt-*.mjs` | keys, seal, open, sandbox, attack bots, and the generator kit |

All public code is generic: renderers, the engine, verification and the simulation. What a
stage says, what counts as an answer, which conditions open a room, the hidden grids and
goals all come from the encrypted pack, and the server sends each piece only after the gate
before it has been passed. The private content folder is ignored as `/hunt/` (anchored to the
repo root), so `server/hunt/` with the sealed files stays committed.

## Life of a frequency

1. **Sealed.** The builder generates the content from a secret seed with
   `tools/hunt-seal.mjs`, which validates every stage (each answer unique, every claim
   checked against how the site really behaves, every grid solvable within its question
   budget, every skill stage completable by a bot and humanly playable), scans the repo for
   leaks, checks that nothing already sealed changed by accident, and writes the sealed files.
   It prints only pass or fail.
2. **Playtested.** Blind solvers and red-team agents play it in the sandbox (below). A
   frequency opens on its date only if the playtest targets are met; otherwise its opening
   date moves (it is pack config) and it is sealed again.
3. **Live.** From `opensAt` (UTC) until `coldAt`, the engine serves the frequency. Some
   steps unlock by UTC day, the final step is not accepted before a set day (day 8 for
   freq 01), and holders of the previous frequency's certificate get in 12 hours early.
4. **Cold.** After 28 days: time-locks lift, the walkthrough is served on the receiver, the
   wall of first solvers freezes, stored progress is deleted, and only "late" certificates
   are issued.

There is one clock, UTC, shown on the receiver.

## Passes and certificates

- **Pass.** Opening the door mints an anonymous token: a random id plus the solved-stage
  bits, signed with Ed25519 (`p1.<payload>.<signature>`). It lives in the visitor's
  `localStorage` and can be exported as a string to move to another browser. It is never put
  in a URL.
- **Recovery code.** The receiver also shows a short code (the pass's random id). While the
  frequency is live, entering it on the receiver restores the pass from the server's record,
  for players whose browser storage gets wiped. It is as private as the pass itself, and it
  never mints a new pass.
- **Certificate.** Solving a frequency issues `c1.<payload>.<signature>`: frequency, solve
  day, and flags for "unlit" (no hints used) and "late". The public key is in `hunt.js`, so
  the browser checks it itself (WebCrypto Ed25519, with `POST /api/hunt/verify` as a fallback
  for older browsers). A verified certificate unlocks cosmetic extras: a solver mask on the
  menu (gold when unlit), a solver tint, a different `whoami`, the 16th egg row, and a
  different greeting on `/ghost/`. The greeting is chosen in the browser; the AI is told
  nothing, and its requests are identical with or without a certificate. A certificate of the
  previous frequency also opens the next one's head start, at most twice per certificate.
- **Variants.** Every reasoning stage exists in several variants, and some steps are drawn
  separately for each pass. Each pass is assigned its variant and draws by a keyed hash, so
  methods can be shared (teams are welcome) but a posted answer fails for most other players.
- **Answers** are checked as HMACs of normalised text, per variant and pass. Plain server code
  checks every answer. The AI never does, and its prompt says it knows nothing about the
  signal. Answers can be sent from the receiver or with `/signal <words>` on `/ghost/`, which
  says plainly that it goes to the signal and is never sent to the AI. Each stage has its own
  daily number of attempts.
- **Skill stages.** Each ranked run gets a secret committed by hash at the start. Every random
  event in the run (a spawn, say) has its own seed derived from that secret, and the server
  releases each seed only when the run has reached the event before it, so the browser never
  knows more than one event ahead. The browser uploads its inputs as it plays; the server
  continues its own copy of the run from where the last upload ended (an upload can never
  rewrite earlier play), requires that the run never ran ahead of real time, checks that the
  timing is humanly plausible for the declared device, and only then accepts the result. The
  secret is revealed at the end so the player can check every seed. Practice runs never touch
  the server.

## Privacy

What the server stores, all in one small file (`<STATS_DIR>/hunt/state.json`, by default
`server/.data/hunt/` locally and `/var/lib/revenge/hunt/` on the server):

| Stored | Granularity | Deleted |
|---|---|---|
| per pass, under a keyed hash of its id, only once the pass has spent something (an answer, a question, a ranked run, a hint): the day each stage opened and was solved, hint tiers used, lantern counts, questions and attempts used per day | UTC days and counts only | when the frequency goes cold; earlier for passes with no solve and no activity for a week |
| how many passes solved each stage (for the global hint drip) | counts | kept, frozen at cold |
| how many ranked runs failed the timing checks, per stage (to tune the checks) | counts | kept, frozen at cold |
| how many head-start passes each previous-frequency certificate opened, under a keyed hash | counts | when that frequency goes cold |
| the wall: opt-in 3-letter handles and solve day, first 10 per frequency | handle + day | kept |
| the ending tally | counts | kept |

Never stored or logged: IP addresses, pass ids, answers or guesses, questions asked, probe
data, run inputs, timestamps finer than a day. Opening the door stores nothing. Rate limits
use a keyed hash of the address (the same rule as the ghost: an IPv6 address counts as its
/64; wider limits use the /24 or /48) held in memory only, with a key that changes daily.
Active runs, cooldowns and the "already asked today" memory are also in memory only and vanish
on restart (a restart closes that day's questions for players who had already asked some; the
rest move to the next day).

**Probes.** Some stages react to how a page is being used. Pages then send a small snapshot
of coarse, allowlisted facts (which section, tint and effects level, which eggs were found,
a short list of recent site events such as a console command name, the screen class) to
`POST /api/hunt/probe`. Only visitors holding a pass for that stage send them. The server
looks only at the most recent events, drops snapshots that could not come from real use, and
matches the rest in memory; nothing is kept. Never sent: the stats key, proxy addresses or
anything inside the proxy frame, YouTube searches, video or channel ids, typed text, console
arguments outside a short allowlist.

**The console** forwards a line to the server only when it matches one narrow shape that the
server publishes while a frequency is live. Every other line stays in the browser, as before.

**The status check.** While the hunt is on, each tab asks `GET /api/hunt/status` about once
per session (cached in `sessionStorage`). It carries nothing about the visitor. Only during a
head-start window does a browser holding the previous frequency's certificate send it, once.

## Secrets and production setup

Four secrets. The server needs three of them.

| Name | Purpose | Where |
|---|---|---|
| `HUNT_KEY` | encrypts the packs and the source backup; part of the walkthrough keys | `server/.env` and the server |
| `HUNT_HMAC` | answer hashes, variants, storage keys | `server/.env` and the server |
| `HUNT_SIGN_KEY` | signs passes and certificates (Ed25519) | `server/.env` and the server |
| `HUNT_SEED` | content generation | only `hunt/seal.env` on the machine where you seal; never on the server |

1. On the builder's machine: `node tools/hunt-keys.mjs` adds any missing ones without printing
   them (`HUNT_SEED` goes to `hunt/seal.env`, the others to `server/.env`, both gitignored and
   mode 0600). `--check` lists which exist, `--public` prints the public key, `--write-pub`
   writes it into `site/js/hunt.js`. Keep a private copy of `hunt/seal.env`: without it an
   errata re-seal cannot reproduce the same content.
2. On the server, copy only the three runtime lines into `/etc/revenge.env` (root only, next
   to `ACCESS_KEY`), for example
   `grep -E '^HUNT_(KEY|HMAC|SIGN_KEY)=' server/.env | ssh root@<server> 'cat >> /etc/revenge.env'`,
   then re-run `setup-native.sh` or `systemctl restart revenge`. With Docker, add the same three
   lines to `server/.env` on the server. The engine warns at startup if `HUNT_SEED` is present.
3. Check: `curl -s https://<domain>/api/hunt/status` shows `"on":true`, and the service's
   startup line names the loaded packs. Without the keys the hunt is simply off and the rest
   of the site is unaffected.

The production server and the sealing machine must use the **same** `HUNT_KEY`, `HUNT_HMAC`
and `HUNT_SIGN_KEY`. Rotating `HUNT_HMAC` or `HUNT_SIGN_KEY` while a frequency is live breaks
every pass and certificate of that frequency; `hunt-keys --rotate` refuses unless forced.

## Adding a frequency or an interlude

1. Write the content in the private folder `hunt/<id>/` (gitignored): a manifest
   (`freq.mjs`: schedule, stage list, alphabets, dials, response lines) and one plugin per
   stage (`stages/*.mjs`), each with a generator, a validator and a walkthrough function.
   Interludes are the same with two or three stages and an interlude certificate.
2. `node tools/hunt-seal.mjs <id> --check` until it prints PASS, then
   `node tools/hunt-seal.mjs <id>` to write `server/hunt/<id>.*`.
3. Commit the sealed files only. Deploy as usual; the engine picks up new packs within a
   minute and serves each one by its schedule.
4. **Errata:** add a line to the manifest's `errata`, bump `rev`, re-seal with
   `--allow <stage>` naming the stage you meant to change. The seal compares against the
   pack already in `server/hunt/` and fails if any other stage changed, so a fix can never
   silently alter a stage players already have open. The errata line appears on the 404 page.
5. While a frequency is live, do not change the site files its stages depend on; the seal
   records their hashes. Before deploying any site change, run
   `node tools/hunt-seal.mjs <id> --frozen` (the engine also warns at startup).

## Sandbox and playtesting

`node tools/hunt-sandbox.mjs --port 8095 --fresh` starts a local server in sandbox mode with
its own data folder and the ghost in mock mode. The clock runs at real speed by default
(`--speed` can compress it); playtests run at real speed and the operator jumps the clock
from one day to the next.

Sandbox mode cannot run in production by accident: the server refuses to start in sandbox
mode when `NODE_ENV` is `production`, when it listens on anything but a loopback address,
when `STATS_DIR` is set, or when its data folder is not a sandbox folder. In sandbox mode it
signs and keys everything with keys derived separately from the real ones, so sandbox passes
and certificates never work in production (and the reverse). The extra routes under
`/api/hunt/sandbox/` (mint a pass, jump a pass to a stage, set the clock) and the walkthrough
route answer only to a request from the machine itself, with no forwarding headers, carrying
an admin token that is generated at each start and shown only on the operator's terminal.
Without all three they look like routes that do not exist.

`node tools/hunt-bot.mjs` attacks a local sandbox: probe enumeration, answer brute force,
replayed, rewritten or forged runs, and forged passes and certificates (all of which should
fail). It refuses to talk to anything but a loopback address. The driver that plays the skill
stages with human-like timing, used to set pars and timing checks, is kept private.

Before a frequency goes live, blind solver agents play it from the player's view only and
report whether each stage was solvable, how long it took and where they got stuck, and
red-team agents with the repo try to forge, replay, brute-force and bot their way through.
The dials are tuned until both groups' targets are met.

## The owner's walkthrough

The walkthrough is sealed per stage. As sealed, it cannot be read at all: the tool refuses
until you lock it with a passphrase only you know. Run on your own machine:

```sh
node tools/hunt-open.mjs freq-01 --set-passphrase
```

It asks twice (nothing is shown as you type; at least 16 characters, four or more random
words recommended) and re-wraps every stage so that opening it needs both your passphrase and
`HUNT_KEY`. The committed file therefore cannot be cracked offline by guessing passphrases.
To read one stage when you are stuck:

```sh
node tools/hunt-open.mjs freq-01 --stage s3
```

It shows that stage's method, then asks for your pass (paste it from the receiver's export)
so it can show the details of your own variant. It opens exactly one stage per run. If the
walkthrough is re-sealed with changes, it is wrapped as sealed again and the tool tells you to
set the passphrase again.

What the passphrase does and does not do: it keeps the walkthrough from being opened by
accident, by you or by anything running on your machine. It does not hide the content from
someone who holds `HUNT_KEY`: they can open the packs, and the public walkthrough file that
the server only reads once the frequency is cold.

## Rate limits (defaults; a pack can tighten them)

Fair-play limits are per pass. Limits per address are only ceilings against abuse, set
several times higher, because schools and mobile networks put many players behind one address.

| What | Limit |
|---|---|
| door attempts | 120 per hour per address, 600 per hour per network; up to 300 new passes per address per day |
| answers | each stage's daily attempts per pass (12 for most stages), 48 per pass per day in total, at least 1.5 s apart; 1200 per hour per address |
| probes | one per 3 s per pass, 1500 per pass per day, 240 per minute per address |
| planchette questions | the stage's daily budget, plus 600 per hour per address |
| ranked runs | one at a time per pass, 30 per day; the final step has its own daily attempts and cooldown |
| recovery codes | 10 per hour per address |
| everything else | 60 per minute per pass, 600 per minute per address |

Over a limit the server answers 429 with `retry-after`, and the client backs off.

## Tests

`cd server && npm run check` runs `hunt.test.mjs` (formats, signing, answers, every route,
limits, purge, the sandbox guards, no logging) and `hunt-sim.test.mjs` (determinism and golden
traces). `tools/hunt-seal.mjs` runs the content validators, the leak check and the errata
check. The simulation's self-test is also run in Chrome and WebKit so the browser and the
server agree tick for tick.

## Honest limits

- Proxied pages run on this site's origin, so a hostile page opened through the proxy could
  read `localStorage`, including a pass, a recovery code or a certificate. A stolen pass can
  spend that player's attempts; a copied certificate shows the cosmetic extras elsewhere and
  can open at most two head-start passes.
- Certificates prove a solve happened, not who holds them.
- Variants can be re-rolled: someone can open the door several times and keep the pass whose
  variant matches a leaked set of answers. Because some steps are drawn per pass, that skips
  only the early stages; the multi-day step and both skill stages still have to be done on the
  player's own pass.
- Hints used on a spare pass leave the main pass "unlit", and one person can hold several
  wall slots on different days.
- The device mode (keyboard or touch) is declared by the browser. Touch has its own timing
  checks and goals, so it is a different game rather than an easier one, but a keyboard
  player can still choose it.
- A bot that imitates human timing can clear the skill stages; it never sees more than one
  event ahead, and the checks make it expensive, not impossible.
- How each kind of stage works (the receiver's views, the question grammar, the simulation)
  is public code from the first day; only the content, conditions, grids, goals and answers
  are sealed.
- Hint timing counts whole UTC days, not hours.
- Memory-only state (cooldowns, the "already asked today" rule) resets when the server
  restarts; that day's remaining questions move to the next day.
- The public walkthrough file is protected against accidents, not against holders of
  `HUNT_KEY`.
