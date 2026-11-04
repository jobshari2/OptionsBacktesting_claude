// Trading Ideas › Strategy lab: try an options structure on every monthly (or weekly) series of the history, the same
// way the Modified covered call is tested (entered at 09:30 on the series' first trading day, held to its expiry,
// 0.5 % slippage, ₹20 an order, taxes by date), but options only and with the structure written as legs relative to
// ATM, so a new idea is a few numbers rather than new code. The presets are the downside ideas worked out from the
// Modified covered call (bt/mcc.js): its NIFTYBEES is what loses when Nifty falls, so they drop it and keep or flip the
// option parts. Optional: a trend filter (only enter when Nifty is under its N-day average) and a whole-position
// profit target / stop checked at 15:00. Shared by the backtest and the compare run (server.js /api/lab/*).
const { MPD, addDays } = require('./data');
const M = require('./mcc');

const STEP = 50;

// side +1 = buy, −1 = sell; off = points from ATM (Nifty rounded to 50); lots per 1 lot of the strategy.
const PRESETS = [
  {
    id: 'bearCombo',
    name: 'Bear spread combo',
    tag: 'Recommended',
    legs: [
      { type: 'PE', side: 1, off: 0, lots: 1 },
      { type: 'PE', side: -1, off: -300, lots: 1 },
      { type: 'CE', side: -1, off: 100, lots: 1 },
      { type: 'CE', side: 1, off: 300, lots: 1 },
    ],
    idea: 'Buy the ATM put and sell the put 300 under it (a bear put spread), paid for by selling the call 100 over ATM and buying the one 300 over it (a bear call spread). Profits as Nifty falls, up to about 300 points; a rally costs at most the call spread’s width less the credit. Four legs, defined risk both ways, no NIFTYBEES.',
  },
  {
    id: 'bearPut',
    name: 'Bear put spread',
    legs: [
      { type: 'PE', side: 1, off: 0, lots: 1 },
      { type: 'PE', side: -1, off: -400, lots: 1 },
    ],
    idea: 'The simplest downside trade: two legs, the debit is the most it can lose, pays up to 400 points less the debit when Nifty falls through the sold strike. Loses the debit in flat and rising months (time decay works against it).',
  },
  {
    id: 'bearCall',
    name: 'Bear call spread',
    legs: [
      { type: 'CE', side: -1, off: 100, lots: 1 },
      { type: 'CE', side: 1, off: 400, lots: 1 },
    ],
    idea: 'Sell a call over the market, buy one further up: keeps the credit when Nifty falls or stays put. The profit is small and capped (the credit) however far Nifty falls; it earns from time decay, not from the fall.',
  },
  {
    id: 'putFly',
    name: 'Put 2-3-1 butterfly (MCC’s put side)',
    legs: [
      { type: 'PE', side: 1, off: -100, lots: 2 },
      { type: 'PE', side: -1, off: -300, lots: 3 },
      { type: 'PE', side: 1, off: -400, lots: 1 },
    ],
    idea: 'The Modified covered call’s insurance on its own: pays most when Nifty expires near the sold strike (300 under ATM), keeps about 300 points below the wing, costs little. A moderate fall, not a crash, is what it is built for.',
  },
  {
    id: 'putBack',
    name: 'Put ratio backspread 1×2',
    legs: [
      { type: 'PE', side: -1, off: -100, lots: 1 },
      { type: 'PE', side: 1, off: -400, lots: 2 },
    ],
    idea: 'Sell one put near the money, buy two further down for about the same money: little lost if Nifty rises, a large gain in a crash, the worst result if Nifty expires at the bought strike. The crash trade.',
  },
  {
    id: 'mccOpts',
    name: 'MCC options alone (reference)',
    tag: 'Reference',
    legs: [
      { type: 'CE', side: 1, off: 100, lots: 1 },
      { type: 'CE', side: -1, off: 200, lots: 2 },
      { type: 'PE', side: 1, off: -100, lots: 2 },
      { type: 'PE', side: -1, off: -300, lots: 3 },
      { type: 'PE', side: 1, off: -400, lots: 1 },
    ],
    idea: 'The Modified covered call’s options at its fixed distances, without NIFTYBEES: one call is naked, so a rally loses without limit. Here only to compare against.',
  },
];

const DEFAULTS = {
  preset: 'bearCombo',
  legs: PRESETS[0].legs,
  lots: 1,
  lotSize: 65,
  cycle: 'monthly', // 'monthly': monthly expiry to monthly expiry; 'weekly': every expiry to the next
  entryMin: 15, // minutes after 09:15 on the series' first trading day (09:30)
  // 'always'; 'belowSma': enter only when Nifty at entry is under the average of the last `sma` daily closes (a
  // downtrend); 'aboveSma': only over it (to see the other half)
  filter: { mode: 'always', sma: 20 },
  // whole position, checked once a day at 15:00 (not on the expiry day): out at targetPct % of the most it can make,
  // or at stopPct % of the most it can lose (0 = off; ignored where that maximum is unlimited)
  exit: { targetPct: 0, stopPct: 0 },
  costs: { slipPct: 0.5, brokerage: 20, taxes: true },
};
const CHECK_MIN = 345; // 15:00

function merge(p = {}) {
  const out = { ...DEFAULTS, ...p };
  for (const k of ['filter', 'exit', 'costs']) out[k] = { ...DEFAULTS[k], ...(p[k] || {}) };
  if (!p.legs && p.preset) out.legs = PRESETS.find((x) => x.id === p.preset)?.legs || DEFAULTS.legs;
  out.legs = cleanLegs(out.legs);
  return out;
}

// Legs as typed on the page: whole lots, known types, offsets on the 50-point grid; at most 8.
function cleanLegs(legs) {
  return (Array.isArray(legs) ? legs : [])
    .map((l) => ({
      type: l?.type === 'CE' ? 'CE' : 'PE',
      side: Number(l?.side) < 0 ? -1 : 1,
      off: Math.round((Number(l?.off) || 0) / STEP) * STEP,
      lots: Math.max(0, Math.min(20, Math.round(Number(l?.lots) || 0))),
    }))
    .filter((l) => l.lots > 0)
    .slice(0, 8);
}

// The opening legs for Nifty at S, in the shape mcc.openLegs takes.
function legsAt(S, p, strikes) {
  const A = M.atmOf(S);
  return p.legs.map((l, i) => ({ role: 'L' + i, type: l.type, side: l.side, strike: M.snap(strikes, A + l.off), lots: l.lots * p.lots }));
}

// Expiry profile of legs with entry premiums (₹, before costs): the most it can make and lose and where it breaks
// even. Open-ended (±Infinity) when the payoff still slopes past the outermost strikes: net calls above the top
// strike, net puts below the lowest (bounded only by Nifty 0).
function profile(legs, lot) {
  if (!legs.length) return { maxProfit: 0, maxLoss: 0, breakevens: [], upSlope: 0, downSlope: 0 };
  const ks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const at = (x) => M.payoffAt(legs, x, lot);
  const upSlope = legs.filter((l) => l.type === 'CE').reduce((s, l) => s + l.side * l.lots * lot, 0); // ₹ per point above the top strike
  const downSlope = legs.filter((l) => l.type === 'PE').reduce((s, l) => s + l.side * l.lots * lot, 0); // ₹ per point fallen under the lowest
  const pts = [0, ...ks, ks[ks.length - 1] + 1000].map((x) => [x, at(x)]);
  const vals = pts.map((x) => x[1]);
  // a net long put tail is bounded only by Nifty 0: open-ended for every practical purpose (and for a target %)
  const maxProfit = upSlope > 0 || downSlope > 0 ? Infinity : Math.max(...vals);
  const maxLoss = upSlope < 0 || downSlope < 0 ? -Infinity : Math.min(...vals);
  const breakevens = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if ((y0 < 0 && y1 >= 0) || (y0 >= 0 && y1 < 0)) breakevens.push(Math.round(x0 + ((x1 - x0) * -y0) / (y1 - y0)));
  }
  if (upSlope !== 0) {
    const [xl, yl] = pts[pts.length - 1];
    const x = xl - yl / upSlope;
    if (x > xl) breakevens.push(Math.round(x));
  }
  return { maxProfit, maxLoss, breakevens, upSlope, downSlope };
}

// Capital the position ties up, for % a year: its maximum loss when that is defined, else a short future's margin
// (~12 % of the notional) per net sold lot on the open side plus the loss up to there.
function capitalFor(prof, S, lot, legs) {
  if (Number.isFinite(prof.maxLoss)) return Math.max(1, -prof.maxLoss);
  const naked = Math.max(-Math.min(prof.upSlope, 0), -Math.min(prof.downSlope, 0)) / lot || legs.reduce((n, l) => n + (l.side < 0 ? l.lots : 0), 0);
  return Math.round(0.12 * S * lot * naked);
}

// Series to trade: { P, E } pairs (previous expiry, this expiry) in the range.
async function seriesOf(data, p, range) {
  const cal = await data.expiryCalendar();
  const list = (p.cycle === 'weekly' ? [...cal.expired] : [...cal.monthly].filter((e) => cal.expiredSet.has(e))).sort();
  const start = data.indexStart() || '2000-01-01';
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const E = list[i];
    const P = list[i - 1];
    if (range.from && E < range.from) continue;
    if (range.to && E > range.to) continue;
    if (addDays(P, 1) < start) continue;
    out.push({ P, E });
  }
  return out;
}

const closeOf = (data, d) => data.spotDay(d)?.[MPD * 4 - 1] ?? null;

// The trend filter: { pass, sma, why } for the series entered on day d0 at Nifty S0.
async function filterCheck(data, p, d0, S0) {
  const mode = p.filter.mode;
  if (mode !== 'belowSma' && mode !== 'aboveSma') return { pass: true };
  const n = Math.max(2, Math.min(200, Math.round(p.filter.sma) || 20));
  let days;
  try {
    days = (await data.loadIndex(addDays(d0, -Math.ceil(n * 1.6) - 10), addDays(d0, -1))).filter((d) => d < d0);
  } catch {
    return { pass: true, why: 'no earlier Nifty history for the filter: entered anyway' };
  }
  const closes = days
    .slice(-n)
    .map((d) => closeOf(data, d))
    .filter((v) => v > 0);
  if (closes.length < n) return { pass: true, why: `fewer than ${n} earlier closes: entered anyway` };
  const sma = closes.reduce((a, b) => a + b, 0) / n;
  const below = S0 < sma;
  const pass = mode === 'belowSma' ? below : !below;
  return { pass, sma, why: `Nifty ${S0.toFixed(0)} ${below ? 'under' : 'over'} its ${n}-day average ${sma.toFixed(0)}` };
}

// ---------- backtest ----------
async function runLab(data, params = {}, range = {}, { onProgress = () => {}, stopped = () => false } = {}) {
  const p = merge(params);
  if (!p.legs.length) throw new Error('The strategy has no legs');
  const series = await seriesOf(data, p, range);
  const months = [];
  for (let i = 0; i < series.length; i++) {
    if (stopped()) break;
    onProgress({ phase: 'Simulating', done: i, total: series.length });
    months.push(await runSeries(data, p, series[i]));
  }
  onProgress({ phase: 'Done', done: series.length, total: series.length });
  return { at: Date.now(), params: p, months, summary: summarize(months, p) };
}

async function runSeries(data, p, { P, E }) {
  const lot = p.lotSize;
  const month = { expiry: E, prevExpiry: P, events: [], ok: false };
  const days = await data.loadIndex(addDays(P, 1), E);
  if (!days.length || days[days.length - 1] !== E) {
    month.skip = 'Nifty history missing for the series';
    return month;
  }
  const d0 = days[0];
  const spotAt = (d, m) => data.spotDay(d)?.[m * 4 + 3] ?? null;
  const S0 = spotAt(d0, p.entryMin);
  if (!(S0 > 0)) {
    month.skip = 'No Nifty price at entry';
    return month;
  }
  const SE = spotAt(E, MPD - 1);
  if (!(SE > 0)) {
    month.skip = 'No Nifty close on the expiry day';
    return month;
  }
  month.spot0 = S0;
  month.spotE = SE;
  month.move = ((SE - S0) / S0) * 100;
  const f = await filterCheck(data, p, d0, S0);
  if (!f.pass) {
    // sat out: no options, but NIFTYBEES (the "+ NIFTYBEES" view) is still held through the series
    const long = Math.round((SE - S0) * p.lotSize * p.lots);
    Object.assign(month, { skip: 'Filter: ' + f.why + ' — stayed out', filtered: true, opt: 0, long, short: -long, hedged: long });
    return month;
  }
  let info;
  try {
    info = await data.contracts(E);
  } catch (e) {
    month.skip = 'No option contracts: ' + e.message;
    return month;
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
    const v = data.optionDay(c, d)?.[m * 4 + 3];
    return v > 0 ? v / 100 : null;
  };
  const legs = legsAt(S0, p, strikes);
  await Promise.all(legs.map((l) => load(l.type, l.strike)));
  const book = { slip: p.costs.slipPct / 100, brokerage: p.costs.brokerage, taxes: p.costs.taxes, lot, day: d0, cash: 0, costs: 0, costsBy: { CE: 0, PE: 0 } };
  const pos = M.newPosition(E, S0);
  const at0 = { day: d0, time: M.timeOf(p.entryMin) };
  if (!M.openLegs(pos, legs, priceOn(d0, p.entryMin), book, at0)) {
    const miss = legs.filter((l) => !(priceOn(d0, p.entryMin)(l.type, l.strike) > 0)).map((l) => l.strike + l.type);
    month.skip = 'No price at entry for ' + miss.join(', ');
    return month;
  }
  const prof = profile(pos.legs, lot);
  month.entry = { ...at0, spot: S0, legs: pos.legs.map((l) => ({ ...l })), net: Math.round(book.cash), filter: f.why || null };
  month.maxProfit = Number.isFinite(prof.maxProfit) ? Math.round(prof.maxProfit) : null;
  month.maxLoss = Number.isFinite(prof.maxLoss) ? Math.round(prof.maxLoss) : null;
  month.capital = capitalFor(prof, S0, lot, pos.legs);
  month.events.push({
    ...at0,
    kind: 'entry',
    spot: S0,
    text:
      `Opened ${pos.legs.map(legText).join(' · ')} · net ${book.cash >= 0 ? 'credit' : 'debit'} ₹${Math.abs(Math.round(book.cash)).toLocaleString('en-IN')}` +
      (f.why ? ` · ${f.why}` : ''),
  });

  // whole-position target / stop at 15:00 (the expiry day settles instead)
  const tgt = p.exit.targetPct > 0 && month.maxProfit > 0 ? (month.maxProfit * p.exit.targetPct) / 100 : null;
  const stop = p.exit.stopPct > 0 && month.maxLoss < 0 ? (month.maxLoss * p.exit.stopPct) / 100 : null;
  let exited = null;
  if (tgt != null || stop != null) {
    for (const d of days.slice(0, -1)) {
      if (d === d0 && CHECK_MIN <= p.entryMin) continue;
      const px = priceOn(d, CHECK_MIN);
      const marks = pos.legs.map((l) => px(l.type, l.strike));
      if (marks.some((v) => !(v > 0))) continue;
      const mtm = pos.legs.reduce((s, l, i) => s + l.side * (marks[i] - l.entry) * l.lots * lot, 0);
      const hit = tgt != null && mtm >= tgt ? 'target' : stop != null && mtm <= stop ? 'stop' : null;
      if (!hit) continue;
      book.day = d;
      const at = { day: d, time: M.timeOf(CHECK_MIN) };
      const S = spotAt(d, CHECK_MIN);
      if (M.apply(pos, { close: pos.legs.map((l) => ({ id: l.id, lots: l.lots })), open: [] }, px, book, at)) {
        exited = { ...at, why: hit, spot: S };
        month.events.push({
          ...at,
          kind: hit,
          spot: S,
          text: `${hit === 'target' ? 'Profit target' : 'Stop'} reached: marked ₹${Math.round(mtm).toLocaleString('en-IN')} — every leg closed`,
        });
        break;
      }
    }
  }
  const held = pos.legs.map((l) => ({ ...l }));
  if (!exited) {
    book.day = E;
    const atE = { day: E, time: '15:30' };
    M.settle(pos, SE, book, atE);
    month.events.push({ ...atE, kind: 'expiry', spot: SE, text: `Expiry at Nifty ${SE.toFixed(0)}: ` + held.map(legText).join(' · ') });
  }
  const units = lot * p.lots;
  Object.assign(month, {
    ok: true,
    exit: exited,
    finalLegs: held,
    closed: pos.closed,
    gross: Math.round(book.cash),
    costs: Math.round(book.costs),
    opt: Math.round(book.cash - book.costs),
    // references for the same series: one lot of Nifty held (what the covered call's NIFTYBEES does), and sold
    long: Math.round((SE - S0) * units),
  });
  month.short = -month.long;
  month.hedged = month.opt + month.long; // the strategy laid over one lot of NIFTYBEES
  return month;
}

const legText = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} ${l.type} @${l.entry.toFixed(1)}`;

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
  const band = p.cycle === 'weekly' ? 1 : 2; // % move that makes a series "up" / "down"
  const bucket = (f) => {
    const ms = ok.filter(f);
    const sum = (k) => ms.reduce((n, m) => n + m[k], 0);
    return { n: ms.length, opt: sum('opt'), long: sum('long'), hedged: sum('hedged'), win: ms.filter((m) => m.opt > 0).length };
  };
  // the NIFTYBEES views run over every series with prices, the ones the filter sat out included (held through them)
  const held = months.filter((m) => m.ok || m.filtered);
  const capital = ok.length ? Math.max(...ok.map((m) => m.capital || 0)) : 0;
  const perYear = p.cycle === 'weekly' ? 52 : 12;
  const years = held.length / perYear; // calendar time, so a filter that sits out does not inflate the yearly rate
  const s = {
    series: months.length,
    months: ok.length,
    filtered: months.filter((m) => m.filtered).length,
    skipped: months.filter((m) => !m.ok && !m.filtered).map((m) => ({ expiry: m.expiry, why: m.skip })),
    opt: stat(ok, 'opt'),
    long: stat(held, 'long'),
    short: stat(held, 'short'),
    hedged: stat(held, 'hedged'),
    costs: ok.reduce((n, m) => n + m.costs, 0),
    exits: { target: ok.filter((m) => m.exit?.why === 'target').length, stop: ok.filter((m) => m.exit?.why === 'stop').length },
    capital,
    band,
    from: held[0] ? held[0].entry?.day || held[0].prevExpiry : null,
    to: held[held.length - 1]?.expiry || null,
  };
  s.opt.annPct = capital && years ? (s.opt.total / capital / years) * 100 : 0;
  s.byMove = { up: bucket((m) => m.move > band), flat: bucket((m) => Math.abs(m.move) <= band), down: bucket((m) => m.move < -band) };
  return s;
}

// ---------- compare: every preset on the same series, always in and with the trend filter ----------
async function runLabCompare(data, base = {}, range = {}, { onProgress = () => {}, stopped = () => false } = {}) {
  const b = merge(base);
  const runs = PRESETS.flatMap((x) => [
    { id: x.id, name: x.name, filter: 'always' },
    { id: x.id, name: x.name, filter: 'belowSma' },
  ]);
  const rows = [];
  for (let i = 0; i < runs.length; i++) {
    if (stopped()) break;
    const r = runs[i];
    const label = `${r.name}${r.filter === 'belowSma' ? ` · only under the ${b.filter.sma}-day average` : ''}`;
    const params = { ...b, preset: r.id, legs: PRESETS.find((x) => x.id === r.id).legs, filter: { ...b.filter, mode: r.filter } };
    const out = await runLab(data, params, range, { onProgress: (x) => onProgress({ phase: label, done: i, total: runs.length, inner: x }), stopped });
    rows.push({
      id: r.id,
      filter: r.filter,
      label,
      summary: out.summary,
      months: out.months.map((m) => ({ expiry: m.expiry, ok: m.ok, filtered: Boolean(m.filtered), move: m.move, opt: m.opt, long: m.long, hedged: m.hedged })),
    });
  }
  onProgress({ phase: 'Done', done: runs.length, total: runs.length });
  return { at: Date.now(), params: b, rows };
}

module.exports = { PRESETS, DEFAULTS, merge, cleanLegs, legsAt, profile, capitalFor, filterCheck, seriesOf, runLab, runLabCompare, summarize };
