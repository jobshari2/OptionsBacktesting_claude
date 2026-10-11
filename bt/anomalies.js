// Option-pricing scanners for the Nifty chain: no-arbitrage bounds (vertical spread, butterfly, broken-wing
// butterfly, box, calendar) and one relative-value signal (fair value deviation). The same detectors run on live
// snapshots and on historical 1-minute candles, so a scan, a backtest and the live screen all agree on what fired.
//
// Every detector works on a chain context (see Chain below): one expiry at one moment — spot, the strikes
// around ATM with their prices, plus lazily computed forward, implied vols and deltas, the context N
// minutes earlier, the next expiry's context, and the recent realised volatility.
//
// Implied vols use Black-76 on the synthetic forward (median of K + (C − P)·e^{rT} near ATM), so calls and
// puts at a strike get consistent vols and the smile is read from out-of-the-money options. Volatility time is
// counted in trading minutes (252 sessions of 375 minutes a year): with calendar time, IV appears to
// triple through expiry day and can't be compared with realised vol or across the day. Money is discounted over
// calendar time (interest accrues over nights and weekends too).
const { RATE, ncdf, b76, b76iv } = require('../lib/pricing');
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

// Calendar years from minute `minute` (0 = 09:15 IST) of `day` to 15:30 IST on `expiry`.
function calendarYears(expiry, day, minute) {
  const ms = Date.parse(expiry + 'T10:00:00Z') - (Date.parse(day + 'T03:45:00Z') + minute * 60_000);
  return Math.max(0, ms) / (365 * 86400_000);
}

// ---------- Black-76 (b76, b76iv: lib/pricing.js) ----------
const d1Of = (F, K, T, v) => (Math.log(F / K) + (v * v * T) / 2) / (v * Math.sqrt(T));

// ---------- chain context ----------
// base: { spot, T (trading years), Tc (calendar years, for discounting; T when left out), ks (sorted strikes),
//         ce, pe (prices aligned with ks; null/0 = missing),
//         ageCe, agePe (optional: minutes since each contract last traded),
//         ceHi, ceLo, peHi, peLo (history: this minute's high / low where the contract traded in it, else 0),
//         book (true when the chain carries an order book: live), ceBid, ceAsk, peBid, peAsk (best quotes),
//         ceBidQ, ceAskQ, peBidQ, peAskQ (quantity at those quotes), lot (lot size, for the quantities),
//         ceVol, peVol, ceOi, peOi (live: units traded today and open interest),
//         ceAt, peAt (live: when each quote was last refreshed, ms), now (when the chain was sampled, ms),
//         expiry, day, minute (0 = 09:15),
//         open (Nifty at 09:15), rv(n) -> annualised realised vol over n sessions, prev(n) -> Chain n minutes
//         earlier, next() -> Chain of the next expiry, dayIv() -> ATM IV at 09:20 }
class Chain {
  constructor(base) {
    Object.assign(this, base);
    this.T = Math.max(this.T, 10 / YEAR_MIN); // the last minutes of expiry day: keep the maths finite
    this.Tc = this.Tc ?? this.T;
    this.df = Math.exp(-RATE * this.Tc);
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
  // One of the per-strike arrays (`what`: 'Bid', 'Ask', 'BidQ', 'AskQ', 'Vol', 'Oi', 'At', 'Hi', 'Lo'), or null.
  col(k, type, what) {
    const i = this.idx.get(k);
    const v = i == null ? null : this[(type === 'CE' ? 'ce' : 'pe') + what]?.[i];
    return v == null ? null : v;
  }
  // Best bid / ask (side 'bid' | 'ask') when the chain carries quotes (live), else null.
  quote(k, type, side) {
    const v = this.col(k, type, side === 'bid' ? 'Bid' : 'Ask');
    return v > 0 ? v : null;
  }
  // Quantity (units) waiting at the best bid / ask, or null.
  quoteQty(k, type, side) {
    const v = this.col(k, type, side === 'bid' ? 'BidQ' : 'AskQ');
    return v > 0 ? v : null;
  }
  // Seconds since the quote was last refreshed (live), or null.
  quoteAge(k, type) {
    const at = this.col(k, type, 'At');
    return at && this.now ? Math.max(0, (this.now - at) / 1000) : null;
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
  get atm() {
    return this.ks[this.ai];
  }
  // The last 90 minutes before expiry: IVs are dominated by pinning and tiny time values, so the
  // volatility detectors stay quiet then.
  get late() {
    return this.T * YEAR_MIN < 90;
  }
  at(i) {
    return i >= 0 && i < this.ks.length ? this.ks[i] : null;
  }
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
  // Put-call parity strike by strike (live): what the forward costs through that strike's synthetic (call bought at
  // the ask, put sold at the bid) and what it pays when sold (call at the bid, put at the ask). Parity holds when
  // every strike's band overlaps every other's; a strike that sells above where another buys is a box arbitrage.
  parity(n = 8) {
    const rows = [];
    for (let i = Math.max(0, this.ai - n); i <= Math.min(this.ks.length - 1, this.ai + n); i++) {
      const k = this.ks[i];
      const [cb, ca, pb, pa] = [this.quote(k, 'CE', 'bid'), this.quote(k, 'CE', 'ask'), this.quote(k, 'PE', 'bid'), this.quote(k, 'PE', 'ask')];
      if (!cb || !ca || !pb || !pa || cb > ca || pb > pa) continue;
      rows.push({ k, cb, ca, pb, pa, buy: k + (ca - pb) / this.df, sell: k + (cb - pa) / this.df });
    }
    return rows;
  }
  iv(k, type) {
    const key = k + type;
    if (!this._iv.has(key)) {
      const p = this.px(k, type);
      this._iv.set(key, p ? b76iv(p, this.F, k, this.T, type === 'CE', this.df) : null);
    }
    return this._iv.get(key);
  }
  otmType(k) {
    return k >= this.F ? 'CE' : 'PE';
  }
  otmIv(k) {
    return this.iv(k, this.otmType(k));
  }
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
const Q = (...a) => ({ ...P(...a), q: true });
const sig = (value, ref = 'hit') => ({ by: 'signal', value, ref });
const L = (action, type, strike, o = {}) => ({ action, type, lots: o.lots || 1, expiry: o.expiry || 'cur', strike, sl: o.sl || null, tgt: o.tgt || null });
const band = (c, n) => [Math.max(0, c.ai - n), Math.min(c.ks.length - 1, c.ai + n)];
const f2 = (x) => x.toFixed(2);
const lotsTxt = (n) => `${n} lot${n === 1 ? '' : 's'}`;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Data-quality and liquidity gates, the same for every type (q: true): only what can actually be traded is
// reported. Live, a leg needs a two-sided, uncrossed quote that is fresh, tight and deep enough, on a contract that
// has traded today and has open interest; the live scanner also wants to see an opportunity for `hold` seconds
// before it counts (the quotes of a snapshot arrive a few hundred milliseconds apart, and a violation that is gone
// on the next scan was usually just that). History has no order book, volume or open interest: a leg must have
// traded within the last `fresh` minutes and be no further in the money than `maxItm` points (a recorded session
// had spreads under 1 point up to 300 points in the money and several points beyond 500, where single-lot prints
// far from the quote make most of the "mispricings" of a candle history).
const QUALITY = [
  Q('minLots', 'Fillable ≥', 1, 1, 'lots (live)', 1),
  Q('maxSpread', 'Spread ≤', 3, 0.5, 'pts (live)'),
  Q('maxSpreadPct', 'or spread ≤', 1, 0.25, '% of premium'),
  Q('minVol', 'Volume ≥', 500, 100, 'lots today (live)'),
  Q('minOi', 'Open interest ≥', 5000, 500, 'lots (live)'),
  Q('maxAge', 'Quote age ≤', 15, 5, 's (live, 0 = any)'),
  Q('hold', 'Seen for ≥', 5, 5, 's (live scanner)'),
  Q('fresh', 'Traded within', 1, 1, 'min (history)'),
  Q('maxItm', 'In the money ≤', 300, 50, 'pts (history, 0 = any)'),
  Q('minPx', 'Min premium', 0.05, 0.05, '₹'),
];

// What a structure costs or pays at the touch, or why it cannot be traded there. legs: [{ act: 'B' | 'S', k,
// t: 'CE' | 'PE', n: units per structure, next: true for the next expiry }].
// With an order book (live) sells go at the bid and buys at the ask, and every leg must pass the quality gates —
// a quote nobody stands behind is not an arbitrage. Without one (history) every leg must have traded within the
// last `fresh` minutes, at its last price.
// Returns { ok: true, cash (net credit, + = received), fit (whole structures the book can fill, live), pxs (the
// price of each leg) } or { ok: false, code, why }.
function fill(c, legs, p) {
  const no = (code, why) => ({ ok: false, code, why });
  const pxs = [];
  let cash = 0;
  let fit = Infinity;
  for (const l of legs) {
    const ch = l.next ? c.next?.() : c;
    if (!ch) return no('data', 'no chain for the next expiry');
    const name = `${l.k} ${l.t}${l.next ? ' (next expiry)' : ''}`;
    let px;
    if (ch.book) {
      const bid = ch.quote(l.k, l.t, 'bid');
      const ask = ch.quote(l.k, l.t, 'ask');
      const side = l.act === 'S' ? 'bid' : 'ask';
      if (!bid || !ask) return no('quote', `${name}: no ${bid ? 'ask' : 'bid'}`);
      if (bid > ask) return no('crossed', `${name}: crossed quote (bid ${f2(bid)} above ask ${f2(ask)})`);
      px = side === 'bid' ? bid : ask;
      const sp = ask - bid;
      const pct = (sp / ((ask + bid) / 2)) * 100;
      if (sp > p.maxSpread && pct > p.maxSpreadPct) return no('spread', `${name}: spread ${f2(sp)} pts (${pct.toFixed(1)}% of premium)`);
      const age = ch.quoteAge(l.k, l.t);
      if (p.maxAge > 0 && age != null && age > p.maxAge) return no('stale', `${name}: quote is ${Math.round(age)} s old`);
      const lot = ch.lot || 1;
      // a recorded tape without quantities (depth: false) cannot be checked for size
      const lots = ch.depth === false ? Infinity : Math.floor((ch.quoteQty(l.k, l.t, side) || 0) / (lot * l.n));
      if (lots < p.minLots)
        return no('depth', `${name}: ${lotsTxt(lots)} at the ${side}${l.n > 1 ? ` (${l.n} needed per structure)` : ''}, ${p.minLots} wanted`);
      const vol = ch.col(l.k, l.t, 'Vol');
      if (p.minVol > 0 && vol != null && vol / lot < p.minVol) return no('volume', `${name}: only ${lotsTxt(Math.round(vol / lot))} traded today`);
      const oi = ch.col(l.k, l.t, 'Oi');
      if (p.minOi > 0 && oi != null && oi / lot < p.minOi) return no('oi', `${name}: open interest only ${lotsTxt(Math.round(oi / lot))}`);
      fit = Math.min(fit, lots);
    } else {
      px = ch.px(l.k, l.t, p.fresh);
      if (!px) return no('stale', `${name}: no trade within ${p.fresh} min`);
      // nothing to judge liquidity by: far in the money a last trade is often one lot, well away from the quote
      const itm = l.t === 'CE' ? ch.spot - l.k : l.k - ch.spot;
      if (p.maxItm > 0 && itm > p.maxItm) return no('depth', `${name}: ${Math.round(itm)} pts in the money`);
    }
    if (px < p.minPx) return no('price', `${name}: premium ${f2(px)} is below the minimum`);
    cash += (l.act === 'S' ? 1 : -1) * l.n * px;
    pxs.push(px);
  }
  return { ok: true, cash, fit: Number.isFinite(fit) ? fit : null, pxs };
}

// The same structure at reference prices that are NOT executable: quote mids ('mid') or last trades ('last').
// null when a leg has no such price.
function refCash(c, legs, basis) {
  let cash = 0;
  for (const l of legs) {
    const ch = l.next ? c.next?.() : c;
    if (!ch) return null;
    let px;
    if (basis === 'mid') {
      const b = ch.quote(l.k, l.t, 'bid');
      const a = ch.quote(l.k, l.t, 'ask');
      px = b && a && b <= a ? (a + b) / 2 : null;
    } else px = ch.px(l.k, l.t);
    if (!px) return null;
    cash += (l.act === 'S' ? 1 : -1) * l.n * px;
  }
  return cash;
}

// History: the worst price a leg could have been filled at in a minute it traded in — the bar's high for a buy,
// its low for a sell. A minute with a single traded price does not say which side of the book traded, so the other
// side is taken a full permitted spread (`pct` % of the premium, at least one tick) away.
const TICK = 0.05;
function worstPx(hi, lo, buy, pct) {
  if (hi > lo) return buy ? hi : lo;
  const pad = Math.max(TICK, (hi * pct) / 100);
  return buy ? hi + pad : Math.max(TICK, lo - pad);
}

// History: the structure at the worst prices that traded in this minute, so the result holds whatever order the
// trades of that minute came in. null when a leg did not trade in the minute (or the chain has no bars: live).
function worstCash(c, legs, p) {
  let cash = 0;
  for (const l of legs) {
    const ch = l.next ? c.next?.() : c;
    const hi = ch?.col(l.k, l.t, 'Hi');
    if (!(hi > 0)) return null;
    cash += (l.act === 'S' ? 1 : -1) * l.n * worstPx(hi, ch.col(l.k, l.t, 'Lo'), l.act === 'B', p.maxSpreadPct);
  }
  return cash;
}

// One candidate structure of an arbitrage type. `floor` = the least the structure is worth when it ends, in points
// (0 for a spread that cannot lose, +width for a bought box, −width for a sold box or a vertical sold above its
// width). Money received later is discounted and money owed later is not (a credit earns no interest in a trading
// account), so the edge errs on the safe side:
//   edge = cash at the touch + (floor > 0 ? floor · df : floor)
// Returns the fill with its edge, the cash it locks in at expiry and (history) the edge at the minute's worst
// prices, or null when the edge is below the minimum. A structure that looks like an arbitrage only at quote mids
// or at last-traded prices is noted in p.rej when rejections are being collected (the live scanner).
function assess(c, p, legs, floor, label) {
  const pv = floor > 0 ? floor * c.df : floor;
  const f = fill(c, legs, p);
  if (f.ok && f.cash + pv >= p.minEdge) {
    const w = c.book ? null : worstCash(c, legs, p);
    return { ...f, edge: f.cash + pv, locked: f.cash + floor, robust: w == null ? null : w + pv, pv };
  }
  if (p.rej) {
    for (const basis of ['mid', 'last']) {
      const r = refCash(c, legs, basis);
      if (r == null || r + pv < p.minEdge) continue;
      const touch = f.ok ? f.cash + pv : null;
      p.rej.push({
        label,
        basis,
        apparent: r + pv,
        touch,
        code: f.ok ? 'touch' : f.code,
        why: f.ok ? (touch > 0 ? `at the bid / ask only ${f2(touch)} pts are left` : `at the bid / ask it loses ${f2(-touch)} pts`) : f.why,
        st: legs,
      });
      break;
    }
  }
  return null;
}
const fitTxt = (f) => (f.fit == null ? '' : ` · ${lotsTxt(f.fit)} fillable`);
const legTxt = (legs) => legs.map((l) => `${l.act === 'B' ? 'BUY' : 'SELL'} ${l.n > 1 ? l.n + '× ' : ''}${l.k}${l.t}${l.next ? ' next' : ''}`).join(' + ');
const byDist = (out) => out.sort((x, y) => x.dist - y.dist || y.value - x.value);
// The fields every arbitrage hit carries: the edge, the cash it locks in at expiry, how much the book fills, the
// edge at the minute's worst prices (history), today's value of its floor (so the edge can be re-priced at other
// fills: edge = cash + pv) and its exact legs.
const arbHit = (a, legs) => ({ value: a.edge, unit: 'pts', arb: true, fit: a.fit, locked: a.locked, robust: a.robust, pv: a.pv, st: legs });

// ---------- the detectors ----------
// cls 'arb': a no-arbitrage bound on one chain of Nifty's European, cash-settled options — the suggested trade
// cannot lose if held to expiry (the calendar: to the near expiry), before brokerage and taxes.
// cls 'rv' (fair value deviation): a relative-value signal — an edge, not a locked-in profit.
const TYPES = [
  {
    // Same rules as the builder's "Vertical spread arbitrage" list (public/sb-view.js findArbs). For one expiry
    // and one option type, a vertical spread is always worth between 0 and its width (strike gap):
    //   calls: C(lo) < C(hi)            -> buy lo, sell hi (paid to take a spread that cannot lose)
    //          C(lo) − C(hi) > hi − lo  -> sell lo, buy hi (credit above the most it can ever cost)
    //   puts : P(lo) > P(hi)            -> sell lo, buy hi
    //          P(hi) − P(lo) > hi − lo  -> sell hi, buy lo
    id: 'varb',
    name: 'Vertical spread arbitrage',
    group: 'Arbitrage',
    cls: 'arb',
    desc: 'Two strikes of the same type break the no-arbitrage bounds of a vertical spread: the further-OTM option is dearer than the nearer one (free credit), or the pair is priced further apart than the strike gap (credit above width).',
    how: 'Free credit: buy the nearer-ITM strike and sell the further one for a credit. Credit above width: sell the nearer-ITM strike and buy the further one for more than the spread can ever cost. Either way the trade cannot lose at expiry, before costs.',
    formula: 'Calls: 0 ≤ C(K1) − C(K2) ≤ K2 − K1. Puts: 0 ≤ P(K2) − P(K1) ≤ K2 − K1 (K1 < K2, same expiry). Monotonicity in the strike and the width bound.',
    assumes: 'European, cash-settled options held to expiry; both legs filled at the quoted bid / ask. The width bound is not discounted (the stricter test).',
    dirs: ['free-credit', 'over-width'],
    cooldown: 10,
    ease: {
      rank: 5,
      why: 'Only two legs, but the violations mostly sit in deep in-the-money strikes where quotes are thin.',
      watch: 'A long leg that finishes in the money pays exercise STT on its full value; that can exceed a small edge.',
    },
    params: [P('minEdge', 'Min edge', 0.5, 0.25, 'pts'), P('band', 'Strikes ± ATM', 10, 1, '', 1), P('maxGap', 'Max strikes apart', 20, 1, '', 1), ...QUALITY],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (const t of ['CE', 'PE']) {
        // history: only sane prices — a stale print below intrinsic value (no implied vol) is not tradeable.
        // Live the quotes decide, whatever the last trade was.
        const ks = c.ks.slice(lo, hi + 1).filter((k) => (c.book ? c.quote(k, t, 'bid') || c.quote(k, t, 'ask') : c.px(k, t) > 0 && c.iv(k, t) != null));
        for (let i = 0; i < ks.length; i++) {
          for (let j = i + 1; j < ks.length && j - i <= p.maxGap; j++) {
            const [a, b] = [ks[i], ks[j]];
            const w = b - a;
            const nearBuy =
              t === 'CE'
                ? [
                    ['B', a],
                    ['S', b],
                  ]
                : [
                    ['S', a],
                    ['B', b],
                  ]; // free credit
            const nearSell =
              t === 'CE'
                ? [
                    ['S', a],
                    ['B', b],
                  ]
                : [
                    ['S', b],
                    ['B', a],
                  ]; // credit above width
            for (const [dir, pairs, floor] of [
              ['free-credit', nearBuy, 0],
              ['over-width', nearSell, -w],
            ]) {
              const legs = pairs.map(([act, k]) => ({ act, k, t, n: 1 }));
              const r = assess(c, p, legs, floor, `${t} ${a}/${b} vertical, ${dir}`);
              if (!r) continue;
              out.push({
                strike: a,
                ref: b,
                side: t,
                dir,
                ...arbHit(r, legs),
                dist: Math.min(Math.abs(a - c.spot), Math.abs(b - c.spot)),
                text: `${t} ${a}/${b}: ${legTxt(legs)} · ${dir === 'free-credit' ? 'free credit' : `credit above the ${w}-pt width`} +${f2(r.edge)} pts${fitTxt(r)}`,
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
    id: 'fly',
    name: 'Butterfly arbitrage',
    group: 'Arbitrage',
    cls: 'arb',
    desc: 'Three equally spaced strikes of the same type are not convex: the long butterfly (buy 1 low, sell 2 middle, buy 1 high) can be put on for a credit.',
    how: 'Buy the butterfly for a credit: it is worth zero or more at expiry, so the credit is the minimum gain (up to credit + wing width if Nifty finishes at the body).',
    formula: 'C(K − w) − 2·C(K) + C(K + w) ≥ 0, and the same for puts: prices are convex in the strike.',
    assumes: 'European, cash-settled options held to expiry; all three legs filled at the quoted bid / ask, the body for twice the quantity.',
    dirs: ['credit'],
    cooldown: 10,
    ease: {
      rank: 3,
      why: 'Liquid when centred near the money; the body needs twice the quantity on the book.',
      watch: 'Three orders: if the body fills and a wing does not, you are left with a naked short.',
    },
    params: [P('minEdge', 'Min credit', 0.5, 0.25, 'pts'), P('wing', 'Wing width', 1, 1, 'strikes', 1), P('band', 'Strikes ± ATM', 10, 1, '', 1), ...QUALITY],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const n = Math.max(1, Math.round(p.wing));
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const [a, k, b] = [c.at(i - n), c.ks[i], c.at(i + n)];
        if (a == null || b == null || k - a !== b - k) continue;
        for (const t of ['CE', 'PE']) {
          const legs = [
            { act: 'B', k: a, t, n: 1 },
            { act: 'S', k, t, n: 2 },
            { act: 'B', k: b, t, n: 1 },
          ];
          const r = assess(c, p, legs, 0, `${t} ${a}/${k}/${b} butterfly`);
          if (!r) continue;
          out.push({
            strike: k,
            side: t,
            dir: 'credit',
            ...arbHit(r, legs),
            dist: Math.abs(k - c.spot),
            text: `${t} ${a}/${k}/${b}: ${legTxt(legs)} · credit +${f2(r.edge)} pts, worth up to ${k - a} more at expiry${fitTxt(r)}`,
          });
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
    // Convexity with unequal strike spacing. For K1 < K2 < K3 the strike-weighted butterfly
    //   (K3 − K2)·X(K1) − (K3 − K1)·X(K2) + (K2 − K1)·X(K3)        (X = calls or puts)
    // is worth ≥ 0 at expiry: zero outside [K1, K3], peaking at K2. Divided by the common factor it is whole
    // lots, e.g. 50 / 100-point wings = buy 2, sell 3, buy 1.
    id: 'bwfly',
    name: 'Broken-wing butterfly arbitrage',
    group: 'Arbitrage',
    cls: 'arb',
    desc: 'Three unequally spaced strikes of the same type are not convex: the strike-weighted butterfly (more lots on the narrow wing, so the payoff never goes below zero) can be put on for a credit.',
    how: 'Buy the weighted butterfly for a credit, e.g. with a 1-strike and a 2-strike wing: buy 2 of the near wing, sell 3 of the body, buy 1 of the far wing. It is worth zero or more at expiry, so the credit is the minimum gain.',
    formula: '(K3 − K2)·C(K1) − (K3 − K1)·C(K2) + (K2 − K1)·C(K3) ≥ 0 for K1 < K2 < K3, and the same for puts: convexity with unequal spacing.',
    assumes: 'European, cash-settled options held to expiry; all three legs filled at the quoted bid / ask in the weighted quantities.',
    dirs: ['high-wide', 'low-wide'],
    cooldown: 10,
    ease: {
      rank: 4,
      why: 'Catches convexity breaks an equal-wing butterfly misses, but it trades more lots across three strikes.',
      watch: 'Three orders in unequal quantities: a missed wing leaves several naked shorts. More lots mean more brokerage and STT.',
    },
    params: [
      P('minEdge', 'Min credit', 0.5, 0.25, 'pts'),
      P('near', 'Narrow wing', 1, 1, 'strikes', 1),
      P('far', 'Wide wing', 2, 1, 'strikes', 2),
      P('band', 'Strikes ± ATM', 10, 1, '', 1),
      ...QUALITY,
    ],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const k = c.ks[i];
        for (const dir of this.dirs) {
          const [n1, n2] = bwWings(p, dir);
          const [a, b] = [c.at(i - n1), c.at(i + n2)];
          if (a == null || b == null || k - a === b - k) continue; // equal wings are the plain butterfly
          const g = gcd(Math.round(b - k), Math.round(k - a));
          const [wa, wb] = [(b - k) / g, (k - a) / g];
          for (const t of ['CE', 'PE']) {
            const legs = [
              { act: 'B', k: a, t, n: wa },
              { act: 'S', k, t, n: wa + wb },
              { act: 'B', k: b, t, n: wb },
            ];
            const r = assess(c, p, legs, 0, `${t} ${a}/${k}/${b} broken-wing butterfly`);
            if (!r) continue;
            out.push({
              strike: k,
              side: t,
              dir,
              ...arbHit(r, legs),
              dist: Math.abs(k - c.spot),
              text: `${t} ${a}/${k}/${b}: ${legTxt(legs)} · credit +${f2(r.edge)} pts, worth up to ${wa * (k - a)} more at expiry${fitTxt(r)}`,
            });
          }
        }
      }
      return byDist(out);
    },
    suggest(h, p) {
      // lots follow the wing widths in strikes (the chain's strikes are evenly spaced near the money)
      const [n1, n2] = bwWings(p, h.dir);
      const g = gcd(n1, n2);
      return { legs: [L('B', h.side, sig(-n1), { lots: n2 / g }), L('S', h.side, sig(0), { lots: (n1 + n2) / g }), L('B', h.side, sig(n2), { lots: n1 / g })] };
    },
  },
  {
    // Long box = bull call spread + bear put spread on k1 < k2: pays exactly k2 − k1 at expiry, so it is worth
    // (k2 − k1) discounted at the risk-free rate. This is put-call parity at two strikes: the forward bought through
    // one strike's synthetic and sold through the other's.
    id: 'box',
    name: 'Box spread arbitrage',
    group: 'Arbitrage',
    cls: 'arb',
    desc: 'A box (bull call spread + bear put spread between two strikes) pays exactly the strike gap at expiry, but can be bought for less than that amount discounted to today, or sold for more than the gap itself. It is put-call parity checked across two strikes.',
    how: 'Cheap: buy the box (buy the lower call and higher put, sell the higher call and lower put) below its discounted width: you lend at more than the risk-free rate. Rich: sell it (the reverse) for more than the width it will cost at expiry.',
    formula: 'C(K1) − C(K2) + P(K2) − P(K1) = (K2 − K1)·e^(−rT). Bought: edge = (K2 − K1)·e^(−rT) − cost. Sold: edge = credit − (K2 − K1).',
    assumes:
      'European, cash-settled options held to expiry; all four legs filled at the quoted bid / ask; r = 6.5% a year over calendar days. A sold box is tested against the full width: the credit earns no interest in a trading account.',
    dirs: ['cheap', 'rich'],
    cooldown: 15,
    ease: {
      rank: 1,
      why: 'All four legs sit in the most liquid strikes and the payout at expiry is fixed.',
      watch:
        'Four orders: the fixed brokerage needs several lots to be covered, and the two long legs pay exercise STT on what they settle for. A sold box blocks margin until expiry.',
    },
    params: [P('minEdge', 'Min edge', 2, 0.5, 'pts'), P('band', 'Strikes ± ATM', 8, 1, '', 1), P('maxGap', 'Max box width', 6, 1, 'strikes', 1), ...QUALITY],
    detect(c, p) {
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i < hi; i++) {
        for (let j = i + 1; j <= Math.min(hi, i + p.maxGap); j++) {
          const [k1, k2] = [c.ks[i], c.ks[j]];
          const w = k2 - k1;
          const long = [
            { act: 'B', k: k1, t: 'CE', n: 1 },
            { act: 'S', k: k2, t: 'CE', n: 1 },
            { act: 'B', k: k2, t: 'PE', n: 1 },
            { act: 'S', k: k1, t: 'PE', n: 1 },
          ];
          const short = long.map((l) => ({ ...l, act: l.act === 'B' ? 'S' : 'B' }));
          for (const [dir, legs, floor] of [
            ['cheap', long, w],
            ['rich', short, -w],
          ]) {
            const r = assess(c, p, legs, floor, `${k1}/${k2} box, ${dir}`);
            if (!r) continue;
            const paid = Math.abs(r.cash);
            // the interest rate the box trades at: lent when bought, borrowed when sold (meaningless within a day of expiry)
            const rate = c.Tc > 1 / 365 && paid > 0 ? Math.log(w / paid) / c.Tc : null;
            out.push({
              strike: k1,
              ref: k2,
              side: null,
              dir,
              ...arbHit(r, legs),
              rate: rate == null ? null : r2(rate * 100),
              dist: Math.min(Math.abs(k1 - c.spot), Math.abs(k2 - c.spot)),
              text: `${k1}/${k2} box ${dir === 'cheap' ? `bought at ${f2(paid)} vs ${f2(w * c.df)} (its ${w}-pt width discounted)` : `sold at ${f2(paid)} vs its ${w}-pt width`}: +${f2(r.edge)} pts${fitTxt(r)}`,
            });
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
    // max(S − K, 0) and the long one is still worth ≥ S·e^(−qτ) − K·e^(−rτ), which is ≥ S − K for strikes near the
    // money while the interest rate exceeds Nifty's dividend yield. (Not true for deep ITM European puts, which can
    // be worth less with more time, so only calls.)
    id: 'cal',
    name: 'Calendar arbitrage (calls)',
    group: 'Arbitrage',
    cls: 'arb',
    needsNext: true,
    desc: "A call on the next expiry can be bought for less than the same strike's call on this expiry sells for, although the longer-dated call is always worth at least as much.",
    how: "Sell this expiry's call and buy the next expiry's call at the same strike for a credit; at this expiry the long call is worth at least what the short one costs, so close it then (or hold it).",
    formula: 'C(K, T2) ≥ C(K, T1) for T2 > T1, same strike.',
    assumes:
      "The interest rate stays above Nifty's dividend yield; both legs filled at the quoted bid / ask; at the near expiry the long call can be sold for at least its intrinsic value.",
    dirs: ['inverted'],
    cooldown: 15,
    ease: {
      rank: 6,
      why: 'Rare, and the quotes of the next expiry are wider than those of this one.',
      watch:
        'After the near expiry you still hold the long call and have to sell it: its bid can sit below intrinsic value. The two chains are quoted a few seconds apart.',
    },
    params: [P('minEdge', 'Min credit', 0.5, 0.25, 'pts'), P('band', 'Strikes ± ATM', 5, 1, '', 1), ...QUALITY],
    detect(c, p) {
      const nx = c.next?.();
      if (!nx) return [];
      const [lo, hi] = band(c, p.band);
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const k = c.ks[i];
        if (!nx.idx.has(k)) continue;
        const legs = [
          { act: 'S', k, t: 'CE', n: 1 },
          { act: 'B', k, t: 'CE', n: 1, next: true },
        ];
        const r = assess(c, p, legs, 0, `${k} CE calendar`);
        if (!r) continue;
        out.push({
          strike: k,
          side: 'CE',
          dir: 'inverted',
          ...arbHit(r, legs),
          dist: Math.abs(k - c.spot),
          text: `${k} CE: ${legTxt(legs)} · credit +${f2(r.edge)} pts${fitTxt(r)}`,
        });
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
    id: 'fv',
    name: 'Fair value deviation',
    group: 'Arbitrage',
    cls: 'rv',
    maxLive: 12,
    desc: "An option trades away from its fair value: the Black-76 price on the chain's own forward at the volatility its neighbouring strikes imply. Rich = it can be sold above fair value, cheap = it can be bought below it. A statistical edge (prices tend to come back in line), not a locked-in profit.",
    how: 'Rich: sell the option and buy the next strike further out of the money, so you collect the overpricing with a capped risk. Cheap: buy the option and sell the next strike further out. You gain when the price returns to fair value (often within minutes: take the deviation as the target and exit), or at expiry if the mispricing held. For a pure fair-value trade hedge the remaining delta with futures; without a hedge a move in Nifty can outweigh the edge.',
    formula:
      'Fair = Black-76(F, K, T, σ̂(K)): F = median of K + (C − P)·e^(rT) near the money, σ̂(K) = a quadratic in ln(K / F) through the out-of-the-money vols of up to 3 strikes either side, leaving K itself out. Deviation = bid − fair (rich) or fair − ask (cheap).',
    assumes: 'The smile is smooth across neighbouring strikes, so a kink at one strike is a mispricing and not information. Nothing is locked in.',
    dirs: ['rich', 'cheap'],
    cooldown: 15,
    ease: {
      rank: 2,
      why: 'The most frequent signal and only two legs, close to the money.',
      watch: 'Not risk-free: the gain comes only if the price returns to fair value, and a move in Nifty can outweigh it.',
    },
    params: [
      P('minEdge', 'Min deviation', 2, 0.5, 'pts'),
      P('minPct', 'Min deviation', 5, 1, '% of fair'),
      P('band', 'Strikes ± ATM', 10, 1, '', 1),
      ...QUALITY,
    ],
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
      const vol = c.ks.map((k) => {
        const t = c.otmType(k);
        const px = refPx(k, t);
        return px ? b76iv(px, F, k, T, t === 'CE', df) : null;
      });
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
          for (const [dir, act] of [
            ['rich', 'S'],
            ['cheap', 'B'],
          ]) {
            const legs = [{ act, k, t, n: 1 }];
            const f = fill(c, legs, p); // sell at the bid / buy at the ask (history: last trade)
            if (!f.ok) continue;
            const mkt = Math.abs(f.cash);
            const edge = dir === 'rich' ? mkt - fair : fair - mkt;
            const pct = (edge / fair) * 100;
            if (edge < p.minEdge || pct < p.minPct) continue;
            const mv = b76iv(mkt, F, k, T, t === 'CE', df);
            out.push({
              strike: k,
              side: t,
              dir,
              value: edge,
              unit: 'pts',
              fit: f.fit,
              dist: Math.abs(k - c.spot),
              st: legs,
              fair: r2(fair),
              mkt: r2(mkt),
              pct: r2(pct),
              ivFair: r2(fv * 100),
              ivMkt: mv == null ? null : r2(mv * 100),
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
      return h.dir === 'cheap' ? { legs: [L('B', side, sig(0)), L('S', side, sig(out))] } : { legs: [L('S', side, sig(0)), L('B', side, sig(out))] };
    },
  },
];
const r2 = (x) => Math.round(x * 100) / 100;
// Least-squares quadratic through [x, y] points, evaluated at x0 (falls back to a line, then the mean).
function quadAt(pts, x0) {
  const n = pts.length;
  if (!n) return null;
  let [s1, s2, s3, s4, t0, t1, t2] = [0, 0, 0, 0, 0, 0, 0];
  for (const [xa, y] of pts) {
    const u = xa - x0;
    s1 += u;
    s2 += u * u;
    s3 += u ** 3;
    s4 += u ** 4;
    t0 += y;
    t1 += u * y;
    t2 += u * u * y;
  }
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
function lowBuys(side, dir) {
  return (side === 'CE') === (dir === 'free-credit');
}
// Wings of the broken-wing butterfly in strikes below / above the body: the wide one above it ('high-wide') or below.
function bwWings(p, dir) {
  const near = Math.max(1, Math.round(p.near));
  const far = Math.max(near + 1, Math.round(p.far));
  return dir === 'low-wide' ? [far, near] : [near, far];
}
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

// Runs one type on a chain. With `rejects`, also returns the structures that look like an arbitrage at quote mids
// or last-traded prices but cannot be traded (the biggest apparent edges first) and how many there were.
function scan(type, ctx, given, { rejects = false } = {}) {
  const t = BY_ID.get(type);
  if (!t) return { hits: [], rejected: [], rejectedTotal: 0 };
  const p = params(type, given);
  if (rejects) p.rej = [];
  let hits = [];
  try {
    hits = t.detect(ctx, p).map((h) => ({ type, cls: t.cls, ...h }));
  } catch {
    hits = [];
  }
  const rej = p.rej || [];
  return {
    hits,
    rejected: rej
      .sort((a, b) => b.apparent - a.apparent)
      .slice(0, 6)
      .map((r) => ({ type, ...r })),
    rejectedTotal: rej.length,
  };
}
const detect = (type, ctx, given) => scan(type, ctx, given).hits;

function suggest(hit, given) {
  const t = BY_ID.get(hit.type);
  return t ? t.suggest(hit, params(hit.type, given)) : { legs: [] };
}

// Public description of the detectors for the page. `ease` = how tradable the type is (rank 1 = easiest to
// execute without slippage), why, and what to watch for. `params` marked q are the shared quality gates.
// templates[dir][side] = the suggested trade for that direction (side matters only when `sided`).
const catalog = () =>
  TYPES.map(({ id, name, group, cls, desc, how, formula, assumes, dirs, params: ps, cooldown, ease, suggest: sg }) => {
    const templates = Object.fromEntries(
      dirs.map((d) => [
        d,
        {
          CE: sg({ type: id, dir: d, side: 'CE', strike: 0 }, params(id)),
          PE: sg({ type: id, dir: d, side: 'PE', strike: 0 }, params(id)),
        },
      ]),
    );
    const sided = dirs.some((d) => JSON.stringify(templates[d].CE) !== JSON.stringify(templates[d].PE));
    return { id, name, group, cls, desc, how, formula, assumes, dirs, params: ps, cooldown, ease, templates, sided };
  });

// Value at expiry of a set of resolved legs ({dir, type, strike, qty: lots, px}) with Nifty at S.
const valueAt = (legs, S) => legs.reduce((v, l) => v + l.dir * l.qty * (Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S) - l.px), 0);
// Worst value at expiry over a spot grid and at every strike (where the payoff kinks).
// > 0 means the trade cannot lose at expiry (an arbitrage at those fill prices).
function worstAtExpiry(legs, spot) {
  let worst = Infinity;
  for (let i = 0; i <= 400; i++) worst = Math.min(worst, valueAt(legs, spot * (0.8 + (0.4 * i) / 400)));
  for (const l of legs) worst = Math.min(worst, valueAt(legs, l.strike));
  return worst;
}

module.exports = {
  Chain,
  TYPES,
  BY_ID,
  QUALITY,
  catalog,
  detect,
  scan,
  suggest,
  params,
  fill,
  worstPx,
  worstCash,
  valueAt,
  worstAtExpiry,
  tradingYears,
  calendarYears,
  b76,
  b76iv,
  ncdf,
  RATE,
};
