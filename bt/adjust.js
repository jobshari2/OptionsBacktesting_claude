// Trading Ideas › Adjustments: the trade-adjustment rules of lib/adjladder.js (Catolico, "Trade adjustment basics")
// backtested on the Nifty option history, one series at a time like the Strategy lab: buy the ATM call (put when
// bearish) at 09:30 on the series' first trading day (or N trading days before its expiry), look at Nifty every hour /
// day / week, and whenever it has moved k standard deviations from the last decision point step the position one
// rung along the ladder (long call → vertical → butterfly → condor on a "+", → ratio → fly rolls on a "−") at that
// minute's real option prices, 0.5 % slippage, ₹20 an order, taxes by date; whatever is open is settled at
// intrinsic on the expiry. Every series is also run as the plain long call held to expiry, the trade the rules start
// from, so the adjustments can be judged against doing nothing. History only: nothing here trades.
const { MPD, addDays } = require('./data');
const M = require('./mcc');
const { seriesOf } = require('./lab');
const A = require('../lib/adjladder');

const DEFAULTS = {
  ...A.DEFAULTS,
  cycle: 'monthly', // 'monthly' (the PDF's front-month series) | 'weekly' (every expiry to the next)
  entryDays: 0, // 0 = the series' first trading day; N = N trading days before its expiry
  entryMin: 15, // 09:30
  exit: { stopRs: 0, targetRs: 0 }, // whole trade, ₹ (0 = off), checked with the rule
  costs: { slipPct: 0.5, brokerage: 20, taxes: true },
  lotSize: 65,
};
// minutes after 09:15 when Nifty is looked at
const CHECKS = { hourly: [60, 120, 180, 240, 300, 360], daily: [345], weekly: [345] };
const YEAR_MS = 365 * 86400_000;

function merge(p = {}) {
  const out = { ...DEFAULTS, ...A.merge(p) };
  for (const k of ['cycle', 'entryDays', 'entryMin', 'lotSize']) if (p[k] != null) out[k] = p[k];
  out.cycle = out.cycle === 'weekly' ? 'weekly' : 'monthly';
  out.entryDays = Math.max(0, Math.min(40, Math.round(Number(out.entryDays) || 0)));
  out.exit = { ...DEFAULTS.exit, ...(p.exit || {}) };
  out.costs = { ...DEFAULTS.costs, ...(p.costs || {}) };
  return out;
}

// Years from minute m of day d to the expiry's 15:30 (IST wall clock on both ends, so no time zone is needed).
const yearsLeft = (d, m, E) => Math.max(0, (Date.parse(E + 'T15:30:00Z') - (Date.parse(d + 'T09:15:00Z') + m * 60_000)) / YEAR_MS);
const signed = (legs) => legs.map((l) => ({ type: l.type, strike: l.strike, lots: l.side * l.lots, entry: l.entry }));
const tradeText = (t) => `${t.lots > 0 ? 'Buy' : 'Sell'} ${Math.abs(t.lots)}× ${t.strike} ${t.type}${t.px ? ' @' + t.px.toFixed(1) : ''}`;

// The trades of an adjustment as an mcc.apply() action: close opposite open legs first, open the rest.
function toAction(pos, tr) {
  const close = [];
  const open = [];
  for (const t of tr) {
    let left = Math.abs(t.lots);
    const side = Math.sign(t.lots);
    for (const l of pos.legs) {
      if (!left) break;
      if (l.type !== t.type || l.strike !== t.strike || l.side !== -side) continue;
      const n = Math.min(left, l.lots);
      close.push({ id: l.id, lots: n });
      left -= n;
    }
    if (left) open.push({ role: 'adj', type: t.type, side, strike: t.strike, lots: left });
  }
  return { close, open };
}

async function runAdjust(data, params = {}, range = {}, { onProgress = () => {}, stopped = () => false } = {}) {
  const p = merge(params);
  const series = (await seriesOf(data, p, range)).filter((s) => !range.only || s.E === range.only);
  const months = [];
  for (let i = 0; i < series.length; i++) {
    if (stopped()) break;
    onProgress({ phase: 'Simulating', done: i, total: series.length });
    months.push(await runSeries(data, p, series[i]));
  }
  onProgress({ phase: 'Done', done: series.length, total: series.length });
  return { at: Date.now(), params: p, range, months, summary: summarize(months, p) };
}

async function runSeries(data, p, { P, E }) {
  const lot = p.lotSize;
  const month = { expiry: E, prevExpiry: P, events: [], path: [], ok: false };
  const all = await data.loadIndex(addDays(P, 1), E);
  if (!all.length || all[all.length - 1] !== E) {
    month.skip = 'Nifty history missing for the series';
    return month;
  }
  const days = p.entryDays > 0 ? all.slice(Math.max(0, all.length - 1 - p.entryDays)) : all;
  const d0 = days[0];
  const spotAt = (d, m) => data.spotDay(d)?.[m * 4 + 3] ?? null;
  const S0 = spotAt(d0, p.entryMin);
  const SE = spotAt(E, MPD - 1);
  if (!(S0 > 0) || !(SE > 0)) {
    month.skip = S0 > 0 ? 'No Nifty close on the expiry day' : 'No Nifty price at entry';
    return month;
  }
  Object.assign(month, { spot0: S0, spotE: SE, move: ((SE - S0) / S0) * 100 });
  let info;
  try {
    info = await data.contracts(E);
  } catch (e) {
    month.skip = 'No option contracts: ' + e.message;
    return month;
  }
  const snap = (k) => M.snap(info.strikes, k);
  const type = p.bias === 'bear' ? 'PE' : 'CE';
  const call = type === 'CE';
  const loaded = new Map();
  const load = async (t, strike) => {
    const id = strike + t;
    if (loaded.has(id)) return loaded.get(id);
    let c = null;
    try {
      c = data.optionCached(E, strike, t, d0) || (await data.option(E, strike, t, d0));
    } catch {
      c = null;
    }
    loaded.set(id, c);
    return c;
  };
  const priceOn = (d, m) => (t, strike) => {
    const c = loaded.get(strike + t);
    if (!c) return null;
    const v = data.optionDay(c, d)?.[m * 4 + 3];
    return v > 0 ? v / 100 : null;
  };

  // entry: the ATM option, its implied volatility (the position's, fixed for the trigger as the PDF does) and the rung
  const K = snap(M.atmOf(S0));
  await load(type, K);
  const px0 = priceOn(d0, p.entryMin)(type, K);
  if (!(px0 > 0)) {
    month.skip = `No price at entry for ${K}${type}`;
    return month;
  }
  const T0 = yearsLeft(d0, p.entryMin, E);
  const iv = A.impliedVol(px0, S0, K, T0, call) || (data.vixDay?.(d0)?.[p.entryMin * 4 + 3] > 0 ? data.vixDay(d0)[p.entryMin * 4 + 3] / 100 : 0.13);
  const W = p.width > 0 ? p.width : A.autoWidth(S0, iv, T0, p.widthSigma);
  Object.assign(month, { K, W, iv, entryDay: d0 });

  const book = { slip: p.costs.slipPct / 100, brokerage: p.costs.brokerage, taxes: p.costs.taxes, lot, day: d0, cash: 0, costs: 0 };
  const pos = M.newPosition(E, S0);
  const at0 = { day: d0, time: M.timeOf(p.entryMin) };
  M.openLegs(pos, [{ role: 'L0', type, side: 1, strike: K, lots: p.lots }], () => px0, book, at0);
  // the plain long option held to expiry, from the same fill
  const base = { slip: book.slip, brokerage: book.brokerage, taxes: book.taxes, lot, day: d0, cash: 0, costs: 0 };
  const basePos = M.newPosition(E, S0);
  M.openLegs(basePos, [{ role: 'L0', type, side: 1, strike: K, lots: p.lots }], () => px0, base, at0);

  const st = { level: 0, ref: S0, quiet: 0 };
  let minL = 0;
  let maxL = 0;
  let nAdj = 0;
  const snapLegs = () => pos.legs.map((l) => ({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, entry: +l.entry.toFixed(2) }));
  const push = (ev) => {
    month.events.push({ ...ev, level: st.level, legs: snapLegs(), cash: Math.round(book.cash), costs: Math.round(book.costs) });
    return month.events.length - 1;
  };
  push({
    ...at0,
    kind: 'entry',
    spot: S0,
    text: `Bought ${p.lots}× ${K} ${type} @${pos.legs[0].entry.toFixed(1)} (IV ${(iv * 100).toFixed(1)} %, rung ${W} pts)`,
  });
  month.path.push([d0, p.entryMin, Math.round(S0), Math.round(S0), 0, 0]);

  let exited = null;
  const mins = CHECKS[p.frame];
  outer: for (let di = 0; di < days.length; di++) {
    const d = days[di];
    if (d === E && !p.expiryDay) break;
    if (p.frame === 'weekly' && (di === 0 || di % 5 !== 0) && d !== E) continue;
    for (const m of mins) {
      if (d === d0 && m <= p.entryMin) continue;
      const S = spotAt(d, m);
      if (!(S > 0)) continue;
      book.day = d;
      const T = yearsLeft(d, m, E);
      const at = { day: d, time: M.timeOf(m) };
      const px = priceOn(d, m);
      const legsNow = signed(pos.legs);
      // whole-trade stop / target on the marked P&L (realised + open legs at this minute's prices, after costs)
      if (p.exit.stopRs > 0 || p.exit.targetRs > 0) {
        const marks = pos.legs.map((l) => px(l.type, l.strike));
        if (marks.every((v) => v > 0)) {
          const pnl = book.cash - book.costs + pos.legs.reduce((s, l, i) => s + l.side * l.lots * lot * marks[i], 0);
          const hit = p.exit.targetRs > 0 && pnl >= p.exit.targetRs ? 'target' : p.exit.stopRs > 0 && pnl <= -p.exit.stopRs ? 'stop' : null;
          if (hit && M.apply(pos, { close: pos.legs.map((l) => ({ id: l.id, lots: l.lots })), open: [] }, px, book, at)) {
            exited = { ...at, why: hit, spot: S };
            const ei = push({
              ...at,
              kind: hit,
              spot: S,
              text: `${hit === 'target' ? 'Profit target' : 'Stop'}: trade marked ₹${Math.round(pnl).toLocaleString('en-IN')} — every leg closed`,
            });
            month.path.push([d, m, Math.round(S), Math.round(st.ref), 0, ei]);
            break outer;
          }
        }
      }
      const th = A.theta(legsNow, S, T, () => iv, lot);
      const locked = st.level >= 2 && book.cash - book.costs >= 0;
      const ref0 = st.ref;
      const dec = A.decide(st, S, p, { iv, theta: th, locked });
      let ei = null;
      if (dec.kind === 'adjust') {
        const target = A.legsFor(dec.to, K, W, p, snap);
        const tr = A.trades(legsNow, target);
        await Promise.all(tr.map((t) => load(t.type, t.strike)));
        const a = toAction(pos, tr);
        const trPx = tr.map((t) => ({ ...t, px: px(t.type, t.strike) }));
        if (M.apply(pos, a, px, book, at)) {
          const from = st.level;
          Object.assign(st, { level: dec.to, ref: S, quiet: 0 });
          nAdj++;
          minL = Math.min(minL, st.level);
          maxL = Math.max(maxL, st.level);
          ei = push({
            ...at,
            kind: 'adjust',
            dir: dec.dir,
            stall: Boolean(dec.stall),
            from,
            to: dec.to,
            spot: S,
            trades: trPx,
            text: `${dec.stall ? 'Stalled' : dec.dir > 0 ? '+' : '−'} ${Math.abs(Math.round(dec.move))} pts (trigger ${Math.round(dec.trig)}): ${A.nodeName(from, p.bias)} → ${A.nodeName(dec.to, p.bias)} · ${trPx.map(tradeText).join(' · ')}`,
          });
        } else {
          const miss = trPx.filter((t) => !(t.px > 0)).map((t) => t.strike + t.type);
          ei = push({
            ...at,
            kind: 'skip',
            spot: S,
            text: `Trigger (${dec.dir > 0 ? '+' : '−'}${Math.abs(Math.round(dec.move))} pts) but no price for ${miss.join(', ')}: not adjusted`,
          });
          st.quiet++;
        }
      } else if (dec.kind === 'hold') {
        Object.assign(st, { ref: S, quiet: 0 });
        ei = push({ ...at, kind: 'hold', dir: dec.dir, spot: S, text: `${dec.dir > 0 ? '+' : '−'} ${Math.abs(Math.round(dec.move))} pts: ${dec.why}` });
      } else if (dec.kind === 'close') {
        if (M.apply(pos, { close: pos.legs.map((l) => ({ id: l.id, lots: l.lots })), open: [] }, px, book, at)) {
          exited = { ...at, why: 'ladder', spot: S };
          ei = push({ ...at, kind: 'close', dir: dec.dir, spot: S, text: `${dec.dir > 0 ? '+' : '−'} ${Math.abs(Math.round(dec.move))} pts: ${dec.why}` });
          month.path.push([d, m, Math.round(S), Math.round(ref0), Math.round(dec.trig), ei]);
          break outer;
        }
        st.quiet++;
      } else st.quiet++;
      month.path.push([d, m, Math.round(S), Math.round(ref0), Math.round(dec.trig), ei]);
    }
  }
  const held = signed(pos.legs);
  if (!exited) {
    book.day = E;
    const atE = { day: E, time: '15:30' };
    M.settle(pos, SE, book, atE);
    push({
      ...atE,
      kind: 'expiry',
      spot: SE,
      text: `Expiry at Nifty ${SE.toFixed(0)}: ${held.length ? held.map((l) => `${l.lots > 0 ? '+' : ''}${l.lots}× ${l.strike}`).join(' ') + ' settled at intrinsic' : 'nothing open'}`,
    });
    month.path.push([E, MPD - 1, Math.round(SE), Math.round(st.ref), 0, month.events.length - 1]);
  }
  base.day = E;
  M.settle(basePos, SE, base, { day: E, time: '15:30' });
  Object.assign(month, {
    ok: true,
    exit: exited,
    finalLevel: st.level,
    minLevel: minL,
    maxLevel: maxL,
    adjustments: nAdj,
    closed: pos.closed.map((c) => ({
      type: c.type,
      strike: c.strike,
      side: c.side,
      lots: c.lots,
      entry: +c.entry.toFixed(2),
      exit: +c.exit.toFixed(2),
      pnl: Math.round(c.pnl),
    })),
    gross: Math.round(book.cash),
    costs: Math.round(book.costs),
    opt: Math.round(book.cash - book.costs),
    base: Math.round(base.cash - base.costs),
    baseCosts: Math.round(base.costs),
  });
  return month;
}

function stat(ok, key) {
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
}

function summarize(months, p) {
  const ok = months.filter((m) => m.ok);
  const band = p.cycle === 'weekly' ? 1 : 2;
  const bucket = (f) => {
    const ms = ok.filter(f);
    const sum = (k) => ms.reduce((n, m) => n + m[k], 0);
    return { n: ms.length, opt: sum('opt'), base: sum('base'), win: ms.filter((m) => m.opt > 0).length, better: ms.filter((m) => m.opt > m.base).length };
  };
  const levels = {};
  for (const m of ok) levels[m.finalLevel] = (levels[m.finalLevel] || 0) + 1;
  const s = {
    series: months.length,
    months: ok.length,
    skipped: months.filter((m) => !m.ok).map((m) => ({ expiry: m.expiry, why: m.skip })),
    opt: stat(ok, 'opt'),
    base: stat(ok, 'base'),
    costs: ok.reduce((n, m) => n + m.costs, 0),
    better: ok.filter((m) => m.opt > m.base).length,
    adjustments: ok.reduce((n, m) => n + m.adjustments, 0),
    closes: ok.filter((m) => m.exit?.why === 'ladder').length,
    exits: { target: ok.filter((m) => m.exit?.why === 'target').length, stop: ok.filter((m) => m.exit?.why === 'stop').length },
    levels,
    band,
    from: ok[0]?.entryDay || null,
    to: ok[ok.length - 1]?.expiry || null,
  };
  s.byMove = { up: bucket((m) => m.move > band), flat: bucket((m) => Math.abs(m.move) <= band), down: bucket((m) => m.move < -band) };
  return s;
}

module.exports = { DEFAULTS, CHECKS, merge, yearsLeft, toAction, runAdjust, runSeries, summarize };
