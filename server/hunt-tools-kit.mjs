// hunt-tools-kit.mjs: helpers shared by the tool tests (a throwaway repo root and a tool runner).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS = path.join(here, '..', 'tools');

export function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-tools-'));
  for (const d of ['server', 'hunt', 'site/js']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/js/hunt.js'), "(function(){\n  var PUB = '';\n})();\n");
  return root;
}
export function run(tool, args, root, env) {
  const clean = Object.assign({}, process.env);
  for (const k of Object.keys(clean)) if (k.startsWith('HUNT_')) delete clean[k];
  const r = spawnSync(process.execPath, [path.join(TOOLS, tool), ...args, '--root', root], { env: Object.assign(clean, env || {}), encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
