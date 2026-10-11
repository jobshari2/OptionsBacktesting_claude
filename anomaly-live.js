// Live anomaly scanner. Every few seconds it samples the nearest-expiry chain (ATM ± 15 strikes), keeps
// ~45 minutes of samples so "N minutes ago" comparisons work, and runs the same detectors as the history
// scan and the backtester. An opportunity counts once it has been there for the "Seen for" time; from then on it is
// logged (after each type's cooldown) for the day to bt-data/anomaly-log/<date>.jsonl. Structures that look like an
// arbitrage at quote mids or last-traded prices but fail a quality gate are kept as rejected signals, with the
// reason. Settings (which types, thresholds, quality gates) live in bt-data/anomaly-config.json.
const fs = require('fs');
const path = require('path');
const A = require('./bt/anomalies');
const { createHistChain } = require('./bt/histchain');
const { IST_OFFSET, istDate: istDay } = require('./lib/time');

const SAMPLE_MS = 5000;
const KEEP_MS = 46 * 60_000;
const STRIKES = 15;
const NEXT_MS = 10_000; // how often the next expiry's chain is fetched for the calendar

// minutes since the 09:15 open
const istMinute = (ts) => {
  const d = new Date(ts + IST_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - 555;
};
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;
const QKEYS = A.QUALITY.map((q) => q.k);

// getFeed: () => { connected, lastTickAt } of the tick feed, or null when there is none (demo).
function createAnomalyLive({ getChain, getNextChain, getFeed = () => null, data, isMarketOpen, demo, configFile, logDir, logError }) {
  let samples = []; // { t, expiry, spot, ks, ce, pe, ceBid, ceAsk, peBid, peAsk, … }
  let nextChain = null; // { at, chain }
  let config = readConfig();
  let day = istDay();
  let log = readLog(day);
  let active = [];
  let rejected = [];
  let health = null;
  let lastScan = { at: 0, ok: false, reason: 'starting' };
  const cooldown = new Map();
  const firstSeen = new Map(); // opportunity -> when this run of it was first seen
  // A restart must not re-log what already fired: start the cooldowns from today's log.
  for (const ev of log.slice().reverse()) cooldown.set(`${ev.type}|${ev.side}|${ev.dir}|${ev.strike}`, ev.t);
  let dayIv = null;
  const hist = createHistChain(data); // used only for realised vol from cached daily candles
  let rvDays = { at: 0 };

  // Types added since the config was saved start enabled. A config from before the quality gates were shared keeps
  // them inside each type's thresholds: they still apply there until the settings are saved again.
  function readConfig() {
    let c = null;
    try {
      c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {}
    const enabled = Object.fromEntries(A.TYPES.map((t) => [t.id, c?.enabled?.[t.id] ?? true]));
    return { enabled, params: c?.params || {}, quality: c?.quality || {} };
  }
  function saveConfig(c) {
    const enabled = {};
    const params = {};
    for (const t of A.TYPES) {
      enabled[t.id] = Boolean(c?.enabled?.[t.id]);
      const all = A.params(t.id, c?.params?.[t.id]);
      params[t.id] = {
        ...Object.fromEntries(Object.entries(all).filter(([k]) => !QKEYS.includes(k))),
        cooldown: Number(c?.params?.[t.id]?.cooldown) > 0 ? Number(c.params[t.id].cooldown) : t.cooldown,
      };
    }
    const q = A.params(A.TYPES[0].id, c?.quality);
    config = { enabled, params, quality: Object.fromEntries(QKEYS.map((k) => [k, q[k]])) };
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 1));
    return config;
  }
  // A type's thresholds with the shared quality gates laid over them.
  const paramsOf = (id) => ({ ...config.params?.[id], ...config.quality });
  const quality = () => A.params(A.TYPES[0].id, config.quality);
  function readLog(d) {
    try {
      return fs
        .readFileSync(path.join(logDir, d + '.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((ev) => A.BY_ID.has(ev.type))
        .reverse();
    } catch {
      return [];
    }
  }

  // ---------- sampling ----------
  function sample() {
    const ch = getChain();
    if (!ch?.rows?.length || ch.spot == null || Date.now() - ch.updatedAt > 30_000) return false;
    const rows = ch.rows;
    let ai = 0;
    rows.forEach((r, i) => {
      if (Math.abs(r.strike - ch.spot) < Math.abs(rows[ai].strike - ch.spot)) ai = i;
    });
    const sel = rows.slice(Math.max(0, ai - STRIKES), ai + STRIKES + 1);
    const t = ch.updatedAt;
    if (samples.length && samples[samples.length - 1].t === t) return true;
    if (samples.length && samples[samples.length - 1].expiry !== ch.expiry) samples = [];
    samples.push({ t, expiry: ch.expiry, spot: ch.spot, ks: sel.map((r) => r.strike), ...cols(sel) });
    while (samples.length && t - samples[0].t > KEEP_MS) samples.shift();
    return true;
  }

  // The per-strike columns of a chain: last price, best quotes with the quantity there (what the arbitrage types
  // need to call a trade fillable), volume, open interest and when each quote was last refreshed.
  function cols(rows) {
    const col = (side, k) => rows.map((r) => r[side][k] || 0);
    return {
      ce: col('ce', 'ltp'),
      pe: col('pe', 'ltp'),
      ceBid: col('ce', 'bid'),
      ceAsk: col('ce', 'ask'),
      peBid: col('pe', 'bid'),
      peAsk: col('pe', 'ask'),
      ceBidQ: col('ce', 'bidQ'),
      ceAskQ: col('ce', 'askQ'),
      peBidQ: col('pe', 'bidQ'),
      peAskQ: col('pe', 'askQ'),
      ceVol: col('ce', 'vol'),
      peVol: col('pe', 'vol'),
      ceOi: col('ce', 'oi'),
      peOi: col('pe', 'oi'),
      ceAt: col('ce', 'at'),
      peAt: col('pe', 'at'),
    };
  }
  // Lot size, for turning book quantities into lots.
  let lot = 65;
  Promise.resolve(data.expiryCalendar?.())
    .then((c) => {
      if (c?.liveLot) lot = c.liveLot;
    })
    .catch(() => {});

  // The sample closest to `t`, within 40 seconds.
  function sampleAt(t) {
    let best = null;
    for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) <= 40_000 ? best : null;
  }

  const ctxMemo = new WeakMap();
  function ctxOf(s) {
    if (!s) return null;
    if (ctxMemo.has(s)) return ctxMemo.get(s);
    const d = istDay(s.t);
    const m = istMinute(s.t);
    const c = new A.Chain({
      ...s,
      T: A.tradingYears(s.expiry, d, m),
      Tc: A.calendarYears(s.expiry, d, m),
      book: true,
      lot,
      now: s.t,
      day: d,
      minute: Math.floor(m),
      open: openSpot(),
      prev: (n) => ctxOf(sampleAt(s.t - n * 60_000)),
      next: () => nextCtx(s.t),
      rv: (n) => rv(n),
      dayIv: () => dayIv,
    });
    ctxMemo.set(s, c);
    return c;
  }

  // The next expiry's chain: REST quotes, all taken at the moment it was fetched.
  function nextCtx(t) {
    const nc = nextChain?.chain;
    if (!nc?.rows?.length || Math.abs(nextChain.at - t) > 120_000) return null;
    const rows = nc.rows.filter((r) => Math.abs(r.strike - nc.spot) < 600);
    const d = istDay(t);
    const m = istMinute(t);
    const at = nc.fetchedAt || nextChain.at;
    return new A.Chain({
      spot: nc.spot,
      T: A.tradingYears(nc.expiry, d, m),
      Tc: A.calendarYears(nc.expiry, d, m),
      ks: rows.map((r) => r.strike),
      ...cols(rows.map((r) => ({ ce: { ...r.ce, at }, pe: { ...r.pe, at } }))),
      expiry: nc.expiry,
      day: d,
      book: true,
      lot,
      now: t,
      minute: Math.floor(m),
      prev: () => null,
      next: () => null,
      rv: () => null,
      dayIv: () => null,
    });
  }

  function openSpot() {
    const today = istDay();
    const a = data.spotDay?.(today);
    if (a) return a[0];
    const first = samples.find((s) => istDay(s.t) === today);
    return first && istMinute(first.t) < 2 ? first.spot : null;
  }

  // Realised vol from the cached daily history (sessions before today), refreshed hourly.
  function rv(n) {
    if (Date.now() - rvDays.at > 3600_000 && !rvDays.loading) {
      rvDays.loading = true;
      const today = istDay();
      data
        .loadIndex(addDays(today, -45), addDays(today, -1))
        .then((days) => {
          hist.setDays([...days, today]);
          rvDays = { at: Date.now() };
        })
        .catch((e) => {
          rvDays = { at: Date.now() - 3000_000 };
          logError('anomaly-rv', e);
        });
    }
    return rvDays.at ? hist.rv(istDay(), n) : null;
  }

  // ---------- scanning ----------
  async function tick() {
    try {
      if (istDay() !== day) {
        day = istDay();
        log = readLog(day);
        cooldown.clear();
        firstSeen.clear();
        dayIv = null;
        samples = [];
      }
      if (!sample()) {
        lastScan = { at: Date.now(), ok: false, reason: 'waiting for live chain data' };
        active = [];
        rejected = [];
        health = null;
        return;
      }
      const t0 = Date.now();
      const open = demo || isMarketOpen(Date.now());
      const s = samples[samples.length - 1];
      const enabled = A.TYPES.filter((t) => config.enabled?.[t.id]);
      if (enabled.some((t) => t.needsNext) && (!nextChain || Date.now() - nextChain.at > NEXT_MS)) {
        nextChain = { at: Date.now(), chain: nextChain?.chain || null };
        getNextChain()
          .then((c) => {
            nextChain = { at: Date.now(), chain: c };
          })
          .catch((e) => logError('anomaly-next', e));
      }
      const ctx = ctxOf(s);
      if (dayIv == null && istMinute(s.t) >= 5) dayIv = ctx.atmIv();
      const hold = quality().hold * 1000;
      const found = [];
      const rej = [];
      let rejTotal = 0;
      const seen = new Set();
      for (const t of enabled) {
        const p = paramsOf(t.id);
        const r = A.scan(t.id, ctx, p, { rejects: true });
        for (const h of r.hits.slice(0, t.maxLive || 3)) {
          const key = `${h.type}|${h.side}|${h.dir}|${h.strike}|${h.ref}`;
          seen.add(key);
          if (!firstSeen.has(key)) firstSeen.set(key, s.t);
          const held = s.t - firstSeen.get(key);
          found.push({ ...withTrade(h, p, s), held: Math.round(held / 1000), pending: held < hold });
        }
        rejTotal += r.rejectedTotal;
        for (const x of r.rejected) rej.push({ ...x, apparent: r2(x.apparent), touch: x.touch == null ? null : r2(x.touch) });
      }
      for (const k of firstSeen.keys()) if (!seen.has(k)) firstSeen.delete(k);
      active = found;
      rejected = rej.sort((a, b) => b.apparent - a.apparent).slice(0, 20);
      health = healthOf(s, ctx, { enabled, rejTotal, ms: Date.now() - t0 });
      lastScan = { at: Date.now(), ok: true, reason: open ? null : "market closed — showing the last session's chain, not logging" };
      if (!open) return;
      const now = Date.now();
      for (const h of found) {
        if (h.pending) continue;
        const key = `${h.type}|${h.side}|${h.dir}|${h.strike}`;
        const cd = (config.params?.[h.type]?.cooldown || A.BY_ID.get(h.type).cooldown) * 60_000;
        const last = cooldown.get(key);
        cooldown.set(key, now);
        if (last && now - last < cd) continue;
        const ev = { id: `${now}-${log.length}`, t: now, ...h };
        log.unshift(ev);
        if (log.length > 500) log.length = 500;
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFile(path.join(logDir, day + '.jsonl'), JSON.stringify(ev) + '\n', (e) => e && logError('anomaly-log', e));
      }
    } catch (e) {
      logError('anomaly-live', e);
    }
  }

  // Suggested trade, resolved to strikes and quotes on the current chain; for arbitrage types also the
  // worst value at expiry when filled at bid (sells) / ask (buys).
  function withTrade(h, p, s) {
    const sug = A.suggest(h, p);
    const near = (x) => s.ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(s.ks[b] - x) ? j : b), 0);
    const legs = [];
    for (const l of sug.legs) {
      let i;
      if (l.strike.by === 'signal') i = near(l.strike.ref === 'ref' && h.ref != null ? h.ref : h.strike) + l.strike.value;
      else i = near(s.spot) + (l.type === 'CE' ? 1 : -1) * l.strike.value;
      const k = s.ks[Math.max(0, Math.min(s.ks.length - 1, i))];
      const j = s.ks.indexOf(k);
      const ce = l.type === 'CE';
      const cur = l.expiry === 'cur'; // quotes are only sampled for the nearest expiry
      const nx = !cur ? nextChain?.chain?.rows?.find((r) => r.strike === k) : null;
      const side = ce ? 'ce' : 'pe';
      const get = (col, key) => (cur ? s[side + col][j] : nx?.[side]?.[key]) || null;
      const at = cur ? s[side + 'At'][j] : nextChain?.chain?.fetchedAt;
      legs.push({
        action: l.action,
        type: l.type,
        lots: l.lots,
        expiry: l.expiry,
        strike: k,
        ltp: cur ? s[side][j] || null : nx?.[side]?.ltp || null,
        bid: get('Bid', 'bid'),
        ask: get('Ask', 'ask'),
        bidQ: get('BidQ', 'bidQ'),
        askQ: get('AskQ', 'askQ'),
        vol: get('Vol', 'vol'),
        oi: get('Oi', 'oi'),
        age: at ? Math.max(0, Math.round((s.t - at) / 1000)) : null,
      });
    }
    let exec = null;
    if (h.arb && legs.every((l) => l.expiry === 'cur' && (l.action === 'B' ? l.ask : l.bid))) {
      exec = A.worstAtExpiry(
        legs.map((l) => ({ dir: l.action === 'B' ? 1 : -1, qty: l.lots, type: l.type, strike: l.strike, px: l.action === 'B' ? l.ask : l.bid })),
        s.spot,
      );
      exec = r2(exec);
    }
    const { st, pv, robust, ...rest } = h;
    return { ...rest, value: r2(h.value), locked: h.locked == null ? null : r2(h.locked), spot: s.spot, expiry: s.expiry, legs, template: sug, exec };
  }

  // ---------- scanner health ----------
  // How good the data behind the scan is: the age of the chain and of the tick feed, how many of the sampled
  // contracts carry a usable two-sided quote, crossed quotes, stale quotes and the typical spread near the money.
  function healthOf(s, ctx, { enabled, rejTotal, ms }) {
    const q = quality();
    const feed = getFeed();
    let sides = 0;
    let twoSided = 0;
    let crossed = 0;
    let stale = 0;
    const spreads = [];
    s.ks.forEach((k, i) => {
      for (const t of ['ce', 'pe']) {
        sides++;
        const [b, a] = [s[t + 'Bid'][i], s[t + 'Ask'][i]];
        if (!(b > 0) || !(a > 0)) continue;
        if (b > a) {
          crossed++;
          continue;
        }
        twoSided++;
        const at = s[t + 'At'][i];
        if (q.maxAge > 0 && at && (s.t - at) / 1000 > q.maxAge) stale++;
        if (Math.abs(i - ctx.ai) <= 5) spreads.push(a - b);
      }
    });
    spreads.sort((x, y) => x - y);
    const needNext = enabled.some((t) => t.needsNext);
    return {
      at: s.t,
      chainAge: Math.round((Date.now() - s.t) / 1000),
      feed: feed ? { connected: Boolean(feed.connected), age: feed.lastTickAt ? Math.round((Date.now() - feed.lastTickAt) / 1000) : null } : null,
      strikes: s.ks.length,
      sides,
      twoSided,
      crossed,
      stale,
      spread: spreads.length ? r2(spreads[spreads.length >> 1]) : null,
      next: needNext ? { age: nextChain?.chain?.fetchedAt ? Math.round((Date.now() - nextChain.chain.fetchedAt) / 1000) : null } : null,
      rejected: rejTotal,
      ms,
    };
  }

  // Summary numbers shown above the live list.
  function metrics() {
    const s = samples[samples.length - 1];
    if (!s) return null;
    const c = ctxOf(s);
    const kp = c.at(c.ai - 4);
    const kc = c.at(c.ai + 4);
    const vp = kp != null ? c.iv(kp, 'PE') : null;
    const vc = kc != null ? c.iv(kc, 'CE') : null;
    const a = c.atmIv();
    const r5 = rv(5);
    const n = c.next();
    const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
    return {
      expiry: s.expiry,
      spot: s.spot,
      at: s.t,
      atm: c.atm,
      forward: Math.round(c.F * 10) / 10,
      basis: Math.round((c.F - s.spot) * 10) / 10,
      atmIv: pct(a),
      rr: vp && vc ? Math.round((vp - vc) * 1000) / 10 : null,
      rv5: pct(r5),
      ivrv: a && r5 ? Math.round((a / r5) * 100) / 100 : null,
      nextIv: pct(n?.atmIv()),
      dayIv: pct(dayIv),
      samples: samples.length,
      minutes: Math.round((s.t - samples[0].t) / 60_000),
    };
  }

  // Put-call parity strike by strike on the latest sample (see Chain.parity).
  function parity() {
    const s = samples[samples.length - 1];
    if (!s) return null;
    const c = ctxOf(s);
    const rows = c.parity(8).map((r) => ({ k: r.k, cb: r.cb, ca: r.ca, pb: r.pb, pa: r.pa, buy: r2(r.buy), sell: r2(r.sell) }));
    if (!rows.length) return null;
    // the forward can be bought no cheaper than `buy` and sold no dearer than `sell`: sell above buy = a box arbitrage
    const buy = rows.reduce((b, r) => (r.buy < b.buy ? r : b));
    const sell = rows.reduce((b, r) => (r.sell > b.sell ? r : b));
    return { rows, buy: { k: buy.k, f: buy.buy }, sell: { k: sell.k, f: sell.sell }, gap: r2(sell.sell - buy.buy), forward: r2(c.F), atm: c.atm };
  }

  // Inputs for evaluating strategy entry conditions right now (levels are added by the caller).
  function env() {
    const s = samples[samples.length - 1];
    if (!s) return null;
    const today = istDay();
    const a = data.spotDay?.(today);
    let high = -Infinity;
    let low = Infinity;
    if (a)
      for (let m = 0; m < a.length / 4; m++) {
        if (a[m * 4] == null) break;
        high = Math.max(high, a[m * 4 + 1]);
        low = Math.min(low, a[m * 4 + 2]);
      }
    for (const x of samples)
      if (istDay(x.t) === today) {
        high = Math.max(high, x.spot);
        low = Math.min(low, x.spot);
      }
    return {
      spot: s.spot,
      prevSpot: sampleAt(s.t - 60_000)?.spot ?? null,
      open: openSpot(),
      high: isFinite(high) ? high : null,
      low: isFinite(low) ? low : null,
      ctx: () => ctxOf(s),
    };
  }

  setInterval(tick, SAMPLE_MS);

  return {
    state: () => ({
      config: { ...config, quality: quality() },
      catalog: A.catalog(),
      status: lastScan,
      metrics: metrics(),
      active,
      rejected,
      health,
      parity: parity(),
      lot,
      log: log.slice(0, 300),
    }),
    saveConfig,
    active: () => active.filter((h) => !h.pending),
    env,
  };
}

module.exports = { createAnomalyLive };
