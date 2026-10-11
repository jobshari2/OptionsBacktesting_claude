// Detector tests on synthetic chains: a fair Black-76 chain (flat vol, consistent forward) must not fire the
// arbitrage / strike-structure detectors; the same chain with one price nudged must fire the right one, with
// the right strikes and direction, and its suggested trade must lock in a profit at expiry where it claims to.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../bt/anomalies');

const SPOT = 24000;
const W = 50;
const T = A.tradingYears('2026-10-08', '2026-10-05', 60); // ~3.8 sessions to expiry

// Fair chain: ATM ± 15 strikes at a flat vol; `edit(ce, pe, ks)` nudges prices before the Chain is built.
function chain({ vol = 0.13, skew = 0, t = T, edit } = {}) {
  const df = Math.exp(-A.RATE * t);
  const fwd = SPOT / df;
  const ks = Array.from({ length: 31 }, (_, i) => SPOT + (i - 15) * W);
  const v = (k) => vol - skew * Math.log(k / fwd) + 4 * skew * Math.log(k / fwd) ** 2; // put skew with a smile
  const ce = ks.map((k) => A.b76(fwd, k, t, v(k), true, df));
  const pe = ks.map((k) => A.b76(fwd, k, t, v(k), false, df));
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
  });
}
const at = (ks, k) => ks.indexOf(k);

// Resolve a suggestion against the chain (signal strikes relative to the hit / ref) and price each leg.
function resolve(c, h, given) {
  const sug = A.suggest(h, given);
  return sug.legs.map((l) => {
    const base = l.strike.ref === 'ref' && h.ref != null ? h.ref : h.strike;
    const strike = c.ks[c.idx.get(base) + l.strike.value];
    return { dir: l.action === 'B' ? 1 : -1, qty: l.lots, type: l.type, strike, px: c.px(strike, l.type) };
  });
}
const lockedIn = (c, h, given) => A.worstAtExpiry(resolve(c, h, given), c.spot);

const ARBS = ['varb', 'fly', 'bwfly', 'box', 'cal'];

test('the Arbitrage screen lists the arbitrages and the fair-value signal', () => {
  const cat = A.catalog();
  assert.deepEqual(
    cat.map((t) => t.id),
    [...ARBS, 'fv'],
  );
  for (const t of cat) {
    assert.equal(t.group, 'Arbitrage');
    // an arbitrage and a relative-value signal are never ranked together: every type says which it is
    assert.equal(t.cls, t.id === 'fv' ? 'rv' : 'arb');
    assert.ok(t.formula && t.assumes, `${t.id} documents its formula and assumptions`);
    for (const d of t.dirs) assert.ok(t.templates[d].CE.legs.length >= 2, `${t.id}/${d}`);
    // the quality gates are the same list on every type, marked so the page shows them once
    assert.deepEqual(
      t.params.filter((p) => p.q).map((p) => p.k),
      A.QUALITY.map((p) => p.k),
    );
  }
});

// Order book around fair prices: half-spread `hs`, `q` units on each side; `edit` adjusts the arrays.
function withBook(c, { hs = 0.5, q = 650, lot = 65, edit } = {}) {
  c.book = true;
  c.lot = lot;
  c.ceBid = c.ce.map((x) => Math.max(0, x - hs));
  c.ceAsk = c.ce.map((x) => x + hs);
  c.peBid = c.pe.map((x) => Math.max(0, x - hs));
  c.peAsk = c.pe.map((x) => x + hs);
  for (const k of ['ceBidQ', 'ceAskQ', 'peBidQ', 'peAskQ']) c[k] = c.ks.map(() => q);
  if (edit) edit(c);
  return c;
}
// A next-expiry chain (a week later) hung off `c`.
function withNext(c, nextEdit, surface = {}) {
  const n = chain({ ...surface, t: c.T + 5 / 252, edit: nextEdit });
  c.next = () => n;
  return n;
}

test('a fair chain fires none of the arbitrages', () => {
  const cases = { flat: {}, skewed: { skew: 1.2 }, steepSkew: { vol: 0.18, skew: 2.5 }, expiryDay: { t: 120 / (252 * 375) }, monthly: { t: 20 / 252 } };
  for (const [name, o] of Object.entries(cases)) {
    const c = chain(o);
    withNext(c, null, { vol: o.vol, skew: o.skew });
    for (const id of ARBS) assert.deepEqual(A.detect(id, c, { band: 15 }), [], `${id} on ${name}`);
    withBook(c);
    for (const id of ARBS) assert.deepEqual(A.detect(id, c, { band: 15 }), [], `${id} on ${name} with a book`);
  }
});

test('free credit: further-OTM call dearer than a nearer one', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24200)] = ce[at(ks, 24150)] + 3;
    },
  });
  const h = A.detect('varb', c).find((x) => x.strike === 24150 && x.ref === 24200 && x.side === 'CE');
  assert.ok(h);
  assert.equal(h.dir, 'free-credit');
  assert.ok(Math.abs(h.value - 3) < 1e-9);
  assert.deepEqual(
    resolve(c, h).map((l) => [l.dir, l.strike]),
    [
      [1, 24150],
      [-1, 24200],
    ],
  );
  assert.ok(lockedIn(c, h) >= 3 - 1e-9, 'buy the cheap call, sell the dear one: cannot lose');
});

test('free credit: further-OTM put dearer than a nearer one (non-adjacent pair too)', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      pe[at(ks, 23800)] = pe[at(ks, 23900)] + 2;
    },
  });
  const hs = A.detect('varb', c).filter((x) => x.side === 'PE' && x.dir === 'free-credit');
  const h = hs.find((x) => x.strike === 23800 && x.ref === 23900);
  assert.ok(h, JSON.stringify(hs));
  assert.deepEqual(
    resolve(c, h).map((l) => [l.dir, l.strike]),
    [
      [-1, 23800],
      [1, 23900],
    ],
  );
  assert.ok(lockedIn(c, h) > 1.99);
});

test('credit above width: put pair priced further apart than the strike gap', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      pe[at(ks, 23800)] -= 20;
      pe[at(ks, 23850)] += 40;
    },
  });
  const h = A.detect('varb', c).find((x) => x.strike === 23800 && x.ref === 23850 && x.side === 'PE');
  assert.ok(h);
  assert.equal(h.dir, 'over-width');
  assert.deepEqual(
    resolve(c, h).map((l) => [l.dir, l.strike]),
    [
      [1, 23800],
      [-1, 23850],
    ],
  );
  assert.ok(lockedIn(c, h) > 0);
});

test('credit above width: call pair', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24100)] += 60;
    },
  });
  const h = A.detect('varb', c).find((x) => x.strike === 24100 && x.ref === 24150 && x.side === 'CE');
  assert.ok(h);
  assert.equal(h.dir, 'over-width');
  assert.deepEqual(
    resolve(c, h).map((l) => [l.dir, l.strike]),
    [
      [-1, 24100],
      [1, 24150],
    ],
  );
  assert.ok(lockedIn(c, h) > 0);
});

test('nearest the money first, min edge and max gap are respected', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24400)] = ce[at(ks, 24350)] + 1;
      ce[at(ks, 24050)] = ce[at(ks, 24000)] + 4;
    },
  });
  const hs = A.detect('varb', c);
  assert.equal(hs[0].strike, 24000);
  assert.ok(hs.every((h, i) => i === 0 || h.dist >= hs[i - 1].dist));
  assert.ok(A.detect('varb', c, { minEdge: 2 }).every((h) => h.value >= 2));
  assert.ok(A.detect('varb', c, { maxGap: 1 }).every((h) => h.ref - h.strike === W));
});

test('order book: a last-price arbitrage that is not there at the bid / ask is ignored', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24200)] = ce[at(ks, 24150)] + 1;
    },
  });
  assert.ok(A.detect('varb', c).some((h) => h.strike === 24150 && h.ref === 24200));
  // quotes 1.5 wide around the last prices: buying 24150 at its ask costs more than 24200's bid pays
  withBook(c, { hs: 0.75 });
  assert.ok(!A.detect('varb', c).some((h) => h.strike === 24150 && h.ref === 24200));
});

test('order book: nobody to trade with on one leg means no arbitrage', () => {
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
  const ok = hit(mk());
  assert.ok(ok);
  assert.equal(ok.fit, 10, '650 units / 65 per lot');
  assert.match(ok.text, /10 lots fillable/);
  assert.equal(
    hit(
      mk((c) => {
        c.ceAskQ[at(c.ks, 24150)] = 0;
      }),
    ),
    undefined,
    'no sellers on the call we buy',
  );
  assert.equal(
    hit(
      mk((c) => {
        c.ceAsk[at(c.ks, 24150)] = 0;
      }),
    ),
    undefined,
    'no ask at all',
  );
  assert.equal(
    hit(
      mk((c) => {
        c.ceBidQ[at(c.ks, 24200)] = 40;
      }),
    ),
    undefined,
    'buyers for less than a lot',
  );
  const c3 = mk((c) => {
    c.ceBidQ[at(c.ks, 24200)] = 195;
  });
  assert.equal(hit(c3).fit, 3);
  assert.equal(hit(c3, { minLots: 5 }), undefined, 'fewer lots than required');
});

test('butterfly arbitrage: a fly that pays a credit; the book check counts the 2x body', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      pe[at(ks, 23900)] += 6;
    },
  });
  const h = A.detect('fly', c).find((x) => x.strike === 23900 && x.side === 'PE');
  assert.ok(h);
  assert.equal(h.dir, 'credit');
  assert.deepEqual(
    resolve(c, h).map((l) => [l.dir * l.qty, l.strike]),
    [
      [1, 23850],
      [-2, 23900],
      [1, 23950],
    ],
  );
  assert.ok(A.worstAtExpiry(resolve(c, h), SPOT) >= h.value - 1e-9);
  // 2 lots of buyers at the body: one fly sells 2 → 1 fillable; 100 units is not enough for one
  withBook(c, {
    hs: 0.1,
    edit: (x) => {
      x.peBidQ[at(x.ks, 23900)] = 130;
    },
  });
  assert.equal(A.detect('fly', c).find((x) => x.strike === 23900 && x.side === 'PE').fit, 1);
  c.peBidQ[at(c.ks, 23900)] = 100;
  assert.equal(
    A.detect('fly', c).find((x) => x.strike === 23900 && x.side === 'PE'),
    undefined,
  );
  // wider wings
  const c2 = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24100)] += 20;
    },
  });
  const h2 = A.detect('fly', c2, { wing: 2 }).find((x) => x.strike === 24100 && x.side === 'CE');
  assert.deepEqual(
    resolve(c2, h2, { wing: 2 }).map((l) => l.strike),
    [24000, 24100, 24200],
  );
  assert.ok(A.worstAtExpiry(resolve(c2, h2, { wing: 2 }), SPOT) > 0);
});

test('box spread arbitrage: cheap and rich boxes lock in the gap', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      pe[at(ks, 24100)] -= 6;
    },
  });
  const hs = A.detect('box', c);
  assert.ok(hs.length);
  for (const h of hs.slice(0, 4)) {
    assert.ok(h.strike === 24100 || h.ref === 24100, JSON.stringify(h));
    assert.equal(h.dir, h.ref === 24100 ? 'cheap' : 'rich');
    assert.ok(Math.abs(h.value - 6) < 1e-6);
    // the edge is today's value; at expiry a box pays the undiscounted gap, so a sold one keeps a bit less
    const w = h.ref - h.strike;
    assert.ok(A.worstAtExpiry(resolve(c, h), SPOT) > 6 - w * (1 - c.df) - 1e-6);
  }
  // a sold box is tested against its full width (the credit earns no interest), so its edge is what it locks in
  const rich = hs.find((h) => h.dir === 'rich' && h.strike === 24100 && h.ref === 24150);
  assert.ok(Math.abs(rich.value - (6 - 50 * (1 - c.df))) < 1e-6, String(rich.value));
  assert.ok(Math.abs(A.worstAtExpiry(resolve(c, rich), SPOT) - rich.value) < 1e-6);
  assert.ok(Math.abs(rich.locked - rich.value) < 1e-9);
  const cheap = hs.find((h) => h.dir === 'cheap');
  assert.ok(Math.abs(cheap.locked - (cheap.value + (cheap.ref - cheap.strike) * (1 - c.df))) < 1e-9, 'a bought box locks in the undiscounted width');
  assert.deepEqual(A.detect('box', c, { minEdge: 7 }), []);
  assert.ok(A.detect('box', c, { maxGap: 1 }).every((h) => h.ref - h.strike === W));
  // at the bid / ask (4 legs x 0.5 half-spread) the 6-pt edge shrinks to 4
  withBook(c);
  const hb = A.detect('box', c).find((h) => h.strike === 24050 && h.ref === 24100);
  assert.ok(Math.abs(hb.value - 4) < 1e-6);
});

test('calendar arbitrage: next-expiry call cheaper than the near one', () => {
  const c = chain();
  const nxt = withNext(c, (ce, pe, ks) => {
    ce[at(ks, 24050)] = c.px(24050, 'CE') - 2;
  });
  const hs = A.detect('cal', c);
  assert.equal(hs.length, 1, JSON.stringify(hs));
  const h = hs[0];
  assert.equal(h.strike, 24050);
  assert.ok(Math.abs(h.value - 2) < 1e-9);
  assert.deepEqual(
    A.suggest(h).legs.map((l) => [l.action, l.type, l.expiry]),
    [
      ['S', 'CE', 'cur'],
      ['B', 'CE', 'next'],
    ],
  );
  // the next expiry's book must have sellers too
  withBook(c, { hs: 0.1 });
  withBook(nxt, { hs: 0.1 });
  assert.equal(A.detect('cal', c).length, 1);
  nxt.ceAskQ[at(nxt.ks, 24050)] = 0;
  assert.deepEqual(A.detect('cal', c), []);
  c.next = () => null;
  assert.deepEqual(A.detect('cal', c), []);
});

test('stale prints are skipped when "Traded within" is set', () => {
  const c = chain({
    edit: (ce, pe, ks) => {
      ce[at(ks, 24200)] = ce[at(ks, 24150)] + 3;
    },
  });
  c.ageCe = c.ks.map((k) => (k === 24200 ? 5 : 0));
  c.agePe = c.ks.map(() => 0);
  assert.ok(!A.detect('varb', c).some((h) => h.ref === 24200 || h.strike === 24200));
  assert.ok(A.detect('varb', c, { fresh: 10 }).some((h) => h.ref === 24200));
});

test('a strategy condition on a removed anomaly type never fires', () => {
  const { normCondition, evaluate } = require('../bt/conditions');
  const cond = normCondition({ kind: 'anomaly', type: 'parity' });
  assert.ok(cond);
  assert.equal(evaluate([cond], { spot: SPOT, ctx: () => chain() }).ok, false);
});

test('fair value: a fair chain has no deviations, with or without a book', () => {
  for (const [name, o] of Object.entries({ flat: {}, skewed: { skew: 1.2 }, steepSkew: { vol: 0.18, skew: 2.5 }, monthly: { t: 20 / 252 } })) {
    const c = chain(o);
    assert.deepEqual(A.detect('fv', c, { band: 12 }), [], name);
    assert.deepEqual(A.detect('fv', withBook(chain(o)), { band: 12 }), [], name + ' with a book');
  }
});

test('fair value: an overpriced call is rich, an underpriced put is cheap', () => {
  const c = chain({
    skew: 1.2,
    edit: (ce, pe, ks) => {
      ce[at(ks, 24200)] += 6;
      pe[at(ks, 23800)] -= 5;
    },
  });
  const hs = A.detect('fv', c);
  const rich = hs.find((h) => h.strike === 24200 && h.side === 'CE');
  const cheap = hs.find((h) => h.strike === 23800 && h.side === 'PE');
  assert.ok(rich && cheap, JSON.stringify(hs.map((h) => [h.strike, h.side, h.dir, h.value])));
  assert.equal(rich.dir, 'rich');
  assert.equal(cheap.dir, 'cheap');
  assert.ok(Math.abs(rich.value - 6) < 0.3, 'fair value is read from the neighbours, not the nudged strike: ' + rich.value);
  assert.ok(Math.abs(cheap.value - 5) < 0.3, String(cheap.value));
  assert.ok(Math.abs(rich.mkt - rich.fair - rich.value) < 0.02);
  assert.ok(rich.ivMkt > rich.ivFair && cheap.ivMkt < cheap.ivFair);
  assert.ok(
    hs.every((h, i) => i === 0 || h.value <= hs[i - 1].value),
    'biggest deviation first',
  );
  // the trade: sell the rich call and buy the next one out; buy the cheap put and sell the next one out
  assert.deepEqual(
    resolve(c, rich).map((l) => [l.dir, l.strike]),
    [
      [-1, 24200],
      [1, 24250],
    ],
  );
  assert.deepEqual(
    resolve(c, cheap).map((l) => [l.dir, l.strike]),
    [
      [1, 23800],
      [-1, 23750],
    ],
  );
});

test('fair value: thresholds and the bid / ask are respected', () => {
  const mk = () =>
    chain({
      edit: (ce, pe, ks) => {
        ce[at(ks, 24200)] += 6;
      },
    });
  assert.ok(!A.detect('fv', mk(), { minEdge: 8 }).some((h) => h.strike === 24200 && h.side === 'CE'));
  assert.ok(!A.detect('fv', mk(), { minPct: 60 }).some((h) => h.strike === 24200 && h.side === 'CE'));
  // a book quoted 1 wide around the nudged price: sold at the bid, so the edge is 0.5 less
  const h = A.detect('fv', withBook(mk())).find((x) => x.strike === 24200 && x.side === 'CE');
  assert.ok(h && h.dir === 'rich' && Math.abs(h.value - 5.5) < 0.3, JSON.stringify(h));
  // a book so wide that the bid is below fair value: nothing to sell into
  assert.ok(!A.detect('fv', withBook(mk(), { hs: 7 })).some((x) => x.strike === 24200 && x.side === 'CE'));
});
