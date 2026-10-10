// The Upstox REST API: one client for the whole app, so every call counts against the same rate limits.
//   live(path, params)  the live screens (option chain, contracts): sent at once, never queued
//   bulk(path)          historical downloads (backtester, hedge history and betas): waits for the limiter, retries
const BASE = 'https://api.upstox.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upstox limits standard APIs to 50/s, 500/min and 2000/30 min per user; stay a little under each.
function createLimiter(windows = [[1000, 25], [60_000, 450], [1_800_000, 1900]]) {
  const stamps = [];
  let waitingSince = 0;
  let total = 0;
  let chain = Promise.resolve();
  const note = () => {
    stamps.push(Date.now());
    total++;
  };
  async function take() {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > 1_800_000) stamps.shift();
      let wait = 0;
      for (const [ms, max] of windows) {
        const inWin = stamps.filter((t) => now - t < ms);
        if (inWin.length >= max) wait = Math.max(wait, ms - (now - inWin[0]) + 5);
      }
      if (!wait) break;
      if (!waitingSince) waitingSince = now;
      await sleep(Math.min(wait, 2000));
    }
    waitingSince = 0;
    note();
  }
  return {
    // Serialised so concurrent callers don't all pass the same check at once.
    take: () => (chain = chain.then(take)),
    // A request that was sent without waiting (live data): it still uses up the allowance.
    note,
    stats: () => ({ requests: total, lastMinute: stamps.filter((t) => Date.now() - t < 60_000).length, waitingSec: waitingSince ? Math.round((Date.now() - waitingSince) / 1000) : 0 }),
  };
}

// onUnauthorized: called when Upstox rejects the token (it expires at ~3:30 AM IST the next day).
function createUpstox({ getToken, onUnauthorized = () => {} }) {
  const limiter = createLimiter();
  const headers = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' });

  // pathname is relative to /v2, e.g. live('/option/chain', { instrument_key, expiry_date }).
  async function live(pathname, params = {}) {
    const token = getToken();
    if (!token) throw new Error('Not logged in');
    const url = new URL(BASE + '/v2' + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    limiter.note();
    const res = await fetch(url, { headers: headers(token) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      onUnauthorized();
      throw new Error('Upstox session expired — please log in again');
    }
    if (!res.ok || body.status !== 'success') {
      throw new Error(body?.errors?.[0]?.message || `Upstox HTTP ${res.status}`);
    }
    return body.data;
  }

  // pathname carries the API version, e.g. bulk('/v3/historical-candle/…').
  async function bulk(pathname) {
    const token = getToken();
    if (!token) throw new Error('Not logged in to Upstox');
    for (let attempt = 0; ; attempt++) {
      await limiter.take();
      const res = await fetch(BASE + pathname, { headers: headers(token) });
      const body = await res.json().catch(() => ({}));
      // Rate limited (e.g. another app on the same account): back off up to ~3 minutes in total.
      const limited = res.status === 429 || /too many/i.test(body?.errors?.[0]?.message || '');
      if ((limited && attempt < 9) || (res.status >= 500 && attempt < 4)) {
        await sleep(limited ? 4000 * (attempt + 1) : 800 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) {
        onUnauthorized();
        throw new Error('Upstox session expired — log in again');
      }
      if (!res.ok || body.status !== 'success') throw new Error(body?.errors?.[0]?.message || `Upstox HTTP ${res.status}`);
      return body.data;
    }
  }

  return { live, bulk, limiter };
}

// One side (call or put) of an option-chain row.
function optionSide(o) {
  const m = o?.market_data || {};
  const g = o?.option_greeks || {};
  return {
    key: o?.instrument_key || null,
    ltp: m.ltp ?? null,
    close: m.close_price ?? null,
    vol: m.volume ?? 0,
    oi: m.oi ?? 0,
    prevOi: m.prev_oi ?? 0,
    iv: g.iv ?? null,
    delta: g.delta ?? null,
    gamma: g.gamma ?? null,
    theta: g.theta ?? null,
    vega: g.vega ?? null,
    bid: m.bid_price || null,
    ask: m.ask_price || null,
    bidQ: m.bid_qty ?? null,
    askQ: m.ask_qty ?? null,
  };
}

// The /option/chain reply as { spot, rows: [{ strike, ce, pe }] }, strikes ascending.
function parseChain(data) {
  return {
    spot: data?.[0]?.underlying_spot_price ?? null,
    rows: (data || [])
      .map((r) => ({ strike: r.strike_price, ce: optionSide(r.call_options), pe: optionSide(r.put_options) }))
      .sort((a, b) => a.strike - b.strike),
  };
}

module.exports = { createUpstox, createLimiter, optionSide, parseChain };
