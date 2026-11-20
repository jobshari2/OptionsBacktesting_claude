// Trading Ideas › Put back spread: NIFTYBEES worth one lot plus, on every monthly series, a put back spread (sell 1 /
// buy 2) and up to 2 put butterflies inside its loss stretch, the strikes searched on the chain at each entry so the
// options alone lose at most a set ₹ amount at expiry (bt/pbs.js on the Covered call's runner, mccpaper.js). Built
// like the Put spread collar screen (psc-view.js): tabs Strategy & rules, Backtest (with and without re-picks, and the
// study), Paper trade and Live trade (mcclive-view.js's makeCcLive on /api/pbs/live*). Nothing here sends orders.
(() => {
  const { $, esc, inr, inrS, kinr, pct, cls, dayLabel } = BT;
  const VIEW = 'pbs';
  const NAME = 'Put back spread';
  const API = '/api/pbs';
  const TABS = [
    ['rules', 'Strategy & rules'],
    ['bt', 'Backtest'],
    ['paper', 'Paper trade'],
    ['live', 'Live trade'],
  ];
  const KIND = { entry: 'Entry', repick: 'Re-pick', keep: 'Kept', expiry: 'Expiry', skip: 'Not done', budget: 'NIFTYBEES' };
  const ADJ = new Set(['repick', 'keep']);
  const ROLE = {
    bsS: 'Sell put (back spread)',
    bsL: 'Buy puts (back spread)',
    flyW: 'Buy put (fly low wing)',
    flyS: 'Sell puts (fly centre)',
    flyU: 'Buy put (fly high wing)',
    pL: 'Buy put',
  };
  const RANKS = [
    ['protect', 'most paid back on falls (2–10 %)'],
    ['loss', 'smallest worst-case loss'],
    ['credit', 'most if Nifty stays / rises'],
  ];
  let meta = null;
  let params = null;
  let tab = BT.store.get('pbs-tab', 'rules');
  if (!TABS.some(([id]) => id === tab)) tab = 'rules';
  let saved = { backtest: null, study: null }; // as shown: raw rescaled to the NIFTYBEES budget (rebudgetAll)
  let raw = { backtest: null, study: null }; // as the server ran them
  let started = false;
  let job = null;
  let paper = null;
  let pollT = null;
  let openMonth = null;
  let viewing = null; // a study rule opened on the Backtest tab: { id, label, B, raw } (its full backtest, not saved)
  let lastDone = '';
  let exRes = null; // the worked example (/api/pbs/example)

  const num0 = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const legLine = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`;
  const body = () => $('pbsBody');
  const grpOf = (l) => (String(l.role || '').startsWith('fly') ? 'fly' : 'bs');
  const GROUP_NAME = { bs: 'Back spread', fly: 'Butterflies' };
  const ofGrp = (legs, g) => legs.filter((l) => grpOf(l) === g);
  const monthName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const shapeShort = (s) =>
    !s ? '—' : s.put != null ? `bought ${s.put} PE` : `${s.K1}/${s.K2}${s.nf ? ` + ${s.nf}× fly ${s.C - s.h}/${s.C}/${s.C + s.h}` : ''}`;

  // ---------- NIFTYBEES budget (every tab), as on the collars ----------
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
    return `<div class="set-row mcc-budget" title="₹ of NIFTYBEES bought at each entry, instead of one lot's worth (${lot} × Nifty). Only the NIFTYBEES quantity and its P&amp;L change: the options stay at their lots. Accepts 1560000, 15,60,000 or 15.6 L."><b>NIFTYBEES budget</b><span class="lbl">₹</span><input class="txt num" id="pbsBudget" value="${value > 0 ? value : ''}" placeholder="${Math.round(one)}" style="width:100px">
      <span class="muted small" id="pbsBudgetNote">${value > 0 ? `= ${num0(units)} units at Nifty ${num0(S)} (₹${(S / 100).toFixed(2)} each), ${(value / one).toFixed(2)} × one lot's worth (${inr(Math.round(one))}).` : `Empty: one lot's worth, ${lot} × Nifty = ${inr(Math.round(one))} (${num0(units)} units) at Nifty ${num0(S)}.`} The options are not changed. ${note}</span></div>`;
  }
  function useBudget(v) {
    params.budget = v;
    BT.store.set('pbs-params', params);
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
      return { n: ms.length, opt: sum('opt'), withOnce: sum('withOnce'), withMonthly: sum('withMonthly'), hold: sum('etfOnce') };
    };
    return {
      ...old,
      invested: Math.round(invested || 0),
      opt: stat('opt'),
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
    saved = { backtest: B(raw.backtest), study: raw.study && { ...raw.study, rows: raw.study.rows.map((r) => rebudget(r, b, at)) } };
    if (viewing) viewing.B = B(viewing.raw);
  }
  function bindBudget(onSet) {
    const el = $('pbsBudget');
    if (!el) return;
    el.onchange = () => {
      const v = parseBudget(el.value);
      if (!(v >= 0)) {
        $('pbsBudgetNote').innerHTML = '<span class="neg">Type a ₹ amount, e.g. 1560000 or 15.6 L (empty = one lot\'s worth).</span>';
        return;
      }
      onSet(v);
    };
  }
  // Legs under their structure: the back spread, then the butterflies.
  const groupedRows = (legs, row, n, total) =>
    ['bs', 'fly']
      .map((g) => {
        const ls = ofGrp(legs, g);
        if (!ls.length) return '';
        const sub = total ? total(ls) : '';
        return `<tr class="mcc-grp"><td class="l" colspan="${sub ? n - 1 : n}">${GROUP_NAME[g]}</td>${sub}</tr>${ls.map(row).join('')}`;
      })
      .join('');

  // ---------- the screen opened ----------
  function applyIdea() {
    init();
    poll();
    drawBees();
  }
  async function init() {
    if (started) return;
    started = true;
    try {
      meta = await BT.api(API + '/meta');
    } catch (e) {
      body().innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      started = false;
      return;
    }
    const stored = BT.store.get('pbs-params', {});
    params = { ...deep(meta.defaults), ...stored };
    for (const k of ['bs', 'pick', 'fixed', 'adj', 'costs']) params[k] = { ...meta.defaults[k], ...(stored[k] || {}) };
    params.lotSize = meta.lot;
    const [b, s] = await Promise.all([BT.api(API + '/backtest').catch(() => ({})), BT.api(API + '/study').catch(() => ({}))]);
    raw = { backtest: b.saved || null, study: s.saved || null };
    rebudgetAll();
    render();
  }
  function render() {
    $('pbsTabs').innerHTML = TABS.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('');
    if (tab === 'rules') renderRules();
    else if (tab === 'bt') renderBacktest();
    else if (tab === 'live') live.render(body());
    else renderPaper();
    poll();
    drawBees();
  }

  // NIFTYBEES to buy for a new trade (public/bees-need.js), under the tab bar on every tab but Live trade (as on the Put
  // spread collar): the Backtest tab budget and lots, at Nifty and NIFTYBEES now (as Enter new trade sizes them). The Live
  // trade tab shows its own (with no trade: large, and Enter new trade takes the same units and price to the Builder).
  // Refreshed every 30 s.
  let beesT = null;
  async function drawBees() {
    clearTimeout(beesT);
    const el = $('pbsBees');
    if (!el || !params) return;
    if (tab === 'live' || window.app?.state.view !== VIEW) {
      el.innerHTML = '';
      return;
    }
    await window.BeesNeed?.fill(el, {
      budget: params.budget,
      lots: params.lots,
      title: `NIFTYBEES to buy for a new ${NAME}`,
      note: params.budget > 0 ? 'set on the Backtest tab (NIFTYBEES budget)' : 'a NIFTYBEES budget on the Backtest tab changes it',
    });
    beesT = setTimeout(drawBees, 30_000);
  }
  // The Live trade tab: the collars' (mcclive-view.js) on this strategy's routes and names. "Enter new trade" runs the
  // search on the expiry's live chain with the Backtest tab's search settings and lots.
  const live = window.makeCcLive({
    view: VIEW,
    tabs: 'pbsTabs',
    api: API,
    storeKey: 'pbslive-key',
    name: NAME,
    names: { CE: 'Calls', PE: 'Puts (back spread + flies)', ce: 'Calls', pe: 'Puts' },
    shapeText: 'sell 1 PE / buy 2 PE + put butterflies, strikes searched on the live chain within the options loss limit',
    shapeShort: 'put back spread',
    flag: { kind: 'pbs' },
    adjust: true, // Legs and payoff › Adjustments (loss-less changes), as on the Put spread collar
    guide: true, // 🧭 the guided new trade: expiry → NIFTYBEES → strikes (💡 Suggestion) → Builder
    planBody: () => ({
      params: params && { lots: params.lots, bs: params.bs, pick: params.pick, fixed: params.fixed, costs: params.costs, budget: params.budget },
    }),
  });
  body().addEventListener('click', (e) => {
    const rule = e.target.closest('tr[data-rule]')?.dataset.rule;
    if (rule) return openRule(rule);
    const m = e.target.closest('tr[data-adj-m]')?.dataset.adjM;
    if (m) {
      openMonth = m;
      renderResults();
      body().querySelector(`#pbsRes tr[data-m="${m}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
  async function openRule(id) {
    const row = saved.study?.rows?.find((r) => r.id === id);
    if (!row || job) return;
    if (tab !== 'bt') {
      tab = 'bt';
      BT.store.set('pbs-tab', tab);
      render();
    }
    const ok = row.months.filter((m) => m.ok);
    const range = { from: ok[0]?.expiry, to: ok[ok.length - 1]?.expiry };
    lastDone = '';
    try {
      job = { kind: 'run', progress: null };
      showProgress({ phase: 'Opening ' + row.label, done: 0, total: 0 });
      const r = await BT.api(API + '/run', { params: row.params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(300);
        const j = await BT.api(API + '/job?id=' + job.id);
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
      if ($('pbsRes')) $('pbsRes').innerHTML = `<div class="panel empty err">Could not open the rule: ${esc(err.message)}</div>`;
      return;
    }
    job = null;
    openMonth = null;
    if (tab === 'bt') {
      renderBacktest();
      $('pbsRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  $('pbsTabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t || t === tab) return;
    tab = t;
    BT.store.set('pbs-tab', tab);
    render();
  });

  // ---------- payoff ----------
  const optAt = (legs, x, lot) => legs.reduce((s, l) => s + l.side * (Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x) - l.entry) * l.lots * lot, 0);
  const STRUCT = [
    ['bs', 'Back spread', '#d6af4c'],
    ['fly', 'Butterflies', '#3fb68b'],
  ];
  function payoffChart(canvas, legs, lot, spot, etf, extraNote) {
    const home = [Math.floor((spot * 0.88) / 50) * 50, Math.ceil((spot * 1.06) / 50) * 50];
    const lo = Math.floor((spot * 0.7) / 50) * 50;
    const hi = Math.ceil((spot * 1.3) / 50) * 50;
    const xs = [];
    for (let x = lo; x <= hi; x += 25) xs.push(x);
    const opt = xs.map((x) => ({ x, y: Math.round(optAt(legs, x, lot)) }));
    const sets = [{ label: 'Options only', data: opt, borderColor: '#b392f0', borderWidth: 2, pointRadius: 0 }];
    for (const [g, label, color] of STRUCT)
      if (ofGrp(legs, g).length)
        sets.push({
          label,
          data: xs.map((x) => ({ x, y: Math.round(optAt(ofGrp(legs, g), x, lot)) })),
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
    const yAll = sets.flatMap((s) => s.data.filter((p) => p.x >= home[0] && p.x <= home[1]).map((p) => p.y));
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

  // ---------- Strategy & rules ----------
  const exDefaults = () => ({ spot: 25000, iv: 13, days: 45, skew: 0.5, units: unitsFor(params, 25000) });
  const exState = () => ({ ...exDefaults(), ...BT.store.get('pbs-ex', {}) });
  const studyRow = (id) => saved.study?.rows?.find((r) => r.id === id) || null;
  const exSrc = () => {
    const ex = exState();
    return exRes?.legs?.length
      ? { id: 'ex', label: 'Example (model chain)', spot: exRes.S, legs: exRes.legs.map((l) => ({ ...l, entry: l.px })), units: ex.units, b0: exRes.S / 100 }
      : null;
  };

  // A position to move Nifty under: { id, label, spot, legs, units, b0 }.
  function animSources() {
    const out = [];
    const e = exSrc();
    if (e) out.push(e);
    const c = paper?.paper?.cycle;
    if (c?.legs?.length)
      out.push({
        id: 'paper',
        label: 'Your paper month',
        spot: c.spot0,
        legs: c.legs,
        units: paper.paper.etfOnce?.qty || exState().units,
        b0: c.etf?.b0 || c.spot0 / 100,
      });
    const m = saved.backtest?.withAdj?.months?.filter((x) => x.ok).slice(-1)[0];
    if (m)
      out.push({
        id: 'bt',
        label: `Backtest: ${monthName(m.expiry)} as entered`,
        spot: m.spot0,
        legs: m.entry.legs,
        units: m.etf?.qtyOnce || exState().units,
        b0: m.etf?.bees0 || m.spot0 / 100,
      });
    return out;
  }
  // P&L of each part at expiry with Nifty at x.
  function parts(src, x) {
    const lot = params.lotSize;
    const etf = src.units * src.b0 * (x / src.spot - 1);
    const bs = optAt(ofGrp(src.legs, 'bs'), x, lot);
    const fly = optAt(ofGrp(src.legs, 'fly'), x, lot);
    return { etf, bs, fly, opt: bs + fly, total: etf + bs + fly };
  }
  function zoneText(src, x) {
    const k = (role) => src.legs.find((l) => l.role === role)?.strike;
    const [K1, K2, P] = ['bsS', 'bsL', 'pL'].map(k);
    const v = parts(src, x);
    const f = (n) => `<b class="${cls(n)}">${inrS(n)}</b>`;
    if (P != null)
      return x < P
        ? `Under the bought put (${P}): it gains a point for every point Nifty falls, so NIFTYBEES (${f(v.etf)}) is hedged from here down. Total ${f(v.total)}.`
        : `Above the bought put (${P}): it expires worthless (${f(v.opt)}); NIFTYBEES ${f(v.etf)}.`;
    if (K1 == null) return '';
    if (x >= K1)
      return `Above the sold put (${K1}): every put expires worthless, the options keep their net premium ${f(v.opt)} (back spread ${f(v.bs)}, butterflies ${f(v.fly)}). NIFTYBEES keeps its whole move (${f(v.etf)}): no sold call caps it.`;
    if (x >= K2)
      return `Inside the back spread's loss stretch (${K2} – ${K1}): the sold put is in the money, the two bought ones not yet, so the back spread loses (${f(v.bs)}). The butterflies are there for this stretch: ${f(v.fly)}. Options ${f(v.opt)}, NIFTYBEES ${f(v.etf)}, total ${f(v.total)}.`;
    if (x >= K2 - (K1 - K2))
      return `Just under the bought puts (${K2}): they gain 2 points for each point Nifty falls, the sold one loses 1 — the back spread climbs back (${f(v.bs)}); butterflies ${f(v.fly)}. Options ${f(v.opt)}, NIFTYBEES ${f(v.etf)}, total ${f(v.total)}.`;
    return `Far under the strikes (below ${K2 - (K1 - K2)}): net one bought put, so the options gain a point for every point Nifty falls (${f(v.opt)}) and NIFTYBEES (${f(v.etf)}) is hedged from here on: the total stays at ${f(v.total)} however far Nifty falls.`;
  }

  function renderRules() {
    const lot = params.lotSize;
    const ex = exState();
    const S = ex.spot;
    const st = saved.study;
    const r0 = studyRow('none');
    const rU = studyRow('move2');
    const rA = st ? [...st.rows].sort((x, y) => y.summary.withOnce.total - x.summary.withOnce.total)[0] : null;
    const mm = BT.store.get('pbs-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
    const budget = params.budget > 0;
    const p = params;
    const P = p.pick;
    const selP = (k, cur, opts) =>
      `<select data-pk="${k}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    body().innerHTML = `
      <div class="panel cc-doc">
        <h3>${NAME} against NIFTYBEES</h3>
        ${budgetRow(p.budget, S, 'Used across this tab, the Backtest and its study (shown for it without re-running) and the paper trade.')}
        <p>Hold NIFTYBEES worth ${budget ? `your budget, ${inr(p.budget)} (the options below stay at one lot)` : `one lot of Nifty (65 × Nifty, about ₹${((S * lot) / 1e5).toFixed(1)} L at Nifty ${num0(S)})`}, as in the collars. Each <b>monthly</b> series, on its first trading day, open and hold to the monthly expiry:</p>
        <ul>
          <li><b>Put back spread</b>: sell ${p.bs.sell} lot PE at K1, buy ${p.bs.buy} lots PE at K2 = K1 − W. Net <b>one bought put</b>: far enough under K2 the options gain a point for every point Nifty falls, which is exactly what one lot of NIFTYBEES loses — the holding is hedged from there down. Above K1 every put expires worthless and the options keep their net premium; <b>no call is sold</b>, so the NIFTYBEES' upside stays open.</li>
          <li><b>The back spread's weak spot</b>: between K2 − W and K1 it loses, most at K2 (W points less the premium). The original put back spread just takes that dip.</li>
          <li><b>Put butterflies</b> (up to ${P.flies} per lot): buy n at C − h, sell 2n at C, buy n at C + h, with C inside that loss stretch. A butterfly pays only near its centre — exactly where the back spread loses — and costs little, so it fills the dip.</li>
        </ul>
      </div>

      <div class="panel cc-doc">
        <h3>How the strikes are picked: a search on the chain, not fixed distances</h3>
        <p>At every entry (and every re-pick) the PE chain of that minute is searched: every sold strike K1 from ATM + ${P.top} down to ATM − ${P.bottom}, every width W (${P.widths.join(', ')}), every butterfly centre C inside the loss stretch, every half-width h (${P.wings.join(', ')}) and 0 – ${P.flies} butterflies per lot — a few thousand structures, each priced at the chain's prices with ${p.costs.slipPct} % slippage, ₹${p.costs.brokerage} an order, STT and charges. For each, the <b>options-only P&L at expiry</b> is worked out at every Nifty level (it bends only at strikes; under the lowest it rises, net one bought put), and so its <b>worst case</b> anywhere.</p>
        <ol>
          <li><b>Loss limit</b>: keep only those whose worst options loss at expiry is within <b>${inr(P.maxLoss)} per lot</b> (after costs) — at any Nifty level, up or down.</li>
          <li><b>Rank</b> the rest: ${esc(RANKS.find((r) => r[0] === P.rank)?.[1] || P.rank)}. None within the limit: the one with the smallest worst case.</li>
        </ol>
        <p><b>Why not "no loss at all"?</b> At market prices a structure that is never under zero anywhere would be free money, so it is not on offer (the search shows it: with a ₹0 limit it falls back to the least loss, usually a ₹2–4 K debit per lot). The loss limit is the price you choose to pay each month for the protection — the study on the Backtest tab compares ₹0, 1 K, 2.5 K, 5 K and 10 K.</p>
        <p><b>What is different from Live › Ideas › Back spreads:</b> that section fixes the geometry (centre halfway between the back spread's strikes, 2 butterflies with wings at ± 1.5 W) and ranks by the loss alone, which pushes the trade to the edge of the strike window; it also looks at the options by themselves. Here the butterflies' centre, width and number are free, the worst case is capped in ₹ after every cost <i>before</i> the trade is entered, the rank is about the NIFTYBEES it protects, and it is backtested month by month with the NIFTYBEES.${ideasVs()}</p>
      </div>

      <div class="panel cc-doc cc-ex">
        <h3>Example: the search on a model chain</h3>
        <div class="set-row">
          <span class="lbl">Nifty</span><input class="txt num" data-pex="spot" value="${ex.spot}">
          <span class="lbl">ATM IV %</span><input class="txt num" data-pex="iv" value="${ex.iv}" style="width:45px">
          <span class="lbl">put skew (IV pts per 1 % under)</span><input class="txt num" data-pex="skew" value="${ex.skew}" style="width:45px">
          <span class="lbl">days to expiry</span><input class="txt num" data-pex="days" value="${ex.days}" style="width:45px">
          <span class="lbl">NIFTYBEES qty</span><input class="txt num" data-pex="units" value="${ex.units}">
        </div>
        <div class="set-row">
          <b>Search</b><span class="lbl">options loss limit ₹ / lot</span><input class="txt num" data-pk="maxLoss" value="${P.maxLoss}" style="width:70px">
          <span class="lbl">rank</span>${selP('rank', P.rank, RANKS)}
          <span class="lbl">butterflies up to</span>${selP('flies', P.flies, [
            [0, 'none (back spread alone)'],
            [1, '1 per lot'],
            [2, '2 per lot'],
          ])}
          <span class="muted small">The same settings as the Backtest tab (changing them here changes them there).</span>
        </div>
        <div id="pbsExOut" class="small muted">Searching…</div>
        <div class="cc-pay" style="margin-top:8px"><div class="cc-pay-chart"><canvas id="pbsExPay"></canvas></div></div>
        <div class="tbl-wrap" id="pbsExTbl"></div>
        <p class="muted small">A model chain: Black-Scholes at the IV typed, plus the skew for puts under the money (Nifty's puts are dearer the further down they are). The live chain is searched the same way on the Live trade tab ("Enter new trade") and by the paper trade.</p>
      </div>

      <div class="panel cc-doc">
        <h3>What happens when Nifty moves</h3>
        <h4>One expiry: Nifty from −25 % to +25 %</h4>
        <p class="muted small">Press ▶ Play (or drag the slider, or the ▲ / ▼ buttons) to move Nifty: the P&L at expiry of NIFTYBEES, the back spread and the butterflies, the options together and the total with NIFTYBEES.</p>
        <div class="set-row mcc-anim-ctl">
          <span class="seg sm" id="pbsAnSrc"></span>
          <button class="btn-sm ghost" id="pbsAnPlay">▶ Play</button>
          ${[-20, -10, -5].map((x) => `<button class="btn-sm ghost" data-bmv="${x}">▼ ${-x} %</button>`).join('')}<button class="btn-sm ghost" data-bmv="0">Back to entry</button>${[5, 10, 20].map((x) => `<button class="btn-sm ghost" data-bmv="${x}">▲ ${x} %</button>`).join('')}
          <span class="lbl">Nifty move</span><input type="range" id="pbsAnRange" min="-25" max="25" step="0.5" value="0" style="width:200px">
          <b id="pbsAnLbl"></b>
        </div>
        <div class="muted small" id="pbsAnPos"></div>
        <div class="cc-ex-grid" style="margin-top:8px">
          <div><div class="mcc-bars" id="pbsAnBars"></div><p class="small" id="pbsAnZone" style="margin-top:8px"></p></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="pbsAnPay"></canvas></div></div>
        </div>

        <h4 style="margin-top:14px">Month by month: the strategy entered again every month</h4>
        <div class="set-row">
          <span class="seg sm" id="pbsMmMode"><button data-m="model" class="${mm.mode === 'model' ? 'on' : ''}">Model path</button><button data-m="real" class="${mm.mode === 'real' ? 'on' : ''}">Real months (backtest)</button></span>
          <span class="pbs-mm-model${mm.mode === 'model' ? '' : ' hidden'}">
            <span class="lbl">Nifty over the period</span><input class="txt num" id="pbsMmPct" value="${mm.pct}" style="width:50px"><span class="lbl">% over</span>
            <select id="pbsMmN">${[3, 6, 12, 24].map((n) => `<option value="${n}"${n === mm.months ? ' selected' : ''}>${n} months</option>`).join('')}</select>
            <span class="lbl">IV %</span><input class="txt num" id="pbsMmIv" value="${mm.iv}" style="width:45px">
            <label class="lbl"><input type="checkbox" id="pbsMmSw"${mm.swings ? ' checked' : ''}> weekly swings</label>
          </span>
          <button class="btn-sm ghost" id="pbsMmPlay">▶ Play the months</button>
          <span class="lbl">Month</span><input type="range" id="pbsMmIdx" min="0" max="0" value="0" style="width:180px">
        </div>
        <p class="muted small" id="pbsMmNote"></p>
        <div class="cc-ex-grid">
          <div><div class="mcc-bars" id="pbsMmBars"></div><div class="small" id="pbsMmText" style="margin-top:8px"></div></div>
          <div class="cc-pay"><div class="cc-pay-chart"><canvas id="pbsMmChart"></canvas></div></div>
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
        <h3>Hold to expiry or re-pick? How much loss to allow? What the backtest says</h3>
        ${variantsHtml()}
      </div>

      <div class="panel cc-doc">
        <h3>Rules</h3>
        <table class="grid-tbl cc-rules"><tbody>
          <tr><th>Entry</th><td>First trading day of each monthly series (the day after the previous monthly expiry), 09:30. Monthly expiries only. Strikes from the search above on that minute's chain; legs with no trade then are not used.</td></tr>
          <tr><th>Holding</th><td>NIFTYBEES worth ${budget ? `your budget, ${inr(p.budget)}` : '65 × Nifty (one lot; set a budget at the top for another amount)'}. Tested both ways: <b>bought once and held</b>, and <b>sold at each expiry and rebought</b> at the next series start.</td></tr>
          <tr><th>Options</th><td>Put back spread ${p.bs.sell} × ${p.bs.buy} (lots per NIFTYBEES lot) + 0 – ${P.flies} put butterflies, options-only loss at expiry ≤ ${inr(P.maxLoss)} a lot, ranked by ${esc(RANKS.find((r) => r[0] === P.rank)?.[1] || P.rank)}. Defined risk: every sold put is covered by a bought one.</td></tr>
          <tr><th>Adjustments (your choice)</th><td><b>Hold to expiry</b>: nothing is changed during the month. <b>Re-pick</b>: once Nifty has moved ${p.adj.movePct} % from the entry or the last re-pick (${{ both: 'either way', up: 'only after rises', down: 'only after falls' }[p.adj.dir]}), checked ${p.adj.check === 'hourly' ? 'every hour' : 'at 15:00'}, close every option and run the search again at the new Nifty — after a rise the protection moves up under the higher NIFTYBEES, after a fall the bought puts' gain is booked and the hedge set again lower. At most ${p.adj.maxPerSide} a month, none in the last ${p.adj.lastDays} trading days. Currently: <b>${p.adj.on ? 'Re-pick' : 'Hold to expiry'}</b> (Backtest tab › Adjustments).</td></tr>
          <tr><th>Exit</th><td>Held to the monthly expiry, settled at Nifty's close. No stop-loss: the worst case of the options is fixed at entry by the loss limit.</td></tr>
          <tr><th>When to re-pick (suggested)</th><td>${rulesWhen(rU, r0)}</td></tr>
          <tr><th>Best rule in the study</th><td>${
            rA && r0
              ? `<b>${esc(rA.label)}</b>: ${inrS(rA.summary.withOnce.total)} with NIFTYBEES held (options ${inrS(rA.summary.opt.total)}) vs ${inrS(r0.summary.withOnce.total)} for the default search held to expiry; drawdown ${inr(rA.summary.withOnce.maxDD)} vs ${inr(r0.summary.withOnce.maxDD)} (NIFTYBEES alone ${inr(r0.summary.hold.maxDD)}). Click it in the study for its full backtest.`
              : 'Run the study on the Backtest tab.'
          }</td></tr>
          <tr><th>Costs</th><td>${p.costs.slipPct} % slippage on every option fill, ₹${p.costs.brokerage} per order, STT and exchange charges by date, STT on bought options that expire in the money. ETF: 0.05 % slippage plus stamp duty and fees.</td></tr>
        </tbody></table>
      </div>

      <div class="panel cc-doc">
        <h3>The study</h3>
        ${st ? studyTable(st, true) : '<p class="muted">The study has not been run yet. Run it on the Backtest tab ("Run study").</p>'}
        ${st && r0 ? `<p class="muted small">Study run ${new Date(st.at).toLocaleString('en-IN')} with ${sizeLabel(st.rows[0]?.params)}, ${r0.summary.months} monthly series ${r0.summary.from ? `(${dayLabel(r0.summary.from)} – ${dayLabel(r0.summary.to)})` : ''}. ${skippedText(r0.summary)} Only ${r0.summary.byMove.up.n} of the months rose and ${r0.summary.byMove.down.n} fell more than 2 %: too few to be sure about any one rule.</p>` : ''}
      </div>`;
    bindBudget((v) => {
      useBudget(v);
      BT.store.set('pbs-ex', { ...exState(), units: unitsFor(params, exState().spot) });
      renderRules();
    });
    body()
      .querySelectorAll('[data-pex]')
      .forEach(
        (el) =>
          (el.onchange = () => {
            const e2 = exState();
            e2[el.dataset.pex] = Number(el.value) || (el.dataset.pex === 'skew' ? 0 : e2[el.dataset.pex]);
            if (el.dataset.pex === 'spot' && params.budget > 0) e2.units = unitsFor(params, e2.spot);
            BT.store.set('pbs-ex', e2);
            loadExample();
          }),
      );
    body()
      .querySelectorAll('[data-pk]')
      .forEach(
        (el) =>
          (el.onchange = () => {
            setParam('pick.' + el.dataset.pk, el.value);
            loadExample();
          }),
      );
    bindAnim();
    bindMm();
    loadExample();
  }

  // ----- the worked example -----
  let exSeq = 0;
  async function loadExample() {
    const ex = exState();
    const seq = ++exSeq;
    if ($('pbsExOut')) $('pbsExOut').textContent = 'Searching…';
    try {
      const r = await BT.api(API + '/example', { S: ex.spot, iv: ex.iv, days: ex.days, skew: ex.skew, params });
      if (seq !== exSeq) return;
      exRes = r;
    } catch (e) {
      if ($('pbsExOut')) $('pbsExOut').innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      return;
    }
    if (tab !== 'rules' || !$('pbsExOut')) return;
    drawExample();
    bindAnim();
  }
  function drawExample() {
    const r = exRes;
    const ex = exState();
    const lot = r.lot;
    const s = r.shape;
    const legs = r.legs.map((l) => ({ ...l, entry: l.px }));
    const src = { spot: r.S, legs, units: ex.units, b0: r.S / 100 };
    const net = legs.reduce((a, l) => a - l.side * l.entry * l.lots * lot, 0);
    $('pbsExOut').classList.remove('muted');
    $('pbsExOut').innerHTML = s
      ? `<div class="mcc-best"><span class="cc-kind k-book">Picked</span> <b>${esc(r.text)}</b>
        <br>${num0(s.n)} structures priced on the chain; ${s.hit ? `within the ${inr(s.maxLoss)} limit, ranked by ${esc(RANKS.find((x) => x[0] === s.rank)?.[1] || s.rank)}` : `<span class="neg">none within the ${inr(s.maxLoss)} limit</span>: the one with the least loss`}.
        Options under water at worst <b class="${cls(s.worst)}">${inrS(s.worst)}</b>; ${s.lowBE ? `in profit again under Nifty <b>${num0(s.lowBE)}</b> (${pct(((s.lowBE - r.S) / r.S) * 100)})` : ''}.</div>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Leg</th><th>Strike</th><th>From ATM</th><th>Model price</th><th>₹ at entry</th></tr></thead><tbody>
        ${groupedRows(
          legs,
          (l) =>
            `<tr><td class="l">${ROLE[l.role] || legLine(l)} · ${l.lots} lot${l.lots > 1 ? 's' : ''}</td><td>${l.strike}</td><td>${l.strike - Math.round(r.S / 50) * 50 >= 0 ? '+' : ''}${l.strike - Math.round(r.S / 50) * 50}</td><td>${l.px.toFixed(2)}</td><td class="${cls(-l.side)}">${inrS(-l.side * l.px * l.lots * lot)}</td></tr>`,
          5,
        )}
        <tr class="mcc-tot"><td class="l" colspan="4">Net ${net >= 0 ? 'credit' : 'debit'} before costs</td><td class="${cls(net)}"><b>${inrS(net)}</b></td></tr></tbody></table></div>`
      : '<span class="neg">No structure could be priced on this chain.</span>';
    payoffChart($('pbsExPay'), legs, lot, r.S, { qty: ex.units, b0: r.S / 100, s0: r.S }, 'example, before costs');
    if (!s) return;
    const k = (role) => legs.find((l) => l.role === role)?.strike;
    const levels = [
      ...new Set(
        [r.S * 0.9, r.S * 0.95, k('bsL') - (k('bsS') - k('bsL')), k('bsL'), s.C, k('bsS'), r.S, r.S * 1.05].filter((x) => x > 0).map((x) => Math.round(x)),
      ),
    ].sort((a, b) => a - b);
    const tag = (x) =>
      ({
        [k('bsS')]: 'sold put K1',
        [k('bsL')]: 'bought puts K2',
        [s.C]: 'fly centre',
        [Math.round(r.S)]: 'entry',
        [k('bsL') - (k('bsS') - k('bsL'))]: 'K2 − W',
      })[x] || '';
    const inv = ex.units * (r.S / 100);
    $('pbsExTbl').innerHTML =
      `<table class="grid-tbl"><thead><tr><th class="l">Nifty at expiry</th><th>NIFTYBEES</th><th class="cc-col-opt">Back spread</th><th class="cc-col-opt">Butterflies</th><th>Options</th><th>% of NIFTYBEES</th><th class="cc-col-tot">With NIFTYBEES</th><th>NIFTYBEES alone</th></tr></thead><tbody>
      ${levels
        .map((x) => {
          const v = parts(src, x);
          return `<tr><td class="l">${num0(x)} <span class="muted small">${tag(x)}</span></td><td class="${cls(v.etf)}">${inrS(v.etf)}</td><td class="cc-col-opt ${cls(v.bs)}">${inrS(v.bs)}</td><td class="cc-col-opt ${cls(v.fly)}">${inrS(v.fly)}</td><td class="${cls(v.opt)}">${inrS(v.opt)}</td><td>${pct((v.opt / inv) * 100)}</td><td class="cc-col-tot ${cls(v.total)}">${inrS(v.total)}</td><td class="${cls(v.etf)}">${inrS(v.etf)}</td></tr>`;
        })
        .join(
          '',
        )}</tbody></table><div class="muted small">Model prices, before slippage and charges (the search itself counts them: its worst case is after costs).</div>`;
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
  const anim = { src: BT.store.get('pbs-an-src', 'ex'), move: 0, timer: null, chart: null };
  function bindAnim() {
    clearInterval(anim.timer);
    anim.timer = null;
    anim.chart = null;
    if (!$('pbsAnSrc')) return;
    const srcs = animSources();
    if (!srcs.length) {
      $('pbsAnPos').textContent = 'Waiting for the example…';
      return;
    }
    if (!srcs.find((s) => s.id === anim.src)) anim.src = srcs[0].id;
    $('pbsAnSrc').innerHTML = srcs.map((s) => `<button data-s="${s.id}" class="${s.id === anim.src ? 'on' : ''}">${esc(s.label)}</button>`).join('');
    $('pbsAnSrc').onclick = (e) => {
      const id = e.target.closest('[data-s]')?.dataset.s;
      if (!id) return;
      anim.src = id;
      BT.store.set('pbs-an-src', id);
      bindAnim();
    };
    $('pbsAnRange').oninput = (e) => {
      stopAnim();
      anim.move = Number(e.target.value);
      drawAnim(false);
    };
    body()
      .querySelectorAll('[data-bmv]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            stopAnim();
            anim.move = Number(b.dataset.bmv);
            drawAnim(false);
          }),
      );
    $('pbsAnPlay').onclick = () => {
      if (anim.timer) return stopAnim();
      $('pbsAnPlay').textContent = '❚❚ Pause';
      let dir = 1;
      anim.timer = setInterval(() => {
        if (!document.body.contains($('pbsAnPlay'))) return stopAnim();
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
    if ($('pbsAnPlay')) $('pbsAnPlay').textContent = '▶ Play';
  }
  function drawAnim(full) {
    const src = animSources().find((s) => s.id === anim.src);
    if (!src) return;
    const x = src.spot * (1 + anim.move / 100);
    $('pbsAnRange').value = anim.move;
    $('pbsAnLbl').textContent = `Nifty ${num0(x)} (${anim.move >= 0 ? '+' : ''}${anim.move.toFixed(1)} %) · NIFTYBEES ₹${((src.b0 * x) / src.spot).toFixed(2)}`;
    const leg = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} @${l.entry.toFixed(1)}`;
    $('pbsAnPos').innerHTML =
      `Position: ${esc(src.label)} — Nifty ${num0(src.spot)}, ${num0(src.units)} NIFTYBEES at ₹${src.b0.toFixed(2)} · <b>back spread</b> ${ofGrp(src.legs, 'bs').map(leg).join(', ') || '—'} · <b>butterflies</b> ${ofGrp(src.legs, 'fly').map(leg).join(', ') || '—'}. Everything at its expiry, before costs.`;
    const v = parts(src, x);
    let scale = 0;
    for (let m = -25; m <= 25; m += 1) {
      const q = parts(src, src.spot * (1 + m / 100));
      scale = Math.max(scale, ...Object.values(q).map(Math.abs));
    }
    bars(
      $('pbsAnBars'),
      [
        ['NIFTYBEES', v.etf],
        ['Back spread', v.bs],
        ['Butterflies', v.fly],
        ['Without NIFTYBEES (options)', v.opt, '', true],
        ['With NIFTYBEES (total)', v.total, '', true],
      ],
      scale,
    );
    $('pbsAnZone').innerHTML = zoneText(src, x);
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
      anim.chart = BT.chart($('pbsAnPay'), {
        type: 'line',
        data: {
          datasets: [
            line('With NIFTYBEES', (q) => q.total, '#58a6ff'),
            line('Without NIFTYBEES (options)', (q) => q.opt, '#b392f0'),
            line('Back spread', (q) => q.bs, '#d6af4c', { borderWidth: 1.5, borderDash: [5, 3] }),
            line('Butterflies', (q) => q.fly, '#3fb68b', { borderWidth: 1.5, borderDash: [5, 3] }),
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
  const mmOpts = () => BT.store.get('pbs-mm', { mode: 'model', pct: 10, months: 12, iv: 13, swings: true });
  function bindMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    const save = () => {
      BT.store.set('pbs-mm', {
        ...mmOpts(),
        pct: Number($('pbsMmPct').value) || 0,
        months: Number($('pbsMmN').value) || 12,
        iv: Number($('pbsMmIv').value) || 13,
        swings: $('pbsMmSw').checked,
      });
      loadMm();
    };
    ['pbsMmPct', 'pbsMmN', 'pbsMmIv', 'pbsMmSw'].forEach((id) => ($(id).onchange = save));
    $('pbsMmMode').onclick = (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      BT.store.set('pbs-mm', { ...mmOpts(), mode: m });
      $('pbsMmMode')
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      body()
        .querySelector('.pbs-mm-model')
        .classList.toggle('hidden', m !== 'model');
      loadMm();
    };
    $('pbsMmIdx').oninput = (e) => {
      stopMm();
      mmState.idx = Number(e.target.value);
      drawMm();
    };
    $('pbsMmPlay').onclick = () => {
      if (mmState.timer) return stopMm();
      if (mmState.idx >= mmState.rows.length - 1) mmState.idx = -1;
      $('pbsMmPlay').textContent = '❚❚ Pause';
      mmState.timer = setInterval(() => {
        if (!document.body.contains($('pbsMmPlay')) || mmState.idx >= mmState.rows.length - 1) return stopMm();
        mmState.idx++;
        drawMm();
      }, 700);
    };
    loadMm();
  }
  function stopMm() {
    clearInterval(mmState.timer);
    mmState.timer = null;
    if ($('pbsMmPlay')) $('pbsMmPlay').textContent = '▶ Play the months';
  }
  async function loadMm() {
    stopMm();
    const o = mmOpts();
    const seq = ++mmState.seq;
    let rows = [];
    if (o.mode === 'real') {
      const B = saved.backtest;
      if (!B) {
        $('pbsMmNote').textContent = 'No backtest saved yet: run one on the Backtest tab.';
        mmState.rows = [];
        return drawMm();
      }
      const none = new Map(B.without.months.map((m) => [m.expiry, m]));
      const one = (x) => (x?.ok ? { opt: x.opt, etf: x.etfOnce, total: x.withOnce, adjustments: x.adjustments, events: x.events } : null);
      rows = B.withAdj.months
        .filter((m) => m.ok)
        .map((m) => ({ label: monthName(m.expiry), spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(none.get(m.expiry)) }));
      $('pbsMmNote').textContent =
        `The backtest's months (${rows.length}, ${sizeLabel(B.withAdj.params)}, ${B.withAdj.params.adj.on ? 'with re-picks' : 'held to expiry'}) next to the same months held to expiry, NIFTYBEES held throughout.`;
    } else {
      $('pbsMmNote').textContent = 'Working…';
      let r;
      try {
        r = await BT.api(API + '/model', { params, opts: { S0: exState().spot, pct: o.pct, months: o.months, iv: o.iv, swings: o.swings } });
      } catch (e) {
        $('pbsMmNote').textContent = e.message;
        return;
      }
      if (seq !== mmState.seq) return;
      const one = (x) => ({ opt: x.opt, etf: x.etf, total: x.total, adjustments: x.adjustments, events: x.events });
      rows = r.withAdj.map((m, i) => ({ label: `Month ${i + 1}`, spot0: m.spot0, spotE: m.spotE, adj: one(m), none: one(r.without[i]) }));
      $('pbsMmNote').textContent =
        `The strategy entered afresh every month (the Backtest tab's settings, ${sizeLabel(params)}, ${params.adj.on ? 're-picks on' : 'held to expiry'}), the search run on a Black-Scholes chain at ${o.iv} % IV (no skew), while Nifty moves the same % each month (${o.pct} % over ${o.months} months; a negative % for a falling market). ${o.swings ? 'With weekly swings Nifty zig-zags about one typical week’s move inside each month, which is what triggers re-picks.' : 'Without weekly swings no re-pick triggers unless the trend alone moves enough.'} A model, not a forecast.`;
    }
    mmState.rows = rows;
    mmState.idx = Math.min(mmState.idx, Math.max(0, rows.length - 1));
    $('pbsMmIdx').max = Math.max(0, rows.length - 1);
    drawMm();
  }
  function drawMm() {
    const rows = mmState.rows;
    if (!rows.length) {
      $('pbsMmBars').innerHTML = '';
      $('pbsMmText').innerHTML = '';
      BT.chart($('pbsMmChart'), { type: 'line', data: { labels: [], datasets: [] } });
      return;
    }
    const i = Math.max(0, mmState.idx);
    $('pbsMmIdx').value = i;
    const cum = (k, upto = i, side = 'adj') => rows.slice(0, upto + 1).reduce((s, r) => s + (r[side]?.[k] || 0), 0);
    const all = (k, side = 'adj') => rows.reduce((s, r) => s + Math.abs(r[side]?.[k] || 0), 0);
    const scale = Math.max(...['etf', 'opt', 'total'].map((k) => Math.abs(cum(k, rows.length - 1))), all('opt') / 2, 1);
    const r = rows[i];
    bars(
      $('pbsMmBars'),
      [
        ['NIFTYBEES', cum('etf')],
        ['Options', cum('opt'), `held to expiry ${inrS(cum('opt', i, 'none'))}`, true],
        ['With NIFTYBEES (total)', cum('total'), `held to expiry ${inrS(cum('total', i, 'none'))}`, true],
      ],
      scale,
    );
    const ev = (r.adj?.events || []).filter((e) => !['entry', 'expiry'].includes(e.kind));
    $('pbsMmText').innerHTML =
      `<b>${esc(r.label)}</b> · Nifty ${num0(r.spot0)} → ${num0(r.spotE)} (${pct(((r.spotE - r.spot0) / r.spot0) * 100)}) · this month: options <b class="${cls(r.adj.opt)}">${inrS(r.adj.opt)}</b>, NIFTYBEES <b class="${cls(r.adj.etf)}">${inrS(r.adj.etf)}</b>, total <b class="${cls(r.adj.total)}">${inrS(r.adj.total)}</b>
      ${ev.length ? `<ul>${ev.map((e) => `<li>${typeof e.day === 'number' ? `day ${e.day}` : dayLabel(e.day)}: ${esc(e.text)}</li>`).join('')}</ul>` : '<div class="muted">No re-picks this month.</div>'}
      <span class="muted">Totals since month 1 in the bars.</span>`;
    const upto = (f) => rows.map((x, j) => (j <= i ? rows.slice(0, j + 1).reduce((s, y) => s + (f(y) || 0), 0) : null));
    BT.chart($('pbsMmChart'), {
      type: 'line',
      data: {
        labels: rows.map((x) => x.label),
        datasets: [
          { label: 'Rules + NIFTYBEES', data: upto((y) => y.adj?.total), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
          { label: 'Held to expiry + NIFTYBEES', data: upto((y) => y.none?.total), borderColor: '#b392f0', borderWidth: 1.5, pointRadius: 0 },
          { label: 'NIFTYBEES alone', data: upto((y) => y.adj?.etf), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
          { label: 'Options', data: upto((y) => y.adj?.opt), borderColor: '#e86fb5', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
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

  // ----- The study's variants side by side -----
  const avgOf = (b, k = 'withOnce') => (b?.n ? b[k] / b.n : 0);
  // hiCol: 'up' | 'down' marks the column a section is about (When Nifty rises / falls)
  function variantTable(list, hiCol) {
    const r0 = studyRow('none');
    const rows = list.map(([id, label]) => [studyRow(id), label]).filter(([r]) => r);
    if (!rows.length) return '';
    const hold = (k) => inrS(avgOf(r0.summary.byMove[k], 'hold'));
    const hi = (k) => (hiCol === k ? ' class="cc-col-tot"' : '');
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Variant</th><th class="cc-col-tot">Whole period, + NIFTYBEES held</th><th>Options</th><th${hi('up')}>Avg up month (hold ${hold('up')})</th><th>Avg flat month</th><th${hi('down')}>Avg down month (hold ${hold('down')})</th><th>Worst month (options)</th><th>Max drawdown (+ NIFTYBEES)</th><th>Re-picks</th></tr></thead>
      <tbody>${rows
        .map(([r, label]) => {
          const s = r.summary;
          return `<tr class="cc-click${r.id === 'none' ? ' on' : ''}" data-rule="${r.id}" title="Click: this rule's full backtest on the Backtest tab"><td class="l">${esc(label)}</td><td class="cc-col-tot ${cls(s.withOnce.total)}">${inrS(s.withOnce.total)}</td><td class="${cls(s.opt.total)}">${inrS(s.opt.total)}</td><td class="${cls(avgOf(s.byMove.up))}">${inrS(avgOf(s.byMove.up))}</td><td class="${cls(avgOf(s.byMove.flat))}">${inrS(avgOf(s.byMove.flat))}</td><td class="${cls(avgOf(s.byMove.down))}">${inrS(avgOf(s.byMove.down))}</td><td class="neg">${inr(s.opt.worst)}</td><td class="neg">${inr(s.withOnce.maxDD)}</td><td>${s.adjustments}</td></tr>`;
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
  // When Nifty rises / falls: what the study's variants did in the up and the down months (as on the Put spread collar)
  function risesHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the study on the Backtest tab: this section is drawn from it.</p>';
    const up = r0.summary.byMove.up;
    return `<p>No call is sold, so NIFTYBEES keep their whole rise; above the strikes every put expires worthless and the options end at what the back spread and the butterflies cost or took in (the search keeps that within the loss limit). In the backtest's ${up.n} months when Nifty rose more than 2 %, the strategy made <b>${inrS(avgOf(up))}</b> a month on average with NIFTYBEES held, while the same NIFTYBEES alone made <b>${inrS(avgOf(up, 'hold'))}</b>: the gap is what the puts cost in a rising month.
      What can be done about it, on the same ${r0.summary.months} months (${dayLabel(r0.summary.from)} – ${dayLabel(r0.summary.to)}, NIFTYBEES held, 0.5 % slippage):</p>
      ${variantTable(
        [
          ['none', 'Hold to expiry (the strategy as entered)'],
          ['move2', 'Re-pick at a 2 % move (default)'],
          ['move2up', 'Re-pick only after a 2 % rise'],
          ['rankCredit', 'Rank by P&L if Nifty stays'],
          ['loss0', 'Loss limit ₹0 (least loss)'],
          ['noFly', 'Back spread alone (no flies)'],
          ['put', 'Plain bought put ATM−300'],
        ],
        'up',
      )}
      <ul style="margin-top:8px">
        <li><b>Re-pick after a rise</b>: the old puts are nearly worthless, the new search sits under the new Nifty (${perMonth('move2up', 'up')} per up month, ${period('move2up')} over the period).</li>
        <li><b>Rank by Nifty staying</b> or <b>a ₹0 loss limit</b>: the trades that cost least if Nifty does not fall (${perMonth('rankCredit', 'up')} and ${perMonth('loss0', 'up')} per up month).</li>
        <li><b>A plain bought put</b> pays its whole premium away in a rise (${perMonth('put', 'up')} per up month): the back spread is cheaper to hold in a rally.</li>
      </ul>
      <p class="muted small">One period of history, not a forecast: only ${up.n} rising months. Click a row for its full backtest.</p>`;
  }
  function fallsHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the study on the Backtest tab: this section is drawn from it.</p>';
    const dn = r0.summary.byMove.down;
    return `<p>Between the sold put and the two bought puts the back spread loses (its dip); the butterflies inside that stretch are what fill it. Below the bought puts the extra bought put gains a point for every point Nifty falls and hedges the NIFTYBEES. In the backtest's ${dn.n} months when Nifty fell more than 2 %, the strategy made <b>${inrS(avgOf(dn))}</b> a month on average with NIFTYBEES held, against <b>${inrS(avgOf(dn, 'hold'))}</b> for NIFTYBEES alone.
      Ways to handle a fall, on the same months:</p>
      ${variantTable(
        [
          ['none', 'Hold to expiry (the strategy as entered)'],
          ['move2', 'Re-pick at a 2 % move (default)'],
          ['move2dn', 'Re-pick only after a 2 % fall'],
          ['move1', 'Re-pick at a 1 % move'],
          ['loss5k', 'Loss limit ₹5,000 (more protection allowed)'],
          ['loss10k', 'Loss limit ₹10,000'],
          ['oneFly', 'At most 1 fly'],
          ['ideas', 'Live Ideas shape (fixed geometry)'],
          ['put', 'Plain bought put ATM−300'],
        ],
        'down',
      )}
      <ul style="margin-top:8px">
        <li><b>Re-pick after a fall</b>: books what the puts made and searches again under the new Nifty (${perMonth('move2dn', 'down')} per down month, ${period('move2dn')} over the period); at 1 % both ways ${perMonth('move1', 'down')}.</li>
        <li><b>Allow a bigger loss limit</b>: the search can buy protection nearer the money (${perMonth('loss5k', 'down')} per down month at ₹5,000, ${perMonth('loss10k', 'down')} at ₹10,000).</li>
        <li><b>A plain bought put</b> protects all the way down from its strike (${perMonth('put', 'down')} per down month, ${period('put')} over the period) but costs its whole premium when Nifty does not fall.</li>
      </ul>
      <p class="muted small">One period of history (Nifty fell over it): ${dn.n} falling months. Click a row for its full backtest.</p>`;
  }
  function variantsHtml() {
    const r0 = studyRow('none');
    if (!r0) return '<p class="muted">Run the study on the Backtest tab: this section is drawn from it.</p>';
    const s0 = r0.summary;
    return `<p>On the same ${s0.months} months (${dayLabel(s0.from)} – ${dayLabel(s0.to)}, 0.5 % slippage), NIFTYBEES alone made <b class="${cls(s0.hold.total)}">${inrS(s0.hold.total)}</b> with a drawdown of <b>${inr(s0.hold.maxDD)}</b>. With the default search held to expiry: <b class="${cls(s0.withOnce.total)}">${inrS(s0.withOnce.total)}</b>, drawdown <b>${inr(s0.withOnce.maxDD)}</b> (options ${inrS(s0.opt.total)}, worst options month ${inr(s0.opt.worst)}).</p>
      <h4>Hold to expiry or re-pick</h4>
      ${variantTable([
        ['none', 'Hold to expiry'],
        ['move1', 'Re-pick at a 1 % move'],
        ['move15', 'Re-pick at a 1.5 % move'],
        ['move2', 'Re-pick at a 2 % move (default)'],
        ['move3', 'Re-pick at a 3 % move'],
        ['move2h', '2 %, checked hourly'],
        ['move2up', 'Re-pick only after a 2 % rise'],
        ['move2dn', 'Re-pick only after a 2 % fall'],
      ])}
      <h4>How much options loss to allow (held to expiry)</h4>
      ${variantTable([
        ['loss0', '₹0 a lot (least loss)'],
        ['loss1k', '₹1,000 a lot'],
        ['none', `₹${num0(r0.params?.pick?.maxLoss ?? 2500)} a lot (default)`],
        ['loss5k', '₹5,000 a lot'],
        ['loss10k', '₹10,000 a lot'],
      ])}
      <h4>The structure and the alternatives (held to expiry)</h4>
      ${variantTable([
        ['none', 'Searched back spread + up to 2 flies (default)'],
        ['oneFly', 'At most 1 fly'],
        ['noFly', 'Back spread alone (no flies)'],
        ['rankLoss', 'Rank by smallest loss'],
        ['rankCredit', 'Rank by P&L if Nifty stays'],
        ['ideas', 'Live Ideas shape (fixed geometry)'],
        ['put', 'Plain bought put ATM−300'],
      ])}
      <p class="muted small">One period of history (Nifty fell over it), not a forecast: protection looks better in a falling period than it will in a rising one. Click a row for its full backtest.</p>`;
  }

  // The study's comparison of the default search with the Live Ideas shape and a plain bought put, in plain words.
  function ideasVs() {
    const [r0, ri, rp] = ['none', 'ideas', 'put'].map(studyRow);
    if (!r0 || !ri) return ' The study (Backtest tab) compares it with the Ideas shape and a plain bought put on the same months.';
    const line = (r) =>
      `${inrS(r.summary.withOnce.total)} with NIFTYBEES held, drawdown ${inr(r.summary.withOnce.maxDD)}, worst options month ${inr(r.summary.opt.worst)} (${r.summary.months} months)`;
    const more = ri.summary.withOnce.total > r0.summary.withOnce.total;
    return ` <br><b>In the backtest</b> (held to expiry): the search at its default ₹${num0(r0.params?.pick?.maxLoss ?? 2500)} limit ${line(r0)}; the Ideas shape ${line(ri)}${rp ? `; a plain bought put ATM−300 ${line(rp)}` : ''}. ${
      more
        ? 'So the fixed Ideas shape <b>made more</b> over this period: it sits nearer the money (more protection, a bigger loss when Nifty does not fall), which paid in a period when Nifty fell. What the search gives is a worst case known and capped at entry; for more protection raise the loss limit (the ₹5 K and ₹10 K rows).'
        : 'The search did better here, with a worst case capped at entry.'
    } Months the Ideas shape could not price (strikes missing in the history) are left out of its row.`;
  }
  function rulesWhen(rU, r0) {
    const rows = ['move1', 'move15', 'move2', 'move3'].map(studyRow);
    const known = rU && r0 && rows.every(Boolean);
    const vs = (r) => (r && r0 ? inrS(r.summary.withOnce.total - r0.summary.withOnce.total) : '—');
    return `${
      known
        ? `With NIFTYBEES held, against holding to expiry: re-pick at 1 % ${vs(rows[0])}, 1.5 % ${vs(rows[1])}, 2 % ${vs(rows[2])}, 3 % ${vs(rows[3])}; only after rises ${vs(studyRow('move2up'))}, only after falls ${vs(studyRow('move2dn'))}. Drawdown at 2 %: ${inr(rows[2].summary.withOnce.maxDD)} vs ${inr(r0.summary.withOnce.maxDD)} held.`
        : 'Run the study on the Backtest tab to compare re-picking with holding to expiry.'
    }
    <br><span class="muted small">Each re-pick pays a fresh round of slippage on 5 legs; it helps when Nifty trends away from the strikes picked at entry.</span>`;
  }
  const skippedText = (s) => (s?.skipped?.length ? `Left out (no option prices in the cache): ${s.skipped.map((x) => monthName(x.expiry)).join(', ')}.` : '');

  // The study's rows, best first by the total with NIFTYBEES held.
  function studyTable(st, compact) {
    const r0 = st.rows.find((r) => r.id === 'none');
    const rows = [...st.rows].sort((a, b) => b.summary.withOnce.total - a.summary.withOnce.total);
    const top = rows[0];
    const steady = [...st.rows].sort((a, b) => b.summary.withOnce.maxDD - a.summary.withOnce.maxDD)[0];
    const t = top.summary;
    const bestLine = `<div class="mcc-best"><span class="cc-kind k-book">Best</span> <b>${esc(top.label)}</b>: ${inrS(t.withOnce.total)} with NIFTYBEES held (options ${inrS(t.opt.total)}), ${t.adjustments} re-picks; worst options month ${inr(t.opt.worst)}, drawdown ${inr(t.withOnce.maxDD)} (held to expiry: ${inrS(r0.summary.withOnce.total)} / ${inr(r0.summary.withOnce.maxDD)}; NIFTYBEES alone ${inrS(r0.summary.hold.total)} / ${inr(r0.summary.hold.maxDD)}).
      ${steady && steady.id !== top.id ? `<br><span class="cc-kind k-call">Steadiest</span> <b>${esc(steady.label)}</b>: the smallest drawdown with NIFTYBEES (${inr(steady.summary.withOnce.maxDD)}) for ${inrS(steady.summary.withOnce.total)}.` : ''}
      <br><span class="muted small">Best on this one period of history (${r0.summary.months} months); the gap between neighbouring rows is often a single month.</span></div>`;
    return `${bestLine}<div class="tbl-wrap"><table class="grid-tbl">
      <thead><tr><th>#</th><th class="l">Rule</th><th>Re-picks</th><th class="cc-col-tot">+ ETF held</th><th>vs held to expiry</th><th>Max drawdown (+ ETF held)</th><th>Options P&L</th><th>Worst month (options)</th><th>Up months</th><th>Flat</th><th>Down</th><th>+ ETF rebought</th>${compact ? '' : '<th>Costs</th>'}</tr></thead>
      <tbody>${rows
        .map((r, i) => {
          const s = r.summary;
          return `<tr class="cc-click${r.id === 'none' ? ' on' : ''}${r === top ? ' mcc-top' : ''}${viewing?.id === r.id ? ' mcc-viewing' : ''}" data-rule="${r.id}" title="Click: this rule's full backtest, month by month">
            <td>${i + 1}</td>
            <td class="l">${esc(r.label)}${r === top ? ' <span class="cc-kind k-book">best</span>' : ''}${steady && r === steady && r !== top ? ' <span class="cc-kind k-call">steadiest</span>' : ''}${r.id === 'move2' ? ' <span class="cc-kind">default settings</span>' : ''}${r.id === 'none' ? ' <span class="cc-kind">baseline</span>' : ''}</td>
            <td>${s.adjustments}</td>
            <td class="cc-col-tot ${cls(s.withOnce.total)}"><b>${inrS(s.withOnce.total)}</b></td>
            <td class="${cls(s.withOnce.total - r0.summary.withOnce.total)}">${r.id === 'none' ? '—' : inrS(s.withOnce.total - r0.summary.withOnce.total)}</td>
            <td class="neg">${inr(s.withOnce.maxDD)}</td>
            <td class="${cls(s.opt.total)}">${inrS(s.opt.total)}</td>
            <td class="neg">${inr(s.opt.worst)}</td>
            <td class="${cls(s.byMove.up.opt)}">${inrS(s.byMove.up.opt)}</td>
            <td class="${cls(s.byMove.flat.opt)}">${inrS(s.byMove.flat.opt)}</td>
            <td class="${cls(s.byMove.down.opt)}">${inrS(s.byMove.down.opt)}</td>
            <td class="${cls(s.withMonthly.total)}">${inrS(s.withMonthly.total)}</td>
            ${compact ? '' : `<td>${inr(s.costs)}</td>`}
          </tr>`;
        })
        .join('')}</tbody></table></div>
      <div class="muted small pad"><b>Click a rule</b> to open its full backtest on the Backtest tab. Ranked by the total with NIFTYBEES held (the protection's job); options P&L after slippage and charges. Up / flat / down: the options in months where Nifty rose more than 2 %, stayed within ±2 %, fell more than 2 %. "+ ETF rebought": NIFTYBEES sold at each expiry and bought back at the next entry.</div>`;
  }

  // ---------- Backtest ----------
  const sel = (path, cur, opts) =>
    `<select data-p="${path}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const inp = (path, cur, w = 60) => `<input class="txt num" data-p="${path}" value="${cur}" style="width:${w}px">`;
  function renderBacktest() {
    const p = params;
    const months = meta.monthly || [];
    const range = BT.store.get('pbs-range', { from: months[1] || '', to: months[months.length - 1] || '' });
    const opts = (cur) =>
      months
        .slice(1)
        .map((e) => `<option${e === cur ? ' selected' : ''}>${e}</option>`)
        .join('');
    body().innerHTML = `
      <div class="panel cc-doc">
        <h3>Settings</h3>
        <div class="cc-params">
          <div class="set-row"><b>Series</b> <span class="lbl">from expiry</span><select id="pbsFrom">${opts(range.from)}</select><span class="lbl">to</span><select id="pbsTo">${opts(range.to)}</select></div>
          ${budgetRow(p.budget, exState().spot, 'Bought at each entry (held: once, at the first); % a year is on the budget. Saved results are shown for it without re-running.')}
          <div class="set-row"><b>Adjustments</b> ${sel('adj.on', p.adj.on, [
            [false, 'Hold to expiry: no changes during the month'],
            [true, 'Re-pick: search again when Nifty moves'],
          ])}
            <span class="lbl">at a</span>${inp('adj.movePct', p.adj.movePct, 45)}<span class="lbl">% move from the entry / last re-pick,</span>${sel(
              'adj.dir',
              p.adj.dir,
              [
                ['both', 'either way'],
                ['up', 'only after rises'],
                ['down', 'only after falls'],
              ],
            )}</div>
          <div class="set-row"><b></b><span class="lbl">checked</span>${sel('adj.check', p.adj.check, [
            ['close', 'once a day at 15:00'],
            ['hourly', 'hourly 10:30–15:00'],
          ])}<span class="lbl">none in the last</span>${inp('adj.lastDays', p.adj.lastDays, 40)}<span class="lbl">trading days · at most</span>${inp('adj.maxPerSide', p.adj.maxPerSide, 40)}<span class="lbl">re-picks a month</span></div>
          <div class="set-row"><b>Strikes</b> ${sel('pick.mode', p.pick.mode, [
            ['search', 'searched on the chain (back spread + flies)'],
            ['ideas', 'Live Ideas shape (fixed geometry)'],
            ['put', 'plain bought put (fixed)'],
          ])}
            <span class="lbl">options loss limit ₹</span>${inp('pick.maxLoss', p.pick.maxLoss, 70)}<span class="lbl">a lot · rank</span>${sel('pick.rank', p.pick.rank, RANKS)}</div>
          <div class="set-row"><b></b><span class="lbl">butterflies up to</span>${sel('pick.flies', p.pick.flies, [
            [0, 'none'],
            [1, '1 per lot'],
            [2, '2 per lot'],
          ])}<span class="lbl">· sold put from ATM +</span>${inp('pick.top', p.pick.top, 50)}<span class="lbl">down to ATM −</span>${inp('pick.bottom', p.pick.bottom, 55)}<span class="lbl">pts · back spread</span>${inp('bs.sell', p.bs.sell, 32)}<span class="lbl">×</span>${inp('bs.buy', p.bs.buy, 32)}<span class="lbl">· lots</span>${inp('lots', p.lots, 32)}</div>
          <div class="set-row"><b></b><span class="lbl">fixed shapes: Ideas sold put ATM −</span>${inp('fixed.sellOff', p.fixed.sellOff, 50)}<span class="lbl">width</span>${inp('fixed.width', p.fixed.width, 50)}<span class="lbl">· bought put ATM −</span>${inp('fixed.putOff', p.fixed.putOff, 50)}</div>
          <div class="set-row" title="When the paper trade opens a series (Start, or after an expiry) and this month's monthly expiry is fewer than this many calendar days away, it skips it and builds the strategy on next month's chain."><b>Paper series</b><span class="lbl">skip this month when fewer than</span>${inp('minDays', p.minDays ?? 15, 40)}<span class="lbl">calendar days are left to its expiry: use next month's</span></div>
          <div class="set-row"><b>NIFTYBEES</b> ${sel('etf', p.etf, [
            ['model', '₹1 per 100 Nifty points (Nifty ÷ 100)'],
            ['real', 'recorded NIFTYBEES prices'],
          ])}
            <span class="lbl">option slippage</span>${inp('costs.slipPct', p.costs.slipPct, 45)}<span class="lbl">% · brokerage ₹</span>${inp('costs.brokerage', p.costs.brokerage, 45)}<span class="lbl">/ order · ETF slippage</span>${inp('costs.etfSlipPct', p.costs.etfSlipPct, 45)}<span class="lbl">%</span></div>
          <div class="set-row cc-run">
            <button class="btn-sm run" id="pbsRun">Run backtest</button>
            <button class="btn-sm ghost" id="pbsStudy">Run study</button>
            <button class="btn-sm ghost" id="pbsDefaults">Defaults</button>
            <span class="muted small">The backtest runs these settings and the same held to expiry. The study runs ${meta.study.length} rules and variants on the same months. Every entry prices a few dozen strikes, so a run takes ~10–20 s, the study a few minutes. Missing contracts are downloaded when logged in.</span>
            <div class="progress hidden" id="pbsProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
          </div>
          ${lastDone ? `<div class="small pbs-done">${lastDone}</div>` : ''}
        </div>
      </div>
      <div id="pbsRes"></div>`;
    body()
      .querySelectorAll('[data-p]')
      .forEach((el) => el.addEventListener('change', () => setParam(el.dataset.p, el.value)));
    bindBudget((v) => {
      useBudget(v);
      renderBacktest();
    });
    ['pbsFrom', 'pbsTo'].forEach((id) => $(id).addEventListener('change', () => BT.store.set('pbs-range', { from: $('pbsFrom').value, to: $('pbsTo').value })));
    $('pbsRun').addEventListener('click', () => {
      viewing = null;
      runJob('backtest');
    });
    $('pbsStudy').addEventListener('click', () => runJob('study'));
    $('pbsDefaults').addEventListener('click', () => {
      params = { ...deep(meta.defaults), lotSize: meta.lot };
      BT.store.set('pbs-params', params);
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
    BT.store.set('pbs-params', params);
    if (path === 'lots' || path === 'budget') drawBees();
  }
  function showProgress(pr) {
    const box = $('pbsProg');
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
    const range = { from: $('pbsFrom')?.value, to: $('pbsTo')?.value };
    lastDone = '';
    body().querySelector('.pbs-done')?.remove();
    try {
      job = { kind, progress: null };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api(API + '/' + kind, { params, ...range });
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api(API + '/job?id=' + job.id);
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
      if ($('pbsRes')) $('pbsRes').innerHTML = `<div class="panel empty err">${kind === 'study' ? 'Study' : 'Backtest'} failed: ${esc(e.message)}</div>`;
      job = null;
      showProgress(null);
      return;
    }
    job = null;
    const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    lastDone =
      kind === 'study'
        ? `✓ Study finished at ${t}: ${saved.study.rows.length} rules on ${saved.study.rows[0]?.summary.months || 0} months. The table is below (and on Strategy & rules).`
        : `✓ Backtest finished at ${t}.`;
    if (tab === 'bt') {
      renderBacktest();
      $(kind === 'study' ? 'pbsStudyPanel' : 'pbsRes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function kpiBlock(title, s, note) {
    const card = (label, x, sub) =>
      `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${cls(x.total)}">${inrS(x.total)}</span><span class="muted small">${sub}</span></div>`;
    const sub = (x) => `${pct(x.annPct)} / yr · worst ${kinr(x.worst)} · DD ${kinr(x.maxDD)} · ${x.win}/${s.months} up`;
    return `<div class="cc-grp-l" style="margin:6px 0 4px"><b>${title}</b> <span class="muted small">${note || ''}</span></div>
      <div class="kpis cc-kpis-main">
        ${card('Options (back spread + flies)', s.opt, sub(s.opt))}
        ${card('+ NIFTYBEES held', s.withOnce, sub(s.withOnce))}
        ${card('+ NIFTYBEES rebought monthly', s.withMonthly, sub(s.withMonthly))}
        ${card('NIFTYBEES alone (buy & hold)', s.hold, sub(s.hold))}
      </div>`;
  }
  const adjDesc = (p) =>
    p.adj.on
      ? `re-pick at a ${p.adj.movePct} % move (${{ both: 'either way', up: 'rises only', down: 'falls only' }[p.adj.dir]}), ${p.adj.check === 'hourly' ? 'hourly' : '15:00'} checks`
      : 'held to expiry';
  const pickDesc = (p) =>
    p.pick.mode === 'ideas'
      ? `Live Ideas shape ATM−${p.fixed.sellOff}/−${p.fixed.sellOff + p.fixed.width}`
      : p.pick.mode === 'put'
        ? `bought put ATM−${p.fixed.putOff}`
        : `searched: loss ≤ ${inr(p.pick.maxLoss)}/lot, rank ${p.pick.rank}, ≤ ${p.pick.flies} flies`;
  function renderResults() {
    const el = $('pbsRes');
    const B = viewing?.B || saved.backtest;
    if (!B) {
      el.innerHTML = `<div class="panel empty"><h3>No backtest yet</h3><p>Press Run backtest.</p></div>${saved.study ? `<div class="panel cc-doc" id="pbsStudyPanel"><h3>Study</h3>${studyTable(saved.study)}</div>` : ''}`;
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
        <button class="btn-sm ghost" id="pbsViewBack">Back to your backtest</button><button class="btn-sm ghost" id="pbsViewUse">Use these settings</button><span class="small" id="pbsViewMsg"></span></div>`
          : ''
      }
      <div class="panel cc-doc">
        <h3>Result: ${dayLabel(sa.from)} – ${dayLabel(sa.to)}, ${sa.months} monthly series, ${sizeLabel(A.params)}, ${esc(pickDesc(A.params))}</h3>
        ${B.withAdj !== (viewing?.raw || raw.backtest)?.withAdj ? `<div class="muted small" style="margin-bottom:6px">Run with ${sizeLabel((viewing?.raw || raw.backtest).withAdj.params)}; shown for your budget: the options are the same, the NIFTYBEES figures scaled to it.</div>` : ''}
        ${kpiBlock(A.params.adj.on ? 'With re-picks' : 'Held to expiry', sa, adjDesc(A.params) + ` · ${sa.adjustments} re-picks · costs ${inr(sa.costs)}`)}
        ${A.params.adj.on ? kpiBlock('Held to expiry', sn, `costs ${inr(sn.costs)}`) : ''}
        <p class="cc-verdict">${verdict(sa, sn, A.params)}</p>
        <p class="muted small">% per year on ${A.params.budget > 0 ? 'the NIFTYBEES budget' : 'the ETF bought at the first entry'} (${inr(sa.invested)}). ${skippedText(sa)} DD = largest fall from a peak of the month-end totals. ${gapNote(A)}.</p>
      </div>
      <div class="panel cc-doc"><h3>Month-end total</h3><div class="cc-pay-chart"><canvas id="pbsEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>By market direction</h3>${dirTable(sa, sn)}</div>
      <div class="panel cc-doc"><h3>Month by month <button class="btn-sm ghost" id="pbsAllMonths" style="margin-left:8px">${all ? 'Hide the details' : 'Show every month’s details'}</button></h3><div class="muted small" style="margin-bottom:6px">"Picked at entry": the back spread K1/K2 and the butterflies, with the options' worst case at expiry the search worked out. Click a month for every leg it traded, its re-picks and the payoff of the position held into expiry.</div>
        <div class="tbl-wrap"><table class="grid-tbl cc-months"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th><th class="l">Picked at entry</th><th>Worst (search)</th><th>Re-picks</th><th class="cc-col-opt">Options${A.params.adj.on ? ', re-picked' : ''}</th><th class="cc-col-opt">Options, held</th><th>NIFTYBEES held</th><th>NIFTYBEES rebought</th><th class="cc-col-tot">Total + held</th><th class="cc-col-tot">Total held to expiry</th></tr></thead>
        <tbody>${A.months
          .map((m) => {
            const n = byExp.get(m.expiry);
            if (!m.ok) return `<tr><td class="l">${monthName(m.expiry)}</td><td colspan="11" class="muted l">${esc(m.skip)}</td></tr>`;
            const open = all || openMonth === m.expiry;
            const sh = m.entry?.shape;
            return `<tr class="cc-click${open ? ' on' : ''}" data-m="${m.expiry}"><td class="l">${monthName(m.expiry)}<div><button class="btn-sm ghost" style="margin-top:3px;white-space:nowrap" data-bbld="${m.expiry}" title="Replay this month in the Builder (Historical replay): the legs at the backtest's entry, its ${m.adjustments} re-pick${m.adjustments === 1 ? '' : 's'} made again as the replay reaches them">Open in Builder ▸</button></div></td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td class="${cls(m.move)}">${pct(m.move)}</td>
              <td class="l small">${esc(shapeShort(sh))}</td><td class="${cls(sh?.worst)}">${sh ? inrS(sh.worst) : '—'}${sh && sh.hit === false ? ' <span class="muted small" title="none within the loss limit: the least loss">*</span>' : ''}</td><td>${m.adjustments}</td>
              <td class="cc-col-opt ${cls(m.opt)}">${inrS(m.opt)}</td><td class="cc-col-opt ${cls(n?.opt)}">${n?.ok ? inrS(n.opt) : '—'}</td>
              <td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.etfMonthly)}">${inrS(m.etfMonthly)}</td>
              <td class="cc-col-tot ${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="cc-col-tot ${cls(n?.withOnce)}">${n?.ok ? inrS(n.withOnce) : '—'}</td></tr>
              ${open ? `<tr class="cc-detail"><td colspan="12">${monthDetail(m, n, A.params.lotSize)}</td></tr>` : ''}`;
          })
          .join('')}</tbody>
        <tfoot><tr><th class="l">Total</th><td></td><td></td><td></td><td></td><td>${sa.adjustments}</td><th class="${cls(sa.opt.total)}">${inrS(sa.opt.total)}</th><th class="${cls(sn.opt.total)}">${inrS(sn.opt.total)}</th><th class="${cls(sa.hold.total)}">${inrS(sa.hold.total)}</th><th class="${cls(sa.withMonthly.total - sa.opt.total)}">${inrS(sa.withMonthly.total - sa.opt.total)}</th><th class="${cls(sa.withOnce.total)}">${inrS(sa.withOnce.total)}</th><th class="${cls(sn.withOnce.total)}">${inrS(sn.withOnce.total)}</th></tr></tfoot></table></div>
        <div class="muted small">* none within the loss limit on that chain: the structure with the least loss was taken.</div>
      </div>
      <div class="panel cc-doc"><h3>Every re-pick</h3>${adjustmentList(A)}</div>
      <div class="panel cc-doc" id="pbsStudyPanel"><h3>Study</h3>${saved.study ? studyTable(saved.study) + `<div class="muted small pad">Run ${new Date(saved.study.at).toLocaleString('en-IN')} with ${sizeLabel(saved.study.rows[0]?.params)}. The rules tab explains what to take from it.</div>` : '<p class="muted">Not run yet: "Run study" above.</p>'}</div>`;
    drawEquity(A, N);
    el.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-bbld]');
        if (b)
          return monthToBuilder(
            A.months.find((m) => m.expiry === b.dataset.bbld),
            A.params,
          );
        openMonth = openMonth === tr.dataset.m ? null : tr.dataset.m;
        renderResults();
      }),
    );
    $('pbsAllMonths').onclick = () => {
      openMonth = all ? null : 'all';
      renderResults();
    };
    if (viewing) {
      $('pbsViewBack').onclick = () => {
        viewing = null;
        openMonth = null;
        renderBacktest();
      };
      $('pbsViewUse').onclick = () => {
        params = { ...deep(viewing.B.withAdj.params), lotSize: meta.lot };
        BT.store.set('pbs-params', params);
        const label = viewing.label;
        renderBacktest();
        $('pbsViewMsg').textContent = `Settings set to "${label}". Press Run backtest to keep its result as your backtest (and for the paper trade).`;
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
  // One month of the backtest replayed in the Builder (Historical replay, multi-day): the legs at the backtest's entry
  // fills, and every re-pick as the Builder's plan, made again at the backtest's fills when the replay reaches it.
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
    const add = (map, id, op) => map.set(id, map.has(id) ? { ...op, qty: map.get(id).qty + op.qty } : op);
    const entry = new Map();
    const steps = new Map();
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
        const ev = m.events.filter((e) => e.day === s.day && e.time === s.time && ADJ.has(e.kind));
        return {
          day: s.day,
          time: s.time,
          title: ev.map((e) => KIND[e.kind] || e.kind).join(' + ') || 'Re-pick',
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
      mcc: { on: false, kind: 'pbs' },
    });
  }
  function adjustmentList(A) {
    const rows = A.months.filter((m) => m.ok).flatMap((m) => m.events.filter((e) => ADJ.has(e.kind) || e.kind === 'skip').map((e) => ({ m, e })));
    if (!rows.length) return `<p class="muted">No re-picks in this run${A.params.adj.on ? '' : ' (held to expiry)'}.</p>`;
    const months = new Set(rows.map((r) => r.m.expiry)).size;
    return `<p class="small">${rows.length} re-picks in ${months} of ${A.summary.months} months.</p>
      <div class="tbl-wrap"><table class="grid-tbl cc-ev"><thead><tr><th class="l">Month</th><th>When</th><th>What</th><th>Nifty</th><th class="l">Detail</th><th>Month's options</th></tr></thead><tbody>
      ${rows
        .map(
          ({ m, e }) =>
            `<tr class="cc-click" data-adj-m="${m.expiry}"><td class="l">${monthName(m.expiry)}</td><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind k-${e.kind === 'skip' ? 'skip' : 'call'}">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td><td class="${cls(m.opt)}">${inrS(m.opt)}</td></tr>`,
        )
        .join('')}</tbody></table></div><div class="muted small">Click a row to open its month above.</div>`;
  }
  function gapNote(A) {
    const ok = A.months.filter((m) => m.ok);
    let pts = 0;
    for (let i = 1; i < ok.length; i++) pts += ok[i].spot0 - ok[i - 1].spotE;
    return `"Rebought monthly" is out of the market from each expiry's close to the next morning: over these months Nifty moved ${pts >= 0 ? '+' : ''}${num0(pts)} pts in those gaps`;
  }
  function verdict(sa, sn, p) {
    const d = sa.withOnce.total - sn.withOnce.total;
    return [
      p.adj.on
        ? `Re-picking ${d >= 0 ? 'added' : 'cost'} <b class="${cls(d)}">${inrS(d)}</b> against holding to expiry (with NIFTYBEES held); drawdown ${inr(sa.withOnce.maxDD)} vs ${inr(sn.withOnce.maxDD)}.`
        : '',
      `With the ETF held: ${inrS(sa.withOnce.total)} vs buy and hold alone ${inrS(sa.hold.total)}: the options ${sa.opt.total >= 0 ? 'added' : 'took'} ${inrS(sa.opt.total)}, and the drawdown went from ${inr(sa.hold.maxDD)} to ${inr(sa.withOnce.maxDD)}.`,
      `Worst options month ${inr(sa.opt.worst)}; ${sa.opt.win} of ${sa.months} months had the options in profit — the protection costs a little most months and pays in the falls.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  function dirTable(sa, sn) {
    const row = (k, label) => {
      const a = sa.byMove[k];
      const n = sn.byMove[k];
      return `<tr><td class="l">${label}</td><td>${a.n}</td><td class="${cls(a.opt)}">${inrS(a.opt)}</td><td class="${cls(n.opt)}">${inrS(n.opt)}</td><td class="${cls(a.hold)}">${inrS(a.hold)}</td><td class="${cls(a.withOnce)}">${inrS(a.withOnce)}</td><td class="${cls(n.withOnce)}">${inrS(n.withOnce)}</td></tr>`;
    };
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty in the month</th><th>Months</th><th>Options (rules)</th><th>Options held to expiry</th><th>NIFTYBEES held</th><th>Total (rules)</th><th>Total held to expiry</th></tr></thead><tbody>
      ${row('up', 'Up more than 2 %')}${row('flat', 'Within ±2 %')}${row('down', 'Down more than 2 %')}</tbody></table></div>`;
  }
  // One month in full: every leg under its structure (before costs), the options after costs, NIFTYBEES, the payoff.
  function monthDetail(m, n, lot) {
    const ev = (list) =>
      `<table class="grid-tbl cc-ev"><tbody>${list.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind k-${e.kind === 'expiry' ? 'exp' : e.kind === 'entry' ? 'hold' : e.kind === 'skip' ? 'skip' : 'call'}">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>`;
    const atExp = (c) => c.exitAt.day === m.expiry && c.exitAt.time === '15:30';
    const when = (x) => (x ? `${dayLabel(x.day)}${x.time ? ' ' + x.time : ''}` : '—');
    const legRow = (c) =>
      `<tr><td class="l">${legLine(c)}</td><td>${when(c.at)}</td><td>${c.entry.toFixed(1)}</td><td>${atExp(c) ? 'expiry' : when(c.exitAt)}</td><td>${c.exit.toFixed(1)}</td>
        <td>${atExp(c) ? '<span class="cc-kind k-exp">held to expiry</span>' : '<span class="cc-kind k-call">closed by re-pick</span>'}</td><td class="${cls(c.pnl)}">${inrS(c.pnl)}</td></tr>`;
    const gross = {};
    const group = (g) => {
      const ls = ofGrp(m.closed, g).sort((x, y) => (x.at?.day + x.at?.time < y.at?.day + y.at?.time ? -1 : 1));
      if (!ls.length) return '';
      gross[g] = ls.reduce((s, c) => s + c.pnl, 0);
      return `<tr class="mcc-grp"><td class="l" colspan="7">${GROUP_NAME[g]}</td></tr>${ls.map(legRow).join('')}
        <tr class="mcc-sub"><td class="l" colspan="6">${GROUP_NAME[g]}: legs before costs</td><td class="${cls(gross[g])}"><b>${inrS(gross[g])}</b></td></tr>`;
    };
    const legsHtml = group('bs') + group('fly');
    const e = m.etf || {};
    const summary = `<table class="grid-tbl mcc-sum"><tbody>
        <tr><td class="l">Back spread <span class="muted small">before costs</span></td><td class="${cls(gross.bs)}">${inrS(gross.bs || 0)}</td></tr><tr><td class="l">Butterflies <span class="muted small">before costs</span></td><td class="${cls(gross.fly)}">${inrS(gross.fly || 0)}</td></tr>
        <tr><td class="l">Costs</td><td class="neg">${inrS(-m.costs)}</td></tr>
        <tr class="mcc-tot"><td class="l">Options total</td><td class="${cls(m.opt)}"><b>${inrS(m.opt)}</b></td></tr>
        <tr><td class="l">NIFTYBEES held <span class="muted small">${num0(e.qtyOnce)} units, this month's change${e.beesE ? ` to ₹${e.beesE.toFixed(2)}` : ''}</span></td><td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td></tr>
        <tr><td class="l">NIFTYBEES rebought <span class="muted small">${num0(e.qtyMonthly)} units ₹${e.bees0?.toFixed(2) ?? '—'} → ₹${e.beesE?.toFixed(2) ?? '—'}, charges included</span></td><td class="${cls(m.etfMonthly)}">${inrS(m.etfMonthly)}</td></tr>
        <tr class="mcc-tot"><td class="l">Total with NIFTYBEES held</td><td class="${cls(m.withOnce)}"><b>${inrS(m.withOnce)}</b></td></tr>
        <tr><td class="l">Total with NIFTYBEES rebought</td><td class="${cls(m.withMonthly)}">${inrS(m.withMonthly)}</td></tr>
        ${n?.ok && n !== m ? `<tr><td class="l muted">Held to expiry: options ${inrS(n.opt)}, total held</td><td class="${cls(n.withOnce)}">${inrS(n.withOnce)}</td></tr>` : ''}
      </tbody></table>`;
    return `<div class="cc-month">
      <div class="cc-month-ev"><div class="tbl-wrap"><table class="grid-tbl mcc-legs"><thead><tr><th class="l">Leg (${lot} per lot)</th><th>Opened</th><th>Entry</th><th>Closed</th><th>Exit</th><th>How</th><th>P&L</th></tr></thead><tbody>${legsHtml}</tbody></table></div></div>
      <div>${summary}</div>
      <div class="cc-pay"><div class="cc-pay-chart"><canvas data-pay="${m.expiry}"></canvas></div><div class="muted small">Payoff of the position held into expiry (entry premiums of those legs), with and without NIFTYBEES.</div></div>
      <div class="cc-month-ev"><b>Re-picks and events</b>${ev(m.events)}${n?.ok && n !== m && n.adjustments !== m.adjustments ? `<b>Held to expiry</b>${ev(n.events)}` : ''}</div>
    </div>`;
  }
  function drawEquity(A, N) {
    const ok = A.months.filter((m) => m.ok);
    const byExp = new Map(N.months.map((m) => [m.expiry, m]));
    const cum = (f) => {
      let s = 0;
      return ok.map((m) => (s += f(m) || 0));
    };
    const sets = [
      { label: (A.params.adj.on ? 'Re-picked' : 'Held') + ' + ETF held', data: cum((m) => m.withOnce), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 2 },
    ];
    if (A.params.adj.on)
      sets.push({
        label: 'Held to expiry + ETF held',
        data: cum((m) => byExp.get(m.expiry)?.withOnce),
        borderColor: '#b392f0',
        borderWidth: 2,
        pointRadius: 2,
      });
    sets.push(
      { label: 'ETF alone', data: cum((m) => m.etfOnce), borderColor: '#9aa5b1', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
      { label: 'Options' + (A.params.adj.on ? ', re-picked' : ''), data: cum((m) => m.opt), borderColor: '#e86fb5', borderWidth: 2, pointRadius: 2 },
    );
    if (A.params.adj.on)
      sets.push({ label: 'Options, held', data: cum((m) => byExp.get(m.expiry)?.opt), borderColor: '#56d4dd', borderWidth: 1.5, pointRadius: 2 });
    BT.chart($('pbsEq'), {
      type: 'line',
      data: { labels: ok.map((m) => monthName(m.expiry)), datasets: sets },
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
      paper = await BT.api(API + '/paper');
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
      <div class="set-row">${btns}<span class="muted small">Follows the live chain every 30 s with the Backtest tab's settings (${P ? 'as started' : 'current'}): ${esc(settingsLine(P ? P.params : params))}. Paper only: nothing is sent to a broker.${paper.demo ? ' Demo mode: synthetic prices.' : ''}</span></div>
      ${P?.lastError ? `<div class="muted small neg">Last error ${new Date(P.lastError.at).toLocaleTimeString('en-IN')}: ${esc(P.lastError.message)}</div>` : ''}
      ${
        P
          ? budgetRow(
              P.params.budget,
              P.cycle?.spot || P.cycle?.spot0 || exState().spot,
              `Held now: ${num0(P.etfOnce?.qty)} units. A new budget buys (or sells) the difference in NIFTYBEES now, at its current price.`,
            )
          : budgetRow(params.budget, exState().spot, 'Bought at Start.')
      }
      <div id="pbsPapMsg" class="muted small"></div></div>`;
    if (!P) {
      el.innerHTML =
        head +
        `<div class="panel empty"><h3>No paper trade running</h3><p>Start runs the search on the live chain of the current monthly series (next month's when this one has fewer than ${params.minDays ?? 15} days left) — ${esc(pickDesc(params))} — opens it at the live prices, buys NIFTYBEES worth ${params.budget > 0 ? `your budget (${inr(params.budget)})` : 'one lot (65 × Nifty)'}, and then runs month after month: ${params.adj.on ? `re-picks at a ${params.adj.movePct} % move at the check times, ` : 'held to each expiry, '}settlement at each monthly expiry and a new series at 09:30 on the next trading day.</p></div>`;
    } else {
      const c = P.cycle;
      const done = P.months || [];
      const tot = (k) => done.reduce((s, m) => s + (m[k] || 0), 0);
      const scenTop = el.querySelector('.mcc-scen')?.scrollTop;
      el.innerHTML =
        head +
        (c
          ? `<div class="panel cc-doc"><h3>${monthName(c.expiry)} series · expiry ${dayLabel(c.expiry)} <button class="btn-sm ghost" data-a="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices. Options only (the Builder holds no NIFTYBEES); the paper trade itself carries on unchanged.">▶ Open in Builder</button></h3>
          ${c.shape ? `<div class="small" style="margin-bottom:6px"><span class="cc-kind k-book">Picked</span> ${esc(shapeShort(c.shape))} · options worst at expiry ${inrS(c.shape.worst)} (search, after costs)</div>` : ''}
          <div class="kpis cc-kpis-main">
            <div class="kpi"><span class="k-l">Nifty</span><span class="k-v">${num0(c.spot)}</span><span class="muted small">entry ${num0(c.spot0)} · ${pct(((c.spot - c.spot0) / c.spot0) * 100)}</span></div>
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
              )}
              ${c.closed.length ? `<tr><td class="l muted">Closed by re-picks</td><td></td><td></td><td class="${cls(c.closed.reduce((s, x) => s + x.pnl, 0))}">${inrS(c.closed.reduce((s, x) => s + x.pnl, 0))}</td></tr>` : ''}
            </tbody></table>
            <div class="muted small">Updated ${c.markAt ? new Date(c.markAt).toLocaleTimeString('en-IN') : '—'} · re-picks this month: ${c.n.put}</div></div>
            <div class="cc-pay"><div class="cc-pay-chart"><canvas id="pbsPapPay"></canvas></div><div class="muted small">At expiry, entry premiums included.</div></div>
          </div>
          ${c.legs.length && c.etf ? scenarioHtml(P, c, lot) : ''}
          <h4>Events</h4><table class="grid-tbl cc-ev"><tbody>${c.events.map((e) => `<tr><td>${dayLabel(e.day)} ${e.time}</td><td><span class="cc-kind">${KIND[e.kind] || e.kind}</span></td><td>${num0(e.spot)}</td><td class="cc-ev-text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>
        </div>`
          : `<div class="panel empty"><h3>Between series</h3><p>The last series expired ${P.lastExpiry ? dayLabel(P.lastExpiry) : ''}. The next one opens at 09:30 on the next trading day.</p></div>`) +
        (done.length
          ? `<div class="panel cc-doc"><h3>Finished months</h3><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty</th><th>Re-picks</th><th>Options</th><th>NIFTYBEES held</th><th>Total held</th><th>Total rebought</th></tr></thead><tbody>
            ${done.map((m) => `<tr><td class="l">${monthName(m.expiry)}</td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td>${m.adjustments}</td><td class="${cls(m.opt)}">${inrS(m.opt)}</td><td class="${cls(m.etfOnce)}">${inrS(m.etfOnce)}</td><td class="${cls(m.withOnce)}">${inrS(m.withOnce)}</td><td class="${cls(m.withMonthly)}">${inrS(m.withMonthly)}</td></tr>`).join('')}
            </tbody><tfoot><tr><th class="l">Total</th><td></td><td></td><th class="${cls(tot('opt'))}">${inrS(tot('opt'))}</th><th class="${cls(tot('etfOnce'))}">${inrS(tot('etfOnce'))}</th><th class="${cls(tot('withOnce'))}">${inrS(tot('withOnce'))}</th><th class="${cls(tot('withMonthly'))}">${inrS(tot('withMonthly'))}</th></tr></tfoot></table></div></div>`
          : '');
      if (c?.legs.length)
        payoffChart($('pbsPapPay'), c.legs, lot, c.spot || c.spot0, { qty: P.etfOnce?.qty || 0, b0: c.etf.b0, s0: c.spot0, adj: c.etf.monthlyAdj });
      const scen = el.querySelector('.mcc-scen');
      const now = scen?.querySelector('tr.sel');
      if (scen) scen.scrollTop = scenTop ?? (now ? now.offsetTop - (scen.clientHeight - now.offsetHeight) / 2 : 0);
    }
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => paperAction(b.dataset.a)));
    bindBudget(async (v) => {
      useBudget(v);
      if (!P) return renderPaper();
      try {
        paper = await BT.api(API + '/paper/budget', { budget: v });
        renderPaper();
      } catch (e) {
        $('pbsBudgetNote').innerHTML = `<span class="neg">${esc(e.message)}</span>`;
      }
    });
  }
  // The paper series at its expiry with Nifty every 100 points, 2,000 either way: NIFTYBEES moving with Nifty from its
  // live price, the open legs at intrinsic value, the options' P&L as the paper counts it and the total.
  function scenarioHtml(P, c, lot) {
    const intr = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
    const closed = c.closed.reduce((s, x) => s + x.pnl, 0);
    const costs = (c.costsBy?.CE || 0) + (c.costsBy?.PE || 0);
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
      const bs = ofGrp(c.legs, 'bs').reduce((s, l) => s + l.side * (intr(l, x) - l.entry) * l.lots * lot, 0);
      const fly = ofGrp(c.legs, 'fly').reduce((s, l) => s + l.side * (intr(l, x) - l.entry) * l.lots * lot, 0);
      const opt = closed + bs + fly - costs;
      rows.push({ x, bees, etf, value, bs, fly, opt, total: etf + opt });
    }
    const td = (v) => `<td class="${cls(v)}">${inrS(Math.round(v))}</td>`;
    const move = (x) => (x === base ? 'now' : `${x > spot ? '+' : '−'}${num0(Math.abs(x - spot))} · ${pct(((x - spot) / spot) * 100)}`);
    return `<h4>If Nifty is here at expiry <span class="muted small">every 100 points, 2,000 either way · NIFTYBEES ${num0(qty)} units moving with Nifty from ₹${beesNow.toFixed(2)} · options at intrinsic value · options P&amp;L with re-picks and costs so far</span></h4>
      <div class="tbl-wrap mcc-scen"><table class="grid-tbl"><thead><tr><th>Nifty</th><th class="l">Move</th><th>NIFTYBEES price</th><th>NIFTYBEES P&amp;L</th><th>Options value</th><th>Back spread (open legs)</th><th>Butterflies (open legs)</th><th>Options P&amp;L</th><th>Combined P&amp;L</th></tr></thead><tbody>
      ${rows
        .map(
          (r) =>
            `<tr class="${r.x === base ? 'sel' : ''}"><td><b>${num0(r.x)}</b></td><td class="l muted small">${move(r.x)}</td><td>₹${r.bees.toFixed(2)}</td>${td(r.etf)}<td class="${cls(r.value)}">${inrS(Math.round(r.value))}</td>${td(r.bs)}${td(r.fly)}${td(r.opt)}<td class="${cls(r.total)}"><b>${inrS(Math.round(r.total))}</b></td></tr>`,
        )
        .join('')}
      </tbody></table></div>`;
  }
  function settingsLine(p) {
    return `${pickDesc(p)}, back spread ${p.bs.sell}×${p.bs.buy}, next month's series when this one has under ${p.minDays ?? 15} days left, ${adjDesc(p)}, NIFTYBEES ${p.etf === 'real' ? 'live price' : '= Nifty ÷ 100'}, ${p.budget > 0 ? `budget ${inr(p.budget)}` : "one lot's worth"}`;
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
    const msg = $('pbsPapMsg');
    try {
      if (a === 'reset' && !confirm(`Delete the ${NAME} paper trade and its history?`)) return;
      if (msg) msg.textContent = 'Working…';
      paper = await BT.api(API + '/paper/' + a, a === 'start' ? { params } : a === 'reset' ? { confirm: true } : {});
      renderPaper();
    } catch (e) {
      if (msg) {
        msg.textContent = e.message;
        msg.classList.add('neg');
      }
    }
  }

  // ---------- Trades screen: the paper trade's months ----------
  async function renderPbsTrades() {
    const el = $('pbsTrades');
    if (!el) return;
    try {
      paper = await BT.api(API + '/paper');
    } catch (e) {
      el.innerHTML = `<div class="panel-head"><h3>${NAME} paper trade</h3></div><div class="err small pad">${esc(e.message)}</div>`;
      return;
    }
    const P = paper.paper;
    el.classList.toggle('hidden', !P);
    if (!P) {
      el.innerHTML = '';
      return;
    }
    const head = `<div class="panel-head"><h3>${NAME} paper trade <span class="muted small">${P.status === 'running' ? 'running' : 'paused'} since ${dayLabel(new Date(P.startedAt).toISOString().slice(0, 10))} · ${sizeLabel(P.params)}${P.cycle?.markAt ? ` · marked ${new Date(P.cycle.markAt).toLocaleTimeString('en-IN')}${paper.marketOpen ? '' : ' (market closed: last traded prices)'}` : ''}</span></h3>
        <span class="spacer"></span><button class="btn-sm ghost danger" data-pbt="delete" title="Delete this paper trade and its history (the same as Reset in Trading Ideas)">✕ Delete</button><button class="btn-sm ghost" data-pbt="open" title="Open the paper trade in Trading Ideas">Open in Trading Ideas ▸</button></div>`;
    const lot = P.params.lotSize;
    const legHtml = (l, open) => {
      const now = open ? l.ltp : l.exit;
      const pnl = open ? (now == null ? null : (now - l.entry) * l.side * l.lots * lot) : l.pnl;
      return `<div class="cc-leg"><b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sold' : 'Bought'}</b> ${l.lots}× ${l.strike} ${l.type} <span class="mono">${l.entry.toFixed(1)} → ${now == null ? '—' : now.toFixed(1)}${open ? ' now' : ''}</span>${pnl == null ? '' : ` <span class="${cls(pnl)}">${inrS(pnl)}</span>`}</div>`;
    };
    const legsCell = (open, closed, g) => {
      const o = ofGrp(open, g).map((l) => legHtml(l, true));
      const c = ofGrp(closed, g).map((l) => legHtml(l, false));
      return (
        o.join('') + (c.length ? `${o.length ? '<div class="muted small">closed by re-picks</div>' : ''}${c.join('')}` : '') || '<span class="muted">—</span>'
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
        <td class="l cc-legs">${legsCell(c.legs, c.closed, 'bs')}</td><td class="l cc-legs">${legsCell(c.legs, c.closed, 'fly')}</td>
        ${money(c.opt)}${money(c.etfOnce)}${money(c.opt == null ? null : total, true)}
        <td><button class="btn-sm ghost" data-pbt="builder" title="Open this series' open option legs in the Builder as a live paper position at their paper entry prices">▶ Open in Builder</button></td></tr>`);
    }
    for (const m of [...(P.months || [])].reverse())
      rows.push(`<tr><td class="l"><b>${NAME}</b></td><td class="l"><b>${monthName(m.expiry)}</b><div class="muted small">to ${dayLabel(m.expiry)}</div></td>
        <td class="l"><span class="cat-pill">closed</span></td><td class="muted">${m.entry ? dayLabel(m.entry.day) : ''}<div>Nifty ${num0(m.spot0)} → ${num0(m.spotE)}</div></td>
        <td class="l cc-legs"><div class="cc-leg"><b class="pos">Held</b> NIFTYBEES</div></td>
        <td class="l cc-legs">${legsCell([], m.closed, 'bs')}</td><td class="l cc-legs">${legsCell([], m.closed, 'fly')}</td>
        ${money(m.opt)}${money(m.etfOnce)}${money(m.withOnce, true)}<td></td></tr>`);
    const sum = (k) => (P.months || []).reduce((n, m) => n + (m[k] || 0), 0);
    const all = { opt: sum('opt') + (c?.opt || 0), etf: sum('etfOnce') + (c?.etfOnce || 0) };
    el.innerHTML =
      head +
      `<div class="tbl-wrap sb-trades-wrap"><table class="grid-tbl sb-trades-tbl cc-trades-tbl"><thead><tr><th class="l">Strategy</th><th class="l">Month</th><th class="l">Status</th><th>Entered</th>
        <th class="l">NIFTYBEES<br><span class="muted">units · price at the series start → now</span></th><th class="l">Back spread<br><span class="muted">lots × strike · entry → now / exit</span></th><th class="l">Butterflies</th>
        <th>Options</th><th>NIFTYBEES</th><th>Total</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="11" class="muted l">No series open yet: the next one opens at 09:30 on the next trading day.</td></tr>'}</tbody></table></div>
      <div class="muted small pad">Whole paper trade: total <b class="${cls(all.opt + all.etf)}">${inrS(all.opt + all.etf)}</b> · options ${inrS(all.opt)} · NIFTYBEES held ${inrS(all.etf)}. P&amp;L after costs; the open series at the last traded prices. Paper only: nothing is sent.</div>`;
    el.querySelector('[data-pbt="open"]')?.addEventListener('click', () => {
      tab = 'paper';
      BT.store.set('pbs-tab', tab);
      window.app.setView(VIEW);
      if (started && params) render();
    });
    el.querySelector('[data-pbt="delete"]')?.addEventListener('click', async () => {
      if (!confirm(`Delete the ${NAME} paper trade and its history?`)) return;
      try {
        paper = await BT.api(API + '/paper/reset', { confirm: true });
      } catch (e) {
        alert('Could not delete: ' + e.message);
      }
      renderPbsTrades();
    });
    el.querySelector('[data-pbt="builder"]')?.addEventListener('click', toBuilder);
  }

  function poll() {
    clearTimeout(pollT);
    if (tab !== 'paper' || window.app?.state.view !== VIEW || !started) return;
    pollT = setTimeout(async () => {
      if (!document.hidden && tab === 'paper' && window.app?.state.view === VIEW && document.activeElement?.id !== 'pbsBudget') {
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
      if (!document.hidden && window.app?.state.view === 'tr') await renderPbsTrades();
      pollTrades();
    }, 30_000);
  }
  window.addEventListener('viewchange', (e) => {
    if (e.detail === VIEW) applyIdea();
    else poll();
    if (e.detail === 'tr') renderPbsTrades().then(pollTrades);
  });
  if (window.app?.state.view === VIEW) applyIdea();
  if (window.app?.state.view === 'tr') renderPbsTrades().then(pollTrades);
})();
