# 06 - Backend (Hetzner) and the Proxy

The proxy needs a real server, so the site now has one. `server/` serves the
whole site **and** the proxy from one origin. GitHub Pages can stay as a
mirror, but the proxy only works on the server.

## How it fits together

```
browser ──https──> Caddy (TLS) ──> server.mjs ──> site/ (static, _headers applied)
                                       │
   /proxy/  page + service worker      ├─ /proxy/sj/*   Scramjet, controller, utils, libcurl (pinned)
   iframe at /proxy/~/...              ├─ /proxy/sw.js  routes proxied requests to the page
                                       └─ /proxy/wisp/  WebSocket ──> the web (ports 80/443 only)
```

- **Scramjet** rewrites pages inside the browser. A service worker catches the
  iframe's requests, and the page sends them out through the **libcurl**
  transport. libcurl does TLS inside the browser, so the server only relays
  encrypted bytes over **Wisp**.
- Versions are pinned in `server/package.json` and installed with `npm ci`.
  Upstream's `proxy-bootstrap` package is not used, because it downloads
  "latest" from npm every time it starts.

## The R2 games (`/semag/`)

About 425 more games live in a Cloudflare R2 bucket (`semag/<game>/index.html` plus
its files). `server/semag.mjs` serves them from this origin instead of linking to the
bucket's `r2.dev` address, because `r2.dev` rate-limits the burst of requests a
Unity game makes (HTTP 429) and school filters block it.

- **List:** `site/games/semag.json` (name, folder, cover file), taken from the old
  nova-hub catalog. The games page merges it with the gn-math list; a game in both
  shows the gn-math version and the R2 copy is hidden (the owner's choice, 2026-10-19;
  about 147 games are in both, matched by name ignoring case and punctuation). If one
  source fails to load, the other still shows, so the R2 copies appear if the gn-math
  list is unreachable.
- **Relay:** the upstream host is fixed (`R2_BASE`) and the path is validated, so it
  cannot be pointed elsewhere. Files are relayed byte for byte, so `.br` / `.gz`
  builds keep working, and cached on disk (`CACHE_DIR`, capped by `CACHE_MAX_MB`,
  default 4 GB, oldest evicted first). At most 8 requests go to the bucket at once,
  with retries on 429 and 5xx. Range requests are answered from the cache or passed
  through.
- **Page patches** (at serve time, the cache keeps the original): Ruffle is loaded
  from `/vendor/ruffle/` instead of `unpkg.com` (138 Flash games; Ruffle 0.7.1 is a
  pinned npm dependency), anti-framing code is removed (6 games), and static ad and
  analytics `<script>` tags are removed. The ad script the old site injected is not
  added. Games can still load their own ads at runtime.
- **Headers:** `/semag/*` has the loose CSP that game code needs, and the games pages
  plus `/semag/*` send `Cross-Origin-Embedder-Policy: credentialless`, which makes
  them cross-origin isolated. Godot and threaded Unity games need that
  (`SharedArrayBuffer`); Karlson did not start without it.
- **Mirror:** GitHub Pages has no relay, so there the R2 games are hidden and only
  the gn-math games show. The page decides by asking `/proxy/config.json`.
- **Not tested:** Safari (it does not support `credentialless`, so isolated games may
  fail there), and a real phone.

## Safety settings (server.mjs)

| Setting | Why |
|---|---|
| Wisp logging off, container `logging: none` | no record of who visited or where they went |
| no private or loopback addresses | the proxy cannot reach the server itself or Hetzner's internal network |
| ports 80 and 443 only, no UDP | the web only; blocks mail spam, SSH scanning and the like |
| `stream_limit_total: 300` per connection | stops one tab opening endless sockets (`stream_limit_per_host` crashes wisp-js 0.4.1/0.5.0, so it is not used) |
| optional `ACCESS_KEY` | the Wisp socket refuses anyone without the key, so it is not an open proxy |
| container: read-only, no capabilities, non-root, port bound to 127.0.0.1 | only Caddy or the tunnel can reach it |

## Deploy on Hetzner

1. Use an existing Hetzner server (Ubuntu or Debian) or create one; the smallest shared-CPU type is enough. The script stops if a port it needs (8080, plus 80/443 with a domain) is already in use, and asks before turning on the firewall.
2. **Pick how it gets HTTPS** (the proxy needs HTTPS; service workers do not run without it):
   - **Your own domain:** add an `A` record pointing at the server's IPv4 address. Caddy gets the certificate on its own.
   - **Cloudflare Tunnel:** no domain records or open ports needed. Leave the domain empty in step 3, then point the tunnel at `http://localhost:8080`.
3. Log in as root (SSH, or the **Console** button in the Hetzner web console) and run:
   ```sh
   curl -sL dippy34.github.io/REVENGE/i | bash
   ```
   `/i` is `server/setup.sh`, copied onto the GitHub Pages site by the Pages workflow so it is short to type.
   It installs Docker, clones the repo to `/opt/revenge`, writes `server/.env`
   with a random access key (it prints the key), opens only SSH/80/443 in the
   firewall, and starts everything.
4. **Updating:** run `bash /opt/revenge/server/setup.sh` again. It pulls `main` and rebuilds.

To change the key: edit `/opt/revenge/server/.env`, then `docker compose up -d` in `/opt/revenge/server`. Visitors are asked for the new key next time.

Check on the server: `ls /var/cache/revenge` (native) or the `games_cache` volume
(Docker). To clear the cache, stop the service and delete that folder.

## Adding to a server that already runs Caddy (no Docker)

`server/setup-native.sh` is for a server that already serves other sites through
Caddy as a system service. It leaves everything else alone:

- The app runs as a `revenge` systemd service on `127.0.0.1:8080`, as its own
  no-login user, with no logs (stdout/stderr go to `/dev/null`) and systemd
  hardening (read-only system, no capabilities).
- One site block for `$DOMAIN` is appended to `/etc/caddy/Caddyfile`. The file is
  backed up first, checked with `caddy validate`, and restored if the check fails.
- The games cache lives in `/var/cache/revenge` (made by systemd, owned by `revenge`).
- The access key lives in `/etc/revenge.env` (root only). Pass `ACCESS_KEY=` (empty) to turn the lock off, or a value to change it. Leave it out to keep the saved one.
- Changing `DOMAIN` (it can list several names, comma-separated) renames the existing site block instead of adding a second one.

```sh
DOMAIN=631cb8a9.157-180-67-116.sslip.io ACCESS_KEY=... bash /opt/revenge/server/setup-native.sh
```

Re-run the same command to update to the latest `main`. Since 2026-10-19 this is
how the Hetzner server `ubuntu-2gb-hel1-2` (157.180.67.116) runs the site, next to the older
nova-hub services. The hostnames use the title digest, so the name is not in the URL.

**Live addresses:**
- `https://631cb8a9.com` and `https://www.631cb8a9.com`: the domain, registered at IONOS
  with private registration on. DNS at IONOS has `A @` and `A www` set to `157.180.67.116`
  with TTL 5 min, and no `AAAA` records.
- `https://631cb8a9.157-180-67-116.sslip.io`: a backup that needs no DNS.

The current update command (no access key; saved settings are kept):
```sh
DOMAIN='631cb8a9.com, www.631cb8a9.com, 631cb8a9.157-180-67-116.sslip.io' bash /opt/revenge/server/setup-native.sh
```

## Local development

```sh
cd server && npm ci && node server.mjs     # http://localhost:8080
```

Service workers are allowed on `localhost` without HTTPS.

## Licences

Scramjet, its controller and utils, and wisp-js are **AGPL-3.0**. They are used
unmodified and the proxy page credits them with links to their source.
`server.mjs` imports wisp-js, so treat `server/` as AGPL-3.0 too (its
`package.json` says so). If the code is ever changed and kept private, its
source still has to be offered to the people who use the proxy.

## Verified (2026-10-19)

- Headless Chromium against the real `server.mjs`, with a local test site
  (a test harness let Wisp reach localhost; production keeps it blocked):
  page load, an in-page `fetch`, link navigation, address bar updates, back, new-page.
- Access key: no key or a wrong key gets 403 on the socket and a "that key did not
  work" prompt. The right key is accepted and remembered after a reload.
- Production filter: loopback is refused.
- Path traversal (`/../`, `%2e%2e`), `/_headers` and dotfiles return 404.
- Docker image builds and runs read-only as non-root. All routes answer and the socket upgrades with the key.
- **Live server (same day):** `setup-native.sh` ran on `ubuntu-2gb-hel1-2` next to the
  existing nova-hub services, which still answer. Caddy got a Let's Encrypt
  certificate. All pages return 200 with the `_headers` rules applied. The socket
  gives 403 without the key and 101 with it. In headless Chromium, example.com,
  a Wikipedia article and a DuckDuckGo search all loaded through the proxy with
  no console errors.
- **R2 games (same day):** live at `https://631cb8a9.com`. All 425 game pages and
  covers came through the relay with no failures (checked locally against the real
  bucket). On the live domain, a plain HTML game, a Flash game (Ruffle), a Unity game
  and Karlson (Godot, needs cross-origin isolation) all started, and the other pages
  and the proxy still load with no console errors.
- **Not verified:** the Docker/Caddy path (`setup.sh`) on a real server, the
  Cloudflare Tunnel path, Safari, Firefox and phones.
