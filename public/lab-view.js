// Trading Ideas › Strategy lab (bt/lab.js): try a new options structure. The Idea tab works out how the Modified
// covered call can be simplified to profit when Nifty falls; Build & payoff edits any structure as legs from ATM and
// prices it by Black-Scholes; Backtest runs it on every monthly (or weekly) series of the history; Compare runs every
// preset, always in and only in a downtrend, on the same series. History and models only: nothing here trades.
(() => {
  const { $, esc, inr, inrS, kinr, pct, cls, dayLabel } = BT;
  const TABS = [
    ['idea', 'Idea: profit from a fall'],
    ['build', 'Build & payoff'],
    ['bt', 'Backtest'],
    ['cmp', 'Compare'],
  ];
  const FILTER = { always: 'Always', belowSma: 'Only in a downtrend (Nifty under its average)', aboveSma: 'Only in an uptrend (Nifty over its average)' };
  let tab = BT.store.get('lab-tab', 'idea');
  let meta = null;
  let metaErr = '';
  let params = null;
  let model = { spot: 0, iv: 13, days: 28, etf: true, ...BT.store.get('lab-model', {}) };
  let saved = { backtest: null, compare: null };
  let job = null; // { kind, id, progress, stop }
  let openRow = null;
  let started = false;

  const num0 = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const legLine = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} ${l.type} ATM${l.off > 0 ? '+' + l.off : l.off < 0 ? '−' + -l.off : ''}`;
  const chips = (legs) => legs.map((l) => `<span class="lab-chip ${l.side > 0 ? 'b' : 's'}">${esc(legLine(l))}</span>`).join('');
  const monthName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const presetOf = (id) => meta?.presets.find((p) => p.id === id);
  const lot = () => params?.lotSize || meta?.lot || 65;
  const spotNow = () => model.spot || Math.round(window.app?.state?.data?.spot || 0) || 24000;

  // ---------- option maths: legs priced by Black-Scholes, the expiry profile (as bt/lab.js profile) ----------
  const atm = (S) => Math.round(S / 50) * 50;
  function priced(legs, S, iv, days) {
    const A = atm(S);
    return legs.map((l) => {
      const strike = A + l.off;
      return { ...l, strike, lots: l.lots * (params?.lots || 1), entry: BT.bs(S, strike, days / 365, iv / 100, l.type === 'CE') };
    });
  }
  const valueAt = (legs, x, T, iv) => legs.reduce((s, l) => s + l.side * (BT.bs(x, l.strike, T, iv, l.type === 'CE') - l.entry) * l.lots * lot(), 0);
  const expiryAt = (legs, x) => valueAt(legs, x, 0, 0);
  function profile(legs) {
    if (!legs.length) return { maxProfit: 0, maxLoss: 0, breakevens: [] };
    const ks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
    const up = legs.filter((l) => l.type === 'CE').reduce((s, l) => s + l.side * l.lots, 0);
    const down = legs.filter((l) => l.type === 'PE').reduce((s, l) => s + l.side * l.lots, 0);
    const pts = [0, ...ks, ks[ks.length - 1] + 1000].map((x) => [x, expiryAt(legs, x)]);
    const vals = pts.map((x) => x[1]);
    const breakevens = [];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      if ((y0 < 0 && y1 >= 0) || (y0 >= 0 && y1 < 0)) breakevens.push(Math.round(x0 + ((x1 - x0) * -y0) / (y1 - y0)));
    }
    // open-ended where the payoff still slopes past the outer strikes (puts: bounded only by Nifty 0)
    return {
      maxProfit: up > 0 || down > 0 ? Infinity : Math.max(...vals),
      maxLoss: up < 0 || down < 0 ? -Infinity : Math.min(...vals),
      open: { profit: up > 0 ? 'rally' : down > 0 ? 'fall' : null, loss: up < 0 ? 'rally' : down < 0 ? 'fall' : null },
      breakevens,
    };
  }
  const maxText = (v, dir) => (Number.isFinite(v) ? inrS(Math.round(v)) : `open-ended on a ${dir}`);
  const net = (legs) => -legs.reduce((s, l) => s + l.side * l.entry * l.lots * lot(), 0); // + credit, − debit

  // ---------- load ----------
  async function init() {
    if (started) return render();
    started = true;
    try {
      meta = await BT.api('/api/lab/meta');
    } catch (e) {
      metaErr = e.message;
    }
    const def = meta?.defaults || {
      preset: 'bearCombo',
      legs: [],
      lots: 1,
      lotSize: 65,
      cycle: 'monthly',
      filter: { mode: 'always', sma: 20 },
      exit: { targetPct: 0, stopPct: 0 },
      costs: { slipPct: 0.5, brokerage: 20, taxes: true },
    };
    const st = BT.store.get('lab-params', null);
    params = { ...deep(def), ...(st || {}), lotSize: meta?.lot || def.lotSize };
    for (const k of ['filter', 'exit', 'costs']) params[k] = { ...def[k], ...(st?.[k] || {}) };
    if (!params.legs?.length) params.legs = deep(presetOf(params.preset)?.legs || def.legs);
    try {
      const [b, c] = await Promise.all([BT.api('/api/lab/backtest'), BT.api('/api/lab/compare')]);
      saved = { backtest: b.saved, compare: c.saved };
    } catch {}
    render();
  }
  const save = () => BT.store.set('lab-params', params);

  function render() {
    const tabsEl = $('labTabs');
    tabsEl.innerHTML = TABS.map(([id, label]) => `<button data-t="${id}" class="${id === tab ? 'on' : ''}">${label}</button>`).join('');
    tabsEl.onclick = (e) => {
      const t = e.target.closest('button')?.dataset.t;
      if (!t) return;
      tab = t;
      BT.store.set('lab-tab', t);
      render();
    };
    $('labStatus').textContent = metaErr
      ? 'Could not load the lab: ' + metaErr
      : meta?.demo
        ? 'Demo mode: Build & payoff works; backtests need the Upstox history.'
        : '';
    if (!meta) {
      $('labBody').innerHTML = `<div class="panel empty err">${esc(metaErr || 'Loading…')}</div>`;
      return;
    }
    ({ idea: renderIdea, build: renderBuild, bt: renderBacktest, cmp: renderCompare })[tab]();
  }
  function usePreset(id, to = 'build') {
    const pr = presetOf(id);
    if (!pr) return;
    params.preset = id;
    params.legs = deep(pr.legs);
    save();
    tab = to;
    BT.store.set('lab-tab', to);
    render();
  }

  // ---------- Idea ----------
  // What a fall does to the Modified covered call and to the simplified versions, priced by Black-Scholes (28 days, 13 % IV).
  function scenarioRows(S) {
    const iv = 13;
    const days = 28;
    const mcc = priced(presetOf('mccOpts').legs, S, iv, days);
    const bear = priced(presetOf('bearCombo').legs, S, iv, days);
    const back = priced(presetOf('putBack').legs, S, iv, days);
    const units = lot() * (params.lots || 1);
    return [-10, -5, -3, -1, 0, 1, 3, 5].map((m) => {
      const x = S * (1 + m / 100);
      const bees = (x - S) * units;
      return {
        m,
        bees,
        mcc: expiryAt(mcc, x),
        mccTot: expiryAt(mcc, x) + bees,
        bear: expiryAt(bear, x),
        bearTot: expiryAt(bear, x) + bees,
        backTot: expiryAt(back, x) + bees,
      };
    });
  }
  function renderIdea() {
    const S = spotNow();
    const rows = scenarioRows(S);
    const r10 = rows[0];
    const flat = rows.find((r) => r.m === 0);
    const bear = priced(presetOf('bearCombo').legs, S, 13, 28);
    const pb = profile(bear);
    const back = priced(presetOf('putBack').legs, S, 13, 28);
    const cell = (v, hl) => `<td class="${hl ? 'lab-hl ' : ''}${cls(v)}">${inrS(Math.round(v))}</td>`;
    $('labBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Where the Modified covered call loses when Nifty falls</h3>
        <p>The Modified covered call is NIFTYBEES worth one lot (${kinr(lot() * S)} at Nifty ${num0(S)}) + a 1×2 call ratio spread + a 2-3-1 put butterfly, every monthly series. Its options are built to <b>earn in a flat market</b>; the downside protection is the put butterfly, which pays at most about 300 points on 2 lots and then stays flat, while NIFTYBEES keeps falling point for point. Past the butterfly the strategy is simply long Nifty: a 10 % fall costs ${kinr(r10.bees)} on the ETF and the options give back ${kinr(r10.mcc)}.</p>
        <div class="tbl-wrap"><table class="grid-tbl lab-scen"><thead><tr><th class="l">Nifty at expiry</th><th>NIFTYBEES (1 lot)</th><th>MCC options</th><th class="lab-hl">MCC total</th><th>Bear spread combo</th><th class="lab-hl">Bear combo + NIFTYBEES</th><th class="lab-hl">Put backspread + NIFTYBEES</th></tr></thead>
        <tbody>${rows
          .map(
            (r) =>
              `<tr><td class="l">${r.m > 0 ? '+' : ''}${r.m} % (${num0(S * (1 + r.m / 100))})</td>${cell(r.bees)}${cell(r.mcc)}${cell(r.mccTot, true)}${cell(r.bear)}${cell(r.bearTot, true)}${cell(r.backTot, true)}</tr>`,
          )
          .join('')}</tbody></table></div>
        <p class="muted small">Black-Scholes at 13 % IV for every strike, 28 days, one lot of ${lot()}, before costs; the MCC options at its fixed distances (its ideal-trade search picks the distances each month, so a real month differs). A model of the shape, not a result: the Backtest and Compare tabs use the real prices.</p>
      </div>
      <div class="panel cc-doc">
        <h3>How to simplify it for a falling market</h3>
        <ol>
          <li><b>Drop NIFTYBEES to profit from a fall: the bear spread combo.</b> NIFTYBEES is the part that loses in a fall; it ties up ~${kinr(lot() * S)} and needs pledging. Without it the call ratio’s second sold call would be naked, so flip both sides instead: buy the ATM put, sell the put 300 under it; sell the call 100 over ATM, buy the one 300 over it. The call credit pays most of the put spread, so a flat month costs little, a fall pays up to ~300 points, a rally costs at most the call spread’s width less its credit. At Nifty ${num0(S)}: net ${net(bear) >= 0 ? 'credit' : 'debit'} ${inr(Math.abs(Math.round(net(bear))))}, most it makes ${maxText(pb.maxProfit, pb.open.profit)}, most it loses ${maxText(pb.maxLoss, pb.open.loss)}, breakeven ${pb.breakevens.map(num0).join(' / ') || '—'}. Four legs, one entry a month, no rolls, capital ≈ the most it can lose instead of ${kinr(lot() * S)}.</li>
          <li><b>Keep NIFTYBEES but give it a floor: swap the 2-3-1 butterfly for a 1×2 put backspread.</b> Sell 1 put at ATM−100, buy 2 at ATM−400. Under the bought strike the one put bought net moves against NIFTYBEES point for point, so the loss stops there: ${kinr(r10.backTot)} at −10 % against ${kinr(r10.mccTot)} for the MCC. It costs ${kinr(-flat.backTot)} in a flat month (a debit of ${inr(Math.abs(Math.round(net(back))))}), and keeps every rupee of a rally on the ETF. Two legs instead of three.</li>
          <li><b>Only when the market is already falling.</b> Either structure with the trend filter (Nifty under its 20-day average at entry): out in rising markets, where a bearish trade mostly loses. The Compare tab runs every structure both ways.</li>
        </ol>
        <p class="small"><b>A spread caps what it can pay.</b> One lot of the bear combo makes at most ~300 points, so it does not hedge one lot of NIFTYBEES in a big fall (${kinr(r10.bearTot)} together at −10 %, worse than the MCC’s ${kinr(r10.mccTot)}). Use it as a trade on its own; to protect the ETF you need a put bought net (the backspread), more lots or a wider spread.</p>
      </div>
      <div class="panel cc-doc">
        <h3>Before you trust it</h3>
        <ul>
          <li><b>Nifty drifts up.</b> A strategy that is bearish every month loses in most of them; the edge, if any, comes from <i>when</i> it is on. That is why the trend filter is part of the lab: compare “always” with “only in a downtrend” on the Compare tab.</li>
          <li><b>Puts are dearer than calls</b> (the volatility skew): the put spread alone costs more than its mirror call spread, which is why selling the call spread to pay for it helps. After a fall, IV rises and makes the next month’s put spread dearer still.</li>
          <li><b>Defined risk on both sides</b> is the point of the spreads: a gap up or down cannot lose more than the maximum shown. The exception is the MCC’s options alone (a naked call, kept for comparison); the backspread is open-ended only on its gain.</li>
          <li><b>Small sample.</b> The cache holds about two years of monthly series: 20-odd results, a handful of real falls. Read the by-direction tables, the worst month and the drawdown, not only the total. Weekly series give more results but more costs (four legs each).</li>
          <li><b>Costs.</b> Four legs in and up to four out: 0.5 % slippage and ₹20 an order are charged; far strikes can be thinner than that.</li>
        </ul>
      </div>
      <div class="panel cc-doc">
        <h3>The structures in the lab</h3>
        <div class="lab-presets">${meta.presets
          .map((p) => {
            const legs = priced(p.legs, S, 13, 28);
            const pr = profile(legs);
            return `<div class="lab-preset"><div class="lab-ph"><b>${esc(p.name)}</b>${p.tag ? `<span class="lab-tag">${esc(p.tag)}</span>` : ''}</div>
              <div class="lab-legs">${chips(p.legs)}</div>
              <p class="small">${esc(p.idea)}</p>
              <div class="muted small">Model (13 % IV, 28 days): net ${net(legs) >= 0 ? 'credit' : 'debit'} ${inr(Math.abs(Math.round(net(legs))))} · max ${maxText(pr.maxProfit, pr.open.profit)} · worst ${maxText(pr.maxLoss, pr.open.loss)}</div>
              <div class="lab-pbtn"><button class="btn-sm ghost" data-use="${p.id}">Build & payoff ▸</button><button class="btn-sm ghost" data-bt="${p.id}">Backtest ▸</button></div></div>`;
          })
          .join('')}</div>
      </div>`;
    bindPresetButtons($('labBody'));
  }
  function bindPresetButtons(el) {
    el.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => usePreset(b.dataset.use, 'build')));
    el.querySelectorAll('[data-bt]').forEach((b) => (b.onclick = () => usePreset(b.dataset.bt, 'bt')));
  }

  // ---------- Build & payoff ----------
  function renderBuild() {
    const S = spotNow();
    $('labBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Structure</h3>
        <div class="lab-row"><span class="muted small">Start from</span><div class="seg sm" id="labPresetSeg">${meta.presets.map((p) => `<button data-p="${p.id}" class="${p.id === params.preset ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div></div>
        <div class="tbl-wrap"><table class="grid-tbl lab-legs-tbl"><thead><tr><th class="l">Buy / sell</th><th class="l">Type</th><th>Strike from ATM (pts)</th><th>Lots</th><th>Strike now</th><th>Premium (model)</th><th></th></tr></thead><tbody id="labLegRows"></tbody></table></div>
        <div class="lab-row"><button class="btn-sm ghost" id="labAddLeg">+ Add leg</button>
          <label class="small">Nifty <input class="txt num" id="labSpot" value="${S}" style="width:80px"></label>
          <label class="small">IV % <input class="txt num" id="labIv" value="${model.iv}" style="width:50px"></label>
          <label class="small">Days to expiry <input class="txt num" id="labDays" value="${model.days}" style="width:50px"></label>
          <label class="small">Strategy lots <input class="txt num" id="labLots" value="${params.lots}" style="width:44px"></label>
          <label class="small"><input type="checkbox" id="labEtf" ${model.etf ? 'checked' : ''}> show with NIFTYBEES (1 lot)</label>
          <button class="btn-sm" id="labToBt">Backtest this ▸</button></div>
        <div class="kpis" id="labKpis"></div>
      </div>
      <div class="panel cc-doc"><h3>Payoff</h3><div class="cc-pay-chart"><canvas id="labPay"></canvas></div><div class="muted small">At expiry and today (Black-Scholes at the IV above, one IV for every strike: real puts trade dearer than calls). Wheel / drag to zoom the chart.</div></div>
      <div class="panel cc-doc"><h3>If Nifty moves by expiry</h3><div id="labScen"></div></div>`;
    const seg = $('labPresetSeg');
    seg.onclick = (e) => {
      const id = e.target.closest('button')?.dataset.p;
      if (id) usePreset(id, 'build');
    };
    const num = (id, d) => {
      const v = Number($(id).value);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    const onModel = () => {
      model = { ...model, spot: num('labSpot', 24000), iv: num('labIv', 13), days: num('labDays', 28), etf: $('labEtf').checked };
      params.lots = Math.max(1, Math.round(num('labLots', 1)));
      BT.store.set('lab-model', model);
      save();
      drawBuild();
    };
    for (const id of ['labSpot', 'labIv', 'labDays', 'labLots']) $(id).addEventListener('change', onModel);
    $('labEtf').addEventListener('change', onModel);
    $('labAddLeg').onclick = () => {
      params.legs.push({ type: 'PE', side: 1, off: 0, lots: 1 });
      params.preset = 'custom';
      save();
      renderBuild();
    };
    $('labToBt').onclick = () => {
      tab = 'bt';
      BT.store.set('lab-tab', tab);
      render();
    };
    drawBuild();
  }
  function drawBuild() {
    const S = spotNow();
    const legs = priced(params.legs, S, model.iv, model.days);
    const rows = $('labLegRows');
    rows.innerHTML = params.legs
      .map(
        (l, i) => `<tr data-i="${i}">
        <td class="l"><select data-k="side"><option value="1" ${l.side > 0 ? 'selected' : ''}>Buy</option><option value="-1" ${l.side < 0 ? 'selected' : ''}>Sell</option></select></td>
        <td class="l"><select data-k="type"><option ${l.type === 'CE' ? 'selected' : ''}>CE</option><option ${l.type === 'PE' ? 'selected' : ''}>PE</option></select></td>
        <td><input class="txt num" data-k="off" value="${l.off}" style="width:70px"></td>
        <td><input class="txt num" data-k="lots" value="${l.lots}" style="width:44px"></td>
        <td>${num0(legs[i].strike)}</td><td>${legs[i].entry.toFixed(1)}</td>
        <td><button class="btn-sm ghost danger" data-del="${i}" title="Remove this leg">✕</button></td></tr>`,
      )
      .join('');
    rows.onchange = (e) => {
      const tr = e.target.closest('tr');
      const l = params.legs[Number(tr.dataset.i)];
      const k = e.target.dataset.k;
      if (k === 'side') l.side = Number(e.target.value);
      else if (k === 'type') l.type = e.target.value;
      else if (k === 'off') l.off = Math.round((Number(e.target.value) || 0) / 50) * 50;
      else if (k === 'lots') l.lots = Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1)));
      params.preset = 'custom';
      save();
      drawBuild();
    };
    rows.onclick = (e) => {
      const i = e.target.dataset.del;
      if (i == null) return;
      params.legs.splice(Number(i), 1);
      params.preset = 'custom';
      save();
      renderBuild();
    };
    const pr = profile(legs);
    const n = net(legs);
    const units = lot() * (params.lots || 1);
    $('labKpis').innerHTML = [
      ['Net premium', `${n >= 0 ? 'Credit' : 'Debit'} ${inr(Math.abs(Math.round(n)))}`, 'paid / received at entry'],
      ['Most it makes', maxText(pr.maxProfit, pr.open.profit), 'at expiry'],
      ['Most it loses', maxText(pr.maxLoss, pr.open.loss), 'at expiry'],
      ['Breakeven', pr.breakevens.map(num0).join(' / ') || '—', 'Nifty at expiry'],
      [
        'Nifty −5 %',
        inrS(Math.round(expiryAt(legs, S * 0.95))),
        model.etf ? `+ NIFTYBEES ${inrS(Math.round(expiryAt(legs, S * 0.95) - 0.05 * S * units))}` : 'at expiry',
      ],
      [
        'Nifty +5 %',
        inrS(Math.round(expiryAt(legs, S * 1.05))),
        model.etf ? `+ NIFTYBEES ${inrS(Math.round(expiryAt(legs, S * 1.05) + 0.05 * S * units))}` : 'at expiry',
      ],
    ]
      .map(([l, v, s]) => `<div class="kpi"><span class="k-l">${l}</span><span class="k-v">${v}</span><span class="k-s">${s}</span></div>`)
      .join('');
    // scenarios
    const moves = [-10, -7, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7, 10];
    $('labScen').innerHTML =
      `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty</th>${moves.map((m) => `<th>${m > 0 ? '+' : ''}${m} %</th>`).join('')}</tr></thead><tbody>
      <tr><th>Strategy</th>${moves.map((m) => ((v) => `<td class="${cls(v)}">${kinr(v)}</td>`)(expiryAt(legs, S * (1 + m / 100)))).join('')}</tr>
      ${model.etf ? `<tr><th>NIFTYBEES (1 lot)</th>${moves.map((m) => ((v) => `<td class="${cls(v)}">${kinr(v)}</td>`)((m / 100) * S * units)).join('')}</tr><tr><th>Together</th>${moves.map((m) => ((v) => `<td class="${cls(v)}"><b>${kinr(v)}</b></td>`)(expiryAt(legs, S * (1 + m / 100)) + (m / 100) * S * units)).join('')}</tr>` : ''}
      </tbody></table></div>`;
    // chart
    const lo = Math.floor((S * 0.8) / 50) * 50;
    const hi = Math.ceil((S * 1.2) / 50) * 50;
    const home = [Math.floor((S * 0.92) / 50) * 50, Math.ceil((S * 1.08) / 50) * 50];
    const xs = [];
    for (let x = lo; x <= hi; x += 25) xs.push(x);
    const T = model.days / 365;
    const sets = [
      { label: 'At expiry', data: xs.map((x) => ({ x, y: Math.round(expiryAt(legs, x)) })), borderColor: '#b392f0', borderWidth: 2, pointRadius: 0 },
      {
        label: 'Today',
        data: xs.map((x) => ({ x, y: Math.round(valueAt(legs, x, T, model.iv / 100)) })),
        borderColor: '#d6af4c',
        borderWidth: 1.5,
        borderDash: [5, 3],
        pointRadius: 0,
      },
    ];
    if (model.etf)
      sets.push({
        label: 'At expiry + NIFTYBEES',
        data: xs.map((x) => ({ x, y: Math.round(expiryAt(legs, x) + (x - S) * units) })),
        borderColor: '#58a6ff',
        borderWidth: 2,
        pointRadius: 0,
      });
    const ys = sets.flatMap((s) => s.data.filter((p) => p.x >= home[0] && p.x <= home[1]).map((p) => p.y));
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    sets.push({
      label: `Nifty ${num0(S)}`,
      data: [
        { x: S, y: y0 - (y1 - y0) },
        { x: S, y: y1 + (y1 - y0) },
      ],
      borderColor: '#9aa5b1',
      borderDash: [4, 4],
      borderWidth: 1,
      pointRadius: 0,
      pz_skip: true,
    });
    BT.chart($('labPay'), {
      type: 'line',
      data: { datasets: sets },
      options: {
        parsing: true,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', min: home[0], max: home[1], title: { display: true, text: 'Nifty' } },
          y: { min: y0 - (y1 - y0) * 0.1, max: y1 + (y1 - y0) * 0.1, ticks: { callback: (v) => kinr(v) } },
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

  // ---------- Backtest ----------
  function settingsHtml() {
    const opts = meta.monthly.map((e) => `<option value="${e}">${dayLabel(e)}</option>`).join('');
    const sel = (k, cur, list) =>
      `<select data-p="${k}">${list.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const inp = (k, cur, w = 50) => `<input class="txt num" data-p="${k}" value="${cur}" style="width:${w}px">`;
    return `<div class="lab-set">
      <label>From expiry <select id="labFrom">${opts}</select></label>
      <label>To expiry <select id="labTo">${opts}</select></label>
      <label>Series ${sel('cycle', params.cycle, [
        ['monthly', 'Monthly (as the MCC)'],
        ['weekly', 'Weekly (every expiry)'],
      ])}</label>
      <label>Enter ${sel('filter.mode', params.filter.mode, Object.entries(FILTER))}</label>
      <label>Average of ${inp('filter.sma', params.filter.sma, 44)} days</label>
      <label title="Close every leg at 15:00 once the position is up this % of the most it can make (0 = hold to expiry)">Target % of max ${inp('exit.targetPct', params.exit.targetPct, 44)}</label>
      <label title="Close every leg at 15:00 once it is down this % of the most it can lose (0 = off)">Stop % of max loss ${inp('exit.stopPct', params.exit.stopPct, 44)}</label>
      <label>Lots ${inp('lots', params.lots, 40)}</label>
      <label>Slippage % ${inp('costs.slipPct', params.costs.slipPct, 44)}</label>
    </div>`;
  }
  function setParam(path, raw) {
    const v = raw !== '' && !isNaN(raw) ? Number(raw) : raw;
    const [a, b] = path.split('.');
    if (b) params[a] = { ...params[a], [b]: v };
    else params[a] = v;
    save();
  }
  function bindSettings(root) {
    const from = BT.store.get('lab-from', meta.monthly[1] || '');
    const to = BT.store.get('lab-to', meta.monthly[meta.monthly.length - 1] || '');
    if ($('labFrom')) {
      $('labFrom').value = from;
      $('labTo').value = to;
      $('labFrom').onchange = () => BT.store.set('lab-from', $('labFrom').value);
      $('labTo').onchange = () => BT.store.set('lab-to', $('labTo').value);
    }
    root.querySelectorAll('[data-p]').forEach((el) => el.addEventListener('change', () => setParam(el.dataset.p, el.value)));
  }
  const progressHtml = () =>
    `<div class="progress ${job ? '' : 'hidden'}" id="labProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span><button class="btn-sm ghost" id="labStop">Stop</button></div>`;
  function showProgress(pr) {
    const box = $('labProg');
    if (!box) return;
    box.classList.toggle('hidden', !job);
    if (!pr) return;
    const inner = pr.inner || pr;
    const frac = pr.total ? (pr.done + (pr.inner?.total ? pr.inner.done / pr.inner.total : 0)) / pr.total : 0;
    box.querySelector('.fill').style.width = (frac * 100).toFixed(1) + '%';
    box.querySelector('.ptext').textContent = `${pr.phase || ''} ${inner.total ? `${inner.done}/${inner.total}` : ''} · ${pr.api?.requests ?? 0} downloads`;
    $('labStop').onclick = () => job?.id && BT.api('/api/lab/job/stop', { id: job.id }).catch(() => {});
  }
  async function runJob(kind) {
    if (job) return;
    const body = { params: { ...params, legs: params.legs }, from: $('labFrom')?.value, to: $('labTo')?.value };
    const errEl = $(kind === 'compare' ? 'labCmpRes' : 'labRes');
    try {
      job = { kind };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api('/api/lab/' + kind, body);
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api('/api/lab/job?id=' + job.id);
        showProgress(j.progress);
        if (j.status === 'done') {
          saved[kind] = j.result;
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
      job = null;
      openRow = null;
      if (tab === (kind === 'compare' ? 'cmp' : 'bt')) render();
    } catch (e) {
      job = null;
      showProgress(null);
      if (errEl) errEl.innerHTML = `<div class="panel empty err">${kind === 'compare' ? 'Compare' : 'Backtest'} failed: ${esc(e.message)}</div>`;
    }
  }
  function renderBacktest() {
    const name = presetOf(params.preset)?.name || 'Custom structure';
    $('labBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Backtest: ${esc(name)}</h3>
        <div class="lab-legs">${chips(params.legs)} <button class="btn-sm ghost" id="labEdit">Edit legs ▸</button></div>
        ${meta.monthly.length ? settingsHtml() : '<p class="muted">No expired monthly series in the calendar yet (log in to Upstox, or the history is not downloaded): the backtest needs the Nifty and option history of the Data screen.</p>'}
        <div class="lab-row"><button class="btn-sm run" id="labRun" ${meta.monthly.length && params.legs.length ? '' : 'disabled'}>Run backtest</button>${progressHtml()}</div>
        <p class="muted small">Entered at 09:30 on each series’ first trading day at the strikes above (ATM = Nifty rounded to 50), held to its expiry and settled at intrinsic, unless the target / stop closes it at 15:00 first. 0.5 % slippage, ₹20 an order, taxes by date. Options the cache lacks are downloaded when logged in to Upstox.</p>
      </div>
      <div id="labRes"></div>`;
    $('labEdit').onclick = () => {
      tab = 'build';
      BT.store.set('lab-tab', tab);
      render();
    };
    bindSettings($('labBody'));
    $('labRun').onclick = () => runJob('backtest');
    if (job) showProgress(job.progress);
    renderResults();
  }
  function kpi(label, v, sub, c) {
    return `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c ?? cls(v)}">${typeof v === 'number' ? inrS(v) : v}</span><span class="k-s">${sub || ''}</span></div>`;
  }
  function dirTable(s) {
    const b = s.byMove;
    const row = (k, label) =>
      `<tr><td class="l">${label}</td><td>${b[k].n}</td><td>${b[k].n ? `${b[k].win}/${b[k].n}` : '—'}</td><td class="${cls(b[k].opt)}">${inrS(b[k].opt)}</td><td class="${cls(b[k].long)}">${inrS(b[k].long)}</td><td class="${cls(b[k].hedged)}">${inrS(b[k].hedged)}</td></tr>`;
    return `<div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty entry → expiry</th><th>Series</th><th>Won</th><th>Strategy</th><th>NIFTYBEES 1 lot</th><th>Strategy + NIFTYBEES</th></tr></thead><tbody>
      ${row('down', `Down more than ${s.band} %`)}${row('flat', `Within ±${s.band} %`)}${row('up', `Up more than ${s.band} %`)}</tbody></table></div>`;
  }
  function renderResults() {
    const el = $('labRes');
    const B = saved.backtest;
    if (!B) {
      el.innerHTML = '<div class="panel empty"><h3>No backtest yet</h3><p>Pick the settings and press Run backtest.</p></div>';
      return;
    }
    const s = B.summary;
    const p = B.params;
    const pname = presetOf(p.preset)?.name || 'Custom structure';
    const exitText =
      [p.exit.targetPct ? `target ${p.exit.targetPct} %` : '', p.exit.stopPct ? `stop ${p.exit.stopPct} %` : ''].filter(Boolean).join(', ') || 'held to expiry';
    el.innerHTML = `
      <div class="panel cc-doc">
        <h3>${esc(pname)}: ${s.from ? `${dayLabel(s.from)} – ${dayLabel(s.to)}` : 'no series'}, ${s.months} ${p.cycle} series traded${s.filtered ? `, ${s.filtered} sat out by the filter` : ''}</h3>
        <div class="lab-legs">${chips(p.legs)}<span class="muted small">${p.lots} lot · ${FILTER[p.filter.mode]}${p.filter.mode !== 'always' ? ` (${p.filter.sma} days)` : ''} · ${exitText} · costs ${inr(s.costs)}</span></div>
        <div class="kpis">
          ${kpi('Strategy total', s.opt.total, `${pct(s.opt.annPct)} / yr on ${kinr(s.capital)} at risk`)}
          ${kpi('Per series', s.opt.avg, `${s.opt.win}/${s.months} won`)}
          ${kpi('Worst series', s.opt.worst, `best ${kinr(s.opt.best)}`)}
          ${kpi('Max drawdown', s.opt.maxDD, 'of the running total')}
          ${kpi('NIFTYBEES 1 lot', s.long.total, 'held over the same series', cls(s.long.total))}
          ${kpi('Strategy + NIFTYBEES', s.hedged.total, `worst ${kinr(s.hedged.worst)} · DD ${kinr(s.hedged.maxDD)}`)}
          ${s.exits.target || s.exits.stop ? kpi('Early exits', `${s.exits.target} / ${s.exits.stop}`, 'target / stop', '') : ''}
        </div>
        ${s.skipped.length ? `<p class="muted small">Left out: ${s.skipped.map((x) => `${monthName(x.expiry)} (${esc(x.why)})`).join(', ')}.</p>` : ''}
      </div>
      <div class="panel cc-doc"><h3>By market direction</h3>${dirTable(s)}<p class="muted small">A strategy that profits from a fall should show its gains in the first row; the last column is what it does laid over the Modified covered call’s NIFTYBEES.</p></div>
      <div class="panel cc-doc"><h3>Running total</h3><div class="cc-pay-chart"><canvas id="labEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>Series by series</h3><div class="muted small" style="margin-bottom:6px">Click a row for its legs and fills.</div>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th><th>Net at entry</th><th>Max / worst</th><th>Exit</th><th>Strategy</th><th>NIFTYBEES</th><th>Together</th></tr></thead><tbody>
        ${B.months
          .map((m) => {
            if (!m.ok)
              return `<tr><td class="l">${dayLabel(m.expiry)}</td><td>${m.spot0 ? `${num0(m.spot0)} → ${num0(m.spotE)}` : ''}</td><td class="${cls(m.move)}">${m.move != null ? pct(m.move) : ''}</td><td colspan="6" class="muted l">${esc(m.skip)}</td></tr>`;
            const open = openRow === m.expiry;
            return `<tr class="cc-click${open ? ' on' : ''}" data-m="${m.expiry}"><td class="l">${dayLabel(m.expiry)}</td><td>${num0(m.spot0)} → ${num0(m.spotE)}</td><td class="${cls(m.move)}">${pct(m.move)}</td>
              <td>${m.entry.net >= 0 ? 'Cr ' : 'Dr '}${inr(Math.abs(m.entry.net))}</td><td>${m.maxProfit != null ? kinr(m.maxProfit) : '∞'} / ${m.maxLoss != null ? kinr(m.maxLoss) : '∞'}</td>
              <td>${m.exit ? `${m.exit.why} ${dayLabel(m.exit.day)}` : 'expiry'}</td>
              <td class="${cls(m.opt)}"><b>${inrS(m.opt)}</b></td><td class="${cls(m.long)}">${inrS(m.long)}</td><td class="${cls(m.hedged)}">${inrS(m.hedged)}</td></tr>
              ${open ? `<tr class="cc-detail"><td colspan="9" class="l"><ul class="small">${m.events.map((e) => `<li>${dayLabel(e.day)} ${e.time || ''} · Nifty ${num0(e.spot)} · ${esc(e.text)}</li>`).join('')}</ul><div class="small muted">Closed legs: ${m.closed.map((c) => `${c.side > 0 ? 'B' : 'S'} ${c.lots}× ${c.strike} ${c.type} ${c.entry.toFixed(1)} → ${c.exit.toFixed(1)} (${inrS(Math.round(c.pnl))})`).join(' · ')} · costs ${inr(m.costs)}</div></td></tr>` : ''}`;
          })
          .join('')}</tbody></table></div></div>`;
    el.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', () => {
        openRow = openRow === tr.dataset.m ? null : tr.dataset.m;
        renderResults();
      }),
    );
    const ok = B.months.filter((m) => m.ok);
    const run = (k) => {
      let t = 0;
      return ok.map((m) => ({ x: m.expiry, y: (t += m[k]) }));
    };
    BT.chart($('labEq'), {
      type: 'line',
      data: {
        labels: ok.map((m) => dayLabel(m.expiry)),
        datasets: [
          { label: 'Strategy', data: run('opt').map((p) => p.y), borderColor: '#b392f0', borderWidth: 2, pointRadius: 2 },
          { label: 'NIFTYBEES 1 lot', data: run('long').map((p) => p.y), borderColor: '#9aa5b1', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
          { label: 'Strategy + NIFTYBEES', data: run('hedged').map((p) => p.y), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 0 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(Math.round(c.parsed.y))}` } } },
      },
    });
  }

  // ---------- Compare ----------
  function renderCompare() {
    $('labBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Every structure on the same series</h3>
        <p class="small">Each preset is run twice — always in, and only when Nifty is under its ${params.filter.sma}-day average at entry — with the period, series, target / stop, lots and slippage set here (shared with the Backtest tab). Click a row to open it on the Backtest tab.</p>
        ${meta.monthly.length ? settingsHtml() : '<p class="muted">No expired monthly series in the calendar yet: log in to Upstox and download the history (Data screen).</p>'}
        <div class="lab-row"><button class="btn-sm run" id="labCmpRun" ${meta.monthly.length ? '' : 'disabled'}>Run compare (${(meta.presets.length || 0) * 2} runs)</button>${progressHtml()}</div>
      </div>
      <div id="labCmpRes"></div>`;
    bindSettings($('labBody'));
    $('labCmpRun').onclick = () => runJob('compare');
    if (job) showProgress(job.progress);
    const C = saved.compare;
    if (!C) {
      $('labCmpRes').innerHTML = '<div class="panel empty"><h3>Not run yet</h3><p>Press Run compare.</p></div>';
      return;
    }
    const rows = [...C.rows].sort((a, b) => b.summary.opt.total - a.summary.opt.total);
    const bestDown = rows.reduce((a, b) => (b.summary.byMove.down.opt > a.summary.byMove.down.opt ? b : a), rows[0]);
    const bestHedge = rows.reduce((a, b) => (b.summary.hedged.total > a.summary.hedged.total ? b : a), rows[0]);
    const s0 = (rows.find((r) => r.filter === 'always') || rows[0])?.summary;
    $('labCmpRes').innerHTML = `<div class="panel cc-doc">
      <h3>Ranked by total${s0?.from ? `: ${dayLabel(s0.from)} – ${dayLabel(s0.to)}, ${C.params.cycle} series` : ''}</h3>
      <p class="small">Best in falling series: <b>${esc(bestDown.label)}</b> (${inrS(bestDown.summary.byMove.down.opt)} over ${bestDown.summary.byMove.down.n} down series). Best laid over NIFTYBEES: <b>${esc(bestHedge.label)}</b> (${inrS(bestHedge.summary.hedged.total)} against ${inrS(bestHedge.summary.long.total)} for NIFTYBEES alone).</p>
      <div class="tbl-wrap"><table class="grid-tbl lab-cmp"><thead><tr><th class="l">Structure</th><th>Traded</th><th>Total</th><th>Per series</th><th>Won</th><th>Worst</th><th>Max DD</th><th>Down series</th><th>Flat</th><th>Up</th><th>+ NIFTYBEES</th><th>% / yr on risk</th></tr></thead><tbody>
      ${rows
        .map((r) => {
          const s = r.summary;
          const b = s.byMove;
          return `<tr class="cc-click" data-id="${r.id}" data-f="${r.filter}"><td class="l">${esc(r.label)}${r === bestDown ? ' <span class="lab-tag">best in falls</span>' : ''}</td><td>${s.months}${s.filtered ? ` <span class="muted">(${s.filtered} out)</span>` : ''}</td>
            <td class="${cls(s.opt.total)}"><b>${inrS(s.opt.total)}</b></td><td class="${cls(s.opt.avg)}">${kinr(s.opt.avg)}</td><td>${s.opt.win}/${s.months}</td><td class="${cls(s.opt.worst)}">${kinr(s.opt.worst)}</td><td class="${cls(s.opt.maxDD)}">${kinr(s.opt.maxDD)}</td>
            <td class="${cls(b.down.opt)}">${kinr(b.down.opt)} <span class="muted">(${b.down.n})</span></td><td class="${cls(b.flat.opt)}">${kinr(b.flat.opt)} <span class="muted">(${b.flat.n})</span></td><td class="${cls(b.up.opt)}">${kinr(b.up.opt)} <span class="muted">(${b.up.n})</span></td>
            <td class="${cls(s.hedged.total)}">${kinr(s.hedged.total)}</td><td>${pct(s.opt.annPct)}</td></tr>`;
        })
        .join('')}</tbody></table></div>
      <p class="muted small">Run ${new Date(C.at).toLocaleString('en-IN')}. Down / flat / up: Nifty from entry to expiry moved more than ±${s0?.band ?? 2} %; the count is in brackets. “+ NIFTYBEES”: the structure laid over one lot of NIFTYBEES held through every series (the ETF alone in the series a filter sat out). % / yr on risk: the total per calendar year on the most the structure could lose (a debit spread risks only its debit, so this runs high; a future’s margin where the loss is open-ended). Past series only, a small sample: a guide to the shape of each structure, not a forecast.</p></div>`;
    $('labCmpRes')
      .querySelectorAll('tr[data-id]')
      .forEach((tr) =>
        tr.addEventListener('click', () => {
          params.filter = { ...params.filter, mode: tr.dataset.f };
          usePreset(tr.dataset.id, 'bt');
        }),
      );
  }

  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'lab') init();
  });
  if (window.app?.state.view === 'lab') init();
})();
