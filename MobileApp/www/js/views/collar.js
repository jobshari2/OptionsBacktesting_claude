// Strategies › Collars: the desktop portal's Put spread collar (and Bull put collar) screens on the phone.
//   New trade:  the legs by the rules, every strike and price editable (prices are LTPs), Nifty and NIFTYBEES at the
//               entry editable; Save trade makes it a live trade.
//   Live trade: the portal's Live trade tab (public/mcclive-view.js): Nifty now against the entry, P&L by structure,
//               NIFTYBEES needed for the upside, the strikes on a line, NIFTYBEES entry, legs (tap to edit strike,
//               lots, entry or exit; add legs), payoff, the P&L for Nifty moves from the start, and closing the whole
//               trade at prices you type. Saved trades live on the phone (nom.positions); nothing is ordered.
import { BEES, NIFTY } from '../market.js';
import { collarExpiry, monthlyExpiries, rowAt } from '../analytics.js';
import { COLLARS, collarLegs, legFromChain, analyse, netGreeks, tradeCosts, netPremium, beesUnits, isClosed, valuePosition, ltpOf, NIFTY_STEP } from '../strategy.js';
import { priceLegs, pnlNow, moveGrid, beesCover, expiryAt, todayAt, COVER_PCTS } from '../live.js';
import { lineChart } from '../charts.js';
import { num, inr, esc, tone, toast, sheet, confirmSheet } from '../ui.js';
import { fmtDate, daysTo, marketOpen, fmtClock } from '../time.js';
import * as store from '../store.js';
import * as positions from '../positions.js';

const N = { CE: 'Sold call', PE: 'Put spread' };
const rs = (v) => inr(v, { sign: true, lakh: false });
const pctS = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), d)} %`);
const posNum = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};
const nonNeg = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) && x >= 0 ? x : null;
};

export const collarState = () => ({
  kind: 'psc',
  expiry: '',
  lots: 1,
  ceOff: 100,
  peOff: 100,
  gap: 100,
  edit: [null, null, null], // per leg: { strike, price } typed on New trade (null = by the rules / LTP)
  spotIn: null, // Nifty at the entry, typed (null = Nifty now)
  beesUnits: null, // NIFTYBEES units, typed (null = one lot's worth per lot)
  beesPx: null, // NIFTYBEES price, typed (null = its LTP)
  ...(store.get('collar') || {}),
});
const saveState = (patch) => store.set('collar', { ...collarState(), ...patch });
export const sub = () => store.get('collarSub') || 'new';
const liveKey = () => 'liveId.' + collarState().kind;

// The trades the Live trade tab can show for this collar: open ones first, then closed (newest first).
function trades() {
  const kind = collarState().kind;
  const all = positions.list().filter((p) => p.kind === kind);
  return [...all.filter((p) => p.status === 'open'), ...all.filter((p) => p.status !== 'open')];
}
export function liveTrade() {
  const list = trades();
  const id = store.get(liveKey());
  return list.find((p) => p.id === id) || list.find((p) => p.status === 'open') || null;
}

// Which expiry's chain the screen needs.
export function needExpiry(contracts) {
  if (sub() === 'live') {
    const t = liveTrade();
    if (t && t.status === 'open' && daysTo(t.expiry) >= 0) return t.expiry;
  }
  const st = collarState();
  return st.expiry && contracts.expiries.includes(st.expiry) ? st.expiry : collarExpiry(contracts.expiries);
}

// Entry costs of a trade: charges and slippage on the option legs at their entry, 0.05 % on NIFTYBEES.
export function entryCosts(legs, lot, bees) {
  const s = store.settings();
  return tradeCosts(legs, lot, s).total + (bees?.units > 0 ? bees.units * bees.entry * 0.0005 : 0);
}

let root;
let ctxRef;
let data;
let closing = false;
let closeVals = {}; // exit prices typed in the close panel, by leg index and 'bees'
let coverQ = null; // NIFTYBEES quantity tried on the cover slider (null = the units held)

export function render(el, ctx, d) {
  root = el;
  ctxRef = ctx;
  data = d;
  const st = collarState();
  // keep the grid's sideways scroll through the redraws
  const sx = root.querySelector('.grid-scroll')?.scrollLeft || 0;
  el.innerHTML = `
    <div class="seg small" id="colKind">${Object.values(COLLARS)
      .map((c) => `<button data-kind="${c.id}" class="${c.id === st.kind ? 'on' : ''}">${c.name}</button>`)
      .join('')}</div>
    <div class="seg small" id="colSub"><button data-sub="new" class="${sub() === 'new' ? 'on' : ''}">New trade</button><button data-sub="live" class="${sub() === 'live' ? 'on' : ''}">Live trade</button></div>
    <div id="colBody"></div>`;
  el.querySelector('#colKind').onclick = (e) => {
    const k = e.target.closest('[data-kind]')?.dataset.kind;
    if (k && k !== st.kind) {
      saveState({ kind: k });
      closing = false;
      ctx.refreshNow();
    }
  };
  el.querySelector('#colSub').onclick = (e) => {
    const s = e.target.closest('[data-sub]')?.dataset.sub;
    if (s && s !== sub()) {
      store.set('collarSub', s);
      closing = false;
      ctx.refreshNow();
    }
  };
  if (sub() === 'live') renderLive();
  else renderNew();
  const g = root.querySelector('.grid-scroll');
  if (g) g.scrollLeft = sx;
}

// ---------- New trade ----------
function newLegs(st, chain) {
  const base = collarLegs(st.kind, chain, st);
  return base.map((l, i) => {
    const e = st.edit?.[i];
    const strike = e?.strike > 0 ? e.strike : l.strike;
    const fresh = strike === l.strike ? l : legFromChain(chain, l.type, strike, l.side, l.lots);
    const px = e?.price > 0 ? e.price : fresh.entry;
    return { ...fresh, entry: px || 0, typed: e?.price > 0 };
  });
}

function renderNew() {
  const el = root.querySelector('#colBody');
  const st = collarState();
  const { contracts, quotes, chain, lot } = data;
  const months = monthlyExpiries(contracts.expiries);
  const auto = collarExpiry(contracts.expiries);
  const legs = newLegs(st, chain);
  const spotNow = chain.spot;
  const spot = st.spotIn > 0 ? st.spotIn : spotNow;
  const beesLtp = quotes[BEES]?.ltp;
  const beesPx = st.beesPx > 0 ? st.beesPx : beesLtp;
  const autoUnits = beesUnits(spot, beesPx, lot, st.lots);
  const units = st.beesUnits != null ? st.beesUnits : autoUnits;
  const bees = units > 0 && beesPx > 0 ? { units, entry: beesPx, spot0: spot } : null;
  const costs = entryCosts(legs, lot, bees);
  const prem = netPremium(legs, lot);
  const shape = COLLARS[st.kind];
  const missing = legs.some((l) => !(l.entry > 0));
  el.innerHTML = `
    <p class="muted small">${esc(shape.blurb)}</p>
    <div class="form-grid">
      <label class="field"><span>Expiry</span><select id="colExp"><option value="">Auto · ${auto ? fmtDate(auto) : '—'}</option>${contracts.expiries
        .map((e) => `<option value="${e}" ${e === st.expiry ? 'selected' : ''}>${fmtDate(e)}${months.includes(e) ? ' · monthly' : ''}</option>`)
        .join('')}</select></label>
      <label class="field"><span>Lots</span><input id="colLots" type="number" inputmode="numeric" min="1" max="20" value="${st.lots}"></label>
      <label class="field"><span>Call over ATM</span><input id="colCe" type="number" inputmode="numeric" step="50" value="${st.ceOff}"></label>
      <label class="field"><span>Put under ATM</span><input id="colPe" type="number" inputmode="numeric" step="50" value="${st.peOff}"></label>
      <label class="field"><span>Put spread width</span><input id="colGap" type="number" inputmode="numeric" step="50" min="50" value="${st.gap}"></label>
    </div>
    <section class="card">
      <div class="card-head"><h2>Legs</h2><span class="muted small">${fmtDate(chain.expiry)} · ${daysTo(chain.expiry)} d · Nifty ${num(spotNow, 2)}</span></div>
      <table class="legs edit"><thead><tr><th>Leg</th><th>Strike</th><th>LTP</th><th>Entry ₹</th></tr></thead><tbody>${legs
        .map(
          (l, i) => `<tr><td><span class="pill ${l.side > 0 ? 'buy' : 'sell'}">${l.side > 0 ? 'B' : 'S'}</span> ${l.lots}× ${l.type}</td>
          <td><input class="cell" data-strike="${i}" type="number" inputmode="numeric" step="${NIFTY_STEP}" value="${l.strike}" aria-label="Strike of leg ${i + 1}"></td>
          <td class="muted">${num(l.ltp)}</td>
          <td><input class="cell ${l.typed ? 'typed' : ''}" data-price="${i}" type="number" inputmode="decimal" step="0.05" min="0" value="${l.entry > 0 ? l.entry : ''}" placeholder="price" aria-label="Entry price of leg ${i + 1}"></td></tr>`,
        )
        .join('')}</tbody></table>
      <div class="row gap wrap"><button class="btn small" id="colLive">↺ Rules and LTPs</button><span class="muted small">Change a strike or a price; the strike box steps by 50.</span></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Entry</h2><span class="muted small">blank = live</span></div>
      <div class="form-grid three">
        <label class="field"><span>Nifty at entry</span><input id="colSpot" type="number" inputmode="decimal" step="0.05" value="${st.spotIn > 0 ? st.spotIn : ''}" placeholder="${num(spotNow, 2).replace(/,/g, '')}"></label>
        <label class="field"><span>NIFTYBEES units</span><input id="colBu" type="number" inputmode="numeric" min="0" step="1" value="${st.beesUnits != null ? st.beesUnits : ''}" placeholder="${autoUnits || ''}"></label>
        <label class="field"><span>NIFTYBEES ₹</span><input id="colBp" type="number" inputmode="decimal" min="0" step="0.01" value="${st.beesPx > 0 ? st.beesPx : ''}" placeholder="${beesLtp ? beesLtp.toFixed(2) : ''}"></label>
      </div>
      <div class="stats">
        <div class="stat"><span>Net premium</span><b class="${tone(prem)}">${rs(prem)} ${prem >= 0 ? 'credit' : 'debit'}</b></div>
        <div class="stat"><span>NIFTYBEES</span><b>${bees ? `${num(units, 0)} × ${num(beesPx)} = ${inr(units * beesPx)}` : '—'}</b></div>
        <div class="stat"><span>Entry costs</span><b>${inr(costs, { lakh: false })}</b></div>
        <div class="stat"><span>Lot size</span><b>${lot}</b></div>
      </div>
    </section>
    <section class="card"><div class="card-head"><h2>Payoff</h2><span class="muted small">tap a name to hide or show its line</span></div>
      <div id="colChart"></div><div id="colStats"></div></section>
    <button class="btn primary block" id="colSave" ${missing ? 'disabled' : ''}>${missing ? 'Type a price for every leg' : 'Save trade'}</button>`;

  if (!missing) {
    const priced = priceLegs(legs, chain, spot, chain.expiry);
    const bz = bees ? { ...bees, now: bees.entry } : null;
    drawPayoff(el.querySelector('#colChart'), { legs: priced, lot, expiry: chain.expiry, S: spot, E: spot, bees: bz, key: 'pay-new', nowLabel: 'Entry' });
    const pts = payoffPts(priced, lot, chain.expiry, spot, bz, spot - spot * 0.1, spot + spot * 0.1);
    const a = analyse(pts.exp);
    const g = netGreeks(priced.map((l) => ({ ...l, iv: l.vol })), spot, chain.expiry, lot, Date.now(), bees);
    el.querySelector('#colStats').innerHTML =
      `<div class="stats">${[
        ['Max profit', a.profitOpen ? 'beyond range' : rs(a.maxProfit), 'up'],
        ['Max loss', a.lossOpen ? `${rs(a.maxLoss)} +` : rs(a.maxLoss), 'down'],
        ['Breakeven', a.breakevens.length ? a.breakevens.map((x) => num(x, 0)).join(' · ') : 'none'],
        ['Delta', num(g.delta, 1)],
        ['Theta / day', rs(g.theta)],
        ['Vega / 1 vol', rs(g.vega)],
      ]
        .map(([k, v, t]) => `<div class="stat"><span>${k}</span><b class="${t || ''}">${v}</b></div>`)
        .join('')}</div>` + `<p class="muted small">Over Nifty ±10 % at expiry, options + NIFTYBEES, before charges. NIFTYBEES moves in % with Nifty.</p>`;
  }

  const int = (id, min, max) => Math.min(max, Math.max(min, Math.round(+el.querySelector(id).value || 0)));
  const rules = ['#colExp', '#colLots', '#colCe', '#colPe', '#colGap'];
  rules.forEach((id) =>
    el.querySelector(id).addEventListener('change', () => {
      const prevExp = collarState().expiry;
      saveState({
        expiry: el.querySelector('#colExp').value,
        lots: int('#colLots', 1, 20),
        ceOff: int('#colCe', -1000, 2000),
        peOff: int('#colPe', -1000, 2000),
        gap: int('#colGap', 50, 1000),
        edit: [null, null, null], // new rules: the strikes and prices by the rules again
      });
      if (collarState().expiry !== prevExp) ctxRef.refreshNow();
      else renderNew();
    }),
  );
  el.querySelectorAll('[data-strike]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const i = +inp.dataset.strike;
      const edit = [...(collarState().edit || [null, null, null])];
      const k = Math.round(+inp.value);
      edit[i] = k > 0 ? { strike: k, price: null } : null; // a new strike takes its own LTP
      saveState({ edit });
      renderNew();
    }),
  );
  el.querySelectorAll('[data-price]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const i = +inp.dataset.price;
      const edit = [...(collarState().edit || [null, null, null])];
      edit[i] = { strike: legs[i].strike, price: posNum(inp.value) };
      saveState({ edit });
      renderNew();
    }),
  );
  [
    ['#colSpot', 'spotIn', posNum],
    ['#colBu', 'beesUnits', (v) => (v === '' ? null : Math.round(nonNeg(v) ?? 0))],
    ['#colBp', 'beesPx', posNum],
  ].forEach(([id, k, f]) =>
    el.querySelector(id).addEventListener('change', (e) => {
      saveState({ [k]: f(e.target.value) });
      renderNew();
    }),
  );
  el.querySelector('#colLive').onclick = () => {
    saveState({ edit: [null, null, null], spotIn: null, beesUnits: null, beesPx: null });
    renderNew();
  };
  el.querySelector('#colSave').onclick = () => {
    if (missing) return;
    const name = `${shape.short} ${fmtDate(chain.expiry)} @ ${num(spot, 0)}`;
    sheet(
      `<h3>Save trade</h3><label class="field"><span>Name</span><input id="svName" value="${esc(name)}" maxlength="60"></label>
       <p class="muted small">Saved on this phone as a live trade at the prices shown. Nothing is sent to a broker.</p>
       <div class="row gap"><button class="btn" data-close>Cancel</button><button class="btn primary" id="svOk">Save</button></div>`,
      (sh, close) => {
        sh.querySelector('#svOk').onclick = () => {
          const L = legs.map(({ type, strike, side, lots, entry, iv, key }) => ({ type, strike, side, lots, entry, iv, key }));
          const p = positions.add({
            kind: st.kind,
            name: sh.querySelector('#svName').value.trim() || name,
            expiry: chain.expiry,
            lotSize: lot,
            legs: L,
            bees,
            spot0: spot,
            costsIn: entryCosts(L, lot, bees),
          });
          store.set('liveId.' + st.kind, p.id);
          store.set('collarSub', 'live');
          close();
          toast(`Saved “${p.name}”: now in Live trade and Positions`);
          ctxRef.refreshNow();
        };
      },
    );
  };
}

// Payoff lines from Nifty lo to hi: the trade (NIFTYBEES + options) at expiry and today, the options at expiry, the
// sold call and the put spread at expiry, and NIFTYBEES alone. NIFTYBEES moves in % with Nifty from its buy price.
function payoffPts(legs, lot, expiry, E, bees, lo, hi) {
  const k = bees?.units > 0 && bees.entry > 0 ? bees.entry / (bees.spot0 || E) : 0;
  const etf = (x) => (bees?.units > 0 ? bees.units * (k * x - bees.entry) : 0);
  const out = { exp: [], today: [], opt: [], optToday: [], ce: [], pe: [], bees: [] };
  for (let i = 0; i <= 200; i++) {
    const x = lo + ((hi - lo) * i) / 200;
    const e = expiryAt(legs, lot, x);
    const d = todayAt(legs, lot, x, expiry);
    out.exp.push([x, e.CE + e.PE + etf(x)]);
    out.today.push([x, d.CE + d.PE + etf(x)]);
    out.opt.push([x, e.CE + e.PE]);
    out.optToday.push([x, d.CE + d.PE]);
    out.ce.push([x, e.CE]);
    out.pe.push([x, e.PE]);
    out.bees.push([x, etf(x)]);
  }
  return out;
}

const RANGES = [5, 10, 20];
// The payoff chart with its range buttons (± % around Nifty now; the start always in view) and a legend that hides or
// shows each line. The dot on "Now" is the trade's P&L today at Nifty now.
function drawPayoff(box, { legs, lot, expiry, S, E, bees, key, nowLabel = 'Now', pnl = null }) {
  const r = RANGES.includes(store.get('payRange')) ? store.get('payRange') : 10;
  const lo = Math.min(S * (1 - r / 100), E * 0.995);
  const hi = Math.max(S * (1 + r / 100), E * 1.005);
  const pts = payoffPts(legs, lot, expiry, E, bees, lo, hi);
  const has = bees?.units > 0;
  const series = has
    ? [
        { pts: pts.exp, cls: 's-tot', label: 'Total at expiry', area: true },
        { pts: pts.today, cls: 's-tot-now', label: 'Total today' },
        { pts: pts.opt, cls: 's-opt', label: 'Options at expiry' },
        { pts: pts.ce, cls: 's-ce', label: N.CE, hidden: true },
        { pts: pts.pe, cls: 's-pe', label: N.PE, hidden: true },
        { pts: pts.bees, cls: 's-bees', label: 'NIFTYBEES' },
      ]
    : [
        { pts: pts.opt, cls: 's-tot', label: 'Options at expiry', area: true },
        { pts: pts.optToday, cls: 's-tot-now', label: 'Options today' },
        { pts: pts.ce, cls: 's-ce', label: N.CE },
        { pts: pts.pe, cls: 's-pe', label: N.PE },
      ];
  const today = series[1];
  // the P&L now as the boxes at the top show it (NIFTYBEES at its LTP); else today's line at Nifty now
  const nowPnl = pnl ?? today.pts.reduce((b, p) => (Math.abs(p[0] - S) < Math.abs(b[0] - S) ? p : b))[1];
  box.innerHTML = `<div class="seg mini pay-range">${RANGES.map((x) => `<button data-r="${x}" class="${x === r ? 'on' : ''}">±${x} %</button>`).join('')}</div><div class="chart-box"></div>
    <p class="muted small">${has ? 'Total = NIFTYBEES + options. ' : ''}Solid: at expiry. Dashed: if Nifty moved there today (Black-Scholes, each leg fitted to its LTP). Touch the chart to read every line.</p>`;
  const marks = [{ x: S, label: `${nowLabel} ${num(S, 0)} · ${rs(nowPnl)}`, cls: 'spot', row: 0 }];
  if (Math.abs(E - S) >= 1) marks.push({ x: E, label: `Started ${num(E, 0)}`, cls: 'entry', row: 1 });
  lineChart(box.querySelector('.chart-box'), {
    series,
    height: 260,
    zero: true,
    area: true,
    legend: key + (has ? '-b' : ''),
    xFmt: (x) => num(x, 0),
    yFmt: (y) => inr(y, { lakh: Math.abs(y) >= 1e5 }),
    marks: marks.map((m) => ({ ...m, dot: m.cls === 'spot' ? today.label : null })),
  });
  box.querySelector('.pay-range').onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    store.set('payRange', +b.dataset.r);
    drawPayoff(box, { legs, lot, expiry, S, E, bees, key, nowLabel, pnl });
  };
}

// ---------- Live trade ----------
function liveModel(p) {
  const { chain, quotes } = data;
  const open = p.status === 'open';
  const S = (open && chain?.expiry === p.expiry ? chain.spot : null) || quotes[NIFTY]?.ltp || chain?.spot;
  const E = p.spot0 > 0 ? p.spot0 : S;
  const lot = p.lotSize;
  const expired = Date.now() >= Date.parse(p.expiry + 'T10:00:00Z'); // 15:30 IST on expiry day
  // after expiry the open legs are worth their intrinsic value at Nifty now
  const legs = priceLegs(p.legs, chain?.expiry === p.expiry ? chain : null, S, p.expiry).map((l) =>
    expired && !isClosed(l) ? { ...l, ltp: Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S) } : l,
  );
  const beesLtp = quotes[BEES]?.ltp;
  const b = p.bees?.units > 0 ? p.bees : null;
  const beesNow = b ? (b.exit > 0 ? b.exit : beesLtp > 0 ? beesLtp : b.entry * (S / (b.spot0 || E))) : beesLtp || null;
  const bees = b ? { units: b.units, entry: b.entry, spot0: b.spot0 || E, now: beesNow, live: !(b.exit > 0) && beesLtp > 0 } : null;
  return { p, S, E, lot, legs, bees, beesLtp, n: pnlNow(legs, lot, bees) };
}

function pickerHtml(cur) {
  const list = trades();
  return `<select id="lvPick" aria-label="Trade">${list
    .map((t) => `<option value="${t.id}" ${t.id === cur?.id ? 'selected' : ''}>${esc(t.name)}${t.status === 'open' ? '' : ' (closed)'} · ${fmtDate(t.expiry)}</option>`)
    .join('')}</select>`;
}

function statusHtml() {
  const s = store.settings();
  const open = marketOpen();
  const when = open || s.source === 'demo' ? `<span class="live-dot"></span> <b>Live</b>, every ${s.refreshSec} s` : 'Market closed: last traded prices';
  return `${when} · prices ${data.at ? fmtClock(data.at) : '—'} · legs at LTP${s.source === 'demo' ? ' · demo: simulated prices' : ''} · nothing is sent to a broker`;
}

function renderLive() {
  const el = root.querySelector('#colBody');
  const p = liveTrade();
  if (!p) {
    el.innerHTML = `<div class="card empty"><h3>No live trade</h3><p class="muted">Build the ${esc(COLLARS[collarState().kind].name.toLowerCase())} on <b>New trade</b> (every strike and price can be changed) and press <b>Save trade</b>. It is shown here and in Positions.</p><button class="btn primary" id="lvNew">New trade</button></div>`;
    el.querySelector('#lvNew').onclick = () => {
      store.set('collarSub', 'new');
      ctxRef.refreshNow();
    };
    return;
  }
  store.set(liveKey(), p.id);
  if (p.status !== 'open') return renderClosed(el, p);
  const m = liveModel(p);
  const { S, E, lot, legs, bees, n } = m;
  const openLegs = legs.filter((l) => !isClosed(l));
  const closedLegs = legs.filter(isClosed);
  const moved = E > 0 ? (S / E - 1) * 100 : null;
  const left = daysTo(p.expiry);
  el.innerHTML = `
    <section class="card lv-head">
      <div class="row gap">${pickerHtml(p)}<button class="btn small" id="lvRefresh" aria-label="Refresh">↻</button></div>
      <div class="muted small" id="lvStatus">${statusHtml()}</div>
      <div class="muted small">${esc(openLegs.map((l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`).join(' · '))} · expiry ${fmtDate(p.expiry)} (${left} day${left === 1 ? '' : 's'} left)${
        closedLegs.length ? ` · closed: ${esc(closedLegs.map((c) => `${c.side > 0 ? 'B' : 'S'} ${c.lots}× ${c.strike} ${c.type} ${num(c.entry)} → ${num(c.exit)}`).join(', '))}` : ''
      } · P&amp;L before charges</div>
      <div class="stats kpis">
        <div class="stat"><span>Nifty now</span><b>${num(S, 0)}</b><small>entry ${num(E, 0)} · <b class="${tone(moved)}">${pctS(moved)}</b></small></div>
        <div class="stat"><span>${N.CE}</span><b class="${tone(n.call)}">${n.call == null ? '—' : rs(n.call)}</b><small>at LTP</small></div>
        <div class="stat"><span>${N.PE}</span><b class="${tone(n.put)}">${n.put == null ? '—' : rs(n.put)}</b><small>at LTP${closedLegs.length ? ', closed legs in' : ''}</small></div>
        <div class="stat"><span>Options</span><b class="${tone(n.opt)}">${n.opt == null ? '—' : rs(n.opt)}</b><small>${n.ok ? 'every leg priced' : 'a leg has no price'}</small></div>
        <div class="stat"><span>NIFTYBEES</span><b class="${tone(n.bees)}">${bees ? rs(n.bees) : '—'}</b><small>${bees ? `${num(bees.units, 0)} × ${num(bees.entry)} → ${num(bees.now)}${bees.live ? '' : ' (est.)'}` : 'enter it below'}</small></div>
        <div class="stat total"><span>Total</span><b class="${tone(n.total)}">${n.total == null ? '—' : rs(n.total)}</b><small>NIFTYBEES + options now</small></div>
      </div>
      <div class="row gap"><button class="btn ${closing ? '' : 'danger'} grow" id="lvCloseBtn">${closing ? 'Cancel close' : 'Close entire trade…'}</button></div>
      <div id="lvClosePanel">${closing ? closePanelHtml(m) : ''}</div>
    </section>
    ${coverHtml(m)}
    <section class="card"><h2>Where it started and where it is</h2>${trackHtml(m)}</section>
    <section class="card">
      <div class="card-head"><h2>NIFTYBEES entry</h2><span class="muted small">${bees ? '' : 'none yet: the totals count the options only'}</span></div>
      <div class="form-grid three">
        <label class="field"><span>Units</span><input id="lvQty" type="number" inputmode="numeric" min="0" step="1" value="${p.bees?.units || ''}" placeholder="e.g. 5800"></label>
        <label class="field"><span>Bought at ₹</span><input id="lvPx" type="number" inputmode="decimal" min="0" step="0.01" value="${p.bees?.entry ? p.bees.entry : ''}" placeholder="${m.beesLtp ? m.beesLtp.toFixed(2) : ''}"></label>
        <label class="field"><span>Entry Nifty</span><input id="lvEntry" type="number" inputmode="decimal" step="0.05" value="${p.spot0 || ''}"></label>
      </div>
      <button class="btn primary block" id="lvSaveBees">Save</button>
      <p class="muted small">NIFTYBEES now: ${bees?.live ? 'its LTP' : bees ? "estimated from Nifty's move since the entry" : '—'}. Entry Nifty is the start marked on the line, the grid and the payoff.</p>
    </section>
    <section class="card">
      <div class="card-head"><h2>Legs and payoff</h2><button class="btn small" id="lvAdd">+ Add leg</button></div>
      <div class="tbl-scroll"><table class="legs live"><thead><tr><th>Leg</th><th>Entry</th><th>Now / exit</th><th>IV</th><th>P&amp;L</th></tr></thead><tbody>${legsBody(m)}</tbody></table></div>
      <p class="muted small">Tap a leg to change its strike, lots, entry or exit price, or to close it. Lot ${lot}.</p>
      <div id="lvChart"></div>
    </section>
    <section class="card">
      <h2>P&amp;L for Nifty moves from where the trade started</h2>
      <p class="muted small">Started at <b>${num(E, 0)}</b>, now <b>${num(S, 0)}</b> (<b class="${tone(S - E)}">${pctS(moved)}</b>). Every P&amp;L is the trade's since the start; NIFTYBEES moves in % with Nifty from its buy price (its price now in the <b>Now</b> row). <b>Today</b>: the options keep their time value (Black-Scholes, each leg fitted to its LTP). <b>Expiry</b>: at intrinsic. Swipe the table sideways.</p>
      <div class="tbl-scroll grid-scroll">${gridHtml(m)}</div>
    </section>
    <p class="muted small">The portal's "Suggestions to improve the result" test changes on past Nifty data on the PC; the phone has no history store, so they are not shown here.</p>
    <div class="row gap"><button class="btn danger" id="lvDelete">Delete trade</button></div>`;
  drawLiveChart(m);
  bindLive(m);
}

function legsBody(m) {
  const { p, lot, legs, n, bees } = m;
  const row = (l, i) => {
    const closed = isClosed(l);
    const px = closed ? l.exit : l.ltp;
    const pnl = px != null ? l.side * l.lots * lot * (px - l.entry) : null;
    return `<tr class="tap ${closed ? 'closed' : ''}" data-leg="${i}"><td><span class="pill ${l.side > 0 ? 'buy' : 'sell'}">${l.side > 0 ? 'B' : 'S'}</span> ${l.lots}× ${l.strike} ${l.type}${closed ? ' <small>closed</small>' : ''}</td><td>${num(l.entry)}</td><td>${num(px)}</td><td class="muted">${!closed && l.vol ? num(l.vol * 100, 1) : '—'}</td><td class="${tone(pnl)}">${pnl == null ? '—' : rs(pnl)}</td></tr>`;
  };
  const group = (t, v) => {
    const idx = legs.map((l, i) => i).filter((i) => legs[i].type === t);
    if (!idx.length) return '';
    return `<tr class="grp"><td colspan="4"><b>${N[t]}</b></td><td class="${tone(v)}"><b>${v == null ? '—' : rs(v)}</b></td></tr>${idx.map((i) => row(legs[i], i)).join('')}`;
  };
  const beesRow = bees
    ? `<tr class="grp"><td><b class="up">Buy</b> ${num(bees.units, 0)} NIFTYBEES</td><td>${num(bees.entry)}</td><td>${num(bees.now)}</td><td class="muted">${pctS((bees.now / bees.entry - 1) * 100)}</td><td class="${tone(n.bees)}"><b>${rs(n.bees)}</b></td></tr>`
    : `<tr class="grp"><td colspan="4"><b>NIFTYBEES</b> <small class="muted">none entered</small></td><td>—</td></tr>`;
  void p;
  return `${group('CE', n.call)}${group('PE', n.put)}
    <tr class="tot"><td colspan="4"><b>Options</b></td><td class="${tone(n.opt)}"><b>${n.opt == null ? '—' : rs(n.opt)}</b></td></tr>
    ${beesRow}
    <tr class="tot total"><td colspan="4"><b>Total: NIFTYBEES + options</b></td><td class="${tone(n.total)}"><b>${n.total == null ? '—' : rs(n.total)}</b></td></tr>`;
}

function gridHtml(m) {
  const rows = moveGrid({ legs: m.legs, lot: m.lot, expiry: m.p.expiry, spot: m.S, entrySpot: m.E, bees: m.bees });
  const lo = Math.min(m.E, m.S);
  const hi = Math.max(m.E, m.S);
  const td = (v, b) => `<td class="${tone(v)}">${b ? '<b>' : ''}${rs(Math.round(v))}${b ? '</b>' : ''}</td>`;
  const body = rows
    .map((r) => {
      const label = r.mark === 'now' ? `<b>Now</b> <b class="${tone(r.m)}">${pctS(r.m)}</b>` : r.mark === 'entry' ? '<b>Started</b>' : pctS(r.m, 1);
      const path = !r.mark && r.x > lo && r.x < hi ? ' path' : '';
      return `<tr class="${r.mark === 'now' ? 'now' : r.mark === 'entry' ? 'entry' : ''}${path}"><th>${label}</th><td><b>${num(r.x, 0)}</b></td><td class="muted">${r.mark === 'now' ? '—' : pctS(r.fromNow, 1)}</td><td>${r.beesPx != null ? num(r.beesPx) : '—'}</td>${m.bees ? td(r.bees) : '<td class="muted">—</td>'}
        <td class="g1 ${tone(r.callToday)}">${rs(Math.round(r.callToday))}</td>${td(r.putToday)}${td(r.optToday)}${td(r.totalToday, true)}
        <td class="g2 ${tone(r.call)}">${rs(Math.round(r.call))}</td>${td(r.put)}${td(r.opt)}${td(r.total, true)}</tr>`;
    })
    .join('');
  return `<table class="grid"><thead>
    <tr class="ghead"><th></th><th colspan="4"></th><th colspan="4" class="g1">If Nifty is there today</th><th colspan="4" class="g2">At expiry (${fmtDate(m.p.expiry)})</th></tr>
    <tr><th>From start</th><th>Nifty</th><th>From now</th><th>NIFTY­BEES</th><th>NIFTY­BEES P&amp;L</th><th class="g1">${N.CE}</th><th>${N.PE}</th><th>Options</th><th>Total</th><th class="g2">${N.CE}</th><th>${N.PE}</th><th>Options</th><th>Total</th></tr>
  </thead><tbody>${body}</tbody></table>`;
}

// The strikes on a line, with the entry and Nifty now marked (the portal's track).
function trackHtml(m) {
  const { p, S, E } = m;
  const open = p.legs.filter((l) => !isClosed(l));
  const ks = open.map((l) => l.strike);
  const all = [...p.legs.map((l) => l.strike), S, E];
  const lo = Math.min(...all) * 0.992;
  const hi = Math.max(...all) * 1.008;
  const pos = (x) => ((x - lo) / (hi - lo)) * 100;
  const at = (x) => pos(x).toFixed(2) + '%';
  const lotsText = (legs) => legs.map((l) => `${l.side > 0 ? '+' : '−'}${l.lots} ${l.type}`).join(' ');
  const ticks = [...new Set(ks)].sort((a, b) => a - b).map((k) => {
    const legs = open.filter((l) => l.strike === k);
    return { k, cls: legs.reduce((s, l) => s + l.side * l.lots, 0) < 0 ? 'down' : 'up', t: lotsText(legs) };
  });
  const lastAt = [-Infinity, -Infinity, -Infinity];
  const strikes = ticks
    .map((x) => {
      let row = lastAt.findIndex((q) => pos(x.k) - q >= 18);
      if (row < 0) row = lastAt.indexOf(Math.min(...lastAt));
      lastAt[row] = pos(x.k);
      return `<span class="tk ${x.cls} r${row}" style="left:${at(x.k)}"><i></i><em>${x.k}</em><small>${esc(x.t)}</small></span>`;
    })
    .join('');
  const puts = open.filter((l) => l.type === 'PE').map((l) => l.strike);
  const calls = open.filter((l) => l.type === 'CE' && l.side < 0).map((l) => l.strike);
  const zone = puts.length && calls.length && Math.max(...calls) > Math.min(...puts) ? `<span class="zone" style="left:${at(Math.min(...puts))};width:calc(${at(Math.max(...calls))} - ${at(Math.min(...puts))})"></span>` : '';
  const rows = lastAt.filter(Number.isFinite).length;
  return `<div class="track" style="padding-bottom:${40 + 26 * Math.max(0, rows - 1)}px"><div class="line">${zone}${strikes}
    <span class="arrow ${S >= E ? 'up' : 'down'}" style="left:${at(Math.min(S, E))};width:calc(${at(Math.max(S, E))} - ${at(Math.min(S, E))})"></span>
    <span class="mk entry ${pos(E) > 50 ? 'l' : 'r'}" style="left:${at(E)}"><span><b>Started</b> ${num(E, 0)}</span></span>
    <span class="mk now ${pos(S) > 50 ? 'l' : 'r'}" style="left:${at(S)}"><span><b>Now</b> ${num(S, 0)} · ${pctS((S / E - 1) * 100)}</span></span>
  </div></div>`;
}

// How much NIFTYBEES the upside needs, with a slider to try quantities (what-if only).
function coverHtml(m) {
  const c = beesCover({ legs: m.legs, lot: m.lot, spot: m.S, bees: m.bees });
  if (!c) return '';
  const q = coverQ ?? c.held;
  return `<section class="card cover" id="lvCover"><details open><summary>NIFTYBEES needed so the upside does not lose</summary>
    <div id="lvCoverBody">${coverBody(m, c, q)}</div>
    <label class="field"><span>Try a NIFTYBEES quantity (what-if, nothing is saved)</span>
      <input type="range" id="lvCq" min="0" max="${Math.ceil(Math.max(c.slopeUnits * 2, c.held * 1.5, (c.minUnits || 0) * 1.3, 1000) / 100) * 100}" step="1" value="${q}"></label>
    <div class="row gap"><input id="lvCqn" type="number" inputmode="numeric" min="0" step="1" value="${q}" aria-label="Units to try"><button class="btn small" data-cq="held">Held</button>${c.minUnits != null ? '<button class="btn small" data-cq="min">Minimum</button>' : ''}</div>
  </details></section>`;
}
function coverBody(m, c, q) {
  const S = m.S;
  const covers = c.minUnits != null && q >= c.minUnits;
  const slope = q * c.perUnit - c.perPoint;
  const diff = q - c.held;
  const what = diff === 0 ? `Your ${num(q, 0)} NIFTYBEES` : `${num(q, 0)} NIFTYBEES (${diff > 0 ? 'buy' : 'sell'} ${num(Math.abs(diff), 0)} now, ≈ ${inr(Math.abs(diff) * c.beesNow)})`;
  const head = covers
    ? `<b class="up">${what} cover the upside</b>: at expiry the trade does not lose anywhere above Nifty now.`
    : c.minUnits == null
      ? '<b class="down">No NIFTYBEES quantity makes the upside safe here.</b>'
      : `<b class="down">${what} do not cover the upside.</b> Minimum <b>${num(c.minUnits, 0)} units</b>${c.toBuy > 0 ? `: buy <b>${num(c.toBuy, 0)} more</b> (≈ ${inr(c.cost)} at ₹${num(c.beesNow)})` : ''}.`;
  const cols = [{ q: c.held, label: `${num(c.held, 0)} held` }, ...(q !== c.held ? [{ q, label: `${num(q, 0)} tried`, tried: true }] : []), ...(c.minUnits != null && c.minUnits !== c.held && c.minUnits !== q ? [{ q: c.minUnits, label: `${num(c.minUnits, 0)} min.` }] : [])];
  const rows = COVER_PCTS.map((pc) => {
    const x = S * (1 + pc / 100);
    return `<tr><th>${pc === 0 ? 'Now' : '+' + pc + ' %'}</th><td>${num(x, 0)}</td>${cols.map((k) => `<td class="${tone(c.at(x, k.q))} ${k.tried ? 'tried' : ''}">${rs(c.at(x, k.q))}</td>`).join('')}</tr>`;
  }).join('');
  return `<p class="small">${head}</p>
    <ol class="small steps">
      <li>Calls sold net: <b>${c.netShortLots} lot${c.netShortLots === 1 ? '' : 's'}</b> = ${c.netShortLots * c.lot} units of Nifty, so above the call the options lose <b>₹${num(c.perPoint, 0)} a point</b>.</li>
      <li>One NIFTYBEES unit: ₹${num(c.beesNow)} ÷ ${num(S, 0)} = <b>₹${c.perUnit.toFixed(5)} a Nifty point</b>.</li>
      <li>To cancel it: ${num(c.perPoint, 0)} ÷ ${c.perUnit.toFixed(5)} = <b>${num(c.slopeUnits, 0)} units</b> (${inr(c.slopeUnits * c.beesNow)}).</li>
      <li>With ${num(q, 0)} units, far up the trade ${slope >= 0 ? 'gains' : 'loses'} <b class="${tone(slope)}">₹${num(Math.abs(slope))} a point</b>.</li>
    </ol>
    <div class="tbl-scroll"><table class="legs cover-t"><thead><tr><th>Nifty</th><th></th>${cols.map((k) => `<th>${k.label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small">At expiry: NIFTYBEES + options, closed legs included; units above those held count as bought now at ₹${num(c.beesNow)}.</p>`;
}

function drawLiveChart(m) {
  const box = root.querySelector('#lvChart');
  if (box) drawPayoff(box, { legs: m.legs, lot: m.lot, expiry: m.p.expiry, S: m.S, E: m.E, bees: m.bees, key: 'pay-live', pnl: m.n.total });
}

// ---------- close the whole trade ----------
function closePrices(m) {
  const out = {};
  m.legs.forEach((l, i) => {
    if (isClosed(l)) return;
    out[i] = closeVals[i] ?? (l.ltp != null ? String(l.ltp) : '');
  });
  if (m.bees && !(m.p.bees?.exit > 0)) out.bees = closeVals.bees ?? (m.bees.now ? m.bees.now.toFixed(2) : '');
  return out;
}
function closeTotals(m) {
  const px = closePrices(m);
  let opt = 0;
  let ok = true;
  m.legs.forEach((l, i) => {
    if (isClosed(l)) return (opt += l.side * l.lots * m.lot * (l.exit - l.entry));
    const v = nonNeg(px[i]);
    if (v == null) ok = false;
    else opt += l.side * l.lots * m.lot * (v - l.entry);
  });
  const bv = posNum(px.bees);
  const bees = m.bees ? (bv ? m.bees.units * (bv - m.bees.entry) : 0) : 0;
  if (m.bees && px.bees !== undefined && !bv) ok = false;
  return { opt, bees, total: opt + bees, ok };
}
function closePanelHtml(m) {
  const px = closePrices(m);
  const rows = m.legs
    .map((l, i) => {
      if (isClosed(l)) return '';
      const v = nonNeg(px[i]);
      const pnl = v == null ? null : l.side * l.lots * m.lot * (v - l.entry);
      return `<tr><td><b class="${l.side < 0 ? 'up' : 'down'}">${l.side < 0 ? 'Buy back' : 'Sell'}</b> ${l.lots}× ${l.strike} ${l.type}<small>entry ${num(l.entry)} · LTP ${num(l.ltp)}</small></td><td><input class="cell" data-cpx="${i}" type="number" inputmode="decimal" min="0" step="0.05" value="${esc(px[i])}" placeholder="price"></td><td class="${tone(pnl)}" data-cpnl="${i}">${pnl == null ? '—' : rs(pnl)}</td></tr>`;
    })
    .join('');
  const beesRow =
    px.bees !== undefined
      ? `<tr><td><b class="down">Sell</b> ${num(m.bees.units, 0)} NIFTYBEES<small>bought ${num(m.bees.entry)} · now ${num(m.bees.now)}${m.bees.live ? '' : ' (est.)'}</small></td><td><input class="cell" data-cpx="bees" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(px.bees)}" placeholder="price"></td><td data-cpnl="bees"></td></tr>`
      : '';
  return `<div class="close-panel">
    <p class="small"><b>Close the entire trade</b> <span class="muted">exit prices filled from the LTPs; change them to the prices you actually got.</span></p>
    <table class="legs edit close-t"><thead><tr><th>Exit</th><th>Price</th><th>P&amp;L</th></tr></thead><tbody>${rows}${beesRow}</tbody></table>
    <div class="small" id="lvCloseTot">${closeTotHtml(closeTotals(m))}</div>
    <div class="row gap"><button class="btn small" id="lvCloseLive">↺ LTPs</button><button class="btn danger grow" id="lvCloseGo">Record the close</button></div>
    <p class="muted small">Records the exits on this phone (the trade moves to closed; you can reopen it). Nothing is sent to a broker.</p></div>`;
}
const closeTotHtml = (t) =>
  `Options <b class="${tone(t.opt)}">${rs(t.opt)}</b> · NIFTYBEES <b class="${tone(t.bees)}">${rs(t.bees)}</b> · Total <b class="${tone(t.total)}">${t.ok ? rs(t.total) : '— a price is missing'}</b> <span class="muted">before charges</span>`;

function recordClose(m) {
  const t = closeTotals(m);
  if (!t.ok) return toast('Type an exit price for every leg first');
  const px = closePrices(m);
  const at = Date.now();
  const p = m.p;
  const legs = p.legs.map((l, i) => (isClosed(l) ? l : { ...l, exit: nonNeg(px[i]), exitAt: at }));
  const bees = p.bees ? { ...p.bees, ...(px.bees !== undefined ? { exit: posNum(px.bees), exitAt: at } : {}) } : p.bees;
  const s = store.settings();
  const v = valuePosition({ ...p, legs, bees }, { chain: null, spot: m.S, beesPx: bees?.exit, slipPct: s.slipPct, brokerage: s.brokerage });
  positions.update(p.id, { legs, bees, status: 'closed', exit: { ...v, at, spot: m.S, beesPx: bees?.exit ?? null } });
  closing = false;
  closeVals = {};
  toast('Trade closed and recorded');
  render(root, ctxRef, data);
}

// ---------- a closed trade ----------
function renderClosed(el, p) {
  const lot = p.lotSize;
  const rows = p.legs
    .map((l) => {
      const pnl = isClosed(l) ? l.side * l.lots * lot * (l.exit - l.entry) : null;
      return `<tr><td><span class="pill ${l.side > 0 ? 'buy' : 'sell'}">${l.side > 0 ? 'B' : 'S'}</span> ${l.lots}× ${l.strike} ${l.type}</td><td>${num(l.entry)}</td><td>${isClosed(l) ? num(l.exit) : '—'}</td><td class="${tone(pnl)}">${pnl == null ? '—' : rs(pnl)}</td></tr>`;
    })
    .join('');
  const b = p.bees;
  const bp = b?.units > 0 && b.exit > 0 ? b.units * (b.exit - b.entry) : null;
  const opt = p.legs.reduce((a, l) => a + (isClosed(l) ? l.side * l.lots * lot * (l.exit - l.entry) : 0), 0);
  el.innerHTML = `<section class="card">
      <div class="row gap">${pickerHtml(p)}</div>
      <div class="card-head"><h2>Closed</h2><span class="muted small">${p.exit?.at ? new Date(p.exit.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span></div>
      <table class="legs"><thead><tr><th>Leg</th><th>Entry</th><th>Exit</th><th>P&amp;L</th></tr></thead><tbody>${rows}${
        b?.units > 0 ? `<tr><td>NIFTYBEES ${num(b.units, 0)}</td><td>${num(b.entry)}</td><td>${b.exit ? num(b.exit) : '—'}</td><td class="${tone(bp)}">${bp == null ? '—' : rs(bp)}</td></tr>` : ''
      }</tbody></table>
      <div class="stats"><div class="stat"><span>Options</span><b class="${tone(opt)}">${rs(opt)}</b></div><div class="stat"><span>NIFTYBEES</span><b class="${tone(bp)}">${bp == null ? '—' : rs(bp)}</b></div>
        <div class="stat"><span>Total before charges</span><b class="${tone(opt + (bp || 0))}">${rs(opt + (bp || 0))}</b></div><div class="stat"><span>After charges</span><b class="${tone(p.exit?.net)}">${p.exit ? inr(p.exit.net, { sign: true }) : '—'}</b></div></div>
      <div class="row gap"><button class="btn" id="lvReopen">Reopen (undo the close)</button><button class="btn danger" id="lvDelete">Delete</button></div>
    </section>`;
  bindPick(el);
  el.querySelector('#lvReopen').onclick = () => {
    const at = p.exit?.at;
    positions.update(p.id, {
      status: 'open',
      exit: null,
      legs: p.legs.map((l) => (l.exitAt && l.exitAt === at ? stripExit(l) : l)),
      bees: p.bees && p.bees.exitAt === at ? stripExit(p.bees) : p.bees,
    });
    toast('Reopened');
    ctxRef.refreshNow();
  };
  bindDelete(el, p);
}
const stripExit = (o) => {
  const { exit, exitAt, ...rest } = o;
  void exit;
  void exitAt;
  return rest;
};

function bindPick(el) {
  const s = el.querySelector('#lvPick');
  if (s)
    s.onchange = () => {
      store.set(liveKey(), s.value);
      closing = false;
      closeVals = {};
      coverQ = null;
      ctxRef.refreshNow();
    };
}
function bindDelete(el, p) {
  el.querySelector('#lvDelete').onclick = async () => {
    if (await confirmSheet(`Delete “${p.name}”? This cannot be undone (Settings › Export backup keeps a copy).`, 'Delete', true)) {
      positions.remove(p.id);
      toast('Deleted');
      ctxRef.refreshNow();
    }
  };
}

function bindLive(m) {
  const el = root.querySelector('#colBody');
  const p = m.p;
  bindPick(el);
  bindDelete(el, p);
  el.querySelector('#lvRefresh').onclick = () => ctxRef.refreshNow();
  el.querySelector('#lvCloseBtn').onclick = () => {
    closing = !closing;
    closeVals = {};
    render(root, ctxRef, data);
    if (closing) root.querySelector('#lvClosePanel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  if (closing) {
    el.querySelectorAll('[data-cpx]').forEach((inp) =>
      inp.addEventListener('input', () => {
        closeVals[inp.dataset.cpx] = inp.value;
        const k = inp.dataset.cpx;
        const cell = el.querySelector(`[data-cpnl="${k}"]`);
        if (k !== 'bees') {
          const l = m.legs[+k];
          const v = nonNeg(inp.value);
          const pnl = v == null ? null : l.side * l.lots * m.lot * (v - l.entry);
          cell.className = tone(pnl);
          cell.textContent = pnl == null ? '—' : rs(pnl);
        }
        el.querySelector('#lvCloseTot').innerHTML = closeTotHtml(closeTotals(m));
      }),
    );
    el.querySelector('#lvCloseLive').onclick = () => {
      closeVals = {};
      render(root, ctxRef, data);
    };
    el.querySelector('#lvCloseGo').onclick = () => recordClose(m);
  }
  // NIFTYBEES entry and entry Nifty
  el.querySelector('#lvSaveBees').onclick = () => {
    const units = Math.round(nonNeg(el.querySelector('#lvQty').value) ?? 0);
    const px = posNum(el.querySelector('#lvPx').value) ?? m.beesLtp;
    const spot0 = posNum(el.querySelector('#lvEntry').value) ?? p.spot0;
    const bees = units > 0 && px > 0 ? { ...(p.bees || {}), units, entry: px, spot0 } : null;
    positions.update(p.id, { bees, spot0, costsIn: entryCosts(p.legs, p.lotSize, bees) });
    coverQ = null;
    toast('NIFTYBEES and entry Nifty saved');
    render(root, ctxRef, data);
  };
  // cover slider
  const cover = el.querySelector('#lvCover');
  if (cover) {
    const c = beesCover({ legs: m.legs, lot: m.lot, spot: m.S, bees: m.bees });
    const set = (v, from) => {
      const q = Math.max(0, Math.round(+v || 0));
      coverQ = q === c.held ? null : q;
      if (from !== 'range') el.querySelector('#lvCq').value = String(q);
      if (from !== 'number') el.querySelector('#lvCqn').value = String(q);
      el.querySelector('#lvCoverBody').innerHTML = coverBody(m, c, q);
    };
    el.querySelector('#lvCq').addEventListener('input', (e) => set(e.target.value, 'range'));
    el.querySelector('#lvCqn').addEventListener('input', (e) => set(e.target.value, 'number'));
    cover.addEventListener('click', (e) => {
      const k = e.target.closest('[data-cq]')?.dataset.cq;
      if (k) set(k === 'min' ? c.minUnits : c.held);
    });
  }
  // legs: tap to edit, + to add
  el.querySelector('table.live').addEventListener('click', (e) => {
    const i = e.target.closest('[data-leg]')?.dataset.leg;
    if (i != null) legSheet(m, +i);
  });
  el.querySelector('#lvAdd').onclick = () => legSheet(m, null);
}

// The chain's LTP for a strike of the trade's expiry (null without the chain or a price).
function chainLtp(type, strike) {
  const r = data.chain ? rowAt(data.chain.rows, strike) : null;
  return ltpOf(type === 'CE' ? r?.ce : r?.pe) ?? null;
}

// Edit one leg (i) or add one (i = null): side, type, strike, lots, entry, exit (blank = open).
function legSheet(m, i) {
  const p = m.p;
  const l = i == null ? { type: 'PE', strike: Math.round(m.S / NIFTY_STEP) * NIFTY_STEP, side: 1, lots: 1, entry: null } : p.legs[i];
  let side = l.side;
  let type = l.type;
  const sameExp = data.chain?.expiry === p.expiry;
  const hint = () => {
    const k = Math.round(+document.getElementById('lgK').value);
    const v = sameExp ? chainLtp(type, k) : null;
    return v != null ? `LTP now ${num(v)}` : 'no LTP for this strike';
  };
  sheet(
    `<h3>${i == null ? 'Add a leg' : 'Edit leg'}</h3>
    <div class="seg small" id="lgSide"><button data-v="1" class="${side > 0 ? 'on' : ''}">Buy</button><button data-v="-1" class="${side < 0 ? 'on' : ''}">Sell</button></div>
    <div class="seg small" id="lgType" style="margin-top:8px"><button data-v="CE" class="${type === 'CE' ? 'on' : ''}">CE</button><button data-v="PE" class="${type === 'PE' ? 'on' : ''}">PE</button></div>
    <div class="form-grid" style="margin-top:10px">
      <label class="field"><span>Strike</span><input id="lgK" type="number" inputmode="numeric" step="${NIFTY_STEP}" value="${l.strike}"></label>
      <label class="field"><span>Lots</span><input id="lgLots" type="number" inputmode="numeric" min="1" max="50" value="${l.lots}"></label>
      <label class="field"><span>Entry ₹</span><input id="lgEntry" type="number" inputmode="decimal" min="0" step="0.05" value="${l.entry ?? ''}" placeholder="LTP"></label>
      <label class="field"><span>Exit ₹ <small>(blank = open)</small></span><input id="lgExit" type="number" inputmode="decimal" min="0" step="0.05" value="${isClosed(l) ? l.exit : ''}" placeholder="open"></label>
    </div>
    <p class="muted small" id="lgHint"></p>
    <div class="row gap wrap"><button class="btn small" id="lgUseE">Entry = LTP</button><button class="btn small" id="lgUseX">Exit = LTP</button></div>
    <div class="row gap" style="margin-top:12px">${i == null ? '' : '<button class="btn danger" id="lgDel">Delete</button>'}<button class="btn" data-close>Cancel</button><button class="btn primary" id="lgOk">Save</button></div>`,
    (sh, close) => {
      const $ = (id) => sh.querySelector(id);
      const upd = () => ($('#lgHint').textContent = hint());
      upd();
      const seg = (id, f) =>
        ($(id).onclick = (e) => {
          const b = e.target.closest('[data-v]');
          if (!b) return;
          $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          f(b.dataset.v);
          upd();
        });
      seg('#lgSide', (v) => (side = +v));
      seg('#lgType', (v) => (type = v));
      $('#lgK').addEventListener('input', upd);
      const ltpNow = () => (sameExp ? chainLtp(type, Math.round(+$('#lgK').value)) : null);
      $('#lgUseE').onclick = () => {
        const v = ltpNow();
        if (v != null) $('#lgEntry').value = v;
      };
      $('#lgUseX').onclick = () => {
        const v = ltpNow();
        if (v != null) $('#lgExit').value = v;
      };
      if ($('#lgDel'))
        $('#lgDel').onclick = () => {
          const legs = p.legs.filter((x, j) => j !== i);
          positions.update(p.id, { legs, costsIn: entryCosts(legs, p.lotSize, p.bees) });
          close();
          toast('Leg removed');
          render(root, ctxRef, data);
        };
      $('#lgOk').onclick = () => {
        const strike = Math.round(+$('#lgK').value);
        const lots = Math.max(1, Math.min(50, Math.round(+$('#lgLots').value || 1)));
        const entry = nonNeg($('#lgEntry').value) ?? ltpNow();
        if (!(strike > 0)) return toast('Type a strike');
        if (entry == null) return toast('Type an entry price (there is no LTP for this strike)');
        const exitRaw = $('#lgExit').value.trim();
        const exit = exitRaw === '' ? null : nonNeg(exitRaw);
        const base = i == null ? {} : stripExit(p.legs[i]);
        const changedOption = i == null || base.strike !== strike || base.type !== type;
        const leg = { ...base, type, strike, side, lots, entry, ...(changedOption ? { key: null, iv: null } : {}), ...(exit != null ? { exit, exitAt: (i != null && p.legs[i].exitAt) || Date.now() } : {}) };
        const legs = i == null ? [...p.legs, leg] : p.legs.map((x, j) => (j === i ? leg : x));
        positions.update(p.id, { legs, costsIn: entryCosts(legs, p.lotSize, p.bees) });
        close();
        toast(i == null ? 'Leg added' : 'Leg saved');
        render(root, ctxRef, data);
      };
    },
  );
}
