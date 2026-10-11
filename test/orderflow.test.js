// Order flow (orderflow.js): minute rows from aggressor volume, and the plain-language read of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAggregator, analyse, netOf } = require('../orderflow');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 4, 30); // 10:00 IST on a Monday
const LOT = 65;

// One snapshot: strike 24800 with cumulative aggressor volume [ceBuy, ceSell, peBuy, peSell] and a book of tbq / tsq.
const entry = (t, agg, { spot = 24800, x, book = [100, 100, 100, 100] } = {}) => {
  const [ceTbq, ceTsq, peTbq, peTsq] = book;
  return {
    t,
    spot,
    x,
    d: { 24800: [100, 0, 0, 90, 0, 0, ...agg, 99, 101, ceTbq, ceTsq, 89, 91, peTbq, peTsq, 0, 0, 0, 0] },
  };
};

test('minute rows count only the new volume, by who started the trade', () => {
  const a = createAggregator();
  a.add(entry(T0, [1000, 500, 300, 200]));
  a.add(entry(T0 + 1000, [1400, 600, 500, 900])); // +400 call buys, +100 call sells, +200 put buys, +700 put sells
  const [r, ...more] = a.rows();
  assert.equal(more.length, 0);
  assert.deepEqual([r.cb, r.cs, r.pb, r.ps], [400, 100, 200, 700]);
  assert.equal(netOf(r), 400 - 100 - (200 - 700)); // calls bought and puts sold lean up
  assert.equal(r.t, T0);
  assert.equal(r.c, 24800);
});

test('the same volume is kept by the Nifty level it traded at, calls and puts apart', () => {
  const a = createAggregator();
  a.add(entry(T0, [0, 0, 0, 0], { spot: 24800.4 }));
  a.add(entry(T0 + 500, [100, 20, 10, 5], { spot: 24800.9 })); // same whole point
  a.add(entry(T0 + 1000, [160, 20, 10, 45], { spot: 24803.2 })); // +60 call buys, +40 put sells, 3 points higher
  const [r] = a.rows();
  assert.deepEqual(r.px, { 24800: [100, 20, 10, 5], 24803: [60, 0, 0, 40] });
  const sum = (i) => Object.values(r.px).reduce((s, v) => s + v[i], 0);
  assert.deepEqual([sum(0), sum(1), sum(2), sum(3)], [r.cb, r.cs, r.pb, r.ps], 'the levels add up to the minute');
});

test('counters that restart, a new expiry, a long pause or hours outside the session add nothing', () => {
  const a = createAggregator();
  a.add(entry(T0, [1000, 1000, 1000, 1000], { x: '2026-10-06' }));
  a.add(entry(T0 + 1000, [10, 10, 10, 10], { x: '2026-10-06' })); // feed restarted: never negative
  a.add(entry(T0 + 2000, [5000, 5000, 5000, 5000], { x: '2026-10-13' })); // another expiry: nothing to compare with
  a.add(entry(T0 + 3000, [5100, 5000, 5000, 5000], { x: '2026-10-13' }));
  a.add(entry(T0 + 60_000, [9100, 5000, 5000, 5000], { x: '2026-10-13' })); // 57 s later: too long a gap
  a.add(entry(Date.UTC(2026, 9, 5, 2, 0), [1, 1, 1, 1])); // 07:30 IST
  const rows = a.rows();
  assert.equal(rows.length, 2, 'only the two session minutes, none before the open');
  assert.equal(
    rows.reduce((s, r) => s + r.cb, 0),
    100,
  );
  assert.ok(rows.every((r) => r.cs === 0 && r.pb === 0 && r.ps === 0));
});

test('the book lean is the average share of resting quantity that is bullish', () => {
  const a = createAggregator();
  a.add(entry(T0, [0, 0, 0, 0], { book: [300, 100, 100, 300] })); // calls bid 300 / offered 100, puts bid 100 / offered 300: 600 of 800
  a.add(entry(T0 + 1000, [0, 0, 0, 0], { book: [100, 100, 100, 100] })); // 200 of 400
  assert.equal(a.rows()[0].bull, 62.5);
});

// minute rows for the read: flow per minute and a spot that moves by `step` each minute
function session(minutes, flow, step, { start = 24800, bull = 50 } = {}) {
  const lots = LOT * 1000;
  return Array.from({ length: minutes }, (_, i) => {
    const f = flow(i);
    const c = start + step(i);
    return {
      t: T0 + i * MIN,
      cb: f > 0 ? lots * f : 0,
      cs: f < 0 ? lots * -f : 0,
      pb: lots,
      ps: lots,
      bull,
      h: c + 1,
      l: c - 1,
      c,
    };
  });
}

test('the read needs a few minutes of flow before it says anything', () => {
  const a = analyse(
    session(
      1,
      () => 1,
      () => 0,
    ),
    { lot: LOT },
  );
  assert.equal(a.ready, false);
  assert.match(a.note, /Collecting/);
});

test('steady buying with a rising Nifty reads as buyers in control, and says why', () => {
  const rows = session(
    60,
    () => 3,
    (i) => i * 2,
    { bull: 70 },
  );
  const a = analyse(rows, { lot: LOT });
  assert.equal(a.ready, true);
  assert.equal(a.verdict.tone, 'bull');
  assert.ok(a.verdict.score > 0.2, `score ${a.verdict.score}`);
  assert.ok(a.windows.length === 5 && a.windows.every((w) => w.net > 0));
  assert.ok(a.reasons.some((r) => r.tone === 'bull' && /buying flow/i.test(r.title)));
  assert.ok(a.reasons.some((r) => /book leans bullish/i.test(r.title)));
  assert.ok(a.reasons.some((r) => /confirms price/i.test(r.title)));
});

test('steady selling reads as sellers in control', () => {
  const a = analyse(
    session(
      60,
      () => -3,
      (i) => -i * 2,
      { bull: 30 },
    ),
    { lot: LOT },
  );
  assert.equal(a.verdict.tone, 'bear');
  assert.ok(a.verdict.score < -0.2);
});

test('even flow is balanced', () => {
  const a = analyse(
    session(
      60,
      () => 0,
      () => 0,
    ),
    { lot: LOT },
  );
  assert.equal(a.verdict.tone, 'neutral');
  assert.match(a.verdict.label, /Balanced/);
});

test('a new high that the cumulative delta does not follow is a bearish divergence', () => {
  // an hour of buying that lifts Nifty, then 15 minutes of selling while it still makes a higher high
  const rows = session(
    60,
    (i) => (i < 40 ? 4 : -2),
    (i) => (i < 40 ? i * 2 : 78 - (i - 40) * 0.2 + (i === 55 ? 12 : 0)),
  );
  const a = analyse(rows, { lot: LOT });
  assert.equal(a.flags.divergence, 'bear');
  assert.ok(a.reasons.some((r) => /Bearish divergence/.test(r.title)));
});

test('heavy buying that does not move Nifty is absorption', () => {
  // quiet, even trading for 55 minutes, then a burst of buying with a flat Nifty
  const burst = (i) => (i < 55 ? 0.2 : 8);
  const a = analyse(
    session(60, burst, () => 0),
    { lot: LOT },
  );
  assert.equal(a.flags.absorption, 'bear');
  assert.ok(a.reasons.some((r) => /absorbed/.test(r.title)));
  // the same burst that does lift Nifty is just a move with its flow behind it
  const moved = analyse(
    session(60, burst, (i) => (i < 55 ? 0 : (i - 54) * 6)),
    { lot: LOT },
  );
  assert.equal(moved.flags.absorption, null);
});
