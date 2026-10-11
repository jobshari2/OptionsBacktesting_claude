const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createData, addDays } = require('../bt/data');
const { createSync } = require('../bt/sync');
const { istDate } = require('../lib/time');

// The last twelve Tuesdays as expiries, Nifty flat at 25,000 on weekdays and strikes every 50 points: with ±2
// strikes an expiry wants 5 strikes × (call + put) = 10 contracts, each two requests (35 days in chunks of 29).
const today = istDate();
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const LAST = addDays(today, -((weekday(today) + 5) % 7 || 7));
const EXPIRIES = Array.from({ length: 12 }, (_, i) => addDays(LAST, -7 * (11 - i)));

// A data layer on an empty cache folder with Upstox faked; `calls` are the option-candle requests made.
function setup(t, { token = 'tok', failing = () => false, slow = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const upstox = {
    limiter: { stats: () => ({ requests: calls.length, lastMinute: 0, waitingSec: 0 }) },
    async bulk(p) {
      if (p.startsWith('/v2/expired-instruments/expiries')) return EXPIRIES;
      if (p.startsWith('/v2/option/contract')) return [{ expiry: addDays(today, 3), lot_size: 65 }];
      if (p.startsWith('/v3/historical-candle/')) {
        // one candle a day is enough: the rest of the day is filled from it
        const [to, from] = p.split('/').slice(-2);
        const candles = [];
        for (let d = from; d <= to; d = addDays(d, 1)) if (weekday(d) % 6) candles.push([d + 'T09:15:00+05:30', 25000, 25010, 24990, 25000]);
        return { candles };
      }
      if (p.startsWith('/v2/expired-instruments/option/contract')) {
        const expiry = p.split('expiry_date=')[1];
        return [24800, 24850, 24900, 24950, 25000, 25050, 25100, 25150, 25200].flatMap((k) =>
          ['CE', 'PE'].map((type) => ({ strike_price: k, instrument_type: type, instrument_key: `K-${expiry}-${k}${type}`, lot_size: 65 })),
        );
      }
      if (p.startsWith('/v2/expired-instruments/historical-candle/')) {
        calls.push(p);
        if (slow) await new Promise((r) => setTimeout(r, slow));
        if (failing(p)) throw new Error('Upstox says no');
        return { candles: [] };
      }
      throw new Error('unexpected request ' + p);
    },
  };
  const state = { token };
  const data = createData({ getToken: () => state.token, upstox, cacheDir: dir });
  const sync = createSync({ data, getToken: () => state.token, file: path.join(dir, 'data-sync.json') });
  sync.saveSettings({ band: 2, daysBefore: 5 });
  return { sync, data, calls, state, dir, upstox };
}
const expiriesOf = (p) => p.rows.map((r) => r.expiry);

test('plan: which expiries each kind of selection covers', async (t) => {
  const { sync } = setup(t);
  assert.deepStrictEqual(expiriesOf(await sync.plan({ scope: 'new' })), [LAST], 'nothing cached: only the latest');
  assert.deepStrictEqual(expiriesOf(await sync.plan({ scope: 'recent', months: 0 })), EXPIRIES);
  assert.deepStrictEqual(
    expiriesOf(await sync.plan({ scope: 'recent', months: 1 })),
    EXPIRIES.filter((e) => e >= addDays(today, -31)),
  );
  assert.deepStrictEqual(expiriesOf(await sync.plan({ scope: 'range', from: EXPIRIES[2], to: EXPIRIES[4] })), EXPIRIES.slice(2, 5));
  assert.deepStrictEqual(expiriesOf(await sync.plan({ scope: 'range', from: '2001-01-01', to: '2001-02-01' })), []);
  // The last expiry of a calendar month is the monthly one; the rest are weekly.
  const monthly = (await sync.plan({ scope: 'recent', months: 0, kind: 'monthly' })).rows.length;
  const weekly = (await sync.plan({ scope: 'recent', months: 0, kind: 'weekly' })).rows.length;
  assert.ok(monthly >= 2 && monthly <= 4, `${monthly} monthly expiries in 12 weeks`);
  assert.strictEqual(monthly + weekly, EXPIRIES.length);
});

test('download: fetches what the plan lists, then nothing is missing', async (t) => {
  const { sync, calls } = setup(t);
  const before = await sync.plan({ scope: 'range', from: EXPIRIES[9], to: LAST });
  assert.deepStrictEqual([before.rows.length, before.contracts, before.missing, before.requests], [3, 30, 30, 60]);
  assert.strictEqual(before.tasks[0][0], LAST, 'the newest expiry is downloaded first');
  assert.strictEqual(calls.length, 0, 'checking downloads no option candles');

  const job = sync.start({ scope: 'range', from: EXPIRIES[9], to: LAST });
  await job.promise;
  assert.strictEqual(job.status, 'done');
  assert.deepStrictEqual(
    { ...job.result, downloaded: job.result.downloaded.length },
    { expiries: 3, wanted: 30, contracts: 30, failed: 0, stopped: false, unchecked: 0, why: null, stale: false, downloaded: 3 },
  );
  assert.strictEqual(calls.length, 60);

  const after = await sync.plan({ scope: 'range', from: EXPIRIES[9], to: LAST });
  assert.deepStrictEqual([after.contracts, after.missing, after.requests], [30, 0, 0]);
  // A wider band only asks for the strikes that were added.
  const wider = await sync.plan({ scope: 'range', from: LAST, to: LAST, band: 3 });
  assert.deepStrictEqual([wider.contracts, wider.missing], [14, 4]);
});

test('plan "new": from the newest cached expiry on, at most the last eight', async (t) => {
  const { sync, data, dir } = setup(t);
  await data.option(EXPIRIES[10], 25000, 'CE', EXPIRIES[10]); // what a backtest leaves behind: one contract
  const p = await sync.plan({ scope: 'new' });
  assert.deepStrictEqual(expiriesOf(p), EXPIRIES.slice(10));
  assert.deepStrictEqual(
    p.rows.map((r) => r.missing),
    [9, 10],
    'the cached expiry is completed too',
  );
  fs.rmSync(path.join(dir, 'opt', EXPIRIES[10]), { recursive: true });
  await data.option(EXPIRIES[0], 25000, 'CE', EXPIRIES[0]);
  assert.deepStrictEqual(expiriesOf(await sync.plan({ scope: 'new' })), EXPIRIES.slice(-8));
});

test('plan: a window deeper than the first download asks for the earlier days only', async (t) => {
  const { sync, data, dir, upstox } = setup(t);
  await data.option(LAST, 25000, 'CE', LAST); // covers the 35 days before the expiry
  // A data layer that has not loaded the contract reads how far its file reaches from the file itself.
  for (const d of [data, createData({ getToken: () => 'tok', upstox, cacheDir: dir })]) {
    assert.strictEqual(d.optionRequests(LAST, 25000, 'CE', addDays(LAST, -20)), 0);
    assert.strictEqual(d.optionRequests(LAST, 25000, 'CE', addDays(LAST, -40)), 1, 'five more days: one request');
    assert.strictEqual(d.optionRequests(LAST, 25000, 'PE', addDays(LAST, -40)), 2, 'not cached: 41 days in two requests');
  }
  // 30 trading days before a Tuesday are six weeks.
  const deep = await sync.plan({ scope: 'range', from: LAST, to: LAST, daysBefore: 30 });
  assert.deepStrictEqual([deep.contracts, deep.missing], [10, 10]);
  assert.strictEqual(deep.requests, 9 * 2 + 1);
});

test('download: failures are counted, and the automatic update leaves those contracts alone for a while', async (t) => {
  const { sync, calls } = setup(t, { failing: (p) => p.includes('25000CE') });
  const job = sync.start({ scope: 'new' });
  await job.promise;
  assert.deepStrictEqual([job.status, job.result.contracts, job.result.failed], ['done', 9, 1]);
  assert.strictEqual((await sync.plan({ scope: 'new' })).missing, 1, 'asked for again by hand');
  assert.strictEqual((await sync.plan({ scope: 'new' }, { skipFailed: true })).missing, 0);
  const n = calls.length;
  sync.tick(); // the automatic update: nothing it may fetch
  await waitFor(() => sync.status().job.auto && sync.status().job.status === 'done');
  assert.strictEqual(calls.length, n);
});

test('download: gives up when everything fails, and needs a login', async (t) => {
  const { sync, state } = setup(t, { failing: () => true });
  const job = sync.start({ scope: 'recent', months: 0 });
  await job.promise;
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /downloads in a row failed: Upstox says no/);
  state.token = null;
  assert.throws(() => sync.start({ scope: 'new' }), /Log in to Upstox/);
  state.token = 'demo';
  assert.throws(() => sync.start({ scope: 'new' }), /demo mode/);
  assert.strictEqual(sync.status().auto.state, 'demo');
});

test('automatic update: downloads the new expiry by itself, once, and can be switched off', async (t) => {
  const { sync, calls, dir, state } = setup(t);
  state.token = null;
  sync.tick();
  assert.strictEqual(sync.status().job, null, 'waits for the login');
  assert.strictEqual(sync.status().auto.state, 'login');
  state.token = 'tok';
  sync.tick();
  const first = sync.status().job;
  assert.ok(first.auto && first.status === 'running');
  sync.tick(); // while it runs: no second one
  await waitFor(() => sync.status().job.status !== 'running');
  assert.strictEqual(calls.length, 20);
  assert.match(sync.status().auto.text, /^downloaded 10 contracts of /);
  assert.strictEqual(sync.status().auto.ok, true);
  sync.tick(); // not due again for half an hour
  assert.strictEqual(sync.status().job.id, first.id);

  sync.saveSettings({ auto: false });
  assert.strictEqual(sync.status().auto.state, 'off');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data-sync.json'), 'utf8')), { auto: false, band: 2, daysBefore: 5 });
  sync.saveSettings({ band: 500, daysBefore: -3 });
  assert.deepStrictEqual(sync.status().settings, { auto: false, band: 80, daysBefore: 0 });
});

test('a download asked for on the Data screen takes over from the automatic one', async (t) => {
  const { sync, calls } = setup(t, { slow: 20 });
  sync.tick();
  assert.ok(sync.status().job.auto);
  await waitFor(() => calls.length > 0);
  const job = sync.start({ scope: 'new' });
  assert.ok(!job.auto);
  assert.strictEqual(sync.start({ scope: 'recent', months: 0 }), job, 'one download at a time');
  await job.promise;
  assert.deepStrictEqual([job.status, job.result.failed, job.result.stopped], ['done', 0, false]);
  assert.strictEqual(calls.length, 20, 'what the automatic one was fetching is not fetched again');
  assert.strictEqual((await sync.plan({ scope: 'new' })).missing, 0);
});
async function waitFor(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'timed out');
}
