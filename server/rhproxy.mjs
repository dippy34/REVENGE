// rhproxy.mjs: forwards the paths Rammerhead owns to its process (rammerhead.cjs)
// and nothing else.
//
// Rammerhead lives at the root of a host: its helper scripts are at paths like
// /hammerhead.js and every proxied page is /<32-character session id>/<address>.
// This module decides which requests those are, strips everything that could
// identify the visitor before the request goes on to the sites they open,
// and limits how many sessions one visitor can create.
//
// /editsession is forwarded only for switching URL shuffling OFF (so addresses
// stay readable): any other use, such as routing a session through another
// proxy, is refused. /deletesession is not forwarded.
import http from 'node:http';
import net from 'node:net';

// method + exact path of Rammerhead's own routes that the proxy page needs
const SERVICE = new Set([
  'GET /hammerhead.js', 'GET /transport-worker.js', 'GET /worker-hammerhead.js',
  'GET /task.js', 'GET /iframe-task.js', 'GET /rammerhead.js',
  'GET /messaging', 'POST /messaging', 'OPTIONS /messaging',
  'POST /syncLocalStorage',
  'GET /needpassword', 'GET /newsession', 'GET /sessionexists', 'GET /mainport', 'GET /api/shuffleDict'
]);
// hammerhead appends flags to the id for sub-requests: /<id>!a!1/<address>
const SESSION_PATH = /^\/[a-z0-9]{32}(?:![^/!]*)*(?:\/|$)/i;

// Added by Caddy, a CDN or us. None of these may reach the sites people visit.
const DROP = new Set([
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip',
  'forwarded', 'via', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop',
  'true-client-ip', 'x-rh-host', 'x-rh-proto', 'x-client-ip', 'x-cluster-client-ip'
]);

const SESSIONS_PER_HOUR = 30;

// hammerhead decodes gzip, deflate and br only. Browsers also offer zstd, and a
// site that answers with it (Google Tag Manager does) gets its bytes "rewritten"
// as if they were text: the browser then fails with ERR_CONTENT_DECODING_FAILED
// and the page stays blank. So sites are only offered what hammerhead can read.
const READABLE = /^(gzip|deflate|br|identity)\s*(;|$)/i;
function acceptEncoding(v) {
  const ok = String(v).split(',').map((s) => s.trim()).filter((s) => READABLE.test(s));
  return ok.length ? ok.join(', ') : 'identity';
}

// /editsession?id=<32>&enableShuffling=0 (plus pwd when a key is set), nothing else
function editAllowed(method, search) {
  if (method !== 'GET') return false;
  const q = new URLSearchParams(search);
  for (const k of q.keys()) if (k !== 'id' && k !== 'enableShuffling' && k !== 'pwd') return false;
  return q.get('enableShuffling') === '0' && /^[a-z0-9]{32}$/i.test(q.get('id') || '');
}

// url is req.url: path and query
export function isRhRequest(method, url) {
  const u = new URL(url, 'http://x');
  if (u.pathname === '/editsession') return editAllowed(method, u.search);
  return SERVICE.has(method + ' ' + u.pathname) || SESSION_PATH.test(u.pathname);
}

// Which protocol did the visitor use? Only believed when it comes from Caddy
// on this machine, never from a visitor connecting directly.
function protoOf(req) {
  const peer = req.socket.remoteAddress || '';
  const local = /^(::ffff:)?127\./.test(peer) || peer === '::1';
  if (local && req.headers['x-forwarded-proto']) return String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https' ? 'https' : 'http';
  return req.socket.encrypted ? 'https' : 'http';
}

function ipOf(req) {
  const peer = req.socket.remoteAddress || '';
  if ((/^(::ffff:)?127\./.test(peer) || peer === '::1') && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return peer;
}

export function createRh({ socketPath, port, host = '127.0.0.1' }) {
  const target = socketPath ? { socketPath } : { host, port };

  // new sessions per visitor per hour; memory only, nothing is stored
  const made = new Map();
  setInterval(() => {
    const cut = Date.now() - 3600000;
    for (const [k, v] of made) if (v.t < cut) made.delete(k);
  }, 60000).unref();
  function allowNewSession(req) {
    const k = ipOf(req);
    const e = made.get(k);
    const now = Date.now();
    if (!e || now - e.t > 3600000) { made.set(k, { t: now, n: 1 }); return true; }
    return ++e.n <= SESSIONS_PER_HOUR;
  }

  function outHeaders(req, raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const l = k.toLowerCase();
      if (DROP.has(l)) continue;
      out[k] = l === 'accept-encoding' ? acceptEncoding(v) : v;
    }
    out['x-rh-host'] = req.headers.host || 'localhost';
    out['x-rh-proto'] = protoOf(req);
    return out;
  }

  function handle(req, res) {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/newsession' && !allowNewSession(req)) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '600', 'cache-control': 'no-store' });
      return res.end('too many sessions, try again later');
    }
    const up = http.request(Object.assign({ method: req.method, path: req.url, headers: outHeaders(req, req.headers) }, target), (ur) => {
      res.writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('the safari engine is not running');
      } else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  // WebSocket: replay the handshake to Rammerhead, then pass bytes both ways
  function upgrade(req, socket, head) {
    const up = net.connect(target.socketPath ? { path: target.socketPath } : { host: target.host, port: target.port });
    const bail = () => { socket.destroy(); up.destroy(); };
    up.on('error', bail);
    socket.on('error', bail);
    up.on('connect', () => {
      const h = outHeaders(req, {});
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!DROP.has(req.rawHeaders[i].toLowerCase())) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      }
      for (const [k, v] of Object.entries(h)) lines.push(k + ': ' + v);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
  }

  return { handle, upgrade };
}
