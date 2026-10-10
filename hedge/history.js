// Daily closes of the Nifty 50 and India VIX from Upstox, for the hedge backtest.
// Cached in <cacheDir>/history.json; only the missing tail is fetched again (at most every 6 hours).
const fs = require('fs');
const path = require('path');

const DAY = 86_400_000;
const KEYS = { nifty: 'NSE_INDEX|Nifty 50', vix: 'NSE_INDEX|India VIX' };
const START = '2008-01-01'; // India VIX history starts in 2008
const CHUNK_DAYS = 300; // keep each request inside the API's range limit for daily candles
const REFRESH_MS = 6 * 3600_000;

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const istToday = () => ymd(Date.now() + 5.5 * 3600_000);

function createHistory({ upstoxGet, cacheDir, logError }) {
  const file = path.join(cacheDir, 'history.json');
  let cache = { at: 0, nifty: {}, vix: {} };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let job = null;

  // { 'YYYY-MM-DD': close } for one instrument between two dates, in chunks.
  async function fetchRange(key, from, to) {
    const ranges = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += (CHUNK_DAYS + 1) * DAY) {
      ranges.push([ymd(t), ymd(Math.min(Date.parse(to), t + CHUNK_DAYS * DAY))]);
    }
    const out = {};
    const worker = async () => {
      while (ranges.length) {
        const [a, b] = ranges.shift();
        try {
          const data = await upstoxGet(`/historical-candle/${encodeURIComponent(key)}/day/${b}/${a}`);
          for (const c of data?.candles || []) if (c[4] > 0) out[c[0].slice(0, 10)] = c[4];
        } catch (e) {
          logError('hedge-history', `${key} ${a}..${b}: ${e.message}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  async function refresh() {
    const to = istToday();
    for (const [name, key] of Object.entries(KEYS)) {
      const have = Object.keys(cache[name]).sort();
      // re-fetch the last few days too (the latest candle may have been a live one)
      const from = have.length ? ymd(Date.parse(have[have.length - 1]) - 5 * DAY) : START;
      cache[name] = { ...cache[name], ...(await fetchRange(key, from, to)) };
    }
    cache.at = Date.now();
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache));
    } catch (e) {
      logError('hedge-history', e);
    }
  }

  // Sorted [{ date, spot, vix }] (vix carried forward over gaps; null before it starts).
  async function load() {
    if (!Object.keys(cache.nifty).length || Date.now() - cache.at > REFRESH_MS) {
      if (!job) job = refresh().finally(() => { job = null; });
      await job;
    }
    const dates = Object.keys(cache.nifty).sort();
    if (!dates.length) throw new Error('No Nifty history returned by Upstox');
    let vix = null;
    return dates.map((date) => {
      if (cache.vix[date] > 0) vix = cache.vix[date];
      return { date, spot: cache.nifty[date], vix };
    });
  }

  return { load, loading: () => Boolean(job) };
}

module.exports = { createHistory };
