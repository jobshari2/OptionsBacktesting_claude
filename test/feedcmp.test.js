// Upstox vs Kite tick comparison (feedcmp.js): when the two feeds disagree, for how long, and who moved first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComparer, summarize, matches, cleanConfig } = require('../feedcmp');

function setup(fields) {
  const eps = [];
  const c = createComparer({ fields, onEpisode: (e) => eps.push(e) });
  return { c, eps };
}

test('the feed that changes first leads; the other following closes the gap with its lag', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', '24800CE', { ltp: 100 }, 1000);
  c.tick('k', '24800CE', { ltp: 100 }, 1010);
  assert.equal(eps.length, 0, 'same price: nothing to record');
  c.tick('k', '24800CE', { ltp: 100.5 }, 2000); // Kite first
  assert.equal(c.view('24800CE').open.ltp.l, 'k');
  c.tick('u', '24800CE', { ltp: 100.5 }, 2085); // Upstox 85 ms later
  assert.equal(eps.length, 1);
  const [e] = eps;
  assert.equal(e.l, 'k');
  assert.equal(e.b, 'u');
  assert.equal(e.h, 'follow');
  assert.equal(e.e - e.s, 85);
  assert.equal(e.lag, 85);
  assert.equal(e.u0, 100);
  assert.equal(e.k0, 100.5);
  assert.equal(e.v, 100.5);
  assert.equal(e.m, 0.5);
  assert.deepEqual(c.view('24800CE').open, {});
});

test('repeated ticks at the same price are not changes', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', 'X', { ltp: 50 }, 0);
  c.tick('k', 'X', { ltp: 50 }, 0);
  c.tick('u', 'X', { ltp: 51 }, 100);
  c.tick('u', 'X', { ltp: 51 }, 200); // a quote update, same LTP
  c.tick('k', 'X', { ltp: 51 }, 300);
  assert.equal(eps[0].lag, 200, 'lag counts from when Upstox first showed 51');
});

test('lag is measured from the price the follower matched, the gap from the first difference', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', 'X', { ltp: 50 }, 0);
  c.tick('k', 'X', { ltp: 50 }, 0);
  c.tick('u', 'X', { ltp: 50.5 }, 1000);
  c.tick('u', 'X', { ltp: 51 }, 1100); // Kite skips 50.5
  c.tick('k', 'X', { ltp: 51 }, 1150);
  assert.equal(eps[0].h, 'follow');
  assert.equal(eps[0].e - eps[0].s, 150);
  assert.equal(eps[0].lag, 50);
  assert.equal(eps[0].m, 1);
});

test('a lead that goes back without the other feed moving is a price the other never showed', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', 'X', { ltp: 50 }, 0);
  c.tick('k', 'X', { ltp: 50 }, 0);
  c.tick('u', 'X', { ltp: 49.95 }, 500);
  c.tick('u', 'X', { ltp: 50 }, 900);
  assert.equal(eps[0].h, 'revert');
  assert.equal(eps[0].l, 'u');
  assert.equal(eps[0].lag, null);
});

test('both moving while apart and meeting elsewhere is a cross', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', 'X', { ltp: 50 }, 0);
  c.tick('k', 'X', { ltp: 50 }, 0);
  c.tick('u', 'X', { ltp: 51 }, 100);
  c.tick('k', 'X', { ltp: 52 }, 200);
  c.tick('u', 'X', { ltp: 52 }, 300);
  assert.equal(eps[0].h, 'cross');
});

test('a feed dropping cuts open gaps and forgets its prices', () => {
  const { c, eps } = setup(['ltp']);
  c.tick('u', 'X', { ltp: 50 }, 0);
  c.tick('k', 'X', { ltp: 51 }, 10);
  c.reset('k', 500);
  assert.equal(eps[0].h, 'cut');
  assert.equal(eps[0].e, 500);
  c.tick('u', 'X', { ltp: 52 }, 600);
  assert.equal(eps.length, 1, 'no Kite price to compare with until it ticks again');
  assert.deepEqual(c.view('X').k, {});
});

test('bid and ask are compared separately when asked for; a zero bid is no bid', () => {
  const { c, eps } = setup(['ltp', 'bid']);
  c.tick('u', 'X', { ltp: 50, bid: 49.9, ask: 50.1 }, 0);
  c.tick('k', 'X', { ltp: 50, bid: 49.85, ask: 50 }, 5);
  assert.deepEqual(Object.keys(c.view('X').open), ['bid']);
  c.tick('k', 'X', { ltp: 50, bid: 0 }, 6);
  assert.deepEqual(Object.keys(c.view('X').open), ['bid'], 'zero bid ignored');
  c.tick('k', 'X', { ltp: 50, bid: 49.9 }, 40);
  assert.equal(eps[0].f, 'bid');
  assert.equal(eps[0].l, 'k', 'Kite showed its bid after Upstox, so the difference started on Kite');
  c.setFields(['ltp'], 50);
  c.tick('u', 'X', { ltp: 50, bid: 40 }, 60);
  assert.equal(eps.length, 1, 'bid no longer compared');
});

test('the summary counts who led, the lag spread and per-instrument figures', () => {
  const eps = [
    { s: 0, e: 40, i: 'A', f: 'ltp', l: 'u', b: 'k', h: 'follow', m: 0.05, lag: 40 },
    { s: 0, e: 120, i: 'A', f: 'ltp', l: 'u', b: 'k', h: 'follow', m: 0.1, lag: 120 },
    { s: 0, e: 700, i: 'B', f: 'ltp', l: 'k', b: 'u', h: 'follow', m: 0.5, lag: 700 },
    { s: 0, e: 300, i: 'B', f: 'ltp', l: 'k', b: 'k', h: 'revert', m: 0.05, lag: null },
    { s: 0, e: 9, i: 'A', f: 'ltp', l: 'u', b: '-', h: 'cut', m: 1, lag: null },
  ];
  const s = summarize(eps);
  assert.equal(s.count, 5);
  assert.equal(s.ms, 40 + 120 + 700 + 300 + 9);
  assert.equal(s.maxMs, 700);
  assert.equal(s.cut, 1);
  assert.equal(s.u.follow, 2);
  assert.equal(s.k.follow, 1);
  assert.equal(s.k.revert, 1);
  assert.deepEqual(s.u.hist, [1, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(s.k.hist, [0, 0, 0, 0, 1, 0, 0]);
  assert.equal(s.u.med, 120);
  const a = s.inst.find((r) => r.i === 'A');
  assert.equal(a.n, 3);
  assert.equal(a.u, 2);
  assert.equal(a.maxDiff, 1);
  assert.equal(s.inst.find((r) => r.i === 'B').revK, 1);
});

test('filters and config cleaning', () => {
  const e = { s: 0, e: 150, i: 'A', f: 'ltp', l: 'u', h: 'follow', m: 0.1 };
  assert.ok(matches(e, { minMs: 100, minDiff: 0.1 }));
  assert.ok(!matches(e, { minMs: 200 }));
  assert.ok(!matches(e, { lead: 'k' }));
  assert.ok(!matches(e, { field: 'bid' }));
  const c = cleanConfig({ around: 99, extra: ['24500', 'x', 24500, -1], fields: ['bogus'], expiry: 'soon' });
  assert.equal(c.around, 20);
  assert.deepEqual(c.extra, [24500]);
  assert.deepEqual(c.fields, ['ltp']);
  assert.equal(c.expiry, 'nearest');
});
