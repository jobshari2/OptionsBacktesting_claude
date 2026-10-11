// Upstox Market Data Feed V3 (WebSocket, protobuf). Keeps the latest tick per instrument key.
// Reconnects automatically; subscriptions are re-sent after every reconnect.
const path = require('path');
const protobuf = require('protobufjs');

const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const FeedResponse = protobuf.loadSync(path.join(__dirname, 'MarketDataFeed.proto')).lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');

function createFeed({ getToken, logError, onTick }) {
  const ticks = new Map(); // instrument key -> { ltp, cp, vol, oi, iv, ltt, at }
  let wanted = new Set(); // keys we want subscribed
  let subscribed = new Set(); // keys sent to the live socket
  let ws = null;
  let connected = false;
  let enabled = false;
  let retryMs = 2000;
  let retryTimer = null;
  let lastTickAt = 0;
  let version = 0; // bumps on every tick, so callers can tell if anything changed

  async function connect() {
    if (!enabled || ws) return;
    try {
      const res = await fetch(AUTHORIZE_URL, { headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      const url = body?.data?.authorized_redirect_uri;
      if (!url) throw new Error(body?.errors?.[0]?.message || `Feed authorize failed (HTTP ${res.status})`);

      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        connected = true;
        retryMs = 2000;
        subscribed = new Set();
        syncSubscriptions();
        console.log('[feed] WebSocket connected');
      };
      ws.onmessage = (ev) => handleMessage(ev.data);
      ws.onerror = (ev) => logError('feed', ev?.message || 'WebSocket error');
      ws.onclose = (ev) => {
        const wasConnected = connected;
        ws = null;
        connected = false;
        subscribed = new Set();
        if (wasConnected) logError('feed', `WebSocket closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''}) — reconnecting`);
        scheduleReconnect();
      };
    } catch (e) {
      ws = null;
      logError('feed', e);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!enabled || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }

  function handleMessage(data) {
    let msg;
    try {
      msg = FeedResponse.toObject(FeedResponse.decode(new Uint8Array(data)), { longs: Number, enums: String, defaults: false });
    } catch (e) {
      return logError('feed-decode', e);
    }
    if (!msg.feeds) return;
    const now = Date.now();
    for (const [key, f] of Object.entries(msg.feeds)) {
      const m = f.fullFeed?.marketFF;
      const idx = f.fullFeed?.indexFF;
      const ltpc = m?.ltpc || idx?.ltpc || f.ltpc;
      if (!ltpc) continue;
      const t = ticks.get(key) || { buy: 0, sell: 0 };
      if (m?.vtt != null) classify(t, m.vtt, ltpc.ltp);
      t.ltp = ltpc.ltp;
      if (ltpc.cp != null) t.cp = ltpc.cp;
      if (ltpc.ltt) t.ltt = ltpc.ltt;
      if (m) {
        const q = m.marketLevel?.bidAskQuote?.[0];
        if (q?.bidP) t.bid = q.bidP;
        if (q?.askP) t.ask = q.askP;
        if (q) {
          t.bidQ = q.bidQ ?? 0;
          t.askQ = q.askQ ?? 0;
        }
        if (m.tbq != null) t.tbq = m.tbq; // total quantity waiting to buy (all depth levels)
        if (m.tsq != null) t.tsq = m.tsq; // total quantity waiting to sell
        if (m.vtt != null) t.vol = m.vtt;
        if (m.oi != null) t.oi = m.oi;
        if (m.iv != null) t.iv = m.iv * 100; // feed sends IV as a fraction; REST uses percent
      }
      t.at = now;
      ticks.set(key, t);
    }
    lastTickAt = now;
    version++;
    onTick?.();
  }

  // Split new volume into buyer- vs seller-initiated (cumulative since subscribing), using the quote
  // that was live before this trade: at/above the ask = buy, at/below the bid = sell; in between,
  // the tick rule (price up = buy, down = sell, unchanged = same side as the previous trade).
  function classify(t, vtt, ltp) {
    const dv = t.vol != null ? vtt - t.vol : 0;
    if (dv <= 0) return;
    let side;
    if (t.ask && ltp >= t.ask) side = 'buy';
    else if (t.bid && ltp <= t.bid) side = 'sell';
    else if (t.ltp != null && ltp > t.ltp) side = 'buy';
    else if (t.ltp != null && ltp < t.ltp) side = 'sell';
    else side = t.lastSide;
    if (!side) return;
    t[side] += dv;
    t.lastSide = side;
  }

  function send(method, keys) {
    if (!keys.length || !ws || !connected) return;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      ws.send(Buffer.from(JSON.stringify({ guid: `${method}-${Date.now()}-${i}`, method, data: { mode: 'full', instrumentKeys: chunk } })));
    }
  }

  function syncSubscriptions() {
    if (!connected) return;
    const add = [...wanted].filter((k) => !subscribed.has(k));
    const remove = [...subscribed].filter((k) => !wanted.has(k));
    send('unsub', remove);
    send('sub', add);
    for (const k of remove) {
      subscribed.delete(k);
      ticks.delete(k);
    }
    for (const k of add) subscribed.add(k);
  }

  return {
    // Turn the feed on (market hours / someone watching) or off.
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
    setSubscriptions(keys) {
      wanted = new Set(keys);
      syncSubscriptions();
    },
    tick: (key) => ticks.get(key),
    get version() {
      return version;
    },
    status: () => ({ connected, enabled, instruments: subscribed.size, lastTickAt }),
  };
}

module.exports = { createFeed };
