# Project: Revenge (working title)

A private, static, no-tracking site: **YouTube** now, **Proxy** later, and **Games** shown on the menu as "soon".
Black-and-white, high-effects, "anonymous" feel. Shared by word of mouth and direct URL only.

> Status: **Phases 1-2 built** (menu, theme, effects, YouTube feed). The settings panel and Proxy are next. Build order is in `docs/04-roadmap.md`.

## Doc index

| File | What it covers |
|---|---|
| [docs/01-vision.md](docs/01-vision.md) | What the site is, who it is for, the sections, scope limits |
| [docs/02-design.md](docs/02-design.md) | Theme, naming/obfuscation of the title, effects, menu, anonymity feel |
| [docs/03-privacy-and-discovery.md](docs/03-privacy-and-discovery.md) | No-tracking architecture, unlisted/no-index setup, builder hygiene, cloak tools |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Phases and build order, definition of done per phase |
| [docs/05-decisions.md](docs/05-decisions.md) | Decisions made, open questions, things we will not build |

## Code layout (`proxy/` not created yet)

```
Revenge/
  README.md
  docs/
  site/                 static output, deployable as-is
    index.html          menu / landing
    css/                theme + effects
    js/                 menu, effects, cloak tools, panic key
    youtube/            YouTube feed (no-cookie player)
    proxy/              last phase
    assets/             self-hosted fonts, icons (metadata stripped)
  tools/                build + leak-check scripts (strip metadata, scan for external requests)
```

## Ground rules

1. Static files only. No backend, accounts, database, or logs.
2. No third-party requests except, in the YouTube section, the no-cookie embed, thumbnails, and nova-hub's search API (see privacy doc).
3. Black and white only.
4. The site name is never shown plainly. It is only hinted at or encoded.
5. Not for targeting, harassing, or exposing any person. See `docs/05-decisions.md`.
