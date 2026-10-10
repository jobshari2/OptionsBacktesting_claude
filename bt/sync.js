// Keeps the historical-data cache complete. For a selection of expired expiries it works out which option candles
// the cache does not hold yet (calls and puts of every strike within `band` strikes of the Nifty range over the
// last `daysBefore` trading days before the expiry), downloads them as one job, and, while the server runs, does
// that by itself for newly expired expiries. Steered from the Data screen (public/data-view.js).
const fs = require('fs');
const path = require('path');
const { addDays } = require('./data');
const { istDate: istToday } = require('../lib/time');

const AUTO_EVERY_MS = 30 * 60_000; // how often the automatic update looks for new data
const AUTO_RETRY_MS = 5 * 60_000; // … and how soon again after a look that failed
const AUTO_TICK_MS = 20_000;
const NEW_MAX = 8; // "new" never reaches back further than this many expiries
const FAIL_HOLD_MS = 6 * 3600_000; // the automatic update leaves a contract Upstox refused alone for this long
const FAIL_STREAK = 20; // downloads failing in a row before a job gives up (offline, logged out)
const DEFAULTS = { auto: true, band: 20, daysBefore: 5 };

const int = (v, lo, hi, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(lo, Math.min(hi, Math.round(Number(v)))));
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const breathe = () => new Promise((r) => setImmediate(r));
// fn over every item, n at a time; results in the order of the items.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

// file: where the settings are kept (bt-data/data-sync.json).
function createSync({ data, getToken, file, logError = () => {} }) {
  // band / daysBefore are the depth of every download (the Data screen's two boxes); auto = the automatic update.
  const clean = (s, d) => ({ auto: s?.auto == null ? d.auto : Boolean(s.auto), band: int(s?.band, 2, 80, d.band), daysBefore: int(s?.daysBefore, 0, 30, d.daysBefore) });
  let settings = { ...DEFAULTS };
  try { settings = clean(JSON.parse(fs.readFileSync(file, 'utf8')), DEFAULTS); } catch {}
  function saveSettings(s) {
    const turnedOn = s?.auto && !settings.auto;
    settings = clean(s, settings);
    if (turnedOn) auto.nextAt = 0;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(settings));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { logError('bt-sync-settings', e); }
  }

  // ---------- what is missing ----------
  // The expired expiries a request is about, oldest first.
  //   scope 'recent'  those of the last `months` months (0 = everything Upstox has)
  //         'range'   those dated `from` .. `to`
  //         else      'new': from the newest expiry with candles in the cache on, at most the last NEW_MAX
  //                   (only the latest one while nothing is cached)
  //   kind  'weekly' | 'monthly'; anything else = both
  function select(cal, o) {
    let list = cal.expired;
    if (o.scope === 'range') {
      const from = isDay(o.from) ? o.from : list[0];
      const to = isDay(o.to) ? o.to : list[list.length - 1];
      list = list.filter((e) => e >= from && e <= to);
    } else if (o.scope === 'recent') {
      const months = int(o.months, 0, 120, 3);
      const from = months ? addDays(istToday(), -Math.round(months * 30.5)) : '';
      list = list.filter((e) => e >= from);
    } else {
      const have = data.optionExpiries().filter((e) => cal.expiredSet.has(e));
      const newest = have.length ? have[have.length - 1] : list[list.length - 1];
      list = list.slice(-NEW_MAX).filter((e) => e >= newest);
    }
    if (o.kind === 'weekly' || o.kind === 'monthly') list = list.filter((e) => cal.monthly.has(e) === (o.kind === 'monthly'));
    return list;
  }

  const failedAt = new Map(); // `${expiry}|${strike}|${type}` -> when its download last failed

  // Per expiry of the request: the contracts wanted, how many of them the cache lacks and the Upstox requests those
  // take; `tasks` lists the missing ones, newest expiry first. Reads (downloading what is not cached) the Nifty
  // candles and the contract lists it needs. skipFailed: leave out contracts whose download failed lately.
  async function plan(o, { skipFailed = false, say = () => {} } = {}) {
    const { band, daysBefore } = clean(o, settings);
    const cal = await data.expiryCalendar();
    const list = select(cal, o);
    const out = { band, daysBefore, stale: cal.stale, index: null, rows: [], tasks: [], contracts: 0, missing: 0, requests: 0 };
    if (!list.length) return out;
    say('Loading Nifty history');
    const last = list[list.length - 1];
    // A selection that reaches the newest expiry brings the index candles up to today as well.
    out.index = [addDays(list[0], -60), last === cal.expired[cal.expired.length - 1] ? istToday() : last];
    const days = await data.loadIndex(...out.index);
    const at = new Map(days.map((d, i) => [d, i]));
    say('Checking what is missing');
    out.rows = await pool(list, 6, async (e) => {
      const row = { expiry: e, contracts: 0, missing: 0, requests: 0, tasks: [] };
      try {
        await breathe();
        if (!at.has(e)) throw new Error('no Nifty candles for the expiry day');
        const info = await data.contracts(e);
        const win = days.slice(Math.max(0, at.get(e) - daysBefore), at.get(e) + 1);
        let lo = Infinity;
        let hi = -Infinity;
        for (const d of win) {
          const s = data.spotDay(d);
          for (let i = 0; i < s.length; i += 4) { lo = Math.min(lo, s[i + 2]); hi = Math.max(hi, s[i + 1]); }
        }
        const ks = info.strikes;
        const near = (x) => ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(ks[b] - x) ? j : b), 0);
        const files = data.optionFiles(e);
        for (let j = Math.max(0, near(lo) - band); j <= Math.min(ks.length - 1, near(hi) + band); j++) {
          for (const t of ['CE', 'PE']) {
            row.contracts++;
            const requests = data.optionRequests(e, ks[j], t, win[0], files);
            if (!requests || (skipFailed && Date.now() - (failedAt.get(`${e}|${ks[j]}|${t}`) || 0) < FAIL_HOLD_MS)) continue;
            row.missing++;
            row.requests += requests;
            row.tasks.push([e, ks[j], t, win[0]]);
          }
        }
      } catch (err) {
        row.error = err.message;
      }
      return row;
    });
    for (const r of out.rows) { out.contracts += r.contracts; out.missing += r.missing; out.requests += r.requests; }
    out.tasks = out.rows.slice().reverse().flatMap((r) => r.tasks);
    return out;
  }
  const planView = (p) => ({ ...p, tasks: undefined, rows: undefined, expiries: p.rows.map(({ tasks, ...r }) => r) });

  // ---------- the download job ----------
  let job = null; // the running download, else the last one
  let seq = 0;

  async function run(j) {
    const p = await plan(j.opts, { skipFailed: j.auto, say: (phase) => { j.progress = { phase, done: 0, total: 0 }; } });
    if (!p.rows.length && !j.auto) throw new Error('No expired expiries in that selection');
    // India VIX for the same days: backtests with a VIX condition read it; the download works without it.
    if (p.index) await data.loadIndex(...p.index, true).catch((e) => logError('bt-sync', e, 'India VIX'));
    const tasks = p.tasks;
    const fails = [];
    let next = 0;
    let done = 0;
    let streak = 0;
    let lastErr = null;
    const tell = (e) => { j.progress = { phase: 'Downloading option candles' + (e ? ' · ' + e : ''), done, total: tasks.length, failed: fails.length }; };
    tell();
    const worker = async () => {
      while (next < tasks.length && !j.stop && streak < FAIL_STREAK) {
        const [e, k, t, from] = tasks[next++];
        try {
          await data.option(e, k, t, from);
          streak = 0;
        } catch (err) {
          streak++;
          lastErr = err;
          fails.push(`${e}|${k}|${t}`);
          logError('bt-sync', err, `${e} ${k}${t}`);
        }
        done++;
        tell(e);
      }
    };
    await Promise.all(Array.from({ length: j.auto ? 4 : 8 }, worker));
    if (streak >= FAIL_STREAK) throw new Error(`Stopped after ${streak} downloads in a row failed: ${lastErr.message}`);
    for (const id of fails) failedAt.set(id, Date.now());
    const unchecked = p.rows.filter((r) => r.error);
    return {
      expiries: p.rows.length, wanted: tasks.length, contracts: done - fails.length, failed: fails.length, stopped: done < tasks.length,
      unchecked: unchecked.length, why: unchecked[0] ? `${unchecked[0].expiry}: ${unchecked[0].error}` : null, stale: p.stale,
      downloaded: [...new Set(tasks.slice(0, next).map((t) => t[0]))].sort(),
    };
  }

  // One download at a time: asking while one runs returns that one, except that a download asked for on the Data
  // screen takes over from an automatic one (which then ends at its next contract; nothing is fetched twice).
  function start(o, isAuto = false) {
    const token = getToken();
    if (token === 'demo') throw new Error('Downloading needs real Upstox data (not available in demo mode)');
    if (!token) throw new Error('Log in to Upstox first');
    if (job?.status === 'running') {
      if (!job.auto || isAuto) return job;
      job.stop = job.takenOver = true;
    }
    const j = {
      id: ++seq, auto: isAuto, status: 'running', startedAt: Date.now(), progress: { phase: 'Starting', done: 0, total: 0 },
      opts: { scope: ['recent', 'range'].includes(o?.scope) ? o.scope : 'new', months: o?.months, from: o?.from, to: o?.to, kind: o?.kind, band: o?.band, daysBefore: o?.daysBefore },
    };
    job = j;
    j.promise = run(j)
      .then((r) => { j.result = r; j.status = 'done'; }, (e) => { j.error = e.message; j.status = 'error'; if (!j.auto || e.message !== auto.error) logError('bt-sync', e); })
      .then(() => { j.endedAt = Date.now(); if (j.auto) autoDone(j); });
    return j;
  }

  // ---------- automatic update ----------
  // While the server runs: the 'new' selection with the saved depth, shortly after the start or a login and then
  // every AUTO_EVERY_MS. A look that finds nothing new only costs the hourly refresh of the expiry list and of the
  // running month's index candles (four requests).
  const auto = { at: 0, ok: null, text: '', error: null, nextAt: 0 };
  function autoDone(j) {
    const r = j.result;
    if (r?.stopped) { // interrupted: the next look continues it, soon when a download from the Data screen took over
      if (j.takenOver) auto.nextAt = Date.now() + AUTO_RETRY_MS;
      return;
    }
    auto.at = j.endedAt;
    auto.error = j.error || null;
    auto.ok = Boolean(r) && !r.unchecked && !r.stale;
    if (!r) auto.text = j.error;
    else if (r.unchecked) auto.text = `could not check ${r.unchecked} ${r.unchecked === 1 ? 'expiry' : 'expiries'} (${r.why})`;
    else if (r.contracts || r.failed) auto.text = `downloaded ${r.contracts} contracts of ${r.downloaded.join(', ')}` + (r.failed ? `, ${r.failed} failed` : '');
    else auto.text = r.stale ? 'Upstox could not be reached; nothing is missing by the saved expiry list' : 'nothing new';
    if (!auto.ok) auto.nextAt = Date.now() + AUTO_RETRY_MS;
  }
  function tick() {
    if (!settings.auto || job?.status === 'running') return;
    const token = getToken();
    if (!token || token === 'demo') { auto.nextAt = 0; return; } // look as soon as there is a login
    if (Date.now() < auto.nextAt) return;
    auto.nextAt = Date.now() + AUTO_EVERY_MS;
    start({ scope: 'new' }, true);
  }
  setInterval(tick, AUTO_TICK_MS).unref();

  function status() {
    const token = getToken();
    return {
      settings,
      job: job && { id: job.id, auto: job.auto, status: job.status, error: job.error, opts: job.opts, startedAt: job.startedAt, endedAt: job.endedAt, progress: { ...job.progress, api: data.apiStats() }, result: job.result },
      auto: { state: token === 'demo' ? 'demo' : !settings.auto ? 'off' : token ? 'on' : 'login', at: auto.at, ok: auto.ok, text: auto.text, nextAt: auto.nextAt },
    };
  }

  async function handle(req, res, p, sendJson, readJson) {
    if (p === '/api/bt/sync') return sendJson(res, 200, status());
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
    const b = await readJson(req);
    if (p === '/api/bt/sync/plan') {
      // Not being able to check (not logged in on an empty cache, offline) is an answer, not a server error.
      try { return sendJson(res, 200, planView(await plan(b))); } catch (e) { return sendJson(res, 200, { error: e.message }); }
    }
    if (p === '/api/bt/sync/start') {
      try { start(b); } catch (e) { return sendJson(res, 400, { error: e.message }); } // demo mode, not logged in
      return sendJson(res, 200, status());
    }
    if (p === '/api/bt/sync/stop') { if (job?.status === 'running') job.stop = true; return sendJson(res, 200, status()); }
    if (p === '/api/bt/sync/settings') { saveSettings(b); return sendJson(res, 200, status()); }
    return sendJson(res, 404, { error: 'Not found' });
  }

  return { handle, plan, start, status, tick, saveSettings };
}

module.exports = { createSync };
