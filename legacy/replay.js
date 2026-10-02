// Replay a recorded day (events/<date>/tape-*.jsonl.gz) through the Volume Flow prediction logic.
//
// Used by the server (/api/flow-replay, the "Day" picker on the Volume Flow tab) and from the command line:
//   node replay.js 2026-10-01                         replay with the settings in .env
//   node replay.js 2026-10-01 --imbalance 0.3 --holdSec 20 --reactPts 10 --horizonMin 5 --minQty 80000
//   node replay.js 2026-10-01 --mode volume           mode: aggressor (default) | premium | volume
//   node replay.js 2026-10-01 --sweep                 compare modes x share % x hold time
//   add --demo to read events-demo/ instead of events/
// Results are written to replays/<date>_<settings>.csv (same columns as predictions.csv).
const fs = require('fs');
const path = require('path');
const { createFlow, flowConfig, CSV_HEADER, predictionRow } = require('./flow');
const { readTape, replaySnapshots } = require('./tape');

function replayFlow(dir, day, cfg) {
  const entries = readTape(dir, day);
  const errors = [];
  const flow = createFlow({ ...cfg, replay: true }, (src, e) => errors.push(`${src}: ${e?.message || e}`));
  for (const { hist, snap } of replaySnapshots(entries)) flow.onSnapshot(hist, snap);
  const st = flow.state();

  // What the live run recorded that day, for comparison.
  let recorded = null;
  try {
    const live = fs.readFileSync(path.join(dir, day, 'predictions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    recorded = { total: live.length, hit: live.filter((p) => p.result === 'hit').length, miss: live.filter((p) => p.result === 'miss').length };
  } catch { /* no live predictions that day */ }

  return {
    day,
    rules: st.rules,
    stats: st.stats,
    predictions: st.predictions,
    series: flow.series(),
    tape: { snapshots: entries.length, from: entries[0]?.t ?? null, to: entries[entries.length - 1]?.t ?? null },
    recorded,
    errors: errors.slice(0, 5),
  };
}

module.exports = { replayFlow };

// ---------- command line ----------
if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));
  const args = process.argv.slice(2);
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!day) {
    console.log('Usage: node replay.js YYYY-MM-DD [--imbalance 0.2] [--holdSec 10] [--minQty 50000] [--reactPts 8] [--horizonMin 3] [--sweep] [--demo]');
    process.exit(1);
  }
  const dir = path.join(__dirname, args.includes('--demo') ? 'events-demo' : 'events');
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : undefined; };
  const keys = ['imbalance', 'holdSec', 'minQty', 'reactPts', 'horizonMin'];
  const base = Object.fromEntries(keys.map((k) => [k, opt(k)]));
  const mi = args.indexOf('--mode');
  if (mi >= 0) base.mode = args[mi + 1];
  const pct = (x) => (x == null ? '  —  ' : `${x.toFixed(0).padStart(3)}%`);

  if (args.includes('--sweep')) {
    console.log(`Sweep for ${day} (reactPts/horizon/minQty from .env or flags)\n`);
    console.log('mode       share≥  hold   preds  hit  miss  flat  hit-rate  UP     DOWN');
    for (const mode of base.mode ? [base.mode] : ['aggressor', 'premium', 'volume']) {
      for (const imbalance of [0.1, 0.2, 0.3, 0.4]) {
        for (const holdSec of [5, 10, 20]) {
          const r = replayFlow(dir, day, flowConfig(process.env, { ...base, mode, imbalance, holdSec }));
          const s = r.stats;
          console.log(`${mode.padEnd(9)}  ${String(50 + imbalance * 50).padStart(4)}%  ${String(holdSec).padStart(4)}s  ${String(s.total).padStart(5)}  ${String(s.hit).padStart(3)}  ${String(s.miss).padStart(4)}  ${String(s.flat).padStart(4)}  ${pct(s.hitRate).padStart(8)}  ${pct(s.up.hitRate)}  ${pct(s.down.hitRate)}`);
        }
      }
    }
    process.exit(0);
  }

  const cfg = flowConfig(process.env, base);
  const r = replayFlow(dir, day, cfg);
  if (!r.tape.snapshots) {
    console.log(`No tape recorded for ${day} in ${dir}`);
    process.exit(1);
  }
  const tag = [`mode-${cfg.mode}`, ...keys.map((k) => `${k}-${cfg[k]}`)].join('_');
  fs.mkdirSync(path.join(__dirname, 'replays'), { recursive: true });
  const out = path.join(__dirname, 'replays', `${day}_${tag}.csv`);
  fs.writeFileSync(out, '﻿' + [CSV_HEADER.join(','), ...[...r.predictions].reverse().map(predictionRow)].join('\n') + '\n');

  const s = r.stats;
  const t = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 19);
  console.log(`Replayed ${day}: ${r.tape.snapshots} snapshots, ${t(r.tape.from)}–${t(r.tape.to)} IST`);
  console.log(`Settings: mode ${cfg.mode}, bull/bear share ≥ ${50 + cfg.imbalance * 50}% for ${cfg.holdSec}s, min ${cfg.minQty} in 1m, HIT/MISS at ${cfg.reactPts} pts, horizon ${cfg.horizonMin}m`);
  console.log(`Predictions ${s.total}: ${s.hit} hit, ${s.miss} miss, ${s.flat} flat, ${s.pending} unfinished — hit rate ${pct(s.hitRate)}`);
  console.log(`UP ${s.up.hit}/${s.up.hit + s.up.miss} (${pct(s.up.hitRate)})   DOWN ${s.down.hit}/${s.down.hit + s.down.miss} (${pct(s.down.hitRate)})`);
  if (r.recorded) console.log(`Live run that day recorded ${r.recorded.total} predictions (${r.recorded.hit} hit, ${r.recorded.miss} miss)`);
  if (r.errors.length) console.log('Errors:', r.errors);
  console.log(`Saved ${path.relative(__dirname, out)}`);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
