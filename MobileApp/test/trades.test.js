// The Trades screen's maths (js/trades.js): a copy of the portal's Ledger and Portfolio P&L.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, portfolio, growth, buckets, accountOf, strategyOf, splitOf, repoOf } from '../www/js/trades.js';

const leg = (o) => ({ lots: 1, expiry: '2026-12-29', ...o });
const closed = {
  id: 't1', name: 'Collar A', createdAt: 0, savedAt: 0,
  summary: { src: 'live', open: 0, closed: 3, lot: 65, total: -2000 },
  snap: {
    src: 'live', spotEntry: 25000,
    mcc: { on: true, kind: 'psc', qty: 1000, price: 280, day: '2026-11-02', exitPx: 290 },
    legs: [
      leg({ action: 'S', type: 'CE', strike: 25500, entryPx: 300, entryDay: '2026-11-02', exitDay: '2026-11-10', exitPx: 330, spotIn: 25000 }),
      leg({ action: 'B', type: 'PE', strike: 24800, entryPx: 250, entryDay: '2026-11-02', exitDay: '2026-11-10', exitPx: 230, spotIn: 25000 }),
      leg({ action: 'S', type: 'PE', strike: 24500, entryPx: 150, entryDay: '2026-11-02', exitDay: '2026-11-10', exitPx: 140, spotIn: 25000 }),
    ],
  },
};
const open = {
  id: 't2', name: 'Collar B', createdAt: 0, savedAt: 0,
  summary: { src: 'live', open: 1, closed: 0, lot: 65, total: 500 },
  snap: { src: 'live', spotEntry: 25200, mcc: { on: true, kind: 'psc', qty: 1000, price: 292, day: '2026-11-12' }, legs: [leg({ action: 'S', type: 'CE', strike: 25700, entryPx: 200, entryDay: '2026-11-12', spotIn: 25200, open: true })] },
};
const paper = { ...open, id: 't3', name: 'Paper trade', summary: { ...open.summary, src: 'replay' } };
const L = { capital: 1_000_000, capitalDate: '2026-11-01', reinvest: true, px: {}, rows: {}, entries: [] };

test('accounts and strategy names as the portal reads them', () => {
  assert.equal(accountOf(closed), 'live');
  assert.equal(accountOf(paper), 'paper');
  assert.equal(strategyOf(closed), 'Put spread collar');
});

test('NIFTYBEES: sold at its exit, else at the price now', () => {
  assert.equal(splitOf(closed).bees, 10_000);
  assert.equal(splitOf(open, { beesPx: 300 }).bees, 8_000);
});

test('ledger and portfolio of the Live trades', () => {
  const B = buildLedger([closed, open, paper], L, { scope: 'live', beesPx: 300, today: '2026-11-20' });
  assert.equal(B.trades.length, 2);
  assert.equal(B.s.optBooked, -2000);
  assert.equal(B.optOpen, 500);
  assert.equal(B.s.beesReal, 10_000);
  assert.equal(B.s.units, 1000);
  // P&L = options booked + open + NIFTYBEES sold + held at 300
  assert.equal(Math.round(B.total), -2000 + 500 + 10_000 + 8_000);
  const M = portfolio(B);
  assert.equal(Math.round(M.pnl), Math.round(B.total));
  assert.equal(M.value - M.s.inv, M.pnl);
  assert.equal(M.rows.at(-1).action, 'Current value');
  // CE and PE legs: one options item
  assert.ok(M.rows.filter((r) => r.action === 'Options opened').every((r) => /^Options \((CE \+ PE|CE|PE)\)$/.test(r.inst)));
  const G = growth(M, {});
  assert.equal(G.pts.at(-1).profit, M.pnl);
  const K = buckets(G.pts, 0, '2026-11-20');
  assert.equal(Math.round(K.list.reduce((a, b) => a + b.v, 0)), Math.round(M.pnl));
});

test('the repository: the setting, else <owner>.github.io/<repo>/', () => {
  assert.equal(repoOf({ hostname: 'me.github.io', pathname: '/MyRepo/' }, ''), 'me/MyRepo');
  assert.equal(repoOf({ hostname: 'localhost', pathname: '/' }, 'a/b'), 'a/b');
});
