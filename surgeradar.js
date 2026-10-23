// Live option-surge radar (Trading Ideas › Option surges › Live radar): watches the live chain snapshots and flags
// options whose premium is climbing off today's low, early, with what is behind it (volume pace, open interest, the
// Nifty move). Paper only: it records what it flagged and when (events/<day>/surge-radar.jsonl), so its calls can be
// checked later, and never trades.
//
// A low has to hold for two snapshots in a row (a stray print is not a low). Lows are known from the first snapshot this
// server saw today; they are saved every minute (events/<day>/surge-radar-state.json) so a restart keeps them.
const fs = require('fs');
const path = require('path');
const { istDate } = require('./lib/time');

const EVERY_MS = 5000; // snapshots are read at most this often per expiry
const STAGES = [
  ['tripled', 3],
  ['doubled', 2],
  ['rising', 1.5],
];
const MAX_DTE = 7;

// minLow(): the lowest option price (₹) watched — lows under it are too thin to mean anything (the screen's setting)
function createSurgeRadar({ dir, logError = () => {}, minLow = () => 4 }) {
  let day = null;
  const seen = new Map(); // key -> per-contract state for today
  const lastAt = new Map(); // expiry -> last processed snapshot time
  let spotLow = null; // Nifty's own low / high today, for "Nifty moved since"
  let spotHigh = null;
  let firstAt = null;
  let lastSpot = null;
  let savedAt = 0;
  const alerts = [];

  const dayDir = () => path.join(dir, day);
  function restore() {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dayDir(), 'surge-radar-state.json'), 'utf8'));
      if (s.day !== day) return;
      for (const [k, v] of s.seen) seen.set(k, v);
      firstAt = s.firstAt;
      spotLow = s.spotLow;
      spotHigh = s.spotHigh;
    } catch {}
    try {
      for (const line of fs.readFileSync(path.join(dayDir(), 'surge-radar.jsonl'), 'utf8').split('\n')) if (line.trim()) alerts.push(JSON.parse(line));
    } catch {}
  }
  function save() {
    try {
      fs.mkdirSync(dayDir(), { recursive: true });
      const file = path.join(dayDir(), 'surge-radar-state.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify({ day, firstAt, spotLow, spotHigh, seen: [...seen] }));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      logError('surge-radar', e);
    }
  }
  function record(a) {
    alerts.push(a);
    while (alerts.length > 500) alerts.shift();
    try {
      fs.mkdirSync(dayDir(), { recursive: true });
      fs.appendFileSync(path.join(dayDir(), 'surge-radar.jsonl'), JSON.stringify(a) + '\n');
    } catch (e) {
      logError('surge-radar', e);
    }
  }

  // snap: { expiry, updatedAt, spot, rows: [{ strike, ce, pe }] } with ce / pe = { key, ltp, close, vol, oi, prevOi, iv }
  function update(snap) {
    if (!snap?.rows?.length || !(snap.spot > 0)) return;
    const now = snap.updatedAt || Date.now();
    if (now - (lastAt.get(snap.expiry) || 0) < EVERY_MS) return;
    lastAt.set(snap.expiry, now);
    const today = istDate(now);
    if (today !== day) {
      day = today;
      seen.clear();
      alerts.length = 0;
      spotLow = spotHigh = firstAt = null;
      restore();
    }
    const dte = Math.round((Date.parse(snap.expiry) - Date.parse(today)) / 86400_000);
    if (dte > MAX_DTE) return;
    firstAt ??= now;
    const spot = snap.spot;
    lastSpot = { spot, at: now };
    if (spotLow == null || spot < spotLow) spotLow = spot;
    if (spotHigh == null || spot > spotHigh) spotHigh = spot;
    for (const r of snap.rows)
      for (const [type, o] of [
        ['CE', r.ce],
        ['PE', r.pe],
      ]) {
        if (!o?.key || !(o.ltp > 0)) continue;
        let s = seen.get(o.key);
        if (!s) {
          s = {
            expiry: snap.expiry,
            strike: r.strike,
            type,
            prev: o.ltp,
            low: null,
            lowAt: null,
            lowSpot: null,
            lowOi: null,
            lowVol: null,
            high: o.ltp,
            stage: null,
            firstVol: o.vol ?? 0,
            firstAt: now,
            vols: [],
          };
          seen.set(o.key, s);
        }
        const held = Math.max(o.ltp, s.prev); // a low only counts once the next snapshot is no lower
        if (s.low == null || held < s.low) {
          s.low = held;
          s.lowAt = now;
          s.lowSpot = spot;
          s.lowOi = o.oi ?? null;
          s.lowVol = o.vol ?? null;
          s.stage = null; // a new low starts over
        }
        s.prev = o.ltp;
        s.high = Math.max(s.high, Math.min(o.ltp, held));
        s.ltp = o.ltp;
        s.close = o.close ?? null;
        s.vol = o.vol ?? 0;
        s.oi = o.oi ?? null;
        s.prevOi = o.prevOi ?? null;
        s.iv = o.iv ?? null;
        s.at = now;
        // volume over the last 5 minutes, kept as [time, cumulative volume] samples
        s.vols.push([now, s.vol]);
        while (s.vols.length > 2 && now - s.vols[1][0] > 5 * 60_000) s.vols.shift();
        if (!(s.low >= minLow())) continue;
        const mult = Math.min(o.ltp, held) / s.low;
        const stage = STAGES.find(([, x]) => mult >= x)?.[0] || null;
        const rank = (x) => (x ? 3 - STAGES.findIndex(([k]) => k === x) : 0);
        if (stage && rank(stage) > rank(s.stage)) {
          s.stage = stage;
          const row = describe(o.key, s, now);
          record({
            t: now,
            stage,
            key: o.key,
            expiry: s.expiry,
            strike: s.strike,
            type,
            ltp: o.ltp,
            low: s.low,
            mult: row.mult,
            volPace: row.volPace,
            oiSinceLow: row.oiSinceLow,
            niftySinceLow: row.niftySinceLow,
            spot,
          });
        }
      }
    if (now - savedAt > 60_000) {
      savedAt = now;
      save();
    }
  }

  // One contract as the screen shows it.
  function describe(key, s, now = Date.now()) {
    const call = s.type === 'CE';
    const mins = Math.max(1, (now - s.firstAt) / 60_000);
    const sessionPace = (s.vol - s.firstVol) / mins; // volume per minute since this server first saw it
    const v0 = s.vols[0];
    const recentPace = v0 && now - v0[0] > 30_000 ? (s.vol - v0[1]) / ((now - v0[0]) / 60_000) : null;
    return {
      key,
      expiry: s.expiry,
      strike: s.strike,
      type: s.type,
      ltp: s.ltp,
      low: s.low,
      lowAt: s.lowAt,
      high: s.high,
      close: s.close,
      mult: s.low ? Math.round((s.ltp / s.low) * 100) / 100 : null,
      dayChg: s.close ? Math.round((s.ltp / s.close - 1) * 1000) / 10 : null,
      volPace: recentPace != null && sessionPace > 0 ? Math.round((recentPace / sessionPace) * 10) / 10 : null,
      vol: s.vol,
      volSinceLow: s.lowVol != null ? s.vol - s.lowVol : null,
      oi: s.oi,
      oiDay: s.prevOi > 0 && s.oi != null ? Math.round(((s.oi - s.prevOi) / s.prevOi) * 1000) / 10 : null,
      oiSinceLow: s.lowOi > 0 && s.oi != null ? Math.round(((s.oi - s.lowOi) / s.lowOi) * 1000) / 10 : null,
      niftySinceLow: s.lowSpot && lastSpot ? Math.round(((lastSpot.spot - s.lowSpot) / s.lowSpot) * 100 * (call ? 1 : -1) * 100) / 100 : null,
      iv: s.iv,
      stage: s.stage,
    };
  }

  function state() {
    const now = Date.now();
    const rows = [];
    for (const [key, s] of seen) if (s.low >= minLow() && s.ltp > 0) rows.push(describe(key, s, now));
    rows.sort((a, b) => b.mult - a.mult);
    return {
      day,
      firstAt,
      at: lastSpot?.at || null,
      spot: lastSpot?.spot || null,
      spotLow,
      spotHigh,
      rows: rows.slice(0, 120),
      alerts: alerts.slice(-200).reverse(),
      minLow: minLow(),
      maxDte: MAX_DTE,
    };
  }

  return { update, state };
}

module.exports = { createSurgeRadar };
