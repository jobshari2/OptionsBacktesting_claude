// Strategy lab (bt/lab.js): legs from ATM offsets, the expiry profile (max profit / loss, breakevens, unlimited sides),
// and the backtest on a synthetic history — the bearish presets make money when Nifty falls, the trend filter keeps
// them out of rising markets, and the target exit closes the position early.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../bt/lab');
const { MPD, addDays } = require('../bt/data');

const strikes = [];
for (let k = 18000; k <= 30000; k += 50) strikes.push(k);
const withEntry = (legs, px) => legs.map((l) => ({ ...l, entry: px(l) }));

test('legs: offsets from ATM snapped to the strike list, lots multiplied', () => {
  const p = L.merge({ preset: 'bearCombo', lots: 2 });
  const legs = L.legsAt(24020, p, strikes);
  assert.deepEqual(
    legs.map((l) => [l.type, l.side, l.strike, l.lots]),
    [
      ['PE', 1, 24000, 2],
      ['PE', -1, 23700, 2],
      ['CE', -1, 24100, 2],
      ['CE', 1, 24300, 2],
    ],
  );
});

test('custom legs are cleaned: types, sides, 50-point offsets, no empty legs', () => {
  const legs = L.cleanLegs([
    { type: 'CE', side: -1, off: 120, lots: 1 },
    { type: 'x', side: 5, off: -260, lots: 2.4 },
    { type: 'PE', side: 1, off: 0, lots: 0 },
  ]);
  assert.deepEqual(legs, [
    { type: 'CE', side: -1, off: 100, lots: 1 },
    { type: 'PE', side: 1, off: -250, lots: 2 },
  ]);
});

test('profile: bear put spread is defined risk with one breakeven', () => {
  const legs = withEntry(L.legsAt(24000, L.merge({ preset: 'bearPut' }), strikes), (l) => (l.strike === 24000 ? 200 : 60));
  const pr = L.profile(legs, 65);
  assert.equal(pr.maxLoss, -140 * 65); // the debit
  assert.equal(pr.maxProfit, (400 - 140) * 65); // width less the debit
  assert.deepEqual(pr.breakevens, [23860]);
});

test('profile: the MCC options alone lose without limit on a rally; the backspread is open below', () => {
  const mcc = withEntry(L.legsAt(24000, L.merge({ preset: 'mccOpts' }), strikes), () => 50);
  const a = L.profile(mcc, 65);
  assert.equal(a.maxLoss, -Infinity);
  assert.ok(a.upSlope < 0);
  const back = withEntry(L.legsAt(24000, L.merge({ preset: 'putBack' }), strikes), () => 50);
  const b = L.profile(back, 65);
  assert.ok(b.downSlope > 0, 'net long a put: gains as Nifty falls');
  assert.equal(b.maxProfit, Infinity, 'open-ended on a fall, so no target % applies');
  assert.ok(Number.isFinite(b.maxLoss) && b.maxLoss < 0);
  // worst at the bought strike: 300 pts of the sold put less the net premium (−50 + 2·50 = 50 paid)
  assert.equal(b.maxLoss, -(300 + 50) * 65);
});

// ---------- synthetic history: weekdays, Thursday weeklies, monthly = last Thursday of the month ----------
function synth({ from = '2025-01-01', to = '2025-06-30', path }) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd > 0 && wd < 6) days.push(d);
  }
  const thursdays = days.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 4);
  const lastOf = new Map();
  for (const t of thursdays) lastOf.set(t.slice(0, 7), t);
  const monthly = new Set(lastOf.values());
  const spot = new Map(days.map((d, i) => [d, path(i, days.length)]));
  const intr = (type, K, s) => Math.max(0, type === 'CE' ? s - K : K - s);
  const px = (K, type, day, expiry) => {
    const s = spot.get(day);
    const dte = Math.max(0, (Date.parse(expiry) - Date.parse(day)) / 86400_000);
    return intr(type, K, s) + 250 * Math.sqrt(dte / 30) * Math.exp(-Math.abs(K - s) / 800) + 0.5;
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
const falling = (i) => 25000 - i * 50; // about −4 to −6 % a month
const rising = (i) => 21000 + i * 50;

test('backtest: the bear combo makes money every month of a falling market, holding Nifty loses', async () => {
  const r = await L.runLab(synth({ path: falling }), { preset: 'bearCombo' });
  assert.ok(r.summary.months >= 4);
  for (const m of r.months.filter((x) => x.ok)) {
    assert.ok(m.opt > 0, `${m.expiry}: ${m.opt}`);
    assert.ok(m.long < 0);
    assert.equal(m.hedged, m.opt + m.long);
    assert.ok(m.opt <= m.maxProfit, 'never more than its maximum');
  }
  assert.equal(r.summary.byMove.down.n, r.summary.months);
  assert.ok(r.summary.capital > 0);
});

test('backtest: the bear combo loses in a rising market, but no more than its maximum loss', async () => {
  const r = await L.runLab(synth({ path: rising }), { preset: 'bearCombo' });
  for (const m of r.months.filter((x) => x.ok)) {
    assert.ok(m.opt < 0);
    assert.ok(m.opt >= m.maxLoss - m.costs - 1, `${m.opt} vs ${m.maxLoss}`);
  }
});

test('trend filter: under the 20-day average only — a rising market is sat out, a falling one traded', async () => {
  const up = await L.runLab(synth({ path: rising }), { preset: 'bearCombo', filter: { mode: 'belowSma', sma: 20 } });
  const traded = up.months.filter((m) => m.ok);
  assert.equal(traded.length, 0);
  assert.ok(up.summary.filtered >= 4);
  assert.ok(up.months.every((m) => m.ok || m.filtered || m.skip));
  // sat out, NIFTYBEES is still held: "+ NIFTYBEES" equals NIFTYBEES alone, and it counts every series
  assert.equal(up.summary.hedged.total, up.summary.long.total);
  assert.ok(up.summary.long.total > 0);
  const dn = await L.runLab(synth({ path: falling }), { preset: 'bearCombo', filter: { mode: 'belowSma', sma: 20 } });
  assert.ok(dn.months.filter((m) => m.ok).length >= 3); // the first series has no 20 earlier closes: entered anyway
});

test('profit target closes every leg early, before the expiry', async () => {
  const r = await L.runLab(synth({ path: falling }), { preset: 'bearPut', exit: { targetPct: 30 } });
  const exits = r.months.filter((m) => m.exit?.why === 'target');
  assert.ok(exits.length > 0);
  for (const m of exits) {
    assert.ok(m.exit.day < m.expiry);
    assert.ok(m.closed.every((c) => c.exitAt.day === m.exit.day));
  }
  assert.equal(r.summary.exits.target, exits.length);
});

test('compare runs every preset with and without the filter on the same series', async () => {
  const r = await L.runLabCompare(synth({ path: falling, to: '2025-03-31' }), {});
  assert.equal(r.rows.length, L.PRESETS.length * 2);
  const n = r.rows[0].months.length;
  assert.ok(r.rows.every((x) => x.months.length === n));
  const bear = r.rows.find((x) => x.id === 'bearCombo' && x.filter === 'always');
  assert.ok(bear.summary.opt.total > 0);
  assert.ok(bear.summary.hedged.total > bear.summary.long.total, 'laid over NIFTYBEES it cuts the loss of a fall');
});
