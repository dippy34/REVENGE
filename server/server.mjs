// server.mjs: one origin for the whole site.
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
//   /api/ai        POST: the ghost's chat stream; /api/ai/status (see ai.mjs)
//   /api/hunt/*    the weekly signal (see hunt.mjs and docs/07-hunt.md); off without HUNT_ secrets
//
// Nothing is logged: no access log, and Wisp's own logging is switched off.
//
// Env:
//   PORT (8080)  HOST (127.0.0.1)  SITE_DIR (../site)
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
//   AI_MODEL     model id (default claude-haiku-5-5)
//   AI_DAILY_MAX requests per day for everyone together (default 300)
//   AI_MOCK=1    canned replies, no key and no network (development)
//   (the ghost's per-visitor limit trusts X-Forwarded-For from a loopback or
//   private peer only, so keep a reverse proxy in front: Caddy or the tunnel)
import http from 'node:http';
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

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const SITE = path.resolve(process.env.SITE_DIR || path.join(here, '..', 'site'));
const KEY = process.env.ACCESS_KEY || '';
const R2_BASE = process.env.R2_BASE || 'https://pub-31ddb721e92142be8b2deee228c36013.r2.dev';
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(here, '.cache'));
const RH_SOCKET = process.env.RH_PORT ? '' : (process.env.RH_SOCKET || '/run/revenge/rh.sock');
const rh = createRh(RH_SOCKET ? { socketPath: RH_SOCKET } : { port: Number(process.env.RH_PORT) });
const CACHE_MAX = Math.max(64, Number(process.env.CACHE_MAX_MB || 4096)) * 1024 * 1024;

const stats = createStats({
  dir: path.resolve(process.env.STATS_DIR || path.join(here, '.data')),
  key: process.env.STATS_KEY || '',
  tz: process.env.STATS_TZ || 'America/Chicago'
});
// save the counts before systemd or Docker stops us
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stats.flush(); if (hunt) hunt.flush(); process.exit(0); });

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
let hunt = null;
try {
  hunt = createHunt({ siteDir: SITE, env: process.env, host: HOST });
} catch (e) {
  console.log(e && e.message ? e.message : 'hunt: could not start');
  process.exit(1);
}
const ai = createAi({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.AI_MODEL || 'claude-haiku-5-5',
  dailyMax: process.env.AI_DAILY_MAX ? Number(process.env.AI_DAILY_MAX) : 300,
  mock: process.env.AI_MOCK === '1',
  mockDelay: process.env.AI_MOCK_DELAY ? Number(process.env.AI_MOCK_DELAY) : undefined,
  tz: process.env.STATS_TZ || 'America/Chicago'
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

const SW = `importScripts("/proxy/sj/controller.sw.js");
addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e));
});
`;

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
  try { page = fs.readFileSync(path.join(SITE, '404.html')); } catch (e) { /* no page */ }
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

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://x').pathname;
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
      return send(res, 301, { location: urlPath + '/' }, '');
    }
    const lookup = urlPath.endsWith('/index.html') ? urlPath.slice(0, -10) : urlPath;
    sendFile(req, res, file, headersFor(rules, lookup));
  });
});

// /proxy/wisp/ or /proxy/wisp/<key>/
server.on('upgrade', (req, socket, head) => {
  if (isRhRequest('GET', req.url)) return rh.upgrade(req, socket, head);
  const m = /^\/proxy\/wisp\/(?:([^/?#]+)\/)?$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m || !keyOk(m[1] && decodeURIComponent(m[1]))) {
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
    return;
  }
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT} (proxy key ${KEY ? 'on' : 'off'}, stats page ${process.env.STATS_KEY ? 'on' : 'off'}, ${hunt.summary()})`);
});
