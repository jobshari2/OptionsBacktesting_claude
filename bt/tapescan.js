// Quote scan: the scanners run over the app's own recordings of the live chain (tape.js: a snapshot a second of the
// nearest expiry, ATM ± 15 strikes, with the best bid and ask of every contract). Unlike the candle history these
// are real quotes, so an occurrence here was executable at the touch when it was seen. What the tape cannot say is
// how long an order would have taken, so each occurrence is followed:
//   signal    the bound is broken at the bid / ask (every leg passing the quality gates)
//   fillable  ... and stays broken on every snapshot for `latency` seconds, priced at the quotes at the end of them
//             (a tape snapshot joins quotes that arrived a few hundred milliseconds apart, so a violation that
//             lasts a single snapshot is usually the quotes being out of step, not a price)
//   pays      ... and what it locks in there exceeds brokerage and taxes on `lots` lots (the STT on bought legs
//             that settle in the money is estimated at the Nifty level of that moment)
// plus how long it lasted. A relative-value occurrence (fair value deviation) is entered `latency` seconds later at
// the touch and closed at the touch 5 / 15 / 30 / 60 minutes later and at the end of the session: a full round trip
// through the spread.
// Only days the app was running are covered, and tapes recorded before the best-level quantities were added to
// them carry no depth: there the "Fillable ≥ N lots" gate cannot be applied.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const A = require('./anomalies');
const Costs = require('../lib/costs');
const { IST_OFFSET, istDate, istTime, isMarketOpen } = require('../lib/time');

const HORIZONS = [5, 15, 30, 60, 'eod'];
const FOLLOW_MS = 10 * 60_000; // an arbitrage is followed for at most this long
const r2 = (x) => Math.round(x * 100) / 100;
const istMinute = (ts) => {
  const d = new Date(ts + IST_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - 555;
};
const breathe = () => new Promise((r) => setImmediate(r));

// Folders that hold recordings: the app's own and any copies kept beside it (events/_from-*).
function tapeRoots(dir) {
  let extra = [];
  try {
    extra = fs
      .readdirSync(dir)
      .filter((d) => d.startsWith('_from-'))
      .sort()
      .map((d) => path.join(dir, d));
  } catch {}
  return [dir, ...extra];
}
const partsOf = (root, day) => {
  try {
    return fs
      .readdirSync(path.join(root, day))
      .filter((f) => /^tape-\d{6}\.jsonl\.gz$/.test(f))
      .sort()
      .map((f) => path.join(root, day, f));
  } catch {
    return [];
  }
};

// Days with a recording that started during a session (a part file opened between 09:00 and 15:30 on a weekday),
// newest first. A recording that began before 09:00 and ran into the session is found when the day is scanned.
function tapeDays(dir) {
  const days = new Set();
  for (const root of tapeRoots(dir)) {
    let list = [];
    try {
      list = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } catch {}
    for (const day of list) {
      const wd = new Date(day + 'T00:00:00Z').getUTCDay();
      if (wd === 0 || wd === 6) continue;
      if (
        partsOf(root, day).some((f) => {
          const hm = path.basename(f).slice(5, 9);
          return hm >= '0900' && hm < '1530';
        })
      )
        days.add(day);
    }
  }
  return [...days].sort().reverse();
}

// The in-session snapshots of one part file, oldest first.
async function* snapshots(file) {
  const gz = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }); // tolerates a part whose writer was killed
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(gz), crlfDelay: Infinity });
  gz.on('error', () => rl.close());
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    } // partial last line
    if (e?.d && e.spot != null && isMarketOpen(e.t)) yield e;
  }
}

// The chain of one snapshot. Row: [ceLtp, ceVol, ceOi, peLtp, peVol, peOi, 4 × aggressor volume, ceBid, ceAsk,
// ceTbq, ceTsq, peBid, peAsk, peTbq, peTsq, then (newer tapes) ceBidQ, ceAskQ, peBidQ, peAskQ]. null when no
// contract carries quotes (recorded while the tick feed was down).
function chainOf(e, lot) {
  const ks = Object.keys(e.d)
    .map(Number)
    .sort((a, b) => a - b);
  if (!ks.some((k) => e.d[k]?.length >= 18)) return null;
  const col = (i) => ks.map((k) => e.d[k]?.[i] || 0);
  const day = istDate(e.t);
  const minute = istMinute(e.t);
  return new A.Chain({
    spot: e.spot,
    T: A.tradingYears(e.x, day, minute),
    Tc: A.calendarYears(e.x, day, minute),
    ks,
    ce: col(0),
    pe: col(3),
    book: true,
    lot,
    depth: ks.some((k) => e.d[k]?.length >= 22),
    ceBid: col(10),
    ceAsk: col(11),
    peBid: col(14),
    peAsk: col(15),
    ceBidQ: col(18),
    ceAskQ: col(19),
    peBidQ: col(20),
    peAskQ: col(21),
    ceVol: col(1),
    peVol: col(4),
    ceOi: col(2),
    peOi: col(5),
    expiry: e.x,
    day,
    minute: Math.floor(minute),
    open: null,
    prev: () => null,
    next: () => null,
    rv: () => null,
    dayIv: () => null,
  });
}

// ₹ of premium bought and sold by a structure at the given leg prices, for `units` of it.
function turnover(st, pxs, units) {
  let buy = 0;
  let sell = 0;
  st.forEach((l, i) => {
    if (l.act === 'B') buy += pxs[i] * l.n * units;
    else sell += pxs[i] * l.n * units;
  });
  return { buy, sell };
}
// ₹ of intrinsic value the bought legs would settle for with Nifty at `spot`.
const longIntrinsic = (st, spot, units) => st.reduce((v, l) => v + (l.act === 'B' ? Math.max(0, l.t === 'CE' ? spot - l.k : l.k - spot) * l.n * units : 0), 0);

// stopped(): true once the user pressed Stop — the scan then ends with what it has found so far.
async function runTapeScan(dir, raw, onProgress = () => {}, stopped = () => false) {
  const all = tapeDays(dir);
  const wanted = Array.isArray(raw.days) && raw.days.length ? new Set(raw.days) : null;
  const scanDays = all.filter((d) => !wanted || wanted.has(d)).sort();
  if (!scanDays.length) throw new Error('No recorded sessions: quotes are recorded on the days the app runs during market hours');
  const types = (raw.types || [])
    .filter((t) => A.BY_ID.has(t.id) && !A.BY_ID.get(t.id).needsNext)
    .map((t) => ({
      id: t.id,
      def: A.BY_ID.get(t.id),
      params: A.params(t.id, { ...t.params, ...raw.quality }),
      cooldown: Number(t.params?.cooldown) > 0 ? Number(t.params.cooldown) : A.BY_ID.get(t.id).cooldown,
    }));
  if (!types.length) throw new Error('Pick at least one type (the calendar needs the next expiry, which is not recorded)');
  const step = Math.max(1, Math.min(60, Math.round(Number(raw.every) || 5))) * 1000;
  const latency = Math.max(0, Math.min(60, Number(raw.latency) >= 0 && raw.latency !== '' && raw.latency != null ? Number(raw.latency) : 3)) * 1000;
  const lot = Math.max(1, Number(raw.lotSize) || 65);
  const lots = Math.max(1, Math.min(500, Math.round(Number(raw.lots) || 10)));
  const brokerage = Number(raw.brokerage) >= 0 && raw.brokerage !== '' && raw.brokerage != null ? Number(raw.brokerage) : Costs.BROKERAGE;
  const units = lots * lot;
  const hits = [];
  const skipped = [];
  let done = 0;
  let depth = false;

  for (const day of scanDays) {
    onProgress({ phase: `Scanning ${day}`, done, total: scanDays.length });
    await breathe();
    if (stopped()) break;
    done++;
    let seen = 0;
    for (const root of tapeRoots(dir)) {
      const parts = partsOf(root, day);
      if (!parts.length) continue;
      const lastSeen = new Map();
      let open = []; // occurrences being followed
      let lastT = 0;
      let lastDetect = 0;
      let lastCtx = null;
      let n = 0;
      for (const file of parts) {
        for await (const e of snapshots(file)) {
          if (e.t <= lastT) continue;
          lastT = e.t;
          const ctx = chainOf(e, lot);
          if (!ctx) continue;
          seen++;
          lastCtx = ctx;
          depth ||= ctx.depth;
          for (const o of open) follow(o, ctx, e.t);
          open = open.filter((o) => !o.done);
          if (e.t - lastDetect >= step) {
            lastDetect = e.t;
            for (const t of types) {
              for (const h of A.detect(t.id, ctx, t.params).slice(0, 3)) {
                const key = `${h.type}|${h.side}|${h.dir}|${h.strike}`;
                const cd = t.cooldown * 60_000;
                if (e.t - (lastSeen.get(key) ?? -1e15) < cd) {
                  lastSeen.set(key, e.t);
                  continue;
                }
                lastSeen.set(key, e.t);
                const sug = A.suggest(h, t.params);
                const rec = {
                  day,
                  t: e.t,
                  time: istTime(e.t),
                  expiry: e.x,
                  dte0: day === e.x,
                  lot,
                  spot: r2(ctx.spot),
                  atmIv: ctx.atmIv() ? r2(ctx.atmIv() * 100) : null,
                  type: h.type,
                  cls: h.cls,
                  strike: h.strike,
                  ref: h.ref ?? null,
                  side: h.side,
                  dir: h.dir,
                  value: r2(h.value),
                  unit: h.unit,
                  text: h.text,
                  arb: Boolean(h.arb),
                  fit: h.fit ?? null,
                  ...(h.fair != null ? { fair: h.fair, mkt: h.mkt, pct: h.pct } : {}),
                  legs: sug.legs,
                  out: null,
                };
                hits.push(rec);
                // an arbitrage is followed as its own legs; a relative-value signal as its suggested trade
                const st = h.cls === 'arb' ? h.st : resolve(sug.legs, h, ctx.ks);
                if (!st) continue;
                const o = { rec, st, p: t.params, pv: h.pv || 0, t0: e.t, alive: true, life: 0, arb: h.cls === 'arb' };
                if (o.arb && !latency) {
                  // no latency: filled at the quotes it was seen at
                  const f = A.fill(ctx, st, t.params);
                  if (f.ok) o.at = enterArb(o, f, f.cash + o.pv, ctx);
                }
                open.push(o);
              }
            }
          }
          if (++n % 2000 === 0) {
            await breathe();
            if (stopped()) break;
          }
        }
        if (stopped()) break;
      }
      for (const o of open) finish(o, lastCtx);
      if (seen) break; // a day is taken from one recorder only
    }
    if (!seen) skipped.push({ day, reason: 'no quotes recorded during market hours' });
  }

  // Follows one occurrence on a later snapshot.
  function follow(o, ctx, t) {
    const dt = t - o.t0;
    if (o.arb) {
      const f = A.fill(ctx, o.st, o.p);
      const edge = f.ok ? f.cash + o.pv : null;
      if (o.alive) {
        if (edge > 0) o.life = dt;
        else o.alive = false;
      }
      // fillable only if it was there on every snapshot up to the latency: quotes that flicker are out of step
      if (o.at === undefined && (dt >= latency || !o.alive)) o.at = o.alive ? enterArb(o, f, edge, ctx) : null;
      if (!o.alive || dt > FOLLOW_MS) finish(o, ctx);
      return;
    }
    if (o.at === undefined) {
      if (dt < latency) return;
      const f = A.fill(ctx, o.st, o.p);
      o.at = f.ok ? { t, cash: f.cash, pxs: f.pxs } : null;
      if (!o.at) return finish(o, ctx);
      o.rec.out = { entry: o.st.map((l, i) => ({ s: l.k, t: l.t, d: (l.act === 'B' ? 1 : -1) * l.n, px: f.pxs[i], e: ctx.expiry })) };
      return;
    }
    for (const H of HORIZONS) {
      if (H === 'eod' || o.rec.out[H] !== undefined || t - o.at.t < H * 60_000) continue;
      o.rec.out[H] = exitPts(o, ctx)?.pts ?? null;
    }
    if (t - o.at.t >= 60 * 60_000) o.wait = true; // only the end of the session is left to measure
  }
  function enterArb(o, f, edge, ctx) {
    const { buy, sell } = turnover(o.st, f.pxs, units);
    const costs = Costs.orders({ buy, sell, orders: o.st.length, day: o.rec.day, brokerage }) + Costs.exercise(longIntrinsic(o.st, ctx.spot, units), o.rec.day);
    return {
      edge: r2(edge),
      fit: f.fit,
      cost: Math.round(costs),
      lock: Math.round(edge * units - costs),
      entry: o.st.map((l, i) => ({ s: l.k, t: l.t, d: (l.act === 'B' ? 1 : -1) * l.n, px: f.pxs[i], e: ctx.expiry })),
    };
  }
  // What closing a relative-value trade at the touch makes: the reverse legs filled at this moment's quotes.
  function exitPts(o, ctx) {
    const back = o.st.map((l) => ({ ...l, act: l.act === 'B' ? 'S' : 'B' }));
    const f = A.fill(ctx, back, { ...o.p, minVol: 0, minOi: 0 });
    return f.ok ? { pts: r2(o.at.cash + f.cash), pxs: f.pxs, back } : null;
  }
  // Stops following: an arbitrage gets its lifetime and what it locked in after the latency; a relative-value
  // trade is closed at the last quotes of the session.
  function finish(o, ctx) {
    if (o.done) return;
    o.done = true;
    if (o.arb) {
      o.rec.out = {
        life: Math.round(o.life / 1000),
        alive: o.alive,
        at: o.at ? o.at.edge : null,
        lock: o.at ? o.at.lock : null,
        cost: o.at ? o.at.cost : null,
        entry: o.at ? o.at.entry : null,
        late: o.at === undefined,
      };
      return;
    }
    if (!o.at || !ctx) {
      o.rec.out = null;
      return;
    }
    for (const H of HORIZONS) if (H !== 'eod' && o.rec.out[H] === undefined) o.rec.out[H] = null;
    const x = exitPts(o, ctx);
    o.rec.out.eod = x ? x.pts : null;
    if (x) {
      const a = turnover(o.st, o.at.pxs, units);
      const b = turnover(x.back, x.pxs, units);
      o.rec.out.net = Math.round(
        x.pts * units - Costs.orders({ buy: a.buy + b.buy, sell: a.sell + b.sell, orders: 2 * o.st.length, day: o.rec.day, brokerage }),
      );
    }
  }

  const cut = scanDays[Math.floor(scanDays.length * 0.7)] || null;
  return {
    opts: {
      source: 'quotes',
      from: scanDays[0],
      to: scanDays[scanDays.length - 1],
      every: step / 1000,
      latency: latency / 1000,
      lot,
      lots,
      brokerage,
      cut,
      depth,
      types: types.map((t) => ({ id: t.id, params: t.params, cooldown: t.cooldown })),
    },
    days: stopped() ? done : scanDays.length,
    stopped: stopped(),
    daysTotal: scanDays.length,
    hits,
    summary: summarise(hits, cut),
    skipped,
    horizons: HORIZONS,
  };
}

// The suggested legs of a hit as strikes of the chain: 'signal' strikes are n strikes from the hit (or ref) strike.
function resolve(legs, h, ks) {
  const out = [];
  for (const l of legs) {
    if (l.strike.by !== 'signal' || l.expiry !== 'cur') return null;
    const base = l.strike.ref === 'ref' && h.ref != null ? h.ref : h.strike;
    const k = ks[ks.indexOf(base) + Math.round(l.strike.value || 0)];
    if (k == null) return null;
    out.push({ act: l.action, k, t: l.type, n: l.lots || 1 });
  }
  return out;
}

const fillable = (h) => h.out?.at > 0;

// Per type, in the shape of the candle scan's summary (scan.js) where the two overlap.
function summarise(hits, cut) {
  const by = {};
  const funnel = () => ({ hits: 0, fill: 0, pay: 0 });
  const count = (f, h) => {
    f.hits++;
    if (fillable(h)) {
      f.fill++;
      if (h.out.lock > 0) f.pay++;
    }
  };
  for (const h of hits) {
    const s = (by[h.type] ||= {
      type: h.type,
      cls: h.cls,
      hits: 0,
      days: new Set(),
      dirs: {},
      hours: {},
      h: {},
      fill: 0,
      pay: 0,
      sumEdge: 0,
      sumAt: 0,
      lives: [],
      valid: { lock: 0 },
      late: funnel(),
      dte0: funnel(),
      net: 0,
      netN: 0,
    });
    s.hits++;
    s.days.add(h.day);
    s.dirs[h.dir] = (s.dirs[h.dir] || 0) + 1;
    const hr = h.time.slice(0, 2);
    s.hours[hr] = (s.hours[hr] || 0) + 1;
    s.sumEdge += h.value;
    if (h.cls === 'arb') {
      if (cut && h.day >= cut) count(s.late, h);
      if (h.dte0) count(s.dte0, h);
      if (h.out) s.lives.push(h.out.life);
      if (fillable(h)) {
        s.fill++;
        s.sumAt += h.out.at;
        s.valid.lock += h.out.lock;
        if (h.out.lock > 0) s.pay++;
      }
      continue;
    }
    if (h.out?.net != null) {
      s.net += h.out.net;
      s.netN++;
    }
    for (const H of HORIZONS) {
      const v = h.out?.[H];
      if (v == null) continue;
      const b = (s.h[H] ||= { n: 0, sum: 0, wins: 0 });
      b.n++;
      b.sum += v;
      if (v > 0) b.wins++;
    }
  }
  return Object.values(by).map((s) => ({
    type: s.type,
    cls: s.cls,
    hits: s.hits,
    days: s.days.size,
    dirs: s.dirs,
    hours: s.hours,
    avgEdge: r2(s.sumEdge / s.hits),
    ...(s.cls === 'arb'
      ? {
          fill: s.fill,
          pay: s.pay,
          avgAt: s.fill ? r2(s.sumAt / s.fill) : null,
          medLife: s.lives.length ? s.lives.sort((a, b) => a - b)[s.lives.length >> 1] : null,
          valid: s.valid,
          late: s.late,
          dte0: s.dte0,
        }
      : {
          net: s.net,
          netN: s.netN,
          horizons: Object.fromEntries(
            HORIZONS.map((H) => {
              const b = s.h[H];
              return [H, b ? { n: b.n, avgPts: r2(b.sum / b.n), winRate: r2((b.wins / b.n) * 100) } : null];
            }),
          ),
        }),
  }));
}

module.exports = { runTapeScan, tapeDays, chainOf, HORIZONS };
