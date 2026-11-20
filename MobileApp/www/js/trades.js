// Saved trades from the portal (its Trades screen), read on the phone: the trades file and the ledger file the
// portal keeps in its repository (bt-data/paper-trades.json, bt-data/ledger.json), fetched from GitHub (or, when the
// app is served by tools/serve.js on the PC, from the PC's bt-data/). The last good copy is kept on the phone.
// The figures are the portal's own (a copy of public/ledger-view.js and public/portfolio-view.js): the Live / Paper
// lists, the Ledger (NIFTYBEES lots, options per trade, capital and cash) and the Portfolio P&L of the Live trades.
// A trade's CE and PE legs are one options item; NIFTYBEES is its own item.
import * as store from './store.js';

export const DEFAULT_REPO = 'jobshari2/OptionsBacktesting_claude';
const FILES = { trades: 'paper-trades.json', ledger: 'ledger.json' };

// the GitHub repository: the setting, else the one this app is published from (<owner>.github.io/<repo>/), else the
// portal's own
export function repoOf(loc = globalThis.location, setting = store.settings().tradesRepo) {
  if (setting && /^[\w.-]+\/[\w.-]+$/.test(setting.trim())) return setting.trim();
  const h = loc?.hostname || '';
  const seg = (loc?.pathname || '').split('/').filter(Boolean)[0];
  if (h.endsWith('.github.io') && seg) return `${h.split('.')[0]}/${seg}`;
  return DEFAULT_REPO;
}
export const rawUrl = (repo, branch, file) => `https://raw.githubusercontent.com/${repo}/${branch || 'main'}/bt-data/${file}`;

// Reads both files: from the PC's bt-data/ when the app is served from the PC (tools/serve.js), else GitHub.
// Returns { trades, ledger, at, from, stale?, error? }.
export async function loadData({ fetchImpl = (...a) => globalThis.fetch(...a), loc = globalThis.location } = {}) {
  const s = store.settings();
  const repo = repoOf(loc, s.tradesRepo);
  const branch = s.tradesBranch || 'main';
  const local = loc && !(loc.hostname || '').endsWith('.github.io') && /^https?:$/.test(loc.protocol || '');
  const getJson = async (url) => {
    const r = await fetchImpl(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} for ${url.replace(/\?.*$/, '')}`);
    return r.json();
  };
  const read = async (base, from) => {
    const [trades, ledger] = await Promise.all([getJson(base(FILES.trades)), getJson(base(FILES.ledger)).catch(() => ({}))]);
    return { trades: Array.isArray(trades) ? trades : trades?.trades || [], ledger: ledger?.ledger || ledger || {}, at: Date.now(), from };
  };
  try {
    let d = null;
    if (local) d = await read((f) => `bt-data/${f}?t=${Date.now()}`, 'this PC').catch(() => null);
    d ||= await read((f) => `${rawUrl(repo, branch, f)}?t=${Date.now()}`, `GitHub ${repo}`);
    store.set('tradesData', d);
    return d;
  } catch (e) {
    const last = store.get('tradesData');
    if (last) return { ...last, stale: true, error: e };
    throw e;
  }
}
export const savedData = () => store.get('tradesData');

// ---------- a saved trade ----------
const MCC_NAME = { psc: 'Put spread collar', bpc: 'Bull put collar', nbo: 'NIFTYBEES + options', pbs: 'Put back spread', mcc: 'Modified covered call' };
// 'live' (real money) or 'paper', as the portal reads it
export const accountOf = (t) => (t.summary?.src !== 'live' ? 'paper' : t.account === 'live' || t.account === 'paper' ? t.account : /paper/i.test(t.name || '') ? 'paper' : 'live');
function mccKind(m, legs) {
  if (MCC_NAME[m?.kind]) return m.kind;
  const all = (legs || []).filter((l) => l.lots > 0);
  const open = all.filter((l) => l.open);
  const ls = open.length ? open : all;
  const of = (t, a) => ls.filter((l) => l.type === t && l.action === a);
  const lots = (a) => a.reduce((n, l) => n + l.lots, 0);
  const [cs, cb, pb, ps] = [of('CE', 'S'), of('CE', 'B'), of('PE', 'B'), of('PE', 'S')];
  const callAndPuts = lots(cs) > 0 && !cb.length && lots(pb) > 0 && lots(pb) === lots(ps);
  if (callAndPuts && Math.min(...pb.map((l) => l.strike)) > Math.max(...ps.map((l) => l.strike))) return 'psc';
  if (callAndPuts && Math.min(...ps.map((l) => l.strike)) > Math.max(...pb.map((l) => l.strike))) return 'bpc';
  if (!cs.length && !cb.length && lots(ps) > 0 && lots(pb) > lots(ps)) return 'pbs';
  return 'mcc';
}
export function strategyOf(t) {
  const m = t.snap?.mcc;
  return m?.on || m?.kind ? MCC_NAME[mccKind(m, t.snap.legs)] || '' : t.snap?.idea || '';
}
export const lotOf = (t) => t.summary?.lot || 65;
const dir = (l) => (l.action === 'B' ? 1 : -1);

// Each leg's P&L: closed at its exit; open at the price now (prices: Map "expiry|strike|type" -> ltp) or, without
// one, with no P&L of its own (the trade's saved open P&L is used for the total).
export function legRows(t, prices) {
  const lot = lotOf(t);
  return (t.snap?.legs || []).map((l) => {
    const now = l.open ? prices?.get(`${l.expiry}|${l.strike}|${l.type}`) : null;
    const px = l.open ? now ?? null : l.exitPx;
    return { ...l, now: px, pnl: px == null ? null : dir(l) * l.lots * lot * (px - l.entryPx) };
  });
}
// The options P&L of a trade: closed legs + open legs at the price now when every open leg has one, else as saved
export function optionsPnl(t, prices) {
  const rows = legRows(t, prices);
  const open = rows.filter((l) => l.open);
  if (!open.length) return { total: t.summary?.total ?? rows.reduce((a, l) => a + (l.pnl || 0), 0), now: false };
  if (open.every((l) => l.now != null)) return { total: rows.reduce((a, l) => a + (l.pnl || 0), 0), now: true };
  return { total: t.summary?.total ?? null, now: false };
}
// The trade's figures as the portal splits them: options P&L and NIFTYBEES P&L (sold, at the price now, or estimated
// from Nifty's move)
export function splitOf(t, { prices, beesPx, nifty } = {}) {
  const o = optionsPnl(t, prices);
  const m = t.snap?.mcc;
  let bees = null;
  let beesHow = null;
  if (m?.on && m.qty > 0 && m.price > 0) {
    if (m.exitPx > 0) [bees, beesHow] = [m.qty * (m.exitPx - m.price), 'sold'];
    else if (beesPx > 0) [bees, beesHow] = [m.qty * (beesPx - m.price), 'live'];
    else {
      const spots = (t.snap.legs || []).filter((l) => l.spotIn > 0).map((l) => l.spotIn);
      const s0 = spots.length ? spots.reduce((a, b) => a + b, 0) / spots.length : t.snap.spotEntry;
      if (nifty > 0 && s0 > 0) [bees, beesHow] = [m.qty * ((m.price * nifty) / s0 - m.price), 'est'];
    }
  }
  return { opt: o.total, optNow: o.now, bees, beesHow, overall: o.total == null ? null : o.total + (bees || 0), mcc: Boolean(m?.on), m };
}

// Capital to put the options on (the portal's payoff.js rule): margin of the shorts (about 9 % of notional per naked
// short lot, capped by the defined-risk loss) + premium of the longs
export function capital(legs, spot) {
  const intrinsic = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
  const q = (l) => l.lots * l.lot;
  const side = (type) => {
    const ls = legs.filter((l) => l.type === type);
    const shortQty = ls.filter((l) => l.action === 'S').reduce((a, l) => a + q(l), 0);
    if (!shortQty) return 0;
    let worst = 0;
    for (let k = 0.6; k <= 1.4001; k += 0.01) {
      const x = spot * k;
      worst = Math.min(worst, ls.reduce((a, l) => a + dir(l) * q(l) * (intrinsic(l, x) - l.entryPx), 0));
    }
    return Math.min(0.09 * spot * shortQty, -worst);
  };
  const ce = side('CE');
  const pe = side('PE');
  const margin = Math.max(ce, pe) + 0.3 * Math.min(ce, pe);
  const premium = legs.filter((l) => l.action === 'B').reduce((a, l) => a + l.entryPx * q(l), 0);
  return { margin, premium, total: margin + premium };
}

// ---------- dates ----------
export const todayIST = (now = Date.now()) => new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
const isoDay = (ms) => (ms > 0 ? new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10) : '');
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const wd = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- the ledger (public/ledger-view.js build) ----------
// opts: { scope 'live'|'paper'|'all', prices, beesPx, nifty, today }
export function buildLedger(trades, L0, opts = {}) {
  const L = { capital: Number(L0?.capital) || 0, capitalDate: L0?.capitalDate || null, rows: L0?.rows || {}, entries: L0?.entries || [], px: L0?.px || {}, reinvest: L0?.reinvest ?? true };
  const today = opts.today || todayIST();
  const scope = opts.scope || 'live';
  const pxNow = opts.beesPx > 0 ? opts.beesPx : null;
  const pxOf = (day) => {
    const k = L.px[day];
    if (k?.px > 0) return { px: k.px, how: k.src === 'user' ? 'your price' : 'close' };
    if (day >= today && pxNow) return { px: pxNow, how: 'live now' };
    return null;
  };
  const info = (t) => {
    const x = splitOf(t, opts);
    const u = t.summary || {};
    const legs = t.snap?.legs || [];
    const m = t.snap?.mcc;
    const ed = L.rows[t.id] || {};
    const open = u.open > 0;
    const opened = legs.map((l) => l.entryDay).filter(Boolean).sort()[0] || m?.day || isoDay(t.createdAt || t.savedAt);
    const lastExit = legs.map((l) => l.exitDay).filter(Boolean).sort().pop();
    const closedOn = open ? null : ed.closeDate || lastExit || isoDay(t.closedAt || t.savedAt);
    const lot = lotOf(t);
    const first = legs.filter((l) => (l.entryDay || opened) === opened);
    const spot = first.find((l) => l.spotIn > 0)?.spotIn || t.snap?.spotEntry || 0;
    const marginAuto = first.length && spot > 0 ? Math.round(capital(first.map((l) => ({ ...l, lot })), spot).total) : 0;
    const charges = num(ed.charges) ?? 0;
    const optAuto = x.opt == null ? null : x.opt - charges;
    const bees = m?.on && m.qty > 0 && m.price > 0 && !ed.beesHeld ? { qty: m.qty, price: m.price, day: m.day || opened, exitPx: m.exitPx > 0 ? m.exitPx : null, exitDay: m.exitDay || closedOn } : null;
    return {
      t, id: t.id, name: t.name, strategy: strategyOf(t) || (x.mcc ? 'Held against NIFTYBEES' : 'Options'), account: accountOf(t), open,
      opened: ed.date || opened, closedOn, margin: num(ed.margin) ?? marginAuto, marginAuto, charges, opt: num(ed.pnl) ?? optAuto, optNow: x.optNow, bees,
      edited: Object.keys(ed).filter((k) => ed[k] !== '' && ed[k] != null && ed[k] !== false), notes: ed.notes || '',
    };
  };
  const list = trades.filter((t) => scope === 'all' || accountOf(t) === scope).map(info);
  const ev = [];
  const add = (o) => ev.push(o);
  if (L.capital > 0) add({ date: L.capitalDate || '', ord: 0, kind: 'capital', cash: L.capital, title: 'Initial capital' });
  for (const tr of list) {
    if (tr.bees) add({ date: tr.bees.day || tr.opened, ord: 1, kind: 'buy', tr, buy: { qty: tr.bees.qty, price: tr.bees.price } });
    if (tr.margin > 0) add({ date: tr.opened, ord: 1.1, kind: 'margin', tr, margin: tr.margin });
    if (!tr.open && tr.closedOn) add({ date: tr.closedOn, ord: 0.8, kind: 'close', tr, pnl: tr.opt ?? 0, release: tr.margin });
    if (tr.bees?.exitPx > 0) add({ date: tr.bees.exitDay || tr.closedOn || today, ord: 0.5, kind: 'sell', tr, sell: { qty: tr.bees.qty, price: tr.bees.exitPx } });
  }
  for (const e of L.entries) {
    const amt = Math.abs(num(e.amount) ?? 0);
    const base = { date: e.date || '', entry: e, title: e.desc || 'Entry' };
    if (e.type === 'deposit') add({ ...base, ord: 0, kind: 'deposit', cash: amt, title: e.desc || 'Capital added' });
    else if (e.type === 'withdrawal') add({ ...base, ord: 5, kind: 'withdrawal', cash: -amt, title: e.desc || 'Capital withdrawn' });
    else if (e.type === 'charges') add({ ...base, ord: 0.9, kind: 'other', other: -amt, title: e.desc || 'Charges' });
    else if (e.type === 'other') add({ ...base, ord: 0.9, kind: 'other', other: num(e.pnl) ?? 0, title: e.desc || 'Other income / expense' });
    else if (e.type === 'trade') {
      const net = (num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0);
      const inv = Math.abs(num(e.invested) ?? 0);
      if (e.status === 'open') add({ ...base, ord: 1.1, kind: 'margin', margin: inv, openPnl: net, title: e.desc || 'Trade made elsewhere' });
      else add({ ...base, ord: 0.8, kind: 'close', pnl: net, release: 0, title: e.desc || 'Trade made elsewhere' });
    }
  }
  const cap = ev.find((e) => e.kind === 'capital' && !e.date);
  if (cap) cap.date = ev.map((e) => e.date).filter(Boolean).sort()[0] || today;
  ev.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.ord - b.ord);
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
      const r = { date: e.date, kind: 'reinvest', from: e };
      if (!p) {
        s.missing.push(e.date);
        Object.assign(r, { pending: true, cashAfter: s.cash, unitsAfter: s.units });
      } else {
        const q = Math.floor(e.pnl / p.px);
        const amt = q * p.px;
        s.cash -= amt;
        s.units += q;
        s.cost += amt;
        Object.assign(r, { buy: { qty: q, price: p.px }, beesAmt: amt, cashAfter: s.cash, unitsAfter: s.units });
      }
      out.push(r);
    }
  }
  const optOpen = list.filter((t) => t.open).reduce((a, t) => a + (t.opt || 0), 0) + L.entries.filter((e) => e.type === 'trade' && e.status === 'open').reduce((a, e) => a + (num(e.pnl) ?? 0) - Math.abs(num(e.charges) ?? 0), 0);
  const value = pxNow ? s.units * pxNow : null;
  const capitalNow = L.capital + s.dep - s.wd;
  const beesUnreal = value == null ? null : value - s.cost;
  const total = s.optBooked + optOpen + s.beesReal + (beesUnreal || 0) + s.other;
  const B = { L, events: out, trades: list, s, optOpen, px: pxNow, value, capital: capitalNow, beesUnreal, total, ret: capitalNow > 0 ? total / capitalNow : null, nOpen: list.filter((t) => t.open).length, today };
  B.lots = beesLots(B);
  return B;
}
// NIFTYBEES lots: bought with a trade, or with a trade's options profit; P&L when sold with its trade, else at the price now
export function beesLots(B) {
  const lots = [];
  for (const e of B.events) {
    if (e.kind === 'buy') {
      const sell = B.events.find((x) => x.kind === 'sell' && x.tr === e.tr);
      lots.push({ date: e.date, tr: e.tr, how: 'bought', qty: e.buy.qty, price: e.buy.price, amt: e.buy.qty * e.buy.price, sold: sell ? { date: sell.date, price: sell.sell.price } : null });
    } else if (e.kind === 'reinvest') {
      lots.push({ date: e.date, tr: e.from.tr, entry: e.from.entry, how: 'reinvest', pending: e.pending, from: e.from, qty: e.buy?.qty || 0, price: e.buy?.price || null, amt: e.beesAmt || 0, left: e.buy ? e.from.pnl - e.beesAmt : null });
    }
  }
  for (const l of lots) {
    if (l.sold) l.pnl = l.qty * (l.sold.price - l.price);
    else if (B.px && l.qty) l.pnl = l.qty * (B.px - l.price);
    else l.pnl = null;
  }
  return lots;
}

// ---------- the portfolio (public/portfolio-view.js model) ----------
export function optLegs(tr) {
  const legs = tr?.t?.snap?.legs || [];
  const ce = legs.filter((l) => l.type === 'CE').length;
  const pe = legs.filter((l) => l.type === 'PE').length;
  const lots = legs.reduce((a, l) => a + (Number(l.lots) || 0), 0);
  return { kinds: [ce ? 'CE' : '', pe ? 'PE' : ''].filter(Boolean).join(' + ') || 'CE + PE', ce, pe, lots, qty: lots * lotOf(tr?.t || {}) };
}
export function portfolio(B) {
  const L = B.L;
  const realEv = B.events.filter((e) => e.kind !== 'capital');
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
  const first = realEv.map((e) => e.date).filter(Boolean).sort()[0] || L.capitalDate || B.today;
  const s = { cash: base, units: 0, cost: 0, margin: 0, inv: base, realised: 0 };
  const steps = [];
  const rows = [{ date: first, action: capSet ? 'Initial investment' : 'Investment', tag: 'inv', inst: 'Capital', sub: capSet ? 'initial capital' : 'no capital set: the most ever invested', amount: base, value: base, total: 0 }];
  const px = {};
  for (const e of realEv) {
    const r = { date: e.date };
    if (e.kind === 'deposit' || e.kind === 'withdrawal') {
      s.cash += e.cash;
      s.inv += e.cash;
      Object.assign(r, { action: e.kind === 'deposit' ? 'Capital added' : 'Capital withdrawn', tag: e.kind === 'deposit' ? 'inv' : 'out', inst: 'Capital', sub: e.title, amount: e.cash, value: e.cash });
    } else if (e.kind === 'buy' || (e.kind === 'reinvest' && e.buy)) {
      s.cash -= e.beesAmt;
      s.units += e.buy.qty;
      s.cost += e.beesAmt;
      px[e.date] ??= e.buy.price;
      const re = e.kind === 'reinvest';
      Object.assign(r, { action: re ? 'Reinvest' : 'Buy', tag: re ? 're' : 'buy', inst: 'NIFTYBEES', sub: re ? `options profit of ${e.from.tr?.name || e.from.entry?.desc || 'a trade'}` : e.tr?.name, amount: e.beesAmt, qty: e.buy.qty, rate: e.buy.price, value: e.beesAmt });
    } else if (e.kind === 'reinvest') {
      Object.assign(r, { action: 'Reinvest', tag: 're', inst: 'NIFTYBEES', sub: 'waiting for the NIFTYBEES price of the day (set it on the portal Ledger)', pending: true });
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
      Object.assign(r, { action: 'Options closed', tag: 'trade', inst: `Options (${e.tr ? o.kinds : 'CE + PE'})`, sub: e.tr ? e.tr.name + (e.tr.charges ? ` · after ₹${Math.round(e.tr.charges)} charges` : '') : e.title, qty: e.tr ? o.qty : null, qtySub: e.tr ? `${o.lots} lots` : '', value: e.release || null, valueSub: e.release ? 'margin back' : '', real: e.pnl });
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
  const beesVal = B.px ? s.units * B.px : null;
  const value = s.cash + (beesVal ?? s.cost) + s.margin + B.optOpen;
  const pnl = value - s.inv;
  const beesPnl = B.lots.reduce((a, l) => a + (l.pnl || 0), 0);
  const reLots = B.lots.filter((l) => l.how === 'reinvest' && l.qty > 0);
  const openTr = B.trades.filter((x) => x.open);
  const t = B.today;
  if (s.units > 0) rows.push({ date: t, action: 'Holding', tag: 'hold', inst: 'NIFTYBEES', sub: B.px ? `${Math.round(s.units)} units at ₹${B.px.toFixed(2)} now` : 'no price now: at cost', qty: s.units, rate: B.px, value: beesVal ?? s.cost, real: beesVal == null ? null : beesVal - s.cost, realSub: 'unrealised', total: s.realised + (beesVal == null ? 0 : beesVal - s.cost) });
  if (openTr.length || s.margin > 0) {
    const o = openTr.map(optLegs);
    rows.push({ date: t, action: 'Open', tag: 'hold', inst: `Options (${[...new Set(o.flatMap((x) => x.kinds.split(' + ')))].join(' + ') || 'CE + PE'})`, sub: `${openTr.length} open: ${openTr.map((x) => x.name).join(', ')}`, qty: o.reduce((a, x) => a + x.qty, 0) || null, qtySub: `${o.reduce((a, x) => a + x.lots, 0)} lots`, value: s.margin + B.optOpen, valueSub: 'margin + P&L now', real: B.optOpen, realSub: 'open P&L' });
  }
  rows.push({ date: t, action: 'Current value', tag: 'now', inst: 'Portfolio', sub: 'cash + NIFTYBEES + options', value, total: pnl, last: true });
  const perTrade = B.trades
    .map((tr) => {
      const bees = B.lots.filter((l) => l.tr === tr).reduce((a, l) => a + (l.pnl || 0), 0);
      return { tr, name: tr.name, bees, opt: tr.opt || 0, total: bees + (tr.opt || 0), open: tr.open, opened: tr.opened };
    })
    .sort((a, b) => (a.opened || '').localeCompare(b.opened || ''));
  return { B, L, base, capSet, first, steps, rows, px, s, pxNow: B.px, beesVal, value, pnl, ret: s.inv > 0 ? pnl / s.inv : null, beesPnl, optPnl: B.s.optBooked + B.optOpen, reLots, openTr, perTrade };
}

// The growth curve: one point per trading day (thinned to ~150). closes: { day: NIFTYBEES close } (Upstox daily
// candles when logged in); else the ledger's price of the day, a price traded that day, or the last known.
export function growth(M, closes = {}) {
  const today = M.B.today;
  const days = [];
  for (let d = M.first; d <= today; d = addDays(d, 1)) if (wd(d) !== 0 && wd(d) !== 6) days.push(d);
  if (days[days.length - 1] !== today) days.push(today);
  const step = Math.max(1, Math.ceil(days.length / 150));
  const keep = new Set(M.steps.map((x) => x.date));
  const sample = days.filter((d, i) => i % step === 0 || keep.has(d) || i === days.length - 1);
  const known = (d) => (d === today && M.pxNow ? M.pxNow : closes[d] > 0 ? closes[d] : M.L.px?.[d]?.px > 0 ? M.L.px[d].px : M.px[d] > 0 ? M.px[d] : null);
  let last = null;
  let filled = 0;
  const pxs = sample.map((d) => {
    const k = known(d);
    if (k) last = k;
    else filled++;
    return k || last;
  });
  const firstKnown = pxs.find((v) => v > 0) || M.pxNow || 0;
  const pts = [];
  let i = -1;
  sample.forEach((d, j) => {
    while (i + 1 < M.steps.length && M.steps[i + 1].date <= d) i++;
    const st = i >= 0 ? M.steps[i] : { cash: M.base, units: 0, margin: 0, inv: M.base };
    const value = d === today ? M.value : st.cash + st.units * (pxs[j] || firstKnown) + st.margin;
    pts.push({ d, value, inv: st.inv, profit: value - st.inv });
  });
  return { pts, filled };
}
// Profit / loss per day, week or month over the last `days` (0: all): the change of the profit curve
export function buckets(pts, days, today) {
  const from = days ? addDays(today, -days) : pts[0]?.d;
  const span = Math.round((Date.parse(today) - Date.parse(from)) / 86400_000);
  const by = span <= 45 ? 'day' : span <= 140 ? 'week' : 'month';
  const key = (d) => (by === 'day' ? d : by === 'month' ? d.slice(0, 7) : addDays(d, -((wd(d) + 6) % 7)));
  const out = [];
  let prev = null;
  for (const p of pts) {
    if (p.d < from) {
      prev = p.profit;
      continue;
    }
    const k = key(p.d);
    let b = out[out.length - 1];
    if (!b || b.k !== k) out.push((b = { k, start: prev ?? 0, end: p.profit }));
    b.end = p.profit;
    prev = p.profit;
  }
  for (const b of out) b.v = b.end - b.start;
  return { list: out, by, from };
}
