// The Bi-weekly screen: the bi-weekly hedge, its reverse, and the two combined.
//  - Hedge / Reverse: the base strategy plus every adjustment variation of it (adjustments.js) and the built-in
//    bi-weekly variants of that family (library.js), each backtested as defined with the same settings.
//  - Combined: ONE position holding the legs of the hedge and the legs of the reverse (8 legs), entered and exited
//    together with one target / stop on the whole of it, with its own adjustment variations. Two more rows take
//    the legs of the best hedge and the best reverse variation, with the position rules of either.
// "Best" = highest net P&L among the variations whose short options stay hedged for their whole life.
// Headline numbers are kept in bt-data/biweekly.json; the trades of one variation are run when asked for.
const fs = require('fs');
const path = require('path');
const { runBacktest, normalizeStrategy } = require('./engine');
const { computeStats } = require('./metrics');
const { buildAdjustments } = require('./adjustments');
const { biweekly } = require('./library');

const FAMILIES = [
  { id: 'hedge', name: 'Bi-weekly Hedge' },
  { id: 'rev', name: 'Bi-weekly Hedge Reverse' },
];
const COMBINED = { id: 'combined', name: 'Bi-weekly Hedge + Reverse' };
const TOP = 5;

// Short options that no bought option of the same type covers for their whole life (naked shorts, a near-week
// hedge that is neither rolled nor closed with the position): the loss is not limited.
function unlimitedRisk(s) {
  const rank = { cur: 0, next: 1, mcur: 2, mnext: 3 };
  // closed on or before the near-week expiry: a near-week hedge is alive for the whole trade
  const early = s.mode === 'positional' && s.entry.after >= 2 && s.exit.dteDays >= 5 * (s.entry.after - 1);
  return ['CE', 'PE'].some((type) => {
    const shorts = s.legs.filter((l) => l.action === 'S' && l.type === type);
    if (!shorts.length) return false;
    const last = Math.max(...shorts.map((l) => rank[l.expiry]));
    const cover = s.legs.filter((l) => l.action === 'B' && l.type === type && (l.roll || early || rank[l.expiry] >= last)).reduce((n, l) => n + l.lots, 0);
    return cover < shorts.reduce((n, l) => n + l.lots, 0);
  });
}

// Which family a bi-weekly strategy belongs to: the first short leg is hedged by a bought call (hedge) or put (reverse).
function familyOf(s) {
  const h = s.legs.find((l) => l.action === 'B' && l.strike.by === 'leg' && l.strike.ref === 0);
  return h ? (h.type === 'PE' ? 'rev' : 'hedge') : null;
}

// Headline numbers of a run: the scalar statistics plus the P&L per year.
const lite = (st) => ({ ...Object.fromEntries(Object.entries(st).filter(([, v]) => v == null || typeof v !== 'object')), yearly: st.yearly });
const baseLots = (s) => Math.min(...s.legs.map((l) => l.lots));

function createBiweekly({ data, ext, dir, startJob, settle, breathe, findStrategy, library, logError }) {
  const file = path.join(dir, 'biweekly.json');
  let state = null;
  function load() {
    if (state === null) {
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        state = false;
      }
    }
    return state || null;
  }
  function save(s) {
    state = s;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(s));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      logError('bw-save', e);
    }
  }

  // strikes: null = the short strikes as each strategy defines them (by premium), or { by: 'pts', value } = both
  // short options that many points out of the money from spot, in every variation.
  const cleanStrikes = (x) => (x?.by === 'pts' && Number(x.value) >= 0 ? { by: 'pts', value: Math.min(2000, Math.round(Number(x.value))) } : null);

  // A family from its list of variations: identical ones once, each a complete named strategy.
  function family(f, base, list) {
    const seen = new Set();
    const rows = [];
    for (const v of list) {
      const { id, name, desc, category, ...rules } = v.strategy;
      const sig = JSON.stringify(rules);
      if (seen.has(sig)) continue; // e.g. a built-in that is one of the adjustment variations
      seen.add(sig);
      rows.push({
        ...v,
        strategy: {
          ...v.strategy,
          id: null,
          name: v.key === 'own' ? base.name : v.group === 'Built-in' ? v.name : `${f.name}: ${v.name}`,
          category: 'Bi-weekly',
        },
        risky: Boolean(v.risky) || unlimitedRisk(v.strategy),
      });
    }
    return { id: f.id, name: f.name, base: base.name, lots: baseLots(base), rows };
  }

  // The variations of the hedge and of the reverse, not yet backtested.
  // overlap: a new position is entered at the start of every weekly series even while the previous one (two weeks
  // long) is still open, each counted as a trade of its own; otherwise the strategies' "one at a time" rule holds.
  function families(strikes, overlap) {
    const move = (st) => {
      const c = JSON.parse(JSON.stringify(st));
      if (strikes) for (const l of c.legs) if (l.action === 'S' && l.strike.by !== 'leg') l.strike = { by: 'pts', value: strikes.value, match: 'closest' };
      if (overlap) c.entry.noOverlap = false;
      return c;
    };
    const libs = library()
      .filter((s) => s.category === 'Bi-weekly')
      .map(move);
    const bases = {
      hedge: findStrategy('my-biweekly-hari') || biweekly('bw-hedge', 'Bi-weekly Hedge', ''),
      rev: findStrategy('lib-biweekly-rev') || biweekly('bw-rev', 'Bi-weekly Hedge Reverse', '', { reverse: true }),
    };
    return FAMILIES.map((f) => {
      const base = normalizeStrategy(move(bases[f.id]));
      const list = buildAdjustments(base).filter((v) => v.group !== 'Reverse'); // the mirror image is the other family
      for (const s of libs)
        if (familyOf(s) === f.id)
          list.push({
            key: s.id,
            group: 'Built-in',
            name: s.name,
            note: strikes ? `Built-in variant, with the short strikes ${strikes.value} pts out of the money instead of chosen by premium.` : s.desc,
            strategy: normalizeStrategy(s),
          });
      return family(f, base, list);
    });
  }

  // ---------- combined: both in one position ----------
  // cfg: lots of the hedge legs and of the reverse legs, and the capital of the position (% profit, and the
  // "% of capital" target / stop, are taken on it).
  function cleanCfg(c, opts) {
    const lots = (v) => (Number(v) >= 1 ? Math.min(50, Math.round(Number(v))) : 2);
    return { capital: Number(c?.capital) > 0 ? Number(c.capital) : opts.capital || null, hedgeLots: lots(c?.hedgeLots), revLots: lots(c?.revLots) };
  }
  // One strategy: the legs of hedge variation h then those of reverse variation r, with the entry, exit and overall
  // rules of `rules` (one of the two). Each leg keeps its own stop, re-entry and roll. The entry checks are per lot
  // of the whole position, so the two net credits and the two risk limits add up.
  function merge(rules, h, r, cfg) {
    const s = JSON.parse(JSON.stringify(rules));
    const legs = (x, lots, shift) =>
      JSON.parse(JSON.stringify(x.legs)).map((l) => ({
        ...l,
        lots: Math.max(1, Math.round((l.lots / baseLots(x)) * lots)),
        strike: l.strike.by === 'leg' ? { ...l.strike, ref: l.strike.ref + shift } : l.strike,
      }));
    s.legs = [...legs(h, cfg.hedgeLots, 0), ...legs(r, cfg.revLots, h.legs.length)];
    const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    const [fh, fr] = [h.filters, r.filters];
    s.filters = {
      ...rules.filters,
      minCredit: add(fh.minCredit, fr.minCredit),
      maxLossDown: add(fh.maxLossDown ?? fh.maxLossUp, fr.maxLossDown ?? fr.maxLossUp),
      maxLossUp: add(fh.maxLossUp ?? fh.maxLossDown, fr.maxLossUp ?? fr.maxLossDown),
    };
    return normalizeStrategy(s);
  }
  function combinedFamily([h, v], cfg) {
    const own = (f) => f.rows.find((r) => r.key === 'own').strategy;
    const base = { ...merge(own(h), own(h), own(v), cfg), name: COMBINED.name };
    const list = buildAdjustments(base).filter((x) => x.group !== 'Reverse');
    const [bh, bv] = [h, v].map((f) => f.best && f.rows.find((r) => r.key === f.best));
    if (bh && bv) {
      const note = (who) =>
        `The legs of the best Hedge variation (${bh.name}) and of the best Reverse variation (${bv.name}) in one position; exit, target, stop and entry filters as in the ${who} one.`;
      list.push({
        key: 'best-h',
        group: 'Best + best',
        name: 'Best Hedge + best Reverse, position rules of the Hedge',
        note: note('Hedge'),
        strategy: merge(bh.strategy, bh.strategy, bv.strategy, cfg),
      });
      list.push({
        key: 'best-r',
        group: 'Best + best',
        name: 'Best Hedge + best Reverse, position rules of the Reverse',
        note: note('Reverse'),
        strategy: merge(bv.strategy, bh.strategy, bv.strategy, cfg),
      });
    }
    return { ...family(COMBINED, base, list), cfg };
  }

  const ranked = (rows) => rows.filter((r) => r.stats?.trades && !r.risky).sort((a, b) => b.stats.total - a.stats.total);
  const optsOf = (f, opts) => (f.cfg ? { ...opts, capital: f.cfg.capital } : opts);

  // Backtest every variation of a family and rank them. Returns the normalized settings of the runs.
  async function runFamily(job, f, opts, done, total) {
    let optsN = null;
    for (const row of f.rows) {
      job.progress = { phase: `${f.name} · ${row.name}`, done: done++, total: Math.max(total, done) };
      await breathe();
      try {
        const r = await runBacktest(data, row.strategy, optsOf(f, opts), () => {}, ext);
        optsN = r.opts;
        row.stats = lite(computeStats(r.trades, r.opts.capital));
        row.skippedCount = r.skipped.length;
      } catch (e) {
        row.error = e.message;
        logError('bw-run', e, row.key);
      }
    }
    f.top = ranked(f.rows)
      .slice(0, TOP)
      .map((r) => r.key);
    f.best = f.top[0] || null;
    return optsN;
  }

  function startRun(opts, strikesIn, overlapIn) {
    return startJob('bw-run', async (job) => {
      const strikes = cleanStrikes(strikesIn);
      const overlap = Boolean(overlapIn);
      const fams = families(strikes, overlap);
      const n = fams.reduce((a, f) => a + f.rows.length, 0);
      const total = Math.round(n * 1.5); // the combined variations are only known once the two are ranked
      let optsN = null;
      let done = 0;
      for (const f of fams) {
        optsN = (await runFamily(job, f, opts, done, total)) || optsN;
        done += f.rows.length;
      }
      // Failed for missing data (not logged in): nothing worth keeping.
      const bad = () => fams.flatMap((f) => f.rows).find((r) => r.error);
      if (!optsN) throw new Error(bad()?.error || 'Nothing could be backtested');
      const prev = load()?.families?.find((f) => f.id === COMBINED.id)?.cfg;
      fams.push(combinedFamily(fams, cleanCfg(prev, optsN)));
      await runFamily(job, fams[2], opts, done, done + fams[2].rows.length);
      const st = { at: Date.now(), optsRaw: opts, opts: optsN, strikes, overlap, families: fams };
      if (!bad()) save(st);
      else state = st;
      return { view: st };
    });
  }

  // The combined position again, with other lots / capital.
  function startCombine(cfg) {
    return startJob('bw-combine', async (job) => {
      const st = load();
      if (!st) throw new Error('Backtest the variations first');
      const two = st.families.slice(0, 2);
      const c = combinedFamily(two, cleanCfg(cfg, st.opts));
      await runFamily(job, c, st.optsRaw, 0, c.rows.length);
      const next = { ...st, families: [...two, c] };
      save(next);
      return { view: next };
    });
  }

  // Everything about one variation: trades, statistics, skipped days. The job keeps the minute-by-minute paths,
  // so /api/bt/trade serves its trades like those of any other run.
  function startDetail(b) {
    return startJob('bw-detail', async (job) => {
      const st = load();
      if (!st) throw new Error('Backtest the variations first');
      const f = st.families.find((x) => x.id === b.family);
      const row = f?.rows.find((r) => r.key === b.key);
      if (!row) throw new Error('Variation not found — backtest the variations again');
      const r = await runBacktest(
        data,
        row.strategy,
        optsOf(f, st.optsRaw),
        (p) => {
          job.progress = p;
        },
        ext,
      );
      job.paths = r.paths;
      return {
        view: {
          family: f.id,
          key: row.key,
          strategy: r.strategy,
          opts: r.opts,
          stats: computeStats(r.trades, r.opts.capital),
          trades: r.trades,
          skipped: r.skipped.slice(0, 200),
          skippedCount: r.skipped.length,
        },
      };
    });
  }

  async function handle(req, res, p, sendJson, readJson) {
    // a result saved before Combined became one position is not shown: it has to be backtested again
    if (p === '/api/bt/bw/state') {
      const st = load();
      return sendJson(res, 200, { state: st?.families?.length === 3 ? st : null });
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
    const b = await readJson(req);
    if (p === '/api/bt/bw/run') return sendJson(res, 200, await settle(startRun(b.opts || {}, b.strikes, b.overlap)));
    if (p === '/api/bt/bw/combine') return sendJson(res, 200, await settle(startCombine(b.cfg || {})));
    if (p === '/api/bt/bw/detail') return sendJson(res, 200, await settle(startDetail(b)));
    return sendJson(res, 404, { error: 'Not found' });
  }

  return { handle };
}

module.exports = { createBiweekly };
