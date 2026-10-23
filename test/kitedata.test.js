// Kite as the live data source (lib/kitedata.js): the Upstox-shaped answers built from Kite's instrument list and
// quotes, the IV / greeks worked out from prices, and the tick feed. A fake Kite API: nothing here reaches Kite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKiteData, buildChain, NIFTY_KEY } = require('../lib/kitedata');
const KiteApi = require('../lib/kite');
const { bsm, RATE } = require('../lib/pricing');

const CSV = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '101,1,NIFTY26O2724900CE,"NIFTY",0,2026-10-27,24900.0,0.05,65,CE,NFO-OPT,NFO',
  '102,2,NIFTY26O2724900PE,"NIFTY",0,2026-10-27,24900.0,0.05,65,PE,NFO-OPT,NFO',
  '103,3,NIFTY26O2725000CE,"NIFTY",0,2026-10-27,25000.0,0.05,65,CE,NFO-OPT,NFO',
  '104,4,NIFTY26O2725000PE,"NIFTY",0,2026-10-27,25000.0,0.05,65,PE,NFO-OPT,NFO',
  '105,5,NIFTY26O2725100CE,"NIFTY",0,2026-10-27,25100.0,0.05,65,CE,NFO-OPT,NFO',
  '106,6,NIFTY26O2725100PE,"NIFTY",0,2026-10-27,25100.0,0.05,65,PE,NFO-OPT,NFO',
  '107,7,NIFTY26N0325000CE,"NIFTY",0,2026-11-03,25000.0,0.05,65,CE,NFO-OPT,NFO',
  '108,8,NIFTY26N0325000PE,"NIFTY",0,2026-11-03,25000.0,0.05,65,PE,NFO-OPT,NFO',
  '200,9,NIFTY26NOVFUT,"NIFTY",0,2026-11-24,0.0,0.1,65,FUT,NFO-FUT,NFO',
  '199,10,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0.0,0.1,65,FUT,NFO-FUT,NFO',
  '300,11,BANKNIFTY26O2755000CE,"BANKNIFTY",0,2026-10-27,55000.0,0.05,35,CE,NFO-OPT,NFO',
].join('\n');

const NOW = Date.parse('2026-10-23T11:00:00+05:30'); // a Friday, in the session
const SPOT = 25010;
const IV = 0.12;
const T = (Date.parse('2026-10-27T15:30:00+05:30') - NOW) / (365 * 86400_000);
const px = (k, call) => Math.round(bsm(SPOT, k, T, IV, call, RATE) * 20) / 20;
const quoteOf = (sym, k, call, oi) => {
  const p = px(k, call);
  return [
    `NFO:${sym}`,
    {
      last_price: p,
      ohlc: { close: p - 3 },
      volume: 1000 * k,
      oi,
      depth: { buy: [{ price: p - 0.05, quantity: 650 }], sell: [{ price: p + 0.05, quantity: 1300 }] },
    },
  ];
};

function fakeApi(over = {}) {
  const calls = [];
  return {
    calls,
    ...KiteApi,
    nfoCsv: async () => (calls.push('csv'), CSV),
    async quotes(auth, list, kind, pace) {
      await pace();
      calls.push(['quotes', kind, list.length]);
      if (kind === 'ltp') return { 'NSE:NIFTYBEES': { last_price: 281.5 } };
      const strikeOf = (s) => Number(s.slice(-7, -2));
      return Object.fromEntries([
        ['NSE:NIFTY 50', { last_price: SPOT }],
        ...list.filter((s) => s.startsWith('NFO:')).map((s) => quoteOf(s.slice(4), strikeOf(s), s.endsWith('CE'), 5_000_000)),
      ]);
    },
    async historical(auth, token, interval) {
      calls.push(['historical', token, interval]);
      // daily candles with OI: Wednesday, Thursday, and today (Friday) running
      return [
        ['2026-10-21T00:00:00+0530', 1, 1, 1, 1, 10, 3_000_000],
        ['2026-10-22T00:00:00+0530', 1, 1, 1, 1, 10, 4_000_000],
        ['2026-10-23T00:00:00+0530', 1, 1, 1, 1, 10, 5_000_000],
      ];
    },
    ...over,
  };
}
const make = (api) => createKiteData({ getAuth: () => ({ mode: 'connect', apiKey: 'k', accessToken: 't' }), api, now: () => NOW });

test('the instrument list gives the Nifty options with their lot and the Nifty futures, nearest first', () => {
  const { options, futures } = KiteApi.parseNiftyNfo(CSV);
  assert.equal(options.size, 8);
  assert.deepEqual(options.get('2026-10-27|25000|CE'), { token: 103, symbol: 'NIFTY26O2725000CE', expiry: '2026-10-27', lot: 65, strike: 25000, type: 'CE' });
  assert.deepEqual(
    futures.map((f) => f.symbol),
    ['NIFTY26OCTFUT', 'NIFTY26NOVFUT'],
  );
});

test('expiries, lot size and the future come back in the Upstox shapes the server reads', async () => {
  const kd = make(fakeApi());
  const c = await kd.call('/option/contract');
  assert.deepEqual(
    c.map((x) => x.expiry),
    ['2026-10-27', '2026-11-03'],
  );
  assert.equal(c[0].lot_size, 65);
  const f = await kd.call('/instruments/search', { query: 'NIFTY' });
  assert.equal(f[0].instrument_key, 'KITE|199');
  assert.equal(f[0].underlying_key, NIFTY_KEY);
  assert.equal(f[0].instrument_type, 'FUT');
  assert.equal(await kd.symbolFor('2026-11-03', 25000, 'PE'), 'NIFTY26N0325000PE');
  const ltp = await kd.call('/market-quote/ltp', { instrument_key: 'NSE_EQ|INF204KB14I2' });
  assert.equal(ltp['NSE_EQ|INF204KB14I2'].last_price, 281.5);
});

test('the chain: prices, quotes and OI from Kite, IV and greeks worked out, keys of Kite contracts', async () => {
  const api = fakeApi();
  const kd = make(api);
  const rows = await kd.call('/option/chain', { instrument_key: NIFTY_KEY, expiry_date: '2026-10-27' });
  assert.deepEqual(
    rows.map((r) => r.strike_price),
    [24900, 25000, 25100],
  );
  const r = rows[1];
  assert.equal(r.underlying_spot_price, SPOT);
  assert.equal(r.call_options.instrument_key, 'KITE|103');
  assert.equal(r.call_options.market_data.ltp, px(25000, true));
  assert.equal(r.call_options.market_data.bid_qty, 650);
  assert.equal(r.put_options.market_data.ask_price, px(25000, false) + 0.05);
  // the IV the prices were made with comes back (to the price's 0.05 rounding)
  assert.ok(Math.abs(r.call_options.option_greeks.iv - IV * 100) < 0.3, `call IV ${r.call_options.option_greeks.iv}`);
  assert.ok(Math.abs(r.put_options.option_greeks.iv - IV * 100) < 0.3, `put IV ${r.put_options.option_greeks.iv}`);
  assert.ok(r.call_options.option_greeks.delta > 0.4 && r.call_options.option_greeks.delta < 0.6);
  assert.ok(r.put_options.option_greeks.delta < -0.4 && r.put_options.option_greeks.delta > -0.6);
  assert.ok(r.call_options.option_greeks.theta < 0);
  // one quote request for the whole expiry (Nifty included)
  assert.deepEqual(
    api.calls.find((c) => c[0] === 'quotes'),
    ['quotes', 'quote', 7],
  );
  // the previous session's OI is read in the background from the daily candles: Thursday's, as Friday is running
  await new Promise((res) => setTimeout(res, 2600));
  const again = await kd.call('/option/chain', { expiry_date: '2026-10-27' });
  assert.equal(again[1].call_options.market_data.prev_oi, 4_000_000);
});

test('the IV of an option with no time value is left out, not made up', () => {
  const options = KiteApi.parseNiftyNfo(CSV).options;
  const q = Object.fromEntries([quoteOf('NIFTY26O2724900CE', 24900, true, 1), quoteOf('NIFTY26O2724900PE', 24900, false, 1)]);
  q['NFO:NIFTY26O2724900CE'].last_price = 1; // far below intrinsic
  q['NFO:NIFTY26O2724900CE'].depth = { buy: [], sell: [] };
  const rows = buildChain({ expiry: '2026-10-27', options, quote: q, spot: SPOT, now: NOW });
  assert.equal(rows[0].call_options.option_greeks.iv, null);
  assert.ok(rows[0].put_options.option_greeks.iv > 0);
});

test('the feed: Kite ticks under the app keys, with the quote and the aggressor split of new volume', () => {
  let opts;
  const subs = [];
  const ticks = new Map();
  const api = fakeApi({
    createKiteTicker(o) {
      opts = o;
      return {
        setEnabled() {},
        restart() {},
        setSubscriptions: (t) => subs.push(t),
        tick: (t) => ticks.get(t),
        status: () => ({ connected: true, enabled: true, instruments: 2, lastTickAt: 1 }),
      };
    },
  });
  const seen = [];
  const feed = make(api).createFeed({ onTick: (keys) => seen.push(keys) });
  feed.setSubscriptions([NIFTY_KEY, 'KITE|103', 'NSE_FO|999']);
  assert.deepEqual(subs.pop(), [256265, 103], 'only Kite instruments are subscribed');
  ticks.set(256265, { ltp: 25010, close: 24950 });
  ticks.set(103, { ltp: 100, vol: 1000, bid: 99.95, ask: 100.05, bidQ: 650, askQ: 650, oi: 7, tbq: 5, tsq: 6 });
  opts.onTicks([256265, 103], 1000);
  ticks.set(103, { ltp: 100.05, vol: 1650, bid: 100, ask: 100.1, bidQ: 650, askQ: 650, oi: 7 });
  opts.onTicks([103], 2000);
  assert.deepEqual(seen, [[NIFTY_KEY, 'KITE|103'], ['KITE|103']]);
  assert.equal(feed.tick(NIFTY_KEY).ltp, 25010);
  assert.equal(feed.tick(NIFTY_KEY).cp, 24950);
  const t = feed.tick('KITE|103');
  assert.equal(t.vol, 1650);
  assert.equal(t.buy, 650, 'a trade at the ask before it is a buy');
  assert.equal(t.bid, 100);
  assert.equal(feed.version, 2);
  assert.equal(feed.status().connected, true);
});

test('not logged in: a clear error, nothing asked of Kite', async () => {
  const api = fakeApi();
  const kd = createKiteData({ getAuth: () => null, api, now: () => NOW });
  await assert.rejects(kd.call('/option/contract'), /Not logged in to Kite/);
  assert.equal(api.calls.length, 0);
});

test('a Kite web session (enctoken) cannot feed the chain, and a refused token is reported once', async () => {
  const enc = createKiteData({ getAuth: () => ({ mode: 'enctoken', enctoken: 'x', userId: 'AB' }), api: fakeApi(), now: () => NOW });
  await assert.rejects(enc.call('/option/chain', { expiry_date: '2026-10-27' }), /needs a Kite Connect login/);
  const refused = [];
  const api = fakeApi({
    async quotes() {
      throw new KiteApi.KiteError('Incorrect `api_key` or `access_token`.', 'TokenException', 403);
    },
  });
  const kd = createKiteData({
    getAuth: () => ({ mode: 'connect', apiKey: 'k', accessToken: 't' }),
    api,
    now: () => NOW,
    onAuthError: (e) => refused.push(e.type),
  });
  await assert.rejects(kd.call('/option/chain', { expiry_date: '2026-10-27' }), /Incorrect/);
  assert.deepEqual(refused, ['TokenException']);
});
