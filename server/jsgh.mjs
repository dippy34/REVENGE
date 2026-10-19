// jsgh.mjs: serves /jsgh/* — GitHub files the gn-math games load, from this
// origin, with a disk cache in front.
//
// Why not load them from the CDN in the browser:
//   - jsDelivr returns 403 for the gn-math user ("User gn-math is blocked")
//   - school and work filters often block cdn.jsdelivr.net entirely
//   - raw.githubusercontent.com sends text/plain + nosniff, so a <script>
//     or <link> pointed at it will not run
//
// The games page rewrites cdn.jsdelivr.net/gh/... to /jsgh/user/repo@version/path.
// This relay tries jsDelivr first (except for gn-math), then GitHub raw, and
// sets a real Content-Type from the file extension when upstream sends
// text/plain.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { Transform, pipeline } from 'node:stream';

const MAX_UPSTREAM = 8;
const MAX_FILE = 300 * 1024 * 1024;
const MAX_HTML = 4 * 1024 * 1024;
const RETRIES = 3;
const PREFIX = '/jsgh/';
const JSDELIVR_GH = /(?:https?:)?\/\/(?:cdn|fastly|gcore|testingcf|quantil)\.jsdelivr\.net\/gh\//gi;
const RUFFLE_SRC = /(<script\b[^>]*\bsrc=["'])(?:https?:)?\/\/[^"']*\bruffle\b[^"']*(["'])/gi;

const EXT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.swf': 'application/x-shockwave-flash', '.xml': 'application/xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.data': 'application/octet-stream', '.unityweb': 'application/octet-stream',
  '.bundle': 'application/octet-stream', '.mem': 'application/octet-stream',
  '.pck': 'application/octet-stream', '.unity3d': 'application/octet-stream',
  '.br': 'application/octet-stream', '.gz': 'application/octet-stream'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (key) => crypto.createHash('sha256').update(key).digest('hex');

export function rewriteJsdelivr(html, origin) {
  const prefix = String(origin || '').replace(/\/+$/, '') + PREFIX;
  return html
    .replace(JSDELIVR_GH, prefix)
    .replace(RUFFLE_SRC, '$1/vendor/ruffle/ruffle.js$2');
}

// "/jsgh/user/repo@version/a/b.js" or "/jsgh/user/repo/a/b.js"
export function parseJsgh(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  let rest;
  try { rest = decodeURIComponent(pathname.slice(PREFIX.length)); } catch (e) { return null; }
  if (!rest || rest.includes('\0') || rest.length > 500) return null;
  const segs = [];
  for (const s of rest.split('/')) {
    if (!s || s === '.' || s === '..' || /[\u0000-\u001f\u007f]/.test(s)) return null;
    segs.push(s);
  }
  if (segs.length < 2) return null;
  const user = segs[0];
  let repo = segs[1];
  let version = '';
  const at = repo.lastIndexOf('@');
  if (at > 0) {
    version = repo.slice(at + 1);
    repo = repo.slice(0, at);
  }
  const file = segs.slice(2);
  if (!/^[A-Za-z0-9._-]{1,39}$/.test(user)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  if (version && !/^[A-Za-z0-9._-]{1,64}$/.test(version)) return null;
  if (file.some((s) => !/^[A-Za-z0-9._~%-]{1,120}$/.test(s))) return null;
  return { user, repo, version, file, key: rest };
}

function typeFor(fileSegs, upstreamType) {
  const name = fileSegs[fileSegs.length - 1] || '';
  const ext = path.extname(name).toLowerCase();
  if (ext === '.wasm') return 'application/wasm';
  const up = (upstreamType || '').split(';')[0].trim().toLowerCase();
  if (!up || up === 'text/plain' || up === 'application/octet-stream' || up === 'binary/octet-stream') {
    return EXT_TYPES[ext] || (ext ? 'application/octet-stream' : (up || 'application/octet-stream'));
  }
  return upstreamType;
}

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

export function upstreams(info) {
  const p = info.file.map(encodeURIComponent).join('/');
  const urls = [];
  if (info.user.toLowerCase() !== 'gn-math') {
    urls.push(info.version
      ? `https://cdn.jsdelivr.net/gh/${info.user}/${info.repo}@${info.version}/${p}`
      : `https://cdn.jsdelivr.net/gh/${info.user}/${info.repo}/${p}`);
  }
  const ref = info.version || 'main';
  urls.push(`https://raw.githubusercontent.com/${info.user}/${info.repo}/${ref}/${p}`);
  if (!info.version) urls.push(`https://raw.githubusercontent.com/${info.user}/${info.repo}/master/${p}`);
  return urls;
}

export function createJsgh({ cacheDir, maxBytes, headersFor }) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM });
  const index = new Map();
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
        } catch (e) { /* half-written */ }
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

  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((ok) => { if (active < MAX_UPSTREAM) { active++; ok(); } else waiting.push(ok); });
  const release = () => { const n = waiting.shift(); if (n) n(); else active--; };

  function requestUrl(url, method, range) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const rq = https.request({
        host: u.hostname, port: 443, path: u.pathname + u.search, method, agent, timeout: 30000,
        headers: Object.assign({
          host: u.hostname,
          'user-agent': 'Mozilla/5.0 (compatible; cache)',
          accept: '*/*'
        }, range ? { range } : {})
      }, resolve);
      rq.on('timeout', () => rq.destroy(new Error('timeout')));
      rq.on('error', reject);
      rq.end();
    });
  }

  async function fetchUp(info, method, range) {
    const urls = upstreams(info);
    let lastErr;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const more = i < urls.length - 1;
      for (let attempt = 0; ; attempt++) {
        await acquire();
        let freed = false;
        const free = () => { if (!freed) { freed = true; release(); } };
        let up;
        try {
          up = await requestUrl(url, method, range);
        } catch (e) {
          free();
          lastErr = e;
          if (attempt >= RETRIES) break;
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
        // gn-math (and any other blocked user) is 403 on jsDelivr; try GitHub raw
        if (more && (up.statusCode === 403 || up.statusCode === 404 || up.statusCode === 451)) {
          up.resume();
          free();
          break;
        }
        up.on('close', free);
        return up;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  function headersOut(pathname, meta, isHtml) {
    const h = Object.assign({}, headersFor(pathname));
    h['content-type'] = meta.type;
    if (meta.enc) h['content-encoding'] = meta.enc;
    h['accept-ranges'] = 'bytes';
    h['x-content-type-options'] = 'nosniff';
    h['cache-control'] = isHtml ? 'public, max-age=300' : 'public, max-age=86400';
    return h;
  }

  async function serveCached(req, res, pathname, h) {
    const meta = JSON.parse(await fsp.readFile(metaPath(h), 'utf8'));
    const file = bodyPath(h);
    const st = await fsp.stat(file);
    const entry = index.get(h);
    const now = Date.now();
    if (entry && now - entry.t > 600000) {
      entry.t = now;
      fsp.utimes(file, now / 1000, now / 1000).catch(() => {});
    }
    const isHtml = /text\/html/i.test(meta.type) && st.size <= MAX_HTML;
    if (isHtml) {
      const body = Buffer.from((await fsp.readFile(file)).toString('utf8'), 'utf8');
      const hd = headersOut(pathname, meta, true);
      hd['content-length'] = body.length;
      delete hd['accept-ranges'];
      res.writeHead(200, hd);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const hd = headersOut(pathname, meta, false);
    const r = parseRange(req.headers.range, st.size);
    if (r === 'bad') { hd['content-range'] = `bytes */${st.size}`; res.writeHead(416, hd); return res.end(); }
    let start = 0, end = st.size - 1, status = 200;
    if (r) { [start, end] = r; status = 206; hd['content-range'] = `bytes ${start}-${end}/${st.size}`; }
    hd['content-length'] = end - start + 1;
    res.writeHead(status, hd);
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  }

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
      const pathname = new URL(req.url, 'http://x').pathname;
      const info = parseJsgh(pathname);
      if (!info || !info.file.length) return plain(res, 404, 'not found');
      const h = hashOf(info.key);

      if (index.has(h)) {
        try { return await serveCached(req, res, pathname, h); }
        catch (e) { remove(h); if (res.headersSent) return res.destroy(); }
      }

      const range = req.method === 'GET' ? req.headers.range : undefined;
      let up;
      try { up = await fetchUp(info, req.method, range); }
      catch (e) { return plain(res, 502, 'game storage is not answering, try again', { 'retry-after': '5' }); }
      if (!up) return plain(res, 404, 'not found');

      if (up.statusCode === 404 || up.statusCode === 403) { up.resume(); return plain(res, 404, 'not found'); }
      if (up.statusCode >= 500 || up.statusCode === 429) { up.resume(); return plain(res, 503, 'game storage is busy, try again', { 'retry-after': '5' }); }

      const type = typeFor(info.file, up.headers['content-type']);
      const enc = up.headers['content-encoding'] || '';
      const meta = { type, enc };
      const isHtml = /text\/html/i.test(type);
      const len = Number(up.headers['content-length']) || 0;

      if (up.statusCode !== 200 || req.method !== 'GET') {
        const hd = headersOut(pathname, meta, isHtml);
        if (up.headers['content-range']) hd['content-range'] = up.headers['content-range'];
        if (len) hd['content-length'] = len;
        if (isHtml) delete hd['content-length'];
        res.writeHead(up.statusCode, hd);
        if (req.method === 'HEAD') { up.resume(); return res.end(); }
        return pipeline(up, res, () => up.destroy());
      }

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
        const hd = headersOut(pathname, meta, true);
        hd['content-length'] = raw.length;
        delete hd['accept-ranges'];
        res.writeHead(200, hd);
        return res.end(raw);
      }

      const hd = headersOut(pathname, meta, false);
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
