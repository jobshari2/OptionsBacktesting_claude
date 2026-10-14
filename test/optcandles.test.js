const test = require('node:test');
const assert = require('node:assert');
const { aggregate, respond, createOptionCandles } = require('../lib/optcandles');
const { istDate } = require('../lib/time');

const row = (ts, o, h, l, c) => [`${ts}+05:30`, o, h, l, c, 100, 5000];
const sec = (iso) => Date.parse(iso + 'Z') / 1000;

test('aggregate folds 1-minute rows into the timeframe, in IST wall-clock seconds', () => {
  const rows = [
    row('2026-10-06T09:17:00', 12, 14, 11, 13), // out of order on purpose
    row('2026-10-06T09:15:00', 10, 11, 9, 10.5),
    row('2026-10-06T09:16:00', 10.5, 13, 10, 12),
    row('2026-10-06T09:20:00', 13, 13, 12, 12.5),
    row('2026-10-06T15:30:00', 1, 1, 1, 1), // after the session: dropped
  ];
  assert.deepStrictEqual(aggregate(rows, '5'), [
    [sec('2026-10-06T09:15:00'), 10, 14, 9, 13],
    [sec('2026-10-06T09:20:00'), 13, 13, 12, 12.5],
  ]);
  assert.strictEqual(aggregate(rows, '1').length, 4);
  assert.deepStrictEqual(aggregate(rows, 'D'), [[sec('2026-10-06T00:00:00'), 10, 14, 9, 12.5]]);
});

test('aggregate refuses timeframes an option chart does not offer', () => {
  assert.throws(() => aggregate([], 'W'), /Unknown chart timeframe/);
  assert.throws(() => aggregate([], '7'), /Unknown chart timeframe/);
});

test('respond reports the previous close and the newest day', () => {
  const r = respond([row('2026-10-05T15:29:00', 8, 9, 7, 8.5), row('2026-10-06T09:15:00', 10, 11, 9, 10.5)], '15');
  assert.strictEqual(r.prevClose, 8.5);
  assert.strictEqual(r.day, '2026-10-06');
  assert.strictEqual(r.first, '2026-10-05');
  assert.strictEqual(r.more, false);
  assert.strictEqual(r.candles.length, 2);
});

test('createOptionCandles joins the history with today and asks Upstox once per contract', async () => {
  const today = istDate();
  const calls = [];
  const bulk = async (p) => {
    calls.push(p);
    const key = p.includes('/intraday/') ? 'today' : 'history';
    return {
      candles: key === 'today' ? [[`${today}T09:15:00+05:30`, 20, 21, 19, 20.5, 1, 1]] : [['2020-01-01T09:15:00+05:30', 5, 6, 4, 5.5, 1, 1]],
    };
  };
  const oc = createOptionCandles({ bulk });
  const a = await oc.candles('NSE_FO|1', '5');
  await oc.candles('NSE_FO|1', '15');
  assert.strictEqual(calls.length, 2); // one history read, one intraday read: the second answer came from the cache
  assert.deepStrictEqual(
    a.candles.map((c) => c[4]),
    [5.5, 20.5],
  );
  assert.strictEqual(a.prevClose, 5.5);
  assert.ok(a.today);
});

test('createOptionCandles still answers when the contract has no history yet', async () => {
  const today = istDate();
  const bulk = async (p) => {
    if (!p.includes('/intraday/')) throw new Error('no data');
    return { candles: [[`${today}T09:15:00+05:30`, 20, 21, 19, 20.5, 1, 1]] };
  };
  const r = await createOptionCandles({ bulk }).candles('NSE_FO|2', '5');
  assert.strictEqual(r.candles.length, 1);
  assert.strictEqual(r.prevClose, null);
});
