// Trading Ideas › NIFTYBEES + options: NIFTYBEES worth one lot of Nifty (65 × Nifty, or a ₹ budget), as in the Covered
// call and the collars, plus any options structure the user builds: legs placed in points from the ATM, entered on
// every monthly series' first trading day and held to the monthly expiry.
//   legs: [{ type: 'CE' | 'PE', side: 1 (buy) | -1 (sell), off: points from the ATM (+ above, − under), lots }]
// Adjustments are generic, per side of the structure (all CE legs together, all PE legs together): when Nifty has moved
// movePct % from that side's entry or last roll (or the side has decayed to decayPct % of its entry value), the side is
// re-centred: every leg of it closed and opened again at its own distance from the new ATM. Each direction is a switch
// (calls follow a fall / a rise, puts follow a rise / a fall), so the collars' rules are special cases (sold call down
// in a fall = calls follow a fall; put spread up in a rise = puts follow a rise).
// The backtest, study and model path are the Covered call's (bt/mcc.js runMcc / runMccStudy / runMccModel) driven by
// this file's legs and rules, so the results are directly comparable with the Covered call and the collars.
const M = require('./mcc');

const { snap, atmOf } = M;

// The structures the screen offers as a start (the user may change every leg).
const PRESETS = [
  {
    id: 'psc',
    name: 'Put spread collar',
    legs: [
      { type: 'CE', side: -1, off: 100, lots: 1 },
      { type: 'PE', side: 1, off: -100, lots: 1 },
      { type: 'PE', side: -1, off: -200, lots: 1 },
    ],
  },
  {
    id: 'bpc',
    name: 'Bull put collar',
    legs: [
      { type: 'CE', side: -1, off: 100, lots: 1 },
      { type: 'PE', side: -1, off: -100, lots: 1 },
      { type: 'PE', side: 1, off: -200, lots: 1 },
    ],
  },
  { id: 'cc', name: 'Plain covered call', legs: [{ type: 'CE', side: -1, off: 100, lots: 1 }] },
  {
    id: 'mcc',
    name: 'Modified covered call (fixed strikes)',
    legs: [
      { type: 'CE', side: 1, off: 100, lots: 1 },
      { type: 'CE', side: -1, off: 200, lots: 2 },
      { type: 'PE', side: 1, off: -100, lots: 2 },
      { type: 'PE', side: -1, off: -300, lots: 3 },
      { type: 'PE', side: 1, off: -400, lots: 1 },
    ],
  },
  {
    id: 'collar',
    name: 'Collar (sell call, buy put)',
    legs: [
      { type: 'CE', side: -1, off: 200, lots: 1 },
      { type: 'PE', side: 1, off: -200, lots: 1 },
    ],
  },
  { id: 'pput', name: 'Protective put', legs: [{ type: 'PE', side: 1, off: -200, lots: 1 }] },
  {
    id: 'ic',
    name: 'Iron condor',
    legs: [
      { type: 'CE', side: -1, off: 200, lots: 1 },
      { type: 'CE', side: 1, off: 400, lots: 1 },
      { type: 'PE', side: -1, off: -200, lots: 1 },
      { type: 'PE', side: 1, off: -400, lots: 1 },
    ],
  },
  {
    id: 'ccspread',
    name: 'Call spread sold + put bought',
    legs: [
      { type: 'CE', side: -1, off: 100, lots: 1 },
      { type: 'CE', side: 1, off: 300, lots: 1 },
      { type: 'PE', side: 1, off: -200, lots: 1 },
    ],
  },
  {
    id: 'ratio',
    name: 'Call ratio 1×2 + put spread',
    legs: [
      { type: 'CE', side: 1, off: 100, lots: 1 },
      { type: 'CE', side: -1, off: 200, lots: 2 },
      { type: 'PE', side: 1, off: -100, lots: 1 },
      { type: 'PE', side: -1, off: -200, lots: 1 },
    ],
  },
];

const DEFAULTS = {
  lotSize: 65,
  lots: 1, // multiplier on every leg's lots (and on the ETF when no budget is set)
  budget: 0, // ₹ of NIFTYBEES (0 = 65 × lots × Nifty worth); only the ETF's quantity and P&L change
  entryMin: 15, // minutes after 09:15 on the series' first day (09:30)
  minDays: 15,
  legs: PRESETS[0].legs.map((l) => ({ ...l })),
  drop: '', // the study's structure rows: 'CE' or 'PE' leaves that side out
  adj: {
    on: true,
    trigger: 'move', // 'move': Nifty moved movePct % from the side's last roll (or entry); 'decay': the side is worth decayPct % of its entry value
    movePct: 2,
    decayPct: 35,
    check: 'close', // 'close': once a day at 15:00; 'hourly': 10:30 … 15:00
    lastDays: 3, // no adjustments in the last N trading days of the series
    maxPerSide: 3, // rolls per side per month
    ceDown: true, // market down: the call legs follow Nifty down (the collars' "sold call rolled down")
    ceUp: false, // market up: the call legs follow Nifty up
    peUp: true, // market up: the put legs follow Nifty up (the collars' "put spread moved up")
    peDown: false, // market down: the put legs follow Nifty down
  },
  up: { mode: 'none' }, // the Covered call's up-market extras: not used here ("calls follow a rise" instead)
  etf: 'model', // 'model' = ₹1 per 100 Nifty points (Nifty ÷ 100); 'real' = recorded NIFTYBEES prices
  costs: { slipPct: 0.5, brokerage: 20, taxes: true, etfSlipPct: 0.05 },
  target: { on: false, amount: 0 },
};
const NESTED = ['adj', 'up', 'costs'];
const MAX_LEGS = 8;

// One leg from the page, checked: { type, side, off (multiple of 50, ±3000), lots (0–20) }; null when unusable.
function cleanLeg(l) {
  if (!l || typeof l !== 'object') return null;
  const type = l.type === 'PE' ? 'PE' : l.type === 'CE' ? 'CE' : null;
  const side = Number(l.side) > 0 ? 1 : Number(l.side) < 0 ? -1 : null;
  const off = Math.round(Number(l.off) / 50) * 50;
  const lots = Math.round(Number(l.lots));
  if (!type || !side || !Number.isFinite(off) || Math.abs(off) > 3000 || !(lots >= 0 && lots <= 20)) return null;
  return { type, side, off, lots };
}
const merge = (p = {}) => {
  const out = { ...DEFAULTS, ...p };
  for (const k of NESTED) out[k] = { ...DEFAULTS[k], ...(p[k] || {}) };
  out.up = { mode: 'none' };
  out.target = { on: false, amount: 0 };
  const legs = Array.isArray(p.legs) ? p.legs.map(cleanLeg).filter(Boolean) : DEFAULTS.legs;
  out.legs = legs.slice(0, MAX_LEGS).map((l) => ({ ...l }));
  out.drop = p.drop === 'CE' || p.drop === 'PE' ? p.drop : '';
  return out;
};

// The opening legs for Nifty at S: [{ role, type, side, strike, lots, off }]. role: 'L<i>' (the leg's place in the list).
function legsAt(S, p, strikes) {
  const A = atmOf(S);
  return p.legs
    .map((l, i) => ({ role: 'L' + i, type: l.type, side: l.side, off: l.off, strike: snap(strikes, A + l.off), lots: l.lots * p.lots }))
    .filter((l) => l.lots > 0 && l.type !== p.drop);
}
const pickLegs = (S, p, strikes) => ({ legs: legsAt(S, p, strikes), p, shape: null });
const withShape = (p) => p;
const shapeText = () => '';
const shapeStrikes = () => [];

// "Sell 1 CE ATM+100" etc.
const legRule = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} ${l.type} ATM${l.off === 0 ? '' : l.off > 0 ? '+' + l.off : '−' + -l.off}`;
const structureText = (p) =>
  (p.legs
    .filter((l) => l.lots > 0)
    .map(legRule)
    .join(', ') || 'no option legs') + (p.drop ? ` (${p.drop} legs left out)` : '');

// The adjustments due now (bt/mcc.js decide's contract: [{ kind, reason, close: [{ id, lots }], open: [legs], ref }]).
function decide(pos, S, ctx, p) {
  const out = [];
  if (!p.adj.on || ctx.daysLeft < p.adj.lastDays) return out;
  const A = atmOf(S);
  const n0 = (x) => x.toFixed(0);
  const decay = p.adj.trigger === 'decay';
  for (const type of ['CE', 'PE']) {
    const legs = pos.legs.filter((l) => l.type === type && l.lots > 0);
    if (!legs.length) continue;
    const call = type === 'CE';
    if ((call ? pos.n.call : pos.n.put) >= p.adj.maxPerSide) continue;
    const ref = call ? pos.refCall : pos.refPut;
    const moved = legs.map((l) => ({ l, k: snap(ctx.strikes, A + (l.off ?? 0)) }));
    const dir = moved[0].k > moved[0].l.strike ? 1 : moved[0].k < moved[0].l.strike ? -1 : 0;
    if (!dir) continue;
    const allowed = call ? (dir > 0 ? p.adj.ceUp : p.adj.ceDown) : dir > 0 ? p.adj.peUp : p.adj.peDown;
    if (!allowed) continue;
    let why;
    if (decay) {
      // the side's value now against its entry value (both as positive amounts: a credit to buy back or a debit held)
      if (legs.some((l) => ctx.px(l) == null)) continue;
      const was = Math.abs(legs.reduce((s, l) => s + l.side * l.entry * l.lots, 0));
      const now = Math.abs(legs.reduce((s, l) => s + l.side * ctx.px(l) * l.lots, 0));
      if (!(was > 0) || now > (was * p.adj.decayPct) / 100) continue;
      why = `${call ? 'call' : 'put'} legs worth ${now.toFixed(1)} (${((now / was) * 100).toFixed(0)} % of ${was.toFixed(1)})`;
    } else {
      const due = dir > 0 ? S >= ref * (1 + p.adj.movePct / 100) : S <= ref * (1 - p.adj.movePct / 100);
      if (!due) continue;
      why = `Nifty ${n0(S)} is ${(((S - ref) / ref) * 100).toFixed(1)} % ${dir > 0 ? 'above' : 'under'} the last roll (${n0(ref)})`;
    }
    const from = legs.map((l) => l.strike).join('/');
    const to = moved.map((x) => x.k).join('/');
    out.push({
      kind: call ? (dir > 0 ? 'rollCallUp' : 'rollCall') : dir > 0 ? 'rollPut' : 'rollPutDn',
      reason: `${why}: ${call ? 'call' : 'put'} legs moved ${dir > 0 ? 'up' : 'down'} ${from} → ${to}`,
      close: legs.map((l) => ({ id: l.id, lots: l.lots })),
      open: moved.map(({ l, k }) => ({ role: l.role, type: l.type, side: l.side, off: l.off, strike: k, lots: l.lots })),
      ref: call ? { call: S } : { put: S },
    });
  }
  return out;
}

// ---------- the study: which adjustment rule, and what each side of the structure adds ----------
const STUDY = [
  ['none', 'No adjustments', { adj: { on: false } }],
  ['move1', 'Roll at a 1 % move', { adj: { movePct: 1 } }],
  ['move15', 'Roll at a 1.5 % move', { adj: { movePct: 1.5 } }],
  ['move2', 'Roll at a 2 % move', { adj: { movePct: 2 } }],
  ['move3', 'Roll at a 3 % move', { adj: { movePct: 3 } }],
  ['move2h', '2 % move, checked hourly', { adj: { movePct: 2, check: 'hourly' } }],
  ['move2l0', '2 % move, also in the last 3 days', { adj: { movePct: 2, lastDays: 0 } }],
  ['callsDn2', 'Only calls follow a fall (2 %)', { adj: { movePct: 2, ceDown: true, ceUp: false, peUp: false, peDown: false } }],
  ['putsUp2', 'Only puts follow a rise (2 %)', { adj: { movePct: 2, ceDown: false, ceUp: false, peUp: true, peDown: false } }],
  ['callsBoth2', 'Calls follow Nifty both ways (2 %)', { adj: { movePct: 2, ceDown: true, ceUp: true, peUp: false, peDown: false } }],
  ['putsBoth2', 'Puts follow Nifty both ways (2 %)', { adj: { movePct: 2, ceDown: false, ceUp: false, peUp: true, peDown: true } }],
  ['all2', 'Every side follows Nifty both ways (2 %)', { adj: { movePct: 2, ceDown: true, ceUp: true, peUp: true, peDown: true } }],
  ['decay35', 'Roll a side at 35 % of its entry value', { adj: { trigger: 'decay', decayPct: 35 } }],
  ['decay50', 'Roll a side at 50 % of its entry value', { adj: { trigger: 'decay', decayPct: 50 } }],
  ['noCalls', 'No call legs: NIFTYBEES + put legs only', { adj: { on: false }, drop: 'CE' }],
  ['noPuts', 'No put legs: NIFTYBEES + call legs only', { adj: { on: false }, drop: 'PE' }],
];

const ENGINE = { merge, pickLegs, shapeStrikes, shapeText, decide, STUDY, DEFAULTS };
const runNbo = (data, params, range, opts) => M.runMcc(data, params, range, opts, ENGINE);
const runNboStudy = (data, base, range, opts) => M.runMccStudy(data, { ...base, drop: '' }, range, opts, ENGINE);
const runNboModel = (params, opts) => M.runMccModel(params, opts, ENGINE);

module.exports = {
  DEFAULTS,
  PRESETS,
  STUDY,
  ENGINE,
  MAX_LEGS,
  merge,
  cleanLeg,
  legsAt,
  pickLegs,
  withShape,
  shapeText,
  structureText,
  legRule,
  decide,
  runNbo,
  runNboStudy,
  runNboModel,
};
