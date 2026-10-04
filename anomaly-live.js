// Live anomaly scanner. Every few seconds it samples the nearest-expiry chain (ATM ± 15 strikes), keeps
// ~45 minutes of samples so "N minutes ago" comparisons work, and runs the same detectors as the history
// scan and the backtester. New anomalies (after each type's cooldown) are logged for the day to
// bt-data/anomaly-log/<date>.jsonl. Settings (which types, thresholds) live in bt-data/anomaly-config.json.
const fs = require('fs');
const path = require('path');
const A = require('./bt/anomalies');
const { createHistChain } = require('./bt/histchain');

const SAMPLE_MS = 5000;
const KEEP_MS = 46 * 60_000;
const STRIKES = 15;

const istNow = (ts = Date.now()) => new Date(ts + 5.5 * 3600_000);
const istDay = (ts) => istNow(ts).toISOString().slice(0, 10);
const istMinute = (ts) => { const d = istNow(ts); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - 555; };
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

function createAnomalyLive({ getChain, getNextChain, data, isMarketOpen, demo, configFile, logDir, logError }) {
  let samples = []; // { t, expiry, spot, ks, ce, pe, ceBid, ceAsk, peBid, peAsk }
  let nextChain = null; // { at, chain }
  let config = readConfig();
  let day = istDay();
  let log = readLog(day);
  let active = [];
  let lastScan = { at: 0, ok: false, reason: 'starting' };
  const cooldown = new Map();
  // A restart must not re-log what already fired: start the cooldowns from today's log.
  for (const ev of log.slice().reverse()) cooldown.set(`${ev.type}|${ev.side}|${ev.dir}|${ev.strike}`, ev.t);
  let dayIv = null;
  const hist = createHistChain(data); // used only for realised vol from cached daily candles
  let rvDays = { at: 0 };

  // Types added since the config was saved start enabled.
  function readConfig() {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
    const enabled = Object.fromEntries(A.TYPES.map((t) => [t.id, c?.enabled?.[t.id] ?? true]));
    return { enabled, params: c?.params || {} };
  }
  function saveConfig(c) {
    const enabled = {};
    const params = {};
    for (const t of A.TYPES) {
      enabled[t.id] = Boolean(c?.enabled?.[t.id]);
      params[t.id] = { ...A.params(t.id, c?.params?.[t.id]), cooldown: Number(c?.params?.[t.id]?.cooldown) > 0 ? Number(c.params[t.id].cooldown) : t.cooldown };
    }
    config = { enabled, params };
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 1));
    return config;
  }
  function readLog(d) {
    try {
      return fs.readFileSync(path.join(logDir, d + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((ev) => A.BY_ID.has(ev.type)).reverse();
    } catch { return []; }
  }

  // ---------- sampling ----------
  function sample() {
    const ch = getChain();
    if (!ch?.rows?.length || ch.spot == null || Date.now() - ch.updatedAt > 30_000) return false;
    const rows = ch.rows;
    let ai = 0;
    rows.forEach((r, i) => { if (Math.abs(r.strike - ch.spot) < Math.abs(rows[ai].strike - ch.spot)) ai = i; });
    const sel = rows.slice(Math.max(0, ai - STRIKES), ai + STRIKES + 1);
    const t = ch.updatedAt;
    if (samples.length && samples[samples.length - 1].t === t) return true;
    if (samples.length && samples[samples.length - 1].expiry !== ch.expiry) samples = [];
    samples.push({
      t, expiry: ch.expiry, spot: ch.spot, ks: sel.map((r) => r.strike),
      ce: sel.map((r) => r.ce.ltp || 0), pe: sel.map((r) => r.pe.ltp || 0),
      ceBid: sel.map((r) => r.ce.bid || 0), ceAsk: sel.map((r) => r.ce.ask || 0),
      peBid: sel.map((r) => r.pe.bid || 0), peAsk: sel.map((r) => r.pe.ask || 0),
      ...qtys(sel),
    });
    while (samples.length && t - samples[0].t > KEEP_MS) samples.shift();
    return true;
  }

  // Quantity at the best bid / ask per strike (what the arbitrage types need to call a trade fillable).
  function qtys(rows) {
    return {
      ceBidQ: rows.map((r) => r.ce.bidQ || 0), ceAskQ: rows.map((r) => r.ce.askQ || 0),
      peBidQ: rows.map((r) => r.pe.bidQ || 0), peAskQ: rows.map((r) => r.pe.askQ || 0),
    };
  }
  // Lot size, for turning book quantities into lots.
  let lot = 65;
  Promise.resolve(data.expiryCalendar?.()).then((c) => { if (c?.liveLot) lot = c.liveLot; }).catch(() => {});

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
    const c = new A.Chain({
      spot: s.spot, T: A.tradingYears(s.expiry, d, istMinute(s.t)), ks: s.ks, ce: s.ce, pe: s.pe,
      book: true, lot, ceBid: s.ceBid, ceAsk: s.ceAsk, peBid: s.peBid, peAsk: s.peAsk,
      ceBidQ: s.ceBidQ, ceAskQ: s.ceAskQ, peBidQ: s.peBidQ, peAskQ: s.peAskQ,
      expiry: s.expiry, day: d, minute: Math.floor(istMinute(s.t)), open: openSpot(),
      prev: (n) => ctxOf(sampleAt(s.t - n * 60_000)),
      next: () => nextCtx(s.t),
      rv: (n) => rv(n),
      dayIv: () => dayIv,
    });
    ctxMemo.set(s, c);
    return c;
  }

  function nextCtx(t) {
    const nc = nextChain?.chain;
    if (!nc?.rows?.length || Math.abs(nextChain.at - t) > 120_000) return null;
    const rows = nc.rows.filter((r) => Math.abs(r.strike - nc.spot) < 600);
    const d = istDay(t);
    return new A.Chain({
      spot: nc.spot, T: A.tradingYears(nc.expiry, d, istMinute(t)), ks: rows.map((r) => r.strike),
      ce: rows.map((r) => r.ce.ltp || 0), pe: rows.map((r) => r.pe.ltp || 0), expiry: nc.expiry, day: d,
      book: true, lot, ceBid: rows.map((r) => r.ce.bid || 0), ceAsk: rows.map((r) => r.ce.ask || 0),
      peBid: rows.map((r) => r.pe.bid || 0), peAsk: rows.map((r) => r.pe.ask || 0), ...qtys(rows),
      minute: Math.floor(istMinute(t)), prev: () => null, next: () => null, rv: () => null, dayIv: () => null,
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
      data.loadIndex(addDays(today, -45), addDays(today, -1))
        .then((days) => { hist.setDays([...days, today]); rvDays = { at: Date.now() }; })
        .catch((e) => { rvDays = { at: Date.now() - 3000_000 }; logError('anomaly-rv', e); });
    }
    return rvDays.at ? hist.rv(istDay(), n) : null;
  }

  // ---------- scanning ----------
  async function tick() {
    try {
      if (istDay() !== day) { day = istDay(); log = readLog(day); cooldown.clear(); dayIv = null; samples = []; }
      if (!sample()) { lastScan = { at: Date.now(), ok: false, reason: 'waiting for live chain data' }; active = []; return; }
      const open = demo || isMarketOpen(Date.now());
      const s = samples[samples.length - 1];
      const enabled = A.TYPES.filter((t) => config.enabled?.[t.id]);
      if (enabled.some((t) => t.needsNext) && (!nextChain || Date.now() - nextChain.at > 30_000)) {
        nextChain = { at: Date.now(), chain: nextChain?.chain || null };
        getNextChain().then((c) => { nextChain = { at: Date.now(), chain: c }; }).catch((e) => logError('anomaly-next', e));
      }
      const ctx = ctxOf(s);
      if (dayIv == null && istMinute(s.t) >= 5) dayIv = ctx.atmIv();
      const found = [];
      for (const t of enabled) {
        const p = config.params?.[t.id] || {};
        for (const h of A.detect(t.id, ctx, p).slice(0, t.maxLive || 3)) found.push(withTrade(h, p, s));
      }
      active = found;
      lastScan = { at: Date.now(), ok: true, reason: open ? null : 'market closed — showing the last session\'s chain, not logging' };
      if (!open) return;
      const now = Date.now();
      for (const h of found) {
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
      legs.push({
        action: l.action, type: l.type, lots: l.lots, expiry: l.expiry, strike: k,
        ltp: cur ? (ce ? s.ce : s.pe)[j] || null : (ce ? nx?.ce : nx?.pe)?.ltp || null,
        bid: cur ? (ce ? s.ceBid : s.peBid)[j] || null : nx ? (ce ? nx.ce : nx.pe).bid || null : null,
        ask: cur ? (ce ? s.ceAsk : s.peAsk)[j] || null : nx ? (ce ? nx.ce : nx.pe).ask || null : null,
        bidQ: cur ? (ce ? s.ceBidQ : s.peBidQ)[j] || null : nx ? (ce ? nx.ce : nx.pe).bidQ || null : null,
        askQ: cur ? (ce ? s.ceAskQ : s.peAskQ)[j] || null : nx ? (ce ? nx.ce : nx.pe).askQ || null : null,
      });
    }
    let exec = null;
    if (h.arb && legs.every((l) => l.expiry === 'cur' && (l.action === 'B' ? l.ask : l.bid))) {
      exec = A.worstAtExpiry(legs.map((l) => ({ dir: l.action === 'B' ? 1 : -1, qty: l.lots, type: l.type, strike: l.strike, px: l.action === 'B' ? l.ask : l.bid })), s.spot);
      exec = Math.round(exec * 100) / 100;
    }
    return { ...h, value: Math.round(h.value * 100) / 100, spot: s.spot, legs, template: sug, exec };
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
      expiry: s.expiry, spot: s.spot, at: s.t, atm: c.atm, forward: Math.round(c.F * 10) / 10, basis: Math.round((c.F - s.spot) * 10) / 10,
      atmIv: pct(a), rr: vp && vc ? Math.round((vp - vc) * 1000) / 10 : null, rv5: pct(r5), ivrv: a && r5 ? Math.round((a / r5) * 100) / 100 : null,
      nextIv: pct(n?.atmIv()), dayIv: pct(dayIv), samples: samples.length, minutes: Math.round((s.t - samples[0].t) / 60_000),
    };
  }

  // Inputs for evaluating strategy entry conditions right now (levels are added by the caller).
  function env() {
    const s = samples[samples.length - 1];
    if (!s) return null;
    const today = istDay();
    const a = data.spotDay?.(today);
    let high = -Infinity;
    let low = Infinity;
    if (a) for (let m = 0; m < a.length / 4; m++) { if (a[m * 4] == null) break; high = Math.max(high, a[m * 4 + 1]); low = Math.min(low, a[m * 4 + 2]); }
    for (const x of samples) if (istDay(x.t) === today) { high = Math.max(high, x.spot); low = Math.min(low, x.spot); }
    return {
      spot: s.spot, prevSpot: sampleAt(s.t - 60_000)?.spot ?? null, open: openSpot(), high: isFinite(high) ? high : null, low: isFinite(low) ? low : null,
      ctx: () => ctxOf(s),
    };
  }

  setInterval(tick, SAMPLE_MS);

  return {
    state: () => ({ config, catalog: A.catalog(), status: lastScan, metrics: metrics(), active, log: log.slice(0, 300) }),
    saveConfig,
    active: () => active,
    env,
  };
}

module.exports = { createAnomalyLive };
