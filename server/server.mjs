// server.mjs: one origin for the whole site.
//   /              site/ as static files, with the headers from site/_headers
//   /proxy/sj/*    Scramjet, its controller, utils and the libcurl transport
//                  (exact versions from package.json, never fetched at runtime)
//   /proxy/sw.js   the service worker that routes proxied requests
//   /proxy/wisp/   Wisp over WebSocket: the only part that reaches the web
//
// Nothing is logged: no access log, and Wisp's own logging is switched off.
//
// Env:
//   PORT (8080)  HOST (127.0.0.1)  SITE_DIR (../site)
//   ACCESS_KEY   if set, the proxy only accepts connections that present it
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { loadHeaders, headersFor } from './headers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const SITE = path.resolve(process.env.SITE_DIR || path.join(here, '..', 'site'));
const KEY = process.env.ACCESS_KEY || '';

const rules = loadHeaders(path.join(SITE, '_headers'));

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

function notFound(req, res) {
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { allow: 'GET, HEAD' }, '');
  }
  const urlPath = new URL(req.url, 'http://x').pathname;

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
    }, JSON.stringify({ key: !!KEY }));
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
  const m = /^\/proxy\/wisp\/(?:([^/?#]+)\/)?$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m || !keyOk(m[1] && decodeURIComponent(m[1]))) {
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
    return;
  }
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT} (proxy key ${KEY ? 'on' : 'off'})`);
});
