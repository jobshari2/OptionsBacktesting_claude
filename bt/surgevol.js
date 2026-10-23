// Volume and open interest behind the option surges (bt/surge.js). The option cache (bt-cache/opt) keeps prices only,
// so for the contracts that surged this downloads their 1-minute candles again with volume and OI, from a few
// sessions before the low to the peak, into bt-cache/vol/<expiry>/<strike><type>.json.gz:
//   { from, to, days: { day: base64 Int32Array(MPD*2) = [volume, oi] per minute, -1 = no candle } }
// From those, flowStats() says how much heavier than usual the trading was during the surge, whether volume rose
// before the price did, and what open interest did (falling = sellers buying back, rising = new positions).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MPD, OPEN_MIN, addDays } = require('./data');

const BEFORE_DAYS = 7; // calendar days before the low: the usual volume is measured on those sessions
const CHUNK_DAYS = 28;
const BURST = 5; // a minute with this many times the median volume of the session's previous BURST_WINDOW minutes is a burst
const BURST_WINDOW = 15;

const minuteOf = (ts) => Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) - OPEN_MIN;
const volFile = (cacheDir, expiry, strike, type) => path.join(cacheDir, 'vol', expiry, `${strike}${type}.json.gz`);

function readVol(cacheDir, expiry, strike, type) {
  try {
    const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(volFile(cacheDir, expiry, strike, type))).toString('utf8'));
    const days = new Map();
    for (const d of Object.keys(saved.days).sort()) {
      const buf = Buffer.from(saved.days[d], 'base64');
      days.set(d, new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    }
    return { from: saved.from, to: saved.to, days };
  } catch {
    return null;
  }
}

// Downloads what is missing for the given surges ([{ expiry, strike, type, troughDay, peakDay }]). api(pathname) is the
// data layer's Upstox call (bulk, rate-limited). Returns { contracts, fetched, failed }.
async function fetchVolumes(api, cacheDir, surges, { onProgress, stopped, logError = () => {} } = {}) {
  const want = new Map(); // contract -> [from, to]
  for (const s of surges) {
    const id = `${s.expiry}|${s.strike}|${s.type}`;
    const from = addDays(s.troughDay, -BEFORE_DAYS);
    const w = want.get(id);
    want.set(id, w ? [w[0] < from ? w[0] : from, w[1] > s.peakDay ? w[1] : s.peakDay] : [from, s.peakDay]);
  }
  const keys = new Map(); // expiry -> Map(`${strike}${type}` -> instrument key)
  const keyOf = (expiry, strike, type) => {
    if (!keys.has(expiry)) {
      const m = new Map();
      try {
        for (const [k, t, key] of JSON.parse(fs.readFileSync(path.join(cacheDir, 'contracts', expiry + '.json'), 'utf8'))) m.set(`${k}${t}`, key);
      } catch {}
      keys.set(expiry, m);
    }
    return keys.get(expiry).get(`${strike}${type}`);
  };
  let done = 0;
  let fetched = 0;
  let failed = 0;
  const todo = [...want].filter(([id, [from, to]]) => {
    const [expiry, strike, type] = id.split('|');
    const have = readVol(cacheDir, expiry, strike, type);
    return !(have && have.from <= from && have.to >= to);
  });
  for (const [id, [from, to]] of todo) {
    if (stopped?.()) break;
    onProgress?.({ phase: 'Volume and OI ' + id.replace(/\|/g, ' '), done, total: todo.length });
    done++;
    const [expiry, strike, type] = id.split('|');
    const key = keyOf(expiry, strike, type);
    if (!key) {
      failed++;
      continue;
    }
    try {
      const have = readVol(cacheDir, expiry, strike, type);
      const days = new Map(have ? have.days : []);
      for (let a = from; a <= to; a = addDays(a, CHUNK_DAYS + 1)) {
        const b = addDays(a, CHUNK_DAYS) < to ? addDays(a, CHUNK_DAYS) : to;
        const data = await api(`/v2/expired-instruments/historical-candle/${encodeURIComponent(key)}/1minute/${b}/${a}`);
        for (const c of data?.candles || []) {
          const m = minuteOf(c[0]);
          if (m < 0 || m >= MPD) continue;
          const day = c[0].slice(0, 10);
          if (!days.has(day)) days.set(day, new Int32Array(MPD * 2).fill(-1));
          days.get(day).set([Math.round(c[5] || 0), Math.round(c[6] || 0)], m * 2);
        }
      }
      const out = { from: have && have.from < from ? have.from : from, to: have && have.to > to ? have.to : to, days: {} };
      for (const [d, arr] of days) out.days[d] = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
      const file = volFile(cacheDir, expiry, strike, type);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', zlib.gzipSync(JSON.stringify(out)));
      fs.renameSync(file + '.tmp', file);
      fetched++;
    } catch (e) {
      failed++;
      logError('surge-volume', e, id);
      if (/session expired|not logged in|demo mode/i.test(e.message)) throw e;
    }
  }
  return { contracts: want.size, fetched, failed, missing: todo.length - fetched };
}

// What the trading looked like during one surge (intraday or multi-day), or null without a volume file.
//   volMult   volume per minute from the low to the peak ÷ the usual volume per minute (earlier sessions)
//   volLead   minutes the first volume burst (5× the session's pace of the previous 15 min) came before the +50 % mark
//             (negative: after it); null when there was none; intraday only
//   oiChg     % change of open interest from the low to the peak
//   flow      'Short covering' (OI down ≥ 3 % while the price rose), 'Long build-up' (OI up ≥ 3 %), 'Flat OI'
//   turnover  ₹ traded from the low to the peak
//   lots      contracts traded from the low to the peak, in lots
function flowStats(cacheDir, ev, prices) {
  const v = readVol(cacheDir, ev.expiry, ev.strike, ev.type);
  if (!v) return null;
  // usual volume per minute: the sessions before the low's
  let base = 0;
  let baseMin = 0;
  for (const [d, a] of v.days) {
    if (d >= ev.troughDay) continue;
    for (let m = 0; m < MPD; m++) if (a[m * 2] >= 0) base += a[m * 2];
    baseMin += MPD;
  }
  // none earlier (a new contract): the low's own session before the low
  if (!baseMin) {
    const a = v.days.get(ev.troughDay);
    if (a && ev.troughMin >= 30) {
      for (let m = 0; m < ev.troughMin; m++) if (a[m * 2] >= 0) base += a[m * 2];
      baseMin = ev.troughMin;
    }
  }
  const usual = baseMin ? base / baseMin : null;
  let vol = 0;
  let mins = 0;
  let turnover = 0;
  let oiLow = null;
  let oiPeak = null;
  for (const [d, a] of v.days) {
    if (d < ev.troughDay || d > ev.peakDay) continue;
    const p = prices.get(d);
    const m0 = d === ev.troughDay ? ev.troughMin : 0;
    const m1 = d === ev.peakDay ? ev.peakMin : MPD - 1;
    for (let m = m0; m <= m1; m++) {
      mins++;
      if (a[m * 2] > 0) {
        vol += a[m * 2];
        const c = p ? p[m * 4 + 3] : -1;
        if (c > 0) turnover += (a[m * 2] * c) / 100;
      }
      if (a[m * 2 + 1] > 0) {
        if (oiLow == null) oiLow = a[m * 2 + 1];
        oiPeak = a[m * 2 + 1];
      }
    }
  }
  // The first burst from 30 minutes before the low (intraday only: the minutes are of one session), against the same
  // session's own recent pace: a contract trades more every day towards expiry, so earlier sessions would make every
  // minute of the surge day look like a burst.
  let volLead = null;
  if (ev.span === 'intraday' && ev.m50 != null) {
    const a = v.days.get(ev.troughDay);
    if (a)
      for (let m = Math.max(BURST_WINDOW, ev.troughMin - 30); m <= ev.peakMin; m++) {
        const prior = [];
        for (let k = m - BURST_WINDOW; k < m; k++) prior.push(Math.max(0, a[k * 2]));
        prior.sort((x, y) => x - y);
        const med = prior[prior.length >> 1];
        if (med > 0 && a[m * 2] >= BURST * med) {
          volLead = ev.m50 - m;
          break;
        }
      }
  }
  const oiChg = oiLow > 0 && oiPeak != null ? ((oiPeak - oiLow) / oiLow) * 100 : null;
  return {
    volMult: usual > 0 && mins ? Math.round((vol / mins / usual) * 10) / 10 : null,
    volLead,
    oiChg: oiChg == null ? null : Math.round(oiChg * 10) / 10,
    flow: oiChg == null ? null : oiChg <= -3 ? 'Short covering' : oiChg >= 3 ? 'Long build-up' : 'Flat OI',
    turnover: Math.round(turnover),
    lots: ev.lot ? Math.round(vol / ev.lot) : null,
  };
}

// Volume and OI per minute of one contract for a chart: { days: { day: [[minute, volume, oi], …] } } or null.
function volSeries(cacheDir, expiry, strike, type, fromDay, toDay) {
  const v = readVol(cacheDir, expiry, strike, type);
  if (!v) return null;
  const days = {};
  for (const [d, a] of v.days) {
    if (d < fromDay || d > toDay) continue;
    const rows = [];
    for (let m = 0; m < MPD; m++) if (a[m * 2] >= 0) rows.push([m, a[m * 2], a[m * 2 + 1]]);
    days[d] = rows;
  }
  return { days };
}

module.exports = { fetchVolumes, flowStats, volSeries, readVol };
