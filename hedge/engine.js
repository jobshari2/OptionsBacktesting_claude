// Hedge search: finds the cheapest option structures that keep the portfolio's loss within a target
// in a chosen Nifty fall, while keeping upside open (or capped only beyond a level you allow).
//
// Model (at the option's expiry): portfolio change ≈ exposure × Nifty move, where exposure =
// Σ holding value × beta (or downside beta). Each leg has its own lot count; hedge P&L =
// Σ leg lots × lot size × payoff − premium paid − charges.
// Legs are priced as you would actually trade them: buy at the ask, sell at the bid (or at LTP).

const FAMILIES = {
  put: 'Protective put',
  spread: 'Put spread',
  spreadtail: 'Put spread + tail put',
  partial: 'Partial collar',
  seagull: 'Seagull',
  collar: 'Collar',
  tail: 'Tail hedge',
};
const FAMILY_NOTES = {
  put: 'Buy puts. Full protection below the strike, upside fully open.',
  spread: 'Buy a put, sell a lower put. Cheaper; protection stops at the lower strike.',
  spreadtail: 'Put spread for the likely fall + a far put so a crash below the spread is covered too.',
  partial: 'Buy puts on all lots, sell calls on half: cheaper, keeps half the upside above the call.',
  seagull: 'Put spread paid for by selling far calls. Gains stop above the call.',
  collar: 'Buy puts, sell calls on all lots. Cheapest; gains stop above the call.',
  tail: 'Cheap far-OTM puts on the full exposure: only for a crash (cuts the −25% loss).',
};
const CAPS_UPSIDE = new Set(['partial', 'seagull', 'collar']);
const CHARGES_PER_LEG = 30; // ₹ per leg order, approximate brokerage + exchange charges + GST
const SCEN_MOVES = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 20, 30, 40]; // Nifty moves (%) shown in the all-options table

function priceOf(side, action, mode) {
  if (!side) return null;
  const { bid, ask, ltp } = side;
  if (mode === 'ltp') return ltp > 0 ? ltp : null;
  if (action === 'buy') return ask > 0 ? ask : ltp > 0 ? ltp * 1.02 : null;
  return bid > 0 ? bid : ltp > 0 ? ltp * 0.98 : null;
}

function legPayoff(leg, s1) {
  const intrinsic = leg.type === 'PE' ? Math.max(0, leg.strike - s1) : Math.max(0, s1 - leg.strike);
  return (leg.action === 'buy' ? 1 : -1) * intrinsic;
}

const sign = (l) => (l.action === 'buy' ? 1 : -1);
const premium = (c, lot) => c.legs.reduce((t, l) => t + sign(l) * l.price * l.lots * lot, 0);

// Portfolio + hedge P&L (₹) if Nifty moves by m (e.g. -0.15) by the hedge's expiry.
function pnl(c, m, ctx) {
  const s1 = ctx.spot * (1 + m);
  const port = ctx.exposure * m;
  if (!c) return port;
  const payoff = c.legs.reduce((t, l) => t + l.lots * ctx.lot * legPayoff(l, s1), 0);
  return port + payoff - premium(c, ctx.lot) - c.charges;
}

// Give each leg its lot count for a structure sized at `lots` (ratio legs round down; 0 = dropped).
function size(s, lots) {
  const legs = s.legs.map((l) => ({ ...l, lots: Math.floor(lots * (l.ratio ?? 1) + 1e-9) })).filter((l) => l.lots > 0);
  return { ...s, lots, legs, charges: legs.length * CHARGES_PER_LEG };
}

function evaluate(c, ctx, p) {
  const at = (pct) => pnl(c, pct / 100, ctx);
  const P = ctx.portfolioValue;
  const unhedged = (pct) => ctx.exposure * (pct / 100);
  const cost = premium(c, ctx.lot) + c.charges;
  let worst = Infinity;
  for (let q = -35; q <= 35; q += 1) worst = Math.min(worst, at(q));
  const putLots = Math.max(0, ...c.legs.filter((l) => l.type === 'PE' && l.action === 'buy').map((l) => l.lots));
  const shortCall = c.legs.filter((l) => l.type === 'CE' && l.action === 'sell').sort((a, b) => a.strike - b.strike)[0];
  const loss = { m5: at(-5), m10: at(-10), m15: at(-15), m20: at(-20), m25: at(-25), m30: at(-30), target: at(-ctx.fallPct) };
  return {
    ...c,
    cost,
    costPct: (cost / P) * 100,
    annualPct: (cost / P) * 100 * (365 / Math.max(c.days, 1)),
    loss,
    gain: { p5: at(5), p10: at(10), p20: at(20) },
    scen: Object.fromEntries([...new Set([...SCEN_MOVES, -ctx.fallPct])].map((q) => [q, at(q)])),
    upsideKept10: unhedged(10) ? (at(10) / unhedged(10)) * 100 : 100,
    upsideKept20: unhedged(20) ? (at(20) / unhedged(20)) * 100 : 100,
    worst,
    hedgeRatio: (putLots * ctx.lot * ctx.spot) / ctx.exposure,
    meets: p ? -loss.target <= (p.maxLossPct / 100) * P + 1 : null,
    crashCut: unhedged(-25) ? 1 - loss.m25 / unhedged(-25) : 0, // share of the −25% loss removed
    capsAt: shortCall ? { strike: shortCall.strike, pct: (shortCall.strike / ctx.spot - 1) * 100, share: shortCall.lots / Math.max(putLots, 1) } : null,
  };
}

// All candidate structures for one expiry (before sizing).
function structures(chain, ctx, p) {
  const S = ctx.spot;
  const rows = chain.strikes.filter((r) => r.strike % 100 === 0);
  const byK = new Map(rows.map((r) => [r.strike, r]));
  const near = (target) => rows.reduce((b, r) => (Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b), rows[0])?.strike;
  const leg = (type, strike, action, ratio = 1) => {
    const side = byK.get(strike)?.[type === 'PE' ? 'pe' : 'ce'];
    const price = priceOf(side, action, p.pricing);
    if (!(price > 0.05)) return null;
    // skip legs with a very wide market (hard to trade near the quoted price)
    if (p.pricing !== 'ltp' && side.bid > 0 && side.ask > 0 && (side.ask - side.bid) / ((side.ask + side.bid) / 2) > 0.25) return null;
    return { type, strike, action, ratio, price, bid: side.bid ?? null, ask: side.ask ?? null, ltp: side.ltp ?? null, oi: side.oi ?? null };
  };
  const out = [];
  const add = (family, legs) => {
    if (legs.every(Boolean)) out.push({ family, legs });
  };
  const strikes = rows.map((r) => r.strike);
  const putStrikes = strikes.filter((k) => k <= S * 1.005 && k >= S * 0.82);
  const tailStrikes = strikes.filter((k) => k <= S * 0.9 && k >= S * 0.72);
  const widths = [0.05, 0.075, 0.1, 0.125, 0.15];
  // calls are sold at or above the allowed cap (or +15% when no cap is allowed, shown for comparison)
  const capFrom = p.capPct ?? 15;
  const callStrikes = strikes.filter((k) => k >= S * (1 + capFrom / 100) && k <= S * (1 + (capFrom + 12) / 100));

  for (const kp of putStrikes) {
    const lp = leg('PE', kp, 'buy');
    if (!lp) continue;
    add('put', [lp]);
    for (const w of widths) {
      const kl = near(kp - S * w);
      if (!kl || kl >= kp) continue;
      const sp = leg('PE', kl, 'sell');
      if (!sp) continue;
      add('spread', [lp, sp]);
      // the tail must sit where a crash would actually reach it (no lower than 25% below spot)
      for (const t of [0.04, 0.07, 0.1]) {
        const kt = near(kl - S * t);
        if (kt && kt < kl && kt >= S * 0.75) add('spreadtail', [lp, sp, leg('PE', kt, 'buy')]);
      }
      for (const kc of callStrikes) add('seagull', [lp, sp, leg('CE', kc, 'sell')]);
    }
    for (const kc of callStrikes) {
      add('collar', [lp, leg('CE', kc, 'sell')]);
      add('partial', [lp, leg('CE', kc, 'sell', 0.5)]);
    }
  }
  for (const kt of tailStrikes) add('tail', [leg('PE', kt, 'buy')]);
  return out.map((s) => ({ ...s, expiry: chain.expiry, days: chain.days }));
}

// Main entry: cheapest structures that meet the target, plus a board with one option per strategy type.
function search(chains, ctx, p) {
  const maxLoss = (p.maxLossPct / 100) * ctx.portfolioValue;
  const fall = p.fallPct / 100;
  const fullLots = ctx.exposure / (ctx.spot * ctx.lot);
  // never hedge more than the exposure (rounded up to whole lots): beyond that the hedge becomes a bet
  const maxLots = Math.max(1, Math.ceil(fullLots * (p.maxHedgeRatio ?? 1)));
  const capAllowed = p.capPct != null;
  const feasible = [];
  const board = {}; // family -> { best (meets target, cheapest/yr) | closest (does not meet) }
  let tried = 0;

  const better = (a, b) => !b || a.annualPct < b.annualPct;
  for (const chain of chains) {
    if (chain.days < p.minDays || chain.days > p.maxDays) continue;
    for (const s of structures(chain, ctx, p)) {
      tried++;
      const slot = (board[s.family] ||= { best: null, closest: null });
      if (s.family === 'tail') {
        // crash insurance: full cover, judged on how much of a −25% loss it removes
        const e = evaluate(size(s, maxLots), ctx, p);
        if (e.crashCut >= 0.35 && better(e, slot.best)) slot.best = e;
        else if (!slot.best && (!slot.closest || e.crashCut > slot.closest.crashCut)) slot.closest = e;
        continue;
      }
      // fewest lots that keep the loss in the target fall within the limit
      let chosen = null;
      for (let lots = 1; lots <= maxLots; lots++) {
        const c = size(s, lots);
        if (-pnl(c, -fall, ctx) <= maxLoss) {
          chosen = c;
          break;
        }
      }
      if (!chosen) {
        // keep the closest attempt so every strategy type can still be shown
        const e = evaluate(size(s, maxLots), ctx, p);
        if (
          !slot.best &&
          (!slot.closest || e.loss.target > slot.closest.loss.target || (e.loss.target === slot.closest.loss.target && e.annualPct < slot.closest.annualPct))
        )
          slot.closest = e;
        continue;
      }
      const e = evaluate(chosen, ctx, p);
      // a spread + tail is only worth its tail if it also removes most of a −25% loss
      if (s.family === 'spreadtail' && e.crashCut < 0.7) {
        if (!slot.best && (!slot.closest || e.crashCut > slot.closest.crashCut)) slot.closest = e;
        continue;
      }
      if (better(e, slot.best)) slot.best = e;
      if (!CAPS_UPSIDE.has(s.family) || capAllowed) feasible.push(e);
    }
  }

  feasible.sort((a, b) => a.annualPct - b.annualPct || b.loss.m25 - a.loss.m25);
  const seen = new Set();
  const shortlist = [];
  for (const c of feasible) {
    const key = `${c.family}|${c.expiry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shortlist.push(c);
    if (shortlist.length >= 12) break;
  }

  const strategies = Object.keys(FAMILIES).map((f) => {
    const slot = board[f] || {};
    const c = slot.best || slot.closest || null;
    return {
      family: f,
      name: FAMILIES[f],
      note: FAMILY_NOTES[f],
      option: c,
      meets: Boolean(slot.best), // for the tail hedge: removes at least 35% of a −25% loss
      crashOnly: f === 'tail',
      capsUpside: CAPS_UPSIDE.has(f),
      allowed: !CAPS_UPSIDE.has(f) || capAllowed,
    };
  });

  return {
    tried,
    feasible: feasible.length,
    fullLots,
    unhedged: {
      m10: ctx.exposure * -0.1,
      m15: ctx.exposure * -0.15,
      m20: ctx.exposure * -0.2,
      m25: ctx.exposure * -0.25,
      target: ctx.exposure * -fall,
      p10: ctx.exposure * 0.1,
    },
    shortlist,
    strategies,
  };
}

// "Your structure": price user-chosen legs on one expiry's chain and evaluate them the same way.
function custom(legsIn, chain, ctx, p) {
  const byK = new Map(chain.strikes.map((r) => [r.strike, r]));
  const legs = legsIn.map((l) => {
    const type = l.type === 'CE' ? 'CE' : 'PE';
    const action = l.action === 'sell' ? 'sell' : 'buy';
    const side = byK.get(Number(l.strike))?.[type === 'PE' ? 'pe' : 'ce'];
    const price = l.price > 0 ? Number(l.price) : priceOf(side, action, p.pricing);
    if (!(price > 0)) throw new Error(`No price for ${l.strike} ${type} on ${chain.expiry}`);
    return {
      type,
      action,
      strike: Number(l.strike),
      lots: Math.max(1, Math.round(Number(l.lots) || 1)),
      price,
      bid: side?.bid ?? null,
      ask: side?.ask ?? null,
      ltp: side?.ltp ?? null,
      oi: side?.oi ?? null,
    };
  });
  const c = {
    family: 'custom',
    expiry: chain.expiry,
    days: chain.days,
    legs,
    lots: Math.max(...legs.map((l) => l.lots)),
    charges: legs.length * CHARGES_PER_LEG,
  };
  return evaluate(c, ctx, p);
}

// Full payoff curve (−40%…+40%) for one candidate, for the chart.
function curve(c, ctx) {
  const pts = [];
  for (let q = -40; q <= 40; q += 1) pts.push({ move: q, unhedged: ctx.exposure * (q / 100), hedged: c ? pnl(c, q / 100, ctx) : null });
  return pts;
}

module.exports = { search, curve, evaluate, custom, FAMILIES, FAMILY_NOTES, CHARGES_PER_LEG, SCEN_MOVES };
