// Modified covered call (bt/mcc.js, mccpaper.js): the opening legs, the roll rules (sold strikes only, the put cap,
// the whole-spread variant, up-market extras, the last-days window), fills / settlement, and the paper trade's calendar helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../bt/mcc');
const { monthlyFor, weekdaysLeft } = require('../mccpaper');

const strikes = [];
for (let k = 22000; k <= 27000; k += 50) strikes.push(k);
const book = () => ({ slip: 0, brokerage: 0, taxes: false, lot: 65, day: '2026-01-05', cash: 0, costs: 0 });
const flat = () => 100;
function opened(S, over = {}) {
  const p = M.deepMerge(M.merge(), over);
  const pos = M.newPosition('2026-01-27', S);
  assert.ok(M.openLegs(pos, M.legsAt(S, p, strikes), flat, book(), { day: '2026-01-02', time: '09:30' }));
  return { p, pos };
}
const strikeOf = (pos, role) => pos.legs.find((l) => l.role === role)?.strike;

test('opening legs: call ratio 1×2 and put 2-3-1 around ATM', () => {
  const legs = M.legsAt(24020, M.merge(), strikes);
  assert.deepEqual(
    legs.map((l) => [l.role, l.side, l.type, l.strike, l.lots]),
    [
      ['ceL', 1, 'CE', 24100, 1],
      ['ceS', -1, 'CE', 24200, 2],
      ['peL', 1, 'PE', 23900, 2],
      ['peS', -1, 'PE', 23700, 3],
      ['peW', 1, 'PE', 23600, 1],
    ],
  );
});

test('put side is defined risk: 3 bought against 3 sold, payoff never below the premium paid', () => {
  const { pos } = opened(24000);
  const puts = pos.legs.filter((l) => l.type === 'PE');
  // every put priced 100: premiums net to zero (−2 + 3 − 1), so the payoff is the intrinsic alone, never negative
  for (let x = 20000; x <= 26000; x += 50) assert.ok(M.payoffAt(puts, x, 65) >= 0);
  // deep under the wing: 2·23900 − 3·23700 + 23600 = 300 pts of intrinsic left
  assert.equal(M.payoffAt(puts, 20000, 65), 300 * 65);
});

test('market up 2 %: sold puts move up, capped at the bought put strike', () => {
  const { p, pos } = opened(24000);
  const acts = M.decide(pos, 24480, { daysLeft: 10, strikes, px: () => 50 }, p);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].kind, 'rollPut');
  // new ATM 24500 − 300 = 24200, above the bought 23900 PE: capped there
  assert.equal(acts[0].open[0].strike, 23900);
  assert.ok(M.apply(pos, acts[0], () => 80, book(), { day: '2026-01-06', time: '15:00' }));
  assert.equal(strikeOf(pos, 'peS'), 23900);
  assert.equal(pos.refPut, 24480);
  assert.equal(pos.n.put, 1);
  // capped: a further rise has nowhere higher to go
  assert.equal(M.decide(pos, 25000, { daysLeft: 9, strikes, px: () => 20 }, p).filter((a) => a.kind === 'rollPut').length, 0);
});

test('market down 2 %: sold calls move down, never under the bought call', () => {
  const { p, pos } = opened(24000);
  const acts = M.decide(pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(
    acts.map((a) => [a.kind, a.open[0].strike]),
    [['rollCall', 24100]], // 23500 + 200 = 23700, floored at the bought 24100 CE
  );
});

test('no move big enough, and no rolls in the last days', () => {
  const { p, pos } = opened(24000);
  assert.equal(M.decide(pos, 24300, { daysLeft: 10, strikes, px: flat }, p).length, 0);
  assert.equal(M.decide(pos, 24800, { daysLeft: 2, strikes, px: flat }, p).length, 0);
});

test('whole-spread variant moves the bought legs too, keeping the shape', () => {
  const { p, pos } = opened(24000, { adj: { legs: 'all' } });
  const [a] = M.decide(pos, 24500, { daysLeft: 10, strikes, px: flat }, p);
  assert.equal(a.kind, 'rollPut');
  assert.deepEqual(
    a.open.map((l) => [l.role, l.strike, l.lots]),
    [
      ['peL', 24400, 2],
      ['peS', 24200, 3],
      ['peW', 24100, 1],
    ],
  );
  assert.equal(a.close.length, 3);
});

test('up-market extras: roll the ratio up, buy one call back, or buy a hedge call', () => {
  const roll = opened(24000, { adj: { on: false }, up: { mode: 'roll' } });
  const [r] = M.decide(roll.pos, 24210, { daysLeft: 10, strikes, px: flat }, roll.p);
  assert.equal(r.kind, 'upRoll');
  assert.deepEqual(
    r.open.map((l) => [l.role, l.strike, l.lots]),
    [
      ['ceL', 24300, 1],
      ['ceS', 24400, 2],
    ],
  );

  const buy = opened(24000, { adj: { on: false }, up: { mode: 'buyBack' } });
  const [b] = M.decide(buy.pos, 24210, { daysLeft: 10, strikes, px: flat }, buy.p);
  assert.equal(b.kind, 'buyBack');
  assert.equal(b.close[0].lots, 1);
  M.apply(buy.pos, b, flat, book(), { day: '2026-01-06', time: '15:00' });
  assert.equal(buy.pos.legs.find((l) => l.role === 'ceS').lots, 1);
  assert.equal(M.decide(buy.pos, 24400, { daysLeft: 9, strikes, px: flat }, buy.p).length, 0);

  const h = opened(24000, { adj: { on: false }, up: { mode: 'hedge' } });
  const [x] = M.decide(h.pos, 24210, { daysLeft: 10, strikes, px: flat }, h.p);
  assert.deepEqual([x.kind, x.open[0].strike, x.open[0].lots, x.open[0].side], ['upHedge', 24400, 1, 1]);
});

test('decay trigger rolls a sold leg once it is worth the set share of its premium', () => {
  const { p, pos } = opened(24000, { adj: { trigger: 'decay', decayPct: 35 } });
  const peS = pos.legs.find((l) => l.role === 'peS');
  // spot unchanged: the same-distance strike is the one held, so nothing to roll into
  assert.equal(M.decide(pos, 24000, { daysLeft: 10, strikes, px: () => 30 }, p).length, 0);
  const acts = M.decide(pos, 24200, { daysLeft: 10, strikes, px: (l) => (l.id === peS.id ? 30 : 100) }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollPut'],
  );
});

test('fills, costs and settlement: cash adds up to the payoff at expiry', () => {
  const { pos } = opened(24000);
  const b = book();
  const legs = pos.legs.map((l) => ({ ...l }));
  // re-open on a fresh book to track the cash of these legs only
  const pos2 = M.newPosition('2026-01-27', 24000);
  M.openLegs(pos2, M.legsAt(24000, M.merge(), strikes), flat, b, { day: '2026-01-02', time: '09:30' });
  M.settle(pos2, 24150, b, { day: '2026-01-27', time: '15:30' });
  assert.equal(Math.round(b.cash), Math.round(M.payoffAt(legs, 24150, 65)));
  assert.equal(pos2.legs.length, 0);
  // slippage: buys fill higher, sells lower
  const s = { ...book(), slip: 0.005 };
  assert.equal(M.fill(s, 1, 100, 65).toFixed(4), '100.5000');
  assert.equal(M.fill(s, -1, 100, 65).toFixed(4), '99.5000');
});

test('paper trade calendar: monthly expiry is the last of its month; weekdays left', () => {
  const ex = ['2026-10-27', '2026-11-03', '2026-11-09', '2026-11-17', '2026-11-23', '2026-12-01', '2026-12-29'];
  assert.equal(monthlyFor(ex, '2026-10-24'), '2026-10-27');
  assert.equal(monthlyFor(ex, '2026-10-27'), '2026-11-23'); // on the expiry day itself: next month's
  // fewer than 15 calendar days to this month's expiry: next month's series (the user's rule)
  assert.equal(monthlyFor(ex, '2026-10-24', 15), '2026-11-23', '3 days left');
  assert.equal(monthlyFor(ex, '2026-10-12', 15), '2026-10-27', '15 days left: this month');
  assert.equal(monthlyFor(ex, '2026-10-13', 15), '2026-11-23', '14 days left');
  assert.equal(M.DEFAULTS.minDays, 15);
  assert.equal(weekdaysLeft('2026-10-23', '2026-10-27'), 2); // Mon, Tue
});

test('call ratio and butterfly P&L add up to the options total, costs included', () => {
  const p = M.merge();
  const b = { slip: 0.005, brokerage: 20, taxes: true, lot: 65, day: '2026-01-05', cash: 0, costs: 0, costsBy: { CE: 0, PE: 0 } };
  const pos = M.newPosition('2026-01-27', 24000);
  M.openLegs(pos, M.legsAt(24000, p, strikes), (t, k) => (t === 'CE' ? Math.max(5, 24150 - k) : Math.max(5, k - 23850)), b, { day: '2026-01-05' });
  const [a] = M.decide(pos, 24500, { daysLeft: 10, strikes, px: () => 20 }, p);
  M.apply(pos, a, () => 30, b, { day: '2026-01-08' });
  M.settle(pos, 24300, b, { day: '2026-01-27' });
  const { call, put } = M.splitPnl(pos.closed, b);
  assert.ok(Math.abs(call + put - (b.cash - b.costs)) <= 1);
  assert.ok(b.costsBy.CE > 0 && b.costsBy.PE > 0);
});

test('model path: months enter afresh, end on the trend, and run with and without rolls', () => {
  const path = M.modelPath({ S0: 24000, pct: 10, months: 6, swings: true });
  assert.equal(path.length, 6);
  assert.ok(Math.abs(path[5][21] - 26400) < 1);
  const r = M.runMccModel({}, { S0: 24000, pct: -12, months: 6 });
  assert.equal(r.withAdj.length, 6);
  assert.equal(
    r.without.every((m) => m.adjustments === 0),
    true,
  );
  for (const m of r.withAdj) assert.ok(Math.abs(m.callPnl + m.putPnl - m.opt) <= 1);
});

// ---------- the ideal trade: a flat zone of params.target.amount ----------
const { bsm } = require('../lib/pricing');
// a monthly series: 20 trading days left, 13 % IV, Nifty 24,800
const bsPrice = (S) => (type, K) => Math.max(0.05, bsm(S, K, 20 / 252, 0.13, type === 'CE'));
test('ideal trade: strikes and gaps picked so the flat zone is the target, the downside never under it, the upside loss as far up as it can', () => {
  const S = 24800;
  const p = M.merge();
  assert.deepEqual(p.target, { on: true, amount: 15000 }, 'on by default, ₹15,000');
  const pick = M.pickLegs(S, p, strikes, bsPrice(S), 65);
  const s = pick.shape;
  assert.ok(s.hit, 'reachable');
  assert.ok(Math.abs(s.flat - 15000) <= 750, `flat zone ${s.flat}`);
  assert.ok(s.minDown >= s.flat - 1 && s.tail >= s.flat - 1, `downside ${s.minDown}, tail ${s.tail}, flat ${s.flat}`);
  // the flat zone is the P&L at expiry with every option worthless: booked exactly as the backtest books it
  const pos = M.newPosition('x', S);
  const b = { slip: p.costs.slipPct / 100, brokerage: p.costs.brokerage, taxes: p.costs.taxes, lot: 65, day: null, cash: 0, costs: 0 };
  assert.ok(M.openLegs(pos, pick.legs, bsPrice(S), b, {}));
  assert.equal(Math.round(b.cash - b.costs), s.flat);
  const k = Object.fromEntries(pick.legs.map((l) => [l.role, l.strike]));
  assert.ok(k.peW < k.peS && k.peS < k.peL && k.peL <= 24800 && 24800 <= k.ceL && k.ceL < k.ceS, JSON.stringify(k));
  // the month's parameters carry the shape, so its rolls keep it
  assert.equal(pick.p.ce.buyOff, s.ce.buyOff);
  assert.deepEqual(M.withShape(p, s).pe, { ...p.pe, ...s.pe });
  assert.equal(M.withShape(p, null), p);
  // every shape of the search booked exactly: none within 5 % with the downside never under its flat zone starts its
  // upside loss higher
  const intr = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
  const B = [0, 50, 100, 150, 200, 250, 300, 350, 400];
  const G = [50, 100, 150, 200, 250, 300];
  let bestUp = -Infinity;
  for (const cb of B)
    for (const cg of G)
      for (const pb of B)
        for (const pg of G)
          for (const wg of G) {
            const legs = M.legsAt(S, M.deepMerge(p, { ce: { buyOff: cb, sellGap: cg }, pe: { buyOff: pb, sellGap: pg, wingGap: wg } }), strikes);
            const bk = { ...b, cash: 0, costs: 0 };
            M.openLegs(M.newPosition('x', S), legs, bsPrice(S), bk, {});
            const f = bk.cash - bk.costs;
            if (Math.abs(f - 15000) > 750) continue;
            const at = (x) => f + legs.reduce((sum, l) => sum + l.side * intr(l, x) * l.lots * 65, 0);
            const lo = Math.min(...legs.map((l) => l.strike));
            if (Math.min(at(lo - 50), ...legs.filter((l) => l.strike <= S).map((l) => at(l.strike))) < f - 1) continue;
            const hi = Math.max(...legs.map((l) => l.strike));
            bestUp = Math.max(bestUp, hi + at(hi) / 65); // the call ratio loses 1 lot a point above its top strike
          }
  assert.equal(s.upBE, Math.round(bestUp), 'the best shape of the whole search');
  // target off: the fixed distances
  const off = M.pickLegs(S, M.deepMerge(p, { target: { on: false } }), strikes, bsPrice(S), 65);
  assert.equal(off.shape, null);
  assert.deepEqual(
    off.legs.map((l) => l.strike),
    M.legsAt(S, p, strikes).map((l) => l.strike),
  );
  assert.match(M.shapeText(s, 15000), /flat zone [\d,]+ ₹ \(target 15,000\)/);
});

test('ideal trade: an amount out of reach takes the closest shape, and says so', () => {
  const S = 24800;
  const pick = M.pickLegs(S, M.deepMerge(M.merge(), { target: { amount: 400000 } }), strikes, bsPrice(S), 65);
  assert.equal(pick.shape.hit, false);
  assert.match(M.shapeText(pick.shape, 400000), /not reachable/);
  assert.ok(pick.shape.minDown >= pick.shape.flat - 1, 'still the downside never under its flat zone');
  // two days before expiry the premiums cannot make ₹15,000: the largest flat zone that keeps the shape
  const late = (type, K) => Math.max(0.05, bsm(S, K, 2 / 252, 0.13, type === 'CE'));
  const l = M.pickLegs(S, M.merge(), strikes, late, 65).shape;
  assert.equal(l.hit, false);
  assert.ok(l.flat > 0 && l.minDown >= l.flat - 1, JSON.stringify(l));
  // no prices at all: the fixed distances
  const none = M.pickLegs(S, M.merge(), strikes, () => null, 65);
  assert.equal(none.shape, null);
  assert.deepEqual(
    none.legs.map((l) => l.strike),
    M.legsAt(S, M.merge(), strikes).map((l) => l.strike),
  );
});
