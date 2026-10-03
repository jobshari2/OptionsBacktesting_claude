// Backtest screen: strategy editor on the left, period/costs bar and results on the right.
(() => {
  const { $, esc, inr, inrS, kinr, pct, num, cls, dayLabel, dayShort, WD, MONTHS, REASON } = BT;
  let editor = null;
  let settings = null;
  let currentId = null; // id of the library/saved strategy the editor was loaded from
  let dirty = false;
  let scan = null; // scenario scan: { strategy, opts, debit, scenarios, rows (distinct outcomes) }
  let runOpts = null;
  let selKey = null; // scenario shown in the detail panels
  let selSc = null;
  let main = null; // the strategy run from the editor
  let variant = null; // adjustment variation shown in Details instead of it (a row of adj.rows), or null
  let adj = null; // adjustment variations of main: { rows } once tested
  let adjNote = ''; // progress / error text while adj is not there
  let adjSort = { k: 'total', dir: -1 };
  let topTab = 'details';
  let autoRan = false;
  let scSort = { k: 'total', dir: -1 };
  let result = null; // full run of the selected scenario
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
    // First visit: start on the bi-weekly hedge. The loaded strategy is then run once on its own (cached history,
    // saved settings), so the screen opens on results; "Run backtest" re-runs it with other settings.
    const start = () => {
      if (!draft && !dirty && !currentId) load(BT.findStrategy('my-biweekly-hari') || BT.meta.library[0]);
      if (!autoRan && !scan && BT.meta.calendar) { autoRan = true; run(); }
    };
    if (BT.meta.loaded) { fillPicker(); start(); } else BT.on('meta', start);
    BT.on('meta-error', (e) => { $('btResults').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; });
    renderEmpty();
  }

  function fillPicker() {
    const sel = $('btPick');
    const groups = {};
    for (const s of BT.meta.library) (groups[s.category] ||= []).push(s);
    const og = ([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.name)}${s.edited ? ' ✎ (edited)' : ''}</option>`).join('')}</optgroup>`;
    const top = Object.entries(groups).filter(([g]) => g === 'Bi-weekly'); // tested best first: kept above everything else
    sel.innerHTML = `<option value="">— Load a strategy —</option>
      ${top.map(og).join('')}
      ${BT.meta.saved.length ? `<optgroup label="My strategies">${BT.meta.saved.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` : ''}
      ${Object.entries(groups).filter(([g]) => g !== 'Bi-weekly').map(og).join('')}`;
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
  $('btBuilder').addEventListener('click', () => BT.emit('open-builder', { strategy: { ...editor.get(), id: currentId }, src: 'live', note: 'from the Backtest editor' }));
  BT.on('open-backtest', ({ strategy, run: autoRun }) => {
    autoRan = true; // opened for this strategy: no automatic run of the previous one
    init();
    load(strategy);
    window.app.setView('bt');
    if (autoRun) run();
  });

  // ---------- run ----------
  // One press runs the strategy as defined plus every profit-target × stop-loss × exit scenario (bt/scenarios.js).
  // The scan returns headline numbers only; the scenario picked in the table is then run on its own for the details.
  async function run() {
    let opts;
    try { opts = settings.get(); } catch (e) { return renderError(e.message); }
    const strategy = editor.get();
    if (!strategy.legs.length) return renderError('Add at least one leg.');
    main = strategy;
    variant = null;
    adj = null;
    topTab = 'details';
    runOpts = opts;
    if (await scanFor(strategy)) testAdjustments();
  }

  // Scenario scan of one strategy (the editor's, or an adjustment variation of it) into the Details tab.
  async function scanFor(strategy) {
    settings.setBusy(true);
    const t0 = performance.now();
    try {
      const job = await BT.runJob('/api/bt/scenarios', { strategy, opts: runOpts }, settings.progress);
      scan = job.result;
      scan.ms = performance.now() - t0;
      scan.rows = distinct(scan.scenarios);
      renderResults();
      return true;
    } catch (e) {
      renderError(e.message);
      return false;
    } finally {
      settings.setBusy(false);
    }
  }

  // ---------- adjustments ----------
  // Every adjustment variation of the strategy (bt/adjustments.js), tested in the background after its own run.
  async function testAdjustments() {
    const mine = main;
    adjNote = 'Testing the adjustment variations…';
    try {
      const job = await BT.runJob('/api/bt/adjustments', { strategy: main, opts: runOpts }, (p) => {
        if (main !== mine) return;
        adjNote = `${p.phase || 'Testing adjustments'}${p.total ? ` — ${p.done} of ${p.total}` : ''}`;
        if (topTab === 'adjust') renderAdjust();
      });
      if (main !== mine) return;
      adj = job.result;
    } catch (e) {
      if (main !== mine) return;
      adjNote = 'Could not test the adjustments: ' + e.message;
    }
    renderTop();
    renderAdjust();
  }

  const ADJ_COLS = [
    ['total', 'Net P&amp;L', (v) => inrS(v)], ['roi', '% profit', (v) => pct(v)], ['capital', 'Investment', (v) => inr(v)], ['winRate', 'Win %', (v) => pct(v)], ['trades', 'Trades', (v) => v],
    ['maxDD', 'Max DD', (v) => inr(v)], ['calmar', 'Return / DD', (v) => num(v)], ['maxLoss', 'Worst trade', (v) => inrS(v)], ['profitFactor', 'Profit factor', (v) => num(v)],
  ];
  function renderTop() {
    const el = $('btTop');
    if (!el) return;
    el.innerHTML = `<button data-top="details" class="${topTab === 'details' ? 'on' : ''}">Details</button><button data-top="adjust" class="${topTab === 'adjust' ? 'on' : ''}" title="The strategy with one adjustment changed at a time, each backtested with the same settings">Adjustments (${adj ? adj.rows.length : '…'})</button>`;
    $('btPaneDetails').classList.toggle('hidden', topTab !== 'details');
    $('btPaneAdjust').classList.toggle('hidden', topTab !== 'adjust');
  }
  function renderAdjust() {
    const el = $('btPaneAdjust');
    if (!el) return;
    if (!adj) { el.innerHTML = `<div class="pad muted">${esc(adjNote)}</div>`; return; }
    const { k, dir } = adjSort;
    const val = (r) => (r.stats?.[k] == null || !isFinite(r.stats[k]) ? null : r.stats[k]);
    const rows = adj.rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return (x == null) - (y == null);
      return (x - y) * dir;
    });
    const cur = variant?.key || 'own';
    el.innerHTML = `<div class="chart-head"><h3>Adjustments — ${esc(main.name)}</h3><span class="muted small">${adj.rows.length} variations, each with one adjustment changed and backtested on the same period and settings · most profitable first · click a row to open it in Details · click a column to sort</span></div>
      <div class="tbl-wrap"><table class="grid-tbl cmp-tbl scen-tbl adj-tbl">
      <thead><tr><th>#</th><th class="l">Adjustment</th>${ADJ_COLS.map(([c, l]) => `<th data-k="${c}" class="sortable${c === k ? ' sorted' : ''}">${l}${c === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-k="${r.key}" class="${r.key === cur ? 'sel' : ''}"><td class="muted">${i + 1}</td>
        <td class="l adj-name"><span class="cat-pill${r.key === 'own' ? ' c-mine' : ''}">${esc(r.group)}</span> <b>${esc(r.name)}</b>${r.risky ? ' <span class="cat-pill c-bearish" title="Part of the position is left without a hedge: one bad week can lose far more than this backtest shows">unhedged · unlimited risk</span>' : ''}<div class="muted small">${esc(r.error ? 'Could not be tested: ' + r.error : r.note)}</div></td>
        ${ADJ_COLS.map(([c, , f]) => `<td class="${c === 'total' ? cls(r.stats?.total) + ' b' : c === 'roi' ? cls(r.stats?.roi) : c === 'maxDD' || c === 'maxLoss' ? 'neg' : ''}">${r.stats?.trades ? f(r.stats[c]) : c === 'trades' && r.stats ? 0 : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="muted small pad">Investment = the Capital in the settings bar, else the largest estimated margin of the trades. % profit = net P&amp;L ÷ investment over the tested period. The ranking is made on the same trades it is measured on: confirm a variation on another period.</div>`;
  }
  async function pickVariant(key) {
    const row = adj?.rows.find((x) => x.key === key);
    if (!row || row.error) return;
    variant = key === 'own' ? null : row;
    topTab = 'details';
    await scanFor(row.strategy);
  }

  // A rule that never came into play leaves the result unchanged: show each outcome once, as its simplest
  // scenario (the strategy as defined comes first in the list), and count the others on that row.
  function distinct(list) {
    const groups = new Map();
    for (const sc of list) {
      const st = sc.stats;
      const sig = [st.trades, st.total, st.gross, st.wins, st.maxDD].join('|');
      if (groups.has(sig)) groups.get(sig).same.push(sc); else groups.set(sig, { ...sc, same: [] });
    }
    return [...groups.values()];
  }

  function renderEmpty() {
    if (!$('btResults')) return;
    result = null;
    scan = null;
    selKey = null;
    main = null;
    variant = null;
    adj = null;
    $('btResults').innerHTML = `<div class="panel empty">
      <h3>Backtest on real 1-minute Nifty option prices</h3>
      <p>Pick a ready-made strategy on the left (or build your own), choose a period and the expiries to include, then press <b>Run backtest</b>.</p>
      <ul>
        <li>Data: Upstox expired-option candles, every strike, every minute. The first run of a period downloads what it needs (about 100 ms per contract); later runs come from the local cache and take milliseconds.</li>
        <li>Entries and timed exits fill at that minute's open. Stops and targets are checked against each candle's high and low; when both are touched in one candle, the stop is taken.</li>
        <li>Slippage, brokerage and STT / exchange / GST charges are deducted from every trade.</li>
        <li>Every run also tests the scenarios around your strategy: booking profit at 10 %, 20 %, 30 % … of the entry premium, an overall stop-loss, and exiting on expiry day or earlier. They are ranked with the most profitable on top; click one to see its months, trades and equity curve.</li>
      </ul></div>`;
  }
  function renderError(msg) {
    $('btResults').innerHTML = `<div class="panel empty err"><b>Backtest failed:</b> ${esc(msg)}</div>`;
  }

  // Share of the investment (capital in the settings, else the estimated margin) of the run shown in Details.
  const ofCap = (v) => (result?.stats?.capital ? pct((v / result.stats.capital) * 100) : '—');
  const tile = (label, value, sub = '', c = '') => `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c}">${value}</span><span class="k-s">${sub}</span></div>`;

  // ---------- scenarios ----------
  const SC_COLS = [
    ['total', 'Net P&amp;L', (v) => inrS(v)], ['roi', '% profit', (v) => pct(v)], ['winRate', 'Win %', (v) => pct(v)], ['trades', 'Trades', (v) => v], ['avg', 'Avg / trade', (v) => inrS(v)],
    ['maxDD', 'Max DD', (v) => inr(v)], ['calmar', 'Return / DD', (v) => num(v)], ['profitFactor', 'Profit factor', (v) => num(v)], ['sharpe', 'Sharpe', (v) => num(v)],
  ];
  function scLabels(sc) {
    const s = scan.strategy;
    const r = s.risk;
    const prem = scan.debit ? 'debit' : 'credit';
    const own = (v, p) => [v != null ? (r.unit === 'pct' ? `${v}% of capital` : inr(v)) : null, p != null ? `${p}% of ${prem}` : null].filter(Boolean).join(' or ') || 'None';
    const of = (v) => (v == null ? 'None' : `${v}% of ${prem}`);
    return {
      tgt: sc.own ? own(r.tgt, r.tgtPrem) : of(sc.tgt),
      sl: sc.own ? own(r.sl, r.slPrem) : of(sc.sl),
      exit: s.mode === 'intraday' ? sc.exit.time : `${sc.exit.dteDays ? `${sc.exit.dteDays}d before expiry` : 'Expiry day'} ${sc.exit.time}`,
    };
  }
  const scText = (sc) => { const l = scLabels(sc); return `take profit ${l.tgt} · stop-loss ${l.sl} · exit ${l.exit}`; };
  function sortedRows() {
    const { k, dir } = scSort;
    const val = (r) => (r.stats[k] == null || !isFinite(r.stats[k]) ? null : r.stats[k]);
    return scan.rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return (x == null) - (y == null); // no value: always last
      return (x - y) * dir || b.stats.total - a.stats.total;
    });
  }

  function renderResults() {
    const s = scan.strategy;
    const own = scan.scenarios[0];
    const st = own.stats;
    const none = !st.trades;
    if (none) result = { skipped: scan.skipped };
    const noTrades = `<div class="panel empty"><h3>No trades</h3><p>${scan.considered} trading days/expiries matched the timing rules, ${own.skippedCount} were skipped${scan.noSignal ? `, and on ${scan.noSignal} the entry conditions never all held` : ''}.</p>${none ? skippedHtml() : ''}</div>`;
    $('btResults').innerHTML = `
      <div class="panel res-head">
        <div class="res-title">
          <h3>${esc(main.name)}${variant ? ` <span class="muted">›</span> ${esc(variant.name)} <button class="btn-sm ghost" id="btMain" title="Back to the strategy as it is in the editor">◂ As defined</button>` : ''}</h3>
          <span class="muted small">${esc(BT.timingLabel(s))}${none ? '' : ` · ${dayLabel(st.from)} → ${dayLabel(st.to)}`} · ${scan.opts.expiries ? scan.opts.expiries.length + ' selected expiries · ' : ''}${scan.opts.lotMode === 'fixed' ? 'lot ' + scan.opts.lotSize : 'lot as traded'}${s.entry.when === 'signal' ? ` · signal on ${scan.considered - (scan.noSignal || 0)} of ${scan.considered} sessions` : ''} · ${scan.scenarios.length} scenarios in ${(scan.ms / 1000).toFixed(2)} s</span>
          ${none ? '' : `<span class="muted small">Investment <b class="txt-strong">${inr(st.capital)}</b> ${scan.opts.capital ? '(the Capital in the settings bar)' : '(largest estimated margin of the trades; set Capital in the settings bar to fix it)'} · as defined: ${inrS(st.total)} = <b class="${cls(st.roi)}">${pct(st.roi)}</b> on it, ${pct(st.annualRoi)} a year</span>`}
          <div class="res-legs">${BT.legChips(s)}</div>
        </div>
        <div class="seg top-tabs" id="btTop"></div>
      </div>
      <div id="btPaneDetails" class="bt-results">
        ${none ? noTrades : `<div class="panel scen-panel">
          <div class="chart-head"><h3>Scenarios — best combinations</h3><span class="muted small">${scan.scenarios.length} combinations of take profit × stop-loss × exit tested, ${scan.rows.length} different outcomes · % of the net ${scan.debit ? 'debit paid' : 'credit received'} at entry · click a row to see it below · click a column to sort</span></div>
          <div class="tbl-wrap scen-wrap" id="btScen"></div>
        </div>
        <div id="btDetail" class="bt-results"></div>`}
      </div>
      <div id="btPaneAdjust" class="panel adj-panel hidden"></div>`;
    renderTop();
    renderAdjust();
    $('btTop').addEventListener('click', (e) => { if (e.target.dataset.top) { topTab = e.target.dataset.top; renderTop(); } });
    $('btMain')?.addEventListener('click', () => pickVariant('own'));
    $('btPaneAdjust').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) {
        adjSort = th.dataset.k === adjSort.k ? { k: adjSort.k, dir: -adjSort.dir } : { k: th.dataset.k, dir: -1 };
        return renderAdjust();
      }
      const tr = e.target.closest('tr[data-k]');
      if (tr) pickVariant(tr.dataset.k);
    });
    if (none) return;
    renderScenarios();
    $('btScen').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) {
        scSort = th.dataset.k === scSort.k ? { k: scSort.k, dir: -scSort.dir } : { k: th.dataset.k, dir: -1 };
        return renderScenarios();
      }
      const tr = e.target.closest('tr[data-k]');
      if (tr && tr.dataset.k !== selKey) select(tr.dataset.k);
    });
    select(sortedRows()[0].key);
  }

  function renderScenarios() {
    const el = $('btScen');
    const top = el.scrollTop;
    const { k, dir } = scSort;
    el.innerHTML = `<table class="grid-tbl cmp-tbl scen-tbl">
      <thead><tr><th>#</th><th class="l">Take profit</th><th class="l">Stop-loss</th><th class="l">Exit</th>${SC_COLS.map(([c, l]) => `<th data-k="${c}" class="sortable${c === k ? ' sorted' : ''}">${l}${c === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
      <tbody>${sortedRows().map((sc, i) => {
        const l = scLabels(sc);
        const same = sc.same.length ? ` <span class="muted small" title="${esc('Same result as: ' + sc.same.map(scText).join('\n'))}">+${sc.same.length} same</span>` : '';
        return `<tr data-k="${sc.key}" class="${sc.key === selKey ? 'sel' : ''}"><td class="muted">${i + 1}</td><td class="l">${esc(l.tgt)}</td><td class="l">${esc(l.sl)}</td>
          <td class="l">${esc(l.exit)}${sc.base ? ' <span class="cat-pill c-mine">as defined</span>' : ''}${same}</td>
          ${SC_COLS.map(([c, , f]) => `<td class="${c === 'total' ? cls(sc.stats.total) + ' b' : c === 'avg' ? cls(sc.stats.avg) : c === 'roi' ? cls(sc.stats.roi) : c === 'maxDD' ? 'neg' : ''}">${sc.stats.trades ? f(sc.stats[c]) : c === 'trades' ? 0 : '—'}</td>`).join('')}</tr>`;
      }).join('')}</tbody></table>`;
    el.scrollTop = top;
  }

  // Run the picked scenario on its own: months, breakdown, trades and equity curve below the table.
  async function select(key) {
    const sc = scan.rows.find((x) => x.key === key);
    if (!sc) return;
    selKey = key;
    $('btScen').querySelectorAll('tr[data-k]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.k === key));
    const mine = scan;
    const current = () => scan === mine && selKey === key;
    try {
      const job = await BT.runJob('/api/bt/run', { strategy: scan.strategy, opts: runOpts, scenario: { own: sc.own, tgt: sc.tgt, sl: sc.sl, exit: sc.exit } });
      if (!current()) return;
      result = job.result;
      jobId = job.id;
      renderDetail(sc);
    } catch (e) {
      if (current()) $('btDetail').innerHTML = `<div class="panel empty err"><b>Backtest failed:</b> ${esc(e.message)}</div>`;
    }
  }

  function renderDetail(sc) {
    selSc = sc;
    const r = result;
    const st = r.stats;
    const rank = sortedRows().findIndex((x) => x.key === sc.key) + 1;
    const head = `<div class="res-title scen-sel">
        <h3>Selected: #${rank} ${sc.base ? '<span class="cat-pill c-mine">as defined</span>' : ''}</h3>
        <span class="muted small">${esc(scText(sc))}</span>
        <span class="spacer"></span>
        ${sc.base && !variant ? '' : '<button class="btn-sm ghost" id="btUse" title="Put this variation / scenario (its adjustments, take profit, stop-loss and exit) into the strategy editor, to save or deploy it">Use in editor</button>'}
      </div>`;
    if (!st.trades) {
      $('btDetail').innerHTML = `<div class="panel res-head">${head}<div class="muted">No trades in this scenario (${r.skippedCount} skipped).</div></div>`;
    } else {
      $('btDetail').innerHTML = `
      <div class="panel res-head">
        ${head}
        <div class="kpis">
          ${tile('Investment', inr(st.capital), r.opts.capital ? 'Capital (settings bar)' : 'est. margin (largest trade)')}
          ${tile('Net P&amp;L', inrS(st.total), `gross ${inrS(st.gross)} · costs ${inr(st.costs)}`, cls(st.total))}
          ${tile('% profit', pct(st.roi), `${pct(st.annualRoi)} a year · ${pct(st.roi / st.trades, 2)} per trade`, cls(st.roi))}
          ${tile('Win rate', pct(st.winRate), `${st.wins} W · ${st.losses} L of ${st.trades}`)}
          ${tile('Avg / trade', inrS(st.avg), `win ${inrS(st.avgWin)} · loss ${inrS(st.avgLoss)}`, cls(st.avg))}
          ${tile('Max drawdown', inr(st.maxDD), `${ofCap(st.maxDD)} of investment${st.ddFrom ? ` · ${dayShort(st.ddFrom)} → ${dayShort(st.ddTo)}` : ''}`, 'neg')}
          ${tile('Return / DD', num(st.calmar), `annual ${inrS(st.annual)}`)}
          ${tile('Profit factor', num(st.profitFactor), `reward:risk ${num(st.rr)}`)}
          ${tile('Sharpe', num(st.sharpe), `Sortino ${num(st.sortino)}`)}
          ${tile('Best / worst', `<span class="pos">${inrS(st.maxWin)}</span>`, `<span class="neg">${inrS(st.maxLoss)}</span> · ${ofCap(st.maxWin)} / ${ofCap(st.maxLoss)}`)}
          ${tile('Streaks', `${st.streakWin} W / ${st.streakLoss} L`, `longest DD ${st.longestDDTrades} trades`)}
        </div>
      </div>
      <div class="panel res-tabs-panel">
        <div class="res-tabbar">
          <div class="seg" id="btTabs">
            <button data-t="monthly">Monthly</button><button data-t="breakdown">Breakdown</button><button data-t="suggest" title="What the losing trades have in common, and which tested rule would have helped">Suggestions</button>
            <button data-t="trades">Trades (${st.trades})</button><button data-t="skipped">Skipped (${r.skippedCount})</button>
          </div>
          <span class="spacer"></span>
          <button class="btn-sm ghost" id="btCsv">Export CSV</button>
        </div>
        <div id="btTab" class="res-tab"></div>
      </div>
      <div class="panel res-chart">
        <div class="chart-head"><h3>Equity curve</h3><span class="muted small">cumulative net P&amp;L after costs · bars = each trade</span></div>
        <div class="chart-box eq"><canvas id="btEq"></canvas></div>
        <div class="chart-box dd"><canvas id="btDD"></canvas></div>
      </div>`;
      drawEquity();
      $('btTabs').addEventListener('click', (e) => { if (e.target.dataset.t) { tab = e.target.dataset.t; renderTab(); } });
      $('btCsv').addEventListener('click', exportCsv);
      // "show it" in the suggestions: jump to that scenario (or the row it shares its result with)
      $('btTab').addEventListener('click', (e) => {
        const k = e.target.dataset.go;
        const row = k && scan.rows.find((x) => x.key === k || x.same.some((y) => y.key === k));
        if (row) select(row.key);
      });
      renderTab();
    }
    $('btUse')?.addEventListener('click', () => {
      editor.set(BT.clone(r.strategy));
      dirty = true;
      BT.store.set('draft', { id: currentId, s: editor.get() });
      $('btSaveMsg').textContent = 'scenario applied — unsaved changes';
    });
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
    else if (tab === 'suggest') el.innerHTML = suggestHtml();
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
      return `<td style="background:rgba(${v >= 0 ? '63,182,139' : '240,113,107'},${a.toFixed(2)})">${kinr(v)}<div class="cell-pct">${ofCap(v)}</div></td>`;
    };
    const posMonths = vals.filter((v) => v > 0).length;
    return `<div class="tbl-wrap"><table class="grid-tbl month-tbl">
      <thead><tr><th>Year</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${years.map((y) => `<tr><th>${y}</th>${MONTHS.map((_, i) => cell(st.monthly[`${y}-${String(i + 1).padStart(2, '0')}`])).join('')}<td class="${cls(st.yearly[y])} b">${inrS(st.yearly[y])}<div class="cell-pct">${ofCap(st.yearly[y])}</div></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="muted small pad">Profitable months: <b>${posMonths}</b> of ${vals.length}. Best month ${inrS(Math.max(...vals))} (${ofCap(Math.max(...vals))}), worst ${inrS(Math.min(...vals))} (${ofCap(Math.min(...vals))}). Percentages are of the investment, ${inr(st.capital)}.</div>`;
  }

  function bucketTable(title, obj, label) {
    const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
    const max = Math.max(1, ...keys.map((k) => Math.abs(obj[k].pnl)));
    return `<div class="bd-card"><h4>${title}</h4><table class="grid-tbl bd-tbl"><thead><tr><th></th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>% profit</th><th>Avg</th><th class="barcol"></th></tr></thead><tbody>
      ${keys.map((k) => { const b = obj[k]; const w = (Math.abs(b.pnl) / max) * 100; return `<tr><th>${label(k)}</th><td>${b.n}</td><td>${pct((b.wins / b.n) * 100, 0)}</td><td class="${cls(b.pnl)}">${inrS(b.pnl)}</td><td class="${cls(b.pnl)}">${ofCap(b.pnl)}</td><td class="${cls(b.pnl)}">${inrS(Math.round(b.pnl / b.n))}</td><td class="barcol"><div class="hbar ${b.pnl >= 0 ? 'p' : 'n'}" style="width:${w.toFixed(0)}%"></div></td></tr>`; }).join('')}
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

  // ---------- suggestions ----------
  // What the losing trades of the selected scenario have in common, and which of the tested rules would have
  // helped. Everything is counted from this backtest's own trades and scenario results; nothing is modelled.
  function suggestHtml() {
    const T = result.trades;
    const sc = selSc;
    const st = result.stats;
    const losers = T.filter((t) => t.net < 0);
    const winners = T.filter((t) => t.net > 0);
    if (!losers.length) return '<div class="muted pad">No losing trades in this scenario.</div>';
    const sum = (a, f) => a.reduce((s, t) => s + f(t), 0);
    const avg = (a, f) => (a.length ? sum(a, f) / a.length : 0);
    const prem = scan.debit ? 'debit' : 'credit';
    const lossSum = sum(losers, (t) => t.net);
    const items = [];
    const add = (kind, title, body) => items.push(`<div class="sugg ${kind}"><div class="sugg-head"><b>${title}</b></div><div>${body}</div></div>`);
    const go = (x) => `<button class="link" data-go="${x.key}">show it</button>`;

    const worst = losers.slice().sort((a, b) => a.net - b.net).slice(0, 3);
    add('info', `${losers.length} of ${T.length} trades lost ${inr(-lossSum)}`,
      `Average loss ${inrS(Math.round(lossSum / losers.length))} against an average win of ${inrS(Math.round(avg(winners, (t) => t.net)))} (${winners.length} winners, ${inrS(sum(winners, (t) => t.net))}). The ${worst.length} worst trades (${worst.map((t) => `${dayShort(t.entryDay)} ${inrS(t.net)}`).join(', ')}) are ${pct((sum(worst, (t) => t.net) / lossSum) * 100, 0)} of all losses.`);

    // Tested rules: the best value of each rule with the other two kept as selected, and the best combination overall.
    const grid = scan.scenarios.filter((x) => !x.own && x.stats.trades);
    const sameExit = (a, b) => a.time === b.time && a.dteDays === b.dteDays;
    const top = (list) => list.reduce((b, x) => (!b || x.stats.total > b.stats.total ? x : b), null);
    const line = (what, x) => `<li>${what}: net ${inrS(x.stats.total)} (${inrS(x.stats.total - st.total)}), win rate ${pct(x.stats.winRate, 0)}, max drawdown ${inr(x.stats.maxDD)} (now ${inr(st.maxDD)}) — ${go(x)}</li>`;
    const better = [];
    if (!sc.own) {
      const bt = top(grid.filter((x) => x.sl === sc.sl && sameExit(x.exit, sc.exit)));
      const bs = top(grid.filter((x) => x.tgt === sc.tgt && sameExit(x.exit, sc.exit)));
      const bx = top(grid.filter((x) => x.tgt === sc.tgt && x.sl === sc.sl));
      if (bt && bt.stats.total > st.total) better.push(line(`Take profit <b>${esc(scLabels(bt).tgt)}</b> instead of ${esc(scLabels(sc).tgt)}`, bt));
      if (bs && bs.stats.total > st.total) better.push(line(`Stop-loss <b>${esc(scLabels(bs).sl)}</b> instead of ${esc(scLabels(sc).sl)}`, bs));
      if (bx && bx.stats.total > st.total) better.push(line(`Exit <b>${esc(scLabels(bx).exit)}</b> instead of ${esc(scLabels(sc).exit)}`, bx));
    }
    const all = top(grid);
    if (all && all.stats.total > st.total) better.push(line(`Best combination tested: <b>${esc(scText(all))}</b>`, all));
    const calm = grid.filter((x) => x.stats.total > 0).reduce((b, x) => (!b || x.stats.maxDD > b.stats.maxDD ? x : b), null);
    if (better.length) add('act', 'Rules that did better on the same trades', `<ul class="sugg-ul">${better.join('')}</ul>`);
    else add('ok', 'No tested rule beats this one', 'Among the take-profit, stop-loss and exit combinations tested, this scenario has the highest net P&amp;L.');
    if (calm && calm.key !== all?.key && calm.stats.maxDD > st.maxDD) add('info', 'A calmer alternative', `<ul class="sugg-ul">${line(`Smallest drawdown among the profitable combinations: <b>${esc(scText(calm))}</b>`, calm)}</ul>`);

    // Losers that were in profit first.
    const withPrem = losers.filter((t) => Math.abs(t.premium) > 0);
    const lv = [10, 20, 30, 50].map((p) => {
      const hit = withPrem.filter((t) => t.maxProfit >= (p / 100) * Math.abs(t.premium));
      const tested = sc.own ? null : scan.scenarios.find((x) => !x.own && x.tgt === p && x.sl === sc.sl && sameExit(x.exit, sc.exit));
      return { p, hit, lost: sum(hit, (t) => t.net), booked: sum(hit, (t) => (p / 100) * Math.abs(t.premium)), tested };
    }).filter((x) => x.hit.length);
    if (lv.length) {
      add('warn', `${lv[0].hit.length} of ${losers.length} losing trades were in profit first`,
        `<table class="grid-tbl sugg-tbl"><thead><tr><th class="l">Was ahead by at least</th><th>Losing trades</th><th>They ended at</th><th>Booked there instead (before costs)</th><th>Tested on all trades</th></tr></thead><tbody>
          ${lv.map((x) => `<tr><th>${x.p}% of ${prem}</th><td>${x.hit.length}</td><td class="neg">${inrS(x.lost)}</td><td class="pos">≈ ${inrS(Math.round(x.booked))}</td><td>${x.tested?.stats.trades ? `net ${inrS(x.tested.stats.total)} ${go(x.tested)}` : '—'}</td></tr>`).join('')}
        </tbody></table><div class="muted small">A take-profit (or the editor's "Lock profit" with a trail) at one of these levels turns those losers into winners, but it also cuts every winner short at the same level: the last column is the net result with that take-profit applied to every trade.</div>`);
    }

    // Which way Nifty went, and which leg paid for it.
    const moved = losers.filter((t) => t.spotOut != null);
    if (moved.length >= 2) {
      const up = moved.filter((t) => t.spotOut > t.spotIn);
      const mv = (t) => (Math.abs(t.spotOut - t.spotIn) / t.spotIn) * 100;
      const side = up.length >= moved.length * 0.65 ? 'up' : up.length <= moved.length * 0.35 ? 'down' : null;
      const s = scan.strategy;
      const legs = s.legs.map((l, i) => {
        const of = (list) => sum(list, (t) => sum(t.legs.filter((x) => x.leg === i), (x) => x.pnl - x.cost));
        return { label: `${i + 1}. ${BT.legLabel(l)}`, lose: of(losers), win: of(winners) };
      });
      for (const [type, label] of [['CE', 'All call legs'], ['PE', 'All put legs']]) {
        const of = (k) => sum(legs.filter((x, i) => s.legs[i]?.type === type), (x) => x[k]);
        if (s.legs.some((l) => l.type === type) && s.legs.some((l) => l.type !== type)) legs.push({ label, lose: of('lose'), win: of('win'), total: true });
      }
      const sides = legs.filter((x) => x.total);
      const worstSide = sides.length ? sides.reduce((b, x) => (x.lose < b.lose ? x : b)) : null;
      const opt = worstSide ? (worstSide.label.includes('call') ? 'call' : 'put') : side === 'up' ? 'call' : 'put';
      add(side ? 'warn' : 'info', side ? `${side === 'up' ? up.length : moved.length - up.length} of ${moved.length} losses came with Nifty ${side === 'up' ? 'rising' : 'falling'}` : 'Losses came on moves in both directions',
        `Nifty moved ${pct(avg(moved, mv))} on average from entry to exit in the losing trades, ${pct(avg(winners.filter((t) => t.spotOut != null), mv))} in the winners.
        ${side || worstSide ? ` The ${opt} side is where the money is lost: sell the ${opt} further from spot, buy its hedge closer to it, or give the short ${opt} a leg stop ("Nifty move %" or "% of premium").` : ' The losses are about the size of the move, not its direction: a smaller overall stop or an earlier exit limits them on both sides.'}
        <table class="grid-tbl sugg-tbl"><thead><tr><th class="l">Leg</th><th>P&amp;L in the losing trades</th><th>P&amp;L in the winning trades</th></tr></thead><tbody>
          ${legs.map((x) => `<tr${x.total ? ' class="b"' : ''}><th>${esc(x.label)}${x === worstSide ? ' <span class="neg small">← loses the most</span>' : ''}</th><td class="${cls(x.lose)}">${inrS(x.lose)}</td><td class="${cls(x.win)}">${inrS(x.win)}</td></tr>`).join('')}
        </tbody></table>`);
    }

    // How deep the winners went before recovering: the room a stop has to leave.
    if (winners.length >= 4) {
      const dips = winners.map((t) => -t.maxLoss).sort((a, b) => a - b);
      const w90 = dips[Math.min(dips.length - 1, Math.floor(dips.length * 0.9))];
      const cut = losers.filter((t) => -t.net > w90);
      if (w90 > 0 && cut.length) {
        add('info', `A stop needs about ${inr(w90)} of room`,
          `9 of 10 winners were never down more than ${inr(w90)} on the way (the deepest was ${inr(dips[dips.length - 1])}). ${cut.length} losing trade${cut.length === 1 ? '' : 's'} ended beyond that, at ${inrS(Math.round(avg(cut, (t) => t.net)))} on average: an overall stop near ${inr(w90)} would have saved about ${inr(Math.round(sum(cut, (t) => -t.net - w90)))} on them while leaving most winners alone (stops fill at the candle close, so a gap can still lose more). Set it under "Overall position" in the editor.`);
      }
    }

    // Entry days that lose.
    for (const [obj, name, label] of [[st.weekday, 'weekday', (k) => WD[k]], [st.dte, 'days to expiry', (k) => (Number(k) === 0 ? 'expiry day' : k + ' days before expiry')]]) {
      const keys = Object.keys(obj);
      const bad = keys.filter((k) => obj[k].n >= 3 && obj[k].pnl < 0);
      if (scan.strategy.mode === 'intraday' && keys.length > 1 && bad.length && bad.length < keys.length) {
        add('warn', `Losing entry ${name}: ${bad.map(label).join(', ')}`,
          `${bad.map((k) => `${label(k)}: ${obj[k].n} trades, ${pct((obj[k].wins / obj[k].n) * 100, 0)} winners, ${inrS(obj[k].pnl)}`).join(' · ')}. Without them the net would be ${inrS(st.total - sum(bad, (k) => obj[k].pnl))}. Untick them under "Entry &amp; exit" in the editor.`);
      }
    }

    // Small entry premium.
    const pr = T.filter((t) => t.premium != null).slice().sort((a, b) => Math.abs(a.premium) - Math.abs(b.premium));
    if (pr.length >= 8) {
      const lo = pr.slice(0, pr.length >> 1);
      const hi = pr.slice(pr.length >> 1);
      const med = Math.abs(hi[0].premium);
      const a = sum(lo, (t) => t.net);
      const b = sum(hi, (t) => t.net);
      if (a < 0 !== b < 0) {
        add('warn', `Entries with a ${a < 0 ? 'small' : 'large'} ${prem} lose`,
          `Trades entered for a ${prem} below ${inr(med)}: ${inrS(a)} (${lo.filter((t) => t.net > 0).length} of ${lo.length} won). Above it: ${inrS(b)} (${hi.filter((t) => t.net > 0).length} of ${hi.length} won). ${!scan.debit && a < 0 ? 'Raise "Net credit at least" under Filters to skip the thin weeks.' : scan.debit ? 'Cheap entries are the ones that pay here: a VIX maximum under Filters keeps you out of the expensive ones.' : 'A rich credit here means a nervous market: a VIX maximum under Filters, or strikes further from spot in those weeks, avoids the losing group.'}`);
      }
    }

    // How the losing trades ended.
    const ends = {};
    for (const t of losers) ends[t.reason] = (ends[t.reason] || 0) + 1;
    add('info', 'How the losing trades ended', Object.entries(ends).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} × ${REASON[k] || k}`).join(' · ') +
      '. Open them in the Trades tab (Losers) and press ▶ Replay to step through one and try an adjustment in the Builder.');

    return `<div class="sb-sugg-list sugg-list">${items.join('')}
      <div class="muted small">These numbers come from the same trades they are judged on, so the best rule is flattered: check it on another period (or other expiries) before relying on it.</div></div>`;
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
    const legTxt = (x) => `<span class="lx ${x.action === 'B' ? 'buy' : 'sell'}" title="${esc(`${x.action === 'B' ? 'Buy' : 'Sell'} ${x.qty} × ${x.strike} ${x.type} (${x.expiry}) · ${x.entryDay} ${x.entryTime} @ ${x.entryPx} → ${x.exitDay} ${x.exitTime} @ ${x.exitPx} · ${REASON[x.reason] || x.reason} · ${inrS(x.pnl)}`)}>${x.action}${x.re ? '↻' : ''}${x.rolled ? '⟳' : ''} ${x.strike}${x.type} ${x.entryPx}→${x.exitPx}${x.reason === 'sl' ? ' <b class="neg">SL</b>' : x.reason === 'tgt' ? ' <b class="pos">TG</b>' : x.reason === 'roll' ? ' <b class="muted">⟳</b>' : x.reason === 'partial' ? ` <b class="pos" title="Partial booking: ${x.qty} closed">½</b>` : ''}</span>`;
    el.innerHTML = `<div class="trade-tools">
        <div class="seg sm">${[['all', 'All'], ['wins', 'Winners'], ['losses', 'Losers']].map(([v, l]) => `<button data-f="${v}" class="${tradeFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select id="btSort">${[['date', 'Oldest first'], ['recent', 'Newest first'], ['best', 'Best first'], ['worst', 'Worst first']].map(([v, l]) => `<option value="${v}" ${tradeSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="muted small">Click a trade for its minute-by-minute P&amp;L; <b>▶ Replay</b> opens it in the Builder at its entry minute to step through and try adjustments.</span>
      </div>
      <div class="tbl-wrap trades-wrap"><table class="grid-tbl trades-tbl">
        <thead><tr><th>#</th><th>Entry</th><th>Exit</th><th>Expiry</th><th>DTE</th><th>Nifty</th><th class="l">Legs (entry → exit)</th><th title="Estimated margin blocked by this trade">Margin</th><th>Max profit</th><th>Max loss</th><th>Exit</th><th>Net P&amp;L</th><th title="Net P&amp;L as a share of the investment">% profit</th><th></th></tr></thead>
        <tbody>${idx.map((i) => {
          const t = result.trades[i];
          return `<tr data-i="${i}"><td class="muted">${i + 1}</td><td>${dayShort(t.entryDay)} <span class="muted">${WD[t.weekday]} ${t.entryTime}</span></td>
            <td>${t.exitDay !== t.entryDay ? dayShort(t.exitDay) + ' ' : ''}<span class="muted">${t.exitTime}</span></td><td>${dayShort(t.ref)}</td><td>${t.dte}</td>
            <td>${Math.round(t.spotIn)} <span class="${cls(t.spotOut - t.spotIn)}">${t.spotOut != null ? (t.spotOut >= t.spotIn ? '+' : '') + Math.round(t.spotOut - t.spotIn) : ''}</span></td>
            <td class="l legs-cell">${t.legs.map(legTxt).join('')}${t.signal ? `<div class="sig-txt" title="${esc(t.signal)}">⚡ ${esc(t.signal)}</div>` : ''}</td>
            <td class="muted">${kinr(t.margin)}</td><td class="pos">${inr(t.maxProfit)}</td><td class="neg">${inr(t.maxLoss)}</td><td class="muted">${REASON[t.reason] || t.reason}</td>
            <td class="${cls(t.net)} b">${inrS(t.net)}</td><td class="${cls(t.net)}">${ofCap(t.net)}</td>
            <td class="replay-cell"><button class="btn-sm ghost" data-replay="${i}" title="Replay this trade in the Builder: same expiry, day, entry minute, strikes and fill prices">▶ Replay</button></td></tr>`;
        }).join('')}</tbody></table></div>`;
    el.querySelector('.seg').addEventListener('click', (e) => { if (e.target.dataset.f) { tradeFilter = e.target.dataset.f; renderTrades(); } });
    $('btSort').addEventListener('change', (e) => { tradeSort = e.target.value; renderTrades(); });
    el.querySelector('tbody').addEventListener('click', (e) => {
      const rb = e.target.closest('button[data-replay]');
      if (rb) { replayTrade(Number(rb.dataset.replay)); return; }
      const tr = e.target.closest('tr[data-i]');
      if (tr) openTrade(Number(tr.dataset.i));
    });
  }

  // ---------- replay in the Builder ----------
  // The trade's original legs (not re-entries) at their backtest fills, on the trade's expiry and entry minute. Each
  // leg carries its strategy rule, so saving from the Builder keeps the rule, SL and target of legs left in place.
  function replayTrade(i) {
    const t = result.trades[i];
    const s = result.strategy;
    const seen = new Set(); // a partial booking splits a leg into two executions with the same entry
    const legs = t.legs.filter((x) => !x.re && !x.rolled && x.entryDay === t.entryDay && x.entryTime === t.entryTime && !seen.has(x.leg) && seen.add(x.leg)).map((x) => ({
      action: x.action, type: x.type, strike: x.strike, expiry: x.expiry, lots: s.legs[x.leg]?.lots, qty: x.qty, px: x.entryPx,
      rule: s.legs[x.leg], ruleStrike: x.strike,
    }));
    document.querySelector('.modal-ov')?.remove();
    BT.emit('open-builder', {
      strategy: s, src: 'hist', expiry: t.ref, day: t.entryDay, time: t.entryTime,
      session: t.exitDay !== t.entryDay || s.mode === 'positional' ? 'multi' : 'intraday',
      legs, note: `backtest trade #${i + 1} · ${dayShort(t.entryDay)} ${t.entryTime} · ended ${inrS(t.net)} (${REASON[t.reason] || t.reason})`,
    });
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
        <span class="${cls(t.net)} big">${inrS(t.net)} <span class="small">${ofCap(t.net)} of ${kinr(result.stats.capital)}</span></span><button class="btn-sm" data-replay="${i}" title="Open this trade in the Builder at its entry minute, to step through it and try adjustments">▶ Replay in Builder</button><button class="icon close">✕</button></div>
      ${t.signal ? `<div class="sig-txt pad">⚡ Entry signal: ${esc(t.signal)}</div>` : ''}
      ${t.credit != null ? `<div class="muted small pad">Net credit at entry ${t.credit} pts per lot${t.partial ? ' · part of the lots booked early (partial booking)' : ''}</div>` : ''}
      ${t.notes?.length ? `<div class="dep-warn pad">${t.notes.map(esc).join('<br>')}</div>` : ''}
      <div class="muted small pad">Expiry ${dayLabel(t.ref)} · DTE ${t.dte} · Nifty ${t.spotIn} → ${t.spotOut ?? '—'}${t.vix != null ? ' · VIX ' + t.vix : ''} · gross ${inrS(t.gross)} · costs ${inr(t.costs)} · max profit ${inr(t.maxProfit)} · max loss ${inr(t.maxLoss)} · est. margin ${kinr(t.margin)}</div>
      <div class="chart-box trade-chart"><canvas id="btTradeChart"></canvas></div>
      <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Leg</th><th>Action</th><th>Contract</th><th>Qty</th><th>Entry</th><th>Price</th><th>Exit</th><th>Price</th><th>Reason</th><th>Costs</th><th>P&amp;L</th></tr></thead><tbody>
        ${t.legs.map((x) => `<tr><td>${x.leg + 1}${x.re ? ' ↻' + x.re : ''}${x.rolled ? ' ⟳' : ''}</td><td class="${x.action === 'B' ? 'pos' : 'neg'}">${x.action === 'B' ? 'BUY' : 'SELL'}</td><td>${x.strike} ${x.type} <span class="muted">${dayShort(x.expiry)}</span></td><td>${x.qty}</td>
          <td>${x.entryDay !== t.entryDay ? dayShort(x.entryDay) + ' ' : ''}${x.entryTime}</td><td>${x.entryPx}</td><td>${x.exitDay !== x.entryDay ? dayShort(x.exitDay) + ' ' : ''}${x.exitTime}</td><td>${x.exitPx}</td>
          <td>${REASON[x.reason] || x.reason}</td><td class="muted">${inr(x.cost)}</td><td class="${cls(x.pnl)} b">${inrS(x.pnl)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => {
      if (e.target.dataset.replay != null) { replayTrade(i); return; }
      if (e.target === ov || e.target.classList.contains('close')) close();
    });
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
    const rows = [['trade', 'signal', 'entry_day', 'entry_time', 'exit_day', 'exit_time', 'expiry', 'dte', 'spot_in', 'spot_out', 'leg', 'action', 'strike', 'type', 'leg_expiry', 'qty', 'leg_entry', 'entry_px', 'leg_exit', 'exit_px', 'exit_reason', 'leg_pnl', 'leg_costs', 'trade_net', 'trade_margin', 'investment', 'trade_pct_of_investment']];
    result.trades.forEach((t, i) => t.legs.forEach((x) => rows.push([i + 1, `"${(t.signal || '').replace(/"/g, "'")}"`, t.entryDay, t.entryTime, t.exitDay, t.exitTime, t.ref, t.dte, t.spotIn, t.spotOut, x.leg + 1, x.action, x.strike, x.type, x.expiry, x.qty, `${x.entryDay} ${x.entryTime}`, x.entryPx, `${x.exitDay} ${x.exitTime}`, x.exitPx, x.reason, x.pnl, x.cost, t.net, t.margin, result.stats.capital, result.stats.capital ? ((t.net / result.stats.capital) * 100).toFixed(2) : ''])));
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
