// headers.mjs: reads site/_headers (Netlify / Cloudflare Pages format) so the
// same file drives GitHub Pages docs, other static hosts and this server.
//
// Supported: exact paths ("/games/") and a trailing splat ("/js/*").
// Each matching block's headers are applied in file order; a later block
// replaces a header of the same name, it does not append to it.
import fs from 'node:fs';

export function loadHeaders(file) {
  const rules = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { path: raw.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    const i = raw.indexOf(':');
    if (cur && i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
  }
  return rules;
}

function matches(pattern, path) {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) {
    if (!matches(r.path, path)) continue;
    for (const [k, v] of r.headers) out[k.toLowerCase()] = v;
  }
  return out;
}
