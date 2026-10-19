const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSignalLog } = require('../pulse-signals');

const T0 = Date.UTC(2026, 9, 19, 4, 0, 0);
const MIN = 60_000;
const snap = (bid, ask = bid + 0.4) => ({ spot: 24300, rows: [{ strike: 24300, ce: { bid, ask, ltp: bid }, pe: { bid: 50, ask: 50.4, ltp: 50 } }] });
const buy = { action: 'BUY', side: 'CE', leanSide: 'CE', score: 2.5, reasons: ['why'], pick: { strike: 24300, premiumTarget: 100, premiumStop: 80 } };
const lines = (dir) =>
  fs
    .readFileSync(path.join(dir, '2026-10-19', 'pulse-signals.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

function mk(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  return { dir, log: createSignalLog({ dir, lot: () => 65, latencySec: 0, ...opts }) };
}

test('a BUY opens one paper trade at the ask plus slippage and writes state + entry', () => {
  const { dir, log } = mk();
  log.consider(T0, buy, snap(89.6), 24300);
  log.consider(T0 + MIN, buy, snap(89.6), 24300); // already open: no second trade
  const rec = lines(dir);
  assert.deepEqual(
    rec.map((r) => r.type),
    ['state', 'entry'],
  );
  assert.equal(rec[1].px, +(90 * 1.005).toFixed(2));
  assert.equal(log.snapshot().open.length, 1);
});

test('target exit books a net profit after charges and writes it to the file', () => {
  const { dir, log } = mk();
  log.consider(T0, buy, snap(89.6), 24300);
  log.manage(T0 + 2 * MIN, snap(101));
  const x = lines(dir).find((r) => r.type === 'exit');
  assert.equal(x.reason, 'target');
  assert.ok(x.pnl > 0 && x.pnl < x.gross); // charges are taken off
  assert.equal(log.snapshot().n, 1);
  assert.equal(log.snapshot().wins, 1);
});

test('stop and time exits lose; entries respect the cool-down and the one-at-a-time rule', () => {
  const { log } = mk({ maxHoldMin: 5 });
  log.consider(T0, buy, snap(89.6), 24300);
  log.manage(T0 + MIN, snap(79));
  assert.equal(log.closedAll()[0].reason, 'stop');
  assert.ok(log.closedAll()[0].pnl < 0);
  log.consider(T0 + 2 * MIN, buy, snap(89.6), 24300); // inside the 10-minute cool-down
  assert.equal(log.snapshot().open.length, 0);
  log.consider(T0 + 12 * MIN, buy, snap(89.6), 24300);
  log.manage(T0 + 18 * MIN, snap(90)); // neither target nor stop: closed by time
  assert.equal(log.closedAll()[1].reason, 'time');
});

test('WATCH / WAIT write a state line but never open a trade', () => {
  const { dir, log } = mk();
  log.consider(T0, { action: 'WATCH', leanSide: 'PE', score: -1, reasons: [], pick: { strike: 24300 } }, snap(89.6), 24300);
  assert.equal(log.snapshot().open.length, 0);
  assert.deepEqual(
    lines(dir).map((r) => r.type),
    ['state'],
  );
});

test('with a fill delay the entry and exit fill at the quotes a few seconds after the signal', () => {
  const { dir, log } = mk({ latencySec: 3 });
  log.consider(T0, buy, snap(89.6), 24300); // signal: ask 90.0
  assert.equal(log.snapshot().open.length, 0); // not filled yet
  log.manage(T0 + 3000, snap(91.6)); // 3 s later the ask is 92.0
  const e = lines(dir).find((r) => r.type === 'entry');
  assert.equal(e.signalAsk, 90);
  assert.equal(e.px, +(92 * 1.005).toFixed(2));
  log.manage(T0 + 60_000, snap(101)); // bid crosses the target: sell order sent
  assert.equal(log.snapshot().n, 0);
  log.manage(T0 + 63_000, snap(98)); // filled at the bid 3 s later, not at the trigger bid
  const x = lines(dir).find((r) => r.type === 'exit');
  assert.equal(x.reason, 'target');
  assert.equal(x.signalBid, 101);
  assert.equal(x.px, +(98 * 0.995).toFixed(2));
});

test('readDay / listDays rebuild a saved day: entries joined with exits, totals over finished trades', () => {
  const { readDay, listDays } = require('../pulse-signals');
  const { dir, log } = mk();
  log.consider(T0, buy, snap(89.6), 24300);
  log.manage(T0 + 2 * MIN, snap(101)); // target: a win
  log.consider(T0 + 20 * MIN, buy, snap(89.6), 24300); // a second trade, left open
  const d = readDay(dir, '2026-10-19');
  assert.equal(d.trades.length, 2);
  assert.equal(d.n, 1);
  assert.equal(d.wins, 1);
  assert.equal(d.open, 1);
  assert.equal(d.pnl, d.trades[0].pnl);
  assert.equal(d.trades[1].open, true);
  assert.deepEqual(listDays(dir), [{ day: '2026-10-19', n: 1, wins: 1, pnl: d.pnl, open: 1 }]);
  assert.equal(readDay(dir, '../etc'), null); // only YYYY-MM-DD names are read
  assert.equal(readDay(dir, '2026-01-01'), null);
});

test('a restart takes the day back from the file: finished trades stay, a running one is closed as "restart"', () => {
  const { readDay } = require('../pulse-signals');
  const { dir, log } = mk();
  log.consider(T0, buy, snap(89.6), 24300);
  log.manage(T0 + 2 * MIN, snap(101)); // trade 1: a win
  log.consider(T0 + 20 * MIN, buy, snap(89.6), 24300); // trade 2: running when the server stops
  const again = createSignalLog({ dir, lot: () => 65, latencySec: 0 }); // the server starts again
  again.manage(T0 + 21 * MIN, snap(90));
  const s = again.snapshot();
  assert.equal(s.n, 1); // only the finished trade counts
  assert.equal(s.closed.length, 2); // the lost one is listed
  assert.equal(s.closed[1].reason, 'restart');
  assert.equal(s.open.length, 0);
  assert.equal(s.pnl, readDay(dir, '2026-10-19').pnl);
  again.consider(T0 + 22 * MIN, buy, snap(89.6), 24300); // inside the cool-down of the restored trade 2
  assert.equal(again.snapshot().open.length, 0);
  again.consider(T0 + 40 * MIN, buy, snap(89.6), 24300);
  assert.equal(again.snapshot().open[0].id, '2026-10-19-3'); // ids carry on, no clash with the earlier ones
  assert.equal(readDay(dir, '2026-10-19').open, 1);
});
