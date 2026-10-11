// Nifty option chain live server (Upstox API v2 + V3 WebSocket feed). Needs Node 22+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSignals, signalConfig } = require('./signals');
const { logError, LOG_FILE } = require('./errorlog');
const { createFeed } = require('./feed');
const { createFlow, flowConfig } = require('./flow');
const { createTape, tapeDays, readTape } = require('./tape');
const { createPulse } = require('./pulse');
const { createBook } = require('./book');
const { createOrderflow } = require('./orderflow');
const { createHedge } = require('./hedge');
const { replayFlow } = require('./replay');
const { buildStats } = require('./sigstats');
const { createBacktester } = require('./bt');
const { createAnomalyLive } = require('./anomaly-live');
const { execFile } = require('child_process');
const { istDate, isMarketOpen } = require('./lib/time');
const { loadEnv, num } = require('./lib/env');
const { createUpstox, parseChain } = require('./lib/upstox');

loadEnv(path.join(__dirname, '.env'));

const env = process.env;

// DEMO=1 serves synthetic data so the UI can be tried without credentials or outside market hours.
const DEMO = env.DEMO === '1';

const CFG = {
  port: num(env.PORT, 3000),
  apiKey: env.UPSTOX_API_KEY || '',
  apiSecret: env.UPSTOX_API_SECRET || '',
  redirectUri: env.UPSTOX_REDIRECT_URI || `http://localhost:${num(env.PORT, 3000)}/callback`,
  pollMs: Math.max(1000, num(env.POLL_MS, 3000)),
  signals: signalConfig(env, env.EVENTS_DIR ? path.resolve(env.EVENTS_DIR) : path.join(__dirname, DEMO ? 'events-demo' : 'events')),
};

const API = 'https://api.upstox.com/v2';
const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const TOKEN_FILE = path.join(__dirname, '.token.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WINDOWS_MIN = [1, 3, 5, 15]; // volume-change windows offered in the UI
const HISTORY_MS = (Math.max(16, CFG.signals.beforeMin) + 1) * 60_000;
// Bumped whenever the /api/chain response shape changes or the page needs routes an older server lacks, so an
// old server + new page is detected.
const API_VERSION = 19;
const FEED_STRIKES = num(env.FEED_STRIKES, 15); // strikes either side of ATM streamed over the WebSocket
const TICK_SNAPSHOT_MS = 500; // how often ticks are folded into a snapshot (history, signals, UI)
const REST_WITH_FEED_MS = 15_000; // REST refresh interval while the WebSocket feed is live
const IDLE_STOP_MS = 30_000; // outside market hours, stop calling Upstox when no browser is watching

// ---------- state ----------
let token = DEMO ? 'demo' : env.UPSTOX_ACCESS_TOKEN || readSavedToken();
let contracts = { expiries: [], lot: 65, fetchedAt: 0 }; // live Nifty option contracts: expiries from today on, lot size
let activeExpiry = null; // expiry the browser is viewing
const sideExpiries = new Map(); // expiry -> last time the Builder asked for it (/api/live), tracked besides the chain's
const restChains = new Map(); // expiry -> { fetchedAt, spot, rows } from the REST option chain
const snapshots = new Map(); // expiry -> latest snapshot (REST + ticks)
// expiry -> [{ t, spot, d: { strike: [ceLtp, ceVol, ceOi, peLtp, peVol, peOi, (ceBuy, ceSell, peBuy, peSell)] } }]
const histories = new Map();
// How each kind of signal played out on earlier days (first run after a new day reads that day's tape).
let signalOdds = null;
try {
  signalOdds = buildStats(CFG.signals.dir, { logError });
} catch (e) {
  logError('signal-odds', e);
}
const signals = createSignals(CFG.signals, logError, signalOdds);
const feed = createFeed({ getToken: () => token, logError });
const flow = createFlow({ ...flowConfig(env), dir: CFG.signals.dir }, logError);
const tape = createTape({ dir: CFG.signals.dir, strikesAround: num(env.TAPE_STRIKES, 15), logError });
const pulse = createPulse({
  dir: CFG.signals.dir,
  buildupStrikes: num(env.PULSE_STRIKES, 5), // strikes either side of ATM used for the OI build-up read
  oiWindowMin: num(env.PULSE_OI_MIN, 15), // OI build-up is measured over this many minutes
  logError,
});
const book = createBook({ strikesAround: num(env.BOOK_STRIKES, 10), pressureStrikes: num(env.PULSE_STRIKES, 5) });
// Order flow of the chart: minute rows of aggressor volume, today live and earlier days from the recorded tape.
const orderflow = createOrderflow({
  dir: CFG.signals.dir,
  strikesAround: num(env.BOOK_STRIKES, 10),
  pressureStrikes: num(env.PULSE_STRIKES, 5),
  days: num(env.ORDERFLOW_DAYS, 10),
  getLot: () => contracts.lot,
  logError,
});
// Give the pulse and the order-book view today's context after a restart.
try {
  const todayTape = readTape(CFG.signals.dir, istDate());
  pulse.seed(todayTape);
  book.seed(todayTape);
  orderflow.seed(todayTape);
} catch (e) {
  logError('tape-seed', e);
}
let lastError = null;
let lastClientAt = 0;
let polling = false;

// ---------- Upstox helpers ----------
// One client for the whole app (lib/upstox.js): the live calls below and the historical downloads of the
// backtester and the hedge planner count against the same rate limits.
const upstoxClient = createUpstox({ getToken: () => token, onUnauthorized: clearToken });
async function upstox(pathname, params = {}) {
  if (DEMO) return demoData(pathname);
  return upstoxClient.live(pathname, params);
}

// Expiries and lot size of the live Nifty options. Re-read hourly and whenever the IST day changes, so newly listed
// expiries appear and past ones drop off.
async function getContracts() {
  const today = istDate();
  if (contracts.expiries.length && contracts.day === today && Date.now() - contracts.fetchedAt < 60 * 60_000) return contracts;
  const data = await upstox('/option/contract', { instrument_key: NIFTY_KEY });
  const expiries = [...new Set((data || []).map((c) => c.expiry))].filter((e) => e >= today).sort();
  contracts = { expiries, lot: (data || []).find((c) => c.lot_size)?.lot_size || 65, fetchedAt: Date.now(), day: today };
  return contracts;
}
const getExpiries = async () => (await getContracts()).expiries;

// REST option chain: gives the strike list, instrument keys, prev OI and IV. While the WebSocket feed
// is live it is refreshed every REST_WITH_FEED_MS; otherwise it is the data source, polled every POLL_MS.
async function fetchChain(expiry) {
  const data = await upstox('/option/chain', { instrument_key: NIFTY_KEY, expiry_date: expiry });
  restChains.set(expiry, { fetchedAt: Date.now(), ...parseChain(data) });
}

// The REST chain of any live expiry, at most maxAgeMs old: what the hedge planner, the strategy deploy and the
// calendar-arbitrage scan price from (the chain screen's expiries are kept fresh by the poll loop anyway).
async function restChain(expiry, maxAgeMs) {
  if (Date.now() - (restChains.get(expiry)?.fetchedAt || 0) >= maxAgeMs) await fetchChain(expiry);
  return restChains.get(expiry);
}

// Latest tick (if subscribed) laid over the REST values. `at` = when the quote was last refreshed: the tick's
// arrival, or the moment the REST chain was fetched (the arbitrage scanner rejects stale quotes on it).
function overlay(o, restAt) {
  const t = o.key ? feed.tick(o.key) : null;
  if (!t) return { ...o, at: restAt };
  return {
    ...o,
    ltp: t.ltp ?? o.ltp,
    close: t.cp ?? o.close,
    vol: t.vol ?? o.vol,
    oi: t.oi ?? o.oi,
    iv: t.iv ?? o.iv,
    buy: t.buy,
    sell: t.sell,
    bid: t.bid ?? o.bid,
    ask: t.ask ?? o.ask,
    bidQ: t.bidQ ?? o.bidQ,
    askQ: t.askQ ?? o.askQ,
    tbq: t.tbq ?? null,
    tsq: t.tsq ?? null,
    at: t.at ?? restAt,
  };
}

function buildSnapshot(expiry) {
  const base = restChains.get(expiry);
  if (!base) return null;
  const now = Date.now();
  const spot = feed.tick(NIFTY_KEY)?.ltp ?? base.spot;
  const rows = base.rows.map((r) => ({ strike: r.strike, ce: overlay(r.ce, base.fetchedAt), pe: overlay(r.pe, base.fetchedAt) }));

  const hist = histories.get(expiry) || [];
  const d = {};
  // [0-5] ceLtp, ceVol, ceOi, peLtp, peVol, peOi
  // [6-9] ceBuy, ceSell, peBuy, peSell            — trade volume by aggressor (tick feed only)
  // [10-17] ceBid, ceAsk, ceTbq, ceTsq, peBid, peAsk, peTbq, peTsq — order book (tick feed only)
  // [18-21] ceBidQ, ceAskQ, peBidQ, peAskQ        — quantity at the best bid / ask (tick feed only), so a scan of
  //                                                 the recorded tape can tell how many lots were fillable
  for (const r of rows) {
    d[r.strike] = [r.ce.ltp, r.ce.vol, r.ce.oi, r.pe.ltp, r.pe.vol, r.pe.oi];
    if (r.ce.buy != null && r.pe.buy != null) {
      d[r.strike].push(r.ce.buy, r.ce.sell, r.pe.buy, r.pe.sell);
      if (r.ce.tbq != null && r.pe.tbq != null) {
        d[r.strike].push(
          r.ce.bid,
          r.ce.ask,
          r.ce.tbq,
          r.ce.tsq,
          r.pe.bid,
          r.pe.ask,
          r.pe.tbq,
          r.pe.tsq,
          r.ce.bidQ ?? 0,
          r.ce.askQ ?? 0,
          r.pe.bidQ ?? 0,
          r.pe.askQ ?? 0,
        );
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

// Signals always watch the nearest expiry; the expiry open in the browser is tracked too if different, and so are
// the expiries the Builder asked for in the last IDLE_STOP_MS.
let nearestExpiry = null;
function targetExpiries() {
  const now = Date.now();
  const watching = now - lastClientAt < IDLE_STOP_MS;
  const list = [nearestExpiry];
  if (watching && activeExpiry) list.push(activeExpiry);
  for (const [e, at] of sideExpiries) {
    if (now - at < IDLE_STOP_MS) list.push(e);
    else sideExpiries.delete(e);
  }
  return [...new Set(list.filter(Boolean))];
}

function snapshotAll() {
  for (const e of targetExpiries()) {
    const built = buildSnapshot(e);
    if (built && e === nearestExpiry) {
      signals.onSnapshot(built.hist, built.snap);
      flow.onSnapshot(built.hist, built.snap);
      tape.record(built.hist[built.hist.length - 1], built.snap);
      pulse.update(built.hist[built.hist.length - 1], built.snap, flow.state().live, signals.state());
      book.update(built.hist[built.hist.length - 1]);
      orderflow.update(built.hist[built.hist.length - 1]);
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
    c.rows.forEach((r, i) => {
      if (Math.abs(r.strike - spot) < Math.abs(c.rows[atm].strike - spot)) atm = i;
    });
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
    const marketOpen = DEMO || isMarketOpen();
    const active = Boolean(token) && (watching || marketOpen);
    // Shut market: nothing changes, so no tick feed and no re-polling of a chain we already hold, even with a page open.
    feed.setEnabled(active && !DEMO && marketOpen);
    if (!active) return;
    const list = await getExpiries();
    nearestExpiry = list[0];
    if (!nearestExpiry) throw new Error('No upcoming Nifty expiries returned by Upstox');
    const live = feed.status().connected;
    let fetched = false;
    for (const e of targetExpiries()) {
      const age = Date.now() - (restChains.get(e)?.fetchedAt || 0);
      if (!marketOpen && restChains.has(e)) continue;
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

// Volume added per time bucket over the last 15 minutes, for strikes around ATM (CE and PE separately).
function surgeHistory(expiry, bucketSec, around) {
  const hist = histories.get(expiry) || [];
  const snap = snapshots.get(expiry);
  if (!hist.length || !snap) return { buckets: [], strikes: [], ce: [], pe: [], spot: [] };
  const bucketMs = bucketSec * 1000;
  const n = Math.floor((15 * 60_000) / bucketMs);
  const now = snap.updatedAt;
  // First history entry at or after time t (null if t is before the history starts).
  const at = (t) => {
    if (t < hist[0].t) return null;
    let lo = 0;
    let hi = hist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hist[mid].t >= t) hi = mid;
      else lo = mid + 1;
    }
    return hist[lo];
  };
  const marks = Array.from({ length: n + 1 }, (_, i) => at(now - (n - i) * bucketMs));

  const rows = snap.rows;
  let atm = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.strike - snap.spot) < Math.abs(rows[atm].strike - snap.spot)) atm = i;
  });
  const strikes = rows.slice(Math.max(0, atm - around), atm + around + 1).map((r) => r.strike);

  const added = (k, idx, i) => {
    const a = marks[i]?.d[k]?.[idx];
    const b = marks[i + 1]?.d[k]?.[idx];
    return a == null || b == null ? null : Math.max(0, b - a);
  };
  return {
    bucketSec,
    atm: rows[atm]?.strike ?? null,
    buckets: marks.slice(1).map((_, i) => now - (n - i - 1) * bucketMs),
    strikes,
    ce: strikes.map((k) => marks.slice(1).map((_, i) => added(k, 1, i))),
    pe: strikes.map((k) => marks.slice(1).map((_, i) => added(k, 4, i))),
    spot: marks.slice(1).map((m) => m?.spot ?? null),
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
  upstox: upstoxClient,
  getRestChain: restChain,
  cacheDir: env.BT_CACHE_DIR ? path.resolve(env.BT_CACHE_DIR) : path.join(__dirname, 'bt-cache'),
  storeFile: path.join(__dirname, 'bt-data', 'strategies.json'),
  tapeDir: CFG.signals.dir, // the recorded quotes the Arbitrage screen's quote scan reads
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
    const c = await restChain(list[1], 10_000); // the scanner asks every 10 s while the calendar is switched on
    return { expiry: list[1], spot: c.spot, rows: c.rows, fetchedAt: c.fetchedAt };
  },
  getFeed: () => (DEMO ? null : feed.status()),
  data: backtester.data,
  isMarketOpen,
  demo: DEMO,
  configFile: path.join(__dirname, 'bt-data', 'anomaly-config.json'),
  logDir: path.join(__dirname, 'bt-data', DEMO ? 'anomaly-log-demo' : 'anomaly-log'),
  logError,
});
backtester.attachLive(anomalyLive);

// Portfolio hedge planner (Hedge screen): holdings from an .xlsx uploaded on the screen (starts empty),
// option chains from the server's own, price history from Upstox.
const hedge = createHedge({
  getContracts,
  getRestChain: restChain,
  upstoxBulk: (p) => upstoxClient.bulk('/v2' + p), // price history for betas and the hedge backtest
  getSpot: () => feed.tick(NIFTY_KEY)?.ltp ?? (nearestExpiry ? snapshots.get(nearestExpiry)?.spot : null) ?? null,
  cacheDir: path.join(__dirname, 'hedge-cache'),
  logError,
});

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleHedge(req, res, p) {
  lastClientAt = Date.now();
  if (DEMO) return sendJson(res, 400, { error: 'The Hedge screen needs live Upstox data (not available in demo mode).' });
  try {
    if (p === '/api/hedge/plan' && req.method === 'POST') {
      const params = JSON.parse((await readBody(req, 200_000)).toString('utf8') || '{}');
      return sendJson(res, 200, await hedge.plan(params));
    }
    if (p === '/api/hedge/backtest' && req.method === 'POST') {
      const params = JSON.parse((await readBody(req, 200_000)).toString('utf8') || '{}');
      return sendJson(res, 200, await hedge.backtest(params));
    }
    if (p === '/api/hedge/saved' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
      return sendJson(res, 200, { ok: true, saved: hedge.saveStructure(body) });
    }
    if (p === '/api/hedge/saved/delete' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}');
      hedge.deleteStructure(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/hedge/reload' && req.method === 'POST') {
      hedge.reload();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/hedge/betas' && req.method === 'POST') {
      await hedge.refreshBetas();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/hedge/upload' && req.method === 'POST') {
      const r = hedge.upload(await readBody(req, 5_000_000));
      await hedge.refreshBetas();
      return sendJson(res, 200, { ok: true, count: r.holdings.length, asOf: r.asOf });
    }
    if (p === '/api/hedge/clear-upload' && req.method === 'POST') {
      hedge.clearUpload();
      await hedge.refreshBetas();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('hedge', e);
    return sendJson(res, 500, { error: e.message });
  }
}

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
        signals: { expiry: list[0], ...signals.state() },
        flow: flow.state(),
        pulse: pulse.state(),
      });
    } catch (e) {
      lastError = e.message;
      logError('api', e);
      return sendJson(res, 200, { apiVersion: API_VERSION, loggedIn: Boolean(token), error: e.message });
    }
  }

  // The streamed chain (REST + ticks, rebuilt every TICK_SNAPSHOT_MS) of any live expiry, for the Builder. Unlike
  // /api/chain it does not change the expiry the Chain screen follows; the expiry is tracked while it is asked for.
  if (p === '/api/live') {
    lastClientAt = Date.now();
    try {
      if (!token) throw new Error('Not logged in');
      const list = await getExpiries();
      const expiry = url.searchParams.get('expiry');
      if (!list.includes(expiry)) throw new Error('Not a live expiry: ' + expiry);
      sideExpiries.set(expiry, Date.now());
      if (!snapshots.has(expiry)) {
        await fetchChain(expiry);
        buildSnapshot(expiry);
        updateSubscriptions();
      }
      const s = snapshots.get(expiry);
      return sendJson(res, 200, { expiry, updatedAt: s.updatedAt, spot: s.spot, rows: s.rows, feed: DEMO ? null : feed.status().connected });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (p.startsWith('/api/bt/') || p.startsWith('/api/sb/')) return backtester.handle(req, res, url, sendJson);

  if (p.startsWith('/api/hedge/')) return handleHedge(req, res, p);

  if (p === '/api/book') {
    lastClientAt = Date.now();
    try {
      return sendJson(res, 200, book.state(nearestExpiry ? snapshots.get(nearestExpiry) : null));
    } catch (e) {
      logError('book', e);
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Order flow per minute (rows [t, callBuy, callSell, putBuy, putSell, bookLean, niftyClose]) from `since` on, and
  // the read of the latest session. Earlier days are read from the tape in the background: `pending` while they are.
  if (p === '/api/orderflow') {
    lastClientAt = Date.now();
    try {
      const since = Number(url.searchParams.get('since'));
      return sendJson(res, 200, orderflow.state(Number.isFinite(since) ? since : 0));
    } catch (e) {
      logError('orderflow', e);
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (p === '/api/flow-series') {
    lastClientAt = Date.now();
    return sendJson(res, 200, flow.series());
  }

  // Replay a recorded day through the Volume Flow logic, optionally with different settings.
  if (p === '/api/flow-days') {
    return sendJson(res, 200, tapeDays(CFG.signals.dir));
  }
  if (p === '/api/flow-replay') {
    const day = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
    const q = (k) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
    try {
      return sendJson(
        res,
        200,
        replayFlow(
          CFG.signals.dir,
          day,
          flowConfig(env, {
            mode: url.searchParams.get('mode') || undefined,
            imbalance: q('imbalance'),
            holdSec: q('holdSec'),
            minQty: q('minQty'),
            reactPts: q('reactPts'),
            horizonMin: q('horizonMin'),
          }),
        ),
      );
    } catch (e) {
      logError('replay', e);
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Backtest the signals over recorded days. Runs signal-backtest.js in its own process: a day takes a few
  // seconds, and this way live data isn't held up and the signals.js on disk is what gets tested.
  if (p === '/api/signal-backtest') {
    const date = url.searchParams.get('date') || 'all';
    if (date !== 'all' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD or all' });
    const args = [path.join(__dirname, 'signal-backtest.js'), '--json', '--dir', CFG.signals.dir];
    if (date !== 'all') args.push(date);
    for (const [k, v] of url.searchParams) {
      if (k !== 'date' && /^[a-zA-Z]+$/.test(k) && Number.isFinite(Number(v))) args.push('--' + k, String(Number(v)));
    }
    return execFile(process.execPath, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        logError('signal-backtest', stderr || err);
        return sendJson(res, 500, { error: (stderr || err.message).trim().split('\n').slice(0, 3).join(' ') });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(stdout);
    });
  }

  if (p === '/api/surge-history') {
    lastClientAt = Date.now();
    const expiry = url.searchParams.get('expiry') || activeExpiry;
    const bucketSec = Math.min(300, Math.max(15, num(url.searchParams.get('bucket'), 60)));
    const around = Math.min(40, Math.max(3, num(url.searchParams.get('strikes'), 12)));
    return sendJson(res, 200, surgeHistory(expiry, bucketSec, around));
  }

  if (p === '/api/an/live') {
    lastClientAt = Date.now(); // keep the chain (and so the scanner) running while the page watches
    return sendJson(res, 200, anomalyLive.state());
  }
  if (p === '/api/an/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      if (body.length < 100_000) body += c;
    });
    req.on('end', () => {
      try {
        sendJson(res, 200, { ok: true, config: anomalyLive.saveConfig(JSON.parse(body || '{}')) });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Latest Nifty tick for the chart (Chain screen and its pop-out window). Counts as a browser watching, so the
  // feed keeps running while only the chart window is open.
  if (p === '/api/nifty/ltp') {
    lastClientAt = Date.now();
    const t = feed.tick(NIFTY_KEY);
    const rest = nearestExpiry ? restChains.get(nearestExpiry) : null;
    const at = t?.at ?? rest?.fetchedAt ?? 0;
    return sendJson(res, 200, { ltp: t?.ltp ?? rest?.spot ?? null, at, live: !DEMO && isMarketOpen() && Date.now() - at < 60_000, loggedIn: Boolean(token) });
  }

  // TradingView Lightweight Charts (candlestick chart), served from node_modules like Chart.js below.
  if (p === '/vendor/lightweight-charts.js') {
    return fs.readFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'), (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'Run npm install' });
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(buf);
    });
  }

  // Option pricing (public/bt-common.js) and trading charges (public/an-view.js) shared with the page: the files
  // the server itself prices with.
  if (p === '/lib/pricing.js' || p === '/lib/costs.js') {
    return fs.readFile(path.join(__dirname, p.slice(1)), (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(buf);
    });
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
    req.on('data', (c) => {
      if (body.length < 10_000) body += c;
    });
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
    flow.flush();
    setTimeout(() => process.exit(0), 1500); // don't hang if the disk is slow
    tape.close(() => process.exit(0));
  });
}

// ---------- utils ----------
// Upstox tokens expire at ~3:30 AM IST the next day, so a saved token is only reused on the same IST day.
function istDay() {
  return istDate(Date.now() - 3.5 * 3600_000);
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
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
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
  // So the Arbitrage screen has something to show: for part of every cycle one put just above the money is quoted
  // 6 points too low (a cheap box), and for a shorter part one call is quoted 5 too high (a butterfly credit).
  const atm = Math.round(s / 50) * 50;
  const cyc = phase / demo.burstEvery;
  const off = (k, isCall) => (!isCall && k === atm + 50 && cyc >= 0.3 && cyc < 0.6 ? -6 : isCall && k === atm + 100 && cyc >= 0.6 && cyc < 0.72 ? 5 : 0);
  for (let k = 23500; k <= 26000; k += 50) {
    const dist = (k - s) / 50;
    const mk = (isCall) => {
      const key = k + (isCall ? 'c' : 'p');
      const hot = (burst ? 12 : 1) * (lead && kind === (isCall ? 0 : 1) ? 4 : 1);
      demo.vols[key] =
        (demo.vols[key] ?? Math.round(2e6 * Math.exp(-Math.abs(dist) / 6))) + Math.round((0.5 + Math.random()) * 1500 * Math.exp(-Math.abs(dist) / 5) * hot);
      const intrinsic = Math.max(0, isCall ? s - k : k - s);
      const ltp = +(intrinsic + 120 * demo.tv * Math.exp(-Math.abs(dist) / 5) + 1).toFixed(2);
      const oi = Math.round(4e6 * Math.exp(-Math.abs(dist + (isCall ? -4 : 4)) / 5));
      // a two-sided quote around the price: about 0.25 % of the premium wide, some lots on each side
      const half = Math.max(0.05, Math.round((ltp * 0.00125) / 0.05) * 0.05);
      const mid = ltp + off(k, isCall);
      const qty = () => 65 * (4 + Math.floor(Math.random() * 30));
      return {
        market_data: {
          ltp,
          close_price: +(ltp * 0.95).toFixed(2),
          volume: demo.vols[key],
          oi,
          prev_oi: Math.round(oi * (0.85 + Math.random() * 0.3)),
          bid_price: +Math.max(0.05, mid - half).toFixed(2),
          ask_price: +(mid + half).toFixed(2),
          bid_qty: qty(),
          ask_qty: qty(),
        },
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
