// Put back spread (bt/pbs.js on bt/mcc.js's runner): the chain search (loss limit after costs, ranks, the fixed
// shapes), the re-pick rule and the live trade's shape check.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../bt/pbs');
const { bsm } = require('../lib/pricing');
const { looksPbs, kindOfTrade } = require('../bt/mcclive');

const S = 25000;
const strikes = [];
for (let k = 21000; k <= 27000; k += 50) strikes.push(k);
// a model chain: Black-Scholes, 13 % at the money, puts dearer below (skew: IV points per 1 % under)
const price =
  (spot, days = 45, skew = 0.25) =>
  (t, k) =>
    Math.max(0.05, bsm(spot, k, days / 365, 0.13 + skew * Math.max(0, (spot - k) / spot), t === 'CE'));
const lot = 65;

test('the search: a back spread 1 × 2 + flies inside its loss stretch, within the loss limit after costs', () => {
  const p = P.merge();
  const r = P.pickLegs(S, p, strikes, price(S, 45, 0), lot);
  assert.ok(r.found && r.shape.hit);
  const k = Object.fromEntries(r.legs.map((l) => [l.role, l]));
  assert.equal(k.bsS.side, -1);
  assert.equal(k.bsS.lots, 1);
  assert.equal(k.bsL.lots, 2);
  assert.ok(k.bsL.strike < k.bsS.strike);
  // net one bought put; every strike distinct
  assert.equal(
    r.legs.reduce((s, l) => s + l.side * l.lots, 0),
    1,
  );
  assert.equal(new Set(r.legs.map((l) => l.strike)).size, r.legs.length);
  if (k.flyS) {
    const W = k.bsS.strike - k.bsL.strike;
    assert.ok(k.flyS.strike > k.bsL.strike - W && k.flyS.strike < k.bsS.strike, 'fly centre inside the loss stretch');
    assert.equal(k.flyS.lots, 2 * k.flyW.lots);
  }
  assert.ok(r.shape.worst >= -p.pick.maxLoss, `worst ${r.shape.worst}`);
  // the worst the search reports is the payoff's minimum over a fine grid (booked the same way)
  const f = P.figures(r.legs, S, p, (x) => price(S, 45, 0)('PE', x), lot);
  let min = Infinity;
  for (let x = 18000; x <= 28000; x += 5) min = Math.min(min, f.at(x));
  assert.ok(Math.abs(min - r.shape.worst) <= 1, `${min} vs ${r.shape.worst}`);
});

test('the loss limit trades protection for cost; with none reachable the least loss is taken', () => {
  const pr = price(S);
  const tight = P.pickLegs(S, P.merge({ pick: { maxLoss: 1000 } }), strikes, pr, lot);
  const loose = P.pickLegs(S, P.merge({ pick: { maxLoss: 10000 } }), strikes, pr, lot);
  assert.ok(loose.shape.protect >= tight.shape.protect);
  assert.ok(tight.shape.worst >= -1000 || !tight.shape.hit);
  const zero = P.pickLegs(S, P.merge({ pick: { maxLoss: 0 } }), strikes, pr, lot);
  assert.equal(zero.shape.hit, false); // no free lunch at model prices
  assert.ok(zero.shape.worst < 0);
  const byLoss = P.pickLegs(S, P.merge({ pick: { maxLoss: 0, rank: 'loss' } }), strikes, pr, lot);
  assert.ok(byLoss.shape.worst >= zero.shape.worst - 1);
});

test('no flies allowed: the back spread alone; fixed shapes', () => {
  const pr = price(S);
  const r = P.pickLegs(S, P.merge({ pick: { flies: 0 } }), strikes, pr, lot);
  assert.deepEqual(r.legs.map((l) => l.role).sort(), ['bsL', 'bsS']);
  const ideas = P.pickLegs(S, P.merge({ pick: { mode: 'ideas' } }), strikes, pr, lot);
  assert.deepEqual(
    ideas.legs.map((l) => [l.role, l.strike, l.lots]),
    [
      ['bsS', 24900, 1],
      ['bsL', 24700, 2],
      ['flyW', 24500, 2],
      ['flyS', 24800, 4],
      ['flyU', 25100, 2],
    ],
  );
  const put = P.pickLegs(S, P.merge({ pick: { mode: 'put' } }), strikes, pr, lot);
  assert.deepEqual(
    put.legs.map((l) => [l.role, l.side, l.strike]),
    [['pL', 1, 24700]],
  );
});

test('re-pick: due at the move, in the allowed direction, not when holding to expiry', () => {
  const p = P.merge();
  const pos = P.newPosition('2026-12-29', S);
  const book = { slip: 0.005, brokerage: 20, taxes: false, lot, day: null, cash: 0, costs: 0 };
  assert.ok(P.openLegs(pos, P.pickLegs(S, p, strikes, price(S), lot).legs, price(S), book, {}));
  const up = S * 1.021;
  const ctx = (x) => ({ daysLeft: 10, strikes, px: (l) => price(x, 35)(l.type, l.strike) });
  assert.deepEqual(P.decide(pos, S * 1.01, ctx(S * 1.01), p), []);
  const [a] = P.decide(pos, up, ctx(up), p);
  assert.equal(a.kind, 'repick');
  assert.equal(a.close.length, pos.legs.length);
  assert.ok(Math.max(...a.open.map((l) => l.strike)) > Math.max(...pos.legs.map((l) => l.strike)), 'protection moved up');
  assert.equal(P.preload(pos, up, ctx(up), p).length > 0, true);
  assert.deepEqual(P.decide(pos, up, ctx(up), P.merge({ adj: { on: false } })), []);
  assert.deepEqual(P.decide(pos, up, ctx(up), P.merge({ adj: { dir: 'down' } })), []);
  assert.deepEqual(P.decide(pos, up, { ...ctx(up), daysLeft: 2 }, p), []);
  assert.deepEqual(P.preload(pos, S, ctx(S), p), []);
  // the runner applies it: refs and counts move on
  assert.ok(P.apply(pos, a, price(up, 35), book, {}));
  assert.equal(pos.refPut, up);
  assert.equal(pos.n.put, 1);
});

test('a saved trade of puts only, more bought than sold, is a Put back spread', () => {
  const L = (side, strike, lots) => ({ type: 'PE', side, strike, lots });
  assert.ok(looksPbs([L(-1, 24900, 1), L(1, 24700, 2), L(1, 24500, 2), L(-1, 24800, 4), L(1, 25100, 2)]));
  assert.ok(!looksPbs([L(-1, 24900, 1), L(1, 24700, 1)]));
  assert.ok(!looksPbs([{ type: 'CE', side: -1, strike: 25100, lots: 1 }, L(1, 24900, 1), L(-1, 24800, 1)]));
  const t = {
    snap: {
      legs: [
        { type: 'PE', action: 'S', strike: 24900, lots: 1, open: true },
        { type: 'PE', action: 'B', strike: 24700, lots: 2, open: true },
      ],
    },
  };
  assert.equal(kindOfTrade(t), 'pbs');
});

test('model path runs with the search on a Black-Scholes chain', () => {
  const r = P.runPbsModel({}, { S0: 25000, pct: -10, months: 3, iv: 13 });
  assert.equal(r.withAdj.length, 3);
  assert.ok(r.withAdj.every((m) => Number.isFinite(m.opt) && m.held.length > 0));
});

test('Suggestion: the best back spreads on a chain, within the options loss limit, one per sold put', () => {
  const { market, bestBackSpreads } = require('../bt/mcclive');
  const pr = price(S, 45, 0);
  const rows = strikes.map((k) => {
    const q = (t) => {
      const v = Math.round(pr(t, k) * 20) / 20;
      return { ltp: v, bid: v * 0.995, ask: v * 1.005, vol: 1000 };
    };
    return { strike: k, ce: q('CE'), pe: q('PE') };
  });
  const M = market({ spot: S, rows }, 45 / 365);
  const plan = P.pickLegs(S, P.merge(), strikes, (t, k) => M.px(t, k), lot);
  const r = bestBackSpreads(M, {
    lot,
    beesQty: 6500,
    beesPx: S / 100,
    expiry: '2027-01-07',
    maxLoss: 2500,
    params: P.merge(),
    fixed: { g: plan.shape, open: plan.legs },
  });
  assert.equal(r.shape, 'pbs');
  assert.ok(r.within > 0 && r.list.length === 5);
  for (const v of r.list) {
    assert.equal(Boolean(v.over), v.optWorst < -2500, `worst ${v.optWorst}`);
    assert.ok(v.legs.every((l) => l.type === 'PE'));
    assert.ok(v.grid.length > 5);
  }
  assert.equal(new Set(r.list.map((v) => v.shape.K1)).size, 5, 'different sold puts');
  // within the limit first, ranked by the options on falls; then the least loss
  const inn = r.list.filter((v) => !v.over);
  assert.deepEqual(r.list.slice(0, inn.length), inn);
  for (let i = 1; i < inn.length; i++) assert.ok(inn[i - 1].downOpt >= inn[i].downOpt - 1e-6);
  const out = r.list.filter((v) => v.over);
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].optWorst >= out[i].optWorst - 1e-6);
  assert.ok(r.rules && !r.rules.missing && r.rules.rules);
  // a limit nothing meets: the least loss first
  const z = bestBackSpreads(M, { lot, beesQty: 6500, beesPx: S / 100, expiry: '2027-01-07', maxLoss: 0, params: P.merge() });
  assert.equal(z.within, 0);
  assert.ok(z.list[0].optWorst >= z.list[1].optWorst);
});
