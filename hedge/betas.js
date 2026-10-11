// Beta of each holding to the Nifty 50, from ~3 years of weekly returns.
//   stocks / ETFs: Upstox weekly candles by ISIN (NSE_EQ|<ISIN>)
//   mutual funds (and anything Upstox doesn't list): AMFI scheme code by ISIN → NAV history from mfapi.in
// Gives beta (all weeks), downside beta (weeks Nifty fell — what matters for a crash hedge), R² and
// the number of weeks used. Results are cached in <cacheDir>/betas.json and refreshed on demand.
const fs = require('fs');
const path = require('path');
const { istDate } = require('../lib/time');

const DAY = 86_400_000;
const YEARS = 3;

// Used only when a holding has too little price history (< 26 weeks).
function fallbackBeta(h) {
  const c = `${h.category} ${h.symbol}`.toUpperCase();
  if (/LIQUID|OVERNIGHT|MONEY MARKET|GILT|DEBT/.test(c)) return 0;
  if (/GOLD|SILVER/.test(c)) return 0;
  if (/NASDAQ|GLOBAL|CHINA|INTERNATIONAL|US /.test(c)) return 0.25;
  if (/MULTI ASSET|HYBRID|BALANCED/.test(c)) return 0.5;
  if (/SMALL/.test(c)) return 1.15;
  if (/MID/.test(c)) return 1.05;
  return 0.95;
}

function createBetas({ upstoxGet, cacheDir, logError }) {
  const file = path.join(cacheDir, 'betas.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  let amfiMap = null;

  async function amfiCode(isin) {
    if (!amfiMap) {
      const txt = await (await fetch('https://www.amfiindia.com/spages/NAVAll.txt')).text();
      amfiMap = new Map();
      for (const line of txt.split(/\r?\n/)) {
        const p = line.split(';');
        if (p.length < 4 || !/^\d+$/.test(p[0])) continue;
        if (p[1]) amfiMap.set(p[1].trim(), p[0]);
        if (p[2]) amfiMap.set(p[2].trim(), p[0]);
      }
    }
    return amfiMap.get(isin) || null;
  }

  // Weekly closes keyed by the Nifty candle date (YYYY-MM-DD, week start).
  async function upstoxWeekly(key, from, to) {
    const data = await upstoxGet(`/historical-candle/${encodeURIComponent(key)}/week/${to}/${from}`);
    const out = new Map();
    for (const c of data?.candles || []) out.set(c[0].slice(0, 10), c[4]);
    return out;
  }

  async function mfDaily(isin) {
    const code = await amfiCode(isin);
    if (!code) return null;
    const j = await (await fetch(`https://api.mfapi.in/mf/${code}`)).json();
    // "dd-mm-yyyy" → sorted [{t, nav}]
    return (j.data || [])
      .map((d) => {
        const [dd, mm, yy] = d.date.split('-');
        return { t: Date.parse(`${yy}-${mm}-${dd}`), nav: Number(d.nav) };
      })
      .filter((x) => x.nav > 0)
      .sort((a, b) => a.t - b.t);
  }

  // Align a daily NAV series to the Nifty weeks: last NAV on or before each week's Friday.
  function navOnWeeks(daily, weeks) {
    const out = new Map();
    let i = 0;
    for (const w of weeks) {
      const friday = Date.parse(w) + 4 * DAY;
      while (i + 1 < daily.length && daily[i + 1].t <= friday) i++;
      if (daily[i] && daily[i].t <= friday && friday - daily[i].t < 10 * DAY) out.set(w, daily[i].nav);
    }
    return out;
  }

  function stats(series, nifty, weeks) {
    const xs = [];
    const ys = [];
    for (let i = 1; i < weeks.length; i++) {
      const a = series.get(weeks[i - 1]),
        b = series.get(weeks[i]);
      const na = nifty.get(weeks[i - 1]),
        nb = nifty.get(weeks[i]);
      if (a > 0 && b > 0 && na > 0 && nb > 0) {
        ys.push(b / a - 1);
        xs.push(nb / na - 1);
      }
    }
    if (xs.length < 26) return null;
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    const mx = mean(xs),
      my = mean(ys);
    let sxy = 0,
      sxx = 0,
      syy = 0,
      dxy = 0,
      dxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
      if (xs[i] < 0) {
        dxy += xs[i] * ys[i];
        dxx += xs[i] * xs[i];
      }
    }
    const beta = sxy / sxx;
    return {
      beta: Math.round(beta * 1000) / 1000,
      downBeta: dxx ? Math.round((dxy / dxx) * 1000) / 1000 : Math.round(beta * 1000) / 1000,
      r2: syy ? Math.round(((sxy * sxy) / (sxx * syy)) * 1000) / 1000 : 0,
      weeks: xs.length,
    };
  }

  async function refresh(holdings) {
    const to = istDate();
    const from = new Date(Date.now() - YEARS * 365 * DAY).toISOString().slice(0, 10);
    const nifty = await upstoxWeekly('NSE_INDEX|Nifty 50', from, to);
    const weeks = [...nifty.keys()].sort();
    const results = {};
    const queue = [...holdings];
    const worker = async () => {
      while (queue.length) {
        const h = queue.shift();
        let series = null;
        let source = null;
        // Exchange prices first (stocks, ETFs), then fund NAVs; either may not know the ISIN.
        if (h.kind !== 'mf') {
          try {
            series = await upstoxWeekly(`NSE_EQ|${h.isin}`, from, to);
            if (series.size >= 27) source = 'Upstox';
            else series = null;
          } catch {
            series = null;
          }
        }
        if (!series && h.isin.startsWith('INF')) {
          try {
            const daily = await mfDaily(h.isin);
            if (daily?.length) {
              series = navOnWeeks(daily, weeks);
              source = 'AMFI NAV';
            }
          } catch (e) {
            logError('hedge-beta', `${h.symbol}: ${e.message}`);
          }
        }
        const s = series ? stats(series, nifty, weeks) : null;
        results[h.isin] = s
          ? { ...s, source, at: Date.now() }
          : { beta: fallbackBeta(h), downBeta: fallbackBeta(h), r2: null, weeks: 0, source: 'estimate', at: Date.now() };
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    cache = { ...cache, ...results };
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache, null, 1));
    } catch (e) {
      logError('hedge-beta', e);
    }
    return cache;
  }

  return {
    get: (isin) => cache[isin] || null,
    all: () => cache,
    fallbackBeta,
    refresh,
  };
}

module.exports = { createBetas };
