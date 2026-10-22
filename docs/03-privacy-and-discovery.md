# 03 - Privacy and Discovery

Honest framing: "no trace whatsoever" is not achievable. Hosts, registrars, and networks always keep some records. The goal is: collect nothing that identifies visitors, keep nothing that identifies the builder, and stay out of search and discovery. Since 2026-10-19 the site counts visits on its own server: counts per day only, no cookies, no IP addresses, and visitors cannot be followed from day to day (details in `06-backend.md`).

## Architecture (nothing to leak)
- Static files plus one proxy server (`server/`). No accounts, database, or server logs: Wisp logging and container logs are off, and Caddy keeps no access log.
- Self-host fonts, scripts, and assets. No CDNs, third-party analytics, ads, or social embeds.
- No cookies and no fingerprinting.
- The menu makes no third-party requests at all.
- On the main server, gn-math game files are fetched by the server (`/jsgh/`), so the visitor's browser does not talk to jsDelivr or GitHub. GitHub/jsDelivr still see the server's IP.
- The YouTube section has these exceptions, added when it became a feed (see `05-decisions.md`):
  - this origin (`/api/tube-*`): search, channel tabs and details. The server calls YouTube. Search phrases leave this machine; visitor IPs do not go to a third-party search host.
  - `i.ytimg.com`: thumbnails while browsing. YouTube sees visitor IPs.
  - `www.youtube-nocookie.com`: the player, loaded when a video is opened.
- Headers: strict CSP, `Referrer-Policy: no-referrer`, `Permissions-Policy` disabling sensors, HSTS.

## Discovery (find it only by URL or word of mouth)
- `<meta name="robots" content="noindex,nofollow,noarchive">` on every page and the `X-Robots-Tag` header.
- Do not rely on `robots.txt` alone (a disallow stops crawlers from seeing `noindex`).
- No sitemap, no Search Console, no Open Graph / link-preview tags.
- Random, unguessable hostname or path. Wildcard TLS certificate so the exact name stays out of Certificate Transparency logs.
- No inbound links from indexed pages. Rotate the URL if it leaks.
- Optional client-side passphrase gate.

## Visitor-side tools (optional, in the settings panel)
- **Tab cloak:** swap tab title and favicon to something generic.
- **`about:blank` launcher:** open the site inside a blank-tab frame.
- **Panic key:** a hotkey that redirects to a neutral page.
- A plain note on the page: these only change what is visible on screen. They do not hide the visit from network monitoring, and private/incognito windows are the way to keep browser history clean.

## Builder hygiene
- Pseudonymous hosting and registrar accounts, dedicated email, WHOIS privacy.
- Edge/static host with access logs and analytics turned off.
- Build from a clean profile or separate user account.
- Strip metadata from every asset (EXIF, author fields, build paths, usernames). Fixed timestamps in builds.
- No reused usernames, code, comments, or writing style from public accounts.
- Run the leak check (see `tools/` in the roadmap) before every deploy: scan the output for names, local paths, and unexpected external requests.

## The ghost (hidden AI page)
- What a visitor types on `/ghost/` goes to Anthropic's API through our server, so Anthropic sees the text and the server's IP, not the visitor's.
- Our server stores nothing: no logs of messages or replies, and the conversation lives only in the open page.
- Rate limits use a keyed hash of the IP, held in memory only and dropped after 10 minutes.
- The page says this in one line under the input.

## Limits to state plainly
- The host and network can still see that the domain was visited.
- Anyone with the exact link can load the site.
- Private windows do not hide traffic from a school, workplace, or ISP.
