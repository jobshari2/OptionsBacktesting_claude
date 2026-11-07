// A strategy as the app stores it: defined relative to the market (ATM offsets, premium, delta, % of spot, expiry
// "current/next week/month"), so the same definition works on any expiry. normalizeStrategy() fills in the defaults
// and drops anything malformed; wholeStrategyStops() turns per-leg stops into one stop on the whole strategy.
// Used by the saved strategies and the live deployment of a strategy (bt/index.js, Strategies screen).
const { normCondition } = require('./conditions');
const BS = require('../lib/backspread');

// ---------- strategy defaults ----------
const ACTIONS = new Set(['B', 'S']);
const TYPES = new Set(['CE', 'PE']);
const EXPIRIES = new Set(['cur', 'next', 'mcur', 'mnext']);
const STRIKE_BY = new Set(['atm', 'premium', 'delta', 'pct', 'pts', 'straddle', 'signal', 'sr', 'leg', 'pick']);
const LEVEL = new Set(['none', 'pct', 'pts', 'upct', 'upts', 'srb']);
const LV = new Set(['any', 'major', 'minor']);

function normLevel(x) {
  const type = LEVEL.has(x?.type) ? x.type : 'none';
  const value = Number(x?.value);
  if (type === 'srb') return { type, value: value >= 0 ? value : 0, lv: LV.has(x.lv) ? x.lv : 'any' }; // buffer may be 0
  return type === 'none' || !(value > 0) ? { type: 'none', value: 0 } : { type, value };
}

const ADJ_ON = new Set(['move', 'near', 'prem']);
const ADJ_ACTION = new Set(['tested', 'untested', 'both']);
function normAdjust(a) {
  if (!a || !ADJ_ON.has(a.on)) return null;
  const value = Number(a.value);
  if (!(value > 0 || (a.on === 'near' && value === 0))) return null;
  if (a.on === 'prem' && !(value > 1)) return null;
  return {
    on: a.on,
    value,
    unit: a.on === 'prem' ? 'x' : a.unit === 'pct' ? 'pct' : 'pts',
    action: ADJ_ACTION.has(a.action) ? a.action : 'tested',
    max: Math.max(1, Math.min(10, Math.round(Number(a.max) || 2))),
  };
}

function normPick(p) {
  if (p?.kind !== 'backfly') return null;
  const widths = (Array.isArray(p.widths) ? p.widths.map(Number) : BS.WIDTHS).filter((w) => BS.WIDTHS.includes(w));
  return {
    kind: 'backfly',
    side: p.side === 'CE' ? 'CE' : 'PE',
    win: Math.max(1, Math.min(40, Math.round(Number(p.win) || 10))),
    widths: widths.length ? widths : BS.WIDTHS,
    form: p.form === 'iron' ? 'iron' : 'same',
    rank: BS.RANKS[p.rank] ? p.rank : 'loss',
    fresh: Math.max(0, Math.min(120, Math.round(Number(p.fresh ?? 15) || 0))), // minutes; 0 = no check
    maxLoss: Math.max(0, Number(p.maxLoss) || 0), // ₹ per unit at worst; 0 = no limit
  };
}

function normalizeStrategy(s) {
  const legs = (Array.isArray(s?.legs) ? s.legs : []).slice(0, 12).map((l) => ({
    action: ACTIONS.has(l.action) ? l.action : 'S',
    type: TYPES.has(l.type) ? l.type : 'CE',
    lots: Math.max(1, Math.min(100, Math.round(Number(l.lots) || 1))),
    expiry: EXPIRIES.has(l.expiry) ? l.expiry : 'cur',
    strike: {
      by: STRIKE_BY.has(l.strike?.by) ? l.strike.by : 'atm',
      value: Number(l.strike?.value) || 0,
      match: ['closest', 'gte', 'lte'].includes(l.strike?.match) ? l.strike.match : 'closest',
      ...(l.strike?.by === 'signal' ? { ref: l.strike.ref === 'ref' ? 'ref' : 'hit' } : {}),
      ...(l.strike?.by === 'sr' ? { lv: LV.has(l.strike.lv) ? l.strike.lv : 'any' } : {}),
      ...(l.strike?.by === 'leg' ? { ref: Math.max(0, Math.min(11, Math.round(Number(l.strike.ref) || 0))) } : {}),
      ...(l.strike?.by === 'pick' ? { role: BS.ROLES.includes(l.strike.role) ? l.strike.role : 'm' } : {}),
    },
    sl: normLevel(l.sl),
    tgt: normLevel(l.tgt),
    trail: l.trail && Number(l.trail.x) > 0 && Number(l.trail.y) > 0 ? { x: Number(l.trail.x), y: Number(l.trail.y) } : null,
    re:
      l.re && ['sl', 'tgt', 'both'].includes(l.re.on) && ['asap', 'cost', 'atm'].includes(l.re.mode)
        ? { on: l.re.on, mode: l.re.mode, max: Math.max(1, Math.min(10, Math.round(Number(l.re.max) || 1))) }
        : null,
    roll: l.roll
      ? { dteDays: Math.max(0, Math.min(5, Math.round(Number(l.roll.dteDays) || 0))), time: /^\d{2}:\d{2}$/.test(l.roll.time) ? l.roll.time : '15:15' }
      : null,
  }));
  legs.forEach((l, i) => {
    // "from leg" must point at another leg resolved before it; otherwise fall back to ATM
    if (l.strike.by !== 'leg') return;
    const r = legs[l.strike.ref];
    if (!r || l.strike.ref === i || (r.strike.by === 'leg' && l.strike.ref > i)) l.strike = { by: 'atm', value: 0, match: 'closest' };
  });
  const num = (v) => (Number(v) > 0 ? Number(v) : null);
  const num0 = (v) => (v === '' || v == null || !(Number(v) >= 0) ? null : Number(v)); // 0 is a real limit
  const r = s?.risk || {};
  return {
    id: s?.id || null,
    name: String(s?.name || 'Untitled').slice(0, 80),
    desc: String(s?.desc || '').slice(0, 400),
    category: String(s?.category || 'Custom').slice(0, 30),
    mode: s?.mode === 'positional' ? 'positional' : 'intraday',
    expiry: s?.expiry === 'monthly' ? 'monthly' : 'weekly',
    entry: {
      time: /^\d{2}:\d{2}$/.test(s?.entry?.time) ? s.entry.time : '09:20',
      days: Array.isArray(s?.entry?.days) && s.entry.days.length ? s.entry.days.map(Number).filter((d) => d >= 1 && d <= 5) : [1, 2, 3, 4, 5],
      dte: Array.isArray(s?.entry?.dte) ? s.entry.dte.map(Number).filter((d) => d >= 0 && d <= 30) : [],
      dteDays: Math.max(0, Math.min(40, Math.round(Number(s?.entry?.dteDays) || 0))),
      after: Math.max(0, Math.min(6, Math.round(Number(s?.entry?.after) || 0))),
      noOverlap: Boolean(s?.entry?.noOverlap),
      when: s?.entry?.when === 'signal' ? 'signal' : 'time',
      until: /^\d{2}:\d{2}$/.test(s?.entry?.until) ? s.entry.until : '14:30',
      maxTrades: Math.max(1, Math.min(5, Math.round(Number(s?.entry?.maxTrades) || 1))),
      conditions: (Array.isArray(s?.entry?.conditions) ? s.entry.conditions : []).map(normCondition).filter(Boolean).slice(0, 6),
    },
    exit: {
      time: /^\d{2}:\d{2}$/.test(s?.exit?.time) ? s.exit.time : '15:15',
      dteDays: Math.max(0, Math.min(40, Math.round(Number(s?.exit?.dteDays) || 0))),
    },
    legs,
    risk: {
      sl: num(r.sl),
      tgt: num(r.tgt),
      slPrem: num(r.slPrem),
      tgtPrem: num(r.tgtPrem),
      lockAt: num(r.lockAt),
      lockTo: Number(r.lockTo) || 0,
      trailEvery: num(r.trailEvery),
      trailBy: num(r.trailBy),
      onLegSl: r.onLegSl === 'all' ? 'all' : 'leg',
      slToCost: Boolean(r.slToCost),
      unit: r.unit === 'pct' ? 'pct' : 'inr',
      partialAt: num(r.partialAt),
      partialPct: Math.max(1, Math.min(99, Number(r.partialPct) || 60)),
      partialFloor: r.partialFloor === '' || r.partialFloor == null || isNaN(Number(r.partialFloor)) ? null : Number(r.partialFloor),
    },
    adjust: normAdjust(s?.adjust),
    pick: normPick(s?.pick),
    filters: {
      vixMin: num(s?.filters?.vixMin),
      vixMax: num(s?.filters?.vixMax),
      minCredit: num(s?.filters?.minCredit),
      maxLossDown: num0(s?.filters?.maxLossDown),
      maxLossUp: num0(s?.filters?.maxLossUp),
    },
  };
}

// Stops judge the whole strategy, never one leg (the app's rule). A leg stop in % of its premium becomes a stop on the
// whole position at that % of the entry premium (the smallest one if legs differ, or the strategy's own if that is
// nearer); stops on a leg's points, on a Nifty move or on S/R have no whole-strategy equivalent and are dropped, with
// their trailing and their re-entry after a stop. Leg targets stay as they are.
function wholeStrategyStops(raw) {
  const s = normalizeStrategy(raw);
  const pcts = s.legs.filter((l) => l.sl.type === 'pct').map((l) => l.sl.value);
  if (pcts.length) s.risk.slPrem = Math.min(s.risk.slPrem ?? Infinity, ...pcts);
  for (const l of s.legs) {
    l.sl = { type: 'none', value: 0 };
    l.trail = null;
    if (l.re?.on === 'sl') l.re = null;
    else if (l.re?.on === 'both') l.re.on = 'tgt';
  }
  s.risk.onLegSl = 'all';
  s.risk.slToCost = false;
  return s;
}

module.exports = { normalizeStrategy, wholeStrategyStops };
