// The app is a research and scanning tool: it reads market data and never places, modifies or cancels an order.
// This test fails if a call to one of Upstox's order endpoints (or a write to the Upstox API) is ever added.
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
