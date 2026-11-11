// India Standard Time helpers. The phone may be set to any time zone; market hours are always IST (UTC+05:30).
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

// { y, m, d, hh, mm, ss, dow (0 = Sunday), date: 'YYYY-MM-DD', mins (minutes since IST midnight) }
export function ist(now = Date.now()) {
  const t = new Date(+now + IST_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  const hh = t.getUTCHours();
  const mm = t.getUTCMinutes();
  return { y, m, d, hh, mm, ss: t.getUTCSeconds(), dow: t.getUTCDay(), date: ymd(y, m, d), mins: hh * 60 + mm };
}

export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Epoch ms of an IST wall-clock time on a 'YYYY-MM-DD' day.
export function istTime(date, hh = 0, mm = 0) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_MS;
}

export const OPEN_MINS = 9 * 60 + 15;
export const CLOSE_MINS = 15 * 60 + 30;

// Regular session, Monday–Friday 09:15–15:30 IST (exchange holidays are not known to the app).
export function marketOpen(now = Date.now()) {
  const t = ist(now);
  return t.dow >= 1 && t.dow <= 5 && t.mins >= OPEN_MINS && t.mins < CLOSE_MINS;
}

// Options expire at 15:30 IST on their expiry day.
export const expiryTime = (expiry) => istTime(expiry, 15, 30);

// Years to expiry (for Black-Scholes), never negative.
export const yearsTo = (expiry, now = Date.now()) => Math.max(0, expiryTime(expiry) - now) / (365 * DAY_MS);

// Calendar days from today (IST) to the expiry day: 0 on expiry day.
export function daysTo(expiry, now = Date.now()) {
  return Math.round((istTime(expiry) - istTime(ist(now).date)) / DAY_MS);
}

// Upstox access tokens stop working at 03:30 IST the day after they were issued (before 03:30: the same day).
export function tokenExpiry(now = Date.now()) {
  const t = ist(now);
  const today = istTime(t.date, 3, 30);
  return now < today ? today : today + DAY_MS;
}

// The last weekday session date on or before `now` (IST) that has started: before 09:15, the previous weekday.
export function sessionDate(now = Date.now()) {
  let t = ist(now);
  let ms = +now;
  if (t.dow >= 1 && t.dow <= 5 && t.mins >= OPEN_MINS) return t.date;
  for (let i = 0; i < 7; i++) {
    ms -= DAY_MS;
    t = ist(ms);
    if (t.dow >= 1 && t.dow <= 5) return t.date;
  }
  return t.date;
}

export function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${mon} ${String(y).slice(2)}`;
}

export function fmtClock(ms) {
  const t = ist(ms);
  return `${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}:${String(t.ss).padStart(2, '0')}`;
}
