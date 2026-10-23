// Zerodha Kite as the live data source of the whole app (the "Live data: Kite" switch). The server's live code was
// written against Upstox, so this module answers in Upstox's shapes and the rest of the app does not need to know which
// broker the prices came from:
//   call(path, params)   the Upstox REST calls the server makes (/option/contract, /option/chain,
//                        /instruments/search, /market-quote/ltp), answered from Kite's instrument list and quotes
//   createFeed(opts)     the tick feed with the interface of feed.js (Kite's binary WebSocket underneath)
//   candles(key, tf)     an option's / the future's 1-minute candles for the chart (Kite historical data)
//   niftyIntraday()      today's 1-minute Nifty candles (the Nifty chart's running session)
//   symbolFor(...)       the Kite tradingsymbol of a Nifty option (orders)
// Kite gives no option greeks and no previous day's OI: IV and greeks are worked out here (Black-76 on the forward
// implied by put-call parity), and the previous OI comes from Kite's daily candles (needs historical data access; without
// it the OI change reads against zero, as Upstox's chain does when it has no previous OI).
// Instrument keys of Kite contracts look like "KITE|<instrument_token>"; Nifty keeps Upstox's "NSE_INDEX|Nifty 50".
const fs = require('fs');
const KiteApi = require('./kite');
const { respond } = require('./optcandles');
const { b76iv, ncdf, RATE } = require('./pricing');
const { istDate } = require('./time');

const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
// Upstox keys the server asks quotes of, and the same instrument on Kite
const KITE_SYMBOL = { [NIFTY_KEY]: 'NSE:NIFTY 50', 'NSE_EQ|INF204KB14I2': 'NSE:NIFTYBEES' };
const QUOTE_GAP_MS = 1050; // Kite: one quote request a second
const HIST_GAP_MS = 350; // Kite: three historical requests a second
const HISTORY_DAYS = 28;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const kiteKey = (token) => `KITE|${token}`;
const tokenOf = (key) => (key === NIFTY_KEY ? KiteApi.NIFTY_TOKEN : /^KITE\|\d+$/.test(key || '') ? Number(key.slice(5)) : null);
const npdf = (x) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

// Years from now to 15:30 IST on the expiry day.
const yearsTo = (expiry, now) => Math.max(60_000, Date.parse(expiry + 'T15:30:00+05:30') - now) / (365 * 86400_000);

// Upstox-style greeks of one option from its price: IV in percent, delta, gamma, theta per day, vega per IV point.
function greeks(price, F, K, T, call, df) {
  const v = price > 0 ? b76iv(price, F, K, T, call, df) : null;
  if (!v) return { iv: null, delta: null, gamma: null, theta: null, vega: null };
  const S = F * df; // the spot the forward implies
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (sq * sq) / 2) / sq;
  const d2 = d1 - sq;
  const decay = (-S * npdf(d1) * v) / (2 * Math.sqrt(T));
  const carry = RATE * K * df * (call ? -ncdf(d2) : ncdf(-d2));
  return {
    iv: Math.round(v * 10000) / 100,
    delta: Math.round((call ? ncdf(d1) : ncdf(d1) - 1) * 10000) / 10000,
    gamma: Math.round((npdf(d1) / (S * sq)) * 1e6) / 1e6,
    theta: Math.round(((decay + carry) / 365) * 100) / 100,
    vega: Math.round(((S * npdf(d1) * Math.sqrt(T)) / 100) * 100) / 100,
  };
}

// The forward from put-call parity at the strikes nearest the spot (the median of up to three), or the spot carried at
// the risk-free rate when the quotes do not allow it. A parity forward more than 0.25 % off the carried spot comes from a
// stale or one-sided quote and is not used.
function impliedForward(rows, spot, df) {
  const carried = spot / df;
  const px = (q) => (q?.bid > 0 && q?.ask > 0 ? (q.bid + q.ask) / 2 : q?.ltp > 0 ? q.ltp : null);
  const near = rows
    .filter((r) => px(r.ce) != null && px(r.pe) != null)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 3)
    .map((r) => r.strike + (px(r.ce) - px(r.pe)) / df)
    .filter((f) => Math.abs(f / carried - 1) < 0.0025)
    .sort((a, b) => a - b);
  return near.length ? near[Math.floor(near.length / 2)] : carried;
}

// One side of the chain row in Upstox's /option/chain shape, from a Kite full quote.
function sideOf(inst, q, prevOi) {
  const bid = q?.depth?.buy?.[0];
  const ask = q?.depth?.sell?.[0];
  return {
    instrument_key: kiteKey(inst.token),
    trading_symbol: inst.symbol,
    market_data: {
      ltp: q?.last_price ?? null,
      close_price: q?.ohlc?.close ?? null,
      volume: q?.volume ?? 0,
      oi: q?.oi ?? 0,
      prev_oi: prevOi ?? 0,
      bid_price: bid?.price > 0 ? bid.price : null,
      ask_price: ask?.price > 0 ? ask.price : null,
      bid_qty: bid?.price > 0 ? bid.quantity : 0,
      ask_qty: ask?.price > 0 ? ask.quantity : 0,
    },
    option_greeks: {},
  };
}

// The /option/chain reply (Upstox's shape: [{ strike_price, underlying_spot_price, call_options, put_options }]) from
// the expiry's instruments and their quotes; prevOi(symbol) -> the previous session's OI or null.
function buildChain({ expiry, options, quote, spot, prevOi = () => null, now = Date.now() }) {
  const strikes = new Map();
  for (const o of options.values()) {
    if (o.expiry !== expiry) continue;
    if (!strikes.has(o.strike)) strikes.set(o.strike, {});
    strikes.get(o.strike)[o.type] = o;
  }
  const rows = [...strikes.entries()]
    .filter(([, s]) => s.CE && s.PE)
    .sort((a, b) => a[0] - b[0])
    .map(([strike, s]) => ({
      strike,
      CE: s.CE,
      PE: s.PE,
      ce: sideOf(s.CE, quote[`NFO:${s.CE.symbol}`], prevOi(s.CE.symbol)),
      pe: sideOf(s.PE, quote[`NFO:${s.PE.symbol}`], prevOi(s.PE.symbol)),
    }));
  const T = yearsTo(expiry, now);
  const df = Math.exp(-RATE * T);
  const flat = rows.map((r) => ({
    strike: r.strike,
    ce: { ltp: r.ce.market_data.ltp, bid: r.ce.market_data.bid_price, ask: r.ce.market_data.ask_price },
    pe: { ltp: r.pe.market_data.ltp, bid: r.pe.market_data.bid_price, ask: r.pe.market_data.ask_price },
  }));
  const F = spot > 0 ? impliedForward(flat, spot, df) : null;
  for (const [i, r] of rows.entries()) {
    if (!F) break;
    // the IV of the mid where the quote is two-sided, else of the last trade
    const price = (q) => (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.ltp);
    r.ce.option_greeks = greeks(price(flat[i].ce), F, r.strike, T, true, df);
    r.pe.option_greeks = greeks(price(flat[i].pe), F, r.strike, T, false, df);
  }
  return rows.map((r) => ({ expiry, strike_price: r.strike, underlying_spot_price: spot, call_options: r.ce, put_options: r.pe }));
}

// onAuthError(e): Kite refused the token (TokenException): the server drops the login so the page asks for a new one.
function createKiteData({ getAuth, logError = () => {}, onAuthError = () => {}, prevOiFile = null, now = Date.now, api = KiteApi }) {
  let inst = null; // { day, mode, options, futures, lot, byToken }
  let instPromise = null;
  let instRetryAt = 0;
  let instError = null;
  let quoteChain = Promise.resolve();
  let lastQuoteAt = 0;
  let histChain = Promise.resolve();
  let lastHistAt = 0;

  const auth = () => {
    const a = getAuth();
    if (!a) throw new Error('Not logged in to Kite');
    return a;
  };
  // Quotes need the official Kite Connect API: Kite's web session (enctoken) has no quote endpoint.
  const connectAuth = () => {
    const a = auth();
    if (a.mode === 'enctoken')
      throw new Error(
        'Kite live data needs a Kite Connect login: the Kite web session (enctoken) has no quote API. Enter your Kite Connect API key and secret under the Kite chip, then press Login with Kite.',
      );
    return a;
  };
  async function quotes(list, kind) {
    const a = connectAuth();
    try {
      return await api.quotes(a, list, kind, paceQuote);
    } catch (e) {
      if (e instanceof KiteApi.KiteError && e.tokenProblem) onAuthError(e);
      throw e;
    }
  }
  // Serialised so concurrent callers keep to Kite's rate limits.
  const paceQuote = () =>
    (quoteChain = quoteChain.then(async () => {
      const wait = lastQuoteAt + QUOTE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastQuoteAt = Date.now();
    }));
  const paceHist = () =>
    (histChain = histChain.then(async () => {
      const wait = lastHistAt + HIST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastHistAt = Date.now();
    }));

  // The Nifty instruments of the day (Kite rebuilds the list every morning; tokens of expired contracts get reused).
  async function instruments() {
    const a = auth();
    const day = KiteApi.kiteDay(now());
    if (inst && inst.day === day && inst.mode === a.mode) return inst;
    if (Date.now() < instRetryAt) throw new Error(instError);
    if (!instPromise) {
      instPromise = (async () => {
        try {
          const { options, futures } = api.parseNiftyNfo(await api.nfoCsv(a));
          if (!options.size) throw new Error('No Nifty options in the Kite instrument list');
          const byToken = new Map();
          for (const o of options.values()) byToken.set(o.token, o);
          for (const f of futures) byToken.set(f.token, { ...f, type: 'FUT' });
          const lot = [...options.values()].find((o) => o.lot > 0)?.lot || null;
          inst = { day, mode: a.mode, options, futures, lot, byToken };
          instError = null;
          return inst;
        } catch (e) {
          instError = e.message;
          instRetryAt = Date.now() + 60_000;
          logError('kite-instruments', e);
          throw e;
        } finally {
          instPromise = null;
        }
      })();
    }
    return instPromise;
  }

  // ---------- previous session's OI (Kite's daily candles with OI) ----------
  let prev = { day: null, oi: {}, tried: new Set(), unavailable: null };
  try {
    const saved = prevOiFile && JSON.parse(fs.readFileSync(prevOiFile, 'utf8'));
    if (saved?.day === istDate(now())) prev = { day: saved.day, oi: saved.oi || {}, tried: new Set(), unavailable: null };
  } catch {}
  const prevOiOf = (symbol) => (prev.day === istDate(now()) ? (prev.oi[symbol] ?? null) : null);
  // Reads the previous session's OI of every contract of an expiry once a day, in the background.
  function fillPrevOi(expiry, I) {
    const today = istDate(now());
    if (prev.day !== today) prev = { day: today, oi: {}, tried: new Set(), unavailable: null };
    if (prev.tried.has(expiry) || prev.unavailable) return;
    prev.tried.add(expiry);
    const list = [...I.options.values()].filter((o) => o.expiry === expiry && prev.oi[o.symbol] == null);
    (async () => {
      // the session running today (or over) has a candle of its own only from 09:15 on a weekday
      const ist = new Date(now() + 19800_000);
      const sessionToday = ist.getUTCDay() >= 1 && ist.getUTCDay() <= 5 && ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 555;
      let done = 0;
      for (const o of list) {
        try {
          await paceHist();
          const rows = await api.historical(auth(), o.token, 'day', `${addDays(today, -12)} 00:00:00`, `${today} 23:59:59`, { oi: true });
          const last = rows[rows.length - 1];
          // the latest session is the current one; the OI before it is the previous session's
          const before = last && String(last[0]).slice(0, 10) < today && sessionToday ? last : rows[rows.length - 2];
          prev.oi[o.symbol] = before?.[6] ?? 0;
          done++;
        } catch (e) {
          if (e instanceof KiteApi.KiteError && (e.status === 403 || /permission|subscri|historical/i.test(e.message))) {
            prev.unavailable = e.message;
            logError('kite-prev-oi', 'Kite historical data is not available on this login: no previous-day OI (' + e.message + ')');
            break;
          }
          logError('kite-prev-oi', e);
        }
      }
      if (done && prevOiFile) {
        try {
          fs.writeFileSync(prevOiFile, JSON.stringify({ day: prev.day, oi: prev.oi }));
        } catch (e) {
          logError('kite-prev-oi', e);
        }
      }
    })();
  }

  // ---------- the Upstox calls, answered from Kite ----------
  async function call(pathname, params = {}) {
    if (pathname === '/option/contract') {
      const I = await instruments();
      const today = istDate(now());
      const exps = [...new Set([...I.options.values()].map((o) => o.expiry))].filter((e) => e >= today).sort();
      return exps.map((expiry) => ({ expiry, lot_size: I.lot, instrument_type: 'CE', underlying_key: NIFTY_KEY }));
    }
    if (pathname === '/instruments/search') {
      const I = await instruments();
      return I.futures.map((f) => ({
        instrument_key: kiteKey(f.token),
        trading_symbol: f.symbol,
        expiry: f.expiry,
        instrument_type: 'FUT',
        underlying_key: NIFTY_KEY,
        lot_size: f.lot || I.lot,
      }));
    }
    if (pathname === '/option/chain') {
      const expiry = params.expiry_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry || '')) throw new Error('No expiry asked for');
      connectAuth();
      const I = await instruments();
      const list = [...I.options.values()].filter((o) => o.expiry === expiry);
      if (!list.length) throw new Error(`Kite lists no Nifty options expiring ${expiry}`);
      const q = await quotes(['NSE:NIFTY 50', ...list.map((o) => `NFO:${o.symbol}`)], 'quote');
      fillPrevOi(expiry, I);
      return buildChain({ expiry, options: I.options, quote: q, spot: q['NSE:NIFTY 50']?.last_price ?? null, prevOi: prevOiOf, now: now() });
    }
    if (pathname === '/market-quote/ltp') {
      const keys = String(params.instrument_key || '')
        .split(',')
        .filter(Boolean);
      const sym = keys.map((k) => KITE_SYMBOL[k] || null);
      if (sym.some((s) => !s)) throw new Error('No Kite instrument for ' + keys.filter((k, i) => !sym[i]).join(', '));
      const q = await quotes(sym, 'ltp');
      return Object.fromEntries(keys.map((k, i) => [k, { instrument_token: k, last_price: q[sym[i]]?.last_price ?? null }]));
    }
    throw new Error(`Kite data has no answer for ${pathname}`);
  }

  async function symbolFor(expiry, strike, type) {
    try {
      return (await instruments()).options.get(`${expiry}|${Number(strike)}|${type}`)?.symbol || null;
    } catch {
      return null;
    }
  }

  // ---------- candles (the option / future chart, today's Nifty) ----------
  const hist = new Map(); // key -> { at, rows }
  const todayRows = new Map();
  const ts = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const istNow = () => new Date(now() + 19800_000);
  const rowsOf = (list) => (list || []).map((c) => [String(c[0]).slice(0, 19) + '+05:30', c[1], c[2], c[3], c[4], c[5] || 0]);
  async function minutes(token, from, to) {
    await paceHist();
    return rowsOf(await api.historical(auth(), token, 'minute', from, to));
  }
  async function candles(key, tf) {
    const token = tokenOf(key);
    if (token == null) throw new Error('Not a Kite instrument: ' + key);
    const today = istDate(now());
    let h = hist.get(key);
    if (!h || Date.now() - h.at > 30 * 60_000) {
      let rows = [];
      try {
        rows = await minutes(token, `${addDays(today, -HISTORY_DAYS)} 09:15:00`, `${addDays(today, -1)} 23:59:59`);
      } catch (e) {
        if (e instanceof KiteApi.KiteError && e.status === 403)
          throw new Error('Kite historical data is not available on this login: ' + e.message, { cause: e });
      }
      h = { at: Date.now(), rows };
      hist.set(key, h);
    }
    let t = todayRows.get(key);
    if (!t || Date.now() - t.at > 15_000) {
      t = { at: Date.now(), rows: await minutes(token, `${today} 09:15:00`, ts(istNow())).catch(() => []) };
      todayRows.set(key, t);
    }
    return respond(h.rows.filter((r) => r[0].slice(0, 10) < today).concat(t.rows.filter((r) => r[0].slice(0, 10) === today)), tf);
  }
  // Today's 1-minute Nifty candles [timestamp, open, high, low, close], oldest first.
  let nifty = { at: 0, rows: [] };
  async function niftyIntraday() {
    if (Date.now() - nifty.at < 20_000) return nifty.rows;
    const today = istDate(now());
    const rows = await minutes(KiteApi.NIFTY_TOKEN, `${today} 09:15:00`, ts(istNow()));
    nifty = { at: Date.now(), rows: rows.map((r) => r.slice(0, 5)) };
    return nifty.rows;
  }

  // ---------- the tick feed, as feed.js ----------
  function createFeed({ onTick, onAuthFail } = {}) {
    const ticks = new Map(); // key -> { ltp, cp, vol, oi, bid, ask, bidQ, askQ, tbq, tsq, buy, sell, ltt, at }
    const keyOf = new Map(); // token -> key
    let version = 0;
    const ticker = api.createKiteTicker({
      getAuth,
      logError,
      onAuthFail,
      onTicks(tokens, at) {
        const keys = [];
        for (const tok of tokens) {
          const key = keyOf.get(tok);
          const k = key && ticker.tick(tok);
          if (!k) continue;
          const t = ticks.get(key) || { buy: 0, sell: 0 };
          if (k.vol != null) classify(t, k.vol, k.ltp);
          t.ltp = k.ltp;
          if (k.close != null) t.cp = k.close;
          if (k.ltt) t.ltt = k.ltt;
          if (k.vol != null) t.vol = k.vol;
          if (k.oi != null) t.oi = k.oi;
          if (k.bid !== undefined) {
            t.bid = k.bid;
            t.ask = k.ask;
            t.bidQ = k.bidQ ?? 0;
            t.askQ = k.askQ ?? 0;
          }
          if (k.tbq != null) t.tbq = k.tbq;
          if (k.tsq != null) t.tsq = k.tsq;
          t.at = at;
          ticks.set(key, t);
          keys.push(key);
        }
        if (!keys.length) return;
        version++;
        onTick?.(keys, at);
      },
    });
    // As feed.js: new volume is buyer- or seller-initiated by where the trade printed against the quote before it.
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
    return {
      setEnabled: (on) => ticker.setEnabled(on),
      restart: () => {
        ticks.clear();
        ticker.restart();
      },
      setSubscriptions(keys) {
        keyOf.clear();
        for (const k of keys) {
          const tok = tokenOf(k);
          if (tok != null) keyOf.set(tok, k);
        }
        const wanted = new Set(keyOf.values());
        for (const k of ticks.keys()) if (!wanted.has(k)) ticks.delete(k);
        ticker.setSubscriptions([...keyOf.keys()]);
      },
      tick: (key) => ticks.get(key),
      get version() {
        return version;
      },
      status: () => {
        const s = ticker.status();
        return { connected: s.connected, enabled: s.enabled, instruments: s.instruments, lastTickAt: s.lastTickAt, error: s.error, source: 'kite' };
      },
    };
  }

  return {
    call,
    symbolFor,
    candles,
    niftyIntraday,
    createFeed,
    instruments,
    status: () => ({
      instruments: inst ? inst.options.size : 0,
      instrumentsError: instError,
      prevOi: prev.unavailable ? 'unavailable: ' + prev.unavailable : Object.keys(prev.oi).length,
    }),
  };
}

module.exports = { createKiteData, buildChain, greeks, impliedForward, tokenOf, kiteKey, NIFTY_KEY, KITE_SYMBOL };
