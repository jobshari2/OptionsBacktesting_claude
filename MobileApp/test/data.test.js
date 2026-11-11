// Upstox reply parsing, the client's error handling, the demo market and the on-phone store. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpstox, parseQuotes, parseContracts, parseChain, parseCandles, loginUrl, exchangeCode, NIFTY } from '../www/js/upstox.js';
import { createDemo } from '../www/js/demo.js';
import * as store from '../www/js/store.js';
import * as positions from '../www/js/positions.js';

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('parse Upstox quotes, contracts, chain and candles', () => {
  const q = parseQuotes({ 'NSE_INDEX:Nifty 50': { instrument_token: NIFTY, last_price: 25900, net_change: 100, ohlc: { open: 25800, high: 25950, low: 25780 } } });
  assert.deepEqual(q[NIFTY], { ltp: 25900, change: 100, prevClose: 25800, open: 25800, high: 25950, low: 25780 });
  assert.deepEqual(
    parseContracts([
      { expiry: '2026-11-24', lot_size: 65 },
      { expiry: '2026-11-17', lot_size: 65 },
      { expiry: '2026-11-24', lot_size: 65 },
    ]),
    { expiries: ['2026-11-17', '2026-11-24'], lotSize: 65 },
  );
  const ch = parseChain([
    { strike_price: 26000, underlying_spot_price: 25900, call_options: { instrument_key: 'C', market_data: { ltp: 90, bid_price: 89, ask_price: 91, oi: 10 }, option_greeks: { iv: 13 } }, put_options: {} },
    { strike_price: 25900, underlying_spot_price: 25900, call_options: {}, put_options: { instrument_key: 'P', market_data: { ltp: 110 } } },
  ]);
  assert.equal(ch.spot, 25900);
  assert.deepEqual(
    ch.rows.map((r) => r.strike),
    [25900, 26000],
  );
  assert.equal(ch.rows[1].ce.iv, 13);
  assert.equal(ch.rows[0].pe.key, 'P');
  const c = parseCandles([
    ['2026-11-11T09:20:00+05:30', 1, 2, 0, 1.5, 10, 0],
    ['2026-11-11T09:15:00+05:30', 1, 2, 0, 1.2, 10, 0],
  ]);
  assert.equal(c[0].c, 1.2);
  assert.ok(c[0].t < c[1].t);
});

test('the Upstox client sends the token and reports errors', async () => {
  const seen = [];
  let unauthorized = 0;
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    if (url.includes('/v2/option/contract')) return reply(200, { status: 'success', data: [{ expiry: '2026-11-17', lot_size: 65 }] });
    if (url.includes('/v2/option/chain')) return reply(401, { status: 'error' });
    return reply(400, { status: 'error', errors: [{ message: 'Invalid instrument' }] });
  };
  const api = createUpstox({ getToken: () => 'T0K', fetchImpl, onUnauthorized: () => unauthorized++ });
  assert.deepEqual(await api.contracts(), { expiries: ['2026-11-17'], lotSize: 65 });
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer T0K');
  assert.ok(seen[0].url.startsWith('https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX%7CNifty+50'));
  await assert.rejects(api.chain('2026-11-17'), /expired/);
  assert.equal(unauthorized, 1);
  await assert.rejects(api.quotes(['X']), /Invalid instrument/);
  const none = createUpstox({ getToken: () => null, fetchImpl });
  await assert.rejects(none.contracts(), /Not logged in/);
  const offline = createUpstox({
    getToken: () => 't',
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(offline.contracts(), /No connection/);
});

test('login URL and code exchange', async () => {
  const u = new URL(loginUrl({ apiKey: 'KEY', redirectUri: 'https://me.github.io/app/', state: 's1' }));
  assert.equal(u.origin + u.pathname, 'https://api.upstox.com/v2/login/authorization/dialog');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://me.github.io/app/');
  let sent;
  const r = await exchangeCode({
    code: 'C',
    apiKey: 'KEY',
    apiSecret: 'SEC',
    redirectUri: 'https://me.github.io/app/',
    fetchImpl: async (url, opts) => {
      sent = { url, opts };
      return reply(200, { access_token: 'AT', user_name: 'Me' });
    },
  });
  assert.deepEqual(r, { token: 'AT', user: 'Me' });
  assert.equal(sent.opts.method, 'POST');
  assert.equal(sent.opts.headers['Content-Type'], 'application/x-www-form-urlencoded'); // a "simple" CORS request
  assert.match(sent.opts.body, /grant_type=authorization_code/);
  await assert.rejects(exchangeCode({ code: 'C', apiKey: 'K', apiSecret: 'S', redirectUri: 'x', fetchImpl: async () => reply(401, { errors: [{ message: 'bad secret' }] }) }), /bad secret/);
});

test('demo market: consistent, moves in session, frozen after close', async () => {
  let t = Date.UTC(2026, 10, 11, 5, 0); // 10:30 IST Wed
  const d = createDemo({ now: () => t });
  const { expiries, lotSize } = await d.contracts();
  assert.equal(lotSize, 65);
  assert.ok(expiries.length >= 8 && expiries.every((e) => new Date(e + 'T00:00:00Z').getUTCDay() === 2));
  const ch = await d.chain(expiries[0]);
  assert.ok(ch.spot > 20000 && ch.rows.length > 50);
  const row = ch.rows.find((r) => r.strike === Math.round(ch.spot / 50) * 50);
  assert.ok(row.ce.bid < row.ce.ask && row.ce.ltp > 0 && row.pe.ltp > 0 && row.ce.iv > 5);
  const q1 = (await d.quotes([NIFTY]))[NIFTY].ltp;
  assert.equal((await d.quotes([NIFTY]))[NIFTY].ltp, q1, 'same moment, same price');
  t += 7 * 60_000;
  assert.notEqual((await d.quotes([NIFTY]))[NIFTY].ltp, q1, 'moves during the session');
  t = Date.UTC(2026, 10, 11, 11, 0); // 16:30 IST
  const c1 = (await d.quotes([NIFTY]))[NIFTY].ltp;
  t += 3_600_000;
  assert.equal((await d.quotes([NIFTY]))[NIFTY].ltp, c1, 'frozen after the close');
  const candles = await d.intraday(NIFTY, 5);
  assert.equal(candles.length, 76); // 09:15 … 15:30 every 5 minutes
});

test('store falls back to memory; positions add/update/export/import', () => {
  store._reset(false);
  assert.equal(store.persistent(), false);
  assert.equal(store.settings().source, 'demo');
  store.saveSettings({ apiKey: 'K', apiSecret: 'S' });
  const p = positions.add({ name: 'A', kind: 'psc', expiry: '2026-12-29', lotSize: 65, legs: [] });
  positions.update(p.id, { name: 'B' });
  assert.equal(positions.get(p.id).name, 'B');
  const backup = positions.exportAll();
  assert.equal(backup.settings.apiSecret, '', 'secret left out of backups');
  positions.remove(p.id);
  assert.equal(positions.list().length, 0);
  assert.equal(positions.importAll(backup), 1);
  assert.equal(positions.list()[0].name, 'B');
  assert.equal(store.settings().apiSecret, 'S', 'import keeps the secret already on the phone');
  assert.throws(() => positions.importAll({ app: 'other' }), /Not a backup/);
});
