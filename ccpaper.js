// Live paper trade of the covered call (Trading Ideas › Covered call › Paper trade): the rules of bt/coveredcall.js
// followed on the live option chain, checked every 30 s while the market is open. Paper only: it never places an order.
//   - First check at or after the entry time: NIFTYBEES is "bought" (lots × lot × Nifty ÷ its LTP, valued at its LTP from
//     then on; when its quote can't be read it is modelled from Nifty with the last known ratio), the monthly call sold
//     and the insurance bought, on the first monthly expiry at least `minDays` away.
//   - Every weekly series up to that monthly expiry: the contra spread for where Nifty is (put spread above the call's
//     breakeven, call spread under the lower trigger, iron condor in between), opened once per series, never on its
//     expiry day.
//   - Expiries settle at their intrinsic value: at 15:25 on the day, or, when the server was not running then, at that
//     day's Nifty close from the history cache. After the monthly expiry the holding's profit is booked / the option
//     profit reinvested as in the backtest, and the next month starts the next session.
// Fills are the LTP (the bid / ask mid when there is no trade) with the strategy's slippage; charges as in the backtest.
// The whole state is kept in one JSON file, so a restart carries on where it stopped.
const fs = require('fs');
const path = require('path');
const CC = require('./bt/coveredcall');
const { istDate, istTime } = require('./lib/time');

const SETTLE_AT = '15:25';
const LAST_ENTRY = '15:20';
const MAX_LOG = 500;

const r2 = (x) => Math.round(x * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const inr = (x) => (x < 0 ? '−' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN');
const signed = (x) => (x >= 0 ? '+' : '') + inr(x);

// getExpiries(): live expiries, ascending; getChain(expiry): { spot, rows: [{ strike, ce, pe }] } of a live expiry;
// closeOf(day) / beesCloseOf(day): Nifty's / NIFTYBEES's close on a past day (or null); beesPrice(): NIFTYBEES LTP (or
// null); getLot(): today's lot.
function createCcPaper({
  file,
  demo = false,
  isMarketOpen,
  getExpiries,
  getChain,
  closeOf,
  beesCloseOf = async () => null,
  beesPrice = async () => null,
  getLot = () => 65,
  logError = () => {},
}) {
  let st = load();
  let busy = false;
  let live = null; // marks of the last check: { at, spot, regime, legs, mtm, eq, bh, opt, margin }
  let lastError = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j.v === 2 ? j : null; // v1 held "Nifty units" instead of NIFTYBEES
    } catch {
      return null;
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!st) return fs.rmSync(file, { force: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(st));
    fs.renameSync(file + '.tmp', file);
  }
  function log(kind, text, at = Date.now()) {
    st.log.push({ t: at, kind, text });
    if (st.log.length > MAX_LOG) st.log.splice(0, st.log.length - MAX_LOG);
  }

  // ---------- prices from the chain ----------
  function priceOf(chain, strike, type) {
    const o = chain?.rows?.find((r) => r.strike === strike)?.[type === 'CE' ? 'ce' : 'pe'];
    if (!o) return null;
    if (o.ltp > 0) return o.ltp;
    return o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : null;
  }
  // The listed strike nearest the target with a price, up to `reach` points away.
  function pick(chain, target, type, reach) {
    const ks = (chain?.rows || [])
      .map((r) => r.strike)
      .filter((k) => Math.abs(k - target) <= reach)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    for (const k of ks) {
      const px = priceOf(chain, k, type);
      if (px != null) return { strike: k, px };
    }
    return null;
  }
  async function openLegs(want, expiry, qty, reach, day) {
    const chain = await getChain(expiry);
    const p = st.params;
    const legs = [];
    for (const l of want) {
      const got = pick(chain, l.strike, l.type, reach);
      if (!got) throw new Error(`no live price for ${l.strike} ${l.type} (${expiry})`);
      legs.push({
        id: `${expiry}|${got.strike}|${l.type}|${l.side}`,
        expiry,
        type: l.type,
        side: l.side,
        strike: got.strike,
        qty: qty * l.mult,
        mkt: got.px,
        entry: CC.fillPx(got.px, l.side, p.costs.slippage),
        entryAt: Date.now(),
      });
    }
    return { legs, cost: CC.orderCost(legs, 'entry', day, p.costs.brokerage) };
  }
  const credit = (legs, qty) => r2(legs.reduce((s, l) => s + (l.side === 'S' ? l.entry : -l.entry) * l.qty, 0) / qty);

  // NIFTYBEES now: its LTP, else Nifty × the last known ETF / Nifty ratio. An index fund: its modelled NAV.
  async function beesNow(spot) {
    if (st.params.hold?.kind === 'mf') return { px: CC.mfNav(spot, st.params.hold, istDate(st.startedAt), istDate()), real: false, nav: true };
    const px = await beesPrice().catch(() => null);
    if (px > 0) {
      st.beesRatio = px / spot;
      return { px, real: true };
    }
    return { px: r2(spot * (st.beesRatio ?? CC.BEES_RATIO)), real: false };
  }

  // ---------- the month ----------
  function monthlies(expiries) {
    const last = new Map();
    for (const e of expiries) last.set(e.slice(0, 7), e);
    return [...last.values()];
  }

  async function startCycle(today, spot, bees, expiries) {
    const p = st.params;
    const E = monthlies(expiries).find((e) => daysBetween(today, e) >= p.minDays);
    if (!E) throw new Error(`no monthly expiry at least ${p.minDays} days away in the live list`);
    const units = p.lots * p.lotSize;
    const h = st.holding;
    if (!h.qty) {
      h.qty = st.qty0 = Math.max(1, Math.round((units * spot) / bees.px));
      h.cost = h.qty * bees.px;
      st.initialCost = h.cost;
      st.spot0 = spot;
      st.bees0 = bees.px;
      st.bhCost = h.cost * (p.costs.etfPct / 100);
      st.cash -= st.bhCost;
      log(
        'hold',
        `Bought (paper) ${h.qty.toLocaleString('en-IN')} ${bees.nav ? 'units of the ' + CC.holdName(p) : 'NIFTYBEES'} at ₹${bees.px.toFixed(2)}${bees.nav ? ' (modelled NAV)' : bees.real ? '' : ' (modelled: no NIFTYBEES quote)'} = ${inr(h.cost)} (covers ${units} Nifty units at Nifty ${spot.toFixed(0)})`,
      );
    }
    const cyc = {
      optStart: st.optCum, // the option P&L before this month, to tell its own
      n: st.cycles.length + 1,
      expiry: E,
      start: today,
      spotIn: spot,
      beesIn: bees.px,
      qtyIn: h.qty,
      call: null,
      ins: [],
      ovl: null,
      weeks: [],
      costs: 0,
      notes: [],
    };
    cyc.lower = spot * (1 - p.ovl.lowerPct / 100);
    const co = await openLegs([{ type: 'CE', side: 'S', strike: CC.callTarget(spot, p.call), mult: 1 }], E, units, 300, today);
    cyc.call = co.legs[0];
    cyc.callBE = cyc.call.strike + cyc.call.entry;
    cyc.costs += co.cost;
    st.cash -= co.cost;
    st.optCum -= co.cost;
    log('call', `Sold ${cyc.call.strike} CE (${E}) at ${cyc.call.entry.toFixed(1)} (LTP ${cyc.call.mkt}), breakeven ${cyc.callBE.toFixed(0)}`);
    st.cycle = cyc;
    await buyInsurance(today, spot);
  }

  // The month's insurance under spot. When a strike has no price it is tried again at every check of the month (the
  // first failure is logged).
  async function buyInsurance(today, spot) {
    const p = st.params;
    const cyc = st.cycle;
    const units = p.lots * p.lotSize;
    const want = CC.insuranceLegs(spot, p.ins);
    if (!want.length || cyc.ins.length || today >= cyc.expiry) return;
    try {
      const io = await openLegs(want, cyc.expiry, units, 200, today);
      cyc.ins = io.legs;
      cyc.costs += io.cost;
      st.cash -= io.cost;
      st.optCum -= io.cost;
      log(
        'ins',
        `${p.ins.kind === 'debit' ? 'Put debit spread' : 'Put butterfly'} ${io.legs.map((l) => l.strike).join(' / ')} for ${(-credit(io.legs, units)).toFixed(1)} debit`,
      );
    } catch (e) {
      if (!cyc.insFailed) log('skip', 'Insurance not bought yet (tried again at every check): ' + e.message);
      cyc.insFailed = e.message;
    }
  }

  // The optional roll up (roll.upPct, off in the threads' rules): Nifty this % over the call's breakeven, at most maxUp
  // times a month and not in its last 3 days: buy the call back and sell the rule's strike from the spot now.
  async function maybeRollUp(today, spot) {
    const p = st.params;
    const cyc = st.cycle;
    const rolls = (cyc.rolls ||= []);
    if (p.roll.upPct == null || rolls.length >= p.roll.maxUp || daysBetween(today, cyc.expiry) < 3) return;
    if (!(spot > cyc.callBE * (1 + p.roll.upPct / 100))) return;
    const k = CC.callTarget(spot, p.call);
    if (k <= cyc.call.strike) return;
    const chain = await getChain(cyc.expiry);
    const backPx = priceOf(chain, cyc.call.strike, 'CE');
    if (backPx == null) return;
    const units = p.lots * p.lotSize;
    const nu = await openLegs([{ type: 'CE', side: 'S', strike: k, mult: 1 }], cyc.expiry, units, 300, today);
    const old = cyc.call;
    old.exit = CC.fillPx(backPx, 'S', p.costs.slippage, false);
    old.exitAt = Date.now();
    const closeCost = CC.orderCost([{ side: 'B', qty: old.qty, x: old.exit }], 'x', today, p.costs.brokerage);
    const realized = CC.legPnl(old, old.exit);
    cyc.callRealized = (cyc.callRealized || 0) + realized;
    st.cash += realized - closeCost - nu.cost;
    st.optCum += realized - closeCost - nu.cost;
    cyc.costs += closeCost + nu.cost;
    (cyc.closedCalls ||= []).push(old);
    cyc.call = nu.legs[0];
    rolls.push({
      day: today,
      spot: r2(spot),
      from: { strike: old.strike, entry: old.entry, exit: old.exit },
      to: { strike: cyc.call.strike, entry: cyc.call.entry },
      pnl: Math.round(realized),
    });
    log(
      'roll',
      `Nifty ${spot.toFixed(0)} is over the ${cyc.callBE.toFixed(0)} breakeven: bought back ${old.strike} CE at ${old.exit.toFixed(1)} (${signed(realized)}) and sold ${cyc.call.strike} CE at ${cyc.call.entry.toFixed(1)}`,
    );
    cyc.callBE = cyc.call.strike + cyc.call.entry;
  }

  async function maybeOverlay(today, spot, expiries) {
    const p = st.params;
    const cyc = st.cycle;
    const W = expiries.find((e) => e > today);
    if (!W || W > cyc.expiry || cyc.weeks.some((w) => w.expiry === W)) return;
    const regime = CC.regimeOf(spot, cyc);
    const qty = p.ovl.lots * p.lotSize;
    const week = { expiry: W, entry: today, regime, spot: r2(spot) };
    try {
      const oo = await openLegs(CC.overlayLegs(spot, regime, p.ovl), W, qty, 100, today);
      const cr = credit(oo.legs, qty);
      if (cr < p.ovl.minCredit) week.skipped = `credit ${cr.toFixed(1)} under the minimum ${p.ovl.minCredit}`;
      else {
        Object.assign(week, { legs: oo.legs, credit: cr, costs: oo.cost });
        cyc.costs += oo.cost;
        st.cash -= oo.cost;
        st.optCum -= oo.cost;
        cyc.ovl = week;
        const kind = regime === 'up' ? 'Put credit spread' : regime === 'down' ? 'Call credit spread' : 'Iron condor';
        log(
          'ovl',
          `Nifty ${spot.toFixed(0)} ${CC.REGIME_TEXT[regime]}: ${kind} ${oo.legs.map((l) => l.strike + ' ' + l.type).join(' / ')} (${W}) for ${cr.toFixed(1)} credit`,
        );
      }
    } catch (e) {
      week.skipped = e.message;
    }
    if (week.skipped) {
      log('skip', `Weekly overlay (${W}) skipped: ${week.skipped}`);
      cyc.weeks.push(week);
    }
  }

  // Settles legs at `spot` (their expiry close): returns the P&L and the STT on bought ones ending in the money.
  function settleLegs(legs, spot, day) {
    for (const l of legs) {
      l.exit = CC.intrinsic(l.type, l.strike, spot);
      l.exitAt = Date.now();
    }
    return { pnl: legs.reduce((s, l) => s + CC.legPnl(l, l.exit), 0), cost: CC.expiryCost(legs, spot, day) };
  }
  // The expiry close of `day`: now when it is today after 15:25, else the cached history (or the last spot seen).
  async function expirySpot(day, today, hhmm, spot) {
    if (day === today && spot) return { spot, how: 'at ' + hhmm };
    const c = await closeOf(day).catch(() => null);
    if (c) return { spot: c, how: "at that day's close" };
    return st.lastSpot ? { spot: st.lastSpot, how: 'at the last Nifty seen (the close was not available)' } : null;
  }
  async function expiryBees(day, today, sc, bees) {
    if (st.params.hold?.kind === 'mf') return CC.mfNav(sc, st.params.hold, istDate(st.startedAt), day);
    if (day === today && bees) return bees.px;
    const c = await beesCloseOf(day).catch(() => null);
    return c > 0 ? c : r2(sc * (st.beesRatio ?? CC.BEES_RATIO));
  }
  async function settleDue(today, hhmm, spot, bees) {
    const cyc = st.cycle;
    if (!cyc) return;
    const due = (e) => e < today || (e === today && hhmm >= SETTLE_AT && spot);
    const p = st.params;
    if (cyc.ovl && due(cyc.ovl.expiry)) {
      const x = await expirySpot(cyc.ovl.expiry, today, hhmm, spot);
      if (!x) return;
      const w = cyc.ovl;
      const s = settleLegs(w.legs, x.spot, w.expiry);
      w.pnl = Math.round(s.pnl - w.costs - s.cost);
      w.costs += s.cost;
      w.spotOut = r2(x.spot);
      cyc.costs += s.cost;
      st.cash += s.pnl - s.cost;
      st.optCum += s.pnl - s.cost;
      cyc.weeks.push(w);
      cyc.ovl = null;
      log('ovl-exp', `Weekly spread (${w.expiry}) settled ${x.how}, Nifty ${x.spot.toFixed(0)}: ${signed(w.pnl)} after charges`);
    }
    if (!due(cyc.expiry)) return;
    const x = await expirySpot(cyc.expiry, today, hhmm, spot);
    if (!x) return;
    const sc = x.spot;
    const bc = await expiryBees(cyc.expiry, today, sc, bees);
    const sCall = settleLegs(cyc.call ? [cyc.call] : [], sc, cyc.expiry);
    const sIns = settleLegs(cyc.ins, sc, cyc.expiry);
    const net = sCall.pnl + sIns.pnl - sCall.cost - sIns.cost;
    st.cash += net;
    st.optCum += net;
    cyc.costs += sCall.cost + sIns.cost;
    Object.assign(cyc, { spotOut: r2(sc), beesOut: r2(bc), callPnl: Math.round(sCall.pnl + (cyc.callRealized || 0)), insPnl: Math.round(sIns.pnl) });
    cyc.ovlPnl = Math.round(cyc.weeks.reduce((s, w) => s + (w.legs ? w.pnl + w.costs : 0), 0));
    cyc.optNet = Math.round(cyc.callPnl + cyc.insPnl + cyc.ovlPnl - cyc.costs);
    cyc.holdChange = Math.round(cyc.qtyIn * (bc - cyc.beesIn));
    let holdCosts = 0;
    log(
      'exp',
      `Monthly expiry ${cyc.expiry} settled ${x.how}, Nifty ${sc.toFixed(0)}: call ${signed(sCall.pnl)}` +
        (cyc.ins.length ? `, insurance ${signed(sIns.pnl)}` : ''),
    );
    const mf = p.hold?.kind === 'mf';
    const etf = (mf ? CC.MF_STAMP_PCT : p.costs.etfPct) / 100;
    const h = st.holding;
    if (p.roll.bookAbove && !mf && cyc.call && sc > cyc.call.strike && bc * h.qty > h.cost) {
      const gain = bc * h.qty - h.cost;
      const c = 2 * bc * h.qty * etf;
      h.booked += gain;
      h.cost = bc * h.qty;
      st.cash -= c;
      cyc.costs += c;
      holdCosts += c;
      cyc.booked = Math.round(gain);
      log(
        'book',
        `Nifty closed above the ${cyc.call.strike} strike: booked the ${CC.holdName(p)} profit ${inr(gain)} (sold and bought back ${h.qty.toLocaleString('en-IN')} at ₹${bc.toFixed(2)})`,
      );
    }
    const re = p.roll.reinvest;
    const add = Math.floor(cyc.optNet / bc);
    if (add > 0 && (re === 'always' || (re === 'below' && sc < cyc.spotIn))) {
      const amt = add * bc;
      h.qty += add;
      h.cost += amt;
      h.reinvested += amt;
      st.cash -= amt + amt * etf;
      cyc.costs += amt * etf;
      holdCosts += amt * etf;
      cyc.reinvested = Math.round(amt);
      cyc.reinvestQty = add;
      log(
        'reinvest',
        `Reinvested the month's option profit: bought ${add.toLocaleString('en-IN')} more ${mf ? 'units of the ' + CC.holdName(p) : 'NIFTYBEES'} at ₹${bc.toFixed(2)} (${inr(amt)}), now ${h.qty.toLocaleString('en-IN')}`,
      );
    }
    cyc.qty = h.qty;
    cyc.holdPnl = Math.round(cyc.holdChange - holdCosts);
    cyc.total = cyc.optNet + cyc.holdPnl;
    cyc.costs = Math.round(cyc.costs);
    st.cycles.push(cyc);
    st.lastExpiry = cyc.expiry;
    st.cycle = null;
  }

  // ---------- marks ----------
  async function mark(today, spot, bees) {
    const cyc = st.cycle;
    const legs = cyc ? [cyc.call, ...cyc.ins, ...(cyc.ovl ? cyc.ovl.legs : [])].filter(Boolean) : [];
    const chains = new Map();
    for (const e of new Set(legs.map((l) => l.expiry))) chains.set(e, await getChain(e).catch(() => null));
    let mtm = 0;
    const marks = legs.map((l) => {
      const ltp = priceOf(chains.get(l.expiry), l.strike, l.type);
      const px = ltp ?? CC.intrinsic(l.type, l.strike, spot);
      const pnl = CC.legPnl(l, px);
      mtm += pnl;
      return { id: l.id, ltp: ltp == null ? null : r2(ltp), pnl: Math.round(pnl) };
    });
    const h = st.holding;
    const eq = Math.round(st.cash + h.qty * bees.px - st.initialCost + mtm);
    const bh = Math.round(st.qty0 * (bees.px - st.bees0) - st.bhCost);
    const opt = Math.round(st.optCum + mtm);
    // this month alone: its options (settled weekly spreads, open legs, charges) and its NIFTYBEES move since its entry
    const mOpt = cyc ? Math.round(st.optCum - (cyc.optStart ?? 0) + mtm) : null;
    const mHold = cyc ? Math.round(cyc.qtyIn * (bees.px - cyc.beesIn)) : null;
    live = {
      month: cyc ? { expiry: cyc.expiry, opt: mOpt, hold: mHold, total: mOpt + mHold } : null,
      at: Date.now(),
      spot: r2(spot),
      bees: { px: r2(bees.px), real: bees.real },
      regime: cyc?.call ? CC.regimeOf(spot, cyc) : null,
      legs: marks,
      mtm: Math.round(mtm),
      eq,
      bh,
      opt,
      hold: eq - opt, // NIFTYBEES's part of the P&L (its move, booking and charges)
      holdOpen: Math.round(h.qty * bees.px - h.cost), // on the NIFTYBEES held now, against its cost
      margin: CC.marginEstimate([[cyc?.call], cyc?.ins || [], cyc?.ovl?.legs || []], spot, h.qty * bees.px),
    };
    st.lastLive = live; // kept with the trade, so the P&L shows after a restart or the close until the next check
    const lastEq = st.equity[st.equity.length - 1];
    const point = { d: today, eq, bh, opt, hold: eq - opt, s: r2(spot), b: r2(bees.px) };
    if (lastEq?.d === today) Object.assign(lastEq, point);
    else st.equity.push(point);
  }

  // ---------- the check ----------
  async function tick(now = Date.now()) {
    if (!st || st.status !== 'running' || busy) return;
    busy = true;
    try {
      const today = istDate(now);
      const hhmm = istTime(now).slice(0, 5);
      const open = demo || isMarketOpen(now);
      // outside market hours nothing is traded, but a position nobody has marked since the server started is marked
      // once at the chain's last prices
      const markOnly = !open && !live && Boolean(st.cycle);
      const expiries = open || markOnly ? await getExpiries() : [];
      const chain = (open || markOnly) && expiries[0] ? await getChain(expiries[0]) : null;
      const spot = chain?.spot || null;
      const before = JSON.stringify([st.cycle, st.cycles.length]);
      const bees = spot ? await beesNow(spot) : null;
      await settleDue(today, hhmm, spot, bees);
      if (spot) {
        st.lastSpot = spot;
        const canEnter = demo || (open && hhmm >= st.params.entryTime && hhmm < LAST_ENTRY);
        if (!st.cycle && canEnter && today > (st.lastExpiry || '')) await startCycle(today, spot, bees, expiries);
        if (st.cycle?.call && !st.cycle.ins.length && canEnter) await buyInsurance(today, spot);
        if (st.cycle?.call && canEnter) await maybeRollUp(today, spot);
        if (st.cycle?.call && st.params.ovl.on && !st.cycle.ovl && canEnter) await maybeOverlay(today, spot, expiries);
        await mark(today, spot, bees);
      }
      lastError = null;
      if (spot || before !== JSON.stringify([st.cycle, st.cycles.length])) save();
    } catch (e) {
      lastError = e.message;
      log('error', e.message);
      save();
      logError('cc-paper', e);
    } finally {
      busy = false;
    }
  }

  // What happens next, in words.
  function nextStep(now = Date.now()) {
    if (!st) return null;
    if (st.status !== 'running') return 'Paused: no new positions, no settlement until it is resumed.';
    const cyc = st.cycle;
    const p = st.params;
    if (!cyc)
      return `Next: at ${p.entryTime} on a trading day${st.lastExpiry ? ' after ' + st.lastExpiry : ''}, buy ${CC.holdName(p)} (first month only), sell the monthly call and buy the insurance.`;
    const today = istDate(now);
    const bits = [];
    if (cyc.ovl) bits.push(`the weekly spread settles on ${cyc.ovl.expiry} at ${SETTLE_AT}`);
    else if (p.ovl.on) bits.push(`the next weekly spread opens at the next check from ${p.entryTime} (not on its expiry day)`);
    if (!cyc.ins.length && cyc.insFailed) bits.push('the insurance is tried again at every check');
    bits.push(`the call${cyc.ins.length ? ' and insurance settle' : ' settles'} on ${cyc.expiry} at ${SETTLE_AT}` + (cyc.expiry === today ? ' (today)' : ''));
    return 'Next: ' + bits.join('; ') + '.';
  }

  return {
    state: () => ({ paper: st, live: live || st?.lastLive || null, next: nextStep(), error: lastError, marketOpen: demo || isMarketOpen(), demo }),
    async start(params = {}) {
      if (st) throw new Error('A paper trade exists already: reset it first');
      st = {
        v: 2,
        status: 'running',
        startedAt: Date.now(),
        params: CC.normalize({ ...params, lotSize: getLot() || params.lotSize }),
        holding: { qty: 0, cost: 0, booked: 0, reinvested: 0 },
        cash: 0,
        optCum: 0,
        initialCost: 0,
        spot0: null,
        bees0: null,
        qty0: 0,
        beesRatio: null,
        bhCost: 0,
        cycle: null,
        cycles: [],
        equity: [],
        log: [],
        lastExpiry: null,
      };
      log('start', 'Paper trade started' + (demo ? ' (demo data)' : '') + '. No orders are placed.');
      save();
      await tick();
      return st;
    },
    pause() {
      if (!st) throw new Error('No paper trade');
      st.status = 'paused';
      log('pause', 'Paused');
      save();
    },
    async resume() {
      if (!st) throw new Error('No paper trade');
      st.status = 'running';
      log('resume', 'Resumed');
      save();
      await tick();
    },
    reset() {
      st = null;
      live = null;
      save();
    },
    tick,
  };
}

module.exports = { createCcPaper };
