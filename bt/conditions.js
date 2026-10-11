// Entry conditions for signal-triggered strategies. All conditions must hold in the same minute; the trade
// is entered at the next minute's open. The same evaluation runs in backtests (on 1-minute Nifty candles)
// and on the live chain.
//
//   anomaly   an option-pricing anomaly fires (type, params, optional side / direction filter)
//   sr-near   Nifty is within X points of a support / resistance level (major, minor or any)
//   sr-break  Nifty closes through a level this minute (up through resistance / down through support)
//   move      Nifty has moved X points or % from the open or previous close (up, down or either way)
//   range     Nifty's high − low since the open is at least / at most X points
const A = require('./anomalies');
const { ofClass } = require('./levels');

const KINDS = new Set(['anomaly', 'sr-near', 'sr-break', 'move', 'range']);
const CLS = new Set(['any', 'major', 'minor']);
const pos = (v, d) => (Number(v) >= 0 && v !== '' && v != null ? Number(v) : d);

function normCondition(c) {
  const kind = KINDS.has(c?.kind) ? c.kind : null;
  if (!kind) return null;
  const cls = CLS.has(c.cls) ? c.cls : 'any';
  switch (kind) {
    case 'anomaly': {
      // A type that has since been removed never fires (dropping it would turn the strategy into "enter every minute").
      if (!A.BY_ID.has(c.type)) return { kind, type: String(c.type), params: {}, side: 'any', dir: 'any' };
      const t = A.BY_ID.get(c.type);
      return {
        kind,
        type: c.type,
        params: A.params(c.type, c.params),
        side: ['CE', 'PE'].includes(c.side) ? c.side : 'any',
        dir: t.dirs.includes(c.dir) ? c.dir : 'any',
      };
    }
    case 'sr-near':
      return { kind, cls, side: ['support', 'resistance'].includes(c.side) ? c.side : 'either', within: pos(c.within, 30) };
    case 'sr-break':
      return { kind, cls, dir: ['up', 'down'].includes(c.dir) ? c.dir : 'either', buffer: pos(c.buffer, 5) };
    case 'move':
      return {
        kind,
        from: c.from === 'prevClose' ? 'prevClose' : 'open',
        dir: ['up', 'down'].includes(c.dir) ? c.dir : 'abs',
        op: c.op === 'lte' ? 'lte' : 'gte',
        unit: c.unit === 'pct' ? 'pct' : 'pts',
        value: pos(c.value, 50),
      };
    case 'range':
      return { kind, op: c.op === 'lte' ? 'lte' : 'gte', value: pos(c.value, 100) };
    default:
      return null;
  }
}

const r1 = (x) => Math.round(x * 10) / 10;

// env: { spot (close this minute), prevSpot (close a minute earlier), open, prevClose, high, low (since the
//        open), levels (from levels.forDay), ctx() -> anomaly Chain or null }
// Returns { ok, hit (the anomaly that fired, if any), level (the S/R level involved), notes: [text] }.
function evaluate(conds, env) {
  const notes = [];
  let hit = null;
  let level = null;
  for (const c of conds) {
    const r = one(c, env);
    if (!r.ok) return { ok: false, hit: null, level: null, notes: [...notes, r.note], failed: c };
    if (r.hit && !hit) hit = r.hit;
    if (r.level && !level) level = r.level;
    notes.push(r.note);
  }
  return { ok: true, hit, level, notes };
}

function one(c, env) {
  const S = env.spot;
  switch (c.kind) {
    case 'anomaly': {
      const ctx = env.ctx?.();
      if (!A.BY_ID.has(c.type)) return { ok: false, note: `anomaly type "${c.type}" no longer exists` };
      if (!ctx) return { ok: false, note: 'no option chain' };
      const hs = A.detect(c.type, ctx, c.params).filter((h) => (c.side === 'any' || h.side === c.side) && (c.dir === 'any' || h.dir === c.dir));
      return hs.length ? { ok: true, hit: hs[0], note: hs[0].text } : { ok: false, note: `${A.BY_ID.get(c.type).name}: not firing` };
    }
    case 'sr-near': {
      let best = null;
      for (const l of ofClass(env.levels, c.cls)) {
        const side = l.price < S ? 'support' : 'resistance';
        if (c.side !== 'either' && side !== c.side) continue;
        const d = Math.abs(S - l.price);
        if (d <= c.within && (!best || d < best.d)) best = { l, d, side };
      }
      return best
        ? { ok: true, level: { ...best.l, side: best.side }, note: `${r1(best.d)} pts from ${best.l.cls} ${best.side} ${best.l.price}` }
        : { ok: false, note: `not within ${c.within} pts of a ${c.cls === 'any' ? '' : c.cls + ' '}${c.side === 'either' ? 'level' : c.side}` };
    }
    case 'sr-break': {
      const p = env.prevSpot;
      if (p == null) return { ok: false, note: 'no previous minute' };
      for (const l of ofClass(env.levels, c.cls)) {
        if ((c.dir === 'up' || c.dir === 'either') && p < l.price + c.buffer && S >= l.price + c.buffer)
          return { ok: true, level: { ...l, side: 'resistance' }, note: `broke above ${l.cls} ${l.price}` };
        if ((c.dir === 'down' || c.dir === 'either') && p > l.price - c.buffer && S <= l.price - c.buffer)
          return { ok: true, level: { ...l, side: 'support' }, note: `broke below ${l.cls} ${l.price}` };
      }
      return { ok: false, note: 'no level broken this minute' };
    }
    case 'move': {
      const base = c.from === 'open' ? env.open : env.prevClose;
      if (!base) return { ok: false, note: `no ${c.from === 'open' ? 'open' : 'previous close'}` };
      const raw = c.unit === 'pct' ? ((S - base) / base) * 100 : S - base;
      const v = c.dir === 'up' ? raw : c.dir === 'down' ? -raw : Math.abs(raw);
      const ok = c.op === 'gte' ? v >= c.value : v <= c.value;
      const txt = `Nifty ${raw >= 0 ? '+' : ''}${c.unit === 'pct' ? Math.round(raw * 100) / 100 + '%' : r1(raw) + ' pts'} from ${c.from === 'open' ? 'open' : 'prev close'}`;
      return { ok, note: txt };
    }
    case 'range': {
      if (env.high == null) return { ok: false, note: 'no range' };
      const rg = env.high - env.low;
      return { ok: c.op === 'gte' ? rg >= c.value : rg <= c.value, note: `range ${r1(rg)} pts` };
    }
    default:
      return { ok: false, note: 'unknown condition' };
  }
}

module.exports = { normCondition, evaluate, KINDS };
