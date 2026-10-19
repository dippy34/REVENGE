# 05 - Decisions, Open Questions, Limits

## Decided
- Sections: YouTube, Games and Proxy, all live as of 2026-10-19 (see below).
- Build the menu and YouTube first.
- Black and white theme only.
- Internal name is "Revenge"; the public-facing title is encoded or hinted, never plain.
- YouTube plays through the no-cookie embed.
- No `.onion` mirror.
- Static site plus one proxy server (`server/`, Hetzner); no third-party analytics, no logs; an anonymous self-hosted visit counter since 2026-10-19.
- Tab cloak, `about:blank` launcher, and panic key are included as optional visitor settings.
- Effects: noise/matrix background, glitch text, grain, scanlines, custom cursor, boot sequence.

### Site shell (2026-10-18)
- **Name style: static hash digest.** The title is `631cb8a9`, the first 8 hex characters of SHA-256 of the capitalised name.
  - The "sha256:" label was dropped on request.
  - On hover the hex churns and glitches, then settles back. It never decodes.
  - The word is not in `site/` in any form.
  - Tab titles are `~` (menu) and `~/v` (YouTube).
- **Menu is minimal:** logo, clock, title, effects, and plain words (youtube, games, proxy). There is no footer, status line or route counter.
  - Locked entries are dim. Activating one shakes it and briefly scrambles it to "soon".
- **Docs win over the original build prompt** on three points:
  - The settings panel stays in Phase 3.
  - A self-hosted font is used.
  - The leak-check script stays in Phase 4.
- **Font:** Geist Mono, a variable font (weights 100-900), latin woff2, 31 KB. It is SIL OFL 1.1, and the license is in `site/assets/fonts/OFL.txt`.
- **Boot screen:** first visit only (`localStorage` key `boot`). It is skipped when storage is blocked or reduced motion is on.
- **Headers:**
  - `site/_headers` (Netlify / Cloudflare Pages format) sets: CSP, `Referrer-Policy: no-referrer`, `X-Robots-Tag`, HSTS, a restrictive `Permissions-Policy` (autoplay, fullscreen, picture-in-picture and encrypted-media allowed only for self and the embed), `nosniff`, `X-Frame-Options: SAMEORIGIN`, COOP/CORP same-origin.
  - Every page repeats the CSP as a `<meta>` tag, minus `frame-ancestors`.
- **CSP:**
  - `default-src 'none'`, with only `'self'` for scripts, styles and fonts.
  - `img-src 'self' https://i.ytimg.com` and `connect-src 'self'` (YouTube search is same-origin).
  - `frame-src 'self' https://www.youtube-nocookie.com`.

### YouTube feed (2026-10-18, replaces the Phase 2 link-in/player-out page)
- **Search data comes from this origin** (`/api/tube-search`, `/api/tube-video` on `server/tube.mjs`). The browser does not contact nova-hub.
  - The server calls YouTube's own InnerTube web API (the same one youtube.com uses). No YouTube Data API key. Searches are not stored.
  - GitHub Pages has no server, so the YouTube feed only works on the main host (same as the proxy and the game relays).
  - The client (`js/yt-api.js`) validates every field, renders text only, caches results in `localStorage` for 30 min (details 6 h), and retries once.
- **Thumbnails load from `i.ytimg.com`** while browsing, chosen by the user, and are shown in colour (switched from grayscale on request).
  - Videos use the light `mqdefault` size. Shorts use the vertical URL the API returns, but only if it is on `i.ytimg.com` for that same video.
  - Avatars are monograms, not images: one less host, and no faces.
- **Onboarding:** opening YouTube with no profile shows "build your feed".
  - You type interests (or pick from ideas), then the first batch is built live with a log.
  - Library → "edit & rebuild" brings it back.
- **Feed algorithm** (`js/yt-profile.js`, on-device only):
  - **Batches:** each batch picks 4 topics by weighted sampling (stronger topics more often, a +0.5 floor so weaker ones still appear). It takes ~12 videos per topic and deals them out one from each in turn.
  - **Filtering:** it then drops duplicates, hidden videos and channels at weight ≤ -3, and pushes watched videos to the bottom.
  - **Repeats:** a topic picked twice gets its next page, and leftovers from a page are kept for the next batch.
  - **Signals and weights:**

    | Signal | When | Topic | Channel | Title words |
    |---|---|---|---|---|
    | open | open a video | +0.5 | +0.5 | +0.3 |
    | watch | watched ≥ 60 s or half, or a Short watched through or looped | +1 | +1.5 | +1 |
    | skip | Short left within 3 s | −0.5 | −0.6 | −0.3 |
    | like | like (unlike reverses it) | +2 | +3 | +2 |
    | subscribe | subscribe (unsubscribe reverses it) | – | +6 | – |
    | hide | "not interested" | −1 | −3 | −1 |
    | search | search for something | +2.5 (a new topic) | – | – |

  - A Short is judged only when you leave it.
  - A title word that reaches weight 6 becomes its own topic.
  - All weights halve every 14 days.
  - Watch time comes from the embed's own progress messages (`enablejsapi=1`, a "listening" postMessage). YouTube's iframe API script is not loaded.
- **Likes, subscriptions, history, "not interested"** are local only. Accounts are ruled out, so nothing reaches YouTube.
  - Keys: `yt.profile`, `yt.likes`, `yt.subs`, `yt.history`, `yt.hidden`, `yt.cache`.
  - Library → "forget everything" wipes them.
- **Views:**
  - home (Shorts shelf and endless feed)
  - Shorts reel (one at a time; arrows, j/k, wheel and swipe move between them)
  - watch (player, subscribe/like/not interested, up next)
  - search (Shorts shelf and results; pasting a YouTube link plays it)
  - channel, subscriptions (latest uploads from up to 12 channels), library
- **Player:**
  - The `youtube-nocookie.com` embed now autoplays on click, like YouTube, and Shorts loop.
  - The sandbox is still `allow-scripts allow-same-origin allow-presentation`, and the iframe sends `referrerpolicy="strict-origin"`. YouTube refuses embeds that send no Referer at all (Error 153, confirmed in the browser).
  - The video and thumbnails keep their colour. The site's own interface stays black and white.

## Open questions
1. ~~**Proxy scope**~~ decided 2026-10-19, see "Proxy" below.
2. **Hosting provider and domain** (pseudonymous registration).
3. **Passphrase gate:** yes or no?
4. **"Watch on YouTube" inside the player:** the sandbox blocks popups, so the player's YouTube logo and its fallback for videos that disallow embedding do nothing. Should `allow-popups` be added?
5. ~~**Depending on nova-hub.dev**~~ decided 2026-10-19: the feed uses `/api/tube-*` on our server instead.

## Will not build
- Anything meant to target, harass, expose, or deceive a specific person or group.
- Anything that collects or stores visitor data.
- Tools meant to evade law enforcement, or hosting for abusive or illegal content.

## Honest limits
- Cloaking features hide things only from someone looking at the screen or browser history, not from network monitoring.
- A public URL cannot be made invisible to everything. It can be kept out of search and discovery.
- The digest is a hint, not a secret. An unsalted hash of a dictionary word can be reversed with a simple lookup.
- **YouTube sees** the server's IP for every search, channel view and details fetch (InnerTube). It does not see the visitor's IP for those calls. Search phrases still leave this machine.
- **YouTube sees** visitor IPs:
  - while browsing, via thumbnails from `i.ytimg.com`
  - once a video plays, via the embed, which also learns the site's origin
  - The embed may set its own storage on `youtube-nocookie.com`. This site still sets no cookies.

### Games (2026-10-19)
- **Source:** the same catalogue the ghostlinkhub site uses, which is the `gn-math` repos (`assets/zones.json`, `html`, `covers`).
  - jsDelivr returns 403 for the `gn-math` user ("User gn-math is blocked"). The HTML shells still point their `<base href>` and asset URLs at `cdn.jsdelivr.net/gh/...`, including paths under `gn-math` itself. GitHub raw cannot be used as a script CDN: it sends `text/plain` with `nosniff`, so the browser will not run the files.
  - On the main server, list, covers and game files are relayed under `/jsgh/` (`server/jsgh.mjs`): jsDelivr first (except `gn-math`), then GitHub raw, with a real Content-Type. `play.html` rewrites jsDelivr `/gh/` URLs to `/jsgh/` and Ruffle tags to `/vendor/ruffle/`.
  - On a static host (GitHub Pages) there is no relay, so the list and covers still come from `raw.githubusercontent.com` and the games still talk to jsDelivr. Games that need `gn-math` assets on jsDelivr will not run there.
  - No game files are stored in this repo.
- **UI:** a grid with search, a "saved" filter (stars, kept in `localStorage` key `g-favs`), lazy covers, and a fullscreen player. Covers keep their colour. The discord "suggest games" entry is dropped.
- **Isolation (changed 2026-10-19 on request):** a game runs in `games/play.html` inside a `sandbox` iframe that includes `allow-same-origin`, so games can save progress.
  - Trade-off: a game shares this site's origin and could read its `localStorage` (the YouTube profile and favourites). Accepted by the owner.
  - `play.html` keeps an in-memory `localStorage` shim for when storage is blocked.
  - `play.html` is the only page with a loose CSP (games need inline scripts, eval and arbitrary https assets). `_headers` is split per path so each page gets exactly one CSP.
- **Known limits:** the games are third-party code and some call out to ad or analytics hosts, so the no-tracking promise covers our pages, not the games. Some ports may not run (a few need a GPU).

### Proxy (2026-10-19)
- **Engine:** Scramjet (MercuryWorkshop, AGPL-3.0) with the libcurl transport over Wisp, chosen by the owner. The backend runs on the owner's Hetzner account.
- **One origin:** `server/server.mjs` serves the whole site and the proxy, because the service worker and the Wisp socket have to be on the page's own origin. This also makes `_headers` actually apply (the server reads that file). GitHub Pages stays as a mirror, where the proxy page explains that it needs the main server.
- **Pinned, not auto-updating:** exact npm versions instead of upstream's `proxy-bootstrap`, which fetches "latest" on every start.
- **Locked down by default:** no logs; no private or loopback destinations; TCP to ports 80/443 only; an access key generated by `setup.sh`.
- **Access key turned off (2026-10-19, owner's call):** the live proxy is open to anyone with the URL. Accepted risk: if the URL spreads, strangers can use the server, and abuse reports go to the Hetzner account. Turn the key back on with `ACCESS_KEY=<key>` on the next `setup-native.sh` run.
- **Search** in the address bar goes to DuckDuckGo.
- Full design, deploy steps and test results are in `06-backend.md`.

### R2 games (2026-10-19)
- **Added at the owner's request:** about 425 games from the owner's R2 bucket, listed from the old nova-hub catalog (`data/games.json`, `source: "semag"`). Played from `/semag/` on our own server, which relays and caches the bucket (see `06-backend.md`).
- **Not linked straight to `r2.dev`:** the old site learned that r2.dev rate-limits Unity games and gets blocked on school networks. Going through our server also keeps the address bar on our domain.
- **Left out on purpose:** the AdSense script the old site injected into every game, and the 14 external proxy-launch entries. Static ad and analytics script tags in games are stripped.
- **Isolation tradeoff:** the games pages are now cross-origin isolated (COEP `credentialless`) so Godot/threaded games run. Same-origin framing, accepted earlier so games can save progress, is unchanged.
- **Duplicates (2026-10-19, owner's choice):** a game that is in both the R2 bucket and the gn-math list is shown once, as the gn-math version. The R2 copy is hidden (about 147 games), matched by name ignoring case and punctuation. This reverses the first version of the merge, which kept the R2 copy.

### Visit counter and cursor glow (2026-10-19)
- **Visit counter, at the owner's request:** this changes the earlier "no analytics" rule, so it is built to keep as little as possible. It counts unique visitors, visits, page views, which pages, which games are played, and which sites people came from. It runs on our own server (`server/stats.mjs`, `site/js/hit.js`), with no third party and no cookies, and IP addresses are never stored.
  - **Unique visitors:** a keyed hash of IP + browser. The key is random, changes daily and is only kept in memory, so a visitor cannot be followed across days or turned back into an IP. If the server restarts mid-day, people seen before the restart may be counted twice that day.
  - **Not recorded:** what is opened through the proxy, YouTube searches, video or channel ids (only the YouTube section: home, shorts...). Bots are skipped by user agent.
  - **Viewing:** the private, unlinked page `/stats/` with a `STATS_KEY`.
- **Cursor glow removed:** the white spotlight that followed the mouse (`.fx-spot`) is gone from every page. The dot-and-ring cursor stays.

### Two proxy engines (2026-10-19)
- **Why:** the owner's school iPad, and Safari on a Mac, did not run the Scramjet proxy (logos missing, odd behaviour) while Chrome did. Scramjet is alpha, its own test suite runs Chromium only, and it has a reported iPad Safari bug (service-worker stream transfer). Ultraviolet was ruled out: same design and deprecated since October 2024.
- **What:** keep Scramjet for Chrome, Edge and Firefox, and use Rammerhead (server-side rewriting) for Safari and every iPhone / iPad browser, picked automatically with a manual switch. The owner confirmed Rammerhead works in Safari on a Mac before this was built.
- **Cost:** a second service on the server (up to 600 MB) and a network lock, because Rammerhead cannot be trusted to refuse private addresses. Details and limits in `06-backend.md`.
- **Not done:** the Docker setup does not include it.
