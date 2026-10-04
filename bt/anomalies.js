// Option-pricing anomaly detectors for the Nifty chain (currently the vertical-spread arbitrage from the builder). The same detectors run on live snapshots and on
// historical 1-minute candles, so a scan, a backtest and the live screen all agree on what fired.
//
// Every detector works on a chain context (see Chain below): one expiry at one moment — spot, the strikes
// around ATM with their prices, plus lazily computed forward, implied vols and deltas, the context N
// minutes earlier, the next expiry's context, and the recent realised volatility.
//
// Implied vols use Black-76 on the synthetic forward (median of K + (C − P)·e^{rT} near ATM), so calls and
// puts at a strike get consistent vols and the smile is read from out-of-the-money options. Time is
// counted in trading minutes (252 sessions of 375 minutes a year): with calendar time, IV appears to
// triple through expiry day and can't be compared with realised vol or across the day.
const RATE = 0.065;
const YEAR_MIN = 252 * 375;

// Trading years from minute `minute` (0 = 09:15) of `day` to 15:30 on `expiry`, counting weekdays.
const tyMemo = new Map();
function tradingYears(expiry, day, minute) {
  const key = expiry + day;
  let full = tyMemo.get(key);
  if (full == null) {
    full = 0;
    for (let t = Date.parse(day + 'T00:00:00Z') + 86400_000, end = Date.parse(expiry + 'T00:00:00Z'); t <= end; t += 86400_000) {
      const wd = new Date(t).getUTCDay();
      if (wd > 0 && wd < 6) full++;
    }
    tyMemo.set(key, full);
    if (tyMemo.size > 20000) tyMemo.clear();
  }
  return (Math.max(0, 375 - minute) + 375 * full) / YEAR_MIN;
}

// ---------- Black-76 ----------
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function b76(F, K, T, v, call, df) {
  if (T <= 0 || v <= 0) return df * Math.max(0, call ? F - K : K - F);
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (sq * sq) / 2) / sq;
  const d2 = d1 - sq;
  return call ? df * (F * ncdf(d1) - K * ncdf(d2)) : df * (K * ncdf(-d2) - F * ncdf(-d1));
}
function b76iv(price, F, K, T, call, df) {
  const intrinsic = df * Math.max(0, call ? F - K : K - F);
  if (!(price > intrinsic + 0.01) || T <= 0) return null;
  let lo = 0.01;
  let hi = 3;
  if (b76(F, K, T, hi, call, df) < price) return null;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (b76(F, K, T, mid, call, df) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
const d1Of = (F, K, T, v) => (Math.log(F / K) + (v * v * T) / 2) / (v * Math.sqrt(T));

// ---------- chain context ----------
// base: { spot, T (trading years), ks (sorted strikes), ce, pe (prices aligned with ks; null/0 = missing),
//         ageCe, agePe (optional: minutes since each contract last traded),
//         book (true when the chain carries an order book: live), ceBid, ceAsk, peBid, peAsk (best quotes),
//         ceBidQ, ceAskQ, peBidQ, peAskQ (quantity at those quotes), lot (lot size, for the quantities),
//         expiry, day, minute (0 = 09:15),
//         open (Nifty at 09:15), rv(n) -> annualised realised vol over n sessions, prev(n) -> Chain n minutes
//         earlier, next() -> Chain of the next expiry, dayIv() -> ATM IV at 09:20 }
class Chain {
  constructor(base) {
    Object.assign(this, base);
    this.T = Math.max(this.T, 10 / YEAR_MIN); // the last minutes of expiry day: keep the maths finite
    this.df = Math.exp(-RATE * this.T);
    this.idx = new Map(this.ks.map((k, i) => [k, i]));
    this._iv = new Map();
  }
  // Price, or null when missing or (with maxAge) when the contract hasn't traded for longer than that.
  px(k, type, maxAge) {
    const i = this.idx.get(k);
    if (i == null) return null;
    const v = (type === 'CE' ? this.ce : this.pe)[i];
    if (!(v > 0)) return null;
    if (maxAge != null) {
      const age = (type === 'CE' ? this.ageCe : this.agePe)?.[i] ?? 0;
      if (age > maxAge) return null;
    }
    return v;
  }
  // Best bid / ask (side 'bid' | 'ask') when the chain carries quotes (live), else null.
  quote(k, type, side) {
    const i = this.idx.get(k);
    const arr = this[(type === 'CE' ? 'ce' : 'pe') + (side === 'bid' ? 'Bid' : 'Ask')];
    const v = i == null ? null : arr?.[i];
    return v > 0 ? v : null;
  }
  // Quantity (units) waiting at the best bid / ask, or null.
  quoteQty(k, type, side) {
    const i = this.idx.get(k);
    const arr = this[(type === 'CE' ? 'ce' : 'pe') + (side === 'bid' ? 'BidQ' : 'AskQ')];
    const v = i == null ? null : arr?.[i];
    return v > 0 ? v : null;
  }
  // Out of the money (or within one strike of ATM): where Nifty options actually trade.
  liquid(k, type) {
    const i = this.idx.get(k);
    return Math.abs(i - this.ai) <= 1 || (type === 'CE' ? k > this.spot : k < this.spot);
  }
  get ai() {
    if (this._ai == null) {
      let b = 0;
      for (let i = 1; i < this.ks.length; i++) if (Math.abs(this.ks[i] - this.spot) < Math.abs(this.ks[b] - this.spot)) b = i;
      this._ai = b;
    }
    return this._ai;
  }
  get atm() { return this.ks[this.ai]; }
  // The last 90 minutes before expiry: IVs are dominated by pinning and tiny time values, so the
  // volatility detectors stay quiet then.
  get late() { return this.T * YEAR_MIN < 90; }
  at(i) { return i >= 0 && i < this.ks.length ? this.ks[i] : null; }
  // Synthetic forward: median of K + (C − P)/df over the strikes nearest ATM that have both prices.
  get F() {
    if (this._F == null) {
      const fs = [];
      for (let d = 0; d <= 8 && fs.length < 5; d++) {
        for (const i of d ? [this.ai - d, this.ai + d] : [this.ai]) {
          const k = this.at(i);
          if (k == null) continue;
          const c = this.px(k, 'CE');
          const p = this.px(k, 'PE');
          if (c && p) fs.push(k + (c - p) / this.df);
        }
      }
      fs.sort((a, b) => a - b);
      this._F = fs.length ? fs[fs.length >> 1] : this.spot / this.df;
    }
    return this._F;
  }
  fwdAt(k) {
    const c = this.px(k, 'CE');
    const p = this.px(k, 'PE');
    return c && p ? k + (c - p) / this.df : null;
  }
  iv(k, type) {
    const key = k + type;
    if (!this._iv.has(key)) {
      const p = this.px(k, type);
      this._iv.set(key, p ? b76iv(p, this.F, k, this.T, type === 'CE', this.df) : null);
    }
    return this._iv.get(key);
  }
  otmType(k) { return k >= this.F ? 'CE' : 'PE'; }
  otmIv(k) { return this.iv(k, this.otmType(k)); }
  // IV at the forward, interpolated between the out-of-the-money vols either side of it.
  atmIv() {
    if (this._atmIv === undefined) {
      const F = this.F;
      let j = this.ks.findIndex((k) => k >= F);
      if (j <= 0) j = 1;
      const k0 = this.ks[j - 1];
      const k1 = this.ks[j];
      const v0 = this.otmIv(k0) ?? this.iv(k0, 'CE');
      const v1 = this.otmIv(k1) ?? this.iv(k1, 'PE');
      this._atmIv = v0 && v1 ? v0 + ((v1 - v0) * (F - k0)) / (k1 - k0) : v0 || v1 || null;
    }
    return this._atmIv;
  }
  delta(k, type) {
    const v = this.iv(k, type) ?? this.atmIv();
    if (!v) return null;
    const n = ncdf(d1Of(this.F, k, this.T, v));
    return type === 'CE' ? n : n - 1;
  }
}

// ---------- helpers ----------
const P = (k, label, def, step = 1, unit = '', min = 0) => ({ k, label, def, step, unit, min });
const sig = (value, ref = 'hit') => ({ by: 'signal', value, ref });
const L = (action, type, strike, o = {}) => ({ action, type, lots: o.lots || 1, expiry: o.expiry || 'cur', strike, sl: o.sl || null, tgt: o.tgt || null });
const band = (c, n) => [Math.max(0, c.ai - n), Math.min(c.ks.length - 1, c.ai + n)];
const f2 = (x) => x.toFixed(2);
// Shared by every type: only report what can actually be traded.
const FILL = [P('minLots', 'Fillable ≥', 1, 1, 'lots (live)', 1), P('fresh', 'Traded within', 1, 1, 'min (history)'), P('minPx', 'Min premium', 0.05, 0.05, '₹')];

// What a structure costs or pays at the touch, if every leg can be filled. legs: [{ act: 'B' | 'S', k, t: 'CE' | 'PE',
// n: units per structure, next: true for the next expiry }].
// With an order book (live) sells go at the bid and buys at the ask, and each side of the book must hold at
// least `minLots` lots of the structure — a quote nobody stands behind is not an arbitrage. Without one (history)
// every leg must have traded within the last `fresh` minutes, at its last price.
// Returns { cash (net credit, + = received), fit (whole structures the book can fill, live) } or null.
function fill(c, legs, p) {
  let cash = 0;
  let fit = Infinity;
  for (const l of legs) {
    const ch = l.next ? c.next?.() : c;
    if (!ch) return null;
    let px;
    if (ch.book) {
      const side = l.act === 'S' ? 'bid' : 'ask';
      px = ch.quote(l.k, l.t, side);
      const q = ch.quoteQty(l.k, l.t, side);
      if (!px || !q) return null;
      const lots = Math.floor(q / ((ch.lot || 1) * l.n));
      if (lots < p.minLots) return null;
      fit = Math.min(fit, lots);
    } else {
      px = ch.px(l.k, l.t, p.fresh);
      if (!px) return null;
    }
    if (px < p.minPx) return null;
    cash += (l.act === 'S' ? 1 : -1) * l.n * px;
  }
  return { cash, fit: Number.isFinite(fit) ? fit : null };
}
const fitTxt = (f) => (f.fit == null ? '' : ` · ${f.fit} lot${f.fit === 1 ? '' : 's'} fillable`);
const legTxt = (legs) => legs.map((l) => `${l.act === 'B' ? 'BUY' : 'SELL'} ${l.n > 1 ? l.n + '× ' : ''}${l.k}${l.t}${l.next ? ' next' : ''}`).join(' + ');
const byDist = (out) => out.sort((x, y) => x.dist - y.dist || y.value - x.value);

// ---------- the detectors ----------
// All but the last are arbitrages on one chain of Nifty's European, cash-settled options: each suggested trade
// cannot lose if held to expiry (the calendar: to the near expiry), before brokerage and taxes. The last one
// (fair value deviation) is a relative-value signal: an edge, not a locked-in profit.
const TYPES = [
  {
    // Same rules as the builder's "Vertical spread arbitrage" list (public/sb-view.js findArbs). For one expiry
    // and one option type, a vertical spread is always worth between 0 and its width (strike gap):
    //   calls: C(lo) < C(hi)            -> buy lo, sell hi (paid to take a spread that cannot lose)
    //          C(lo) − C(hi) > hi − lo  -> sell lo, buy hi (credit above the most it can ever cost)
    //   puts : P(lo) > P(hi)            -> sell lo, buy hi
    //          P(hi) − P(lo) > hi − lo  -> sell hi, buy lo
    id: 'varb', name: 'Vertical spread arbitrage', group: 'Arbitrage',
    desc: 'Two strikes of the same type break the no-arbitrage bounds of a vertical spread: the further-OTM option is dearer than the nearer one (free credit), or the pair is priced further apart than the strike gap (credit above width).',
    how: 'Free credit: buy the nearer-ITM strike and sell the further one for a credit. Credit above width: sell the nearer-ITM strike and buy the further one for more than the spread can ever cost. Either way the trade cannot lose at expiry, before costs.',
    dirs: ['free-credit', 'over-width'], cooldown: 10,
    ease: { rank: 4, why: 'Only two legs, but the violations mostly sit in deep in-the-money strikes where quotes are thin.', watch: 'A long leg that finishes in the money pays exercise STT on its full value; that can exceed a small edge.' },
    params: [P('minEdge', 'Min edge', 0.5, 0.25, 'pts'), P('band', 'Strikes ± ATM', 10, 1, '', 1), P('maxGap', 'Max strikes apart', 20, 1, '', 1), ...FILL],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (const t of ['CE', 'PE']) {
        // only sane prices: a stale print below intrinsic value (no implied vol) is not tradeable
        const ks = c.ks.slice(lo, hi + 1).filter((k) => c.px(k, t) > 0 && c.iv(k, t) != null);
        for (let i = 0; i < ks.length; i++) {
          for (let j = i + 1; j < ks.length && j - i <= p.maxGap; j++) {
            const [a, b] = [ks[i], ks[j]];
            const w = b - a;
            const nearBuy = t === 'CE' ? [['B', a], ['S', b]] : [['S', a], ['B', b]]; // free credit
            const nearSell = t === 'CE' ? [['S', a], ['B', b]] : [['S', b], ['B', a]]; // credit above width
            for (const [dir, pairs, less] of [['free-credit', nearBuy, 0], ['over-width', nearSell, w]]) {
              const legs = pairs.map(([act, k]) => ({ act, k, t, n: 1 }));
              const f = fill(c, legs, p);
              if (!f || f.cash - less < p.minEdge) continue;
              const edge = f.cash - less;
              out.push({
                strike: a, ref: b, side: t, dir, value: edge, unit: 'pts', arb: true, fit: f.fit,
                dist: Math.min(Math.abs(a - c.spot), Math.abs(b - c.spot)),
                text: `${t} ${a}/${b}: ${legTxt(legs)} · ${dir === 'free-credit' ? 'free credit' : `credit above the ${w}-pt width`} +${f2(edge)} pts${fitTxt(f)}`,
              });
              break;
            }
          }
        }
      }
      // nearest the money first, then the bigger edge (the order the builder lists them in)
      return byDist(out);
    },
    suggest(h) {
      // hit = lower strike, ref = higher strike
      const lb = lowBuys(h.side, h.dir);
      return { legs: [L(lb ? 'B' : 'S', h.side, sig(0)), L(lb ? 'S' : 'B', h.side, sig(0, 'ref'))] };
    },
  },
  {
    // Option prices are convex in the strike: a long butterfly (1 − 2 + 1, equal wings) is worth ≥ 0 at expiry.
    id: 'fly', name: 'Butterfly arbitrage', group: 'Arbitrage',
    desc: 'Three equally spaced strikes of the same type are not convex: the long butterfly (buy 1 low, sell 2 middle, buy 1 high) can be put on for a credit.',
    how: 'Buy the butterfly for a credit: it is worth zero or more at expiry, so the credit is the minimum gain (up to credit + wing width if Nifty finishes at the body).',
    dirs: ['credit'], cooldown: 10,
    ease: { rank: 3, why: 'Liquid when centred near the money; the body needs twice the quantity on the book.', watch: 'Three orders: if the body fills and a wing does not, you are left with a naked short.' },
    params: [P('minEdge', 'Min credit', 0.5, 0.25, 'pts'), P('wing', 'Wing width', 1, 1, 'strikes', 1), P('band', 'Strikes ± ATM', 10, 1, '', 1), ...FILL],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const n = Math.max(1, Math.round(p.wing));
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const [a, k, b] = [c.at(i - n), c.ks[i], c.at(i + n)];
        if (a == null || b == null || k - a !== b - k) continue;
        for (const t of ['CE', 'PE']) {
          const legs = [{ act: 'B', k: a, t, n: 1 }, { act: 'S', k, t, n: 2 }, { act: 'B', k: b, t, n: 1 }];
          const f = fill(c, legs, p);
          if (!f || f.cash < p.minEdge) continue;
          out.push({ strike: k, side: t, dir: 'credit', value: f.cash, unit: 'pts', arb: true, fit: f.fit, dist: Math.abs(k - c.spot), text: `${t} ${a}/${k}/${b}: ${legTxt(legs)} · credit +${f2(f.cash)} pts, worth up to ${k - a} more at expiry${fitTxt(f)}` });
        }
      }
      return byDist(out);
    },
    suggest(h, p) {
      const n = Math.max(1, Math.round(p.wing));
      return { legs: [L('B', h.side, sig(-n)), L('S', h.side, sig(0), { lots: 2 }), L('B', h.side, sig(n))] };
    },
  },
  {
    // Long box = bull call spread + bear put spread on k1 < k2: pays exactly k2 − k1 at expiry, so it is worth
    // (k2 − k1) discounted at the risk-free rate.
    id: 'box', name: 'Box spread arbitrage', group: 'Arbitrage',
    desc: 'A box (bull call spread + bear put spread between two strikes) pays exactly the strike gap at expiry, but can be bought for less, or sold for more, than that amount discounted to today.',
    how: 'Cheap: buy the box (buy the lower call and higher put, sell the higher call and lower put). Rich: sell it (the reverse). The difference to its fair value is locked in at expiry.',
    dirs: ['cheap', 'rich'], cooldown: 15,
    ease: { rank: 1, why: 'All four legs sit in the most liquid strikes and the payout at expiry is fixed.', watch: 'Four orders: the fixed brokerage needs several lots to be covered. A sold box blocks margin until expiry.' },
    params: [P('minEdge', 'Min edge', 2, 0.5, 'pts'), P('band', 'Strikes ± ATM', 8, 1, '', 1), P('maxGap', 'Max box width', 6, 1, 'strikes', 1), ...FILL],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i < hi; i++) {
        for (let j = i + 1; j <= Math.min(hi, i + p.maxGap); j++) {
          const [k1, k2] = [c.ks[i], c.ks[j]];
          const fair = (k2 - k1) * c.df;
          const long = [{ act: 'B', k: k1, t: 'CE', n: 1 }, { act: 'S', k: k2, t: 'CE', n: 1 }, { act: 'B', k: k2, t: 'PE', n: 1 }, { act: 'S', k: k1, t: 'PE', n: 1 }];
          const short = long.map((l) => ({ ...l, act: l.act === 'B' ? 'S' : 'B' }));
          for (const [dir, legs] of [['cheap', long], ['rich', short]]) {
            const f = fill(c, legs, p);
            if (!f) continue;
            const edge = dir === 'cheap' ? fair + f.cash : f.cash - fair; // cash < 0 when buying
            if (edge < p.minEdge) continue;
            out.push({ strike: k1, ref: k2, side: null, dir, value: edge, unit: 'pts', arb: true, fit: f.fit, dist: Math.min(Math.abs(k1 - c.spot), Math.abs(k2 - c.spot)), text: `${k1}/${k2} box ${dir === 'cheap' ? 'bought' : 'sold'} at ${f2(Math.abs(f.cash))} vs fair ${f2(fair)}: +${f2(edge)} pts${fitTxt(f)}` });
            break;
          }
        }
      }
      return byDist(out);
    },
    suggest(h) {
      // hit = lower strike, ref = higher strike
      const [b, s] = h.dir === 'cheap' ? ['B', 'S'] : ['S', 'B'];
      return { legs: [L(b, 'CE', sig(0)), L(s, 'CE', sig(0, 'ref')), L(b, 'PE', sig(0, 'ref')), L(s, 'PE', sig(0))] };
    },
  },
  {
    // A European call with more time is worth at least the nearer one: at the near expiry the short call costs
    // max(S − K, 0) and the long one is still worth ≥ S − K·df ≥ that. (Not true for deep ITM European puts,
    // which can be worth less with more time, so only calls.)
    id: 'cal', name: 'Calendar arbitrage (calls)', group: 'Arbitrage', needsNext: true,
    desc: "A call on the next expiry can be bought for less than the same strike's call on this expiry sells for, although the longer-dated call is always worth at least as much.",
    how: "Sell this expiry's call and buy the next expiry's call at the same strike for a credit; at this expiry the long call is worth at least what the short one costs, so close it then (or hold it).",
    dirs: ['inverted'], cooldown: 15,
    ease: { rank: 5, why: 'Rare, and the quotes of the next expiry are wider than those of this one.', watch: 'After the near expiry you still hold the long call and have to sell it.' },
    params: [P('minEdge', 'Min credit', 0.5, 0.25, 'pts'), P('band', 'Strikes ± ATM', 5, 1, '', 1), ...FILL],
    detect(c, p) {
      const nx = c.next?.();
      if (!nx) return [];
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const k = c.ks[i];
        if (!nx.idx.has(k)) continue;
        const legs = [{ act: 'S', k, t: 'CE', n: 1 }, { act: 'B', k, t: 'CE', n: 1, next: true }];
        const f = fill(c, legs, p);
        if (!f || f.cash < p.minEdge) continue;
        out.push({ strike: k, side: 'CE', dir: 'inverted', value: f.cash, unit: 'pts', arb: true, fit: f.fit, dist: Math.abs(k - c.spot), text: `${k} CE: ${legTxt(legs)} · credit +${f2(f.cash)} pts${fitTxt(f)}` });
      }
      return byDist(out);
    },
    suggest() {
      return { legs: [L('S', 'CE', sig(0)), L('B', 'CE', sig(0), { expiry: 'next' })] };
    },
  },
  {
    // Not a risk-free arbitrage like the ones above: a relative-value signal. Fair value of an option = Black-76 on
    // the chain's own synthetic forward, at the volatility its neighbouring strikes trade at (a quadratic through
    // the out-of-the-money vols of the nearest strikes either side, leaving the strike itself out). An option that
    // can be sold above / bought below that by more than the thresholds is out of line with the rest of the chain.
    id: 'fv', name: 'Fair value deviation', group: 'Arbitrage', maxLive: 12,
    desc: "An option trades away from its fair value: the Black-76 price on the chain's own forward at the volatility its neighbouring strikes imply. Rich = it can be sold above fair value, cheap = it can be bought below it. A statistical edge (prices tend to come back in line), not a locked-in profit.",
    how: 'Rich: sell the option and buy the next strike further out of the money, so you collect the overpricing with a capped risk. Cheap: buy the option and sell the next strike further out. You gain when the price returns to fair value (often within minutes: take the deviation as the target and exit), or at expiry if the mispricing held. For a pure fair-value trade hedge the remaining delta with futures; without a hedge a move in Nifty can outweigh the edge.',
    dirs: ['rich', 'cheap'], cooldown: 15,
    ease: { rank: 2, why: 'The most frequent signal and only two legs, close to the money.', watch: 'Not risk-free: the gain comes only if the price returns to fair value, and a move in Nifty can outweigh it.' },
    params: [P('minEdge', 'Min deviation', 2, 0.5, 'pts'), P('minPct', 'Min deviation', 5, 1, '% of fair'), P('band', 'Strikes ± ATM', 10, 1, '', 1), ...FILL],
    detect(c, p) {
      if (c.late) return [];
      const { F, T, df } = c;
      // the smile is read from quote mids when there is an order book (live), else from fresh last trades
      const refPx = (k, t) => {
        if (!c.book) return c.px(k, t, p.fresh);
        const b = c.quote(k, t, 'bid');
        const a = c.quote(k, t, 'ask');
        return b && a ? (a + b) / 2 : null;
      };
      const x = c.ks.map((k) => Math.log(k / F));
      const vol = c.ks.map((k) => { const t = c.otmType(k); const px = refPx(k, t); return px ? b76iv(px, F, k, T, t === 'CE', df) : null; });
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const k = c.ks[i];
        const left = [];
        const right = [];
        for (let d = 1; d <= 6; d++) {
          if (left.length < 3 && vol[i - d] != null) left.push([x[i - d], vol[i - d]]);
          if (right.length < 3 && vol[i + d] != null) right.push([x[i + d], vol[i + d]]);
        }
        if (left.length < 2 || right.length < 2) continue; // no extrapolating past the quoted strikes
        const fv = quadAt([...left, ...right], x[i]);
        if (!(fv > 0.01)) continue;
        for (const t of ['CE', 'PE']) {
          const fair = b76(F, k, T, fv, t === 'CE', df);
          if (!(fair >= p.minPx)) continue;
          for (const [dir, act] of [['rich', 'S'], ['cheap', 'B']]) {
            const f = fill(c, [{ act, k, t, n: 1 }], p); // sell at the bid / buy at the ask (history: last trade)
            if (!f) continue;
            const mkt = Math.abs(f.cash);
            const edge = dir === 'rich' ? mkt - fair : fair - mkt;
            const pct = (edge / fair) * 100;
            if (edge < p.minEdge || pct < p.minPct) continue;
            const mv = b76iv(mkt, F, k, T, t === 'CE', df);
            out.push({
              strike: k, side: t, dir, value: edge, unit: 'pts', fit: f.fit, dist: Math.abs(k - c.spot),
              fair: r2(fair), mkt: r2(mkt), pct: r2(pct), ivFair: r2(fv * 100), ivMkt: mv == null ? null : r2(mv * 100),
              text: `${k} ${t} ${dir === 'rich' ? 'sells' : 'buys'} at ${f2(mkt)} vs fair value ${f2(fair)}: ${dir} by ${f2(edge)} pts (${pct.toFixed(1)}%)${mv == null ? '' : ` · IV ${(mv * 100).toFixed(1)}% vs ${(fv * 100).toFixed(1)}% at the neighbouring strikes`}${fitTxt(f)}`,
            });
            break;
          }
        }
      }
      return out.sort((a, b) => b.value - a.value); // biggest deviation first
    },
    suggest(h) {
      // the option itself against the next strike further out of the money (calls: above, puts: below)
      const out = h.side === 'PE' ? -1 : 1;
      const side = h.side || 'CE';
      return h.dir === 'cheap'
        ? { legs: [L('B', side, sig(0)), L('S', side, sig(out))] }
        : { legs: [L('S', side, sig(0)), L('B', side, sig(out))] };
    },
  },
];
const r2 = (x) => Math.round(x * 100) / 100;
// Least-squares quadratic through [x, y] points, evaluated at x0 (falls back to a line, then the mean).
function quadAt(pts, x0) {
  const n = pts.length;
  if (!n) return null;
  let [s1, s2, s3, s4, t0, t1, t2] = [0, 0, 0, 0, 0, 0, 0];
  for (const [xa, y] of pts) { const u = xa - x0; s1 += u; s2 += u * u; s3 += u ** 3; s4 += u ** 4; t0 += y; t1 += u * y; t2 += u * u * y; }
  // normal equations for y = a + b·u + c·u² (u = x − x0, so the value at x0 is a), by Cramer's rule
  const det = n * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  const scale = n * s2 * s4;
  if (n >= 3 && Math.abs(det) > 1e-9 * Math.abs(scale)) {
    return (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
  }
  const dl = n * s2 - s1 * s1;
  return n >= 2 && Math.abs(dl) > 1e-12 ? (t0 * s2 - s1 * t1) / dl : t0 / n;
}
// Whether the lower strike is the one bought: calls with a free credit, puts priced over the width.
function lowBuys(side, dir) { return (side === 'CE') === (dir === 'free-credit'); }
const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

function params(type, given) {
  const t = BY_ID.get(type);
  const out = {};
  for (const p of t?.params || []) {
    const v = Number(given?.[p.k]);
    out[p.k] = given?.[p.k] == null || given[p.k] === '' || !Number.isFinite(v) ? p.def : v;
  }
  return out;
}

function detect(type, ctx, given) {
  const t = BY_ID.get(type);
  if (!t) return [];
  try {
    return t.detect(ctx, params(type, given)).map((h) => ({ type, ...h }));
  } catch {
    return [];
  }
}

function suggest(hit, given) {
  const t = BY_ID.get(hit.type);
  return t ? t.suggest(hit, params(hit.type, given)) : { legs: [] };
}

// Public description of the detectors for the page. `ease` = how tradable the type is (rank 1 = easiest to
// execute without slippage), why, and what to watch for.
// templates[dir][side] = the suggested trade for that direction (side matters only when `sided`).
const catalog = () => TYPES.map(({ id, name, group, desc, how, dirs, params: ps, cooldown, ease, suggest: sg }) => {
  const templates = Object.fromEntries(dirs.map((d) => [d, {
    CE: sg({ type: id, dir: d, side: 'CE', strike: 0 }, params(id)),
    PE: sg({ type: id, dir: d, side: 'PE', strike: 0 }, params(id)),
  }]));
  const sided = dirs.some((d) => JSON.stringify(templates[d].CE) !== JSON.stringify(templates[d].PE));
  return { id, name, group, desc, how, dirs, params: ps, cooldown, ease, templates, sided };
});

// Worst value at expiry of a set of resolved legs ({dir, type, strike, qty: lots, px}), over a spot grid.
// > 0 means the trade cannot lose at expiry (an arbitrage at those fill prices).
function worstAtExpiry(legs, spot) {
  let worst = Infinity;
  for (let i = 0; i <= 400; i++) {
    const S = spot * (0.8 + (0.4 * i) / 400);
    let v = 0;
    for (const l of legs) v += l.dir * l.qty * (Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S) - l.px);
    worst = Math.min(worst, v);
  }
  return worst;
}

module.exports = { Chain, TYPES, BY_ID, catalog, detect, suggest, params, worstAtExpiry, tradingYears, b76, b76iv, ncdf, RATE };
