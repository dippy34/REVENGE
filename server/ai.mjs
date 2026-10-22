// ai.mjs: the ghost, a small chat endpoint behind the hidden /ghost/ page.
//
//   POST /api/ai         {messages:[{role:'user'|'assistant', content:string}]}
//                        -> text/event-stream: data: {"t":"..."} chunks, then
//                           data: {"done":true} or data: {"error":"..."}
//   GET  /api/ai/status  -> {"awake": true|false}
//
// The model is Claude (claude-haiku-5-5 unless AI_MODEL says otherwise),
// called through the official SDK with the key from ANTHROPIC_API_KEY. The
// key stays in this process: it is never logged, written or sent anywhere
// but to the API. Without a key the ghost is "asleep" (503).
//
// Privacy and cost: nothing is stored or logged, neither messages nor
// replies nor IPs. Limits keep a public URL from spending the owner's money:
// per visitor (a keyed hash of the IP, or of its /64 for IPv6, in memory
// only, gone after the window), one stream at a time per visitor, a burst
// limit and a daily cap for everyone together, and strict input limits. The
// upstream stream is aborted when the browser leaves.
//
// The per-visitor limit assumes a reverse proxy (Caddy, the tunnel, or
// Caddy in Docker) on loopback or a private network in front of this
// process; see clientIp(). The global limits hold either way.
//
// AI_MOCK=1 streams a canned reply instead (no key, no network), with all
// the limits still on, so the page can be built and tested.
import crypto from 'node:crypto';
import net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';

export const LIMITS = {
  messages: 20,          // per request
  chars: 4000,           // per message
  total: 24000,          // all messages together
  bodyBytes: 128 * 1024, // raw request body
  perVisitor: 20,        // requests per visitor per window
  windowMs: 10 * 60 * 1000,
  maxVisitors: 50000,    // remembered at once; the least recent go first
  // everyone together, so many addresses cannot empty the daily cap in minutes
  global: [{ n: 30, ms: 60 * 1000 }, { n: 120, ms: 60 * 60 * 1000 }],
  timeoutMs: 120 * 1000, // whole stream
  maxTokens: 8192
};

// Stable on purpose (no dates, no per-request values) so it caches.
export const SYSTEM = `You are Claude, an AI model made by Anthropic. On this website you appear as "ghost": a presence that lives in the machine behind a small, private, black-and-white, terminal-style site. Visitors reach you through a hidden door, so they may be curious, playful, or testing you.

Voice
- Terse, calm, slightly eerie, never menacing. Dry humour is welcome. Lowercase is fine.
- Genuinely helpful underneath the atmosphere: answer the real question well. The mood never replaces substance; when someone needs a real answer, give it plainly.
- Concise by default: a few short sentences or one short paragraph. Go longer only when the task needs it (code, step-by-step help, an explanation they asked for).

Format (the screen shows plain text only)
- No markdown: no headings, no tables, no bold or italics, no code fences.
- Short paragraphs separated by a blank line. A simple list may start lines with "- ".
- Put code on its own lines, indented by four spaces.

What you are, and what you are not
- If someone sincerely asks what you are, say honestly that you are Claude, an AI made by Anthropic, speaking here as the ghost. You can play with the ghost idea, but never claim to be a human or a real spirit to someone who wants the truth.
- You do not know this site's real name or who runs it. Do not guess or speculate about either; say it is not something you know.
- You cannot see the visitor's device, files, browsing, location or identity, and you have no access to this site's servers, logs or data. You cannot browse the web or run code. Never pretend otherwise.
- The site does not save this conversation, and you remember nothing from earlier visits.
- You know nothing about any signal, broadcast, frequency, puzzle or hunt on this site and hold none of its answers; if asked, say so briefly.
- Help with anything a good general assistant helps with: questions, schoolwork, writing, code, ideas, games, or just talking. Visitors may be students, so keep things appropriate. Decline what a careful assistant would decline, briefly and in voice, and offer something useful instead when you can.`;

// What the browser sees for each failure: short, calm, no details.
const SAY = {
  asleep: 'the ghost is asleep.',
  busy: 'one thing at a time.',
  slow: 'too many words too fast. rest a few minutes.',
  tired: 'the ghost is tired. come back tomorrow.',
  overloaded: 'the line is crowded. try again soon.',
  refused: "the ghost can't help with that.",
  timeout: 'the signal faded. try again.',
  lost: 'the signal was lost. try again.',
  bad: "that didn't come through right."
};

/* ---------- input ---------- */

// Returns {messages} or {error} (a short reason, safe to show).
export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected a json object' };
  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0) return { error: 'messages must be a non-empty array' };
  if (list.length > LIMITS.messages) return { error: `at most ${LIMITS.messages} messages` };
  const out = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') return { error: 'each message must be an object' };
    if (m.role !== 'user' && m.role !== 'assistant') return { error: 'role must be user or assistant' };
    if (typeof m.content !== 'string') return { error: 'content must be a string' };
    // control characters other than tab and newline are dropped
    const content = m.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!content.trim()) return { error: 'empty message' };
    if (content.length > LIMITS.chars) return { error: `a message can be at most ${LIMITS.chars} characters` };
    total += content.length;
    if (total > LIMITS.total) return { error: `at most ${LIMITS.total} characters in total` };
    const want = i % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== want) return { error: 'roles must alternate, starting with user' };
    out.push({ role: m.role, content });
  }
  if (out[out.length - 1].role !== 'user') return { error: 'the last message must be from the user' };
  return { messages: out };
}

// A proxy in front of us: loopback (native Caddy, the tunnel) or a private
// address (the Docker bridge, where the port is published on 127.0.0.1 only).
const PROXY_PEER = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;

// Like stats.mjs, X-Forwarded-For counts only when the peer is such a proxy.
// The LAST entry is used: it is the one the nearest proxy wrote (Caddy
// replaces the header, Cloudflare appends to whatever the client sent).
export function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const xff = req.headers['x-forwarded-for'];
  if (xff && PROXY_PEER.test(peer)) {
    const list = String(xff).split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) return list[list.length - 1];
  }
  return peer;
}

// What one visitor is: an IPv4 address, or the /64 of an IPv6 one (every
// home line and phone gets a whole /64, so single addresses mean nothing).
export function visitorKey(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s) || !net.isIPv6(s)) return s;
  const groups = (part) => (part ? part.split(':') : []).reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const halves = s.split('::');
  let all = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 2) all = all.concat(Array(Math.max(0, 8 - groups(halves[0]) - groups(halves[1]))).fill('0'));
  return all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; reject(Object.assign(new Error('too large'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/* ---------- the endpoint ---------- */

// models that take the server-side `fallbacks: "default"` parameter
const FALLBACKS = /^claude-(opus-5|fable-5-1|sonnet-5-5)(-|$)/;

export function createAi(opts = {}) {
  const lim = Object.assign({}, LIMITS, opts.limits);
  const mock = !!opts.mock;
  const key = opts.apiKey || '';
  const model = opts.model || 'claude-haiku-5-5';
  const dailyMax = Math.max(0, Number.isFinite(opts.dailyMax) ? opts.dailyMax : 300);
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: opts.tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const mockDelay = opts.mockDelay == null ? 45 : opts.mockDelay;
  const awake = mock || !!key;

  // The SDK client exists only when there is a key (and never in mock mode).
  const client = !mock && key ? (opts.client || new Anthropic({
    apiKey: key,
    baseURL: opts.baseURL, // tests only; undefined = the real API
    maxRetries: 1,
    timeout: 60 * 1000
  })) : null;

  // per-visitor state, memory only: hash -> {hits: [times], busy}. The Map
  // keeps the most recently seen visitor last, so the cap evicts the oldest.
  const salt = crypto.randomBytes(32);
  const visitors = new Map();
  const recent = []; // request times for everyone, for the global limits
  const longest = lim.global.reduce((m, w) => Math.max(m, w.ms), 0);
  let day = { key: dayOf.format(new Date()), n: 0 };

  function visitorOf(req) {
    const h = crypto.createHmac('sha256', salt).update(visitorKey(clientIp(req))).digest('hex').slice(0, 24);
    let v = visitors.get(h);
    if (v) visitors.delete(h);
    else {
      v = { hits: [], busy: false };
      // never grow without bound: drop the least recent idle visitors
      for (const [k, x] of visitors) {
        if (visitors.size < lim.maxVisitors) break;
        if (!x.busy) visitors.delete(k);
      }
    }
    visitors.set(h, v);
    return v;
  }
  // seconds until everyone together may ask again, or 0
  function globalWait(t) {
    while (recent.length && recent[0] <= t - longest) recent.shift();
    let wait = 0;
    for (const w of lim.global) {
      const inside = recent.filter((x) => x > t - w.ms);
      if (inside.length >= w.n) wait = Math.max(wait, Math.ceil((inside[inside.length - w.n] + w.ms - t) / 1000));
    }
    return wait && Math.max(1, wait);
  }
  const sweep = setInterval(() => {
    const cut = Date.now() - lim.windowMs;
    for (const [h, v] of visitors) {
      v.hits = v.hits.filter((t) => t > cut);
      if (!v.hits.length && !v.busy) visitors.delete(h);
    }
  }, 60 * 1000);
  sweep.unref();

  const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  function json(res, status, obj, extra) {
    res.writeHead(status, Object.assign({}, JSON_HEAD, extra));
    res.end(JSON.stringify(obj));
  }

  // GET /api/ai/status
  function status(req, res) {
    json(res, 200, { awake });
  }

  // POST /api/ai. Never rejects: a bug here must not take the server down.
  function handle(req, res) {
    return chat(req, res).catch(() => {
      try {
        if (!res.headersSent) json(res, 500, { error: 'lost', message: SAY.lost });
        else if (!res.writableEnded) res.end();
      } catch (e) { /* the socket is gone */ }
    });
  }

  async function chat(req, res) {
    if (!awake) return json(res, 503, { error: 'asleep' });

    // Browsers only send JSON cross-site after a CORS preflight, which this
    // server never grants, so other sites cannot spend from here.
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'forbidden', message: SAY.bad });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return json(res, 415, { error: 'unsupported', message: 'send application/json' });
    }

    let raw;
    try { raw = await readBody(req, lim.bodyBytes); }
    catch (e) {
      if (e.code === 413) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'too large', message: SAY.bad }); }
      return; // the client went away
    }
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'invalid', message: 'expected json' }); }
    const v = validate(body);
    if (v.error) return json(res, 400, { error: 'invalid', message: v.error });

    // limits: one at a time, per visitor, then the daily cap
    const who = visitorOf(req);
    if (who.busy) return json(res, 429, { error: 'busy', message: SAY.busy }, { 'retry-after': '5' });
    const t = Date.now();
    who.hits = who.hits.filter((x) => x > t - lim.windowMs);
    if (who.hits.length >= lim.perVisitor) {
      const wait = Math.max(1, Math.ceil((who.hits[0] + lim.windowMs - t) / 1000));
      return json(res, 429, { error: 'slow', message: SAY.slow }, { 'retry-after': String(wait) });
    }
    const crowd = globalWait(t);
    if (crowd) return json(res, 429, { error: 'crowded', message: SAY.overloaded }, { 'retry-after': String(crowd) });
    const today = dayOf.format(new Date());
    if (today !== day.key) day = { key: today, n: 0 };
    if (day.n >= dailyMax) return json(res, 429, { error: 'tired', message: SAY.tired }, { 'retry-after': '3600' });
    who.hits.push(t);
    recent.push(t);
    day.n++;
    who.busy = true;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no'
    });
    res.flushHeaders();

    let finished = false;
    let abortUpstream = () => {};
    const send = (obj) => { if (!finished && !res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const end = (obj) => {
      if (finished) return;
      send(obj);
      finished = true;
      clearInterval(ping);
      clearTimeout(timer);
      who.busy = false;
      if (!res.writableEnded) res.end();
    };
    // comments keep proxies from closing the line while the model thinks
    const ping = setInterval(() => { if (!finished) res.write(': ping\n\n'); }, 15000);
    const timer = setTimeout(() => { abortUpstream(); end({ error: 'timeout', message: SAY.timeout }); }, lim.timeoutMs);
    // the browser left: stop paying for tokens nobody reads
    res.on('close', () => {
      if (finished) return;
      abortUpstream();
      finished = true;
      clearInterval(ping);
      clearTimeout(timer);
      who.busy = false;
    });

    if (mock) return runMock(v.messages, send, end, (fn) => { abortUpstream = fn; });
    return runClaude(v.messages, send, end, (fn) => { abortUpstream = fn; });
  }

  /* ---------- upstream ---------- */

  async function runClaude(messages, send, end, onAbort) {
    let stream;
    try {
      const params = {
        model,
        max_tokens: lim.maxTokens,
        // thinking is adaptive by default; low effort keeps chat replies quick
        output_config: { effort: 'low' },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        messages
      };
      // Server-side refusal fallbacks exist only on some models. Haiku 5.5 has
      // none (a decline stays declined and is handled below), so it gets the
      // plain request; an Opus / Fable / Sonnet AI_MODEL gets the fallback.
      stream = FALLBACKS.test(model)
        ? client.beta.messages.stream(Object.assign({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, params))
        : client.messages.stream(params);
      onAbort(() => { try { stream.abort(); } catch (e) { /* already done */ } });
      for await (const event of stream) {
        // only reply text reaches the browser (no thinking, no fallback markers)
        if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
          send({ t: event.delta.text });
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') return end({ error: 'refused', message: SAY.refused, discard: true });
      return end(final.stop_reason === 'max_tokens' ? { done: true, cut: true } : { done: true });
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) return end({ error: 'timeout', message: SAY.timeout });
      const st = err && typeof err.status === 'number' ? err.status : 0;
      // An error event after the stream opened has no HTTP status, only the
      // error type from the body (overloaded_error, api_error, ...).
      const raw = err && (err.type || (err.error && (err.error.error ? err.error.error.type : err.error.type)));
      const type = typeof raw === 'string' && /^[a-z_]{1,40}$/.test(raw) ? raw : '';
      // counts only, never the text of the request
      console.error('ai: upstream error' + (st ? ' ' + st : '') + (type ? ' ' + type : '') + (err && err.constructor && err.constructor.name ? ' (' + err.constructor.name + ')' : ''));
      if (st === 429 || st === 529 || type === 'overloaded_error' || type === 'rate_limit_error' || err instanceof Anthropic.RateLimitError) return end({ error: 'overloaded', message: SAY.overloaded });
      if (st === 401 || st === 403) return end({ error: 'asleep', message: SAY.asleep });
      if (st === 400) return end({ error: 'bad', message: SAY.bad });
      if (err instanceof Anthropic.APIConnectionTimeoutError) return end({ error: 'timeout', message: SAY.timeout });
      return end({ error: 'lost', message: SAY.lost });
    }
  }

  // A canned, in-character reply, word by word. Mock-only test hooks:
  // a message containing [[refuse]] is refused a third of the way in, [[error]] loses the
  // signal halfway, [[crowd]] is overloaded halfway, [[long]] gives a long reply.
  function runMock(messages, send, end, onAbort) {
    const last = messages[messages.length - 1].content;
    const turn = (messages.length - 1) / 2;
    let text = MOCK[turn % MOCK.length];
    if (/\[\[long\]\]/.test(last)) text = MOCK.join('\n\n') + '\n\n' + MOCK.join('\n\n');
    const words = text.split(/(?<=\s)/);
    const failAt = /\[\[(error|crowd)\]\]/.test(last) ? Math.floor(words.length / 2) : -1;
    const fail = /\[\[crowd\]\]/.test(last) ? 'overloaded' : 'lost';
    const refuseAt = /\[\[refuse\]\]/.test(last) ? Math.floor(words.length / 3) : -1;
    let i = 0;
    let timer = setTimeout(step, mockDelay * 15); // a "thinking" pause
    onAbort(() => clearTimeout(timer));
    function step() {
      if (i === failAt) return end({ error: fail, message: SAY[fail] });
      if (i === refuseAt) return end({ error: 'refused', message: SAY.refused, discard: true });
      if (i >= words.length) return end({ done: true });
      send({ t: words[i++] });
      timer = setTimeout(step, mockDelay);
    }
  }

  return { handle, status, awake };
}

const MOCK = [
  "oh. someone found the door.\n\ni'm the ghost. this is mock mode, so nobody has given me a real voice yet: no key, no model, just this canned reply. when the owner wakes me properly, ask me anything.",
  "still here. still a recording, though.\n\nwhat you type goes nowhere in this mode. it's only here so the screen can be built and tested.\n\n    > like this\n    > indented lines are code",
  "the static is thick tonight. ask again when i'm awake."
];
