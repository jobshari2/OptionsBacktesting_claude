// Back spread + 2 butterflies (lib/backspread.js): the strike window, the payoff of the user's Opstra example, the
// ranking, and the strategy the Back spread backtest screen runs (bt/backspread.js, engine strategy.pick).
const test = require('node:test');
const assert = require('node:assert/strict');
const BS = require('../lib/backspread');
const { strategyOf, cleanSel } = require('../bt/backspread');
const { normalizeStrategy } = require('../bt/engine');

const ks = [];
for (let k = 24000; k <= 26000; k += 50) ks.push(k);
const ai = ks.indexOf(25000);

test('every leg of every candidate lies within ATM ± the window, the centre on the side the back spread gains', () => {
  for (const side of ['PE', 'CE'])
    for (const win of BS.WINDOWS) {
      const gs = BS.geometries(ks, ai, side, win);
      assert.ok(gs.length > 0, `${side} ±${win} has candidates`);
      for (const g of gs) {
        for (const r of BS.ROLES) assert.ok(Math.abs(ks.indexOf(g[r]) - ai) <= win, `${side} ±${win} ${r} ${g[r]} inside`);
        assert.ok(side === 'PE' ? g.m <= 25000 : g.m >= 25000, 'centre on the gain side');
        assert.equal(g.hi - g.lo, 3 * g.W, 'wings 1.5 W either side of the centre');
        assert.equal(Math.abs(g.k1 - g.k2), g.W);
      }
    }
  // ±5 strikes (250 pts) only fits a 100-wide back spread: its wings are 150 from the centre
  assert.deepEqual([...new Set(BS.geometries(ks, ai, 'PE', 5).map((g) => g.W))], [100]);
  assert.ok(BS.geometries(ks, ai, 'PE', 20).some((g) => g.W === 400), 'a wide window allows wide spreads');
});

test("the Opstra example: put back spread 14900/14800 + 2 iron butterflies at 14850", () => {
  const g = { W: 100, m: 14850, k1: 14900, k2: 14800, lo: 14700, hi: 15000 };
  const px = { '14850PE': 23.2, '14850CE': 394, '14700PE': 12.6, '15000CE': 266.6, '14900PE': 29.2, '14800PE': 18.8 };
  const L = BS.legsOf(g, 'PE', 'iron').map((l) => ({ ...l, px: px[l.k + l.type] }));
  const e = BS.evaluate(L, { spot: 15175.3 });
  assert.equal(Math.round(e.net * 10) / 10, 267.6, 'net credit');
  assert.equal(Math.round(e.worst * 10) / 10, -32.4, 'worst: ₹2,430 for 75');
  assert.equal(Math.round(e.peak * 10) / 10, 217.6, 'peak at 14850: ₹16,320 for 75');
  // Opstra's breakevens, to the point
  [14668, 14733, 14984].forEach((x, i) => assert.ok(Math.abs(e.bes[i] - x) <= 1, `breakeven ${x}: ${e.bes[i]}`));
  // the single-type form has the same payoff shape: the same worst and peak relative to its own premium
  const same = BS.legsOf(g, 'PE', 'same');
  assert.deepEqual(
    same.map((l) => `${l.act}${l.n}${l.k}${l.type}`),
    ['S414850PE', 'B214700PE', 'B215000PE', 'S114900PE', 'B214800PE'],
  );
});

test('ranking: min loss, chance of profit, peak per point of loss', () => {
  const a = { worst: -10, peak: 100, pop: 0.2 };
  const b = { worst: -40, peak: 300, pop: 0.4 };
  assert.deepEqual([b, a].sort(BS.better('loss')), [a, b]);
  assert.deepEqual([a, b].sort(BS.better('pop')), [b, a]);
  assert.deepEqual([b, a].sort(BS.better('peak')), [a, b]);
});

test('the backtest strategy picks every leg from the window and survives normalisation', () => {
  const sel = cleanSel({ sides: ['PE'], wins: [10, 99], dtes: [2], widths: [100, 150], rank: 'pop', units: 2, sl: 4 });
  assert.deepEqual(sel.wins, [10], 'unknown windows dropped');
  assert.deepEqual(sel.widths, [100]);
  assert.deepEqual(sel.forms, ['same'], 'butterfly by default');
  assert.deepEqual(cleanSel({ forms: ['iron', 'same', 'x'] }).forms, ['iron', 'same']);
  assert.deepEqual(cleanSel({ form: 'iron' }).forms, ['iron'], 'a single form as before');
  const iron = normalizeStrategy(strategyOf({ ...sel, form: 'iron', side: 'PE', win: 10, dte: 2 }));
  assert.deepEqual(
    iron.legs.map((l) => `${l.action}${l.type}:${l.strike.role}`),
    ['SPE:m', 'SCE:m', 'BPE:lo', 'BCE:hi', 'SPE:k1', 'BPE:k2'],
    'iron fly: CE and PE strikes',
  );
  const s = normalizeStrategy(strategyOf({ ...sel, form: 'same', side: 'PE', win: 10, dte: 2 }));
  assert.deepEqual(s.pick, { kind: 'backfly', side: 'PE', win: 10, widths: [100], form: 'same', rank: 'pop', fresh: 15 });
  assert.deepEqual(
    s.legs.map((l) => `${l.action}${l.lots}${l.type}:${l.strike.by}/${l.strike.role}`),
    ['S8PE:pick/m', 'B4PE:pick/lo', 'B4PE:pick/hi', 'S2PE:pick/k1', 'B4PE:pick/k2'],
  );
  assert.equal(s.entry.dteDays, 2);
  assert.equal(s.exit.dteDays, 0);
  assert.deepEqual([s.risk.unit, s.risk.sl], ['pct', 4]);
  assert.equal(normalizeStrategy({ legs: [{ action: 'S', type: 'CE' }] }).pick, null, 'no picker unless asked');
});

// ---------- the engine on a made-up calendar ----------
// Seven sessions; expiries on the 1st (monthly), 3rd and 5th (weekly) and 7th (monthly). Nifty flat at 24,000; every
// option is its intrinsic value plus a time value that shrinks away from the money. Invented prices, to exercise the rules.
const { runBacktest } = require('../bt/engine');
const { MPD } = require('../bt/data');
const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09'];
const [E0, E1, E2, E3] = [DAYS[0], DAYS[2], DAYS[4], DAYS[6]];
const KS = Array.from({ length: 61 }, (_, i) => 22500 + i * 50);
const value = (k, type) => Math.max(0, type === 'CE' ? 24000 - k : k - 24000) + 80 * Math.exp(-Math.abs(24000 - k) / 200);
function calendarData({ untraded = new Set() } = {}) {
  const sp = new Float64Array(MPD * 4).fill(24000);
  const bars = new Map();
  const option = (k, type) => {
    if (!bars.has(k + type)) {
      const a = new Int32Array(MPD * 4).fill(Math.round(value(k, type) * 100));
      bars.set(k + type, { a, raw: untraded.has(k + type) ? null : a });
    }
    return bars.get(k + type);
  };
  return {
    expiryCalendar: async () => ({ expired: [E0, E1, E2, E3], all: [E0, E1, E2, E3], expiredSet: new Set([E0, E1, E2, E3]), monthly: new Set([E0, E3]), liveLot: 65 }),
    loadIndex: async (from, to) => DAYS.filter((d) => d >= from && d <= to),
    spotDay: () => sp,
    vixDay: () => null,
    contracts: async () => ({ lot: 65, strikes: KS }),
    option: async (e, k, type) => option(k, type),
    optionCached: (e, k, type) => option(k, type),
    optionDay: (c) => c.a,
    optionRaw: (c) => c.raw,
    apiStats: () => ({}),
  };
}
const OPTS = { from: DAYS[0], to: DAYS[6], slippage: 0.5, brokerage: 20, taxes: true, lotMode: 'fixed', lotSize: 65, minSlip: 0.05 };
const pickStrat = (o) => strategyOf({ side: 'PE', win: 10, widths: [100, 200], form: 'same', rank: 'loss', dte: 'start', expiry: 'weekly', ...o });

test('expiry start enters the day after the previous expiry: weekly series and monthly series', async () => {
  const wk = await runBacktest(calendarData(), pickStrat({}), OPTS);
  assert.deepEqual(
    wk.trades.map((t) => `${t.entryDay}>${t.exitDay}`),
    [`${DAYS[1]}>${E1}`, `${DAYS[3]}>${E2}`, `${DAYS[5]}>${E3}`],
  );
  const mo = await runBacktest(calendarData(), pickStrat({ expiry: 'monthly' }), OPTS);
  assert.deepEqual(
    mo.trades.map((t) => `${t.entryDay}>${t.exitDay}`),
    [`${DAYS[1]}>${E3}`],
    'the day after the previous monthly expiry, held to the monthly expiry',
  );
  assert.ok(mo.trades[0].legs.every((l) => l.expiry === E3), 'monthly legs trade the monthly expiry');
});

test('the picker keeps every leg inside the window, pays a tick at least, and skips options that did not trade', async () => {
  const r = await runBacktest(calendarData(), pickStrat({}), OPTS);
  const atm = KS.indexOf(24000);
  for (const t of r.trades) {
    for (const l of t.legs) assert.ok(Math.abs(KS.indexOf(l.strike) - atm) <= 10, `${l.strike} within ATM ± 10`);
    // a cheap option: 0.5 % of its price is under a tick, so the fill is a full tick away
    for (const l of t.legs.filter((x) => x.entryPx * 0.005 < 0.05)) assert.equal(Math.round(Math.abs(l.entryFill - l.entryPx) * 100) / 100, 0.05);
  }
  const used = new Set(r.trades[0].legs.map((l) => l.strike + l.type));
  const avoid = await runBacktest(calendarData({ untraded: used }), pickStrat({}), OPTS);
  assert.ok(avoid.trades.length > 0, 'another set of strikes is picked');
  for (const l of avoid.trades[0].legs) assert.ok(!used.has(l.strike + l.type), `${l.strike}${l.type} had no trade before entry`);
});
