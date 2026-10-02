// Backtest screen: strategy editor on the left, period/costs bar and results on the right.
(() => {
  const { $, esc, inr, inrS, kinr, pct, num, cls, dayLabel, dayShort, WD, MONTHS, REASON } = BT;
  let editor = null;
  let settings = null;
  let currentId = null; // id of the library/saved strategy the editor was loaded from
  let dirty = false;
  let result = null;
  let jobId = null;
  let tab = 'monthly';
  let tradeFilter = 'all';
  let tradeSort = 'date';

  function init() {
    if (editor) return;
    editor = BT.createEditor($('btEditor'), () => {
      dirty = true;
      BT.store.set('draft', { id: currentId, s: editor.get() });
      $('btSaveMsg').textContent = 'unsaved changes';
    });
    settings = BT.createSettings($('btSettings'), { onRun: run, runLabel: 'Run backtest' });
    const draft = BT.store.get('draft', null);
    if (draft?.s) { currentId = draft.id; editor.set(draft.s); } else editor.set(BT.blankStrategy());
    BT.on('meta', fillPicker);
    if (BT.meta.loaded) {
      fillPicker();
      if (!draft) load(BT.meta.library[0]);
    } else if (!draft) {
      let first = true;
      BT.on('meta', () => { if (first && !dirty && !currentId) load(BT.meta.library[0]); first = false; });
    }
    BT.on('meta-error', (e) => { $('btResults').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; });
    renderEmpty();
  }

  function fillPicker() {
    const sel = $('btPick');
    const groups = {};
    for (const s of BT.meta.library) (groups[s.category] ||= []).push(s);
    sel.innerHTML = `<option value="">— Load a strategy —</option>
      ${BT.meta.saved.length ? `<optgroup label="My strategies">${BT.meta.saved.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` : ''}
      ${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.name)}${s.edited ? ' ✎ (edited)' : ''}</option>`).join('')}</optgroup>`).join('')}`;
    sel.value = currentId && BT.findStrategy(currentId) ? currentId : '';
    updateButtons();
  }
  function updateButtons() {
    const mine = currentId?.startsWith('my-');
    const builtIn = currentId?.startsWith('lib-') ? BT.findStrategy(currentId) : null;
    $('btDelete').disabled = !mine;
    $('btDelete').classList.toggle('hidden', Boolean(builtIn));
    $('btReset').classList.toggle('hidden', !builtIn?.edited);
    $('btSave').title = mine ? 'Save changes to this strategy' : builtIn ? 'Save your changes into this built-in strategy (or as a copy)' : 'Save as one of your strategies';
  }

  function load(s, keepResults) {
    if (!s) return;
    currentId = s.id || null;
    editor.set(BT.clone(s));
    dirty = false;
    BT.store.set('draft', { id: currentId, s: editor.get() });
    $('btPick').value = currentId && BT.findStrategy(currentId) ? currentId : '';
    $('btSaveMsg').textContent = '';
    updateButtons();
    if (!keepResults) renderEmpty();
  }

  $('btPick').addEventListener('change', (e) => {
    const s = BT.findStrategy(e.target.value);
    if (!s) return;
    if (dirty && !confirm('Discard unsaved changes to the current strategy?')) { e.target.value = currentId || ''; return; }
    load(s);
  });
  $('btNew').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    load({ ...BT.blankStrategy(), id: null });
  });
  // Own strategies save in place. A built-in one can be updated in place (kept as an edited copy that
  // replaces it everywhere until "Reset to original") or saved as a new strategy.
  async function save(asNew) {
    const s = editor.get();
    const mine = currentId?.startsWith('my-');
    const builtIn = currentId?.startsWith('lib-');
    let override = false;
    if (!asNew && builtIn) {
      override = confirm(`Save your changes into the built-in strategy "${s.name}"?\n\nOK — update the built-in (it can be reset to the original later)\nCancel — save as a new strategy instead`);
    }
    if (override) s.id = currentId;
    else if (asNew || !mine) {
      const name = prompt('Save strategy as', mine || !currentId ? s.name : s.name + ' (custom)');
      if (!name) return;
      s.name = name;
      s.id = null;
    } else s.id = currentId;
    try {
      const saved = await BT.saveStrategy(s, override);
      load(override ? BT.findStrategy(saved.id) || saved : saved, true);
      $('btSaveMsg').textContent = override ? 'built-in updated ✓' : 'saved ✓ — reusable on any expiry';
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
  }
  $('btReset').addEventListener('click', async () => {
    if (!currentId?.startsWith('lib-') || !confirm('Discard your edits and restore the original built-in strategy?')) return;
    try {
      const orig = await BT.resetStrategy(currentId);
      load(orig, true);
      $('btSaveMsg').textContent = 'restored the original';
    } catch (e) {
      alert('Could not reset: ' + e.message);
    }
  });
  $('btSave').addEventListener('click', () => save(false));
  $('btSaveAs').addEventListener('click', () => save(true));
  $('btDelete').addEventListener('click', async () => {
    if (!currentId?.startsWith('my-') || !confirm('Delete this saved strategy?')) return;
    await BT.deleteStrategy(currentId);
    load({ ...editor.get(), id: null }, true);
    $('btSaveMsg').textContent = 'deleted (still in the editor)';
  });
  $('btDeploy').addEventListener('click', () => {
    BT.emit('deploy', editor.get());
    window.app.setView('lib');
  });
  BT.on('open-backtest', ({ strategy, run: autoRun }) => {
    init();
    load(strategy);
    window.app.setView('bt');
    if (autoRun) run();
  });

  // ---------- run ----------
  async function run() {
    let opts;
    try { opts = settings.get(); } catch (e) { return renderError(e.message); }
    const strategy = editor.get();
    if (!strategy.legs.length) return renderError('Add at least one leg.');
    settings.setBusy(true);
    const t0 = performance.now();
    try {
      const job = await BT.runJob('/api/bt/run', { strategy, opts }, settings.progress);
      result = job.result;
      jobId = job.id;
      result.ms = performance.now() - t0;
      renderResults();
    } catch (e) {
      renderError(e.message);
    } finally {
      settings.setBusy(false);
    }
  }

  function renderEmpty() {
    if (!$('btResults')) return;
    result = null;
    $('btResults').innerHTML = `<div class="panel empty">
      <h3>Backtest on real 1-minute Nifty option prices</h3>
      <p>Pick a ready-made strategy on the left (or build your own), choose a period and the expiries to include, then press <b>Run backtest</b>.</p>
      <ul>
        <li>Data: Upstox expired-option candles, every strike, every minute. The first run of a period downloads what it needs (about 100 ms per contract); later runs come from the local cache and take milliseconds.</li>
        <li>Entries and timed exits fill at that minute's open. Stops and targets are checked against each candle's high and low; when both are touched in one candle, the stop is taken.</li>
        <li>Slippage, brokerage and STT / exchange / GST charges are deducted from every trade.</li>
      </ul></div>`;
  }
  function renderError(msg) {
    $('btResults').innerHTML = `<div class="panel empty err"><b>Backtest failed:</b> ${esc(msg)}</div>`;
  }

  const tile = (label, value, sub = '', c = '') => `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c}">${value}</span><span class="k-s">${sub}</span></div>`;

  function renderResults() {
    const r = result;
    const st = r.stats;
    const s = r.strategy;
    if (!st.trades) {
      $('btResults').innerHTML = `<div class="panel empty"><h3>No trades</h3><p>${r.considered} trading days/expiries matched the timing rules, ${r.skippedCount} were skipped${r.noSignal ? `, and on ${r.noSignal} the entry conditions never all held` : ''}.</p>${skippedHtml()}</div>`;
      return;
    }
    $('btResults').innerHTML = `
      <div class="panel res-head">
        <div class="res-title">
          <h3>${esc(s.name)}</h3>
          <span class="muted small">${esc(BT.timingLabel(s))} · ${dayLabel(st.from)} → ${dayLabel(st.to)} · ${r.opts.expiries ? r.opts.expiries.length + ' selected expiries · ' : ''}${r.opts.lotMode === 'fixed' ? 'lot ' + r.opts.lotSize : 'lot as traded'}${s.entry.when === 'signal' ? ` · signal on ${r.considered - (r.noSignal || 0)} of ${r.considered} sessions` : ''} · computed in ${(r.ms / 1000).toFixed(2)} s</span>
          <div class="res-legs">${BT.legChips(s)}</div>
        </div>
        <div class="kpis">
          ${tile('Net P&amp;L', inrS(st.total), `gross ${inrS(st.gross)} · costs ${inr(st.costs)}`, cls(st.total))}
          ${tile('Win rate', pct(st.winRate), `${st.wins} W · ${st.losses} L of ${st.trades}`)}
          ${tile('Avg / trade', inrS(st.avg), `win ${inrS(st.avgWin)} · loss ${inrS(st.avgLoss)}`, cls(st.avg))}
          ${tile('Max drawdown', inr(st.maxDD), st.ddFrom ? `${dayShort(st.ddFrom)} → ${dayShort(st.ddTo)}` : '', 'neg')}
          ${tile('Return / DD', num(st.calmar), `annual ${inrS(st.annual)}`)}
          ${tile('Profit factor', num(st.profitFactor), `reward:risk ${num(st.rr)}`)}
          ${tile('ROI', pct(st.roi), `on ${kinr(st.capital)} ${r.opts.capital ? '' : '(est. margin)'} · ${pct(st.annualRoi)}/yr`, cls(st.roi))}
          ${tile('Sharpe', num(st.sharpe), `Sortino ${num(st.sortino)}`)}
          ${tile('Best / worst', `<span class="pos">${inrS(st.maxWin)}</span>`, `<span class="neg">${inrS(st.maxLoss)}</span>`)}
          ${tile('Streaks', `${st.streakWin} W / ${st.streakLoss} L`, `longest DD ${st.longestDDTrades} trades`)}
        </div>
      </div>
      <div class="panel res-chart">
        <div class="chart-head"><h3>Equity curve</h3><span class="muted small">cumulative net P&amp;L after costs · bars = each trade</span></div>
        <div class="chart-box eq"><canvas id="btEq"></canvas></div>
        <div class="chart-box dd"><canvas id="btDD"></canvas></div>
      </div>
      <div class="panel res-tabs-panel">
        <div class="res-tabbar">
          <div class="seg" id="btTabs">
            <button data-t="monthly">Monthly</button><button data-t="breakdown">Breakdown</button>
            <button data-t="trades">Trades (${st.trades})</button><button data-t="skipped">Skipped (${r.skippedCount})</button>
          </div>
          <span class="spacer"></span>
          <button class="btn-sm ghost" id="btCsv">Export CSV</button>
        </div>
        <div id="btTab" class="res-tab"></div>
      </div>`;
    drawEquity();
    $('btTabs').addEventListener('click', (e) => { if (e.target.dataset.t) { tab = e.target.dataset.t; renderTab(); } });
    $('btCsv').addEventListener('click', exportCsv);
    renderTab();
  }

  function drawEquity() {
    const st = result.stats;
    const labels = st.equity.map((e) => dayShort(e.d));
    const pnl = st.equity.map((e) => result.trades[e.i].net);
    BT.chart($('btEq'), {
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Equity', data: st.equity.map((e) => e.eq), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.10)', fill: 'origin', pointRadius: 0, borderWidth: 1.8, tension: 0.1, yAxisID: 'y' },
          { type: 'bar', label: 'Trade P&L', data: pnl, backgroundColor: pnl.map((v) => (v >= 0 ? 'rgba(63,182,139,.28)' : 'rgba(240,113,107,.28)')), yAxisID: 'y2', barPercentage: 1, categoryPercentage: 0.9, order: 2 },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.raw)}` } } },
        scales: {
          x: { ticks: { maxTicksLimit: 12, autoSkip: true }, grid: { display: false } },
          y: { position: 'left', ticks: { callback: (v) => kinr(v) } },
          y2: { position: 'right', grid: { display: false }, ticks: { callback: (v) => kinr(v) } },
        },
        onClick: (_, els) => { if (els[0]) openTrade(st.equity[els[0].index].i); },
      },
    });
    BT.chart($('btDD'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Drawdown', data: st.equity.map((e) => e.dd), borderColor: '#f0716b', backgroundColor: 'rgba(240,113,107,.18)', fill: 'origin', pointRadius: 0, borderWidth: 1.2 }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (c) => `Drawdown ${inr(c.raw)}` } } },
        scales: { x: { display: false }, y: { ticks: { callback: (v) => kinr(v), maxTicksLimit: 3 } } },
      },
    });
  }

  function renderTab() {
    $('btTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    const el = $('btTab');
    if (tab === 'monthly') el.innerHTML = monthlyHtml(result.stats);
    else if (tab === 'breakdown') { el.innerHTML = breakdownHtml(); drawHist(); }
    else if (tab === 'trades') renderTrades();
    else el.innerHTML = skippedHtml();
  }

  function monthlyHtml(st) {
    const years = Object.keys(st.yearly).sort();
    const vals = Object.values(st.monthly);
    const max = Math.max(1, ...vals.map(Math.abs));
    const cell = (v) => {
      if (v == null) return '<td class="muted">·</td>';
      const a = 0.12 + 0.5 * Math.min(1, Math.abs(v) / max);
      return `<td style="background:rgba(${v >= 0 ? '63,182,139' : '240,113,107'},${a.toFixed(2)})">${kinr(v)}</td>`;
    };
    const posMonths = vals.filter((v) => v > 0).length;
    return `<div class="tbl-wrap"><table class="grid-tbl month-tbl">
      <thead><tr><th>Year</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${years.map((y) => `<tr><th>${y}</th>${MONTHS.map((_, i) => cell(st.monthly[`${y}-${String(i + 1).padStart(2, '0')}`])).join('')}<td class="${cls(st.yearly[y])} b">${inrS(st.yearly[y])}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="muted small pad">Profitable months: <b>${posMonths}</b> of ${vals.length}. Best month ${inrS(Math.max(...vals))}, worst ${inrS(Math.min(...vals))}.</div>`;
  }

  function bucketTable(title, obj, label) {
    const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
    const max = Math.max(1, ...keys.map((k) => Math.abs(obj[k].pnl)));
    return `<div class="bd-card"><h4>${title}</h4><table class="grid-tbl bd-tbl"><thead><tr><th></th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>Avg</th><th class="barcol"></th></tr></thead><tbody>
      ${keys.map((k) => { const b = obj[k]; const w = (Math.abs(b.pnl) / max) * 100; return `<tr><th>${label(k)}</th><td>${b.n}</td><td>${pct((b.wins / b.n) * 100, 0)}</td><td class="${cls(b.pnl)}">${inrS(b.pnl)}</td><td class="${cls(b.pnl)}">${inrS(Math.round(b.pnl / b.n))}</td><td class="barcol"><div class="hbar ${b.pnl >= 0 ? 'p' : 'n'}" style="width:${w.toFixed(0)}%"></div></td></tr>`; }).join('')}
    </tbody></table></div>`;
  }

  function breakdownHtml() {
    const st = result.stats;
    const reasons = Object.entries(st.reasons).sort((a, b) => b[1] - a[1]);
    const total = reasons.reduce((s, [, n]) => s + n, 0);
    return `<div class="bd-grid">
      ${bucketTable('By weekday (entry)', st.weekday, (k) => WD[k])}
      ${bucketTable('By days to expiry (entry)', st.dte, (k) => (k === 0 ? 'Expiry' : k + 'd'))}
      <div class="bd-card"><h4>How legs exited</h4><table class="grid-tbl bd-tbl"><tbody>
        ${reasons.map(([k, n]) => `<tr><th>${REASON[k] || k}</th><td>${n}</td><td>${pct((n / total) * 100, 0)}</td><td class="barcol"><div class="hbar" style="width:${((n / total) * 100).toFixed(0)}%"></div></td></tr>`).join('')}
      </tbody></table></div>
      <div class="bd-card wide"><h4>Distribution of trade P&amp;L</h4><div class="chart-box hist"><canvas id="btHist"></canvas></div></div>
    </div>`;
  }

  function drawHist() {
    const net = result.trades.map((t) => t.net);
    const lo = Math.min(...net);
    const hi = Math.max(...net);
    const n = Math.min(30, Math.max(8, Math.round(Math.sqrt(net.length) * 2)));
    const w = (hi - lo) / n || 1;
    const bins = Array.from({ length: n }, (_, i) => ({ a: lo + i * w, c: 0 }));
    for (const v of net) bins[Math.min(n - 1, Math.floor((v - lo) / w))].c++;
    BT.chart($('btHist'), {
      type: 'bar',
      data: { labels: bins.map((b) => kinr(b.a + w / 2)), datasets: [{ data: bins.map((b) => b.c), backgroundColor: bins.map((b) => (b.a + w / 2 >= 0 ? 'rgba(63,182,139,.7)' : 'rgba(240,113,107,.7)')), barPercentage: 1, categoryPercentage: 0.95 }] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `${kinr(bins[c[0].dataIndex].a)} to ${kinr(bins[c[0].dataIndex].a + w)}`, label: (c) => `${c.raw} trades` } } }, scales: { x: { grid: { display: false } } } },
    });
  }

  function skippedHtml() {
    const r = result;
    if (!r.skipped.length) return '<div class="muted pad">Nothing was skipped.</div>';
    return `<div class="muted small pad">Days or expiries that matched the rules but couldn't be traded (usually because a contract had no trades yet, or a "next" expiry hasn't expired).</div>
      <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Date</th><th>Expiry</th><th>Reason</th></tr></thead><tbody>
      ${r.skipped.map((x) => `<tr><td>${dayLabel(x.day)}</td><td>${dayLabel(x.ref)}</td><td class="l">${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderTrades() {
    const el = $('btTab');
    let idx = result.trades.map((_, i) => i);
    if (tradeFilter === 'wins') idx = idx.filter((i) => result.trades[i].net > 0);
    if (tradeFilter === 'losses') idx = idx.filter((i) => result.trades[i].net < 0);
    if (tradeSort === 'best') idx.sort((a, b) => result.trades[b].net - result.trades[a].net);
    if (tradeSort === 'worst') idx.sort((a, b) => result.trades[a].net - result.trades[b].net);
    if (tradeSort === 'recent') idx.reverse();
    const legTxt = (x) => `<span class="lx ${x.action === 'B' ? 'buy' : 'sell'}" title="${esc(`${x.action === 'B' ? 'Buy' : 'Sell'} ${x.qty} × ${x.strike} ${x.type} (${x.expiry}) · ${x.entryDay} ${x.entryTime} @ ${x.entryPx} → ${x.exitDay} ${x.exitTime} @ ${x.exitPx} · ${REASON[x.reason] || x.reason} · ${inrS(x.pnl)}`)}">${x.action}${x.re ? '↻' : ''} ${x.strike}${x.type} ${x.entryPx}→${x.exitPx}${x.reason === 'sl' ? ' <b class="neg">SL</b>' : x.reason === 'tgt' ? ' <b class="pos">TG</b>' : ''}</span>`;
    el.innerHTML = `<div class="trade-tools">
        <div class="seg sm">${[['all', 'All'], ['wins', 'Winners'], ['losses', 'Losers']].map(([v, l]) => `<button data-f="${v}" class="${tradeFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select id="btSort">${[['date', 'Oldest first'], ['recent', 'Newest first'], ['best', 'Best first'], ['worst', 'Worst first']].map(([v, l]) => `<option value="${v}" ${tradeSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="muted small">Click a trade for its minute-by-minute P&amp;L.</span>
      </div>
      <div class="tbl-wrap trades-wrap"><table class="grid-tbl trades-tbl">
        <thead><tr><th>#</th><th>Entry</th><th>Exit</th><th>Expiry</th><th>DTE</th><th>Nifty</th><th class="l">Legs (entry → exit)</th><th>Max profit</th><th>Max loss</th><th>Exit</th><th>Net P&amp;L</th></tr></thead>
        <tbody>${idx.map((i) => {
          const t = result.trades[i];
          return `<tr data-i="${i}"><td class="muted">${i + 1}</td><td>${dayShort(t.entryDay)} <span class="muted">${WD[t.weekday]} ${t.entryTime}</span></td>
            <td>${t.exitDay !== t.entryDay ? dayShort(t.exitDay) + ' ' : ''}<span class="muted">${t.exitTime}</span></td><td>${dayShort(t.ref)}</td><td>${t.dte}</td>
            <td>${Math.round(t.spotIn)} <span class="${cls(t.spotOut - t.spotIn)}">${t.spotOut != null ? (t.spotOut >= t.spotIn ? '+' : '') + Math.round(t.spotOut - t.spotIn) : ''}</span></td>
            <td class="l legs-cell">${t.legs.map(legTxt).join('')}${t.signal ? `<div class="sig-txt" title="${esc(t.signal)}">⚡ ${esc(t.signal)}</div>` : ''}</td>
            <td class="pos">${inr(t.maxProfit)}</td><td class="neg">${inr(t.maxLoss)}</td><td class="muted">${REASON[t.reason] || t.reason}</td>
            <td class="${cls(t.net)} b">${inrS(t.net)}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    el.querySelector('.seg').addEventListener('click', (e) => { if (e.target.dataset.f) { tradeFilter = e.target.dataset.f; renderTrades(); } });
    $('btSort').addEventListener('change', (e) => { tradeSort = e.target.value; renderTrades(); });
    el.querySelector('tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) openTrade(Number(tr.dataset.i)); });
  }

  // ---------- trade detail ----------
  async function openTrade(i) {
    let d;
    try { d = await BT.api(`/api/bt/trade?job=${jobId}&i=${i}`); } catch (e) { alert(e.message); return; }
    const t = d.trade;
    const p = d.path;
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `<div class="modal panel">
      <div class="modal-head"><h3>Trade ${i + 1} · ${dayLabel(t.entryDay)} ${t.entryTime} → ${t.exitDay !== t.entryDay ? dayLabel(t.exitDay) + ' ' : ''}${t.exitTime}</h3>
        <span class="${cls(t.net)} big">${inrS(t.net)}</span><button class="icon close">✕</button></div>
      ${t.signal ? `<div class="sig-txt pad">⚡ Entry signal: ${esc(t.signal)}</div>` : ''}
      <div class="muted small pad">Expiry ${dayLabel(t.ref)} · DTE ${t.dte} · Nifty ${t.spotIn} → ${t.spotOut ?? '—'}${t.vix != null ? ' · VIX ' + t.vix : ''} · gross ${inrS(t.gross)} · costs ${inr(t.costs)} · max profit ${inr(t.maxProfit)} · max loss ${inr(t.maxLoss)} · est. margin ${kinr(t.margin)}</div>
      <div class="chart-box trade-chart"><canvas id="btTradeChart"></canvas></div>
      <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Leg</th><th>Action</th><th>Contract</th><th>Qty</th><th>Entry</th><th>Price</th><th>Exit</th><th>Price</th><th>Reason</th><th>Costs</th><th>P&amp;L</th></tr></thead><tbody>
        ${t.legs.map((x) => `<tr><td>${x.leg + 1}${x.re ? ' ↻' + x.re : ''}</td><td class="${x.action === 'B' ? 'pos' : 'neg'}">${x.action === 'B' ? 'BUY' : 'SELL'}</td><td>${x.strike} ${x.type} <span class="muted">${dayShort(x.expiry)}</span></td><td>${x.qty}</td>
          <td>${x.entryDay !== t.entryDay ? dayShort(x.entryDay) + ' ' : ''}${x.entryTime}</td><td>${x.entryPx}</td><td>${x.exitDay !== x.entryDay ? dayShort(x.exitDay) + ' ' : ''}${x.exitTime}</td><td>${x.exitPx}</td>
          <td>${REASON[x.reason] || x.reason}</td><td class="muted">${inr(x.cost)}</td><td class="${cls(x.pnl)} b">${inrS(x.pnl)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.classList.contains('close')) close(); });
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    // x labels: minutes across the days of the trade
    const labels = [];
    let first = true;
    for (let di = 0; di < p.days.length && labels.length < p.mtm.length; di++) {
      for (let m = first ? p.em : 0; m < 375 && labels.length < p.mtm.length; m++) {
        const t2 = m + 555;
        labels.push(`${p.days.length > 1 ? dayShort(p.days[di]) + ' ' : ''}${String(Math.floor(t2 / 60)).padStart(2, '0')}:${String(t2 % 60).padStart(2, '0')}`);
      }
      first = false;
    }
    BT.chart(document.getElementById('btTradeChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Position P&L', data: p.mtm, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.12)', fill: 'origin', pointRadius: 0, borderWidth: 1.6, yAxisID: 'y' },
          { label: 'Nifty', data: p.spot, borderColor: '#d6af4c', pointRadius: 0, borderWidth: 1, yAxisID: 'y2' },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: (c) => (c.datasetIndex ? `Nifty ${c.raw?.toFixed(2)}` : `P&L ${inrS(c.raw)}`) } } },
        scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { ticks: { callback: (v) => kinr(v) } }, y2: { position: 'right', grid: { display: false } } },
      },
    });
  }

  function exportCsv() {
    const rows = [['trade', 'signal', 'entry_day', 'entry_time', 'exit_day', 'exit_time', 'expiry', 'dte', 'spot_in', 'spot_out', 'leg', 'action', 'strike', 'type', 'leg_expiry', 'qty', 'leg_entry', 'entry_px', 'leg_exit', 'exit_px', 'exit_reason', 'leg_pnl', 'leg_costs', 'trade_net']];
    result.trades.forEach((t, i) => t.legs.forEach((x) => rows.push([i + 1, `"${(t.signal || '').replace(/"/g, "'")}"`, t.entryDay, t.entryTime, t.exitDay, t.exitTime, t.ref, t.dte, t.spotIn, t.spotOut, x.leg + 1, x.action, x.strike, x.type, x.expiry, x.qty, `${x.entryDay} ${x.entryTime}`, x.entryPx, `${x.exitDay} ${x.exitTime}`, x.exitPx, x.reason, x.pnl, x.cost, t.net])));
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backtest_${result.strategy.name.replace(/[^\w]+/g, '_')}_${result.stats.from}_${result.stats.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  window.addEventListener('viewchange', (e) => { if (e.detail === 'bt') { init(); settings.reload(); } });
  if (window.app.state.view === 'bt') init();
  window.BTView = { init };
})();
