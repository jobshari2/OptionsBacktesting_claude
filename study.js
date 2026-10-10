// Scorecard: does each reading actually point the right way? Uses a recorded day's tape.
//   node study.js 2026-10-01            (add --demo to read events-demo/)
// Every minute it takes each indicator's direction (up / down / no call) and checks Nifty's move over
// the next 5 and 15 minutes. An indicator only helps if it beats the "follow the 15-min trend"
// baseline across several different days — one trending day proves nothing.
const path = require('path');
const { readTape } = require('./tape');

const MIN = 60_000;
const NEAR = 5; // strikes either side of ATM for book / flow readings
const IST = 5.5 * 3600_000;

function study(dir, day) {
  const E = readTape(dir, day);
  if (!E.length) return null;
  const idxAt = (t) => { let lo = 0, hi = E.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].t >= t) hi = m; else lo = m + 1; } return lo; };
  const near = (e) => {
    const ks = Object.keys(e.d).map(Number).sort((a, b) => a - b);
    const atm = ks.reduce((b, k) => (Math.abs(k - e.spot) < Math.abs(b - e.spot) ? k : b), ks[0]);
    const i = ks.indexOf(atm);
    return ks.slice(Math.max(0, i - NEAR), i + NEAR + 1);
  };
  const bookShare = (e) => {
    let bull = 0, bear = 0, n = 0;
    for (const k of near(e)) {
      const v = e.d[k];
      if (!v || v.length < 18) continue;
      bull += v[12] + v[17]; // CE waiting to buy + PE waiting to sell
      bear += v[16] + v[13]; // PE waiting to buy + CE waiting to sell
      n++;
    }
    return n && bull + bear ? (bull / (bull + bear)) * 100 : null;
  };

  const rows = [];
  for (let t = E[0].t + 15 * MIN; t <= E[E.length - 1].t; t += MIN) {
    const e = E[idxAt(t)];
    const m1 = E[idxAt(t - MIN)];
    const m5 = E[idxAt(t - 5 * MIN)];
    const m15 = E[idxAt(t - 15 * MIN)];
    if (e.t - t > 5000 || e.t - m1.t < 45_000) continue;
    const f5 = E[idxAt(t + 5 * MIN)];
    const f15 = E[idxAt(t + 15 * MIN)];
    const out5 = f5.t - t >= 4.5 * MIN ? f5.spot - e.spot : null;
    const out15 = f15.t - t >= 14.5 * MIN ? f15.spot - e.spot : null;

    const tr = e.spot - m15.spot;
    const trend = Math.abs(tr) >= 10 ? Math.sign(tr) : 0;

    // aggressor flow and premium-direction flow over the last minute
    let aBull = 0, aBear = 0, pBull = 0, pBear = 0, hasAggr = false;
    for (const k of near(e)) {
      const a = m1.d[k], b = e.d[k];
      if (!a || !b) continue;
      const dce = Math.max(0, b[1] - a[1]), dpe = Math.max(0, b[4] - a[4]);
      if (a.length >= 10 && b.length >= 10) {
        hasAggr = true;
        aBull += Math.max(0, b[6] - a[6]) + Math.max(0, b[9] - a[9]);
        aBear += Math.max(0, b[8] - a[8]) + Math.max(0, b[7] - a[7]);
      }
      if (b[0] > a[0]) pBull += dce; else if (b[0] < a[0]) pBear += dce;
      if (b[3] > a[3]) pBear += dpe; else if (b[3] < a[3]) pBull += dpe;
    }
    const ratio = (x, y) => (x + y ? (x - y) / (x + y) : 0);
    const aggr = hasAggr ? ratio(aBull, aBear) : null;
    const prem = ratio(pBull, pBear);

    // order book: level vs its own 30-min average, and change over 5 minutes
    const bNow = bookShare(e);
    const bPrev = bookShare(m5);
    let bAvg = null;
    if (bNow != null) {
      const hist = [];
      for (let s = t - 30 * MIN; s < t - MIN; s += MIN) { const x = bookShare(E[idxAt(s)]); if (x != null) hist.push(x); }
      if (hist.length >= 10) bAvg = hist.reduce((a, b) => a + b, 0) / hist.length;
    }
    const sgn = (v, th) => (v == null ? null : Math.abs(v) >= th ? Math.sign(v) : 0);

    rows.push({
      t, out5, out15,
      trend,
      aggr: sgn(aggr, 0.2),
      prem: sgn(prem, 0.2),
      bookLevel: bAvg != null ? sgn(bNow - bAvg, 3) : null,
      bookChange: bNow != null && bPrev != null ? sgn(bNow - bPrev, 2) : null,
    });
  }
  return { E, rows };
}

function score(rows, get, horizon) {
  const r = rows.map((x) => ({ d: get(x), o: horizon === 5 ? x.out5 : x.out15 })).filter((x) => x.d && x.o != null);
  if (!r.length) return null;
  const right = r.filter((x) => Math.sign(x.o) === x.d).length;
  return { n: r.length, pct: (100 * right) / r.length, avg: r.reduce((s, x) => s + x.o * x.d, 0) / r.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!day) { console.log('Usage: node study.js YYYY-MM-DD [--demo]'); process.exit(1); }
  const dir = path.join(__dirname, args.includes('--demo') ? 'events-demo' : 'events');
  const res = study(dir, day);
  if (!res) { console.log(`No tape for ${day}`); process.exit(1); }
  const { E, rows } = res;
  const T = (t) => new Date(t + IST).toISOString().slice(11, 16);
  const cover = (k) => rows.filter((x) => x[k] != null).length;
  console.log(`${day}: tape ${T(E[0].t)}–${T(E[E.length - 1].t)}, Nifty ${E[0].spot} → ${E[E.length - 1].spot}, ${rows.length} minutes scored`);
  console.log(`Data available: aggressor flow ${cover('aggr')} min, order book ${cover('bookLevel')} min\n`);
  const agree = (a, b) => (x) => (x[a] && x[a] === x[b] ? x[a] : 0);
  const tests = [
    ['Baseline: follow the 15-min trend', (x) => x.trend],
    ['Baseline: fade the 15-min trend', (x) => -x.trend],
    ['Order flow (aggressor, bid/ask)', (x) => x.aggr],
    ['Order flow (premium direction)', (x) => x.prem],
    ['Order book vs its 30-min average', (x) => x.bookLevel],
    ['Order book change over 5 min', (x) => x.bookChange],
    ['Trend + aggressor flow agree', agree('trend', 'aggr')],
    ['Trend + order book agree', agree('trend', 'bookLevel')],
    ['Trend + book change agree', agree('trend', 'bookChange')],
    ['Aggressor flow + order book agree', agree('aggr', 'bookLevel')],
  ];
  console.log('Indicator                              calls  right 5m  avg pts | calls  right 15m  avg pts');
  for (const [name, get] of tests) {
    const a = score(rows, get, 5), b = score(rows, get, 15);
    const f = (s) => (s ? `${String(s.n).padStart(5)}  ${s.pct.toFixed(0).padStart(7)}%  ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(1)}`.padEnd(24) : '    —  (no data)'.padEnd(24));
    console.log(`${name.padEnd(38)} ${f(a)} | ${f(b)}`);
  }
  console.log('\n"right" = Nifty moved the indicated way; "avg pts" = average move in the indicated direction.');
  console.log('An indicator helps only if it beats the follow-trend baseline on many different days.');
}

module.exports = { study };
