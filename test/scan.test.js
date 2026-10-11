// History scan on synthetic candles: a mispricing that is really printed for a few minutes must come through every
// check and pay after costs; closes that are only out of step for one minute must be reported as a signal and
// nothing more. The candles are made up to exercise the checks — they say nothing about the real market.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../bt/anomalies');
const { createHistChain } = require('../bt/histchain');
const { runScan, trim } = require('../bt/scan');
const { MPD } = require('../bt/data');

const DAY = '2026-01-12'; // Monday
const EXPIRY = '2026-01-13';
const SPOT = 24000;
const KS = Array.from({ length: 41 }, (_, i) => SPOT + (i - 20) * 50);

// A data layer with one session of one expiry. Every contract trades every minute over a 1-point range around its
// Black-76 value; `bump(k, type, m)` returns points added to { all prices, or only the close } of minute m.
function fakeData(bump) {
  const flat = (v) => {
    const a = new Float64Array(MPD * 4);
    a.fill(v);
    return a;
  };
  const spot = { [DAY]: flat(SPOT), [EXPIRY]: flat(SPOT + 40) }; // settles 40 points higher
  const bars = new Map();
  function option(expiry, k, type) {
    const id = k + type;
    if (!bars.has(id)) {
      const a = new Int32Array(MPD * 4);
      for (let m = 0; m < MPD; m++) {
        const t = A.tradingYears(EXPIRY, DAY, m + 1);
        const df = Math.exp(-A.RATE * A.calendarYears(EXPIRY, DAY, m + 1));
        const fair = A.b76(SPOT / df, k, t, 0.14, type === 'CE', df);
        const b = bump(k, type, m) || {};
        const mid = fair + (b.all || 0);
        const close = mid + (b.close || 0);
        a.set(
          [mid, Math.max(mid + 0.5, close), Math.max(0.05, mid - 0.5), close].map((x) => Math.round(Math.max(0.05, x) * 100)),
          m * 4,
        );
      }
      bars.set(id, { id, a });
    }
    return bars.get(id);
  }
  return {
    expiryCalendar: async () => ({ expired: [EXPIRY], all: [EXPIRY], expiredSet: new Set([EXPIRY]), liveLot: 65 }),
    loadIndex: async (from, to) =>
      Object.keys(spot)
        .filter((d) => d >= from && d <= to)
        .sort(),
    spotDay: (d) => spot[d] || null,
    contracts: async () => ({ expiry: EXPIRY, lot: 65, strikes: KS }),
    option: async (expiry, k, type) => option(expiry, k, type),
    optionCached: (expiry, k, type) => option(expiry, k, type),
    optionDay: (c) => c.a,
    optionRaw: (c) => c.a,
    apiStats: () => ({}),
  };
}

test('a mispricing that is really printed comes through every check; closes out of step do not', async () => {
  const data = fakeData((k, type, m) => {
    // 10:55-10:59: the 24100 put trades 8 below its value, on every print
    if (k === 24100 && type === 'PE' && m >= 100 && m <= 104) return { all: -8 };
    // 12:35: the 24200 call's last trade of the minute is 5 above the rest of its minute
    if (k === 24200 && type === 'CE' && m === 200) return { close: 5 };
    return null;
  });
  const r = await runScan(data, createHistChain(data), {
    from: DAY,
    to: DAY,
    types: [
      { id: 'box', params: {} },
      { id: 'fly', params: {} },
    ],
    lots: 10,
  });
  assert.equal(r.days, 1);
  assert.equal(r.opts.lots, 10);
  const of = (id) => r.summary.find((s) => s.type === id);

  // the boxes on the cheap put: found, robust, fillable, paying. (The off print at 12:35 also makes boxes look
  // cheap at the closes: those are counted as signals and stop there.)
  const box = of('box');
  assert.equal(box.cls, 'arb');
  const real = r.hits.filter((x) => x.type === 'box' && x.time < '12:00');
  const noise = r.hits.filter((x) => x.type === 'box' && x.time >= '12:00');
  assert.ok(real.length >= 3 && noise.length >= 1);
  assert.deepEqual([box.hits, box.robust, box.fill, box.pay], [real.length + noise.length, real.length, real.length, real.length], JSON.stringify(box));
  for (const h of noise) {
    assert.equal(h.time, '12:35');
    assert.ok(h.value >= 2 && h.robust < 0 && h.out.ew < 0, JSON.stringify(h));
  }
  for (const h of real) {
    assert.ok(h.time >= '10:55' && h.time <= '10:59');
    assert.ok(h.strike === 24100 || h.ref === 24100);
    // 8 points at the closes; bought at the highs and sold at the lows of a 1-point range it keeps about 4 less
    assert.ok(h.value > 7.5 && h.robust > 3.5 && h.robust < h.value, `${h.value} / ${h.robust}`);
    assert.ok(h.out.ew > 3.5 && h.out.eo > h.out.ew, 'still there in the next minute, at its opens and at its worst prices');
    const units = 10 * 65;
    assert.ok(Math.abs(h.out.lock - (h.out.ew * units - h.out.cost)) < 5, 'what it locks in = edge x quantity - costs (the edge is shown to 2 decimals)');
    assert.ok(h.out.lock > 0 && h.out.cost > 80, 'four orders, taxes and the STT on the legs that settle in the money');
    // at settlement it makes what it locked in, plus the interest a bought box was discounted by
    assert.ok(h.out.net >= h.out.lock && h.out.net - h.out.lock < 0.3 * units, `${h.out.net} vs ${h.out.lock}`);
    assert.equal(h.out.fsp, SPOT + 40);
    assert.equal(h.out.entry.length, 4);
  }
  assert.ok(box.valid.lock > 0 && box.valid.net >= box.valid.lock);

  // butterflies: the one with the cheap put as a wing is real too; the ones on the single off print at 12:35 are
  // signals at the closes and nothing more
  const fly = of('fly');
  const flyReal = r.hits.filter((x) => x.type === 'fly' && x.time < '12:00');
  const flyNoise = r.hits.filter((x) => x.type === 'fly' && x.time >= '12:00');
  assert.ok(flyNoise.length >= 1, JSON.stringify(fly));
  assert.deepEqual([fly.hits, fly.robust, fly.fill], [flyReal.length + flyNoise.length, flyReal.length, flyReal.length], JSON.stringify(fly));
  for (const h of flyReal) assert.ok(h.side === 'PE' && h.st === undefined && h.robust > 0 && h.out.ew > 0, JSON.stringify(h));
  for (const h of flyNoise) {
    assert.equal(h.time, '12:35');
    assert.ok(h.value > 0.5 && h.robust < 0 && h.out.ew < 0, 'gone at the worst prices of its own minute and of the next');
  }
});

test('a fair history has nothing to report, and a saved scan keeps the fillable occurrences first', async () => {
  const data = fakeData(() => null);
  const r = await runScan(data, createHistChain(data), { from: DAY, to: DAY, types: ['varb', 'fly', 'bwfly', 'box', 'fv'].map((id) => ({ id, params: {} })) });
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.summary, []);

  const hit = (i, ok) => ({ i, cls: 'arb', robust: ok ? 1 : -1, out: { ew: ok ? 1 : -1 } });
  const hits = [hit(0, true), hit(1, false), hit(2, false), hit(3, true), hit(4, false), hit(5, false)];
  assert.deepEqual(
    trim(hits, 4).map((h) => h.i),
    [0, 3, 4, 5],
    'both fillable ones, then the latest of the rest, in time order',
  );
  assert.equal(trim(hits, 10).length, 6);
});
