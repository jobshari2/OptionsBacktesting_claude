// Nifty option chain live server (Upstox API v2 + V3 WebSocket feed). Needs Node 22+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSignals, isMarketOpen } = require('./signals');
const { logError, LOG_FILE } = require('./errorlog');
const { createFeed } = require('./feed');
const { createTape } = require('./tape');
const { createBacktester } = require('./bt');
const { createAnomalyLive } = require('./anomaly-live');

loadEnv(path.join(__dirname, '.env'));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

// DEMO=1 serves synthetic data so the UI can be tried without credentials or outside market hours.
const DEMO = env.DEMO === '1';

const CFG = {
  port: num(env.PORT, 3000),
  apiKey: env.UPSTOX_API_KEY || '',
  apiSecret: env.UPSTOX_API_SECRET || '',
  redirectUri: env.UPSTOX_REDIRECT_URI || `http://localhost:${num(env.PORT, 3000)}/callback`,
  pollMs: Math.max(1000, num(env.POLL_MS, 3000)),
  signals: {
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
    dir: env.EVENTS_DIR ? path.resolve(env.EVENTS_DIR) : path.join(__dirname, DEMO ? 'events-demo' : 'events'), // where recordings go
  },
};

const API = 'https://api.upstox.com/v2';
const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const TOKEN_FILE = path.join(__dirname, '.token.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WINDOWS_MIN = [1, 3, 5, 15]; // volume-change windows offered in the UI
const HISTORY_MS = (Math.max(16, CFG.signals.beforeMin) + 1) * 60_000;
// Bumped whenever the /api/chain response shape changes, so an old server + new page is detected.
const API_VERSION = 16;
const FEED_STRIKES = num(env.FEED_STRIKES, 15); // strikes either side of ATM streamed over the WebSocket
const TICK_SNAPSHOT_MS = 500; // how often ticks are folded into a snapshot (history, signals, UI)
const REST_WITH_FEED_MS = 15_000; // REST refresh interval while the WebSocket feed is live
const IDLE_STOP_MS = 30_000; // outside market hours, stop calling Upstox when no browser is watching

// ---------- state ----------
let token = DEMO ? 'demo' : env.UPSTOX_ACCESS_TOKEN || readSavedToken();
let expiries = { list: [], fetchedAt: 0 };
let activeExpiry = null; // expiry the browser is viewing
const restChains = new Map(); // expiry -> { fetchedAt, spot, rows } from the REST option chain
const snapshots = new Map(); // expiry -> latest snapshot (REST + ticks)
// expiry -> [{ t, spot, d: { strike: [ceLtp, ceVol, ceOi, peLtp, peVol, peOi, (ceBuy, ceSell, peBuy, peSell)] } }]
const histories = new Map();
const signals = createSignals(CFG.signals, logError);
const feed = createFeed({ getToken: () => token, logError });
const tape = createTape({ dir: CFG.signals.dir, strikesAround: num(env.TAPE_STRIKES, 15), logError });
let lastError = null;
let lastClientAt = 0;
let polling = false;

// ---------- Upstox helpers ----------
async function upstox(pathname, params = {}) {
  if (DEMO) return demoData(pathname);
  if (!token) throw new Error('Not logged in');
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearToken();
    throw new Error('Upstox session expired — please log in again');
  }
  if (!res.ok || body.status !== 'success') {
    throw new Error(body?.errors?.[0]?.message || `Upstox HTTP ${res.status}`);
  }
  return body.data;
}

async function getExpiries() {
  if (expiries.list.length && Date.now() - expiries.fetchedAt < 60 * 60_000) return expiries.list;
  const data = await upstox('/option/contract', { instrument_key: NIFTY_KEY });
  const today = new Date().toISOString().slice(0, 10);
  const list = [...new Set((data || []).map((c) => c.expiry))].filter((e) => e >= today).sort();
  expiries = { list, fetchedAt: Date.now() };
  return list;
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
    bidQ: m.bid_qty ?? null,
    askQ: m.ask_qty ?? null,
  };
}

// REST option chain: gives the strike list, instrument keys, prev OI and IV. While the WebSocket feed
// is live it is refreshed every REST_WITH_FEED_MS; otherwise it is the data source, polled every POLL_MS.
async function fetchChain(expiry) {
  const data = await upstox('/option/chain', { instrument_key: NIFTY_KEY, expiry_date: expiry });
  const rows = (data || [])
    .map((r) => ({ strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) }))
    .sort((a, b) => a.strike - b.strike);
  restChains.set(expiry, { fetchedAt: Date.now(), spot: data?.[0]?.underlying_spot_price ?? null, rows });
}

// Latest tick (if subscribed) laid over the REST values.
function overlay(o) {
  const t = o.key ? feed.tick(o.key) : null;
  if (!t) return o;
  return {
    ...o, ltp: t.ltp ?? o.ltp, close: t.cp ?? o.close, vol: t.vol ?? o.vol, oi: t.oi ?? o.oi, iv: t.iv ?? o.iv,
    buy: t.buy, sell: t.sell,
    bid: t.bid ?? o.bid, ask: t.ask ?? o.ask, bidQ: t.bidQ ?? o.bidQ, askQ: t.askQ ?? o.askQ, tbq: t.tbq ?? null, tsq: t.tsq ?? null,
  };
}

function buildSnapshot(expiry) {
  const base = restChains.get(expiry);
  if (!base) return null;
  const now = Date.now();
  const spot = feed.tick(NIFTY_KEY)?.ltp ?? base.spot;
  const rows = base.rows.map((r) => ({ strike: r.strike, ce: overlay(r.ce), pe: overlay(r.pe) }));

  const hist = histories.get(expiry) || [];
  const d = {};
  // [0-5] ceLtp, ceVol, ceOi, peLtp, peVol, peOi
  // [6-9] ceBuy, ceSell, peBuy, peSell            — trade volume by aggressor (tick feed only)
  // [10-17] ceBid, ceAsk, ceTbq, ceTsq, peBid, peAsk, peTbq, peTsq — order book (tick feed only)
  for (const r of rows) {
    d[r.strike] = [r.ce.ltp, r.ce.vol, r.ce.oi, r.pe.ltp, r.pe.vol, r.pe.oi];
    if (r.ce.buy != null && r.pe.buy != null) {
      d[r.strike].push(r.ce.buy, r.ce.sell, r.pe.buy, r.pe.sell);
      if (r.ce.tbq != null && r.pe.tbq != null) {
        d[r.strike].push(r.ce.bid, r.ce.ask, r.ce.tbq, r.ce.tsq, r.pe.bid, r.pe.ask, r.pe.tbq, r.pe.tsq);
      }
    }
  }
  hist.push({ t: now, spot, d });
  while (hist.length && now - hist[0].t > HISTORY_MS) hist.shift();
  histories.set(expiry, hist);

  const snap = { expiry, updatedAt: now, spot, rows };
  snapshots.set(expiry, snap);
  return { hist, snap };
}

// Signals always watch the nearest expiry; the expiry open in the browser is tracked too if different.
let nearestExpiry = null;
function targetExpiries() {
  const watching = Date.now() - lastClientAt < IDLE_STOP_MS;
  const list = [nearestExpiry];
  if (watching && activeExpiry && activeExpiry !== nearestExpiry) list.push(activeExpiry);
  return list.filter(Boolean);
}

function snapshotAll() {
  for (const e of targetExpiries()) {
    const built = buildSnapshot(e);
    if (built && e === nearestExpiry) {
      signals.onSnapshot(built.hist, built.snap);
      tape.record(built.hist[built.hist.length - 1], built.snap);
    }
  }
}

// Subscribe to the index plus FEED_STRIKES strikes either side of ATM (calls and puts) per tracked expiry.
function updateSubscriptions() {
  const keys = new Set([NIFTY_KEY]);
  for (const e of targetExpiries()) {
    const c = restChains.get(e);
    if (!c?.rows.length) continue;
    const spot = feed.tick(NIFTY_KEY)?.ltp ?? c.spot;
    let atm = 0;
    c.rows.forEach((r, i) => { if (Math.abs(r.strike - spot) < Math.abs(c.rows[atm].strike - spot)) atm = i; });
    for (const r of c.rows.slice(Math.max(0, atm - FEED_STRIKES), atm + FEED_STRIKES + 1)) {
      if (r.ce.key) keys.add(r.ce.key);
      if (r.pe.key) keys.add(r.pe.key);
    }
  }
  feed.setSubscriptions([...keys]);
}

// During market hours this keeps running with no browser open, so spikes are recorded all day.
async function restLoop() {
  if (polling) return;
  polling = true;
  try {
    const watching = Date.now() - lastClientAt < IDLE_STOP_MS;
    const active = Boolean(token) && (watching || isMarketOpen());
    feed.setEnabled(active && !DEMO);
    if (!active) return;
    const list = await getExpiries();
    nearestExpiry = list[0];
    if (!nearestExpiry) throw new Error('No upcoming Nifty expiries returned by Upstox');
    const live = feed.status().connected;
    let fetched = false;
    for (const e of targetExpiries()) {
      const age = Date.now() - (restChains.get(e)?.fetchedAt || 0);
      if (!live || age >= REST_WITH_FEED_MS) {
        await fetchChain(e);
        fetched = true;
      }
    }
    if (fetched) snapshotAll();
    updateSubscriptions();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    logError('poll', e);
  } finally {
    polling = false;
  }
}
setInterval(restLoop, CFG.pollMs);

// With the feed live, rebuild the snapshot every TICK_SNAPSHOT_MS whenever new ticks have arrived.
let lastFeedVersion = 0;
setInterval(() => {
  if (!feed.status().connected || feed.version === lastFeedVersion) return;
  lastFeedVersion = feed.version;
  try {
    snapshotAll();
  } catch (e) {
    logError('snapshot', e);
  }
}, TICK_SNAPSHOT_MS);

// Volume added in each window, per strike: current volume minus volume at the start of the window,
// and that as a % of the volume at the start of the window (null = strike had no volume before).
function buildResponse(expiry) {
  const snap = snapshots.get(expiry);
  if (!snap) return null;
  const hist = histories.get(expiry) || [];
  const now = snap.updatedAt;
  const oldest = hist[0]?.t ?? now;
  const bases = {};
  for (const w of WINDOWS_MIN) {
    const from = now - w * 60_000;
    bases[w] = hist.find((h) => h.t >= from) || hist[0];
  }

  let ceOi = 0;
  let peOi = 0;
  const rows = snap.rows.map((r) => {
    ceOi += r.ce.oi;
    peOi += r.pe.oi;
    const ce = { ...r.ce, dVol: {}, pVol: {}, dLtp: {} };
    const pe = { ...r.pe, dVol: {}, pVol: {}, dLtp: {} };
    for (const w of WINDOWS_MIN) {
      const b = bases[w]?.d[r.strike];
      fillChange(ce, w, b?.[1], b?.[0]);
      fillChange(pe, w, b?.[4], b?.[3]);
    }
    return { strike: r.strike, ce, pe };
  });

  let atm = null;
  if (snap.spot != null && rows.length) {
    atm = rows.reduce((best, r) => (Math.abs(r.strike - snap.spot) < Math.abs(best - snap.spot) ? r.strike : best), rows[0].strike);
  }

  return {
    source: DEMO ? 'demo' : 'upstox',
    expiry,
    updatedAt: snap.updatedAt,
    spot: snap.spot,
    atm,
    pcr: ceOi ? peOi / ceOi : null,
    trackingSec: Math.round((now - oldest) / 1000),
    windows: WINDOWS_MIN,
    rows,
  };
}

// Also records the LTP change over the same window (null when there's no price to compare).
function fillChange(o, w, baseVol, baseLtp) {
  o.dLtp[w] = baseLtp != null && o.ltp != null ? o.ltp - baseLtp : null;
  if (baseVol == null) {
    o.dVol[w] = 0;
    o.pVol[w] = 0;
    return;
  }
  const added = Math.max(0, o.vol - baseVol);
  o.dVol[w] = added;
  o.pVol[w] = baseVol > 0 ? (added / baseVol) * 100 : added > 0 ? null : 0;
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handleCallback(res, code) {
  try {
    const r = await fetch(`${API}/login/authorization/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: CFG.apiKey,
        client_secret: CFG.apiSecret,
        redirect_uri: CFG.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const body = await r.json();
    if (!body.access_token) throw new Error(body?.errors?.[0]?.message || 'No access token returned');
    saveToken(body.access_token);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h3>Login failed</h3><p>${escapeHtml(e.message)}</p><a href="/">Back</a>`);
  }
}

// Strategy backtester (Backtest / Compare / Strategies / Data tabs): expired-option history from Upstox,
// cached under bt-cache/, saved strategies in bt-data/strategies.json.
const backtester = createBacktester({
  getToken: () => token,
  upstoxGet: upstox,
  cacheDir: env.BT_CACHE_DIR ? path.resolve(env.BT_CACHE_DIR) : path.join(__dirname, 'bt-cache'),
  storeFile: path.join(__dirname, 'bt-data', 'strategies.json'),
  logError,
});

// Live anomaly scanner on the nearest expiry (Anomalies tab), logging to bt-data/anomaly-log/.
const anomalyLive = createAnomalyLive({
  getChain: () => {
    const snap = nearestExpiry && snapshots.get(nearestExpiry);
    return snap ? { expiry: snap.expiry, spot: snap.spot, rows: snap.rows, updatedAt: snap.updatedAt } : null;
  },
  getNextChain: async () => {
    const list = await getExpiries();
    if (!list[1]) return null;
    const rows = await upstox('/option/chain', { instrument_key: NIFTY_KEY, expiry_date: list[1] });
    return {
      expiry: list[1], spot: rows?.[0]?.underlying_spot_price ?? null,
      rows: (rows || []).map((r) => ({ strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) })).sort((a, b) => a.strike - b.strike),
    };
  },
  data: backtester.data,
  isMarketOpen,
  demo: DEMO,
  configFile: path.join(__dirname, 'bt-data', 'anomaly-config.json'),
  logDir: path.join(__dirname, 'bt-data', DEMO ? 'anomaly-log-demo' : 'anomaly-log'),
  logError,
});
backtester.attachLive(anomalyLive);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/login') {
    if (!CFG.apiKey || !CFG.apiSecret) {
      return sendJson(res, 400, { error: 'Set UPSTOX_API_KEY and UPSTOX_API_SECRET in .env first' });
    }
    const auth = new URL(`${API}/login/authorization/dialog`);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', CFG.apiKey);
    auth.searchParams.set('redirect_uri', CFG.redirectUri);
    res.writeHead(302, { Location: auth.toString() });
    return res.end();
  }

  if (p === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) return sendJson(res, 400, { error: 'Missing code' });
    return handleCallback(res, code);
  }

  if (p === '/api/chain') {
    lastClientAt = Date.now();
    if (!token) {
      return sendJson(res, 200, { apiVersion: API_VERSION, loggedIn: false, configured: Boolean(CFG.apiKey && CFG.apiSecret), error: lastError });
    }
    try {
      const list = await getExpiries();
      const wanted = url.searchParams.get('expiry');
      const expiry = list.includes(wanted) ? wanted : list[0];
      if (!expiry) throw new Error('No upcoming Nifty expiries returned by Upstox');
      if (expiry !== activeExpiry || !snapshots.has(expiry)) {
        activeExpiry = expiry;
        await restLoop(); // fetch immediately on first load / expiry switch
      }
      return sendJson(res, 200, {
        apiVersion: API_VERSION,
        loggedIn: true,
        expiries: list,
        error: lastError,
        data: buildResponse(expiry),
        feed: DEMO ? null : feed.status(),
      });
    } catch (e) {
      lastError = e.message;
      logError('api', e);
      return sendJson(res, 200, { apiVersion: API_VERSION, loggedIn: Boolean(token), error: e.message });
    }
  }

  if (p.startsWith('/api/bt/') || p.startsWith('/api/sb/')) return backtester.handle(req, res, url, sendJson);

  if (p === '/api/an/live') {
    lastClientAt = Date.now(); // keep the chain (and so the scanner) running while the page watches
    return sendJson(res, 200, anomalyLive.state());
  }
  if (p === '/api/an/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { if (body.length < 100_000) body += c; });
    req.on('end', () => {
      try { sendJson(res, 200, { ok: true, config: anomalyLive.saveConfig(JSON.parse(body || '{}')) }); } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  // Chart.js, served from node_modules so the page works without a CDN.
  if (p === '/vendor/chart.js') {
    return fs.readFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.min.js'), (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'Run npm install' });
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(buf);
    });
  }

  // Errors from the browser page are written to the same log file.
  if (p === '/api/client-error' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { if (body.length < 10_000) body += c; });
    req.on('end', () => {
      try {
        const e = JSON.parse(body);
        const stack = e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' < ') : '';
        logError('browser', String(e.message || 'Unknown error'), String(e.where || '') + stack);
      } catch {}
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, p);
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(CFG.port, () => {
  console.log(`Nifty option chain running at http://localhost:${CFG.port}`);
  console.log(DEMO ? 'Data source: DEMO (synthetic data, not real prices)' : 'Data source: Upstox API (real market data)');
  if (!token) console.log('Not logged in yet — open the page and click "Login with Upstox".');
  console.log(`Spike recordings are saved to ${CFG.signals.dir}`);
  console.log(`Errors are logged to ${LOG_FILE}`);
});

process.on('uncaughtException', (e) => logError('server-crash', e));
process.on('unhandledRejection', (e) => logError('server-crash', e));

server.on('error', (e) => {
  logError('server', e);
  if (e.code === 'EADDRINUSE') process.exit(1);
});

// Save any spike recording that is still collecting "after" data before exiting.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    signals.flush();
    setTimeout(() => process.exit(0), 1500); // don't hang if the disk is slow
    tape.close(() => process.exit(0));
  });
}

// ---------- utils ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Upstox tokens expire at ~3:30 AM IST the next day, so a saved token is only reused on the same IST day.
function istDay() {
  return new Date(Date.now() + 5.5 * 3600_000 - 3.5 * 3600_000).toISOString().slice(0, 10);
}

function readSavedToken() {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return saved.day === istDay() ? saved.token : null;
  } catch {
    return null;
  }
}

function saveToken(t) {
  token = t;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: t, day: istDay() }));
}

function clearToken() {
  token = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

// Every DEMO_BURST_EVERY polls there's a short burst (volume ×12 on all strikes, spot jumps ~40 pts)
// so the spike, broad-surge and spot-move signals can be seen in demo mode.
// Bursts cycle through: Nifty rise, Nifty fall, and premiums expanding on both sides (IV pump).
const demo = { spot: 24812, vols: {}, tick: 0, burstEvery: num(env.DEMO_BURST_EVERY, 100), tv: 1 };
function demoData(pathname) {
  if (pathname === '/option/contract') {
    const out = [];
    const d = new Date();
    for (let i = 0; i < 4; i++) {
      const e = new Date(d);
      e.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7) + i * 7); // Tuesdays
      out.push({ expiry: e.toISOString().slice(0, 10) });
    }
    return out;
  }
  demo.tick++;
  const burst = demo.tick % demo.burstEvery >= demo.burstEvery - 5;
  const kind = Math.floor(demo.tick / demo.burstEvery) % 3; // 0 rise, 1 fall, 2 IV pump
  // Before a rise, call volume builds up; before a fall, put volume does (for the Volume Flow tab).
  const phase = demo.tick % demo.burstEvery;
  const lead = phase >= demo.burstEvery - 25 && phase < demo.burstEvery - 5;
  demo.spot += (Math.random() - 0.5) * 3 + (burst && kind < 2 ? (kind === 0 ? 8 : -8) : 0);
  demo.tv = burst && kind === 2 ? demo.tv * 1.04 : 1 + (demo.tv - 1) * 0.98;
  const s = demo.spot;
  const rows = [];
  for (let k = 23500; k <= 26000; k += 50) {
    const dist = (k - s) / 50;
    const mk = (isCall) => {
      const key = k + (isCall ? 'c' : 'p');
      const hot = (burst ? 12 : 1) * (lead && kind === (isCall ? 0 : 1) ? 4 : 1);
      demo.vols[key] = (demo.vols[key] ?? Math.round(2e6 * Math.exp(-Math.abs(dist) / 6))) +
        Math.round((0.5 + Math.random()) * 1500 * Math.exp(-Math.abs(dist) / 5) * hot);
      const intrinsic = Math.max(0, isCall ? s - k : k - s);
      const ltp = +(intrinsic + 120 * demo.tv * Math.exp(-Math.abs(dist) / 5) + 1).toFixed(2);
      const oi = Math.round(4e6 * Math.exp(-Math.abs(dist + (isCall ? -4 : 4)) / 5));
      return {
        market_data: { ltp, close_price: +(ltp * 0.95).toFixed(2), volume: demo.vols[key], oi, prev_oi: Math.round(oi * (0.85 + Math.random() * 0.3)) },
        option_greeks: { iv: 11 + Math.abs(dist) * 0.15, delta: 0 },
      };
    };
    rows.push({ strike_price: k, underlying_spot_price: s, call_options: mk(true), put_options: mk(false) });
  }
  return rows;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
