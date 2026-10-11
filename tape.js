// Market tape: an all-day recording of the nearest-expiry snapshots, so any day can be replayed.
// One gzipped JSON line per snapshot (at most one per TAPE_EVERY_MS), in exactly the shape the
// signal/flow engines use as history: { t, spot, d: { strike: [ceLtp, ceVol, ceOi, peLtp, peVol, peOi] } }.
// Each server run writes its own part file (tape-HHMMSS.jsonl.gz); readTape() joins them in order.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { istDate, istTime } = require('./lib/time');

function createTape({ dir, everyMs = 1000, strikesAround = 15, logError }) {
  let out = null; // { day, gz }
  let lastAt = 0;
  let flushTimer = null;

  function open(t) {
    const day = istDate(t);
    if (out?.day === day) return out;
    close();
    const folder = path.join(dir, day);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `tape-${istTime(t).replace(/:/g, '')}.jsonl.gz`);
    const gz = zlib.createGzip({ level: 6 });
    const ws = fs.createWriteStream(file, { flags: 'a' });
    gz.pipe(ws);
    gz.on('error', (e) => logError('tape', e));
    out = { day, gz, ws, file };
    // Flush every 15 s so a crash loses at most a few seconds.
    flushTimer = setInterval(() => out?.gz.flush(), 15_000);
    return out;
  }

  // Finish the current part file; done() runs once it is fully written to disk.
  function close(done) {
    clearInterval(flushTimer);
    if (!out) return done?.();
    if (done) out.ws.on('finish', done);
    out.gz.end();
    out = null;
  }

  return {
    // Record one snapshot (strikes within ±strikesAround of ATM).
    record(entry, snap) {
      if (entry.t - lastAt < everyMs || entry.spot == null) return;
      lastAt = entry.t;
      try {
        const rows = snap.rows;
        let atm = 0;
        rows.forEach((r, i) => {
          if (Math.abs(r.strike - snap.spot) < Math.abs(rows[atm].strike - snap.spot)) atm = i;
        });
        const d = {};
        for (const r of rows.slice(Math.max(0, atm - strikesAround), atm + strikesAround + 1)) d[r.strike] = entry.d[r.strike];
        open(entry.t).gz.write(JSON.stringify({ t: entry.t, spot: entry.spot, x: snap.expiry, d }) + '\n');
      } catch (e) {
        logError('tape', e);
      }
    },
    close,
  };
}

// All snapshots recorded for one day (oldest first).
function readTape(dir, day) {
  const folder = path.join(dir, day);
  let parts = [];
  try {
    parts = fs
      .readdirSync(folder)
      .filter((f) => /^tape-\d{6}\.jsonl\.gz$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const f of parts) {
    let text = '';
    try {
      // finishFlush tolerates a part whose writer was killed before closing it
      text = zlib.gunzipSync(fs.readFileSync(path.join(folder, f)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* partial last line */
      }
    }
  }
  return entries.sort((a, b) => a.t - b.t);
}

// Days that have a tape, newest first.
function tapeDays(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .filter((d) => fs.readdirSync(path.join(dir, d)).some((f) => f.startsWith('tape-')))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// Rebuild the engine inputs from tape entries: a rolling history plus a minimal snapshot.
function* replaySnapshots(entries, historyMs = 17 * 60_000) {
  const hist = [];
  for (const e of entries) {
    hist.push(e);
    while (hist.length && e.t - hist[0].t > historyMs) hist.shift();
    const rows = Object.keys(e.d)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => {
        const v = e.d[k] || [];
        return { strike: k, ce: { ltp: v[0] }, pe: { ltp: v[3] } };
      });
    yield { hist, snap: { expiry: e.x, updatedAt: e.t, spot: e.spot, rows } };
  }
}

module.exports = { createTape, readTape, tapeDays, replaySnapshots };
