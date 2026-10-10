// Option pricing shared by the strategy backtester (bt/engine.js), the anomaly scanner (bt/anomalies.js), the
// hedge backtest (hedge/backtest.js) and the browser (public/bt-common.js loads this same file as /lib/pricing.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RATE = 0.065; // risk-free rate used where none is given

  // Standard normal CDF (Abramowitz–Stegun 26.2.17; accurate to about 2e-7)
  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // Black-Scholes-Merton price of a European option: spot S, strike K, T years, volatility v, rate r, dividend yield q.
  function bsm(S, K, T, v, call, r = RATE, q = 0) {
    if (T <= 0 || v <= 0) return Math.max(0, call ? S - K : K - S);
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + (v * v) / 2) * T) / sq;
    const d2 = d1 - sq;
    return call
      ? S * Math.exp(-q * T) * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2)
      : K * Math.exp(-r * T) * ncdf(-d2) - S * Math.exp(-q * T) * ncdf(-d1);
  }

  // Black-76: the same option priced off the forward F, discounted by df.
  function b76(F, K, T, v, call, df) {
    if (T <= 0 || v <= 0) return df * Math.max(0, call ? F - K : K - F);
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(F / K) + (sq * sq) / 2) / sq;
    const d2 = d1 - sq;
    return call ? df * (F * ncdf(d1) - K * ncdf(d2)) : df * (K * ncdf(-d2) - F * ncdf(-d1));
  }
  // Implied volatility under Black-76 (null when the price carries no time value or is out of range).
  function b76iv(price, F, K, T, call, df) {
    const intrinsic = df * Math.max(0, call ? F - K : K - F);
    if (!(price > intrinsic + 0.01) || T <= 0) return null;
    let lo = 0.01;
    let hi = 3;
    if (b76(F, K, T, hi, call, df) < price) return null;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (b76(F, K, T, mid, call, df) > price) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  return { RATE, ncdf, bsm, b76, b76iv };
});
