// Option surges (bt/surge.js scan + backtest, surgeradar.js live radar) on synthetic prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const S = require('../bt/surge');
const { createSurgeRadar } = require('../surgeradar');
const { MPD } = require('../bt/data');

// one session of closes (₹) as the cache keeps it: Int32Array(MPD*4) paise, -1 = no trade
function bars(closeAt) {
  const a = new Int32Array(MPD * 4).fill(-1);
  for (let m = 0; m < MPD; m++) {
    const c = closeAt(m);
    if (c == null) continue;
    const p = Math.round(c * 100);
    a.set([p, p, p, p], m * 4);
  }
  return a;
}
// 10 until 10:15, up to 35 by 11:15, back to 15 by 12:35; a stray ₹1 print at 09:45 and a stray ₹100 at 09:25
const surgeDay = (m) => (m === 30 ? 1 : m === 10 ? 100 : m < 60 ? 10 : m <= 120 ? 10 + ((m - 60) / 60) * 25 : m <= 200 ? 35 - ((m - 120) / 80) * 20 : 15);

test('a surge is measured from a low and to a peak that held two minutes: stray prints are ignored', () => {
  const days = new Map([['2026-01-05', bars(surgeDay)]]);
  const out = S.contractSurges(days, { ...S.SCAN_DEFAULTS }, '2026-01-06');
  assert.equal(out.length, 1);
  const ev = out[0];
  assert.equal(ev.span, 'intraday');
  assert.equal(ev.trough, 1000); // not the ₹1 print
  assert.ok(Math.abs(ev.peak - 3500) <= 50, `peak ${ev.peak}`); // not the ₹100 print
  assert.ok(ev.peakMin >= 119 && ev.peakMin <= 121);
});

test('the last half hour of expiry day (settlement average) is not scanned', () => {
  const late = (m) => (m < 350 ? 10 : 40);
  const days = new Map([['2026-01-06', bars(late)]]);
  assert.equal(S.contractSurges(days, { ...S.SCAN_DEFAULTS }, '2026-01-06').length, 0);
  assert.equal(S.contractSurges(days, { ...S.SCAN_DEFAULTS }, '2026-01-13').length, 1); // another day: it counts
});

test('illiquid sessions (few traded minutes) are skipped', () => {
  const thin = (m) => (m % 4 ? null : m < 100 ? 10 : 40);
  assert.equal(S.contractSurges(new Map([['2026-01-05', bars(thin)]]), { ...S.SCAN_DEFAULTS }, '2026-01-06').length, 0);
});

test('implied volatility round-trips through Black-Scholes', () => {
  const { bsm, RATE } = require('../lib/pricing');
  const p = bsm(24000, 24200, 3 / 365, 0.14, true, RATE);
  assert.ok(Math.abs(S.impliedVol(p, 24000, 24200, 3 / 365, true) - 0.14) < 1e-3);
  assert.equal(S.impliedVol(50, 24000, 23900, 1 / 365, true), null); // under intrinsic
});

// a cache folder with one contract and a flat Nifty, for the scan and the backtest
function fakeCache(dayBars, { expiry = '2026-01-06', day = '2026-01-06', strike = 24000, type = 'PE', lot = 65 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-'));
  fs.mkdirSync(path.join(dir, 'opt', expiry), { recursive: true });
  fs.mkdirSync(path.join(dir, 'contracts'), { recursive: true });
  const a = bars(dayBars);
  const saved = { from: day, to: expiry, days: { [day]: Buffer.from(a.buffer).toString('base64') } };
  fs.writeFileSync(path.join(dir, 'opt', expiry, `${strike}${type}.json.gz`), zlib.gzipSync(JSON.stringify(saved)));
  fs.writeFileSync(path.join(dir, 'contracts', expiry + '.json'), JSON.stringify([[strike, type, 'NSE_FO|1', lot]]));
  // Nifty falls 1 % through the session (in a put's favour)
  const nifty = new Float64Array(MPD * 4);
  for (let m = 0; m < MPD; m++) nifty.fill(24100 - m * 0.65, m * 4, m * 4 + 4);
  const data = { loadIndex: async () => [day], spotDay: (d) => (d === day ? nifty : null), vixDay: () => null };
  return { dir, data };
}

test('scan: the surge row carries the Nifty move, the driver and the marks', async () => {
  const { dir, data } = fakeCache(surgeDay, { expiry: '2026-01-08', day: '2026-01-06' });
  const r = await S.scanSurges(data, dir, {}, {});
  const I = (k) => r.cols.indexOf(k);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.ok(Math.abs(row[I('mult')] - 3.5) < 0.03); // the peak that held two minutes: ₹34.79
  assert.equal(row[I('dte')], 2);
  assert.equal(row[I('m100')] < row[I('m200')], true);
  assert.ok(row[I('niftyMove')] > 0); // Nifty fell: in the put's favour
  assert.equal(r.stats.tripled, 1);
});

test('backtest: buys the next minute after the signal and sells at the target, net of charges and slippage', async () => {
  const { dir, data } = fakeCache(surgeDay);
  const [res] = await S.backtestSurge(data, dir, [{ trigger: 2, minBase: 5, confirm: 0, dteMax: 0, targetMult: 3, stopPct: 25, budget: 20000 }]);
  assert.equal(res.trades.length, 1);
  const t = res.trades[0];
  assert.equal(t.why, 'target');
  assert.equal(t.entryMin, t.sigMin + 1);
  assert.ok(t.entry > 20 && t.entry < 21); // ≈ ₹20.4 open × 1.005
  assert.ok(t.exit >= 30 * 0.99);
  assert.equal(t.qty % 65, 0);
  assert.ok(t.pnl > 0 && t.pnl < (t.exit - t.entry) * t.qty); // charges taken off
  assert.equal(res.summary.trades, 1);
});

test('backtest: a doubling that collapses is stopped out (the watcher cannot know the peak)', async () => {
  const fade = (m) => (m < 60 ? 10 : m <= 90 ? 10 + ((m - 60) / 30) * 12 : Math.max(5, 22 - (m - 90) * 0.5));
  const { dir, data } = fakeCache(fade);
  const [res] = await S.backtestSurge(data, dir, [{ trigger: 2, minBase: 5, confirm: 0, dteMax: 0, targetMult: 3, stopPct: 25 }]);
  assert.equal(res.trades[0].why, 'stop');
  assert.ok(res.trades[0].pnl < 0);
});

test('radar: flags rising → doubled once each and writes them to the day log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const radar = createSurgeRadar({ dir });
  const t0 = Date.parse('2026-01-05T04:00:00Z'); // 09:30 IST
  const prices = [10, 10, 9, 9, 12, 15, 16, 19, 21, 21];
  prices.forEach((ltp, i) =>
    radar.update({
      expiry: '2026-01-06',
      updatedAt: t0 + i * 6000,
      spot: 24000 - i,
      rows: [{ strike: 24000, pe: { key: 'K1', ltp, close: 12, vol: 1000 + i * 500, oi: 5000 - i * 100, prevOi: 5000 } }],
    }),
  );
  const s = radar.state();
  assert.equal(s.rows[0].low, 9); // the 9 held two snapshots
  assert.equal(s.rows[0].stage, 'doubled');
  assert.deepEqual(
    s.alerts.map((a) => a.stage),
    ['doubled', 'rising'], // newest first
  );
  const log = fs
    .readFileSync(path.join(dir, '2026-01-05', 'surge-radar.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(log.length, 2);
});

test('minimum option price: ₹4 by default, and a surge whose low is under the setting is not counted', async () => {
  assert.equal(S.SCAN_DEFAULTS.minBase, 4);
  assert.equal(S.BT_DEFAULTS.minBase, 4);
  const { dir, data } = fakeCache(surgeDay, { expiry: '2026-01-08', day: '2026-01-06' }); // low ₹10
  assert.equal((await S.scanSurges(data, dir, { minBase: 10 }, {})).rows.length, 1);
  assert.equal((await S.scanSurges(data, dir, { minBase: 12 }, {})).rows.length, 0);
  const [res] = await S.backtestSurge(data, dir, [{ trigger: 2, minBase: 12, confirm: 0, dteMax: 3 }]);
  assert.equal(res.trades.length, 0);
});

test('radar: the minimum option price setting is read live', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  let min = 4;
  const radar = createSurgeRadar({ dir, minLow: () => min });
  const t0 = Date.parse('2026-01-05T04:00:00Z');
  [3, 3, 3, 5, 7].forEach((ltp, i) =>
    radar.update({
      expiry: '2026-01-06',
      updatedAt: t0 + i * 6000,
      spot: 24000,
      rows: [{ strike: 24000, ce: { key: 'K2', ltp, close: 4, vol: 100, oi: 10, prevOi: 10 } }],
    }),
  );
  assert.equal(radar.state().rows.length, 0); // low ₹3 < ₹4
  assert.equal(radar.state().minLow, 4);
  min = 2;
  assert.equal(radar.state().rows.length, 1);
});
