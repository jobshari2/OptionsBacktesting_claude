// The collar's Live trade on the phone (www/js/live.js) and closed legs. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceLegs, pnlNow, moveGrid, beesCover, MOVES } from '../www/js/live.js';
import { valuePosition, optionsAtExpiry, collarLegs, legMarks } from '../www/js/strategy.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
const side = (ltp, bid, ask, iv = 14) => ({ ltp, bid, ask, iv, key: 'k' + ltp });
// LTPs deliberately away from the bid/ask mid, to tell them apart
const CHAIN = {
  expiry: '2026-11-24',
  spot: 25930,
  rows: [25700, 25800, 25900, 26000, 26100].map((k, i) => ({ strike: k, ce: side(260 - i * 50, 250 - i * 50, 256 - i * 50), pe: side(30 + i * 50, 20 + i * 50, 26 + i * 50) })),
};
const NOW = Date.UTC(2026, 10, 11, 5, 0); // 10:30 IST
const LOT = 65;
const LEGS = [
  { type: 'CE', strike: 26000, side: -1, lots: 1, entry: 120 },
  { type: 'PE', strike: 25800, side: 1, lots: 1, entry: 90 },
  { type: 'PE', strike: 25700, side: -1, lots: 1, entry: 50 },
];

test('collar legs and marks use the LTP, not the bid/ask mid', () => {
  const legs = collarLegs('psc', CHAIN, { ceOff: 100, peOff: 100, gap: 100 });
  assert.deepEqual(
    legs.map((l) => [l.strike, l.entry]),
    [
      [26000, 110],
      [25800, 80],
      [25700, 30],
    ],
  );
  assert.deepEqual(legMarks(LEGS, CHAIN, 25930, false), [110, 80, 30]);
});

test('P&L now by structure, at LTP; a closed leg counts with its booked P&L', () => {
  const legs = priceLegs(LEGS, CHAIN, 25930, CHAIN.expiry, NOW);
  const n = pnlNow(legs, LOT, { units: 100, entry: 290, now: 292 });
  near(n.call, (120 - 110) * LOT, 1e-9);
  near(n.put, (80 - 90) * LOT + (50 - 30) * LOT, 1e-9);
  near(n.bees, 200, 1e-9);
  near(n.total, n.opt + 200, 1e-9);
  const closed = priceLegs([{ ...LEGS[0], exit: 100 }, ...LEGS.slice(1)], CHAIN, 25930, CHAIN.expiry, NOW);
  near(pnlNow(closed, LOT, null).call, 20 * LOT, 1e-9);
  // no price for a strike: that structure has no P&L
  const none = pnlNow(priceLegs([{ ...LEGS[0], strike: 26500 }], CHAIN, 25930, CHAIN.expiry, NOW), LOT, null);
  assert.equal(none.call, null);
  assert.equal(none.total, null);
});

test('move grid: rows from the start, the Now row equals the P&L now, expiry at intrinsic', () => {
  const legs = priceLegs(LEGS, CHAIN, 25930, CHAIN.expiry, NOW);
  const bees = { units: 5800, entry: 288, now: 290 };
  const rows = moveGrid({ legs, lot: LOT, expiry: CHAIN.expiry, spot: 25930, entrySpot: 25800, bees, now: NOW });
  assert.equal(rows.length, MOVES.length * 2 + 2); // ± moves, the start, Nifty now
  const nowRow = rows.find((r) => r.mark === 'now');
  const n = pnlNow(legs, LOT, bees);
  near(nowRow.totalToday, n.total, 1, 'today at Nifty now = P&L now (each leg fitted to its LTP)');
  const start = rows.find((r) => r.mark === 'entry');
  assert.equal(start.x, 25800);
  near(start.beesPx, 288, 1e-9);
  const up = rows.find((r) => Math.abs(r.m - 5) < 1e-9);
  near(up.opt, optionsAtExpiry(LEGS, 25800 * 1.05, LOT), 1e-6);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].x >= r.x), 'highest Nifty first');
});

test('NIFTYBEES cover: units per point and the minimum that keeps the upside from losing', () => {
  const legs = priceLegs(LEGS, CHAIN, 25930, CHAIN.expiry, NOW);
  const c = beesCover({ legs, lot: LOT, spot: 25930, bees: { units: 0, entry: 0, now: 290 } });
  assert.equal(c.netShortLots, 1);
  near(c.slopeUnits, (65 * 25930) / 290, 1e-6);
  assert.ok(c.minUnits >= Math.floor(c.slopeUnits));
  for (const pc of [0, 1, 5, 20]) assert.ok(c.at(25930 * (1 + pc / 100), c.minUnits) >= -1e-6, `no loss at +${pc} %`);
  assert.ok(c.at(25930 * 1.2, c.minUnits - 50) < 0 || c.at(25930, c.minUnits - 50) < 0 || c.minUnits - 50 < c.slopeUnits);
  assert.equal(beesCover({ legs: legs.slice(1), lot: LOT, spot: 25930, bees: null }), null, 'no sold call: nothing to cover');
});

test('valuing a closed trade: legs and NIFTYBEES at their exits, closing costs counted', () => {
  const legs = LEGS.map((l) => ({ ...l, exit: l.entry - 10 }));
  const pos = { expiry: CHAIN.expiry, lotSize: LOT, legs, bees: { units: 100, entry: 290, spot0: 25800, exit: 295 }, costsIn: 40 };
  const v = valuePosition(pos, { chain: null, spot: 26500, beesPx: 300, now: NOW });
  near(v.options, (10 - 10 + 10) * LOT, 1e-9);
  near(v.bees, 500, 1e-9);
  assert.deepEqual(v.marks, [110, 80, 40]);
  assert.ok(v.costsOut > 0);
});
