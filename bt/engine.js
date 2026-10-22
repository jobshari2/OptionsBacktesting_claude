// Backtest engine: replays a strategy minute by minute over cached 1-minute option candles.
//
// A strategy is defined relative to the market (ATM offsets, premium, delta, % of spot, expiry
// "current/next week/month"), so the same definition works for every past and future expiry.
//
// Fills: entry and timed exit at the OPEN of that minute's candle; stop-loss / target are checked against
// each candle's high/low (stop first when both are touched in one candle — the conservative choice) and
// fill at the trigger price, or at the open if the candle gapped through it. Overall MTM rules are checked
// on candle closes. Slippage is applied against you on every fill. Marks and fills are never below the option's
// intrinsic value (a stale price of a deep in-the-money contract that stopped trading).
//
// Signal-triggered strategies (entry.when = 'signal') scan each session from the entry time to the
// "until" time and enter at the open of the minute after all entry conditions hold (anomaly fired, near or
// through a support/resistance level, Nifty move...), up to maxTrades times a day. Legs can take their
// strike from the anomaly ("signal") or from the nearest support/resistance level ("sr"), and a leg can
// stop out when Nifty closes through the level beyond it ("srb").
//
// Multi-expiry hedging (e.g. the bi-weekly hedge in library.js):
//  - entry.after = n: positional entry on the trading day after the expiry n series before the trade's expiry (the
//    start of a new series, whatever the weekday or holidays), instead of n trading days before it. Series are weekly
//    expiries for a weekly cycle and monthly expiries for a monthly one.
//  - strike { by: 'leg', ref, value }: another leg's strike ± points (e.g. a wing exactly 100 above the short call).
//  - leg.roll { dteDays, time }: that many trading days before the leg's own expiry, at that time, the leg is closed
//    and the same strike is opened in the next weekly expiry (e.g. a near-week hedge rolled into the main expiry).
//  - filters.minCredit / maxLossDown / maxLossUp (index points per lot): skip the trade unless the entry net credit
//    is high enough and the expiry payoff far below / above spot (intrinsic, all legs) loses no more than that.
//  - risk.unit = 'pct': overall stop / target / lock / partial amounts are % of capital (the capital in the settings,
//    else the trade's estimated margin). risk.partialAt: book partialPct % of every leg's lots once, then keep
//    partialFloor as a profit floor; the overall target no longer applies to the lots left running.
//  - risk.slPrem / tgtPrem: overall stop / target as % of the net premium at entry (the credit received or the debit
//    paid, in rupees). Used by the scenario scan (scenarios.js); when a rupee / % of capital rule is set too, the
//    nearer one applies.
//  - entry.noOverlap: one position at a time (a trade whose entry falls before the previous exit is skipped).
//
// Picked strikes (strategy.pick, lib/backspread.js): { kind: 'backfly', side, win, widths, form, rank }. At entry every
// back spread + 2 butterflies whose strikes all lie within ATM ± win strikes is priced at that minute's open, and the
// best by rank (smallest worst-case loss after slippage and brokerage, chance of profit, or peak ÷ loss) gives the
// strikes of the legs whose strike is { by: 'pick', role } (m, lo, hi, k1, k2). Only candidates whose every option
// really traded in the pick.fresh minutes up to entry (default 15) count. None: no trade.
//
// Adjustments on market movement (strategy.adjust), checked on every candle close like the overall MTM rules:
//  - on 'move': Nifty has moved `value` points (unit 'pts') or % (unit 'pct') from the position's centre (spot at entry,
//    then at the last adjustment); the side Nifty moved towards is the tested one (up = calls).
//  - on 'near': Nifty is within `value` points / % of a short strike (0 = touching it); that strike's side is tested.
//  - on 'prem': a short leg's price is `value` times its entry price (2 = doubled); that leg's side is tested.
//  action 'tested' re-strikes the tested side's legs (shorts and their wings), 'untested' the other side (rolled in
//  closer), 'both' every leg (re-centred). The legs are closed at the next minute's open and the same legs opened at the
//  strikes their own rules pick at that moment (a wing "from leg" follows its short), in the same expiry. Legs whose
//  strike would not change are left alone; if any new leg has no price the adjustment is skipped as a whole, so a short is
//  never left without its wing. At most `max` adjustments a trade, none in the last 30 minutes before the exit.
const { MPD, addDays } = require('./data');
const Costs = require('../lib/costs');
const { normCondition, evaluate } = require('./conditions');
const A = require('./anomalies');
const { nearest: nearestLevels } = require('./levels');
const BS = require('../lib/backspread');

const { RATE, ncdf, bsm } = require('../lib/pricing'); // RATE: risk-free rate for implied vol / delta
const MIN_OF = (t) => {
  const [h, m] = String(t || '09:15')
    .split(':')
    .map(Number);
  return h * 60 + m - (9 * 60 + 15);
};
const clampMin = (m) => Math.max(0, Math.min(MPD - 1, m));
const hhmm = (m) => {
  const t = m + 555;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const weekday = (day) => new Date(day + 'T00:00:00Z').getUTCDay();
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- Black-Scholes (lib/pricing.js) at the fixed rate, no dividend ----------
const bs = (S, K, T, v, call) => bsm(S, K, T, v, call, RATE, 0);
function impliedVol(price, S, K, T, call) {
  let lo = 0.005;
  let hi = 3;
  if (price <= Math.max(0, call ? S - K * Math.exp(-RATE * T) : K * Math.exp(-RATE * T) - S) + 1e-6) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bs(S, K, T, mid, call) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
function delta(S, K, T, v, call) {
  if (T <= 0) return call ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + (RATE + (v * v) / 2) * T) / (v * Math.sqrt(T));
  return call ? ncdf(d1) : ncdf(d1) - 1;
}
const yearsTo = (expiry, day, m) => Math.max(1e-6, (Date.parse(expiry + 'T15:30:00+05:30') - Date.parse(`${day}T${hhmm(m)}:00+05:30`)) / (365 * 86400_000));

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

function normalizeOpts(o, cal) {
  const last = cal.expired[cal.expired.length - 1];
  const first = cal.expired[0];
  let from = /^\d{4}-\d{2}-\d{2}$/.test(o?.from) ? o.from : addDays(last, -180);
  let to = /^\d{4}-\d{2}-\d{2}$/.test(o?.to) ? o.to : last;
  if (to > last) to = last;
  if (from < addDays(first, -40)) from = addDays(first, -40);
  return {
    from,
    to,
    expiries: Array.isArray(o?.expiries) && o.expiries.length ? new Set(o.expiries) : null,
    slippage: Math.max(0, Math.min(5, Number(o?.slippage) || 0)) / 100,
    // least slippage per fill in ₹ (one tick = 0.05): a % of a ₹2 option is far less than any real spread
    minSlip: Math.max(0, Math.min(5, Number(o?.minSlip) || 0)),
    brokerage: Math.max(0, Number(o?.brokerage ?? 20) || 0),
    taxes: o?.taxes !== false,
    lotMode: o?.lotMode === 'historical' ? 'historical' : 'fixed',
    lotSize: Math.max(1, Number(o?.lotSize) || cal.liveLot || 65),
    capital: Number(o?.capital) > 0 ? Number(o.capital) : null,
  };
}

// ---------- run ----------
// ext: { hist (histchain, for anomaly conditions), levels (levels.createLevels()) } — shared caches; stopped() (optional):
// true once the caller wants the run abandoned — it then ends with an error whose `cancelled` is set.
async function runBacktest(data, rawStrat, rawOpts, onProgress = () => {}, ext = {}) {
  const strat = normalizeStrategy(rawStrat);
  if (!strat.legs.length) throw new Error('Add at least one leg');
  const cal = await data.expiryCalendar();
  if (!cal.expired.length) throw new Error('Upstox returned no expired Nifty expiries');
  const opts = normalizeOpts(rawOpts, cal);
  onProgress({ phase: 'Loading Nifty history', done: 0, total: 0 });

  const sigMode = strat.entry.when === 'signal';
  const conds = sigMode ? strat.entry.conditions : [];
  if (sigMode && !conds.length) throw new Error('Signal entry needs at least one condition');
  const needChain = conds.some((c) => c.kind === 'anomaly');
  const usesLevels =
    conds.some((c) => c.kind === 'sr-near' || c.kind === 'sr-break') ||
    strat.legs.some((l) => l.strike.by === 'sr' || l.sl.type === 'srb' || l.tgt.type === 'srb');
  if (needChain && !ext.hist) throw new Error('Anomaly conditions are not available here');
  if (usesLevels && !ext.levels) throw new Error('Support/resistance is not available here');

  const needVix = Boolean(strat.filters.vixMin || strat.filters.vixMax);
  const lastDay = cal.expired[cal.expired.length - 1];
  // Support/resistance looks back ~120 sessions before the first trade. India VIX is recorded on every trade (the
  // Breakdown tab's market regime); only a VIX filter needs it, without one a month that can't be had is left out.
  const days = await data.loadIndex(addDays(opts.from, usesLevels ? -200 : -70), lastDay, needVix || 'soft');
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  if (ext.hist) ext.hist.setDays(days);
  const levelsOf = (day) => (usesLevels && dayIdx.has(day) ? ext.levels.forDay(days, dayIdx.get(day), data.spotDay) : null);

  const allMonthly = cal.all.filter((e) => cal.monthly.has(e));
  const nthOnOrAfter = (list, day, n) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < day) lo = mid + 1;
      else hi = mid;
    }
    return list[lo + n] || null;
  };
  const legExpiry = (code, day) =>
    code === 'cur'
      ? nthOnOrAfter(cal.all, day, 0)
      : code === 'next'
        ? nthOnOrAfter(cal.all, day, 1)
        : code === 'mcur'
          ? nthOnOrAfter(allMonthly, day, 0)
          : nthOnOrAfter(allMonthly, day, 1);
  const refList = strat.expiry === 'monthly' ? allMonthly : cal.all;

  // ---- which trades to take ----
  const positions = [];
  const em = clampMin(MIN_OF(strat.entry.time));
  let xm = clampMin(MIN_OF(strat.exit.time));
  const sameDay = strat.mode === 'intraday' || strat.entry.dteDays === strat.exit.dteDays;
  const um = sameDay ? Math.min(xm - 1, clampMin(MIN_OF(strat.entry.until))) : clampMin(MIN_OF(strat.entry.until));
  if (sigMode && um < em) throw new Error('"Until" time must be after the entry time');
  if (strat.mode === 'intraday') {
    if (xm <= em) throw new Error('Exit time must be after entry time');
    for (const d of days) {
      if (d < opts.from || d > opts.to) continue;
      const ref = nthOnOrAfter(refList, d, 0);
      if (!ref || !dayIdx.has(ref)) continue;
      if (opts.expiries && !opts.expiries.has(ref)) continue;
      if (!strat.entry.days.includes(weekday(d))) continue;
      const dte = dayIdx.get(ref) - dayIdx.get(d);
      if (strat.entry.dte.length && !strat.entry.dte.includes(dte)) continue;
      positions.push({ entryDay: d, exitDay: d, ref, dte });
    }
  } else {
    const after = strat.entry.after;
    if (!after && strat.exit.dteDays > strat.entry.dteDays) throw new Error('Exit must be on or after the entry day');
    if (!after && strat.exit.dteDays === strat.entry.dteDays && xm <= em) throw new Error('Exit time must be after entry time');
    for (const ref of refList) {
      if (!cal.expiredSet.has(ref) || !dayIdx.has(ref)) continue;
      if (opts.expiries && !opts.expiries.has(ref)) continue;
      const i = dayIdx.get(ref);
      let entryDay;
      if (after) {
        // the trading day after the expiry `after` series earlier: the start of a new series (weekly series for a
        // weekly cycle, monthly series for a monthly one: after = 1 enters the day after the previous monthly expiry)
        const prev = refList[refList.indexOf(ref) - after];
        if (!prev || !dayIdx.has(prev)) continue;
        entryDay = days[dayIdx.get(prev) + 1];
      } else entryDay = days[i - strat.entry.dteDays];
      const exitDay = days[i - strat.exit.dteDays];
      if (!entryDay || !exitDay || entryDay < opts.from || ref > opts.to) continue;
      if (entryDay > exitDay || (entryDay === exitDay && xm <= em)) continue;
      positions.push({ entryDay, exitDay, ref, dte: i - dayIdx.get(entryDay) });
    }
  }

  const lotOf = async (expiry) => (opts.lotMode === 'fixed' ? opts.lotSize : (await data.contracts(expiry)).lot);

  // Price (₹) of a contract at the open of minute m on a day, or null if it had not traded.
  async function priceAt(expiry, strike, type, day, m) {
    const c = data.optionCached(expiry, strike, type, day) || (await data.option(expiry, strike, type, day));
    const a = data.optionDay(c, day);
    const v = a ? a[m * 4] : -1;
    return v > 0 ? v / 100 : null;
  }

  // ---- strike selection ----
  // sx: { hit (anomaly that triggered the entry), lv (support/resistance levels of the day) }
  async function selectStrike(spec, type, expiry, day, m, spot, sx = {}) {
    const info = await data.contracts(expiry);
    const ks = info.strikes;
    const nearest = (x) => {
      let b = 0;
      for (let i = 1; i < ks.length; i++) if (Math.abs(ks[i] - x) < Math.abs(ks[b] - x)) b = i;
      return b;
    };
    const ai = nearest(spot);
    const otm = type === 'CE' ? 1 : -1;
    const at = (i) => ks[Math.max(0, Math.min(ks.length - 1, i))];
    switch (spec.by) {
      case 'atm':
        return at(ai + otm * Math.round(spec.value));
      // n strikes above (+) / below (−) the anomaly's strike; ATM when the entry had no anomaly.
      case 'signal': {
        const base = spec.ref === 'ref' && sx.hit?.ref != null ? sx.hit.ref : sx.hit?.strike;
        return base == null ? ks[ai] : at(nearest(base) + Math.round(spec.value));
      }
      // The strike at the nearest resistance above (calls) or support below (puts), n strikes further OTM.
      case 'sr': {
        const n = nearestLevels(sx.lv, spot);
        const lvl = (type === 'CE' ? n.resistance : n.support)[spec.lv || 'any'];
        return lvl ? at(nearest(lvl.price) + otm * Math.round(spec.value)) : at(ai + otm * Math.round(spec.value));
      }
      // Another leg's strike ± points (snapped to this leg's expiry's strikes); ATM if that leg is missing.
      case 'leg': {
        const base = sx.legStrikes?.[spec.ref];
        return base == null ? ks[ai] : ks[nearest(base + spec.value)];
      }
      // The strike the back spread picker chose for this role at entry (strategy.pick).
      case 'pick':
        return sx.pick?.[spec.role] ?? null;
      case 'pct':
        return ks[nearest(spot * (1 + (otm * spec.value) / 100))];
      case 'pts':
        return ks[nearest(spot + otm * spec.value)];
      case 'straddle': {
        const [c, p] = await Promise.all([priceAt(expiry, ks[ai], 'CE', day, m), priceAt(expiry, ks[ai], 'PE', day, m)]);
        if (c == null || p == null) return ks[ai];
        return ks[nearest(ks[ai] + otm * (c + p) * (spec.value || 1))];
      }
      default: {
        // premium / delta: both fall steadily going OTM, so binary-search the crossing point
        const T = yearsTo(expiry, day, m);
        const target = spec.by === 'delta' ? Math.abs(spec.value > 1 ? spec.value / 100 : spec.value) : spec.value;
        const order = [];
        for (let i = ai - otm * 6; i >= 0 && i < ks.length && order.length < 90; i += otm) order.push(i);
        const memo = new Map();
        const val = async (j) => {
          if (memo.has(j)) return memo.get(j);
          const i = order[j];
          const p = await priceAt(expiry, ks[i], type, day, m).catch(() => null);
          // Untraded: deep OTM counts as worthless, deep ITM as above any target.
          let v = p == null ? ((i - ai) * otm > 0 ? 0 : Infinity) : p;
          if (p != null && spec.by === 'delta') v = Math.abs(delta(spot, ks[i], T, impliedVol(p, spot, ks[i], T, type === 'CE'), type === 'CE'));
          memo.set(j, v);
          return v;
        };
        // Find the last position whose value is still >= target. Each probe is a download on a cold cache,
        // so start where Black-Scholes (at the ATM option's implied vol) predicts the crossing, then walk
        // a strike at a time — usually 3-5 probes in total.
        if (!order.length) return ks[ai];
        const call = type === 'CE';
        const jAtm = order.indexOf(ai);
        const pAtm = jAtm >= 0 ? await priceAt(expiry, ks[ai], type, day, m).catch(() => null) : null;
        let j = 0;
        if (pAtm != null) {
          const iv = impliedVol(pAtm, spot, ks[ai], T, call);
          const est = (k) => (spec.by === 'delta' ? Math.abs(delta(spot, k, T, iv, call)) : bs(spot, k, T, iv, call));
          j = jAtm;
          while (j + 1 < order.length && est(ks[order[j + 1]]) >= target) j++;
          memo.set(jAtm, spec.by === 'delta' ? Math.abs(delta(spot, ks[ai], T, iv, call)) : pAtm);
        }
        let lo;
        let hi;
        if ((await val(j)) >= target) {
          lo = j;
          while (lo + 1 < order.length && (await val(lo + 1)) >= target) lo++;
          if (lo + 1 >= order.length) return ks[order[lo]];
          hi = lo + 1;
        } else {
          hi = j;
          while (hi > 0 && (await val(hi - 1)) < target) hi--;
          if (hi === 0) return ks[order[0]];
          lo = hi - 1;
        }
        const a = await val(lo);
        const b = await val(hi);
        if (spec.match === 'gte') return ks[order[lo]];
        if (spec.match === 'lte') return ks[order[a === target ? lo : hi]];
        return ks[order[Math.abs(a - target) <= Math.abs(b - target) ? lo : hi]];
      }
    }
  }

  // The back spread + 2 butterflies (lib/backspread.js) whose strikes all lie within ATM ± win and that ranks best,
  // priced at the open of minute m, costs per unit (slippage on every fill in and out, brokerage per order) included.
  async function pickStrikes(P, expiry, day, m, spot) {
    if (!expiry || !cal.expiredSet.has(expiry)) return null;
    const info = await data.contracts(expiry);
    const ks = info.strikes;
    let ai = 0;
    for (let i = 1; i < ks.length; i++) if (Math.abs(ks[i] - spot) < Math.abs(ks[ai] - spot)) ai = i;
    const T = yearsTo(expiry, day, m);
    const memo = new Map();
    const px = async (k, t) => {
      const key = k + t;
      if (!memo.has(key)) {
        const p = await priceAt(expiry, k, t, day, m).catch(() => null);
        memo.set(key, p == null ? null : Math.max(p, t === 'CE' ? spot - k : k * Math.exp(-RATE * T) - spot));
      }
      return memo.get(key);
    };
    // tradable: the option traded (a real candle, not one carried forward) in the last P.fresh minutes up to entry
    const fresh = new Map();
    const traded = async (k, t) => {
      const key = k + t;
      if (!fresh.has(key)) {
        let ok = false;
        try {
          const c = data.optionCached(expiry, k, t, day) || (await data.option(expiry, k, t, day));
          const raw = data.optionRaw(c, day);
          for (let i = Math.max(0, m - P.fresh); raw && i <= m && !ok; i++) ok = raw[i * 4] > 0;
        } catch {
          /* not downloadable: not tradable */
        }
        fresh.set(key, ok);
      }
      return fresh.get(key);
    };
    const atmPx = await px(ks[ai], P.side);
    const iv = atmPx ? impliedVol(atmPx, spot, ks[ai], T, P.side === 'CE') : null;
    const lot = await lotOf(expiry);
    let best = null;
    for (const g of BS.geometries(ks, ai, P.side, P.win, P.widths)) {
      const L = BS.legsOf(g, P.side, P.form);
      for (const l of L) l.px = await px(l.k, l.type);
      if (L.some((l) => !(l.px > 0))) continue;
      if (P.fresh) {
        let ok = true;
        for (const l of L) if (ok) ok = await traded(l.k, l.type);
        if (!ok) continue;
      }
      const cost = 2 * L.reduce((s, l) => s + l.n * slip(l.px), 0) + (2 * L.length * opts.brokerage) / lot;
      const e = BS.evaluate(L, { spot, iv, T, cost });
      if (!best || BS.better(P.rank)(e, best.e) < 0) best = { g, e };
    }
    return best ? { ...best.g } : null;
  }

  const slip = (px) => Math.max(px * opts.slippage, opts.minSlip);
  const fill = (px, buy) => (buy ? px + slip(px) : Math.max(0, px - slip(px)));
  // Brokerage and charges of one leg's round trip, at the rates in force on the day of each side (lib/costs.js: STT
  // changes with the budgets). A leg settled at expiry places no closing order: a bought option that expires in the
  // money pays STT on its settlement value instead, and an option that expires worthless pays nothing more.
  function execCost(x) {
    const settled = x.reason === 'expiry';
    const buy = { turn: (x.dir > 0 ? x.entryFill : x.exitFill) * x.qty, day: x.dir > 0 ? x.entryDay : x.exitDay, order: x.dir > 0 || !settled };
    const sell = { turn: (x.dir > 0 ? x.exitFill : x.entryFill) * x.qty, day: x.dir > 0 ? x.exitDay : x.entryDay, order: x.dir < 0 || !settled };
    let cost = 0;
    for (const [side, s] of [
      ['buy', buy],
      ['sell', sell],
    ]) {
      if (!s.order) continue;
      if (!opts.taxes) cost += opts.brokerage;
      else cost += Costs.orders({ [side]: s.turn, orders: 1, day: s.day, brokerage: opts.brokerage });
    }
    if (opts.taxes && settled && x.dir > 0) cost += Costs.exercise(x.exitPx * x.qty, x.exitDay);
    return cost;
  }

  // ---- one trade ----
  // pos: { entryDay, exitDay, ref, dte, em? (entry minute; signal entries), hit?, sigText? }
  async function simulate(pos) {
    const tl = days.slice(dayIdx.get(pos.entryDay), dayIdx.get(pos.exitDay) + 1);
    const sp0 = data.spotDay(pos.entryDay);
    if (!sp0) return { skip: 'no Nifty data' };
    const e0 = pos.em ?? em;
    if (tl.length === 1 && e0 >= xm) return { skip: 'signal too late to trade', silent: true };
    const sx = { hit: pos.hit || null, lv: levelsOf(pos.entryDay) };
    const spotIn = sp0[e0 * 4];
    const vixD = data.vixDay(pos.entryDay);
    const vix = vixD ? vixD[e0 * 4] : null;
    if (needVix) {
      if (vix == null) return { skip: 'no VIX data' };
      if (strat.filters.vixMin && vix < strat.filters.vixMin) return { skip: 'VIX filter', silent: true };
      if (strat.filters.vixMax && vix > strat.filters.vixMax) return { skip: 'VIX filter', silent: true };
    }

    const openLeg = async (def, li, t, m, strike, spot, reCount, origPx, expOverride) => {
      const day = tl[t];
      const expiry = expOverride || legExpiry(def.expiry, tl[0]);
      if (!expiry || !cal.expiredSet.has(expiry)) throw new Skip(`expiry ${expiry || '?'} has no data yet`);
      if (strike == null) strike = await selectStrike(def.strike, def.type, expiry, day, m, spot, sx);
      if (strike == null) throw new Skip(`no ${def.type} strike for leg ${li + 1}`);
      const c = await data.option(expiry, strike, def.type, tl[0]);
      const a = data.optionDay(c, day);
      const px =
        a && a[m * 4] > 0 ? Math.max(a[m * 4] / 100, def.type === 'CE' ? spot - strike : strike * Math.exp(-RATE * yearsTo(expiry, day, m)) - spot) : null; // not below its no-arbitrage bound (stale price)
      if (px == null) throw new Skip(`${strike} ${def.type} ${expiry} not traded at entry`);
      const dir = def.action === 'B' ? 1 : -1;
      const lot = await lotOf(expiry);
      const leg = {
        def,
        li,
        expiry,
        strike,
        type: def.type,
        dir,
        c,
        lot,
        qty: def.lots * lot,
        entryPx: px,
        entryFill: fill(px, dir > 0),
        entryT: t,
        entryM: m,
        spotIn: spot,
        best: px,
        reCount,
        origPx: origPx ?? px,
        open: true,
        arrDay: null,
        arr: null,
        lastDay: expiry < tl[tl.length - 1] ? expiry : null, // settled at expiry if it comes before the exit
      };
      setLevels(leg);
      if (def.roll && dayIdx.has(expiry)) {
        // scheduled roll: trading days before this leg's own expiry
        const rd = days[dayIdx.get(expiry) - def.roll.dteDays];
        if (rd && rd >= day) leg.rollAt = { day: rd, m: clampMin(MIN_OF(def.roll.time)) };
      }
      return leg;
    };

    function setLevels(leg) {
      const { sl, tgt } = leg.def;
      const e = leg.entryPx;
      const s = leg.dir;
      leg.slPx = sl.type === 'pct' ? e * (1 - (s * sl.value) / 100) : sl.type === 'pts' ? e - s * sl.value : null;
      if (leg.slPx != null && leg.slPx < 0) leg.slPx = null;
      leg.tgtPx = tgt.type === 'pct' ? e * (1 + (s * tgt.value) / 100) : tgt.type === 'pts' ? e + s * tgt.value : null;
      if (leg.tgtPx != null && leg.tgtPx <= 0) leg.tgtPx = 0.05;
      leg.slInit = leg.slPx;
      // Underlying-based levels, in Nifty points; adv = which way of Nifty hurts this leg.
      leg.adv = (leg.type === 'CE' ? 1 : -1) * (leg.dir < 0 ? 1 : -1);
      leg.uSl = sl.type === 'upts' ? sl.value : sl.type === 'upct' ? (leg.spotIn * sl.value) / 100 : null;
      leg.uTgt = tgt.type === 'upts' ? tgt.value : tgt.type === 'upct' ? (leg.spotIn * tgt.value) / 100 : null;
      // Support/resistance: stop when Nifty closes through the level on the adverse side (+ buffer),
      // target when it reaches the level on the favourable side (− buffer).
      leg.srSl = null;
      leg.srTgt = null;
      if ((sl.type === 'srb' || tgt.type === 'srb') && sx.lv) {
        const n = nearestLevels(sx.lv, leg.spotIn);
        if (sl.type === 'srb') {
          const l = (leg.adv > 0 ? n.resistance : n.support)[sl.lv];
          if (l) leg.srSl = l.price + leg.adv * sl.value;
        }
        if (tgt.type === 'srb') {
          const l = (leg.adv > 0 ? n.support : n.resistance)[tgt.lv];
          if (l) leg.srTgt = l.price + leg.adv * tgt.value;
        }
      }
    }

    // An option is never worth less than its intrinsic value. A deep in-the-money contract that has stopped
    // trading still shows its last, stale price (candles are carried forward), which would book a loss on a short
    // or a profit on a long that nobody could trade: marks, exits, rolls and settlements are floored at the
    // no-arbitrage bound (calls: spot − strike; puts: discounted strike − spot, as index puts are priced off the
    // future and can trade a little under spot intrinsic).
    const real = (leg, px, spot, day, m) =>
      Math.max(px, leg.type === 'CE' ? spot - leg.strike : leg.strike * Math.exp(-RATE * yearsTo(leg.expiry, day, m)) - spot);

    const arrOf = (leg, day) => {
      if (leg.arrDay !== day) {
        leg.arr = data.optionDay(leg.c, day);
        leg.arrDay = day;
      }
      return leg.arr;
    };

    let legs;
    try {
      if (strat.pick) {
        sx.pick = await pickStrikes(strat.pick, legExpiry(strat.legs[0].expiry, tl[0]), tl[0], e0, spotIn); // the legs' own expiry
        if (!sx.pick) throw new Skip(`no back spread fully priced within ATM ± ${strat.pick.win}`);
      }
      const out = new Array(strat.legs.length);
      sx.legStrikes = [];
      await Promise.all(
        strat.legs.map(async (def, li) => {
          if (def.strike.by === 'leg') return;
          out[li] = await openLeg(def, li, 0, e0, null, spotIn, 0);
          sx.legStrikes[li] = out[li].strike;
        }),
      );
      for (const [li, def] of strat.legs.entries()) {
        if (def.strike.by !== 'leg') continue;
        out[li] = await openLeg(def, li, 0, e0, null, spotIn, 0);
        sx.legStrikes[li] = out[li].strike;
      }
      legs = out;
    } catch (e) {
      if (e instanceof Skip) return { skip: e.message };
      throw e;
    }
    const entryLegs = legs.map((l) => ({ dir: l.dir, type: l.type, strike: l.strike, qty: l.qty, px: l.entryPx }));

    // Entry checks, in index points per lot (of the smallest leg): net credit, and the expiry payoff far below /
    // above spot with every leg at intrinsic value (a near-week hedge counts as if it were still held).
    const F = strat.filters;
    let creditPts = null;
    if (F.minCredit != null || F.maxLossDown != null || F.maxLossUp != null) {
      const unit = Math.min(...legs.map((l) => l.qty));
      const at = (S) => entryLegs.reduce((v, l) => v + l.dir * l.qty * (Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S) - l.px), 0) / unit;
      creditPts = -entryLegs.reduce((v, l) => v + l.dir * l.qty * l.px, 0) / unit;
      if (F.minCredit != null && creditPts < F.minCredit) return { skip: `net credit ${creditPts.toFixed(1)} < ${F.minCredit} pts` };
      const down = at(spotIn * 0.5);
      const up = at(spotIn * 1.5);
      if (F.maxLossDown != null && down < -F.maxLossDown)
        return { skip: `downside not covered: ${down.toFixed(1)} pts below the puts (limit −${F.maxLossDown})` };
      if (F.maxLossUp != null && up < -F.maxLossUp) return { skip: `upside not covered: ${up.toFixed(1)} pts above the calls (limit −${F.maxLossUp})` };
    }

    // Overall rules in rupees: % of capital (settings, else this trade's estimated margin) when risk.unit = 'pct'.
    const base = opts.capital || estimateMargin(entryLegs, spotIn);
    const rs = (v) => (v == null ? null : strat.risk.unit === 'pct' ? (v * base) / 100 : v);
    // ... or % of the net premium at entry (credit received or debit paid).
    const premNet = entryLegs.reduce((v, l) => v + l.dir * l.qty * l.px, 0); // > 0 = debit
    const prem = (v) => (v == null || !(Math.abs(premNet) > 0) ? null : (v * Math.abs(premNet)) / 100);
    const nearer = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
    const R = {
      sl: nearer(rs(strat.risk.sl), prem(strat.risk.slPrem)),
      tgt: nearer(rs(strat.risk.tgt), prem(strat.risk.tgtPrem)),
      lockAt: rs(strat.risk.lockAt),
      lockTo: rs(strat.risk.lockTo) || 0,
      trailEvery: rs(strat.risk.trailEvery),
      trailBy: rs(strat.risk.trailBy),
      partialAt: rs(strat.risk.partialAt),
      partialFloor: rs(strat.risk.partialFloor),
      partialPct: strat.risk.partialPct,
    };
    let partialDone = false;
    const notes = [];
    const ADJ = strat.adjust;
    let center = spotIn; // Nifty at entry, then at the last adjustment
    let adjCount = 0; // adjustments decided (the limit counts these)
    let adjDone = 0; // ... and made
    let adjQ = null; // an adjustment decided on a candle close, made at the next minute's open: { t, m, types, why }

    const execs = [];
    let realized = 0;
    let costs = 0;
    const pending = [];
    const mtm = [];
    const spotPath = [];
    let maxP = -Infinity;
    let minP = Infinity;
    let reason = 'exit-time';
    let done = false;
    let lockFloor = null;
    let exitT = tl.length - 1;
    let exitM = xm;
    let spotOut = null;
    const exitAtClose = xm >= MPD - 1;

    const close = (leg, t, m, px, why, noRe) => {
      leg.open = false;
      const exitFill = fill(px, leg.dir < 0);
      const pnl = (exitFill - leg.entryFill) * leg.dir * leg.qty;
      const x = {
        leg: leg.li,
        action: leg.dir > 0 ? 'B' : 'S',
        type: leg.type,
        strike: leg.strike,
        expiry: leg.expiry,
        qty: leg.qty,
        entryDay: tl[leg.entryT],
        entryTime: hhmm(leg.entryM),
        entryPx: r2(leg.entryPx),
        entryFill: leg.entryFill,
        exitDay: tl[t],
        exitTime: hhmm(m),
        exitPx: r2(px),
        exitFill,
        reason: why,
        re: leg.reCount,
        dir: leg.dir,
        ...(leg.rolled ? { rolled: 1 } : {}),
        ...(leg.adjusted ? { adj: 1 } : {}),
      };
      const cost = execCost(x);
      x.pnl = Math.round(pnl);
      x.cost = Math.round(cost);
      // the fills (price after slippage) stay on the execution: a replay in the Builder trades at them
      x.entryFill = Math.round(x.entryFill * 1e4) / 1e4;
      x.exitFill = Math.round(x.exitFill * 1e4) / 1e4;
      delete x.dir;
      execs.push(x);
      realized += pnl;
      costs += cost;
      // Re-entry
      const re = leg.def.re;
      const cnt = leg.reCount;
      if (!noRe && re && cnt < re.max && (re.on === 'both' || re.on === why) && !done) {
        pending.push({
          def: leg.def,
          li: leg.li,
          mode: re.mode,
          strike: re.mode === 'atm' ? null : leg.strike,
          t,
          m: m + 1,
          reCount: cnt + 1,
          origPx: leg.origPx,
          dir: leg.dir,
          c: leg.c,
          why,
        });
      }
    };

    // The adjustment decided on the previous close: the legs of q.types are given the strikes their rules pick now.
    async function adjustNow(t, m, q) {
      const day = tl[t];
      const spot = data.spotDay(day)[m * 4];
      const old = legs.filter((l) => l.open && q.types.has(l.type));
      if (!old.length) {
        center = spot;
        return;
      }
      const cur = sx.legStrikes; // what "from leg" wings are measured from: the legs' current strikes
      for (const l of legs) if (l.open) cur[l.li] = l.strike;
      const saved = cur.slice();
      const fresh = [];
      try {
        for (const l of [...old.filter((x) => x.def.strike.by !== 'leg'), ...old.filter((x) => x.def.strike.by === 'leg')]) {
          const strike = await selectStrike(l.def.strike, l.type, l.expiry, day, m, spot, sx);
          cur[l.li] = strike;
          if (strike === l.strike) continue;
          const nl = await openLeg(l.def, l.li, t, m, strike, spot, l.reCount, null, l.expiry);
          nl.qty = l.qty; // keeps any partial booking
          nl.adjusted = true;
          fresh.push([l, nl]);
        }
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        saved.forEach((k, i) => (cur[i] = k));
        notes.push(`${hhmm(m)} ${day}: ${q.why}: adjustment skipped (${e.message})`);
        center = spot;
        return;
      }
      for (const [l, nl] of fresh) {
        const a = arrOf(l, day);
        close(l, t, m, a && a[m * 4] > 0 ? real(l, a[m * 4] / 100, spot, day, m) : l.entryPx, 'adjust', true);
        legs.push(nl);
      }
      center = spot;
      if (fresh.length) adjDone++;
      if (fresh.length)
        notes.push(`${hhmm(m)} ${day}: ${q.why}: ${fresh.map(([l, nl]) => `${l.dir > 0 ? 'B' : 'S'} ${l.type} ${l.strike}→${nl.strike}`).join(', ')}`);
    }

    const closeAll = (t, m, useOpen, why) => {
      for (const leg of legs) {
        if (!leg.open) continue;
        const a = arrOf(leg, tl[t]);
        const px = a ? real(leg, a[m * 4 + (useOpen ? 0 : 3)] / 100, data.spotDay(tl[t])[m * 4 + (useOpen ? 0 : 3)], tl[t], m) : leg.entryPx;
        close(leg, t, m, px, why);
      }
      pending.length = 0;
      done = true;
      reason = why;
      exitT = t;
      exitM = m;
    };

    outer: for (let t = 0; t < tl.length; t++) {
      const day = tl[t];
      const sp = data.spotDay(day);
      const m0 = t === 0 ? e0 : 0;
      const m1 = t === tl.length - 1 ? xm : MPD - 1;
      for (let m = m0; m <= m1; m++) {
        const isLast = t === tl.length - 1 && m === xm;
        if (isLast && !exitAtClose) {
          closeAll(t, m, true, 'exit-time');
          spotOut = sp[m * 4];
          break outer;
        }
        // Pending re-entries
        for (let p = pending.length - 1; p >= 0; p--) {
          const q = pending[p];
          if (t < q.t || (t === q.t && m < q.m)) continue;
          let px = null;
          if (q.mode === 'cost') {
            const a = data.optionDay(q.c, day);
            if (!a || a[m * 4] <= 0) continue;
            const lo = a[m * 4 + 2] / 100;
            const hi = a[m * 4 + 1] / 100;
            if (q.origPx < lo || q.origPx > hi) continue;
            px = q.origPx;
          }
          pending.splice(p, 1);
          try {
            const leg = await openLeg(q.def, q.li, t, m, q.strike, sp[m * 4], q.reCount, q.origPx);
            if (px != null) {
              leg.entryPx = px;
              leg.entryFill = fill(px, leg.dir > 0);
              setLevels(leg);
            }
            legs.push(leg);
          } catch (e) {
            if (!(e instanceof Skip)) throw e;
          }
        }

        // Adjustment decided on the last close
        if (adjQ && (t > adjQ.t || (t === adjQ.t && m >= adjQ.m))) {
          const q = adjQ;
          adjQ = null;
          await adjustNow(t, m, q);
        }

        // Scheduled rolls: close the leg at this minute's open, open the same strike in the next weekly expiry.
        // (">=": a hedge opened by an adjustment after the roll time of its roll day is rolled straight away.)
        for (const leg of legs.slice()) {
          if (!leg.open || !leg.rollAt || leg.rollAt.day !== day || m < leg.rollAt.m) continue;
          leg.rollAt = null;
          const to = nthOnOrAfter(cal.all, addDays(leg.expiry, 1), 0);
          const a = arrOf(leg, day);
          const px = a && a[m * 4] > 0 ? real(leg, a[m * 4] / 100, sp[m * 4], day, m) : null;
          if (px == null || !to || !cal.expiredSet.has(to)) {
            notes.push(`${hhmm(m)} ${day}: roll of ${leg.strike} ${leg.type} skipped (${px == null ? 'no price' : 'no later expiry with data'})`);
            continue;
          }
          let nl;
          try {
            nl = await openLeg({ ...leg.def, roll: null }, leg.li, t, m, leg.strike, sp[m * 4], leg.reCount, null, to);
          } catch (e) {
            notes.push(`${hhmm(m)} ${day}: roll of ${leg.strike} ${leg.type} into ${to} failed (${e.message})`);
            continue;
          }
          close(leg, t, m, px, 'roll', true);
          nl.qty = leg.qty; // keeps any partial booking
          nl.rolled = true;
          legs.push(nl);
        }

        // Leg stop-loss / target / trailing
        const shi = sp[m * 4 + 1];
        const slo = sp[m * 4 + 2];
        let legSlHit = false;
        for (const leg of legs) {
          if (!leg.open) continue;
          const a = arrOf(leg, day);
          if (!a) continue;
          const i = m * 4;
          const o = a[i] / 100;
          const h = a[i + 1] / 100;
          const l = a[i + 2] / 100;
          const c = a[i + 3] / 100;
          let hit = null;
          let px = 0;
          if (leg.dir < 0) {
            if (leg.slPx != null && h >= leg.slPx) {
              hit = 'sl';
              px = o > leg.slPx ? o : leg.slPx;
            } else if (leg.tgtPx != null && l <= leg.tgtPx) {
              hit = 'tgt';
              px = o < leg.tgtPx ? o : leg.tgtPx;
            }
          } else {
            if (leg.slPx != null && l <= leg.slPx) {
              hit = 'sl';
              px = o < leg.slPx ? o : leg.slPx;
            } else if (leg.tgtPx != null && h >= leg.tgtPx) {
              hit = 'tgt';
              px = o > leg.tgtPx ? o : leg.tgtPx;
            }
          }
          if (!hit && (leg.uSl != null || leg.uTgt != null)) {
            const advMove = leg.adv > 0 ? shi - leg.spotIn : leg.spotIn - slo;
            const favMove = leg.adv > 0 ? leg.spotIn - slo : shi - leg.spotIn;
            if (leg.uSl != null && advMove >= leg.uSl) {
              hit = 'sl';
              px = c;
            } else if (leg.uTgt != null && favMove >= leg.uTgt) {
              hit = 'tgt';
              px = c;
            }
          }
          if (!hit && (leg.srSl != null || leg.srTgt != null)) {
            const sc = sp[m * 4 + 3];
            if (leg.srSl != null && (leg.adv > 0 ? sc >= leg.srSl : sc <= leg.srSl)) {
              hit = 'sl';
              px = c;
            } else if (leg.srTgt != null && (leg.adv > 0 ? sc <= leg.srTgt : sc >= leg.srTgt)) {
              hit = 'tgt';
              px = c;
            }
          }
          if (hit) {
            close(leg, t, m, px, hit);
            if (hit === 'sl') legSlHit = true;
            continue;
          }
          // Trail the stop after this candle.
          if (leg.def.trail && leg.slInit != null) {
            const { x, y } = leg.def.trail;
            const pct = leg.def.sl.type === 'pct';
            if (leg.dir < 0) {
              if (l < leg.best) leg.best = l;
              const fav = leg.entryPx - leg.best;
              const steps = Math.floor((pct ? (fav / leg.entryPx) * 100 : fav) / x);
              if (steps > 0) leg.slPx = Math.min(leg.slPx, leg.slInit - steps * (pct ? (y / 100) * leg.entryPx : y));
            } else {
              if (h > leg.best) leg.best = h;
              const fav = leg.best - leg.entryPx;
              const steps = Math.floor((pct ? (fav / leg.entryPx) * 100 : fav) / x);
              if (steps > 0) leg.slPx = Math.max(leg.slPx, leg.slInit + steps * (pct ? (y / 100) * leg.entryPx : y));
            }
          }
        }
        if (legSlHit) {
          if (strat.risk.onLegSl === 'all') {
            closeAll(t, m, false, 'leg-sl-all');
            spotOut = sp[m * 4 + 3];
            mtm.push(Math.round(realized));
            spotPath.push(spotOut);
            break outer;
          }
          if (strat.risk.slToCost)
            for (const leg of legs)
              if (leg.open) {
                leg.slPx = leg.entryPx;
                leg.slInit = null;
              }
        }

        // Expiry settlement of legs whose expiry comes before the position's exit.
        if (m === MPD - 1) {
          for (const leg of legs)
            if (leg.open && leg.lastDay === day) close(leg, t, m, real(leg, arrOf(leg, day)?.[m * 4 + 3] / 100 || 0.05, sp[m * 4 + 3], day, m), 'expiry');
        }

        // Mark to market on the close
        let open = 0;
        let nOpen = 0;
        for (const leg of legs) {
          if (!leg.open) continue;
          const a = arrOf(leg, day);
          const c = a ? real(leg, a[m * 4 + 3] / 100, sp[m * 4 + 3], day, m) : leg.entryPx;
          open += (c - leg.entryFill) * leg.dir * leg.qty;
          nOpen++;
        }
        const pnl = realized + open;
        mtm.push(Math.round(pnl));
        spotPath.push(sp[m * 4 + 3]);
        if (pnl > maxP) maxP = pnl;
        if (pnl < minP) minP = pnl;

        const r = R;
        if (isLast) {
          closeAll(t, m, false, 'exit-time');
          spotOut = sp[m * 4 + 3];
          break outer;
        }
        if (r.sl && pnl <= -r.sl) {
          closeAll(t, m, false, 'mtm-sl');
          spotOut = sp[m * 4 + 3];
          break outer;
        }
        if (r.tgt && !partialDone && pnl >= r.tgt) {
          closeAll(t, m, false, 'mtm-tgt');
          spotOut = sp[m * 4 + 3];
          break outer;
        }
        // Partial booking (once): close part of every open leg on this candle's close, then hold a profit floor.
        if (r.partialAt && !partialDone && pnl >= r.partialAt) {
          partialDone = true;
          let booked = 0;
          for (const leg of legs.slice()) {
            if (!leg.open) continue;
            const lots = Math.round(leg.qty / leg.lot);
            const n = Math.floor((lots * r.partialPct) / 100);
            if (n < 1 || n >= lots) continue;
            const a = arrOf(leg, day);
            const px = a ? real(leg, a[m * 4 + 3] / 100, sp[m * 4 + 3], day, m) : leg.entryPx;
            close({ ...leg, qty: n * leg.lot }, t, m, px, 'partial', true);
            leg.qty -= n * leg.lot;
            booked++;
          }
          if (!booked) notes.push(`${hhmm(m)} ${day}: partial booking needs at least 2 lots per leg`);
          if (r.partialFloor != null) lockFloor = lockFloor == null ? r.partialFloor : Math.max(lockFloor, r.partialFloor);
        }
        if (r.lockAt && pnl >= r.lockAt) {
          let floor = r.lockTo;
          if (r.trailEvery && r.trailBy) floor += Math.floor((pnl - r.lockAt) / r.trailEvery) * r.trailBy;
          lockFloor = lockFloor == null ? floor : Math.max(lockFloor, floor);
        }
        if (lockFloor != null && pnl <= lockFloor) {
          closeAll(t, m, false, 'lock-trail');
          spotOut = sp[m * 4 + 3];
          break outer;
        }
        // Market-move adjustment: decided on this close, made at the next minute's open.
        if (ADJ && !adjQ && adjCount < ADJ.max && nOpen && !(t === tl.length - 1 && m > xm - 30)) {
          const s = sp[m * 4 + 3];
          const lim = (v) => (ADJ.unit === 'pct' ? (s * v) / 100 : v);
          let tested = null;
          let why = '';
          if (ADJ.on === 'move') {
            const d = s - center;
            if (Math.abs(d) >= lim(ADJ.value)) {
              tested = d > 0 ? 'CE' : 'PE';
              why = `Nifty ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} pts`;
            }
          } else {
            for (const leg of legs) {
              if (!leg.open || leg.dir > 0) continue;
              if (ADJ.on === 'near') {
                const room = leg.type === 'CE' ? leg.strike - s : s - leg.strike;
                if (room <= lim(ADJ.value)) {
                  tested = leg.type;
                  why = `Nifty ${room <= 0 ? 'through' : room.toFixed(0) + ' pts from'} the short ${leg.strike} ${leg.type}`;
                }
              } else {
                const a = arrOf(leg, day);
                const c = a ? real(leg, a[m * 4 + 3] / 100, s, day, m) : leg.entryPx;
                if (c >= ADJ.value * leg.entryPx) {
                  tested = leg.type;
                  why = `short ${leg.strike} ${leg.type} at ${(c / leg.entryPx).toFixed(1)}× its entry`;
                }
              }
              if (tested) break;
            }
          }
          if (tested) {
            const other = tested === 'CE' ? 'PE' : 'CE';
            const types = new Set(ADJ.action === 'tested' ? [tested] : ADJ.action === 'untested' ? [other] : ['CE', 'PE']);
            // nothing to re-strike on that side (e.g. a call spread when Nifty falls): no adjustment
            if (legs.some((l) => l.open && types.has(l.type))) {
              adjQ = { t, m: m + 1, types, why };
              adjCount++;
            }
          }
        }
        if (!nOpen && !pending.length) {
          reason = 'legs-closed';
          done = true;
          exitT = t;
          exitM = m;
          spotOut = sp[m * 4 + 3];
          break outer;
        }
      }
    }
    if (!done) closeAll(tl.length - 1, xm, false, 'exit-time');

    const gross = execs.reduce((s, x) => s + x.pnl, 0);
    // Nifty's range while the position was open (minute closes), for its market regime (metrics.js trendOf)
    let spotHi = Math.max(spotIn, spotOut ?? spotIn);
    let spotLo = Math.min(spotIn, spotOut ?? spotIn);
    for (const v of spotPath) {
      if (v > spotHi) spotHi = v;
      if (v < spotLo) spotLo = v;
    }
    return {
      trade: {
        entryDay: pos.entryDay,
        exitDay: tl[exitT],
        entryTime: hhmm(e0),
        exitTime: hhmm(exitM),
        ref: pos.ref,
        dte: pos.dte,
        weekday: weekday(pos.entryDay),
        spotIn: r2(spotIn),
        spotOut: spotOut != null ? r2(spotOut) : null,
        spotHi: r2(spotHi),
        spotLo: r2(spotLo),
        sessions: exitT + 1,
        vix: vix != null ? r2(vix) : null,
        gross: Math.round(gross),
        costs: Math.round(costs),
        net: Math.round(gross - costs),
        maxProfit: Math.round(Math.max(0, maxP)),
        maxLoss: Math.round(Math.min(0, minP)),
        reason,
        legs: execs,
        margin: Math.round(estimateMargin(entryLegs, spotIn)),
        premium: Math.round(-premNet),
        ...(pos.sigText ? { signal: pos.sigText } : {}),
        ...(creditPts != null ? { credit: r2(creditPts) } : {}),
        ...(partialDone ? { partial: 1 } : {}),
        ...(adjDone ? { adjusted: adjDone } : {}),
        ...(notes.length ? { notes } : {}),
      },
      path: { days: tl.slice(0, exitT + 1), em: e0, mtm, spot: spotPath },
      exitT,
      exitM,
    };
  }

  // ---- signal entries: first minute in [from, to] of `day` where every condition holds ----
  async function findTrigger(day, from, to) {
    const sp = data.spotDay(day);
    if (!sp) return { skip: 'no Nifty data' };
    const di = dayIdx.get(day);
    const prevClose = di > 0 ? (data.spotDay(days[di - 1])?.[MPD * 4 - 1] ?? null) : null;
    const lv = levelsOf(day);
    let st = null;
    if (needChain) {
      const ei = cal.all.findIndex((e) => e >= day);
      const exp = cal.all[ei];
      if (!exp || !cal.expiredSet.has(exp)) return { skip: `expiry ${exp || '?'} has no data yet` };
      const nxt = cal.all[ei + 1];
      const withNext = conds.some((c) => A.BY_ID.get(c.type)?.needsNext) && nxt && cal.expiredSet.has(nxt) ? nxt : null;
      try {
        st = await ext.hist.load(exp, day, { withNext });
      } catch (e) {
        return { skip: e.message };
      }
      if (!st) return { skip: 'no option data' };
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let m = 0; m <= to; m++) {
      hi = Math.max(hi, sp[m * 4 + 1]);
      lo = Math.min(lo, sp[m * 4 + 2]);
      if (m < from) continue;
      const r = evaluate(conds, {
        spot: sp[m * 4 + 3],
        prevSpot: m > 0 ? sp[(m - 1) * 4 + 3] : prevClose,
        open: sp[0],
        prevClose,
        high: hi,
        low: lo,
        levels: lv,
        ctx: () => (st ? ext.hist.ctxAt(st, m) : null),
      });
      if (r.ok) return { m, hit: r.hit, text: r.notes.join(' · ') };
    }
    return {};
  }

  // ---- run all positions with a small worker pool ----
  const trades = [];
  const paths = [];
  const skipped = [];
  let done = 0;
  let next = 0;
  onProgress({ phase: 'Simulating', done, total: positions.length });
  let noSignal = 0;
  async function worker() {
    while (next < positions.length && !ext.stopped?.()) {
      const pos = positions[next++];
      if (!sigMode) {
        const r = await simulate(pos);
        if (r.skip) {
          if (!r.silent) skipped.push({ day: pos.entryDay, ref: pos.ref, reason: r.skip });
        } else {
          trades.push(r.trade);
          paths.push(r.path);
        }
      } else {
        // Scan the entry day for the conditions; after a trade closes the same day, keep scanning.
        let from = em;
        for (let n = 0; n < strat.entry.maxTrades; n++) {
          const trig = await findTrigger(pos.entryDay, from, um);
          if (trig.skip) {
            skipped.push({ day: pos.entryDay, ref: pos.ref, reason: trig.skip });
            break;
          }
          if (trig.m == null) {
            if (!n) noSignal++;
            break;
          }
          const r = await simulate({ ...pos, em: trig.m + 1, hit: trig.hit, sigText: `${hhmm(trig.m)} ${trig.text}` });
          if (r.skip) {
            if (!r.silent) skipped.push({ day: pos.entryDay, ref: pos.ref, reason: r.skip });
            break;
          }
          trades.push(r.trade);
          paths.push(r.path);
          if (strat.mode !== 'intraday' || r.exitT > 0) break;
          from = r.exitM + 1;
          if (from > um) break;
        }
      }
      done++;
      if (done % 4 === 0 || done === positions.length) onProgress({ phase: 'Simulating', done, total: positions.length, api: data.apiStats() });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (ext.stopped?.()) throw Object.assign(new Error('Stopped'), { cancelled: true });
  let order = trades.map((_, i) => i).sort((a, b) => (trades[a].entryDay + trades[a].entryTime).localeCompare(trades[b].entryDay + trades[b].entryTime));
  if (strat.entry.noOverlap) {
    // one position at a time: drop trades entered while the previous one was still open
    let last = '';
    order = order.filter((i) => {
      const t = trades[i];
      if (t.entryDay + t.entryTime < last) {
        skipped.push({ day: t.entryDay, ref: t.ref, reason: 'previous trade still open' });
        return false;
      }
      last = t.exitDay + t.exitTime;
      return true;
    });
  }
  return {
    strategy: strat,
    noSignal,
    opts: { ...opts, expiries: opts.expiries ? [...opts.expiries] : null },
    trades: order.map((i) => trades[i]),
    paths: order.map((i) => paths[i]),
    skipped,
    considered: positions.length,
  };
}

class Skip extends Error {}

// Rough margin for selling options (≈ SPAN + exposure): about 9% of notional per naked short lot,
// capped by the defined-risk loss when the short side is covered by long options of the same type.
// Straddles/strangles get partial offset (the larger side plus 30% of the smaller). Long premium is added.
function estimateMargin(legs, spot) {
  const side = (type) => {
    const ls = legs.filter((l) => l.type === type);
    const shortQty = ls.filter((l) => l.dir < 0).reduce((s, l) => s + l.qty, 0);
    if (!shortQty) return 0;
    let worst = 0;
    for (let k = 0.6; k <= 1.4001; k += 0.01) {
      const S = spot * k;
      const v = ls.reduce((s, l) => s + l.dir * l.qty * (Math.max(0, type === 'CE' ? S - l.strike : l.strike - S) - l.px), 0);
      if (v < worst) worst = v;
    }
    return Math.min(0.09 * spot * shortQty, -worst);
  };
  const ce = side('CE');
  const pe = side('PE');
  const debit = legs.filter((l) => l.dir > 0).reduce((s, l) => s + l.px * l.qty, 0);
  return Math.max(ce, pe) + 0.3 * Math.min(ce, pe) + debit;
}

// Stops judge the whole strategy, never one leg (the app's rule: Backtest, Compare and Bi-weekly screens). A leg stop in
// % of its premium becomes a stop on the whole position at that % of the entry premium (the smallest one if legs differ,
// or the strategy's own if that is nearer); stops on a leg's points, on a Nifty move or on S/R have no whole-strategy
// equivalent and are dropped, with their trailing and their re-entry after a stop. Leg targets stay as they are.
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

module.exports = { runBacktest, normalizeStrategy, wholeStrategyStops, estimateMargin, bs, impliedVol, delta, yearsTo, hhmm, MIN_OF };
