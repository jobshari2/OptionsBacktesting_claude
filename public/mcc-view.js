// Trading Ideas › Covered call › Modified covered call (left menu of the Covered call screen): NIFTYBEES worth one
// lot plus a monthly call ratio spread and a 2-3-1 put butterfly, with rolls of the sold strikes (bt/mcc.js,
// mccpaper.js). Tabs: Strategy & rules, Backtest (with and without adjustments, and the study of when to adjust),
// Paper trade. Paper only: nothing here sends orders.
(() => {
  const { $, esc, inr, inrS, kinr, pct, cls, dayLabel } = BT;
  const TABS = [
    ['rules', 'Strategy & rules'],
    ['bt', 'Backtest'],
    ['paper', 'Paper trade'],
  ];
  const KIND = {
    entry: 'Entry',
    rollPut: 'Puts up',
    rollCall: 'Calls down',
    upRoll: 'Calls up',
    buyBack: 'Buy back',
    upHedge: 'Hedge call',
    expiry: 'Expiry',
    skip: 'Not done',
    budget: 'NIFTYBEES',
  };
  const ROLE = { ceL: 'Buy call', ceS: 'Sell call', peL: 'Buy put', peS: 'Sell put', peW: 'Buy put (wing)', ceH: 'Buy call (hedge)' };
  // study rows the rules text quotes
  const REC = { base: 'none', user: 'move2', all: 'all15' };
  let meta = null;
  let params = null;
  let tab = BT.store.get('mcc-tab', 'rules');
  let idea = BT.store.get('cc-idea', 'cc');
  let saved = { backtest: null, study: null }; // as shown: raw rescaled to the NIFTYBEES budget (rebudgetAll)
  let raw = { backtest: null, study: null }; // as the server ran them
  let started = false;
  let job = null;
  let paper = null;
  let pollT = null;
  let openMonth = null;
  let viewing = null; // a study rule opened on the Backtest tab: { id, label, B, raw } (its full backtest, not saved)
  let lastDone = ''; // what the last backtest / study run finished, shown under the run buttons

  const num0 = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const legLine = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`;

  // ---------- NIFTYBEES budget (every tab) ----------
  // params.budget: ₹ of NIFTYBEES bought at each entry (0 = 65 × lots × Nifty's worth, one lot). The options are not
  // affected: only the ETF's quantity and P&L (bt/mcc.js etfQty).
  const unitsFor = (p, S) => Math.round((p.budget > 0 ? p.budget : p.lotSize * p.lots * S) / (S / 100)); // NIFTYBEES = Nifty ÷ 100
  const sizeLabel = (p) => (p?.budget > 0 ? `NIFTYBEES budget ${inr(p.budget)}` : 'NIFTYBEES of one lot (65 × Nifty)');
  // "5 L", "5,00,000", "₹1.5 cr" → ₹; empty → 0 (one lot's worth); NaN when it is not an amount.
  function parseBudget(raw) {
    const t = String(raw ?? '')
      .toLowerCase()
      .replace(/[₹,\s]/g, '');
    if (!t) return 0;
    const m = t.match(/^(\d*\.?\d+)(l|lakh|lakhs|lac|cr|crore|k)?$/);
    if (!m) return NaN;
    return Math.round(Number(m[1]) * ({ l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, cr: 1e7, crore: 1e7, k: 1e3 }[m[2]] || 1));
  }
  // The Budget row: value (₹, 0 = one lot's worth), S = the Nifty its note counts units at, note = what it does on this tab.
  function budgetRow(value, S, note = '') {
    const lot = params.lotSize;
    const one = lot * params.lots * S;
    const units = unitsFor({ ...params, budget: value }, S);
    return `<div class="set-row mcc-budget" title="₹ of NIFTYBEES bought at each entry, instead of one lot's worth (${lot} × Nifty). Only the NIFTYBEES quantity and its P&amp;L change: the options stay at their lots. Accepts 1560000, 15,60,000 or 15.6 L."><b>NIFTYBEES budget</b><span class="lbl">₹</span><input class="txt num" id="mccBudget" value="${value > 0 ? value : ''}" placeholder="${Math.round(one)}" style="width:100px">
      <span class="muted small" id="mccBudgetNote">${value > 0 ? `= ${num0(units)} units at Nifty ${num0(S)} (₹${(S / 100).toFixed(2)} each), ${(value / one).toFixed(2)} × one lot's worth (${inr(Math.round(one))}).` : `Empty: one lot's worth, ${lot} × Nifty = ${inr(Math.round(one))} (${num0(units)} units) at Nifty ${num0(S)}.`} The options are not changed. ${note}</span></div>`;
  }
  // One budget for every tab: saved results are shown for it too.
  function useBudget(v) {
    params.budget = v;
    BT.store.set('mcc-params', params);
    rebudgetAll();
  }

  // ---------- saved results at the budget ----------
  // A result is run with some NIFTYBEES budget. The options do not depend on it and the NIFTYBEES P&L, charges
  // included, is in proportion to the units held, so the result for another budget is the same months with the ETF
  // figures scaled: the held ETF by what the first entry buys, the rebought one by what each month's entry buys.
  // Exact up to the rounding of units. Its params then carry the budget, so "Use these settings" / a re-run keep it.
  const worth = (p, budget, S0) => (budget > 0 ? budget : S0 > 0 ? p.lotSize * p.lots * S0 : null); // ₹ of NIFTYBEES bought at an entry
  function rebudget(r, budget, spotOf) {
    const p = r.params;
    const from = p.budget || 0;
    if (from === (budget || 0)) return r;
    const ok = r.months.filter((m) => m.ok);
    const S1 = spotOf(ok[0]);
    const kOnce = worth(p, budget, S1) / worth(p, from, S1) || 1;
    const months = r.months.map((m) => {
      if (!m.ok) return m;
      const S0 = spotOf(m);
      const kMon = worth(p, budget, S0) / worth(p, from, S0) || kOnce; // a month without its Nifty (old study): as held
      const etfOnce = Math.round((m.etfOnce ?? m.withOnce - m.opt) * kOnce);
      const etfMonthly = Math.round((m.etfMonthly ?? m.withMonthly - m.opt) * kMon);
      const out = { ...m, etfOnce, etfMonthly, withOnce: m.opt + etfOnce, withMonthly: m.opt + etfMonthly };
      if (m.etf) out.etf = { ...m.etf, qtyOnce: Math.round(m.etf.qtyOnce * kOnce), qtyMonthly: Math.round(m.etf.qtyMonthly * kMon) };
      return out;
    });
    const q = { ...p, budget: budget || 0 };
    return { ...r, params: q, months, summary: summarizeAt(months, r.summary, budget > 0 ? budget : worth(p, 0, S1)) };
  }
  // bt/mcc.js summarize on rescaled months (skipped months, rolls and costs as they were).
  function summarizeAt(months, old, invested) {
    const ok = months.filter((m) => m.ok);
    const stat = (key) => {
      let eq = 0;
      let peak = 0;
      let dd = 0;
      for (const m of ok) {
        eq += m[key];
        peak = Math.max(peak, eq);
        dd = Math.min(dd, eq - peak);
      }
      const vals = ok.map((m) => m[key]);
      const years = ok.length / 12;
      return {
        total: Math.round(eq),
        avg: ok.length ? Math.round(eq / ok.length) : 0,
        win: vals.filter((v) => v > 0).length,
        worst: vals.length ? Math.min(...vals) : 0,
        best: vals.length ? Math.max(...vals) : 0,
        maxDD: Math.round(dd),
        annPct: invested && years ? (eq / invested / years) * 100 : 0,
      };
    };
    const bucket = (f) => {
      const ms = ok.filter(f);
      const sum = (k) => ms.reduce((n, m) => n + (m[k] || 0), 0);
      return { n: ms.length, opt: sum('opt'), call: sum('callPnl'), put: sum('putPnl'), withOnce: sum('withOnce'), withMonthly: sum('withMonthly'), hold: sum('etfOnce') };
    };
    return {
      ...old,
      invested: Math.round(invested || 0),
      opt: stat('opt'),
      call: stat('callPnl'),
      put: stat('putPnl'),
      withOnce: stat('withOnce'),
      withMonthly: stat('withMonthly'),
      hold: stat('etfOnce'),
      byMove: { up: bucket((m) => m.move > 2), flat: bucket((m) => Math.abs(m.move) <= 2), down: bucket((m) => m.move < -2) },
    };
  }
  // Nifty at each month's entry: the month's own, else the saved backtest's for that expiry (studies before it was kept).
  function spotFinder() {
    const bt = new Map((raw.backtest?.withAdj?.months || []).map((m) => [m.expiry, m.spot0]));
    return (m) => m?.spot0 ?? bt.get(m?.expiry) ?? null;
  }
  function rebudgetAll() {
    const b = params.budget || 0;
    const at = spotFinder();
    const B = (x) => x && { ...x, withAdj: rebudget(x.withAdj, b, at), without: rebudget(x.without, b, at) };
    saved = { backtest: B(raw.backtest), study: raw.study && { ...raw.study, rows: raw.study.rows.map((r) => rebudget(r, b, at)) } };
    if (viewing) viewing.B = B(viewing.raw);
  }
  function bindBudget(onSet) {
    const el = $('mccBudget');
    if (!el) return;
    el.onchange = () => {
      const v = parseBudget(el.value);
      if (!(v >= 0)) {
        $('mccBudgetNote').innerHTML = '<span class="neg">Type a ₹ amount, e.g. 1560000 or 15.6 L (empty = one lot\'s worth).</span>';
        return;
      }
      onSet(v);
    };
  }
  // Table rows of legs under their structure: the call ratio spread, then the put butterfly. row(leg) → <tr>…;
  // total(legs) → the group's subtotal cell (or '' for none); n = column count.
  const GROUP_NAME = { CE: 'Call ratio spread', PE: 'Put 2-3-1 butterfly' };
  const groupedRows = (legs, row, n, total) =>
    ['CE', 'PE']
      .map((t) => {
        const g = legs.filter((l) => l.type === t);
        if (!g.length) return '';
        const sub = total ? total(g) : '';
        return `<tr class="mcc-grp"><td class="l" colspan="${sub ? n - 1 : n}">${GROUP_NAME[t]}</td>${sub}</tr>${g.map(row).join('')}`;
      })
      .join('');
  const monthName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  // ---------- the left menu: Covered call | Modified covered call ----------
  function applyIdea() {
    const menu = $('ccMenu');
    if (!menu) return;
    if (!menu.querySelector('[data-idea="mcc"]')) return; // cc-view.js has not drawn the menu yet
    menu.querySelectorAll('[data-idea]').forEach((b) => b.classList.toggle('on', b.dataset.idea === idea));
    document.querySelector('#cc > .bt-main:not(#mccMain)')?.classList.toggle('hidden', idea === 'mcc');
    $('mccMain').classList.toggle('hidden', idea !== 'mcc');
    if (idea === 'mcc') init();
    poll();
  }
  $('ccMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-idea]');
    if (!b || b.dataset.idea === idea) return;
    idea = b.dataset.idea;
    BT.store.set('cc-idea', idea);
    applyIdea();
  });

  async function init() {
    if (started) return;
    started = true;
    try {
      meta = await BT.api('/api/mcc/meta');
    } catch (e) {
      $('mccBody').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      started = false;
      return;
    }
    const stored = BT.store.get('mcc-params', {});
    params = { ...deep(meta.defaults), ...stored };
    for (const k of ['ce', 'pe', 'adj', 'up', 'costs', 'target']) params[k] = { ...meta.defaults[k], ...(stored[k] || {}) };
    params.lotSize = meta.lot;
    const [b, s] = await Promise.all([BT.api('/api/mcc/backtest').catch(() => ({})), BT.api('/api/mcc/study').catch(() => ({}))]);
    raw = { backtest: b.saved || null, study: s.saved || null };
    rebudgetAll();
    render();
  }

  function render() {
    $('mccTabs').innerHTML = TABS.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('');
    if (tab === 'rules') renderRules();
    else if (tab === 'bt') renderBacktest();
    else renderPaper();
    poll();
  }
  // A click on a study rule (Backtest or Strategy & rules tab) opens its full backtest; a click on an adjustment
  // opens its month.
  $('mccBody').addEventListener('click', (e) => {
    const rule = e.target.closest('tr[data-rule]')?.dataset.rule;
    if (rule) return openRule(rule);
    const m = e.target.closest('tr[data-adj-m]')?.dataset.adjM;
    if (m) {
      openMonth = m;
      renderResults();
      document.querySelector(`#mccRes tr[data-m="${m}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
  async function openRule(id) {
    const row = saved.study?.rows?.find((r) => r.id === id);
    if (!row || job) return;
    if (tab !== 'bt') {
      tab = 'bt';
      BT.store.set('mcc-tab', tab);
      render();
    }
    const ok = row.months.filter((m) => m.ok);
    const range = { from: ok[0]?.expiry, to: ok[ok.length - 1]?.expiry };
    lastDone = '';
    try {
      job = { kind: 'run', progress: null };
      showProgress({ phase: 'Opening ' + row.label, done: 0, total: 0 });
      const r = await BT.api('/api/mcc/run', { params: row.params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(300);
        const j = await BT.api('/api/mcc/job?id=' + job.id);
        showProgress(j.progress);
        if (j.status === 'done') {
          viewing = { id, label: row.label, raw: j.result };
          rebudgetAll();
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
    } catch (err) {
      job = null;
      showProgress(null);
      if ($('mccRes')) $('mccRes').innerHTML = `<div class="panel empty err">Could not open the rule: ${esc(err.message)}</div>`;
      return;
    }
    job = null;
    openMonth = null;
    if (tab === 'bt') {
      renderBacktest();
      $('mccRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  $('mccTabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t || t === tab) return;
    tab = t;
    BT.store.set('mcc-tab', tab);
    render();
  });

  // ---------- payoff ----------
  // legs: [{ side, type, strike, lots, entry }]; etf: { qty, b0, s0 } (b0 = ₹ per unit when Nifty was s0; the ETF moves
  // with Nifty, ₹1 per 100 pts in the model) or null.
  const optAt = (legs, x, lot) => legs.reduce((s, l) => s + l.side * (Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x) - l.entry) * l.lots * lot, 0);
  function payoffChart(canvas, legs, lot, spot, etf, extraNote) {
    // opens on ±10 %; the curve goes to ±30 % to zoom out (bt-common.js payZoom)
    const home = [Math.floor((spot * 0.9) / 50) * 50, Math.ceil((spot * 1.1) / 50) * 50];
    const lo = Math.floor((spot * 0.7) / 50) * 50;
    const hi = Math.ceil((spot * 1.3) / 50) * 50;
    const xs = [];
    for (let x = lo; x <= hi; x += 25) xs.push(x);
    const opt = xs.map((x) => ({ x, y: Math.round(optAt(legs, x, lot)) }));
    const sets = [{ label: 'Options only', data: opt, borderColor: '#b392f0', borderWidth: 2, pointRadius: 0 }];
    // the call ratio spread and the put butterfly apart
    for (const [t, label, color] of [
      ['CE', 'Call ratio spread', '#d6af4c'],
      ['PE', 'Put 2-3-1 butterfly', '#3fb68b'],
    ])
      if (legs.some((l) => l.type === t))
        sets.push({
          label,
          data: xs.map((x) => ({
            x,
            y: Math.round(
              optAt(
                legs.filter((l) => l.type === t),
                x,
                lot,
              ),
            ),
          })),
          borderColor: color,
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 0,
        });
    if (etf)
      sets.push({
        label: 'With NIFTYBEES',
        data: xs.map((x, i) => ({ x, y: Math.round(opt[i].y + etf.qty * etf.b0 * (x / etf.s0 - 1) + (etf.adj || 0)) })),
        borderColor: '#58a6ff',
        borderWidth: 2,
        pointRadius: 0,
      });
    const yAll = sets.flatMap((s) => s.data.map((p) => p.y));
    const [y0, y1] = [Math.min(...yAll), Math.max(...yAll)];
    sets.push({
      label: `Nifty ${num0(spot)}`,
      data: [
        { x: spot, y: y0 - (y1 - y0) }, // past the y axis however it is zoomed (the line is clipped there)
        { x: spot, y: y1 + (y1 - y0) },
      ],
      borderColor: '#9aa5b1',
      borderDash: [4, 4],
      borderWidth: 1,
      pointRadius: 0,
      pz_skip: true,
    });
    BT.chart(canvas, {
      type: 'line',
      data: { datasets: sets },
      options: {
        parsing: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: home[0], max: home[1], title: { display: true, text: 'Nifty at expiry' + (extraNote ? ' · ' + extraNote : '') } },
          y: { ticks: { callback: (v) => kinr(v) } },
        },
        plugins: {
          payZoom: { on: true, home },
          tooltip: {
            filter: (i) => !i.dataset.pz_skip,
            callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}`, title: (c) => 'Nifty ' + num0(c[0].parsed.x) },
          },
        },
      },
    });
  }

  // ---------- Strategy & rules ----------
  // The two option structures, kept apart everywhere: the call ratio spread (CE legs) and the put 2-3-1 butterfly (PE legs).
  const STRUCT = [
    ['CE', 'Call ratio spread', '#d6af4c'],
    ['PE', 'Put 2-3-1 butterfly', '#3fb68b'],
  ];
  const of = (legs, t) => legs.filter((l) => l.type === t);
  const exDefaults = () => ({ spot: 24000, iv: 13, days: 28, units: unitsFor(params, 24000), legs: null });
  // The example month's legs: the ones typed in (Payoff diagram of the month), else Black-Scholes prices at IV / days.
  function bsLegs(S, iv, days) {
    const A = Math.round(S / 50) * 50;
    const p = params;
    const ceL = A + p.ce.buyOff;
    const ceS = ceL + p.ce.sellGap;
    const peL = A - p.pe.buyOff;
    const peS = peL - p.pe.sellGap;
    const peW = peS - p.pe.wingGap;
    const pr = (K, call) => Math.round(Math.max(0.05, BT.bs(S, K, days / 365, iv / 100, call)) * 10) / 10;
    return [
      { role: 'ceL', side: 1, type: 'CE', strike: ceL, lots: p.ce.buy * p.lots },
      { role: 'ceS', side: -1, type: 'CE', strike: ceS, lots: p.ce.sell * p.lots },
      { role: 'peL', side: 1, type: 'PE', strike: peL, lots: p.pe.buy * p.lots },
      { role: 'peS', side: -1, type: 'PE', strike: peS, lots: p.pe.sell * p.lots },
      { role: 'peW', side: 1, type: 'PE', strike: peW, lots: p.pe.wing * p.lots },
    ].map((l) => ({ ...l, entry: pr(l.strike, l.type === 'CE') }));
  }
  function exState() {
    const ex = { ...exDefaults(), ...BT.store.get('mcc-ex', {}) };
    if (!ex.legs?.length) ex.legs = bsLegs(ex.spot, ex.iv, ex.days);
    return ex;
  }
  const studyRow = (id) => saved.study?.rows?.find((r) => r.id === id) || null;

  // A position to move Nifty under: { label, spot, legs, units, b0 }.
  function animSources() {
    const ex = exState();
    const out = [{ id: 'ex', label: 'Example month', spot: ex.spot, legs: ex.legs, units: ex.units, b0: ex.spot / 100 }];
    const c = paper?.paper?.cycle;
    if (c?.legs?.length)
      out.push({
        id: 'paper',
        label: 'Your paper month',
        spot: c.spot0,
        legs: c.legs,
        units: paper.paper.etfOnce?.qty || ex.units,
        b0: c.etf?.b0 || c.spot0 / 100,
      });
    const m = saved.backtest?.withAdj?.months?.filter((x) => x.ok).slice(-1)[0];
    if (m)
      out.push({
        id: 'bt',
        label: `Backtest: ${monthName(m.expiry)} as entered`,
        spot: m.spot0,
        legs: m.entry.legs,
        units: m.etf?.qtyOnce || ex.units,
        b0: m.etf?.bees0 || m.spot0 / 100,
      });
    return out;
  }
  // P&L of each part at expiry with Nifty at x.
  function parts(src, x) {
    const lot = params.lotSize;
    const etf = src.units * src.b0 * (x / src.spot - 1);
    const call = optAt(of(src.legs, 'CE'), x, lot);
    const put = optAt(of(src.legs, 'PE'), x, lot);
    return { etf, call, put, opt: call + put, total: etf + call + put };
  }
  function zoneText(src, x) {
    const k = (role) => src.legs.find((l) => l.role === role)?.strike;
    const [ceL, ceS, peL, peS, peW] = ['ceL', 'ceS', 'peL', 'peS', 'peW'].map(k);
    const v = parts(src, x);
    const f = (n) => `<b class="${cls(n)}">${inrS(n)}</b>`;
    if (peW && x <= peW)
      return `Under the butterfly's far wing (${peW}): the butterfly keeps a fixed ${f(v.put)}, the call ratio has lost its premium (${f(v.call)}). NIFTYBEES (${f(v.etf)}) has no more protection below here.`;
    if (peS && x <= peS)
      return `Between the wing (${peW}) and the sold puts (${peS}): the butterfly is near its best (${f(v.put)}), cushioning NIFTYBEES (${f(v.etf)}).`;
    if (peL && x < peL) return `Between the sold puts (${peS}) and the bought puts (${peL}): the butterfly gains as Nifty falls toward ${peS} (${f(v.put)}).`;
    if (ceL && x <= ceL)
      return `Between the bought put (${peL}) and the bought call (${ceL}): neither structure is in the money at expiry — the call ratio keeps its net premium (${f(v.call)}), the butterfly loses its cost (${f(v.put)}); NIFTYBEES (${f(v.etf)}) carries the month.`;
    if (ceS && x <= ceS)
      return `Between the call strikes (${ceL} – ${ceS}): the call ratio gains (${f(v.call)}), best exactly at the sold ${ceS}. NIFTYBEES ${f(v.etf)}.`;
    return `Above the sold calls (${ceS}): the extra sold call loses what NIFTYBEES gains, so the total stays at ${f(v.total)}. The call ratio alone is ${v.call < 0 ? 'now losing' : 'giving back its gain'} (${f(v.call)}) while NIFTYBEES makes ${f(v.etf)}.`;
  }

  function renderRules() {
    const lot = params.lotSize;
    const ex = exState();
    const S = ex.spot;
    const st = saved.study;
    const r0 = studyRow(REC.base);
    const rU = studyRow(REC.user);
    const rA = saved.study ? [...saved.study.rows].sort((x, y) => y.summary.opt.total - x.summary.opt.total)[0] : null; // the study's best
    const d = (r, k = 'opt') => (r ? r.summary[k].total : null);
    const diff = (r) => (r && r0 ? inrS(d(r) - d(r0)) : '—');
    const mm = BT.store.get('mcc-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
    const budget = params.budget > 0;
    $('mccBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Modified covered call</h3>
        ${budgetRow(params.budget, S, 'Used across this tab, the Backtest and its study (shown for it without re-running) and the paper trade.')}
        <p>Hold NIFTYBEES worth ${budget ? `your budget, ${inr(params.budget)} (one lot of Nifty, 65 × Nifty, is about ₹${((S * lot) / 1e5).toFixed(1)} L at Nifty ${num0(S)}; the options below stay at that one lot)` : `one lot of Nifty (65 × Nifty, about ₹${((S * lot) / 1e5).toFixed(1)} L at Nifty ${num0(S)})`}. Each <b>monthly</b> series, on its first trading day, open two option structures and hold them to the monthly expiry:</p>
        <ul>
          <li><b>Call ratio spread</b>: buy 1 lot CE 100 pts over ATM, sell 2 lots 100 pts above that. It earns when Nifty drifts up to the sold strike; the second sold call is covered by the ETF.</li>
          <li><b>Put 2-3-1 butterfly</b>: buy 2 lots PE 100 pts under ATM, sell 3 lots 200 pts under the bought strike, buy 1 lot 100 pts under the sold strike. It earns when Nifty falls, best at the sold strike; with 3 bought against 3 sold its loss is capped.</li>
        </ul>
        ${studyRow('none') ? `<p>Over the backtest (no adjustments) the <b>call ratio spread</b> made ${inrS(studyRow('none').summary.call.total)} and the <b>put butterfly</b> ${inrS(studyRow('none').summary.put.total)}: the ratio is the income, the butterfly is the cushion (${inrS(studyRow('none').summary.byMove.down.put)} in the months Nifty fell more than 2 %, ${inrS(studyRow('none').summary.byMove.flat.put + studyRow('none').summary.byMove.up.put)} in the others).</p>` : ''}
        <p class="muted small">NIFTYBEES is modelled at ₹1 per 100 Nifty points (price = Nifty ÷ 100), as you asked. So ${num0(ex.units)} units move ₹${num0(ex.units / 100)} per Nifty point${ex.units === lot * params.lots * 100 ? ', exactly like one lot of Nifty' : ` (one lot of Nifty: ₹${num0(lot * params.lots)})`}. The real ETF trades at about Nifty ÷ 89 and moves about ₹1.12 per 100 points, so ₹ for ₹ it comes to the same. The Backtest tab can use its recorded prices instead.</p>
      </div>

      <div class="panel cc-doc">
        <h3>What happens when Nifty moves</h3>
        <h4>One expiry: Nifty from −25 % to +25 %</h4>
        <p class="muted small">Press ▶ Play (or drag the slider, or the ▲ / ▼ buttons) to move Nifty up and down: the P&L at expiry of NIFTYBEES, the call ratio spread and the put butterfly, the options together and the total with NIFTYBEES.</p>
        <div class="set-row mcc-anim-ctl">
          <span class="seg sm" id="mccAnSrc"></span>
          <button class="btn-sm ghost" id="mccAnPlay">▶ Play</button>
          ${[-20, -10]
            .map((x) => `<button class="btn-sm ghost" data-mv="${x}">▼ ${-x} %</button>`)
            .join(
              '',
            )}<button class="btn-sm ghost" data-mv="0">Back to entry</button>${[10, 20].map((x) => `<button class="btn-sm ghost" data-mv="${x}">▲ ${x} %</button>`).join('')}
          <span class="lbl">Nifty move</span><input type="range" id="mccAnRange" min="-25" max="25" step="0.5" value="0" style="width:200px">
          <b id="mccAnLbl"></b>
        </div>
        <div class="muted small" id="mccAnPos"></div>
        <div class="cc-ex-grid" style="margin-top:8px">
          <div><div class="mcc-bars" id="mccAnBars"></div><p class="small" id="mccAnZone" style="margin-top:8px"></p></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="mccAnPay"></canvas></div></div>
        </div>

        <h4 style="margin-top:14px">Month by month: the strategy entered again every month</h4>
        <div class="set-row">
          <span class="seg sm" id="mccMmMode"><button data-m="model" class="${mm.mode === 'model' ? 'on' : ''}">Model path</button><button data-m="real" class="${mm.mode === 'real' ? 'on' : ''}">Real months (backtest)</button></span>
          <span class="mcc-mm-model${mm.mode === 'model' ? '' : ' hidden'}">
            <span class="lbl">Nifty over the period</span><input class="txt num" id="mccMmPct" value="${mm.pct}" style="width:50px"><span class="lbl">% over</span>
            <select id="mccMmN">${[3, 6, 12, 24].map((n) => `<option value="${n}"${n === mm.months ? ' selected' : ''}>${n} months</option>`).join('')}</select>
            <span class="lbl">IV %</span><input class="txt num" id="mccMmIv" value="${mm.iv}" style="width:45px">
            <label class="lbl"><input type="checkbox" id="mccMmSw"${mm.swings ? ' checked' : ''}> weekly swings</label>
          </span>
          <button class="btn-sm ghost" id="mccMmPlay">▶ Play the months</button>
          <span class="lbl">Month</span><input type="range" id="mccMmIdx" min="0" max="0" value="0" style="width:180px">
        </div>
        <p class="muted small" id="mccMmNote"></p>
        <div class="cc-ex-grid">
          <div><div class="mcc-bars" id="mccMmBars"></div><div class="small" id="mccMmText" style="margin-top:8px"></div></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="mccMmChart"></canvas></div></div>
        </div>
      </div>

      <div class="panel cc-doc">
        <h3>When Nifty rises: what you can do</h3>
        ${risesHtml()}
      </div>

      <div class="panel cc-doc cc-ex">
        <h3>Payoff diagram of the month (example, at the monthly expiry)</h3>
        <div class="set-row">
          <span class="lbl">Nifty at entry</span><input class="txt num" data-ex="spot" value="${ex.spot}">
          <span class="lbl">Lot</span><input class="txt num" value="${lot}" disabled style="width:45px">
          <span class="lbl">NIFTYBEES ₹</span><input class="txt num" value="${(ex.spot / 100).toFixed(2)}" disabled style="width:70px">
          <span class="lbl">NIFTYBEES qty</span><input class="txt num" data-ex="units" value="${ex.units}">
          <span class="lbl">price the legs at IV %</span><input class="txt num" data-ex="iv" value="${ex.iv}" style="width:45px">
          <span class="lbl">days to expiry</span><input class="txt num" data-ex="days" value="${ex.days}" style="width:45px">
          <button class="btn-sm ghost" id="mccExBs">Price from Black-Scholes</button>
        </div>
        <div class="mcc-ex-legs" id="mccExLegs"></div>
        <div class="cc-pay" style="margin-top:8px"><div class="cc-pay-chart"><canvas id="mccExPay"></canvas></div></div>
        <div class="tbl-wrap" id="mccExTbl"></div>
        <p class="muted small">NIFTYBEES = quantity × its price change (₹1 per 100 Nifty points). Strikes and premiums can be typed in; "Price from Black-Scholes" resets them to the rule's strikes around the entry at that IV. Before costs.</p>
      </div>

      <div class="panel cc-doc">
        <h3>Rules</h3>
        <table class="grid-tbl cc-rules"><tbody>
          <tr><th>Entry</th><td>First trading day of each monthly series (the day after the previous monthly expiry), 09:30. Monthly expiries only.</td></tr>
          <tr><th>Holding</th><td>NIFTYBEES worth ${budget ? `your budget, ${inr(params.budget)}, bought at each entry's price (the options are not changed)` : '65 × Nifty (one lot; set a NIFTYBEES budget at the top for another amount)'}. Tested both ways: <b>bought once and held</b>, and <b>sold at each expiry and rebought</b> at the next series start.</td></tr>
          ${
            params.target?.on
              ? `<tr><th>Ideal trade</th><td>At every new series the strikes and gaps below are not fixed: they are picked on that day's prices so that the flat zone between the put butterfly and the call ratio (all options expiring worthless: the net credit after fills and costs) is <b>${inr(params.target.amount)}</b> within 5 %, the downside never goes under it, and the upside loss starts as far above Nifty as possible. The month's rolls keep the shape picked. The distances below apply when this is switched off (Backtest tab).</td></tr>`
              : ''
          }
          <tr><th>1 · Call ratio spread</th><td>Buy ${params.ce.buy} lot CE at ATM + ${params.ce.buyOff}, sell ${params.ce.sell} lots at ATM + ${params.ce.buyOff + params.ce.sellGap}. Above the sold strike the extra call is covered by the ETF, so the whole position stops gaining there.
            <br><b>Adjustment (market down):</b> close the sold calls and sell calls at a lower strike (200 pts over the new ATM), never under the bought call.</td></tr>
          <tr><th>2 · Put 2-3-1 butterfly</th><td>Buy ${params.pe.buy} lots PE at ATM − ${params.pe.buyOff}, sell ${params.pe.sell} at ATM − ${params.pe.buyOff + params.pe.sellGap}, buy ${params.pe.wing} at ATM − ${params.pe.buyOff + params.pe.sellGap + params.pe.wingGap}. You confirmed the far wing is bought, so the loss is capped.
            <br><b>Adjustment (market up):</b> close the sold puts and sell puts at a higher strike, back at their entry distance from the new ATM (300 pts under it), never above the bought puts.</td></tr>
          <tr><th>Exit</th><td>Held to the monthly expiry, settled at Nifty's close. No stop-loss (your choice): the adjustments are the only risk control.</td></tr>
          <tr><th>When to adjust (suggested)</th><td>${rulesWhen(rU, r0)}</td></tr>
          <tr><th>Best adjustment in the study</th><td>${
            rA
              ? `<b>${esc(rA.label)}</b>: ${inrS(d(rA))} on the options vs ${inrS(d(r0))} with no adjustments (${diff(rA)}), ${rA.summary.adjustments} rolls, but the worst month is ${inr(rA.summary.opt.worst)} vs ${inr(r0.summary.opt.worst)}. ${rA.params.adj.legs === 'all' ? 'It moves the <b>whole</b> butterfly / spread to the new ATM, not just the sold strikes: on the Backtest tab, roll "the whole spread / butterfly"' : 'Set it on the Backtest tab'}${rA.params.adj.trigger === 'decay' ? `, when "sold leg decayed to" ${rA.params.adj.decayPct} %` : `, at a ${rA.params.adj.movePct} % move`}.`
              : 'Run the study on the Backtest tab.'
          }</td></tr>
          <tr><th>Costs</th><td>0.5 % slippage on every option fill, ₹20 per order, STT and exchange charges by date, STT on bought options that expire in the money. ETF: 0.05 % slippage plus stamp duty and fees.</td></tr>
        </tbody></table>
      </div>

      <div class="panel cc-doc">
        <h3>When to adjust: what the backtest says</h3>
        ${st ? studyTable(st, true) : '<p class="muted">The study has not been run yet. Run it on the Backtest tab ("Run adjustment study").</p>'}
        ${st ? `<p class="muted small">Study run ${new Date(st.at).toLocaleString('en-IN')} with ${sizeLabel(st.rows[0]?.params)}, ${r0?.summary.months || 0} monthly series ${r0?.summary.from ? `(${dayLabel(r0.summary.from)} – ${dayLabel(r0.summary.to)})` : ''}. ${skippedText(r0?.summary)} Only ${r0?.summary.byMove.up.n ?? '?'} of the months rose more than 2 %, too few to be sure about up-market rules.</p>` : ''}
      </div>`;
    bindBudget((v) => {
      useBudget(v);
      const ex = exState();
      ex.units = unitsFor(params, ex.spot); // the example's NIFTYBEES follow the budget
      BT.store.set('mcc-ex', ex);
      renderRules();
    });
    bindAnim();
    bindMm();
    bindExample();
  }

  // ----- bars: one row per part, centred on zero, scaled to the largest value the section can show -----
  function bars(el, rows, scale) {
    el.innerHTML = rows
      .map(([label, v, sub, strong]) => {
        const w = scale ? Math.min(50, (Math.abs(v) / scale) * 50) : 0;
        return `<div class="mcc-bar-row${strong ? ' strong' : ''}"><span>${label}</span><span class="mcc-bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></span><b class="${cls(v)}">${inrS(v)}</b>${sub ? `<span class="muted small mcc-bar-sub">${sub}</span>` : ''}</div>`;
      })
      .join('');
  }

  // ----- One expiry -----
  let anim = { src: BT.store.get('mcc-an-src', 'ex'), move: 0, timer: null, chart: null };
  function bindAnim() {
    clearInterval(anim.timer);
    anim.timer = null;
    const srcs = animSources();
    if (!srcs.find((s) => s.id === anim.src)) anim.src = 'ex';
    $('mccAnSrc').innerHTML = srcs.map((s) => `<button data-s="${s.id}" class="${s.id === anim.src ? 'on' : ''}">${esc(s.label)}</button>`).join('');
    $('mccAnSrc').onclick = (e) => {
      const id = e.target.closest('[data-s]')?.dataset.s;
      if (!id) return;
      anim.src = id;
      BT.store.set('mcc-an-src', id);
      bindAnim();
    };
    $('mccAnRange').oninput = (e) => {
      stopAnim();
      anim.move = Number(e.target.value);
      drawAnim(false);
    };
    document.querySelectorAll('[data-mv]').forEach(
      (b) =>
        (b.onclick = () => {
          stopAnim();
          anim.move = Number(b.dataset.mv);
          drawAnim(false);
        }),
    );
    $('mccAnPlay').onclick = () => {
      if (anim.timer) return stopAnim();
      $('mccAnPlay').textContent = '❚❚ Pause';
      let dir = 1;
      anim.timer = setInterval(() => {
        if (!document.body.contains($('mccAnPlay'))) return stopAnim();
        anim.move += dir * 0.5;
        if (anim.move >= 25 || anim.move <= -25) dir = -dir;
        drawAnim(false);
      }, 80);
    };
    drawAnim(true);
  }
  function stopAnim() {
    clearInterval(anim.timer);
    anim.timer = null;
    if ($('mccAnPlay')) $('mccAnPlay').textContent = '▶ Play';
  }
  function drawAnim(full) {
    const src = animSources().find((s) => s.id === anim.src);
    const x = src.spot * (1 + anim.move / 100);
    $('mccAnRange').value = anim.move;
    $('mccAnLbl').textContent = `Nifty ${num0(x)} (${anim.move >= 0 ? '+' : ''}${anim.move.toFixed(1)} %) · NIFTYBEES ₹${((src.b0 * x) / src.spot).toFixed(2)}`;
    const leg = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} @${l.entry.toFixed(1)}`;
    $('mccAnPos').innerHTML =
      `Position: ${esc(src.label)} — Nifty ${num0(src.spot)}, ${num0(src.units)} NIFTYBEES at ₹${src.b0.toFixed(2)} · <b>call ratio</b> ${of(src.legs, 'CE').map(leg).join(', ')} · <b>put butterfly</b> ${of(src.legs, 'PE').map(leg).join(', ')}. Everything at its expiry, before costs.`;
    const v = parts(src, x);
    let scale = 0;
    for (let m = -25; m <= 25; m += 1) {
      const q = parts(src, src.spot * (1 + m / 100));
      scale = Math.max(scale, ...Object.values(q).map(Math.abs));
    }
    bars(
      $('mccAnBars'),
      [
        ['NIFTYBEES', v.etf],
        ['Call ratio spread', v.call],
        ['Put 2-3-1 butterfly', v.put],
        ['Without NIFTYBEES (options)', v.opt, '', true],
        ['With NIFTYBEES (total)', v.total, '', true],
      ],
      scale,
    );
    $('mccAnZone').innerHTML = zoneText(src, x);
    if (full || !anim.chart) {
      // opens on the slider's ±25 %; the curves go to ±40 % to zoom out (bt-common.js payZoom)
      const xs = [];
      for (let m = -40; m <= 40; m += 0.5) xs.push(src.spot * (1 + m / 100));
      const home = [src.spot * 0.75, src.spot * 1.25];
      const line = (label, f, color, extra = {}) => ({
        label,
        data: xs.map((xx) => ({ x: xx, y: Math.round(f(parts(src, xx))) })),
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        ...extra,
      });
      anim.chart = BT.chart($('mccAnPay'), {
        type: 'line',
        data: {
          datasets: [
            line('With NIFTYBEES', (q) => q.total, '#58a6ff'),
            line('Without NIFTYBEES (options)', (q) => q.opt, '#b392f0'),
            line('Call ratio spread', (q) => q.call, '#d6af4c', { borderWidth: 1.5, borderDash: [5, 3] }),
            line('Put 2-3-1 butterfly', (q) => q.put, '#3fb68b', { borderWidth: 1.5, borderDash: [5, 3] }),
            line('NIFTYBEES', (q) => q.etf, '#9aa5b1', { borderWidth: 1, borderDash: [2, 3] }),
            { label: 'Now', type: 'scatter', data: [], pointRadius: 6, backgroundColor: '#58a6ff', borderColor: '#fff', borderWidth: 1.5 },
          ],
        },
        options: {
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: {
            x: { type: 'linear', min: home[0], max: home[1], title: { display: true, text: 'Nifty at expiry' } },
            y: { ticks: { callback: (n) => kinr(n) } },
          },
          plugins: {
            payZoom: { on: true, home },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}`, title: (c) => 'Nifty ' + num0(c[0].parsed.x) } },
          },
        },
      });
    }
    const ds = anim.chart.data.datasets;
    ds[ds.length - 1].data = [
      { x, y: Math.round(v.total) },
      { x, y: Math.round(v.opt) },
    ];
    anim.chart.update('none');
  }

  // ----- Month by month -----
  let mmState = { rows: [], idx: 0, timer: null, seq: 0 };
  function mmOpts() {
    return BT.store.get('mcc-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
  }
  function bindMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    const save = () => {
      const o = {
        ...mmOpts(),
        pct: Number($('mccMmPct').value) || 0,
        months: Number($('mccMmN').value) || 12,
        iv: Number($('mccMmIv').value) || 13,
        swings: $('mccMmSw').checked,
      };
      BT.store.set('mcc-mm', o);
      loadMm();
    };
    ['mccMmPct', 'mccMmN', 'mccMmIv', 'mccMmSw'].forEach((id) => ($(id).onchange = save));
    $('mccMmMode').onclick = (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      BT.store.set('mcc-mm', { ...mmOpts(), mode: m });
      $('mccMmMode')
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      document.querySelector('.mcc-mm-model').classList.toggle('hidden', m !== 'model');
      loadMm();
    };
    $('mccMmIdx').oninput = (e) => {
      stopMm();
      mmState.idx = Number(e.target.value);
      drawMm();
    };
    $('mccMmPlay').onclick = () => {
      if (mmState.timer) return stopMm();
      if (mmState.idx >= mmState.rows.length - 1) mmState.idx = -1;
      $('mccMmPlay').textContent = '❚❚ Pause';
      mmState.timer = setInterval(() => {
        if (!document.body.contains($('mccMmPlay')) || mmState.idx >= mmState.rows.length - 1) return stopMm();
        mmState.idx++;
        drawMm();
      }, 700);
    };
    loadMm();
  }
  function stopMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    if ($('mccMmPlay')) $('mccMmPlay').textContent = '▶ Play the months';
  }
  async function loadMm() {
    stopMm();
    const o = mmOpts();
    const seq = ++mmState.seq;
    let rows = [];
    if (o.mode === 'real') {
      const B = saved.backtest;
      if (!B) {
        $('mccMmNote').textContent = 'No backtest saved yet: run one on the Backtest tab.';
        mmState.rows = [];
        return drawMm();
      }
      const none = new Map(B.without.months.map((m) => [m.expiry, m]));
      rows = B.withAdj.months
        .filter((m) => m.ok)
        .map((m) => {
          const n = none.get(m.expiry);
          const one = (x) =>
            x?.ok ? { opt: x.opt, call: x.callPnl, put: x.putPnl, etf: x.etfOnce, total: x.withOnce, adjustments: x.adjustments, events: x.events } : null;
          return { label: monthName(m.expiry), spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(n) };
        });
      $('mccMmNote').textContent =
        `The backtest's months (${rows.length}, ${sizeLabel(B.withAdj.params)}, ${B.withAdj.params.adj.on ? 'with its adjustments' : 'no adjustments'}) next to the same months without adjustments, NIFTYBEES held throughout. Months left out of the backtest are skipped. ${rows.some((r) => r.adj.call == null) ? 'Run the backtest again to split the options into the call ratio and the butterfly.' : ''}`;
    } else {
      $('mccMmNote').textContent = 'Working…';
      let r;
      try {
        r = await BT.api('/api/mcc/model', { params, opts: { S0: exState().spot, pct: o.pct, months: o.months, iv: o.iv, swings: o.swings } });
      } catch (e) {
        $('mccMmNote').textContent = e.message;
        return;
      }
      if (seq !== mmState.seq) return;
      const one = (x) => ({
        opt: x.opt,
        call: x.callPnl,
        put: x.putPnl,
        etf: x.etf,
        total: x.total,
        adjustments: x.adjustments,
        events: x.events.map((e) => ({ ...e, text: e.text })),
      });
      rows = r.withAdj.map((m, i) => ({ label: `Month ${i + 1}`, spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(r.without[i]) }));
      $('mccMmNote').textContent =
        `The strategy is entered afresh every month (the Backtest tab's settings, ${sizeLabel(params)}, ${params.adj.on ? 'with its adjustments' : 'adjustments off'}), priced by Black-Scholes at ${o.iv} % IV, while Nifty moves the same % each month (${o.pct} % over ${o.months} months). ${o.swings ? 'With weekly swings Nifty zig-zags about one typical week’s move inside each month, which is what triggers the rolls.' : 'Without weekly swings every month is a straight line: no rolls trigger unless the trend alone moves 2 %.'} A model, not a forecast: real months are uneven (see Real months).`;
    }
    mmState.rows = rows;
    mmState.idx = Math.min(mmState.idx, Math.max(0, rows.length - 1));
    $('mccMmIdx').max = Math.max(0, rows.length - 1);
    drawMm();
  }
  function drawMm() {
    const rows = mmState.rows;
    if (!rows.length) {
      $('mccMmBars').innerHTML = '';
      $('mccMmText').innerHTML = '';
      BT.chart($('mccMmChart'), { type: 'line', data: { labels: [], datasets: [] } });
      return;
    }
    const i = Math.max(0, mmState.idx);
    $('mccMmIdx').value = i;
    const cum = (k, upto = i, side = 'adj') => rows.slice(0, upto + 1).reduce((s, r) => s + (r[side]?.[k] || 0), 0);
    const all = (k, side = 'adj') => rows.reduce((s, r) => s + Math.abs(r[side]?.[k] || 0), 0);
    const scale = Math.max(...['etf', 'call', 'put', 'opt', 'total'].map((k) => Math.abs(cum(k, rows.length - 1))), all('opt') / 2, 1);
    const r = rows[i];
    bars(
      $('mccMmBars'),
      [
        ['NIFTYBEES', cum('etf')],
        ['Call ratio spread', cum('call'), `not adjusted ${inrS(cum('call', i, 'none'))}`],
        ['Put 2-3-1 butterfly', cum('put'), `not adjusted ${inrS(cum('put', i, 'none'))}`],
        ['Without NIFTYBEES (options)', cum('opt'), `not adjusted ${inrS(cum('opt', i, 'none'))}`, true],
        ['With NIFTYBEES (total)', cum('total'), `not adjusted ${inrS(cum('total', i, 'none'))}`, true],
      ],
      scale,
    );
    const ev = (r.adj?.events || []).filter((e) => !['entry', 'expiry'].includes(e.kind));
    $('mccMmText').innerHTML =
      `<b>${esc(r.label)}</b> · Nifty ${num0(r.spot0)} → ${num0(r.spotE)} (${pct(((r.spotE - r.spot0) / r.spot0) * 100)}) · this month: call ratio <b class="${cls(r.adj.call)}">${inrS(r.adj.call)}</b>, butterfly <b class="${cls(r.adj.put)}">${inrS(r.adj.put)}</b>, NIFTYBEES <b class="${cls(r.adj.etf)}">${inrS(r.adj.etf)}</b>, total <b class="${cls(r.adj.total)}">${inrS(r.adj.total)}</b>
      ${ev.length ? `<ul>${ev.map((e) => `<li>${e.day != null && typeof e.day === 'number' ? `day ${e.day}` : dayLabel(e.day)}: ${esc(e.text)}</li>`).join('')}</ul>` : '<div class="muted">No rolls this month.</div>'}
      <span class="muted">Totals since month 1 in the bars.</span>`;
    const upto = (f) => rows.map((x, j) => (j <= i ? rows.slice(0, j + 1).reduce((s, y) => s + (f(y) || 0), 0) : null));
    BT.chart($('mccMmChart'), {
      type: 'line',
      data: {
        labels: rows.map((x) => x.label),
        datasets: [
          { label: 'Adjusted + NIFTYBEES', data: upto((y) => y.adj?.total), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
          { label: 'Not adjusted + NIFTYBEES', data: upto((y) => y.none?.total), borderColor: '#b392f0', borderWidth: 1.5, pointRadius: 0 },
          { label: 'NIFTYBEES alone', data: upto((y) => y.adj?.etf), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
          { label: 'Call ratio spread', data: upto((y) => y.adj?.call), borderColor: '#d6af4c', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Put 2-3-1 butterfly', data: upto((y) => y.adj?.put), borderColor: '#3fb68b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
          {
            label: 'Nifty',
            data: rows.map((x, j) => (j <= i ? x.spotE : null)),
            borderColor: 'rgba(154,165,177,.5)',
            borderWidth: 1,
            pointRadius: 0,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (n) => kinr(n) } }, y2: { position: 'right', grid: { display: false }, ticks: { callback: (n) => num0(n) } } },
        plugins: {
          tooltip: { callbacks: { label: (c) => (c.dataset.yAxisID === 'y2' ? `Nifty ${num0(c.parsed.y)}` : `${c.dataset.label}: ${inrS(c.parsed.y)}`) } },
        },
      },
    });
  }

  // ----- When Nifty rises -----
  function risesHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the adjustment study on the Backtest tab: this section is drawn from it.</p>';
    const up = r0.summary.byMove.up;
    const ids = [
      ['none', 'No adjustments (the rule as entered)'],
      [REC.user, 'Your rule: sold strikes rolled at 2 %'],
      ['upRoll', 'Roll the call ratio up at the sold strike'],
      ['upRoll100', 'Roll the call ratio up 100 pts over the sold strike'],
      ['upBuy', 'Buy one sold call back at the sold strike'],
      ['upHedge', 'Buy a call 200 pts over the sold strike'],
      ['ratio11', 'Sell 1 call instead of 2 (1 × 1)'],
      ['ratio11move2', 'Sell 1 call instead of 2, rolls at 2 %'],
      [REC.all, 'Whole spread / butterfly rolled at 1.5 %'],
      ['all15upHedge', 'Whole-spread rolls + the hedge call'],
    ]
      .map(([id, label]) => [studyRow(id), label])
      .filter(([r]) => r);
    const avg = (b, k = 'withOnce') => (b.n ? b[k] / b.n : 0);
    const holdUp = avg(up, 'hold');
    const row = ([r, label]) => {
      const s = r.summary;
      return `<tr${r.id === 'none' ? ' class="cc-click on"' : ''}><td class="l">${esc(label)}</td><td class="${cls(s.withOnce.total)}">${inrS(s.withOnce.total)}</td><td class="${cls(avg(s.byMove.up))}">${inrS(avg(s.byMove.up))}</td><td class="${cls(avg(s.byMove.flat))}">${inrS(avg(s.byMove.flat))}</td><td class="${cls(avg(s.byMove.down))}">${inrS(avg(s.byMove.down))}</td><td class="${cls(s.call.total)}">${inrS(s.call.total)}</td><td class="${cls(s.put.total)}">${inrS(s.put.total)}</td><td class="neg">${inr(s.opt.worst)}</td></tr>`;
    };
    const f = (id) => {
      const r = studyRow(id);
      return r ? inrS(avg(r.summary.byMove.up)) : '—';
    };
    const tot = (id) => {
      const r = studyRow(id);
      return r ? inrS(r.summary.withOnce.total) : '—';
    };
    return `<p>Above the sold call strike the second sold call loses what NIFTYBEES gains, so a rally is capped there (the animation above shows it). In the backtest's ${up.n} months when Nifty rose more than 2 %, the strategy made <b>${inrS(avg(up))}</b> a month on average with NIFTYBEES held, while simply holding the same NIFTYBEES made <b>${inrS(holdUp)}</b>.
      What can be done about it, tested on the same ${r0.summary.months} months (${dayLabel(r0.summary.from)} – ${dayLabel(r0.summary.to)}, with NIFTYBEES held, 0.5 % slippage):</p>
      <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Variant</th><th>Whole period</th><th>Avg up month (hold ${inrS(holdUp)})</th><th>Avg flat month</th><th>Avg down month</th><th>Call ratio (period)</th><th>Butterfly (period)</th><th>Worst month (options)</th></tr></thead>
      <tbody>${ids.map(row).join('')}</tbody></table></div>
      <ul style="margin-top:8px">
        <li><b>Roll the call ratio up</b> (close all three calls, open 1 × 2 again around the new ATM) when Nifty reaches the sold strike: keeps the next leg of a rally (${f('upRoll')} per up month) but pays the loss on the sold calls every time Nifty touches the strike and falls back. Over the whole period ${tot('upRoll')}.</li>
        <li><b>Buy one sold call back</b> at the sold strike, so NIFTYBEES runs free above it: the most per up month (${f('upBuy')}) and the most expensive overall (${tot('upBuy')}).</li>
        <li><b>Buy a hedge call</b> 200 pts over the sold strike once Nifty reaches it: the position gains again above that strike (${f('upHedge')} per up month); the smoothest month to month, but it gives up most of the profit (${tot('upHedge')}).</li>
        <li><b>Sell 1 call instead of 2</b>: no extra sold call, so NIFTYBEES keeps its gain above the sold strike — the most of a rally kept (${f('ratio11')} per up month) — but the second sold call is where most of the income comes from, so over the whole period it lost (${tot('ratio11')}). Only worth it in a month you are confident will rise: a decision at entry, not an adjustment.</li>
        <li><b>Already in your rule:</b> when Nifty rises the sold puts are moved up, collecting more premium (${f(REC.user)} per up month).</li>
      </ul>
      <p class="muted small">One period of history, not a forecast: only ${up.n} rising months. Each variant can be re-tested on the Backtest tab (Up-market extra, call lots).</p>`;
  }

  // ----- Payoff diagram of the month -----
  function bindExample() {
    const draw = () => drawExample();
    document.querySelectorAll('[data-ex]').forEach(
      (el) =>
        (el.onchange = () => {
          const ex = exState();
          ex[el.dataset.ex] = Number(el.value) || ex[el.dataset.ex];
          if (el.dataset.ex === 'spot') {
            ex.legs = bsLegs(ex.spot, ex.iv, ex.days);
            if (params.budget > 0) ex.units = unitsFor(params, ex.spot); // the budget at the new price
          }
          BT.store.set('mcc-ex', ex);
          renderRules();
        }),
    );
    $('mccExBs').onclick = () => {
      const ex = exState();
      ex.legs = bsLegs(ex.spot, ex.iv, ex.days);
      BT.store.set('mcc-ex', ex);
      renderRules();
    };
    draw();
  }
  function drawExample() {
    const ex = exState();
    const lot = params.lotSize;
    const src = { spot: ex.spot, legs: ex.legs, units: ex.units, b0: ex.spot / 100 };
    const legRow = (l, i) =>
      `<span class="mcc-leg"><span class="lbl">${ROLE[l.role] || (l.side > 0 ? 'Buy' : 'Sell')}</span><input class="txt num" data-leg="${i}" data-k="lots" value="${l.lots}" style="width:36px"><span class="lbl">lots @ strike</span><input class="txt num" data-leg="${i}" data-k="strike" value="${l.strike}" style="width:64px"><span class="lbl">premium</span><input class="txt num" data-leg="${i}" data-k="entry" value="${l.entry}" style="width:60px"></span>`;
    const group = (t, title) => {
      const legs = ex.legs.map((l, i) => [l, i]).filter(([l]) => l.type === t);
      const net = legs.reduce((s, [l]) => s - l.side * l.entry * l.lots * lot, 0);
      return `<div class="mcc-grp-box"><div class="cc-grp-l"><b>${title}</b> <span class="muted small">${net >= 0 ? 'credit' : 'debit'} <b class="${cls(net)}">${inrS(net)}</b></span></div>${legs.map(([l, i]) => legRow(l, i)).join('')}</div>`;
    };
    $('mccExLegs').innerHTML = STRUCT.map(([t, title]) => group(t, title)).join('');
    $('mccExLegs')
      .querySelectorAll('[data-leg]')
      .forEach(
        (el) =>
          (el.onchange = () => {
            const e2 = exState();
            e2.legs[Number(el.dataset.leg)][el.dataset.k] = Number(el.value);
            BT.store.set('mcc-ex', e2);
            drawExample();
            drawAnim(true);
          }),
      );
    payoffChart($('mccExPay'), ex.legs, lot, ex.spot, { qty: ex.units, b0: ex.spot / 100, s0: ex.spot }, 'example month');
    // key levels: the strikes, the entry, the call ratio's upper breakeven and ±5 / ±10 %
    const k = (role) => ex.legs.find((l) => l.role === role)?.strike;
    const callOnly = (x) => optAt(of(ex.legs, 'CE'), x, lot);
    let be = null;
    for (let x = k('ceS') || ex.spot; x < ex.spot * 1.3; x += 1)
      if (callOnly(x) < 0) {
        be = x;
        break;
      }
    const levels = [
      ...new Set(
        [ex.spot * 0.9, k('peW') - 100, k('peW'), k('peS'), k('peL'), ex.spot, k('ceL'), k('ceS'), be, ex.spot * 1.05, ex.spot * 1.1]
          .filter((x) => x > 0)
          .map((x) => Math.round(x)),
      ),
    ].sort((a, b) => a - b);
    const tag = (x) =>
      ({
        [k('peW')]: 'wing',
        [k('peS')]: 'sold puts',
        [k('peL')]: 'bought puts',
        [Math.round(ex.spot)]: 'entry',
        [k('ceL')]: 'bought call',
        [k('ceS')]: 'sold calls',
        [be]: 'call ratio breakeven',
      })[x] || '';
    const inv = ex.units * (ex.spot / 100);
    $('mccExTbl').innerHTML =
      `<table class="grid-tbl"><thead><tr><th class="l">Nifty at expiry</th><th>NIFTYBEES</th><th class="cc-col-opt">Call ratio spread</th><th class="cc-col-opt">Put butterfly</th><th>Without NIFTYBEES</th><th>% of NIFTYBEES</th><th class="cc-col-tot">With NIFTYBEES</th></tr></thead><tbody>
      ${levels
        .map((x) => {
          const v = parts(src, x);
          return `<tr><td class="l">${num0(x)} <span class="muted small">${tag(x)}</span></td><td class="${cls(v.etf)}">${inrS(v.etf)}</td><td class="cc-col-opt ${cls(v.call)}">${inrS(v.call)}</td><td class="cc-col-opt ${cls(v.put)}">${inrS(v.put)}</td><td class="${cls(v.opt)}">${inrS(v.opt)}</td><td>${pct((v.opt / inv) * 100)}</td><td class="cc-col-tot ${cls(v.total)}">${inrS(v.total)}</td></tr>`;
        })
        .join('')}</tbody></table>`;
  }

  function rulesWhen(rU, r0) {
    const rows = ['move1', 'move15', 'move2', 'move3'].map(studyRow);
    const known = rU && r0 && rows.every(Boolean);
    const vs = (r) => inrS(r.summary.opt.total - r0.summary.opt.total);
    const hourly = studyRow('move15h');
    const decay = studyRow('decay35');
    const nocap = studyRow('move15nc');
    return `<ol>
      <li><b>Check once a day, at 15:00.</b> Intraday checks only add trades: ${hourly && studyRow('move15') ? `checking every hour gave ${vs(hourly)} vs no adjustments, about the same as once a day (${vs(studyRow('move15'))})` : 'hourly checks gave the same result'}.</li>
      <li><b>Roll a side when Nifty has moved 2 % from that side's entry or last roll</b> (market up → the butterfly's sold puts; market down → the ratio's sold calls)${known ? `: 1 % ${vs(rows[0])}, 1.5 % ${vs(rows[1])}, 2 % ${vs(rows[2])}, 3 % ${vs(rows[3])} on the options against no adjustments` : ''}. Rolling on small moves pays slippage on every whipsaw.
        A premium rule works about as well: roll a sold leg once it is worth 35 % of what it was sold for${decay ? ` (${vs(decay)})` : ''}.</li>
      <li><b>Keep the sold puts at or under the bought puts.</b> Letting them pass the bought strike leaves 3 sold over 2 bought when the market turns${nocap ? ` (${vs(nocap)})` : ''}.</li>
      <li><b>No rolls in the last 3 trading days</b> and at most 3 per side a month: late rolls buy very little premium for the slippage.</li>
    </ol>
    <span class="muted small">Your rule as given is roughly neutral: it moves money between months more than it adds any. The rolls do not protect the ETF from a fall; the put butterfly does that, and only down to its wing.</span>`;
  }
  const skippedText = (s) => (s?.skipped?.length ? `Left out (no option prices in the cache): ${s.skipped.map((x) => monthName(x.expiry)).join(', ')}.` : '');

  // The study's rules, best first (options P&L over the period; the ETF is the same in every row, so the order with
  // NIFTYBEES is the same), with a line naming the best and the steadiest.
  function studyTable(st, compact) {
    const r0 = st.rows.find((r) => r.id === 'none');
    const rows = [...st.rows].sort((a, b) => b.summary.opt.total - a.summary.opt.total);
    const top = rows[0];
    const steady = [...st.rows].filter((r) => r.summary.opt.total > 0).sort((a, b) => b.summary.opt.maxDD - a.summary.opt.maxDD)[0];
    const t = top.summary;
    const bestLine = `<div class="mcc-best"><span class="cc-kind k-book">Best</span> <b>${esc(top.label)}</b>: ${inrS(t.opt.total)} on the options (${inrS(t.opt.total - r0.summary.opt.total)} vs no adjustments), ${inrS(t.withOnce.total)} with NIFTYBEES held, ${t.adjustments} rolls; worst month ${inr(t.opt.worst)}, drawdown ${inr(t.opt.maxDD)} (no adjustments: ${inr(r0.summary.opt.worst)} / ${inr(r0.summary.opt.maxDD)}).
      ${steady && steady.id !== top.id ? `<br><span class="cc-kind k-call">Steadiest</span> <b>${esc(steady.label)}</b>: the smallest drawdown of the profitable rules (${inr(steady.summary.opt.maxDD)}) for ${inrS(steady.summary.opt.total)}.` : ''}
      <br><span class="muted small">Best on this one period of history (${r0.summary.months} months); the gap between neighbouring rows is often a single month.</span></div>`;
    return `${bestLine}<div class="tbl-wrap"><table class="grid-tbl">
      <thead><tr><th>#</th><th class="l">Rule</th><th>Rolls</th><th>Options P&L</th><th>vs none</th><th>Worst month</th><th>Max drawdown</th><th>Call ratio</th><th>Butterfly</th><th>Up months</th><th>Flat</th><th>Down</th><th>+ ETF held</th><th>+ ETF rebought</th>${compact ? '' : '<th>Costs</th>'}</tr></thead>
      <tbody>${rows
        .map((r, i) => {
          const s = r.summary;
          return `<tr class="cc-click${r.id === 'none' ? ' on' : ''}${r === top ? ' mcc-top' : ''}${viewing?.id === r.id ? ' mcc-viewing' : ''}" data-rule="${r.id}" title="Click: this rule's full backtest, month by month with every adjustment">
            <td>${i + 1}</td>
            <td class="l">${esc(r.label)}${r === top ? ' <span class="cc-kind k-book">best</span>' : ''}${steady && r === steady && r !== top ? ' <span class="cc-kind k-call">steadiest</span>' : ''}${r.id === REC.user ? ' <span class="cc-kind">suggested timing for your rule</span>' : ''}${r.id === 'none' ? ' <span class="cc-kind">baseline</span>' : ''}</td>
            <td>${s.adjustments}</td>
            <td class="${cls(s.opt.total)}"><b>${inrS(s.opt.total)}</b></td>
            <td class="${cls(s.opt.total - r0.summary.opt.total)}">${r.id === 'none' ? '—' : inrS(s.opt.total - r0.summary.opt.total)}</td>
            <td class="neg">${inr(s.opt.worst)}</td>
            <td class="neg">${inr(s.opt.maxDD)}</td>
            <td class="${cls(s.call?.total)}">${s.call ? inrS(s.call.total) : '—'}</td>
            <td class="${cls(s.put?.total)}">${s.put ? inrS(s.put.total) : '—'}</td>
            <td class="${cls(s.byMove.up.opt)}">${inrS(s.byMove.up.opt)}</td>
            <td class="${cls(s.byMove.flat.opt)}">${inrS(s.byMove.flat.opt)}</td>
            <td class="${cls(s.byMove.down.opt)}">${inrS(s.byMove.down.opt)}</td>
            <td class="${cls(s.withOnce.total)}">${inrS(s.withOnce.total)}</td>
            <td class="${cls(s.withMonthly.total)}">${inrS(s.withMonthly.total)}</td>
            ${compact ? '' : `<td>${inr(s.costs)}</td>`}
          </tr>`;
        })
        .join('')}</tbody></table></div>
      <div class="muted small pad"><b>Click a rule</b> to open its full backtest on the Backtest tab: every month, every adjustment. Options P&L after slippage and charges, split into the call ratio spread and the put butterfly (each net of its own costs). Up / flat / down: months where Nifty rose more than 2 %, stayed within ±2 %, fell more than 2 % from entry to expiry.
      "+ ETF held": with NIFTYBEES bought once (buy and hold alone: ${inrS(r0.summary.hold.total)}). "+ ETF rebought": sold at each expiry and bought back at the next entry.</div>`;
  }

  // ---------- Backtest ----------
  const sel = (path, cur, opts) =>
    `<select data-p="${path}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const inp = (path, cur, w = 60) => `<input class="txt num" data-p="${path}" value="${cur}" style="width:${w}px">`;
  function renderBacktest() {
    const p = params;
    const months = meta.monthly || [];
    const range = BT.store.get('mcc-range', { from: months[1] || '', to: months[months.length - 1] || '' });
    $('mccBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Settings</h3>
        <div class="cc-params">
          <div class="set-row"><b>Series</b> <span class="lbl">from expiry</span>${`<select id="mccFrom">${months
            .slice(1)
            .map((e) => `<option${e === range.from ? ' selected' : ''}>${e}</option>`)
            .join('')}</select>`}
            <span class="lbl">to</span>${`<select id="mccTo">${months
              .slice(1)
              .map((e) => `<option${e === range.to ? ' selected' : ''}>${e}</option>`)
              .join('')}</select>`}</div>
          ${budgetRow(p.budget, exState().spot, 'Bought at each entry (held: once, at the first); % a year is on the budget. Saved results are shown for it without re-running.')}
          <div class="set-row"><b>Adjustments</b> ${sel('adj.on', p.adj.on, [
            [true, 'on: roll the sold strikes'],
            [false, 'off'],
          ])}
            <span class="lbl">when</span>${sel('adj.trigger', p.adj.trigger, [
              ['move', 'Nifty moved'],
              ['decay', 'sold leg decayed to'],
            ])} ${inp('adj.movePct', p.adj.movePct, 50)}<span class="lbl">% (move) /</span>${inp('adj.decayPct', p.adj.decayPct, 50)}<span class="lbl">% of its premium (decay)</span></div>
          <div class="set-row"><b></b><span class="lbl">checked</span>${sel('adj.check', p.adj.check, [
            ['close', 'once a day at 15:00'],
            ['hourly', 'hourly 10:30–15:00'],
          ])}
            <span class="lbl">roll</span>${sel('adj.legs', p.adj.legs, [
              ['short', 'only the sold strikes (your rule)'],
              ['all', 'the whole spread / butterfly'],
            ])}
            <span class="lbl">sold puts</span>${sel('adj.capPut', p.adj.capPut, [
              [true, 'never above the bought puts'],
              [false, 'may pass them'],
            ])}</div>
          <div class="set-row"><b></b><span class="lbl">none in the last</span>${inp('adj.lastDays', p.adj.lastDays, 40)}<span class="lbl">trading days · at most</span>${inp('adj.maxPerSide', p.adj.maxPerSide, 40)}<span class="lbl">rolls per side a month</span></div>
          <div class="set-row" title="At every new series (backtest and paper trade) the strike placement and the gaps are picked so that the flat zone between the put butterfly and the call ratio — the P&amp;L at expiry with every option worthless, i.e. the net credit after fills and costs — is this amount (within 5 %), the downside never goes under it, and the upside loss starts as far above Nifty as possible. The month's rolls keep that shape. Off: the fixed distances in the two rows below."><b>Ideal trade</b>${sel(
            'target.on',
            p.target?.on ?? true,
            [
              [true, 'pick strikes and gaps for a flat zone of'],
              [false, 'off: use the fixed distances below'],
            ],
          )}<span class="lbl">₹</span>${inp('target.amount', p.target?.amount ?? 15000, 70)}<span class="lbl">at expiry between the put butterfly and the call ratio</span></div>
          <div class="set-row" title="When the paper trade opens a series (Start, or after an expiry) and this month's monthly expiry is fewer than this many calendar days away, it skips it and builds the strategy on next month's strikes. The backtest enters every series on its first trading day, always further out."><b>Paper series</b><span class="lbl">skip this month when fewer than</span>${inp('minDays', p.minDays ?? 15, 40)}<span class="lbl">calendar days are left to its expiry: use next month's</span></div>
          <div class="set-row"><b>Call ratio spread</b><span class="lbl">buy</span>${inp('ce.buy', p.ce.buy, 36)}<span class="lbl">lot at ATM +</span>${inp('ce.buyOff', p.ce.buyOff, 50)}<span class="lbl">· sell</span>${inp('ce.sell', p.ce.sell, 36)}<span class="lbl">lots</span>${inp('ce.sellGap', p.ce.sellGap, 50)}<span class="lbl">pts above (1 × 1 = no extra sold call)</span></div>
          <div class="set-row"><b>Put butterfly</b><span class="lbl">buy</span>${inp('pe.buy', p.pe.buy, 36)}<span class="lbl">at ATM −</span>${inp('pe.buyOff', p.pe.buyOff, 50)}<span class="lbl">· sell</span>${inp('pe.sell', p.pe.sell, 36)}${inp('pe.sellGap', p.pe.sellGap, 50)}<span class="lbl">pts under · buy</span>${inp('pe.wing', p.pe.wing, 36)}${inp('pe.wingGap', p.pe.wingGap, 50)}<span class="lbl">pts under the sold strike</span></div>
          <div class="set-row"><b>Up-market extra</b> ${sel('up.mode', p.up.mode, [
            ['none', 'none'],
            ['roll', 'roll the call ratio up to the new ATM'],
            ['buyBack', 'buy one sold call back'],
            ['hedge', 'buy a hedge call over the sold strike'],
          ])}
            <span class="lbl">when Nifty ≥ sold call +</span>${inp('up.buffer', p.up.buffer, 50)}<span class="lbl">pts · hedge call</span>${inp('up.hedgeGap', p.up.hedgeGap, 50)}<span class="lbl">pts over the sold strike</span></div>
          <div class="set-row"><b>NIFTYBEES</b> ${sel('etf', p.etf, [
            ['model', '₹1 per 100 Nifty points (Nifty ÷ 100)'],
            ['real', 'recorded NIFTYBEES prices'],
          ])}
            <span class="lbl">option slippage</span>${inp('costs.slipPct', p.costs.slipPct, 45)}<span class="lbl">% · brokerage ₹</span>${inp('costs.brokerage', p.costs.brokerage, 45)}<span class="lbl">/ order · ETF slippage</span>${inp('costs.etfSlipPct', p.costs.etfSlipPct, 45)}<span class="lbl">%</span></div>
          <div class="set-row cc-run">
            <button class="btn-sm run" id="mccRun">Run backtest</button>
            <button class="btn-sm ghost" id="mccStudy">Run adjustment study</button>
            <button class="btn-sm ghost" id="mccDefaults">Defaults</button>
            <span class="muted small">The backtest runs these settings and the same without any adjustment. The study runs ${meta.study.length} rules on the same months. Both use the cached history (missing contracts are downloaded when logged in).</span>
            <div class="progress hidden" id="mccProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
          </div>
          ${lastDone ? `<div class="small mcc-done">${lastDone}</div>` : ''}
        </div>
      </div>
      <div id="mccRes"></div>`;
    $('mccBody')
      .querySelectorAll('[data-p]')
      .forEach((el) => el.addEventListener('change', () => setParam(el.dataset.p, el.value)));
    bindBudget((v) => {
      useBudget(v);
      renderBacktest();
    });
    ['mccFrom', 'mccTo'].forEach((id) => $(id).addEventListener('change', () => BT.store.set('mcc-range', { from: $('mccFrom').value, to: $('mccTo').value })));
    $('mccRun').addEventListener('click', () => {
      viewing = null;
      runJob('backtest');
    });
    $('mccStudy').addEventListener('click', () => runJob('study'));
    $('mccDefaults').addEventListener('click', () => {
      params = { ...deep(meta.defaults), lotSize: meta.lot };
      BT.store.set('mcc-params', params);
      renderBacktest();
    });
    if (job) showProgress(job.progress);
    renderResults();
  }
  function setParam(path, raw) {
    const v = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !isNaN(raw) ? Number(raw) : raw;
    const [a, b] = path.split('.');
    if (b) params[a] = { ...params[a], [b]: v };
    else params[a] = v;
    BT.store.set('mcc-params', params);
  }
  function showProgress(pr) {
    const box = $('mccProg');
    if (!box) return;
    box.classList.toggle('hidden', !job);
    if (!pr) return;
    const inner = pr.inner || pr;
    const frac = pr.total ? (pr.done + (pr.inner?.total ? pr.inner.done / pr.inner.total : 0)) / pr.total : 0;
    box.querySelector('.fill').style.width = (frac * 100).toFixed(1) + '%';
    box.querySelector('.ptext').textContent = `${pr.phase || ''} ${inner.total ? `${inner.done}/${inner.total}` : ''} · ${pr.api?.requests ?? 0} downloads`;
  }
  async function runJob(kind) {
    if (job) return;
    const range = { from: $('mccFrom')?.value, to: $('mccTo')?.value };
    lastDone = '';
    document.querySelector('.mcc-done')?.remove();
    try {
      job = { kind, progress: null };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api('/api/mcc/' + kind, { params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api('/api/mcc/job?id=' + job.id);
        job.progress = j.progress;
        showProgress(j.progress);
        if (j.status === 'done') {
          raw[kind] = j.result;
          rebudgetAll();
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
    } catch (e) {
      lastDone = '';
      $('mccRes') &&
        ($('mccRes').innerHTML = `<div class="panel empty err">${kind === 'study' ? 'Adjustment study' : 'Backtest'} failed: ${esc(e.message)}</div>`);
      job = null;
      showProgress(null);
      return;
    }
    job = null;
    const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    lastDone =
      kind === 'study'
        ? `✓ Adjustment study finished at ${t}: ${saved.study.rows.length} rules on ${saved.study.rows[0]?.summary.months || 0} months. The table is below (and on Strategy & rules).`
        : `✓ Backtest finished at ${t}.`;
    if (tab === 'bt') {
      renderBacktest();
      $(kind === 'study' ? 'mccStudyPanel' : 'mccRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function kpiBlock(title, s, note) {
    const card = (label, x, sub) =>
      `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${cls(x.total)}">${inrS(x.total)}</span><span class="muted small">${sub}</span></div>`;
    const sub = (x) => `${pct(x.annPct)} / yr · worst ${kinr(x.worst)} · DD ${kinr(x.maxDD)} · ${x.win}/${s.months} up`;
    return `<div class="cc-grp-l" style="margin:6px 0 4px"><b>${title}</b> <span class="muted small">${note || ''}</span></div>
      <div class="kpis cc-kpis-main">
        ${s.call ? card('Call ratio spread', s.call, sub(s.call)) : ''}
        ${s.put ? card('Put 2-3-1 butterfly', s.put, sub(s.put)) : ''}
        ${card('Options only (both)', s.opt, sub(s.opt))}
        ${card('+ NIFTYBEES held', s.withOnce, sub(s.withOnce))}
        ${card('+ NIFTYBEES rebought monthly', s.withMonthly, sub(s.withMonthly))}
        ${card('NIFTYBEES alone (buy & hold)', s.hold, sub(s.hold))}
      </div>`;
  }
  function renderResults() {
    const el = $('mccRes');
    const B = viewing?.B || saved.backtest;
    if (!B) {
      el.innerHTML = `<div class="panel empty"><h3>No backtest yet</h3><p>Press Run backtest.</p></div>${saved.study ? `<div class="panel cc-doc" id="mccStudyPanel"><h3>Adjustment study</h3>${studyTable(saved.study)}</div>` : ''}`;
      return;
    }
    const A = B.withAdj;
    const N = B.without;
    const sa = A.summary;
    const sn = N.summary;
    const byExp = new Map(N.months.map((m) => [m.expiry, m]));
    const adjDesc = (p) =>
      p.adj.on
        ? `${p.adj.legs === 'all' ? 'whole spread' : 'sold strikes'} rolled at ${p.adj.trigger === 'decay' ? p.adj.decayPct + ' % premium' : p.adj.movePct + ' % Nifty move'}, ${p.adj.check === 'hourly' ? 'hourly' : '15:00'} checks`
        : 'no rolls';
    const upDesc = (p) => ({ none: '', roll: ' · call ratio rolled up', buyBack: ' · sold call bought back', hedge: ' · hedge call bought' })[p.up.mode] || '';
    const all = openMonth === 'all';
    el.innerHTML = `
      ${
        viewing
          ? `<div class="panel cc-doc mcc-view-banner"><span class="cc-kind k-book">Study rule</span><b>${esc(viewing.label)}</b><span class="muted small">its full backtest (not saved; your own backtest is kept)</span>
        <button class="btn-sm ghost" id="mccViewBack">Back to your backtest</button><button class="btn-sm ghost" id="mccViewUse">Use these settings</button><span class="small" id="mccViewMsg"></span></div>`
          : ''
      }
      <div class="panel cc-doc">
        <h3>Result: ${dayLabel(sa.from)} – ${dayLabel(sa.to)}, ${sa.months} monthly series, ${sizeLabel(A.params)}</h3>
        ${(B.withAdj !== (viewing?.raw || raw.backtest)?.withAdj) ? `<div class="muted small" style="margin-bottom:6px">Run with ${sizeLabel((viewing?.raw || raw.backtest).withAdj.params)}; shown for your budget: the options are the same, the NIFTYBEES figures scaled to it.</div>` : ''}
        ${kpiBlock('With adjustments', sa, adjDesc(A.params) + upDesc(A.params) + ` · ${sa.adjustments} adjustments · costs ${inr(sa.costs)}`)}
        ${kpiBlock('Without adjustments', sn, `costs ${inr(sn.costs)}`)}
        <p class="cc-verdict">${verdict(sa, sn, A.params)}</p>
        <p class="muted small">% per year on ${A.params.budget > 0 ? 'the NIFTYBEES budget' : 'the ETF bought at the first entry'} (${inr(sa.invested)}). ${skippedText(sa)} DD = largest fall from a peak of the month-end totals.
        "Rebought monthly" is out of the market from each expiry's close to the next morning; ${gapNote(A)}.</p>
      </div>
      <div class="panel cc-doc"><h3>Month-end total</h3><div class="cc-pay-chart"><canvas id="mccEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>By market direction</h3>${dirTable(sa, sn)}</div>
      <div class="panel cc-doc"><h3>Month by month <button class="btn-sm ghost" id="mccAllMonths" style="margin-left:8px">${all ? 'Hide the details' : 'Show every month’s details'}</button></h3><div class="muted small" style="margin-bottom:6px">Call ratio and butterfly: the adjusted run, each net of its own costs. Click a month for every leg it traded (closed strikes included), the options and NIFTYBEES totals, its adjustments and the payoff of the position held into expiry.</div>
        <div class="tbl-wrap"><table class="grid-tbl cc-months"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th><th>Rolls</th><th>Call ratio</th><th>Butterfly</th><th class="cc-col-opt">Options, adjusted</th><th class="cc-col-opt">Options, not adjusted</th><th>NIFTYBEES held</th><th>NIFTYBEES rebought</th><th class="cc-col-tot">Total adjusted + held</th><th class="cc-col-tot">Total not adjusted + held</th></tr></thead>
        <tbody>${A.months
          .map((m) => {
            const n = byExp.get(m.expiry);
            if (!m.ok) return `<tr><td class="l">${monthName(m.expiry)}</td><td colspan="11" class="muted l">${esc(m.skip)}</td></tr>`;
            const open = all || openMonth === m.expiry;
            return `<tr class="cc-click${open ? ' on' : ''}" data-m="${m.expiry}"><td class="l">${monthName(m.expiry)}</td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td class="${cls(m.move)}">${pct(m.move)}</td><td>${m.adjustments}</td>
              <td class="${cls(m.callPnl)}">${m.callPnl != null ? inrS(m.callPnl) : '—'}</td><td class="${cls(m.putPnl)}">${m.putPnl != null ? inrS(m.putPnl) : '—'}</td>
              <td class="cc-col-opt ${cls(m.opt)}">${inrS(m.opt)}</td><td class="cc-col-opt ${cls(n?.opt)}">${n?.ok ? inrS(n.opt) : '—'}</td>
              <td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.etfMonthly)}">${inrS(m.etfMonthly)}</td>
              <td class="cc-col-tot ${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="cc-col-tot ${cls(n?.withOnce)}">${n?.ok ? inrS(n.withOnce) : '—'}</td></tr>
              ${open ? `<tr class="cc-detail"><td colspan="12">${monthDetail(m, n)}</td></tr>` : ''}`;
          })
          .join('')}</tbody>
        <tfoot><tr><th class="l">Total</th><td></td><td></td><td>${sa.adjustments}</td><th class="${cls(sa.call?.total)}">${sa.call ? inrS(sa.call.total) : ''}</th><th class="${cls(sa.put?.total)}">${sa.put ? inrS(sa.put.total) : ''}</th><th class="${cls(sa.opt.total)}">${inrS(sa.opt.total)}</th><th class="${cls(sn.opt.total)}">${inrS(sn.opt.total)}</th><th class="${cls(sa.hold.total)}">${inrS(sa.hold.total)}</th><th class="${cls(sa.withMonthly.total - sa.opt.total)}">${inrS(sa.withMonthly.total - sa.opt.total)}</th><th class="${cls(sa.withOnce.total)}">${inrS(sa.withOnce.total)}</th><th class="${cls(sn.withOnce.total)}">${inrS(sn.withOnce.total)}</th></tr></tfoot></table></div>
      </div>
      <div class="panel cc-doc"><h3>Every adjustment</h3>${adjustmentList(A)}</div>
      <div class="panel cc-doc" id="mccStudyPanel"><h3>Adjustment study</h3>${saved.study ? studyTable(saved.study) + `<div class="muted small pad">Run ${new Date(saved.study.at).toLocaleString('en-IN')} with ${sizeLabel(saved.study.rows[0]?.params)}. The rules tab explains what to take from it.</div>` : '<p class="muted">Not run yet: "Run adjustment study" above.</p>'}</div>`;
    drawEquity(A, N);
    el.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', () => {
        openMonth = openMonth === tr.dataset.m ? null : tr.dataset.m;
        renderResults();
      }),
    );
    $('mccAllMonths').onclick = () => {
      openMonth = all ? null : 'all';
      renderResults();
    };
    if (viewing) {
      $('mccViewBack').onclick = () => {
        viewing = null;
        openMonth = null;
        renderBacktest();
      };
      $('mccViewUse').onclick = () => {
        params = { ...deep(viewing.B.withAdj.params), lotSize: meta.lot };
        BT.store.set('mcc-params', params);
        const label = viewing.label;
        renderBacktest();
        $('mccViewMsg').textContent = `Settings set to "${label}". Press Run backtest to keep its result as your backtest (and for the paper trade).`;
      };
    }
    for (const m of A.months.filter((x) => x.ok && (all || x.expiry === openMonth))) {
      const canvas = el.querySelector(`[data-pay="${m.expiry}"]`);
      if (canvas)
        payoffChart(
          canvas,
          m.finalLegs,
          A.params.lotSize,
          m.spot0,
          { qty: m.etf.qtyOnce || m.etf.qtyMonthly, b0: m.etf.bees0 ?? m.spot0 / 100, s0: m.spot0 },
          `expired at ${num0(m.spotE)}`,
        );
    }
  }
  // Every roll / extra of a backtest, month by month, with the structure it touched.
  const SIDE = { rollPut: 'PE', rollCall: 'CE', upRoll: 'CE', buyBack: 'CE', upHedge: 'CE' };
  function adjustmentList(A) {
    const rows = A.months.filter((m) => m.ok).flatMap((m) => m.events.filter((e) => SIDE[e.kind] || e.kind === 'skip').map((e) => ({ m, e })));
    if (!rows.length) return '<p class="muted">No adjustments in this run.</p>';
    const count = (t) => rows.filter((r) => SIDE[r.e.kind] === t).length;
    const months = new Set(rows.map((r) => r.m.expiry)).size;
    const skips = rows.filter((r) => r.e.kind === 'skip').length;
    return `<p class="small">${rows.length} adjustments in ${months} of ${A.summary.months} months: call ratio ${count('CE')}, put butterfly ${count('PE')}${skips ? `, not done (no price) ${skips}` : ''}.</p>
      <div class="tbl-wrap"><table class="grid-tbl cc-ev"><thead><tr><th class="l">Month</th><th>When</th><th>Structure</th><th>What</th><th>Nifty</th><th class="l">Detail</th><th>Month's options</th></tr></thead><tbody>
      ${rows
        .map(
          ({ m, e }) =>
            `<tr class="cc-click" data-adj-m="${m.expiry}"><td class="l">${monthName(m.expiry)}</td><td>${dayLabel(e.day)} ${e.time}</td><td>${SIDE[e.kind] ? GROUP_NAME[SIDE[e.kind]] : '—'}</td><td><span class="cc-kind k-${e.kind === 'skip' ? 'skip' : 'call'}">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td><td class="${cls(m.opt)}">${inrS(m.opt)}</td></tr>`,
        )
        .join('')}</tbody></table></div><div class="muted small">Click a row to open its month above.</div>`;
  }
  function gapNote(A) {
    const ok = A.months.filter((m) => m.ok);
    let pts = 0;
    for (let i = 1; i < ok.length; i++) pts += ok[i].spot0 - ok[i - 1].spotE;
    return `over these months Nifty moved ${pts >= 0 ? '+' : ''}${num0(pts)} pts between expiry closes and the next entries (left-out months included), which the rebought ETF did not hold`;
  }
  function verdict(sa, sn, p) {
    const d = sa.opt.total - sn.opt.total;
    const parts = [];
    parts.push(
      `Adjustments ${d >= 0 ? 'added' : 'cost'} <b class="${cls(d)}">${inrS(d)}</b> on the options (${inrS(sa.opt.total)} vs ${inrS(sn.opt.total)}); worst month ${inr(sa.opt.worst)} vs ${inr(sn.opt.worst)}.`,
    );
    parts.push(
      `With the ETF held: ${inrS(sa.withOnce.total)} vs buy and hold alone ${inrS(sa.hold.total)}: the options ${sa.opt.total >= 0 ? 'added' : 'took'} ${inrS(sa.opt.total)}, while the drawdown went from ${inr(sa.hold.maxDD)} to ${inr(sa.withOnce.maxDD)}.`,
    );
    parts.push(`Options alone made ${pct(sa.opt.annPct)} a year on ${p?.budget > 0 ? 'the NIFTYBEES budget' : "the ETF's value"}. That does not count interest on the ₹ in the ETF.`);
    return parts.join(' ');
  }
  function dirTable(sa, sn) {
    const row = (k, label) => {
      const a = sa.byMove[k];
      const n = sn.byMove[k];
      return `<tr><td class="l">${label}</td><td>${a.n}</td><td class="${cls(a.call)}">${a.call != null ? inrS(a.call) : '—'}</td><td class="${cls(a.put)}">${a.put != null ? inrS(a.put) : '—'}</td><td class="${cls(a.opt)}">${inrS(a.opt)}</td><td class="${cls(n.opt)}">${inrS(n.opt)}</td><td class="${cls(a.hold)}">${inrS(a.hold)}</td><td class="${cls(a.withOnce)}">${inrS(a.withOnce)}</td><td class="${cls(n.withOnce)}">${inrS(n.withOnce)}</td></tr>`;
    };
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty in the month</th><th>Months</th><th>Call ratio</th><th>Butterfly</th><th>Options, adjusted</th><th>Options, not adjusted</th><th>NIFTYBEES held</th><th>Total adjusted</th><th>Total not adjusted</th></tr></thead><tbody>
      ${row('up', 'Up more than 2 %')}${row('flat', 'Within ±2 %')}${row('down', 'Down more than 2 %')}</tbody></table></div>`;
  }
  // One month in full: every leg it traded (held into expiry or closed by a roll) under its structure, each
  // structure's result after its costs, the options total, NIFTYBEES (held / rebought) and the total; then the payoff
  // of what was held into expiry and the events of the adjusted and the not-adjusted run.
  function monthDetail(m, n) {
    const ev = (list) =>
      `<table class="grid-tbl cc-ev"><tbody>${list.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind k-${e.kind === 'expiry' ? 'exp' : e.kind === 'entry' ? 'hold' : e.kind === 'skip' ? 'skip' : 'call'}">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>`;
    const atExp = (c) => c.exitAt.day === m.expiry && c.exitAt.time === '15:30';
    const when = (x) => (x ? `${dayLabel(x.day)}${x.time ? ' ' + x.time : ''}` : '—');
    const lot = saved.backtest?.withAdj?.params?.lotSize || params.lotSize;
    const legRow = (c) =>
      `<tr><td class="l">${legLine(c)}</td><td>${when(c.at)}</td><td>${c.entry.toFixed(1)}</td><td>${atExp(c) ? 'expiry' : when(c.exitAt)}</td><td>${c.exit.toFixed(1)}</td>
        <td>${atExp(c) ? '<span class="cc-kind k-exp">held to expiry</span>' : '<span class="cc-kind k-call">closed by roll</span>'}</td><td class="${cls(c.pnl)}">${inrS(c.pnl)}</td></tr>`;
    const group = (t) => {
      const g = m.closed.filter((c) => c.type === t).sort((x, y) => (x.at?.day + x.at?.time < y.at?.day + y.at?.time ? -1 : 1));
      if (!g.length) return '';
      const gross = g.reduce((s, c) => s + c.pnl, 0);
      const net = t === 'CE' ? m.callPnl : m.putPnl;
      const rolled = g.filter((c) => !atExp(c)).length;
      return `<tr class="mcc-grp"><td class="l" colspan="7">${GROUP_NAME[t]} <span class="muted small">${rolled ? `${rolled} leg${rolled > 1 ? 's' : ''} closed by rolls` : 'no rolls'}</span></td></tr>
        ${g.map(legRow).join('')}
        ${net != null ? `<tr class="mcc-sub"><td class="l" colspan="6">${GROUP_NAME[t]}: legs ${inrS(gross)}, costs ${inrS(net - gross)}</td><td class="${cls(net)}"><b>${inrS(net)}</b></td></tr>` : ''}`;
    };
    const e = m.etf || {};
    const summary = `<table class="grid-tbl mcc-sum"><tbody>
        ${m.callPnl != null ? `<tr><td class="l">Call ratio spread</td><td class="${cls(m.callPnl)}">${inrS(m.callPnl)}</td></tr><tr><td class="l">Put 2-3-1 butterfly</td><td class="${cls(m.putPnl)}">${inrS(m.putPnl)}</td></tr>` : ''}
        <tr class="mcc-tot"><td class="l">Options total <span class="muted small">(costs ${inr(m.costs)} included)</span></td><td class="${cls(m.opt)}"><b>${inrS(m.opt)}</b></td></tr>
        <tr><td class="l">NIFTYBEES held <span class="muted small">${num0(e.qtyOnce)} units, this month's change${e.beesE ? ` to ₹${e.beesE.toFixed(2)}` : ''}</span></td><td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td></tr>
        <tr><td class="l">NIFTYBEES rebought <span class="muted small">${num0(e.qtyMonthly)} units ₹${e.bees0?.toFixed(2) ?? '—'} → ₹${e.beesE?.toFixed(2) ?? '—'}, charges included</span></td><td class="${cls(m.etfMonthly)}">${inrS(m.etfMonthly)}</td></tr>
        <tr class="mcc-tot"><td class="l">Total with NIFTYBEES held</td><td class="${cls(m.withOnce)}"><b>${inrS(m.withOnce)}</b></td></tr>
        <tr><td class="l">Total with NIFTYBEES rebought</td><td class="${cls(m.withMonthly)}">${inrS(m.withMonthly)}</td></tr>
        ${n?.ok ? `<tr><td class="l muted">Not adjusted: options ${inrS(n.opt)}, total held</td><td class="${cls(n.withOnce)}">${inrS(n.withOnce)}</td></tr>` : ''}
      </tbody></table>`;
    return `<div class="cc-month">
      <div class="cc-month-ev"><div class="tbl-wrap"><table class="grid-tbl mcc-legs"><thead><tr><th class="l">Leg (${lot} per lot)</th><th>Opened</th><th>Entry</th><th>Closed</th><th>Exit</th><th>How</th><th>P&L</th></tr></thead><tbody>${group('CE')}${group('PE')}</tbody></table></div></div>
      <div>${summary}</div>
      <div class="cc-pay"><div class="cc-pay-chart"><canvas data-pay="${m.expiry}"></canvas></div><div class="muted small">Payoff of the position held into expiry (entry premiums of those legs), with and without NIFTYBEES.</div></div>
      <div class="cc-month-ev"><b>Adjustments and events</b>${ev(m.events)}${n?.ok ? `<b>Not adjusted</b>${ev(n.events)}` : ''}</div>
    </div>`;
  }
  function drawEquity(A, N) {
    const ok = A.months.filter((m) => m.ok);
    const byExp = new Map(N.months.map((m) => [m.expiry, m]));
    const cum = (f) => {
      let s = 0;
      return ok.map((m) => (s += f(m) || 0));
    };
    BT.chart($('mccEq'), {
      type: 'line',
      data: {
        labels: ok.map((m) => monthName(m.expiry)),
        datasets: [
          { label: 'Adjusted + ETF held', data: cum((m) => m.withOnce), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
          { label: 'Not adjusted + ETF held', data: cum((m) => byExp.get(m.expiry)?.withOnce), borderColor: '#b392f0', borderWidth: 2, pointRadius: 2 },
          { label: 'ETF alone', data: cum((m) => m.etfOnce), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Options, adjusted', data: cum((m) => m.opt), borderColor: '#e86fb5', borderWidth: 2, pointRadius: 2 },
          { label: 'Options, not adjusted', data: cum((m) => byExp.get(m.expiry)?.opt), borderColor: '#56d4dd', borderWidth: 1.5, pointRadius: 2 },
          { label: 'Call ratio spread (adjusted)', data: cum((m) => m.callPnl), borderColor: '#d6af4c', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Put butterfly (adjusted)', data: cum((m) => m.putPnl), borderColor: '#3fb68b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}` } } },
      },
    });
  }

  // ---------- Paper trade ----------
  async function loadPaper() {
    try {
      paper = await BT.api('/api/mcc/paper');
    } catch (e) {
      paper = { error: e.message };
    }
  }
  async function renderPaper() {
    if (!paper) await loadPaper();
    const el = $('mccBody');
    const P = paper?.paper;
    const lot = P?.params.lotSize || params.lotSize;
    if (paper?.error) {
      el.innerHTML = `<div class="panel empty err">${esc(paper.error)}</div>`;
      return;
    }
    const btns = P
      ? `${P.status === 'running' ? '<button class="btn-sm ghost" data-a="pause">Pause</button>' : '<button class="btn-sm ghost" data-a="resume">Resume</button>'} <button class="btn-sm ghost danger" data-a="reset">Reset</button>`
      : '<button class="btn-sm run" data-a="start">Start paper trade</button>';
    const head = `<div class="panel cc-doc"><h3>Paper trade ${P ? `<span class="cc-kind ${P.status === 'running' ? 'k-book' : 'k-skip'}">${P.status}</span>` : ''}</h3>
      <div class="set-row">${btns}<span class="muted small">Follows the live chain every 30 s with the Backtest tab's settings (${P ? 'as started' : 'current'}): ${esc(settingsLine(P ? P.params : params))}. Paper only: nothing is sent to a broker.${paper.demo ? ' Demo mode: synthetic prices.' : ''}</span></div>
      ${P?.lastError ? `<div class="muted small neg">Last error ${new Date(P.lastError.at).toLocaleTimeString('en-IN')}: ${esc(P.lastError.message)}</div>` : ''}
      ${
        P
          ? budgetRow(
              P.params.budget,
              P.cycle?.spot || P.cycle?.spot0 || exState().spot,
              `Held now: ${num0(P.etfOnce?.qty)} units. A new budget buys (or sells) the difference in NIFTYBEES now, at its current price: the KPIs, the payoff and the "If Nifty is here at expiry" table count the new holding.`,
            )
          : budgetRow(params.budget, exState().spot, 'Bought at Start.')
      }
      <div id="mccPapMsg" class="muted small"></div></div>`;
    if (!P) {
      el.innerHTML =
        head +
        `<div class="panel empty"><h3>No paper trade running</h3><p>Start opens the position now on the current monthly series (next month's when this one has fewer than ${params.minDays ?? 15} days left) at the live prices, buys NIFTYBEES worth ${params.budget > 0 ? `your budget (${inr(params.budget)})` : 'one lot (65 × Nifty)'}, and then runs month after month: rolls at the check times, settlement at each monthly expiry and a new series at 09:30 on the next trading day.</p></div>`;
    } else {
      const c = P.cycle;
      const done = P.months || [];
      const tot = (k) => done.reduce((s, m) => s + (m[k] || 0), 0);
      const scenTop = el.querySelector('.mcc-scen')?.scrollTop; // the 100-point table keeps its scroll through the 30 s redraws
      el.innerHTML =
        head +
        (c
          ? `<div class="panel cc-doc"><h3>${monthName(c.expiry)} series · expiry ${dayLabel(c.expiry)} <button class="btn-sm ghost" data-a="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices: payoff on any date, Greeks, P&amp;L and adjustments. Options only (the Builder holds no NIFTYBEES); the paper trade itself carries on unchanged.">▶ Open in Builder</button></h3>
          <div class="kpis cc-kpis-main">
            <div class="kpi"><span class="k-l">Nifty</span><span class="k-v">${num0(c.spot)}</span><span class="muted small">entry ${num0(c.spot0)} · ${pct(((c.spot - c.spot0) / c.spot0) * 100)}</span></div>
            <div class="kpi"><span class="k-l">Call ratio spread</span><span class="k-v ${cls(c.callPnl)}">${inrS(c.callPnl)}</span><span class="muted small">at LTP, its costs included</span></div>
            <div class="kpi"><span class="k-l">Put 2-3-1 butterfly</span><span class="k-v ${cls(c.putPnl)}">${inrS(c.putPnl)}</span><span class="muted small">at LTP, its costs included</span></div>
            <div class="kpi"><span class="k-l">Options now</span><span class="k-v ${cls(c.opt)}">${inrS(c.opt)}</span><span class="muted small">at LTP, costs so far ${inr(c.costs)}${c.priced === false ? ' · a leg has no LTP' : ''}</span></div>
            <div class="kpi"><span class="k-l">NIFTYBEES held</span><span class="k-v ${cls(c.etfOnce)}">${inrS(c.etfOnce)}</span><span class="muted small">${num0(P.etfOnce?.qty)} units · this series</span></div>
            <div class="kpi"><span class="k-l">Total (held)</span><span class="k-v ${cls((c.opt || 0) + (c.etfOnce || 0))}">${inrS((c.opt || 0) + (c.etfOnce || 0))}</span><span class="muted small">rebought: ${inrS((c.opt || 0) + (c.etfMonthly || 0))}</span></div>
          </div>
          <div class="cc-pos-grid">
            <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Leg</th><th>Entry</th><th>LTP</th><th>P&L</th></tr></thead><tbody>
              ${groupedRows(
                c.legs,
                (l) =>
                  `<tr><td class="l">${legLine(l)}</td><td>${l.entry.toFixed(1)}</td><td>${l.ltp != null ? l.ltp.toFixed(1) : '—'}</td><td class="${cls(l.ltp != null ? (l.ltp - l.entry) * l.side : 0)}">${l.ltp != null ? inrS((l.ltp - l.entry) * l.side * l.lots * lot) : '—'}</td></tr>`,
                4,
                (g) => {
                  const v = g[0].type === 'CE' ? c.callPnl : c.putPnl;
                  return v != null ? `<td class="${cls(v)}" title="with legs closed by rolls and costs">${inrS(v)}</td>` : '';
                },
              )}
              ${c.closed.length ? `<tr><td class="l muted">Closed by rolls: call ratio ${inrS(c.closed.filter((x) => x.type === 'CE').reduce((s, x) => s + x.pnl, 0))}, butterfly ${inrS(c.closed.filter((x) => x.type === 'PE').reduce((s, x) => s + x.pnl, 0))}</td><td></td><td></td><td class="${cls(c.closed.reduce((s, x) => s + x.pnl, 0))}">${inrS(c.closed.reduce((s, x) => s + x.pnl, 0))}</td></tr>` : ''}
            </tbody></table>
            <div class="muted small">Updated ${c.markAt ? new Date(c.markAt).toLocaleTimeString('en-IN') : '—'} · rolls this month: puts ${c.n.put}, calls ${c.n.call}${c.n.up ? `, calls up ${c.n.up}` : ''}</div></div>
            <div class="cc-pay"><div class="cc-pay-chart"><canvas id="mccPapPay"></canvas></div><div class="muted small">At expiry, entry premiums included.</div></div>
          </div>
          ${c.legs.length && c.etf ? scenarioHtml(P, c, lot) : ''}
          <h4>Events</h4><table class="grid-tbl cc-ev"><tbody>${c.events.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>
        </div>`
          : `<div class="panel empty"><h3>Between series</h3><p>The last series expired ${P.lastExpiry ? dayLabel(P.lastExpiry) : ''}. The next one opens at 09:30 on the next trading day.</p></div>`) +
        (done.length
          ? `<div class="panel cc-doc"><h3>Finished months</h3><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty</th><th>Rolls</th><th>Call ratio</th><th>Butterfly</th><th>Options</th><th>NIFTYBEES held</th><th>Total held</th><th>Total rebought</th></tr></thead><tbody>
            ${done.map((m) => `<tr><td class="l">${monthName(m.expiry)}</td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td>${m.adjustments}</td><td class="${cls(m.callPnl)}">${inrS(m.callPnl)}</td><td class="${cls(m.putPnl)}">${inrS(m.putPnl)}</td><td class="${cls(m.opt)}">${inrS(m.opt)}</td><td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="${cls(m.withMonthly)}">${inrS(m.withMonthly)}</td></tr>`).join('')}
            </tbody><tfoot><tr><th class="l">Total</th><td></td><td></td><th class="${cls(tot('callPnl'))}">${inrS(tot('callPnl'))}</th><th class="${cls(tot('putPnl'))}">${inrS(tot('putPnl'))}</th><th class="${cls(tot('opt'))}">${inrS(tot('opt'))}</th><th class="${cls(tot('etfOnce'))}">${inrS(tot('etfOnce'))}</th><th class="${cls(tot('withOnce'))}">${inrS(tot('withOnce'))}</th><th class="${cls(tot('withMonthly'))}">${inrS(tot('withMonthly'))}</th></tr></tfoot></table></div></div>`
          : '');
      if (c?.legs.length) payoffChart($('mccPapPay'), c.legs, lot, c.spot || c.spot0, { qty: P.etfOnce?.qty || 0, b0: c.etf.b0, s0: c.spot0, adj: c.etf.monthlyAdj });
      const scen = el.querySelector('.mcc-scen');
      const now = scen?.querySelector('tr.sel');
      if (scen) scen.scrollTop = scenTop ?? (now ? now.offsetTop - (scen.clientHeight - now.offsetHeight) / 2 : 0); // first time: Nifty now in the middle
    }
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => paperAction(b.dataset.a)));
    bindBudget(async (v) => {
      useBudget(v);
      if (!P) return renderPaper();
      try {
        paper = await BT.api('/api/mcc/paper/budget', { budget: v });
        renderPaper();
      } catch (e) {
        $('mccBudgetNote').innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      }
    });
  }
  // The paper series at its expiry with Nifty every 100 points from 2,000 below to 2,000 above now: NIFTYBEES (its price
  // moving with Nifty from the live one) and the open option legs at intrinsic value, each structure's P&L as the
  // paper counts it (legs closed by rolls + open legs from their entry − its costs) and the total. Before the costs of
  // closing anything at expiry.
  function scenarioHtml(P, c, lot) {
    const intr = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
    const closed = (t) => c.closed.filter((x) => x.type === t).reduce((s, x) => s + x.pnl, 0);
    const pnlOf = (t, x) =>
      closed(t) + c.legs.filter((l) => l.type === t).reduce((s, l) => s + l.side * (intr(l, x) - l.entry) * l.lots * lot, 0) - (c.costsBy?.[t] || 0);
    const qty = P.etfOnce?.qty || 0;
    const spot = c.spot || c.spot0;
    const beesNow = c.bees || spot / 100;
    const base = Math.round(spot / 100) * 100;
    const rows = [];
    for (let i = 20; i >= -20; i--) {
      const x = base + i * 100;
      const bees = (beesNow * x) / spot;
      const etf = qty * (bees - c.etf.onceFrom) + (c.etf.onceAdj || 0) - (c.etf.onceCost ?? (c.etf.firstOnce ? P.etfOnce.cost : 0));
      const value = c.legs.reduce((s, l) => s + l.side * intr(l, x) * l.lots * lot, 0);
      const call = pnlOf('CE', x);
      const put = pnlOf('PE', x);
      rows.push({ x, bees, beesValue: qty * bees, etf, value, call, put, opt: call + put, total: etf + call + put });
    }
    const td = (v) => `<td class="${cls(v)}">${inrS(Math.round(v))}</td>`;
    const move = (x) => (x === base ? 'now' : `${x > spot ? '+' : '−'}${num0(Math.abs(x - spot))} · ${pct(((x - spot) / spot) * 100)}`);
    return `<h4>If Nifty is here at expiry <span class="muted small">every 100 points, 2,000 either way · NIFTYBEES ${num0(qty)} units moving with Nifty from ₹${beesNow.toFixed(2)} · options at intrinsic value · P&amp;L as above (rolls and costs so far included), before the costs of closing at expiry</span></h4>
      <div class="tbl-wrap mcc-scen"><table class="grid-tbl"><thead><tr><th>Nifty</th><th class="l">Move</th><th>NIFTYBEES price</th><th>NIFTYBEES value</th><th title="NIFTYBEES units held, at ₹${c.etf.onceFrom.toFixed(2)} each at the series start (the P&amp;L is against that price; units a budget added during the series, against their own price)">NIFTYBEES bought</th><th>NIFTYBEES P&amp;L</th><th>Options value</th><th>Call ratio P&amp;L</th><th>Put butterfly P&amp;L</th><th>Options P&amp;L</th><th>Combined P&amp;L</th></tr></thead><tbody>
      ${rows
        .map(
          (r) =>
            `<tr class="${r.x === base ? 'sel' : ''}"><td><b>${num0(r.x)}</b></td><td class="l muted small">${move(r.x)}</td><td>₹${r.bees.toFixed(2)}</td><td>${inr(Math.round(r.beesValue))}</td><td>${num0(qty)}</td>${td(r.etf)}<td class="${cls(r.value)}">${inrS(Math.round(r.value))}</td>${td(r.call)}${td(r.put)}${td(r.opt)}<td class="${cls(r.total)}"><b>${inrS(Math.round(r.total))}</b></td></tr>`,
        )
        .join('')}
      </tbody></table></div>`;
  }
  function settingsLine(p) {
    const a = p.adj.on
      ? `${p.adj.legs === 'all' ? 'whole spread' : 'sold strikes'} rolled at ${p.adj.trigger === 'decay' ? p.adj.decayPct + ' % premium' : p.adj.movePct + ' % move'}, ${p.adj.check === 'hourly' ? 'hourly' : '15:00'} checks`
      : 'no adjustments';
    const u = { none: '', roll: ', call ratio rolled up', buyBack: ', sold call bought back', hedge: ', hedge call' }[p.up.mode] || '';
    const t =
      (p.target?.on ? `ideal trade: flat zone ₹${Number(p.target.amount).toLocaleString('en-IN')}, ` : 'fixed strike distances, ') +
      `next month's series when this one has under ${p.minDays ?? 15} days left, `;
    return `${t}${a}${u}, NIFTYBEES ${p.etf === 'real' ? 'live price' : '= Nifty ÷ 100'}, ${p.budget > 0 ? `budget ${inr(p.budget)}` : 'one lot\'s worth'}`;
  }
  // The series' open legs in the Builder as a live paper position at their paper entry prices (as Covered call's paper
  // trade and Live Ideas do): the Builder follows them on the live chain with P&L, payoff on any date and adjustments.
  // Options only: the Builder holds no NIFTYBEES.
  function toBuilder() {
    const P = paper?.paper;
    const c = P?.cycle;
    if (!c?.legs.length) return;
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this one?')) return;
    BT.emit('open-builder', {
      src: 'live',
      expiry: c.expiry,
      note: `Modified covered call paper trade · ${monthName(c.expiry)} series (options only; ${num0(P.etfOnce?.qty)} NIFTYBEES not in the Builder)`,
      legs: c.legs.map((l) => ({ action: l.side > 0 ? 'B' : 'S', type: l.type, strike: l.strike, expiry: c.expiry, lots: l.lots, px: l.entry })),
    });
  }
  async function paperAction(a) {
    if (a === 'builder') return toBuilder();
    const msg = $('mccPapMsg');
    try {
      if (a === 'reset' && !confirm('Delete the Modified covered call paper trade and its history?')) return;
      if (msg) msg.textContent = 'Working…';
      paper = await BT.api('/api/mcc/paper/' + a, a === 'start' ? { params } : a === 'reset' ? { confirm: true } : {});
      renderPaper();
    } catch (e) {
      if (msg) {
        msg.textContent = e.message;
        msg.classList.add('neg');
      }
    }
  }

  // ---------- Trades screen: the paper trade's months ----------
  // Listed from the moment it is started: the open series marked at the last check, then the finished months as
  // settled. NIFTYBEES held (at the budget), each structure's legs with entry → now / exit, and the P&L split.
  const STRATEGY = 'Modified covered call';
  async function renderMccTrades() {
    const el = $('mccTrades');
    if (!el) return;
    try {
      paper = await BT.api('/api/mcc/paper');
    } catch (e) {
      el.innerHTML = `<div class="panel-head"><h3>${STRATEGY} paper trade</h3></div><div class="err small pad">${esc(e.message)}</div>`;
      return;
    }
    const P = paper.paper;
    const head = `<div class="panel-head"><h3>${STRATEGY} paper trade <span class="muted small">${
      P
        ? `${P.status === 'running' ? 'running' : 'paused'} since ${dayLabel(new Date(P.startedAt).toISOString().slice(0, 10))} · ${sizeLabel(P.params)}${P.cycle?.markAt ? ` · marked ${new Date(P.cycle.markAt).toLocaleTimeString('en-IN')}${paper.marketOpen ? '' : ' (market closed: last traded prices)'}` : ''}`
        : 'none'
    }</span></h3>
        <span class="spacer"></span>${P ? '<button class="btn-sm ghost danger" data-mct="delete" title="Delete this paper trade and its history (the same as Reset in Trading Ideas)">✕ Delete</button>' : ''}<button class="btn-sm ghost" data-mct="open" title="Open the paper trade in Trading Ideas">Open in Trading Ideas ▸</button></div>`;
    if (!P) {
      el.innerHTML = head + '<div class="muted small pad">Start one in <b>Trading Ideas › Covered call › Modified covered call › Paper trade</b>; it is listed here at once, month by month, with its strikes and P&amp;L.</div>';
      bindMccTrades(el);
      return;
    }
    const lot = P.params.lotSize;
    // a leg: open (entry → LTP now) or closed (entry → exit, its P&L as booked)
    const legHtml = (l, open) => {
      const now = open ? l.ltp : l.exit;
      const pnl = open ? (now == null ? null : (now - l.entry) * l.side * l.lots * lot) : l.pnl;
      return `<div class="cc-leg"><b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sold' : 'Bought'}</b> ${l.lots}× ${l.strike} ${l.type} <span class="mono">${l.entry.toFixed(1)} → ${now == null ? '—' : now.toFixed(1)}${open ? ' now' : ''}</span>${pnl == null ? '' : ` <span class="${cls(pnl)}">${inrS(pnl)}</span>`}</div>`;
    };
    const legsCell = (open, closed, t) => {
      const o = open.filter((l) => l.type === t).map((l) => legHtml(l, true));
      const c = closed.filter((l) => l.type === t).map((l) => legHtml(l, false));
      return o.join('') + (c.length ? `${o.length ? '<div class="muted small">closed by rolls</div>' : ''}${c.join('')}` : '') || '<span class="muted">—</span>';
    };
    const money = (v, b) => `<td class="${cls(v)}${b ? ' b' : ''}">${v == null ? '—' : inrS(v)}</td>`;
    const rows = [];
    const c = P.cycle;
    if (c) {
      const total = (c.opt ?? 0) + (c.etfOnce ?? 0);
      rows.push(`<tr><td class="l"><b>${STRATEGY}</b></td><td class="l"><b>${monthName(c.expiry)}</b><div class="muted small">to ${dayLabel(c.expiry)}</div></td>
        <td class="l"><span class="cat-pill c-bullish">open</span></td><td class="muted">${dayLabel(c.entry.day)} ${c.entry.time}<div>Nifty ${num0(c.spot0)}${c.spot ? ' → ' + num0(c.spot) : ''}</div></td>
        <td class="l cc-legs"><div class="cc-leg"><b class="pos">Held</b> ${num0(P.etfOnce?.qty)} units <span class="mono">₹${c.etf.onceFrom.toFixed(2)} → ${c.bees ? '₹' + c.bees.toFixed(2) + ' now' : '—'}</span></div></td>
        <td class="l cc-legs">${legsCell(c.legs, c.closed, 'CE')}</td><td class="l cc-legs">${legsCell(c.legs, c.closed, 'PE')}</td>
        ${money(c.callPnl)}${money(c.putPnl)}${money(c.opt)}${money(c.etfOnce)}${money(c.opt == null ? null : total, true)}
        <td><button class="btn-sm ghost" data-mct="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices">▶ Open in Builder</button></td></tr>`);
    }
    for (const m of [...(P.months || [])].reverse()) {
      const held = m.closed.filter((x) => x.exitAt?.day === m.expiry && x.exitAt?.time === '15:30');
      const rolled = m.closed.filter((x) => !held.includes(x));
      rows.push(`<tr><td class="l"><b>${STRATEGY}</b></td><td class="l"><b>${monthName(m.expiry)}</b><div class="muted small">to ${dayLabel(m.expiry)}</div></td>
        <td class="l"><span class="cat-pill">closed</span></td><td class="muted">${m.entry ? dayLabel(m.entry.day) : ''}<div>Nifty ${num0(m.spot0)} → ${num0(m.spotE)}</div></td>
        <td class="l cc-legs"><div class="cc-leg"><b class="pos">Held</b> NIFTYBEES</div></td>
        <td class="l cc-legs">${legsCell([], [...held, ...rolled], 'CE')}</td><td class="l cc-legs">${legsCell([], [...held, ...rolled], 'PE')}</td>
        ${money(m.callPnl)}${money(m.putPnl)}${money(m.opt)}${money(m.etfOnce)}${money(m.withOnce, true)}<td></td></tr>`);
    }
    const sum = (k) => (P.months || []).reduce((n, m) => n + (m[k] || 0), 0);
    const all = { opt: sum('opt') + (c?.opt || 0), etf: sum('etfOnce') + (c?.etfOnce || 0) };
    el.innerHTML =
      head +
      `<div class="tbl-wrap sb-trades-wrap"><table class="grid-tbl sb-trades-tbl cc-trades-tbl"><thead><tr><th class="l">Strategy</th><th class="l">Month</th><th class="l">Status</th><th>Entered</th>
        <th class="l">NIFTYBEES<br><span class="muted">units · price at the series start → now</span></th><th class="l">Call ratio spread<br><span class="muted">lots × strike · entry → now / exit</span></th><th class="l">Put 2-3-1 butterfly</th>
        <th>Call ratio</th><th>Butterfly</th><th>Options</th><th>NIFTYBEES</th><th>Total</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="13" class="muted l">No series open yet: the next one opens at 09:30 on the next trading day.</td></tr>'}</tbody></table></div>
      <div class="muted small pad">Whole paper trade: total <b class="${cls(all.opt + all.etf)}">${inrS(all.opt + all.etf)}</b> · options ${inrS(all.opt)} · NIFTYBEES held ${inrS(all.etf)}. P&amp;L after costs; the open series at the last traded prices. Paper only: nothing is sent.</div>`;
    bindMccTrades(el);
  }
  function bindMccTrades(el) {
    el.querySelector('[data-mct="open"]')?.addEventListener('click', () => {
      idea = 'mcc';
      tab = 'paper';
      BT.store.set('cc-idea', idea);
      BT.store.set('mcc-tab', tab);
      window.app.setView('cc');
      if (started && params) render(); // else init() draws it once the settings are loaded
    });
    el.querySelector('[data-mct="delete"]')?.addEventListener('click', async () => {
      if (!confirm(`Delete the ${STRATEGY} paper trade and its history?`)) return;
      try {
        paper = await BT.api('/api/mcc/paper/reset', { confirm: true });
      } catch (e) {
        alert('Could not delete: ' + e.message);
      }
      renderMccTrades();
    });
    el.querySelector('[data-mct="builder"]')?.addEventListener('click', toBuilder);
  }

  function poll() {
    clearTimeout(pollT);
    if (tab !== 'paper' || idea !== 'mcc' || window.app?.state.view !== 'cc' || !started) return;
    pollT = setTimeout(async () => {
      if (!document.hidden && tab === 'paper' && idea === 'mcc' && window.app?.state.view === 'cc' && document.activeElement?.id !== 'mccBudget') {
        await loadPaper();
        renderPaper();
      }
      poll();
    }, 15_000);
  }

  let trT = null;
  function pollTrades() {
    clearTimeout(trT);
    if (window.app?.state.view !== 'tr') return;
    trT = setTimeout(async () => {
      if (!document.hidden && window.app?.state.view === 'tr') await renderMccTrades();
      pollTrades();
    }, 30_000);
  }
  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'cc') applyIdea();
    else poll();
    if (e.detail === 'tr') renderMccTrades().then(pollTrades);
  });
  if (window.app?.state.view === 'cc') applyIdea();
  if (window.app?.state.view === 'tr') renderMccTrades().then(pollTrades);
})();
