// End-to-end tests in Android phone emulation: Chromium with the Pixel 7 profile (412×915 screen, Android Chrome user
// agent, touch, device pixel ratio 2.625) and a narrow 360 px Android phone. Run: npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 8191);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL || undefined } },
    { name: 'galaxy-s9', use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 740 }, channel: process.env.PW_CHANNEL || undefined } },
  ],
  webServer: {
    command: `node tools/serve.js --port ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
  },
});
