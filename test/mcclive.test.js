// Modified covered call › Live trade (bt/mcclive.js): a saved Builder trade read as a position, the move grid
// (NIFTYBEES + options), pricing a change with slippage and charges, the defined-risk and worst-outcome guards, and
// the suggestions' stats on past moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../bt/mcclive');
const { bsm } = require('../lib/pricing');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} is not within ${tol} of ${b}`);

// a Builder trade like the user's: call ratio 1×2, put 2-3-1, one put leg already closed
const saved = {
  id: 'pt-x',
  name: 'Live Covered Call',
  summary: { lot: 65, spot: 22950 },
  snap: {
    src: 'live',
    liveExpiry: '2026-11-23',
    legs: [
      { id: 1, action: 'B', type: 'PE', strike: 22500, lots: 2, expiry: '2026-11-23', entryPx: 343, entryDay: '2026-10-30', spotIn: 22960, open: true },
      {
        id: 2,
        action: 'S',
        type: 'PE',
        strike: 22400,
        lots: 3,
        expiry: '2026-11-23',
        entryPx: 298,
        entryDay: '2026-10-30',
        spotIn: 22964,
        open: false,
        exitPx: 150.56,
      },
      { id: 3, action: 'S', type: 'PE', strike: 22550, lots: 3, expiry: '2026-11-23', entryPx: 187, entryDay: '2026-10-30', spotIn: 22960, open: true },
      { id: 4, action: 'B', type: 'CE', strike: 22700, lots: 1, expiry: '2026-11-23', entryPx: 360, entryDay: '2026-10-30', spotIn: 22960, open: true },
      { id: 5, action: 'S', type: 'CE', strike: 22800, lots: 2, expiry: '2026-11-23', entryPx: 309, entryDay: '2026-10-30', spotIn: 22960, open: true },
      { id: 6, action: 'B', type: 'PE', strike: 22300, lots: 1, expiry: '2026-11-23', entryPx: 267, entryDay: '2026-10-30', spotIn: 22960, open: true },
    ],
  },
};

// a chain priced by Black-Scholes at one volatility (no smile), every strike traded today
function chainAt(S, T, v = 0.14) {
  const rows = [];
  for (let k = 20000; k <= 26000; k += 50)
    rows.push({ strike: k, ce: { ltp: Math.max(0.05, bsm(S, k, T, v, true)), vol: 1000 }, pe: { ltp: Math.max(0.05, bsm(S, k, T, v, false)), vol: 1000 } });
  return { spot: S, rows };
}

test('a saved Builder trade: open legs, the closed leg realised, entry spot', () => {
  const pos = L.fromBuilder(saved);
  assert.equal(pos.expiry, '2026-11-23');
  assert.deepEqual(pos.legs.map(L.legText), ['B 2× 22500 PE', 'S 3× 22550 PE', 'B 1× 22700 CE', 'S 2× 22800 CE', 'B 1× 22300 PE']);
  near(pos.realised.PE, (298 - 150.56) * 3 * 65, 1e-6);
  assert.equal(pos.realised.CE, 0);
  near(pos.spotIn, 22960, 1e-9);
  assert.ok(L.looksMcc(pos.legs));
  assert.ok(!L.looksMcc(pos.legs.filter((l) => l.type === 'CE')));
});

test('markOf: the bid / ask mid of a tight quote, else the LTP (pulled inside a wide quote it is outside of)', () => {
  // the user's 25050 CE on 9 Nov: last trade 581.60 above a 572.85 / 577.50 quote → the mid
  assert.deepEqual(L.markOf({ ltp: 581.6, bid: 572.85, ask: 577.5 }), { px: 575.175, how: 'mid' });
  // a small option: ₹2 wide is still tight (SPREAD.inr)
  assert.deepEqual(L.markOf({ ltp: 4, bid: 3, ask: 5 }), { px: 4, how: 'mid' });
  // wider than 10 % of the mid and ₹2: the LTP, inside the quote
  assert.deepEqual(L.markOf({ ltp: 130, bid: 100, ask: 120 }), { px: 120, how: 'ltp' });
  assert.deepEqual(L.markOf({ ltp: 110, bid: 100, ask: 120 }), { px: 110, how: 'ltp' });
  // no two-sided quote, or a crossed one: the LTP; nothing at all: no price
  assert.deepEqual(L.markOf({ ltp: 50, bid: 0, ask: 52 }), { px: 50, how: 'ltp' });
  assert.deepEqual(L.markOf({ ltp: 50, bid: 53, ask: 52 }), { px: 50, how: 'ltp' });
  assert.deepEqual(L.markOf({ bid: 100, ask: 130 }), { px: null, how: null });
  assert.deepEqual(L.markOf(null), { px: null, how: null });
});

test('market(): legs valued at the quote mid, the raw LTP kept in quote()', () => {
  const T = 30 / 365;
  const c = chainAt(24000, T);
  const r = c.rows.find((x) => x.strike === 24100);
  const fair = r.ce.ltp;
  r.ce = { ...r.ce, ltp: fair + 20, bid: fair - 1, ask: fair + 1 }; // an old trade 20 above the live quote
  const M = L.market(c, T);
  near(M.px('CE', 24100), fair, 1e-9);
  assert.equal(M.how('CE', 24100), 'mid');
  near(M.quote('CE', 24100).ltp, fair + 20, 1e-9);
  near(M.iv('CE', 24100), 0.14, 2e-3); // the volatility of the mid, not of the old trade
  assert.equal(M.how('PE', 24100), 'ltp'); // no quote in the fixture: its LTP
});

test('market(): implied volatility round-trips and the forward comes from parity', () => {
  const T = 20 / 365;
  const M = L.market(chainAt(23400, T, 0.15), T);
  near(M.atmIv, 0.15, 0.002);
  near(M.iv('PE', 22000), 0.15, 0.002);
  near(M.F, 23400 * Math.exp(0.065 * T), 2);
  assert.equal(M.px('CE', 99999), null);
});

test('grid: every row a % move from the start, Nifty now its own row, P&L since the start', () => {
  const pos = L.fromBuilder(saved);
  const T = 20 / 365;
  const M = L.market(chainAt(23400, T), T);
  const bees = { qty: 6500, price: 229, now: 234 };
  const E = 22960;
  const g = L.grid(pos, M, bees, E);
  assert.equal(g.length, L.MOVES.length * 2 + 2);
  const now = g.find((r) => r.mark === 'now');
  const start = g.find((r) => r.mark === 'entry');
  // the start: 0 %, at the entry level; Nifty now: its move from the start
  assert.equal(start.m, 0);
  near(start.x, E, 1e-9);
  near(now.x, 23400, 1e-9);
  near(now.m, (23400 / E - 1) * 100, 1e-9);
  near(now.fromNow, 0, 1e-9);
  // +5 % is 5 % above the start, not above now
  const up5 = g.find((r) => r.m === 5);
  near(up5.x, E * 1.05, 1e-9);
  near(up5.fromNow, ((E * 1.05) / 23400 - 1) * 100, 1e-9);
  // NIFTYBEES moves with Nifty from its price now; its P&L from its buy price
  near(up5.beesPx, (234 * up5.x) / 23400, 1e-9);
  near(up5.bees, 6500 * ((234 * up5.x) / 23400 - 229), 1e-6);
  // at expiry with Nifty at 24,108: puts worthless, calls: +1 × (x − 22700) − 2 × (x − 22800), from their entry
  const x = up5.x;
  const call = (x - 22700 - 360 - 2 * (x - 22800 - 309)) * 65 - require('../lib/costs').exercise((x - 22700) * 65);
  near(up5.call, call, 1e-6);
  const put = (298 - 150.56) * 3 * 65 + (-2 * 343 + 3 * 187 - 267) * 65;
  near(up5.put, put, 1e-6);
  near(up5.total, up5.call + up5.put + up5.bees, 1e-6);
  // rows sorted from the largest rise to the largest fall
  for (let i = 1; i < g.length; i++) assert.ok(g[i - 1].m > g[i].m);
  // NIFTYBEES priced from the start (bought at the entry level, no LTP): nothing made or lost at the start
  const est = L.grid(pos, M, { qty: 6500, price: 229, now: (229 * 23400) / E }, E);
  near(est.find((r) => r.mark === 'entry').bees, 0, 1e-6);
  // Nifty now within 0.05 % of a row: that row is Nifty now
  const close = L.grid(pos, L.market(chainAt(E * 1.02 + 1, T), T), bees, E);
  assert.equal(close.length, L.MOVES.length * 2 + 1);
  near(close.find((r) => r.mark === 'now').x, E * 1.02 + 1, 1e-9);
  // the "if today" P&L at Nifty now is the trade at its prices now
  const live = pos.realised.CE + pos.realised.PE + pos.legs.reduce((s2, l) => s2 + l.side * (M.px(l.type, l.strike) - l.entry) * l.lots * 65, 0);
  near(now.optToday, live, 0.01);
  // no start given: the grid is around Nifty now
  const none = L.grid(pos, M, bees, null);
  assert.equal(none.length, L.MOVES.length * 2 + 1);
  assert.equal(none.find((r) => r.m === 0).mark, 'now');
});

test('a change closing a leg at its price (no slippage) books exactly its P&L', () => {
  const pos = L.fromBuilder(saved);
  const T = 20 / 365;
  const M = L.market(chainAt(23400, T), T);
  const sold = pos.legs.find((l) => l.type === 'CE' && l.side < 0);
  const ch = { close: [{ id: sold.id, lots: 1 }], open: [] };
  const p = L.priceChange(pos, ch, M, 0, '2026-11-03');
  const px = M.px('CE', 22800);
  const charges = require('../lib/costs').orders({ buy: px * 65, orders: 1, day: '2026-11-03' });
  near(p.charges, charges, 1e-9);
  near(p.next.realised.CE, -(px - 309) * 65 - charges, 1e-6);
  assert.equal(p.next.legs.find((l) => l.id === sold.id).lots, 1);
  // at any Nifty at expiry the difference is the bought-back call's −(price − intrinsic) less the charges
  for (const x of [22000, 22800, 23400, 25000]) {
    const d = L.optExpiry(p.next, x).CE - L.optExpiry(pos, x).CE;
    const stt = (legs) =>
      require('../lib/costs').exercise(legs.filter((l) => l.type === 'CE' && l.side > 0).reduce((s, l) => s + Math.max(0, x - l.strike) * l.lots * 65, 0));
    near(d, -(px - Math.max(0, x - 22800)) * 65 - charges + stt(pos.legs) - stt(p.next.legs), 1e-6, 'x=' + x);
  }
});

test('slippage: bought at LTP × (1 + slip), sold at LTP × (1 − slip)', () => {
  const pos = L.fromBuilder(saved);
  const T = 20 / 365;
  const M = L.market(chainAt(23400, T), T);
  const p = L.priceChange(
    pos,
    {
      close: [],
      open: [
        { type: 'CE', strike: 24000, side: 1, lots: 1 },
        { type: 'PE', strike: 22000, side: -1, lots: 1 },
      ],
    },
    M,
    0.005,
    null,
  );
  near(p.fills[0].fill, M.px('CE', 24000) * 1.005, 1e-9);
  near(p.fills[1].fill, M.px('PE', 22000) * 0.995, 1e-9);
});

test('defined risk: no more net sold calls, never more puts sold than bought', () => {
  const legs = L.fromBuilder(saved).legs;
  assert.ok(L.keepsRisk(legs, legs));
  assert.ok(!L.keepsRisk(legs, [...legs, { type: 'CE', strike: 24000, side: -1, lots: 1 }]));
  assert.ok(!L.keepsRisk(legs, [...legs, { type: 'PE', strike: 22000, side: -1, lots: 1 }]));
  assert.ok(
    L.keepsRisk(
      legs,
      legs.filter((l) => !(l.type === 'CE' && l.side < 0)),
    ),
  );
});

test('worst outcome guard: ₹5,000, 5 % of it, or the average gain', () => {
  assert.ok(L.keepsWorst({ worstBefore: -50000, worstAfter: -54000 }));
  assert.ok(!L.keepsWorst({ worstBefore: -50000, worstAfter: -56000 }));
  assert.ok(L.keepsWorst({ worstBefore: -200000, worstAfter: -209000 }));
  assert.ok(!L.keepsWorst({ worstBefore: -200000, worstAfter: -211000 }));
  assert.ok(L.keepsWorst({ worstBefore: -50000, worstAfter: -60000, avg: 10000 }));
  assert.ok(!L.keepsWorst({ worstBefore: -50000, worstAfter: -60001, avg: 10000 }));
});

test("pastMoves: n-day returns scaled by today's volatility over VIX, clamped", () => {
  const closes = [
    { close: 100, vix: 10 },
    { close: 110, vix: 40 },
    { close: 121, vix: null },
  ];
  const m = L.pastMoves(closes, 1, 0.2);
  near(m[0], 0.1 * 2, 1e-12); // 20 % ÷ 10: ×2 (the cap)
  near(m[1], 0.1 * 0.5, 1e-12); // 20 % ÷ 40: ×0.5
  assert.equal(L.pastMoves(closes, 2, 0.2).length, 1);
  near(L.pastMoves([{ close: 100 }, { close: 90 }], 1, 0.2)[0], -0.1, 1e-12); // no VIX: unscaled
});

test('suggest: only changes that raise the average and keep the worst outcome; stats as judged', () => {
  const pos = L.fromBuilder(saved);
  const T = 14 / 365;
  const M = L.market(chainAt(23400, T), T);
  const bees = { qty: 6500, price: 229, now: 234 };
  const moves = [];
  for (let i = -40; i <= 40; i++) moves.push(i / 1000);
  const s = L.suggest(pos, M, bees, moves, { days: 10 });
  assert.ok(s.tried > 50);
  assert.ok(s.hold.profitable >= 0 && s.hold.profitable <= 1);
  for (const v of s.list) {
    assert.ok(v.stats.avg > 0, v.title);
    assert.ok(L.keepsWorst(v.stats), v.title);
    assert.equal(v.reliable, v.stats.better >= L.RELIABLE);
    // re-judging the position after it gives the same average
    const next = L.applyView(pos, v.after);
    const avg =
      moves.reduce(
        (a, r) =>
          a +
          (L.optExpiry(next, 23400 * (1 + r)).CE +
            L.optExpiry(next, 23400 * (1 + r)).PE -
            L.optExpiry(pos, 23400 * (1 + r)).CE -
            L.optExpiry(pos, 23400 * (1 + r)).PE),
        0,
      ) / moves.length;
    near(v.stats.avg, avg, 1, v.title);
  }
  // overpriced calls: selling the call ratio higher, or buying back the extra call, must come up when calls are rich
  const rich = chainAt(23400, T);
  for (const r of rich.rows) r.ce.ltp *= r.strike > 23400 ? 1.6 : 1;
  const s2 = L.suggest(pos, L.market(rich, T), bees, moves, { days: 10 });
  assert.ok(s2.list.length > 0);
  assert.equal(s2.list[0].group, 'call');
});

test('study rules: totals, months beaten and what is due now', () => {
  const pos = L.fromBuilder(saved);
  const T = 14 / 365;
  const M = L.market(chainAt(23440, T), T);
  const study = {
    rows: [
      {
        id: 'none',
        label: 'No adjustments',
        months: [
          { expiry: 'a', ok: true, opt: 100 },
          { expiry: 'b', ok: true, opt: -50 },
        ],
      },
      {
        id: 'move2',
        label: 'Roll at 2 %',
        params: { adj: { on: true, trigger: 'move', movePct: 2, legs: 'short' } },
        months: [
          { expiry: 'a', ok: true, opt: 120 },
          { expiry: 'b', ok: true, opt: -80 },
        ],
      },
      {
        id: 'move3',
        label: 'Roll at 3 %',
        params: { adj: { on: true, trigger: 'move', movePct: 3, legs: 'short' } },
        months: [
          { expiry: 'a', ok: true, opt: 90 },
          { expiry: 'b', ok: true, opt: 10 },
        ],
      },
    ],
  };
  const r = L.studyRules(study, pos, M, 22960);
  assert.deepEqual(
    r.map((x) => [x.id, x.total, x.beat, x.months]),
    [
      ['move3', 100, 1, 2],
      ['move2', 40, 1, 2],
    ],
  );
  assert.match(r.find((x) => x.id === 'move2').due, /up 2\.1 %/);
  assert.equal(r.find((x) => x.id === 'move3').due, null);
});

test('closed legs: listed with their exit, and their P&L in every figure (grid, today, hold stats, suggestions)', () => {
  const pos = L.fromBuilder({
    ...saved,
    snap: { ...saved.snap, legs: saved.snap.legs.map((l) => (l.id === 2 ? { ...l, exitDay: '2026-10-30', exitAt: 'Live 10:08:43', exitClock: '10:08' } : l)) },
  });
  assert.deepEqual(
    pos.closed.map((c) => [c.strike, c.type, c.side, c.lots, c.entry, c.exit, c.exitDay, c.exitAt]),
    [[22400, 'PE', -1, 3, 298, 150.56, '2026-10-30', '10:08']],
  );
  const booked = (298 - 150.56) * 3 * 65;
  const open = { ...pos, closed: [], realised: { CE: 0, PE: 0 } };
  const T = 14 / 365;
  const M = L.market(chainAt(23400, T), T);
  const bees = { qty: 6500, price: 229, now: 234 };
  // every row of the grid differs from the open legs alone by exactly the booked P&L
  const g = L.grid(pos, M, bees, 22960);
  const g0 = L.grid(open, M, bees, 22960);
  g.forEach((r, i) => {
    near(r.put - g0[i].put, booked, 1e-6);
    near(r.total - g0[i].total, booked, 1e-6);
    near(r.totalToday - g0[i].totalToday, booked, 1e-6);
    near(r.call, g0[i].call, 1e-9);
  });
  const moves = [-0.03, -0.01, 0, 0.01, 0.03];
  const h = L.holdStats(pos, 23400, moves, bees);
  const h0 = L.holdStats(open, 23400, moves, bees);
  near(h.avg - h0.avg, booked, 1);
  near(h.worst - h0.worst, booked, 1);
  // a suggestion's position after keeps the booked P&L, and its worst outcomes count it
  const s = L.suggest(pos, M, bees, moves, { days: 10 });
  for (const v of s.list) if (v.group === 'call') near(v.after.realised.PE, booked, 1e-6, v.title);
  near(s.hold.worst - L.holdStats(open, 23400, moves, bees).worst, booked, 1);
});

test('suggestions enter only strikes traded today with a sound quote; a stale LTP fills at the mid', () => {
  const pos = L.fromBuilder(saved);
  const T = 14 / 365;
  const bees = { qty: 6500, price: 229, now: 234 };
  const moves = [];
  for (let i = -40; i <= 40; i++) moves.push(i / 1000);
  const ch = chainAt(23400, T);
  for (const r of ch.rows) for (const o of [r.ce, r.pe]) o.vol = 0;
  // nothing traded today: no strike can be entered, only closing changes are left
  const none = L.suggest(pos, L.market(ch, T), bees, moves, { days: 10 });
  for (const v of none.list)
    assert.ok(
      v.orders.every((o) => o.close),
      v.title,
    );
  assert.ok(none.skipped.volume.length > 20);
  // volume back on all but a few strikes, and one strike's quote too wide
  for (const r of ch.rows) for (const o of [r.ce, r.pe]) o.vol = 500;
  for (const k of [23500, 23550, 23600]) ch.rows.find((r) => r.strike === k).ce.vol = 0;
  const wide = ch.rows.find((r) => r.strike === 23700).ce;
  Object.assign(wide, { bid: wide.ltp * 0.5, ask: wide.ltp * 1.5 });
  const M = L.market(ch, T);
  assert.equal(M.notEnterable('CE', 23500), 'volume');
  assert.equal(M.notEnterable('CE', 23700), 'spread');
  assert.equal(M.notEnterable('CE', 23650), null);
  assert.equal(M.notEnterable('CE', 99999), 'price');
  for (const c of L.candidates(pos, M, bees)) for (const o of c.open) assert.ok(!M.notEnterable(o.type, o.strike), c.title);
  const s = L.suggest(pos, M, bees, moves, { days: 10 });
  for (const v of s.list) for (const o of v.orders.filter((x) => !x.close)) assert.ok(o.vol > 0, v.title);
  assert.deepEqual(s.skipped.volume.filter((k) => k.endsWith('CE')).sort(), ['23500 CE', '23550 CE', '23600 CE']);
  assert.deepEqual(s.skipped.spread, ['23700 CE']);
  // priceChange refuses to enter a strike with no volume, even when asked directly
  assert.equal(L.priceChange(pos, { close: [], open: [{ type: 'CE', strike: 23500, side: 1, lots: 1 }] }, M, 0, null), null);
  // an LTP outside the bid–ask is old: fills at the quote's mid; inside it, at the LTP
  const q = ch.rows.find((r) => r.strike === 23800).ce;
  Object.assign(q, { bid: q.ltp + 10, ask: q.ltp + 11 });
  near(L.market(ch, T).exec('CE', 23800), q.ltp + 10.5, 1e-9);
  Object.assign(q, { bid: q.ltp - 0.5, ask: q.ltp + 0.5 });
  near(L.market(ch, T).exec('CE', 23800), q.ltp, 1e-9);
});

test('"if today" at Nifty now is every leg at its LTP, also when the forward is off spot × e^rT (futures basis)', () => {
  const pos = L.fromBuilder(saved);
  const T = 20 / 365;
  const S = 23800;
  const df = Math.exp(-0.065 * T);
  const F = S / df - 120; // the chain's forward 120 points under spot × e^rT
  const { b76 } = require('../lib/pricing');
  const rows = [];
  for (let k = 20000; k <= 26000; k += 50) {
    const v = 0.14 + 0.00000004 * (k - S) ** 2;
    rows.push({ strike: k, ce: { ltp: Math.max(0.05, b76(F, k, T, v, true, df)), vol: 1 }, pe: { ltp: Math.max(0.05, b76(F, k, T, v, false, df)), vol: 1 } });
  }
  const M = L.market({ spot: S, rows }, T);
  near(M.F, F, 0.5);
  for (const l of pos.legs) near(L.valueToday(l, S, M), M.px(l.type, l.strike), 1e-6, `${l.strike} ${l.type}`);
  const bees = { qty: 4288, price: 260.01, now: 270.12 };
  const now = L.grid(pos, M, bees, 22960).find((r) => r.mark === 'now');
  const top =
    pos.realised.CE + pos.realised.PE + pos.legs.reduce((s, l) => s + l.side * (M.px(l.type, l.strike) - l.entry) * l.lots * 65, 0) + 4288 * (270.12 - 260.01);
  near(now.totalToday, top, 0.01);
  near(now.callToday + now.putToday, now.optToday, 1e-9);
  // the model alone (no calibration) moves smoothly away from Nifty now: a call is worth more 1 % higher
  const call = pos.legs.find((l) => l.type === 'CE' && l.side > 0);
  assert.ok(L.valueToday(call, S * 1.01, M) > L.valueToday(call, S, M));
});

test('suggest: protection and riskier changes come apart from the suggested ones', () => {
  const pos = L.fromBuilder(saved);
  const T = 14 / 365;
  const M = L.market(chainAt(23400, T), T);
  const bees = { qty: 6500, price: 229, now: 234 };
  const moves = [];
  for (let i = -60; i <= 40; i++) moves.push(i / 1000);
  const s = L.suggest(pos, M, bees, moves, { days: 10 });
  const ids = (a) => a.map((v) => v.id);
  for (const v of s.protect) {
    assert.ok(v.protect && !ids(s.list).includes(v.id));
    assert.ok(v.stats.worstAfter - v.stats.worstBefore >= Math.max(L.PROTECT.inr, Math.abs(v.stats.worstBefore) * L.PROTECT.share) - 1, v.title);
  }
  for (const v of s.risky) {
    assert.ok(v.risky && v.stats.avg > 0 && !L.keepsWorst(v.stats), v.title);
    assert.ok(!ids(s.list).includes(v.id));
  }
  assert.ok(s.risky.length <= 4 && s.protect.length <= 3);
});

test("NIFTYBEES for the upside: units per point, the minimum, extra units bought at today's price", () => {
  const pos = L.fromBuilder(saved); // 1 lot of calls sold net (2 × 22800 sold, 1 × 22700 bought)
  const T = 20 / 365;
  const S = 23811;
  const M = L.market(chainAt(S, T), T);
  const bees = { qty: 4288, price: 260.01, now: 270.12 };
  const c = L.beesCover(pos, M, bees);
  assert.equal(c.netShortLots, 1);
  assert.equal(c.perPoint, 65);
  near(c.perUnit, 270.12 / S, 1e-12);
  assert.equal(c.slopeUnits, Math.ceil(65 / (270.12 / S)));
  near(c.slopeHeld, 4288 * (270.12 / S) - 65, 1e-9);
  assert.ok(c.minUnits >= c.slopeUnits);
  assert.equal(c.toBuy, c.minUnits - 4288);
  near(c.cost, c.toBuy * 270.12, 1e-6);
  // with the minimum (extra units bought now at ₹270.12): never below 0 from Nifty now up, to +50 %
  const at = (x, add) => {
    const e = L.optExpiry(pos, x);
    return e.CE + e.PE + 4288 * (270.12 * (x / S) - 260.01) + add * 270.12 * (x / S - 1);
  };
  for (let x = S; x <= S * 1.5; x += 25) assert.ok(at(x, c.toBuy) >= -1e-6, 'x=' + x);
  // one unit fewer is not enough somewhere up there (or loses per point far up)
  const fewer = c.toBuy - 1;
  let bad = (4288 + fewer) * c.perUnit - 65 < -1e-9;
  for (let x = S; x <= S * 1.5 && !bad; x += 25) bad = at(x, fewer) < 0;
  assert.ok(bad);
  // the rows: P&L with the units held and with the minimum, at expiry
  const r10 = c.rows.find((r) => r.pct === 10);
  near(r10.held, at(S * 1.1, 0), 1e-6);
  near(r10.min, at(S * 1.1, c.toBuy), 1e-6);
  // enough units held already: nothing to buy
  const ok = L.beesCover(pos, M, { ...bees, qty: 9000 });
  assert.equal(ok.toBuy, 0);
  assert.equal(ok.minUnits, 9000);
  // no sold calls: nothing to cover
  assert.equal(L.beesCover({ ...pos, legs: pos.legs.filter((l) => l.type === 'PE') }, M, bees).netShortLots, 0);
});

test('a Builder trade marked Modified covered call carries its NIFTYBEES (snap.mcc)', () => {
  assert.equal(L.fromBuilder(saved).bees, null);
  const t = { ...saved, snap: { ...saved.snap, mcc: { on: true, qty: 4288, price: 260.01, day: '2026-10-30' } } };
  const pos = L.fromBuilder(t);
  assert.ok(pos.flag);
  assert.deepEqual(pos.bees, { qty: 4288, price: 260.01, day: '2026-10-30', exitPx: null, exitDay: null, exitAt: null });
  // marked but no units entered: no NIFTYBEES
  assert.equal(L.fromBuilder({ ...saved, snap: { ...saved.snap, mcc: { on: true } } }).bees, null);
});

test('closeSaved: every open leg and the NIFTYBEES closed as the Builder records exits; reopenSaved undoes it', () => {
  const t = { ...saved, savedAt: 1, snap: { ...saved.snap, log: [], mcc: { on: true, qty: 4000, price: 260 } } };
  const open = t.snap.legs.filter((l) => l.open);
  const px = Object.fromEntries(open.map((l) => [l.id, 100]));
  const ts = Date.parse('2026-11-04T05:00:00Z'); // 10:30 IST
  // a price missing: refused
  assert.throws(() => L.closeSaved(t, { px: { ...px, 1: '' }, beesPx: 265, ts }), /Exit price missing for 22500 PE/);
  assert.throws(() => L.closeSaved(t, { px, ts }), /NIFTYBEES sell price missing/);
  const c = L.closeSaved(t, { px, beesPx: 265, ts });
  assert.ok(t.snap.legs[0].open, 'the trade passed in is not changed');
  assert.ok(c.snap.legs.every((l) => !l.open));
  const l1 = c.snap.legs.find((l) => l.id === 1);
  assert.equal(l1.exitPx, 100);
  assert.equal(l1.exitDay, '2026-11-04');
  assert.equal(l1.exitClock, '10:30');
  assert.equal(l1.exitMin, 75);
  assert.equal(l1.exitAt, 'Live 10:30:00');
  // the leg closed before keeps its own exit
  assert.equal(c.snap.legs.find((l) => l.id === 2).exitPx, 150.56);
  assert.equal(c.snap.mcc.exitPx, 265);
  assert.equal(c.closedAt, ts);
  assert.equal(c.snap.log.length, open.length + 1);
  // the position read back: no open legs, everything realised
  const pos = L.fromBuilder(c);
  assert.ok(pos.done);
  assert.equal(pos.legs.length, 0);
  assert.equal(pos.expiry, '2026-11-23');
  const lots = (l) => (l.action === 'B' ? 1 : -1) * l.lots * 65;
  const want = saved.snap.legs.reduce((s, l) => s + lots(l) * ((l.open ? 100 : l.exitPx) - l.entryPx), 0);
  near(pos.realised.CE + pos.realised.PE, want, 1e-6);
  assert.equal(c.summary.open, 0);
  assert.equal(c.summary.total, Math.round(want));
  assert.equal(c.summary.bees, 4000 * 5);
  assert.equal(pos.bees.exitPx, 265);
  // nothing left to close
  assert.throws(() => L.closeSaved(c, { px }), /no open legs/);
  // undo: the same legs open again, the earlier exit kept, the NIFTYBEES sale removed
  const r = L.reopenSaved(c, { ts: ts + 1000 });
  assert.deepEqual(
    r.snap.legs.map((l) => [l.id, l.open, l.exitPx ?? null]),
    t.snap.legs.map((l) => [l.id, l.open, l.exitPx ?? null]),
  );
  assert.equal(r.snap.mcc.exitPx, undefined);
  assert.equal(r.closedAt, undefined);
  assert.equal(L.fromBuilder(r).legs.length, 5);
  assert.throws(() => L.reopenSaved(r), /not closed from the Live trade tab/);
});

test('closeSaved: NIFTYBEES already sold in the Builder are left as they are', () => {
  const t = { ...saved, snap: { ...saved.snap, mcc: { on: true, qty: 4000, price: 260, exitPx: 270 } } };
  const px = Object.fromEntries(t.snap.legs.filter((l) => l.open).map((l) => [l.id, 0]));
  const c = L.closeSaved(t, { px });
  assert.equal(c.snap.mcc.exitPx, 270);
  assert.equal(c.snap.mcc.exitBatch, undefined);
  assert.equal(L.reopenSaved(c).snap.mcc.exitPx, 270);
});

// ---------- the Put spread collar on the same Live trade engine ----------
const collar = {
  id: 'pt-c',
  name: 'Live collar',
  summary: { lot: 65, spot: 24000 },
  snap: {
    src: 'live',
    liveExpiry: '2026-11-23',
    mcc: { on: true, kind: 'psc', qty: 6500, price: 240 },
    legs: [
      { id: 1, action: 'S', type: 'CE', strike: 24100, lots: 1, expiry: '2026-11-23', entryPx: 300, spotIn: 24000, open: true },
      { id: 2, action: 'B', type: 'PE', strike: 23900, lots: 1, expiry: '2026-11-23', entryPx: 250, spotIn: 24000, open: true },
      { id: 3, action: 'S', type: 'PE', strike: 23800, lots: 1, expiry: '2026-11-23', entryPx: 210, spotIn: 24000, open: true },
    ],
  },
};

test('collar: a saved trade marked Put spread collar is flagged for the collar only; its shape is recognised', () => {
  const asPsc = L.fromBuilder(collar, 'psc');
  const asMcc = L.fromBuilder(collar, 'mcc');
  assert.equal(asPsc.flag, true);
  assert.equal(asMcc.flag, false);
  assert.deepEqual(asPsc.bees, { qty: 6500, price: 240, day: null, exitPx: null, exitDay: null, exitAt: null });
  assert.ok(L.looksPsc(asPsc.legs));
  assert.ok(!L.looksMcc(asPsc.legs));
  assert.ok(!L.looksPsc(L.fromBuilder(saved).legs)); // the call ratio + 2-3-1 is not a collar
  // a Modified covered call trade (no kind) stays the Covered call's
  assert.equal(L.fromBuilder(saved, 'psc').flag, false);
  assert.equal(L.kindOf({ on: true }), 'mcc');
  assert.equal(
    L.fromPaper(
      { params: { lotSize: 65 }, cycle: { expiry: '2026-11-23', legs: asPsc.legs, closed: [], spot0: 24000, etf: { onceFrom: 240 } } },
      'Put spread collar',
    ).name,
    'Put spread collar paper trade · 2026-11-23',
  );
});

test('kindOfTrade: the Builder pick wins; unpicked, a collar by its legs (open, else all), anything else the Covered call', () => {
  const unpicked = { ...collar, snap: { ...collar.snap, mcc: { on: true, qty: 5850, price: 283.5 } } };
  assert.equal(L.kindOfTrade(unpicked), 'psc');
  assert.equal(L.fromBuilder(unpicked, 'psc').flag, true);
  assert.equal(L.fromBuilder(unpicked, 'mcc').flag, false);
  // picked as the Covered call in the Builder: kept there although the legs are a collar
  const picked = { ...unpicked, snap: { ...unpicked.snap, mcc: { ...unpicked.snap.mcc, kind: 'mcc' } } };
  assert.equal(L.kindOfTrade(picked), 'mcc');
  assert.equal(L.fromBuilder(picked, 'mcc').flag, true);
  // the call ratio + put 2-3-1, open or closed, unmarked: the Covered call
  assert.equal(L.kindOfTrade({ ...saved, snap: { ...saved.snap, mcc: { on: true } } }), 'mcc');
  const shut = { ...saved, snap: { ...saved.snap, legs: saved.snap.legs.map((l) => ({ ...l, open: false, exitPx: 1 })) } };
  assert.equal(L.kindOfTrade(shut), 'mcc');
  // a closed collar (no open legs) is still a collar
  const shutCollar = { ...unpicked, snap: { ...unpicked.snap, legs: unpicked.snap.legs.map((l) => ({ ...l, open: false, exitPx: 1 })) } };
  assert.equal(L.kindOfTrade(shutCollar), 'psc');
  // put strikes the other way round (sold above bought): the Bull put collar; a bought call: not a collar
  const bull = { ...unpicked, snap: { ...unpicked.snap, legs: unpicked.snap.legs.map((l) => (l.id === 3 ? { ...l, strike: 24000 } : l)) } };
  assert.equal(L.kindOfTrade(bull), 'bpc');
  const withCall = {
    ...unpicked,
    snap: { ...unpicked.snap, legs: [...unpicked.snap.legs, { id: 4, action: 'B', type: 'CE', strike: 24300, lots: 1, open: true }] },
  };
  assert.equal(L.kindOfTrade(withCall), 'mcc');
  assert.equal(L.kindOfTrade({ snap: { legs: [] } }), 'mcc');
});

test('collar suggestions: its own names, the sold put kept under the bought put, the bought put rolled on its own', () => {
  const pos = L.fromBuilder(collar, 'psc');
  const T = 20 / 365;
  const M = L.market(chainAt(24000, T), T);
  const c = L.candidates(pos, M, { qty: 6500, now: 240, price: 240 }, new Map(), 'psc');
  const titles = c.map((x) => x.title);
  assert.ok(titles.includes('Close the sold call'));
  assert.ok(titles.includes('Close the put spread'));
  assert.ok(titles.some((t) => /^Move the whole put spread/.test(t)));
  assert.ok(titles.some((t) => /^Buy back the sold 24100 call \(NIFTYBEES runs free/.test(t)));
  assert.ok(!titles.some((t) => /call ratio|butterfly/.test(t)));
  // one sold call: no "move the whole call" (it is the roll)
  assert.ok(!c.some((x) => x.id.startsWith('ceShift:')));
  // sold put rolls stay under the bought 23900 put; bought put rolls stay over the sold 23800 put
  const peRolls = c.filter((x) => x.id.startsWith('peRoll:')).map((x) => x.open[0].strike);
  assert.ok(peRolls.length && peRolls.every((k) => k < 23900));
  const peL = c.filter((x) => x.id.startsWith('peLRoll:')).map((x) => x.open[0].strike);
  assert.ok(peL.length && peL.every((k) => k > 23800));
  // the Covered call's candidates on its own trade are unchanged in kind
  const mcc = L.candidates(L.fromBuilder(saved), L.market(chainAt(23400, T), T), null, new Map());
  assert.ok(mcc.some((x) => x.title === 'Close the call ratio spread'));
  assert.ok(!mcc.some((x) => x.id.startsWith('peLRoll:')));
  // suggest runs on the collar's candidates
  const moves = [];
  for (let i = -40; i <= 40; i++) moves.push(i / 400);
  const out = L.suggest(pos, M, { qty: 6500, now: 240, price: 240 }, moves, { shape: 'psc' });
  assert.ok(out.tried > 50);
  for (const v of [...out.list, ...out.protect, ...out.risky]) assert.ok(!/call ratio|butterfly/.test(v.title));
});

test('collar study rules: due in the collar’s words (put spread up on a rise, sold call down on a fall)', () => {
  const pos = L.fromBuilder(collar, 'psc');
  const T = 20 / 365;
  const months = [{ expiry: '2026-01-27', ok: true, opt: 1000 }];
  const study = {
    rows: [
      { id: 'none', label: 'No adjustments', params: { adj: { on: false } }, months },
      { id: 'move2', label: 'Roll at a 2 % move', params: { adj: { on: true, trigger: 'move', movePct: 2, call: true, put: true } }, months },
    ],
  };
  const up = L.studyRules(study, pos, L.market(chainAt(24600, T), T), 24000, 'psc')[0];
  assert.match(up.due, /put spread up/);
  const down = L.studyRules(study, pos, L.market(chainAt(23400, T), T), 24000, 'psc')[0];
  assert.match(down.due, /sold call down/);
  assert.equal(L.studyRules(study, pos, L.market(chainAt(24100, T), T), 24000, 'psc')[0].due, null);
});
