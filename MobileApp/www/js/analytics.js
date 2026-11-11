// Option-chain analytics. A chain is { spot, expiry, lotSize, rows: [{ strike, ce, pe }] } with strikes ascending and
// each side { key, ltp, close, vol, oi, prevOi, iv (percent), delta, bid, ask }.
import { daysTo } from './time.js';

export function atmStrike(rows, spot) {
  if (!rows?.length || !(spot > 0)) return null;
  let best = rows[0].strike;
  for (const r of rows) if (Math.abs(r.strike - spot) < Math.abs(best - spot)) best = r.strike;
  return best;
}

// The listed strike nearest to k.
export function snap(rows, k) {
  let best = null;
  for (const r of rows) if (best == null || Math.abs(r.strike - k) < Math.abs(best - k)) best = r.strike;
  return best;
}

export const rowAt = (rows, strike) => rows.find((r) => r.strike === strike) || null;

// Fair price of one side: bid/ask mid when the quote is two-sided and not wide, else LTP kept inside the quote.
export function mark(side) {
  if (!side) return null;
  const { bid, ask, ltp } = side;
  if (bid > 0 && ask > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (ask - bid <= Math.max(2, mid * 0.05)) return round2(mid);
    if (ltp > 0) return Math.min(ask, Math.max(bid, ltp));
    return round2(mid);
  }
  return ltp > 0 ? ltp : null;
}
const round2 = (x) => Math.round(x * 100) / 100;

export function pcr(rows) {
  let c = 0;
  let p = 0;
  for (const r of rows) {
    c += r.ce?.oi || 0;
    p += r.pe?.oi || 0;
  }
  return c > 0 ? p / c : null;
}

// Strike at which option writers pay out the least if Nifty expires there.
export function maxPain(rows) {
  let best = null;
  let bestPay = Infinity;
  for (const x of rows) {
    let pay = 0;
    for (const r of rows) {
      if (x.strike > r.strike) pay += (x.strike - r.strike) * (r.ce?.oi || 0);
      if (x.strike < r.strike) pay += (r.strike - x.strike) * (r.pe?.oi || 0);
    }
    if (pay < bestPay) {
      bestPay = pay;
      best = x.strike;
    }
  }
  return best;
}

// Highest put OI (support) and highest call OI (resistance).
export function supportResistance(rows) {
  let sup = null;
  let res = null;
  for (const r of rows) {
    if ((r.pe?.oi || 0) > (sup?.pe?.oi || 0)) sup = r;
    if ((r.ce?.oi || 0) > (res?.ce?.oi || 0)) res = r;
  }
  return { support: sup?.strike ?? null, resistance: res?.strike ?? null };
}

// ATM straddle and the move it implies by expiry (≈ 0.85 × straddle, a rule of thumb).
export function straddle(chain) {
  const atm = atmStrike(chain.rows, chain.spot);
  const r = rowAt(chain.rows, atm);
  const ce = mark(r?.ce);
  const pe = mark(r?.pe);
  if (!(ce > 0) || !(pe > 0)) return { atm, price: null, move: null, movePct: null };
  const price = ce + pe;
  return { atm, price, move: price * 0.85, movePct: (price * 0.85 * 100) / chain.spot };
}

export function summary(chain) {
  return { ...straddle(chain), pcr: pcr(chain.rows), maxPain: maxPain(chain.rows), ...supportResistance(chain.rows) };
}

// Monthly expiries: the last listed expiry of each calendar month.
export function monthlyExpiries(expiries) {
  const last = new Map();
  for (const e of [...expiries].sort()) last.set(e.slice(0, 7), e);
  return [...last.values()];
}

// The collars' series: the current monthly expiry while at least minDays calendar days remain, else the next one.
export function collarExpiry(expiries, now = Date.now(), minDays = 15) {
  const m = monthlyExpiries(expiries).filter((e) => daysTo(e, now) >= 0);
  return m.find((e) => daysTo(e, now) >= minDays) || m[m.length - 1] || null;
}

// The strikes around ATM shown on the Chain screen.
export function around(rows, spot, n) {
  const atm = atmStrike(rows, spot);
  const i = rows.findIndex((r) => r.strike === atm);
  if (i < 0) return rows.slice(0, 2 * n + 1);
  return rows.slice(Math.max(0, i - n), i + n + 1);
}
