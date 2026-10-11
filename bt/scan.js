// History scan: run the scanners over every minute of past sessions (on the nearest weekly expiry's chain) and
// record each occurrence once per cooldown.
//
// The history is 1-minute candles of last-traded prices: no bid / ask, no depth, no volume. A minute's closes of
// different contracts are last trades a few seconds apart, so most "violations" between them are timing noise.
// Each occurrence of an arbitrage type is therefore taken through four checks of rising strength:
//   signal   the bound is broken at the minute's closing prices (what the detector saw)
//   robust   ... and at that minute's worst traded prices (buys at each leg's high, sells at its low)
//   fillable ... and again at the next minute's worst traded prices: for two minutes running it locked a profit
//            whatever order the trades came in
//   pays     ... and what it locks in there exceeds brokerage and taxes on `lots` lots
// A fillable occurrence is also settled at the expiry's final settlement price. An occurrence that is not fillable
// has nothing locked in, so what its trade made at expiry is market direction and is not reported. These are trade
// prices, not quotes: "fillable" says the mispricing was really printed, not that size was available.
//
// A relative-value occurrence (fair value deviation) is measured as before: its suggested trade entered at the
// next minute's open and marked after 5 / 15 / 30 / 60 minutes and at the end of the scan window.
const A = require('./anomalies');
const Costs = require('../lib/costs');
const { MPD, addDays } = require('./data');

const HORIZONS = [5, 15, 30, 60, 'eod'];
const KEEP = 5000; // occurrences kept in a saved scan
const MIN_OF = (t) => {
  const [h, m] = String(t || '09:15')
    .split(':')
    .map(Number);
  return Math.max(0, Math.min(MPD - 1, h * 60 + m - 555));
};

// Lets the server answer other requests (progress polls, Stop) during a scan whose data is all cached.
const breathe = () => new Promise((r) => setImmediate(r));

// stopped(): true once the user pressed Stop — the scan then ends with what it has found so far.
async function runScan(data, hist, raw, onProgress = () => {}, stopped = () => false) {
  const cal = await data.expiryCalendar();
  if (!cal.expired.length) throw new Error('Upstox returned no expired Nifty expiries');
  const last = cal.expired[cal.expired.length - 1];
  const to = raw.to && raw.to < last ? raw.to : last;
  const from = raw.from || addDays(to, -30);
  const types = (raw.types || [])
    .filter((t) => A.BY_ID.has(t.id))
    .map((t) => ({
      id: t.id,
      def: A.BY_ID.get(t.id),
      params: A.params(t.id, { ...t.params, ...raw.quality }),
      cooldown: Number(t.params?.cooldown) > 0 ? Number(t.params.cooldown) : A.BY_ID.get(t.id).cooldown,
      side: t.side || 'any',
      dir: t.dir || 'any',
    }));
  if (!types.length) throw new Error('Pick at least one anomaly type');
  const startM = MIN_OF(raw.start || '09:20');
  const endM = Math.max(startM + 1, MIN_OF(raw.end || '15:15'));
  const step = Math.max(1, Math.min(15, Math.round(Number(raw.step) || 1)));
  const fixedLot = raw.lotMode === 'historical' ? null : Math.max(1, Number(raw.lotSize) || cal.liveLot || 65);
  const lots = Math.max(1, Math.min(500, Math.round(Number(raw.lots) || 10)));
  const brokerage = Number(raw.brokerage) >= 0 && raw.brokerage !== '' && raw.brokerage != null ? Number(raw.brokerage) : Costs.BROKERAGE;
  const wanted = Array.isArray(raw.expiries) && raw.expiries.length ? new Set(raw.expiries) : null;
  const needNext =
    types.some((t) => t.def.needsNext) || types.some((t) => A.suggest({ type: t.id, dir: t.def.dirs[0] }, t.params).legs.some((l) => l.expiry === 'next'));

  onProgress({ phase: 'Loading Nifty history', done: 0, total: 0 });
  const days = await data.loadIndex(addDays(from, -30), to);
  hist.setDays(days);
  const scanDays = days.filter((d) => d >= from && d <= to);
  const hits = [];
  const skipped = [];
  let done = 0;

  for (const day of scanDays) {
    onProgress({ phase: `Scanning ${day}`, done, total: scanDays.length, api: data.apiStats() });
    await breathe();
    if (stopped()) break;
    done++;
    const ei = cal.all.findIndex((e) => e >= day);
    const exp = cal.all[ei];
    if (!exp || !cal.expiredSet.has(exp)) {
      skipped.push({ day, reason: 'expiry not yet expired' });
      continue;
    }
    if (wanted && !wanted.has(exp)) continue;
    const nxt = cal.all[ei + 1];
    const withNext = needNext && nxt && cal.expiredSet.has(nxt) ? nxt : null;
    let s;
    try {
      s = await hist.load(exp, day, { withNext });
    } catch (e) {
      skipped.push({ day, reason: e.message });
      continue;
    }
    if (!s) {
      skipped.push({ day, reason: 'no Nifty data' });
      continue;
    }
    const lot = fixedLot || (await data.contracts(exp)).lot || cal.liveLot || 65;
    const lastSeen = new Map();
    for (let m = startM; m <= endM; m += step) {
      const ctx = hist.ctxAt(s, m);
      for (const t of types) {
        const found = A.detect(t.id, ctx, t.params).filter((h) => (t.side === 'any' || h.side === t.side) && (t.dir === 'any' || h.dir === t.dir));
        for (const h of found.slice(0, 3)) {
          const key = `${h.type}|${h.side}|${h.dir}|${h.strike}`;
          if (m - (lastSeen.get(key) ?? -1e9) < t.cooldown) {
            lastSeen.set(key, m);
            continue;
          }
          lastSeen.set(key, m);
          const sug = A.suggest(h, t.params);
          const rec = {
            day,
            m,
            time: hhmm(m),
            expiry: exp,
            dte0: day === exp,
            lot,
            spot: r2(ctx.spot),
            atmIv: ctx.atmIv() ? r2(ctx.atmIv() * 100) : null,
            ...pick(h),
            legs: sug.legs,
          };
          // an arbitrage is re-priced at the next minute's prices while the day's candles are in memory
          if (h.cls === 'arb') rec._fills = m + 1 <= endM ? nextMinute(s, m + 1, h.st, t.params.maxSpreadPct) : null;
          rec._pv = h.pv;
          hits.push(rec);
        }
      }
    }
  }

  // ---- outcomes ----
  onProgress({ phase: 'Measuring outcomes', done: 0, total: hits.length, api: data.apiStats() });
  const cost = { lots, brokerage };
  let k = 0;
  for (const h of hits) {
    if (stopped()) h.out = null;
    else if (h.cls === 'arb') h.out = await settleArb(data, cal, h, cost).catch(() => null);
    else h.out = await outcome(data, cal, h, endM, cost).catch(() => null);
    delete h._fills;
    delete h._pv;
    if (++k % 50 === 0 && !stopped()) {
      onProgress({ phase: 'Measuring outcomes', done: k, total: hits.length, api: data.apiStats() });
      await breathe();
    }
  }

  const cut = scanDays[Math.floor(scanDays.length * 0.7)] || null; // sessions from here on are the later 30 %
  return {
    opts: {
      from,
      to,
      start: hhmm(startM),
      end: hhmm(endM),
      step,
      lot: fixedLot,
      lots,
      brokerage,
      cut,
      types: types.map((t) => ({ id: t.id, params: t.params, cooldown: t.cooldown, side: t.side, dir: t.dir })),
    },
    days: stopped() ? done : scanDays.length,
    stopped: stopped(),
    daysTotal: scanDays.length,
    hits,
    summary: summarise(hits, cut),
    skipped: skipped.slice(0, 100),
    horizons: HORIZONS,
  };
}

const r2 = (x) => Math.round(x * 100) / 100;
const hhmm = (m) => {
  const t = m + 555;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const pick = (h) => ({
  type: h.type,
  cls: h.cls,
  strike: h.strike,
  ref: h.ref ?? null,
  side: h.side,
  dir: h.dir,
  value: r2(h.value),
  unit: h.unit,
  text: h.text,
  arb: Boolean(h.arb),
  ...(h.cls === 'arb' ? { robust: h.robust == null ? null : r2(h.robust) } : {}),
  ...(h.fair != null ? { fair: h.fair, mkt: h.mkt, pct: h.pct } : {}),
});

// The legs of a structure at minute m: its opening price and the worst price it could have been filled at in that
// minute (anomalies.js worstPx). null when a leg did not trade in the minute — there was nothing to fill against.
function nextMinute(s, m, st, spreadPct) {
  const legs = [];
  for (const l of st) {
    const ss = l.next ? s.next : s;
    const i = ss ? ss.ks.indexOf(l.k) : -1;
    const x = i < 0 ? null : (l.t === 'CE' ? ss.ce : ss.pe)[i];
    if (!x || !(x.op[m] > 0)) return null;
    legs.push({
      dir: l.act === 'B' ? 1 : -1,
      qty: l.n,
      type: l.t,
      strike: l.k,
      expiry: ss.expiry,
      open: x.op[m],
      worst: A.worstPx(x.hi[m], x.lo[m], l.act === 'B', spreadPct),
    });
  }
  return legs;
}

// Final settlement price of an expiry: the average of Nifty's last 30 one-minute closes on that day, standing in
// for the exchange's 30-minute weighted average close.
const settleMemo = new Map();
async function settlePrice(data, expiry) {
  if (settleMemo.has(expiry)) return settleMemo.get(expiry);
  await data.loadIndex(expiry, expiry);
  const sp = data.spotDay(expiry);
  let v = null;
  if (sp) {
    let sum = 0;
    for (let m = MPD - 30; m < MPD; m++) sum += sp[m * 4 + 3];
    v = sum / 30;
  }
  settleMemo.set(expiry, v);
  if (settleMemo.size > 500) settleMemo.delete(settleMemo.keys().next().value);
  return v;
}

// An arbitrage occurrence traded in the next minute and held to its (near) expiry:
//   eo / ew  the edge per structure at the next minute's opens / worst prices (> 0: it still locks a profit there)
//   lock     ₹ on `lots` lots that the worst-price fills lock in, after the entry orders' charges and the STT on
//            bought legs that settle in the money
//   net      ₹ the trade made at settlement with those fills, after the same charges
// null when a leg did not trade in the next minute.
async function settleArb(data, cal, h, { lots, brokerage }) {
  const fills = h._fills;
  if (!fills) return null;
  const fsp = await settlePrice(data, h.expiry);
  if (fsp == null) return null;
  const units = lots * h.lot;
  // what each leg is worth when the trade ends: intrinsic value at settlement; a next-expiry leg (calendar) is sold
  // at its last price of the near expiry's day
  const ends = [];
  for (const l of fills) {
    if (l.expiry === h.expiry) {
      ends.push(Math.max(0, l.type === 'CE' ? fsp - l.strike : l.strike - fsp));
      continue;
    }
    const c = data.optionCached(l.expiry, l.strike, l.type, h.day) || (await data.option(l.expiry, l.strike, l.type, h.day));
    const a = data.optionDay(c, h.expiry);
    if (!a || !(a[(MPD - 1) * 4 + 3] > 0)) return null;
    ends.push(a[(MPD - 1) * 4 + 3] / 100);
  }
  const res = { entry: fills.map((l) => ({ s: l.strike, t: l.type, d: l.dir * l.qty, px: l.open, e: l.expiry })), fsp: r2(fsp) };
  res.eo = r2(fills.reduce((cash, l) => cash - l.dir * l.qty * l.open, 0) + h._pv);
  let cash = 0;
  let pts = 0;
  let buy = 0;
  let sell = 0;
  let exercised = 0; // ₹ of intrinsic value on bought legs that settle in the money
  let later = 0; // ₹ of next-expiry legs sold at the near expiry
  fills.forEach((l, i) => {
    const turn = l.worst * l.qty * units;
    cash -= l.dir * l.qty * l.worst;
    pts += l.dir * l.qty * (ends[i] - l.worst);
    if (l.dir > 0) buy += turn;
    else sell += turn;
    if (l.expiry !== h.expiry) later += ends[i] * l.qty * units;
    else if (l.dir > 0) exercised += ends[i] * l.qty * units;
  });
  const costs =
    Costs.orders({ buy, sell, orders: fills.length, day: h.day, brokerage }) +
    Costs.exercise(exercised, h.expiry) +
    (later ? Costs.orders({ sell: later, orders: fills.filter((l) => l.expiry !== h.expiry).length, day: h.expiry, brokerage }) : 0);
  res.ew = r2(cash + h._pv);
  res.cost = Math.round(costs);
  res.lock = Math.round((cash + h._pv) * units - costs);
  res.net = Math.round(pts * units - costs);
  return res;
}

// Strike for a suggested leg: 'signal' = n strikes from the hit (or ref) strike; 'atm' = n strikes OTM.
function legStrike(def, h, ks, spot) {
  const near = (x) => ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(ks[b] - x) ? j : b), 0);
  const v = Math.round(def.strike.value || 0);
  if (def.strike.by === 'signal') {
    const base = def.strike.ref === 'ref' && h.ref != null ? h.ref : h.strike;
    return ks[Math.max(0, Math.min(ks.length - 1, near(base) + v))];
  }
  const i = near(spot) + (def.type === 'CE' ? 1 : -1) * v;
  return ks[Math.max(0, Math.min(ks.length - 1, i))];
}

// A relative-value occurrence: points made per 1-lot unit (Σ dir × lots × (exit − entry)) by its suggested trade at
// each horizon, entered at the next minute's open; `net` = ₹ on `lots` lots to the end of the window after the
// charges of entering and closing it.
async function outcome(data, cal, h, endM, { lots, brokerage }) {
  const m0 = h.m + 1;
  if (m0 > endM) return null;
  const legs = [];
  for (const def of h.legs) {
    const expiry = def.expiry === 'next' ? cal.all[cal.all.indexOf(h.expiry) + 1] : h.expiry;
    if (!expiry || !cal.expiredSet.has(expiry)) return null;
    const info = await data.contracts(expiry);
    const strike = legStrike(def, h, info.strikes, h.spot);
    const c = data.optionCached(expiry, strike, def.type, h.day) || (await data.option(expiry, strike, def.type, h.day));
    const a = data.optionDay(c, h.day);
    if (!a || !(a[m0 * 4] > 0)) return null;
    legs.push({ a, dir: def.action === 'B' ? 1 : -1, lots: def.lots || 1, entry: a[m0 * 4] / 100, strike, type: def.type, expiry });
  }
  const res = { entry: legs.map((l) => ({ s: l.strike, t: l.type, d: l.dir * l.lots, px: l.entry, e: l.expiry })) };
  for (const H of HORIZONS) {
    const m1 = H === 'eod' ? endM : Math.min(endM, m0 + H);
    if (H !== 'eod' && m0 + H > endM) {
      res[H] = null;
      continue;
    }
    res[H] = r2(legs.reduce((sum, l) => sum + l.dir * l.lots * (l.a[m1 * 4 + 3] / 100 - l.entry), 0));
  }
  // Best and worst point of the trade along the way to the end of the window.
  let best = -Infinity;
  let worst = Infinity;
  for (let m = m0; m <= endM; m++) {
    const v = legs.reduce((sum, l) => sum + l.dir * l.lots * (l.a[m * 4 + 3] / 100 - l.entry), 0);
    if (v > best) best = v;
    if (v < worst) worst = v;
  }
  res.best = r2(best);
  res.worst = r2(worst);
  const units = lots * h.lot;
  let buy = 0;
  let sell = 0;
  for (const l of legs) {
    const [inn, exit] = [l.entry * l.lots * units, (l.a[endM * 4 + 3] / 100) * l.lots * units];
    if (l.dir > 0) {
      buy += inn;
      sell += exit;
    } else {
      sell += inn;
      buy += exit;
    }
  }
  res.net = Math.round(res.eod * units - Costs.orders({ buy, sell, orders: 2 * legs.length, day: h.day, brokerage }));
  return res;
}

// An arbitrage occurrence that locked a profit at the worst traded prices of its own minute and of the next one.
const fillable = (h) => h.robust > 0 && h.out?.ew > 0;

// Per type. Arbitrage types: how many occurrences pass each check, the average edge at each set of prices, and for
// the fillable ones what they locked in and made at settlement after costs (`valid`).
// `late` = the counts for the last 30 % of the sessions, `dte0` for expiry days.
function summarise(hits, cut) {
  const by = {};
  const funnel = () => ({ hits: 0, fill: 0, pay: 0 });
  const count = (f, h) => {
    f.hits++;
    if (fillable(h)) {
      f.fill++;
      if (h.out.lock > 0) f.pay++;
    }
  };
  for (const h of hits) {
    const s = (by[h.type] ||= {
      type: h.type,
      cls: h.cls,
      hits: 0,
      days: new Set(),
      dirs: {},
      hours: {},
      h: {},
      robust: 0,
      entered: 0,
      fill: 0,
      pay: 0,
      sumEdge: 0,
      sumEo: 0,
      sumEw: 0,
      valid: { lock: 0, net: 0 },
      late: funnel(),
      dte0: funnel(),
      net: 0,
      netN: 0,
    });
    s.hits++;
    s.days.add(h.day);
    s.dirs[h.dir] = (s.dirs[h.dir] || 0) + 1;
    const hr = h.time.slice(0, 2);
    s.hours[hr] = (s.hours[hr] || 0) + 1;
    s.sumEdge += h.value;
    if (h.cls === 'arb') {
      if (h.robust > 0) s.robust++;
      if (cut && h.day >= cut) count(s.late, h);
      if (h.dte0) count(s.dte0, h);
      if (!h.out) continue;
      s.entered++;
      s.sumEo += h.out.eo;
      s.sumEw += h.out.ew;
      if (fillable(h)) {
        s.fill++;
        s.valid.lock += h.out.lock;
        s.valid.net += h.out.net;
        if (h.out.lock > 0) s.pay++;
      }
      continue;
    }
    if (h.out?.net != null) {
      s.net += h.out.net;
      s.netN++;
    }
    for (const H of HORIZONS) {
      const v = h.out?.[H];
      if (v == null) continue;
      const b = (s.h[H] ||= { n: 0, sum: 0, wins: 0 });
      b.n++;
      b.sum += v;
      if (v > 0) b.wins++;
    }
  }
  return Object.values(by).map((s) => ({
    type: s.type,
    cls: s.cls,
    hits: s.hits,
    days: s.days.size,
    dirs: s.dirs,
    hours: s.hours,
    avgEdge: r2(s.sumEdge / s.hits),
    ...(s.cls === 'arb'
      ? {
          robust: s.robust,
          entered: s.entered,
          fill: s.fill,
          pay: s.pay,
          avgEo: s.entered ? r2(s.sumEo / s.entered) : null,
          avgEw: s.entered ? r2(s.sumEw / s.entered) : null,
          valid: s.valid,
          late: s.late,
          dte0: s.dte0,
        }
      : {
          net: s.net,
          netN: s.netN,
          horizons: Object.fromEntries(
            HORIZONS.map((H) => {
              const b = s.h[H];
              return [H, b ? { n: b.n, avgPts: r2(b.sum / b.n), winRate: r2((b.wins / b.n) * 100) } : null];
            }),
          ),
        }),
  }));
}

// The occurrences a saved scan keeps: every fillable arbitrage (of a candle scan or of a quote scan, tapescan.js)
// and every relative-value one first, then the most recent of the rest, in time order.
function trim(hits, max = KEEP) {
  if (hits.length <= max) return hits;
  const keep = new Set(hits.filter((h) => h.cls !== 'arb' || fillable(h) || h.out?.at > 0).slice(-max));
  for (let i = hits.length - 1; i >= 0 && keep.size < max; i--) keep.add(hits[i]);
  return hits.filter((h) => keep.has(h));
}

module.exports = { runScan, legStrike, trim, HORIZONS };
