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
};
const KINDS = ['mcc', 'psc', 'bpc', 'nbo'];
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
  return looksPsc(legs) ? 'psc' : looksBpc(legs) ? 'bpc' : 'mcc';
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
function studyRules(study, pos, M, entrySpot, shape = 'mcc') {
  if (!study?.rows?.length) return [];
  const none = study.rows.find((r) => r.id === 'none');
  const byExp = new Map((none?.months || []).filter((m) => m.ok).map((m) => [m.expiry, m.opt]));
  const S = M.spot;
  const move = entrySpot > 0 ? (S / entrySpot - 1) * 100 : 0;
  const sold = pos.legs.filter((l) => l.side < 0);
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
      if (shape === 'psc' || shape === 'bpc') due = pscDue(r.params || {}, move, entrySpot, pos, M, shape === 'bpc');
      else if (shape === 'nbo') due = nboDue(r.params || {}, move, entrySpot, pos, M);
      else if (a.on && a.trigger === 'move' && Math.abs(move) >= a.movePct)
        due = `Nifty is ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} % since the entry (${Math.round(entrySpot)}): the rule moves the ${move > 0 ? 'sold puts up' : 'sold calls down'}${a.legs === 'all' ? ' (the whole structure)' : ''}`;
      else if (a.on && a.trigger === 'decay' && decay(a.decayPct).length)
        due = `${decay(a.decayPct)
          .map((l) => `${l.strike} ${l.type}`)
          .join(', ')} at or under ${a.decayPct} % of the premium sold: the rule rolls ${a.legs === 'all' ? 'that whole structure' : 'it'} toward Nifty`;
      return { id: r.id, label: r.label, total: Math.round(total), noneTotal: Math.round(sum([...byExp.values()], (v) => v)), beat, months: ok.length, due };
    })
    .sort((a, b) => b.total - a.total);
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

module.exports = {
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
  legText,
};
