// Strategies › Back spread: the back spread + 2 butterflies of Live › Ideas › Back spreads, backtested for every
// selection at once. Each row is one side (put = bearish, call = bullish), one butterfly form (butterfly = all puts /
// all calls, iron fly = CE and PE strikes), one strike window (every leg within ATM ±
// win strikes), one expiry cycle (weekly or monthly) and one entry: the start of the expiry's series (the trading day
// after the previous expiry of that cycle) or n trading days before it, 09:20, held to expiry (15:20). At every
// entry the engine picks the best strikes inside the window from that minute's prices (strategy.pick,
// lib/backspread.js), so each trade can use a different width and centre. Only options that traded in the 15 minutes
// up to entry are picked, and every fill pays at least a tick of slippage. The last result is saved in
// bt-data/backspread.json and shown again when the screen opens.
const fs = require('fs');
const path = require('path');
const { runBacktest: runRaw, wholeStrategyStops } = require('./engine');
const { computeStats } = require('./metrics');
const BS = require('../lib/backspread');

// stop-losses judge the whole strategy, never a single leg (as on the Backtest screen)
const runBacktest = (data, strategy, ...rest) => runRaw(data, wholeStrategyStops(strategy), ...rest);
const SIDES = { PE: 'Put back spread', CE: 'Call back spread' };
const FORM = { same: '2 single-type butterflies', iron: '2 iron butterflies' };
// Realistic fills: every option picked must have traded in the FRESH minutes up to entry (not a price carried forward),
// and every fill pays at least one tick (₹0.05) of slippage, however cheap the option.
const FRESH = 15;
// Entries: the start of the series, or trading days before expiry. 5 days or more only fit a monthly cycle: a weekly
// series is about 5 trading days long, so "this week" legs would trade the expiry before.
const ENTRIES = ['start', 0, 1, 2, 3, 4, 5, 10, 15];
const WEEKLY_MAX_DTE = 4;
const MIN_SLIP = 0.05;

// The strategy of one selection; units = lots of the whole structure (sell 1 / buy 2 back spread + 2 butterflies).
const entryName = (dte) => (dte === 'start' ? 'expiry start' : dte === 0 ? 'expiry day' : `${dte}d before expiry`);
// maxLoss: ₹ for the whole trade (all units) the picked strikes may lose at worst at expiry, costs included; 0 = any.
function strategyOf({ side, win, widths, form, rank, dte, expiry = 'weekly', units = 1, sl = 0, maxLoss = 0 }) {
  return {
    name: `${SIDES[side]} + ${FORM[form]} · ATM ±${win} · ${expiry} · ${entryName(dte)}`,
    desc: `Back spread + 2 butterflies, every leg within ATM ± ${win} strikes, the best strikes picked at entry by ${BS.RANKS[rank][0].toLowerCase()} (widths ${widths.join(' / ')})${maxLoss ? `, only those that lose at most ₹${maxLoss} at worst` : ''}.`,
    category: 'Back spread',
    mode: 'positional',
    expiry,
    // expiry start: the trading day after the previous expiry of the cycle (engine entry.after = 1)
    entry: dte === 'start' ? { time: '09:20', dteDays: 0, after: 1 } : { time: '09:20', dteDays: dte },
    exit: { time: '15:20', dteDays: 0 },
    legs: BS.roles(side, form).map((r) => ({
      action: r.act,
      type: r.type,
      lots: r.n * units,
      expiry: expiry === 'monthly' ? 'mcur' : 'cur',
      strike: { by: 'pick', role: r.role },
    })),
    pick: { kind: 'backfly', side, win, widths, form, rank, fresh: FRESH, maxLoss: maxLoss / units }, // the engine's limit is per unit
    risk: sl > 0 ? { unit: 'pct', sl } : {},
  };
}

// The selection as sent by the page, cleaned.
function cleanSel(b) {
  const pickList = (xs, ok, def) => {
    const v = (Array.isArray(xs) ? xs : []).filter((x) => ok.includes(x));
    return v.length ? [...new Set(v)] : def;
  };
  return {
    sides: pickList(b?.sides, ['PE', 'CE'], ['PE', 'CE']),
    wins: pickList((b?.wins || []).map(Number), BS.WINDOWS, [5, 10, 15, 20]).sort((a, b) => a - b),
    widths: pickList((b?.widths || []).map(Number), BS.WIDTHS, BS.WIDTHS).sort((a, b) => a - b),
    expiries: pickList(b?.expiries, ['weekly', 'monthly'], ['weekly']),
    dtes: pickList(
      (b?.dtes || []).map((x) => (x === 'start' ? x : Number(x))),
      ENTRIES,
      [2],
    ).sort((a, b) => ENTRIES.indexOf(a) - ENTRIES.indexOf(b)),
    forms: pickList(b?.forms || (b?.form ? [b.form] : []), BS.FORMS, ['same']),
    rank: BS.RANKS[b?.rank] ? b.rank : 'loss',
    units: Math.max(1, Math.min(20, Math.round(Number(b?.units) || 1))),
    sl: Math.max(0, Math.min(50, Number(b?.sl) || 0)),
    maxLoss: Math.max(0, Math.round(Number(b?.maxLoss) || 0)),
  };
}

// One trade as the table shows it: the strikes picked (width, centre, wings, back spread) and the result.
function tradeRow(t, side) {
  const k = (role) => t.legs.find((l) => l.strike != null && pickRole(t, l) === role)?.strike;
  const ks = t.legs.map((l) => l.strike);
  const m = k('m');
  const lo = Math.min(...ks);
  const hi = Math.max(...ks);
  return {
    in: t.entryDay,
    out: t.exitDay,
    dte: t.dte,
    spotIn: t.spotIn,
    spotOut: t.spotOut,
    W: (hi - lo) / 3,
    m,
    lo,
    hi,
    k1: k('k1'),
    k2: k('k2'),
    off: m == null ? null : Math.round((side === 'CE' ? m - t.spotIn : t.spotIn - m) * 100) / 100,
    net: Math.round(t.net),
    margin: t.margin ? Math.round(t.margin) : null,
    reason: t.reason,
    // for the replay in the Builder (BTView.replay): the expiry, entry minute, costs and every execution at its fills
    ref: t.ref,
    entryDay: t.entryDay,
    entryTime: t.entryTime,
    exitDay: t.exitDay,
    gross: t.gross,
    costs: t.costs,
    legs: t.legs.map(({ pnl, cost, entryPx, exitPx, ...x }) => x),
  };
}
// A trade leg's role: the leg definitions are BS.roles() in order, so the leg index gives it.
function pickRole(t, l) {
  return t.roles?.[l.leg] ?? null;
}

function createBackspread({ data, ext, startJob, settle, dir, logError }) {
  const file = dir ? path.join(dir, 'backspread.json') : null;
  let saved; // undefined = not read yet, null = none
  function load() {
    if (saved === undefined) {
      try {
        saved = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      } catch {
        saved = null;
      }
    }
    return saved;
  }
  function save(v) {
    saved = v;
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(v));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      logError?.('bs-save', e);
    }
  }

  function startRun(b) {
    return startJob('bs-run', async (job) => {
      const sel = cleanSel(b.sel);
      const rows = [];
      const combos = [];
      for (const expiry of sel.expiries)
        for (const form of sel.forms)
          for (const side of sel.sides)
            for (const win of sel.wins)
              for (const dte of sel.dtes) if (expiry === 'monthly' || dte === 'start' || dte <= WEEKLY_MAX_DTE) combos.push({ expiry, form, side, win, dte });
      let optsN = null;
      for (const [i, c] of combos.entries()) {
        if (job.stop) break;
        const s = strategyOf({ ...sel, ...c });
        const label = `${i + 1}/${combos.length} · ${c.expiry} · ${c.form === 'iron' ? 'Iron fly' : 'Butterfly'} · ${c.side === 'PE' ? 'Put' : 'Call'} ATM ±${c.win}, ${entryName(c.dte)} · `;
        try {
          const r = await runBacktest(
            data,
            s,
            { ...(b.opts || {}), minSlip: MIN_SLIP },
            (p) => {
              job.progress = { ...p, phase: label + p.phase };
            },
            { ...ext, stopped: () => Boolean(job.stop) },
          );
          optsN = r.opts;
          const st = computeStats(r.trades, r.opts.capital);
          const roles = BS.roles(c.side, c.form).map((x) => x.role);
          const trades = r.trades.map((t) => tradeRow({ ...t, roles }, c.side));
          rows.push({
            key: `${c.expiry}-${c.form}-${c.side}-${c.win}-${c.dte}`,
            ...c,
            name: s.name,
            strategy: s,
            stats: Object.fromEntries(Object.entries(st).filter(([, v]) => v == null || typeof v !== 'object')),
            yearly: st.yearly,
            equity: (st.equity || []).map((e) => [e.d, e.eq]),
            trades,
            skipped: r.skipped.length,
            skipReasons: r.skipped.slice(0, 5).map((x) => `${x.day}: ${x.reason}`),
          });
        } catch (e) {
          if (e.cancelled) break;
          rows.push({ key: `${c.expiry}-${c.form}-${c.side}-${c.win}-${c.dte}`, ...c, name: s.name, error: e.message });
        }
      }
      if (!rows.some((r) => !r.error)) throw new Error(rows.find((r) => r.error)?.error || 'Nothing could be backtested');
      const view = { at: Date.now(), sel, opts: optsN, rows, stopped: Boolean(job.stop) };
      save(view);
      return { view };
    });
  }

  async function handle(req, res, p, sendJson, readJson) {
    if (p === '/api/bt/bs/state') return sendJson(res, 200, { state: load() });
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
    const b = await readJson(req);
    if (p === '/api/bt/bs/run') return sendJson(res, 200, await settle(startRun(b)));
    return sendJson(res, 404, { error: 'Not found' });
  }
  return { handle };
}

module.exports = { createBackspread, strategyOf, cleanSel, ENTRIES, WEEKLY_MAX_DTE };
