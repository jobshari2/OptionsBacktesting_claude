// Tick-by-tick trades of the instruments the feed streams (Nifty, the near-month Nifty future, the options around the
// money), kept in memory for the session so the chart's Tick view can draw every trade with its size. Only trades are
// kept: an update whose price and day volume did not move is a quote change. Each key holds up to `cap` ticks (the
// oldest drop off) and a new IST day starts empty. Nothing is written to disk, so a restart starts over.
const { IST_OFFSET, istDate } = require('./time');

const CAP = 150_000; // a full session of Nifty, which moves several times a second (the arrays grow as needed)
const FIRST = 4096; // arrays start this long and double until `cap`

function createTickStore({ cap = CAP } = {}) {
  let day = null;
  let dayStart = 0; // UTC ms of IST midnight of `day`
  let gen = Date.now(); // changes when the store starts over (a new day, a restart): a chart holding older ticks reloads
  const keys = new Map(); // key -> { n, size, ms: Uint32Array (ms since IST midnight), px, qty, ltp, vtt }

  function grow(s) {
    const size = Math.min(cap, s.size ? s.size * 2 : FIRST);
    const ms = new Uint32Array(size);
    const px = new Float64Array(size);
    const qty = new Float64Array(size);
    if (s.size) {
      ms.set(s.ms);
      px.set(s.px);
      qty.set(s.qty);
    }
    Object.assign(s, { size, ms, px, qty });
  }

  return {
    // A feed update of `key` at `at` (ms): its last price and, for a traded contract, the day's volume so far (vtt).
    // The tick's quantity is the volume added since the previous one (0 for the index and for a key's first tick).
    record(key, at, ltp, vtt) {
      if (!key || ltp == null || !Number.isFinite(ltp)) return;
      const d = istDate(at);
      if (d !== day) {
        if (day && d < day) return; // a late update from the day before
        day = d;
        dayStart = Date.parse(d + 'T00:00:00Z') - IST_OFFSET;
        gen = Math.max(gen + 1, Date.now());
        keys.clear();
      }
      let s = keys.get(key);
      if (!s) keys.set(key, (s = { n: 0, size: 0, ltp: null, vtt: null }));
      const more = vtt != null && Number.isFinite(vtt) && (s.vtt == null || vtt > s.vtt); // volume traded since the last
      if (ltp === s.ltp && !more) return;
      const qty = more && s.vtt != null ? vtt - s.vtt : 0;
      s.ltp = ltp;
      if (more) s.vtt = vtt;
      if (s.n === s.size && s.size < cap) grow(s);
      const i = s.n % s.size;
      s.ms[i] = Math.max(0, at - dayStart);
      s.px[i] = ltp;
      s.qty[i] = qty;
      s.n++;
    },
    // The session's ticks of `key` from the `after`-th on, as [at ms, price, quantity]. A caller whose `gen` is out of
    // date, or who asks for ticks that have dropped off, gets everything kept: `start` says which tick comes first.
    since(key, after = 0, wantGen = null) {
      const s = keys.get(key);
      if (!s) return { gen, day, start: 0, count: 0, ticks: [] };
      const oldest = s.n > s.size ? s.n - s.size : 0;
      let from = Number(after);
      if (wantGen !== gen || !Number.isInteger(from) || from < oldest || from > s.n) from = oldest;
      const ticks = [];
      for (let k = from; k < s.n; k++) {
        const i = k % s.size;
        ticks.push([dayStart + s.ms[i], s.px[i], s.qty[i]]);
      }
      return { gen, day, start: from, count: s.n, ticks };
    },
    get gen() {
      return gen;
    },
  };
}

module.exports = { createTickStore };
