// Covered call › Paper trade › Suggestions: what the rules would buy and sell on the live chain right now, for the
// current and the next monthly expiry and this week's contra spread, with the alternatives ranked beside the rule's
// pick. Prices are the LTP (else the bid / ask mid) with the strategy's slippage, as the paper trade fills. Chances
// are read from the options' own implied volatility (lognormal): the market's estimate, not an edge.
const CC = require('./coveredcall');
const { ncdf } = require('../lib/pricing');

const r2 = (x) => Math.round(x * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const INS_GRID = [
  ['butterfly', 1, 3],
  ['butterfly', 1.5, 4],
  ['butterfly', 2, 5],
  ['butterfly', 2.5, 6],
  ['debit', 1.5, 4],
  ['debit', 2, 5],
];
const OTM_GRID = [1, 1.5, 2, 2.5];
const WIDTH_GRID = [100, 200, 300];
const MIN_POP = 65; // weekly spreads less likely than this to expire worthless are not suggested

function row(chain, strike) {
  return chain?.rows?.find((r) => r.strike === strike) || null;
}
function quote(chain, strike, type) {
  const o = row(chain, strike)?.[type === 'CE' ? 'ce' : 'pe'];
  if (!o) return null;
  const px = o.ltp > 0 ? o.ltp : o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : null;
  return px == null ? null : { px, iv: o.iv > 0 ? o.iv / 100 : null, delta: o.delta ?? null, bid: o.bid || null, ask: o.ask || null };
}
// Implied volatility near the money (the ATM call's, else the put's), for strikes that have none.
function atmIv(chain, spot) {
  const ks = (chain?.rows || []).map((r) => r.strike).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
  for (const k of ks.slice(0, 4)) {
    const q = quote(chain, k, 'CE') || quote(chain, k, 'PE');
    if (q?.iv) return q.iv;
  }
  return 0.13;
}
// P(Nifty above K at expiry), lognormal with no drift, at volatility v over `days` calendar days.
function pAbove(spot, K, v, days) {
  const T = Math.max(days, 0.25) / 365;
  const s = v * Math.sqrt(T);
  return ncdf((Math.log(spot / K) - (s * s) / 2) / s);
}
// Legs [{ type, side, strike, mult }] priced as fills; null when a strike has no quote.
function price(chain, legs, qty, slip) {
  const out = [];
  for (const l of legs) {
    const q = quote(chain, l.strike, l.type);
    if (!q) return null;
    out.push({ ...l, qty: qty * l.mult, mkt: r2(q.px), entry: CC.fillPx(q.px, l.side, slip), iv: q.iv });
  }
  return out;
}
const net = (legs) => legs.reduce((s, l) => s + (l.side === 'S' ? l.entry : -l.entry) * l.qty, 0); // ₹, + = credit

// Covered call candidates: 100-point strikes from 2 % under to 3.5 % over spot.
function callCandidates(chain, spot, p, dte, units, iv) {
  const out = [];
  const lo = Math.ceil((spot * 0.98) / 100) * 100;
  for (let K = lo; K <= spot * 1.035; K += 100) {
    const q = quote(chain, K, 'CE');
    if (!q) continue;
    const fill = CC.fillPx(q.px, 'S', p.costs.slippage);
    const intrinsic = Math.max(0, spot - K);
    const tv = fill - intrinsic;
    out.push({
      strike: K,
      ltp: r2(q.px),
      fill,
      iv: q.iv ? r2(q.iv * 100) : null,
      delta: q.delta,
      timeValue: r2(tv),
      flat: Math.round(tv * units), // if Nifty is where it is now at expiry
      flatPct: r2((tv / spot) * 100),
      flatPctYear: r2(((tv / spot) * 100 * 365) / Math.max(1, dte)),
      breakeven: r2(K + fill),
      protectedTo: r2(spot - fill), // NIFTYBEES + call lose nothing down to here
      maxWith: Math.round((K - spot + fill) * units), // with NIFTYBEES, at or above the strike
      pCapped: Math.round(pAbove(spot, K, q.iv || iv, dte) * 100), // chance Nifty ends above the strike
    });
  }
  return out;
}

function insuranceCandidates(chain, spot, p, dte, units, iv) {
  const out = [];
  const grid = INS_GRID.some(([k, u, b]) => k === p.ins.kind && u === p.ins.upperPct && b === p.ins.bodyPct)
    ? INS_GRID
    : [...INS_GRID, [p.ins.kind, p.ins.upperPct, p.ins.bodyPct]];
  for (const [kind, upperPct, bodyPct] of grid) {
    const want = CC.insuranceLegs(spot, { kind, upperPct, bodyPct });
    const legs = price(chain, want, units, p.costs.slippage);
    if (!legs) continue;
    const debit = -net(legs);
    const upper = want[0].strike;
    const body = want[1].strike;
    const maxPay = (upper - body) * units - debit;
    const lowBE = kind === 'butterfly' ? 2 * body - upper + debit / units : null;
    const highBE = upper - debit / units;
    // chance Nifty ends where it pays more than it cost: under the upper breakeven (and over the lower one)
    const pZone = (lowBE ? pAbove(spot, lowBE, iv, dte) : 1) - pAbove(spot, highBE, iv, dte);
    out.push({
      kind,
      upperPct,
      bodyPct,
      strikes: want.map((l) => l.strike),
      legs,
      debit: Math.round(debit),
      maxPay: Math.round(maxPay),
      payRatio: debit > 0 ? r2(maxPay / debit) : null,
      zone: [lowBE == null ? null : r2(lowBE), r2(highBE)], // Nifty at expiry where it pays more than it cost
      pZone: Math.round(Math.max(0, pZone) * 100),
    });
  }
  return out;
}

// Weekly contra spreads for the regime: every short distance × wing width, scored by credit ÷ maximum loss among those
// with at least MIN_POP % chance of expiring worthless.
function weeklyCandidates(chain, spot, regime, p, dte, qty, iv) {
  const out = [];
  const otms = OTM_GRID.includes(p.ovl.otmPct) ? OTM_GRID : [...OTM_GRID, p.ovl.otmPct].sort((a, b) => a - b);
  const widths = WIDTH_GRID.includes(p.ovl.width) ? WIDTH_GRID : [...WIDTH_GRID, p.ovl.width].sort((a, b) => a - b);
  for (const otmPct of otms)
    for (const width of widths) {
      const want = CC.overlayLegs(spot, regime, { otmPct, width });
      const legs = price(chain, want, qty, p.costs.slippage);
      if (!legs) continue;
      const credit = net(legs);
      const maxLoss = width * qty - credit; // one side of a condor can lose
      const kp = want.find((l) => l.type === 'PE' && l.side === 'S')?.strike;
      const kc = want.find((l) => l.type === 'CE' && l.side === 'S')?.strike;
      const pop = (kp ? pAbove(spot, kp, iv, dte) : 1) - (kc ? pAbove(spot, kc, iv, dte) : 0);
      out.push({
        otmPct,
        width,
        legs,
        shorts: [kp, kc].filter(Boolean),
        credit: Math.round(credit),
        creditPts: r2(credit / qty),
        maxLoss: Math.round(maxLoss),
        ratio: maxLoss > 0 ? r2(credit / maxLoss) : null,
        pop: Math.round(pop * 100),
        ok: credit / qty >= p.ovl.minCredit && pop * 100 >= MIN_POP,
      });
    }
  return out;
}

// spot, bees: Nifty and NIFTYBEES now; chains: Map(expiry -> { rows }); expiries: live, ascending; paper: the paper
// trade's state (or null). Returns { months: [current, next], weekly, now: [actions] }.
function suggest({ today, spot, bees = null, chains, expiries, params, paper = null }) {
  const p = CC.normalize(params);
  const units = p.lots * p.lotSize;
  const lastOf = new Map();
  for (const e of expiries) lastOf.set(e.slice(0, 7), e);
  const monthly = [...lastOf.values()].filter((e) => e >= today);
  // no NIFTYBEES quote (demo, or the read failed): modelled from Nifty with the paper trade's last ratio, and flagged
  const beesModelled = !(bees > 0);
  if (beesModelled) bees = r2(spot * (paper?.beesRatio ?? CC.BEES_RATIO));
  const qtyBees = Math.round((units * spot) / bees);
  const ruleIns = (c) => c.kind === p.ins.kind && c.upperPct === p.ins.upperPct && c.bodyPct === p.ins.bodyPct;

  const months = monthly.slice(0, 2).map((E, i) => {
    const chain = chains.get(E);
    const dte = daysBetween(today, E);
    const iv = atmIv(chain, spot);
    const calls = callCandidates(chain, spot, p, dte, units, iv);
    const target = CC.callTarget(spot, p.call);
    const rule = calls.length ? calls.reduce((b, c) => (Math.abs(c.strike - target) < Math.abs(b.strike - target) ? c : b)) : null;
    const best = calls.length ? calls.reduce((b, c) => (c.flat > b.flat ? c : b)) : null;
    for (const c of calls) c.tags = [c === rule ? 'rule' : null, c === best ? 'most' : null].filter(Boolean);
    const ins = p.ins.kind === 'none' ? [] : insuranceCandidates(chain, spot, p, dte, units, iv);
    const insRule = ins.find(ruleIns) || null;
    const insBest = ins.filter((c) => c.payRatio).reduce((b, c) => (!b || c.payRatio > b.payRatio ? c : b), null);
    for (const c of ins) c.tags = [c === insRule ? 'rule' : null, c === insBest ? 'best' : null].filter(Boolean);
    return {
      label: i === 0 ? 'Current month' : 'Next month',
      expiry: E,
      dte,
      iv: r2(iv * 100),
      tooSoon: dte < p.minDays, // the paper trade would start on the next month instead
      calls,
      ins,
      pick: { call: rule?.strike ?? null, ins: insRule || insBest ? ins.indexOf(insRule || insBest) : null }, // the rule's, else the best priced
    };
  });

  // this week's contra spread, for where Nifty is against the paper trade's month (or a month entered now)
  const cyc = paper?.cycle || null;
  const ref = cyc?.call
    ? { callBE: cyc.callBE, lower: cyc.lower, from: 'the paper trade’s month' }
    : (() => {
        const m = months.find((x) => !x.tooSoon) || months[0];
        const c = m?.calls.find((x) => x.strike === m.pick.call);
        return { callBE: c ? c.breakeven : spot * 1.02, lower: spot * (1 - p.ovl.lowerPct / 100), from: 'a month entered now' };
      })();
  const W = expiries.find((e) => e > today) || null;
  let weekly = null;
  if (W) {
    const chain = chains.get(W);
    const dte = daysBetween(today, W);
    const iv = atmIv(chain, spot);
    const regime = CC.regimeOf(spot, ref);
    const qty = p.ovl.lots * p.lotSize;
    const cands = weeklyCandidates(chain, spot, regime, p, dte, qty, iv);
    const rule = cands.find((c) => c.otmPct === p.ovl.otmPct && c.width === p.ovl.width) || null;
    const best = cands.filter((c) => c.ok && c.ratio).reduce((b, c) => (!b || c.ratio > b.ratio ? c : b), null);
    for (const c of cands) c.tags = [c === rule ? 'rule' : null, c === best ? 'best' : null].filter(Boolean);
    weekly = {
      expiry: W,
      dte,
      iv: r2(iv * 100),
      regime,
      levels: { callBE: r2(ref.callBE), lower: r2(ref.lower), from: ref.from },
      candidates: cands,
      pick: best ? cands.indexOf(best) : rule ? cands.indexOf(rule) : null,
      open: cyc?.ovl ? { expiry: cyc.ovl.expiry, legs: cyc.ovl.legs } : null,
      done: Boolean(cyc?.weeks?.some((w) => w.expiry === W)),
    };
  }

  // what to do now, in words
  const now = [];
  const first = months.find((m) => !m.tooSoon);
  const describe = (m) => {
    const c = m.calls.find((x) => x.strike === m.pick.call);
    const i = m.pick.ins != null ? m.ins[m.pick.ins] : null;
    return (
      (c ? `sell ${c.strike} CE (${m.expiry}) at about ${c.fill} (${c.flatPct}% time value, breakeven ${Math.round(c.breakeven)})` : 'no call quote') +
      (i ? `, buy the ${i.strikes.join(' / ')} PE ${i.kind === 'debit' ? 'debit spread' : 'butterfly'} for about ₹${i.debit.toLocaleString('en-IN')}` : '')
    );
  };
  if (!paper) {
    now.push({
      kind: 'start',
      text:
        `Buy ${qtyBees.toLocaleString('en-IN')} NIFTYBEES at about ₹${bees}${beesModelled ? ' (modelled: no quote)' : ''} (${units} Nifty units); ` +
        (first ? describe(first) : 'no monthly expiry far enough away') +
        '.',
    });
    if (months[0]?.tooSoon)
      now.push({
        kind: 'info',
        text: `The current monthly expiry is only ${months[0].dte} days away (under ${p.minDays}): the rules start on the next month (${first?.expiry || '—'}).`,
      });
  } else if (cyc) {
    now.push({
      kind: 'hold',
      text: `Keep NIFTYBEES, the ${cyc.call?.strike} CE${cyc.ins.length ? ' and the insurance' : ''} to ${cyc.expiry}: the threads change nothing inside the month.`,
    });
    if (!cyc.ins.length && p.ins.kind !== 'none') {
      const m = months.find((x) => x.expiry === cyc.expiry);
      const i = m?.pick.ins != null ? m.ins[m.pick.ins] : null;
      if (i)
        now.push({
          kind: 'buy',
          text: `Insurance still missing: buy the ${i.strikes.join(' / ')} PE ${i.kind === 'debit' ? 'debit spread' : 'butterfly'} (${cyc.expiry}) for about ₹${i.debit.toLocaleString('en-IN')}.`,
        });
    }
    const left = daysBetween(today, cyc.expiry);
    const nextM = months.find((m) => m.expiry > cyc.expiry);
    if (left <= 7 && nextM)
      now.push({ kind: 'roll', text: `${left} days to the monthly expiry. Next month after it settles: ${describe(nextM)} (at today's prices).` });
  } else {
    now.push({
      kind: 'start',
      text: `Between months: at the next check from ${p.entryTime}, ${first ? describe(first) : 'no monthly expiry far enough away'}.`,
    });
  }
  if (weekly && p.ovl.on) {
    const c = weekly.pick != null ? weekly.candidates[weekly.pick] : null;
    const kind = REGIME_TRADE[weekly.regime];
    if (weekly.open) now.push({ kind: 'hold', text: `Weekly spread open to ${weekly.open.expiry}: hold it to expiry.` });
    else if (weekly.done) now.push({ kind: 'info', text: `This week's spread (${W}) was already traded.` });
    else if (c)
      now.push({
        kind: 'sell',
        text: `Nifty ${Math.round(spot)} is ${CC.REGIME_TEXT[weekly.regime]} → ${kind}: sell ${c.shorts.join(' / ')} with ${c.width}-point wings (${W}) for about ₹${c.credit.toLocaleString('en-IN')} (${c.creditPts} points), ${c.pop}% chance to expire worthless, max loss ₹${c.maxLoss.toLocaleString('en-IN')}.`,
      });
    else now.push({ kind: 'info', text: `No ${kind} this week clears the minimum credit (${p.ovl.minCredit} points) and a ${MIN_POP}% chance.` });
  }
  return { at: Date.now(), today, spot: r2(spot), bees, beesModelled, qtyBees, units, months, weekly, now, minPop: MIN_POP };
}
const REGIME_TRADE = { up: 'put credit spread', down: 'call credit spread', range: 'iron condor' };

module.exports = { suggest, pAbove };
