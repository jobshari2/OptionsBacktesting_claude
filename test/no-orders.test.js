// The app reads market data from Upstox and never places, modifies or cancels an order there. This test fails if a
// call to one of Upstox's order endpoints (or a write to the Upstox API) is ever added.
// The exception is Zerodha Kite, through lib/kite.js, from two places only: the Feeds screen's live trading
// (feedlive.js), switched on by hand, and the Live Ideas screen's "Trade with Zerodha Kite" (kitebasket.js), which
// sends a basket only after the confirmation dialog on the screen. The last tests keep Kite orders to those files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'test', 'bt-cache', 'bt-data', 'events', 'events-demo', 'hedge-cache', 'logs', 'replays', '.git', '.claude']);
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no order placement anywhere in the app', () => {
  const files = sources(ROOT);
  assert.ok(files.length > 40, 'the source files were found');
  // Upstox order, GTT and position-conversion endpoints
  const endpoint = /\/(v2|v3)?\/?order\/(place|modify|cancel|multi|gtt)|\/order\/gtt|\/portfolio\/convert-position|api-hft\.upstox\.com/i;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!endpoint.test(text), `${path.relative(ROOT, f)} references an order endpoint`);
  }
  // the one Upstox client only ever reads: no request to the Upstox API carries a method or a body
  const client = fs.readFileSync(path.join(ROOT, 'lib/upstox.js'), 'utf8');
  assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i.test(client), 'lib/upstox.js sends only GET requests');
});

test('Kite orders are sent only by lib/kite.js, and only the live trader and the Ideas basket use them', () => {
  const orderEndpoint = /\/orders\/(regular|amo|co|iceberg|auction)|\/gtt\/triggers/i;
  const orderCall = /\b(placeOrder|cancelOrder)\s*\(/;
  for (const f of sources(ROOT)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const text = fs.readFileSync(f, 'utf8');
    if (rel !== 'lib/kite.js') assert.ok(!orderEndpoint.test(text), `${rel} references a Kite order endpoint`);
    if (!['lib/kite.js', 'feedlive.js', 'kitebasket.js'].includes(rel)) assert.ok(!orderCall.test(text), `${rel} sends a Kite order`);
  }
  const live = fs.readFileSync(path.join(ROOT, 'feedlive.js'), 'utf8');
  assert.ok(/let on = false;/.test(live), 'live trading starts switched off');
});

test('the Ideas basket keeps its guards, and only the server and the Ideas screen reach it', () => {
  const basket = fs.readFileSync(path.join(ROOT, 'kitebasket.js'), 'utf8');
  assert.ok(/confirmed !== true/.test(basket), 'a basket must be confirmed');
  assert.ok(/no BUY leg/.test(basket), 'an uncovered short is refused');
  assert.ok(/req\.orderType === 'MARKET' \? 'MARKET' : 'LIMIT'/.test(basket), 'LIMIT unless the request asks for MARKET');
  assert.ok(/KITE_ORDERS_ENCTOKEN/.test(basket), 'enctoken sessions need the explicit switch');
  for (const f of sources(ROOT)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (!['server.js', 'public/ideas-view.js'].includes(rel)) assert.ok(!/api\/kite\/basket/.test(fs.readFileSync(f, 'utf8')), `${rel} calls the Ideas basket`);
  }
});
