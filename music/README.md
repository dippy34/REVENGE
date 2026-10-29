# music/ (source)

The music section of the site. It builds into `../site/music/` and is served at
`/music/` by `server/server.mjs`, which also runs its relay (`server/music.mjs`,
everything under `/api/music/`). How it works and what it may and may not do:
`docs/05-decisions.md` ("Music"), routes and settings: `docs/06-backend.md`.

```bash
npm ci                 # once
npm run dev            # http://localhost:5173/music/, proxies /api to a running server (REVENGE_SERVER, default http://127.0.0.1:8193)
npm test               # unit tests (Vitest)
npm run build          # type-checks, then writes ../site/music (commit it)
npm run test:e2e       # browser smoke tests: builds first, then starts server.mjs on :8194 (network + Google Chrome)
```

For `npm run dev`, start the server in another terminal first:

```bash
cd ../server && PORT=8193 RH_PORT=1 node server.mjs
```

Layout:

```
src/
  app/          shell, router, services (wires providers, player and library)
  core/         types, validation, config (relay URLs), http (timeouts, cache)
  providers/    one file per catalog; every call goes to /api/music
  player/       queue, playback controller, resolver, engines (HTML audio, YouTube)
  data/         IndexedDB store with migrations, library, settings, import/export
  discovery/    local recommendations
  ui/           pages, layout, components; styles/music.css is the whole theme
tests/unit      Vitest (fake-indexeddb)
tests/e2e       Playwright smoke tests
```

The page loads the site's shared `css/` and `js/` (base, fx, eggs, hit, hunt). The
Vite config adds those tags and the page's CSP `<meta>` at build time, and serves
them from `../site` during `npm run dev`.
