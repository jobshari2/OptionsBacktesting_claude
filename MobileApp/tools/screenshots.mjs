// Takes the screenshots used in the docs: the app on demo data in a Pixel 7 emulation.
// Run: npm run screenshots   (starts its own file server; PW_CHANNEL=msedge to use the installed Edge)
import { chromium, devices } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'screenshots');
const PORT = 8193;
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [join(HERE, 'serve.js'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
try {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark', timezoneId: 'Asia/Kolkata' });
  const page = await ctx.newPage();
  const shot = async (name) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, name + '.png') });
    console.log('saved', name);
  };
  await page.goto(`http://localhost:${PORT}/#market`);
  await page.locator('.quote.big .q-ltp').waitFor();
  await page.locator('#mkSnap .stat').first().waitFor();
  await shot('1-market');
  await page.goto(`http://localhost:${PORT}/#chain`);
  await page.locator('#chBody tr.atm').waitFor();
  await shot('2-chain');
  await page.locator('#chBody tr.atm td[data-pick="CE"]').tap();
  await shot('3-chain-add-leg');
  await page.locator('.sheet-panel button.sell').tap();
  await page.goto(`http://localhost:${PORT}/#strategies`);
  await page.locator('#stTabs [data-t="collars"]').tap();
  await page.locator('#colChart svg').waitFor();
  await page.locator('#colKind').evaluate((e) => e.scrollIntoView());
  await shot('4-collar');
  await page.locator('#colSave').tap();
  await page.locator('#svOk').tap();
  await page.locator('#lvPick').waitFor();
  await page.waitForTimeout(3000); // the toast goes
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('5-live-trade');
  await page.goto(`http://localhost:${PORT}/#positions`);
  await page.locator('article.pos .pos-head').first().tap();
  await page.locator('article.pos svg').first().waitFor();
  await shot('6-positions');
  await page.goto(`http://localhost:${PORT}/#settings`);
  await shot('7-settings');
} finally {
  await browser.close();
  server.kill();
}
