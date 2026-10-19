// Market regime of backtest trades (bt/metrics.js): trend up / down, whipsaw or range from what Nifty did while a
// trade was open, and the India VIX band at entry. The trades are made up; only the fields the rules read are set.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats, regimeStats, trendOf, vixBand } = require('../bt/metrics');
const { runBacktest } = require('../bt/engine');
const { MPD } = require('../bt/data');

// One trade from Nifty 24,000 at entry: out = Nifty at exit, hi / lo = highest / lowest while open.
const trade = (out, hi, lo, sessions = 1, extra = {}) => ({
  entryDay: '2026-06-08',
  exitDay: '2026-06-08',
  entryTime: '09:20',
  exitTime: '15:15',
  weekday: 1,
  dte: 1,
  spotIn: 24000,
  spotOut: out,
  spotHi: hi,
  spotLo: lo,
  sessions,
  net: 0,
  gross: 0,
  costs: 0,
  legs: [],
  ...extra,
});

test('a move beyond 1 % of Nifty is a trend, a wide range without one a whipsaw', () => {
  assert.equal(trendOf(trade(24300, 24300, 24000)), 'up'); // +1.25 %
  assert.equal(trendOf(trade(23700, 24000, 23700)), 'down'); // −1.25 %
  assert.equal(trendOf(trade(24100, 24300, 23800)), 'whipsaw'); // +0.42 %, range 2.08 %
  assert.equal(trendOf(trade(24100, 24200, 23900)), 'range'); // +0.42 %, range 1.25 %
  assert.equal(trendOf(trade(24240, 24240, 24000)), 'range'); // exactly 1 %: not beyond it
});

test('the thresholds grow with the square root of the sessions held', () => {
  // +1.25 % is a trend for an intraday trade, not over 4 sessions (needs 2 %); its 2.5 % range is no whipsaw there (3.6 %)
  assert.equal(trendOf(trade(24300, 24400, 23800, 1)), 'up');
  assert.equal(trendOf(trade(24300, 24400, 23800, 4)), 'range');
  assert.equal(trendOf(trade(24500, 24500, 24000, 4)), 'up'); // +2.08 %
  assert.equal(trendOf(trade(24100, 24500, 23600, 4)), 'whipsaw'); // range 3.75 %
  assert.equal(trendOf(trade(24300, 24400, 23800, 0)), 'up'); // no session count: one
});

test('trades saved without the Nifty range have no regime', () => {
  assert.equal(trendOf(trade(24300, null, null)), null);
  assert.equal(trendOf(trade(null, 24300, 24000)), null);
});

test('India VIX bands at entry: below 13, 13 to 16, above 16', () => {
  assert.deepEqual([null, 12.99, 13, 14.5, 16, 16.01].map(vixBand), [null, 'low', 'mid', 'mid', 'mid', 'high']);
});

test('the statistics count trades, P&L and winners per regime', () => {
  const T = [
    trade(24300, 24300, 24000, 1, { net: -5000, vix: 12 }),
    trade(24400, 24400, 24000, 1, { net: 2000, vix: 15 }),
    trade(23700, 24000, 23700, 1, { net: 1000, vix: 18 }),
    trade(24100, 24200, 23900, 1, { net: 1500, vix: 14 }),
    trade(24100, 24200, 23900, 1, { net: -500 }), // no VIX: counted by trend only
    trade(24100, null, null, 1, { net: 700, vix: 17 }), // saved without the range: counted by VIX only
  ];
  const st = computeStats(T, 100000);
  assert.deepEqual(st.regime, regimeStats(T));
  assert.deepEqual(st.regime.trend, {
    up: { n: 2, pnl: -3000, wins: 1 },
    down: { n: 1, pnl: 1000, wins: 1 },
    range: { n: 2, pnl: 1000, wins: 1 },
  });
  assert.deepEqual(st.regime.vix, {
    low: { n: 1, pnl: -5000, wins: 0 },
    mid: { n: 2, pnl: 3500, wins: 2 },
    high: { n: 2, pnl: 1700, wins: 2 },
  });
  assert.deepEqual(computeStats([]).regime, { trend: {}, vix: {} });
});

test('the engine records Nifty high / low, sessions held and India VIX at entry on every trade', async () => {
  const day = '2026-06-08';
  const expiry = '2026-06-09';
  // Nifty 24,000, up to 24,150 at 11:15, down to 23,900 at 13:15, back to 24,000 at the close; VIX 14.2 all day.
  const spotAt = (m) => (m === 120 ? 24150 : m === 240 ? 23900 : 24000);
  const sp = new Float64Array(MPD * 4);
  for (let m = 0; m < MPD; m++) sp.fill(spotAt(m), m * 4, m * 4 + 4);
  const opt = { a: new Int32Array(MPD * 4).fill(10000) }; // every option at ₹100
  const data = {
    expiryCalendar: async () => ({ expired: [expiry], all: [expiry], expiredSet: new Set([expiry]), monthly: new Set([expiry]), liveLot: 65 }),
    loadIndex: async (from, to) => [day, expiry].filter((d) => d >= from && d <= to),
    spotDay: (d) => (d === day ? sp : null),
    vixDay: (d) => (d === day ? new Float64Array(MPD * 4).fill(14.2) : null), // no VIX filter set: read all the same
    contracts: async () => ({ expiry, lot: 65, strikes: [23900, 23950, 24000, 24050, 24100] }),
    option: async () => opt,
    optionCached: () => opt,
    optionDay: (c) => c.a,
    apiStats: () => ({}),
  };
  const strategy = {
    mode: 'intraday',
    expiry: 'weekly',
    entry: { time: '09:20', days: [1, 2, 3, 4, 5] },
    exit: { time: '15:15' },
    legs: [{ action: 'S', type: 'CE', lots: 1, expiry: 'cur', strike: { by: 'atm', value: 0 } }],
  };
  const r = await runBacktest(data, strategy, { from: day, to: day, slippage: 0, brokerage: 20, taxes: false, lotMode: 'fixed', lotSize: 65 });
  const t = r.trades[0];
  assert.deepEqual([t.spotIn, t.spotOut, t.spotHi, t.spotLo, t.sessions, t.vix], [24000, 24000, 24150, 23900, 1, 14.2]);
  assert.equal(trendOf(t), 'range'); // no net move, a 1.04 % range
  assert.deepEqual(r.paths[0].days, [day]);
});
