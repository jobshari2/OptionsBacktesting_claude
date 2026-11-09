// Trade adjustments as rules: Michael Catolico's "Trade adjustment basics" (2007) made mechanical for Nifty options.
// Shared by the backtest (bt/adjust.js) and the browser (public/adj-view.js loads this same file as /lib/adjladder.js).
//
// The document's decision tree is a ladder. Every "+" (a move the trade's way) takes the position one rung right,
// every "−" one rung left, and the tree's boxes are the rungs it has reached:
//     … ← Fly roll again ← Fly roll (ratio) ← Ratio ← LONG CALL → Vertical → Butterfly → Condor (fly roll) → …
//          level −3            level −2       −1         0           1           2              3
// e.g. Vertical "−" = back to the long call, Ratio "+" = back to the long call, Fly roll (ratio) "+" = the reverse fly
// roll back to the ratio — every edge of the tree in the PDF. So the position is a function of the level alone, with
// K = the first (ATM) strike and W = the gap between strikes (a "rung"); the trades of an adjustment are the
// difference between two levels.
//
// When: the document's trigger — adjust when Nifty has moved k standard deviations from the last decision point,
// 1σ = P × V / √t (P = price at the last decision, V = the position's implied volatility, t = time units a year:
// 252 days, 252 × 6.25 hours, 52 weeks), k ≈ 1.5 while long premium and 2–2.5 while short premium.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pricing'));
  else root.AdjLadder = factory(root.Pricing);
})(typeof self !== 'undefined' ? self : this, function (Pricing) {
  const STEP = 50; // Nifty strike grid
  const SESSION_HOURS = 6.25; // 09:15–15:30
  const FRAMES = { hourly: 252 * SESSION_HOURS, daily: 252, weekly: 52 };
  // The PDF's $5 strike gap on an $80 stock at 30 % IV with 30 days left is 0.72 of a standard deviation to expiry
  // (80 × 0.30 × √(30/365) = 6.88): the same distance in σ keeps premiums in the same proportions on Nifty.
  const WIDTH_SIGMA = 0.72;

  const DEFAULTS = {
    bias: 'bull', // 'bull': calls, "+" = Nifty up (the PDF's examples); 'bear': puts, mirrored ("+" = Nifty down)
    width: 0, // points between strikes (a rung); 0 = auto, WIDTH_SIGMA of a standard deviation to expiry
    widthSigma: WIDTH_SIGMA,
    frame: 'daily', // how often Nifty is looked at: 'hourly' | 'daily' | 'weekly'
    kLong: 1.5, // trigger in σ of that frame while the position is long premium (loses from time decay)
    kShort: 2, // ...while it is short premium (earns from time decay): wait longer, as the PDF advises
    cap: 'capped', // 'capped': the ratio's extra sold call is covered by one bought capRungs higher (defined risk);
    capRungs: 2, //    'naked': as in the PDF, one sold call uncovered (unlimited loss on a rally)
    maxUp: 3, // rungs right of the long call the ladder may climb (3 = the PDF's tree: the condor)
    maxDown: 3, // rungs left (3 = the PDF's last box: fly roll, open condor ratio)
    beyondUp: 'hold', // a "+" past maxUp: 'hold' the position, or 'close' it (take the profit)
    beyondDown: 'close', // a "−" past maxDown: 'close' (the PDF: "consider closing rather than adjusting"), or 'hold'
    lockHold: false, // stop adjusting once a butterfly or condor is held for a net credit (profit locked in)
    stall: { on: false, checks: 2 }, // long premium and no trigger for this many checks: turn it into the butterfly
    expiryDay: false, // also adjust on the expiry day (an adjustment then mostly adds costs)
    lots: 1,
  };

  const round50 = (x) => Math.round(x / STEP) * STEP;
  const sigmaPts = (P, iv, frame) => (P * iv) / Math.sqrt(FRAMES[frame] || FRAMES.daily);
  const autoWidth = (S, iv, years, mult = WIDTH_SIGMA) => Math.max(STEP, round50(mult * S * iv * Math.sqrt(Math.max(years, 1 / 365))));

  function merge(p = {}) {
    const out = { ...DEFAULTS, ...p };
    out.stall = { ...DEFAULTS.stall, ...(p.stall || {}) };
    out.bias = out.bias === 'bear' ? 'bear' : 'bull';
    out.frame = FRAMES[out.frame] ? out.frame : 'daily';
    out.cap = out.cap === 'naked' ? 'naked' : 'capped';
    const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
    out.width = Math.max(0, round50(Number(out.width) || 0));
    out.capRungs = int(out.capRungs, 1, 6, DEFAULTS.capRungs);
    out.maxUp = int(out.maxUp, 1, 8, DEFAULTS.maxUp);
    out.maxDown = int(out.maxDown, 1, 8, DEFAULTS.maxDown);
    out.lots = int(out.lots, 1, 50, 1);
    out.kLong = Number(out.kLong) > 0 ? Number(out.kLong) : DEFAULTS.kLong;
    out.kShort = Number(out.kShort) > 0 ? Number(out.kShort) : DEFAULTS.kShort;
    out.stall.checks = int(out.stall.checks, 1, 50, DEFAULTS.stall.checks);
    return out;
  }

  // Net lots per rung (rungs from K, in the trade's direction) for ladder level n, per lot of the strategy.
  function rungsFor(n, p) {
    const m = new Map();
    const add = (r, q) => m.set(r, (m.get(r) || 0) + q);
    add(0, 1); // the long call at K
    if (n >= 1) add(1, -1); // vertical: sell one a rung up
    if (n >= 2) {
      add(1, -1); // butterfly: sell another there, buy one two rungs up
      add(2, 1);
    }
    for (let j = 3; j <= n; j++) {
      // fly roll: a butterfly centred one rung higher each time (condor at 3)
      add(j - 2, 1);
      add(j - 1, -2);
      add(j, 1);
    }
    if (n <= -1) {
      add(1, -2); // ratio: sell two a rung up
      if (p.cap !== 'naked') add(1 + p.capRungs, 1); // ...the second covered further up
    }
    for (let j = -2; j >= n; j--) {
      // fly roll down: a butterfly centred one rung lower each time
      add(j + 1, 1);
      add(j + 2, -2);
      add(j + 3, 1);
    }
    return m;
  }

  // The legs of level n: [{ type, strike, lots }] with lots signed (+ bought, − sold), lowest strike first.
  // snap(strike) maps to a listed strike.
  function legsFor(n, K, W, params, snap = (k) => k) {
    const p = merge(params);
    const s = p.bias === 'bear' ? -1 : 1;
    const type = s > 0 ? 'CE' : 'PE';
    const by = new Map();
    for (const [r, q] of rungsFor(n, p)) {
      if (!q) continue;
      const k = snap(K + s * r * W);
      by.set(k, (by.get(k) || 0) + q);
    }
    return [...by]
      .filter(([, q]) => q)
      .map(([strike, q]) => ({ type, strike, lots: q * p.lots }))
      .sort((a, b) => a.strike - b.strike);
  }

  // Trades that turn legs `from` into legs `to` (both signed): [{ type, strike, lots }] with lots + buy, − sell.
  function trades(from, to) {
    const key = (l) => l.type + l.strike;
    const m = new Map();
    for (const l of from) m.set(key(l), { type: l.type, strike: l.strike, lots: (m.get(key(l))?.lots || 0) - l.lots });
    for (const l of to) m.set(key(l), { type: l.type, strike: l.strike, lots: (m.get(key(l))?.lots || 0) + l.lots });
    return [...m.values()].filter((t) => t.lots).sort((a, b) => a.strike - b.strike);
  }

  // Names: the PDF's boxes (calls; "Long put" when bearish).
  function nodeName(n, bias = 'bull') {
    if (n === 0) return bias === 'bear' ? 'Long put' : 'Long call';
    if (n === 1) return 'Vertical';
    if (n === 2) return 'Butterfly';
    if (n === 3) return 'Condor (fly roll)';
    if (n > 3) return `Condor, fly rolled ${n - 2}×`;
    if (n === -1) return 'Ratio';
    if (n === -2) return 'Fly roll (open ratio condor)';
    if (n === -3) return 'Fly roll (open condor ratio)';
    return `Ratio, fly rolled ${-n - 1}×`;
  }
  const SHORT = { '-3': 'FR2', '-2': 'FR', '-1': 'R', 0: 'L', 1: 'V', 2: 'F', 3: 'C' };
  const nodeShort = (n) => SHORT[n] || (n > 0 ? 'C' + (n - 2) : 'FR' + (-n - 1));

  // What an adjustment does, in the PDF's words.
  function stepText(from, to, bias = 'bull') {
    const c = bias === 'bear' ? 'put' : 'call';
    const up = bias === 'bear' ? 'lower' : 'higher';
    const key = `${from}>${to}`;
    const t = {
      '0>1': `Sell one ${c} a rung ${up}: long ${c} → vertical (locks in part of the gain, lowers the cost)`,
      '1>2': `Sell another ${c} at the short strike, buy one a rung ${up}: vertical → butterfly`,
      '2>3': `Buy one short back, sell two a rung ${up}, buy one above them: the fly rolls ${up} → condor`,
      '1>0': `Buy the short ${c} back: vertical → long ${c}`,
      '2>1': 'Take off the upper short vertical: butterfly → vertical',
      '3>2': 'Reverse the fly roll: condor → butterfly',
      '0>-1': `Sell two ${c}s a rung ${up}: long ${c} → ratio (lowers the cost, pulls the profit zone back to the price)`,
      '-1>0': `Buy the two short ${c}s back: ratio → long ${c}`,
      '-1>-2': 'Add a butterfly a rung lower: ratio → open ratio condor (fly roll)',
      '-2>-1': 'Reverse the fly roll: back to the ratio',
      '-2>-3': 'Add one more butterfly a rung lower (fly roll again)',
      '-3>-2': 'Reverse the last fly roll',
    }[key];
    if (t) return t;
    if (from === 0 && to === 2) return `No trigger and time decay hurting: sell two ${c}s a rung ${up}, buy one two rungs ${up} → butterfly`;
    if (from === 1 && to === 2) return 'No trigger and time decay hurting: vertical → butterfly';
    return to > from ? 'Roll the fly one rung further' : 'Reverse the last fly roll';
  }

  // ---------- pricing (Black-Scholes, /lib/pricing.js) ----------
  const bs = (S, K, T, v, call) => (T <= 1e-6 || !(v > 0) ? Math.max(0, call ? S - K : K - S) : Pricing.bsm(S, K, T, v, call, Pricing.RATE, 0));
  // Implied volatility from a price (bisection), null when the price carries no time value.
  function impliedVol(price, S, K, T, call) {
    const intrinsic = Math.max(0, call ? S - K : K - S);
    if (!(price > intrinsic + 0.05) || !(T > 0)) return null;
    let lo = 0.005;
    let hi = 3;
    if (bs(S, K, T, hi, call) < price) return null;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (bs(S, K, T, mid, call) > price) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }
  // Value of signed legs (₹) at Nifty S with T years left; ivOf(strike) the volatility of each strike.
  const value = (legs, S, T, ivOf, lot) => legs.reduce((s, l) => s + l.lots * lot * bs(S, l.strike, T, ivOf(l.strike), l.type === 'CE'), 0);
  // ₹ a calendar day the legs gain (+) or lose (−) from time alone: < 0 = long premium.
  function theta(legs, S, T, ivOf, lot) {
    const dt = 1 / 365;
    if (!legs.length) return 0;
    return value(legs, S, Math.max(0, T - dt), ivOf, lot) - value(legs, S, T, ivOf, lot);
  }
  const intrinsic = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
  // P&L at expiry for Nifty x: the cash so far (premiums received − paid) + what the open legs are then worth.
  const atExpiry = (legs, x, cash, lot) => cash + legs.reduce((s, l) => s + l.lots * lot * intrinsic(l, x), 0);

  // ---------- the rule ----------
  // st = { level, ref (Nifty at the last decision point), quiet (checks since it) }; ctx = { iv, theta (₹ a day),
  // locked (a butterfly / condor held for a net credit) }. Returns what to do now:
  // { kind: 'none' | 'adjust' | 'hold' | 'close', dir (+1 the trade's way, −1 against, 0 stall), to, move, trig, sd, k, longPrem, why }.
  function decide(st, S, params, ctx) {
    const p = merge(params);
    const sd = sigmaPts(st.ref, ctx.iv, p.frame);
    const longPrem = ctx.theta < 0;
    const k = longPrem ? p.kLong : p.kShort;
    const trig = k * sd;
    const move = (S - st.ref) * (p.bias === 'bear' ? -1 : 1);
    const base = { move, trig, sd, k, longPrem, from: st.level };
    if (Math.abs(move) >= trig) {
      const dir = move > 0 ? 1 : -1;
      if (p.lockHold && ctx.locked)
        return { ...base, kind: 'hold', dir, to: st.level, why: 'Profit locked in (a butterfly or condor for a net credit): held, no more adjustments' };
      const to = st.level + dir;
      if (to > p.maxUp)
        return {
          ...base,
          kind: p.beyondUp === 'close' ? 'close' : 'hold',
          dir,
          to: st.level,
          why: p.beyondUp === 'close' ? 'Past the top of the ladder: profit taken, every leg closed' : 'Past the top of the ladder: held',
        };
      if (to < -p.maxDown)
        return {
          ...base,
          kind: p.beyondDown === 'hold' ? 'hold' : 'close',
          dir,
          to: st.level,
          why:
            p.beyondDown === 'hold'
              ? 'Past the bottom of the ladder: held'
              : 'Past the bottom of the ladder: closed rather than adjusted again (the PDF’s advice)',
        };
      return { ...base, kind: 'adjust', dir, to, why: stepText(st.level, to, p.bias) };
    }
    if (p.stall.on && longPrem && (st.level === 0 || st.level === 1) && st.quiet + 1 >= p.stall.checks)
      return { ...base, kind: 'adjust', dir: 0, to: 2, stall: true, why: stepText(st.level, 2, p.bias) };
    return { ...base, kind: 'none', dir: 0, to: st.level };
  }

  return {
    STEP,
    FRAMES,
    SESSION_HOURS,
    WIDTH_SIGMA,
    DEFAULTS,
    merge,
    round50,
    sigmaPts,
    autoWidth,
    rungsFor,
    legsFor,
    trades,
    nodeName,
    nodeShort,
    stepText,
    bs,
    impliedVol,
    value,
    theta,
    intrinsic,
    atExpiry,
    decide,
  };
});
