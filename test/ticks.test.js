const test = require('node:test');
const assert = require('node:assert');
const { createTickStore } = require('../lib/ticks');

const at = (hms) => Date.parse(`2026-10-16T${hms}+05:30`);

test('record keeps trades only, with the quantity each one added', () => {
  const s = createTickStore();
  s.record('F', at('09:15:00.100'), 100, 1000); // first tick of the key: quantity unknown
  s.record('F', at('09:15:00.300'), 100, 1000); // a quote change: not a trade
  s.record('F', at('09:15:01.000'), 100.5, 1065);
  s.record('F', at('09:15:02.000'), 100.5, 1195); // same price, more volume: a trade
  s.record('F', at('09:15:03.000'), 100.5, 1100); // volume going backwards counts as nothing
  const r = s.since('F');
  assert.deepStrictEqual(r.ticks, [
    [at('09:15:00.100'), 100, 0],
    [at('09:15:01.000'), 100.5, 65],
    [at('09:15:02.000'), 100.5, 130],
  ]);
  assert.strictEqual(r.start, 0);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.day, '2026-10-16');
});

test('the index has no volume: a tick whenever its price moves', () => {
  const s = createTickStore();
  for (const [t, px] of [
    ['10:00:00', 24800],
    ['10:00:01', 24800],
    ['10:00:02', 24801.5],
  ])
    s.record('N', at(t), px, null);
  assert.deepStrictEqual(
    s.since('N').ticks.map((x) => [x[1], x[2]]),
    [
      [24800, 0],
      [24801.5, 0],
    ],
  );
});

test('since hands out only the new ticks to a caller of the same generation', () => {
  const s = createTickStore();
  s.record('O', at('10:00:00'), 10, 0);
  s.record('O', at('10:00:01'), 11, 65);
  const a = s.since('O');
  s.record('O', at('10:00:02'), 12, 130);
  const b = s.since('O', a.start + a.ticks.length, a.gen);
  assert.strictEqual(b.start, 2);
  assert.deepStrictEqual(
    b.ticks.map((x) => x[1]),
    [12],
  );
  // an unknown generation (a restart, another day) gets everything again
  const c = s.since('O', 2, a.gen + 1);
  assert.strictEqual(c.start, 0);
  assert.strictEqual(c.ticks.length, 3);
  assert.deepStrictEqual(s.since('missing'), { gen: s.gen, day: '2026-10-16', start: 0, count: 0, ticks: [] });
});

test('the oldest ticks drop off at the cap, and asking for them restarts at the oldest kept', () => {
  const s = createTickStore({ cap: 5000 });
  for (let i = 0; i < 6000; i++) s.record('K', at('10:00:00') + i, 100 + i / 100, i);
  const all = s.since('K');
  assert.strictEqual(all.start, 1000);
  assert.strictEqual(all.ticks.length, 5000);
  assert.strictEqual(all.ticks[0][1], 110);
  assert.strictEqual(all.ticks[4999][0], at('10:00:00') + 5999);
  assert.strictEqual(s.since('K', 10, all.gen).start, 1000);
  assert.strictEqual(s.since('K', 5990, all.gen).ticks.length, 10);
});

test('a new day starts the store over', () => {
  const s = createTickStore();
  s.record('F', at('15:29:59'), 100, 10);
  const g = s.gen;
  s.record('F', Date.parse('2026-10-19T09:15:00+05:30'), 101, 5);
  const r = s.since('F', 1, g);
  assert.notStrictEqual(r.gen, g);
  assert.strictEqual(r.day, '2026-10-19');
  assert.deepStrictEqual(
    r.ticks.map((x) => [x[1], x[2]]),
    [[101, 0]],
  );
  s.record('F', at('15:30:00'), 99, 20); // late update from the day before: ignored
  assert.strictEqual(s.since('F').count, 1);
});
