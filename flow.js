// Volume-flow predictions: when CE volume added in the last minute clearly outweighs PE (or the
// reverse) near ATM, predict Nifty will move up (or down), then track how the market actually reacts
// and score the prediction. Everything is saved to <dir>/<date>/predictions.csv / .jsonl.
const fs = require('fs');
const path = require('path');
const { istDate, istTime } = require('./lib/time');
const { num } = require('./lib/env');

const MIN = 60_000;
const SERIES_EVERY_MS = 5000; // chart sample rate
const SERIES_KEEP_MS = 60 * MIN;
const REACTION_START_PTS = 3; // first move of this size (either way) = "market started reacting"
const BOM = '﻿';
const CE_LTP = 0, CE_VOL = 1, PE_LTP = 3, PE_VOL = 4, CE_BUY = 6, CE_SELL = 7, PE_BUY = 8, PE_SELL = 9;

const CSV_HEADER = [
  'date', 'prediction', 'flow_build_start', 'signal_time', 'build_sec',
  'ce_1m_at_build_start', 'pe_1m_at_build_start', 'ce_1m_at_signal', 'pe_1m_at_signal', 'ce_share_pct',
  'spot_at_signal', 'atm', 'reaction_start', 'reaction_delay_sec', 'reaction_first_direction',
  'result', 'result_time', 'time_to_result_sec', 'max_favourable_pts', 'max_adverse_pts',
  'spot_after_1m', 'spot_after_horizon', 'move_after_horizon_pts',
  'atm_ce_at_signal', 'atm_ce_after', 'atm_pe_at_signal', 'atm_pe_after',
  'mode', 'flow_measure', 'bull_1m_at_signal', 'bear_1m_at_signal',
];

// cfg.replay = true runs the same logic over a recorded tape: nothing is loaded or saved, and the
// chart series and stats cover the whole replayed day instead of "today".
function createFlow(cfg, logError) {
  const replay = Boolean(cfg.replay);
  const seriesKeepMs = replay ? Infinity : SERIES_KEEP_MS;
  const inDay = (p) => replay || istDate(p.at) === istDate(Date.now());
  const predictions = replay ? [] : loadDay(istDate(Date.now())); // newest first
  const series = [];
  let live = { ready: false };
  let leader = null; // { side: 'up'|'down', since, ce, pe, bull, bear } — which flow leads, and since when
  let candidate = null; // { dir, since } — imbalance past the threshold, waiting out the hold time
  const armed = { up: true, down: true }; // re-armed once the flow flips to the other side
  const lastPredAt = { up: 0, down: 0 };
  let lastSeriesAt = 0;

  function onSnapshot(hist, snap) {
    const cur = hist[hist.length - 1];
    const now = cur.t;
    const m1 = hist.find((h) => h.t >= now - MIN);
    const spanSec = (cur.t - m1.t) / 1000;
    const strikes = nearStrikes(snap);
    const atm = strikes[Math.floor(strikes.length / 2)]?.strike ?? null;

    // Last-minute volume near ATM, as raw CE vs PE, and as bullish vs bearish flow:
    //   aggressor — CE buys + PE sells vs PE buys + CE sells, from bid/ask (tick feed only)
    //   premium   — each leg's volume counted by which way its own premium moved over the minute
    let ce = 0, pe = 0, aBull = 0, aBear = 0, aVol = 0, pBull = 0, pBear = 0;
    for (const r of strikes) {
      const a = m1.d[r.strike];
      const b = cur.d[r.strike];
      if (!a || !b) continue;
      const dce = Math.max(0, b[CE_VOL] - a[CE_VOL]);
      const dpe = Math.max(0, b[PE_VOL] - a[PE_VOL]);
      ce += dce;
      pe += dpe;
      if (a.length >= 10 && b.length >= 10) {
        aBull += Math.max(0, b[CE_BUY] - a[CE_BUY]) + Math.max(0, b[PE_SELL] - a[PE_SELL]);
        aBear += Math.max(0, b[PE_BUY] - a[PE_BUY]) + Math.max(0, b[CE_SELL] - a[CE_SELL]);
        aVol += dce + dpe;
      }
      const pc = b[CE_LTP] - a[CE_LTP];
      const pp = b[PE_LTP] - a[PE_LTP];
      if (pc > 0) pBull += dce; else if (pc < 0) pBear += dce;
      if (pp > 0) pBear += dpe; else if (pp < 0) pBull += dpe;
    }
    const total = ce + pe;
    // Aggressor needs most of the volume classified; otherwise (polling, old tapes) use premium.
    const mode = cfg.mode === 'aggressor' && !(aVol >= total * 0.6 && aBull + aBear > 0) ? 'premium' : cfg.mode;
    const bull = mode === 'aggressor' ? aBull : mode === 'premium' ? pBull : ce;
    const bear = mode === 'aggressor' ? aBear : mode === 'premium' ? pBear : pe;
    const m = bull + bear > 0 ? (bull - bear) / (bull + bear) : 0; // -1 ... +1, + = bullish
    const ready = spanSec >= 45;
    const quiet = total < cfg.minQty;
    const zone = !ready || quiet ? 'quiet' : m >= cfg.imbalance ? 'up' : m <= -cfg.imbalance ? 'down' : 'neutral';

    // Which side is leading, and since when (the "flow build start").
    if (ready && bull !== bear) {
      const side = bull > bear ? 'up' : 'down';
      if (!leader || leader.side !== side) leader = { side, since: now, ce, pe, bull, bear };
    }

    // One prediction per flow episode: a direction re-arms only after the flow has flipped to the
    // other side, and never sooner than the scoring horizon after its last prediction.
    if (m < 0) armed.up = true;
    if (m > 0) armed.down = true;

    if (zone === 'up' || zone === 'down') {
      if (!candidate || candidate.dir !== zone) candidate = { dir: zone, since: now };
      const gapOk = now - (lastPredAt[zone] || 0) >= cfg.horizonMin * MIN;
      if (armed[zone] && gapOk && now - candidate.since >= cfg.holdSec * 1000) {
        armed[zone] = false;
        lastPredAt[zone] = now;
        predict(zone, now, { ce, pe, bull, bear, m, mode }, cur, snap, atm);
      }
    } else {
      candidate = null;
    }

    for (const p of predictions) if (!p.done) track(p, now, cur, snap);

    live = {
      ready, quiet, ce, pe, bull, bear, m, mode, zone, spot: cur.spot, atm,
      share: total ? (ce / total) * 100 : null,
      bullShare: bull + bear ? (bull / (bull + bear)) * 100 : null,
      leader: leader && { side: leader.side, since: leader.since },
      candidate: candidate && {
        dir: candidate.dir,
        heldSec: Math.round((now - candidate.since) / 1000),
        armed: armed[candidate.dir] && now - (lastPredAt[candidate.dir] || 0) >= cfg.horizonMin * MIN,
      },
    };
    if (now - lastSeriesAt >= SERIES_EVERY_MS) {
      lastSeriesAt = now;
      series.push({ t: now, spot: cur.spot, ce, pe, imb: ready && !quiet ? m : null });
      while (series.length && now - series[0].t > seriesKeepMs) series.shift();
    }
  }

  function predict(dir, now, f, cur, snap, atm) {
    const { ce, pe } = f;
    const row = snap.rows.find((r) => r.strike === atm);
    const p = {
      id: `${now}-${dir}`,
      dir,
      at: now,
      buildStartAt: leader?.since ?? now,
      buildCe: leader?.ce ?? null,
      buildPe: leader?.pe ?? null,
      buildBull: leader?.bull ?? null,
      buildBear: leader?.bear ?? null,
      ce, pe,
      share: (ce / (ce + pe)) * 100,
      mode: f.mode,
      bull: f.bull,
      bear: f.bear,
      measure: f.m,
      spot: cur.spot,
      atm,
      atmCe: row?.ce.ltp ?? null,
      atmPe: row?.pe.ltp ?? null,
      reactionAt: null, reactionDir: null,
      result: 'pending', resultAt: null,
      fav: 0, adv: 0,
      spot1m: null, spotEnd: null, atmCeAfter: null, atmPeAfter: null,
      done: false,
    };
    predictions.unshift(p);
    if (predictions.length > 500 && !replay) predictions.pop();
    if (!replay) console.log(`[flow] ${istTime(now)} predict ${dir.toUpperCase()} (${f.mode}) — bull +${Math.round(f.bull)} vs bear +${Math.round(f.bear)}, CE +${Math.round(ce)} vs PE +${Math.round(pe)} in 1m, spot ${cur.spot}`);
  }

  function track(p, now, cur, snap) {
    if (cur.spot == null || p.spot == null) return;
    const raw = cur.spot - p.spot;
    const move = p.dir === 'up' ? raw : -raw; // + = in the predicted direction
    p.fav = Math.max(p.fav, move);
    p.adv = Math.min(p.adv, move);
    if (!p.reactionAt && Math.abs(raw) >= REACTION_START_PTS) {
      p.reactionAt = now;
      p.reactionDir = raw > 0 ? 'up' : 'down';
    }
    if (p.result === 'pending') {
      if (move >= cfg.reactPts) { p.result = 'hit'; p.resultAt = now; }
      else if (move <= -cfg.reactPts) { p.result = 'miss'; p.resultAt = now; }
    }
    if (p.spot1m == null && now - p.at >= MIN) p.spot1m = cur.spot;
    if (now - p.at >= cfg.horizonMin * MIN) {
      if (p.result === 'pending') { p.result = 'flat'; p.resultAt = now; }
      const row = snap.rows.find((r) => r.strike === p.atm);
      p.spotEnd = cur.spot;
      p.atmCeAfter = row?.ce.ltp ?? null;
      p.atmPeAfter = row?.pe.ltp ?? null;
      p.done = true;
      if (!replay) save(p);
    }
  }

  function save(p) {
    try {
      const day = istDate(p.at);
      const dir = path.join(cfg.dir, day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'predictions.csv');
      // If the file was started with older columns, keep it aside and start a fresh one.
      if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').split('\n')[0].includes(CSV_HEADER.at(-1))) {
        fs.renameSync(file, path.join(dir, `predictions-old-${istTime(Date.now()).replace(/:/g, '')}.csv`));
      }
      if (!fs.existsSync(file)) fs.writeFileSync(file, BOM + CSV_HEADER.join(',') + '\n');
      fs.appendFileSync(file, predictionRow(p) + '\n');
      fs.appendFileSync(path.join(dir, 'predictions.jsonl'), JSON.stringify(p) + '\n');
    } catch (e) {
      logError('flow-save', e);
    }
  }

  function stats() {
    const today = predictions.filter(inDay);
    const done = today.filter((p) => p.result !== 'pending');
    const by = (list, r) => list.filter((p) => p.result === r).length;
    const avg = (list, f) => (list.length ? list.reduce((s, p) => s + f(p), 0) / list.length : null);
    const hits = done.filter((p) => p.result === 'hit');
    const side = (dir) => {
      const l = done.filter((p) => p.dir === dir);
      const h = by(l, 'hit');
      const m = by(l, 'miss');
      return { total: l.length, hit: h, miss: m, flat: by(l, 'flat'), hitRate: h + m ? (h / (h + m)) * 100 : null };
    };
    const h = by(done, 'hit');
    const m = by(done, 'miss');
    return {
      total: today.length,
      pending: today.length - done.length,
      hit: h, miss: m, flat: by(done, 'flat'),
      hitRate: h + m ? (h / (h + m)) * 100 : null,
      avgSecToHit: avg(hits, (p) => (p.resultAt - p.at) / 1000),
      avgReactionSec: avg(done.filter((p) => p.reactionAt), (p) => (p.reactionAt - p.at) / 1000),
      avgFav: avg(done, (p) => p.fav),
      avgAdv: avg(done, (p) => p.adv),
      up: side('up'),
      down: side('down'),
    };
  }

  function nearStrikes(snap) {
    const rows = snap.rows;
    if (!rows.length || snap.spot == null) return [];
    let atm = 0;
    rows.forEach((r, i) => { if (Math.abs(r.strike - snap.spot) < Math.abs(rows[atm].strike - snap.spot)) atm = i; });
    return rows.slice(Math.max(0, atm - cfg.strikesAround), atm + cfg.strikesAround + 1);
  }

  function loadDay(day) {
    try {
      return fs.readFileSync(path.join(cfg.dir, day, 'predictions.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse();
    } catch {
      return [];
    }
  }

  return {
    onSnapshot(hist, snap) {
      try {
        onSnapshot(hist, snap);
      } catch (e) {
        logError('flow', e);
      }
    },
    state: () => ({
      live,
      stats: stats(),
      predictions: predictions.filter(inDay).slice(0, replay ? Infinity : 150),
      rules: {
        mode: cfg.mode, imbalance: cfg.imbalance, sharePct: 50 + cfg.imbalance * 50, holdSec: cfg.holdSec, minQty: cfg.minQty,
        reactPts: cfg.reactPts, horizonMin: cfg.horizonMin, strikesAround: cfg.strikesAround, reactionStartPts: REACTION_START_PTS,
      },
    }),
    series: () => series,
    // On shutdown, save predictions still being tracked so they aren't lost.
    flush() {
      for (const p of predictions) {
        if (p.done) continue;
        if (p.result === 'pending') p.result = 'interrupted';
        p.done = true;
        if (!replay) save(p);
      }
    },
  };
}

// One predictions.csv row (shared by the live recorder and replay.js).
function predictionRow(p) {
  const sec = (a, b) => (a && b ? Math.round((b - a) / 1000) : '');
  const day = istDate(p.at);
  return csvRow([
    day, p.dir.toUpperCase(), istTime(p.buildStartAt), istTime(p.at), sec(p.buildStartAt, p.at),
    round0(p.buildCe), round0(p.buildPe), round0(p.ce), round0(p.pe), round(p.share),
    round(p.spot), p.atm, p.reactionAt ? istTime(p.reactionAt) : '', sec(p.at, p.reactionAt), p.reactionDir || '',
    p.result.toUpperCase(), p.resultAt ? istTime(p.resultAt) : '', sec(p.at, p.resultAt), round(p.fav), round(p.adv),
    round(p.spot1m), round(p.spotEnd), round(p.spotEnd != null ? p.spotEnd - p.spot : null),
    p.atmCe, p.atmCeAfter, p.atmPe, p.atmPeAfter,
    p.mode || 'volume', round(p.measure ?? p.imb), round0(p.bull), round0(p.bear),
  ]);
}

// Settings from .env (FLOW_*), with optional overrides (used by replays to test other values).
function flowConfig(env, overrides = {}) {
  return {
    imbalance: num(env.FLOW_IMBALANCE, 0.2), // predict when (CE − PE) / (CE + PE) of 1-min volume is ≥ this (CE share ≥ 60%)
    holdSec: num(env.FLOW_HOLD_SEC, 10), // ...and the imbalance holds for this many seconds
    minQty: num(env.FLOW_MIN_QTY, 50000), // ...and at least this much volume traded near ATM in that minute
    reactPts: num(env.FLOW_REACT_PTS, 8), // HIT if Nifty moves this many points the predicted way first, MISS if the other way first
    horizonMin: num(env.FLOW_HORIZON_MIN, 3), // FLAT if neither happens within this many minutes
    strikesAround: num(env.SIGNAL_STRIKES, 10),
    // what counts as bullish vs bearish flow: 'aggressor' (bid/ask, default), 'premium', or 'volume' (raw CE vs PE)
    mode: ['aggressor', 'premium', 'volume'].includes(overrides.mode || env.FLOW_MODE) ? (overrides.mode || env.FLOW_MODE) : 'aggressor',
    ...Object.fromEntries(Object.entries(overrides).filter(([k, v]) => k !== 'mode' && v != null && !isNaN(v))),
  };
}

// ---------- utils ----------
const round = (n) => (n == null ? '' : Math.round(n * 100) / 100);
const round0 = (n) => (n == null ? '' : Math.round(n));

function csvRow(values) {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

module.exports = { createFlow, flowConfig, CSV_HEADER, predictionRow };
