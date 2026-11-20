// Trading Ideas › Put back spread: NIFTYBEES worth one lot of Nifty (65 × Nifty, or a ₹ budget), as in the collars,
// plus on every monthly series (entered on its first trading day, held to the monthly expiry):
//   - a put back spread: sell 1 lot PE at K1, buy 2 lots PE at K2 = K1 − W (net one bought put: under K2 − W the
//     options gain point for point as Nifty falls, so the NIFTYBEES are hedged below there)
//   - 0, 1 or 2 put butterflies inside the back spread's loss stretch (K2 − W … K1, deepest at K2): buy n at C − h,
//     sell 2n at C, buy n at C + h. They pay exactly where the back spread loses.
// No sold call: the NIFTYBEES' upside stays open.
//
// The strikes are not fixed distances: at every entry (and every re-pick) the whole PE chain of that minute is
// searched — every K1 from ATM + top down to ATM − bottom, every width W, every fly centre inside the loss stretch,
// every fly half-width h and 0 … flies butterflies — each priced with 0.5 % slippage and charges, its OPTIONS-ONLY P&L
// at expiry checked at every Nifty level (the payoff bends only at strikes; under the lowest strike it rises, net one
// bought put). Kept: those whose worst options loss is within pick.maxLoss ₹ per lot. Ranked by pick.rank:
//   'protect' the most options P&L on Nifty falls of 2 / 4 / 6 / 8 / 10 % (how much of the NIFTYBEES' fall it pays back)
//   'loss'    the smallest worst-case options loss
//   'credit'  the most options P&L if Nifty stays or rises
// None within the limit: the smallest worst-case loss. At market prices a structure that never loses anywhere is not
// on offer (it would be free money), so maxLoss is the price paid for the protection, chosen by the user.
//
// Live › Ideas › Back spreads (lib/backspread.js) fixes the geometry (centre halfway between the strikes, 2 flies
// with wings at ± 1.5 W) and ranks by the loss alone, which pushes the trade to the edge of the strike window; here
// the flies are free, the floor is in ₹ after costs, and the rank is about what the trade is for: the NIFTYBEES.
// pick.mode 'ideas' rebuilds that fixed geometry (and 'put' a plain bought put) for the study's comparison.
//
// Adjustments (adj.on; off = hold to expiry): when Nifty has moved movePct % from the entry or the last re-pick (in
// the directions adj.dir allows), every option is closed and the search runs again at the new Nifty. The backtest,
// study, model path and paper trade are the Covered call's (bt/mcc.js runMcc / runMccStudy / runMccModel,
// mccpaper.js) driven by this file.
const Costs = require('../lib/costs');
const M = require('./mcc');

const { snap, atmOf } = M;
const STEP = 50;

const DEFAULTS = {
  lotSize: 65,
  lots: 1, // multiplier on every quantity below (and on the ETF)
  budget: 0, // ₹ of NIFTYBEES (0 = 65 × lots × Nifty worth); only the ETF's quantity and P&L change
  entryMin: 15, // minutes after 09:15 on the series' first day (09:30)
  minDays: 15, // paper trade: a series with fewer calendar days than this left is skipped for next month's
  bs: { sell: 1, buy: 2 }, // the back spread's ratio, lots per NIFTYBEES lot
  pick: {
    mode: 'search', // 'search' the chain | 'ideas' the Live Ideas geometry (fixed) | 'put' a plain bought put (fixed)
    maxLoss: 2500, // ₹ per lot: the worst options-only loss at expiry, after costs, any Nifty level
    rank: 'protect', // 'protect' | 'loss' | 'credit'
    top: 300, // the sold put K1 from ATM + top …
    bottom: 1000, // … down to ATM − bottom (points)
    widths: [100, 150, 200, 250, 300, 400], // back spread widths W tried
    wings: [50, 100, 150, 200, 250, 300, 400], // butterfly half-widths h tried
    flies: 2, // butterflies per lot tried: 0 … flies
    falls: [2, 4, 6, 8, 10], // % falls the 'protect' rank averages over
  },
  fixed: { sellOff: 100, width: 200, putOff: 300 }, // 'ideas': K1 = ATM − sellOff, W = width; 'put': bought PE at ATM − putOff
  adj: {
    on: true, // false: hold to expiry
    trigger: 'move',
    movePct: 2, // re-pick when Nifty has moved this % from the entry / the last re-pick
    dir: 'both', // 'both' | 'up' (only after rises) | 'down' (only after falls)
    check: 'close', // 'close': once a day at 15:00; 'hourly': 10:30 … 15:00
    lastDays: 3, // no re-picks in the last N trading days of the series
    maxPerSide: 3, // re-picks per month
  },
  up: { mode: 'none' }, // (the Covered call's up-market extras do not apply: no sold call)
  etf: 'model', // 'model' = ₹1 per 100 Nifty points (Nifty ÷ 100); 'real' = recorded NIFTYBEES prices
  costs: { slipPct: 0.5, brokerage: 20, taxes: true, etfSlipPct: 0.05 },
  target: { on: false, amount: 0 },
};
const NESTED = ['bs', 'pick', 'fixed', 'adj', 'up', 'costs'];
const merge = (p = {}) => {
  const out = { ...DEFAULTS, ...p };
  for (const k of NESTED) out[k] = { ...DEFAULTS[k], ...(p[k] || {}) };
  out.up = { mode: 'none' };
  out.target = { on: false, amount: 0 };
  return out;
};

const intr = (k, x) => Math.max(0, k - x); // a put's value at expiry
const ROLE = {
  bsS: 'Sell put (back spread)',
  bsL: 'Buy puts (back spread)',
  flyW: 'Buy put (fly, low wing)',
  flyS: 'Sell puts (fly centre)',
  flyU: 'Buy put (fly, high wing)',
  pL: 'Buy put',
};

// The legs of one structure. g: { K1, K2, nf, C, h } (nf 0: no flies) or { put } (a plain bought put). L: lots.
function legsOf(g, p, L = p.lots) {
  if (g.put != null) return [{ role: 'pL', type: 'PE', side: 1, strike: g.put, lots: L }];
  const out = [
    { role: 'bsS', type: 'PE', side: -1, strike: g.K1, lots: p.bs.sell * L },
    { role: 'bsL', type: 'PE', side: 1, strike: g.K2, lots: p.bs.buy * L },
  ];
  if (g.nf > 0)
    out.push(
      { role: 'flyW', type: 'PE', side: 1, strike: g.C - g.h, lots: g.nf * L },
      { role: 'flyS', type: 'PE', side: -1, strike: g.C, lots: 2 * g.nf * L },
      { role: 'flyU', type: 'PE', side: 1, strike: g.C + g.h, lots: g.nf * L },
    );
  return out.filter((l) => l.lots > 0);
}

// Options-only payoff at expiry, ₹, of legs with entry fills (l.entry) — or with flat (₹ after entry costs) instead.
const payAt = (legs, x, lot, flat = null) =>
  (flat ?? -legs.reduce((s, l) => s + l.side * l.entry * l.lots * lot, 0)) + legs.reduce((s, l) => s + l.side * intr(l.strike, x) * l.lots * lot, 0);

// The figures of a structure booked at prices pr(strike) (exactly: slippage, brokerage, taxes, and STT on bought puts
// finishing in the money): { flat (Nifty above every strike), worst, protect (avg on the falls), credit, lowBE, at(x) }.
function figures(legs, S, p, pr, lot, day = null) {
  const book = { slip: p.costs.slipPct / 100, brokerage: p.costs.brokerage, taxes: p.costs.taxes, lot, day, cash: 0, costs: 0 };
  if (!M.openLegs(M.newPosition('pick', S), legs, (t, k) => pr(k), book, {})) return null;
  const flat = book.cash - book.costs;
  const ex = (x) => (p.costs.taxes ? legs.reduce((s, l) => s + (l.side > 0 ? Costs.exercise(intr(l.strike, x) * l.lots * lot, day) : 0), 0) : 0);
  const at = (x) => payAt(legs, x, lot, flat) - ex(x);
  const ks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const pts = [...ks, ks[0] - 500, ks[ks.length - 1] + STEP];
  const worst = Math.min(...pts.map(at));
  const protect = p.pick.falls.reduce((s, f) => s + at(S * (1 - f / 100)), 0) / p.pick.falls.length;
  // the Nifty level under which the options are in profit again (the bought put's side), scanning down from the lowest strike
  let lowBE = null;
  for (let x = ks[0]; x > ks[0] - 5000; x -= 5)
    if (at(x) >= 0) {
      lowBE = x;
      break;
    }
  return { flat, worst, protect, credit: at(S), lowBE, at };
}

// Higher is better.
function score(f, rank) {
  if (rank === 'loss') return f.worst;
  if (rank === 'credit') return f.credit;
  return f.protect;
}

// Every strike the search may price for Nifty at S: [{ type, strike }].
function shapeStrikes(S, strikes, p = DEFAULTS) {
  const P = { ...DEFAULTS.pick, ...(p.pick || {}) };
  const A = atmOf(S);
  const hi = A + P.top + Math.max(...P.wings);
  const lo = A - P.bottom - 2 * Math.max(...P.widths) - Math.max(...P.wings);
  const fx = { ...DEFAULTS.fixed, ...(p.fixed || {}) };
  const loFixed = A - fx.sellOff - 2.5 * fx.width - 100;
  return (strikes || []).filter((k) => k <= hi && k >= Math.min(lo, loFixed, A - fx.putOff - 100)).map((strike) => ({ type: 'PE', strike }));
}

// Every structure of the search for Nifty at S, priced roughly from pr(strike) (null = not tradable): fills with
// slippage, brokerage per order, no taxes. [{ g: { K1, K2, nf, C, h }, f: { worst, credit, protect } }] (₹, options only
// at expiry). Shared by pickLegs and the Live trade tab's Suggestion (bt/mcclive.js bestBackSpreads).
function searchRough(S, p, pr, lot) {
  const A = atmOf(S);
  const P = p.pick;
  const slip = p.costs.slipPct / 100;
  const L = p.lots;
  const q = lot * L;
  const b = (k) => pr(k) * (1 + slip);
  const s = (k) => pr(k) * (1 - slip);
  const xs = P.falls.map((f) => S * (1 - f / 100));
  const rough = [];
  const brk = p.costs.brokerage;
  const add = (g, net, legsN) => {
    // payoff in points per unit at x; kinks at the strikes, rising under the lowest (net one bought put)
    const v = (x) => {
      let y = net - p.bs.sell * intr(g.K1, x) + p.bs.buy * intr(g.K2, x);
      if (g.nf) y += g.nf * (intr(g.C - g.h, x) - 2 * intr(g.C, x) + intr(g.C + g.h, x));
      return y;
    };
    const kinks = g.nf ? [g.K1, g.K2, g.C - g.h, g.C, g.C + g.h] : [g.K1, g.K2];
    const lo = Math.min(...kinks);
    let worst = Math.min(v(lo - 500), v(Math.max(...kinks) + STEP), ...kinks.map(v));
    const fees = legsN * brk;
    worst = worst * q - fees;
    const f = { worst, credit: v(S) * q - fees, protect: (xs.reduce((a, x) => a + v(x), 0) / xs.length) * q - fees };
    rough.push({ g, f });
  };
  for (let K1 = A + P.top; K1 >= A - P.bottom; K1 -= STEP) {
    if (!pr(K1)) continue;
    for (const W of P.widths) {
      const K2 = K1 - W;
      if (!pr(K2)) continue;
      const net = p.bs.sell * s(K1) - p.bs.buy * b(K2);
      add({ K1, K2, nf: 0 }, net, 2);
      for (let nf = 1; nf <= P.flies; nf++)
        for (let C = K2 - W + STEP; C < K1; C += STEP) {
          if (C === K2 || !pr(C)) continue;
          for (const h of P.wings) {
            const lo = C - h;
            const hi = C + h;
            if (lo === K1 || lo === K2 || hi === K1 || hi === K2 || !pr(lo) || !pr(hi)) continue;
            add({ K1, K2, nf, C, h }, net - nf * (b(lo) - 2 * s(C) + b(hi)), 5);
          }
        }
    }
  }
  return rough;
}

// The opening legs for Nifty at S, from prices price(type, strike) (null = no trade there) and the lot size.
//   { legs, p, shape: { mode, K1, K2, W, nf, C, h, put, flat, worst, protect, credit, lowBE, hit, n } | null, found }
// hit: within maxLoss; n: how many structures were priced. Nothing priced: the Live Ideas geometry, unpriced (the
// runner then reports the missing prices).
function pickLegs(S, p, strikes, price, lot = p.lotSize, day = null) {
  const A = atmOf(S);
  const list = [...(strikes || [])].sort((a, b) => a - b);
  const listed = new Set(list);
  const cache = new Map();
  const pr = (k) => {
    if (!cache.has(k)) {
      const v = listed.has(k) && price ? price('PE', k) : null;
      cache.set(k, v > 0 ? v : null);
    }
    return cache.get(k);
  };
  const fx = p.fixed;
  const ideasG = () => {
    const K1 = snap(list, A - fx.sellOff);
    const K2 = snap(list, K1 - fx.width);
    const m = snap(list, (K1 + K2) / 2);
    const W = K1 - K2;
    return { K1, K2, nf: 2, C: m, h: Math.round((1.5 * W) / STEP) * STEP };
  };
  const done = (g, f, hit, n) => ({
    legs: legsOf(g, p),
    p,
    found: Boolean(f),
    shape: f
      ? {
          mode: p.pick.mode,
          ...g,
          W: g.K1 != null ? g.K1 - g.K2 : null,
          flat: Math.round(f.flat),
          worst: Math.round(f.worst),
          protect: Math.round(f.protect),
          credit: Math.round(f.credit),
          lowBE: f.lowBE,
          hit,
          n,
          maxLoss: p.pick.maxLoss * p.lots,
          rank: p.pick.rank,
        }
      : null,
  });
  if (p.pick.mode === 'put') {
    const g = { put: snap(list, A - fx.putOff) };
    return done(g, figures(legsOf(g, p), S, p, pr, lot, day), true, 1);
  }
  if (p.pick.mode === 'ideas') {
    const g = ideasG();
    return done(g, figures(legsOf(g, p), S, p, pr, lot, day), true, 1);
  }

  // rough pass: fills with slippage, brokerage per order, no taxes (fast); the best are then booked exactly
  const P = p.pick;
  const L = p.lots;
  const floor = -P.maxLoss * L;
  const rough = searchRough(S, p, pr, lot);
  if (!rough.length) {
    const g = ideasG();
    return { legs: legsOf(g, p), p, shape: null, found: false };
  }
  // within the limit (a margin for the taxes the rough pass leaves out), best by the rank; else the least loss
  const margin = 150 * L;
  let pool = rough.filter((c) => c.f.worst >= floor - margin);
  const byRank = (a, c) => score(c.f, P.rank) - score(a.f, P.rank) || c.f.worst - a.f.worst;
  pool = pool.length ? pool.sort(byRank) : rough.sort((a, c) => c.f.worst - a.f.worst || score(c.f, P.rank) - score(a.f, P.rank));
  const exact = pool
    .slice(0, 60)
    .map((c) => ({ g: c.g, f: figures(legsOf(c.g, p), S, p, pr, lot, day) }))
    .filter((c) => c.f);
  const within = exact.filter((c) => c.f.worst >= floor);
  const best = within.length ? within.sort(byRank)[0] : exact.sort((a, c) => c.f.worst - a.f.worst || score(c.f, P.rank) - score(a.f, P.rank))[0];
  return done(best.g, best.f, within.length > 0, rough.length);
}
const withShape = (p) => p;
const inr = (v) => '₹' + Math.round(v).toLocaleString('en-IN');
const shapeText = (s) => {
  if (!s) return '';
  if (s.put != null) return `Bought ${s.put} PE: options at worst ${inr(s.worst)}`;
  const fly = s.nf ? `${s.nf}× fly ${s.C - s.h}/${s.C}/${s.C + s.h}` : 'no flies';
  const lim = s.mode === 'search' ? (s.hit ? ` (limit ${inr(-s.maxLoss)})` : ` (none within ${inr(-s.maxLoss)}: least loss)`) : '';
  return `Back spread ${s.K1}/${s.K2} (W ${s.W}), ${fly}: options worst ${inr(s.worst)}${lim}, if Nifty stays ${inr(s.credit)}, on falls ${inr(s.protect)}`;
};

// The re-pick is due: Nifty moved movePct % from the entry / last re-pick, in a direction adj.dir allows.
function due(pos, S, ctx, p) {
  if (!p.adj.on || !pos.legs.length || ctx.daysLeft < p.adj.lastDays || pos.n.put >= p.adj.maxPerSide) return null;
  const mv = (S / pos.refPut - 1) * 100;
  if (mv >= p.adj.movePct && p.adj.dir !== 'down') return mv;
  if (mv <= -p.adj.movePct && p.adj.dir !== 'up') return mv;
  return null;
}
// The runner loads these strikes' prices before decide() when a re-pick is due.
const preload = (pos, S, ctx, p) => (due(pos, S, ctx, p) == null ? [] : shapeStrikes(S, ctx.strikes, p));

// The adjustments due now (bt/mcc.js decide's contract): the whole structure closed and searched again at Nifty S.
function decide(pos, S, ctx, p) {
  const mv = due(pos, S, ctx, p);
  if (mv == null) return [];
  const pick = pickLegs(S, p, ctx.strikes, (t, k) => ctx.px({ type: t, strike: k }), p.lotSize, ctx.day || null);
  const why = `Nifty ${S.toFixed(0)} is ${Math.abs(mv).toFixed(1)} % ${mv > 0 ? 'above' : 'under'} the last pick (${pos.refPut.toFixed(0)})`;
  if (!pick.found) return [];
  const key = (legs) =>
    legs
      .map((l) => `${l.side}${l.strike}x${l.lots}`)
      .sort()
      .join();
  if (key(pick.legs) === key(pos.legs))
    return [{ kind: 'keep', reason: `${why}: the search picks the same strikes, kept`, close: [], open: [], ref: { put: S } }];
  return [
    {
      kind: 'repick',
      reason: `${why}: re-picked → ${shapeText(pick.shape)}`,
      close: pos.legs.map((l) => ({ id: l.id, lots: l.lots })),
      open: pick.legs,
      ref: { put: S },
    },
  ];
}

// ---------- the study: hold vs re-pick, the loss limit, the rank, and the alternatives ----------
const STUDY = [
  ['none', 'Hold to expiry (no re-picks)', { adj: { on: false } }],
  ['move1', 'Re-pick at a 1 % move', { adj: { movePct: 1 } }],
  ['move15', 'Re-pick at a 1.5 % move', { adj: { movePct: 1.5 } }],
  ['move2', 'Re-pick at a 2 % move', { adj: { movePct: 2 } }],
  ['move3', 'Re-pick at a 3 % move', { adj: { movePct: 3 } }],
  ['move2h', '2 % move, checked hourly', { adj: { movePct: 2, check: 'hourly' } }],
  ['move2up', 'Re-pick only after a 2 % rise', { adj: { movePct: 2, dir: 'up' } }],
  ['move2dn', 'Re-pick only after a 2 % fall', { adj: { movePct: 2, dir: 'down' } }],
  ['loss0', 'Hold · loss limit ₹0 (least loss)', { adj: { on: false }, pick: { maxLoss: 0 } }],
  ['loss1k', 'Hold · loss limit ₹1,000', { adj: { on: false }, pick: { maxLoss: 1000 } }],
  ['loss5k', 'Hold · loss limit ₹5,000', { adj: { on: false }, pick: { maxLoss: 5000 } }],
  ['loss10k', 'Hold · loss limit ₹10,000', { adj: { on: false }, pick: { maxLoss: 10000 } }],
  ['rankLoss', 'Hold · rank by smallest loss', { adj: { on: false }, pick: { rank: 'loss' } }],
  ['rankCredit', 'Hold · rank by P&L if Nifty stays', { adj: { on: false }, pick: { rank: 'credit' } }],
  ['noFly', 'Hold · back spread alone (no flies)', { adj: { on: false }, pick: { flies: 0 } }],
  ['oneFly', 'Hold · at most 1 fly', { adj: { on: false }, pick: { flies: 1 } }],
  ['ideas', 'Hold · Live Ideas shape (ATM−100/−300, 2 flies ±1.5 W)', { adj: { on: false }, pick: { mode: 'ideas' } }],
  ['put', 'Hold · plain bought put ATM−300', { adj: { on: false }, pick: { mode: 'put' } }],
];

const ENGINE = { merge, pickLegs, shapeStrikes, shapeText, decide, preload, priced: true, STUDY, DEFAULTS };
const runPbs = (data, params, range, opts) => M.runMcc(data, params, range, opts, ENGINE);
const runPbsStudy = (data, base, range, opts) => M.runMccStudy(data, base, range, opts, ENGINE);
const runPbsModel = (params, opts) => M.runMccModel(params, opts, ENGINE);

module.exports = {
  // this strategy's own
  DEFAULTS,
  STUDY,
  ENGINE,
  ROLE,
  merge,
  legsOf,
  searchRough,
  score,
  figures,
  pickLegs,
  withShape,
  shapeText,
  shapeStrikes,
  decide,
  preload,
  runPbs,
  runPbsStudy,
  runPbsModel,
  // shared with the Covered call (what mccpaper.js takes from its engine)
  deepMerge: M.deepMerge,
  atmOf,
  snap,
  CHECK_MINS: M.CHECK_MINS,
  newPosition: M.newPosition,
  needs: M.needs,
  apply: M.apply,
  openLegs: M.openLegs,
  settle: M.settle,
  payoffAt: M.payoffAt,
  splitPnl: M.splitPnl,
  etfCost: M.etfCost,
  etfQty: M.etfQty,
  fill: M.fill,
  summarize: M.summarize,
  timeOf: M.timeOf,
};
