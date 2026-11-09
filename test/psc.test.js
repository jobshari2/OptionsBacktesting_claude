// Put spread collar (bt/psc.js on bt/mcc.js's runner, mccpaper.js with engine): the opening legs, the payoff, the
// roll rules (sold call down, put spread up / down, decay trigger, up-market extras, the last-days window), the model
// path and the paper trade on its engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../bt/psc');
const { createMccPaper } = require('../mccpaper');

const strikes = [];
for (let k = 22000; k <= 27000; k += 50) strikes.push(k);
const book = () => ({ slip: 0, brokerage: 0, taxes: false, lot: 65, day: '2026-01-05', cash: 0, costs: 0 });
const flat = () => 100;
function opened(S, over = {}) {
  const p = P.deepMerge(P.merge(), over);
  const pos = P.newPosition('2026-01-27', S);
  assert.ok(P.openLegs(pos, P.legsAt(S, p, strikes), flat, book(), { day: '2026-01-02', time: '09:30' }));
  return { p, pos };
}
const strikeOf = (pos, role) => pos.legs.find((l) => l.role === role)?.strike;

test('opening legs: sell CE ATM+100, buy PE ATM−100, sell PE 100 under it', () => {
  const legs = P.legsAt(24020, P.merge(), strikes);
  assert.deepEqual(
    legs.map((l) => [l.role, l.side, l.type, l.strike, l.lots]),
    [
      ['ceS', -1, 'CE', 24100, 1],
      ['peL', 1, 'PE', 23900, 1],
      ['peS', -1, 'PE', 23800, 1],
    ],
  );
  // the Covered call's ideal-trade search never applies to this shape
  assert.equal(P.merge({ target: { on: true, amount: 15000 } }).target.on, false);
});

test('payoff: put spread worth at most its width, sold call loses above its strike', () => {
  const legs = P.legsAt(24000, P.merge(), strikes).map((l) => ({ ...l, entry: 0 }));
  const puts = legs.filter((l) => l.type === 'PE');
  const call = legs.filter((l) => l.type === 'CE');
  assert.equal(P.payoffAt(puts, 20000, 65), 100 * 65); // 23900 − 23800
  assert.equal(P.payoffAt(puts, 23850, 65), 50 * 65);
  assert.equal(P.payoffAt(puts, 24500, 65), 0);
  assert.equal(P.payoffAt(call, 24100, 65), 0);
  assert.equal(P.payoffAt(call, 24300, 65), -200 * 65);
});

test('market down 2 %: the sold call moves down to the new ATM + 100', () => {
  const { p, pos } = opened(24000);
  const acts = P.decide(pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollCall'],
  );
  assert.equal(acts[0].open[0].strike, 23600);
  assert.ok(P.apply(pos, acts[0], () => 30, book(), { day: '2026-01-06', time: '15:00' }));
  assert.equal(strikeOf(pos, 'ceS'), 23600);
  assert.equal(pos.n.call, 1);
  assert.equal(pos.refCall, 23500);
  // the put spread stays unless putDown is on
  assert.equal(strikeOf(pos, 'peL'), 23900);
});

test('market up 2 %: the put spread moves up as a whole, keeping its width', () => {
  const { p, pos } = opened(24000);
  const acts = P.decide(pos, 24500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollPut'],
  );
  assert.deepEqual(
    acts[0].open.map((l) => [l.role, l.side, l.strike]),
    [
      ['peL', 1, 24400],
      ['peS', -1, 24300],
    ],
  );
  assert.ok(P.apply(pos, acts[0], () => 60, book(), { day: '2026-01-06', time: '15:00' }));
  assert.equal(pos.closed.length, 2);
  assert.equal(pos.n.put, 1);
});

test('put spread follows a fall only with putDown; each side switchable', () => {
  const { p, pos } = opened(24000, { adj: { putDown: true } });
  const acts = P.decide(pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, p);
  assert.deepEqual(acts.map((a) => a.kind).sort(), ['rollCall', 'rollPutDn']);
  assert.equal(acts.find((a) => a.kind === 'rollPutDn').open[0].strike, 23400);
  const off = opened(24000, { adj: { call: false, put: false } });
  assert.equal(P.decide(off.pos, 23500, { daysLeft: 10, strikes, px: () => 20 }, off.p).length, 0);
  assert.equal(P.decide(off.pos, 24500, { daysLeft: 10, strikes, px: () => 20 }, off.p).length, 0);
});

test('no move big enough, and no rolls in the last days or with adjustments off', () => {
  const { p, pos } = opened(24000);
  assert.equal(P.decide(pos, 24300, { daysLeft: 10, strikes, px: () => 50 }, p).length, 0);
  assert.equal(P.decide(pos, 23000, { daysLeft: 2, strikes, px: () => 50 }, p).length, 0);
  const off = opened(24000, { adj: { on: false } });
  assert.equal(P.decide(off.pos, 23000, { daysLeft: 10, strikes, px: () => 50 }, off.p).length, 0);
});

test('decay trigger: the sold call at 35 % of its premium, the put spread at 35 % of its cost', () => {
  const { p, pos } = opened(24000, { adj: { trigger: 'decay' } });
  // call 100 → 30, Nifty lower so the new strike is under the sold one
  const acts = P.decide(pos, 23800, { daysLeft: 10, strikes, px: (l) => (l.type === 'CE' ? 30 : l.role === 'peL' ? 150 : 100) }, p);
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['rollCall'],
  );
  // put spread bought for 0 here (both legs 100): never rolls on decay; price it as a real debit
  const q = P.newPosition('2026-01-27', 24000);
  P.openLegs(q, P.legsAt(24000, p, strikes), (t, k) => (t === 'CE' ? 100 : k === 23900 ? 120 : 80), book(), { day: '2026-01-02' });
  const up = P.decide(q, 24300, { daysLeft: 10, strikes, px: (l) => (l.type === 'CE' ? 150 : l.role === 'peL' ? 30 : 20) }, p); // 10 of 40 = 25 %
  assert.deepEqual(
    up.map((a) => a.kind),
    ['rollPut'],
  );
});

test('up-market extras on the sold call: roll up, buy back, hedge', () => {
  const ctx = { daysLeft: 10, strikes, px: () => 50 };
  const r = opened(24000, { adj: { on: false }, up: { mode: 'roll' } });
  const roll = P.decide(r.pos, 24150, ctx, r.p);
  assert.equal(roll[0].kind, 'upRoll');
  assert.equal(roll[0].open[0].strike, 24250);
  const b = opened(24000, { adj: { on: false }, up: { mode: 'buyBack' } });
  const back = P.decide(b.pos, 24100, ctx, b.p);
  assert.equal(back[0].kind, 'buyBack');
  assert.ok(P.apply(b.pos, back[0], () => 60, book(), { day: '2026-01-06' }));
  assert.equal(strikeOf(b.pos, 'ceS'), undefined);
  assert.equal(P.decide(b.pos, 24400, ctx, b.p).length, 0);
  const h = opened(24000, { adj: { on: false }, up: { mode: 'hedge' } });
  const hedge = P.decide(h.pos, 24100, ctx, h.p);
  assert.equal(hedge[0].kind, 'upHedge');
  assert.deepEqual([hedge[0].open[0].strike, hedge[0].open[0].side], [24300, 1]);
});

test('settlement: cash adds up to the payoff; call and put spread split adds up to the options', () => {
  const b = { ...book(), costsBy: { CE: 0, PE: 0 } };
  const pos = P.newPosition('2026-01-27', 24000);
  P.openLegs(pos, P.legsAt(24000, P.merge(), strikes), (t, k) => (t === 'CE' ? 150 : k === 23900 ? 120 : 80), b, { day: '2026-01-02' });
  P.settle(pos, 23700, b, { day: '2026-01-27', time: '15:30' });
  // call +150, put spread −40 + 100 = +60 → 210 pts
  assert.equal(Math.round(b.cash), 210 * 65);
  const s = P.splitPnl(pos.closed, b);
  assert.equal(s.call, 150 * 65);
  assert.equal(s.put, 60 * 65);
});

test('model path: runs this strategy with and without rolls', () => {
  const r = P.runPscModel({}, { S0: 24000, pct: -10, months: 6, iv: 13, swings: true });
  assert.equal(r.withAdj.length, 6);
  assert.equal(r.without.length, 6);
  for (const m of r.without) {
    assert.equal(m.adjustments, 0);
    assert.ok(m.held.every((l) => ['ceS', 'peL', 'peS'].includes(l.role)));
    assert.ok(Math.abs(m.opt - (m.callPnl + m.putPnl)) <= 1); // each rounded on its own
  }
  assert.ok(r.withAdj.some((m) => m.events.some((e) => e.kind === 'rollCall')));
});

test('paper trade on the collar engine: opens the three legs and NIFTYBEES', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psc-'));
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
    tag: 'psc-paper',
  });
  await paper.start({});
  const st = paper.state().paper;
  assert.deepEqual(
    st.cycle.legs.map((l) => [l.role, l.strike]),
    [
      ['ceS', 24100],
      ['peL', 23900],
      ['peS', 23800],
    ],
  );
  assert.equal(st.cycle.shape, null);
  assert.equal(st.etfOnce.qty, 6500);
  fs.rmSync(dir, { recursive: true, force: true });
});
