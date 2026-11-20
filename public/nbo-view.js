// Trading Ideas › NIFTYBEES + options: NIFTYBEES worth one lot (or a ₹ budget) plus any options structure the user
// builds, legs placed in points from the ATM on every monthly series, with generic rolls (bt/nbo.js on the Covered
// call's runner). Tabs: Strategy (the legs, presets, payoff at expiry), Backtest (shown like the Put spread collar's:
// with and without adjustments, month by month, every adjustment, the study), Compare (this strategy against the
// Covered call, Put spread collar and Bull put collar on the same months, NIFTYBEES and costs), Paper trade and Live
// trade, as the Put spread collar has them. Nothing here sends orders.
(() => {
  const { $, esc, inr, inrS, kinr, pct, cls, dayLabel } = BT;
  const VIEW = 'nbo';
  const NAME = 'NIFTYBEES + options';
  const TABS = [
    ['rules', 'Strategy'],
    ['bt', 'Backtest'],
    ['cmp', 'Compare'],
    ['paper', 'Paper trade'],
    ['live', 'Live trade'],
  ];
  const KIND = {
    entry: 'Entry',
    rollPut: 'Puts up',
    rollPutDn: 'Puts down',
    rollCall: 'Calls down',
    rollCallUp: 'Calls up',
    expiry: 'Expiry',
    skip: 'Not done',
  };
  const REC = { base: 'none', user: 'move2' }; // study rows: the baseline and the default settings
  let meta = null;
  let params = null;
  let tab = BT.store.get('nbo-tab', 'rules');
  if (!TABS.some(([id]) => id === tab)) tab = 'rules';
  let saved = { backtest: null, study: null, compare: null }; // as shown: raw rescaled to the NIFTYBEES budget (rebudgetAll)
  let raw = { backtest: null, study: null, compare: null }; // as the server ran them
  let started = false;
  let job = null;
  let openMonth = null;
  let viewing = null; // a study rule opened on the Backtest tab: { id, label, B, raw } (its full backtest, not saved)
  let lastDone = '';
  let cmpDone = '';
  let paper = null;
  let pollT = null;

  const num0 = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const legLine = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`;
  const body = () => $('nboBody');

  // ---------- NIFTYBEES budget (every tab), as on the Covered call ----------
  const unitsFor = (p, S) => Math.round((p.budget > 0 ? p.budget : p.lotSize * p.lots * S) / (S / 100)); // NIFTYBEES = Nifty ÷ 100
  const sizeLabel = (p) => (p?.budget > 0 ? `NIFTYBEES budget ${inr(p.budget)}` : 'NIFTYBEES of one lot (65 × Nifty)');
  function parseBudget(v) {
    const t = String(v ?? '')
      .toLowerCase()
      .replace(/[₹,\s]/g, '');
    if (!t) return 0;
    const m = t.match(/^(\d*\.?\d+)(l|lakh|lakhs|lac|cr|crore|k)?$/);
    if (!m) return NaN;
    return Math.round(Number(m[1]) * ({ l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, cr: 1e7, crore: 1e7, k: 1e3 }[m[2]] || 1));
  }
  function budgetRow(value, S, note = '') {
    const lot = params.lotSize;
    const one = lot * params.lots * S;
    const units = unitsFor({ ...params, budget: value }, S);
    return `<div class="set-row mcc-budget" title="₹ of NIFTYBEES bought at each entry, instead of one lot's worth (${lot} × Nifty). Only the NIFTYBEES quantity and its P&amp;L change: the options stay at their lots. Accepts 1560000, 15,60,000 or 15.6 L."><b>NIFTYBEES budget</b><span class="lbl">₹</span><input class="txt num" id="nboBudget" value="${value > 0 ? value : ''}" placeholder="${Math.round(one)}" style="width:100px">
      <span class="muted small" id="nboBudgetNote">${value > 0 ? `= ${num0(units)} units at Nifty ${num0(S)} (₹${(S / 100).toFixed(2)} each), ${(value / one).toFixed(2)} × one lot's worth (${inr(Math.round(one))}).` : `Empty: one lot's worth, ${lot} × Nifty = ${inr(Math.round(one))} (${num0(units)} units) at Nifty ${num0(S)}.`} The options are not changed. ${note}</span></div>`;
  }
  function useBudget(v) {
    params.budget = v;
    BT.store.set('nbo-params', params);
    rebudgetAll();
    drawBees();
  }
  // Saved results at another budget: the options do not depend on it, the NIFTYBEES P&L is in proportion to the units.
  const worth = (p, budget, S0) => (budget > 0 ? budget : S0 > 0 ? p.lotSize * p.lots * S0 : null);
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
      const kMon = worth(p, budget, S0) / worth(p, from, S0) || kOnce;
      const etfOnce = Math.round((m.etfOnce ?? m.withOnce - m.opt) * kOnce);
      const etfMonthly = Math.round((m.etfMonthly ?? m.withMonthly - m.opt) * kMon);
      const out = { ...m, etfOnce, etfMonthly, withOnce: m.opt + etfOnce, withMonthly: m.opt + etfMonthly };
      if (m.etf) out.etf = { ...m.etf, qtyOnce: Math.round(m.etf.qtyOnce * kOnce), qtyMonthly: Math.round(m.etf.qtyMonthly * kMon) };
      return out;
    });
    return { ...r, params: { ...p, budget: budget || 0 }, months, summary: summarizeAt(months, r.summary, budget > 0 ? budget : worth(p, 0, S1)) };
  }
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
      return {
        n: ms.length,
        opt: sum('opt'),
        call: sum('callPnl'),
        put: sum('putPnl'),
        withOnce: sum('withOnce'),
        withMonthly: sum('withMonthly'),
        hold: sum('etfOnce'),
      };
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
  function spotFinder() {
    const bt = new Map((raw.backtest?.withAdj?.months || []).map((m) => [m.expiry, m.spot0]));
    return (m) => m?.spot0 ?? bt.get(m?.expiry) ?? null;
  }
  function rebudgetAll() {
    const b = params.budget || 0;
    const at = spotFinder();
    const B = (x) => x && { ...x, withAdj: rebudget(x.withAdj, b, at), without: rebudget(x.without, b, at) };
    saved = {
      backtest: B(raw.backtest),
      study: raw.study && { ...raw.study, rows: raw.study.rows.map((r) => rebudget(r, b, at)) },
      compare: raw.compare && { ...raw.compare, rows: raw.compare.rows.map((r) => (r.summary?.months ? rebudget(r, b, at) : r)) },
    };
    if (viewing) viewing.B = B(viewing.raw);
  }
  function bindBudget(onSet) {
    const el = $('nboBudget');
    if (!el) return;
    el.onchange = () => {
      const v = parseBudget(el.value);
      if (!(v >= 0)) {
        $('nboBudgetNote').innerHTML = '<span class="neg">Type a ₹ amount, e.g. 1560000 or 15.6 L (empty = one lot\'s worth).</span>';
        return;
      }
      onSet(v);
    };
  }
  // Legs under their side: the call legs, then the put legs.
  const GROUP_NAME = { CE: 'Call legs', PE: 'Put legs' };
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

  // ---------- the screen opened ----------
  async function init() {
    if (started) return;
    started = true;
    try {
      meta = await BT.api('/api/nbo/meta');
    } catch (e) {
      body().innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      started = false;
      return;
    }
    const stored = BT.store.get('nbo-params', {});
    params = { ...deep(meta.defaults), ...stored };
    for (const k of ['adj', 'costs']) params[k] = { ...meta.defaults[k], ...(stored[k] || {}) };
    params.legs = Array.isArray(stored.legs) ? stored.legs : deep(meta.defaults.legs);
    params.lotSize = meta.lot;
    const get = (k) => BT.api('/api/nbo/' + k).catch(() => ({}));
    const [b, s, c] = await Promise.all([get('backtest'), get('study'), get('compare')]);
    raw = { backtest: b.saved || null, study: s.saved || null, compare: c.saved || null };
    rebudgetAll();
    render();
  }
  function render() {
    $('nboTabs').innerHTML = TABS.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('');
    if (tab === 'rules') renderRules();
    else if (tab === 'bt') renderBacktest();
    else if (tab === 'live') live.render(body());
    else if (tab === 'paper') renderPaper();
    else renderCompare();
    poll();
    drawBees();
  }
  const saveParams = () => {
    BT.store.set('nbo-params', params);
    drawBees();
  };

  // NIFTYBEES to buy for a new trade (public/bees-need.js), under the tab bar on every tab but Live trade (as on the Put
  // spread collar): the Strategy tab budget and lots, at Nifty and NIFTYBEES now (as Enter new trade sizes them). The Live
  // trade tab shows its own (with no trade: large, and Enter new trade takes the same units and price to the Builder).
  // Refreshed every 30 s.
  let beesT = null;
  async function drawBees() {
    clearTimeout(beesT);
    const el = $('nboBees');
    if (!el || !params) return;
    if (tab === 'live' || window.app?.state.view !== VIEW) {
      el.innerHTML = '';
      return;
    }
    await window.BeesNeed?.fill(el, {
      budget: params.budget,
      lots: params.lots,
      title: `NIFTYBEES to buy for a new ${NAME}`,
      note: params.budget > 0 ? 'set on the Strategy tab (NIFTYBEES budget)' : 'a NIFTYBEES budget on the Strategy tab changes it',
    });
    beesT = setTimeout(drawBees, 30_000);
  }
  // The Live trade tab: the collars' (mcclive-view.js makeCcLive) on /api/nbo/live*: a Builder trade marked as this
  // strategy, with its NIFTYBEES, on the live chain. "Enter new trade" builds the Strategy tab's legs on the live chain.
  const live = window.makeCcLive({
    view: VIEW,
    tabs: 'nboTabs',
    api: '/api/nbo',
    storeKey: 'nbolive-key',
    name: NAME,
    names: { CE: 'Call legs', PE: 'Put legs', ce: 'Call legs', pe: 'Put legs' },
    get shapeText() {
      return params ? structureText(params) : 'your legs from the Strategy tab';
    },
    shapeShort: 'NIFTYBEES + options trade',
    flag: { kind: 'nbo' },
    adjust: true, // Legs and payoff › Adjustments (loss-less changes), as on the Put spread collar
    guide: true, // 🧭 the guided new trade: expiry → NIFTYBEES → strikes (💡 Suggestion) → Builder
    planBody: () => ({ params: params && { lots: params.lots, legs: params.legs, budget: params.budget } }),
  });
  const stratName = () => BT.store.get('nbo-name', '') || 'Your strategy';
  const goTab = (t) => {
    tab = t;
    BT.store.set('nbo-tab', tab);
    render();
    window.scrollTo({ top: 0 });
  };

  body().addEventListener('click', (e) => {
    const rule = e.target.closest('tr[data-rule]')?.dataset.rule;
    if (rule) return openRule(rule);
    const m = e.target.closest('tr[data-adj-m]')?.dataset.adjM;
    if (m) {
      openMonth = m;
      renderResults();
      body().querySelector(`#nboRes tr[data-m="${m}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
  async function openRule(id) {
    const row = saved.study?.rows?.find((r) => r.id === id);
    if (!row || job) return;
    if (tab !== 'bt') {
      tab = 'bt';
      BT.store.set('nbo-tab', tab);
      render();
    }
    const ok = row.months.filter((m) => m.ok);
    const range = { from: ok[0]?.expiry, to: ok[ok.length - 1]?.expiry };
    lastDone = '';
    try {
      job = { kind: 'run', progress: null };
      showProgress({ phase: 'Opening ' + row.label, done: 0, total: 0 });
      const r = await BT.api('/api/nbo/run', { params: row.params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(300);
        const j = await BT.api('/api/nbo/job?id=' + job.id);
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
      if ($('nboRes')) $('nboRes').innerHTML = `<div class="panel empty err">Could not open the rule: ${esc(err.message)}</div>`;
      return;
    }
    job = null;
    openMonth = null;
    if (tab === 'bt') {
      renderBacktest();
      $('nboRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  $('nboTabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t || t === tab) return;
    tab = t;
    BT.store.set('nbo-tab', tab);
    render();
  });

  // ---------- payoff ----------
  const optAt = (legs, x, lot) => legs.reduce((s, l) => s + l.side * (Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x) - l.entry) * l.lots * lot, 0);
  const STRUCT = [
    ['CE', 'Call legs', '#d6af4c'],
    ['PE', 'Put legs', '#3fb68b'],
  ];
  const of = (legs, t) => legs.filter((l) => l.type === t);
  function payoffChart(canvas, legs, lot, spot, etf, extraNote) {
    const home = [Math.floor((spot * 0.9) / 50) * 50, Math.ceil((spot * 1.1) / 50) * 50];
    const lo = Math.floor((spot * 0.7) / 50) * 50;
    const hi = Math.ceil((spot * 1.3) / 50) * 50;
    const xs = [];
    for (let x = lo; x <= hi; x += 25) xs.push(x);
    const opt = xs.map((x) => ({ x, y: Math.round(optAt(legs, x, lot)) }));
    const sets = [{ label: 'Options only', data: opt, borderColor: '#b392f0', borderWidth: 2, pointRadius: 0 }];
    for (const [t, label, color] of STRUCT)
      if (legs.some((l) => l.type === t))
        sets.push({
          label,
          data: xs.map((x) => ({ x, y: Math.round(optAt(of(legs, t), x, lot)) })),
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
        { x: spot, y: y0 - (y1 - y0) },
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

  // ---------- Strategy: the legs, presets and the payoff at expiry ----------
  const offLabel = (off) => (off === 0 ? 'ATM' : off > 0 ? `ATM + ${off}` : `ATM − ${-off}`);
  const legRule = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} ${l.type} ${offLabel(l.off)}`;
  const structureText = (p) =>
    (p?.legs || [])
      .filter((l) => l.lots > 0)
      .map(legRule)
      .join(', ') || 'no option legs';
  const exState = () => {
    const last = raw.backtest?.withAdj?.months?.filter((m) => m.ok).slice(-1)[0];
    return { spot: last ? Math.round(last.spot0 / 50) * 50 : 24000, iv: 13, days: 28, ...BT.store.get('nbo-ex', {}) };
  };
  // The legs at Nifty S priced by Black-Scholes at iv % with `days` to expiry (the example month).
  function bsLegs(S, iv, days) {
    const A = Math.round(S / 50) * 50;
    const pr = (K, call) => Math.round(Math.max(0.05, BT.bs(S, K, days / 365, iv / 100, call)) * 10) / 10;
    return params.legs
      .map((l) => ({ ...l, strike: A + l.off, lots: l.lots * params.lots }))
      .filter((l) => l.lots > 0)
      .map((l) => ({ ...l, entry: pr(l.strike, l.type === 'CE') }));
  }
  // Risk notes: sold calls beyond the bought ones and the NIFTYBEES, sold puts beyond the bought ones.
  // ---------- What happens when Nifty moves (as on the Put spread collar) ----------
  const studyRow = (id) => saved.study?.rows?.find((r) => r.id === id) || null;
  // A position to move Nifty under: { id, label, spot, legs, units, b0 }: the example month (the Strategy tab's legs
  // at Black-Scholes prices), the paper trade's series, the backtest's last month as entered.
  function animSources() {
    const ex = exState();
    const out = [
      { id: 'ex', label: 'Example month', spot: ex.spot, legs: bsLegs(ex.spot, ex.iv, ex.days), units: unitsFor(params, ex.spot), b0: ex.spot / 100 },
    ];
    const c = paper?.paper?.cycle;
    if (c?.legs?.length)
      out.push({
        id: 'paper',
        label: 'Your paper month',
        spot: c.spot0,
        legs: c.legs,
        units: paper.paper.etfOnce?.qty || out[0].units,
        b0: c.etf?.b0 || c.spot0 / 100,
      });
    const m = saved.backtest?.withAdj?.months?.filter((x) => x.ok).slice(-1)[0];
    if (m)
      out.push({
        id: 'bt',
        label: `Backtest: ${monthName(m.expiry)} as entered`,
        spot: m.spot0,
        legs: m.entry.legs,
        units: m.etf?.qtyOnce || out[0].units,
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
  // Which legs end in the money at x, and what each side and NIFTYBEES make there.
  function zoneText(src, x) {
    const v = parts(src, x);
    const f = (n) => `<b class="${cls(n)}">${inrS(n)}</b>`;
    const itm = src.legs.filter((l) => (l.type === 'CE' ? x > l.strike : x < l.strike));
    const txt = (l) => `${l.side > 0 ? 'bought' : 'sold'} ${l.strike} ${l.type}`;
    const where = itm.length ? `In the money: ${itm.map(txt).join(', ')}.` : 'No leg ends in the money: every option keeps or loses its premium.';
    const sold = src.legs.filter((l) => l.type === 'CE').reduce((s, l) => s - l.side * l.lots, 0);
    const cap = sold > 0 && itm.some((l) => l.type === 'CE' && l.side < 0) ? ' Above the sold calls they give back what NIFTYBEES gain.' : '';
    return `${where}${cap} Call legs ${f(v.call)}, put legs ${f(v.put)}, NIFTYBEES ${f(v.etf)}: total ${f(v.total)}.`;
  }
  function riskNotes(S) {
    const net = (t) => params.legs.filter((l) => l.type === t).reduce((s, l) => s - l.side * l.lots * params.lots, 0); // sold − bought
    const cover = params.budget > 0 ? params.budget / (params.lotSize * S) : params.lots;
    const out = [];
    const c = net('CE');
    const p = net('PE');
    if (c > cover + 0.01)
      out.push(
        `<span class="neg">${c} net sold call lot${c === 1 ? '' : 's'} against NIFTYBEES worth ${cover.toFixed(2)} lot${cover === 1 ? '' : 's'}: above the calls, the loss grows without a cap.</span>`,
      );
    else if (c > 0)
      out.push(
        `${c} net sold call lot${c === 1 ? '' : 's'}, covered by the NIFTYBEES (${cover.toFixed(2)} lots' worth): above the sold strike the gains stop.`,
      );
    if (p > 0)
      out.push(
        `<span class="neg">${p} net sold put lot${p === 1 ? '' : 's'} (more sold than bought): in a fall the loss adds to the NIFTYBEES' with no floor.</span>`,
      );
    if (!params.legs.some((l) => l.lots > 0)) out.push('<span class="neg">No option leg with lots: add one.</span>');
    return out;
  }
  function renderRules() {
    const ex = exState();
    const legs = bsLegs(ex.spot, ex.iv, ex.days);
    const A = Math.round(ex.spot / 50) * 50;
    const max = meta.maxLegs || 8;
    const presetOpts = meta.presets.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    const legRows = params.legs
      .map((l, i) => {
        const priced = legs.find((x) => x.strike === A + l.off && x.type === l.type && x.side === l.side);
        return `<tr data-leg="${i}">
          <td>${i + 1}</td>
          <td><select data-f="side"><option value="1"${l.side > 0 ? ' selected' : ''}>Buy</option><option value="-1"${l.side < 0 ? ' selected' : ''}>Sell</option></select></td>
          <td><input class="txt num" data-f="lots" value="${l.lots}" style="width:44px"></td>
          <td><select data-f="type"><option${l.type === 'CE' ? ' selected' : ''}>CE</option><option${l.type === 'PE' ? ' selected' : ''}>PE</option></select></td>
          <td><span class="lbl">ATM</span> <input class="txt num" data-f="off" value="${l.off}" style="width:64px" title="Points from the ATM strike: + above, − under (multiples of 50)"></td>
          <td>${A + l.off}</td>
          <td>${priced ? priced.entry.toFixed(1) : '—'}</td>
          <td><button class="btn-sm ghost" data-del="${i}" title="Remove this leg">✕</button></td></tr>`;
      })
      .join('');
    const lot = params.lotSize;
    const etf = { qty: unitsFor(params, ex.spot), b0: ex.spot / 100, s0: ex.spot };
    const cash = legs.reduce((s, l) => s - l.side * l.entry * l.lots * lot, 0);
    const notes = riskNotes(ex.spot);
    const name = BT.store.get('nbo-name', '');
    const mm = BT.store.get('nbo-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
    body().innerHTML = `
      <div class="panel cc-doc">
        <h3>Your strategy: NIFTYBEES + options</h3>
        <p class="small">NIFTYBEES held all the time, plus the option legs below opened on the first trading day of every monthly series (09:30) and held to the monthly expiry.
        Each leg is placed in points from the ATM at that entry (+ above, − under), so the same structure is rebuilt every month. The Backtest tab shows it like the Put spread collar; Compare runs it next to the Covered call and both collars.</p>
        <div class="set-row"><b>Name</b><input class="txt" id="nboName" value="${esc(name)}" placeholder="Your strategy" style="width:220px"><span class="muted small">used on the Compare tab</span></div>
        <div class="set-row"><b>Start from</b><select id="nboPreset"><option value="">— pick a structure —</option>${presetOpts}</select><span class="muted small">replaces the legs below (you can change every leg after)</span></div>
        <div class="tbl-wrap"><table class="grid-tbl nbo-legs"><thead><tr><th>#</th><th>Buy / sell</th><th>Lots</th><th>Type</th><th>Strike from ATM (pts)</th><th>Strike at Nifty ${num0(ex.spot)}</th><th>Premium (model)</th><th></th></tr></thead>
          <tbody>${legRows || '<tr><td colspan="8" class="muted">No legs: add one.</td></tr>'}</tbody></table></div>
        <div class="set-row"><button class="btn-sm" id="nboAdd"${params.legs.length >= max ? ' disabled' : ''}>＋ Add leg</button>
          <span class="lbl">all lots ×</span><input class="txt num" id="nboLots" value="${params.lots}" style="width:40px" title="Multiplier on every leg's lots">
          <span class="muted small">Up to ${max} legs. Lot = ${lot}. Strikes snap to the listed strikes in the backtest.</span></div>
        ${budgetRow(params.budget, ex.spot)}
        <div class="small" style="margin-top:6px">${structureText(params)}${notes.length ? '<br>' + notes.join('<br>') : ''}</div>
      </div>
      <div class="panel cc-doc">
        <h3>Payoff at expiry (example month)</h3>
        <div class="set-row"><b>Example</b><span class="lbl">Nifty</span><input class="txt num" id="nboExS" value="${ex.spot}" style="width:70px">
          <span class="lbl">IV %</span><input class="txt num" id="nboExIv" value="${ex.iv}" style="width:44px">
          <span class="lbl">days to expiry</span><input class="txt num" id="nboExD" value="${ex.days}" style="width:44px">
          <span class="muted small">premiums by Black-Scholes at that IV (a model, not the chain): net ${cash >= 0 ? 'credit' : 'debit'} <b class="${cls(cash)}">${inrS(Math.round(cash))}</b> before costs</span></div>
        <div class="cc-pay-chart"><canvas id="nboPay"></canvas></div>
        ${scenarioTable(legs, ex.spot, etf)}
      </div>

      <div class="panel cc-doc">
        <h3>What happens when Nifty moves</h3>
        <h4>One expiry: Nifty from −25 % to +25 %</h4>
        <p class="muted small">Press ▶ Play (or drag the slider, or the ▲ / ▼ buttons) to move Nifty up and down: the P&L at expiry of NIFTYBEES, the call legs and the put legs, the options together and the total with NIFTYBEES.</p>
        <div class="set-row mcc-anim-ctl">
          <span class="seg sm" id="nboAnSrc"></span>
          <button class="btn-sm ghost" id="nboAnPlay">▶ Play</button>
          ${[-20, -10, -5].map((x) => `<button class="btn-sm ghost" data-nmv="${x}">▼ ${-x} %</button>`).join('')}<button class="btn-sm ghost" data-nmv="0">Back to entry</button>${[5, 10, 20].map((x) => `<button class="btn-sm ghost" data-nmv="${x}">▲ ${x} %</button>`).join('')}
          <span class="lbl">Nifty move</span><input type="range" id="nboAnRange" min="-25" max="25" step="0.5" value="0" style="width:200px">
          <b id="nboAnLbl"></b>
        </div>
        <div class="muted small" id="nboAnPos"></div>
        <div class="cc-ex-grid" style="margin-top:8px">
          <div><div class="mcc-bars" id="nboAnBars"></div><p class="small" id="nboAnZone" style="margin-top:8px"></p></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="nboAnPay"></canvas></div></div>
        </div>

        <h4 style="margin-top:14px">Month by month: the strategy entered again every month</h4>
        <div class="set-row">
          <span class="seg sm" id="nboMmMode"><button data-m="model" class="${mm.mode === 'model' ? 'on' : ''}">Model path</button><button data-m="real" class="${mm.mode === 'real' ? 'on' : ''}">Real months (backtest)</button></span>
          <span class="nbo-mm-model${mm.mode === 'model' ? '' : ' hidden'}">
            <span class="lbl">Nifty over the period</span><input class="txt num" id="nboMmPct" value="${mm.pct}" style="width:50px"><span class="lbl">% over</span>
            <select id="nboMmN">${[3, 6, 12, 24].map((n) => `<option value="${n}"${n === mm.months ? ' selected' : ''}>${n} months</option>`).join('')}</select>
            <span class="lbl">IV %</span><input class="txt num" id="nboMmIv" value="${mm.iv}" style="width:45px">
            <label class="lbl"><input type="checkbox" id="nboMmSw"${mm.swings ? ' checked' : ''}> weekly swings</label>
          </span>
          <button class="btn-sm ghost" id="nboMmPlay">▶ Play the months</button>
          <span class="lbl">Month</span><input type="range" id="nboMmIdx" min="0" max="0" value="0" style="width:180px">
        </div>
        <p class="muted small" id="nboMmNote"></p>
        <div class="cc-ex-grid">
          <div><div class="mcc-bars" id="nboMmBars"></div><div class="small" id="nboMmText" style="margin-top:8px"></div></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="nboMmChart"></canvas></div></div>
        </div>
      </div>

      <div class="panel cc-doc">
        <h3>When Nifty rises: what you can do</h3>
        ${risesHtml()}
      </div>

      <div class="panel cc-doc">
        <h3>When Nifty falls: what you can do</h3>
        ${fallsHtml()}
      </div>
      <div class="panel cc-doc">
        <h3>Adjustments</h3>
        <p class="small">${adjText(params)}</p>
        <p class="muted small">A side's legs (all calls together, all puts together) are closed and opened again at their own distances from the new ATM. The collars' rules are the default: calls follow a fall, puts follow a rise, at a 2 % move. Change them on the Backtest tab; the adjustment study there tries the alternatives.</p>
        <div class="set-row"><button class="btn-sm run" id="nboGoBt">Backtest this ▸</button><button class="btn-sm ghost" id="nboGoCmp">Compare with the Covered call and collars ▸</button></div>
      </div>
      <div class="panel cc-doc">
        <h3>When to adjust: what the backtest says</h3>
        ${studyLegsNote()}
        <table class="grid-tbl cc-rules"><tbody>
          <tr><th>When to adjust (suggested)</th><td>${rulesWhen()}</td></tr>
          <tr><th>Best rule in the study</th><td>${(() => {
            const r0 = studyRow('none');
            const rA = saved.study ? [...saved.study.rows].sort((x, y) => y.summary.opt.total - x.summary.opt.total)[0] : null;
            return rA && r0
              ? `<b>${esc(rA.label)}</b>: ${inrS(rA.summary.opt.total)} on the options vs ${inrS(r0.summary.opt.total)} with no adjustments (${inrS(rA.summary.opt.total - r0.summary.opt.total)}), ${rA.summary.adjustments} rolls; worst month ${inr(rA.summary.opt.worst)} vs ${inr(r0.summary.opt.worst)}, drawdown with NIFTYBEES held ${inr(rA.summary.withOnce.maxDD)} vs ${inr(r0.summary.withOnce.maxDD)}. Click it in the study below to open its full backtest.`
              : 'Run the study on the Backtest tab.';
          })()}</td></tr>
        </tbody></table>
        ${saved.study ? studyTable(saved.study, true) : '<p class="muted">The study has not been run yet. Run it on the Backtest tab ("Run adjustment study").</p>'}
      </div>`;
    const etfPay = legs.length ? etf : null;
    payoffChart($('nboPay'), legs, lot, ex.spot, etfPay);
    bindRules();
    bindAnim();
    bindMm();
  }
  function bindRules() {
    const re = () => {
      saveParams();
      renderRules();
    };
    body()
      .querySelectorAll('tr[data-leg] [data-f]')
      .forEach((el) =>
        el.addEventListener('change', () => {
          const i = Number(el.closest('tr').dataset.leg);
          const f = el.dataset.f;
          const v = f === 'type' ? el.value : Number(el.value);
          if (f !== 'type' && !Number.isFinite(v)) return re();
          params.legs[i] = { ...params.legs[i], [f]: f === 'off' ? Math.round(v / 50) * 50 : f === 'lots' ? Math.max(0, Math.min(20, Math.round(v))) : v };
          re();
        }),
      );
    body()
      .querySelectorAll('[data-del]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          params.legs.splice(Number(b.dataset.del), 1);
          re();
        }),
      );
    $('nboAdd').onclick = () => {
      const last = params.legs[params.legs.length - 1];
      params.legs.push(last ? { ...last, off: last.off + (last.off >= 0 ? 100 : -100) } : { type: 'CE', side: -1, off: 100, lots: 1 });
      re();
    };
    $('nboLots').onchange = () => {
      const v = Math.round(Number($('nboLots').value));
      if (v >= 1 && v <= 20) params.lots = v;
      re();
    };
    $('nboPreset').onchange = () => {
      const pr = meta.presets.find((x) => x.id === $('nboPreset').value);
      if (!pr) return;
      params.legs = deep(pr.legs);
      re();
    };
    $('nboName').onchange = () => BT.store.set('nbo-name', $('nboName').value.trim().slice(0, 40));
    const exSet = () => {
      const n = (id, lo, hi, d) => {
        const v = Number($(id).value);
        return Number.isFinite(v) && v >= lo && v <= hi ? v : d;
      };
      const ex = exState();
      BT.store.set('nbo-ex', { spot: n('nboExS', 5000, 100000, ex.spot), iv: n('nboExIv', 3, 80, ex.iv), days: n('nboExD', 1, 90, ex.days) });
      renderRules();
    };
    ['nboExS', 'nboExIv', 'nboExD'].forEach((id) => ($(id).onchange = exSet));
    bindBudget((v) => {
      useBudget(v);
      renderRules();
    });
    $('nboGoBt').onclick = () => goTab('bt');
    $('nboGoCmp').onclick = () => goTab('cmp');
  }
  // P&L at expiry for Nifty moves from the example's level: calls, puts, options, NIFTYBEES, total.
  function scenarioTable(legs, S, etf) {
    const lot = params.lotSize;
    const moves = [-10, -7, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7, 10];
    const rows = moves.map((mv) => {
      const x = Math.round(S * (1 + mv / 100));
      const c = optAt(of(legs, 'CE'), x, lot);
      const p = optAt(of(legs, 'PE'), x, lot);
      const e = etf.qty * etf.b0 * (x / etf.s0 - 1);
      return { mv, x, c, p, o: c + p, e, t: c + p + e };
    });
    const td = (n) => `<td class="${cls(n)}">${inrS(Math.round(n))}</td>`;
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Nifty at expiry</th><th>Move</th><th>Call legs</th><th>Put legs</th><th>Options</th><th>NIFTYBEES (${num0(etf.qty)})</th><th>Total</th></tr></thead><tbody>
      ${rows.map((r) => `<tr${r.mv === 0 ? ' class="on"' : ''}><td>${num0(r.x)}</td><td class="${cls(r.mv)}">${r.mv > 0 ? '+' : ''}${r.mv} %</td>${td(r.c)}${td(r.p)}${td(r.o)}${td(r.e)}<td class="${cls(r.t)}"><b>${inrS(Math.round(r.t))}</b></td></tr>`).join('')}
      </tbody></table></div><div class="muted small">Options at their model premiums, before slippage and charges; NIFTYBEES = Nifty ÷ 100 bought at the example level.</div>`;
  }
  // ----- When Nifty rises / falls: study variants side by side (rows open the rule's full backtest) -----
  const avgOf = (b, k = 'withOnce') => (b?.n ? b[k] / b.n : 0);
  function variantTable(list, hiCol) {
    const r0 = studyRow('none');
    const rows = list.map(([id, label]) => [studyRow(id), label]).filter(([r]) => r);
    const hold = (k) => inrS(avgOf(r0.summary.byMove[k], 'hold'));
    const th = (k, label) => `<th${hiCol === k ? ' class="cc-col-tot"' : ''}>${label}</th>`;
    const td = (k, v) => `<td class="${hiCol === k ? 'cc-col-tot ' : ''}${cls(v)}">${inrS(v)}</td>`;
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Variant</th><th>Whole period</th>${th('up', `Avg up month (hold ${hold('up')})`)}${th('flat', 'Avg flat month')}${th('down', `Avg down month (hold ${hold('down')})`)}<th>Call legs (period)</th><th>Put legs (period)</th><th>Worst month (options)</th><th>Max drawdown (with NIFTYBEES)</th></tr></thead>
      <tbody>${rows
        .map(([r, label]) => {
          const s = r.summary;
          return `<tr class="cc-click${r.id === 'none' ? ' on' : ''}" data-rule="${r.id}" title="Click: this rule's full backtest on the Backtest tab"><td class="l">${esc(label)}</td><td class="${cls(s.withOnce.total)}">${inrS(s.withOnce.total)}</td>${td('up', avgOf(s.byMove.up))}${td('flat', avgOf(s.byMove.flat))}${td('down', avgOf(s.byMove.down))}<td class="${cls(s.call?.total)}">${s.call ? inrS(s.call.total) : '—'}</td><td class="${cls(s.put?.total)}">${s.put ? inrS(s.put.total) : '—'}</td><td class="neg">${inr(s.opt.worst)}</td><td class="neg">${inr(s.withOnce.maxDD)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }
  const perMonth = (id, k) => {
    const r = studyRow(id);
    return r ? inrS(avgOf(r.summary.byMove[k])) : '—';
  };
  const period = (id) => {
    const r = studyRow(id);
    return r ? inrS(r.summary.withOnce.total) : '—';
  };
  // the study is run on the legs it was run with: say so when the Strategy tab's legs are different now
  const studyLegsNote = () => {
    const p = saved.study?.rows?.[0]?.params;
    return p && structureText(p) !== structureText(params)
      ? `<p class="small neg">The study was run on other legs (${esc(structureText(p))}); run it again on the Backtest tab for the legs above.</p>`
      : '';
  };
  function risesHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the adjustment study on the Backtest tab: this section is drawn from it.</p>';
    const up = r0.summary.byMove.up;
    return `${studyLegsNote()}<p>A rise is NIFTYBEES' month: sold calls above Nifty give back what NIFTYBEES gains over their strikes, bought puts expire worthless. In the backtest's ${up.n} months when Nifty rose more than 2 %, your strategy made <b>${inrS(avgOf(up))}</b> a month on average with NIFTYBEES held, while simply holding the same NIFTYBEES made <b>${inrS(avgOf(up, 'hold'))}</b>.
      What can be done about it, tested on the same ${r0.summary.months} months (${dayLabel(r0.summary.from)} – ${dayLabel(r0.summary.to)}, NIFTYBEES held, 0.5 % slippage):</p>
      ${variantTable(
        [
          ['none', 'No adjustments (the strategy as entered)'],
          [REC.user, 'The default rules: rolls at a 2 % move'],
          ['putsUp2', 'Only the puts follow a rise (2 %)'],
          ['callsBoth2', 'Calls follow Nifty both ways (2 %)'],
          ['all2', 'Every side follows Nifty both ways (2 %)'],
          ['noCalls', 'No call legs (NIFTYBEES + puts only)'],
        ],
        'up',
      )}
      <ul style="margin-top:8px">
        <li><b>Move the puts up</b> after a rise: the old ones are nearly worthless, the new ones sit near the money again (${perMonth('putsUp2', 'up')} per up month, ${period('putsUp2')} over the period).</li>
        <li><b>Let the calls follow a rise</b>: the sold calls are bought back and sold higher, so more of the rally is kept, at a loss each time (${perMonth('callsBoth2', 'up')} per up month, ${period('callsBoth2')} over the period).</li>
        <li><b>Without the call legs</b>: NIFTYBEES keep their whole rise (${perMonth('noCalls', 'up')} per up month, ${period('noCalls')} over the period). The difference to the first row is what the calls did.</li>
      </ul>
      <p class="muted small">One period of history, not a forecast: only ${up.n} rising months. Click a row for its full backtest; the direction switches are on the Backtest tab.</p>`;
  }
  function fallsHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the adjustment study on the Backtest tab: this section is drawn from it.</p>';
    const dn = r0.summary.byMove.down;
    return `${studyLegsNote()}<p>In a fall NIFTYBEES lose; bought puts under Nifty gain a point for every point below their strikes (sold puts under them give that back), sold calls keep their premium. In the backtest's ${dn.n} months when Nifty fell more than 2 %, your strategy made <b>${inrS(avgOf(dn))}</b> a month on average with NIFTYBEES held, against <b>${inrS(avgOf(dn, 'hold'))}</b> for NIFTYBEES alone.
      Ways to handle a fall, on the same months:</p>
      ${variantTable(
        [
          ['none', 'No adjustments (the strategy as entered)'],
          [REC.user, 'The default rules: rolls at a 2 % move'],
          ['callsDn2', 'Only the calls follow a fall (2 %)'],
          ['putsBoth2', 'Puts follow Nifty both ways (2 %)'],
          ['all2', 'Every side follows Nifty both ways (2 %)'],
          ['decay35', 'Roll a side at 35 % of its entry value'],
          ['noPuts', 'No put legs (NIFTYBEES + calls only)'],
        ],
        'down',
      )}
      <ul style="margin-top:8px">
        <li><b>Move the calls down</b> after a fall: more premium as Nifty falls (${perMonth('callsDn2', 'down')} per down month), but a rebound runs into the lower strikes (${perMonth('callsDn2', 'up')} per up month).</li>
        <li><b>Let the puts follow a fall</b>: books what they made and sets them up again lower (${perMonth('putsBoth2', 'down')} per down month, ${period('putsBoth2')} over the period).</li>
        <li><b>Without the put legs</b>: ${perMonth('noPuts', 'down')} per down month, ${period('noPuts')} over the period. The difference to the first row is what the puts did.</li>
      </ul>
      <p class="muted small">One period of history: ${dn.n} falling months. Click a row for its full backtest.</p>`;
  }
  // When to adjust: the study's rules for the checks and the trigger, as on the collar
  function rulesWhen() {
    const r0 = studyRow('none');
    if (!r0) return 'Run the adjustment study on the Backtest tab.';
    const vs = (id) => {
      const r = studyRow(id);
      return r ? inrS(r.summary.opt.total - r0.summary.opt.total) : '—';
    };
    const dd = (id) => {
      const r = studyRow(id);
      return r ? inr(r.summary.withOnce.maxDD) : '—';
    };
    return `<ul style="margin:0;padding-left:18px">
      <li><b>Check once a day, at 15:00.</b> Checking every hour gave ${vs('move2h')} vs no adjustments, once a day ${vs('move2')}.</li>
      <li><b>How far Nifty moves before a side is rolled</b>: 1 % ${vs('move1')}, 1.5 % ${vs('move15')}, 2 % ${vs('move2')}, 3 % ${vs('move3')} on the options vs no adjustments (drawdown with NIFTYBEES ${dd('move2')} at 2 % vs ${dd('none')} with none). A premium rule instead: roll a side at 35 % of its entry value ${vs('decay35')}, at 50 % ${vs('decay50')}.</li>
      <li><b>No rolls in the last 3 trading days</b>: rolling then too gave ${vs('move2l0')}; late rolls buy very little for the slippage.</li>
    </ul>
    <span class="muted small">The rolls move money between months more than they add any; their main effect is on the drawdown. One period of history, on the legs the study was run with.</span>`;
  }
  // bars: one row per part, centred on zero, scaled to the largest value the section can show
  function bars(el, rows, scale) {
    el.innerHTML = rows
      .map(([label, v, sub, strong]) => {
        const w = scale ? Math.min(50, (Math.abs(v) / scale) * 50) : 0;
        return `<div class="mcc-bar-row${strong ? ' strong' : ''}"><span>${label}</span><span class="mcc-bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></span><b class="${cls(v)}">${inrS(v)}</b>${sub ? `<span class="muted small mcc-bar-sub">${sub}</span>` : ''}</div>`;
      })
      .join('');
  }

  // ----- One expiry -----
  const anim = { src: BT.store.get('nbo-an-src', 'ex'), move: 0, timer: null, chart: null };
  function bindAnim() {
    clearInterval(anim.timer);
    anim.timer = null;
    anim.chart = null;
    const srcs = animSources();
    if (!srcs.find((s) => s.id === anim.src)) anim.src = 'ex';
    $('nboAnSrc').innerHTML = srcs.map((s) => `<button data-s="${s.id}" class="${s.id === anim.src ? 'on' : ''}">${esc(s.label)}</button>`).join('');
    $('nboAnSrc').onclick = (e) => {
      const id = e.target.closest('[data-s]')?.dataset.s;
      if (!id) return;
      anim.src = id;
      BT.store.set('nbo-an-src', id);
      bindAnim();
    };
    $('nboAnRange').oninput = (e) => {
      stopAnim();
      anim.move = Number(e.target.value);
      drawAnim(false);
    };
    body()
      .querySelectorAll('[data-nmv]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            stopAnim();
            anim.move = Number(b.dataset.nmv);
            drawAnim(false);
          }),
      );
    $('nboAnPlay').onclick = () => {
      if (anim.timer) return stopAnim();
      $('nboAnPlay').textContent = '❚❚ Pause';
      let dir = 1;
      anim.timer = setInterval(() => {
        if (!document.body.contains($('nboAnPlay'))) return stopAnim();
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
    if ($('nboAnPlay')) $('nboAnPlay').textContent = '▶ Play';
  }
  function drawAnim(full) {
    const src = animSources().find((s) => s.id === anim.src);
    const x = src.spot * (1 + anim.move / 100);
    $('nboAnRange').value = anim.move;
    $('nboAnLbl').textContent = `Nifty ${num0(x)} (${anim.move >= 0 ? '+' : ''}${anim.move.toFixed(1)} %) · NIFTYBEES ₹${((src.b0 * x) / src.spot).toFixed(2)}`;
    const leg = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} @${l.entry.toFixed(1)}`;
    $('nboAnPos').innerHTML =
      `Position: ${esc(src.label)} — Nifty ${num0(src.spot)}, ${num0(src.units)} NIFTYBEES at ₹${src.b0.toFixed(2)} · <b>call legs</b> ${of(src.legs, 'CE').map(leg).join(', ') || '—'} · <b>put legs</b> ${of(src.legs, 'PE').map(leg).join(', ') || '—'}. Everything at its expiry, before costs.`;
    const v = parts(src, x);
    let scale = 0;
    for (let m = -25; m <= 25; m += 1) {
      const q = parts(src, src.spot * (1 + m / 100));
      scale = Math.max(scale, ...Object.values(q).map(Math.abs));
    }
    bars(
      $('nboAnBars'),
      [
        ['NIFTYBEES', v.etf],
        ['Call legs', v.call],
        ['Put legs', v.put],
        ['Without NIFTYBEES (options)', v.opt, '', true],
        ['With NIFTYBEES (total)', v.total, '', true],
      ],
      scale,
    );
    $('nboAnZone').innerHTML = zoneText(src, x);
    if (full || !anim.chart) {
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
      anim.chart = BT.chart($('nboAnPay'), {
        type: 'line',
        data: {
          datasets: [
            line('With NIFTYBEES', (q) => q.total, '#58a6ff'),
            line('Without NIFTYBEES (options)', (q) => q.opt, '#b392f0'),
            line('Call legs', (q) => q.call, '#d6af4c', { borderWidth: 1.5, borderDash: [5, 3] }),
            line('Put legs', (q) => q.put, '#3fb68b', { borderWidth: 1.5, borderDash: [5, 3] }),
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
  const mmState = { rows: [], idx: 0, timer: null, seq: 0 };
  const mmOpts = () => BT.store.get('nbo-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
  function bindMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    const save = () => {
      BT.store.set('nbo-mm', {
        ...mmOpts(),
        pct: Number($('nboMmPct').value) || 0,
        months: Number($('nboMmN').value) || 12,
        iv: Number($('nboMmIv').value) || 13,
        swings: $('nboMmSw').checked,
      });
      loadMm();
    };
    ['nboMmPct', 'nboMmN', 'nboMmIv', 'nboMmSw'].forEach((id) => ($(id).onchange = save));
    $('nboMmMode').onclick = (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      BT.store.set('nbo-mm', { ...mmOpts(), mode: m });
      $('nboMmMode')
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      body()
        .querySelector('.nbo-mm-model')
        .classList.toggle('hidden', m !== 'model');
      loadMm();
    };
    $('nboMmIdx').oninput = (e) => {
      stopMm();
      mmState.idx = Number(e.target.value);
      drawMm();
    };
    $('nboMmPlay').onclick = () => {
      if (mmState.timer) return stopMm();
      if (mmState.idx >= mmState.rows.length - 1) mmState.idx = -1;
      $('nboMmPlay').textContent = '❚❚ Pause';
      mmState.timer = setInterval(() => {
        if (!document.body.contains($('nboMmPlay')) || mmState.idx >= mmState.rows.length - 1) return stopMm();
        mmState.idx++;
        drawMm();
      }, 700);
    };
    loadMm();
  }
  function stopMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    if ($('nboMmPlay')) $('nboMmPlay').textContent = '▶ Play the months';
  }
  async function loadMm() {
    stopMm();
    const o = mmOpts();
    const seq = ++mmState.seq;
    let rows = [];
    if (o.mode === 'real') {
      const B = saved.backtest;
      if (!B) {
        $('nboMmNote').textContent = 'No backtest saved yet: run one on the Backtest tab.';
        mmState.rows = [];
        return drawMm();
      }
      const none = new Map(B.without.months.map((m) => [m.expiry, m]));
      const one = (x) =>
        x?.ok ? { opt: x.opt, call: x.callPnl, put: x.putPnl, etf: x.etfOnce, total: x.withOnce, adjustments: x.adjustments, events: x.events } : null;
      rows = B.withAdj.months
        .filter((m) => m.ok)
        .map((m) => ({ label: monthName(m.expiry), spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(none.get(m.expiry)) }));
      $('nboMmNote').textContent =
        `The backtest's months (${rows.length}, ${sizeLabel(B.withAdj.params)}, ${B.withAdj.params.adj.on ? 'with its adjustments' : 'no adjustments'}) next to the same months without adjustments, NIFTYBEES held throughout. Months left out of the backtest are skipped.`;
    } else {
      $('nboMmNote').textContent = 'Working…';
      let r;
      try {
        r = await BT.api('/api/nbo/model', { params, opts: { S0: exState().spot, pct: o.pct, months: o.months, iv: o.iv, swings: o.swings } });
      } catch (e) {
        $('nboMmNote').textContent = e.message;
        return;
      }
      if (seq !== mmState.seq) return;
      const one = (x) => ({ opt: x.opt, call: x.callPnl, put: x.putPnl, etf: x.etf, total: x.total, adjustments: x.adjustments, events: x.events });
      rows = r.withAdj.map((m, i) => ({ label: `Month ${i + 1}`, spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(r.without[i]) }));
      $('nboMmNote').textContent =
        `The strategy is entered afresh every month (the Backtest tab's settings, ${sizeLabel(params)}, ${params.adj.on ? 'with its adjustments' : 'adjustments off'}), priced by Black-Scholes at ${o.iv} % IV, while Nifty moves the same % each month (${o.pct} % over ${o.months} months; type a negative % for a falling market). ${o.swings ? 'With weekly swings Nifty zig-zags about one typical week’s move inside each month, which is what triggers the rolls.' : 'Without weekly swings every month is a straight line: no rolls trigger unless the trend alone moves 2 %.'} A model, not a forecast: real months are uneven (see Real months).`;
    }
    mmState.rows = rows;
    mmState.idx = Math.min(mmState.idx, Math.max(0, rows.length - 1));
    $('nboMmIdx').max = Math.max(0, rows.length - 1);
    drawMm();
  }
  function drawMm() {
    const rows = mmState.rows;
    if (!rows.length) {
      $('nboMmBars').innerHTML = '';
      $('nboMmText').innerHTML = '';
      BT.chart($('nboMmChart'), { type: 'line', data: { labels: [], datasets: [] } });
      return;
    }
    const i = Math.max(0, mmState.idx);
    $('nboMmIdx').value = i;
    const cum = (k, upto = i, side = 'adj') => rows.slice(0, upto + 1).reduce((s, r) => s + (r[side]?.[k] || 0), 0);
    const all = (k, side = 'adj') => rows.reduce((s, r) => s + Math.abs(r[side]?.[k] || 0), 0);
    const scale = Math.max(...['etf', 'call', 'put', 'opt', 'total'].map((k) => Math.abs(cum(k, rows.length - 1))), all('opt') / 2, 1);
    const r = rows[i];
    bars(
      $('nboMmBars'),
      [
        ['NIFTYBEES', cum('etf')],
        ['Call legs', cum('call'), `not adjusted ${inrS(cum('call', i, 'none'))}`],
        ['Put legs', cum('put'), `not adjusted ${inrS(cum('put', i, 'none'))}`],
        ['Without NIFTYBEES (options)', cum('opt'), `not adjusted ${inrS(cum('opt', i, 'none'))}`, true],
        ['With NIFTYBEES (total)', cum('total'), `not adjusted ${inrS(cum('total', i, 'none'))}`, true],
      ],
      scale,
    );
    const ev = (r.adj?.events || []).filter((e) => !['entry', 'expiry'].includes(e.kind));
    $('nboMmText').innerHTML =
      `<b>${esc(r.label)}</b> · Nifty ${num0(r.spot0)} → ${num0(r.spotE)} (${pct(((r.spotE - r.spot0) / r.spot0) * 100)}) · this month: call legs <b class="${cls(r.adj.call)}">${inrS(r.adj.call)}</b>, put legs <b class="${cls(r.adj.put)}">${inrS(r.adj.put)}</b>, NIFTYBEES <b class="${cls(r.adj.etf)}">${inrS(r.adj.etf)}</b>, total <b class="${cls(r.adj.total)}">${inrS(r.adj.total)}</b>
      ${ev.length ? `<ul>${ev.map((e) => `<li>${typeof e.day === 'number' ? `day ${e.day}` : dayLabel(e.day)}: ${esc(e.text)}</li>`).join('')}</ul>` : '<div class="muted">No rolls this month.</div>'}
      <span class="muted">Totals since month 1 in the bars.</span>`;
    const upto = (f) => rows.map((x, j) => (j <= i ? rows.slice(0, j + 1).reduce((s, y) => s + (f(y) || 0), 0) : null));
    BT.chart($('nboMmChart'), {
      type: 'line',
      data: {
        labels: rows.map((x) => x.label),
        datasets: [
          { label: 'Adjusted + NIFTYBEES', data: upto((y) => y.adj?.total), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
          { label: 'Not adjusted + NIFTYBEES', data: upto((y) => y.none?.total), borderColor: '#b392f0', borderWidth: 1.5, pointRadius: 0 },
          { label: 'NIFTYBEES alone', data: upto((y) => y.adj?.etf), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
          { label: 'Call legs', data: upto((y) => y.adj?.call), borderColor: '#d6af4c', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Put legs', data: upto((y) => y.adj?.put), borderColor: '#3fb68b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
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

  function adjText(p) {
    const a = p.adj;
    if (!a.on) return '<b>No adjustments</b>: every leg is held to expiry.';
    const dirs = [a.ceDown && 'calls follow a fall', a.ceUp && 'calls follow a rise', a.peUp && 'puts follow a rise', a.peDown && 'puts follow a fall'].filter(
      Boolean,
    );
    const when =
      a.trigger === 'decay'
        ? `once a side is worth ${a.decayPct} % of its entry value (and Nifty has moved a strike or more)`
        : `when Nifty has moved ${a.movePct} % from that side's entry or last roll`;
    return `<b>${dirs.length ? dirs.join(', ') : 'no direction switched on'}</b>, ${when}; checked ${a.check === 'hourly' ? 'hourly 10:30–15:00' : 'once a day at 15:00'}, none in the last ${a.lastDays} trading days, at most ${a.maxPerSide} rolls per side a month.`;
  }

  const skippedText = (s) => (s?.skipped?.length ? `Left out (no option prices in the cache): ${s.skipped.map((x) => monthName(x.expiry)).join(', ')}.` : '');

  // The study's rules, best first (options P&L over the period; the NIFTYBEES is the same in every row).
  function studyTable(st, compact) {
    const r0 = st.rows.find((r) => r.id === 'none');
    const rows = [...st.rows].sort((a, b) => b.summary.opt.total - a.summary.opt.total);
    const top = rows[0];
    const steady = [...st.rows].filter((r) => r.summary.opt.total > 0).sort((a, b) => b.summary.withOnce.maxDD - a.summary.withOnce.maxDD)[0];
    const t = top.summary;
    const bestLine = `<div class="mcc-best"><span class="cc-kind k-book">Best</span> <b>${esc(top.label)}</b>: ${inrS(t.opt.total)} on the options (${inrS(t.opt.total - r0.summary.opt.total)} vs no adjustments), ${inrS(t.withOnce.total)} with NIFTYBEES held, ${t.adjustments} rolls; worst month ${inr(t.opt.worst)}, drawdown with NIFTYBEES ${inr(t.withOnce.maxDD)} (no adjustments: ${inr(r0.summary.opt.worst)} / ${inr(r0.summary.withOnce.maxDD)}).
      ${steady && steady.id !== top.id ? `<br><span class="cc-kind k-call">Steadiest</span> <b>${esc(steady.label)}</b>: the smallest drawdown with NIFTYBEES of the profitable rules (${inr(steady.summary.withOnce.maxDD)}) for ${inrS(steady.summary.opt.total)} on the options.` : ''}
      <br><span class="muted small">Best on this one period of history (${r0.summary.months} months); the gap between neighbouring rows is often a single month. The last two rows leave a side out (no adjustments), to show what each side adds.</span></div>`;
    return `${bestLine}<div class="tbl-wrap"><table class="grid-tbl">
      <thead><tr><th>#</th><th class="l">Rule</th><th>Rolls</th><th>Options P&L</th><th>vs none</th><th>Worst month</th><th>Max drawdown (+ ETF held)</th><th>Call legs</th><th>Put legs</th><th>Up months</th><th>Flat</th><th>Down</th><th>+ ETF held</th><th>+ ETF rebought</th>${compact ? '' : '<th>Costs</th>'}</tr></thead>
      <tbody>${rows
        .map((r, i) => {
          const s = r.summary;
          return `<tr class="cc-click${r.id === 'none' ? ' on' : ''}${r === top ? ' mcc-top' : ''}${viewing?.id === r.id ? ' mcc-viewing' : ''}" data-rule="${r.id}" title="Click: this rule's full backtest, month by month with every adjustment">
            <td>${i + 1}</td>
            <td class="l">${esc(r.label)}${r === top ? ' <span class="cc-kind k-book">best</span>' : ''}${steady && r === steady && r !== top ? ' <span class="cc-kind k-call">steadiest</span>' : ''}${r.id === REC.user ? ' <span class="cc-kind">default settings</span>' : ''}${r.id === 'none' ? ' <span class="cc-kind">baseline</span>' : ''}</td>
            <td>${s.adjustments}</td>
            <td class="${cls(s.opt.total)}"><b>${inrS(s.opt.total)}</b></td>
            <td class="${cls(s.opt.total - r0.summary.opt.total)}">${r.id === 'none' ? '—' : inrS(s.opt.total - r0.summary.opt.total)}</td>
            <td class="neg">${inr(s.opt.worst)}</td>
            <td class="neg">${inr(s.withOnce.maxDD)}</td>
            <td class="${cls(s.call.total)}">${inrS(s.call.total)}</td>
            <td class="${cls(s.put.total)}">${inrS(s.put.total)}</td>
            <td class="${cls(s.byMove.up.opt)}">${inrS(s.byMove.up.opt)}</td>
            <td class="${cls(s.byMove.flat.opt)}">${inrS(s.byMove.flat.opt)}</td>
            <td class="${cls(s.byMove.down.opt)}">${inrS(s.byMove.down.opt)}</td>
            <td class="${cls(s.withOnce.total)}">${inrS(s.withOnce.total)}</td>
            <td class="${cls(s.withMonthly.total)}">${inrS(s.withMonthly.total)}</td>
            ${compact ? '' : `<td>${inr(s.costs)}</td>`}
          </tr>`;
        })
        .join('')}</tbody></table></div>
      <div class="muted small pad"><b>Click a rule</b> to open its full backtest on the Backtest tab: every month, every adjustment. Options P&L after slippage and charges, split into the call legs and the put legs (each net of its own costs). Up / flat / down: the options in months where Nifty rose more than 2 %, stayed within ±2 %, fell more than 2 % from entry to expiry.
      "+ ETF held": with NIFTYBEES bought once (buy and hold alone: ${inrS(r0.summary.hold.total)}, drawdown ${inr(r0.summary.hold.maxDD)}). "+ ETF rebought": sold at each expiry and bought back at the next entry.</div>`;
  }

  // ---------- Backtest ----------
  const sel = (path, cur, opts) =>
    `<select data-p="${path}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const inp = (path, cur, w = 60) => `<input class="txt num" data-p="${path}" value="${cur}" style="width:${w}px">`;
  const onOff = (path, cur, on, off = 'off') =>
    sel(path, cur, [
      [true, on],
      [false, off],
    ]);
  function renderBacktest() {
    const p = params;
    const months = meta.monthly || [];
    const range = BT.store.get('nbo-range', { from: months[1] || '', to: months[months.length - 1] || '' });
    const opts = (cur) =>
      months
        .slice(1)
        .map((e) => `<option${e === cur ? ' selected' : ''}>${e}</option>`)
        .join('');
    body().innerHTML = `
      <div class="panel cc-doc">
        <h3>Settings</h3>
        <div class="cc-params">
          <div class="set-row"><b>Series</b> <span class="lbl">from expiry</span><select id="nboFrom">${opts(range.from)}</select><span class="lbl">to</span><select id="nboTo">${opts(range.to)}</select></div>
          ${budgetRow(p.budget, exState().spot, 'Bought at each entry (held: once, at the first); % a year is on the budget. Saved results are shown for it without re-running.')}
          <div class="set-row"><b>Adjustments</b> ${onOff('adj.on', p.adj.on, 'on: roll as below')}
            <span class="lbl">when</span>${sel('adj.trigger', p.adj.trigger, [
              ['move', 'Nifty moved'],
              ['decay', 'side decayed to'],
            ])} ${inp('adj.movePct', p.adj.movePct, 50)}<span class="lbl">% (move) /</span>${inp('adj.decayPct', p.adj.decayPct, 50)}<span class="lbl">% of its entry value (decay)</span></div>
          <div class="set-row"><b></b><span class="lbl">market down: call legs</span>${onOff('adj.ceDown', p.adj.ceDown, 'follow Nifty down', 'kept')}
            <span class="lbl">market up: call legs</span>${onOff('adj.ceUp', p.adj.ceUp, 'follow Nifty up', 'kept')}
            <span class="lbl">market up: put legs</span>${onOff('adj.peUp', p.adj.peUp, 'follow Nifty up', 'kept')}
            <span class="lbl">market down: put legs</span>${onOff('adj.peDown', p.adj.peDown, 'follow Nifty down', 'kept')}</div>
          <div class="set-row"><b></b><span class="lbl">checked</span>${sel('adj.check', p.adj.check, [
            ['close', 'once a day at 15:00'],
            ['hourly', 'hourly 10:30–15:00'],
          ])}<span class="lbl">none in the last</span>${inp('adj.lastDays', p.adj.lastDays, 40)}<span class="lbl">trading days · at most</span>${inp('adj.maxPerSide', p.adj.maxPerSide, 40)}<span class="lbl">rolls per side a month</span></div>
          <div class="set-row"><b>Option legs</b><span class="small">${esc(structureText(p))}</span><button class="btn-sm ghost" id="nboEditLegs">Change on the Strategy tab</button></div>
          <div class="set-row"><b>NIFTYBEES</b> ${sel('etf', p.etf, [
            ['model', '₹1 per 100 Nifty points (Nifty ÷ 100)'],
            ['real', 'recorded NIFTYBEES prices'],
          ])}
            <span class="lbl">option slippage</span>${inp('costs.slipPct', p.costs.slipPct, 45)}<span class="lbl">% · brokerage ₹</span>${inp('costs.brokerage', p.costs.brokerage, 45)}<span class="lbl">/ order · ETF slippage</span>${inp('costs.etfSlipPct', p.costs.etfSlipPct, 45)}<span class="lbl">%</span></div>
          <div class="set-row cc-run">
            <button class="btn-sm run" id="nboRun">Run backtest</button>
            <button class="btn-sm ghost" id="nboStudy">Run adjustment study</button>
            <button class="btn-sm ghost" id="nboDefaults" title="Default adjustments, NIFTYBEES and costs; your legs are kept">Default rules</button>
            <span class="muted small">The backtest runs these settings and the same without any adjustment. The study runs ${meta.study.length} adjustment rules (and each side left out) on the same months, with your legs. Both use the cached history (missing contracts are downloaded when logged in).</span>
            <div class="progress hidden" id="nboProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
          </div>
          ${lastDone ? `<div class="small nbo-done">${lastDone}</div>` : ''}
        </div>
      </div>
      <div id="nboRes"></div>`;
    body()
      .querySelectorAll('[data-p]')
      .forEach((el) => el.addEventListener('change', () => setParam(el.dataset.p, el.value)));
    bindBudget((v) => {
      useBudget(v);
      renderBacktest();
    });
    ['nboFrom', 'nboTo'].forEach((id) => $(id).addEventListener('change', () => BT.store.set('nbo-range', { from: $('nboFrom').value, to: $('nboTo').value })));
    $('nboRun').addEventListener('click', () => {
      viewing = null;
      runJob('backtest');
    });
    $('nboStudy').addEventListener('click', () => runJob('study'));
    $('nboEditLegs').onclick = () => goTab('rules');
    $('nboDefaults').addEventListener('click', () => {
      params = { ...deep(meta.defaults), legs: params.legs, lots: params.lots, budget: params.budget, lotSize: meta.lot };
      BT.store.set('nbo-params', params);
      renderBacktest();
    });
    if (job) showProgress(job.progress);
    renderResults();
  }
  function setParam(path, v0) {
    const v = v0 === 'true' ? true : v0 === 'false' ? false : v0 !== '' && !isNaN(v0) ? Number(v0) : v0;
    const [a, b] = path.split('.');
    if (b) params[a] = { ...params[a], [b]: v };
    else params[a] = v;
    BT.store.set('nbo-params', params);
    if (path === 'lots' || path === 'budget') drawBees();
  }
  function showProgress(pr) {
    const box = $('nboProg');
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
    const range = { from: $('nboFrom')?.value, to: $('nboTo')?.value };
    lastDone = '';
    body().querySelector('.nbo-done')?.remove();
    try {
      job = { kind, progress: null };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api('/api/nbo/' + kind, { params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api('/api/nbo/job?id=' + job.id);
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
      if ($('nboRes'))
        $('nboRes').innerHTML = `<div class="panel empty err">${kind === 'study' ? 'Adjustment study' : 'Backtest'} failed: ${esc(e.message)}</div>`;
      job = null;
      showProgress(null);
      return;
    }
    job = null;
    const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    lastDone =
      kind === 'study'
        ? `✓ Adjustment study finished at ${t}: ${saved.study.rows.length} rules on ${saved.study.rows[0]?.summary.months || 0} months. The table is below.`
        : `✓ Backtest finished at ${t}.`;
    if (tab === 'bt') {
      renderBacktest();
      $(kind === 'study' ? 'nboStudyPanel' : 'nboRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function kpiBlock(title, s, note) {
    const card = (label, x, sub) =>
      `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${cls(x.total)}">${inrS(x.total)}</span><span class="muted small">${sub}</span></div>`;
    const sub = (x) => `${pct(x.annPct)} / yr · worst ${kinr(x.worst)} · DD ${kinr(x.maxDD)} · ${x.win}/${s.months} up`;
    return `<div class="cc-grp-l" style="margin:6px 0 4px"><b>${title}</b> <span class="muted small">${note || ''}</span></div>
      <div class="kpis cc-kpis-main">
        ${card('Call legs', s.call, sub(s.call))}
        ${card('Put legs', s.put, sub(s.put))}
        ${card('Options only (both)', s.opt, sub(s.opt))}
        ${card('+ NIFTYBEES held', s.withOnce, sub(s.withOnce))}
        ${card('+ NIFTYBEES rebought monthly', s.withMonthly, sub(s.withMonthly))}
        ${card('NIFTYBEES alone (buy & hold)', s.hold, sub(s.hold))}
      </div>`;
  }
  const adjDesc = (p) => {
    if (!p.adj.on) return 'no rolls';
    const sides =
      [p.adj.ceDown && 'calls down', p.adj.ceUp && 'calls up', p.adj.peUp && 'puts up', p.adj.peDown && 'puts down'].filter(Boolean).join(', ') ||
      'no side switched on';
    return `${sides} at ${p.adj.trigger === 'decay' ? p.adj.decayPct + ' % premium' : p.adj.movePct + ' % Nifty move'}, ${p.adj.check === 'hourly' ? 'hourly' : '15:00'} checks`;
  };
  const shapeDesc = (p) => esc(structureText(p)) + (p.drop ? ` (${p.drop} legs left out)` : '');
  function renderResults() {
    const el = $('nboRes');
    const B = viewing?.B || saved.backtest;
    if (!B) {
      el.innerHTML = `<div class="panel empty"><h3>No backtest yet</h3><p>Press Run backtest.</p></div>${saved.study ? `<div class="panel cc-doc" id="nboStudyPanel"><h3>Adjustment study</h3>${studyTable(saved.study)}</div>` : ''}`;
      return;
    }
    const A = B.withAdj;
    const N = B.without;
    const sa = A.summary;
    const sn = N.summary;
    const byExp = new Map(N.months.map((m) => [m.expiry, m]));
    const all = openMonth === 'all';
    el.innerHTML = `
      ${
        viewing
          ? `<div class="panel cc-doc mcc-view-banner"><span class="cc-kind k-book">Study rule</span><b>${esc(viewing.label)}</b><span class="muted small">its full backtest (not saved; your own backtest is kept)</span>
        <button class="btn-sm ghost" id="nboViewBack">Back to your backtest</button><button class="btn-sm ghost" id="nboViewUse">Use these settings</button><span class="small" id="nboViewMsg"></span></div>`
          : ''
      }
      <div class="panel cc-doc">
        <h3>Result: ${dayLabel(sa.from)} – ${dayLabel(sa.to)}, ${sa.months} monthly series, ${sizeLabel(A.params)}, ${shapeDesc(A.params)}</h3>
        ${B.withAdj !== (viewing?.raw || raw.backtest)?.withAdj ? `<div class="muted small" style="margin-bottom:6px">Run with ${sizeLabel((viewing?.raw || raw.backtest).withAdj.params)}; shown for your budget: the options are the same, the NIFTYBEES figures scaled to it.</div>` : ''}
        ${kpiBlock('With adjustments', sa, adjDesc(A.params) + ` · ${sa.adjustments} adjustments · costs ${inr(sa.costs)}`)}
        ${kpiBlock('Without adjustments', sn, `costs ${inr(sn.costs)}`)}
        <p class="cc-verdict">${verdict(sa, sn, A.params)}</p>
        <p class="muted small">% per year on ${A.params.budget > 0 ? 'the NIFTYBEES budget' : 'the ETF bought at the first entry'} (${inr(sa.invested)}). ${skippedText(sa)} DD = largest fall from a peak of the month-end totals.
        "Rebought monthly" is out of the market from each expiry's close to the next morning; ${gapNote(A)}.</p>
      </div>
      <div class="panel cc-doc"><h3>Month-end total</h3><div class="cc-pay-chart"><canvas id="nboEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>By market direction</h3>${dirTable(sa, sn)}</div>
      <div class="panel cc-doc"><h3>Month by month <button class="btn-sm ghost" id="nboAllMonths" style="margin-left:8px">${all ? 'Hide the details' : 'Show every month’s details'}</button></h3><div class="muted small" style="margin-bottom:6px">Call legs and put legs: the adjusted run, each net of its own costs. Click a month for every leg it traded (closed strikes included), the options and NIFTYBEES totals, its adjustments and the payoff of the position held into expiry.</div>
        <div class="tbl-wrap"><table class="grid-tbl cc-months"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th><th>Rolls</th><th>Call legs</th><th>Put legs</th><th class="cc-col-opt">Options, adjusted</th><th class="cc-col-opt">Options, not adjusted</th><th>NIFTYBEES held</th><th>NIFTYBEES rebought</th><th class="cc-col-tot">Total adjusted + held</th><th class="cc-col-tot">Total not adjusted + held</th></tr></thead>
        <tbody>${A.months
          .map((m) => {
            const n = byExp.get(m.expiry);
            if (!m.ok) return `<tr><td class="l">${monthName(m.expiry)}</td><td colspan="11" class="muted l">${esc(m.skip)}</td></tr>`;
            const open = all || openMonth === m.expiry;
            return `<tr class="cc-click${open ? ' on' : ''}" data-m="${m.expiry}"><td class="l">${monthName(m.expiry)}<div><button class="btn-sm ghost" style="margin-top:3px;white-space:nowrap" data-pbld="${m.expiry}" title="Replay this month in the Builder (Historical replay): the legs at the backtest's entry, its ${m.adjustments} roll${m.adjustments === 1 ? '' : 's'} made again as the replay reaches them">Open in Builder ▸</button></div></td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td class="${cls(m.move)}">${pct(m.move)}</td><td>${m.adjustments}</td>
              <td class="${cls(m.callPnl)}">${inrS(m.callPnl)}</td><td class="${cls(m.putPnl)}">${inrS(m.putPnl)}</td>
              <td class="cc-col-opt ${cls(m.opt)}">${inrS(m.opt)}</td><td class="cc-col-opt ${cls(n?.opt)}">${n?.ok ? inrS(n.opt) : '—'}</td>
              <td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.etfMonthly)}">${inrS(m.etfMonthly)}</td>
              <td class="cc-col-tot ${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="cc-col-tot ${cls(n?.withOnce)}">${n?.ok ? inrS(n.withOnce) : '—'}</td></tr>
              ${open ? `<tr class="cc-detail"><td colspan="12">${monthDetail(m, n, A.params.lotSize)}</td></tr>` : ''}`;
          })
          .join('')}</tbody>
        <tfoot><tr><th class="l">Total</th><td></td><td></td><td>${sa.adjustments}</td><th class="${cls(sa.call.total)}">${inrS(sa.call.total)}</th><th class="${cls(sa.put.total)}">${inrS(sa.put.total)}</th><th class="${cls(sa.opt.total)}">${inrS(sa.opt.total)}</th><th class="${cls(sn.opt.total)}">${inrS(sn.opt.total)}</th><th class="${cls(sa.hold.total)}">${inrS(sa.hold.total)}</th><th class="${cls(sa.withMonthly.total - sa.opt.total)}">${inrS(sa.withMonthly.total - sa.opt.total)}</th><th class="${cls(sa.withOnce.total)}">${inrS(sa.withOnce.total)}</th><th class="${cls(sn.withOnce.total)}">${inrS(sn.withOnce.total)}</th></tr></tfoot></table></div>
      </div>
      <div class="panel cc-doc"><h3>Every adjustment</h3>${adjustmentList(A)}</div>
      <div class="panel cc-doc" id="nboStudyPanel"><h3>Adjustment study</h3>${saved.study ? studyTable(saved.study) + `<div class="muted small pad">Run ${new Date(saved.study.at).toLocaleString('en-IN')} with ${sizeLabel(saved.study.rows[0]?.params)}, with the legs ${esc(structureText(saved.study.rows[0]?.params))}. The rolls mostly move money between months; read the drawdown as well as the total.</div>` : '<p class="muted">Not run yet: "Run adjustment study" above.</p>'}</div>`;
    drawEquity(A, N);
    el.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-pbld]');
        if (b)
          return monthToBuilder(
            A.months.find((m) => m.expiry === b.dataset.pbld),
            A.params,
          );
        openMonth = openMonth === tr.dataset.m ? null : tr.dataset.m;
        renderResults();
      }),
    );
    $('nboAllMonths').onclick = () => {
      openMonth = all ? null : 'all';
      renderResults();
    };
    if (viewing) {
      $('nboViewBack').onclick = () => {
        viewing = null;
        openMonth = null;
        renderBacktest();
      };
      $('nboViewUse').onclick = () => {
        params = { ...deep(viewing.B.withAdj.params), lotSize: meta.lot };
        BT.store.set('nbo-params', params);
        const label = viewing.label;
        renderBacktest();
        $('nboViewMsg').textContent = `Settings set to "${label}". Press Run backtest to keep its result as your backtest.`;
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
  const SIDE = { rollPut: 'PE', rollPutDn: 'PE', rollCall: 'CE', rollCallUp: 'CE' };
  // One month of the backtest replayed in the Builder (Historical replay, multi-day): the legs at the backtest's entry
  // fills, and every roll it made as the Builder's plan, made again at the backtest's fills when the replay reaches
  // that minute. Both are rebuilt from the month's legs (m.closed: when each was opened and, unless held to expiry,
  // closed). The NIFTYBEES are left to the Builder's "Held against NIFTYBEES" box (ticked on a replay: the recorded
  // NIFTYBEES price at the entry, ₹16 L by default); only the strategy is marked, so the box names the collar.
  function monthToBuilder(m, p) {
    if (!m?.ok) return;
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this month of the backtest?'))
      return;
    const lot = p.lotSize;
    const act = (side) => (side > 0 ? 'B' : 'S');
    const key = (x) => `${x.day} ${x.time}`;
    const at0 = m.entry || m.events.find((e) => e.kind === 'entry');
    const atExp = (c) => c.exitAt.day === m.expiry && c.exitAt.time === '15:30';
    // a leg partly closed is listed once per part (same id): its lots add up again
    const add = (map, id, op) => map.set(id, map.has(id) ? { ...op, qty: map.get(id).qty + op.qty } : op);
    const entry = new Map();
    const steps = new Map(); // 'day time' -> { day, time, close: [ops], open: Map(id -> op) }
    const stepAt = (x) => {
      if (!steps.has(key(x))) steps.set(key(x), { day: x.day, time: x.time, close: [], open: new Map() });
      return steps.get(key(x));
    };
    for (const c of m.closed) {
      const op = { action: act(c.side), type: c.type, strike: c.strike, expiry: m.expiry, lot };
      if (!c.at || key(c.at) === key(at0)) add(entry, c.id, { ...op, qty: c.lots * lot, px: c.entry });
      else add(stepAt(c.at).open, c.id, { ...op, op: 'open', qty: c.lots * lot, px: c.entry });
      if (!atExp(c)) stepAt(c.exitAt).close.push({ ...op, op: 'close', qty: c.lots * lot, px: c.exit });
    }
    const plan = [...steps.values()]
      .sort((a, b) => (key(a) < key(b) ? -1 : 1))
      .map((s) => {
        const ev = m.events.filter((e) => e.day === s.day && e.time === s.time && SIDE[e.kind]);
        return {
          day: s.day,
          time: s.time,
          title: ev.map((e) => KIND[e.kind] || e.kind).join(' + ') || 'Roll',
          why: ev.map((e) => e.text).join(' · '),
          ops: [...s.close, ...s.open.values()],
        };
      });
    BT.emit('open-builder', {
      idea: NAME, // the Trading Ideas strategy, named in the Builder's Positions heading
      src: 'hist',
      expiry: m.expiry,
      day: at0.day,
      time: at0.time,
      session: 'multi',
      lot,
      strategy: { name: NAME, mode: 'positional', expiry: 'monthly', entry: { time: at0.time, after: 1 }, exit: { time: '15:30', dteDays: 0 }, legs: [] },
      fromLabel: `backtest month: entered ${at0.time} on ${dayLabel(at0.day)}, held to the ${dayLabel(m.expiry)} expiry`,
      note: `${monthName(m.expiry)} series${viewing ? ` (study rule: ${viewing.label})` : ''} · Nifty ${num0(m.spot0)} → ${num0(m.spotE)} · options ${inrS(m.opt)} after costs in the backtest`,
      bt: { costs: m.costs, net: m.opt },
      plan,
      legs: [...entry.values()].map((l) => ({ action: l.action, type: l.type, strike: l.strike, expiry: l.expiry, lots: Math.round(l.qty / lot), px: l.px })),
    });
  }
  function adjustmentList(A) {
    const rows = A.months.filter((m) => m.ok).flatMap((m) => m.events.filter((e) => SIDE[e.kind] || e.kind === 'skip').map((e) => ({ m, e })));
    if (!rows.length) return '<p class="muted">No adjustments in this run.</p>';
    const count = (t) => rows.filter((r) => SIDE[r.e.kind] === t).length;
    const months = new Set(rows.map((r) => r.m.expiry)).size;
    const skips = rows.filter((r) => r.e.kind === 'skip').length;
    return `<p class="small">${rows.length} adjustments in ${months} of ${A.summary.months} months: call legs ${count('CE')}, put legs ${count('PE')}${skips ? `, not done (no price) ${skips}` : ''}.</p>
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
    return [
      `Adjustments ${d >= 0 ? 'added' : 'cost'} <b class="${cls(d)}">${inrS(d)}</b> on the options (${inrS(sa.opt.total)} vs ${inrS(sn.opt.total)}); worst month ${inr(sa.opt.worst)} vs ${inr(sn.opt.worst)}.`,
      `With the ETF held: ${inrS(sa.withOnce.total)} vs buy and hold alone ${inrS(sa.hold.total)}: the options ${sa.opt.total >= 0 ? 'added' : 'took'} ${inrS(sa.opt.total)}, while the drawdown went from ${inr(sa.hold.maxDD)} to ${inr(sa.withOnce.maxDD)}.`,
      `Options alone made ${pct(sa.opt.annPct)} a year on ${p?.budget > 0 ? 'the NIFTYBEES budget' : "the ETF's value"}. That does not count interest on the ₹ in the ETF.`,
    ].join(' ');
  }
  function dirTable(sa, sn) {
    const row = (k, label) => {
      const a = sa.byMove[k];
      const n = sn.byMove[k];
      return `<tr><td class="l">${label}</td><td>${a.n}</td><td class="${cls(a.call)}">${inrS(a.call)}</td><td class="${cls(a.put)}">${inrS(a.put)}</td><td class="${cls(a.opt)}">${inrS(a.opt)}</td><td class="${cls(n.opt)}">${inrS(n.opt)}</td><td class="${cls(a.hold)}">${inrS(a.hold)}</td><td class="${cls(a.withOnce)}">${inrS(a.withOnce)}</td><td class="${cls(n.withOnce)}">${inrS(n.withOnce)}</td></tr>`;
    };
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty in the month</th><th>Months</th><th>Call legs</th><th>Put legs</th><th>Options, adjusted</th><th>Options, not adjusted</th><th>NIFTYBEES held</th><th>Total adjusted</th><th>Total not adjusted</th></tr></thead><tbody>
      ${row('up', 'Up more than 2 %')}${row('flat', 'Within ±2 %')}${row('down', 'Down more than 2 %')}</tbody></table></div>`;
  }
  // One month in full: every leg it traded under its structure, each structure's result after its costs, the
  // options total, NIFTYBEES (held / rebought) and the total; the payoff of what was held into expiry; the events.
  function monthDetail(m, n, lot) {
    const ev = (list) =>
      `<table class="grid-tbl cc-ev"><tbody>${list.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind k-${e.kind === 'expiry' ? 'exp' : e.kind === 'entry' ? 'hold' : e.kind === 'skip' ? 'skip' : 'call'}">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>`;
    const atExp = (c) => c.exitAt.day === m.expiry && c.exitAt.time === '15:30';
    const when = (x) => (x ? `${dayLabel(x.day)}${x.time ? ' ' + x.time : ''}` : '—');
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
        <tr class="mcc-sub"><td class="l" colspan="6">${GROUP_NAME[t]}: legs ${inrS(gross)}, costs ${inrS(net - gross)}</td><td class="${cls(net)}"><b>${inrS(net)}</b></td></tr>`;
    };
    const e = m.etf || {};
    const summary = `<table class="grid-tbl mcc-sum"><tbody>
        <tr><td class="l">Call legs</td><td class="${cls(m.callPnl)}">${inrS(m.callPnl)}</td></tr><tr><td class="l">Put legs</td><td class="${cls(m.putPnl)}">${inrS(m.putPnl)}</td></tr>
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
    BT.chart($('nboEq'), {
      type: 'line',
      data: {
        labels: ok.map((m) => monthName(m.expiry)),
        datasets: [
          { label: 'Adjusted + ETF held', data: cum((m) => m.withOnce), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
          { label: 'Not adjusted + ETF held', data: cum((m) => byExp.get(m.expiry)?.withOnce), borderColor: '#b392f0', borderWidth: 2, pointRadius: 2 },
          { label: 'ETF alone', data: cum((m) => m.etfOnce), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Options, adjusted', data: cum((m) => m.opt), borderColor: '#e86fb5', borderWidth: 2, pointRadius: 2 },
          { label: 'Options, not adjusted', data: cum((m) => byExp.get(m.expiry)?.opt), borderColor: '#56d4dd', borderWidth: 1.5, pointRadius: 2 },
          { label: 'Call legs (adjusted)', data: cum((m) => m.callPnl), borderColor: '#d6af4c', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
          { label: 'Put legs (adjusted)', data: cum((m) => m.putPnl), borderColor: '#3fb68b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}` } } },
      },
    });
  }

  // ---------- Compare: this strategy against the Covered call and the collars ----------
  const CMP_COLORS = { mine: '#58a6ff', mineOff: '#56d4dd', mcc: '#d6af4c', psc: '#3fb68b', bpc: '#e86fb5', hold: '#9aa5b1' };
  // ---------- Paper trade ----------
  async function loadPaper() {
    try {
      paper = await BT.api('/api/nbo/paper');
    } catch (e) {
      paper = { error: e.message };
    }
  }
  async function renderPaper() {
    if (!paper) await loadPaper();
    if (tab !== 'paper') return;
    const el = body();
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
      <div class="set-row">${btns}<span class="muted small">Follows the live chain every 30 s with the Strategy tab's legs and the Backtest tab's settings (${P ? 'as started' : 'current'}): ${esc(settingsLine(P ? P.params : params))}. Paper only: nothing is sent to a broker.${paper.demo ? ' Demo mode: synthetic prices.' : ''}</span></div>
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
      <div id="nboPapMsg" class="muted small"></div></div>`;
    if (!P) {
      el.innerHTML =
        head +
        `<div class="panel empty"><h3>No paper trade running</h3><p>Start opens the position now on the current monthly series (next month's when this one has fewer than ${params.minDays ?? 15} days left) at the live prices — ${esc(structureText(params))} — buys NIFTYBEES worth ${params.budget > 0 ? `your budget (${inr(params.budget)})` : 'one lot (65 × Nifty)'}, and then runs month after month: rolls at the check times, settlement at each monthly expiry and a new series at 09:30 on the next trading day.</p></div>`;
    } else {
      const c = P.cycle;
      const done = P.months || [];
      const tot = (k) => done.reduce((s, m) => s + (m[k] || 0), 0);
      const scenTop = el.querySelector('.mcc-scen')?.scrollTop;
      el.innerHTML =
        head +
        (c
          ? `<div class="panel cc-doc"><h3>${monthName(c.expiry)} series · expiry ${dayLabel(c.expiry)} <button class="btn-sm ghost" data-a="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices. Options only (the Builder holds no NIFTYBEES); the paper trade itself carries on unchanged.">▶ Open in Builder</button></h3>
          <div class="kpis cc-kpis-main">
            <div class="kpi"><span class="k-l">Nifty</span><span class="k-v">${num0(c.spot)}</span><span class="muted small">entry ${num0(c.spot0)} · ${pct(((c.spot - c.spot0) / c.spot0) * 100)}</span></div>
            <div class="kpi"><span class="k-l">Call legs</span><span class="k-v ${cls(c.callPnl)}">${inrS(c.callPnl)}</span><span class="muted small">at LTP, its costs included</span></div>
            <div class="kpi"><span class="k-l">Put legs</span><span class="k-v ${cls(c.putPnl)}">${inrS(c.putPnl)}</span><span class="muted small">at LTP, its costs included</span></div>
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
              ${c.closed.length ? `<tr><td class="l muted">Closed by rolls: call legs ${inrS(c.closed.filter((x) => x.type === 'CE').reduce((s, x) => s + x.pnl, 0))}, put legs ${inrS(c.closed.filter((x) => x.type === 'PE').reduce((s, x) => s + x.pnl, 0))}</td><td></td><td></td><td class="${cls(c.closed.reduce((s, x) => s + x.pnl, 0))}">${inrS(c.closed.reduce((s, x) => s + x.pnl, 0))}</td></tr>` : ''}
            </tbody></table>
            <div class="muted small">Updated ${c.markAt ? new Date(c.markAt).toLocaleTimeString('en-IN') : '—'} · rolls this month: put legs ${c.n.put}, call legs ${c.n.call}${c.n.up ? `, call up ${c.n.up}` : ''}</div></div>
            <div class="cc-pay"><div class="cc-pay-chart"><canvas id="nboPapPay"></canvas></div><div class="muted small">At expiry, entry premiums included.</div></div>
          </div>
          ${c.legs.length && c.etf ? scenarioHtml(P, c, lot) : ''}
          <h4>Events</h4><table class="grid-tbl cc-ev"><tbody>${c.events.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>
        </div>`
          : `<div class="panel empty"><h3>Between series</h3><p>The last series expired ${P.lastExpiry ? dayLabel(P.lastExpiry) : ''}. The next one opens at 09:30 on the next trading day.</p></div>`) +
        (done.length
          ? `<div class="panel cc-doc"><h3>Finished months</h3><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty</th><th>Rolls</th><th>Call legs</th><th>Put legs</th><th>Options</th><th>NIFTYBEES held</th><th>Total held</th><th>Total rebought</th></tr></thead><tbody>
            ${done.map((m) => `<tr><td class="l">${monthName(m.expiry)}</td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td>${m.adjustments}</td><td class="${cls(m.callPnl)}">${inrS(m.callPnl)}</td><td class="${cls(m.putPnl)}">${inrS(m.putPnl)}</td><td class="${cls(m.opt)}">${inrS(m.opt)}</td><td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="${cls(m.withMonthly)}">${inrS(m.withMonthly)}</td></tr>`).join('')}
            </tbody><tfoot><tr><th class="l">Total</th><td></td><td></td><th class="${cls(tot('callPnl'))}">${inrS(tot('callPnl'))}</th><th class="${cls(tot('putPnl'))}">${inrS(tot('putPnl'))}</th><th class="${cls(tot('opt'))}">${inrS(tot('opt'))}</th><th class="${cls(tot('etfOnce'))}">${inrS(tot('etfOnce'))}</th><th class="${cls(tot('withOnce'))}">${inrS(tot('withOnce'))}</th><th class="${cls(tot('withMonthly'))}">${inrS(tot('withMonthly'))}</th></tr></tfoot></table></div></div>`
          : '');
      if (c?.legs.length)
        payoffChart($('nboPapPay'), c.legs, lot, c.spot || c.spot0, { qty: P.etfOnce?.qty || 0, b0: c.etf.b0, s0: c.spot0, adj: c.etf.monthlyAdj });
      const scen = el.querySelector('.mcc-scen');
      const now = scen?.querySelector('tr.sel');
      if (scen) scen.scrollTop = scenTop ?? (now ? now.offsetTop - (scen.clientHeight - now.offsetHeight) / 2 : 0);
    }
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => paperAction(b.dataset.a)));
    bindBudget(async (v) => {
      useBudget(v);
      if (!P) return renderPaper();
      try {
        paper = await BT.api('/api/nbo/paper/budget', { budget: v });
        renderPaper();
      } catch (e) {
        $('nboBudgetNote').innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      }
    });
  }
  // The paper series at its expiry with Nifty every 100 points, 2,000 either way: NIFTYBEES moving with Nifty from its
  // live price, the open legs at intrinsic value, each structure's P&L as the paper counts it and the total.
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
      <div class="tbl-wrap mcc-scen"><table class="grid-tbl"><thead><tr><th>Nifty</th><th class="l">Move</th><th>NIFTYBEES price</th><th>NIFTYBEES value</th><th>NIFTYBEES bought</th><th>NIFTYBEES P&amp;L</th><th>Options value</th><th>Call legs P&amp;L</th><th>Put legs P&amp;L</th><th>Options P&amp;L</th><th>Combined P&amp;L</th></tr></thead><tbody>
      ${rows
        .map(
          (r) =>
            `<tr class="${r.x === base ? 'sel' : ''}"><td><b>${num0(r.x)}</b></td><td class="l muted small">${move(r.x)}</td><td>₹${r.bees.toFixed(2)}</td><td>${inr(Math.round(r.beesValue))}</td><td>${num0(qty)}</td>${td(r.etf)}<td class="${cls(r.value)}">${inrS(Math.round(r.value))}</td>${td(r.call)}${td(r.put)}${td(r.opt)}<td class="${cls(r.total)}"><b>${inrS(Math.round(r.total))}</b></td></tr>`,
        )
        .join('')}
      </tbody></table></div>`;
  }
  function settingsLine(p) {
    return `${structureText(p)}, next month's series when this one has under ${p.minDays ?? 15} days left, ${adjDesc(p)}, NIFTYBEES ${p.etf === 'real' ? 'live price' : '= Nifty ÷ 100'}, ${p.budget > 0 ? `budget ${inr(p.budget)}` : "one lot's worth"}`;
  }
  // The series' open legs in the Builder as a live paper position at their paper entry prices (options only).
  function toBuilder() {
    const P = paper?.paper;
    const c = P?.cycle;
    if (!c?.legs.length) return;
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this one?')) return;
    BT.emit('open-builder', {
      idea: NAME, // the Trading Ideas strategy, named in the Builder's Positions heading
      src: 'live',
      expiry: c.expiry,
      note: `${NAME} paper trade · ${monthName(c.expiry)} series (options only; ${num0(P.etfOnce?.qty)} NIFTYBEES not in the Builder)`,
      legs: c.legs.map((l) => ({ action: l.side > 0 ? 'B' : 'S', type: l.type, strike: l.strike, expiry: c.expiry, lots: l.lots, px: l.entry })),
    });
  }
  async function paperAction(a) {
    if (a === 'builder') return toBuilder();
    const msg = $('nboPapMsg');
    try {
      if (a === 'reset' && !confirm(`Delete the ${NAME} paper trade and its history?`)) return;
      if (msg) msg.textContent = 'Working…';
      paper = await BT.api('/api/nbo/paper/' + a, a === 'start' ? { params } : a === 'reset' ? { confirm: true } : {});
      renderPaper();
    } catch (e) {
      if (msg) {
        msg.textContent = e.message;
        msg.classList.add('neg');
      }
    }
  }

  // ---------- Trades screen: the paper trade's months (as the collars list theirs) ----------
  async function renderNboTrades() {
    const el = $('nboTrades');
    if (!el) return;
    try {
      paper = await BT.api('/api/nbo/paper');
    } catch (e) {
      el.innerHTML = `<div class="panel-head"><h3>${NAME} paper trade</h3></div><div class="err small pad">${esc(e.message)}</div>`;
      return;
    }
    const P = paper.paper;
    // nothing started: one line, not a whole panel
    el.classList.toggle('hidden', !P);
    if (!P) {
      el.innerHTML = '';
      return;
    }
    const head = `<div class="panel-head"><h3>${NAME} paper trade <span class="muted small">${P.status === 'running' ? 'running' : 'paused'} since ${dayLabel(new Date(P.startedAt).toISOString().slice(0, 10))} · ${sizeLabel(P.params)}${P.cycle?.markAt ? ` · marked ${new Date(P.cycle.markAt).toLocaleTimeString('en-IN')}${paper.marketOpen ? '' : ' (market closed: last traded prices)'}` : ''}</span></h3>
        <span class="spacer"></span><button class="btn-sm ghost danger" data-nct="delete" title="Delete this paper trade and its history (the same as Reset in Trading Ideas)">✕ Delete</button><button class="btn-sm ghost" data-nct="open" title="Open the paper trade in Trading Ideas">Open in Trading Ideas ▸</button></div>`;
    const lot = P.params.lotSize;
    const legHtml = (l, open) => {
      const now = open ? l.ltp : l.exit;
      const pnl = open ? (now == null ? null : (now - l.entry) * l.side * l.lots * lot) : l.pnl;
      return `<div class="cc-leg"><b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sold' : 'Bought'}</b> ${l.lots}× ${l.strike} ${l.type} <span class="mono">${l.entry.toFixed(1)} → ${now == null ? '—' : now.toFixed(1)}${open ? ' now' : ''}</span>${pnl == null ? '' : ` <span class="${cls(pnl)}">${inrS(pnl)}</span>`}</div>`;
    };
    const legsCell = (open, closed, t) => {
      const o = open.filter((l) => l.type === t).map((l) => legHtml(l, true));
      const c = closed.filter((l) => l.type === t).map((l) => legHtml(l, false));
      return (
        o.join('') + (c.length ? `${o.length ? '<div class="muted small">closed by rolls</div>' : ''}${c.join('')}` : '') || '<span class="muted">—</span>'
      );
    };
    const money = (v, b) => `<td class="${cls(v)}${b ? ' b' : ''}">${v == null ? '—' : inrS(v)}</td>`;
    const rows = [];
    const c = P.cycle;
    if (c) {
      const total = (c.opt ?? 0) + (c.etfOnce ?? 0);
      rows.push(`<tr><td class="l"><b>${NAME}</b></td><td class="l"><b>${monthName(c.expiry)}</b><div class="muted small">to ${dayLabel(c.expiry)}</div></td>
        <td class="l"><span class="cat-pill c-bullish">open</span></td><td class="muted">${dayLabel(c.entry.day)} ${c.entry.time}<div>Nifty ${num0(c.spot0)}${c.spot ? ' → ' + num0(c.spot) : ''}</div></td>
        <td class="l cc-legs"><div class="cc-leg"><b class="pos">Held</b> ${num0(P.etfOnce?.qty)} units <span class="mono">₹${c.etf.onceFrom.toFixed(2)} → ${c.bees ? '₹' + c.bees.toFixed(2) + ' now' : '—'}</span></div></td>
        <td class="l cc-legs">${legsCell(c.legs, c.closed, 'CE')}</td><td class="l cc-legs">${legsCell(c.legs, c.closed, 'PE')}</td>
        ${money(c.callPnl)}${money(c.putPnl)}${money(c.opt)}${money(c.etfOnce)}${money(c.opt == null ? null : total, true)}
        <td><button class="btn-sm ghost" data-nct="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices">▶ Open in Builder</button></td></tr>`);
    }
    for (const m of [...(P.months || [])].reverse())
      rows.push(`<tr><td class="l"><b>${NAME}</b></td><td class="l"><b>${monthName(m.expiry)}</b><div class="muted small">to ${dayLabel(m.expiry)}</div></td>
        <td class="l"><span class="cat-pill">closed</span></td><td class="muted">${m.entry ? dayLabel(m.entry.day) : ''}<div>Nifty ${num0(m.spot0)} → ${num0(m.spotE)}</div></td>
        <td class="l cc-legs"><div class="cc-leg"><b class="pos">Held</b> NIFTYBEES</div></td>
        <td class="l cc-legs">${legsCell([], m.closed, 'CE')}</td><td class="l cc-legs">${legsCell([], m.closed, 'PE')}</td>
        ${money(m.callPnl)}${money(m.putPnl)}${money(m.opt)}${money(m.etfOnce)}${money(m.withOnce, true)}<td></td></tr>`);
    const sum = (k) => (P.months || []).reduce((n, m) => n + (m[k] || 0), 0);
    const all = { opt: sum('opt') + (c?.opt || 0), etf: sum('etfOnce') + (c?.etfOnce || 0) };
    el.innerHTML =
      head +
      `<div class="tbl-wrap sb-trades-wrap"><table class="grid-tbl sb-trades-tbl cc-trades-tbl"><thead><tr><th class="l">Strategy</th><th class="l">Month</th><th class="l">Status</th><th>Entered</th>
        <th class="l">NIFTYBEES<br><span class="muted">units · price at the series start → now</span></th><th class="l">Call legs<br><span class="muted">lots × strike · entry → now / exit</span></th><th class="l">Put legs</th>
        <th>Call legs</th><th>Put legs</th><th>Options</th><th>NIFTYBEES</th><th>Total</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="13" class="muted l">No series open yet: the next one opens at 09:30 on the next trading day.</td></tr>'}</tbody></table></div>
      <div class="muted small pad">Whole paper trade: total <b class="${cls(all.opt + all.etf)}">${inrS(all.opt + all.etf)}</b> · options ${inrS(all.opt)} · NIFTYBEES held ${inrS(all.etf)}. P&amp;L after costs; the open series at the last traded prices. Paper only: nothing is sent.</div>`;
    el.querySelector('[data-nct="open"]')?.addEventListener('click', () => {
      tab = 'paper';
      BT.store.set('nbo-tab', tab);
      window.app.setView(VIEW);
      if (started && params) render();
    });
    el.querySelector('[data-nct="delete"]')?.addEventListener('click', async () => {
      if (!confirm(`Delete the ${NAME} paper trade and its history?`)) return;
      try {
        paper = await BT.api('/api/nbo/paper/reset', { confirm: true });
      } catch (e) {
        alert('Could not delete: ' + e.message);
      }
      renderNboTrades();
    });
    el.querySelector('[data-nct="builder"]')?.addEventListener('click', toBuilder);
  }

  function poll() {
    clearTimeout(pollT);
    if (tab !== 'paper' || window.app?.state.view !== VIEW || !started) return;
    pollT = setTimeout(async () => {
      if (!document.hidden && tab === 'paper' && window.app?.state.view === VIEW && document.activeElement?.id !== 'pscBudget') {
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
      if (!document.hidden && window.app?.state.view === 'tr') await renderNboTrades();
      pollTrades();
    }, 30_000);
  }
  function renderCompare() {
    const months = meta.monthly || [];
    const range = BT.store.get('nbo-range', { from: months[1] || '', to: months[months.length - 1] || '' });
    const opts = (cur) =>
      months
        .slice(1)
        .map((e) => `<option${e === cur ? ' selected' : ''}>${e}</option>`)
        .join('');
    const use = BT.store.get('nbo-cmp-use', 'saved');
    const savedOf = meta.rivals.filter((r) => r.saved).map((r) => r.name);
    body().innerHTML = `
      <div class="panel cc-doc">
        <h3>Compare</h3>
        <p class="small"><b>${esc(stratName())}</b> (${esc(structureText(params))}; ${esc(adjText(params).replace(/<[^>]+>/g, ''))}) against the Covered call, Put spread collar and Bull put collar.
        All run on the same monthly series with this screen's NIFTYBEES budget, ETF pricing and costs, so only the options differ.</p>
        <div class="cc-params">
          <div class="set-row"><b>Series</b> <span class="lbl">from expiry</span><select id="nboCFrom">${opts(range.from)}</select><span class="lbl">to</span><select id="nboCTo">${opts(range.to)}</select></div>
          <div class="set-row"><b>Their rules</b><select id="nboCUse"><option value="saved"${use === 'saved' ? ' selected' : ''}>their Backtest tab settings (last run), else defaults</option><option value="defaults"${use === 'defaults' ? ' selected' : ''}>their default rules</option></select>
            <span class="muted small">${savedOf.length ? `Saved settings exist for: ${savedOf.join(', ')}.` : 'None of them has a saved backtest: defaults are used.'}</span></div>
          ${budgetRow(params.budget, exState().spot)}
          <div class="set-row cc-run"><button class="btn-sm run" id="nboCmpRun">Run comparison</button>
            <span class="muted small">5 runs: yours with and without its adjustments, then the three others. The Covered call searches its ideal strikes each month, so it takes the longest.</span>
            <div class="progress hidden" id="nboProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div></div>
          ${cmpDone ? `<div class="small nbo-done">${cmpDone}</div>` : ''}
        </div>
      </div>
      <div id="nboCmpRes"></div>`;
    ['nboCFrom', 'nboCTo'].forEach((id) =>
      $(id).addEventListener('change', () => BT.store.set('nbo-range', { from: $('nboCFrom').value, to: $('nboCTo').value })),
    );
    $('nboCUse').onchange = () => BT.store.set('nbo-cmp-use', $('nboCUse').value);
    bindBudget((v) => {
      useBudget(v);
      renderCompare();
    });
    $('nboCmpRun').onclick = runCompare;
    if (job) showProgress(job.progress);
    renderCompareResults();
  }
  async function runCompare() {
    if (job) return;
    cmpDone = '';
    body().querySelector('.nbo-done')?.remove();
    try {
      job = { kind: 'compare', progress: null };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api('/api/nbo/compare', { params, name: stratName(), use: $('nboCUse').value, from: $('nboCFrom').value, to: $('nboCTo').value });
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api('/api/nbo/job?id=' + job.id);
        job.progress = j.progress;
        showProgress(j.progress);
        if (j.status === 'done') {
          raw.compare = j.result;
          rebudgetAll();
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
    } catch (e) {
      job = null;
      showProgress(null);
      if ($('nboCmpRes')) $('nboCmpRes').innerHTML = `<div class="panel empty err">Comparison failed: ${esc(e.message)}</div>`;
      return;
    }
    job = null;
    cmpDone = `✓ Comparison finished at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`;
    if (tab === 'cmp') {
      renderCompare();
      $('nboCmpRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  function renderCompareResults() {
    const el = $('nboCmpRes');
    const C = saved.compare;
    if (!C?.rows?.length) {
      el.innerHTML = '<div class="panel empty"><h3>No comparison yet</h3><p>Press Run comparison.</p></div>';
      return;
    }
    const rows = C.rows.filter((r) => r.summary?.months);
    const ref = rows[0].summary;
    const hold = { id: 'hold', name: 'NIFTYBEES alone', desc: 'bought once and held, no options', summary: ref, hold: true };
    const metric = BT.store.get('nbo-cmp-metric', 'withOnce');
    const best = [...rows].sort((a, b) => b.summary.withOnce.total - a.summary.withOnce.total)[0];
    const steadiest = [...rows].sort((a, b) => b.summary.withOnce.maxDD - a.summary.withOnce.maxDD)[0];
    const ranked = [...rows].sort((a, b) => b.summary.withOnce.total - a.summary.withOnce.total);
    const mine = rows.find((r) => r.id === 'mine');
    const place = mine ? ranked.indexOf(mine) + 1 : 0;
    const tr = (r) => {
      const s = r.summary;
      if (r.hold)
        return `<tr class="muted"><td class="l"><b>${r.name}</b><div class="small">${r.desc}</div></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
          <td class="${cls(s.hold.total)}"><b>${inrS(s.hold.total)}</b></td><td>${pct(s.hold.annPct)}</td><td class="neg">${inr(s.hold.worst)}</td><td class="neg">${inr(s.hold.maxDD)}</td><td>—</td><td>—</td><td>—</td></tr>`;
      return `<tr class="${r.id === 'mine' ? 'on' : ''}"><td class="l"><span class="nbo-dot" style="background:${CMP_COLORS[r.id] || '#888'}"></span><b>${esc(r.name)}</b>${r === best ? ' <span class="cc-kind k-book">best total</span>' : ''}${r === steadiest ? ' <span class="cc-kind k-call">smallest drawdown</span>' : ''}
          <div class="muted small">${esc(r.desc || '')}${r.from ? ` · ${esc(r.from)}` : ''}</div></td>
        <td class="${cls(s.opt.total)}"><b>${inrS(s.opt.total)}</b></td><td>${pct(s.opt.annPct)}</td><td class="neg">${inr(s.opt.worst)}</td><td>${s.opt.win}/${s.months}</td>
        <td class="${cls(s.call.total)}">${inrS(s.call.total)}</td><td class="${cls(s.put.total)}">${inrS(s.put.total)}</td>
        <td class="${cls(s.byMove.up.opt)}">${inrS(s.byMove.up.opt)}</td><td class="${cls(s.byMove.flat.opt)}">${inrS(s.byMove.flat.opt)}</td><td class="${cls(s.byMove.down.opt)}">${inrS(s.byMove.down.opt)}</td>
        <td class="cc-col-tot ${cls(s.withOnce.total)}"><b>${inrS(s.withOnce.total)}</b></td><td>${pct(s.withOnce.annPct)}</td><td class="neg">${inr(s.withOnce.worst)}</td><td class="neg">${inr(s.withOnce.maxDD)}</td>
        <td class="${cls(s.withMonthly.total)}">${inrS(s.withMonthly.total)}</td><td>${s.adjustments}</td><td>${inr(s.costs)}</td></tr>`;
    };
    // month by month: each strategy's chosen figure, the month's best in bold
    const allExp = rows[0].months.map((m) => m.expiry);
    const byId = Object.fromEntries(rows.map((r) => [r.id, new Map(r.months.map((m) => [m.expiry, m]))]));
    const mKey = metric === 'opt' ? 'opt' : 'withOnce';
    const monthRows = allExp
      .map((e) => {
        const ms = rows.map((r) => byId[r.id].get(e));
        const m0 = ms.find((m) => m?.ok);
        if (!m0) return `<tr><td class="l">${monthName(e)}</td><td colspan="${rows.length + 2}" class="muted l">${esc(ms[0]?.skip || 'left out')}</td></tr>`;
        const vals = ms.map((m) => (m?.ok ? m[mKey] : null));
        const top = Math.max(...vals.filter((v) => v != null));
        return `<tr><td class="l">${monthName(e)}</td><td>${num0(m0.spot0)} → ${num0(m0.spotE)}</td><td class="${cls(m0.move)}">${pct(m0.move)}</td>${vals
          .map((v) => (v == null ? '<td>—</td>' : `<td class="${cls(v)}">${v === top ? '<b>' : ''}${inrS(v)}${v === top ? '</b>' : ''}</td>`))
          .join('')}<td class="${cls(m0.etfOnce)}">${inrS(m0.etfOnce)}</td></tr>`;
      })
      .join('');
    const runParams = rows.find((r) => r.id === 'mine')?.params;
    const changed = runParams && structureText(runParams) !== structureText(params);
    el.innerHTML = `
      <div class="panel cc-doc">
        <h3>Result: ${dayLabel(ref.from)} – ${dayLabel(ref.to)}, ${ref.months} monthly series, ${sizeLabel(rows[0].params)}</h3>
        ${changed ? `<div class="small neg" style="margin-bottom:6px">Run with your earlier legs (${esc(structureText(runParams))}); press Run comparison for the current ones.</div>` : ''}
        <p class="cc-verdict">${mine ? `<b>${esc(mine.name)}</b> ranks <b>${place} of ${rows.length}</b> on the total with NIFTYBEES held (${inrS(mine.summary.withOnce.total)}, drawdown ${inr(mine.summary.withOnce.maxDD)}); best: <b>${esc(best.name)}</b> ${inrS(best.summary.withOnce.total)}. NIFTYBEES alone: ${inrS(ref.hold.total)}, drawdown ${inr(ref.hold.maxDD)}.` : ''}
        One period of history (${ref.months} months, ${ref.byMove.up.n} up / ${ref.byMove.flat.n} flat / ${ref.byMove.down.n} down): a ranking here is not an edge, and neighbouring rows are often a month apart.</p>
        <div class="tbl-wrap"><table class="grid-tbl nbo-cmp"><thead>
          <tr><th class="l" rowspan="2">Strategy</th><th colspan="4">Options (after costs)</th><th colspan="2">By side</th><th colspan="3">Options by month's move</th><th colspan="4" class="cc-col-tot">+ NIFTYBEES held</th><th rowspan="2">+ ETF rebought</th><th rowspan="2">Rolls</th><th rowspan="2">Costs</th></tr>
          <tr><th>Total</th><th>% / yr</th><th>Worst month</th><th>Months up</th><th>Calls</th><th>Puts</th><th>Up &gt;2 %</th><th>Flat</th><th>Down &gt;2 %</th><th class="cc-col-tot">Total</th><th>% / yr</th><th>Worst month</th><th>Max drawdown</th></tr></thead>
          <tbody>${rows.map(tr).join('')}${tr(hold)}</tbody></table></div>
        <p class="muted small">% a year on ${rows[0].params.budget > 0 ? 'the NIFTYBEES budget' : 'the ETF bought at the first entry'} (${inr(ref.invested)}). Max drawdown: the largest fall from a peak of the month-end totals. "+ ETF rebought": sold at each expiry and bought at the next entry. ${skippedText(ref)}</p>
      </div>
      <div class="panel cc-doc"><h3>Month-end total <span class="seg nbo-metric">${[
        ['withOnce', '+ NIFTYBEES held'],
        ['opt', 'Options only'],
      ]
        .map(([k, l]) => `<button class="${k === metric ? 'on' : ''}" data-metric="${k}">${l}</button>`)
        .join('')}</span></h3><div class="cc-pay-chart"><canvas id="nboCmpEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>Month by month <span class="muted small">(${metric === 'opt' ? 'options only' : 'with NIFTYBEES held'}; the month's best in bold)</span></h3>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th>${rows.map((r) => `<th>${esc(r.name)}</th>`).join('')}<th>NIFTYBEES alone</th></tr></thead>
        <tbody>${monthRows}</tbody>
        <tfoot><tr><th class="l">Total</th><td></td><td></td>${rows.map((r) => `<th class="${cls(r.summary[mKey].total)}">${inrS(r.summary[mKey].total)}</th>`).join('')}<th class="${cls(ref.hold.total)}">${inrS(ref.hold.total)}</th></tr></tfoot></table></div>
        <div class="muted small pad">Run ${new Date(C.at).toLocaleString('en-IN')}. Their full backtests (every leg and roll) are on their own tabs; yours on the Backtest tab.</div></div>`;
    el.querySelectorAll('[data-metric]').forEach((b) =>
      b.addEventListener('click', () => {
        BT.store.set('nbo-cmp-metric', b.dataset.metric);
        renderCompareResults();
      }),
    );
    const ok = rows[0].months.filter((m) => m.ok);
    const cum = (r) => {
      let s = 0;
      const by = byId[r.id];
      return ok.map((m) => (s += by.get(m.expiry)?.[mKey] || 0));
    };
    let h = 0;
    BT.chart($('nboCmpEq'), {
      type: 'line',
      data: {
        labels: ok.map((m) => monthName(m.expiry)),
        datasets: [
          ...rows.map((r) => ({
            label: r.name,
            data: cum(r),
            borderColor: CMP_COLORS[r.id] || '#888',
            borderWidth: r.id === 'mine' ? 2.5 : 1.5,
            borderDash: r.id === 'mineOff' ? [5, 3] : [],
            pointRadius: r.id === 'mine' ? 2 : 0,
          })),
          ...(metric === 'opt'
            ? []
            : [
                {
                  label: 'NIFTYBEES alone',
                  data: ok.map((m) => (h += m.etfOnce || 0)),
                  borderColor: CMP_COLORS.hold,
                  borderDash: [4, 4],
                  borderWidth: 1.5,
                  pointRadius: 0,
                },
              ]),
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}` } } },
      },
    });
  }

  window.addEventListener('viewchange', (e) => {
    if (e.detail === VIEW) {
      init();
      drawBees();
    } else poll();
    if (e.detail === 'tr') renderNboTrades().then(pollTrades);
  });
  if (window.app?.state.view === VIEW) init();
  if (window.app?.state.view === 'tr') renderNboTrades().then(pollTrades);
})();
