// Trading charges by date (lib/costs.js): the rates in force on a day, and the charges on a set of orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const Costs = require('../lib/costs');

test('the rates in force follow the budget dates', () => {
  assert.equal(Costs.rates('2024-09-30').stt, 0.000625);
  assert.equal(Costs.rates('2024-10-01').stt, 0.001);
  assert.equal(Costs.rates('2026-03-31').stt, 0.001);
  assert.equal(Costs.rates('2026-03-31').exStt, 0.00125);
  // Finance Act 2026: 0.15 % on option sales and on exercise, from 1 April 2026
  assert.equal(Costs.rates('2026-04-01').stt, 0.0015);
  assert.equal(Costs.rates('2026-04-01').exStt, 0.0015);
  assert.equal(Costs.rates('2019-01-01'), Costs.SCHEDULE[0], 'before the first row: the first row');
  assert.equal(Costs.rates(), Costs.SCHEDULE[Costs.SCHEDULE.length - 1], 'no day: the latest');
  assert.ok(
    Costs.SCHEDULE.every((r, i) => i === 0 || r.from > Costs.SCHEDULE[i - 1].from),
    'rows in date order',
  );
});

test('charges on orders: brokerage, STT on sales, fees and GST, stamp duty on buys', () => {
  // ₹1,00,000 bought and ₹1,00,000 sold in 2 orders on a day in 2026-27
  const day = '2026-06-01';
  const cost = Costs.orders({ buy: 100000, sell: 100000, orders: 2, day });
  const fees = 200000 * (0.0003503 + 0.000001);
  const want = 40 + 100000 * 0.0015 + fees + 0.18 * (40 + fees) + 100000 * 0.00003;
  assert.ok(Math.abs(cost - want) < 1e-9, `${cost} vs ${want}`);
  // the same orders a year earlier paid 0.10 % STT: ₹50 less
  assert.ok(Math.abs(cost - Costs.orders({ buy: 100000, sell: 100000, orders: 2, day: '2025-06-01' }) - 50) < 1e-9);
  // nothing traded, nothing charged; brokerage is per order and can be changed
  assert.equal(Costs.orders({}), 0);
  assert.ok(Math.abs(Costs.orders({ orders: 4, brokerage: 0, day }) - 0) < 1e-12);
  assert.ok(Math.abs(Costs.orders({ orders: 4, day }) - 80 * 1.18) < 1e-9);
});

test('a bought option that expires in the money pays STT on what it settles for', () => {
  assert.ok(Math.abs(Costs.exercise(65 * 300, '2026-06-01') - 65 * 300 * 0.0015) < 1e-9);
  assert.ok(Math.abs(Costs.exercise(65 * 300, '2025-06-01') - 65 * 300 * 0.00125) < 1e-9);
  assert.equal(Costs.exercise(0, '2026-06-01'), 0);
  assert.equal(Costs.exercise(-5, '2026-06-01'), 0);
});
