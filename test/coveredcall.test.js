// Covered call (bt/coveredcall.js rules + backtest, ccpaper.js live paper trade) on synthetic prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CC = require('../bt/coveredcall');
const { createCcPaper } = require('../ccpaper');
const { MPD, addDays } = require('../bt/data');
const { istDate } = require('../lib/time');

test('strikes follow the threads: ITM call under spot, 1:2:1 put butterfly mirrored around its body', () => {
  const p = CC.normalize({});
  assert.equal(CC.callTarget(18270, p.call), 18200); // the Nifty thread's June 18,200 CE at spot 18,270
  assert.equal(CC.callTarget(18270, { rule: 'atm' }), 18250);
  assert.equal(CC.callTarget(41350, { rule: 'otmPct', value: 1.6 }), 42000); // the Bank Nifty thread's 42,000 CE
  const fly = CC.insuranceLegs(18270, { kind: 'butterfly', upperPct: 1.5, bodyPct: 4 });
  assert.deepEqual(
    fly.map((l) => [l.side, l.strike, l.mult]),
    [
      ['B', 18000, 1],
      ['S', 17500, 2],
      ['B', 17000, 1],
    ],
  );
  assert.equal(CC.insuranceLegs(18270, { kind: 'none' }).length, 0);
  assert.deepEqual(
    CC.insuranceLegs(18270, { kind: 'debit', upperPct: 1.5, bodyPct: 4 }).map((l) => l.side + l.strike),
    ['B18000', 'S17500'],
  );
});

test('the weekly contra spread depends on where Nifty is against the month (version 2 cases), always defined risk', () => {
  const cyc = { callBE: 19800, lower: 19200 }; // entry 19,500, call sold at 300
  const ovl = CC.normalize({}).ovl;
  assert.equal(CC.regimeOf(19500, cyc), 'range');
  assert.equal(CC.regimeOf(19850, cyc), 'up');
  assert.equal(CC.regimeOf(19150, cyc), 'down');
  const kinds = (r) => CC.overlayLegs(19500, r, ovl).map((l) => l.side + l.type);
  assert.deepEqual(kinds('up'), ['SPE', 'BPE']); // put credit spread
  assert.deepEqual(kinds('down'), ['SCE', 'BCE']); // call credit spread
  assert.deepEqual(kinds('range'), ['SPE', 'BPE', 'SCE', 'BCE']); // iron condor
  for (const r of ['up', 'down', 'range']) {
    const legs = CC.overlayLegs(19500, r, ovl);
    for (const s of legs.filter((l) => l.side === 'S'))
      assert.ok(
        legs.some((b) => b.side === 'B' && b.type === s.type),
        'every short has a wing',
      );
  }
});

test('fills, settlement and parameter limits', () => {
  assert.equal(CC.fillPx(100, 'S', 0.5), 99.5);
  assert.equal(CC.fillPx(100, 'B', 0.5), 100.5);
  assert.equal(CC.fillPx(100, 'S', 0.5, false), 100.5); // closing a short buys it back
  assert.equal(CC.fillPx(2, 'B', 0.5), 2.05); // at least one tick
  assert.equal(CC.intrinsic('CE', 18200, 18500), 300);
  assert.equal(CC.intrinsic('PE', 18200, 18500), 0);
  assert.equal(CC.legPnl({ side: 'S', qty: 50, entry: 405 }, 300), 5250); // Case 2 of the Nifty thread
  const p = CC.normalize({ lots: 0, call: { rule: 'nope' }, ins: { upperPct: 3, bodyPct: 1 }, roll: { reinvest: 'x' } });
  assert.equal(p.lots, 1);
  assert.equal(p.call.rule, 'itm100');
  assert.ok(p.ins.bodyPct > p.ins.upperPct);
  assert.equal(p.roll.reinvest, 'below');
});

// ---------- synthetic history: weekdays, Thursday weeklies, monthly = last Thursday of the month ----------
// bees: NIFTYBEES ÷ Nifty for the ETF's own prices (null = no ETF history, so it is modelled).
function synth({ from = '2025-01-01', to = '2025-03-31', path: spotPath, bees = null }) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd > 0 && wd < 6) days.push(d);
  }
  const thursdays = days.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 4);
  const lastOf = new Map();
  for (const t of thursdays) lastOf.set(t.slice(0, 7), t);
  const monthly = new Set(lastOf.values());
  const spot = new Map(days.map((d, i) => [d, spotPath(i, days.length)]));
  const px = (K, type, day, expiry) => {
    const s = spot.get(day);
    const dte = Math.max(0, (Date.parse(expiry) - Date.parse(day)) / 86400_000);
    return CC.intrinsic(type, K, s) + 250 * Math.sqrt(dte / 30) * Math.exp(-Math.abs(K - s) / 800) + 0.5;
  };
  const strikes = [];
  for (let k = 18000; k <= 28000; k += 50) strikes.push(k);
  return {
    expiryCalendar: async () => ({ monthly, expired: thursdays, expiredSet: new Set(thursdays) }),
    indexStart: () => from,
    loadIndex: async (a, b) => days.filter((d) => d >= a && d <= b),
    spotDay: (d) => (spot.has(d) ? new Float64Array(MPD * 4).fill(spot.get(d)) : null),
    contracts: async () => ({ strikes }),
    optionFiles: () => new Set(),
    option: async (expiry, strike, type) => ({ expiry, strike, type }),
    optionDay: (c, day) => (day > c.expiry ? null : new Int32Array(MPD * 4).fill(Math.round(px(c.strike, c.type, day, c.expiry) * 100))),
    loadSeries: async () => {},
    seriesDay: (key, d) => (bees && spot.has(d) ? new Float64Array(MPD * 4).fill(Math.round(spot.get(d) * bees * 100) / 100) : null),
  };
}

test('backtest: a flat market earns the call time value every month and the holding does not move', async () => {
  const data = synth({ path: () => 23030 });
  const r = await CC.runCoveredCall(data, { ovl: { on: false } });
  assert.ok(r.cycles.length >= 2);
  for (const c of r.cycles) {
    assert.equal(c.call.strike, 23000); // ITM: the 100-point strike under 23,030
    assert.ok(c.callPnl > 0, 'the call keeps its time value');
    assert.equal(c.holdChange, 0);
    assert.ok(c.ins.length === 3);
  }
  assert.ok(r.stats.opt > 0);
  assert.ok(r.stats.total > r.stats.bh, 'flat: the options beat holding alone');
  assert.equal(r.stats.reinvested, 0, 'nothing is reinvested when the month did not close under its entry');
  assert.equal(r.stats.total, r.stats.opt + r.stats.hold, 'with NIFTYBEES = options alone + the NIFTYBEES part');
});

test('backtest: the holding is NIFTYBEES at its own prices, one lot of Nifty worth of it', async () => {
  const r = await CC.runCoveredCall(synth({ path: (i) => 23000 + i * 10, bees: 0.011 }), { ovl: { on: false } });
  assert.equal(r.bees0, Math.round(r.spot0 * 0.011 * 100) / 100);
  assert.equal(r.qty0, Math.round((65 * r.spot0) / r.bees0)); // lot × Nifty ÷ ETF price
  assert.equal(r.beesSource.model, 0);
  assert.ok(r.beesSource.real > 40);
  assert.ok(r.events[0].text.includes('NIFTYBEES at ₹'));
  const c = r.cycles[0];
  assert.equal(c.holdChange, Math.round(c.qtyIn * (c.beesOut - c.beesIn)));
  for (const e of r.equity) assert.ok(Math.abs(e.eq - (e.opt + e.hold)) <= 1);
  const modelled = await CC.runCoveredCall(synth({ path: () => 23030 }), { ovl: { on: false } });
  assert.ok(modelled.beesSource.model > 0 && modelled.beesSource.real === 0, 'without ETF prices every day is modelled, and counted');
});

test('backtest: a rising market books the holding profit above the strike, a falling one reinvests the option profit', async () => {
  const up = await CC.runCoveredCall(synth({ path: (i) => 23000 + i * 20 }), {});
  assert.ok(up.cycles.some((c) => c.booked > 0));
  assert.ok(up.events.some((e) => e.kind === 'book'));
  assert.ok(
    up.cycles.flatMap((c) => c.weeks).some((w) => w.regime === 'up'),
    'above the breakeven the weekly spread is a put spread',
  );
  const down = await CC.runCoveredCall(synth({ path: (i) => 24000 - i * 30 }), {});
  assert.ok(down.cycles.some((c) => c.reinvested > 0));
  assert.ok(down.stats.qtyEnd > down.qty0, 'more NIFTYBEES bought with the option profit');
  assert.ok(down.cycles.some((c) => c.reinvestQty > 0));
  assert.ok(
    down.cycles.flatMap((c) => c.weeks).some((w) => w.regime === 'down'),
    'under the trigger the weekly spread is a call spread',
  );
});

// ---------- live paper trade ----------
function paperSetup(spot = 25030, bees = 280.5) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccpaper-')), 'cc-paper.json');
  const today = istDate();
  const expiries = [6, 13, 20, 27, 34, 41, 48].map((n) => addDays(today, n));
  const rows = [];
  for (let k = 22000; k <= 28000; k += 50) {
    const tv = 200 * Math.exp(-Math.abs(k - spot) / 800);
    rows.push({ strike: k, ce: { ltp: CC.intrinsic('CE', k, spot) + tv }, pe: { ltp: CC.intrinsic('PE', k, spot) + tv } });
  }
  const p = createCcPaper({
    file,
    demo: true,
    isMarketOpen: () => true,
    getExpiries: async () => expiries.filter((e) => e >= istDate()),
    getChain: async () => ({ spot, rows }),
    closeOf: async () => spot,
    getLot: () => 65,
    beesPrice: async () => bees,
    beesCloseOf: async () => bees,
  });
  return { p, file, expiries };
}

test('paper trade: start buys the holding, sells the monthly call, buys the insurance and opens a weekly spread', async () => {
  const { p, file } = paperSetup();
  await p.start({ lots: 1 });
  const { paper, live } = p.state();
  assert.equal(paper.holding.qty, Math.round((65 * 25030) / 280.5)); // lot × Nifty ÷ NIFTYBEES LTP
  assert.equal(paper.bees0, 280.5);
  assert.equal(live.bees.real, true);
  assert.equal(live.eq, live.opt + live.hold);
  assert.equal(paper.cycle.call.strike, 25000);
  assert.equal(paper.cycle.ins.length, 3);
  assert.ok(paper.cycle.ovl?.legs.length === 4, 'in range: an iron condor');
  assert.ok(live.legs.length === 8);
  assert.ok(fs.existsSync(file));
  await assert.rejects(() => p.start({}), /reset it first/);
  p.reset();
  assert.equal(fs.existsSync(file), false);
});

test('paper trade: after the expiries pass, the weekly and the month settle at their close', async () => {
  const { p } = paperSetup();
  await p.start({});
  const E = p.state().paper.cycle.expiry;
  await p.tick(Date.parse(addDays(E, 1) + 'T10:00:00+05:30'));
  const { paper } = p.state();
  assert.equal(paper.cycles.length, 1);
  assert.equal(paper.cycles[0].expiry, E);
  assert.ok(
    paper.cycles[0].weeks.some((w) => w.pnl != null),
    'the weekly spread settled',
  );
  assert.ok(paper.cycles[0].callPnl > 0, 'Nifty did not move: the ITM call kept its time value');
});

// ---------- suggestions on the live chain ----------
const { suggest } = require('../bt/ccsuggest');
function suggChains(spot, expiries) {
  const rows = [];
  for (let k = 22000; k <= 28000; k += 50) {
    const tv = 220 * Math.exp(-Math.abs(k - spot) / 900);
    rows.push({ strike: k, ce: { ltp: CC.intrinsic('CE', k, spot) + tv, iv: 12 }, pe: { ltp: CC.intrinsic('PE', k, spot) + tv, iv: 12 } });
  }
  return new Map(expiries.map((e) => [e, { spot, rows }]));
}

test('suggestions: the rule picks are marked among ranked alternatives for the current and next month and this week', () => {
  const today = '2026-10-21';
  const expiries = ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-24', '2026-12-29'];
  const s = suggest({ today, spot: 25030, bees: 280, chains: suggChains(25030, expiries), expiries, params: { lotSize: 65 } });
  assert.deepEqual(
    s.months.map((m) => [m.label, m.expiry]),
    [
      ['Current month', '2026-10-27'],
      ['Next month', '2026-11-24'],
    ],
  );
  assert.equal(s.months[0].tooSoon, true, '6 days is under the 14-day minimum');
  const m = s.months[1];
  assert.equal(m.pick.call, 25000); // ITM: the 100-point strike under 25,030
  assert.ok(m.calls.find((c) => c.strike === 25000).tags.includes('rule'));
  assert.ok(m.calls.some((c) => c.tags.includes('most')));
  const fly = m.ins[m.pick.ins];
  assert.deepEqual(fly.strikes, [24700, 24000, 23300]);
  assert.ok(fly.tags.includes('rule') && fly.debit > 0 && fly.maxPay > 0);
  assert.equal(s.weekly.expiry, '2026-10-27');
  assert.equal(s.weekly.regime, 'range');
  assert.ok(s.weekly.candidates.every((c) => c.legs.length === 4 && c.pop > 0 && c.pop < 100));
  assert.equal(s.qtyBees, Math.round((65 * 25030) / 280));
  assert.match(s.now[0].text, /^Buy 5,811 NIFTYBEES/);
  assert.match(s.now.map((n) => n.text).join(' '), /rules start on the next month/);
});

test('suggestions: with a paper month open, the weekly regime is judged against its levels and the month is held', () => {
  const today = '2026-10-21';
  const expiries = ['2026-10-27', '2026-11-24'];
  const paper = { cycle: { expiry: '2026-11-24', call: { strike: 24500 }, callBE: 24800, lower: 24300, ins: [{}], weeks: [] } };
  const s = suggest({ today, spot: 25030, bees: 280, chains: suggChains(25030, expiries), expiries, params: { lotSize: 65 }, paper });
  assert.equal(s.weekly.regime, 'up'); // over the 24,800 breakeven
  assert.ok(
    s.weekly.candidates.every((c) => c.legs.every((l) => l.type === 'PE')),
    'above the breakeven: put spreads',
  );
  assert.match(s.now[0].text, /^Keep NIFTYBEES, the 24500 CE and the insurance to 2026-11-24/);
});

test('paper trade: after a restart outside market hours the last marks show, it marks once, and nothing new is traded', async () => {
  const { p, file, expiries } = paperSetup();
  await p.start({});
  const before = p.state();
  assert.ok(before.live.month && before.live.month.total === before.live.month.opt + before.live.month.hold, "the month's own P&L");
  // the server restarts on a Saturday morning: the market is closed
  const spot = 25030;
  const rows = [];
  for (let k = 22000; k <= 28000; k += 50)
    rows.push({ strike: k, ce: { ltp: CC.intrinsic('CE', k, spot) + 50 }, pe: { ltp: CC.intrinsic('PE', k, spot) + 50 } });
  const q = createCcPaper({
    file,
    demo: false,
    isMarketOpen: () => false,
    getExpiries: async () => expiries,
    getChain: async () => ({ spot, rows }),
    closeOf: async () => spot,
    beesPrice: async () => 280.5,
  });
  assert.deepEqual(q.state().live.legs, before.live.legs, 'the saved marks, until the next check');
  const legsBefore = JSON.stringify(q.state().paper.cycle);
  await q.tick(Date.parse('2026-10-24T10:00:00+05:30'));
  const after = q.state();
  assert.ok(after.live.at >= before.live.at);
  assert.ok(
    after.live.legs.every((x) => x.ltp != null),
    'marked at the chain prices',
  );
  assert.equal(JSON.stringify(after.paper.cycle), legsBefore, 'nothing opened or closed outside market hours');
});
