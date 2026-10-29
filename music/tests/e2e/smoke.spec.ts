import { expect, test, type Page } from '@playwright/test';

/** Reads player state through the window.__m hook (on with ?debug). */
async function player(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).__m.player;
    const el = p.engine?.element as HTMLAudioElement | undefined;
    return {
      status: p.playback.value.status as string,
      position: p.playback.value.position as number,
      provider: p.source.value?.provider as string | undefined,
      kind: p.source.value?.kind as string | undefined,
      trackId: p.currentTrack.value?.id as string | undefined,
      index: p.queue.value.index as number,
      audioSrc: el?.currentSrc ?? '',
    };
  });
}

/** Real song rows (loading skeletons share the class but are not list items). */
const SONG_ROW = '.m-row[role="listitem"]';
/** Home's "full tracks" shelf: trending on Audius, always full length. */
const FULL_SHELF = 'section[aria-labelledby="shelf-full"] .m-card';

async function waitPlaying(page: Page, minPosition = 1) {
  await expect.poll(async () => (await player(page)).status, { timeout: 45_000 }).toBe('playing');
  await expect.poll(async () => (await player(page)).position, { timeout: 30_000 }).toBeGreaterThan(minPosition);
}

/** Every request the page makes goes to this origin, except YouTube's player and thumbnails. */
function watchHosts(page: Page): string[] {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    if (u.host === 'localhost:8194' || u.host === 'www.youtube-nocookie.com' || u.host === 'i.ytimg.com') return;
    if (r.frame() !== page.mainFrame()) return; // requests made inside YouTube's own player
    foreign.push(u.host);
  });
  return foreign;
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('page error:', e.message));
});

test('the shell loads, navigates and talks only to this server', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const foreign = watchHosts(page);
  await page.goto('./?debug');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('music');
  await expect(page.locator('.m-shelf').first()).toBeVisible();
  for (const [name, heading] of [
    ['search', null],
    ['playlists', 'playlists'],
    ['home', 'music'],
  ] as const) {
    await page.getByRole('navigation', { name: 'music' }).getByRole('link', { name, exact: true }).click();
    if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
});

test('plays a full Audius track, survives navigation, pauses and skips', async ({ page }) => {
  await page.goto('./?debug');
  const cards = page.locator(FULL_SHELF);
  await expect(cards.first()).toBeVisible();
  await cards.first().getByRole('button').first().click();
  await waitPlaying(page);
  const first = await player(page);
  expect(first.provider).toBe('audius');
  expect(first.kind).toBe('full');
  expect(first.audioSrc).toContain('/api/music/audio/audius/');

  await page.getByRole('navigation', { name: 'music' }).getByRole('link', { name: 'playlists', exact: true }).click();
  const before = (await player(page)).position;
  await expect.poll(async () => (await player(page)).position).toBeGreaterThan(before + 1);

  await page.getByRole('contentinfo', { name: 'Player' }).getByRole('button', { name: 'Pause' }).click();
  await expect.poll(async () => (await player(page)).status).toBe('paused');

  await page.getByRole('contentinfo', { name: 'Player' }).getByRole('button', { name: 'Next' }).click();
  await waitPlaying(page, 0.5);
  expect((await player(page)).trackId).not.toBe(first.trackId);
});

test('rapid skipping ends on the right track with no stale audio', async ({ page }) => {
  await page.goto('./?debug');
  await page.waitForFunction(() => (window as any).__m);
  await page.evaluate(async () => {
    const s = (window as any).__m;
    const home = await (await fetch('/api/music/home')).json();
    s.player.playTracks(home.full, 0, { type: 'chart', title: 'Full tracks' });
    for (let i = 0; i < 6; i += 1) {
      s.player.next();
      await new Promise((r) => setTimeout(r, 40));
    }
  });
  await waitPlaying(page, 0.5);
  const st = await player(page);
  expect(st.index).toBe(6);
  expect(st.audioSrc).toContain(`/api/music/audio/audius/${st.trackId!.slice(3)}`);
});

test('plays a mainstream song through the visible YouTube player', async ({ page }) => {
  await page.goto('./?debug#/search?q=blinding%20lights%20the%20weeknd&type=tracks');
  const row = page.locator(SONG_ROW, { hasText: 'The Weeknd' }).first();
  await expect(row).toBeVisible();
  await row.dblclick();
  await expect.poll(async () => (await player(page)).provider, { timeout: 30_000 }).toBe('youtube');
  await waitPlaying(page);
  const box = await page.locator('.m-embed').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(200);
  expect(box!.height).toBeGreaterThanOrEqual(200);
  const frame = await page.locator('.m-embed iframe').boundingBox();
  expect(frame!.height).toBeGreaterThanOrEqual(box!.height - 1); // fills its box
  await expect(page.locator('.m-embed iframe')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\//);
});

test('creates a playlist from a song and keeps it after reload', async ({ page }) => {
  await page.goto('./?debug#/search?q=daft%20punk&type=tracks');
  const row = page.locator(SONG_ROW).first();
  await expect(row).toBeVisible();
  const title = (await row.locator('.m-title').textContent())!.trim();
  await row.hover();
  await row.getByRole('button', { name: /to a playlist$/ }).click();
  await page.getByRole('menuitem', { name: 'new playlist…' }).click();
  const name = `e2e ${Date.now()}`;
  await page.getByLabel('name').fill(name);
  await page.getByRole('button', { name: 'create', exact: true }).click();
  await expect(page.getByText(`created “${name}”`)).toBeVisible();
  await page.reload();
  await page.goto('./?debug#/library');
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.locator(`${SONG_ROW} .m-title`)).toContainText([title]);
});

test('mobile layout: bottom tabs, mini player and now playing @mobile', async ({ page }) => {
  await page.goto('./?debug');
  await expect(page.locator('.m-tabs')).toBeVisible();
  await page.locator(FULL_SHELF).first().getByRole('button').first().tap();
  await waitPlaying(page);
  await expect(page.locator('.m-mini')).toBeVisible();
  await page.locator('.m-mini-open').tap();
  await expect(page.getByRole('dialog', { name: /Now playing/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.querySelector('.m-np-main')!.scrollWidth > window.innerWidth || document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
