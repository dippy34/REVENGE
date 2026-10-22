# tools/

Scripts that run on the builder's machine. Nothing in here is deployed.

- **The weekly signal's tools** (see `docs/07-hunt.md`). All take `--root <dir>` to work on another checkout (the tests use throwaway ones):
  - `hunt-keys.mjs`: creates and checks the secrets. `HUNT_KEY`, `HUNT_HMAC` and `HUNT_SIGN_KEY` go in `server/.env`; `HUNT_SEED` goes only in `hunt/seal.env`. Never prints a value. `--check`, `--move-seed`, `--public`, `--write-pub`, `--rotate NAME`.
  - `hunt-seal.mjs <id>`: generates a frequency from its private source in `hunt/`, runs every check (plugin validators, global checks, determinism, errata safety, leak scan) and writes the sealed files to `server/hunt/` only if everything passes. `--check` writes nothing; `--only`, `--allow`, `--against`, `--leaks`, `--frozen`. Its output never contains content.
  - `hunt-open.mjs <id>`: the owner's walkthrough reader. Needs a terminal; passphrases are typed at a hidden prompt, never passed as arguments. Opens one stage per run. `--set-passphrase`, `--list`, `--stage sN`, `--restore-src`.
  - `hunt-sandbox.mjs`: a loopback copy of the server with the hunt in sandbox mode (sped-up clock, mock AI, its own data directory), for playtests.
  - `hunt-kit.mjs` (generator kit for the content plugins), `hunt-env.mjs` and `hunt-checks.mjs` (shared by the tools above).
  - Tests: `server/hunt-tools.test.mjs` and `server/hunt-seal.test.mjs` run the tools as real processes against throwaway repos with a synthetic frequency (`server/hunt-synth.mjs`); run them with `npm --prefix server run check`.

Planned for Phase 4 (see `docs/04-roadmap.md`):

- **leak check:** scan `site/` for external URLs (other than `youtube-nocookie.com`), the plain site name, personal strings, absolute local paths, and OS junk files such as `.DS_Store`.
- **metadata strip:** remove EXIF, author fields and editor metadata from assets, and set fixed file timestamps.
- **headless check:** load every route and confirm there are no cookies and no unexpected requests.
