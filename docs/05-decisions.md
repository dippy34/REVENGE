# 05 - Decisions, Open Questions, Limits

## Decided
- Sections: YouTube, Games and Proxy, all live as of 2026-10-19 (see below).
- Build the menu and YouTube first.
- Black and white theme only.
- Internal name is "Revenge"; the public-facing title is encoded or hinted, never plain.
- YouTube plays through the no-cookie embed.
- No `.onion` mirror.
- Static site plus one proxy server (`server/`, Hetzner); no analytics, no logs.
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
  - `img-src 'self' https://i.ytimg.com` and `connect-src https://nova-hub.dev`.
  - `frame-src 'self' https://www.youtube-nocookie.com`.

### YouTube feed (2026-10-18, replaces the Phase 2 link-in/player-out page)
- **Search data comes from nova-hub's public API**, at the user's request, after looking at how github.com/dippy34/nova-hub does it.
  - Endpoints: `https://nova-hub.dev/api/tube-search` and `/api/tube-video`.
  - That API is their Cloudflare Function calling YouTube's internal web API. No API key is involved, and it allows any origin (CORS `*`).
  - So this site still has no backend of its own. No code from that repo was copied; it is GPL-3.0.
  - The client (`js/yt-api.js`) validates every field, renders text only, caches results in `localStorage` for 30 min (details 6 h), and retries once, because their upstream returns 502/504 now and then.
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
5. **Depending on nova-hub.dev:** keep using it, or self-host an equivalent function later? Either way, the feed is down whenever that API is.

## Will not build
- Anything meant to target, harass, expose, or deceive a specific person or group.
- Anything that collects or stores visitor data.
- Tools meant to evade law enforcement, or hosting for abusive or illegal content.

## Honest limits
- Cloaking features hide things only from someone looking at the screen or browser history, not from network monitoring.
- A public URL cannot be made invisible to everything. It can be kept out of search and discovery.
- The digest is a hint, not a secret. An unsalted hash of a dictionary word can be reversed with a simple lookup.
- **nova-hub.dev sees** every visitor's IP address and the search phrases the feed sends, which are your interests. It may log them, rate-limit, change the API or block other sites at any time.
- **YouTube sees** visitor IPs:
  - while browsing, via thumbnails from `i.ytimg.com`
  - once a video plays, via the embed, which also learns the site's origin
  - The embed may set its own storage on `youtube-nocookie.com`. This site still sets no cookies.

### Games (2026-10-19)
- **Source:** the same catalogue the ghostlinkhub site uses, which is the `gn-math` repos (`assets/zones.json`, `html`, `covers`).
  - jsDelivr now blocks `gn-math`, so everything is fetched from `raw.githubusercontent.com` (CORS `*`) instead.
  - No game files are stored in this repo. The only new third-party host on our own pages is `raw.githubusercontent.com` (connect + img).
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
