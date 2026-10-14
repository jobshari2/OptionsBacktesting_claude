// Live trading of the Feeds screen's gap trades on Zerodha Kite. Real orders, real money.
// It follows the paper trades (feedpaper.js): when a paper trade opens, a MARKET order for the same side is sent
// (1 lot by default); when the paper trade closes (its target, stop or max hold, i.e. the existing settings), the
// opposite MARKET order closes the position. Any position still open at 15:15 IST is closed then, before Zerodha's
// own intraday square-off.
// Safety:
//   - off after every server start, after a Kite logout and when the Kite account changes; switching it on needs
//     an explicit confirmation from the screen
//   - only with a Kite Connect login (the enctoken web session is unofficial) unless KITE_ORDERS_ENCTOKEN=1
//   - entries only in market hours and before 15:10, at most maxEntries a day and maxOpen positions at a time
//   - with "Kite trades only" (on by default) only trades where Kite moved first, i.e. entered at Kite's own quote,
//     are sent
//   - exits are always sent, whatever the limits; a failed exit stays on screen until "Square off" succeeds
//   - a position can be closed from the screen (Close, Square off all) or in Kite itself: Kite's positions are
//     read every few seconds and before every exit, and whatever has been closed there is marked "closed in Kite"
//     (priced from the closing order found in Kite's order book) and no order is sent for it, so an exit can't open
//     a reverse position
// Open positions are marked to market (Kite's bid for a long, ask for a short) for the live P&L.
// Funds: Kite's "available to trade" (equity net) is read every 30 s and just before each budget-sized entry. With
// "Size by budget" on, an entry's lots = what budgetPct % of that buys (a BUY needs the premium at the ask, a SELL the
// margin Kite's calculator asks for), at most maxLots; 0 lots = the trade is skipped.
// Test order (the screen's button, whether or not live trading is on): BUY 1 lot of the ATM call or put at MARKET.
// It is a real position: listed on the screen and closed by "Square off all" or at 15:15. Or, as a check only, a
// 1-lot LIMIT BUY at ₹0.05 of the ATM call, which can't fill and is cancelled at once if Kite accepts it.
const Costs = require('./lib/costs');
const KiteApi = require('./lib/kite');
const { istDate, istTime } = require('./lib/time');

const LIVE_DEFAULTS = { lots: 1, product: 'MIS', maxEntries: 10, maxOpen: 1, kiteOnly: true, budget: false, budgetPct: 90, maxLots: 10 };
const TERMINAL = new Set(['COMPLETE', 'REJECTED', 'CANCELLED', 'ERROR']);
const ENTRY_UNTIL = '15:10:00';
const SQUARE_OFF_AT = '15:15:00';
const TAG = 'feedgap';

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanLive(c = {}) {
  const n = (v, d, lo, hi) => {
    const x = Math.round(Number(v ?? d));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    lots: n(c.lots, LIVE_DEFAULTS.lots, 1, 50),
    product: c.product === 'NRML' ? 'NRML' : 'MIS',
    maxEntries: n(c.maxEntries, LIVE_DEFAULTS.maxEntries, 1, 500),
    maxOpen: n(c.maxOpen, LIVE_DEFAULTS.maxOpen, 1, 20),
    kiteOnly: c.kiteOnly !== false,
    budget: c.budget === true,
    budgetPct: n(c.budgetPct, LIVE_DEFAULTS.budgetPct, 1, 100),
    maxLots: n(c.maxLots, LIVE_DEFAULTS.maxLots, 1, 50),
  };
}

// getAuth() -> the Kite login; getSymbol(instrument id) -> Kite tradingsymbol; getTestSymbol('CE' | 'PE') ->
// { id, symbol } of the ATM option;
// onChange(trade) -> persist the paper trade that carries the order details (trade.live).
function createLiveTrader({
  getConfig,
  getAuth,
  getSymbol,
  getTestSymbol,
  getLot,
  isMarketOpen,
  onChange = () => {},
  logError = () => {},
  demo = false,
  allowEnctoken = false,
  marketProtection = null,
  api = KiteApi,
  getQuote = () => null, // (instrument id) -> { ltp, bid, ask } for the live P&L
  now = () => Date.now(),
  pollMs = 500,
}) {
  let on = false;
  let since = null;
  let account = null;
  let day = istDate(now());
  let entries = 0; // live entries sent today
  const active = new Map(); // paper trade id -> trade, while a live position may be open
  const events = []; // newest first, for the screen
  const tests = []; // test buys, newest first (kept in memory only)
  // a test buy is not a paper trade: nothing to save
  const changed = (t) => {
    if (!t.test) onChange(t);
  };
  let pos = { list: null, raw: null, at: 0, error: null, busy: null };
  let fund = { available: null, cash: null, used: null, at: 0, error: null, busy: null };
  const DEMO_FUNDS = 100_000;

  // Kite's funds for F&O: available to trade (equity net), cash, used. One request at a time.
  function refreshFunds() {
    const auth = getAuth();
    if (demo) {
      Object.assign(fund, { available: DEMO_FUNDS, cash: DEMO_FUNDS, used: 0, at: now(), error: null });
      return Promise.resolve(fund);
    }
    if (!auth) return Promise.resolve(null);
    if (!fund.busy)
      fund.busy = api
        .funds(auth)
        .then((e) => {
          Object.assign(fund, { available: r2(e?.net ?? null), cash: r2(e?.available?.cash ?? null), used: r2(e?.utilised?.debits ?? null), error: null });
          return fund;
        })
        .catch((e) => {
          fund.error = e.message;
          return null;
        })
        .finally(() => {
          fund.at = now();
          fund.busy = null;
        });
    return fund.busy;
  }

  // Cost of one lot: a BUY pays the premium (at the ask, else the LTP, else the paper entry); a SELL needs the margin
  // Kite's calculator gives for one lot.
  async function perLot(t, symbol, side, product) {
    const lot = getLot();
    if (side === 'BUY') {
      const q = getQuote(t.i);
      const px = q?.ask || q?.ltp || t.entry;
      return px ? px * lot : null;
    }
    if (demo) return 120_000;
    const [m] = await api.orderMargins(getAuth(), [{ tradingsymbol: symbol, transaction_type: side, quantity: lot, product }]);
    return m?.total || null;
  }

  // Lots the budget buys: floor(budgetPct % of the available funds / cost of a lot), at most maxLots.
  function lotsFor(available, cost, c) {
    if (!(available > 0) || !(cost > 0)) return 0;
    return Math.min(c.maxLots, Math.floor((available * c.budgetPct) / 100 / cost));
  }
  const ours = new Set(); // ids of the orders this app sent
  const suspect = new Map(); // symbol|product -> when Kite was first seen holding less than this app's positions
  let polling = false;

  function note(msg, level = 'info') {
    events.unshift({ at: now(), msg, level });
    if (events.length > 40) events.length = 40;
    if (level === 'error') logError('kite-live', msg);
  }

  const openStates = new Set(['entering', 'open', 'exiting', 'exit-failed']);
  const openCount = () => [...active.values()].filter((t) => !t.test && openStates.has(t.live.state)).length;

  function authOk(auth) {
    if (demo) return null;
    if (!auth) return 'Not logged in to Kite';
    if (auth.mode === 'enctoken' && !allowEnctoken)
      return 'Live orders need a Kite Connect login (the enctoken web session is unofficial). Set KITE_ORDERS_ENCTOKEN=1 in .env to allow it anyway.';
    return null;
  }

  async function refreshLeg(auth, leg) {
    const s = await api.orderStatus(auth, leg.id);
    leg.status = s.status;
    leg.avg = s.average_price ? r2(s.average_price) : leg.avg;
    leg.filled = s.filled_quantity ?? leg.filled;
    leg.msg = s.status_message || null;
  }

  // Send one MARKET order for a trade and follow it until Kite reports it filled, rejected or cancelled.
  async function send(t, which, side, qty) {
    const leg = { side, qty, status: 'SENDING', id: null, avg: null, filled: 0, msg: null, at: now() };
    t.live[which] = leg;
    changed(t);
    const auth = getAuth();
    try {
      if (demo) {
        await sleep(150);
        leg.id = `DEMO-${now()}`;
        leg.status = 'COMPLETE';
        leg.filled = qty;
        const q = getQuote(t.i); // simulated fill at the quote
        leg.avg = r2((side === 'BUY' ? q?.ask || q?.ltp : q?.bid || q?.ltp) ?? (which === 'entry' ? t.entry : (t.exit ?? t.mark)));
      } else {
        const why = authOk(auth);
        if (why) throw new Error(why);
        leg.id = await api.placeOrder(auth, {
          tradingsymbol: t.live.symbol,
          transaction_type: side,
          quantity: qty,
          order_type: 'MARKET',
          product: t.live.product,
          market_protection: marketProtection,
          tag: TAG,
        });
        leg.status = 'PLACED';
        ours.add(leg.id);
        changed(t);
        for (let i = 0; i < 20 && !TERMINAL.has(leg.status); i++) {
          await sleep(pollMs);
          try {
            await refreshLeg(auth, leg);
          } catch (e) {
            leg.msg = 'status check failed: ' + e.message;
          }
        }
      }
    } catch (e) {
      leg.status = 'ERROR';
      leg.msg = e.message;
    }
    settle(t, which);
  }

  // What an order's outcome means for the position.
  function settle(t, which) {
    const L = t.live;
    const leg = L[which];
    if (leg.settled) return;
    if (!TERMINAL.has(leg.status)) {
      changed(t); // still working: tick() keeps asking Kite
      return;
    }
    leg.settled = true;
    if (which === 'entry') {
      if (leg.filled > 0) {
        L.state = 'open';
        leg.doneAt = now();
        note(`${t.i} ${leg.side} ${leg.filled} filled at ${leg.avg} (${L.symbol})`);
        if (L.wantExit) exit(t, L.wantExit);
      } else {
        L.state = 'failed';
        active.delete(t.id);
        note(`${t.i} ${leg.side} entry ${leg.status.toLowerCase()}: ${leg.msg || 'no reason given'}`, 'error');
      }
    } else {
      // exits may take more than one order (a partial fill, a retry after a failure): add up what has been closed
      if (leg.filled > 0) {
        L.exitedQty = (L.exitedQty || 0) + leg.filled;
        L.exitValue = (L.exitValue || 0) + leg.filled * leg.avg;
        L.exitOrders = (L.exitOrders || 0) + 1;
      }
      if (remaining(t) <= 0) {
        finish(t);
        note(`${t.i} closed: ${leg.side} ${L.entry.filled} at ${L.exitAvg} · ${L.net >= 0 ? '+' : '−'}₹${Math.abs(L.net)} net`);
      } else {
        L.state = 'exit-failed';
        note(
          `${t.i} EXIT ${leg.status.toLowerCase()}: ${leg.msg || 'no reason given'}. ${L.entry.filled - (L.exitedQty || 0)} still open on Kite: press Square off or close it in Kite.`,
          'error',
        );
      }
    }
    changed(t);
  }

  const remaining = (t) => t.live.entry.filled - (t.live.exitedQty || 0);

  // All of a position is closed: its P&L from the exit fills (and, for what was closed in Kite, the price found there).
  function finish(t) {
    const L = t.live;
    L.state = 'closed';
    active.delete(t.id);
    const dir = L.entry.side === 'BUY' ? 1 : -1;
    const qty = L.entry.filled;
    L.exitAvg = r2(L.exitValue / L.exitedQty);
    L.pnl = r2((L.exitAvg - L.entry.avg) * dir);
    L.gross = r2((L.exitValue / L.exitedQty - L.entry.avg) * dir * qty);
    const buy = dir > 0 ? L.entry.avg * qty : L.exitValue;
    const sell = dir > 0 ? L.exitValue : L.entry.avg * qty;
    L.costs = r2(Costs.orders({ buy, sell, orders: 1 + (L.exitOrders || 1), day: istDate(t.at) }));
    L.net = r2(L.gross - L.costs);
    L.mark = null;
    L.upnl = null;
    changed(t);
  }

  // Close a position at market, unless Kite shows it has already been closed there.
  async function exit(t, reason) {
    const L = t.live;
    if (!['open', 'exit-failed'].includes(L.state) || L.checking) return;
    L.checking = true;
    L.exitReason = reason;
    try {
      if (!demo) await withTimeout(syncKite(true), 2500).catch(() => {}); // never let a slow Kite hold up an exit
    } finally {
      L.checking = false;
    }
    if (!['open', 'exit-failed'].includes(L.state)) return; // closed in Kite meanwhile
    L.state = 'exiting';
    send(t, 'exit', L.entry.side === 'BUY' ? 'SELL' : 'BUY', remaining(t));
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // Part (or all) of a position was closed in Kite, at price.
  function closedInKite(t, qty, price, estimated) {
    const L = t.live;
    L.exitedQty = (L.exitedQty || 0) + qty;
    L.exitValue = (L.exitValue || 0) + qty * price;
    L.exitOrders = (L.exitOrders || 0) + 1;
    L.closedInKite = (L.closedInKite || 0) + qty;
    if (estimated) L.kitePriceEstimated = true;
    if (remaining(t) <= 0) {
      L.exitReason = L.exitReason || 'kite';
      finish(t);
    } else changed(t);
    note(
      `${t.i} (${L.symbol}): ${qty} closed in Kite at ${r2(price)}${estimated ? ' (estimated: no closing order found)' : ''}. This app won't send an exit for it.`,
      'warn',
    );
  }

  // Where Kite's closing orders for a symbol filled: average of the latest complete orders on the closing side that
  // this app didn't send, placed after since (null if none).
  async function kiteClosePrice(auth, symbol, product, side, qty, since) {
    const list = await api.orders(auth);
    const at = (o) => Date.parse(String(o.order_timestamp || '').replace(' ', 'T') + '+05:30');
    const fills = list
      .filter(
        (o) =>
          o.tradingsymbol === symbol &&
          o.product === product &&
          o.transaction_type === side &&
          o.status === 'COMPLETE' &&
          !ours.has(o.order_id) &&
          !(at(o) < since - 1000),
      )
      .sort((a, b) => at(b) - at(a));
    let got = 0;
    let value = 0;
    for (const o of fills) {
      const take = Math.min(o.filled_quantity, qty - got);
      got += take;
      value += take * o.average_price;
      if (got >= qty) break;
    }
    return got ? value / got : null;
  }

  // Compare this app's open positions with Kite's. Whatever Kite no longer holds was closed there. Unless now is set
  // (just before an exit), a shortfall must be seen on two reads 3 s apart, as Kite's positions can lag a fill.
  async function reconcile(raw, nowCheck) {
    const auth = getAuth();
    const net = new Map(raw.map((p) => [`${p.tradingsymbol}|${p.product}`, p.quantity]));
    const groups = new Map();
    for (const t of active.values()) {
      const L = t.live;
      if (!['open', 'exit-failed'].includes(L.state) || L.entry?.filled <= 0 || now() - (L.entry.doneAt || now()) < 5000) continue;
      const k = `${L.symbol}|${L.product}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    for (const [k, list] of groups) {
      const dir = list[0].live.entry.side === 'BUY' ? 1 : -1;
      if (list.some((t) => (t.live.entry.side === 'BUY' ? 1 : -1) !== dir)) continue; // long and short together: leave it
      const held = list.reduce((a, t) => a + remaining(t), 0);
      const kite = Math.max(0, (net.get(k) || 0) * dir);
      let missing = held - kite;
      if (missing <= 0) {
        suspect.delete(k);
        continue;
      }
      if (!nowCheck) {
        if (!suspect.has(k)) suspect.set(k, now());
        if (now() - suspect.get(k) < 3000) continue;
      }
      suspect.delete(k);
      list.sort((a, b) => a.at - b.at);
      const L0 = list[0].live;
      let price = null;
      try {
        price = await kiteClosePrice(auth, L0.symbol, L0.product, dir > 0 ? 'SELL' : 'BUY', missing, list[0].live.entry.doneAt || list[0].at);
      } catch (e) {
        note(`Kite order book: ${e.message}`, 'error');
      }
      const p = raw.find((x) => `${x.tradingsymbol}|${x.product}` === k);
      const estimate = L0.mark ?? (p?.last_price || null) ?? L0.entry.avg;
      for (const t of list) {
        if (missing <= 0) break;
        const take = Math.min(remaining(t), missing);
        missing -= take;
        closedInKite(t, take, price ?? estimate, price == null);
      }
    }
  }

  // Read Kite's positions and reconcile (now: just before an exit, no second read needed).
  async function syncKite(nowCheck = false) {
    const raw = await refreshPositions();
    if (raw) await reconcile(raw, nowCheck);
  }

  async function pollPending() {
    if (polling || demo) return;
    polling = true;
    try {
      const auth = getAuth();
      for (const t of active.values()) {
        for (const which of ['entry', 'exit']) {
          const leg = t.live[which];
          if (!leg?.id || TERMINAL.has(leg.status) || now() - leg.at < 10_000) continue;
          try {
            await refreshLeg(auth, leg);
            settle(t, which);
          } catch (e) {
            leg.msg = 'status check failed: ' + e.message;
          }
        }
      }
    } finally {
      polling = false;
    }
  }

  // Kite's positions (the raw list, also kept for the screen); one request at a time.
  function refreshPositions() {
    const auth = getAuth();
    if (demo || !auth) return Promise.resolve(null);
    if (!pos.busy) pos.busy = readPositions(auth).finally(() => (pos.busy = null));
    return pos.busy;
  }
  async function readPositions(auth) {
    try {
      const list = await api.positions(auth);
      pos.raw = list;
      pos.list = list
        .filter((p) => p.exchange === 'NFO' && /^NIFTY\d/.test(p.tradingsymbol))
        .map((p) => ({ symbol: p.tradingsymbol, qty: p.quantity, avg: r2(p.average_price), ltp: r2(p.last_price), pnl: r2(p.pnl), product: p.product }));
      pos.error = null;
      return list;
    } catch (e) {
      pos.error = e.message;
      return null;
    } finally {
      pos.at = now();
    }
  }

  // The live P&L of open positions: marked at Kite's bid (long) or ask (short), else the LTP, else Kite's position LTP.
  function markOpen() {
    for (const t of active.values()) {
      const L = t.live;
      if (!['open', 'exit-failed', 'exiting'].includes(L.state) || !L.entry?.avg) continue;
      const dir = L.entry.side === 'BUY' ? 1 : -1;
      const q = getQuote(t.i);
      const p = pos.raw?.find((x) => x.tradingsymbol === L.symbol);
      const m = (dir > 0 ? q?.bid : q?.ask) || q?.ltp || p?.last_price || null;
      if (m == null) continue;
      L.mark = r2(m);
      L.upnl = r2((m - L.entry.avg) * dir * remaining(t));
    }
  }

  async function testBuy(type) {
    const atm = getTestSymbol(type);
    const qty = getLot();
    const out = { kind: type, symbol: atm?.symbol || null, qty, at: now() };
    try {
      if (!atm?.symbol) throw new Error('No ATM option yet: wait for the watch list to load');
      const why = authOk(getAuth());
      if (why) throw new Error(why);
      const t = { id: `TEST-${now()}`, i: atm.id, side: 'BUY', at: now(), test: true };
      t.live = { state: 'entering', symbol: atm.symbol, product: getConfig().product, lots: 1, qty };
      tests.unshift(t);
      if (tests.length > 10) tests.length = 10;
      active.set(t.id, t);
      await send(t, 'entry', 'BUY', qty);
      const e = t.live.entry;
      Object.assign(out, {
        ok: e.status !== 'ERROR',
        id: e.id,
        status: e.status,
        msg: e.msg,
        avg: e.avg,
        filled: e.filled,
        error: e.status === 'ERROR' ? e.msg : undefined,
      });
      note(
        `Test buy ${atm.symbol} ${qty} at market: ${String(e.status).toLowerCase()}${e.avg ? ' at ' + e.avg : ''}${e.msg ? ' — ' + e.msg : ''}.${e.filled ? ' Close it with Square off all (or it is closed at 15:15).' : ''}`,
        e.filled ? 'warn' : 'error',
      );
    } catch (err) {
      Object.assign(out, { ok: false, error: err.message });
      note(`Test buy failed: ${err.message}`, 'error');
    }
    return out;
  }

  return {
    // Trades left from before a restart: entries count towards today's limit; open ones are flagged.
    seed(trades) {
      for (const t of trades) {
        if (t.live?.entry && istDate(t.at) === day) entries++;
        if (t.live && openStates.has(t.live.state)) {
          t.live.state = 'unknown';
          note(`${t.i}: a live position (${t.live.symbol}) was open when the server stopped. Check it in Kite.`, 'error');
        }
      }
    },
    // A paper trade opened: send the entry if live trading is on and within its limits.
    onOpen(t) {
      if (!on) return;
      const c = getConfig();
      const skip = (why) => {
        t.live = { state: 'skipped', why };
        changed(t);
      };
      const at = now();
      if (c.kiteOnly && t.entryFeed !== 'k') return skip('Upstox moved first: not a Kite trade (Kite trades only is on)');
      if (!demo && (!isMarketOpen(at) || istTime(at) >= ENTRY_UNTIL)) return skip('outside entry hours (09:15–15:10)');
      if (entries >= c.maxEntries) return skip(`daily limit of ${c.maxEntries} entries reached`);
      if (openCount() >= c.maxOpen) return skip(`${c.maxOpen} position(s) already open`);
      const symbol = getSymbol(t.i);
      if (!symbol) return skip('no Kite trading symbol for this option');
      entries++;
      if (!c.budget) {
        t.live = { state: 'entering', symbol, product: c.product, lots: c.lots, qty: c.lots * getLot() };
        active.set(t.id, t);
        send(t, 'entry', t.side, t.live.qty);
        return;
      }
      // sized by budget: the funds right now and the cost of a lot decide how many lots
      t.live = { state: 'entering', symbol, product: c.product, sizing: true };
      active.set(t.id, t);
      (async () => {
        try {
          const f = await withTimeout(refreshFunds(), 3000);
          if (f?.available == null) throw new Error(`Kite funds unavailable${fund.error ? ': ' + fund.error : ''}`);
          const cost = await withTimeout(perLot(t, symbol, t.side, c.product), 3000);
          if (!cost) throw new Error('no price to size the order with');
          const lots = lotsFor(f.available, cost, c);
          Object.assign(t.live, { sizing: false, budget: { available: f.available, pct: c.budgetPct, perLot: r2(cost), lots } });
          if (lots < 1) throw new Error(`₹${f.available} available × ${c.budgetPct}% doesn't cover one lot (₹${r2(cost)})`);
          t.live.lots = lots;
          t.live.qty = lots * getLot();
          send(t, 'entry', t.side, t.live.qty);
        } catch (e) {
          entries--;
          active.delete(t.id);
          t.live = { state: 'skipped', why: 'budget: ' + e.message, budget: t.live.budget };
          note(`${t.i}: not sent, ${t.live.why}`, 'error');
          changed(t);
        }
      })();
    },
    // A paper trade closed (target, stop, max hold or 15:25): close its live position.
    onClose(t, reason) {
      const L = t.live;
      if (!L) return;
      if (L.state === 'entering') L.wantExit = reason;
      else if (L.state === 'open') exit(t, reason);
    },
    tick() {
      const at = now();
      const d = istDate(at);
      if (d !== day) {
        day = d;
        entries = 0;
      }
      const auth = getAuth();
      if (on && !demo && (!auth || auth.userId !== account)) {
        on = false;
        note('Live trading switched off: the Kite login changed or ended.', 'error');
      }
      if (istTime(at) >= SQUARE_OFF_AT && istTime(at) < '15:30:00') {
        for (const t of active.values()) if (t.live.state === 'open') exit(t, 'eod');
      }
      pollPending();
      markOpen();
      if (!demo && auth && !authOk(auth) && at - fund.at > 30_000) refreshFunds();
      // Kite's positions: every 5 s while this app holds any (to notice what is closed in Kite), else every 15 s
      const every = active.size ? 5000 : 15_000;
      if (!demo && auth && (on || active.size) && at - pos.at > every) syncKite().catch((e) => note(`Kite positions: ${e.message}`, 'error'));
    },
    // Close one live position (the Close button), now, at market.
    closeOne(id) {
      const t = active.get(id);
      if (!t || !['open', 'exit-failed'].includes(t.live.state)) return false;
      note(`${t.i} (${t.live.symbol}): closing at market.`);
      exit(t, 'manual');
      return true;
    },
    setOn(want) {
      if (!want) {
        if (on) note('Live trading switched off. Positions already open are still closed by their paper trade.');
        on = false;
        return;
      }
      const auth = getAuth();
      const why = authOk(auth);
      if (why) throw new Error(why);
      on = true;
      since = now();
      account = demo ? 'DEMO' : auth.userId;
      note(`Live trading switched ON for ${account}: ${getConfig().lots} lot(s) at market, ${getConfig().product}.`, 'warn');
      refreshPositions();
    },
    // Close every live position this app opened, now, at market.
    squareOff() {
      let n = 0;
      for (const t of active.values()) {
        if (['open', 'exit-failed'].includes(t.live.state)) {
          exit(t, 'manual');
          n++;
        }
      }
      note(n ? `Square off: closing ${n} position(s) at market.` : 'Square off: no open position.');
      return n;
    },
    // The test button. kind 'CE' / 'PE': BUY 1 lot of that ATM option at MARKET, tracked like a live position.
    // kind 'check': a 1-lot LIMIT BUY at ₹0.05 of the ATM call, cancelled at once if it rests.
    async testOrder(kind = 'CE') {
      if (kind === 'CE' || kind === 'PE') return testBuy(kind);
      const symbol = getTestSymbol('CE')?.symbol;
      const qty = getLot();
      const out = { symbol, qty, price: 0.05, at: now() };
      try {
        if (!symbol) throw new Error('No option to test with yet: wait for the watch list to load');
        if (demo) {
          Object.assign(out, { id: `DEMO-TEST-${now()}`, status: 'CANCELLED', msg: 'demo mode: simulated, nothing sent', cancelled: true });
        } else {
          const auth = getAuth();
          const why = authOk(auth);
          if (why) throw new Error(why);
          out.id = await api.placeOrder(auth, {
            tradingsymbol: symbol,
            transaction_type: 'BUY',
            quantity: qty,
            order_type: 'LIMIT',
            price: 0.05,
            product: getConfig().product,
            tag: TAG,
          });
          const leg = { id: out.id, status: 'PLACED' };
          for (let i = 0; i < 6 && !TERMINAL.has(leg.status); i++) {
            await sleep(pollMs);
            await refreshLeg(auth, leg).catch(() => {});
          }
          if (!TERMINAL.has(leg.status)) {
            await api.cancelOrder(auth, out.id);
            out.cancelled = true;
            await sleep(pollMs);
            await refreshLeg(auth, leg).catch(() => {});
          }
          Object.assign(out, { status: leg.status, msg: leg.msg });
        }
        out.ok = true;
        note(
          `Test order ${out.id} (${symbol} BUY ${qty} @ ₹0.05): reached Kite, ${String(out.status).toLowerCase()}${out.msg ? ' — ' + out.msg : ''}${out.cancelled ? ', cancelled' : ''}.`,
        );
      } catch (e) {
        out.ok = false;
        out.error = e.message;
        note(`Test order failed: ${e.message}`, 'error');
      }
      return out;
    },
    refreshPositions,
    refreshFunds,
    state() {
      const auth = getAuth();
      return {
        on,
        since,
        account,
        demo,
        mode: demo ? 'demo' : auth?.mode || null,
        allowed: !authOk(auth),
        why: authOk(auth),
        entries,
        open: openCount(),
        funds: { available: fund.available, cash: fund.cash, used: fund.used, at: fund.at || null, error: fund.error },
        // what the funds buy now: 1 lot of the ATM call / put at the ask
        afford: ['CE', 'PE'].map((type) => {
          const a = getTestSymbol(type);
          const q = a && getQuote(a.id);
          const px = q?.ask || q?.ltp || null;
          const cost = px ? px * getLot() : null;
          return {
            type,
            id: a?.id || null,
            symbol: a?.symbol || null,
            price: r2(px),
            perLot: r2(cost),
            lots: cost ? lotsFor(fund.available, cost, getConfig()) : null,
          };
        }),
        openPnl: r2([...active.values()].reduce((a, t) => a + (t.live.upnl || 0), 0)),
        events: events.slice(0, 12),
        tests: tests.map((t) => ({ id: t.id, i: t.i, at: t.at, ...t.live })),
        positions: pos.list,
        positionsAt: pos.at || null,
        positionsError: pos.error,
      };
    },
  };
}

function summarizeLive(trades) {
  const done = trades.filter((t) => t.live?.state === 'closed');
  const sum = (f) => r2(done.reduce((a, t) => a + (f(t) || 0), 0));
  return {
    sent: trades.filter((t) => t.live?.entry).length,
    closed: done.length,
    failed: trades.filter((t) => ['failed', 'exit-failed', 'unknown'].includes(t.live?.state)).length,
    gross: sum((t) => t.live.gross),
    costs: sum((t) => t.live.costs),
    net: sum((t) => t.live.net),
    open: trades.filter((t) => ['open', 'exiting', 'exit-failed'].includes(t.live?.state)).length,
    openPnl: r2(trades.reduce((a, t) => a + (['open', 'exiting', 'exit-failed'].includes(t.live?.state) ? t.live.upnl || 0 : 0), 0)),
  };
}

module.exports = { createLiveTrader, cleanLive, summarizeLive, LIVE_DEFAULTS };
