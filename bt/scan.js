// History scan: run the anomaly detectors over every minute of past sessions (on the nearest weekly
// expiry's chain), record each anomaly once per cooldown, and measure what its suggested trade would have
// made after 5 / 15 / 30 / 60 minutes and at the end of the scan window — entered at the next minute's open,
// exited at the horizon's close, before costs and without stops. For full simulation with stops, costs and
// re-entries, turn an anomaly into a strategy and backtest it.
const A = require('./anomalies');
const { MPD, addDays } = require('./data');

const HORIZONS = [5, 15, 30, 60, 'eod'];
const MIN_OF = (t) => {
  const [h, m] = String(t || '09:15').split(':').map(Number);
  return Math.max(0, Math.min(MPD - 1, h * 60 + m - 555));
};

async function runScan(data, hist, raw, onProgress = () => {}) {
  const cal = await data.expiryCalendar();
  if (!cal.expired.length) throw new Error('Upstox returned no expired Nifty expiries');
  const last = cal.expired[cal.expired.length - 1];
  const to = raw.to && raw.to < last ? raw.to : last;
  const from = raw.from || addDays(to, -30);
  const types = (raw.types || []).filter((t) => A.BY_ID.has(t.id)).map((t) => ({
    id: t.id, def: A.BY_ID.get(t.id), params: A.params(t.id, t.params),
    cooldown: Number(t.params?.cooldown) > 0 ? Number(t.params.cooldown) : A.BY_ID.get(t.id).cooldown,
    side: t.side || 'any', dir: t.dir || 'any',
  }));
  if (!types.length) throw new Error('Pick at least one anomaly type');
  const startM = MIN_OF(raw.start || '09:20');
  const endM = Math.max(startM + 1, MIN_OF(raw.end || '15:15'));
  const step = Math.max(1, Math.min(15, Math.round(Number(raw.step) || 1)));
  const lot = Math.max(1, Number(raw.lotSize) || cal.liveLot || 65);
  const wanted = Array.isArray(raw.expiries) && raw.expiries.length ? new Set(raw.expiries) : null;
  const needNext = types.some((t) => t.def.needsNext) || types.some((t) => A.suggest({ type: t.id, dir: t.def.dirs[0] }, t.params).legs.some((l) => l.expiry === 'next'));

  onProgress({ phase: 'Loading Nifty history', done: 0, total: 0 });
  const days = await data.loadIndex(addDays(from, -30), to);
  hist.setDays(days);
  const scanDays = days.filter((d) => d >= from && d <= to);
  const hits = [];
  const skipped = [];
  let done = 0;

  for (const day of scanDays) {
    onProgress({ phase: `Scanning ${day}`, done, total: scanDays.length, api: data.apiStats() });
    done++;
    const ei = cal.all.findIndex((e) => e >= day);
    const exp = cal.all[ei];
    if (!exp || !cal.expiredSet.has(exp)) { skipped.push({ day, reason: 'expiry not yet expired' }); continue; }
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
    if (!s) { skipped.push({ day, reason: 'no Nifty data' }); continue; }
    const lastSeen = new Map();
    for (let m = startM; m <= endM; m += step) {
      const ctx = hist.ctxAt(s, m);
      for (const t of types) {
        let found = A.detect(t.id, ctx, t.params).filter((h) => (t.side === 'any' || h.side === t.side) && (t.dir === 'any' || h.dir === t.dir));
        for (const h of found.slice(0, 3)) {
          const key = `${h.type}|${h.side}|${h.dir}|${h.strike}`;
          if (m - (lastSeen.get(key) ?? -1e9) < t.cooldown) { lastSeen.set(key, m); continue; }
          lastSeen.set(key, m);
          const sug = A.suggest(h, t.params);
          hits.push({ day, m, time: hhmm(m), expiry: exp, spot: r2(ctx.spot), atmIv: ctx.atmIv() ? r2(ctx.atmIv() * 100) : null, ...pick(h), legs: sug.legs, _s: s, _next: withNext });
        }
      }
    }
  }

  // ---- outcomes of the suggested trades ----
  onProgress({ phase: 'Measuring outcomes', done: 0, total: hits.length, api: data.apiStats() });
  let k = 0;
  for (const h of hits) {
    h.out = await outcome(data, cal, h, endM).catch(() => null);
    delete h._s;
    delete h._next;
    if (++k % 50 === 0) onProgress({ phase: 'Measuring outcomes', done: k, total: hits.length, api: data.apiStats() });
  }

  return { opts: { from, to, start: hhmm(startM), end: hhmm(endM), step, lot, types: types.map((t) => ({ id: t.id, params: t.params, cooldown: t.cooldown, side: t.side, dir: t.dir })) }, days: scanDays.length, hits, summary: summarise(hits, lot), skipped: skipped.slice(0, 100), horizons: HORIZONS };
}

const r2 = (x) => Math.round(x * 100) / 100;
const hhmm = (m) => { const t = m + 555; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const pick = (h) => ({ type: h.type, strike: h.strike, ref: h.ref ?? null, side: h.side, dir: h.dir, value: r2(h.value), unit: h.unit, text: h.text, arb: Boolean(h.arb), ...(h.fair != null ? { fair: h.fair, mkt: h.mkt, pct: h.pct } : {}) });

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

// Points made per 1-lot unit (Σ dir × lots × (exit − entry)) at each horizon.
async function outcome(data, cal, h, endM) {
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
  const res = { entry: legs.map((l) => ({ s: l.strike, t: l.type, d: l.dir * l.lots, px: l.entry })) };
  for (const H of HORIZONS) {
    const m1 = H === 'eod' ? endM : Math.min(endM, m0 + H);
    if (H !== 'eod' && m0 + H > endM) { res[H] = null; continue; }
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
  return res;
}

function summarise(hits, lot) {
  const by = {};
  for (const h of hits) {
    const s = (by[h.type] ||= { type: h.type, hits: 0, days: new Set(), dirs: {}, hours: {}, h: {} });
    s.hits++;
    s.days.add(h.day);
    s.dirs[h.dir] = (s.dirs[h.dir] || 0) + 1;
    const hr = h.time.slice(0, 2);
    s.hours[hr] = (s.hours[hr] || 0) + 1;
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
    type: s.type, hits: s.hits, days: s.days.size, dirs: s.dirs, hours: s.hours,
    horizons: Object.fromEntries(HORIZONS.map((H) => {
      const b = s.h[H];
      return [H, b ? { n: b.n, avgPts: r2(b.sum / b.n), winRate: r2((b.wins / b.n) * 100), totalInr: Math.round(b.sum * lot) } : null];
    })),
  }));
}

module.exports = { runScan, legStrike, HORIZONS };
