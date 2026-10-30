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
  // Our UI shows the page in an <iframe>, so DENY (Discord, for one) would leave it
  // blank. null removes it, as Rammerhead documents (its rewrite is called without
  // the original value for most responses, so it cannot become SAMEORIGIN). CSP,
  // and with it frame-ancestors, hammerhead removes itself.
  rewriteServerHeaders: { 'x-frame-options': null },
  fileCacheSessionConfig: {},
  logLevel: 'disabled',
  generatePrefix: () => '',
  getIP: () => '0.0.0.0'
};
require.cache[cfgFile] = { id: cfgFile, filename: cfgFile, loaded: true, children: [], paths: [], exports: config };

// srcset, read the way the HTML spec reads it. hammerhead splits a srcset on every
// comma, which cuts URLs that contain one: image-resizer URLs (Poki's game pictures are
// img.poki-cdn.com/cdn-cgi/image/q=78,width=94,.../x.png) and data: URLs. The pieces are
// proxied one by one and glued back into an address no server knows, so every picture
// on such sites breaks in safari mode (Chrome's engine, Scramjet, gets this right). The
// spec: a URL runs to the next whitespace, and a comma right after it, or after its
// descriptors, ends that candidate. Written as ES5 because it also replaces the function
// in the client script browsers get; the server's copy is swapped below, before
// Rammerhead loads (processing/resources calls it through the module's exports).
function srcsetFn(name, h, u) {
  return `function ${name}(${h},${u}){var _r=Array.prototype.slice.call(arguments,2),_o=[],_s=String(${u}),_i=0,_n=_s.length,_j,_k,_w,_d;` +
    'while(_i<_n){while(_i<_n&&/[\\s,]/.test(_s.charAt(_i)))_i++;if(_i>=_n)break;_j=_i;while(_j<_n&&!/\\s/.test(_s.charAt(_j)))_j++;' +
    '_w=_s.slice(_i,_j);_d="";if(/,$/.test(_w)){_w=_w.replace(/,+$/,"");_i=_j}' +
    'else{_k=_j;while(_k<_n&&_s.charAt(_k)!==",")_k++;_d=_s.slice(_j,_k).trim();_i=_k+1}' +
    `if(_w)_o.push(${h}.apply(void 0,[_w].concat(_r))+(_d?" "+_d:""))}return _o.join(", ")}`;
}
const hhUrl = require(require.resolve('testcafe-hammerhead/lib/utils/url.js', { paths: [RH] }));
hhUrl.handleUrlsSet = new Function(`return ${srcsetFn('handleUrlsSet', 'handler', 'url')}`)(); // eslint-disable-line no-new-func

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

// The proxy page shows Rammerhead inside an <iframe>. hammerhead finds that iframe
// through window.frameElement, and once a site calls document.open() (sites that
// build their page with document.write do, nova-hub.dev for one) it treats the page
// as an "iframe without src" and gives the site the REAL location.pathname and host
// (/<session>/https://...). A site that checks its own path then redirects forever.
// Rammerhead's own fix for being iframed misses this one function, so the client
// script is patched here, in memory: when the parent window is not a proxied page
// (it is our UI), hammerhead sees no frame element. Nested proxied frames are as before.
const FRAME_ELEMENT = /function ([\w$]+)\s*\((\w+)\)\s*\{\s*try\s*\{\s*return \2\.frameElement;?\s*\}\s*catch\s*\(\w+\)\s*\{\s*return null;?\s*\}\s*\}/;
// Safari 26 and later (WebKit 27) keep CSS style properties (style.background and the
// rest) on CSSStyleProperties.prototype. hammerhead's start-up check only knows Firefox's
// CSS2Properties, Chrome's CSSStyleDeclaration.prototype and old Safari's per-element
// properties, so it reads a property descriptor that does not exist and throws. hammerhead
// then never starts and every rewritten script fails (`__get$ is not a function`): pages
// show their HTML and images but nothing their scripts draw. So CSSStyleProperties is
// treated like CSS2Properties, only where Chrome's check fails (Chrome and Firefox as before).
const CSS2_FEATURE = /(\w+)\.css2PropertiesProtoContainsAllProps=!!window\.CSS2Properties/;
const CSS2_PROTO = 'this.window.CSS2Properties.prototype';
const client = proxy.routes.get('GET /hammerhead.js');
const original = String(client.handler.content);
let clientSrc = original;
if (FRAME_ELEMENT.test(clientSrc)) {
  clientSrc = clientSrc.replace(FRAME_ELEMENT, (m, fn, w) =>
    `function ${fn}(${w}){try{var f=${w}.frameElement;return f&&!${w}.parent["%hammerhead%"]?null:f}catch(e){return null}}`);
}
if (CSS2_FEATURE.test(clientSrc) && clientSrc.split(CSS2_PROTO).length === 3) {
  clientSrc = clientSrc
    .replace(CSS2_FEATURE, '$1.css2PropertiesProtoContainsAllProps=!!(window.CSS2Properties||window.CSSStyleProperties&&!Object.prototype.hasOwnProperty.call(window.CSSStyleDeclaration.prototype,"background"))')
    .split(CSS2_PROTO).join('(this.window.CSS2Properties||this.window.CSSStyleProperties).prototype');
}
// the client's srcset splitter (see srcsetFn above); minified, so found by its shape
const SRCSET_SPLIT = /function (\w+)\((\w+),(\w+)\)\{for\(var (\w+)=\[\],(\w+)=2;\5<arguments\.length;\5\+\+\)\4\[\5-2\]=arguments\[\5\];for\(var \w+=\[\],\w+=0,\w+=\3\.split\(","\);[\s\S]*?return \w+\.join\(","\)\}/g;
if ((clientSrc.match(SRCSET_SPLIT) || []).length === 1) {
  clientSrc = clientSrc.replace(SRCSET_SPLIT, (m, fn, h, u) => srcsetFn(fn, h, u));
}
// Three more ways srcsets escape hammerhead, all common on React / Next.js sites (movy.sx
// for one). React writes setAttribute('srcSet', ...): hammerhead proxies it but tests
// `attr === 'srcset'`, so the whole list becomes ONE address. Lazy loaders write
// img.srcset = ...: hammerhead wraps the src property but not srcset, so the relative URLs
// resolve against our origin and 404. And <link rel=preload imagesrcset> is not a URL
// attribute to it at all. After hammerhead starts (Rammerhead's start hook), srcset names
// are lowercased on the way in, imagesrcset is proxied as a list, and the srcset /
// imageSrcset properties go through setAttribute like everything else.
const SRCSET_HOOKS = `
;(window.rammerheadStartListeners=window.rammerheadStartListeners||[]).push(function(){
var hh=window["%hammerhead%"],url=hh&&hh.utils&&hh.utils.url,E=window.Element&&window.Element.prototype;
if(!E||!url||!url.getProxyUrl)return;
var set=E.setAttribute,get=E.getAttribute;
E.setAttribute=function(name,value){var n=String(name).toLowerCase();
if(n==="srcset")return set.call(this,"srcset",value);
if(n==="imagesrcset"&&this.tagName==="LINK")return set.call(this,"imagesrcset",url.getProxyUrl(String(value),{isUrlsSet:true}));
return set.apply(this,arguments)};
[[window.HTMLImageElement,"srcset"],[window.HTMLSourceElement,"srcset"],[window.HTMLLinkElement,"imageSrcset"]].forEach(function(p){
var C=p[0],d=C&&Object.getOwnPropertyDescriptor(C.prototype,p[1]),attr=p[1].toLowerCase();
if(!d||!d.configurable)return;
Object.defineProperty(C.prototype,p[1],{configurable:true,enumerable:d.enumerable,
get:function(){var v=get.call(this,attr);return v===null?"":v},
set:function(v){E.setAttribute.call(this,attr,String(v))}})})});
`;
if (!clientSrc.includes('rammerheadStartListeners')) clientSrc += SRCSET_HOOKS;
if (clientSrc !== original) {
  client.handler.content = Buffer.from(clientSrc);
  client.handler.etag = require('node:crypto').createHash('md5').update(client.handler.content).digest('hex');
}

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
