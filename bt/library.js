// Ready-made strategies. All are defined relative to the market (ATM offsets, premium, delta, expiry
// "current / next"), so each one can be backtested on any past expiry and deployed on any future one.
// "OTM n" = n strikes away from ATM on the out-of-the-money side (negative = in the money).
const atm = (n = 0) => ({ by: 'atm', value: n });
const prem = (v, match = 'closest') => ({ by: 'premium', value: v, match });
const dlt = (v) => ({ by: 'delta', value: v, match: 'closest' });
const leg = (action, type, strike, o = {}) => ({
  action,
  type,
  lots: o.lots || 1,
  expiry: o.expiry || 'cur',
  strike,
  sl: o.sl || null,
  tgt: o.tgt || null,
  trail: o.trail || null,
  re: o.re || null,
});

const intraday = (entry = '09:20', exit = '15:15', extra = {}) => ({
  mode: 'intraday',
  expiry: 'weekly',
  entry: { time: entry, days: [1, 2, 3, 4, 5], dte: [], ...extra },
  exit: { time: exit },
});
const positional = (entryDte, entry, exitDte, exit, expiry = 'weekly') => ({
  mode: 'positional',
  expiry,
  entry: { time: entry, dteDays: entryDte },
  exit: { time: exit, dteDays: exitDte },
});

// The bi-weekly hedge and its variants (see the LIBRARY entries below).
// o: { shortCall, shortPut, callExpiry, roll, risk, filters, exitDte, reverse, nearWing (points between the short
// strike and its near-week hedge, default 100) }
// reverse = the mirror image for the upside: the 2-week spread that is fully covered is the call spread (no loss
// however far Nifty rallies), and the cheap near-week hedge that gets rolled is a put 100 below the short put.
function biweekly(id, name, desc, o = {}) {
  const lots = 5;
  const [near, far] = o.reverse ? ['PE', 'CE'] : ['CE', 'PE']; // near = side hedged in the near week, far = side hedged in the 2-week expiry
  const wing = (type, w = 100) => (type === 'CE' ? w : -w);
  return {
    id,
    category: 'Bi-weekly',
    name,
    desc,
    mode: 'positional',
    expiry: 'weekly',
    entry: { time: '09:20', dteDays: 0, after: 2, noOverlap: true }, // the day after the expiry 2 series before the 2-week expiry
    exit: { time: '15:15', dteDays: o.exitDte || 0 },
    legs: [
      leg('S', near, o.shortCall || prem(105), { lots, expiry: 'next' }),
      leg('S', far, o.shortPut || prem(120), { lots, expiry: 'next' }),
      leg('B', far, { by: 'leg', ref: 1, value: wing(far) }, { lots, expiry: 'next' }),
      {
        ...leg('B', near, { by: 'leg', ref: 0, value: wing(near, o.nearWing) }, { lots, expiry: o.callExpiry || 'cur' }),
        roll: o.roll === false ? null : { dteDays: 1, time: '15:15' },
      },
    ],
    risk: o.risk || { unit: 'pct', tgt: 2.5 },
    filters: { ...(o.reverse ? { minCredit: 90, maxLossUp: 10 } : { minCredit: 90, maxLossDown: 10 }), ...(o.filters || {}) },
  };
}

const LIBRARY = [
  // ---- Bi-weekly hedge (Advanced Bi-Weekly Option Strategy playbook): first in every list ----
  // Enter the day after a weekly expiry (start of a new series). Sell a ~₹105 call and a ~₹120 put in the 2-week
  // expiry, buy the put 100 below the short put (same expiry) and the call 100 above the short call in the cheaper
  // near week. The near-week call is rolled into the 2-week expiry the trading day before it expires, 15:15.
  // Enter only when the net credit is ≥ 90 pts and the put-spread risk is covered (≤ 10 pts loss far below).
  // Amounts are % of capital: set Capital to ₹1 L per lot (₹5 L for these 5 lots) in the settings bar.
  // The playbook version itself is the user's own saved strategy "BiWeekly Hedge-Hari" (bt-data/strategies.json);
  // these are the variants to compare it with.
  // Ordered by their backtest over Oct 2024 - Sep 2026 (Rs 5 L capital, lot 65, 0.5 % slippage; net of year 1 / year 2),
  // best first. Most losing trades of the playbook lose on the rolled hedge: the 2-week option bought on the roll
  // day costs 110-270 pts and usually expires worthless. Closing everything on the near-week expiry day keeps the
  // cheap hedge for the whole trade and needs no roll; the 4 % stop caps the trending weeks.
  biweekly(
    'lib-biweekly-week1-c100-sl',
    'Bi-weekly Hedge, week-1 exit, credit ≥ 100, target 2.5% + stop 4%',
    'Smallest drawdown in testing (−₹43K / −₹49K in the two years, worst trade −₹22K) with +₹1.09 L / +₹0.80 L: the week-1 exit, taken only in weeks that pay a net credit of 100 pts or more (about 32 trades a year), with a 4% stop.',
    { roll: false, exitDte: 5, risk: { unit: 'pct', tgt: 2.5, sl: 4 }, filters: { minCredit: 100 } },
  ),
  biweekly(
    'lib-biweekly-week1-c100',
    'Bi-weekly Hedge, week-1 exit, credit ≥ 100, target 2.5%',
    'Highest profit in testing (+₹1.55 L / +₹1.14 L) with a drawdown of −₹64K in both years and a worst trade of −₹36K: the week-1 exit, only in weeks that pay a net credit of 100 pts or more, no stop. The credit level matters: at 105 the result falls away.',
    { roll: false, exitDte: 5, filters: { minCredit: 100 } },
  ),
  biweekly(
    'lib-biweekly-week1-sl',
    'Bi-weekly Hedge, week-1 exit (no roll), target 2.5% + stop 4%',
    'Best in testing (+₹0.97 L / +₹0.84 L in the two years, worst trade −₹22K). As BiWeekly Hedge-Hari, but the whole position is closed on the near-week expiry day at 15:15, while the cheap near-week call still hedges it: no roll. Target +2.5%, stop −4% of capital.',
    { roll: false, exitDte: 5, risk: { unit: 'pct', tgt: 2.5, sl: 4 } },
  ),
  biweekly(
    'lib-biweekly-week1',
    'Bi-weekly Hedge, week-1 exit (no roll), target 2.5%',
    'Second in testing (+₹0.78 L / +₹1.00 L, but worst trade −₹65K and twice the drawdown). Closed on the near-week expiry day at 15:15 with no roll and no stop. Target +2.5% of capital.',
    { roll: false, exitDte: 5 },
  ),
  // The mirror image for the upside: sell a ~Rs 105 put and a ~Rs 120 call in the 2-week expiry, buy the call 100
  // above the short call (same expiry: no loss however far Nifty rallies), and hedge the put with a near-week put
  // below it. As a straight mirror (put 100 below, rolled) it lost in both years: falls are faster than rallies, and
  // a near-week put 100 away hardly moves when the 2-week short put doubles. What worked in testing: the near-week
  // put only 50 below the short put, everything closed on the near-week expiry day (no roll), no stop (every stop
  // tested made it worse). Skipping the quiet weeks (India VIX under 12) helped in both years.
  biweekly(
    'lib-biweekly-rev-h50-vix-lock',
    'Bi-weekly Hedge Reverse, put hedge 50, week-1 exit, VIX ≥ 12, lock profit',
    'Smallest drawdown of the reverse in testing (−₹26K / −₹16K, worst trade −₹17K) with +₹0.43 L / +₹0.52 L: once the position is up 1.2% of capital a floor of 0.5% is locked, so a winner cannot turn into a loser. Target +2.5%, no stop.',
    { reverse: true, nearWing: 50, roll: false, exitDte: 5, filters: { vixMin: 12 }, risk: { unit: 'pct', tgt: 2.5, lockAt: 1.2, lockTo: 0.5 } },
  ),
  biweekly(
    'lib-biweekly-rev-h50-lock',
    'Bi-weekly Hedge Reverse, put hedge 50, week-1 exit, lock profit',
    'The same without the VIX filter: +₹0.42 L / +₹0.32 L, drawdown −₹26K / −₹21K, worst trade −₹17K. Locks 0.5% of capital once up 1.2%.',
    { reverse: true, nearWing: 50, roll: false, exitDte: 5, risk: { unit: 'pct', tgt: 2.5, lockAt: 1.2, lockTo: 0.5 } },
  ),
  biweekly(
    'lib-biweekly-rev-h50-vix',
    'Bi-weekly Hedge Reverse, put hedge 50 below, week-1 exit, VIX ≥ 12',
    'Best form of the reverse in testing (+₹0.38 L / +₹0.54 L, worst trade −₹31K, about 20 trades a year). Short ~₹105 put and ~₹120 call in the 2-week expiry, call wing 100 above, near-week put 50 below the short put, closed on the near-week expiry day. Enter only when India VIX is 12 or more. Target +2.5%, no stop.',
    { reverse: true, nearWing: 50, roll: false, exitDte: 5, filters: { vixMin: 12 } },
  ),
  biweekly(
    'lib-biweekly-rev-h50',
    'Bi-weekly Hedge Reverse, put hedge 50 below, week-1 exit',
    'The same without the VIX filter: +₹0.42 L / +₹0.15 L, worst trade −₹31K, about 29 trades a year. Target +2.5%, no stop.',
    { reverse: true, nearWing: 50, roll: false, exitDte: 5 },
  ),
  biweekly(
    'lib-biweekly-rev-week1',
    'Bi-weekly Hedge Reverse (upside covered), week-1 exit',
    'The straight mirror closed on the near-week expiry day (put hedge 100 below), no roll, target +2.5%: +₹0.32 L / −₹0.95 L. Kept for comparison.',
    { reverse: true, roll: false, exitDte: 5 },
  ),
  biweekly(
    'lib-biweekly-rev',
    'Bi-weekly Hedge Reverse (upside covered)',
    'Mirror of BiWeekly Hedge-Hari: short ~₹105 put and ~₹120 call in the 2-week expiry, call wing 100 above (upside fully covered), near-week put 100 below rolled the day before it expires. Credit ≥ 90, target +2.5%. Tested −₹0.39 L / −₹1.25 L. Kept for comparison.',
    { reverse: true },
  ),
  biweekly(
    'lib-biweekly-partial',
    'Bi-weekly Hedge, partial booking',
    'As BiWeekly Hedge-Hari, but instead of a full target: at +3.6% book 60% of the lots (3 of 5) and keep a +1.4% floor; the rest runs to the 2-week expiry.',
    { risk: { unit: 'pct', partialAt: 3.6, partialPct: 60, partialFloor: 1.4 } },
  ),
  biweekly(
    'lib-biweekly-noroll',
    'Bi-weekly Hedge, no Monday roll',
    'What a missed roll costs: identical, but the near-week call simply expires, leaving the short call unhedged in week 2.',
    { roll: false },
  ),
  biweekly(
    'lib-biweekly-ic',
    'Bi-weekly Iron Condor (same expiry)',
    'The "traditional" comparison: the protective call is bought in the 2-week expiry at entry. No near-week trick, no roll, no credit filter.',
    { callExpiry: 'next', roll: false, filters: { minCredit: null, maxLossDown: null } },
  ),
  biweekly(
    'lib-biweekly-dist',
    'Bi-weekly Hedge, strikes by distance',
    'As BiWeekly Hedge-Hari, but the short call is 450 pts and the short put 400 pts from spot instead of chosen by premium.',
    { shortCall: { by: 'pts', value: 450 }, shortPut: { by: 'pts', value: 400 } },
  ),
  // ---- Neutral: sell premium ----
  {
    id: 'lib-straddle-920',
    category: 'Neutral',
    name: '9:20 Short Straddle (25% SL)',
    desc: 'Sell ATM call and put at 09:20, exit 15:15 or when the whole straddle has lost 25% of the premium collected. The classic intraday premium-selling setup.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm()), leg('S', 'PE', atm())],
    risk: { slPrem: 25 },
  },
  {
    id: 'lib-straddle-trail',
    category: 'Neutral',
    name: 'Straddle, MTM lock & trail',
    desc: 'ATM straddle at 09:20 with an overall ₹4,000 stop. Once up ₹2,000 it locks ₹500, then trails ₹500 for every ₹1,000 more.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm()), leg('S', 'PE', atm())],
    risk: { sl: 4000, lockAt: 2000, lockTo: 500, trailEvery: 1000, trailBy: 500 },
  },
  {
    id: 'lib-strangle-prem',
    category: 'Neutral',
    name: 'Short Strangle (₹50 premium)',
    desc: 'Sell the call and put trading closest to ₹50 at 09:20, exit 15:15 or when the whole strangle has lost 50% of the premium collected.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', prem(50)), leg('S', 'PE', prem(50))],
    risk: { slPrem: 50 },
  },
  {
    id: 'lib-expiry-straddle',
    category: 'Neutral',
    name: 'Expiry-day Straddle',
    desc: 'Only on expiry day: sell the ATM straddle at 09:30, exit 15:20 or when the whole straddle has lost 30% of the premium collected.',
    ...intraday('09:30', '15:20', { dte: [0] }),
    legs: [leg('S', 'CE', atm()), leg('S', 'PE', atm())],
    risk: { slPrem: 30 },
  },
  {
    id: 'lib-iron-condor',
    category: 'Neutral',
    name: 'Intraday Iron Condor',
    desc: 'Sell OTM 2 call and put, buy OTM 6 wings; out when the whole position has lost 50% of the net credit. Defined risk, lower margin.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm(2)), leg('S', 'PE', atm(2)), leg('B', 'CE', atm(6)), leg('B', 'PE', atm(6))],
    risk: { slPrem: 50 },
  },
  {
    id: 'lib-iron-fly',
    category: 'Neutral',
    name: 'Iron Butterfly',
    desc: 'Sell ATM straddle, buy wings 4 strikes away. Overall stop ₹3,000, target ₹3,000.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'CE', atm()), leg('S', 'PE', atm()), leg('B', 'CE', atm(4)), leg('B', 'PE', atm(4))],
    risk: { sl: 3000, tgt: 3000 },
  },
  {
    id: 'lib-weekly-strangle',
    category: 'Neutral',
    name: 'Weekly Strangle (0.2 delta)',
    desc: 'Positional: 4 trading days before expiry sell 0.2-delta call and put at 09:20, hold to expiry 15:20. Overall stop ₹6,000.',
    ...positional(4, '09:20', 0, '15:20'),
    legs: [leg('S', 'CE', dlt(0.2)), leg('S', 'PE', dlt(0.2))],
    risk: { sl: 6000 },
  },
  {
    id: 'lib-weekly-ic-roll',
    category: 'Neutral',
    name: 'Weekly Iron Condor (0.2 delta), tested side rolled',
    desc: 'Defined risk. 4 trading days before expiry sell the 0.2-delta call and put, buy wings 300 pts beyond each. When a short leg doubles, that side (short and wing) is moved out to a fresh 0.2 delta (at most 3 times); stop at 3% of capital on the whole position. Set Capital ₹5 L (5 lots). Oct 2024 - Oct 2026, 0.5% slippage: +₹3.27 L (+₹2.09 L / +₹1.18 L by year), drawdown −₹50K, worst trade −₹20K (+₹2.47 L, drawdown −₹1.15 L without the roll). Strong trends still lose.',
    ...positional(4, '09:20', 0, '15:20'),
    legs: [
      leg('S', 'CE', dlt(0.2), { lots: 5 }),
      leg('S', 'PE', dlt(0.2), { lots: 5 }),
      leg('B', 'CE', { by: 'leg', ref: 0, value: 300 }, { lots: 5 }),
      leg('B', 'PE', { by: 'leg', ref: 1, value: -300 }, { lots: 5 }),
    ],
    risk: { unit: 'pct', sl: 3 },
    adjust: { on: 'prem', value: 2, unit: 'x', action: 'tested', max: 3 },
  },
  {
    id: 'lib-weekly-ic',
    category: 'Neutral',
    name: 'Weekly Iron Condor (positional)',
    desc: '3 days before expiry: sell 0.25-delta call and put, buy wings 5 strikes further. Hold to expiry.',
    ...positional(3, '09:30', 0, '15:20'),
    legs: [leg('S', 'CE', dlt(0.25)), leg('S', 'PE', dlt(0.25)), leg('B', 'CE', { by: 'pct', value: 2.5 }), leg('B', 'PE', { by: 'pct', value: 2.5 })],
  },
  {
    id: 'lib-monthly-ic',
    category: 'Neutral',
    name: 'Monthly Iron Condor',
    desc: 'Multi-week: 15 trading days before the monthly expiry sell 0.15-delta options, buy 4%-OTM wings, exit 2 days before expiry.',
    ...positional(15, '10:00', 2, '15:15', 'monthly'),
    legs: [
      leg('S', 'CE', dlt(0.15), { expiry: 'mcur' }),
      leg('S', 'PE', dlt(0.15), { expiry: 'mcur' }),
      leg('B', 'CE', { by: 'pct', value: 4 }, { expiry: 'mcur' }),
      leg('B', 'PE', { by: 'pct', value: 4 }, { expiry: 'mcur' }),
    ],
    risk: { sl: 10000 },
  },

  // ---- Bullish ----
  {
    id: 'lib-bull-call',
    category: 'Bullish',
    name: 'Bull Call Spread',
    desc: 'Buy ATM call, sell OTM 4 call. Limited risk, limited reward.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('S', 'CE', atm(4))],
  },
  {
    id: 'lib-bull-put',
    category: 'Bullish',
    name: 'Bull Put Spread (weekly)',
    desc: 'Positional credit spread: 2 days before expiry sell OTM 1 put, buy OTM 5 put, hold to expiry.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('S', 'PE', atm(1)), leg('B', 'PE', atm(5))],
  },
  {
    id: 'lib-long-call',
    category: 'Bullish',
    name: 'Long Call (momentum)',
    desc: 'Buy ATM call at 09:30 with 30% stop and 60% target.',
    ...intraday('09:30', '15:15'),
    legs: [leg('B', 'CE', atm())],
    risk: { slPrem: 30, tgtPrem: 60 },
  },
  {
    id: 'lib-jade-lizard',
    category: 'Bullish',
    name: 'Jade Lizard',
    desc: 'Sell OTM 2 put, sell OTM 2 call, buy OTM 6 call; out when the whole position has lost 50% of the credit. No upside risk when the credit exceeds the call spread width.',
    ...intraday('09:20', '15:15'),
    legs: [leg('S', 'PE', atm(2)), leg('S', 'CE', atm(2)), leg('B', 'CE', atm(6))],
    risk: { slPrem: 50 },
  },
  {
    id: 'lib-call-ratio',
    category: 'Bullish',
    name: 'Call Ratio Spread 1×2',
    desc: 'Buy 1 ATM call, sell 2 OTM 3 calls. Profits in a mild rise; risk on a big rally.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('S', 'CE', atm(3), { lots: 2 })],
    risk: { sl: 4000 },
  },

  // ---- Bearish ----
  {
    id: 'lib-bear-put',
    category: 'Bearish',
    name: 'Bear Put Spread',
    desc: 'Buy ATM put, sell OTM 4 put.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'PE', atm()), leg('S', 'PE', atm(4))],
  },
  {
    id: 'lib-bear-call',
    category: 'Bearish',
    name: 'Bear Call Spread (weekly)',
    desc: 'Positional credit spread: 2 days before expiry sell OTM 1 call, buy OTM 5 call, hold to expiry.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('S', 'CE', atm(1)), leg('B', 'CE', atm(5))],
  },
  {
    id: 'lib-long-put',
    category: 'Bearish',
    name: 'Long Put (momentum)',
    desc: 'Buy ATM put at 09:30 with 30% stop and 60% target.',
    ...intraday('09:30', '15:15'),
    legs: [leg('B', 'PE', atm())],
    risk: { slPrem: 30, tgtPrem: 60 },
  },
  {
    id: 'lib-put-ratio',
    category: 'Bearish',
    name: 'Put Ratio Spread 1×2',
    desc: 'Buy 1 ATM put, sell 2 OTM 3 puts.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'PE', atm()), leg('S', 'PE', atm(3), { lots: 2 })],
    risk: { sl: 4000 },
  },

  // ---- Volatility: buy premium ----
  {
    id: 'lib-long-straddle',
    category: 'Volatility',
    name: 'Long Straddle',
    desc: 'Buy ATM call and put at 09:20. Target ₹3,000, stop ₹2,000 overall. Wins on big moves.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('B', 'PE', atm())],
    risk: { sl: 2000, tgt: 3000 },
  },
  {
    id: 'lib-long-strangle',
    category: 'Volatility',
    name: 'Long Strangle',
    desc: 'Buy OTM 2 call and put. Cheaper than a straddle, needs a bigger move.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm(2)), leg('B', 'PE', atm(2))],
    risk: { sl: 1500, tgt: 3000 },
  },
  {
    id: 'lib-buy-sl-hunt',
    category: 'Volatility',
    name: 'Straddle buy, trailing',
    desc: 'Buy ATM straddle at 09:20; out when the whole straddle has lost 20% of what it cost, exit 15:15.',
    ...intraday('09:20', '15:15'),
    legs: [leg('B', 'CE', atm()), leg('B', 'PE', atm())],
    risk: { slPrem: 20 },
  },

  // ---- Calendars / multi-expiry ----
  {
    id: 'lib-calendar',
    category: 'Calendar',
    name: 'Call Calendar Spread',
    desc: "Positional: 3 days before expiry sell this week's ATM call, buy next week's ATM call; close on expiry day.",
    ...positional(3, '09:30', 0, '15:15'),
    legs: [leg('S', 'CE', atm()), leg('B', 'CE', atm(), { expiry: 'next' })],
  },
  {
    id: 'lib-double-calendar',
    category: 'Calendar',
    name: 'Double Calendar',
    desc: "Sell this week's OTM 2 call and put, buy next week's same strikes. Profits from faster decay of the near week.",
    ...positional(3, '09:30', 0, '15:15'),
    legs: [leg('S', 'CE', atm(2)), leg('S', 'PE', atm(2)), leg('B', 'CE', atm(2), { expiry: 'next' }), leg('B', 'PE', atm(2), { expiry: 'next' })],
  },
  {
    id: 'lib-butterfly',
    category: 'Neutral',
    name: 'Call Butterfly',
    desc: 'Buy 1 ITM 2 call, sell 2 ATM calls, buy 1 OTM 2 call. Cheap bet that Nifty pins near ATM.',
    ...positional(2, '09:30', 0, '15:20'),
    legs: [leg('B', 'CE', atm(-2)), leg('S', 'CE', atm(), { lots: 2 }), leg('B', 'CE', atm(2))],
  },
];

// One signal strategy per arbitrage / fair-value type, direction and (where the legs differ) option side: enter when
// the detector fires (09:20-15:00, up to 2 a day) with its suggested legs, exit 15:15. The same strategy the Arbitrage
// screen's "Backtest as strategy" opens, with the detector's default thresholds; built from the detector catalog so a
// new type or direction shows up here by itself.
function arbitrageStrategies() {
  const A = require('./anomalies');
  const out = [];
  for (const t of A.catalog()) {
    for (const dir of t.dirs) {
      for (const side of t.sided ? ['CE', 'PE'] : [null]) {
        const tpl = t.templates[dir][side || 'CE'];
        out.push({
          id: `lib-arb-${t.id}-${dir}${side ? '-' + side.toLowerCase() : ''}`,
          category: 'Arbitrage',
          name: `${t.name} — ${dir}${side ? ' ' + side : ''}`,
          desc: `${t.desc} ${t.how}`,
          mode: 'intraday',
          expiry: 'weekly',
          entry: {
            time: '09:20',
            days: [1, 2, 3, 4, 5],
            dte: [],
            when: 'signal',
            until: '15:00',
            maxTrades: 2,
            conditions: [{ kind: 'anomaly', type: t.id, params: {}, side: side || 'any', dir }],
          },
          exit: { time: '15:15' },
          legs: tpl.legs.map((l) => leg(l.action, l.type, l.strike, { lots: l.lots, expiry: l.expiry })),
          risk: tpl.risk || {},
        });
      }
    }
  }
  return out;
}
LIBRARY.push(...arbitrageStrategies());

module.exports = { LIBRARY, biweekly };
