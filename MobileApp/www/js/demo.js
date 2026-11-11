// A simulated market with the same interface as the Upstox client, so the app can be tried (and tested) with no
// account and no network. Prices are a smooth function of the clock: the same moment always gives the same numbers,
// and they move while the session is open (09:15–15:30 IST on weekdays) and stay put outside it.
import { price, greeks } from './bs.js';
import { ist, istTime, sessionDate, yearsTo, ymd } from './time.js';
import { NIFTY, VIX, BEES } from './upstox.js';

const DAY_MS = 86_400_000;
const STEP = 50;
const round05 = (x) => Math.max(0.05, Math.round(x * 20) / 20);

function dayIndex(date) {
  return Math.round(istTime(date) / DAY_MS);
}

function prevWeekday(date) {
  let ms = istTime(date, 12);
  for (let i = 0; i < 7; i++) {
    ms -= DAY_MS;
    const t = ist(ms);
    if (t.dow >= 1 && t.dow <= 5) return t.date;
  }
  return date;
}

// Nifty on a session date, `min` minutes after 09:15 (0 … 375).
function niftyAt(date, min) {
  const d = dayIndex(date);
  const base = 25800 + 180 * Math.sin(d / 9) + 70 * Math.sin(d * 1.7);
  return base + 85 * Math.sin(min / 75 + d) + 28 * Math.sin(min / 11 + d * 2) + 9 * Math.sin(min / 1.6) - 85 * Math.sin(d);
}
const vixAt = (date, min) => 13 + 1.2 * Math.sin(dayIndex(date) / 5) + 0.4 * Math.sin(min / 40);

// Deterministic 0…1 from a few numbers.
function hash(...xs) {
  let h = 2166136261;
  for (const ch of xs.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export function createDemo({ now = () => Date.now() } = {}) {
  // The session the clock is in (or the last one) and how many minutes of it have passed.
  function clock() {
    const t = now();
    const date = sessionDate(t);
    const open = istTime(date, 9, 15);
    const min = Math.min(375, Math.max(0, (t - open) / 60_000));
    return { t, date, min };
  }

  function quoteOf(key) {
    const { date, min } = clock();
    const prev = prevWeekday(date);
    const f = key === NIFTY ? niftyAt : key === VIX ? vixAt : key === BEES ? (d, m) => niftyAt(d, m) / 89.6 : null;
    if (!f) return null;
    const ltp = +f(date, min).toFixed(2);
    const prevClose = +f(prev, 375).toFixed(2);
    let high = -Infinity;
    let low = Infinity;
    for (let m = 0; m <= min; m += 1) {
      const v = f(date, m);
      if (v > high) high = v;
      if (v < low) low = v;
    }
    return { ltp, change: +(ltp - prevClose).toFixed(2), prevClose, open: +f(date, 0).toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2) };
  }

  async function quotes(keys) {
    const out = {};
    for (const k of keys) {
      const q = quoteOf(k);
      if (q) out[k] = q;
    }
    return out;
  }

  // Weekly expiries on Tuesdays for 8 weeks, plus the last Tuesday of the next few months.
  async function contracts() {
    const t = now();
    const set = new Set();
    let ms = istTime(ist(t).date, 12);
    for (let i = 0; i < 60 && set.size < 8; i++, ms += DAY_MS) {
      const x = ist(ms);
      if (x.dow === 2 && istTime(x.date, 15, 30) > t) set.add(x.date);
    }
    const c = ist(t);
    for (let k = 0; k < 4; k++) {
      const y = c.y + Math.floor((c.m - 1 + k) / 12);
      const m = ((c.m - 1 + k) % 12) + 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = lastDay; d > lastDay - 7; d--) {
        if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 2) {
          const e = ymd(y, m, d);
          if (istTime(e, 15, 30) > t) set.add(e);
          break;
        }
      }
    }
    return { expiries: [...set].sort(), lotSize: 65 };
  }

  async function chain(expiry) {
    const { t, date, min } = clock();
    const S = +niftyAt(date, min).toFixed(2);
    const T = yearsTo(expiry, t);
    if (!(T > 0)) throw new Error(`Expiry ${expiry} has passed`);
    const base = (vixAt(date, min) / 100) * (1 + 0.15 * Math.exp(-T * 20));
    const atm = Math.round(S / STEP) * STEP;
    const rows = [];
    for (let K = atm - 1500; K <= atm + 1500; K += STEP) {
      const m = Math.log(K / S);
      const vol = Math.max(0.06, base * (1 - 1.1 * m + 7 * m * m));
      const mk = (type) => {
        const px = round05(price(type, S, K, T, vol));
        const spread = Math.max(0.1, px * 0.004);
        const round = K % 500 === 0 ? 2.2 : K % 100 === 0 ? 1.5 : 1;
        const center = type === 'CE' ? S + 250 : S - 250;
        const oi = Math.round(((1.8e6 * round * Math.exp(-(((K - center) / 700) ** 2)) * (0.7 + 0.6 * hash(K, type, expiry))) / 65) * 65);
        const drift = 0.82 + 0.3 * hash(K, type, expiry, date) + 0.05 * Math.sin(min / 30 + K);
        return {
          key: `DEMO|${expiry}|${K}${type}`,
          ltp: px,
          close: round05(price(type, niftyAt(prevWeekday(date), 375), K, T + 1 / 365, vol)),
          vol: Math.round(oi * (0.5 + hash(K, type, date)) * (min / 375 + 0.05)),
          oi,
          prevOi: Math.round(oi * drift),
          iv: +(vol * 100).toFixed(2),
          delta: +greeks(type, S, K, T, vol).delta.toFixed(4),
          bid: round05(px - spread / 2),
          ask: round05(px + spread / 2),
        };
      };
      rows.push({ strike: K, ce: mk('CE'), pe: mk('PE') });
    }
    return { expiry, spot: S, rows };
  }

  async function intraday(key = NIFTY, minutes = 5) {
    const { date, min } = clock();
    const open = istTime(date, 9, 15);
    const f = key === VIX ? vixAt : niftyAt;
    const out = [];
    for (let m = 0; m <= min; m += minutes) {
      const seg = [m, m + minutes / 2, Math.min(min, m + minutes)].map((x) => f(date, x));
      out.push({ t: open + m * 60_000, o: seg[0], h: Math.max(...seg), l: Math.min(...seg), c: seg[2] });
    }
    return out;
  }

  return { quotes, contracts, chain, intraday, demo: true };
}
