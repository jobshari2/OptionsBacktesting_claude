// Strategies HTTP API: saved strategies, live deployment of a strategy on the current option chain, the Builder's
// historical replay and saved trades, support / resistance, Nifty candles and the historical-data cache.
const fs = require('fs');
const path = require('path');
const { createData, addDays } = require('./data');
const { normalizeStrategy, wholeStrategyStops } = require('./strategy');
const { LIBRARY } = require('./library');
const { createLevels, nearest: nearestLevels, extend: extendLevels } = require('./levels');
const { evaluate } = require('./conditions');
const A = require('./anomalies');
const { createSync } = require('./sync');
const { MPD } = require('./data');
const { istDate: istToday } = require('../lib/time');

// upstox: the app's Upstox client; getRestChain(expiry, maxAgeMs): the server's REST chain of a live expiry;
// liveData(): the live source when it is not Upstox (see bt/data.js), or null.
function createBacktester({ getToken, upstox, getRestChain, cacheDir, storeFile, logError, liveData }) {
  const data = createData({ getToken, upstox, cacheDir, logError, live: liveData });
  const levels = createLevels();
  let liveScan = null; // live anomaly scanner, attached by the server

  // ---------- Strategy Builder: historical replay data ----------
  // Trading days on which an expired expiry's options can be replayed (up to ~5 weeks before it).
  // `from` (optional) starts the list earlier than the usual 34 days, so a position kept while switching the
  // replay to a later expiry (calendar / diagonal spreads) stays on its replay day; capped at 120 days.
  async function builderDays(expiry, from) {
    const cal = await data.expiryCalendar();
    if (!cal.expiredSet.has(expiry)) throw new Error('Pick an expired expiry for historical replay');
    let start = addDays(expiry, -34);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from || '') && from < start) start = from > addDays(expiry, -120) ? from : addDays(expiry, -120);
    const days = (await data.loadIndex(start, expiry)).filter((d) => d <= expiry);
    const info = await data.contracts(expiry);
    return { expiry, days, lot: info.lot, liveLot: cal.liveLot, monthly: cal.monthly.has(expiry) };
  }
  // One day of an expiry: Nifty and the closing price per minute of every strike within `width` of the
  // day's Nifty range (plus any `extra` strikes already in the position). 0 = not traded yet.
  async function builderDay(expiry, day, width = 15, extra = []) {
    const sp = data.spotDay(day) || (await data.loadIndex(day, day), data.spotDay(day));
    if (!sp) throw new Error('No Nifty data for ' + day);
    const info = await data.contracts(expiry);
    let lo = Infinity;
    let hi = -Infinity;
    for (let m = 0; m < MPD; m++) {
      lo = Math.min(lo, sp[m * 4 + 2]);
      hi = Math.max(hi, sp[m * 4 + 1]);
    }
    const all = info.strikes;
    const near = (x) => all.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(all[b] - x) ? j : b), 0);
    const ks = [...new Set([...all.slice(Math.max(0, near(lo) - width), near(hi) + width + 1), ...extra.filter((k) => all.includes(k))])].sort((a, b) => a - b);
    const series = async (k, t) => {
      const c = await data.option(expiry, k, t, day).catch(() => null);
      const a = c && data.optionDay(c, day);
      const out = new Array(MPD).fill(0);
      if (a) for (let m = 0; m < MPD; m++) out[m] = a[m * 4 + 3] > 0 ? a[m * 4 + 3] / 100 : 0;
      return out;
    };
    const tasks = ks.flatMap((k) => [
      [k, 'CE'],
      [k, 'PE'],
    ]);
    const res = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < tasks.length) {
          const [k, t] = tasks[next++];
          res.set(k + t, await series(k, t));
        }
      }),
    );
    return {
      expiry,
      day,
      ks,
      lot: info.lot,
      spot: Array.from({ length: MPD }, (_, m) => Math.round(sp[m * 4 + 3] * 100) / 100),
      ce: ks.map((k) => res.get(k + 'CE')),
      pe: ks.map((k) => res.get(k + 'PE')),
      bees: await beesDay(day),
    };
  }
  // NIFTYBEES' closing price per minute of a day (the Builder's "Held against NIFTYBEES" on a replay), or null when
  // its history for that month cannot be had (not cached and offline): the Builder then moves it with Nifty.
  async function beesDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
    await data.loadSeries(data.BEES, day, day);
    const a = data.seriesDay(data.BEES, day);
    if (!a) return null;
    return Array.from({ length: MPD }, (_, m) => (a[m * 4 + 3] > 0 ? Math.round(a[m * 4 + 3] * 100) / 100 : 0));
  }

  // Volume and open interest of strikes on a replay day, for the Builder's chain: per strike and side, per minute, the
  // day's volume so far and the latest open interest (0 before the first candle). Downloads what the cache lacks
  // (data.optionVo). A contract that cannot be read gives nulls.
  async function builderVo(expiry, day, ks) {
    const run = (a) => {
      if (!a) return { v: new Array(MPD).fill(0), o: new Array(MPD).fill(0) };
      const v = new Array(MPD);
      const o = new Array(MPD);
      let vol = 0;
      let oi = 0;
      for (let m = 0; m < MPD; m++) {
        if (a[m * 2] > 0) vol += a[m * 2];
        if (a[m * 2 + 1] > 0) oi = a[m * 2 + 1];
        v[m] = vol;
        o[m] = oi;
      }
      return { v, o };
    };
    const tasks = ks.flatMap((k) => ['CE', 'PE'].map((t) => [k, t]));
    const res = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < tasks.length) {
          const [k, t] = tasks[next++];
          res.set(
            k + t,
            await data
              .optionVo(expiry, k, t, day)
              .then(run)
              .catch(() => null),
          );
        }
      }),
    );
    return { expiry, day, ks, ce: ks.map((k) => res.get(k + 'CE')), pe: ks.map((k) => res.get(k + 'PE')) };
  }

  // ---------- Builder: saved trades ----------
  // Positions built in the Builder (live paper trades and replays), each with its whole Builder state (legs with
  // their entries and exits, log, P&L curve) so it can be loaded back, adjusted and saved again. bt-data/paper-trades.json.
  const tradesFile = path.join(path.dirname(storeFile), 'paper-trades.json');
  function readTrades() {
    try {
      return JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
    } catch {
      return [];
    }
  }
  function writeTrades(list) {
    fs.mkdirSync(path.dirname(tradesFile), { recursive: true });
    fs.writeFileSync(tradesFile + '.tmp', JSON.stringify(list));
    fs.renameSync(tradesFile + '.tmp', tradesFile);
  }
  function saveTrade(b) {
    if (!Array.isArray(b?.snap?.legs) || !b.snap.legs.length) throw new Error('Nothing to save: the position has no legs');
    const list = readTrades();
    const old = list.find((x) => x.id === b.id);
    const t = {
      id: old ? old.id : 'pt-' + Date.now().toString(36),
      name: String(b.name || old?.name || 'Paper trade').slice(0, 80),
      createdAt: old?.createdAt || Date.now(),
      savedAt: Date.now(),
      summary: b.summary || {},
      snap: b.snap,
    };
    if (old?.account) t.account = old.account; // live / paper, set on the Trades screen: a save from the Builder keeps it
    writeTrades(old ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]);
    return t;
  }
  // Mark a saved trade 'live' (real money, counted in the Trades screen's total P&L) or 'paper'.
  function setTradeAccount(b) {
    if (b?.account !== 'live' && b?.account !== 'paper') throw new Error('account must be live or paper');
    const list = readTrades();
    const t = list.find((x) => x.id === b.id);
    if (!t) throw new Error('No such trade');
    t.account = b.account;
    writeTrades(list);
    return t;
  }

  // ---------- saved strategies ----------
  // The store holds the user's own strategies ("my-…") and edited copies of built-in ones, saved under the
  // built-in's id ("lib-…"); an edited built-in replaces the original everywhere until it is reset.
  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch {
      return [];
    }
  }
  function writeStore(list) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile + '.tmp', JSON.stringify(list, null, 1));
    fs.renameSync(storeFile + '.tmp', storeFile);
  }
  const isLib = (id) => LIBRARY.some((x) => x.id === id);
  function saveStrategy(s) {
    const list = readStore();
    const strat = normalizeStrategy(s);
    if (!strat.legs.length) throw new Error('A strategy needs at least one leg');
    if (s.override && isLib(strat.id)) strat.edited = true;
    else if (!strat.id || !strat.id.startsWith('my-')) strat.id = 'my-' + Date.now().toString(36);
    strat.updatedAt = Date.now();
    const i = list.findIndex((x) => x.id === strat.id);
    if (i >= 0) list[i] = strat;
    else list.push(strat);
    writeStore(list);
    return strat;
  }
  function deleteStrategy(id) {
    writeStore(readStore().filter((x) => x.id !== id));
  }
  function library() {
    const edits = new Map(
      readStore()
        .filter((x) => isLib(x.id))
        .map((x) => [x.id, x]),
    );
    return LIBRARY.map((l) =>
      edits.has(l.id)
        ? { ...wholeStrategyStops(edits.get(l.id)), id: l.id, edited: true, updatedAt: edits.get(l.id).updatedAt }
        : { ...wholeStrategyStops(l), id: l.id },
    );
  }
  // served with whole-strategy stops (an older save may still have leg stops), keeping its id and save time
  const saved = () =>
    readStore()
      .filter((x) => !isLib(x.id))
      .map((x) => ({ ...wholeStrategyStops(x), id: x.id, ...(x.updatedAt ? { updatedAt: x.updatedAt } : {}) }));
  const findStrategy = (id) => library().find((x) => x.id === id) || saved().find((x) => x.id === id);

  // ---------- support / resistance ----------
  let liveLv = { at: 0, day: null, lv: null };
  // Levels for `day` (default today) from the sessions before it.
  async function levelsFor(day) {
    const today = istToday();
    day = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today ? day : today;
    // The swing levels of a day only change with the day (they use the sessions before it): computed once per day, re-read
    // every 10 minutes for new data. They are then projected beyond their last level against the current spot (levels.js).
    const withSpot = async (base) => {
      let spot = data.spotDay(day)?.[0] ?? base.prev.c;
      if (day === today) {
        try {
          const c = (await data.niftyIntraday()).filter((x) => x[0].slice(0, 10) === today).pop();
          if (c) spot = c[4];
        } catch {
          /* demo / not logged in / holiday: the day's open */
        }
      }
      return extendLevels({ ...base }, spot);
    };
    if (day === today && liveLv.day === day && Date.now() - liveLv.at < 10 * 60_000) return withSpot(liveLv.lv);
    let days;
    try {
      days = await data.loadIndex(addDays(day, -200), day);
    } catch (e) {
      // The running month can't be fetched (offline / demo): use the cached history up to last month.
      days = await data.loadIndex(addDays(day, -200), addDays(day.slice(0, 7) + '-01', -1));
      logError('levels', e, 'using cached history');
    }
    const list = days.filter((d) => d < day).concat(day);
    const lv = levels.forDay(list, list.length - 1, data.spotDay);
    if (!lv) throw new Error('Not enough Nifty history for support/resistance');
    if (day === today) liveLv = { at: Date.now(), day, lv };
    return withSpot(lv);
  }

  // Nifty candles for the chart on the Chain screen and its pop-out window. History comes from the cached 1-minute
  // files under bt-cache/index, the running session from the Upstox intraday endpoint (the page then moves the last
  // candle with the live tick). tf = minutes per candle (1, 3, 5, 10, 15, 60, 120) or 'D' / 'W' / 'M'.
  // Intraday candles come a block of sessions at a time, ending before the day `before`, so the page can load
  // further back as it is scrolled; D / W / M return everything in the cache folder.
  // Candle = [time, open, high, low, close]; time is IST wall-clock seconds (as if UTC), which the chart displays as is.
  const TF_SESSIONS = { 1: 6, 3: 15, 5: 30, 10: 60, 15: 90, 60: 250, 120: 500 };
  async function niftyCandles(tf, before) {
    const step = Number(tf);
    const sessions = TF_SESSIONS[step];
    if (!sessions && !['D', 'W', 'M'].includes(tf)) throw new Error('Unknown chart timeframe ' + tf);
    const today = istToday();
    const start = data.indexStart() || addDays(today, -200).slice(0, 7) + '-01';
    const older = /^\d{4}-\d{2}-\d{2}$/.test(before || '') && before <= today ? before : null;
    let intra = [];
    if (!older) {
      try {
        intra = (await data.niftyIntraday()).filter((c) => c[0].slice(0, 10) === today);
      } catch {
        /* demo / not logged in / holiday */
      }
    }
    const to = older ? addDays(older, -1) : today;
    let from = sessions ? addDays(to, -Math.ceil(sessions * 1.6) - 10) : start;
    if (from < start) from = start;
    let days = [];
    if (from <= to) {
      try {
        days = await data.loadIndex(from, to);
      } catch (e) {
        days = await data.loadIndex(from, addDays(today.slice(0, 7) + '-01', -1)); // running month unavailable: cached history
      }
    }
    if (intra.length) days = days.filter((d) => d < today); // today comes from the intraday feed
    let more = false;
    if (sessions) {
      const keep = sessions - (intra.length ? 1 : 0);
      more = days.length > keep || from > start;
      days = days.slice(-keep);
    }
    if (intra.length) days.push(today);

    const r2 = (x) => Math.round(x * 100) / 100;
    const sec = (day, m) => Date.parse(day + 'T00:00:00Z') / 1000 + (m == null ? 0 : (555 + m) * 60);
    const weekOf = (d) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
    const minuteOf = (ts) => Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) - 555;
    const candles = [];
    let cur = null;
    let curKey = null;
    const add = (key, t, o, h, l, c) => {
      if (key !== curKey) {
        cur = [t, o, h, l, c];
        candles.push(cur);
        curKey = key;
        return;
      }
      if (h > cur[2]) cur[2] = h;
      if (l < cur[3]) cur[3] = l;
      cur[4] = c;
    };
    for (const d of days) {
      const key = tf === 'D' ? d : tf === 'W' ? weekOf(d) : tf === 'M' ? d.slice(0, 7) : null;
      const bar = (m, o, h, l, c) => {
        if (key) return add(key, sec(d), o, h, l, c);
        const b = Math.floor(m / step) * step;
        add(d + '|' + b, sec(d, b), o, h, l, c);
      };
      if (d === today && intra.length) {
        for (const c of intra) {
          const m = minuteOf(c[0]);
          if (m >= 0 && m < MPD) bar(m, c[1], c[2], c[3], c[4]);
        }
      } else {
        const a = data.spotDay(d);
        for (let m = 0; m < MPD; m++) bar(m, a[m * 4], a[m * 4 + 1], a[m * 4 + 2], a[m * 4 + 3]);
      }
    }
    for (const c of candles) for (let i = 1; i < 5; i++) c[i] = r2(c[i]);
    const prev = days.length > 1 ? data.spotDay(days[days.length - 2]) : null;
    return {
      tf: String(tf),
      candles,
      more,
      first: days[0] || null,
      day: days[days.length - 1] || null,
      today: intra.length > 0,
      prevClose: !older && prev ? r2(prev[(MPD - 1) * 4 + 3]) : null,
    };
  }

  // ---------- the Data screen's downloads ----------
  // What the cache lacks for a selection of expiries, downloading it, and the automatic update (sync.js).
  const sync = createSync({ data, getToken, file: path.join(path.dirname(storeFile), 'data-sync.json'), logError });

  // ---------- live deployment on the current chain ----------
  // The REST chain of a live expiry, at most 15 s old (fetched and cached by the server, shared with its screens).
  const liveChain = (expiry) => getRestChain(expiry, 15_000);

  // hitIn: an anomaly picked on the Anomalies screen (its strike / ref feed "signal" strikes).
  async function resolveLive(rawStrategy, shift = 0, hitIn = null) {
    const strat = normalizeStrategy(rawStrategy);
    const cal = await data.expiryCalendar();
    const live = cal.live;
    if (!live.length) throw new Error('No live expiries from Upstox');
    const warnings = [];
    const conds = strat.entry.when === 'signal' ? strat.entry.conditions : [];
    const needLv = conds.some((c) => c.kind.startsWith('sr')) || strat.legs.some((l) => l.strike.by === 'sr' || l.sl.type === 'srb' || l.tgt.type === 'srb');
    let lv = null;
    if (needLv) {
      try {
        lv = await levelsFor();
      } catch (e) {
        warnings.push('Support/resistance unavailable: ' + e.message);
      }
    }
    // Entry conditions evaluated on the live chain right now.
    let condState = null;
    let hit = hitIn;
    if (conds.length) {
      const env = liveScan?.env();
      if (!env) condState = { ok: false, notes: ['live chain not sampled yet'] };
      else condState = evaluate(conds, { ...env, prevClose: lv?.prev?.c ?? null, levels: lv });
      if (!hit && condState?.hit) hit = condState.hit;
      if (!hit) {
        const ac = conds.find((c) => c.kind === 'anomaly');
        if (ac)
          hit =
            (liveScan?.active() || []).find((h) => h.type === ac.type && (ac.side === 'any' || h.side === ac.side) && (ac.dir === 'any' || h.dir === ac.dir)) ||
            null;
      }
    }
    if (strat.legs.some((l) => l.strike.by === 'signal') && !hit) warnings.push('No live anomaly for the "signal" strikes right now — they are shown at ATM.');
    const base = live[Math.max(0, Math.min(live.length - 1, shift))];
    const monthly = live.filter((e) => cal.monthly.has(e));
    const nth = (list, n) => list.filter((e) => e >= base)[n] || null;
    const exp = (code) => (code === 'cur' ? nth(live, 0) : code === 'next' ? nth(live, 1) : code === 'mcur' ? nth(monthly, 0) : nth(monthly, 1));
    const chains = {};
    const legs = [];
    let spot = null;
    for (const def of strat.legs) {
      const expiry = exp(def.expiry);
      if (!expiry) throw new Error(`No live expiry for "${def.expiry}"`);
      const ch = (chains[expiry] ||= await liveChain(expiry));
      spot = spot ?? ch.spot;
      const rows = ch.rows.filter((r) => r.ce.ltp && r.pe.ltp);
      const ks = rows.map((r) => r.strike);
      const near = (x) => ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(ks[b] - x) ? j : b), 0);
      const ai = near(ch.spot);
      const otm = def.type === 'CE' ? 1 : -1;
      const sideOf = (r) => (def.type === 'CE' ? r.ce : r.pe);
      const v = def.strike.value;
      let idx;
      if (def.strike.by === 'atm') idx = ai + otm * Math.round(v);
      else if (def.strike.by === 'pct') idx = near(ch.spot * (1 + (otm * v) / 100));
      else if (def.strike.by === 'pts') idx = near(ch.spot + otm * v);
      else if (def.strike.by === 'straddle') idx = near(ks[ai] + otm * (rows[ai].ce.ltp + rows[ai].pe.ltp) * (v || 1));
      else if (def.strike.by === 'signal') {
        const b = def.strike.ref === 'ref' && hit?.ref != null ? hit.ref : hit?.strike;
        idx = b == null ? ai : near(b) + Math.round(v);
      } else if (def.strike.by === 'leg') {
        // another leg's strike ± points
        const b = legs[def.strike.ref]?.strikeValue;
        idx = b == null ? ai : near(b + v);
        if (b == null) warnings.push(`Leg ${legs.length + 1}: "from leg ${def.strike.ref + 1}" not resolved yet — shown at ATM`);
      } else if (def.strike.by === 'sr') {
        const n = nearestLevels(lv, ch.spot);
        const l = (def.type === 'CE' ? n.resistance : n.support)[def.strike.lv || 'any'];
        idx = (l ? near(l.price) : ai) + otm * Math.round(v);
      } else {
        const target = def.strike.by === 'delta' ? Math.abs(v > 1 ? v / 100 : v) : v;
        const val = (r) => (def.strike.by === 'delta' ? Math.abs(sideOf(r).delta ?? 0) : sideOf(r).ltp);
        const order = rows
          .map((r, j) => j)
          .filter((j) => (j - ai) * otm >= -4)
          .sort((a, b) => (a - b) * otm);
        if (def.strike.match === 'gte') idx = order.filter((j) => val(rows[j]) >= target).pop() ?? order[0];
        else if (def.strike.match === 'lte') idx = order.find((j) => val(rows[j]) <= target) ?? order[order.length - 1];
        else idx = order.reduce((b, j) => (Math.abs(val(rows[j]) - target) < Math.abs(val(rows[b]) - target) ? j : b), order[0]);
      }
      idx = Math.max(0, Math.min(rows.length - 1, idx));
      legs.push({ ...def, expiryDate: expiry, strikeValue: ks[idx], quote: sideOf(rows[idx]) });
    }
    // Rules the deploy view does not automate: scheduled rolls, and the entry checks (evaluated at today's LTPs).
    strat.legs.forEach((d, i) => {
      if (d.roll)
        warnings.push(
          `Leg ${i + 1} (${legs[i].strikeValue} ${d.type}, ${legs[i].expiryDate}) rolls into the next weekly expiry ${d.roll.dteDays} trading day${d.roll.dteDays === 1 ? '' : 's'} before it expires, at ${d.roll.time}: do it by hand (Builder: change its expiry).`,
        );
    });
    const F = strat.filters;
    if (F.minCredit != null || F.maxLossDown != null || F.maxLossUp != null) {
      const q = legs.map((l) => ({ dir: l.action === 'B' ? 1 : -1, n: l.lots, type: l.type, k: l.strikeValue, px: l.quote?.ltp || 0 }));
      const unit = Math.min(...q.map((l) => l.n));
      const at = (S) => q.reduce((a, l) => a + l.dir * l.n * (Math.max(0, l.type === 'CE' ? S - l.k : l.k - S) - l.px), 0) / unit;
      const credit = -q.reduce((a, l) => a + l.dir * l.n * l.px, 0) / unit;
      if (F.minCredit != null && credit < F.minCredit)
        warnings.push(`Entry check: net credit ${credit.toFixed(1)} pts is below ${F.minCredit} — the backtest would skip this week.`);
      if (F.maxLossDown != null && at(spot * 0.5) < -F.maxLossDown)
        warnings.push(`Entry check: downside not covered (${at(spot * 0.5).toFixed(1)} pts far below; limit −${F.maxLossDown}).`);
      if (F.maxLossUp != null && at(spot * 1.5) < -F.maxLossUp)
        warnings.push(`Entry check: upside not covered (${at(spot * 1.5).toFixed(1)} pts far above; limit −${F.maxLossUp}).`);
    }
    return {
      strategy: strat,
      spot,
      lot: cal.liveLot || 65,
      expiries: live.map((e) => ({ e, monthly: cal.monthly.has(e) })),
      base,
      legs,
      chains: Object.fromEntries(Object.entries(chains).map(([e, c]) => [e, c.rows])),
      warnings,
      conditions: condState ? { ok: condState.ok, notes: condState.notes } : null,
      hit: hit ? { type: hit.type, strike: hit.strike, ref: hit.ref ?? null, side: hit.side, dir: hit.dir, text: hit.text } : null,
      levels: lv ? nearestLevels(lv, spot) : null,
    };
  }

  // ---------- HTTP ----------
  async function readJson(req, limit = 500_000) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('Request too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function handle(req, res, url, sendJson) {
    const p = url.pathname;
    try {
      if (p === '/api/bt/meta') {
        let cal = null;
        let calError = null;
        try {
          cal = await data.expiryCalendar();
        } catch (e) {
          calError = e.message;
        }
        return sendJson(res, 200, {
          library: library(),
          originals: Object.fromEntries(LIBRARY.map((l) => [l.id, { ...normalizeStrategy(l), id: l.id }])),
          saved: saved(),
          anomalies: A.catalog(),
          calendar: cal ? { expired: cal.expired, live: cal.live, monthly: [...cal.monthly], liveLot: cal.liveLot } : null,
          calError,
        });
      }
      if (p === '/api/bt/strategies' && req.method === 'POST') return sendJson(res, 200, { ok: true, strategy: saveStrategy(await readJson(req)) });
      if (p === '/api/bt/strategies/delete' && req.method === 'POST') {
        deleteStrategy((await readJson(req)).id);
        return sendJson(res, 200, { ok: true });
      }
      // Reset an edited built-in strategy to the original (removes the edited copy).
      if (p === '/api/bt/strategies/reset' && req.method === 'POST') {
        const id = (await readJson(req)).id;
        if (!isLib(id)) throw new Error('Only built-in strategies can be reset');
        deleteStrategy(id);
        return sendJson(res, 200, { ok: true, strategy: findStrategy(id) });
      }
      if (p === '/api/sb/days') return sendJson(res, 200, await builderDays(url.searchParams.get('expiry'), url.searchParams.get('from')));
      if (p === '/api/sb/vo') {
        const ks = (url.searchParams.get('ks') || '')
          .split(',')
          .map(Number)
          .filter((x) => x > 0)
          .slice(0, 400);
        return sendJson(res, 200, await builderVo(url.searchParams.get('expiry'), url.searchParams.get('day'), ks));
      }
      if (p === '/api/sb/day') {
        const extra = (url.searchParams.get('extra') || '')
          .split(',')
          .map(Number)
          .filter((x) => x > 0);
        return sendJson(
          res,
          200,
          // width: strikes beyond the day's Nifty range each way; the Builder's "All strikes" sends more than any list has
          await builderDay(url.searchParams.get('expiry'), url.searchParams.get('day'), Math.min(999, Number(url.searchParams.get('width')) || 15), extra),
        );
      }
      if (p === '/api/sb/bees') {
        const day = url.searchParams.get('day');
        return sendJson(res, 200, { day, bees: await beesDay(day) });
      }
      if (p === '/api/sb/trades' && req.method !== 'POST') return sendJson(res, 200, { trades: readTrades() });
      if (p === '/api/sb/trades' && req.method === 'POST') return sendJson(res, 200, { trade: saveTrade(await readJson(req, 3_000_000)) });
      if (p === '/api/sb/trades/account' && req.method === 'POST') return sendJson(res, 200, { trade: setTradeAccount(await readJson(req)) });
      if (p === '/api/sb/trades/delete' && req.method === 'POST') {
        const id = (await readJson(req)).id;
        writeTrades(readTrades().filter((x) => x.id !== id));
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/bt/levels') {
        const lv = await levelsFor(url.searchParams.get('day'));
        return sendJson(res, 200, lv);
      }
      if (p === '/api/bt/candles') return sendJson(res, 200, await niftyCandles(url.searchParams.get('tf') || '5', url.searchParams.get('before')));
      if (p === '/api/bt/sync' || p.startsWith('/api/bt/sync/')) return await sync.handle(req, res, p, sendJson, readJson);
      if (p === '/api/bt/cache') return sendJson(res, 200, data.cacheStats());
      if (p === '/api/bt/cache/clear' && req.method === 'POST') {
        data.clearCache((await readJson(req)).what || 'options');
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/bt/resolve' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await resolveLive(b.strategy, Number(b.shift) || 0, b.hit || null));
      }
      if (p === '/api/bt/chain') {
        const c = await liveChain(url.searchParams.get('expiry'));
        return sendJson(res, 200, { spot: c.spot, rows: c.rows });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      logError('bt', e, p);
      return sendJson(res, 500, { error: e.message });
    }
  }

  return {
    handle,
    data,
    levelsFor,
    attachLive: (l) => {
      liveScan = l;
    },
  };
}

module.exports = { createBacktester };
