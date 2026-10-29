import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests against the built section, served by the site's own
 * server (server/server.mjs) so the /api/music relay is real. Needs the
 * network and the installed Google Chrome (no browser download).
 *   npm run build && npm run test:e2e
 */
const PORT = 8194;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    // localhost, not 127.0.0.1: YouTube refuses embeds on pages opened by IP address.
    baseURL: `http://localhost:${PORT}/music/`,
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
    viewport: { width: 1440, height: 900 },
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'desktop', use: {}, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, grep: /@mobile/ },
  ],
  webServer: {
    command: 'node ../server/server.mjs',
    env: { PORT: String(PORT), RH_PORT: '1' },
    url: `http://127.0.0.1:${PORT}/music/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
