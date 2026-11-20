// Trades: the portal's saved trades on the phone, read from its repository (js/trades.js). Four tabs, as on the
// portal's Trades screen: Live (real-money trades, closed and open), Paper, Ledger (NIFTYBEES lots, options per
// trade, capital and cash) and Portfolio P&L (the Live trades: summary, growth, allocation, detailed ledger, P&L by
// day / week / month, P&L by trade, insights). Read only: trades are saved and edited on the portal.
// Prices now (open legs, NIFTYBEES, Nifty) come from Upstox when logged in; otherwise the figures as saved.
// A trade's CE and PE legs are one options item everywhere; NIFTYBEES is its own item.
import { BEES, NIFTY, tokenInfo } from '../market.js';
import * as store from '../store.js';
import * as T from '../trades.js';
import { lineChart } from '../charts.js';
import { esc, inr, num, tone, toast } from '../ui.js';

const TABS = { live: 'Live', paper: 'Paper', ledger: 'Ledger', portfolio: 'Portfolio P&L' };
const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, All: 0 };
const SCOPES = { live: 'Live', paper: 'Paper', all: 'All' };
let root;
let data = null; // { trades, ledger, at, from, stale, error }
let err = null;
let loading = false;
let lastLoad = 0;
let px = { prices: new Map(), beesPx: null, nifty: null, at: 0 }; // prices now (Upstox)
let closes = {}; // NIFTYBEES daily closes (Upstox), day -> close
let closesKey = '';
const expanded = new Set();

const tab = () => (TABS[store.get('tradesTab')] ? store.get('tradesTab') : 'live');
const range = () => (RANGES[store.get('tradesRange')] != null ? store.get('tradesRange') : 'All');
const rs = (v, sign = true) => inr(v, { sign, lakh: false });
const rl = (v, sign = false) => inr(v, { sign });
const pct = (v) => (v == null || !Number.isFinite(v) ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`);
const dayTxt = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—');
const dayShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const monTxt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const units = (n) => num(n, 0);
const live = () => store.settings().source === 'upstox' && tokenInfo().state === 'valid';
const opts = () => ({ prices: px.prices, beesPx: px.beesPx, nifty: px.nifty });

// ---------- pieces ----------
const stat = (label, v, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${v}</b></div>`;
function hbars(items) {
  const max = Math.max(1, ...items.map((x) => Math.abs(x.v || 0)));
  return `<div class="tr-hbars">${items
    .map((x) => `<div class="tr-hb"><span class="tr-hbl"><i class="${x.c}"></i>${esc(x.label)}</span><b class="${tone(x.v)}">${rs(x.v)}</b><div class="tr-hbt"><div class="tr-hbz"></div><div class="tr-hbf ${x.v < 0 ? 'neg' : 'pos'}" style="${x.v < 0 ? 'right' : 'left'}:50%;width:${(Math.abs(x.v || 0) / max) * 50}%"></div></div></div>`)
    .join('')}</div>`;
}
function donut(items, centre, sub) {
  const tot = items.reduce((a, x) => a + Math.max(0, x.v), 0) || 1;
  let a0 = -Math.PI / 2;
  const R = 50;
  const r = 34;
  const arcs = items
    .filter((x) => x.v > 0)
    .map((x) => {
      const a1 = a0 + (Math.max(0, x.v) / tot) * Math.PI * 2 - 1e-6;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${(60 + rad * Math.cos(ang)).toFixed(2)},${(60 + rad * Math.sin(ang)).toFixed(2)}`;
      const d = `M${p(R, a0)}A${R},${R} 0 ${big} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${big} 0 ${p(r, a0)}Z`;
      a0 = a1;
      return `<path class="tr-arc ${x.c}" d="${d}"/>`;
    })
    .join('');
  return `<div class="tr-donut"><div class="tr-dc"><svg viewBox="0 0 120 120">${arcs}</svg><div class="tr-dmid"><b>${centre}</b><span>${sub}</span></div></div>
    <ul>${items.map((x) => `<li><i class="${x.c}"></i><div><span>${esc(x.label)}</span><b>${rl(x.v)} <small class="muted">${((100 * Math.max(0, x.v)) / tot).toFixed(0)}%</small></b></div></li>`).join('')}</ul></div>`;
}
// signed vertical bars with labels under them
function vbars(list) {
  if (!list.length) return '<div class="chart-empty">Nothing in this range</div>';
  const max = Math.max(1, ...list.map((b) => Math.abs(b.v)));
  const W = 100 / list.length;
  const hasNeg = list.some((b) => b.v < 0);
  const zero = hasNeg ? 50 : 100;
  return `<div class="tr-vb"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${list
    .map((b, i) => {
      const h = (Math.abs(b.v) / max) * (hasNeg ? 48 : 96);
      return `<rect class="${b.v < 0 ? 'neg' : 'pos'}" x="${i * W + W * 0.15}" width="${W * 0.7}" y="${b.v < 0 ? zero : zero - h}" height="${Math.max(0.5, h)}"/>`;
    })
    .join('')}<line x1="0" x2="100" y1="${zero}" y2="${zero}" class="zero"/></svg>
    <div class="tr-vbl"><span>${esc(list[0].label)}</span>${list.length > 2 ? `<span>${esc(list[Math.floor(list.length / 2)].label)}</span>` : ''}<span>${esc(list[list.length - 1].label)}</span></div></div>`;
}

// ---------- Live / Paper ----------
function tradeCard(t) {
  const x = T.splitOf(t, opts());
  const open = t.summary?.open > 0;
  const legs = T.legRows(t, px.prices);
  const o = T.optLegs({ t });
  const id = t.id;
  const exp = expanded.has(id);
  const m = x.m;
  const beesSub = !m?.on ? '' : m.exitPx > 0 ? `${units(m.qty)} sold at ₹${num(m.exitPx)}` : x.beesHow === 'live' ? `${units(m.qty)} at ₹${num(px.beesPx)} now` : x.beesHow === 'est' ? `${units(m.qty)} · estimated from Nifty` : `${units(m.qty)} held`;
  return `<article class="card pos tr-card ${open ? 'open' : 'closed'}" data-id="${esc(id)}">
    <button class="pos-head" data-act="toggle" aria-expanded="${exp}">
      <span class="pos-title"><b>${esc(t.name)}</b><small>${esc(T.strategyOf(t) || 'Options')} · ${open ? 'open' : 'closed'} · ${esc((t.summary?.expiries || []).map(dayShort).join(', '))}</small></span>
      <span class="pos-pnl ${tone(x.overall)}">${x.overall == null ? '—' : rl(x.overall, true)}</span>
    </button>
    <table class="legs tr-items"><thead><tr><th>Item</th><th>Qty</th><th>Bought at</th><th>P&amp;L</th></tr></thead><tbody>
      ${m?.on ? `<tr><td><b>NIFTYBEES</b><small>${esc(beesSub)}</small></td><td>${units(m.qty)}</td><td>${num(m.price)}</td><td class="${tone(x.bees)}">${x.bees == null ? '—' : rs(x.bees)}</td></tr>` : ''}
      <tr><td><b>Options (${o.kinds})</b><small>${o.ce} CE + ${o.pe} PE legs · ${open ? (x.optNow ? 'priced now' : 'as saved') : 'booked'}</small></td><td>${units(o.qty)}<small>${o.lots} lots</small></td><td>—</td><td class="${tone(x.opt)}">${x.opt == null ? '—' : rs(x.opt)}</td></tr>
    </tbody></table>
    ${
      exp
        ? `<div class="pos-detail"><table class="legs"><thead><tr><th>Leg</th><th>Entry</th><th>${open ? 'Now / exit' : 'Exit'}</th><th>P&amp;L</th></tr></thead><tbody>${legs
            .map((l) => `<tr><td><span class="pill ${l.action === 'B' ? 'buy' : 'sell'}">${l.action}</span> ${l.lots}× ${l.strike} ${l.type}<small>${dayTxt(l.entryDay)}${l.exitDay ? ' → ' + dayTxt(l.exitDay) : l.open ? ' · open' : ''}</small></td><td>${num(l.entryPx)}</td><td>${l.now == null ? '—' : num(l.now)}</td><td class="${tone(l.pnl)}">${l.pnl == null ? '—' : rs(l.pnl)}</td></tr>`)
            .join('')}</tbody></table>
          <p class="muted small">Saved ${new Date(t.savedAt || t.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${t.summary?.spot ? ` · Nifty ${num(t.summary.spot, 0)}` : ''}</p></div>`
        : `<button class="link-btn" data-act="toggle">Show the ${legs.length} legs</button>`
    }
  </article>`;
}
function listTab(acct) {
  const all = data.trades.filter((t) => T.accountOf(t) === acct);
  if (!all.length) return `<div class="empty"><p>No ${acct} trades saved.</p><p class="muted">Save a trade in the portal's Builder and push the repository.</p></div>`;
  const xs = all.map((t) => ({ t, x: T.splitOf(t, opts()), open: t.summary?.open > 0 }));
  const sum = (f) => xs.reduce((a, r) => a + (f(r) || 0), 0);
  const open = xs.filter((r) => r.open);
  const closed = xs.filter((r) => !r.open);
  return `<div class="stats">${stat('Total P&amp;L', rl(sum((r) => r.x.overall), true), tone(sum((r) => r.x.overall)))}${stat('Options', rl(sum((r) => r.x.opt), true), tone(sum((r) => r.x.opt)))}${stat('NIFTYBEES', rl(sum((r) => r.x.bees), true), tone(sum((r) => r.x.bees)))}${stat('Open / closed', `${open.length} / ${closed.length}`)}</div>
    ${open.length ? `<h3 class="section-title">Open</h3>${open.map((r) => tradeCard(r.t)).join('')}` : ''}
    ${closed.length ? `<h3 class="section-title">Closed</h3>${closed.map((r) => tradeCard(r.t)).join('')}` : ''}`;
}

// ---------- Ledger ----------
function ledgerTab() {
  const sc = SCOPES[store.get('ledgerScope')] ? store.get('ledgerScope') : data.ledger.scope || 'live';
  const B = T.buildLedger(data.trades, data.ledger, { ...opts(), scope: sc });
  const s = B.s;
  const invested = s.cost + s.margin;
  const held = B.lots.filter((l) => !l.sold);
  const lotRow = (l) => {
    const name = l.tr ? l.tr.name : l.entry?.desc || 'Trade made elsewhere';
    if (l.pending) return `<li class="tr-li pend"><div><b>Reinvested</b><small>${dayTxt(l.date)} · waiting for the NIFTYBEES price of the day</small></div></li>`;
    return `<li class="tr-li"><div><b>${l.how === 'bought' ? esc(name) : 'Reinvested profit'}</b><small>${dayTxt(l.date)} · ${units(l.qty)} at ₹${num(l.price)}${l.how === 'reinvest' ? ` · from ${esc(name)}` : ''}</small></div>
      <div class="r"><b>${rl(l.amt)}</b><small class="${tone(l.pnl)}">${l.pnl == null ? '—' : rs(l.pnl)} ${l.sold ? `sold ${dayTxt(l.sold.date)}` : 'held'}</small></div></li>`;
  };
  const optRows = B.trades
    .slice()
    .sort((a, b) => (b.opened || '').localeCompare(a.opened || ''))
    .map((tr) => {
      const re = B.events.find((x) => x.kind === 'reinvest' && x.from.tr === tr);
      return `<li class="tr-li"><div><b>${esc(tr.name)}</b><small>${dayTxt(tr.opened)} · Options (${T.optLegs(tr).kinds}) · ${esc(tr.strategy)}${tr.open ? ' · open' : ` · closed ${dayTxt(tr.closedOn)}`}${re?.buy ? ` · → ${units(re.buy.qty)} NIFTYBEES` : ''}</small></div>
        <div class="r"><b>${rl(tr.margin)}</b><small class="${tone(tr.opt)}">${tr.opt == null ? '—' : rs(tr.opt)} ${tr.open ? 'open' : 'booked'}</small></div></li>`;
    })
    .join('');
  const cash = B.events.filter((e) => ['capital', 'deposit', 'withdrawal', 'other'].includes(e.kind));
  return `<div class="seg" id="trScope">${Object.entries(SCOPES)
    .map(([k, n]) => `<button data-scope="${k}" class="${k === sc ? 'on' : ''}">${n}</button>`)
    .join('')}</div>
    <div class="stats">
      ${stat('NIFTYBEES (cost of units held)', rl(s.cost))}${stat('Units held', `${units(s.units)}${s.units > 0 ? ` · avg ₹${num(s.cost / s.units)}` : ''}`)}
      ${stat('Value now', B.value == null ? 'no price now' : rl(B.value))}${stat('NIFTYBEES P&amp;L', rs(s.beesReal + (B.beesUnreal || 0)), tone(s.beesReal + (B.beesUnreal || 0)))}
      ${stat('Options margin (open)', rl(s.margin))}${stat('Options booked / open', `${rs(s.optBooked)} / ${rs(B.optOpen)}`, tone(s.optBooked + B.optOpen))}
      ${stat('Invested of capital', `${rl(invested)} of ${rl(B.capital)}`)}${stat('Cash · Total P&amp;L', `${rl(s.cash)} · <span class="${tone(B.total)}">${rs(B.total)}</span>`)}
    </div>
    <section class="card"><div class="card-head"><h2><i class="dot bees"></i>NIFTYBEES</h2><span class="muted small">${units(s.units)} held · ${rl(held.reduce((a, l) => a + l.amt, 0))}</span></div>
      <ul class="tr-list">${B.lots.slice().reverse().map(lotRow).join('') || '<li class="muted">No NIFTYBEES bought yet.</li>'}</ul></section>
    <section class="card"><div class="card-head"><h2><i class="dot opt"></i>Options (CE + PE)</h2><span class="muted small">margin in open trades ${rl(s.margin)}</span></div>
      <ul class="tr-list">${optRows || '<li class="muted">No trades.</li>'}</ul></section>
    <section class="card"><div class="card-head"><h2>Capital and cash</h2><span class="muted small">cash now ${rl(s.cash)}</span></div>
      <ul class="tr-list">${cash
        .slice()
        .reverse()
        .map((e) => `<li class="tr-li"><div><b>${esc(e.title)}</b><small>${dayTxt(e.date)}</small></div><div class="r"><b class="${tone(e.kind === 'other' ? e.other : e.cash)}">${rs(e.kind === 'other' ? e.other : e.cash)}</b><small>cash after ${rl(e.cashAfter)}</small></div></li>`)
        .join('') || '<li class="muted">No capital set (set it on the portal Ledger tab).</li>'}</ul></section>
    <p class="muted small">Same figures as the portal's Ledger tab (its capital, margins, charges and edits). Edits are made on the portal.</p>`;
}

// ---------- Portfolio P&L (the Live trades) ----------
function portfolioTab() {
  const B = T.buildLedger(data.trades, data.ledger, { ...opts(), scope: 'live' });
  if (!B.trades.length && !B.L.entries.length) return `<div class="empty"><p>No Live trades yet.</p></div>`;
  const M = T.portfolio(B);
  const S = T.growth(M, closes);
  const rg = range();
  const from = RANGES[rg] ? T.addDays(B.today, -RANGES[rg]) : null;
  const pts = S.pts.filter((p) => !from || p.d >= from);
  const Bk = T.buckets(S.pts, RANGES[rg], B.today);
  const bars = Bk.list.map((b) => ({ ...b, label: Bk.by === 'day' ? dayShort(b.k) : Bk.by === 'month' ? monTxt(b.k + '-01') : 'wk ' + dayShort(b.k) }));
  const best = bars.reduce((a, b) => (a && a.v >= b.v ? a : b), null);
  const reAmt = M.reLots.reduce((a, l) => a + l.amt, 0);
  const beesNow = M.beesVal ?? M.s.cost;
  const optNow = M.s.margin + B.optOpen;
  const span = Math.max(1, Math.round((Date.parse(B.today) - Date.parse(M.first)) / 86400_000));
  const ins = [`Portfolio ${M.pnl >= 0 ? 'up' : 'down'} <b class="${tone(M.pnl)}">${pct(M.ret)}</b> (${rs(M.pnl)}) on ${rl(M.s.inv)} since ${dayTxt(M.first)} (${span} days).`];
  if (M.beesPnl || M.optPnl) ins.push(`NIFTYBEES ${rs(M.beesPnl)} · options (CE + PE) ${rs(M.optPnl)}: <b>${M.beesPnl >= M.optPnl ? 'NIFTYBEES' : 'Options'}</b> carried the result.`);
  if (M.perTrade.length > 1) {
    const b = M.perTrade.reduce((a, x) => (x.total > a.total ? x : a));
    const w = M.perTrade.reduce((a, x) => (x.total < a.total ? x : a));
    ins.push(`Best trade <b>${esc(b.name)}</b> ${rs(b.total)}; weakest <b>${esc(w.name)}</b> ${rs(w.total)}.`);
  }
  if (M.openTr.length) ins.push(`${M.openTr.length} open: options P&amp;L now ${rs(B.optOpen)} on ${rl(M.s.margin)} margin${live() ? '' : ' (as saved — log in to Upstox for prices now)'}.`);
  if (M.reLots.length) ins.push(`${rl(reAmt)} of options profit went back into NIFTYBEES.`);
  else if (B.L.reinvest) ins.push(`No options profit to reinvest yet: options booked ${rs(B.s.optBooked)}.`);
  if (S.filled) ins.push(`<span class="muted">NIFTYBEES closes missing for ${S.filled} day(s) of the curve: the last price known is carried${live() ? '' : ' (log in to Upstox for daily closes)'}.</span>`);
  const maxT = Math.max(1, ...M.perTrade.map((x) => Math.abs(x.bees) + Math.abs(x.opt)));
  const row = (r) => `<li class="tr-row ${r.last ? 'last' : ''}${r.pending ? ' pend' : ''}"><div class="tr-r1"><span class="tr-tag ${r.tag}">${esc(r.action)}</span><b>${esc(r.inst)}</b><span class="muted small">${dayTxt(r.date)}</span></div>
      ${r.sub ? `<div class="muted small">${esc(r.sub)}</div>` : ''}
      <div class="tr-r2">${r.amount != null ? `<span>Amount <b>${rs(r.amount, false)}</b></span>` : ''}${r.qty != null ? `<span>Qty <b>${units(r.qty)}</b>${r.qtySub ? ` (${r.qtySub})` : ''}</span>` : ''}${r.rate > 0 ? `<span>Price <b>${num(r.rate)}</b></span>` : ''}${r.value != null ? `<span>Value <b>${rs(r.value, false)}</b>${r.valueSub ? ` (${r.valueSub})` : ''}</span>` : ''}${r.real != null ? `<span>${r.realSub || 'Realised'} <b class="${tone(r.real)}">${rs(r.real)}</b></span>` : ''}${r.total != null ? `<span>Total profit <b class="${tone(r.total)}">${rs(r.total)}</b></span>` : ''}</div></li>`;
  return `
    <p class="muted small">Live trades: ${B.trades.length} (${B.trades.length - M.openTr.length} closed, ${M.openTr.length} open) · ${monTxt(M.first)} – ${monTxt(B.today)}${M.pxNow ? ` · NIFTYBEES ₹${num(M.pxNow)} now` : ''}</p>
    <h3 class="section-title tr-num">1. Portfolio summary</h3>
    <div class="stats">
      ${stat('Total investment', rl(M.s.inv))}${stat('Current value', rl(M.value))}
      ${stat('Total P&amp;L', `${rl(M.pnl, true)} <small>${pct(M.ret)}</small>`, tone(M.pnl))}${stat('Profit reinvested', reAmt > 0 ? `${rl(reAmt)} → ${units(M.reLots.reduce((a, l) => a + l.qty, 0))} units` : '₹0')}
    </div>
    <section class="card"><div class="card-head"><h2>Portfolio growth</h2></div><div class="chart-box" id="trGrowth"></div><div class="chart-box" id="trProfit"></div></section>
    <section class="card"><h2>Asset allocation</h2>${donut(
      [
        { label: 'NIFTYBEES', v: beesNow, c: 'bees' },
        { label: 'Options (CE + PE)', v: optNow, c: 'opt' },
        { label: 'Cash', v: M.s.cash, c: 'cash' },
      ],
      rl(M.value),
      'total value',
    )}</section>
    <section class="card"><h2>Profit contribution</h2>${hbars([
      { label: 'NIFTYBEES', v: M.beesPnl, c: 'bees' },
      { label: 'Options (CE + PE)', v: M.optPnl, c: 'opt' },
      ...(B.s.other ? [{ label: 'Other entries', v: B.s.other, c: 'cash' }] : []),
      { label: 'Total', v: M.beesPnl + M.optPnl + B.s.other, c: 'tot' },
    ])}<p class="muted small">NIFTYBEES: sold + held at the price now · options: booked ${rs(B.s.optBooked)} + open ${rs(B.optOpen)}</p></section>
    <div class="notice ${M.pnl >= 0 ? 'good' : 'bad'}">${M.pnl >= 0 ? '✔' : '✖'} Total P&amp;L (NIFTYBEES + options): <b>${rs(M.pnl)}</b> (${pct(M.ret) || '—'} on ${rl(M.s.inv)})</div>
    <div class="card-head"><h3 class="section-title tr-num">2. Detailed ledger</h3><button class="btn small" data-act="csv">Export CSV</button></div>
    <ul class="tr-rows">${M.rows.map(row).join('')}</ul>
    <div class="stats three">${stat('Investment', rl(M.s.inv))}${stat('Current value', rl(M.value))}${stat('Total profit', rl(M.pnl, true), tone(M.pnl))}</div>
    <div class="card-head"><h3 class="section-title tr-num">3. Performance analytics</h3></div>
    <div class="seg" id="trRange">${Object.keys(RANGES)
      .map((k) => `<button data-range="${k}" class="${k === rg ? 'on' : ''}">${k}</button>`)
      .join('')}</div>
    <section class="card"><div class="card-head"><h2>Profit / loss by ${Bk.by}</h2>${best ? `<span class="muted small">best ${esc(best.label)} <b class="${tone(best.v)}">${rs(best.v)}</b></span>` : ''}</div>${vbars(bars)}</section>
    <section class="card"><div class="card-head"><h2>P&amp;L by trade</h2><span class="tr-legend"><i class="bees"></i>NIFTYBEES <i class="opt"></i>Options</span></div>
      <ul class="tr-list">${M.perTrade
        .map((x) => `<li class="tr-pt"><div class="tr-r1"><b>${esc(x.name)}</b>${x.open ? '<span class="tr-tag hold">open</span>' : ''}<b class="${tone(x.total)} r">${rs(x.total)}</b></div>
          <div class="tr-stack"><span class="bees" style="width:${(Math.abs(x.bees) / maxT) * 100}%" title="NIFTYBEES ${rs(x.bees)}"></span><span class="opt ${x.opt < 0 ? 'neg' : ''}" style="width:${(Math.abs(x.opt) / maxT) * 100}%"></span></div>
          <div class="muted small">NIFTYBEES <b class="${tone(x.bees)}">${rs(x.bees)}</b> · options <b class="${tone(x.opt)}">${rs(x.opt)}</b></div></li>`)
        .join('')}</ul></section>
    <section class="card tr-ins"><h2>💡 Key insights</h2><ul>${ins.map((x) => `<li>${x}</li>`).join('')}</ul></section>
    <p class="muted small">Open options are carried at their margin until today, when their P&amp;L now is added. A trade's CE and PE legs are one options item.</p>
    ${draw.after(() => {
      const xs = pts.map((p) => Date.parse(p.d));
      const fx = (x) => dayShort(new Date(x + 5.5 * 3600_000).toISOString().slice(0, 10));
      lineChart(root.querySelector('#trGrowth'), {
        series: [
          { pts: pts.map((p, i) => [xs[i], p.value]), cls: 's-tot', label: 'Portfolio value' },
          { pts: pts.map((p, i) => [xs[i], p.inv]), cls: 's-inv', label: 'Investment' },
        ],
        height: 190,
        xFmt: fx,
        yFmt: (y) => inr(y),
        legend: 'trGrowth',
      });
      lineChart(root.querySelector('#trProfit'), { series: [{ pts: pts.map((p, i) => [xs[i], p.profit]), cls: M.pnl >= 0 ? 's-up' : 's-down', label: 'Profit' }], height: 140, zero: true, area: true, xFmt: fx, yFmt: (y) => inr(y) });
    })}`;
}

function exportCsv() {
  const B = T.buildLedger(data.trades, data.ledger, { ...opts(), scope: 'live' });
  const M = T.portfolio(B);
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const n = (v, d = 0) => (v == null || !Number.isFinite(v) ? '' : (+v).toFixed(d));
  const lines = [['Date', 'Action', 'Instrument', 'Detail', 'Amount (Rs)', 'Units / Qty', 'Rate / Price', 'Value (Rs)', 'Realised P&L (Rs)', 'Total profit (Rs)'].join(',')];
  for (const r of M.rows) lines.push([r.date, r.action, r.inst, r.sub || '', n(r.amount), n(r.qty), n(r.rate, 2), n(r.value), n(r.real), n(r.total)].map(q).join(','));
  lines.push('', ['Total investment', n(M.s.inv)].join(','), ['Current value', n(M.value)].join(','), ['Total profit', n(M.pnl)].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `portfolio-pnl-live-${B.today}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

// ---------- drawing ----------
let afters = [];
function draw() {
  if (!root) return;
  const el = root.querySelector('#trBody');
  const t = tab();
  root.querySelectorAll('#trTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  const head = data
    ? `<p class="muted small tr-src">${esc(data.from)} · read ${new Date(data.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${data.stale ? ` · <span class="down">offline copy (${esc(data.error?.message || 'no connection')})</span>` : ''} · ${live() ? (px.at ? 'prices now from Upstox' : 'pricing…') : 'figures as saved (log in to Upstox for prices now)'} <button class="link-btn" data-act="reload">Reload trades</button></p>`
    : '';
  if (!data) {
    el.innerHTML = err ? `<div class="card error"><p>Could not read the trades: ${esc(err.message)}</p><p class="muted small">They are read from GitHub (${esc(T.repoOf())}, bt-data/). Check the connection, or the repository in Settings.</p><button class="btn" data-act="reload">Try again</button></div>` : '<div class="card skeleton" style="height:160px"></div>';
    return;
  }
  afters = [];
  el.innerHTML = head + (t === 'live' ? listTab('live') : t === 'paper' ? listTab('paper') : t === 'ledger' ? ledgerTab() : portfolioTab());
  for (const f of afters) f();
}
draw.after = (f) => (afters.push(f), '');

async function loadTrades(force) {
  if (loading || (!force && data && Date.now() - lastLoad < 120_000)) return;
  loading = true;
  try {
    data = await T.loadData();
    err = null;
  } catch (e) {
    err = e;
    data ||= T.savedData();
  } finally {
    loading = false;
    lastLoad = Date.now();
  }
}
// prices now: Nifty and NIFTYBEES, the open legs' option chains, NIFTYBEES daily closes for the growth curve
async function price(ctx) {
  if (!live() || !data) return;
  const q = await ctx.market.quotes();
  ctx.report(q);
  const prices = new Map();
  const open = data.trades.filter((t) => t.summary?.open > 0);
  const exps = [...new Set(open.flatMap((t) => (t.snap?.legs || []).filter((l) => l.open).map((l) => l.expiry)))];
  await Promise.all(
    exps.map(async (e) => {
      try {
        const c = (await ctx.market.chain(e)).data;
        for (const r of c.rows) {
          if (r.ce?.ltp != null) prices.set(`${e}|${r.strike}|CE`, r.ce.ltp);
          if (r.pe?.ltp != null) prices.set(`${e}|${r.strike}|PE`, r.pe.ltp);
        }
      } catch {
        // expired or no data: as saved
      }
    }),
  );
  px = { prices, beesPx: q.data[BEES]?.ltp || null, nifty: q.data[NIFTY]?.ltp || null, at: Date.now() };
  const first = data.trades.flatMap((t) => (t.snap?.legs || []).map((l) => l.entryDay)).filter(Boolean).sort()[0];
  const key = `${first}|${T.todayIST()}`;
  if (first && key !== closesKey) {
    try {
      const c = (await ctx.market.daily(BEES, T.addDays(first, -7), T.todayIST())).data;
      closes = {};
      for (const k of c) closes[new Date(k.t + 5.5 * 3600_000).toISOString().slice(0, 10)] = k.c;
      closesKey = key;
    } catch {
      // no daily candles: the curve uses the trades' prices
    }
  }
}

export default {
  id: 'trades',
  title: 'Trades',
  mount(el) {
    root = el;
    el.innerHTML = `<div class="seg tr-tabs" id="trTabs">${Object.entries(TABS)
      .map(([k, n]) => `<button data-tab="${k}">${n}</button>`)
      .join('')}</div><div id="trBody"></div>`;
    data ||= T.savedData();
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tab) {
        store.set('tradesTab', b.dataset.tab);
        draw();
        window.scrollTo(0, 0);
      } else if (b.dataset.scope) {
        store.set('ledgerScope', b.dataset.scope);
        draw();
      } else if (b.dataset.range) {
        store.set('tradesRange', b.dataset.range);
        draw();
      } else if (b.dataset.act === 'toggle') {
        const id = b.closest('[data-id]').dataset.id;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        draw();
      } else if (b.dataset.act === 'csv') exportCsv();
      else if (b.dataset.act === 'reload') {
        b.disabled = true;
        await loadTrades(true);
        draw();
        toast(err ? 'Could not read the trades: ' + err.message : `Trades read from ${data.from}`);
      }
    });
    draw();
  },
  async refresh(ctx) {
    await loadTrades(false);
    try {
      await price(ctx);
    } catch (e) {
      ctx.report({ error: e });
    }
    if (root?.isConnected) draw();
  },
};
