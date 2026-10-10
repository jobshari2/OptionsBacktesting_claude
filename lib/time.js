// Indian Standard Time and NSE trading hours, shared by the recorders, the backtesters and the server.
const IST_OFFSET = 5.5 * 3600_000;
const istDate = (ts = Date.now()) => new Date(ts + IST_OFFSET).toISOString().slice(0, 10); // YYYY-MM-DD
const istTime = (ts = Date.now()) => new Date(ts + IST_OFFSET).toISOString().slice(11, 19); // HH:MM:SS

// NSE F&O trading hours: Mon–Fri 09:15–15:30 IST (exchange holidays not accounted for).
function isMarketOpen(ts = Date.now()) {
  const ist = new Date(ts + IST_OFFSET);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

module.exports = { IST_OFFSET, istDate, istTime, isMarketOpen };
