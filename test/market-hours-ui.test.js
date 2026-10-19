// The portal's pollers must stop at 15:30 IST: the clock rule in public/app.js, checked at its boundaries.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const fn = src.slice(src.indexOf('function isMarketOpen'), src.indexOf('function updateStatus'));
const isMarketOpen = new Function(`${fn}; return isMarketOpen;`)();
const ist = (h, m, s = 0, day = '2026-10-19') => Date.parse(`${day}T00:00:00Z`) - 5.5 * 3600_000 + ((h * 60 + m) * 60 + s) * 1000;

test('market hours are 09:15 up to, not including, 15:30 IST on weekdays', () => {
  assert.equal(isMarketOpen(ist(9, 14, 59)), false);
  assert.equal(isMarketOpen(ist(9, 15)), true);
  assert.equal(isMarketOpen(ist(15, 29, 59)), true);
  assert.equal(isMarketOpen(ist(15, 30)), false);
  assert.equal(isMarketOpen(ist(15, 30, 30)), false);
  assert.equal(isMarketOpen(ist(16, 0)), false);
  assert.equal(isMarketOpen(ist(11, 0, 0, '2026-10-17')), false); // Saturday
});

test('every poller on the portal checks marketClosed() before it asks the server', () => {
  const pollers = {
    'app.js': ['marketClosed() ? scheduleWake()', 'if (!force && marketClosed()'],
    'chain-chart.js': ['window.app?.marketClosed?.()'],
    'an-view.js': ['window.app.marketClosed()'],
    'sb-view.js': ['window.app.marketClosed()'],
    'feeds-view.js': ['window.app.marketClosed()'],
    'bt-common.js': ['window.app?.marketClosed?.()'],
  };
  for (const [file, needles] of Object.entries(pollers)) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    for (const n of needles) assert.ok(text.includes(n), `${file} should contain ${n}`);
  }
});
