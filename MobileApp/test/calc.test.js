// Unit tests for the calculations that run on the phone. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { price, greeks, impliedVol, intrinsic } from '../www/js/bs.js';
import { ist, istTime, marketOpen, tokenExpiry, daysTo, yearsTo, sessionDate } from '../www/js/time.js';
import { orders, rates } from '../www/js/costs.js';
import { atmStrike, pcr, maxPain, supportResistance, mark, monthlyExpiries, collarExpiry, around } from '../www/js/analytics.js';
import { optionsAtExpiry, analyse, grid, collarLegs, beesUnits, netPremium, tradeCosts, valuePosition, beesPnl } from '../www/js/strategy.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('Black-Scholes: put-call parity and textbook value', () => {
  const S = 100;
  const K = 100;
  const T = 1;
  const v = 0.2;
  const r = 0.05;
  near(price('CE', S, K, T, v, r), 10.4506, 1e-3, 'call');
  near(price('PE', S, K, T, v, r), 5.5735, 1e-3, 'put');
  near(price('CE', S, K, T, v, r) - price('PE', S, K, T, v, r), S - K * Math.exp(-r * T), 1e-6, 'parity');
  assert.equal(price('CE', 120, 100, 0, 0.2), 20);
  assert.equal(intrinsic('PE', 90, 100), 10);
});

test('Greeks have the right signs and implied vol inverts the price', () => {
  const g = greeks('PE', 25000, 25000, 30 / 365, 0.14);
  assert.ok(g.delta < 0 && g.delta > -1);
  assert.ok(g.gamma > 0 && g.theta < 0 && g.vega > 0);
  const px = price('CE', 25000, 25300, 20 / 365, 0.13);
  near(impliedVol('CE', px, 25000, 25300, 20 / 365), 0.13, 1e-4, 'iv');
  assert.equal(impliedVol('CE', 0, 25000, 25300, 0.1), null);
});

test('IST time helpers', () => {
  const t = Date.UTC(2026, 10, 11, 4, 0); // 09:30 IST Wed 11 Nov 2026
  assert.equal(ist(t).date, '2026-11-11');
  assert.equal(ist(t).mins, 9 * 60 + 30);
  assert.ok(marketOpen(t));
  assert.ok(!marketOpen(Date.UTC(2026, 10, 11, 10, 5))); // 15:35 IST
  assert.ok(!marketOpen(Date.UTC(2026, 10, 14, 5, 0))); // Saturday
  assert.equal(tokenExpiry(t), istTime('2026-11-12', 3, 30));
  assert.equal(tokenExpiry(Date.UTC(2026, 10, 10, 21, 0)), istTime('2026-11-11', 3, 30)); // 02:30 IST
  assert.equal(daysTo('2026-11-17', t), 6);
  assert.equal(daysTo('2026-11-11', t), 0);
  near(yearsTo('2026-11-11', t), (6 * 60) / (365 * 1440), 1e-9);
  assert.equal(sessionDate(Date.UTC(2026, 10, 16, 2, 0)), '2026-11-13'); // Mon 07:30 IST → Fri
});

test('charges follow the schedule', () => {
  assert.equal(rates('2026-05-01').stt, 0.0015);
  assert.equal(rates('2025-01-01').stt, 0.001);
  // ₹1 L sold, ₹1 L bought, 2 orders on 2026-11-11
  const c = orders({ buy: 100000, sell: 100000, n: 2, day: '2026-11-11' });
  const fees = 200000 * (0.0003503 + 0.000001);
  near(c, 40 + 150 + fees + 0.18 * (40 + fees) + 3, 1e-6);
});

const side = (oi, ltp, bid, ask, iv = 14) => ({ oi, prevOi: oi, ltp, bid, ask, iv, key: 'k' + ltp });
const CHAIN = {
  expiry: '2026-11-24',
  spot: 25930,
  rows: [25700, 25750, 25800, 25850, 25900, 25950, 26000, 26050, 26100].map((k, i) => ({
    strike: k,
    ce: side([10, 20, 30, 40, 50, 60, 90, 70, 40][i], Math.max(5, 300 - i * 40), Math.max(5, 299 - i * 40), Math.max(5, 301 - i * 40)),
    pe: side([80, 60, 50, 40, 30, 20, 10, 10, 5][i], Math.max(5, 40 + i * 40), Math.max(5, 39 + i * 40), Math.max(5, 41 + i * 40)),
  })),
};

test('chain analytics', () => {
  assert.equal(atmStrike(CHAIN.rows, 25930), 25950);
  near(pcr(CHAIN.rows), 305 / 410, 1e-9);
  assert.deepEqual(supportResistance(CHAIN.rows), { support: 25700, resistance: 26000 });
  const mp = maxPain(CHAIN.rows);
  assert.ok(mp >= 25700 && mp <= 26100);
  assert.equal(around(CHAIN.rows, 25930, 2).map((r) => r.strike).join(), '25850,25900,25950,26000,26050');
});

test('mark: mid when tight, LTP inside a wide quote', () => {
  assert.equal(mark({ bid: 100, ask: 101, ltp: 99 }), 100.5);
  assert.equal(mark({ bid: 100, ask: 130, ltp: 140 }), 130);
  assert.equal(mark({ bid: null, ask: null, ltp: 12 }), 12);
  assert.equal(mark(null), null);
});

test('monthly expiry selection for the collars', () => {
  const ex = ['2026-11-17', '2026-11-24', '2026-12-01', '2026-12-29', '2027-01-26'];
  assert.deepEqual(monthlyExpiries(ex), ['2026-11-24', '2026-12-29', '2027-01-26']);
  const now = Date.UTC(2026, 10, 11, 4, 0);
  assert.equal(collarExpiry(ex, now), '2026-12-29'); // Nov series has 13 days left (< 15)
  assert.equal(collarExpiry(ex, Date.UTC(2026, 10, 2, 4, 0)), '2026-11-24'); // 22 days left
});

test('payoff, breakevens and extremes of a bull call spread', () => {
  const legs = [
    { type: 'CE', strike: 25900, side: 1, lots: 1, entry: 150 },
    { type: 'CE', strike: 26000, side: -1, lots: 1, entry: 100 },
  ];
  const pts = grid(25500, 26400, 91).map((S) => [S, optionsAtExpiry(legs, S, 65)]);
  const a = analyse(pts);
  near(a.maxProfit, 50 * 65, 1e-6);
  near(a.maxLoss, -50 * 65, 1e-6);
  assert.deepEqual(a.breakevens, [25950]);
  assert.equal(a.profitOpen, false);
  assert.equal(a.lossOpen, false);
});

test('collar legs: put spread collar buys the upper put, bull put collar sells it', () => {
  const psc = collarLegs('psc', CHAIN, {});
  assert.deepEqual(
    psc.map((l) => [l.type, l.strike, l.side]),
    [
      ['CE', 26050, -1],
      ['PE', 25850, 1],
      ['PE', 25750, -1],
    ],
  );
  const bpc = collarLegs('bpc', CHAIN, {});
  assert.deepEqual(
    bpc.map((l) => l.side),
    [-1, -1, 1],
  );
  assert.ok(psc.every((l) => l.entry > 0 && l.iv === 0.14));
  near(netPremium(psc, 65), (psc[0].entry - psc[1].entry + psc[2].entry) * 65, 1e-9);
});

test('NIFTYBEES units: one lot of Nifty, or the budget', () => {
  assert.equal(beesUnits(26000, 290, 65, 1), Math.round((65 * 26000) / 290));
  assert.equal(beesUnits(26000, 290, 65, 1, 100000), 344);
  assert.equal(beesUnits(26000, 0, 65), 0);
  near(beesPnl({ units: 100, entry: 290, spot0: 26000 }, 26260), 100 * 290 * 0.01, 1e-9);
});

test('valuing a position: marks, ETF, costs on both sides; expired legs at intrinsic', () => {
  const legs = [{ type: 'CE', strike: 26000, side: -1, lots: 1, entry: 100 }];
  const pos = { expiry: '2026-11-24', lotSize: 65, legs, bees: { units: 100, entry: 290, spot0: 25900 }, costsIn: 50 };
  const now = Date.UTC(2026, 10, 11, 4, 0);
  const v = valuePosition(pos, { chain: CHAIN, spot: 25930, beesPx: 291, now });
  near(v.options, (100 - 60) * 65, 1e-9); // 26000 CE mid = 60
  near(v.bees, 100, 1e-9);
  assert.ok(v.costsOut > 0);
  near(v.net, v.options + v.bees - 50 - v.costsOut, 1e-9);
  const after = valuePosition(pos, { chain: null, spot: 26100, beesPx: null, now: Date.UTC(2026, 10, 25, 4, 0) });
  assert.equal(after.expired, true);
  near(after.options, (100 - 100) * 65, 1e-9);
  assert.equal(after.costsOut, 0);
  const c = tradeCosts(legs, 65, { slipPct: 0.5, brokerage: 20 }, now);
  near(c.slippage, 100 * 65 * 0.005, 1e-9);
});
