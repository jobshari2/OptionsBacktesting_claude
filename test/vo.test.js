const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createData, addDays, MPD } = require('../bt/data');

// Volume and open interest of option contracts (the Builder's chain): kept from every candle download, in files apart
// from the OHLC, and fetched once for a contract cached before. Upstox faked: one expiry, candles at 09:15 and 09:16
// every weekday with volume 100 / 50 and OI 2,000 / 2,100.
const EXPIRY = '2026-06-30';
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const upstox = {
    limiter: { stats: () => ({ requests: calls.length, lastMinute: 0, waitingSec: 0 }) },
    async bulk(p) {
      if (p.startsWith('/v2/expired-instruments/option/contract'))
        return ['CE', 'PE'].map((type) => ({ strike_price: 25000, instrument_type: type, instrument_key: `K-25000${type}`, lot_size: 65 }));
      if (p.startsWith('/v2/expired-instruments/historical-candle/')) {
        calls.push(p);
        const [to, from] = p.split('/').slice(-2);
        const candles = [];
        for (let d = from; d <= to; d = addDays(d, 1))
          if (weekday(d) % 6) candles.push([d + 'T09:15:00+05:30', 10, 11, 9, 10, 100, 2000], [d + 'T09:16:00+05:30', 10, 12, 10, 11, 50, 2100]);
        return { candles };
      }
      throw new Error('unexpected request ' + p);
    },
  };
  const data = createData({ getToken: () => 'tok', upstox, cacheDir: dir });
  return { data, calls, dir, upstox };
}

test('a candle download keeps volume and OI, and the chain reads them without asking Upstox again', async (t) => {
  const { data, calls, dir, upstox } = setup(t);
  const day = '2026-06-24';
  await data.option(EXPIRY, 25000, 'CE', day);
  const n = calls.length;
  const vo = await data.optionVo(EXPIRY, 25000, 'CE', day);
  assert.strictEqual(calls.length, n, 'already downloaded with the candles');
  assert.deepStrictEqual([vo[0], vo[1], vo[2], vo[3], vo[4]], [100, 2000, 50, 2100, -1]);
  assert.strictEqual(vo.length, MPD * 2);
  assert.strictEqual(await data.optionVo(EXPIRY, 25000, 'CE', '2026-06-27'), null, 'a Saturday: no candles, known from the span');
  assert.strictEqual(calls.length, n);
  // kept in a file of its own, read back by a new data layer
  assert.ok(fs.existsSync(path.join(dir, 'vo', EXPIRY, '25000CE.json.gz')));
  assert.ok(!fs.readdirSync(path.join(dir, 'opt', EXPIRY)).some((f) => f.includes('vo')), 'the OHLC files are unchanged');
  const again = createData({ getToken: () => 'tok', upstox, cacheDir: dir });
  assert.strictEqual((await again.optionVo(EXPIRY, 25000, 'CE', day))[1], 2000);
  assert.strictEqual(calls.length, n);
});

test('a contract cached before volume and OI were kept gets them in one request, from the day asked on', async (t) => {
  const { data, calls, dir, upstox } = setup(t);
  await data.option(EXPIRY, 25000, 'PE', '2026-06-10');
  fs.rmSync(path.join(dir, 'vo'), { recursive: true }); // as a cache from before has it
  const old = createData({ getToken: () => 'tok', upstox, cacheDir: dir });
  const n = calls.length;
  const vo = await old.optionVo(EXPIRY, 25000, 'PE', '2026-06-15');
  assert.strictEqual(vo[1], 2000);
  assert.strictEqual(calls.length, n + 1, 'one request');
  assert.ok(calls.at(-1).endsWith(`/${EXPIRY}/2026-06-15`), 'from the day asked to the expiry (under 4 weeks)');
  assert.strictEqual((await old.optionVo(EXPIRY, 25000, 'PE', '2026-06-22'))[3], 2100, 'a later day of the replay: already there');
  assert.strictEqual(calls.length, n + 1);
  await old.optionVo(EXPIRY, 25000, 'PE', '2026-06-12');
  assert.strictEqual(calls.length, n + 2, 'an earlier day is fetched');
  // the option cache cleared: volume and OI go with it
  old.clearCache('options');
  assert.ok(!fs.existsSync(path.join(dir, 'vo')));
});
