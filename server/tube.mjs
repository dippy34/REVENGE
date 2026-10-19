// tube.mjs: YouTube search, channel tabs and video details for the site.
//
// The browser talks only to this origin (/api/tube-search, /api/tube-video).
// This process calls YouTube's own InnerTube web API (the same one youtube.com
// uses). Visitors never contact nova-hub or any other third-party search host.
// Searches are not stored; the process has no access log.
//
// The InnerTube key below is the public WEB client key shipped in youtube.com,
// not a secret. YouTube may change the client version or the renderer shapes.
import https from 'node:https';

const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const VERSION = '2.20251016.01.00';
const HOST = 'www.youtube.com';
const TIMEOUT = 12000;
const MAX_QUERY = 100;
const MAX_IDS = 8;
const ID = /^[A-Za-z0-9_-]{11}$/;
const CH = /^UC[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_%=.+\/-]{1,4096}$/;
const FILTERS = { videos: 'EgIQAQ==', shorts: 'EgIYAQ==', all: '' };
const CHANNEL_TABS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA=='
};

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function context() {
  return { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: VERSION } };
}

function innertube(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, port: 443, method: 'POST', agent, timeout: TIMEOUT,
      path: `/youtubei/v1/${path}?prettyPrint=false&key=${KEY}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'x-youtube-client-name': '1',
        'x-youtube-client-version': VERSION
      }
    }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > 8 * 1024 * 1024) { res.destroy(new Error('upstream too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('youtube answered ' + res.statusCode));
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('youtube sent invalid json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('youtube timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v.simpleText === 'string') return text(v.simpleText);
  if (typeof v.content === 'string') return text(v.content);
  if (Array.isArray(v.runs)) return text(v.runs.map((r) => r && r.text).filter(Boolean).join(''));
  if (v.accessibility && v.accessibility.accessibilityData) {
    return text(v.accessibility.accessibilityData.label);
  }
  return '';
}

function find(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  const kids = Array.isArray(node) ? node : Object.values(node);
  for (const k of kids) {
    const hit = find(k, key);
    if (hit != null) return hit;
  }
  return null;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const kids = Array.isArray(node) ? node : Object.values(node);
  for (const k of kids) walk(k, visit);
}

function channelIdOf(node) {
  let id = '';
  walk(node, (n) => {
    if (id) return;
    const b = n.browseEndpoint && n.browseEndpoint.browseId;
    if (typeof b === 'string' && CH.test(b)) id = b;
  });
  return id;
}

function handleOf(node) {
  let h = '';
  walk(node, (n) => {
    if (h) return;
    const u = (n.browseEndpoint && n.browseEndpoint.canonicalBaseUrl)
      || (n.commandMetadata && n.commandMetadata.webCommandMetadata && n.commandMetadata.webCommandMetadata.url)
      || '';
    if (typeof u === 'string' && /^\/@[\w.-]{1,60}$/.test(u)) h = u;
  });
  return h;
}

function thumb(id, thumbs) {
  const list = Array.isArray(thumbs) ? thumbs : [];
  let best = '';
  for (const t of list) {
    const u = String((t && t.url) || '').split('?')[0];
    if (u.indexOf('https://i.ytimg.com/vi/' + id + '/') === 0) best = u;
  }
  return best;
}

function videoOf(r, forceShort) {
  if (!r || typeof r !== 'object') return null;
  const id = typeof r.videoId === 'string' ? r.videoId : '';
  if (!ID.test(id)) return null;
  const owner = r.ownerText || r.longBylineText || r.shortBylineText || {};
  const short = forceShort === true
    || !!(r.navigationEndpoint && r.navigationEndpoint.reelWatchEndpoint)
    || !!(r.thumbnailOverlays && JSON.stringify(r.thumbnailOverlays).indexOf('SHORTS') !== -1);
  return {
    type: 'video',
    id,
    title: text(r.title).slice(0, 200),
    channel: text(owner).slice(0, 100),
    channelId: channelIdOf(owner),
    thumbnail: thumb(id, r.thumbnail && r.thumbnail.thumbnails),
    duration: text(r.lengthText).slice(0, 12),
    views: text(r.viewCountText || r.shortViewCountText).slice(0, 40),
    published: text(r.publishedTimeText).slice(0, 40),
    isShort: short
  };
}

function lockupOf(m, forceShort) {
  if (!m || typeof m !== 'object') return null;
  const id = typeof m.contentId === 'string' ? m.contentId : '';
  if (!ID.test(id)) return null;
  if (m.contentType && m.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const meta = (m.metadata && m.metadata.lockupMetadataViewModel) || {};
  const img = (((m.contentImage || {}).thumbnailViewModel || {}).image || {}).sources;
  let duration = '';
  walk(m.contentImage, (n) => {
    if (duration) return;
    const t = text(n.thumbnailBadgeViewModel && n.thumbnailBadgeViewModel.text);
    if (/^\d{1,3}(:\d{2}){1,2}$/.test(t)) duration = t;
  });
  const parts = [];
  walk((meta.metadata || {}).contentMetadataViewModel, (n) => {
    if (n && n.text && n.text.content) parts.push(text(n.text.content));
  });
  const views = parts.find((p) => /views?/i.test(p)) || '';
  const published = parts.find((p) => /\bago\b|streamed|premiere/i.test(p)) || '';
  const channel = parts.find((p) => p && p !== views && p !== published) || '';
  const short = forceShort === true || !!(find(m, 'reelWatchEndpoint'));
  return {
    type: 'video',
    id,
    title: text(meta.title || (m.rendererContext && m.rendererContext.accessibilityContext && m.rendererContext.accessibilityContext.label)).slice(0, 200),
    channel: channel.slice(0, 100),
    channelId: '',
    thumbnail: thumb(id, img),
    duration: duration.slice(0, 12),
    views: views.slice(0, 40),
    published: published.slice(0, 40),
    isShort: short
  };
}

function shortOf(m) {
  if (!m || typeof m !== 'object') return null;
  const ep = (((m.onTap || {}).innertubeCommand || {}).reelWatchEndpoint)
    || ((m.onTap || {}).reelWatchEndpoint)
    || {};
  const id = typeof ep.videoId === 'string' ? ep.videoId : '';
  if (!ID.test(id)) return null;
  const label = text(m.accessibilityText);
  const title = label.replace(/\s+\d[\d.,]*\s*(thousand|million|billion|views).*$/i, '').replace(/\s+-\s+play short$/i, '').trim();
  return {
    type: 'video',
    id,
    title: (title || label).slice(0, 200),
    channel: '',
    channelId: '',
    thumbnail: thumb(id, ep.thumbnail && ep.thumbnail.thumbnails),
    duration: '',
    views: '',
    published: '',
    isShort: true
  };
}

function collect(root, forceShort) {
  const videos = [];
  const seen = new Set();
  let continuation = '';
  walk(root, (n) => {
    let v = null;
    if (n.videoRenderer) v = videoOf(n.videoRenderer, forceShort);
    else if (n.gridVideoRenderer) v = videoOf(n.gridVideoRenderer, forceShort);
    else if (n.compactVideoRenderer) v = videoOf(n.compactVideoRenderer, forceShort);
    else if (n.reelItemRenderer) v = videoOf(n.reelItemRenderer, true);
    else if (n.shortsLockupViewModel) v = shortOf(n.shortsLockupViewModel);
    else if (n.lockupViewModel) v = lockupOf(n.lockupViewModel, forceShort);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      videos.push(v);
    }
    const tok = n.continuationCommand && n.continuationCommand.token;
    if (!continuation && typeof tok === 'string' && TOKEN.test(tok)) continuation = tok;
  });
  return { videos, continuation: continuation || null };
}

function channelInfo(root, id) {
  const meta = find(root, 'channelMetadataRenderer') || {};
  const header = find(root, 'pageHeaderRenderer') || {};
  const subs = text(find(root, 'subscriberCountText')) || text(find(root, 'subscribers'));
  let videos = '';
  walk(root, (n) => {
    if (videos) return;
    const t = text(n.content || n.simpleText || n);
    if (/\b[\d.,]+[KMB]?\s+videos?\b/i.test(t) && t.length < 40) videos = t;
  });
  return {
    id,
    channelId: id,
    title: text(meta.title || header.pageTitle).slice(0, 100),
    handle: text(meta.vanityChannelUrl || handleOf(root)).replace(/^https?:\/\/(www\.)?youtube\.com/i, '').slice(0, 60),
    subscribers: subs.slice(0, 40),
    videoCount: videos.slice(0, 40)
  };
}

function likesOf(next) {
  const btn = find(next, 'likeButtonViewModel') || find(next, 'segmentedLikeDislikeButtonViewModel');
  const label = text(btn && (btn.accessibilityText || btn.accessibility));
  const m = /(\d[\d.,]*\s*[KMB]?)\s*likes?/i.exec(label);
  if (m) return m[1];
  let found = '';
  walk(next, (n) => {
    if (found) return;
    if (typeof n.likeCountIfLiked === 'string') found = n.likeCountIfLiked;
  });
  return found.slice(0, 20);
}

function publishedOf(next) {
  const primary = find(next, 'videoPrimaryInfoRenderer') || {};
  return text(primary.dateText || primary.relativeDateText).slice(0, 40);
}

function detailsOf(player, next) {
  const d = (player && player.videoDetails) || {};
  if (!d || !ID.test(d.videoId)) return null;
  const secondary = find(next, 'videoSecondaryInfoRenderer') || {};
  const owner = secondary.owner || find(next, 'videoOwnerRenderer') || {};
  const views = d.viewCount ? Number(d.viewCount).toLocaleString('en-US') + ' views' : text(find(next, 'viewCount'));
  return {
    id: d.videoId,
    title: text(d.title).slice(0, 200),
    channel: text(d.author).slice(0, 100),
    channelId: CH.test(d.channelId) ? d.channelId : channelIdOf(owner),
    handle: handleOf(owner || next),
    subscribers: text(find(secondary, 'subscriberCountText')).slice(0, 40),
    likes: likesOf(next),
    views: String(views).slice(0, 40),
    published: publishedOf(next)
  };
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': buf.length
  });
  res.end(buf);
}

function fail(res, status, msg) {
  json(res, status, { success: false, error: msg });
}

export async function search(query, filter, continuation) {
  const body = { context: context() };
  if (continuation) body.continuation = continuation;
  else {
    body.query = query;
    if (FILTERS[filter]) body.params = FILTERS[filter];
  }
  const raw = await innertube('search', body);
  return collect(raw, filter === 'shorts');
}

export async function channel(id, tab, continuation) {
  const body = { context: context() };
  if (continuation) body.continuation = continuation;
  else {
    body.browseId = id;
    body.params = CHANNEL_TABS[tab] || CHANNEL_TABS.videos;
  }
  const raw = await innertube('browse', body);
  const info = channelInfo(raw, id);
  const got = collect(raw, tab === 'shorts');
  got.videos.forEach((v) => {
    if (!v.channel) v.channel = info.title;
    if (!v.channelId) v.channelId = id;
  });
  return { channel: info, videos: got.videos, continuation: got.continuation };
}

export async function videoDetails(ids) {
  const videos = [];
  for (const id of ids) {
    try {
      const [player, next] = await Promise.all([
        innertube('player', { context: context(), videoId: id }),
        innertube('next', { context: context(), videoId: id })
      ]);
      const v = detailsOf(player, next);
      if (v) videos.push(v);
    } catch (e) {
      videos.push({ id, error: true });
    }
  }
  return videos;
}

export function createTube() {
  return {
    async handleSearch(req, res) {
      try {
        const u = new URL(req.url, 'http://x');
        const q = String(u.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
        const channelId = String(u.searchParams.get('channel') || '');
        const filter = FILTERS[u.searchParams.get('filter')] !== undefined ? u.searchParams.get('filter') : 'videos';
        const tab = u.searchParams.get('tab') === 'shorts' ? 'shorts' : 'videos';
        const cont = u.searchParams.get('continuation') || '';
        if (cont && !TOKEN.test(cont)) return fail(res, 400, 'bad continuation');

        if (channelId) {
          if (!CH.test(channelId)) return fail(res, 400, 'bad channel');
          const out = await channel(channelId, tab, TOKEN.test(cont) ? cont : '');
          return json(res, 200, {
            success: true,
            type: 'channel',
            tab,
            channel: out.channel,
            videos: out.videos,
            continuation: out.continuation
          });
        }
        if (!q && !cont) return fail(res, 400, 'missing query');
        const out = await search(q, filter, TOKEN.test(cont) ? cont : '');
        return json(res, 200, {
          success: true,
          type: 'search',
          query: q,
          filter,
          videos: out.videos,
          continuation: out.continuation
        });
      } catch (e) {
        fail(res, 502, 'search service unreachable');
      }
    },
    async handleVideo(req, res) {
      try {
        const u = new URL(req.url, 'http://x');
        const ids = String(u.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter((id) => ID.test(id)).slice(0, MAX_IDS);
        if (!ids.length) return fail(res, 400, 'missing ids');
        const videos = await videoDetails(ids);
        json(res, 200, { success: true, type: 'video', videos });
      } catch (e) {
        fail(res, 502, 'search service unreachable');
      }
    }
  };
}
