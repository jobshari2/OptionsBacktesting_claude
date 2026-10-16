// Paper trades on big Upstox-vs-Kite gaps (feedpaper.js): when they open, the prices they fill at, and how they close.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFeedPaper, cleanPaper, summarizePaper, summarizeBySurge, readTrades } = require('../feedpaper');

const T0 = Date.parse('2026-10-14T10:50:00+05:30');

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedpaper-'));
  const q = { u: null, k: null };
  const cfg = cleanPaper({ minGap: 5, target: 3, maxHoldSec: 300, cooldownSec: 60, ...over });
  const p = createFeedPaper({ dir, getConfig: () => cfg, quotes: () => q, getLot: () => 65, now: () => T0 });
  return { dir, q, p };
}

test('a big gap opens a BUY at the ask of the feed that moved first, never at the stale price', () => {
  const { q, p } = setup();
  q.k = { ltp: 305, bid: 304.8, ask: 305.2, at: T0 };
  q.u = { ltp: 300, bid: 299.8, ask: 300.2, at: T0 - 20_000 }; // Upstox frozen
  p.check('22500CE', '2026-10-19', { u: 300, k: 304.9, l: 'k' }, T0);
  assert.equal(p.list().length, 0, 'gap of ₹4.90 is below ₹5');
  p.check('22500CE', '2026-10-19', { u: 300, k: 305, l: 'k' }, T0);
  const [t] = p.list();
  assert.equal(t.side, 'BUY');
  assert.equal(t.entry, 305.2);
  assert.equal(t.entryFeed, 'k');
  assert.equal(t.stale, 300);
  assert.equal(t.gap, 5);
  p.check('22500CE', '2026-10-19', { u: 300, k: 306, l: 'k' }, T0 + 100);
  assert.equal(p.list().length, 1, 'one trade per instrument at a time');
});

test('the lower price on the leading feed is a SELL at its bid', () => {
  const { q, p } = setup();
  q.u = { ltp: 260, bid: 259.9, ask: 260.3, at: T0 };
  q.k = { ltp: 266, bid: 265.8, ask: 266.2, at: T0 - 5000 };
  p.check('22950PE', '2026-10-19', { u: 260, k: 266, l: 'u' }, T0);
  const [t] = p.list();
  assert.equal(t.side, 'SELL');
  assert.equal(t.entry, 259.9);
});

test('closes at +₹3 at the price it could be closed at, from the feed that ticked last, with charges', () => {
  const { q, p } = setup();
  q.k = { ltp: 305, bid: 304.8, ask: 305.2, at: T0 };
  q.u = { ltp: 300, bid: 299.8, ask: 300.2, at: T0 - 20_000 };
  p.check('X', 'e', { u: 300, k: 305, l: 'k' }, T0);
  q.k = { ltp: 308.3, bid: 308.1, ask: 308.5, at: T0 + 4000 }; // bid only +2.90
  p.tick(T0 + 4000);
  assert.equal(p.list()[0].status, 'open');
  assert.equal(p.list()[0].pnl, 2.9);
  q.u = { ltp: 308.6, bid: 308.2, ask: 308.7, at: T0 + 5000 }; // Upstox back: its quote is now the latest
  p.tick(T0 + 5000);
  const t = p.list()[0];
  assert.equal(t.status, 'closed');
  assert.equal(t.reason, 'target');
  assert.equal(t.exit, 308.2);
  assert.equal(t.exitFeed, 'u');
  assert.equal(t.pnl, 3);
  assert.equal(t.stalePnl, 8.2);
  assert.equal(t.gross, 195);
  assert.ok(t.costs > 40 && t.costs < 120, 'two orders of brokerage plus taxes: ' + t.costs);
  assert.equal(t.net, Math.round((195 - t.costs) * 100) / 100);
  assert.equal(t.later[5], 3);
});

test('max hold, stop and what happened later; cooldown before the next trade on the instrument', () => {
  const { q, p } = setup({ stop: 2 });
  q.k = { ltp: 105, bid: 104.9, ask: 105.1, at: T0 };
  q.u = { ltp: 100, at: T0 - 1000 };
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  q.k = { ltp: 103, bid: 102.9, ask: 103.1, at: T0 + 2000 };
  p.tick(T0 + 2000);
  assert.equal(p.list()[0].reason, 'stop');
  assert.equal(p.list()[0].pnl, -2.2);
  q.k = { ltp: 110, bid: 109.9, ask: 110.1, at: T0 + 30_000 };
  p.tick(T0 + 30_000);
  assert.equal(p.list()[0].later[30], 4.8, 'still followed after closing');
  p.check('A', 'e', { u: 100, k: 110, l: 'k' }, T0 + 30_000);
  assert.equal(p.list().length, 1, 'cooldown');

  const b = setup({ maxHoldSec: 60 });
  b.q.k = { ltp: 105, bid: 104.9, ask: 105.1, at: T0 };
  b.q.u = { ltp: 100, at: T0 };
  b.p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  b.q.k = { ltp: 106, bid: 105.9, ask: 106.1, at: T0 + 60_000 };
  b.p.tick(T0 + 60_000);
  assert.equal(b.p.list()[0].reason, 'time');
  assert.equal(b.p.list()[0].pnl, 0.8);
});

test('side filter, the day file, and the summary', () => {
  const { dir, q, p } = setup({ side: 'buy' });
  q.u = { ltp: 260, bid: 259.9, ask: 260.3, at: T0 };
  q.k = { ltp: 266, at: T0 };
  p.check('PE', 'e', { u: 260, k: 266, l: 'u' }, T0);
  assert.equal(p.list().length, 0, 'a SELL is skipped when buying only');
  q.k = { ltp: 272, bid: 271.9, ask: 272.1, at: T0 + 1000 };
  p.check('CE', 'e', { u: 266, k: 272, l: 'k' }, T0 + 1000);
  q.k = { ltp: 276, bid: 275.9, ask: 276.1, at: T0 + 3000 };
  p.tick(T0 + 3000);
  p.flush();
  const saved = readTrades(dir, '2026-10-14');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'closed');
  const s = summarizePaper(p.list());
  assert.equal(s.closed, 1);
  assert.equal(s.target, 1);
  assert.equal(s.pnl, 3.8);
  assert.equal(s.stalePnl, 9.9);
});

test('exit when feeds match: closes at the first matching LTPs instead of the target, and every trade notes its convergence profit', () => {
  const { q, p } = setup({ exitOnConverge: true });
  q.k = { ltp: 305, bid: 304.8, ask: 305.2, at: T0 };
  q.u = { ltp: 300, bid: 299.8, ask: 300.2, at: T0 - 20_000 };
  p.check('X', 'e', { u: 300, k: 305, l: 'k' }, T0);
  q.k = { ltp: 312, bid: 311.8, ask: 312.2, at: T0 + 2000 }; // +6.8 per unit, past the ₹3 target: no exit, feeds differ
  p.tick(T0 + 2000);
  assert.equal(p.list()[0].status, 'open');
  assert.equal(p.list()[0].conv, undefined);
  q.u = { ltp: 312, bid: 311.7, ask: 312.3, at: T0 + 4000 }; // Upstox caught up: same LTP
  p.tick(T0 + 4000);
  const t = p.list()[0];
  assert.equal(t.status, 'closed');
  assert.equal(t.reason, 'converge');
  assert.equal(t.exit, 311.7);
  assert.equal(t.pnl, 6.5);
  assert.deepEqual([t.conv.at, t.conv.ltp, t.conv.px, t.conv.pnl, t.conv.gross], [T0 + 4000, 312, 311.7, 6.5, 422.5]);
  assert.equal(t.conv.net, t.net, "closed there: the convergence profit is the trade's net");
});

test('with the exit off the trade closes as before, but the convergence profit is still noted', () => {
  const { q, p } = setup();
  q.k = { ltp: 105, bid: 104.9, ask: 105.1, at: T0 };
  q.u = { ltp: 100, at: T0 - 1000 };
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  q.k = { ltp: 108.5, bid: 108.4, ask: 108.6, at: T0 + 1000 };
  p.tick(T0 + 1000);
  assert.equal(p.list()[0].reason, 'target');
  assert.equal(p.list()[0].conv, undefined);
  q.u = { ltp: 108.5, at: T0 + 2000 }; // matches after the close, within the follow window
  p.tick(T0 + 2000);
  const t = p.list()[0];
  assert.equal(t.reason, 'target');
  assert.equal(t.conv.pnl, 3.4); // priced at Upstox's LTP: it has no bid
  assert.ok(t.conv.net < t.conv.gross);
});

test('a loss-making match still exits when the exit is on; the stop wins if both hold', () => {
  const { q, p } = setup({ exitOnConverge: true, stop: 1 });
  q.k = { ltp: 105, bid: 104.9, ask: 105.1, at: T0 };
  q.u = { ltp: 100, at: T0 - 1000 };
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  q.k = { ltp: 100, bid: 99.9, ask: 100.1, at: T0 + 1000 }; // Kite fell back to Upstox: -5.2 per unit, same LTP
  p.tick(T0 + 1000);
  assert.equal(p.list()[0].reason, 'stop');
  const b = setup({ exitOnConverge: true });
  b.q.k = { ltp: 105, bid: 104.9, ask: 105.1, at: T0 };
  b.q.u = { ltp: 100, at: T0 - 1000 };
  b.p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  b.q.k = { ltp: 100, bid: 99.9, ask: 100.1, at: T0 + 1000 };
  b.p.tick(T0 + 1000);
  assert.equal(b.p.list()[0].reason, 'converge');
  assert.equal(b.p.list()[0].pnl, -5.2);
});

// ---- the optional broad-surge gate
function setupSurge(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedpaper-'));
  const q = { u: { ltp: 100, bid: 99.9, ask: 100.1, at: T0 }, k: { ltp: 105, bid: 104.9, ask: 105.1, at: T0 } };
  const breadth = { ready: true, pct: 20 };
  const cfg = cleanPaper({ minGap: 5, target: 3, cooldownSec: 60, ...over });
  const p = createFeedPaper({ dir, getConfig: () => cfg, quotes: () => q, getLot: () => 65, getSurge: () => breadth, now: () => T0 });
  return { p, breadth, cfg };
}

test('the surge gate is off by default, and every trade is tagged with the volume breadth it opened in', () => {
  assert.equal(cleanPaper().surgeGate, false);
  assert.equal(cleanPaper().surgePct, 60);
  const { p, breadth } = setupSurge();
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  breadth.pct = 72.456;
  p.check('B', 'e', { u: 100, k: 105, l: 'k' }, T0);
  assert.deepEqual(
    p.list().map((t) => t.surge),
    [20, 72.46],
  );
});

test('with the gate on, no trade opens below the level or while the breadth is not ready, and no cooldown is used up', () => {
  const { p, breadth } = setupSurge({ surgeGate: true, surgePct: 60 });
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0);
  assert.equal(p.list().length, 0, 'breadth 20% < 60%');
  breadth.pct = 59.9;
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0 + 1000);
  assert.equal(p.list().length, 0);
  breadth.ready = false;
  breadth.pct = 90;
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0 + 2000);
  assert.equal(p.list().length, 0, 'breadth not ready');
  breadth.ready = true;
  p.check('A', 'e', { u: 100, k: 105, l: 'k' }, T0 + 3000);
  assert.equal(p.list().length, 1, 'opens at once when the surge arrives: gated ticks did not start a cooldown');
  assert.equal(p.list()[0].surge, 90);
});

test('trades split by the breadth they opened in; older ones without a tag are kept apart', () => {
  const mk = (surge, pnl, net) => ({
    status: 'closed',
    reason: 'target',
    pnl,
    net,
    gross: net,
    costs: 0,
    stalePnl: 0,
    ...(surge === undefined ? {} : { surge }),
  });
  const r = summarizeBySurge([mk(80, 3, 100), mk(60, -5, -300), mk(10, -5, -300), mk(null, 3, 100), mk(undefined, 3, 100)], 60);
  assert.equal(r.minPct, 60);
  assert.equal(r.surge.trades, 2);
  assert.equal(r.surge.net, -200);
  assert.equal(r.calm.trades, 1);
  assert.equal(r.untagged.trades, 2);
});
