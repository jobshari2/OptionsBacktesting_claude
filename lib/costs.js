// Charges on Nifty option trades by date, shared by the Arbitrage screen (the browser loads this same file as
// /lib/costs.js) and its history scan (bt/scan.js). Rates are fractions of the premium turnover unless noted.
//   stt    securities transaction tax on the premium of options sold
//   exStt  STT on a bought option that expires in the money, on its intrinsic (settlement) value
//   txn    NSE transaction charge, both sides
//   sebi   SEBI turnover fee (₹10 a crore), both sides
//   stamp  stamp duty on options bought
//   gst    GST on brokerage and on the exchange and SEBI charges
// A row applies from its date until the next one; trades before the first row use the first row.
// Sources: Finance Act 2023 (STT from 1 Apr 2023), Finance (No. 2) Act 2024 (STT from 1 Oct 2024), NSE's uniform
// transaction charges (1 Oct 2024), Finance Act 2026 (STT from 1 Apr 2026). Check NSE's charges page and your
// broker's contract note before relying on them: they change with every budget.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Costs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SCHEDULE = [
    { from: '2023-04-01', stt: 0.000625, exStt: 0.00125, txn: 0.0005, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
    { from: '2024-10-01', stt: 0.001, exStt: 0.00125, txn: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
    { from: '2026-04-01', stt: 0.0015, exStt: 0.0015, txn: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 },
  ];
  const BROKERAGE = 20; // ₹ per order (a flat-fee broker)

  // The rates in force on `day` (YYYY-MM-DD); today's when no day is given.
  function rates(day) {
    let r = SCHEDULE[0];
    for (const s of SCHEDULE) if (!day || s.from <= day) r = s;
    return r;
  }

  // ₹ charged on a set of orders: `buy` / `sell` = premium turnover on each side in ₹, `orders` = how many orders.
  function orders({ buy = 0, sell = 0, orders: n = 0, day = null, brokerage = BROKERAGE }) {
    const r = rates(day);
    const brk = n * brokerage;
    const fees = (buy + sell) * (r.txn + r.sebi);
    return brk + sell * r.stt + fees + r.gst * (brk + fees) + buy * r.stamp;
  }

  // ₹ of STT on bought options that expire in the money: `value` = their intrinsic value in ₹.
  const exercise = (value, day = null) => Math.max(0, value) * rates(day).exStt;

  return { SCHEDULE, BROKERAGE, rates, orders, exercise };
});
