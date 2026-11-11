// Positions: paper trades saved on the phone, marked to market on every refresh.
import { BEES, NIFTY } from '../market.js';
import { valuePosition, curves } from '../strategy.js';
import { lineChart } from '../charts.js';
import { num, inr, esc, tone, sheet, confirmSheet, toast } from '../ui.js';
import { fmtDate, daysTo } from '../time.js';
import * as store from '../store.js';
import * as positions from '../positions.js';

let root;
let ctxRef;
const open = new Set(); // expanded cards
let lastVals = new Map(); // id -> { v, chain, spot, beesPx }

const KIND = { psc: 'Put spread collar', bpc: 'Bull put collar', custom: 'Builder' };

function card(p, info) {
  const closed = p.status === 'closed';
  const v = closed ? p.exit : info?.v;
  const net = v?.net;
  const exp = open.has(p.id);
  const sub = closed
    ? `Closed ${new Date(p.exit.at).toLocaleDateString('en-IN')}`
    : `${fmtDate(p.expiry)} · ${daysTo(p.expiry) >= 0 ? daysTo(p.expiry) + ' d left' : 'expired'}${v?.expired ? ' · expired: at intrinsic' : ''}`;
  return `<article class="card pos ${closed ? 'closed' : ''}" data-id="${p.id}">
    <button class="pos-head" data-act="toggle" aria-expanded="${exp}">
      <span class="pos-title"><b>${esc(p.name)}</b><small>${KIND[p.kind] || p.kind} · ${sub}</small></span>
      <span class="pos-pnl ${tone(net)}">${v ? inr(net, { sign: true }) : '…'}</span>
    </button>
    ${
      v
        ? `<div class="pos-break"><span>Options <b class="${tone(v.options)}">${inr(v.options, { sign: true })}</b></span>${p.bees ? `<span>NIFTYBEES <b class="${tone(v.bees)}">${inr(v.bees, { sign: true })}</b></span>` : ''}<span>Costs <b>${inr(-(v.costsIn + v.costsOut), { sign: true, lakh: false })}</b></span></div>`
        : ''
    }
    ${exp ? detail(p, info, v) : ''}
  </article>`;
}

function detail(p, info, v) {
  const marks = v?.marks || [];
  const rows = p.legs
    .map((l, i) => {
      const pnl = marks[i] != null ? l.side * l.lots * p.lotSize * (marks[i] - l.entry) : null;
      return `<tr><td><span class="pill ${l.side > 0 ? 'buy' : 'sell'}">${l.side > 0 ? 'B' : 'S'}</span> ${l.lots}× ${l.strike} ${l.type}</td><td>${num(l.entry)}</td><td>${num(marks[i])}</td><td class="${tone(pnl)}">${inr(pnl, { sign: true, lakh: false })}</td></tr>`;
    })
    .join('');
  const bees = p.bees
    ? `<tr><td>NIFTYBEES ${num(p.bees.units, 0)}</td><td>${num(p.bees.entry)}</td><td>${num(p.status === 'closed' ? p.exit.beesPx : info?.beesPx)}</td><td class="${tone(v?.bees)}">${inr(v?.bees, { sign: true, lakh: false })}</td></tr>`
    : '';
  const spotNow = p.status === 'closed' ? p.exit.spot : info?.spot;
  return `<div class="pos-detail">
    <p class="muted small">Entered ${new Date(p.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · Nifty ${num(p.spot0, 0)} → ${num(spotNow, 0)}</p>
    <table class="legs"><thead><tr><th>Leg</th><th>Entry</th><th>${p.status === 'closed' ? 'Exit' : 'Now'}</th><th>P&amp;L</th></tr></thead><tbody>${rows}${bees}</tbody></table>
    <div class="chart-box" data-chart="${p.id}"></div>
    <div class="row gap wrap">
      ${p.status === 'open' ? `<button class="btn primary" data-act="close">Close at market</button>` : ''}
      <button class="btn" data-act="rename">Rename</button>
      <button class="btn" data-act="builder">Open in Builder</button>
      <button class="btn danger" data-act="delete">Delete</button>
    </div></div>`;
}

function draw() {
  const all = positions.list();
  const openP = all.filter((p) => p.status === 'open');
  const closedP = all.filter((p) => p.status === 'closed');
  const total = openP.reduce((a, p) => a + (lastVals.get(p.id)?.v?.net || 0), 0);
  const realised = closedP.reduce((a, p) => a + (p.exit?.net || 0), 0);
  const el = root.querySelector('#psBody');
  if (!all.length) {
    el.innerHTML = `<div class="empty"><p>No paper positions yet.</p><p class="muted">Save one from Strategies (a collar or the Builder). Positions stay on this phone.</p><button class="btn primary" data-go>Open Strategies</button></div>`;
    el.querySelector('[data-go]').onclick = () => ctxRef.nav('strategies');
    return;
  }
  el.innerHTML = `
    <div class="stats"><div class="stat"><span>Open P&amp;L (after costs)</span><b class="${tone(total)}">${inr(total, { sign: true })}</b></div>
      <div class="stat"><span>Realised</span><b class="${tone(realised)}">${inr(realised, { sign: true })}</b></div></div>
    ${openP.map((p) => card(p, lastVals.get(p.id))).join('')}
    ${closedP.length ? `<h3 class="section-title">Closed</h3>${closedP.map((p) => card(p, null)).join('')}` : ''}`;
  for (const p of all) {
    if (!open.has(p.id)) continue;
    const box = el.querySelector(`[data-chart="${p.id}"]`);
    const info = lastVals.get(p.id);
    const spot = p.status === 'closed' ? p.exit.spot : info?.spot;
    if (!box || !(spot > 0)) continue;
    const c = curves(p.legs, { spot: p.spot0, lot: p.lotSize, expiry: p.expiry, bees: p.bees, pct: 0.1 });
    lineChart(box, {
      series: [
        { pts: c.atExp, cls: 's-exp', label: 'Expiry' },
        { pts: c.today, cls: 's-now', label: 'Today' },
      ],
      height: 180,
      zero: true,
      area: true,
      xFmt: (x) => num(x, 0),
      yFmt: (y) => inr(y, { lakh: Math.abs(y) >= 1e5 }),
      marks: [
        { x: p.spot0, label: 'entry', cls: 'entry' },
        { x: spot, label: 'now', cls: 'spot' },
      ],
    });
  }
}

async function act(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const p = positions.get(id);
  if (!p) return;
  const a = btn.dataset.act;
  if (a === 'toggle') {
    if (open.has(id)) open.delete(id);
    else open.add(id);
    draw();
  } else if (a === 'delete') {
    if (await confirmSheet(`Delete “${p.name}”? This cannot be undone (export a backup in Settings first if you want to keep it).`, 'Delete', true)) {
      positions.remove(id);
      lastVals.delete(id);
      draw();
    }
  } else if (a === 'rename') {
    sheet(`<h3>Rename</h3><label class="field"><span>Name</span><input id="rnName" value="${esc(p.name)}" maxlength="60"></label><div class="row gap"><button class="btn" data-close>Cancel</button><button class="btn primary" id="rnOk">Save</button></div>`, (el, close) => {
      el.querySelector('#rnOk').onclick = () => {
        positions.update(id, { name: el.querySelector('#rnName').value.trim() || p.name });
        close();
        draw();
      };
    });
  } else if (a === 'close') {
    const info = lastVals.get(id);
    if (!info?.v) return toast('No market price yet — try again after the next refresh');
    if (!(await confirmSheet(`Close “${p.name}” at the current prices (${inr(info.v.net, { sign: true })} after costs)?`, 'Close position'))) return;
    positions.update(id, { status: 'closed', exit: { ...info.v, at: Date.now(), spot: info.spot, beesPx: info.beesPx } });
    toast('Position closed');
    draw();
  } else if (a === 'builder') {
    store.set('builder', { expiry: p.expiry, legs: p.legs.map((l) => ({ ...l })), bees: Boolean(p.bees) });
    store.set('strategiesTab', 'builder');
    ctxRef.nav('strategies');
  }
}

export default {
  id: 'positions',
  title: 'Positions',
  mount(el, ctx) {
    root = el;
    ctxRef = ctx;
    el.innerHTML = `<div id="psBody"></div>`;
    el.addEventListener('click', act);
    draw();
  },
  async refresh(ctx) {
    const openP = positions.list().filter((p) => p.status === 'open');
    if (!openP.length) return draw();
    try {
      const q = await ctx.market.quotes();
      ctx.report(q);
      const spot = q.data[NIFTY]?.ltp;
      const beesPx = q.data[BEES]?.ltp;
      const s = store.settings();
      const expiries = [...new Set(openP.map((p) => p.expiry))];
      const chains = new Map();
      await Promise.all(
        expiries.map(async (e) => {
          if (daysTo(e) < 0) return;
          try {
            chains.set(e, (await ctx.market.chain(e)).data);
          } catch {
            // expired today after 15:30, or no data: valued at intrinsic below
          }
        }),
      );
      lastVals = new Map();
      for (const p of openP) {
        const chain = chains.get(p.expiry) || null;
        const S = chain?.spot || spot;
        const v = valuePosition(p, { chain, spot: S, beesPx, slipPct: s.slipPct, brokerage: s.brokerage });
        lastVals.set(p.id, { v, spot: S, beesPx });
      }
    } catch (e) {
      ctx.report({ error: e });
    }
    if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    draw();
  },
};
