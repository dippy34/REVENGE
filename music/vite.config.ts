import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the music section into site/music/. The page shares the site's
 * stylesheets and effect scripts (base, fx, eggs, the visit counter), which
 * are added as plain tags so Vite leaves them alone.
 *
 * Development: `npm run dev` serves the app on :5173 and forwards /api to the
 * site server (REVENGE_SERVER, default http://127.0.0.1:8193). Start that with
 * `PORT=8193 node server/server.mjs` from the repository root.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const SITE = resolve(here, '..', 'site');
const SERVER = process.env.REVENGE_SERVER || 'http://127.0.0.1:8193';

/** Same policy as the YouTube page, plus audio from this origin (the music server). */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https://i.ytimg.com",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "frame-src 'self' https://www.youtube-nocookie.com",
  "child-src 'self' https://www.youtube-nocookie.com",
  "form-action 'self'",
  "base-uri 'none'",
].join('; ');

const SHARED: HtmlTagDescriptor[] = [
  { tag: 'link', attrs: { rel: 'stylesheet', href: '../css/base.css' }, injectTo: 'head-prepend' },
  { tag: 'link', attrs: { rel: 'stylesheet', href: '../css/fx.css' }, injectTo: 'head-prepend' },
  { tag: 'link', attrs: { rel: 'stylesheet', href: '../css/eggs.css' }, injectTo: 'head-prepend' },
  { tag: 'script', attrs: { src: '../js/early.js' }, injectTo: 'head-prepend' },
  { tag: 'script', attrs: { src: '../js/fx.js', defer: true }, injectTo: 'head' },
  { tag: 'script', attrs: { src: '../js/hit.js', defer: true }, injectTo: 'head' },
  { tag: 'script', attrs: { src: '../js/eggs.js', defer: true }, injectTo: 'head' },
  { tag: 'script', attrs: { src: '../js/hunt.js', defer: true }, injectTo: 'head' },
];

function sitePage(): Plugin {
  return {
    name: 'music-site-page',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const tags = [...SHARED];
        // The CSP goes in only for the build: Vite's dev client needs inline code.
        if (!ctx.server) tags.unshift({ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' });
        return tags;
      },
    },
    configureServer(server) {
      // The shared site files, read straight from site/ during development.
      const TYPES: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (!/^\/(css|js|assets)\//.test(path)) return next();
        const file = resolve(SITE, `.${decodeURIComponent(path)}`);
        if (!file.startsWith(SITE + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: '/music/',
  plugins: [sitePage()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    outDir: '../site/music',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 250,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: SERVER, changeOrigin: false } },
  },
});
