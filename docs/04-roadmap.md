# 04 - Roadmap

## Phase 0 - Planning
- [x] Capture vision, design, privacy approach in `docs/`.
- [ ] Confirm open questions in `05-decisions.md`. (Name style is settled; the rest are still open.)

## Phase 1 - Foundation + Menu (done 2026-10-18)
- [x] Folder scaffold (`site/`, `tools/`). `tools/` only holds a README until Phase 4.
- [x] Black/white theme, self-hosted monospace font (Geist Mono, OFL, 31 KB woff2).
- [x] Landing menu: logo, clock, the name as a static SHA-256 digest (`631cb8a9`), plain menu words, boot sequence, effects (falling-glyph canvas, glitch, text scramble, grain, scanlines, cursor + spotlight, section transitions).
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
  - [x] Search data from nova-hub's public API, thumbnails from `i.ytimg.com` (in colour).
- Verified in the built-in browser:
  - Onboarding builds a 48-video feed, and scrolling adds the next batch.
  - Interleaving order is correct.
  - Like/subscribe/skip change the right weights.
  - The embed reports watch time.
  - The Shorts reel works.
  - Search, channel, subscriptions and library work.
  - At 375 px there is no horizontal scroll.
  - Hosts contacted: self, `nova-hub.dev`, `i.ytimg.com`, plus `youtube-nocookie.com` on play. No cookies.
  - Parser tests: 41 cases (first version) and 19 for the search box.
- Known: nova-hub's API intermittently returns 502/504. The client retries once; a topic that still fails is skipped for that batch.
- Not verified: Safari, Firefox, a real phone, and how the feed feels after days of real use.

## Phase 3 - Settings panel
- Tab cloak, `about:blank` launcher, panic key, plus the on-page note on what they do and do not hide.
  - The CSP already allows `frame-src 'self'` and `frame-ancestors 'self'` for the launcher. Note: an `about:blank` window inherits the opener's CSP.
  - Set the cloak title and favicon in `js/early.js` so the real ones never flash.

## Phase 4 - Hardening + Leak check
- `tools/` script: strip metadata, scan output for personal strings, local paths, and external URLs.
  - A manual scan on 2026-10-18 came back clean. Allowed hosts are `nova-hub.dev`, `i.ytimg.com` and `www.youtube-nocookie.com`. Other known harmless hits the script must allowlist:
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
- [x] Live on the Hetzner server at `https://631cb8a9.157-180-67-116.sslip.io` (2026-10-19). Real sites tested through it: example.com, Wikipedia, a DuckDuckGo search.

## Phase 6 - Deploy
- Edge/static host, random hostname, wildcard cert, logs off.
- Confirm the host honours `_headers` (Netlify / Cloudflare Pages format) or port the rules to its own config.
