// NIFTYBEES + options (bt/nbo.js on bt/mcc.js's runner): legs from the page, the opening strikes, the generic side
// rolls (calls / puts follow a fall or a rise), the decay trigger, the last-days window, and the study's side rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../bt/nbo');
const M = require('../bt/mcc');

const strikes = [];
for (let k = 22000; k <= 27000; k += 50) strikes.push(k);
const book = () => ({ slip: 0, brokerage: 0, taxes: false, lot: 65, day: '2026-01-05', cash: 0, costs: 0 });
const flat = () => 100;
function opened(S, over = {}, px = flat) {
  const p = N.merge(over);
  const pos = M.newPosition('2026-01-27', S);
  assert.ok(M.openLegs(pos, N.legsAt(S, p, strikes), px, book(), { day: '2026-01-02', time: '09:30' }));
  return { p, pos };
}
const ctx = (over = {}) => ({ daysLeft: 10, strikes, px: () => 100, ...over });

test('merge cleans the legs from the page and keeps at most MAX_LEGS', () => {
  const p = N.merge({
    legs: [
      { type: 'CE', side: -1, off: 120, lots: 1 },
      { type: 'XX', side: 1, off: 0, lots: 1 },
      { type: 'PE', side: '1', off: '-210', lots: '2' },
      { type: 'PE', side: 1, off: 9000, lots: 1 },
    ],
  });
  assert.deepEqual(p.legs, [
    { type: 'CE', side: -1, off: 100, lots: 1 },
    { type: 'PE', side: 1, off: -200, lots: 2 },
  ]);
  const many = N.merge({ legs: Array.from({ length: 12 }, () => ({ type: 'CE', side: 1, off: 0, lots: 1 })) });
  assert.equal(many.legs.length, N.MAX_LEGS);
  assert.equal(N.merge({}).legs.length, 3); // the default: the Put spread collar
});

test('opening legs at their distance from ATM, lots × the multiplier, a dropped side left out', () => {
  const p = N.merge({ lots: 2, legs: N.PRESETS.find((x) => x.id === 'ic').legs });
  const legs = N.legsAt(24020, p, strikes);
  assert.deepEqual(
    legs.map((l) => [l.type, l.side, l.strike, l.lots]),
    [
      ['CE', -1, 24200, 2],
      ['CE', 1, 24400, 2],
      ['PE', -1, 23800, 2],
      ['PE', 1, 23600, 2],
    ],
  );
  assert.ok(N.legsAt(24020, { ...p, drop: 'CE' }, strikes).every((l) => l.type === 'PE'));
});

test('default rules: calls follow a fall, puts follow a rise, at 2 %', () => {
  const { p, pos } = opened(24000);
  assert.deepEqual(N.decide(pos, 23700, ctx(), p), []); // 1.25 % under: nothing
  const dn = N.decide(pos, 23500, ctx(), p);
  assert.equal(dn.length, 1);
  assert.equal(dn[0].kind, 'rollCall');
  assert.deepEqual(
    dn[0].open.map((l) => [l.type, l.side, l.strike]),
    [['CE', -1, 23600]],
  );
  const up = N.decide(pos, 24500, ctx(), p);
  assert.equal(up.length, 1);
  assert.equal(up[0].kind, 'rollPut');
  assert.deepEqual(
    up[0].open.map((l) => [l.side, l.strike]),
    [
      [1, 24400],
      [-1, 24300],
    ],
  );
  // the roll re-centres the side and counts against its limit
  assert.ok(M.apply(pos, up[0], flat, book(), { day: '2026-01-08', time: '15:00' }));
  assert.equal(pos.refPut, 24500);
  assert.equal(pos.n.put, 1);
  assert.deepEqual(N.decide(pos, 24600, ctx(), p), []);
});

test('the other directions are switches; nothing in the last days', () => {
  const { p, pos } = opened(24000, { adj: { ceDown: false, peUp: false, ceUp: true, peDown: true } });
  assert.equal(N.decide(pos, 24500, ctx(), p)[0].kind, 'rollCallUp');
  assert.equal(N.decide(pos, 23500, ctx(), p)[0].kind, 'rollPutDn');
  assert.deepEqual(N.decide(pos, 23500, ctx({ daysLeft: 2 }), p), []);
  assert.deepEqual(N.decide(pos, 23500, ctx(), { ...p, adj: { ...p.adj, on: false } }), []);
});

test('decay trigger: a side rolls once it is worth decayPct % of its entry value', () => {
  const { p, pos } = opened(24000, { adj: { trigger: 'decay', decayPct: 35 } });
  // the put spread was opened at 100 − 100 = 0: no entry value, so it never decays
  const px = (l) => (l.type === 'CE' ? 30 : 100);
  // calls (sold at 100) now at 30 = 30 %: due, and Nifty fell 150 so the strike moves down
  const a = N.decide(pos, 23850, ctx({ px }), p);
  assert.deepEqual(
    a.map((x) => x.kind),
    ['rollCall'],
  );
  const b = N.decide(pos, 23850, ctx({ px: () => 50 }), p);
  assert.deepEqual(b, []);
});

test('study rows run with the user legs and leave one side out', () => {
  const ids = N.STUDY.map(([id]) => id);
  assert.ok(ids.includes('none') && ids.includes('move2') && ids.includes('noCalls') && ids.includes('noPuts'));
  const noCalls = N.STUDY.find(([id]) => id === 'noCalls')[2];
  assert.equal(N.merge(M.deepMerge(N.merge({}), noCalls)).drop, 'CE');
});

test('Live trade: a Builder trade marked nbo is this strategy; its study rules say what is due', () => {
  const L = require('../bt/mcclive');
  const t = { snap: { mcc: { on: true, kind: 'nbo' }, legs: [{ type: 'CE', strike: 24100, lots: 1, action: 'S', open: true }] } };
  assert.equal(L.kindOfTrade(t), 'nbo');
  const pos = { legs: [{ type: 'CE', strike: 24100, lots: 1, side: -1, entry: 100 }] };
  const M = { spot: 23400, px: () => 50 };
  const study = {
    rows: [
      { id: 'none', months: [{ ok: true, expiry: 'e', opt: 0 }] },
      { id: 'move2', label: '2 %', params: N.merge({}), months: [{ ok: true, expiry: 'e', opt: 10 }] },
    ],
  };
  const [r] = L.studyRules(study, pos, M, 24000, 'nbo');
  assert.match(r.due, /call legs down/);
});

test('Live trade suggestions for this shape: sold puts may roll either side of the bought one, names are generic', () => {
  const L = require('../bt/mcclive');
  const { bsm } = require('../lib/pricing');
  const T = 14 / 365;
  const rows = [];
  for (let k = 20000; k <= 26000; k += 50)
    rows.push({
      strike: k,
      ce: { ltp: Math.max(0.05, bsm(23400, k, T, 0.14, true)), vol: 1000 },
      pe: { ltp: Math.max(0.05, bsm(23400, k, T, 0.14, false)), vol: 1000 },
    });
  const M = L.market({ spot: 23400, rows }, T);
  const pos = {
    lot: 65,
    legs: [
      { id: 1, type: 'CE', strike: 23600, lots: 1, side: -1, entry: 120 },
      { id: 2, type: 'PE', strike: 23200, lots: 1, side: 1, entry: 110 },
      { id: 3, type: 'PE', strike: 23000, lots: 1, side: -1, entry: 70 },
    ],
    closed: [],
    realised: { CE: 0, PE: 0 },
    costs: 0,
  };
  const ids = L.candidates(pos, M, { qty: 6500, price: 234, now: 234 }, new Map(), 'nbo').map((c) => c.id);
  assert.ok(ids.includes('peRoll:23300') && ids.includes('peRoll:22800')); // over and under the bought put
  const titles = L.candidates(pos, M, null, new Map(), 'nbo').map((c) => c.title);
  assert.ok(titles.includes('Close the put legs') && titles.includes('Close the call legs'));
  const moves = [];
  for (let i = -40; i <= 40; i++) moves.push(i / 1000);
  const s = L.suggest(pos, M, { qty: 6500, price: 234, now: 234 }, moves, { days: 10, shape: 'nbo' });
  assert.ok(s.tried > 50);
});
