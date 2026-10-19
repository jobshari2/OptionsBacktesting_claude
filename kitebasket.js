// Orders from Live Ideas: the legs of a trade idea sent to Zerodha Kite as one basket. Real orders, real money.
// Only on a click on the screen, after its confirmation dialog (the request must say `confirmed: true`).
// How a basket is sent:
//   - LIMIT orders by default, at the price shown on the screen moved `buffer` points towards a fill (a bought leg a
//     little higher, a sold leg a little lower) and rounded to the 0.05 tick, so a quote that moved a tick still fills;
//     MARKET orders (fill at once at the best price available, which can be worse than the one shown) only when the
//     request says `orderType: 'MARKET'`
//   - the BUY legs go first and the SELL legs only when every BUY leg is filled: the bought wings are in place before
//     anything is sold, so the short legs are never uncovered and the margin is hedged. A BUY leg that is not filled
//     within the wait is cancelled and no SELL leg is sent. A basket with no BUY leg (an uncovered short) is refused.
//   - a SELL leg that does not fill in time is cancelled too, and the basket is reported as partial: the legs bought
//     stay open in Kite and have to be managed there
// Safety, as in the Feeds live trader (feedlive.js): needs a Kite login; an enctoken web session (unofficial) only with
// KITE_ORDERS_ENCTOKEN=1; only in market hours and before 15:25 IST; at most MAX_LEGS legs; no order above Nifty's freeze
// quantity; one basket at a time; the same basket is not sent twice within 15 s. Every basket is logged (logs/).
// In demo mode nothing is sent: the fills are simulated.
const fs = require('fs');
const path = require('path');
const KiteApi = require('./lib/kite');
const { istTime } = require('./lib/time');

const TAG = 'ideas';
const TERMINAL = new Set(['COMPLETE', 'REJECTED', 'CANCELLED', 'ERROR']);
const ENTRY_UNTIL = '15:25:00';
const MAX_LEGS = 8;
const MAX_QTY = 1800; // Nifty's freeze quantity for one order: above it Kite rejects the order
const TICK = 0.05;
const r2 = (n) => Math.round(n * 100) / 100;
const tickUp = (x) => r2(Math.ceil(x / TICK - 1e-9) * TICK);
const tickDown = (x) => Math.max(TICK, r2(Math.floor(x / TICK + 1e-9) * TICK));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// getAuth() -> the Kite login; symbolFor(expiry, strike, type) -> Kite tradingsymbol (async); getLot() -> Nifty lot size.
function createKiteBasket({
  getAuth,
  symbolFor,
  getLot,
  allowEnctoken = false,
  demo = false,
  isMarketOpen = () => true,
  now = Date.now,
  api = KiteApi,
  marketProtection = null,
  pollMs = 1000,
  waitMs = 20_000,
  logFile = null,
  logError = () => {},
}) {
  let busy = false;
  let lastSig = null;
  let lastAt = 0;

  // Why orders can't go out right now, or null.
  function gate() {
    if (demo) return null;
    const auth = getAuth();
    if (!auth) return 'Not logged in to Kite';
    if (auth.mode === 'enctoken' && !allowEnctoken)
      return 'Orders need a Kite Connect login: the enctoken web session is unofficial. Set KITE_ORDERS_ENCTOKEN=1 in .env and restart the server to allow orders through it anyway.';
    if (!isMarketOpen(now())) return 'The market is closed';
    if (istTime(now()) >= ENTRY_UNTIL) return 'No new orders after 15:25 IST';
    return null;
  }

  // Validates the request and resolves each leg to a Kite tradingsymbol, quantity and limit price.
  async function plan(req) {
    const legs = Array.isArray(req?.legs) ? req.legs : [];
    if (!legs.length || legs.length > MAX_LEGS) throw new Error(`A basket has 1 to ${MAX_LEGS} legs`);
    const product = req.product === 'MIS' ? 'MIS' : 'NRML';
    const orderType = req.orderType === 'MARKET' ? 'MARKET' : 'LIMIT';
    const buffer = Math.min(5, Math.max(0, Number(req.buffer ?? 0.5) || 0));
    const lot = getLot();
    if (!(lot > 0)) throw new Error('The Nifty lot size is not known yet');
    const out = [];
    for (const l of legs) {
      const action = l.action === 'B' ? 'BUY' : l.action === 'S' ? 'SELL' : null;
      const type = l.type === 'CE' || l.type === 'PE' ? l.type : null;
      const strike = Number(l.strike);
      const lots = Math.round(Number(l.lots));
      const price = Number(l.price);
      if (!action || !type || !(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry || '') || !(lots >= 1) || !(price > 0))
        throw new Error('A leg of the basket is incomplete');
      const qty = lots * lot;
      if (qty > MAX_QTY) throw new Error(`${lots} lots (${qty} qty) is above Nifty's freeze quantity of ${MAX_QTY} for one order: use fewer lots`);
      const symbol = (await symbolFor(l.expiry, strike, type)) || (demo ? `NIFTY-${l.expiry}-${strike}${type}` : null);
      if (!symbol) throw new Error(`No Kite instrument found for the ${strike} ${type} of ${l.expiry}`);
      out.push({
        action,
        type,
        strike,
        expiry: l.expiry,
        lots,
        qty,
        price,
        limit: orderType === 'MARKET' ? null : action === 'BUY' ? tickUp(price + buffer) : tickDown(price - buffer),
        symbol,
      });
    }
    return { legs: out, product, orderType, buffer, lot };
  }

  // What would be sent, and why it can't be yet: for the confirmation dialog. Sends nothing.
  async function preview(req) {
    const P = await plan(req);
    let funds = null;
    const auth = getAuth();
    if (!demo && auth) {
      try {
        const f = await api.funds(auth);
        funds = { available: f?.net ?? null };
      } catch (e) {
        funds = { error: e.message };
      }
    }
    // what the whole basket ties up (Kite's own calculator, hedges counted) and so per lot of the strategy
    let margin = null;
    if (!demo && auth) {
      try {
        const m = await api.basketMargin(
          auth,
          P.legs.map((l) => ({
            tradingsymbol: l.symbol,
            transaction_type: l.action,
            quantity: l.qty,
            product: P.product,
            order_type: P.orderType,
            price: l.limit ?? 0,
          })),
        );
        const total = m?.final?.total ?? m?.initial?.total ?? null;
        const k = Math.max(1, Math.round(Number(req.strategyLots) || 1));
        margin = total != null ? { total, perLot: total / k, source: 'Kite' } : { error: 'Kite returned no margin' };
      } catch (e) {
        margin = { error: e.message };
      }
    }
    return { ...P, gate: gate(), user: demo ? 'DEMO' : auth?.userId || null, funds, margin, demo };
  }

  async function refresh(auth, leg) {
    const s = await api.orderStatus(auth, leg.id);
    leg.status = s.status;
    leg.avg = s.average_price ? r2(s.average_price) : leg.avg;
    leg.filled = s.filled_quantity ?? (s.status === 'COMPLETE' ? leg.qty : leg.filled);
    leg.msg = s.status_message || leg.msg;
  }

  // Sends one leg and follows it until Kite reports it filled, rejected or cancelled, or the wait is over (then it is cancelled).
  async function send(auth, P, leg) {
    try {
      if (demo) {
        await sleep(150);
        leg.id = `DEMO-${now()}`;
        leg.status = 'COMPLETE';
        leg.filled = leg.qty;
        leg.avg = leg.limit ?? leg.price;
        return;
      }
      leg.id = await api.placeOrder(auth, {
        tradingsymbol: leg.symbol,
        transaction_type: leg.action,
        quantity: leg.qty,
        order_type: P.orderType,
        price: P.orderType === 'LIMIT' ? leg.limit : null, // a MARKET order has no price
        market_protection: P.orderType === 'MARKET' ? marketProtection : null,
        product: P.product,
        tag: TAG,
      });
      leg.status = 'PLACED';
      for (let i = 0; i < Math.max(1, Math.ceil(waitMs / pollMs)) && !TERMINAL.has(leg.status); i++) {
        await sleep(pollMs);
        try {
          await refresh(auth, leg);
        } catch (e) {
          leg.msg = 'status check failed: ' + e.message;
        }
      }
      if (!TERMINAL.has(leg.status)) {
        leg.msg = 'not filled in time: cancelled';
        try {
          await api.cancelOrder(auth, leg.id);
          await sleep(pollMs);
          await refresh(auth, leg);
        } catch (e) {
          leg.msg = `not filled in time, and cancelling failed (${e.message}): check Kite`;
        }
      }
    } catch (e) {
      leg.status = 'ERROR';
      leg.msg = e.message;
    }
  }

  async function place(req) {
    if (req?.confirmed !== true) throw new Error('The order basket was not confirmed');
    const why = gate();
    if (why) throw new Error(why);
    if (busy) throw new Error('Another basket is being placed: wait for it to finish');
    const P = await plan(req);
    if (!P.legs.some((l) => l.action === 'BUY')) throw new Error('A basket with no BUY leg would leave a SELL uncovered: not sent');
    const sig = JSON.stringify([P.orderType, P.legs.map((l) => [l.action, l.symbol, l.qty, l.limit])]);
    if (sig === lastSig && now() - lastAt < 15_000) throw new Error('This same basket was just sent: not sending it twice');
    busy = true;
    lastSig = sig;
    lastAt = now();
    try {
      const auth = getAuth();
      const legs = P.legs.map((l) => ({ ...l, id: null, status: 'PENDING', filled: 0, avg: null, msg: null }));
      const filled = (l) => l.status === 'COMPLETE' && l.filled >= l.qty;
      const buys = legs.filter((l) => l.action === 'BUY');
      const sells = legs.filter((l) => l.action === 'SELL');
      await Promise.all(buys.map((l) => send(auth, P, l)));
      let status = 'done';
      let message = 'Every leg is filled.';
      if (buys.some((l) => !filled(l))) {
        status = 'stopped';
        message = sells.length
          ? 'A BUY leg did not fill, so no SELL leg was sent. Check Kite for anything that did fill.'
          : 'A BUY leg did not fill. Check Kite for anything that did fill.';
        for (const l of sells) {
          l.status = 'NOT SENT';
          l.msg = 'the BUY legs did not all fill';
        }
      } else if (sells.length) {
        await Promise.all(sells.map((l) => send(auth, P, l)));
        if (sells.some((l) => !filled(l))) {
          status = 'partial';
          message = 'A SELL leg did not fill: the legs that did fill are open in Kite and have to be managed there.';
        }
      }
      const result = { ok: status === 'done', status, message, product: P.product, orderType: P.orderType, demo, legs };
      if (logFile) {
        try {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.appendFileSync(logFile, JSON.stringify({ at: now(), user: auth?.userId || null, name: req.name || null, ...result }) + '\n');
        } catch (e) {
          logError('kite-basket-log', e);
        }
      }
      return result;
    } finally {
      busy = false;
    }
  }

  return { gate, plan, preview, place };
}

module.exports = { createKiteBasket, tickUp, tickDown, MAX_QTY, MAX_LEGS };
