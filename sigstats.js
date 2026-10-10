// Track record of past signals, so a live signal can show how the same kind played out before.
//   node sigstats.js            (add --demo to read events-demo/, --rebuild to ignore the cache)
// For every stored signal (events/<day>/events.jsonl) the day's tape tells what Nifty did next: did it
// move MOVE_PTS up or MOVE_PTS down first, within HORIZON_MIN minutes? Signals are grouped by kind
// (type + CE/PE side, and for volume spikes whether buyers or sellers led the trades) and compared with
// the "any moment" rate: the same question asked every 30 s of the same days. A kind is only called
// high-probability when it clears HIGH on several days, because one trending day proves nothing.
const fs = require('fs');
const path = require('path');
const { readTape } = require('./tape');
const { istDate } = require('./lib/time');

const MIN = 60_000;
const HORIZON_MIN = 5; // how long after the signal the outcome is judged
const MOVE_PTS = 10; // outcome = which comes first: Nifty +MOVE_PTS or −MOVE_PTS
const EPISODE_GAP_MIN = 3; // signals of one kind closer than this count as one case
const MIN_CASES = 8; // below this a kind has no track record worth showing
const HIGH = { p: 0.7, cases: 15, days: 2, edge: 0.15 }; // hit rate, cases, days it held on, margin over "any moment"
const CACHE_VERSION = 1;
const CE_BUY = 6, CE_SELL = 7, PE_BUY = 8, PE_SELL = 9;

// Which kind a signal is. lead = its strongest leg ({ strike, side }), cur / m1 = snapshots now and 1 min ago.
function signalKind(type, lead, cur, m1) {
  if (type.startsWith('premium')) return lead ? `${type}:${lead.side}` : type;
  if (type !== 'strike-spike' || !lead) return type;
  const a = m1?.d[lead.strike];
  const b = cur?.d[lead.strike];
  if (!a || !b || a.length < 10 || b.length < 10) return `${type}:${lead.side}`; // no bid/ask data (polling)
  const [bi, si] = lead.side === 'CE' ? [CE_BUY, CE_SELL] : [PE_BUY, PE_SELL];
  const buy = Math.max(0, b[bi] - a[bi]);
  const sell = Math.max(0, b[si] - a[si]);
  if (!(buy + sell)) return `${type}:${lead.side}`;
  const share = buy / (buy + sell);
  return `${type}:${lead.side}:${share >= 0.55 ? 'buy' : share <= 0.45 ? 'sell' : 'mixed'}`;
}

function kindLabel(kind) {
  const [type, side, who] = kind.split(':');
  if (type === 'premium-up') return `${side} premium ▲`;
  if (type === 'premium-down') return `${side} premium ▼`;
  if (type === 'strike-spike') {
    return `${side} volume spike` + ({ buy: ', buyers leading', sell: ', sellers leading', mixed: ', buyers and sellers even' }[who] || '');
  }
  return { 'spot-up': 'Nifty ▲', 'spot-down': 'Nifty ▼', 'broad-surge': 'Broad surge', 'both-rising': 'CE + PE rising' }[type] || type;
}

// The strongest leg of a stored signal, read back from its description (legs are listed strongest first).
function leadFromDetail(ev) {
  if (ev.type === 'strike-spike') {
    const m = /(\d+) (CE|PE)/.exec(ev.detail);
    return m ? { strike: Number(m[1]), side: m[2] } : null;
  }
  if (ev.type.startsWith('premium')) {
    const m = /^(CE|PE) premium .: (\d+)/.exec(ev.detail);
    return m ? { strike: Number(m[2]), side: m[1] } : null;
  }
  return null;
}

// One recorded day: the outcome after each signal, and after every 30 s of the session (the base rate).
function analyseDay(dir, day) {
  let events;
  try {
    events = fs.readFileSync(path.join(dir, day, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
  const tape = tapeOutcomes(sessionTape(dir, day));
  if (!tape || !events.length) return null;
  const { at, outcome, base } = tape;
  const cases = [];
  for (const ev of events.sort((a, b) => a.t - b.t)) {
    const o = outcome(ev.t);
    if (o == null) continue;
    cases.push({ t: ev.t, kind: ev.kind || signalKind(ev.type, leadFromDetail(ev), at(ev.t), at(ev.t - MIN)), o });
  }
  return { base, cases };
}

// A day's tape during market hours (09:15–15:30 IST).
function sessionTape(dir, day) {
  const open = Date.parse(`${day}T09:15:00+05:30`);
  const close = Date.parse(`${day}T15:30:00+05:30`);
  return readTape(dir, day).filter((e) => e.t >= open && e.t <= close && e.spot != null);
}

// What Nifty did after any moment of a taped session, plus the day's base rate (asked every 30 s).
function tapeOutcomes(E) {
  if (E.length < 2) return null;
  const idxAt = (t) => { let lo = 0, hi = E.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].t >= t) hi = m; else lo = m + 1; } return lo; };
  const at = (t) => { const e = E[idxAt(t)]; return e.t >= t && e.t - t <= 5000 ? e : null; };
  // 1 = up first, -1 = down first, 0 = neither; null when the tape doesn't cover the whole horizon
  const outcome = (t) => {
    const e = at(t);
    const end = t + HORIZON_MIN * MIN;
    if (!e || E[E.length - 1].t < end - 5000) return null;
    for (let i = idxAt(t); i < E.length && E[i].t <= end; i++) {
      const d = E[i].spot - e.spot;
      if (d >= MOVE_PTS) return 1;
      if (d <= -MOVE_PTS) return -1;
    }
    return 0;
  };

  const base = { n: 0, up: 0, down: 0 };
  for (let t = E[0].t; t <= E[E.length - 1].t; t += 30_000) {
    const o = outcome(t);
    if (o == null) continue;
    base.n++;
    if (o > 0) base.up++; else if (o < 0) base.down++;
  }
  return { at, outcome, base };
}

// Hit rate per kind from { day: { base, cases } }, best first.
function summarise(days) {
  const kinds = {};
  for (const day of Object.keys(days).sort()) {
    const { base, cases } = days[day];
    if (!base.n) continue;
    const last = {};
    for (const c of cases) {
      if (c.o == null) continue;
      if (last[c.kind] != null && c.t - last[c.kind] < EPISODE_GAP_MIN * MIN) continue;
      last[c.kind] = c.t;
      const k = (kinds[c.kind] ||= { kind: c.kind, n: 0, up: 0, down: 0, perDay: {} });
      const d = (k.perDay[day] ||= { day, n: 0, up: 0, down: 0, baseUp: base.up / base.n, baseDown: base.down / base.n });
      for (const x of [k, d]) { x.n++; if (c.o > 0) x.up++; else if (c.o < 0) x.down++; }
    }
  }
  const out = [];
  for (const k of Object.values(kinds)) {
    const dir2 = k.up >= k.down ? 'up' : 'down';
    const baseKey = dir2 === 'up' ? 'baseUp' : 'baseDown';
    const perDay = Object.values(k.perDay).map((d) => ({ day: d.day, n: d.n, hits: d[dir2], base: d[baseKey] }));
    const hits = k[dir2];
    const p = hits / k.n;
    const base = perDay.reduce((s, d) => s + d.n * d.base, 0) / k.n; // "any moment" rate, weighted like the cases
    const solid = perDay.filter((d) => d.n >= 3);
    const high = p >= HIGH.p && k.n >= HIGH.cases && p - base >= HIGH.edge
      && solid.length >= HIGH.days && solid.every((d) => d.hits / d.n > d.base);
    out.push({
      kind: k.kind, label: kindLabel(k.kind), dir: dir2, p, hits, n: k.n, against: k[dir2 === 'up' ? 'down' : 'up'],
      base, days: perDay.length, high, pts: MOVE_PTS, min: HORIZON_MIN, perDay,
    });
  }
  return out.sort((a, b) => b.high - a.high || b.p - a.p);
}

// Track record per kind across every finished day (today is left out: it isn't over yet).
function buildStats(dir, { rebuild = false, logError = () => {} } = {}) {
  const today = istDate();
  const cacheFile = path.join(dir, 'signal-odds.json');
  let cache = { version: CACHE_VERSION, horizonMin: HORIZON_MIN, movePts: MOVE_PTS, days: {} };
  if (!rebuild) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === CACHE_VERSION && c.horizonMin === HORIZON_MIN && c.movePts === MOVE_PTS) cache = c;
    } catch { /* no cache yet */ }
  }
  let dayNames = [];
  try {
    dayNames = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today).sort();
  } catch { /* nothing recorded yet */ }
  let changed = false;
  for (const day of dayNames) {
    if (cache.days[day]) continue;
    try {
      const res = analyseDay(dir, day);
      if (res) { cache.days[day] = res; changed = true; }
    } catch (e) {
      logError('signal-odds', e);
    }
  }
  if (changed) {
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) { logError('signal-odds', e); }
  }

  const all = summarise(cache.days);
  const odds = Object.fromEntries(all.map((o) => [o.kind, o]));
  return {
    days: Object.keys(cache.days).sort(),
    all,
    // The same table for some of the days only (to compare with a backtest of those days).
    forDays: (list) => summarise(Object.fromEntries(list.filter((d) => cache.days[d]).map((d) => [d, cache.days[d]]))),
    // The track record to show on a live signal of this kind (null until there are enough cases).
    lookup(kind) {
      const o = odds[kind];
      if (!o || o.n < MIN_CASES) return null;
      const { perDay, ...rest } = o;
      return rest;
    },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = path.join(__dirname, args.includes('--demo') ? 'events-demo' : 'events');
  const stats = buildStats(dir, { rebuild: args.includes('--rebuild'), logError: (s, e) => console.error(s, e) });
  if (!stats.all.length) { console.log(`No finished days with signals and a tape in ${dir}`); process.exit(1); }
  const pc = (x) => `${Math.round(x * 100)}%`.padStart(4);
  console.log(`Days: ${stats.days.join(', ')}`);
  console.log(`Outcome: Nifty moves ${MOVE_PTS} pts one way before ${MOVE_PTS} pts the other, within ${HORIZON_MIN} min of the signal.`);
  console.log(`Cases closer than ${EPISODE_GAP_MIN} min count once. "any moment" = the same outcome at any time of those days.\n`);
  console.log('Signal kind                                 then Nifty  hit rate  cases  against  any moment  by day');
  for (const o of stats.all) {
    const byDay = o.perDay.map((d) => `${d.day.slice(5)} ${d.hits}/${d.n}`).join(', ');
    console.log(`${(o.high ? '★ ' : '  ') + o.label.padEnd(42)}${(o.dir === 'up' ? 'rises' : 'falls').padEnd(11)} ${pc(o.p)}   ${`${o.hits}/${o.n}`.padStart(7)}  ${String(o.against).padStart(5)}  ${pc(o.base).padStart(10)}   ${byDay}${o.n < MIN_CASES ? '  (too few to show live)' : ''}`);
  }
  console.log(`\n★ high probability: hit rate ≥ ${HIGH.p * 100}%, ≥ ${HIGH.cases} cases, ≥ ${HIGH.edge * 100} percentage points above "any moment", and above it on each of ≥ ${HIGH.days} days.`);
}

module.exports = { buildStats, signalKind, kindLabel, sessionTape, tapeOutcomes, summarise, RULE: { pts: MOVE_PTS, min: HORIZON_MIN, gapMin: EPISODE_GAP_MIN, high: HIGH } };
