// Charges on Nifty option trades by date (a copy of the desktop portal's schedule, kept here so the app stands alone).
// Rates are fractions of premium turnover unless noted:
//   stt    securities transaction tax on the premium of options sold
//   exStt  STT on a bought option that expires in the money, on its intrinsic value
//   txn    NSE transaction charge, both sides;  sebi  SEBI fee, both sides
//   stamp  stamp duty on options bought;        gst   GST on brokerage + exchange + SEBI charges
// Check NSE's charges page and your broker's contract note: these change with every budget.
export const SCHEDULE = [
  { from: '2023-04-01', stt: 0.000625, exStt: 0.00125, txn: 0.0005, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
  { from: '2024-10-01', stt: 0.001, exStt: 0.00125, txn: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
  { from: '2026-04-01', stt: 0.0015, exStt: 0.0015, txn: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
];
export const BROKERAGE = 20; // ₹ per order (a flat-fee broker)

export function rates(day) {
  let r = SCHEDULE[0];
  for (const s of SCHEDULE) if (!day || s.from <= day) r = s;
  return r;
}

// ₹ charged on a set of orders: buy / sell = premium turnover in ₹ on each side; n = number of orders.
export function orders({ buy = 0, sell = 0, n = 0, day = null, brokerage = BROKERAGE }) {
  const r = rates(day);
  const brk = n * brokerage;
  const fees = (buy + sell) * (r.txn + r.sebi);
  return brk + sell * r.stt + fees + r.gst * (brk + fees) + buy * r.stamp;
}

// STT on bought options that expire in the money: value = their intrinsic value in ₹.
export const exercise = (value, day = null) => Math.max(0, value) * rates(day).exStt;
