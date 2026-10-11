const test = require('node:test');
const assert = require('node:assert');
const { buildScenarios, applyScenario } = require('../bt/scenarios');

const legs = [
  { action: 'S', type: 'CE' },
  { action: 'S', type: 'PE' },
];
const positional = { mode: 'positional', entry: { time: '09:20', dteDays: 3 }, exit: { time: '15:15', dteDays: 0 }, legs };
const intraday = { mode: 'intraday', entry: { time: '09:20' }, exit: { time: '15:15' }, legs };

test('positional grid: exits no earlier than the entry day, one row is the strategy as defined', () => {
  const list = buildScenarios(positional);
  assert.deepStrictEqual([...new Set(list.map((x) => x.exit.dteDays))], [0, 1, 2, 3]); // 3 = the entry day itself, 09:20 → 15:15
  assert.strictEqual(list.length, 4 * 10 * 4);
  assert.strictEqual(new Set(list.map((x) => x.key)).size, list.length);
  const base = list.filter((x) => x.base);
  assert.strictEqual(base.length, 1);
  assert.deepStrictEqual([base[0].tgt, base[0].sl, base[0].exit.dteDays], [null, null, 0]);
});

test('a rupee target makes "as defined" its own row', () => {
  const list = buildScenarios({ ...positional, risk: { tgt: 3000 } });
  assert.strictEqual(list[0].own, true);
  assert.strictEqual(list.filter((x) => x.base).length, 1);
  assert.strictEqual(applyScenario({ ...positional, risk: { tgt: 3000 } }, list[0]).risk.tgt, 3000);
});

test('intraday grid: exit times after the entry, debit steps go past 100 %', () => {
  const list = buildScenarios({ ...intraday, entry: { time: '12:45' } }, true);
  assert.deepStrictEqual([...new Set(list.map((x) => x.exit.time))], ['14:00', '15:15']);
  assert.ok(list.some((x) => x.tgt === 200));
});

test('applyScenario replaces the overall stop, target and exit only', () => {
  const s = applyScenario({ ...positional, risk: { sl: 5000, tgt: 3000, lockAt: 1000 } }, { tgt: 30, sl: null, exit: { dteDays: 1, time: '15:15' } });
  assert.deepStrictEqual([s.risk.sl, s.risk.tgt, s.risk.slPrem, s.risk.tgtPrem, s.risk.lockAt], [null, null, null, 30, 1000]);
  assert.strictEqual(s.exit.dteDays, 1);
  assert.strictEqual(s.legs.length, 2);
});

test('an un-rolled leg in an earlier expiry: no exits later than the own exit', () => {
  const s = {
    mode: 'positional',
    entry: { time: '09:20', after: 2 },
    exit: { time: '15:15', dteDays: 5 },
    legs: [
      { action: 'S', type: 'CE', expiry: 'next' },
      { action: 'B', type: 'CE', expiry: 'cur' },
    ],
  };
  assert.deepStrictEqual([...new Set(buildScenarios(s).map((x) => x.exit.dteDays))], [5, 6]);
  s.legs[1].roll = { dteDays: 1, time: '15:15' };
  assert.deepStrictEqual([...new Set(buildScenarios(s).map((x) => x.exit.dteDays))], [0, 1, 2, 3, 5]);
});
