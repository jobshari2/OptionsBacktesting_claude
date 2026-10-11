const test = require('node:test');
const assert = require('node:assert');
const { RATE, ncdf, bsm, b76, b76iv } = require('../lib/pricing');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('normal CDF: known values and symmetry', () => {
  near(ncdf(0), 0.5, 2e-7);
  near(ncdf(1.96), 0.9750021, 2e-7);
  near(ncdf(-1), 0.1586553, 2e-7);
  for (const x of [0.1, 0.7, 1.3, 2.4, 4]) near(ncdf(x) + ncdf(-x), 1, 1e-12);
});

test('Black-Scholes-Merton: textbook value, put-call parity, intrinsic at expiry', () => {
  near(bsm(100, 100, 1, 0.2, true, 0.05, 0), 10.4506, 1e-3);
  near(bsm(100, 100, 1, 0.2, false, 0.05, 0), 5.5735, 1e-3);
  for (const [S, K, T, v, r, q] of [
    [24800, 24000, 30 / 365, 0.14, 0.065, 0],
    [24800, 26000, 0.5, 0.2, 0.065, 0.013],
    [22000, 22000, 7 / 365, 0.32, 0.07, 0],
  ]) {
    const parity = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    near(bsm(S, K, T, v, true, r, q) - bsm(S, K, T, v, false, r, q), parity, 0.01);
  }
  assert.strictEqual(bsm(24800, 24000, 0, 0.14, true), 800);
  assert.strictEqual(bsm(24800, 24000, 0, 0.14, false), 0);
  assert.strictEqual(bsm(24800, 25000, 0.1, 0, false), 200);
});

test('the rate defaults to RATE and the dividend yield to zero', () => {
  assert.strictEqual(bsm(24800, 24800, 0.1, 0.15, true), bsm(24800, 24800, 0.1, 0.15, true, RATE, 0));
});

test('Black-76 is Black-Scholes on the forward, and its implied vol round-trips', () => {
  const [S, K, T, v] = [24800, 25000, 21 / 365, 0.13];
  const df = Math.exp(-RATE * T);
  for (const call of [true, false]) {
    near(b76(S / df, K, T, v, call, df), bsm(S, K, T, v, call, RATE, 0), 1e-6);
    near(b76iv(b76(S / df, K, T, v, call, df), S / df, K, T, call, df), v, 1e-6);
  }
  assert.strictEqual(b76iv(0.001, 24800, 30000, T, true, df), null); // no time value to read a vol from
});
