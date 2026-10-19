import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseJsgh, rewriteJsdelivr, upstreams, createJsgh } from './jsgh.mjs';

test('parseJsgh accepts user/repo@version/path', () => {
  const p = parseJsgh('/jsgh/bubbls/youtube-playables@main/bowmasters/game.js');
  assert.deepEqual(p, {
    user: 'bubbls',
    repo: 'youtube-playables',
    version: 'main',
    file: ['bowmasters', 'game.js'],
    key: 'bubbls/youtube-playables@main/bowmasters/game.js'
  });
});

test('parseJsgh accepts a path without a version', () => {
  const p = parseJsgh('/jsgh/bubblfan/ice-dodo/index.js');
  assert.equal(p.version, '');
  assert.equal(p.repo, 'ice-dodo');
  assert.deepEqual(p.file, ['index.js']);
});

test('parseJsgh rejects traversal and odd names', () => {
  assert.equal(parseJsgh('/jsgh/../secrets'), null);
  assert.equal(parseJsgh('/jsgh/user/repo@main/../x.js'), null);
  assert.equal(parseJsgh('/semag/nope'), null);
  assert.equal(parseJsgh('/jsgh/gn-math/html@main/'), null);
  assert.equal(parseJsgh('/jsgh/bad user/repo@main/a.js'), null);
});

test('upstreams skip jsDelivr for gn-math and try GitHub raw', () => {
  const u = upstreams({ user: 'gn-math', repo: 'html', version: 'main', file: ['0-fix2.html'] });
  assert.equal(u.length, 1);
  assert.equal(u[0], 'https://raw.githubusercontent.com/gn-math/html/main/0-fix2.html');
});

test('upstreams try jsDelivr first for other users', () => {
  const u = upstreams({ user: 'bubbls', repo: 'youtube-playables', version: 'main', file: ['bowmasters', 'game.js'] });
  assert.equal(u[0], 'https://cdn.jsdelivr.net/gh/bubbls/youtube-playables@main/bowmasters/game.js');
  assert.ok(u[1].startsWith('https://raw.githubusercontent.com/'));
});

test('rewriteJsdelivr points gh URLs at /jsgh/ and Ruffle at /vendor/', () => {
  const html = [
    '<base href="https://cdn.jsdelivr.net/gh/bubbls/youtube-playables@main/bowmasters/">',
    '<script src="https://cdn.jsdelivr.net/gh/gn-math/assets@main/angry-birds-cffa09e/birds.js"></script>',
    '<script src="//fastly.jsdelivr.net/gh/x/y@1/z.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/ruffle.min.js"></script>'
  ].join('\n');
  const out = rewriteJsdelivr(html, 'https://631cb8a9.com');
  assert.match(out, /https:\/\/631cb8a9\.com\/jsgh\/bubbls\/youtube-playables@main\/bowmasters\//);
  assert.match(out, /https:\/\/631cb8a9\.com\/jsgh\/gn-math\/assets@main\/angry-birds-cffa09e\/birds\.js/);
  assert.match(out, /https:\/\/631cb8a9\.com\/jsgh\/x\/y@1\/z\.js/);
  assert.match(out, /src="\/vendor\/ruffle\/ruffle\.js"/);
  assert.doesNotMatch(out, /jsdelivr/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks)
      }));
    }).on('error', reject);
  });
}

test('relay serves a gn-math JS file as javascript, not text/plain', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jsgh = createJsgh({ cacheDir: dir, maxBytes: 10 * 1024 * 1024, headersFor: () => ({}) });
  const server = http.createServer((req, res) => jsgh.handle(req, res));
  t.after(() => new Promise((r) => server.close(r)));
  const port = await listen(server);

  const r = await get(port, '/jsgh/gn-math/assets@main/angry-birds-cffa09e/birds.js');
  assert.equal(r.status, 200);
  assert.match(r.type, /javascript/);
  assert.doesNotMatch(r.type, /text\/plain/);
  assert.ok(r.body.length > 100);

  const html = await get(port, '/jsgh/gn-math/html@main/0-fix2.html');
  assert.equal(html.status, 200);
  assert.match(html.type, /html/);
  assert.match(html.body.toString('utf8'), /bowmasters|jsdelivr|base/i);

  const css = await get(port, '/jsgh/bubbls/youtube-playables@main/bowmasters/style/index.css');
  assert.equal(css.status, 200);
  assert.match(css.type, /css/);

  const miss = await get(port, '/jsgh/gn-math/html@main/this-file-does-not-exist-xyz.html');
  assert.equal(miss.status, 404);
});
