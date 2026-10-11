// End-to-end tests (e2e/): the app in demo mode, driven through a real browser. `npm run test:e2e` runs them.
const os = require('os');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const CI = Boolean(process.env.CI);
// A port of its own, so an app already running on 3000 is left alone.
const PORT = Number(process.env.E2E_PORT || 3210);
// The demo server's recordings and downloads go to a temp folder instead of the project.
const TMP = path.join(os.tmpdir(), 'nifty-options-lab-e2e');

module.exports = defineConfig({
  testDir: './e2e',
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // in a pipeline: results for its Tests tab (JUnit), a report to download (HTML) and, on GitHub, failures marked on the code
  reporter: CI
    ? [['list'], ...(process.env.GITHUB_ACTIONS ? [['github']] : []), ['junit', { outputFile: 'reports/e2e-junit.xml' }], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=chrome (or msedge) uses the browser already installed instead of Playwright's own Chromium
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined },
    },
  ],
  webServer: {
    command: 'node server.js',
    env: { DEMO: '1', PORT: String(PORT), EVENTS_DIR: path.join(TMP, 'events'), BT_CACHE_DIR: path.join(TMP, 'bt-cache') },
    url: `http://127.0.0.1:${PORT}/api/chain`,
    reuseExistingServer: false, // never test against a server that might be showing real data
    timeout: 30_000,
  },
});
