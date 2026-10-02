// Compare screen: run several strategies over the same period and expiries, then rank them.
(() => {
  const { $, esc, inr, inrS, kinr, pct, num, cls, dayShort } = BT;
  let settings = null;
  let selected = new Set(BT.store.get('cmpSel', ['lib-straddle-920', 'lib-straddle-920-re', 'lib-strangle-prem', 'lib-iron-condor', 'lib-straddle-cost']));
  let result = null;
  let sortKey = BT.store.get('cmpSort', 'calmar');
  let sortDir = -1;

  const COLS = [
    ['total', 'Net P&L', (s) => inrS(s.total)],
    ['winRate', 'Win %', (s) => pct(s.winRate)],
    ['trades', 'Trades', (s) => s.trades],
    ['avg', 'Avg / trade', (s) => inrS(s.avg)],
    ['maxDD', 'Max DD', (s) => inr(s.maxDD)],
    ['calmar', 'Return / DD', (s) => num(s.calmar)],
    ['profitFactor', 'Profit factor', (s) => num(s.profitFactor)],
    ['sharpe', 'Sharpe', (s) => num(s.sharpe)],
    ['roi', 'ROI %', (s) => pct(s.roi)],
    ['capital', 'Est. margin', (s) => kinr(s.capital)],
    ['maxLoss', 'Worst trade', (s) => inrS(s.maxLoss)],
    ['streakLoss', 'Loss streak', (s) => s.streakLoss],
  ];
  const SIGNED = new Set(['total', 'avg', 'roi', 'maxLoss']);
  // Higher is better except where noted (drawdown and worst trade are negative numbers, so higher is still better).
  const lowerBetter = new Set(['streakLoss', 'capital']);

  function init() {
    if (settings) return;
    settings = BT.createSettings($('cmpSettings'), { onRun: run, runLabel: 'Compare' });
    BT.on('meta', renderList);
    if (BT.meta.loaded) renderList();
    renderEmpty();
  }

  function renderList() {
    const q = $('cmpSearch').value.trim().toLowerCase();
    const groups = {};
    if (BT.meta.saved.length) groups['My strategies'] = BT.meta.saved;
    for (const s of BT.meta.library) (groups[s.category] ||= []).push(s);
    $('cmpList').innerHTML = Object.entries(groups).map(([g, list]) => {
      const shown = list.filter((s) => !q || s.name.toLowerCase().includes(q) || g.toLowerCase().includes(q));
      if (!shown.length) return '';
      return `<div class="cmp-group"><div class="cmp-g-head"><span>${esc(g)}</span><button class="link" data-group="${esc(g)}">toggle</button></div>
        ${shown.map((s) => `<label class="cmp-item" title="${esc(s.desc || '')}"><input type="checkbox" value="${s.id}" ${selected.has(s.id) ? 'checked' : ''}>
          <span><b>${esc(s.name)}</b><span class="muted small">${esc(BT.timingLabel(s))}</span></span></label>`).join('')}</div>`;
    }).join('');
    updateCount();
  }
  function updateCount() {
    const btn = $('cmpSettings').querySelector('[data-act="run"]');
    if (btn && !btn.disabled) btn.textContent = `▶ Compare ${selected.size} strateg${selected.size === 1 ? 'y' : 'ies'}`;
  }
  const persist = () => { BT.store.set('cmpSel', [...selected]); updateCount(); };

  $('cmpList').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    persist();
  });
  $('cmpList').addEventListener('click', (e) => {
    const g = e.target.dataset.group;
    if (!g) return;
    const ids = g === 'My strategies' ? BT.meta.saved.map((s) => s.id) : BT.meta.library.filter((s) => s.category === g).map((s) => s.id);
    const all = ids.every((id) => selected.has(id));
    ids.forEach((id) => (all ? selected.delete(id) : selected.add(id)));
    persist();
    renderList();
  });
  $('cmpSearch').addEventListener('input', renderList);
  $('cmpAll').addEventListener('click', () => { BT.allStrategies().forEach((s) => selected.add(s.id)); persist(); renderList(); });
  $('cmpNone').addEventListener('click', () => { selected.clear(); persist(); renderList(); });

  function renderEmpty() {
    $('cmpResults').innerHTML = `<div class="panel empty"><h3>Which strategy suits this market best?</h3>
      <p>Tick the strategies on the left, pick the period (and, if you like, only certain weeks), then press <b>Compare</b>. Each one is backtested on exactly the same days and expiries with the same costs, then ranked.</p>
      <p class="muted">Return / DD (yearly return ÷ max drawdown) is the default ranking: it rewards profit earned without deep losing streaks. Click any column to rank by it instead.</p></div>`;
  }

  async function run() {
    let opts;
    try { opts = settings.get(); } catch (e) { $('cmpResults').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; return; }
    const ids = [...selected].filter((id) => BT.findStrategy(id));
    if (!ids.length) { $('cmpResults').innerHTML = '<div class="panel empty err">Tick at least one strategy on the left.</div>'; return; }
    settings.setBusy(true);
    const t0 = performance.now();
    try {
      // Library entries are sent by id; saved ones too (the server reads them from its store).
      const job = await BT.runJob('/api/bt/compare', { strategies: ids, opts }, settings.progress);
      result = job.result;
      result.ms = performance.now() - t0;
      render();
    } catch (e) {
      $('cmpResults').innerHTML = `<div class="panel empty err"><b>Compare failed:</b> ${esc(e.message)}</div>`;
    } finally {
      settings.setBusy(false);
      updateCount();
    }
  }

  function render() {
    const ok = result.runs.filter((r) => !r.error && r.stats.trades);
    const bad = result.runs.filter((r) => r.error || !r.stats?.trades);
    const low = lowerBetter.has(sortKey);
    const val = (r) => (r.stats[sortKey] == null || !isFinite(r.stats[sortKey]) ? (low ? 1e18 : -1e18) : r.stats[sortKey]);
    // sortDir -1 = best first
    ok.sort((a, b) => { const d = low ? val(a) - val(b) : val(b) - val(a); return sortDir < 0 ? d : -d; });
    const best = {};
    for (const [k] of COLS) {
      if (k === 'trades') continue;
      const vals = ok.map((r) => r.stats[k]).filter((v) => v != null && isFinite(v));
      if (vals.length > 1 && Math.min(...vals) !== Math.max(...vals)) best[k] = lowerBetter.has(k) ? Math.min(...vals) : Math.max(...vals);
    }
    const top = (k) => ok.slice().filter((r) => r.stats[k] != null).sort((a, b) => b.stats[k] - a.stats[k])[0];
    const bR = top('calmar');
    const bP = top('total');
    const bW = top('winRate');
    const bD = top('maxDD');
    const years = [...new Set(ok.flatMap((r) => Object.keys(r.stats.yearly)))].sort();

    $('cmpResults').innerHTML = `
      <div class="panel res-head">
        <div class="res-title"><h3>${ok.length} strategies · ${dayShort(result.opts.from)} ${result.opts.from.slice(0, 4)} → ${dayShort(result.opts.to)} ${result.opts.to.slice(0, 4)}</h3>
          <span class="muted small">same days, same costs · ${result.opts.expiries ? result.opts.expiries.length + ' selected expiries · ' : ''}computed in ${(result.ms / 1000).toFixed(2)} s</span></div>
        ${ok.length ? `<div class="verdict">
          ${bR ? `<div><span class="muted">Best risk-adjusted</span><b>${esc(bR.strategy.name)}</b><span class="muted small">Return / DD ${num(bR.stats.calmar)}</span></div>` : ''}
          ${bP ? `<div><span class="muted">Most profit</span><b>${esc(bP.strategy.name)}</b><span class="${cls(bP.stats.total)} small">${inrS(bP.stats.total)}</span></div>` : ''}
          ${bW ? `<div><span class="muted">Highest win rate</span><b>${esc(bW.strategy.name)}</b><span class="muted small">${pct(bW.stats.winRate)}</span></div>` : ''}
          ${bD ? `<div><span class="muted">Smallest drawdown</span><b>${esc(bD.strategy.name)}</b><span class="muted small">${inr(bD.stats.maxDD)}</span></div>` : ''}
        </div>` : ''}
      </div>
      <div class="panel">
        <div class="tbl-wrap"><table class="grid-tbl cmp-tbl">
          <thead><tr><th>#</th><th class="l">Strategy</th>${COLS.map(([k, l]) => `<th data-k="${k}" class="sortable${k === sortKey ? ' sorted' : ''}">${l}${k === sortKey ? (sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
          <tbody>${ok.map((r, i) => `<tr>
            <td class="muted">${i + 1}</td>
            <td class="l"><span class="swatch" style="background:${BT.COLORS[result.runs.indexOf(r) % BT.COLORS.length]}"></span><a href="#" data-open="${result.runs.indexOf(r)}">${esc(r.strategy.name)}</a></td>
            ${COLS.map(([k, , f]) => `<td class="${SIGNED.has(k) ? cls(r.stats[k]) : k === 'maxDD' ? 'neg' : ''}${best[k] != null && r.stats[k] === best[k] ? ' best' : ''}">${f(r.stats)}</td>`).join('')}
          </tr>`).join('')}</tbody></table></div>
        ${bad.length ? `<div class="muted small pad">Not ranked: ${bad.map((r) => `${esc(r.strategy.name)} (${esc(r.error || 'no trades')})`).join(' · ')}</div>` : ''}
        <div class="muted small pad">Highlighted = best in column. Click a strategy to open it in Backtest with its full trade list.</div>
      </div>
      <div class="panel res-chart">
        <div class="chart-head"><h3>Equity curves</h3><span class="muted small">cumulative net P&amp;L</span></div>
        <div class="chart-box eq tall"><canvas id="cmpEq"></canvas></div>
      </div>
      <div class="panel">
        <div class="chart-head"><h3>P&amp;L by year</h3></div>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Strategy</th>${years.map((y) => `<th>${y}</th>`).join('')}<th>Profitable months</th></tr></thead>
          <tbody>${ok.map((r) => { const m = Object.values(r.stats.monthly); return `<tr><td class="l">${esc(r.strategy.name)}</td>${years.map((y) => `<td class="${cls(r.stats.yearly[y])}">${r.stats.yearly[y] != null ? inrS(r.stats.yearly[y]) : '—'}</td>`).join('')}<td>${m.filter((v) => v > 0).length} / ${m.length}</td></tr>`; }).join('')}</tbody></table></div>
      </div>`;

    $('cmpResults').querySelector('thead').addEventListener('click', (e) => {
      const k = e.target.closest('th')?.dataset.k;
      if (!k) return;
      if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
      BT.store.set('cmpSort', sortKey);
      render();
    });
    $('cmpResults').querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const r = result.runs[Number(a.dataset.open)];
      const s = BT.findStrategy(r.strategy.id) || r.strategy;
      BT.emit('open-backtest', { strategy: s, run: true });
    }));
    drawEquity(ok);
  }

  function drawEquity(runs) {
    const dates = [...new Set(runs.flatMap((r) => r.stats.equity.map((e) => e.d)))].sort();
    const datasets = runs.map((r) => {
      const byDay = new Map();
      for (const e of r.stats.equity) byDay.set(e.d, e.eq);
      let last = 0;
      const color = BT.COLORS[result.runs.indexOf(r) % BT.COLORS.length];
      return { label: r.strategy.name, data: dates.map((d) => (byDay.has(d) ? (last = byDay.get(d)) : last)), borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 1.6, tension: 0.1 };
    });
    BT.chart($('cmpEq'), {
      type: 'line',
      data: { labels: dates.map(dayShort), datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom' }, tooltip: { itemSort: (a, b) => b.raw - a.raw, callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.raw)}` } } },
        scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { ticks: { callback: (v) => kinr(v) } } },
      },
    });
  }

  window.addEventListener('viewchange', (e) => { if (e.detail === 'cmp') { init(); settings.reload(); updateCount(); } });
  if (window.app.state.view === 'cmp') init();
})();
