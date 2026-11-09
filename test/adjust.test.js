// Trading Ideas › Adjustments: the ladder (lib/adjladder.js) reproduces every position of the PDF's two examples and
// its decision tree, the σ trigger matches the PDF's numbers, and the backtest (bt/adjust.js) climbs the ladder in a
// rally, falls down it (and closes at the bottom) in a slide, and settles against the plain long call.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/adjladder');
const Adj = require('../bt/adjust');
const { MPD, addDays } = require('../bt/data');

const show = (legs) => legs.map((l) => `${l.lots > 0 ? '+' : ''}${l.lots}x${l.strike}`).join(' ');

test('ladder: the PDF example positions, $80 stock with $5 strikes (naked ratio as printed)', () => {
  const at = (n) => show(A.legsFor(n, 80, 5, { cap: 'naked' }));
  // Example 1: long call → vertical → butterfly → condor
  assert.equal(at(0), '+1x80');
  assert.equal(at(1), '+1x80 -1x85');
  assert.equal(at(2), '+1x80 -2x85 +1x90');
  assert.equal(at(3), '+1x80 -1x85 -1x90 +1x95');
  // Example 2: long call → ratio → open ratio condor → fly roll again
  assert.equal(at(-1), '+1x80 -2x85');
  assert.equal(at(-2), '+1x75 -1x80 -1x85');
  assert.equal(at(-3), '+1x70 -1x75 -1x85');
});

test('ladder: the trades between rungs are the PDF adjustments', () => {
  const tr = (a, b) => show(A.trades(A.legsFor(a, 80, 5, { cap: 'naked' }), A.legsFor(b, 80, 5, { cap: 'naked' })));
  assert.equal(tr(0, 1), '-1x85'); // sell the 85 call
  assert.equal(tr(1, 2), '-1x85 +1x90'); // sell another 85, buy the 90
  assert.equal(tr(2, 3), '+1x85 -2x90 +1x95');
  assert.equal(tr(0, -1), '-2x85');
  assert.equal(tr(-1, -2), '+1x75 -2x80 +1x85'); // add a butterfly
  assert.equal(tr(-2, -3), '+1x70 -2x75 +1x80');
  // the tree's way back: vertical − → long call, ratio + → long call, fly roll + → reverse to the ratio
  assert.equal(tr(1, 0), '+1x85');
  assert.equal(tr(-1, 0), '+2x85');
  assert.equal(tr(-2, -1), '-1x75 +2x80 -1x85');
});

test('ladder: the capped ratio keeps every level defined-risk; bearish mirrors with puts', () => {
  for (const n of [-1, -2, -3]) {
    const legs = A.legsFor(n, 24000, 300, {});
    assert.equal(
      legs.reduce((s, l) => s + l.lots, 0),
      0,
      `level ${n}: as many calls bought as sold`,
    );
  }
  assert.equal(show(A.legsFor(-1, 24000, 300, {})), '+1x24000 -2x24300 +1x24900'); // cap 2 rungs above the short
  const bear = A.legsFor(2, 24000, 300, { bias: 'bear' });
  assert.ok(bear.every((l) => l.type === 'PE'));
  assert.equal(show(bear), '+1x23400 -2x23700 +1x24000');
});

test('σ trigger: the PDF numbers', () => {
  assert.equal(A.sigmaPts(80, 0.3, 'daily').toFixed(2), '1.51');
  assert.equal((1.5 * A.sigmaPts(80, 0.3, 'daily')).toFixed(2), '2.27');
  // 0.72σ to expiry: $5 on the $80 stock (30 days, 30 %); Nifty rounds to the 50-point grid
  assert.ok(Math.abs(0.72 * 80 * 0.3 * Math.sqrt(30 / 365) - 5) < 0.1);
  assert.equal(A.autoWidth(25600, 0.12, 30 / 365), 650);
});

test('decide: + / − steps along the ladder, holds past the top, closes past the bottom', () => {
  const p = A.merge({});
  const ctx = { iv: 0.15, theta: -1, locked: false };
  const sd = A.sigmaPts(24000, 0.15, 'daily');
  const st = (level) => ({ level, ref: 24000, quiet: 0 });
  assert.equal(A.decide(st(0), 24000 + sd, p, ctx).kind, 'none'); // inside 1.5σ
  const up = A.decide(st(0), 24000 + 1.6 * sd, p, ctx);
  assert.deepEqual([up.kind, up.to], ['adjust', 1]);
  const dn = A.decide(st(0), 24000 - 1.6 * sd, p, ctx);
  assert.deepEqual([dn.kind, dn.to], ['adjust', -1]);
  assert.equal(A.decide(st(3), 24000 + 3 * sd, p, ctx).kind, 'hold');
  assert.equal(A.decide(st(-3), 24000 - 3 * sd, p, ctx).kind, 'close');
  // short premium waits for 2σ
  assert.equal(A.decide(st(2), 24000 + 1.8 * sd, p, { ...ctx, theta: 5 }).kind, 'none');
  // bearish: Nifty down is "+"
  assert.equal(A.decide(st(0), 24000 - 1.6 * sd, A.merge({ bias: 'bear' }), ctx).to, 1);
  // stall rule: long premium, quiet long enough → butterfly
  const s = A.decide({ level: 0, ref: 24000, quiet: 1 }, 24010, A.merge({ stall: { on: true, checks: 2 } }), ctx);
  assert.deepEqual([s.kind, s.to, s.stall], ['adjust', 2, true]);
});

// ---------- synthetic history (as test/lab.test.js): weekdays, Thursday weeklies, last Thursday monthly ----------
function synth({ from = '2025-01-01', to = '2025-04-30', path }) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd > 0 && wd < 6) days.push(d);
  }
  const thursdays = days.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 4);
  const lastOf = new Map();
  for (const t of thursdays) lastOf.set(t.slice(0, 7), t);
  const monthly = new Set(lastOf.values());
  const spot = new Map(days.map((d, i) => [d, path(i)]));
  const strikes = [];
  for (let k = 15000; k <= 35000; k += 50) strikes.push(k);
  const px = (K, type, day, expiry) => {
    const s = spot.get(day);
    const T = Math.max(0, (Date.parse(expiry) - Date.parse(day)) / 86400_000 + 0.3) / 365;
    return Math.max(0.05, A.bs(s, K, T, 0.15, type === 'CE'));
  };
  return {
    expiryCalendar: async () => ({ monthly, expired: thursdays, expiredSet: new Set(thursdays) }),
    indexStart: () => from,
    loadIndex: async (a, b) => days.filter((d) => d >= a && d <= b),
    spotDay: (d) => (spot.has(d) ? new Float64Array(MPD * 4).fill(spot.get(d)) : null),
    contracts: async () => ({ strikes }),
    optionCached: () => null,
    option: async (expiry, strike, type) => ({ expiry, strike, type }),
    optionDay: (c, day) => (day > c.expiry ? null : new Int32Array(MPD * 4).fill(Math.round(px(c.strike, c.type, day, c.expiry) * 100))),
  };
}

test('backtest: a steady rally climbs the ladder (vertical, fly, condor) and makes money', async () => {
  const r = await Adj.runAdjust(synth({ path: (i) => 22000 + i * 120 }), { width: 300 });
  const ok = r.months.filter((m) => m.ok);
  assert.ok(ok.length >= 2);
  for (const m of ok) {
    assert.ok(m.maxLevel >= 2, `${m.expiry}: reached ${m.maxLevel}`);
    assert.equal(m.minLevel, 0);
    const lv = m.events.filter((e) => e.kind === 'adjust').map((e) => e.to);
    assert.deepEqual(lv.slice(0, 2), [1, 2], 'long call → vertical → butterfly');
    assert.ok(m.opt > 0);
    assert.ok(m.base > m.opt, 'a one-way rally: the plain call does better (the PDF says so too)');
    assert.equal(m.path[0][5], 0, 'the path starts at the entry event');
  }
  assert.equal(r.summary.months, ok.length);
});

test('backtest: a steady fall goes down the ladder and closes at the bottom', async () => {
  const r = await Adj.runAdjust(synth({ path: (i) => 26000 - i * 150 }), { width: 300 });
  const ok = r.months.filter((m) => m.ok);
  assert.ok(ok.length >= 2);
  for (const m of ok) {
    assert.ok(m.minLevel <= -3, `${m.expiry}: reached ${m.minLevel}`);
    assert.equal(m.exit?.why, 'ladder');
    assert.equal(m.events[m.events.length - 1].kind, 'close');
    assert.ok(m.closed.every((c) => c.exit >= 0));
    // capped ratio: never more short calls than long ones at any decision
    for (const e of m.events) assert.ok(e.legs.reduce((s, l) => s + l.side * l.lots, 0) >= 0, `${m.expiry} ${e.day}`);
  }
  assert.ok(r.summary.closes >= 2);
});

test('backtest: no trigger in a flat market — the long call is just held to expiry', async () => {
  const r = await Adj.runAdjust(synth({ path: (i) => 24000 + (i % 2 ? 20 : -20) }), {});
  const ok = r.months.filter((m) => m.ok);
  assert.ok(ok.length >= 2);
  for (const m of ok) {
    assert.equal(m.adjustments, 0);
    assert.equal(m.opt, m.base, 'same trade, same result');
  }
});

test('backtest: a whole-trade stop closes every leg', async () => {
  const r = await Adj.runAdjust(synth({ path: (i) => 26000 - i * 150 }), { width: 300, exit: { stopRs: 3000 } });
  const stops = r.months.filter((m) => m.exit?.why === 'stop');
  assert.ok(stops.length > 0);
  for (const m of stops) {
    const last = m.events.at(-1);
    assert.equal(last.kind, 'stop');
    assert.equal(last.legs.length, 0, 'nothing left open');
    assert.ok(last.day < m.expiry);
  }
});
