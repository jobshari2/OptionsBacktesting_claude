// Candles of a live Nifty option contract for the chart on the Chain screen: the last weeks of 1-minute candles from
// Upstox (history up to yesterday plus the running session), folded into the chart's timeframe. Same candle shape as
// the Nifty chart's /api/bt/candles: [time, open, high, low, close], time = IST wall-clock seconds (as if UTC).
const { istDate } = require('./time');

const OPEN_MIN = 9 * 60 + 15;
const MPD = 375;
const HISTORY_DAYS = 28; // the 1-minute history endpoint reaches back one month per request
const HISTORY_TTL_MS = 30 * 60_000;
const TODAY_TTL_MS = 15_000;
const STEPS = new Set([1, 3, 5, 10, 15, 60, 120]);
const OPT_TFS = new Set([...STEPS, 'D']);

const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

// rows = Upstox candles [timestamp, o, h, l, c, ...] in any order; tf = minutes per candle or 'D'.
function aggregate(rows, tf) {
  if (!OPT_TFS.has(tf === 'D' ? 'D' : Number(tf))) throw new Error('Unknown chart timeframe ' + tf);
  const step = Number(tf);
  const out = [];
  let curKey = null;
  let cur = null;
  for (const r of [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const day = r[0].slice(0, 10);
    const m = Number(r[0].slice(11, 13)) * 60 + Number(r[0].slice(14, 16)) - OPEN_MIN;
    if (m < 0 || m >= MPD) continue;
    const base = Date.parse(day + 'T00:00:00Z') / 1000;
    const b = tf === 'D' ? 0 : Math.floor(m / step) * step;
    const key = day + '|' + b;
    if (key !== curKey) {
      cur = [base + (tf === 'D' ? 0 : (OPEN_MIN + b) * 60), r[1], r[2], r[3], r[4]];
      out.push(cur);
      curKey = key;
      continue;
    }
    if (r[2] > cur[2]) cur[2] = r[2];
    if (r[3] < cur[3]) cur[3] = r[3];
    cur[4] = r[4];
  }
  for (const c of out) for (let i = 1; i < 5; i++) c[i] = r2(c[i]);
  return out;
}

// { prevClose, candles } for a response: prevClose = last close before the newest session.
function respond(rows, tf) {
  const candles = aggregate(rows, tf);
  const days = [...new Set(rows.map((r) => r[0].slice(0, 10)))].sort();
  const last = days[days.length - 1];
  const before = rows.filter((r) => r[0].slice(0, 10) < last).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const prev = before[before.length - 1];
  return {
    tf: String(tf),
    candles,
    more: false,
    first: days[0] || null,
    day: last || null,
    today: last === istDate(),
    prevClose: prev ? r2(prev[4]) : null,
  };
}

// Deterministic 1-minute candles for the demo server (no Upstox): a seeded random walk over the last few sessions
// that ends at the option's current price.
function demoRows(seed, ltp, now = Date.now()) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const today = istDate(now);
  const nowMin = Math.floor(((now + 19800_000) % 86400_000) / 60_000) - OPEN_MIN;
  const rows = [];
  for (let d = 3; d >= 0; d--) {
    const day = addDays(today, -d);
    const wd = new Date(day + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const upto = d === 0 ? Math.max(0, Math.min(MPD, nowMin + 1)) : MPD;
    for (let m = 0; m < upto; m++) {
      const t = OPEN_MIN + m;
      const ts = `${day}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00+05:30`;
      rows.push([ts, 0, 0, 0, 0]);
    }
  }
  // walk backwards from the current price
  let px = ltp;
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = px;
    const o = Math.max(0.05, c * (1 + (rnd() - 0.5) * 0.01));
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.max(0.05, Math.min(o, c) * (1 - rnd() * 0.004));
    rows[i] = [rows[i][0], o, h, l, c];
    px = o;
  }
  return rows;
}

// bulk(pathname) = the Upstox client's historical download (returns the response data).
function createOptionCandles({ bulk }) {
  const hist = new Map(); // key -> { at, rows }
  const today = new Map();
  const inflight = new Map();
  const once = (id, fn) => {
    if (inflight.has(id)) return inflight.get(id);
    const p = fn().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  };
  const rowsOf = (d) => (d?.candles || []).map((c) => c.slice(0, 5));

  async function history(key) {
    const h = hist.get(key);
    if (h && Date.now() - h.at < HISTORY_TTL_MS) return h.rows;
    return once('h|' + key, async () => {
      const t = istDate();
      let rows = [];
      try {
        const d = await bulk(`/v3/historical-candle/${encodeURIComponent(key)}/minutes/1/${addDays(t, -1)}/${addDays(t, -HISTORY_DAYS)}`);
        rows = rowsOf(d);
      } catch {
        /* a contract listed today has no history yet */
      }
      hist.set(key, { at: Date.now(), rows });
      return rows;
    });
  }
  async function intraday(key) {
    const h = today.get(key);
    if (h && Date.now() - h.at < TODAY_TTL_MS) return h.rows;
    return once('t|' + key, async () => {
      const rows = rowsOf(await bulk(`/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/1`));
      today.set(key, { at: Date.now(), rows });
      return rows;
    });
  }

  return {
    async candles(key, tf) {
      const [old, now] = await Promise.all([history(key), intraday(key).catch(() => [])]);
      const t = istDate();
      return respond(old.filter((r) => r[0].slice(0, 10) < t).concat(now.filter((r) => r[0].slice(0, 10) === t)), tf);
    },
  };
}

module.exports = { createOptionCandles, aggregate, respond, demoRows, OPT_TFS };
