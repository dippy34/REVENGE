// server.mjs: one origin for the whole site (631cb8a9.com). The routes, and the
// env they read, are in app.mjs; this file only listens.
//
// Env: PORT (8080)  HOST (127.0.0.1), plus everything listed in app.mjs.
import http from 'node:http';
import { createApp } from './app.mjs';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

let app;
try {
  app = createApp({ env: process.env, host: HOST });
} catch (e) {
  console.log(e && e.message ? e.message : 'hunt: could not start');
  process.exit(1);
}
// save the counts before systemd or Docker stops us
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.flush(); process.exit(0); });

const server = http.createServer(app.handle);
server.on('upgrade', app.upgrade);

server.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT} (${app.summary()})`);
});
