// Backtester HTTP API: runs, comparisons, saved strategies, live deployment of a strategy on the current
// option chain, and the historical-data cache. Long work runs as a job the page polls for progress.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createData, addDays } = require('./data');
const { runBacktest: runRaw, normalizeStrategy, wholeStrategyStops, MIN_OF } = require('./engine');
const { computeStats, regimeStats } = require('./metrics');
const { LIBRARY } = require('./library');
const { createHistChain } = require('./histchain');
const { createLevels, nearest: nearestLevels, extend: extendLevels } = require('./levels');
const { runScan, trim: trimScan } = require('./scan');
const { runTapeScan, tapeDays } = require('./tapescan');
const { buildScenarios, applyScenario } = require('./scenarios');
const { buildAdjustments } = require('./adjustments');

// Stop-losses judge the whole strategy's loss, never a single leg (engine.wholeStrategyStops): a leg's "% of premium"
// stop becomes a stop on the whole position at that % of the entry premium. The Bi-weekly screen follows the same rule.
const runBacktest = (data, strategy, ...rest) => runRaw(data, wholeStrategyStops(strategy), ...rest);
const { evaluate } = require('./conditions');
const A = require('./anomalies');
const { createResearch } = require('./research');
const { createBiweekly } = require('./biweekly');
const { createBackspread } = require('./backspread');
const { createSync } = require('./sync');
const { MPD } = require('./data');
const { istDate: istToday } = require('../lib/time');

// upstox: the app's Upstox client; getRestChain(expiry, maxAgeMs): the server's REST chain of a live expiry;
// tapeDir: where the live chain is recorded (tape.js), for the Arbitrage screen's quote scan.
// liveData(): the live source when it is not Upstox (see bt/data.js), or null.
function createBacktester({ getToken, upstox, getRestChain, cacheDir, storeFile, tapeDir = null, logError, liveData }) {
  const data = createData({ getToken, upstox, cacheDir, logError, live: liveData });
  const hist = createHistChain(data);
  const levels = createLevels();
  const ext = { hist, levels };
  let liveScan = null; // live anomaly scanner, attached by the server
  const researcher = createResearch({ logError });

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
    };
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
    writeTrades(old ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]);
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

  // ---------- jobs ----------
  const jobs = new Map();
  function startJob(kind, fn) {
    const id = Math.random().toString(36).slice(2, 10);
    const job = { id, kind, status: 'running', progress: { phase: 'Starting', done: 0, total: 0 }, startedAt: Date.now() };
    jobs.set(id, job);
    while (jobs.size > 12) jobs.delete(jobs.keys().next().value);
    job.promise = fn(job)
      .then((r) => {
        job.result = r;
        job.status = 'done';
        job.ms = Date.now() - job.startedAt;
      })
      .catch((e) => {
        job.status = 'error';
        job.error = e.message;
        if (!e.cancelled) logError('bt-' + kind, e);
      });
    return job;
  }
  // Cached runs finish in milliseconds: answer with the result directly instead of making the page poll.
  async function settle(job, ms = 1500) {
    await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
    return jobView(job);
  }
  const jobView = (job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    error: job.error,
    ms: job.ms,
    progress: { ...job.progress, api: data.apiStats() },
    result: job.status === 'done' ? job.result.view : undefined,
  });

  // The shared caches plus the job's Stop button (job.stop, set by POST /api/bt/job/stop).
  const extOf = (job) => ({ ...ext, stopped: () => Boolean(job.stop) });
  const cancelled = () => Object.assign(new Error('Stopped'), { cancelled: true });

  async function runOne(job, strategy, opts, label = '') {
    const r = await runBacktest(
      data,
      strategy,
      opts,
      (p) => {
        job.progress = { ...p, phase: label + p.phase };
      },
      extOf(job),
    );
    const stats = computeStats(r.trades, r.opts.capital);
    return { ...r, stats };
  }

  function startRun(strategy, opts) {
    return startJob('run', async (job) => {
      const r = await runOne(job, strategy, opts);
      job.paths = r.paths;
      return {
        view: {
          strategy: r.strategy,
          opts: r.opts,
          stats: r.stats,
          trades: r.trades,
          skipped: r.skipped.slice(0, 200),
          skippedCount: r.skipped.length,
          considered: r.considered,
          noSignal: r.noSignal,
        },
      };
    });
  }

  // ---------- scenario scan ----------
  // The strategy as defined, then every profit-target × stop-loss × exit combination (scenarios.js). Only the
  // headline numbers of each run are kept; the page re-runs the scenario it wants to look at in detail.
  // Expired data never changes, so a scan is kept (memory + bt-data/scenario-cache.json) until the strategy, the
  // settings or the last expired expiry change: the all-strategies overview and repeat runs are then instant.
  const SCAN_VERSION = 11; // bump when the engine or the scenario grid changes what a scan returns
  const scanFile = path.join(path.dirname(storeFile), 'scenario-cache.json');
  let scanCache = null;
  function scans() {
    if (!scanCache) {
      try {
        scanCache = new Map(Object.entries(JSON.parse(fs.readFileSync(scanFile, 'utf8'))));
      } catch {
        scanCache = new Map();
      }
    }
    return scanCache;
  }
  function saveScans() {
    while (scanCache.size > 80) scanCache.delete(scanCache.keys().next().value);
    try {
      fs.mkdirSync(path.dirname(scanFile), { recursive: true });
      fs.writeFileSync(scanFile + '.tmp', JSON.stringify(Object.fromEntries(scanCache)));
      fs.renameSync(scanFile + '.tmp', scanFile);
    } catch (e) {
      logError('bt-scenario-cache', e);
    }
  }
  const scanKey = (strategy, opts, cal) =>
    crypto
      .createHash('sha1')
      .update(JSON.stringify([SCAN_VERSION, wholeStrategyStops(strategy), opts, cal.expired[cal.expired.length - 1]]))
      .digest('hex');

  // On cached data a backtest never waits for I/O, so a long series of them would keep the server from answering
  // anything else (the page's progress polls included): let the event loop run between two backtests.
  const breathe = () => new Promise((r) => setImmediate(r));

  async function scanScenarios(job, strategy, opts, { label = '', persist = true, progress = true } = {}) {
    const cal = await data.expiryCalendar();
    const key = scanKey(strategy, opts, cal);
    const hit = scans().get(key);
    if (hit) return hit;
    const say = (p) => {
      if (progress) job.progress = p;
      else job.progress = { ...job.progress, phase: label + p.phase + (p.total ? ` ${p.done}/${p.total}` : '') };
    };
    const base = await runBacktest(data, strategy, opts, (p) => say({ ...p, phase: 'As defined · ' + p.phase }), extOf(job));
    const lite = (r) => ({
      stats: Object.fromEntries(Object.entries(computeStats(r.trades, r.opts.capital)).filter(([, v]) => v == null || typeof v !== 'object')),
      skippedCount: r.skipped.length,
    });
    const prems = base.trades.map((t) => t.premium).sort((a, b) => a - b);
    const debit = prems.length ? prems[prems.length >> 1] < 0 : false;
    const list = buildScenarios(base.strategy, debit);
    const own = list.find((x) => x.base);
    const rows = [{ ...own, ...lite(base) }];
    // No trades as defined: the entries are the same in every scenario, so there is nothing to compare.
    const todo = base.trades.length ? list.filter((x) => x !== own) : [];
    for (const [i, sc] of todo.entries()) {
      if (job.stop) throw cancelled();
      say({ phase: 'Testing scenarios', done: i, total: todo.length });
      await breathe();
      try {
        rows.push({ ...sc, ...lite(await runBacktest(data, applyScenario(base.strategy, sc), opts, () => {}, extOf(job))) });
      } catch (e) {
        if (e.cancelled) throw e;
        logError('bt-scenario', e, sc.key);
      }
    }
    const view = {
      strategy: base.strategy,
      opts: base.opts,
      debit,
      scenarios: rows,
      considered: base.considered,
      noSignal: base.noSignal,
      skipped: base.skipped.slice(0, 200),
      at: Date.now(),
    };
    scans().set(key, view);
    if (persist) saveScans();
    return view;
  }
  // ---------- saved backtests ----------
  // The result of every "Run backtest" is kept in bt-data/backtests.json, one entry per strategy (its id, else its
  // name): the scenario scan, the full run of its best scenario and, once tested, its adjustment variations. The
  // Backtest screen opens on these (Summary tab) and shows them without running anything again.
  const resultsFile = path.join(path.dirname(storeFile), 'backtests.json');
  let results = null;
  function savedResults() {
    if (!results) {
      try {
        results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      } catch {
        results = {};
      }
    }
    return results;
  }
  function writeResults() {
    try {
      fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
      fs.writeFileSync(resultsFile + '.tmp', JSON.stringify(results));
      fs.renameSync(resultsFile + '.tmp', resultsFile);
    } catch (e) {
      logError('bt-results', e);
    }
  }
  const resultKey = (s) => s.id || 'name:' + String(s.name || 'Untitled');
  const bestOf = (rows) => rows.reduce((b, x) => (x.stats.trades && x.stats.total > b.stats.total ? x : b), rows[0]);
  const runView = (r) => ({
    strategy: r.strategy,
    opts: r.opts,
    stats: r.stats,
    trades: r.trades,
    skipped: r.skipped.slice(0, 200),
    skippedCount: r.skipped.length,
    considered: r.considered,
    noSignal: r.noSignal,
  });
  async function saveResult(job, strategy, opts, view) {
    const best = bestOf(view.scenarios);
    const detail = runView(await runOne(job, applyScenario(view.strategy, best), opts, 'Saving · '));
    const key = resultKey(strategy);
    const lib = strategy.id && findStrategy(strategy.id);
    savedResults()[key] = {
      key,
      id: strategy.id || null,
      name: view.strategy.name,
      category: strategy.id?.startsWith('my-') ? 'Mine' : lib?.category || view.strategy.category,
      at: Date.now(),
      optsRaw: opts,
      scan: view,
      detail,
      detailKey: best.key,
      adj: null,
    };
    writeResults();
  }
  // A backtest saved before trades carried Nifty's range and India VIX at entry: both are read back from the
  // cached index candles when it is opened (in memory only), so its Breakdown tab shows the market regime too.
  async function addRegime(view) {
    const T = view?.trades;
    if (!T?.length || view.stats?.regime) return;
    const r2 = (x) => Math.round(x * 100) / 100;
    try {
      const from = T.reduce((a, t) => (t.entryDay < a ? t.entryDay : a), T[0].entryDay);
      const to = T.reduce((a, t) => (t.exitDay > a ? t.exitDay : a), T[0].exitDay);
      const days = await data.loadIndex(from, to, 'soft');
      const at = new Map(days.map((d, i) => [d, i]));
      for (const t of T) {
        const e0 = MIN_OF(t.entryTime);
        const v = t.vix == null ? data.vixDay(t.entryDay) : null;
        if (v) t.vix = r2(v[e0 * 4]);
        const i0 = at.get(t.entryDay);
        const i1 = at.get(t.exitDay);
        if (t.spotHi != null || i0 == null || i1 == null || t.spotOut == null) continue;
        let hi = Math.max(t.spotIn, t.spotOut);
        let lo = Math.min(t.spotIn, t.spotOut);
        for (let i = i0; i <= i1; i++) {
          const sp = data.spotDay(days[i]);
          const m1 = i === i1 ? Math.min(MPD - 1, MIN_OF(t.exitTime)) : MPD - 1;
          for (let m = i === i0 ? e0 : 0; m <= m1; m++) {
            hi = Math.max(hi, sp[m * 4 + 3]);
            lo = Math.min(lo, sp[m * 4 + 3]);
          }
        }
        Object.assign(t, { spotHi: r2(hi), spotLo: r2(lo), sessions: i1 - i0 + 1 });
      }
      view.stats.regime = regimeStats(T);
    } catch (e) {
      logError('bt-regime', e);
    }
  }

  // The five best different outcomes among a strategy's scenarios (the Summary tab's "top 5 variants"): headline numbers only.
  const topVariants = (rows, n = 5) => {
    const seen = new Set();
    return rows
      .filter((x) => x.stats.trades)
      .sort((a, b) => b.stats.total - a.stats.total)
      .filter((x) => {
        const sig = [x.stats.trades, x.stats.total, x.stats.gross, x.stats.wins, x.stats.maxDD].join('|'); // a rule that never fired repeats the result
        return !seen.has(sig) && seen.add(sig);
      })
      .slice(0, n)
      .map((x) => ({
        key: x.key,
        own: Boolean(x.own),
        tgt: x.tgt,
        sl: x.sl,
        exit: x.exit,
        stats: Object.fromEntries(Object.entries(x.stats).filter(([, v]) => v == null || typeof v !== 'object')),
      }));
  };
  // What the Summary tab lists: the headline numbers only.
  const resultSummary = (e) => ({
    key: e.key,
    id: e.id,
    name: e.name,
    category: e.category,
    at: e.at,
    opts: e.scan.opts,
    strategy: e.scan.strategy,
    debit: e.scan.debit,
    tested: e.scan.scenarios.length,
    own: e.scan.scenarios[0],
    best: bestOf(e.scan.scenarios),
    variants: topVariants(e.scan.scenarios.slice()),
    adjustments: e.adj ? e.adj.rows.length : 0,
  });

  // save: this is a "Run backtest" (not a look at a variation): keep the result.
  const startScenarios = (strategy, opts, save) =>
    startJob('scenarios', async (job) => {
      const view = await scanScenarios(job, strategy, opts);
      if (save) await saveResult(job, strategy, opts, view);
      return { view };
    });

  // Adjustment variations of a strategy (adjustments.js), each run as defined: one row of headline numbers per
  // variation, with the complete strategy so the page can open any of them in detail. Cached like the scans.
  function startAdjustments(strategy, opts, save) {
    return startJob('adjustments', async (job) => {
      const cal = await data.expiryCalendar();
      const key = 'adj-' + scanKey(strategy, opts, cal);
      const keep = (view) => {
        // attach to the saved backtest of the same strategy and settings
        const e = save && savedResults()[resultKey(strategy)];
        if (e && JSON.stringify(e.optsRaw) === JSON.stringify(opts)) {
          e.adj = view;
          writeResults();
        }
        return { view };
      };
      const hit = scans().get(key);
      if (hit) return keep(hit);
      const list = buildAdjustments(strategy);
      const rows = [];
      for (const [i, v] of list.entries()) {
        if (job.stop) throw cancelled();
        job.progress = { phase: 'Testing adjustments · ' + v.name, done: i, total: list.length };
        await breathe();
        try {
          const r = await runBacktest(data, v.strategy, opts, () => {}, extOf(job));
          const st = computeStats(r.trades, r.opts.capital);
          rows.push({
            ...v,
            stats: Object.fromEntries(Object.entries(st).filter(([, x]) => x == null || typeof x !== 'object')),
            skippedCount: r.skipped.length,
          });
        } catch (e) {
          if (e.cancelled) throw e;
          rows.push({ ...v, error: e.message });
          logError('bt-adjust', e, v.key);
        }
      }
      const view = { rows, at: Date.now() };
      // A run that failed for missing data (not logged in) is not kept: it should be retried.
      if (!rows.some((x) => x.error)) {
        scans().set(key, view);
        saveScans();
        return keep(view);
      }
      return { view };
    });
  }

  // "Backtest all strategies": every saved and built-in strategy scanned with the same settings and saved.
  // One runs at a time; asking again for the same settings joins the running job.
  let overviewJob = null;
  function startOverview(opts) {
    const tag = JSON.stringify(opts);
    if (overviewJob?.status === 'running' && overviewJob.tag === tag) return overviewJob;
    overviewJob = startJob('overview', async (job) => {
      const list = [...saved(), ...library()];
      const failed = [];
      let stopped = false;
      for (const [i, s] of list.entries()) {
        if (job.stop) {
          stopped = true;
          break;
        }
        const label = `${i + 1}/${list.length} ${s.name} · `;
        job.progress = { phase: label + 'starting', done: i, total: list.length };
        try {
          const view = await scanScenarios(job, s, opts, { label, persist: false, progress: false });
          await saveResult({ progress: {} }, s, opts, view);
        } catch (e) {
          if (e.cancelled) {
            stopped = true; // the strategy in progress is dropped; the ones before it are already saved
            break;
          }
          failed.push({ name: s.name, error: e.message });
          logError('bt-overview', e, s.name);
        }
      }
      saveScans();
      return { view: { done: list.length - failed.length, failed, stopped } };
    });
    overviewJob.tag = tag;
    return overviewJob;
  }

  // The last history scan of the Arbitrage screen is kept per source — the 1-minute candles (bt-data/
  // anomaly-scan.json) and the recorded quotes (anomaly-scan-quotes.json) — so the screen opens on it without
  // scanning again.
  const anScanFile = (source) => path.join(path.dirname(storeFile), source === 'quotes' ? 'anomaly-scan-quotes.json' : 'anomaly-scan.json');
  const lastScans = {}; // source -> scan, null when there is none (absent = not read yet)
  const SCAN_FORMAT = 2; // bump when what a scan returns changes: an older saved scan is then not shown
  function savedScan(source) {
    if (lastScans[source] === undefined) {
      try {
        lastScans[source] = JSON.parse(fs.readFileSync(anScanFile(source), 'utf8'));
      } catch {
        lastScans[source] = null;
      }
    }
    return lastScans[source]?.v === SCAN_FORMAT ? lastScans[source] : null;
  }
  function startScan(cfg) {
    const source = cfg.source === 'quotes' ? 'quotes' : 'candles';
    return startJob('scan', async (job) => {
      const t0 = Date.now();
      const progress = (p) => {
        job.progress = p;
      };
      const stopped = () => Boolean(job.stop);
      let r;
      if (source === 'quotes') {
        if (!tapeDir) throw new Error('No recordings folder is configured');
        const lotSize = cfg.lotSize || (await data.expiryCalendar().catch(() => null))?.liveLot;
        r = await runTapeScan(tapeDir, { ...cfg, lotSize }, progress, stopped);
      } else r = await runScan(data, hist, cfg, progress, stopped);
      const scan = { ...r, hits: trimScan(r.hits), hitsTotal: r.hits.length, savedAt: Date.now(), ms: Date.now() - t0, v: SCAN_FORMAT };
      lastScans[source] = scan;
      try {
        fs.mkdirSync(path.dirname(anScanFile(source)), { recursive: true });
        fs.writeFileSync(anScanFile(source) + '.tmp', JSON.stringify(scan));
        fs.renameSync(anScanFile(source) + '.tmp', anScanFile(source));
      } catch (e) {
        logError('anomaly-scan', e);
      }
      return { view: scan };
    });
  }

  function startCompare(list, opts) {
    return startJob('compare', async (job) => {
      const runs = [];
      for (let i = 0; i < list.length; i++) {
        const s = typeof list[i] === 'string' ? findStrategy(list[i]) : list[i];
        if (!s) continue;
        try {
          const r = await runOne(job, s, opts, `${i + 1}/${list.length} ${s.name} · `);
          runs.push({ strategy: r.strategy, stats: r.stats, skippedCount: r.skipped.length });
        } catch (e) {
          runs.push({ strategy: normalizeStrategy(s), error: e.message });
        }
      }
      return { view: { runs, opts } };
    });
  }

  // ---------- the Data screen's downloads ----------
  // What the cache lacks for a selection of expiries, downloading it, and the automatic update (sync.js).
  const sync = createSync({ data, getToken, file: path.join(path.dirname(storeFile), 'data-sync.json'), logError });

  // ---------- the Bi-weekly screen ----------
  const bw = createBiweekly({ data, ext, dir: path.dirname(storeFile), startJob, settle, breathe, findStrategy, library, logError });
  const bsp = createBackspread({ data, ext, startJob, settle, dir: path.dirname(storeFile), logError });

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
      if (p === '/api/bt/scan/last') return sendJson(res, 200, { scan: savedScan(url.searchParams.get('source') === 'quotes' ? 'quotes' : 'candles') });
      if (p === '/api/bt/scan/tapes') return sendJson(res, 200, { days: tapeDir ? tapeDays(tapeDir) : [] }); // sessions with recorded quotes
      if (p === '/api/bt/scan' && req.method === 'POST') return sendJson(res, 200, await settle(startScan(await readJson(req)), 3000));
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
      if (p === '/api/sb/trades' && req.method !== 'POST') return sendJson(res, 200, { trades: readTrades() });
      if (p === '/api/sb/trades' && req.method === 'POST') return sendJson(res, 200, { trade: saveTrade(await readJson(req, 3_000_000)) });
      if (p === '/api/sb/trades/delete' && req.method === 'POST') {
        const id = (await readJson(req)).id;
        writeTrades(readTrades().filter((x) => x.id !== id));
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/sb/research' && req.method === 'POST') return sendJson(res, 200, await researcher.research((await readJson(req)).summary));
      if (p === '/api/bt/levels') {
        const lv = await levelsFor(url.searchParams.get('day'));
        return sendJson(res, 200, lv);
      }
      if (p === '/api/bt/candles') return sendJson(res, 200, await niftyCandles(url.searchParams.get('tf') || '5', url.searchParams.get('before')));
      if (p === '/api/bt/run' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await settle(startRun(b.scenario ? applyScenario(b.strategy, b.scenario) : b.strategy, b.opts || {})));
      }
      if (p === '/api/bt/scenarios' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await settle(startScenarios(b.strategy, b.opts || {}, Boolean(b.save))));
      }
      if (p === '/api/bt/adjustments' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await settle(startAdjustments(b.strategy, b.opts || {}, Boolean(b.save))));
      }
      if (p === '/api/bt/results' && req.method !== 'POST') return sendJson(res, 200, { results: Object.values(savedResults()).map(resultSummary) });
      if (p === '/api/bt/result') {
        const e = savedResults()[url.searchParams.get('key')];
        if (e) await addRegime(e.detail);
        return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: 'No saved backtest for this strategy — run it' });
      }
      if (p === '/api/bt/results/delete' && req.method === 'POST') {
        delete savedResults()[(await readJson(req)).key];
        writeResults();
        return sendJson(res, 200, { ok: true });
      }
      if (p.startsWith('/api/bt/bw/')) return await bw.handle(req, res, p, sendJson, readJson);
      if (p.startsWith('/api/bt/bs/')) return await bsp.handle(req, res, p, sendJson, readJson);
      if (p === '/api/bt/overview' && req.method === 'POST') return sendJson(res, 200, await settle(startOverview((await readJson(req)).opts || {})));
      if (p === '/api/bt/compare' && req.method === 'POST') {
        const b = await readJson(req, 2_000_000);
        if (!Array.isArray(b.strategies) || !b.strategies.length) throw new Error('Pick at least one strategy');
        return sendJson(res, 200, await settle(startCompare(b.strategies.slice(0, 30), b.opts || {})));
      }
      if (p === '/api/bt/sync' || p.startsWith('/api/bt/sync/')) return await sync.handle(req, res, p, sendJson, readJson);
      if (p === '/api/bt/job/stop' && req.method === 'POST') {
        // the job ends at its next checkpoint, with what it has so far
        const job = jobs.get((await readJson(req)).id);
        if (job) job.stop = true;
        return sendJson(res, 200, { ok: Boolean(job) });
      }
      if (p === '/api/bt/job') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return sendJson(res, 404, { error: 'Job not found (the server may have restarted) — run it again' });
        return sendJson(res, 200, jobView(job));
      }
      if (p === '/api/bt/trade') {
        const job = jobs.get(url.searchParams.get('job'));
        const i = Number(url.searchParams.get('i'));
        if (!job?.paths?.[i]) return sendJson(res, 404, { error: 'Trade not found — run the backtest again' });
        return sendJson(res, 200, { trade: job.result.view.trades[i], path: job.paths[i] });
      }
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
