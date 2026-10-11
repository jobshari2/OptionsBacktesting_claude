// Spike detection and before/after recording.
// Runs on every poll of the nearest-expiry chain, raises signals, and writes what happened
// around each spike to <dir>/<YYYY-MM-DD>/ (a tick-level CSV per spike + a daily events.csv summary).
const fs = require('fs');
const path = require('path');
const { signalKind } = require('./sigstats');
const { istDate, istTime } = require('./lib/time');
const { num } = require('./lib/env');

const MIN = 60_000;
const BASELINE_SPAN_MIN = 15; // "normal" volume = average per-minute volume over the previous 15 minutes
const MAX_CAPTURE_MIN = 30; // a cluster of spikes can extend one recording up to this length
const CE_LTP = 0,
  CE_VOL = 1,
  CE_OI = 2,
  PE_LTP = 3,
  PE_VOL = 4,
  PE_OI = 5;
const BOM = '﻿'; // lets Excel open the CSVs as UTF-8 (≥, →, × in the descriptions)

const EVENTS_CSV_HEADER = [
  'date',
  'time',
  'type',
  'detail',
  'spot_before',
  'spot_at_signal',
  'spot_after',
  'change_after_pts',
  'max_up_after_pts',
  'max_down_after_pts',
  'ce_vol_added_before',
  'ce_vol_added_after',
  'pe_vol_added_before',
  'pe_vol_added_after',
  'before_sec',
  'after_sec',
  'detail_file',
];
const TICKS_CSV_HEADER = [
  'time',
  'sec_from_signal',
  'spot',
  'strike',
  'ce_ltp',
  'ce_volume',
  'ce_vol_added',
  'ce_oi',
  'pe_ltp',
  'pe_volume',
  'pe_vol_added',
  'pe_oi',
  'signal',
];

// Signal thresholds from the environment (.env); dir = where recordings go.
function signalConfig(env, dir) {
  return {
    spikeRatio: num(env.SPIKE_RATIO, 3), // strike spike: last-minute volume ≥ this × its normal per-minute volume
    spikeMinQty: num(env.SPIKE_MIN_QTY, 25000), // ...and at least this many units traded in that minute
    broadRatio: num(env.BROAD_RATIO, 2), // a strike counts as "elevated" at ≥ this × normal volume
    broadPct: num(env.BROAD_PCT, 60), // broad surge: ≥ this % of strikes near ATM elevated at once
    spotMovePts: num(env.SPOT_MOVE_PTS, 25), // Nifty rise/fall: moves ≥ this many points within 1 minute...
    spotFastPts: num(env.SPOT_FAST_PTS, 15), // ...or ≥ this many points within 20 seconds
    priceSpikePct: num(env.PRICE_SPIKE_PCT, 10), // premium spike: a CE/PE near ATM rises ≥ this % within 1 minute
    priceMinLtp: num(env.PRICE_MIN_LTP, 5), // ...ignoring options priced below this (₹), where % moves are noise
    bothRisePct: num(env.BOTH_RISE_PCT, 3), // CE & PE both rising: both legs up ≥ this % within 1 minute...
    bothRisePairs: num(env.BOTH_RISE_PAIRS, 3), // ...on at least this many of the 5 strikes around ATM
    baselineMin: num(env.BASELINE_MIN, 5), // minutes of history needed before volume signals start
    strikesAround: num(env.SIGNAL_STRIKES, 10), // strikes either side of ATM that are watched and recorded
    beforeMin: num(env.CAPTURE_BEFORE_MIN, 5), // minutes of data saved before a spike
    afterMin: num(env.CAPTURE_AFTER_MIN, 5), // max minutes of data saved after the last spike...
    minAfterSec: num(env.CAPTURE_MIN_AFTER_SEC, 60), // ...but recording stops once at least this long has passed
    calmSec: num(env.CAPTURE_CALM_SEC, 30), // ...and no signal condition has been true for this long (cooled off)
    cooldownMin: num(env.SPIKE_COOLDOWN_MIN, 5), // the same signal won't repeat within this time
    dir,
  };
}

// odds = the track record of past signals (sigstats.buildStats); each new signal is tagged with its kind's record.
// cfg.replay = backtest over a tape (signal-backtest.js): signals are only collected, nothing is recorded or saved.
function createSignals(cfg, logError = (src, e) => console.error(src, e), odds = null) {
  const cooldowns = new Map(); // trigger key -> last time it fired
  const events = cfg.replay ? [] : loadDay(istDate(Date.now())); // newest first, shown in the UI
  let capture = null;
  let breadth = { ready: false };

  function onSnapshot(hist, snap) {
    const cur = hist[hist.length - 1];
    const now = cur.t;
    if (capture) capture.entries.push(cur);

    const result = evaluate(hist, snap, now);
    breadth = result.breadth;
    for (const tr of result.triggers) {
      const ev = applyCooldown(tr, now);
      if (ev) record(ev, hist, snap, now);
    }
    if (!capture) return;

    // Any trigger condition still true (even one held back by cooldown) means it hasn't cooled off yet.
    if (result.triggers.length) capture.lastHotAt = now;
    const sinceSignal = now - capture.lastSignalAt;
    const calmFor = now - capture.lastHotAt;
    if (sinceSignal >= cfg.minAfterSec * 1000 && calmFor >= cfg.calmSec * 1000) finalize('cooled off');
    else if (now >= capture.endsAt) finalize('max length');
  }

  function evaluate(hist, snap, now) {
    const triggers = [];
    const cur = hist[hist.length - 1];
    const m1 = hist.find((h) => h.t >= now - MIN);
    const base = hist.find((h) => h.t >= now - (BASELINE_SPAN_MIN + 1) * MIN);
    const lastSpan = (cur.t - m1.t) / MIN;
    const baseSpan = (m1.t - base.t) / MIN;

    // Nifty moves: a fast window (default 15 pts in 20 s) and a 1-minute window (25 pts). Up and down
    // are separate signals with their own cooldowns, so a sharp fall right after a rise still fires.
    const s20 = hist.find((h) => h.t >= now - 20_000);
    for (const [from, pts] of [
      [s20, cfg.spotFastPts],
      [m1, cfg.spotMovePts],
    ]) {
      const span = (cur.t - from.t) / 1000;
      if (span < 10 || cur.spot == null || from.spot == null) continue;
      const move = cur.spot - from.spot;
      if (Math.abs(move) < pts) continue;
      const dir = move > 0 ? 'up' : 'down';
      triggers.push({
        key: `spot-${dir}`,
        type: `spot-${dir}`,
        detail: `Nifty ${dir === 'up' ? 'rose' : 'fell'} ${Math.abs(move).toFixed(1)} pts in ${Math.round(span)}s (${from.spot.toFixed(1)} → ${cur.spot.toFixed(1)})`,
      });
      break; // one spot signal per check; the fast window wins
    }

    const premium = evaluatePremium(snap, cur, m1, lastSpan, triggers);

    if (lastSpan < 0.5 || baseSpan < cfg.baselineMin) {
      const haveSec = (cur.t - hist[0].t) / 1000;
      return { breadth: { ready: false, readyInSec: Math.max(0, Math.round((cfg.baselineMin + 1) * 60 - haveSec)), premium }, triggers };
    }

    // Per leg (strike + CE/PE) near ATM: volume rate in the last minute vs its normal rate.
    const legs = [];
    for (const r of nearStrikes(snap)) {
      for (const [side, idx] of [
        ['CE', CE_VOL],
        ['PE', PE_VOL],
      ]) {
        const v0 = base.d[r.strike]?.[idx];
        const v1 = m1.d[r.strike]?.[idx];
        const v2 = cur.d[r.strike]?.[idx];
        if (v0 == null || v1 == null || v2 == null) continue;
        const baseRate = Math.max(0, v1 - v0) / baseSpan;
        const lastRate = Math.max(0, v2 - v1) / lastSpan;
        const ratio = baseRate > 0 ? lastRate / baseRate : lastRate > 0 ? Infinity : 0;
        legs.push({ strike: r.strike, side, baseRate, lastRate, ratio });
      }
    }

    const counted = legs.filter((l) => l.baseRate > 0);
    const elevated = counted.filter((l) => l.ratio >= cfg.broadRatio);
    const pct = counted.length ? (elevated.length / counted.length) * 100 : 0;
    const ce = elevated.filter((l) => l.side === 'CE').length;
    const pe = elevated.length - ce;
    const active = counted.length >= 10 && pct >= cfg.broadPct;
    const b = { ready: true, pct, elevated: elevated.length, legs: counted.length, ce, pe, active, premium };
    if (active) {
      triggers.push({
        key: 'broad',
        type: 'broad-surge',
        detail: `${elevated.length}/${counted.length} strikes near ATM trading ≥${cfg.broadRatio}× normal volume (CE ${ce}, PE ${pe})`,
      });
    }

    const spikes = legs.filter((l) => l.ratio >= cfg.spikeRatio && l.lastRate >= cfg.spikeMinQty);
    if (spikes.length) triggers.push({ type: 'strike-spike', legs: spikes });
    return { breadth: b, triggers };
  }

  // Option premiums near ATM over the last minute: single-leg jumps, and calls + puts rising together.
  // Normally one side falls when the other rises; both rising means option prices (IV) are expanding.
  function evaluatePremium(snap, cur, m1, lastSpan, triggers) {
    if (lastSpan < 0.5) return null;
    const near = nearStrikes(snap);
    if (!near.length) return null;
    const chg = (k, idx) => {
      const p1 = m1.d[k]?.[idx];
      const p2 = cur.d[k]?.[idx];
      if (p1 == null || p2 == null || p1 < cfg.priceMinLtp) return null;
      return { from: p1, to: p2, pct: ((p2 - p1) / p1) * 100 };
    };

    // Sharp premium moves in either direction, reported separately per side and direction
    // (e.g. "PE ▲" and "CE ▼" in a sudden fall) so one side can never hide the other.
    const groups = {};
    for (const r of near) {
      for (const [side, idx] of [
        ['CE', CE_LTP],
        ['PE', PE_LTP],
      ]) {
        const c = chg(r.strike, idx);
        if (!c || Math.abs(c.pct) < cfg.priceSpikePct) continue;
        const dir = c.pct > 0 ? 'up' : 'down';
        (groups[`${side}-${dir}`] ||= []).push({ strike: r.strike, side, ratio: Math.abs(c.pct), ...c });
      }
    }
    for (const [g, legs] of Object.entries(groups)) {
      const [side, dir] = g.split('-');
      triggers.push({ type: `premium-${dir}`, group: g, label: `${side} premium ${dir === 'up' ? '▲' : '▼'}`, legs });
    }

    // ATM ± 2 strikes: how many CE/PE pairs have both legs up by at least bothRisePct.
    const atmIdx = Math.floor(near.length / 2);
    const pairs = near.slice(Math.max(0, atmIdx - 2), atmIdx + 3);
    let both = 0;
    for (const r of pairs) {
      const c = chg(r.strike, CE_LTP);
      const p = chg(r.strike, PE_LTP);
      if (c && p && c.pct >= cfg.bothRisePct && p.pct >= cfg.bothRisePct) both++;
    }
    const atm = near[atmIdx].strike;
    const ce = chg(atm, CE_LTP);
    const pe = chg(atm, PE_LTP);
    const straddle = ce && pe ? ((ce.to + pe.to - (ce.from + pe.from)) / (ce.from + pe.from)) * 100 : null;
    const bothRising = both >= Math.min(cfg.bothRisePairs, pairs.length);
    if (bothRising) {
      triggers.push({
        key: 'both-rising',
        type: 'both-rising',
        detail:
          `Calls and puts both rising: ${both}/${pairs.length} strikes around ATM up ≥${cfg.bothRisePct}% on both sides in ${Math.round(lastSpan * 60)}s` +
          (straddle != null ? ` · ATM ${atm} CE ${fmtPct(ce.pct)}, PE ${fmtPct(pe.pct)}, straddle ${fmtPct(straddle)}` : ''),
      });
    }
    return { atm, ce: ce?.pct ?? null, pe: pe?.pct ?? null, straddle, both, pairs: pairs.length, bothRising };
  }

  // Each signal fires at most once per cooldown period. Strike-level signals (volume and premium spikes)
  // are batched into one event per minute, and each strike/side can only appear once per cooldown.
  function applyCooldown(tr, now) {
    const ready = (key) => now - (cooldowns.get(key) || 0) >= cfg.cooldownMin * MIN;
    if (!tr.legs) {
      if (!ready(tr.key)) return null;
      cooldowns.set(tr.key, now);
      return tr;
    }
    const group = `${tr.type}:${tr.group || ''}`;
    if (now - (cooldowns.get(`${group}:group`) || 0) < MIN) return null;
    const legs = tr.legs.filter((l) => ready(`${tr.type}:${l.strike}${l.side}`)).sort((a, b) => b.ratio - a.ratio);
    if (!legs.length) return null;
    cooldowns.set(`${group}:group`, now);
    for (const l of legs) cooldowns.set(`${tr.type}:${l.strike}${l.side}`, now);
    const isPremium = tr.type.startsWith('premium');
    const more = legs.length > 5 ? ` +${legs.length - 5} more` : '';
    const parts = legs
      .slice(0, 5)
      .map((l) =>
        isPremium
          ? `${l.strike} ${fmtPct(l.pct)} (${l.from.toFixed(2)} → ${l.to.toFixed(2)})`
          : `${l.strike} ${l.side} ${Number.isFinite(l.ratio) ? l.ratio.toFixed(1) + '×' : 'new'} (+${compact(l.lastRate)}/min)`,
      );
    const label = isPremium ? tr.label : 'Volume spike';
    return { type: tr.type, detail: `${label}: ${parts.join(', ')}${more}`, strikes: legs.map((l) => `${l.strike}${l.side}`), lead: legs[0] };
  }

  function record(tr, hist, snap, now) {
    const kind = signalKind(
      tr.type,
      tr.lead,
      hist[hist.length - 1],
      hist.find((h) => h.t >= now - MIN),
    );
    const ev = {
      id: `${now}-${tr.type}`,
      t: now,
      type: tr.type,
      kind,
      detail: tr.detail,
      spot: snap.spot,
      odds: odds?.lookup(kind) ?? null,
      after: null,
      file: null,
    };
    events.unshift(ev);
    if (cfg.replay) return;
    if (events.length > 300) events.pop();
    console.log(
      `[signal] ${istTime(now)} ${tr.type} — ${tr.detail}` +
        (ev.odds?.high ? ` · HIGH PROBABILITY: Nifty ${ev.odds.dir} ${Math.round(ev.odds.p * 100)}% (${ev.odds.hits}/${ev.odds.n})` : ''),
    );

    if (!capture) {
      capture = {
        startedAt: now,
        lastSignalAt: now,
        lastHotAt: now,
        endsAt: now + cfg.afterMin * MIN,
        strikes: nearStrikes(snap).map((r) => r.strike),
        entries: hist.filter((h) => h.t >= now - cfg.beforeMin * MIN),
        events: [ev],
      };
    } else {
      capture.events.push(ev);
      capture.lastSignalAt = now;
      capture.lastHotAt = now;
      capture.endsAt = Math.min(Math.max(capture.endsAt, now + cfg.afterMin * MIN), capture.startedAt + MAX_CAPTURE_MIN * MIN);
    }
  }

  function finalize(reason = 'shutdown') {
    const c = capture;
    capture = null;
    if (!c) return;
    try {
      const day = istDate(c.startedAt);
      const dir = path.join(cfg.dir, day);
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${istTime(c.startedAt).replace(/:/g, '')}_${c.events[0].type}.csv`;
      const relFile = path.join(path.basename(cfg.dir), day, fileName).replace(/\\/g, '/');

      // Tick-level file: every snapshot before/after, for the strikes around ATM at signal time.
      const first = c.events[0].t;
      const lines = [TICKS_CSV_HEADER.join(',')];
      let prev = null;
      for (const e of c.entries) {
        const marker = c.events
          .filter((ev) => ev.t === e.t)
          .map((ev) => `${ev.type}: ${ev.detail}`)
          .join(' | ');
        for (const k of c.strikes) {
          const r = e.d[k];
          if (!r) continue;
          const p = prev?.d[k];
          lines.push(
            csvRow([
              istTime(e.t),
              Math.round((e.t - first) / 1000),
              round(e.spot),
              k,
              r[CE_LTP],
              r[CE_VOL],
              p ? r[CE_VOL] - p[CE_VOL] : '',
              r[CE_OI],
              r[PE_LTP],
              r[PE_VOL],
              p ? r[PE_VOL] - p[PE_VOL] : '',
              r[PE_OI],
              marker,
            ]),
          );
        }
        prev = e;
      }
      fs.writeFileSync(path.join(dir, fileName), BOM + lines.join('\n') + '\n');

      // One summary row per signal: how spot and volume behaved before vs after it.
      const csvFile = path.join(dir, 'events.csv');
      if (!fs.existsSync(csvFile)) fs.writeFileSync(csvFile, BOM + EVENTS_CSV_HEADER.join(',') + '\n');
      for (const ev of c.events) {
        const before = c.entries.filter((e) => e.t <= ev.t && e.t >= ev.t - cfg.beforeMin * MIN);
        const after = c.entries.filter((e) => e.t >= ev.t && e.t <= ev.t + cfg.afterMin * MIN);
        const spots = after.map((e) => e.spot).filter((s) => s != null);
        const s0 = before[0]?.spot ?? null;
        const s2 = spots[spots.length - 1] ?? null;
        ev.after = {
          spotBefore: s0,
          spotAfter: s2,
          change: s2 != null && ev.spot != null ? s2 - ev.spot : null,
          maxUp: spots.length && ev.spot != null ? Math.max(...spots) - ev.spot : null,
          maxDown: spots.length && ev.spot != null ? Math.min(...spots) - ev.spot : null,
          ceBefore: volAdded(before, c.strikes, CE_VOL),
          ceAfter: volAdded(after, c.strikes, CE_VOL),
          peBefore: volAdded(before, c.strikes, PE_VOL),
          peAfter: volAdded(after, c.strikes, PE_VOL),
          beforeSec: before.length ? Math.round((ev.t - before[0].t) / 1000) : 0,
          afterSec: after.length ? Math.round((after[after.length - 1].t - ev.t) / 1000) : 0,
        };
        ev.file = relFile;
        const a = ev.after;
        fs.appendFileSync(
          csvFile,
          csvRow([
            day,
            istTime(ev.t),
            ev.type,
            ev.detail,
            round(a.spotBefore),
            round(ev.spot),
            round(a.spotAfter),
            round(a.change),
            round(a.maxUp),
            round(a.maxDown),
            a.ceBefore,
            a.ceAfter,
            a.peBefore,
            a.peAfter,
            a.beforeSec,
            a.afterSec,
            relFile,
          ]) + '\n',
        );
        fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
      }
      console.log(
        `[signal] recorded ${c.events.length} signal(s), ${Math.round((c.entries.at(-1).t - c.startedAt) / 1000)}s after the first (${reason}) → ${relFile}`,
      );
    } catch (e) {
      logError('recording', e);
    }
  }

  function nearStrikes(snap) {
    const rows = snap.rows;
    if (!rows.length || snap.spot == null) return [];
    let atm = 0;
    rows.forEach((r, i) => {
      if (Math.abs(r.strike - snap.spot) < Math.abs(rows[atm].strike - snap.spot)) atm = i;
    });
    return rows.slice(Math.max(0, atm - cfg.strikesAround), atm + cfg.strikesAround + 1);
  }

  function loadDay(day) {
    try {
      return fs
        .readFileSync(path.join(cfg.dir, day, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .reverse();
    } catch {
      return [];
    }
  }

  return {
    onSnapshot,
    flush: finalize, // write any in-progress recording (e.g. on shutdown)
    all: () => events,
    state: () => ({
      breadth,
      recording: capture
        ? {
            startedAt: capture.startedAt,
            lastSignalAt: capture.lastSignalAt,
            lastHotAt: capture.lastHotAt,
            endsAt: capture.endsAt,
            minAfterSec: cfg.minAfterSec,
            calmSec: cfg.calmSec,
          }
        : null,
      events: events.filter((e) => istDate(e.t) === istDate(Date.now())).slice(0, 100),
      rules: {
        spikeRatio: cfg.spikeRatio,
        spikeMinQty: cfg.spikeMinQty,
        broadRatio: cfg.broadRatio,
        broadPct: cfg.broadPct,
        spotMovePts: cfg.spotMovePts,
        spotFastPts: cfg.spotFastPts,
        strikesAround: cfg.strikesAround,
        priceSpikePct: cfg.priceSpikePct,
        bothRisePct: cfg.bothRisePct,
        bothRisePairs: cfg.bothRisePairs,
        beforeMin: cfg.beforeMin,
        afterMin: cfg.afterMin,
        cooldownMin: cfg.cooldownMin,
      },
    }),
  };
}

// Total volume added across strikes between the first and last snapshot of a list.
function volAdded(list, strikes, idx) {
  if (list.length < 2) return 0;
  const a = list[0];
  const b = list[list.length - 1];
  let sum = 0;
  for (const k of strikes) {
    if (a.d[k] && b.d[k]) sum += Math.max(0, b.d[k][idx] - a.d[k][idx]);
  }
  return sum;
}

// ---------- utils ----------
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
const round = (n) => (n == null ? '' : Math.round(n * 100) / 100);

function csvRow(values) {
  return values
    .map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(Math.round(n));
}

module.exports = { createSignals, signalConfig };
