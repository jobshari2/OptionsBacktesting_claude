// Upstox-shaped replies for the tests, so the "Upstox (live)" path runs in the browser without a real account.
// Prices come from the demo market, reshaped into what api.upstox.com returns.
import { createDemo } from '../www/js/demo.js';
import { NIFTY } from '../www/js/upstox.js';

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

export async function mockUpstox(page, { token = 'TEST_TOKEN', onRequest = () => {} } = {}) {
  const demo = createDemo();
  await page.route('https://api.upstox.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    onRequest(url, req);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { ...CORS, 'access-control-allow-headers': 'authorization, accept' } });
    if (url.pathname === '/v2/login/authorization/token') {
      const body = new URLSearchParams(req.postData() || '');
      if (body.get('code') !== 'GOODCODE') return route.fulfill({ status: 401, headers: CORS, body: JSON.stringify({ status: 'error', errors: [{ message: 'Invalid auth code' }] }) });
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ access_token: token, user_name: 'Test User' }) });
    }
    if (req.headers().authorization !== `Bearer ${token}`) return route.fulfill({ status: 401, headers: CORS, body: JSON.stringify({ status: 'error', errors: [{ message: 'Invalid token' }] }) });
    const ok = (data) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ status: 'success', data }) });
    if (url.pathname === '/v2/market-quote/quotes') {
      const keys = url.searchParams.get('instrument_key').split(',');
      const q = await demo.quotes(keys);
      return ok(
        Object.fromEntries(
          Object.entries(q).map(([k, v]) => [k.replace('|', ':'), { instrument_token: k, last_price: v.ltp, net_change: v.change, ohlc: { open: v.open, high: v.high, low: v.low, close: v.ltp } }]),
        ),
      );
    }
    if (url.pathname === '/v2/option/contract') {
      const { expiries } = await demo.contracts();
      return ok(expiries.map((e) => ({ expiry: e, lot_size: 75, instrument_type: 'CE', strike_price: 26000 })));
    }
    if (url.pathname === '/v2/option/chain') {
      const ch = await demo.chain(url.searchParams.get('expiry_date'));
      const side = (o) => ({ instrument_key: o.key.replace('DEMO', 'NSE_FO'), market_data: { ltp: o.ltp, close_price: o.close, volume: o.vol, oi: o.oi, prev_oi: o.prevOi, bid_price: o.bid, ask_price: o.ask }, option_greeks: { iv: o.iv, delta: o.delta } });
      return ok(ch.rows.map((r) => ({ strike_price: r.strike, underlying_spot_price: ch.spot, call_options: side(r.ce), put_options: side(r.pe) })));
    }
    if (url.pathname.startsWith('/v3/historical-candle/intraday/')) {
      const c = await demo.intraday(NIFTY, 5);
      return ok({ candles: c.reverse().map((k) => [new Date(k.t).toISOString(), k.o, k.h, k.l, k.c, 0, 0]) });
    }
    return route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ status: 'error', errors: [{ message: 'not mocked ' + url.pathname }] }) });
  });
}
