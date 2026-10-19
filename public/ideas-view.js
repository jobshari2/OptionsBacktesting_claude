// Live › Ideas: every trade the live screens suggest right now, in one place. Every idea is built and priced on the
// live option chain shown on the left of the screen (the expiry picked there or in the top bar), with the most it
// can make and lose at expiry. Sections:
//   Arbitrage         the vertical-spread arbitrage list of Live › Chain (arb.js): the same scan, filters and lots
//   Vertical spreads  the two debit verticals at the money, the one the Pulse leans towards marked
//   Option buyers     the Pulse "Trade idea" (pulse.js buildPlay): the option it would buy, taken on this chain at
//                     the same place from the money, and the same view capped with a sold wing
//   Option writers    credit spreads sold at the strikes where the Pulse sees fresh call / put writing (on the
//                     nearest expiry), else at this chain's largest call OI above Nifty and put OI below, and the
//                     iron condor of the two
//   Neutral           iron butterfly at the money and iron condor outside the move the ATM straddle prices in
//   My paper trades   the live paper trades saved from the Builder, at the current chain prices
// Best trades at the top ranks everything on the screen: arbitrage first, then reward-to-risk × chance of profit among
// defined-risk trades within a loss limit. Other arbitrages checks butterfly, broken-wing butterfly, box and calendar
// bounds on the live chain; Miscellaneous holds the best trade of each other defined-risk structure.
// Ideas show as cards or as a sortable table; hovering or clicking one marks its legs in the chain. Every idea opens
// in the Builder as a live paper position (legs filled at the prices shown), or is saved there as a paper trade
// straight away. No orders are sent from anywhere in this app.
(() => {
  const { $, esc, inr, inrS, dayShort } = BT;
  const { state } = window.app;
  const SECTIONS = [
    ['best', 'Best trades'],
    ['arb', 'Arbitrage'],
    ['arbx', 'Other arbitrage'],
    ['vert', 'Vertical spreads'],
    ['pulse', 'Pulse trade idea'],
    ['buy', 'Option buyers'],
    ['write', 'Option writers'],
    ['neutral', 'Neutral'],
    ['misc', 'Miscellaneous'],
    ['mine', 'My paper trades'],
  ];
  const WINGS = [100, 200, 300];
  const CHAIN_W = [8, 12, 20];
  const stored = BT.store.get('ideas', {});
  const C = {
    lots: 1,
    wing: 200,
    basis: 'ltp',
    capital: 500000,
    show: 'all',
    view: 'cards',
    chainW: 12,
    sort: null,
    collapsed: {},
    riskCap: 2,
    ...stored,
  };
  if (stored.basisV !== 2) Object.assign(C, { basis: 'ltp', basisV: 2 }); // Prices were bid / ask by default before: LTP now
  const saveC = () => BT.store.set('ideas', C);
  const lots = () => Math.max(1, Math.floor(Number(C.lots)) || 1);
  const lotSize = () => BT.meta.calendar?.liveLot || 65;
  const compact = (n) => (window.app.compact ? window.app.compact(n) : String(n));
  const f2 = (n) => (n == null ? '—' : n.toFixed(2));
  const money = (n) => (n == null ? '—' : inrS(Math.round(n)));

  let M = null; // the live chain on screen, as a market
  let ideas = new Map(); // id -> idea on screen (its legs carry the prices a click fills at)
  let trades = []; // saved live paper trades (/api/sb/trades)
  let tradesAt = 0;
  let drawnAt = 0;
  let pressed = false; // a mouse button is down on the screen: redrawing now would swallow the click
  let hoverId = null; // idea under the mouse: its legs are marked in the chain
  let selId = null; // idea clicked: marked until another is clicked
  let centredFor = null; // the chain scrolls to the money once per expiry
  let chartSel = null; // the option the floating chart shows: { expiry, strike, type }, or null (Nifty)
  const CHART_ICON =
    '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 10.5V1.5M1 10.5h10M3 8l2.5-3 2 2L11 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---------- the chain as a market ----------
  function marketOf(d) {
    if (!d?.rows?.length || d.spot == null) return null;
    const by = new Map(d.rows.filter((r) => [r.ce, r.pe].some((q) => q.ltp > 0 || (q.bid > 0 && q.ask > 0))).map((r) => [r.strike, r]));
    const ks = [...by.keys()].sort((a, b) => a - b);
    if (ks.length < 5) return null;
    const atm = ks.reduce((b, k) => (Math.abs(k - d.spot) < Math.abs(b - d.spot) ? k : b), ks[0]);
    const ai = ks.indexOf(atm);
    const quote = (k, t) => {
      const r = by.get(k);
      return r ? (t === 'CE' ? r.ce : r.pe) : null;
    };
    const iv = [quote(atm, 'CE')?.iv, quote(atm, 'PE')?.iv].filter((x) => x > 0);
    return {
      expiry: d.expiry,
      spot: d.spot,
      at: d.updatedAt,
      ks,
      atm,
      ai,
      step: ks[ai + 1] - ks[ai] || ks[ai] - ks[ai - 1] || 50,
      lot: lotSize(),
      quote,
      px: (k, t) => (quote(k, t)?.ltp > 0 ? quote(k, t).ltp : null),
      iv: iv.length ? iv.reduce((s, x) => s + x, 0) / iv.length : null,
    };
  }
  // What a leg fills at: sell at the bid, buy at the ask (the last trade when the book is empty or LTP is picked).
  function fill(M, act, k, t) {
    const q = M.quote(k, t);
    if (!q) return null;
    if (C.basis === 'ba') {
      if (act === 'B' && q.ask > 0) return q.ask;
      if (act === 'S' && q.bid > 0) return q.bid;
    }
    return q.ltp > 0 ? q.ltp : null;
  }
  const kNear = (M, x) => M.ks.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), M.ks[0]);
  const wingK = (M, k, dir) => {
    const w = kNear(M, k + dir * C.wing);
    return w !== k ? w : null;
  };
  const tagOf = (M, k) => {
    const d = M.ks.indexOf(k) - M.ai;
    return d === 0 ? 'ATM' : `ATM${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  };
  const legs = (M, list) => list.map(([act, type, k]) => ({ act, type, k, px: k == null ? null : fill(M, act, k, type) }));
  const nearestExpiry = () => $('expiry').options[0]?.value || null;

  // ---------- payoff at expiry ----------
  const intr = (t, k, S) => Math.max(0, t === 'CE' ? S - k : k - S);
  const unitPay = (L, S) => L.reduce((s, l) => s + (l.act === 'B' ? 1 : -1) * (l.n || 1) * (intr(l.type, l.k, S) - l.px), 0);
  const years = (expiry) => (Date.parse(expiry + 'T10:00:00Z') - Date.now()) / (365 * 864e5); // expires 15:30 IST
  // Most it can make / lose at expiry, breakevens, charges and the model chance of ending in profit.
  function evaluate(idea, M) {
    const L = idea.legs;
    const qty = (idea.lots || lots()) * M.lot;
    const ks = [...new Set(L.map((l) => l.k))].sort((a, b) => a - b);
    const xs = [0, ...ks];
    const vs = xs.map((x) => unitPay(L, x));
    const slope = L.reduce((s, l) => s + (l.type === 'CE' ? (l.act === 'B' ? 1 : -1) * (l.n || 1) : 0), 0); // beyond the top strike
    const hi = Math.max(...vs);
    const lo = Math.min(...vs);
    const bes = [];
    for (let i = 1; i < xs.length; i++) {
      const [a, b] = [vs[i - 1], vs[i]];
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) bes.push(xs[i - 1] + ((0 - a) * (xs[i] - xs[i - 1])) / (b - a));
    }
    const vLast = vs[vs.length - 1];
    if (slope && vLast * slope < 0) bes.push(xs[xs.length - 1] - vLast / slope);
    let buy = 0;
    let sell = 0;
    for (const l of L) l.act === 'B' ? (buy += l.px * qty * (l.n || 1)) : (sell += l.px * qty * (l.n || 1));
    // charges (₹20 an order, STT, exchange, SEBI, GST, stamp): opening and closing at about the same premiums, or for
    // a trade held to expiry (arbitrage) the entry only plus the STT on a long leg that ends in the money
    let charges = 0;
    if (window.Costs) {
      charges = (idea.once ? 1 : 2) * window.Costs.orders({ buy, sell, orders: L.length });
      if (idea.once) for (const l of L) if (l.act === 'B') charges += window.Costs.exercise(intr(l.type, l.k, M.spot) * qty * (l.n || 1));
    }
    const net = sell - buy; // + credit received, − debit paid
    const maxP = slope > 0 ? Infinity : hi * qty;
    const maxL = slope < 0 ? -Infinity : lo * qty;
    // chance of finishing above / below each breakeven, lognormal at the ATM IV
    let pop = null;
    const T = years(M.expiry);
    if (M.iv && T > 0) {
      const sd = (M.iv / 100) * Math.sqrt(T);
      const cdf = (x) => (x <= 0 ? 0 : BT.ncdf((Math.log(x / M.spot) + (sd * sd) / 2) / sd));
      const cuts = [...bes].sort((a, b) => a - b);
      const edges = [0, ...cuts, Infinity];
      pop = 0;
      for (let i = 1; i < edges.length; i++) {
        const a = edges[i - 1];
        const b = edges[i];
        const mid = b === Infinity ? (a || M.spot) * 1.5 + 1 : (a + b) / 2;
        if (unitPay(L, mid) > 0) pop += (b === Infinity ? 1 : cdf(b)) - cdf(a);
      }
      if (!cuts.length) pop = unitPay(L, M.spot) > 0 ? 1 : 0;
    }
    const netMaxP = maxP - charges;
    const netMaxL = maxL - charges;
    const rr = maxP !== Infinity && maxL < 0 && maxP > 0 ? netMaxP / -netMaxL : null;
    const risk = maxL > -Infinity && C.capital > 0 ? (Math.max(0, -netMaxL) / C.capital) * 100 : null;
    return { qty, maxP, maxL, bes, charges, net, pop, netMaxP, netMaxL, rr, risk, once: !!idea.once };
  }
  // A calendar (near call sold, later call bought) has no single-expiry payoff: at the near expiry the later call is
  // worth at least its intrinsic value, so the credit is the least it keeps; the most depends on that call's value then.
  function calendarE(I, M) {
    const qty = (I.lots || lots()) * M.lot;
    let buy = 0;
    let sell = 0;
    for (const l of I.legs) l.act === 'B' ? (buy += l.px * qty * (l.n || 1)) : (sell += l.px * qty * (l.n || 1));
    const charges = window.Costs ? window.Costs.orders({ buy, sell, orders: I.legs.length }) : 0;
    const net = sell - buy;
    return { qty, maxP: null, maxL: net, bes: [], charges, net, pop: null, netMaxP: null, netMaxL: net - charges, rr: null, risk: null, once: true };
  }

  // ---------- the ideas ----------
  function idea(sec, M, o) {
    const id = `${sec}|${M.expiry}|${o.key}|${o.legs.map((l) => `${l.act}${l.n || 1}${l.k}${l.type}${l.expiry || ''}`).join(',')}`;
    const missing = o.legs.filter((l) => l.k == null || !(l.px > 0));
    const I = { sec, id, expiry: M.expiry, M, ...o, ok: !missing.length, missing };
    I.E = I.ok ? (o.calendar ? calendarE(I, M) : evaluate(I, M)) : null;
    return I;
  }
  function verticals(M, pulse) {
    const out = [];
    const lean = pulse?.play?.leanSide; // 'CE' up, 'PE' down
    const up = wingK(M, M.atm, 1);
    const dn = wingK(M, M.atm, -1);
    out.push(
      idea('vert', M, {
        key: 'bull',
        title: 'Bull call spread',
        sub: `Buy the ATM call, sell the ${up ?? '—'} call: gains if Nifty rises towards ${up ?? '—'} by expiry.`,
        tags: [['Debit', 'debit'], ['Bullish', 'bull'], ...(lean === 'CE' ? [['Pulse leans up', 'pick']] : [])],
        hl: lean === 'CE',
        legs: legs(M, [
          ['B', 'CE', M.atm],
          ['S', 'CE', up],
        ]),
      }),
      idea('vert', M, {
        key: 'bear',
        title: 'Bear put spread',
        sub: `Buy the ATM put, sell the ${dn ?? '—'} put: gains if Nifty falls towards ${dn ?? '—'} by expiry.`,
        tags: [['Debit', 'debit'], ['Bearish', 'bear'], ...(lean === 'PE' ? [['Pulse leans down', 'pick']] : [])],
        hl: lean === 'PE',
        legs: legs(M, [
          ['B', 'PE', M.atm],
          ['S', 'PE', dn],
        ]),
      }),
    );
    return out;
  }
  // The Pulse reads the nearest expiry; its strike is taken on this chain at the same place from the money
  // (ATM, one step in or out of the money) and priced here.
  function buyers(M, p) {
    const out = [];
    const y = p?.play;
    if (!y) {
      out.empty = 'The Pulse is still collecting data: an idea needs about 15 minutes of the session.';
      return out;
    }
    if (y.action === 'WAIT' || !y.pick) {
      out.empty = `Pulse says WAIT — ${y.reasons?.[0] || 'no clear direction yet.'}`;
      return out;
    }
    const k = y.pick;
    const side = y.side;
    const word = side === 'CE' ? 'call' : 'put';
    const itm = side === 'CE' ? -1 : 1;
    const off = /ITM/.test(k.label) ? itm : /OTM/.test(k.label) ? -itm : 0;
    const strike = M.ks[M.ai + off] ?? null;
    const px = strike == null ? null : fill(M, 'B', strike, side);
    const delta = k.delta || 0.5;
    const tgtPts = Math.abs(k.niftyTarget - p.spot);
    const stopPts = Math.abs(p.spot - k.niftyStop);
    const plan =
      px > 0
        ? {
            target: { nifty: k.niftyTarget, prem: px + delta * tgtPts, pnl: delta * tgtPts * lots() * M.lot },
            stop: { nifty: k.niftyStop, prem: Math.max(0.05, px - delta * stopPts), pnl: -Math.min(px, delta * stopPts) * lots() * M.lot },
          }
        : null;
    const sig = y.action === 'BUY' ? ['Pulse: BUY', 'pick'] : ['Pulse: WATCH', 'warn'];
    const other = M.expiry !== nearestExpiry() ? ' Pulse read on the nearest expiry, strike and price from this chain.' : '';
    out.push(
      idea('buy', M, {
        key: 'long',
        title: `Buy ${strike ?? '—'} ${side}`,
        sub: `${k.label} ${word}${k.why?.length && !other ? ` · ${k.why.join('; ')}` : ''}. ${y.reasons?.[0] || ''}${other}`,
        tags: [sig, ['Debit', 'debit'], [side === 'CE' ? 'Bullish' : 'Bearish', side === 'CE' ? 'bull' : 'bear']],
        hl: y.action === 'BUY',
        legs: [{ act: 'B', type: side, k: strike, px }],
        plan,
        note: `Pulse trade idea: buy ${strike} ${side}`,
      }),
    );
    const w = strike == null ? null : wingK(M, strike, side === 'CE' ? 1 : -1);
    out.push(
      idea('buy', M, {
        key: 'capped',
        title: `${side === 'CE' ? 'Bull call' : 'Bear put'} spread ${strike ?? '—'}/${w ?? '—'}`,
        sub: `The same ${word}, with the ${w ?? '—'} ${word} sold against it: cheaper, and the most it can lose is smaller, but the gain stops at ${w ?? '—'}.`,
        tags: [sig, ['Debit', 'debit'], ['Capped', 'na']],
        legs: legs(M, [
          ['B', side, strike],
          ['S', side, w],
        ]),
        note: `Pulse trade idea, capped: ${strike}/${w} ${side}`,
      }),
    );
    out.warn = 'No proven edge: replays of the Pulse idea on the recorded days lost money after costs. Paper-trade it first.';
    return out;
  }
  function writers(M, p) {
    const out = [];
    const fresh = M.expiry === nearestExpiry() ? p?.levels : null; // the Pulse's fresh writing is on the nearest expiry
    const oi = (k, t) => M.quote(k, t)?.oi || 0;
    // the strike writers defend on this chain: fresh writing out of the money, else the largest OI out of the money
    const pick = (side) => {
      const f = side === 'CE' ? fresh?.resistance : fresh?.support;
      const word = side === 'CE' ? 'call' : 'put';
      if (f && (side === 'CE' ? f.strike > M.spot : f.strike < M.spot) && M.ks.includes(f.strike))
        return { k: f.strike, src: `fresh ${word} writing (+${compact(f.doi)} OI in ${p.oi?.windowMin ?? 15} min)` };
      const otm = M.ks.filter((k) => (side === 'CE' ? k > M.spot : k < M.spot) && Math.abs(M.ks.indexOf(k) - M.ai) <= 20);
      const k = otm.reduce((b, x) => (oi(x, side) > oi(b, side) ? x : b), otm[0]);
      return k == null || !oi(k, side) ? null : { k, src: `the largest ${word} OI ${side === 'CE' ? 'above' : 'below'} Nifty (${compact(oi(k, side))})` };
    };
    const cap = pick('CE');
    const floor = pick('PE');
    if (cap) {
      const w = wingK(M, cap.k, 1);
      out.push(
        idea('write', M, {
          key: 'bcs',
          title: `Bear call spread ${cap.k}/${w ?? '—'}`,
          sub: `Sell the ${cap.k} call under ${cap.src}, buy the ${w ?? '—'} call as the hedge. Keeps the credit while Nifty stays below ${cap.k}.`,
          tags: [
            ['Credit', 'credit'],
            ['Bearish', 'bear'],
          ],
          legs: legs(M, [
            ['S', 'CE', cap.k],
            ['B', 'CE', w],
          ]),
        }),
      );
    }
    if (floor) {
      const w = wingK(M, floor.k, -1);
      out.push(
        idea('write', M, {
          key: 'bps',
          title: `Bull put spread ${floor.k}/${w ?? '—'}`,
          sub: `Sell the ${floor.k} put above ${floor.src}, buy the ${w ?? '—'} put as the hedge. Keeps the credit while Nifty stays above ${floor.k}.`,
          tags: [
            ['Credit', 'credit'],
            ['Bullish', 'bull'],
          ],
          legs: legs(M, [
            ['S', 'PE', floor.k],
            ['B', 'PE', w],
          ]),
        }),
      );
    }
    if (cap && floor) {
      out.push(
        idea('write', M, {
          key: 'wic',
          title: `Iron condor ${floor.k}–${cap.k}`,
          sub: `Both spreads together: sells the writers' range ${floor.k}–${cap.k}, wings bought ${C.wing} pts beyond each side.`,
          tags: [
            ['Credit', 'credit'],
            ['Neutral', 'neutral'],
          ],
          hl: !!(fresh?.resistance && fresh?.support),
          legs: legs(M, [
            ['B', 'PE', wingK(M, floor.k, -1)],
            ['S', 'PE', floor.k],
            ['S', 'CE', cap.k],
            ['B', 'CE', wingK(M, cap.k, 1)],
          ]),
        }),
      );
    }
    if (!out.length) out.empty = 'No call or put open interest on this chain to sell against yet.';
    return out;
  }
  function neutral(M) {
    const out = [];
    const up = wingK(M, M.atm, 1);
    const dn = wingK(M, M.atm, -1);
    out.push(
      idea('neutral', M, {
        key: 'fly',
        title: `Iron butterfly ${M.atm}`,
        sub: `Sell the ATM straddle, buy the ${dn ?? '—'} put and ${up ?? '—'} call: the most credit, earned if Nifty pins near ${M.atm}.`,
        tags: [
          ['Credit', 'credit'],
          ['Neutral', 'neutral'],
        ],
        legs: legs(M, [
          ['B', 'PE', dn],
          ['S', 'PE', M.atm],
          ['S', 'CE', M.atm],
          ['B', 'CE', up],
        ]),
      }),
    );
    const ce = M.px(M.atm, 'CE');
    const pe = M.px(M.atm, 'PE');
    if (ce && pe) {
      const em = ce + pe; // the move the ATM straddle prices in by expiry
      const sc = M.ks.find((k) => k >= M.spot + em) ?? null;
      const sp = [...M.ks].reverse().find((k) => k <= M.spot - em) ?? null;
      if (sc && sp) {
        out.push(
          idea('neutral', M, {
            key: 'ic',
            title: `Iron condor ${sp}–${sc}`,
            sub: `Shorts outside the ±${em.toFixed(0)} pts the ATM straddle prices in by expiry, wings ${C.wing} pts further out.`,
            tags: [
              ['Credit', 'credit'],
              ['Neutral', 'neutral'],
            ],
            hl: true,
            legs: legs(M, [
              ['B', 'PE', wingK(M, sp, -1)],
              ['S', 'PE', sp],
              ['S', 'CE', sc],
              ['B', 'CE', wingK(M, sc, 1)],
            ]),
          }),
        );
      }
    }
    return out;
  }

  // ---------- other arbitrages: butterfly, broken-wing butterfly, box, calendar ----------
  // The no-arbitrage bounds of the Arbitrage scanner (bt/anomalies.js), checked here on the live chain shown. Priced
  // at what a fill really costs (buy at the ask, sell at the bid), every leg two-sided with a spread of at most
  // QSPREAD points and at least one lot on the book. Held to expiry they cannot lose, before charges. Vertical spreads
  // have their own section.
  const ARB_MIN = { fly: 0.25, bwfly: 0.5, box: 1, cal: 0.25 }; // least edge in points
  const ARB_BAND = 10;
  const QSPREAD = 3;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const rate = () => BT.RATE ?? 0.07;
  const nx = { expiry: null, d: null, at: 0, busy: false }; // the expiry after the one shown, for calendars
  function nextMarket(M) {
    const list = [...$('expiry').options].map((o) => o.value);
    const e = list[list.indexOf(M.expiry) + 1];
    if (!e) return null;
    if ((nx.expiry !== e || (Date.now() - nx.at > 3000 && !window.app.marketClosed())) && !nx.busy) {
      nx.busy = true;
      BT.api('/api/live?expiry=' + e)
        .then((d) => Object.assign(nx, { expiry: e, d, at: Date.now() }))
        .catch(() => Object.assign(nx, { expiry: e, d: null, at: Date.now() }))
        .finally(() => (nx.busy = false));
    }
    return nx.expiry === e ? marketOf(nx.d) : null;
  }
  // The price a leg really fills at: ask to buy, bid to sell, both sides quoted, a sane spread, a real price.
  function strict(Mx, act, k, t) {
    const q = Mx?.quote(k, t);
    if (!q || !(q.bid > 0) || !(q.ask > 0) || q.ask < q.bid || q.ask - q.bid > QSPREAD) return null;
    const px = act === 'B' ? q.ask : q.bid;
    return px >= 0.05 ? { px, qty: act === 'B' ? q.askQ : q.bidQ } : null;
  }
  // A structure priced at the touch: the cash it brings in today (+ credit, − debit) and the lots every leg can fill.
  function touch(spec) {
    let cash = 0;
    let fit = Infinity;
    const out = [];
    for (const s of spec) {
      const f = strict(s.chain, s.act, s.k, s.type);
      if (!f) return null;
      cash += (s.act === 'S' ? 1 : -1) * s.n * f.px;
      if (f.qty != null) fit = Math.min(fit, Math.floor(f.qty / (s.n * s.chain.lot)));
      out.push({ act: s.act, type: s.type, k: s.k, n: s.n, px: f.px, expiry: s.chain.expiry });
    }
    return { cash, fit: fit === Infinity ? null : fit, legs: out };
  }
  const fitTag = (fit, n = lots()) => (fit == null ? ['depth unknown', 'na'] : [`${fit} lot${fit === 1 ? '' : 's'} fillable`, fit >= n ? 'ok' : 'warn']);
  function arbitrages(M) {
    const out = [];
    // what the scan saw, per kind: structures checked, how many had a two-sided quote on every leg, the best edge
    const stat = Object.fromEntries(Object.keys(ARB_MIN).map((k) => [k, { n: 0, q: 0, best: null }]));
    const df = Math.exp(-rate() * Math.max(0, years(M.expiry)));
    const lo = Math.max(0, M.ai - ARB_BAND);
    const hi = Math.min(M.ks.length - 1, M.ai + ARB_BAND);
    const name = (t) => (t === 'CE' ? 'Call' : 'Put');
    // floor: the least the structure is worth at expiry (+width for a bought box, −width for a sold one, else 0)
    const take = (kind, label, spec, floor, centre, make) => {
      const st = stat[kind];
      st.n++;
      const T = touch(spec);
      if (!T) return;
      st.q++;
      const edge = T.cash + (floor > 0 ? floor * df : floor);
      if (st.best == null || edge > st.best) st.best = edge;
      if (edge < ARB_MIN[kind]) return;
      if (T.fit != null && T.fit < 1) return;
      const I = make(T, edge);
      I.dist = Math.abs(centre - M.spot);
      I.edge = edge;
      out.push(I);
    };
    const mk = (kind, title, sub, T, edge, note, extra = {}) =>
      idea('arbx', M, {
        key: kind,
        title,
        sub,
        tags: [['Arbitrage', 'arb'], [`Edge +${edge.toFixed(2)} pts`, 'ok'], fitTag(T.fit)],
        legs: T.legs,
        once: true,
        arbitrage: true,
        note,
        ...extra,
      });
    const leg = (act, type, k, n, chain) => ({ act, type, k, n, chain });
    for (let i = lo; i <= hi; i++) {
      const k = M.ks[i];
      for (const w of [1, 2]) {
        // butterfly: equal wings
        const a = M.ks[i - w];
        const b = M.ks[i + w];
        if (a == null || b == null || k - a !== b - k) continue;
        for (const t of ['CE', 'PE'])
          take('fly', `${t} ${a}/${k}/${b} butterfly`, [leg('B', t, a, 1, M), leg('S', t, k, 2, M), leg('B', t, b, 1, M)], 0, k, (T, edge) =>
            mk(
              'fly',
              `${name(t)} butterfly ${a}/${k}/${b}`,
              `Buy ${a}, sell 2× ${k}, buy ${b} for a credit of ${T.cash.toFixed(2)} pts: it is worth zero or more at expiry (up to ${k - a} more if Nifty ends at ${k}), so the credit is the least you keep.`,
              T,
              edge,
              `butterfly arbitrage ${a}/${k}/${b} ${t}`,
            ),
          );
      }
      for (const [s1, s2] of [
        [1, 2],
        [2, 1],
      ]) {
        // broken-wing butterfly: unequal wings, lots weighted by the strike gaps so it never pays out below zero
        const a = M.ks[i - s1];
        const b = M.ks[i + s2];
        if (a == null || b == null || k - a === b - k) continue;
        const g = gcd(k - a, b - k);
        const [wa, wk, wb] = [(b - k) / g, (b - a) / g, (k - a) / g];
        if (wa + wk + wb > 12) continue;
        for (const t of ['CE', 'PE'])
          take('bwfly', `${t} ${a}/${k}/${b} broken-wing`, [leg('B', t, a, wa, M), leg('S', t, k, wk, M), leg('B', t, b, wb, M)], 0, k, (T, edge) =>
            mk(
              'bwfly',
              `${name(t)} broken-wing butterfly ${a}/${k}/${b}`,
              `Buy ${wa}× ${a}, sell ${wk}× ${k}, buy ${wb}× ${b} (weighted by the strike gaps so it never pays out below zero) for a credit of ${T.cash.toFixed(2)} pts, which is the least you keep.`,
              T,
              edge,
              `broken-wing butterfly arbitrage ${a}/${k}/${b} ${t}`,
            ),
          );
      }
      for (let j = i + 1; j <= Math.min(hi, i + 6); j++) {
        // box: a call spread plus a put spread over the same two strikes pays exactly the gap at expiry
        const h = M.ks[j];
        const w = h - k;
        take(
          'box',
          `box ${k}/${h} bought`,
          [leg('B', 'CE', k, 1, M), leg('S', 'CE', h, 1, M), leg('B', 'PE', h, 1, M), leg('S', 'PE', k, 1, M)],
          w,
          (k + h) / 2,
          (T, edge) =>
            mk(
              'box',
              `Box ${k}/${h} (buy)`,
              `Bull call spread plus bear put spread over ${k}/${h}: pays exactly ${w} pts at expiry whatever Nifty does, and costs ${(-T.cash).toFixed(2)} pts now (${w} discounted is ${(w * df).toFixed(2)}).`,
              T,
              edge,
              `box spread arbitrage ${k}/${h} bought`,
            ),
        );
        take(
          'box',
          `box ${k}/${h} sold`,
          [leg('S', 'CE', k, 1, M), leg('B', 'CE', h, 1, M), leg('S', 'PE', h, 1, M), leg('B', 'PE', k, 1, M)],
          -w,
          (k + h) / 2,
          (T, edge) =>
            mk(
              'box',
              `Box ${k}/${h} (sell)`,
              `Bear call spread plus bull put spread over ${k}/${h}: takes in ${T.cash.toFixed(2)} pts now for owing exactly ${w} pts at expiry, whatever Nifty does.`,
              T,
              edge,
              `box spread arbitrage ${k}/${h} sold`,
            ),
        );
      }
    }
    const N = nextMarket(M);
    if (N)
      for (let i = lo; i <= hi; i++) {
        // calendar: a later call can never be worth less than the same strike's call that expires first
        const k = M.ks[i];
        if (!N.ks.includes(k)) continue;
        take('cal', `${k} call calendar`, [leg('B', 'CE', k, 1, N), leg('S', 'CE', k, 1, M)], 0, k, (T, edge) =>
          mk(
            'cal',
            `Call calendar ${k}`,
            `Buy the ${dayShort(N.expiry)} ${k} call for less than the ${dayShort(M.expiry)} ${k} call sells for: the longer-dated call is always worth at least as much, so the credit of ${T.cash.toFixed(2)} pts is the least you keep.`,
            T,
            edge,
            `calendar arbitrage ${k} call`,
            { calendar: true },
          ),
        );
      }
    out.sort((x, y) => x.dist - y.dist || y.edge - x.edge);
    out.length = Math.min(out.length, 10);
    if (!out.length) {
      const NAME = { fly: 'butterfly', bwfly: 'broken-wing', box: 'box', cal: 'calendar' };
      const parts = Object.keys(NAME)
        .filter((k) => k !== 'cal' || N)
        .map((k) => {
          const t = stat[k];
          return t.q
            ? `${NAME[k]}: best ${t.best >= 0 ? '+' : ''}${t.best.toFixed(2)} pts, needs +${ARB_MIN[k]} (${t.q} of ${t.n} quoted)`
            : `${NAME[k]}: no two-sided bid / ask on ${t.n} structures`;
        });
      const quoted = Object.values(stat).reduce((n, t) => n + t.q, 0);
      out.empty = `No arbitrage within ATM ± ${ARB_BAND} at the bid / ask. Checked — ${parts.join(' · ')}.${
        quoted
          ? ' None breaks its no-arbitrage bound by the minimum edge: the prices are consistent, which is the normal state of this market.'
          : ' No strike has a two-sided quote: the market is closed or the feed carries no depth.'
      }${N ? '' : ' Calendars need the next expiry chain.'}`;
    }
    return out;
  }

  // ---------- candidate trades: the best of each defined-risk structure ----------
  // Every vertical, condor, butterfly and broken-wing butterfly near the money is priced on this chain; the best of
  // each kind goes to Miscellaneous and the whole pool competes for Best trades. "Best" is a ranking of payoff shape
  // (reward-to-risk × chance of profit, within a loss limit), not a forecast.
  const MIN_POP = 0.25; // a "best" trade must finish in profit at least this often (model estimate)
  const BEST_N = 8;
  const PER_KIND = 2;
  const BEST_ARB = 4;
  // structures of one family compete for the same places in Best trades (shape keys of the candidates, and the keys of
  // the ideas the other sections build)
  const FAMILY = {
    bps: 'Credit spread',
    bcs: 'Credit spread',
    bcd: 'Debit spread',
    bpd: 'Debit spread',
    bull: 'Debit spread',
    bear: 'Debit spread',
    capped: 'Debit spread',
    ic: 'Condor',
    wic: 'Condor',
    ifly: 'Butterfly',
    fly: 'Butterfly',
    lfc: 'Butterfly',
    lfp: 'Butterfly',
    bwp: 'Butterfly',
    bwc: 'Butterfly',
  };
  const SHAPE = {
    bps: ['Bull put spread', ['Bullish', 'bull']],
    bcs: ['Bear call spread', ['Bearish', 'bear']],
    bcd: ['Bull call spread', ['Bullish', 'bull']],
    bpd: ['Bear put spread', ['Bearish', 'bear']],
    ic: ['Iron condor', ['Neutral', 'neutral']],
    ifly: ['Iron butterfly', ['Neutral', 'neutral']],
    lfc: ['Call butterfly', ['Pin', 'neutral']],
    lfp: ['Put butterfly', ['Pin', 'neutral']],
    bwp: ['Put broken-wing butterfly', ['Bullish', 'bull']],
    bwc: ['Call broken-wing butterfly', ['Bearish', 'bear']],
  };
  // The price a candidate's leg fills at: the touch on the bid / ask basis, the last trade on the LTP basis.
  const legPx = (M, act, k, t) => (k == null ? null : C.basis === 'ba' ? (strict(M, act, k, t)?.px ?? null) : M.px(k, t));
  function candidates(M) {
    const out = [];
    const at = (o) => M.ks[M.ai + o] ?? null;
    const add = (shape, title, sub, spec) => {
      const L = spec.map(([act, type, k, n]) => ({ act, type, k, n: n || 1, px: legPx(M, act, k, type) }));
      if (L.some((l) => l.k == null || !(l.px > 0))) return;
      if (new Set(L.map((l) => `${l.type}${l.k}`)).size !== L.length) return;
      const I = idea('misc', M, { key: shape, shape, title, sub, tags: [], legs: L });
      if (!I.ok || !I.E) return;
      I.tags = [[I.E.net >= 0 ? 'Credit' : 'Debit', I.E.net >= 0 ? 'credit' : 'debit'], SHAPE[shape][1]];
      out.push(I);
    };
    for (const w of [2, 4, 6]) {
      for (let o = -8; o <= 8; o++) {
        const k = at(o);
        const up = at(o + w);
        const dn = at(o - w);
        if (k == null) continue;
        if (o <= 0 && dn != null)
          add('bps', `Bull put spread ${k}/${dn}`, `Sell the ${k} put, buy the ${dn} put: keeps the credit while Nifty stays above ${k}.`, [
            ['S', 'PE', k],
            ['B', 'PE', dn],
          ]);
        if (o >= 0 && up != null)
          add('bcs', `Bear call spread ${k}/${up}`, `Sell the ${k} call, buy the ${up} call: keeps the credit while Nifty stays below ${k}.`, [
            ['S', 'CE', k],
            ['B', 'CE', up],
          ]);
        if (o >= -2 && o <= 4 && up != null)
          add('bcd', `Bull call spread ${k}/${up}`, `Buy the ${k} call, sell the ${up} call: gains if Nifty rises towards ${up}.`, [
            ['B', 'CE', k],
            ['S', 'CE', up],
          ]);
        if (o >= -4 && o <= 2 && dn != null)
          add('bpd', `Bear put spread ${k}/${dn}`, `Buy the ${k} put, sell the ${dn} put: gains if Nifty falls towards ${dn}.`, [
            ['B', 'PE', k],
            ['S', 'PE', dn],
          ]);
      }
      for (let i = 2; i <= 8; i++) {
        const [lp, sp, sc, lc] = [at(-i - w), at(-i), at(i), at(i + w)];
        if ([lp, sp, sc, lc].some((x) => x == null)) continue;
        add(
          'ic',
          `Iron condor ${lp}/${sp}–${sc}/${lc}`,
          `Sell the ${sp} put and ${sc} call, buy the ${lp} put and ${lc} call as wings: keeps the credit while Nifty stays between ${sp} and ${sc}.`,
          [
            ['B', 'PE', lp],
            ['S', 'PE', sp],
            ['S', 'CE', sc],
            ['B', 'CE', lc],
          ],
        );
      }
      const [lp, c0, lc] = [at(-w), at(0), at(w)];
      if (lp != null && lc != null)
        add(
          'ifly',
          `Iron butterfly ${c0} ±${lc - c0}`,
          `Sell the ${c0} straddle, buy the ${lp} put and ${lc} call: the most credit, earned if Nifty pins near ${c0}.`,
          [
            ['B', 'PE', lp],
            ['S', 'PE', c0],
            ['S', 'CE', c0],
            ['B', 'CE', lc],
          ],
        );
    }
    for (const s of [2, 4])
      for (let o = -6; o <= 6; o++) {
        const [a, k, b] = [at(o - s), at(o), at(o + s)];
        if (a == null || k == null || b == null || k - a !== b - k) continue;
        for (const t of ['CE', 'PE'])
          add(
            t === 'CE' ? 'lfc' : 'lfp',
            `${t === 'CE' ? 'Call' : 'Put'} butterfly ${a}/${k}/${b}`,
            `Buy ${a}, sell 2× ${k}, buy ${b}: the most profit if Nifty ends at ${k} (${k - a} pts), the most loss the debit paid.`,
            [
              ['B', t, a],
              ['S', t, k, 2],
              ['B', t, b],
            ],
          );
      }
    for (const [s1, s2] of [
      [1, 2],
      [2, 3],
      [2, 4],
      [1, 3],
    ])
      for (let o = -6; o <= 6; o++) {
        const put = [at(o), at(o - s1), at(o - s1 - s2)];
        if (o <= 1 && !put.some((x) => x == null))
          add(
            'bwp',
            `Put broken-wing butterfly ${put[0]}/${put[1]}/${put[2]}`,
            `Buy the ${put[0]} put, sell 2× ${put[1]}, buy the ${put[2]} put: the narrow wing is on the upside, so put on for a credit it cannot lose if Nifty rises; the most profit at ${put[1]}.`,
            [
              ['B', 'PE', put[0]],
              ['S', 'PE', put[1], 2],
              ['B', 'PE', put[2]],
            ],
          );
        const call = [at(o), at(o + s1), at(o + s1 + s2)];
        if (o >= -1 && !call.some((x) => x == null))
          add(
            'bwc',
            `Call broken-wing butterfly ${call[0]}/${call[1]}/${call[2]}`,
            `Buy the ${call[0]} call, sell 2× ${call[1]}, buy the ${call[2]} call: the narrow wing is on the downside, so put on for a credit it cannot lose if Nifty falls; the most profit at ${call[1]}.`,
            [
              ['B', 'CE', call[0]],
              ['S', 'CE', call[1], 2],
              ['B', 'CE', call[2]],
            ],
          );
      }
    return out;
  }
  // A trade that makes money after charges whatever happens (an arbitrage), a defined-risk trade within the loss limit.
  const locked = (I) => !!(I.arbitrage && I.ok && I.E && I.E.netMaxL > 0);
  const qualifies = (I) => {
    const E = I.E;
    return !!(
      I.ok &&
      E &&
      E.maxL !== -Infinity &&
      E.maxP !== Infinity &&
      E.maxP != null &&
      E.netMaxP > 0 &&
      (E.pop ?? 0) >= MIN_POP &&
      (E.risk == null || E.risk <= C.riskCap)
    );
  };
  const score = (I) => (I.E.rr ?? 0) * (I.E.pop ?? 0); // reward-to-risk × chance of profit
  function misc(cands) {
    const out = [];
    for (const shape of Object.keys(SHAPE)) {
      const ok = cands.filter((I) => I.shape === shape && qualifies(I));
      if (!ok.length) continue;
      const best = ok.reduce((b, I) => (score(I) > score(b) ? I : b));
      out.push({ ...best, hl: false, sub: `Best of ${ok.length} ${SHAPE[shape][0].toLowerCase()} candidates within your loss limit. ${best.sub}` });
    }
    out.sort((a, b) => score(b) - score(a));
    if (!out.length)
      out.empty = cands.length
        ? `No structure passes the filters (max loss within ${C.riskCap}% of capital, chance of profit at least ${MIN_POP * 100}%): raise the loss limit or the capital.`
        : 'No structure is fully quoted on this chain right now.';
    return out;
  }
  // Vertical-spread arbitrage hits (from the Arbitrage section's scan), as trades that can compete for Best trades.
  let arbFound = [];
  function arbPool() {
    if (!M || arbSet().basis !== 'ba') return [];
    return arbFound
      .filter((a) => a.reach <= 10)
      .slice(0, 4)
      .map((a) =>
        idea('arb', M, {
          key: 'varb',
          title: `${a.type === 'CE' ? 'Call' : 'Put'} vertical ${a.lo}/${a.hi}`,
          sub: `Vertical-spread arbitrage (${a.kind}): ${a.info.map((x) => `${x.act === 'B' ? 'buy' : 'sell'} ${x.k}`).join(', ')}. Held to expiry it cannot lose, before charges.`,
          tags: [['Arbitrage', 'arb'], [`Edge +${a.edge.toFixed(2)} pts`, 'ok'], fitTag(a.fit)],
          legs: a.info.map((x) => ({ act: x.act, type: a.type, k: x.k, px: x.px, n: 1, expiry: a.expiry })),
          once: true,
          arbitrage: true,
          note: `vertical-spread arbitrage ${a.lo}/${a.hi} ${a.type}`,
        }),
      );
  }
  // Arbitrage first (it makes money after charges whatever Nifty does), then the rest by reward-to-risk × chance of
  // profit, among defined-risk trades within the loss limit. The same structure from two sections shows once.
  function bestTrades(lists, pool) {
    const sig = (I) =>
      I.legs
        .map((l) => `${l.act}${l.n || 1}${l.type}${l.k}${l.expiry || ''}`)
        .sort()
        .join(',');
    const seen = new Set();
    const all = [...pool, ...lists.vert, ...lists.buy, ...lists.write, ...lists.neutral, ...lists.arbx].filter((I) => {
      if (!I.ok || !I.E || seen.has(sig(I))) return false;
      seen.add(sig(I));
      return true;
    });
    // at most PER_KIND of one structure (butterflies would otherwise fill the list) and BEST_ARB arbitrages, so the list
    // shows the best of each kind
    const taken = {};
    const perKind = (I) => {
      const kind = I.arbitrage ? `arb:${I.key}` : FAMILY[I.shape || I.key] || I.shape || I.key;
      taken[kind] = (taken[kind] || 0) + 1;
      return taken[kind] <= PER_KIND;
    };
    const top = [
      ...all
        .filter(locked)
        .sort((a, b) => b.E.netMaxL - a.E.netMaxL)
        .filter(perKind)
        .slice(0, BEST_ARB),
      ...all
        .filter((I) => !locked(I) && qualifies(I))
        .sort((a, b) => score(b) - score(a))
        .filter(perKind),
    ].slice(0, BEST_N);
    const src = (I) =>
      I.arbitrage ? 'Arbitrage' : I.shape ? SHAPE[I.shape][0] : { vert: 'Vertical', buy: 'Buyers', write: 'Writers', neutral: 'Neutral' }[I.sec] || '';
    const out = top.map((I, i) => ({
      ...I,
      hl: i === 0,
      tags: [[`#${i + 1}`, 'pick'], [src(I), 'na'], ...I.tags.filter(([, c]) => c !== 'pick' && c !== 'arb').slice(0, 3)],
    }));
    out.info = `Ranked: arbitrage first (it keeps a profit after charges whatever Nifty does), then reward-to-risk × chance of profit, among defined-risk trades whose max loss is within ${C.riskCap}% of ${inr(C.capital)} and whose chance of profit is at least ${MIN_POP * 100}%. A ranking of payoff shape from the live prices, not a forecast: none of these has a proven edge.`;
    if (!out.length)
      out.empty = `No trade passes the filters right now (max loss within ${C.riskCap}% of capital, chance of profit at least ${MIN_POP * 100}%): raise the loss limit or the capital.`;
    return out;
  }

  // ---------- figures shared by the cards and the table ----------
  function figs(I) {
    const E = I.E;
    if (!E) return null;
    const unlimited = E.maxP === Infinity;
    return {
      maxP: { v: E.maxP == null ? '—' : unlimited ? 'Unlimited' : money(E.netMaxP), c: E.maxP == null ? '' : unlimited || E.netMaxP > 0 ? 'pos' : 'neg' },
      maxL: { v: E.maxL === -Infinity ? 'Unlimited' : money(E.netMaxL), c: E.netMaxL >= 0 ? 'pos' : 'neg', label: E.netMaxL >= 0 ? 'Worst case' : 'Max loss' },
      net: { v: inr(Math.abs(E.net)), label: E.net >= 0 ? 'Credit' : 'Debit' },
      be: E.bes.length ? E.bes.map((x) => x.toFixed(0)).join(' – ') : '—',
      rr: E.rr == null ? '—' : `${E.rr.toFixed(2)} : 1`,
      pop: E.pop == null ? '—' : `${Math.round(E.pop * 100)}%`,
      risk: E.risk == null ? '—' : `${E.risk.toFixed(1)}%`,
    };
  }
  const tipMax = (E, which) =>
    `At expiry, after ≈ ${inr(E.charges)} charges (${E.once ? 'on entry, held to expiry' : 'in and out'}). Before charges: ${which === 'P' ? (E.maxP == null ? 'depends on the later call' : E.maxP === Infinity ? 'unlimited' : inr(E.maxP)) : inr(E.maxL)}`;
  const tipPop = (M) => `Model estimate at expiry: lognormal Nifty at the ATM IV (${M.iv ? M.iv.toFixed(1) : '—'}). Not a forecast.`;
  const missingTxt = (I) =>
    `Not priced right now: ${I.missing.map((l) => (l.k == null ? 'no strike that far out' : `${l.k} ${l.type} has no ${C.basis === 'ba' ? 'bid/ask' : 'price'}`)).join(', ')}.`;

  // ---------- cards ----------
  // Payoff at expiry, green above zero and red below, with Nifty now marked.
  function spark(I, M) {
    const L = I.legs;
    const ks = L.map((l) => l.k);
    const span = Math.max(C.wing * 2, (Math.max(...ks) - Math.min(...ks)) * 0.9, M.step * 6);
    const x0 = Math.min(Math.min(...ks), M.spot) - span / 2;
    const x1 = Math.max(Math.max(...ks), M.spot) + span / 2;
    const pts = [x0, ...[...new Set(ks)].sort((a, b) => a - b), x1].map((x) => [x, unitPay(L, x)]);
    const ys = pts.map((p) => p[1]);
    let y0 = Math.min(0, ...ys);
    let y1 = Math.max(0, ...ys);
    if (y1 - y0 < 1e-9) ((y0 -= 1), (y1 += 1));
    const W = 240;
    const H = 72;
    const pad = 6;
    const sx = (x) => ((x - x0) / (x1 - x0)) * W;
    const sy = (y) => pad + (1 - (y - y0) / (y1 - y0)) * (H - pad * 2);
    const line = pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
    const zero = sy(0).toFixed(1);
    const area = `${sx(x0).toFixed(1)},${zero} ${line} ${sx(x1).toFixed(1)},${zero}`;
    const cid = 'idc' + Math.abs([...I.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
    const spot = sx(M.spot).toFixed(1);
    return `<svg class="id-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Payoff at expiry">
      <defs><clipPath id="${cid}u"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath><clipPath id="${cid}d"><rect x="0" y="${zero}" width="${W}" height="${H}"/></clipPath></defs>
      <polygon points="${area}" class="up" clip-path="url(#${cid}u)"/><polygon points="${area}" class="dn" clip-path="url(#${cid}d)"/>
      <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="zero"/>
      <line x1="${spot}" x2="${spot}" y1="0" y2="${H}" class="spot"/>
      <polyline points="${line}" class="pay" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  const kpi = (label, value, cls = '', tip = '', box = '') =>
    `<div class="id-kpi ${box}"${tip ? ` title="${esc(tip)}"` : ''}><span>${label}</span><b class="${cls}">${value}</b></div>`;
  // The part of a card that moves with the prices (redrawn in place, so the buttons keep hover and focus).
  function dyn(I) {
    const M = I.M;
    const nl = I.lots || lots();
    const legRows = I.legs
      .map(
        (l) =>
          `<div class="id-leg"><span class="id-act ${l.act === 'B' ? 'b' : 's'}">${l.act === 'B' ? 'BUY' : 'SELL'}</span><span class="id-k">${l.n > 1 ? l.n + '× ' : ''}${l.k ?? '—'} <i class="${l.type === 'CE' ? 'ce-t' : 'pe-t'}">${l.type}</i></span><span class="muted">${l.k == null ? '' : tagOf(M, l.k)}${l.expiry && l.expiry !== I.expiry ? ' · ' + dayShort(l.expiry) : ''}</span><span class="id-px">${l.px > 0 ? '@ ' + f2(l.px) : 'no price'}</span></div>`,
      )
      .join('');
    if (!I.ok) return `<div class="id-legs">${legRows}</div><div class="id-unavail">${missingTxt(I)}</div>`;
    const E = I.E;
    const F = figs(I);
    const plan = I.plan
      ? `<div class="id-plan"><span title="Nifty target from the recent 1-minute move size; the option price there estimated with the strike's delta">🎯 Nifty ${I.plan.target.nifty.toFixed(0)} → option ≈ ${f2(I.plan.target.prem)} <b class="pos">${money(I.plan.target.pnl)}</b></span><span title="Exit level for Nifty and the option price there">⛔ Nifty ${I.plan.stop.nifty.toFixed(0)} → option ≈ ${f2(I.plan.stop.prem)} <b class="neg">${money(I.plan.stop.pnl)}</b></span></div>`
      : '';
    return `<div class="id-legs">${legRows}</div>
      <div class="id-body">
        <div class="id-hero">
          ${kpi('Max profit', F.maxP.v, F.maxP.c, tipMax(E, 'P'))}
          ${kpi(F.maxL.label, F.maxL.v, F.maxL.c, tipMax(E, 'L'))}
        </div>
        ${I.calendar ? '<div class="id-spark id-spark-na muted small">Never below the credit kept: the later call is worth at least what the near call settles at.</div>' : spark(I, M)}
      </div>
      <div class="id-kpis">
        ${kpi(F.net.label, F.net.v, '', `${E.net >= 0 ? 'Received' : 'Paid'} on entry for ${nl} lot${nl === 1 ? '' : 's'} (${E.qty} qty)`)}
        ${kpi('Breakeven', F.be, '', 'Nifty at expiry where the trade makes nothing (before charges)', E.bes.length > 1 ? 'two' : '')}
        ${kpi('Reward/risk', F.rr, '', 'Max profit ÷ max loss, after charges')}
        ${kpi('Prob. profit', F.pop, '', tipPop(M))}
      </div>
      ${plan}
      <div class="id-foot-note muted small">${nl} lot${nl === 1 ? '' : 's'} × ${M.lot} · ≈ ${inr(E.charges)} charges${E.risk != null ? ` · max loss ${E.risk.toFixed(1)}% of ${inr(C.capital)}` : ''}</div>`;
  }
  const ACTIONS = `<button class="btn-sm kite" data-kite="1" title="Send the legs to Zerodha Kite as real orders (limit orders: buys first, sells only after the buys fill). Asks you to confirm first.">Trade with Zerodha Kite</button><button class="btn-sm ghost" data-open="1" title="Open the legs in the Builder as a live paper position at the prices shown, to review the payoff or adjust it before saving">Open in Builder</button><button class="btn-sm" data-save="1" title="Fill the legs as a live paper trade at the prices shown and save it (listed on the Trades tab and below)">＋ Save paper trade</button>`;
  const tagsHtml = (I) => I.tags.map(([t, c]) => `<span class="id-tag ${c}">${esc(t)}</span>`).join('');
  const setHtml = (n, html) => {
    if (n._html !== html) ((n.innerHTML = html), (n._html = html));
  };
  function cardShell(I) {
    const el = document.createElement('article');
    el.className = 'id-card';
    el.dataset.id = I.id;
    el.innerHTML = `<header><div class="id-title">${esc(I.title)}</div><span class="id-exp" title="Expiry">${dayShort(I.expiry)}</span></header>
      <div class="id-tags"></div>
      <div class="id-sub"></div>
      <div class="id-dyn"></div>
      <footer>${ACTIONS}</footer>`;
    return el;
  }
  function paintCard(el, I) {
    setHtml(el.querySelector('.id-tags'), tagsHtml(I));
    setHtml(el.querySelector('.id-sub'), esc(I.sub));
    setHtml(el.querySelector('.id-dyn'), dyn(I));
    el.classList.toggle('hl', !!I.hl);
    el.classList.toggle('off', !I.ok);
    el.querySelectorAll('footer button').forEach((b) => (b.disabled = !I.ok));
  }
  // Keeps one element per idea id: new ones are added, gone ones removed, the rest repainted in place.
  function keyed(box, list, make, paint) {
    const have = new Map([...box.children].map((el) => [el.dataset.id, el]));
    list.forEach((I, i) => {
      const el = have.get(I.id) || make(I);
      have.delete(I.id);
      paint(el, I);
      el.classList.toggle('sel', I.id === selId);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    for (const el of have.values()) el.remove();
  }

  // ---------- table ----------
  const COLS = [
    ['idea', 'Idea', 'l'],
    ['legs', 'Legs', 'l'],
    ['net', 'Cr / Dr', '', 'Received (credit) or paid (debit) on entry'],
    ['maxP', 'Max profit', '', 'Most it can make at expiry, after charges'],
    ['maxL', 'Max loss', '', 'At expiry, after charges'],
    ['be', 'Breakeven', ''],
    ['rr', 'R : R', '', 'Reward to risk: max profit ÷ max loss, after charges'],
    ['pop', 'Prob.', '', 'Chance of profit at expiry: model estimate, lognormal at the ATM IV'],
    ['risk', 'Risk %', '', 'Max loss as a share of the capital set above'],
  ];
  const SORTABLE = {
    net: (E) => E.net,
    maxP: (E) => E.netMaxP,
    maxL: (E) => E.netMaxL,
    rr: (E) => E.rr ?? -1,
    pop: (E) => E.pop ?? -1,
    risk: (E) => -(E.risk ?? 1e9),
  };
  function sorted(list) {
    const s = C.sort;
    const f = s && SORTABLE[s.key];
    if (!f) return list;
    return list.slice().sort((a, b) => {
      const x = a.E ? f(a.E) : -Infinity;
      const y = b.E ? f(b.E) : -Infinity;
      return x === y ? 0 : (x < y ? -1 : 1) * s.dir;
    });
  }
  function theadHtml() {
    return `<tr>${COLS.map(([k, t, c, tip]) => {
      const on = C.sort?.key === k;
      const label = SORTABLE[k]
        ? `<button class="id-sort ${on ? 'on' : ''}" data-sort="${k}" title="${esc(tip || '')} · click to sort">${t}${on ? (C.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`
        : t;
      return `<th class="${c}"${tip && !SORTABLE[k] ? ` title="${esc(tip)}"` : ''}>${label}</th>`;
    }).join('')}<th></th></tr>`;
  }
  function rowCells(I) {
    const legsTxt = I.legs
      .map(
        (l) =>
          `<span class="id-chip ${l.act === 'B' ? 'b' : 's'}">${l.act} ${l.n > 1 ? l.n + '× ' : ''}${l.k ?? '—'} ${l.type}${l.expiry && l.expiry !== I.expiry ? ' ' + dayShort(l.expiry) : ''}<i>${l.px > 0 ? f2(l.px) : '—'}</i></span>`,
      )
      .join('');
    const head = `<div class="id-row-title"><b>${esc(I.title)}</b>${I.hl ? '<span class="id-dot" title="Highlighted: the Pulse leans this way or the setup is complete"></span>' : ''}</div><div class="id-tags sm">${tagsHtml(I)}</div>`;
    if (!I.ok) return [head, `${legsTxt}<div class="id-unavail">${missingTxt(I)}</div>`, '—', '—', '—', '—', '—', '—', '—'];
    const F = figs(I);
    const E = I.E;
    return [
      head,
      `${legsTxt}${I.plan ? `<div class="muted small">🎯 ${I.plan.target.nifty.toFixed(0)} <span class="pos">${money(I.plan.target.pnl)}</span> · ⛔ ${I.plan.stop.nifty.toFixed(0)} <span class="neg">${money(I.plan.stop.pnl)}</span></div>` : ''}`,
      `<span class="muted small">${F.net.label === 'Credit' ? 'Cr' : 'Dr'}</span> ${F.net.v}`,
      `<b class="${F.maxP.c}" title="${esc(tipMax(E, 'P'))}">${F.maxP.v}</b>`,
      `<b class="${F.maxL.c}" title="${esc(tipMax(E, 'L'))}">${F.maxL.v}</b>`,
      F.be,
      F.rr,
      `<span title="${esc(tipPop(I.M))}">${F.pop}</span>`,
      F.risk,
    ];
  }
  function rowShell(I) {
    const tr = document.createElement('tr');
    tr.dataset.id = I.id;
    tr.innerHTML =
      COLS.map(([, , c]) => `<td class="${c}"></td>`).join('') +
      `<td class="id-acts">${ACTIONS.replace('＋ Save paper trade', '＋ Save').replace('Trade with Zerodha Kite', 'Kite')}</td>`;
    return tr;
  }
  function paintRow(tr, I) {
    rowCells(I).forEach((h, i) => setHtml(tr.children[i], h));
    tr.classList.toggle('hl', !!I.hl);
    tr.classList.toggle('off', !I.ok);
    tr.querySelectorAll('.id-acts button').forEach((b) => (b.disabled = !I.ok));
  }

  // ---------- the live option chain ----------
  // Legs of the idea under the mouse (else the one clicked) are marked B / S beside their price.
  function chainHtml(M) {
    const act = ideas.get(hoverId) || ideas.get(selId);
    const marks = new Map();
    for (const l of act?.legs || [])
      if (l.k != null && (!l.expiry || l.expiry === M.expiry)) marks.set(`${l.k}|${l.type}`, (marks.get(`${l.k}|${l.type}`) || '') + l.act);
    const ks = M.ks.slice(Math.max(0, M.ai - C.chainW), M.ai + C.chainW + 1);
    const maxOi = Math.max(1, ...ks.flatMap((k) => [M.quote(k, 'CE')?.oi || 0, M.quote(k, 'PE')?.oi || 0]));
    const n = (x) => (x > 0 ? x.toFixed(2) : '—');
    const badge = (k, t) => [...(marks.get(`${k}|${t}`) || '')].map((a) => `<b class="id-cb ${a === 'B' ? 'b' : 's'}">${a}</b>`).join('');
    const oiCell = (q, side) =>
      `<td class="oi ${side}"><span class="bar" style="width:${(((q?.oi || 0) / maxOi) * 100).toFixed(1)}%"></span><span class="v">${q?.oi ? compact(q.oi) : '—'}</span></td>`;
    // the chart button of a price: shows that option in the floating chart
    const chBtn = (k, t) =>
      `<button type="button" class="ch-btn ${t === 'CE' ? 'ce' : 'pe'}${chartSel && chartSel.expiry === M.expiry && chartSel.strike === k && chartSel.type === t ? ' on' : ''}" data-chart="${k}|${t}" title="Show the ${k} ${t} chart in the floating chart">${CHART_ICON}</button>`;
    const spotRow = `<tr class="spot"><td colspan="9"><span>Nifty ${M.spot.toFixed(2)}</span></td></tr>`;
    const rows = [];
    let spotDone = false;
    for (const k of ks) {
      if (!spotDone && k > M.spot) {
        rows.push(spotRow);
        spotDone = true;
      }
      const ce = M.quote(k, 'CE');
      const pe = M.quote(k, 'PE');
      const bc = badge(k, 'CE');
      const bp = badge(k, 'PE');
      const ci = k < M.spot ? ' itm' : '';
      const pi = k > M.spot ? ' itm' : '';
      rows.push(`<tr class="${k === M.atm ? 'atm' : ''}${bc || bp ? ' leg' : ''}">${oiCell(ce, 'ce' + ci)}<td class="${ci}">${n(ce?.bid)}</td><td class="${ci}">${n(ce?.ask)}</td><td class="ltp${ci}${bc ? ' mk' : ''}">${chBtn(k, 'CE')}${bc}${n(ce?.ltp)}</td>
        <td class="k">${k}</td>
        <td class="ltp${pi}${bp ? ' mk' : ''}">${n(pe?.ltp)}${bp}${chBtn(k, 'PE')}</td><td class="${pi}">${n(pe?.bid)}</td><td class="${pi}">${n(pe?.ask)}</td>${oiCell(pe, 'pe' + pi)}</tr>`);
    }
    if (!spotDone) rows.push(spotRow);
    return rows.join('');
  }
  function paintChain() {
    const body = $('idChainBody');
    if (!M) {
      setHtml(body, '<tr><td colspan="9" class="muted id-chain-wait">Waiting for the live option chain…</td></tr>');
      return;
    }
    setHtml(body, chainHtml(M));
    const act = ideas.get(hoverId) || ideas.get(selId);
    setHtml(
      $('idChainSel'),
      act
        ? `<span class="muted">Legs of</span> <b>${esc(act.title)}</b>${selId && act.id === selId ? ' <button class="icon" data-unsel="1" title="Clear the marked idea">✕</button>' : ''}`
        : '<span class="muted">Hover or click an idea to mark its legs here</span>',
    );
    if (centredFor !== M.expiry) {
      centredFor = M.expiry;
      const wrap = $('idChainWrap');
      const atm = body.querySelector('tr.atm');
      if (atm) wrap.scrollTop = atm.offsetTop - wrap.clientHeight / 2;
    }
  }
  function renderChainHead() {
    const top = $('expiry');
    const sel = $('idExp');
    const key = [...top.options].map((o) => o.value).join(',');
    if (sel.dataset.key !== key) {
      sel.innerHTML = [...top.options].map((o) => `<option value="${esc(o.value)}">${esc(o.textContent)}</option>`).join('');
      sel.dataset.key = key;
    }
    if (M && sel.value !== M.expiry) sel.value = M.expiry;
    setHtml(
      $('idChainW'),
      CHAIN_W.map((w) => `<button data-chainw="${w}" class="${C.chainW === w ? 'on' : ''}" title="Strikes either side of the money">±${w}</button>`).join(''),
    );
  }

  // ---------- my paper trades ----------
  async function loadTrades() {
    try {
      trades = (await BT.api('/api/sb/trades')).trades.filter((t) => t.summary?.src === 'live');
    } catch {
      trades = [];
    }
    tradesAt = Date.now();
  }
  // P&L now of a saved trade whose open legs are all on the chain shown.
  function nowPnl(t) {
    const lot = t.summary.lot || lotSize();
    let total = 0;
    for (const l of t.snap.legs) {
      let px = l.exitPx;
      if (l.open) {
        if (M?.expiry !== (l.expiry || t.snap.liveExpiry)) return null;
        px = M.px(l.strike, l.type);
        if (!(px > 0)) return null;
      }
      total += (l.action === 'B' ? 1 : -1) * l.lots * lot * (px - l.entryPx);
    }
    return total;
  }
  function mineHtml() {
    if (!trades.length)
      return '<div class="id-empty">No live paper trades saved yet. Press <b>＋ Save paper trade</b> on any idea above: it is filled at the prices shown, saved, and listed here with its P&amp;L.</div>';
    const list = trades.slice().sort((a, b) => b.savedAt - a.savedAt);
    return `<div class="tbl-wrap"><table class="grid-tbl id-mine">
      <thead><tr><th class="l">Trade</th><th class="l">Legs</th><th class="l">Expiry</th><th>Saved</th><th title="Total P&amp;L when it was last saved">At save</th><th title="At the current chain prices (open legs at their last traded price)">Now</th><th></th></tr></thead>
      <tbody>${list
        .map((t) => {
          const now = nowPnl(t);
          return `<tr><td class="l"><b>${esc(t.name)}</b></td><td class="l small">${esc(t.summary.legs || '—')}</td><td class="l">${(t.summary.expiries || []).map(dayShort).join(', ')}</td>
            <td class="muted">${new Date(t.savedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td class="${t.summary.total > 0 ? 'pos' : t.summary.total < 0 ? 'neg' : ''}">${inrS(t.summary.total || 0)}</td>
            <td class="${now > 0 ? 'pos' : now < 0 ? 'neg' : 'muted'}">${now == null ? '<span class="muted" title="Its expiry is not the one in the chain: pick it there, or open the trade, to see the P&amp;L">—</span>' : `<b>${inrS(Math.round(now))}</b>`}</td>
            <td><button class="btn-sm ghost" data-trade="${esc(t.id)}" title="Load it in the Builder with its legs, log and live P&amp;L">Open ▸</button></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  // ---------- the screen ----------
  function renderTop(p, counts) {
    const bias = p?.bias || 'neutral';
    $('idStats').innerHTML = `
      <div class="id-stat"><span>Nifty</span><b>${M ? M.spot.toFixed(2) : '—'}</b></div>
      <div class="id-stat"><span>Expiry</span><b>${M ? dayShort(M.expiry) : '—'}</b></div>
      <div class="id-stat"><span>ATM</span><b>${M?.atm ?? '—'}</b></div>
      <div class="id-stat"><span>ATM IV</span><b>${M?.iv ? M.iv.toFixed(1) : '—'}</b></div>
      <div class="id-stat"><span>Pulse</span><b><span class="bias-pill ${esc(bias)}">${esc(p ? bias : 'collecting')}</span></b></div>
      <div class="id-stat"><span>Ideas</span><b>${counts.vert + counts.buy + counts.write + counts.neutral + counts.arbx + counts.misc}</b></div>`;
    $('idNav').innerHTML = [['all', 'All', null], ...SECTIONS.map(([k, t]) => [k, t, counts[k]])]
      .map(([k, t, n]) => `<button data-show="${k}" class="${C.show === k ? 'on' : ''}">${t}${n == null ? '' : ` <span class="id-n">${n}</span>`}</button>`)
      .join('');
  }
  function renderControls() {
    $('idCtl').innerHTML = `
      <span class="id-ctl" title="Show the ideas as cards with their payoff, or as one sortable table per section">View <span class="seg sm">${[
        ['cards', '▦ Cards'],
        ['table', '☰ Table'],
      ]
        .map(([v, l]) => `<button data-layout="${v}" class="${C.view === v ? 'on' : ''}">${l}</button>`)
        .join('')}</span></span>
      <label class="id-ctl" title="Lots per idea: the max profit / loss and the trade saved use this size">Lots <input class="num xs" type="number" min="1" step="1" id="idLots" value="${lots()}"></label>
      <span class="id-ctl" title="How far the bought wing of a spread sits from its short / long strike">Wing <span class="seg sm">${WINGS.map((w) => `<button data-wing="${w}" class="${C.wing === w ? 'on' : ''}">${w} pts</button>`).join('')}</span></span>
      <span class="id-ctl" title="Bid/Ask: buy at the ask and sell at the bid, what a fill would really cost. LTP: the last traded prices.">Prices <span class="seg sm">${[
        ['ltp', 'LTP'],
        ['ba', 'Bid / Ask'],
      ]
        .map(([v, l]) => `<button data-basis="${v}" class="${C.basis === v ? 'on' : ''}">${l}</button>`)
        .join('')}</span></span>
      <label class="id-ctl" title="Capital per strategy: the max loss of each idea is shown as a share of it">Capital ₹ <input class="num wide" type="number" min="0" step="50000" id="idCap" value="${C.capital}"></label>
      <label class="id-ctl" title="Best trades and Miscellaneous only take trades whose max loss, after charges, is at most this share of the capital">Max loss ≤ <input class="num xs" type="number" min="0.1" step="0.5" id="idRisk" value="${C.riskCap}"> %</label>`;
  }
  function draw(force) {
    if (state.view !== 'ideas') return;
    if (!force && (pressed || Date.now() - drawnAt < 900)) return;
    drawnAt = Date.now();
    const p = state.pulse;
    M = marketOf(state.data);
    const cands = M ? candidates(M) : [];
    const lists = M
      ? { vert: verticals(M, p), buy: buyers(M, p), write: writers(M, p), neutral: neutral(M), arbx: arbitrages(M), misc: misc(cands) }
      : { vert: [], buy: [], write: [], neutral: [], arbx: [], misc: [] };
    if (!M) for (const l of Object.values(lists)) l.empty = 'Waiting for the live option chain…';
    ideas = new Map(Object.values(lists).flatMap((l) => l.map((I) => [I.id, I])));
    const arbN = drawArb();
    lists.best = M ? bestTrades(lists, [...arbPool(), ...cands]) : [];
    if (!M) lists.best.empty = 'Waiting for the live option chain…';
    for (const I of lists.best) ideas.set(I.id, I);
    const PU = pulseHtml(
      p,
      lists.buy.find((i) => i.key === 'long'),
    );
    if (selId && !ideas.has(selId)) selId = null;
    if (Date.now() - tradesAt > 30000) loadTrades().then(() => draw(true));
    const counts = {
      best: lists.best.length,
      arbx: lists.arbx.length,
      misc: lists.misc.length,
      arb: arbN,
      pulse: PU.n,
      vert: lists.vert.length,
      buy: lists.buy.length,
      write: lists.write.length,
      neutral: lists.neutral.length,
      mine: trades.length,
    };
    renderTop(p, counts);
    renderChainHead();
    paintChain();
    $('idAsOf').textContent = M
      ? `All ideas priced on the live chain · expiry ${dayShort(M.expiry)} · ${C.basis === 'ba' ? 'bid / ask' : 'last traded'} prices · ${new Date(M.at).toLocaleTimeString('en-IN', { hour12: false })}`
      : '';
    for (const [k] of SECTIONS) {
      const sec = document.querySelector(`#ideas [data-sec="${k}"]`);
      sec.classList.toggle('hidden', C.show !== 'all' && C.show !== k);
      sec.querySelector('.id-count').textContent = k === 'mine' ? `${trades.length} saved` : `${counts[k]} idea${counts[k] === 1 ? '' : 's'}`;
      sec.classList.toggle('collapsed', !!C.collapsed[k]);
      sec.querySelector('.id-sec-head').setAttribute('aria-expanded', String(!C.collapsed[k]));
      if (k === 'pulse') {
        sec.querySelector('.id-count').textContent = PU.word;
        if (!C.collapsed.pulse) setHtml(sec.querySelector('.id-pulse'), PU.html);
        continue;
      }
      if (k === 'arb') {
        sec.querySelector('.id-count').textContent = `${arbN} found`;
        continue;
      }
      if (C.collapsed[k]) continue; // painted when opened again
      if (k === 'mine') {
        setHtml(sec.querySelector('.id-mine-body'), mineHtml());
        continue;
      }
      const L = lists[k];
      const msg = [
        L.info && `<div class="id-note">${esc(L.info)}</div>`,
        L.empty && `<div class="id-empty">${esc(L.empty)}</div>`,
        L.warn && `<div class="id-warn">⚠ ${esc(L.warn)}</div>`,
      ]
        .filter(Boolean)
        .join('');
      setHtml(sec.querySelector('.id-msg'), msg);
      const grid = sec.querySelector('.id-grid');
      const tbl = sec.querySelector('.id-tbl');
      const table = C.view === 'table';
      grid.classList.toggle('hidden', table);
      tbl.classList.toggle('hidden', table ? !L.length : true);
      if (table) {
        if (!tbl.firstChild) tbl.innerHTML = '<table class="grid-tbl id-ideas-tbl"><thead></thead><tbody></tbody></table>';
        setHtml(tbl.querySelector('thead'), theadHtml());
        keyed(tbl.querySelector('tbody'), sorted(L), rowShell, paintRow);
      } else keyed(grid, L, cardShell, paintCard);
    }
  }

  // ---------- Pulse trade idea: Pulse › Option writers & buyers ----------
  // The Pulse screen's own read (state.pulse.play: what writers and buyers are doing, the option it would buy, its
  // target and exit, the reasons) with the writers / buyers activity behind it and the Pulse's paper record of the
  // day. The Pulse reads the nearest expiry; the buttons act on the same option priced on the live chain shown.
  const ACT = { 'long-buildup': 'Long build-up', 'short-buildup': 'Writing', 'short-covering': 'Short covering', 'long-unwinding': 'Unwinding' };
  function pulseHtml(p, I) {
    const y = p?.play;
    if (!y)
      return {
        n: 0,
        word: 'collecting',
        html: '<div class="id-empty">The Pulse is still collecting data: its trade idea needs about 15 minutes of the session.</div>',
      };
    const word =
      y.action === 'BUY' ? `BUY ${y.side === 'CE' ? 'CALL' : 'PUT'}` : y.action === 'WATCH' ? `WATCH ${y.leanSide === 'CE' ? 'CALLS' : 'PUTS'}` : 'WAIT';
    const kind = y.action === 'BUY' ? (y.side === 'CE' ? 'up' : 'down') : y.action === 'WATCH' ? 'watch' : '';
    const k = y.pick;
    const f = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
    const row = (a, b) => `<span class="lk">${a}</span><span>${b}</span>`;
    const strike =
      k && y.action !== 'WAIT'
        ? `<div class="idp-grid">
          ${row('Strike', `<b>${k.strike} ${y.side}</b> <span class="muted">(${esc(k.label)})</span>`)}
          ${row('Price now', `${f(k.ltp)} <span class="muted">· bid ${f(k.bid)} / ask ${f(k.ask)}${k.spreadPct != null ? ` · spread ${f(k.spreadPct)}%` : ''}</span>`)}
          ${row('Why this strike', k.why?.length ? esc(k.why.join('; ')) : 'closest to the money: moves most for the premium paid')}
          ${row('Nifty target', `${f(k.niftyTarget, 0)} <span class="muted">→ option ≈ ${f(k.premiumTarget)}${k.targetCapped ? ` · wall at ${k.targetCapped} may cap it` : ''}</span>`)}
          ${row('Exit if Nifty', `${y.side === 'CE' ? 'falls below' : 'rises above'} ${f(k.niftyStop, 0)} <span class="muted">→ option ≈ ${f(k.premiumStop)}</span>`)}
        </div>`
        : '';
    // the option on the chain shown, filled at its ask, with the card's buttons
    let act = '';
    if (I && y.action !== 'WAIT') {
      const l = I.legs[0];
      act = I.ok
        ? `<div class="idp-act"><span>On the chain shown (${dayShort(I.expiry)}): <b class="pos">BUY</b> ${l.k} ${l.type} @ <b>${f2(l.px)}</b> · max loss <b class="neg">${money(I.E.netMaxL)}</b> for ${lots()} lot${lots() === 1 ? '' : 's'} (premium + charges)</span><span class="idp-btns">${ACTIONS}</span></div>`
        : `<div class="id-unavail">${missingTxt(I)}</div>`;
    }
    const tot = p.oi?.totals;
    const cells = (s) => {
      const vals = Object.keys(ACT).map((c) => tot?.[s]?.[c] || 0);
      const top = Math.max(...vals);
      return vals.map((v) => `<td class="${v && v === top ? 'top' : ''}">${v ? compact(v) : '—'}</td>`).join('');
    };
    const wb = tot
      ? `<table class="grid-tbl idp-wb"><thead><tr><th class="l">Last ${p.oi?.windowMin ?? 15} min, near ATM</th>${Object.values(ACT)
          .map((a) => `<th>${a}</th>`)
          .join('')}</tr></thead>
          <tbody><tr><td class="l ce-t"><b>Calls</b> <span class="muted small">OI added</span></td>${cells('CE')}</tr><tr><td class="l pe-t"><b>Puts</b> <span class="muted small">OI added</span></td>${cells('PE')}</tr></tbody></table>`
      : '';
    const tr = p.trades;
    let rec = '<div class="muted small">No Pulse paper trades yet today.</div>';
    if (tr && (tr.open?.length || tr.closed?.length)) {
      const done = tr.closed.filter((x) => x.pnl != null);
      const net = done.reduce((a, x) => a + x.pnl, 0);
      const rows = [...tr.open.map((x) => ({ ...x, open: true })), ...[...tr.closed].reverse()].slice(0, 6);
      rec = `<div class="idp-recsum"><b class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${done.length ? `${done.filter((x) => x.pnl > 0).length}/${done.length} won · ${money(net)}` : 'no finished trades'}</b> <span class="muted small">per lot, after charges</span></div>
        <table class="grid-tbl idp-rec"><tbody>${rows
          .map(
            (x) =>
              `<tr><td class="muted">${window.app.istClock(x.t)}</td><td class="l">${x.side} ${x.strike}</td><td class="l">${f2(x.px)} → ${x.open ? `<span class="muted">tgt ${f2(x.target)} / stop ${f2(x.stop)}</span>` : x.exitPx == null ? '—' : f2(x.exitPx)}</td><td class="l">${x.open ? 'open' : esc(x.reason || '')}</td><td class="${!x.open && x.pnl > 0 ? 'pos' : !x.open && x.pnl < 0 ? 'neg' : ''}">${x.open || x.pnl == null ? '' : money(x.pnl)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
    }
    const html = `<div class="idp ${I ? 'id-pulse-card' : ''}"${I ? ` data-id="${esc(I.id)}"` : ''}>
      <div class="idp-main">
        <div class="idp-head"><span class="idp-call ${kind}">${word}</span><span class="muted small">Pulse › Option writers &amp; buyers · read on the nearest expiry (${dayShort(nearestExpiry() || '')})</span></div>
        ${y.happening?.length ? `<div class="idp-happening">${y.happening.map(esc).join(' ')}</div>` : ''}
        ${strike}
        ${act}
        ${y.reasons?.length ? `<ul class="idp-reasons ${y.action === 'BUY' ? '' : 'warn'}">${y.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <div class="muted small">Rule-based read of trend, writers / buyers and order flow: <b>no proven edge</b>. Replays on the recorded days did not make money after costs. Judge it by the paper record. Option buying loses fast if the move stalls.</div>
      </div>
      <div class="idp-side">
        ${wb}
        <div class="idp-rechead muted small">PULSE PAPER TRADES · today</div>
        ${rec}
      </div>
    </div>`;
    return { n: y.action === 'WAIT' ? 0 : 1, word, html };
  }

  // ---------- vertical-spread arbitrage: the Chain screen's list ----------
  // Same scan (BT.arb.find), same list (BT.arb.html) and the same settings as Live › Chain, so both show the same
  // spreads; each row also gets a Save button, and its legs are marked in the chain like any idea.
  const arbSet = () => BT.arbChain?.settings || { type: 'ALL', width: 10, lots: 1, basis: 'ba' };
  const arbLots = () => Math.max(1, Math.floor(Number(arbSet().lots)) || 1);
  const arbSave = () => {
    BT.arbChain?.save();
    BT.arbChain?.sync();
  };
  function drawArb() {
    const el = $('idArb');
    if (!BT.arb || !M) {
      setHtml(el, '<div class="muted small">Waiting for the live option chain…</div>');
      return 0;
    }
    const o = arbSet();
    const width = BT.arb.WIDTHS.includes(o.width) ? o.width : 10;
    const found = BT.arb.find(M, { live: true, basis: o.basis });
    // nearest the money first (then the bigger edge), the closest-to-an-arbitrage list included
    const byMoney = (x, y) => x.dist - y.dist || y.edge - x.edge;
    found.sort(byMoney);
    arbFound = found;
    for (const w of Object.keys(found.near || {})) found.near[w].sort(byMoney);
    const r = BT.arb.html(found, M, {
      live: true,
      basis: o.basis,
      width,
      type: o.type,
      lots: arbLots(),
      btn: 'Open in Builder ▸',
      btnTip: 'Open both legs as a paper position in the Builder on the live chain (payoff, P&L and adjustments)',
    });
    // rows keyed by their spread (the list reorders as prices move), in the order the list draws them
    const key = (a) => `arbrow|${a.expiry}|${a.type}|${a.lo}|${a.hi}`;
    let i = 0;
    const html = r.html
      .replace(/<div class="arb-row/g, () => {
        const a = r.shown[i++];
        return `<div data-id="${a ? key(a) : ''}" class="arb-row`;
      })
      .replace(
        /(<button class="btn-sm ghost" data-arb="\d+")/g,
        '<button class="btn-sm kite" data-kite="1" title="Send the legs to Zerodha Kite as real orders (limit orders: buys first, sells only after the buys fill). Asks you to confirm first.">Trade with Zerodha Kite</button>$1',
      )
      .replace(
        /(<button class="btn-sm ghost" data-arb="(\d+)"[^>]*>[^<]*<\/button>)/g,
        '$1<button class="btn-sm" data-arbsave="$2" title="Fill both legs as a live paper trade at the prices shown and save it">＋ Save</button>',
      );
    setHtml(el, html);
    if ($('idArbLots') !== document.activeElement) $('idArbLots').value = arbLots();
    // each row as an idea: a card in Cards view; the row or card marks its legs in the chain and Open / Save work on it
    const nl = arbLots();
    const cards = r.shown.slice(0, 8).map((a) => {
      const real = a.edge >= 0.05; // the arbitrage scan's least edge; below it the list shows the closest pairs
      const I = idea('arb', M, {
        key: 'varb',
        title: `${a.type === 'CE' ? 'Call' : 'Put'} vertical ${a.lo}/${a.hi}`,
        sub: !real
          ? `Not an arbitrage yet: ${(0.05 - a.edge).toFixed(2)} pts short of the minimum edge. One of the closest pairs on this chain.`
          : a.kind === 'free credit'
            ? 'The farther strike is dearer than the nearer one: paid to take a spread that cannot lose at expiry.'
            : 'The pair is priced further apart than the strike gap: the credit is more than the spread can ever cost.',
        tags: [
          real ? ['Arbitrage', 'arb'] : ['Closest, not an arbitrage', 'na'],
          [`${a.edge >= 0 ? '+' : ''}${a.edge.toFixed(2)} pts`, real ? 'ok' : 'warn'],
          fitTag(a.fit, nl),
          ...(o.basis === 'ltp' ? [['LTP: check bid/ask', 'warn']] : []),
        ],
        legs: a.info.map((x) => ({ act: x.act, type: a.type, k: x.k, px: x.px, n: 1, expiry: a.expiry })),
        lots: nl,
        once: true,
        arbitrage: real,
        note: `vertical-spread arbitrage ${a.lo}/${a.hi} ${a.type}`,
      });
      ideas.set(key(a), I);
      ideas.set(I.id, I);
      return I;
    });
    const asCards = C.view !== 'table';
    el.classList.toggle('cards', asCards);
    $('idArbGrid').classList.toggle('hidden', !asCards);
    if (asCards) keyed($('idArbGrid'), cards, cardShell, paintCard);
    return found.filter((a) => a.reach <= width && (o.type === 'ALL' || a.type === o.type)).length;
  }

  // ---------- floating Nifty chart ----------
  // The Market Pulse chart (chain-chart.js mounts it on #ideasChart) in a panel pinned to the top right of the window.
  // Drag the bar to move it, the bottom-right corner to resize it; ▁ folds it to its bar, ✕ hides it (the Chart button
  // brings it back). Position, size and state are remembered.
  const fl = $('idFloat');
  const FL = { x: null, y: null, w: 560, h: 380, min: false, hidden: false, ...BT.store.get('ideasFloat', {}) };
  const saveFl = () => BT.store.set('ideasFloat', FL);
  function placeFloat() {
    const top = Math.round(($('subtabs')?.getBoundingClientRect().bottom ?? 90) + 10);
    const w = Math.min(FL.w, window.innerWidth - 24);
    const h = Math.min(FL.h, window.innerHeight - top - 12);
    Object.assign(fl.style, { width: w + 'px', height: FL.min ? 'auto' : h + 'px' });
    // not moved yet: pinned to the top right; moved: where it was dropped, kept inside the window
    const x = FL.x == null ? window.innerWidth - w - 18 : Math.min(Math.max(0, FL.x), window.innerWidth - Math.min(w, 120));
    const y = FL.y == null ? top : Math.min(Math.max(0, FL.y), window.innerHeight - 40);
    Object.assign(fl.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    fl.classList.toggle('min', FL.min);
    fl.classList.toggle('hidden', FL.hidden);
    $('idChartBtn').classList.toggle('on', !FL.hidden);
  }
  placeFloat();
  window.addEventListener('resize', placeFloat);
  window.addEventListener('viewchange', (e) => e.detail === 'ideas' && setTimeout(placeFloat, 0));
  new ResizeObserver(() => {
    if (FL.min || fl.classList.contains('hidden') || !fl.offsetParent) return;
    FL.w = Math.round(fl.offsetWidth);
    FL.h = Math.round(fl.offsetHeight);
    saveFl();
  }).observe(fl);
  $('idFloatBar').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const sx = e.clientX - fl.offsetLeft;
    const sy = e.clientY - fl.offsetTop;
    const move = (ev) => {
      FL.x = ev.clientX - sx;
      FL.y = ev.clientY - sy;
      placeFloat();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveFl();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  fl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fl]');
    if (!b) return;
    if (b.dataset.fl === 'min') FL.min = !FL.min;
    else FL.hidden = true;
    saveFl();
    placeFloat();
    if (!FL.min) setTimeout(() => window.ideasChart?.refresh(), 0);
  });
  // The chain's chart buttons: the option's chart in the floating chart (brought back if it was hidden or folded).
  function showOptionChart(strike, type) {
    FL.hidden = false;
    FL.min = false;
    saveFl();
    placeFloat();
    window.ideasChart?.showOption({ expiry: M.expiry, strike, type });
    setTimeout(() => window.ideasChart?.refresh(), 0);
  }
  // The chart can also be switched inside itself (Nifty 50 / Nifty Fut / the option tab): the button follows.
  $('ideasChart').addEventListener('ncsource', (e) => {
    chartSel = e.detail?.strike ? e.detail : null;
    if (M) paintChain();
  });
  $('idChartBtn').addEventListener('click', () => {
    FL.hidden = !FL.hidden;
    if (!FL.hidden) FL.min = false;
    saveFl();
    placeFloat();
    setTimeout(() => window.ideasChart?.refresh(), 0);
  });

  // ---------- Trade with Zerodha Kite ----------
  // The legs of an idea as a basket of LIMIT orders (kitebasket.js on the server): the buys first, the sells only once
  // every buy has filled. Nothing is sent before the dialog's own confirmation.
  const dlg = $('kiteDlg');
  const KD = { I: null, lots: 1, orderType: 'LIMIT', product: 'NRML', buffer: 0.5, ack: false, prev: null, err: null, busy: false, result: null, seq: 0 };
  const KITE_FREEZE = 1800; // Nifty's freeze quantity for one order (kitebasket.js refuses more)
  const maxN = (I) => Math.max(...I.legs.map((l) => l.n || 1));
  const maxLots = (I) => Math.max(1, Math.floor(KITE_FREEZE / (lotSize() * maxN(I))));
  // the legs as the server wants them: KD.lots lots of the strategy, each leg times its own weight
  const kiteLegs = (I) =>
    I.legs.map((l) => ({ action: l.act, type: l.type, strike: l.k, expiry: l.expiry || I.expiry, lots: KD.lots * (l.n || 1), price: l.px }));
  async function kitePreview() {
    const seq = ++KD.seq;
    try {
      const prev = await BT.api('/api/kite/basket/preview', {
        legs: kiteLegs(KD.I),
        product: KD.product,
        buffer: KD.buffer,
        orderType: KD.orderType,
        strategyLots: KD.lots,
      });
      if (seq === KD.seq) Object.assign(KD, { prev, err: null });
    } catch (e) {
      if (seq === KD.seq) Object.assign(KD, { prev: null, err: e.message });
    }
    renderKite();
  }
  function openKite(I) {
    Object.assign(KD, { I, lots: Math.min(maxLots(I), I.lots || lots()), ack: false, prev: null, err: null, result: null, busy: false });
    dlg.classList.remove('hidden');
    window.KiteLogin?.refresh();
    renderKite();
    kitePreview();
  }
  function closeKite() {
    if (!KD.busy) dlg.classList.add('hidden');
  }
  // How many lots of this strategy to take: what the funds cover (Kite's margin for the basket, else the larger of the
  // debit and the max loss), what the loss limit set on this screen allows, and Nifty's freeze quantity.
  function kiteSuggest(I, P) {
    const E1 = I.calendar ? calendarE({ ...I, lots: 1 }, I.M) : evaluate({ ...I, lots: 1 }, I.M);
    const lossPerLot = E1.maxL === -Infinity ? null : Math.max(0, -E1.netMaxL);
    const debitPerLot = Math.max(0, -E1.net);
    const marginPerLot = P?.margin?.perLot > 0 ? P.margin.perLot : null;
    const needPerLot = marginPerLot ?? (lossPerLot != null ? Math.max(debitPerLot, lossPerLot) : null);
    const avail = P?.funds?.available ?? null;
    const byFunds = avail != null && needPerLot > 0 ? Math.floor((avail * 0.9) / needPerLot) : null;
    const limitCash = (C.capital * C.riskCap) / 100;
    const byRisk = lossPerLot > 0 && limitCash > 0 ? Math.floor(limitCash / lossPerLot) : null;
    const cap = maxLots(I);
    const pick = [byFunds, byRisk, cap].filter((x) => x != null);
    return { avail, needPerLot, marginPerLot, lossPerLot, byFunds, byRisk, cap, limitCash, best: Math.min(...pick), marginErr: P?.margin?.error };
  }
  function renderKite() {
    if (dlg.classList.contains('hidden') || !KD.I) return;
    const I = KD.I;
    const P = KD.prev;
    const k = window.KiteLogin?.status;
    const demo = window.KiteLogin?.demo();
    const loggedIn = demo || k?.loggedIn;
    const market = KD.orderType === 'MARKET';
    $('kdLogin').classList.toggle('kd-in', !!loggedIn);
    $('kdSub').textContent = `${I.title} · ${dayShort(I.expiry)} · prices as of ${new Date(I.M.at).toLocaleTimeString('en-IN', { hour12: false })}`;
    // the figures for the lots chosen here, not the lots the card was computed for
    const E = I.calendar ? calendarE({ ...I, lots: KD.lots }, I.M) : evaluate({ ...I, lots: KD.lots }, I.M);
    const F = figs({ E });
    const rows = (P?.legs || kiteLegs(I).map((l) => ({ ...l, action: l.action === 'B' ? 'BUY' : 'SELL', symbol: '…', qty: l.lots * lotSize(), limit: null })))
      .slice()
      .sort((a, b) => (a.action === b.action ? 0 : a.action === 'BUY' ? -1 : 1));
    const step = (a) => (a === 'BUY' ? '1 · first' : '2 · after the buys fill');
    let body;
    if (KD.result) {
      const R = KD.result;
      body = `<div class="kd-banner ${R.status === 'done' ? 'ok' : 'bad'}"><b>${R.status === 'done' ? 'All legs filled' : R.status === 'stopped' ? 'Stopped: nothing was sold' : R.status === 'partial' ? 'Partly filled: check Kite' : 'Not placed'}</b> ${esc(R.message)}${R.demo ? ' <span class="muted">(demo: simulated)</span>' : ''}</div>
        ${
          R.legs.length
            ? `<table class="grid-tbl kd-legs"><thead><tr><th class="l">Leg</th><th class="l">Instrument</th><th>Qty</th><th>${R.orderType === 'MARKET' ? 'Order' : 'Limit'}</th><th class="l">Order id</th><th class="l">Status</th><th>Filled</th><th>Avg</th></tr></thead><tbody>${R.legs
                .map(
                  (l) =>
                    `<tr><td class="l"><span class="id-act ${l.action === 'BUY' ? 'b' : 's'}">${l.action}</span></td><td class="l">${esc(l.symbol)}</td><td>${l.qty}</td><td>${R.orderType === 'MARKET' ? 'Market' : f2(l.limit)}</td><td class="l muted">${esc(l.id || '—')}</td><td class="l ${l.status === 'COMPLETE' ? 'pos' : l.status === 'PENDING' || l.status === 'PLACED' ? '' : 'neg'}">${esc(l.status)}${l.msg ? ` <span class="muted small">${esc(l.msg)}</span>` : ''}</td><td>${l.filled || 0}</td><td>${l.avg ? f2(l.avg) : '—'}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : ''
        }
        <div class="kd-foot"><button class="btn-sm" data-kd="close">Close</button></div>`;
    } else {
      // at the prices shown for a market order, at the limits for a limit order
      const net = P ? P.legs.reduce((a, l) => a + (l.action === 'SELL' ? 1 : -1) * (l.limit ?? l.price) * l.qty, 0) : null;
      const why = !loggedIn ? 'Log in to Kite above first.' : KD.err || P?.gate || null;
      const can = !!(P && loggedIn && !P.gate && !KD.err);
      const S = kiteSuggest(I, P);
      const suggest = (() => {
        const bits = [];
        if (S.avail != null) bits.push(`Funds available <b>${inr(S.avail)}</b>`);
        else bits.push(demo ? 'Funds are not read in demo mode' : loggedIn ? 'Funds could not be read' : 'Log in to see your funds');
        if (S.needPerLot != null)
          bits.push(
            `one lot of this strategy needs about <b>${inr(S.needPerLot)}</b> <span class="muted">(${S.marginPerLot ? 'margin by Kite, hedges counted' : S.marginErr ? 'estimate: the larger of the debit and the max loss, Kite margin unavailable' : 'estimate: the larger of the debit and the max loss'})</span>`,
          );
        const lines = [];
        if (S.byFunds != null) lines.push(`funds cover up to <b>${S.byFunds}</b> lot${S.byFunds === 1 ? '' : 's'} (keeping 10% spare)`);
        if (S.byRisk != null)
          lines.push(
            `your loss limit (${C.riskCap}% of ${inr(C.capital)} = ${inr(S.limitCash)}) allows <b>${S.byRisk}</b> (max loss ${inr(S.lossPerLot)} a lot)`,
          );
        lines.push(`one order can hold at most <b>${S.cap}</b> lots (freeze quantity)`);
        const best = S.best;
        return `<div class="kd-suggest"><div>${bits.join(' · ')}</div><div class="muted small">${lines.join(' · ')}</div>${
          S.avail != null || S.byRisk != null
            ? best >= 1
              ? `<div><b>Suggested: ${best} lot${best === 1 ? '' : 's'}</b>${best === KD.lots ? ' <span class="muted">(selected)</span>' : ` <button class="btn-sm ghost" data-kd="uselots" data-lots="${best}">Use ${best} lot${best === 1 ? '' : 's'}</button>`}</div>`
              : '<div class="neg"><b>The funds or the loss limit do not cover even one lot of this strategy.</b></div>'
            : ''
        }</div>`;
      })();
      body = `<div class="kd-idea">${F ? `<span>Max profit <b class="${F.maxP.c}">${F.maxP.v}</b></span><span>${F.maxL.label} <b class="${F.maxL.c}">${F.maxL.v}</b></span><span>${F.net.label} <b>${F.net.v}</b></span>` : ''}${P?.user ? `<span>Account <b>${esc(P.user)}</b></span>` : ''}</div>
        <table class="grid-tbl kd-legs"><thead><tr><th class="l">Step</th><th class="l">Leg</th><th class="l">Kite instrument</th><th>Lots</th><th>Qty</th><th>Price shown</th><th>${market ? 'Order' : 'Limit order'}</th></tr></thead><tbody>${rows
          .map(
            (l) =>
              `<tr><td class="l muted small">${step(l.action)}</td><td class="l"><span class="id-act ${l.action === 'BUY' ? 'b' : 's'}">${l.action}</span></td><td class="l">${esc(l.symbol)}</td><td>${l.lots}</td><td>${l.qty}</td><td>${f2(l.price)}</td><td><b>${market ? 'Market' : l.limit ? f2(l.limit) : '…'}</b></td></tr>`,
          )
          .join('')}</tbody></table>
        <div class="kd-set">
          <label class="id-ctl" title="Lots of the strategy: every leg is multiplied by it (a leg sold twice is sold twice as many lots)">Lots <input class="num xs" type="number" id="kdLots" min="1" max="${maxLots(I)}" step="1" value="${KD.lots}"></label>
          <span class="id-ctl" title="Limit: at the price shown, moved by the buffer towards a fill. Market: fills at once at the best price on the book, which can be worse than the price shown, most of all in far strikes.">Order <span class="seg sm"><button data-kd="otype" data-v="LIMIT" class="${market ? '' : 'on'}">Limit</button><button data-kd="otype" data-v="MARKET" class="${market ? 'on' : ''}">Market price</button></span></span>
          ${market ? '' : `<label class="id-ctl" title="Points added to a buy's price and taken off a sell's, so a quote that moved a tick still fills. Rounded to the 0.05 tick.">Limit buffer <input class="num xs" type="number" id="kdBuffer" min="0" max="5" step="0.25" value="${KD.buffer}"> pts</label>`}
          <label class="id-ctl">Product <select id="kdProduct"><option value="NRML" ${KD.product === 'NRML' ? 'selected' : ''}>NRML (carry)</option><option value="MIS" ${KD.product === 'MIS' ? 'selected' : ''}>MIS (intraday)</option></select></label>
          <button class="btn-sm ghost" data-kd="refresh" title="Take the prices of the idea as they are now">↻ Prices</button>
          ${net != null ? `<span class="kd-net">${net >= 0 ? 'Credit' : 'Debit'} ${market ? 'at the prices shown' : 'at the limits'} <b>${inr(Math.abs(net))}</b> · charges ≈ <b>${inr(E.charges)}</b></span>` : ''}
        </div>
        ${suggest}
        <div class="kd-note muted small">${
          market
            ? '<b>Market orders</b> fill at once at the best price on the book: the price paid can be worse than the price shown, and the quantity is not capped by a price.'
            : 'Limit orders at the price shown ± the buffer.'
        } The <b>BUY legs go first</b>; the SELL legs are sent only when every BUY has filled, so the shorts are never uncovered. A BUY that has not filled after about 20 s is cancelled and nothing is sold. These are <b>real orders</b> on your Kite account.</div>
        ${why ? `<div class="kd-banner bad">${esc(why)}</div>` : ''}
        <label class="kd-ack"><input type="checkbox" id="kdAck" ${KD.ack ? 'checked' : ''} ${can ? '' : 'disabled'}> I understand these are real orders${P?.user ? ` on Kite account <b>${esc(P.user)}</b>` : ''}${demo ? ' (demo: simulated)' : ''}</label>
        <div class="kd-foot"><button class="btn-sm ghost" data-kd="close">Cancel</button><button class="btn-sm kite" data-kd="place" ${can && KD.ack && !KD.busy ? '' : 'disabled'}>${KD.busy ? 'Placing…' : `Place ${rows.length} ${market ? 'market ' : ''}order${rows.length === 1 ? '' : 's'} on Kite`}</button></div>`;
    }
    setHtml($('kdBody'), body);
  }
  async function placeKite() {
    KD.busy = true;
    renderKite();
    try {
      KD.result = await BT.api('/api/kite/basket', {
        legs: kiteLegs(KD.I),
        product: KD.product,
        buffer: KD.buffer,
        orderType: KD.orderType,
        confirmed: true,
        name: KD.I.title,
      });
    } catch (e) {
      KD.result = { ok: false, status: 'error', message: e.message, legs: [] };
    }
    KD.busy = false;
    renderKite();
  }
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kd]');
    if (e.target === dlg) return closeKite();
    if (!b) return;
    if (b.dataset.kd === 'close') closeKite();
    else if (b.dataset.kd === 'place' && KD.ack && !KD.busy) placeKite();
    else if (b.dataset.kd === 'otype') {
      KD.orderType = b.dataset.v === 'MARKET' ? 'MARKET' : 'LIMIT';
      KD.ack = false;
      renderKite();
      kitePreview();
    } else if (b.dataset.kd === 'uselots') {
      KD.lots = Math.min(maxLots(KD.I), Math.max(1, Math.floor(Number(b.dataset.lots)) || 1));
      KD.ack = false;
      renderKite();
      kitePreview();
    } else if (b.dataset.kd === 'refresh') {
      KD.I = ideas.get(KD.I.id) || KD.I;
      KD.ack = false;
      renderKite();
      kitePreview();
    }
  });
  dlg.addEventListener('change', (e) => {
    if (e.target.id === 'kdAck') KD.ack = e.target.checked;
    else if (e.target.id === 'kdLots') {
      KD.lots = Math.min(maxLots(KD.I), Math.max(1, Math.floor(Number(e.target.value)) || 1));
      KD.ack = false;
      kitePreview();
    } else if (e.target.id === 'kdProduct') {
      KD.product = e.target.value === 'MIS' ? 'MIS' : 'NRML';
      KD.ack = false;
      kitePreview();
    } else if (e.target.id === 'kdBuffer') {
      KD.buffer = Math.min(5, Math.max(0, Number(e.target.value) || 0));
      KD.ack = false;
      kitePreview();
    } else return;
    renderKite();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeKite());
  window.addEventListener('kitechange', () => {
    if (!dlg.classList.contains('hidden') && !KD.result) kitePreview();
  });
  window.KiteLogin?.mount($('kdLogin'));

  // ---------- to the Builder ----------
  function toBuilder(I, saveAs) {
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this idea?')) return;
    BT.emit('open-builder', {
      src: 'live',
      expiry: I.expiry,
      note: I.note || `${I.title} (Ideas)`,
      save: saveAs || null,
      legs: I.legs.map((l) => ({ action: l.act, type: l.type, strike: l.k, expiry: l.expiry || I.expiry, lots: (I.lots || lots()) * (l.n || 1), px: l.px })),
    });
  }

  const root = $('ideas');
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select')) pressed = true;
  });
  window.addEventListener('pointerup', () => setTimeout(() => (pressed = false), 0));
  // the idea under the mouse marks its legs in the chain
  root.addEventListener('mouseover', (e) => {
    const id = e.target.closest('.id-card, .id-ideas-tbl tr[data-id], .arb-row[data-id], .id-pulse-card[data-id]')?.dataset.id || null;
    if (id === hoverId) return;
    hoverId = id;
    if (M) paintChain();
  });
  function toggleSection(k) {
    C.collapsed[k] = !C.collapsed[k];
    saveC();
    draw(true);
  }
  root.addEventListener('keydown', (e) => {
    const head = e.target.closest?.('.id-sec-head');
    if (head && e.target === head && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleSection(head.closest('.id-sec').dataset.sec);
    }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.chart && M) {
      const [k, t] = b.dataset.chart.split('|');
      return showOptionChart(Number(k), t);
    }
    // a click on a section's header (not on a control in it) folds / unfolds the section
    const head = e.target.closest('.id-sec-head');
    if (head && !e.target.closest('button, input, select, label, a')) return toggleSection(head.closest('.id-sec').dataset.sec);
    const holder = e.target.closest('.id-card, .id-ideas-tbl tr[data-id], .arb-row[data-id], .id-pulse-card[data-id]');
    const I = holder && ideas.get(holder.dataset.id);
    if (!b) {
      // a click on an idea (not on its buttons) keeps its legs marked in the chain
      if (I && !e.target.closest('input, select, a')) {
        selId = selId === I.id ? null : I.id;
        root
          .querySelectorAll('.id-card, .id-ideas-tbl tr[data-id], .arb-row[data-id], .id-pulse-card[data-id]')
          .forEach((el) => el.classList.toggle('sel', el.dataset.id === selId));
        paintChain();
      }
      return;
    }
    pressed = false;
    if (b.dataset.kite && I) return openKite(I);
    if (b.dataset.open && I) return toBuilder(I);
    if (b.dataset.save && I) {
      const name = prompt('Save this paper trade as', `${I.title} · ${dayShort(I.expiry)}`);
      if (name) toBuilder(I, name);
      return;
    }
    if (b.dataset.arb != null || b.dataset.arbsave != null) {
      const A = ideas.get(b.closest('.arb-row')?.dataset.id);
      if (!A) return;
      if (b.dataset.arb != null) return toBuilder(A);
      const name = prompt('Save this paper trade as', `Arbitrage ${A.title.replace(' vertical', '')} · ${dayShort(A.expiry)}`);
      if (name) toBuilder(A, name);
      return;
    }
    if (b.dataset.af || b.dataset.aw || b.dataset.ab) {
      const o = arbSet();
      if (b.dataset.af) o.type = b.dataset.af;
      else if (b.dataset.aw) o.width = Number(b.dataset.aw);
      else o.basis = b.dataset.ab;
      arbSave();
      return draw(true);
    }
    if (b.dataset.trade) return BT.emit('open-trade', b.dataset.trade);
    if (b.dataset.alltrades) return window.app.setView('tr');
    if (b.dataset.unsel) {
      selId = null;
      root.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
      return paintChain();
    }
    if (b.dataset.sort) {
      const k = b.dataset.sort;
      C.sort = C.sort?.key !== k ? { key: k, dir: -1 } : C.sort.dir < 0 ? { key: k, dir: 1 } : null; // high first, low first, off
    } else if (b.dataset.show) C.show = b.dataset.show;
    else if (b.dataset.layout) C.view = b.dataset.layout;
    else if (b.dataset.wing) C.wing = Number(b.dataset.wing);
    else if (b.dataset.basis) C.basis = b.dataset.basis;
    else if (b.dataset.chainw) {
      C.chainW = Number(b.dataset.chainw);
      centredFor = null;
    } else return;
    saveC();
    renderControls();
    draw(true);
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'idExp') {
      // the chain's expiry is the top bar's: the whole live group follows it
      const top = $('expiry');
      top.value = e.target.value;
      top.dispatchEvent(new Event('change'));
      return;
    }
    if (e.target.id === 'idArbLots') {
      arbSet().lots = Math.max(1, Math.floor(Number(e.target.value)) || 1);
      arbSave();
      return draw(true);
    }
    if (e.target.id === 'idLots') C.lots = Math.max(1, Math.floor(Number(e.target.value)) || 1);
    else if (e.target.id === 'idCap') C.capital = Math.max(0, Number(e.target.value) || 0);
    else if (e.target.id === 'idRisk') C.riskCap = Math.max(0.1, Number(e.target.value) || 2);
    else return;
    saveC();
    draw(true);
  });

  window.onIdeasRender = () => draw(false);
  window.addEventListener('viewchange', (e) => {
    if (e.detail !== 'ideas') return;
    centredFor = null;
    BT.loadMeta()
      .catch(() => {})
      .then(() => draw(true));
    loadTrades().then(() => draw(true));
  });
  renderControls();
  if (state.view === 'ideas') loadTrades().then(() => draw(true));
})();
