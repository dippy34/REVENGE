// app.mjs: everything the site's origin answers, as a request handler and an
// upgrade handler. server.mjs listens with it (631cb8a9.com); kyrie/server.mjs
// mounts it behind the 631 door so the whole site also runs on Kyrie's origin.
//   /              site/ as static files, with the headers from site/_headers
//   /proxy/sj/*    Scramjet, its controller, utils and the libcurl transport
//                  (exact versions from package.json, never fetched at runtime)
//   /proxy/sw.js   the service worker that routes proxied requests
//   /proxy/wisp/   Wisp over WebSocket: the only part that reaches the web
//   /<session>/... the Safari / iPad engine (Rammerhead), forwarded to rammerhead.cjs
//                  together with its helper scripts; see rhproxy.mjs
//   /semag/*       the R2 games, relayed and cached on disk (see semag.mjs)
//   /jsgh/*        gn-math game files (jsDelivr / GitHub), relayed and cached
//   /vendor/ruffle Ruffle (Flash emulator), from its pinned npm package
//   /api/p         POST: one page view or game play (see stats.mjs)
//   /api/stats     GET: the counts, with the STATS_KEY
//   /api/tube-*    YouTube search / channel / details (see tube.mjs)
//   /api/music/*   the music player: pages, how each song plays, cover art and audio (see music.mjs)
//   /api/ai        POST: the ghost's chat stream; /api/ai/status (see ai.mjs)
//   /api/hunt/*    the weekly signal (see hunt.mjs and docs/07-hunt.md); off without HUNT_ secrets
//
// Nothing is logged: no access log, and Wisp's own logging is switched off.
//
// Env (the object passed to createApp; PORT and HOST belong to the listener):
//   SITE_DIR     (../site)
//   ACCESS_KEY   if set, the proxy only accepts connections that present it
//   RH_SOCKET    unix socket of the Rammerhead process (default /run/revenge/rh.sock);
//                or RH_PORT for a loopback TCP port. If nothing listens there,
//                the Safari engine answers 502 and the rest of the site works.
//   R2_BASE      public address of the games bucket (default: the owner's)
//   CACHE_DIR    where relayed game files are kept (default ./.cache)
//   CACHE_MAX_MB size cap for that cache (default 4096)
//   STATS_KEY    password for /stats/; if unset, the stats page is off
//                (visits are still counted)
//   STATS_DIR    where the daily counts are saved (default ./.data)
//   STATS_TZ     time zone that decides where a day starts (default America/Chicago)
//   ANTHROPIC_API_KEY  wakes the ghost (/ghost/); without it /api/ai answers 503
//   MUSIC_DISABLE_YOUTUBE=1  music plays from Audius and previews only (see music.mjs)
//   AI_MODEL     model id (default claude-haiku-5-5)
//   AI_DAILY_MAX requests per day for everyone together (default 300)
//   AI_MOCK=1    canned replies, no key and no network (development)
//   (the ghost's per-visitor limit trusts X-Forwarded-For from a loopback or
//   private peer only, so keep a reverse proxy in front: Caddy or the tunnel)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { loadHeaders, headersFor } from './headers.mjs';
import { createSemag } from './semag.mjs';
import { createJsgh } from './jsgh.mjs';
import { createTube } from './tube.mjs';
import { createStats } from './stats.mjs';
import { createRh, isRhRequest } from './rhproxy.mjs';
import { createAi } from './ai.mjs';
import { createHunt } from './hunt.mjs';
import { createMusic } from './music.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// rename: optional { oldName: newName } for top-level paths ({ games: 'flashcards' }).
// The site is then served under the new names: requests are mapped back to the
// real ones, and the site's own HTML, JS and CSS are rewritten on the way out
// (site/ itself never changes). Old page names answer 404; old relay names keep
// working because relayed game files point at them.
export function createApp({ env = process.env, host = '127.0.0.1', rename = null } = {}) {
  const SITE = path.resolve(env.SITE_DIR || path.join(here, '..', 'site'));
  const KEY = env.ACCESS_KEY || '';
  const R2_BASE = env.R2_BASE || 'https://pub-31ddb721e92142be8b2deee228c36013.r2.dev';
  const CACHE_DIR = path.resolve(env.CACHE_DIR || path.join(here, '.cache'));
  const RH_SOCKET = env.RH_PORT ? '' : (env.RH_SOCKET || '/run/revenge/rh.sock');
  const rh = createRh(RH_SOCKET ? { socketPath: RH_SOCKET } : { port: Number(env.RH_PORT) });
  const CACHE_MAX = Math.max(64, Number(env.CACHE_MAX_MB || 4096)) * 1024 * 1024;

  const stats = createStats({
    dir: path.resolve(env.STATS_DIR || path.join(here, '.data')),
    key: env.STATS_KEY || '',
    tz: env.STATS_TZ || 'America/Chicago'
  });

  const rules = loadHeaders(path.join(SITE, '_headers'));

  const semag = createSemag({
    base: R2_BASE,
    cacheDir: path.join(CACHE_DIR, 'semag'),
    maxBytes: CACHE_MAX,
    headersFor: (p) => headersFor(rules, p)
  });
  const jsgh = createJsgh({
    cacheDir: path.join(CACHE_DIR, 'jsgh'),
    maxBytes: CACHE_MAX,
    headersFor: (p) => headersFor(rules, p)
  });
  const tube = createTube();
  const music = createMusic({ env });
  const hunt = createHunt({ siteDir: SITE, env, host }); // throws when it cannot start
  const ai = createAi({
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.AI_MODEL || 'claude-haiku-5-5',
    dailyMax: env.AI_DAILY_MAX ? Number(env.AI_DAILY_MAX) : 300,
    mock: env.AI_MOCK === '1',
    mockDelay: env.AI_MOCK_DELAY ? Number(env.AI_MOCK_DELAY) : undefined,
    tz: env.STATS_TZ || 'America/Chicago'
  });

  // Ruffle: only the files that exist in the package, by exact name
  const RUFFLE_DIR = path.join(here, 'node_modules', '@ruffle-rs', 'ruffle');
  const RUFFLE_FILES = new Set(fs.readdirSync(RUFFLE_DIR).filter((f) => /^[\w.-]+\.(js|wasm)$/.test(f)));

  /* ---------- wisp ---------- */

  logging.set_level(logging.NONE);
  Object.assign(wisp.options, {
    allow_private_ips: false,   // never reach this server's own network
    allow_loopback_ips: false,
    allow_udp_streams: false,   // the web only needs TCP
    port_whitelist: [80, 443],  // web ports only: no mail, ssh or other abuse
    // stream_limit_per_host crashes the server in wisp-js 0.4.1 and 0.5.0
    // (it iterates an object), so cap the total per connection instead.
    stream_limit_total: 300,
    wisp_motd: null
  });

  function keyOk(given) {
    if (!KEY) return true;
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /* ---------- proxy assets ---------- */

  // Their export maps hide package.json and dist/, so go to node_modules.
  function pkgFile(pkg, file) {
    return path.join(here, 'node_modules', pkg, file);
  }

  const ASSETS = {
    '/proxy/sj/scramjet.js': pkgFile('@mercuryworkshop/scramjet', 'dist/scramjet.js'),
    '/proxy/sj/scramjet.wasm': pkgFile('@mercuryworkshop/scramjet', 'dist/scramjet.wasm'),
    '/proxy/sj/controller.api.js': pkgFile('@mercuryworkshop/scramjet-controller', 'dist/controller.api.js'),
    '/proxy/sj/controller.inject.js': pkgFile('@mercuryworkshop/scramjet-controller', 'dist/controller.inject.js'),
    '/proxy/sj/controller.sw.js': pkgFile('@mercuryworkshop/scramjet-controller', 'dist/controller.sw.js'),
    '/proxy/sj/scramjet-utils.js': pkgFile('@mercuryworkshop/scramjet-utils', 'dist/scramjet-utils.js'),
    '/proxy/sj/libcurl.js': pkgFile('@mercuryworkshop/libcurl-transport', 'dist/index.js')
  };
  for (const f of Object.values(ASSETS)) fs.accessSync(f); // fail at start, not mid-request

  /* ---------- renamed paths ---------- */

  const RELAYS = new Set(['semag', 'jsgh']);
  const outName = new Map(Object.entries(rename || {}));
  const inName = new Map([...outName].map(([a, b]) => [b, a]));
  // a name used as a path: "/games/", "\/games\/", "'games/'", "BASE + 'rx/'", "'/games'"
  const words = [...outName.keys()].join('|');
  const PATHS = outName.size && new RegExp(`(?<![\\w.@-])(${words})(?=\\\\?/)|(?<=['"\`]/)(${words})(?=['"\`])`, 'g');
  const outward = (text) => (PATHS ? text.replace(PATHS, (w) => outName.get(w)) : text);

  // the path as the site knows it, or null for an old page name that is hidden
  function inward(p) {
    const seg = p.split('/')[1];
    if (inName.has(seg)) return '/' + inName.get(seg) + p.slice(1 + seg.length);
    if (outName.has(seg) && !RELAYS.has(seg)) return null;
    return p;
  }

  const SW = outward(`importScripts("/proxy/sj/controller.sw.js");
addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e));
});
`);

  /* ---------- static files ---------- */

  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm'
  };

  function send(res, status, headers, body) {
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendFile(req, res, file, extra) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(req, res);
      if (PATHS && file.startsWith(SITE + path.sep) && /\.(html|js|css)$/.test(file)) {
        return fs.readFile(file, 'utf8', (err2, text) => {
          if (err2) return notFound(req, res);
          const body = Buffer.from(outward(text));
          send(res, 200, Object.assign({ 'content-type': TYPES[path.extname(file)], 'content-length': body.length }, extra), req.method === 'HEAD' ? '' : body);
        });
      }
      const headers = Object.assign({
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': st.size
      }, extra);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // The themed site/404.html (same headers as the menu) when it exists,
  // otherwise plain text.
  function notFound(req, res) {
    let page = null;
    try { page = outward(fs.readFileSync(path.join(SITE, '404.html'), 'utf8')); } catch (e) { /* no page */ }
    if (page) return send(res, 404, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, headersFor(rules, '/')), req.method === 'HEAD' ? '' : page);
    send(res, 404, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, headersFor(rules, '/404')), 'not found');
  }

  // Map a URL path to a file inside SITE; anything that escapes it is a 404.
  function resolveSite(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch (e) { return null; }
    if (p.includes('\0')) return null;
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(SITE, '.' + path.posix.normalize(p));
    if (file !== SITE && !file.startsWith(SITE + path.sep)) return null;
    if (path.basename(file).startsWith('.') || path.basename(file) === '_headers') return null;
    return file;
  }

  function handle(req, res) {
    let urlPath = new URL(req.url, 'http://x').pathname;
    if (outName.size) {
      const real = inward(urlPath);
      if (real === null) return notFound(req, res);
      req.url = real + req.url.slice(urlPath.length); // the relays read req.url themselves
      urlPath = real;
    }
    if (req.method === 'POST' && urlPath === '/api/p') return stats.hit(req, res);
    if (req.method === 'POST' && urlPath === '/api/ai') return ai.handle(req, res);
    if (urlPath.startsWith('/api/hunt/')) return hunt.handle(req, res);
    if (isRhRequest(req.method, req.url)) return rh.handle(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { allow: 'GET, HEAD' }, '');
    }
    if (urlPath === '/api/stats') return stats.report(req, res);
    if (urlPath === '/api/tube-search') return tube.handleSearch(req, res);
    if (urlPath === '/api/tube-video') return tube.handleVideo(req, res);
    if (urlPath.startsWith('/api/music/')) return music.handle(req, res);
    if (urlPath === '/api/ai/status') return ai.status(req, res);

    if (urlPath === '/proxy/sw.js') {
      return send(res, 200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      }, SW);
    }
    if (ASSETS[urlPath]) {
      return sendFile(req, res, ASSETS[urlPath], {
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin'
      });
    }
    if (urlPath === '/proxy/config.json') {
      return send(res, 200, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      }, JSON.stringify({ key: !!KEY, semag: true, jsgh: true, rammerhead: true }));
    }
    if (urlPath.startsWith('/semag/')) return semag.handle(req, res);
    if (urlPath.startsWith('/jsgh/')) return jsgh.handle(req, res);
    if (urlPath.startsWith('/vendor/ruffle/')) {
      const name = urlPath.slice('/vendor/ruffle/'.length);
      if (!RUFFLE_FILES.has(name)) return notFound(req, res);
      return sendFile(req, res, path.join(RUFFLE_DIR, name), Object.assign({
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff'
      }, headersFor(rules, urlPath)));
    }

    // "/games" -> "/games/" so relative links on the page resolve
    const file = resolveSite(urlPath);
    if (!file) return notFound(req, res);
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        return send(res, 301, { location: outward(urlPath + '/') }, '');
      }
      const lookup = urlPath.endsWith('/index.html') ? urlPath.slice(0, -10) : urlPath;
      sendFile(req, res, file, headersFor(rules, lookup));
    });
  }

  // /proxy/wisp/ or /proxy/wisp/<key>/
  function upgrade(req, socket, head) {
    if (isRhRequest('GET', req.url)) return rh.upgrade(req, socket, head);
    let pathname = new URL(req.url, 'http://x').pathname;
    if (outName.size) pathname = inward(pathname) || '';
    const m = /^\/proxy\/wisp\/(?:([^/?#]+)\/)?$/.exec(pathname);
    if (!m || !keyOk(m[1] && decodeURIComponent(m[1]))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    wisp.routeRequest(req, socket, head);
  }

  return {
    handle,
    upgrade,
    // save the counts (call before the process stops)
    flush() { stats.flush(); hunt.flush(); },
    summary() { return `proxy key ${KEY ? 'on' : 'off'}, stats page ${env.STATS_KEY ? 'on' : 'off'}, ${hunt.summary()}`; }
  };
}
