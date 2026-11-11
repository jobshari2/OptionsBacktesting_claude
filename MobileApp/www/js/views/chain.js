// Chain: one expiry's strikes around ATM. Tap a price to put that option in the Builder.
import { around, atmStrike, pcr, maxPain, mark, rowAt } from '../analytics.js';
import { num, signed, compact, esc, sheet, toast } from '../ui.js';
import { fmtDate, daysTo } from '../time.js';
import * as store from '../store.js';
import { addLeg } from './strategies.js';

let root;
let expiry = null;
let scrolled = false;
let last = null; // last chain shown

function oiCell(o, max, cls) {
  const w = max > 0 ? Math.round((100 * (o?.oi || 0)) / max) : 0;
  const d = (o?.oi || 0) - (o?.prevOi || 0);
  return `<td class="oi ${cls}"><div class="bar" style="width:${w}%"></div><span>${compact(o?.oi || 0)}</span><small class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${compact(Math.abs(d))}</small></td>`;
}

function pxCell(o, type, strike) {
  const ch = o?.close ? ((o.ltp - o.close) / o.close) * 100 : null;
  return `<td class="px" data-pick="${type}" data-k="${strike}"><span>${num(o?.ltp, 2)}</span><small class="${ch >= 0 ? 'up' : 'down'}">${ch == null ? '' : signed(ch, 1) + '%'}</small></td>`;
}

function render(ctx, ch, stale) {
  const s = store.settings();
  const rows = around(ch.rows, ch.spot, s.strikes);
  const atm = atmStrike(ch.rows, ch.spot);
  const maxOi = Math.max(1, ...rows.flatMap((r) => [r.ce?.oi || 0, r.pe?.oi || 0]));
  root.querySelector('#chSum').innerHTML = `
    <div class="stat"><span>Spot</span><b>${num(ch.spot, 2)}</b></div>
    <div class="stat"><span>PCR</span><b>${num(pcr(ch.rows), 2)}</b></div>
    <div class="stat"><span>Max pain</span><b>${num(maxPain(ch.rows), 0)}</b></div>
    <div class="stat"><span>DTE</span><b>${daysTo(ch.expiry)} d</b></div>`;
  const body = rows
    .map((r) => {
      const cls = r.strike === atm ? 'atm' : '';
      const ceItm = r.strike < ch.spot ? 'itm' : '';
      const peItm = r.strike > ch.spot ? 'itm' : '';
      const iv = r.ce?.iv && r.pe?.iv ? (r.ce.iv + r.pe.iv) / 2 : r.ce?.iv || r.pe?.iv;
      return `<tr class="${cls}" data-strike="${r.strike}">
        ${oiCell(r.ce, maxOi, 'ce ' + ceItm)}${pxCell(r.ce, 'CE', r.strike).replace('class="px"', `class="px ${ceItm}"`)}
        <td class="strike"><b>${r.strike}</b><small>${iv ? num(iv, 1) + '%' : ''}</small></td>
        ${pxCell(r.pe, 'PE', r.strike).replace('class="px"', `class="px ${peItm}"`)}${oiCell(r.pe, maxOi, 'pe ' + peItm)}
      </tr>`;
    })
    .join('');
  const tb = root.querySelector('#chBody');
  tb.innerHTML = body;
  root.querySelector('#chStale').hidden = !stale;
  if (!scrolled) {
    scrolled = true;
    tb.querySelector('tr.atm')?.scrollIntoView({ block: 'center' });
  }
}

function pick(ctx, type, strike) {
  const r = rowAt(last.rows, strike);
  const o = type === 'CE' ? r?.ce : r?.pe;
  let lots = 1;
  sheet(
    `<h3>NIFTY ${strike} ${type}</h3>
     <p class="muted">${fmtDate(last.expiry)} · LTP ${num(o?.ltp)} · bid ${num(o?.bid)} / ask ${num(o?.ask)} · IV ${num(o?.iv, 1)}%</p>
     <div class="stepper"><button class="btn" data-dec>−</button><span data-lots>1 lot</span><button class="btn" data-inc>+</button></div>
     <div class="row gap"><button class="btn buy" data-side="1">Buy</button><button class="btn sell" data-side="-1">Sell</button></div>
     <p class="muted small">Adds the leg to Strategies › Builder at ${num(mark(o))} (bid/ask mid).</p>`,
    (el, close) => {
      const show = () => (el.querySelector('[data-lots]').textContent = `${lots} lot${lots > 1 ? 's' : ''}`);
      el.querySelector('[data-dec]').onclick = () => {
        lots = Math.max(1, lots - 1);
        show();
      };
      el.querySelector('[data-inc]').onclick = () => {
        lots = Math.min(50, lots + 1);
        show();
      };
      el.querySelectorAll('[data-side]').forEach((b) => {
        b.onclick = async () => {
          const ok = await addLeg(last, type, strike, +b.dataset.side, lots);
          close();
          if (ok) toast(`${+b.dataset.side > 0 ? 'Bought' : 'Sold'} ${lots} × ${strike} ${type} added to the Builder`);
        };
      });
    },
  );
}

export default {
  id: 'chain',
  title: 'Chain',
  mount(el, ctx) {
    root = el;
    scrolled = false;
    el.innerHTML = `
      <div class="toolbar"><select id="chExp" aria-label="Expiry"></select>
        <select id="chN" aria-label="Strikes shown">${[5, 10, 15, 20].map((n) => `<option value="${n}">±${n} strikes</option>`).join('')}</select></div>
      <div id="chSum" class="stats four"></div>
      <div id="chStale" class="notice small" hidden>Showing the last chain saved on this phone.</div>
      <div class="chain-wrap"><table class="chain">
        <thead><tr><th>OI</th><th>Call LTP</th><th>Strike<br><small>IV</small></th><th>Put LTP</th><th>OI</th></tr></thead>
        <tbody id="chBody"><tr><td colspan="5" class="muted center">Loading…</td></tr></tbody></table></div>`;
    el.querySelector('#chN').value = String(store.settings().strikes);
    el.querySelector('#chN').onchange = (e) => {
      store.saveSettings({ strikes: +e.target.value });
      if (last) render(ctx, last);
    };
    el.querySelector('#chExp').onchange = (e) => {
      expiry = e.target.value;
      scrolled = false;
      ctx.refreshNow();
    };
    el.querySelector('#chBody').addEventListener('click', (e) => {
      const td = e.target.closest('[data-pick]');
      if (td && last) pick(ctx, td.dataset.pick, +td.dataset.k);
    });
  },
  async refresh(ctx) {
    try {
      const c = await ctx.market.contracts();
      const exps = c.data.expiries;
      if (!expiry || !exps.includes(expiry)) expiry = exps[0];
      const sel = root.querySelector('#chExp');
      const opts = exps.map((e) => `<option value="${e}">${fmtDate(e)} · ${daysTo(e)} d</option>`).join('');
      if (sel.dataset.opts !== opts) {
        sel.innerHTML = opts;
        sel.dataset.opts = opts;
      }
      sel.value = expiry;
      const ch = await ctx.market.chain(expiry);
      ctx.report(ch);
      last = { ...ch.data, lotSize: ctx.market.lotSize(c.data.lotSize) };
      render(ctx, last, ch.stale);
    } catch (e) {
      ctx.report({ error: e });
      root.querySelector('#chBody').innerHTML = `<tr><td colspan="5" class="error">${esc(e.message)}</td></tr>`;
    }
  },
};
