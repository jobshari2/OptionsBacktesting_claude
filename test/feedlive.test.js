// Live orders on Kite following the gap paper trades (feedlive.js), against a fake Kite: nothing is sent anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveTrader, cleanLive, summarizeLive } = require('../feedlive');

const T0 = Date.parse('2026-10-14T10:50:00+05:30');
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// A fake Kite: orders fill at once at `fill(order)` unless `status(order)` says otherwise. Positions and the order
// book follow from the orders, including `external` ones (placed in Kite by hand).
function fakeKite({ fill = () => 100, status = () => 'COMPLETE' } = {}) {
  const sent = [];
  const external = [];
  const filled = (o) => (o.status === 'COMPLETE' ? o.quantity : 0);
  return {
    sent,
    external,
    async placeOrder(auth, p) {
      const o = { id: 'O' + (sent.length + 1), ...p, status: status(p, sent.length), avg: fill(p) };
      sent.push(o);
      return o.id;
    },
    async orderStatus(auth, id) {
      const o = sent.find((x) => x.id === id);
      return { status: o.status, average_price: o.status === 'COMPLETE' ? o.avg : 0, filled_quantity: filled(o), status_message: o.msg || null };
    },
    async cancelOrder(auth, id) {
      sent.find((x) => x.id === id).status = 'CANCELLED';
    },
    funds: async () => ({ net: 50_000, available: { cash: 40_000 }, utilised: { debits: 1000 } }),
    orderMargins: async (auth, list) => list.map(() => ({ total: 120_000 })),
    async orders() {
      return [...sent, ...external].map((o) => ({
        order_id: o.id,
        tradingsymbol: o.tradingsymbol,
        transaction_type: o.transaction_type,
        product: o.product,
        status: o.status,
        average_price: o.avg,
        filled_quantity: filled(o),
        order_timestamp: o.ts || '2026-10-14 10:50:00',
      }));
    },
    async positions() {
      const net = new Map();
      for (const o of [...sent, ...external]) {
        const k = o.tradingsymbol + '|' + o.product;
        net.set(k, (net.get(k) || 0) + filled(o) * (o.transaction_type === 'BUY' ? 1 : -1));
      }
      return [...net].map(([k, quantity]) => {
        const [tradingsymbol, product] = k.split('|');
        return { tradingsymbol, product, quantity, exchange: 'NFO', average_price: 0, last_price: 0, pnl: 0 };
      });
    },
  };
}

function setup({ api = fakeKite(), auth = { mode: 'connect', userId: 'AB1234' }, config = {}, ...over } = {}) {
  const cfg = cleanLive(config);
  const changes = [];
  const ctx = { auth, at: T0 };
  const live = createLiveTrader({
    getConfig: () => cfg,
    getAuth: () => ctx.auth,
    getSymbol: (id) => `NIFTY26O19${id}`,
    getTestSymbol: (type) => ({ id: `22700${type}`, symbol: `NIFTY26O1922700${type}` }),
    getLot: () => 65,
    isMarketOpen: () => true,
    onChange: (t) => changes.push(t.live?.state),
    api,
    now: () => ctx.at,
    pollMs: 0,
    ...over,
  });
  return { live, api, ctx, changes };
}
const trade = (id = '22700CE', side = 'BUY', entryFeed = 'k') => ({ id: 'T-' + id, i: id, side, at: T0, entry: 100, entryFeed });

test('off by default: a paper trade sends nothing', async () => {
  const { live, api } = setup();
  const t = trade();
  live.onOpen(t);
  await wait();
  assert.equal(api.sent.length, 0);
  assert.equal(t.live, undefined);
  assert.equal(live.state().on, false);
});

test('on: entry and exit are MARKET orders of 1 lot, and the P&L comes from the real fills', async () => {
  const api = fakeKite({ fill: (p) => (p.transaction_type === 'BUY' ? 100.5 : 103.75) });
  const { live } = setup({ api });
  live.setOn(true);
  const t = trade();
  live.onOpen(t);
  await wait();
  assert.equal(api.sent.length, 1);
  assert.deepEqual(
    {
      s: api.sent[0].tradingsymbol,
      side: api.sent[0].transaction_type,
      q: api.sent[0].quantity,
      type: api.sent[0].order_type,
      prod: api.sent[0].product,
    },
    { s: 'NIFTY26O1922700CE', side: 'BUY', q: 65, type: 'MARKET', prod: 'MIS' },
  );
  assert.equal(t.live.state, 'open');
  assert.equal(t.live.entry.avg, 100.5);
  live.onClose(t, 'target');
  await wait();
  assert.equal(api.sent[1].transaction_type, 'SELL');
  assert.equal(api.sent[1].quantity, 65);
  assert.equal(t.live.state, 'closed');
  assert.equal(t.live.pnl, 3.25);
  assert.equal(t.live.gross, 211.25);
  assert.ok(t.live.costs > 0 && t.live.net < t.live.gross);
  const s = summarizeLive([t]);
  assert.equal(s.closed, 1);
  assert.equal(s.net, t.live.net);
});

test('a SELL trade sells to open and buys to close', async () => {
  const { live, api } = setup({ config: { lots: 2, product: 'NRML' } });
  live.setOn(true);
  const t = trade('22950PE', 'SELL');
  live.onOpen(t);
  await wait();
  live.onClose(t, 'time');
  await wait();
  assert.deepEqual(
    api.sent.map((o) => [o.transaction_type, o.quantity, o.product]),
    [
      ['SELL', 130, 'NRML'],
      ['BUY', 130, 'NRML'],
    ],
  );
});

test('limits: open positions, entries a day, entry hours', async () => {
  const { live, api, ctx } = setup({ config: { maxOpen: 1, maxEntries: 2 } });
  live.setOn(true);
  const a = trade('A');
  live.onOpen(a);
  await wait();
  const b = trade('B');
  live.onOpen(b);
  assert.equal(b.live.state, 'skipped');
  assert.match(b.live.why, /already open/);
  live.onClose(a, 'target');
  await wait();
  const c = trade('C');
  live.onOpen(c);
  await wait();
  live.onClose(c, 'target');
  await wait();
  const d = trade('D');
  live.onOpen(d);
  assert.match(d.live.why, /daily limit of 2/);
  ctx.at = Date.parse('2026-10-15T15:12:00+05:30'); // next day, after 15:10
  live.tick();
  const e = trade('E');
  live.onOpen(e);
  assert.match(e.live.why, /entry hours/);
  assert.equal(api.sent.length, 4);
});

test('a paper trade closing while the entry is still working is closed once the entry fills', async () => {
  const api = fakeKite({ status: (p, n) => (n === 0 ? 'OPEN' : 'COMPLETE') });
  const { live } = setup({ api });
  live.setOn(true);
  const t = trade();
  live.onOpen(t);
  await wait(800); // its 20 status checks are over (timers are coarse on Windows)
  assert.equal(t.live.state, 'entering');
  live.onClose(t, 'target');
  assert.equal(api.sent.length, 1, 'no exit before the entry has filled');
  api.sent[0].status = 'COMPLETE';
  live.tick(); // too soon to ask again (10 s)
  await wait();
  assert.equal(t.live.state, 'entering');
  t.live.entry.at -= 11_000;
  live.tick();
  await wait();
  assert.equal(t.live.state, 'closed');
  assert.equal(api.sent[1].transaction_type, 'SELL');
});

test('a rejected entry and a failed exit; square off closes what is left', async () => {
  const api = fakeKite({ status: (p, n) => (n === 0 ? 'REJECTED' : n === 2 ? 'REJECTED' : 'COMPLETE') });
  const { live } = setup({ api, config: { maxOpen: 5 } });
  live.setOn(true);
  const a = trade('A');
  live.onOpen(a);
  await wait();
  assert.equal(a.live.state, 'failed');
  const b = trade('B');
  live.onOpen(b);
  await wait();
  live.onClose(b, 'target');
  await wait();
  assert.equal(b.live.state, 'exit-failed');
  assert.match(live.state().events[0].msg, /still open on Kite/);
  assert.equal(live.squareOff(), 1);
  await wait();
  assert.equal(b.live.state, 'closed');
  assert.equal(api.sent[3].quantity, 65);
});

test('switching on needs a Kite Connect login; a login change switches it off', async () => {
  const { live, ctx } = setup({ auth: { mode: 'enctoken', userId: 'AB1234' } });
  assert.throws(() => live.setOn(true), /Kite Connect/);
  const ok = setup({ auth: { mode: 'enctoken', userId: 'AB1234' }, allowEnctoken: true });
  ok.live.setOn(true);
  assert.equal(ok.live.state().on, true);
  ctx.auth = null;
  assert.throws(() => live.setOn(true), /Not logged in/);
  ok.ctx.auth = { mode: 'connect', userId: 'ZZ9999' };
  ok.live.tick();
  assert.equal(ok.live.state().on, false);
});

test('15:15 closes open live positions', async () => {
  const { live, api, ctx } = setup();
  live.setOn(true);
  const t = trade();
  live.onOpen(t);
  await wait();
  ctx.at = Date.parse('2026-10-14T15:15:01+05:30');
  live.tick();
  await wait();
  assert.equal(t.live.state, 'closed');
  assert.equal(t.live.exitReason, 'eod');
  assert.equal(api.sent.length, 2);
});

test('the check-only test order is a 1-lot LIMIT BUY at ₹0.05, cancelled if it rests', async () => {
  const api = fakeKite({ status: () => 'OPEN' });
  const { live } = setup({ api });
  const r = await live.testOrder('check');
  assert.equal(r.ok, true);
  assert.deepEqual(
    { type: api.sent[0].order_type, price: api.sent[0].price, q: api.sent[0].quantity, side: api.sent[0].transaction_type },
    { type: 'LIMIT', price: 0.05, q: 65, side: 'BUY' },
  );
  assert.equal(r.cancelled, true);
  assert.equal(r.status, 'CANCELLED');
  const rej = setup({ api: fakeKite({ status: () => 'REJECTED' }) });
  const r2 = await rej.live.testOrder('check');
  assert.equal(r2.ok, true, 'a rejection still shows the order reached Kite');
  assert.equal(r2.cancelled, undefined);
});

test('after a restart, a position left open is flagged and counts towards the day', () => {
  const { live } = setup({ config: { maxEntries: 1 } });
  const old = { ...trade(), live: { state: 'open', symbol: 'X', entry: { filled: 65 } } };
  live.seed([old]);
  assert.equal(old.live.state, 'unknown');
  assert.match(live.state().events[0].msg, /Check it in Kite/);
  live.setOn(true);
  const t = trade('B');
  live.onOpen(t);
  assert.match(t.live.why, /daily limit/);
});

test('Kite trades only (the default) skips trades where Upstox moved first; off, it sends them too', async () => {
  const { live, api } = setup({ config: { maxOpen: 5 } });
  live.setOn(true);
  const u = trade('U', 'BUY', 'u');
  live.onOpen(u);
  assert.equal(u.live.state, 'skipped');
  assert.match(u.live.why, /Upstox moved first/);
  const k = trade('K', 'BUY', 'k');
  live.onOpen(k);
  await wait();
  assert.equal(api.sent.length, 1);
  assert.equal(live.state().entries, 1, 'a skipped trade does not use up an entry');

  const all = setup({ config: { kiteOnly: false } });
  all.live.setOn(true);
  const u2 = trade('U', 'BUY', 'u');
  all.live.onOpen(u2);
  await wait();
  assert.equal(all.api.sent.length, 1);
  assert.equal(cleanLive({}).kiteOnly, true);
});

test('the test button buys 1 lot of the ATM option at market, tracked until Square off', async () => {
  const api = fakeKite({ fill: (p) => (p.transaction_type === 'BUY' ? 120 : 121) });
  const { live, changes } = setup({ api, config: { lots: 3 } });
  const r = await live.testOrder('PE');
  assert.equal(r.ok, true);
  assert.deepEqual(
    { s: api.sent[0].tradingsymbol, side: api.sent[0].transaction_type, type: api.sent[0].order_type, q: api.sent[0].quantity },
    { s: 'NIFTY26O1922700PE', side: 'BUY', type: 'MARKET', q: 65 },
    'one lot, whatever the live lots setting',
  );
  assert.equal(r.avg, 120);
  assert.equal(live.state().on, false, 'works without switching live trading on');
  assert.equal(live.state().tests[0].state, 'open');
  assert.equal(live.state().open, 0, 'a test buy does not block gap trades');
  assert.equal(changes.length, 0, 'nothing saved as a paper trade');
  assert.equal(live.squareOff(), 1);
  await wait();
  assert.equal(api.sent[1].transaction_type, 'SELL');
  const t = live.state().tests[0];
  assert.equal(t.state, 'closed');
  assert.equal(t.pnl, 1);
});

test('Close sends the opposite order for that one position', async () => {
  const api = fakeKite({ fill: (p) => (p.transaction_type === 'BUY' ? 100 : 102) });
  const { live, ctx } = setup({ api, config: { maxOpen: 5 } });
  live.setOn(true);
  const a = trade('A');
  const b = trade('B');
  live.onOpen(a);
  live.onOpen(b);
  await wait();
  ctx.at += 10_000;
  assert.equal(live.closeOne(a.id), true);
  await wait();
  assert.equal(a.live.state, 'closed');
  assert.equal(a.live.exitReason, 'manual');
  assert.equal(b.live.state, 'open');
  assert.equal(api.sent.length, 3);
  assert.equal(live.closeOne(a.id), false, 'already closed');
});

test('a position closed in Kite is noticed, priced from Kite, and no exit is sent for it', async () => {
  const api = fakeKite({ fill: () => 100 });
  const { live, ctx } = setup({ api });
  live.setOn(true);
  const t = trade('22700CE');
  live.onOpen(t);
  await wait();
  ctx.at += 10_000;
  live.tick(); // Kite still holds it
  await wait();
  assert.equal(t.live.state, 'open');
  api.external.push({
    id: 'K1',
    tradingsymbol: t.live.symbol,
    product: 'MIS',
    transaction_type: 'SELL',
    quantity: 65,
    status: 'COMPLETE',
    avg: 104,
    ts: '2026-10-14 10:50:08',
  });
  ctx.at += 6000;
  live.tick(); // first sighting: wait for a second read
  await wait();
  assert.equal(t.live.state, 'open');
  ctx.at += 6000;
  live.tick();
  await wait();
  assert.equal(t.live.state, 'closed');
  assert.equal(t.live.closedInKite, 65);
  assert.equal(t.live.exitAvg, 104);
  assert.equal(t.live.pnl, 4);
  live.onClose(t, 'target');
  await wait();
  assert.equal(api.sent.length, 1, 'no exit order from the app');
});

test('just before an exit, Kite is checked: closed there means no order', async () => {
  const api = fakeKite();
  const { live, ctx } = setup({ api });
  live.setOn(true);
  const t = trade();
  live.onOpen(t);
  await wait();
  api.external.push({ id: 'K1', tradingsymbol: t.live.symbol, product: 'MIS', transaction_type: 'SELL', quantity: 65, status: 'COMPLETE', avg: 98 });
  ctx.at += 10_000;
  live.onClose(t, 'stop');
  await wait();
  assert.equal(t.live.state, 'closed');
  assert.equal(t.live.exitAvg, 98);
  assert.equal(api.sent.length, 1);
});

test('open positions are marked to market for the live P&L', async () => {
  const api = fakeKite({ fill: () => 100.5 });
  const { live } = setup({ api, getQuote: () => ({ ltp: 103.2, bid: 103, ask: 103.5 }) });
  live.setOn(true);
  const t = trade();
  live.onOpen(t);
  await wait();
  live.tick();
  assert.equal(t.live.mark, 103);
  assert.equal(t.live.upnl, 162.5);
  assert.equal(live.state().openPnl, 162.5);
  const s = summarizeLive([t]);
  assert.equal(s.open, 1);
  assert.equal(s.openPnl, 162.5);
});

test('size by budget: lots = what 90% of the Kite funds buys at the ask, capped at max lots; too little = skipped', async () => {
  const quote = { ltp: 99.5, bid: 99.4, ask: 100 };
  const { live, api } = setup({ config: { budget: true, maxOpen: 5 }, getQuote: () => quote });
  live.setOn(true);
  const t = trade('A');
  live.onOpen(t);
  assert.equal(t.live.sizing, true);
  await wait();
  // ₹50,000 × 90% = ₹45,000; a lot costs 100 × 65 = ₹6,500 → 6 lots
  assert.equal(api.sent[0].quantity, 390);
  assert.equal(t.live.lots, 6);
  assert.deepEqual(t.live.budget, { available: 50_000, pct: 90, perLot: 6500, lots: 6 });
  assert.equal(live.state().funds.available, 50_000);
  assert.equal(live.state().afford[0].lots, 6);

  const capped = setup({ config: { budget: true, maxLots: 2 }, getQuote: () => ({ ask: 10 }) });
  capped.live.setOn(true);
  const c = trade('C');
  capped.live.onOpen(c);
  await wait();
  assert.equal(capped.api.sent[0].quantity, 130, 'max lots');

  // a SELL needs Kite's margin (₹1.2 L a lot): ₹45,000 buys none
  const s = setup({ config: { budget: true } });
  s.live.setOn(true);
  const sell = trade('S', 'SELL');
  s.live.onOpen(sell);
  await wait();
  assert.equal(s.api.sent.length, 0);
  assert.equal(sell.live.state, 'skipped');
  assert.match(sell.live.why, /doesn't cover one lot/);
  assert.equal(s.live.state().entries, 0, 'a skipped entry is given back');
  assert.equal(s.live.state().open, 0);
});
