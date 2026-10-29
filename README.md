# Project: Revenge (working title)

A private site with no third-party tracking (only its own anonymous visit counter, see `docs/06-backend.md`): **YouTube**, **Games**, a **Proxy** (Scramjet for Chrome, Rammerhead for Safari and iPad, on our own Hetzner server), and **Other**, which holds **Music** (experimental).
Black-and-white, high-effects, "anonymous" feel. Shared by word of mouth and direct URL only.

> Status: **Phases 1-2 built** (menu, theme, effects, YouTube feed) plus **Games**, the **Proxy** (`server/`, see `docs/06-backend.md`) and **Music** under **Other** (experimental, 2026-10-29). The settings panel and Proxy are next. Build order is in `docs/04-roadmap.md`.

## Doc index

| File | What it covers |
|---|---|
| [docs/01-vision.md](docs/01-vision.md) | What the site is, who it is for, the sections, scope limits |
| [docs/02-design.md](docs/02-design.md) | Theme, naming/obfuscation of the title, effects, menu, anonymity feel |
| [docs/03-privacy-and-discovery.md](docs/03-privacy-and-discovery.md) | No-tracking architecture, unlisted/no-index setup, builder hygiene, cloak tools |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Phases and build order, definition of done per phase |
| [docs/05-decisions.md](docs/05-decisions.md) | Decisions made, open questions, things we will not build |
| [docs/06-backend.md](docs/06-backend.md) | The Hetzner server, the two proxy engines, safety settings, how to deploy |

## Code layout

```
Revenge/
  README.md
  docs/
  site/                 static output, deployable as-is
    index.html          menu / landing
    css/                theme + effects
    js/                 menu, effects, cloak tools, panic key
    youtube/            YouTube feed (no-cookie player)
    games/              game grid, player page, semag.json (the R2 game list)
    proxy/              proxy shell (needs server/)
    music/              music player, built from music/ (do not edit by hand)
    assets/             self-hosted fonts, icons (metadata stripped)
  music/                music player source (Preact + Vite + TypeScript): draws and plays only; `npm run build` writes site/music/
  server/               Node server: site, Scramjet proxy, R2/gn-math relays, YouTube search (tube.mjs), the music backend (music.mjs); Docker, Caddy, setup scripts
  tools/                build + leak-check scripts (strip metadata, scan for external requests)
```

## Deploying to GitHub Pages

The main deploy is the Hetzner server, live at https://631cb8a9.com: see `docs/06-backend.md`. GitHub Pages is a mirror without the proxy. `.github/workflows/pages.yml` publishes `site/` on every push to `main`. One-time setup: repo **Settings -> Pages -> Source: GitHub Actions**. Pages ignores `site/_headers`; the CSP in each page's `<meta>` tag still applies. Music needs the server's relay, so on Pages it opens but cannot search or play (it says so).

## Ground rules

1. Static files, plus one small server for the proxy (`server/`). No accounts, database, or logs.
2. No third-party requests except, in the YouTube and music sections, the no-cookie embed and thumbnails. Search, covers and music audio go through this origin (see privacy doc).
3. Black and white only.
4. The site name is never shown plainly. It is only hinted at or encoded.
5. Not for targeting, harassing, or exposing any person. See `docs/05-decisions.md`.
