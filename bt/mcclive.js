// Trading Ideas › Covered call › Modified covered call › Live trade: a real position followed on the live chain — a
// trade saved from the Builder (Trades › Saved trades) or the paper trade's open series — with the NIFTYBEES bought
// against it. Computes:
//   - the P&L of NIFTYBEES + the options for Nifty moves of 0.3 % … 20 % either way (at expiry, and if the move
//     happened today: Black-Scholes at each strike's implied volatility now)
//   - suggestions: changes to the option legs (rolls, shifts, hedges, closing a side), each priced at the live chain
//     with slippage and charges and tested on the history of Nifty moves over the days left (bt-cache, scaled to
//     today's volatility). Only changes that raise the average result are suggested; the share of past moves in
//     which each one does better is shown, and the ones better in at least 90 % of them are marked.
//   - the backtest study's rules (bt-data/mcc-study.json): which are due on this trade now.
// Nothing here places orders. Shared by server.js (/api/mcc/live*, /api/psc/live*) and test/mcclive.test.js.
// shape: 'mcc' (Modified covered call: call ratio + put 2-3-1, the default), 'psc' (Put spread collar: a sold call
// + a bought put spread) or 'bpc' (Bull put collar: a sold call + a sold put spread): the names in the suggestions, how far the sold put may roll, and when a study rule is due.
const Costs = require('../lib/costs');
const { RATE, b76, b76iv } = require('../lib/pricing');

const MOVES = [0.3, 0.5, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20];
const STEP = 50;
const RELIABLE = 0.9; // share of past moves a suggestion must do better in to be marked
// a suggestion may not make the worst past outcome (options + NIFTYBEES) worse by more than this (₹, or this share of
// it), or than the average it gains
const WORST_TOL = { inr: 5000, share: 0.05 };
// protection: a change that lifts the worst past outcome by at least this (₹, or this share of it), whatever it costs
// on average (shown with that cost, never as raising the result)
const PROTECT = { inr: 5000, share: 0.1 };
const YEAR_MS = 365 * 86400_000;
// A strike a suggestion may enter: traded today (volume > 0), priced, and its bid–ask spread (when quoted) no wider
// than this share of its mid or ₹SPREAD_INR, whichever is larger.
const SPREAD = { share: 0.1, inr: 2 };

const intr = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
const atmOf = (S) => Math.round(S / STEP) * STEP;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const legText = (l) => `${l.side > 0 ? 'B' : 'S'} ${l.lots}× ${l.strike} ${l.type}`;
// What each strategy's structures are called, and where its sold put may go when rolled ('wing': above the lowest
// bought put, the 2-3-1's far wing; 'under': below the bought put, so the put spread stays a debit spread; 'over':
// above the bought put, so it stays a credit spread).
const SHAPES = {
  mcc: {
    name: 'Modified covered call',
    calls: 'call ratio',
    callStruct: 'call ratio spread',
    soldCalls: 'sold calls',
    puts: 'put butterfly',
    soldPutRoll: 'wing',
  },
  psc: { name: 'Put spread collar', calls: 'sold call', callStruct: 'sold call', soldCalls: 'sold call', puts: 'put spread', soldPutRoll: 'under' },
  bpc: { name: 'Bull put collar', calls: 'sold call', callStruct: 'sold call', soldCalls: 'sold call', puts: 'put spread', soldPutRoll: 'over' },
  // NIFTYBEES + options (bt/nbo.js): any legs, so a sold put may roll anywhere (the worst-case guard still applies)
  nbo: { name: 'NIFTYBEES + options', calls: 'call legs', callStruct: 'call legs', soldCalls: 'sold call', puts: 'put legs', soldPutRoll: 'any' },
  // Put back spread (bt/pbs.js): puts only (back spread + flies), searched again on a move
  pbs: { name: 'Put back spread', calls: 'call legs', callStruct: 'call legs', soldCalls: 'sold call', puts: 'puts', soldPutRoll: 'any' },
};
const KINDS = ['mcc', 'psc', 'bpc', 'nbo', 'pbs'];
// The strategy a saved trade's NIFTYBEES (snap.mcc) were entered for: kind 'psc' / 'bpc', else the Modified covered call.
const kindOf = (m) => (KINDS.includes(m?.kind) ? m.kind : 'mcc');
// The strategy of a saved Builder trade: snap.mcc.kind when picked in the Builder ('mcc' / 'psc' / 'bpc'); unmarked
// (saved before the collars existed, or the Builder's selector left alone) a Put spread collar or a Bull put collar when
// its legs are one — open legs, else all of them — and the Modified covered call otherwise. The Builder's selector shows the same (sb-view.js).
function kindOfTrade(t) {
  const m = t?.snap?.mcc;
  if (KINDS.includes(m?.kind)) return m.kind;
  const all = (t?.snap?.legs || []).filter((l) => l.lots > 0);
  const open = all.filter((l) => l.open);
  const legs = (open.length ? open : all).map((l) => ({ type: l.type, strike: l.strike, lots: l.lots, side: l.action === 'B' ? 1 : -1 }));
  if (!legs.length || looksMcc(legs)) return 'mcc';
  return looksPsc(legs) ? 'psc' : looksBpc(legs) ? 'bpc' : looksPbs(legs) ? 'pbs' : 'mcc';
}

// ---------- the position ----------
// { key, src, id, name, lot, expiry, legs: [{ id, type, strike, lots, side, entry }], closed: [{ …, exit, pnl }],
//   realised: { CE, PE }, costs, spotIn, entryDay, bees: { qty, price } | null }

// The NIFTYBEES held against a Builder trade (its snap.mcc, set in the Builder or on the Live trade tab):
// { qty, price, day, exitPx, exitDay, exitAt } or null when no units and price are entered.
function beesOfSnap(snap) {
  const m = snap?.mcc;
  if (!(m?.qty > 0 && m?.price > 0)) return null;
  return { qty: m.qty, price: m.price, day: m.day || null, exitPx: m.exitPx > 0 ? m.exitPx : null, exitDay: m.exitDay || null, exitAt: m.exitAt || null };
}

// A trade saved in the Builder (bt-data/paper-trades.json). Its P&L is before charges, as the Builder shows it.
// A trade whose legs are all closed comes back with no legs (done: true), its expiry from the closed legs.
// kind: the strategy asking ('mcc' / 'psc'): flag is set when the trade is marked as that one in the Builder.
function fromBuilder(t, kind = 'mcc') {
  const lot = t.summary?.lot || 65;
  const expOf = (l) => l.expiry || t.snap.liveExpiry || t.snap.expiry;
  const side = (l) => (l.action === 'B' ? 1 : -1);
  const all = t.snap.legs || [];
  const legs = all
    .filter((l) => l.open && l.lots > 0)
    .map((l) => ({ id: l.id, type: l.type, strike: l.strike, lots: l.lots, side: side(l), entry: l.entryPx, expiry: expOf(l) }));
  const closed = all
    .filter((l) => !l.open && l.exitPx != null)
    .map((l) => ({
      id: l.id,
      type: l.type,
      strike: l.strike,
      lots: l.lots,
      side: side(l),
      entry: l.entryPx,
      exit: l.exitPx,
      exitDay: l.exitDay || null,
      exitAt: l.exitClock || (typeof l.exitAt === 'string' ? l.exitAt.replace(/^Lives*/, '') : null),
      expiry: expOf(l),
      pnl: (l.exitPx - l.entryPx) * side(l) * l.lots * lot,
    }));
  const count = new Map();
  for (const l of legs.length ? legs : closed) count.set(l.expiry, (count.get(l.expiry) || 0) + 1);
  const expiry = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || t.snap.liveExpiry || null;
  const spots = all.filter((l) => (legs.length ? l.open : true) && l.spotIn > 0).map((l) => l.spotIn);
  return {
    key: 'builder:' + t.id,
    src: 'builder',
    id: t.id,
    name: t.name,
    lot,
    expiry,
    legs: legs.filter((l) => l.expiry === expiry),
    otherExpiry: legs.filter((l) => l.expiry !== expiry).length,
    others: legs.filter((l) => l.expiry !== expiry), // open legs of other expiries (closed with the trade too)
    done: !legs.length,
    flag: Boolean(t.snap.mcc?.on) && kindOfTrade(t) === kind, // marked as this strategy in the Builder (NIFTYBEES held)
    closedAt: t.closedAt || null,
    closeBatch: t.closeBatch || null, // set when closed from the Live trade tab (closeSaved), for its undo
    closed,
    realised: {
      CE: sum(
        closed.filter((c) => c.type === 'CE'),
        (c) => c.pnl,
      ),
      PE: sum(
        closed.filter((c) => c.type === 'PE'),
        (c) => c.pnl,
      ),
    },
    costs: 0,
    spotIn: spots.length ? sum(spots, (x) => x) / spots.length : t.snap.spotEntry || t.summary?.spot || null,
    entryDay:
      all
        .map((l) => l.entryDay)
        .filter(Boolean)
        .sort()[0] || null,
    live: t.snap.src === 'live',
    bees: beesOfSnap(t.snap),
  };
}

// ---------- closing a saved trade ----------
// Every open leg of a saved Builder trade closed at the prices given (px: { [leg id]: price }), and the NIFTYBEES held
// sold at beesPx, at time ts — the way the Builder records an exit (exitPx / exitAt / exitDay / exitMin / exitClock,
// a log line per leg). Returns a new trade object (the summary updated) for bt-data/paper-trades.json. The legs closed
// and the NIFTYBEES exit carry closeBatch = ts, so reopenSaved can undo exactly this close.
const IST = 5.5 * 3600_000;
const istDay = (ts) => new Date(ts + IST).toISOString().slice(0, 10);
const istHms = (ts) => new Date(ts + IST).toISOString().slice(11, 19);
const goodPx = (v) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0;
function closeSaved(t, { px = {}, beesPx = null, ts = Date.now() } = {}) {
  const out = JSON.parse(JSON.stringify(t));
  const snap = out.snap;
  const lot = out.summary?.lot || 65;
  const open = (snap.legs || []).filter((l) => l.open && l.lots > 0);
  if (!open.length) throw new Error('The trade has no open legs to close');
  for (const l of open) if (!goodPx(px[l.id])) throw new Error(`Exit price missing for ${l.strike} ${l.type}`);
  const bees = beesOfSnap(snap);
  if (bees && !bees.exitPx && !(Number(beesPx) > 0)) throw new Error('NIFTYBEES sell price missing');
  const hms = istHms(ts);
  const [h, m] = hms.split(':').map(Number);
  const at = 'Live ' + hms;
  const day = istDay(ts);
  const sgn = (l) => (l.action === 'B' ? 1 : -1);
  snap.log ||= [];
  for (const l of open) {
    const p = Number(px[l.id]);
    Object.assign(l, {
      open: false,
      exitPx: p,
      exitAt: at,
      exitDay: day,
      exitMin: Math.max(0, Math.min(374, h * 60 + m - 555)),
      exitClock: hms.slice(0, 5),
      closeBatch: ts,
    });
    const pnl = sgn(l) * (p - l.entryPx) * l.lots * lot;
    snap.log.unshift({
      at,
      text: `Close ${l.lots} × ${l.strike} ${l.type} (${l.action === 'B' ? 'long' : 'short'}) @ ${p.toFixed(2)} · ${pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')} — whole trade closed (Trading Ideas › Live trade)`,
    });
  }
  if (bees && !bees.exitPx) {
    Object.assign(snap.mcc, { exitPx: Number(beesPx), exitDay: day, exitAt: hms.slice(0, 5), exitBatch: ts });
    const b = bees.qty * (Number(beesPx) - bees.price);
    snap.log.unshift({
      at,
      text: `Sell ${bees.qty} NIFTYBEES @ ${Number(beesPx).toFixed(2)} (bought ${bees.price.toFixed(2)}) · ${b >= 0 ? '+' : '−'}₹${Math.abs(Math.round(b)).toLocaleString('en-IN')}`,
    });
  }
  snap.log = snap.log.slice(0, 200);
  out.summary = summaryOf(out, at);
  out.savedAt = ts;
  out.closedAt = ts;
  out.closeBatch = ts;
  return out;
}
// Undoes the last closeSaved: its legs open again (their exits removed), the NIFTYBEES exit it recorded removed.
function reopenSaved(t, { ts = Date.now() } = {}) {
  if (!t.closeBatch) throw new Error('This trade was not closed from the Live trade tab: re-open its legs in the Builder');
  const out = JSON.parse(JSON.stringify(t));
  const snap = out.snap;
  let n = 0;
  for (const l of snap.legs || [])
    if (l.closeBatch === t.closeBatch) {
      for (const k of ['exitPx', 'exitAt', 'exitDay', 'exitMin', 'exitClock', 'closeBatch']) delete l[k];
      l.open = true;
      n++;
    }
  if (snap.mcc?.exitBatch === t.closeBatch) for (const k of ['exitPx', 'exitDay', 'exitAt', 'exitBatch']) delete snap.mcc[k];
  const at = 'Live ' + istHms(ts);
  snap.log = [{ at, text: `Undo the close of the whole trade: ${n} leg${n === 1 ? '' : 's'} open again` }, ...(snap.log || [])].slice(0, 200);
  delete out.closedAt;
  delete out.closeBatch;
  out.summary = summaryOf(out, at);
  out.savedAt = ts;
  return out;
}
// The Trades list's summary of a saved trade after a close / undo here (open legs at their entry: the Builder prices
// them again when it next saves the trade).
function summaryOf(t, at) {
  const lot = t.summary?.lot || 65;
  const legs = t.snap.legs || [];
  const open = legs.filter((l) => l.open);
  const realised = sum(
    legs.filter((l) => !l.open && l.exitPx != null),
    (l) => (l.action === 'B' ? 1 : -1) * (l.exitPx - l.entryPx) * l.lots * lot,
  );
  const b = beesOfSnap(t.snap);
  return {
    ...t.summary,
    legs: open.map((l) => `${l.action === 'B' ? 'B' : 'S'} ${l.lots}× ${l.strike} ${l.type}`).join(', '),
    open: open.length,
    closed: legs.length - open.length,
    at,
    realised: Math.round(realised),
    openPnl: 0,
    total: Math.round(realised),
    bees: b?.exitPx ? Math.round(b.qty * (b.exitPx - b.price)) : undefined,
  };
}

// A paper trade's open series (mccpaper.js: the Modified covered call's or the Put spread collar's); its P&L is after
// costs, as the paper counts it. name: the strategy's.
function fromPaper(P, name = SHAPES.mcc.name) {
  const c = P?.cycle;
  if (!c?.legs?.length) return null;
  const lot = P.params.lotSize;
  const closed = (c.closed || []).map((x) => ({ ...x, exitDay: x.exitAt?.day || null, exitAt: x.exitAt?.time || null, expiry: c.expiry }));
  return {
    key: 'paper',
    src: 'paper',
    id: 'paper',
    name: `${name} paper trade · ${c.expiry}`,
    lot,
    expiry: c.expiry,
    legs: c.legs.map((l) => ({ id: l.id, type: l.type, strike: l.strike, lots: l.lots, side: l.side, entry: l.entry, expiry: c.expiry })),
    otherExpiry: 0,
    closed,
    realised: {
      CE: sum(
        closed.filter((x) => x.type === 'CE'),
        (x) => x.pnl,
      ),
      PE: sum(
        closed.filter((x) => x.type === 'PE'),
        (x) => x.pnl,
      ),
    },
    costs: c.costsBy || { CE: 0, PE: 0 },
    spotIn: c.spot0,
    entryDay: c.entry?.day || null,
    live: true,
    bees: P.etfOnce?.qty ? { qty: P.etfOnce.qty, price: c.etf.onceFrom } : null,
  };
}

// A call ratio spread (more calls sold than bought) and a put structure with both bought and sold puts.
function looksMcc(legs) {
  const lots = (t, s) =>
    sum(
      legs.filter((l) => l.type === t && l.side === s),
      (l) => l.lots,
    );
  return lots('CE', 1) > 0 && lots('CE', -1) > lots('CE', 1) && lots('PE', 1) > 0 && lots('PE', -1) > 0;
}
// A sold call with no bought call, and a put spread: puts bought above the puts sold, as many bought as sold.
function looksPsc(legs) {
  const of = (t, s) => legs.filter((l) => l.type === t && l.side === s);
  const lots = (a) => sum(a, (l) => l.lots);
  const [cs, cb, pb, ps] = [of('CE', -1), of('CE', 1), of('PE', 1), of('PE', -1)];
  return (
    lots(cs) > 0 &&
    !cb.length &&
    lots(pb) > 0 &&
    lots(ps) > 0 &&
    lots(pb) === lots(ps) &&
    Math.min(...pb.map((l) => l.strike)) > Math.max(...ps.map((l) => l.strike))
  );
}
// A sold call with no bought call, and a bull put spread: puts sold above the puts bought, as many bought as sold.
// A Put back spread (bt/pbs.js): puts only, some sold, more bought than sold (the back spread's extra put; its flies
// add as many bought as sold).
function looksPbs(legs) {
  const ls = (legs || []).filter((l) => l.lots > 0);
  if (!ls.length || ls.some((l) => l.type !== 'PE')) return false;
  const sold = sum(ls.filter((l) => l.side < 0), (l) => l.lots);
  const bought = sum(ls.filter((l) => l.side > 0), (l) => l.lots);
  return sold > 0 && bought > sold;
}
function looksBpc(legs) {
  const of = (t, s) => legs.filter((l) => l.type === t && l.side === s);
  const lots = (a) => sum(a, (l) => l.lots);
  const [cs, cb, pb, ps] = [of('CE', -1), of('CE', 1), of('PE', 1), of('PE', -1)];
  return (
    lots(cs) > 0 &&
    !cb.length &&
    lots(pb) > 0 &&
    lots(ps) > 0 &&
    lots(pb) === lots(ps) &&
    Math.min(...ps.map((l) => l.strike)) > Math.max(...pb.map((l) => l.strike))
  );
}

// ---------- prices ----------
// Years to the expiry's close (15:30 IST).
const yearsTo = (expiry, now = Date.now()) => Math.max(0, (Date.parse(expiry + 'T10:00:00Z') - now) / YEAR_MS);

// What an option is worth now: { px, how }: its LTP, as it is (never the bid / ask mid, never moved inside the quote).
// how: 'ltp' | null (no price).
function markOf(o) {
  const ltp = o?.ltp > 0 ? o.ltp : null;
  return { px: ltp, how: ltp ? 'ltp' : null };
}

// The chain's prices and implied volatilities: { spot, F, atmIv, px(type, K), how(type, K), iv(type, K), strikes(type) }.
// Every option is valued at its LTP (markOf); quote() keeps the LTP with the bid / ask. The
// forward comes from put-call parity at the strike nearest the spot; a strike's volatility is its own, else the
// out-of-the-money side's at that strike, else the nearest strike's.
function market(chain, T) {
  const rows = (chain?.rows || []).filter((r) => r.strike > 0);
  const S = chain?.spot;
  const df = Math.exp(-RATE * T);
  const marks = new Map(); // strike + type -> markOf
  for (const r of rows) {
    marks.set(r.strike + 'CE', markOf(r.ce));
    marks.set(r.strike + 'PE', markOf(r.pe));
  }
  const pxOf = (t, K) => marks.get(K + t)?.px ?? null;
  const both = rows.filter((r) => pxOf('CE', r.strike) > 0 && pxOf('PE', r.strike) > 0);
  const near = both.reduce((b, r) => (!b || Math.abs(r.strike - S) < Math.abs(b.strike - S) ? r : b), null);
  const F = near ? near.strike + (pxOf('CE', near.strike) - pxOf('PE', near.strike)) / df : S / df;
  const ivs = new Map();
  for (const r of rows)
    for (const t of ['CE', 'PE']) {
      const p = pxOf(t, r.strike);
      if (p > 0 && T > 0) {
        const v = b76iv(p, F, r.strike, T, t === 'CE', df);
        if (v) ivs.set(r.strike + t, v);
      }
    }
  const own = (t, K) => ivs.get(K + t);
  const otm = (K) => own(K >= F ? 'CE' : 'PE', K) ?? own(K >= F ? 'PE' : 'CE', K);
  const ks = rows.map((r) => r.strike);
  const atmIv = near ? (otm(near.strike) ?? 0.14) : 0.14;
  const iv = (t, K) => {
    const v = otm(K);
    if (v) return v;
    let best = null;
    for (const k of ks) if (otm(k) && (best == null || Math.abs(k - K) < Math.abs(best - K))) best = k;
    return best == null ? atmIv : otm(best);
  };
  const side = (t, K) => {
    const r = rows.find((x) => x.strike === K);
    return (r && (t === 'CE' ? r.ce : r.pe)) || null;
  };
  const px = (t, K) => pxOf(t, K);
  const how = (t, K) => marks.get(K + t)?.how ?? null;
  // { ltp, bid, ask, vol } of a strike (bid / ask null when not quoted)
  const quote = (t, K) => {
    const o = side(t, K);
    return { ltp: o?.ltp > 0 ? o.ltp : null, bid: o?.bid > 0 ? o.bid : null, ask: o?.ask > 0 ? o.ask : null, vol: o?.vol > 0 ? o.vol : 0 };
  };
  // The price to trade at: the LTP (slippage is added on top by the caller).
  const exec = (t, K) => quote(t, K).ltp;
  // Why a strike may not be entered, or null: 'price' (none), 'volume' (no trades today), 'spread' (too wide).
  const notEnterable = (t, K) => {
    const q = quote(t, K);
    if (!q.ltp) return 'price';
    if (!(q.vol > 0)) return 'volume';
    if (q.bid && q.ask && q.ask - q.bid > Math.max(SPREAD.inr, ((q.bid + q.ask) / 2) * SPREAD.share)) return 'spread';
    return null;
  };
  const strikes = (t) => rows.filter((r) => (t === 'CE' ? r.ce : r.pe)?.ltp > 0).map((r) => r.strike);
  return { spot: S, F, df, T, atmIv, px, how, quote, exec, notEnterable, iv, strikes };
}

// ---------- P&L ----------
// The options' P&L at expiry with Nifty at x, per structure: realised + open legs at intrinsic − costs so far − STT on
// the bought legs that finish in the money.
function optExpiry(pos, x) {
  const out = {};
  for (const t of ['CE', 'PE']) {
    const legs = pos.legs.filter((l) => l.type === t);
    const stt = Costs.exercise(
      sum(
        legs.filter((l) => l.side > 0),
        (l) => intr(l, x) * l.lots * pos.lot,
      ),
    );
    out[t] = pos.realised[t] + sum(legs, (l) => l.side * (intr(l, x) - l.entry) * l.lots * pos.lot) - (pos.costs?.[t] || 0) - stt;
  }
  return out;
}
// The same if Nifty were at x now: open legs at Black-Scholes with each strike's volatility now (sticky strike).
// A leg's value if Nifty were at x now: Black-76 on the chain's own forward moved with Nifty (F × x / spot, the forward
// the volatilities were solved on, not spot × e^rT: the two differ by the futures basis), at the strike's volatility now,
// plus the leg's calibration (legCal): so at Nifty now every leg is worth exactly its LTP.
function valueToday(l, x, M) {
  if (!(M.T > 0)) return intr(l, x);
  return Math.max(0, b76((M.F * x) / M.spot, l.strike, M.T, M.iv(l.type, l.strike), l.type === 'CE', M.df) + legCal(l, M));
}
// LTP − the model's value at Nifty now (0 for a leg with no LTP).
function legCal(l, M) {
  const p = M.px(l.type, l.strike);
  return p > 0 && M.T > 0 ? p - b76(M.F, l.strike, M.T, M.iv(l.type, l.strike), l.type === 'CE', M.df) : 0;
}
function optToday(pos, x, M) {
  const out = {};
  for (const t of ['CE', 'PE']) {
    const legs = pos.legs.filter((l) => l.type === t);
    out[t] = pos.realised[t] + sum(legs, (l) => l.side * (valueToday(l, x, M) - l.entry) * l.lots * pos.lot) - (pos.costs?.[t] || 0);
  }
  return out;
}
// NIFTYBEES moves in % with Nifty: P&L of the units held at Nifty x.
const beesAt = (bees, spot, x) => (bees?.qty > 0 ? bees.qty * (bees.now * (x / spot) - bees.price) : 0);
// NIFTYBEES ₹ per Nifty point, pinned at the trade's start: its buy price ÷ Nifty at the entry. The grid and the payoff
// price NIFTYBEES at a Nifty level with it, so their rows stay put while the market moves (NIFTYBEES' live price ÷
// Nifty now drifts by its tracking error and the two quotes' timing). Null without a buy price or an entry level.
const beesPerNifty = (bees, entrySpot) => (bees?.price > 0 && entrySpot > 0 ? bees.price / entrySpot : null);

// Rows for Nifty at the trade's start (entrySpot; Nifty now without one) and MOVES % up and down from it, plus Nifty
// now. Every row: m = % from the start, fromNow = % from Nifty now. The P&L is the trade's since its start whatever the
// row: options from their entry premiums (closed legs as booked), NIFTYBEES from its buy price. At a fixed Nifty level
// NIFTYBEES is its buy price moved in % with Nifty from the entry (beesPerNifty), so the at-expiry columns stay the
// same until the legs change; the Now row takes NIFTYBEES at its price now, so it is the P&L at the top.
function grid(pos, M, bees, entrySpot) {
  const S = M.spot;
  const E = entrySpot > 0 ? entrySpot : S;
  const k = beesPerNifty(bees, entrySpot) ?? (bees?.now > 0 ? bees.now / S : 0);
  const beesPxAt = (x, isNow) => (isNow ? bees.now : k * x);
  const marks = [...MOVES.map((m) => -m).reverse(), 0, ...MOVES].map((m) => ({ m, mark: m === 0 ? (E === S ? 'now' : 'entry') : null }));
  const mNow = (S / E - 1) * 100;
  // Nifty now always has its own row: the fixed rows are never taken over by it (with Nifty ticking about one of them,
  // that row would flip between its fixed level and Nifty now, and the table shift under the eye).
  if (E !== S) marks.push({ m: mNow, mark: 'now' });
  return marks
    .sort((x, y) => y.m - x.m)
    .map(({ m, mark }) => {
      const x = mark === 'now' ? S : E * (1 + m / 100);
      const e = optExpiry(pos, x);
      const d = optToday(pos, x, M);
      const px = bees?.qty > 0 ? beesPxAt(x, mark === 'now') : null;
      const etf = px == null ? 0 : bees.qty * (px - bees.price);
      return {
        m: mark === 'now' ? mNow : m,
        mark,
        x,
        fromNow: (x / S - 1) * 100,
        beesPx: px,
        bees: etf,
        call: e.CE,
        put: e.PE,
        opt: e.CE + e.PE,
        total: e.CE + e.PE + etf,
        callToday: d.CE,
        putToday: d.PE,
        optToday: d.CE + d.PE,
        totalToday: d.CE + d.PE + etf,
      };
    });
}

// ---------- NIFTYBEES needed for the upside ----------
// Above the highest call strike the options lose (sold calls − bought calls) × lot ₹ for every Nifty point; one
// NIFTYBEES unit gains its price ÷ Nifty ₹ a point (it moves in % with Nifty). So
//   perPoint = net sold call lots × lot              (₹ the options lose per point, far up)
//   perUnit  = NIFTYBEES now ÷ Nifty now             (₹ one unit gains per point)
//   slopeUnits = perPoint ÷ perUnit                  (units for the upside to stop losing per point)
// and minUnits: the fewest units for which the trade at expiry (NIFTYBEES + options, from their entry, closed legs
// included) is never below 0 anywhere from Nifty now up, more often than slopeUnits when the trade is in a loss now.
// NIFTYBEES added is taken as bought now, at its price now. null without sold calls.
function beesCover(pos, M, bees, { upTo = 0.5 } = {}) {
  const S = M.spot;
  const lot = pos.lot;
  const net = sum(
    pos.legs.filter((l) => l.type === 'CE'),
    (l) => -l.side * l.lots,
  );
  const now = bees?.now > 0 ? bees.now : S / 100;
  const held = bees?.qty > 0 ? bees.qty : 0;
  const price = held && bees.price > 0 ? bees.price : now;
  const perUnit = now / S;
  const perPoint = net * lot;
  const slopeUnits = net > 0 ? perPoint / perUnit : 0;
  // the trade at expiry at Nifty x with `add` more units bought now
  const at = (x, add) => {
    const e = optExpiry(pos, x);
    return e.CE + e.PE + held * (now * (x / S) - price) + add * now * (x / S - 1);
  };
  // the payoff bends only at strikes: check Nifty now, every strike above it, and the slope past the last one
  const xs = [S, ...[...new Set(pos.legs.map((l) => l.strike))].filter((k) => k > S).sort((a, b) => a - b), S * (1 + upTo)];
  const top = Math.max(S, ...pos.legs.map((l) => l.strike));
  const ok = (add) => xs.every((x) => at(x, add) >= 0) && (held + add) * perUnit - perPoint >= -1e-9;
  const slopeHeld = held * perUnit - perPoint; // ₹ per point far up with the units held (> 0: gains)
  let minUnits = null;
  if (ok(0)) minUnits = held;
  else {
    let hi = Math.max(1000, slopeUnits * 4);
    if (ok(hi - held)) {
      let lo = held;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(mid - held)) hi = mid;
        else lo = mid;
      }
      minUnits = hi;
    }
  }
  // P&L at expiry with Nifty pct % above now: with the units held, and with the minimum (the extra ones bought now)
  const lossAt = (pct) => {
    const x = S * (1 + pct / 100);
    return { pct, x, held: at(x, 0), min: minUnits == null ? null : at(x, Math.max(0, minUnits - held)) };
  };
  return {
    netShortLots: net,
    lot,
    topStrike: top,
    perPoint,
    perUnit,
    beesNow: now,
    beesLive: Boolean(bees?.live),
    held,
    slopeUnits: Math.ceil(slopeUnits),
    slopeHeld,
    minUnits,
    toBuy: minUnits == null ? null : Math.max(0, minUnits - held),
    cost: minUnits == null ? null : Math.max(0, minUnits - held) * now,
    now: at(S, 0),
    rows: [0, 1, 2, 5, 10, 20].map(lossAt),
  };
}

// ---------- history of Nifty moves ----------
// Returns over n trading days from every day of the history (closes: [{ day, close, vix }]), each scaled by today's
// ATM volatility over India VIX that day (clamped to 0.5–2×; unscaled where VIX is missing).
function pastMoves(closes, n, ivNow) {
  const out = [];
  const k = Math.max(1, n);
  for (let i = 0; i + k < closes.length; i++) {
    const r = closes[i + k].close / closes[i].close - 1;
    const v = closes[i].vix;
    const f = v > 0 && ivNow > 0 ? Math.min(2, Math.max(0.5, (ivNow * 100) / v)) : 1;
    out.push(r * f);
  }
  return out;
}

// ---------- suggestions ----------
// A change: { id, group, title, close: [{ id, lots }], open: [{ type, strike, side, lots }] }, priced with slippage
// (slip, a fraction) and charges on every order. Returns { next, fills, charges } or null when a price is missing:
// next = the position after it (the closed lots' P&L and the charges booked into realised, per structure; new legs
// from their fill).
function priceChange(pos, ch, M, slip, day) {
  const realised = { ...pos.realised };
  let charges = 0;
  const legs = pos.legs.map((l) => ({ ...l }));
  const fills = [];
  const order = (t, buy, turn) => {
    const c = Costs.orders({ [buy ? 'buy' : 'sell']: turn, orders: 1, day });
    charges += c;
    realised[t] -= c;
  };
  for (const c of ch.close) {
    const l = legs.find((x) => x.id === c.id);
    const p = l && M.exec(l.type, l.strike);
    if (!(p > 0) || c.lots > l.lots) return null;
    const buy = l.side < 0; // closing a sold leg buys it back
    const f = buy ? p * (1 + slip) : p * (1 - slip);
    order(l.type, buy, f * c.lots * pos.lot);
    realised[l.type] += l.side * (f - l.entry) * c.lots * pos.lot;
    fills.push({ ...l, lots: c.lots, fill: f, close: true });
    l.lots -= c.lots;
  }
  let seq = Math.max(0, ...pos.legs.map((l) => l.id || 0));
  for (const o of ch.open) {
    const p = M.exec(o.type, o.strike);
    if (!(p > 0) || M.notEnterable(o.type, o.strike)) return null;
    const buy = o.side > 0;
    const f = buy ? p * (1 + slip) : p * (1 - slip);
    order(o.type, buy, f * o.lots * pos.lot);
    fills.push({ ...o, fill: f });
    legs.push({ ...o, id: ++seq, entry: f, expiry: pos.expiry });
  }
  return { next: { ...pos, legs: legs.filter((l) => l.lots > 0), realised }, fills, charges };
}
// Defined risk kept: no more net sold calls than before (NIFTYBEES covers those), and never more puts sold than bought.
function keepsRisk(before, after) {
  const net = (legs, t) =>
    sum(
      legs.filter((l) => l.type === t),
      (l) => -l.side * l.lots,
    );
  return net(after, 'CE') <= Math.max(0, net(before, 'CE')) && net(after, 'PE') <= 0;
}

// The changes worth testing on this position, with Nifty at S.
// skipped (a Map, optional): the strikes left out, "22500 PE" -> why (notEnterable). shape: 'mcc' / 'psc' / 'bpc' (SHAPES).
function candidates(pos, M, bees, skipped = new Map(), shape = 'mcc') {
  const N = SHAPES[shape] || SHAPES.mcc;
  const S = M.spot;
  const out = [];
  const of = (t, s) => pos.legs.filter((l) => l.type === t && l.side === s).sort((a, b) => b.lots - a.lots);
  const [ceS] = of('CE', -1);
  const ceL = of('CE', 1);
  const [peS] = of('PE', -1);
  const peL = of('PE', 1);
  const calls = pos.legs.filter((l) => l.type === 'CE');
  const puts = pos.legs.filter((l) => l.type === 'PE');
  // a strike a change would enter: priced, traded today, a sound quote
  const has = (t, K) => {
    const why = M.notEnterable(t, K);
    if (why && why !== 'price') skipped.set(`${K} ${t}`, why);
    return !why;
  };
  const closeAll = (legs) => legs.map((l) => ({ id: l.id, lots: l.lots }));
  const reopen = (legs, d) => legs.map((l) => ({ type: l.type, strike: l.strike + d, side: l.side, lots: l.lots }));
  const range = (from, to) => {
    const a = [];
    for (let k = from; k <= to; k += STEP) a.push(k);
    return a;
  };
  const fmtD = (d) => `${d > 0 ? 'up' : 'down'} ${Math.abs(d)} pts`;
  // strikes / shifts searched: 600 pts either way of where a leg is, and as far as 800 pts past Nifty now
  const A = atmOf(S);
  const shifts = (k) => range(Math.min(-600, A - k - 800), Math.max(600, A - k + 800)).filter((d) => d);

  if (ceS) {
    const floor = Math.max(...ceL.map((l) => l.strike), -Infinity);
    for (const K of range(Math.min(ceS.strike, A) - 600, Math.max(ceS.strike, A) + 800))
      if (K !== ceS.strike && K > floor && has('CE', K))
        out.push({
          id: `ceRoll:${K}`,
          group: 'call',
          kind: 'roll',
          title: `Roll the ${N.soldCalls} ${ceS.strike} → ${K}`,
          close: [{ id: ceS.id, lots: ceS.lots }],
          open: [{ type: 'CE', strike: K, side: -1, lots: ceS.lots }],
        });
    // (a single sold call: a shift is the same as a roll)
    for (const d of calls.length > 1 ? shifts(ceS.strike) : [])
      if (calls.every((l) => has('CE', l.strike + d)))
        out.push({
          id: `ceShift:${d}`,
          group: 'call',
          kind: 'shift',
          shift: d,
          title: `Move the whole ${N.calls} ${fmtD(d)} (${calls.map((l) => l.strike + d).join('/')})`,
          close: closeAll(calls),
          open: reopen(calls, d),
        });
    const naked = ceS.lots - sum(ceL, (l) => l.lots);
    if (naked > 0) {
      out.push({
        id: 'ceBuyBack',
        group: 'call',
        kind: 'buyBack',
        title: ceL.length
          ? `Buy back ${naked} of the sold ${ceS.strike} calls (1 × 1 spread)`
          : `Buy back the sold ${ceS.strike} call${naked > 1 ? 's' : ''} (NIFTYBEES runs free above it)`,
        close: [{ id: ceS.id, lots: naked }],
        open: [],
      });
      for (const K of range(ceS.strike + STEP, ceS.strike + 1000))
        if (has('CE', K))
          out.push({
            id: `ceHedge:${K}`,
            group: 'call',
            kind: 'hedge',
            title: `Buy ${naked} × ${K} CE above the ${N.soldCalls}`,
            close: [],
            open: [{ type: 'CE', strike: K, side: 1, lots: naked }],
          });
    }
    out.push({ id: 'ceClose', group: 'call', kind: 'close', title: `Close the ${N.callStruct}`, close: closeAll(calls), open: [] });
  }
  if (peS) {
    // the sold puts stay above the 2-3-1's wing (the lowest bought put), under the collar's bought put, or over the
    // bull put collar's bought put
    const wing = Math.min(...peL.map((l) => l.strike), Infinity);
    const top = Math.max(...peL.map((l) => l.strike), -Infinity);
    const okPut = (K) => (N.soldPutRoll === 'any' ? true : N.soldPutRoll === 'under' ? K < top : N.soldPutRoll === 'over' ? K > top : K > wing);
    for (const K of range(Math.min(peS.strike, A) - 800, Math.max(peS.strike, A) + 600))
      if (K !== peS.strike && okPut(K) && has('PE', K))
        out.push({
          id: `peRoll:${K}`,
          group: 'put',
          kind: 'roll',
          title: `Roll the sold put${peS.lots > 1 ? 's' : ''} ${peS.strike} → ${K}`,
          close: [{ id: peS.id, lots: peS.lots }],
          open: [{ type: 'PE', strike: K, side: -1, lots: peS.lots }],
        });
    for (const d of shifts(peS.strike))
      if (puts.every((l) => has('PE', l.strike + d)))
        out.push({
          id: `peShift:${d}`,
          group: 'put',
          kind: 'shift',
          shift: d,
          title: `Move the whole ${N.puts} ${fmtD(d)} (${puts.map((l) => l.strike + d).join('/')})`,
          close: closeAll(puts),
          open: reopen(puts, d),
        });
    // the collar's bought put on its own: nearer protection, or a cheaper one (always above the sold put; the bull put
    // collar's always under it)
    const [pb] = peL;
    const okBought = (K) => (N.soldPutRoll === 'any' ? true : N.soldPutRoll === 'under' ? K > peS.strike : K < peS.strike);
    if (N.soldPutRoll !== 'wing' && pb)
      for (const K of range(Math.min(pb.strike, A) - 600, Math.max(pb.strike, A) + 400))
        if (K !== pb.strike && okBought(K) && has('PE', K))
          out.push({
            id: `peLRoll:${K}`,
            group: 'put',
            kind: 'rollBought',
            title: `Roll the bought put ${pb.strike} → ${K}`,
            close: [{ id: pb.id, lots: pb.lots }],
            open: [{ type: 'PE', strike: K, side: 1, lots: pb.lots }],
          });
    out.push({ id: 'peClose', group: 'put', kind: 'close', title: `Close the ${N.puts}`, close: closeAll(puts), open: [] });
  }
  // a put under the structure for the NIFTYBEES held (its lots: the units' worth in Nifty lots)
  if (bees?.qty > 0) {
    const lots = Math.max(1, Math.round((bees.qty * bees.now) / (pos.lot * S)));
    const low = Math.min(...pos.legs.map((l) => l.strike), atmOf(S));
    for (const K of range(atmOf(S * 0.9), low - STEP))
      if (has('PE', K))
        out.push({
          id: `beesPut:${K}`,
          group: 'protect',
          kind: 'protect',
          title: `Buy ${lots} × ${K} PE under the ${N.puts} (protects the NIFTYBEES)`,
          close: [],
          open: [{ type: 'PE', strike: K, side: 1, lots }],
        });
  }
  if (pos.legs.length)
    out.push({ id: 'closeAll', group: 'both', kind: 'close', title: 'Close every option leg (keep the NIFTYBEES)', close: closeAll(pos.legs), open: [] });
  return out;
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : null);

// How the change does against keeping the position, over the past moves (returns r: Nifty at S·(1+r) at expiry):
// { better (share of moves it ends better in), avg, se (its standard error: overlapping n-day moves count as n / days
// independent ones), p5 / p95 (₹ change), worstBefore / worstAfter (the worst outcome with NIFTYBEES) }.
function judge(pos, next, S, moves, bees, days = 1) {
  const opt = (p, x) => {
    const e = optExpiry(p, x);
    return e.CE + e.PE;
  };
  const d = [];
  let worstBefore = Infinity;
  let worstAfter = Infinity;
  for (const r of moves) {
    const x = S * (1 + r);
    const b = opt(pos, x);
    const a = opt(next, x);
    d.push(a - b);
    const etf = beesAt(bees, S, x);
    worstBefore = Math.min(worstBefore, b + etf);
    worstAfter = Math.min(worstAfter, a + etf);
  }
  const sorted = [...d].sort((a, b) => a - b);
  const avg = sum(d, (v) => v) / d.length;
  const sd = Math.sqrt(sum(d, (v) => (v - avg) ** 2) / Math.max(1, d.length - 1));
  return {
    better: d.filter((v) => v > 1).length / d.length,
    avg,
    se: sd / Math.sqrt(Math.max(1, d.length / Math.max(1, days))),
    p5: quantile(sorted, 0.05),
    p95: quantile(sorted, 0.95),
    worstBefore,
    worstAfter,
  };
}

// Changes that lift the worst past outcome by PROTECT or more and are not already suggested, the most protection per
// ₹ of average cost first.
function protection(tried, good) {
  const lift = (c) => c.stats.worstAfter - c.stats.worstBefore;
  return tried
    .filter((c) => !good.includes(c) && lift(c) >= Math.max(PROTECT.inr, Math.abs(c.stats.worstBefore) * PROTECT.share))
    .sort((a, b) => lift(b) / Math.max(1, -b.stats.avg) - lift(a) / Math.max(1, -a.stats.avg));
}
// The first n of a list, at most 2 of each side and kind.
function firstOfKinds(list, n) {
  const per = new Map();
  const out = [];
  for (const c of list) {
    const k = c.group + ':' + c.kind;
    if (out.length >= n || (per.get(k) || 0) >= 2) continue;
    per.set(k, (per.get(k) || 0) + 1);
    out.push(c);
  }
  return out;
}
// Keeps the worst past outcome: not worse than before by more than WORST_TOL or the average gain.
const keepsWorst = (st) => st.worstAfter >= st.worstBefore - Math.max(WORST_TOL.inr, Math.abs(st.worstBefore) * WORST_TOL.share, st.avg || 0);

// The position held as it is to expiry, over the past moves: { profitable (share), avg, p5, worst } with NIFTYBEES.
function holdStats(pos, S, moves, bees) {
  const v = moves.map((r) => {
    const x = S * (1 + r);
    const e = optExpiry(pos, x);
    return e.CE + e.PE + beesAt(bees, S, x);
  });
  const sorted = [...v].sort((a, b) => a - b);
  return {
    profitable: v.filter((x) => x > 0).length / v.length,
    avg: Math.round(sum(v, (x) => x) / v.length),
    p5: Math.round(quantile(sorted, 0.05)),
    worst: Math.round(sorted[0]),
    best: Math.round(sorted[sorted.length - 1]),
  };
}

// The suggestions: every candidate priced and judged; those that raise the average and keep the worst past outcome
// (keepsWorst) are kept, best first, at most `max` (and at most 2 of a kind per side, so one idea does not fill the
// list), plus the best call change and the best put change together. `days`: the trading days the moves span.
function suggest(pos, M, bees, moves, { slip = 0.005, day = null, max = 8, days = 1, shape = 'mcc' } = {}) {
  const S = M.spot;
  const tried = [];
  const skipped = new Map();
  for (const c of candidates(pos, M, bees, skipped, shape)) {
    const priced = priceChange(pos, c, M, slip, day);
    if (!priced || !keepsRisk(pos.legs, priced.next.legs)) continue;
    tried.push({ ...c, priced, stats: judge(pos, priced.next, S, moves, bees, days) });
  }
  // raise the average but make the worst past outcome worse than keepsWorst allows: shown apart, best first, 2 a kind
  const risky = tried.filter((c) => c.stats.avg > 0 && !keepsWorst(c.stats)).sort((a, b) => b.stats.avg - a.stats.avg);
  const riskier = risky.length;
  const good = tried.filter((c) => c.stats.avg > 0 && keepsWorst(c.stats)).sort((a, b) => b.stats.avg - a.stats.avg);
  const best = (g) => good.find((c) => c.group === g);
  const [bc, bp] = [best('call'), best('put')];
  if (bc && bp) {
    const ch = {
      id: `combo:${bc.id}+${bp.id}`,
      group: 'both',
      kind: 'combo',
      title: `${bc.title} and ${bp.title.replace(/^./, (s) => s.toLowerCase())}`,
      close: [...bc.close, ...bp.close],
      open: [...bc.open, ...bp.open],
    };
    const priced = priceChange(pos, ch, M, slip, day);
    if (priced && keepsRisk(pos.legs, priced.next.legs)) {
      const c = { ...ch, priced, stats: judge(pos, priced.next, S, moves, bees, days) };
      if (c.stats.avg > 0 && keepsWorst(c.stats)) good.push(c);
      good.sort((a, b) => b.stats.avg - a.stats.avg);
    }
  }
  const picked = [];
  const per = new Map();
  const add = (c) => {
    if (picked.includes(c) || picked.length >= max) return;
    const k = c.group + ':' + c.kind;
    if ((per.get(k) || 0) >= 2) return;
    per.set(k, (per.get(k) || 0) + 1);
    picked.push(c);
  };
  // the best of those better in ≥ 90 % of past moves first, then by average gain
  const sure = good.filter((c) => c.stats.better >= RELIABLE);
  if (sure[0]) add(sure[0]);
  for (const c of good) add(c);
  const left = (why) =>
    [...skipped]
      .filter(([, w]) => w === why)
      .map(([k]) => k)
      .sort();
  return {
    tried: tried.length,
    improving: good.length,
    riskier,
    reliable: sure.length,
    skipped: { volume: left('volume'), spread: left('spread') },
    hold: holdStats(pos, S, moves, bees),
    list: picked.map((c) => view(pos, c, M)),
    risky: firstOfKinds(risky, 4).map((c) => ({ ...view(pos, c, M), risky: true })),
    protect: firstOfKinds(protection(tried, good), 3).map((c) => ({ ...view(pos, c, M), protect: true })),
  };
}

// What the page shows of a suggestion: the orders, its cost now, its stats and the position after.
function view(pos, c, M) {
  const S = M.spot;
  const orders = c.priced.fills.map((f) => ({
    action: f.close ? (f.side > 0 ? 'S' : 'B') : f.side > 0 ? 'B' : 'S',
    type: f.type,
    strike: f.strike,
    lots: f.lots,
    ltp: M.px(f.type, f.strike),
    ...(({ bid, ask, vol }) => ({ bid, ask, vol }))(M.quote(f.type, f.strike)),
    fill: Math.round(f.fill * 100) / 100,
    close: Boolean(f.close),
  }));
  // what it costs now, against the legs' LTP (slippage + charges): the change's P&L the moment it is done
  const now = sum(c.priced.fills, (f) => {
    const p = M.px(f.type, f.strike);
    const sgn = f.close ? -f.side : f.side; // +1 bought, −1 sold
    return sgn * (p - f.fill) * f.lots * pos.lot;
  });
  return {
    id: c.id,
    group: c.group,
    kind: c.kind,
    title: c.title,
    orders,
    charges: Math.round(c.priced.charges),
    costNow: Math.round(now - c.priced.charges),
    reliable: c.stats.better >= RELIABLE,
    stats: {
      better: c.stats.better,
      avg: Math.round(c.stats.avg),
      se: Math.round(c.stats.se),
      p5: Math.round(c.stats.p5),
      p95: Math.round(c.stats.p95),
      worstBefore: Math.round(c.stats.worstBefore),
      worstAfter: Math.round(c.stats.worstAfter),
    },
    // the position after the change, for the page's grid and payoff
    after: {
      legs: c.priced.next.legs.map((l) => ({ id: l.id, type: l.type, strike: l.strike, lots: l.lots, side: l.side, entry: l.entry })),
      realised: c.priced.next.realised,
    },
    text: c.priced.fills
      .map((f) => `${f.close ? (f.side > 0 ? 'Sell' : 'Buy back') : f.side > 0 ? 'Buy' : 'Sell'} ${f.lots} × ${f.strike} ${f.type} @ ~${f.fill.toFixed(1)}`)
      .join(' · '),
    spot: S,
  };
}

// The position after a suggestion the page sent back (view().after).
const applyView = (pos, after) => ({ ...pos, legs: after.legs, realised: after.realised });

// The backtest study's rules on this trade: for each rule kept in bt-data/mcc-study.json (psc-study.json), its total and
// how many months it beat no adjustments, and whether it would act now (Nifty's move since entry, a premium's decay).
// No trade (pos null): the same list, nothing due. current: the id of the row run with the strategy's own rules.
function studyRules(study, pos, M, entrySpot, shape = 'mcc', current = null) {
  if (!study?.rows?.length) return [];
  const none = study.rows.find((r) => r.id === 'none');
  const byExp = new Map((none?.months || []).filter((m) => m.ok).map((m) => [m.expiry, m.opt]));
  const live = Boolean(pos && M);
  const S = live ? M.spot : 0;
  const move = live && entrySpot > 0 ? (S / entrySpot - 1) * 100 : 0;
  const sold = live ? pos.legs.filter((l) => l.side < 0) : [];
  const decay = (pct) => sold.filter((l) => M.px(l.type, l.strike) != null && M.px(l.type, l.strike) <= (l.entry * pct) / 100);
  return study.rows
    .filter((r) => r.id !== 'none')
    .map((r) => {
      const ok = r.months.filter((m) => m.ok && byExp.has(m.expiry));
      const beat = ok.filter((m) => m.opt > byExp.get(m.expiry)).length;
      const total = sum(
        r.months.filter((m) => m.ok),
        (m) => m.opt,
      );
      const a = r.params?.adj || {};
      let due = null;
      if (!live) due = null;
      else if (shape === 'psc' || shape === 'bpc') due = pscDue(r.params || {}, move, entrySpot, pos, M, shape === 'bpc');
      else if (shape === 'nbo') due = nboDue(r.params || {}, move, entrySpot, pos, M);
      else if (shape === 'pbs') due = pbsDue(r.params || {}, move, entrySpot);
      else if (a.on && a.trigger === 'move' && Math.abs(move) >= a.movePct)
        due = `Nifty is ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} % since the entry (${Math.round(entrySpot)}): the rule moves the ${move > 0 ? 'sold puts up' : 'sold calls down'}${a.legs === 'all' ? ' (the whole structure)' : ''}`;
      else if (a.on && a.trigger === 'decay' && decay(a.decayPct).length)
        due = `${decay(a.decayPct)
          .map((l) => `${l.strike} ${l.type}`)
          .join(', ')} at or under ${a.decayPct} % of the premium sold: the rule rolls ${a.legs === 'all' ? 'that whole structure' : 'it'} toward Nifty`;
      return { id: r.id, label: r.label, total: Math.round(total), noneTotal: Math.round(sum([...byExp.values()], (v) => v)), beat, months: ok.length, due, current: r.id === current };
    })
    .sort((a, b) => b.total - a.total);
}
// The study row run with the strategy's own rules (defaults: the legs' distances, adjustments, up-market extra): every
// setting the row and the defaults both have is equal. null when none is.
const STUDY_KEYS = ['ce', 'pe', 'adj', 'up', 'pick'];
function studyCurrent(study, defaults) {
  const same = (a = {}, b = {}) => Object.keys(b).every((k) => !(k in a) || JSON.stringify(a[k]) === JSON.stringify(b[k]));
  const row = (study?.rows || []).find((r) => STUDY_KEYS.every((k) => same(r.params?.[k], defaults?.[k])));
  return row ? row.id : null;
}
// The study for the comparison popup: each row's settings, summary and months, trimmed to what it shows.
function studyRows(study) {
  return (study?.rows || []).map((r) => ({
    id: r.id,
    label: r.label,
    params: Object.fromEntries(STUDY_KEYS.map((k) => [k, r.params?.[k] || {}])),
    summary: r.summary,
    months: (r.months || []).map((m) => ({ expiry: m.expiry, ok: m.ok, why: m.why, move: m.move, opt: m.opt, callPnl: m.callPnl, putPnl: m.putPnl, withOnce: m.withOnce, adjustments: m.adjustments })),
  }));
}
// A NIFTYBEES + options rule (bt/nbo.js decide) on this trade now: a side (all call legs, all put legs) re-centred when
// Nifty has moved movePct % since the entry in a direction switched on for it, or (decay) once the side is worth
// decayPct % of its entry value. null when nothing is due.
function nboDue(prm, move, entrySpot, pos, M) {
  const a = prm.adj || {};
  if (!a.on) return null;
  const out = [];
  for (const t of ['CE', 'PE']) {
    const legs = pos.legs.filter((l) => l.type === t);
    if (!legs.length) continue;
    const name = t === 'CE' ? 'call legs' : 'put legs';
    const on = t === 'CE' ? (move > 0 ? a.ceUp : a.ceDown) : move > 0 ? a.peUp : a.peDown;
    if (a.trigger === 'decay') {
      if (legs.some((l) => M.px(l.type, l.strike) == null)) continue;
      const was = Math.abs(sum(legs, (l) => l.side * l.entry * l.lots));
      const now = Math.abs(sum(legs, (l) => l.side * M.px(l.type, l.strike) * l.lots));
      if (was > 0 && now <= (was * a.decayPct) / 100 && on) out.push(`the ${name} are worth ${((now / was) * 100).toFixed(0)} % of their entry value: the rule moves them to the new ATM`);
    } else if (Math.abs(move) >= a.movePct && on) out.push(`the rule moves the ${name} ${move > 0 ? 'up' : 'down'} to the new ATM`);
  }
  if (!out.length) return null;
  return `Nifty is ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} % since the entry (${Math.round(entrySpot)}): ${out.join('; ')}`;
}
// A Put back spread rule (bt/pbs.js decide) on this trade now: the whole structure searched again once Nifty has moved
// movePct % since the entry, in a direction the rule allows. null when nothing is due (or the rule holds to expiry).
function pbsDue(prm, move, entrySpot) {
  const a = prm.adj || {};
  if (!a.on || !(Math.abs(move) >= a.movePct)) return null;
  if ((move > 0 && a.dir === 'down') || (move < 0 && a.dir === 'up')) return null;
  return `Nifty is ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} % since the entry (${Math.round(entrySpot)}): the rule closes the options and searches the chain again at the new Nifty`;
}
// A Put spread collar rule (bt/psc.js decide; bt/bpc.js for the Bull put collar, credit: true) on this trade now:
// market down → the sold call rolled down (and the put spread down with putDown); market up → the put spread moved up.
// Decay: the sold call, or the put spread's value against what it cost (the credit taken, for a sold spread). Up-market
// extras: Nifty at the sold call's strike. null when nothing is due.
function pscDue(prm, move, entrySpot, pos, M, credit = false) {
  const a = prm.adj || {};
  const S = M.spot;
  const [ceS] = pos.legs.filter((l) => l.type === 'CE' && l.side < 0);
  const [peL] = pos.legs.filter((l) => l.type === 'PE' && l.side > 0);
  const [peS] = pos.legs.filter((l) => l.type === 'PE' && l.side < 0);
  const out = [];
  const since = `Nifty is ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} % since the entry (${Math.round(entrySpot)})`;
  if (a.on && a.trigger === 'move' && Math.abs(move) >= a.movePct) {
    const puts = peL || peS;
    if (move > 0 && a.put !== false && puts) out.push('the rule moves the put spread up to the new ATM');
    if (move < 0 && a.call !== false && ceS) out.push('the rule rolls the sold call down');
    if (move < 0 && a.putDown && puts) out.push('and moves the put spread down');
    if (out.length) return `${since}: ${out.join(', ')}`;
  } else if (a.on && a.trigger === 'decay') {
    const px = (l) => (l ? M.px(l.type, l.strike) : 0);
    if (a.call !== false && ceS && px(ceS) != null && px(ceS) <= (ceS.entry * a.decayPct) / 100)
      out.push(`the ${ceS.strike} CE is at or under ${a.decayPct} % of its premium: the rule rolls it toward Nifty`);
    // the spread's value as held: bought less sold (a debit spread), sold less bought (a credit spread)
    const [hi, lo] = credit ? [peS, peL] : [peL, peS];
    const cost = hi ? hi.entry - (lo ? lo.entry : 0) : 0;
    const now = hi && px(hi) != null && (!lo || px(lo) != null) ? px(hi) - px(lo) : null;
    if (a.put !== false && cost > 0 && now != null && now <= (cost * a.decayPct) / 100)
      out.push(`the put spread is worth ${a.decayPct} % or less of its ${credit ? 'credit' : 'cost'}: the rule moves it up to the new ATM`);
    if (out.length) return out.join('; ');
  }
  const upOn = prm.up?.mode && prm.up.mode !== 'none';
  if (upOn && ceS && S >= ceS.strike + (prm.up.buffer || 0)) return `Nifty is at or over the sold ${ceS.strike} CE: the rule acts on the call`;
  return null;
}

// ---------- best strikes for a new collar ----------
// Every collar on the live chain M: sell 1 CE + a put spread (2 PE legs, one bought one sold, 50 … 700 points apart,
// either way round: the bought put above the sold one, or the sold above the bought), strikes ATM or out of the money
// only (the call at the ATM strike up to WIDE points above, the puts at the ATM strike down to WIDE below). Entered now at the LTP ± slip with charges, held with the NIFTYBEES (beesQty
// units bought now at beesPx), scored at expiry on Nifty moves of 1 … 8 % from now:
//   up      = the average total (NIFTYBEES + options) over the up moves,
//   downOpt = the average options P&L over the down moves (what the options earn on a fall, NIFTYBEES aside),
//   down    = the average total over the down moves, worst = the lowest total on them, flat = options P&L at Nifty now.
//   mid     = the lowest total at expiry anywhere within ±midBand % of now (Nifty staying in a range).
// Kept: downOpt ≥ minDown, up ≥ minUp and mid ≥ minMid (the floors); ranked by up + mid (Nifty up and Nifty staying in
// the range, same weight), then downOpt. None that meet all: the ones that miss by the least (shortfalls added) first.
//   minFlat: the least the options alone earn if Nifty ends where it is now (flat), e.g. 1 % of the money invested.
// midBest: the highest mid of the collars meeting the other floors (the most the range can be asked for).
// One per sold-call strike. Only strikes traded today with a tight quote (M.notEnterable).
// Returns { tried, priced, within, minDown, list: [{ id, title, legs (with fills), credit, charges, up, down, downOpt,
// worst, flat, grid (as grid()) }] }.
// settle (a past month): { spot, bees } — Nifty and NIFTYBEES at the expiry. Each pick then also has actual: { spot,
// opt, bees, total } (the options at intrinsic at that Nifty, NIFTYBEES bought at beesPx sold at settle.bees), and the
// result has hindsight: the collar of all those priced (within the floor when any is) whose options made the most.
// shape 'mcc' (the Modified covered call), the same search and scoring on its legs instead: buy ratios.ce.buy CE, sell
// ratios.ce.sell CE 50 … MCC_GAP points above it (the call ratio, 1 × 2); buy ratios.pe.buy PE, sell ratios.pe.sell PE
// 50 … MCC_GAP under it and buy ratios.pe.wing PE 50 … MCC_WING under those (the put butterfly, 2-3-1); each × lots.
const BEST_MOVES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8];
const WIDE = 1000;
// the Modified covered call's search (shape 'mcc'): the gap from the bought call to the sold ones and from the bought
// puts to the sold ones (50 … MCC_GAP points), the wing under the sold puts (50 … MCC_WING)
const MCC_GAP = 400;
const MCC_CALL_GAP = 800; // the call ratio's gap: up to twice the puts' (equal peaks need call gap = 2 × put gap at 1×2 / 2-3-1)
const MCC_WING = 300;
const MID_BAND = 2; // default % either side of the entry: the range Nifty stays in ("rangebound")
function bestCollars(M, { lot, lots = 1, beesQty = 0, beesPx, expiry, slip = 0.005, day = null, n = 5, minDown = 30000, minUp = 35000, minMid = -Infinity, midBand = MID_BAND, minFlat = -Infinity, settle = null, shape = 'collar', ratios = null, peakTol = null, fixed = null } = {}) {
  const S = M.spot;
  const A = atmOf(S);
  const bees = beesQty > 0 ? { qty: beesQty, price: beesPx, now: beesPx } : null;
  const empty = { legs: [], realised: { CE: 0, PE: 0 }, costs: {}, lot, expiry };
  const ups = BEST_MOVES.map((m) => S * (1 + m / 100));
  const downs = BEST_MOVES.map((m) => S * (1 - m / 100));
  // the range: Nifty anywhere from −midBand to +midBand % at the expiry, every 0.1 %
  const band = Math.min(10, Math.max(0.5, Number(midBand) || MID_BAND));
  const mids = Array.from({ length: Math.round(band * 20) + 1 }, (_, i) => S * (1 + (i / 10 - band) / 100));
  const ok = (t, K) => M.exec(t, K) > 0 && !M.notEnterable(t, K);
  // ATM and out of the money only (no ITM): the call at the ATM strike or above, both puts at the ATM strike or below
  const strikes = (t) => {
    const out = [];
    const [lo, hi] = t === 'CE' ? [A, A + WIDE] : [A - WIDE, A];
    for (let k = lo; k <= hi; k += STEP) if (ok(t, k)) out.push(k);
    return out;
  };
  const ces = strikes('CE');
  const pes = strikes('PE');
  // The call side and the put side are priced apart (charges are per order and optExpiry keeps calls and puts apart,
  // so a pair's numbers are the sum of its two sides', exactly), then every pair is scored.
  const r0 = (n) => Math.max(1, Math.round(n * lots));
  const callSides = [];
  const putSides = [];
  if (shape === 'mcc') {
    // Modified covered call: buy ce.buy CE, sell ce.sell CE gap points above (the call ratio); buy pe.buy PE, sell
    // pe.sell PE sellGap under it, buy pe.wing PE wingGap under that (the put butterfly)
    const ce = { buy: 1, sell: 2, ...(ratios?.ce || {}) };
    const pe = { buy: 2, sell: 3, wing: 1, ...(ratios?.pe || {}) };
    const has = (t, k) => (t === 'CE' ? ces : pes).includes(k);
    for (const k of ces)
      for (let g = STEP; g <= MCC_CALL_GAP; g += STEP)
        if (has('CE', k + g))
          callSides.push({
            id: `c${k}x${k + g}`,
            key: k + g,
            pk: k + g, // the upside peak: Nifty at the sold calls
            fx: k, // calls all out of the money from here down
            open: [
              { type: 'CE', strike: k, side: 1, lots: r0(ce.buy) },
              { type: 'CE', strike: k + g, side: -1, lots: r0(ce.sell) },
            ],
          });
    for (const k of pes)
      for (let g = STEP; g <= MCC_GAP; g += STEP)
        for (let w = STEP; w <= MCC_WING; w += STEP)
          if (has('PE', k - g) && has('PE', k - g - w))
            putSides.push({
              id: `p${k}x${k - g}w${k - g - w}`,
              pk: k - g, // the downside peak: Nifty at the sold puts
              fx: k, // puts all out of the money from here up
              open: [
                { type: 'PE', strike: k, side: 1, lots: r0(pe.buy) },
                { type: 'PE', strike: k - g, side: -1, lots: r0(pe.sell) },
                { type: 'PE', strike: k - g - w, side: 1, lots: r0(pe.wing) },
              ],
            });
  } else {
    for (const c of ces) callSides.push({ id: `c${c}`, key: c, open: [{ type: 'CE', strike: c, side: -1, lots }] });
    for (const hi of pes)
      for (const lo of pes) {
        if (lo >= hi || hi - lo > 700) continue;
        for (const buyHi of [true, false])
          putSides.push({
            id: `${buyHi ? 'b' : 's'}${hi}${buyHi ? 's' : 'b'}${lo}`,
            open: [
              { type: 'PE', strike: hi, side: buyHi ? 1 : -1, lots },
              { type: 'PE', strike: lo, side: buyHi ? -1 : 1, lots },
            ],
          });
      }
  }
  // each side's options P&L at expiry at the points scored: ups, downs, the range, and Nifty where it is
  const pts = [...ups, ...downs, ...mids, S];
  const nU = ups.length;
  const nD = downs.length;
  const nM = mids.length;
  const priceSide = (sd, t) => {
    const r = priceChange(empty, { close: [], open: sd.open }, M, slip, day);
    if (!r) return null;
    const v = Float64Array.from(pts, (x) => optExpiry(r.next, x)[t]);
    // the Modified covered call's two peaks: this side's P&L at its own peak and where it is flat (the other side's)
    return sd.pk ? { ...sd, v, peak: optExpiry(r.next, sd.pk)[t], flatV: optExpiry(r.next, sd.fx)[t] } : { ...sd, v };
  };
  const cs = callSides.map((sd) => priceSide(sd, 'CE')).filter(Boolean);
  const ps = putSides.map((sd) => priceSide(sd, 'PE')).filter(Boolean);
  const beesV = pts.map((x) => beesAt(bees, S, x));
  const tried = callSides.length * putSides.length;
  const scored = [];
  const peaks = shape === 'mcc';
  const tol = peaks && peakTol != null && Number.isFinite(Number(peakTol)) ? Math.max(0, Number(peakTol)) : null;
  let peaked = 0;
  for (const c of cs)
    for (const p of ps) {
      // options only at expiry: Nifty at the sold calls (the puts are all out of the money there) and at the sold puts
      const upPeak = peaks ? c.peak + p.flatV : null;
      const downPeak = peaks ? p.peak + c.flatV : null;
      if (tol != null && Math.abs(upPeak - downPeak) > tol) continue;
      peaked++;
      const a = c.v;
      const b = p.v;
      let up = 0;
      let dnOpt = 0;
      let dn = 0;
      let worst = Infinity;
      let mid = Infinity;
      for (let i = 0; i < nU; i++) up += a[i] + b[i] + beesV[i];
      for (let i = nU; i < nU + nD; i++) {
        const o = a[i] + b[i];
        dnOpt += o;
        dn += o + beesV[i];
        if (o + beesV[i] < worst) worst = o + beesV[i];
      }
      for (let i = nU + nD; i < nU + nD + nM; i++) if (a[i] + b[i] + beesV[i] < mid) mid = a[i] + b[i] + beesV[i];
      const f = nU + nD + nM;
      scored.push({ id: c.id + p.id, call: c, put: p, up: up / nU, downOpt: dnOpt / nD, down: dn / nD, worst, flat: a[f] + b[f], mid, upPeak, downPeak });
    }
  const within = scored.filter((o) => o.downOpt >= minDown && o.up >= minUp && o.mid >= minMid && o.flat >= minFlat);
  // ranked by Nifty going up and Nifty staying in the range (its lowest point), same weight; the floors cover the fall
  const short = (o) => Math.max(0, minDown - o.downOpt) + Math.max(0, minUp - o.up) + Math.max(0, minMid - o.mid) + Math.max(0, minFlat - o.flat);
  const rank = (a, b) => b.up + b.mid - (a.up + a.mid) || b.downOpt - a.downOpt;
  const pool = within.length ? within.sort(rank) : scored.sort((a, b) => short(a) - short(b) || rank(a, b));
  const beesOut = settle?.bees > 0 && bees ? bees.qty * (settle.bees - bees.price) : 0;
  const actualOf = (opt) => ({ spot: settle.spot, opt, bees: beesOut, total: opt + beesOut });
  const actual = (pos) => {
    if (!(settle?.spot > 0)) return null;
    const e = optExpiry(pos, settle.spot);
    return actualOf(e.CE + e.PE);
  };
  const titleOf = (legs) => legs.map((l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots > 1 ? `${l.lots}× ` : ''}${l.strike} ${l.type}`).join(' · ');
  const whole = (o) => (o.r ||= priceChange(empty, { close: [], open: [...o.call.open, ...o.put.open] }, M, slip, day));
  let hindsight = null;
  if (settle?.spot > 0) {
    // each side's options at the expiry's Nifty, once
    const at = new Map();
    const side = (sd, t) => {
      if (!at.has(sd)) at.set(sd, optExpiry(priceChange(empty, { close: [], open: sd.open }, M, slip, day).next, settle.spot)[t]);
      return at.get(sd);
    };
    let best = null;
    for (const o of within.length ? within : scored) {
      const v = side(o.call, 'CE') + side(o.put, 'PE');
      if (!best || v > best.v) best = { o, v };
    }
    if (best) hindsight = { title: titleOf([...best.o.call.open, ...best.o.put.open]), actual: actualOf(best.v), up: best.o.up, downOpt: best.o.downOpt };
  }
  // a fixed trade (the strategy's rules), scored the same way and shown whatever the floors; priced even on strikes
  // the search would leave out (no volume, a wide quote), which are named
  const out1 = (o, legs, r) => ({
    id: o.id,
    title: titleOf(legs),
    // iv: the strike's IV now (the guided new trade's payoff chart prices the legs between now and the expiry with it)
    legs: legs.map((l) => ({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, fill: l.entry, ltp: M.px(l.type, l.strike), iv: M.iv(l.type, l.strike) })),
    credit: sum(legs, (l) => -l.side * l.entry * l.lots * lot),
    charges: r.charges,
    up: o.up,
    down: o.down,
    downOpt: o.downOpt,
    worst: o.worst,
    flat: o.flat,
    mid: o.mid,
    upPeak: o.upPeak ?? null,
    downPeak: o.downPeak ?? null,
    grid: grid(r.next, M, bees, S),
    actual: actual(r.next),
  });
  let rules = null;
  if (fixed?.open?.length) {
    const r = priceChange(empty, { close: [], open: fixed.open }, { ...M, notEnterable: () => null }, slip, day);
    if (r) {
      const opt = (x) => {
        const e = optExpiry(r.next, x);
        return e.CE + e.PE;
      };
      const avg = (a) => sum(a, (v) => v) / a.length;
      const dnOpt = downs.map(opt);
      const dnTot = downs.map((x, i) => dnOpt[i] + beesAt(bees, S, x));
      const peakAt = (t) => {
        const ks = fixed.open.filter((l) => l.type === t && l.side < 0).map((l) => l.strike);
        return ks.length ? Math.max(...ks.map(opt)) : null;
      };
      const o = {
        id: 'rules',
        up: avg(ups.map((x) => opt(x) + beesAt(bees, S, x))),
        downOpt: avg(dnOpt),
        down: avg(dnTot),
        worst: Math.min(...dnTot),
        flat: opt(S),
        mid: Math.min(...mids.map((x) => opt(x) + beesAt(bees, S, x))),
        upPeak: peaks ? peakAt('CE') : null,
        downPeak: peaks ? peakAt('PE') : null,
      };
      const why = fixed.open.map((l) => [l, M.notEnterable(l.type, l.strike)]).filter(([, w]) => w && w !== 'price');
      rules = {
        ...out1(o, r.next.legs, r),
        rules: true,
        label: fixed.label || 'By the rules',
        note: fixed.note || '',
        meets: { down: o.downOpt >= minDown, up: o.up >= minUp, mid: o.mid >= minMid, flat: o.flat >= minFlat, peaks: tol == null || Math.abs(o.upPeak - o.downPeak) <= tol },
        thin: why.map(([l, w]) => `${l.strike} ${l.type} (${w === 'volume' ? 'no trades today' : 'wide quote'})`),
      };
    } else rules = { rules: true, label: fixed.label || 'By the rules', missing: true, title: titleOf(fixed.open) };
  }
  return {
    tried,
    T: M.T, // years to the expiry and the ATM IV (payoff curves before the expiry)
    atmIv: M.atmIv,
    peakTol: tol,
    peaked: peaks ? peaked : null,
    rules,
    priced: scored.length,
    within: within.length,
    minDown,
    minUp,
    minMid: Number.isFinite(minMid) ? minMid : null,
    minFlat: Number.isFinite(minFlat) ? minFlat : null,
    midBand: band,
    // the most any collar keeps through the range while meeting the fall and rise floors (what a range floor can ask)
    midBest: scored.reduce((b, o) => (o.downOpt >= minDown && o.up >= minUp && o.flat >= minFlat && (b == null || o.mid > b) ? o.mid : b), null),
    hindsight,
    // one per sold-call strike, so the five are different trades, not one trade with the puts moved by 50
    list: pool
      .filter(
        (
          (seen) => (o) =>
            seen.size < n && !seen.has(o.call.key) && seen.add(o.call.key)
        )(new Set()),
      )
      .map((o) => {
        whole(o);
        return out1(o, o.r.next.legs, o.r);
      }),
  };
}

// ---------- Suggestion for the Put back spread (bt/pbs.js) ----------
// The back spread search (pbs.searchRough: every sold put K1, width W, butterfly centre and half-width, 0 … flies
// butterflies) on the expiry's live chain, only strikes traded today with a tight quote, roughly priced; the best ~300
// by the rank are then booked exactly (LTP ± slip, charges per order, STT on bought puts in the money) and scored at
// expiry like the collars' picks: up (options + NIFTYBEES on rises of 1 … 8 %), downOpt (options on falls), down
// (with NIFTYBEES), flat (options if Nifty stays), mid (lowest total within ±midBand %), and optWorst: the options'
// lowest P&L at expiry at ANY Nifty level (the user's "no loss / minimal loss"). Kept: optWorst ≥ −maxLoss (₹ for the
// whole trade); none: the least loss first. Ranked by rank: 'protect' downOpt, 'loss' optWorst, 'credit' flat, 'up'
// up. One per sold put strike, so the picks are different trades. fixed: the trade the rules pick (plan), shown first.
// settle (a past month): each pick's actual result and the hindsight best, as bestCollars.
const PBS_KEY = { protect: 'downOpt', loss: 'optWorst', credit: 'flat', up: 'up' };
function bestBackSpreads(M, { lot, lots = 1, beesQty = 0, beesPx, expiry, slip = 0.005, day = null, n = 5, maxLoss = 2500, rank = 'protect', params = {}, midBand = MID_BAND, settle = null, fixed = null } = {}) {
  const Pbs = require('./pbs');
  const S = M.spot;
  const bees = beesQty > 0 ? { qty: beesQty, price: beesPx, now: beesPx } : null;
  const empty = { legs: [], realised: { CE: 0, PE: 0 }, costs: {}, lot, expiry };
  const ups = BEST_MOVES.map((m) => S * (1 + m / 100));
  const downs = BEST_MOVES.map((m) => S * (1 - m / 100));
  const band = Math.min(10, Math.max(0.5, Number(midBand) || MID_BAND));
  const mids = Array.from({ length: Math.round(band * 20) + 1 }, (_, i) => S * (1 + (i / 10 - band) / 100));
  const key = PBS_KEY[rank] ? rank : 'protect';
  const p = Pbs.merge({
    ...params,
    lots,
    lotSize: lot,
    costs: { ...(params.costs || {}), slipPct: slip * 100 },
    pick: { ...(params.pick || {}), mode: 'search', maxLoss: maxLoss / lots, rank: key === 'up' ? 'credit' : key },
  });
  const pr = (k) => (M.exec('PE', k) > 0 && !M.notEnterable('PE', k) ? M.exec('PE', k) : null);
  const rough = Pbs.searchRough(S, p, pr, lot);
  const margin = 150 * lots;
  const pass = rough.filter((c) => c.f.worst >= -maxLoss - margin);
  const rs = (c) => Pbs.score(c.f, p.pick.rank);
  // the best by the rank within the limit, and the least-loss ones (to fill the list when few are within)
  const pool = [
    ...new Set([...pass.sort((a, b) => rs(b) - rs(a) || b.f.worst - a.f.worst).slice(0, 300), ...[...rough].sort((a, b) => b.f.worst - a.f.worst).slice(0, 200)]),
  ];
  const avg = (a) => sum(a, (v) => v) / a.length;
  const titleOf = (g) =>
    g.put != null ? `Buy ${g.put} PE` : `Sell ${g.K1} PE · buy ${2 * lots}× ${g.K2} PE${g.nf ? ` + ${g.nf * lots}× fly ${g.C - g.h}/${g.C}/${g.C + g.h}` : ''}`;
  // a structure booked and scored; null when a leg cannot be priced
  const score = (open, g, Mx = M) => {
    const r = priceChange(empty, { close: [], open }, Mx, slip, day);
    if (!r) return null;
    const opt = (x) => {
      const e = optExpiry(r.next, x);
      return e.CE + e.PE;
    };
    const ks = [...new Set(open.map((l) => l.strike))].sort((a, b) => a - b);
    const optWorst = Math.min(...[ks[0] - 500, ...ks, ks[ks.length - 1] + STEP].map(opt));
    const dnOpt = downs.map(opt);
    const dnTot = downs.map((x, i) => dnOpt[i] + beesAt(bees, S, x));
    let lowBE = null;
    for (let x = ks[0]; x > ks[0] - 5000; x -= 5)
      if (opt(x) >= 0) {
        lowBE = x;
        break;
      }
    const legs = r.next.legs;
    return {
      g,
      r,
      id: open.map((l) => `${l.side > 0 ? 'b' : 's'}${l.lots}x${l.strike}`).join(''),
      key: g.K1 ?? g.put,
      title: titleOf(g),
      legs: legs.map((l) => ({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, role: l.role, fill: l.entry, ltp: M.px(l.type, l.strike) })),
      credit: sum(legs, (l) => -l.side * l.entry * l.lots * lot),
      charges: r.charges,
      up: avg(ups.map((x) => opt(x) + beesAt(bees, S, x))),
      downOpt: avg(dnOpt),
      down: avg(dnTot),
      worst: Math.min(...dnTot),
      optWorst,
      flat: opt(S),
      mid: Math.min(...mids.map((x) => opt(x) + beesAt(bees, S, x))),
      lowBE,
      atSettle: settle?.spot > 0 ? opt(settle.spot) : null,
    };
  };
  const exact = pool.map((c) => score(Pbs.legsOf(c.g, p), c.g)).filter(Boolean);
  const within = exact.filter((o) => o.optWorst >= -maxLoss);
  const by = (a, b) => b[PBS_KEY[key]] - a[PBS_KEY[key]] || b.optWorst - a.optWorst;
  // within the limit by the rank, then the rest with the least loss first (marked over: true)
  const over = exact.filter((o) => o.optWorst < -maxLoss).sort((a, b) => b.optWorst - a.optWorst || by(a, b));
  const list = [...[...within].sort(by), ...over.map((o) => ({ ...o, over: true }))];
  const beesOut = settle?.bees > 0 && bees ? bees.qty * (settle.bees - bees.price) : 0;
  const actualOf = (opt) => (settle?.spot > 0 ? { spot: settle.spot, opt, bees: beesOut, total: opt + beesOut } : null);
  const out1 = (o) => {
    const { g, r, atSettle, ...rest } = o;
    return { ...rest, shape: g, grid: grid(r.next, M, bees, S), actual: atSettle == null ? null : actualOf(atSettle) };
  };
  let hindsight = null;
  if (settle?.spot > 0 && exact.length) {
    const h = (within.length ? within : exact).reduce((a, b) => (b.atSettle > a.atSettle ? b : a));
    hindsight = { title: h.title, actual: actualOf(h.atSettle), up: h.up, downOpt: h.downOpt };
  }
  let rules = null;
  if (fixed?.open?.length) {
    const o = score(fixed.open, fixed.g || {}, { ...M, notEnterable: () => null });
    if (o) {
      const why = fixed.open.map((l) => [l, M.notEnterable(l.type, l.strike)]).filter(([, w]) => w && w !== 'price');
      rules = {
        ...out1(o),
        title: fixed.g ? titleOf(fixed.g) : o.title,
        rules: true,
        label: fixed.label || 'By the rules',
        note: fixed.note || '',
        meets: { loss: o.optWorst >= -maxLoss },
        thin: why.map(([l, w]) => `${l.strike} ${l.type} (${w === 'volume' ? 'no trades today' : 'wide quote'})`),
      };
    } else rules = { rules: true, label: fixed.label || 'By the rules', missing: true, title: fixed.g ? titleOf(fixed.g) : 'the rules’ trade' };
  }
  const seen = new Set();
  return {
    shape: 'pbs',
    tried: rough.length,
    priced: exact.length,
    within: within.length,
    maxLoss,
    rank: key,
    midBand: band,
    flies: p.pick.flies,
    rules,
    hindsight,
    list: list
      .filter((o) => seen.size < n && !seen.has(o.key) && seen.add(o.key))
      .map(out1),
  };
}

// ---------- Adjustments: when closing or covering legs leaves the options loss-less ----------
// Options only (the NIFTYBEES left out). "Loss-less": the options' P&L at expiry (the legs closed before at the P&L
// they booked, the legs left at intrinsic value, charges, slippage and STT on bought legs in the money) is ≥ 0 at every
// Nifty level, rises and falls. Example: a sold call in profit, closed, leaves the put spread; when the call's profit
// covers what the put spread cost, nothing can lose any more. Each plan (close the sold call, cover it with a bought
// call, book the put spread and cover the call, …) is checked now at the live prices, and on the days ahead at every
// Nifty level (Black-76 at each strike's volatility now): where and when doing it makes the options loss-less.
const ADJ_DAYS = [0, 3, 7, 10, 14, 21, 28, 35];
const ADJ_SPAN = 12; // ± % of Nifty searched on each day
const ADJ_STEP = 0.25; // % steps of that search (the edges are then refined)
const ADJ_HEDGE = [50, 100, 150, 200, 250, 300, 400, 500]; // points above the sold call a covering call is bought at

// The options at expiry with Nifty at x: p = { lot, base (booked P&L, ₹), legs: [{ type, strike, side, lots, entry }] }.
function adjPayoff(p, exStt) {
  const n = p.legs.length;
  const call = p.legs.map((l) => l.type === 'CE');
  const K = p.legs.map((l) => l.strike);
  const q = p.legs.map((l) => l.side * l.lots * p.lot);
  const b = p.legs.map((l) => (l.side > 0 ? l.lots * p.lot : 0));
  const base = p.base - sum(p.legs, (l) => l.side * l.entry * l.lots * p.lot);
  return (x) => {
    let v = base;
    let stt = 0;
    for (let i = 0; i < n; i++) {
      const iv = call[i] ? (x > K[i] ? x - K[i] : 0) : x < K[i] ? K[i] - x : 0;
      v += q[i] * iv;
      stt += b[i] * iv;
    }
    return v - stt * exStt;
  };
}
// The lowest the options can end at: { min, at } (at: the Nifty level), min −Infinity when more calls are sold than
// bought (a loss without limit as Nifty rises). The payoff is straight between strikes, so it is checked at Nifty 0,
// at every strike, and 30 % above the top strike: with as many calls bought as sold, the STT on in-the-money bought
// calls still grows with Nifty, so the payoff can drift down there.
function adjMin(p, exStt) {
  const up = sum(
    p.legs.filter((l) => l.type === 'CE'),
    (l) => l.side * l.lots,
  );
  if (up < 0) return { min: -Infinity, at: Infinity };
  const f = adjPayoff(p, exStt);
  let min = Infinity;
  let at = 0;
  const ks = p.legs.map((l) => l.strike);
  for (const x of [0, ...ks, ks.length ? Math.max(...ks) * 1.3 : 0]) {
    const v = f(x);
    if (v < min) [min, at] = [v, x];
  }
  return { min, at };
}
// Option prices on day d (calendar days from now) with Nifty at x: Black-76 at each strike's volatility now (sticky
// strike) on the chain's forward moved with Nifty, plus the strike's calibration (LTP − model now) fading to the expiry;
// so on day 0 at Nifty now every strike is worth its LTP. null for a strike with no price now.
function adjPricer(M) {
  const cal = new Map();
  const calOf = (t, K) => {
    const k = t + K;
    if (!cal.has(k)) cal.set(k, legCal({ type: t, strike: K }, M));
    return cal.get(k);
  };
  return (d, x) => {
    const T = Math.max(0, M.T - d / 365);
    const F = (M.F * x) / M.spot;
    const df = Math.exp(-RATE * T);
    const fade = M.T > 0 ? T / M.T : 0;
    return (t, K) => {
      if (!(M.px(t, K) > 0)) return null;
      if (!(T > 0)) return intr({ type: t, strike: K }, x);
      return Math.max(0.05, b76(F, K, T, M.iv(t, K), t === 'CE', df) + calOf(t, K) * fade);
    };
  };
}
// A plan done at prices px: { close: [leg ids], open: [{ type, strike, side, lots }] }. Every order at the price ±
// slip with its charges. Returns the options after it (adjPayoff's p), what the closed legs made (closed, after their
// charges), the cash it takes / brings, its fills; null when a price is missing.
function adjApply(pos, plan, px, slip, day) {
  const L = pos.lot;
  const fills = [];
  const legs = [];
  let closed = 0;
  let charges = 0;
  let cash = 0;
  let openCh = 0;
  const fill = (buy, p, lots) => {
    const f = buy ? p * (1 + slip) : p * (1 - slip);
    const c = Costs.orders({ [buy ? 'buy' : 'sell']: f * lots * L, orders: 1, day });
    charges += c;
    cash += (buy ? -f : f) * lots * L - c;
    return { f, c };
  };
  for (const l of pos.legs) {
    if (!plan.close.includes(l.id)) {
      legs.push(l);
      continue;
    }
    const p = px(l.type, l.strike);
    if (p == null) return null;
    const { f, c } = fill(l.side < 0, p, l.lots);
    closed += l.side * (f - l.entry) * l.lots * L - c;
    fills.push({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, entry: l.entry, price: p, px: f, close: true });
  }
  for (const o of plan.open) {
    const p = px(o.type, o.strike);
    if (!(p > 0)) return null;
    const { f, c } = fill(o.side > 0, p, o.lots);
    openCh += c;
    legs.push({ ...o, entry: f });
    fills.push({ ...o, price: p, px: f });
  }
  const booked = pos.realised.CE + pos.realised.PE - (pos.costs?.CE || 0) - (pos.costs?.PE || 0);
  // booked: before, plus what the closed legs made, less the new legs' charges (their premium is in their entry)
  return { lot: L, base: booked + closed - openCh, legs, closed, charges, cash, fills };
}
// The plans checked on this position (options only). group: 'call' | 'put' | 'both'. hedge: a covering call bought
// above the sold call, its strike picked (ADJ_HEDGE) where it locks in the most.
function adjPlans(pos) {
  const sc = pos.legs.filter((l) => l.type === 'CE' && l.side < 0);
  const bc = pos.legs.filter((l) => l.type === 'CE' && l.side > 0);
  const puts = pos.legs.filter((l) => l.type === 'PE');
  const sp = puts.filter((l) => l.side < 0);
  const bp = puts.filter((l) => l.side > 0);
  const ids = (ls) => ls.map((l) => l.id);
  const txt = (ls) => ls.map((l) => `${l.strike}`).join(' / ');
  const naked = sum(sc, (l) => l.lots) - sum(bc, (l) => l.lots);
  const top = Math.max(...sc.map((l) => l.strike), -Infinity);
  const plans = [];
  if (sc.length) {
    plans.push({
      id: 'closeCall',
      group: 'call',
      title: `Close the sold ${txt(sc)} CE`,
      why: `Buy the sold call back. What it made must cover the rest: ${puts.length ? 'the put spread’s cost if Nifty ends above it' : 'the other legs’ worst case'}.`,
      close: ids(sc),
      open: [],
    });
    if (naked > 0)
      plans.push({
        id: 'coverCall',
        group: 'call',
        title: `Cover the sold ${txt(sc)} CE: buy a CE above it`,
        why: 'Keep the sold call and cap it with a bought call above it (a call spread): its credit, less the bought call and the gap between the strikes, must cover the rest.',
        close: [],
        hedge: { lots: naked, from: top },
      });
  }
  if (sp.length && sc.length)
    plans.push({
      id: 'closeCallSoldPut',
      group: 'both',
      title: `Close the sold ${txt(sc)} CE and buy back the sold ${txt(sp)} PE`,
      why: 'Only the bought put is left: no loss above it if the two buy-backs made more than it cost, and it gains on every fall.',
      close: ids([...sc, ...sp]),
      open: [],
    });
  if (puts.length && naked > 0)
    plans.push({
      id: 'bookPutsCover',
      group: 'put',
      title: `Book the put spread (${txt(puts)}) and cover the sold call with a CE above it`,
      why: 'Take the put spread’s profit after a fall; the sold call alone would lose without limit on a rise, so it is capped with a bought call above it.',
      close: ids(puts),
      hedge: { lots: naked, from: top },
    });
  if (pos.legs.length)
    plans.push({
      id: 'closeAll',
      group: 'both',
      title: 'Close every option leg',
      why: 'Nothing is left open: loss-less once the options as a whole are in profit.',
      close: ids(pos.legs),
      open: [],
    });
  // changes that can never be loss-less on their own (shown with why)
  const never = [];
  if (puts.length && naked > 0)
    never.push({ title: `Book the put spread (${txt(puts)}) and keep the sold call`, why: 'The sold call left alone loses without limit if Nifty rises (options only), whatever the put spread made.' });
  if (sp.length && bp.length && naked > 0)
    never.push({ title: `Buy back the sold ${txt(sp)} PE only`, why: 'More downside protection, but the sold call still loses without limit on a rise.' });
  return { plans, never };
}
// A plan at prices px: its best version (a hedged plan: the covering call that locks in the most, loss-less ones first).
// { lossless, min, at, after (adjApply), hedgeK } or null when it cannot be priced.
function adjBest(pos, plan, px, slip, day, exStt) {
  const tries = plan.hedge
    ? ADJ_HEDGE.map((h) => ({ K: plan.hedge.from + h, open: [{ type: 'CE', strike: plan.hedge.from + h, side: 1, lots: plan.hedge.lots }] }))
    : [{ K: null, open: plan.open || [] }];
  let best = null;
  for (const t of tries) {
    const after = adjApply(pos, { close: plan.close, open: t.open }, px, slip, day);
    if (!after) continue;
    const m = adjMin(after, exStt);
    if (!best || m.min > best.min) best = { lossless: m.min >= 0, min: m.min, at: m.at, after, hedgeK: t.K };
  }
  return best;
}
// ---------- loss-free now: adjustments built on each leg's P&L at the live prices ----------
const NOW_MOVES = [1, 2, 3, 4, 5, 6, 7, 8]; // % either way for the up / down averages
const NOW_WIDE = 600; // new strikes within this many points of the ATM strike
const NOW_KEEP = 12; // picks kept per ranking (diverse), the page sorts them
// Each open leg's P&L at its LTP, the legs closed before (booked), per structure (calls / puts) and in all.
function legsNow(pos, M) {
  const L = pos.lot;
  const legs = pos.legs.map((l) => {
    const ltp = M.px(l.type, l.strike);
    return { id: l.id, type: l.type, strike: l.strike, side: l.side, lots: l.lots, entry: l.entry, ltp, pnl: ltp == null ? null : l.side * (ltp - l.entry) * l.lots * L };
  });
  const booked = { CE: pos.realised.CE - (pos.costs?.CE || 0), PE: pos.realised.PE - (pos.costs?.PE || 0) };
  const of = (t) => booked[t] + sum(legs.filter((l) => l.type === t), (l) => l.pnl || 0);
  return { legs, booked, CE: of('CE'), PE: of('PE'), total: of('CE') + of('PE') };
}
// Every adjustment made now at the live prices (LTP ± slip, charges in): close any set of the open legs (none to all),
// with nothing new, one new leg (buy / sell a CE / PE within NOW_WIDE of the ATM strike), or two (a call spread, a put
// spread, a bought call + a bought put, a bought call + a sold put). Kept: those after which the options cannot lose at
// expiry anywhere (adjMin ≥ 0). Scored on the payoff at expiry: the least it locks in, the averages of Nifty up / down
// 1 … 8 %, Nifty staying, and the average over ±8 %.
function lossFreeNow(pos, M, { slip = 0.005, day = null, exStt = Costs.rates(day).exStt } = {}) {
  const S = M.spot;
  const A = atmOf(S);
  const L = pos.lot;
  const legs = pos.legs;
  const n = Math.min(legs.length, 6);
  const sets = [];
  for (let mask = 0; mask < 1 << n; mask++) sets.push(legs.filter((l, i) => i < n && mask & (1 << i)).map((l) => l.id));
  const ks = (t) => {
    const out = [];
    for (let K = A - NOW_WIDE; K <= A + NOW_WIDE; K += STEP) if (!M.notEnterable(t, K)) out.push(K);
    return out;
  };
  const CE = ks('CE');
  const PE = ks('PE');
  const leg = (type, strike, side) => ({ type, strike, side, lots: 1 });
  const adds = [[]];
  for (const K of CE) adds.push([leg('CE', K, 1)], [leg('CE', K, -1)]);
  for (const K of PE) adds.push([leg('PE', K, 1)], [leg('PE', K, -1)]);
  for (const a of CE) for (const b of CE) if (a !== b) adds.push([leg('CE', a, 1), leg('CE', b, -1)]);
  for (const a of PE) for (const b of PE) if (a !== b) adds.push([leg('PE', a, 1), leg('PE', b, -1)]);
  for (const a of CE) for (const b of PE) adds.push([leg('CE', a, 1), leg('PE', b, 1)], [leg('CE', a, 1), leg('PE', b, -1)]);
  // the new legs' lots: as many as the most lots of a leg now (one lot for a one-lot collar)
  const lots = Math.max(1, ...legs.map((l) => l.lots));
  const px = (t, K) => M.px(t, K);
  const mv = (m) => S * (1 + m / 100);
  const found = [];
  let tried = 0;
  for (const close of sets)
    for (const add of adds) {
      if (!close.length && !add.length) continue;
      const open = add.map((o) => ({ ...o, lots }));
      // a new leg at a strike the trade holds is no new idea: the opposite side is a close (listed by the closes), the
      // same side re-buys a closed leg or adds lots
      if (open.some((o) => legs.some((l) => l.type === o.type && l.strike === o.strike))) continue;
      tried++;
      const after = adjApply(pos, { close, open }, px, slip, day);
      if (!after) continue;
      const m = adjMin(after, exStt);
      if (!Number.isFinite(m.min)) continue;
      found.push({ close, open, after, min: m.min, at: m.at });
    }
  const score = (x) => {
    const f = adjPayoff(x.after, exStt);
    const up = sum(NOW_MOVES, (m) => f(mv(m))) / NOW_MOVES.length;
    const down = sum(NOW_MOVES, (m) => f(mv(-m))) / NOW_MOVES.length;
    let avg = 0;
    for (let i = 0; i <= 32; i++) avg += f(mv(-8 + i / 2));
    return { up, down, stays: f(S), avg: avg / 33, up5: f(mv(5)), down5: f(mv(-5)) };
  };
  const free = found.filter((x) => x.min >= 0);
  for (const x of free) x.s = score(x);
  const orders = (x) => x.close.length + x.open.length;
  // what each pick is (the same closes + the same kinds of new legs): at most 2 of each per ranking
  const sig = (x) => `${x.close.join(',')}|${x.open.map((o) => (o.side > 0 ? 'B' : 'S') + o.type).join(',')}`;
  const RANKS = {
    avg: (x) => x.s.avg,
    min: (x) => x.min,
    up: (x) => x.s.up,
    down: (x) => x.s.down,
    stays: (x) => x.s.stays,
    few: (x) => -orders(x) * 1e9 + x.s.avg,
  };
  const keep = new Set();
  for (const f of Object.values(RANKS)) {
    const per = new Map();
    let k = 0;
    for (const x of [...free].sort((a, b) => f(b) - f(a))) {
      if (k >= NOW_KEEP) break;
      const g = sig(x);
      if ((per.get(g) || 0) >= 2) continue;
      per.set(g, (per.get(g) || 0) + 1);
      keep.add(x);
      k++;
    }
  }
  // none loss-free: the ones that lose the least at worst (bounded ones only), 2 per kind
  const closest = [];
  if (!free.length) {
    const per = new Map();
    for (const x of [...found].sort((a, b) => b.min - a.min)) {
      if (closest.length >= 8) break;
      const g = sig(x);
      if ((per.get(g) || 0) >= 2) continue;
      per.set(g, (per.get(g) || 0) + 1);
      x.s = score(x);
      closest.push(x);
    }
  }
  const legTxt = (l) => `${l.side > 0 ? 'bought' : 'sold'} ${l.strike} ${l.type}`;
  const title = (x) => {
    const closed = legs.filter((l) => x.close.includes(l.id));
    const parts = [];
    const opens = [...x.open];
    for (const l of closed) {
      // a leg closed and one of its type and side opened: a roll
      const i = opens.findIndex((o) => o.type === l.type && o.side === l.side);
      if (i >= 0) {
        parts.push(`roll the ${legTxt(l)} → ${opens[i].strike}`);
        opens.splice(i, 1);
      } else parts.push(`close the ${legTxt(l)}`);
    }
    for (const o of opens) parts.push(`${o.side > 0 ? 'buy' : 'sell'} ${o.lots > 1 ? `${o.lots} × ` : ''}${o.strike} ${o.type}`);
    const t = parts.join(', ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const view = (x) => ({
    id: sig(x) + '|' + x.open.map((o) => o.strike).join(','),
    title: title(x),
    lossless: x.min >= 0,
    min: x.min,
    minAt: x.at,
    orders: orders(x),
    closed: x.after.closed,
    charges: x.after.charges,
    cash: x.after.cash,
    fills: x.after.fills.map((f) => ({ ...f, pnl: f.close ? f.side * (f.px - f.entry) * f.lots * L : null })),
    legs: x.after.legs.map((l) => ({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, entry: l.entry })),
    ...x.s,
    after: x.after,
  });
  return { tried, free: free.length, picks: [...keep].map(view), closest: closest.map(view) };
}
// pos, M (the live market) as the Live trade tab has them. Returns the options as they are (before), and per plan: now
// (at the live prices), what the closed legs must make (need; the sold call's buy-back price for a single leg), when it
// works (per day ahead: the Nifty ranges and the level nearest to Nifty now), and if Nifty stays, from which day.
function adjustments(pos, M, { slip = 0.005, day = null } = {}) {
  const S = M.spot;
  const exStt = Costs.rates(day).exStt;
  const pricer = adjPricer(M);
  const now = pricer(0, S);
  const booked = pos.realised.CE + pos.realised.PE - (pos.costs?.CE || 0) - (pos.costs?.PE || 0);
  const xs = [];
  for (let i = 0; i <= 60; i++) xs.push(Math.round(S * (0.85 + (0.3 * i) / 60)));
  const curveOf = (p) => {
    const f = adjPayoff(p, exStt);
    return xs.map((x) => Math.round(f(x)));
  };
  const beforeP = { lot: pos.lot, base: booked, legs: pos.legs };
  const bm = adjMin(beforeP, exStt);
  const optNow = booked + sum(pos.legs, (l) => l.side * ((M.px(l.type, l.strike) ?? l.entry) - l.entry) * l.lots * pos.lot);
  const view = (r, extra = {}) =>
    r && {
      lossless: r.lossless,
      min: Number.isFinite(r.min) ? r.min : null,
      minAt: Number.isFinite(r.at) ? r.at : null,
      hedgeK: r.hedgeK,
      closed: r.after.closed,
      charges: r.after.charges,
      cash: r.after.cash,
      fills: r.after.fills,
      legs: r.after.legs.map((l) => ({ type: l.type, strike: l.strike, side: l.side, lots: l.lots, entry: l.entry })),
      curve: curveOf(r.after),
      ...extra,
    };
  const calLeft = M.T * 365 - 0.5; // calendar days to the expiry's close
  const days = ADJ_DAYS.filter((d) => d === 0 || d < calLeft);
  const dateOf = (d) => (day ? new Date(Date.parse(day + 'T00:00:00Z') + d * 86400_000).toISOString().slice(0, 10) : null);
  const { plans, never } = adjPlans(pos);
  const out = [];
  for (const plan of plans) {
    const ok = (d, m) => adjBest(pos, plan, pricer(d, S * (1 + m / 100)), slip, day, exStt)?.lossless || false;
    const r0 = adjBest(pos, plan, now, slip, day, exStt);
    // what the closed legs must make, the legs left kept from their entries (no new legs only)
    let need = null;
    if (!plan.hedge) {
      const rest = { lot: pos.lot, base: booked, legs: pos.legs.filter((l) => !plan.close.includes(l.id)) };
      const m = adjMin(rest, exStt).min;
      need = { profit: Number.isFinite(m) ? Math.max(0, -m) : null, restMin: Number.isFinite(m) ? m : null };
      // one leg closed: the price to buy it back at (or sell it at) for that profit, slippage and charges in
      const cl = pos.legs.filter((l) => plan.close.includes(l.id));
      if (cl.length === 1 && need.profit != null) {
        const l = cl[0];
        const made = (p) => adjApply(pos, plan, () => p, slip, day).closed;
        // what the leg makes falls as its price rises when it was sold, and rises when it was bought
        let lo = 0.05;
        let hi = Math.max(l.entry * 5, 1000);
        const good = (p) => made(p) >= need.profit;
        if (l.side < 0 ? good(lo) : good(hi)) {
          for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            if (good(mid) === l.side < 0) lo = mid;
            else hi = mid;
          }
          need.price = (lo + hi) / 2;
        } else need.price = null; // not even at ₹0.05
        need.leg = { type: l.type, strike: l.strike, side: l.side, entry: l.entry, ltp: M.px(l.type, l.strike) };
      }
    }
    // per day: the Nifty moves (−ADJ_SPAN … +ADJ_SPAN %) at which doing it makes the options loss-less, as ranges
    const when = [];
    for (const d of days) {
      const ms = [];
      for (let m = -ADJ_SPAN; m <= ADJ_SPAN + 1e-9; m += ADJ_STEP) ms.push(Math.round(m * 100) / 100);
      const pass = ms.map((m) => ok(d, m));
      const edge = (a, b) => {
        // a passes, b fails: the move between them where it stops working
        for (let i = 0; i < 14; i++) {
          const mid = (a + b) / 2;
          if (ok(d, mid)) a = mid;
          else b = mid;
        }
        return a;
      };
      const ranges = [];
      for (let i = 0; i < ms.length; i++) {
        if (!pass[i] || (i && pass[i - 1])) continue;
        let j = i;
        while (j + 1 < ms.length && pass[j + 1]) j++;
        ranges.push({ from: i === 0 ? null : edge(ms[i], ms[i - 1]), to: j === ms.length - 1 ? null : edge(ms[j], ms[j + 1]) });
        i = j;
      }
      // the level nearest to Nifty now where it works
      let trig = null;
      for (const g of ranges) {
        const lo = g.from ?? -ADJ_SPAN;
        const hi = g.to ?? ADJ_SPAN;
        const m = lo <= 0 && hi >= 0 ? 0 : lo > 0 ? lo : hi;
        if (trig == null || Math.abs(m) < Math.abs(trig)) trig = m;
      }
      const at = trig == null ? null : view(adjBest(pos, plan, pricer(d, S * (1 + trig / 100)), slip, day, exStt), { m: trig, x: S * (1 + trig / 100), days: d });
      when.push({
        days: d,
        date: dateOf(d),
        ranges: ranges.map((g) => ({ from: g.from == null ? null : { m: g.from, x: S * (1 + g.from / 100) }, to: g.to == null ? null : { m: g.to, x: S * (1 + g.to / 100) } })),
        trigger: at,
      });
    }
    // Nifty where it is: the first day it works on time decay alone
    let stays = null;
    for (let d = 0; d < calLeft; d++)
      if (ok(d, 0)) {
        stays = { days: d, date: dateOf(d) };
        break;
      }
    out.push({
      id: plan.id,
      group: plan.group,
      title: plan.title,
      why: plan.why,
      hedge: Boolean(plan.hedge),
      need,
      now: view(r0, { m: 0, x: S, days: 0 }),
      when,
      stays,
      possible: Boolean(r0?.lossless) || when.some((w) => w.ranges.length),
    });
  }
  // loss-free now: built on each leg's P&L at the live prices
  const ln = lossFreeNow(pos, M, { slip, day, exStt });
  const pick = ({ after, ...v }) => ({ ...v, curve: curveOf(after) });
  return {
    spot: S,
    expiry: pos.expiry,
    xs,
    days,
    legsNow: legsNow(pos, M),
    lossFree: { tried: ln.tried, free: ln.free, picks: ln.picks.map(pick), closest: ln.closest.map(pick) },
    before: { min: Number.isFinite(bm.min) ? bm.min : null, minAt: Number.isFinite(bm.at) ? bm.at : null, unboundedUp: !Number.isFinite(bm.min), curve: curveOf(beforeP), optNow },
    plans: out,
    never,
  };
}

module.exports = {
  adjustments,
  lossFreeNow,
  legsNow,
  adjPayoff,
  adjMin,
  bestCollars,
  bestBackSpreads,
  BEST_MOVES,
  MOVES,
  RELIABLE,
  WORST_TOL,
  PROTECT,
  SPREAD,
  fromBuilder,
  beesOfSnap,
  beesPerNifty,
  closeSaved,
  reopenSaved,
  fromPaper,
  looksMcc,
  looksPsc,
  looksBpc,
  looksPbs,
  SHAPES,
  kindOf,
  kindOfTrade,
  yearsTo,
  markOf,
  market,
  optExpiry,
  optToday,
  valueToday,
  legCal,
  beesAt,
  beesCover,
  grid,
  pastMoves,
  candidates,
  priceChange,
  keepsRisk,
  judge,
  keepsWorst,
  holdStats,
  suggest,
  applyView,
  studyRules,
  studyCurrent,
  studyRows,
  legText,
};
