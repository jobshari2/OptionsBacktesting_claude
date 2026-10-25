// Strategies › Back spread: the back spread + 2 butterflies of Live › Ideas › Back spreads, backtested for every
// selection at once (bt/backspread.js). Pick the sides, the strike windows (every leg within ATM ± 5, 10, 15...), the
// widths allowed, the butterfly forms (butterfly = all puts / all calls, iron fly = CE and PE strikes; pick both to
// compare), how the best strikes are ranked, the expiry cycle (weekly / monthly), the entries (the start of the
// expiry's series, or n days before expiry) and the size; each expiry × form × side × window × entry is one row. At every past entry the engine picks the best strikes inside the window from that
// minute's prices (lib/backspread.js, the picker Live › Ideas uses), so a row's trades can differ in width and centre.
// Click a row for its equity curve and every trade with the strikes picked; ▶ Builder / ▶ Replay open a trade in the
// Builder's historical replay (BTView.replay). The last result is saved on the server (bt-data/backspread.json) and
// shown again when the screen opens.
(() => {
  const { $, esc, inrS, kinr, dayShort } = BT;
  const BS = window.BackSpread;
  // entries: the start of the expiry's series, or trading days before expiry (5 or more: monthly only, see bt/backspread.js)
  const ENTRIES = ['start', 0, 1, 2, 3, 4, 5, 10, 15];
  const WEEKLY_MAX_DTE = 4;
  const entryName = (d, long) => (d === 'start' ? 'expiry start' : d === 0 ? 'expiry day' : `${d}d before${long ? ' expiry' : ''}`);
  const runs = () =>
    sel.forms.length *
    sel.sides.length *
    sel.wins.length *
    sel.expiries.reduce((n, e) => n + sel.dtes.filter((d) => e === 'monthly' || d === 'start' || d <= WEEKLY_MAX_DTE).length, 0);
  const DEF = {
    sides: ['PE', 'CE'],
    wins: [5, 10, 15, 20],
    widths: [100, 200, 300, 400],
    dtes: [2],
    expiries: ['weekly'],
    forms: ['same'],
    rank: 'loss',
    units: 1,
    sl: 0,
    maxLoss: 0,
  };
  let sel = { ...DEF, ...BT.store.get('bs-sel', {}) };
  if (!Array.isArray(sel.forms) || !sel.forms.length) sel.forms = [sel.form === 'iron' ? 'iron' : 'same']; // saved before forms
  if (!Array.isArray(sel.expiries) || !sel.expiries.length) sel.expiries = ['weekly'];
  delete sel.form;
  const FORM_NAME = { same: 'Butterfly', iron: 'Iron fly' };
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
    // the last backtest, saved on the server: shown without running anything
    try {
      const st = (await BT.api('/api/bt/bs/state')).state;
      if (st?.rows?.length && !res) {
        res = st;
        render();
      }
    } catch {
      /* nothing saved, or the server is older: the empty screen stays */
    }
  }

  // ---------- selection ----------
  const toggle = (list, v) => (list.includes(v) ? (list.length > 1 ? list.filter((x) => x !== v) : list) : [...list, v]);
  function chips(attr, items, on, multi = true) {
    return `<span class="seg sm">${items
      .map(
        ([v, l, tip]) =>
          `<button data-${attr}="${v}" class="${(multi ? on.includes(v) : on === v) ? 'on' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${l}</button>`,
      )
      .join('')}</span>`;
  }
  function renderSel() {
    const n = runs();
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
      <div class="bs-row"><span class="lbl" title="Weekly: the nearest weekly expiry. Monthly: the current monthly expiry. Pick both to compare.">Expiry</span>${chips(
        'exp',
        [
          ['weekly', 'Weekly'],
          ['monthly', 'Monthly'],
        ],
        sel.expiries,
      )}</div>
      <div class="bs-row"><span class="lbl" title="When to enter (09:20); every trade is held to its expiry (15:20). Expiry start: the first trading day of the series, the day after the previous weekly (or monthly) expiry. 5d and more: monthly only, a weekly series is about 5 trading days long.">Enter</span>${chips(
        'dte',
        ENTRIES.map((d) => [
          d,
          d === 'start' ? 'Expiry start' : d === 0 ? 'Expiry day' : `${d}d before`,
          d !== 'start' && d > WEEKLY_MAX_DTE ? 'Monthly only' : '',
        ]),
        sel.dtes,
      )}</div>
      <div class="bs-row"><span class="lbl" title="Butterfly: all puts (put side) or all calls (call side), no deep in-the-money option. Iron fly: a straddle sold at the centre with a put and a call bought as wings (CE and PE strikes). Both pay the same at expiry; pick both to compare them, each its own row.">Butterflies</span>${chips(
        'form',
        [
          ['same', 'Butterfly (all PE / all CE)'],
          ['iron', 'Iron fly (CE + PE)'],
        ],
        sel.forms,
      )}
        <span class="lbl" title="How the picker chooses the strikes at each entry">Best strikes by</span>${chips(
          'rank',
          Object.entries(BS.RANKS).map(([k, [l, tip]]) => [k, l, tip]),
          sel.rank,
          false,
        )}</div>
      <div class="bs-row"><label class="lbl" title="Units of the whole structure per trade: 1 = sell 1 / buy 2 back spread + 2 butterflies (11 lots of options for single-type butterflies)">Units <input class="num xs" type="number" min="1" max="20" step="1" id="bsUnits" value="${sel.units}"></label>
        <label class="lbl" title="Stop on the whole position's loss, as % of the capital in the settings bar (0 = none, held to expiry)">Stop at <input class="num xs" type="number" min="0" max="50" step="0.5" id="bsSl" value="${sel.sl}"> % of capital</label>
        <label class="lbl" title="At each entry only strikes whose worst case at expiry (slippage and brokerage included) loses at most this much for the whole trade (all units) are picked; when none fits, that entry is skipped. 0 = any.">Max loss ₹ <input class="num" type="number" min="0" step="500" id="bsMaxLoss" value="${sel.maxLoss || 0}"> a trade</label>
        <span class="muted small">${n} backtest${n === 1 ? '' : 's'} (expiry × form × side × window × entry)</span></div>`;
  }
  $('bsSel').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.side) sel.sides = toggle(sel.sides, d.side);
    else if (d.win) sel.wins = toggle(sel.wins, Number(d.win)).sort((a, b) => a - b);
    else if (d.width) sel.widths = toggle(sel.widths, Number(d.width)).sort((a, b) => a - b);
    else if (d.dte) sel.dtes = toggle(sel.dtes, d.dte === 'start' ? 'start' : Number(d.dte)).sort((a, b) => ENTRIES.indexOf(a) - ENTRIES.indexOf(b));
    else if (d.exp) sel.expiries = toggle(sel.expiries, d.exp);
    else if (d.form) sel.forms = toggle(sel.forms, d.form);
    else if (d.rank) sel.rank = d.rank;
    else return;
    saveSel();
    renderSel();
  });
  $('bsSel').addEventListener('change', (e) => {
    if (e.target.id === 'bsUnits') sel.units = Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 1));
    else if (e.target.id === 'bsSl') sel.sl = Math.max(0, Math.min(50, Number(e.target.value) || 0));
    else if (e.target.id === 'bsMaxLoss') sel.maxLoss = Math.max(0, Math.round(Number(e.target.value) || 0));
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
    hideTip();
    const el = $('bsResults');
    if (!res) {
      el.innerHTML = `${note ? `<div class="panel empty err">${esc(note)}</div>` : ''}<div class="panel empty">
        <p>Pick the sides, strike windows and entry days above, then <b>Backtest selection</b>. The result is saved and shown here next time without running anything.</p>
        <p class="muted">At every past entry the best back spread + 2 butterflies with every leg within ATM ± the window is picked from that minute's prices (the same picker as Live › Ideas › Back spreads), held to expiry, with the slippage and charges in the settings bar. Realistic fills: only options that really traded in the 15 minutes before entry are picked, and every fill pays at least one tick (₹0.05) of slippage.</p></div>`;
      return;
    }
    const ok = res.rows.filter((r) => !r.error);
    const fk = COLS.find((c) => c[0] === sort.k)?.[3];
    const rows = fk ? ok.slice().sort((a, b) => (fk(a) - fk(b)) * sort.dir) : ok;
    const ys = years();
    if (!cur || !ok.some((r) => r.key === cur)) cur = rows[0]?.key || null;
    const head = `<tr>${COLS.map(([k, t, c, f]) => `<th class="${c}">${f ? `<button class="id-sort ${sort.k === k ? 'on' : ''}" data-sort="${k}">${t}${sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>` : t}</th>${k === 'name' ? '<th></th>' : ''}`).join('')}${ys.map((y) => `<th>${y}</th>`).join('')}</tr>`;
    const body = rows
      .map((r) => {
        const s = r.stats;
        return `<tr data-row="${esc(r.key)}" class="${r.key === cur ? 'sel' : ''}">
          <td class="l"><b>${sideName(r.side)}</b> · ${FORM_NAME[r.form] || ''} · ATM ±${r.win} · ${r.expiry || 'weekly'} · ${entryName(r.dte)}</td>
          <td class="nowrap">${r.trades.length && r.trades.at(-1).legs ? `<button class="btn-sm ghost" data-rp="${esc(r.key)}|${r.trades.length - 1}" title="Open this selection's latest trade (${dayShort(r.trades.at(-1).in)}) in the Builder at its entry minute: same expiry, strikes and fill prices, to step through it and try adjustments. Every trade has its own ▶ Replay in the list below.">▶ Builder</button>` : ''}</td>
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
          <span class="muted small">${esc(o.from || '')} → ${esc(o.to || '')} · ${res.sel.units} unit${res.sel.units === 1 ? '' : 's'} · ${(res.sel.forms || []).map((x) => FORM_NAME[x].toLowerCase()).join(' + ')} · widths ${res.sel.widths.join(' / ')} · best strikes by ${BS.RANKS[res.sel.rank][0].toLowerCase()} · ${res.sel.sl ? `stop ${res.sel.sl}% of capital` : 'held to expiry'}${res.sel.maxLoss ? ` · <b>max loss ${BT.inr(res.sel.maxLoss)} a trade</b> at entry` : ''} · slippage ${((o.slippage || 0) * 100).toFixed(2)}%, at least ₹${(o.minSlip || 0).toFixed(2)} a fill · only options traded in the 15 min before entry${res.stopped ? ' · <b>stopped early</b>' : ''}${res.at ? ` · run ${new Date(res.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}, saved` : ''}</span></div>
        <div class="tbl-wrap"><table class="grid-tbl bs-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>
        ${errs.length ? `<div class="muted small">Not run: ${errs.map((r) => `${sideName(r.side)} ${FORM_NAME[r.form] || ''} ±${r.win} ${r.expiry} ${entryName(r.dte)} (${esc(r.error)})`).join('; ')}</div>` : ''}
        <div class="muted small">Click a row for its equity curve and every trade with the strikes picked; <b>▶ Builder</b> opens a row's latest trade (<b>▶ Replay</b>: any trade) in the Builder at its entry minute to step through it and try adjustments. Hover over a row or a trade for its payoff at expiry. Each row is the best of its own picks; picking the best row afterwards is a choice made with hindsight: expect less going forward.</div>
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
      <div class="bs-sum-head"><b>${sideName(r.side)} · ${FORM_NAME[r.form] || ''} · ATM ±${r.win} · ${r.expiry || 'weekly'} · ${entryName(r.dte, true)}</b>
        <span class="muted small">widths picked: ${Object.entries(ws)
          .map(([w, n]) => `${w} pts × ${n}`)
          .join(', ')} · centre ${offs.length ? `${Math.round(median(offs))} pts from Nifty (median)` : '—'}</span></div>
      <div class="bs-eq"><canvas id="bsEq"></canvas></div>
      <div class="tbl-wrap bs-trades"><table class="grid-tbl"><thead><tr><th class="l">Entry</th><th class="l">Exit</th><th>Nifty in → out</th><th>Width</th><th class="l">Butterflies (low / centre / high)</th><th class="l">Back spread (sell / buy 2)</th><th>Centre from Nifty</th><th>Margin</th><th>Net P&amp;L</th><th class="l">Exit</th><th></th></tr></thead>
      <tbody>${r.trades
        .map((t, i) => [t, i])
        .reverse()
        .map(
          ([t, i]) =>
            `<tr data-tr="${esc(r.key)}|${i}"><td class="l">${dayShort(t.in)}</td><td class="l">${dayShort(t.out)}</td><td>${Math.round(t.spotIn)} → ${t.spotOut == null ? '—' : Math.round(t.spotOut)}</td><td>${t.W}</td><td class="l">${t.lo} / ${t.m} / ${t.hi}</td><td class="l">${t.k1} / ${t.k2}</td><td>${t.off == null ? '—' : Math.round(t.off)}</td><td>${t.margin ? BT.inr(t.margin) : '—'}</td><td><b>${pn(t.net)}</b></td><td class="l muted small">${esc(BT.REASON?.[t.reason] || t.reason || '')}</td><td class="replay-cell">${t.legs ? `<button class="btn-sm ghost" data-rp="${esc(r.key)}|${i}" title="Replay this trade in the Builder: same expiry, day, entry minute, strikes and fill prices">▶ Replay</button>` : ''}</td></tr>`,
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
  // A trade in the Builder's historical replay at its entry minute, the Backtest screen's ▶ Replay (bt-view.js): the
  // legs at their backtest fills, the backtest's lot size and costs, and its stop / expiry exit repeated on the way.
  function replay(key, i) {
    const r = res?.rows.find((x) => x.key === key);
    const t = r?.trades[i];
    if (!t?.legs) return;
    hideTip();
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this replay?')) return;
    window.BTView.replay(t, r.strategy, res.opts || {}, i);
  }
  // ---------- payoff on hover ----------
  // The trade's payoff at expiry (₹, whole position, before costs): its legs at their entry fills (slippage included),
  // with Nifty at entry and at expiry marked. A trade line shows its trade, a result row its latest trade.
  const tip = document.createElement('div');
  tip.className = 'bs-pay hidden';
  document.body.appendChild(tip);
  function payoffOf(t) {
    const seen = new Set();
    const legs = t.legs.filter((x) => !x.re && !x.rolled && x.entryDay === t.entryDay && x.entryTime === t.entryTime && !seen.has(x.leg) && seen.add(x.leg));
    const dir = (x) => (x.action === 'B' ? 1 : -1);
    const pl = (S) => legs.reduce((a, x) => a + dir(x) * x.qty * (Math.max(0, x.type === 'CE' ? S - x.strike : x.strike - S) - x.entryFill), 0);
    const ks = [...new Set(legs.map((x) => x.strike))].sort((a, b) => a - b);
    const marks = [t.spotIn, t.spotOut].filter((x) => x != null);
    // the strikes with room either side, stretched to Nifty at entry / expiry but at most 2 pads past the strikes
    // (a Nifty further away is drawn at the edge with an arrow, so the structure stays readable)
    const pad = Math.max(1.5 * (t.W || 100), 0.5 * (ks.at(-1) - ks[0]));
    const x0 = Math.max(ks[0] - 2 * pad, Math.min(ks[0] - pad, ...marks.map((x) => x - 0.25 * pad)));
    const x1 = Math.min(ks.at(-1) + 2 * pad, Math.max(ks.at(-1) + pad, ...marks.map((x) => x + 0.25 * pad)));
    const pts = [x0, ...ks, x1].map((x) => [x, pl(x)]); // the payoff is straight between strikes: exact
    const bes = [];
    for (let j = 1; j < pts.length; j++) {
      const [a, pa] = pts[j - 1];
      const [b, pb] = pts[j];
      if ((pa < 0 && pb >= 0) || (pa >= 0 && pb < 0)) bes.push(Math.round(a + ((b - a) * -pa) / (pb - pa)));
    }
    // beyond the strikes: puts set the slope below, calls above (> 0 = P&L keeps growing that way)
    const down = legs.filter((x) => x.type === 'PE').reduce((a, x) => a + dir(x) * x.qty, 0);
    const up = legs.filter((x) => x.type === 'CE').reduce((a, x) => a + dir(x) * x.qty, 0);
    const vals = pts.map((p) => p[1]);
    return {
      legs,
      pl,
      pts,
      bes,
      maxP: Math.max(...vals),
      maxL: Math.min(...vals),
      up,
      down,
      prem: legs.reduce((a, x) => a + dir(x) * x.qty * x.entryFill, 0),
    };
  }
  function payoffHtml(t, label) {
    const P = payoffOf(t);
    const W = 380;
    const H = 170;
    const m = { l: 48, r: 8, t: 8, b: 20 };
    // the usual range zoomed by tipZoom (Ctrl + scroll over the row) around its middle; y fits what is drawn. The
    // figures below the chart stay those of the usual range.
    const c0 = (P.pts[0][0] + P.pts.at(-1)[0]) / 2;
    const hw = ((P.pts.at(-1)[0] - P.pts[0][0]) * tipZoom) / 2;
    const [x0, x1] = [c0 - hw, c0 + hw];
    const ks = [...new Set(P.legs.map((x) => x.strike))].filter((k) => k > x0 && k < x1);
    const pts = [x0, ...ks.sort((a, b) => a - b), x1].map((x) => [x, P.pl(x)]);
    const yMax = Math.max(0, ...pts.map((p) => p[1]));
    const yMin = Math.min(0, ...pts.map((p) => p[1]));
    const yp = (yMax - yMin) * 0.12 || 1;
    const X = (x) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (y) => m.t + ((yMax + yp - y) / (yMax - yMin + 2 * yp)) * (H - m.t - m.b);
    const line = pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const area = `${X(x0).toFixed(1)},${Y(0).toFixed(1)} ${line} ${X(x1).toFixed(1)},${Y(0).toFixed(1)}`;
    // labels closer than min px to one already placed are left out (the first ones win)
    const spaced = (vs, pos, min) => {
      const out = [];
      for (const v of vs) if (!out.some((u) => Math.abs(pos(u) - pos(v)) < min)) out.push(v);
      return out;
    };
    const lab = spaced(
      [t.lo, t.m, t.hi].filter((k) => k != null && k > x0 && k < x1),
      X,
      40,
    );
    const atExpiry = t.spotOut != null && t.out === t.ref;
    const inView = (x) => x >= x0 && x <= x1;
    // a vertical marker; outside the range it sits on the edge with an arrow. Its label flips left near the right edge.
    const vline = (x, cls, txt, row) => {
      const px = X(Math.max(x0, Math.min(x1, x)));
      const text = x < x0 ? `◀ ${txt}` : x > x1 ? `${txt} ▶` : txt;
      const right = px > W - 90;
      return `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${m.t}" y2="${H - m.b}" class="${cls}"/><text x="${(px + (right ? -3 : 3)).toFixed(1)}" y="${m.t + 9 + row * 11}" text-anchor="${right ? 'end' : 'start'}" class="bs-pay-lbl ${cls}">${text}</text>`;
    };
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <defs><clipPath id="bsPayUp"><rect x="0" y="0" width="${W}" height="${Y(0).toFixed(1)}"/></clipPath><clipPath id="bsPayDn"><rect x="0" y="${Y(0).toFixed(1)}" width="${W}" height="${H}"/></clipPath></defs>
      <polygon points="${area}" class="bs-pay-up" clip-path="url(#bsPayUp)"/><polygon points="${area}" class="bs-pay-dn" clip-path="url(#bsPayDn)"/>
      <line x1="${m.l}" x2="${W - m.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="bs-pay-zero"/>
      ${ks.map((k) => `<line x1="${X(k).toFixed(1)}" x2="${X(k).toFixed(1)}" y1="${H - m.b}" y2="${H - m.b + 4}" class="bs-pay-tick"/>`).join('')}
      ${lab.map((k) => `<text x="${X(k).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="bs-pay-lbl">${k}</text>`).join('')}
      ${spaced([0, yMax, yMin], Y, 12)
        .map((v) => `<text x="${m.l - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" class="bs-pay-lbl">${kinr(Math.round(v))}</text>`)
        .join('')}
      <polyline points="${line}" class="bs-pay-line"/>
      ${vline(t.spotIn, 'bs-pay-in', `in ${Math.round(t.spotIn)}`, 0)}
      ${t.spotOut != null ? vline(t.spotOut, 'bs-pay-out', `${atExpiry ? 'expiry' : 'exit'} ${Math.round(t.spotOut)}`, 1) : ''}
      ${atExpiry && inView(t.spotOut) ? `<circle cx="${X(t.spotOut).toFixed(1)}" cy="${Y(P.pl(t.spotOut)).toFixed(1)}" r="3.5" class="bs-pay-dot"/>` : ''}
    </svg>`;
    // sign: +1 for the profit side, -1 for the loss side; a slope that way beyond the strikes has no limit
    const lim = (sign, v) => (P.down * sign > 0 ? 'unlimited on a fall' : P.up * sign > 0 ? 'unlimited on a rise' : pn(v));
    return `<div class="bs-pay-head"><b>${esc(label)}</b> <span class="muted">${dayShort(t.in)} → ${dayShort(t.out)} · expiry ${dayShort(t.ref)} · width ${t.W}</span></div>
      ${svg}
      <div class="bs-pay-kv">
        <span>Max profit</span><b>${lim(1, P.maxP)}</b>
        <span>Max loss</span><b>${P.maxL >= 0 && !(P.down < 0 || P.up < 0) ? `none (worst ${pn(P.maxL)})` : lim(-1, P.maxL)}</b>
        <span>Breakevens</span><b>${P.bes.length ? P.bes.join(' / ') : '—'}</b>
        <span>Net premium</span><b>${P.prem > 0 ? `debit ${BT.inr(Math.round(P.prem))}` : `credit ${BT.inr(Math.round(-P.prem))}`}</b>
        <span>Result</span><b>${atExpiry ? `${pn(P.pl(t.spotOut))} at expiry before costs, ` : ''}${pn(t.net)} net</b>
      </div>
      <div class="muted small">Payoff at expiry, ₹ for the whole position at the backtest's fills; charges not included. Ctrl + scroll here zooms${tipZoom !== 1 ? ` (now ×${(1 / tipZoom).toFixed(1)})` : ''}.${atExpiry ? '' : ` Exited early: ${esc(BT.REASON?.[t.reason] || t.reason || '')}.`}</div>`;
  }
  function tipFor(el) {
    const tr = el.closest('tr[data-tr], tr[data-row]');
    if (!tr || !res) return null;
    if (tr.dataset.tr) {
      const [key, i] = tr.dataset.tr.split('|');
      const r = res.rows.find((x) => x.key === key);
      const t = r?.trades[Number(i)];
      return t?.legs ? { tr, t, label: `Trade ${Number(i) + 1} of ${r.trades.length}` } : null;
    }
    const r = res.rows.find((x) => x.key === tr.dataset.row);
    const t = r?.trades.at(-1);
    return t?.legs ? { tr, t, label: `${sideName(r.side)} · ATM ±${r.win}: latest trade` } : null;
  }
  let tipRow = null;
  let tipNow = null; // { t, label } shown
  let tipZoom = 1; // width ÷ the usual width: kept from row to row, back to 1 when the mouse leaves the results
  $('bsResults').addEventListener('mouseover', (e) => {
    const h = tipFor(e.target);
    if (!h) return;
    if (h.tr !== tipRow) {
      tipRow = h.tr;
      tipNow = h;
      tip.innerHTML = payoffHtml(h.t, h.label);
      tip.classList.remove('hidden');
    }
  });
  // Ctrl (⌘) + scroll or a pinch over the row zooms the payoff shown (the tooltip itself cannot be clicked)
  $('bsResults').addEventListener(
    'wheel',
    (e) => {
      if (!tipRow || !tipNow || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      tipZoom = Math.max(1 / 40, Math.min(4, tipZoom * (e.deltaY < 0 ? 1 / 1.25 : 1.25)));
      tip.innerHTML = payoffHtml(tipNow.t, tipNow.label);
    },
    { passive: false },
  );
  $('bsResults').addEventListener('mouseleave', () => (tipZoom = 1));
  $('bsResults').addEventListener('mousemove', (e) => {
    if (!tipRow) return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = e.clientX + 16 + w > innerWidth ? Math.max(4, e.clientX - 16 - w) : e.clientX + 16;
    const y = Math.max(4, Math.min(innerHeight - h - 4, e.clientY + 14));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  function hideTip() {
    tipRow = null;
    tip.classList.add('hidden');
  }
  $('bsResults').addEventListener('mouseout', (e) => {
    if (tipRow && !tipRow.contains(e.relatedTarget)) hideTip();
  });

  $('bsResults').addEventListener('click', (e) => {
    const rp = e.target.closest('[data-rp]');
    if (rp) {
      const [key, i] = rp.dataset.rp.split('|');
      return replay(key, Number(i));
    }
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
    if (Array.isArray(p.forms) && p.forms.length) sel.forms = p.forms;
    if (p.maxLossPerUnit != null) sel.maxLoss = Math.round(p.maxLossPerUnit * sel.units);
    saveSel();
    if (settings && settings !== true) renderSel();
  });
  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'bs') init();
  });
  if (window.app.state.view === 'bs') init();
})();
