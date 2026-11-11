// Positions made of option legs (and optionally NIFTYBEES): payoff, Greeks, charges, and the collar shapes.
// A leg is { type: 'CE'|'PE', strike, side: 1 (bought) | -1 (sold), lots, entry (₹ premium), iv (fraction|null), key }.
import { price, greeks, intrinsic, impliedVol } from './bs.js';
import { yearsTo, ist } from './time.js';
import { orders } from './costs.js';
import { atmStrike, snap, rowAt, mark } from './analytics.js';

export const NIFTY_STEP = 50;

export const optionsAtExpiry = (legs, S, lot) => legs.reduce((a, l) => a + l.side * l.lots * lot * (intrinsic(l.type, S, l.strike) - l.entry), 0);

// NIFTYBEES held: { units, entry (₹ per unit), spot0 (Nifty when bought) }, modelled as moving with Nifty.
export const beesPnl = (bees, S) => (bees && bees.units > 0 ? bees.units * bees.entry * (S / bees.spot0 - 1) : 0);

// A leg's volatility for Black-Scholes: its own IV, else one solved from its entry price, else 15 %.
function volOf(l, S, T) {
  if (l.iv > 0) return l.iv;
  return impliedVol(l.type, l.entry, S, l.strike, T) || 0.15;
}

export function optionsNow(legs, S, expiry, lot, now = Date.now(), spotRef = S) {
  const T = yearsTo(expiry, now);
  return legs.reduce((a, l) => a + l.side * l.lots * lot * (price(l.type, S, l.strike, T, volOf(l, spotRef, T)) - l.entry), 0);
}

export function netGreeks(legs, S, expiry, lot, now = Date.now(), bees = null) {
  const T = yearsTo(expiry, now);
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) {
    const x = greeks(l.type, S, l.strike, T, volOf(l, S, T));
    const q = l.side * l.lots * lot;
    g.delta += x.delta * q;
    g.gamma += x.gamma * q;
    g.theta += x.theta * q;
    g.vega += x.vega * q;
  }
  if (bees?.units > 0) g.delta += (bees.units * bees.entry) / bees.spot0; // ₹ per Nifty point, in Nifty units
  return g;
}

export function grid(lo, hi, n = 161) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * i) / (n - 1));
  return out;
}

// From [[S, pnl], …] sorted by S: extremes, breakevens and whether the ends keep going (beyond the range shown).
export function analyse(points) {
  let maxP = -Infinity;
  let maxL = Infinity;
  const be = [];
  for (let i = 0; i < points.length; i++) {
    const [S, v] = points[i];
    if (v > maxP) maxP = v;
    if (v < maxL) maxL = v;
    if (i > 0) {
      const [S0, v0] = points[i - 1];
      if ((v0 < 0 && v >= 0) || (v0 > 0 && v <= 0)) be.push(S0 + ((0 - v0) * (S - S0)) / (v - v0));
    }
  }
  const n = points.length;
  const slope = (a, b) => (points[b][1] - points[a][1]) / (points[b][0] - points[a][0]);
  const lo = n > 1 ? slope(0, 1) : 0;
  const hi = n > 1 ? slope(n - 2, n - 1) : 0;
  const eps = 0.5; // ₹ per Nifty point
  return {
    maxProfit: maxP,
    maxLoss: maxL,
    breakevens: be.map((x) => Math.round(x)),
    profitOpen: hi > eps || lo < -eps, // keeps rising beyond an edge of the range
    lossOpen: hi < -eps || lo > eps, // keeps falling beyond an edge of the range
  };
}

// Charges on opening (or closing) the legs at their marks: slippage + statutory charges + brokerage.
export function tradeCosts(legs, lot, { slipPct = 0.5, brokerage = 20 } = {}, now = Date.now(), marks = null) {
  let buy = 0;
  let sell = 0;
  let slip = 0;
  legs.forEach((l, i) => {
    const px = marks ? marks[i] : l.entry;
    if (!(px > 0)) return;
    const turn = px * l.lots * lot;
    slip += (turn * slipPct) / 100;
    // closing reverses the side
    const buying = marks ? l.side < 0 : l.side > 0;
    if (buying) buy += turn;
    else sell += turn;
  });
  const charges = orders({ buy, sell, n: legs.filter((l, i) => (marks ? marks[i] : l.entry) > 0).length, brokerage, day: ist(now).date });
  return { slippage: slip, charges, total: slip + charges };
}

// Net premium: positive = credit received.
export const netPremium = (legs, lot) => legs.reduce((a, l) => a - l.side * l.entry * l.lots * lot, 0);

export function beesUnits(spot, beesPx, lot, lots = 1, budget = 0) {
  if (!(beesPx > 0)) return 0;
  return budget > 0 ? Math.floor(budget / beesPx) : Math.round((lot * lots * spot) / beesPx);
}

export const COLLARS = {
  psc: {
    id: 'psc',
    name: 'Put spread collar',
    short: 'PSC',
    blurb: 'NIFTYBEES worth one lot · sell CE ATM+100 · buy PE ATM−100 · sell PE 100 under it. The sold call pays for the put spread; the put spread cushions the ETF for 100 points.',
    puts: [1, -1], // [upper put side, lower put side]
  },
  bpc: {
    id: 'bpc',
    name: 'Bull put collar',
    short: 'BPC',
    blurb: 'NIFTYBEES worth one lot · sell CE ATM+100 · sell PE ATM−100 · buy PE 100 under it. Both sides collect premium; the bought put caps the sold put’s loss.',
    puts: [-1, 1],
  },
};

// The collar's legs on a chain, priced at each side's mark. opts: { ceOff, peOff, gap, lots }.
export function collarLegs(kind, chain, { ceOff = 100, peOff = 100, gap = 100, lots = 1 } = {}) {
  const shape = COLLARS[kind];
  const rows = chain.rows;
  const atm = Math.round(chain.spot / NIFTY_STEP) * NIFTY_STEP;
  const ceK = snap(rows, atm + ceOff);
  const peHi = snap(rows, atm - peOff);
  const peLo = snap(rows, peHi - gap);
  const spec = [
    { type: 'CE', strike: ceK, side: -1 },
    { type: 'PE', strike: peHi, side: shape.puts[0] },
    { type: 'PE', strike: peLo, side: shape.puts[1] },
  ];
  return spec.map((s) => legFromChain(chain, s.type, s.strike, s.side, lots));
}

export function legFromChain(chain, type, strike, side, lots = 1) {
  const r = rowAt(chain.rows, strike);
  const o = type === 'CE' ? r?.ce : r?.pe;
  return {
    type,
    strike,
    side,
    lots,
    entry: mark(o) ?? 0,
    iv: o?.iv > 0 ? o.iv / 100 : null,
    key: o?.key || null,
    bid: o?.bid ?? null,
    ask: o?.ask ?? null,
  };
}

// The current mark of each leg on a chain of its expiry (or intrinsic at spot once expired / missing).
export function legMarks(legs, chain, spot, expired) {
  return legs.map((l) => {
    if (expired || !chain) return intrinsic(l.type, spot, l.strike);
    const r = rowAt(chain.rows, l.strike);
    const m = mark(l.type === 'CE' ? r?.ce : r?.pe);
    return m ?? intrinsic(l.type, spot, l.strike);
  });
}

// Value a saved position now: { marks, options, bees, gross, costsIn, costsOut, net }.
export function valuePosition(pos, { chain, spot, beesPx, now = Date.now(), slipPct = 0.5, brokerage = 20 }) {
  const expired = now >= Date.parse(pos.expiry + 'T10:00:00Z'); // 15:30 IST
  const marks = legMarks(pos.legs, chain, spot, expired);
  const options = pos.legs.reduce((a, l, i) => a + l.side * l.lots * pos.lotSize * (marks[i] - l.entry), 0);
  let bees = 0;
  if (pos.bees?.units > 0) bees = beesPx > 0 ? pos.bees.units * (beesPx - pos.bees.entry) : beesPnl(pos.bees, spot);
  const costsOut = expired ? 0 : tradeCosts(pos.legs, pos.lotSize, { slipPct, brokerage }, now, marks).total;
  const gross = options + bees;
  return { marks, expired, options, bees, gross, costsIn: pos.costsIn || 0, costsOut, net: gross - (pos.costsIn || 0) - costsOut };
}

// Payoff curves for a set of legs: [{ S, expiry, now }] over ±pct around spot.
export function curves(legs, { spot, lot, expiry, bees = null, pct = 0.1, now = Date.now(), n = 161 }) {
  const xs = grid(spot * (1 - pct), spot * (1 + pct), n);
  const atExp = xs.map((S) => [S, optionsAtExpiry(legs, S, lot) + beesPnl(bees, S)]);
  const today = xs.map((S) => [S, optionsNow(legs, S, expiry, lot, now, spot) + beesPnl(bees, S)]);
  const opts = xs.map((S) => [S, optionsAtExpiry(legs, S, lot)]);
  return { xs, atExp, today, opts };
}

export { atmStrike };
