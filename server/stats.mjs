// stats.mjs: a small, self-hosted visit counter.
//
// The browser sends {p: page, g: game, r: referrer host} to POST /api/p
// (js/hit.js). We keep counts per day only:
//   views     page views
//   visitors  unique visitors that day
//   visits    visits (a new one starts after 30 minutes without a hit)
//   plays     games opened
//   pages / games / refs   counts per page, game and referring site
//
// Privacy: no cookies, nothing stored in the browser, no IP addresses kept.
// A visitor is a keyed hash of IP + user agent; the key is random, changes
// every day, and only lives in memory, so the same person cannot be linked
// from one day to the next, or back to an IP. Proxy destinations, YouTube
// searches and video ids are never sent.
//
// The numbers are readable at GET /api/stats with the STATS_KEY.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEEP_DAYS = 400;
const VISIT_GAP = 30 * 60 * 1000;
const ONLINE_WINDOW = 5 * 60 * 1000;
const PER_MINUTE = 60;                       // hits per visitor per minute
const CAPS = { pages: 300, games: 2000, refs: 300 };
const BOT = /bot|crawl|spider|slurp|headless|preview|lighthouse|curl|wget|python|httpclient|java\/|go-http|node-fetch|axios|monitor/i;

export function createStats({ dir, key, tz }) {
  const file = path.join(dir, 'stats.json');
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => dayOf.format(new Date());

  fs.mkdirSync(dir, { recursive: true });
  let data = { v: 1, days: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  if (!data.days) data.days = {};

  // today's visitors: keyed hash -> last hit time. Memory only.
  let state = { day: today(), salt: crypto.randomBytes(32), seen: new Map(), rate: new Map() };
  const recent = [];
  let dirty = false;

  function rotate(day) {
    state = { day, salt: crypto.randomBytes(32), seen: new Map(), rate: new Map() };
    const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const d of Object.keys(data.days)) if (d < cut) delete data.days[d];
  }

  function bump(obj, k, cap) {
    if (!(k in obj) && Object.keys(obj).length >= cap) k = '(other)';
    obj[k] = (obj[k] || 0) + 1;
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) { dirty = true; }
  }
  setInterval(flush, 30000).unref();

  function clientIp(req) {
    const peer = req.socket.remoteAddress || '';
    // behind Caddy on this machine: trust its X-Forwarded-For
    if (/^(::ffff:)?127\.|^::1$/.test(peer) && req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    return peer;
  }

  function clean(body) {
    const out = {};
    if (typeof body.p === 'string' && /^\/[\w\-./~]{0,99}$/.test(body.p)) out.p = body.p;
    if (typeof body.g === 'string') {
      const g = body.g.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      if (g) out.g = g;
    }
    if (typeof body.r === 'string' && /^[a-z0-9.-]{1,100}$/i.test(body.r)) out.r = body.r.toLowerCase();
    return out;
  }

  function record(req, body) {
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT.test(ua)) return;
    const hit = clean(body);
    if (!hit.p) return;

    const now = Date.now();
    const day = today();
    if (day !== state.day) rotate(day);
    const h = crypto.createHmac('sha256', state.salt).update(clientIp(req) + '|' + ua).digest('hex').slice(0, 24);

    const r = state.rate.get(h);
    if (!r || now - r.t > 60000) state.rate.set(h, { t: now, n: 1 });
    else if (++r.n > PER_MINUTE) return;

    const d = data.days[day] || (data.days[day] = { views: 0, visitors: 0, visits: 0, plays: 0, pages: {}, games: {}, refs: {} });
    const last = state.seen.get(h);
    if (!last) { d.visitors++; d.visits++; }
    else if (now - last > VISIT_GAP) d.visits++;
    state.seen.set(h, now);

    if (hit.g) { d.plays++; bump(d.games, hit.g, CAPS.games); }
    else {
      d.views++;
      bump(d.pages, hit.p, CAPS.pages);
      if (hit.r) bump(d.refs, hit.r, CAPS.refs);
    }
    recent.unshift({ t: now, p: hit.p, g: hit.g || null, r: hit.r || null });
    if (recent.length > 100) recent.length = 100;
    dirty = true;
  }

  // POST /api/p  (always 204, so it reveals nothing)
  function hit(req, res) {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2048) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { record(req, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { /* ignore junk */ }
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    });
    req.on('error', () => {});
  }

  function keyOk(req) {
    if (!key) return false;
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
    const a = Buffer.from(m ? m[1] : '');
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function top(days, field, n) {
    const sum = {};
    for (const d of days) for (const [k, v] of Object.entries(d[field] || {})) sum[k] = (sum[k] || 0) + v;
    return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  // GET /api/stats?range=1|7|30|90|365
  function report(req, res) {
    const head = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (!key) { res.writeHead(404, head); return res.end('{"error":"stats are off"}'); }
    if (!keyOk(req)) { res.writeHead(401, head); return res.end('{"error":"wrong key"}'); }

    const range = Math.min(365, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('range')) || 30));
    const day = today();
    if (day !== state.day) rotate(day);
    const list = [];
    for (let i = range - 1; i >= 0; i--) {
      const ds = dayOf.format(new Date(Date.now() - i * 864e5));
      const d = data.days[ds] || {};
      list.push({ day: ds, views: d.views || 0, visitors: d.visitors || 0, visits: d.visits || 0, plays: d.plays || 0 });
    }
    const picked = list.map((x) => data.days[x.day]).filter(Boolean);
    const total = (f) => list.reduce((s, x) => s + x[f], 0);
    let online = 0;
    const now = Date.now();
    for (const t of state.seen.values()) if (now - t < ONLINE_WINDOW) online++;

    res.writeHead(200, head);
    res.end(JSON.stringify({
      tz, today: day, range, online,
      totals: { views: total('views'), visitors: total('visitors'), visits: total('visits'), plays: total('plays') },
      days: list,
      pages: top(picked, 'pages', 40),
      games: top(picked, 'games', 40),
      refs: top(picked, 'refs', 20),
      recent: recent.slice(0, 50)
    }));
  }

  return { hit, report, flush };
}
