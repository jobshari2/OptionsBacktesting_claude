// The app in demo mode (synthetic data, no Upstox login), driven through a real browser.
// These tests only look and navigate. They never press a button that runs a backtest, a scan or a download:
// those replace the results saved in bt-data/.
const http = require('http');
const { test, expect } = require('@playwright/test');

// Uncaught errors thrown by the page's scripts while a test runs.
function scriptErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

// GET with the path sent exactly as written (a browser or fetch() would resolve the ".." first).
function rawGet(baseURL, rawPath) {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    http
      .get({ hostname, port, path: rawPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

test('the chain screen shows the demo market', async ({ page }) => {
  const errors = scriptErrors(page);
  await page.goto('/');
  await expect(page).toHaveTitle('Nifty Options Lab');
  await expect(page.locator('#source')).toHaveText('DEMO DATA');
  await expect(page.locator('main#app')).toBeVisible();
  await expect(page.locator('#spot')).toHaveText(/^\d{1,3}(,\d{3})*\.\d{2}$/);
  await expect(page.locator('#atm')).toHaveText(/^\d+$/);
  await expect(page.locator('#expiry option')).not.toHaveCount(0);
  await expect(page.locator('#chainBody tr').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('every script and stylesheet of the page is served', async ({ page }) => {
  const assets = [];
  page.on('response', (r) => {
    if (['document', 'script', 'stylesheet'].includes(r.request().resourceType())) assets.push({ url: new URL(r.url()).pathname, status: r.status() });
  });
  await page.goto('/');
  await expect(page.locator('#chainBody tr').first()).toBeVisible();
  expect(assets.length).toBeGreaterThan(20);
  expect(assets.filter((a) => a.status !== 200)).toEqual([]);
});

test('every screen opens without a script error', async ({ page }) => {
  test.slow(); // nine screens, some of them drawing saved results
  const errors = scriptErrors(page);
  await page.goto('/');
  await expect(page.locator('#chainBody tr').first()).toBeVisible(); // the live screens are drawn from the chain

  // the groups of the top bar and their screens, as the page lists them
  const groups = await page
    .locator('#subtabs .sub-group')
    .evaluateAll((els) => els.map((g) => ({ group: g.dataset.group, views: [...g.querySelectorAll('button')].map((b) => b.dataset.view) })));
  expect(groups.map((g) => g.group)).toEqual(['live', 'strat', 'builder', 'trades', 'tideas', 'port', 'data']);

  for (const { group, views } of groups) {
    for (const view of views) {
      await test.step(`${group} / ${view}`, async () => {
        await page.locator(`#tabs button[data-group="${group}"]`).click();
        if (views.length > 1) await page.locator(`#subtabs button[data-view="${view}"]`).click();
        await expect(page.locator(`main#${view === 'chain' ? 'app' : view}`)).toBeVisible();
        await expect(page.locator('main:not(.hidden)')).toHaveCount(1);
      });
    }
  }
  expect(errors).toEqual([]);
});

test('the colour theme is switched and remembered', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('#themeSw button[data-theme="day"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await expect(page.locator('#themeSw button[data-theme="day"]')).toHaveClass(/\bon\b/);
});

test('the chart window opens', async ({ page }) => {
  const errors = scriptErrors(page);
  const response = await page.goto('/chart.html');
  expect(response.status()).toBe(200);
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('/api/chain returns the option chain and keeps updating', async ({ request }) => {
  const chain = async () => (await (await request.get('/api/chain')).json()).data;
  const first = await chain();
  expect(first.source).toBe('demo');
  expect(first.spot).toBeGreaterThan(0);
  expect(first.rows.length).toBeGreaterThan(10);
  const strikes = first.rows.map((r) => r.strike);
  expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
  for (const row of first.rows) {
    expect(row.ce.ltp).toBeGreaterThan(0);
    expect(row.pe.ltp).toBeGreaterThan(0);
  }
  await expect.poll(async () => (await chain()).updatedAt, { timeout: 15_000 }).toBeGreaterThan(first.updatedAt);
});

test('unknown paths and files outside public/ are not served', async ({ baseURL }) => {
  for (const path of ['/no-such-file.js', '/api/no-such-route', '/../.env', '/../package.json', '/..%2f.env', '/%2e%2e/.env', '/..%5c.env', '/../server.js']) {
    const res = await rawGet(baseURL, path);
    expect(res.status, path).toBe(404);
    expect(res.body, path).not.toContain('UPSTOX_');
  }
});

// ---------- the Terminal design (public/terminal/): picked on the sign-in page, or from either design's own controls ----------
test('the Classic design loads nothing of the Terminal design and offers it', async ({ page }) => {
  const errors = scriptErrors(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'classic');
  await expect(page.locator('.topbar #tabs')).toBeVisible();
  expect(await page.evaluate(() => [...document.styleSheets].filter((s) => (s.href || '').includes('/terminal/')).length)).toBe(0);
  await expect(page.locator('#tmRail')).toHaveCount(0);

  await page.locator('#designBtn').click(); // loads the page again, in the Terminal design
  await expect(page.locator('html')).toHaveAttribute('data-design', 'terminal');
  await expect(page.locator('#tmRail #tabs')).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-design', 'terminal');
  expect(errors).toEqual([]);
});

test('the Terminal design: sharp text, every screen from the rail, Night / Day, the command line, back to Classic', async ({ page }) => {
  test.slow();
  const errors = scriptErrors(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('nifty-design')) localStorage.setItem('nifty-design', 'terminal');
  });
  await page.goto('/');
  await expect(page.locator('#chainBody tr').first()).toBeVisible();
  await expect(page.locator('#tmRail')).toBeVisible();
  await expect(page.locator('#tmStatus')).toBeVisible();

  // text on the Chain screen: whole pixels, never under 12 (the charts draw their own, on a canvas)
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('main#app *, .topbar *, #subtabs *, #tmRail *, #tmStatus *')]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length)
      .map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  expect(sizes.length).toBeGreaterThan(100);
  expect(sizes.filter((px) => px < 12 || px !== Math.round(px))).toEqual([]);

  // every screen, from the rail
  const groups = await page
    .locator('#subtabs .sub-group')
    .evaluateAll((els) => els.map((g) => ({ group: g.dataset.group, views: [...g.querySelectorAll('button')].map((b) => b.dataset.view) })));
  for (const { group, views } of groups) {
    for (const view of views) {
      await test.step(`${group} / ${view}`, async () => {
        await page.locator(`#tmRail button[data-group="${group}"]`).click();
        if (views.length > 1) await page.locator(`#subtabs button[data-view="${view}"]`).click();
        await expect(page.locator(`main#${view === 'chain' ? 'app' : view}`)).toBeVisible();
        await expect(page.locator('main:not(.hidden)')).toHaveCount(1);
      });
    }
  }

  // Night / Day, remembered
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('#tmTheme button[data-v="day"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await expect(page.locator('#tmTheme button[data-v="day"]')).toHaveClass(/\bon\b/);

  // the command line: a screen by its code, then back to the Classic design
  await page.keyboard.press('Control+k');
  await page.locator('#tmCmdIn').fill('bld');
  await page.keyboard.press('Enter');
  await expect(page.locator('main#sb')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.locator('#tmCmdIn').fill('cls');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'classic');
  await expect(page.locator('.topbar #tabs')).toBeVisible();
  expect(errors).toEqual([]);
});
