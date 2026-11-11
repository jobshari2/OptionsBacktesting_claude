// Upstox REST API, called straight from the phone. Upstox answers browser (cross-origin) requests: data endpoints send
// "access-control-allow-origin: *", the token exchange echoes the caller's origin. No other server is involved.
export const BASE = 'https://api.upstox.com';
export const NIFTY = 'NSE_INDEX|Nifty 50';
export const VIX = 'NSE_INDEX|India VIX';
export const BEES = 'NSE_EQ|INF204KB14I2'; // NIFTYBEES (Nippon India ETF Nifty 50 BeES)

export class UpstoxError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function createUpstox({ getToken, fetchImpl = (...a) => globalThis.fetch(...a), onUnauthorized = () => {} }) {
  async function get(path, params = {}) {
    const token = getToken();
    if (!token) throw new UpstoxError('Not logged in to Upstox', 401);
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch {
      throw new UpstoxError('No connection to Upstox', 0);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      onUnauthorized();
      throw new UpstoxError('Upstox session expired — log in again', 401);
    }
    if (!res.ok || body.status !== 'success') throw new UpstoxError(body?.errors?.[0]?.message || `Upstox HTTP ${res.status}`, res.status);
    return body.data;
  }

  // { [instrumentKey]: { ltp, change, prevClose, open, high, low } }
  async function quotes(keys) {
    const data = await get('/v2/market-quote/quotes', { instrument_key: keys.join(',') });
    return parseQuotes(data);
  }

  // { expiries: ['YYYY-MM-DD', …], lotSize }
  async function contracts(key = NIFTY) {
    return parseContracts(await get('/v2/option/contract', { instrument_key: key }));
  }

  async function chain(expiry, key = NIFTY) {
    return { expiry, ...parseChain(await get('/v2/option/chain', { instrument_key: key, expiry_date: expiry })) };
  }

  // Today's candles, oldest first: [{ t (ms), o, h, l, c }]
  async function intraday(key = NIFTY, minutes = 5) {
    const data = await get(`/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/${minutes}`);
    return parseCandles(data?.candles);
  }

  return { get, quotes, contracts, chain, intraday };
}

export function parseQuotes(data) {
  const out = {};
  for (const q of Object.values(data || {})) {
    const key = q.instrument_token;
    if (!key) continue;
    const ltp = q.last_price ?? null;
    const change = q.net_change ?? null;
    out[key] = {
      ltp,
      change,
      prevClose: ltp != null && change != null ? ltp - change : null,
      open: q.ohlc?.open ?? null,
      high: q.ohlc?.high ?? null,
      low: q.ohlc?.low ?? null,
    };
  }
  return out;
}

export function parseContracts(data) {
  const exp = new Set();
  let lotSize = null;
  for (const c of data || []) {
    if (c.expiry) exp.add(c.expiry);
    if (!lotSize && c.lot_size) lotSize = c.lot_size;
  }
  return { expiries: [...exp].sort(), lotSize };
}

function side(o) {
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
    bid: m.bid_price || null,
    ask: m.ask_price || null,
  };
}

export function parseChain(data) {
  return {
    spot: data?.[0]?.underlying_spot_price ?? null,
    rows: (data || []).map((r) => ({ strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) })).sort((a, b) => a.strike - b.strike),
  };
}

export function parseCandles(candles) {
  return (candles || [])
    .map((c) => ({ t: Date.parse(c[0]), o: c[1], h: c[2], l: c[3], c: c[4] }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
}

// ---- Sign-in (OAuth authorization-code flow, all on the phone) ----
export function loginUrl({ apiKey, redirectUri, state }) {
  const u = new URL(BASE + '/v2/login/authorization/dialog');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', apiKey);
  u.searchParams.set('redirect_uri', redirectUri);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

// Exchanges the ?code= Upstox sent back for an access token. A form POST is a "simple" cross-origin request, and
// Upstox echoes the origin, so the phone can read the reply.
export async function exchangeCode({ code, apiKey, apiSecret, redirectUri, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const body = new URLSearchParams({ code, client_id: apiKey, client_secret: apiSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  let res;
  try {
    res = await fetchImpl(BASE + '/v2/login/authorization/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new UpstoxError('No connection to Upstox', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new UpstoxError(data?.errors?.[0]?.message || `Login failed (HTTP ${res.status})`, res.status);
  return { token: data.access_token, user: data.user_name || data.user_id || '' };
}
