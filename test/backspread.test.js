// Back spread + 2 butterflies (lib/backspread.js, Live Ideas › Back spreads): the strike window, the payoff of the
// user's Opstra example and the ranking.
const test = require('node:test');
const assert = require('node:assert/strict');
const BS = require('../lib/backspread');

const ks = [];
for (let k = 24000; k <= 26000; k += 50) ks.push(k);
const ai = ks.indexOf(25000);

test('every leg of every candidate lies within ATM ± the window, the centre on the side the back spread gains', () => {
  for (const side of ['PE', 'CE'])
    for (const win of BS.WINDOWS) {
      const gs = BS.geometries(ks, ai, side, win);
      assert.ok(gs.length > 0, `${side} ±${win} has candidates`);
      for (const g of gs) {
        for (const r of BS.ROLES) assert.ok(Math.abs(ks.indexOf(g[r]) - ai) <= win, `${side} ±${win} ${r} ${g[r]} inside`);
        assert.ok(side === 'PE' ? g.m <= 25000 : g.m >= 25000, 'centre on the gain side');
        assert.equal(g.hi - g.lo, 3 * g.W, 'wings 1.5 W either side of the centre');
        assert.equal(Math.abs(g.k1 - g.k2), g.W);
      }
    }
  // ±5 strikes (250 pts) only fits a 100-wide back spread: its wings are 150 from the centre
  assert.deepEqual([...new Set(BS.geometries(ks, ai, 'PE', 5).map((g) => g.W))], [100]);
  assert.ok(
    BS.geometries(ks, ai, 'PE', 20).some((g) => g.W === 400),
    'a wide window allows wide spreads',
  );
});

test('the Opstra example: put back spread 14900/14800 + 2 iron butterflies at 14850', () => {
  const g = { W: 100, m: 14850, k1: 14900, k2: 14800, lo: 14700, hi: 15000 };
  const px = { '14850PE': 23.2, '14850CE': 394, '14700PE': 12.6, '15000CE': 266.6, '14900PE': 29.2, '14800PE': 18.8 };
  const L = BS.legsOf(g, 'PE', 'iron').map((l) => ({ ...l, px: px[l.k + l.type] }));
  const e = BS.evaluate(L, { spot: 15175.3 });
  assert.equal(Math.round(e.net * 10) / 10, 267.6, 'net credit');
  assert.equal(Math.round(e.worst * 10) / 10, -32.4, 'worst: ₹2,430 for 75');
  assert.equal(Math.round(e.peak * 10) / 10, 217.6, 'peak at 14850: ₹16,320 for 75');
  // Opstra's breakevens, to the point
  [14668, 14733, 14984].forEach((x, i) => assert.ok(Math.abs(e.bes[i] - x) <= 1, `breakeven ${x}: ${e.bes[i]}`));
  // the single-type form has the same payoff shape: the same worst and peak relative to its own premium
  const same = BS.legsOf(g, 'PE', 'same');
  assert.deepEqual(
    same.map((l) => `${l.act}${l.n}${l.k}${l.type}`),
    ['S414850PE', 'B214700PE', 'B215000PE', 'S114900PE', 'B214800PE'],
  );
});

test('ranking: min loss, chance of profit, peak per point of loss', () => {
  const a = { worst: -10, peak: 100, pop: 0.2 };
  const b = { worst: -40, peak: 300, pop: 0.4 };
  assert.deepEqual([b, a].sort(BS.better('loss')), [a, b]);
  assert.deepEqual([a, b].sort(BS.better('pop')), [b, a]);
  assert.deepEqual([b, a].sort(BS.better('peak')), [a, b]);
});
