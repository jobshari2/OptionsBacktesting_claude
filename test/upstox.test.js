const test = require('node:test');
const assert = require('node:assert');
const { createUpstox, createLimiter, parseChain } = require('../lib/upstox');

// Replace fetch for one test: replies come from the queue, the requests made are returned.
function fakeFetch(t, replies) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    const r = replies.shift();
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const ok = (data) => ({ status: 200, body: { status: 'success', data } });

test('live(): /v2 path with its query, the token as bearer, counted against the limits', async (t) => {
  const calls = fakeFetch(t, [ok([{ x: 1 }])]);
  const up = createUpstox({ getToken: () => 'tok' });
  const data = await up.live('/option/chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: '2026-10-13' });
  assert.deepStrictEqual(data, [{ x: 1 }]);
  assert.strictEqual(calls[0].url, 'https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty+50&expiry_date=2026-10-13');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok');
  assert.strictEqual(up.limiter.stats().requests, 1);
});

test('live(): a rejected token is reported once and the caller is told to log in', async (t) => {
  fakeFetch(t, [{ status: 401, body: {} }]);
  let cleared = 0;
  const up = createUpstox({ getToken: () => 'old', onUnauthorized: () => cleared++ });
  await assert.rejects(up.live('/option/contract'), /session expired/);
  assert.strictEqual(cleared, 1);
});

test('live(): no token, and an Upstox error message', async (t) => {
  await assert.rejects(createUpstox({ getToken: () => null }).live('/x'), /Not logged in/);
  fakeFetch(t, [{ status: 400, body: { status: 'error', errors: [{ message: 'Invalid expiry' }] } }]);
  await assert.rejects(createUpstox({ getToken: () => 'tok' }).live('/x'), /Invalid expiry/);
});

test('bulk(): the path carries the API version; a server error is retried', async (t) => {
  const calls = fakeFetch(t, [{ status: 502, body: {} }, ok({ candles: [] })]);
  const up = createUpstox({ getToken: () => 'tok' });
  assert.deepStrictEqual(await up.bulk('/v3/historical-candle/K/minutes/1/2025-01-31/2025-01-01'), { candles: [] });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].url, 'https://api.upstox.com/v3/historical-candle/K/minutes/1/2025-01-31/2025-01-01');
  assert.strictEqual(up.limiter.stats().requests, 2);
});

test('bulk(): a rejected token clears the session too', async (t) => {
  fakeFetch(t, [{ status: 401, body: {} }]);
  let cleared = 0;
  await assert.rejects(createUpstox({ getToken: () => 'old', onUnauthorized: () => cleared++ }).bulk('/v2/x'), /session expired/);
  assert.strictEqual(cleared, 1);
});

test('limiter: live requests use up the allowance bulk requests wait for', async () => {
  const lim = createLimiter([[200, 3]]); // 3 requests per 200 ms
  lim.note();
  lim.note();
  const t0 = Date.now();
  await lim.take(); // third in the window: goes at once
  assert.ok(Date.now() - t0 < 100);
  await lim.take(); // fourth: waits for the window to move on
  assert.ok(Date.now() - t0 >= 150, `waited only ${Date.now() - t0} ms`);
  assert.strictEqual(lim.stats().requests, 4);
});

test('parseChain: strikes ascending, both sides with prices, greeks and book', () => {
  const side = (ltp) => ({ instrument_key: 'K' + ltp, market_data: { ltp, close_price: 9, volume: 5, oi: 7, prev_oi: 6, bid_price: 0, ask_price: ltp + 1, bid_qty: 65, ask_qty: 130 }, option_greeks: { iv: 12, delta: 0.4, gamma: 0.001, theta: -3, vega: 8 } });
  const c = parseChain([
    { strike_price: 24850, underlying_spot_price: 24812.4, call_options: side(90), put_options: side(110) },
    { strike_price: 24800, underlying_spot_price: 24812.4, call_options: side(120), put_options: {} },
  ]);
  assert.strictEqual(c.spot, 24812.4);
  assert.deepStrictEqual(c.rows.map((r) => r.strike), [24800, 24850]);
  assert.deepStrictEqual(c.rows[1].ce, { key: 'K90', ltp: 90, close: 9, vol: 5, oi: 7, prevOi: 6, iv: 12, delta: 0.4, gamma: 0.001, theta: -3, vega: 8, bid: null, ask: 91, bidQ: 65, askQ: 130 });
  assert.deepStrictEqual(c.rows[0].pe, { key: null, ltp: null, close: null, vol: 0, oi: 0, prevOi: 0, iv: null, delta: null, gamma: null, theta: null, vega: null, bid: null, ask: null, bidQ: null, askQ: null });
  assert.deepStrictEqual(parseChain(undefined), { spot: null, rows: [] });
});
