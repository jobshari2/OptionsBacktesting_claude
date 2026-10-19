// Backtest the Pulse "trade idea": replay recorded days (events/<date>/tape-*.jsonl.gz) through pulse.js and its
// paper-trade ledger (pulse-signals.js) and report what buying the suggested CE / PE would have made after charges and
// slippage. Nothing is written to events/: the replay runs without a log folder.
//   node pulse-backtest.js                         every recorded session day
//   node pulse-backtest.js 2026-10-08 2026-10-12   chosen days
//   --verbose   list every trade      --slip 0.005   slippage per fill      --hold 15   minutes before a time exit      --cool 10   minutes between entries      --lat 3   seconds from signal to fill
// Only days that moved (a flat spot all day is a weekend / holiday recording) and only 09:15–15:30 IST are replayed.
// A handful of recorded days is a small sample: read the totals as "does the idea hold up", not as a forecast.
const { tapeDays, readTape } = require('./tape');

const IST = 19_800_000;
const inSession = (t) => {
  const m = Math.floor(((t + IST) % 86_400_000) / 60_000);
  return m >= 555 && m <= 930;
};

function snapOf(e) {
  const rows = Object.keys(e.d)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => {
      const v = e.d[k] || [];
      const hasBook = v.length >= 18;
      return {
        strike: k,
        ce: {
          ltp: v[0],
          oi: v[2],
          prevOi: v[2],
          bid: hasBook ? v[10] : null,
          ask: hasBook ? v[11] : null,
          tbq: hasBook ? v[12] : null,
          tsq: hasBook ? v[13] : null,
        },
        pe: {
          ltp: v[3],
          oi: v[5],
          prevOi: v[5],
          bid: hasBook ? v[14] : null,
          ask: hasBook ? v[15] : null,
          tbq: hasBook ? v[16] : null,
          tsq: hasBook ? v[17] : null,
        },
      };
    });
  return { spot: e.spot, rows };
}

function replayDay(day, entries, { slip, hold, lot = 65, signalOpts = {} }) {
  const { createPulse } = require('./pulse');
  const pulse = createPulse({ dir: null, getLot: () => lot, signalOpts: { slippage: slip, maxHoldMin: hold, ...signalOpts } });
  let lastSnap = null;
  let lastT = 0;
  for (const e of entries) {
    if (!inSession(e.t)) continue;
    // Quotes are needed to enter and exit: entries without a book (REST-only snapshots) are skipped.
    const first = Object.values(e.d)[0];
    if (!first || first.length < 18) continue;
    lastSnap = snapOf(e);
    lastT = e.t;
    pulse.update(e, lastSnap, null, { events: [] });
  }
  if (lastSnap) pulse.signalLog.flush(lastT, lastSnap);
  return pulse.signalLog.closedAll();
}

function summarise(trades) {
  const n = trades.length;
  const pnl = trades.reduce((s, x) => s + x.pnl, 0);
  const wins = trades.filter((x) => x.pnl > 0);
  const by = (f) => {
    const o = {};
    for (const x of trades) (o[f(x)] ||= []).push(x);
    return Object.fromEntries(
      Object.entries(o).map(([k, a]) => [k, { n: a.length, win: a.filter((x) => x.pnl > 0).length, pnl: Math.round(a.reduce((s, x) => s + x.pnl, 0)) }]),
    );
  };
  return {
    n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    pnl: Math.round(pnl),
    avg: n ? Math.round(pnl / n) : 0,
    bySide: by((x) => x.side),
    byExit: by((x) => x.reason),
  };
}

function backtestPulse(dir, days, opts = {}) {
  const o = { slip: 0.005, hold: 15, ...opts };
  const perDay = {};
  const all = [];
  for (const day of days) {
    const entries = readTape(dir, day).filter((e) => inSession(e.t));
    const spots = entries.map((e) => e.spot).filter((x) => x != null);
    if (!spots.length || Math.max(...spots) - Math.min(...spots) < 5) continue; // not a trading day
    const trades = replayDay(day, entries, o);
    perDay[day] = {
      ...summarise(trades),
      from: new Date(entries[0].t + IST).toISOString().slice(11, 16),
      range: Math.round(Math.max(...spots) - Math.min(...spots)),
    };
    all.push(...trades.map((x) => ({ ...x, day })));
  }
  return { perDay, total: summarise(all), trades: all };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, d) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args.splice(i, 2)[1]) : d;
  };
  const verbose = args.includes('--verbose') && args.splice(args.indexOf('--verbose'), 1);
  const slip = flag('--slip', 0.005);
  const hold = flag('--hold', 15);
  const cool = flag('--cool', 10);
  const lat = flag('--lat', 3);
  const dir = 'events';
  const days = args.length ? args : tapeDays(dir).reverse();
  const r = backtestPulse(dir, days, { slip, hold, signalOpts: { cooldownMin: cool, latencySec: lat } });
  const f = (t) => new Date(t + IST).toISOString().slice(11, 16);
  for (const [d, s] of Object.entries(r.perDay))
    console.log(d, `from ${s.from}`, `range ${s.range}`, `trades ${s.n}`, `win ${s.wins}`, `net ₹${s.pnl}`, JSON.stringify(s.byExit));
  if (verbose)
    for (const x of r.trades)
      console.log(
        `${x.day} ${f(x.t)} ${x.side} ${x.strike} in ${x.px.toFixed(1)} out ${x.exitPx.toFixed(1)} ${x.reason} ${x.held.toFixed(0)}m  ₹${Math.round(x.pnl)}`,
      );
  console.log('TOTAL', JSON.stringify(r.total));
}

module.exports = { backtestPulse, replayDay, summarise };
