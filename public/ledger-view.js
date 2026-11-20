// Trades › Ledger. On top, where the money is: NIFTYBEES (₹ invested, units, average price, value now), Options (margin
// in open trades, P&L booked and open) and Total (invested of the capital, cash, P&L). Below, side by side, the
// NIFTYBEES ledger (one row per lot: bought with a trade or reinvested from a trade's options profit — units, price,
// invested, P&L: realised when sold with its trade, else at the price now) and the Options ledger (one row per trade:
// margin invested, P&L booked or open, what its profit bought); then Capital and cash (capital added / withdrawn,
// charges, other). Built from the events, in date order: capital added / withdrawn, a trade opened (NIFTYBEES bought at its price, the
// options' margin), its options closed (P&L booked, margin back), the options profit reinvested in NIFTYBEES (units =
// profit ÷ NIFTYBEES' closing price that day, the rest stays cash), NIFTYBEES sold; and entries typed in (deposits,
// withdrawals, trades made elsewhere, charges, other). Losses come out of cash. Each line shows the cash and the
// NIFTYBEES units after it.
// The trades come from the saved trades (sb-view.js window.SBTrades). Kept on the server (/api/ledger →
// bt-data/ledger.json): the capital, the user's edits per trade (rows), the entries, and the NIFTYBEES closing price
// used for each day (px; read once from the recorded history, editable), so the history does not move.
(function () {
  const { esc, inr, inrS, cls } = BT;
  const $ = (id) => document.getElementById(id);
  const TYPES = { deposit: 'Capital added', withdrawal: 'Capital withdrawn', trade: 'Trade made elsewhere', charges: 'Charges', other: 'Other income / expense' };
  const SCOPES = { live: 'Live trades', paper: 'Paper trades', all: 'All trades' };
  let L = null; // { capital, capitalDate, scope, reinvest, rows: { tradeId: edits }, entries: [], px: { day: { px, src } } }
  let loaded = false;
  let editing = null; // { kind: 'trade' | 'entry' | 'px' | 'new', id }
  let msg = '';
  let pxNow = null; // NIFTYBEES now { px, how }
  const tried = new Set(); // days whose closing price was looked up (found or not) this session
  let fetching = false;

  const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const isoDay = (ms) => (ms > 0 ? new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10) : '');
  const dayTxt = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—');
  const R = (v) => Math.round(v);
  const money = (v) => (v == null || !Number.isFinite(v) ? '—' : inr(R(v)));
  const signed = (v) => (v == null || !Number.isFinite(v) ? '—' : inrS(R(v)));
  const units = (n) => Math.round(n).toLocaleString('en-IN');
  const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)} %`);
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const prevDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 86400_000).toISOString().slice(0, 10);

  async function load() {
    try {
      const r = await BT.api('/api/ledger');
      L = r.ledger || {};
    } catch (e) {
      L = null;
      msg = 'Could not read the ledger: ' + e.message;
    }
    if (L) {
      L.capital = Number(L.capital) || 0;
      L.scope ||= 'live';
      L.rows ||= {};
      L.entries ||= [];
      L.px ||= {};
      if (L.reinvest == null) L.reinvest = true;
    }
    loaded = true;
  }
  async function save(note) {
    try {
      L = (await BT.api('/api/ledger', { ledger: L })).ledger;
      msg = note || 'Saved ✓';
    } catch (e) {
      msg = 'Could not save: ' + e.message;
    }
    render();
  }

  // ---------- NIFTYBEES prices ----------
  // The closing price of a day: the user's, else the one kept, else today's live price (not kept: it still moves),
  // else unknown (looked up by fetchPrices).
  function pxOf(day) {
    const k = L.px[day];
    if (k?.px > 0) return { px: k.px, how: k.src === 'user' ? 'your price' : `close ${dayTxt(k.day || day)}` };
    if (day >= today() && pxNow?.px > 0) return { px: pxNow.px, how: 'live now' };
    return null;
  }
  // The days that need a price, read from the recorded NIFTYBEES history (the day's last minute; a holiday: the trading
  // day before, up to a week back), kept in the ledger.
  async function fetchPrices(days) {
    if (fetching) return;
    const need = [...new Set(days)].filter((d) => d && d < today() && !(L.px[d]?.px > 0) && !tried.has(d));
    if (!need.length) return;
    fetching = true;
    let found = 0;
    for (const d of need) {
      tried.add(d);
      let day = d;
      for (let i = 0; i < 7; i++, day = prevDay(day)) {
        const a = (await BT.api('/api/sb/bees?day=' + day).catch(() => null))?.bees;
        const close = a ? [...a].reverse().find((v) => v > 0) : null;
        if (close > 0) {
          L.px[d] = { px: close, src: 'auto', day };
          found++;
          break;
        }
      }
    }
    fetching = false;
    if (found) await save(`NIFTYBEES prices read for ${found} day${found === 1 ? '' : 's'} ✓`);
    else render();
  }

  // ---------- events ----------
  // A saved trade, as the ledger reads it (the user's edits on top of the trade's own figures)
  function tradeInfo(t) {
    const T = window.SBTrades;
    const x = T.split(t);
    const u = t.summary || {};
    const legs = t.snap?.legs || [];
    const m = t.snap?.mcc;
    const ed = L.rows[t.id] || {};
    const open = u.open > 0;
    const opened = legs.map((l) => l.entryDay).filter(Boolean).sort()[0] || m?.day || isoDay(t.createdAt || t.savedAt);
    const lastExit = legs.map((l) => l.exitDay).filter(Boolean).sort().pop();
    const closedOn = open ? null : ed.closeDate || lastExit || isoDay(t.closedAt || t.savedAt);
    // the options' capital: margin of the shorts + premium of the longs (payoff.js estimate) for the first day's legs
    const lot = u.lot || BT.meta?.calendar?.liveLot || 65;
    const first = legs.filter((l) => (l.entryDay || opened) === opened);
    const spot = first.find((l) => l.spotIn > 0)?.spotIn || t.snap?.spotEntry || 0;
    let marginAuto = 0;
    if (first.length && spot > 0 && BT.payoff?.capital) {
      try {
        marginAuto = R(BT.payoff.capital(first.map((l) => ({ action: l.action, type: l.type, strike: l.strike, lots: l.lots, lot, entryPx: l.entryPx })), spot).total);
      } catch {
        marginAuto = 0;
      }
    }
    const charges = num(ed.charges) ?? 0;
    const optAuto = x.opt == null ? null : x.opt - charges;
    const bees = m?.on && m.qty > 0 && m.price > 0 && !ed.beesHeld ? { qty: m.qty, price: m.price, day: m.day || opened, exitPx: m.exitPx > 0 ? m.exitPx : null, exitDay: m.exitDay || closedOn } : null;
    return {
      t,
      id: t.id,
      name: t.name,
      strategy: T.strategy(t) || (x.mcc ? 'Held against NIFTYBEES' : 'Options'),
      account: T.account(t) === 'live' ? 'Live' : 'Paper',
      open,
      opened: ed.date || opened,
      closedOn,
      margin: num(ed.margin) ?? marginAuto,
      marginAuto,
      charges,
      opt: num(ed.pnl) ?? optAuto, // options P&L after charges (open: now, or as saved)
      optAuto,
      optNow: x.optNow,
      bees,
      beesHeld: Boolean(ed.beesHeld),
      notes: ed.notes || '',
      edited: Object.keys(ed).filter((k) => ed[k] !== '' && ed[k] != null && ed[k] !== false),
    };
  }
  // Every event in date order, with the running cash, NIFTYBEES units and their cost, and the options' margin.
  function build(scope) {
    const T = window.SBTrades;
    const sc = scope || L.scope;
    const trades = (T ? T.list().filter((t) => sc === 'all' || T.account(t) === sc) : []).map(tradeInfo);
    const ev = [];
    const add = (o) => ev.push(o);
    // order within a day: money in, NIFTYBEES sold and options closed (a profit reinvested), other entries, then new
    // trades (NIFTYBEES bought, margin), money out — so a roll's sale frees the cash before the next trade buys
    if (L.capital > 0) add({ date: L.capitalDate || '', ord: 0, kind: 'capital', cash: L.capital, title: 'Initial capital', key: { kind: 'capital' } });
    for (const tr of trades) {
      if (tr.bees) add({ date: tr.bees.day || tr.opened, ord: 1, kind: 'buy', tr, buy: { qty: tr.bees.qty, price: tr.bees.price }, title: `Opened ${tr.name}`, sub: `bought ${units(tr.bees.qty)} NIFTYBEES at ₹${tr.bees.price.toFixed(2)}` });
      if (tr.margin > 0) add({ date: tr.opened, ord: 1.1, kind: 'margin', tr, margin: tr.margin, title: tr.bees ? `${tr.name}: options` : `Opened ${tr.name}`, sub: `${tr.strategy} · options margin and premium${tr.edited.includes('margin') ? ' (yours)' : ' (estimate)'}` });
      if (!tr.open && tr.closedOn) add({ date: tr.closedOn, ord: 0.8, kind: 'close', tr, pnl: tr.opt ?? 0, release: tr.margin, title: `Closed ${tr.name}: options`, sub: `${tr.charges ? `after ₹${units(tr.charges)} charges · ` : ''}margin back` });
      if (tr.bees?.exitPx > 0) add({ date: tr.bees.exitDay || tr.closedOn || today(), ord: 0.5, kind: 'sell', tr, sell: { qty: tr.bees.qty, price: tr.bees.exitPx }, title: `Sold NIFTYBEES of ${tr.name}`, sub: `${units(tr.bees.qty)} at ₹${tr.bees.exitPx.toFixed(2)}` });
    }
    for (const e of L.entries) {
      const amt = Math.abs(num(e.amount) ?? 0);
      const base = { date: e.date || '', entry: e, key: { kind: 'entry', id: e.id }, title: e.desc || TYPES[e.type] || 'Entry' };
      if (e.type === 'deposit') add({ ...base, ord: 0, kind: 'deposit', cash: amt, sub: 'capital added' });
      else if (e.type === 'withdrawal') add({ ...base, ord: 5, kind: 'withdrawal', cash: -amt, sub: 'capital withdrawn' });
      else if (e.type === 'charges') add({ ...base, ord: 0.9, kind: 'other', other: -amt, sub: 'charges' });
      else if (e.type === 'other') add({ ...base, ord: 0.9, kind: 'other', other: num(e.pnl) ?? 0, sub: 'other income / expense' });
      else if (e.type === 'trade') {
        const net = (num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0);
        const inv = Math.abs(num(e.invested) ?? 0);
        if (e.status === 'open') add({ ...base, ord: 1.1, kind: 'margin', margin: inv, openPnl: net, sub: 'trade made elsewhere · open' });
        else add({ ...base, ord: 0.8, kind: 'close', pnl: net, release: 0, sub: 'trade made elsewhere · P&L after charges' });
      }
    }
    // the initial capital with no date: on the first day of the rest
    const cap = ev.find((e) => e.kind === 'capital' && !e.date);
    if (cap) cap.date = ev.map((e) => e.date).filter(Boolean).sort()[0] || today();
    ev.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.ord - b.ord);
    // the options profit of each close is reinvested in NIFTYBEES at that day's closing price (L.reinvest)
    const out = [];
    const s = { cash: 0, units: 0, cost: 0, margin: 0, optBooked: 0, beesReal: 0, other: 0, dep: 0, wd: 0, missing: [] };
    for (const e of ev) {
      if (e.kind === 'capital' || e.kind === 'deposit') {
        s.cash += e.cash;
        s.dep += e.kind === 'deposit' ? e.cash : 0;
      } else if (e.kind === 'withdrawal') {
        s.cash += e.cash;
        s.wd -= e.cash;
      } else if (e.kind === 'buy') {
        e.beesAmt = e.buy.qty * e.buy.price;
        s.cash -= e.beesAmt;
        s.units += e.buy.qty;
        s.cost += e.beesAmt;
      } else if (e.kind === 'margin') {
        s.cash -= e.margin;
        s.margin += e.margin;
      } else if (e.kind === 'close') {
        s.cash += e.pnl + e.release;
        s.margin -= e.release;
        s.optBooked += e.pnl;
      } else if (e.kind === 'sell') {
        // the trade's own lot (its units at their buy price) is sold: the P&L is that lot's
        const q = Math.min(e.sell.qty, s.units);
        const lotPx = e.tr?.bees?.price ?? (s.units > 0 ? s.cost / s.units : 0);
        e.beesAmt = -q * e.sell.price;
        e.realised = q * (e.sell.price - lotPx);
        s.cash += q * e.sell.price;
        s.cost -= q * lotPx;
        s.units -= q;
        s.beesReal += e.realised;
      } else if (e.kind === 'other') {
        s.cash += e.other;
        s.other += e.other;
      }
      Object.assign(e, { cashAfter: s.cash, unitsAfter: s.units });
      out.push(e);
      if (e.kind === 'close' && e.pnl > 0 && L.reinvest) {
        const p = pxOf(e.date);
        const r = { date: e.date, kind: 'reinvest', from: e, key: { kind: 'px', id: e.date }, title: 'Profit reinvested in NIFTYBEES' };
        if (!p) {
          s.missing.push(e.date);
          Object.assign(r, { sub: `waiting for the NIFTYBEES price of ${dayTxt(e.date)} — ✎ to enter it`, pending: true, cashAfter: s.cash, unitsAfter: s.units });
        } else {
          const q = Math.floor(e.pnl / p.px);
          const amt = q * p.px;
          s.cash -= amt;
          s.units += q;
          s.cost += amt;
          Object.assign(r, { buy: { qty: q, price: p.px }, beesAmt: amt, sub: `${units(q)} units at ₹${p.px.toFixed(2)} (${p.how})${e.pnl - amt >= 1 ? `, ₹${units(e.pnl - amt)} left as cash` : ''}`, cashAfter: s.cash, unitsAfter: s.units });
        }
        out.push(r);
      }
    }
    // open trades' options P&L now (not booked: shown in the Options card, not in the cash)
    const optOpen = trades.filter((t) => t.open).reduce((a, t) => a + (t.opt || 0), 0) + L.entries.filter((e) => e.type === 'trade' && e.status === 'open').reduce((a, e) => a + (num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0), 0);
    const px = pxNow?.px > 0 ? pxNow.px : null;
    const value = px ? s.units * px : null;
    const capital = L.capital + s.dep - s.wd;
    const beesUnreal = value == null ? null : value - s.cost;
    const total = s.optBooked + optOpen + s.beesReal + (beesUnreal || 0) + s.other;
    return { events: out, trades, s, optOpen, px, value, capital, beesUnreal, total, ret: capital > 0 ? total / capital : null, nOpen: trades.filter((t) => t.open).length };
  }

  // ---------- drawing ----------
  function cardsHtml(B) {
    const s = B.s;
    const avg = s.units > 0 ? s.cost / s.units : null;
    const invested = s.cost + s.margin;
    return `<div class="lg-cards">
      <div class="lg-card"><div class="lg-cl">NIFTYBEES</div><div class="lg-cv">${money(s.cost)}</div>
        <div class="lg-cs">${units(s.units)} units${avg ? ` · avg ₹${avg.toFixed(2)}` : ''}</div>
        <div class="lg-cs">${B.value == null ? 'no price now' : `value now ${money(B.value)} <b class="${cls(B.beesUnreal)}">${signed(B.beesUnreal)}</b>`}${s.beesReal ? ` · sold ${signed(s.beesReal)}` : ''}</div>
        <div class="lg-cs muted">${B.px ? `NIFTYBEES ₹${B.px.toFixed(2)} ${pxNow?.how === 'tick' ? 'streamed' : 'now'}` : ''}</div></div>
      <div class="lg-card"><div class="lg-cl">Options</div><div class="lg-cv">${money(s.margin)}</div>
        <div class="lg-cs">margin in ${B.nOpen} open trade${B.nOpen === 1 ? '' : 's'}</div>
        <div class="lg-cs">booked <b class="${cls(s.optBooked)}">${signed(s.optBooked)}</b> · open <b class="${cls(B.optOpen)}">${signed(B.optOpen)}</b></div>
        ${s.other ? `<div class="lg-cs">other entries <b class="${cls(s.other)}">${signed(s.other)}</b></div>` : ''}</div>
      <div class="lg-card total"><div class="lg-cl">Total</div><div class="lg-cv">${money(invested)}</div>
        <div class="lg-cs">invested of ${money(B.capital)} capital${B.capital > 0 ? ` (${((invested / B.capital) * 100).toFixed(0)} %)` : ''}</div>
        <div class="lg-cs">cash ${money(s.cash)} · P&amp;L <b class="${cls(B.total)}">${signed(B.total)}</b> <span class="${cls(B.ret)}">${pct(B.ret)}</span></div>
        <div class="lg-cs muted">worth now ${B.value == null ? '—' : money(s.cash + B.value + s.margin + B.optOpen)} (cash + NIFTYBEES + margin + open P&amp;L)</div></div>
    </div>`;
  }
  const edBtn = (kind, id) => (editing ? '' : `<button class="btn-sm ghost lg-edbtn" data-ed="${kind}" data-id="${esc(String(id))}" title="Edit">✎</button>`);
  const pnlCell = (v, sub) => `<td>${v == null ? '—' : `<b class="${cls(v)}">${signed(v)}</b>`}${sub ? `<div class="lg-sub">${sub}</div>` : ''}</td>`;
  const edMark = (tr) => (tr?.edited.length ? ` <span class="lg-ed" title="Edited by you: ${esc(tr.edited.join(', '))}">✎</span>` : '');

  // The NIFTYBEES lots: bought with a trade, or with a trade's options profit. P&L: sold with its trade (realised), else
  // at the price now.
  function beesLots(B) {
    const lots = [];
    for (const e of B.events) {
      if (e.kind === 'buy') {
        const sell = B.events.find((x) => x.kind === 'sell' && x.tr === e.tr);
        lots.push({ date: e.date, tr: e.tr, how: 'bought', qty: e.buy.qty, price: e.buy.price, amt: e.buy.qty * e.buy.price, sold: sell ? { date: sell.date, price: sell.sell.price } : null });
      } else if (e.kind === 'reinvest') {
        const tr = e.from.tr;
        lots.push({ date: e.date, tr, entry: e.from.entry, how: 'reinvest', key: e.key, pending: e.pending, from: e.from, qty: e.buy?.qty || 0, price: e.buy?.price || null, amt: e.beesAmt || 0, left: e.buy ? e.from.pnl - e.beesAmt : null });
      }
    }
    for (const l of lots) {
      if (l.sold) l.pnl = l.qty * (l.sold.price - l.price);
      else if (B.px && l.qty) l.pnl = l.qty * (B.px - l.price);
      else l.pnl = null;
    }
    return lots;
  }
  function beesPanel(B) {
    const lots = beesLots(B);
    const held = lots.filter((l) => !l.sold);
    const inv = held.reduce((a, l) => a + l.amt, 0);
    const real = lots.filter((l) => l.sold).reduce((a, l) => a + (l.pnl || 0), 0);
    const unreal = B.px ? held.reduce((a, l) => a + (l.pnl || 0), 0) : null;
    const row = (l) => {
      const name = l.tr ? l.tr.name : l.entry?.desc || 'Trade made elsewhere';
      const what =
        l.how === 'bought'
          ? `<b>${esc(name)}</b>${edMark(l.tr)}<div class="lg-sub">bought with the trade</div>`
          : `<b>Reinvested</b> <span class="lg-tag">profit</span><div class="lg-sub">options profit ${signed(l.from.pnl)} of ${esc(name)}${l.left >= 1 ? ` · ₹${units(l.left)} left as cash` : ''}</div>`;
      const ed = l.how === 'reinvest' ? edBtn('px', l.key.id) : l.tr ? edBtn('trade', l.tr.id) : '';
      if (l.pending)
        return `<tr class="lg-pending"><td class="lg-d">${dayTxt(l.date)}</td><td class="l">${what}<div class="lg-sub">waiting for the NIFTYBEES price of ${dayTxt(l.date)} — ✎ to enter it</div></td><td></td><td></td><td></td><td></td><td class="lg-act">${ed}</td></tr>`;
      return `<tr class="${l.how === 'reinvest' ? 'lg-k-reinvest' : ''}${l.sold ? ' lg-sold' : ''}"><td class="lg-d">${dayTxt(l.date)}</td><td class="l">${what}</td>
        <td>${units(l.qty)}<div class="lg-sub">at ₹${l.price.toFixed(2)}</div></td>
        <td>${money(l.amt)}</td>
        ${pnlCell(l.pnl, l.sold ? `sold ${dayTxt(l.sold.date)} at ₹${l.sold.price.toFixed(2)}` : B.px ? `held · now ₹${B.px.toFixed(2)}` : 'held · no price now')}
        <td>${l.sold ? '<span class="lg-st closed">Sold</span>' : '<span class="lg-st open">Held</span>'}</td><td class="lg-act">${ed}</td></tr>`;
    };
    return `<section class="lg-side lg-bees"><div class="lg-side-h"><h4>NIFTYBEES</h4><span class="muted small">${units(B.s.units)} units held · invested ${money(inv)}</span></div>
      <div class="tbl-wrap lg-wrap"><table class="grid-tbl lg-tbl"><thead><tr><th>Date</th><th class="l">Trade</th><th>Units</th><th title="Units × buy price">Invested ₹</th><th title="Sold with its trade: realised. Held: at the price now">P&amp;L ₹</th><th></th><th></th></tr></thead>
      <tbody>${lots.slice().reverse().map(row).join('') || '<tr><td colspan="7" class="muted pad">No NIFTYBEES bought yet.</td></tr>'}</tbody>
      <tfoot><tr class="lg-total"><td></td><td class="l"><b>Total</b><div class="lg-sub">held ${money(inv)} · sold P&amp;L ${signed(real)}</div></td><td>${units(B.s.units)}</td><td>${money(inv)}</td>${pnlCell(unreal == null ? real : real + unreal, unreal == null ? 'sold only (no price now)' : `sold ${signed(real)} · held ${signed(unreal)}`)}<td></td><td></td></tr></tfoot></table></div></section>`;
  }
  // The options: one row per trade (and per trade made elsewhere)
  function optPanel(B) {
    const rows = [];
    for (const tr of B.trades) {
      const re = B.events.find((x) => x.kind === 'reinvest' && x.from.tr === tr);
      rows.push({ date: tr.opened, tr, name: tr.name, sub: tr.strategy + (tr.charges ? ` · after ₹${units(tr.charges)} charges` : ''), margin: tr.margin, marginMine: tr.edited.includes('margin'), pnl: tr.opt, open: tr.open, closed: tr.closedOn, re, now: tr.optNow });
    }
    for (const e of L.entries.filter((x) => x.type === 'trade')) {
      const re = B.events.find((x) => x.kind === 'reinvest' && x.from.entry === e);
      rows.push({ date: e.date, entry: e, name: e.desc || 'Trade made elsewhere', sub: 'made elsewhere' + (num(e.charges) ? ` · after ₹${units(Math.abs(num(e.charges)))} charges` : ''), margin: Math.abs(num(e.invested) ?? 0), marginMine: true, pnl: (num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0), open: e.status === 'open', closed: e.status === 'open' ? null : e.date, re });
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const row = (r) => {
      const ed = r.tr ? edBtn('trade', r.tr.id) : edBtn('entry', r.entry.id);
      const reTxt = r.re ? (r.re.pending ? 'profit: waiting for the NIFTYBEES price' : `→ ${units(r.re.buy.qty)} NIFTYBEES at ₹${r.re.buy.price.toFixed(2)}`) : '';
      return `<tr class="${r.open ? 'lg-open' : ''}"><td class="lg-d">${dayTxt(r.date)}</td><td class="l"><b>${esc(r.name)}</b>${edMark(r.tr)}<div class="lg-sub">${esc(r.sub)}</div>${r.tr?.notes || r.entry?.notes ? `<div class="lg-sub lg-note">${esc(r.tr?.notes || r.entry?.notes)}</div>` : ''}</td>
        <td>${r.margin > 0 ? money(r.margin) : '—'}<div class="lg-sub">${r.marginMine ? 'margin' : 'margin (estimate)'}</div></td>
        ${pnlCell(r.pnl, r.open ? `open · ${r.now ? 'now' : 'as saved'}` : reTxt)}
        <td>${r.open ? '<span class="lg-st open">Open</span>' : `<span class="lg-st closed">Closed</span><div class="lg-sub">${dayTxt(r.closed)}</div>`}</td><td class="lg-act">${ed}</td></tr>`;
    };
    const s = B.s;
    return `<section class="lg-side lg-opts"><div class="lg-side-h"><h4>Options</h4><span class="muted small">margin in open trades ${money(s.margin)} · ${B.nOpen} open</span></div>
      <div class="tbl-wrap lg-wrap"><table class="grid-tbl lg-tbl"><thead><tr><th>Opened</th><th class="l">Trade</th><th title="The options' margin and premium (an estimate unless you put your own with ✎)">Invested ₹</th><th title="Closed: booked, after charges. Open: now, or as saved">P&amp;L ₹</th><th></th><th></th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="6" class="muted pad">No trades yet.</td></tr>'}</tbody>
      <tfoot><tr class="lg-total"><td></td><td class="l"><b>Total</b><div class="lg-sub">booked ${signed(s.optBooked)} · open ${signed(B.optOpen)}</div></td><td>${money(s.margin)}<div class="lg-sub">in open trades</div></td>${pnlCell(s.optBooked + B.optOpen, `booked ${signed(s.optBooked)} · open ${signed(B.optOpen)}`)}<td></td><td></td></tr></tfoot></table></div></section>`;
  }
  // Capital and cash: capital added / withdrawn, charges and other entries, with the cash after each
  function cashPanel(B) {
    const rows = B.events.filter((e) => ['capital', 'deposit', 'withdrawal', 'other'].includes(e.kind));
    const row = (e) => {
      const amt = e.kind === 'other' ? e.other : e.cash;
      return `<tr><td class="lg-d">${dayTxt(e.date)}</td><td class="l"><b>${esc(e.title)}</b><div class="lg-sub">${esc(e.sub || '')}</div>${e.entry?.notes ? `<div class="lg-sub lg-note">${esc(e.entry.notes)}</div>` : ''}</td><td><b class="${cls(amt)}">${signed(amt)}</b></td><td class="lg-bal">${money(e.cashAfter)}</td><td class="lg-act">${e.kind === 'capital' ? '' : edBtn('entry', e.entry.id)}</td></tr>`;
    };
    return `<section class="lg-side lg-cash"><div class="lg-side-h"><h4>Capital and cash</h4><span class="muted small">capital ${money(B.capital)} · cash now ${money(B.s.cash)}</span></div>
      <div class="tbl-wrap lg-wrap"><table class="grid-tbl lg-tbl"><thead><tr><th>Date</th><th class="l">Entry</th><th>Amount ₹</th><th title="Cash after it, with every NIFTYBEES purchase, margin and P&amp;L up to that day">Cash after</th><th></th></tr></thead>
      <tbody>${rows.slice().reverse().map(row).join('') || '<tr><td colspan="5" class="muted pad">Set the initial capital above, or ＋ Add entry.</td></tr>'}</tbody></table></div></section>`;
  }
  // the form for what is being edited (over the passbook)
  function formHtml(B) {
    if (!editing) return '';
    const inp = (k, v, type = 'number', ph = '', w = 120) => `<input class="num" type="${type}" data-f="${k}" value="${v == null ? '' : esc(String(v))}" placeholder="${esc(String(ph))}" style="width:${w}px">`;
    const lab = (t, h) => `<label class="mini lg-fl"><span>${t}</span>${h}</label>`;
    const btns = (extra = '') => `<div class="set-row"><button class="btn-sm" data-act="save">Save</button><button class="btn-sm ghost" data-act="cancel">Cancel</button>${extra}</div>`;
    if (editing.kind === 'trade') {
      const tr = B.trades.find((x) => x.id === editing.id);
      if (!tr) return '';
      const ed = L.rows[tr.id] || {};
      return `<div class="lg-form"><h4>✎ ${esc(tr.name)} <span class="muted small">${esc(tr.strategy)} · ${tr.account} · the legs themselves are changed in the Builder</span></h4>
        <div class="lg-fields">
          ${lab('Opened on', inp('date', ed.date || '', 'date', '', 140) + `<em>auto ${dayTxt(tr.t.snap?.legs?.map((l) => l.entryDay).filter(Boolean).sort()[0])}</em>`)}
          ${lab('Options closed on', inp('closeDate', ed.closeDate || '', 'date', '', 140) + `<em>${tr.open ? 'open' : 'auto ' + dayTxt(tr.closedOn)}</em>`)}
          ${lab('Options margin ₹', inp('margin', ed.margin ?? '', 'number', tr.marginAuto) + '<em>empty: the estimate</em>')}
          ${lab('Charges ₹', inp('charges', ed.charges ?? '', 'number', 0))}
          ${lab('Options P&amp;L ₹', inp('pnl', ed.pnl ?? '', 'number', tr.optAuto == null ? '' : R(tr.optAuto)) + '<em>after charges; empty: the trade’s</em>')}
          ${lab('NIFTYBEES', `<span><input type="checkbox" data-f="beesHeld" ${ed.beesHeld ? 'checked' : ''}> already held (not bought again)</span>`)}
          ${lab('Notes', inp('notes', ed.notes || '', 'text', 'notes', 260))}
        </div>${btns(tr.edited.length ? '<button class="btn-sm ghost" data-act="reset" title="Back to the trade’s own figures">Reset</button>' : '')}</div>`;
    }
    if (editing.kind === 'px') {
      const k = L.px[editing.id];
      return `<div class="lg-form"><h4>✎ NIFTYBEES price on ${dayTxt(editing.id)} <span class="muted small">the profit of that day is reinvested at it</span></h4>
        <div class="lg-fields">${lab('Price ₹', inp('px', k?.px ?? '', 'number', 'e.g. 268.40') + `<em>${k?.src === 'auto' ? `read from the history (close ${dayTxt(k.day || editing.id)})` : k?.src === 'user' ? 'yours' : 'not found in the history'}</em>`)}</div>
        ${btns(k?.src === 'user' ? '<button class="btn-sm ghost" data-act="reset">Read from the history</button>' : '')}</div>`;
    }
    const e = editing.kind === 'entry' ? L.entries.find((x) => String(x.id) === String(editing.id)) : null;
    const x = editing.draft || e || { date: today(), type: 'deposit', status: 'closed' };
    const t = x.type;
    const amtTypes = ['deposit', 'withdrawal', 'charges'];
    return `<div class="lg-form"><h4>${e ? '✎ Entry' : '＋ New entry'}</h4>
      <div class="lg-fields">
        ${lab('Type', `<select data-f="type">${Object.entries(TYPES).map(([k, n]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
        ${lab('Date', inp('date', x.date || today(), 'date', '', 140))}
        ${lab('Description', inp('desc', x.desc || '', 'text', t === 'trade' ? 'e.g. Bank Nifty spread at the broker' : 'e.g. top-up from savings', 240))}
        ${amtTypes.includes(t) ? lab('Amount ₹', inp('amount', x.amount ?? '', 'number', '500000')) : ''}
        ${t === 'trade' ? lab('Status', `<select data-f="status"><option value="closed" ${x.status !== 'open' ? 'selected' : ''}>Closed</option><option value="open" ${x.status === 'open' ? 'selected' : ''}>Open</option></select>`) : ''}
        ${t === 'trade' ? lab('Margin / invested ₹', inp('invested', x.invested ?? '', 'number', '200000')) : ''}
        ${t === 'trade' ? lab('P&amp;L ₹', inp('pnl', x.pnl ?? '', 'number', 'before charges')) : ''}
        ${t === 'trade' ? lab('Charges ₹', inp('charges', x.charges ?? '', 'number', '0')) : ''}
        ${t === 'other' ? lab('Amount ₹', inp('pnl', x.pnl ?? '', 'number', '+ income, − expense')) : ''}
        ${lab('Notes', inp('notes', x.notes || '', 'text', 'notes', 220))}
      </div>${btns(e ? '<button class="btn-sm ghost lg-del" data-act="delete">🗑 Delete</button>' : '')}
      ${t === 'trade' ? '<p class="muted small">A closed trade made elsewhere books its P&amp;L on its date (a profit is reinvested in NIFTYBEES like any other); an open one takes its margin from the cash until you mark it closed.</p>' : ''}</div>`;
  }

  function render() {
    const el = $('trLedger');
    if (!el) return;
    if (!loaded) return void (el.innerHTML = '<div class="pad muted">Reading the ledger…</div>');
    if (!L) return void (el.innerHTML = `<div class="pad err">${esc(msg)}</div>`);
    if (!window.SBTrades) return void (el.innerHTML = '<div class="pad muted">The saved trades are not loaded yet.</div>');
    const B = build();
    if (B.s.missing.length && !fetching) fetchPrices(B.s.missing);
    el.innerHTML = `<div class="panel-head lg-head"><h3>Ledger</h3>
        <label class="mini">Trades <select data-f="scope">${Object.entries(SCOPES).map(([k, n]) => `<option value="${k}" ${k === L.scope ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="mini" title="Each options profit buys NIFTYBEES at that day's closing price (the rest stays cash). Losses come out of the cash."><input type="checkbox" data-f="reinvest" ${L.reinvest ? 'checked' : ''}> Reinvest options profit in NIFTYBEES</label>
        <span class="spacer"></span>
        <span class="muted small">${esc(msg)}</span>
        <button class="btn-sm ghost" data-act="refresh" title="Price the open trades and NIFTYBEES now">↻ Prices now</button>
        <button class="btn-sm" data-act="add">＋ Add entry</button>
        <button class="btn-sm ghost tr-export" data-act="xlsx" title="Download the summary, the NIFTYBEES and Options ledgers and the capital and cash as an Excel workbook (.xlsx)">⬇ Excel</button></div>
      <div class="lg-cap set-row"><b>Initial capital</b> <span class="lbl">₹</span><input class="num" type="number" min="0" step="10000" data-f="capital" value="${L.capital || ''}" placeholder="2500000" style="width:130px"> <span class="lbl">on</span> <input type="date" data-f="capitalDate" value="${esc(L.capitalDate || '')}"></div>
      ${cardsHtml(B)}
      ${formHtml(B)}
      <div class="lg-split">${beesPanel(B)}${optPanel(B)}</div>
      ${cashPanel(B)}
      <p class="muted small pad">The trades are the ${SCOPES[L.scope].toLowerCase()} saved in the Builder. <b>NIFTYBEES</b>: each trade's units at the price saved with it${L.reinvest ? ', and each options profit reinvested at that day’s closing price (the rest stays cash)' : ''}; P&amp;L when sold with the trade, else at the price now. <b>Options</b>: the margin and premium of each trade (an estimate unless you put your own with ✎) and its P&amp;L after charges — booked when closed, now (or as saved) while open. Losses come out of the cash.</p>`;
  }

  // ---------- actions ----------
  function formValues() {
    const out = {};
    $('trLedger')
      .querySelectorAll('.lg-form [data-f]')
      .forEach((i) => (out[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value.trim()));
    return out;
  }
  function saveForm() {
    const v = formValues();
    if (editing.kind === 'trade') {
      const ed = {};
      for (const k of ['date', 'closeDate', 'notes']) if (v[k]) ed[k] = v[k];
      for (const k of ['margin', 'charges', 'pnl']) if (v[k] !== '' && Number.isFinite(Number(v[k]))) ed[k] = Number(v[k]);
      if (v.beesHeld) ed.beesHeld = true;
      if (Object.keys(ed).length) L.rows[editing.id] = ed;
      else delete L.rows[editing.id];
      editing = null;
      return save('Trade saved ✓');
    }
    if (editing.kind === 'px') {
      const p = Number(v.px);
      if (!(p > 0)) return alert('Enter the NIFTYBEES price in ₹');
      L.px[editing.id] = { px: p, src: 'user' };
      editing = null;
      return save('Price saved ✓');
    }
    const e = { id: editing.kind === 'entry' ? editing.id : 'e' + Date.now().toString(36), date: v.date || today(), type: TYPES[v.type] ? v.type : 'other', desc: v.desc || '', notes: v.notes || '' };
    for (const k of ['amount', 'invested', 'pnl', 'charges']) if (v[k] != null && v[k] !== '' && Number.isFinite(Number(v[k]))) e[k] = Number(v[k]);
    if (e.type === 'trade') e.status = v.status === 'open' ? 'open' : 'closed';
    if (['deposit', 'withdrawal', 'charges'].includes(e.type) && !(e.amount > 0)) return alert('Enter the amount in ₹');
    if (e.type === 'other' && e.pnl == null) return alert('Enter the amount: + for income, − for an expense');
    if (e.type === 'trade' && e.pnl == null && e.status !== 'open') return alert('Enter the P&L of the trade');
    if (editing.kind === 'entry') L.entries = L.entries.map((x) => (String(x.id) === String(e.id) ? e : x));
    else L.entries.push(e);
    const added = editing.kind !== 'entry';
    editing = null;
    return save(added ? 'Entry added ✓' : 'Entry saved ✓');
  }
  async function priceNow() {
    pxNow = await BT.api('/api/mcc/bees').catch(() => null);
    if (!(pxNow?.px > 0)) pxNow = null;
  }

  function bind() {
    const el = $('trLedger');
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.ed) {
        editing = { kind: b.dataset.ed, id: b.dataset.id };
        msg = '';
        render();
        el.querySelector('.lg-form')?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const a = b.dataset.act;
      if (a === 'add') {
        editing = { kind: 'new' };
        msg = '';
        render();
        el.querySelector('.lg-form [data-f="desc"]')?.focus();
      } else if (a === 'cancel') {
        editing = null;
        render();
      } else if (a === 'save') saveForm();
      else if (a === 'reset') {
        if (editing.kind === 'trade') delete L.rows[editing.id];
        if (editing.kind === 'px') {
          delete L.px[editing.id];
          tried.delete(editing.id);
        }
        editing = null;
        save('Back to the worked-out figures ✓');
      } else if (a === 'delete') {
        const x = L.entries.find((v) => String(v.id) === String(editing.id));
        if (!x || !confirm(`Delete this entry (${TYPES[x.type] || 'entry'}${x.desc ? ': ' + x.desc : ''}, ${dayTxt(x.date)})? This cannot be undone.`)) return;
        L.entries = L.entries.filter((v) => String(v.id) !== String(editing.id));
        editing = null;
        save('Entry deleted');
      } else if (a === 'refresh') {
        b.disabled = true;
        b.textContent = 'Pricing…';
        await Promise.all([priceNow(), window.SBTrades?.refresh().catch(() => {})]);
        render();
      } else if (a === 'xlsx') exportXlsx();
    });
    el.addEventListener('change', (e) => {
      const f = e.target.dataset?.f;
      if (!f || e.target.closest('.lg-form')) {
        // an entry's type changes the boxes it needs: drawn again with what was typed
        if (f === 'type') {
          editing = { ...editing, draft: { ...formValues(), id: editing.id } };
          render();
        }
        return;
      }
      if (f === 'scope') {
        L.scope = e.target.value;
        save('Showing ' + SCOPES[L.scope].toLowerCase());
      } else if (f === 'reinvest') {
        L.reinvest = e.target.checked;
        save(L.reinvest ? 'Profits reinvested in NIFTYBEES' : 'Profits kept as cash');
      } else if (f === 'capital') {
        const n = Number(e.target.value);
        if (e.target.value !== '' && !(n >= 0)) return alert('Initial capital: an amount in ₹');
        L.capital = n || 0;
        save('Initial capital saved ✓');
      } else if (f === 'capitalDate') {
        L.capitalDate = e.target.value || null;
        save('Date saved ✓');
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest('.lg-form') && e.target.tagName === 'INPUT') {
        e.preventDefault();
        saveForm();
      } else if (e.key === 'Escape' && editing) {
        editing = null;
        render();
      }
    });
  }

  // ---------- Excel: Summary (the three cards), NIFTYBEES (lots), Options (trades), Capital and cash ----------
  function exportXlsx() {
    if (!window.XLSX_LITE) return alert('The Excel writer did not load');
    const B = build();
    const s = B.s;
    const N = (v) => (v == null || !Number.isFinite(v) ? '' : { v: R(v), s: 'n' });
    const NB = (v) => (v == null || !Number.isFinite(v) ? '' : { v: R(v), s: 'nb' });
    const D = (d) => (d ? { v: d, s: 'd' } : '');
    const H = (h) => ({ v: h, s: 'h' });
    const summary = [
      [{ v: 'Trading ledger', s: 't' }],
      [`${SCOPES[L.scope]} · ${L.reinvest ? 'options profit reinvested in NIFTYBEES' : 'profit kept as cash'} · exported ${dayTxt(today())}`],
      [],
      [H(''), H('Rs'), H('')],
      [{ v: 'NIFTYBEES', s: 'b' }],
      ['Invested (cost of the units held)', NB(s.cost)],
      ['Units held', { v: R(s.units), s: 'n' }, s.units > 0 ? `avg Rs ${(s.cost / s.units).toFixed(2)}` : ''],
      ['Value now', N(B.value), B.px ? `at Rs ${B.px.toFixed(2)}` : 'no price now'],
      ['Unrealised P&L', N(B.beesUnreal)],
      ['Realised on sales', N(s.beesReal)],
      [],
      [{ v: 'Options', s: 'b' }],
      ['Margin in open trades', NB(s.margin), `${B.nOpen} open`],
      ['P&L booked (after charges)', N(s.optBooked)],
      ['P&L of open trades', N(B.optOpen)],
      ['Other entries', N(s.other)],
      [],
      [{ v: 'Total', s: 'b' }],
      ['Capital (initial + added − withdrawn)', NB(B.capital), L.capitalDate ? `initial ${R(L.capital)} on ${dayTxt(L.capitalDate)}` : ''],
      ['Invested (NIFTYBEES + options)', NB(s.cost + s.margin)],
      ['Cash', NB(s.cash)],
      ['Total P&L', NB(B.total), { v: B.ret ?? '', s: 'pb' }],
    ];
    // NIFTYBEES: one row per lot (oldest first)
    const bees = [[H('Date'), H('Trade'), H('How'), H('Units'), H('Buy price (Rs)'), H('Invested (Rs)'), H('Status'), H('Sold / now price (Rs)'), H('P&L (Rs)')]];
    for (const l of beesLots(B)) {
      bees.push([
        D(l.date),
        l.tr ? l.tr.name : l.entry?.desc || 'Trade made elsewhere',
        l.how === 'bought' ? 'Bought with the trade' : l.pending ? 'Reinvested profit (price missing)' : 'Reinvested options profit',
        l.qty ? { v: l.qty, s: 'n' } : '',
        l.price || '',
        N(l.amt),
        l.pending ? '' : l.sold ? `Sold ${dayTxt(l.sold.date)}` : 'Held',
        l.sold ? l.sold.price : B.px || '',
        N(l.pnl),
      ]);
    }
    // Options: one row per trade
    const opts = [[H('Opened'), H('Trade'), H('Strategy'), H('Invested / margin (Rs)'), H('Status'), H('Closed'), H('P&L (Rs)'), H('Charges (Rs)'), H('Profit reinvested'), H('Notes')]];
    for (const tr of B.trades.slice().sort((a, b) => (a.opened || '').localeCompare(b.opened || ''))) {
      const re = B.events.find((x) => x.kind === 'reinvest' && x.from.tr === tr);
      opts.push([D(tr.opened), tr.name, tr.strategy, N(tr.margin), tr.open ? 'Open' : 'Closed', D(tr.closedOn), N(tr.opt), tr.charges ? N(-tr.charges) : '', re?.buy ? `${re.buy.qty} NIFTYBEES at ${re.buy.price}` : '', tr.notes]);
    }
    for (const e of L.entries.filter((x) => x.type === 'trade')) {
      const re = B.events.find((x) => x.kind === 'reinvest' && x.from.entry === e);
      opts.push([D(e.date), e.desc || 'Trade made elsewhere', 'Made elsewhere', N(Math.abs(num(e.invested) ?? 0)), e.status === 'open' ? 'Open' : 'Closed', e.status === 'open' ? '' : D(e.date), N((num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0)), num(e.charges) ? N(-Math.abs(num(e.charges))) : '', re?.buy ? `${re.buy.qty} NIFTYBEES at ${re.buy.price}` : '', e.notes || '']);
    }
    // Capital and cash
    const cash = [[H('Date'), H('Entry'), H('Detail'), H('Amount (Rs)'), H('Cash after (Rs)'), H('Notes')]];
    for (const e of B.events.filter((x) => ['capital', 'deposit', 'withdrawal', 'other'].includes(x.kind))) cash.push([D(e.date), e.title, e.sub || '', N(e.kind === 'other' ? e.other : e.cash), N(e.cashAfter), e.entry?.notes || '']);
    XLSX_LITE.download(`ledger-${L.scope}-${today()}.xlsx`, [
      { name: 'Summary', rows: summary, widths: [38, 16, 34] },
      { name: 'NIFTYBEES', rows: bees, widths: [12, 40, 30, 10, 14, 15, 16, 18, 14], freeze: 1 },
      { name: 'Options', rows: opts, widths: [12, 40, 24, 20, 10, 12, 14, 13, 28, 30], freeze: 1 },
      { name: 'Capital and cash', rows: cash, widths: [12, 30, 26, 15, 16, 30], freeze: 1 },
    ]);
  }

  // ---------- shown ----------
  let showing = false;
  async function show() {
    if (showing) return;
    showing = true;
    try {
      if (!loaded) {
        render();
        await load();
      }
      await Promise.all([priceNow(), window.SBTrades && !window.SBTrades.list().length ? window.SBTrades.load() : null]);
    } finally {
      showing = false;
    }
    render();
  }
  BT.on('ledger-show', show);
  // Trades › Portfolio P&L (portfolio-view.js) reads the same events and figures: build('live') = the Live trades.
  window.LedgerModel = {
    async ready() {
      if (!loaded) await load();
      if (!pxNow) await priceNow();
      if (window.SBTrades && !window.SBTrades.list().length) await window.SBTrades.load();
      return Boolean(L);
    },
    ledger: () => L,
    error: () => (L ? '' : msg),
    build: (scope) => (L && window.SBTrades ? build(scope) : null),
    beesLots: (B) => beesLots(B),
    pxNow: () => pxNow,
    priceNow,
    fetchPrices: (days) => fetchPrices(days),
  };
  // the trades drawn again (loaded, priced): the ledger follows unless something is being edited; the screen opened on
  // the Ledger tab (its first 'ledger-show' came before this file was read): the ledger is read now
  BT.on('trades-render', () => {
    if (!window.SBTrades?.shown() || editing) return;
    if (!loaded) show();
    else render();
  });
  if ($('trLedger')) bind();
  if (window.SBTrades?.shown()) show();
})();
