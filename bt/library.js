// Ready-made strategies. All are defined relative to the market (ATM offsets, premium, delta, expiry
// "current / next"), so each one can be backtested on any past expiry and deployed on any future one.
// "OTM n" = n strikes away from ATM on the out-of-the-money side (negative = in the money).
const atm = (n = 0) => ({ by: 'atm', value: n });
const prem = (v, match = 'closest') => ({ by: 'premium', value: v, match });
const dlt = (v) => ({ by: 'delta', value: v, match: 'closest' });
const pct = (v) => ({ type: 'pct', value: v });
const pts = (v) => ({ type: 'pts', value: v });
const leg = (action, type, strike, o = {}) => ({ action, type, lots: o.lots || 1, expiry: o.expiry || 'cur', strike, sl: o.sl || null, tgt: o.tgt || null, trail: o.trail || null, re: o.re || null });

const intraday = (entry = '09:20', exit = '15:15', extra = {}) => ({ mode: 'intraday', expiry: 'weekly', entry: { time: entry, days: [1, 2, 3, 4, 5], dte: [], ...extra }, exit: { time: exit } });
const positional = (entryDte, entry, exitDte, exit, expiry = 'weekly') => ({ mode: 'positional', expiry, entry: { time: entry, dteDays: entryDte }, exit: { time: exit, dteDays: exitDte } });

// The bi-weekly hedge and its variants (see the LIBRARY entries below). o: { shortCall, shortPut, callExpiry, roll, risk, filters }
function biweekly(id, name, desc, o = {}) {
  const lots = 5;
  return {
    id, category: 'Calendar', name, desc,
    mode: 'positional', expiry: 'weekly',
    entry: { time: '09:20', dteDays: 0, after: 2, noOverlap: true }, // the day after the expiry 2 series before the 2-week expiry
    exit: { time: '15:15', dteDays: 0 },
    legs: [
      leg('S', 'CE', o.shortCall || prem(105), { lots, expiry: 'next' }),
      leg('S', 'PE', o.shortPut || prem(120), { lots, expiry: 'next' }),
      leg('B', 'PE', { by: 'leg', ref: 1, value: -100 }, { lots, expiry: 'next' }),
      { ...leg('B', 'CE', { by: 'leg', ref: 0, value: 100 }, { lots, expiry: o.callExpiry || 'cur' }), roll: o.roll === false ? null : { dteDays: 1, time: '15:15' } },
    ],
    risk: o.risk || { unit: 'pct', tgt: 2.5 },
    filters: o.filters || { minCredit: 90, maxLossDown: 10 },
  };
}

const LIBRARY = [
  // ---- Neutral: sell premium ----
  {
    id: 'lib-straddle-920', category: 'Neutral', name: '9:20 Short Straddle (25% SL)',
    desc: 'Sell ATM call and put at 09:20, 25% stop-loss on each leg, exit 15:15. The classic intraday premium-selling setup.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm(), { sl: pct(25) }), leg('S', 'PE', atm(), { sl: pct(25) })],
  },
  {
    id: 'lib-straddle-920-re', category: 'Neutral', name: '9:20 Straddle with re-entry',
    desc: 'Same as the 9:20 straddle, but a stopped-out leg is sold again at the fresh ATM strike (up to 2 times).',
    ...intraday('09:20', '15:15'),
    legs: [
      leg('S', 'CE', atm(), { sl: pct(25), re: { on: 'sl', mode: 'atm', max: 2 } }),
      leg('S', 'PE', atm(), { sl: pct(25), re: { on: 'sl', mode: 'atm', max: 2 } }),
    ],
  },
  {
    id: 'lib-straddle-cost', category: 'Neutral', name: 'Straddle, SL to cost',
    desc: 'Sell ATM straddle at 09:30 with 30% leg stops. When one leg is stopped, the other leg\'s stop moves to its entry price.',
    ...intraday('09:30', '15:15'),
    legs: [leg('S', 'CE', atm(), { sl: pct(30) }), leg('S', 'PE', atm(), { sl: pct(30) })],
    risk: { slToCost: true },
  },
  {
    id: 'lib-straddle-trail', category: 'Neutral', name: 'Straddle, MTM lock & trail',
    desc: 'ATM straddle at 09:20 with an overall ₹4,000 stop. Once up ₹2,000 it locks ₹500, then trails ₹500 for every ₹1,000 more.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm(), { sl: pct(40) }), leg('S', 'PE', atm(), { sl: pct(40) })],
    risk: { sl: 4000, lockAt: 2000, lockTo: 500, trailEvery: 1000, trailBy: 500 },
  },
  {
    id: 'lib-strangle-prem', category: 'Neutral', name: 'Short Strangle (₹50 premium)',
    desc: 'Sell the call and put trading closest to ₹50 at 09:20, 50% stop on each, exit 15:15.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', prem(50), { sl: pct(50) }), leg('S', 'PE', prem(50), { sl: pct(50) })],
  },
  {
    id: 'lib-expiry-straddle', category: 'Neutral', name: 'Expiry-day Straddle',
    desc: 'Only on expiry day: sell the ATM straddle at 09:30 with 30% leg stops and trailing stops, exit 15:20.',
    ...intraday('09:30', '15:20', { dte: [0] }),
    legs: [
      leg('S', 'CE', atm(), { sl: pct(30), trail: { x: 10, y: 5 } }),
      leg('S', 'PE', atm(), { sl: pct(30), trail: { x: 10, y: 5 } }),
    ],
  },
  {
    id: 'lib-iron-condor', category: 'Neutral', name: 'Intraday Iron Condor',
    desc: 'Sell OTM 2 call and put, buy OTM 6 wings. Defined risk, lower margin.',
    ...intraday('09:20', '15:15'),
    legs: [
      leg('S', 'CE', atm(2), { sl: pct(50) }), leg('S', 'PE', atm(2), { sl: pct(50) }),
      leg('B', 'CE', atm(6)), leg('B', 'PE', atm(6)),
    ],
  },
  {
    id: 'lib-iron-fly', category: 'Neutral', name: 'Iron Butterfly',
    desc: 'Sell ATM straddle, buy wings 4 strikes away. Overall stop ₹3,000, target ₹3,000.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm()), leg('S', 'PE', atm()), leg('B', 'CE', atm(4)), leg('B', 'PE', atm(4))],
    risk: { sl: 3000, tgt: 3000 },
  },
  {
    id: 'lib-weekly-strangle', category: 'Neutral', name: 'Weekly Strangle (0.2 delta)',
    desc: 'Positional: 4 trading days before expiry sell 0.2-delta call and put at 09:20, hold to expiry 15:20. Overall stop ₹6,000.',
    ...positional(4, '09:20', 0, '15:20'),
    legs: [leg('S', 'CE', dlt(0.2)), leg('S', 'PE', dlt(0.2))],
    risk: { sl: 6000 },
  },
  {
    id: 'lib-weekly-ic', category: 'Neutral', name: 'Weekly Iron Condor (positional)',
    desc: '3 days before expiry: sell 0.25-delta call and put, buy wings 5 strikes further. Hold to expiry.',
    ...positional(3, '09:30', 0, '15:20'),
    legs: [
      leg('S', 'CE', dlt(0.25)), leg('S', 'PE', dlt(0.25)),
      leg('B', 'CE', { by: 'pct', value: 2.5 }), leg('B', 'PE', { by: 'pct', value: 2.5 }),
    ],
  },
  {
    id: 'lib-monthly-ic', category: 'Neutral', name: 'Monthly Iron Condor',
    desc: 'Multi-week: 15 trading days before the monthly expiry sell 0.15-delta options, buy 4%-OTM wings, exit 2 days before expiry.',
    ...positional(15, '10:00', 2, '15:15', 'monthly'),
    legs: [
      leg('S', 'CE', dlt(0.15), { expiry: 'mcur' }), leg('S', 'PE', dlt(0.15), { expiry: 'mcur' }),
      leg('B', 'CE', { by: 'pct', value: 4 }, { expiry: 'mcur' }), leg('B', 'PE', { by: 'pct', value: 4 }, { expiry: 'mcur' }),
    ],
    risk: { sl: 10000 },
  },
  {
    id: 'lib-underlying-sl', category: 'Neutral', name: 'Straddle, Nifty-move stop',
    desc: 'Sell ATM straddle at 09:20; a leg exits if Nifty moves 0.5% against it.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm(), { sl: { type: 'upct', value: 0.5 } }), leg('S', 'PE', atm(), { sl: { type: 'upct', value: 0.5 } })],
  },

  // ---- Bullish ----
  {
    id: 'lib-bull-call', category: 'Bullish', name: 'Bull Call Spread',
    desc: 'Buy ATM call, sell OTM 4 call. Limited risk, limited reward.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('S', 'CE', atm(4))],
  },
  {
    id: 'lib-bull-put', category: 'Bullish', name: 'Bull Put Spread (weekly)',
    desc: 'Positional credit spread: 2 days before expiry sell OTM 1 put, buy OTM 5 put, hold to expiry.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('S', 'PE', atm(1)), leg('B', 'PE', atm(5))],
  },
  {
    id: 'lib-long-call', category: 'Bullish', name: 'Long Call (momentum)',
    desc: 'Buy ATM call at 09:30 with 30% stop and 60% target.',
    ...intraday('09:30', '15:15'),
    legs: [leg('B', 'CE', atm(), { sl: pct(30), tgt: pct(60) })],
  },
  {
    id: 'lib-jade-lizard', category: 'Bullish', name: 'Jade Lizard',
    desc: 'Sell OTM 2 put, sell OTM 2 call, buy OTM 6 call. No upside risk when the credit exceeds the call spread width.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'PE', atm(2), { sl: pct(50) }), leg('S', 'CE', atm(2)), leg('B', 'CE', atm(6))],
  },
  {
    id: 'lib-call-ratio', category: 'Bullish', name: 'Call Ratio Spread 1×2',
    desc: 'Buy 1 ATM call, sell 2 OTM 3 calls. Profits in a mild rise; risk on a big rally.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('S', 'CE', atm(3), { lots: 2 })],
    risk: { sl: 4000 },
  },

  // ---- Bearish ----
  {
    id: 'lib-bear-put', category: 'Bearish', name: 'Bear Put Spread',
    desc: 'Buy ATM put, sell OTM 4 put.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'PE', atm()), leg('S', 'PE', atm(4))],
  },
  {
    id: 'lib-bear-call', category: 'Bearish', name: 'Bear Call Spread (weekly)',
    desc: 'Positional credit spread: 2 days before expiry sell OTM 1 call, buy OTM 5 call, hold to expiry.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('S', 'CE', atm(1)), leg('B', 'CE', atm(5))],
  },
  {
    id: 'lib-long-put', category: 'Bearish', name: 'Long Put (momentum)',
    desc: 'Buy ATM put at 09:30 with 30% stop and 60% target.',
    ...intraday('09:30', '15:15'),
    legs: [leg('B', 'PE', atm(), { sl: pct(30), tgt: pct(60) })],
  },
  {
    id: 'lib-put-ratio', category: 'Bearish', name: 'Put Ratio Spread 1×2',
    desc: 'Buy 1 ATM put, sell 2 OTM 3 puts.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'PE', atm()), leg('S', 'PE', atm(3), { lots: 2 })],
    risk: { sl: 4000 },
  },

  // ---- Volatility: buy premium ----
  {
    id: 'lib-long-straddle', category: 'Volatility', name: 'Long Straddle',
    desc: 'Buy ATM call and put at 09:20. Target ₹3,000, stop ₹2,000 overall. Wins on big moves.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('B', 'PE', atm())],
    risk: { sl: 2000, tgt: 3000 },
  },
  {
    id: 'lib-long-strangle', category: 'Volatility', name: 'Long Strangle',
    desc: 'Buy OTM 2 call and put. Cheaper than a straddle, needs a bigger move.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm(2)), leg('B', 'PE', atm(2))],
    risk: { sl: 1500, tgt: 3000 },
  },
  {
    id: 'lib-buy-sl-hunt', category: 'Volatility', name: 'Straddle buy, trailing',
    desc: 'Buy ATM straddle at 09:20 with 20% leg stops and a trailing stop (every 10% up, trail 10%).',
    ...intraday('09:20', '15:15'),
    legs: [
      leg('B', 'CE', atm(), { sl: pct(20), trail: { x: 10, y: 10 } }),
      leg('B', 'PE', atm(), { sl: pct(20), trail: { x: 10, y: 10 } }),
    ],
  },

  // ---- Calendars / multi-expiry ----
  {
    id: 'lib-calendar', category: 'Calendar', name: 'Call Calendar Spread',
    desc: 'Positional: 3 days before expiry sell this week\'s ATM call, buy next week\'s ATM call; close on expiry day.',
    ...positional(3, '09:30', 0, '15:15'),
    legs: [leg('S', 'CE', atm()), leg('B', 'CE', atm(), { expiry: 'next' })],
  },
  {
    id: 'lib-double-calendar', category: 'Calendar', name: 'Double Calendar',
    desc: 'Sell this week\'s OTM 2 call and put, buy next week\'s same strikes. Profits from faster decay of the near week.',
    ...positional(3, '09:30', 0, '15:15'),
    legs: [
      leg('S', 'CE', atm(2)), leg('S', 'PE', atm(2)),
      leg('B', 'CE', atm(2), { expiry: 'next' }), leg('B', 'PE', atm(2), { expiry: 'next' }),
    ],
  },
  // ---- Bi-weekly hedge (Advanced Bi-Weekly Option Strategy playbook) ----
  // Enter the day after a weekly expiry (start of a new series). Sell a ~₹105 call and a ~₹120 put in the 2-week
  // expiry, buy the put 100 below the short put (same expiry) and the call 100 above the short call in the cheaper
  // near week. The near-week call is rolled into the 2-week expiry the trading day before it expires, 15:15.
  // Enter only when the net credit is ≥ 90 pts and the put-spread risk is covered (≤ 10 pts loss far below).
  // Amounts are % of capital: set Capital to ₹1 L per lot (₹5 L for these 5 lots) in the settings bar.
  // The playbook version itself is the user's own saved strategy "BiWeekly Hedge-Hari" (bt-data/strategies.json);
  // these are the variants to compare it with.
  biweekly('lib-biweekly-partial', 'Bi-weekly Hedge, partial booking',
    'As BiWeekly Hedge-Hari, but instead of a full target: at +3.6% book 60% of the lots (3 of 5) and keep a +1.4% floor; the rest runs to the 2-week expiry.',
    { risk: { unit: 'pct', partialAt: 3.6, partialPct: 60, partialFloor: 1.4 } }),
  biweekly('lib-biweekly-noroll', 'Bi-weekly Hedge, no Monday roll',
    'What a missed roll costs: identical, but the near-week call simply expires, leaving the short call unhedged in week 2.',
    { roll: false }),
  biweekly('lib-biweekly-ic', 'Bi-weekly Iron Condor (same expiry)',
    'The "traditional" comparison: the protective call is bought in the 2-week expiry at entry. No near-week trick, no roll, no credit filter.',
    { callExpiry: 'next', roll: false, filters: {} }),
  biweekly('lib-biweekly-dist', 'Bi-weekly Hedge, strikes by distance',
    'As BiWeekly Hedge-Hari, but the short call is 450 pts and the short put 400 pts from spot instead of chosen by premium.',
    { shortCall: { by: 'pts', value: 450 }, shortPut: { by: 'pts', value: 400 } }),
  {
    id: 'lib-butterfly', category: 'Neutral', name: 'Call Butterfly',
    desc: 'Buy 1 ITM 2 call, sell 2 ATM calls, buy 1 OTM 2 call. Cheap bet that Nifty pins near ATM.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('B', 'CE', atm(-2)), leg('S', 'CE', atm(), { lots: 2 }), leg('B', 'CE', atm(2))],
  },
];

module.exports = { LIBRARY };
