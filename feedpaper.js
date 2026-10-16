// Paper trades on big Upstox-vs-Kite price gaps (Feeds screen). When the two feeds' LTPs of an option are at least
// `minGap` apart, a trade is opened in the direction of the feed that moved first (its price above the other's =
// BUY, below = SELL), on the theory that the slower feed is about to catch up.
// Fills are what could really have been done: the market is one order book, so an order fills at the live quote,
// not at the stale price the slow feed still shows. Entry = the ask (BUY) or bid (SELL) of the feed that moved
// first; afterwards each mark uses the feed whose quote arrived last. The P&L of the impossible fill at the stale
// price is kept beside it ("at stale price"), to show how much of the gap was never really there.
// A trade closes at +target ₹ per unit, at -stop (if set), after maxHoldSec, or at 15:25 IST. With `exitOnConverge` on,
// the +target is replaced by the moment the two feeds' LTPs show the same price again (stop, max hold and 15:25 still
// apply). Whether or not that exit is on, the first time the feeds agree again after entry is noted on the trade
// (`conv`: when, and the profit per unit / in ₹ / after charges had it been closed then). A trade is closed, then
// still followed until 15 minutes after entry, so the screen shows what the price did later.
// Trades are appended to <events dir>/<date>/feedpaper.jsonl (a trade's later lines replace its earlier ones).
const fs = require('fs');
const path = require('path');
const { istDate, istTime } = require('./lib/time');
const Costs = require('./lib/costs');

const LATER_SEC = [5, 30, 60, 300, 900];
const FOLLOW_MS = 900_000; // keep watching a trade until 15 minutes after its entry
const PAPER_DEFAULTS = {
  enabled: true,
  minGap: 5,
  target: 3,
  stop: 0,
  maxHoldSec: 300,
  lots: 1,
  cooldownSec: 60,
  side: 'both',
  exitOnConverge: false,
  surgeGate: false,
  surgePct: 60,
};
const CONVERGED = 0.025; // LTPs are quoted in 0.05 steps: closer than half a step = the same price

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function cleanPaper(p = {}) {
  const n = (v, d, lo, hi) => {
    const x = Number(v ?? d);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    enabled: p.enabled !== false,
    minGap: n(p.minGap, PAPER_DEFAULTS.minGap, 0.5, 100),
    target: n(p.target, PAPER_DEFAULTS.target, 0.05, 100),
    stop: n(p.stop, PAPER_DEFAULTS.stop, 0, 100),
    maxHoldSec: Math.round(n(p.maxHoldSec, PAPER_DEFAULTS.maxHoldSec, 5, 6 * 3600)),
    lots: Math.round(n(p.lots, PAPER_DEFAULTS.lots, 1, 100)),
    cooldownSec: Math.round(n(p.cooldownSec, PAPER_DEFAULTS.cooldownSec, 0, 3600)),
    side: ['both', 'buy', 'sell'].includes(p.side) ? p.side : 'both',
    exitOnConverge: p.exitOnConverge === true,
    surgeGate: p.surgeGate === true,
    surgePct: n(p.surgePct, PAPER_DEFAULTS.surgePct, 1, 100),
  };
}

// Round-trip charges in ₹ for one trade (2 orders) at these prices.
function charges(t) {
  const qty = t.lot * t.lots;
  const buy = (t.side === 'BUY' ? t.entry : t.exit) * qty;
  const sell = (t.side === 'BUY' ? t.exit : t.entry) * qty;
  return r2(Costs.orders({ buy, sell, orders: 2, day: istDate(t.at) }));
}

// quotes(id) -> { u: { ltp, bid, ask, at }, k: {...} } (latest of each feed); getLot() -> contract size.
// getSurge() -> the signals' volume breadth { ready, pct } (share of strikes near ATM trading well above their normal
// volume), or null. Every trade is tagged with it (t.surge, in %); with the surge gate on, no trade opens below
// surgePct, or while the breadth isn't known yet.
// onOpen(trade) / onClose(trade, reason): told when a trade opens and closes (live trading follows them).
function createFeedPaper({
  dir,
  getConfig,
  quotes,
  getLot,
  getSurge = () => null,
  onOpen = () => {},
  onClose = () => {},
  logError = () => {},
  now = () => Date.now(),
}) {
  let day = istDate(now());
  let trades = readTrades(dir, day); // this day's trades, oldest first
  const cool = new Map(); // instrument -> no new trade before this time
  let pending = [];
  let seq = 0;

  const save = (t) => pending.push(t);
  const flush = () => {
    if (!pending.length) return;
    const byDay = new Map();
    for (const t of pending) byDay.set(istDate(t.at), (byDay.get(istDate(t.at)) || '') + JSON.stringify(t) + '\n');
    pending = [];
    for (const [d, text] of byDay) {
      try {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
        fs.appendFileSync(path.join(dir, d, 'feedpaper.jsonl'), text);
      } catch (e) {
        logError('feedpaper-log', e);
      }
    }
  };
  setInterval(flush, 2000).unref?.();

  // The quote a fill or mark uses: the given feed's, or (src null) the one that arrived last.
  function pickQuote(q, src) {
    if (src) return { src, ...q[src] };
    const u = q.u?.at || 0;
    const k = q.k?.at || 0;
    return u >= k ? { src: 'u', ...q.u } : { src: 'k', ...q.k };
  }
  // Price the trade could be closed at: the bid of a BUY, the ask of a SELL (LTP when the feed has no quote).
  const exitPx = (t, q) => (t.side === 'BUY' ? q.bid || q.ltp : q.ask || q.ltp);

  function open(id, expiry, g, at) {
    const c = getConfig();
    const { u, k, l: lead } = g;
    const fresh = lead === 'u' ? u : k;
    const stale = lead === 'u' ? k : u;
    const side = fresh > stale ? 'BUY' : 'SELL';
    if ((c.side === 'buy' && side !== 'BUY') || (c.side === 'sell' && side !== 'SELL')) return;
    const q = quotes(id);
    const fq = q?.[lead];
    if (!fq) return;
    const quoted = side === 'BUY' ? fq.ask : fq.bid;
    const entry = quoted || fresh;
    const b = getSurge();
    const surge = b?.ready && Number.isFinite(b.pct) ? r2(b.pct) : null;
    const t = {
      id: `${istTime(at).replace(/:/g, '')}-${id}-${++seq}`,
      i: id,
      x: expiry,
      side,
      lead,
      at,
      surge,
      gap: r2(Math.abs(u - k)),
      uLtp: u,
      kLtp: k,
      entry: r2(entry),
      entryFeed: lead,
      entryQuote: { bid: fq.bid ?? null, ask: fq.ask ?? null },
      quoted: Boolean(quoted),
      stale: r2(stale),
      lot: getLot(),
      lots: c.lots,
      status: 'open',
      mark: r2(entry),
      markFeed: lead,
      pnl: 0,
      mfe: 0,
      mae: 0,
      later: {},
    };
    trades.push(t);
    save(t);
    onOpen(t);
  }

  function close(t, px, src, at, reason) {
    t.status = 'closed';
    t.exitAt = at;
    t.exit = r2(px);
    t.exitFeed = src;
    t.reason = reason;
    t.pnl = r2((t.exit - t.entry) * (t.side === 'BUY' ? 1 : -1));
    t.stalePnl = r2((t.exit - t.stale) * (t.side === 'BUY' ? 1 : -1));
    t.gross = r2(t.pnl * t.lot * t.lots);
    t.costs = charges(t);
    t.net = r2(t.gross - t.costs);
    save({ ...t });
    onClose(t, reason);
  }

  return {
    // After every tick of an instrument: open a trade when its LTP gap is big enough. g = { u, k, l }: both feeds'
    // LTPs and the feed that moved first, while they differ (from the comparer's ltpGap).
    check(id, expiry, g, at) {
      const c = getConfig();
      if (!c.enabled || id === 'NIFTY' || !g || Math.abs(g.u - g.k) < c.minGap - 1e-9) return;
      if (trades.some((t) => t.i === id && t.status === 'open')) return;
      if (at < (cool.get(id) || 0)) return;
      if (c.surgeGate) {
        const b = getSurge();
        if (!b?.ready || !(b.pct >= c.surgePct - 1e-9)) return; // no broad volume surge: no trade, and no cooldown used up
      }
      cool.set(id, at + c.cooldownSec * 1000);
      open(id, expiry, g, at);
    },
    // Every half second: mark open trades, close them, and note what happened later.
    tick(at = now()) {
      const d = istDate(at);
      if (d !== day) {
        flush();
        day = d;
        trades = [];
        cool.clear();
      }
      const c = getConfig();
      const eod = istTime(at) >= '15:25:00';
      for (const t of trades) {
        if (t.done) continue;
        const q = quotes(t.i);
        if (!q) continue;
        const mq = pickQuote(q, null);
        const px = exitPx(t, mq);
        if (px == null) continue;
        const pnl = r2((px - t.entry) * (t.side === 'BUY' ? 1 : -1));
        const age = at - t.at;
        const same = q.u?.ltp != null && q.k?.ltp != null && Math.abs(q.u.ltp - q.k.ltp) < CONVERGED;
        if (same && !t.conv) {
          const gross = r2(pnl * t.lot * t.lots);
          const costs = charges({ ...t, exit: px, at: t.at });
          t.conv = { at, ltp: q.u.ltp, px: r2(px), pnl, gross, net: r2(gross - costs) };
        }
        for (const s of LATER_SEC) if (t.later[s] == null && age >= s * 1000) t.later[s] = pnl;
        if (t.status === 'open') {
          t.mark = r2(px);
          t.markFeed = mq.src;
          t.pnl = pnl;
          t.mfe = Math.max(t.mfe, pnl);
          t.mae = Math.min(t.mae, pnl);
          if (!c.exitOnConverge && pnl >= c.target - 1e-9) close(t, px, mq.src, at, 'target');
          else if (c.stop > 0 && pnl <= -c.stop + 1e-9) close(t, px, mq.src, at, 'stop');
          else if (c.exitOnConverge && same) close(t, px, mq.src, at, 'converge');
          else if (age >= c.maxHoldSec * 1000) close(t, px, mq.src, at, 'time');
          else if (eod) close(t, px, mq.src, at, 'eod');
        }
        if (t.status === 'closed' && (age >= FOLLOW_MS || eod)) {
          t.done = true;
          save({ ...t });
        }
      }
    },
    flush,
    // Save a trade again (its live order details changed).
    touch: (t) => save({ ...t }),
    list: (date) => (date && date !== day ? readTrades(dir, date) : trades),
    get day() {
      return day;
    },
  };
}

// The trades of a day: the last line written for each one.
function readTrades(dir, day) {
  const file = path.join(dir, day, 'feedpaper.jsonl');
  if (!fs.existsSync(file)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const t = JSON.parse(line);
      byId.set(t.id, t);
    } catch {}
  }
  // a trade left open by a restart can't be followed any more
  return [...byId.values()].map((t) => (t.status === 'open' ? { ...t, status: 'lost', done: true } : t.done ? t : { ...t, done: true }));
}

function summarizePaper(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  const sum = (f) => r2(closed.reduce((a, t) => a + (f(t) || 0), 0));
  const n = closed.length;
  return {
    trades: trades.length,
    open: trades.filter((t) => t.status === 'open').length,
    closed: n,
    target: closed.filter((t) => t.reason === 'target').length,
    converge: closed.filter((t) => t.reason === 'converge').length,
    wins: closed.filter((t) => t.pnl > 0).length,
    pnl: sum((t) => t.pnl),
    stalePnl: sum((t) => t.stalePnl),
    avg: n ? r2(sum((t) => t.pnl) / n) : null,
    avgStale: n ? r2(sum((t) => t.stalePnl) / n) : null,
    gross: sum((t) => t.gross),
    costs: sum((t) => t.costs),
    net: sum((t) => t.net),
  };
}

// The day's trades split by the volume breadth they opened in: at or above the gate's level, below it, or not tagged
// (opened before the breadth was recorded, or while it wasn't ready).
function summarizeBySurge(trades, minPct = PAPER_DEFAULTS.surgePct) {
  const has = (t) => typeof t.surge === 'number';
  return {
    minPct,
    surge: summarizePaper(trades.filter((t) => has(t) && t.surge >= minPct)),
    calm: summarizePaper(trades.filter((t) => has(t) && t.surge < minPct)),
    untagged: summarizePaper(trades.filter((t) => !has(t))),
  };
}

module.exports = { createFeedPaper, cleanPaper, summarizePaper, summarizeBySurge, readTrades, PAPER_DEFAULTS, LATER_SEC };
