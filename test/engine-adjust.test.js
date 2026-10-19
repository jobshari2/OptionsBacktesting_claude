// Backtest engine: adjustments on market movement (strategy.adjust), stops on the whole strategy and the charges by date,
// on a made-up session.
// Nifty is flat at 24,000, climbs 2 points a minute from 10:55 to 12:35 and then stays at 24,200. Every option is
// priced as its intrinsic value plus a time value that shrinks away from the money. The prices are invented to exercise
// the rules; they say nothing about the market.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest, normalizeStrategy, wholeStrategyStops, hhmm } = require('../bt/engine');
const { MPD } = require('../bt/data');

const KS = Array.from({ length: 41 }, (_, i) => 23000 + i * 50);
const spotAt = (m) => (m < 100 ? 24000 : m < 200 ? 24000 + 2 * (m - 100) : 24200);
const priceOf = (S, k, type) => Math.max(0, type === 'CE' ? S - k : k - S) + 60 * Math.exp(-Math.abs(S - k) / 150);

// One session `day` of one expiry. missing: contracts ("24400CE") that never trade.
function fakeData(day, expiry, missing = new Set()) {
  const sp = new Float64Array(MPD * 4);
  for (let m = 0; m < MPD; m++) sp.fill(spotAt(m), m * 4, m * 4 + 4);
  const spots = { [day]: sp, [expiry]: new Float64Array(MPD * 4).fill(24200) }; // the expiry day itself is never traded here
  const bars = new Map();
  const option = (k, type) => {
    const id = k + type;
    if (!bars.has(id)) {
      let a = null;
      if (!missing.has(id)) {
        a = new Int32Array(MPD * 4);
        for (let m = 0; m < MPD; m++) a.fill(Math.round(priceOf(spotAt(m), k, type) * 100), m * 4, m * 4 + 4);
      }
      bars.set(id, { id, a });
    }
    return bars.get(id);
  };
  return {
    expiryCalendar: async () => ({ expired: [expiry], all: [expiry], expiredSet: new Set([expiry]), monthly: new Set([expiry]), liveLot: 65 }),
    loadIndex: async (from, to) => [day, expiry].filter((d) => d >= from && d <= to),
    spotDay: (d) => spots[d] || null,
    vixDay: () => null,
    contracts: async () => ({ expiry, lot: 65, strikes: KS }),
    option: async (e, k, type) => option(k, type),
    optionCached: (e, k, type) => option(k, type),
    optionDay: (c) => c.a,
    apiStats: () => ({}),
  };
}

const DAY = '2026-06-08'; // a Monday
const EXPIRY = '2026-06-09';
const OPTS = { from: DAY, to: DAY, slippage: 0, brokerage: 20, taxes: true, lotMode: 'fixed', lotSize: 65 };
const leg = (action, type, strike) => ({ action, type, lots: 1, expiry: 'cur', strike });
// Short call and put 2 strikes out of the money, and a call bought 200 points above the short call.
const strangle = (adjust) => ({
  mode: 'intraday',
  expiry: 'weekly',
  entry: { time: '09:20', days: [1, 2, 3, 4, 5] },
  exit: { time: '15:15' },
  legs: [leg('S', 'CE', { by: 'atm', value: 2 }), leg('S', 'PE', { by: 'atm', value: 2 }), leg('B', 'CE', { by: 'leg', ref: 0, value: 200 })],
  adjust,
});
const run = async (adjust, data = fakeData(DAY, EXPIRY), opts = OPTS) => (await runBacktest(data, strangle(adjust), opts)).trades[0];
const legsOf = (t, reason) => t.legs.filter((x) => x.reason === reason).map((x) => `${x.action} ${x.strike}${x.type}`);

test('adjust rule is normalized: unknown triggers dropped, limits clamped', () => {
  assert.equal(normalizeStrategy({ legs: [] }).adjust, null);
  assert.equal(normalizeStrategy({ adjust: { on: 'magic', value: 1 } }).adjust, null);
  assert.equal(normalizeStrategy({ adjust: { on: 'move', value: 0 } }).adjust, null);
  assert.equal(normalizeStrategy({ adjust: { on: 'prem', value: 1 } }).adjust, null); // a short at its own entry price is no trigger
  assert.deepEqual(normalizeStrategy({ adjust: { on: 'near', value: 0, max: 99 } }).adjust, { on: 'near', value: 0, unit: 'pts', action: 'tested', max: 10 });
  assert.deepEqual(normalizeStrategy({ adjust: { on: 'move', value: 1, unit: 'pct', action: 'both' } }).adjust, {
    on: 'move',
    value: 1,
    unit: 'pct',
    action: 'both',
    max: 2,
  });
});

test('Nifty moves 100 pts: the tested call side and its wing get new strikes, the put stays', async () => {
  const t = await run({ on: 'move', value: 100, unit: 'pts', action: 'tested', max: 1 });
  // the close of 11:45 (minute 150) is 24,100: made at the open of 11:46, when Nifty is 24,102 (ATM 24,100)
  assert.equal(t.adjusted, 1);
  assert.deepEqual(legsOf(t, 'adjust'), ['S 24100CE', 'B 24300CE']);
  const fresh = t.legs.filter((x) => x.entryTime === hhmm(151));
  assert.deepEqual(
    fresh.map((x) => `${x.action} ${x.strike}${x.type}`),
    ['S 24200CE', 'B 24400CE'],
  );
  assert.ok(fresh.every((x) => x.adj === 1 && x.reason === 'exit-time'));
  assert.deepEqual(legsOf(t, 'exit-time').sort(), ['B 24400CE', 'S 23900PE', 'S 24200CE'].sort());
  assert.match(t.notes.join(' '), /Nifty \+100 pts: S CE 24100→24200, B CE 24300→24400/);
});

test('"both" re-centres every leg; "untested" only rolls the put in', async () => {
  const both = await run({ on: 'move', value: 100, unit: 'pts', action: 'both', max: 1 });
  assert.deepEqual(legsOf(both, 'adjust').sort(), ['B 24300CE', 'S 23900PE', 'S 24100CE'].sort());
  assert.ok(both.legs.some((x) => x.strike === 24000 && x.type === 'PE' && x.entryTime === hhmm(151)));
  const un = await run({ on: 'move', value: 100, unit: 'pts', action: 'untested', max: 1 });
  assert.deepEqual(legsOf(un, 'adjust'), ['S 23900PE']);
});

test('near a short strike and premium multiple trigger on the short call', async () => {
  const near = await run({ on: 'near', value: 0, unit: 'pts', action: 'tested', max: 1 });
  assert.match(near.notes[0], /through the short 24100 CE/);
  const prem = await run({ on: 'prem', value: 2, action: 'tested', max: 1 });
  assert.equal(prem.adjusted, 1);
  assert.match(prem.notes[0], /short 24100 CE at 2\.\d× its entry/);
});

test('an adjustment is all or nothing: a missing wing leaves the old legs in place', async () => {
  const t = await run({ on: 'move', value: 100, unit: 'pts', action: 'tested', max: 1 }, fakeData(DAY, EXPIRY, new Set(['24400CE'])));
  assert.equal(t.adjusted, undefined);
  assert.deepEqual(legsOf(t, 'adjust'), []);
  assert.deepEqual(legsOf(t, 'exit-time').sort(), ['B 24300CE', 'S 23900PE', 'S 24100CE'].sort());
  assert.match(t.notes.join(' '), /adjustment skipped/);
});

test('no adjustment rule: the trade is untouched', async () => {
  const t = await run(null);
  assert.equal(t.adjusted, undefined);
  assert.equal(t.legs.length, 3);
});

test('charges follow the STT in force on the day of the sale', async () => {
  // the same session a year apart: 0.10 % STT on options sold in 2025, 0.15 % from April 2026
  const old = await run(null, fakeData('2025-06-09', '2025-06-10'), { ...OPTS, from: '2025-06-09', to: '2025-06-09' });
  const now = await run(null);
  const sold = now.legs.reduce((s, x) => s + (x.action === 'S' ? x.entryFill : x.exitFill) * x.qty, 0);
  assert.ok(Math.abs(now.costs - old.costs - Math.round(sold * 0.0005)) <= 2, `${now.costs} vs ${old.costs}`);
});

test('leg stops become one stop on the whole strategy', () => {
  const s = wholeStrategyStops({
    legs: [
      { ...leg('S', 'CE', { by: 'atm', value: 2 }), sl: { type: 'pct', value: 50 }, trail: { x: 10, y: 5 }, re: { on: 'sl', mode: 'atm', max: 2 } },
      { ...leg('S', 'PE', { by: 'atm', value: 2 }), sl: { type: 'pct', value: 30 }, re: { on: 'both', mode: 'asap', max: 1 } },
      { ...leg('B', 'CE', { by: 'atm', value: 6 }), sl: { type: 'upct', value: 1 } },
    ],
  });
  assert.equal(s.risk.slPrem, 30); // the smallest leg stop in % of premium
  assert.ok(s.legs.every((l) => l.sl.type === 'none' && l.trail === null));
  assert.equal(s.legs[0].re, null); // re-entry after a stop goes, after a target stays
  assert.equal(s.legs[1].re.on, 'tgt');
  assert.equal(wholeStrategyStops({ legs: [leg('S', 'CE', { by: 'atm', value: 0 })], risk: { slPrem: 20 } }).risk.slPrem, 20);
  assert.equal(
    wholeStrategyStops({ legs: [{ ...leg('S', 'CE', { by: 'atm', value: 0 }), sl: { type: 'pct', value: 40 } }], risk: { slPrem: 20 } }).risk.slPrem,
    20,
  );
});

test("a 50% stop exits on the whole position's loss, not when one leg is 50% up", async () => {
  const s = strangle(null);
  s.legs = s.legs.slice(0, 2).map((l) => ({ ...l, sl: { type: 'pct', value: 50 } }));
  const perLeg = (await runBacktest(fakeData(DAY, EXPIRY), s, OPTS)).trades[0];
  const whole = (await runBacktest(fakeData(DAY, EXPIRY), wholeStrategyStops(s), OPTS)).trades[0];
  // the engine alone would close the call at +50% of its premium and keep the put
  assert.deepEqual(legsOf(perLeg, 'sl'), ['S 24100CE']);
  // with the rule both legs go together, once the pair has lost half the credit (later than the call alone)
  assert.equal(whole.reason, 'mtm-sl');
  assert.deepEqual(legsOf(whole, 'mtm-sl').sort(), ['S 23900PE', 'S 24100CE']);
  const t = (x, k) => x.legs.find((l) => l.strike === k).exitTime;
  assert.ok(t(whole, 24100) > t(perLeg, 24100));
});
