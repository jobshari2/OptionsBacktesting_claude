// Nifty option chain live server (Upstox API v2 + V3 WebSocket feed). Needs Node 22+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSignals, signalConfig } = require('./signals');
const { logError, LOG_FILE } = require('./errorlog');
const { createFeed } = require('./feed');
const { createFlow, flowConfig } = require('./flow'); // live order-flow read: an input of the Pulse
const { createTape, readTape } = require('./tape');
const { createPulse } = require('./pulse');
const { createOrderflow } = require('./orderflow');
const { createHedge } = require('./hedge');
const { buildStats } = require('./sigstats');
const { createBacktester } = require('./bt');
const { createAnomalyLive } = require('./anomaly-live');
const { istDate, isMarketOpen } = require('./lib/time');
const { loadEnv, num } = require('./lib/env');
const { createAuth, LOGIN_PAGE } = require('./lib/auth');
const { createUpstox, parseChain } = require('./lib/upstox');
const { createOptionCandles, respond, demoRows, OPT_TFS } = require('./lib/optcandles');
const { createKiteSession, loginUrl: kiteLoginUrl, exchangeRequestToken, profile: kiteProfile, invalidate: kiteInvalidate } = require('./lib/kite');
const { createKiteData } = require('./lib/kitedata');
const { createKiteBasket } = require('./kitebasket');
const {
  runMcc,
  runMccStudy,
  runMccModel,
  DEFAULTS: MCC_DEFAULTS,
  STUDY: MCC_STUDY,
  merge: mccMerge,
  pickLegs: mccPickLegs,
  shapeText: mccShapeText,
  etfQty: mccEtfQty,
} = require('./bt/mcc');
const { createMccPaper, weekdaysLeft, monthlyFor } = require('./mccpaper');
const mccLive = require('./bt/mcclive');
const psc = require('./bt/psc');
const lab = require('./bt/lab');
const adjust = require('./bt/adjust');
const { createTickStore } = require('./lib/ticks');

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

const auth = createAuth(env); // AUTH_USERNAME / AUTH_PASSWORD from .env; off when either is missing

// Zerodha Kite: the login in use (one for the whole app), and Kite as a source of live data (lib/kitedata.js).
const kiteSession = createKiteSession({ file: path.join(__dirname, '.kite-token.json'), appFile: path.join(__dirname, '.kite-app.json'), env, logError });
const kiteData = createKiteData({
  getAuth: kiteSession.get,
  logError,
  onAuthError: (e) => kiteSession.clear('Kite rejected the token (' + e.message + '). Log in to Kite again.'),
  prevOiFile: path.join(__dirname, 'bt-data', 'kite-prev-oi.json'),
});

const API = 'https://api.upstox.com/v2';
const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const TOKEN_FILE = path.join(__dirname, '.token.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WINDOWS_MIN = [1, 3, 5, 15]; // volume-change windows offered in the UI
const HISTORY_MS = (Math.max(16, CFG.signals.beforeMin) + 1) * 60_000;
// Bumped whenever the /api/chain response shape changes or the page needs routes an older server lacks, so an
// old server + new page is detected.
const API_VERSION = 22;
const FEED_STRIKES = num(env.FEED_STRIKES, 15); // strikes either side of ATM streamed over the WebSocket
const TICK_SNAPSHOT_MS = 500; // how often ticks are folded into a snapshot (history, signals, UI)
const REST_WITH_FEED_MS = 15_000; // REST refresh interval while the WebSocket feed is live
const IDLE_STOP_MS = 30_000; // outside market hours, stop calling Upstox when no browser is watching

// ---------- state ----------
let token = DEMO ? 'demo' : env.UPSTOX_ACCESS_TOKEN || readSavedToken();
// Where the live screens' data comes from: 'upstox' or 'kite'. Picked on the page (the Kite chip, or the Connect panel)
// and kept in bt-data/live-source.json; LIVE_DATA_SOURCE in .env sets the default. Backtests, the Data screen and the
// Hedge price history always use Upstox: Kite has no expired option contracts.
const SOURCE_FILE = path.join(__dirname, 'bt-data', 'live-source.json');
let liveSource = readLiveSource();
const useKite = () => !DEMO && liveSource === 'kite';
// Logged in to the live data source in use (demo needs nothing).
const liveLoggedIn = () => DEMO || (useKite() ? Boolean(kiteSession.get()) : Boolean(token));
const sourceName = () => (DEMO ? 'demo' : liveSource);
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
const ticks = createTickStore(); // every trade of the streamed instruments today, for the chart's Tick view
const upstoxFeed = createFeed({
  getToken: () => token,
  logError,
  // every message, as it arrives, to the tick store (while Upstox is the source)
  onTick: (keys, at) => !useKite() && recordTicks(upstoxFeed, keys, at),
});
// Kite's tick feed, in feed.js's shape: the live screens' feed while Kite is the source.
const kiteFeed = kiteData.createFeed({
  onTick: (keys, at) => useKite() && recordTicks(kiteFeed, keys, at),
  // Kite refuses the socket: drop the login if Kite says the token is no longer valid.
  async onAuthFail() {
    const a = kiteSession.get();
    if (!a) return;
    try {
      await kiteProfile(a);
    } catch (e) {
      if (e.tokenProblem) {
        kiteSession.clear('Kite rejected the token (' + e.message + '). Log in to Kite again.');
        kiteFeed.setEnabled(false);
      }
    }
  },
});
function recordTicks(f, keys, at) {
  for (const k of keys) {
    const t = f.tick(k);
    if (t) ticks.record(k, at, t.ltp, t.vol);
  }
}
// The feed of the source in use: everything below reads ticks through this.
const activeFeed = () => (useKite() ? kiteFeed : upstoxFeed);
const feed = {
  tick: (key) => activeFeed().tick(key),
  status: () => ({ ...activeFeed().status(), source: sourceName() }),
  get version() {
    return activeFeed().version;
  },
};
const flow = createFlow({ ...flowConfig(env), dir: CFG.signals.dir }, logError);
const tape = createTape({ dir: CFG.signals.dir, strikesAround: num(env.TAPE_STRIKES, 15), logError });
const pulse = createPulse({
  dir: CFG.signals.dir,
  buildupStrikes: num(env.PULSE_STRIKES, 5), // strikes either side of ATM used for the OI build-up read
  oiWindowMin: num(env.PULSE_OI_MIN, 15), // OI build-up is measured over this many minutes
  getLot: () => contracts.lot,
  logError,
});
// Order flow of the chart: minute rows of aggressor volume, today live and earlier days from the recorded tape.
const orderflow = createOrderflow({
  dir: CFG.signals.dir,
  strikesAround: num(env.BOOK_STRIKES, 10),
  pressureStrikes: num(env.PULSE_STRIKES, 5),
  days: num(env.ORDERFLOW_DAYS, 10),
  getLot: () => contracts.lot,
  logError,
});
// Give the pulse and the order flow today's context after a restart.
try {
  const todayTape = readTape(CFG.signals.dir, istDate());
  pulse.seed(todayTape);
  orderflow.seed(todayTape);
} catch (e) {
  logError('tape-seed', e);
}
let lastError = null;
let lastClientAt = 0;
let polling = false;
let future = null; // the near-month Nifty future: { key, symbol, expiry, lot, day }
let futureRetryAt = 0;
let futureError = null;
const chartKeys = new Map(); // instrument key -> last time the chart asked for it: streamed even when off the chain's range

// ---------- Upstox helpers ----------
// One client for the whole app (lib/upstox.js): the live calls below and the historical downloads of the
// backtester and the hedge planner count against the same rate limits.
const upstoxClient = createUpstox({ getToken: () => token, onUnauthorized: clearToken });
const optionCandles = createOptionCandles({ bulk: (pathname) => upstoxClient.bulk(pathname) });
// The live calls of the screens: Upstox's REST API, or the same questions answered from Kite (lib/kitedata.js).
async function upstox(pathname, params = {}) {
  if (DEMO) return demoData(pathname);
  if (useKite()) return kiteData.call(pathname, params);
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

// The near-month Nifty future (the chart's "Nifty Fut"), looked up once per IST day with Upstox's instrument search. It
// is streamed with the chain from then on, so its ticks are recorded whether or not the chart shows it. A failed
// lookup is retried after 5 minutes.
async function getFuture() {
  const today = istDate();
  if (future?.day === today) return future;
  if (Date.now() < futureRetryAt) throw new Error(futureError);
  try {
    const data = await upstox('/instruments/search', { query: 'NIFTY', exchanges: 'NSE', segments: 'FUT', records: 30 });
    const expiry = (x) => (typeof x.expiry === 'number' ? istDate(x.expiry) : String(x.expiry || '').slice(0, 10));
    const f = (data || [])
      .filter((x) => x.instrument_type === 'FUT' && x.underlying_key === NIFTY_KEY && x.instrument_key && expiry(x) >= today)
      .sort((a, b) => (expiry(a) < expiry(b) ? -1 : 1))[0];
    if (!f) throw new Error(`${useKite() ? 'Kite' : 'Upstox'} returned no Nifty future`);
    future = { key: f.instrument_key, symbol: f.trading_symbol || 'NIFTY FUT', expiry: expiry(f), lot: f.lot_size || contracts.lot, day: today };
    updateSubscriptions();
    return future;
  } catch (e) {
    futureError = 'Nifty future not found: ' + e.message;
    futureRetryAt = Date.now() + 5 * 60_000;
    logError('future', e);
    throw new Error(futureError, { cause: e });
  }
}

// The chart asked for this contract: keep it streamed (and its ticks recorded) while it is on screen.
function watchKey(key) {
  if (!key) return;
  const fresh = !chartKeys.has(key);
  chartKeys.set(key, Date.now());
  if (fresh) updateSubscriptions();
}

// Key of an option in the tick store: its instrument key (the demo chain has none, so expiry|strike|type there).
const tickKey = (expiry, strike, type, o) => o.key || `${expiry}|${strike}|${type}`;

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
      orderflow.update(built.hist[built.hist.length - 1]);
    }
  }
}

// Subscribe to the index, the Nifty future, whatever the chart shows and FEED_STRIKES strikes either side of ATM (calls
// and puts) per tracked expiry.
function updateSubscriptions() {
  const keys = new Set([NIFTY_KEY, ...(future ? [future.key] : [])]);
  for (const [k, at] of chartKeys) {
    if (Date.now() - at < IDLE_STOP_MS) keys.add(k);
    else chartKeys.delete(k);
  }
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
  if (useKite()) {
    kiteFeed.setSubscriptions([...keys]);
    upstoxFeed.setSubscriptions([]);
  } else {
    upstoxFeed.setSubscriptions([...keys]);
    kiteFeed.setSubscriptions([]);
  }
}

// During market hours this keeps running with no browser open, so spikes are recorded all day.
async function restLoop() {
  if (polling) return;
  polling = true;
  try {
    const watching = Date.now() - lastClientAt < IDLE_STOP_MS;
    const marketOpen = DEMO || isMarketOpen();
    const active = liveLoggedIn() && (watching || marketOpen);
    // Shut market: nothing changes, so no tick feed and no re-polling of a chain we already hold, even with a page open.
    const feedOn = active && !DEMO && marketOpen;
    kiteFeed.setEnabled(useKite() && feedOn);
    upstoxFeed.setEnabled(!useKite() && feedOn); // Upstox streams for the screens while it is the source
    if (!active) return;
    const list = await getExpiries();
    nearestExpiry = list[0];
    if (!nearestExpiry) throw new Error(`No upcoming Nifty expiries returned by ${useKite() ? 'Kite' : 'Upstox'}`);
    await getFuture().catch(() => {}); // logged there; the chain does not depend on it
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
    if (fetched && DEMO) recordDemoTicks();
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
    source: sourceName(),
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

// Strategy store and history (Strategies / Builder / Data tabs): expired-option history from Upstox, cached under
// bt-cache/, saved strategies in bt-data/strategies.json.
const backtester = createBacktester({
  getToken: () => token,
  upstox: upstoxClient,
  getRestChain: restChain,
  cacheDir: env.BT_CACHE_DIR ? path.resolve(env.BT_CACHE_DIR) : path.join(__dirname, 'bt-cache'),
  storeFile: path.join(__dirname, 'bt-data', 'strategies.json'),
  logError,
  // with Kite as the live source: today's Nifty candles and the live expiries come from Kite
  liveData: () => (useKite() && kiteSession.get() ? { niftyIntraday: kiteData.niftyIntraday, contracts: () => kiteData.call('/option/contract') } : null),
});

// Live anomaly scanner on the nearest expiry, in the background: Strategies › Deploy live reads it for the entry
// conditions of signal strategies (the library's Arbitrage category). Logs to bt-data/anomaly-log/.
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

// The login as the screens see it: whether orders through an enctoken web session are allowed (KITE_ORDERS_ENCTOKEN=1).
// Also the live data source and the Redirect URL the Kite Connect app must have.
const kiteRedirect = (req) => `http://${req?.headers?.host || 'localhost:' + CFG.port}/kite/callback`;
const kiteStatus = (req) => ({
  ...kiteSession.status(),
  ordersEnctoken: env.KITE_ORDERS_ENCTOKEN === '1',
  liveSource: sourceName(),
  upstox: { loggedIn: !DEMO && Boolean(token), configured: Boolean(CFG.apiKey && CFG.apiSecret) }, // the other source, for the switch
  redirectUrl: kiteRedirect(req),
  data: useKite() ? { feed: kiteFeed.status(), ...kiteData.status() } : null,
});
// After a Kite login or logout: the live feed and the instrument list start again.
function kiteChanged() {
  kiteFeed.restart();
  if (useKite()) resetLive();
}

// Orders of Live Ideas: a trade idea's legs sent to Kite as one basket, after the screen's confirmation (kitebasket.js).
const kiteBasket = createKiteBasket({
  getAuth: kiteSession.get,
  symbolFor: async (expiry, strike, type) => (DEMO ? null : await kiteData.symbolFor(expiry, strike, type)),
  getLot: () => contracts.lot,
  allowEnctoken: env.KITE_ORDERS_ENCTOKEN === '1',
  marketProtection: env.KITE_MARKET_PROTECTION || null, // sent with MARKET orders only
  demo: DEMO,
  isMarketOpen,
  logFile: path.join(__dirname, 'logs', 'kite-baskets.jsonl'),
  logError,
});

// NIFTYBEES's LTP for the Modified covered call (paper trade and live trade), read at most every 20 s; null in demo mode.
let ccBees = { at: 0, px: null };
async function ccBeesPrice(maxAgeMs = 20_000) {
  if (DEMO) return null; // the demo models NIFTYBEES from its synthetic Nifty
  if (Date.now() - ccBees.at < maxAgeMs) return ccBees.px;
  const d = await upstox('/market-quote/ltp', { instrument_key: backtester.data.BEES });
  ccBees = { at: Date.now(), px: Object.values(d || {})[0]?.last_price || null };
  return ccBees.px;
}
// ---------- Trading Ideas › Covered call › Modified covered call (bt/mcc.js, mccpaper.js) ----------
// Backtest (current settings + the same without adjustments) and the adjustment study run as jobs the page polls; the
// last of each is kept in bt-data/mcc-backtest.json / mcc-study.json. The paper trade is checked every 30 s. No orders.
const MCC_FILES = { backtest: path.join(__dirname, 'bt-data', 'mcc-backtest.json'), study: path.join(__dirname, 'bt-data', 'mcc-study.json') };
const mccPaper = createMccPaper({
  file: path.join(__dirname, 'bt-data', DEMO ? 'mcc-paper-demo.json' : 'mcc-paper.json'),
  demo: DEMO,
  isMarketOpen: () => DEMO || isMarketOpen(),
  getExpiries,
  getChain: (expiry) => restChain(expiry, 30_000),
  closeOf: async (day) => {
    await backtester.data.loadIndex(day, day);
    const a = backtester.data.spotDay(day);
    return a ? a[a.length - 1] : null;
  },
  beesPrice: ccBeesPrice,
  getLot: () => contracts.lot,
  logError,
});
setInterval(() => {
  if (liveLoggedIn()) mccPaper.tick();
}, 30_000);
const mccJobs = new Map();
function mccJob(kind, run) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, kind, status: 'running', progress: { phase: 'Starting', done: 0, total: 0 }, startedAt: Date.now() };
  mccJobs.set(id, job);
  while (mccJobs.size > 6) mccJobs.delete(mccJobs.keys().next().value);
  run({ onProgress: (x) => (job.progress = { ...x, api: backtester.data.apiStats() }), stopped: () => Boolean(job.stop) })
    .then((r) => {
      job.result = r;
      job.status = 'done';
      if (!MCC_FILES[kind]) return; // 'run': a study rule opened on the Backtest tab, not kept
      fs.mkdirSync(path.dirname(MCC_FILES[kind]), { recursive: true });
      fs.writeFileSync(MCC_FILES[kind] + '.tmp', JSON.stringify(r));
      fs.renameSync(MCC_FILES[kind] + '.tmp', MCC_FILES[kind]);
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e.message;
      logError('mcc-' + kind, e);
    });
  return job;
}
// Live trade tab (bt/mcclive.js): a saved Builder trade or the paper trade's series, with the NIFTYBEES bought against
// it (kept per trade in bt-data/mcc-live.json), on the live chain. Read-only: nothing is ordered.
const MCC_LIVE_FILE = path.join(__dirname, 'bt-data', DEMO ? 'mcc-live-demo.json' : 'mcc-live.json');
// The Builder's saved trades (bt/index.js keeps them; written here only by the Live trade's NIFTYBEES entry, close and
// undo, compact like bt/index.js writes them).
const SB_TRADES_FILE = path.join(__dirname, 'bt-data', 'paper-trades.json');
// Saved trades with open legs, and closed ones marked as this strategy (L.kind) in the Builder (their final result
// is shown), and the strategy's paper trade series.
function liveTrades(L) {
  const saved = readJson(SB_TRADES_FILE) || [];
  const list = saved
    .filter((t) => t?.snap?.legs?.some((l) => l.open) || (t?.snap?.mcc?.on && mccLive.kindOfTrade(t) === L.kind && t.snap.legs?.length))
    .map((t) => mccLive.fromBuilder(t, L.kind));
  const paper = mccLive.fromPaper(L.paper().state().paper, L.name);
  if (paper) list.push(paper);
  return list.filter((x) => (x.legs.length || x.done) && x.expiry);
}
// Changes one saved Builder trade (id) with f(trade) -> the new trade, and writes the list back.
function editSavedTrade(id, f) {
  const list = readJson(SB_TRADES_FILE) || [];
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('That saved trade is not in the Builder any more');
  list[i] = f(list[i]);
  writeJson(SB_TRADES_FILE, list);
  return list[i];
}
// A trade's NIFTYBEES as first entered on this tab (bt-data/mcc-live.json, before the Builder kept them in the trade)
// moved into the trade's snap.mcc, so the Builder shows them too.
function withLegacyBees(t, cfg) {
  const old = cfg.trades?.['builder:' + t.id]?.bees;
  if (mccLive.beesOfSnap(t.snap) || !(old?.qty > 0 && old?.price > 0)) return t;
  return { ...t, snap: { ...t.snap, mcc: { ...(t.snap.mcc || {}), on: true, qty: old.qty, price: old.price, ...(old.day ? { day: old.day } : {}) } } };
}
// Nifty's daily closes (and India VIX) over the cached history, for the suggestions' past moves; kept 6 h.
let mccCloses = { at: 0, list: null };
async function mccHistory() {
  if (mccCloses.list && Date.now() - mccCloses.at < 6 * 3600_000) return mccCloses.list;
  const d = backtester.data;
  const from = d.indexStart();
  if (!from) throw new Error('No Nifty history in the cache yet (Data screen): the suggestions are tested on it');
  const yesterday = d.addDays(istDate(), -1);
  let days;
  try {
    days = await d.loadIndex(from, yesterday, 'soft');
  } catch {
    days = await d.loadIndex(from, d.addDays(istDate().slice(0, 7) + '-01', -1), 'soft'); // offline: the months cached
  }
  const list = [];
  for (const day of days) {
    const a = d.spotDay(day);
    const v = d.vixDay(day);
    const close = a ? a[a.length - 1] : null;
    if (close > 0) list.push({ day, close, vix: v ? v[v.length - 1] : null });
  }
  mccCloses = { at: Date.now(), list };
  return list;
}
// The trade's expiry as the Builder streams it (/api/live): the REST chain with the ticks folded in every
// TICK_SNAPSHOT_MS. While the Live trade tab asks for it (every few seconds), the expiry is tracked and its legs and
// NIFTYBEES are streamed even when they are off the chain's streamed range (watchKey).
async function mccLiveChain(expiry, legs) {
  const list = await getExpiries();
  if (!list.includes(expiry)) throw new Error(`The ${expiry} expiry is not live any more (expired?)`);
  sideExpiries.set(expiry, Date.now());
  if (!snapshots.has(expiry)) {
    await fetchChain(expiry);
    buildSnapshot(expiry);
    updateSubscriptions();
  }
  const base = restChains.get(expiry);
  for (const l of legs) {
    const r = base?.rows.find((x) => x.strike === l.strike);
    watchKey((l.type === 'CE' ? r?.ce : r?.pe)?.key);
  }
  if (!DEMO) watchKey(backtester.data.BEES);
  const snap = snapshots.get(expiry);
  return { spot: snap.spot, rows: snap.rows, updatedAt: snap.updatedAt, fetchedAt: base?.fetchedAt };
}
// NIFTYBEES now: its streamed tick when fresh, else its LTP read at most every 5 s. { px, at, how } or null.
async function mccBeesNow() {
  const t = DEMO ? null : feed.tick(backtester.data.BEES);
  if (t?.ltp > 0 && Date.now() - (t.at || 0) < 60_000) return { px: t.ltp, at: t.at, how: 'tick' };
  const px = await ccBeesPrice(5_000).catch(() => null);
  return px > 0 ? { px, at: ccBees.at, how: 'ltp' } : null;
}

// Nifty and NIFTYBEES now, for a Live trade tab with no open trade on it (a closed trade, or none): Nifty's streamed
// tick, else the nearest expiry's chain; NIFTYBEES streamed (watched from here on) or its LTP. null when not read.
async function liveNow() {
  const tick = DEMO ? null : feed.tick(NIFTY_KEY);
  let [spot, at] = tick?.ltp > 0 ? [tick.ltp, tick.at || Date.now()] : [null, null];
  if (!spot) {
    const e = nearestExpiry || (await getExpiries())[0];
    const snap = e ? snapshots.get(e) : null;
    if (snap?.spot > 0) [spot, at] = [snap.spot, snap.updatedAt];
    else if (e) {
      const c = await restChain(e, 30_000);
      if (c?.spot > 0) [spot, at] = [c.spot, c.fetchedAt];
    }
  }
  if (!(spot > 0)) return null;
  if (!DEMO) watchKey(backtester.data.BEES);
  const b = await mccBeesNow().catch(() => null);
  return { spot, at, bees: b?.px || null, beesAt: b?.at || null, beesHow: b?.how || null };
}

// fresh: the tab is being opened (not a poll or a pick), so a remembered closed trade or None gives way to an open
// trade of this strategy, and the tab opens on live prices.
async function liveState(L, key, fresh = false) {
  const cfg = readJson(L.file) || {};
  const all = liveTrades(L);
  const trades = all.map((x) => ({
    key: x.key,
    name: x.name,
    src: x.src,
    expiry: x.expiry,
    mcc: Boolean(x.flag) || L.looks(x.legs.length ? x.legs : x.closed), // this strategy (marked, or its shape)
    closed: Boolean(x.done),
    legs: x.legs.map(mccLive.legText).join(', '),
  }));
  const now = () => liveNow().catch(() => null);
  // the newest open one of this strategy (saved trades are kept in the order they were first saved)
  const ownOpen = () =>
    all.findLast((x) => x.src === 'builder' && !x.done && (x.flag || L.looks(x.legs))) || all.find((x) => !x.done && (x.flag || L.looks(x.legs)));
  // None picked on the tab: no trade shown (the list still sent, to pick one or enter a new one)
  // newest: the newest open trade (a trade just entered from this tab and saved in the Builder)
  const want = key === 'newest' ? null : key || cfg.selected;
  let pos = all.find((x) => x.key === want) || null;
  if (fresh && (want === 'none' || pos?.done)) pos = ownOpen() || pos;
  if (want === 'none' && !pos) return { trades, key: 'none', pos: null, now: await now() };
  pos ||=
    ownOpen() ||
    // strict (the collar): none of its own → no trade shown (another strategy's trade only when picked)
    (L.strict ? null : all.find((x) => !x.done) || all[0]);
  if (!pos) return { trades, pos: null, now: await now() };
  // NIFTYBEES entered on this tab before the Builder kept them: moved into the saved trade once (values unchanged, its
  // saved time kept), so the Builder shows them too. Not in demo mode: it shares the real saved trades.
  if (!DEMO && L.kind === 'mcc' && pos.src === 'builder' && !pos.bees && cfg.trades?.[pos.key]?.bees?.qty > 0 && cfg.trades[pos.key].bees.price > 0) {
    try {
      editSavedTrade(pos.id, (t) => withLegacyBees(t, cfg));
      pos.bees = mccLive.beesOfSnap(withLegacyBees({ id: pos.id, snap: {} }, cfg).snap);
      pos.flag = true;
      delete cfg.trades[pos.key].bees;
      writeJson(L.file, cfg);
    } catch (e) {
      logError('mcc-live bees move', e);
    }
  }
  const own = cfg.trades?.[pos.key] || {};
  // the NIFTYBEES: a Builder trade's own (snap.mcc), else as entered here before; the paper trade's unless overridden
  const beesIn = pos.src === 'builder' ? pos.bees || own.bees : own.bees || pos.bees;
  // closed: no chain needed, the result as booked
  if (pos.done) {
    const b = beesIn?.qty > 0 && beesIn?.price > 0 ? beesIn : null;
    return {
      trades,
      key: pos.key,
      pos,
      closed: true,
      bees: b ? { qty: b.qty, price: b.price, exitPx: b.exitPx || null, exitDay: b.exitDay || null, exitAt: b.exitAt || null } : null,
      entrySpot: own.entrySpot > 0 ? own.entrySpot : pos.spotIn,
      now: await now(),
    };
  }
  // no chain for it (expired, not listed): the list is still sent, so another trade can be picked
  let chain;
  try {
    chain = await mccLiveChain(pos.expiry, pos.legs);
    if (!chain?.spot) throw new Error(`No live chain for the ${pos.expiry} expiry yet`);
  } catch (e) {
    return { trades, key: pos.key, pos: null, error: e.message, now: await now() };
  }
  const T = mccLive.yearsTo(pos.expiry);
  const M = mccLive.market(chain, T);
  const entrySpot = own.entrySpot > 0 ? own.entrySpot : pos.spotIn;
  const qty = beesIn?.qty ?? 0;
  const price = beesIn?.price ?? null;
  const live = await mccBeesNow();
  // NIFTYBEES now: live, else moved from its entry price with Nifty since the entry (else Nifty ÷ 100)
  const now = live?.px || (price > 0 && entrySpot > 0 ? (price * M.spot) / entrySpot : M.spot / 100);
  const bees = {
    qty,
    price: price > 0 ? price : now,
    now,
    live: Boolean(live),
    how: live?.how || null,
    at: live?.at || null,
    set: price > 0 && qty > 0,
    fromPaper: pos.src === 'paper' && !own.bees && Boolean(pos.bees),
    fromBuilder: pos.src === 'builder' && Boolean(pos.bees), // kept in the saved trade (the Builder shows them too)
    exitPx: beesIn?.exitPx || null, // already sold (recorded in the Builder)
  };
  // cal: what the page adds to the model so each leg is worth its LTP at Nifty now (bt/mcclive.js valueToday)
  const legs = pos.legs.map((l) => ({ ...l, ltp: M.px(l.type, l.strike), iv: M.iv(l.type, l.strike), cal: mccLive.legCal(l, M) }));
  // legs of other expiries (closed with the whole trade): their LTP when that chain has been read
  const others = (pos.others || []).map((l) => {
    const r = restChains.get(l.expiry)?.rows?.find((x) => x.strike === l.strike);
    const p = (l.type === 'CE' ? r?.ce : r?.pe)?.ltp;
    return { ...l, ltp: p > 0 ? p : null };
  });
  return {
    trades,
    key: pos.key,
    pos: { ...pos, legs, others },
    M,
    market: {
      spot: M.spot,
      F: M.F,
      df: M.df,
      atmIv: M.atmIv,
      T,
      daysLeft: weekdaysLeft(istDate(), pos.expiry),
      at: chain.updatedAt, // the streamed snapshot (ticks folded in)
      restAt: chain.fetchedAt,
      feed: DEMO ? false : Boolean(feed.status().connected),
    },
    bees,
    entrySpot,
    entryFromTrade: !(own.entrySpot > 0),
    grid: mccLive.grid(pos, M, bees, entrySpot),
    cover: mccLive.beesCover(pos, M, bees),
  };
}
const liveOut = (st) => ({ ...st, M: undefined, marketOpen: DEMO || isMarketOpen(), demo: DEMO });
// The strategies' Live trade tabs (bt/mcclive.js): the same screen for each, with what differs here. kind: how a
// saved trade's NIFTYBEES are marked in the Builder (snap.mcc.kind, none = Covered call); file: the tab's own
// settings (entry Nifty, the paper trade's NIFTYBEES override, the trade picked); plan: the legs its rules pick on a
// live chain for "Enter new trade". The Put spread collar's entry is added with its routes (LIVE.psc).
const LIVE = {
  mcc: {
    kind: 'mcc',
    name: 'Modified covered call',
    file: MCC_LIVE_FILE,
    paper: () => mccPaper,
    looks: mccLive.looksMcc,
    studyFile: () => MCC_FILES.study,
    defaults: MCC_DEFAULTS,
    // bt/mcc.js pickLegs: call ratio 1×2 + put 2-3-1, the ideal trade's flat zone (b.target ₹, 0 = fixed distances)
    plan(S, strikes, ltp, lot, b) {
      const amount = Number(b.target);
      const prm = mccMerge({ lotSize: lot, target: { on: amount !== 0, amount: amount > 0 ? amount : MCC_DEFAULTS.target.amount } });
      const pick = mccPickLegs(S, prm, strikes, ltp, lot);
      return { prm, pick, shapeText: mccShapeText(pick.shape, prm.target.amount) };
    },
  },
};
// A Live trade tab's routes: p is the part after /api/<strategy> ('/live', '/live/config', …); errors go to the caller.
async function handleLive(req, res, url, p, L) {
  if (p === '/live' && req.method !== 'POST') {
    if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the live trade is priced on the live chain`);
    return sendJson(res, 200, liveOut(await liveState(L, url.searchParams.get('key'), url.searchParams.get('fresh') === '1')));
  }
  if (p === '/live/config' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}');
    if (typeof b.key !== 'string' || !b.key) throw new Error('Which trade?');
    const num = (v, lo, hi) => (v === '' || v == null ? null : Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : NaN);
    const cfg = readJson(L.file) || {};
    cfg.trades ||= {};
    const t = (cfg.trades[b.key] ||= {});
    if (b.bees) {
      const qty = num(b.bees.qty, 0, 1e8);
      const price = num(b.bees.price, 1, 1e5);
      if (Number.isNaN(qty) || Number.isNaN(price)) throw new Error('NIFTYBEES: units 0 – 10 crore, price ₹1 – ₹1,00,000');
      if (b.key.startsWith('builder:')) {
        // kept in the saved trade itself (snap.mcc), where the Builder shows and saves them too
        editSavedTrade(b.key.slice(8), (tr) => {
          const m = { ...(tr.snap.mcc || {}), on: true };
          if (!tr.snap.mcc?.on) m.kind = L.kind; // first entered here: marked as this strategy
          if (qty == null && price == null) for (const k of ['qty', 'price', 'day']) delete m[k];
          else Object.assign(m, { qty: qty ?? 0, price }, b.bees.day ? { day: String(b.bees.day).slice(0, 10) } : {});
          return { ...tr, savedAt: Date.now(), snap: { ...tr.snap, mcc: m } };
        });
        delete t.bees;
      } else {
        t.bees = qty == null && price == null ? undefined : { qty: qty ?? 0, price };
        if (b.bees.day) t.bees.day = String(b.bees.day).slice(0, 10);
      }
    }
    if ('entrySpot' in b) {
      const e = num(b.entrySpot, 1000, 1e6);
      if (Number.isNaN(e)) throw new Error('Entry Nifty: a level like 22960');
      t.entrySpot = e ?? undefined;
    }
    cfg.selected = b.key;
    writeJson(L.file, cfg);
    return sendJson(res, 200, liveOut(await liveState(L, b.key)));
  }
  // Close the whole saved Builder trade: every open leg at the prices sent, the NIFTYBEES sold at beesPx — recorded
  // in the saved trade as the Builder records exits. Nothing is sent to a broker. reopen undoes the last such close.
  if ((p === '/live/close' || p === '/live/reopen') && req.method === 'POST') {
    const b = JSON.parse((await readBody(req, 20_000)).toString('utf8') || '{}');
    if (typeof b.key !== 'string' || !b.key.startsWith('builder:'))
      throw new Error('Only a trade saved in the Builder can be closed here (the paper trade is run on its own tab)');
    if (b.confirm !== true) throw new Error('Closing the trade needs confirmation');
    const cfg = readJson(L.file) || {};
    editSavedTrade(b.key.slice(8), (t) =>
      p.endsWith('/close') ? mccLive.closeSaved(withLegacyBees(t, cfg), { px: b.px || {}, beesPx: b.beesPx }) : mccLive.reopenSaved(t),
    );
    // NIFTYBEES entered on this tab before now live in the trade
    if (cfg.trades?.[b.key]?.bees) {
      delete cfg.trades[b.key].bees;
      writeJson(L.file, cfg);
    }
    return sendJson(res, 200, liveOut(await liveState(L, b.key)));
  }
  // Enter a new trade: the expiries it can be built on (the default: the monthly series the paper trade would take),
  // the legs the rules pick on that expiry's live chain (bt/mcc.js pickLegs: call ratio 1×2 + put 2-3-1, the ideal
  // trade's flat zone), which the page opens in the Builder. Nothing is sent to a broker.
  if (p === '/live/expiries') {
    if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the trade is built on the live chain`);
    const today = istDate();
    const list = (await getExpiries()).filter((e) => e >= today).sort();
    const lastOfMonth = new Map(list.map((e) => [e.slice(0, 7), e]));
    const monthly = new Set(lastOfMonth.values());
    return sendJson(res, 200, {
      expiries: list.map((e) => ({ expiry: e, monthly: monthly.has(e), days: Math.round((Date.parse(e) - Date.parse(today)) / 86400_000) })),
      dflt: monthlyFor(list, today, L.defaults.minDays) || list[0] || null,
      minDays: L.defaults.minDays,
      target: L.defaults.target?.on ? L.defaults.target.amount : 0,
    });
  }
  if (p === '/live/plan' && req.method === 'POST') {
    if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the trade is built on the live chain`);
    const b = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}');
    const chain = await mccLiveChain(String(b.expiry || ''), []);
    if (!(chain?.spot > 0) || !chain.rows?.length) throw new Error(`No live chain for the ${b.expiry} expiry yet`);
    const S = Number(b.spot) >= 1000 ? Number(b.spot) : chain.spot;
    const lot = contracts.lot || L.defaults.lotSize;
    const rows = new Map(chain.rows.map((r) => [r.strike, r]));
    const q = (type, k) => rows.get(k)?.[type === 'CE' ? 'ce' : 'pe'];
    const ltp = (type, k) => (q(type, k)?.ltp > 0 ? q(type, k).ltp : null);
    const { prm, pick, shapeText } = L.plan(
      S,
      [...rows.keys()].sort((x, y) => x - y),
      ltp,
      lot,
      b,
    );
    const legs = pick.legs.map((l) => {
      const o = q(l.type, l.strike) || {};
      return { role: l.role, type: l.type, strike: l.strike, lots: l.lots, side: l.side, ltp: ltp(l.type, l.strike), bid: o.bid ?? null, ask: o.ask ?? null };
    });
    const bees = await mccBeesNow().catch(() => null);
    const beesPx = bees?.px || S / 100;
    return sendJson(res, 200, {
      expiry: b.expiry,
      spot: chain.spot,
      S,
      lot,
      legs,
      shape: pick.shape,
      shapeText,
      target: prm.target,
      atmIv: mccLive.market(chain, mccLive.yearsTo(b.expiry)).atmIv,
      bees: { now: beesPx, live: Boolean(bees), qty: mccEtfQty(prm, S, beesPx) },
      at: chain.updatedAt,
    });
  }
  if (p === '/live/suggest' && req.method === 'POST') {
    if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the suggestions are priced on the live chain`);
    const b = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}');
    const st = await liveState(L, b.key);
    if (!st.pos) throw new Error('No trade to suggest for');
    const closes = await mccHistory();
    const days = Math.max(1, st.market.daysLeft);
    const moves = mccLive.pastMoves(closes, days, st.M.atmIv);
    if (moves.length < 100) throw new Error(`Only ${moves.length} past ${days}-day moves in the cached history: too few to test on`);
    const slip = (L.defaults.costs.slipPct || 0.5) / 100;
    const out = mccLive.suggest(st.pos, st.M, st.bees, moves, { slip, day: istDate(), days, shape: L.kind });
    for (const v of [...out.list, ...out.protect, ...out.risky]) {
      v.after.legs = v.after.legs.map((l) => ({ ...l, ltp: st.M.px(l.type, l.strike), iv: st.M.iv(l.type, l.strike), cal: mccLive.legCal(l, st.M) }));
    }
    return sendJson(res, 200, {
      key: st.key,
      ...out,
      rules: mccLive.studyRules(readJson(L.studyFile()), st.pos, st.M, st.entrySpot, L.kind),
      sample: { n: moves.length, days, from: closes[0]?.day, to: closes[closes.length - 1]?.day, ivNow: st.M.atmIv, slipPct: slip * 100 },
      spot: st.M.spot,
      at: Date.now(),
    });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

async function handleMcc(req, res, url, p) {
  lastClientAt = Date.now();
  try {
    if (p === '/api/mcc/meta') {
      const cal = await backtester.data.expiryCalendar().catch(() => null);
      const monthly = cal ? [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort() : [];
      return sendJson(res, 200, {
        defaults: MCC_DEFAULTS,
        study: MCC_STUDY.map(([id, label]) => ({ id, label })),
        lot: contracts.lot || MCC_DEFAULTS.lotSize,
        monthly,
        demo: DEMO,
      });
    }
    if ((p === '/api/mcc/backtest' || p === '/api/mcc/study') && req.method !== 'POST') return sendJson(res, 200, { saved: readJson(MCC_FILES[p.slice(9)]) });
    // backtest: the settings and the same without adjustments, saved; run: the same for one study rule, not saved
    if ((p === '/api/mcc/backtest' || p === '/api/mcc/run') && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
      const range = { from: b.from, to: b.to };
      const params = b.params || {};
      const job = mccJob(p.slice(9), async ({ onProgress, stopped }) => {
        const withAdj = await runMcc(backtester.data, params, range, { onProgress: (x) => onProgress({ ...x, phase: 'With adjustments' }), stopped });
        const off = { ...params, adj: { ...(params.adj || {}), on: false }, up: { ...(params.up || {}), mode: 'none' } };
        const without = await runMcc(backtester.data, off, range, { onProgress: (x) => onProgress({ ...x, phase: 'Without adjustments' }), stopped });
        return { at: Date.now(), range, withAdj, without };
      });
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/mcc/study' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
      const job = mccJob('study', (o) => runMccStudy(backtester.data, b.params || {}, { from: b.from, to: b.to }, o));
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/mcc/job') {
      const job = mccJobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Job not found (the server may have restarted): run it again' });
      return sendJson(res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        result: job.status === 'done' ? job.result : undefined,
      });
    }
    if (p === '/api/mcc/job/stop' && req.method === 'POST') {
      const job = mccJobs.get(JSON.parse((await readBody(req, 2_000)).toString('utf8') || '{}').id);
      if (job) job.stop = true;
      return sendJson(res, 200, { ok: Boolean(job) });
    }
    if (p === '/api/mcc/model' && req.method === 'POST') {
      // Strategy & rules › Month by month: the model path, every month priced by Black-Scholes (nothing saved)
      const b = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
      const o = b.opts || {};
      const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
      const opts = {
        S0: clamp(o.S0, 5000, 100000, 24000),
        pct: clamp(o.pct, -60, 100, 10),
        months: Math.round(clamp(o.months, 1, 36, 12)),
        iv: clamp(o.iv, 5, 60, 13),
        swings: o.swings !== false,
      };
      return sendJson(res, 200, runMccModel(b.params || {}, opts));
    }
    // NIFTYBEES now for the Trades screen's Modified covered call columns: { px, how, at }, px null when unknown (demo)
    if (p === '/api/mcc/bees') {
      const b = liveLoggedIn() ? await mccBeesNow().catch(() => null) : null;
      return sendJson(res, 200, { px: b?.px || null, how: b?.how || null, at: b?.at || null });
    }
    if (p.startsWith('/api/mcc/live')) return await handleLive(req, res, url, p.slice(8), LIVE.mcc);
    if (p === '/api/mcc/paper') return sendJson(res, 200, { ...mccPaper.state(), demo: DEMO });
    if (p.startsWith('/api/mcc/paper/') && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
      if (p === '/api/mcc/paper/start') {
        if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the paper trade follows the live chain`);
        await mccPaper.start(b.params || {});
      } else if (p === '/api/mcc/paper/pause') mccPaper.pause();
      else if (p === '/api/mcc/paper/resume') await mccPaper.resume();
      else if (p === '/api/mcc/paper/budget') await mccPaper.setBudget(b.budget);
      else if (p === '/api/mcc/paper/reset') {
        if (b.confirm !== true) throw new Error('Resetting deletes the paper trade: it needs confirmation');
        mccPaper.reset();
      } else return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, { ...mccPaper.state(), demo: DEMO });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('mcc', e);
    return sendJson(res, 400, { error: e.message });
  }
}

// ---------- Trading Ideas › Put spread collar (bt/psc.js on bt/mcc.js's runner, mccpaper.js with engine) ----------
// NIFTYBEES + a sold call (ATM + 100) + a put spread (ATM − 100 / − 200). Same jobs, files and paper trade as the
// Covered call, kept apart: bt-data/psc-backtest.json, psc-study.json, psc-paper(-demo).json. No orders.
const PSC_FILES = { backtest: path.join(__dirname, 'bt-data', 'psc-backtest.json'), study: path.join(__dirname, 'bt-data', 'psc-study.json') };
const pscPaper = createMccPaper({
  file: path.join(__dirname, 'bt-data', DEMO ? 'psc-paper-demo.json' : 'psc-paper.json'),
  demo: DEMO,
  isMarketOpen: () => DEMO || isMarketOpen(),
  getExpiries,
  getChain: (expiry) => restChain(expiry, 30_000),
  closeOf: async (day) => {
    await backtester.data.loadIndex(day, day);
    const a = backtester.data.spotDay(day);
    return a ? a[a.length - 1] : null;
  },
  beesPrice: ccBeesPrice,
  getLot: () => contracts.lot,
  logError,
  engine: psc,
  tag: 'psc-paper',
});
setInterval(() => {
  if (liveLoggedIn()) pscPaper.tick();
}, 30_000);
// Its Live trade tab (handleLive): a saved Builder trade (marked Put spread collar, or one shaped like it) or the paper
// trade's series; its own settings in bt-data/psc-live.json.
LIVE.psc = {
  kind: 'psc',
  name: 'Put spread collar',
  file: path.join(__dirname, 'bt-data', DEMO ? 'psc-live-demo.json' : 'psc-live.json'),
  paper: () => pscPaper,
  looks: mccLive.looksPsc,
  strict: true,
  studyFile: () => PSC_FILES.study,
  defaults: psc.DEFAULTS,
  // the strikes at the page's settings (b.params: the Backtest tab's distances and lots), else the defaults
  plan(S, strikes, ltp, lot, b) {
    const prm = psc.merge({ ...(b.params || {}), lotSize: lot });
    const pick = psc.pickLegs(S, prm, strikes);
    return { prm, pick, shapeText: `call ATM+${prm.ce.sellOff}, put spread ATM−${prm.pe.buyOff}/−${prm.pe.buyOff + prm.pe.sellGap}` };
  },
};
const pscJobs = new Map();
function pscJob(kind, run) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, kind, status: 'running', progress: { phase: 'Starting', done: 0, total: 0 }, startedAt: Date.now() };
  pscJobs.set(id, job);
  while (pscJobs.size > 6) pscJobs.delete(pscJobs.keys().next().value);
  run({ onProgress: (x) => (job.progress = { ...x, api: backtester.data.apiStats() }), stopped: () => Boolean(job.stop) })
    .then((r) => {
      job.result = r;
      job.status = 'done';
      if (!PSC_FILES[kind]) return; // 'run': a study rule opened on the Backtest tab, not kept
      fs.mkdirSync(path.dirname(PSC_FILES[kind]), { recursive: true });
      fs.writeFileSync(PSC_FILES[kind] + '.tmp', JSON.stringify(r));
      fs.renameSync(PSC_FILES[kind] + '.tmp', PSC_FILES[kind]);
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e.message;
      logError('psc-' + kind, e);
    });
  return job;
}
async function handlePsc(req, res, url, p) {
  lastClientAt = Date.now();
  const body = async () => JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}');
  try {
    if (p === '/api/psc/meta') {
      const cal = await backtester.data.expiryCalendar().catch(() => null);
      const monthly = cal ? [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort() : [];
      return sendJson(res, 200, {
        defaults: psc.DEFAULTS,
        study: psc.STUDY.map(([id, label]) => ({ id, label })),
        lot: contracts.lot || psc.DEFAULTS.lotSize,
        monthly,
        demo: DEMO,
      });
    }
    if ((p === '/api/psc/backtest' || p === '/api/psc/study') && req.method !== 'POST') return sendJson(res, 200, { saved: readJson(PSC_FILES[p.slice(9)]) });
    // backtest: the settings and the same without adjustments, saved; run: the same for one study rule, not saved
    if ((p === '/api/psc/backtest' || p === '/api/psc/run') && req.method === 'POST') {
      const b = await body();
      const range = { from: b.from, to: b.to };
      const params = b.params || {};
      const job = pscJob(p.slice(9), async ({ onProgress, stopped }) => {
        const withAdj = await psc.runPsc(backtester.data, params, range, { onProgress: (x) => onProgress({ ...x, phase: 'With adjustments' }), stopped });
        const off = { ...params, adj: { ...(params.adj || {}), on: false }, up: { ...(params.up || {}), mode: 'none' } };
        const without = await psc.runPsc(backtester.data, off, range, { onProgress: (x) => onProgress({ ...x, phase: 'Without adjustments' }), stopped });
        return { at: Date.now(), range, withAdj, without };
      });
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/psc/study' && req.method === 'POST') {
      const b = await body();
      const job = pscJob('study', (o) => psc.runPscStudy(backtester.data, b.params || {}, { from: b.from, to: b.to }, o));
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/psc/job') {
      const job = pscJobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Job not found (the server may have restarted): run it again' });
      return sendJson(res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        result: job.status === 'done' ? job.result : undefined,
      });
    }
    if (p === '/api/psc/job/stop' && req.method === 'POST') {
      const job = pscJobs.get((await body()).id);
      if (job) job.stop = true;
      return sendJson(res, 200, { ok: Boolean(job) });
    }
    if (p === '/api/psc/model' && req.method === 'POST') {
      // Strategy & rules › Month by month: the model path, every month priced by Black-Scholes (nothing saved)
      const b = await body();
      const o = b.opts || {};
      const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
      const opts = {
        S0: clamp(o.S0, 5000, 100000, 24000),
        pct: clamp(o.pct, -60, 100, 10),
        months: Math.round(clamp(o.months, 1, 36, 12)),
        iv: clamp(o.iv, 5, 60, 13),
        swings: o.swings !== false,
      };
      return sendJson(res, 200, psc.runPscModel(b.params || {}, opts));
    }
    if (p.startsWith('/api/psc/live')) return await handleLive(req, res, url, p.slice(8), LIVE.psc);
    if (p === '/api/psc/paper') return sendJson(res, 200, { ...pscPaper.state(), demo: DEMO });
    if (p.startsWith('/api/psc/paper/') && req.method === 'POST') {
      const b = await body();
      if (p === '/api/psc/paper/start') {
        if (!liveLoggedIn()) throw new Error(`Log in to ${useKite() ? 'Kite' : 'Upstox'} first: the paper trade follows the live chain`);
        await pscPaper.start(b.params || {});
      } else if (p === '/api/psc/paper/pause') pscPaper.pause();
      else if (p === '/api/psc/paper/resume') await pscPaper.resume();
      else if (p === '/api/psc/paper/budget') await pscPaper.setBudget(b.budget);
      else if (p === '/api/psc/paper/reset') {
        if (b.confirm !== true) throw new Error('Resetting deletes the paper trade: it needs confirmation');
        pscPaper.reset();
      } else return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, { ...pscPaper.state(), demo: DEMO });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('psc', e);
    return sendJson(res, 400, { error: e.message });
  }
}

// JSON files under bt-data/ (Covered call, Put spread collar, Strategy lab, saved trades)
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}
// ---------- Trading Ideas › Strategy lab (bt/lab.js) ----------
// Any options structure written as legs from ATM, backtested on every monthly (or weekly) series like the Modified
// covered call, and every preset compared on the same series. Jobs the page polls; the last of each is kept in
// bt-data/lab-backtest.json / lab-compare.json. History only: nothing is traded.
const LAB_FILES = { backtest: path.join(__dirname, 'bt-data', 'lab-backtest.json'), compare: path.join(__dirname, 'bt-data', 'lab-compare.json') };
const labJobs = new Map();
function labJob(kind, run, file = LAB_FILES[kind]) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, kind, status: 'running', progress: { phase: 'Starting', done: 0, total: 0 }, startedAt: Date.now() };
  labJobs.set(id, job);
  while (labJobs.size > 6) labJobs.delete(labJobs.keys().next().value);
  run({ onProgress: (x) => (job.progress = { ...x, api: backtester.data.apiStats() }), stopped: () => Boolean(job.stop) })
    .then((r) => {
      job.result = r;
      job.status = 'done';
      if (file) writeJson(file, r);
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e.message;
      logError('lab-' + kind, e);
    });
  return job;
}
async function handleLab(req, res, url, p) {
  lastClientAt = Date.now();
  try {
    const body = async () => (req.method === 'POST' ? JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}') : {});
    if (p === '/api/lab/meta') {
      const cal = await backtester.data.expiryCalendar().catch(() => null);
      const monthly = cal ? [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort() : [];
      return sendJson(res, 200, { presets: lab.PRESETS, defaults: lab.DEFAULTS, lot: contracts.lot || lab.DEFAULTS.lotSize, monthly, demo: DEMO });
    }
    if ((p === '/api/lab/backtest' || p === '/api/lab/compare') && req.method !== 'POST') return sendJson(res, 200, { saved: readJson(LAB_FILES[p.slice(9)]) });
    if (p === '/api/lab/backtest' && req.method === 'POST') {
      const b = await body();
      const job = labJob('backtest', (o) => lab.runLab(backtester.data, b.params || {}, { from: b.from, to: b.to }, o));
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/lab/compare' && req.method === 'POST') {
      const b = await body();
      const job = labJob('compare', (o) => lab.runLabCompare(backtester.data, b.params || {}, { from: b.from, to: b.to }, o));
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/lab/job') {
      const job = labJobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Job not found (the server may have restarted): run it again' });
      return sendJson(res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        result: job.status === 'done' ? job.result : undefined,
      });
    }
    if (p === '/api/lab/job/stop' && req.method === 'POST') {
      const job = labJobs.get((await body()).id);
      if (job) job.stop = true;
      return sendJson(res, 200, { ok: Boolean(job) });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('lab', e);
    return sendJson(res, 500, { error: e.message });
  }
}

// ---------- Trading Ideas › Adjustments (bt/adjust.js, lib/adjladder.js) ----------
// The trade-adjustment rules of Catolico's "Trade adjustment basics" backtested on the option history (a job the page
// polls, the last run kept in bt-data/adj-backtest.json; adj-backtest-demo.json in demo mode), and one series run on
// its own for the animated replay (not saved). History only: nothing is traded.
const ADJ_FILE = path.join(__dirname, 'bt-data', DEMO ? 'adj-backtest-demo.json' : 'adj-backtest.json');
async function handleAdj(req, res, url, p) {
  lastClientAt = Date.now();
  try {
    const body = async () => (req.method === 'POST' ? JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}') : {});
    if (p === '/api/adj/meta') {
      const cal = await backtester.data.expiryCalendar().catch(() => null);
      return sendJson(res, 200, {
        defaults: adjust.DEFAULTS,
        lot: contracts.lot || adjust.DEFAULTS.lotSize,
        expired: cal ? [...cal.expired].sort() : [],
        monthly: cal ? [...cal.monthly].filter((e) => cal.expiredSet.has(e)).sort() : [],
        live: cal ? [...cal.live] : [],
        demo: DEMO,
      });
    }
    if (p === '/api/adj/backtest' && req.method !== 'POST') return sendJson(res, 200, { saved: readJson(ADJ_FILE) });
    if (p === '/api/adj/backtest' && req.method === 'POST') {
      const b = await body();
      const job = labJob('adj', (o) => adjust.runAdjust(backtester.data, b.params || {}, { from: b.from, to: b.to }, o), ADJ_FILE);
      return sendJson(res, 200, { id: job.id, status: job.status });
    }
    if (p === '/api/adj/series' && req.method === 'POST') {
      const b = await body();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiry || '')) return sendJson(res, 400, { error: 'Pick an expiry' });
      const r = await adjust.runAdjust(backtester.data, b.params || {}, { only: b.expiry });
      if (!r.months.length) return sendJson(res, 400, { error: `${b.expiry} is not an expired ${r.params.cycle} expiry with a previous one in the history` });
      return sendJson(res, 200, { params: r.params, month: r.months[0] });
    }
    if (p === '/api/adj/job') {
      const job = labJobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Job not found (the server may have restarted): run it again' });
      return sendJson(res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        result: job.status === 'done' ? job.result : undefined,
      });
    }
    if (p === '/api/adj/job/stop' && req.method === 'POST') {
      const job = labJobs.get((await body()).id);
      if (job) job.stop = true;
      return sendJson(res, 200, { ok: Boolean(job) });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('adj', e);
    return sendJson(res, 500, { error: e.message });
  }
}

async function handleKite(req, res, url, p) {
  try {
    if (p === '/kite/login') {
      if (!kiteSession.configured) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end(
          '<h3>Kite Connect is not set up</h3><p>Click the <b>Kite</b> chip at the top of the page and enter your Kite Connect app API key and API secret (from developers.kite.trade), or put KITE_API_KEY and KITE_API_SECRET in .env and restart the server.</p><a href="/">Back</a>',
        );
      }
      res.writeHead(302, { Location: kiteLoginUrl(kiteSession.apiKey) });
      return res.end();
    }
    if (p === '/kite/callback') {
      const requestToken = url.searchParams.get('request_token');
      if (!requestToken || url.searchParams.get('status') === 'error')
        throw new Error(url.searchParams.get('message') || 'Kite did not return a request token');
      const data = await exchangeRequestToken({ apiKey: kiteSession.apiKey, apiSecret: kiteSession.apiSecret, requestToken });
      kiteSession.set({ mode: 'connect', apiKey: kiteSession.apiKey, accessToken: data.access_token }, data);
      kiteChanged();
      res.writeHead(302, { Location: '/?kite=ok' });
      return res.end();
    }
    if (p === '/api/kite/status') return sendJson(res, 200, kiteStatus(req));
    // The Kite Connect app typed in on the page: api_key + api_secret, kept in .kite-app.json (the secret never comes back).
    if (p === '/api/kite/app' && req.method === 'POST') {
      if (DEMO) throw new Error('Demo mode simulates Kite; run the server without DEMO to set up Kite Connect.');
      const b = JSON.parse((await readBody(req, 5_000)).toString('utf8') || '{}');
      if (b.clear === true) kiteSession.clearApp();
      else kiteSession.setApp(b.apiKey, b.apiSecret);
      return sendJson(res, 200, { ok: true, kite: kiteStatus(req) });
    }
    // Live data from Upstox or from Kite, for every live screen.
    if (p === '/api/kite/source' && req.method === 'POST') {
      if (DEMO) throw new Error('Demo mode serves synthetic data: run the server without DEMO to pick the live source.');
      const b = JSON.parse((await readBody(req, 2_000)).toString('utf8') || '{}');
      if (b.source !== 'upstox' && b.source !== 'kite') throw new Error('source must be upstox or kite');
      setLiveSource(b.source);
      return sendJson(res, 200, { ok: true, kite: kiteStatus(req) });
    }
    // A pasted token, or the enctoken sent by the bookmarklet (kite-link.html): checked with Kite before it is kept.
    if (p === '/api/kite/session' && req.method === 'POST') {
      if (DEMO) throw new Error('Demo mode simulates the Kite feed; run the server without DEMO to log in to Kite.');
      const b = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}');
      let auth;
      if (b.mode === 'enctoken') {
        const enctoken = String(b.enctoken || '').trim();
        const userId = String(b.userId || '')
          .trim()
          .toUpperCase();
        if (!enctoken || !userId) throw new Error('Both the enctoken and your Kite user ID are needed');
        auth = { mode: 'enctoken', enctoken, userId };
      } else {
        const accessToken = String(b.accessToken || '').trim();
        const apiKey = String(b.apiKey || '').trim() || kiteSession.apiKey;
        if (!accessToken || !apiKey) throw new Error('An access token and the Kite Connect api_key (KITE_API_KEY in .env, or typed in) are needed');
        auth = { mode: 'connect', apiKey, accessToken };
      }
      let user;
      try {
        user = await kiteProfile(auth);
      } catch (e) {
        throw new Error('Kite did not accept this token: ' + e.message, { cause: e });
      }
      kiteSession.set(auth, user);
      kiteChanged();
      return sendJson(res, 200, { ok: true, kite: kiteStatus(req) });
    }
    // Live Ideas: what a basket would send (nothing is sent), and the basket itself (needs `confirmed: true`).
    if ((p === '/api/kite/basket/preview' || p === '/api/kite/basket') && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 20_000)).toString('utf8') || '{}');
      return sendJson(res, 200, p === '/api/kite/basket' ? await kiteBasket.place(b) : await kiteBasket.preview(b));
    }
    if (p === '/api/kite/logout' && req.method === 'POST') {
      const was = kiteSession.get();
      kiteSession.clear();
      kiteChanged();
      await kiteInvalidate(was); // a Kite Connect session is ended at Kite too
      return sendJson(res, 200, { ok: true, kite: kiteStatus(req) });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    logError('kite', e);
    if (p.startsWith('/kite/')) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      return res.end(`<h3>Kite login failed</h3><p>${escapeHtml(e.message)}</p><a href="/">Back</a>`);
    }
    return sendJson(res, 400, { error: e.message });
  }
}

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

  // ---- sign-in: the login page and /api/auth/* are open; everything else needs a session (or a Basic header) ----
  if (p === '/api/auth/status') {
    return sendJson(res, 200, { enabled: auth.enabled, authenticated: auth.isAuthed(req), user: auth.enabled ? auth.user : null });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 2_000)).toString('utf8') || '{}');
      const r = auth.login(req, String(b.username ?? ''), String(b.password ?? ''));
      if (!r.ok) return sendJson(res, r.status, { error: r.error });
      res.setHeader('Set-Cookie', r.cookie);
      return sendJson(res, 200, { ok: true, user: auth.user });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.logout(req));
    return sendJson(res, 200, { ok: true });
  }
  if (p === LOGIN_PAGE && req.method === 'GET') return serveStatic(req, res, p);
  if (!auth.isAuthed(req)) {
    // a page asks the browser to sign in; anything else gets a 401 the page's scripts turn into the same redirect
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      res.writeHead(302, { Location: `${LOGIN_PAGE}?next=${encodeURIComponent(req.url)}` });
      return res.end();
    }
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); // no WWW-Authenticate: it would pop the browser's own dialog
    return res.end(JSON.stringify({ error: 'Sign in required', login: LOGIN_PAGE }));
  }

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
    if (!liveLoggedIn()) {
      return sendJson(res, 200, {
        apiVersion: API_VERSION,
        loggedIn: false,
        source: sourceName(),
        configured: useKite() ? kiteSession.configured : Boolean(CFG.apiKey && CFG.apiSecret),
        error: useKite() ? kiteSession.status().error : lastError,
      });
    }
    try {
      const list = await getExpiries();
      const wanted = url.searchParams.get('expiry');
      const expiry = list.includes(wanted) ? wanted : list[0];
      if (!expiry) throw new Error(`No upcoming Nifty expiries returned by ${useKite() ? 'Kite' : 'Upstox'}`);
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
        pulse: pulse.state(),
      });
    } catch (e) {
      lastError = e.message;
      logError('api', e);
      return sendJson(res, 200, { apiVersion: API_VERSION, loggedIn: liveLoggedIn(), source: sourceName(), error: e.message });
    }
  }

  // The streamed chain (REST + ticks, rebuilt every TICK_SNAPSHOT_MS) of any live expiry, for the Builder. Unlike
  // /api/chain it does not change the expiry the Chain screen follows; the expiry is tracked while it is asked for.
  if (p === '/api/live') {
    lastClientAt = Date.now();
    try {
      if (!liveLoggedIn()) throw new Error(`Not logged in to ${useKite() ? 'Kite' : 'Upstox'}`);
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

  if (p.startsWith('/api/mcc/')) return handleMcc(req, res, url, p);

  if (p.startsWith('/api/psc/')) return handlePsc(req, res, url, p);

  if (p.startsWith('/api/lab/')) return handleLab(req, res, url, p);

  if (p.startsWith('/api/adj/')) return handleAdj(req, res, url, p);

  if (p === '/kite/login' || p === '/kite/callback' || p.startsWith('/api/kite/')) return handleKite(req, res, url, p);

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

  // Latest Nifty tick for the chart (Chain screen and its pop-out window). Counts as a browser watching, so the
  // feed keeps running while only the chart window is open.
  if (p === '/api/nifty/ltp') {
    lastClientAt = Date.now();
    const t = feed.tick(NIFTY_KEY);
    const rest = nearestExpiry ? restChains.get(nearestExpiry) : null;
    const at = t?.at ?? rest?.fetchedAt ?? 0;
    return sendJson(res, 200, { ltp: t?.ltp ?? rest?.spot ?? null, at, live: !DEMO && isMarketOpen() && Date.now() - at < 60_000, loggedIn: liveLoggedIn() });
  }

  // The option chart of the Chain screen (the chart button beside each strike): candles and the latest price of one
  // contract of a chain the server holds, named by expiry + strike + CE / PE.
  if (p === '/api/option/candles' || p === '/api/option/ltp') {
    lastClientAt = Date.now();
    const q = url.searchParams;
    const side = restChains.get(q.get('expiry'))?.rows.find((r) => r.strike === Number(q.get('strike')));
    const o = side && (q.get('type') === 'PE' ? side.pe : q.get('type') === 'CE' ? side.ce : null);
    if (!o) return sendJson(res, 404, { error: 'That option is not in the chain any more' });
    const cur = overlay(o, restChains.get(q.get('expiry')).fetchedAt);
    watchKey(o.key);
    if (p === '/api/option/ltp') {
      const fresh = Date.now() - cur.at < 5 * 60_000;
      return sendJson(res, 200, { ltp: cur.ltp, vol: cur.vol ?? null, at: cur.at, live: cur.ltp != null && (DEMO || (isMarketOpen() && fresh)) });
    }
    try {
      const tf = q.get('tf') || '5';
      if (!OPT_TFS.has(tf === 'D' ? 'D' : Number(tf))) throw new Error('Unknown chart timeframe ' + tf);
      const lot = contracts.lot; // the chart shows the volume in lots too
      if (DEMO) return sendJson(res, 200, { ...respond(demoRows(`${q.get('expiry')}${q.get('strike')}${q.get('type')}`, cur.ltp ?? 100), tf), lot });
      if (!o.key) throw new Error('No instrument key for this option');
      if (useKite()) return sendJson(res, 200, { ...(await kiteData.candles(o.key, tf)), lot });
      return sendJson(res, 200, { ...(await optionCandles.candles(o.key, tf)), lot });
    } catch (e) {
      logError('option-chart', e);
      return sendJson(res, 400, { error: e.message });
    }
  }

  // The Nifty future on the chart ("Nifty Fut" beside "Nifty 50"): candles with their volume, and the latest price.
  if (p === '/api/future/candles' || p === '/api/future/ltp') {
    lastClientAt = Date.now();
    try {
      const f = await getFuture();
      watchKey(f.key);
      const q = futureQuote(f);
      const about = { symbol: f.symbol, expiry: f.expiry, lot: f.lot };
      if (p === '/api/future/ltp') {
        const fresh = q.at != null && Date.now() - q.at < 5 * 60_000;
        return sendJson(res, 200, { ...q, ...about, live: q.ltp != null && (DEMO || (isMarketOpen() && fresh)) });
      }
      const tf = url.searchParams.get('tf') || '5';
      if (!OPT_TFS.has(tf === 'D' ? 'D' : Number(tf))) throw new Error('Unknown chart timeframe ' + tf);
      if (DEMO) return sendJson(res, 200, { ...respond(demoRows('NIFTYFUT', q.ltp ?? 24900), tf), ...about });
      return sendJson(res, 200, { ...(await (useKite() ? kiteData : optionCandles).candles(f.key, tf)), ...about });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Every trade of today for the chart's Tick view: Nifty (src=nifty), the Nifty future (src=fut) or one option
  // (src=opt with expiry, strike and type). after + gen = the ticks the chart already holds, so it gets only new ones.
  if (p === '/api/ticks') {
    lastClientAt = Date.now();
    const q = url.searchParams;
    try {
      const src = q.get('src');
      let key = NIFTY_KEY;
      let lot = contracts.lot;
      let symbol = null;
      if (src === 'fut') {
        const f = await getFuture();
        key = f.key;
        lot = f.lot;
        symbol = f.symbol;
        watchKey(key);
      } else if (src === 'opt') {
        const expiry = q.get('expiry');
        const strike = Number(q.get('strike'));
        const type = q.get('type');
        const row = restChains.get(expiry)?.rows.find((r) => r.strike === strike);
        const o = row && (type === 'PE' ? row.pe : type === 'CE' ? row.ce : null);
        if (!o) throw new Error('That option is not in the chain any more');
        key = tickKey(expiry, strike, type, o);
        watchKey(o.key);
      } else if (src !== 'nifty') throw new Error('src must be nifty, fut or opt');
      const live = DEMO || (feed.status().connected && isMarketOpen());
      return sendJson(res, 200, { ...ticks.since(key, Number(q.get('after')), Number(q.get('gen'))), cp: feed.tick(key)?.cp ?? null, lot, symbol, live });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // TradingView Lightweight Charts (candlestick chart), served from node_modules like Chart.js below.
  if (p === '/vendor/lightweight-charts.js') {
    return fs.readFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'), (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'Run npm install' });
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(buf);
    });
  }

  // Option pricing (public/bt-common.js), trading charges (Live Ideas, Covered call, the Kite order dialog) and the
  // back spread picker (public/ideas-view.js) shared with the page: the files the server itself uses.
  if (p === '/lib/pricing.js' || p === '/lib/costs.js' || p === '/lib/backspread.js' || p === '/lib/adjladder.js') {
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
  console.log(
    DEMO ? 'Data source: DEMO (synthetic data, not real prices)' : `Live data source: ${useKite() ? 'Zerodha Kite' : 'Upstox API'} (real market data)`,
  );
  if (!liveLoggedIn()) console.log(`Not logged in yet — open the page and log in to ${useKite() ? 'Kite' : 'Upstox'}.`);
  console.log(auth.enabled ? `Sign-in required (user "${auth.user}")` : 'WARNING: no sign-in. Set AUTH_USERNAME and AUTH_PASSWORD in .env to require one.');
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

// ---------- live data source ----------
function readLiveSource() {
  try {
    const s = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8')).source;
    if (s === 'upstox' || s === 'kite') return s;
  } catch {}
  return env.LIVE_DATA_SOURCE === 'kite' ? 'kite' : 'upstox';
}
function setLiveSource(s) {
  if (s === liveSource) return;
  liveSource = s;
  try {
    fs.mkdirSync(path.dirname(SOURCE_FILE), { recursive: true });
    fs.writeFileSync(SOURCE_FILE, JSON.stringify({ source: s }));
  } catch (e) {
    logError('live-source', e);
  }
  console.log(`Live data source: ${s === 'kite' ? 'Zerodha Kite' : 'Upstox API'}`);
  resetLive();
}
// The chains, contracts and future of one source mean nothing to the other (different instrument keys): start again.
// The per-strike history (volume windows, signals) carries on, as both read the exchange's own figures.
function resetLive() {
  restChains.clear();
  snapshots.clear();
  contracts = { expiries: [], lot: contracts.lot, fetchedAt: 0 };
  future = null;
  futureRetryAt = 0;
  chartKeys.clear();
  lastError = null;
  updateSubscriptions();
  restLoop();
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
const demo = { spot: 24812, vols: {}, tick: 0, burstEvery: num(env.DEMO_BURST_EVERY, 100), tv: 1, futVol: 1_500_000 };
function demoData(pathname) {
  if (pathname === '/instruments/search') {
    const expiry = demoFutureExpiry();
    const d = new Date(expiry + 'T00:00:00Z');
    const mon = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    const symbol = `NIFTY FUT ${String(d.getUTCDate()).padStart(2, '0')} ${mon} ${String(d.getUTCFullYear()).slice(2)}`;
    return [{ instrument_key: 'NSE_FO|DEMOFUT', trading_symbol: symbol, expiry, instrument_type: 'FUT', underlying_key: NIFTY_KEY, lot_size: 65 }];
  }
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

// Latest price, the day's volume and the previous close of the Nifty future: from the tick feed (the demo's own walk in
// demo mode). Without ticks (market shut, feed not up yet) the price is null and the chart shows the last candle.
function futureQuote(f) {
  if (DEMO) return { ltp: demoFuture(), vol: demo.futVol, cp: null, at: Date.now() };
  const t = feed.tick(f.key);
  return { ltp: t?.ltp ?? null, vol: t?.vol ?? null, cp: t?.cp ?? null, at: t?.at ?? null };
}

// The demo future: Nifty plus about 6.5 % a year of carry to the last Tuesday of the month.
function demoFutureExpiry(now = Date.now()) {
  const d = new Date(now + 19800_000);
  for (let add = 0; add < 3; add++) {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add + 1, 0));
    last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() + 5) % 7)); // back to Tuesday
    const day = last.toISOString().slice(0, 10);
    if (day >= istDate(now)) return day;
  }
  return istDate(now);
}
function demoFuture() {
  const days = Math.max(0, (Date.parse(demoFutureExpiry() + 'T10:00:00Z') - Date.now()) / 86400_000);
  return Math.round((demo.spot * (1 + (0.065 * days) / 365) + (Math.random() - 0.5) * 2) * 20) / 20;
}

// Demo mode has no tick feed: each poll's prices go into the tick store instead, so the Tick view has something to draw.
function recordDemoTicks() {
  const now = Date.now();
  for (const e of targetExpiries()) {
    for (const r of snapshots.get(e)?.rows || []) {
      ticks.record(tickKey(e, r.strike, 'CE', r.ce), now, r.ce.ltp, r.ce.vol);
      ticks.record(tickKey(e, r.strike, 'PE', r.pe), now, r.pe.ltp, r.pe.vol);
    }
  }
  ticks.record(NIFTY_KEY, now, Math.round(demo.spot * 100) / 100, null);
  if (future) {
    demo.futVol += 65 * Math.round(Math.random() * Math.random() * 6); // about the demo candles' volume per minute
    ticks.record(future.key, now, demoFuture(), demo.futVol);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
