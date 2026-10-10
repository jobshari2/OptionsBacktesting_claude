// Data screen: what history Upstox provides, what is cached locally, and downloading what is missing
// (by hand for a selection of expiries, and automatically for new ones: bt/sync.js).
(() => {
  const { $, esc, dayLabel, dayShort } = BT;
  let inited = false;
  let drawn = 0;
  let sync = null; // /api/bt/sync: the saved depth, the running (or last) download, the automatic update
  let plan = null; // what the cache lacks for the selection (null while the server is checking)
  let planSeq = 0;
  let seen = null; // id + status of the download last shown, to notice one ending
  let note = null; // why a download could not be started
  let timer = null;
  // Which expiries to download: 'new' | 'recent' (months) | 'dates' (from, to) | 'expiries' (expFrom, expTo).
  const form = { scope: 'new', months: 3, kind: 'all', ...BT.store.get('data.pick', {}), from: '', to: '', expFrom: '', expTo: '' };

  const mb = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';
  const n = (x) => Number(x).toLocaleString('en-IN');
  const some = (c, one, many) => `${n(c)} ${c === 1 ? one : many}`;
  const clock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const shift = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
  const span = (list) => (list.length === 1 ? dayLabel(list[0].expiry) : `${dayLabel(list[0].expiry)} → ${dayLabel(list[list.length - 1].expiry)}`);
  // The downloader stays under 450 requests a minute and 1,900 per half hour.
  const eta = (requests) => {
    const min = requests <= 1900 ? requests / 450 : (requests / 1900) * 30;
    return min < 1 ? 'under a minute' : min < 90 ? `about ${Math.ceil(min)} min` : `about ${(min / 60).toFixed(1)} hours`;
  };

  function downloadPanel(exp, monthly) {
    if (!exp.length) return '';
    const last = exp[exp.length - 1];
    if (!exp.includes(form.expFrom)) form.expFrom = exp[Math.max(0, exp.length - 8)];
    if (!exp.includes(form.expTo)) form.expTo = last;
    form.from ||= shift(last, -91);
    form.to ||= last;
    const opts = (sel) => exp.map((e) => `<option value="${e}" ${e === sel ? 'selected' : ''}>${dayLabel(e)}${monthly.has(e) ? ' · M' : ''}</option>`).join('');
    const pick = {
      new: '<span class="muted">expiries since the last one downloaded (the latest 8 at most)</span>',
      recent: `<select id="syMonths">${[[1, 'Last month'], [3, 'Last 3 months'], [6, 'Last 6 months'], [12, 'Last year'], [0, 'Everything Upstox has']].map(([m, t]) => `<option value="${m}" ${m === form.months ? 'selected' : ''}>${t}</option>`).join('')}</select>`,
      dates: `<span class="muted">expiring from</span><input type="date" id="syFrom" value="${form.from}" min="${exp[0]}" max="${last}"><span class="muted">to</span><input type="date" id="syTo" value="${form.to}" min="${exp[0]}" max="${last}">`,
      expiries: `<select id="syExpFrom">${opts(form.expFrom)}</select><span class="muted">→</span><select id="syExpTo">${opts(form.expTo)}</select>`,
    };
    const s = sync?.settings || { band: 20, daysBefore: 5 };
    return `
      <section class="panel data-card wide" id="syCard">
        <h3>Download data <span class="muted small">option candles the cache does not have yet</span></h3>
        <div class="set-row">
          <span class="lbl">Expiries</span>
          <div class="seg sm">${[['new', 'New'], ['recent', 'Recent'], ['dates', 'Date range'], ['expiries', 'Pick expiries']].map(([k, t]) => `<button data-scope="${k}" class="${k === form.scope ? 'on' : ''}">${t}</button>`).join('')}</div>
          ${pick[form.scope] || pick.new}
          <select id="syKind">${[['all', 'Weekly + monthly'], ['monthly', 'Monthly only'], ['weekly', 'Weekly only']].map(([k, t]) => `<option value="${k}" ${k === form.kind ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="set-row">
          <span class="lbl">Strikes</span><span class="muted">±</span><input id="syBand" class="num xs" type="number" value="${s.band}" min="2" max="80"><span class="muted">around the Nifty range of the last</span>
          <input id="syDays" class="num xs" type="number" value="${s.daysBefore}" min="0" max="30"><span class="muted">trading days before each expiry (calls and puts)</span>
        </div>
        <div class="sy-sum" id="sySum">Checking what is missing…</div>
        <div class="set-row">
          <button class="btn-sm run" id="syRun" disabled>Download missing data</button>
          <button class="btn-sm ghost hidden" id="syStop">Stop</button>
          <div class="progress hidden" id="syProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
          <span id="syMsg" class="muted small"></span>
        </div>
        <div class="set-row sy-auto">
          <label class="chk"><input type="checkbox" id="syAuto"> Download new expiries automatically while the app is running</label>
          <span id="syAutoMsg" class="muted small"></span>
        </div>
      </section>`;
  }

  async function render() {
    const id = ++drawn;
    let cache = null;
    try { cache = await BT.api('/api/bt/cache'); } catch {}
    if (id !== drawn) return;
    const cal = BT.meta.calendar;
    const exp = cal?.expired || [];
    const monthly = new Set(cal?.monthly || []);
    const cached = new Map((cache?.expiries || []).map((e) => [e.expiry, e.contracts]));
    const maxC = Math.max(1, ...cached.values());
    const byYear = {};
    for (const e of exp) (byYear[e.slice(0, 4)] ||= []).push(e);
    $('dataBody').innerHTML = `
      <section class="panel data-card">
        <h3>Historical data from Upstox</h3>
        ${cal ? `<table class="kv">
          <tr><th>Expired Nifty options</th><td><b>${exp.length} expiries</b>, ${dayLabel(exp[0])} → ${dayLabel(exp[exp.length - 1])} (${exp.filter((e) => monthly.has(e)).length} monthly, ${exp.filter((e) => !monthly.has(e)).length} weekly)</td></tr>
          <tr><th>Resolution</th><td>1-minute OHLC + open interest for every strike (call and put), via <code>/v2/expired-instruments</code></td></tr>
          <tr><th>Nifty 50 &amp; India VIX</th><td>1-minute candles since Jan 2022 via <code>/v3/historical-candle</code></td></tr>
          <tr><th>Live expiries</th><td>${(cal.live || []).slice(0, 6).map(dayShort).join(' · ')}${cal.live.length > 6 ? ' …' : ''} — usable for <b>Deploy live</b>; they become backtestable once expired</td></tr>
          <tr><th>Lot size</th><td>today ${cal.liveLot || '—'}; over this history it went 25 → 75 → 65 ("As traded" takes it from each expiry's contract data). Backtests use a fixed lot by default so years compare fairly.</td></tr>
          <tr><th>Rate limits</th><td>Upstox allows ~500 requests/min and 2,000 per 30 min. One request downloads a contract's whole last month, so a 6-month ATM straddle test needs ~300 requests the first time and none after.</td></tr>
        </table>` : `<div class="err">${esc(BT.meta.calError || 'Calendar not loaded — log in to Upstox.')}</div>`}
      </section>
      <section class="panel data-card">
        <h3>Local cache <span class="muted small">bt-cache/</span></h3>
        ${cache ? `<table class="kv">
          <tr><th>Option candles</th><td><b>${cache.options.files.toLocaleString('en-IN')}</b> contracts across ${cache.expiries.length} expiries · ${mb(cache.options.bytes)}</td></tr>
          <tr><th>Index candles</th><td>${cache.index.files} month files · ${mb(cache.index.bytes)}</td></tr>
          <tr><th>In memory</th><td>${cache.memContracts} contracts (fastest re-runs)</td></tr>
          <tr><th>This session</th><td>${cache.api.requests} Upstox requests · ${cache.api.lastMinute} in the last minute</td></tr>
        </table>
        <div class="data-actions"><button class="btn-sm ghost danger" data-clear="options">Clear option cache</button> <button class="btn-sm ghost danger" data-clear="index">Clear index cache</button></div>` : '<div class="muted">—</div>'}
      </section>
      ${downloadPanel(exp, monthly)}
      <section class="panel data-card wide">
        <h3>Coverage by expiry <span class="muted small">bar = contracts cached · M = monthly · outlined = in the selection above, red = something of it is missing · click an expiry to pick it (Shift-click for a range)</span></h3>
        <div class="cov">${Object.entries(byYear).reverse().map(([y, es]) => `<div class="cov-year"><span class="muted">${y}</span><div class="cov-row">${es.map((e) => {
          const c = cached.get(e) || 0;
          const tip = `${dayLabel(e)}${monthly.has(e) ? ' (monthly)' : ''}: ${c} contracts cached`;
          return `<div class="cov-cell${monthly.has(e) ? ' m' : ''}" data-e="${e}" data-tip="${tip}" title="${tip}"><div class="cov-fill" style="height:${((c / maxC) * 100).toFixed(0)}%"></div><span>${dayShort(e).split(' ')[0]}</span></div>`;
        }).join('')}</div></div>`).join('')}</div>
      </section>`;
    paintSync();
    check();
  }

  // The selection as the server takes it (the depth is the saved one).
  function request() {
    if (form.scope === 'recent') return { scope: 'recent', months: form.months, kind: form.kind };
    if (form.scope === 'dates' || form.scope === 'expiries') {
      const [from, to] = form.scope === 'dates' ? [form.from, form.to] : [form.expFrom, form.expTo];
      if (!from || !to) return { error: 'Give both ends of the range.' };
      if (from > to) return { error: 'The range starts after it ends.' };
      return { scope: 'range', from, to, kind: form.kind };
    }
    return { scope: 'new', kind: form.kind };
  }

  // Ask the server what the cache lacks for the selection: after every change of it and every download.
  async function check() {
    if (!$('sySum')) return;
    const id = ++planSeq;
    const req = request();
    plan = req.error ? { error: req.error } : null;
    paintPlan();
    if (req.error) return;
    let p;
    try { p = await BT.api('/api/bt/sync/plan', req); } catch (e) { p = { error: e.message }; }
    if (id !== planSeq) return;
    plan = p;
    paintPlan();
  }

  function paintPlan() {
    const el = $('sySum');
    if (!el) return;
    let cls = '';
    let html = 'Checking what is missing…';
    if (plan?.error) {
      cls = 'bad';
      html = esc(plan.error);
    } else if (plan) {
      const es = plan.expiries;
      const need = es.filter((e) => e.missing);
      const bad = es.filter((e) => e.error);
      if (!es.length) html = 'No expired expiries in this selection.';
      else if (plan.missing) {
        cls = 'need';
        html = `<b>${some(plan.missing, 'contract', 'contracts')} to download</b> of the ${n(plan.contracts)} wanted, in ${need.length} of ${some(es.length, 'expiry', 'expiries')} (${span(need)}) · about ${n(plan.requests)} Upstox requests, ${eta(plan.requests)}.`;
      } else if (bad.length < es.length) {
        cls = 'ok';
        html = `<b>Nothing missing.</b> All ${n(plan.contracts)} contracts wanted for ${some(es.length - bad.length, 'expiry', 'expiries')} (${span(es)}) are downloaded.`;
      } else html = '';
      if (bad.length) {
        cls = plan.missing ? cls : 'bad';
        html += ` <span class="err">${some(bad.length, 'expiry', 'expiries')} could not be checked (${esc(dayLabel(bad[0].expiry) + ': ' + bad[0].error)}).</span>`;
      }
      if (plan.stale) html += ' <span class="muted">Upstox could not be reached, so this is checked against the saved list of expiries.</span>';
      const rows = new Map(es.map((e) => [e.expiry, e]));
      for (const c of $('dataBody').querySelectorAll('.cov-cell')) {
        const r = rows.get(c.dataset.e);
        c.classList.toggle('sel', Boolean(r));
        c.classList.toggle('miss', Boolean(r && (r.missing || r.error)));
        c.title = c.dataset.tip + (!r ? '' : r.error ? ` · not checked: ${r.error}` : r.missing ? ` · ${r.missing} of the ${r.contracts} wanted are missing` : ` · all ${r.contracts} wanted are downloaded`);
      }
    }
    el.className = 'sy-sum ' + cls;
    el.innerHTML = html;
    paintSync();
  }

  // The running download, the result of the last one and the state of the automatic update.
  function paintSync() {
    if (!$('syRun')) return;
    const j = sync?.job;
    const running = j?.status === 'running';
    const a = sync?.auto;
    const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
    if (sync) { set('syBand', sync.settings.band); set('syDays', sync.settings.daysBefore); }
    $('syRun').disabled = running || a?.state === 'demo' || !plan?.missing;
    $('syRun').title = a?.state === 'demo' ? 'Not available in demo mode' : '';
    $('syStop').classList.toggle('hidden', !running);
    const prog = $('syProg');
    prog.classList.toggle('hidden', !running);
    if (running) {
      const p = j.progress;
      prog.querySelector('.fill').style.width = (p.total ? (p.done / p.total) * 100 : 0).toFixed(1) + '%';
      const wait = p.api?.waitingSec ? ` · waiting ${p.api.waitingSec}s for the Upstox rate limit` : '';
      prog.querySelector('.ptext').textContent = `${j.auto ? 'Automatic update · ' : ''}${p.phase} ${p.total ? p.done + '/' + p.total : ''}${p.failed ? ' · ' + p.failed + ' failed' : ''}${wait}`;
    }
    let msg = note || '';
    let err = Boolean(note);
    if (!note && j && !running && !j.auto) {
      const r = j.result;
      err = !r;
      if (!r) msg = 'Download failed: ' + j.error;
      else if (!r.wanted) msg = 'Nothing was missing.';
      else {
        msg = `Downloaded ${some(r.contracts, 'contract', 'contracts')} of ${some(r.downloaded.length, 'expiry', 'expiries')}`
          + (r.failed ? `, ${r.failed} failed (see logs/errors.log)` : '') + (r.stopped ? `; stopped with ${n(r.wanted - r.contracts - r.failed)} left` : '') + ` · ${clock(j.endedAt)}`;
      }
    }
    $('syMsg').textContent = running ? '' : msg;
    $('syMsg').className = 'small ' + (err ? 'err' : 'muted');
    const box = $('syAuto');
    box.checked = sync ? sync.settings.auto : true;
    box.disabled = !sync || a.state === 'demo';
    let text = '';
    if (a?.state === 'demo') text = 'Not available in demo mode.';
    else if (a?.state === 'off') text = 'Off: new expiries are downloaded only with the button above (backtests still fetch what they need).';
    else if (a?.state === 'login') text = 'Waiting for the Upstox login.';
    else if (a && running && j.auto) text = 'Checking now.';
    else if (a) text = (a.at ? `Last check ${clock(a.at)}: ${a.text}.` : 'First check within half a minute.') + (a.at && a.nextAt > Date.now() ? ` Next check ${clock(a.nextAt)}.` : '');
    $('syAutoMsg').textContent = text;
    $('syAutoMsg').className = 'small ' + (a?.state === 'on' && a.ok === false && !(running && j.auto) ? 'err' : 'muted');
  }

  function apply(status) {
    const was = sync?.job;
    sync = status;
    const j = status.job;
    const key = j ? j.id + j.status : '';
    // A download ended (one seen running, or one that ran between two polls and fetched something): the cache changed.
    const ended = seen !== null && key !== seen && j && j.status !== 'running' && (was?.status === 'running' || j.result?.contracts > 0);
    seen = key;
    if (ended) render(); else paintSync();
  }

  // Follows the download while the screen is open: closely while one runs, else often enough to see one start.
  async function poll() {
    clearTimeout(timer);
    if (window.app.state.view !== 'data') return;
    if (!document.hidden || !sync) { try { apply(await BT.api('/api/bt/sync')); } catch {} }
    clearTimeout(timer);
    timer = setTimeout(poll, sync?.job?.status === 'running' ? 500 : 5000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  async function send(path, body) {
    try {
      note = null;
      apply(await BT.api(path, body));
      poll();
      return true;
    } catch (e) {
      note = e.message;
      paintSync();
      return false;
    }
  }

  // The selection changed: check it again; another way of picking (redraw) also needs its own inputs.
  function picked(redraw) {
    BT.store.set('data.pick', { scope: form.scope, months: form.months, kind: form.kind });
    const cal = BT.meta.calendar;
    if (redraw && $('syCard') && cal) {
      $('syCard').outerHTML = downloadPanel(cal.expired, new Set(cal.monthly));
      paintSync();
    }
    check();
  }

  $('dataBody').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.scope) { form.scope = t.dataset.scope; return picked(true); }
    const cell = t.closest('.cov-cell');
    if (cell && $('syCard')) {
      const from = e.shiftKey && form.scope === 'expiries' ? form.expFrom : cell.dataset.e;
      [form.expFrom, form.expTo] = [from, cell.dataset.e].sort();
      form.scope = 'expiries';
      return picked(true);
    }
    if (t.id === 'syRun') { const req = request(); if (!req.error) send('/api/bt/sync/start', req); }
    if (t.id === 'syStop') send('/api/bt/sync/stop', {});
    const what = t.dataset.clear;
    if (what && confirm(`Delete the cached ${what} data? It will be downloaded again when needed.`)) {
      await BT.api('/api/bt/cache/clear', { what });
      render();
    }
  });

  $('dataBody').addEventListener('change', async (e) => {
    const t = e.target;
    const field = { syMonths: 'months', syKind: 'kind', syFrom: 'from', syTo: 'to', syExpFrom: 'expFrom', syExpTo: 'expTo' }[t.id];
    if (field) { form[field] = field === 'months' ? Number(t.value) : t.value; return picked(false); }
    if (t.id === 'syAuto') send('/api/bt/sync/settings', { auto: t.checked });
    // The depth is saved on the server: the automatic update downloads with it too.
    if ((t.id === 'syBand' || t.id === 'syDays') && await send('/api/bt/sync/settings', { band: $('syBand').value, daysBefore: $('syDays').value })) check();
  });

  function init() {
    if (!inited) { inited = true; BT.on('meta', render); }
    render();
    poll();
  }
  window.addEventListener('viewchange', (e) => { if (e.detail === 'data') init(); });
  if (window.app.state.view === 'data') init();
})();
