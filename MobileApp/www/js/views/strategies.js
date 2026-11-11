// Strategies: the desktop portal's collars (views/collar.js: New trade and Live trade) and a Builder for any legs picked
// on the Chain screen. Trades are saved on the phone (Positions).
import { BEES } from '../market.js';
import { legFromChain, curves, analyse, netGreeks, tradeCosts, netPremium, beesUnits } from '../strategy.js';
import * as collar from './collar.js';
import { lineChart } from '../charts.js';
import { num, inr, esc, tone, toast, sheet, confirmSheet } from '../ui.js';
import { fmtDate, daysTo } from '../time.js';
import * as store from '../store.js';
import * as positions from '../positions.js';

let root;
let ctxRef;
let data = null; // { contracts, quotes, chain, lot } of the last refresh

const builderState = () => ({ expiry: '', legs: [], bees: false, ...(store.get('builder') || {}) });
const tab = () => store.get('strategiesTab') || 'collars';

// Called from the Chain screen. Returns false when the user keeps the Builder's other expiry.
export async function addLeg(chain, type, strike, side, lots) {
  const b = builderState();
  if (b.legs.length && b.expiry && b.expiry !== chain.expiry) {
    const ok = await confirmSheet(`The Builder holds legs of ${fmtDate(b.expiry)}. Start again with ${fmtDate(chain.expiry)}?`, 'Start again');
    if (!ok) return false;
    b.legs = [];
  }
  b.expiry = chain.expiry;
  const same = b.legs.find((l) => l.type === type && l.strike === strike && l.side === side);
  if (same) same.lots += lots;
  else b.legs.push(legFromChain(chain, type, strike, side, lots));
  store.set('builder', b);
  store.set('strategiesTab', 'builder');
  return true;
}

// ---------- shared pieces ----------
function payoffBlock(el, { legs, lot, spot, expiry, bees, pct }) {
  const c = curves(legs, { spot, lot, expiry, bees, pct });
  const series = [{ pts: c.atExp, cls: 's-exp', label: 'Expiry' }];
  series.push({ pts: c.today, cls: 's-now', label: 'Today' });
  if (bees) series.push({ pts: c.opts, cls: 's-opt', label: 'Options' });
  lineChart(el, { series, height: 210, zero: true, area: true, xFmt: (x) => num(x, 0), yFmt: (y) => inr(y, { lakh: Math.abs(y) >= 1e5 }), marks: [{ x: spot, label: 'now ' + num(spot, 0), cls: 'spot' }] });
  return analyse(c.atExp);
}

function statsBlock(a, g, extra = []) {
  const rows = [
    ['Max profit', a.profitOpen ? 'beyond range' : inr(a.maxProfit, { sign: true }), 'up'],
    ['Max loss', a.lossOpen ? `${inr(a.maxLoss, { sign: true })} +` : inr(a.maxLoss, { sign: true }), 'down'],
    ['Breakeven', a.breakevens.length ? a.breakevens.map((x) => num(x, 0)).join(' · ') : 'none'],
    ['Delta', num(g.delta, 1)],
    ['Theta / day', inr(g.theta, { sign: true, lakh: false })],
    ['Vega / 1 vol', inr(g.vega, { sign: true, lakh: false })],
    ...extra,
  ];
  return `<div class="stats">${rows.map(([k, v, t]) => `<div class="stat"><span>${k}</span><b class="${t || ''}">${v}</b></div>`).join('')}</div>`;
}

function saveSheet(defName, build) {
  sheet(
    `<h3>Save as paper position</h3><label class="field"><span>Name</span><input id="svName" value="${esc(defName)}" maxlength="60"></label>
     <p class="muted small">Entry at each option's LTP. Charges and ${store.settings().slipPct}% slippage are counted on entry and on exit.</p>
     <div class="row gap"><button class="btn" data-close>Cancel</button><button class="btn primary" id="svOk">Save</button></div>`,
    (el, close) => {
      el.querySelector('#svOk').onclick = () => {
        const p = positions.add({ ...build(), name: el.querySelector('#svName').value.trim() || defName });
        close();
        toast(`Saved “${p.name}” to Positions`);
      };
    },
  );
}

// ---------- builder ----------
function renderBuilder() {
  const el = root.querySelector('#stBody');
  const b = builderState();
  if (!b.legs.length || !data.chain) {
    el.innerHTML = `<div class="empty"><p>No legs yet.</p><p class="muted">Tap a call or put price on the Chain screen and choose Buy or Sell.</p><button class="btn primary" data-go="chain">Open the chain</button></div>`;
    el.querySelector('[data-go]').onclick = () => ctxRef.nav('chain');
    return;
  }
  const { chain, quotes, lot } = data;
  const legs = b.legs.map((l) => ({ ...l, ...legFromChain(chain, l.type, l.strike, l.side, l.lots) }));
  const spot = chain.spot;
  const beesPx = quotes[BEES]?.ltp;
  const oneLot = beesUnits(spot, beesPx, lot, 1);
  const units = b.bees ? oneLot : 0;
  const bees = units > 0 ? { units, entry: beesPx, spot0: spot } : null;
  const s = store.settings();
  const costs = tradeCosts(legs, lot, s);
  const prem = netPremium(legs, lot);
  el.innerHTML = `
    <section class="card"><div class="card-head"><h2>Legs</h2><span class="muted small">${fmtDate(chain.expiry)} · ${daysTo(chain.expiry)} d · Nifty ${num(spot, 2)}</span></div>
      <ul class="leg-list">${legs
        .map(
          (l, i) => `<li data-i="${i}">
            <button class="pill ${l.side > 0 ? 'buy' : 'sell'}" data-act="flip" aria-label="Switch buy/sell">${l.side > 0 ? 'BUY' : 'SELL'}</button>
            <span class="leg-name">${l.strike} ${l.type}<small>${num(l.entry)} · IV ${num(l.iv * 100, 1)}%</small></span>
            <span class="stepper mini"><button data-act="dec" aria-label="Fewer lots">−</button><b>${l.lots}</b><button data-act="inc" aria-label="More lots">+</button></span>
            <button class="icon-btn" data-act="del" aria-label="Remove leg">✕</button></li>`,
        )
        .join('')}</ul>
      <label class="check"><input type="checkbox" id="bBees" ${b.bees ? 'checked' : ''}> Hold NIFTYBEES worth one lot (${oneLot ? num(oneLot, 0) + ' units' : '—'})</label>
      <div class="stats">
        <div class="stat"><span>Net premium</span><b class="${tone(prem)}">${inr(prem, { sign: true, lakh: false })}</b></div>
        <div class="stat"><span>Charges + slippage</span><b>${inr(costs.total, { lakh: false })}</b></div>
      </div>
    </section>
    <section class="card"><div class="card-head"><h2>Payoff</h2><span class="legend"><i class="s-exp"></i>expiry <i class="s-now"></i>today</span></div>
      <div id="bChart" class="chart-box"></div><div id="bStats"></div></section>
    <div class="row gap"><button class="btn" id="bClear">Clear</button><button class="btn primary grow" id="bSave">Save as paper position</button></div>`;
  const a = payoffBlock(el.querySelector('#bChart'), { legs, lot, spot, expiry: chain.expiry, bees, pct: 0.15 });
  el.querySelector('#bStats').innerHTML = statsBlock(a, netGreeks(legs, spot, chain.expiry, lot, Date.now(), bees)) + `<p class="muted small">Over Nifty ±15 %, priced at LTP; today's curve is Black-Scholes at each leg's IV.</p>`;

  el.querySelector('.leg-list').onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const i = +e.target.closest('[data-i]')?.dataset.i;
    if (!act || Number.isNaN(i)) return;
    const st = builderState();
    const l = st.legs[i];
    if (act === 'flip') l.side = -l.side;
    if (act === 'inc') l.lots = Math.min(50, l.lots + 1);
    if (act === 'dec') l.lots = Math.max(1, l.lots - 1);
    if (act === 'del') st.legs.splice(i, 1);
    store.set('builder', st);
    renderBuilder();
  };
  el.querySelector('#bBees').onchange = (e) => {
    store.set('builder', { ...builderState(), bees: e.target.checked });
    renderBuilder();
  };
  el.querySelector('#bClear').onclick = async () => {
    if (await confirmSheet('Remove every leg from the Builder?', 'Clear', true)) {
      store.set('builder', { expiry: '', legs: [], bees: false });
      renderBuilder();
    }
  };
  el.querySelector('#bSave').onclick = () =>
    saveSheet(`${legs.map((l) => `${l.side > 0 ? '+' : '−'}${l.strike}${l.type[0]}`).join(' ')} ${fmtDate(chain.expiry)}`, () => ({
      kind: 'custom',
      expiry: chain.expiry,
      lotSize: lot,
      legs: legs.map(({ type, strike, side, lots, entry, iv, key }) => ({ type, strike, side, lots, entry, iv, key })),
      bees,
      spot0: spot,
      costsIn: costs.total + (bees ? units * beesPx * 0.0005 : 0),
    }));
}

function render() {
  if (!data) return;
  if (tab() === 'collars') collar.render(root.querySelector('#stBody'), ctxRef, data);
  else renderBuilder();
}

export default {
  id: 'strategies',
  title: 'Strategies',
  mount(el, ctx) {
    root = el;
    ctxRef = ctx;
    el.innerHTML = `<div class="seg" id="stTabs"><button data-t="collars">Collars</button><button data-t="builder">Builder</button></div><div id="stBody"><div class="card skeleton" style="height:300px"></div></div>`;
    const mark = () => el.querySelectorAll('#stTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab()));
    mark();
    el.querySelector('#stTabs').onclick = (e) => {
      const t = e.target.closest('[data-t]')?.dataset.t;
      if (!t) return;
      store.set('strategiesTab', t);
      mark();
      ctx.refreshNow();
    };
  },
  async refresh(ctx) {
    try {
      const [c, q] = await Promise.all([ctx.market.contracts(), ctx.market.quotes()]);
      const contracts = c.data;
      let expiry;
      if (tab() === 'collars') expiry = collar.needExpiry(contracts);
      else expiry = builderState().expiry || contracts.expiries[0];
      if (!contracts.expiries.includes(expiry)) expiry = contracts.expiries[0];
      const ch = await ctx.market.chain(expiry);
      ctx.report(ch);
      data = { contracts, quotes: q.data, chain: ch.data, at: ch.at, lot: ctx.market.lotSize(contracts.lotSize) };
      // keep the user's typing: don't redraw the collar form while an input has focus
      if (root.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
      render();
    } catch (e) {
      ctx.report({ error: e });
      root.querySelector('#stBody').innerHTML = `<div class="card error">${esc(e.message)}</div>`;
    }
  },
};
