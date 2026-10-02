// Adjustment suggestions for the Strategy Builder: a rule book of widely published option-adjustment
// techniques (tastylive management rules, iron condor / strangle repairs, credit-spread rolls, long-option
// profit locking, straddle re-centring, gamma scalping, expiry-day gamma rules, support/resistance breaks).
// Each rule looks at the open position and the market, and when it applies returns a suggestion with the
// reasoning and, where possible, the exact orders to carry it out at current prices.
//
// suggest(ctx) — ctx is built by sb-view.js:
//   spot, strikes (sorted), step, atm, minute (0 = 09:15), dte (calendar days to expiry), expiryDay (bool),
//   session ('intraday' | 'multi'), lot, legs (open: {id, action, type, strike, lots, entryPx, px, delta, iv, entryIv}),
//   pnl (₹, realised + open), openPnl, credit (₹ net premium of the open legs at entry; < 0 = debit),
//   maxProfit, maxLoss (₹ at expiry; ±Infinity when unlimited), greeks {delta (Nifty units), gamma, theta (₹/day), vega},
//   atmIv, atmIvEntry (decimals), levels (nearest support/resistance by class) or null, spotEntry,
//   priceOf(strike, type), deltaOf(strike, type)
// Returns [{ id, sev: 'act' | 'warn' | 'info' | 'ok', title, why, src, ops? }] — ops: {op:'close', id} | {op:'open', action, type, strike, lots}.
(() => {
  const r0 = (x) => Math.round(x);
  const inr = (n) => (n < 0 ? '−₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
  const isShort = (l) => l.action === 'S';

  // ---------- structure ----------
  function structure(legs) {
    const sc = legs.filter((l) => isShort(l) && l.type === 'CE');
    const sp = legs.filter((l) => isShort(l) && l.type === 'PE');
    const lc = legs.filter((l) => !isShort(l) && l.type === 'CE');
    const lp = legs.filter((l) => !isShort(l) && l.type === 'PE');
    const lots = (a) => a.reduce((s, l) => s + l.lots, 0);
    const n = legs.length;
    let name = 'custom';
    if (!n) name = 'none';
    else if (sc.length === 1 && sp.length === 1 && !lc.length && !lp.length) name = sc[0].strike === sp[0].strike ? 'short straddle' : 'short strangle';
    else if (sc.length === 1 && sp.length === 1 && lc.length === 1 && lp.length === 1) name = sc[0].strike === sp[0].strike ? 'iron fly' : 'iron condor';
    else if (lc.length === 1 && lp.length === 1 && !sc.length && !sp.length) name = lc[0].strike === lp[0].strike ? 'long straddle' : 'long strangle';
    else if (sp.length === 1 && lp.length === 1 && !sc.length && !lc.length) name = sp[0].strike > lp[0].strike ? 'bull put spread' : 'put debit spread';
    else if (sc.length === 1 && lc.length === 1 && !sp.length && !lp.length) name = sc[0].strike < lc[0].strike ? 'bear call spread' : 'bull call spread';
    else if (lp.length === 1 && sp.length === 1 && lp[0].strike > sp[0].strike && !sc.length && !lc.length) name = 'bear put spread';
    else if (n === 1) name = (isShort(legs[0]) ? 'naked short ' : 'long ') + (legs[0].type === 'CE' ? 'call' : 'put');
    else if (sc.length && lc.length && lots(sc) > lots(lc) && !sp.length && !lp.length) name = 'call ratio';
    else if (sp.length && lp.length && lots(sp) > lots(lp) && !sc.length && !lc.length) name = 'put ratio';
    else if (lc.length === 2 && sc.length === 1 && lots(sc) === 2 && !sp.length && !lp.length) name = 'call butterfly';
    else if (lp.length === 2 && sp.length === 1 && lots(sp) === 2 && !sc.length && !lc.length) name = 'put butterfly';
    const credit = ['short straddle', 'short strangle', 'iron fly', 'iron condor', 'bull put spread', 'bear call spread', 'naked short call', 'naked short put', 'call ratio', 'put ratio'].includes(name);
    return { name, sc, sp, lc, lp, credit, nakedCalls: lots(sc) > lots(lc), nakedPuts: lots(sp) > lots(lp) };
  }

  function suggest(ctx) {
    const out = [];
    const add = (s) => out.push(s);
    const st = structure(ctx.legs);
    const { spot, step, legs, lot } = ctx;
    const K = (k, n) => { const i = ctx.strikes.indexOf(k); const j = Math.max(0, Math.min(ctx.strikes.length - 1, (i < 0 ? ctx.strikes.indexOf(ctx.atm) : i) + n)); return ctx.strikes[j]; };
    const otmStep = (type) => (type === 'CE' ? 1 : -1);
    const byDelta = (type, target) => {
      let best = null;
      for (const k of ctx.strikes) {
        if (type === 'CE' ? k < ctx.atm : k > ctx.atm) continue;
        const d = Math.abs(ctx.deltaOf(k, type) ?? NaN);
        if (!isFinite(d)) continue;
        if (!best || Math.abs(d - target) < Math.abs(best.d - target)) best = { k, d };
      }
      return best?.k ?? null;
    };
    const closeAll = () => legs.map((l) => ({ op: 'close', id: l.id }));
    const dPer = Math.abs(ctx.greeks.delta) / lot; // net delta in "lots of Nifty"
    const lotsAll = legs.reduce((s, l) => s + l.lots, 0) || 1;
    const lateExpiry = ctx.expiryDay && ctx.minute >= 315; // 14:30+
    const ivChg = ctx.atmIv && ctx.atmIvEntry ? (ctx.atmIv - ctx.atmIvEntry) * 100 : null;
    const shortVega = ctx.greeks.vega < 0;

    if (st.name === 'none') {
      add({ id: 'start', sev: 'info', title: 'No open position', why: 'Click B / S in the chain or apply a strategy from the bar above. Suggestions update every replay step.', src: '' });
      return out;
    }

    // ---- 1. Profit taking and stops (tastylive management rules) ----
    if (st.credit && ctx.credit > 0) {
      const captured = ctx.openPnl / ctx.credit;
      if (captured >= 0.5) add({ id: 'win50', sev: 'act', title: `Book profits: ${Math.round(captured * 100)}% of the credit captured`, why: `Short-premium positions are typically closed at 50% of the maximum credit — the remaining premium pays little for the risk still carried (gamma, gap risk). Open P&L ${inr(ctx.openPnl)} of ${inr(ctx.credit)} credit.`, src: 'tastylive: manage winners at 50%', ops: closeAll() });
      else if (captured <= -1) add({ id: 'stop2x', sev: 'act', title: `Stop: loss is ${(-captured).toFixed(1)}× the credit`, why: `A common hard stop for credit trades is when the loss reaches 1–2× the credit received (the position is worth 2–3× what was sold). Beyond that, repairs usually add risk rather than remove it.`, src: 'tastylive / Option Alpha: 2× credit stop', ops: closeAll() });
    }
    if (!st.credit && ctx.credit < 0) {
      const debit = -ctx.credit;
      const gain = ctx.openPnl / debit;
      if (gain >= 1) add({ id: 'debit100', sev: 'act', title: `Debit position up ${Math.round(gain * 100)}% — lock it in`, why: 'Doubling the premium paid is a common exit for long options / debit spreads; at least take the original risk off (close half) and let the rest run with a stop at entry.', src: 'Long-option management: take initial risk off at 100%', ops: lotsAll > 1 ? legs.map((l) => ({ op: 'close', id: l.id, lots: Math.max(1, Math.floor(l.lots / 2)) })) : closeAll() });
      else if (gain <= -0.5) add({ id: 'debit50', sev: 'warn', title: `Debit position down ${Math.round(-gain * 100)}%`, why: 'Long premium decays faster as expiry approaches. Cut it, or reduce cost by selling a further OTM option against it (turning it into a spread).', src: 'Long-option management: 50% stop / convert to spread' });
    }

    // ---- 2. Expiry-day gamma and end of session ----
    if (lateExpiry) {
      const nearShorts = legs.filter((l) => isShort(l) && Math.abs(l.strike - spot) <= 1.5 * step);
      if (nearShorts.length) add({ id: 'gamma', sev: 'act', title: 'Expiry-day gamma: close shorts near the money', why: `${nearShorts.map((l) => l.strike + l.type).join(', ')} within ${r0(1.5 * step)} pts of Nifty in the last hour of expiry. A 30–50 pt move can multiply these premiums; the little time value left is not worth it.`, src: 'Expiry-day risk management', ops: nearShorts.map((l) => ({ op: 'close', id: l.id })) });
    }
    if (ctx.session === 'intraday' && ctx.minute >= 345) add({ id: 'eod', sev: 'warn', title: 'Square off before 15:20', why: 'Intraday session: closing in the last minutes risks wide spreads and settlement at the closing auction.', src: 'Intraday discipline', ops: closeAll() });

    // ---- 3. Short strangle / straddle / iron condor / iron fly repairs ----
    if (['short strangle', 'short straddle', 'iron condor', 'iron fly'].includes(st.name)) {
      const c = st.sc[0];
      const p = st.sp[0];
      const dc = Math.abs(c.delta ?? 0);
      const dp = Math.abs(p.delta ?? 0);
      const tested = dc > dp ? c : p;
      const untested = tested === c ? p : c;
      const dt = Math.max(dc, dp);
      const du = Math.min(dc, dp);
      const breached = tested.type === 'CE' ? spot > tested.strike : spot < tested.strike;
      const wingOf = (l) => (l.type === 'CE' ? st.lc[0] : st.lp[0]);

      if (st.name.startsWith('short straddle') || st.name === 'iron fly') {
        const moved = Math.abs(spot - c.strike);
        if (moved >= 1.5 * step) {
          const newK = ctx.atm;
          const ops = [{ op: 'close', id: c.id }, { op: 'close', id: p.id }, { op: 'open', action: 'S', type: 'CE', strike: newK, lots: c.lots }, { op: 'open', action: 'S', type: 'PE', strike: newK, lots: p.lots }];
          if (st.name === 'iron fly') {
            const w = Math.abs((st.lc[0]?.strike ?? c.strike) - c.strike) || 4 * step;
            ops.push({ op: 'close', id: st.lc[0].id }, { op: 'close', id: st.lp[0].id }, { op: 'open', action: 'B', type: 'CE', strike: newK + w, lots: st.lc[0].lots }, { op: 'open', action: 'B', type: 'PE', strike: newK - w, lots: st.lp[0].lots });
          }
          add({ id: 'recentre', sev: 'warn', title: `Re-centre the ${st.name} at ${newK}`, why: `Nifty is ${r0(moved)} pts from the short strike ${c.strike}; the position is now directional (delta ${dPer.toFixed(2)} lots). Shifting the straddle to the new ATM restores neutrality and collects fresh premium — at the cost of realising the loss on the tested side.`, src: 'Straddle adjustment: shift to new ATM', ops });
        }
      } else if (dt >= 0.35 || breached) {
        // Roll the untested side closer (to ~0.30 delta) — collects credit and re-balances delta.
        // Never past the tested strike (that would invert the strangle; the straddle conversion covers it).
        const target = byDelta(untested.type, 0.3);
        const inverts = target != null && (untested.type === 'CE' ? target <= tested.strike : target >= tested.strike);
        if (target != null && !inverts && target !== untested.strike && du < 0.2) {
          const ops = [{ op: 'close', id: untested.id }, { op: 'open', action: 'S', type: untested.type, strike: target, lots: untested.lots }];
          const w = wingOf(untested);
          if (w) ops.push({ op: 'close', id: w.id }, { op: 'open', action: 'B', type: w.type, strike: target + (w.strike - untested.strike), lots: w.lots });
          add({ id: 'rollUntested', sev: 'warn', title: `Roll the untested ${untested.type} from ${untested.strike} to ${target}`, why: `The ${tested.strike} ${tested.type} is tested (Δ ${dt.toFixed(2)}) while the ${untested.strike} ${untested.type} has little left (Δ ${du.toFixed(2)}, ₹${(untested.px ?? 0).toFixed(1)}). Moving it to ~0.30 Δ brings in more credit and pulls net delta back toward zero; the breakeven on the tested side widens by the extra credit.`, src: 'Iron condor / strangle: roll the untested side', ops });
        }
        // Convert to straddle / iron fly when the short strike is breached.
        if (breached) {
          const ops = [{ op: 'close', id: untested.id }, { op: 'open', action: 'S', type: untested.type, strike: tested.strike, lots: untested.lots }];
          const w = wingOf(untested);
          if (w) ops.push({ op: 'close', id: w.id }, { op: 'open', action: 'B', type: w.type, strike: tested.strike + (w.strike - untested.strike), lots: w.lots });
          add({ id: 'toFly', sev: 'warn', title: `Convert to a ${st.name === 'iron condor' ? 'iron butterfly' : 'straddle'} at ${tested.strike}`, why: `Nifty has crossed the short ${tested.strike} ${tested.type}. Rolling the untested side to the same strike collects the most extra premium and centres the position on the current price. Max profit rises, but the profit zone narrows — only if you expect Nifty to settle here.`, src: 'Iron condor → iron fly / strangle → straddle conversion', ops });
        }
        if (st.name === 'iron condor' && breached && ctx.dte >= 3) add({ id: 'rollOut', sev: 'info', title: 'Or roll the tested spread out in time', why: 'With several days left, the tested vertical can be rolled to the next expiry (same or further strikes) for a credit, buying time for the trade to work.', src: 'tastylive: roll challenged spread at the short strike or 21 DTE' });
      }
      // Close the untested side for pennies.
      if (untested.entryPx > 0 && (untested.px ?? 0) <= 0.2 * untested.entryPx && dt >= 0.25) {
        const ops = [{ op: 'close', id: untested.id }];
        const w = wingOf(untested);
        if (w) ops.push({ op: 'close', id: w.id });
        add({ id: 'closeUntested', sev: 'info', title: `Close the untested ${untested.strike} ${untested.type} for ₹${(untested.px ?? 0).toFixed(1)}`, why: `It has decayed to ${Math.round(((untested.px ?? 0) / untested.entryPx) * 100)}% of its entry price: little profit left but full risk if Nifty reverses. Buy it back (and its wing) and, if you want, re-sell closer.`, src: 'Iron condor management: close the untested side', ops });
      }
      // Add wings to naked short premium when vol expands or the move accelerates.
      if (st.name.startsWith('short') && ((ivChg != null && ivChg >= 1.5) || dt >= 0.4)) {
        const wc = K(c.strike, 4);
        const wp = K(p.strike, -4);
        add({ id: 'wings', sev: 'warn', title: `Buy wings ${wc} CE / ${wp} PE (turn it into an iron ${st.name.includes('straddle') ? 'fly' : 'condor'})`, why: `${ivChg != null && ivChg >= 1.5 ? `ATM IV is up ${ivChg.toFixed(1)} pts since entry` : 'The move is accelerating'} and the position is naked short. Wings cap the loss on a gap and cut margin; they cost part of the remaining credit.`, src: 'Defining risk: convert naked short premium to iron condor / fly', ops: [{ op: 'open', action: 'B', type: 'CE', strike: wc, lots: c.lots }, { op: 'open', action: 'B', type: 'PE', strike: wp, lots: p.lots }] });
      }
    }

    // ---- 4. Vertical credit spreads ----
    if (st.name === 'bull put spread' || st.name === 'bear call spread') {
      const sh = st.name === 'bull put spread' ? st.sp[0] : st.sc[0];
      const lg = st.name === 'bull put spread' ? st.lp[0] : st.lc[0];
      const breached = sh.type === 'PE' ? spot < sh.strike : spot > sh.strike;
      const d = Math.abs(sh.delta ?? 0);
      if (breached || d >= 0.45) {
        const n = otmStep(sh.type) * 2;
        add({ id: 'rollSpread', sev: 'warn', title: `Roll the ${st.name} ${sh.type === 'PE' ? 'down' : 'up'} to ${K(sh.strike, n)}/${K(lg.strike, n)}`, why: `The short ${sh.strike} ${sh.type} is ${breached ? 'breached' : 'tested'} (Δ ${d.toFixed(2)}). Moving the spread away from the price lowers delta; it usually costs a debit now, so compare with simply closing (the loss is capped at the width minus credit).`, src: 'Credit spread: roll down/up and out', ops: [{ op: 'close', id: sh.id }, { op: 'close', id: lg.id }, { op: 'open', action: 'S', type: sh.type, strike: K(sh.strike, n), lots: sh.lots }, { op: 'open', action: 'B', type: lg.type, strike: K(lg.strike, n), lots: lg.lots }] });
        const ot = sh.type === 'PE' ? 'CE' : 'PE';
        const s2 = byDelta(ot, 0.3);
        if (s2 != null) add({ id: 'addOpposite', sev: 'info', title: `Add a ${ot === 'CE' ? 'bear call' : 'bull put'} spread at ${s2} (make it an iron condor)`, why: 'Selling the opposite spread brings in more credit, which offsets part of the loss and neutralises delta, without adding risk on the tested side (both sides cannot lose at expiry).', src: 'Credit spread repair: add the untested side', ops: [{ op: 'open', action: 'S', type: ot, strike: s2, lots: sh.lots }, { op: 'open', action: 'B', type: ot, strike: K(s2, otmStep(ot) * Math.abs(ctx.strikes.indexOf(lg.strike) - ctx.strikes.indexOf(sh.strike) || 4)), lots: lg.lots }] });
      }
    }

    // ---- 5. Long options and debit spreads ----
    if (st.name === 'long call' || st.name === 'long put') {
      const l = legs[0];
      const gain = l.entryPx ? (l.px - l.entryPx) / l.entryPx : 0;
      if (gain >= 0.5) {
        const k = K(l.strike, otmStep(l.type) * 3);
        add({ id: 'toVertical', sev: 'warn', title: `Lock profit: sell the ${k} ${l.type} against it`, why: `The ${l.strike} ${l.type} is up ${Math.round(gain * 100)}%. Selling a further OTM option turns it into a ${l.type === 'CE' ? 'bull call' : 'bear put'} spread: it banks part of the gain and cuts theta/vega exposure while keeping upside to ${k}.`, src: 'Long option: roll into a vertical', ops: [{ op: 'open', action: 'S', type: l.type, strike: k, lots: l.lots }] });
        const up = K(ctx.atm, 0);
        if (up !== l.strike) add({ id: 'rollUp', sev: 'info', title: `Or roll ${l.type === 'CE' ? 'up' : 'down'} to the ${up} ${l.type}`, why: 'Sell the winning option and buy the new ATM one: takes the intrinsic gain off the table and keeps similar exposure for a smaller outlay.', src: 'Long option: roll up and take profits', ops: [{ op: 'close', id: l.id }, { op: 'open', action: 'B', type: l.type, strike: up, lots: l.lots }] });
      }
    }
    if (st.name === 'long straddle' || st.name === 'long strangle') {
      const c = st.lc[0];
      const p = st.lp[0];
      const win = (c.px - c.entryPx) * c.lots > (p.px - p.entryPx) * p.lots ? c : p;
      if (Math.abs(spot - (ctx.spotEntry ?? spot)) >= 1.5 * step && dPer >= 0.3) {
        add({ id: 'scalp', sev: 'warn', title: `Gamma scalp: sell the ${win.strike} ${win.type} and re-buy the ATM ${win.type}`, why: `Nifty has moved ${r0(spot - (ctx.spotEntry ?? spot))} pts and the position is now ${dPer.toFixed(2)} lots directional. Booking the winning leg and re-buying at the money realises the move while keeping the straddle's long gamma.`, src: 'Long straddle: gamma scalping / rebalancing', ops: [{ op: 'close', id: win.id }, { op: 'open', action: 'B', type: win.type, strike: ctx.atm, lots: win.lots }] });
      }
      if (ivChg != null && ivChg <= -1.5) add({ id: 'crush', sev: 'warn', title: `IV down ${(-ivChg).toFixed(1)} pts since entry`, why: 'Long premium is losing to vol crush as well as time. Unless a move is imminent (event, S/R test), consider closing or selling OTM options against it.', src: 'Long volatility management' });
    }

    // ---- 6. Ratio spreads and butterflies ----
    if (st.name === 'call ratio' || st.name === 'put ratio') {
      const sh = st.name === 'call ratio' ? st.sc[0] : st.sp[0];
      if (Math.abs(spot - sh.strike) <= step * 1.5 || (sh.type === 'CE' ? spot > sh.strike : spot < sh.strike)) {
        add({ id: 'ratioWing', sev: 'act', title: `Cap the naked side: buy the ${K(sh.strike, otmStep(sh.type) * 3)} ${sh.type}`, why: `Nifty is at the short ${sh.strike} ${sh.type} of a ratio spread — beyond it, the extra short lot loses without limit. A further OTM long turns it into a broken-wing butterfly with capped risk.`, src: 'Ratio spread adjustment: add a far wing', ops: [{ op: 'open', action: 'B', type: sh.type, strike: K(sh.strike, otmStep(sh.type) * 3), lots: Math.max(1, sh.lots - (sh.type === 'CE' ? st.lc : st.lp).reduce((s, l) => s + l.lots, 0)) }] });
      }
    }
    if (st.name.endsWith('butterfly')) {
      const body = (st.sc[0] || st.sp[0]).strike;
      const wings = (st.lc.length ? st.lc : st.lp).map((l) => l.strike);
      if (spot < Math.min(...wings) || spot > Math.max(...wings)) add({ id: 'flyMove', sev: 'warn', title: 'Nifty is outside the butterfly', why: `Price left the ${Math.min(...wings)}–${Math.max(...wings)} tent around ${body}. Either close (the loss is the debit) or add a second butterfly centred at ${ctx.atm} to widen the profit zone.`, src: 'Butterfly adjustment: add a second fly / roll the body' });
    }

    // ---- 7. Delta, vega and naked risk (any structure) ----
    if (dPer >= 0.5 && !out.some((s) => ['rollUntested', 'recentre', 'scalp', 'rollSpread'].includes(s.id))) {
      const sign = ctx.greeks.delta > 0 ? 1 : -1;
      const type = sign > 0 ? 'CE' : 'PE'; // selling calls removes long delta, selling puts removes short delta
      const k = byDelta(type, 0.3);
      if (k != null) add({ id: 'hedgeDelta', sev: 'warn', title: `Position is ${dPer.toFixed(2)} lots ${sign > 0 ? 'long' : 'short'} Nifty — neutralise`, why: `Net delta is large for the size of the trade. Selling the ${k} ${type} (≈0.30 Δ) offsets about ${(0.3).toFixed(2)} lots per lot sold and collects premium; or close part of the directional legs.`, src: 'Delta-neutral rebalancing', ops: [{ op: 'open', action: 'S', type, strike: k, lots: Math.max(1, Math.round(dPer / 0.3)) }] });
    }
    if (shortVega && ivChg != null && ivChg >= 2 && !out.some((s) => s.id === 'wings')) add({ id: 'vega', sev: 'warn', title: `IV up ${ivChg.toFixed(1)} pts while short vega`, why: 'Rising implied volatility marks short options up even without a move. Defined-risk structures and smaller size hold up better; avoid adding short premium until IV settles.', src: 'Vega risk management' });
    if ((st.nakedCalls || st.nakedPuts) && !out.some((s) => s.id === 'wings' || s.id === 'ratioWing') && !st.name.startsWith('short st')) {
      add({ id: 'naked', sev: 'info', title: `Unhedged short ${st.nakedCalls ? 'calls' : 'puts'}`, why: 'Buying a far OTM option against naked shorts limits gap risk and lowers margin for a small cost.', src: 'Risk definition' });
    }

    // ---- 8. Support / resistance ----
    const L = ctx.levels;
    if (L) {
      for (const l of legs.filter(isShort)) {
        if (l.type === 'CE') {
          const res = L.resistance.major;
          if (res && l.strike >= res.price && spot < res.price) add({ id: 'srR' + l.id, sev: 'ok', title: `Short ${l.strike} CE is behind major resistance ${res.price}`, why: 'The level has turned Nifty before; holding the call is reasonable while it holds. Exit or roll up if Nifty closes above it.', src: 'Support / resistance' });
          const broke = [L.support.major, L.support.minor].find((x) => x && x.price < spot && x.price > (ctx.spotEntry ?? Infinity) && l.strike - spot < 2 * step);
          if (broke) add({ id: 'srBreakR' + l.id, sev: 'act', title: `Nifty broke above ${broke.price} toward your ${l.strike} CE`, why: 'A broken resistance often becomes support and the move extends. Roll the call side up or close it rather than waiting for the strike.', src: 'Support / resistance break', ops: [{ op: 'close', id: l.id }, { op: 'open', action: 'S', type: 'CE', strike: K(l.strike, 3), lots: l.lots }] });
        } else {
          const sup = L.support.major;
          if (sup && l.strike <= sup.price && spot > sup.price) add({ id: 'srS' + l.id, sev: 'ok', title: `Short ${l.strike} PE is behind major support ${sup.price}`, why: 'Holding the put is reasonable while the support holds; act if Nifty closes below it.', src: 'Support / resistance' });
          const broke = [L.resistance.major, L.resistance.minor].find((x) => x && x.price > spot && x.price < (ctx.spotEntry ?? -Infinity) && spot - l.strike < 2 * step);
          if (broke) add({ id: 'srBreakS' + l.id, sev: 'act', title: `Nifty broke below ${broke.price} toward your ${l.strike} PE`, why: 'A broken support often becomes resistance. Roll the put side down or close it.', src: 'Support / resistance break', ops: [{ op: 'close', id: l.id }, { op: 'open', action: 'S', type: 'PE', strike: K(l.strike, -3), lots: l.lots }] });
        }
      }
    }

    // ---- 9. Time ----
    if (st.credit && ctx.dte >= 2 && ctx.greeks.theta > 0 && !out.some((s) => s.sev === 'act' || s.sev === 'warn')) add({ id: 'hold', sev: 'ok', title: `Theta is working: +${inr(ctx.greeks.theta)}/day`, why: 'Nothing is tested. Holding is the plan; manage at 50% of credit or when a short strike is challenged.', src: 'Short premium management' });
    if (!out.length) add({ id: 'none', sev: 'ok', title: 'No adjustment needed now', why: `${st.name} — no rule is triggered at the current price, time and volatility.`, src: '' });
    const rank = { act: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]).map((s) => ({ ...s, structure: st.name }));
  }

  window.SBAdjust = { suggest, structure };
})();
