'use strict';
// rammerhead.cjs: runs Rammerhead (testcafe-hammerhead) for the Safari / iPad
// engine of the proxy page. It rewrites pages on the SERVER, so the browser
// needs none of the service-worker features Scramjet depends on.
//
// It is a separate process (own memory limit, own restarts) that listens
// only on a unix socket (RH_SOCKET) or, for local tests, a loopback TCP port
// (RH_PORT). server.mjs forwards the right paths to it (rhproxy.mjs) and is
// the only thing that can reach it.
//
// Settings that matter here:
//   - the package's own config.js is replaced before it loads, so Rammerhead
//     never writes inside node_modules and never uses its default password
//   - sessions live in memory only (30 min idle, 4 h max): cookies and
//     localStorage of the sites people visit are never written to disk
//   - logging is off, and really off: in this Rammerhead version logLevel
//     'disabled' logs EVERYTHING (the check is `0 <= level`, true for all), so the
//     logger's output function is replaced. The visitor IP is never known here.
//   - headers that could reveal the visitor to the sites they open are stripped
//   - it has no network filter of its own: systemd (setup-native.sh) denies it
//     loopback, private, link-local and this server's own addresses
//
// Env: RH_SOCKET | RH_PORT, ACCESS_KEY (optional; required for /newsession)
const path = require('node:path');
const fs = require('node:fs');

const RH = path.join(__dirname, 'node_modules', 'rammerhead', 'src');
const SOCKET = process.env.RH_SOCKET || '';
const PORT = Number(process.env.RH_PORT || 8082);
const KEY = process.env.ACCESS_KEY || '';

// Headers added on the way in (Caddy, server.mjs) that must not reach the sites.
const STRIP = [
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip',
  'forwarded', 'via', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop',
  'true-client-ip', 'x-rh-host', 'x-rh-proto'
];

process.umask(0o007);           // the socket is readable by our own user and group only
if (SOCKET) { try { fs.unlinkSync(SOCKET); } catch (e) { /* no stale socket */ } }

// Pre-seed the module cache so src/config.js (which builds a disk cache and a
// default password at load time) is never executed.
const cfgFile = require.resolve(path.join(RH, 'config.js'));
const RammerheadJSMemCache = require(path.join(RH, 'classes', 'RammerheadJSMemCache.js'));
const config = {
  bindingAddress: SOCKET ? null : '127.0.0.1',
  port: SOCKET || PORT,
  crossDomainPort: null,          // one port only; see docs/06-backend.md
  publicDir: null,
  enableWorkers: false,
  workers: 1,
  ssl: null,
  getServerInfo: (req) => {
    const host = String(req.headers['x-rh-host'] || req.headers.host || 'localhost');
    const https = req.headers['x-rh-proto'] === 'https';
    const u = new URL((https ? 'https://' : 'http://') + host);
    return { hostname: u.hostname, port: u.port ? Number(u.port) : (https ? 443 : 80), protocol: https ? 'https:' : 'http:' };
  },
  password: KEY || null,
  disableLocalStorageSync: false,
  restrictSessionToIP: false,
  jsCache: new RammerheadJSMemCache(50 * 1024 * 1024),
  disableHttp2: false,
  stripClientHeaders: STRIP,
  rewriteServerHeaders: {},
  fileCacheSessionConfig: {},
  logLevel: 'disabled',
  generatePrefix: () => '',
  getIP: () => '0.0.0.0'
};
require.cache[cfgFile] = { id: cfgFile, filename: cfgFile, loaded: true, children: [], paths: [], exports: config };

const exitHook = require('async-exit-hook');
// see the note at the top: 'disabled' does not disable anything in this version
require(path.join(RH, 'classes', 'RammerheadLogging.js')).prototype.callLogger = function () {};
const { RammerheadProxy, RammerheadLogging, RammerheadSessionMemoryStore } = require(path.join(RH, 'index.js'));
const setupRoutes = require(path.join(RH, 'server', 'setupRoutes.js'));
const setupPipeline = require(path.join(RH, 'server', 'setupPipeline.js'));

const logger = new RammerheadLogging({ logLevel: 'disabled' });
const proxy = new RammerheadProxy({
  logger,
  loggerGetIP: config.getIP,
  bindingAddress: config.bindingAddress,
  port: config.port,
  crossDomainPort: null,
  dontListen: false,
  ssl: null,
  getServerInfo: config.getServerInfo,
  disableLocalStorageSync: false,
  jsCache: config.jsCache,
  disableHttp2: false
});

const store = new RammerheadSessionMemoryStore({ logger, staleTimeout: 30 * 60 * 1000, maxToLive: 4 * 60 * 60 * 1000 });
store.attachToProxy(proxy);
setupPipeline(proxy, store);
setupRoutes(proxy, store, logger);

// Used by tests and by rhproxy.mjs: the exact list of service routes.
if (process.env.RH_DUMP_ROUTES) {
  const routes = [...proxy.routes.keys()].concat(proxy.routesWithParams.map((r) => String(r.re)));
  console.log(JSON.stringify(routes));
  process.exit(0);
}

exitHook(() => { try { proxy.close(); } catch (e) { /* closing anyway */ } });
