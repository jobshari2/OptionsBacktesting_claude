// Trading Ideas › Covered call › Modified covered call: the live paper trade. Checked every 30 s by server.js; the
// same rules as the backtest (bt/mcc.js: legsAt, decide, apply, settle), priced from the live chain's LTP with the
// backtest's slippage and charges. Paper only: nothing here sends orders.
//   - Start opens the position at once on the current monthly series (the next monthly expiry; on a monthly expiry
//     day itself, the month after). After an expiry the next series opens at 09:30 on the next trading day.
//   - Adjustments are checked at the backtest's check times (15:00 daily, or hourly), once each, during market hours.
//   - Expiry: settled at Nifty's close of the expiry day (the cached history, else the last spot seen after 15:25).
//   - NIFTYBEES: params.budget (₹) sets how much is bought (else 65 × Nifty's worth); the options are not affected.
//     A budget changed while running buys (or sells) the difference in NIFTYBEES at once, at its price then (the
//     user's rule: the holding grows from the profits); between series, at the next series' entry.
const fs = require('fs');
const path = require('path');
const M = require('./bt/mcc');
const { istDate, istTime } = require('./lib/time');

const minuteNow = () => {
  const [h, m] = istTime().split(':').map(Number);
  return h * 60 + m - (9 * 60 + 15);
};
// Weekdays after `day` up to and including `expiry` (exchange holidays are not known here).
function weekdaysLeft(day, expiry) {
  let n = 0;
  for (let t = Date.parse(day + 'T00:00:00Z') + 86400_000; t <= Date.parse(expiry + 'T00:00:00Z'); t += 86400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd > 0 && wd < 6) n++;
  }
  return n;
}
// The monthly expiry the paper trade runs on from `today`: the last listed expiry of its month, skipping one fewer
// than minDays calendar days away (the user's rule: then the strategy is built on next month's strikes).
function monthlyFor(expiries, today, minDays = 0) {
  const last = new Map();
  for (const e of [...expiries].sort()) last.set(e.slice(0, 7), e);
  const daysTo = (e) => (Date.parse(e + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400_000;
  return [...last.values()].sort().find((e) => e > today && daysTo(e) >= minDays) || null;
}

function createMccPaper({ file, demo, isMarketOpen, getExpiries, getChain, closeOf, beesPrice, getLot, logError = () => {} }) {
  let st = { paper: null };
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  let busy = false;
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
  };
  const quote = (chain) => {
    const rows = new Map(chain.rows.map((r) => [r.strike, r]));
    return (type, strike) => {
      const r = rows.get(strike);
      const v = r?.[type === 'CE' ? 'ce' : 'pe']?.ltp;
      return v > 0 ? v : null;
    };
  };
  const bookOf = (P, c) => ({
    slip: P.params.costs.slipPct / 100,
    brokerage: P.params.costs.brokerage,
    taxes: P.params.costs.taxes,
    lot: P.params.lotSize,
    day: istDate(),
    cash: c.cash,
    costs: c.costs,
    costsBy: { CE: 0, PE: 0, ...(c.costsBy || {}) },
  });
  const keep = (c, book) => {
    c.cash = book.cash;
    c.costs = book.costs;
    c.costsBy = book.costsBy;
  };
  const etfPx = async (P, spot) => {
    if (P.params.etf === 'real' && !demo) {
      const v = await beesPrice().catch(() => null);
      if (v > 0) return v;
    }
    return spot / 100;
  };

  async function openCycle(P) {
    const today = istDate();
    // under minDays (15) calendar days left in this month's series: next month's (a paper trade from before the rule too)
    const expiry = monthlyFor(await getExpiries(), today, P.params.minDays ?? M.DEFAULTS.minDays);
    if (!expiry) throw new Error('No monthly expiry listed');
    const chain = await getChain(expiry);
    const S = chain?.spot;
    if (!(S > 0) || !chain.rows?.length) throw new Error('No live chain for ' + expiry);
    // a paper trade started before the ideal trade existed builds it from its next series on (the user's rule)
    P.params.target ||= { ...M.DEFAULTS.target };
    const p = P.params;
    const pos = M.newPosition(expiry, S);
    const book = bookOf(P, { cash: 0, costs: 0 });
    const at = { day: today, time: istTime().slice(0, 5) };
    // the ideal trade (params.target): strikes and gaps picked on this chain; the series rolls with that shape
    const pick = M.pickLegs(
      S,
      p,
      chain.rows.map((r) => r.strike),
      quote(chain),
      p.lotSize,
    );
    const legs = pick.legs;
    if (!M.openLegs(pos, legs, quote(chain), book, at)) throw new Error('A leg has no price yet: ' + legs.map((l) => l.strike + l.type).join(', '));
    const b0 = await etfPx(P, S);
    const qty = M.etfQty(p, S, b0);
    const etfSlip = p.costs.etfSlipPct / 100;
    const first = !P.etfOnce;
    if (first) P.etfOnce = { qty, b0, last: b0, cost: M.etfCost(qty * b0, true, etfSlip), budget: p.budget || qty * b0 };
    // a budget changed between series: the held NIFTYBEES grows (or shrinks) by the difference at this entry's price
    const topUp = first ? null : toBudget(P, b0, null);
    P.cycle = {
      ...pos,
      spot0: S,
      entry: { ...at, spot: S },
      cash: book.cash,
      costs: book.costs,
      costsBy: book.costsBy,
      // onceCost: the held NIFTYBEES' charges in this series (its first purchase, or a budget's top-up)
      etf: {
        qtyMonthly: qty,
        b0,
        cost: M.etfCost(qty * b0, true, etfSlip),
        onceFrom: P.etfOnce.last,
        firstOnce: !P.months.length,
        onceCost: first ? P.etfOnce.cost : topUp?.cost || 0,
        topUp,
      },
      checks: [],
      shape: pick.shape, // null: the fixed distances of the settings
      events: [
        {
          ...at,
          kind: 'entry',
          spot: S,
          text:
            'Opened ' +
            pos.legs.map((l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} ${l.type} @${l.entry.toFixed(1)}`).join(' · ') +
            (pick.shape ? ' · ' + M.shapeText(pick.shape, p.target.amount) : ''),
        },
      ],
    };
    if (topUp) P.cycle.events.push(budgetEvent(P, topUp, at, S));
    P.next = null;
    mark(P, chain, b0);
  }

  const onceCost = (P, c) => c.etf.onceCost ?? (c.etf.firstOnce ? P.etfOnce.cost : 0);

  // The NIFTYBEES brought to params.budget: the difference bought (or sold) at price b. Returns { units, b, cost, from,
  // to } or null. Inside a running series (c) the rebought NIFTYBEES changes too, and the units added count from b, not
  // from the series' start: onceAdj / monthlyAdj = units × (start price − b), so qty × (price − start) + adj is right.
  function toBudget(P, b, c) {
    const p = P.params;
    const had = P.etfOnce.budget ?? P.etfOnce.qty * P.etfOnce.b0; // a paper trade from before the budget: what it bought
    if (!(p.budget > 0) || p.budget === had || !(b > 0)) return null;
    const units = Math.round((p.budget - had) / b);
    if (!units || P.etfOnce.qty + units <= 0 || (c && c.etf.qtyMonthly + units <= 0)) return null;
    const cost = M.etfCost(Math.abs(units) * b, units > 0, p.costs.etfSlipPct / 100);
    P.etfOnce.budget = p.budget;
    P.etfOnce.qty += units;
    if (c) {
      c.etf.onceAdj = (c.etf.onceAdj || 0) + units * (c.etf.onceFrom - b);
      c.etf.onceCost = onceCost(P, c) + cost;
      c.etf.qtyMonthly += units;
      c.etf.monthlyAdj = (c.etf.monthlyAdj || 0) + units * (c.etf.b0 - b);
      c.etf.cost += cost;
    }
    return { units, b, cost, from: had, to: p.budget };
  }
  const budgetEvent = (P, t, at, spot) => ({
    ...at,
    kind: 'budget',
    spot,
    text: `NIFTYBEES budget ₹${Math.round(t.from).toLocaleString('en-IN')} → ₹${t.to.toLocaleString('en-IN')}: ${t.units > 0 ? 'bought' : 'sold'} ${Math.abs(t.units)} units @₹${t.b.toFixed(2)}, now ${P.etfOnce.qty} held`,
  });
  // A budget not yet applied to the running series: applied now at NIFTYBEES' price (live, or Nifty ÷ 100).
  async function applyBudget(P) {
    const c = P.cycle;
    if (!c || !(P.params.budget > 0) || P.params.budget === (P.etfOnce.budget ?? P.etfOnce.qty * P.etfOnce.b0)) return false; // nothing pending
    const spot = c.spot || c.spot0;
    const b = await etfPx(P, spot);
    const t = toBudget(P, b, c);
    if (!t) return false;
    c.events.push(budgetEvent(P, t, { day: istDate(), time: istTime().slice(0, 5) }, spot));
    markEtf(P, c, b);
    return true;
  }
  function markEtf(P, c, bees) {
    c.bees = bees;
    c.etfMonthly = Math.round(c.etf.qtyMonthly * (bees - c.etf.b0) + (c.etf.monthlyAdj || 0) - c.etf.cost);
    c.etfOnce = Math.round(P.etfOnce.qty * (bees - c.etf.onceFrom) + (c.etf.onceAdj || 0) - onceCost(P, c));
  }

  // The running cycle valued now: options P&L if closed at the LTPs (no exit costs), ETF marked.
  function mark(P, chain, bees) {
    const c = P.cycle;
    const px = quote(chain);
    let open = 0;
    let priced = true;
    const openBy = { CE: 0, PE: 0 };
    for (const l of c.legs) {
      const v = px(l.type, l.strike);
      l.ltp = v;
      if (v == null) priced = false;
      else {
        open += l.side * v * l.lots * P.params.lotSize;
        openBy[l.type] += l.side * (v - l.entry) * l.lots * P.params.lotSize;
      }
    }
    c.spot = chain.spot;
    c.markAt = Date.now();
    c.opt = Math.round(c.cash + open - c.costs);
    // each structure: its legs closed by rolls + its open legs at LTP − its costs
    const closedBy = (t) => c.closed.filter((x) => x.type === t).reduce((s, x) => s + x.pnl, 0);
    c.callPnl = Math.round(closedBy('CE') + openBy.CE - (c.costsBy?.CE || 0));
    c.putPnl = Math.round(closedBy('PE') + openBy.PE - (c.costsBy?.PE || 0));
    c.priced = priced;
    if (bees > 0) markEtf(P, c, bees);
  }

  async function settleCycle(P, S) {
    const c = P.cycle;
    const p = P.params;
    const book = bookOf(P, c);
    book.day = c.expiry;
    const at = { day: c.expiry, time: '15:30' };
    const final = c.legs.map((l) => ({ ...l }));
    M.settle(c, S, book, at);
    keep(c, book);
    c.events.push({ ...at, kind: 'expiry', spot: S, text: `Expiry at Nifty ${S.toFixed(0)}` });
    const bE = p.etf === 'real' && !demo ? (await beesPrice().catch(() => null)) || S / 100 : S / 100;
    const etfSlip = p.costs.etfSlipPct / 100;
    const etfMonthly = c.etf.qtyMonthly * (bE - c.etf.b0) + (c.etf.monthlyAdj || 0) - c.etf.cost - M.etfCost(c.etf.qtyMonthly * bE, false, etfSlip);
    const etfOnce = P.etfOnce.qty * (bE - c.etf.onceFrom) + (c.etf.onceAdj || 0) - onceCost(P, c);
    P.etfOnce.last = bE;
    const opt = Math.round(c.cash - c.costs);
    P.months.push({
      expiry: c.expiry,
      ok: true,
      entry: c.entry,
      spot0: c.spot0,
      spotE: S,
      move: ((S - c.spot0) / c.spot0) * 100,
      finalLegs: final,
      closed: c.closed,
      events: c.events,
      adjustments: c.events.filter((e) => !['entry', 'expiry', 'skip'].includes(e.kind)).length,
      gross: Math.round(c.cash),
      costs: Math.round(c.costs),
      opt,
      ...(({ call, put }) => ({ callPnl: call, putPnl: put }))(M.splitPnl(c.closed, book)),
      etfOnce: Math.round(etfOnce),
      etfMonthly: Math.round(etfMonthly),
      withOnce: Math.round(opt + etfOnce),
      withMonthly: Math.round(opt + etfMonthly),
    });
    P.cycle = null;
    P.next = 'open'; // the next series opens on the next trading day at the entry time
    P.lastExpiry = c.expiry;
  }

  async function tick() {
    const P = st.paper;
    if (!P || P.status !== 'running' || busy) return;
    busy = true;
    try {
      const today = istDate();
      const m = minuteNow();
      const c = P.cycle;
      if (c) {
        // expiry: after the close of the expiry day (or any later day, e.g. the server was off)
        if (today > c.expiry || (today === c.expiry && m >= 375)) {
          let S = await closeOf(c.expiry).catch(() => null);
          if (!(S > 0) && c.lastSpotDay === c.expiry && c.lastSpotMin >= 370) S = c.spot;
          if (S > 0) {
            await settleCycle(P, S);
            save();
          }
          return;
        }
        if (await applyBudget(P)) save();
        if (!isMarketOpen()) return;
        const chain = await getChain(c.expiry);
        if (!(chain?.spot > 0)) return;
        const bees = await etfPx(P, chain.spot);
        mark(P, chain, bees);
        c.lastSpotDay = today;
        c.lastSpotMin = m;
        // adjustment checks: each check time once a day
        const mins = M.CHECK_MINS[P.params.adj.check] || M.CHECK_MINS.close;
        const due = mins.filter((x) => x <= m && !c.checks.includes(today + '|' + x));
        if (due.length) {
          for (const x of due) c.checks.push(today + '|' + x);
          c.checks = c.checks.slice(-40);
          const px = quote(chain);
          const strikes = chain.rows.map((r) => r.strike);
          const acts = M.decide(
            c,
            chain.spot,
            { daysLeft: weekdaysLeft(today, c.expiry), strikes, px: (l) => px(l.type, l.strike) },
            M.withShape(P.params, c.shape),
          );
          const book = bookOf(P, c);
          const at = { day: today, time: istTime().slice(0, 5) };
          for (const a of acts) {
            if (M.apply(c, a, px, book, at)) c.events.push({ ...at, kind: a.kind, spot: chain.spot, text: a.reason });
            else c.events.push({ ...at, kind: 'skip', spot: chain.spot, text: a.reason + ' — not done: a strike has no price now' });
          }
          keep(c, book);
          mark(P, chain, bees);
        }
        save();
        return;
      }
      // between series: open the next one at the entry time of a market day after the last expiry
      if (P.next === 'open' && isMarketOpen() && today > (P.lastExpiry || '') && m >= P.params.entryMin) {
        await openCycle(P);
        save();
      }
    } catch (e) {
      P.lastError = { at: Date.now(), message: e.message };
      logError('mcc-paper', e);
    } finally {
      busy = false;
    }
  }

  return {
    state: () => ({ paper: st.paper, marketOpen: isMarketOpen(), lot: getLot?.() || null }),
    async start(params) {
      const p = M.merge(params);
      p.lotSize = getLot?.() || p.lotSize;
      st.paper = { params: p, status: 'running', startedAt: Date.now(), months: [], cycle: null, etfOnce: null, next: null };
      await openCycle(st.paper);
      save();
    },
    pause() {
      if (st.paper) st.paper.status = 'paused';
      save();
    },
    async resume() {
      if (st.paper) st.paper.status = 'running';
      save();
      await tick();
    },
    // the NIFTYBEES budget (₹; 0 = leave the NIFTYBEES as they are): the difference is bought or sold now in the
    // running series, else at the next series' entry
    async setBudget(budget) {
      if (!st.paper) throw new Error('No paper trade running');
      const b = Number(budget) || 0;
      if (b < 0) throw new Error('The budget cannot be negative');
      st.paper.params.budget = b;
      await applyBudget(st.paper);
      save();
    },
    reset() {
      st.paper = null;
      save();
    },
    tick,
  };
}

module.exports = { createMccPaper, monthlyFor, weekdaysLeft };
