// Live trade of a collar (the desktop portal's Trading Ideas › Put spread collar › Live trade, bt/mcclive.js), worked
// out on the phone: the P&L now by structure (the sold call, the put spread), NIFTYBEES, the P&L for Nifty moves from
// where the trade started (if Nifty is there today, and at expiry), and how much NIFTYBEES the upside needs.
// Open legs are priced at their LTP. Closed legs count with the P&L they were closed at. Before charges, as the
// portal's Live trade shows it.
import { price, intrinsic, impliedVol } from './bs.js';
import { yearsTo } from './time.js';
import { rowAt } from './analytics.js';
import { isClosed, legPnl, ltpOf } from './strategy.js';

// Nifty moves (%) the grid shows either way from the trade's start, as on the portal.
export const MOVES = [0.3, 0.5, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20];
export const COVER_PCTS = [0, 1, 2, 5, 10, 20];

// The trade's legs with their prices now: ltp (null when the chain has none), and vol, the volatility that prices the
// leg at its LTP with Nifty at spot (the chain's IV without an LTP), so "if Nifty is there today" is the P&L now at
// Nifty now.
export function priceLegs(legs, chain, spot, expiry, now = Date.now()) {
  const T = yearsTo(expiry, now);
  return legs.map((l) => {
    if (isClosed(l)) return { ...l, ltp: null, vol: null };
    const r = chain ? rowAt(chain.rows, l.strike) : null;
    const o = l.type === 'CE' ? r?.ce : r?.pe;
    const ltp = ltpOf(o) ?? null;
    const chainIv = o?.iv > 0 ? o.iv / 100 : null;
    const fit = ltp > 0 && T > 0 && spot > 0 ? impliedVol(l.type, ltp, spot, l.strike, T) : null;
    return { ...l, ltp, iv: chainIv, vol: fit || chainIv || l.iv || 0.15 };
  });
}

const byType = (legs, f) => {
  const out = { CE: 0, PE: 0 };
  for (const l of legs) out[l.type] += f(l);
  return out;
};

// P&L now by structure. A structure with an open leg that has no price has no P&L (null).
export function pnlNow(legs, lot, bees) {
  const priced = { CE: true, PE: true };
  const by = byType(legs, (l) => {
    if (isClosed(l)) return legPnl(l, lot);
    if (!(l.ltp >= 0) || l.ltp == null) {
      priced[l.type] = false;
      return 0;
    }
    return legPnl(l, lot, l.ltp);
  });
  const ok = priced.CE && priced.PE;
  const etf = bees?.units > 0 && bees.now > 0 ? bees.units * (bees.now - bees.entry) : 0;
  return {
    call: priced.CE ? by.CE : null,
    put: priced.PE ? by.PE : null,
    opt: ok ? by.CE + by.PE : null,
    bees: etf,
    total: ok ? by.CE + by.PE + etf : null,
    ok,
  };
}

// The options at expiry with Nifty at x, by structure.
export const expiryAt = (legs, lot, x) => byType(legs, (l) => legPnl(l, lot, intrinsic(l.type, x, l.strike)));

// The options if Nifty moved to x today (Black-Scholes, each open leg at its calibrated vol), by structure.
export function todayAt(legs, lot, x, expiry, now = Date.now()) {
  const T = yearsTo(expiry, now);
  return byType(legs, (l) => legPnl(l, lot, isClosed(l) ? 0 : price(l.type, x, l.strike, T, l.vol || l.iv || 0.15)));
}

// Rows for Nifty at the trade's start E and MOVES % up and down from it, plus Nifty now (its own row). Every P&L is the
// trade's since its start. NIFTYBEES at a Nifty level is its buy price moved in % with Nifty from the start (pinned, so
// the rows stay put while the market moves); the Now row takes NIFTYBEES at its price now.
// bees: { units, entry, now } or null.
export function moveGrid({ legs, lot, expiry, spot: S, entrySpot, bees, now = Date.now() }) {
  const E = entrySpot > 0 ? entrySpot : S;
  const has = bees?.units > 0;
  const k = has && bees.entry > 0 ? bees.entry / E : 0;
  const mNow = (S / E - 1) * 100;
  const marks = [...MOVES.map((m) => -m).reverse(), 0, ...MOVES].map((m) => ({ m, mark: m === 0 ? (Math.abs(E - S) < 1e-9 ? 'now' : 'entry') : null }));
  if (Math.abs(E - S) >= 1e-9) marks.push({ m: mNow, mark: 'now' });
  return marks
    .sort((a, b) => b.m - a.m)
    .map(({ m, mark }) => {
      const x = mark === 'now' ? S : E * (1 + m / 100);
      const e = expiryAt(legs, lot, x);
      const d = todayAt(legs, lot, x, expiry, now);
      const px = has ? (mark === 'now' && bees.now > 0 ? bees.now : k * x) : null;
      const etf = has ? bees.units * (px - bees.entry) : 0;
      return {
        m: mark === 'now' ? mNow : m,
        mark,
        x,
        fromNow: (x / S - 1) * 100,
        beesPx: px,
        bees: etf,
        call: e.CE,
        put: e.PE,
        opt: e.CE + e.PE,
        total: e.CE + e.PE + etf,
        callToday: d.CE,
        putToday: d.PE,
        optToday: d.CE + d.PE,
        totalToday: d.CE + d.PE + etf,
      };
    });
}

// How much NIFTYBEES the upside needs (bt/mcclive.js beesCover). Above the highest call strike the options lose
// (sold − bought call lots) × lot ₹ a Nifty point; one NIFTYBEES unit gains its price ÷ Nifty ₹ a point.
//   perPoint = net sold call lots × lot, perUnit = NIFTYBEES now ÷ Nifty now, slopeUnits = perPoint ÷ perUnit
// minUnits: the fewest units for which the trade at expiry is never below 0 from Nifty now up (units added count as
// bought now at NIFTYBEES now). null without sold calls (nothing to cover).
export function beesCover({ legs, lot, spot: S, bees, upTo = 0.5 }) {
  const open = legs.filter((l) => !isClosed(l));
  const net = open.filter((l) => l.type === 'CE').reduce((a, l) => a - l.side * l.lots, 0);
  if (!(net > 0)) return null;
  const beesNow = bees?.now > 0 ? bees.now : S / 100;
  const held = bees?.units > 0 ? bees.units : 0;
  const paid = held && bees.entry > 0 ? bees.entry : beesNow;
  const perUnit = beesNow / S;
  const perPoint = net * lot;
  const slopeUnits = perPoint / perUnit;
  const opt = (x) => {
    const e = expiryAt(legs, lot, x);
    return e.CE + e.PE;
  };
  // the trade at expiry at Nifty x with q units in all (those above the units held bought now)
  const at = (x, q) => opt(x) + held * (beesNow * (x / S) - paid) + (q - held) * beesNow * (x / S - 1);
  const xs = [S, ...[...new Set(open.map((l) => l.strike))].filter((k) => k > S).sort((a, b) => a - b), S * (1 + upTo)];
  const ok = (q) => xs.every((x) => at(x, q) >= 0) && q * perUnit - perPoint >= -1e-9;
  let minUnits = null;
  if (ok(held)) minUnits = held;
  else {
    let hi = Math.max(1000, slopeUnits * 4);
    if (ok(hi)) {
      let lo = held;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(mid)) hi = mid;
        else lo = mid;
      }
      minUnits = hi;
    }
  }
  const toBuy = minUnits == null ? null : Math.max(0, minUnits - held);
  return { netShortLots: net, lot, perPoint, perUnit, slopeUnits, held, beesNow, minUnits, toBuy, cost: toBuy == null ? null : toBuy * beesNow, now: at(S, held), at };
}
