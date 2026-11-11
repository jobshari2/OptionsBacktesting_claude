// Black-Scholes for European index options (Nifty options are European). Volatility as a fraction (0.13 = 13 %).
export const RATE = 0.065;

// Abramowitz–Stegun 7.1.26 erf: error < 1.5e-7, plenty for option prices.
function erf(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export const intrinsic = (type, S, K) => (type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S));

export function price(type, S, K, T, vol, r = RATE) {
  if (!(T > 0) || !(vol > 0)) return intrinsic(type, S, K);
  const sq = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  return type === 'CE' ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
}

// delta, gamma (per point), theta (₹ per calendar day), vega (₹ per 1 vol point) for one unit.
export function greeks(type, S, K, T, vol, r = RATE) {
  if (!(T > 0) || !(vol > 0)) {
    const itm = type === 'CE' ? S > K : S < K;
    return { delta: itm ? (type === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  const gamma = npdf(d1) / (S * sq);
  const vega = (S * npdf(d1) * Math.sqrt(T)) / 100;
  const common = -(S * npdf(d1) * vol) / (2 * Math.sqrt(T));
  const theta = type === 'CE' ? common - r * K * df * ncdf(d2) : common + r * K * df * ncdf(-d2);
  return { delta: type === 'CE' ? ncdf(d1) : ncdf(d1) - 1, gamma, theta: theta / 365, vega };
}

// Implied volatility by bisection; null when the price is outside what any volatility can give.
export function impliedVol(type, px, S, K, T, r = RATE) {
  if (!(px > 0) || !(T > 0)) return null;
  let lo = 0.005;
  let hi = 3;
  if (px < price(type, S, K, T, lo, r) - 1e-9 || px > price(type, S, K, T, hi, r)) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (price(type, S, K, T, mid, r) > px) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
