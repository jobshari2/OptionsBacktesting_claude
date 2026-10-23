// Option surges (Trading Ideas › Option surges): Nifty options whose premium at least doubled from a low, found in the
// cached 1-minute history of expired contracts (bt-cache/opt), each tied to what moved it, and a backtest of trading
// them without hindsight.
//
//   scanSurges     every surge in the cache. An intraday surge is a close at least `minMult` × the lowest close of the
//                  same session so far (the low at least ₹minBase); a multi-day surge measures from the lowest close of
//                  the previous `swingDays` sessions instead. The surge runs on to its peak until the price gives back
//                  `drop` of it (or the session / contract ends). For each: Nifty, VIX and implied volatility at the low
//                  and at the peak, the gain split into the part the Nifty move explains (Black-Scholes at the low's IV)
//                  and the part only a higher IV explains, days to expiry, moneyness, the session's gap and range, and
//                  macro days from a small calendar.
//   backtestSurge  the trade a watcher could have made: buy when a contract is up `trigger` × its session low (the
//                  surge is still under way, its end unknown), next minute's open + slippage, out at a target / stop /
//                  trailing stop / time. Every contract in the cache is watched, not only the ones that surged, so the
//                  result carries the many doublings that never tripled. A "lottery" mode buys cheap options at a set
//                  time instead (positioning before a surge, no signal).
// Prices in the cache are Int32 paise, [open, high, low, close] per minute, -1 = no trade that minute.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Costs = require('../lib/costs');
const { bsm, RATE } = require('../lib/pricing');
const { MPD, OPEN_MIN, addDays } = require('./data');
const { flowStats } = require('./surgevol');

// multi-day surges are kept from swingMult × their low and within swingDte days of expiry (far months double often and
// slowly: thousands of them would bury the rest)
// minBase: the lowest option price (₹) a surge may start from; the screen's "Minimum option price" setting
const SCAN_DEFAULTS = { minBase: 4, minMult: 2, drop: 0.4, swingDays: 3, swingMult: 3, swingDte: 14 };
const BT_DEFAULTS = {
  mode: 'trigger', // trigger | lottery
  trigger: 2, // buy when the close is this many times the session's low
  minBase: 4, // ₹: the session low must be at least this (skips penny options)
  maxBase: 0, // ₹: ... and at most this (0 = no limit)
  sides: 'both', // both | CE | PE
  dteMax: 1, // only contracts this many calendar days or fewer from expiry
  entryFrom: '09:30',
  entryTo: '14:30',
  confirm: 0.2, // % Nifty must have moved in the option's favour since its low (0 = no check)
  premium: 10, // lottery: buy the option priced nearest this
  lotteryAt: '09:30', // lottery: entry time
  targetMult: 3, // exit when the close reaches this many times the low (0 = off)
  targetPct: 0, // ... or this % over the entry price (0 = off)
  stopPct: 25, // exit when the close is this % under the entry (0 = off)
  trailPct: 0, // exit when the close is this % under its best since entry (0 = off)
  exitAt: '15:20',
  maxPerDay: 2,
  budget: 25000, // ₹ of premium per trade (at least one lot)
  capital: 500000,
  slippage: 0.5, // % per fill
};
// Days the market had a known reason to move. A seed list (edit or extend bt-data/surge-calendar.json, same shape).
const MACRO = [
  ['2024-10-09', 'RBI policy'],
  ['2024-11-06', 'US election result'],
  ['2024-11-25', 'Maharashtra election result (first session after)'],
  ['2024-12-06', 'RBI policy (CRR cut)'],
  ['2025-02-01', 'Union Budget'],
  ['2025-02-07', 'RBI policy (rate cut)'],
  ['2025-04-03', 'US reciprocal tariffs announced'],
  ['2025-04-07', 'Global tariff sell-off'],
  ['2025-04-09', 'RBI policy (rate cut)'],
  ['2025-04-11', 'US tariff pause (first session after)'],
  ['2025-05-07', 'Operation Sindoor'],
  ['2025-05-12', 'India-Pakistan ceasefire rally'],
  ['2025-06-06', 'RBI policy (50 bp cut, CRR cut)'],
  ['2025-08-06', 'RBI policy; US tariff on India'],
  ['2025-10-01', 'RBI policy'],
  ['2025-11-14', 'Bihar election result'],
  ['2025-12-05', 'RBI policy'],
  ['2026-02-01', 'Union Budget'],
];
// columns of a scanned surge, in order (the file keeps rows as arrays)
const COLS = [
  'expiry',
  'strike',
  'type',
  'lot',
  'span',
  'troughDay',
  'troughMin',
  'trough',
  'day',
  'm50',
  'm100',
  'm200',
  'peakDay',
  'peakMin',
  'peak',
  'mult',
  'dayClose',
  'dte',
  'otmPct',
  'spotLow',
  'spotPeak',
  'niftyMove',
  'niftyPts',
  'gapPct',
  'dayChg',
  'dayRange',
  'vixLow',
  'vixPeak',
  'ivLow',
  'ivPeak',
  'byMove',
  'byIv',
  'traded',
  'driver',
  'tags',
  'volMult',
  'volLead',
  'oiChg',
  'flow',
  'turnover',
  'lots',
];

const r2 = (x) => Math.round(x * 100) / 100;
const num = (v, d, lo = -Infinity, hi = Infinity) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};
const minuteOf = (hhmm, d) => (/^\d{2}:\d{2}$/.test(hhmm || '') ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - OPEN_MIN : d);
const hhmm = (m) => {
  const t = m + OPEN_MIN;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};
const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
// Years to the expiry (15:30 IST) from minute m of day.
const yearsTo = (expiry, day, m) =>
  Math.max(1e-7, (Date.parse(expiry + 'T15:30:00+05:30') - Date.parse(day + 'T09:15:00+05:30') - m * 60_000) / (365 * 86400_000));

// Implied volatility (Black-Scholes, r = RATE, no dividend) of an option price, or null.
function impliedVol(price, S, K, T, call) {
  const intrinsic = Math.max(0, call ? S - K : K - S);
  if (!(price > intrinsic + 0.01) || !(S > 0) || T <= 0) return null;
  let lo = 0.01;
  let hi = 4;
  if (bsm(S, K, T, hi, call, RATE) < price) return null;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bsm(S, K, T, mid, call, RATE) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------- the cache, read directly (nothing downloaded, nothing kept in memory) ----------
function cachedExpiries(cacheDir) {
  try {
    return fs
      .readdirSync(path.join(cacheDir, 'opt'))
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
      .sort();
  } catch {
    return [];
  }
}
function cachedContracts(cacheDir, expiry) {
  try {
    return fs
      .readdirSync(path.join(cacheDir, 'opt', expiry))
      .map((f) => /^(\d+)(CE|PE)\.json\.gz$/.exec(f))
      .filter(Boolean)
      .map((m) => ({ strike: Number(m[1]), type: m[2] }));
  } catch {
    return [];
  }
}
// day -> Int32Array(MPD*4) as downloaded, days sorted
function readContract(cacheDir, expiry, strike, type) {
  try {
    const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, 'opt', expiry, `${strike}${type}.json.gz`))).toString('utf8'));
    const days = new Map();
    for (const d of Object.keys(saved.days).sort()) {
      const buf = Buffer.from(saved.days[d], 'base64');
      days.set(d, new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    }
    return days;
  } catch {
    return null;
  }
}
function lotOf(cacheDir, expiry) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'contracts', expiry + '.json'), 'utf8'))[0]?.[3] || 65;
  } catch {
    return 65;
  }
}
function macroCalendar(file) {
  const map = new Map(MACRO);
  try {
    for (const [d, label] of JSON.parse(fs.readFileSync(file, 'utf8'))) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) map.set(d, String(label));
  } catch {}
  return map;
}

// Nifty and VIX by day, with the previous session's close, for the range of expiries.
async function loadMarket(data, from, to) {
  const days = await data.loadIndex(from, to, 'soft');
  const prevClose = new Map();
  let last = null;
  for (const d of days) {
    prevClose.set(d, last);
    const a = data.spotDay(d);
    if (a) last = a[MPD * 4 - 1];
  }
  const spot = (d, m) => data.spotDay(d)?.[m * 4 + 3] ?? null;
  const vix = (d, m) => data.vixDay(d)?.[m * 4 + 3] ?? null;
  // gap, change and range of a session in %
  const session = (d) => {
    const a = data.spotDay(d);
    const pc = prevClose.get(d);
    if (!a) return { gap: null, chg: null, range: null };
    let hi = -Infinity;
    let lo = Infinity;
    for (let m = 0; m < MPD; m++) {
      hi = Math.max(hi, a[m * 4 + 1]);
      lo = Math.min(lo, a[m * 4 + 2]);
    }
    return {
      gap: pc ? ((a[0] - pc) / pc) * 100 : null,
      chg: pc ? ((a[MPD * 4 - 1] - pc) / pc) * 100 : null,
      range: ((hi - lo) / a[0]) * 100,
    };
  };
  return { days, spot, vix, session };
}

// ---------- scan ----------
// A price must hold for two traded minutes in a row to count, so one stray print neither makes a low nor a peak:
// lo[m] = the higher of this close and the previous traded one (what a low really was), hi[m] = the lower of the two
// (what a high really was); 0 where there is no previous trade that session. Sessions with fewer than MIN_TRADED traded
// minutes are skipped as illiquid.
const MIN_TRADED = 150;
const SETTLE_MIN = 345; // 15:00: on expiry day the last half hour trades against the settlement average, not spot
function held(a) {
  const lo = new Float64Array(MPD);
  const hi = new Float64Array(MPD);
  let prev = 0;
  let traded = 0;
  for (let m = 0; m < MPD; m++) {
    const c = a[m * 4 + 3];
    if (c <= 0) continue;
    traded++;
    if (prev > 0) {
      lo[m] = Math.max(c, prev);
      hi[m] = Math.min(c, prev);
    }
    prev = c;
  }
  return { lo, hi, traded };
}

// Surges of one contract: { span, troughDay, troughMin, trough (paise), day (of the trigger), trigMin, peakDay, peakMin, peak }
function contractSurges(days, o, expiry) {
  const base = o.minBase * 100;
  const out = [];
  const list = [...days.keys()];
  const H = new Map(list.map((d) => [d, held(days.get(d))]));
  const lastMin = (d) => (d === expiry ? SETTLE_MIN : MPD);
  // intraday: from the session's own low
  for (const d of list) {
    const { lo: L, hi: P, traded } = H.get(d);
    if (traded < MIN_TRADED) continue;
    let lo = Infinity;
    let loM = -1;
    let ev = null;
    const end = () => {
      out.push(ev);
      ev = null;
    };
    for (let m = 0; m < lastMin(d); m++) {
      if (!L[m]) continue;
      if (ev) {
        if (P[m] > ev.peak) {
          ev.peak = P[m];
          ev.peakMin = m;
        }
        if (L[m] < ev.peak * (1 - o.drop)) {
          end();
          lo = L[m];
          loM = m;
        }
        continue;
      }
      if (L[m] < lo) {
        lo = L[m];
        loM = m;
      }
      if (lo >= base && P[m] >= o.minMult * lo)
        ev = { span: 'intraday', troughDay: d, troughMin: loM, trough: lo, day: d, trigMin: m, peakDay: d, peakMin: m, peak: P[m] };
    }
    if (ev) end();
  }
  // multi-day: from the lowest held close of the previous sessions, when today's own low does not already explain it
  const lows = list.map((d) => {
    const { lo: L, traded } = H.get(d);
    let lo = Infinity;
    let loM = -1;
    if (traded >= MIN_TRADED)
      for (let m = 0; m < lastMin(d); m++)
        if (L[m] && L[m] < lo) {
          lo = L[m];
          loM = m;
        }
    return { lo, loM };
  });
  let barrier = -1; // index of the last day an earlier multi-day surge reached; lows before it are spent
  for (let k = 1; k < list.length; k++) {
    let prev = null;
    for (let j = Math.max(barrier + 1, k - o.swingDays); j < k; j++) if (lows[j].lo < Infinity && (!prev || lows[j].lo < prev.lo)) prev = { ...lows[j], k: j };
    if (!prev || prev.lo < base) continue;
    const { lo: L, hi: P, traded } = H.get(list[k]);
    if (traded < MIN_TRADED) continue;
    let today = Infinity;
    let ev = null;
    for (let m = 0; m < lastMin(list[k]) && !ev; m++) {
      if (!L[m]) continue;
      today = Math.min(today, L[m]);
      if (P[m] >= o.minMult * prev.lo && P[m] < o.minMult * today && prev.lo < today)
        ev = {
          span: 'multi-day',
          troughDay: list[prev.k],
          troughMin: prev.loM,
          trough: prev.lo,
          day: list[k],
          trigMin: m,
          peakDay: list[k],
          peakMin: m,
          peak: P[m],
        };
    }
    if (!ev) continue;
    // follow the peak onwards, across sessions, until it gives back `drop` of it
    let done = false;
    let lastK = k;
    for (let j = k; j < list.length && !done; j++) {
      const { lo: Lj, hi: Pj } = H.get(list[j]);
      for (let m = j === k ? ev.trigMin : 0; m < lastMin(list[j]); m++) {
        if (!Lj[m]) continue;
        lastK = j;
        if (Pj[m] > ev.peak) {
          ev.peak = Pj[m];
          ev.peakDay = list[j];
          ev.peakMin = m;
        } else if (Lj[m] < ev.peak * (1 - o.drop)) {
          done = true;
          break;
        }
      }
    }
    out.push(ev);
    barrier = lastK;
    k = lastK;
  }
  return out;
}

// First minute from the low to the peak with a close at least x (its day: firstCrossDay); null if none.
function firstCross(days, ev, x) {
  for (const [d, a] of days) {
    if (d < ev.troughDay || d > ev.peakDay) continue;
    const m0 = d === ev.troughDay ? ev.troughMin : 0;
    const m1 = d === ev.peakDay ? ev.peakMin : MPD - 1;
    const P = held(a).hi;
    for (let m = m0; m <= m1; m++) if (P[m] >= x) return m;
  }
  return null;
}
// Day of that first cross, for multi-day surges (the minute alone is ambiguous there).
function firstCrossDay(days, ev, x) {
  for (const [d, a] of days) {
    if (d < ev.troughDay || d > ev.peakDay) continue;
    const m0 = d === ev.troughDay ? ev.troughMin : 0;
    const m1 = d === ev.peakDay ? ev.peakMin : MPD - 1;
    const P = held(a).hi;
    for (let m = m0; m <= m1; m++) if (P[m] >= x) return d;
  }
  return null;
}

function describe(days, ev, c, mk, macro, cacheDir) {
  const call = c.type === 'CE';
  const trough = ev.trough / 100;
  const peak = ev.peak / 100;
  const sLow = mk.spot(ev.troughDay, ev.troughMin);
  const sPeak = mk.spot(ev.peakDay, ev.peakMin);
  const vLow = mk.vix(ev.troughDay, ev.troughMin);
  const vPeak = mk.vix(ev.peakDay, ev.peakMin);
  const tLow = yearsTo(c.expiry, ev.troughDay, ev.troughMin);
  const tPeak = yearsTo(c.expiry, ev.peakDay, ev.peakMin);
  const ivLow = sLow ? impliedVol(trough, sLow, c.strike, tLow, call) : null;
  const ivPeak = sPeak ? impliedVol(peak, sPeak, c.strike, tPeak, call) : null;
  // the gain the Nifty move explains at the low's volatility (time decay included), and the rest
  let byMove = null;
  let byIv = null;
  if (ivLow && sPeak) {
    const atLowIv = bsm(sPeak, c.strike, tPeak, ivLow, call, RATE);
    const gain = peak - trough;
    byMove = Math.max(-1, Math.min(2, (atLowIv - trough) / gain));
    byIv = 1 - byMove;
  }
  const niftyMove = sLow && sPeak ? ((sPeak - sLow) / sLow) * 100 * (call ? 1 : -1) : null;
  const ses = mk.session(ev.troughDay);
  const sesPeak = mk.session(ev.peakDay);
  let dayClose = null;
  const pa = days.get(ev.peakDay);
  for (let m = MPD - 1; m >= 0 && dayClose == null; m--) if (pa[m * 4 + 3] > 0) dayClose = pa[m * 4 + 3] / 100;
  let traded = 0;
  const ta = days.get(ev.day);
  for (let m = 0; m < MPD; m++) if (ta[m * 4 + 3] > 0) traded++;
  const dte = dayGap(ev.troughDay, c.expiry);
  const otmPct = sLow ? ((call ? c.strike - sLow : sLow - c.strike) / sLow) * 100 : null;
  const m50 = firstCross(days, ev, ev.trough * 1.5);
  const m100 = firstCross(days, ev, ev.trough * 2);
  const m200 = ev.peak >= ev.trough * 3 ? firstCross(days, ev, ev.trough * 3) : null;
  const fl = flowStats(cacheDir, { ...c, ...ev, m50 }, days) || {};
  // what moved it
  const tags = [];
  if (dayGap(ev.peakDay, c.expiry) === 0) tags.push('Expiry day');
  else if (dayGap(ev.peakDay, c.expiry) <= 2) tags.push('Near expiry');
  if (niftyMove != null && niftyMove >= 1) tags.push('Big Nifty move');
  if (sesPeak.chg != null && Math.abs(sesPeak.chg) >= 1.5) tags.push('Big Nifty day');
  if (ev.troughMin <= 5 && ses.gap != null && Math.abs(ses.gap) >= 0.4) tags.push(ses.gap > 0 === call ? 'Gap in favour' : 'Gap against, reversed');
  if (ivLow && ivPeak && ivPeak / ivLow >= 1.3) tags.push('IV jump');
  if (vLow && vPeak && vPeak / vLow >= 1.08) tags.push('VIX spike');
  if (otmPct != null && otmPct >= 1) tags.push('Far OTM');
  if (fl.flow && fl.flow !== 'Flat OI') tags.push(fl.flow);
  if (fl.volMult >= 5) tags.push('Volume ×' + Math.round(fl.volMult));
  for (const d of new Set([ev.troughDay, ev.peakDay])) if (macro.has(d)) tags.push('Macro: ' + macro.get(d));
  let driver = 'Mixed';
  if (byMove != null && byMove >= 0.6) driver = dayGap(ev.peakDay, c.expiry) === 0 ? 'Expiry-day gamma' : 'Nifty move (delta / gamma)';
  else if (byIv != null && byIv >= 0.5) driver = 'Volatility (IV) expansion';
  else if (byMove == null) driver = 'In the money (no IV)';
  const row = {
    expiry: c.expiry,
    strike: c.strike,
    type: c.type,
    lot: c.lot,
    span: ev.span,
    troughDay: ev.troughDay,
    troughMin: ev.troughMin,
    trough,
    day: ev.span === 'intraday' ? ev.day : firstCrossDay(days, ev, ev.trough * 2) || ev.day,
    m50,
    m100,
    m200,
    peakDay: ev.peakDay,
    peakMin: ev.peakMin,
    peak,
    mult: r2(peak / trough),
    dayClose,
    dte,
    otmPct: otmPct == null ? null : r2(otmPct),
    spotLow: sLow == null ? null : r2(sLow),
    spotPeak: sPeak == null ? null : r2(sPeak),
    niftyMove: niftyMove == null ? null : r2(niftyMove),
    niftyPts: sLow && sPeak ? r2((sPeak - sLow) * (call ? 1 : -1)) : null,
    gapPct: ses.gap == null ? null : r2(ses.gap),
    dayChg: sesPeak.chg == null ? null : r2(sesPeak.chg),
    dayRange: ses.range == null ? null : r2(ses.range),
    vixLow: vLow == null ? null : r2(vLow),
    vixPeak: vPeak == null ? null : r2(vPeak),
    ivLow: ivLow == null ? null : r2(ivLow * 100),
    ivPeak: ivPeak == null ? null : r2(ivPeak * 100),
    byMove: byMove == null ? null : r2(byMove),
    byIv: byIv == null ? null : r2(byIv),
    traded,
    driver,
    tags,
    volMult: fl.volMult ?? null,
    volLead: fl.volLead ?? null,
    oiChg: fl.oiChg ?? null,
    flow: fl.flow ?? null,
    turnover: fl.turnover ?? null,
    lots: fl.lots ?? null,
  };
  return COLS.map((k) => row[k]);
}

// Every surge in the cache between from and to (days of the trigger). Returns { at, params, from, to, cols, rows, stats }.
async function scanSurges(data, cacheDir, params = {}, { from, to, calendarFile, onProgress, stopped } = {}) {
  const o = {
    minBase: num(params.minBase, SCAN_DEFAULTS.minBase, 0.5, 500),
    minMult: num(params.minMult, SCAN_DEFAULTS.minMult, 1.5, 10),
    drop: num(params.drop, SCAN_DEFAULTS.drop, 0.1, 0.9),
    swingDays: Math.round(num(params.swingDays, SCAN_DEFAULTS.swingDays, 1, 10)),
    swingMult: num(params.swingMult, SCAN_DEFAULTS.swingMult, 1.5, 20),
    swingDte: Math.round(num(params.swingDte, SCAN_DEFAULTS.swingDte, 0, 60)),
  };
  const expiries = cachedExpiries(cacheDir).filter((e) => (!from || e >= from) && (!to || addDays(e, -45) <= to));
  if (!expiries.length) throw new Error('No option history in the cache: download some on the Data screen first');
  const first = from || addDays(expiries[0], -45);
  const mk = await loadMarket(data, first, expiries[expiries.length - 1]);
  const macro = macroCalendar(calendarFile);
  const rows = [];
  let contracts = 0;
  for (const [i, e] of expiries.entries()) {
    if (stopped?.()) break;
    onProgress?.({ phase: 'Scanning expiry ' + e, done: i, total: expiries.length });
    const lot = lotOf(cacheDir, e);
    for (const { strike, type } of cachedContracts(cacheDir, e)) {
      const days = readContract(cacheDir, e, strike, type);
      if (!days?.size) continue;
      contracts++;
      for (const ev of contractSurges(days, o, e)) {
        if ((from && ev.day < from) || (to && ev.day > to)) continue;
        if (ev.span === 'multi-day' && (ev.peak < o.swingMult * ev.trough || dayGap(ev.day, e) > o.swingDte)) continue;
        rows.push(describe(days, ev, { expiry: e, strike, type, lot }, mk, macro, cacheDir));
      }
    }
    await new Promise((r) => setImmediate(r)); // keep the server answering while this runs
  }
  rows.sort((a, b) => (a[8] === b[8] ? a[10] - b[10] : a[8] < b[8] ? -1 : 1));
  const iMult = COLS.indexOf('mult');
  const intraday = rows.filter((r) => r[4] === 'intraday');
  return {
    at: Date.now(),
    params: o,
    from: from || null,
    to: to || null,
    expiries: expiries.length,
    contracts,
    cols: COLS,
    rows,
    stats: {
      doubled: intraday.length,
      tripled: intraday.filter((r) => r[iMult] >= 3).length,
      fivefold: intraday.filter((r) => r[iMult] >= 5).length,
    },
  };
}

// ---------- backtest ----------
function normalizeBt(p = {}) {
  const D = BT_DEFAULTS;
  return {
    mode: p.mode === 'lottery' ? 'lottery' : 'trigger',
    trigger: num(p.trigger, D.trigger, 1.1, 10),
    minBase: num(p.minBase, D.minBase, 0.5, 1000),
    maxBase: num(p.maxBase, D.maxBase, 0, 5000),
    sides: ['CE', 'PE'].includes(p.sides) ? p.sides : 'both',
    dteMax: Math.round(num(p.dteMax, D.dteMax, 0, 45)),
    entryFrom: minuteOf(p.entryFrom, minuteOf(D.entryFrom)),
    entryTo: minuteOf(p.entryTo, minuteOf(D.entryTo)),
    confirm: num(p.confirm, D.confirm, 0, 5),
    premium: num(p.premium, D.premium, 0.5, 1000),
    lotteryAt: minuteOf(p.lotteryAt, minuteOf(D.lotteryAt)),
    targetMult: num(p.targetMult, D.targetMult, 0, 50),
    targetPct: num(p.targetPct, D.targetPct, 0, 5000),
    stopPct: num(p.stopPct, D.stopPct, 0, 100),
    trailPct: num(p.trailPct, D.trailPct, 0, 100),
    exitAt: minuteOf(p.exitAt, minuteOf(D.exitAt)),
    maxPerDay: Math.round(num(p.maxPerDay, D.maxPerDay, 1, 50)),
    budget: num(p.budget, D.budget, 100, 1e8),
    capital: num(p.capital, D.capital, 1000, 1e10),
    slippage: num(p.slippage, D.slippage, 0, 10),
  };
}
const forOut = (v) => ({ ...v, entryFrom: hhmm(v.entryFrom), entryTo: hhmm(v.entryTo), lotteryAt: hhmm(v.lotteryAt), exitAt: hhmm(v.exitAt) });

// The trade from an entry signal at minute sig of day (bars a), or null when nothing traded in the next 3 minutes.
function simulate(v, a, sig, low, ctx) {
  let em = -1;
  for (let m = sig + 1; m <= Math.min(MPD - 1, sig + 3); m++)
    if (a[m * 4] > 0) {
      em = m;
      break;
    }
  if (em < 0 || em >= v.exitAt) return null;
  const slip = v.slippage / 100;
  const entry = (a[em * 4] / 100) * (1 + slip);
  const target = Math.min(v.targetMult > 0 ? (low / 100) * v.targetMult : Infinity, v.targetPct > 0 ? entry * (1 + v.targetPct / 100) : Infinity);
  const stop = v.stopPct > 0 ? entry * (1 - v.stopPct / 100) : -Infinity;
  let best = entry;
  let exitM = -1;
  let px = null;
  let why = 'time';
  let last = a[em * 4 + 3] > 0 ? a[em * 4 + 3] / 100 : a[em * 4] / 100;
  for (let m = em; m < MPD; m++) {
    const c = a[m * 4 + 3];
    if (c > 0) last = c / 100;
    if (m >= v.exitAt) {
      exitM = m;
      px = last;
      break;
    }
    if (c <= 0) continue;
    best = Math.max(best, last);
    if (last >= target) why = 'target';
    else if (last <= stop) why = 'stop';
    else if (v.trailPct > 0 && best > entry && last <= best * (1 - v.trailPct / 100)) why = 'trail';
    else continue;
    exitM = m;
    px = last;
    break;
  }
  if (px == null) {
    exitM = MPD - 1;
    px = last;
  }
  const exit = px * (1 - slip);
  const lots = Math.max(1, Math.floor(v.budget / (entry * ctx.lot)));
  const qty = lots * ctx.lot;
  const charges = Costs.orders({ buy: entry * qty, sell: exit * qty, orders: 2, day: ctx.day });
  return {
    day: ctx.day,
    expiry: ctx.expiry,
    strike: ctx.strike,
    type: ctx.type,
    sigMin: sig,
    low: low / 100,
    entryMin: em,
    entry: r2(entry),
    exitMin: exitM,
    exit: r2(exit),
    why,
    lots,
    qty,
    charges: r2(charges),
    pnl: r2((exit - entry) * qty - charges),
    ret: r2(((exit - entry) / entry) * 100),
  };
}

// Entry signals of one contract-session for variant v: [{ sig, low }] (at most one per session).
function signals(v, a, ctx, mk) {
  if (v.sides !== 'both' && v.sides !== ctx.type) return [];
  if (ctx.dte > v.dteMax) return [];
  const call = ctx.type === 'CE';
  if (v.mode === 'lottery') {
    const m = v.lotteryAt;
    const c = a[m * 4 + 3];
    if (!(c > 0)) return [];
    return [{ sig: m, low: c, price: c }];
  }
  const { lo: L, hi: P, traded } = held(a);
  if (traded < MIN_TRADED) return [];
  let lo = Infinity;
  let loM = -1;
  for (let m = 0; m < Math.min(MPD, v.entryTo + 1); m++) {
    if (!L[m]) continue;
    if (L[m] < lo) {
      lo = L[m];
      loM = m;
    }
    if (m < v.entryFrom || lo < v.minBase * 100 || (v.maxBase > 0 && lo > v.maxBase * 100)) continue;
    if (P[m] < v.trigger * lo) continue;
    if (v.confirm > 0) {
      const s0 = mk.spot(ctx.day, loM);
      const s1 = mk.spot(ctx.day, m);
      if (!s0 || !s1 || ((s1 - s0) / s0) * 100 * (call ? 1 : -1) < v.confirm) continue;
    }
    return [{ sig: m, low: lo }];
  }
  return [];
}

function summarize(trades, v, from, to) {
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = -losses.reduce((s, t) => s + t.pnl, 0);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.pnl);
  const equity = [];
  for (const [d, p] of [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.min(dd, cum - peak);
    equity.push([d, r2(cum)]);
  }
  // the two halves of the period, to see whether a result holds up out of sample
  const mid = from && to ? addDays(from, Math.round(dayGap(from, to) / 2)) : null;
  const half = (f) => {
    const t = trades.filter(f);
    return { trades: t.length, net: r2(t.reduce((s, x) => s + x.pnl, 0)), win: t.length ? r2((t.filter((x) => x.pnl > 0).length / t.length) * 100) : null };
  };
  const group = (key) => {
    const m = new Map();
    for (const t of trades) {
      const k = key(t);
      const g = m.get(k) || { key: k, trades: 0, net: 0, wins: 0 };
      g.trades++;
      g.net += t.pnl;
      if (t.pnl > 0) g.wins++;
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, net: r2(g.net), win: r2((g.wins / g.trades) * 100) })).sort((a, b) => (a.key < b.key ? -1 : 1));
  };
  const years = Math.max(0.25, from && to ? dayGap(from, to) / 365 : 1);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    net: r2(net),
    charges: r2(trades.reduce((s, t) => s + t.charges, 0)),
    avgWin: wins.length ? r2(gw / wins.length) : null,
    avgLoss: losses.length ? r2(-gl / losses.length) : null,
    pf: gl > 0 ? r2(gw / gl) : null,
    maxDD: r2(dd),
    best: trades.length ? r2(Math.max(...trades.map((t) => t.pnl))) : null,
    worst: trades.length ? r2(Math.min(...trades.map((t) => t.pnl))) : null,
    hitTarget: trades.length ? r2((trades.filter((t) => t.why === 'target').length / trades.length) * 100) : null,
    // what is left without the 5 best trades: a result that only a handful of days made is a lottery, not an edge
    exTop5: r2(
      net -
        [...trades]
          .sort((a, b) => b.pnl - a.pnl)
          .slice(0, 5)
          .reduce((s, t) => s + t.pnl, 0),
    ),
    cagrPct: r2((net / v.capital / years) * 100),
    mid,
    h1: mid ? half((t) => t.day < mid) : null,
    h2: mid ? half((t) => t.day >= mid) : null,
    byExit: group((t) => t.why),
    bySide: group((t) => t.type),
    byDte: group((t) => String(dayGap(t.day, t.expiry))),
    byMonth: group((t) => t.day.slice(0, 7)),
    equity,
  };
}

// Runs one or more variants over the cache in one pass. Returns [{ params, summary, trades? }] in variant order;
// trades are kept when keepTrades (the single run), not for a grid.
async function backtestSurge(data, cacheDir, variants, { from, to, keepTrades = true, onProgress, stopped } = {}) {
  const V = variants.map(normalizeBt);
  const dteMax = Math.max(...V.map((v) => v.dteMax));
  const all = cachedExpiries(cacheDir);
  if (!all.length) throw new Error('No option history in the cache: download some on the Data screen first');
  from = from || addDays(all[0], -dteMax);
  to = to || all[all.length - 1];
  const expiries = all.filter((e) => e >= from && addDays(e, -dteMax) <= to);
  const mk = await loadMarket(data, addDays(from, -7), to);
  // per variant: day -> candidate trades (kept to the best maxPerDay, earliest signal first)
  const picks = V.map(() => new Map());
  const better = (v, a, b) =>
    v.mode === 'lottery' ? Math.abs(a.price / 100 - v.premium) - Math.abs(b.price / 100 - v.premium) : a.sig - b.sig || b.low - a.low;
  for (const [i, e] of expiries.entries()) {
    if (stopped?.()) break;
    onProgress?.({ phase: 'Backtesting expiry ' + e, done: i, total: expiries.length });
    const lot = lotOf(cacheDir, e);
    for (const { strike, type } of cachedContracts(cacheDir, e)) {
      const days = readContract(cacheDir, e, strike, type);
      if (!days) continue;
      for (const [day, a] of days) {
        if (day < from || day > to) continue;
        const dte = dayGap(day, e);
        if (dte > dteMax) continue;
        const ctx = { day, expiry: e, strike, type, lot, dte };
        V.forEach((v, vi) => {
          for (const s of signals(v, a, ctx, mk)) {
            if (v.mode === 'lottery' && (s.price < v.minBase * 100 || (v.maxBase > 0 && s.price > v.maxBase * 100))) continue;
            const cand = { ...s, a, ctx };
            const key = v.mode === 'lottery' ? day + type : day; // lottery: one per side per day
            const list = picks[vi].get(key) || [];
            list.push(cand);
            list.sort((x, y) => better(v, x, y));
            if (list.length > (v.mode === 'lottery' ? 1 : v.maxPerDay)) list.pop();
            picks[vi].set(key, list);
          }
        });
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  return V.map((v, vi) => {
    const trades = [];
    for (const list of picks[vi].values())
      for (const c of list) {
        const t = simulate(v, c.a, c.sig, c.low, c.ctx);
        if (t) trades.push(t);
      }
    trades.sort((a, b) => (a.day === b.day ? a.entryMin - b.entryMin : a.day < b.day ? -1 : 1));
    const summary = summarize(trades, v, from, to);
    return {
      params: { ...forOut(v), name: variants[vi].exitName || null },
      summary,
      trades: keepTrades ? trades.map((t) => ({ ...t, entryAt: hhmm(t.entryMin), exitAt: hhmm(t.exitMin), sigAt: hhmm(t.sigMin) })) : undefined,
    };
  });
}

// The variants of the grid: trigger level × exit rule × days to expiry × side, on top of the base parameters, and the
// lottery (no signal) for comparison. With this many rows the best one is partly luck: the two halves of the period
// (h1 / h2) show whether it held up.
function gridVariants(base = {}) {
  const out = [];
  for (const trigger of [1.5, 2, 3])
    for (const exit of [
      {
        name: trigger < 3 ? 'Target 3× low, stop 25%' : 'Target 4.5× low, stop 25%',
        targetMult: trigger < 3 ? 3 : 4.5,
        targetPct: 0,
        stopPct: 25,
        trailPct: 0,
      },
      { name: 'Target +50%, stop 25%', targetMult: 0, targetPct: 50, stopPct: 25, trailPct: 0 },
      { name: 'Trail 25% from best', targetMult: 0, targetPct: 0, stopPct: 25, trailPct: 25 },
      { name: 'Hold to 15:20', targetMult: 0, targetPct: 0, stopPct: 0, trailPct: 0 },
    ])
      for (const dteMax of [0, 1, 3])
        for (const sides of ['both', 'CE', 'PE']) out.push({ ...base, mode: 'trigger', trigger, ...exit, dteMax, sides, exitName: exit.name });
  for (const premium of [5, 10, 20])
    for (const dteMax of [0, 1])
      out.push({
        ...base,
        mode: 'lottery',
        premium,
        minBase: 1,
        maxBase: 0,
        dteMax,
        sides: 'both',
        targetMult: 3,
        targetPct: 0,
        stopPct: 0,
        trailPct: 0,
        exitName: 'Lottery: target 3×, else 15:20',
      });
  return out;
}

module.exports = {
  readContract,
  scanSurges,
  backtestSurge,
  gridVariants,
  contractSurges,
  impliedVol,
  SCAN_DEFAULTS,
  BT_DEFAULTS,
  COLS,
  MACRO,
  normalizeBt,
  hhmm,
};
