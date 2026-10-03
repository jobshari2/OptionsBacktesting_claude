// Backtester HTTP API: runs, comparisons, saved strategies, live deployment of a strategy on the current
// option chain, and the historical-data cache. Long work runs as a job the page polls for progress.
const fs = require('fs');
const path = require('path');
const { createData, addDays } = require('./data');
const { runBacktest, normalizeStrategy } = require('./engine');
const { computeStats } = require('./metrics');
const { LIBRARY } = require('./library');
const { createHistChain } = require('./histchain');
const { createLevels, nearest: nearestLevels } = require('./levels');
const { runScan } = require('./scan');
const { evaluate } = require('./conditions');
const A = require('./anomalies');
const { createResearch } = require('./research');
const { MPD } = require('./data');

function createBacktester({ getToken, upstoxGet, cacheDir, storeFile, logError }) {
  const data = createData({ getToken, cacheDir, logError });
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
    for (let m = 0; m < MPD; m++) { lo = Math.min(lo, sp[m * 4 + 2]); hi = Math.max(hi, sp[m * 4 + 1]); }
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
    const tasks = ks.flatMap((k) => [[k, 'CE'], [k, 'PE']]);
    const res = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (next < tasks.length) { const [k, t] = tasks[next++]; res.set(k + t, await series(k, t)); } }));
    return {
      expiry, day, ks, lot: info.lot,
      spot: Array.from({ length: MPD }, (_, m) => Math.round(sp[m * 4 + 3] * 100) / 100),
      ce: ks.map((k) => res.get(k + 'CE')), pe: ks.map((k) => res.get(k + 'PE')),
    };
  }

  // ---------- saved strategies ----------
  // The store holds the user's own strategies ("my-…") and edited copies of built-in ones, saved under the
  // built-in's id ("lib-…"); an edited built-in replaces the original everywhere until it is reset.
  function readStore() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return []; }
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
    if (i >= 0) list[i] = strat; else list.push(strat);
    writeStore(list);
    return strat;
  }
  function deleteStrategy(id) {
    writeStore(readStore().filter((x) => x.id !== id));
  }
  function library() {
    const edits = new Map(readStore().filter((x) => isLib(x.id)).map((x) => [x.id, x]));
    return LIBRARY.map((l) => (edits.has(l.id) ? { ...normalizeStrategy(edits.get(l.id)), id: l.id, edited: true, updatedAt: edits.get(l.id).updatedAt } : { ...normalizeStrategy(l), id: l.id }));
  }
  const saved = () => readStore().filter((x) => !isLib(x.id));
  const findStrategy = (id) => library().find((x) => x.id === id) || saved().find((x) => x.id === id);

  // ---------- support / resistance ----------
  const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  let liveLv = { at: 0, day: null, lv: null };
  // Levels for `day` (default today) from the sessions before it.
  async function levelsFor(day) {
    const today = istToday();
    day = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today ? day : today;
    if (day === today && liveLv.day === day && Date.now() - liveLv.at < 10 * 60_000) return liveLv.lv;
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
    const out = { ...lv, spot: data.spotDay(day)?.[0] ?? lv.prev.c };
    if (day === today) liveLv = { at: Date.now(), day, lv: out };
    return out;
  }

  // ---------- jobs ----------
  const jobs = new Map();
  function startJob(kind, fn) {
    const id = Math.random().toString(36).slice(2, 10);
    const job = { id, kind, status: 'running', progress: { phase: 'Starting', done: 0, total: 0 }, startedAt: Date.now() };
    jobs.set(id, job);
    while (jobs.size > 12) jobs.delete(jobs.keys().next().value);
    job.promise = fn(job)
      .then((r) => { job.result = r; job.status = 'done'; job.ms = Date.now() - job.startedAt; })
      .catch((e) => { job.status = 'error'; job.error = e.message; logError('bt-' + kind, e); });
    return job;
  }
  // Cached runs finish in milliseconds: answer with the result directly instead of making the page poll.
  async function settle(job, ms = 1500) {
    await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
    return jobView(job);
  }
  const jobView = (job) => ({
    id: job.id, kind: job.kind, status: job.status, error: job.error, ms: job.ms,
    progress: { ...job.progress, api: data.apiStats() },
    result: job.status === 'done' ? job.result.view : undefined,
  });

  async function runOne(job, strategy, opts, label = '') {
    const r = await runBacktest(data, strategy, opts, (p) => { job.progress = { ...p, phase: label + p.phase }; }, ext);
    const stats = computeStats(r.trades, r.opts.capital);
    return { ...r, stats };
  }

  function startRun(strategy, opts) {
    return startJob('run', async (job) => {
      const r = await runOne(job, strategy, opts);
      job.paths = r.paths;
      return { view: { strategy: r.strategy, opts: r.opts, stats: r.stats, trades: r.trades, skipped: r.skipped.slice(0, 200), skippedCount: r.skipped.length, considered: r.considered, noSignal: r.noSignal } };
    });
  }

  function startScan(cfg) {
    return startJob('scan', async (job) => {
      const r = await runScan(data, hist, cfg, (p) => { job.progress = p; });
      return { view: { ...r, hits: r.hits.slice(-5000), hitsTotal: r.hits.length } };
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

  // Download option candles around the Nifty path for a range of expiries, so later runs are instant.
  function startPrefetch({ from, to, band = 20, daysBefore = 5 }) {
    return startJob('prefetch', async (job) => {
      const cal = await data.expiryCalendar();
      const list = cal.expired.filter((e) => e >= from && e <= to);
      if (!list.length) throw new Error('No expired expiries in that range');
      job.progress = { phase: 'Loading Nifty history', done: 0, total: 0 };
      const days = await data.loadIndex(addDays(list[0], -60), list[list.length - 1]);
      const dayIdx = new Map(days.map((d, i) => [d, i]));
      const tasks = [];
      for (const e of list) {
        if (!dayIdx.has(e)) continue;
        const info = await data.contracts(e);
        const i = dayIdx.get(e);
        const win = days.slice(Math.max(0, i - Math.max(0, daysBefore)), i + 1);
        let lo = Infinity;
        let hi = -Infinity;
        for (const d of win) {
          const s = data.spotDay(d);
          for (let m = 0; m < s.length / 4; m++) { lo = Math.min(lo, s[m * 4 + 2]); hi = Math.max(hi, s[m * 4 + 1]); }
        }
        const ks = info.strikes;
        const near = (x) => ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(ks[b] - x) ? j : b), 0);
        const a = Math.max(0, near(lo) - band);
        const b = Math.min(ks.length - 1, near(hi) + band);
        for (let j = a; j <= b; j++) for (const t of ['CE', 'PE']) tasks.push([e, ks[j], t, win[0]]);
      }
      let done = 0;
      let failed = 0;
      let next = 0;
      job.progress = { phase: 'Downloading option candles', done, total: tasks.length };
      const worker = async () => {
        while (next < tasks.length) {
          const [e, k, t, d] = tasks[next++];
          try { await data.option(e, k, t, d); } catch (err) { failed++; logError('bt-prefetch', err, `${e} ${k}${t}`); }
          done++;
          job.progress = { phase: `Downloading option candles · ${e}`, done, total: tasks.length, failed };
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      return { view: { expiries: list.length, contracts: tasks.length, failed } };
    });
  }

  // ---------- live deployment on the current chain ----------
  const chainCache = new Map();
  async function liveChain(expiry) {
    const hit = chainCache.get(expiry);
    if (hit && Date.now() - hit.at < 15_000) return hit;
    const rows = await upstoxGet('/option/chain', { instrument_key: data.NIFTY, expiry_date: expiry });
    const side = (o) => ({
      ltp: o?.market_data?.ltp ?? null, bid: o?.market_data?.bid_price || null, ask: o?.market_data?.ask_price || null,
      oi: o?.market_data?.oi ?? 0, iv: o?.option_greeks?.iv ?? null, delta: o?.option_greeks?.delta ?? null,
      gamma: o?.option_greeks?.gamma ?? null, theta: o?.option_greeks?.theta ?? null, vega: o?.option_greeks?.vega ?? null,
    });
    const out = {
      at: Date.now(),
      spot: rows?.[0]?.underlying_spot_price ?? null,
      rows: (rows || []).map((r) => ({ strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) })).sort((a, b) => a.strike - b.strike),
    };
    chainCache.set(expiry, out);
    return out;
  }

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
      try { lv = await levelsFor(); } catch (e) { warnings.push('Support/resistance unavailable: ' + e.message); }
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
        if (ac) hit = (liveScan?.active() || []).find((h) => h.type === ac.type && (ac.side === 'any' || h.side === ac.side) && (ac.dir === 'any' || h.dir === ac.dir)) || null;
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
      } else if (def.strike.by === 'leg') { // another leg's strike ± points
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
        const order = rows.map((r, j) => j).filter((j) => (j - ai) * otm >= -4).sort((a, b) => (a - b) * otm);
        if (def.strike.match === 'gte') idx = order.filter((j) => val(rows[j]) >= target).pop() ?? order[0];
        else if (def.strike.match === 'lte') idx = order.find((j) => val(rows[j]) <= target) ?? order[order.length - 1];
        else idx = order.reduce((b, j) => (Math.abs(val(rows[j]) - target) < Math.abs(val(rows[b]) - target) ? j : b), order[0]);
      }
      idx = Math.max(0, Math.min(rows.length - 1, idx));
      legs.push({ ...def, expiryDate: expiry, strikeValue: ks[idx], quote: sideOf(rows[idx]) });
    }
    // Rules the deploy view does not automate: scheduled rolls, and the entry checks (evaluated at today's LTPs).
    strat.legs.forEach((d, i) => {
      if (d.roll) warnings.push(`Leg ${i + 1} (${legs[i].strikeValue} ${d.type}, ${legs[i].expiryDate}) rolls into the next weekly expiry ${d.roll.dteDays} trading day${d.roll.dteDays === 1 ? '' : 's'} before it expires, at ${d.roll.time}: do it by hand (Builder: change its expiry).`);
    });
    const F = strat.filters;
    if (F.minCredit != null || F.maxLossDown != null || F.maxLossUp != null) {
      const q = legs.map((l) => ({ dir: l.action === 'B' ? 1 : -1, n: l.lots, type: l.type, k: l.strikeValue, px: l.quote?.ltp || 0 }));
      const unit = Math.min(...q.map((l) => l.n));
      const at = (S) => q.reduce((a, l) => a + l.dir * l.n * (Math.max(0, l.type === 'CE' ? S - l.k : l.k - S) - l.px), 0) / unit;
      const credit = -q.reduce((a, l) => a + l.dir * l.n * l.px, 0) / unit;
      if (F.minCredit != null && credit < F.minCredit) warnings.push(`Entry check: net credit ${credit.toFixed(1)} pts is below ${F.minCredit} — the backtest would skip this week.`);
      if (F.maxLossDown != null && at(spot * 0.5) < -F.maxLossDown) warnings.push(`Entry check: downside not covered (${at(spot * 0.5).toFixed(1)} pts far below; limit −${F.maxLossDown}).`);
      if (F.maxLossUp != null && at(spot * 1.5) < -F.maxLossUp) warnings.push(`Entry check: upside not covered (${at(spot * 1.5).toFixed(1)} pts far above; limit −${F.maxLossUp}).`);
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
        try { cal = await data.expiryCalendar(); } catch (e) { calError = e.message; }
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
      if (p === '/api/bt/strategies/delete' && req.method === 'POST') { deleteStrategy((await readJson(req)).id); return sendJson(res, 200, { ok: true }); }
      // Reset an edited built-in strategy to the original (removes the edited copy).
      if (p === '/api/bt/strategies/reset' && req.method === 'POST') {
        const id = (await readJson(req)).id;
        if (!isLib(id)) throw new Error('Only built-in strategies can be reset');
        deleteStrategy(id);
        return sendJson(res, 200, { ok: true, strategy: findStrategy(id) });
      }
      if (p === '/api/bt/scan' && req.method === 'POST') return sendJson(res, 200, await settle(startScan(await readJson(req)), 3000));
      if (p === '/api/sb/days') return sendJson(res, 200, await builderDays(url.searchParams.get('expiry'), url.searchParams.get('from')));
      if (p === '/api/sb/day') {
        const extra = (url.searchParams.get('extra') || '').split(',').map(Number).filter((x) => x > 0);
        return sendJson(res, 200, await builderDay(url.searchParams.get('expiry'), url.searchParams.get('day'), Math.min(30, Number(url.searchParams.get('width')) || 15), extra));
      }
      if (p === '/api/sb/research' && req.method === 'POST') return sendJson(res, 200, await researcher.research((await readJson(req)).summary));
      if (p === '/api/bt/levels') {
        const lv = await levelsFor(url.searchParams.get('day'));
        return sendJson(res, 200, lv);
      }
      if (p === '/api/bt/run' && req.method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await settle(startRun(b.strategy, b.opts || {})));
      }
      if (p === '/api/bt/compare' && req.method === 'POST') {
        const b = await readJson(req, 2_000_000);
        if (!Array.isArray(b.strategies) || !b.strategies.length) throw new Error('Pick at least one strategy');
        return sendJson(res, 200, await settle(startCompare(b.strategies.slice(0, 30), b.opts || {})));
      }
      if (p === '/api/bt/prefetch' && req.method === 'POST') return sendJson(res, 200, jobView(startPrefetch(await readJson(req))));
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
      if (p === '/api/bt/cache/clear' && req.method === 'POST') { data.clearCache((await readJson(req)).what || 'options'); return sendJson(res, 200, { ok: true }); }
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

  return { handle, data, levelsFor, attachLive: (l) => { liveScan = l; } };
}

module.exports = { createBacktester };
