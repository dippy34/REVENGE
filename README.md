# Project: Revenge (working title)

A private, static, no-tracking site: **YouTube**, **Games** and a **Proxy** (Scramjet, on our own Hetzner server).
Black-and-white, high-effects, "anonymous" feel. Shared by word of mouth and direct URL only.

> Status: **Phases 1-2 built** (menu, theme, effects, YouTube feed) plus **Games** and the **Proxy** (`server/`, see `docs/06-backend.md`). The settings panel and Proxy are next. Build order is in `docs/04-roadmap.md`.

## Doc index

| File | What it covers |
|---|---|
| [docs/01-vision.md](docs/01-vision.md) | What the site is, who it is for, the sections, scope limits |
| [docs/02-design.md](docs/02-design.md) | Theme, naming/obfuscation of the title, effects, menu, anonymity feel |
| [docs/03-privacy-and-discovery.md](docs/03-privacy-and-discovery.md) | No-tracking architecture, unlisted/no-index setup, builder hygiene, cloak tools |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Phases and build order, definition of done per phase |
| [docs/05-decisions.md](docs/05-decisions.md) | Decisions made, open questions, things we will not build |
| [docs/06-backend.md](docs/06-backend.md) | The Hetzner server, the proxy, safety settings, how to deploy |

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
    games/              game grid + sandboxed player page
    proxy/              proxy shell (needs server/)
    assets/             self-hosted fonts, icons (metadata stripped)
  server/               Node server for the site + Scramjet proxy, Docker, Caddy, setup.sh
  tools/                build + leak-check scripts (strip metadata, scan for external requests)
```

## Deploying to GitHub Pages

The main deploy is the Hetzner server: see `docs/06-backend.md`. GitHub Pages is a mirror without the proxy. `.github/workflows/pages.yml` publishes `site/` on every push to `main`. One-time setup: repo **Settings -> Pages -> Source: GitHub Actions**. Pages ignores `site/_headers`; the CSP in each page's `<meta>` tag still applies.

## Ground rules

1. Static files, plus one small server for the proxy (`server/`). No accounts, database, or logs.
2. No third-party requests except, in the YouTube section, the no-cookie embed, thumbnails, and nova-hub's search API (see privacy doc).
3. Black and white only.
4. The site name is never shown plainly. It is only hinted at or encoded.
5. Not for targeting, harassing, or exposing any person. See `docs/05-decisions.md`.
