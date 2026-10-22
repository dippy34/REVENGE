// semag.mjs: serves /semag/* (the games stored in the R2 bucket) from our own
// origin, with a disk cache in front of the bucket.
//
// Why not link to the bucket's r2.dev address directly:
//   - r2.dev rate-limits (HTTP 429) the burst of requests a Unity game makes,
//   - school and work filters block r2.dev,
//   - the address bar and every request would leave this domain.
//
// What it does:
//   - the upstream host is fixed (R2_BASE) and the path is validated, so it
//     cannot be pointed anywhere else
//   - files are relayed byte for byte (no decoding), so .br/.gz builds still
//     work, and cached on disk with a size cap (oldest evicted first)
//   - at most 8 requests to the bucket at a time, retried on 429 and 5xx
//   - Range requests are answered from the cache, or passed through
//   - game pages (HTML) are patched on the way out: Ruffle is loaded from
//     /vendor/ruffle/ instead of unpkg.com, anti-framing code is removed,
//     and ad / analytics scripts are dropped
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { Transform, pipeline } from 'node:stream';

const MAX_UPSTREAM = 8;          // parallel requests to the bucket
const MAX_FILE = 300 * 1024 * 1024;
const MAX_HTML = 4 * 1024 * 1024;
const RETRIES = 3;

const EXT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.swf': 'application/x-shockwave-flash', '.xml': 'application/xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.data': 'application/octet-stream'
};

/* ---------- patching game pages ---------- */

const RUFFLE_SRC = /(<script\b[^>]*\bsrc=["'])(?:https?:)?\/\/[^"']*\bruffle\b[^"']*(["'])/gi;
const ANTI_CLICKJACK_STYLE = /<style\b[^>]*\bid=["']antiClickjack["'][^>]*>[\s\S]*?<\/style>/gi;
const ANTI_CLICKJACK_SCRIPT = /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?\btop\.location\s*=\s*self\.location[\s\S]*?<\/script>/gi;
const TRACKER_SCRIPT = /<script\b[^>]*\bsrc=["'](?:https?:)?\/\/[^"']*(?:googlesyndication|googletagmanager|google-analytics|doubleclick|adsbygoogle)[^"']*["'][^>]*>\s*<\/script>/gi;

export function patchHtml(html) {
  return html
    .replace(RUFFLE_SRC, '$1/vendor/ruffle/ruffle.js$2')
    .replace(ANTI_CLICKJACK_STYLE, '')
    .replace(ANTI_CLICKJACK_SCRIPT, '')
    .replace(TRACKER_SCRIPT, '');
}

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (key) => crypto.createHash('sha256').update(key).digest('hex');

// "/semag/dir/file" -> ["semag","dir","file"], or null if it is not a clean path
function parsePath(pathname) {
  if (!pathname.startsWith('/semag/')) return null;
  let rest = pathname.slice(1);
  if (rest.endsWith('/')) rest += 'index.html';
  const segs = [];
  for (const s of rest.split('/')) {
    let d;
    try { d = decodeURIComponent(s); } catch (e) { return null; }
    if (!d || d === '.' || d === '..' || /[\/\\\u0000-\u001f\u007f]/.test(d)) return null;
    segs.push(d);
  }
  if (segs.length < 2 || segs.join('/').length > 400) return null;
  return segs;
}

function typeFor(segs, upstreamType) {
  const ext = path.extname(segs[segs.length - 1]).toLowerCase();
  const up = (upstreamType || '').split(';')[0].trim().toLowerCase();
  if (ext === '.wasm' && !/\.(br|gz)$/.test(segs[segs.length - 1])) return 'application/wasm';
  if (!up || up === 'application/octet-stream' || up === 'binary/octet-stream') {
    return EXT_TYPES[ext] || 'application/octet-stream';
  }
  return upstreamType;
}

// "bytes=a-b" -> [a, b] | 'bad' | null (not a single range, so ignore it)
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let a, b;
  if (m[1] === '') { a = Math.max(0, size - Number(m[2])); b = size - 1; }
  else { a = Number(m[1]); b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return a > b || a >= size ? 'bad' : [a, b];
}

function plain(res, status, text, extra) {
  res.writeHead(status, Object.assign({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }, extra));
  res.end(text);
}

/* ---------- the relay ---------- */

export function createSemag({ base, cacheDir, maxBytes, headersFor }) {
  const baseUrl = new URL(base);
  const agent = new https.Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM });
  const index = new Map();       // hash -> { size, t }
  let total = 0;

  const bodyPath = (h) => path.join(cacheDir, h.slice(0, 2), h + '.body');
  const metaPath = (h) => path.join(cacheDir, h.slice(0, 2), h + '.meta');

  fs.mkdirSync(cacheDir, { recursive: true });
  (function scan() {
    for (const d of fs.readdirSync(cacheDir)) {
      const dir = path.join(cacheDir, d);
      let files;
      try { files = fs.readdirSync(dir); } catch (e) { continue; }
      for (const f of files) {
        const full = path.join(dir, f);
        try {
          if (f.endsWith('.tmp')) { fs.unlinkSync(full); continue; }
          if (!f.endsWith('.meta')) continue;
          const h = f.slice(0, -5);
          const st = fs.statSync(bodyPath(h));
          index.set(h, { size: st.size, t: st.mtimeMs });
          total += st.size;
        } catch (e) { /* half-written entry: ignored, evicted or overwritten later */ }
      }
    }
  })();

  function remove(h) {
    const e = index.get(h);
    if (!e) return;
    index.delete(h);
    total -= e.size;
    fs.unlink(bodyPath(h), () => {});
    fs.unlink(metaPath(h), () => {});
  }

  function evict() {
    if (total <= maxBytes) return;
    const oldest = [...index.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [h] of oldest) {
      if (total <= maxBytes * 0.9) break;
      remove(h);
    }
  }

  /* limit and retry requests to the bucket */
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((ok) => { if (active < MAX_UPSTREAM) { active++; ok(); } else waiting.push(ok); });
  const release = () => { const n = waiting.shift(); if (n) n(); else active--; };

  async function fetchUp(segs, method, range) {
    const p = (baseUrl.pathname.replace(/\/+$/, '')) + '/' + segs.map(encodeURIComponent).join('/');
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let freed = false;
      const free = () => { if (!freed) { freed = true; release(); } };
      let up;
      try {
        up = await new Promise((resolve, reject) => {
          const rq = https.request({
            host: baseUrl.hostname, port: 443, path: p, method, agent, timeout: 30000,
            headers: Object.assign({ host: baseUrl.hostname, 'user-agent': 'Mozilla/5.0 (compatible; cache)', accept: '*/*' }, range ? { range } : {})
          }, resolve);
          rq.on('timeout', () => rq.destroy(new Error('timeout')));
          rq.on('error', reject);
          rq.end();
        });
      } catch (e) {
        free();
        if (attempt >= RETRIES) throw e;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      if ((up.statusCode === 429 || up.statusCode >= 500) && attempt < RETRIES) {
        const wait = Number(up.headers['retry-after']);
        up.resume();
        free();
        await sleep(wait > 0 && wait < 10 ? wait * 1000 : 400 * 2 ** attempt);
        continue;
      }
      up.on('close', free);
      return up;
    }
  }

  function headersOut(segs, meta, isHtml) {
    const h = Object.assign({}, headersFor('/' + segs.join('/')));
    h['content-type'] = meta.type;
    if (meta.enc) h['content-encoding'] = meta.enc;
    h['accept-ranges'] = 'bytes';
    h['x-content-type-options'] = 'nosniff';
    h['cache-control'] = isHtml ? 'public, max-age=300' : 'public, max-age=86400';
    return h;
  }

  /* answer from the disk cache */
  async function serveCached(req, res, segs, h) {
    const meta = JSON.parse(await fsp.readFile(metaPath(h), 'utf8'));
    const file = bodyPath(h);
    const st = await fsp.stat(file);
    const entry = index.get(h);
    const now = Date.now();
    if (entry && now - entry.t > 600000) {   // remember it was used, for eviction order
      entry.t = now;
      fsp.utimes(file, now / 1000, now / 1000).catch(() => {});
    }
    const isHtml = /text\/html/i.test(meta.type) && st.size <= MAX_HTML;
    if (isHtml) {
      const body = Buffer.from(patchHtml((await fsp.readFile(file)).toString('utf8')), 'utf8');
      const hd = headersOut(segs, meta, true);
      hd['content-length'] = body.length;
      delete hd['accept-ranges'];
      res.writeHead(200, hd);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const hd = headersOut(segs, meta, false);
    const r = parseRange(req.headers.range, st.size);
    if (r === 'bad') { hd['content-range'] = `bytes */${st.size}`; res.writeHead(416, hd); return res.end(); }
    let start = 0, end = st.size - 1, status = 200;
    if (r) { [start, end] = r; status = 206; hd['content-range'] = `bytes ${start}-${end}/${st.size}`; }
    hd['content-length'] = end - start + 1;
    res.writeHead(status, hd);
    if (req.method === 'HEAD') return res.end();
    // a client that leaves early ends the pipeline before the file is open;
    // the late open error (file evicted meanwhile) must not crash the server
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => {});
    pipeline(rs, res, () => {});
  }

  /* copy the bytes into the cache while they stream to the visitor */
  function teeToCache(h, meta, expected) {
    const dir = path.join(cacheDir, h.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, h + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    const ws = fs.createWriteStream(tmp);
    let size = 0, failed = false, done = false;
    ws.on('error', () => { failed = true; });
    const drop = () => { failed = true; ws.destroy(); fs.unlink(tmp, () => {}); };
    const t = new Transform({
      transform(chunk, _enc, cb) {
        if (!failed) {
          size += chunk.length;
          if (size > MAX_FILE || ws.writableLength > 8 * 1024 * 1024) drop(); else ws.write(chunk);
        }
        cb(null, chunk);
      },
      flush(cb) {
        if (failed || (expected && size !== expected)) { drop(); return cb(); }
        ws.end(() => {
          try {
            fs.writeFileSync(tmp + '.meta', JSON.stringify(meta));
            fs.renameSync(tmp, bodyPath(h));
            fs.renameSync(tmp + '.meta', metaPath(h));
            const old = index.get(h);
            if (old) total -= old.size;
            index.set(h, { size, t: Date.now() });
            total += size;
            done = true;
            evict();
          } catch (e) { drop(); }
          cb();
        });
      }
    });
    t.on('close', () => { if (!done) drop(); });
    return t;
  }

  async function handle(req, res) {
    try {
      const segs = parsePath(new URL(req.url, 'http://x').pathname);
      if (!segs) return plain(res, 404, 'not found');
      const key = segs.join('/');
      const h = hashOf(key);

      if (index.has(h)) {
        try { return await serveCached(req, res, segs, h); }
        catch (e) { remove(h); if (res.headersSent) return res.destroy(); }
      }

      const range = req.method === 'GET' ? req.headers.range : undefined;
      let up;
      try { up = await fetchUp(segs, req.method, range); }
      catch (e) { return plain(res, 502, 'game storage is not answering, try again', { 'retry-after': '5' }); }

      if (up.statusCode === 404 || up.statusCode === 403) { up.resume(); return plain(res, 404, 'not found'); }
      if (up.statusCode >= 500 || up.statusCode === 429) { up.resume(); return plain(res, 503, 'game storage is busy, try again', { 'retry-after': '5' }); }

      const type = typeFor(segs, up.headers['content-type']);
      const enc = up.headers['content-encoding'] || '';
      const meta = { type, enc };
      const isHtml = /text\/html/i.test(type);
      const len = Number(up.headers['content-length']) || 0;

      // ranges, HEAD and anything that is not a plain 200: pass through, no caching
      if (up.statusCode !== 200 || req.method !== 'GET') {
        const hd = headersOut(segs, meta, isHtml);
        if (up.headers['content-range']) hd['content-range'] = up.headers['content-range'];
        if (len) hd['content-length'] = len;
        if (isHtml) delete hd['content-length'];
        res.writeHead(up.statusCode, hd);
        if (req.method === 'HEAD') { up.resume(); return res.end(); }
        return pipeline(up, res, () => up.destroy());
      }

      // pages: read whole, keep the original in the cache, send the patched one
      if (isHtml && len <= MAX_HTML) {
        const chunks = [];
        let got = 0, aborted = false;
        for await (const c of up) {
          got += c.length;
          if (got > MAX_HTML) { aborted = true; up.destroy(); break; }
          chunks.push(c);
        }
        if (aborted) return plain(res, 502, 'page too large');
        const raw = Buffer.concat(chunks);
        const w = teeToCache(h, meta, raw.length);
        w.on('error', () => {});
        w.resume();
        w.end(raw);
        const body = Buffer.from(patchHtml(raw.toString('utf8')), 'utf8');
        const hd = headersOut(segs, meta, true);
        hd['content-length'] = body.length;
        delete hd['accept-ranges'];
        res.writeHead(200, hd);
        return res.end(body);
      }

      const hd = headersOut(segs, meta, false);
      if (len) hd['content-length'] = len;
      res.writeHead(200, hd);
      const cacheable = !len || len <= MAX_FILE;
      pipeline(...(cacheable ? [up, teeToCache(h, meta, len), res] : [up, res]), () => up.destroy());
    } catch (e) {
      if (!res.headersSent) plain(res, 500, 'error');
      else res.destroy();
    }
  }

  return { handle, stats: () => ({ files: index.size, bytes: total }) };
}
