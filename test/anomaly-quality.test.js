// The parts of the scanners that decide whether a mispricing is real: the strike-weighted butterfly, the quality
// gates on every leg (two-sided, uncrossed, tight, fresh, traded, deep enough), the rejected signals with their
// reason, and the worst-price test that tells a mispricing from two last trades a few seconds apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../bt/anomalies');

const SPOT = 24000;
const W = 50;
const T = A.tradingYears('2026-10-08', '2026-10-05', 60);

// Fair Black-76 chain, ATM ± 15 strikes at a flat vol; `edit(ce, pe, ks)` nudges prices before the Chain is built.
function chain({ vol = 0.13, t = T, edit, extra = {} } = {}) {
  const df = Math.exp(-A.RATE * t);
  const fwd = SPOT / df;
  const ks = Array.from({ length: 31 }, (_, i) => SPOT + (i - 15) * W);
  const ce = ks.map((k) => A.b76(fwd, k, t, vol, true, df));
  const pe = ks.map((k) => A.b76(fwd, k, t, vol, false, df));
  if (edit) edit(ce, pe, ks);
  return new A.Chain({
    spot: SPOT,
    T: t,
    ks,
    ce,
    pe,
    expiry: '2026-10-08',
    day: '2026-10-05',
    minute: 60,
    open: SPOT,
    prev: () => null,
    next: () => null,
    rv: () => null,
    dayIv: () => null,
    ...extra,
  });
}
const at = (ks, k) => ks.indexOf(k);
// A live order book around the prices: half-spread `hs`, `q` units on each side, plenty of volume and open interest.
function withBook(c, { hs = 0.25, q = 650, lot = 65, edit } = {}) {
  Object.assign(c, {
    book: true,
    lot,
    now: 1_000_000,
    ceBid: c.ce.map((x) => Math.max(0, x - hs)),
    ceAsk: c.ce.map((x) => x + hs),
    peBid: c.pe.map((x) => Math.max(0, x - hs)),
    peAsk: c.pe.map((x) => x + hs),
  });
  for (const k of ['ceBidQ', 'ceAskQ', 'peBidQ', 'peAskQ']) c[k] = c.ks.map(() => q);
  for (const k of ['ceVol', 'peVol', 'ceOi', 'peOi']) c[k] = c.ks.map(() => 1e7);
  for (const k of ['ceAt', 'peAt']) c[k] = c.ks.map(() => 999_000); // quotes refreshed a second ago
  if (edit) edit(c);
  return c;
}
// The exact legs of a hit as resolved positions, priced at the last prices.
const legsOf = (c, h) => h.st.map((l) => ({ dir: l.act === 'B' ? 1 : -1, qty: l.n, type: l.t, strike: l.k, px: c.px(l.k, l.t) }));

test('broken-wing butterfly: strike-weighted lots, never worth less than zero, and its suggestion matches', () => {
  // body 24100 CE made 4 dearer: the 1-strike / 2-strike butterflies around it pay a credit
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24100)] += 4;
    },
  });
  const hs = A.detect('bwfly', c).filter((h) => h.strike === 24100 && h.side === 'CE');
  assert.deepEqual(hs.map((h) => h.dir).sort(), ['high-wide', 'low-wide']);
  for (const h of hs) {
    const wide = h.dir === 'high-wide';
    // 50 / 100-point wings: 2 lots of the narrow wing, 3 of the body, 1 of the wide wing
    assert.deepEqual(
      h.st.map((l) => [l.act, l.k, l.n]),
      wide
        ? [
            ['B', 24050, 2],
            ['S', 24100, 3],
            ['B', 24200, 1],
          ]
        : [
            ['B', 24000, 1],
            ['S', 24100, 3],
            ['B', 24150, 2],
          ],
    );
    const legs = legsOf(c, h);
    // the payoff alone (prices set to zero) is never negative and is zero outside the wings
    const payoff = legs.map((l) => ({ ...l, px: 0 }));
    assert.ok(A.worstAtExpiry(payoff, SPOT) >= -1e-9);
    assert.equal(A.valueAt(payoff, 23000), 0);
    assert.equal(A.valueAt(payoff, 25000), 0);
    assert.equal(A.valueAt(payoff, 24100), 100, 'peaks at the body: narrow-wing lots x its width');
    // so the credit is locked in
    assert.ok(Math.abs(A.worstAtExpiry(legs, SPOT) - h.value) < 1e-6);
    assert.ok(h.value > 0.5 && Math.abs(h.locked - h.value) < 1e-9);
    // the suggested trade (signal strikes) is the same structure
    const sug = A.suggest(h).legs.map((l) => [l.action, c.ks[c.idx.get(h.strike) + l.strike.value], l.lots]);
    assert.deepEqual(
      sug,
      h.st.map((l) => [l.act, l.k, l.n]),
    );
  }
  // wings of the same width are the plain butterfly, not this type
  assert.deepEqual(
    A.detect('bwfly', c, { near: 1, far: 1 }).filter((h) => h.st[1].n === 2),
    [],
  );
  // a fair chain has none, with other wing widths too
  for (const far of [2, 3, 4]) assert.deepEqual(A.detect('bwfly', chain(), { far, band: 12 }), [], `far ${far}`);
  assert.deepEqual(A.detect('bwfly', withBook(chain()), { band: 12 }), []);
});

test('quality gates: a leg must be two-sided, uncrossed, tight, fresh, traded and deep enough', () => {
  // 24200 CE can be sold 3 above what 24150 CE costs: a free credit when every gate passes
  const mk = (edit) =>
    withBook(
      chain({
        edit: (ce, pe, ks) => {
          ce[at(ks, 24200)] = ce[at(ks, 24150)] + 3;
        },
      }),
      { edit },
    );
  const hit = (c, p) => A.detect('varb', c, p).find((h) => h.strike === 24150 && h.ref === 24200 && h.dir === 'free-credit');
  const why = (c, p) => A.scan('varb', c, p, { rejects: true }).rejected.find((r) => /24150\/24200/.test(r.label));
  const i50 = (c) => at(c.ks, 24150);
  const i200 = (c) => at(c.ks, 24200);
  assert.ok(hit(mk()));
  assert.equal(why(mk()), undefined, 'a hit is not also a rejection');

  const cases = [
    [
      'crossed',
      (c) => {
        c.ceBid[i50(c)] = c.ceAsk[i50(c)] + 1;
      },
      /crossed quote/,
    ],
    [
      'quote',
      (c) => {
        c.ceBid[i50(c)] = 0;
      },
      /no bid/,
    ], // one-sided, although only the ask is needed to buy it
    [
      'spread',
      (c) => {
        c.ceBid[i200(c)] -= 0;
        c.ceAsk[i200(c)] += 6;
      },
      /spread/,
    ],
    [
      'stale',
      (c) => {
        c.ceAt[i200(c)] = c.now - 40_000;
      },
      /40 s old/,
    ],
    [
      'depth',
      (c) => {
        c.ceBidQ[i200(c)] = 40;
      },
      /0 lots at the bid/,
    ],
    [
      'volume',
      (c) => {
        c.ceVol[i50(c)] = 65 * 100;
      },
      /only 100 lots traded today/,
    ],
    [
      'oi',
      (c) => {
        c.ceOi[i50(c)] = 65 * 900;
      },
      /open interest only 900 lots/,
    ],
  ];
  for (const [code, edit, text] of cases) {
    const c = mk(edit);
    assert.equal(hit(c), undefined, code);
    const r = why(c);
    assert.ok(r, `${code} is reported as a rejected signal`);
    assert.equal(r.code, code);
    assert.match(r.why, text);
    assert.ok(r.apparent >= 0.5, 'it looked like an arbitrage at mids or last prices');
  }
  // the gates are thresholds, not fixed rules
  assert.ok(
    hit(
      mk((c) => {
        c.ceAt[i200(c)] = c.now - 40_000;
      }),
      { maxAge: 0 },
    ),
    'quote age 0 = any',
  );
  assert.ok(
    hit(
      mk((c) => {
        c.ceVol[i50(c)] = 65 * 100;
      }),
      { minVol: 50 },
    ),
  );
  assert.ok(
    hit(
      mk((c) => {
        c.ceOi[i50(c)] = 65 * 900;
      }),
      { minOi: 0 },
    ),
  );
  // wide in points but not as a share of the premium passes: either limit is enough
  const deep = withBook(
    chain({
      edit: (ce, pe, ks) => {
        ce[at(ks, 23400)] = ce[at(ks, 23350)] + 8;
      },
    }),
    { hs: 2.5 },
  );
  assert.ok(
    A.detect('varb', deep, { band: 15, minOi: 0 }).some((h) => h.strike === 23350 && h.ref === 23400),
    '5 points on a 600-point option is under 1 %',
  );
  // a recorded tape without quantities cannot be checked for size: the depth gate is skipped, nothing else
  const tape = mk((c) => {
    c.depth = false;
    c.ceBidQ = c.ceAskQ = c.peBidQ = c.peAskQ = c.ks.map(() => 0);
  });
  assert.equal(hit(tape).fit, null);
});

test('rejected signals: there at mids or last trades, not at the bid / ask', () => {
  // last trades say 24200 CE is 1 dearer than 24150 CE, but the quotes are 1.5 wide: buying one at the ask costs
  // more than selling the other at the bid pays
  const c = withBook(
    chain({
      edit: (ce, pe, ks) => {
        ce[at(ks, 24200)] = ce[at(ks, 24150)] + 1;
      },
    }),
    { hs: 0.75 },
  );
  const r = A.scan('varb', c, {}, { rejects: true });
  assert.equal(r.hits.length, 0);
  const x = r.rejected.find((y) => /24150\/24200/.test(y.label));
  assert.equal(x.code, 'touch');
  assert.equal(x.basis, 'mid');
  assert.ok(Math.abs(x.apparent - 1) < 1e-9 && Math.abs(x.touch + 0.5) < 1e-9);
  assert.match(x.why, /loses 0\.50 pts/);
  // quotes back in line, only the last trade is off: a stale print
  const c2 = withBook(chain(), { hs: 0.25 });
  c2.ce[at(c2.ks, 24200)] = c2.ce[at(c2.ks, 24150)] + 2;
  const x2 = A.scan('varb', c2, {}, { rejects: true }).rejected.find((y) => /24150\/24200/.test(y.label));
  assert.equal(x2.basis, 'last');
  assert.equal(x2.code, 'touch');
  // rejections are only collected when asked for, and never change the hits
  assert.deepEqual(A.scan('varb', c).rejected, []);
  assert.deepEqual(A.detect('varb', c), []);
});

test('history: a mispricing must hold at the worst prices of the minute, not just between two closes', () => {
  assert.equal(A.worstPx(101, 99, true, 1), 101, 'a buy at the high');
  assert.equal(A.worstPx(101, 99, false, 1), 99, 'a sell at the low');
  // one price in the minute: the other side of the book is taken a full permitted spread away
  assert.ok(Math.abs(A.worstPx(600, 600, true, 1) - 606) < 1e-9);
  assert.ok(Math.abs(A.worstPx(600, 600, false, 1) - 594) < 1e-9);
  assert.ok(Math.abs(A.worstPx(0.4, 0.4, true, 1) - 0.45) < 1e-9, 'at least one tick');
  assert.ok(Math.abs(A.worstPx(0.05, 0.05, false, 1) - 0.05) < 1e-9, 'never below a tick');

  const bars = (c, range) =>
    Object.assign(c, {
      ceHi: c.ce.map((x) => x + range),
      ceLo: c.ce.map((x) => Math.max(0.05, x - range)),
      peHi: c.pe.map((x) => x + range),
      peLo: c.pe.map((x) => Math.max(0.05, x - range)),
    });
  const mk = (bump, range) =>
    bars(
      chain({
        edit: (ce, pe, ks) => {
          ce[at(ks, 24200)] = ce[at(ks, 24150)] + bump;
        },
      }),
      range,
    );
  const hit = (c) => A.detect('varb', c).find((h) => h.strike === 24150 && h.ref === 24200);
  // closes 3 apart, but each contract traded over a 4-point range in that minute: timing noise
  const noisy = hit(mk(3, 2));
  assert.ok(Math.abs(noisy.value - 3) < 1e-9);
  assert.ok(Math.abs(noisy.robust + 1) < 1e-9, 'bought at its high and sold at the other low it loses 1');
  // 6 apart with the same ranges: there whatever order the trades came in
  assert.ok(Math.abs(hit(mk(6, 2)).robust - 2) < 1e-9);
  // a leg that did not trade in the minute cannot be judged
  const c = mk(6, 2);
  c.ceHi[at(c.ks, 24200)] = 0;
  assert.equal(hit(c).robust, null);
  // live chains carry quotes instead of bars
  assert.equal(A.detect('varb', withBook(mk(6, 2))).find((h) => h.ref === 24200).robust, null);
});

test('history: legs far in the money are left out, as there are no quotes to judge them by', () => {
  // 23450 CE (550 in the money) prints 4 above 23400 CE: at last trades a free credit
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 23450)] = ce[at(ks, 23400)] + 4;
    },
  });
  const hit = (p) => A.detect('varb', c, { band: 15, ...p }).find((h) => h.strike === 23400 && h.ref === 23450);
  assert.equal(hit(), undefined, 'beyond the default 300 points');
  assert.ok(hit({ maxItm: 700 }));
  assert.ok(hit({ maxItm: 0 }), '0 = any');
  // the same pair with a live book is judged by its quotes, volume and open interest instead
  const live = withBook(
    chain({
      edit: (ce, pe, ks) => {
        ce[at(ks, 23450)] = ce[at(ks, 23400)] + 4;
      },
    }),
  );
  assert.ok(A.detect('varb', live, { band: 15 }).some((h) => h.strike === 23400 && h.ref === 23450));
  // out-of-the-money and near-the-money legs are untouched
  const near = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24200)] = ce[at(ks, 24150)] + 3;
    },
  });
  assert.ok(A.detect('varb', near).some((h) => h.strike === 24150 && h.ref === 24200));
});

test('money is discounted over calendar time, volatility runs on trading time', () => {
  // Friday 15:00 to Tuesday 15:30: 2 sessions and 30 minutes of trading, but 4 days of interest
  const ty = A.tradingYears('2026-10-13', '2026-10-09', 345);
  const cy = A.calendarYears('2026-10-13', '2026-10-09', 345);
  assert.ok(Math.abs(ty - (30 + 2 * 375) / (252 * 375)) < 1e-12);
  assert.ok(Math.abs(cy - (4 * 24 + 0.5) / (365 * 24)) < 1e-12);
  assert.equal(A.calendarYears('2026-10-09', '2026-10-09', 375), 0);
  const c = new A.Chain({ spot: SPOT, T: ty, Tc: cy, ks: [SPOT], ce: [100], pe: [100], prev: () => null, next: () => null, rv: () => null, dayIv: () => null });
  assert.ok(Math.abs(c.df - Math.exp(-A.RATE * cy)) < 1e-15);
  // left out, the chain discounts over its own T (the synthetic test chains)
  assert.ok(Math.abs(chain().df - Math.exp(-A.RATE * T)) < 1e-15);
});

test('put-call parity by strike: where the forward can be bought and sold through each synthetic', () => {
  const c = withBook(chain(), { hs: 0.25 });
  const rows = c.parity(6);
  assert.equal(rows.length, 13);
  for (const r of rows) {
    // buying the forward crosses two half-spreads above its value, selling it two below
    assert.ok(Math.abs(r.buy - (c.F + 0.5 / c.df)) < 1e-6 && Math.abs(r.sell - (c.F - 0.5 / c.df)) < 1e-6);
  }
  // a put quoted 4 too high: through that strike the forward is bought 4 cheaper than the other strikes sell it
  const c2 = withBook(chain(), {
    hs: 0.25,
    edit: (x) => {
      const i = at(x.ks, 24100);
      x.peBid[i] += 4;
      x.peAsk[i] += 4;
    },
  });
  const p = c2.parity(6);
  const cheap = p.find((r) => r.k === 24100);
  const best = Math.max(...p.filter((r) => r.k !== 24100).map((r) => r.sell));
  assert.ok(best - cheap.buy > 2.9, 'the gap between selling elsewhere and buying here is the box edge');
  assert.ok(A.detect('box', c2).some((h) => h.strike === 24100 || h.ref === 24100));
  // a crossed or one-sided strike is left out
  const c3 = withBook(chain(), {
    edit: (x) => {
      x.ceBid[at(x.ks, 24000)] = 0;
    },
  });
  assert.ok(!c3.parity(6).some((r) => r.k === 24000));
});
