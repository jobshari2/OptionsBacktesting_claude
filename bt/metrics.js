// Performance statistics for a list of backtest trades (net P&L after costs).
function computeStats(trades, capitalOverride) {
  const n = trades.length;
  const empty = { trades: 0, total: 0, equity: [], monthly: {}, yearly: {}, weekday: {}, dte: {}, reasons: {} };
  if (!n) return empty;
  const net = trades.map((t) => t.net);
  const wins = net.filter((v) => v > 0);
  const losses = net.filter((v) => v < 0);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const total = sum(net);
  const sumWin = sum(wins);
  const sumLoss = sum(losses);

  // Equity curve and drawdown, in exit order.
  const order = trades.map((t, i) => i).sort((a, b) => (trades[a].exitDay + trades[a].exitTime).localeCompare(trades[b].exitDay + trades[b].exitTime));
  let eq = 0;
  let peak = 0;
  let peakDay = order.length ? trades[order[0]].entryDay : null;
  let maxDD = 0;
  let ddFrom = null;
  let ddTo = null;
  let longestDD = 0;
  let ddStartIdx = 0;
  const equity = [];
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  order.forEach((i, k) => {
    const t = trades[i];
    eq += t.net;
    if (eq > peak) {
      peak = eq;
      peakDay = t.exitDay;
      ddStartIdx = k;
    }
    const dd = eq - peak;
    if (dd < maxDD) {
      maxDD = dd;
      ddFrom = peakDay;
      ddTo = t.exitDay;
    }
    if (dd < 0) longestDD = Math.max(longestDD, k - ddStartIdx);
    equity.push({ d: t.exitDay, i, eq: Math.round(eq), dd: Math.round(dd) });
    if (t.net > 0) {
      streakW++;
      streakL = 0;
    } else if (t.net < 0) {
      streakL++;
      streakW = 0;
    } else {
      streakW = 0;
      streakL = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  });

  const first = trades[order[0]].entryDay;
  const last = trades[order[order.length - 1]].exitDay;
  const years = Math.max(1 / 52, (Date.parse(last) - Date.parse(first)) / (365.25 * 86400_000));
  const mean = total / n;
  const sd = Math.sqrt(net.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const perYear = n / years;
  const downside = Math.sqrt(net.reduce((s, v) => s + Math.min(0, v) ** 2, 0) / Math.max(1, n - 1));

  const capital = capitalOverride || Math.max(...trades.map((t) => t.margin || 0)) || null;

  const bucket = (key) => {
    const out = {};
    for (const t of trades) {
      const k = key(t);
      const b = (out[k] ||= { n: 0, pnl: 0, wins: 0 });
      b.n++;
      b.pnl += t.net;
      if (t.net > 0) b.wins++;
    }
    return out;
  };
  const monthly = {};
  const yearly = {};
  for (const t of trades) {
    const m = t.exitDay.slice(0, 7);
    monthly[m] = (monthly[m] || 0) + t.net;
    const y = t.exitDay.slice(0, 4);
    yearly[y] = (yearly[y] || 0) + t.net;
  }
  const reasons = {};
  for (const t of trades) for (const x of t.legs) reasons[x.reason] = (reasons[x.reason] || 0) + 1;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / n) * 100,
    total: Math.round(total),
    gross: Math.round(sum(trades.map((t) => t.gross))),
    costs: Math.round(sum(trades.map((t) => t.costs))),
    sumWin: Math.round(sumWin),
    sumLoss: Math.round(sumLoss),
    avg: Math.round(mean),
    avgWin: wins.length ? Math.round(sumWin / wins.length) : 0,
    avgLoss: losses.length ? Math.round(sumLoss / losses.length) : 0,
    maxWin: Math.round(Math.max(...net)),
    maxLoss: Math.round(Math.min(...net)),
    profitFactor: sumLoss ? sumWin / -sumLoss : null,
    rr: losses.length && wins.length ? sumWin / wins.length / (-sumLoss / losses.length) : null,
    expectancy: Math.round(mean),
    maxDD: Math.round(maxDD),
    ddFrom,
    ddTo,
    longestDDTrades: longestDD,
    streakWin: maxW,
    streakLoss: maxL,
    sharpe: sd ? (mean / sd) * Math.sqrt(perYear) : null,
    sortino: downside ? (mean / downside) * Math.sqrt(perYear) : null,
    annual: Math.round(total / years),
    calmar: maxDD ? total / years / -maxDD : null,
    capital: capital ? Math.round(capital) : null,
    roi: capital ? (total / capital) * 100 : null,
    annualRoi: capital ? (total / years / capital) * 100 : null,
    from: first,
    to: last,
    years,
    equity,
    monthly,
    yearly,
    weekday: bucket((t) => t.weekday),
    dte: bucket((t) => t.dte),
    reasons,
  };
}

module.exports = { computeStats };
