// Bi-weekly screen: the bi-weekly hedge, its reverse, and the two combined (bt/biweekly.js).
// Left: the three of them; Combined is one position holding the legs of both. Right: Summary (the best variation
// and the top 5), Details (KPIs, months, trades and equity curve of one variation) and Adjustments (all, ranked).
(() => {
  const { $, esc, inr, inrS, kinr, pct, num, cls, dayLabel, dayShort, WD, MONTHS, REASON } = BT;
  const FAMS = [
    ['hedge', 'Bi-weekly Hedge'],
    ['rev', 'Bi-weekly Hedge Reverse'],
    ['combined', 'Combined'],
  ];
  let settings = null;
  let st = null; // saved result of "Backtest all variations": { at, opts, optsRaw, strikes, overlap, families: [hedge, rev, combined] }
  let fam = BT.store.get('bw-fam', 'hedge');
  let tab = 'summary';
  const sel = { hedge: null, rev: null, combined: null }; // variation shown in Details (default: the best)
  const sort = { hedge: { k: 'total', dir: -1 }, rev: { k: 'total', dir: -1 }, combined: { k: 'total', dir: -1 } };
  let run = null; // what Details shows: the full run of one variation, with its job id
  let runTag = null;
  let note = ''; // error of the last run
  let rTab = 'monthly';
  let tradeFilter = 'all';
  let tradeSort = 'date';
  // Short strikes of every variation: null = as each strategy defines them (by premium), or that many points OTM.
  let strikes = BT.store.get('bw-strikes', { by: 'pts', value: 100 });
  // A new position every week even while the previous one is open (each its own trade), or one at a time.
  let overlap = BT.store.get('bw-overlap', true);

  const family = (id) => st.families.find((f) => f.id === id);
  const rowOf = (id, key) => family(id).rows.find((r) => r.key === key);
  const curKey = (id) => (sel[id] && rowOf(id, sel[id]) ? sel[id] : family(id).best || family(id).rows[0].key);
  const when = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const tile = (label, value, sub = '', c = '') =>
    `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c}">${value}</span><span class="k-s">${sub}</span></div>`;
  const riskPill =
    '<span class="cat-pill c-bearish" title="Some short options are not covered by a bought option for their whole life: one bad week can lose far more than this backtest shows. Never picked as the best.">unlimited risk</span>';

  async function init() {
    if (settings) return;
    settings = true; // being set up
    try {
      await BT.loadMeta();
    } catch (e) {
      settings = null;
      $('bwResults').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      return;
    }
    // First visit: the whole history, on ₹5 L (₹1 L per lot for the 5 lots of the strategies).
    const c = BT.meta.calendar;
    if (c?.expired?.length && !BT.store.get('bw-settings', null)) {
      const first = new Date(Date.parse(c.expired[0] + 'T00:00:00Z') - 7 * 86400_000).toISOString().slice(0, 10);
      BT.store.set('bw-settings', { from: first, to: c.expired[c.expired.length - 1], capital: 500000 });
    }
    settings = BT.createSettings($('bwSettings'), { onRun: runAll, runLabel: 'Backtest all variations', key: 'bw-settings' });
    await loadState();
    render();
  }
  async function loadState() {
    try {
      st = (await BT.api('/api/bt/bw/state')).state;
    } catch {
      /* keep what is shown */
    }
  }

  async function runAll() {
    let opts;
    try {
      opts = settings.get();
    } catch (e) {
      return alert(e.message);
    }
    settings.setBusy(true);
    try {
      st = (await BT.runJob('/api/bt/bw/run', { opts, strikes, overlap }, settings.progress)).result;
      run = runTag = null;
      sel.hedge = sel.rev = sel.combined = null;
      note = '';
    } catch (e) {
      note = 'Backtest failed: ' + e.message;
    } finally {
      settings.setBusy(false);
    }
    render();
  }

  // ---------- layout ----------
  const strikeTxt = (x) => (x ? `short strikes ${x.value} pts OTM` : 'short strikes by premium');
  const overlapTxt = (x) => (x ? 'a new trade every week' : 'one trade at a time');
  function renderStrikes() {
    $('bwStrikes').innerHTML = `<span class="lbl">Short strikes</span>
      <div class="seg sm"><button data-sk="prem" class="${strikes ? '' : 'on'}" title="As each strategy defines them: the call and the put closest to a premium (≈₹105 / ≈₹120)">By premium</button><button data-sk="pts" class="${strikes ? 'on' : ''}" title="The call and the put this many points out of the money from Nifty at entry">Points OTM</button></div>
      ${strikes ? `<input class="num xs" type="number" id="bwPts" value="${strikes.value}" min="0" max="2000" step="50"><span class="muted">pts from spot</span>` : ''}
      <label class="chk" title="Enter at the start of every weekly series, even while the previous position (held up to two weeks) is still open. Each is a trade of its own and all are added to the results. Unticked: the weeks that start while a trade is open are skipped (&quot;previous trade still open&quot;)."><input type="checkbox" id="bwOverlap" ${overlap ? 'checked' : ''}> New trade every week (overlapping)</label>
      <span class="muted small">Both apply to every variation.${overlap ? ' Two positions can be open at once, so up to twice the capital is in use; % profit stays on the Capital above.' : ''}${st && (JSON.stringify(st.strikes || null) !== JSON.stringify(strikes) || Boolean(st.overlap) !== overlap) ? ' <b class="dep-warn">The results below are for ' + strikeTxt(st.strikes) + ', ' + overlapTxt(st.overlap) + ': press Backtest all variations.</b>' : ''}</span>`;
  }
  function setStrikes(x) {
    strikes = x;
    BT.store.set('bw-strikes', strikes);
    renderStrikes();
  }

  function render() {
    renderMenu();
    renderStrikes();
    const el = $('bwResults');
    if (!st) {
      el.innerHTML = `<div class="panel empty${note ? ' err' : ''}">${note ? `<p class="err">${esc(note)}</p>` : ''}<h3>Bi-weekly Hedge, its Reverse, and the two combined</h3>
        <p>Press <b>Backtest all variations</b>: every adjustment variation of the two strategies is backtested over the period above (the whole option history Upstox keeps, about two years), the best of each is picked, and the two are also backtested as one combined position (the legs of both in a single trade). The results are saved and shown here next time without running anything.</p></div>`;
      return;
    }
    const f = family(fam);
    const tabs = [
      ['summary', 'Summary', 'The best variation and the top 5'],
      ['details', 'Details', 'KPIs, months, trades and equity curve of one variation'],
      ['adjust', `Adjustments (${f.rows.length})`, 'Every variation, each with one adjustment changed, ranked'],
    ];
    el.innerHTML = `<div class="panel top-bar"><div class="seg top-tabs" id="bwTop">${tabs.map(([t, l, tip]) => `<button data-top="${t}" class="${tab === t ? 'on' : ''}" title="${tip}">${l}</button>`).join('')}</div></div>
      ${note ? `<div class="panel empty err">${esc(note)}</div>` : ''}
      ${fam === 'combined' ? cfgHtml() : ''}
      <div id="bwPane" class="bt-results"></div>`;
    if (tab === 'details') renderDetails();
    else $('bwPane').innerHTML = tab === 'summary' ? familySummary(f) : adjustHtml(f);
  }

  function renderMenu() {
    const line = (id) => {
      if (!st) return 'not backtested yet';
      const f = family(id);
      const b = f.best && rowOf(id, f.best);
      return `${id === 'combined' ? 'both in one trade · ' : ''}${f.rows.length} variations · best ${b ? `<span class="${cls(b.stats.total)}">${inrS(b.stats.total)} (${pct(b.stats.roi)})</span>` : '—'}`;
    };
    $('bwMenu').innerHTML = `<div class="bt-edit-head"><b>Bi-weekly strategies</b></div>
      ${FAMS.map(([id, name]) => `<button class="bw-item${fam === id ? ' on' : ''}" data-fam="${id}"><b>${name}</b><span class="muted small">${line(id)}</span></button>`).join('')}
      ${st ? `<div class="muted small pad">${dayLabel(st.opts.from)} → ${dayLabel(st.opts.to)} · ${st.opts.lotMode === 'fixed' ? 'lot ' + st.opts.lotSize : 'lot as traded'} · capital ${st.opts.capital ? inr(st.opts.capital) : 'est. margin'} · slippage ${(st.opts.slippage * 100).toFixed(1)}% · ${strikeTxt(st.strikes)} · ${overlapTxt(st.overlap)}<br>backtested ${when(st.at)}<br><br>Best = the highest net P&amp;L among the variations whose short options stay hedged.</div>` : ''}`;
  }

  // ---------- tables ----------
  const years = () => [...new Set(st.families.flatMap((f) => f.rows.flatMap((r) => Object.keys(r.stats?.yearly || {}))))].sort();
  // [key, heading, text, class]
  const cols = () => [
    ['total', 'Net P&amp;L', (s) => inrS(s.total), (s) => cls(s.total) + ' b'],
    ['roi', '% profit', (s) => pct(s.roi), (s) => cls(s.roi)],
    ...years().map((y) => ['y' + y, y, (s) => (s.yearly?.[y] == null ? '·' : kinr(s.yearly[y])), (s) => cls(s.yearly?.[y])]),
    ['trades', 'Trades', (s) => `${s.trades} <span class="muted">(${s.wins} W / ${s.losses} L)</span>`, () => ''],
    ['winRate', 'Win %', (s) => pct(s.winRate), () => ''],
    ['maxDD', 'Max DD', (s) => inr(s.maxDD), () => 'neg'],
    ['calmar', 'Return / DD', (s) => num(s.calmar), () => ''],
    ['maxLoss', 'Worst trade', (s) => inrS(s.maxLoss), () => 'neg'],
    ['profitFactor', 'Profit factor', (s) => num(s.profitFactor), () => ''],
  ];
  const statVal = (s, k) => {
    if (!s?.trades) return null;
    const v = /^y\d{4}$/.test(k) ? (s.yearly?.[k.slice(1)] ?? 0) : s[k];
    return v == null || !isFinite(v) ? null : v;
  };
  const sorted = (rows, { k, dir }) =>
    rows.slice().sort((a, b) => {
      const x = statVal(a.stats, k);
      const y = statVal(b.stats, k);
      if (x == null || y == null) return (x == null) - (y == null); // no value: always last
      return (x - y) * dir;
    });
  const headCells = (so) =>
    cols()
      .map(
        ([c, l]) =>
          `<th${so ? ` data-k="${c}" class="sortable${c === so.k ? ' sorted' : ''}"` : ''}>${l}${so && c === so.k ? (so.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`,
      )
      .join('');
  const statCells = (s) =>
    cols()
      .map(([c, , f, k]) => `<td class="${s?.trades ? k(s) : ''}">${s?.trades ? f(s) : c === 'trades' && s ? 'no trades' : '—'}</td>`)
      .join('');
  const nameCell = (f, r) =>
    `<td class="l adj-name"><span class="cat-pill${r.key === 'own' ? ' c-mine' : ''}">${esc(r.group)}</span> <b>${esc(r.key === 'own' ? `As defined (${f.base})` : r.name)}</b>${r.key === f.best ? ' <span class="cat-pill c-bullish">best</span>' : ''}${r.risky ? ' ' + riskPill : ''}<div class="muted small">${esc(r.error ? 'Could not be tested: ' + r.error : r.note)}</div></td>`;
  const varRows = (f, rows, cur) =>
    rows
      .map(
        (r, i) =>
          `<tr data-var="${esc(r.key)}" class="${r.key === cur ? 'sel' : ''}"><td class="muted">${i + 1}</td>${nameCell(f, r)}${statCells(r.stats)}</tr>`,
      )
      .join('');
  const footnote = (f) =>
    `<div class="muted small pad">Investment = ${f.cfg ? (f.cfg.capital ? 'the Capital of the combined position' : 'the largest estimated margin of the trades') : st.opts.capital ? 'the Capital in the settings bar' : 'the largest estimated margin of the trades'}. % profit = net P&amp;L ÷ investment over the whole period; the year columns are the net P&amp;L of the trades closed in that year. The ranking is made on the same trades it is measured on: confirm a variation on another period before relying on it.</div>`;

  function rulesText(s) {
    const r = s.risk;
    const u = (v) => (r.unit === 'pct' ? `${v}% of capital` : inr(v));
    const out = [];
    out.push(r.tgt != null ? `target ${u(r.tgt)}` : r.tgtPrem != null ? `target ${r.tgtPrem}% of the premium` : 'no target');
    out.push(r.sl != null ? `stop ${u(r.sl)}` : r.slPrem != null ? `stop ${r.slPrem}% of the premium` : 'no overall stop');
    if (r.lockAt != null) out.push(`lock ${u(r.lockTo)} once up ${u(r.lockAt)}`);
    if (r.partialAt != null) out.push(`book ${r.partialPct}% of the lots at ${u(r.partialAt)}`);
    const ls = s.legs.find((l) => l.sl.type !== 'none');
    if (ls)
      out.push(
        `leg stop ${ls.sl.value}${{ pct: '% of its premium', pts: ' pts', upct: '% Nifty move', upts: ' Nifty pts' }[ls.sl.type] || ''}${r.onLegSl === 'all' ? ' → exit all' : ''}${ls.re ? ', re-entry' : ''}`,
      );
    const roll = s.legs.find((l) => l.roll);
    out.push(roll ? `hedge rolled ${roll.roll.dteDays ? roll.roll.dteDays + 'd before' : 'on the day'} it expires` : 'no roll');
    const f = s.filters;
    if (f.minCredit != null) out.push(`net credit ≥ ${f.minCredit} pts`);
    if (f.vixMin != null) out.push(`VIX ≥ ${f.vixMin}`);
    if (f.vixMax != null) out.push(`VIX ≤ ${f.vixMax}`);
    return out.join(' · ');
  }

  // KPI tiles from headline numbers (a variation or a full run).
  function kpis(s, capNote) {
    const tot = s.sumWin - s.sumLoss || 1;
    return `<div class="kpis">
      ${tile('Investment', inr(s.capital), capNote)}
      ${tile('Net P&amp;L', inrS(s.total), `gross ${inrS(s.gross)} · costs ${inr(s.costs)}`, cls(s.total))}
      ${tile('% profit', pct(s.roi), `${pct(s.annualRoi)} a year`, cls(s.roi))}
      ${tile('Trades', s.trades, `${s.wins} winners · ${s.losses} losers`)}
      ${tile('Win rate', pct(s.winRate), `avg win ${inrS(s.avgWin)} · avg loss ${inrS(s.avgLoss)}`)}
      ${tile('Profit vs loss', `<span class="pos">${kinr(s.sumWin)}</span> <span class="muted">vs</span> <span class="neg">${kinr(s.sumLoss)}</span>`, `<div class="pl-bar"><i style="width:${((s.sumWin / tot) * 100).toFixed(0)}%"></i></div>`)}
      ${tile('Max drawdown', inr(s.maxDD), `${s.capital ? pct((s.maxDD / s.capital) * 100) + ' of investment' : ''}${s.ddFrom ? ` · ${dayShort(s.ddFrom)} → ${dayShort(s.ddTo)}` : ''}`, 'neg')}
      ${tile('Return / DD', num(s.calmar), `profit factor ${num(s.profitFactor)}`)}
      ${tile('Best / worst trade', `<span class="pos">${inrS(s.maxWin)}</span>`, `<span class="neg">${inrS(s.maxLoss)}</span>`)}
      ${tile('Sharpe', num(s.sharpe), `longest losing run ${s.streakLoss}`)}
    </div>`;
  }
  const capNote = (f) =>
    f.cfg
      ? f.cfg.capital
        ? 'Capital of the combined position'
        : 'est. margin (largest trade)'
      : st.opts.capital
        ? 'Capital (settings bar)'
        : 'est. margin (largest trade)';
  const yearLine = (s) =>
    Object.keys(s.yearly || {})
      .sort()
      .map((y) => `${y}: <b class="${cls(s.yearly[y])}">${inrS(s.yearly[y])}</b>`)
      .join(' · ');

  // ---------- one strategy: summary and adjustments ----------
  function familySummary(f) {
    const best = f.best && rowOf(f.id, f.best);
    const tested = f.rows.filter((r) => r.stats?.trades);
    const riskyTop = tested.filter((r) => r.risky && best && r.stats.total > best.stats.total).sort((a, b) => b.stats.total - a.stats.total)[0];
    const card = !best
      ? '<div class="panel empty"><h3>No variation with limited risk made a trade</h3></div>'
      : `<div class="panel res-head best-card">
        <div class="res-title scen-sel"><h3>Best variation: ${esc(best.key === 'own' ? `As defined (${f.base})` : best.name)}</h3><span class="cat-pill">${esc(best.group)}</span>
          <span class="spacer"></span><button class="btn-sm" data-var="${esc(best.key)}">Open details ▸</button></div>
        <span class="muted small">${esc(best.note)} · ${esc(rulesText(best.strategy))}</span>
        <span class="muted small">Highest net P&amp;L of the ${tested.filter((r) => !r.risky).length} limited-risk variations tested · ${dayLabel(best.stats.from)} → ${dayLabel(best.stats.to)} · ${yearLine(best.stats)}</span>
        <div class="res-legs">${BT.legChips(best.strategy)}</div>
        ${kpis(best.stats, capNote(f))}
        ${riskyTop ? `<span class="dep-warn">${esc(riskyTop.name)} made more (${inrS(riskyTop.stats.total)}) but leaves short options uncovered, so its loss is not limited: it is listed under Adjustments and never picked as the best.</span>` : ''}
      </div>`;
    return `${card}${topPanel(f, `click a row to see it in Details · all ${f.rows.length} are under Adjustments`, footnote(f))}`;
  }
  // The top 5 of a family (and the strategy as defined, when it is not one of them): also the Backtest screen's Summary.
  function topPanel(f, hint, foot) {
    const own = f.rows.find((r) => r.key === 'own');
    return `<div class="panel scen-panel" data-bwfam="${f.id}">
        <div class="chart-head"><h3>${esc(f.name)} — top 5 variations</h3><span class="muted small">limited risk only, highest net P&amp;L first · ${hint}</span></div>
        <div class="tbl-wrap"><table class="grid-tbl cmp-tbl scen-tbl"><thead><tr><th>#</th><th class="l">Variation</th>${headCells()}</tr></thead>
          <tbody>${varRows(
            f,
            f.top.map((k) => rowOf(f.id, k)),
            null,
          )}${own && !f.top.includes('own') ? `<tr data-var="own"><td class="muted">·</td>${nameCell(f, own)}${statCells(own.stats)}</tr>` : ''}</tbody></table></div>
        ${foot}
      </div>`;
  }

  function adjustHtml(f) {
    return `<div class="panel adj-panel">
      <div class="chart-head"><h3>Adjustments — ${esc(f.name)}</h3><span class="muted small">${f.rows.length} variations of ${esc(f.base)}, each with one adjustment changed (plus ${f.id === 'combined' ? 'the best Hedge + best Reverse legs' : 'the built-in variants'}) and backtested on the same period and settings · click a row to open it in Details · click a column to sort</span></div>
      <div class="tbl-wrap"><table class="grid-tbl cmp-tbl scen-tbl adj-tbl"><thead><tr><th>#</th><th class="l">Adjustment</th>${headCells(sort[f.id])}</tr></thead>
        <tbody>${varRows(f, sorted(f.rows, sort[f.id]), curKey(f.id))}</tbody></table></div>
      ${footnote(f)}
    </div>`;
  }

  // ---------- combined ----------
  // One position: the hedge legs and the reverse legs entered, managed and exited together.
  function cfgHtml() {
    const c = family('combined').cfg;
    return `<div class="panel top-bar bw-cfg">
      <span class="lbl">Capital</span><span class="muted">₹</span><input class="num wide" type="number" id="bwCap" value="${c.capital ?? ''}" min="0" step="10000" placeholder="auto (margin)">
      <span class="lbl">Hedge lots</span><input class="num xs" type="number" id="bwHL" value="${c.hedgeLots}" min="1" max="50" step="1">
      <span class="lbl">Reverse lots</span><input class="num xs" type="number" id="bwRL" value="${c.revLots}" min="1" max="50" step="1">
      <button class="btn-sm" id="bwApply">Apply</button>
      <span class="muted small">Hedge and Reverse are traded as <b>one position</b>: all 8 legs are entered together, the target / stop is on the whole position, and each backtest trade (and its replay in the Builder) holds both. Apply backtests the combined variations again with these lots and capital.</span>
    </div>`;
  }
  async function applyCfg() {
    const cfg = { capital: $('bwCap').value === '' ? null : Number($('bwCap').value), hedgeLots: Number($('bwHL').value), revLots: Number($('bwRL').value) };
    $('bwApply').disabled = true;
    try {
      st = (
        await BT.runJob('/api/bt/bw/combine', { cfg }, (p) => {
          if ($('bwApply')) $('bwApply').textContent = p.total ? `${p.done}/${p.total}…` : '…';
        })
      ).result;
      if (runTag?.startsWith('combined')) run = runTag = null;
      sel.combined = null;
      note = '';
    } catch (e) {
      note = 'Could not backtest the combined position: ' + e.message;
    }
    render();
  }

  // ---------- details ----------
  async function renderDetails() {
    const req = { family: fam, key: curKey(fam) };
    const pane = $('bwPane');
    const tag = `${fam}|${req.key}`;
    if (runTag !== tag) {
      pane.innerHTML = '<div class="panel empty"><span class="muted">Loading the trades…</span></div>';
      try {
        const job = await BT.runJob('/api/bt/bw/detail', req);
        run = { ...job.result, jobId: job.id, req };
        runTag = tag;
      } catch (e) {
        if ($('bwPane') === pane) pane.innerHTML = `<div class="panel empty err"><b>Could not load it:</b> ${esc(e.message)}</div>`;
        return;
      }
      if (!$('bwPane') || tab !== 'details') return;
      if (`${fam}|${curKey(fam)}` !== tag) return renderDetails();
    }
    const r = run;
    const s = r.stats;
    const f = family(r.family);
    const row = rowOf(r.family, r.key);
    const head = `<div class="res-title scen-sel"><h3>${esc(f.name)} <span class="muted">›</span> ${esc(row.key === 'own' ? `As defined (${f.base})` : row.name)}</h3>
        ${row.key === f.best ? '<span class="cat-pill c-bullish">best</span>' : ''}${row.risky ? riskPill : ''}<span class="spacer"></span>
        ${row.key === f.best ? '' : `<button class="btn-sm ghost" data-var="${esc(f.best || 'own')}" title="Back to the best variation">◂ Best</button>`}
        <button class="btn-sm ghost" id="bwEdit" title="Open this variation in the Backtest screen's editor, to change it, test its scenarios, save or deploy it">Open in Backtest ▸</button></div>
      <span class="muted small">${esc(row.note)}</span>
      <span class="muted small">${esc(BT.timingLabel(r.strategy))} · ${esc(rulesText(r.strategy))}</span>
      <div class="res-legs">${BT.legChips(r.strategy)}</div>`;
    if (!s.trades) {
      pane.innerHTML = `<div class="panel res-head">${head}<div class="muted">No trades (${r.skippedCount} skipped).</div></div><div class="panel res-tabs-panel"><div class="res-tab">${skippedHtml()}</div></div>`;
      return;
    }
    pane.innerHTML = `<div class="panel res-head">${head}${kpis(s, capNote(f))}</div>
      <div class="panel res-tabs-panel">
        <div class="res-tabbar">
          <div class="seg" id="bwTabs"><button data-t="monthly">Monthly</button><button data-t="breakdown">Breakdown</button><button data-t="trades">Trades (${s.trades})</button><button data-t="skipped">Skipped (${r.skippedCount})</button></div>
          <span class="spacer"></span><button class="btn-sm ghost" id="bwCsv">Export CSV</button>
        </div>
        <div id="bwTab" class="res-tab"></div>
      </div>
      <div class="panel res-chart">
        <div class="chart-head"><h3>Equity curve</h3><span class="muted small">cumulative net P&amp;L after costs · bars = each trade · click a bar to open the trade</span></div>
        <div class="chart-box eq"><canvas id="bwEq"></canvas></div>
        <div class="chart-box dd"><canvas id="bwDD"></canvas></div>
      </div>`;
    drawEquity();
    renderTab();
  }

  const ofCap = (v) => (run?.stats?.capital ? pct((v / run.stats.capital) * 100) : '—');

  function drawEquity() {
    const s = run.stats;
    const labels = s.equity.map((e) => dayShort(e.d));
    const pnl = s.equity.map((e) => run.trades[e.i].net);
    BT.chart($('bwEq'), {
      data: {
        labels,
        datasets: [
          {
            type: 'line',
            label: 'Equity',
            data: s.equity.map((e) => e.eq),
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88,166,255,.10)',
            fill: 'origin',
            pointRadius: 0,
            borderWidth: 1.8,
            tension: 0.1,
            yAxisID: 'y',
          },
          {
            type: 'bar',
            label: 'Trade P&L',
            data: pnl,
            backgroundColor: pnl.map((v) => (v >= 0 ? 'rgba(63,182,139,.28)' : 'rgba(240,113,107,.28)')),
            yAxisID: 'y2',
            barPercentage: 1,
            categoryPercentage: 0.9,
            order: 2,
          },
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
        onClick: (_, els) => {
          if (els[0]) openTrade(s.equity[els[0].index].i);
        },
      },
    });
    BT.chart($('bwDD'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Drawdown',
            data: s.equity.map((e) => e.dd),
            borderColor: '#f0716b',
            backgroundColor: 'rgba(240,113,107,.18)',
            fill: 'origin',
            pointRadius: 0,
            borderWidth: 1.2,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (c) => `Drawdown ${inr(c.raw)}` } } },
        scales: { x: { display: false }, y: { ticks: { callback: (v) => kinr(v), maxTicksLimit: 3 } } },
      },
    });
  }

  function renderTab() {
    $('bwTabs')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.t === rTab));
    const el = $('bwTab');
    if (rTab === 'monthly') el.innerHTML = monthlyHtml();
    else if (rTab === 'breakdown') {
      el.innerHTML = breakdownHtml();
      drawHist();
    } else if (rTab === 'trades') el.innerHTML = tradesHtml();
    else el.innerHTML = skippedHtml();
  }

  function monthlyHtml() {
    const s = run.stats;
    const ys = Object.keys(s.yearly).sort();
    const vals = Object.values(s.monthly);
    const max = Math.max(1, ...vals.map(Math.abs));
    const cell = (v) => {
      if (v == null) return '<td class="muted">·</td>';
      const a = 0.12 + 0.5 * Math.min(1, Math.abs(v) / max);
      return `<td style="background:rgba(${v >= 0 ? '63,182,139' : '240,113,107'},${a.toFixed(2)})">${kinr(v)}<div class="cell-pct">${ofCap(v)}</div></td>`;
    };
    return `<div class="tbl-wrap"><table class="grid-tbl month-tbl">
      <thead><tr><th>Year</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${ys.map((y) => `<tr><th>${y}</th>${MONTHS.map((_, i) => cell(s.monthly[`${y}-${String(i + 1).padStart(2, '0')}`])).join('')}<td class="${cls(s.yearly[y])} b">${inrS(s.yearly[y])}<div class="cell-pct">${ofCap(s.yearly[y])}</div></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="muted small pad">Profitable months: <b>${vals.filter((v) => v > 0).length}</b> of ${vals.length}. Best month ${inrS(Math.max(...vals))} (${ofCap(Math.max(...vals))}), worst ${inrS(Math.min(...vals))} (${ofCap(Math.min(...vals))}). Percentages are of the investment, ${inr(s.capital)}.</div>`;
  }

  function bucketTable(title, obj, label) {
    const keys = Object.keys(obj)
      .map(Number)
      .sort((a, b) => a - b);
    const max = Math.max(1, ...keys.map((k) => Math.abs(obj[k].pnl)));
    return `<div class="bd-card"><h4>${title}</h4><table class="grid-tbl bd-tbl"><thead><tr><th></th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>% profit</th><th>Avg</th><th class="barcol"></th></tr></thead><tbody>
      ${keys
        .map((k) => {
          const b = obj[k];
          return `<tr><th>${label(k)}</th><td>${b.n}</td><td>${pct((b.wins / b.n) * 100, 0)}</td><td class="${cls(b.pnl)}">${inrS(b.pnl)}</td><td class="${cls(b.pnl)}">${ofCap(b.pnl)}</td><td class="${cls(b.pnl)}">${inrS(Math.round(b.pnl / b.n))}</td><td class="barcol"><div class="hbar ${b.pnl >= 0 ? 'p' : 'n'}" style="width:${((Math.abs(b.pnl) / max) * 100).toFixed(0)}%"></div></td></tr>`;
        })
        .join('')}
    </tbody></table></div>`;
  }
  function breakdownHtml() {
    const s = run.stats;
    const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]);
    const total = reasons.reduce((n, [, v]) => n + v, 0);
    // how each trade ended (the legs table counts every leg)
    const ends = {};
    for (const t of run.trades) {
      const b = (ends[t.reason] ||= { n: 0, pnl: 0, wins: 0 });
      b.n++;
      b.pnl += t.net;
      if (t.net > 0) b.wins++;
    }
    const endKeys = Object.keys(ends).sort((a, b) => ends[b].n - ends[a].n);
    return `<div class="bd-grid">
      <div class="bd-card"><h4>How the trades ended</h4><table class="grid-tbl bd-tbl"><thead><tr><th></th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody>
        ${endKeys
          .map((k) => {
            const b = ends[k];
            return `<tr><th>${REASON[k] || k}</th><td>${b.n}</td><td>${pct((b.wins / b.n) * 100, 0)}</td><td class="${cls(b.pnl)}">${inrS(Math.round(b.pnl))}</td><td class="${cls(b.pnl)}">${inrS(Math.round(b.pnl / b.n))}</td></tr>`;
          })
          .join('')}
      </tbody></table></div>
      ${bucketTable('By weekday (entry)', s.weekday, (k) => WD[k])}
      <div class="bd-card"><h4>How legs exited</h4><table class="grid-tbl bd-tbl"><tbody>
        ${reasons.map(([k, n]) => `<tr><th>${REASON[k] || k}</th><td>${n}</td><td>${pct((n / total) * 100, 0)}</td><td class="barcol"><div class="hbar" style="width:${((n / total) * 100).toFixed(0)}%"></div></td></tr>`).join('')}
      </tbody></table></div>
      <div class="bd-card wide"><h4>Distribution of trade P&amp;L</h4><div class="chart-box hist"><canvas id="bwHist"></canvas></div></div>
    </div>`;
  }
  function drawHist() {
    const net = run.trades.map((t) => t.net);
    const lo = Math.min(...net);
    const hi = Math.max(...net);
    const n = Math.min(30, Math.max(8, Math.round(Math.sqrt(net.length) * 2)));
    const w = (hi - lo) / n || 1;
    const bins = Array.from({ length: n }, (_, i) => ({ a: lo + i * w, c: 0 }));
    for (const v of net) bins[Math.min(n - 1, Math.floor((v - lo) / w))].c++;
    BT.chart($('bwHist'), {
      type: 'bar',
      data: {
        labels: bins.map((b) => kinr(b.a + w / 2)),
        datasets: [
          {
            data: bins.map((b) => b.c),
            backgroundColor: bins.map((b) => (b.a + w / 2 >= 0 ? 'rgba(63,182,139,.7)' : 'rgba(240,113,107,.7)')),
            barPercentage: 1,
            categoryPercentage: 0.95,
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (c) => `${kinr(bins[c[0].dataIndex].a)} to ${kinr(bins[c[0].dataIndex].a + w)}`, label: (c) => `${c.raw} trades` } },
        },
        scales: { x: { grid: { display: false } } },
      },
    });
  }

  function skippedHtml() {
    if (!run.skipped.length) return '<div class="muted pad">Nothing was skipped.</div>';
    return `<div class="muted small pad">Expiries that matched the timing but were not traded: the entry checks (net credit, covered risk, VIX) failed, a contract had no trades yet, or the previous trade was still open.</div>
      <div class="tbl-wrap trades-wrap"><table class="grid-tbl"><thead><tr><th>Date</th><th>Expiry</th><th class="l">Reason</th></tr></thead><tbody>
      ${run.skipped.map((x) => `<tr><td>${dayLabel(x.day)}</td><td>${dayLabel(x.ref)}</td><td class="l">${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function tradesHtml() {
    const T = run.trades;
    let idx = T.map((_, i) => i);
    if (tradeFilter === 'wins') idx = idx.filter((i) => T[i].net > 0);
    if (tradeFilter === 'losses') idx = idx.filter((i) => T[i].net < 0);
    if (tradeSort === 'best') idx.sort((a, b) => T[b].net - T[a].net);
    if (tradeSort === 'worst') idx.sort((a, b) => T[a].net - T[b].net);
    if (tradeSort === 'recent') idx.reverse();
    const legTxt = (x) =>
      `<span class="lx ${x.action === 'B' ? 'buy' : 'sell'}" title="${esc(`${x.action === 'B' ? 'Buy' : 'Sell'} ${x.qty} × ${x.strike} ${x.type} (${x.expiry}) · ${x.entryDay} ${x.entryTime} @ ${x.entryPx} → ${x.exitDay} ${x.exitTime} @ ${x.exitPx} · ${REASON[x.reason] || x.reason} · ${inrS(x.pnl)}`)}">${x.action}${x.re ? '↻' : ''}${x.rolled ? '⟳' : ''} ${x.strike}${x.type} ${x.entryPx}→${x.exitPx}${x.reason === 'sl' ? ' <b class="neg">SL</b>' : x.reason === 'tgt' ? ' <b class="pos">TG</b>' : x.reason === 'roll' ? ' <b class="muted">⟳</b>' : ''}</span>`;
    const filters = [
      ['all', 'All'],
      ['wins', 'Winners'],
      ['losses', 'Losers'],
    ];
    return `<div class="trade-tools">
        <div class="seg sm" id="bwFilter">${filters.map(([v, l]) => `<button data-f="${v}" class="${tradeFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select id="bwSort">${[
          ['date', 'Oldest first'],
          ['recent', 'Newest first'],
          ['best', 'Best first'],
          ['worst', 'Worst first'],
        ]
          .map(([v, l]) => `<option value="${v}" ${tradeSort === v ? 'selected' : ''}>${l}</option>`)
          .join('')}</select>
        <span class="muted small">Click a trade for its minute-by-minute P&amp;L; <b>▶ Replay</b> opens it in the Builder at its entry minute.</span>
      </div>
      <div class="tbl-wrap trades-wrap"><table class="grid-tbl trades-tbl">
        <thead><tr><th>#</th><th>Entry</th><th>Exit</th><th>Expiry</th><th>Nifty</th><th class="l">Legs (entry → exit)</th><th>Max profit</th><th>Max loss</th><th>Exit</th><th>Net P&amp;L</th><th title="Net P&amp;L as a share of the investment">% profit</th><th></th></tr></thead>
        <tbody>${idx
          .map((i) => {
            const t = T[i];
            return `<tr data-i="${i}"><td class="muted">${i + 1}</td>
            <td>${dayShort(t.entryDay)} <span class="muted">${WD[t.weekday]} ${t.entryTime}</span></td>
            <td>${t.exitDay !== t.entryDay ? dayShort(t.exitDay) + ' ' : ''}<span class="muted">${t.exitTime}</span></td><td>${dayShort(t.ref)}</td>
            <td>${Math.round(t.spotIn)} <span class="${cls(t.spotOut - t.spotIn)}">${t.spotOut != null ? (t.spotOut >= t.spotIn ? '+' : '') + Math.round(t.spotOut - t.spotIn) : ''}</span></td>
            <td class="l legs-cell">${t.legs.map(legTxt).join('')}</td>
            <td class="pos">${inr(t.maxProfit)}</td><td class="neg">${inr(t.maxLoss)}</td><td class="muted">${REASON[t.reason] || t.reason}</td>
            <td class="${cls(t.net)} b">${inrS(t.net)}</td><td class="${cls(t.net)}">${ofCap(t.net)}</td>
            <td class="replay-cell"><button class="btn-sm ghost" data-replay="${i}" title="Replay this trade in the Builder: same expiry, day, entry minute, strikes and fill prices">▶ Replay</button></td></tr>`;
          })
          .join('')}</tbody></table></div>`;
  }

  const replay = (i) => BTView.replay(run.trades[i], run.strategy, run.opts, i);
  async function openTrade(i) {
    const r = run;
    const get = () => BT.api(`/api/bt/trade?job=${r.jobId}&i=${i}`);
    let d;
    try {
      d = await get().catch(async () => {
        // the server no longer has that run (restarted, or many runs since): run it again
        r.jobId = (await BT.runJob('/api/bt/bw/detail', r.req)).id;
        return get();
      });
    } catch (e) {
      alert(e.message);
      return;
    }
    BTView.tradeModal(d.trade, d.path, i, r.stats.capital, () => replay(i));
  }

  function exportCsv() {
    const rows = [
      [
        'trade',
        'strategy',
        'entry_day',
        'entry_time',
        'exit_day',
        'exit_time',
        'expiry',
        'spot_in',
        'spot_out',
        'leg',
        'action',
        'strike',
        'type',
        'leg_expiry',
        'qty',
        'leg_entry',
        'entry_px',
        'leg_exit',
        'exit_px',
        'exit_reason',
        'leg_pnl',
        'leg_costs',
        'trade_net',
        'investment',
        'trade_pct_of_investment',
      ],
    ];
    const cap = run.stats.capital;
    run.trades.forEach((t, i) =>
      t.legs.forEach((x) =>
        rows.push([
          i + 1,
          `"${run.strategy.name.replace(/"/g, "'")}"`,
          t.entryDay,
          t.entryTime,
          t.exitDay,
          t.exitTime,
          t.ref,
          t.spotIn,
          t.spotOut,
          x.leg + 1,
          x.action,
          x.strike,
          x.type,
          x.expiry,
          x.qty,
          `${x.entryDay} ${x.entryTime}`,
          x.entryPx,
          `${x.exitDay} ${x.exitTime}`,
          x.exitPx,
          x.reason,
          x.pnl,
          x.cost,
          t.net,
          cap,
          cap ? ((t.net / cap) * 100).toFixed(2) : '',
        ]),
      ),
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
    a.download = `biweekly_${runTag.replace(/[^\w]+/g, '_')}_${run.stats.from}_${run.stats.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- events ----------
  $('bwMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fam]');
    if (!b || b.dataset.fam === fam) return;
    fam = b.dataset.fam;
    BT.store.set('bw-fam', fam);
    tab = 'summary';
    render();
  });
  $('bwResults').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.top) {
      tab = t.dataset.top;
      return render();
    }
    if (t.id === 'bwApply') return applyCfg();
    if (t.id === 'bwCsv') return exportCsv();
    if (t.id === 'bwEdit') return BT.emit('open-backtest', { strategy: BT.clone(run.strategy), run: false });
    if (t.dataset.t) {
      rTab = t.dataset.t;
      return renderTab();
    }
    if (t.dataset.f) {
      tradeFilter = t.dataset.f;
      return renderTab();
    }
    if (t.dataset.replay != null) return replay(Number(t.dataset.replay));
    const tr = t.closest('tr[data-i]');
    if (tr) return openTrade(Number(tr.dataset.i));
    const th = t.closest('th[data-k]');
    if (th) {
      const so = sort[fam];
      sort[fam] = th.dataset.k === so.k ? { k: so.k, dir: -so.dir } : { k: th.dataset.k, dir: -1 };
      return render();
    }
    const v = t.closest('[data-var]');
    if (v) {
      // a variation: open it in Details
      sel[fam] = v.dataset.var;
      tab = 'details';
      return render();
    }
  });
  $('bwStrikes').addEventListener('click', (e) => {
    if (e.target.dataset.sk) setStrikes(e.target.dataset.sk === 'pts' ? { by: 'pts', value: 100 } : null);
  });
  $('bwStrikes').addEventListener('change', (e) => {
    if (e.target.id === 'bwPts') setStrikes({ by: 'pts', value: Math.max(0, Number(e.target.value) || 0) });
    if (e.target.id === 'bwOverlap') {
      overlap = e.target.checked;
      BT.store.set('bw-overlap', overlap);
      renderStrikes();
    }
  });
  $('bwResults').addEventListener('change', (e) => {
    if (e.target.id === 'bwSort') {
      tradeSort = e.target.value;
      renderTab();
    }
  });

  // For the Backtest screen's Summary: the same top 5 of the hedge and of its reverse, from the same saved result.
  window.BWView = {
    load: loadState,
    topHtml() {
      if (!st) return '';
      const foot = `<div class="muted small pad">Backtested on the Bi-weekly screen with its own settings, not those in the bar above: ${dayLabel(st.opts.from)} → ${dayLabel(st.opts.to)} · capital ${st.opts.capital ? inr(st.opts.capital) : 'est. margin'} · ${strikeTxt(st.strikes)} · ${overlapTxt(st.overlap)} · backtested ${when(st.at)}.</div>`;
      return ['hedge', 'rev']
        .map((id) => topPanel(family(id), `${family(id).rows.length} variations backtested · click a row to open it on the Bi-weekly screen`, foot))
        .join('');
    },
    open(id, key) {
      // a variation in Details
      fam = id;
      BT.store.set('bw-fam', fam);
      sel[id] = key;
      tab = 'details';
      window.app.setView('bw');
      if (settings && settings !== true) render();
    },
  };

  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'bw') init();
  });
  if (window.app.state.view === 'bw') init();
})();
