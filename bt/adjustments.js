// Adjustment variations for the Backtest screen's "Adjustments" tab: the loaded strategy with one adjustment
// changed at a time (take profit, overall stop, leg stops and re-entry, exit, roll timing, closing in the first
// week instead of rolling, entry filters, the mirror-image position). Each one is a complete strategy, so picking
// it shows the same details (scenarios, months, trades, equity) as the strategy itself.
// Which variations exist depends on the strategy: roll / week-1 ones need a rolled leg, "% of capital" stops need
// the strategy to use that unit, and so on.
const { normalizeStrategy } = require('./engine');

function buildAdjustments(strategy) {
  const base = normalizeStrategy(strategy);
  const out = [];
  const add = (key, group, name, note, change, extra = {}) => {
    const s = JSON.parse(JSON.stringify(base));
    change(s);
    out.push({ key, group, name, note, strategy: normalizeStrategy(s), ...extra });
  };
  const pos = base.mode === 'positional';
  const cap = base.risk.unit === 'pct'; // overall amounts are % of capital
  const shorts = base.legs.map((l, i) => (l.action === 'S' ? i : -1)).filter((i) => i >= 0);
  const rolled = base.legs.findIndex((l) => l.roll);
  // Trading days from the near-week expiry to the trade's expiry, for a position entered `after` series earlier.
  const week1 = pos && rolled >= 0 && base.entry.after >= 2 ? 5 * (base.entry.after - 1) : null;
  const stop = (s, v) => { if (cap) s.risk.sl = v; else { s.risk.sl = null; s.risk.slPrem = v; } };
  const stops = cap ? [3, 4, 5, 6] : [50, 100, 200];
  const stopTxt = (v) => (cap ? `stop ${v}% of capital` : `stop ${v}% of premium`);

  add('own', 'As defined', 'As defined', 'The strategy exactly as it is in the editor.', () => {});

  // ---- closing in the first week instead of rolling ----
  if (week1 != null && base.exit.dteDays < week1) {
    const w1 = (s) => { s.exit.dteDays = week1; s.legs.forEach((l) => { l.roll = null; }); };
    add('w1', 'Week-1 exit', 'Week-1 exit, no roll', 'Everything is closed on the near-week expiry day, while the near-week hedge is still alive: no roll.', w1);
    for (const v of stops) add(`w1-sl${v}`, 'Week-1 exit', `Week-1 exit, no roll, ${stopTxt(v)}`, 'Closed on the near-week expiry day, with an overall stop for the trending weeks.', (s) => { w1(s); stop(s, v); });
    if (cap) {
      for (const [t, v] of [[3, 5], [4, 5]]) add(`w1-t${t}-sl${v}`, 'Week-1 exit', `Week-1 exit, no roll, target ${t}%, stop ${v}% of capital`, 'A wider target with the week-1 exit.', (s) => { w1(s); s.risk.tgt = t; stop(s, v); });
    }
    add('w1-1430', 'Week-1 exit', `Week-1 exit at 14:30, no roll, ${stopTxt(stops[1])}`, 'Out before the last hour of the near-week expiry, when its hedge loses its value fastest.', (s) => { w1(s); stop(s, stops[1]); s.exit.time = '14:30'; });
    add('w1-day-before', 'Week-1 exit', 'Exit the day before the near-week expiry', 'Closed at the moment the roll would have happened.', (s) => { s.exit.dteDays = week1 + 1; });
  }

  // ---- lock a profit once it is there ----
  const lock = (s) => { s.risk.lockAt = 1.2; s.risk.lockTo = 0.5; };
  if (cap && base.risk.lockAt == null) {
    add('lock', 'Lock profit', 'Lock 0.5% of capital once up 1.2%', 'A trade that was clearly ahead can no longer end as a loser: it is closed if the profit falls back to the floor. Cuts the drawdown more than it costs.', lock);
    add('lock-1', 'Lock profit', 'Lock 0.3% of capital once up 1%', 'An earlier, lower floor.', (s) => { s.risk.lockAt = 1; s.risk.lockTo = 0.3; });
  }
  if (week1 != null && base.exit.dteDays < week1) {
    const w1 = (s) => { s.exit.dteDays = week1; s.legs.forEach((l) => { l.roll = null; }); };
    if (cap && base.risk.lockAt == null) add('w1-lock', 'Week-1 exit', 'Week-1 exit, no roll, lock 0.5% once up 1.2%', 'The week-1 exit with a profit floor.', (s) => { w1(s); lock(s); });
    if (base.filters.minCredit != null) {
      add('w1-credit', 'Week-1 exit', `Week-1 exit, no roll, net credit at least ${base.filters.minCredit + 10} pts`, 'The week-1 exit, only in the richer weeks: fewer trades, smaller drawdown.', (s) => { w1(s); s.filters.minCredit += 10; });
      add('w1-credit-sl', 'Week-1 exit', `Week-1 exit, no roll, net credit at least ${base.filters.minCredit + 10} pts, ${stopTxt(stops[1])}`, 'The richer weeks only, with an overall stop.', (s) => { w1(s); s.filters.minCredit += 10; stop(s, stops[1]); });
    }
  }

  // ---- a closer near-week hedge ----
  // The hedge bought in the nearer expiry, measured from a short leg: half the distance (e.g. 50 instead of 100).
  const nearHedge = base.legs.map((l, i) => (l.action === 'B' && l.strike.by === 'leg' && Math.abs(l.strike.value) >= 100 && base.legs[l.strike.ref]?.expiry !== l.expiry ? i : -1)).filter((i) => i >= 0);
  const closer = (s) => nearHedge.forEach((i) => { s.legs[i].strike.value /= 2; });
  if (nearHedge.length) {
    const d = Math.abs(base.legs[nearHedge[0]].strike.value) / 2;
    add('hedge-closer', 'Hedge', `Near-week hedge ${d} pts from the short strike`, 'A closer hedge follows the short leg better when Nifty moves against it; it costs more, so fewer weeks pass the credit filter.', closer);
    if (week1 != null && base.exit.dteDays < week1) add('hedge-closer-w1', 'Hedge', `Near-week hedge ${d} pts away, week-1 exit, no roll`, 'The closer hedge, with everything closed on the near-week expiry day.', (s) => { closer(s); s.exit.dteDays = week1; s.legs.forEach((l) => { l.roll = null; }); });
  }

  // ---- roll timing ----
  if (rolled >= 0) {
    const d = base.legs[rolled].roll.dteDays;
    for (const v of [0, 1, 2].filter((x) => x !== d)) add(`roll${v}`, 'Roll', v ? `Roll ${v} day${v > 1 ? 's' : ''} before the hedge expires` : 'Roll on the day the hedge expires', 'Same roll, different day.', (s) => { s.legs.forEach((l) => { if (l.roll) l.roll.dteDays = v; }); });
    add('noroll', 'Roll', 'No roll (hedge left to expire)', 'What a missed roll costs: the short side is unhedged after the near-week expiry. Unlimited risk.', (s) => { s.legs.forEach((l) => { l.roll = null; }); }, { risky: true });
  }

  // ---- take profit ----
  for (const v of [15, 20, 25, 30, 40]) add(`tp${v}`, 'Take profit', `Take profit ${v}% of the entry premium`, 'Whole position booked at this share of the net credit / debit.', (s) => { s.risk.tgt = null; s.risk.tgtPrem = v; });
  if (base.risk.tgt != null || base.risk.tgtPrem != null) add('tp-none', 'Take profit', 'No target (hold to the exit)', 'No overall profit target.', (s) => { s.risk.tgt = null; s.risk.tgtPrem = null; });

  // ---- overall stop ----
  for (const v of stops) add(`sl${v}`, 'Overall stop', `Overall ${stopTxt(v)}`, 'Whole position closed at this loss (checked on 1-minute closes).', (s) => stop(s, v));

  // ---- stops on the short legs ----
  if (shorts.length && shorts.every((i) => base.legs[i].sl.type === 'none')) {
    const each = (s, f) => shorts.forEach((i) => f(s.legs[i]));
    for (const v of [50, 100, 150]) add(`leg${v}`, 'Leg stops', `Short legs: stop at +${v}% of their premium`, 'Only the stopped leg is closed; the rest stays.', (s) => each(s, (l) => { l.sl = { type: 'pct', value: v }; }));
    add('leg100-all', 'Leg stops', 'Short legs: stop at +100%, then exit everything', 'A leg stop closes the whole position.', (s) => { each(s, (l) => { l.sl = { type: 'pct', value: 100 }; }); s.risk.onLegSl = 'all'; });
    add('leg100-re', 'Leg stops', 'Short legs: stop at +100%, re-sell a fresh strike once', 'The stopped short is sold again at the strike the strategy would pick now (rolling the tested side away).', (s) => each(s, (l) => { l.sl = { type: 'pct', value: 100 }; l.re = { on: 'sl', mode: 'atm', max: 1 }; }));
    for (const v of [1.5, 2]) add(`nifty${v}`, 'Leg stops', `Short legs: stop when Nifty moves ${v}% against them`, 'Only the stopped leg is closed.', (s) => each(s, (l) => { l.sl = { type: 'upct', value: v }; }));
    add('nifty2-all', 'Leg stops', 'Nifty moves 2% against a short leg: exit everything', 'A leg stop closes the whole position.', (s) => { each(s, (l) => { l.sl = { type: 'upct', value: 2 }; }); s.risk.onLegSl = 'all'; });
  }

  // ---- exit ----
  if (pos && base.exit.dteDays === 0) add('exit1', 'Exit', 'Exit one day before expiry', 'Avoids the expiry-day swings.', (s) => { s.exit.dteDays = 1; });

  // ---- entry filters ----
  if (base.filters.minCredit != null) {
    for (const v of [10, 20]) add(`credit+${v}`, 'Entry filter', `Net credit at least ${base.filters.minCredit + v} pts`, 'Fewer, richer entries.', (s) => { s.filters.minCredit += v; });
  }
  if (base.filters.vixMax == null) add('vix-max15', 'Entry filter', 'Enter only when India VIX is at most 15', 'Skips the nervous weeks.', (s) => { s.filters.vixMax = 15; });
  if (base.filters.vixMin == null) add('vix-min12', 'Entry filter', 'Enter only when India VIX is at least 12', 'Skips the weeks with little premium.', (s) => { s.filters.vixMin = 12; });

  // ---- the mirror image: calls and puts swapped ----
  const flip = (l) => JSON.stringify({ ...l, type: l.type === 'CE' ? 'PE' : 'CE', strike: { ...l.strike, value: l.strike.by === 'leg' ? -l.strike.value : l.strike.value } });
  const symmetric = JSON.stringify(base.legs.map(flip).sort()) === JSON.stringify(base.legs.map((l) => JSON.stringify(l)).sort());
  if (new Set(base.legs.map((l) => l.type)).size === 2 && !symmetric) {
    const mirror = (s) => {
      s.legs.forEach((l) => { l.type = l.type === 'CE' ? 'PE' : 'CE'; if (l.strike.by === 'leg') l.strike.value = -l.strike.value; });
      [s.filters.maxLossDown, s.filters.maxLossUp] = [s.filters.maxLossUp, s.filters.maxLossDown];
    };
    add('rev', 'Reverse', 'Reverse: calls and puts swapped', 'The mirror image: what protected the downside now protects the upside, and the other way round.', mirror);
    if (week1 != null && base.exit.dteDays < week1) {
      const w1 = (s) => { mirror(s); s.exit.dteDays = week1; s.legs.forEach((l) => { l.roll = null; }); };
      add('rev-w1', 'Reverse', 'Reverse, week-1 exit, no roll', 'The mirror image, closed on the near-week expiry day.', w1);
      if (nearHedge.length) {
        const d = Math.abs(base.legs[nearHedge[0]].strike.value) / 2;
        add('rev-w1-closer', 'Reverse', `Reverse, hedge ${d} pts away, week-1 exit, no roll`, 'The mirror image with the closer near-week hedge: the form of the reverse that held up in testing.', (s) => { w1(s); closer(s); });
        if (cap && base.risk.lockAt == null) add('rev-w1-closer-lock', 'Reverse', `Reverse, hedge ${d} pts away, week-1 exit, lock 0.5% once up 1.2%`, 'The reverse form with the smallest drawdown in testing.', (s) => { w1(s); closer(s); s.risk.lockAt = 1.2; s.risk.lockTo = 0.5; });
        if (base.filters.vixMin == null) add('rev-w1-closer-vix', 'Reverse', `Reverse, hedge ${d} pts away, week-1 exit, India VIX at least 12`, 'The same, skipping the quiet weeks.', (s) => { w1(s); closer(s); s.filters.vixMin = 12; });
      }
      add(`rev-w1-sl${stops[1]}`, 'Reverse', `Reverse, week-1 exit, no roll, ${stopTxt(stops[1])}`, 'The mirror image with the week-1 exit and an overall stop.', (s) => { w1(s); stop(s, stops[1]); });
    }
  }
  return out;
}

module.exports = { buildAdjustments };
