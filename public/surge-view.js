// Trading Ideas › Option surges: every Nifty option whose premium jumped 100–200 %+ off a low in the cached history
// (bt/surge.js), shown several ways (overview, table with a chart of each surge, price vs. Nifty move, causes), with
// the volume and open interest behind it where downloaded (bt/surgevol.js), a backtest of trading the surges without
// hindsight, and a live radar of options climbing off today's low (surgeradar.js). Paper only: nothing here trades.
(() => {
  const { $, esc, inrS, kinr, cls, dayLabel, store, api, sleep, chart, COLORS } = BT;
  const TABS = [
    ['overview', 'Overview'],
    ['list', 'Surges'],
    ['rel', 'Price vs. Nifty move'],
    ['why', 'What causes them'],
    ['bt', 'Backtest'],
    ['live', 'Live radar'],
    ['use', 'How to use it'],
  ];
  const DEF_FILTER = { minMult: 3, span: 'intraday', side: 'both', minLow: 4, maxLow: 0, dteMax: 99, driver: 'all', from: '', to: '', q: '' };
  const DTE_B = [
    ['0', 'Expiry day', (d) => d === 0],
    ['1', '1 day', (d) => d === 1],
    ['2-3', '2–3 days', (d) => d >= 2 && d <= 3],
    ['4-7', '4–7 days', (d) => d >= 4 && d <= 7],
    ['8+', '8+ days', (d) => d >= 8],
  ];
  const OTM_B = [
    ['itm', 'ITM', (x) => x < -0.25],
    ['atm', 'ATM ±0.25 %', (x) => x >= -0.25 && x <= 0.25],
    ['n', '0.25–0.75 % OTM', (x) => x > 0.25 && x <= 0.75],
    ['m', '0.75–1.5 % OTM', (x) => x > 0.75 && x <= 1.5],
    ['f', '> 1.5 % OTM', (x) => x > 1.5],
  ];
  const BT_FIELDS = [
    // [key, label, kind, extra]
    [
      'mode',
      'Entry',
      'sel',
      [
        ['trigger', 'When it is up N× from the session low (signal)'],
        ['lottery', 'Lottery: buy a cheap option at a set time (no signal)'],
      ],
    ],
    ['trigger', 'Signal: close ≥ N × low', 'num', 0.1],
    ['minBase', 'Low at least ₹', 'num', 0.5],
    ['maxBase', 'Low at most ₹ (0 = any)', 'num', 1],
    ['premium', 'Lottery: premium near ₹', 'num', 1],
    ['lotteryAt', 'Lottery: buy at', 'time'],
    [
      'sides',
      'Side',
      'sel',
      [
        ['both', 'Calls and puts'],
        ['CE', 'Calls only'],
        ['PE', 'Puts only'],
      ],
    ],
    ['dteMax', 'Days to expiry ≤', 'num', 1],
    ['entryFrom', 'Signals from', 'time'],
    ['entryTo', 'Signals until', 'time'],
    ['confirm', 'Nifty moved ≥ % in favour since the low', 'num', 0.1],
    ['targetMult', 'Target: close ≥ N × low (0 = off)', 'num', 0.5],
    ['targetPct', 'Target: % over entry (0 = off)', 'num', 5],
    ['stopPct', 'Stop: % under entry (0 = off)', 'num', 5],
    ['trailPct', 'Trailing stop % from best (0 = off)', 'num', 5],
    ['exitAt', 'Exit by', 'time'],
    ['maxPerDay', 'Trades per day ≤', 'num', 1],
    ['budget', 'Premium per trade ₹', 'num', 1000],
    ['capital', 'Capital ₹ (for %/yr)', 'num', 50000],
    ['slippage', 'Slippage % per fill', 'num', 0.1],
  ];

  let tab = store.get('sr-tab', 'overview');
  let filt = { ...DEF_FILTER, ...store.get('sr-filter', {}) };
  let sort = store.get('sr-sort', { k: 'day', dir: -1 });
  let meta = null;
  let rows = null; // the scan as objects
  let loadError = '';
  let job = null; // { kind, progress, error }
  let selId = null;
  const seriesCache = new Map();
  let btParams = null;
  let liveTimer = null;
  let live = null;
  let liveError = '';
  let started = false;
  let listLimit = 300;

  // ---------- helpers ----------
  const OPEN = 9 * 60 + 15;
  const hhmm = (m) => (m == null ? '—' : `${String(Math.floor((m + OPEN) / 60)).padStart(2, '0')}:${String((m + OPEN) % 60).padStart(2, '0')}`);
  const rs = (x, d = 2) => (x == null ? '—' : '₹' + Number(x).toFixed(d));
  const f1 = (x, d = 1) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(d));
  const sgn = (x, d = 2, u = '%') => (x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(d) + u);
  const median = (a) => {
    const v = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y);
    if (!v.length) return null;
    const i = v.length >> 1;
    return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
  };
  const mean = (a) => {
    const v = a.filter((x) => x != null && !isNaN(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  function corr(xs, ys) {
    const p = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && isFinite(x) && isFinite(y));
    if (p.length < 5) return null;
    const mx = mean(p.map((q) => q[0]));
    const my = mean(p.map((q) => q[1]));
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const [x, y] of p) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  const tile = (label, value, sub = '', c = '') =>
    `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c}">${value}</span><span class="k-s">${sub}</span></div>`;
  const multCls = (m) => (m >= 10 ? 'x10' : m >= 5 ? 'x5' : '');
  const name = (r) => `${r.strike} <span class="sr-type ${r.type}">${r.type}</span> <span class="muted small">${dayLabel(r.expiry)}</span>`;
  const dteBucket = (d) => DTE_B.find((b) => b[2](d))?.[0];
  // minutes from the low to the peak (trading minutes; across sessions for multi-day)
  const runMins = (r) => (r.troughDay === r.peakDay ? r.peakMin - r.troughMin : null);
  const tagCls = (t) => (t.startsWith('Macro') ? 'macro' : /covering|build-up|Volume/.test(t) ? 'flow' : /Big|Gap/.test(t) ? 'big' : '');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // the minimum option price (₹) a surge may start from: the screen's setting, saved on the server (bt-data/surge-config.json)
  const minPrice = () => meta?.config?.minPrice ?? 4;

  // ---------- data ----------
  async function loadAll() {
    loadError = '';
    try {
      meta = await api('/api/surge/meta');
      btParams = { ...meta.btDefaults, ...store.get('sr-bt', {}) };
      if (meta.scanRows) {
        const { scan } = await api('/api/surge/scan');
        rows = scan ? toObjects(scan) : null;
      } else rows = null;
    } catch (e) {
      loadError = e.message;
    }
  }
  function toObjects(scan) {
    const C = scan.cols;
    return scan.rows.map((a, i) => {
      const o = { id: i };
      C.forEach((k, j) => (o[k] = a[j]));
      return o;
    });
  }
  function pass(r, f = filt, skipMult = false) {
    if (!skipMult && r.mult < f.minMult) return false;
    if (f.span !== 'all' && r.span !== f.span) return false;
    if (f.side !== 'both' && r.type !== f.side) return false;
    if (r.trough < Math.max(f.minLow, minPrice())) return false;
    if (f.maxLow > 0 && r.trough > f.maxLow) return false;
    if (r.dte > f.dteMax) return false;
    if (f.driver !== 'all' && r.driver !== f.driver) return false;
    if (f.from && r.day < f.from) return false;
    if (f.to && r.day > f.to) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!`${r.strike} ${r.type} ${r.expiry} ${r.day} ${r.driver} ${r.tags.join(' ')}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }
  const filtered = () => (rows || []).filter((r) => pass(r));

  // ---------- jobs ----------
  async function startJob(path, body, kind) {
    if (job) return;
    job = { kind, progress: { phase: 'Starting', done: 0, total: 0 } };
    renderStatus();
    try {
      let j = await api(path, body);
      job.id = j.id;
      while (j.status === 'running') {
        job.progress = j.progress || job.progress;
        renderStatus();
        await sleep(500);
        j = await api('/api/surge/job?id=' + job.id);
      }
      if (j.status === 'error') throw new Error(j.error);
      job = null;
      if (kind === 'scan' || kind === 'volume') await loadAll();
      else meta = await api('/api/surge/meta');
      render();
    } catch (e) {
      job = { kind, error: e.message };
      renderStatus();
      setTimeout(() => {
        if (job?.error) {
          job = null;
          renderStatus();
        }
      }, 15000);
    }
  }
  async function stopJob() {
    if (job?.id) await api('/api/surge/job/stop', { id: job.id }).catch(() => {});
  }
  function renderStatus() {
    const el = $('srStatus');
    if (!el) return;
    if (job?.error) el.innerHTML = `<span class="neg">${esc(job.error)}</span>`;
    else if (job) {
      const p = job.progress || {};
      el.innerHTML = `<span class="spin"></span> ${esc(p.phase || 'Working')}${p.total ? ` · ${p.done} / ${p.total}` : ''} <button class="btn-sm ghost" data-sr="stop">Stop</button>`;
    } else if (meta)
      el.innerHTML =
        `<label class="sr-minp" title="Options priced under this at their low are not counted as surges: the scan, the filters, the backtest's default and the live radar all start from it. Changing it rescans the history (about 30 s).">Minimum option price ₹ <input class="num xs" type="number" min="0.5" step="0.5" data-sr="minp" value="${minPrice()}"></label> ` +
        (meta.scanAt
          ? `History scanned ${new Date(meta.scanAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${meta.scanRows.toLocaleString('en-IN')} surges · volume &amp; OI for ${meta.volFiles.toLocaleString('en-IN')} contracts
          <button class="btn-sm ghost" data-sr="scan" title="Scan the cached option history again (after the Data screen downloaded newer expiries)">Rescan</button>
          <button class="btn-sm ghost" data-sr="volume" title="Download volume and open interest from Upstox for every contract that tripled (only the missing ones), then rescan"${meta.demo ? ' disabled' : ''}>Fetch volume &amp; OI</button>`
          : '');
    el.querySelector('[data-sr="stop"]')?.addEventListener('click', stopJob);
    el.querySelector('[data-sr="scan"]')?.addEventListener('click', () => startJob('/api/surge/scan', {}, 'scan'));
    el.querySelector('[data-sr="volume"]')?.addEventListener('click', () => startJob('/api/surge/volume', {}, 'volume'));
    el.querySelector('[data-sr="minp"]')?.addEventListener('change', (e) => setMinPrice(Number(e.target.value)));
  }
  async function setMinPrice(v) {
    try {
      const { config } = await api('/api/surge/config', { minPrice: v });
      meta.config = config;
      meta.btDefaults.minBase = config.minPrice;
      filt.minLow = config.minPrice;
      store.set('sr-filter', filt);
      if (btParams) {
        btParams.minBase = config.minPrice;
        store.set('sr-bt', btParams);
      }
      render();
      // the saved scan starts from the old minimum: scan again from the new one
      if (rows && meta.scanMinPrice !== config.minPrice) startJob('/api/surge/scan', {}, 'scan');
    } catch (e) {
      job = { kind: 'config', error: e.message };
      renderStatus();
      setTimeout(() => {
        if (job?.error) {
          job = null;
          renderStatus();
        }
      }, 8000);
    }
  }

  // ---------- filter bar ----------
  function filterBar(count) {
    const sel = (k, items) =>
      `<select data-f="${k}">${items.map(([v, l]) => `<option value="${v}"${String(filt[k]) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const drivers = [...new Set((rows || []).map((r) => r.driver))].sort();
    return `<div class="panel sr-sec"><div class="sr-filters">
      <label>Rise at least ${sel('minMult', [
        [1.5, '+50 %'],
        [2, '+100 % (2×)'],
        [3, '+200 % (3×)'],
        [5, '+400 % (5×)'],
        [10, '+900 % (10×)'],
      ])}</label>
      <label>Kind ${sel('span', [
        ['intraday', 'Within one session'],
        ['multi-day', 'Over several sessions'],
        ['all', 'Both'],
      ])}</label>
      <label>Side ${sel('side', [
        ['both', 'Calls and puts'],
        ['CE', 'Calls'],
        ['PE', 'Puts'],
      ])}</label>
      <label>Low ₹ <input class="num" type="number" step="1" min="${minPrice()}" data-f="minLow" value="${Math.max(filt.minLow, minPrice())}" title="At least the minimum option price (₹${minPrice()}, top right)"> to <input class="num" type="number" step="5" min="0" data-f="maxLow" value="${filt.maxLow}" title="0 = no upper limit"></label>
      <label>Days to expiry ≤ <input class="num" type="number" step="1" min="0" data-f="dteMax" value="${filt.dteMax}"></label>
      <label>Driver ${sel('driver', [['all', 'Any'], ...drivers.map((d) => [d, d])])}</label>
      <label>From <input type="date" data-f="from" value="${filt.from}"></label><label>to <input type="date" data-f="to" value="${filt.to}"></label>
      <label><input class="txt" type="search" data-f="q" placeholder="strike, tag, date…" value="${esc(filt.q)}" style="width:130px"></label>
      <button class="btn-sm ghost" data-f-reset>Reset</button>
      <span class="sr-count muted">${count.toLocaleString('en-IN')} surges</span></div></div>`;
  }
  function bindFilters(root) {
    root.querySelectorAll('[data-f]').forEach((el) =>
      el.addEventListener(el.type === 'search' ? 'input' : 'change', () => {
        const k = el.dataset.f;
        filt[k] = el.type === 'number' || ['minMult'].includes(k) ? Number(el.value) || 0 : el.value;
        store.set('sr-filter', filt);
        listLimit = 300;
        render();
        if (el.type === 'search') {
          const s = $('srBody').querySelector('[data-f="q"]');
          s?.focus();
          s?.setSelectionRange(s.value.length, s.value.length);
        }
      }),
    );
    root.querySelector('[data-f-reset]')?.addEventListener('click', () => {
      filt = { ...DEF_FILTER, minLow: minPrice() };
      store.set('sr-filter', filt);
      render();
    });
  }

  // ---------- render ----------
  function render() {
    if (!started) return;
    $('srTabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('');
    renderStatus();
    const body = $('srBody');
    if (tab !== 'live') stopLive();
    if (loadError) return (body.innerHTML = `<div class="panel sr-empty neg">${esc(loadError)}</div>`);
    if (!meta) return (body.innerHTML = `<div class="panel sr-empty muted"><span class="spin"></span> Loading…</div>`);
    if (tab === 'bt') return renderBt();
    if (tab === 'live') return renderLive();
    if (tab === 'use') return renderUse();
    if (!rows) {
      body.innerHTML = `<div class="panel sr-empty"><p>The option history has not been scanned yet.</p><p class="muted small">It reads every cached 1-minute option candle (bt-cache, about 30 s) and saves bt-data/surge-scan.json. Nothing is downloaded.</p>
        <button class="btn-sm run" data-sr-scan>Scan the history</button></div>`;
      body.querySelector('[data-sr-scan]').addEventListener('click', () => startJob('/api/surge/scan', {}, 'scan'));
      return;
    }
    const list = filtered();
    const head = filterBar(list.length);
    if (tab === 'overview') renderOverview(body, head, list);
    else if (tab === 'list') renderList(body, head, list);
    else if (tab === 'rel') renderRel(body, head, list);
    else if (tab === 'why') renderWhy(body, head, list);
    bindFilters(body);
  }

  // ---------- Overview ----------
  function renderOverview(body, head, list) {
    const days = new Set(list.map((r) => r.day));
    const months = new Set(list.map((r) => r.day.slice(0, 7)));
    const top = [...list].sort((a, b) => b.mult - a.mult)[0];
    const intr = list.filter((r) => r.span === 'intraday');
    // of the doublings with the same filters, how many went on to 3×
    const dbl = rows.filter((r) => r.span === 'intraday' && pass(r, { ...filt, span: 'intraday' }, true) && r.mult >= 2);
    const tri = dbl.filter((r) => r.mult >= 3).length;
    const ce = list.filter((r) => r.type === 'CE').length;
    body.innerHTML = `${head}
      <div class="panel sr-sec"><div class="kpis">
        ${tile('Surges', list.length.toLocaleString('en-IN'), `${ce} calls · ${list.length - ce} puts`)}
        ${tile('Sessions with one', days.size, `about ${f1(list.length / Math.max(1, months.size), 0)} surges a month`)}
        ${tile('Median rise', '×' + f1(median(list.map((r) => r.mult)), 2), `low → peak (${f1((median(list.map((r) => r.mult)) - 1) * 100, 0)} %)`)}
        ${tile('Biggest', top ? '×' + f1(top.mult, 1) : '—', top ? `${top.strike} ${top.type} · ${dayLabel(top.day)} · ${rs(top.trough)} → ${rs(top.peak)}` : '')}
        ${tile('Low → peak', intr.length ? f1(median(intr.map(runMins)), 0) + ' min' : '—', 'median, within a session')}
        ${tile('+100 % → +200 %', intr.length ? f1(median(intr.filter((r) => r.m200 != null).map((r) => r.m200 - r.m100)), 0) + ' min' : '—', 'median time between the two marks')}
        ${tile('Doubled → tripled', dbl.length ? f1((tri / dbl.length) * 100, 0) + ' %' : '—', `${tri.toLocaleString('en-IN')} of ${dbl.length.toLocaleString('en-IN')} intraday doublings`, '')}
        ${tile('On expiry day', list.length ? f1((list.filter((r) => r.dte === 0).length / list.length) * 100, 0) + ' %' : '—', `${f1((list.filter((r) => r.dte <= 1).length / Math.max(1, list.length)) * 100, 0)} % within a day of expiry`)}
      </div></div>
      <div class="sr-grid2">
        <div class="panel sr-sec"><h3>Surges per month <span class="muted small">calls and puts</span></h3><div class="sr-chart"><canvas id="srMonth"></canvas></div></div>
        <div class="panel sr-sec"><h3>Days to expiry at the low <span class="muted small">gamma: the closer the expiry, the faster a cheap option moves</span></h3><div class="sr-chart"><canvas id="srDte"></canvas></div></div>
        <div class="panel sr-sec"><h3>Time of the low <span class="muted small">when the move started</span></h3><div class="sr-chart"><canvas id="srHour"></canvas></div></div>
        <div class="panel sr-sec"><h3>How far out of the money at the low</h3><div class="sr-chart"><canvas id="srOtm"></canvas></div></div>
      </div>
      <div class="panel sr-sec"><h3>Calendar <span class="muted small">surges per session (weekdays, Mon → Fri across) · click a day to list its surges</span></h3><div class="sr-cal" id="srCal"></div></div>
      <div class="panel sr-sec"><h3>The 15 biggest <span class="muted small">click one for its chart and what moved it</span></h3>${table([...list].sort((a, b) => b.mult - a.mult).slice(0, 15), false)}</div>`;
    const bar = (id, labels, sets, opts = {}) =>
      chart($(id), {
        type: 'bar',
        data: { labels, datasets: sets },
        options: {
          scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } },
          plugins: { legend: { display: sets.length > 1 } },
          ...opts,
        },
      });
    const ms = [...months].sort();
    bar(
      'srMonth',
      ms.map((m) => BT.MONTHS[Number(m.slice(5)) - 1] + ' ' + m.slice(2, 4)),
      [
        { label: 'Calls', data: ms.map((m) => list.filter((r) => r.type === 'CE' && r.day.startsWith(m)).length), backgroundColor: css('--ce') },
        { label: 'Puts', data: ms.map((m) => list.filter((r) => r.type === 'PE' && r.day.startsWith(m)).length), backgroundColor: css('--pe') },
      ],
    );
    bar(
      'srDte',
      DTE_B.map((b) => b[1]),
      [{ label: 'Surges', data: DTE_B.map((b) => list.filter((r) => b[2](r.dte)).length), backgroundColor: COLORS[0] }],
    );
    const hours = [9, 10, 11, 12, 13, 14, 15];
    bar(
      'srHour',
      hours.map((h) => `${h}:00`),
      [{ label: 'Surges', data: hours.map((h) => list.filter((r) => Math.floor((r.troughMin + OPEN) / 60) === h).length), backgroundColor: COLORS[1] }],
    );
    bar(
      'srOtm',
      OTM_B.map((b) => b[1]),
      [{ label: 'Surges', data: OTM_B.map((b) => list.filter((r) => r.otmPct != null && b[2](r.otmPct)).length), backgroundColor: COLORS[4] }],
    );
    calendar(list);
    bindTable(body);
  }
  function calendar(list) {
    const per = new Map();
    for (const r of list) per.set(r.day, (per.get(r.day) || 0) + 1);
    const max = Math.max(1, ...per.values());
    const allDays = [...new Set(rows.map((r) => r.day))].sort();
    if (!allDays.length) return;
    const first = new Date(allDays[0].slice(0, 7) + '-01T00:00:00Z');
    const last = allDays[allDays.length - 1];
    const accent = css('--accent');
    let html = '';
    for (let d = new Date(first); d.toISOString().slice(0, 10) <= last; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth();
      const cells = [];
      const firstWd = new Date(Date.UTC(y, mo, 1)).getUTCDay();
      for (let i = 0; i < (firstWd >= 1 && firstWd <= 5 ? firstWd - 1 : 0); i++) cells.push('<span class="blank"></span>');
      for (let day = 1; day <= 31; day++) {
        const dt = new Date(Date.UTC(y, mo, day));
        if (dt.getUTCMonth() !== mo) break;
        const wd = dt.getUTCDay();
        if (wd === 0 || wd === 6) continue;
        const iso = dt.toISOString().slice(0, 10);
        const n = per.get(iso) || 0;
        const a = n ? 0.18 + 0.82 * Math.sqrt(n / max) : 0;
        cells.push(
          `<span data-day="${iso}" title="${dayLabel(iso)}: ${n} surge${n === 1 ? '' : 's'}" style="${n ? `background:${accent};opacity:${a.toFixed(2)}` : ''}" class="${filt.from === iso && filt.to === iso ? 'on' : ''}"></span>`,
        );
      }
      html += `<div class="sr-cal-month"><span class="lbl">${BT.MONTHS[mo]} ${String(y).slice(2)}</span><div class="sr-cal-days">${cells.join('')}</div></div>`;
    }
    const el = $('srCal');
    el.innerHTML = html;
    el.addEventListener('click', (e) => {
      const d = e.target.dataset.day;
      if (!d) return;
      filt.from = filt.to = d;
      store.set('sr-filter', filt);
      tab = 'list';
      store.set('sr-tab', tab);
      render();
    });
  }

  // ---------- Surges (table + one surge) ----------
  const COLS_T = [
    ['day', 'Date', (r) => dayLabel(r.day)],
    ['strike', 'Contract', (r) => name(r)],
    ['dte', 'DTE', (r) => r.dte],
    ['otmPct', 'OTM at low', (r) => sgn(r.otmPct, 2)],
    ['troughMin', 'Low at', (r) => (r.span === 'intraday' ? hhmm(r.troughMin) : `${dayLabel(r.troughDay)} ${hhmm(r.troughMin)}`)],
    ['trough', 'Low', (r) => rs(r.trough)],
    ['peak', 'Peak', (r) => rs(r.peak)],
    ['mult', 'Rise', (r) => `<span class="sr-mult ${multCls(r.mult)}">×${f1(r.mult, 2)}</span>`],
    ['run', 'Low → peak', (r) => (runMins(r) != null ? runMins(r) + ' min' : `${dayLabel(r.peakDay)} ${hhmm(r.peakMin)}`)],
    ['m100', '+100 % at', (r) => (r.span === 'intraday' ? hhmm(r.m100) : '—')],
    ['m200', '+200 % at', (r) => (r.span === 'intraday' ? hhmm(r.m200) : '—')],
    [
      'niftyMove',
      'Nifty move',
      (r) => `${sgn(r.niftyMove, 2)} <span class="muted small">${r.niftyPts == null ? '' : (r.niftyPts > 0 ? '+' : '') + Math.round(r.niftyPts)} pts</span>`,
    ],
    ['ivLow', 'IV low → peak', (r) => (r.ivLow == null ? '—' : `${f1(r.ivLow, 0)} → ${f1(r.ivPeak, 0)} %`)],
    ['volMult', 'Volume', (r) => (r.volMult == null ? '<span class="muted">—</span>' : '×' + f1(r.volMult, 1))],
    ['oiChg', 'OI', (r) => (r.oiChg == null ? '<span class="muted">—</span>' : sgn(r.oiChg, 1))],
    ['driver', 'Driver', (r) => esc(r.driver)],
    ['tags', 'Tags', (r) => r.tags.map((t) => `<span class="sr-tag ${tagCls(t)}">${esc(t)}</span>`).join('')],
  ];
  function table(list, sortable = true) {
    return `<div class="tbl-wrap sr-tbl-wrap"><table class="grid-tbl sr-tbl"><thead><tr>${COLS_T.map(
      ([k, l]) =>
        `<th class="${['strike', 'driver', 'tags'].includes(k) ? 'l' : ''} ${sortable && sort.k === k ? 'on' : ''}" ${sortable ? `data-sort="${k}"` : ''}>${l}${sortable && sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`,
    ).join('')}</tr></thead><tbody>${list
      .map(
        (r) =>
          `<tr data-id="${r.id}" class="${r.id === selId ? 'on' : ''}">${COLS_T.map(([k, , f]) => `<td class="${['strike', 'driver', 'tags'].includes(k) ? 'l' : ''}">${f(r)}</td>`).join('')}</tr>`,
      )
      .join('')}</tbody></table></div>`;
  }
  function bindTable(root) {
    root.querySelectorAll('.sr-tbl tbody tr').forEach((tr) =>
      tr.addEventListener('click', () => {
        selId = Number(tr.dataset.id);
        if (tab !== 'list') {
          tab = 'list';
          store.set('sr-tab', tab);
        }
        render();
        $('srDetail')?.scrollIntoView({ block: 'nearest' });
      }),
    );
    root.querySelectorAll('.sr-tbl th[data-sort]').forEach((th) =>
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        sort = sort.k === k ? { k, dir: -sort.dir } : { k, dir: -1 };
        store.set('sr-sort', sort);
        render();
      }),
    );
  }
  function sorted(list) {
    const k = sort.k;
    const val = (r) => (k === 'run' ? (runMins(r) ?? 1e9) : k === 'tags' ? r.tags.length : k === 'day' ? r.day + hhmm(r.troughMin) : r[k]);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }
  function renderList(body, head, list) {
    const s = sorted(list);
    const r = rows.find((x) => x.id === selId);
    body.innerHTML = `${head}
      ${r ? `<div class="panel sr-sec" id="srDetail">${detailHtml(r)}</div>` : ''}
      <div class="panel sr-sec"><h3>Every surge <span class="muted small">click a row for its chart and what moved it · click a heading to sort</span></h3>
        ${table(s.slice(0, listLimit))}
        ${s.length > listLimit ? `<button class="btn-sm ghost" data-more>Show ${Math.min(500, s.length - listLimit)} more (${s.length - listLimit} hidden)</button>` : ''}
        <p class="muted small">Low and peak are prices that held for two traded minutes in a row (single stray prints are ignored). Times are IST. DTE = calendar days from the low to the expiry. Volume = traded volume per minute from the low to the peak ÷ the contract's usual (earlier sessions); OI = change of open interest over the same stretch. Both only where downloaded (Fetch volume &amp; OI).</p></div>`;
    body.querySelector('[data-more]')?.addEventListener('click', () => {
      listLimit += 500;
      render();
    });
    bindTable(body);
    if (r) drawDetail(r);
  }
  function detailHtml(r) {
    const call = r.type === 'CE';
    const gain = r.peak - r.trough;
    const lines = [];
    if (r.niftyMove != null)
      lines.push(
        `Nifty went ${r.niftyPts > 0 === call ? 'up' : 'down'} ${Math.abs(Math.round((r.spotPeak - r.spotLow) * 100) / 100)} points (${f1(Math.abs(((r.spotPeak - r.spotLow) / r.spotLow) * 100), 2)} %) from ${r.spotLow} at the low to ${r.spotPeak} at the peak${r.niftyMove > 0 ? ', in this ' + (call ? 'call' : 'put') + "'s favour" : ' — against it'}.`,
      );
    if (r.byMove != null)
      lines.push(
        `At the low's implied volatility (${f1(r.ivLow, 1)} %), that Nifty move alone (with the time that passed) prices the option at ₹${f1(r.trough + r.byMove * gain, 2)}: <b>${f1(Math.max(0, Math.min(1, r.byMove)) * 100, 0)} %</b> of the ₹${f1(gain, 2)} gain. ${r.byMove >= 0.95 ? `Implied volatility hardly mattered (${f1(r.ivPeak, 1)} % at the peak).` : `The rest came from implied volatility rising to ${f1(r.ivPeak, 1)} %.`}`,
      );
    else lines.push('Implied volatility could not be worked out at the low (the price was at or under its intrinsic value), so the gain is not split.');
    lines.push(
      r.dte === 0
        ? 'Expiry day: with hours left, an option near the money has very high gamma — each Nifty point changes its delta a lot, so a cheap option can multiply on a modest move.'
        : `${r.dte} day${r.dte === 1 ? '' : 's'} to expiry at the low${r.dte <= 2 ? ': high gamma, cheap premium — small Nifty moves multiply it.' : '.'}`,
    );
    if (r.otmPct != null)
      lines.push(
        `At the low it was ${r.otmPct > 0 ? f1(r.otmPct, 2) + ' % out of the money' : r.otmPct < 0 ? f1(-r.otmPct, 2) + ' % in the money' : 'at the money'}.`,
      );
    if (r.gapPct != null)
      lines.push(
        `That session Nifty opened ${sgn(r.gapPct, 2)} from the previous close and ${r.troughDay === r.peakDay ? 'closed' : 'on the peak day closed'} ${sgn(r.dayChg, 2)}; the low's session ranged ${f1(r.dayRange, 2)} %.`,
      );
    if (r.vixLow != null && r.vixPeak != null)
      lines.push(`India VIX ${f1(r.vixLow, 2)} → ${f1(r.vixPeak, 2)} (${sgn(((r.vixPeak - r.vixLow) / r.vixLow) * 100, 1)}).`);
    if (r.volMult != null)
      lines.push(
        `Orders: ${r.lots != null ? r.lots.toLocaleString('en-IN') + ' lots' : 'volume'} traded from the low to the peak (≈ ${kinr(r.turnover)} of premium), <b>${f1(r.volMult, 1)}×</b> the contract's usual volume per minute. ` +
          (r.oiChg != null
            ? `Open interest ${r.oiChg < 0 ? 'fell' : 'rose'} ${f1(Math.abs(r.oiChg), 1)} %: ${r.flow === 'Short covering' ? '<b>short covering</b> — option writers buying back their shorts, which pushes the price up fast' : r.flow === 'Long build-up' ? '<b>long build-up</b> — new buyers opening positions' : 'little change, so the buying and selling was mostly between existing holders'}.`
            : '') +
          (r.volLead != null
            ? ` The first volume burst (5× usual in a minute) came ${r.volLead >= 0 ? r.volLead + ' min before' : -r.volLead + ' min after'} the +50 % mark.`
            : ''),
      );
    else lines.push('<span class="muted">Volume and open interest for this contract have not been downloaded (Fetch volume &amp; OI, top right).</span>');
    const macro = r.tags.filter((t) => t.startsWith('Macro')).map((t) => t.slice(7));
    if (macro.length) lines.push(`Market news that day: <b>${esc(macro.join('; '))}</b>.`);
    const intr = r.span === 'intraday';
    const p100 = r.trough * 2;
    const after =
      intr && r.m100 != null
        ? `Bought at the +100 % mark (₹${f1(p100, 2)}, ${hhmm(r.m100)}): ${sgn(((r.peak - p100) / p100) * 100, 0)} at the peak, ${sgn(((r.dayClose - p100) / p100) * 100, 0)} at the session close (₹${f1(r.dayClose, 2)}). The peak is known only afterwards — the Backtest tab trades the signal without that hindsight.`
        : '';
    const mv = r.byMove == null ? 0 : Math.max(0, Math.min(1, r.byMove));
    return `<h3>${r.strike} ${r.type} · expiry ${dayLabel(r.expiry)} · ${intr ? dayLabel(r.day) : `${dayLabel(r.troughDay)} → ${dayLabel(r.peakDay)}`} <span class="sr-mult ${multCls(r.mult)}">×${f1(r.mult, 2)}</span> <span class="muted small">${rs(r.trough)} → ${rs(r.peak)} · ${esc(r.driver)}</span></h3>
      <div class="sr-detail">
        <div><div class="sr-chart tall"><canvas id="srOne"></canvas></div><div class="muted small" id="srOneNote">Loading the minute prices…</div></div>
        <div class="sr-why">
          ${r.byMove != null ? `<div><div class="sr-split"><span class="mv" style="width:${mv * 100}%"></span><span class="iv" style="width:${(1 - mv) * 100}%"></span></div><div class="sr-legend"><span><i style="background:var(--accent)"></i>Nifty move ${f1(mv * 100, 0)} %</span><span><i style="background:var(--atm)"></i>Implied volatility ${f1((1 - mv) * 100, 0)} %</span></div></div>` : ''}
          <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          ${after ? `<div class="muted small">${after}</div>` : ''}
          <div>${r.tags.map((t) => `<span class="sr-tag ${tagCls(t)}">${esc(t)}</span>`).join('')}</div>
        </div>
      </div>`;
  }
  async function drawDetail(r) {
    const key = `${r.expiry}|${r.strike}|${r.type}|${r.troughDay}|${r.peakDay}`;
    let s = seriesCache.get(key);
    try {
      if (!s) {
        s = await api(`/api/surge/series?expiry=${r.expiry}&strike=${r.strike}&type=${r.type}&from=${r.troughDay}&to=${r.peakDay}`);
        seriesCache.set(key, s);
      }
    } catch (e) {
      const n = $('srOneNote');
      if (n) n.textContent = e.message;
      return;
    }
    if (selId !== r.id || !$('srOne')) return;
    const multi = s.days.length > 1;
    const labels = [];
    const opt = [];
    const nifty = [];
    const vol = [];
    const oi = [];
    const marks = [];
    const volDays = s.vol?.days || {};
    for (const d of s.days) {
      const om = new Map(d.opt.map((x) => [x[0], x[4]]));
      const nm = new Map(d.nifty.map((x) => [x[0], x[1]]));
      const vm = new Map((volDays[d.day] || []).map((x) => [x[0], x]));
      for (let m = 0; m < 375; m++) {
        labels.push(multi ? `${d.day.slice(8)}/${d.day.slice(5, 7)} ${hhmm(m)}` : hhmm(m));
        opt.push(om.get(m) ?? null);
        nifty.push(nm.get(m) ?? null);
        vol.push(vm.get(m)?.[1] ?? null);
        oi.push(vm.get(m)?.[2] > 0 ? vm.get(m)[2] : null);
        const at = (day, min) => day === d.day && min === m;
        marks.push(
          at(r.troughDay, r.troughMin)
            ? 'Low'
            : at(r.peakDay, r.peakMin)
              ? 'Peak'
              : !multi && m === r.m100
                ? '+100 %'
                : !multi && m === r.m200
                  ? '+200 %'
                  : !multi && m === r.m50
                    ? '+50 %'
                    : null,
        );
      }
    }
    const haveVol = vol.some((v) => v != null);
    const sets = [
      {
        label: `${r.strike} ${r.type} ₹`,
        data: opt,
        borderColor: r.type === 'CE' ? css('--ce') : css('--pe'),
        yAxisID: 'y',
        spanGaps: true,
        borderWidth: 1.6,
        pointRadius: marks.map((x) => (x ? 5 : 0)),
        pointBackgroundColor: css('--text'),
        order: 1,
      },
      { label: 'Nifty', data: nifty, borderColor: COLORS[0], yAxisID: 'yn', spanGaps: true, borderWidth: 1, pointRadius: 0, borderDash: [4, 3], order: 2 },
    ];
    if (haveVol) {
      sets.push({ type: 'bar', label: 'Volume', data: vol, backgroundColor: 'rgba(154,165,177,.45)', yAxisID: 'yv', order: 4 });
      sets.push({ label: 'Open interest', data: oi, borderColor: COLORS[1], yAxisID: 'yo', spanGaps: true, borderWidth: 1, pointRadius: 0, order: 3 });
    }
    const vmax = Math.max(1, ...vol.filter((v) => v != null));
    chart($('srOne'), {
      type: 'line',
      data: { labels, datasets: sets },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 10, autoSkip: true }, grid: { display: false } },
          y: { position: 'left', title: { display: true, text: 'Option ₹' } },
          yn: { position: 'right', grid: { display: false }, title: { display: true, text: 'Nifty' } },
          yv: { display: false, min: 0, max: vmax * 3.2 },
          yo: { display: false },
        },
        plugins: {
          tooltip: {
            callbacks: {
              afterTitle: (it) => marks[it[0].dataIndex] || '',
              label: (c) =>
                c.parsed.y == null
                  ? null
                  : `${c.dataset.label}: ${c.dataset.yAxisID === 'y' ? '₹' + c.parsed.y.toFixed(2) : Math.round(c.parsed.y).toLocaleString('en-IN')}`,
            },
          },
        },
      },
    });
    const n = $('srOneNote');
    if (n)
      n.textContent = `Dots: the low, +50 %, +100 %, +200 % and the peak. ${haveVol ? 'Grey bars: volume per minute; amber: open interest.' : 'No volume / OI downloaded for this contract.'} Dashed: Nifty (right axis).`;
  }

  // ---------- Price vs. Nifty move ----------
  function renderRel(body, head, list) {
    const intr = rows.filter((r) => r.span === 'intraday' && pass(r, { ...filt, span: 'intraday' }, true) && r.mult >= 2);
    const odds = DTE_B.map(([, l, f]) => {
      const g = intr.filter((r) => f(r.dte));
      const n3 = g.filter((r) => r.mult >= 3).length;
      const n5 = g.filter((r) => r.mult >= 5).length;
      return {
        l,
        n: g.length,
        p3: g.length ? (n3 / g.length) * 100 : null,
        p5: n3 ? (n5 / n3) * 100 : null,
        med: median(g.map((r) => r.mult)),
        mv: median(g.filter((r) => r.mult >= 3).map((r) => r.niftyMove)),
      };
    });
    // median Nifty move behind a 3× by days to expiry × moneyness
    const need = DTE_B.map(([, l, f]) => ({
      l,
      cells: OTM_B.map(([, , of]) => {
        const g = list.filter((r) => r.mult >= 3 && f(r.dte) && r.otmPct != null && of(r.otmPct) && r.niftyMove != null);
        return { n: g.length, v: median(g.map((r) => r.niftyMove)) };
      }),
    }));
    const lm = list.map((r) => Math.log(r.mult));
    const c = (k) =>
      corr(
        list.map((r) => r[k]),
        lm,
      );
    const withVol = list.filter((r) => r.volMult != null);
    body.innerHTML = `${head}
      <div class="sr-grid2">
        <div class="panel sr-sec"><h3>Rise vs. Nifty move <span class="muted small">x: Nifty % in the option's favour, low → peak · y: rise (log) · colour: days to expiry</span></h3><div class="sr-chart tall"><canvas id="srSc1"></canvas></div></div>
        <div class="panel sr-sec"><h3>Rise vs. moneyness at the low <span class="muted small">x: % out of the money (negative = in the money)</span></h3><div class="sr-chart tall"><canvas id="srSc2"></canvas></div></div>
        <div class="panel sr-sec"><h3>Rise vs. premium at the low <span class="muted small">x: ₹ (log) — cheap options multiply most</span></h3><div class="sr-chart tall"><canvas id="srSc3"></canvas></div></div>
        <div class="panel sr-sec"><h3>Rise vs. trading volume <span class="muted small">x: volume per minute ÷ usual (log) · ${withVol.length} surges with volume downloaded</span></h3><div class="sr-chart tall"><canvas id="srSc4"></canvas></div></div>
      </div>
      <div class="sr-grid2">
        <div class="panel sr-sec"><h3>Once it has doubled, how often does it go on? <span class="muted small">intraday doublings with these filters (rise filter ignored)</span></h3>
          <table class="grid-tbl sr-odds"><thead><tr><th class="l">Days to expiry</th><th>Doubled</th><th>… then reached 3×</th><th>3× → 5×</th><th>Median peak</th><th>Nifty move for 3×</th></tr></thead><tbody>
          ${odds.map((o) => `<tr><th>${o.l}</th><td>${o.n.toLocaleString('en-IN')}</td><td>${o.p3 == null ? '—' : f1(o.p3, 0) + ' %'}<span class="sr-bar" style="width:${(o.p3 || 0) * 0.8}px"></span></td><td>${o.p5 == null ? '—' : f1(o.p5, 0) + ' %'}</td><td>${o.med == null ? '—' : '×' + f1(o.med, 2)}</td><td>${sgn(o.mv, 2)}</td></tr>`).join('')}
          </tbody></table>
          <p class="muted small">Read: of the options that doubled off their session low, this share kept going to three times the low. The rest gave it back first (the peak counts until 40 % of it is given back).</p></div>
        <div class="panel sr-sec"><h3>Nifty move behind a 3× <span class="muted small">median Nifty % in favour, low → peak (count)</span></h3>
          <table class="grid-tbl sr-odds"><thead><tr><th class="l">Days to expiry</th>${OTM_B.map((b) => `<th>${b[1]}</th>`).join('')}</tr></thead><tbody>
          ${need.map((n) => `<tr><th>${n.l}</th>${n.cells.map((x) => `<td>${x.n ? `${sgn(x.v, 2)} <span class="muted small">(${x.n})</span>` : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
          </tbody></table>
          <p class="muted small">How strongly each thing goes with a bigger rise (correlation with log rise): Nifty move ${f1(c('niftyMove'), 2)}, % OTM ${f1(c('otmPct'), 2)}, days to expiry ${f1(c('dte'), 2)}, premium at the low ${f1(
            corr(
              list.map((r) => Math.log(r.trough)),
              lm,
            ),
            2,
          )}, IV change ${f1(
            corr(
              list.map((r) => (r.ivLow ? r.ivPeak - r.ivLow : null)),
              lm,
            ),
            2,
          )}${
            withVol.length > 20
              ? `, volume × ${f1(
                  corr(
                    list.map((r) => (r.volMult ? Math.log(r.volMult) : null)),
                    lm,
                  ),
                  2,
                )}`
              : ''
          }.</p></div>
      </div>`;
    const groups = [
      ['Expiry day', (r) => r.dte === 0, COLORS[3]],
      ['1–2 days', (r) => r.dte >= 1 && r.dte <= 2, COLORS[1]],
      ['3–7 days', (r) => r.dte >= 3 && r.dte <= 7, COLORS[0]],
      ['8+ days', (r) => r.dte >= 8, COLORS[4]],
    ];
    const sample = list.length > 4000 ? list.filter((_, i) => i % Math.ceil(list.length / 4000) === 0) : list;
    const scatter = (id, xf, xlab, xlog = false) =>
      chart($(id), {
        type: 'scatter',
        data: {
          datasets: groups.map(([l, f, col]) => ({
            label: l,
            data: sample.filter((r) => f(r) && xf(r) != null && (!xlog || xf(r) > 0)).map((r) => ({ x: xf(r), y: r.mult, id: r.id })),
            backgroundColor: col + 'aa',
            pointRadius: 2.2,
          })),
        },
        options: {
          scales: {
            x: { type: xlog ? 'logarithmic' : 'linear', title: { display: true, text: xlab } },
            y: {
              type: 'logarithmic',
              title: { display: true, text: 'Rise ×' },
              ticks: { callback: (v) => ([1, 2, 3, 5, 10, 20, 50, 100].includes(v) ? '×' + v : '') },
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (c) => {
                  const r = rows[c.raw.id];
                  return `${dayLabel(r.day)} ${r.strike} ${r.type}: ×${f1(r.mult, 2)} (${rs(r.trough)} → ${rs(r.peak)}), Nifty ${sgn(r.niftyMove, 2)}`;
                },
              },
            },
          },
          onClick: (e, els) => {
            if (!els.length) return;
            const ds = e.chart.data.datasets[els[0].datasetIndex];
            selId = ds.data[els[0].index].id;
            tab = 'list';
            store.set('sr-tab', tab);
            render();
          },
        },
      });
    scatter('srSc1', (r) => r.niftyMove, 'Nifty move in favour, %');
    scatter('srSc2', (r) => r.otmPct, '% out of the money at the low');
    scatter('srSc3', (r) => r.trough, 'Premium at the low, ₹', true);
    scatter('srSc4', (r) => r.volMult, 'Volume per minute ÷ usual', true);
  }

  // ---------- What causes them ----------
  function renderWhy(body, head, list) {
    const by = (key) => {
      const m = new Map();
      for (const r of list) {
        const ks = key(r);
        for (const k of Array.isArray(ks) ? ks : [ks]) {
          if (k == null) continue;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(r);
        }
      }
      return [...m].map(([k, g]) => ({ k, g, n: g.length })).sort((a, b) => b.n - a.n);
    };
    const drivers = by((r) => r.driver);
    const tags = by((r) => r.tags.map((t) => (t.startsWith('Macro') ? 'Macro news day' : t.startsWith('Volume') ? 'Volume ≥ 5× usual' : t)));
    const flows = by((r) => r.flow);
    const withVol = list.filter((r) => r.volLead != null);
    const led = withVol.filter((r) => r.volLead > 0).length;
    const macro = by((r) => r.tags.filter((t) => t.startsWith('Macro')).map((t) => `${r.day}|${t.slice(7)}`));
    const split = DTE_B.map(([, l, f]) => {
      const g = list.filter((r) => f(r.dte) && r.byMove != null);
      const mv = mean(g.map((r) => Math.max(0, Math.min(1, r.byMove))));
      return { l, n: g.length, mv };
    });
    const row = (x) =>
      `<tr><th class="l">${esc(x.k)}</th><td>${x.n.toLocaleString('en-IN')}</td><td>${f1((x.n / Math.max(1, list.length)) * 100, 0)} %</td><td>×${f1(median(x.g.map((r) => r.mult)), 2)}</td><td>${sgn(median(x.g.map((r) => r.niftyMove)), 2)}</td><td>${f1(median(x.g.map(runMins)), 0)} min</td><td>${x.g.some((r) => r.volMult != null) ? '×' + f1(median(x.g.map((r) => r.volMult)), 1) : '—'}</td></tr>`;
    const thead = `<thead><tr><th class="l"></th><th>Surges</th><th>Share</th><th>Median rise</th><th>Median Nifty move</th><th>Low → peak</th><th>Volume</th></tr></thead>`;
    body.innerHTML = `${head}
      <div class="panel sr-sec"><h3>What moves an option 200 %+</h3>
        <p>An option's price is set by Nifty's level, the time left and the implied volatility (IV). Each surge is split into the part the <b>Nifty move</b> explains — repricing the option at the low's IV with the new Nifty level and the time that passed — and the part only a <b>higher IV</b> explains. When the Nifty move explains ≥ 60 %, the driver is the move (on expiry day: <i>expiry-day gamma</i>, where a cheap near-the-money option multiplies on a small move); when IV explains ≥ 50 %, it is a <i>volatility expansion</i> (fear or news priced in before Nifty moves much). The order flow (where downloaded) shows <i>who</i> was trading: open interest falling while the price jumps is <b>short covering</b> (option writers buying back, often in a hurry — the classic squeeze), rising is <b>long build-up</b> (new buyers). Volume and OI never cause a move on their own: they are the orders that carry it, so the question is whether they show up <i>before</i> the price does.</p></div>
      <div class="sr-grid2">
        <div class="panel sr-sec"><h3>Main driver</h3><table class="grid-tbl">${thead}<tbody>${drivers.map(row).join('')}</tbody></table></div>
        <div class="panel sr-sec"><h3>Who traded <span class="muted small">open interest from the low to the peak · ${list.filter((r) => r.flow).length} of ${list.length} with volume / OI</span></h3>
          ${flows.length ? `<table class="grid-tbl">${thead}<tbody>${flows.map(row).join('')}</tbody></table>` : '<p class="muted">No volume / OI downloaded yet: Fetch volume &amp; OI (top right).</p>'}
          ${withVol.length ? `<p class="small">Volume burst (5× usual in a minute) <b>before</b> the +50 % mark in <b>${f1((led / withVol.length) * 100, 0)} %</b> of ${withVol.length} intraday surges; median lead ${f1(median(withVol.map((r) => r.volLead)), 0)} min. ${led / withVol.length > 0.5 ? 'Heavy buying usually shows up a little before the price takes off — the radar watches for it.' : 'The price usually moves first and the volume follows: volume is a confirmation, not an early warning.'}</p>` : ''}</div>
        <div class="panel sr-sec"><h3>Tags <span class="muted small">a surge can carry several</span></h3><div class="sr-chart"><canvas id="srTags"></canvas></div></div>
        <div class="panel sr-sec"><h3>Nifty move vs. IV, by days to expiry <span class="muted small">average share of the gain</span></h3><div class="sr-chart"><canvas id="srSplit"></canvas></div></div>
      </div>
      <div class="panel sr-sec"><h3>News days <span class="muted small">from a small seed calendar (RBI policy, Budget, elections, tariff and war news) — add your own in bt-data/surge-calendar.json as [["YYYY-MM-DD", "what happened"], …] and rescan</span></h3>
        ${
          macro.length
            ? `<table class="grid-tbl"><thead><tr><th class="l">Day</th><th class="l">News</th><th>Surges</th><th>Biggest</th></tr></thead><tbody>${macro
                .sort((a, b) => (a.k < b.k ? 1 : -1))
                .map((x) => {
                  const [d, t] = x.k.split('|');
                  const big = [...x.g].sort((a, b) => b.mult - a.mult)[0];
                  return `<tr><th class="l">${dayLabel(d)}</th><td class="l">${esc(t)}</td><td>${x.n}</td><td>×${f1(big.mult, 1)} ${big.strike} ${big.type}</td></tr>`;
                })
                .join('')}</tbody></table>`
            : '<p class="muted">No surge with these filters fell on a listed news day.</p>'
        }</div>`;
    chart($('srTags'), {
      type: 'bar',
      data: { labels: tags.map((t) => t.k), datasets: [{ label: 'Surges', data: tags.map((t) => t.n), backgroundColor: COLORS[0] }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } },
    });
    chart($('srSplit'), {
      type: 'bar',
      data: {
        labels: split.map((s) => `${s.l} (${s.n})`),
        datasets: [
          { label: 'Nifty move', data: split.map((s) => (s.mv == null ? null : s.mv * 100)), backgroundColor: css('--accent') },
          { label: 'Implied volatility', data: split.map((s) => (s.mv == null ? null : (1 - s.mv) * 100)), backgroundColor: css('--atm') },
        ],
      },
      options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, max: 100, ticks: { callback: (v) => v + ' %' } } } },
    });
  }

  // ---------- Backtest ----------
  function verdict(s) {
    if (!s || !s.trades) return '<div class="sr-verdict">No trades with these settings.</div>';
    const both = s.h1 && s.h2 && s.h1.net > 0 && s.h2.net > 0;
    const c = s.net > 0 ? (both ? 'pos' : '') : 'neg';
    const msg =
      s.net > 0
        ? both && s.exTop5 <= 0
          ? `Made money in both halves (${inrS(s.h1.net)} then ${inrS(s.h2.net)}), but only because of a few big days: without its 5 best trades it is ${inrS(s.exTop5)}. That is a lottery ticket that paid off in this sample (crash or squeeze days), not a steady edge.`
          : both
            ? `Made money in both halves of the period (${inrS(s.h1.net)} then ${inrS(s.h2.net)}). Treat it as a lead, not a proven edge: one setting picked from many will look better than it is — check the grid and the trades.`
            : `Made money overall but not in both halves (${inrS(s.h1?.net)} then ${inrS(s.h2?.net)}): it depends on a few days. Not reliable.`
        : `Lost money after charges and ${btParams?.slippage ?? 0.5} % slippage per fill: buying a surge once it is visible did not pay. Winners were big (avg ${inrS(s.avgWin)}) but too rare against the stops (avg ${inrS(s.avgLoss)}).`;
    return `<div class="sr-verdict ${c}"><b>${inrS(s.net)}</b> over ${s.trades} trades · win rate ${f1(s.winRate, 0)} % · ${msg}</div>`;
  }
  function renderBt() {
    const p = btParams;
    const field = ([k, l, kind, x]) => {
      const v = p[k];
      const input =
        kind === 'sel'
          ? `<select data-bt="${k}">${x.map(([a, b]) => `<option value="${a}"${String(v) === a ? ' selected' : ''}>${b}</option>`).join('')}</select>`
          : kind === 'time'
            ? `<input type="time" data-bt="${k}" value="${v}">`
            : `<input class="num" type="number" step="${x}" data-bt="${k}" value="${v}">`;
      return `<span class="lbl">${l}</span>${input}`;
    };
    const F = Object.fromEntries(BT_FIELDS.map((f) => [f[0], f]));
    const lottery = p.mode === 'lottery';
    const saved = meta.backtest;
    const grid = meta.grid;
    $('srBody').innerHTML = `
      <div class="panel sr-sec"><h3>Trade the surge without hindsight</h3>
        <p class="small">Every contract in the cache is watched minute by minute — including the many that double and then collapse. ${lottery ? 'Lottery: at the set time, on days within the days-to-expiry limit, buy the call and the put priced nearest the premium; sell at the target or at the exit time.' : "When a contract's close reaches N × its session low (the low at least ₹X, Nifty confirming), buy at the next minute's open plus slippage; sell at the target, the stop, the trailing stop or the exit time, whichever comes first. If several signal on one day, the earliest are taken."} Charges as on the contract note (STT, exchange, GST, stamp, ₹20 a order); size = the premium budget in whole lots (at least one), the lot of that time.</p>
        <div class="sr-form">
          <div class="set-row"><b>Entry</b>${field(F.mode)}</div>
          ${
            lottery
              ? `<div class="set-row"><b>What</b>${field(F.premium)}${field(F.lotteryAt)}${field(F.minBase)}${field(F.sides)}${field(F.dteMax)}</div>`
              : `<div class="set-row"><b>Signal</b>${field(F.trigger)}${field(F.minBase)}${field(F.maxBase)}${field(F.confirm)}</div>
          <div class="set-row"><b>Which</b>${field(F.sides)}${field(F.dteMax)}${field(F.entryFrom)}${field(F.entryTo)}${field(F.maxPerDay)}</div>`
          }
          <div class="set-row"><b>Exit</b>${field(F.targetMult)}${field(F.targetPct)}${field(F.stopPct)}${field(F.trailPct)}${field(F.exitAt)}</div>
          <div class="set-row"><b>Money</b>${field(F.budget)}${field(F.capital)}${field(F.slippage)}
            <span class="run-box"><button class="btn-sm ghost" data-bt-reset>Defaults</button><button class="btn-sm ghost" data-bt-grid title="${grid ? 'Runs 114 variants (trigger × exit × days to expiry × side, and the lottery) on these money settings: about a minute' : 'about a minute'}">Run the grid</button><button class="btn-sm run" data-bt-run>Run backtest</button></span></div>
        </div></div>
      ${saved ? btResult(saved) : '<div class="panel sr-empty muted">No backtest run yet.</div>'}
      ${grid ? gridHtml(grid) : ''}`;
    const root = $('srBody');
    root.querySelectorAll('[data-bt]').forEach((el) =>
      el.addEventListener('change', () => {
        const k = el.dataset.bt;
        p[k] = el.type === 'number' ? Number(el.value) : el.value;
        store.set('sr-bt', p);
        if (k === 'mode') renderBt();
      }),
    );
    root.querySelector('[data-bt-reset]').addEventListener('click', () => {
      btParams = { ...meta.btDefaults };
      store.set('sr-bt', {});
      renderBt();
    });
    root.querySelector('[data-bt-run]').addEventListener('click', () => startJob('/api/surge/backtest', { params: btParams }, 'backtest'));
    root.querySelector('[data-bt-grid]').addEventListener('click', () =>
      startJob(
        '/api/surge/backtest',
        {
          params: { budget: p.budget, capital: p.capital, slippage: p.slippage, minBase: p.minBase, confirm: p.confirm, maxPerDay: p.maxPerDay },
          grid: true,
        },
        'grid',
      ),
    );
    root.querySelectorAll('[data-grid-row]').forEach((tr) =>
      tr.addEventListener('click', () => {
        const g = grid.rows[Number(tr.dataset.gridRow)].params;
        btParams = { ...btParams, ...g };
        delete btParams.name;
        store.set('sr-bt', btParams);
        renderBt();
        window.scrollTo(0, 0);
        $('srBody').closest('main').scrollTop = 0;
      }),
    );
    root.querySelectorAll('[data-grid-sort]').forEach((th) =>
      th.addEventListener('click', () => {
        store.set('sr-grid-sort', th.dataset.gridSort);
        renderBt();
      }),
    );
    if (saved?.summary?.equity?.length) {
      chart($('srEq'), {
        type: 'line',
        data: {
          labels: saved.summary.equity.map((e) => e[0]),
          datasets: [
            { label: 'Cumulative P&L', data: saved.summary.equity.map((e) => e[1]), borderColor: COLORS[0], pointRadius: 0, borderWidth: 1.5, fill: false },
          ],
        },
        options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { ticks: { callback: (v) => kinr(v) } } } },
      });
    }
  }
  function btResult(b) {
    const s = b.summary;
    const p = b.params;
    const grp = (title, list, lab = (k) => k) =>
      `<div><h4 class="small">${title}</h4><table class="grid-tbl"><thead><tr><th class="l"></th><th>Trades</th><th>Win</th><th>Net</th></tr></thead><tbody>${list
        .map((g) => `<tr><th class="l">${esc(lab(g.key))}</th><td>${g.trades}</td><td>${f1(g.win, 0)} %</td><td class="${cls(g.net)}">${inrS(g.net)}</td></tr>`)
        .join('')}</tbody></table></div>`;
    const WHY = { target: 'Target', stop: 'Stop', trail: 'Trailing stop', time: 'Exit time' };
    return `<div class="panel sr-sec"><h3>Result <span class="muted small">${new Date(b.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${p.mode === 'lottery' ? `lottery ₹${p.premium} at ${p.lotteryAt}` : `signal ${p.trigger}× low ≥ ₹${p.minBase}${p.confirm ? `, Nifty ≥ ${p.confirm} %` : ''}`}, ${p.sides === 'both' ? 'calls and puts' : p.sides}, ≤ ${p.dteMax} days to expiry · exit ${[p.targetMult ? `${p.targetMult}× low` : '', p.targetPct ? `+${p.targetPct} %` : '', p.stopPct ? `stop −${p.stopPct} %` : '', p.trailPct ? `trail ${p.trailPct} %` : '', `by ${p.exitAt}`].filter(Boolean).join(', ')} · ₹${Number(p.budget).toLocaleString('en-IN')} a trade</span></h3>
      ${verdict(s)}
      <div class="kpis">
        ${tile('Net P&L', inrS(s.net), `${f1(s.cagrPct, 1)} %/yr on ${kinr(p.capital)}`, cls(s.net))}
        ${tile('Trades', s.trades, `${s.wins} won · ${f1(s.winRate, 0)} %`)}
        ${tile('Profit factor', f1(s.pf, 2), 'gross wins ÷ gross losses')}
        ${tile('Avg win / loss', `${kinr(s.avgWin)} / ${kinr(s.avgLoss)}`, `best ${kinr(s.best)} · worst ${kinr(s.worst)}`)}
        ${tile('Max drawdown', kinr(s.maxDD), 'peak to trough of the running P&L', 'neg')}
        ${tile('Reached target', f1(s.hitTarget, 0) + ' %', 'of trades')}
        ${tile('Without the 5 best', inrS(s.exTop5), 'net P&L if the 5 best trades had not happened', cls(s.exTop5))}
        ${tile('First half', inrS(s.h1?.net), `${s.h1?.trades} trades · to ${s.mid ? dayLabel(s.mid) : ''}`, cls(s.h1?.net))}
        ${tile('Second half', inrS(s.h2?.net), `${s.h2?.trades} trades`, cls(s.h2?.net))}
        ${tile('Charges', kinr(s.charges), 'included above')}
      </div>
      <div class="sr-chart"><canvas id="srEq"></canvas></div>
      <div class="sr-grid3">${grp('By exit', s.byExit, (k) => WHY[k] || k)}${grp('By side', s.bySide)}${grp('By days to expiry', s.byDte)}</div>
      ${
        b.trades?.length
          ? `<details><summary class="small">The ${b.trades.length} trades</summary><div class="tbl-wrap sr-tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Day</th><th class="l">Contract</th><th>Low</th><th>Signal</th><th>Bought</th><th>Sold</th><th>Why</th><th>Lots</th><th>Return</th><th>P&amp;L</th></tr></thead><tbody>${[
              ...b.trades,
            ]
              .reverse()
              .map(
                (t) =>
                  `<tr><th class="l">${dayLabel(t.day)}</th><td class="l">${t.strike} <span class="sr-type ${t.type}">${t.type}</span> <span class="muted small">${dayLabel(t.expiry)}</span></td><td>${rs(t.low)}</td><td>${t.sigAt}</td><td>${rs(t.entry)} ${t.entryAt}</td><td>${rs(t.exit)} ${t.exitAt}</td><td>${WHY[t.why] || t.why}</td><td>${t.lots}</td><td class="${cls(t.ret)}">${sgn(t.ret, 0)}</td><td class="${cls(t.pnl)}">${inrS(t.pnl)}</td></tr>`,
              )
              .join('')}</tbody></table></div></details>`
          : ''
      }</div>`;
  }
  function gridHtml(g) {
    const k = store.get('sr-grid-sort', 'net');
    const val = (r) => (k === 'h' ? Math.min(r.summary.h1?.net ?? -1e12, r.summary.h2?.net ?? -1e12) : k === 'pf' ? (r.summary.pf ?? 0) : r.summary.net);
    const list = g.rows.map((r, i) => ({ ...r, i })).sort((a, b) => val(b) - val(a));
    const pos = g.rows.filter((r) => r.summary.net > 0).length;
    const both = g.rows.filter((r) => r.summary.h1?.net > 0 && r.summary.h2?.net > 0).length;
    const steady = g.rows.filter((r) => r.summary.h1?.net > 0 && r.summary.h2?.net > 0 && r.summary.exTop5 > 0).length;
    const puts = g.rows.filter((r) => r.summary.net > 0 && r.params.sides === 'PE').length;
    return `<div class="panel sr-sec"><h3>Grid <span class="muted small">${g.rows.length} variants · ${new Date(g.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ₹${Number(g.base.budget || meta.btDefaults.budget).toLocaleString('en-IN')} a trade · click a row to load it above</span></h3>
      <div class="sr-verdict ${pos ? '' : 'neg'}">${pos} of ${g.rows.length} variants made money (${puts} of them on puts only); ${both} made money in both halves of the period, and ${steady} of those still did without their 5 best trades. ${steady <= Math.max(2, g.rows.length * 0.05) ? 'Few enough to be chance when this many settings are tried: the profitable rows lean on a handful of crash or squeeze days. No steady edge in buying surges.' : 'Look for the ones that hold in both halves, without their best days, before trusting any.'}</div>
      <div class="tbl-wrap sr-tbl-wrap"><table class="grid-tbl sr-grid-tbl"><thead><tr><th class="l">Entry</th><th class="l">Exit</th><th>DTE ≤</th><th>Side</th><th>Trades</th><th>Win</th><th data-grid-sort="net" style="cursor:pointer">${k === 'net' ? '▼ ' : ''}Net</th><th data-grid-sort="pf" style="cursor:pointer">${k === 'pf' ? '▼ ' : ''}PF</th><th>Max DD</th><th>1st half</th><th>2nd half</th><th>Without best 5</th><th data-grid-sort="h" style="cursor:pointer" title="Sort by the worse of the two halves">${k === 'h' ? '▼ ' : ''}Both halves</th></tr></thead><tbody>${list
        .map((r) => {
          const p = r.params;
          const s = r.summary;
          const ok = s.h1?.net > 0 && s.h2?.net > 0;
          return `<tr data-grid-row="${r.i}"><th class="l">${p.mode === 'lottery' ? `Lottery ₹${p.premium} at ${p.lotteryAt}` : `${p.trigger}× low`}</th><td class="l">${esc(p.name || '')}</td><td>${p.dteMax}</td><td>${p.sides === 'both' ? 'Both' : p.sides}</td><td>${s.trades}</td><td>${f1(s.winRate, 0)} %</td><td class="${cls(s.net)}">${kinr(s.net)}</td><td>${f1(s.pf, 2)}</td><td>${kinr(s.maxDD)}</td><td class="${cls(s.h1?.net)}">${kinr(s.h1?.net)}</td><td class="${cls(s.h2?.net)}">${kinr(s.h2?.net)}</td><td class="${cls(s.exTop5)}">${kinr(s.exTop5)}</td><td>${ok ? '<span class="sr-ok">✓</span>' : ''}</td></tr>`;
        })
        .join('')}</tbody></table></div></div>`;
  }

  // ---------- Live radar ----------
  function stopLive() {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  async function pollLive() {
    stopLive();
    if (tab !== 'live' || window.app?.state.view !== 'surge') return;
    try {
      live = await api('/api/surge/live');
      liveError = '';
    } catch (e) {
      liveError = e.message;
    }
    if (tab === 'live' && window.app?.state.view === 'surge') {
      drawLive();
      liveTimer = setTimeout(pollLive, document.hidden ? 15000 : 5000);
    }
  }
  // historical odds that a contract at this stage goes on to 3×, for its days to expiry, side and price
  function oddsFor(r) {
    if (!rows) return null;
    const dte = Math.round((Date.parse(r.expiry) - Date.parse(live.day)) / 86400000);
    const lowB = r.low < 5 ? [2, 5] : r.low < 20 ? [5, 20] : r.low < 50 ? [20, 50] : [50, 1e9];
    const g = rows.filter(
      (x) => x.span === 'intraday' && x.type === r.type && dteBucket(x.dte) === dteBucket(dte) && x.trough >= lowB[0] && x.trough < lowB[1],
    );
    const base = r.mult >= 2 ? g : null; // the scan holds doublings only: odds from +100 % on
    if (!base?.length) return null;
    const n3 = base.filter((x) => x.mult >= 3).length;
    return { p: (n3 / base.length) * 100, n: base.length };
  }
  function renderLive() {
    $('srBody').innerHTML =
      `<div class="panel sr-sec"><h3>Live radar <span class="muted small">options of the next expiries (up to 7 days) climbing off today's low · refreshed every 5 s · paper only</span></h3>
      <p class="small">It reads the live chain this server keeps (the nearest expiry, and any other one open on the Chain or the Builder) and knows today's lows from the first snapshot it saw. Options whose low is under the minimum option price (₹${minPrice()}, top right) are left out. <b>Rising</b> = up 50 % from the low, <b>doubled</b> = 100 %, <b>tripled</b> = 200 %. Next to each: how fast it is trading now against its pace since tracking started, open interest since the low (falling = shorts covering), and the Nifty move since the low in its favour. Each stage change is written to events/&lt;day&gt;/surge-radar.jsonl so the calls can be checked against what happened. The historical column says how often an intraday doubling like it (same side, days to expiry and price band) reached 3× in the scanned history — remember the backtest: buying at that point did not pay after costs.</p>
      <div id="srLive"><span class="spin"></span> Loading…</div></div>`;
    pollLive();
  }
  function drawLive() {
    const el = $('srLive');
    if (!el) return;
    if (liveError) return (el.innerHTML = `<p class="neg">${esc(liveError)}</p>`);
    const L = live;
    if (!L.loggedIn) return (el.innerHTML = '<p class="muted">Log in to the live data source (Live › Chain) first: the radar reads the live chain.</p>');
    if (!L.day)
      return (el.innerHTML = `<p class="muted">${L.marketOpen ? 'Waiting for the first chain snapshot…' : 'Market closed: the radar starts with the next session (it needs the chain to be streaming).'}</p>`);
    const rowsL = L.rows.filter((r) => r.mult >= 1.2);
    const t = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
    el.innerHTML = `<div class="kpis">${tile('Nifty', L.spot ? f1(L.spot, 2) : '—', `low ${f1(L.spotLow, 2)} · high ${f1(L.spotHigh, 2)} since tracking`)}${tile('Tracking since', t(L.firstAt), dayLabel(L.day))}${tile('Up ≥ 50 %', L.rows.filter((r) => r.mult >= 1.5).length, 'contracts now')}${tile('Doubled+', L.rows.filter((r) => r.mult >= 2).length, `${L.rows.filter((r) => r.mult >= 3).length} tripled`)}${tile('Updated', t(L.at), L.marketOpen ? 'market open' : 'market closed')}</div>
      <div class="tbl-wrap sr-tbl-wrap"><table class="grid-tbl sr-tbl"><thead><tr><th class="l">Contract</th><th>Stage</th><th>LTP</th><th>Low (at)</th><th>Rise</th><th>Day vs prev close</th><th>Volume pace</th><th>OI since low</th><th>OI today</th><th>Nifty since low</th><th>IV</th><th>History: 2× → 3×</th></tr></thead><tbody>
      ${
        rowsL.length
          ? rowsL
              .map((r) => {
                const o = oddsFor(r);
                return `<tr><td class="l">${r.strike} <span class="sr-type ${r.type}">${r.type}</span> <span class="muted small">${dayLabel(r.expiry)}</span></td><td>${r.stage ? `<span class="sr-stage ${r.stage}">${r.stage}</span>` : ''}</td><td>${rs(r.ltp)}</td><td>${rs(r.low)} <span class="muted small">${t(r.lowAt)}</span></td><td><span class="sr-mult ${multCls(r.mult)}">×${f1(r.mult, 2)}</span></td><td>${sgn(r.dayChg, 0)}</td><td>${r.volPace == null ? '—' : '×' + f1(r.volPace, 1)}</td><td class="${r.oiSinceLow < -3 ? 'pos' : ''}">${sgn(r.oiSinceLow, 1)}</td><td>${sgn(r.oiDay, 1)}</td><td class="${cls(r.niftySinceLow)}">${sgn(r.niftySinceLow, 2)}</td><td>${r.iv == null ? '—' : f1(r.iv, 1)}</td><td>${o ? `${f1(o.p, 0)} % <span class="muted small">of ${o.n}</span>` : '<span class="muted">—</span>'}</td></tr>`;
              })
              .join('')
          : '<tr><td colspan="12" class="muted l">Nothing up 20 % or more from its low yet.</td></tr>'
      }</tbody></table></div>
      <h3 style="margin-top:10px">Stage changes today <span class="muted small">${L.alerts.length}</span></h3>
      ${
        L.alerts.length
          ? `<div class="tbl-wrap sr-tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Time</th><th class="l">Contract</th><th>Stage</th><th>LTP</th><th>Low</th><th>Rise</th><th>Volume pace</th><th>OI since low</th><th>Nifty since low</th></tr></thead><tbody>${L.alerts
              .map(
                (a) =>
                  `<tr><th class="l">${t(a.t)}</th><td class="l">${a.strike} <span class="sr-type ${a.type}">${a.type}</span> <span class="muted small">${dayLabel(a.expiry)}</span></td><td><span class="sr-stage ${a.stage}">${a.stage}</span></td><td>${rs(a.ltp)}</td><td>${rs(a.low)}</td><td>×${f1(a.mult, 2)}</td><td>${a.volPace == null ? '—' : '×' + f1(a.volPace, 1)}</td><td>${sgn(a.oiSinceLow, 1)}</td><td>${sgn(a.niftySinceLow, 2)}</td></tr>`,
              )
              .join('')}</tbody></table></div>`
          : '<p class="muted small">None yet.</p>'
      }`;
  }

  // ---------- How to use it ----------
  function renderUse() {
    const R = rows || [];
    const big = R.filter((r) => r.span === 'intraday' && r.mult >= 3 && r.trough >= minPrice());
    const dbl = R.filter((r) => r.span === 'intraday' && r.mult >= 2 && r.trough >= minPrice() && r.dte <= 1);
    const p3 = dbl.length ? (dbl.filter((r) => r.mult >= 3).length / dbl.length) * 100 : null;
    const exp = big.length ? (big.filter((r) => r.dte <= 1).length / big.length) * 100 : null;
    const mvd = median(big.filter((r) => r.dte === 0 && r.otmPct > 0.25 && r.otmPct <= 0.75).map((r) => r.niftyMove));
    const s = meta.backtest?.summary;
    const g = meta.grid;
    const bothG = g ? g.rows.filter((r) => r.summary.h1?.net > 0 && r.summary.h2?.net > 0).length : null;
    $('srBody').innerHTML = `<div class="panel sr-sec sr-guide"><h3>What the history says</h3><ul>
      <li><b>200 %+ jumps are common, not rare.</b> ${big.length ? `${big.length.toLocaleString('en-IN')} intraday ones (low ≥ ₹${minPrice()}) in the cached history, on ${new Set(big.map((r) => r.day)).size} sessions.` : 'Scan the history to count them.'} ${exp != null ? `${f1(exp, 0)} % happen within a day of expiry` : ''} — options that are cheap because they are out of the money with hours left.</li>
      <li><b>The Nifty move does nearly all the work.</b> Most surges are delta and gamma: ${mvd != null ? `on expiry day an option 0.25–0.75 % out of the money tripled on a median Nifty move of ${f1(mvd, 2)} % in its favour` : 'a modest Nifty move multiplies a cheap near-expiry option'}. IV expansion is the main driver mostly a week or more from expiry, around news. See <i>What causes them</i> and <i>Price vs. Nifty move</i>.</li>
      <li><b>The "massive orders" are the move, not its cause.</b> Volume runs many times its usual pace during a surge and open interest often falls (short covering: writers buying back) — but they mostly arrive with the price, not well before it. ${R.some((r) => r.volLead != null) ? 'The lead time is measured on <i>What causes them</i>.' : 'Fetch volume &amp; OI to measure the lead.'}</li>
      <li><b>Spotting it early is not enough to profit.</b> ${p3 != null ? `Of intraday doublings within a day of expiry (low ≥ ₹${minPrice()}), ${f1(p3, 0)} % went on to 3×; the rest gave the gain back.` : ''} ${s ? `The default backtest (buy at 2× the low, target 3×, stop 25 %) made <b class="${cls(s.net)}">${inrS(s.net)}</b> over ${s.trades} trades after costs.` : ''} ${g ? `${bothG} of ${g.rows.length} grid variants made money in both halves of the period.` : ''} Buying cheap options before a surge (the lottery rows) lost the most.</li>
    </ul></div>
    <div class="panel sr-sec sr-guide"><h3>How you can use it</h3><ol>
      <li><b>As a risk map for option selling.</b> The real use: know where these surges hit. A short option within a day of expiry and under 1 % out of the money can triple on an ordinary Nifty day. Keep short strikes outside that band, or always hedge them (defined risk: spreads, not naked), and put the whole-strategy stop where a 3× of the short leg would land.</li>
      <li><b>As a hedge you buy cheaply.</b> Surges are skewed to the downside move (puts) — the backtest's put side did better than its call side. A small long put a little out of the money on expiry / the day before protects a short-premium book and can pay several times over on a fall; budget it as insurance, not as a trade expected to make money.</li>
      <li><b>Watch the radar, act only with a plan.</b> The live radar shows which contracts are climbing, with volume pace, OI and the Nifty move. If you trade the momentum, decide the exit before you enter (target near 3× the low, a stop, out by 15:20), keep size small (premium you can lose in full), and record it. The backtest settings here let you test your own rule first.</li>
      <li><b>Check the news calendar.</b> RBI policy, the Budget, election results, global shocks: on those days IV and the surge count jump. Add the dates you care about to bt-data/surge-calendar.json and rescan.</li>
      <li><b>Don't chase the table of past winners.</b> The peak is only known afterwards. Any rule picked because it looked best on this history will look better than it is; trust only what holds in both halves and on fresh days (the radar's log lets you check that going forward).</li>
    </ol>
    <p class="muted small">This is research on past prices, not investment advice. Nothing on this screen places orders.</p></div>`;
  }

  // ---------- wiring ----------
  async function init() {
    if (!started) {
      started = true;
      render();
      await loadAll();
    }
    render();
  }
  $('srTabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t || t === tab) return;
    tab = t;
    store.set('sr-tab', tab);
    listLimit = 300;
    render();
  });
  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'surge') init();
    else stopLive();
  });
  if (window.app?.state.view === 'surge') init();
})();
