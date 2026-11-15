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

// ---------- Suggestion: the best strikes for a new collar (the portal's bt/mcclive.js bestCollars) ----------
// Every collar on the chain: sell 1 CE + a put spread (2 PE legs 50 … 700 points apart, one bought one sold, either way
// round: the bought put above the sold one = Put spread collar, the sold above the bought = Bull put collar), every
// strike ATM or out of the money only (the call at the ATM strike up to WIDE above, the puts at the ATM strike down to
// WIDE below). Entered now at the LTP ± slipPct % with charges,
// held with the NIFTYBEES (beesUnits at beesPx, bought now), scored at expiry on Nifty moves of 1 … 8 % from now:
//   up      = the average total (NIFTYBEES + options) over the up moves,
//   downOpt = the average options P&L over the down moves (what the options earn on a fall, NIFTYBEES aside),
//   down    = the average total over the down moves, flat = the options' P&L if Nifty ends where it is now,
//   mid     = the lowest total at expiry anywhere within ±midBand % of now (Nifty staying in a range).
// Kept: downOpt ≥ minDown, up ≥ minUp and mid ≥ minMid (the floors); ranked by up + mid, then downOpt (none that meet
// all: the ones that miss by the least, shortfalls added, first). minFlat: the least the options alone earn if Nifty
// stays (flat), e.g. 1 % of the money invested. midBest: the highest mid meeting the other floors. One per
// sold-call strike. Only strikes traded today (volume above 0) with a price and a bid–ask no wider than ₹2 / 10 %.
export const BEST_MOVES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8];
const WIDE = 1000;
const STEP = 50;
export function bestCollars({ chain, lot, lots = 1, beesUnits = 0, beesPx = 0, slipPct = 0.5, brokerage = 20, day = null, n = 5, minDown = 30000, minUp = 35000, minMid = 0, midBand = 2, minFlat = -Infinity, orders = null }) {
  const S = chain.spot;
  const A = Math.round(S / STEP) * STEP;
  const slip = slipPct / 100;
  const rows = new Map(chain.rows.map((r) => [r.strike, r]));
  const quote = (t, K) => {
    const o = t === 'CE' ? rows.get(K)?.ce : rows.get(K)?.pe;
    const px = o?.ltp > 0 ? o.ltp : null;
    if (!px || !(o.vol > 0)) return null;
    if (o.bid > 0 && o.ask > 0 && o.ask - o.bid > Math.max(2, ((o.bid + o.ask) / 2) * 0.1)) return null;
    return px;
  };
  // ATM and out of the money only (no ITM): the call at the ATM strike or above, both puts at the ATM strike or below
  const strikes = (t) => {
    const out = [];
    const [lo, hi] = t === 'CE' ? [A, A + WIDE] : [A - WIDE, A];
    for (let k = lo; k <= hi; k += STEP) if (quote(t, k)) out.push(k);
    return out;
  };
  const bees = (x) => (beesUnits > 0 ? beesUnits * beesPx * (x / S - 1) : 0);
  const ups = BEST_MOVES.map((m) => S * (1 + m / 100));
  const downs = BEST_MOVES.map((m) => S * (1 - m / 100));
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const band = Math.min(10, Math.max(0.5, Number(midBand) || 2));
  const mids = Array.from({ length: Math.round(band * 20) + 1 }, (_, i) => S * (1 + (i / 10 - band) / 100));
  const ces = strikes('CE');
  const pes = strikes('PE');
  const scored = [];
  let tried = 0;
  for (const c of ces)
    for (const hi of pes)
      for (const lo of pes) {
        if (lo >= hi || hi - lo > 700) continue;
        for (const buyHi of [true, false]) {
          tried++;
          const spec = [
            { type: 'CE', strike: c, side: -1 },
            { type: 'PE', strike: hi, side: buyHi ? 1 : -1 },
            { type: 'PE', strike: lo, side: buyHi ? -1 : 1 },
          ];
          let buy = 0;
          let sell = 0;
          const legs = spec.map((s) => {
            const ltp = quote(s.type, s.strike);
            const fill = s.side > 0 ? ltp * (1 + slip) : ltp * (1 - slip);
            if (s.side > 0) buy += fill * lots * lot;
            else sell += fill * lots * lot;
            return { ...s, lots, ltp, entry: fill };
          });
          const charges = orders ? orders({ buy, sell, n: 3, brokerage, day }) : 0;
          const opt = (x) => {
            const e = expiryAt(legs, lot, x);
            return e.CE + e.PE - charges;
          };
          const dn = downs.map(opt);
          scored.push({
            legs,
            charges,
            up: avg(ups.map((x) => opt(x) + bees(x))),
            downOpt: avg(dn),
            down: avg(dn.map((v, i) => v + bees(downs[i]))),
            flat: opt(S),
            mid: Math.min(...mids.map((x) => opt(x) + bees(x))),
          });
        }
      }
  const within = scored.filter((o) => o.downOpt >= minDown && o.up >= minUp && o.mid >= minMid && o.flat >= minFlat);
  // ranked by Nifty going up and Nifty staying in the range (its lowest point), same weight; the floors cover the fall
  const short = (o) => Math.max(0, minDown - o.downOpt) + Math.max(0, minUp - o.up) + Math.max(0, minMid - o.mid) + Math.max(0, minFlat - o.flat);
  const rank = (a, b) => b.up + b.mid - (a.up + a.mid) || b.downOpt - a.downOpt;
  const midBest = scored.reduce((m, o) => (o.downOpt >= minDown && o.up >= minUp && o.flat >= minFlat && (m == null || o.mid > m) ? o.mid : m), null);
  const pool = within.length ? within.sort(rank) : scored.sort((a, b) => short(a) - short(b) || rank(a, b));
  const list = pool
    .filter((o, i) => pool.findIndex((q) => q.legs[0].strike === o.legs[0].strike) === i)
    .slice(0, n)
    .map((o) => ({
      ...o,
      kind: o.legs[1].side > 0 ? 'psc' : 'bpc',
      title: o.legs.map((l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.strike} ${l.type}`).join(' · '),
      credit: o.legs.reduce((a, l) => a - l.side * l.entry * l.lots * lot, 0),
    }));
  return { tried, priced: scored.length, within: within.length, minDown, minUp, minMid, midBand: band, minFlat: Number.isFinite(minFlat) ? minFlat : null, midBest, list };
}
