// Live Ideas' orders (kitebasket.js) against a fake Kite API: nothing here can reach Kite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKiteBasket, tickUp, tickDown, MAX_QTY } = require('../kitebasket');

const LEGS = [
  { action: 'B', type: 'CE', strike: 24800, expiry: '2026-10-20', lots: 1, price: 100.02 },
  { action: 'S', type: 'CE', strike: 24900, expiry: '2026-10-20', lots: 2, price: 60.01 },
  { action: 'B', type: 'CE', strike: 25000, expiry: '2026-10-20', lots: 1, price: 30 },
];

// A fake Kite: records every call; `fill(order)` decides how an order ends ('COMPLETE' | 'OPEN' | 'REJECTED' | 'PARTIAL').
function fake(fill = () => 'COMPLETE') {
  const calls = [];
  const orders = new Map();
  let n = 0;
  const api = {
    async placeOrder(auth, p) {
      const id = `O${++n}`;
      calls.push({ call: 'place', ...p, id });
      orders.set(id, { p, state: fill(p) });
      return id;
    },
    async orderStatus(auth, id) {
      const { p, state } = orders.get(id);
      calls.push({ call: 'status', id });
      if (state === 'COMPLETE') return { status: 'COMPLETE', filled_quantity: p.quantity, average_price: Number(p.price) };
      if (state === 'PARTIAL') return { status: 'OPEN', filled_quantity: Math.floor(p.quantity / 2) };
      if (state === 'REJECTED') return { status: 'REJECTED', status_message: 'Insufficient funds' };
      if (state === 'CANCELLED') return { status: 'CANCELLED', filled_quantity: 0 };
      return { status: 'OPEN', filled_quantity: 0 };
    },
    async cancelOrder(auth, id) {
      calls.push({ call: 'cancel', id });
      const o = orders.get(id);
      if (o.state === 'OPEN') o.state = 'CANCELLED';
    },
    async funds() {
      return { net: 123456 };
    },
  };
  return { api, calls };
}

function make(over = {}, f = fake()) {
  const b = createKiteBasket({
    getAuth: () => ({ mode: 'connect', apiKey: 'k', accessToken: 't', userId: 'AB1234' }),
    symbolFor: async (e, k, t) => `NIFTY${e.replace(/-/g, '')}${k}${t}`,
    getLot: () => 65,
    isMarketOpen: () => true,
    now: () => Date.parse('2026-10-20T05:00:00Z'), // 10:30 IST
    api: f.api,
    pollMs: 1,
    waitMs: 5,
    ...over,
  });
  return { b, f };
}
const req = (extra = {}) => ({ legs: LEGS, product: 'NRML', buffer: 0.5, confirmed: true, ...extra });

test('limit prices are rounded to the tick, moved in favour of the fill', () => {
  assert.equal(tickUp(100.52), 100.55);
  assert.equal(tickUp(100.55), 100.55);
  assert.equal(tickDown(59.51), 59.5);
  assert.equal(tickDown(0.01), 0.05);
});

test('the BUY legs are filled before any SELL leg is sent', async () => {
  const { b, f } = make();
  const r = await b.place(req());
  assert.equal(r.status, 'done');
  assert.ok(r.ok);
  const placed = f.calls.filter((c) => c.call === 'place');
  assert.deepEqual(
    placed.map((c) => c.transaction_type),
    ['BUY', 'BUY', 'SELL'],
  );
  // quantities are lots × the lot size; the SELL is two lots
  assert.deepEqual(
    placed.map((c) => c.quantity),
    [65, 65, 130],
  );
  assert.ok(placed.every((c) => c.order_type === 'LIMIT' && c.product === 'NRML' && c.tag === 'ideas'));
  assert.equal(placed[0].price, 100.55); // 100.02 + 0.5, up to the tick
  assert.equal(placed[2].price, 59.5); // 60.01 − 0.5, down to the tick
  assert.equal(placed[0].tradingsymbol, 'NIFTY2026102024800CE');
  // the SELL order was placed after both BUYs had been checked as filled
  const sellAt = f.calls.findIndex((c) => c.call === 'place' && c.transaction_type === 'SELL');
  assert.ok(f.calls.slice(0, sellAt).filter((c) => c.call === 'status').length >= 2);
});

test('a BUY leg that does not fill is cancelled and nothing is sold', async () => {
  const { b, f } = make(
    {},
    fake((p) => (p.tradingsymbol.includes('25000') ? 'OPEN' : 'COMPLETE')),
  );
  const r = await b.place(req());
  assert.equal(r.status, 'stopped');
  assert.ok(!f.calls.some((c) => c.call === 'place' && c.transaction_type === 'SELL'), 'no SELL was sent');
  assert.ok(
    f.calls.some((c) => c.call === 'cancel'),
    'the unfilled BUY was cancelled',
  );
  assert.equal(r.legs.find((l) => l.action === 'SELL').status, 'NOT SENT');
});

test('a rejected BUY stops the basket', async () => {
  const { b, f } = make(
    {},
    fake(() => 'REJECTED'),
  );
  const r = await b.place(req());
  assert.equal(r.status, 'stopped');
  assert.ok(!f.calls.some((c) => c.call === 'place' && c.transaction_type === 'SELL'));
  assert.match(r.legs[0].msg, /Insufficient funds/);
});

test('a SELL that does not fill is cancelled and the basket is reported partial', async () => {
  const { b, f } = make(
    {},
    fake((p) => (p.transaction_type === 'SELL' ? 'OPEN' : 'COMPLETE')),
  );
  const r = await b.place(req());
  assert.equal(r.status, 'partial');
  assert.ok(f.calls.some((c) => c.call === 'cancel'));
  assert.match(r.message, /open in Kite/);
});

test('it refuses what it should', async () => {
  // not confirmed
  await assert.rejects(make().b.place(req({ confirmed: false })), /not confirmed/);
  // not logged in
  await assert.rejects(make({ getAuth: () => null }).b.place(req()), /Not logged in/);
  // enctoken sessions need the explicit switch
  const enc = () => ({ mode: 'enctoken', enctoken: 'x', userId: 'AB1234' });
  await assert.rejects(make({ getAuth: enc }).b.place(req()), /KITE_ORDERS_ENCTOKEN=1/);
  const okEnc = make({ getAuth: enc, allowEnctoken: true });
  assert.equal((await okEnc.b.place(req())).status, 'done');
  // market closed, and after 15:25
  await assert.rejects(make({ isMarketOpen: () => false }).b.place(req()), /closed/);
  await assert.rejects(make({ now: () => Date.parse('2026-10-20T09:56:00Z') }).b.place(req()), /after 15:25/); // 15:26 IST
  // a basket with only SELL legs is an uncovered short
  await assert.rejects(make().b.place(req({ legs: [LEGS[1]] })), /no BUY leg/);
  // above the freeze quantity, unknown instrument, incomplete leg, too many legs
  await assert.rejects(make().b.place(req({ legs: [{ ...LEGS[0], lots: Math.ceil(MAX_QTY / 65) + 1 }, LEGS[1]] })), /freeze quantity/);
  await assert.rejects(make({ symbolFor: async () => null }).b.place(req()), /No Kite instrument/);
  await assert.rejects(make().b.place(req({ legs: [{ ...LEGS[0], price: 0 }] })), /incomplete/);
  await assert.rejects(make().b.place(req({ legs: Array(9).fill(LEGS[0]) })), /1 to 8 legs/);
});

test('nothing is placed when a request is refused, and the same basket is not sent twice', async () => {
  const { b, f } = make();
  await assert.rejects(b.place(req({ confirmed: undefined })));
  assert.equal(f.calls.length, 0);
  assert.equal((await b.place(req())).status, 'done');
  const n = f.calls.length;
  await assert.rejects(b.place(req()), /just sent/);
  assert.equal(f.calls.length, n);
});

test('the preview sends nothing and says why orders cannot go out yet', async () => {
  const { b, f } = make({ isMarketOpen: () => false });
  const p = await b.preview(req());
  assert.equal(f.calls.filter((c) => c.call === 'place').length, 0);
  assert.match(p.gate, /closed/);
  assert.equal(p.legs[1].qty, 130);
  assert.equal(p.funds.available, 123456);
});

test('demo mode simulates the fills and sends nothing, even with a real login saved', async () => {
  const { b, f } = make({ demo: true, symbolFor: async () => null }); // make() has a Kite Connect login
  const r = await b.place(req());
  assert.equal(r.status, 'done');
  assert.ok(r.demo);
  assert.equal(f.calls.length, 0);
  assert.match(r.legs[0].id, /^DEMO-/);
});

test('MARKET orders are sent only when asked for: no price, the BUYs still go first', async () => {
  const { b, f } = make({ marketProtection: '-1' });
  const r = await b.place(req({ orderType: 'MARKET' }));
  assert.equal(r.status, 'done');
  assert.equal(r.orderType, 'MARKET');
  const placed = f.calls.filter((c) => c.call === 'place');
  assert.ok(placed.every((c) => c.order_type === 'MARKET' && c.price == null && c.market_protection === '-1'));
  assert.deepEqual(
    placed.map((c) => c.transaction_type),
    ['BUY', 'BUY', 'SELL'],
  );
  // and a request that does not say MARKET (or says something else) is a LIMIT basket
  const lim = make();
  await lim.b.place(req({ orderType: 'whatever' }));
  assert.ok(lim.f.calls.filter((c) => c.call === 'place').every((c) => c.order_type === 'LIMIT' && c.price > 0 && c.market_protection == null));
});

test('the preview asks Kite for the basket margin and gives it per lot of the strategy', async () => {
  const f = fake();
  const asked = [];
  f.api.basketMargin = async (auth, list) => {
    asked.push(list);
    return { initial: { total: 99999 }, final: { total: 90000 } };
  };
  const { b } = make({}, f);
  const p = await b.preview(req({ strategyLots: 3 }));
  assert.equal(p.margin.total, 90000);
  assert.equal(p.margin.perLot, 30000);
  assert.equal(p.margin.source, 'Kite');
  assert.equal(asked[0].length, 3);
  assert.ok(asked[0].every((o) => o.order_type === 'LIMIT' && o.quantity > 0 && o.product === 'NRML'));
  // a margin call that fails does not break the preview
  f.api.basketMargin = async () => {
    throw new Error('Kite is down');
  };
  const q = await b.preview(req({ strategyLots: 3 }));
  assert.match(q.margin.error, /Kite is down/);
  assert.equal(q.legs.length, 3);
});
