// Trading Ideas › Put spread collar: NIFTYBEES worth one lot of Nifty (65 × Nifty), as in the Covered call, plus on
// every monthly series (entered on its first trading day, held to the monthly expiry):
//   - a sold call: sell 1 lot CE 100 pts over ATM (covered by the NIFTYBEES)
//   - a put spread: buy 1 lot PE 100 pts under ATM, sell 1 lot PE 100 pts under the bought one
// The sold call pays for the put spread; the put spread cushions the NIFTYBEES for its 100 pts.
// Adjustments (switchable, the study compares them): market down → the sold call is rolled down to its entry distance
// from the new ATM (more premium); market up → the put spread is moved up to the new ATM, keeping the protection near
// the money; optionally the put spread follows a fall too (books its gain). Up-market extras on the sold call as in the
// Covered call (roll it up, buy it back, buy a hedge call). The backtest, study, model path and paper trade are the
// Covered call's (bt/mcc.js runMcc / runMccStudy / runMccModel, mccpaper.js) driven by this file's legs and rules.
const M = require('./mcc');

const { snap, atmOf } = M;

const DEFAULTS = {
  lotSize: 65,
  lots: 1, // multiplier on every quantity below (and on the ETF)
  budget: 0, // ₹ of NIFTYBEES (0 = 65 × lots × Nifty worth); only the ETF's quantity and P&L change
  entryMin: 15, // minutes after 09:15 on the series' first day (09:30)
  minDays: 15, // paper trade: a series with fewer calendar days than this left is skipped for next month's
  ce: { sellOff: 100, sell: 1 }, // sold call at ATM + sellOff
  pe: { buyOff: 100, sellGap: 100, buy: 1, sell: 1 }, // bought put at ATM − buyOff, sold put sellGap under it
  adj: {
    on: true,
    trigger: 'move', // 'move': Nifty moved movePct % from the side's last roll (or entry); 'decay': the leg / spread is worth decayPct % of its entry
    movePct: 2,
    decayPct: 35,
    check: 'close', // 'close': once a day at 15:00; 'hourly': 10:30 … 15:00
    lastDays: 3, // no adjustments in the last N trading days of the series
    maxPerSide: 3, // rolls per side per month
    call: true, // market down: the sold call rolled down
    put: true, // market up: the put spread moved up
    putDown: false, // market down: the put spread moved down as well (books its gain, protection follows)
  },
  up: {
    mode: 'none', // 'none' | 'roll' (sold call up to the new ATM + sellOff) | 'buyBack' (buy the sold call back once) | 'hedge' (buy a call hedgeGap over it once)
    buffer: 0, // pts: acts when Nifty is at or above the sold call strike + buffer
    max: 2, // times per month ('roll')
    hedgeGap: 200,
  },
  etf: 'model', // 'model' = ₹1 per 100 Nifty points (Nifty ÷ 100); 'real' = recorded NIFTYBEES prices
  costs: { slipPct: 0.5, brokerage: 20, taxes: true, etfSlipPct: 0.05 },
  target: { on: false, amount: 0 }, // no ideal-trade search here: the strikes are the fixed distances above
};
const NESTED = ['ce', 'pe', 'adj', 'up', 'costs', 'target'];
const merge = (p = {}) => {
  const out = { ...DEFAULTS, ...p };
  for (const k of NESTED) out[k] = { ...DEFAULTS[k], ...(p[k] || {}) };
  out.target = { on: false, amount: 0 }; // the Covered call's ideal trade does not apply to this shape
  return out;
};

// The opening legs for Nifty at S: [{ role, type, side, strike, lots }] (ceS sold call, peL bought put, peS sold put).
function legsAt(S, p, strikes) {
  const A = atmOf(S);
  const ceS = snap(strikes, A + p.ce.sellOff);
  const peL = snap(strikes, A - p.pe.buyOff);
  const peS = snap(strikes, peL - p.pe.sellGap);
  const L = p.lots;
  return [
    { role: 'ceS', type: 'CE', side: -1, strike: ceS, lots: p.ce.sell * L },
    { role: 'peL', type: 'PE', side: 1, strike: peL, lots: p.pe.buy * L },
    { role: 'peS', type: 'PE', side: -1, strike: peS, lots: p.pe.sell * L },
  ].filter((l) => l.lots > 0);
}
// The Covered call's runner asks for these; the collar's strikes are always the fixed distances.
const pickLegs = (S, p, strikes) => ({ legs: legsAt(S, p, strikes), p, shape: null });
const withShape = (p) => p;
const shapeText = () => '';
const shapeStrikes = () => [];

// The adjustments due now (bt/mcc.js decide's contract: [{ kind, reason, close: [{ id, lots }], open: [legs], ref, flag }]).
function decide(pos, S, ctx, p) {
  const out = [];
  if (ctx.daysLeft < p.adj.lastDays) return out;
  const A = atmOf(S);
  const open = (role) => pos.legs.filter((l) => l.role === role && l.lots > 0);
  const [ceS] = open('ceS');
  const [peL] = open('peL');
  const [peS] = open('peS');
  const reopen = (legs, role, strike) => legs.filter((l) => l.role === role).map((l) => ({ role, type: l.type, side: l.side, strike, lots: l.lots }));
  const closeAll = (legs) => legs.map((l) => ({ id: l.id, lots: l.lots }));
  const n0 = (x) => x.toFixed(0);

  // up-market extras on the sold call
  let callDone = false;
  if (p.up.mode !== 'none' && ceS && S >= ceS.strike + p.up.buffer) {
    if (p.up.mode === 'roll' && pos.n.up < p.up.max) {
      const nS = snap(ctx.strikes, A + p.ce.sellOff);
      if (nS > ceS.strike) {
        out.push({
          kind: 'upRoll',
          reason: `Nifty ${n0(S)} reached the sold ${ceS.strike} CE: sold call moved up to ${nS}`,
          close: closeAll([ceS]),
          open: reopen([ceS], 'ceS', nS),
          ref: { call: S },
        });
        callDone = true;
      }
    } else if (p.up.mode === 'buyBack' && !pos.boughtBack) {
      out.push({
        kind: 'buyBack',
        reason: `Nifty ${n0(S)} reached the sold ${ceS.strike} CE: bought back, the NIFTYBEES gains above it are kept`,
        close: closeAll([ceS]),
        open: [],
        flag: 'boughtBack',
      });
      callDone = true;
    } else if (p.up.mode === 'hedge' && !pos.hedged) {
      const k = snap(ctx.strikes, ceS.strike + p.up.hedgeGap);
      out.push({
        kind: 'upHedge',
        reason: `Nifty ${n0(S)} reached the sold ${ceS.strike} CE: bought ${ceS.lots} lot ${k} CE, so the NIFTYBEES gains above ${k} are kept`,
        close: [],
        open: [{ role: 'ceH', type: 'CE', side: 1, strike: k, lots: ceS.lots }],
        flag: 'hedged',
      });
      callDone = true;
    }
  }
  if (!p.adj.on) return out;
  const decay = p.adj.trigger === 'decay';
  const px = (l) => (l ? ctx.px(l) : 0);
  const pctOf = (now, was) => `${((now / was) * 100).toFixed(0)} % of ${was.toFixed(1)}`;
  const moved = (ref, dir) => `Nifty ${n0(S)} is ${(((S - ref) / ref) * 100).toFixed(1)} % ${dir} the last roll (${n0(ref)})`;

  // the put spread: market up → moved up to the new ATM (decay: once the spread is worth decayPct % of its cost);
  // market down (putDown) → moved down to the new ATM, booking what it gained
  if (peL && pos.n.put < p.adj.maxPerSide) {
    const legs = [...open('peL'), ...open('peS')];
    const nL = snap(ctx.strikes, A - p.pe.buyOff);
    const nS = snap(ctx.strikes, nL - p.pe.sellGap);
    const move = (kind, why) => ({
      kind,
      reason: `${why}: put spread moved ${kind === 'rollPut' ? 'up' : 'down'} ${peL.strike}${peS ? '/' + peS.strike : ''} → ${nL}${peS ? '/' + nS : ''}`,
      close: closeAll(legs),
      open: [...reopen(legs, 'peL', nL), ...reopen(legs, 'peS', nS)],
      ref: { put: S },
    });
    const cost = peL.entry - (peS ? peS.entry : 0);
    const now = ctx.px(peL) != null && (!peS || ctx.px(peS) != null) ? px(peL) - px(peS) : null;
    const upDue = decay ? now != null && cost > 0 && now <= (cost * p.adj.decayPct) / 100 : S >= pos.refPut * (1 + p.adj.movePct / 100);
    if (p.adj.put && upDue && nL > peL.strike)
      out.push(move('rollPut', decay ? `put spread down to ${now.toFixed(1)} (${pctOf(now, cost)})` : moved(pos.refPut, 'above')));
    else if (p.adj.putDown && S <= pos.refPut * (1 - p.adj.movePct / 100) && nL < peL.strike) out.push(move('rollPutDn', moved(pos.refPut, 'under')));
  }
  // the sold call: market down → rolled down to its entry distance from the new ATM (decay: once worth decayPct %)
  if (p.adj.call && !callDone && ceS && pos.n.call < p.adj.maxPerSide) {
    const due = decay ? ctx.px(ceS) != null && ctx.px(ceS) <= (ceS.entry * p.adj.decayPct) / 100 : S <= pos.refCall * (1 - p.adj.movePct / 100);
    const nS = snap(ctx.strikes, A + p.ce.sellOff);
    if (due && nS < ceS.strike)
      out.push({
        kind: 'rollCall',
        reason: `${decay ? `sold ${ceS.strike} CE down to ${ctx.px(ceS).toFixed(1)} (${pctOf(ctx.px(ceS), ceS.entry)})` : moved(pos.refCall, 'under')}: sold call moved down ${ceS.strike} → ${nS}`,
        close: closeAll([ceS]),
        open: reopen([ceS], 'ceS', nS),
        ref: { call: S },
      });
  }
  return out;
}

// ---------- the study: which adjustment rule, and what each part of the structure adds ----------
const STUDY = [
  ['none', 'No adjustments', { adj: { on: false } }],
  ['move1', 'Roll at a 1 % move', { adj: { movePct: 1 } }],
  ['move15', 'Roll at a 1.5 % move', { adj: { movePct: 1.5 } }],
  ['move2', 'Roll at a 2 % move', { adj: { movePct: 2 } }],
  ['move3', 'Roll at a 3 % move', { adj: { movePct: 3 } }],
  ['move2h', '2 % move, checked hourly', { adj: { movePct: 2, check: 'hourly' } }],
  ['move2l0', '2 % move, also in the last 3 days', { adj: { movePct: 2, lastDays: 0 } }],
  ['callOnly2', 'Only the sold call rolled down (2 %)', { adj: { movePct: 2, put: false } }],
  ['putOnly2', 'Only the put spread moved up (2 %)', { adj: { movePct: 2, call: false } }],
  ['putBoth2', 'Put spread follows Nifty up and down (2 %), call kept', { adj: { movePct: 2, call: false, putDown: true } }],
  ['move2putDn', '2 % rolls + put spread follows a fall too', { adj: { movePct: 2, putDown: true } }],
  ['decay35', 'Roll a leg / the spread at 35 % of its premium', { adj: { trigger: 'decay', decayPct: 35 } }],
  ['decay50', 'Roll a leg / the spread at 50 % of its premium', { adj: { trigger: 'decay', decayPct: 50 } }],
  ['upRoll', 'Up only: sold call rolled up at its strike', { adj: { on: false }, up: { mode: 'roll' } }],
  ['upRoll100', 'Up only: sold call rolled up 100 pts over its strike', { adj: { on: false }, up: { mode: 'roll', buffer: 100 } }],
  ['upHedge', 'Up only: buy a call 200 pts over the sold strike', { adj: { on: false }, up: { mode: 'hedge' } }],
  ['upBuy', 'Up only: buy the sold call back at its strike', { adj: { on: false }, up: { mode: 'buyBack' } }],
  ['move2upRoll', '2 % rolls + sold call rolled up', { adj: { movePct: 2 }, up: { mode: 'roll' } }],
  ['noPut', 'No put spread: plain covered call', { adj: { on: false }, pe: { buy: 0, sell: 0 } }],
  ['noCall', 'No sold call: NIFTYBEES + put spread only', { adj: { on: false }, ce: { sell: 0 } }],
  ['call200', 'Call sold 200 pts over ATM', { adj: { on: false }, ce: { sellOff: 200 } }],
  ['putAtm', 'Put spread from ATM (ATM / −100)', { adj: { on: false }, pe: { buyOff: 0 } }],
  ['put200', 'Put spread 200 pts wide', { adj: { on: false }, pe: { sellGap: 200 } }],
  ['putLong', 'Bought put only (no sold put)', { adj: { on: false }, pe: { sell: 0 } }],
];

const ENGINE = { merge, pickLegs, shapeStrikes, shapeText, decide, STUDY, DEFAULTS };
const runPsc = (data, params, range, opts) => M.runMcc(data, params, range, opts, ENGINE);
const runPscStudy = (data, base, range, opts) => M.runMccStudy(data, base, range, opts, ENGINE);
const runPscModel = (params, opts) => M.runMccModel(params, opts, ENGINE);

module.exports = {
  // this strategy's own
  DEFAULTS,
  STUDY,
  ENGINE,
  merge,
  legsAt,
  pickLegs,
  withShape,
  shapeText,
  decide,
  runPsc,
  runPscStudy,
  runPscModel,
  // shared with the Covered call (what mccpaper.js takes from its engine)
  deepMerge: M.deepMerge,
  atmOf,
  snap,
  CHECK_MINS: M.CHECK_MINS,
  newPosition: M.newPosition,
  needs: M.needs,
  apply: M.apply,
  openLegs: M.openLegs,
  settle: M.settle,
  payoffAt: M.payoffAt,
  splitPnl: M.splitPnl,
  etfCost: M.etfCost,
  etfQty: M.etfQty,
  fill: M.fill,
  summarize: M.summarize,
  timeOf: M.timeOf,
};
