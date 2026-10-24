// Covered call against a Nifty ETF holding (Trading Ideas › Covered call). The rules are read from three threads by
// Suresh Kumar (@Suresh_kumar047: "Covered Call strategy against bees investment", 7 Mar 2023; "Covered call against
// Nifty bees investment", 19 May 2023; "Covered call in Nifty version 2", 30 Sep 2023), taken together as one strategy:
//   1. Hold NIFTYBEES worth `lots` Nifty lots, pledged for margin: quantity = lots × lot size × Nifty ÷ ETF price, valued
//      at the ETF's own prices (its 1-minute history from Upstox; a day without it is modelled from Nifty with the last
//      known ETF / Nifty ratio, and counted). The ETF keeps its dividends, so its price includes them.
//   2. Each monthly series: sell one monthly call per lot (by default in the money: the 100-point strike under spot)
//      and buy a 1:2:1 put butterfly under spot as insurance (or a put debit spread, or nothing).
//   3. Version 2, the "soldier": every weekly series, sell a contra spread with the pledged margin, chosen by where
//      Nifty is. Between the lower trigger and the call's breakeven: an iron condor (the threads' strangle / credit
//      spreads). Above the breakeven: a put credit spread. Below the trigger: a call credit spread. The threads also
//      allow naked options and ratio spreads; those have unlimited risk and are left out (spreads only).
//   4. At the monthly expiry, when Nifty closes above the call strike the holding's profit is booked (sold and bought
//      back, so it keeps covering the next call); when it closes below the month's entry the month's option profit is
//      reinvested in the holding ("buy more bees at a better average"). The next month starts the next session.
// The rule functions are shared by the backtest (runCoveredCall) and the live paper trade (ccpaper.js).
const Costs = require('../lib/costs');
const { bsm } = require('../lib/pricing');
const { MPD, OPEN_MIN, addDays, BEES } = require('./data');

const DEFAULTS = {
  lots: 1,
  lotSize: 65, // Nifty units per lot (today's lot by default, so years compare fairly)
  entryTime: '09:30', // the threads enter at 9:30
  call: { rule: 'itm100', value: 0 }, // itm100 | atm | itmPts | otmPts | otmPct
  // butterfly | debit | none; the butterfly's lower wing mirrors the upper. expiry: monthly (the threads: bought on the
  // month's expiry with the call) | weekly (paper trade only: bought on the nearest weekly series, the structure best
  // suited to that week picked from the live chain, closed at its expiry and the next week's bought)
  ins: { kind: 'butterfly', upperPct: 1.5, bodyPct: 4, expiry: 'monthly' },
  ovl: { on: true, lots: 1, otmPct: 1.5, width: 200, minCredit: 5, lowerPct: 1.5 },
  // reinvest: below (the month closed under its entry) | always | never. upPct: roll the call up when Nifty is this % over
  // its breakeven at a day's entry time (null = never), at most maxUp times a month, not in its last 3 days.
  roll: { bookAbove: true, reinvest: 'below', upPct: null, maxUp: 2 },
  costs: { slippage: 0.5, brokerage: 20, etfPct: 0.03 }, // slippage and ETF charges in % of each fill
  // what is held: NIFTYBEES (the ETF, its own prices) or a Nifty 50 index mutual fund. The app has no fund NAV history, so
  // a fund is modelled: Nifty's close + its dividend yield (divPct a year) − the fund's expense ratio (expPct a year);
  // bought and sold at that day's NAV, stamp duty only (0.005 % on purchases), and never sold and bought back.
  hold: { kind: 'etf', divPct: 1.2, expPct: 0.2 },
  minDays: 14, // live paper trade: the monthly expiry sold is at least this many days away
};
const CALL_RULES = ['itm100', 'atm', 'itmPts', 'otmPts', 'otmPct'];
const INS_KINDS = ['butterfly', 'debit', 'none'];
const REINVEST = ['below', 'always', 'never'];
const MARGIN_PCT = 0.12; // a naked short Nifty option needs about 12 % of its notional (SPAN + exposure), roughly
const HAIRCUT = 0.1; // pledged ETF counts at 90 % of its value
const CASH_SHARE = 0.5; // half the option margin has to be cash, the other half can be pledged collateral
const BEES_RATIO = 0.0112; // NIFTYBEES / Nifty (Rs 289 at 25,800 in Oct 2024): only used before any real ETF price is known

const r2 = (x) => Math.round(x * 100) / 100;
const roundTo = (x, step) => Math.round(x / step) * step;
const num = (v, d, lo = -Infinity, hi = Infinity) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

// The parameters with defaults filled in and everything clamped to sensible ranges.
function normalize(p = {}) {
  const D = DEFAULTS;
  const c = p.call || {};
  const i = p.ins || {};
  const o = p.ovl || {};
  const r = p.roll || {};
  const k = p.costs || {};
  const upperPct = num(i.upperPct, D.ins.upperPct, 0, 10);
  return {
    lots: Math.round(num(p.lots, D.lots, 1, 20)),
    lotSize: Math.round(num(p.lotSize, D.lotSize, 1, 200)),
    entryTime: /^\d{2}:\d{2}$/.test(p.entryTime || '') && p.entryTime >= '09:15' && p.entryTime <= '15:00' ? p.entryTime : D.entryTime,
    call: { rule: CALL_RULES.includes(c.rule) ? c.rule : D.call.rule, value: num(c.value, D.call.value, 0, 3000) },
    ins: {
      kind: INS_KINDS.includes(i.kind) ? i.kind : D.ins.kind,
      upperPct,
      bodyPct: num(i.bodyPct, D.ins.bodyPct, upperPct + 0.5, 20),
      expiry: i.expiry === 'weekly' ? 'weekly' : 'monthly',
    },
    ovl: {
      on: o.on === undefined ? D.ovl.on : Boolean(o.on),
      lots: Math.round(num(o.lots, D.ovl.lots, 1, 20)),
      otmPct: num(o.otmPct, D.ovl.otmPct, 0, 10),
      width: roundTo(num(o.width, D.ovl.width, 50, 2000), 50),
      minCredit: num(o.minCredit, D.ovl.minCredit, 0, 500),
      lowerPct: num(o.lowerPct, D.ovl.lowerPct, 0, 20),
    },
    roll: {
      bookAbove: r.bookAbove === undefined ? D.roll.bookAbove : Boolean(r.bookAbove),
      reinvest: REINVEST.includes(r.reinvest) ? r.reinvest : D.roll.reinvest,
      upPct: r.upPct === null || r.upPct === undefined || r.upPct === '' || !Number.isFinite(Number(r.upPct)) ? null : num(r.upPct, 0, 0, 10),
      maxUp: Math.round(num(r.maxUp, D.roll.maxUp, 1, 5)),
    },
    costs: {
      slippage: num(k.slippage, D.costs.slippage, 0, 10),
      brokerage: num(k.brokerage, D.costs.brokerage, 0, 1000),
      etfPct: num(k.etfPct, D.costs.etfPct, 0, 2),
    },
    minDays: Math.round(num(p.minDays, D.minDays, 1, 60)),
    hold: {
      kind: p.hold?.kind === 'mf' ? 'mf' : 'etf',
      divPct: num(p.hold?.divPct, D.hold.divPct, 0, 5),
      expPct: num(p.hold?.expPct, D.hold.expPct, 0, 3),
    },
  };
}
// The holding's name in texts.
const holdName = (p) => (p?.hold?.kind === 'mf' ? 'Nifty 50 index fund' : 'NIFTYBEES');
const MF_STAMP_PCT = 0.005; // stamp duty on mutual fund purchases
// A modelled index fund NAV: Nifty / 100, growing by (dividends − expenses) a year from `since`.
const mfNav = (nifty, hold, since, day) =>
  r2((nifty / 100) * Math.pow(1 + (hold.divPct - hold.expPct) / 100, Math.max(0, (Date.parse(day) - Date.parse(since)) / (365.25 * 86400_000))));

// ---------- the rules ----------
// Strike the covered call aims for (the nearest listed strike is used). "itm100" is the Nifty thread's choice:
// spot 18,270 → the 18,200 call, so the month earns its time value even if Nifty does not move.
function callTarget(spot, call) {
  if (call.rule === 'atm') return roundTo(spot, 50);
  if (call.rule === 'itmPts') return roundTo(spot - call.value, 50);
  if (call.rule === 'otmPts') return roundTo(spot + call.value, 50);
  if (call.rule === 'otmPct') return roundTo(spot * (1 + call.value / 100), 100);
  return Math.floor(spot / 100) * 100;
}

// Insurance legs under spot, as [{ type, side, strike, mult }] (mult = lots per covered lot). Butterfly 1:2:1 as in
// the threads (18,270 → 18,000 / 17,500 / 17,000; 41,350 → 40,500 / 39,500 / 38,500): upper wing upperPct under spot,
// body bodyPct under it, lower wing as far under the body as the upper is over it. Debit spread: the upper bought,
// the body sold.
function insuranceLegs(spot, ins) {
  if (ins.kind === 'none') return [];
  const upper = roundTo(spot * (1 - ins.upperPct / 100), 100);
  let body = roundTo(spot * (1 - ins.bodyPct / 100), 100);
  if (body >= upper) body = upper - 100;
  if (ins.kind === 'debit')
    return [
      { type: 'PE', side: 'B', strike: upper, mult: 1 },
      { type: 'PE', side: 'S', strike: body, mult: 1 },
    ];
  return [
    { type: 'PE', side: 'B', strike: upper, mult: 1 },
    { type: 'PE', side: 'S', strike: body, mult: 2 },
    { type: 'PE', side: 'B', strike: 2 * body - upper, mult: 1 },
  ];
}

// Where Nifty is against the month's levels: above the call's breakeven (strike + premium) = 'up', under the lower
// trigger (lowerPct under the month's entry) = 'down', else 'range'. Version 2's example: entry 19,500 with the 19,500
// call sold at 300 → above 19,800 sell puts, below 19,200 sell calls, in between sell both.
function regimeOf(spot, cyc) {
  if (spot > cyc.callBE) return 'up';
  if (spot < cyc.lower) return 'down';
  return 'range';
}
const REGIME_TEXT = { up: 'above the call breakeven', down: 'below the lower trigger', range: 'between the trigger and the breakeven' };

// The weekly contra spread for a regime, as legs (mult = overlay lots). 'up' → put credit spread, 'down' → call credit
// spread, 'range' → both (an iron condor).
function overlayLegs(spot, regime, ovl) {
  const legs = [];
  if (regime !== 'down') {
    const k = roundTo(spot * (1 - ovl.otmPct / 100), 50);
    legs.push({ type: 'PE', side: 'S', strike: k, mult: 1 }, { type: 'PE', side: 'B', strike: k - ovl.width, mult: 1 });
  }
  if (regime !== 'up') {
    const k = roundTo(spot * (1 + ovl.otmPct / 100), 50);
    legs.push({ type: 'CE', side: 'S', strike: k, mult: 1 }, { type: 'CE', side: 'B', strike: k + ovl.width, mult: 1 });
  }
  return legs;
}

// ---------- fills, settlement and charges ----------
// A fill with slippage against us (at least one 5-paise tick when slippage is on).
function fillPx(px, side, slippagePct, opening = true) {
  const s = slippagePct > 0 ? Math.max(0.05, (px * slippagePct) / 100) : 0;
  const sells = (side === 'S') === opening;
  return r2(Math.max(0.05, sells ? px - s : px + s));
}
const intrinsic = (type, strike, spot) => Math.max(0, type === 'CE' ? spot - strike : strike - spot);
// ₹ P&L of a leg { side, qty, entry } valued at `px`.
const legPnl = (l, px) => (l.side === 'S' ? l.entry - px : px - l.entry) * l.qty;
// Charges of placing these legs as orders (one order per leg) at the `price` field, on `day`.
function orderCost(legs, field, day, brokerage) {
  let buy = 0;
  let sell = 0;
  for (const l of legs) l.side === 'B' ? (buy += l[field] * l.qty) : (sell += l[field] * l.qty);
  return Costs.orders({ buy, sell, orders: legs.length, day, brokerage });
}
// Charges at expiry: no orders, but STT on the settlement value of bought options that end in the money.
const expiryCost = (legs, spot, day) => legs.reduce((s, l) => s + (l.side === 'B' ? Costs.exercise(intrinsic(l.type, l.strike, spot) * l.qty, day) : 0), 0);

// Margin the option positions need, roughly, each position on its own (groups = [[call], insurance legs, weekly
// legs]): a short option without a bought one of its type ~12 % of notional (SPAN + exposure); a debit structure
// (butterfly, debit spread) nothing beyond its premium, already paid; a credit spread or iron condor its maximum loss
// (only one side of a condor can lose). Shown beside the collateral the pledged holding gives (90 % of its value)
// and the cash half of the margin.
function groupMargin(ls, spot) {
  if (!ls.length) return 0;
  let naked = 0;
  let side = 0;
  for (const type of ['CE', 'PE']) {
    const t = ls.filter((l) => l.type === type);
    const shorts = t.filter((l) => l.side === 'S');
    const longs = t.filter((l) => l.side === 'B');
    const shortQ = shorts.reduce((s, l) => s + l.qty, 0);
    const longQ = longs.reduce((s, l) => s + l.qty, 0);
    naked += Math.max(0, shortQ - longQ);
    if (shortQ && longQ)
      side = Math.max(side, Math.max(...shorts.map((s) => Math.min(...longs.map((b) => Math.abs(s.strike - b.strike))))) * Math.min(shortQ, longQ));
  }
  if (naked) return naked * spot * MARGIN_PCT;
  const credit = ls.reduce((s, l) => s + (l.side === 'S' ? l.entry : -l.entry) * l.qty, 0);
  return credit > 0 ? Math.max(0, side - credit) : 0;
}
function marginEstimate(groups, spot, holdingValue) {
  const m = groups.reduce((s, g) => s + groupMargin(g.filter(Boolean), spot), 0);
  const collateral = (holdingValue || 0) * (1 - HAIRCUT);
  return { margin: Math.round(m), collateral: Math.round(collateral), cash: Math.round(m * CASH_SHARE) };
}

// ---------- backtest ----------
// The monthly cycles of [from, to]: each monthly expiry with the session after the previous monthly expiry as its
// start (or 34 days before it when the calendar has no earlier monthly), and its weekly series for the overlay.
function cyclesOf(cal, days, from, to) {
  const monthly = [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort();
  const all = [...cal.expired].sort();
  const next = (d) => days.find((x) => x > d) || null;
  const firstFrom = (d) => days.find((x) => x >= d) || null;
  const out = [];
  monthly.forEach((E, i) => {
    const start = i > 0 ? next(monthly[i - 1]) : firstFrom(addDays(E, -34));
    if (!start || start < from || E > to || start >= E) return;
    const weeks = [];
    for (const w of all) {
      if (w <= start || w > E) continue;
      const prev = all[all.indexOf(w) - 1];
      let entry = prev ? next(prev) : start;
      if (!entry || entry < start) entry = start;
      if (entry < w) weeks.push({ expiry: w, entry });
    }
    out.push({ expiry: E, start, weeks });
  });
  return out;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const minuteOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - OPEN_MIN;
const CLOSE_M = MPD - 1;

// Backtest on the cached history (bt/data.js). Returns cycles, the daily equity (strategy, buy-and-hold of the same
// units, option layer alone), an event log and statistics. ctl: { onProgress(p), stopped() }.
async function runCoveredCall(data, params, { from, to } = {}, ctl = {}) {
  const p = normalize(params);
  const mf = p.hold.kind === 'mf'; // a Nifty 50 index fund instead of NIFTYBEES
  const HN = holdName(p);
  const cal = await data.expiryCalendar();
  const monthly = [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort();
  if (!monthly.length) throw new Error('No expired monthly expiries in the calendar');
  const idxStart = data.indexStart();
  from = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : addDays(monthly[0], -34);
  to = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : monthly[monthly.length - 1];
  if (idxStart && from < idxStart) from = idxStart;
  const days = await data.loadIndex(addDays(from, -3) < (idxStart || from) ? from : addDays(from, -3), to);
  const plan = cyclesOf(cal, days, from, to);
  if (!plan.length) throw new Error('No monthly cycle fits in ' + from + ' → ' + to + ' (a cycle runs from the day after one monthly expiry to the next)');

  const units = p.lots * p.lotSize; // Nifty units the holding covers, and the call quantity
  const ovlQty = p.ovl.lots * p.lotSize;
  const slip = p.costs.slippage;
  const etf = (mf ? MF_STAMP_PCT : p.costs.etfPct) / 100;
  const entryM = minuteOf(p.entryTime);
  const spotAt = (day, m, f = 0) => data.spotDay(day)?.[m * 4 + f] ?? null;

  // NIFTYBEES at a minute: its own price, else Nifty × the last known ratio.
  if (!mf) await data.loadSeries?.(BEES, from, to);
  const beesRow = (day) => (mf ? null : data.seriesDay?.(BEES, day) || null);
  let ratio = null;
  for (const d of days) {
    const v = beesRow(d)?.[CLOSE_M * 4 + 3];
    if (v > 0 && spotAt(d, CLOSE_M, 3)) {
      ratio = v / spotAt(d, CLOSE_M, 3);
      break;
    }
  }
  const beesDays = { real: new Set(), model: new Set() };
  function beesAt(day, m, f = 0) {
    // an index fund: one NAV a day, at the close
    if (mf) return mfNav(spotAt(day, CLOSE_M, 3), p.hold, from, day);
    const v = beesRow(day)?.[m * 4 + f];
    const sp = spotAt(day, m, f);
    if (v > 0) {
      if (sp) ratio = v / sp;
      beesDays.real.add(day);
      return v;
    }
    beesDays.model.add(day);
    return r2(sp * (ratio ?? BEES_RATIO));
  }

  const notes = [];
  const events = [];
  const ev = (day, time, kind, text) => events.push({ day, time, kind, text });

  // Price of an option at a minute (open, or close with f = 3), or null when there is none.
  async function priceAt(expiry, strike, type, day, m, f = 0, needFrom = day) {
    const c = await data.option(expiry, strike, type, needFrom).catch(() => null);
    const a = c && data.optionDay(c, day);
    const v = a ? a[m * 4 + f] : 0;
    return v > 0 ? v / 100 : null;
  }
  // The listed strike nearest the target that has a price at the entry minute; falls back up to `reach` points away
  // (the cache may hold only strikes near the money), noting the substitution.
  async function pick(expiry, target, type, day, m, reach, needFrom) {
    let strikes;
    try {
      strikes = (await data.contracts(expiry)).strikes;
    } catch {
      strikes = [...data.optionFiles(expiry)].filter((f) => f.endsWith(type)).map((f) => Number(f.slice(0, -2)));
    }
    const cands = strikes.filter((k) => Math.abs(k - target) <= reach).sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    for (const k of cands) {
      const px = await priceAt(expiry, k, type, day, m, 0, needFrom);
      if (px != null) return { strike: k, px };
    }
    return null;
  }
  // Opens legs [{ type, side, strike, mult }] × qty on `expiry` at the entry minute of `day`; null if a leg has no price.
  async function open(legs, expiry, qty, day, reach, needFrom, tag) {
    const out = [];
    for (const l of legs) {
      const got = await pick(expiry, l.strike, l.type, day, entryM, reach, needFrom);
      if (!got) return { error: `no price for ${l.strike} ${l.type} (${expiry}) on ${day}` };
      if (got.strike !== l.strike) notes.push(`${day}: ${tag} ${l.strike} ${l.type} had no data, used ${got.strike}`);
      out.push({ expiry, type: l.type, side: l.side, strike: got.strike, qty: qty * l.mult, mkt: got.px, entry: fillPx(got.px, l.side, slip) });
    }
    return { legs: out, cost: orderCost(out, 'entry', day, p.costs.brokerage) };
  }
  const credit = (legs, qty) => r2(legs.reduce((s, l) => s + (l.side === 'S' ? l.entry : -l.entry) * l.qty, 0) / qty); // points per unit
  // Value of open legs at a day's close (option close, else intrinsic).
  async function mark(legs, day) {
    let v = 0;
    const sc = spotAt(day, CLOSE_M, 3);
    for (const l of legs) {
      const px =
        l.expiry === day ? intrinsic(l.type, l.strike, sc) : ((await priceAt(l.expiry, l.strike, l.type, day, CLOSE_M, 3)) ?? intrinsic(l.type, l.strike, sc));
      v += legPnl(l, px);
    }
    return v;
  }
  // Settles legs at the expiry close: returns { pnl, cost }.
  function settle(legs, day) {
    const sc = spotAt(day, CLOSE_M, 3);
    for (const l of legs) {
      l.exit = intrinsic(l.type, l.strike, sc);
      l.exitDay = day;
    }
    return { pnl: legs.reduce((s, l) => s + legPnl(l, l.exit), 0), cost: expiryCost(legs, sc, day) };
  }

  // Account: option P&L and charges go to cash; the holding is NIFTYBEES quantity × its price against its cost.
  const hold = { qty: 0, cost: 0, booked: 0, reinvested: 0 };
  let cash = 0;
  let optCum = 0; // the option layer's cumulative P&L after its charges
  let spot0 = null;
  let bees0 = null;
  let qty0 = 0;
  let bhCost = 0;
  let initialCost = 0;
  const equity = [];
  const cycles = [];
  const dayIdx = new Map(days.map((d, i) => [d, i]));

  for (let ci = 0; ci < plan.length; ci++) {
    if (ctl.stopped?.()) break;
    const P = plan[ci];
    ctl.onProgress?.({ phase: `Month ${ci + 1} of ${plan.length} (${P.expiry})`, done: ci, total: plan.length });
    const d0 = P.start;
    const s0 = spotAt(d0, entryM);
    if (s0 == null) {
      notes.push(`${P.expiry}: no Nifty data on ${d0}, month skipped`);
      continue;
    }
    // the holding: bought once, at the first month's entry
    const b0 = beesAt(d0, entryM);
    if (!hold.qty) {
      spot0 = s0;
      bees0 = b0;
      hold.qty = qty0 = Math.max(1, Math.round((units * s0) / b0));
      hold.cost = hold.qty * b0;
      initialCost = hold.cost;
      const c = hold.cost * etf;
      cash -= c;
      bhCost = c;
      ev(
        d0,
        p.entryTime,
        'hold',
        `Bought ${hold.qty.toLocaleString('en-IN')} ${mf ? 'units of the ' + HN : HN} at ₹${b0.toFixed(2)}${mf ? ' (modelled NAV)' : ''} = ₹${Math.round(hold.cost).toLocaleString('en-IN')} (covers ${units} Nifty units, ${p.lots} lot${p.lots > 1 ? 's' : ''}, at Nifty ${s0.toFixed(0)})`,
      );
    }
    const cyc = { n: cycles.length + 1, expiry: P.expiry, start: d0, spotIn: s0, beesIn: b0, qtyIn: hold.qty, notes: [], weeks: [], costs: 0 };
    const eqStart = equity.length ? equity[equity.length - 1] : { eq: 0, bh: 0, opt: 0 };

    // covered call
    const ct = callTarget(s0, p.call);
    const callOpen = await open([{ type: 'CE', side: 'S', strike: ct, mult: 1 }], P.expiry, units, d0, 300, d0, 'call');
    // without a call (no option data) the month carries the holding alone: no insurance, no overlay
    let call = callOpen.error ? null : callOpen.legs[0];
    cyc.call = call;
    cyc.rolls = [];
    cyc.callRealized = 0; // P&L of calls bought back when rolled up
    cyc.lower = s0 * (1 - p.ovl.lowerPct / 100);
    if (call) {
      cyc.callBE = call.strike + call.entry;
      cash += -callOpen.cost;
      optCum -= callOpen.cost;
      cyc.costs += callOpen.cost;
      ev(d0, p.entryTime, 'call', `Sold ${call.strike} CE (${P.expiry}) at ${call.entry.toFixed(1)}, breakeven ${cyc.callBE.toFixed(0)}`);
    } else {
      cyc.notes.push('no covered call this month: ' + callOpen.error);
      notes.push(`${P.expiry}: no covered call (holding only), ${callOpen.error}`);
      ev(d0, p.entryTime, 'skip', `No covered call this month (${callOpen.error}): holding only`);
    }

    // insurance
    cyc.ins = [];
    const insWant = insuranceLegs(s0, p.ins);
    if (call && insWant.length) {
      const io = await open(insWant, P.expiry, units, d0, 200, d0, 'insurance');
      if (io.error) {
        cyc.notes.push('insurance skipped: ' + io.error);
        notes.push(`${P.expiry}: insurance skipped, ${io.error}`);
      } else {
        cyc.ins = io.legs;
        cash -= io.cost;
        optCum -= io.cost;
        cyc.costs += io.cost;
        const debit = -credit(io.legs, units);
        ev(
          d0,
          p.entryTime,
          'ins',
          `${p.ins.kind === 'debit' ? 'Put debit spread' : 'Put butterfly'} ${io.legs.map((l) => l.strike).join(' / ')} for ${debit.toFixed(1)} debit`,
        );
      }
    }
    const margin0 = marginEstimate([[call], cyc.ins], s0, hold.qty * b0);

    // day by day until the monthly expiry
    let ovl = null; // the open weekly spread
    const wkByEntry = new Map(P.weeks.map((w) => [w.entry, w]));
    let maxMargin = margin0;
    for (let di = dayIdx.get(d0); di != null && di < days.length && days[di] <= P.expiry; di++) {
      const d = days[di];
      // roll the call up: Nifty is upPct over its breakeven at the entry time (the threads hold it; an option to test)
      if (call && p.roll.upPct != null && d > d0 && cyc.rolls.length < p.roll.maxUp && daysBetween(d, P.expiry) >= 3) {
        const s = spotAt(d, entryM);
        if (s > cyc.callBE * (1 + p.roll.upPct / 100)) {
          const k = callTarget(s, p.call);
          const back = k > call.strike ? await priceAt(P.expiry, call.strike, 'CE', d, entryM) : null;
          const nu = back != null ? await open([{ type: 'CE', side: 'S', strike: k, mult: 1 }], P.expiry, units, d, 300, d, 'roll') : null;
          if (nu && !nu.error) {
            const exit = fillPx(back, 'S', slip, false);
            const closeCost = orderCost([{ side: 'B', qty: call.qty, x: exit }], 'x', d, p.costs.brokerage);
            const realized = (call.entry - exit) * call.qty;
            cyc.callRealized += realized;
            cash += realized - closeCost - nu.cost;
            optCum += realized - closeCost - nu.cost;
            cyc.costs += closeCost + nu.cost;
            const next = nu.legs[0];
            cyc.rolls.push({
              day: d,
              spot: s,
              from: { strike: call.strike, entry: call.entry, exit },
              to: { strike: next.strike, entry: next.entry },
              pnl: Math.round(realized),
            });
            ev(
              d,
              p.entryTime,
              'roll',
              `Nifty ${s.toFixed(0)} is over the ${cyc.callBE.toFixed(0)} breakeven: bought back ${call.strike} CE at ${exit.toFixed(1)} (${realized >= 0 ? '+' : '−'}₹${Math.abs(Math.round(realized)).toLocaleString('en-IN')}) and sold ${next.strike} CE at ${next.entry.toFixed(1)}`,
            );
            call = next;
            cyc.call = call;
            cyc.callBE = call.strike + call.entry;
          }
        }
      }
      // weekly overlay entry
      const wk = p.ovl.on && call ? wkByEntry.get(d) : null;
      if (wk && !ovl) {
        const s = spotAt(d, entryM);
        const regime = regimeOf(s, cyc);
        const want = overlayLegs(s, regime, p.ovl);
        const oo = await open(want, wk.expiry, ovlQty, d, 100, d, 'overlay');
        const week = { expiry: wk.expiry, entry: d, regime, spot: s };
        if (oo.error) {
          week.skipped = oo.error;
        } else {
          const cr = credit(oo.legs, ovlQty);
          if (cr < p.ovl.minCredit) week.skipped = `credit ${cr.toFixed(1)} under the minimum ${p.ovl.minCredit}`;
          else {
            week.legs = oo.legs;
            week.credit = cr;
            week.costs = oo.cost;
            cash -= oo.cost;
            optCum -= oo.cost;
            cyc.costs += oo.cost;
            ovl = week;
            const m = marginEstimate([[call], cyc.ins, oo.legs], s, hold.qty * beesAt(d, entryM));
            if (m.margin > maxMargin.margin) maxMargin = m;
            const kind = regime === 'up' ? 'Put credit spread' : regime === 'down' ? 'Call credit spread' : 'Iron condor';
            ev(
              d,
              p.entryTime,
              'ovl',
              `Nifty ${s.toFixed(0)} ${REGIME_TEXT[regime]}: ${kind} ${oo.legs.map((l) => l.strike + ' ' + l.type).join(' / ')} (${wk.expiry}) for ${cr.toFixed(1)} credit`,
            );
          }
        }
        if (week.skipped) ev(d, p.entryTime, 'skip', `Weekly overlay (${wk.expiry}) skipped: ${week.skipped}`);
        cyc.weeks.push(week);
      }
      // weekly overlay expiry
      if (ovl && ovl.expiry === d) {
        const st = settle(ovl.legs, d);
        ovl.pnl = st.pnl - ovl.costs - st.cost;
        ovl.spotOut = spotAt(d, CLOSE_M, 3);
        ovl.costs += st.cost;
        cash += st.pnl - st.cost;
        optCum += st.pnl - st.cost;
        cyc.costs += st.cost;
        ev(
          d,
          '15:30',
          'ovl-exp',
          `Weekly spread expired, Nifty ${spotAt(d, CLOSE_M, 3).toFixed(0)}: ${ovl.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(ovl.pnl)).toLocaleString('en-IN')} after charges`,
        );
        ovl = null;
      }
      // monthly expiry: call and insurance settle, then book / reinvest
      if (d === P.expiry) {
        const sc = spotAt(d, CLOSE_M, 3);
        const bc = beesAt(d, CLOSE_M, 3);
        const sCall = settle(call ? [call] : [], d);
        const sIns = settle(cyc.ins, d);
        cash += sCall.pnl + sIns.pnl - sCall.cost - sIns.cost;
        optCum += sCall.pnl + sIns.pnl - sCall.cost - sIns.cost;
        cyc.costs += sCall.cost + sIns.cost;
        cyc.spotOut = sc;
        cyc.beesOut = bc;
        cyc.callPnl = sCall.pnl + cyc.callRealized; // with the calls bought back on a roll up
        cyc.insPnl = sIns.pnl;
        cyc.ovlPnl = cyc.weeks.reduce((s, w) => s + (w.legs ? w.pnl + w.costs : 0), 0); // before charges, like the others
        cyc.holdChange = cyc.qtyIn * (bc - b0);
        cyc.optNet = cyc.callPnl + cyc.insPnl + cyc.ovlPnl - cyc.costs;
        ev(
          d,
          '15:30',
          'exp',
          `Monthly expiry, Nifty ${sc.toFixed(0)}` +
            (call ? `: call ${sCall.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(sCall.pnl)).toLocaleString('en-IN')}` : '') +
            (cyc.ins.length ? `, insurance ${sIns.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(sIns.pnl)).toLocaleString('en-IN')}` : ''),
        );
        // Nifty above the call strike: the call is "called away" against the holding; book its profit and buy back
        if (p.roll.bookAbove && !mf && call && sc > call.strike && bc * hold.qty > hold.cost) {
          const gain = bc * hold.qty - hold.cost;
          const c = 2 * bc * hold.qty * etf;
          hold.booked += gain;
          hold.cost = bc * hold.qty;
          cash -= c;
          cyc.costs += c;
          cyc.booked = gain;
          ev(
            d,
            '15:30',
            'book',
            `Nifty closed above the ${call.strike} strike: booked the ${HN} profit ₹${Math.round(gain).toLocaleString('en-IN')} (sold and bought back ${hold.qty.toLocaleString('en-IN')} at ₹${bc.toFixed(2)})`,
          );
        }
        // the month's option profit into more of the holding
        const re = p.roll.reinvest;
        const add = Math.floor(cyc.optNet / bc);
        if (add > 0 && (re === 'always' || (re === 'below' && sc < s0))) {
          const amt = add * bc;
          hold.qty += add;
          hold.cost += amt;
          hold.reinvested += amt;
          cash -= amt + amt * etf;
          cyc.costs += amt * etf;
          cyc.reinvested = amt;
          cyc.reinvestQty = add;
          ev(
            d,
            '15:30',
            'reinvest',
            `Reinvested the month's option profit: bought ${add.toLocaleString('en-IN')} more ${mf ? 'units of the ' + HN : HN} at ₹${bc.toFixed(2)} (₹${Math.round(amt).toLocaleString('en-IN')}), now ${hold.qty.toLocaleString('en-IN')}`,
          );
        }
      }
      // close of the day: equity
      const sc = spotAt(d, CLOSE_M, 3);
      const held = (d < P.expiry ? [call, ...cyc.ins, ...(ovl ? ovl.legs : [])] : ovl ? ovl.legs : []).filter(Boolean);
      const mtm = held.length ? await mark(held, d) : 0;
      const bc = beesAt(d, CLOSE_M, 3);
      const eq = cash + hold.qty * bc - initialCost + mtm;
      const bh = qty0 * (bc - bees0) - bhCost;
      const point = { d, eq, bh, opt: optCum + mtm, hold: eq - optCum - mtm, s: sc, b: bc };
      const last = equity[equity.length - 1];
      if (last?.d === d) Object.assign(last, point);
      else equity.push(point);
    }
    if (cyc.spotOut == null) {
      notes.push(`${P.expiry}: the month did not reach its expiry in the data`);
      break;
    }
    const eqEnd = equity[equity.length - 1];
    cyc.total = eqEnd.eq - eqStart.eq;
    cyc.holdPnl = eqEnd.eq - eqEnd.opt - (eqStart.eq - eqStart.opt); // NIFTYBEES: its move, booking and charges
    cyc.bh = eqEnd.bh - eqStart.bh;
    cyc.notional = s0 * units;
    cyc.margin = maxMargin;
    cyc.qty = hold.qty;
    cycles.push(cyc);
  }
  ctl.onProgress?.({ phase: 'Done', done: plan.length, total: plan.length });
  if (!cycles.length) throw new Error('No month could be traded: ' + (notes[0] || 'no data'));

  for (const e of equity) for (const k of ['eq', 'bh', 'opt', 'hold']) e[k] = Math.round(e[k]);
  return {
    params: p,
    from: cycles[0].start,
    to: cycles[cycles.length - 1].expiry,
    units,
    spot0,
    bees0,
    qty0,
    initialCost,
    beesSource: { real: beesDays.real.size, model: [...beesDays.model].filter((d) => !beesDays.real.has(d)).length, mf },
    holdName: HN,
    cycles: cycles.map(slimCycle),
    equity,
    events,
    notes,
    stats: statsOf(cycles, equity, initialCost, hold),
  };
}

const slimLeg = (l) => l && { expiry: l.expiry, type: l.type, side: l.side, strike: l.strike, qty: Math.round(l.qty), entry: l.entry, exit: l.exit ?? null };
function slimCycle(c) {
  const R = (x) => (x == null ? null : Math.round(x));
  return {
    n: c.n,
    start: c.start,
    expiry: c.expiry,
    spotIn: r2(c.spotIn),
    spotOut: r2(c.spotOut),
    beesIn: r2(c.beesIn),
    beesOut: r2(c.beesOut),
    qtyIn: c.qtyIn,
    qty: c.qty,
    call: slimLeg(c.call),
    rolls: c.rolls || [],
    callBE: c.callBE == null ? null : r2(c.callBE),
    lower: r2(c.lower),
    ins: c.ins.map(slimLeg),
    weeks: c.weeks.map((w) => ({
      expiry: w.expiry,
      entry: w.entry,
      regime: w.regime,
      spot: r2(w.spot),
      spotOut: w.spotOut == null ? null : r2(w.spotOut),
      credit: w.credit ?? null,
      pnl: R(w.pnl),
      skipped: w.skipped || null,
      legs: (w.legs || []).map(slimLeg),
    })),
    callPnl: R(c.callPnl),
    insPnl: R(c.insPnl),
    ovlPnl: R(c.ovlPnl),
    costs: R(c.costs),
    optNet: R(c.optNet),
    holdChange: R(c.holdChange),
    holdPnl: R(c.holdPnl),
    reinvestQty: c.reinvestQty || 0,
    booked: R(c.booked),
    reinvested: R(c.reinvested),
    total: R(c.total),
    bh: R(c.bh),
    notional: R(c.notional),
    margin: c.margin,
    notes: c.notes,
  };
}

function maxDrawdown(series) {
  let peak = 0;
  let dd = 0;
  let at = null;
  for (const e of series) {
    peak = Math.max(peak, e.v);
    if (e.v - peak < dd) {
      dd = e.v - peak;
      at = e.d;
    }
  }
  return { dd: Math.round(dd), at };
}

function statsOf(cycles, equity, initialCost, hold) {
  const last = equity[equity.length - 1];
  const years = Math.max(1 / 12, (Date.parse(last.d) - Date.parse(cycles[0].start)) / (365.25 * 86400_000));
  const sum = (f) => cycles.reduce((s, c) => s + (f(c) || 0), 0);
  const weeks = cycles.flatMap((c) => c.weeks);
  const traded = weeks.filter((w) => w.legs?.length);
  const optPct = cycles.map((c) => (c.optNet / c.notional) * 100);
  const pctYear = (v) => (v / initialCost / years) * 100;
  return {
    months: cycles.length,
    years: r2(years),
    initialCost: Math.round(initialCost),
    total: last.eq,
    bh: last.bh,
    opt: last.opt,
    hold: last.eq - last.opt,
    edge: last.eq - last.bh,
    totalPctYear: r2(pctYear(last.eq)),
    bhPctYear: r2(pctYear(last.bh)),
    optPctYear: r2(pctYear(last.opt)),
    holdPctYear: r2(pctYear(last.eq - last.opt)),
    ddTotal: maxDrawdown(equity.map((e) => ({ d: e.d, v: e.eq }))),
    ddBh: maxDrawdown(equity.map((e) => ({ d: e.d, v: e.bh }))),
    ddOpt: maxDrawdown(equity.map((e) => ({ d: e.d, v: e.opt }))),
    call: Math.round(sum((c) => c.callPnl)),
    ins: Math.round(sum((c) => c.insPnl)),
    ovl: Math.round(sum((c) => c.ovlPnl)),
    costs: Math.round(sum((c) => c.costs)),
    optMonthsUp: cycles.filter((c) => c.optNet > 0).length,
    beatMonths: cycles.filter((c) => c.total > c.bh).length,
    avgOptPct: r2(optPct.reduce((s, v) => s + v, 0) / cycles.length),
    bestOpt: Math.round(Math.max(...cycles.map((c) => c.optNet))),
    worstOpt: Math.round(Math.min(...cycles.map((c) => c.optNet))),
    ovlWeeks: traded.length,
    ovlWins: traded.filter((w) => w.pnl > 0).length,
    ovlSkipped: weeks.length - traded.length,
    booked: Math.round(hold.booked),
    reinvested: Math.round(hold.reinvested),
    qtyEnd: hold.qty,
    maxMargin: Math.max(...cycles.map((c) => c.margin.margin)),
    maxCash: Math.max(...cycles.map((c) => c.margin.cash)),
  };
}

// ---------- month by month on a chosen path (a model, for the Strategy & rules animation) ----------
// The strategy repeated every month while Nifty moves `totalPct` % in all over `months` months, the same % each month.
// swings: inside each month Nifty zig-zags around that line by a typical weekly move (0.8 × the weekly σ at `iv`: up,
// back, down, back, so the month still ends on the line); false = a straight line, which flatters the weekly spreads.
// Each month: the rule's call
// and insurance priced by Black-Scholes at volatility `iv` (decimal) for 4 weeks, four weekly contra spreads priced for a
// week each, all with the strategy's slippage and charges, settled at intrinsic. NIFTYBEES bought once at the start
// and held; booking and reinvesting at the expiry are left out. Returns the months and their running totals.
function modelPath({ params, spot0, bees0, totalPct, months = 12, iv = 0.13, swings = true }) {
  const p = normalize(params);
  const units = p.lots * p.lotSize;
  const ovlQty = p.ovl.lots * p.lotSize;
  const slip = p.costs.slippage;
  months = Math.round(Math.min(36, Math.max(1, Number(months) || 12)));
  const total = Math.min(100, Math.max(-60, Number(totalPct) || 0));
  const g = Math.pow(1 + total / 100, 1 / months) - 1;
  const d = swings ? 0.8 * iv * Math.sqrt(7 / 365) : 0; // a typical weekly move
  const ZIG = [0, d, 0, -d, 0]; // offsets from the line at the week boundaries
  const at = (S, j) => S * Math.pow(1 + g, j / 4) * (1 + ZIG[j]);
  const qty = Math.max(1, Math.round((units * spot0) / bees0));
  const day = new Date().toISOString().slice(0, 10); // today's charges
  const price = (S, K, days, type) => Math.max(0.05, bsm(S, K, days / 365, iv, type === 'CE'));
  const priced = (legs, S, qtyEach, days) =>
    legs.map((l) => {
      const px = price(S, l.strike, days, l.type);
      return { ...l, qty: qtyEach * l.mult, mkt: r2(px), entry: fillPx(px, l.side, slip) };
    });
  const settle = (legs, S) => legs.reduce((a, l) => a + legPnl(l, intrinsic(l.type, l.strike, S)), 0);
  const out = [];
  let S = spot0;
  const cum = { opt: 0, bees: 0, total: 0 };
  for (let m = 0; m < months; m++) {
    const S1 = S * (1 + g);
    const call = priced([{ type: 'CE', side: 'S', strike: callTarget(S, p.call), mult: 1 }], S, units, 28)[0];
    const ins = priced(insuranceLegs(S, p.ins), S, units, 28);
    const lv = { callBE: call.strike + call.entry, lower: S * (1 - p.ovl.lowerPct / 100) };
    // the weekly spreads, each net of its own charges
    const weeks = [];
    if (p.ovl.on)
      for (let w = 0; w < 4; w++) {
        const a = at(S, w);
        const b = at(S, w + 1);
        const regime = regimeOf(a, lv);
        const legs = priced(overlayLegs(a, regime, p.ovl), a, ovlQty, 7);
        const credit = r2(legs.reduce((s, l) => s + (l.side === 'S' ? l.entry : -l.entry) * l.qty, 0) / ovlQty);
        const week = { regime, spot: r2(a), spotOut: r2(b), credit };
        if (credit < p.ovl.minCredit) week.skipped = true;
        else {
          week.shorts = legs.filter((l) => l.side === 'S').map((l) => l.strike + ' ' + l.type);
          week.pnl = Math.round(settle(legs, b) - orderCost(legs, 'entry', day, p.costs.brokerage) - expiryCost(legs, b, day));
        }
        weeks.push(week);
      }
    const monthCosts = orderCost([call, ...ins], 'entry', day, p.costs.brokerage) + expiryCost([call, ...ins], S1, day);
    const callPnl = settle([call], S1);
    const insPnl = settle(ins, S1);
    const wkPnl = weeks.reduce((s, w) => s + (w.pnl || 0), 0);
    const opt = callPnl + insPnl + wkPnl - monthCosts;
    const bees = qty * (bees0 / spot0) * (S1 - S);
    cum.opt += opt;
    cum.bees += bees;
    cum.total += opt + bees;
    out.push({
      n: m + 1,
      spotIn: r2(S),
      spotOut: r2(S1),
      call: { strike: call.strike, entry: call.entry, exit: r2(intrinsic('CE', call.strike, S1)) },
      callBE: r2(lv.callBE),
      ins: ins.map((l) => ({ side: l.side, strike: l.strike, qty: l.qty, entry: l.entry, exit: r2(intrinsic('PE', l.strike, S1)) })),
      weeks,
      callPnl: Math.round(callPnl),
      insPnl: Math.round(insPnl),
      wkPnl: Math.round(wkPnl),
      costs: Math.round(monthCosts),
      opt: Math.round(opt),
      bees: Math.round(bees),
      total: Math.round(opt + bees),
      cum: { opt: Math.round(cum.opt), bees: Math.round(cum.bees), total: Math.round(cum.total) },
    });
    S = S1;
  }
  return {
    holdName: holdName(p),
    spot0: r2(spot0),
    bees0: r2(bees0),
    qty,
    units,
    months,
    totalPct: total,
    monthlyPct: r2(g * 100),
    iv,
    swings: Boolean(swings),
    weeklySwingPct: r2(d * 100),
    cost: Math.round(qty * bees0),
    path: out,
  };
}

module.exports = {
  DEFAULTS,
  normalize,
  callTarget,
  insuranceLegs,
  regimeOf,
  overlayLegs,
  REGIME_TEXT,
  BEES_RATIO,
  fillPx,
  intrinsic,
  legPnl,
  orderCost,
  expiryCost,
  marginEstimate,
  cyclesOf,
  runCoveredCall,
  modelPath,
  holdName,
  mfNav,
  MF_STAMP_PCT,
};
