// Market Pulse: a live, plain-language read of what the market is doing, recomputed every few
// seconds from the tick data — trend and acceleration, volatility, option-writer activity (OI
// build-up), key OI levels, straddle/IV, order flow and recent signals. Descriptive only.
// Keeps ~100 min of 15-second samples (seeded from today's tape after a restart) and logs a
// summary once a minute to <dir>/<date>/pulse.jsonl.
const fs = require('fs');
const path = require('path');
const { istDate } = require('./lib/time');

const MIN = 60_000;
const SAMPLE_MS = 15_000;
const KEEP_MS = 100 * MIN;
const COMPUTE_MS = 5000;
const LOG_MS = MIN;

// OI build-up classes: what option traders did, given the change in OI and in the option's price.
const CLASSES = {
  'long-buildup': 'long build-up (buying)',
  'short-buildup': 'short build-up (writing)',
  'short-covering': 'short covering',
  'long-unwinding': 'long unwinding',
};
// How each class leans for Nifty, per side.
const LEAN = {
  CE: { 'long-buildup': 1, 'short-buildup': -1, 'short-covering': 1, 'long-unwinding': -1 },
  PE: { 'long-buildup': -1, 'short-buildup': 1, 'short-covering': -1, 'long-unwinding': 1 },
};

function createPulse({ dir, buildupStrikes = 5, oiWindowMin = 15, logError }) {
  const samples = []; // { t, spot, iv, d: { strike: [ceLtp, ceOi, peLtp, peOi] } }
  let dayHigh = null;
  let dayLow = null;
  let day = null;
  let last = null;
  let lastComputeAt = 0;
  let lastLogAt = 0;

  function addSample(e, iv = null, book = null) {
    if (e.spot == null) return;
    const dd = istDate(e.t);
    if (day !== dd) {
      day = dd;
      dayHigh = dayLow = null;
      samples.length = 0;
    }
    dayHigh = dayHigh == null ? e.spot : Math.max(dayHigh, e.spot);
    dayLow = dayLow == null ? e.spot : Math.min(dayLow, e.spot);
    if (samples.length && e.t - samples[samples.length - 1].t < SAMPLE_MS) return;
    const ks = Object.keys(e.d)
      .map(Number)
      .sort((a, b) => a - b);
    const atm = ks.reduce((b, k) => (Math.abs(k - e.spot) < Math.abs(b - e.spot) ? k : b), ks[0]);
    const d = {};
    for (const k of ks) if (Math.abs(k - atm) <= 500 && e.d[k]) d[k] = [e.d[k][0], e.d[k][2], e.d[k][3], e.d[k][5]];
    samples.push({ t: e.t, spot: e.spot, iv, book, d });
    while (samples.length && e.t - samples[0].t > KEEP_MS) samples.shift();
  }

  // Sample at or just after time t, if the samples actually reach back that far.
  function ago(t) {
    if (!samples.length || samples[0].t > t + SAMPLE_MS * 2) return null;
    return samples.find((s) => s.t >= t) || null;
  }

  function compute(snap, flowLive, signalsState) {
    const now = samples[samples.length - 1];
    if (!now) return null;
    const rows = snap.rows;
    const atmRow = rows.reduce((b, r) => (Math.abs(r.strike - snap.spot) < Math.abs(b.strike - snap.spot) ? r : b), rows[0]);
    const atm = atmRow.strike;

    // --- trend ---
    const chg = {};
    for (const m of [5, 15, 30, 60]) {
      const a = ago(now.t - m * MIN);
      chg[m] = a ? now.spot - a.spot : null;
    }
    // --- volatility: typical 1-minute move (RMS), last 15 min vs the 30 min before ---
    const perMin = [];
    for (let t = now.t - 45 * MIN; t <= now.t; t += MIN) perMin.push(ago(t)?.spot ?? null);
    const moves = perMin.slice(1).map((v, i) => (v != null && perMin[i] != null ? v - perMin[i] : null));
    const rms = (a) => {
      const x = a.filter((v) => v != null);
      return x.length >= 5 ? Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length) : null;
    };
    const volNow = rms(moves.slice(-15));
    const volBefore = rms(moves.slice(0, 30));

    let trend = 'unknown';
    let trendDir = 0;
    const c15 = chg[15] ?? chg[5];
    if (c15 != null) {
      const scale = Math.max(8, (volNow ?? 6) * Math.sqrt(15));
      const r = c15 / scale;
      trendDir = Math.abs(r) < 0.6 ? 0 : Math.sign(r);
      trend = Math.abs(r) < 0.6 ? 'sideways' : Math.abs(r) >= 1.5 ? (r > 0 ? 'strong rise' : 'strong fall') : r > 0 ? 'rising' : 'falling';
    }
    const accelerating =
      chg[5] != null &&
      chg[15] != null &&
      Math.sign(chg[5]) === Math.sign(chg[15]) &&
      Math.abs(chg[5]) / 5 > 1.5 * (Math.abs(chg[15]) / 15) &&
      Math.abs(chg[5]) >= 10;
    const stalling = chg[5] != null && chg[15] != null && Math.abs(chg[15]) >= 30 && Math.abs(chg[5]) < Math.abs(chg[15]) / 10;
    const reversing = chg[5] != null && chg[15] != null && Math.abs(chg[15]) >= 30 && Math.sign(chg[5]) === -Math.sign(chg[15]) && Math.abs(chg[5]) >= 10;

    // --- OI build-up over the window, strikes ATM ± buildupStrikes ---
    const ref = ago(now.t - oiWindowMin * MIN);
    const buildup = [];
    const tot = { CE: {}, PE: {} };
    let lean = 0;
    let leanBase = 0;
    if (ref) {
      const ks = Object.keys(now.d)
        .map(Number)
        .sort((a, b) => a - b);
      const i = ks.indexOf(atm);
      for (const k of ks.slice(Math.max(0, i - buildupStrikes), i + buildupStrikes + 1)) {
        const a = ref.d[k];
        const b = now.d[k];
        if (!a || !b) continue;
        const row = { strike: k };
        for (const [side, li, oi] of [
          ['CE', 0, 1],
          ['PE', 2, 3],
        ]) {
          const dp = b[li] - a[li];
          const doi = b[oi] - a[oi];
          const cls = doi === 0 ? null : doi > 0 ? (dp >= 0 ? 'long-buildup' : 'short-buildup') : dp >= 0 ? 'short-covering' : 'long-unwinding';
          row[side] = { ltpFrom: a[li], ltp: b[li], dp, doi, cls };
          if (cls) {
            tot[side][cls] = (tot[side][cls] || 0) + Math.abs(doi);
            lean += LEAN[side][cls] * Math.abs(doi);
            leanBase += Math.abs(doi);
          }
        }
        buildup.push(row);
      }
    }
    const oiLean = leanBase ? lean / leanBase : null; // −1 … +1, + = bullish

    // --- levels ---
    const maxCe = rows.reduce((b, r) => (r.ce.oi > b.ce.oi ? r : b), rows[0]);
    const maxPe = rows.reduce((b, r) => (r.pe.oi > b.pe.oi ? r : b), rows[0]);
    const near = rows.filter((r) => Math.abs(r.strike - snap.spot) <= 300);
    const addedToday = (side) =>
      [...near]
        .sort((a, b) => b[side].oi - b[side].prevOi - (a[side].oi - a[side].prevOi))
        .slice(0, 3)
        .map((r) => ({ strike: r.strike, added: r[side].oi - r[side].prevOi }));
    const freshWall = (side, above) =>
      buildup
        .filter((r) => r[side]?.cls === 'short-buildup' && (above ? r.strike >= snap.spot : r.strike <= snap.spot))
        .sort((a, b) => b[side].doi - a[side].doi)[0];
    const resistance = freshWall('CE', true);
    const support = freshWall('PE', false);

    // --- straddle & IV ---
    const straddleAt = (s) => {
      if (!s) return null;
      const ks = Object.keys(s.d).map(Number);
      const k = ks.reduce((b, x) => (Math.abs(x - s.spot) < Math.abs(b - s.spot) ? x : b), ks[0]);
      return s.d[k] ? { strike: k, value: s.d[k][0] + s.d[k][2] } : null;
    };
    const stNow = straddleAt(now);
    const st30 = straddleAt(ago(now.t - 30 * MIN));
    const st60 = straddleAt(ago(now.t - 60 * MIN));
    const stChg = stNow && st30 ? ((stNow.value - st30.value) / st30.value) * 100 : null;
    const iv = atmRow.ce.iv != null && atmRow.pe.iv != null ? (atmRow.ce.iv + atmRow.pe.iv) / 2 : null;
    const ivRef = ago(now.t - 30 * MIN)?.iv ?? null;

    // --- order book: quantity waiting near ATM (not used in the alignment vote until it is tested) ---
    const bookNow = bookPressure(snap);
    const bookRef = ago(now.t - 5 * MIN)?.book ?? null;
    const book = bookNow && {
      ...bookNow,
      chg5: bookRef != null ? bookNow.bullShare - bookRef : null,
    };

    // --- order flow & signals ---
    const flow =
      flowLive?.ready && !flowLive.quiet ? { mode: flowLive.mode, bullShare: flowLive.bullShare, m: flowLive.m, ce: flowLive.ce, pe: flowLive.pe } : null;
    const recent = (signalsState?.events || []).filter((e) => now.t - e.t <= 10 * MIN);
    const sigCount = {};
    for (const e of recent) sigCount[e.type] = (sigCount[e.type] || 0) + 1;

    // --- alignment: do trend, writer activity and order flow agree? ---
    const votes = [];
    if (trendDir) votes.push({ what: 'trend', dir: trendDir });
    if (oiLean != null && Math.abs(oiLean) >= 0.2) votes.push({ what: 'OI build-up', dir: Math.sign(oiLean) });
    if (flow && Math.abs(flow.m) >= 0.1) votes.push({ what: 'order flow', dir: Math.sign(flow.m) });
    const up = votes.filter((v) => v.dir > 0).length;
    const down = votes.filter((v) => v.dir < 0).length;
    const bias = votes.length === 0 ? 'neutral' : up && down ? 'mixed' : up ? 'bullish' : 'bearish';

    // --- plain-language summary ---
    const pts = (n) => `${n > 0 ? '+' : ''}${n.toFixed(0)}`;
    const L = (n) => (Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : `${(n / 1e5).toFixed(1)} L`);
    let headline = trend === 'unknown' ? 'Collecting data…' : trend[0].toUpperCase() + trend.slice(1);
    if (accelerating) headline += ', accelerating';
    else if (reversing) headline += ', now reversing';
    else if (stalling) headline += ', pausing';
    if (bias === 'bullish' || bias === 'bearish') headline += ` — ${bias} signals aligned (${Math.max(up, down)}/${votes.length})`;
    else if (bias === 'mixed') headline += ` — signals mixed (${up} up, ${down} down)`;

    const bullets = [];
    if (chg[15] != null) {
      const parts = [5, 15, 30, 60].filter((m) => chg[m] != null).map((m) => `${pts(chg[m])} in ${m}m`);
      const atLow = dayLow != null && snap.spot - dayLow <= 10;
      const atHigh = dayHigh != null && dayHigh - snap.spot <= 10;
      bullets.push(`Nifty ${snap.spot.toFixed(0)}: ${parts.join(', ')}.${atLow ? ' Trading at the day’s low.' : atHigh ? ' Trading at the day’s high.' : ''}`);
    }
    if (volNow != null) {
      const v = volBefore ? volNow / volBefore : 1;
      bullets.push(
        `Typical 1-minute move ${volNow.toFixed(1)} pts${volBefore ? ` (was ${volBefore.toFixed(1)})` : ''} — volatility ${v > 1.3 ? 'rising' : v < 0.75 ? 'falling' : 'steady'}.`,
      );
    }
    if (ref && leanBase) {
      const w = (side, c) => tot[side][c] || 0;
      const items = [
        ['call writing', w('CE', 'short-buildup')],
        ['put writing', w('PE', 'short-buildup')],
        ['call buying', w('CE', 'long-buildup')],
        ['put buying', w('PE', 'long-buildup')],
        ['call short covering', w('CE', 'short-covering')],
        ['put short covering', w('PE', 'short-covering')],
        ['call long unwinding', w('CE', 'long-unwinding')],
        ['put long unwinding', w('PE', 'long-unwinding')],
      ]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      bullets.push(
        `Last ${oiWindowMin} min near ATM: ${items.map(([n, v]) => `${n} ${L(v)}`).join(', ')} — option activity leans ${oiLean >= 0.2 ? 'bullish' : oiLean <= -0.2 ? 'bearish' : 'neutral'}.`,
      );
    }
    if (resistance || support) {
      bullets.push(
        `Fresh writing: ${[
          resistance && `calls at ${resistance.strike} (+${L(resistance.CE.doi)}) above`,
          support && `puts at ${support.strike} (+${L(support.PE.doi)}) below`,
        ]
          .filter(Boolean)
          .join(', ')}.`,
      );
    }
    bullets.push(
      `Largest OI: calls ${maxCe.strike} (${L(maxCe.ce.oi)}), puts ${maxPe.strike} (${L(maxPe.pe.oi)}). PCR ${(
        rows.reduce((s, r) => s + r.pe.oi, 0) /
        Math.max(
          1,
          rows.reduce((s, r) => s + r.ce.oi, 0),
        )
      ).toFixed(2)}.`,
    );
    if (stNow && stChg != null) {
      bullets.push(
        `ATM straddle ${stNow.value.toFixed(0)} (${stChg > 0 ? '+' : ''}${stChg.toFixed(1)}% in 30m) — option prices ${stChg > 5 ? 'expanding: a bigger move is being priced in' : stChg < -5 ? 'shrinking: the market expects calmer trade' : 'steady'}.${iv != null ? ` ATM IV ${iv.toFixed(1)}${ivRef != null ? ` (${pts(iv - ivRef)} vs 30m ago)` : ''}.` : ''}`,
      );
    }
    if (book) {
      bullets.push(
        `Order book near ATM: ${book.bullShare.toFixed(0)}% of waiting quantity is on the bullish side (calls to buy + puts to sell)${book.chg5 != null ? `, ${book.chg5 >= 0 ? '+' : ''}${book.chg5.toFixed(1)} pts vs 5m ago` : ''}. ATM spread ${book.atmSpreadPct != null ? book.atmSpreadPct.toFixed(2) + '%' : '—'}.`,
      );
    }
    if (flow) {
      bullets.push(
        `Order flow (last 1m, ${flow.mode}): ${flow.bullShare.toFixed(0)}% bullish / ${(100 - flow.bullShare).toFixed(0)}% bearish; raw volume CE ${L(flow.ce)} vs PE ${L(flow.pe)}.`,
      );
    }
    if (recent.length) {
      bullets.push(
        `Signals in the last 10 min: ${Object.entries(sigCount)
          .map(([k, v]) => `${k} ×${v}`)
          .join(', ')}.`,
      );
    }

    return {
      t: now.t,
      spot: snap.spot,
      headline,
      bias,
      votes,
      bullets,
      trend: { label: trend, dir: trendDir, chg, accelerating, stalling, reversing, dayHigh, dayLow },
      vol: { now: volNow, before: volBefore },
      oi: { windowMin: oiWindowMin, lean: oiLean, totals: tot, buildup, ready: Boolean(ref) },
      levels: {
        maxCe: { strike: maxCe.strike, oi: maxCe.ce.oi },
        maxPe: { strike: maxPe.strike, oi: maxPe.pe.oi },
        addedCe: addedToday('ce'),
        addedPe: addedToday('pe'),
        resistance: resistance && { strike: resistance.strike, doi: resistance.CE.doi },
        support: support && { strike: support.strike, doi: support.PE.doi },
      },
      straddle: { now: stNow, ago30: st30, ago60: st60, chg30: stChg },
      iv: { now: iv, ago30: ivRef },
      flow,
      book,
      signals: sigCount,
      history: samples.filter((s, i) => i % 2 === 0 || i === samples.length - 1).map((s) => ({ t: s.t, spot: s.spot })),
      coverMin: Math.round((now.t - samples[0].t) / MIN),
    };
  }

  function log(p) {
    try {
      const folder = path.join(dir, istDate(p.t));
      fs.mkdirSync(folder, { recursive: true });
      const { history, oi, ...rest } = p; // keep the log compact; the tape has the raw data
      fs.appendFileSync(path.join(folder, 'pulse.jsonl'), JSON.stringify({ ...rest, oi: { lean: oi.lean, totals: oi.totals } }) + '\n');
    } catch (e) {
      logError('pulse-log', e);
    }
  }

  // Bullish book = calls waiting to be bought + puts waiting to be sold; bearish = the reverse.
  // Uses total buy/sell queue (all depth levels) for strikes ATM ± buildupStrikes; needs the tick feed.
  function bookPressure(snap) {
    const rows = snap.rows;
    if (!rows?.length || snap.spot == null) return null;
    let i = 0;
    rows.forEach((r, j) => {
      if (Math.abs(r.strike - snap.spot) < Math.abs(rows[i].strike - snap.spot)) i = j;
    });
    let bull = 0;
    let bear = 0;
    for (const r of rows.slice(Math.max(0, i - buildupStrikes), i + buildupStrikes + 1)) {
      if (r.ce.tbq == null || r.pe.tbq == null) continue;
      bull += r.ce.tbq + r.pe.tsq;
      bear += r.pe.tbq + r.ce.tsq;
    }
    if (!(bull + bear)) return null;
    const a = rows[i];
    const spread = (o) => (o.bid && o.ask ? ((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100 : null);
    const sp = [spread(a.ce), spread(a.pe)].filter((x) => x != null);
    return { bull, bear, bullShare: (bull / (bull + bear)) * 100, atmSpreadPct: sp.length ? sp.reduce((s, x) => s + x, 0) / sp.length : null };
  }

  return {
    // Seed from today's tape so the pulse has context right after a restart.
    seed(entries) {
      for (const e of entries) addSample(e);
    },
    update(entry, snap, flowLive, signalsState) {
      try {
        const rows = snap.rows;
        const atmRow = rows.reduce((b, r) => (Math.abs(r.strike - snap.spot) < Math.abs(b.strike - snap.spot) ? r : b), rows[0]);
        addSample(
          entry,
          atmRow && atmRow.ce.iv != null && atmRow.pe.iv != null ? (atmRow.ce.iv + atmRow.pe.iv) / 2 : null,
          bookPressure(snap)?.bullShare ?? null,
        );
        if (entry.t - lastComputeAt < COMPUTE_MS) return;
        lastComputeAt = entry.t;
        last = compute(snap, flowLive, signalsState);
        if (last && entry.t - lastLogAt >= LOG_MS) {
          lastLogAt = entry.t;
          log(last);
        }
      } catch (e) {
        logError('pulse', e);
      }
    },
    state: () => last,
    labels: CLASSES,
  };
}

module.exports = { createPulse, PULSE_CLASSES: CLASSES };
