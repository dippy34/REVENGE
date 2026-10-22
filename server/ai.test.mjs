// ai.test.mjs: the ghost endpoint. No real API calls: mock mode, or the real
// SDK pointed at a fake Anthropic server on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAi, validate, clientIp, visitorKey, LIMITS, SYSTEM } from './ai.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// a site server with just the two ghost routes
async function site(t, opts) {
  const ai = createAi(Object.assign({ mockDelay: 1 }, opts));
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && p === '/api/ai') return ai.handle(req, res);
    if (p === '/api/ai/status') return ai.status(req, res);
    res.writeHead(404); res.end();
  });
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { port: await listen(server), ai };
}

function request(port, { method = 'POST', path = '/api/ai', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, headers)
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* a stream */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, events: events(text) });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// "data: {...}" lines of an event stream, parsed
function events(text) {
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
}

const hi = { messages: [{ role: 'user', content: 'hello?' }] };

/* ---------- validation ---------- */

test('validate accepts a normal conversation', () => {
  const v = validate({ messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c\nd' }
  ] });
  assert.equal(v.error, undefined);
  assert.equal(v.messages.length, 3);
  assert.deepEqual(Object.keys(v.messages[0]), ['role', 'content']);
});

test('validate rejects bad shapes and limits', () => {
  const u = (c) => ({ role: 'user', content: c });
  const a = (c) => ({ role: 'assistant', content: c });
  const bad = [
    null, [], {}, { messages: [] }, { messages: 'hi' },
    { messages: [a('x')] },                                  // starts with assistant
    { messages: [u('x'), a('y')] },                          // ends with assistant
    { messages: [u('x'), u('y')] },                          // does not alternate
    { messages: [{ role: 'system', content: 'x' }] },        // role
    { messages: [{ role: 'user', content: 5 }] },            // not a string
    { messages: [{ role: 'user', content: ['x'] }] },
    { messages: [u('   ')] },                                // empty
    { messages: [u('x'.repeat(LIMITS.chars + 1))] },         // one too long
    { messages: Array.from({ length: LIMITS.messages + 1 }, (_, i) => (i % 2 ? a('y') : u('x'))) },
    { messages: Array.from({ length: 7 }, (_, i) => (i % 2 ? a('y'.repeat(3999)) : u('x'.repeat(3999)))) } // total
  ];
  for (const b of bad) assert.ok(validate(b).error, 'expected an error for ' + JSON.stringify(b).slice(0, 80));
  assert.equal(validate({ messages: [u('x'.repeat(LIMITS.chars))] }).error, undefined);
});

test('validate drops control characters', () => {
  const v = validate({ messages: [{ role: 'user', content: 'a\u0000b\u001bc\td\ne' }] });
  assert.equal(v.messages[0].content, 'abc\td\ne');
});

test('clientIp trusts X-Forwarded-For only from a proxy on this machine or network', () => {
  const r = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  // the last entry is the one the nearest proxy wrote
  assert.equal(clientIp(r('127.0.0.1', '6.6.6.6, 9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(r('::ffff:127.0.0.1', '9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(r('::1', '9.9.9.9 , ')), '9.9.9.9');
  assert.equal(clientIp(r('172.18.0.1', '9.9.9.9')), '9.9.9.9');     // the Docker bridge
  assert.equal(clientIp(r('::ffff:10.0.0.3', '9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(r('203.0.113.5', '9.9.9.9')), '203.0.113.5');
  assert.equal(clientIp(r('172.32.0.1', '9.9.9.9')), '172.32.0.1');   // not private
  assert.equal(clientIp(r('203.0.113.5')), '203.0.113.5');
});

test('visitorKey groups IPv6 by /64 and unwraps mapped IPv4', () => {
  assert.equal(visitorKey('198.51.100.7'), '198.51.100.7');
  assert.equal(visitorKey('::ffff:198.51.100.7'), '198.51.100.7');
  const a = visitorKey('2001:db8:abcd:12:1111:2222:3333:4444');
  assert.equal(a, '2001:db8:abcd:12::/64');
  assert.equal(visitorKey('2001:0DB8:abcd:0012::1'), a);
  assert.equal(visitorKey('2001:db8:abcd:12:ffff::9%eth0'), a);
  assert.notEqual(visitorKey('2001:db8:abcd:13::1'), a);
  assert.equal(visitorKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(visitorKey('::1'), '0:0:0:0::/64');
  assert.equal(visitorKey('64:ff9b::198.51.100.7'), '64:ff9b:0:0::/64');
});

/* ---------- asleep ---------- */

test('without a key the ghost is asleep', async (t) => {
  const { port } = await site(t, {});
  const s = await request(port, { method: 'GET', path: '/api/ai/status' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { awake: false });
  const r = await request(port, { body: hi });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'asleep' });
});

/* ---------- requests ---------- */

test('bad requests get clean json errors', async (t) => {
  const { port } = await site(t, { mock: true });
  let r = await request(port, { body: '{nope' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid');
  r = await request(port, { body: { messages: [{ role: 'assistant', content: 'x' }] } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message);
  r = await request(port, { body: hi, headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await request(port, { body: hi, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  r = await request(port, { body: 'x'.repeat(LIMITS.bodyBytes + 10) });
  assert.equal(r.status, 413);
});

test('mock mode streams a reply word by word', async (t) => {
  const { port } = await site(t, { mock: true });
  const s = await request(port, { method: 'GET', path: '/api/ai/status' });
  assert.deepEqual(s.json, { awake: true });
  const r = await request(port, { body: hi, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const ev = r.events;
  assert.ok(ev.length > 5, 'expected several chunks');
  assert.deepEqual(ev[ev.length - 1], { done: true });
  const text = ev.slice(0, -1).map((e) => e.t).join('');
  assert.match(text, /mock mode/);
});

test('mock hooks: refusal and a lost signal', async (t) => {
  const { port } = await site(t, { mock: true });
  let r = await request(port, { body: { messages: [{ role: 'user', content: 'please [[refuse]]' }] } });
  let last = r.events[r.events.length - 1];
  assert.equal(last.error, 'refused');
  assert.equal(last.discard, true);
  r = await request(port, { body: { messages: [{ role: 'user', content: '[[error]]' }] } });
  last = r.events[r.events.length - 1];
  assert.equal(last.error, 'lost');
});

/* ---------- limits ---------- */

test('per-visitor limit answers 429 with retry-after', async (t) => {
  const { port } = await site(t, { mock: true, limits: { perVisitor: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await request(port, { body: hi })).status, 200);
  const r = await request(port, { body: hi });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'slow');
  assert.ok(Number(r.headers['retry-after']) > 0);
  // a different visitor (behind the loopback proxy) is not affected
  const other = await request(port, { body: hi, headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(other.status, 200);
});

test('daily cap applies to everyone together', async (t) => {
  const { port } = await site(t, { mock: true, dailyMax: 2 });
  assert.equal((await request(port, { body: hi, headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200);
  assert.equal((await request(port, { body: hi, headers: { 'x-forwarded-for': '198.51.100.2' } })).status, 200);
  const r = await request(port, { body: hi, headers: { 'x-forwarded-for': '198.51.100.3' } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'tired');
});

test('one IPv6 /64 is one visitor', async (t) => {
  const { port } = await site(t, { mock: true, limits: { perVisitor: 2 } });
  const from = (ip) => ({ body: hi, headers: { 'x-forwarded-for': ip } });
  assert.equal((await request(port, from('2001:db8:1:2::a'))).status, 200);
  assert.equal((await request(port, from('2001:db8:1:2::b'))).status, 200);
  const r = await request(port, from('2001:db8:1:2:dead:beef:0:1'));
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'slow');
  assert.equal((await request(port, from('2001:db8:1:3::a'))).status, 200);
});

test('a full visitor table forgets the least recent, not everyone', async (t) => {
  const { port } = await site(t, { mock: true, limits: { perVisitor: 1, maxVisitors: 2 } });
  const from = (ip) => request(port, { body: hi, headers: { 'x-forwarded-for': ip } });
  assert.equal((await from('198.51.100.1')).status, 200);
  assert.equal((await from('198.51.100.2')).status, 200);
  assert.equal((await from('198.51.100.2')).status, 429); // seen again: now the most recent
  assert.equal((await from('198.51.100.3')).status, 200); // table full: .1 is forgotten
  assert.equal((await from('198.51.100.2')).status, 429); // .2 is still remembered
  assert.equal((await from('198.51.100.3')).status, 429);
  assert.equal((await from('198.51.100.1')).status, 200); // .1 starts over
});

test('a burst limit holds for everyone together', async (t) => {
  const { port } = await site(t, { mock: true, limits: { global: [{ n: 2, ms: 60 * 1000 }] } });
  const from = (ip) => request(port, { body: hi, headers: { 'x-forwarded-for': ip } });
  assert.equal((await from('198.51.100.1')).status, 200);
  assert.equal((await from('198.51.100.2')).status, 200);
  const r = await from('198.51.100.3');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'crowded');
  assert.ok(Number(r.headers['retry-after']) > 0 && Number(r.headers['retry-after']) <= 60);
});

test('one stream at a time per visitor', async (t) => {
  const { port } = await site(t, { mock: true, mockDelay: 40 });
  const first = request(port, { body: hi });
  await new Promise((r) => setTimeout(r, 60));
  const second = await request(port, { body: hi });
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'busy');
  assert.equal((await first).status, 200);
  // free again once the first one ended
  assert.equal((await request(port, { body: hi })).status, 200);
});

test('a timeout ends the stream with an error', async (t) => {
  const { port } = await site(t, { mock: true, mockDelay: 50, limits: { timeoutMs: 120 } });
  const r = await request(port, { body: hi });
  assert.equal(r.events[r.events.length - 1].error, 'timeout');
});

/* ---------- the real SDK against a fake API ---------- */

// A stand-in for the Anthropic API on 127.0.0.1: records what it was sent
// and streams back the events the real API would.
async function fakeApi(t, script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      script(req, res);
    });
  });
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = await listen(server);
  return { url: 'http://127.0.0.1:' + port, seen };
}

function sse(res, list, gap = 0) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_test' });
  let i = 0;
  (function next() {
    if (res.destroyed) return;
    if (i >= list.length) return res.end();
    const [type, data] = list[i++];
    res.write(`event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, data))}\n\n`);
    if (gap) setTimeout(next, gap); else next();
  })();
}

function reply(parts, stop) {
  const list = [
    ['message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }]
  ];
  for (const p of parts) list.push(['content_block_delta', { index: 1, delta: { type: 'text_delta', text: p } }]);
  list.push(['content_block_stop', { index: 1 }]);
  list.push(['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } }]);
  list.push(['message_stop', {}]);
  return list;
}

test('real SDK: request shape, text only, key never leaves', async (t) => {
  const api = await fakeApi(t, (req, res) => sse(res, reply(['hello ', 'there.'], 'end_turn')));
  const { port } = await site(t, { apiKey: 'sk-test-not-a-real-key', baseURL: api.url });
  const r = await request(port, { body: { messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }, { role: 'user', content: 'again' }
  ] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.events, [{ t: 'hello ' }, { t: 'there.' }, { done: true }]);
  assert.doesNotMatch(r.text, /secret reasoning|sk-test/);

  assert.equal(api.seen.length, 1);
  const { url, headers, body } = api.seen[0];
  assert.match(url, /^\/v1\/messages/);
  assert.equal(headers['x-api-key'], 'sk-test-not-a-real-key');
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, undefined); // Haiku 5.5 has no server-side fallback
  assert.doesNotMatch(String(headers['anthropic-beta'] || ''), /server-side-fallback/);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.system, SYSTEM);
  assert.equal(body.max_tokens, LIMITS.maxTokens);
  assert.equal(body.thinking, undefined);
  assert.equal(body.betas, undefined);
  assert.equal(body.messages.length, 3);
  assert.doesNotMatch(SYSTEM, /\d{4}-\d{2}-\d{2}/); // stable prompt, no dates
  assert.ok(SYSTEM.includes('\n- You know nothing about any signal, broadcast, frequency, puzzle or hunt on this site and hold none of its answers; if asked, say so briefly.\n')); // the hunt's one line
});

test('real SDK: an Opus AI_MODEL gets the server-side refusal fallback', async (t) => {
  const api = await fakeApi(t, (req, res) => sse(res, reply(['ok.'], 'end_turn')));
  const { port } = await site(t, { apiKey: 'sk-test-not-a-real-key', baseURL: api.url, model: 'claude-opus-5-5' });
  const r = await request(port, { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  const { headers, body } = api.seen[0];
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.betas, undefined);
});

test('real SDK: a refusal becomes a polite error', async (t) => {
  const api = await fakeApi(t, (req, res) => sse(res, reply(['partial '], 'refusal')));
  const { port } = await site(t, { apiKey: 'sk-test', baseURL: api.url });
  const r = await request(port, { body: hi });
  const last = r.events[r.events.length - 1];
  assert.equal(last.error, 'refused');
  assert.equal(last.discard, true);
  assert.ok(last.message);
});

test('real SDK: upstream errors map to short messages', async (t) => {
  const api = await fakeApi(t, (req, res) => {
    res.writeHead(529, { 'content-type': 'application/json', 'x-should-retry': 'false' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  });
  const { port } = await site(t, { apiKey: 'sk-test', baseURL: api.url });
  const r = await request(port, { body: hi });
  const last = r.events[r.events.length - 1];
  assert.equal(last.error, 'overloaded');
  assert.doesNotMatch(r.text, /Overloaded|overloaded_error/);
});

test('real SDK: an overload after the stream opened is still "crowded"', async (t) => {
  const api = await fakeApi(t, (req, res) => {
    const list = reply(['half a '], 'end_turn').slice(0, 7);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_test' });
    for (const [type, data] of list) res.write(`event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, data))}\n\n`);
    res.end('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) + '\n\n');
  });
  const { port } = await site(t, { apiKey: 'sk-test', baseURL: api.url });
  const r = await request(port, { body: hi });
  assert.deepEqual(r.events[0], { t: 'half a ' });
  assert.equal(r.events[r.events.length - 1].error, 'overloaded');
  assert.doesNotMatch(r.text, /Overloaded|overloaded_error/);
});

test('real SDK: the upstream stream is aborted when the browser leaves', async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const parts = Array.from({ length: 200 }, (_, i) => 'w' + i + ' ');
  const api = await fakeApi(t, (req, res) => {
    res.on('close', () => upstreamClosed(true));
    sse(res, reply(parts, 'end_turn'), 20);
  });
  const { port } = await site(t, { apiKey: 'sk-test', baseURL: api.url });
  await new Promise((resolve, reject) => {
    const payload = JSON.stringify(hi);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ai', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
    req.end(payload);
    setTimeout(() => reject(new Error('no data')), 3000);
  });
  const ok = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 3000))]);
  assert.equal(ok, true, 'upstream connection should close');
  assert.ok(api.seen.length === 1);
});
