// Trading Ideas › Covered call › Modified covered call: NIFTYBEES worth one lot of Nifty (65 × Nifty) plus, on every
// monthly series (entered on its first trading day, held to the monthly expiry):
//   - a call ratio spread: buy 1 lot CE 100 pts over ATM, sell 2 lots 100 pts above that
//   - a 2-3-1 put butterfly: buy 2 lots PE 100 pts under ATM, sell 3 lots 200 pts under that, buy 1 lot 100 pts
//     under the sold strike (the far wing is bought, so the put side is defined risk)
// The extra sold call is covered by the ETF. Adjustments only move sold strikes (the user's rule): market up → the
// sold puts are rolled up to the strike at their entry distance from the new ATM; market down → the sold calls are
// rolled down the same way. "When" is a parameter (a Nifty move from the last roll, or the sold leg's premium decay)
// so the backtest can compare them; up-market extras (roll the call spread up, or buy one sold call back) are
// separate switches. Shared by the backtest (runMcc / runMccStudy) and the live paper trade (mccpaper.js).
const Costs = require('../lib/costs');
const { MPD, addDays } = require('./data');

const DEFAULTS = {
  lotSize: 65,
  lots: 1, // multiplier on every quantity below (and on the ETF)
  entryMin: 15, // minutes after 09:15 on the series' first day (09:30)
  ce: { buyOff: 100, sellGap: 100, buy: 1, sell: 2 },
  pe: { buyOff: 100, sellGap: 200, wingGap: 100, buy: 2, sell: 3, wing: 1 },
  adj: {
    on: true,
    trigger: 'move', // 'move': Nifty moved movePct % from the side's last roll (or entry); 'decay': the sold leg is worth decayPct % of what it was sold for
    movePct: 2, // best of 1 / 1.5 / 2 / 3 % in the study (Nov 2024 – Sep 2026); 1 % costs money
    decayPct: 35,
    check: 'close', // 'close': once a day at 15:00; 'hourly': 10:30 … 15:00
    lastDays: 3, // no adjustments in the last N trading days of the series (the expiry day counts)
    maxPerSide: 3, // rolls per side per month
    legs: 'short', // 'short': only the sold strikes move (the rule as given); 'all': the whole spread / butterfly moves
    capPut: true, // sold puts never above the bought puts' strike (else a reversal leaves 3 sold over 2 bought)
  },
  up: {
    mode: 'none', // up-market extra: 'none' | 'roll' (whole call ratio up to the new ATM) | 'buyBack' (buy one sold call back once) | 'hedge' (buy a call hedgeGap over the sold strike once)
    buffer: 0, // pts: acts when Nifty is at or above the sold call strike + buffer
    max: 2, // times per month ('roll')
    hedgeGap: 200, // pts over the sold call strike ('hedge')
  },
  // NIFTYBEES: 'model' = ₹1 per 100 Nifty points (price = Nifty ÷ 100, so 65 × Nifty worth is 6,500 units and moves
  // like one lot of Nifty); 'real' = its recorded prices (bt-cache, from Sep 2024)
  etf: 'model',
  costs: { slipPct: 0.5, brokerage: 20, taxes: true, etfSlipPct: 0.05 },
};

const CHECK_MINS = { close: [345], hourly: [75, 135, 195, 255, 315, 345] };
const STEP = 50;
const atmOf = (S) => Math.round(S / STEP) * STEP;
const sideOf = (role) => (role === 'ceS' || role === 'peS' ? -1 : 1); // ceH: the up-market hedge call (bought)
const typeOf = (role) => (role[0] === 'c' ? 'CE' : 'PE');
const timeOf = (m) => {
  const t = 9 * 60 + 15 + m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const merge = (p = {}) => {
  const out = { ...DEFAULTS, ...p };
  for (const k of ['ce', 'pe', 'adj', 'up', 'costs']) out[k] = { ...DEFAULTS[k], ...(p[k] || {}) };
  return out;
};

// Nearest listed strike (strikes sorted ascending); the target itself when the list is empty.
function snap(strikes, k) {
  if (!strikes?.length) return k;
  let best = strikes[0];
  for (const s of strikes) if (Math.abs(s - k) < Math.abs(best - k)) best = s;
  return best;
}

// The opening legs for Nifty at S: [{ role, type, side, strike, lots }].
function legsAt(S, p, strikes) {
  const A = atmOf(S);
  const ceL = snap(strikes, A + p.ce.buyOff);
  const ceS = snap(strikes, ceL + p.ce.sellGap);
  const peL = snap(strikes, A - p.pe.buyOff);
  const peS = snap(strikes, peL - p.pe.sellGap);
  const peW = snap(strikes, peS - p.pe.wingGap);
  const L = p.lots;
  return [
    { role: 'ceL', strike: ceL, lots: p.ce.buy * L },
    { role: 'ceS', strike: ceS, lots: p.ce.sell * L },
    { role: 'peL', strike: peL, lots: p.pe.buy * L },
    { role: 'peS', strike: peS, lots: p.pe.sell * L },
    { role: 'peW', strike: peW, lots: p.pe.wing * L },
  ]
    .filter((l) => l.lots > 0)
    .map((l) => ({ ...l, type: typeOf(l.role), side: sideOf(l.role) }));
}

// A new position (no fills yet): what decide() and apply() work on.
function newPosition(expiry, S) {
  return { expiry, legs: [], closed: [], refPut: S, refCall: S, n: { put: 0, call: 0, up: 0 }, boughtBack: false, seq: 0 };
}

// The adjustments due now. pos: the open position; S: Nifty; ctx: { daysLeft (trading days after today to the
// expiry), strikes, px(leg) → its price now or null }. Returns [{ kind, reason, close: [{ id, lots }], open: [legs], ref }].
function decide(pos, S, ctx, p) {
  const out = [];
  if (ctx.daysLeft < p.adj.lastDays) return out;
  const A = atmOf(S);
  const open = (role) => pos.legs.filter((l) => l.role === role && l.lots > 0);
  const [ceS] = open('ceS');
  const [ceL] = open('ceL');
  const [peS] = open('peS');
  const [peL] = open('peL');
  const reopen = (legs, role, strike) => legs.filter((l) => l.role === role).map((l) => ({ role, type: l.type, side: l.side, strike, lots: l.lots }));
  const closeAll = (legs) => legs.map((l) => ({ id: l.id, lots: l.lots }));

  // up-market extra on the call side (before the user's call roll: they never both apply, the market is either up or down)
  let callDone = false;
  if (p.up.mode !== 'none' && ceS && S >= ceS.strike + p.up.buffer) {
    if (p.up.mode === 'roll' && pos.n.up < p.up.max) {
      const legs = [...open('ceL'), ...open('ceS')];
      const nL = snap(ctx.strikes, A + p.ce.buyOff);
      const nS = snap(ctx.strikes, nL + p.ce.sellGap);
      if (nS > ceS.strike) {
        out.push({
          kind: 'upRoll',
          reason: `Nifty ${S.toFixed(0)} reached the sold ${ceS.strike} CE: call ratio moved up to ${nL}/${nS}`,
          close: closeAll(legs),
          open: [...reopen(legs, 'ceL', nL), ...reopen(legs, 'ceS', nS)],
          ref: { call: S },
        });
        callDone = true;
      }
    } else if (p.up.mode === 'buyBack' && !pos.boughtBack && ceL && ceS.lots > ceL.lots) {
      const lots = ceS.lots - ceL.lots;
      out.push({
        kind: 'buyBack',
        reason: `Nifty ${S.toFixed(0)} reached the sold ${ceS.strike} CE: ${lots} lot bought back, the ETF's gains above it are kept`,
        close: [{ id: ceS.id, lots }],
        open: [],
        flag: 'boughtBack',
      });
      callDone = true;
    } else if (p.up.mode === 'hedge' && !pos.hedged && ceL && ceS.lots > ceL.lots) {
      const lots = ceS.lots - ceL.lots;
      const k = snap(ctx.strikes, ceS.strike + p.up.hedgeGap);
      out.push({
        kind: 'upHedge',
        reason: `Nifty ${S.toFixed(0)} reached the sold ${ceS.strike} CE: bought ${lots} lot ${k} CE, so the ETF's gains above ${k} are kept`,
        open: [{ role: 'ceH', type: 'CE', side: 1, strike: k, lots }],
        close: [],
        flag: 'hedged',
      });
      callDone = true;
    }
  }
  if (!p.adj.on) return out;
  const dueUp = (leg, ref) =>
    p.adj.trigger === 'decay' ? leg && ctx.px(leg) != null && ctx.px(leg) <= (leg.entry * p.adj.decayPct) / 100 : S >= ref * (1 + p.adj.movePct / 100);
  const dueDn = (leg, ref) =>
    p.adj.trigger === 'decay' ? leg && ctx.px(leg) != null && ctx.px(leg) <= (leg.entry * p.adj.decayPct) / 100 : S <= ref * (1 - p.adj.movePct / 100);
  const why = (leg, ref, dir) =>
    p.adj.trigger === 'decay'
      ? `sold ${leg.strike} ${leg.type} down to ${ctx.px(leg).toFixed(1)} (${((ctx.px(leg) / leg.entry) * 100).toFixed(0)} % of ${leg.entry.toFixed(1)})`
      : `Nifty ${S.toFixed(0)} is ${(((S - ref) / ref) * 100).toFixed(1)} % ${dir} the last roll (${ref.toFixed(0)})`;

  // market up: sold puts up to their entry distance from the new ATM
  if (peS && pos.n.put < p.adj.maxPerSide && dueUp(peS, pos.refPut)) {
    if (p.adj.legs === 'all') {
      const legs = [...open('peL'), ...open('peS'), ...open('peW')];
      const nL = snap(ctx.strikes, A - p.pe.buyOff);
      const nS = snap(ctx.strikes, nL - p.pe.sellGap);
      const nW = snap(ctx.strikes, nS - p.pe.wingGap);
      if (nS > peS.strike)
        out.push({
          kind: 'rollPut',
          reason: `${why(peS, pos.refPut, 'above')}: put butterfly moved up to ${nL}/${nS}/${nW}`,
          close: closeAll(legs),
          open: [...reopen(legs, 'peL', nL), ...reopen(legs, 'peS', nS), ...reopen(legs, 'peW', nW)],
          ref: { put: S },
        });
    } else {
      let nS = snap(ctx.strikes, A - p.pe.buyOff - p.pe.sellGap);
      if (p.adj.capPut && peL && nS > peL.strike) nS = peL.strike;
      if (nS > peS.strike)
        out.push({
          kind: 'rollPut',
          reason: `${why(peS, pos.refPut, 'above')}: sold puts moved up ${peS.strike} → ${nS}`,
          close: [{ id: peS.id, lots: peS.lots }],
          open: reopen([peS], 'peS', nS),
          ref: { put: S },
        });
    }
  }
  // market down: sold calls down to their entry distance from the new ATM (never under the bought call)
  if (!callDone && ceS && pos.n.call < p.adj.maxPerSide && dueDn(ceS, pos.refCall)) {
    if (p.adj.legs === 'all') {
      const legs = [...open('ceL'), ...open('ceS')];
      const nL = snap(ctx.strikes, A + p.ce.buyOff);
      const nS = snap(ctx.strikes, nL + p.ce.sellGap);
      if (nS < ceS.strike)
        out.push({
          kind: 'rollCall',
          reason: `${why(ceS, pos.refCall, 'under')}: call ratio moved down to ${nL}/${nS}`,
          close: closeAll(legs),
          open: [...reopen(legs, 'ceL', nL), ...reopen(legs, 'ceS', nS)],
          ref: { call: S },
        });
    } else {
      let nS = snap(ctx.strikes, A + p.ce.buyOff + p.ce.sellGap);
      if (ceL && nS < ceL.strike) nS = ceL.strike;
      if (nS < ceS.strike)
        out.push({
          kind: 'rollCall',
          reason: `${why(ceS, pos.refCall, 'under')}: sold calls moved down ${ceS.strike} → ${nS}`,
          close: [{ id: ceS.id, lots: ceS.lots }],
          open: reopen([ceS], 'ceS', nS),
          ref: { call: S },
        });
    }
  }
  return out;
}

// Contracts an action needs prices for: [{ type, strike }].
const needs = (pos, a) => [...a.close.map((c) => pos.legs.find((l) => l.id === c.id)), ...a.open].map((l) => ({ type: l.type, strike: l.strike }));

// Books fills. book = { slip (fraction), brokerage, taxes, lot, day, cash, costs, costsBy }: cash = premium received −
// paid (₹); costsBy = the costs of the call ratio (CE) and the put butterfly (PE) apart.
function addCost(book, type, c) {
  book.costs += c;
  if (type) {
    book.costsBy ||= { CE: 0, PE: 0 };
    book.costsBy[type] += c;
  }
}
function fill(book, side, px, qty, type) {
  const f = side > 0 ? px * (1 + book.slip) : px * (1 - book.slip);
  const turn = f * qty;
  book.cash += side > 0 ? -turn : turn;
  addCost(book, type, book.taxes ? Costs.orders({ [side > 0 ? 'buy' : 'sell']: turn, orders: 1, day: book.day, brokerage: book.brokerage }) : book.brokerage);
  return f;
}

// Opens legs at prices from price(type, strike); all or nothing. Returns false when a price is missing.
function openLegs(pos, legs, price, book, at) {
  const px = legs.map((l) => price(l.type, l.strike));
  if (px.some((x) => !(x > 0))) return false;
  legs.forEach((l, i) => pos.legs.push({ ...l, id: ++pos.seq, entry: fill(book, l.side, px[i], l.lots * book.lot, l.type), at }));
  return true;
}

// Carries out one decide() action; false (nothing changed) when a price is missing.
function apply(pos, a, price, book, at) {
  const closing = a.close.map((c) => ({ c, leg: pos.legs.find((l) => l.id === c.id) }));
  const pxClose = closing.map(({ leg }) => price(leg.type, leg.strike));
  const pxOpen = a.open.map((l) => price(l.type, l.strike));
  if ([...pxClose, ...pxOpen].some((x) => !(x > 0))) return false;
  closing.forEach(({ c, leg }, i) => {
    const exit = fill(book, -leg.side, pxClose[i], c.lots * book.lot, leg.type);
    pos.closed.push({ ...leg, lots: c.lots, exit, exitAt: at, pnl: (exit - leg.entry) * leg.side * c.lots * book.lot });
    leg.lots -= c.lots;
  });
  pos.legs = pos.legs.filter((l) => l.lots > 0);
  a.open.forEach((l, i) => pos.legs.push({ ...l, id: ++pos.seq, entry: fill(book, l.side, pxOpen[i], l.lots * book.lot, l.type), at }));
  if (a.ref?.put != null) {
    pos.refPut = a.ref.put;
    pos.n.put++;
  }
  if (a.ref?.call != null) {
    pos.refCall = a.ref.call;
    if (a.kind === 'upRoll') pos.n.up++;
    else pos.n.call++;
  }
  if (a.flag) pos[a.flag] = true;
  return true;
}

// Expiry: every open leg at its intrinsic value against Nifty's close S (no slippage; STT on bought legs that finish ITM).
function settle(pos, S, book, at) {
  for (const l of pos.legs) {
    const v = Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S);
    const qty = l.lots * book.lot;
    book.cash += l.side * v * qty;
    if (l.side > 0 && v > 0 && book.taxes) addCost(book, l.type, Costs.exercise(v * qty, book.day));
    pos.closed.push({ ...l, exit: v, exitAt: at, pnl: (v - l.entry) * l.side * qty });
  }
  pos.legs = [];
}

// Value of the position's legs at expiry for Nifty at x (₹, before costs), entry premiums included.
const payoffAt = (legs, x, lot) => legs.reduce((s, l) => s + l.side * (Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x) - l.entry) * l.lots * lot, 0);

// A month's options P&L split into the call ratio spread (CE legs) and the put butterfly (PE legs), each net of its costs.
function splitPnl(closed, book) {
  const by = (t) => closed.filter((c) => c.type === t).reduce((s, c) => s + c.pnl, 0) - (book.costsBy?.[t] || 0);
  return { call: Math.round(by('CE')), put: Math.round(by('PE')) };
}

// ETF buy / sell charges (delivery: stamp 0.015 % on buys, exchange fees, STT 0.001 % on ETF sells) plus slippage.
const etfCost = (turn, buy, slip) => turn * (slip + (buy ? 0.00015 : 0.00001) + 0.0000297);

// ---------- backtest ----------

// One run over the monthly series in [from, to]. Returns { months, summary, params }.
// The ETF is reported both ways from the same option trades: bought once and held ('once'), or bought at each
// series start and sold at its expiry ('monthly'), always 65 × lots × Nifty worth at that entry.
async function runMcc(data, params = {}, range = {}, { onProgress = () => {}, stopped = () => false } = {}) {
  const p = merge(params);
  const lot = p.lotSize;
  const cal = await data.expiryCalendar();
  const monthly = [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort();
  const start = data.indexStart() || '2000-01-01';
  const series = [];
  for (let i = 1; i < monthly.length; i++) {
    const E = monthly[i];
    const P = monthly[i - 1];
    if (range.from && E < range.from) continue;
    if (range.to && E > range.to) continue;
    if (addDays(P, 1) < start) continue;
    series.push({ P, E });
  }
  const months = [];
  let once = null; // { qty, last } the ETF bought at the first entry
  for (let i = 0; i < series.length; i++) {
    if (stopped()) break;
    onProgress({ phase: 'Simulating', done: i, total: series.length });
    const r = await runMonth(data, p, series[i], once);
    if (r.once) once = r.once;
    months.push(r.month);
  }
  onProgress({ phase: 'Done', done: series.length, total: series.length });
  return { at: Date.now(), params: p, months, summary: summarize(months, lot * p.lots) };
}

async function runMonth(data, p, { P, E }, once) {
  const lot = p.lotSize;
  const month = { expiry: E, prevExpiry: P, events: [], ok: false };
  const days = await data.loadIndex(addDays(P, 1), E);
  if (!days.length || days[days.length - 1] !== E) {
    month.skip = 'Nifty history missing for the series';
    return { month };
  }
  const d0 = days[0];
  const spotAt = (d, m) => data.spotDay(d)?.[m * 4 + 3] ?? null;
  const real = p.etf === 'real';
  if (real) await data.loadSeries(data.BEES, P, E);
  const beesAt = (d, m) => {
    if (!real) return spotAt(d, m) / 100;
    const v = data.seriesDay(data.BEES, d)?.[m * 4 + 3];
    return v > 0 ? v : null;
  };
  let info;
  try {
    info = await data.contracts(E);
  } catch (e) {
    month.skip = 'No option contracts: ' + e.message;
    return { month };
  }
  const strikes = info.strikes;
  const loaded = new Map();
  const load = async (type, strike) => {
    const id = strike + type;
    if (loaded.has(id)) return loaded.get(id);
    let c = null;
    try {
      c = data.optionCached(E, strike, type, d0) || (await data.option(E, strike, type, d0));
    } catch {
      c = null;
    }
    loaded.set(id, c);
    return c;
  };
  const priceOn = (d, m) => (type, strike) => {
    const c = loaded.get(strike + type);
    if (!c) return null;
    const a = data.optionDay(c, d);
    const v = a?.[m * 4 + 3];
    return v > 0 ? v / 100 : null;
  };
  const book = { slip: p.costs.slipPct / 100, brokerage: p.costs.brokerage, taxes: p.costs.taxes, lot, day: d0, cash: 0, costs: 0, costsBy: { CE: 0, PE: 0 } };
  const S0 = spotAt(d0, p.entryMin);
  const pos = newPosition(E, S0);
  const legs = legsAt(S0, p, strikes);
  await Promise.all(legs.map((l) => load(l.type, l.strike)));
  const at0 = { day: d0, time: timeOf(p.entryMin) };
  if (!openLegs(pos, legs, priceOn(d0, p.entryMin), book, at0)) {
    const miss = legs.filter((l) => !(priceOn(d0, p.entryMin)(l.type, l.strike) > 0)).map((l) => l.strike + l.type);
    month.skip = 'No price at entry for ' + miss.join(', ');
    return { month };
  }
  month.entry = { ...at0, spot: S0, legs: pos.legs.map((l) => ({ ...l })) };
  month.events.push({ ...at0, kind: 'entry', spot: S0, text: 'Opened ' + pos.legs.map(legText).join(' · ') });

  // the ETF
  const b0 = beesAt(d0, p.entryMin) || (once ? once.last * (S0 / once.lastSpot) : null);
  const etfSlip = p.costs.etfSlipPct / 100;
  let onceOut = once;
  const etf = { monthly: 0, once: 0 };
  if (b0) {
    const qty = Math.round((lot * p.lots * S0) / b0);
    etf.qtyMonthly = qty;
    etf.monthly = -etfCost(qty * b0, true, etfSlip);
    if (!onceOut) {
      onceOut = { qty, last: b0, lastSpot: S0, cost: etfCost(qty * b0, true, etfSlip), invested: qty * b0 };
      etf.once = -onceOut.cost;
    }
  }

  const mins = CHECK_MINS[p.adj.check] || CHECK_MINS.close;
  for (let di = 0; di < days.length; di++) {
    const d = days[di];
    book.day = d;
    const daysLeft = days.length - 1 - di;
    for (const m of mins) {
      if (d === d0 && m <= p.entryMin) continue;
      const S = spotAt(d, m);
      if (S == null) continue;
      const price = priceOn(d, m);
      const acts = decide(pos, S, { daysLeft, strikes, px: (l) => price(l.type, l.strike) }, p);
      for (const a of acts) {
        await Promise.all(needs(pos, a).map((x) => load(x.type, x.strike)));
        const at = { day: d, time: timeOf(m) };
        if (apply(pos, a, priceOn(d, m), book, at)) month.events.push({ ...at, kind: a.kind, spot: S, text: a.reason });
        else month.events.push({ ...at, kind: 'skip', spot: S, text: a.reason + ' — not done: a strike has no price then' });
      }
    }
  }
  const SE = spotAt(E, MPD - 1);
  book.day = E;
  const atE = { day: E, time: '15:30' };
  const atExpiry = pos.legs.map((l) => ({ ...l }));
  settle(pos, SE, book, atE);
  month.events.push({ ...atE, kind: 'expiry', spot: SE, text: `Expiry at Nifty ${SE.toFixed(0)}: ` + atExpiry.map(legText).join(' · ') });

  // ETF P&L
  const bE = beesAt(E, MPD - 1) || (b0 ? b0 * (SE / S0) : null);
  if (b0 && bE) {
    etf.monthly += etf.qtyMonthly * (bE - b0) - etfCost(etf.qtyMonthly * bE, false, etfSlip);
    const from = once ? once.last : b0;
    etf.once += onceOut.qty * (bE - from);
    onceOut = { ...onceOut, last: bE, lastSpot: SE };
    etf.qtyOnce = onceOut.qty;
    etf.bees0 = b0;
    etf.beesE = bE;
  }
  Object.assign(month, {
    ok: true,
    spot0: S0,
    spotE: SE,
    move: ((SE - S0) / S0) * 100,
    finalLegs: atExpiry,
    closed: pos.closed,
    adjustments: month.events.filter((e) => !['entry', 'expiry', 'skip'].includes(e.kind)).length,
    gross: Math.round(book.cash),
    costs: Math.round(book.costs),
    opt: Math.round(book.cash - book.costs),
    ...(({ call, put }) => ({ callPnl: call, putPnl: put }))(splitPnl(pos.closed, book)),
    etfOnce: Math.round(etf.once),
    etfMonthly: Math.round(etf.monthly),
    etf,
  });
  month.withOnce = month.opt + month.etfOnce;
  month.withMonthly = month.opt + month.etfMonthly;
  return { month, once: onceOut };
}

const legText = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} ${l.type} @${l.entry.toFixed(1)}`;

// Totals and risk numbers per series of monthly P&L: opt (options alone), withOnce / withMonthly (with the ETF),
// hold (the ETF bought once, alone).
function summarize(months, units) {
  const ok = months.filter((m) => m.ok);
  const stat = (key) => {
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (const m of ok) {
      eq += m[key];
      peak = Math.max(peak, eq);
      dd = Math.min(dd, eq - peak);
    }
    const vals = ok.map((m) => m[key]);
    return {
      total: Math.round(eq),
      avg: ok.length ? Math.round(eq / ok.length) : 0,
      win: vals.filter((v) => v > 0).length,
      worst: vals.length ? Math.min(...vals) : 0,
      best: vals.length ? Math.max(...vals) : 0,
      maxDD: Math.round(dd),
    };
  };
  const invested = ok[0] ? ok[0].spot0 * units : 0;
  const years = ok.length / 12;
  const s = {
    months: ok.length,
    skipped: months.filter((m) => !m.ok).map((m) => ({ expiry: m.expiry, why: m.skip })),
    invested: Math.round(invested),
    opt: stat('opt'),
    call: stat('callPnl'),
    put: stat('putPnl'),
    withOnce: stat('withOnce'),
    withMonthly: stat('withMonthly'),
    hold: stat('etfOnce'),
    adjustments: ok.reduce((n, m) => n + m.adjustments, 0),
    costs: ok.reduce((n, m) => n + m.costs, 0),
    from: ok[0]?.entry?.day || null,
    to: ok[ok.length - 1]?.expiry || null,
  };
  for (const k of ['opt', 'call', 'put', 'withOnce', 'withMonthly', 'hold']) s[k].annPct = invested && years ? (s[k].total / invested / years) * 100 : 0;
  // by the month's direction (Nifty from entry to expiry)
  const bucket = (f) => {
    const ms = ok.filter(f);
    const sum = (k) => ms.reduce((n, m) => n + m[k], 0);
    return {
      n: ms.length,
      opt: sum('opt'),
      call: sum('callPnl'),
      put: sum('putPnl'),
      withOnce: sum('withOnce'),
      withMonthly: sum('withMonthly'),
      hold: sum('etfOnce'),
    };
  };
  s.byMove = { up: bucket((m) => m.move > 2), flat: bucket((m) => Math.abs(m.move) <= 2), down: bucket((m) => m.move < -2) };
  return s;
}

// ---------- the study: which adjustment rule, when ----------
// Every variant on the same months; the table on the Backtest tab (what "with / without adjustments" and the
// recommended rule come from).
const STUDY = [
  ['none', 'No adjustments', { adj: { on: false } }],
  ['move1', 'Roll sold strikes at a 1 % move', { adj: { movePct: 1 } }],
  ['move15', 'Roll sold strikes at a 1.5 % move', { adj: { movePct: 1.5 } }],
  ['move2', 'Roll sold strikes at a 2 % move', { adj: { movePct: 2 } }],
  ['move3', 'Roll sold strikes at a 3 % move', { adj: { movePct: 3 } }],
  ['move15h', '1.5 % move, checked hourly', { adj: { movePct: 1.5, check: 'hourly' } }],
  ['move15nc', '1.5 % move, sold puts may pass the bought puts', { adj: { movePct: 1.5, capPut: false } }],
  ['move15l0', '1.5 % move, also in the last 3 days', { adj: { movePct: 1.5, lastDays: 0 } }],
  ['decay35', 'Roll a sold leg at 35 % of its premium', { adj: { trigger: 'decay', decayPct: 35 } }],
  ['decay50', 'Roll a sold leg at 50 % of its premium', { adj: { trigger: 'decay', decayPct: 50 } }],
  ['all15', 'Move the whole spread / butterfly at 1.5 %', { adj: { movePct: 1.5, legs: 'all' } }],
  ['all1', 'Move the whole spread / butterfly at 1 %', { adj: { movePct: 1, legs: 'all' } }],
  ['all2', 'Move the whole spread / butterfly at 2 %', { adj: { movePct: 2, legs: 'all' } }],
  ['all3', 'Move the whole spread / butterfly at 3 %', { adj: { movePct: 3, legs: 'all' } }],
  ['allDecay35', 'Move the whole spread / butterfly at 35 % premium', { adj: { trigger: 'decay', decayPct: 35, legs: 'all' } }],
  ['upRoll', 'Up only: call ratio rolled up at the sold strike', { adj: { on: false }, up: { mode: 'roll' } }],
  ['upRoll100', 'Up only: call ratio rolled up 100 pts over the sold strike', { adj: { on: false }, up: { mode: 'roll', buffer: 100 } }],
  ['upHedge', 'Up only: buy a call 200 pts over the sold strike', { adj: { on: false }, up: { mode: 'hedge' } }],
  ['upBuy', 'Up only: buy one sold call back at its strike', { adj: { on: false }, up: { mode: 'buyBack' } }],
  ['move15upRoll', '1.5 % rolls + call ratio rolled up', { adj: { movePct: 1.5 }, up: { mode: 'roll' } }],
  ['move15upBuy', '1.5 % rolls + buy one sold call back', { adj: { movePct: 1.5 }, up: { mode: 'buyBack' } }],
  ['move15upHedge', '1.5 % rolls + buy a call 200 over the sold strike', { adj: { movePct: 1.5 }, up: { mode: 'hedge' } }],
  ['ratio11', 'Sell 1 call instead of 2 (1 × 1 spread), no rolls', { adj: { on: false }, ce: { sell: 1 } }],
  ['ratio11move2', 'Sell 1 call instead of 2, rolls at 2 %', { ce: { sell: 1 } }],
  ['all15upHedge', 'Whole spread at 1.5 % + buy a call 200 over the sold strike', { adj: { movePct: 1.5, legs: 'all' }, up: { mode: 'hedge' } }],
];
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(a[k] || {}), ...v } : v;
  return out;
};

async function runMccStudy(data, base = {}, range = {}, { onProgress = () => {}, stopped = () => false } = {}) {
  const rows = [];
  for (let i = 0; i < STUDY.length; i++) {
    if (stopped()) break;
    const [id, label, over] = STUDY[i];
    const params = deepMerge({ ...merge(base), adj: { ...DEFAULTS.adj }, up: { ...DEFAULTS.up } }, over);
    const r = await runMcc(data, params, range, { onProgress: (x) => onProgress({ phase: label, done: i, total: STUDY.length, inner: x }), stopped });
    rows.push({
      id,
      label,
      params: r.params,
      summary: r.summary,
      months: r.months.map((m) => ({
        expiry: m.expiry,
        ok: m.ok,
        move: m.move,
        opt: m.opt,
        callPnl: m.callPnl,
        putPnl: m.putPnl,
        withOnce: m.withOnce,
        withMonthly: m.withMonthly,
        adjustments: m.adjustments,
      })),
    });
  }
  onProgress({ phase: 'Done', done: STUDY.length, total: STUDY.length });
  return { at: Date.now(), rows };
}

// ---------- model path (Strategy & rules › Month by month) ----------
// Nifty moves pct % over `months` months (the same % each month), optionally zig-zagging about one typical week's move
// (weekly swings); every month is entered afresh on day 0, priced by Black-Scholes at iv %, rolled by decide() at each
// day's close and settled on day 21. Run with the given adjustments and without any. A model, not a forecast.
const MODEL_DAYS = 21;
function modelPath({ S0 = 24000, pct = 10, months = 12, iv = 13, swings = true } = {}) {
  const per = Math.pow(1 + pct / 100, 1 / months);
  const amp = (iv / 100) * Math.sqrt(5 / 252); // one week's typical move, as a fraction
  const out = [];
  let S = S0;
  for (let m = 0; m < months; m++) {
    const days = [];
    for (let d = 0; d <= MODEL_DAYS; d++) {
      const trend = S * Math.pow(per, d / MODEL_DAYS);
      // four swings a month, back to the trend on day 0 and on the expiry day
      days.push(Math.round(trend * (1 + (swings ? amp * Math.sin((2 * Math.PI * d) / (MODEL_DAYS / 4)) : 0)) * 100) / 100);
    }
    out.push(days);
    S = days[MODEL_DAYS];
  }
  return out;
}
function runMccModel(params = {}, opts = {}) {
  const { bsm } = require('../lib/pricing');
  const base = merge(params);
  const iv = (opts.iv ?? 13) / 100;
  const path = modelPath(opts);
  const lot = base.lotSize;
  const run = (p) => {
    const months = [];
    for (const days of path) {
      const S0 = days[0];
      const strikes = [];
      for (let k = Math.floor((S0 * 0.6) / STEP) * STEP; k <= S0 * 1.4; k += STEP) strikes.push(k);
      const priceAt = (S, left) => (type, K) =>
        left <= 0 ? Math.max(0, type === 'CE' ? S - K : K - S) : Math.max(0.05, bsm(S, K, left / 252, iv, type === 'CE'));
      const book = {
        slip: p.costs.slipPct / 100,
        brokerage: p.costs.brokerage,
        taxes: p.costs.taxes,
        lot,
        day: null,
        cash: 0,
        costs: 0,
        costsBy: { CE: 0, PE: 0 },
      };
      const pos = newPosition('model', S0);
      openLegs(pos, legsAt(S0, p, strikes), priceAt(S0, MODEL_DAYS), book, { day: 0 });
      const events = [];
      for (let d = 1; d < MODEL_DAYS; d++) {
        const S = days[d];
        const px = priceAt(S, MODEL_DAYS - d);
        for (const a of decide(pos, S, { daysLeft: MODEL_DAYS - d, strikes, px: (l) => px(l.type, l.strike) }, p))
          if (apply(pos, a, px, book, { day: d })) events.push({ day: d, kind: a.kind, spot: S, text: a.reason });
      }
      const SE = days[MODEL_DAYS];
      const held = pos.legs.map((l) => ({ ...l }));
      settle(pos, SE, book, { day: MODEL_DAYS });
      const { call, put } = splitPnl(pos.closed, book);
      const etf = Math.round(lot * p.lots * (SE - S0)); // NIFTYBEES = Nifty ÷ 100, 65 × lots × 100 units
      const opt = Math.round(book.cash - book.costs);
      months.push({ spot0: S0, spotE: SE, opt, callPnl: call, putPnl: put, etf, total: opt + etf, adjustments: events.length, events, held });
    }
    return months;
  };
  const off = { ...base, adj: { ...base.adj, on: false }, up: { ...base.up, mode: 'none' } };
  return { path, withAdj: run(base), without: run(off), params: base };
}

module.exports = {
  modelPath,
  runMccModel,
  splitPnl,
  DEFAULTS,
  STUDY,
  CHECK_MINS,
  merge,
  deepMerge,
  atmOf,
  snap,
  legsAt,
  newPosition,
  decide,
  needs,
  apply,
  openLegs,
  settle,
  payoffAt,
  etfCost,
  fill,
  runMcc,
  runMccStudy,
  summarize,
  timeOf,
};
