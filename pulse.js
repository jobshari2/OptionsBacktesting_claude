// Market Pulse: a live, plain-language read of what the market is doing, recomputed every few
// seconds from the tick data — trend and acceleration, volatility, option-writer activity (OI
// build-up), key OI levels, straddle/IV, order flow and recent signals. Descriptive only.
// Keeps ~100 min of 15-second samples (seeded from today's tape after a restart) and logs a
// summary once a minute to <dir>/<date>/pulse.jsonl.
const fs = require('fs');
const path = require('path');
const { istDate } = require('./lib/time');
const { createSignalLog } = require('./pulse-signals');

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

const L = (n) => (Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : `${(n / 1e5).toFixed(1)} L`);

// "Trade idea" under the option writers & buyers table: what the writers/buyers are doing, whether a call (CE) or
// put (PE) buy looks better for a quick up-move in the option's price, and which strike. A heuristic read of the same
// data as the rest of the screen (trend, OI build-up, order flow) — not advice, and it says WAIT when they disagree.
function buildPlay({
  snap,
  rows,
  atmRow,
  buildup,
  ref,
  tot,
  oiLean,
  trendDir,
  accelerating,
  stalling,
  reversing,
  flow,
  votes,
  volNow,
  resistance,
  support,
  oiWindowMin,
}) {
  const spot = snap.spot;
  // What is happening: the biggest option activity near ATM, in words.
  const w = (side, c) => tot[side][c] || 0;
  const happening = [];
  if (ref) {
    const items = [
      ['call writers are adding (cap above)', w('CE', 'short-buildup'), -1],
      ['put writers are adding (floor below)', w('PE', 'short-buildup'), 1],
      ['call buyers are adding', w('CE', 'long-buildup'), 1],
      ['put buyers are adding', w('PE', 'long-buildup'), -1],
      ['call shorts are covering', w('CE', 'short-covering'), 1],
      ['put shorts are covering', w('PE', 'short-covering'), -1],
      ['call holders are exiting', w('CE', 'long-unwinding'), -1],
      ['put holders are exiting', w('PE', 'long-unwinding'), 1],
    ]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (items.length) happening.push(`Last ${oiWindowMin} min near ATM: ${items.map(([n, v]) => `${n} (${L(v)})`).join('; ')}.`);
  }
  if (resistance || support) {
    happening.push(
      [resistance && `Fresh call wall at ${resistance.strike}`, support && `fresh put floor at ${support.strike}`].filter(Boolean).join(', ') + '.',
    );
  }
  if (!ref) return { action: 'WAIT', side: null, happening, reasons: [`Needs ${oiWindowMin} minutes of history before an idea can be given.`], pick: null };

  // Direction score: trend, writer/buyer lean and order flow (about −4 … +4). Positive = buy calls.
  let score = 0;
  score += trendDir * (stalling ? 0.5 : accelerating ? 1.5 : 1);
  score += (oiLean ?? 0) * 1.5;
  if (flow) score += flow.m * 1.5;
  const dir = Math.sign(score);
  const side = dir > 0 ? 'CE' : 'PE';
  const agree = votes.filter((v) => v.dir === dir).length;
  const against = votes.filter((v) => v.dir === -dir).length;

  const reasons = [];
  let action = 'WAIT';
  if (!dir || Math.abs(score) < 0.8 || against) {
    reasons.push(against ? 'Trend, option writers and order flow disagree — no clean edge.' : 'No clear direction yet.');
  } else {
    action = Math.abs(score) >= 1.8 && agree >= 2 ? 'BUY' : 'WATCH';
    if (action === 'WATCH') reasons.push('Only a partial agreement of trend, writers and order flow — wait for it to firm up.');
  }
  if (reversing && dir === trendDir) {
    action = 'WAIT';
    reasons.push('Price has just turned against the trend — the move may be over.');
  }
  // A fresh wall right in the way caps the move.
  const wall = dir > 0 ? resistance : dir < 0 ? support : null;
  if (wall && Math.abs(wall.strike - spot) <= 40 && action === 'BUY') {
    action = 'WATCH';
    reasons.push(
      `Fresh ${dir > 0 ? 'call writing' : 'put writing'} at ${wall.strike} is only ${Math.abs(wall.strike - spot).toFixed(0)} pts away and can cap the move.`,
    );
  }

  // Strike: ATM or one step either side, ranked by delta (ATM best), activity on that strike and spread.
  const i = rows.indexOf(atmRow);
  const key = side === 'CE' ? 'ce' : 'pe';
  const itm = side === 'CE' ? -1 : 1; // row offset of the in-the-money neighbour
  const cands = [
    { off: itm, label: '1 step ITM', base: 1.6, delta: 0.6 },
    { off: 0, label: 'ATM', base: 2, delta: 0.5 },
    { off: -itm, label: '1 step OTM', base: 1.2, delta: 0.4 },
  ];
  let pick = null;
  for (const c of cands) {
    const r = rows[i + c.off];
    const o = r?.[key];
    if (!o || !(o.ltp > 0)) continue;
    let s = c.base;
    const why = [];
    const b = buildup.find((x) => x.strike === r.strike)?.[side];
    if (b?.cls === 'long-buildup') ((s += 1.5), why.push('fresh buyers here (OI up, price up)'));
    else if (b?.cls === 'short-covering') ((s += 1.2), why.push('shorts covering here (price rising)'));
    else if (b?.cls === 'short-buildup') ((s -= 2), why.push('writers are selling into it'));
    else if (b?.cls === 'long-unwinding') ((s -= 1.5), why.push('holders are exiting'));
    if (b && b.dp > 0) s += 0.5;
    else if (b && b.dp < 0) s -= 0.5;
    const spreadPct = o.bid && o.ask ? ((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100 : null;
    if (spreadPct != null) s -= spreadPct > 4 ? 2 : spreadPct > 2 ? 1 : 0;
    if (o.ltp < 5) s -= 2;
    if (!pick || s > pick.score)
      pick = {
        score: s,
        strike: r.strike,
        label: c.label,
        delta: c.delta,
        ltp: o.ltp,
        bid: o.bid ?? null,
        ask: o.ask ?? null,
        spreadPct,
        oi: o.oi,
        vol: o.vol,
        cls: b?.cls ?? null,
        dp: b?.dp ?? null,
        why,
      };
  }
  if (pick) {
    // Nifty exit levels from the recent 1-minute move size; premium targets use the delta of the chosen strike.
    const stopPts = Math.max(12, Math.round((volNow ?? 5) * 3));
    const targetPts = Math.round(stopPts * 1.5);
    const sgn = dir || 1;
    pick.niftyStop = spot - sgn * stopPts;
    pick.niftyTarget = spot + sgn * targetPts;
    pick.premiumTarget = pick.ltp + pick.delta * targetPts;
    pick.premiumStop = Math.max(0.05, pick.ltp - pick.delta * stopPts);
    if (wall && Math.abs(wall.strike - spot) < targetPts) pick.targetCapped = wall.strike;
    if (pick.spreadPct != null && pick.spreadPct > 3)
      reasons.push(`Wide bid-ask spread (${pick.spreadPct.toFixed(1)}%) — entry cost will eat into a quick move.`);
  }
  if (action === 'BUY' || action === 'WATCH') {
    reasons.unshift(
      `${agree} of ${votes.length || 0} signals point ${dir > 0 ? 'up' : 'down'}${flow ? '' : ' (order flow not available)'}: ${votes
        .filter((v) => v.dir === dir)
        .map((v) => v.what)
        .join(', ')}.`,
    );
  }
  return { action, side: action === 'WAIT' ? null : side, leanSide: dir ? side : null, score, happening, reasons, pick: action === 'WAIT' ? null : pick };
}

function createPulse({ dir, buildupStrikes = 5, oiWindowMin = 15, logError = () => {}, getLot, signalOpts = {} }) {
  const sig = createSignalLog({ dir, logError, lot: getLot, ...signalOpts }); // paper trades of the trade idea, written to pulse-signals.jsonl
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

    const play = buildPlay({
      snap,
      rows,
      atmRow,
      buildup,
      ref,
      tot,
      oiLean,
      trendDir,
      accelerating,
      stalling,
      reversing,
      flow,
      votes,
      volNow,
      resistance,
      support,
      oiWindowMin,
    });

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
      play,
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
    if (!dir) return;
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
        sig.manage(entry.t, snap);
        if (entry.t - lastComputeAt < COMPUTE_MS) return;
        lastComputeAt = entry.t;
        last = compute(snap, flowLive, signalsState);
        if (last?.play) sig.consider(entry.t, last.play, snap, snap.spot);
        if (last && entry.t - lastLogAt >= LOG_MS) {
          lastLogAt = entry.t;
          log(last);
        }
      } catch (e) {
        logError('pulse', e);
      }
    },
    state: () => last && { ...last, trades: sig.snapshot() },
    signalLog: sig,
    labels: CLASSES,
  };
}

module.exports = { createPulse, PULSE_CLASSES: CLASSES };
