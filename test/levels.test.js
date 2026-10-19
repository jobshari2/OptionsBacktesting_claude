const test = require('node:test');
const assert = require('node:assert');
const { extend } = require('../bt/levels');

const lv = (prices) => ({
  prev: { h: 24500, l: 24300, c: 24450 },
  levels: prices.map((price) => ({ price, cls: 'major', touches: 3, src: 'daily swing ×3' })),
});

test('extend: a new high past the last swing level gets projected resistance above it', () => {
  const out = extend(lv([24000, 24300, 24500]), 24520);
  const above = out.levels.filter((l) => l.price > 24520);
  assert.ok(above.length >= 3, 'levels above spot');
  assert.ok(above.every((l) => l.projected), 'all of them projected');
  assert.ok(above.some((l) => l.price === 25000 && l.cls === 'major'), 'next 500 is a major level');
  assert.ok(above.some((l) => l.price === 24600 && l.cls === 'minor'), 'next 100 is a minor level');
  assert.strictEqual(out.spot, 24520);
});

test('extend: a new low below the last swing level gets projected support below it', () => {
  const out = extend(lv([24400, 24600, 25000]), 24350);
  const below = out.levels.filter((l) => l.price < 24350);
  assert.ok(below.some((l) => l.price === 24000 && l.cls === 'major'));
  assert.ok(below.every((l) => l.projected));
});

test('extend: nothing is projected where swing levels still reach well beyond spot', () => {
  const base = lv([23000, 24000, 24400, 25400, 26000]);
  const out = extend(base, 24420);
  assert.strictEqual(out.levels.filter((l) => l.projected).length, 0);
  assert.deepStrictEqual(out.levels.map((l) => l.price), [26000, 25400, 24400, 24000, 23000]);
});

test('extend: leaves the input untouched and tolerates missing data', () => {
  const base = lv([24000]);
  extend(base, 24100);
  assert.strictEqual(base.levels.length, 1);
  assert.strictEqual(extend(null, 24100), null);
  assert.strictEqual(extend(base, NaN), base);
});
