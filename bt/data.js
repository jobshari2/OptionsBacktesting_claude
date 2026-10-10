// Historical data for the backtester, from Upstox:
//   - Nifty 50 and India VIX 1-minute candles (/v3/historical-candle, available from 2022)
//   - 1-minute candles of expired Nifty option contracts (/v2/expired-instruments, ~2 years back)
// Everything is cached on disk (gzip) and in memory, so a contract is downloaded once and later runs
// are pure computation. Prices are kept as Int32 paise, one bar = [open, high, low, close].
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createUpstox } = require('../lib/upstox');
const { istDate: istToday } = require('../lib/time');

const NIFTY = 'NSE_INDEX|Nifty 50';
const VIX = 'NSE_INDEX|India VIX';
const MPD = 375; // minutes per trading day, 09:15 .. 15:29
const OPEN_MIN = 9 * 60 + 15;
const CHUNK_DAYS = 28; // span of one option-candle request
const LOOKBACK_DAYS = 35; // first download of a contract covers this many days before its expiry
const MEM_CONTRACTS = 1500; // contracts kept in memory (≈ 150 KB each)

const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const minuteOf = (ts) => Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) - OPEN_MIN;

// upstox: the app's Upstox client (lib/upstox.js); left out, the data layer makes its own (tests, scripts).
function createData({ getToken, upstox = createUpstox({ getToken }), cacheDir, logError = () => {} }) {
  const limiter = upstox.limiter;
  const inflight = new Map();
  fs.mkdirSync(cacheDir, { recursive: true });

  async function api(pathname) {
    if (getToken() === 'demo') throw new Error('Backtesting needs real Upstox data (not available in demo mode)');
    return upstox.bulk(pathname);
  }
  // One request per key at a time; later callers share the first one's promise.
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const readGz = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  function writeGz(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', zlib.gzipSync(JSON.stringify(obj), { level: 6 }));
    fs.renameSync(file + '.tmp', file);
  }

  // ---------- index candles (Nifty, VIX) per calendar month ----------
  const indexMem = new Map(); // `${key}|${month}` -> Map(day -> Float64Array(MPD*4))
  const indexAt = new Map(); // when the running month was last read (it is re-read after an hour)

  function denseIndex(candles) {
    const days = {};
    for (const c of candles) {
      const m = minuteOf(c[0]);
      if (m < 0 || m >= MPD) continue;
      const day = c[0].slice(0, 10);
      (days[day] ||= new Array(MPD * 4).fill(null));
      days[day].splice(m * 4, 4, c[1], c[2], c[3], c[4]);
    }
    // Fill gaps: before the first candle with its open, afterwards with the previous close.
    for (const a of Object.values(days)) {
      let first = -1;
      for (let m = 0; m < MPD; m++) if (a[m * 4] != null) { first = m; break; }
      for (let m = 0; m < MPD; m++) {
        if (a[m * 4] != null) continue;
        const v = m < first ? a[first * 4] : a[(m - 1) * 4 + 3];
        a.splice(m * 4, 4, v, v, v, v);
      }
    }
    return days;
  }

  async function indexMonth(key, month) {
    const memKey = `${key}|${month}`;
    const running = month >= istToday().slice(0, 7);
    if (indexMem.has(memKey) && (!running || Date.now() - indexAt.get(memKey) < 3600_000)) return indexMem.get(memKey);
    return once('idx|' + memKey, async () => {
      const file = path.join(cacheDir, 'index', key.replace(/[^A-Za-z0-9]+/g, '_'), month + '.json.gz');
      const first = month + '-01';
      const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
      const today = istToday();
      const complete = last < today;
      let days = null;
      let saved = null;
      let at = Date.now();
      if (fs.existsSync(file)) {
        saved = readGz(file);
        // The running month is refreshed after an hour.
        if (complete || Date.now() - saved.fetchedAt < 3600_000) days = saved.days;
      }
      if (!days) {
        if (first > today) days = {};
        else {
          const to = complete ? last : today;
          try {
            const data = await api(`/v3/historical-candle/${encodeURIComponent(key)}/minutes/1/${to}/${first}`);
            days = denseIndex(data?.candles || []);
            writeGz(file, { fetchedAt: Date.now(), days });
          } catch (e) {
            // Offline / demo / not logged in: keep what was downloaded before and try again in a minute.
            if (!saved) throw e;
            days = saved.days;
            at -= 3600_000 - 60_000;
          }
        }
      }
      const map = new Map(Object.entries(days).map(([d, a]) => [d, Float64Array.from(a)]));
      indexMem.set(memKey, map);
      indexAt.set(memKey, at);
      return map;
    });
  }

  const monthsBetween = (from, to) => {
    const out = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(m + '-01', 32).slice(0, 7)) out.push(m);
    return out;
  };

  // Loads Nifty (and VIX) for [from, to]; returns the sorted trading days in that range.
  async function loadIndex(from, to, withVix = false) {
    const months = monthsBetween(from, to);
    await Promise.all(months.flatMap((m) => [indexMonth(NIFTY, m), withVix ? indexMonth(VIX, m) : null]));
    const days = [];
    for (const m of months) for (const d of indexMem.get(`${NIFTY}|${m}`).keys()) if (d >= from && d <= to) days.push(d);
    return days.sort();
  }
  const spotDay = (day) => indexMem.get(`${NIFTY}|${day.slice(0, 7)}`)?.get(day) || null;
  const vixDay = (day) => indexMem.get(`${VIX}|${day.slice(0, 7)}`)?.get(day) || null;
  // First day of the earliest month of Nifty history in the cache folder, or null when nothing is cached yet.
  function indexStart() {
    try {
      const m = fs.readdirSync(path.join(cacheDir, 'index', NIFTY.replace(/[^A-Za-z0-9]+/g, '_'))).filter((f) => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort()[0];
      return m ? m.slice(0, 7) + '-01' : null;
    } catch {
      return null;
    }
  }

  // Today's 1-minute Nifty candles, oldest first: [timestamp, open, high, low, close]. The historical endpoint only
  // has completed sessions, so the running one comes from the intraday endpoint (cached for 20 s).
  let intraday = { at: 0, candles: [] };
  async function niftyIntraday() {
    if (Date.now() - intraday.at < 20_000) return intraday.candles;
    return once('intraday', async () => {
      const d = await api(`/v3/historical-candle/intraday/${encodeURIComponent(NIFTY)}/minutes/1`);
      const candles = (d?.candles || []).map((c) => c.slice(0, 5)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      intraday = { at: Date.now(), candles };
      return candles;
    });
  }

  // ---------- expiry calendar ----------
  let calendar = null;
  async function expiryCalendar() {
    // Re-read hourly and whenever the IST day changes (new expiries get listed, today's moves to expired). A calendar
    // served from the saved file because Upstox failed (e.g. not logged in yet) is retried after a minute.
    if (calendar && calendar.day === istToday() && Date.now() - calendar.fetchedAt < (calendar.stale ? 60_000 : 3600_000)) return calendar;
    return once('calendar', async () => {
      const file = path.join(cacheDir, 'expiries.json');
      let expired = [];
      let live = [];
      let liveLot = null;
      let stale = false;
      try {
        const [e, c] = await Promise.all([
          api(`/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(NIFTY)}`),
          api(`/v2/option/contract?instrument_key=${encodeURIComponent(NIFTY)}`),
        ]);
        expired = [...new Set(e || [])].sort();
        live = [...new Set((c || []).map((x) => x.expiry))].sort();
        liveLot = c?.[0]?.lot_size || null;
        fs.writeFileSync(file, JSON.stringify({ expired, live, liveLot }));
      } catch (err) {
        if (!fs.existsSync(file)) throw err;
        ({ expired, live, liveLot } = JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!calendar?.stale) logError('bt-calendar', err);
        stale = true;
      }
      const today = istToday();
      expired = expired.filter((e) => e < today);
      live = live.filter((e) => e >= today);
      // A monthly expiry is the last expiry of its calendar month (live expiries complete the current month).
      const all = [...new Set([...expired, ...live])].sort();
      const lastOfMonth = new Map();
      for (const e of all) lastOfMonth.set(e.slice(0, 7), e);
      const monthly = new Set(lastOfMonth.values());
      calendar = { fetchedAt: Date.now(), day: today, stale, expired, live, liveLot, all, monthly, expiredSet: new Set(expired) };
      return calendar;
    });
  }

  // ---------- option contracts of an expired expiry ----------
  const contractMem = new Map();
  async function contracts(expiry) {
    if (contractMem.has(expiry)) return contractMem.get(expiry);
    return once('contracts|' + expiry, async () => {
      const file = path.join(cacheDir, 'contracts', expiry + '.json');
      let list;
      if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        const data = await api(`/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(NIFTY)}&expiry_date=${expiry}`);
        list = (data || []).map((c) => [c.strike_price, c.instrument_type, c.instrument_key, c.lot_size]);
        if (!list.length) throw new Error(`No contracts returned for expiry ${expiry}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(list));
      }
      const keys = new Map();
      let lot = 0;
      for (const [k, t, key, l] of list) {
        if (!keys.has(k)) keys.set(k, {});
        keys.get(k)[t] = key;
        lot = lot || l;
      }
      const strikes = [...keys.keys()].filter((k) => keys.get(k).CE && keys.get(k).PE).sort((a, b) => a - b);
      const info = { expiry, lot, strikes, keys };
      contractMem.set(expiry, info);
      return info;
    });
  }

  // ---------- option candles ----------
  // contract = { from, to, days: Map(day -> Int32Array(MPD*4) paise, -1 = no trade yet), dayList }
  const optMem = new Map();
  const optFile = (expiry, strike, type) => path.join(cacheDir, 'opt', expiry, `${strike}${type}.json.gz`);

  function rememberOpt(id, c) {
    optMem.delete(id);
    optMem.set(id, c);
    while (optMem.size > MEM_CONTRACTS) optMem.delete(optMem.keys().next().value);
  }

  // Each minute without a trade carries the previous close, across days too.
  function fillForward(c) {
    c.dayList = [...c.days.keys()].sort();
    let last = -1;
    for (const d of c.dayList) {
      const a = c.days.get(d);
      for (let m = 0; m < MPD; m++) {
        const i = m * 4;
        if (a[i] === -1 || a[i] === 0) {
          a[i] = a[i + 1] = a[i + 2] = a[i + 3] = last;
        } else last = a[i + 3];
      }
    }
    c.flat = new Map();
  }

  function decode(saved) {
    const days = new Map();
    for (const [d, b64] of Object.entries(saved.days)) {
      const buf = Buffer.from(b64, 'base64');
      days.set(d, new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice());
    }
    return days;
  }
  function encode(c) {
    const days = {};
    for (const [d, a] of c.raw) days[d] = Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    return { from: c.from, to: c.to, days };
  }

  async function fetchCandles(key, from, to) {
    const raw = new Map();
    for (let a = from; a <= to; a = addDays(a, CHUNK_DAYS + 1)) {
      const b = addDays(a, CHUNK_DAYS) < to ? addDays(a, CHUNK_DAYS) : to;
      const data = await api(`/v2/expired-instruments/historical-candle/${encodeURIComponent(key)}/1minute/${b}/${a}`);
      for (const c of data?.candles || []) {
        const m = minuteOf(c[0]);
        if (m < 0 || m >= MPD) continue;
        const day = c[0].slice(0, 10);
        if (!raw.has(day)) raw.set(day, new Int32Array(MPD * 4).fill(-1));
        raw.get(day).set([c[1], c[2], c[3], c[4]].map((v) => Math.round(v * 100)), m * 4);
      }
    }
    return raw;
  }

  // Candles of one contract, covering at least [needFrom, expiry].
  async function option(expiry, strike, type, needFrom) {
    const id = `${expiry}|${strike}|${type}`;
    let c = optMem.get(id);
    if (c && c.from <= needFrom) return c;
    return once('opt|' + id, async () => {
      c = optMem.get(id);
      if (!c) {
        const file = optFile(expiry, strike, type);
        if (fs.existsSync(file)) {
          try {
            const saved = readGz(file);
            const raw = decode(saved);
            c = { from: saved.from, to: saved.to, raw };
          } catch (e) {
            logError('bt-cache', e, file);
          }
        }
      }
      if (c && c.from <= needFrom) {
        if (!c.days) { c.days = new Map([...c.raw].map(([d, a]) => [d, a.slice()])); fillForward(c); }
        rememberOpt(id, c);
        return c;
      }
      const info = await contracts(expiry);
      const key = info.keys.get(strike)?.[type];
      if (!key) throw new Error(`No ${strike} ${type} contract for expiry ${expiry}`);
      const want = needFrom < addDays(expiry, -LOOKBACK_DAYS) ? needFrom : addDays(expiry, -LOOKBACK_DAYS);
      const fetchTo = c ? addDays(c.from, -1) : expiry;
      const raw = await fetchCandles(key, want, fetchTo);
      if (c) for (const [d, a] of c.raw) raw.set(d, a);
      c = { from: want, to: expiry, raw };
      writeGz(optFile(expiry, strike, type), encode(c));
      c.days = new Map([...raw].map(([d, a]) => [d, a.slice()]));
      fillForward(c);
      rememberOpt(id, c);
      return c;
    });
  }

  // Bars for one day: Int32Array(MPD*4) in paise, or null if the contract had not traded by then.
  function optionDay(c, day) {
    const a = c.days.get(day);
    if (a) return a;
    if (c.flat.has(day)) return c.flat.get(day);
    // No trade that day: hold the last close from an earlier day.
    let lo = 0;
    let hi = c.dayList.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c.dayList[mid] < day) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let out = null;
    if (found >= 0) {
      const prev = c.days.get(c.dayList[found]);
      const v = prev[MPD * 4 - 1];
      if (v > 0) out = new Int32Array(MPD * 4).fill(v);
    }
    c.flat.set(day, out);
    return out;
  }

  // Memory-only peek (no download), used to skip awaits in hot loops.
  const optionCached = (expiry, strike, type, needFrom) => {
    const c = optMem.get(`${expiry}|${strike}|${type}`);
    return c && c.from <= needFrom ? c : null;
  };

  // Bars for one day as downloaded (-1 = no trade in that minute), or null if it never traded that day.
  const optionRaw = (c, day) => c.raw?.get(day) || null;

  // ---------- cache info ----------
  function cacheStats() {
    const dirSize = (dir) => {
      let n = 0;
      let files = 0;
      if (!fs.existsSync(dir)) return { bytes: 0, files: 0 };
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const s = dirSize(p); n += s.bytes; files += s.files; } else { n += fs.statSync(p).size; files++; }
      }
      return { bytes: n, files };
    };
    const optDir = path.join(cacheDir, 'opt');
    const expiries = fs.existsSync(optDir)
      ? fs.readdirSync(optDir).map((e) => ({ expiry: e, contracts: fs.readdirSync(path.join(optDir, e)).length })).sort((a, b) => a.expiry.localeCompare(b.expiry))
      : [];
    return { options: dirSize(optDir), index: dirSize(path.join(cacheDir, 'index')), expiries, memContracts: optMem.size, api: limiter.stats() };
  }

  function clearCache(what) {
    if (what === 'options' || what === 'all') {
      fs.rmSync(path.join(cacheDir, 'opt'), { recursive: true, force: true });
      optMem.clear();
    }
    if (what === 'index' || what === 'all') {
      fs.rmSync(path.join(cacheDir, 'index'), { recursive: true, force: true });
      indexMem.clear();
    }
  }

  return {
    MPD, NIFTY, loadIndex, spotDay, vixDay, indexStart, niftyIntraday, expiryCalendar, contracts, option, optionDay, optionCached, optionRaw,
    cacheStats, clearCache, apiStats: limiter.stats, api, addDays,
  };
}

module.exports = { createData, MPD, OPEN_MIN, addDays };
