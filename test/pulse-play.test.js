const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { createPulse } = require('../pulse');

const T0 = Date.UTC(2026, 9, 19, 4, 0, 0); // 09:30 IST
const STRIKES = [];
for (let k = 24000; k <= 24600; k += 50) STRIKES.push(k);

// A day tape: Nifty drifts by `slope` pts/min; per-strike [ceLtp, ceVol, ceOi, peLtp, peVol, peOi].
function entry(min, spot, oi) {
  const d = {};
  for (const k of STRIKES) {
    const ce = Math.max(1, spot - k + 60 + (oi.cePx || 0) * min);
    const pe = Math.max(1, k - spot + 60 + (oi.pePx || 0) * min);
    d[k] = [ce, 0, 1e6 + (oi.ceOi || 0) * min, pe, 0, 1e6 + (oi.peOi || 0) * min];
  }
  return { t: T0 + min * 60_000, spot, d };
}
function snapOf(e) {
  const rows = STRIKES.map((k) => ({
    strike: k,
    ce: { ltp: e.d[k][0], oi: e.d[k][2], prevOi: 1e6, bid: e.d[k][0] - 0.2, ask: e.d[k][0] + 0.2, iv: 12 },
    pe: { ltp: e.d[k][3], oi: e.d[k][5], prevOi: 1e6, bid: e.d[k][3] - 0.2, ask: e.d[k][3] + 0.2, iv: 12 },
  }));
  return { spot: e.spot, rows };
}
function run(slope, oi) {
  const p = createPulse({
    dir: os.tmpdir(),
    logError: (n, e) => {
      throw e;
    },
  });
  let e;
  for (let m = 0; m <= 30; m++) {
    for (let s = 0; s < 4; s++) {
      e = entry(m + s / 4, 24300 + slope * (m + s / 4), oi);
      e.t = T0 + m * 60_000 + s * 15_000;
      p.update(e, snapOf(e), null, { events: [] });
    }
  }
  return p.state().play;
}

test('rising market with put writing and call short-covering → buy a call', () => {
  const y = run(1, { peOi: 20000, pePx: -0.1, ceOi: -15000, cePx: 0.4 });
  assert.equal(y.action, 'BUY');
  assert.equal(y.side, 'CE');
  assert.ok(y.pick.strike >= 24200 && y.pick.strike <= 24400);
  assert.ok(y.pick.niftyTarget > y.pick.niftyStop);
});

test('falling market with call writing and put buying → buy a put', () => {
  const y = run(-1, { ceOi: 20000, cePx: -0.4, peOi: 15000, pePx: 0.4 });
  assert.equal(y.action, 'BUY');
  assert.equal(y.side, 'PE');
  assert.ok(y.pick.niftyTarget < y.pick.niftyStop);
});

test('flat market, no OI change → wait', () => {
  const y = run(0, {});
  assert.equal(y.action, 'WAIT');
  assert.equal(y.pick, null);
});
