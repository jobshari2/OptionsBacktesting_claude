// Trades › Portfolio P&L: a dashboard of the LIVE trades (closed and open), NIFTYBEES + options, built on the Ledger's
// own events and figures (ledger-view.js window.LedgerModel.build('live')), so the two tabs always agree.
//   1. Summary: total investment (the ledger's capital; none set: the most ever invested), value now (cash +
//      NIFTYBEES at the price now + options margin + the open trades' P&L), total P&L, the profit reinvested; the
//      portfolio's growth (value, investment, profit) day by day; asset allocation; profit contribution.
//   2. Detailed ledger: one row per event, oldest first — NIFTYBEES bought / sold / reinvested, options opened /
//      closed (CE and PE of a trade as ONE row: "Options (CE + PE)"), capital added / withdrawn — with the realised P&L
//      and the running total; then what is held (marked at the price now) and the value now. CSV export.
//   3. Performance: profit / loss per day, week or month (1M / 3M / 6M / 1Y / All), P&L of each trade split NIFTYBEES /
//      options, and a few plain insights.
// The growth curve values NIFTYBEES at each day's close (read once from the recorded history, /api/sb/bees; a day with
// no record: the trade prices of that day, else the last price known). Open options are carried at their margin
// until today, when their P&L now is added (their past value day by day is not recorded).
(function () {
  const { esc, inr, inrS, cls } = BT;
  const $ = (id) => document.getElementById(id);
  const R = (v) => Math.round(v);
  const money = (v) => (v == null || !Number.isFinite(v) ? '—' : inr(R(v)));
  const signed = (v) => (v == null || !Number.isFinite(v) ? '—' : inrS(R(v)));
  const pct = (v) => (v == null || !Number.isFinite(v) ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`);
  const units = (n) => Math.round(n).toLocaleString('en-IN');
  const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const dayTxt = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
  const dayShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const monTxt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
  const wd = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  const lakh = (v) => {
    const a = Math.abs(v);
    const s = v < 0 ? '−₹' : '₹';
    if (a >= 1e7) return s + (a / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(2) + 'L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + R(a);
  };
  const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, All: 0 };
  const BEES_C = '#f0883e'; // NIFTYBEES, as on the Ledger tab
  let range = BT.store.get('pfRange', 'All');
  if (!(range in RANGES)) range = 'All';
  let msg = '';
  let busy = false;
  const closes = new Map(); // day -> NIFTYBEES close (null: none recorded), read this session
  let fetching = false;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const colors = () => ({ opt: css('--accent') || '#4c8dff', bees: BEES_C, cash: css('--muted') || '#8b949e', up: css('--up') || '#3fb950', down: css('--down') || '#f85149', text: css('--text') || '#ddd', line: css('--line') || '#333' });

  // ---------- the model ----------
  // Options legs of a saved trade as one item: "Options (CE + PE)", with how many CE / PE legs and lots
  function optLegs(tr) {
    const legs = tr?.t?.snap?.legs || [];
    const ce = legs.filter((l) => l.type === 'CE');
    const pe = legs.filter((l) => l.type === 'PE');
    const lots = legs.reduce((a, l) => a + (Number(l.lots) || 0), 0);
    const kinds = [ce.length ? 'CE' : '', pe.length ? 'PE' : ''].filter(Boolean).join(' + ') || 'CE + PE';
    return { kinds, ce: ce.length, pe: pe.length, lots, qty: lots * (tr?.t?.summary?.lot || BT.meta?.calendar?.liveLot || 65), open: legs.filter((l) => l.open).length };
  }

  // Replays the ledger's events of the Live trades: the cash, NIFTYBEES units and options margin after each; the
  // investment (initial capital from the first day — or, with none set, the most ever invested — plus capital added,
  // less withdrawn); and the detailed ledger rows.
  function model() {
    const LM = window.LedgerModel;
    const B = LM?.build('live');
    if (!B) return null;
    const L = LM.ledger();
    const ev = B.events;
    const realEv = ev.filter((e) => e.kind !== 'capital');
    // the most ever invested (NIFTYBEES at cost + options margin), for a ledger with no capital set
    let cost = 0;
    let margin = 0;
    let peak = 0;
    for (const e of realEv) {
      if (e.kind === 'buy' || (e.kind === 'reinvest' && e.buy)) cost += e.beesAmt;
      else if (e.kind === 'sell') cost -= -e.beesAmt - e.realised;
      else if (e.kind === 'margin') margin += e.margin;
      else if (e.kind === 'close') margin -= e.release;
      peak = Math.max(peak, cost + margin);
    }
    const capSet = L.capital > 0;
    const base = capSet ? L.capital : peak;
    const first = realEv.map((e) => e.date).filter(Boolean).sort()[0] || L.capitalDate || today();
    // the replay
    const s = { cash: base, units: 0, cost: 0, margin: 0, inv: base, realised: 0 };
    const steps = []; // { date, cash, units, margin, inv, realised } after each event
    const rows = [];
    const px = {}; // day -> a NIFTYBEES price traded that day (the fallback for the growth curve)
    rows.push({ date: first, action: capSet ? 'Initial investment' : 'Investment', tag: 'inv', inst: 'Capital', sub: capSet ? (L.capitalDate && L.capitalDate !== first ? `capital of ${dayTxt(L.capitalDate)}` : 'initial capital') : 'no capital set on the Ledger tab: the most ever invested', amount: base, value: base, total: 0 });
    for (const e of realEv) {
      const r = { date: e.date };
      if (e.kind === 'deposit' || e.kind === 'withdrawal') {
        s.cash += e.cash;
        s.inv += e.cash;
        Object.assign(r, { action: e.kind === 'deposit' ? 'Capital added' : 'Capital withdrawn', tag: e.kind === 'deposit' ? 'inv' : 'out', inst: 'Capital', sub: e.title, amount: e.cash, value: e.cash });
      } else if (e.kind === 'buy') {
        s.cash -= e.beesAmt;
        s.units += e.buy.qty;
        s.cost += e.beesAmt;
        px[e.date] ??= e.buy.price;
        Object.assign(r, { action: 'Buy', tag: 'buy', inst: 'NIFTYBEES', sub: e.tr?.name, amount: e.beesAmt, qty: e.buy.qty, rate: e.buy.price, value: e.beesAmt });
      } else if (e.kind === 'reinvest') {
        if (!e.buy) {
          Object.assign(r, { action: 'Reinvest', tag: 're', inst: 'NIFTYBEES', sub: 'waiting for the NIFTYBEES price of the day (see the Ledger tab)', pending: true });
        } else {
          s.cash -= e.beesAmt;
          s.units += e.buy.qty;
          s.cost += e.beesAmt;
          px[e.date] ??= e.buy.price;
          Object.assign(r, { action: 'Reinvest', tag: 're', inst: 'NIFTYBEES', sub: `options profit of ${e.from.tr?.name || e.from.entry?.desc || 'a trade'}`, amount: e.beesAmt, qty: e.buy.qty, rate: e.buy.price, value: e.beesAmt });
        }
      } else if (e.kind === 'margin') {
        s.cash -= e.margin;
        s.margin += e.margin;
        const o = optLegs(e.tr);
        Object.assign(r, { action: 'Options opened', tag: 'opt', inst: `Options (${e.tr ? o.kinds : 'CE + PE'})`, sub: e.tr ? `${e.tr.name} · ${o.ce} CE + ${o.pe} PE legs` : e.title, amount: e.margin, qty: e.tr ? o.qty : null, qtySub: e.tr ? `${o.lots} lots` : '', value: e.margin, valueSub: e.tr?.edited.includes('margin') ? 'margin' : 'margin (estimate)' });
      } else if (e.kind === 'close') {
        s.cash += e.pnl + e.release;
        s.margin -= e.release;
        s.realised += e.pnl;
        const o = optLegs(e.tr);
        Object.assign(r, { action: 'Options closed', tag: 'trade', inst: `Options (${e.tr ? o.kinds : 'CE + PE'})`, sub: e.tr ? `${e.tr.name}${e.tr.charges ? ` · after ₹${units(e.tr.charges)} charges` : ''}` : e.title, qty: e.tr ? o.qty : null, qtySub: e.tr ? `${o.lots} lots` : '', value: e.release || null, valueSub: e.release ? 'margin back' : '', real: e.pnl });
      } else if (e.kind === 'sell') {
        const q = -e.beesAmt / e.sell.price;
        s.cash += -e.beesAmt;
        s.units -= q;
        s.cost -= -e.beesAmt - e.realised;
        s.realised += e.realised;
        px[e.date] = e.sell.price;
        Object.assign(r, { action: 'Sell', tag: 'sell', inst: 'NIFTYBEES', sub: e.tr?.name, qty: q, rate: e.sell.price, value: -e.beesAmt, real: e.realised });
      } else if (e.kind === 'other') {
        s.cash += e.other;
        s.realised += e.other;
        Object.assign(r, { action: e.entry?.type === 'charges' ? 'Charges' : 'Other', tag: 'out', inst: 'Cash', sub: e.title, amount: e.other, real: e.other });
      } else continue;
      r.total = s.realised;
      rows.push(r);
      steps.push({ date: e.date, cash: s.cash, units: s.units, margin: s.margin, inv: s.inv, realised: s.realised });
    }
    const pxNow = B.px;
    const beesVal = pxNow ? s.units * pxNow : null;
    const value = s.cash + (beesVal ?? s.cost) + s.margin + B.optOpen;
    const pnl = value - s.inv;
    const lots = LM.beesLots(B);
    const beesPnl = lots.reduce((a, l) => a + (l.pnl || 0), 0);
    const reLots = lots.filter((l) => l.how === 'reinvest' && l.qty > 0);
    const optPnl = B.s.optBooked + B.optOpen;
    // held now, marked at the price now; then the value now
    const t = today();
    if (s.units > 0) rows.push({ date: t, action: 'Holding', tag: 'hold', inst: 'NIFTYBEES', sub: pxNow ? `${units(s.units)} units held at ₹${pxNow.toFixed(2)} now` : 'no price now: at cost', qty: s.units, rate: pxNow, value: beesVal ?? s.cost, real: beesVal == null ? null : beesVal - s.cost, realSub: 'unrealised', total: s.realised + (beesVal == null ? 0 : beesVal - s.cost) });
    const openTr = B.trades.filter((x) => x.open);
    if (openTr.length || s.margin > 0) {
      const o = openTr.map(optLegs);
      rows.push({ date: t, action: 'Open', tag: 'hold', inst: `Options (${[...new Set(o.flatMap((x) => x.kinds.split(' + ')))].join(' + ') || 'CE + PE'})`, sub: `${openTr.length} open trade${openTr.length === 1 ? '' : 's'}: ${openTr.map((x) => x.name).join(', ')}`, qty: o.reduce((a, x) => a + x.qty, 0) || null, qtySub: `${o.reduce((a, x) => a + x.lots, 0)} lots`, value: s.margin + B.optOpen, valueSub: 'margin + P&L now', real: B.optOpen, realSub: 'open P&L' });
    }
    rows.push({ date: t, action: 'Current value', tag: 'now', inst: 'Portfolio', sub: 'cash + NIFTYBEES + options', value, total: pnl, last: true });
    return { B, L, base, capSet, first, steps, rows, px, s, pxNow, beesVal, value, pnl, ret: s.inv > 0 ? pnl / s.inv : null, beesPnl, optPnl, lots, reLots, openTr };
  }

  // ---------- the growth curve: one point per trading day (thinned to about 150 over a long period) ----------
  function dayList(from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (wd(d) !== 0 && wd(d) !== 6) out.push(d);
    if (!out.length || out[out.length - 1] !== to) out.push(to);
    return out;
  }
  function sampleDays(M) {
    const all = dayList(M.first, today());
    const step = Math.max(1, Math.ceil(all.length / 150));
    const keep = new Set(M.steps.map((x) => x.date));
    return all.filter((d, i) => i % step === 0 || keep.has(d) || i === all.length - 1);
  }
  // NIFTYBEES on a day: its recorded close, else the ledger's price for it, else a price traded that day, else the
  // last one known before (or, at the very start, the first one after); today: the price now
  function priceFn(M, days) {
    const known = (d) => {
      if (d === today() && M.pxNow) return M.pxNow;
      const c = closes.get(d);
      if (c > 0) return c;
      const k = M.L.px?.[d]?.px;
      if (k > 0) return k;
      return M.px[d] > 0 ? M.px[d] : null;
    };
    const out = {};
    let last = null;
    let filled = 0;
    for (const d of days) {
      const k = known(d);
      if (k) last = k;
      else filled++;
      out[d] = k || last;
    }
    const firstKnown = days.map((d) => out[d]).find((v) => v > 0) || M.pxNow || null;
    for (const d of days) out[d] ||= firstKnown;
    return { at: (d) => out[d], filled };
  }
  function series(M) {
    const days = sampleDays(M);
    const P = priceFn(M, days);
    const pts = [];
    let i = -1;
    const t = today();
    for (const d of days) {
      while (i + 1 < M.steps.length && M.steps[i + 1].date <= d) i++;
      const st = i >= 0 ? M.steps[i] : { cash: M.base, units: 0, margin: 0, inv: M.base, realised: 0 };
      const p = P.at(d);
      const value = d === t ? M.value : st.cash + st.units * (p || 0) + st.margin;
      pts.push({ d, value, inv: st.inv, profit: value - st.inv });
    }
    return { pts, filled: P.filled, days };
  }
  async function fetchCloses(days) {
    if (fetching) return;
    const need = days.filter((d) => d < today() && !closes.has(d));
    if (!need.length) return;
    fetching = true;
    for (let i = 0; i < need.length; i += 6) {
      await Promise.all(
        need.slice(i, i + 6).map(async (d) => {
          const a = (await BT.api('/api/sb/bees?day=' + d).catch(() => null))?.bees;
          const c = Array.isArray(a) ? [...a].reverse().find((v) => v > 0) : null;
          closes.set(d, c > 0 ? c : null);
        }),
      );
    }
    fetching = false;
    if (shown()) render();
  }

  // ---------- drawing ----------
  const card = (icon, label, val, sub, k = '') => `<div class="pf-card ${k}"><div class="pf-ic">${icon}</div><div class="pf-cl">${label}</div><div class="pf-cv">${val}</div>${sub ? `<div class="pf-cs">${sub}</div>` : ''}</div>`;
  function summaryHtml(M) {
    const re = M.reLots;
    const reAmt = re.reduce((a, l) => a + l.amt, 0);
    const reNow = M.pxNow ? re.reduce((a, l) => a + l.qty * M.pxNow, 0) : null;
    return `<div class="pf-cards">
      ${card('🏦', 'Total investment', money(M.s.inv), M.capSet ? 'capital (Ledger tab)' : 'most ever invested · set a capital on the Ledger tab')}
      ${card('📈', 'Current value', money(M.value), `NIFTYBEES ${money(M.beesVal ?? M.s.cost)} · options ${money(M.s.margin + M.B.optOpen)} · cash ${money(M.s.cash)}`)}
      ${card('🏆', 'Total P&amp;L', `<span class="${cls(M.pnl)}">${signed(M.pnl)}</span>`, `<b class="${cls(M.ret)}">${pct(M.ret)}</b> · booked ${signed(M.s.realised)}`, M.pnl >= 0 ? 'good' : 'bad')}
      ${card('⭐', 'Profit reinvested', reAmt > 0 ? money(reNow ?? reAmt) : '₹0', reAmt > 0 ? `${money(reAmt)} of options profit → ${units(re.reduce((a, l) => a + l.qty, 0))} NIFTYBEES${reNow != null ? ` · <b class="${cls(reNow - reAmt)}">${signed(reNow - reAmt)}</b> on them` : ''}` : M.L.reinvest ? 'no options profit booked yet' : 'reinvesting is off (Ledger tab)')}
    </div>`;
  }
  const head = (n, title, right = '') => `<div class="pf-h"><h3><span class="pf-n">${n}.</span> ${title}</h3>${right}</div>`;
  const leg = (c, t) => `<span class="pf-leg"><i style="background:${c}"></i>${t}</span>`;
  function donutHtml(id, title, items, centre, sub) {
    return `<div class="pf-box pf-donut"><h4>${title}</h4><div class="pf-dn"><div class="pf-dc"><canvas id="${id}"></canvas><div class="pf-dmid"><b>${centre}</b><span>${sub}</span></div></div>
      <ul>${items.map((x) => `<li><i style="background:${x.c}"></i><div><span>${x.label}</span><b class="${x.k || ''}">${x.val}</b></div></li>`).join('')}</ul></div></div>`;
  }
  function barsHtml(title, items, note) {
    const max = Math.max(1, ...items.map((x) => Math.abs(x.v || 0)));
    return `<div class="pf-box pf-contrib"><h4>${title}</h4>${items
      .map((x) => {
        const w = (Math.abs(x.v || 0) / max) * 50;
        return `<div class="pf-cb"><span class="pf-cbl"><i style="background:${x.c}"></i>${x.label}</span><div class="pf-cbt"><div class="pf-cbz"></div><div class="pf-cbf ${x.v < 0 ? 'neg' : 'pos'}" style="${x.v < 0 ? `right:50%` : `left:50%`};width:${w}%"></div></div><b class="${cls(x.v)}">${signed(x.v)}</b></div>`;
      })
      .join('')}${note ? `<p class="muted small">${note}</p>` : ''}</div>`;
  }
  function ledgerHtml(M) {
    const v = (x, sub) => `${x == null ? '—' : money(x)}${sub ? `<div class="pf-sub">${sub}</div>` : ''}`;
    const row = (r) => `<tr class="${r.last ? 'pf-last' : ''}${r.pending ? ' pf-pend' : ''}"><td class="pf-d">${dayTxt(r.date)}</td><td><span class="pf-tag ${r.tag}">${esc(r.action)}</span></td>
      <td class="l"><b>${esc(r.inst)}</b>${r.sub ? `<div class="pf-sub">${esc(r.sub)}</div>` : ''}</td>
      <td>${r.amount == null ? '—' : money(r.amount)}</td>
      <td>${r.qty == null ? '—' : units(r.qty)}${r.qtySub ? `<div class="pf-sub">${r.qtySub}</div>` : ''}</td>
      <td>${r.rate > 0 ? r.rate.toFixed(2) : '—'}</td>
      <td>${v(r.value, r.valueSub)}</td>
      <td>${r.real == null ? '—' : `<b class="${cls(r.real)}">${signed(r.real)}</b>`}${r.realSub ? `<div class="pf-sub">${r.realSub}</div>` : ''}</td>
      <td>${r.total == null ? '—' : `<b class="${cls(r.total)}">${signed(r.total)}</b>`}</td></tr>`;
    return `<div class="pf-wrap"><table class="grid-tbl pf-tbl"><thead><tr><th>Date</th><th>Action</th><th class="l">Instrument</th><th>Amount (₹)</th><th>Units / Qty</th><th>Rate / Price</th><th>Value (₹)</th><th title="Booked when sold / closed; held and open rows: unrealised">Realised P&amp;L (₹)</th><th title="Running total of the booked P&amp;L; the last rows add what is held now">Total profit (₹)</th></tr></thead>
      <tbody>${M.rows.map(row).join('')}</tbody></table></div>
      <div class="pf-strip"><div><span>Total investment</span><b>${money(M.s.inv)}</b></div><div><span>Current value</span><b>${money(M.value)}</b></div><div><span>Total profit</span><b class="${cls(M.pnl)}">${signed(M.pnl)} <small>(${pct(M.ret) || '—'})</small></b></div></div>`;
  }
  // P&L of each live trade: its NIFTYBEES lot(s) and its options
  function perTrade(M) {
    return M.B.trades
      .map((tr) => {
        const bees = M.lots.filter((l) => l.tr === tr && l.how === 'bought').reduce((a, l) => a + (l.pnl || 0), 0);
        const re = M.lots.filter((l) => l.tr === tr && l.how === 'reinvest').reduce((a, l) => a + (l.pnl || 0), 0);
        return { tr, name: tr.name, bees: bees + re, opt: tr.opt || 0, total: bees + re + (tr.opt || 0), open: tr.open, opened: tr.opened };
      })
      .sort((a, b) => (a.opened || '').localeCompare(b.opened || ''));
  }
  function insights(M, S, P) {
    const out = [];
    const span = Math.max(1, Math.round((Date.parse(today()) - Date.parse(M.first)) / 86400_000));
    out.push(`Portfolio ${M.pnl >= 0 ? 'up' : 'down'} <b class="${cls(M.pnl)}">${pct(M.ret)}</b> (${signed(M.pnl)}) on ${money(M.s.inv)} since ${dayTxt(M.first)} (${span} day${span === 1 ? '' : 's'}).`);
    const tot = Math.abs(M.beesPnl) + Math.abs(M.optPnl);
    if (tot > 0) {
      const lead = M.beesPnl >= M.optPnl ? 'NIFTYBEES' : 'Options';
      out.push(`NIFTYBEES ${signed(M.beesPnl)} · options (CE + PE) ${signed(M.optPnl)}: <b>${lead}</b> carried the result${M.beesPnl * M.optPnl < 0 ? `, the other ${M.beesPnl < 0 ? 'NIFTYBEES' : 'options'} side cost ${money(Math.abs(Math.min(M.beesPnl, M.optPnl)))}` : ''}.`);
    }
    if (P.length > 1) {
      const best = P.reduce((a, b) => (b.total > a.total ? b : a));
      const worst = P.reduce((a, b) => (b.total < a.total ? b : a));
      out.push(`Best trade <b>${esc(best.name)}</b> ${signed(best.total)}; weakest <b>${esc(worst.name)}</b> ${signed(worst.total)}.`);
    } else if (P.length === 1) out.push(`One live trade: <b>${esc(P[0].name)}</b> ${signed(P[0].total)}.`);
    if (M.openTr.length) out.push(`${M.openTr.length} trade${M.openTr.length === 1 ? '' : 's'} open: options P&amp;L now ${signed(M.B.optOpen)} on ${money(M.s.margin)} margin.`);
    if (M.reLots.length) out.push(`${money(M.reLots.reduce((a, l) => a + l.amt, 0))} of options profit went back into NIFTYBEES.`);
    else if (M.L.reinvest) out.push(`No options profit to reinvest yet: options booked ${signed(M.B.s.optBooked)}.`);
    if (S.filled > 0) out.push(`<span class="muted">NIFTYBEES closes missing for ${S.filled} day${S.filled === 1 ? '' : 's'} of the curve: the last price known is carried.</span>`);
    return out;
  }

  // profit / loss per bucket (day, week or month) over the range: the change of the profit curve
  function buckets(pts) {
    const days = RANGES[range];
    const from = days ? addDays(today(), -days) : pts[0]?.d;
    const span = Math.round((Date.parse(today()) - Date.parse(from)) / 86400_000);
    const by = span <= 45 ? 'day' : span <= 140 ? 'week' : 'month';
    const key = (d) => (by === 'day' ? d : by === 'month' ? d.slice(0, 7) : addDays(d, -((wd(d) + 6) % 7)));
    const lab = (k) => (by === 'day' ? dayShort(k) : by === 'month' ? monTxt(k + '-01') : 'wk ' + dayShort(k));
    const out = [];
    let prev = null;
    for (const p of pts) {
      if (p.d < from) {
        prev = p.profit;
        continue;
      }
      const k = key(p.d);
      let b = out[out.length - 1];
      if (!b || b.k !== k) out.push((b = { k, label: lab(k), start: prev ?? 0, end: p.profit }));
      b.end = p.profit;
      prev = p.profit;
    }
    for (const b of out) b.v = b.end - b.start;
    return { list: out, by, from };
  }

  const fmtTick = (v) => lakh(v);
  function drawCharts(M, S, P) {
    if (!window.Chart) return;
    const C = colors();
    const days = RANGES[range];
    const from = days ? addDays(today(), -days) : null;
    const pts = S.pts.filter((p) => !from || p.d >= from);
    const lastP = pts[pts.length - 1];
    BT.chart($('pfGrowth'), {
      type: 'line',
      data: {
        labels: pts.map((p) => dayShort(p.d)),
        datasets: [
          { label: 'Portfolio value', data: pts.map((p) => R(p.value)), borderColor: C.opt, backgroundColor: C.opt + '22', fill: 'origin', pointRadius: pts.length > 40 ? 0 : 2.5, borderWidth: 2, tension: 0.2 },
          { label: 'Investment', data: pts.map((p) => R(p.inv)), borderColor: C.cash, borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5, stepped: true },
          { label: 'Profit', data: pts.map((p) => R(p.profit)), borderColor: (lastP?.profit ?? 0) >= 0 ? C.up : C.down, backgroundColor: ((lastP?.profit ?? 0) >= 0 ? C.up : C.down) + '22', fill: 'origin', pointRadius: pts.length > 40 ? 0 : 2.5, borderWidth: 2, tension: 0.2, yAxisID: 'y2' },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inr(c.parsed.y)}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { position: 'left', ticks: { callback: fmtTick }, title: { display: true, text: 'value / investment' } },
          y2: { position: 'right', grid: { display: false }, ticks: { callback: fmtTick }, title: { display: true, text: 'profit' } },
        },
      },
    });
    // allocation: NIFTYBEES value, options (margin + open P&L), cash
    const alloc = [
      { label: 'NIFTYBEES', v: Math.max(0, M.beesVal ?? M.s.cost), c: C.bees },
      { label: 'Options (CE + PE)', v: Math.max(0, M.s.margin + M.B.optOpen), c: C.opt },
      { label: 'Cash', v: Math.max(0, M.s.cash), c: C.cash },
    ];
    BT.chart($('pfAlloc'), { type: 'doughnut', data: { labels: alloc.map((x) => x.label), datasets: [{ data: alloc.map((x) => R(x.v)), backgroundColor: alloc.map((x) => x.c), borderWidth: 0 }] }, options: { cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${inr(c.parsed)}` } } } } });
    // profit / loss per day, week or month
    const Bk = buckets(S.pts);
    $('pfBarsT').textContent = `Profit / loss by ${Bk.by}`;
    const best = Bk.list.reduce((a, b) => (a && a.v >= b.v ? a : b), null);
    BT.chart($('pfBars'), {
      type: 'bar',
      data: { labels: Bk.list.map((b) => b.label), datasets: [{ label: 'P&L', data: Bk.list.map((b) => R(b.v)), backgroundColor: Bk.list.map((b) => (b.v >= 0 ? C.up : C.down)), borderRadius: 3, maxBarThickness: 28 }] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => signed(c.parsed.y) } } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { ticks: { callback: fmtTick } } } },
    });
    $('pfBarsNote').innerHTML = Bk.list.length ? `best ${Bk.by} <b class="${cls(best.v)}">${signed(best.v)}</b> (${esc(best.label)}) · over the range <b class="${cls(Bk.list.reduce((a, b) => a + b.v, 0))}">${signed(Bk.list.reduce((a, b) => a + b.v, 0))}</b>` : 'nothing in this range';
    // P&L of each trade: NIFTYBEES and options stacked
    BT.chart($('pfMix'), {
      type: 'bar',
      data: {
        labels: P.map((x) => (x.name.length > 26 ? x.name.slice(0, 25) + '…' : x.name) + (x.open ? ' (open)' : '')),
        datasets: [
          { label: 'NIFTYBEES', data: P.map((x) => R(x.bees)), backgroundColor: C.bees, borderRadius: 3, maxBarThickness: 22 },
          { label: 'Options (CE + PE)', data: P.map((x) => R(x.opt)), backgroundColor: C.opt, borderRadius: 3, maxBarThickness: 22 },
        ],
      },
      options: { indexAxis: 'y', plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${signed(c.parsed.x)}`, footer: (it) => `Trade: ${signed(P[it[0].dataIndex].total)}` } } }, scales: { x: { stacked: true, ticks: { callback: fmtTick } }, y: { stacked: true, grid: { display: false } } } },
    });
  }

  const shown = () => window.SBTrades?.tabShown?.('portfolio');
  function render() {
    const el = $('trPortfolio');
    if (!el) return;
    const LM = window.LedgerModel;
    const M = LM ? model() : null;
    if (!M) return void (el.innerHTML = `<div class="panel pad muted">${esc(LM?.error() || 'Reading the trades and the ledger…')}</div>`);
    if (!M.B.trades.length && !M.L.entries.length)
      return void (el.innerHTML = `<div class="panel pad muted">No Live trades yet. Save a live trade in the Builder (Trades › Live) and it shows here with its NIFTYBEES and options.</div>`);
    const S = series(M);
    fetchCloses(S.days.filter((d) => d < today()));
    if (M.B.s.missing.length) LM.fetchPrices(M.B.s.missing);
    const P = perTrade(M);
    const C = colors();
    const nTr = M.B.trades.length;
    const nOpen = M.openTr.length;
    const rangeBtns = `<div class="seg pf-range">${Object.keys(RANGES)
      .map((k) => `<button data-range="${k}" class="${k === range ? 'on' : ''}">${k}</button>`)
      .join('')}</div>`;
    el.innerHTML = `
      <div class="pf-top panel"><div><h2>Portfolio P&amp;L <span class="muted">· NIFTYBEES + options</span></h2>
        <span class="muted small">Live trades: ${nTr} (${nTr - nOpen} closed, ${nOpen} open) · ${monTxt(M.first)} – ${monTxt(today())}${M.pxNow ? ` · NIFTYBEES ₹${M.pxNow.toFixed(2)} now` : ' · no NIFTYBEES price now'}</span></div>
        <span class="spacer"></span><span class="muted small">${esc(msg)}</span>
        <button class="btn-sm ghost" data-act="refresh" ${busy ? 'disabled' : ''} title="Price the open trades and NIFTYBEES now">${busy ? 'Pricing…' : '↻ Prices now'}</button></div>
      <div class="pf-grid">
        <section class="panel pf-sec pf-s1">${head(1, 'Portfolio summary', `<span class="muted small">${monTxt(M.first)} – ${monTxt(today())}</span>`)}
          ${summaryHtml(M)}
          <div class="pf-box"><div class="pf-bh"><h4>Portfolio growth</h4>${leg(C.opt, 'Portfolio value')}${leg(C.cash, 'Investment')}${leg(M.pnl >= 0 ? C.up : C.down, 'Profit (right axis)')}</div><div class="pf-chart"><canvas id="pfGrowth"></canvas></div></div>
          <div class="pf-two">
            ${donutHtml(
              'pfAlloc',
              'Asset allocation',
              [
                { label: 'NIFTYBEES', val: `${money(M.beesVal ?? M.s.cost)} <small>(${((100 * (M.beesVal ?? M.s.cost)) / Math.max(1, M.value)).toFixed(0)}%)</small>`, c: C.bees },
                { label: 'Options (CE + PE)', val: `${money(M.s.margin + M.B.optOpen)} <small>(${((100 * (M.s.margin + M.B.optOpen)) / Math.max(1, M.value)).toFixed(0)}%)</small>`, c: C.opt },
                { label: 'Cash', val: `${money(M.s.cash)} <small>(${((100 * M.s.cash) / Math.max(1, M.value)).toFixed(0)}%)</small>`, c: C.cash },
              ],
              lakh(M.value),
              'total value',
            )}
            ${barsHtml(
              'Profit contribution',
              [
                { label: 'NIFTYBEES', v: M.beesPnl, c: C.bees },
                { label: 'Options (CE + PE)', v: M.optPnl, c: C.opt },
                ...(M.B.s.other ? [{ label: 'Other entries', v: M.B.s.other, c: C.cash }] : []),
                { label: 'Total', v: M.beesPnl + M.optPnl + M.B.s.other, c: C.text },
              ],
              `NIFTYBEES: sold + held at the price now · options: booked ${signed(M.B.s.optBooked)} + open ${signed(M.B.optOpen)}`,
            )}
          </div>
          <div class="pf-banner ${M.pnl >= 0 ? 'good' : 'bad'}">${M.pnl >= 0 ? '✔' : '✖'} Total P&amp;L (NIFTYBEES + options${M.reLots.length ? ', with reinvestments' : ''}): <b>${signed(M.pnl)}</b> (${pct(M.ret) || '—'} on ${money(M.s.inv)})</div>
        </section>
        <section class="panel pf-sec pf-s2">${head(2, 'Detailed ledger', `<button class="btn-sm ghost" data-act="csv" title="Download this table as a CSV for Excel">⬇ Export CSV</button>`)}
          ${ledgerHtml(M)}
        </section>
        <section class="panel pf-sec pf-s3">${head(3, 'Performance analytics', rangeBtns)}
          <div class="pf-two">
            <div class="pf-box"><div class="pf-bh"><h4 id="pfBarsT">Profit / loss</h4></div><div class="pf-chart sm"><canvas id="pfBars"></canvas></div><div class="muted small" id="pfBarsNote"></div></div>
            <div class="pf-box"><div class="pf-bh"><h4>P&amp;L by trade</h4><span class="muted small">NIFTYBEES + options (CE + PE)</span></div><div class="pf-chart sm" style="height:${Math.max(180, 60 + P.length * 34)}px"><canvas id="pfMix"></canvas></div></div>
          </div>
          <div class="pf-ins"><h4>💡 Key insights</h4><ul>${insights(M, S, P)
            .map((x) => `<li>${x}</li>`)
            .join('')}</ul></div>
        </section>
      </div>
      <p class="muted small pad">The Live trades and the figures of the Ledger tab (capital, margins, charges, your edits). NIFTYBEES and the options of a trade are separate items; a trade's CE and PE legs are one options item. The growth curve values NIFTYBEES at each day's close and carries open options at their margin until today, when their P&amp;L now is added.</p>`;
    drawCharts(M, S, P);
  }

  // ---------- CSV ----------
  function exportCsv() {
    const M = model();
    if (!M) return;
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const n = (v, d = 0) => (v == null || !Number.isFinite(v) ? '' : (+v).toFixed(d));
    const lines = [['Date', 'Action', 'Instrument', 'Detail', 'Amount (Rs)', 'Units / Qty', 'Rate / Price', 'Value (Rs)', 'Realised P&L (Rs)', 'Total profit (Rs)'].join(',')];
    for (const r of M.rows) lines.push([r.date, r.action, r.inst, r.sub || '', n(r.amount), n(r.qty), n(r.rate, 2), n(r.value), n(r.real), n(r.total)].map(q).join(','));
    lines.push('');
    lines.push(['Total investment', n(M.s.inv)].map(q).join(','));
    lines.push(['Current value', n(M.value)].map(q).join(','));
    lines.push(['Total profit', n(M.pnl), M.ret == null ? '' : (M.ret * 100).toFixed(2) + '%'].map(q).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio-pnl-live-${today()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  }

  // ---------- shown ----------
  let opening = false;
  async function show() {
    if (opening) return;
    opening = true;
    render();
    try {
      await window.LedgerModel?.ready();
    } catch (e) {
      msg = 'Could not read the trades: ' + e.message;
    } finally {
      opening = false;
    }
    render();
  }
  const el = $('trPortfolio');
  if (el) {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.range) {
        range = b.dataset.range;
        BT.store.set('pfRange', range);
        render();
      } else if (b.dataset.act === 'csv') exportCsv();
      else if (b.dataset.act === 'refresh') {
        busy = true;
        render();
        await Promise.all([window.LedgerModel?.priceNow(), window.SBTrades?.refresh().catch(() => {})]);
        busy = false;
        msg = 'Priced now ✓';
        render();
      }
    });
  }
  BT.on('portfolio-show', show);
  BT.on('trades-render', () => shown() && !opening && render());
  if (shown()) show();
})();
