// Back spread + 2 butterflies, shared by Live › Ideas › Back spreads (the browser loads this same file as
// /lib/backspread.js) and the backtest engine's strike picker (bt/engine.js, strategy.pick).
//
// The structure, put side (the call side is its mirror image), for a back spread W wide centred at m:
//   back spread    sell 1 put at m + W/2, buy 2 puts at m − W/2
//   2 butterflies  wings at m − 1.5 W and m + 1.5 W, exactly where the back spread's loss stretch ends, so they pay
//                  across all of it: 'same' = 2 put butterflies (buy 2 at each wing, sell 4 at m), 'iron' = 2 iron
//                  butterflies (sell 2 straddles at m, buy 2 puts at the low wing and 2 calls at the high one).
// Both forms pay the same at expiry (put-call parity); 'same' trades no deep in-the-money option, so it is cheaper.
// In profit around m and on a big move past it, a small loss elsewhere.
//
// Strikes are picked inside a window: every leg within ATM ± win strikes. Each width W and each centre on the side
// the back spread gains (ATM itself up to the edge of the window) that fits is a candidate; the best by the chosen
// rank is the trade: 'loss' the smallest worst-case loss, 'pop' the highest chance of ending in profit, 'peak' the
// largest profit at the centre for each point of worst-case loss.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BackSpread = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WIDTHS = [100, 200, 300, 400];
  const WINDOWS = [5, 10, 15, 20, 25, 30];
  const FORMS = ['same', 'iron'];
  const RANKS = {
    loss: ['Min loss', 'Smallest worst-case loss after costs first'],
    pop: ['Prob. profit', 'Highest model chance of ending in profit first'],
    peak: ['Peak ÷ loss', 'Largest profit at the centre for each point of worst-case loss first'],
  };
  const ROLES = ['m', 'lo', 'hi', 'k1', 'k2'];

  // The legs of one structure (n = units): { role, act, type, n }. Roles: m centre, lo / hi wings, k1 the back
  // spread's sold strike, k2 its bought one.
  function roles(side, form) {
    const other = side === 'CE' ? 'PE' : 'CE';
    const low = 'PE';
    const high = 'CE';
    return form === 'iron'
      ? [
          { role: 'm', act: 'S', type: side, n: 2 },
          { role: 'm', act: 'S', type: other, n: 2 },
          { role: 'lo', act: 'B', type: low, n: 2 },
          { role: 'hi', act: 'B', type: high, n: 2 },
          { role: 'k1', act: 'S', type: side, n: 1 },
          { role: 'k2', act: 'B', type: side, n: 2 },
        ]
      : [
          { role: 'm', act: 'S', type: side, n: 4 },
          { role: 'lo', act: 'B', type: side, n: 2 },
          { role: 'hi', act: 'B', type: side, n: 2 },
          { role: 'k1', act: 'S', type: side, n: 1 },
          { role: 'k2', act: 'B', type: side, n: 2 },
        ];
  }
  // The legs with strikes: { act, type, k, n, role }.
  const legsOf = (g, side, form) => roles(side, form).map((r) => ({ ...r, k: g[r.role] }));

  // Every geometry whose strikes are all listed and within ATM ± win strikes. ks ascending, ai = ATM's index.
  function geometries(ks, ai, side, win, widths = WIDTHS) {
    const dir = side === 'CE' ? 1 : -1;
    const idx = new Map(ks.map((k, i) => [k, i]));
    const inWin = (k) => idx.has(k) && Math.abs(idx.get(k) - ai) <= win;
    const out = [];
    for (const W of widths)
      for (let i = 0; i <= win; i++) {
        const m = ks[ai + dir * i];
        if (m == null) break;
        const g = { W, m, k1: m - (dir * W) / 2, k2: m + (dir * W) / 2, lo: m - 1.5 * W, hi: m + 1.5 * W };
        if (ROLES.every((r) => inWin(g[r]))) out.push(g);
      }
    return out;
  }

  // Payoff at expiry per unit, in index points, of legs with prices: { act, type, k, n, px }.
  const intr = (t, k, S) => Math.max(0, t === 'CE' ? S - k : k - S);
  const pay = (L, S) => L.reduce((s, l) => s + (l.act === 'B' ? 1 : -1) * (l.n || 1) * (intr(l.type, l.k, S) - l.px), 0);
  // standard normal CDF (Abramowitz–Stegun 7.1.26)
  function ncdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  // Worst case, centre profit, breakevens, net premium (+ credit) and the lognormal chance of ending in profit
  // (iv as a fraction, T in years), all per unit in points. cost: points per unit to take off (charges, slippage).
  function evaluate(L, { spot, iv, T, cost = 0 } = {}) {
    const ks = [...new Set(L.map((l) => l.k))].sort((a, b) => a - b);
    const xs = [0, ...ks];
    const vs = xs.map((x) => pay(L, x));
    const worst = Math.min(...ks.map((x) => pay(L, x))) - cost;
    const m = L.find((l) => l.role === 'm')?.k;
    const peak = (m == null ? Math.max(...vs) : pay(L, m)) - cost;
    const bes = [];
    for (let i = 1; i < xs.length; i++) {
      const [a, b] = [vs[i - 1] - cost, vs[i] - cost];
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) bes.push(xs[i - 1] + ((0 - a) * (xs[i] - xs[i - 1])) / (b - a));
    }
    const net = L.reduce((s, l) => s + (l.act === 'S' ? 1 : -1) * (l.n || 1) * l.px, 0);
    let pop = null;
    if (iv > 0 && T > 0 && spot > 0) {
      const sd = iv * Math.sqrt(T);
      const cdf = (x) => (x <= 0 ? 0 : ncdf((Math.log(x / spot) + (sd * sd) / 2) / sd));
      const edges = [0, ...bes, Infinity];
      pop = 0;
      for (let i = 1; i < edges.length; i++) {
        const a = edges[i - 1];
        const b = edges[i];
        const mid = b === Infinity ? ks[ks.length - 1] * 1.5 : (a + b) / 2;
        if (pay(L, mid) - cost > 0) pop += (b === Infinity ? 1 : cdf(b)) - cdf(a);
      }
    }
    return { worst, peak, bes, net, pop };
  }
  // Higher is better.
  function score(e, rank) {
    if (rank === 'pop') return e.pop ?? 0;
    if (rank === 'peak') return e.peak / Math.max(1, -e.worst);
    return e.worst;
  }
  const better = (rank) => (a, b) => score(b, rank) - score(a, rank) || b.worst - a.worst;

  return { WIDTHS, WINDOWS, FORMS, RANKS, ROLES, roles, legsOf, geometries, pay, evaluate, score, better };
});
