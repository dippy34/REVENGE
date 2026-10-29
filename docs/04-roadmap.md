# 04 - Roadmap

## Phase 0 - Planning
- [x] Capture vision, design, privacy approach in `docs/`.
- [ ] Confirm open questions in `05-decisions.md`. (Name style is settled; the rest are still open.)

## Phase 1 - Foundation + Menu (done 2026-10-18)
- [x] Folder scaffold (`site/`, `tools/`). `tools/` only holds a README until Phase 4.
- [x] Black/white theme, self-hosted monospace font (Geist Mono, OFL, 31 KB woff2).
- [x] Landing menu: logo, clock, the name as a static SHA-256 digest (`631cb8a9`), plain menu words, boot sequence, effects (falling-glyph canvas, glitch, text scramble, grain, scanlines, cursor, section transitions; the spotlight was later removed).
- [x] noindex meta + `_headers` config, CSP (as a header and as a `<meta>` on every page).
- [x] Games and Proxy shown as locked ("soon") entries.
- **Done when:** menu loads with zero external requests, works on phone and desktop, honors reduced-motion.
  - Verified in the desktop app's built-in browser (Chromium) against a local server that applied `_headers`:
    - The menu makes 8 requests, all same-origin. No cookies, no console errors, no CSP violations.
    - At 375 px wide there is no horizontal scroll, and the custom cursor and key hints are off for touch.
    - Keyboard: arrows, j/k, Home/End, number keys and Enter all work. Locked entries answer "soon".
    - Reduced motion: the pane cannot emulate the media query, so it was tested on a copy with the query forced on. Boot was skipped, no custom cursor, a static canvas, grain/sweep/glitch off, scramble instant, no transition delay.
    - Canvas pause: the pane never hides background tabs, so it was tested by overriding `document.hidden` and firing `visibilitychange`. The canvas froze and then resumed.
  - Not verified: Safari, Firefox, a real phone, and the OS-level reduced-motion switch.

## Phase 2 - YouTube (done 2026-10-18, then rebuilt as a feed the same day)
- First version: paste a link or ID, then play it in the no-cookie player, with a recent list.
- Rebuilt on request into a YouTube-style app (details in `05-decisions.md`):
  - [x] "Build your feed" onboarding: type interests, and the first batch is built live.
  - [x] Home feed: 4 weighted topics × ~12 videos, dealt out one from each in turn, deduped, watched pushed to the bottom, endless scroll.
  - [x] Shorts shelf and a vertical Shorts reel (keys, wheel, swipe).
  - [x] Watch page: autoplaying no-cookie player, like, subscribe, not interested, up next.
  - [x] Search (pasting a link plays it), channel pages, subscriptions feed, library.
  - [x] On-device algorithm that learns from opens, watch time, Shorts skips, likes, subscribes, searches and "not interested", with a 14-day half-life.
  - [x] Search data from this origin (`/api/tube-*`), thumbnails from `i.ytimg.com` (in colour).
- Verified in the built-in browser:
  - Onboarding builds a 48-video feed, and scrolling adds the next batch.
  - Interleaving order is correct.
  - Like/subscribe/skip change the right weights.
  - The embed reports watch time.
  - The Shorts reel works.
  - Search, channel, subscriptions and library work.
  - At 375 px there is no horizontal scroll.
  - Hosts contacted: self, `i.ytimg.com`, plus `youtube-nocookie.com` on play. No cookies.
  - Parser tests: 41 cases (first version) and 19 for the search box.
- Known: YouTube intermittently returns 502/504. The client retries once; a topic that still fails is skipped for that batch.
- Not verified: Safari, Firefox, a real phone, and how the feed feels after days of real use.

## Visual overhaul (2026-10-19)
- [x] Every page restyled in the black-and-white terminal theme: menu, boot, 404, all YouTube views, games and player, proxy (both engines), stats. See `02-design.md` and `05-decisions.md`.
- Verified in headless Chrome against the real `server.mjs` at 1440 px and 375 px:
  - **Errors:** no exceptions and no CSP violations from our own pages.
  - **Hosts contacted:**
    - menu, 404 and stats: self only
    - YouTube: self, `i.ytimg.com` and `www.youtube-nocookie.com`
  - **Phone:** no horizontal scroll at 375 px on any page.
  - **Flows:**
    - menu keyboard and boot skip
    - onboarding builds a feed, which lands on #/home with 48 cards
    - infinite scroll (48 → 144 cards)
    - like toast, reel j/k
    - games search, saved filter, opening and closing the player
    - proxy address bar in both engines, stats wrong key
  - **Reduced motion:** static frames on the menu, YouTube home and games.
  - **Speed:** about 16.6 ms per frame while scrolling 144 cards.
- Not verified:
  - Safari, Firefox and a real phone.
  - The stats dashboard with a real `STATS_KEY` (only checked with fake data).
  - The proxy access-key dialog with a real key.

## Effect levels, easter eggs, ghost AI (2026-10-19)
- [x] Effect levels (high/mid/low) with automatic detection, 15 easter eggs, and the hidden `/ghost/` AI terminal. Decisions are in `05-decisions.md`.
- Verified in headless Chrome against the real server:
  - **Effect levels:**
    - no slowdown: stays high
    - 4x/6x CPU slowdown: drops to mid/low after ~2.5 s, with 2-4x more idle main-thread time
    - `?fx=` forces a level
    - a cached level applies before first paint
  - **Eggs:** every egg triggers on desktop and 375 px. Nothing fires while typing in a field, and the existing keyboard shortcuts still work.
  - **Ghost:**
    - the door works from the mask, the logo and the console
    - asleep state without a key
    - mock streaming
    - limits return 400/413/415/429
    - server tests pass (45)
    - a real conversation on Haiku 5.5 (2026-10-21), through curl and through the page
  - No console errors, CSP violations or new hosts, and no horizontal scroll at 375 px.
- Not verified:
  - real weak hardware, Safari / iPad, and real phone touch input

## Phase 3 - Settings panel
- Tab cloak, `about:blank` launcher, panic key, plus the on-page note on what they do and do not hide.
  - The CSP already allows `frame-src 'self'` and `frame-ancestors 'self'` for the launcher. Note: an `about:blank` window inherits the opener's CSP.
  - Set the cloak title and favicon in `js/early.js` so the real ones never flash.

## Phase 4 - Hardening + Leak check
- `tools/` script: strip metadata, scan output for personal strings, local paths, and external URLs.
  - A manual scan on 2026-10-18 came back clean. Allowed hosts are `i.ytimg.com` and `www.youtube-nocookie.com`. Other known harmless hits the script must allowlist:
    - the SVG `xmlns` namespace URL
    - the URLs inside `assets/fonts/OFL.txt`
    - the bare YouTube host names in the link parser in `js/yt-app.js`
  - Set fixed file timestamps as part of the script. They were set once by hand, and every edit resets them.
- Verify headers and noindex on every route.
- Headless-browser check: no cookies, no unexpected requests.

## Phase 5 - Proxy (built 2026-10-19)
- [x] Scramjet + Wisp on our own server (`server/`), with pinned versions. Details and test results are in `06-backend.md`.
- [x] Browser shell at `/proxy/`: address bar (search or URL), back/forward/reload, new page, fullscreen, quick links, access-key prompt.
- [x] No logging; private/loopback addresses blocked; web ports only; optional access key.
- [x] Live on the Hetzner server at `https://631cb8a9.com` (2026-10-19; also `www.` and an sslip.io backup). Real sites tested through it: example.com, Wikipedia, a DuckDuckGo search.

## Music (built 2026-10-28, cut down 2026-10-29)
- Under the menu's `other` entry, tagged experimental. `music/` (Preact, TypeScript, Vite) built into `site/music/`; the backend is `server/music.mjs`.
- Done means: search and play on desktop and phone, the YouTube player always visible, no third-party requests beyond YouTube's player and thumbnails, unit and browser tests green.
- Not done: deploying the build to the live server.

## Phase 6 - Deploy
- Edge/static host, random hostname, wildcard cert, logs off.
- Confirm the host honours `_headers` (Netlify / Cloudflare Pages format) or port the rules to its own config.
