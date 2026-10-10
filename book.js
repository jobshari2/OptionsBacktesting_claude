// Order book view: how much is waiting to buy vs sell at each strike, how that pressure moves over the
// day, who is actually trading (buyers vs sellers), and how Nifty moved after the book leaned one way.
// Samples the snapshot history every 15 s (full day, seeded from today's tape after a restart).
// Needs the tick feed: entries carry [10-17] bid/ask/queues and [6-9] aggressor volume.
const MIN = 60_000;
const SAMPLE_MS = 15_000;
const IST_OFFSET = 5.5 * 3600_000;
const istDate = (ts) => new Date(ts + IST_OFFSET).toISOString().slice(0, 10);

function createBook({ strikesAround = 10, pressureStrikes = 5 }) {
  const samples = []; // { t, spot, atm, bull, k: { strike: [ceBuyPct, peBuyPct, ceSprPct, peSprPct] }, agg }
  let day = null;
  let lastCum = null; // per-strike cumulative aggressor volume at the previous sample
  let lastAt = 0;

  function addEntry(e) {
    if (e.spot == null || e.t - lastAt < SAMPLE_MS) return;
    const ks = Object.keys(e.d).map(Number).sort((a, b) => a - b);
    if (!ks.length || !(e.d[ks[0]]?.length >= 18 || ks.some((k) => e.d[k]?.length >= 18))) return;
    const dd = istDate(e.t);
    if (day !== dd) { day = dd; samples.length = 0; lastCum = null; }
    lastAt = e.t;

    const atm = ks.reduce((b, k) => (Math.abs(k - e.spot) < Math.abs(b - e.spot) ? k : b), ks[0]);
    const i = ks.indexOf(atm);
    const k = {};
    let bull = 0;
    let bear = 0;
    const cum = {};
    const agg = { ceBuy: 0, ceSell: 0, peBuy: 0, peSell: 0 };
    for (const s of ks.slice(Math.max(0, i - strikesAround), i + strikesAround + 1)) {
      const v = e.d[s];
      if (!v || v.length < 18) continue;
      const pct = (b, a) => (b + a > 0 ? (b / (b + a)) * 100 : null);
      const spr = (bid, ask) => (bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null);
      k[s] = [pct(v[12], v[13]), pct(v[16], v[17]), spr(v[10], v[11]), spr(v[14], v[15])];
      if (Math.abs(ks.indexOf(s) - i) <= pressureStrikes) {
        bull += v[12] + v[17];
        bear += v[16] + v[13];
      }
      cum[s] = [v[6], v[7], v[8], v[9]];
      const p = lastCum?.[s];
      if (p) {
        agg.ceBuy += Math.max(0, v[6] - p[0]);
        agg.ceSell += Math.max(0, v[7] - p[1]);
        agg.peBuy += Math.max(0, v[8] - p[2]);
        agg.peSell += Math.max(0, v[9] - p[3]);
      }
    }
    const hadPrev = Boolean(lastCum);
    lastCum = cum;
    samples.push({ t: e.t, spot: e.spot, atm, bull: bull + bear ? (bull / (bull + bear)) * 100 : null, k, agg: hadPrev ? agg : null });
  }

  // Average of the bullish share over the window before time t (its own "normal" level).
  function avgBefore(idx, minutes) {
    const t = samples[idx].t;
    let sum = 0;
    let n = 0;
    for (let j = idx - 1; j >= 0 && t - samples[j].t <= minutes * MIN; j--) {
      if (samples[j].bull != null && t - samples[j].t >= MIN) { sum += samples[j].bull; n++; }
    }
    return n >= 20 ? sum / n : null;
  }

  function at(t) {
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t >= t) hi = m; else lo = m + 1; }
    return samples[lo];
  }

  function state(snap) {
    // --- live, per strike, straight from the latest snapshot ---
    const rows = snap?.rows || [];
    let ai = 0;
    rows.forEach((r, j) => { if (Math.abs(r.strike - snap.spot) < Math.abs(rows[ai].strike - snap.spot)) ai = j; });
    const strikes = rows.slice(Math.max(0, ai - strikesAround), ai + strikesAround + 1).map((r) => {
      const side = (o) => ({ bid: o.bid ?? null, ask: o.ask ?? null, bidQ: o.bidQ ?? null, askQ: o.askQ ?? null, tbq: o.tbq ?? null, tsq: o.tsq ?? null, ltp: o.ltp ?? null });
      return { strike: r.strike, ce: side(r.ce), pe: side(r.pe) };
    });
    const live = strikes.some((s) => s.ce.tbq != null);

    // --- series: pressure vs its 30-min average, Nifty, and aggressor volume per minute ---
    const series = samples.map((s, idx) => ({ t: s.t, spot: s.spot, bull: s.bull, avg30: avgBefore(idx, 30) }));
    const minutes = [];
    let cur = null;
    for (const s of samples) {
      if (!s.agg) continue;
      const m = Math.floor(s.t / MIN) * MIN;
      if (!cur || cur.t !== m) { cur = { t: m, ceBuy: 0, ceSell: 0, peBuy: 0, peSell: 0 }; minutes.push(cur); }
      for (const key of ['ceBuy', 'ceSell', 'peBuy', 'peSell']) cur[key] += s.agg[key];
    }

    // --- heatmap: buy share of the queue per strike per minute, last 60 min ---
    const last = samples[samples.length - 1];
    const heat = { times: [], strikes: [], ce: [], pe: [] };
    if (last) {
      const keys = Object.keys(last.k).map(Number).sort((a, b) => a - b);
      heat.strikes = keys;
      heat.ce = keys.map(() => []);
      heat.pe = keys.map(() => []);
      for (let t = last.t - 59 * MIN; t <= last.t; t += MIN) {
        const s = samples.length && samples[0].t <= t ? at(t) : null;
        heat.times.push(t);
        keys.forEach((kk, i) => {
          heat.ce[i].push(s?.k[kk]?.[0] ?? null);
          heat.pe[i].push(s?.k[kk]?.[1] ?? null);
        });
      }
    }

    // --- how Nifty reacted: book lean vs its 30-min average, against the next 5 min ---
    const reaction = [];
    for (let idx = 0; idx < samples.length; idx += 4) { // one point per minute
      const s = samples[idx];
      const a = avgBefore(idx, 30);
      if (s.bull == null || a == null) continue;
      const f = at(s.t + 5 * MIN);
      if (!f || f.t - s.t < 4.5 * MIN || f.t - s.t > 6 * MIN) continue;
      reaction.push({ t: s.t, lean: s.bull - a, move: f.spot - s.spot });
    }
    const leaned = reaction.filter((r) => Math.abs(r.lean) >= 3);
    const right = leaned.filter((r) => Math.sign(r.move) === Math.sign(r.lean)).length;
    const corr = (() => {
      if (reaction.length < 10) return null;
      const mx = reaction.reduce((s, r) => s + r.lean, 0) / reaction.length;
      const my = reaction.reduce((s, r) => s + r.move, 0) / reaction.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (const r of reaction) { sxy += (r.lean - mx) * (r.move - my); sxx += (r.lean - mx) ** 2; syy += (r.move - my) ** 2; }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
    })();

    const lastS = samples[samples.length - 1];
    // only when the history really reaches back that far
    const ago = (m) => (lastS && samples[0].t <= lastS.t - m * MIN + SAMPLE_MS ? at(lastS.t - m * MIN) : null);
    const s5 = ago(5);
    const s15 = ago(15);
    const lastMin = minutes[minutes.length - 2] || minutes[minutes.length - 1] || null; // last complete minute

    return {
      live,
      spot: snap?.spot ?? null,
      atm: rows[ai]?.strike ?? null,
      strikes,
      now: lastS ? {
        bull: lastS.bull,
        avg30: series[series.length - 1]?.avg30 ?? null,
        chg5: s5 && s5.t < lastS.t && s5.bull != null ? lastS.bull - s5.bull : null,
        chg15: s15 && s15.t < lastS.t && s15.bull != null ? lastS.bull - s15.bull : null,
      } : null,
      lastMinute: lastMin,
      series,
      minutes,
      heat,
      reaction: { points: reaction, leaned: leaned.length, right, corr },
      coverMin: samples.length ? Math.round((lastS.t - samples[0].t) / MIN) : 0,
    };
  }

  return {
    seed(entries) { for (const e of entries) addEntry(e); },
    update(entry) { addEntry(entry); },
    state,
  };
}

module.exports = { createBook };
