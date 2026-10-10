// Backtest the signals: run recorded days (events/<date>/tape-*.jsonl.gz) through the signal logic as it
// is now, and score every signal it raises by what Nifty did next (same outcome rule as sigstats.js).
// Change signals.js or a threshold, re-run, and compare with the previous run and with what was recorded live.
//
// The server runs this file as a separate process (/api/signal-backtest, the Signal test screen),
// so live data keeps flowing and an edited signals.js is picked up without restarting. From the command line:
//   node signal-backtest.js                              every recorded day, with the settings in .env
//   node signal-backtest.js 2026-10-08                   one day (several dates can be given)
//   node signal-backtest.js --spikeRatio 4 --priceSpikePct 8 --spotFastPts 12 --spotMovePts 20 --spikeMinQty 50000 --cooldownMin 3
//   add --demo to read events-demo/ instead of events/
// The tape has one snapshot per second (live checks run every 0.5 s), so a replay can differ slightly from the live run.
const fs = require('fs');
const path = require('path');
const { createSignals, signalConfig } = require('./signals');
const { buildStats, sessionTape, tapeOutcomes, summarise, RULE } = require('./sigstats');
const { tapeDays, replaySnapshots } = require('./tape');

// Thresholds that can be overridden for a what-if run.
const TUNABLE = ['spikeRatio', 'spikeMinQty', 'broadRatio', 'broadPct', 'spotFastPts', 'spotMovePts', 'priceSpikePct', 'bothRisePct', 'cooldownMin'];

function backtestSignals(dir, days, cfg, overrides = {}) {
  const used = { ...cfg, replay: true };
  for (const k of TUNABLE) if (Number.isFinite(overrides[k]) && overrides[k] > 0) used[k] = overrides[k];
  const errors = [];
  const perDay = {};
  const dayInfo = [];
  const events = [];
  for (const day of [...days].sort()) {
    const E = sessionTape(dir, day);
    const tape = tapeOutcomes(E);
    if (!tape) continue;
    const signals = createSignals(used, (src, e) => errors.push(`${day} ${src}: ${e?.message || e}`));
    for (const { hist, snap } of replaySnapshots(E)) signals.onSnapshot(hist, snap);
    const found = signals.all().map((ev) => ({ day, t: ev.t, type: ev.type, kind: ev.kind, detail: ev.detail, spot: ev.spot, o: tape.outcome(ev.t) }))
      .sort((a, b) => a.t - b.t);
    perDay[day] = { base: tape.base, cases: found };
    events.push(...found);
    let recorded = null;
    try {
      recorded = fs.readFileSync(path.join(dir, day, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    } catch { /* nothing recorded live that day */ }
    dayInfo.push({ day, snapshots: E.length, from: E[0].t, to: E[E.length - 1].t, signals: found.length, recorded, base: tape.base });
  }
  // What the live run recorded on the same days, scored the same way.
  let recorded = [];
  try {
    recorded = buildStats(dir).forDays(dayInfo.map((d) => d.day)).map(({ perDay: _, ...o }) => o);
  } catch (e) {
    errors.push(`recorded: ${e.message}`);
  }
  return {
    days: dayInfo,
    rule: RULE,
    settings: Object.fromEntries(TUNABLE.map((k) => [k, used[k]])),
    kinds: summarise(perDay),
    recorded,
    events: events.reverse(), // newest first, like the live log
    errors: errors.slice(0, 5),
  };
}

module.exports = { backtestSignals, TUNABLE };

// ---------- command line ----------
if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));
  const args = process.argv.slice(2);
  const di = args.indexOf('--dir');
  const dir = di >= 0 ? args[di + 1] : path.join(__dirname, args.includes('--demo') ? 'events-demo' : 'events');
  const picked = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const overrides = {};
  for (const k of TUNABLE) { const i = args.indexOf('--' + k); if (i >= 0) overrides[k] = Number(args[i + 1]); }
  const r = backtestSignals(dir, picked.length ? picked : tapeDays(dir), signalConfig(process.env, dir), overrides);
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(r)); return; } // for the server
  if (!r.days.length) { console.log(`No market-hours tape found in ${dir}`); process.exit(1); }
  const T = (t) => new Date(t + 5.5 * 3600_000).toISOString().slice(11, 16);
  const pc = (x) => `${Math.round(x * 100)}%`.padStart(4);
  for (const d of r.days) {
    console.log(`${d.day}: tape ${T(d.from)}–${T(d.to)}, ${d.signals} signals now${d.recorded != null ? ` (recorded live: ${d.recorded})` : ''}`);
  }
  console.log(`Settings: ${Object.entries(r.settings).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`Outcome: Nifty moves ${r.rule.pts} pts one way before ${r.rule.pts} the other, within ${r.rule.min} min. Signals of one kind under ${r.rule.gapMin} min apart count once.\n`);
  console.log('Signal kind                                 then Nifty  hit rate    cases  any moment   recorded live');
  const live = Object.fromEntries(r.recorded.map((o) => [o.kind, o]));
  for (const o of r.kinds) {
    const l = live[o.kind];
    const was = l ? `${l.dir === 'up' ? 'rises' : 'falls'} ${pc(l.p)} ${l.hits}/${l.n}` : '—';
    console.log(`${(o.high ? '★ ' : '  ') + o.label.padEnd(42)}${(o.dir === 'up' ? 'rises' : 'falls').padEnd(11)} ${pc(o.p)}   ${`${o.hits}/${o.n}`.padStart(7)}  ${pc(o.base).padStart(10)}   ${was}`);
  }
  if (r.errors.length) console.log('\nErrors:', r.errors);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
