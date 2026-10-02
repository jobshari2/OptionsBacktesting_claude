// Historical chain contexts: the chain of an expiry at any minute of a past day, rebuilt from cached
// 1-minute candles, for the anomaly detectors (the history scanner and backtest entry conditions).
//
// A strike's price at minute m is that minute's close, but only if the contract actually traded within the
// last `fresh` minutes — a stale last price would otherwise look like a mispricing. Each price also carries
// its age (minutes since the last trade) so the arbitrage detectors can insist on fresher prints.
const { Chain, tradingYears } = require('./anomalies');
const { MPD } = require('./data');

function createHistChain(data, { band = 12, fresh = 3 } = {}) {
  const states = new Map(); // `${expiry}|${day}|${width}` -> state, small LRU
  let tradingDays = [];
  const rvMemo = new Map();

  function setDays(days) { tradingDays = days; }

  // Annualised realised vol of Nifty from 5-minute returns plus the overnight gap, over the n sessions
  // before `day`.
  function rv(day, n) {
    const key = day + '|' + n;
    if (rvMemo.has(key)) return rvMemo.get(key);
    let i = tradingDays.indexOf(day);
    if (i < 0) i = tradingDays.findIndex((d) => d > day);
    if (i < 0) i = tradingDays.length;
    let ss = 0;
    let cnt = 0;
    let lastClose = null;
    for (let j = Math.max(0, i - n - 1); j < i; j++) {
      const a = data.spotDay(tradingDays[j]);
      if (!a) { lastClose = null; continue; }
      const gapFrom = lastClose;
      lastClose = a[(MPD - 1) * 4 + 3];
      if (j < i - n) continue;
      let dayVar = gapFrom ? Math.log(a[0] / gapFrom) ** 2 : 0;
      for (let m = 5; m < MPD; m += 5) {
        const r = Math.log(a[m * 4 + 3] / a[(m - 5) * 4 + 3]);
        dayVar += r * r;
      }
      ss += dayVar;
      cnt++;
    }
    const v = cnt >= 2 ? Math.sqrt((ss / cnt) * 252) : null;
    rvMemo.set(key, v);
    if (rvMemo.size > 5000) rvMemo.delete(rvMemo.keys().next().value);
    return v;
  }

  // Load the strikes of `expiry` that come within `width` strikes of ATM during `day`.
  async function load(expiry, day, { width = band, withNext = null } = {}) {
    const id = `${expiry}|${day}|${width}`;
    if (states.has(id)) {
      const s = states.get(id);
      if (withNext && !s.next) s.next = await load(withNext, day, { width: 6 });
      return s;
    }
    const sp = data.spotDay(day);
    if (!sp) return null;
    const info = await data.contracts(expiry);
    let lo = Infinity;
    let hi = -Infinity;
    for (let m = 0; m < MPD; m++) { lo = Math.min(lo, sp[m * 4 + 2]); hi = Math.max(hi, sp[m * 4 + 1]); }
    const all = info.strikes;
    const near = (x) => all.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(all[b] - x) ? j : b), 0);
    const ks = all.slice(Math.max(0, near(lo) - width), near(hi) + width + 1);
    const tasks = ks.flatMap((k) => ['CE', 'PE'].map((t) => [k, t]));
    const got = new Map();
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const [k, t] = tasks[next++];
        const c = data.optionCached(expiry, k, t, day) || (await data.option(expiry, k, t, day).catch(() => null));
        got.set(k + t, c);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    // Per strike and side: close per minute (0 where it hasn't traded within `fresh` minutes) and the
    // minutes since its last trade.
    const series = (c) => {
      const px = new Float64Array(MPD);
      const age = new Int16Array(MPD).fill(999);
      const a = c && data.optionDay(c, day);
      const raw = c && data.optionRaw(c, day);
      if (!a || !raw) return { px, age };
      let last = -1e4;
      for (let m = 0; m < MPD; m++) {
        if (raw[m * 4] !== -1) last = m;
        age[m] = Math.min(999, m - last);
        if (m - last <= fresh && a[m * 4 + 3] > 0) px[m] = a[m * 4 + 3] / 100;
      }
      return { px, age };
    };
    const ce = ks.map((k) => series(got.get(k + 'CE')));
    const pe = ks.map((k) => series(got.get(k + 'PE')));
    const s = { expiry, day, ks, ce, pe, sp, ctx: new Map(), next: null };
    if (withNext) s.next = await load(withNext, day, { width: 6 });
    states.set(id, s);
    while (states.size > 6) states.delete(states.keys().next().value);
    return s;
  }

  // Chain at the close of minute m (that minute's closing prices; time to expiry from the end of it).
  function ctxAt(s, m) {
    if (!s || m < 0 || m >= MPD) return null;
    let c = s.ctx.get(m);
    if (c) return c;
    c = new Chain({
      spot: s.sp[m * 4 + 3],
      T: tradingYears(s.expiry, s.day, m + 1),
      ks: s.ks,
      ce: s.ce.map((x) => x.px[m]),
      pe: s.pe.map((x) => x.px[m]),
      ageCe: s.ce.map((x) => x.age[m]),
      agePe: s.pe.map((x) => x.age[m]),
      expiry: s.expiry,
      day: s.day,
      minute: m,
      open: s.sp[0],
      prev: (n) => ctxAt(s, m - n),
      next: () => (s.next ? ctxAt(s.next, m) : null),
      rv: (n) => rv(s.day, n),
      dayIv: () => ctxAt(s, 5)?.atmIv() ?? null,
    });
    s.ctx.set(m, c);
    return c;
  }

  return { load, ctxAt, setDays, rv };
}

module.exports = { createHistChain };
