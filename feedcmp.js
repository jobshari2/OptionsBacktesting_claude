// Feed compare (Live › Feeds screen): the same Nifty options streamed by Upstox and by Zerodha Kite, tick by tick.
// Whenever the two show different prices for an instrument an "episode" opens; it closes when they agree again.
// Each episode records when it started, how long it lasted, which feed changed first (the lead) and which one
// changed later to match it (or whether the lead went back, i.e. the other feed never showed that price).
// Episodes are appended to <events dir>/<date>/feedcmp.jsonl, one JSON object per line:
//   { s, e: start / end (ms), x: expiry, i: instrument ("24800CE" | "NIFTY"), f: field (ltp | bid | ask),
//     l: lead feed (u = Upstox, k = Kite), b: feed whose tick closed it ("-" = cut short), h: how it ended,
//     u0, k0: the two prices when it opened, v: the price they agreed on, m: largest gap, lag, n: ticks during }
// how: follow = the other feed moved to the lead's price (lag = ms since the lead showed that price)
//      revert = the lead went back without the other feed ever showing its price
//      cross  = both moved while apart and met elsewhere
//      cut    = a feed dropped, the instrument left the watch list or the session ended
const fs = require('fs');
const path = require('path');
const { istDate } = require('./lib/time');
const { NIFTY_TOKEN, kiteDay, niftyInstruments, createKiteTicker, profile } = require('./lib/kite');
const { createFeedPaper, cleanPaper, summarizePaper, PAPER_DEFAULTS } = require('./feedpaper');
const { createLiveTrader, cleanLive, summarizeLive, LIVE_DEFAULTS } = require('./feedlive');

const FIELDS = ['ltp', 'bid', 'ask'];
const SAME = 0.004; // prices are in 0.05 steps; anything closer than half a paisa is the same price
const LAG_BUCKETS = [50, 100, 250, 500, 1000, 5000, Infinity];
const LAG_LABELS = ['<50ms', '50–100ms', '100–250ms', '250–500ms', '0.5–1s', '1–5s', '>5s'];
const MAX_EPISODES = 400_000; // kept in memory for today (oldest dropped beyond that; the log keeps all)
const UPSTOX_NIFTY = 'NSE_INDEX|Nifty 50';

const same = (a, b) => Math.abs(a - b) < SAME;
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ---------- the engine: pure, fed with (feed, instrument, prices, arrival time) ----------
function createComparer({ fields = ['ltp'], onEpisode = () => {} } = {}) {
  let watch = new Set(fields);
  const inst = new Map(); // id -> { v: { u: {f: price}, k }, at: { u: {f: ms}, k }, open: { f: episode } }
  const slot = (id) => {
    let s = inst.get(id);
    if (!s) inst.set(id, (s = { v: { u: {}, k: {} }, at: { u: {}, k: {} }, open: {} }));
    return s;
  };

  function finish(id, s, f, at, by) {
    const ep = s.open[f];
    delete s.open[f];
    let how = 'cut';
    let lag = null;
    if (by !== '-') {
      if (by !== ep.l) {
        how = 'follow';
        lag = at - s.at[ep.l][f];
      } else how = ep.otherMoved ? 'cross' : 'revert';
    }
    onEpisode({
      s: ep.s,
      e: at,
      i: id,
      f,
      l: ep.l,
      b: by,
      h: how,
      u0: ep.u0,
      k0: ep.k0,
      v: how === 'cut' ? null : r2(s.v.u[f]),
      m: r2(ep.m),
      lag,
      n: ep.n,
    });
  }

  return {
    // A tick from feed src ('u' | 'k'): only prices that changed since that feed's last tick count.
    tick(src, id, vals, at) {
      if (!vals) return;
      const s = slot(id);
      const other = src === 'u' ? 'k' : 'u';
      for (const f of watch) {
        const v = vals[f];
        if (v == null || !(v > 0)) continue;
        const prev = s.v[src][f];
        if (prev != null && same(prev, v)) continue;
        s.v[src][f] = v;
        s.at[src][f] = at;
        const o = s.v[other][f];
        if (o == null) continue;
        const ep = s.open[f];
        if (!same(v, o)) {
          if (!ep) s.open[f] = { s: at, l: src, u0: r2(s.v.u[f]), k0: r2(s.v.k[f]), m: Math.abs(v - o), n: 1, otherMoved: false };
          else {
            ep.m = Math.max(ep.m, Math.abs(v - o));
            ep.n++;
            if (src !== ep.l) ep.otherMoved = true;
          }
        } else if (ep) {
          ep.n++;
          finish(id, s, f, at, src);
        }
      }
    },
    // A feed went down: what it showed is no longer current, so every open gap is cut and its prices forgotten.
    reset(src, at) {
      for (const [id, s] of inst) {
        for (const f of Object.keys(s.open)) finish(id, s, f, at, '-');
        s.v[src] = {};
        s.at[src] = {};
      }
    },
    drop(id, at) {
      const s = inst.get(id);
      if (!s) return;
      for (const f of Object.keys(s.open)) finish(id, s, f, at, '-');
      inst.delete(id);
    },
    dropAll(at) {
      for (const id of [...inst.keys()]) this.drop(id, at);
    },
    setFields(list, at) {
      watch = new Set(list);
      for (const [id, s] of inst) for (const f of Object.keys(s.open)) if (!watch.has(f)) finish(id, s, f, at, '-');
    },
    view(id) {
      const s = inst.get(id);
      if (!s) return null;
      const open = {};
      for (const [f, ep] of Object.entries(s.open)) open[f] = { s: ep.s, l: ep.l, m: r2(ep.m), u0: ep.u0, k0: ep.k0 };
      return { u: { ...s.v.u }, uAt: { ...s.at.u }, k: { ...s.v.k }, kAt: { ...s.at.k }, open };
    },
    // Both LTPs and the feed that moved first while they differ (null when they agree).
    ltpGap(id) {
      const s = inst.get(id);
      const ep = s?.open.ltp;
      return ep ? { u: s.v.u.ltp, k: s.v.k.ltp, l: ep.l } : null;
    },
    openCount: () => [...inst.values()].reduce((n, s) => n + Object.keys(s.open).length, 0),
  };
}

// ---------- summaries ----------
function matches(e, q) {
  return (
    (!q.minMs || e.e - e.s >= q.minMs) &&
    (!q.minDiff || e.m >= q.minDiff - 1e-9) &&
    (!q.field || e.f === q.field) &&
    (!q.inst || e.i === q.inst) &&
    (!q.how || e.h === q.how) &&
    (!q.lead || e.l === q.lead)
  );
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// Who led how often and by how much, overall and per instrument.
function summarize(eps) {
  const side = () => ({ follow: 0, revert: 0, cross: 0, lags: [], hist: LAG_BUCKETS.map(() => 0) });
  const by = { u: side(), k: side() };
  const per = new Map();
  let ms = 0;
  let maxMs = 0;
  let cut = 0;
  for (const e of eps) {
    const d = e.e - e.s;
    ms += d;
    if (d > maxMs) maxMs = d;
    let r = per.get(e.i);
    if (!r) per.set(e.i, (r = { i: e.i, n: 0, ms: 0, maxMs: 0, maxDiff: 0, u: 0, k: 0, revU: 0, revK: 0, lags: [] }));
    r.n++;
    r.ms += d;
    if (d > r.maxMs) r.maxMs = d;
    if (e.m > r.maxDiff) r.maxDiff = e.m;
    if (e.h === 'cut') {
      cut++;
      continue;
    }
    by[e.l][e.h]++;
    if (e.h === 'follow') {
      by[e.l].lags.push(e.lag);
      by[e.l].hist[LAG_BUCKETS.findIndex((b) => e.lag < b)]++;
      r[e.l]++;
      r.lags.push(e.lag);
    } else if (e.h === 'revert') r[e.l === 'u' ? 'revU' : 'revK']++;
  }
  const lagStats = (lags) => {
    const s = Float64Array.from(lags).sort();
    return {
      med: quantile(s, 0.5),
      p90: quantile(s, 0.9),
      avg: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
      max: s.length ? s[s.length - 1] : null,
    };
  };
  const fin = (o) => {
    const { lags, ...rest } = o;
    return { ...rest, ...lagStats(lags) };
  };
  return {
    count: eps.length,
    ms,
    maxMs,
    cut,
    u: fin(by.u),
    k: fin(by.k),
    buckets: LAG_LABELS,
    inst: [...per.values()].map((r) => {
      const { lags, ...rest } = r;
      return { ...rest, med: quantile(Float64Array.from(lags).sort(), 0.5) };
    }),
  };
}

function readDay(dir, day) {
  const file = path.join(dir, day, 'feedcmp.jsonl');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a line cut short by a crash
  }
  return out;
}

function compareDays(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(dir, d, 'feedcmp.jsonl')))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ---------- the live service ----------
const DEFAULTS = { enabled: true, expiry: 'nearest', around: 5, extra: [], fields: ['ltp'], index: true, paper: PAPER_DEFAULTS, live: LIVE_DEFAULTS };

function cleanConfig(c = {}) {
  const fields = Array.isArray(c.fields) ? c.fields.filter((f) => FIELDS.includes(f)) : DEFAULTS.fields;
  return {
    paper: cleanPaper(c.paper),
    live: cleanLive(c.live),
    enabled: c.enabled !== false,
    expiry: /^\d{4}-\d{2}-\d{2}$/.test(c.expiry) ? c.expiry : 'nearest',
    around: Math.min(20, Math.max(0, Math.round(Number(c.around ?? DEFAULTS.around)) || 0)),
    extra: [...new Set((Array.isArray(c.extra) ? c.extra : []).map(Number).filter((k) => Number.isFinite(k) && k > 0))].slice(0, 40).sort((a, b) => a - b),
    fields: fields.length ? fields : ['ltp'],
    index: c.index !== false,
  };
}

// upstox: { getExpiries(), getChain(expiry) -> { spot, rows }, tick(key), status(), getSpot() }
// kite:   the session from lib/kite.js createKiteSession
// allowEnctokenOrders / marketProtection: see feedlive.js (KITE_ORDERS_ENCTOKEN, KITE_MARKET_PROTECTION in .env).
function createFeedCompare({
  dir,
  configFile,
  demo = false,
  isMarketOpen,
  upstox,
  kite,
  getLot = () => 65,
  allowEnctokenOrders = false,
  marketProtection = null,
  logError,
}) {
  let cfg = cleanConfig(DEFAULTS);
  try {
    cfg = cleanConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  } catch {}

  let day = istDate();
  let eps = [];
  try {
    eps = readDay(dir, day);
  } catch (e) {
    logError('feedcmp-seed', e);
  }
  let pending = [];
  let expiry = null;
  let expiries = [];
  let list = []; // [{ id, strike, type, uKey, kToken }]
  let uMap = new Map();
  let kMap = new Map();
  let kiteInst = null; // { day, mode, map }
  let kiteInstError = null;
  let kiteInstRetryAt = 0;
  let lastClientAt = 0;
  let upWas = false;
  let kiteWas = false;
  let lastError = null;

  const comparer = createComparer({
    fields: cfg.fields,
    onEpisode(ep) {
      const d = istDate(ep.s);
      if (d !== day) {
        day = d;
        eps = [];
      }
      const rec = { ...ep, x: ep.i === 'NIFTY' ? null : expiry };
      eps.push(rec);
      if (eps.length > MAX_EPISODES) eps.splice(0, eps.length - MAX_EPISODES);
      pending.push(rec);
    },
  });

  // A tick from either feed: compare it, then let the paper trader look at the gap.
  function onTick(src, id, vals, at) {
    comparer.tick(src, id, vals, at);
    if (id !== 'NIFTY') paper.check(id, expiry, comparer.ltpGap(id), at);
  }

  // Paper trades on big gaps (feedpaper.js), priced from each feed's latest quote of the instrument.
  const demoQ = { u: new Map(), k: new Map() };
  const quotes = (id) => {
    if (demo) return { u: demoQ.u.get(id), k: demoQ.k.get(id) };
    const i = list.find((x) => x.id === id);
    if (!i) return null;
    const pickQ = (t) => (t ? { ltp: t.ltp, bid: t.bid, ask: t.ask, at: t.at } : undefined);
    return { u: pickQ(i.uKey && upstox.tick(i.uKey)), k: pickQ(i.kToken && ticker.tick(i.kToken)) };
  };
  const paper = createFeedPaper({
    dir,
    getConfig: () => cfg.paper,
    quotes,
    getLot,
    onOpen: (t) => live.onOpen(t),
    onClose: (t, reason) => live.onClose(t, reason),
    logError,
  });
  // Live orders on Kite following the paper trades (feedlive.js): off until switched on from the screen.
  const live = createLiveTrader({
    getConfig: () => cfg.live,
    getAuth: kite.get,
    getSymbol: (id) => list.find((i) => i.id === id)?.kSymbol || null,
    getTestSymbol: (type) => {
      const i = list.find((x) => x.atm && x.type === type);
      return i?.kSymbol ? { id: i.id, symbol: i.kSymbol } : null;
    },
    getLot,
    isMarketOpen,
    onChange: (t) => paper.touch(t),
    // the live P&L: Kite's quote of the option, else Upstox's
    getQuote: (id) => {
      const q = quotes(id);
      return q?.k || q?.u || null;
    },
    logError,
    demo,
    allowEnctoken: allowEnctokenOrders,
    marketProtection,
  });
  live.seed(paper.list());
  setInterval(() => {
    try {
      paper.tick();
      live.tick();
    } catch (e) {
      logError('feedpaper', e);
    }
  }, 500).unref();

  const ticker = createKiteTicker({
    getAuth: kite.get,
    logError,
    onTicks(tokens, at) {
      for (const t of tokens) {
        const id = kMap.get(t);
        if (id) onTick('k', id, ticker.tick(t), at);
      }
    },
    // Kite refuses the socket: check the token, and drop it if Kite says it is no longer valid.
    async onAuthFail() {
      const auth = kite.get();
      if (!auth) return;
      try {
        await profile(auth);
      } catch (e) {
        if (e.tokenProblem) {
          kite.clear('Kite rejected the token (' + e.message + '). Log in to Kite again.');
          ticker.setEnabled(false);
        }
      }
    },
  });

  // Flush the episode log every 2 s.
  setInterval(() => {
    if (!pending.length) return;
    const byDay = new Map();
    for (const e of pending) {
      const d = istDate(e.s);
      byDay.set(d, (byDay.get(d) || '') + JSON.stringify(e) + '\n');
    }
    pending = [];
    for (const [d, text] of byDay) {
      try {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
        fs.appendFileSync(path.join(dir, d, 'feedcmp.jsonl'), text);
      } catch (e) {
        logError('feedcmp-log', e);
      }
    }
  }, 2000).unref();

  async function kiteTokens(auth) {
    if (demo) return null;
    if (!auth) return null;
    if (kiteInst && kiteInst.day === kiteDay() && kiteInst.mode === auth.mode) return kiteInst.map;
    if (Date.now() < kiteInstRetryAt) return kiteInst?.map || null;
    try {
      kiteInst = { day: kiteDay(), mode: auth.mode, map: await niftyInstruments(auth) };
      kiteInstError = null;
    } catch (e) {
      kiteInstError = e.message;
      kiteInstRetryAt = Date.now() + 60_000;
      logError('kite-instruments', e);
    }
    return kiteInst?.map || null;
  }

  // The watch list: ATM ± around and the extra strikes, calls and puts, plus the index.
  async function rebuild() {
    expiries = await upstox.getExpiries();
    const e = cfg.expiry !== 'nearest' && expiries.includes(cfg.expiry) ? cfg.expiry : expiries[0];
    if (!e) throw new Error('No upcoming Nifty expiries');
    const chain = await upstox.getChain(e);
    if (!chain?.rows?.length) return;
    const tokens = await kiteTokens(kite.get());
    const now = Date.now();
    if (e !== expiry) {
      comparer.dropAll(now); // different contracts: nothing carries over
      expiry = e;
    }
    const spot = upstox.getSpot() ?? chain.spot;
    let atm = 0;
    chain.rows.forEach((r, i) => {
      if (Math.abs(r.strike - spot) < Math.abs(chain.rows[atm].strike - spot)) atm = i;
    });
    const strikes = new Set(chain.rows.slice(Math.max(0, atm - cfg.around), atm + cfg.around + 1).map((r) => r.strike));
    for (const k of cfg.extra) if (chain.rows.some((r) => r.strike === k)) strikes.add(k);
    const next = [];
    if (cfg.index) next.push({ id: 'NIFTY', strike: null, type: 'IDX', uKey: UPSTOX_NIFTY, kToken: NIFTY_TOKEN });
    for (const r of chain.rows) {
      if (!strikes.has(r.strike)) continue;
      for (const [type, o] of [
        ['CE', r.ce],
        ['PE', r.pe],
      ]) {
        const kInfo = tokens?.get(`${e}|${r.strike}|${type}`);
        const kToken = demo ? 900000 + r.strike * 2 + (type === 'PE' ? 1 : 0) : kInfo?.token;
        next.push({
          id: `${r.strike}${type}`,
          strike: r.strike,
          type,
          uKey: o.key || null,
          kToken: kToken || null,
          kSymbol: demo ? `DEMO${r.strike}${type}` : kInfo?.symbol || null,
          atm: r.strike === chain.rows[atm].strike,
          ltp: o.ltp,
        });
      }
    }
    const keep = new Set(next.map((i) => i.id));
    for (const i of list) if (!keep.has(i.id)) comparer.drop(i.id, now);
    list = next;
    uMap = new Map(list.filter((i) => i.uKey).map((i) => [i.uKey, i.id]));
    kMap = new Map(list.filter((i) => i.kToken).map((i) => [i.kToken, i.id]));
  }

  let busy = false;
  async function loop() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const watching = now - lastClientAt < 30_000;
      const want = cfg.enabled && (demo || isMarketOpen() || watching);
      if (want) await rebuild();
      const auth = kite.get();
      ticker.setEnabled(!demo && want && Boolean(auth) && kMap.size > 0);
      ticker.setSubscriptions([...kMap.keys()]);
      demoSim.setEnabled(demo && want);
      // A feed that drops can't be compared: cut what was open and forget its prices.
      const upNow = demo || upstox.status().connected;
      const kiteNow = demo ? want : ticker.status().connected;
      if (upWas && !upNow) comparer.reset('u', now);
      if (kiteWas && !kiteNow) comparer.reset('k', now);
      upWas = upNow;
      kiteWas = kiteNow;
      if (!want && list.length) {
        comparer.dropAll(now);
        list = [];
        uMap = new Map();
        kMap = new Map();
      }
      lastError = null;
    } catch (e) {
      lastError = e.message;
      logError('feedcmp', e);
    } finally {
      busy = false;
    }
  }
  // Demo mode: both feeds are simulated from the demo chain, the lead and the lag picked at random, and now and
  // then one feed skips a price, so the screen has something to show. About once a minute one feed freezes for
  // 10-30 s while prices trend, as Upstox did on 2026-10-14, which opens the big gaps the paper trader acts on.
  const demoSim = (() => {
    let timer = null;
    const px = new Map();
    let stall = null; // { src, until, drift }
    const send = (src, id, vals) => {
      if (stall && stall.src === src && Date.now() < stall.until) return; // frozen: nothing arrives
      const at = Date.now();
      demoQ[src].set(id, { ...vals, at });
      onTick(src, id, vals, at);
    };
    function step() {
      if (!list.length) return;
      if (stall && Date.now() >= stall.until) stall = null;
      if (!stall && Math.random() < 1 / 300)
        stall = { src: Math.random() < 0.5 ? 'u' : 'k', until: Date.now() + 10_000 + Math.random() * 20_000, drift: Math.random() < 0.5 ? 1 : -1 };
      const i = list[Math.floor(Math.random() * list.length)];
      const base = px.get(i.id) ?? (i.id === 'NIFTY' ? upstox.getSpot() || 24800 : i.ltp || 100);
      const trend = stall ? stall.drift * (i.type === 'PE' ? -1 : 1) * 1.5 : 0;
      const p = Math.max(0.05, Math.round((base + trend + (Math.random() - 0.5) * (i.id === 'NIFTY' ? 4 : 1)) * 20) / 20);
      px.set(i.id, p);
      const vals = i.id === 'NIFTY' ? { ltp: p } : { ltp: p, bid: Math.max(0.05, r2(p - 0.05)), ask: r2(p + 0.05) };
      const lead = Math.random() < 0.6 ? 'u' : 'k';
      send(lead, i.id, vals);
      if (Math.random() < 0.04) return; // the other feed never shows this price
      const lag = Math.random() < 0.05 ? 800 + Math.random() * 2500 : 5 + -Math.log(Math.random()) * 80;
      setTimeout(() => send(lead === 'u' ? 'k' : 'u', i.id, vals), lag);
    }
    return {
      setEnabled(on) {
        if (on && !timer) timer = setInterval(step, 120);
        if (!on && timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  })();

  setInterval(loop, 2000).unref();

  function pick(q) {
    const minMs = Math.max(0, Number(q.minMs) || 0);
    const minDiff = Math.max(0, Number(q.minDiff) || 0);
    return {
      minMs,
      minDiff,
      field: FIELDS.includes(q.field) ? q.field : null,
      inst: q.inst || null,
      how: q.how || null,
      lead: q.lead === 'u' || q.lead === 'k' ? q.lead : null,
    };
  }

  let histCache = null; // { day, size, eps }
  function dayEpisodes(d) {
    if (d === day) return eps;
    const file = path.join(dir, d, 'feedcmp.jsonl');
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (histCache?.day !== d || histCache.size !== size) histCache = { day: d, size, eps: readDay(dir, d) };
    return histCache.eps;
  }

  return {
    // Upstox tick feed callback (feed.js onTick): the keys of one message and when it arrived.
    onUpstoxTicks(keys, at) {
      if (demo) return;
      for (const k of keys) {
        const id = uMap.get(k);
        if (id) onTick('u', id, upstox.tick(k), at);
      }
    },
    upstoxKeys: () => [...uMap.keys()],
    get kiteTicker() {
      return ticker;
    },
    restartKite() {
      kiteInst = null;
      kiteInstRetryAt = 0;
      live.setOn(false); // a new or ended login: live trading has to be switched on again
      ticker.restart();
      loop();
    },
    config: () => cfg,
    saveConfig(c) {
      cfg = cleanConfig({ ...cfg, ...c, paper: { ...cfg.paper, ...(c.paper || {}) }, live: { ...cfg.live, ...(c.live || {}) } });
      comparer.setFields(cfg.fields, Date.now());
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
      loop();
      return cfg;
    },
    days: () => {
      const d = compareDays(dir);
      return d.includes(day) ? d : [day, ...d];
    },
    // The screen: live prices of both feeds, the open gaps, and the episodes of a day that pass the filter.
    state(q = {}) {
      lastClientAt = Date.now();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : day;
      const f = pick(q);
      const all = dayEpisodes(date);
      const hit = all.filter((e) => matches(e, f));
      const limit = Math.min(2000, Math.max(10, Number(q.limit) || 300));
      const ks = ticker.status();
      return {
        now: Date.now(),
        date,
        today: day,
        live: date === day,
        demo,
        config: cfg,
        expiry,
        expiries,
        marketOpen: isMarketOpen(),
        error: lastError || (kite.get() && !demo ? kiteInstError : null),
        upstox: demo ? { connected: true, demo: true } : upstox.status(),
        kite: { ...kite.status(), ...(demo ? { loggedIn: true, mode: 'demo' } : {}), feed: demo ? { connected: cfg.enabled, demo: true } : ks },
        instruments:
          date === day
            ? list.map((i) => ({
                id: i.id,
                strike: i.strike,
                type: i.type,
                atm: i.atm,
                mapped: { u: Boolean(i.uKey) || demo, k: Boolean(i.kToken) },
                ...comparer.view(i.id),
              }))
            : [],
        open: comparer.openCount(),
        total: all.length,
        matched: hit.length,
        stats: summarize(hit),
        episodes: hit.slice(-limit).reverse(),
        paper: (() => {
          const trades = paper.list(date).filter((t) => !['u', 'k'].includes(q.pfeed) || t.entryFeed === q.pfeed);
          return { summary: summarizePaper(trades), live: summarizeLive(trades), trades: trades.slice(-300).reverse() };
        })(),
        trading: live.state(),
      };
    },
    // Live orders on Kite (feedlive.js).
    setLive: (on) => live.setOn(on),
    testOrder: (kind) => live.testOrder(kind),
    squareOff: () => live.squareOff(),
    closeLive: (id) => live.closeOne(id),
    refreshFunds: () => live.refreshFunds(),
  };
}

module.exports = { createComparer, summarize, matches, readDay, cleanConfig, createFeedCompare, LAG_LABELS };
