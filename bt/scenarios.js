// Scenario scan for the Backtest screen: the same strategy re-run with every combination of
//   - overall profit target: none, or book the whole position at 10 %, 20 %, 30 % ... of the net entry premium
//   - overall stop-loss:     none, or exit at a loss of 50 %, 100 % ... of the net entry premium
//   - exit:                  positional: on expiry day or 1 / 2 / 3 trading days before it; intraday: a few exit times
// plus the strategy exactly as defined. Entries, strikes, leg stops / targets, re-entries, rolls, partial booking and
// filters are the strategy's own in every scenario; only the overall stop, the overall target and the exit change.
// "Net entry premium" = the credit received (or debit paid) at entry, in rupees (engine: risk.slPrem / tgtPrem).
const { normalizeStrategy, MIN_OF } = require('./engine');

const GRID = {
  credit: { tgt: [10, 20, 30, 40, 50, 60, 70, 80, 90], sl: [50, 100, 200] }, // a credit position can make at most 100 %
  debit: { tgt: [10, 20, 30, 40, 50, 75, 100, 150, 200], sl: [25, 50, 75] }, // a debit position can lose at most 100 %
};
const EXIT_DTE = [0, 1, 2, 3];
const EXIT_TIMES = ['11:00', '12:30', '14:00', '15:15'];

// Exits worth testing for a (normalized) strategy, the strategy's own exit included.
function exitsOf(s) {
  const em = MIN_OF(s.entry.time);
  if (s.mode === 'intraday') {
    return [...new Set([...EXIT_TIMES, s.exit.time])]
      .filter((t) => MIN_OF(t) > em)
      .sort()
      .map((time) => ({ time }));
  }
  const ok = (d) => Boolean(s.entry.after) || d < s.entry.dteDays || (d === s.entry.dteDays && MIN_OF(s.exit.time) > em);
  // A leg in an earlier expiry that is not rolled (e.g. a near-week hedge) is gone after its expiry: holding the
  // rest longer than the strategy does would test a different, unhedged position. Only the own exit and the day
  // before it are tested then.
  const codes = new Set(s.legs.map((l) => l.expiry));
  const first = ['cur', 'mcur', 'next', 'mnext'].find((c) => codes.has(c));
  const hedgeEnds = codes.size > 1 && s.legs.some((l) => l.expiry === first && !l.roll);
  return [...new Set(hedgeEnds ? [s.exit.dteDays, s.exit.dteDays + 1] : [...EXIT_DTE, s.exit.dteDays])]
    .filter(ok)
    .sort((a, b) => a - b)
    .map((dteDays) => ({ dteDays, time: s.exit.time }));
}

// debit: the position pays premium at entry (decides which % steps make sense).
function buildScenarios(strategy, debit = false) {
  const s = normalizeStrategy(strategy);
  const g = debit ? GRID.debit : GRID.credit;
  const sameExit = (x) => x.time === s.exit.time && (s.mode === 'intraday' || x.dteDays === s.exit.dteDays);
  const plain = s.risk.sl == null && s.risk.tgt == null; // no rupee / % of capital rule: "as defined" is one of the cells
  const out = [];
  for (const exit of exitsOf(s)) {
    for (const tgt of [null, ...g.tgt]) {
      for (const sl of [null, ...g.sl]) {
        const base = plain && sameExit(exit) && tgt === s.risk.tgtPrem && sl === s.risk.slPrem;
        out.push({ key: `t${tgt ?? 0}s${sl ?? 0}x${exit.dteDays ?? ''}@${exit.time}`, tgt, sl, exit, ...(base ? { base: true } : {}) });
      }
    }
  }
  if (!out.some((x) => x.base))
    out.unshift({
      key: 'base',
      base: true,
      own: true,
      tgt: null,
      sl: null,
      exit: s.mode === 'intraday' ? { time: s.exit.time } : { dteDays: s.exit.dteDays, time: s.exit.time },
    });
  return out;
}

// The strategy with a scenario's overall stop, target and exit. `own` = the strategy's own rules, untouched.
function applyScenario(strategy, sc) {
  const s = normalizeStrategy(strategy);
  if (!sc || sc.own) return s;
  const pctOf = (v) => (Number(v) > 0 ? Math.min(1000, Number(v)) : null);
  s.risk.sl = null;
  s.risk.tgt = null;
  s.risk.slPrem = pctOf(sc.sl);
  s.risk.tgtPrem = pctOf(sc.tgt);
  if (/^\d{2}:\d{2}$/.test(sc.exit?.time)) s.exit.time = sc.exit.time;
  if (s.mode === 'positional' && sc.exit?.dteDays != null) s.exit.dteDays = Math.max(0, Math.min(40, Math.round(Number(sc.exit.dteDays) || 0)));
  return s;
}

module.exports = { buildScenarios, applyScenario, exitsOf };
