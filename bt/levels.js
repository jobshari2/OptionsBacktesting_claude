// Nifty support / resistance from price history, without look-ahead: levels for a day only use
// sessions before it.
//
//   Major: swing highs/lows of daily bars over the last MAJOR_DAYS sessions, clustered (≈0.35%),
//          ranked by how many times price turned there and how recently.
//   Minor: swing points of 15-minute bars over the last MINOR_DAYS sessions, clustered (≈0.12%),
//          plus the previous session's high / low / close and its floor pivots (P, R1, S1, R2, S2).
//
// A level is support when it is below the current spot and resistance when above, so the same
// level flips role once it is crossed.
const MPD = 375;

const DEFAULTS = {
  majorDays: 120, majorTol: 0.0035, majorWing: 3, majorMax: 10, majorRange: 0.08,
  minorDays: 5, minorTol: 0.0012, minorWing: 2, minorMax: 12, minorRange: 0.03, barMin: 15,
};

function bar(a, from = 0, to = MPD) {
  let h = -Infinity;
  let l = Infinity;
  for (let m = from; m < to; m++) {
    if (a[m * 4 + 1] > h) h = a[m * 4 + 1];
    if (a[m * 4 + 2] < l) l = a[m * 4 + 2];
  }
  return { o: a[from * 4], h, l, c: a[(to - 1) * 4 + 3] };
}

// Bars whose high (low) is the highest (lowest) of `w` bars either side.
function swings(bars, w) {
  const out = [];
  for (let i = w; i < bars.length - w; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - w; j <= i + w && (hi || lo); j++) {
      if (j === i) continue;
      if (bars[j].h > bars[i].h || (j < i && bars[j].h === bars[i].h)) hi = false;
      if (bars[j].l < bars[i].l || (j < i && bars[j].l === bars[i].l)) lo = false;
    }
    if (hi) out.push({ price: bars[i].h, kind: 'H', i });
    if (lo) out.push({ price: bars[i].l, kind: 'L', i });
  }
  return out;
}

// Greedy clustering of sorted prices: a point joins the cluster when within tol of its running mean.
function cluster(points, tol) {
  const sorted = points.slice().sort((a, b) => a.price - b.price);
  const out = [];
  for (const p of sorted) {
    const c = out[out.length - 1];
    if (c && Math.abs(p.price - c.sum / c.n) <= tol * p.price) {
      c.sum += p.price; c.n++; c.last = Math.max(c.last, p.i); c.kinds.add(p.kind);
    } else out.push({ sum: p.price, n: 1, last: p.i, kinds: new Set([p.kind]) });
  }
  return out.map((c) => ({ price: c.sum / c.n, touches: c.n, last: c.last, flip: c.kinds.size > 1 }));
}

function createLevels() {
  const daily = new Map(); // day -> {o,h,l,c}
  const intraday = new Map(); // day -> 15-min bars
  const memo = new Map();

  const dayBar = (day, arr) => {
    if (!daily.has(day)) daily.set(day, bar(arr));
    return daily.get(day);
  };
  const dayBars15 = (day, arr, size) => {
    if (!intraday.has(day)) {
      const out = [];
      for (let m = 0; m < MPD; m += size) out.push(bar(arr, m, Math.min(MPD, m + size)));
      intraday.set(day, out);
    }
    return intraday.get(day);
  };

  // days: sorted trading days with data (spotDay(d) returns the 1-minute array); i: index of the day to
  // compute levels for (only days[0..i-1] are used). Levels are cached per day.
  function forDay(days, i, spotDay, cfg = {}) {
    const day = days[i];
    const key = day + JSON.stringify(cfg);
    if (memo.has(key)) return memo.get(key);
    const o = { ...DEFAULTS, ...cfg };
    const hist = days.slice(Math.max(0, i - o.majorDays), i).filter((d) => spotDay(d));
    if (hist.length < 3) return null;
    const bars = hist.map((d) => dayBar(d, spotDay(d)));
    const prev = bars[bars.length - 1];
    const ref = prev.c;

    // ---- major: daily swings ----
    const maj = cluster(swings(bars, o.majorWing), o.majorTol)
      .filter((c) => Math.abs(c.price - ref) <= o.majorRange * ref)
      .map((c) => ({ ...c, score: c.touches + (c.flip ? 1 : 0) + 1.5 * (c.last / bars.length) }));
    // The range extremes count as major even with one touch.
    const hiBar = bars.reduce((b, x) => (x.h > b.h ? x : b), bars[0]);
    const loBar = bars.reduce((b, x) => (x.l < b.l ? x : b), bars[0]);
    for (const [price, src] of [[hiBar.h, `${hist.length}-day high`], [loBar.l, `${hist.length}-day low`]]) {
      if (Math.abs(price - ref) > o.majorRange * ref) continue;
      if (!maj.some((c) => Math.abs(c.price - price) <= o.majorTol * price)) maj.push({ price, touches: 1, score: 2.5, src });
    }
    const major = maj
      .filter((c) => c.touches >= 2 || c.src)
      .sort((a, b) => b.score - a.score)
      .slice(0, o.majorMax)
      .map((c) => ({ price: Math.round(c.price), cls: 'major', touches: c.touches, src: c.src || `daily swing ×${c.touches}${c.flip ? ' (flipped)' : ''}` }));

    // ---- minor: 15-minute swings over recent sessions + previous-day levels and pivots ----
    const recent = hist.slice(-o.minorDays);
    const b15 = recent.flatMap((d) => dayBars15(d, spotDay(d), o.barMin));
    const minPts = cluster(swings(b15, o.minorWing), o.minorTol)
      .map((c) => ({ price: c.price, touches: c.touches, src: `15m swing ×${c.touches}`, score: c.touches + c.last / b15.length }));
    const P = (prev.h + prev.l + prev.c) / 3;
    const named = [
      [prev.h, 'prev high', 2.5], [prev.l, 'prev low', 2.5], [prev.c, 'prev close', 1.5],
      [P, 'pivot P', 2], [2 * P - prev.l, 'pivot R1', 1.8], [2 * P - prev.h, 'pivot S1', 1.8],
      [P + (prev.h - prev.l), 'pivot R2', 1.2], [P - (prev.h - prev.l), 'pivot S2', 1.2],
    ];
    for (const [price, src, score] of named) {
      const hit = minPts.find((c) => Math.abs(c.price - price) <= o.minorTol * price);
      if (hit) { hit.src += ' · ' + src; hit.score += score; } else minPts.push({ price, touches: 1, src, score });
    }
    const near = (p, list, tol) => list.some((x) => Math.abs(x.price - p) <= tol * p);
    const minor = minPts
      .filter((c) => Math.abs(c.price - ref) <= o.minorRange * ref && !near(c.price, major, o.majorTol / 2))
      .sort((a, b) => b.score - a.score)
      .slice(0, o.minorMax)
      .map((c) => ({ price: Math.round(c.price), cls: 'minor', touches: c.touches, src: c.src }));

    const out = {
      asOf: day, basedOn: hist[hist.length - 1], sessions: hist.length,
      prev: { h: prev.h, l: prev.l, c: prev.c },
      levels: [...major, ...minor].sort((a, b) => b.price - a.price),
    };
    memo.set(key, out);
    if (memo.size > 3000) memo.delete(memo.keys().next().value);
    return out;
  }

  return { forDay };
}

// Nearest support (below spot) and resistance (above) for each class.
function nearest(lv, spot) {
  const out = { support: { major: null, minor: null, any: null }, resistance: { major: null, minor: null, any: null } };
  for (const l of lv?.levels || []) {
    const side = l.price < spot ? 'support' : l.price > spot ? 'resistance' : null;
    if (!side) continue;
    for (const k of [l.cls, 'any']) {
      const cur = out[side][k];
      if (!cur || Math.abs(l.price - spot) < Math.abs(cur.price - spot)) out[side][k] = l;
    }
  }
  return out;
}

const ofClass = (lv, cls) => (lv?.levels || []).filter((l) => cls === 'any' || l.cls === cls);

module.exports = { createLevels, nearest, ofClass, DEFAULTS };
