import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRh, isRhRequest } from './rhproxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ID = 'a'.repeat(32);

test('isRhRequest: Rammerhead service routes and session paths', () => {
  assert.equal(isRhRequest('GET', '/hammerhead.js'), true);
  assert.equal(isRhRequest('GET', '/newsession'), true);
  assert.equal(isRhRequest('GET', '/newsession?pwd=x'), true);
  assert.equal(isRhRequest('POST', '/syncLocalStorage?sessionId=' + ID), true);
  assert.equal(isRhRequest('OPTIONS', '/messaging'), true);
  assert.equal(isRhRequest('GET', `/${ID}/https://example.com/`), true);
  assert.equal(isRhRequest('POST', `/${ID}/https://example.com/login`), true);
  // flags that hammerhead appends to the id on sub-requests
  assert.equal(isRhRequest('GET', `/${ID}!a!1/https://example.com/api`), true);
  assert.equal(isRhRequest('GET', `/${ID}!i/https://example.com/`), true);
});

test('isRhRequest: the rest of the site is not Rammerhead', () => {
  for (const p of ['/', '/games/', '/proxy/', '/proxy/sw.js', '/semag/2048/index.html', '/api/p', '/api/stats',
    '/jsgh/gn-math/html@main/0.html', '/youtube/', '/stats/', '/css/base.css', '/' + 'a'.repeat(31) + '/x', '/' + 'a'.repeat(33) + '/x']) {
    assert.equal(isRhRequest('GET', p), false, p);
  }
  // wrong method for a service route
  assert.equal(isRhRequest('POST', '/newsession'), false);
  assert.equal(isRhRequest('GET', '/syncLocalStorage'), false);
});

test('isRhRequest: /editsession only to switch URL shuffling off; /deletesession never', () => {
  assert.equal(isRhRequest('GET', `/editsession?id=${ID}&enableShuffling=0`), true);
  assert.equal(isRhRequest('GET', `/editsession?id=${ID}&enableShuffling=0&pwd=k`), true);
  assert.equal(isRhRequest('GET', `/editsession?id=${ID}&enableShuffling=1`), false);
  assert.equal(isRhRequest('GET', `/editsession?id=${ID}&httpProxy=1.2.3.4:80`), false);
  assert.equal(isRhRequest('GET', `/editsession?id=${ID}&enableShuffling=0&httpProxy=1.2.3.4:80`), false);
  assert.equal(isRhRequest('GET', '/editsession?id=short&enableShuffling=0'), false);
  assert.equal(isRhRequest('GET', '/editsession'), false);
  assert.equal(isRhRequest('GET', `/deletesession?id=${ID}`), false);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

test('forwarding hides who the visitor is and tells Rammerhead the public host', async (t) => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
    res.end('hello');
  });
  t.after(() => new Promise((r) => upstream.close(r)));
  const upPort = await listen(upstream);

  const rh = createRh({ port: upPort });
  const front = http.createServer((req, res) => rh.handle(req, res));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);

  const r = await request(port, {
    path: `/${ID}/https://example.com/`,
    headers: {
      host: '631cb8a9.com',
      'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7',
      forwarded: 'for=203.0.113.7', via: '1.1 caddy', 'cf-connecting-ip': '203.0.113.7',
      'user-agent': 'TestAgent', cookie: 'k=v', 'accept-encoding': 'gzip, deflate, br, zstd'
    }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'hello');
  assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);   // duplicates survive
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip']) {
    assert.equal(seen[h], undefined, h + ' must not be forwarded');
  }
  assert.equal(seen['x-rh-host'], '631cb8a9.com');
  assert.equal(seen['x-rh-proto'], 'https');       // believed: the peer is local (Caddy)
  assert.equal(seen['user-agent'], 'TestAgent');
  assert.equal(seen.cookie, 'k=v');
  assert.equal(seen['accept-encoding'], 'gzip, deflate, br');   // hammerhead cannot decode zstd
});

test('sites are never offered an encoding hammerhead cannot decode', async (t) => {
  const got = [];
  const upstream = http.createServer((req, res) => { got.push(req.headers['accept-encoding']); res.end(); });
  t.after(() => new Promise((r) => upstream.close(r)));
  const rh = createRh({ port: await listen(upstream) });
  const front = http.createServer((req, res) => rh.handle(req, res));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);
  for (const ae of ['zstd', 'zstd;q=1.0, br;q=0.9', 'gzip;q=0.5, ZSTD, identity', 'br']) {
    await request(port, { path: `/${ID}/https://example.com/`, headers: { 'accept-encoding': ae } });
  }
  assert.deepEqual(got, ['identity', 'br;q=0.9', 'gzip;q=0.5, identity', 'br']);
});

test('POST bodies and WebSocket upgrades pass through', async (t) => {
  let upHeaders = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { res.writeHead(200); res.end('got:' + Buffer.concat(chunks).toString()); });
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => { upHeaders = req.headers; ws.on('message', (m) => ws.send('echo:' + m)); });
  t.after(() => new Promise((r) => upstream.close(r)));
  const upPort = await listen(upstream);

  const rh = createRh({ port: upPort });
  const front = http.createServer((req, res) => rh.handle(req, res));
  front.on('upgrade', (req, socket, head) => rh.upgrade(req, socket, head));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);

  const post = await request(port, { method: 'POST', path: `/${ID}/https://example.com/form`, body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(post.body, 'got:a=1&b=2');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/${ID}/wss://example.com/socket`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  const reply = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => resolve(String(m)));
    ws.on('error', reject);
  });
  ws.close();
  assert.equal(reply, 'echo:ping');
  assert.equal(upHeaders['x-forwarded-for'], undefined);
});

test('an unreachable engine answers 502 and does not crash the site', async (t) => {
  const dead = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => dead.once('listening', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));

  const rh = createRh({ port: deadPort });
  const front = http.createServer((req, res) => rh.handle(req, res));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);
  const r = await request(port, { path: '/newsession' });
  assert.equal(r.status, 502);
});

test('one visitor cannot create unlimited sessions', async (t) => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end(ID); });
  t.after(() => new Promise((r) => upstream.close(r)));
  const upPort = await listen(upstream);
  const rh = createRh({ port: upPort });
  const front = http.createServer((req, res) => rh.handle(req, res));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);

  const codes = [];
  for (let i = 0; i < 33; i++) codes.push((await request(port, { path: '/newsession', headers: { 'x-forwarded-for': '198.51.100.9' } })).status);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes.filter((c) => c === 429).length, 3);
  // somebody else is not affected
  assert.equal((await request(port, { path: '/newsession', headers: { 'x-forwarded-for': '198.51.100.10' } })).status, 200);
});

test('the real Rammerhead process: proxies a page, strips headers, writes no log', async (t) => {
  let seen = null;
  const site = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    res.end('<!doctype html><html><head><title>t</title></head><body><h1>hello from the target</h1><a href="/next">next</a>' +
      '<img srcset="/cdn-cgi/image/q=78,width=94/a.png 1x, /cdn-cgi/image/q=78,width=188/a.png 2x"></body></html>');
  });
  t.after(() => new Promise((r) => site.close(r)));
  const sitePort = await listen(site);

  const rhPort = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(here, 'rammerhead.cjs')], { env: { ...process.env, RH_PORT: String(rhPort) } });
  let output = 0;
  child.stdout.on('data', (c) => { output += c.length; });
  child.stderr.on('data', (c) => { output += c.length; });
  t.after(() => child.kill());
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => { const s = net.connect(rhPort, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const rh = createRh({ port: rhPort });
  const front = http.createServer((req, res) => rh.handle(req, res));
  t.after(() => new Promise((r) => front.close(r)));
  const port = await listen(front);

  const id = (await request(port, { path: '/newsession' })).body.trim();
  assert.match(id, /^[a-z0-9]{32}$/i);
  assert.equal((await request(port, { path: `/editsession?id=${id}&enableShuffling=0` })).body, 'Success');
  assert.equal((await request(port, { path: `/sessionexists?id=${id}` })).body, 'exists');

  const page = await request(port, {
    path: `/${id}/http://127.0.0.1:${sitePort}/`,
    // accept + sec-fetch-dest: what a browser sends when it navigates (Rammerhead only rewrites then)
    headers: { host: '631cb8a9.com', accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7', via: '1.1 caddy', 'x-forwarded-proto': 'https' }
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /hello from the target/);
  for (const h of ['x-forwarded-for', 'x-real-ip', 'via', 'x-forwarded-proto', 'x-rh-host', 'x-rh-proto']) {
    assert.equal(seen[h], undefined, `the target site must not see ${h}`);
  }
  assert.doesNotMatch(String(seen['accept-encoding']), /zstd/, 'the target must not be offered zstd');
  // our UI shows the page in an iframe, so a site's DENY must not reach the browser
  assert.equal(page.headers['x-frame-options'], undefined);
  // the rewritten page points back at the PUBLIC address, not at the loopback port
  assert.match(page.body, /631cb8a9\.com/);
  // the client is patched so a page inside our proxy UI's iframe reads its own
  // location.pathname, not /<session>/https://... (see rammerhead.cjs)
  const hh = await request(port, { path: '/hammerhead.js' });
  assert.equal(hh.status, 200);
  assert.match(hh.body, /\.frameElement;return f&&!\w+\.parent\["%hammerhead%"\]\?null:f/);
  // ...and patched so hammerhead starts in Safari 26+, where style properties live on
  // CSSStyleProperties.prototype (see rammerhead.cjs). Run the served feature check
  // against each browser's layout: only WebKit's changes, Chrome and Firefox are as before.
  assert.doesNotMatch(hh.body, /this\.window\.CSS2Properties\.prototype/);
  assert.equal(hh.body.split('(this.window.CSS2Properties||this.window.CSSStyleProperties).prototype').length, 3);
  const check = /css2PropertiesProtoContainsAllProps=(!!\(window\.CSS2Properties\|\|.*?"background"\)\))/.exec(hh.body);
  assert.ok(check, 'the CSSStyleProperties feature check is in the served client');
  const protoHasAll = (window) => vm.runInNewContext(check[1], { window });
  const F = function () {};
  assert.equal(protoHasAll({ CSSStyleProperties: F, CSSStyleDeclaration: { prototype: {} } }), true, 'Safari 26+ (WebKit 27)');
  assert.equal(protoHasAll({ CSSStyleProperties: F, CSSStyleDeclaration: { prototype: { background: '' } } }), false, 'Chrome');
  assert.equal(protoHasAll({ CSSStyleDeclaration: { prototype: { background: '' } } }), false, 'Chrome without CSSStyleProperties');
  assert.equal(protoHasAll({ CSS2Properties: F, CSSStyleDeclaration: { prototype: {} } }), true, 'Firefox');
  assert.equal(protoHasAll({ CSSStyleDeclaration: { prototype: {} } }), false, 'old Safari (properties on each element)');
  // srcset URLs with commas in them (image resizers, data: URLs) stay whole, on the
  // server's rewrite and in the served client (see srcsetFn in rammerhead.cjs)
  assert.match(page.body, /srcset="[^"]*\/http:\/\/127\.0\.0\.1:\d+\/cdn-cgi\/image\/q=78,width=94\/a\.png 1x, [^"]*\/cdn-cgi\/image\/q=78,width=188\/a\.png 2x"/);
  assert.doesNotMatch(hh.body, /\.split\(","\);[^}]*\.replace\(\/ \+\/g," "\)/, 'the comma-splitting srcset handler is gone');
  const fixed = /function \w+\(\w+,\w+\)\{var _r=Array\.prototype\.slice\.call\(arguments,2\)[\s\S]*?return _o\.join\(", "\)\}/.exec(hh.body);
  assert.ok(fixed, 'the spec srcset handler is in the served client');
  const urlsSet = vm.runInNewContext(`(${fixed[0]})`);
  const P = (u, tag) => `P(${u}${tag ? ':' + tag : ''})`;
  assert.equal(urlsSet(P, 'https://i.example/cdn-cgi/image/q=78,w=94/a.png 1x, https://i.example/x,y.png 2x', 'img'),
    'P(https://i.example/cdn-cgi/image/q=78,w=94/a.png:img) 1x, P(https://i.example/x,y.png:img) 2x');
  assert.equal(urlsSet(P, 'a.png 1x,b.png 2x'), 'P(a.png) 1x, P(b.png) 2x');
  assert.equal(urlsSet(P, 'a.png, data:image/png;base64,AA== 640w'), 'P(a.png), P(data:image/png;base64,AA==) 640w');
  // ...and srcsets set from script reach hammerhead: React's setAttribute('srcSet'),
  // lazy loaders' img.srcset = ..., and <link imagesrcset> (see SRCSET_HOOKS)
  assert.match(hh.body, /rammerheadStartListeners/);
  assert.match(hh.body, /n==="imagesrcset"&&this\.tagName==="LINK"/);
  assert.match(hh.body, /\[window\.HTMLImageElement,"srcset"\]/);
  // Rammerhead's own 'disabled' log level logs everything; make sure it stays silent
  assert.equal(output, 0, 'rammerhead must write nothing to stdout/stderr');
});
