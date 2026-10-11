// Quote scan on a synthetic tape: a box that stays cheap at the bid / ask for 15 seconds is fillable after the
// latency and pays; one that is there for a single snapshot (quotes out of step) is a signal and nothing more.
// The tape is made up to exercise the checks — it says nothing about the real market.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const A = require('../bt/anomalies');
const { runTapeScan, tapeDays, chainOf } = require('../bt/tapescan');

const DAY = '2026-01-12'; // Monday
const EXPIRY = '2026-01-13';
const SPOT = 24000;
const T0 = Date.parse(DAY + 'T04:30:00Z'); // 10:00:00 IST
const KS = Array.from({ length: 31 }, (_, i) => SPOT + (i - 15) * 50);

// One snapshot: fair Black-76 quotes 0.5 wide; `off(k, type)` shifts a contract's whole quote. `qty` adds the
// best-level quantities newer tapes carry.
function snap(sec, off = () => 0, qty = null) {
  const t = T0 + sec * 1000;
  const m = 45 + sec / 60;
  const ty = A.tradingYears(EXPIRY, DAY, m);
  const df = Math.exp(-A.RATE * A.calendarYears(EXPIRY, DAY, m));
  const d = {};
  for (const k of KS) {
    const px = (type) => A.b76(SPOT / df, k, ty, 0.14, type === 'CE', df) + off(k, type);
    const [c, p] = [px('CE'), px('PE')];
    const bid = (x) => +Math.max(0.05, x - 0.25).toFixed(2);
    const ask = (x) => +(x + 0.25).toFixed(2);
    d[k] = [c, 65e5, 65e5, p, 65e5, 65e5, 0, 0, 0, 0, bid(c), ask(c), 1e5, 1e5, bid(p), ask(p), 1e5, 1e5, ...(qty ? [qty, qty, qty, qty] : [])];
  }
  return { t, spot: SPOT, x: EXPIRY, d };
}
function writeTape(snaps, name = 'tape-100000.jsonl.gz') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapescan-'));
  fs.mkdirSync(path.join(dir, DAY));
  fs.writeFileSync(path.join(dir, DAY, name), zlib.gzipSync(snaps.map((s) => JSON.stringify(s)).join('\n') + '\n'));
  return dir;
}

test('a box that stays cheap at the bid / ask is fillable; one snapshot out of step is not', async () => {
  const snaps = [];
  for (let s = 0; s <= 40; s++) {
    snaps.push(
      snap(s, (k, type) => {
        if (k === 24100 && type === 'PE' && s >= 5 && s <= 20) return -8; // offered 8 too low for 15 seconds
        if (k === 23900 && type === 'PE' && s === 30) return -8; // and another one for a single snapshot
        return 0;
      }),
    );
  }
  const dir = writeTape(snaps);
  try {
    assert.deepEqual(tapeDays(dir), [DAY]);
    const r = await runTapeScan(dir, {
      types: [
        { id: 'box', params: {} },
        { id: 'cal', params: {} },
      ],
      latency: 3,
      lots: 10,
      lotSize: 65,
    });
    assert.equal(r.opts.source, 'quotes');
    assert.equal(r.opts.depth, false, 'this tape has no quantities');
    assert.deepEqual(
      r.opts.types.map((t) => t.id),
      ['box'],
      'the calendar needs the next expiry, which is not recorded',
    );
    assert.deepEqual(r.skipped, []);
    const real = r.hits.filter((h) => h.ref === 24100 || h.strike === 24100);
    const blip = r.hits.filter((h) => h.ref === 23900 || h.strike === 23900);
    assert.ok(real.length >= 1 && blip.length >= 1 && real.length + blip.length === r.hits.length, JSON.stringify(r.hits.map((h) => h.text)));
    for (const h of real) {
      assert.equal(h.time, '10:00:05');
      assert.equal(h.cls, 'arb');
      // 8 points less four half-spreads of 0.25 (and the discounting of a bought box)
      assert.ok(h.value > 6.8 && h.value < 7.05, String(h.value)); // quotes are rounded to paise
      assert.equal(h.out.life, 15, 'gone when the quote came back');
      assert.equal(h.out.alive, false);
      assert.ok(Math.abs(h.out.at - h.value) < 0.05, 'the same edge 3 seconds later');
      assert.ok(Math.abs(h.out.lock - (h.out.at * 650 - h.out.cost)) < 5, 'edge x quantity - costs (the edge is shown to 2 decimals)');
      assert.ok(h.out.lock > 0 && h.out.cost > 80, 'pays after 4 orders, taxes and the STT on the legs that settle in the money');
      assert.equal(h.out.entry.length, 4);
      assert.equal(h.fit, null);
    }
    for (const h of blip) {
      assert.equal(h.time, '10:00:30');
      assert.deepEqual([h.out.life, h.out.alive, h.out.at, h.out.lock], [0, false, null, null]);
    }
    const s = r.summary.find((x) => x.type === 'box');
    assert.deepEqual([s.hits, s.fill, s.pay], [r.hits.length, real.length, real.length]);
    assert.ok(s.valid.lock > 0);

    // no latency: whatever is seen counts as filled at once, the blip too
    const r0 = await runTapeScan(dir, { types: [{ id: 'box', params: {} }], latency: 0, lots: 10, lotSize: 65 });
    assert.equal(r0.summary[0].fill, r0.hits.length);
    // a day without a tape is not scanned; no types left is an error
    await assert.rejects(runTapeScan(dir, { types: [{ id: 'box', params: {} }], days: ['2026-01-09'] }), /No recorded sessions/);
    await assert.rejects(runTapeScan(dir, { types: [{ id: 'cal', params: {} }] }), /Pick at least one type/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tapes: quantities are used when recorded, quote-less and after-hours snapshots are ignored', async () => {
  // newer tapes carry the quantity at the best bid / ask: 3 lots on every side
  const c = chainOf(
    snap(0, () => 0, 195),
    65,
  );
  assert.equal(c.depth, true);
  assert.equal(c.quoteQty(24000, 'CE', 'ask'), 195);
  assert.equal(chainOf(snap(0), 65).depth, false);
  // a snapshot recorded while the tick feed was down has prices but no quotes
  const bare = snap(0);
  for (const k of KS) bare.d[k] = bare.d[k].slice(0, 6);
  assert.equal(chainOf(bare, 65), null);

  const cheap = (k, type) => (k === 24100 && type === 'PE' ? -8 : 0);
  const snaps = [];
  for (let s = 0; s <= 12; s++) snaps.push(snap(s, cheap, 195));
  for (let s = 0; s <= 12; s++) snaps.push({ ...snap(s, cheap, 195), t: Date.parse(DAY + 'T11:00:00Z') + s * 1000 }); // 16:30 IST: the frozen closing quotes
  const dir = writeTape(snaps);
  try {
    const r = await runTapeScan(dir, { types: [{ id: 'box', params: {} }], latency: 3, lots: 10, lotSize: 65 });
    assert.equal(r.opts.depth, true);
    assert.ok(r.hits.length >= 1 && r.hits.every((h) => h.time < '10:01:00'), 'nothing from after the close');
    assert.ok(
      r.hits.every((h) => h.fit === 3 && h.out.at > 0 && h.out.alive),
      'still there when the recording ended',
    );
    // more lots wanted than the book shows: no signal at all
    const big = await runTapeScan(dir, { types: [{ id: 'box', params: {} }], quality: { minLots: 5 }, lotSize: 65 });
    assert.deepEqual(big.hits, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // a folder with no weekday session recording
  const empty = writeTape([snap(0)], 'tape-203000.jsonl.gz');
  try {
    assert.deepEqual(tapeDays(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
