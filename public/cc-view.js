// Trading Ideas › Covered call: the strategy and its rules (from the three threads it comes from), its backtest on
// the cached history and its live paper trade (bt/coveredcall.js, ccpaper.js). Paper only: nothing here sends orders.
// P&L is shown with NIFTYBEES (options + the ETF held) and without it (the options alone); every position has a payoff
// diagram at expiry with both.
(() => {
  const { $, esc, inr, inrS, kinr, pct, cls, dayLabel } = BT;
  const TABS = [
    ['rules', 'Strategy & rules'],
    ['bt', 'Backtest'],
    ['paper', 'Paper trade'],
  ];
  const IDEAS = [['cc', 'Covered call', 'NIFTYBEES + monthly call, put butterfly, weekly contra spreads']];
  const CALL_RULES = [
    ['itm100', 'ITM: the 100-point strike under spot (as in the thread)'],
    ['atm', 'ATM'],
    ['itmPts', 'ITM by N points'],
    ['otmPts', 'OTM by N points'],
    ['otmPct', 'OTM by N %'],
  ];
  const INS = [
    ['butterfly', 'Put butterfly 1:2:1'],
    ['debit', 'Put debit spread'],
    ['none', 'None'],
  ];
  const REINVEST = [
    ['below', 'when the month closed under its entry'],
    ['always', 'every month'],
    ['never', 'never'],
  ];
  const REGIME = { up: 'Above call breakeven', down: 'Below lower trigger', range: 'In range' };
  const REGIME_TRADE = { up: 'put credit spread', down: 'call credit spread', range: 'iron condor' };
  const KIND = {
    hold: 'NIFTYBEES',
    call: 'Call',
    ins: 'Insurance',
    ovl: 'Weekly',
    'ovl-exp': 'Weekly expiry',
    exp: 'Monthly expiry',
    book: 'Booked',
    reinvest: 'Reinvest',
    skip: 'Skipped',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    error: 'Error',
  };
  const VIEWS = [
    ['with', 'With NIFTYBEES'],
    ['without', 'Without NIFTYBEES (options only)'],
  ];

  let meta = null;
  let tab = BT.store.get('cc-tab', 'rules');
  let view = BT.store.get('cc-pnl-view', 'with'); // which P&L the charts draw
  let params = null;
  let saved = null; // last backtest { at, result }
  let open = null; // month expanded in the backtest table
  let openPay = 'month'; // its payoff: the month or one weekly spread (index)
  let paperOpen = null; // closed paper month whose payoff is shown
  let running = null; // { stop } while a backtest runs
  let runError = '';
  let paper = null; // /api/cc/paper
  let paperError = '';
  let sugg = null; // /api/cc/suggest: what the rules would trade on the live chain now
  let suggError = '';
  const suggSel = { month: null, call: {}, ins: {}, wk: null }; // the rows picked in the suggestion tables (month: null = the one the rules trade)
  let pollTimer = null;
  let started = false;

  const tile = (label, value, sub = '', c = '') =>
    `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c}">${value}</span><span class="k-s">${sub}</span></div>`;
  const legName = (l) => `${l.side === 'S' ? 'Sell' : 'Buy'} ${l.strike} ${l.type}`;
  const when = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const num0 = (x) => Math.round(x).toLocaleString('en-IN');
  const rupee = (x, d = 2) => '₹' + Number(x).toFixed(d);
  const viewSeg = () =>
    `<span class="seg sm cc-view">${VIEWS.map(([k, l]) => `<button data-view="${k}" class="${k === view ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  function bindView(root, redraw) {
    root.querySelectorAll('.cc-view button').forEach((b) =>
      b.addEventListener('click', () => {
        view = b.dataset.view;
        BT.store.set('cc-pnl-view', view);
        redraw();
      }),
    );
  }

  async function init() {
    if (started) return;
    started = true;
    $('ccMenu').innerHTML =
      '<div class="cc-menu-head muted small">Trading ideas</div>' +
      IDEAS.map(([id, name, sub]) => `<button class="bw-item on" data-idea="${id}"><b>${name}</b><span class="muted small">${sub}</span></button>`).join('') +
      '<div class="muted small cc-menu-foot">Each idea: its rules as read from the source, a backtest on the cached history and a live paper trade. Nothing here places orders.</div>';
    try {
      meta = await BT.api('/api/cc/meta');
    } catch (e) {
      $('ccBody').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
      return;
    }
    params = { ...deep(meta.defaults), ...BT.store.get('cc-params', {}) };
    params.lotSize = meta.lot;
    try {
      saved = (await BT.api('/api/cc/backtest')).saved;
    } catch {}
    render();
  }

  function render() {
    $('ccTabs').innerHTML = TABS.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('');
    if (tab === 'rules') renderRules();
    else if (tab === 'bt') renderBacktest();
    else renderPaper();
    poll();
  }

  // ---------- payoff diagram ----------
  // P&L at expiry against Nifty there: the options at their intrinsic value, NIFTYBEES moving with Nifty.
  //   legs: [{ type, side, strike, qty, entry }]; hold: { qty, spot, bees, cost } (NIFTYBEES worth bees at Nifty spot,
  //   bought at cost each) or null; marks: [{ x, label, color }] vertical lines (entry, expiry, breakevens…).
  // label: the name of the options-only line when there is no NIFTYBEES (default "Options").
  function payoffChart(canvas, { legs, hold, marks = [], label = 'Options' }) {
    const optAt = (S) =>
      legs.reduce((s, l) => s + (l.side === 'S' ? 1 : -1) * (l.entry - Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S)) * l.qty, 0);
    const holdAt = (S) => (hold ? hold.qty * ((hold.bees * S) / hold.spot - hold.cost) : 0);
    const refs = [...legs.map((l) => l.strike), ...marks.map((m) => m.x), hold?.spot].filter((x) => x > 0);
    const lo = Math.floor((Math.min(...refs) * 0.965) / 50) * 50;
    const hi = Math.ceil((Math.max(...refs) * 1.03) / 50) * 50;
    const step = Math.max(10, Math.round((hi - lo) / 160 / 10) * 10);
    const xs = [];
    for (let s = lo; s <= hi; s += step) xs.push(s);
    for (const r of refs) if (!xs.includes(Math.round(r))) xs.push(Math.round(r));
    xs.sort((a, b) => a - b);
    const opt = xs.map((x) => ({ x, y: Math.round(optAt(x)) }));
    const tot = xs.map((x) => ({ x, y: Math.round(optAt(x) + holdAt(x)) }));
    const bees = xs.map((x) => ({ x, y: Math.round(holdAt(x)) }));
    const ys = [...opt, ...(hold ? tot : [])].map((p) => p.y);
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(0, ...ys);
    const without = view === 'without' || !hold;
    const optSet = { label: 'Without NIFTYBEES (options)', data: opt, borderColor: BT.COLORS[1], borderWidth: 2 };
    const sets = hold
      ? [
          { label: 'With NIFTYBEES', data: tot, borderColor: BT.COLORS[0], borderWidth: 2.5, hidden: without },
          optSet,
          { label: 'NIFTYBEES alone', data: bees, borderColor: BT.COLORS[8], borderWidth: 1, borderDash: [4, 3], hidden: without },
        ]
      : [{ ...optSet, label }];
    for (const m of marks)
      sets.push({
        label: m.label,
        data: [
          { x: m.x, y: yMin },
          { x: m.x, y: yMax },
        ],
        borderColor: m.color || 'rgba(150,160,175,.8)',
        borderWidth: 1,
        borderDash: [2, 3],
        cc_mark: true,
      });
    sets.push({
      label: 'zero',
      data: [
        { x: lo, y: 0 },
        { x: hi, y: 0 },
      ],
      borderColor: 'rgba(150,160,175,.45)',
      borderWidth: 1,
      cc_mark: true,
      cc_hide: true,
    });
    BT.chart(canvas, {
      type: 'line',
      data: { datasets: sets.map((d) => ({ pointRadius: 0, tension: 0, ...d })) },
      options: {
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: lo,
            max: hi,
            ticks: { maxTicksLimit: 10, callback: (v) => Number(v).toLocaleString('en-IN') },
            title: { display: true, text: 'Nifty at expiry' },
          },
          y: { ticks: { callback: (v) => kinr(v) } },
        },
        plugins: {
          legend: { labels: { filter: (i, d) => !d.datasets[i.datasetIndex].cc_hide } },
          tooltip: {
            filter: (i) => !i.dataset.cc_mark,
            callbacks: { title: (i) => 'Nifty ' + Number(i[0].parsed.x).toLocaleString('en-IN'), label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}` },
          },
        },
      },
    });
  }
  const payBox = (id, note) =>
    `<div class="cc-pay"><div class="chart-box cc-pay-chart"><canvas id="${id}"></canvas></div>${note ? `<div class="muted small">${note}</div>` : ''}</div>`;

  // ---------- Strategy & rules ----------
  function renderRules() {
    $('ccBody').innerHTML = `
      <div class="panel cc-doc">
        <h3>Covered call against a Nifty ETF (NIFTYBEES)</h3>
        <p>Read from three threads by Suresh Kumar (@Suresh_kumar047): <i>Covered Call strategy against bees investment</i> (7 Mar 2023, Bank Nifty example),
        <i>Covered call against Nifty bees investment</i> (19 May 2023, Nifty example) and <i>Covered call in Nifty version 2</i> (30 Sep 2023, the extra weekly sells).
        The threads' English is loose; below is what they describe, put as exact rules, and how this app trades them.</p>
        <p class="muted">The idea: hold NIFTYBEES for the long term, rent it out every month by selling a call against it, insure it against a big fall with a cheap put butterfly,
        and use it pledged as margin to sell small "contra" spreads every week. The threads expect about 2 % a month (12–14 % a year from the monthly call; 20 % a year with the weekly sells),
        "without watching the market". Every result here is shown <b>with NIFTYBEES</b> (options + the ETF's own gain or loss) and <b>without it</b> (the options alone, which is how the threads count their income).</p>
      </div>

      <div class="panel cc-doc">
        <h3>1 · Setup (once): buy NIFTYBEES</h3>
        <ol>
          <li><b>Buy NIFTYBEES worth one Nifty lot</b> per lot you want to cover: quantity = lot size × Nifty ÷ NIFTYBEES price.
            Thread: 50 × 18,270 = ₹9,13,500 ÷ ₹200.10 = 4,565 → buy about 4,500. Today's lot is ${meta.lot}: at Nifty 25,000 and NIFTYBEES ₹280 that is ${num0((meta.lot * 25000) / 280)} units, ₹${num0(meta.lot * 25000)}.</li>
          <li>The backtest and the paper trade hold exactly that quantity and value it at <b>NIFTYBEES's own price</b> (its 1-minute history and live quote from Upstox).
            The ETF moves about ₹1 per 100 Nifty points and keeps its dividends, so it slightly beats the index. A day without an ETF price is modelled from Nifty and counted.</li>
          <li><b>Pledge it.</b> After a day the broker gives about 90 % of its value as margin (10 % haircut). Exchanges want half of an option seller's margin in cash,
            so keep cash for that half (the app shows the estimate).</li>
          <li>NIFTYBEES is never sold at a loss: it has no expiry, so a fall is waited out.</li>
        </ol>
      </div>

      <div class="panel cc-doc">
        <h3>2 · Every month (entered at ${esc(params.entryTime)} the session after the monthly expiry)</h3>
        <table class="grid-tbl cc-rules"><thead><tr><th>Leg</th><th>Rule</th><th>Thread's example</th></tr></thead><tbody>
          <tr><th>Covered call</th><td>Sell 1 lot of the monthly call per lot of NIFTYBEES held. Default <b>in the money</b>: the 100-point strike under spot, so the month earns the call's time value even if Nifty does not move. ATM / OTM are options.</td>
            <td>Nifty 18,270: sold June 18,200 CE at 405. Only 70 of it is intrinsic, so 335 points (₹16,750, 1.6 %) are earned if Nifty stays put. Bank Nifty 41,350: sold April 42,000 CE at 700.</td></tr>
          <tr><th>Insurance</th><td><b>Put butterfly 1:2:1</b> under spot: buy 1 put ${params.ins.upperPct}% under spot, sell 2 at ${params.ins.bodyPct}% under, buy 1 as far under the body as the first is above it.
            Limited loss (its small debit). A put debit spread is the alternative; the thread's 1:2 put ratio is <i>not</i> used (unlimited risk).</td>
            <td>18,000 / 17,500 / 17,000 PE (debit about ₹2,200, pays up to ₹22,800 near 17,500). Bank Nifty: 40,500 / 39,500 / 38,500.</td></tr>
        </tbody></table>
      </div>

      <div class="panel cc-doc">
        <h3>Payoff diagram of the month (the Nifty thread's example, at the monthly expiry)</h3>
        <div class="set-row cc-ex" id="ccEx">
          ${exInput('spot', 'Nifty at entry', 18270)}${exInput('lot', 'Lot', 50)}${exInput('bees', 'NIFTYBEES ₹', 200.1)}${exInput('qty', 'NIFTYBEES qty', 4500)}
          ${exInput('k', 'Call strike', 18200)}${exInput('prem', 'Call premium', 405)}
          ${exInput('b1', 'Butterfly buy', 18000)}${exInput('b2', 'sell ×2', 17500)}${exInput('b3', 'buy', 17000)}${exInput('debit', 'Butterfly debit', 44)}
        </div>
        <div class="set-row">${viewSeg()}</div>
        <div class="cc-ex-grid"><div class="tbl-wrap" id="ccExTbl"></div>${payBox('ccExChart')}</div>
        <p class="muted small">NIFTYBEES = quantity × its price change (the thread's 4,500 units at ₹200.10 ≈ ₹49 per Nifty point). The thread counts only the option income ("the bees have no expiry, keep them"); both are shown.</p>
      </div>

      <div class="panel cc-doc">
        <h3>3 · Every weekly series: the contra spread (version 2, "a soldier to my empire")</h3>
        <p class="muted">With the pledged margin, sell a small spread against NIFTYBEES every week, chosen by where Nifty is. Levels of the month:
          <b>call breakeven</b> = call strike + premium received; <b>lower trigger</b> = month's entry − ${params.ovl.lowerPct}%. Thread: entry 19,500, call sold at 300 → breakeven 19,800, trigger 19,200.</p>
        <table class="grid-tbl cc-rules"><thead><tr><th>Where Nifty is (at the weekly entry)</th><th>Thread says</th><th>The app sells (defined risk)</th></tr></thead><tbody>
          <tr><th>Between the trigger and the breakeven (Case 1, sideways)</th><td>Sell a strangle or credit spreads</td><td>Iron condor: call and put credit spreads ${params.ovl.otmPct}% OTM, ${params.ovl.width}-point wings</td></tr>
          <tr><th>Above the call breakeven (Case 2)</th><td>Sell naked puts, a put credit spread or a put ratio</td><td>Put credit spread ${params.ovl.otmPct}% under spot</td></tr>
          <tr><th>Below the lower trigger (Case 3, "market falling continuously")</th><td>Sell calls, a call credit spread or a call ratio</td><td>Call credit spread ${params.ovl.otmPct}% over spot</td></tr>
        </tbody></table>
        <p class="muted small">Opened once per weekly series (the session after the previous weekly expiry, never on its own expiry day), held to expiry, skipped when the credit is under ${params.ovl.minCredit} points.
          The threads also say the weekly sells pay for the insurance ("pledge the bees, sell far options, collect the 4k we paid for the butterfly").</p>
        <div class="set-row" id="ccWk">${exInput('wspot', 'Nifty at the weekly entry', 19500, 'wk')}${exInput('wcr', 'Credit per spread (points)', 30, 'wk')}
          <span class="seg sm" id="ccWkSel">${['range', 'up', 'down'].map((r, i) => `<button data-r="${r}" class="${i ? '' : 'on'}">${REGIME_TRADE[r]}</button>`).join('')}</span></div>
        ${payBox('ccWkChart', 'Payoff of one weekly spread at its expiry, options only (the weekly does not change NIFTYBEES). Strikes from the parameters; the credit is an example.')}
      </div>

      <div class="panel cc-doc">
        <h3>4 · Adjustments</h3>
        <table class="grid-tbl cc-rules"><thead><tr><th>When</th><th>What is done</th><th>Source</th></tr></thead><tbody>
          <tr><th>Nifty stays in a range all month</th><td>Nothing: the call decays to its intrinsic value, the weekly iron condors add their credit. "Enter, forget and book profit."</td><td>Nifty thread, Case 1</td></tr>
          <tr><th>Nifty rises past the call's breakeven</th><td>The call loses, NIFTYBEES gains more. The weekly contra spread switches to <b>put credit spreads</b> (bullish).</td><td>Version 2, Case 2</td></tr>
          <tr><th>Nifty falls under the lower trigger</th><td>The weekly contra spread switches to <b>call credit spreads</b>, every week while it keeps falling.</td><td>Version 2, Case 3; both threads ("sell weekly calls also")</td></tr>
          <tr><th>Nifty falls hard (towards the butterfly body)</th><td>Nothing to do: the whole call premium is kept and the butterfly pays (Case 4: 17,500 → call ₹20,250 + butterfly ₹22,800 = 4 %).</td><td>Nifty thread, Case 4</td></tr>
          <tr><th>Monthly expiry above the call strike</th><td>The call is in effect "called away": <b>book the NIFTYBEES profit</b> (sold and bought back at the new price, so it still covers the next call)${params.roll.bookAbove ? '' : ' (switched off in the parameters)'}.</td><td>Bank Nifty thread, Cases 2–3</td></tr>
          <tr><th>Monthly expiry below the month's entry</th><td>Never sell NIFTYBEES at a loss. <b>Reinvest the month's option profit</b> in more NIFTYBEES ("best average price") — ${esc(REINVEST.find((r) => r[0] === params.roll.reinvest)[1])}.</td><td>Both threads, Cases 3–4</td></tr>
          <tr><th>Every monthly expiry</th><td>Roll: next session, a new monthly call and a new butterfly at the new spot. Repeat every month.</td><td>All threads</td></tr>
        </tbody></table>
      </div>

      <div class="panel cc-doc">
        <h3>What was changed or left out, and why</h3>
        <ul>
          <li><b>Naked options and ratio spreads</b> (naked puts, strangles, 1:2 put / call ratios) have unlimited risk: replaced by credit spreads and iron condors of the same direction.</li>
          <li><b>Daily expiries.</b> In 2023 Nifty, Bank Nifty and Fin Nifty each had a weekly expiry, so version 2 sold "every day". Now only Nifty has a weekly expiry on NSE, so the contra spread is weekly, on Nifty.</li>
          <li><b>Bank Nifty / BANKBEES</b>: same rules, but this app has Nifty option history only, so it trades Nifty against NIFTYBEES.</li>
          <li><b>Monthly vs next-month contract.</b> The threads sometimes sold the next month's call 6–7 weeks out; the history keeps about 5 weeks of each contract, so the app sells the current monthly right after the previous one expires.</li>
          <li>Not modelled: capital-gains tax on booked NIFTYBEES profits, interest on the cash margin.</li>
        </ul>
      </div>`;
    const root = $('ccBody');
    drawExample();
    drawWeekly();
    $('ccEx').addEventListener('input', drawExample);
    $('ccWk').addEventListener('input', drawWeekly);
    $('ccWkSel').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('ccWkSel')
        .querySelectorAll('button')
        .forEach((x) => x.classList.toggle('on', x === b));
      drawWeekly();
    });
    bindView(root, () => {
      root.querySelectorAll('.cc-view button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
      drawExample();
    });
  }
  const exInput = (id, label, v, set = 'ex') => `<label class="lbl">${label}</label><input class="txt num" type="number" data-${set}="${id}" value="${v}">`;
  function readInputs(sel, key) {
    const v = {};
    document.querySelectorAll(sel).forEach((el) => (v[el.dataset[key]] = Number(el.value) || 0));
    return v;
  }
  function drawExample() {
    const v = readInputs('#ccEx [data-ex]', 'ex');
    const legs = [
      { type: 'CE', side: 'S', strike: v.k, qty: v.lot, entry: v.prem },
      { type: 'PE', side: 'B', strike: v.b1, qty: v.lot, entry: v.debit },
      { type: 'PE', side: 'S', strike: v.b2, qty: 2 * v.lot, entry: 0 },
      { type: 'PE', side: 'B', strike: v.b3, qty: v.lot, entry: 0 },
    ];
    const hold = { qty: v.qty, spot: v.spot, bees: v.bees, cost: v.bees };
    const leg = (l, S) => (l.side === 'S' ? 1 : -1) * (l.entry - Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S)) * l.qty;
    const row = (s) => {
      const bees = hold.qty * ((hold.bees * s) / hold.spot - hold.cost);
      const call = leg(legs[0], s);
      const ins = legs.slice(1).reduce((a, l) => a + leg(l, s), 0);
      return { s, bees, call, ins, opt: call + ins, total: bees + call + ins };
    };
    const pts = [...new Set([v.b3, v.b2, v.b1, v.k, v.spot, v.spot + 230, v.k + v.prem, v.spot + 700].map(Math.round))].sort((a, b) => a - b);
    const notional = v.qty * v.bees;
    $('ccExTbl').innerHTML =
      `<table class="grid-tbl"><thead><tr><th>Nifty at expiry</th><th>NIFTYBEES</th><th>Call</th><th>Butterfly</th><th>Without NIFTYBEES</th><th>% of NIFTYBEES</th><th>With NIFTYBEES</th></tr></thead><tbody>${pts
        .map(row)
        .map(
          (r) =>
            `<tr><th>${r.s.toLocaleString('en-IN')}</th><td class="${cls(r.bees)}">${inrS(r.bees)}</td><td class="${cls(r.call)}">${inrS(r.call)}</td><td class="${cls(r.ins)}">${inrS(r.ins)}</td><td class="${cls(r.opt)}"><b>${inrS(r.opt)}</b></td><td>${pct((r.opt / notional) * 100)}</td><td class="${cls(r.total)}"><b>${inrS(r.total)}</b></td></tr>`,
        )
        .join('')}</tbody></table>`;
    payoffChart($('ccExChart'), {
      legs,
      hold,
      marks: [
        { x: v.spot, label: 'Entry ' + num0(v.spot), color: BT.COLORS[2] },
        { x: v.k + v.prem, label: 'Call breakeven ' + num0(v.k + v.prem), color: BT.COLORS[3] },
      ],
    });
  }
  function drawWeekly() {
    const v = readInputs('#ccWk [data-wk]', 'wk');
    const r = $('ccWkSel').querySelector('button.on')?.dataset.r || 'range';
    const o = params.ovl;
    const kp = Math.round((v.wspot * (1 - o.otmPct / 100)) / 50) * 50;
    const kc = Math.round((v.wspot * (1 + o.otmPct / 100)) / 50) * 50;
    const q = o.lots * params.lotSize;
    // the credit split as about 2/3 on the short, 1/3 paid for the wing
    const spread = (type, k, w) => [
      { type, side: 'S', strike: k, qty: q, entry: (v.wcr * 3) / 2 },
      { type, side: 'B', strike: w, qty: q, entry: v.wcr / 2 },
    ];
    const legs = [...(r !== 'down' ? spread('PE', kp, kp - o.width) : []), ...(r !== 'up' ? spread('CE', kc, kc + o.width) : [])];
    payoffChart($('ccWkChart'), { legs, hold: null, marks: [{ x: v.wspot, label: 'Entry ' + num0(v.wspot), color: BT.COLORS[2] }] });
  }

  // ---------- parameters (shared by the backtest and the paper trade) ----------
  const sel = (key, opts, v) =>
    `<select class="txt" data-p="${key}">${opts.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const inp = (key, v, w = 70, step = 'any') => `<input class="txt num" type="number" step="${step}" data-p="${key}" value="${v}" style="width:${w}px">`;
  const chk = (key, v, label) => `<label class="chk"><input type="checkbox" data-p="${key}"${v ? ' checked' : ''}> ${label}</label>`;
  function paramsForm() {
    const p = params;
    return `<div class="cc-params">
      <div class="set-row"><b>NIFTYBEES & call</b>
        <span class="lbl">Lots</span>${inp('lots', p.lots, 55, 1)}<span class="muted small">(NIFTYBEES worth ${p.lots * p.lotSize} Nifty units)</span>
        <span class="lbl">Entry</span><input class="txt" type="time" data-p="entryTime" value="${p.entryTime}">
        <span class="lbl">Call strike</span>${sel('call.rule', CALL_RULES, p.call.rule)}${['itmPts', 'otmPts', 'otmPct'].includes(p.call.rule) ? inp('call.value', p.call.value) : ''}</div>
      <div class="set-row"><b>Insurance</b>${sel('ins.kind', INS, p.ins.kind)}
        ${p.ins.kind !== 'none' ? `<span class="lbl">bought</span>${inp('ins.upperPct', p.ins.upperPct, 55)}<span class="lbl">% under spot, sold</span>${inp('ins.bodyPct', p.ins.bodyPct, 55)}<span class="lbl">% under</span>` : ''}</div>
      <div class="set-row"><b>Weekly contra spread</b>${chk('ovl.on', p.ovl.on, 'on')}
        <span class="lbl">Lots</span>${inp('ovl.lots', p.ovl.lots, 55, 1)}<span class="lbl">Short strikes % OTM</span>${inp('ovl.otmPct', p.ovl.otmPct, 55)}
        <span class="lbl">Wing points</span>${inp('ovl.width', p.ovl.width, 65, 50)}<span class="lbl">Min credit</span>${inp('ovl.minCredit', p.ovl.minCredit, 55)}
        <span class="lbl">Lower trigger % under entry</span>${inp('ovl.lowerPct', p.ovl.lowerPct, 55)}</div>
      <div class="set-row"><b>At the monthly expiry</b>${chk('roll.bookAbove', p.roll.bookAbove, 'book the NIFTYBEES profit when above the strike')}
        <span class="lbl">Reinvest option profit in NIFTYBEES</span>${sel('roll.reinvest', REINVEST, p.roll.reinvest)}</div>
      <div class="set-row"><b>Costs</b><span class="lbl">Slippage %</span>${inp('costs.slippage', p.costs.slippage, 55)}<span class="lbl">Brokerage ₹/order</span>${inp('costs.brokerage', p.costs.brokerage, 55)}
        <span class="lbl">NIFTYBEES charges %</span>${inp('costs.etfPct', p.costs.etfPct, 55)}<span class="lbl">Paper: monthly expiry at least</span>${inp('minDays', p.minDays, 50, 1)}<span class="lbl">days away</span>
        <button class="btn-sm ghost" data-act="defaults">Defaults</button></div>
    </div>`;
  }
  function bindParams(root, onChange) {
    root.querySelectorAll('[data-p]').forEach((el) =>
      el.addEventListener('change', () => {
        const path = el.dataset.p.split('.');
        let o = params;
        while (path.length > 1) o = o[path.shift()];
        o[path[0]] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        BT.store.set('cc-params', params);
        onChange?.();
      }),
    );
    root.querySelector('[data-act="defaults"]')?.addEventListener('click', () => {
      params = { ...deep(meta.defaults), lotSize: meta.lot };
      BT.store.set('cc-params', params);
      onChange?.();
    });
  }

  // ---------- Backtest ----------
  function renderBacktest() {
    const months = meta.monthly || [];
    const from = BT.store.get('cc-from', months[0] || '');
    const to = BT.store.get('cc-to', months[months.length - 1] || '');
    const opts = (v) => months.map((m) => `<option value="${m}"${m === v ? ' selected' : ''}>${dayLabel(m)}</option>`).join('');
    $('ccBody').innerHTML = `
      <div class="panel top-bar">
        ${paramsForm()}
        <div class="set-row cc-run"><b>Months</b><span class="lbl">expiring from</span><select class="txt" id="ccFrom">${opts(from)}</select>
          <span class="lbl">to</span><select class="txt" id="ccTo">${opts(to)}</select>
          <span class="muted small">${months.length} monthly expiries in the history. Months whose contracts (or NIFTYBEES prices) are not cached are downloaded when logged in to Upstox.</span>
          <span class="run-box">${running ? '<button class="btn-sm ghost danger" id="ccStop">Stop</button>' : ''}<button class="btn-sm run" id="ccRun"${running ? ' disabled' : ''}>Run backtest</button></span></div>
        <div class="progress hidden" id="ccProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
        ${runError ? `<div class="err small">${esc(runError)}</div>` : ''}
      </div>
      <div id="ccRes" class="bt-results"></div>`;
    bindParams($('ccBody'), renderBacktest);
    $('ccFrom').addEventListener('change', (e) => BT.store.set('cc-from', e.target.value));
    $('ccTo').addEventListener('change', (e) => BT.store.set('cc-to', e.target.value));
    $('ccRun').addEventListener('click', runBacktest);
    $('ccStop')?.addEventListener('click', () => running && (running.stop = true));
    renderResult();
  }

  async function runBacktest() {
    const months = meta.monthly || [];
    const fromE = $('ccFrom').value;
    const i = months.indexOf(fromE);
    // a month starts the session after the previous monthly expiry
    const from = i > 0 ? months[i - 1] : '';
    const to = $('ccTo').value;
    runError = '';
    running = { stop: false };
    renderBacktest();
    $('ccProg').classList.remove('hidden');
    try {
      let job = await BT.api('/api/cc/backtest', { params, from: from ? nextDay(from) : undefined, to });
      while (job.status === 'running') {
        const p = job.progress || {};
        const box = $('ccProg');
        if (box) {
          box.querySelector('.fill').style.width = p.total ? ((p.done / p.total) * 100).toFixed(1) + '%' : '0';
          box.querySelector('.ptext').textContent = `${p.phase || ''}`;
        }
        if (running.stop && !running.sent) {
          running.sent = true;
          await BT.api('/api/cc/job/stop', { id: job.id });
        }
        await BT.sleep(300);
        job = await BT.api('/api/cc/job?id=' + job.id);
      }
      if (job.status === 'error') throw new Error(job.error);
      saved = job.result;
      open = null;
    } catch (e) {
      runError = e.message;
    }
    running = null;
    if (tab === 'bt') renderBacktest();
  }
  const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);

  function renderResult() {
    const box = $('ccRes');
    if (!saved?.result) {
      box.innerHTML =
        '<div class="panel empty"><h3>No backtest yet</h3><p>Set the parameters and press <b>Run backtest</b>: every monthly cycle of the period is traded on 1-minute history with the rules of the first tab.</p></div>';
      return;
    }
    const r = saved.result;
    if (r.qty0 == null) {
      box.innerHTML =
        '<div class="panel empty"><h3>Saved before NIFTYBEES was priced</h3><p>This result counted the holding as units of Nifty. Press <b>Run backtest</b> to run it again with NIFTYBEES quantity and prices.</p></div>';
      return;
    }
    const s = r.stats;
    const p = r.params;
    const ann = (v) => `${pct(v)} a year`;
    const src = r.beesSource.model
      ? `NIFTYBEES prices for ${r.beesSource.real} sessions, ${r.beesSource.model} modelled from Nifty`
      : `NIFTYBEES at its own prices (${r.beesSource.real} sessions)`;
    box.innerHTML = `
      <div class="panel res-head">
        <div class="res-title"><b>Covered call · ${dayLabel(r.from)} → ${dayLabel(r.to)}</b>
          <span class="muted small">${s.months} months · bought ${num0(r.qty0)} NIFTYBEES at ${rupee(r.bees0)} = ${kinr(s.initialCost)} (Nifty ${num0(r.spot0)}, covers ${p.lots} lot${p.lots > 1 ? 's' : ''} = ${r.units} units) · ${src} ·
          call ${esc(CALL_RULES.find((c) => c[0] === p.call.rule)[1])} · ${esc(INS.find((c) => c[0] === p.ins.kind)[1])} · weekly spreads ${p.ovl.on ? 'on' : 'off'} · slippage ${p.costs.slippage}% · run ${new Date(saved.at).toLocaleString('en-IN')}</span></div>
        <div class="kpis cc-kpis-main">
          ${tile('P&L with NIFTYBEES', inrS(s.total), `${ann(s.totalPctYear)} on ${kinr(s.initialCost)} · max drawdown ${inr(s.ddTotal.dd)}`, cls(s.total))}
          ${tile('P&L without NIFTYBEES', inrS(s.opt), `options only · ${ann(s.optPctYear)} · avg ${pct(s.avgOptPct, 2)} a month · drawdown ${inr(s.ddOpt.dd)}`, cls(s.opt))}
          ${tile('NIFTYBEES part', inrS(s.hold), `${ann(s.holdPctYear)} · ${num0(r.qty0)} → ${num0(s.qtyEnd)} units`, cls(s.hold))}
          ${tile('Buy and hold NIFTYBEES', inrS(s.bh), `${ann(s.bhPctYear)} · same ${num0(r.qty0)} units, no options · drawdown ${inr(s.ddBh.dd)}`, cls(s.bh))}
        </div>
        <div class="kpis">
          ${tile('Added by the options', inrS(s.edge), `vs buy and hold · better in ${s.beatMonths} of ${s.months} months`, cls(s.edge))}
          ${tile('Months with option profit', `${s.optMonthsUp} / ${s.months}`, `best ${kinr(s.bestOpt)} · worst ${kinr(s.worstOpt)}`)}
          ${tile('Call / insurance / weekly', `${kinr(s.call)} / ${kinr(s.ins)} / ${kinr(s.ovl)}`, `charges ${kinr(-s.costs)}`)}
          ${tile('Weekly spreads', `${s.ovlWins} / ${s.ovlWeeks} won`, s.ovlSkipped ? s.ovlSkipped + ' weeks skipped' : '')}
          ${tile('Booked / reinvested', `${kinr(s.booked)} / ${kinr(s.reinvested)}`, 'NIFTYBEES profit booked / option profit put into NIFTYBEES')}
          ${tile('Margin (est.)', kinr(s.maxMargin), `cash half ≈ ${kinr(s.maxCash)}; the pledged NIFTYBEES cover the rest`)}
        </div>
        <div class="muted small cc-verdict">${verdict(s)}</div>
      </div>
      <div class="panel"><div class="set-row pad">${viewSeg()}<span class="muted small">Cumulative P&L, daily close</span></div><div class="chart-box eq tall"><canvas id="ccEq"></canvas></div></div>
      <div class="panel"><div class="tbl-wrap"><table class="grid-tbl cc-months"><thead><tr>
        <th>Month</th><th>Nifty in → out</th><th>NIFTYBEES in → out</th><th class="cc-legs-h">Call &amp; insurance<br><span class="muted">strike · sold / bought at → settled</span></th><th>Call</th><th>Insurance</th><th>Weekly</th><th>Charges</th>
        <th class="cc-col-opt">Without NIFTYBEES</th><th>% of NIFTYBEES</th><th>NIFTYBEES P&amp;L</th><th class="cc-col-tot">With NIFTYBEES</th><th>Buy &amp; hold</th><th>After expiry</th>
      </tr></thead><tbody>${r.cycles.map((c) => monthRow(c)).join('')}</tbody></table></div>
      <div class="muted small pad"><b>▶ Replay in Builder</b> opens a month in the Builder at its entry minute to step through it (the call, insurance and every weekly spread at the backtest's prices) and try adjustments. Click a month for its payoff diagram, legs, weekly spreads and events.</div></div>
      ${r.notes.length ? `<div class="panel cc-doc"><h3>Data notes</h3><ul class="small">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel cc-doc"><details><summary><b>Every event (${r.events.length})</b></summary>${eventsTable(r.events)}</details></div>`;
    drawEquity($('ccEq'), r.equity);
    bindView(box, renderResult);
    box.querySelectorAll('[data-sbm]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        replayToBuilder(r.cycles.find((x) => x.expiry === b.dataset.sbm));
      }),
    );
    box.querySelectorAll('[data-sbw]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const [mo, i] = b.dataset.sbw.split('|');
        const c = r.cycles.find((x) => x.expiry === mo);
        replayToBuilder(c, c.weeks[Number(i)]);
      }),
    );
    box.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', () => {
        open = open === tr.dataset.m ? null : tr.dataset.m;
        openPay = 'month';
        renderResult();
      }),
    );
    const c = open && r.cycles.find((x) => x.expiry === open);
    if (c) {
      box.querySelectorAll('[data-pay]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          openPay = b.dataset.pay;
          renderResult();
        }),
      );
      drawMonthPayoff(c);
    }
  }
  function verdict(s) {
    return (
      `Without NIFTYBEES the options earned ${pct(s.optPctYear)} a year on its cost (the threads expect 12–20 %). ` +
      `With NIFTYBEES the strategy made ${inrS(s.total)} (${pct(s.totalPctYear)} a year), ${s.edge >= 0 ? inr(s.edge) + ' more' : inr(-s.edge) + ' less'} than holding the same NIFTYBEES without options (${inrS(s.bh)}); ` +
      `deepest drawdown ${inr(s.ddTotal.dd)} against ${inr(s.ddBh.dd)}. The covered call caps the upside: in strong rising months it trails buy and hold. One period of history; not a forecast.`
    );
  }
  function monthRow(c) {
    const mo = c.expiry;
    const isOpen = open === mo;
    const after =
      [c.booked ? `booked ${kinr(c.booked)}` : '', c.reinvestQty ? `+${num0(c.reinvestQty)} NIFTYBEES (${kinr(c.reinvested)})` : '']
        .filter(Boolean)
        .join(', ') || '—';
    const row = `<tr data-m="${mo}" class="cc-click${isOpen ? ' on' : ''}">
      <th class="cc-month-cell">${isOpen ? '▾' : '▸'} ${dayLabel(mo)}${c.call ? `<div><button class="btn-sm ghost cc-replay" data-sbm="${mo}" title="Replay this month in the Builder from its entry: the call and insurance at the backtest's fills, each weekly spread opened and settled on its days, the month settled at expiry (options only: NIFTYBEES is not in the Builder)">▶ Replay in Builder</button></div>` : ''}</th><td>${num0(c.spotIn)} → ${num0(c.spotOut)}</td><td>${rupee(c.beesIn)} → ${rupee(c.beesOut)}</td>
      <td class="cc-legs">${c.call ? legLines([c.call, ...c.ins]) : '<span class="neg">no call data</span>'}</td>
      <td class="${cls(c.callPnl)}">${inrS(c.callPnl)}</td><td class="${cls(c.insPnl)}">${c.ins.length ? inrS(c.insPnl) : '—'}</td>
      <td class="${cls(c.ovlPnl)}">${c.weeks.length ? inrS(c.ovlPnl) : '—'}</td><td class="neg">${inr(-c.costs)}</td>
      <td class="${cls(c.optNet)} cc-col-opt"><b>${inrS(c.optNet)}</b></td><td>${pct((c.optNet / (c.qtyIn * c.beesIn)) * 100, 2)}</td>
      <td class="${cls(c.holdPnl)}">${inrS(c.holdPnl)}</td><td class="${cls(c.total)} cc-col-tot"><b>${inrS(c.total)}</b></td><td class="${cls(c.bh)}">${inrS(c.bh)}</td><td class="muted">${after}</td>
</tr>`;
    if (!isOpen) return row;
    const ev = saved.result.events.filter((e) => e.day >= c.start && e.day <= c.expiry && e.kind !== 'hold');
    const traded = c.weeks.map((w, i) => [w, i]).filter(([w]) => w.legs?.length);
    return (
      row +
      `<tr class="cc-detail"><td colspan="15"><div class="cc-month">
        ${c.call ? `<div class="cc-month-head"><button class="btn-sm" data-sbm="${mo}" title="Replay this month in the Builder from its entry: the call and insurance at the backtest's fills, each weekly spread opened and settled on its days, the month settled at expiry (options only: NIFTYBEES is not in the Builder)">▶ Replay this month in Builder</button><span class="muted small">Steps through ${dayLabel(c.start)} → ${dayLabel(c.expiry)} at the backtest's fills; the weekly spreads open and settle as steps of the replay. Each weekly spread below has its own ▶ Replay.</span></div>` : ''}
        <div class="cc-month-pay"><h4>Payoff diagram</h4>
          <div class="set-row"><span class="seg sm">
            <button data-pay="month" class="${openPay === 'month' ? 'on' : ''}">Month: NIFTYBEES + call + insurance</button>
            ${traded.map(([w, i]) => `<button data-pay="${i}" class="${String(openPay) === String(i) ? 'on' : ''}">Week to ${dayLabel(w.expiry)}</button>`).join('')}
          </span></div>
          ${payBox('ccMonthPay', openPay === 'month' ? `At the monthly expiry ${dayLabel(c.expiry)}; NIFTYBEES from ${rupee(c.beesIn)} (${num0(c.qtyIn)} units) moving with Nifty. Lines: entry, call breakeven, lower trigger, Nifty at expiry.` : 'The weekly spread at its expiry (options only; it does not change NIFTYBEES). Lines: entry and Nifty at its expiry.')}
        </div>
        <div><h4>Monthly legs (${c.expiry})</h4>${legsTable(legGroups(c, saved.result.params.ins.kind))}
          <div class="muted small">NIFTYBEES ${num0(c.qtyIn)} units ${rupee(c.beesIn)} → ${rupee(c.beesOut)}: ${inrS(c.holdChange)} · call breakeven ${c.callBE ? num0(c.callBE) : '—'} · lower trigger ${num0(c.lower)} ·
          margin ≈ ${kinr(c.margin.margin)} (cash half ${kinr(c.margin.cash)}, pledge gives ${kinr(c.margin.collateral)})</div>
          ${c.notes.length ? `<div class="err small">${c.notes.map(esc).join('<br>')}</div>` : ''}</div>
        <div class="cc-month-wk"><h4>Weekly contra spreads</h4><div class="tbl-wrap">${weeksTable(c.weeks, mo)}</div></div>
        <div class="cc-month-ev"><h4>Events</h4>${eventsTable(ev)}</div></div></td></tr>`
    );
  }
  function drawMonthPayoff(c) {
    const canvas = $('ccMonthPay');
    if (!canvas) return;
    if (openPay === 'month') {
      const marks = [{ x: c.spotIn, label: 'Entry ' + num0(c.spotIn), color: BT.COLORS[2] }];
      if (c.callBE) marks.push({ x: c.callBE, label: 'Call breakeven ' + num0(c.callBE), color: BT.COLORS[3] });
      marks.push({ x: c.lower, label: 'Lower trigger ' + num0(c.lower), color: BT.COLORS[4] });
      marks.push({ x: c.spotOut, label: 'Expiry ' + num0(c.spotOut), color: BT.COLORS[6] });
      payoffChart(canvas, { legs: [c.call, ...c.ins].filter(Boolean), hold: { qty: c.qtyIn, spot: c.spotIn, bees: c.beesIn, cost: c.beesIn }, marks });
    } else {
      const w = c.weeks[Number(openPay)];
      const marks = [{ x: w.spot, label: 'Entry ' + num0(w.spot), color: BT.COLORS[2] }];
      if (w.spotOut) marks.push({ x: w.spotOut, label: 'Expiry ' + num0(w.spotOut), color: BT.COLORS[6] });
      payoffChart(canvas, { legs: w.legs, hold: null, marks });
    }
  }
  // groups: [{ title, legs }], each drawn under its own heading row with its P&L subtotal (a plain list of legs is
  // one untitled group); marks: the paper trade's live marks (LTP column) or none (the settled price of a backtest).
  function legsTable(groups, marks) {
    if (groups.length && groups[0].strike != null) groups = [{ title: null, legs: groups }];
    groups = groups.map((g) => ({ ...g, legs: g.legs.filter(Boolean) })).filter((g) => g.legs.length);
    if (!groups.length) return '<div class="muted small">None</div>';
    const m = new Map((marks || []).map((x) => [x.id, x]));
    const row = (l) => {
      const mk = m.get(l.id);
      const px = marks ? mk?.ltp : l.exit;
      const pnl = marks ? mk?.pnl : l.exit == null ? null : (l.side === 'S' ? l.entry - l.exit : l.exit - l.entry) * l.qty;
      return {
        pnl,
        html: `<tr><th class="${l.side === 'S' ? 'neg' : 'pos'}">${legName(l)}</th><td>${dayLabel(l.expiry)}</td><td>${Math.round(l.qty)}</td><td>${l.entry.toFixed(2)}</td><td>${px == null ? '—' : px.toFixed(2)}</td><td class="${cls(pnl)}">${pnl == null ? '—' : inrS(pnl)}</td></tr>`,
      };
    };
    const body = groups
      .map((g) => {
        const rows = g.legs.map(row);
        const sum = rows.every((r) => r.pnl != null) ? rows.reduce((a, r) => a + r.pnl, 0) : null;
        return (
          (g.title ? `<tr class="cc-grp"><th colspan="5">${g.title}</th><td class="${cls(sum)}">${sum == null ? '' : inrS(sum)}</td></tr>` : '') +
          rows.map((r) => r.html).join('')
        );
      })
      .join('');
    return `<table class="grid-tbl cc-legs-tbl"><thead><tr><th>Leg</th><th>Expiry</th><th>Qty</th><th>Entry</th>${marks ? '<th>LTP</th><th>P&amp;L</th>' : '<th>Settled</th><th>P&amp;L</th>'}</tr></thead><tbody>${body}</tbody></table>`;
  }
  // A month's legs in their three parts: the covered call, its insurance and the weekly contra spread (if open).
  const insTitle = (kind) => `Insurance · ${kind === 'debit' ? 'put debit spread' : 'put butterfly 1:2:1'}`;
  const legGroups = (c, insKind, ovl = null) => [
    { title: 'Covered call · sold against NIFTYBEES', legs: [c.call] },
    { title: insTitle(insKind), legs: c.ins },
    ...(ovl ? [{ title: `Weekly contra spread · ${REGIME_TRADE[ovl.regime] || ''} to ${dayLabel(ovl.expiry)}`, legs: ovl.legs }] : []),
  ];
  // month: the backtest month's expiry, for the weekly "Test in Builder" buttons (none in the paper trade)
  function weeksTable(weeks, month = null) {
    if (!weeks.length) return '<div class="muted small">None this month</div>';
    return `<table class="grid-tbl"><thead><tr><th>Expiry</th><th>Entered</th><th>Nifty in → out</th><th>Where</th><th>Spread</th><th class="cc-legs-h">Legs: sold / bought at → settled</th><th>Credit</th><th>P&amp;L</th>${month ? '<th></th>' : ''}</tr></thead><tbody>${weeks
      .map(
        (w) =>
          `<tr><th>${dayLabel(w.expiry)}</th><td>${dayLabel(w.entry)}</td><td>${w.spot ? num0(w.spot) : '—'}${w.spotOut ? ' → ' + num0(w.spotOut) : ''}</td><td>${REGIME[w.regime] || '—'}</td>
          <td>${
            w.skipped
              ? `<span class="muted">skipped: ${esc(w.skipped)}</span>`
              : w.legs
                  .filter((l) => l.side === 'S')
                  .map((l) => l.strike + ' ' + l.type)
                  .join(' + ') +
                ' (' +
                REGIME_TRADE[w.regime] +
                ')'
          }</td>
          <td class="cc-legs">${w.legs?.length ? legLines(w.legs) : '—'}</td>
          <td>${w.credit == null ? '—' : w.credit.toFixed(1)}</td><td class="${cls(w.pnl)}">${w.pnl == null ? (w.legs ? 'open' : '—') : inrS(w.pnl)}</td>${
            month
              ? `<td>${w.legs?.length ? `<button class="btn-sm ghost cc-sb" data-sbw="${month}|${weeks.indexOf(w)}" title="Replay this weekly spread in the Builder from its entry to its expiry">▶ Replay</button>` : ''}</td>`
              : ''
          }</tr>`,
      )
      .join('')}</tbody></table>`;
  }
  // Each leg on its own line: side, strike, type, the fill it was sold / bought at and where it settled.
  function legLines(legs) {
    return legs
      .filter(Boolean)
      .map(
        (l) =>
          `<div class="cc-leg"><b class="${l.side === 'S' ? 'neg' : 'pos'}">${l.side === 'S' ? 'Sold' : 'Bought'}</b> ${l.qty > (saved?.result?.units || l.qty) ? Math.round(l.qty / saved.result.units) + '× ' : ''}${l.strike} ${l.type} <span class="mono">${l.entry.toFixed(2)} → ${l.exit == null ? 'open' : l.exit.toFixed(2)}</span></div>`,
      )
      .join('');
  }

  // ---------- backtest month / week to the Builder (historical replay) ----------
  // The month's call and insurance at the backtest's fills from its entry, and a plan the Builder repeats as the replay
  // reaches it: each weekly spread opened at its entry and settled at its expiry, the month settled at its expiry. The
  // Builder holds options only, so its P&L is the month "without NIFTYBEES".
  function replayToBuilder(c, week = null) {
    const r = saved.result;
    const p = r.params;
    const lot = p.lotSize;
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this replay?')) return;
    const leg = (l) => ({
      action: l.side,
      type: l.type,
      strike: l.strike,
      expiry: l.expiry,
      lots: Math.max(1, Math.round(l.qty / lot)),
      qty: l.qty,
      px: l.entry,
    });
    const op = (kind, l) => ({
      op: kind,
      action: l.side,
      type: l.type,
      strike: l.strike,
      expiry: l.expiry,
      qty: l.qty,
      lot,
      px: kind === 'open' ? l.entry : l.exit,
    });
    const settle = (w) => ({
      day: w.expiry,
      time: '15:29',
      title: `Weekly spread to ${dayLabel(w.expiry)} expires`,
      why: `Settled at its intrinsic value at the close (Nifty ${w.spotOut ? num0(w.spotOut) : '—'}): ${w.pnl == null ? '' : inrS(w.pnl) + ' after charges in the backtest'}.`,
      ops: w.legs.map((l) => op('close', l)),
    });
    const weekOpen = (w) => ({
      day: w.entry,
      time: p.entryTime,
      title: `Weekly contra spread: ${REGIME_TRADE[w.regime]} to ${dayLabel(w.expiry)}`,
      why: `Nifty ${num0(w.spot)} is ${REGIME[w.regime].toLowerCase()} (call breakeven ${c.callBE ? num0(c.callBE) : '—'}, lower trigger ${num0(c.lower)}), so the rules sell a ${REGIME_TRADE[w.regime]} for ${w.credit} points.`,
      ops: w.legs.map((l) => op('open', l)),
    });
    let o;
    if (week) {
      o = {
        expiry: week.expiry,
        day: week.entry,
        legs: week.legs.map(leg),
        plan: [settle(week)],
        note: `Covered call backtest · weekly ${REGIME_TRADE[week.regime]} to ${dayLabel(week.expiry)} · ended ${inrS(week.pnl)}`,
        bt: { net: week.pnl, gross: week.pnl, costs: 0 },
      };
    } else {
      const monthly = [c.call, ...c.ins].filter(Boolean);
      const weeks = c.weeks.filter((w) => w.legs?.length);
      // a spread opened at the replay's first minute goes in with the month's legs (the Builder plays steps after it)
      const atStart = (w) => w.entry === c.start;
      o = {
        expiry: c.expiry,
        day: c.start,
        legs: [...monthly, ...weeks.filter(atStart).flatMap((w) => w.legs)].map(leg),
        plan: [
          ...weeks.flatMap((w) => (atStart(w) ? [settle(w)] : [weekOpen(w), settle(w)])),
          {
            day: c.expiry,
            time: '15:29',
            title: 'Monthly expiry: settle the call and insurance',
            why: `Settled at their intrinsic value at the close (Nifty ${num0(c.spotOut)}). Then the backtest ${c.booked ? 'booked the NIFTYBEES profit' : c.reinvestQty ? `bought ${num0(c.reinvestQty)} more NIFTYBEES` : 'kept NIFTYBEES'} and rolled to the next month.`,
            ops: monthly.map((l) => op('close', l)),
          },
        ],
        note: `Covered call backtest · month to ${dayLabel(c.expiry)} · options only (NIFTYBEES ${num0(c.qtyIn)} not in the Builder) · option net ${inrS(c.optNet)}`,
        bt: { net: c.optNet, gross: c.optNet + c.costs, costs: c.costs },
      };
    }
    BT.emit('open-builder', { src: 'hist', time: p.entryTime, session: 'multi', lot, ...o });
  }
  function eventsTable(evs) {
    if (!evs.length) return '<div class="muted small">None</div>';
    return `<div class="tbl-wrap cc-ev"><table class="grid-tbl"><tbody>${evs
      .map(
        (e) =>
          `<tr><th>${e.t ? when(e.t) : dayLabel(e.day) + ' ' + (e.time || '')}</th><td><span class="cc-kind k-${e.kind}">${KIND[e.kind] || e.kind}</span></td><td class="cc-ev-text">${esc(e.text)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  }
  // Cumulative P&L: with NIFTYBEES (and its NIFTYBEES part and buy and hold beside it) or without (the options alone).
  function drawEquity(canvas, eq) {
    const w = view === 'with';
    const holdOf = (e) => e.hold ?? e.eq - e.opt;
    BT.chart(canvas, {
      type: 'line',
      data: {
        labels: eq.map((e) => e.d),
        datasets: [
          { label: 'With NIFTYBEES', data: eq.map((e) => e.eq), borderColor: BT.COLORS[0], pointRadius: 0, borderWidth: 2, hidden: !w },
          { label: 'Without NIFTYBEES (options only)', data: eq.map((e) => e.opt), borderColor: BT.COLORS[1], pointRadius: 0, borderWidth: w ? 1.5 : 2.5 },
          { label: 'NIFTYBEES part', data: eq.map(holdOf), borderColor: BT.COLORS[8], pointRadius: 0, borderWidth: 1, borderDash: [4, 3], hidden: !w },
          {
            label: 'Buy and hold NIFTYBEES',
            data: eq.map((e) => e.bh),
            borderColor: BT.COLORS[3],
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [2, 2],
            hidden: !w,
          },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { ticks: { maxTicksLimit: 12, callback: (v, i) => dayLabel(eq[i].d) } }, y: { ticks: { callback: (x) => kinr(x) } } },
        plugins: { tooltip: { callbacks: { title: (i) => dayLabel(i[0].label), label: (c) => `${c.dataset.label}: ${inrS(c.raw)}` } } },
      },
    });
  }

  // ---------- Paper trade ----------
  async function loadPaper() {
    try {
      paper = await BT.api('/api/cc/paper');
      paperError = '';
    } catch (e) {
      paperError = e.message;
    }
  }
  async function paperAct(path, body = {}) {
    try {
      paper = await BT.api('/api/cc/paper/' + path, body);
      paperError = '';
    } catch (e) {
      paperError = e.message;
    }
    renderPaper(false);
  }
  async function loadSugg() {
    try {
      sugg = await BT.api('/api/cc/suggest', { params });
      suggError = '';
    } catch (e) {
      suggError = e.message;
    }
  }
  async function renderPaper(fresh = true) {
    if (fresh) await Promise.all([loadPaper(), loadSugg()]);
    if (tab !== 'paper') return;
    const P = paper?.paper;
    const L = paper?.live;
    const err = paperError || paper?.error;
    const head = `<div class="panel top-bar"><div class="set-row"><b>Live paper trade</b>
        <span class="muted small">${paper?.demo ? 'Demo data (NIFTYBEES modelled from the demo Nifty). ' : ''}Follows the rules on the live chain and NIFTYBEES's live price, checked every 30 s while the market is open (${paper?.marketOpen ? '<span class="pos">open now</span>' : 'closed now'}). Paper only: no orders are placed.</span>
        <span class="run-box">${
          !P
            ? '<button class="btn-sm run" data-pa="start">Start paper trade</button>'
            : `${P.status === 'running' ? '<button class="btn-sm ghost" data-pa="pause">Pause</button>' : '<button class="btn-sm" data-pa="resume">Resume</button>'}<button class="btn-sm ghost danger" data-pa="reset">Reset…</button>`
        }</span></div>${err ? `<div class="err small">${esc(err)}</div>` : ''}</div>`;
    if (!P) {
      $('ccBody').innerHTML =
        head +
        `<div class="panel top-bar">${paramsForm()}</div><div id="ccSugg"></div><div class="panel empty"><h3>Not started</h3><p>Start uses the parameters above. At the first check from ${esc(params.entryTime)} on a market day it buys NIFTYBEES (on paper, at its live price),
        sells the monthly call on the first monthly expiry at least ${params.minDays} days away and buys the insurance; then it opens one weekly contra spread per series and settles everything at expiry, rolling every month.</p></div>`;
      bindParams($('ccBody'), () => loadSugg().then(() => renderPaper(false)));
    } else {
      const c = P.cycle;
      const h = P.holding;
      const legs = c ? [c.call, ...c.ins, ...(c.ovl ? c.ovl.legs : [])].filter(Boolean) : [];
      const pp = P.params;
      const avg = h.qty ? h.cost / h.qty : null;
      const closed = paperOpen != null ? P.cycles.find((x) => x.expiry === paperOpen) : null;
      $('ccBody').innerHTML =
        head +
        `<div class="panel res-head">
          <div class="res-title"><b>${P.status === 'running' ? '<span class="pos">● Running</span>' : '<span class="muted">❚❚ Paused</span>'} since ${new Date(P.startedAt).toLocaleString('en-IN')}</b>
            <span class="muted small">${pp.lots} lot${pp.lots > 1 ? 's' : ''} × ${pp.lotSize} · call ${esc(CALL_RULES.find((x) => x[0] === pp.call.rule)[1])} · ${esc(INS.find((x) => x[0] === pp.ins.kind)[1])} · weekly spreads ${pp.ovl.on ? 'on' : 'off'}${L ? ` · marked ${when(L.at)}${paper.marketOpen ? '' : ' (market closed: last traded prices)'}` : ' · not marked yet'}</span></div>
          ${
            L
              ? `<div class="kpis cc-kpis-main">
            ${tile('P&L with NIFTYBEES', inrS(L.eq), 'options + NIFTYBEES, marked now', cls(L.eq))}
            ${tile('P&L without NIFTYBEES', inrS(L.opt), `options only · open legs ${inrS(L.mtm)}`, cls(L.opt))}
            ${tile('NIFTYBEES part', inrS(L.hold), `on the units held now ${inrS(L.holdOpen)}`, cls(L.hold))}
            ${tile('Buy and hold NIFTYBEES', inrS(L.bh), 'same units, no options', cls(L.bh))}
          </div>`
              : ''
          }
          <div class="kpis">
            ${tile('NIFTYBEES held', h.qty ? num0(h.qty) : '0', avg ? `avg ${rupee(avg)} · ${L ? `LTP ${rupee(L.bees.px)}${L.bees.real ? '' : ' (modelled)'}` : ''}` : 'bought at the first entry')}
            ${L ? tile('Nifty', L.spot.toLocaleString('en-IN'), L.regime ? REGIME[L.regime] + ' → ' + REGIME_TRADE[L.regime] : '') : ''}
            ${c?.call ? tile('Levels', `${num0(c.callBE)} / ${num0(c.lower)}`, 'call breakeven / lower trigger') : ''}
            ${L ? tile('Margin (est.)', kinr(L.margin.margin), `cash half ${kinr(L.margin.cash)} · pledge gives ${kinr(L.margin.collateral)}`) : ''}
            ${L?.month ? tile(`This month (to ${dayLabel(L.month.expiry)})`, inrS(L.month.total), `without NIFTYBEES ${inrS(L.month.opt)} · NIFTYBEES ${inrS(L.month.hold)}`, cls(L.month.total)) : ''}
            ${tile('Booked / reinvested', `${kinr(h.booked)} / ${kinr(h.reinvested)}`, `${P.cycles.length} month${P.cycles.length === 1 ? '' : 's'} closed`)}
          </div>
          <div class="muted small">${esc(paper.next || '')}</div>
        </div>
        <div class="panel cc-doc"><h3>Position${c ? ` · month to ${dayLabel(c.expiry)}` : ''}${L ? ` <span class="muted small">· prices at ${when(L.at)}</span>` : ''}</h3>
          ${h.qty ? `<div class="small">NIFTYBEES: ${num0(h.qty)} units at avg ${rupee(avg)} = ${inr(h.cost)}${L ? `, now ${rupee(L.bees.px)} = ${inr(h.qty * L.bees.px)} (<span class="${cls(L.holdOpen)}">${inrS(L.holdOpen)}</span>)` : ''}</div>` : '<div class="muted small">No NIFTYBEES yet.</div>'}
          <div class="cc-pos-grid"><div>${c ? legsTable(legGroups(c, pp.ins.kind, c.ovl), L?.legs || []) : '<div class="muted small">No position yet.</div>'}
            ${c?.weeks.length ? `<h4>Weekly spreads this month</h4>${weeksTable(c.weeks)}` : ''}</div>
            ${legs.length && L ? `<div><h4>Payoff diagram (now)</h4><div class="set-row">${viewSeg()}</div>${payBox('ccPaperPay', `Each leg at its own expiry; NIFTYBEES from its price now (${rupee(L.bees.px)}) moving with Nifty, against its average cost. Lines: Nifty now, call breakeven, lower trigger.`)}</div>` : ''}
          </div>
        </div>
        <div id="ccSugg"></div>
        ${P.equity.length > 1 ? `<div class="panel"><div class="set-row pad">${viewSeg()}<span class="muted small">Cumulative P&L, one point a day</span></div><div class="chart-box eq"><canvas id="ccPaperEq"></canvas></div></div>` : ''}
        ${
          P.cycles.length
            ? `<div class="panel"><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Month</th><th>Nifty in → out</th><th>NIFTYBEES in → out</th><th>Call</th><th>Insurance</th><th>Weekly</th><th>Charges</th><th class="cc-col-opt">Without NIFTYBEES</th><th>NIFTYBEES P&amp;L</th><th class="cc-col-tot">With NIFTYBEES</th><th>After expiry</th></tr></thead><tbody>${P.cycles
                .map(
                  (x) =>
                    `<tr data-pm="${x.expiry}" class="cc-click${paperOpen === x.expiry ? ' on' : ''}"><th>${paperOpen === x.expiry ? '▾' : '▸'} ${dayLabel(x.expiry)}</th><td>${num0(x.spotIn)} → ${num0(x.spotOut)}</td><td>${rupee(x.beesIn)} → ${rupee(x.beesOut)}</td><td class="${cls(x.callPnl)}">${inrS(x.callPnl)}</td><td class="${cls(x.insPnl)}">${inrS(x.insPnl)}</td><td class="${cls(x.ovlPnl)}">${inrS(x.ovlPnl)}</td><td class="neg">${inr(-x.costs)}</td><td class="${cls(x.optNet)} cc-col-opt"><b>${inrS(x.optNet)}</b></td><td class="${cls(x.holdPnl)}">${inrS(x.holdPnl)}</td><td class="${cls(x.total)} cc-col-tot"><b>${inrS(x.total)}</b></td><td class="muted">${[x.booked ? 'booked ' + kinr(x.booked) : '', x.reinvestQty ? `+${num0(x.reinvestQty)} NIFTYBEES` : ''].filter(Boolean).join(', ') || '—'}</td></tr>`,
                )
                .join('')}</tbody></table></div>
              ${closed ? `<div class="pad"><h4>Payoff diagram · month to ${dayLabel(closed.expiry)}</h4>${payBox('ccPaperClosedPay', "At the monthly expiry; NIFTYBEES from its price at the month's entry. Lines: entry, call breakeven, Nifty at expiry.")}</div>` : '<div class="muted small pad">Click a month for its payoff diagram.</div>'}</div>`
            : ''
        }
        <div class="panel cc-doc"><h3>Log</h3>${eventsTable([...P.log].reverse())}</div>`;
      if (P.equity.length > 1) drawEquity($('ccPaperEq'), P.equity);
      if (legs.length && L)
        payoffChart($('ccPaperPay'), {
          legs,
          hold: h.qty ? { qty: h.qty, spot: L.spot, bees: L.bees.px, cost: avg } : null,
          marks: [
            { x: L.spot, label: 'Nifty now ' + num0(L.spot), color: BT.COLORS[2] },
            ...(c?.callBE ? [{ x: c.callBE, label: 'Call breakeven ' + num0(c.callBE), color: BT.COLORS[3] }] : []),
            ...(c?.lower ? [{ x: c.lower, label: 'Lower trigger ' + num0(c.lower), color: BT.COLORS[4] }] : []),
          ],
        });
      if (closed)
        payoffChart($('ccPaperClosedPay'), {
          legs: [closed.call, ...closed.ins].filter(Boolean),
          hold: { qty: closed.qtyIn, spot: closed.spotIn, bees: closed.beesIn, cost: closed.beesIn },
          marks: [
            { x: closed.spotIn, label: 'Entry ' + num0(closed.spotIn), color: BT.COLORS[2] },
            ...(closed.callBE ? [{ x: closed.callBE, label: 'Call breakeven ' + num0(closed.callBE), color: BT.COLORS[3] }] : []),
            { x: closed.spotOut, label: 'Expiry ' + num0(closed.spotOut), color: BT.COLORS[6] },
          ],
        });
      $('ccBody')
        .querySelectorAll('tr[data-pm]')
        .forEach((tr) =>
          tr.addEventListener('click', () => {
            paperOpen = paperOpen === tr.dataset.pm ? null : tr.dataset.pm;
            renderPaper(false);
          }),
        );
      bindView($('ccBody'), () => renderPaper(false));
    }
    renderSugg();
    $('ccBody')
      .querySelectorAll('[data-pa]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const a = b.dataset.pa;
          if (a === 'start') paperAct('start', { params });
          else if (a === 'reset') {
            if (confirm('Delete the paper trade, its log and its history?')) paperAct('reset', { confirm: true });
          } else paperAct(a);
        }),
      );
  }

  // ---------- suggestions ----------
  const TAG = {
    rule: ['Rule pick', "The strike the strategy's parameters choose"],
    most: ['Most time value', 'Earns the most if Nifty does not move'],
    best: ['Best ratio', 'Highest payoff for its cost / credit for its risk (weekly: with at least the minimum chance)'],
    held: ['Held', 'The paper trade already holds this for the month'],
  };
  const tags = (t) => t.map((k) => `<span class="cc-tag t-${k}" title="${TAG[k][1]}">${TAG[k][0]}</span>`).join(' ');
  const NOW_KIND = {
    start: ['Do', 'call'],
    hold: ['Hold', 'skip'],
    buy: ['Buy', 'call'],
    sell: ['Sell', 'ovl'],
    roll: ['Roll', 'exp'],
    info: ['Note', 'skip'],
  };
  function renderSugg() {
    const box = $('ccSugg');
    if (!box) return;
    if (!sugg) {
      box.innerHTML = suggError ? `<div class="panel cc-doc"><h3>Suggestions now</h3><div class="err small">${esc(suggError)}</div></div>` : '';
      return;
    }
    const S = sugg;
    // The month the paper trade holds already has its one call and one insurance (the rules buy one of each a month):
    // it is shown as held, today's alternatives for comparison only, and the panel opens on the next month's roll.
    const held = paper?.paper?.cycle || null;
    const rollI = held ? S.months.findIndex((m) => m.expiry > held.expiry) : -1;
    const mi = Math.min(
      suggSel.month ??
        (rollI >= 0
          ? rollI
          : Math.max(
              0,
              S.months.findIndex((m) => !m.tooSoon && m.expiry !== held?.expiry),
            )),
      S.months.length - 1,
    );
    const M = S.months[mi];
    const heldHere = Boolean(held && M && held.expiry === M.expiry);
    const heldCall = heldHere && suggSel.call[M.expiry] == null ? held.call : null;
    const heldIns = heldHere && suggSel.ins[M.expiry] == null && held.ins.length ? held.ins : null;
    const sameStrikes = (c) => heldHere && held.ins.length && c.strikes.join() === held.ins.map((l) => l.strike).join();
    const callK = M ? (suggSel.call[M.expiry] ?? (heldHere ? held.call?.strike : M.pick.call)) : null;
    const insI = M ? (suggSel.ins[M.expiry] ?? (heldHere ? M.ins.findIndex(sameStrikes) : M.pick.ins)) : null;
    const W = S.weekly;
    const wkI = W ? (suggSel.wk?.expiry === W.expiry ? suggSel.wk.i : W.pick) : null;
    const call = M?.calls.find((c) => c.strike === callK);
    const ins = insI != null && insI >= 0 ? M?.ins[insI] : null;
    const net =
      heldCall || heldIns
        ? (heldCall ? heldCall.entry * heldCall.qty : 0) - (heldIns ? heldIns.reduce((a, l) => a + (l.side === 'B' ? l.entry : -l.entry) * l.qty, 0) : 0)
        : (call ? call.fill * S.units : 0) - (ins ? ins.debit : 0);
    const insName = (kind) => (kind === 'debit' ? 'put debit spread' : 'put butterfly');
    const callRows = (M?.calls || [])
      .map(
        (c) =>
          `<tr data-call="${c.strike}" class="cc-click${c.strike === callK ? ' on' : ''}"><th>${c.strike} CE${c.strike < S.spot ? ' <span class="muted small">ITM</span>' : ''}</th><td>${c.ltp.toFixed(2)}</td><td>${c.fill.toFixed(2)}</td><td>${c.timeValue.toFixed(1)}</td>
          <td class="${cls(c.flat)}">${inrS(c.flat)}</td><td>${pct(c.flatPct, 2)} (${pct(c.flatPctYear, 0)})</td><td>${num0(c.breakeven)}</td><td>${num0(c.protectedTo)}</td><td class="${cls(c.maxWith)}">${inrS(c.maxWith)}</td><td>${c.pCapped}%</td><td>${tags([...(heldHere && c.strike === held.call?.strike ? ['held'] : []), ...c.tags])}</td></tr>`,
      )
      .join('');
    const insRows = (M?.ins || [])
      .map(
        (c, i) =>
          `<tr data-ins="${i}" class="cc-click${i === insI ? ' on' : ''}"><th>${c.kind === 'debit' ? 'Debit spread' : 'Butterfly'} ${c.upperPct}/${c.bodyPct}%<div><button class="btn-sm ghost cc-sb" data-sb-ins="${i}" title="Open this insurance as a live paper position in the Builder: watch its price, P&amp;L and payoff, adjust it">Add / watch in Builder ▸</button> <button class="btn-sm kite" data-kite-ins="${i}" title="Buy this insurance on Zerodha Kite: real orders at the prices shown, after you confirm">Trade on Kite</button></div></th><td>${c.strikes.join(' / ')}</td><td class="neg">${inr(-c.debit)}</td><td class="pos">${inrS(c.maxPay)}</td><td>${c.payRatio ?? '—'}×</td>
          <td>${c.zone[0] ? num0(c.zone[0]) + ' – ' : 'under '}${num0(c.zone[1])}</td><td>${c.pZone}%</td><td>${tags([...(sameStrikes(c) ? ['held'] : []), ...c.tags])}</td></tr>`,
      )
      .join('');
    const wkRows = (W?.candidates || [])
      .map(
        (c, i) =>
          `<tr data-wk="${i}" class="cc-click${i === wkI ? ' on' : ''}${c.ok ? '' : ' cc-dim'}"><th>${c.shorts.join(' / ')}</th><td>${c.otmPct}%</td><td>${c.width}</td><td>${c.creditPts.toFixed(1)}</td><td class="pos">${inrS(c.credit)}</td><td class="neg">${inr(-c.maxLoss)}</td><td>${c.ratio ?? '—'}</td><td>${c.pop}%</td><td>${tags(c.tags)}</td></tr>`,
      )
      .join('');
    const monthHtml = M
      ? `<div class="set-row cc-sugg-months"><span class="seg sm" id="ccSuggMonth">${S.months
          .map(
            (m, i) =>
              `<button data-i="${i}" class="${i === mi ? 'on' : ''}">${m.label} · ${dayLabel(m.expiry)} (${m.dte} days)${m.expiry === held?.expiry ? ' · held' : held && m.expiry > held.expiry && i === rollI ? ' · roll' : ''}</button>`,
          )
          .join('')}</span>
          ${M.tooSoon ? `<span class="muted small">Only ${M.dte} days left: under the ${params.minDays}-day minimum, the rules sell the next month.</span>` : ''}<span class="muted small">ATM IV ${M.iv}%</span></div>
        <div class="cc-sugg-grid">
          <div>${
            heldHere && held.call
              ? `<h4>Covered call · held: sell ${held.call.strike} CE at ${held.call.entry.toFixed(2)} (${dayLabel(M.expiry)})</h4>
            <details class="cc-alt"><summary class="muted small">Other strikes at today's prices, for comparison only: the rules sell one call a month</summary>`
              : `<h4>Covered call to sell (${dayLabel(M.expiry)}, ${S.units} units)${held && !heldHere ? ' · next month, after the held one settles' : ''}</h4>`
          }
            <div class="tbl-wrap"><table class="grid-tbl cc-pick"><thead><tr><th>Strike</th><th>LTP</th><th>Sell at</th><th>Time value</th><th>If Nifty unchanged</th><th>% (a year)</th><th>Breakeven</th><th>Covered down to</th><th>Max with NIFTYBEES</th><th>Chance capped</th><th></th></tr></thead><tbody>${callRows}</tbody></table></div>${heldHere && held.call ? '</details>' : ''}</div>
          <div><div class="small cc-sugg-sum">${
            heldCall || heldIns
              ? `Held: ${heldCall ? `sell ${heldCall.strike} CE at ${heldCall.entry.toFixed(2)}` : `sell ${call?.strike} CE (alternative)`}${heldIns ? ` + ${insName(held.ins.length === 3 ? 'butterfly' : 'debit')} ${heldIns.map((l) => l.strike).join('/')}` : ins ? ` + ${insName(ins.kind)} ${ins.strikes.join('/')} (alternative)` : ''} → net credit <b class="${cls(net)}">${inrS(net)}</b> against ${num0(held.qtyIn)} NIFTYBEES`
              : `Selected: ${call ? `sell ${call.strike} CE at ${call.fill}` : 'no call'}${ins ? ` + ${insName(ins.kind)} ${ins.strikes.join('/')}` : ''} → net credit <b class="${cls(net)}">${inrS(net)}</b>${S.qtyBees ? ` against ${num0(S.qtyBees)} NIFTYBEES (${kinr(S.qtyBees * S.bees)})` : ''}`
          }
              ${(call || ins) && !(heldCall && heldIns) ? '<button class="btn-sm ghost cc-sb" data-sb-all="1" title="Open the selected call and insurance together as a live paper position in the Builder">Add / watch both in Builder ▸</button> <button class="btn-sm kite" data-kite-all="1" title="Send the selected call and insurance to Zerodha Kite as real orders (the insurance is bought first, the call sold only after it fills). The call is covered by your NIFTYBEES, which Kite does not check here. Asks you to confirm first.">Trade on Kite</button>' : ''}</div>
            <div class="set-row">${viewSeg()}</div>
            ${payBox(
              'ccSuggPay',
              heldCall || heldIns
                ? `At the ${dayLabel(M.expiry)} expiry: the held call and insurance at their paper prices, with the NIFTYBEES held since ${dayLabel(held.start)}. Open "Other strikes" to compare an alternative. Lines: Nifty now, call breakeven.`
                : `At the ${dayLabel(M.expiry)} expiry: the selected call and insurance${S.qtyBees ? ', with NIFTYBEES bought now' : ''}. Click rows to compare. Lines: Nifty now, call breakeven.`,
            )}</div>
        </div>
        <div class="cc-sugg-grid ins">
          <div>${
            heldHere && held.ins.length
              ? `<h4>Insurance · held: ${insName(held.ins.length === 3 ? 'butterfly' : 'debit')} ${held.ins.map((l) => l.strike).join(' / ')} PE (${dayLabel(M.expiry)})</h4>
            <div class="muted small">One insurance a month: this month's is bought. ${M.ins.length ? "Other structures below at today's prices, for comparison only." : ''}</div>`
              : `<h4>Insurance to buy (${dayLabel(M.expiry)})${held && !heldHere ? ' · next month, after the held one settles' : ''}</h4>`
          }${
            M.ins.length
              ? `${heldHere && held.ins.length ? '<details class="cc-alt"><summary class="muted small">Compare other insurance structures</summary>' : ''}<div class="tbl-wrap"><table class="grid-tbl cc-pick"><thead><tr><th>Structure</th><th>Strikes (PE)</th><th>Debit</th><th>Max pay</th><th>Pay ÷ cost</th><th>Pays between</th><th>Chance it pays</th><th></th></tr></thead><tbody>${insRows}</tbody></table></div>${heldHere && held.ins.length ? '</details>' : ''}`
              : '<div class="muted small">Insurance is switched off in the parameters.</div>'
          }</div>
          <div>${
            heldIns
              ? `<h4>Payoff of the held insurance · ${heldIns.map((l) => l.strike).join(' / ')} PE</h4>
            ${payBox('ccSuggInsPay', `The held insurance legs alone at the ${dayLabel(M.expiry)} expiry, at their paper entry prices. Lines: its bought and sold strikes.`)}`
              : ins
                ? `<h4>Payoff of the insurance · ${ins.kind === 'debit' ? 'debit spread' : 'butterfly'} ${ins.strikes.join(' / ')} PE${heldHere ? ' (alternative)' : ''}</h4>
            ${payBox('ccSuggInsPay', `The insurance legs alone at the ${dayLabel(M.expiry)} expiry: its debit is lost above ${num0(ins.strikes[0])}, it pays the most near ${num0(ins.strikes[1])}. Lines: its bought and sold strikes.`)}`
                : ''
          }</div>
        </div>`
      : '<div class="muted small">No monthly expiry in the live list.</div>';
    const weekHtml = W
      ? `<h4>This week's contra spread · ${dayLabel(W.expiry)} (${W.dte} day${W.dte === 1 ? '' : 's'}) · Nifty ${REGIME[W.regime].toLowerCase()} → ${REGIME_TRADE[W.regime]}</h4>
        <div class="muted small">Levels from ${esc(W.levels.from)}: call breakeven ${num0(W.levels.callBE)}, lower trigger ${num0(W.levels.lower)}. ${W.open ? 'A weekly spread is open: hold it.' : W.done ? 'This series was already traded.' : ''} Greyed rows miss the minimum credit (${params.ovl.minCredit} points) or a ${S.minPop}% chance.</div>
        <div class="cc-sugg-grid"><div class="tbl-wrap"><table class="grid-tbl cc-pick"><thead><tr><th>Short strikes</th><th>OTM</th><th>Wings</th><th>Credit (points)</th><th>Credit</th><th>Max loss</th><th>Credit ÷ max loss</th><th>Chance worthless</th><th></th></tr></thead><tbody>${wkRows}</tbody></table></div>
          ${payBox('ccSuggWkPay', 'The selected weekly spread at its expiry (options only). Lines: Nifty now.')}</div>`
      : '';
    box.innerHTML = `<div class="panel cc-doc cc-sugg">
      <h3>Suggestions now <span class="muted small">· Nifty ${S.spot.toLocaleString('en-IN')} · NIFTYBEES ${rupee(S.bees)}${S.beesModelled ? ' (modelled: no quote)' : ''} · prices at ${when(S.at)}${S.marketOpen ? '' : ' (market closed: last traded prices)'}${S.demo ? ' · demo data' : ''}</span></h3>
      <ul class="cc-now">${S.now.map((n) => `<li><span class="cc-kind k-${NOW_KIND[n.kind][1]}">${NOW_KIND[n.kind][0]}</span> ${esc(n.text)}</li>`).join('')}</ul>
      <div class="muted small">Ranked from the live chain with the strategy's slippage. "Chance" figures come from the options' own implied volatility: the market's estimate, not a forecast or an edge. Paper only: nothing is sent.</div>
      ${monthHtml}${weekHtml}
    </div>`;
    box.querySelectorAll('#ccSuggMonth button').forEach((b) =>
      b.addEventListener('click', () => {
        suggSel.month = Number(b.dataset.i);
        renderSugg();
      }),
    );
    box.querySelectorAll('tr[data-call]').forEach((tr) =>
      tr.addEventListener('click', () => {
        suggSel.call[M.expiry] = Number(tr.dataset.call);
        renderSugg();
      }),
    );
    box.querySelectorAll('tr[data-ins]').forEach((tr) =>
      tr.addEventListener('click', () => {
        suggSel.ins[M.expiry] = Number(tr.dataset.ins);
        renderSugg();
      }),
    );
    box.querySelectorAll('tr[data-wk]').forEach((tr) =>
      tr.addEventListener('click', () => {
        suggSel.wk = { expiry: W.expiry, i: Number(tr.dataset.wk) };
        renderSugg();
      }),
    );
    box.querySelectorAll('[data-sb-ins]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = M.ins[Number(b.dataset.sbIns)];
        toBuilder(
          M.expiry,
          c.legs,
          `Covered call insurance: ${c.kind === 'debit' ? 'put debit spread' : 'put butterfly'} ${c.strikes.join('/')} (${dayLabel(M.expiry)})`,
        );
      }),
    );
    box.querySelector('[data-sb-all]')?.addEventListener('click', () => {
      const legs = [...(call ? [{ type: 'CE', side: 'S', strike: call.strike, qty: S.units, mkt: call.ltp }] : []), ...(ins ? ins.legs : [])];
      toBuilder(M.expiry, legs, `Covered call: ${call ? call.strike + ' CE' : ''}${ins ? ' + ' + ins.strikes.join('/') + ' PE' : ''} (${dayLabel(M.expiry)})`);
    });
    box.querySelectorAll('[data-kite-ins]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = M.ins[Number(b.dataset.kiteIns)];
        toKite(M.expiry, c.legs, `Covered call insurance: ${c.kind === 'debit' ? 'put debit spread' : 'put butterfly'} ${c.strikes.join('/')}`);
      }),
    );
    box.querySelector('[data-kite-all]')?.addEventListener('click', () => {
      const legs = [...(call ? [{ type: 'CE', side: 'S', strike: call.strike, qty: S.units, mkt: call.ltp }] : []), ...(ins ? ins.legs : [])];
      toKite(M.expiry, legs, `Covered call: ${call ? call.strike + ' CE' : ''}${ins ? ' + ' + ins.strikes.join('/') + ' PE' : ''}`);
    });
    bindView(box, () => renderPaper(false));
    const insLegs = heldIns || ins?.legs || null;
    if (insLegs)
      // the insurance legs alone: no NIFTYBEES, no call; its strikes marked
      payoffChart($('ccSuggInsPay'), {
        legs: insLegs,
        hold: null,
        label: 'Insurance',
        marks: insLegs.map((l) => ({
          x: l.strike,
          label: `${l.side === 'B' ? 'Bought' : 'Sold'}${l.qty > S.units ? ' ×' + Math.round(l.qty / S.units) : ''} ${num0(l.strike)} PE`,
          color: l.side === 'B' ? BT.COLORS[2] : BT.COLORS[3],
        })),
      });
    if (M && (call || ins || heldCall || heldIns)) {
      const callLeg = heldCall || (call ? { type: 'CE', side: 'S', strike: call.strike, qty: S.units, entry: call.fill } : null);
      const be = heldCall ? held.callBE : call?.breakeven;
      payoffChart($('ccSuggPay'), {
        legs: [callLeg, ...(insLegs || [])].filter(Boolean),
        // a held month: the NIFTYBEES bought at the month's entry; otherwise NIFTYBEES bought now
        hold: heldHere
          ? { qty: held.qtyIn, spot: S.spot, bees: S.bees, cost: held.beesIn }
          : S.qtyBees
            ? { qty: S.qtyBees, spot: S.spot, bees: S.bees, cost: S.bees }
            : null,
        marks: [
          { x: S.spot, label: 'Nifty now ' + num0(S.spot), color: BT.COLORS[2] },
          ...(be ? [{ x: be, label: 'Call breakeven ' + num0(be), color: BT.COLORS[3] }] : []),
        ],
      });
    }
    const wc = W && wkI != null ? W.candidates[wkI] : null;
    if (wc) payoffChart($('ccSuggWkPay'), { legs: wc.legs, hold: null, marks: [{ x: S.spot, label: 'Nifty now ' + num0(S.spot), color: BT.COLORS[2] }] });
  }

  // The same legs [{ type, side, strike, qty, mkt }] to Zerodha Kite as real orders, after the dialog's confirmation.
  function toKite(expiry, legs, title) {
    const lot = meta.lot || params.lotSize;
    window.KiteOrder?.open({
      title,
      sub: `${dayLabel(expiry)} · prices shown`,
      legs: legs.map((l) => ({
        action: l.side,
        type: l.type,
        strike: l.strike,
        expiry: l.expiry || expiry,
        lots: Math.max(1, Math.round(l.qty / lot)),
        price: l.mkt,
      })),
    });
  }

  // Opens legs [{ type, side, strike, qty, mkt }] in the Builder as a live paper position (at the prices shown), the way
  // Live Ideas does: the Builder follows it on the live chain with its P&L, payoff and adjustments.
  function toBuilder(expiry, legs, note) {
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this one?')) return;
    const lot = meta.lot || params.lotSize;
    BT.emit('open-builder', {
      src: 'live',
      expiry,
      note,
      legs: legs.map((l) => ({
        action: l.side,
        type: l.type,
        strike: l.strike,
        expiry: l.expiry || expiry,
        lots: Math.max(1, Math.round(l.qty / lot)),
        px: l.mkt,
      })),
    });
  }

  // The paper tab redraws every 15 s while it is on screen.
  function poll() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (tab !== 'paper' || window.app?.state.view !== 'cc') return;
    pollTimer = setInterval(() => {
      if (document.hidden || tab !== 'paper' || window.app?.state.view !== 'cc') return;
      if (document.activeElement?.closest?.('#ccBody .cc-params')) return; // don't redraw under the user's typing
      renderPaper();
    }, 15_000);
  }

  // ---------- Trades screen: the covered call's paper months ----------
  // One row per month of the live paper trade (the open one marked at the last check, the closed ones as settled):
  // strategy, month, legs with their prices, weekly spreads, and the P&L with and without NIFTYBEES.
  const STRATEGY = 'Covered call · NIFTYBEES';
  async function renderCcTrades() {
    const el = $('ccTrades');
    if (!el) return;
    let st;
    try {
      if (!meta) meta = await BT.api('/api/cc/meta');
      st = await BT.api('/api/cc/paper');
    } catch (e) {
      el.innerHTML = `<div class="panel-head"><h3>Trading Ideas paper trades</h3></div><div class="err small pad">${esc(e.message)}</div>`;
      return;
    }
    const P = st.paper;
    const L = st.live;
    const head = `<div class="panel-head"><h3>Trading Ideas paper trades <span class="muted small">${P ? `${STRATEGY} · ${P.status === 'running' ? 'running' : 'paused'} since ${dayLabel(new Date(P.startedAt).toISOString().slice(0, 10))}${L ? ` · marked ${when(L.at)}${st.marketOpen ? '' : ' (market closed: last traded prices)'}` : ''}` : 'none'}</span></h3>
        <span class="spacer"></span><button class="btn-sm ghost" data-cct="open" title="Open the covered call's paper trade in Trading Ideas">Open in Trading Ideas ▸</button></div>`;
    if (!P) {
      el.innerHTML =
        head +
        '<div class="muted small pad">Start one in <b>Trading Ideas › Covered call › Paper trade</b>; each of its months is listed here with its strikes and P&amp;L.</div>';
      bindCcTrades(el, null);
      return;
    }
    const marks = new Map((L?.legs || []).map((x) => [x.id, x]));
    const units = P.params.lots * P.params.lotSize;
    const legLine = (l, open) => {
      const now = open ? marks.get(l.id)?.ltp : l.exit;
      const pnl = now == null ? null : (l.side === 'S' ? l.entry - now : now - l.entry) * l.qty;
      return `<div class="cc-leg"><b class="${l.side === 'S' ? 'neg' : 'pos'}">${l.side === 'S' ? 'Sold' : 'Bought'}</b> ${l.qty > units ? Math.round(l.qty / units) + '× ' : ''}${l.strike} ${l.type} <span class="mono">${l.entry.toFixed(2)} → ${now == null ? '—' : now.toFixed(2)}${open ? ' now' : ''}</span>${pnl == null ? '' : ` <span class="${cls(pnl)}">${inrS(pnl)}</span>`}</div>`;
    };
    const weekLine = (w, open) =>
      `<div class="cc-leg"><span class="muted">to ${dayLabel(w.expiry)}</span> ${REGIME_TRADE[w.regime] || ''} ${w.legs
        .filter((l) => l.side === 'S')
        .map((l) => l.strike + ' ' + l.type)
        .join(' / ')} · ${w.credit} cr
        ${open ? '<span class="cat-pill c-bullish">open</span>' : `<span class="${cls(w.pnl)}">${inrS(w.pnl)}</span>`}</div>`;
    const rows = [];
    const c = P.cycle;
    if (c) {
      const weeks = [...c.weeks.filter((w) => w.legs?.length).map((w) => weekLine(w, false)), ...(c.ovl ? [weekLine(c.ovl, true)] : [])];
      const m = L?.month?.expiry === c.expiry ? L.month : null;
      rows.push({
        month: c.expiry,
        html: `<tr><td class="l"><b>${STRATEGY}</b></td><td class="l"><b>${monthName(c.expiry)}</b><div class="muted small">to ${dayLabel(c.expiry)}</div></td>
          <td class="l"><span class="cat-pill c-bullish">open</span></td><td class="muted">${dayLabel(c.start)}<div>Nifty ${num0(c.spotIn)}</div></td>
          <td class="l cc-legs"><div class="cc-grp-l">NIFTYBEES</div><div class="cc-leg"><b class="pos">Held</b> ${num0(c.qtyIn)} NIFTYBEES <span class="mono">${rupee(c.beesIn)} → ${L ? rupee(L.bees.px) + ' now' : '—'}</span></div>${legParts(c, P.params.ins.kind, (l) => legLine(l, true))}</td>
          <td class="l cc-legs">${weeks.join('') || '<span class="muted">—</span>'}${c.ovl ? c.ovl.legs.map((l) => legLine(l, true)).join('') : ''}</td>
          <td class="${cls(m?.opt)}">${m ? inrS(m.opt) : '—'}</td><td class="${cls(m?.hold)}">${m ? inrS(m.hold) : '—'}</td><td class="${cls(m?.total)} b">${m ? inrS(m.total) : '—'}</td>
          <td><button class="btn-sm ghost" data-cct="builder" title="Open this month's open legs in the Builder as a live paper position at their paper entry prices">▶ Open in Builder</button></td></tr>`,
      });
    }
    for (const x of [...P.cycles].reverse())
      rows.push({
        month: x.expiry,
        html: `<tr><td class="l"><b>${STRATEGY}</b></td><td class="l"><b>${monthName(x.expiry)}</b><div class="muted small">to ${dayLabel(x.expiry)}</div></td>
          <td class="l"><span class="cat-pill">closed</span></td><td class="muted">${dayLabel(x.start)}<div>Nifty ${num0(x.spotIn)} → ${num0(x.spotOut)}</div></td>
          <td class="l cc-legs"><div class="cc-grp-l">NIFTYBEES</div><div class="cc-leg"><b class="pos">Held</b> ${num0(x.qtyIn)} NIFTYBEES <span class="mono">${rupee(x.beesIn)} → ${rupee(x.beesOut)}</span></div>${legParts(x, P.params.ins.kind, (l) => legLine(l, false))}</td>
          <td class="l cc-legs">${
            x.weeks
              .filter((w) => w.legs?.length)
              .map((w) => weekLine(w, false))
              .join('') || '<span class="muted">—</span>'
          }</td>
          <td class="${cls(x.optNet)}">${inrS(x.optNet)}</td><td class="${cls(x.holdPnl)}">${inrS(x.holdPnl)}</td><td class="${cls(x.total)} b">${inrS(x.total)}</td><td></td></tr>`,
      });
    el.innerHTML =
      head +
      `<div class="tbl-wrap sb-trades-wrap"><table class="grid-tbl sb-trades-tbl cc-trades-tbl"><thead><tr><th class="l">Strategy</th><th class="l">Month</th><th class="l">Status</th><th>Entered</th>
        <th class="l">NIFTYBEES · covered call · insurance<br><span class="muted">strike · entry → now / settled</span></th><th class="l">Weekly spreads</th>
        <th>Without NIFTYBEES</th><th>NIFTYBEES</th><th>With NIFTYBEES</th><th></th></tr></thead><tbody>${rows.map((r) => r.html).join('') || '<tr><td colspan="10" class="muted l">No month entered yet: it starts at the next check from the entry time on a market day.</td></tr>'}</tbody></table></div>
      ${L ? `<div class="muted small pad">Whole paper trade: with NIFTYBEES <b class="${cls(L.eq)}">${inrS(L.eq)}</b> · without NIFTYBEES <b class="${cls(L.opt)}">${inrS(L.opt)}</b> · buy and hold NIFTYBEES ${inrS(L.bh)}. Paper only: nothing is sent.</div>` : ''}`;
    bindCcTrades(el, P);
  }
  // the call and the insurance under their own labels
  const legParts = (c, insKind, line) =>
    (c.call ? `<div class="cc-grp-l">Covered call</div>${line(c.call)}` : '') +
    (c.ins.length ? `<div class="cc-grp-l">${insTitle(insKind)}</div>${c.ins.map(line).join('')}` : '');
  const monthName = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  function bindCcTrades(el, P) {
    el.querySelector('[data-cct="open"]')?.addEventListener('click', () => {
      tab = 'paper';
      BT.store.set('cc-tab', tab);
      window.app.setView('cc');
      if (started) render();
    });
    el.querySelector('[data-cct="builder"]')?.addEventListener('click', () => {
      const c = P?.cycle;
      if (!c) return;
      const legs = [c.call, ...c.ins, ...(c.ovl ? c.ovl.legs : [])].filter(Boolean).map((l) => ({ ...l, mkt: l.entry }));
      toBuilder(c.expiry, legs, `${STRATEGY} paper trade · ${monthName(c.expiry)} (options only; ${num0(c.qtyIn)} NIFTYBEES not in the Builder)`);
    });
  }

  $('ccTabs').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tab;
    if (!t || t === tab) return;
    tab = t;
    BT.store.set('cc-tab', tab);
    render();
  });
  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'cc') init().then(poll);
    else poll();
    if (e.detail === 'tr') renderCcTrades();
  });
  if (window.app?.state.view === 'cc') init();
  if (window.app?.state.view === 'tr') renderCcTrades();
})();
