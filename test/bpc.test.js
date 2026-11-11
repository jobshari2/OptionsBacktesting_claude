// Bull put collar (bt/bpc.js on bt/mcc.js's runner, mccpaper.js with engine): the opening legs, the payoff, the roll
// rules (sold call down, put spread up / down, decay trigger on the credit, the last-days window), the model path, the
// paper trade on its engine, and the Live trade's shape detection (bt/mcclive.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../bt/bpc');
const L = require('../bt/mcclive');
const { createMccPaper } = require('../mccpaper');

const strikes = [];
for (let k = 22000; k <= 27000; k += 50) strikes.push(k);
const book = () => ({ slip: 0, brokerage: 0, taxes: false, lot: 65, day: '2026-01-05', cash: 0, costs: 0 });
const flat = () => 100;
function opened(S, over = {}, px = flat) {
  const p = P.deepMerge(P.merge(), over);
  const pos = P.newPosition('2026-01-27', S);
  assert.ok(P.openLegs(pos, P.legsAt(S, p, strikes), px, book(), { day: '2026-01-02', time: '09:30' }));
  return { p, pos };
}
const strikeOf = (pos, role) => pos.legs.find((l) => l.role === role)?.strike;

test('opening legs: sell CE ATM+100, sell PE ATM−100, buy PE 100 under it', () => {
  const legs = P.legsAt(24020, P.merge(), strikes);
  assert.deepEqual(
    legs.map((l) => [l.role, l.side, l.type, l.strike, l.lots]),
    [
      ['ceS', -1, 'CE', 24100, 1],
      ['peS', -1, 'PE', 23900, 1],
      ['peL', 1, 'PE', 23800, 1],
    ],
  );
  assert.equal(P.merge({ target: { on: true, amount: 15000 } }).target.on, false);
});

test('payoff: the sold put spread loses at most its width, nothing above the sold put', () => {
  const legs = P.legsAt(24000, P.merge(), strikes).map((l) => ({ ...l, entry: 0 }));
  const puts = legs.filter((l) => l.type === 'PE');
  assert.equal(P.payoffAt(puts, 20000, 65), -100 * 65); // 23900 − 23800
  assert.equal(P.payoffAt(puts, 23850, 65), -50 * 65);
  assert.equal(P.payoffAt(puts, 24500, 65), 0);
});

test('market down 2 %: the sold call moves down to the new ATM + 100, the put spread stays', () => {
  const { p, pos } = opened(24000);
  const acts = P.decide(pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollCall'],
  );
  assert.equal(acts[0].open[0].strike, 23600);
  assert.ok(P.apply(pos, acts[0], () => 30, book(), { day: '2026-01-06', time: '15:00' }));
  assert.equal(strikeOf(pos, 'ceS'), 23600);
  assert.equal(strikeOf(pos, 'peS'), 23900);
});

test('market up 2 %: the sold put spread moves up as a whole, keeping its width', () => {
  const { p, pos } = opened(24000);
  const acts = P.decide(pos, 24500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollPut'],
  );
  assert.deepEqual(
    acts[0].open.map((l) => [l.role, l.side, l.strike]),
    [
      ['peS', -1, 24400],
      ['peL', 1, 24300],
    ],
  );
  assert.ok(P.apply(pos, acts[0], () => 60, book(), { day: '2026-01-06', time: '15:00' }));
  assert.equal(pos.closed.length, 2);
  assert.equal(pos.n.put, 1);
});

test('putDown, switches, last days and adjustments off', () => {
  const d = opened(24000, { adj: { putDown: true } });
  const acts = P.decide(d.pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, d.p);
  assert.deepEqual(acts.map((a) => a.kind).sort(), ['rollCall', 'rollPutDn']);
  assert.equal(acts.find((a) => a.kind === 'rollPutDn').open.find((l) => l.role === 'peS').strike, 23400);
  const off = opened(24000, { adj: { call: false, put: false } });
  assert.equal(P.decide(off.pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, off.p).length, 0);
  assert.equal(P.decide(off.pos, 24500, { daysLeft: 10, strikes, px: () => 20 }, off.p).length, 0);
  const { p, pos } = opened(24000);
  assert.equal(P.decide(pos, 24300, { daysLeft: 10, strikes, px: () => 50 }, p).length, 0);
  assert.equal(P.decide(pos, 23000, { daysLeft: 2, strikes, px: () => 50 }, p).length, 0);
});

test('decay trigger: the put spread rolls up once worth 35 % of the credit taken', () => {
  // sold 23900 PE at 120, bought 23800 PE at 80: credit 40
  const px0 = (t, k) => (t === 'CE' ? 100 : k === 23900 ? 120 : 80);
  const { p, pos } = opened(24000, { adj: { trigger: 'decay' } }, px0);
  const now = (l) => (l.type === 'CE' ? 150 : l.role === 'peS' ? 30 : 20); // 10 of 40 = 25 %
  assert.deepEqual(
    P.decide(pos, 24300, { daysLeft: 10, strikes, px: now }, p).map((a) => a.kind),
    ['rollPut'],
  );
  const half = (l) => (l.type === 'CE' ? 150 : l.role === 'peS' ? 50 : 20); // 30 of 40 = 75 %
  assert.equal(P.decide(pos, 24300, { daysLeft: 10, strikes, px: half }, p).length, 0);
});

test('settlement: the call and the sold put spread add up to the options', () => {
  const b = { ...book(), costsBy: { CE: 0, PE: 0 } };
  const pos = P.newPosition('2026-01-27', 24000);
  P.openLegs(pos, P.legsAt(24000, P.merge(), strikes), (t, k) => (t === 'CE' ? 150 : k === 23900 ? 120 : 80), b, { day: '2026-01-02' });
  P.settle(pos, 23700, b, { day: '2026-01-27', time: '15:30' });
  // call +150, put spread +40 − 100 = −60 → 90 pts
  assert.equal(Math.round(b.cash), 90 * 65);
  const s = P.splitPnl(pos.closed, b);
  assert.equal(s.call, 150 * 65);
  assert.equal(s.put, -60 * 65);
});

test('model path: runs this strategy with and without rolls', () => {
  const r = P.runBpcModel({}, { S0: 24000, pct: 10, months: 6, iv: 13, swings: true });
  assert.equal(r.withAdj.length, 6);
  for (const m of r.without) {
    assert.equal(m.adjustments, 0);
    assert.ok(m.held.every((l) => ['ceS', 'peL', 'peS'].includes(l.role)));
    assert.ok(Math.abs(m.opt - (m.callPnl + m.putPnl)) <= 1);
  }
  assert.ok(r.withAdj.some((m) => m.events.some((e) => e.kind === 'rollPut')));
});

test('paper trade on the bull put engine: opens the three legs and NIFTYBEES', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-'));
  const chainRows = strikes.map((k) => ({ strike: k, ce: { ltp: Math.max(5, 24000 - k + 150) }, pe: { ltp: Math.max(5, k - 24000 + 150) } }));
  const paper = createMccPaper({
    file: path.join(dir, 'p.json'),
    demo: true,
    isMarketOpen: () => true,
    getExpiries: async () => ['2099-01-29', '2099-02-26'],
    getChain: async () => ({ spot: 24000, rows: chainRows }),
    closeOf: async () => null,
    beesPrice: async () => null,
    getLot: () => 65,
    engine: P,
    tag: 'bpc-paper',
  });
  await paper.start({});
  const st = paper.state().paper;
  assert.deepEqual(
    st.cycle.legs.map((l) => [l.role, l.strike]),
    [
      ['ceS', 24100],
      ['peS', 23900],
      ['peL', 23800],
    ],
  );
  assert.equal(st.etfOnce.qty, 6500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Live trade: a sold call + sold put spread is a Bull put collar, not a Put spread collar', () => {
  const legs = [
    { type: 'CE', side: -1, strike: 24100, lots: 1 },
    { type: 'PE', side: -1, strike: 23900, lots: 1 },
    { type: 'PE', side: 1, strike: 23800, lots: 1 },
  ];
  assert.ok(L.looksBpc(legs));
  assert.ok(!L.looksPsc(legs));
  assert.ok(!L.looksBpc(legs.map((l) => (l.type === 'PE' ? { ...l, side: -l.side } : l)))); // the bought spread
  const trade = (kind) => ({
    snap: {
      mcc: { on: true, ...(kind ? { kind } : {}) },
      legs: legs.map((l) => ({ type: l.type, strike: l.strike, lots: l.lots, action: l.side > 0 ? 'B' : 'S', open: true })),
    },
  });
  assert.equal(L.kindOfTrade(trade()), 'bpc');
  assert.equal(L.kindOfTrade(trade('mcc')), 'mcc');
  assert.equal(L.kindOf({ kind: 'bpc' }), 'bpc');
  assert.equal(L.SHAPES.bpc.soldPutRoll, 'over');
});
