// Strategies › Back spread: the back spread + 2 butterflies of Live › Ideas › Back spreads, backtested for every
// selection at once (bt/backspread.js). Pick the sides, the strike windows (every leg within ATM ± 5, 10, 15...), the
// widths allowed, the butterflies' form, how the best strikes are ranked, the entry days and the size; each side ×
// window × entry day is one row. At every past entry the engine picks the best strikes inside the window from that
// minute's prices (lib/backspread.js, the picker Live › Ideas uses), so a row's trades can differ in width and centre.
// Click a row for its equity curve and every trade with the strikes picked. Results are not saved.
(() => {
  const { $, esc, inrS, kinr, dayShort } = BT;
  const BS = window.BackSpread;
  const DTES = [0, 1, 2, 3, 4];
  const DEF = { sides: ['PE', 'CE'], wins: [5, 10, 15, 20], widths: [100, 200, 300, 400], dtes: [2], form: 'same', rank: 'loss', units: 1, sl: 0 };
  let sel = { ...DEF, ...BT.store.get('bs-sel', {}) };
  let settings = null;
  let res = null; // { at, sel, opts, rows, stopped }
  let cur = null; // key of the row shown below the table
  let note = '';
  let sort = { k: 'total', dir: -1 };
  const ctl = {};
  const saveSel = () => BT.store.set('bs-sel', sel);
  const sideName = (s) => (s === 'PE' ? 'Put (bearish)' : 'Call (bullish)');

  async function init() {
    if (settings) return;
    settings = true;
    try {
      await BT.loadMeta();
    } catch (e) {
      settings = null;
      $('bsResults').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      return;
    }
    // First visit: the whole history, on ₹5 L.
    const c = BT.meta.calendar;
    if (c?.expired?.length && !BT.store.get('bs-settings', null)) {
      const first = new Date(Date.parse(c.expired[0] + 'T00:00:00Z') - 7 * 86400_000).toISOString().slice(0, 10);
      BT.store.set('bs-settings', { from: first, to: c.expired[c.expired.length - 1], capital: 500000 });
    }
    settings = BT.createSettings($('bsSettings'), {
      onRun: run,
      runLabel: 'Backtest selection',
      key: 'bs-settings',
      onStop: () => (ctl.stop = true),
    });
    renderSel();
    render();
  }

  // ---------- selection ----------
  const toggle = (list, v) => (list.includes(v) ? (list.length > 1 ? list.filter((x) => x !== v) : list) : [...list, v]);
  function chips(attr, items, on, multi = true) {
    return `<span class="seg sm">${items
      .map(([v, l, tip]) => `<button data-${attr}="${v}" class="${(multi ? on.includes(v) : on === v) ? 'on' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${l}</button>`)
      .join('')}</span>`;
  }
  function renderSel() {
    const n = sel.sides.length * sel.wins.length * sel.dtes.length;
    $('bsSel').innerHTML = `
      <div class="bs-row"><span class="lbl" title="Put = bearish (the back spread gains on a fall), call = bullish">Side</span>${chips(
        'side',
        [
          ['PE', 'Put (bearish)'],
          ['CE', 'Call (bullish)'],
        ],
        sel.sides,
      )}</div>
      <div class="bs-row"><span class="lbl" title="Every leg's strike must lie within this many strikes of the ATM strike at entry. Pick several to compare them.">Strikes within</span>${chips(
        'win',
        BS.WINDOWS.map((w) => [w, `ATM ±${w}`]),
        sel.wins,
      )}</div>
      <div class="bs-row"><span class="lbl" title="Back spread widths the picker may use (butterfly wings sit 1.5× the width either side of the centre)">Widths</span>${chips(
        'width',
        BS.WIDTHS.map((w) => [w, `${w} pts`]),
        sel.widths,
      )}</div>
      <div class="bs-row"><span class="lbl" title="Trading days before the weekly expiry to enter (09:20); every trade is held to expiry (15:20)">Enter</span>${chips(
        'dte',
        DTES.map((d) => [d, d === 0 ? 'Expiry day' : `${d}d before`]),
        sel.dtes,
      )}</div>
      <div class="bs-row"><span class="lbl" title="Both forms pay the same at expiry. Single-type butterflies trade only puts (or only calls), with no deep in-the-money option: lower slippage and STT.">Butterflies</span>${chips(
        'form',
        [
          ['same', 'All puts / all calls'],
          ['iron', 'Iron'],
        ],
        sel.form,
        false,
      )}
        <span class="lbl" title="How the picker chooses the strikes at each entry">Best strikes by</span>${chips(
          'rank',
          Object.entries(BS.RANKS).map(([k, [l, tip]]) => [k, l, tip]),
          sel.rank,
          false,
        )}</div>
      <div class="bs-row"><label class="lbl" title="Units of the whole structure per trade: 1 = sell 1 / buy 2 back spread + 2 butterflies (11 lots of options for single-type butterflies)">Units <input class="num xs" type="number" min="1" max="20" step="1" id="bsUnits" value="${sel.units}"></label>
        <label class="lbl" title="Stop on the whole position's loss, as % of the capital in the settings bar (0 = none, held to expiry)">Stop at <input class="num xs" type="number" min="0" max="50" step="0.5" id="bsSl" value="${sel.sl}"> % of capital</label>
        <span class="muted small">${n} backtest${n === 1 ? '' : 's'} (side × window × entry day)</span></div>`;
  }
  $('bsSel').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.side) sel.sides = toggle(sel.sides, d.side);
    else if (d.win) sel.wins = toggle(sel.wins, Number(d.win)).sort((a, b) => a - b);
    else if (d.width) sel.widths = toggle(sel.widths, Number(d.width)).sort((a, b) => a - b);
    else if (d.dte) sel.dtes = toggle(sel.dtes, Number(d.dte)).sort((a, b) => a - b);
    else if (d.form) sel.form = d.form;
    else if (d.rank) sel.rank = d.rank;
    else return;
    saveSel();
    renderSel();
  });
  $('bsSel').addEventListener('change', (e) => {
    if (e.target.id === 'bsUnits') sel.units = Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 1));
    else if (e.target.id === 'bsSl') sel.sl = Math.max(0, Math.min(50, Number(e.target.value) || 0));
    else return;
    saveSel();
    renderSel();
  });

  async function run() {
    let opts;
    try {
      opts = settings.get();
    } catch (e) {
      return alert(e.message);
    }
    ctl.stop = false;
    ctl.sent = false;
    settings.setBusy(true);
    try {
      res = (await BT.runJob('/api/bt/bs/run', { opts, sel }, settings.progress, ctl)).result;
      cur = null;
      note = '';
    } catch (e) {
      note = 'Backtest failed: ' + e.message;
    } finally {
      settings.setBusy(false);
    }
    render();
  }

  // ---------- results ----------
  const COLS = [
    ['name', 'Selection', 'l'],
    ['n', 'Trades', '', (r) => r.trades.length],
    ['total', 'Net P&L', '', (r) => r.stats.total],
    ['winRate', 'Win %', '', (r) => r.stats.winRate],
    ['maxLoss', 'Worst trade', '', (r) => r.stats.maxLoss],
    ['maxDD', 'Max drawdown', '', (r) => r.stats.maxDD],
    ['pf', 'Profit factor', '', (r) => r.stats.profitFactor ?? 0],
    ['margin', 'Margin (median)', '', (r) => median(r.trades.map((t) => t.margin || 0))],
  ];
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
  const years = () => [...new Set(res.rows.flatMap((r) => Object.keys(r.yearly || {})))].sort();
  const pn = (v) => `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${inrS(Math.round(v))}</span>`;
  function render() {
    const el = $('bsResults');
    if (!res) {
      el.innerHTML = `${note ? `<div class="panel empty err">${esc(note)}</div>` : ''}<div class="panel empty">
        <p>Pick the sides, strike windows and entry days above, then <b>Backtest selection</b>.</p>
        <p class="muted">At every past entry the best back spread + 2 butterflies with every leg within ATM ± the window is picked from that minute's prices (the same picker as Live › Ideas › Back spreads), held to expiry, with the slippage and charges in the settings bar. Realistic fills: only options that really traded in the 15 minutes before entry are picked, and every fill pays at least one tick (₹0.05) of slippage.</p></div>`;
      return;
    }
    const ok = res.rows.filter((r) => !r.error);
    const fk = COLS.find((c) => c[0] === sort.k)?.[3];
    const rows = fk ? ok.slice().sort((a, b) => (fk(a) - fk(b)) * sort.dir) : ok;
    const ys = years();
    if (!cur || !ok.some((r) => r.key === cur)) cur = rows[0]?.key || null;
    const head = `<tr>${COLS.map(([k, t, c, f]) => `<th class="${c}">${f ? `<button class="id-sort ${sort.k === k ? 'on' : ''}" data-sort="${k}">${t}${sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>` : t}</th>`).join('')}${ys.map((y) => `<th>${y}</th>`).join('')}</tr>`;
    const body = rows
      .map((r) => {
        const s = r.stats;
        return `<tr data-row="${esc(r.key)}" class="${r.key === cur ? 'sel' : ''}">
          <td class="l"><b>${sideName(r.side)}</b> · ATM ±${r.win} · ${r.dte === 0 ? 'expiry day' : `${r.dte}d before`}</td>
          <td>${r.trades.length}${r.skipped ? ` <span class="muted small" title="${esc(r.skipReasons.join('\n'))}">(${r.skipped} skipped)</span>` : ''}</td>
          <td><b>${pn(s.total)}</b></td><td>${(s.winRate ?? 0).toFixed(0)}%</td><td>${pn(s.maxLoss)}</td><td>${pn(s.maxDD)}</td>
          <td>${s.profitFactor == null ? '—' : s.profitFactor.toFixed(2)}</td><td>${BT.inr(median(r.trades.map((t) => t.margin || 0)))}</td>
          ${ys.map((y) => `<td>${r.yearly?.[y] == null ? '—' : pn(r.yearly[y])}</td>`).join('')}</tr>`;
      })
      .join('');
    const errs = res.rows.filter((r) => r.error);
    const o = res.opts || {};
    el.innerHTML = `
      ${note ? `<div class="panel empty err">${esc(note)}</div>` : ''}
      <div class="panel bs-sum">
        <div class="bs-sum-head"><b>${ok.length} backtest${ok.length === 1 ? '' : 's'}</b>
          <span class="muted small">${esc(o.from || '')} → ${esc(o.to || '')} · ${res.sel.units} unit${res.sel.units === 1 ? '' : 's'} · ${res.sel.form === 'iron' ? 'iron butterflies' : 'single-type butterflies'} · widths ${res.sel.widths.join(' / ')} · best strikes by ${BS.RANKS[res.sel.rank][0].toLowerCase()} · ${res.sel.sl ? `stop ${res.sel.sl}% of capital` : 'held to expiry'} · slippage ${((o.slippage || 0) * 100).toFixed(2)}%, at least ₹${(o.minSlip || 0).toFixed(2)} a fill · only options traded in the 15 min before entry${res.stopped ? ' · <b>stopped early</b>' : ''}</span></div>
        <div class="tbl-wrap"><table class="grid-tbl bs-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>
        ${errs.length ? `<div class="muted small">Not run: ${errs.map((r) => `${sideName(r.side)} ±${r.win} ${r.dte}d (${esc(r.error)})`).join('; ')}</div>` : ''}
        <div class="muted small">Click a row for its equity curve and every trade with the strikes picked. Each row is the best of its own picks; picking the best row afterwards is a choice made with hindsight: expect less going forward.</div>
      </div>
      <div id="bsDetail"></div>`;
    renderDetail();
  }
  function renderDetail() {
    const r = res?.rows.find((x) => x.key === cur);
    const el = $('bsDetail');
    if (!r || !el) return;
    const ws = {};
    for (const t of r.trades) ws[t.W] = (ws[t.W] || 0) + 1;
    const offs = r.trades.map((t) => t.off).filter((x) => x != null);
    el.innerHTML = `<div class="panel bs-detail">
      <div class="bs-sum-head"><b>${sideName(r.side)} · ATM ±${r.win} · ${r.dte === 0 ? 'expiry day' : `${r.dte}d before expiry`}</b>
        <span class="muted small">widths picked: ${Object.entries(ws)
          .map(([w, n]) => `${w} pts × ${n}`)
          .join(', ')} · centre ${offs.length ? `${Math.round(median(offs))} pts from Nifty (median)` : '—'}</span></div>
      <div class="bs-eq"><canvas id="bsEq"></canvas></div>
      <div class="tbl-wrap bs-trades"><table class="grid-tbl"><thead><tr><th class="l">Entry</th><th class="l">Exit</th><th>Nifty in → out</th><th>Width</th><th class="l">Butterflies (low / centre / high)</th><th class="l">Back spread (sell / buy 2)</th><th>Centre from Nifty</th><th>Margin</th><th>Net P&amp;L</th><th class="l">Exit</th></tr></thead>
      <tbody>${r.trades
        .slice()
        .reverse()
        .map(
          (t) =>
            `<tr><td class="l">${dayShort(t.in)}</td><td class="l">${dayShort(t.out)}</td><td>${Math.round(t.spotIn)} → ${t.spotOut == null ? '—' : Math.round(t.spotOut)}</td><td>${t.W}</td><td class="l">${t.lo} / ${t.m} / ${t.hi}</td><td class="l">${t.k1} / ${t.k2}</td><td>${t.off == null ? '—' : Math.round(t.off)}</td><td>${t.margin ? BT.inr(t.margin) : '—'}</td><td><b>${pn(t.net)}</b></td><td class="l muted small">${esc(BT.REASON?.[t.reason] || t.reason || '')}</td></tr>`,
        )
        .join('')}</tbody></table></div></div>`;
    BT.chart($('bsEq'), {
      data: {
        labels: r.equity.map((e) => dayShort(e[0])),
        datasets: [
          {
            type: 'line',
            label: 'Equity',
            data: r.equity.map((e) => e[1]),
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88,166,255,.10)',
            fill: 'origin',
            pointRadius: 0,
            borderWidth: 1.8,
            tension: 0.1,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Equity: ${inrS(c.raw)}` } } },
        scales: { x: { ticks: { maxTicksLimit: 12, autoSkip: true }, grid: { display: false } }, y: { ticks: { callback: (v) => kinr(v) } } },
      },
    });
  }
  $('bsResults').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort;
      sort = sort.k === k ? { k, dir: -sort.dir } : { k, dir: -1 };
      return render();
    }
    const tr = e.target.closest('tr[data-row]');
    if (tr) {
      cur = tr.dataset.row;
      $('bsResults')
        .querySelectorAll('tr[data-row]')
        .forEach((x) => x.classList.toggle('sel', x.dataset.row === cur));
      renderDetail();
    }
  });

  // Live › Ideas › Back spreads: "Backtest ATM ±n ▸" opens this screen with that window picked.
  BT.on('bs-preset', (p) => {
    if (p.wins) sel.wins = p.wins;
    if (p.rank && BS.RANKS[p.rank]) sel.rank = p.rank;
    saveSel();
    if (settings && settings !== true) renderSel();
  });
  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'bs') init();
  });
  if (window.app.state.view === 'bs') init();
})();
