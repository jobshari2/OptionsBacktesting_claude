// Hedge → "Backtest" tab: replays hedge strategies over historical Nifty + India VIX closes
// (POST /api/hedge/backtest, see hedge/backtest.js) and compares how each one did.
// Strategies: templates A–G built from the strike settings, your own custom legs, and every hedge
// currently on the Planner tab (its strikes as % of today's spot, same expiry length).
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const { esc } = window.app;
  const planner = window.hedgePlanner;
  const { inr, parseInr, LETTERS } = planner;
  const C = { muted: css('--muted'), text: css('--text'), grid: 'rgba(139,148,158,.12)', zero: 'rgba(139,148,158,.45)' };
  // distinct line colours for up to 16 strategies (No hedge is the grey dashed line)
  const PALETTE = ['#58a6ff', '#3fb68b', '#f0716b', '#d6af4c', '#b392f0', '#56d4dd', '#ff9f43', '#e86fb0', '#9bd35a', '#7c8cff', '#ffd166', '#4dd0a7', '#ff7b72', '#a0c4ff', '#c9a0ff', '#8fd694'];

  const local = (k, d) => { try { return JSON.parse(localStorage.getItem('oc.hedge.bt.' + k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem('oc.hedge.bt.' + k, JSON.stringify(v)); } catch {} };

  // Same families and order as the Planner's strategy board (A–G).
  const TEMPLATES = [
    ['put', 'Protective put'], ['spread', 'Put spread'], ['spreadtail', 'Put spread + tail put'], ['partial', 'Partial collar'],
    ['seagull', 'Seagull'], ['collar', 'Collar'], ['tail', 'Tail hedge'],
  ];

  const yearsAgo = (y) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); return d.toISOString().slice(0, 10); };
  const today = () => new Date().toISOString().slice(0, 10);

  // Form fields: element id → [setting key, default]. Blank optional fields mean "off".
  const FIELDS = {
    hbFrom: ['from', '2024-07-01'], hbTo: ['to', '2026-10-02'],
    hbValue: ['value', ''], hbBeta: ['beta', ''], hbHedgePct: ['hedgePct', 100], hbLot: ['lot', ''], hbWhole: ['wholeLots', true],
    hbTenor: ['tenorDays', '90'], hbRollLeft: ['rollDaysLeft', 0], hbExitFall: ['exitFallPct', ''], hbExitMult: ['exitMultiple', ''], hbMaxVol: ['maxEntryVol', ''],
    hbPutK: ['putK', -5], hbWidth: ['width', 10], hbTailK: ['tailK', -20], hbCallK: ['callK', 10], hbStep: ['strikeStep', '100'],
    hbVolSrc: ['volSource', 'vix'], hbVolMult: ['volMult', 1], hbFixedVol: ['fixedVol', 16], hbRvWin: ['rvWindow', 20],
    hbPutSkew: ['putSkew', 3], hbCallSkew: ['callSkew', -1], hbTerm: ['termAdjust', true],
    hbSpread: ['spreadPct', 4], hbCharges: ['chargesPerLeg', 30], hbRate: ['ratePct', 6.5], hbDiv: ['divYieldPct', 1.3],
  };

  const bt = {
    settings: local('settings', {}),
    checked: new Set(local('checked', TEMPLATES.map(([f]) => `t:${f}`))),
    custom: local('custom', [{ action: 'buy', type: 'PE', k: -5, size: 100 }]),
    sort: local('sort', null), // { k, dir }
    chartMode: local('chartMode', 'value'),
    selected: null, // result id whose trades are shown
    result: null,
    specs: [], // everything that can be ticked: { id, label, group, desc, body }
    chart: null,
    busy: false,
  };
  // One-time: drop dates remembered from earlier visits so the default period (Jul 2024 → Oct 2026) shows.
  if (local('datesV', 0) < 1) {
    delete bt.settings.from;
    delete bt.settings.to;
    save('settings', bt.settings);
    save('datesV', 1);
  }

  // ---------- form ----------
  const getField = (id) => { const el = $(id); return el.type === 'checkbox' ? el.checked : el.value; };
  function fillForm() {
    for (const [id, [key, def]] of Object.entries(FIELDS)) {
      const el = $(id);
      const v = bt.settings[key] ?? def;
      if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v;
    }
    showVolFields();
  }
  function readForm() {
    for (const [id, [key]] of Object.entries(FIELDS)) bt.settings[key] = getField(id);
    save('settings', bt.settings);
  }
  const showVolFields = () => {
    const src = $('hbVolSrc').value;
    document.querySelectorAll('.hb-vol-vix, .hb-vol-realised, .hb-vol-fixed').forEach((el) => el.classList.toggle('hidden', !el.classList.contains(`hb-vol-${src}`)));
  };
  // Placeholders show what an empty field falls back to (the Planner's portfolio).
  function plannerDefaults() {
    const d = planner.data();
    const value = d?.portfolio?.value > 0 ? d.portfolio.value : 1e7;
    const beta = d?.portfolio?.value > 0 ? d.portfolio.beta : 1;
    const lot = d?.lot || 75;
    $('hbValue').placeholder = `${inr(value)}${d?.portfolio?.value > 0 ? ' (planner)' : ''}`;
    $('hbBeta').placeholder = beta.toFixed(2);
    $('hbLot').placeholder = lot;
    return { value, beta, lot };
  }

  $('hbForm').addEventListener('change', (e) => {
    if (e.target.id === 'hbVolSrc') showVolFields();
    readForm();
    if (['hbPutK', 'hbWidth', 'hbTailK', 'hbCallK', 'hbTenor', 'hbHedgePct'].includes(e.target.id)) renderList();
  });
  $('hbPresets').addEventListener('click', (e) => {
    const y = e.target.dataset.y;
    if (y == null) return;
    $('hbFrom').value = Number(y) ? yearsAgo(Number(y)) : '2008-01-01';
    $('hbTo').value = today();
    readForm();
  });
  $('hbReset').addEventListener('click', () => { bt.settings = {}; save('settings', {}); fillForm(); renderList(); });

  // ---------- strategy list ----------
  const pctS = (k) => `${k > 0 ? '+' : k < 0 ? '−' : ''}${Math.abs(Math.round(k * 10) / 10)}%`;
  const legDesc = (legs) => legs.map((l) => `${l.action === 'buy' ? 'B' : 'S'} ${l.type} ${l.k === 0 ? 'ATM' : pctS(l.k)}${Math.abs(l.ratio - 1) > 0.01 ? ` ×${Math.round(l.ratio * 100)}%` : ''}`).join(' · ');
  const tenorLabel = (n) => (n >= 330 ? `${Math.round(n / 365 * 10) / 10}y` : n >= 55 ? `${Math.round(n / 30.4)}m` : `${n}d`);

  // Mirrors hedge/backtest.js TEMPLATES so the list can describe each one's legs.
  function templateLegs(f, s) {
    const putK = Number(s.putK ?? -5), width = Number(s.width ?? 10), tailK = Number(s.tailK ?? -20), callK = Number(s.callK ?? 10);
    const L = (action, type, k, ratio = 1) => ({ action, type, k, ratio });
    return {
      put: [L('buy', 'PE', putK)],
      spread: [L('buy', 'PE', putK), L('sell', 'PE', putK - width)],
      spreadtail: [L('buy', 'PE', putK), L('sell', 'PE', putK - width), L('buy', 'PE', Math.min(tailK, putK - width - 5))],
      partial: [L('buy', 'PE', putK), L('sell', 'CE', callK, 0.5)],
      seagull: [L('buy', 'PE', putK), L('sell', 'PE', putK - width), L('sell', 'CE', callK)],
      collar: [L('buy', 'PE', putK), L('sell', 'CE', callK)],
      tail: [L('buy', 'PE', tailK)],
    }[f];
  }

  // A live Planner hedge → strikes as % of today's spot, lots as a share of the exposure.
  function fromLive(c, d) {
    const full = d.search.fullLots || 1;
    return c.legs.map((l) => ({ action: l.action, type: l.type, k: Math.round((l.strike / d.spot - 1) * 1000) / 10, ratio: Math.round((l.lots / full) * 1000) / 1000 }));
  }

  function buildSpecs() {
    const s = bt.settings;
    const tenor = Number(s.tenorDays || 90);
    const out = TEMPLATES.map(([f, name], i) => ({
      id: `t:${f}`, label: `${LETTERS[i]} · ${name}`, group: 'Templates — use the strike settings',
      desc: `${legDesc(templateLegs(f, s))} · ${tenorLabel(tenor)}`, body: { id: `t:${f}`, family: f, label: `${LETTERS[i]} · ${name}` },
    }));
    const cl = bt.custom.filter((l) => Number(l.size) > 0);
    if (cl.length) {
      const legs = cl.map((l) => ({ action: l.action, type: l.type, k: Number(l.k), ratio: Number(l.size) / 100 }));
      out.push({ id: 'custom', label: 'Custom legs', group: 'Templates — use the strike settings', desc: `${legDesc(legs)} · ${tenorLabel(tenor)} (size × hedge size)`, body: { id: 'custom', label: 'Custom legs', legs, scaleByHedge: true } });
    }
    const d = planner.data();
    if (d && !d.empty && d.spot) {
      const grp = `From the Planner — today's strikes as % of spot (Nifty ${Math.round(d.spot)})`;
      const add = (id, label, c) => {
        const legs = fromLive(c, d);
        const days = Math.max(7, Math.round(c.days));
        out.push({ id, label, group: grp, desc: `${legDesc(legs)} · ${tenorLabel(days)}`, body: { id, label, legs, tenorDays: days, group: 'planner' } });
      };
      d.search.strategies.forEach((x, i) => { if (x.option) add(`p:${x.family}`, `Planner ${LETTERS[i]} · ${x.name}`, x.option); });
      if (d.custom) add('p:custom', 'Planner H · Your structure', d.custom);
      (d.saved || []).forEach((x, i) => { if (!x.error) add(`p:${x.id}`, `S${i + 1} · ${x.name}`, x); });
    }
    bt.specs = out;
  }

  function renderList() {
    buildSpecs();
    let grp = null;
    const html = [];
    for (const s of bt.specs) {
      if (s.group !== grp) { grp = s.group; html.push(`<div class="grp">${esc(grp)}</div>`); }
      html.push(`<label title="${esc(s.desc)}"><input type="checkbox" data-id="${esc(s.id)}"${bt.checked.has(s.id) ? ' checked' : ''}><span><b>${esc(s.label)}</b> <span class="d">${esc(s.desc)}</span></span></label>`);
    }
    if (!bt.specs.some((s) => s.id.startsWith('p:'))) html.push('<div class="grp">From the Planner</div><div class="muted small">Open the Planner tab with a portfolio to add its live hedges here.</div>');
    $('hbList').innerHTML = html.join('');
    renderCustom();
  }
  $('hbList').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) bt.checked.add(id); else bt.checked.delete(id);
    save('checked', [...bt.checked]);
  });
  const setAll = (on) => { for (const s of bt.specs) on ? bt.checked.add(s.id) : bt.checked.delete(s.id); save('checked', [...bt.checked]); renderList(); };
  $('hbAll').addEventListener('click', () => setAll(true));
  $('hbNone').addEventListener('click', () => setAll(false));

  // ---------- custom legs ----------
  function renderCustom() {
    $('hbCLegs').innerHTML = bt.custom.map((l, i) => `<tr data-i="${i}">
      <td><select data-f="action"><option value="buy"${l.action === 'buy' ? ' selected' : ''}>Buy</option><option value="sell"${l.action === 'sell' ? ' selected' : ''}>Sell</option></select></td>
      <td><select data-f="type"><option value="PE"${l.type === 'PE' ? ' selected' : ''}>PE</option><option value="CE"${l.type === 'CE' ? ' selected' : ''}>CE</option></select></td>
      <td><input data-f="k" type="number" step="1" value="${l.k}"></td>
      <td><input data-f="size" type="number" step="5" min="0" value="${l.size}"></td>
      <td><button class="h-ed-del" data-del="${i}" title="Remove leg">✕</button></td>
    </tr>`).join('');
  }
  const customChanged = () => { save('custom', bt.custom); bt.checked.add('custom'); save('checked', [...bt.checked]); renderList(); };
  $('hbCLegs').addEventListener('change', (e) => {
    const i = Number(e.target.closest('tr')?.dataset.i);
    const f = e.target.dataset.f;
    if (Number.isNaN(i) || !f) return;
    bt.custom[i][f] = f === 'k' || f === 'size' ? Number(e.target.value) : e.target.value;
    customChanged();
  });
  $('hbCLegs').addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    if (del == null || bt.custom.length <= 1) return;
    bt.custom.splice(Number(del), 1);
    customChanged();
  });
  $('hbCAdd').addEventListener('click', () => {
    const last = bt.custom[bt.custom.length - 1];
    bt.custom.push({ action: 'sell', type: 'PE', k: (last?.k ?? 0) - 10, size: last?.size ?? 100 });
    customChanged();
  });
  $('hbCCopy').addEventListener('click', () => {
    const d = planner.data();
    const c = d?.selected;
    if (!c || d.empty) { $('hbStatus').textContent = 'Select a hedge on the Planner tab first'; return; }
    const hedge = Number(bt.settings.hedgePct || 100) / 100;
    bt.custom = fromLive(c, d).map((l) => ({ action: l.action, type: l.type, k: l.k, size: Math.round((l.ratio / hedge) * 100) }));
    customChanged();
    $('hbStatus').textContent = `Copied ${c.legs.length} leg${c.legs.length > 1 ? 's' : ''} from the Planner`;
  });

  // ---------- run ----------
  async function run() {
    if (bt.busy) return;
    readForm();
    buildSpecs();
    const chosen = bt.specs.filter((s) => bt.checked.has(s.id));
    if (!chosen.length) { $('hbStatus').textContent = 'Tick at least one strategy'; return; }
    const s = bt.settings;
    const def = plannerDefaults();
    const value = s.value === '' || s.value == null ? def.value : parseInr(s.value);
    if (!(value > 0)) { $('hbStatus').textContent = `Couldn't read “${s.value}” — use e.g. 2500000, 25L or 1.2Cr`; return; }
    const body = {
      ...s,
      startValue: value,
      beta: s.beta === '' ? def.beta : Number(s.beta),
      lot: s.lot === '' ? def.lot : Number(s.lot),
      strategies: chosen.map((x) => x.body),
    };
    bt.busy = true;
    $('hbRun').disabled = true;
    const t0 = Date.now();
    $('hbStatus').textContent = 'Loading Nifty & VIX history and running… (the first run downloads ~18 years, may take a minute)';
    try {
      const r = await fetch('/api/hedge/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      // colour per strategy, fixed by its position in the full list so colours don't jump between runs
      j.results.forEach((x) => { x.color = PALETTE[Math.max(0, bt.specs.findIndex((sp) => sp.id === x.id)) % PALETTE.length]; });
      bt.result = j;
      if (!j.results.some((x) => x.id === bt.selected)) bt.selected = j.results[0]?.id ?? null;
      render();
      $('hbStatus').textContent = `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s · history ${j.available.from} → ${j.available.to}`;
    } catch (e) {
      $('hbStatus').textContent = 'Error: ' + e.message;
    } finally {
      bt.busy = false;
      $('hbRun').disabled = false;
    }
  }
  $('hbRun').addEventListener('click', run);

  // ---------- render ----------
  const sgn = (v, d = 1) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const num2 = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const dt = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  const mon = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

  function render() {
    const r = bt.result;
    if (!r) return;
    renderTiles(r);
    renderChart(r);
    renderTable(r);
    renderCrises(r);
    renderPeriods(r);
    renderTrades(r);
  }

  function renderTiles(r) {
    const u = r.unhedged.stats;
    const tile = (s, v, n, vc = '') => `<div class="st"><span class="s">${s}</span><span class="v ${vc}">${v}</span><span class="n">${n}</span></div>`;
    const by = (f, better) => r.results.reduce((b, x) => (f(x) != null && (!b || better(f(x), f(b))) ? x : b), null);
    const hi = by((x) => x.stats.cagrPct, (a, b) => a > b);
    const dd = by((x) => x.stats.maxDdPct, (a, b) => a > b);
    const cal = by((x) => x.stats.calmar, (a, b) => a > b);
    const v = r.volUsed;
    $('hbTiles').innerHTML = [
      tile('Period', `${mon(r.range.from)} → ${mon(r.range.to)}`, `${r.range.days} trading days · Nifty ${Math.round(r.range.niftyFrom)} → ${Math.round(r.range.niftyTo)} (${sgn(r.range.niftyPct)})`),
      tile('No hedge', `${sgn(u.cagrPct, 2)} / yr`, `max drawdown ${sgn(u.maxDdPct)} · ends ${inr(u.final)}`, cls(u.cagrPct)),
      hi ? tile('Highest return', `${sgn(hi.stats.cagrPct, 2)} / yr`, `${esc(hi.label)} · ${sgn(hi.stats.cagrPct - u.cagrPct, 2)} vs no hedge`, cls(hi.stats.cagrPct)) : '',
      dd ? tile('Smallest drawdown', sgn(dd.stats.maxDdPct), `${esc(dd.label)} · ${sgn(dd.stats.maxDdPct - u.maxDdPct)} pts vs no hedge`, 'neg') : '',
      cal ? tile('Best return ÷ drawdown', num2(cal.stats.calmar), `${esc(cal.label)} · no hedge ${num2(u.calmar)}`) : '',
      tile('Volatility used', `${v.avg.toFixed(1)}% avg`, v.source === 'vix' ? `India VIX${v.fellBack ? ` (realised vol before ${v.vixFrom})` : ''} · long-run ${v.longRun.toFixed(1)}%` : v.source === 'realised' ? 'realised volatility' : 'fixed'),
    ].join('');
  }

  // ---------- chart ----------
  function series(r, id) {
    const eq = id === 'none' ? r.curve.unhedged : r.curve.series[id];
    if (bt.chartMode === 'value') return eq;
    if (bt.chartMode === 'rel') return eq.map((v, i) => (v / r.curve.unhedged[i] - 1) * 100);
    let peak = -Infinity;
    return eq.map((v) => { peak = Math.max(peak, v); return (v / peak - 1) * 100; });
  }
  function renderChart(r) {
    $('hbChartMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === bt.chartMode));
    const pctMode = bt.chartMode !== 'value';
    if (!bt.chart) {
      bt.chart = new Chart($('cBt'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
          animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, callback: function (v) { return mon(this.getLabelForValue(v)); } } },
            y: { grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false }, ticks: {} },
          },
          plugins: {
            legend: { position: 'top', align: 'start', labels: { boxWidth: 12, boxHeight: 2 } },
            tooltip: { itemSort: (a, b) => b.raw - a.raw, callbacks: { title: (i) => dt(i[0].label), label: (c) => ` ${c.dataset.label}: ${bt.chartMode === 'value' ? inr(c.raw) : sgn(c.raw)}` } },
          },
        },
      });
    }
    const ch = bt.chart;
    const hiddenBefore = new Map(ch.data.datasets.map((ds, i) => [ds.key, !ch.isDatasetVisible(i)]));
    ch.options.scales.y.ticks.callback = pctMode ? (v) => `${v}%` : (v) => inr(v, 1);
    ch.options.scales.y.type = 'linear';
    ch.data.labels = r.curve.dates;
    ch.data.datasets = [
      { key: 'none', label: 'No hedge', data: series(r, 'none'), borderColor: C.muted, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, hidden: hiddenBefore.get('none') ?? (bt.chartMode === 'rel') },
      ...r.results.map((x) => ({ key: x.id, label: x.label, data: series(r, x.id), borderColor: x.color, backgroundColor: x.color, borderWidth: x.id === bt.selected ? 3 : 1.5, pointRadius: 0, hidden: hiddenBefore.get(x.id) ?? false })),
    ];
    ch.update('none');
  }
  $('hbChartMode').addEventListener('click', (e) => {
    if (!e.target.dataset.m) return;
    bt.chartMode = e.target.dataset.m;
    save('chartMode', bt.chartMode);
    if (bt.result) renderChart(bt.result);
  });

  // ---------- summary table ----------
  // [key, header, value(x), format, higher is better?, title]
  const COLS = [
    ['final', 'Final value', (x) => x.stats.final, (v) => inr(v), true],
    ['total', 'Total return', (x) => x.stats.totalPct, (v) => sgn(v), true],
    ['cagr', 'Return / yr', (x) => x.stats.cagrPct, (v) => sgn(v, 2), true, 'Compound annual growth rate'],
    ['dd', 'Max drawdown', (x) => x.stats.maxDdPct, (v) => sgn(v), true, 'Biggest fall from a high, hedged portfolio'],
    ['ddv', 'DD vs none', (x, u) => x.stats.maxDdPct - u.maxDdPct, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} pts`, true, 'How much smaller the max drawdown was than with no hedge'],
    ['vol', 'Volatility', (x) => x.stats.volPct, (v) => `${v.toFixed(1)}%`, false, 'Annualised volatility of daily returns'],
    ['sharpe', 'Sharpe', (x) => x.stats.sharpe, num2, true, '(Return − risk-free) ÷ volatility'],
    ['sortino', 'Sortino', (x) => x.stats.sortino, num2, true, '(Return − risk-free) ÷ downside volatility'],
    ['calmar', 'Calmar', (x) => x.stats.calmar, num2, true, 'Return per year ÷ max drawdown'],
    ['w1m', 'Worst month', (x) => x.stats.worst1mPct, (v) => sgn(v), true, 'Worst 21-trading-day return'],
    ['w3m', 'Worst 3M', (x) => x.stats.worst3mPct, (v) => sgn(v), true, 'Worst 63-trading-day return'],
    ['w1y', 'Worst year', (x) => x.stats.worst1yPct, (v) => sgn(v), true, 'Worst 252-trading-day return'],
    ['opt', 'Options P&L', (x) => x.options?.net, (v) => inr(v), true, 'Everything the options made or lost, incl. the one still open'],
    ['prem', 'Paid to open', (x) => x.options?.premiumPaid, (v) => inr(v), false, 'Net premium + charges paid when opening hedges (negative = received)'],
    ['cost', 'Cost / yr', (x) => x.options?.costPerYearPct, (v) => `${v.toFixed(2)}%`, false, 'Average opening cost per year, % of holdings'],
    ['rolls', 'Trades', (x) => x.options?.rolls, (v) => String(v), null],
    ['paid', 'Paid off', (x) => (x.options?.rolls ? (x.options.paidOff / x.options.rolls) * 100 : null), (v) => `${v.toFixed(0)}%`, true, 'Share of trades that got back more than they cost'],
    ['best', 'Best trade', (x) => x.options?.bestRoll?.pnl, (v) => inr(v), true],
    ['worst', 'Worst trade', (x) => x.options?.worstRoll?.pnl, (v) => inr(v), true],
  ];

  function renderTable(r) {
    const u = r.unhedged.stats;
    const rows = [...r.results];
    if (bt.sort) {
      const col = COLS.find((c) => c[0] === bt.sort.k);
      const v = (x) => { const n = col?.[2](x, u); return n == null || !isFinite(n) ? -1e18 : n; };
      if (col) rows.sort((a, b) => (v(a) - v(b)) * bt.sort.dir);
    }
    $('hbHead').innerHTML = `<tr><th>Strategy</th><th>Expiry</th>${COLS.map(([k, h, , , , t]) => `<th data-k="${k}"${t ? ` title="${esc(t)}"` : ''}${bt.sort?.k === k ? ' class="sorted"' : ''}>${h}${bt.sort?.k === k ? (bt.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
    // best value per column (among strategies)
    const best = {};
    for (const [k, , f, , hib] of COLS) {
      if (hib == null) continue;
      const vals = r.results.map((x) => f(x, u)).filter((v) => v != null && isFinite(v));
      if (vals.length > 1) best[k] = hib ? Math.max(...vals) : Math.min(...vals);
    }
    const base = { stats: u, options: null };
    const cells = (x, isBase) => COLS.map(([k, , f, fmt, hib]) => {
      const v = isBase && ['ddv', 'opt', 'prem', 'cost', 'rolls', 'paid', 'best', 'worst'].includes(k) ? null : f(x, u);
      const c = [['total', 'cagr', 'dd', 'ddv', 'w1m', 'w3m', 'w1y', 'opt', 'best', 'worst'].includes(k) ? cls(v) : '', !isBase && best[k] != null && v === best[k] && hib != null ? 'best' : ''].filter(Boolean).join(' ');
      return `<td class="${c}">${v == null || !isFinite(v) ? '—' : fmt(v)}</td>`;
    }).join('');
    $('hbBody').innerHTML = `<tr class="base"><td class="lbl"><span class="sw2" style="background:${C.muted}"></span>No hedge</td><td class="muted">—</td>${cells(base, true)}</tr>`
      + rows.map((x) => `<tr data-id="${esc(x.id)}"${x.id === bt.selected ? ' class="on"' : ''}><td class="lbl" title="${esc(legDesc(x.legs))}"><span class="sw2" style="background:${x.color}"></span>${esc(x.label)}</td><td class="muted">${tenorLabel(x.tenorDays)}</td>${cells(x, false)}</tr>`).join('');
  }
  $('hbHead').addEventListener('click', (e) => {
    const k = e.target.closest('th')?.dataset.k;
    if (!k) return;
    bt.sort = bt.sort?.k === k ? (bt.sort.dir < 0 ? { k, dir: 1 } : null) : { k, dir: -1 };
    save('sort', bt.sort);
    if (bt.result) renderTable(bt.result);
  });
  const selectRow = (e) => {
    const id = e.target.closest('tr')?.dataset.id;
    if (!id || !bt.result) return;
    bt.selected = id;
    render();
  };
  $('hbBody').addEventListener('click', selectRow);

  // ---------- crises & years ----------
  function renderCrises(r) {
    if (!r.crises.length) {
      $('hbCrisisHead').innerHTML = '';
      $('hbCrisisBody').innerHTML = '<tr><td class="muted" style="text-align:left">Nifty never fell 8% or more from a high in this period.</td></tr>';
      return;
    }
    $('hbCrisisHead').innerHTML = `<tr><th>Strategy</th>${r.crises.map((c) => `<th title="${dt(c.from)} → ${dt(c.to)}">${mon(c.from)}–${mon(c.to)}<br><span class="neg">Nifty ${sgn(c.depth, 0)}</span></th>`).join('')}</tr>`;
    const row = (label, color, f, id) => `<tr${id ? ` data-id="${esc(id)}"${id === bt.selected ? ' class="on"' : ''}` : ' class="base"'}><td class="lbl"><span class="sw2" style="background:${color}"></span>${esc(label)}</td>${r.crises.map((c) => { const v = f(c); return `<td class="${cls(v)}">${sgn(v)}</td>`; }).join('')}</tr>`;
    $('hbCrisisBody').innerHTML = row('No hedge', C.muted, (c) => c.unhedged) + r.results.map((x) => row(x.label, x.color, (c) => c.results[x.id], x.id)).join('');
  }
  $('hbCrisisBody').addEventListener('click', selectRow);

  // Returns by period: rows = years or months (newest first), columns = Nifty, No hedge, each strategy.
  // Monthly view puts each year's total above its months; the footer summarises every column.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function renderPeriods(r) {
    const monthly = bt.periodMode === 'month';
    $('hbPeriodMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === bt.periodMode));
    const key = monthly ? 'months' : 'years';
    const cols = [
      { label: 'Nifty', color: null, data: r.nifty[key], years: r.nifty.years, nf: true },
      { label: 'No hedge', color: C.muted, data: r.unhedged[key], years: r.unhedged.years, base: true },
      ...r.results.map((x) => ({ id: x.id, label: x.label, color: x.color, data: x[key], years: x.years })),
    ];
    const un = r.unhedged;
    $('hbPerHead').innerHTML = `<tr><th>${monthly ? 'Month' : 'Year'}</th>${cols.map((c) => `<th class="${c.id ? `strat${c.id === bt.selected ? ' on' : ''}` : ''}"${c.id ? ` data-id="${esc(c.id)}"` : ''}>${c.color ? `<span class="sw2" style="background:${c.color}"></span>` : ''}${esc(c.label)}</th>`).join('')}</tr>`;
    const cell = (c, v, unV) => {
      const k = [cls(v), c.nf ? 'nf' : '', !c.nf && !c.base && v != null && unV != null && v > unV + 0.005 ? 'beat' : ''].filter(Boolean).join(' ');
      return `<td class="${k}">${sgn(v)}</td>`;
    };
    const rowOf = (label, get, getUn, trCls = '') => `<tr${trCls ? ` class="${trCls}"` : ''}><td>${label}</td>${cols.map((c) => cell(c, get(c), getUn())).join('')}</tr>`;
    const out = [];
    if (monthly) {
      const months = Object.keys(un.months).sort().reverse();
      let year = null;
      for (const m of months) {
        const y = m.slice(0, 4);
        if (y !== year) { year = y; out.push(rowOf(`<b>${y}</b>`, (c) => c.years[y], () => un.years[y], 'yr')); }
        out.push(rowOf(`${MONTHS[Number(m.slice(5, 7)) - 1]} ${y}`, (c) => c.data[m], () => un.months[m]));
      }
    } else {
      for (const y of Object.keys(un.years).sort().reverse()) out.push(rowOf(y, (c) => c.data[y], () => un.years[y]));
    }
    $('hbPerBody').innerHTML = out.join('');
    // summary over the whole column (first/last periods may be partial)
    const vals = (c) => Object.values(c.data).filter((v) => v != null && isFinite(v));
    const unVals = Object.keys(un[key]);
    const foot = (label, f, fmt = sgn) => `<tr><td>${label}</td>${cols.map((c) => { const v = f(c); return `<td class="${fmt === sgn ? cls(v) : ''}">${v == null ? '—' : fmt(v)}</td>`; }).join('')}</tr>`;
    const per = monthly ? 'month' : 'year';
    $('hbPerFoot').innerHTML = [
      foot(`Average ${per}`, (c) => { const v = vals(c); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }),
      foot(`Best ${per}`, (c) => (vals(c).length ? Math.max(...vals(c)) : null)),
      foot(`Worst ${per}`, (c) => (vals(c).length ? Math.min(...vals(c)) : null)),
      foot(`${monthly ? 'Months' : 'Years'} up`, (c) => { const v = vals(c); return v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null; }, (v) => `${v.toFixed(0)}%`),
      foot('Beat no hedge', (c) => (c.nf || c.base ? null : (unVals.filter((k) => c.data[k] > un[key][k] + 0.005).length / unVals.length) * 100), (v) => `${v.toFixed(0)}%`),
    ].join('');
  }
  bt.periodMode = local('periodMode', 'year');
  $('hbPeriodMode').addEventListener('click', (e) => {
    if (!e.target.dataset.m) return;
    bt.periodMode = e.target.dataset.m;
    save('periodMode', bt.periodMode);
    if (bt.result) renderPeriods(bt.result);
  });
  $('hbPerHead').addEventListener('click', (e) => {
    const id = e.target.closest('th')?.dataset.id;
    if (!id || !bt.result) return;
    bt.selected = id;
    render();
  });

  // ---------- trade log ----------
  function renderTrades(r) {
    const x = r.results.find((y) => y.id === bt.selected);
    if (!x) { $('hbTradesTitle').textContent = 'Trades'; $('hbTradesSub').textContent = ''; $('hbTrades').innerHTML = ''; return; }
    const o = x.options;
    $('hbTradesTitle').innerHTML = `Trades · <span style="color:${x.color}">${esc(x.label)}</span>`;
    $('hbTradesSub').textContent = `${o.rolls} trades · ${o.paidOff} paid off · paid ${inr(o.premiumPaid)} to open in total · options P&L ${inr(o.net)}${Math.abs(o.openValue) > 1 ? ` (incl. ${inr(o.openValue)} still open)` : ''}`;
    const L = r.params.lot;
    $('hbTrades').innerHTML = x.trades.length ? [...x.trades].reverse().map((t) => {
      const net = t.pnl + t.holdingsMove;
      return `<tr>
        <td>${dt(t.open)}</td><td>${dt(t.close)}</td><td class="muted">${esc(t.reason)}</td>
        <td>${Math.round(t.spotIn)} → ${Math.round(t.spotOut)} <span class="${cls(t.niftyMove)}">${sgn(t.niftyMove)}</span></td>
        <td class="muted">${t.volIn.toFixed(1)}%</td>
        <td class="legs-t">${t.legs.map((l) => `<span class="act-${l.action}">${l.action === 'buy' ? 'B' : 'S'}</span> ${Number.isInteger(l.lots) ? l.lots : l.lots.toFixed(2)}× ${l.strike} ${l.type} ${l.entry.toFixed(1)}→${l.exit.toFixed(1)}`).join(' · ')}<span class="muted"> (lot ${L})</span></td>
        <td>${inr(t.cost)}</td><td>${inr(t.proceeds)}</td>
        <td class="${cls(t.pnl)}">${inr(t.pnl)}</td><td class="${cls(t.holdingsMove)}">${inr(t.holdingsMove)}</td><td class="${cls(net)}"><b>${inr(net)}</b></td>
      </tr>`;
    }).join('') : '<tr><td colspan="11" class="muted" style="text-align:left">No trades — the hedge was never opened (check the IV limit).</td></tr>';
  }

  // ---------- tabs ----------
  let opened = false;
  function setTab(t) {
    save('tab', t);
    $('hTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('hPlanPane').classList.toggle('hidden', t !== 'plan');
    $('hBtPane').classList.toggle('hidden', t !== 'bt');
    $('hTabNote').textContent = t === 'bt' ? 'Replay hedges over past Nifty moves, priced from India VIX' : 'Live hedges priced from the current option chain';
    if (t === 'plan') { window.onHedgeRender?.(); return; }
    if (!opened) { opened = true; fillForm(); }
    plannerDefaults();
    renderList();
    if (bt.chart) bt.chart.resize();
  }
  $('hTabs').addEventListener('click', (e) => { if (e.target.dataset.t) setTab(e.target.dataset.t); });
  setTab(local('tab', 'plan'));
})();
