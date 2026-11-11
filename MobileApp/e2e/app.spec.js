// The app on an emulated Android phone. Demo data unless a test switches to (mocked) Upstox.
import { test, expect } from '@playwright/test';
import { mockUpstox } from './upstox-fixture.js';

const tab = (page, name) => page.locator('.tabbar a', { hasText: name });

// Every request that leaves the phone must go to the app's own files or to api.upstox.com.
let foreign = [];
test.beforeEach(async ({ page, baseURL }) => {
  foreign = [];
  const origin = new URL(baseURL).origin;
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;
    if (u.origin !== origin && u.origin !== 'https://api.upstox.com') foreign.push(u.origin);
  });
});
test.afterEach(() => expect(foreign, 'requests to hosts other than the app and Upstox').toEqual([]));

async function noHorizontalScroll(page) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(w[0], 'page wider than the screen').toBeLessThanOrEqual(w[1]);
}

test('Market screen shows Nifty, VIX, NIFTYBEES, today’s chart and the expiry read', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#status')).toContainText('DEMO');
  await expect(page.locator('.quote.big .q-ltp')).toHaveText(/\d{2},\d{3}\.\d{2}/);
  await expect(page.locator('.quote', { hasText: 'INDIA VIX' })).toBeVisible();
  await expect(page.locator('.quote', { hasText: 'NIFTYBEES' })).toBeVisible();
  await expect(page.locator('#mkChart svg path.line')).toHaveCount(1);
  await expect(page.locator('#mkSnap .stat', { hasText: 'Max pain' })).toContainText(/\d/);
  await noHorizontalScroll(page);
});

test('Chain → tap a price → the leg lands in the Builder with a payoff', async ({ page }) => {
  await page.goto('./#chain');
  await expect(page.locator('#chBody tr.atm')).toHaveCount(1);
  expect(await page.locator('#chBody tr').count()).toBe(21);
  await noHorizontalScroll(page);
  const strike = await page.locator('#chBody tr.atm').getAttribute('data-strike');
  await page.locator('#chBody tr.atm td[data-pick="CE"]').tap();
  await expect(page.locator('.sheet-panel h3')).toHaveText(`NIFTY ${strike} CE`);
  await page.locator('.sheet-panel [data-inc]').tap();
  await page.locator('.sheet-panel button.sell').tap();
  await expect(page.locator('#toast')).toContainText(`Sold 2 × ${strike} CE`);
  await page.locator('#chBody tr.atm td[data-pick="PE"]').tap();
  await page.locator('.sheet-panel button.sell').tap();

  await tab(page, 'Strategies').tap();
  await expect(page.locator('#stTabs button.on')).toHaveText('Builder');
  await expect(page.locator('.leg-list li')).toHaveCount(2);
  await expect(page.locator('.leg-list li').first()).toContainText(`${strike} CE`);
  await expect(page.locator('#bChart svg path.line.s-exp')).toHaveCount(1);
  await expect(page.locator('#bStats')).toContainText('Max profit');
  // a short straddle: open-ended loss
  await expect(page.locator('#bStats .stat', { hasText: 'Max loss' })).toContainText('+');
  await page.locator('.leg-list li').first().locator('[data-act="flip"]').tap();
  await expect(page.locator('.leg-list li').first().locator('.pill')).toHaveText('BUY');
  await noHorizontalScroll(page);
});

test('Collars: both shapes, saved as a paper position, valued, then closed', async ({ page }) => {
  await page.goto('./#strategies');
  await page.locator('#stTabs button', { hasText: 'Collars' }).tap();
  const legs = page.locator('.card table.legs tbody tr');
  await expect(legs).toHaveCount(3);
  await expect(legs.nth(0)).toContainText('CE');
  await expect(legs.nth(1).locator('.pill')).toHaveText('B'); // put spread collar buys the upper put
  await page.locator('#colKind button', { hasText: 'Bull put collar' }).tap();
  await expect(page.locator('.card table.legs tbody tr').nth(1).locator('.pill')).toHaveText('S');
  await expect(page.locator('.stat', { hasText: 'NIFTYBEES' })).toContainText('×');
  await expect(page.locator('#colChart svg path.area-pos')).toHaveCount(1);
  await noHorizontalScroll(page);

  await page.locator('#colSave').tap();
  await page.locator('#svName').fill('BPC test');
  await page.locator('#svOk').tap();
  await expect(page.locator('#toast')).toContainText('Saved “BPC test”');

  await tab(page, 'Positions').tap();
  const card = page.locator('article.pos', { hasText: 'BPC test' });
  await expect(card.locator('.pos-pnl')).toHaveText(/[+−]?₹/);
  await expect(card.locator('.pos-break')).toContainText('NIFTYBEES');
  await card.locator('.pos-head').tap();
  await expect(card.locator('table.legs tbody tr')).toHaveCount(4); // 3 legs + NIFTYBEES
  await expect(card.locator('svg path.line.s-exp')).toHaveCount(1);
  await card.locator('[data-act="close"]').tap();
  await page.locator('.sheet-panel [data-yes]').tap();
  await expect(page.locator('h3.section-title')).toHaveText('Closed');
  await expect(page.locator('article.pos.closed', { hasText: 'BPC test' })).toBeVisible();

  // positions survive a restart of the app
  await page.reload();
  await expect(page.locator('article.pos.closed', { hasText: 'BPC test' })).toBeVisible();
});

test('Put spread collar: edit strikes and prices, then the Live trade: KPIs, legs, NIFTYBEES, grid, close, reopen', async ({ page }) => {
  await page.goto('./#strategies');
  await page.locator('#stTabs button', { hasText: 'Collars' }).tap();
  await expect(page.locator('#colSub button.on')).toHaveText('New trade');
  await expect(page.locator('table.legs.edit thead')).toContainText('LTP');
  await expect(page.locator('table.legs.edit thead')).not.toContainText('Bid');
  // a new strike takes its own LTP; a typed price stays
  const ce = page.locator('[data-strike="0"]');
  const ceK = +(await ce.inputValue()) + 100;
  await ce.fill(String(ceK));
  await ce.press('Enter');
  await expect(page.locator('[data-strike="0"]')).toHaveValue(String(ceK));
  const ltp = await page.locator('table.legs.edit tbody tr').first().locator('td').nth(2).innerText();
  expect(+(await page.locator('[data-price="0"]').inputValue())).toBeCloseTo(+ltp.replace(/,/g, ''), 2);
  await page.locator('[data-price="1"]').fill('123.45');
  await page.locator('[data-price="1"]').press('Enter');
  await expect(page.locator('[data-price="1"]')).toHaveValue('123.45');
  await page.locator('#colSpot').fill('25000');
  await page.locator('#colSpot').press('Enter');
  await page.locator('#colBu').fill('5000');
  await page.locator('#colBu').press('Enter');
  await page.locator('#colBp').fill('280');
  await page.locator('#colBp').press('Enter');
  await expect(page.locator('.stat', { hasText: 'NIFTYBEES' }).first()).toContainText('5,000 × 280.00');
  await noHorizontalScroll(page);
  await page.locator('#colSave').tap();
  await page.locator('#svName').fill('PSC live');
  await page.locator('#svOk').tap();

  // Live trade
  await expect(page.locator('#colSub button.on')).toHaveText('Live trade');
  await expect(page.locator('#lvPick')).toContainText('PSC live');
  for (const k of ['Nifty now', 'Sold call', 'Put spread', 'Options', 'NIFTYBEES', 'Total']) await expect(page.locator('.kpis .stat', { hasText: k }).first()).toBeVisible();
  await expect(page.locator('.kpis .stat', { hasText: 'Nifty now' })).toContainText('entry 25,000');
  await expect(page.locator('table.live')).toContainText(`${ceK} CE`);
  await expect(page.locator('table.live')).toContainText('123.45');
  await expect(page.locator('table.live')).toContainText('5,000 NIFTYBEES');
  await expect(page.locator('#lvCover')).toContainText('NIFTYBEES needed');
  await expect(page.locator('.track .mk.entry')).toContainText('25,000');
  await expect(page.locator('table.grid tbody tr')).toHaveCount(42);
  await expect(page.locator('table.grid tr.now')).toHaveCount(1);
  // payoff: total (expiry, today), options and NIFTYBEES drawn; the structures in the legend, to switch on
  for (const c of ['s-tot', 's-tot-now', 's-opt', 's-bees']) await expect(page.locator(`#lvChart svg path.line.${c}`)).toHaveCount(1);
  await expect(page.locator('#lvChart .mark-label').first()).toContainText(await page.locator('.kpis .stat.total b').innerText());
  await page.locator('#lvChart .chart-legend button', { hasText: 'Put spread' }).tap();
  await expect(page.locator('#lvChart svg path.line.s-pe')).toHaveCount(1);
  await page.locator('#lvChart .pay-range button', { hasText: '±20 %' }).tap();
  await expect(page.locator('#lvChart .pay-range button.on')).toHaveText('±20 %');
  await noHorizontalScroll(page);

  // edit a leg: close the sold call at a typed price
  await page.locator('tr[data-leg="0"]').tap();
  await page.locator('#lgExit').fill('10');
  await page.locator('#lgOk').tap();
  await expect(page.locator('tr[data-leg="0"]')).toContainText('closed');
  // NIFTYBEES entry saved from the form
  await page.locator('#lvQty').fill('6000');
  await page.locator('#lvSaveBees').tap();
  await expect(page.locator('table.live')).toContainText('6,000 NIFTYBEES');

  // close the whole trade at typed prices
  await page.locator('#lvCloseBtn').tap();
  await page.locator('[data-cpx="bees"]').fill('290');
  await expect(page.locator('#lvCloseTot')).toContainText('NIFTYBEES +₹60,000');
  await page.locator('#lvCloseGo').tap();
  await expect(page.locator('#colBody')).toContainText('Closed');
  await expect(page.locator('#colBody table.legs')).toContainText('290.00');
  await page.locator('#lvReopen').tap();
  await expect(page.locator('tr[data-leg="0"]')).toContainText('closed'); // closed before the trade's close: stays closed
  await expect(page.locator('tr[data-leg="1"]')).not.toContainText('closed');
});

test('Settings persist: theme, refresh, strikes', async ({ page }) => {
  await page.goto('./#settings');
  await page.locator('#seTheme button', { hasText: 'Light' }).tap();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#seRefresh').fill('10');
  await page.locator('#seRefresh').blur();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#seRefresh')).toHaveValue('10');
  await noHorizontalScroll(page);
});

test('Upstox source: asks to log in, then shows live (mocked) data from a pasted token', async ({ page }) => {
  const calls = [];
  await mockUpstox(page, { onRequest: (u) => calls.push(u.pathname) });
  await page.goto('./#settings');
  await page.locator('#seSource button', { hasText: 'Upstox' }).tap();
  await expect(page.locator('#status')).toHaveText('LOG IN');
  await page.locator('summary', { hasText: 'Paste an access token' }).tap();
  await page.locator('#seTokenIn').fill('TEST_TOKEN_THAT_IS_LONG_ENOUGH'.slice(0, 10) + 'X'.repeat(15));
  await page.locator('#seTokenSave').tap();
  // wrong token → Upstox says 401 → the app forgets it and asks again
  await tab(page, 'Market').tap();
  await expect(page.locator('#status')).toHaveText('LOG IN');
  await page.evaluate(() => localStorage.setItem('nom.token', JSON.stringify({ token: 'TEST_TOKEN', savedAt: Date.now(), expiresAt: Date.now() + 3600e3 })));
  await page.reload();
  await expect(page.locator('#status')).toContainText('LIVE');
  await expect(page.locator('.quote.big .q-ltp')).toHaveText(/\d{2},\d{3}\.\d{2}/);
  await tab(page, 'Strategies').tap();
  await page.locator('#stTabs button', { hasText: 'Collars' }).tap();
  await expect(page.locator('.stat', { hasText: 'Lot size' })).toContainText('75'); // lot size as Upstox reports it
  expect(calls).toEqual(expect.arrayContaining(['/v2/market-quote/quotes', '/v2/option/contract', '/v2/option/chain']));
});

test('Upstox login: the ?code= return is exchanged for a token on the phone', async ({ page }) => {
  let posted = null;
  await mockUpstox(page, { onRequest: (u, r) => r.method() === 'POST' && (posted = r.postData()) });
  await page.goto('./#settings');
  await page.evaluate(() => {
    localStorage.setItem('nom.settings', JSON.stringify({ source: 'upstox', apiKey: 'MYKEY', apiSecret: 'MYSECRET', redirectUri: location.origin + '/' }));
    localStorage.setItem('nom.oauthState', JSON.stringify('st4te'));
  });
  await page.goto('./?code=GOODCODE&state=st4te#market');
  await expect(page.locator('#toast')).toContainText('Logged in to Upstox');
  await expect(page).toHaveURL(/\/#market$/); // code removed from the address bar
  await expect(page.locator('#status')).toContainText('LIVE');
  expect(posted).toContain('client_secret=MYSECRET');
  // a reply with the wrong state is ignored
  await page.goto('./?code=GOODCODE&state=forged#market');
  await expect(page.locator('#toast')).toContainText('Ignored a login reply');
});

test('Installable PWA: manifest, icons, service worker, and it starts offline', async ({ page, context, request }) => {
  const res = await request.get('manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBeTruthy();
  for (const size of ['192x192', '512x512']) expect(m.icons.some((i) => i.sizes === size && i.type === 'image/png')).toBeTruthy();
  expect(m.icons.some((i) => i.purpose === 'maskable')).toBeTruthy();
  for (const i of m.icons) expect((await request.get(i.src)).ok(), i.src).toBeTruthy();

  await page.goto('./');
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.tabbar a')).toHaveCount(5);
  await expect(page.locator('.quote.big .q-ltp')).toHaveText(/\d/); // demo data needs no network
  await tab(page, 'Chain').tap();
  await expect(page.locator('#chBody tr.atm')).toHaveCount(1);
  await context.setOffline(false);
});

test('Offline on Upstox: last saved prices are shown and marked', async ({ page, context }) => {
  await mockUpstox(page);
  await page.goto('./');
  await page.evaluate(() => {
    localStorage.setItem('nom.settings', JSON.stringify({ source: 'upstox' }));
    localStorage.setItem('nom.token', JSON.stringify({ token: 'TEST_TOKEN', savedAt: Date.now(), expiresAt: Date.now() + 3600e3 }));
  });
  await page.reload();
  await expect(page.locator('.quote.big .q-ltp')).toHaveText(/\d{2},\d{3}/);
  await page.unroute('https://api.upstox.com/**');
  await page.route('https://api.upstox.com/**', (r) => r.abort('internetdisconnected'));
  await context.setOffline(true);
  await page.waitForTimeout(1700); // past the 1.5 s in which screens share one answer
  await page.locator('#refresh').tap();
  await expect(page.locator('#updated')).toContainText('(saved)');
  await expect(page.locator('#status')).toHaveText(/OFFLINE|ERROR/);
  await expect(page.locator('.quote.big .q-ltp')).toHaveText(/\d{2},\d{3}/);
  await context.setOffline(false);
});
