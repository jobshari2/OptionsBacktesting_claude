// Zerodha Kite: login, the Nifty option instrument list and the live tick feed (binary WebSocket).
// Two ways to authenticate:
//   connect   the official Kite Connect API: an app's api_key + an access_token from the login redirect (or pasted)
//   enctoken  the session token of a Kite web login (kite.zerodha.com), passed in by the bookmarklet or pasted;
//             an unofficial interface Zerodha does not document and can change without notice
const fs = require('fs');
const crypto = require('crypto');
const { istDate } = require('./time');

const KITE_API = 'https://api.kite.trade';
const KITE_WEB = 'https://kite.zerodha.com/oms';
const NIFTY_TOKEN = 256265; // NSE:NIFTY 50

// Kite tokens are cut off at about 6 AM IST, so a token is good for the "Kite day" it was made on.
const kiteDay = (ts = Date.now()) => istDate(ts - 6 * 3600_000);

const loginUrl = (apiKey) => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

function authHeaders(auth) {
  if (!auth) return {};
  if (auth.mode === 'enctoken') return { Authorization: `enctoken ${auth.enctoken}`, 'X-Kite-Version': '3' };
  return { Authorization: `token ${auth.apiKey}:${auth.accessToken}`, 'X-Kite-Version': '3' };
}
const restBase = (auth) => (auth?.mode === 'enctoken' ? KITE_WEB : KITE_API);

// Kite answers errors as { status: 'error', error_type, message }. A TokenException means the token is no good.
class KiteError extends Error {
  constructor(message, type, status) {
    super(message);
    this.type = type;
    this.status = status;
  }
  get tokenProblem() {
    return this.type === 'TokenException' || this.status === 403;
  }
}

async function kiteJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === 'error') throw new KiteError(body.message || `Kite HTTP ${res.status}`, body.error_type, res.status);
  return body.data;
}

// The logged-in user ({ user_id, user_name, ... }): also how a token is checked.
async function profile(auth) {
  return kiteJson(await fetch(`${restBase(auth)}/user/profile`, { headers: authHeaders(auth) }));
}

// Kite Connect login: the request_token from the redirect is swapped for an access_token.
async function exchangeRequestToken({ apiKey, apiSecret, requestToken }) {
  const checksum = crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');
  const res = await fetch(`${KITE_API}/session/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });
  return kiteJson(res); // { access_token, user_id, user_name, ... }
}

// Nifty options from Kite's instrument dump (CSV): "expiry|strike|CE" -> { token, symbol } (the tradingsymbol
// orders are placed with).
function parseInstruments(csv) {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const col = (name) => head.indexOf(name);
  const [cTok, cSym, cName, cExp, cStrike, cType, cSeg] = ['instrument_token', 'tradingsymbol', 'name', 'expiry', 'strike', 'instrument_type', 'segment'].map(
    col,
  );
  if ([cTok, cSym, cName, cExp, cStrike, cType].some((c) => c < 0)) throw new Error('Kite instrument list has an unexpected format');
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < head.length) continue;
    const name = f[cName].replace(/"/g, '');
    const type = f[cType];
    if (name !== 'NIFTY' || (type !== 'CE' && type !== 'PE') || (cSeg >= 0 && f[cSeg] !== 'NFO-OPT')) continue;
    map.set(`${f[cExp]}|${Number(f[cStrike])}|${type}`, { token: Number(f[cTok]), symbol: f[cSym].replace(/"/g, '') });
  }
  return map;
}

// ---------- orders ----------
// The only place in the app that sends orders (test/no-orders.test.js checks this). Used by the Feeds screen's live
// trading (feedlive.js), which is off after every server start until it is switched on, on the screen.
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));

// A regular NFO order: { tradingsymbol, transaction_type: BUY | SELL, quantity, order_type: MARKET | LIMIT,
// product: MIS | NRML, price (LIMIT only), market_protection (optional), tag }. Returns the order id.
async function placeOrder(auth, p) {
  const res = await fetch(`${restBase(auth)}/orders/regular`, {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ exchange: 'NFO', validity: 'DAY', ...p }),
  });
  return (await kiteJson(res)).order_id;
}

// The latest state of an order: { status: OPEN | COMPLETE | REJECTED | CANCELLED | ..., average_price,
// filled_quantity, status_message, ... }.
async function orderStatus(auth, orderId) {
  const hist = await kiteJson(await fetch(`${restBase(auth)}/orders/${encodeURIComponent(orderId)}`, { headers: authHeaders(auth) }));
  return Array.isArray(hist) ? hist[hist.length - 1] : hist;
}

async function cancelOrder(auth, orderId) {
  return kiteJson(await fetch(`${restBase(auth)}/orders/regular/${encodeURIComponent(orderId)}`, { method: 'DELETE', headers: authHeaders(auth) }));
}

// Funds of the equity segment (where F&O trades): { net (available to trade), available: { cash, live_balance,
// collateral, ... }, utilised: { debits, ... } }.
async function funds(auth) {
  return (await kiteJson(await fetch(`${restBase(auth)}/user/margins`, { headers: authHeaders(auth) }))).equity;
}

// The margin Kite would need for some NFO orders; nothing is placed. list: [{ tradingsymbol, transaction_type,
// quantity, product }] -> [{ total, ... }] in the same order.
async function orderMargins(auth, list) {
  const body = list.map((o) => ({ exchange: 'NFO', variety: 'regular', order_type: 'MARKET', price: 0, trigger_price: 0, ...o }));
  const res = await fetch(`${restBase(auth)}/margins/orders`, {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return kiteJson(res);
}

// Today's orders, all of them (also those placed in Kite itself): [{ order_id, tradingsymbol, transaction_type,
// product, status, average_price, filled_quantity, order_timestamp, tag, ... }].
async function orders(auth) {
  return kiteJson(await fetch(`${restBase(auth)}/orders`, { headers: authHeaders(auth) }));
}

// Positions of the day (Kite's "net" list): [{ tradingsymbol, quantity, average_price, last_price, pnl, ... }].
async function positions(auth) {
  return (await kiteJson(await fetch(`${restBase(auth)}/portfolio/positions`, { headers: authHeaders(auth) }))).net || [];
}

// The list is public with Kite Connect; for an enctoken session the open endpoint is tried first, then Kite web's.
async function niftyInstruments(auth) {
  const tries =
    auth?.mode === 'connect'
      ? [[`${KITE_API}/instruments/NFO`, authHeaders(auth)]]
      : [
          [`${KITE_API}/instruments/NFO`, {}],
          [`${KITE_WEB}/instruments/NFO`, authHeaders(auth)],
        ];
  let last;
  for (const [url, headers] of tries) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const map = parseInstruments(await res.text());
      if (map.size) return map;
      throw new Error(`No Nifty options in ${url}`);
    } catch (e) {
      last = e;
    }
  }
  throw new Error('Could not load the Kite instrument list: ' + last.message);
}

// ---------- binary tick packets ----------
// A message is [count u16] then count × [length u16][packet]. Prices are paise (int32) for NSE / NFO.
// Packet lengths: 8 = LTP mode, 28 / 32 = index quote / full, 44 = quote, 184 = full (with 5-level depth).
function parseBinary(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length < 4) return []; // 1-byte heartbeat
  const n = b.readUInt16BE(0);
  const out = [];
  let off = 2;
  for (let i = 0; i < n && off + 2 <= b.length; i++) {
    const len = b.readUInt16BE(off);
    off += 2;
    if (off + len > b.length) break;
    const p = parsePacket(b.subarray(off, off + len));
    if (p) out.push(p);
    off += len;
  }
  return out;
}

function parsePacket(p) {
  if (p.length < 8) return null;
  const token = p.readUInt32BE(0);
  const seg = token & 0xff;
  const div = seg === 3 ? 1e7 : seg === 6 ? 1e4 : 100; // CDS, BCD, everything else
  const px = (o) => p.readInt32BE(o) / div;
  const t = { token, ltp: px(4) };
  if (p.length === 28 || p.length === 32) {
    Object.assign(t, { high: px(8), low: px(12), open: px(16), close: px(20) });
    if (p.length === 32) t.ts = p.readUInt32BE(28) * 1000;
    return t;
  }
  if (p.length < 44) return t;
  Object.assign(t, {
    lastQty: p.readUInt32BE(8),
    avg: px(12),
    vol: p.readUInt32BE(16),
    tbq: p.readUInt32BE(20),
    tsq: p.readUInt32BE(24),
    open: px(28),
    high: px(32),
    low: px(36),
    close: px(40),
  });
  if (p.length >= 184) {
    t.ltt = p.readUInt32BE(44) * 1000;
    t.oi = p.readUInt32BE(48);
    t.ts = p.readUInt32BE(60) * 1000;
    // depth: 10 × [qty u32, price i32, orders u16, pad u16]; 5 bids then 5 asks
    const lvl = (i) => ({ q: p.readUInt32BE(64 + i * 12), p: px(68 + i * 12) });
    const bid = lvl(0);
    const ask = lvl(5);
    t.bid = bid.p > 0 ? bid.p : null;
    t.bidQ = bid.q;
    t.ask = ask.p > 0 ? ask.p : null;
    t.askQ = ask.q;
  }
  return t;
}

function tickerUrl(auth) {
  if (auth.mode === 'enctoken') {
    const q = new URLSearchParams({
      api_key: 'kitefront',
      user_id: auth.userId,
      enctoken: auth.enctoken,
      uid: String(Date.now()),
      'user-agent': 'kite3-web',
      version: '3.0.0',
    });
    return `wss://ws.zerodha.com/?${q}`;
  }
  return `wss://ws.kite.trade?${new URLSearchParams({ api_key: auth.apiKey, access_token: auth.accessToken })}`;
}

// The Kite tick feed: keeps the latest tick per instrument token, reconnects by itself and re-subscribes.
// onTicks(tokens, at) is called with the tokens of every message as it arrives. onAuthFail() runs when the
// socket keeps failing before it ever opens (Kite refuses the handshake for a bad token).
function createKiteTicker({ getAuth, logError, onTicks, onAuthFail }) {
  const ticks = new Map();
  let wanted = new Set();
  let subscribed = new Set();
  let ws = null;
  let connected = false;
  let enabled = false;
  let retryMs = 2000;
  let retryTimer = null;
  let failsBeforeOpen = 0;
  let lastTickAt = 0;
  let lastError = null;
  let messages = 0;

  function connect() {
    const auth = getAuth();
    if (!enabled || ws || !auth) return;
    let opened = false;
    try {
      ws = new WebSocket(tickerUrl(auth), { headers: auth.mode === 'enctoken' ? { Origin: 'https://kite.zerodha.com' } : {} });
    } catch (e) {
      ws = null;
      lastError = e.message;
      return scheduleReconnect();
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      opened = true;
      connected = true;
      retryMs = 2000;
      failsBeforeOpen = 0;
      lastError = null;
      subscribed = new Set();
      syncSubscriptions();
      console.log(`[kite] WebSocket connected (${auth.mode})`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return handleText(ev.data);
      const at = Date.now();
      let list;
      try {
        list = parseBinary(ev.data);
      } catch (e) {
        return logError('kite-decode', e);
      }
      if (!list.length) return;
      messages++;
      const tokens = [];
      for (const t of list) {
        const prev = ticks.get(t.token);
        // an LTP-mode packet carries no quote: keep the last one
        ticks.set(t.token, prev && t.bid === undefined ? { ...prev, ...t, bid: prev.bid, ask: prev.ask, at } : { ...t, at });
        tokens.push(t.token);
      }
      lastTickAt = at;
      onTicks?.(tokens, at);
    };
    ws.onerror = (ev) => {
      lastError = ev?.message || 'WebSocket error';
    };
    ws.onclose = (ev) => {
      const was = connected;
      ws = null;
      connected = false;
      subscribed = new Set();
      ticks.clear();
      if (was) logError('kite', `WebSocket closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''}) — reconnecting`);
      if (!opened && ++failsBeforeOpen >= 2) onAuthFail?.();
      scheduleReconnect();
    };
  }

  function handleText(text) {
    try {
      const m = JSON.parse(text);
      if (m.type === 'error') {
        lastError = String(m.data);
        logError('kite', lastError);
      }
    } catch {}
  }

  function scheduleReconnect() {
    if (!enabled || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }

  function send(msg) {
    if (ws && connected) ws.send(JSON.stringify(msg));
  }

  function syncSubscriptions() {
    if (!connected) return;
    const add = [...wanted].filter((k) => !subscribed.has(k));
    const remove = [...subscribed].filter((k) => !wanted.has(k));
    if (remove.length) send({ a: 'unsubscribe', v: remove });
    if (add.length) {
      send({ a: 'subscribe', v: add });
      send({ a: 'mode', v: ['full', add] });
    }
    for (const k of remove) {
      subscribed.delete(k);
      ticks.delete(k);
    }
    for (const k of add) subscribed.add(k);
  }

  return {
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) connect();
      else {
        clearTimeout(retryTimer);
        retryTimer = null;
        if (ws) ws.close();
      }
    },
    // Drop the socket (after a new login) so the next connect uses the new token.
    restart() {
      if (ws) ws.close();
      else if (enabled) connect();
    },
    setSubscriptions(tokens) {
      wanted = new Set(tokens);
      syncSubscriptions();
    },
    tick: (token) => ticks.get(token),
    status: () => ({ connected, enabled, instruments: subscribed.size, lastTickAt, messages, error: lastError }),
  };
}

// The Kite login in use: saved in a file for the rest of the Kite day, or taken from .env.
function createKiteSession({ file, env = {}, logError = () => {} }) {
  const apiKey = env.KITE_API_KEY || '';
  const apiSecret = env.KITE_API_SECRET || '';
  let auth = null;
  let source = null;
  let error = null;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.day === kiteDay()) {
      auth = saved.auth;
      source = 'saved';
    }
  } catch {}
  if (!auth && env.KITE_ACCESS_TOKEN && apiKey) {
    auth = { mode: 'connect', apiKey, accessToken: env.KITE_ACCESS_TOKEN };
    source = 'env';
  } else if (!auth && env.KITE_ENCTOKEN && env.KITE_USER_ID) {
    auth = { mode: 'enctoken', enctoken: env.KITE_ENCTOKEN, userId: env.KITE_USER_ID };
    source = 'env';
  }

  return {
    apiKey,
    apiSecret,
    configured: Boolean(apiKey && apiSecret),
    get: () => auth,
    set(a, user) {
      auth = { ...a, userId: a.userId || user?.user_id, userName: user?.user_name };
      source = 'saved';
      error = null;
      try {
        fs.writeFileSync(file, JSON.stringify({ day: kiteDay(), auth }));
      } catch (e) {
        logError('kite-session', e);
      }
    },
    clear(reason = null) {
      auth = null;
      source = null;
      error = reason;
      try {
        fs.unlinkSync(file);
      } catch {}
    },
    status: () => ({
      loggedIn: Boolean(auth),
      mode: auth?.mode || null,
      userId: auth?.userId || null,
      userName: auth?.userName || null,
      source,
      error,
      configured: Boolean(apiKey && apiSecret),
      apiKey: Boolean(apiKey),
    }),
  };
}

module.exports = {
  NIFTY_TOKEN,
  KiteError,
  kiteDay,
  loginUrl,
  profile,
  exchangeRequestToken,
  parseInstruments,
  niftyInstruments,
  placeOrder,
  orderStatus,
  cancelOrder,
  funds,
  orderMargins,
  orders,
  positions,
  parseBinary,
  createKiteTicker,
  createKiteSession,
};
