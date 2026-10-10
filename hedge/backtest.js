// Hedge backtest: replays option hedges over historical daily Nifty closes.
//
// No historical option prices are available, so every leg is priced with Black-Scholes:
//   volatility = India VIX of that day (or realised volatility, or a fixed level) × multiplier,
//   + skew (vol points per 10% out of the money; puts usually dearer than calls),
//   optionally pulled toward the long-run average for longer expiries (term structure),
//   bought above / sold below the model price by half the bid/ask spread, plus charges per leg.
// Portfolio model: holdings move beta × Nifty each day. Hedges are opened with strikes set as a %
// of spot at entry, sized as a share of the exposure at that time, held to expiry (or rolled
// early) and re-opened, and marked to model every day. Premiums come out of / go into cash
// (no interest); the hedged value = holdings + cash + open options.

const DAY = 86_400_000;

// Template strategies (same families as the live planner), with strikes as % of spot.
const TEMPLATES = {
  put: { name: 'Protective put', legs: (s) => [['buy', 'PE', s.putK, 1]] },
  spread: { name: 'Put spread', legs: (s) => [['buy', 'PE', s.putK, 1], ['sell', 'PE', s.putK - s.width, 1]] },
  spreadtail: { name: 'Put spread + tail put', legs: (s) => [['buy', 'PE', s.putK, 1], ['sell', 'PE', s.putK - s.width, 1], ['buy', 'PE', Math.min(s.tailK, s.putK - s.width - 5), 1]] },
  partial: { name: 'Partial collar', legs: (s) => [['buy', 'PE', s.putK, 1], ['sell', 'CE', s.callK, 0.5]] },
  seagull: { name: 'Seagull', legs: (s) => [['buy', 'PE', s.putK, 1], ['sell', 'PE', s.putK - s.width, 1], ['sell', 'CE', s.callK, 1]] },
  collar: { name: 'Collar', legs: (s) => [['buy', 'PE', s.putK, 1], ['sell', 'CE', s.callK, 1]] },
  tail: { name: 'Tail hedge', legs: (s) => [['buy', 'PE', s.tailK, 1]] },
};

// ---------- pricing ----------
// Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7)
function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function bs(type, S, K, T, r, q, v) {
  if (T <= 0 || v <= 0) return Math.max(0, type === 'PE' ? K - S : S - K);
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (v * v) / 2) * T) / sq;
  const d2 = d1 - sq;
  return type === 'PE'
    ? K * Math.exp(-r * T) * ncdf(-d2) - S * Math.exp(-q * T) * ncdf(-d1)
    : S * Math.exp(-q * T) * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
}

// Volatility for one strike: base level, term structure, then skew.
function legVol(base, K, S, T, p) {
  let v = base;
  if (p.termAdjust) v = p.longRunVol + (v - p.longRunVol) * Math.sqrt(30 / Math.max(30, T * 365));
  const m = Math.log(K / S);
  v += m < 0 ? (p.putSkew / 100) * (-m / 0.1) : (p.callSkew / 100) * (m / 0.1);
  return Math.max(0.04, v);
}

// Base volatility for each day, per the chosen source.
function baseVols(days, p) {
  const rets = days.map((d, i) => (i ? Math.log(d.spot / days[i - 1].spot) : 0));
  const realised = (i) => {
    const n = Math.min(p.rvWindow, i);
    if (n < 5) return 0.16;
    let s = 0, s2 = 0;
    for (let j = i - n + 1; j <= i; j++) { s += rets[j]; s2 += rets[j] * rets[j]; }
    return Math.sqrt(Math.max(0, (s2 - (s * s) / n) / (n - 1)) * 252);
  };
  return days.map((d, i) => {
    if (p.volSource === 'fixed') return p.fixedVol / 100;
    if (p.volSource === 'vix' && d.vix > 0) return (d.vix / 100) * p.volMult;
    return realised(i) * p.volMult; // realised, or VIX not available that far back
  });
}

// ---------- simulation ----------
function roundStrike(K, step) { return Math.max(step, Math.round(K / step) * step); }

function simulate(spec, days, vols, p) {
  const n = days.length;
  const half = p.spreadPct / 200;
  const val = (l, S, T, base) => bs(l.type, S, l.strike, T, p.rate, p.divYield, legVol(base, l.strike, S, Math.max(T, 1 / 365), p));
  const equity = new Array(n);
  const trades = [];
  let stock = p.startValue;
  let cash = 0;
  let pos = null;
  let premiumPaid = 0; // net debit + charges at every open
  let costPctSum = 0; // each opening cost as % of holdings at the time

  const close = (i, reason) => {
    const d = days[i];
    const T = (pos.expiryT - Date.parse(d.date)) / DAY / 365;
    let proceeds = 0;
    const exits = pos.legs.map((l) => {
      const mid = T > 0 ? val(l, d.spot, T, vols[i]) : Math.max(0, l.type === 'PE' ? l.strike - d.spot : d.spot - l.strike);
      // at expiry it settles at intrinsic; before expiry you sell at the bid / buy back at the ask
      const px = T > 0 ? (l.action === 'buy' ? mid * (1 - half) : mid * (1 + half)) : mid;
      proceeds += (l.action === 'buy' ? 1 : -1) * px * l.lots * p.lot;
      return px;
    });
    if (T > 0) proceeds -= pos.legs.length * p.chargesPerLeg;
    cash += proceeds;
    trades.push({
      open: days[pos.i].date, close: d.date, expiry: ymd(pos.expiryT), reason,
      spotIn: days[pos.i].spot, spotOut: d.spot, volIn: vols[pos.i] * 100,
      legs: pos.legs.map((l, j) => ({ action: l.action, type: l.type, strike: l.strike, lots: l.lots, entry: l.price, exit: exits[j] })),
      cost: pos.cost, proceeds, pnl: proceeds - pos.cost,
      niftyMove: (d.spot / days[pos.i].spot - 1) * 100,
      holdingsMove: stock - pos.stockIn,
    });
    pos = null;
  };

  const open = (i) => {
    const d = days[i];
    const T = spec.tenorDays / 365;
    const exposureLots = (stock * p.beta) / (d.spot * p.lot);
    const maxRatio = Math.max(...spec.legs.map((l) => l.ratio));
    const base = p.wholeLots ? Math.max(1, Math.round(exposureLots * maxRatio)) : exposureLots * maxRatio;
    const legs = spec.legs.map((l) => {
      const lots = p.wholeLots ? Math.floor(base * (l.ratio / maxRatio) + 1e-9) : base * (l.ratio / maxRatio);
      const strike = roundStrike(d.spot * (1 + l.k / 100), p.strikeStep);
      const leg = { action: l.action, type: l.type, strike, lots };
      const mid = val(leg, d.spot, T, vols[i]);
      leg.price = Math.max(0.05, l.action === 'buy' ? mid * (1 + half) : mid * (1 - half));
      return leg;
    }).filter((l) => l.lots > 0);
    if (!legs.length) return;
    const cost = legs.reduce((t, l) => t + (l.action === 'buy' ? 1 : -1) * l.price * l.lots * p.lot, 0) + legs.length * p.chargesPerLeg;
    cash -= cost;
    premiumPaid += cost;
    costPctSum += (cost / stock) * 100;
    pos = { i, legs, cost, stockIn: stock, expiryT: Date.parse(d.date) + spec.tenorDays * DAY };
  };

  for (let i = 0; i < n; i++) {
    const d = days[i];
    if (i) stock *= 1 + p.beta * (d.spot / days[i - 1].spot - 1);
    if (pos) {
      const left = (pos.expiryT - Date.parse(d.date)) / DAY;
      const mtm = () => pos.legs.reduce((t, l) => t + (l.action === 'buy' ? 1 : -1) * val(l, d.spot, left / 365, vols[i]) * l.lots * p.lot, 0);
      if (left <= 0) close(i, 'expiry');
      else if (p.exitFallPct && d.spot <= days[pos.i].spot * (1 - p.exitFallPct / 100)) close(i, `Nifty −${p.exitFallPct}%`);
      else if (p.exitMultiple && pos.cost > 0 && mtm() >= pos.cost * p.exitMultiple) close(i, `${p.exitMultiple}× cost`);
      else if (left <= p.rollDaysLeft) close(i, 'rolled');
    }
    // open (or re-open) unless volatility is above the entry limit, or this is the last day
    if (!pos && i < n - 1 && !(p.maxEntryVol && vols[i] * 100 > p.maxEntryVol)) open(i);
    const T = pos ? (pos.expiryT - Date.parse(d.date)) / DAY / 365 : 0;
    const optVal = pos ? pos.legs.reduce((t, l) => t + (l.action === 'buy' ? 1 : -1) * val(l, d.spot, T, vols[i]) * l.lots * p.lot, 0) : 0;
    equity[i] = stock + cash + optVal;
  }
  const years = Math.max((Date.parse(days[n - 1].date) - Date.parse(days[0].date)) / DAY / 365.25, 1 / 365);
  return {
    equity, trades,
    options: {
      premiumPaid,
      net: equity[n - 1] - stock, // everything the options made or lost, incl. the open one
      openValue: equity[n - 1] - stock - cash,
      costPerYearPct: costPctSum / years,
      rolls: trades.length,
      paidOff: trades.filter((t) => t.pnl > 0).length,
      bestRoll: trades.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null),
      worstRoll: trades.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null),
    },
  };
}

// ---------- statistics ----------
function stats(eq, days, rate) {
  const n = eq.length;
  const years = Math.max((Date.parse(days[n - 1].date) - Date.parse(days[0].date)) / DAY / 365.25, 1 / 365);
  const total = eq[n - 1] / eq[0] - 1;
  const cagr = eq[n - 1] > 0 ? (eq[n - 1] / eq[0]) ** (1 / years) - 1 : -1;
  let s = 0, s2 = 0, k = 0, ds2 = 0;
  for (let i = 1; i < n; i++) {
    const r = eq[i] / eq[i - 1] - 1;
    s += r; s2 += r * r; k++;
    if (r < 0) ds2 += r * r;
  }
  const vol = k > 1 ? Math.sqrt(Math.max(0, (s2 - (s * s) / k) / (k - 1)) * 252) : 0;
  const downVol = k ? Math.sqrt((ds2 / k) * 252) : 0;
  let peak = eq[0], peakI = 0, dd = 0, ddPeak = 0, ddTrough = 0;
  for (let i = 0; i < n; i++) {
    if (eq[i] > peak) { peak = eq[i]; peakI = i; }
    const x = eq[i] / peak - 1;
    if (x < dd) { dd = x; ddPeak = peakI; ddTrough = i; }
  }
  // worst return over any window of `len` trading days
  const worst = (len) => {
    if (n <= len) return null;
    let w = Infinity;
    for (let i = len; i < n; i++) w = Math.min(w, eq[i] / eq[i - len] - 1);
    return w * 100;
  };
  return {
    final: eq[n - 1], totalPct: total * 100, cagrPct: cagr * 100, volPct: vol * 100,
    sharpe: vol ? (cagr - rate) / vol : null,
    sortino: downVol ? (cagr - rate) / downVol : null,
    maxDdPct: dd * 100, ddFrom: days[ddPeak].date, ddTo: days[ddTrough].date,
    calmar: dd ? cagr / -dd : null,
    worst1mPct: worst(21), worst3mPct: worst(63), worst1yPct: worst(252),
  };
}

// The deepest Nifty falls in the range (peak → trough, non-overlapping, at least `min` %).
function crises(days, min, count) {
  const out = [];
  let peakI = 0, troughI = 0, inDd = false;
  const push = () => { const depth = (days[troughI].spot / days[peakI].spot - 1) * 100; if (depth <= -min) out.push({ from: peakI, to: troughI, depth }); };
  for (let i = 1; i < days.length; i++) {
    if (days[i].spot >= days[peakI].spot) {
      if (inDd) push();
      peakI = i; troughI = i; inDd = false;
    } else {
      inDd = true;
      if (days[i].spot < days[troughI].spot) troughI = i;
    }
  }
  if (inDd) push();
  return out.sort((a, b) => a.depth - b.depth).slice(0, count).sort((a, b) => a.from - b.from);
}

// % return per calendar period: len 4 → { 'YYYY': % }, len 7 → { 'YYYY-MM': % }
function periodic(eq, days, len) {
  const out = {};
  let startV = eq[0], key = days[0].date.slice(0, len);
  for (let i = 1; i < days.length; i++) {
    const k = days[i].date.slice(0, len);
    if (k !== key) { out[key] = (eq[i - 1] / startV - 1) * 100; startV = eq[i - 1]; key = k; }
  }
  out[key] = (eq[eq.length - 1] / startV - 1) * 100;
  return out;
}
const yearly = (eq, days) => periodic(eq, days, 4);
const monthly = (eq, days) => periodic(eq, days, 7);

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
const opt = (v) => (v === undefined || v === null || v === '' || !(Number(v) > 0) ? null : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function normalise(q) {
  return {
    from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null,
    startValue: clamp(num(q.startValue, 1e7), 1e4, 1e11),
    beta: clamp(num(q.beta, 1), 0, 3),
    hedgePct: clamp(num(q.hedgePct, 100), 5, 150),
    lot: clamp(Math.round(num(q.lot, 75)), 1, 10_000),
    wholeLots: q.wholeLots !== false,
    tenorDays: clamp(Math.round(num(q.tenorDays, 90)), 7, 730),
    rollDaysLeft: clamp(num(q.rollDaysLeft, 0), 0, 365),
    exitFallPct: opt(q.exitFallPct),
    exitMultiple: opt(q.exitMultiple),
    maxEntryVol: opt(q.maxEntryVol),
    putK: clamp(num(q.putK, -5), -50, 20),
    width: clamp(num(q.width, 10), 1, 50),
    tailK: clamp(num(q.tailK, -20), -60, 0),
    callK: clamp(num(q.callK, 10), 0, 60),
    strikeStep: [50, 100, 500].includes(Number(q.strikeStep)) ? Number(q.strikeStep) : 100,
    volSource: ['vix', 'realised', 'fixed'].includes(q.volSource) ? q.volSource : 'vix',
    volMult: clamp(num(q.volMult, 1), 0.3, 3),
    fixedVol: clamp(num(q.fixedVol, 16), 3, 100),
    rvWindow: clamp(Math.round(num(q.rvWindow, 20)), 5, 252),
    putSkew: clamp(num(q.putSkew, 3), -10, 30),
    callSkew: clamp(num(q.callSkew, -1), -20, 20),
    termAdjust: q.termAdjust !== false,
    spreadPct: clamp(num(q.spreadPct, 4), 0, 50),
    chargesPerLeg: clamp(num(q.chargesPerLeg, 30), 0, 10_000),
    rate: clamp(num(q.ratePct, 6.5), 0, 20) / 100,
    divYield: clamp(num(q.divYieldPct, 1.3), 0, 10) / 100,
  };
}

// Turn the requested strategies into specs: { id, label, tenorDays, legs: [{ action, type, k, ratio }] }
function specsFor(list, p) {
  const out = [];
  for (const s of (Array.isArray(list) ? list : []).slice(0, 30)) {
    const label = String(s.label || s.family || 'Strategy').slice(0, 80);
    if (s.family && TEMPLATES[s.family]) {
      out.push({
        id: String(s.id || s.family), label, group: 'template', tenorDays: p.tenorDays,
        legs: TEMPLATES[s.family].legs(p).map(([action, type, k, r]) => ({ action, type, k, ratio: r * (p.hedgePct / 100) })),
      });
      continue;
    }
    if (!Array.isArray(s.legs) || !s.legs.length || s.legs.length > 12) continue;
    const legs = s.legs.map((l) => ({
      action: l.action === 'sell' ? 'sell' : 'buy',
      type: l.type === 'CE' ? 'CE' : 'PE',
      k: clamp(num(l.k, 0), -80, 80),
      ratio: clamp(num(l.ratio, 1), 0, 5) * (s.scaleByHedge ? p.hedgePct / 100 : 1),
    })).filter((l) => l.ratio > 0);
    if (!legs.length) continue;
    out.push({ id: String(s.id || label), label, group: s.group || 'custom', tenorDays: s.tenorDays ? clamp(Math.round(Number(s.tenorDays)), 7, 730) : p.tenorDays, legs });
  }
  return out;
}

// Main entry. history: [{ date, spot, vix }] sorted by date.
function run(history, q) {
  const p = normalise(q || {});
  let days = history.filter((d) => (!p.from || d.date >= p.from) && (!p.to || d.date <= p.to));
  if (days.length < 30) throw new Error('Need at least 30 trading days of history in the chosen range');
  const vixDays = history.filter((d) => d.vix > 0);
  // long-run volatility level for the term-structure adjustment: average VIX over all history
  p.longRunVol = vixDays.length ? vixDays.reduce((s, d) => s + d.vix, 0) / vixDays.length / 100 : 0.17;
  const vols = baseVols(days, p);
  const specs = specsFor(q.strategies, p);
  if (!specs.length) throw new Error('Pick at least one strategy to test');

  // holdings with no hedge, compounded daily like the simulation does
  const unhedged = [p.startValue];
  for (let i = 1; i < days.length; i++) unhedged[i] = unhedged[i - 1] * (1 + p.beta * (days[i].spot / days[i - 1].spot - 1));

  const results = specs.map((spec) => {
    const sim = simulate(spec, days, vols, p);
    return { id: spec.id, label: spec.label, group: spec.group, tenorDays: spec.tenorDays, legs: spec.legs, equity: sim.equity, trades: sim.trades, options: sim.options, stats: stats(sim.equity, days, p.rate), years: yearly(sim.equity, days), months: monthly(sim.equity, days) };
  });

  const falls = crises(days, 8, 8).map((c) => ({
    from: days[c.from].date, to: days[c.to].date, depth: c.depth,
    unhedged: (unhedged[c.to] / unhedged[c.from] - 1) * 100,
    results: Object.fromEntries(results.map((r) => [r.id, (r.equity[c.to] / r.equity[c.from] - 1) * 100])),
  }));

  // thin the curves for the chart (stats above use every day)
  const stepN = Math.max(1, Math.ceil(days.length / 1500));
  const idx = days.map((_, i) => i).filter((i) => i % stepN === 0 || i === days.length - 1);
  const pick = (a) => idx.map((i) => Math.round(a[i]));
  return {
    params: p,
    range: { from: days[0].date, to: days[days.length - 1].date, days: days.length, niftyFrom: days[0].spot, niftyTo: days[days.length - 1].spot, niftyPct: (days[days.length - 1].spot / days[0].spot - 1) * 100 },
    volUsed: { source: p.volSource, vixFrom: vixDays[0]?.date || null, avg: (vols.reduce((s, v) => s + v, 0) / vols.length) * 100, longRun: p.longRunVol * 100, fellBack: p.volSource === 'vix' && days.some((d) => !(d.vix > 0)) },
    curve: { dates: idx.map((i) => days[i].date), nifty: idx.map((i) => days[i].spot), unhedged: pick(unhedged), series: Object.fromEntries(results.map((r) => [r.id, pick(r.equity)])) },
    unhedged: { stats: stats(unhedged, days, p.rate), years: yearly(unhedged, days), months: monthly(unhedged, days) },
    nifty: { years: yearly(days.map((d) => d.spot), days), months: monthly(days.map((d) => d.spot), days) },
    results: results.map(({ equity, ...r }) => r),
    crises: falls,
  };
}

module.exports = { run, TEMPLATES, bs };
