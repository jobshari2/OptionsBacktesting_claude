// The Pulse screen's trade idea, kept as a paper trade ledger. Each time the pulse says BUY CE / BUY PE it opens a
// paper trade at the strike it named (bought at the ask plus slippage), follows that option's bid and closes it at the
// Nifty-derived target, the stop, or after `maxHoldMin`, then books the net rupee result after the same charges the
// Arbitrage screen uses (lib/costs.js). Everything is appended to <dir>/<date>/pulse-signals.jsonl:
//   { type: 'state', t, action, side, strike }            the call changed (BUY / WATCH / WAIT)
//   { type: 'entry', id, t, side, strike, px, target, stop, spot, score, why }
//   { type: 'exit',  id, t, reason, px, held, pnl, ... }  pnl = ₹ per lot after charges
// so the real, forward result of the idea is on disk — judge it from the exits, not from the wording on screen.
const fs = require('fs');
const path = require('path');
const costs = require('./lib/costs');
const { istDate } = require('./lib/time');

const MIN = 60_000;

function createSignalLog({ dir, logError = () => {}, slippage = 0.005, lot = () => 65, maxHoldMin = 15, cooldownMin = 10, minPx = 5, latencySec = 3 } = {}) {
  let day = null;
  let open = []; // trades still running
  let pending = null; // an entry decided but not yet filled: { fillAt, side, strike, play, spot, decidedAt }
  let closed = []; // today's finished trades
  let lastState = null;
  let lastEntryAt = -Infinity; // time of the last entry on either side: the cool-down also stops CE/PE flip-flopping

  function write(rec) {
    if (!dir) return;
    try {
      const folder = path.join(dir, istDate(rec.t));
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(path.join(folder, 'pulse-signals.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) {
      logError('pulse-signals', e);
    }
  }

  function newDay(t) {
    const d = istDate(t);
    if (d === day) return;
    day = d;
    open = [];
    pending = null;
    closed = [];
    lastState = null;
    lastEntryAt = -Infinity;
    // A restart must not empty the day's ledger: take back what the file already holds. A trade that was still running
    // when the server stopped has no known exit: it is closed in the file as 'restart' with no result.
    const saved = dir ? readDay(dir, d) : null;
    for (const x of saved?.trades || []) {
      lastEntryAt = Math.max(lastEntryAt, x.t);
      if (x.open) {
        write({ type: 'exit', id: x.id, t, reason: 'restart', px: null, pnl: null });
        closed.push({ ...x, open: false, reason: 'restart', exitPx: null, held: null, pnl: null });
      } else closed.push(x);
    }
  }

  const quote = (snap, tr) => {
    const o = snap.rows.find((r) => r.strike === tr.strike)?.[tr.side === 'CE' ? 'ce' : 'pe'];
    return o ? { bid: o.bid || null, ask: o.ask || null, ltp: o.ltp ?? null } : null;
  };

  // Net ₹ of one lot: bought at `tr.px`, sold at `px`.
  function net(tr, px) {
    const q = lot();
    const charges = costs.orders({ buy: tr.px * q, sell: px * q, orders: 2, day: istDate(tr.t) });
    return { gross: (px - tr.px) * q, pnl: (px - tr.px) * q - charges, charges };
  }

  function close(tr, t, reason, bid) {
    const sold = tr.exit ? { signalT: tr.exit.decidedAt, signalBid: tr.exit.bid } : {};
    const px = bid * (1 - slippage); // sold into the bid, with the user's slippage on top
    const r = net(tr, px);
    const done = { ...tr, ...sold, exitT: t, exitPx: px, reason, held: (t - tr.t) / MIN, ...r, maxBid: tr.maxBid, minBid: tr.minBid };
    open = open.filter((x) => x !== tr);
    closed.push(done);
    write({
      type: 'exit',
      id: tr.id,
      t,
      reason,
      px: +px.toFixed(2),
      signalBid: sold.signalBid ?? null,
      held: +done.held.toFixed(1),
      gross: Math.round(r.gross),
      charges: Math.round(r.charges),
      pnl: Math.round(r.pnl),
      maxBid: tr.maxBid,
      minBid: tr.minBid,
    });
  }

  // Fill the pending entry and the due exits at the quotes of this snapshot.
  function settle(t, snap) {
    if (pending && t >= pending.fillAt) {
      const p = pending;
      pending = null;
      const q = quote(snap, p);
      const raw = q?.ask || q?.ltp;
      if (raw && raw >= minPx && raw < p.play.pick.premiumTarget) {
        const px = raw * (1 + slippage);
        const tr = {
          id: `${istDate(p.decidedAt)}-${closed.length + open.length + 1}`,
          t,
          signalT: p.decidedAt,
          signalAsk: p.signalAsk,
          side: p.side,
          strike: p.strike,
          px,
          spot: p.spot,
          target: p.play.pick.premiumTarget,
          stop: p.play.pick.premiumStop,
          maxBid: q.bid ?? raw,
          minBid: q.bid ?? raw,
        };
        open.push(tr);
        write({
          type: 'entry',
          id: tr.id,
          t,
          signalT: p.decidedAt,
          side: tr.side,
          strike: tr.strike,
          px: +px.toFixed(2),
          signalAsk: p.signalAsk,
          target: +tr.target.toFixed(2),
          stop: +tr.stop.toFixed(2),
          spot: p.spot,
          score: +p.play.score.toFixed(2),
          why: p.play.reasons[0] || null,
        });
      }
    }
    for (const tr of [...open]) {
      if (!tr.exit || t < tr.exit.at) continue;
      const q = quote(snap, tr);
      if (q?.bid) close(tr, t, tr.exit.reason, q.bid);
    }
  }

  return {
    // Follow the open trades on a fresh snapshot (call on every update). A target / stop / time exit is decided on the
    // quote it sees, then filled at the bid `latencySec` later, like an order that takes a moment to reach the exchange.
    manage(t, snap) {
      newDay(t);
      settle(t, snap);
      for (const tr of [...open]) {
        const q = quote(snap, tr);
        if (!q?.bid || tr.exit) continue;
        tr.maxBid = Math.max(tr.maxBid, q.bid);
        tr.minBid = Math.min(tr.minBid, q.bid);
        const reason = q.bid >= tr.target ? 'target' : q.bid <= tr.stop ? 'stop' : t - tr.t >= maxHoldMin * MIN ? 'time' : null;
        if (reason) tr.exit = { reason, decidedAt: t, at: t + latencySec * 1000, bid: q.bid };
      }
      settle(t, snap);
    },
    // The pulse's latest call (every compute): log changes and open a paper trade on a fresh BUY.
    consider(t, play, snap, spot) {
      newDay(t);
      const st = `${play.action}|${play.leanSide || ''}|${play.pick?.strike ?? ''}`;
      if (st !== lastState) {
        lastState = st;
        write({
          type: 'state',
          t,
          action: play.action,
          side: play.leanSide,
          strike: play.pick?.strike ?? null,
          score: play.score != null ? +play.score.toFixed(2) : null,
        });
      }
      if (play.action !== 'BUY' || !play.pick) return;
      const side = play.side;
      if (open.length || pending || t - lastEntryAt < cooldownMin * MIN) return; // one paper trade at a time
      const q = quote(snap, { strike: play.pick.strike, side });
      const raw = q?.ask || q?.ltp;
      if (!raw || raw < minPx) return;
      lastEntryAt = t;
      pending = { decidedAt: t, fillAt: t + latencySec * 1000, side, strike: play.pick.strike, play, spot, signalAsk: raw };
      settle(t, snap); // no delay configured: fills now
    },
    // What the screen shows: today's ledger and its totals.
    snapshot() {
      const done = closed.filter((x) => x.pnl != null); // a trade lost to a restart has no result
      const wins = done.filter((x) => x.pnl > 0).length;
      return {
        open: open.map((x) => ({ id: x.id, t: x.t, side: x.side, strike: x.strike, px: x.px, target: x.target, stop: x.stop })),
        closed: closed.map((x) => ({
          id: x.id,
          t: x.t,
          side: x.side,
          strike: x.strike,
          px: x.px,
          exitPx: x.exitPx,
          reason: x.reason,
          held: x.held,
          pnl: x.pnl,
        })),
        n: done.length,
        wins,
        pnl: done.reduce((s, x) => s + x.pnl, 0),
      };
    },
    closedAll: () => closed,
    // Close anything still open (end of a replay).
    flush(t, snap) {
      for (const tr of [...open]) {
        const q = quote(snap, tr);
        if (q?.bid) close(tr, t, tr.exit?.reason ?? 'end', q.bid);
      }
    },
  };
}

// The saved ledger of one day (<dir>/<day>/pulse-signals.jsonl): every entry joined with its exit, oldest first.
// A trade without an exit line was still open when the log stopped. Totals count finished trades only.
function readDay(dir, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, day, 'pulse-signals.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const byId = new Map();
  for (const line of text.split('\n')) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a partial last line
    }
    if (r.type === 'entry')
      byId.set(r.id, {
        id: r.id,
        t: r.t,
        signalT: r.signalT ?? null,
        side: r.side,
        strike: r.strike,
        px: r.px,
        target: r.target,
        stop: r.stop,
        why: r.why ?? null,
        open: true,
      });
    else if (r.type === 'exit' && byId.has(r.id))
      Object.assign(byId.get(r.id), { open: false, exitT: r.t, exitPx: r.px, reason: r.reason, held: r.held, gross: r.gross, charges: r.charges, pnl: r.pnl });
  }
  const trades = [...byId.values()];
  const done = trades.filter((x) => !x.open && x.pnl != null);
  return {
    day,
    trades,
    n: done.length,
    wins: done.filter((x) => x.pnl > 0).length,
    pnl: done.reduce((a, x) => a + x.pnl, 0),
    open: trades.filter((x) => x.open).length,
  };
}

// Every day that has a saved ledger with its totals, newest first.
function listDays(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((d) => readDay(dir, d))
    .filter(Boolean)
    .map(({ day, n, wins, pnl, open }) => ({ day, n, wins, pnl, open }));
}

module.exports = { createSignalLog, readDay, listDays };
