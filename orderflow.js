// Order flow of the Nifty options, one row per minute, and a plain-language read of it.
//
// Nifty itself is an index (no volume), so the flow is read from the options near the money: every trade the tick feed
// classifies as buyer- or seller-initiated (entry fields [6-9]: ceBuy, ceSell, peBuy, peSell, cumulative per strike).
// Calls bought and puts sold lean the market up; calls sold and puts bought lean it down:
//     delta = (ceBuy - ceSell) - (peBuy - peSell)
// The queue of orders waiting in the book ([12],[13],[16],[17]) gives the "book lean" (share of resting quantity that
// is bullish), averaged over the minute. Today comes from the live snapshots, earlier days from the recorded tape
// (streamed from disk in the background and cached as a small file per day).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const { IST_OFFSET, istDate } = require('./lib/time');
const { tapeDays } = require('./tape');

const MIN = 60_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const CACHE_VERSION = 2;

const netOf = (r) => r.cb - r.cs - (r.pb - r.ps);
const totalOf = (r) => r.cb + r.cs + r.pb + r.ps;
const round1 = (x) => Math.round(x * 10) / 10;

// Folds snapshots (oldest first) into minute rows { t, cb, cs, pb, ps, bull, h, l, c }: traded quantity by side for
// calls and puts, the minute's average book lean (%), and Nifty's high / low / close in it.
function createAggregator({ strikesAround = 10, pressureStrikes = 5 } = {}) {
  const rows = new Map(); // minute start (ms) -> row
  let prev = null; // { t, x, cum: { strike: [ceBuy, ceSell, peBuy, peSell] } }
  let lastT = 0;
  let day = null;

  function add(e) {
    if (e.t <= lastT) return;
    lastT = e.t;
    const dd = istDate(e.t);
    if (day !== dd) {
      day = dd;
      rows.clear();
      prev = null;
    }
    const ks = Object.keys(e.d)
      .map(Number)
      .filter((k) => e.d[k]?.length >= 10)
      .sort((a, b) => a - b);
    if (!ks.length) {
      prev = null;
      return;
    }
    const cum = {};
    for (const k of ks) cum[k] = e.d[k].slice(6, 10);
    const atm = ks.reduce((b, k) => (e.spot != null && Math.abs(k - e.spot) < Math.abs(b - e.spot) ? k : b), ks[0]);
    const ai = ks.indexOf(atm);

    const ist = new Date(e.t + IST_OFFSET);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const inHours = mins >= OPEN_MIN && mins < CLOSE_MIN;
    const m = Math.floor(e.t / MIN) * MIN;
    let r = rows.get(m);
    if (inHours && !r) {
      r = { t: m, cb: 0, cs: 0, pb: 0, ps: 0, bs: 0, bn: 0, h: null, l: null, c: null, px: {} };
      rows.set(m, r);
    }

    // a new expiry, or a pause long enough for counters to have restarted, has nothing to compare with
    const comparable = prev && !(prev.x && e.x && prev.x !== e.x) && e.t - prev.t <= 30_000;
    let bull = 0;
    let bear = 0;
    const inc = [0, 0, 0, 0]; // what this snapshot added: ceBuy, ceSell, peBuy, peSell
    for (let i = Math.max(0, ai - strikesAround); i <= Math.min(ks.length - 1, ai + strikesAround); i++) {
      const k = ks[i];
      const v = e.d[k];
      const p = comparable ? prev.cum[k] : null;
      if (r && p) {
        for (let j = 0; j < 4; j++) inc[j] += Math.max(0, v[6 + j] - p[j]);
      }
      if (Math.abs(i - ai) <= pressureStrikes && v.length >= 18) {
        bull += v[12] + v[17];
        bear += v[16] + v[13];
      }
    }
    if (r) {
      r.cb += inc[0];
      r.cs += inc[1];
      r.pb += inc[2];
      r.ps += inc[3];
      // the footprint: the same volume by the Nifty level (whole points) it traded at
      if (e.spot != null && inc.some((x) => x > 0)) {
        const px = (r.px[Math.floor(e.spot)] ||= [0, 0, 0, 0]);
        for (let j = 0; j < 4; j++) px[j] += inc[j];
      }
      if (bull + bear > 0) {
        r.bs += (bull / (bull + bear)) * 100;
        r.bn++;
      }
      if (e.spot != null) {
        r.h = r.h == null ? e.spot : Math.max(r.h, e.spot);
        r.l = r.l == null ? e.spot : Math.min(r.l, e.spot);
        r.c = e.spot;
      }
    }
    prev = { t: e.t, x: e.x, cum };
  }

  return {
    add,
    rows: () =>
      [...rows.values()]
        .sort((a, b) => a.t - b.t)
        .map((r) => ({ t: r.t, cb: r.cb, cs: r.cs, pb: r.pb, ps: r.ps, bull: r.bn ? round1(r.bs / r.bn) : null, h: r.h, l: r.l, c: r.c, px: r.px })),
  };
}

// A minute's volume by Nifty level, flattened for the wire: [price, ceBuy, ceSell, peBuy, peSell, price, ...], by price.
const footprint = (px) =>
  Object.keys(px || {})
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((k) => [k, ...px[k]]);

// ---------- the read ----------
const sumRows = (rows) => {
  const s = { cb: 0, cs: 0, pb: 0, ps: 0 };
  for (const r of rows) {
    s.cb += r.cb;
    s.cs += r.cs;
    s.pb += r.pb;
    s.ps += r.ps;
  }
  const net = netOf(s);
  const total = totalOf(s);
  return { ...s, net, total, bias: total ? net / total : 0 };
};
const WINDOWS = [
  ['1 min', 1],
  ['5 min', 5],
  ['15 min', 15],
  ['30 min', 30],
];
const fmtQty = (x) => {
  const a = Math.abs(x);
  const s = a >= 1e5 ? (a / 1e5).toFixed(2) + 'L' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : String(Math.round(a));
  return (x < 0 ? '−' : x > 0 ? '+' : '') + s;
};
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`;

// What the flow of one session (minute rows, oldest first) says right now.
function analyse(all, { lot = 65 } = {}) {
  const q = (x) => fmtQty(x / lot); // quantities are read in lots
  const rows = all.filter((r) => r.c != null || totalOf(r) > 0);
  const n = rows.length;
  if (n < 2) return { ready: false, minutes: n, note: 'Collecting order flow: the verdict needs a few minutes of trades.' };
  const last = rows[n - 1];
  const from = (mins) => rows.filter((r) => r.t > last.t - mins * MIN);
  const windows = WINDOWS.map(([label, w]) => ({ label, ...sumRows(from(w)) }));
  windows.push({ label: 'Session', ...sumRows(rows) });
  const [, w5, w15, w30] = windows;
  const minTotal = lot * 200; // 200 lots: thinner than this and a "bias" is just noise
  const biasOf = (w) => (w.total >= minTotal ? w.bias : 0);

  const recentBull = rows
    .slice(-3)
    .map((r) => r.bull)
    .filter((x) => x != null);
  const book = recentBull.length ? recentBull.reduce((a, b) => a + b, 0) / recentBull.length : null;
  const bookLean = book == null ? 0 : (book - 50) / 50;
  const bookAvg = rows.map((r) => r.bull).filter((x) => x != null);
  const bookNorm = bookAvg.length > 5 ? bookAvg.reduce((a, b) => a + b, 0) / bookAvg.length : 50;

  // price and cumulative delta by minute
  let cvd = 0;
  const series = rows.map((r) => ({ t: r.t, c: r.c, h: r.h ?? r.c, l: r.l ?? r.c, cvd: (cvd += netOf(r)) }));
  const priceAt = (mins) => {
    const s = series.filter((x) => x.c != null && x.t <= last.t - mins * MIN);
    return s.length ? s[s.length - 1].c : null;
  };
  const lastPx = [...series].reverse().find((x) => x.c != null)?.c ?? null;
  const chg = (mins) => {
    const p = priceAt(mins);
    return p == null || lastPx == null ? null : lastPx - p;
  };
  // typical 5-minute move of this session, to tell a quiet tape from a moving one
  const moves5 = [];
  for (let i = 5; i < series.length; i += 5) if (series[i].c != null && series[i - 5].c != null) moves5.push(Math.abs(series[i].c - series[i - 5].c));
  const typ5 = moves5.length >= 4 ? Math.max(2, moves5.reduce((a, b) => a + b, 0) / moves5.length) : 8;
  const chg5 = chg(5);
  const chg15 = chg(15);

  const flow = 0.45 * biasOf(w5) + 0.35 * biasOf(w15) + 0.2 * biasOf(w30);
  const score = Math.max(-1, Math.min(1, 0.8 * flow * 3 + 0.2 * bookLean)); // flow bias seldom passes ±0.3: scale it up
  const tone = score >= 0.1 ? 'bull' : score <= -0.1 ? 'bear' : 'neutral';
  const label =
    score >= 0.45
      ? 'Buyers firmly in control'
      : score >= 0.2
        ? 'Buyers in control'
        : score >= 0.1
          ? 'Slight buying lean'
          : score <= -0.45
            ? 'Sellers firmly in control'
            : score <= -0.2
              ? 'Sellers in control'
              : score <= -0.1
                ? 'Slight selling lean'
                : 'Balanced: no side in control';

  const reasons = [];
  const side = (w) => {
    const calls = w.cb - w.cs;
    const puts = w.pb - w.ps;
    const driver = Math.abs(calls) >= Math.abs(puts) ? 'calls' : 'puts';
    const what =
      driver === 'calls' ? (calls >= 0 ? 'calls are being bought' : 'calls are being sold') : puts >= 0 ? 'puts are being bought' : 'puts are being sold';
    return `${what} (calls ${q(calls)}, puts ${q(puts)} lots net)`;
  };
  if (w15.total >= minTotal) {
    const t = w15.bias >= 0.05 ? 'bull' : w15.bias <= -0.05 ? 'bear' : 'neutral';
    reasons.push({
      tone: t,
      title: t === 'bull' ? 'Net buying flow' : t === 'bear' ? 'Net selling flow' : 'Flow is even',
      text: `Delta ${q(w15.net)} lots over 15 min (${pct(w15.bias)} of ${q(w15.total).replace(/^\+/, '')} lots traded); ${side(w15)}. Last 5 min: ${q(w5.net)} lots (${pct(w5.bias)}).`,
    });
  } else
    reasons.push({
      tone: 'neutral',
      title: 'Thin trading',
      text: `Only ${q(w15.total).replace(/^\+/, '')} lots traded near the money in 15 min, too little to lean on.`,
    });

  if (book != null) {
    const d = book - bookNorm;
    const t = book >= 55 ? 'bull' : book <= 45 ? 'bear' : 'neutral';
    reasons.push({
      tone: t,
      title: t === 'bull' ? 'Order book leans bullish' : t === 'bear' ? 'Order book leans bearish' : 'Order book is even',
      text: `${book.toFixed(0)}% of the quantity resting near the money is bullish (calls bid / puts offered)${Math.abs(d) >= 2 ? `, ${Math.abs(d).toFixed(0)} points ${d > 0 ? 'above' : 'below'} today's average` : ''}.`,
    });
  }

  // flow against price: does the move have the flow behind it?
  const flags = { divergence: null, absorption: null };
  const recent = series.filter((x) => x.t > last.t - 15 * MIN);
  const ref = series.filter((x) => x.t <= last.t - 15 * MIN && x.t > last.t - 45 * MIN);
  if (recent.length >= 8 && ref.length >= 10) {
    const hi = (a) => Math.max(...a.map((x) => x.h));
    const lo = (a) => Math.min(...a.map((x) => x.l));
    const cMax = (a) => Math.max(...a.map((x) => x.cvd));
    const cMin = (a) => Math.min(...a.map((x) => x.cvd));
    const span = Math.max(cMax(series.slice(-45)) - cMin(series.slice(-45)), lot * 5);
    const eps = 0.08 * span;
    if (hi(recent) > hi(ref) && cMax(recent) < cMax(ref) - eps) flags.divergence = 'bear';
    else if (lo(recent) < lo(ref) && cMin(recent) > cMin(ref) + eps) flags.divergence = 'bull';
  }
  if (flags.divergence === 'bear')
    reasons.push({
      tone: 'bear',
      title: 'Bearish divergence',
      text: 'Nifty made a new high in the last 15 min but the cumulative flow did not: the rise is not being bought. A weaker rise can fade.',
    });
  else if (flags.divergence === 'bull')
    reasons.push({
      tone: 'bull',
      title: 'Bullish divergence',
      text: 'Nifty made a new low in the last 15 min but the cumulative flow did not: the fall is not being sold. Selling pressure may be running out.',
    });

  const avg5Total = (w) => (n >= 10 ? (w.total / n) * 5 : 0);
  const busy = avg5Total(windows[4]) > 0 && w5.total >= 1.3 * avg5Total(windows[4]);
  if (busy && chg5 != null && Math.abs(w5.bias) >= 0.12) {
    if (w5.bias > 0 && chg5 <= 0.3 * typ5) flags.absorption = 'bear';
    else if (w5.bias < 0 && chg5 >= -0.3 * typ5) flags.absorption = 'bull';
  }
  if (flags.absorption === 'bear')
    reasons.push({
      tone: 'bear',
      title: 'Buying is being absorbed',
      text: `Heavy buying flow (${q(w5.net)} lots in 5 min, ${(w5.total / avg5Total(windows[4])).toFixed(1)}× the usual pace) but Nifty moved only ${chg5 >= 0 ? '+' : '−'}${Math.abs(chg5).toFixed(1)} pts: sellers are soaking it up.`,
    });
  else if (flags.absorption === 'bull')
    reasons.push({
      tone: 'bull',
      title: 'Selling is being absorbed',
      text: `Heavy selling flow (${q(w5.net)} lots in 5 min, ${(w5.total / avg5Total(windows[4])).toFixed(1)}× the usual pace) but Nifty moved ${chg5 >= 0 ? '+' : '−'}${Math.abs(chg5).toFixed(1)} pts: buyers are soaking it up.`,
    });

  if (!flags.divergence && !flags.absorption && chg15 != null && w15.total >= minTotal) {
    const agree = Math.sign(chg15) === Math.sign(w15.net) && Math.abs(chg15) >= 0.5 * typ5 && Math.abs(w15.bias) >= 0.05;
    const clash = Math.sign(chg15) !== Math.sign(w15.net) && Math.abs(chg15) >= typ5 && Math.abs(w15.bias) >= 0.05;
    if (agree)
      reasons.push({
        tone: chg15 > 0 ? 'bull' : 'bear',
        title: 'Flow confirms price',
        text: `Nifty ${chg15 > 0 ? 'rose' : 'fell'} ${Math.abs(chg15).toFixed(1)} pts in 15 min with the flow behind it.`,
      });
    else if (clash)
      reasons.push({
        tone: chg15 > 0 ? 'bear' : 'bull',
        title: 'Flow disagrees with price',
        text: `Nifty ${chg15 > 0 ? 'rose' : 'fell'} ${Math.abs(chg15).toFixed(1)} pts in 15 min against the flow: the move may not hold.`,
      });
  }

  return {
    ready: true,
    minutes: n,
    asOf: last.t,
    verdict: { label, tone, score: round1(score * 100) / 100, strength: Math.round(Math.abs(score) * 100) },
    reasons,
    flags,
    windows,
    book: book == null ? null : round1(book),
    cvd: series[series.length - 1].cvd,
    chg5: chg5 == null ? null : round1(chg5),
    chg15: chg15 == null ? null : round1(chg15),
  };
}

// ---------- recorded days ----------
// Streams one day's tape (all its part files) through an aggregator without loading it into memory.
async function readDay(dir, day, cfg) {
  const folder = path.join(dir, day);
  const parts = fs
    .readdirSync(folder)
    .filter((f) => /^tape-\d{6}\.jsonl\.gz$/.test(f))
    .sort();
  const agg = createAggregator(cfg);
  for (const f of parts) {
    const dec = new StringDecoder('utf8');
    let rest = '';
    const eat = (line) => {
      if (!line) return;
      try {
        agg.add(JSON.parse(line));
      } catch {
        /* partial last line */
      }
    };
    try {
      await pipeline(fs.createReadStream(path.join(folder, f)), zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }), async (source) => {
        for await (const chunk of source) {
          rest += dec.write(chunk);
          const lines = rest.split('\n');
          rest = lines.pop();
          lines.forEach(eat);
        }
      });
    } catch {
      /* a part cut off mid-write: keep what was read */
    }
    eat(rest + dec.end());
  }
  return agg.rows();
}

function createOrderflow({ dir, strikesAround = 10, pressureStrikes = 5, days = 10, getLot = () => 65, logError = () => {} }) {
  const cfg = { strikesAround, pressureStrikes };
  const live = createAggregator(cfg);
  const past = new Map(); // day -> rows
  const cacheDir = path.join(dir, '_orderflow-cache');
  let loading = null;

  async function loadDay(day) {
    const file = path.join(cacheDir, day + '.json');
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c.v === CACHE_VERSION && c.strikes === strikesAround && c.pressure === pressureStrikes) return c.rows;
    } catch {
      /* not cached yet */
    }
    const rows = await readDay(dir, day, cfg);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, strikes: strikesAround, pressure: pressureStrikes, rows }));
    } catch (e) {
      logError('orderflow-cache', e);
    }
    return rows;
  }

  // Reads the recorded days before today, newest first, one at a time in the background.
  function ensurePast() {
    if (loading) return loading;
    const today = istDate();
    const want = tapeDays(dir)
      .filter((d) => d < today)
      .slice(0, days)
      .filter((d) => !past.has(d));
    if (!want.length) return null;
    loading = (async () => {
      for (const d of want) {
        try {
          past.set(d, await loadDay(d));
        } catch (e) {
          logError('orderflow', e);
          past.set(d, []);
        }
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  return {
    seed(entries) {
      for (const e of entries) live.add(e);
    },
    update(entry) {
      live.add(entry);
    },
    // Minute rows from `since` (ms) on: the recorded days before today that are ready, then today.
    // `analysis` reads the latest session that has flow in it.
    state(since = 0) {
      ensurePast();
      const today = istDate();
      const todayRows = live.rows();
      const have = [...past.keys()].filter((d) => d < today && past.get(d).length).sort();
      const out = [];
      for (const d of have) for (const r of past.get(d)) if (r.t >= since) out.push(r);
      for (const r of todayRows) if (r.t >= since) out.push(r);
      const sessionRows = todayRows.length ? todayRows : have.length ? past.get(have[have.length - 1]) : [];
      const sessionDay = todayRows.length ? today : have[have.length - 1] || null;
      const lastDay = tapeDays(dir).filter((d) => d < today)[0];
      return {
        lot: getLot(),
        today,
        days: have.concat(todayRows.length ? [today] : []),
        pending: Boolean(loading) || (days > 0 && Boolean(lastDay) && !past.has(lastDay)),
        rows: out.map((r) => [r.t, r.cb, r.cs, r.pb, r.ps, r.bull, r.c, footprint(r.px)]),
        analysis: { day: sessionDay, ...analyse(sessionRows, { lot: getLot() }) },
      };
    },
    whenReady: () => ensurePast() || Promise.resolve(),
  };
}

module.exports = { createAggregator, createOrderflow, analyse, netOf, readDay };
