// Strategy Builder: trade a position by hand (or from a ready-made / saved strategy) on a historical replay
// of an expired expiry or on the live chain. Left: the option chain with Buy/Sell buttons; right: the payoff
// at expiry and today; below: positions and P&L over the replay, and adjustment suggestions (rule book in
// sb-adjust.js, plus online research through Claude + web search). The replay steps 1 minute to 1 day,
// manually or automatically, within the day (intraday) or across days up to expiry (multi-day).
// Live mode is paper trading: entries and exits are recorded at the chain's prices; no orders are sent.
// Other screens open a position here through BT.emit('open-builder', …) (a backtest trade to replay, a deployed
// strategy to customise); the position can be saved back as a strategy or sent to the Backtest.
(() => {
  const { $, esc, inr, inrS, kinr, num, cls, dayShort, dayLabel, WD, bs } = BT;
  const MPD = 375;
  const STEPS = [[1, '1m'], [3, '3m'], [5, '5m'], [10, '10m'], [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], ['1d', '1 day']];
  const SPEEDS = [[500, '0.5 s'], [1000, '1 s'], [2000, '2 s'], [4000, '4 s']];
  const hhmm = (m) => { const t = m + 555; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const minOf = (t) => { const [h, m] = String(t || '09:20').split(':').map(Number); return Math.max(0, Math.min(MPD - 1, h * 60 + m - 555)); };

  const def = { src: 'hist', expiry: null, liveExpiry: null, day: null, startTime: '09:20', chainExp: null, chainLots: null, m: 5, session: 'intraday', step: 5, speed: 1000, lots: 1, width: 10, legs: [], log: [], mtm: [], atmIvEntry: null, spotEntry: null, seq: 0 };
  let S = { ...def, ...BT.store.get('sb', {}) };
  if (!Array.isArray(S.legs)) S.legs = [];
  if (!S.pay) S.pay = { daysAhead: 0, ivShift: 0 }; // payoff what-if controls
  const save = () => BT.store.set('sb', S);

  let inited = false;
  let cal = null; // { days, lot } of the historical expiry
  const dayCache = new Map(); // `${expiry}|${day}` -> day data
  const liveMap = new Map(); // expiry -> { at, spot, rows }
  const loadingKeys = new Set();
  const failedKeys = new Set(); // viewed expiries with no data for the current day
  let liveTimer = null;
  let playTimer = null;
  let levels = new Map(); // day -> levels
  let research = null;
  let busy = false;
  let pending = null; // position handed over by another screen, placed once the chain is loaded (see 'open-builder')

  // ---------- data ----------
  // Lots used by the chain's B / S buttons and the arbitrage list: the chain's own box wins over the global Lots on top.
  const chainLots = () => Math.max(1, Math.floor(Number(S.chainLots)) || S.lots);
  let forceRebuild = false; // redraw the positions table even though one of its boxes has focus
  const primary = () => (S.src === 'hist' ? S.expiry : S.liveExpiry);
  const legExp = (l) => l.expiry || primary();
  const dd = (exp = S.expiry) => (S.src === 'hist' ? dayCache.get(`${exp}|${S.day}`) : null);
  // Expiries shown in the chain's picker (the replay/live expiry and every later one), and the one currently viewed.
  function chainExpiries() {
    if (S.src === 'hist') {
      const all = BT.meta.calendar?.expired || [];
      const list = all.filter((e) => e >= (S.day || S.expiry) && e >= S.expiry).slice(0, 8);
      return list.length ? list : [S.expiry].filter(Boolean);
    }
    return (BT.meta.calendar?.live || []).slice(0, 8);
  }
  const viewedExp = () => (S.chainExp && chainExpiries().includes(S.chainExp) ? S.chainExp : primary());
  async function loadDay(day, force, exp = S.expiry) {
    const key = `${exp}|${day}`;
    const need = [...new Set([...S.legs, ...(pending?.legs || [])].filter((l) => (l.expiry || primary()) === exp).map((l) => l.strike))];
    const have = dayCache.get(key);
    if (have && !force && need.every((k) => have.ks.includes(k))) return have;
    const d = await BT.api(`/api/sb/day?expiry=${exp}&day=${day}&width=15&extra=${need.join(',')}`);
    dayCache.set(key, d);
    if (dayCache.size > 30) dayCache.delete(dayCache.keys().next().value);
    return d;
  }
  // Other expiries needed besides the main one: those held in legs and the one viewed in the chain.
  const extraExps = () => [...new Set([...S.legs.filter((l) => l.open).map(legExp), viewedExp()])].filter((e) => e && e !== primary());
  async function fetchLive(exp) {
    const c = await BT.api('/api/bt/chain?expiry=' + exp);
    liveMap.set(exp, { at: Date.now(), spot: c.spot, rows: c.rows.filter((r) => r.ce.ltp || r.pe.ltp) });
  }
  async function loadLive() {
    if (!S.liveExpiry) return;
    for (const exp of [S.liveExpiry, ...extraExps()]) {
      try { await fetchLive(exp); } catch (e) { liveMap.set(exp, { error: e.message, at: Date.now(), rows: [] }); }
    }
  }
  // Make sure an expiry's prices are loaded at the current replay time / live (for legs of another expiry).
  async function ensureExp(exp) {
    if (S.src === 'hist') await loadDay(S.day, false, exp);
    else if (!liveMap.get(exp)?.rows?.length) await fetchLive(exp);
  }
  // Load whatever the viewed expiry needs, then redraw (guards against repeated loads of the same thing).
  function ensureView() {
    const e = viewedExp();
    if (!e || e === primary()) return;
    const key = `${S.src}|${e}|${S.day}`;
    if (S.src === 'hist' ? dayCache.has(`${e}|${S.day}`) : liveMap.has(e)) return;
    if (loadingKeys.has(key) || failedKeys.has(key)) return;
    loadingKeys.add(key);
    (S.src === 'hist' ? loadDay(S.day, false, e) : loadLive()).catch(() => failedKeys.add(key)).finally(() => { loadingKeys.delete(key); render(); });
  }
  async function loadLevels(day) {
    const key = day || 'live';
    if (levels.has(key)) return;
    levels.set(key, null);
    try { levels.set(key, await BT.api('/api/bt/levels' + (day ? '?day=' + day : ''))); } catch { /* optional */ }
  }

  // Current market view: strikes, prices, spot, time to expiry.
  function market(exp = primary()) {
    if (S.src === 'hist') {
      const d = dd(exp);
      if (!d) return null;
      const m = S.m;
      return {
        spot: d.spot[m], ks: d.ks, lot: exp === S.expiry ? cal?.lot || d.lot : d.lot, expiry: exp, day: S.day, minute: m,
        px: (k, t) => { const i = d.ks.indexOf(k); if (i < 0) return null; const v = (t === 'CE' ? d.ce : d.pe)[i][m]; return v > 0 ? v : null; },
        quote: () => null,
        T: Math.max(1e-6, (Date.parse(exp + 'T15:30:00+05:30') - Date.parse(`${S.day}T${hhmm(m)}:00+05:30`)) / (365 * 86400_000)),
        label: `${WD[new Date(S.day + 'T00:00:00Z').getUTCDay()]} ${dayShort(S.day)} ${hhmm(m)}`,
      };
    }
    const live = liveMap.get(exp);
    if (!live?.rows?.length) return null;
    const ist = new Date(Date.now() + 5.5 * 3600_000);
    const minute = Math.max(0, Math.min(MPD - 1, ist.getUTCHours() * 60 + ist.getUTCMinutes() - 555));
    const row = (k) => live.rows.find((r) => r.strike === k);
    return {
      spot: live.spot, ks: live.rows.map((r) => r.strike), lot: BT.meta.calendar?.liveLot || 65, expiry: exp, day: ist.toISOString().slice(0, 10), minute,
      px: (k, t) => { const r = row(k); const v = r && (t === 'CE' ? r.ce : r.pe).ltp; return v > 0 ? v : null; },
      quote: (k, t) => { const r = row(k); return r ? (t === 'CE' ? r.ce : r.pe) : null; },
      T: Math.max(1e-6, (Date.parse(exp + 'T15:30:00+05:30') - Date.now()) / (365 * 86400_000)),
      label: `Live ${window.app.istClock(live.at)}`,
    };
  }

  // ---------- option maths ----------
  function ivOf(price, Sx, K, T, call) {
    if (!(price > 0)) return null;
    const intr = Math.max(0, call ? Sx - K : K - Sx);
    if (price < intr - 0.5) return null; // stale print below intrinsic (illiquid in-the-money strike)
    if (price <= intr + 0.05) return 0.05;
    let lo = 0.01;
    let hi = 3;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (bs(Sx, K, T, mid, call) > price) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  }
  const { greeks } = BT.payoff;
  const atmOf = (M) => M.ks.reduce((b, k) => (Math.abs(k - M.spot) < Math.abs(b - M.spot) ? k : b), M.ks[0]);
  function atmIv(M) {
    const k = atmOf(M);
    const a = ivOf(M.px(k, 'CE'), M.spot, k, M.T, true);
    const b = ivOf(M.px(k, 'PE'), M.spot, k, M.T, false);
    return a && b ? (a + b) / 2 : a || b;
  }

  // ---------- position ----------
  const openLegs = () => S.legs.filter((l) => l.open);
  const picked = (l) => !l.off; // ticked in Positions & P&L: only ticked legs count towards the payoff, Greeks, P&L, chart and suggestions
  const dir = (l) => (l.action === 'B' ? 1 : -1);
  // Each leg is priced from its own expiry's chain (calendar / diagonal spreads hold legs of different expiries).
  const mk = (l, M) => market(legExp(l)) || M;
  function legNow(l, M) {
    const Ml = mk(l, M);
    const px = Ml.px(l.strike, l.type);
    const iv = ivOf(px, M.spot, l.strike, Ml.T, l.type === 'CE') ?? atmIv(Ml) ?? 0.12;
    return { px, iv, T: Ml.T, lot: Ml.lot, g: greeks(M.spot, l.strike, Ml.T, iv, l.type === 'CE') };
  }
  // extra: { px (fill price instead of the chain's, e.g. a backtest fill), rule / ruleStrike / ruleExpiry (the strategy
  // leg it came from and where that rule put it, kept so "Save as strategy" can keep the rule and its SL / target) }
  function addLeg(action, type, strike, lots, M, why, extra = {}) {
    const px = extra.px > 0 ? extra.px : M.px(strike, type);
    if (px == null) { flash(`${strike} ${type} has no price at ${M.label}`); return false; }
    if (!openLegs().length) { S.atmIvEntry = atmIv(M); S.spotEntry = M.spot; }
    const rule = extra.rule ? { rule: BT.clone(extra.rule), ruleStrike: extra.ruleStrike ?? strike, ruleExpiry: extra.ruleExpiry ?? M.expiry } : {};
    S.legs.push({ id: ++S.seq, action, type, strike, lots, expiry: M.expiry, entryPx: px, entryAt: M.label, entryDay: M.day, entryMin: M.minute, spotIn: M.spot, open: true, ...rule });
    log(`${action === 'B' ? 'Buy' : 'Sell'} ${lots} × ${strike} ${type} @ ${px.toFixed(2)}${why ? ' — ' + why : ''}`, M);
    return true;
  }
  function closeLeg(l, M, lots, why) {
    const Ml = mk(l, M);
    const px = Ml.px(l.strike, l.type) ?? (Ml.T <= 1e-5 ? Math.max(0, l.type === 'CE' ? M.spot - l.strike : l.strike - M.spot) : null);
    if (px == null) { flash(`${l.strike} ${l.type} has no price now`); return false; }
    const n = Math.min(l.lots, lots || l.lots);
    if (n < l.lots) {
      // Partial close: split off the closed part.
      l.lots -= n;
      S.legs.push({ ...l, id: ++S.seq, lots: n, open: false, exitPx: px, exitAt: M.label });
    } else Object.assign(l, { open: false, exitPx: px, exitAt: M.label });
    log(`Close ${n} × ${l.strike} ${l.type} (${l.action === 'B' ? 'long' : 'short'}) @ ${px.toFixed(2)} · ${inrS(dir(l) * (px - l.entryPx) * n * Ml.lot)}${why ? ' — ' + why : ''}`, M);
    return true;
  }
  function log(text, M) { S.log.unshift({ at: M?.label || '', text }); S.log = S.log.slice(0, 200); }

  function pnl(M) {
    let realised = 0;
    let open = 0;
    let credit = 0;
    const by = {}; // per-leg P&L, so the replay curve can be re-summed when legs are ticked/unticked
    for (const l of S.legs) {
      const Ml = mk(l, M);
      const q = dir(l) * l.lots * Ml.lot;
      let v;
      if (!l.open) v = q * (l.exitPx - l.entryPx);
      else {
        const px = Ml.px(l.strike, l.type);
        v = q * ((px ?? l.entryPx) - l.entryPx);
      }
      by[l.id] = Math.round(v);
      if (!picked(l)) continue;
      if (!l.open) realised += v;
      else { open += v; credit -= q * l.entryPx; }
    }
    return { realised, open, total: realised + open, credit, by };
  }

  // Payoff, Greeks, capital and risk numbers from the shared engine (payoff.js). whatIf applies the payoff panel's
  // days-ahead / IV controls; the positions table and the suggestions always use the market as it is.
  function analyse(M, whatIf) {
    const legs = openLegs().filter(picked).map((l) => ({ ...l, ...legNow(l, M) }));
    const P = pnl(M);
    const A = BT.payoff.analyse(legs, { spot: M.spot, atmIv: atmIv(M) || 0.12, realised: P.realised, daysAhead: whatIf ? S.pay.daysAhead : 0, ivShift: whatIf ? S.pay.ivShift : 0 });
    return { ...A, P };
  }

  // ---------- strategy resolution on the current chain ----------
  // Concrete expiry for a strategy expiry code, counted from the Builder's main expiry.
  function expiryFor(code) {
    const c = BT.meta.calendar || {};
    const later = (S.src === 'hist' ? c.expired || [] : c.live || []).filter((e) => e >= primary());
    const ms = later.filter((e) => (c.monthly || []).includes(e));
    return code === 'next' ? later[1] : code === 'mcur' ? ms[0] : code === 'mnext' ? ms[1] : primary();
  }
  // Each leg is placed on its own expiry's chain (so calendars / diagonals keep their shape).
  async function resolveStrategy(s) {
    const lv = levels.get(S.src === 'hist' ? S.day : 'live');
    const warn = [];
    const out = [];
    for (const l of s.legs) {
      let exp = expiryFor(l.expiry);
      if (exp && exp !== primary()) {
        try { await ensureExp(exp); } catch { exp = null; }
      }
      if (!exp || !market(exp)) { warn.push(`${l.type} leg: no ${(BT.EXP_LABEL[l.expiry] || l.expiry).toLowerCase()} expiry with prices, placed on this expiry`); exp = primary(); }
      const M = market(exp);
      if (!M) continue;
      const ks = M.ks.filter((k) => M.px(k, 'CE') || M.px(k, 'PE'));
      const near = (x) => ks.reduce((b, k, j) => (Math.abs(k - x) < Math.abs(ks[b] - x) ? j : b), 0);
      const ai = near(M.spot);
      const otm = l.type === 'CE' ? 1 : -1;
      const v = l.strike.value;
      let i;
      switch (l.strike.by) {
        case 'atm': i = ai + otm * Math.round(v); break;
        case 'pct': i = near(M.spot * (1 + (otm * v) / 100)); break;
        case 'pts': i = near(M.spot + otm * v); break;
        case 'straddle': i = near(ks[ai] + otm * ((M.px(ks[ai], 'CE') || 0) + (M.px(ks[ai], 'PE') || 0)) * (v || 1)); break;
        case 'sr': {
          const list = (lv?.levels || []).filter((x) => (l.strike.lv && l.strike.lv !== 'any' ? x.cls === l.strike.lv : true) && (l.type === 'CE' ? x.price > M.spot : x.price < M.spot));
          const best = list.sort((a, b) => Math.abs(a.price - M.spot) - Math.abs(b.price - M.spot))[0];
          i = (best ? near(best.price) : ai) + otm * Math.round(v);
          if (!best) warn.push('no S/R level found, used ATM');
          break;
        }
        case 'signal': i = ai + Math.round(v); warn.push('"signal" strikes placed relative to ATM (no anomaly in the builder)'); break;
        default: { // premium / delta
          const order = ks.map((_, j) => j).filter((j) => (j - ai) * otm >= -4);
          const val = (j) => { const px = M.px(ks[j], l.type); if (!px) return null; if (l.strike.by === 'premium') return px; const iv = ivOf(px, M.spot, ks[j], M.T, l.type === 'CE'); return iv ? Math.abs(greeks(M.spot, ks[j], M.T, iv, l.type === 'CE').delta) : null; };
          const target = l.strike.by === 'delta' ? Math.abs(v > 1 ? v / 100 : v) : v;
          i = order.reduce((b, j) => { const x = val(j); return x != null && (b == null || Math.abs(x - target) < Math.abs(val(b) - target)) ? j : b; }, null) ?? ai;
        }
      }
      out.push({ action: l.action, type: l.type, strike: ks[Math.max(0, Math.min(ks.length - 1, i))], lots: l.lots, M, rule: l });
    }
    return { legs: out, warn: [...new Set(warn)] };
  }
  async function placeStrategy(s, note) {
    const r = await resolveStrategy(s);
    setFrom(s, note);
    for (const l of r.legs) addLeg(l.action, l.type, l.strike, l.lots * S.lots, l.M, s.name, { rule: l.rule });
    if (s.mode === 'positional' && S.src === 'hist') S.session = 'multi';
    record(); save(); renderTop(); render();
    if (r.warn.length) flash(r.warn.join(' · '));
  }
  function setFrom(s, note) { S.from = s ? { strategy: BT.clone(s), note: note || null } : null; }

  // ---------- position -> strategy ----------
  // Open, ticked legs as a relative strategy (ATM offsets + expiry codes), reusable on any expiry. Legs that came
  // from a strategy and still sit where its rule put them keep the rule (premium / delta / S/R…) and their SL /
  // target; moved or hand-picked legs become ATM offsets measured at the spot when they were entered. Timing and
  // risk rules come from the strategy the position was loaded from, if any.
  function toStrategy() {
    const legs = openLegs().filter(picked);
    if (!legs.length) { flash('Open a position first: its open, ticked legs become the strategy'); return null; }
    const M = market();
    if (!M) return null;
    const c = BT.meta.calendar || {};
    const list = S.src === 'hist' ? c.expired || [] : c.live || [];
    const from = S.from?.strategy;
    const s = from ? BT.complete(from) : BT.blankStrategy();
    const warn = [];
    if (!from) {
      const key = (l) => `${l.entryDay || ''}|${String(l.entryMin ?? 0).padStart(3, '0')}`;
      const first = legs.reduce((a, l) => (key(l) < key(a) ? l : a));
      s.name = `${SBAdjust.structure(legs).name} (builder)`;
      s.desc = 'Built in the Strategy Builder';
      if (first.entryMin != null) s.entry.time = hhmm(first.entryMin);
      if (S.src === 'hist' && S.session === 'multi') {
        s.mode = 'positional';
        const di = cal?.days.indexOf(first.entryDay) ?? -1;
        s.entry.dteDays = di >= 0 ? cal.days.length - 1 - di : 2;
      }
    }
    s.legs = legs.map((l) => {
      const Ml = mk(l, M);
      const def = l.rule ? BT.clone(l.rule) : {};
      Object.assign(def, { action: l.action, type: l.type, lots: l.lots });
      if (!l.rule || l.strike !== l.ruleStrike) def.strike = { by: 'atm', value: BT.atmOffset(l.strike, l.spotIn ?? M.spot, BT.strikeStep(Ml.ks), l.type), match: 'closest' };
      if (!l.rule || legExp(l) !== l.ruleExpiry) {
        const code = BT.expiryCode(legExp(l), primary(), list, c.monthly || [], s.expiry === 'monthly');
        if (!code) warn.push(`${l.strike} ${l.type} (${dayShort(legExp(l))}) has no relative expiry code, saved as this week`);
        def.expiry = code || 'cur';
      }
      return def;
    });
    return { s: BT.complete(s), warn };
  }
  async function saveAsStrategy() {
    const r = toStrategy();
    if (!r) return;
    const { s, warn } = r;
    const mine = s.id?.startsWith('my-');
    const name = prompt(`Save the open position as a strategy (strikes relative to ATM, so it works on any expiry).${warn.length ? '\n\n⚠ ' + warn.join('\n⚠ ') : ''}\n\nName:`, mine || s.name.endsWith('(builder)') ? s.name : s.name + ' (mine)');
    if (!name) return;
    if (!mine || name !== s.name) s.id = null; // a new strategy, unless it is one of yours kept under the same name
    s.name = name;
    try {
      const saved = await BT.saveStrategy(s);
      setFrom(saved, S.from?.note);
      save(); renderTop();
      flash(`Saved "${saved.name}" ✓ in Strategies › My strategies`);
    } catch (e) { alert('Could not save: ' + e.message); }
  }
  function backtestPosition() {
    const r = toStrategy();
    if (!r) return;
    if (r.warn.length) alert(r.warn.join('\n'));
    BT.emit('open-backtest', { strategy: r.s, run: false });
  }

  // ---------- opened from another screen ----------
  // o: { strategy, src: 'hist' | 'live', expiry, day, time, session, note, pay: { daysAhead, ivShift },
  //      legs?: [{ action, type, strike, expiry, lots | qty, px?, rule?, ruleStrike? }] }. Without legs the strategy
  //      is resolved on the chain at that moment, like Apply.
  BT.on('open-builder', (o) => {
    pause();
    clearPosition();
    S.src = o.src === 'hist' ? 'hist' : 'live';
    if (S.src === 'hist') {
      if (o.expiry) S.expiry = o.expiry;
      S.day = o.day || null;
      if (o.time) S.startTime = o.time;
      S.m = minOf(S.startTime);
      if (o.session) S.session = o.session;
    } else if (o.expiry) S.liveExpiry = o.expiry;
    S.chainExp = null;
    S.pay = { daysAhead: o.pay?.daysAhead || 0, ivShift: o.pay?.ivShift || 0 }; // a new position starts from today's market unless the sender had a what-if
    pending = o;
    save();
    window.app.setView('sb'); // fires 'viewchange' -> init() -> activate(), which places the pending position
  });
  async function placePending() {
    const o = pending;
    if (!o) return;
    if (!o.legs?.length) { pending = null; if (o.strategy) await placeStrategy(o.strategy, o.note); return; }
    setFrom(o.strategy, o.note);
    const warn = [];
    for (const l of o.legs) {
      const exp = l.expiry || primary();
      try { await ensureExp(exp); } catch { /* reported below */ }
      const M = market(exp);
      if (!M) { warn.push(`${l.strike} ${l.type}: no prices for ${dayShort(exp)}`); continue; }
      const lots = l.lots || Math.max(1, Math.round((l.qty || M.lot) / M.lot));
      if (!addLeg(l.action, l.type, l.strike, lots, M, o.note || o.strategy?.name, { px: l.px, rule: l.rule, ruleStrike: l.ruleStrike, ruleExpiry: exp })) warn.push(`${l.strike} ${l.type} has no price`);
    }
    pending = null; // kept until here so loadDay() also fetches the handed-over strikes outside the usual window
    if (o.strategy?.mode === 'positional' && S.src === 'hist') S.session = 'multi';
    record(); save(); renderTop(); render();
    if (warn.length) flash(warn.join(' · '));
  }

  // ---------- replay ----------
  async function setDay(day, m) {
    S.day = day;
    S.m = m;
    busy = true;
    try {
      await loadDay(day);
      for (const e of extraExps()) await loadDay(day, false, e).catch(() => {}); // other expiries held / viewed (missing data just shows no price)
    } finally { busy = false; }
    loadLevels(day).then(render);
  }
  function lastMinute() { return MPD - 1; }
  async function step(n = S.step) {
    if (S.src !== 'hist' || busy || !cal) return;
    const di = cal.days.indexOf(S.day);
    let day = S.day;
    let m = S.m;
    if (n === '1d') {
      if (S.session === 'intraday' || di >= cal.days.length - 1) return endOfRun('No further day in this session');
      day = cal.days[di + 1];
    } else {
      m += n;
      if (m > lastMinute()) {
        if (S.session === 'intraday' || di >= cal.days.length - 1) { S.m = lastMinute(); return endOfRun(S.session === 'intraday' ? 'End of the trading day' : 'Expiry reached'); }
        day = cal.days[di + 1];
        m = 0;
      }
    }
    await setDay(day, m);
    record();
    render();
  }
  // Mirror of step(): move the replay clock back by one step (the reverse of what step() does to the clock and the P&L curve).
  async function stepBack(n = S.step) {
    if (S.src !== 'hist' || busy || !cal) return;
    pause();
    const di = cal.days.indexOf(S.day);
    let day = S.day;
    let m = S.m;
    if (n === '1d') {
      if (S.session === 'intraday' || di <= 0) { flash('No earlier day in this session'); return; }
      day = cal.days[di - 1];
    } else {
      m -= n;
      if (m < 0) {
        if (S.session === 'intraday' || di <= 0) { if (S.m === 0) { flash('Start of the trading day'); return; } m = 0; } else {
          day = cal.days[di - 1];
          m = lastMinute();
        }
      }
    }
    S.mtm.pop(); // drop the point for the minute we are leaving
    await setDay(day, m);
    record();
    render();
  }
  function endOfRun(why) {
    pause();
    const M = market();
    if (M && openLegs().length) {
      const isExpiry = S.day === S.expiry;
      for (const l of openLegs()) closeLeg(l, M, null, isExpiry ? 'settled at expiry' : 'session end');
      if (isExpiry) log('Expiry: open legs closed at the last traded price', M);
    }
    flash(why);
    record();
    save();
    render();
  }
  function record() {
    const M = market();
    if (!M) return;
    const P = pnl(M);
    if (S.mtm.length && S.mtm[S.mtm.length - 1].l === M.label) S.mtm.pop();
    S.mtm.push({ l: M.label, p: Math.round(P.total), s: Math.round(M.spot), by: P.by });
    if (S.mtm.length > 3000) S.mtm.shift();
    save();
  }
  function play() {
    if (playTimer) return;
    const tick = async () => { await step(); if (playTimer) playTimer = setTimeout(tick, S.speed); };
    playTimer = setTimeout(tick, 50);
    renderReplay();
  }
  function pause() { clearTimeout(playTimer); playTimer = null; renderReplay(); }

  // ---------- init / top bar ----------
  async function init() {
    if (!inited) {
      inited = true;
      BT.on('meta', () => { renderTop(); });
    }
    await BT.loadMeta().catch(() => {});
    renderTop();
    await activate();
  }
  async function activate() {
    pause();
    clearInterval(liveTimer);
    if (S.src === 'hist') {
      const exp = BT.meta.calendar?.expired || [];
      if (!S.expiry || !exp.includes(S.expiry)) S.expiry = exp[exp.length - 1] || null;
      if (!S.expiry) { renderEmpty('No expired expiries — log in to Upstox to load the calendar.'); return; }
      try {
        cal = await BT.api('/api/sb/days?expiry=' + S.expiry);
        if (!S.day || !cal.days.includes(S.day)) S.day = cal.days[Math.max(0, cal.days.length - 5)] || cal.days[0];
        renderTop();
        $('sbChain').innerHTML = '<div class="muted pad">Loading the day\'s option prices (first time downloads them)…</div>';
        await setDay(S.day, S.m);
        record();
      } catch (e) { renderEmpty(e.message); return; }
    } else {
      const lv = BT.meta.calendar?.live || [];
      if (!S.liveExpiry || !lv.includes(S.liveExpiry)) S.liveExpiry = lv[0] || null;
      renderTop();
      $('sbChain').innerHTML = '<div class="muted pad">Loading the live chain…</div>';
      await loadLive();
      loadLevels(null).then(render);
      liveTimer = setInterval(async () => { if (window.app.state.view !== 'sb' || S.src !== 'live') return; await loadLive(); record(); render(); }, 5000);
      record();
    }
    render();
    if (pending) await placePending();
  }
  function renderEmpty(msg) {
    $('sbChain').innerHTML = `<div class="err pad">${esc(msg)}</div>`;
  }

  function renderTop() {
    const exp = BT.meta.calendar?.expired || [];
    const lv = BT.meta.calendar?.live || [];
    const strategies = [...(BT.meta.saved || []), ...(BT.meta.library || [])];
    const groups = {};
    for (const s of BT.meta.saved || []) (groups['My strategies'] ||= []).push(s);
    for (const s of BT.meta.library || []) (groups[s.category] ||= []).push(s);
    $('sbTop').innerHTML = `<div class="set-row">
      <div class="seg sm" id="sbSrc"><button data-src="hist" class="${S.src === 'hist' ? 'on' : ''}">Historical replay</button><button data-src="live" class="${S.src === 'live' ? 'on' : ''}">Live (paper)</button></div>
      ${S.src === 'hist' ? `
        <span class="lbl">Expiry</span><select id="sbExpiry">${exp.slice().reverse().map((e) => `<option value="${e}" ${e === S.expiry ? 'selected' : ''}>${dayLabel(e)}${BT.meta.calendar.monthly.includes(e) ? ' (M)' : ''}</option>`).join('')}</select>
        <span class="lbl">Start</span><select id="sbDay">${(cal?.expiry === S.expiry ? cal.days : []).map((d) => `<option value="${d}" ${d === S.day ? 'selected' : ''}>${WD[new Date(d + 'T00:00:00Z').getUTCDay()]} ${dayShort(d)}${d === S.expiry ? ' (expiry)' : ''}</option>`).join('')}</select>
        <input type="time" id="sbTime" value="${S.startTime}" step="60" title="Start time">
        <button class="btn-sm ghost" id="sbGo" title="Jump to this day and time (keeps the position)">Go</button>
        <span class="lbl">Session</span><div class="seg sm" id="sbSession"><button data-s="intraday" class="${S.session === 'intraday' ? 'on' : ''}">Intraday</button><button data-s="multi" class="${S.session === 'multi' ? 'on' : ''}">Multi-day</button></div>`
      : `<span class="lbl">Expiry</span><select id="sbLiveExpiry">${lv.slice(0, 10).map((e) => `<option value="${e}" ${e === S.liveExpiry ? 'selected' : ''}>${dayLabel(e)}</option>`).join('')}</select>
        <span class="muted small">Paper trading on the live chain (LTP fills); refreshes every 5 s. No orders are sent.</span>`}
      <span class="spacer"></span>
      <span class="lbl">Strategy</span><select id="sbStrat"><option value="">— custom (click B / S in the chain) —</option>${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('')}</select>
      <button class="btn-sm" id="sbApply" title="Place this strategy's legs on the chain at the current time">Apply</button>
      <label class="mini">Lots <input class="num xs" type="number" id="sbLots" min="1" max="100" value="${S.lots}"></label>
      <button class="btn-sm ghost" id="sbSaveStrat" title="Save the open, ticked legs as a strategy (strikes relative to ATM, so it works on any expiry)">💾 Save as strategy</button>
      <button class="btn-sm ghost" id="sbBacktest" title="Open the open, ticked legs as a strategy in the Backtest">Backtest ▸</button>
      <button class="btn-sm ghost danger" id="sbClear" title="Close the position view and start again">Reset</button>
    </div>${S.from ? `<div class="sb-from"><span>Loaded from <b>${esc(S.from.strategy.name)}</b>${S.from.note ? ` · ${esc(S.from.note)}` : ''}</span>
      <span class="muted">${esc(BT.timingLabel(BT.complete(S.from.strategy)))} · its stop-loss / target / exit-time rules are not automated here: step the replay and manage the legs by hand.</span>
      <button class="icon" id="sbFromClose" title="Hide this note (the legs stay)">✕</button></div>` : ''}`;
    void strategies;
    renderReplay();
  }

  function renderReplay() {
    const el = $('sbReplay');
    if (S.src !== 'hist') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const M = market();
    const di = cal?.days.indexOf(S.day) ?? -1;
    const dte = cal ? cal.days.length - 1 - di : null;
    el.innerHTML = `<div class="set-row">
      <b class="sb-clock">${M ? esc(M.label) : '—'}</b>
      <span>Nifty <b>${M ? num(M.spot, 2) : '—'}</b></span>
      <span class="muted">${dte != null && dte >= 0 ? (dte ? `${dte} trading day${dte > 1 ? 's' : ''} to expiry` : 'expiry day') : ''}</span>
      <span class="spacer"></span>
      <button class="btn-sm ghost" data-r="restart" title="Back to the start day and time, clearing the position">⏮ Restart</button>
      <button class="btn-sm ghost" data-r="reset" title="Clear all strikes, P&amp;L and logs for a completely fresh start">🗑 Reset</button>
      <button class="btn-sm ghost" data-r="back" title="Go back one step">◀ Step</button>
      <button class="btn-sm ghost" data-r="step" title="Advance one step">▶ Step</button>
      <button class="btn-sm ${playTimer ? '' : 'ghost'}" data-r="play">${playTimer ? '⏸ Pause' : '⏵ Auto play'}</button>
      <span class="lbl">Step</span><div class="seg sm" id="sbStep">${STEPS.map(([v, l]) => `<button data-step="${v}" class="${String(S.step) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="lbl">Speed</span><select id="sbSpeed">${SPEEDS.map(([v, l]) => `<option value="${v}" ${S.speed === v ? 'selected' : ''}>${l}/step</option>`).join('')}</select>
    </div>`;
  }

  // ---------- render ----------
  function render() {
    if (window.app.state.view !== 'sb') return;
    renderReplay();
    const M = market();
    if (!M) { const le = liveMap.get(S.liveExpiry); if (S.src === 'live' && le?.error) renderEmpty(le.error); return; }
    const A = analyse(M);
    const Aw = S.pay.daysAhead || S.pay.ivShift ? analyse(M, true) : A;
    renderChainExp();
    const Mv = market(viewedExp());
    if (Mv) renderChain(Mv);
    else if (failedKeys.has(`${S.src}|${viewedExp()}|${S.day}`)) $('sbChain').innerHTML = '<div class="muted pad">No price data for this expiry on this day. Pick another expiry.</div>';
    else { $('sbChain').innerHTML = '<div class="muted pad">Loading this expiry\'s prices…</div>'; ensureView(); }
    renderPayoff(M, Aw);
    renderPositions(M, A);
    renderSuggestions(M, A);
  }

  // ---------- vertical-spread arbitrage ----------
  // For one expiry and one option type, a vertical spread can never be worth less than 0 or more than its width
  // (strike gap). Prices that break those bounds are a risk-free gain at expiry, before costs:
  //   calls: C(lo) < C(hi)  -> buy lo, sell hi (paid to take a spread that cannot lose)
  //          C(lo) - C(hi) > hi - lo -> sell lo, buy hi (credit above the most it can ever cost)
  //   puts : P(lo) > P(hi)  -> sell lo, buy hi
  //          P(hi) - P(lo) > hi - lo -> sell hi, buy lo
  // Live prices use what you would really get (sell at bid, buy at ask) when the book is there; replay uses closes.
  const ARB_MIN = 0.5; // smallest edge (index points) worth showing
  let arbs = []; // everything found
  let arbsShown = []; // after the CE / PE filter, in the order listed
  const nq = (n) => (n == null ? '—' : window.app?.compact ? window.app.compact(n) : String(n));
  function findArbs(M) {
    const out = [];
    const live = S.src === 'live';
    const book = (k, t) => (live ? M.quote(k, t) : null);
    const sellPx = (k, t) => { const q = book(k, t); return q?.bid > 0 ? q.bid : M.px(k, t); };
    const buyPx = (k, t) => { const q = book(k, t); return q?.ask > 0 ? q.ask : M.px(k, t); };
    // Order-book depth behind a leg: selling needs buyers at the bid, buying needs sellers at the ask.
    const leg = (act, k, t) => {
      const q = book(k, t);
      return { act, k, px: act === 'S' ? sellPx(k, t) : buyPx(k, t), qty: q ? (act === 'S' ? q.bidQ : q.askQ) ?? null : null, buyers: q?.tbq ?? null, sellers: q?.tsq ?? null };
    };
    for (const t of ['CE', 'PE']) {
      // only the strikes shown in the chain, and only sane prices (stale prints below intrinsic value are not tradeable)
      const at = M.ks.indexOf(atmOf(M));
      const ks = M.ks.slice(Math.max(0, at - S.width), at + S.width + 1).filter((k) => M.px(k, t) > 0.05 && ivOf(M.px(k, t), M.spot, k, M.T, t === 'CE') != null);
      for (let i = 0; i < ks.length; i++) {
        for (let j = i + 1; j < ks.length; j++) {
          const lo = ks[i];
          const hi = ks[j];
          const w = hi - lo;
          let a = null;
          if (t === 'CE') {
            const order = sellPx(hi, t) - buyPx(lo, t); // buy lo, sell hi for a credit
            const width = sellPx(lo, t) - buyPx(hi, t) - w; // sell lo, buy hi for more than the width
            if (order >= ARB_MIN) a = { kind: 'free credit', edge: order, legs: [['B', lo], ['S', hi]] };
            else if (width >= ARB_MIN) a = { kind: 'credit above width', edge: width, legs: [['S', lo], ['B', hi]] };
          } else {
            const order = sellPx(lo, t) - buyPx(hi, t); // sell lo, buy hi for a credit
            const width = sellPx(hi, t) - buyPx(lo, t) - w; // sell hi, buy lo for more than the width
            if (order >= ARB_MIN) a = { kind: 'free credit', edge: order, legs: [['S', lo], ['B', hi]] };
            else if (width >= ARB_MIN) a = { kind: 'credit above width', edge: width, legs: [['S', hi], ['B', lo]] };
          }
          if (!a) continue;
          const info = a.legs.map(([act, k]) => leg(act, k, t));
          const qtys = info.map((x) => x.qty);
          // lots both legs can fill at the quoted price (live only; the replay has no order book)
          const fit = live && qtys.every((x) => x != null) ? Math.floor(Math.min(...qtys) / M.lot) : null;
          out.push({ ...a, type: t, lo, hi, expiry: M.expiry, info, fit, dist: Math.min(Math.abs(lo - M.spot), Math.abs(hi - M.spot)) });
        }
      }
    }
    // nearest the money first, then the bigger edge
    return out.sort((x, y) => x.dist - y.dist || y.edge - x.edge);
  }
  function renderArb(M) {
    arbs = findArbs(M);
    const el = $('sbArb');
    const f = S.arbType || 'ALL';
    const cnt = { ALL: arbs.length, CE: arbs.filter((a) => a.type === 'CE').length, PE: arbs.filter((a) => a.type === 'PE').length };
    const filt = `<span class="seg sm" id="sbArbFilter">${['ALL', 'CE', 'PE'].map((v) => `<button data-af="${v}" class="${f === v ? 'on' : ''}">${v === 'ALL' ? 'All' : v} ${cnt[v]}</button>`).join('')}</span>`;
    if (!arbs.length) { el.innerHTML = `<div class="arb-head">${filt} <span class="muted small">Vertical-spread arbitrage: none found on this expiry (call and put prices respect the no-arbitrage bounds).</span></div>`; arbsShown = []; return; }
    arbsShown = arbs.filter((a) => f === 'ALL' || a.type === f);
    const shown = arbsShown.slice(0, 8);
    const live = S.src === 'live';
    const row = (a, i) => {
      const depth = a.info.map((x) => `<span class="${x.act === 'B' ? 'pos' : 'neg'}">${x.act === 'S' ? 'SELL' : 'BUY'} ${x.k}</span> ${x.act === 'S' ? 'buyers' : 'sellers'} at ${x.px?.toFixed(2)}: <b>${nq(x.qty)}</b> <span class="muted">(book ${nq(x.buyers)} buy / ${nq(x.sellers)} sell)</span>`).join(' · ');
      const badge = !live ? '<span class="arb-fit na" title="The replay has no order book">depth n/a (replay)</span>'
        : a.fit == null ? '<span class="arb-fit na" title="No depth in the quote">depth unknown</span>'
          : `<span class="arb-fit ${a.fit >= chainLots() ? 'ok' : a.fit > 0 ? 'thin' : 'none'}" title="Lots both legs can fill at the quoted price">${a.fit >= chainLots() ? '✔' : '⚠'} ${a.fit} lot${a.fit === 1 ? '' : 's'} fillable</span>`;
      return `<div class="arb-row"><span class="arb-leg">${a.legs.map(([act, k]) => `<b class="${act === 'B' ? 'pos' : 'neg'}">${act === 'B' ? 'BUY' : 'SELL'}</b> ${k} ${a.type}`).join(' + ')}</span>
        <span class="muted small">${a.kind} · ${a.dist === 0 ? 'at the money' : `${Math.round(a.dist)} pts from Nifty`}</span> <b class="pos" title="Guaranteed minimum gain per lot">+${a.edge.toFixed(2)} pts · ${inr(a.edge * M.lot)}/lot</b> ${badge}
        <button class="btn-sm ghost" data-arb="${i}" title="Add both legs to the position and payoff chart">Add to position</button>
        ${live ? `<div class="arb-depth small">${depth}</div>` : ''}</div>`;
    };
    el.innerHTML = `<div class="arb-head">${filt} <b>⚡ ${arbsShown.length} vertical-spread arbitrage${arbsShown.length === 1 ? '' : 's'}</b> <span class="muted small">nearest the money first · risk-free at expiry before brokerage and slippage${live ? '; priced at bid/ask' : '; replay uses last traded prices, so a stale print can look like an arbitrage'}</span></div>`
      + (shown.length ? shown.map(row).join('') : '<div class="muted small">None of this type.</div>')
      + (arbsShown.length > shown.length ? `<div class="muted small">+${arbsShown.length - shown.length} farther from the money</div>` : '');
  }
  function renderChainExp() {
    const el = $('sbChainExp');
    if (!el) return;
    const list = chainExpiries();
    const v = viewedExp();
    const mo = BT.meta.calendar?.monthly || [];
    const days = (e) => Math.round((Date.parse(e) - Date.parse(S.src === 'hist' ? S.day : new Date().toISOString().slice(0, 10))) / 86400000);
    const cl = $('sbChainLots');
    if (cl) { cl.placeholder = String(S.lots); if (document.activeElement !== cl) cl.value = S.chainLots || ''; }
    el.innerHTML = list.map((e) => `<option value="${e}" ${e === v ? 'selected' : ''}>${dayLabel(e)}${mo.includes(e) ? ' (M)' : ''} · ${days(e)}d</option>`).join('');
  }
  function renderChain(M) {
    const atm = atmOf(M);
    const idx = M.ks.indexOf(atm);
    const ks = M.ks.slice(Math.max(0, idx - S.width), idx + S.width + 1);
    const held = new Map();
    const heldAny = new Set(openLegs().filter((x) => legExp(x) === M.expiry).map((x) => x.strike + x.type)); // incl. unticked legs
    for (const l of openLegs().filter(picked).filter((x) => legExp(x) === M.expiry)) held.set(l.strike + l.type, (held.get(l.strike + l.type) || 0) + dir(l) * l.lots);
    const lv = levels.get(S.src === 'hist' ? S.day : 'live')?.levels || [];
    const step = ks[1] - ks[0] || 50;
    const tag = (k) => {
      const h = lv.filter((x) => Math.abs(x.price - k) < step / 2);
      if (!h.length) return '';
      const r = h[0].price > M.spot;
      return `<span class="lv-tag ${r ? 'r' : 's'}${h.some((x) => x.cls === 'major') ? ' major' : ''}" title="${esc(h.map((x) => `${x.price} ${x.cls} · ${x.src}`).join('\n'))}">${r ? 'R' : 'S'}</span>`;
    };
    const cell = (k, t) => {
      const px = M.px(k, t);
      const call = t === 'CE';
      const iv = ivOf(px, M.spot, k, M.T, call);
      const d = iv ? greeks(M.spot, k, M.T, iv, call).delta : null;
      const q = M.quote(k, t);
      const h = held.get(k + t);
      const itm = call ? k < M.spot : k > M.spot;
      const btns = `<span class="sb-bs"><button data-add="B" data-k="${k}" data-t="${t}" title="Buy ${k} ${t}">B</button><button data-add="S" data-k="${k}" data-t="${t}" title="Sell ${k} ${t}">S</button>${heldAny.has(k + t) ? `<button data-rm="1" data-k="${k}" data-t="${t}" title="Remove the last added ${k} ${t} leg (deletes the entry, no trade)">✕</button>` : ''}</span>`;
      const pos = h ? `<span class="sb-held ${h > 0 ? 'pos' : 'neg'}" title="Open position">${h > 0 ? '+' : ''}${h}</span>` : '';
      const parts = [`<td class="${itm ? 'itm' : ''} sb-ltp">${px == null ? '—' : num(px)}${pos}</td>`, `<td class="muted ${itm ? 'itm' : ''}">${d == null ? '—' : d.toFixed(2)}</td>`, `<td class="muted ${itm ? 'itm' : ''}">${iv ? (iv * 100).toFixed(1) : '—'}</td>`];
      if (S.src === 'live') parts.push(`<td class="muted ${itm ? 'itm' : ''}">${q?.oi ? window.app.compact(q.oi) : '—'}</td>`);
      parts.push(`<td class="${itm ? 'itm' : ''}">${btns}</td>`);
      return call ? parts.reverse().join('') : parts.join('');
    };
    const head = (call) => { const h = ['LTP', 'Δ', 'IV']; if (S.src === 'live') h.push('OI'); h.push(''); return (call ? h.reverse() : h).map((x) => `<th>${x}</th>`).join(''); };
    let spotDone = false;
    const rows = ks.map((k) => {
      let pre = '';
      if (!spotDone && k > M.spot) { pre = `<tr class="spot-row"><td colspan="${S.src === 'live' ? 11 : 9}"></td></tr>`; spotDone = true; }
      return `${pre}<tr class="${k === atm ? 'atm' : ''}">${cell(k, 'CE')}<td class="strike">${k}${tag(k)}</td>${cell(k, 'PE')}</tr>`;
    }).join('');
    $('sbChain').innerHTML = `<table class="chain sb-chain-tbl"><thead><tr class="side-head"><th colspan="${S.src === 'live' ? 5 : 4}" class="ce-h">CALLS</th><th></th><th colspan="${S.src === 'live' ? 5 : 4}" class="pe-h">PUTS</th></tr><tr>${head(true)}<th class="strike-h">Strike</th>${head(false)}</tr></thead><tbody>${rows}</tbody></table>`;
    renderArb(M);
    $('sbChainInfo').textContent = `· ${dayShort(M.expiry)} · lot ${M.lot} · ATM IV ${((atmIv(M) || 0) * 100).toFixed(1)}%`;
  }

  // Nearest support / resistance at the current spot, marked on the payoff chart.
  function nearLevels(M) {
    const lv = levels.get(S.src === 'hist' ? S.day : 'live')?.levels || [];
    const by = (f) => lv.filter(f).sort((a, b) => Math.abs(a.price - M.spot) - Math.abs(b.price - M.spot))[0] || null;
    return { resistance: by((x) => x.price > M.spot), support: by((x) => x.price < M.spot) };
  }
  function renderPayoff(M, A) {
    const has = A.legs.length;
    $('sbKpis').innerHTML = BT.payoff.kpis(A, { pnl: A.P.total });
    $('sbPayInfo').textContent = has ? `${SBAdjust.structure(A.legs).name} · ${M.label}` : 'add legs to see the payoff';
    $('sbPayCtl').classList.toggle('hidden', !has);
    BT.payoff.controls($('sbPayCtl'), A, S.pay, () => { save(); const Mn = market(); if (Mn) renderPayoff(Mn, analyse(Mn, true)); });
    const near = has ? A.legs.map(legExp).sort()[0] : null;
    BT.payoff.draw($('sbPayChart'), A, { expiryLabel: near ? dayShort(near) : '', nowLabel: M.label, levels: nearLevels(M) });
  }

  function renderPositions(M, A) {
    const lot = M.lot;
    const rows = S.legs.slice().sort((a, b) => (b.open - a.open) || a.id - b.id).map((l) => {
      const Ml = mk(l, M);
      const now = l.open ? Ml.px(l.strike, l.type) : l.exitPx;
      const p = now == null ? null : dir(l) * l.lots * Ml.lot * (now - l.entryPx);
      const g = l.open ? A.legs.find((x) => x.id === l.id)?.g : null;
      return `<tr class="${l.open ? '' : 'closed'}${picked(l) ? '' : ' unpicked'}" ${picked(l) ? '' : 'style="opacity:.45"'}>
        <td><input type="checkbox" data-pick="${l.id}" ${picked(l) ? 'checked' : ''} title="Include this leg in the payoff, Greeks, P&amp;L and suggestions"></td>
        <td class="${l.action === 'B' ? 'pos' : 'neg'}"><b>${l.action === 'B' ? 'BUY' : 'SELL'}</b></td><td>${l.open ? `<input class="num xs" type="number" min="1" step="1" data-lots="${l.id}" value="${l.lots}" title="Change the number of lots of this leg">` : l.lots}</td><td class="nowrap">${l.open ? `<button class="icon sb-kbtn" data-shift="${l.id}" data-d="-1" ${nextStrike(l, -1, M) == null ? 'disabled' : ''} title="Change to the next lower strike (edits this leg as if entered there; no exit trade)">−</button>` : ''}<b>${l.strike} ${l.type}</b>${l.open ? `<button class="icon sb-kbtn" data-shift="${l.id}" data-d="1" ${nextStrike(l, 1, M) == null ? 'disabled' : ''} title="Change to the next higher strike (edits this leg as if entered there; no exit trade)">+</button>` : ''}</td>
        <td>${l.open ? expirySelect(l) : `<span class="muted small">${dayShort(legExp(l))}</span>`}</td>
        <td class="muted small">${esc(l.entryAt)}</td><td>${num(l.entryPx)}</td>
        <td>${l.open ? num(now) : `${num(l.exitPx)} <span class="muted small">${esc(l.exitAt)}</span>`}</td>
        <td>${g ? g.delta.toFixed(2) : ''}</td>
        <td class="${cls(p)} b">${p == null ? '—' : inrS(p)}</td>
        <td class="nowrap">${l.open ? `<button class="icon" data-roll="${l.id}" data-d="-1" title="Roll one strike down: exits this leg at the current price (booking its P&amp;L) and opens the next lower strike">◀</button><button class="icon" data-roll="${l.id}" data-d="1" title="Roll one strike up: exits this leg at the current price (booking its P&amp;L) and opens the next higher strike">▶</button><input class="num xs" type="number" min="1" step="1" data-lots="${l.id}" value="${l.lots}" title="Lots of this leg — change it to resize the position (payoff, Greeks and P&amp;L update)"><button class="btn-sm ghost" data-close="${l.id}" title="Exit this leg (asks how many lots when more than one)">Exit</button>` : `<span class="muted small">closed</span> <button class="btn-sm ghost" data-reopen="${l.id}" title="Undo the exit: the leg becomes open again at its original entry price">Re-open</button>`} <button class="icon" data-remove="${l.id}" title="Remove this strike from the position (deletes the entry as if never added; not an exit)">✕</button></td></tr>`;
    }).join('');
    $('sbPnlHead').innerHTML = S.legs.length ? `Realised <b class="${cls(A.P.realised)}">${inrS(A.P.realised)}</b> · Open <b class="${cls(A.P.open)}">${inrS(A.P.open)}</b> · Total <b class="${cls(A.P.total)}">${inrS(A.P.total)}</b> ${openLegs().length ? '<button class="btn-sm ghost" id="sbExitAll">Exit all</button>' : ''}` : '';
    const typing = !forceRebuild && document.activeElement?.closest?.('#sbPos') && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (!typing) $('sbPos').innerHTML = S.legs.length ? `<div class="tbl-wrap"><table class="grid-tbl sb-pos-tbl"><thead><tr><th></th><th>Side</th><th>Lots</th><th>Strike</th><th>Expiry</th><th>Entered</th><th>Entry</th><th>Now / exit</th><th>Δ</th><th>P&amp;L</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="muted pad">No trades yet. Click <b>B</b> or <b>S</b> next to a price in the chain, or pick a strategy and press <b>Apply</b>. Then step the replay to see the P&amp;L evolve.</div>';
    // MTM over the replay
    const onIds = new Set(S.legs.filter(picked).map((l) => String(l.id)));
    const pts = S.mtm.slice(-600).map((x) => (x.by ? { ...x, p: Object.entries(x.by).reduce((s, [id, v]) => s + (onIds.has(id) ? v : 0), 0) } : x));
    BT.chart($('sbMtmChart'), {
      data: {
        labels: pts.map((x) => x.l),
        datasets: [
          { type: 'line', label: 'P&L', data: pts.map((x) => x.p), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.12)', fill: 'origin', pointRadius: 0, borderWidth: 1.6, yAxisID: 'y' },
          { type: 'line', label: 'Nifty', data: pts.map((x) => x.s), borderColor: '#d6af4c', pointRadius: 0, borderWidth: 1, yAxisID: 'y2' },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.datasetIndex ? `Nifty ${c.raw}` : `P&L ${inrS(c.raw)}`) } } },
        scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { ticks: { callback: (v) => kinr(v) } }, y2: { position: 'right', grid: { display: false } } },
      },
    });
    $('sbLog').innerHTML = S.log.slice(0, 30).map((x) => `<div><span class="muted">${esc(x.at)}</span> ${esc(x.text)}</div>`).join('');
  }

  // ---------- suggestions ----------
  let lastSugg = [];
  function suggCtx(M, A) {
    const lot = M.lot;
    const step = (() => { const i = M.ks.indexOf(atmOf(M)); return M.ks[i + 1] - M.ks[i] || 50; })();
    const lv = levels.get(S.src === 'hist' ? S.day : 'live');
    const near = (side, cls) => (lv?.levels || []).filter((x) => (cls === 'any' || x.cls === cls) && (side === 'support' ? x.price < M.spot : x.price > M.spot)).sort((a, b) => Math.abs(a.price - M.spot) - Math.abs(b.price - M.spot))[0] || null;
    const L = lv ? { support: { major: near('support', 'major'), minor: near('support', 'minor'), any: near('support', 'any') }, resistance: { major: near('resistance', 'major'), minor: near('resistance', 'minor'), any: near('resistance', 'any') } } : null;
    return {
      spot: M.spot, strikes: M.ks, step, atm: atmOf(M), minute: M.minute, dte: M.T * 365, expiryDay: M.day === M.expiry,
      session: S.src === 'live' ? 'multi' : S.session, lot,
      legs: A.legs.filter((l) => legExp(l) === M.expiry).map((l) => ({ id: l.id, action: l.action, type: l.type, strike: l.strike, lots: l.lots, entryPx: l.entryPx, px: l.px, delta: l.g.delta, iv: l.iv })),
      pnl: A.P.total, openPnl: A.P.open, credit: A.P.credit, maxProfit: A.unlimP ? Infinity : A.maxP, maxLoss: A.unlimL ? -Infinity : A.maxL,
      greeks: A.g, atmIv: atmIv(M), atmIvEntry: S.atmIvEntry, levels: L, spotEntry: S.spotEntry,
      priceOf: (k, t) => M.px(k, t),
      deltaOf: (k, t) => { const px = M.px(k, t); const iv = ivOf(px, M.spot, k, M.T, t === 'CE'); return iv ? greeks(M.spot, k, M.T, iv, t === 'CE').delta : null; },
    };
  }
  function renderSuggestions(M, A) {
    lastSugg = SBAdjust.suggest(suggCtx(M, A));
    const SEV = { act: 'Act now', warn: 'Consider', info: 'Option', ok: 'OK' };
    $('sbSugg').innerHTML = lastSugg.map((s, i) => `<div class="sugg ${s.sev}">
      <div class="sugg-head"><span class="sugg-sev">${SEV[s.sev]}</span><b>${esc(s.title)}</b></div>
      <div class="small">${esc(s.why)}</div>
      ${s.ops?.length ? `<div class="sugg-ops">${s.ops.map((o) => `<span class="leg-chip ${o.op === 'open' ? (o.action === 'B' ? 'buy' : 'sell') : 'close'}">${o.op === 'close' ? 'Exit ' + legName(o.id) + (o.lots ? ` (${o.lots})` : '') : `${o.action === 'B' ? 'Buy' : 'Sell'} ${o.lots} × ${o.strike} ${o.type}`}</span>`).join(' ')}
        <button class="btn-sm" data-apply="${i}">Apply</button></div>` : ''}
      ${s.src ? `<div class="muted small sugg-src">Source: ${esc(s.src)}</div>` : ''}
    </div>`).join('');
  }
  const legName = (id) => { const l = S.legs.find((x) => x.id === id); return l ? `${l.strike} ${l.type}` : '#' + id; };
  function applyOps(ops, why) {
    const M = market();
    if (!M) return;
    for (const o of ops) {
      if (o.op === 'close') { const l = S.legs.find((x) => x.id === o.id && x.open); if (l) closeLeg(l, M, o.lots, why); }
    }
    for (const o of ops) if (o.op === 'open') addLeg(o.action, o.type, o.strike, o.lots || S.lots, M, why);
    record();
    save();
    render();
  }

  // Plain-text summary of the position for online research.
  function summary(M, A) {
    const st = SBAdjust.structure(A.legs).name;
    const lv = suggCtx(M, A).levels;
    const atm = atmOf(M);
    const near = M.ks.filter((k) => Math.abs(k - atm) <= 8 * 50);
    return [
      `Underlying: Nifty 50 at ${M.spot.toFixed(1)} (${S.src === 'hist' ? 'historical replay' : 'live'}), ${M.label}. Expiry ${M.expiry} (${(M.T * 365).toFixed(1)} calendar days left). Lot size ${M.lot}.`,
      `Structure: ${st}. Session: ${S.src === 'live' ? 'live' : S.session}.`,
      `Open legs: ${A.legs.map((l) => `${l.action === 'B' ? 'long' : 'short'} ${l.lots} lot ${l.strike} ${l.type} (expiry ${legExp(l)}) entered ${l.entryPx.toFixed(2)} now ${l.px?.toFixed(2) ?? '?'} (delta ${l.g.delta.toFixed(2)}, IV ${(l.iv * 100).toFixed(1)}%)`).join('; ') || 'none'}.`,
      `P&L: open ${Math.round(A.P.open)}, realised ${Math.round(A.P.realised)} INR. Net ${A.P.credit >= 0 ? 'credit' : 'debit'} ${Math.round(Math.abs(A.P.credit))} INR. Max profit ${A.unlimP ? 'unlimited' : Math.round(A.maxP)}, max loss ${A.unlimL ? 'unlimited' : Math.round(A.maxL)}, breakevens ${A.be.map(Math.round).join(', ') || 'none'}.`,
      `Greeks (position, INR): delta ${A.g.delta.toFixed(1)} (Nifty units), gamma ${A.g.gamma.toFixed(3)}, theta ${Math.round(A.g.theta)}/day, vega ${Math.round(A.g.vega)}/vol pt.`,
      `ATM IV now ${((atmIv(M) || 0) * 100).toFixed(1)}%${S.atmIvEntry ? `, at entry ${(S.atmIvEntry * 100).toFixed(1)}%` : ''}. Nifty at entry ${S.spotEntry?.toFixed(1) ?? '?'}.`,
      lv ? `Support/resistance: nearest resistance ${lv.resistance.any?.price ?? '-'} (major ${lv.resistance.major?.price ?? '-'}), nearest support ${lv.support.any?.price ?? '-'} (major ${lv.support.major?.price ?? '-'}).` : '',
      `Chain (strike: CE / PE LTP): ${near.map((k) => `${k}: ${M.px(k, 'CE')?.toFixed(1) ?? '-'} / ${M.px(k, 'PE')?.toFixed(1) ?? '-'}`).join(', ')}.`,
      `Rule-engine suggestions: ${lastSugg.map((s) => s.title).join(' | ')}.`,
    ].filter(Boolean).join('\n');
  }

  function md(text) {
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    let list = null;
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (h) out.push(`<h4>${inline(h[1])}</h4>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }
  async function runResearch() {
    const M = market();
    if (!M) return;
    const A = analyse(M);
    if (!A.legs.length) { flash('Open a position first — research looks up adjustments for it'); return; }
    const box = $('sbResearchOut');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="muted">Searching the web for adjustments for this position (≈20–60 s)…</div>';
    $('sbResearch').disabled = true;
    try {
      research = await BT.api('/api/sb/research', { summary: summary(M, A) });
      box.innerHTML = `<div class="muted small">Online research · ${esc(M.label)} · ${esc(research.model || '')}${research.cached ? ' · cached' : ''}</div>${md(research.text)}
        ${research.sources?.length ? `<div class="small"><b>Sources</b><ul>${research.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul></div>` : ''}`;
    } catch (e) {
      box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    } finally {
      $('sbResearch').disabled = false;
    }
  }

  let flashTimer;
  function flash(msg) {
    $('sbPayInfo').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => render(), 4000);
  }

  // ---------- events ----------
  $('sbTop').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.src && b.dataset.src !== S.src) {
      if (openLegs().length && !confirm('Switch source? The current position will be cleared.')) return;
      clearPosition();
      S.src = b.dataset.src;
      save();
      renderTop();
      activate();
    } else if (b.dataset.s) { S.session = b.dataset.s; save(); renderTop(); }
    else if (b.id === 'sbGo') { S.startTime = $('sbTime').value || '09:20'; pause(); await setDay($('sbDay').value, minOf(S.startTime)); record(); save(); render(); }
    else if (b.id === 'sbApply') {
      const s = BT.findStrategy($('sbStrat').value);
      if (!s || !market()) return;
      await placeStrategy(s);
    } else if (b.id === 'sbSaveStrat') saveAsStrategy();
    else if (b.id === 'sbBacktest') backtestPosition();
    else if (b.id === 'sbFromClose') { S.from = null; save(); renderTop(); }
    else if (b.id === 'sbClear') {
      if (S.legs.length && !confirm('Clear the position, P&L and log?')) return;
      clearPosition();
      S.chainMin = false; applyChainMin();
      record(); save(); render();
    }
  });
  function clearPosition() { pause(); S.legs = []; S.log = []; S.mtm = []; S.atmIvEntry = null; S.spotEntry = null; S.from = null; research = null; $('sbResearchOut').classList.add('hidden'); }
  $('sbTop').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'sbExpiry') {
      if (openLegs().length && !confirm('Change expiry? The current position will be cleared.')) { t.value = S.expiry; return; }
      clearPosition(); S.expiry = t.value; S.chainExp = null; S.day = null; save(); activate();
    } else if (t.id === 'sbDay') { pause(); await setDay(t.value, minOf($('sbTime').value)); record(); save(); render(); }
    else if (t.id === 'sbLiveExpiry') { if (openLegs().length && !confirm('Change expiry? The current position will be cleared.')) { t.value = S.liveExpiry; return; } clearPosition(); S.liveExpiry = t.value; S.chainExp = null; save(); activate(); }
    else if (t.id === 'sbLots') { S.lots = Math.max(1, Number(t.value) || 1); save(); }
  });
  $('sbReplay').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.step) { S.step = b.dataset.step === '1d' ? '1d' : Number(b.dataset.step); save(); renderReplay(); }
    else if (b.dataset.r === 'step') await step();
    else if (b.dataset.r === 'back') await stepBack();
    else if (b.dataset.r === 'reset') {
      if ((S.legs.length || S.log.length) && !confirm('Reset everything? All strikes, P&L and logs will be cleared.')) return;
      clearPosition();
      S.seq = 0;
      S.chainMin = false; applyChainMin(); // a fresh start also brings the minimized chain back
      if (S.src === 'hist') await setDay($('sbDay')?.value || S.day, minOf(S.startTime));
      record(); save(); render();
    }
    else if (b.dataset.r === 'play') (playTimer ? pause() : play());
    else if (b.dataset.r === 'restart') {
      if (S.legs.length && !confirm('Restart from the start day/time? The position and P&L will be cleared.')) return;
      clearPosition();
      await setDay($('sbDay')?.value || S.day, minOf(S.startTime));
      record(); save(); render();
    }
  });
  $('sbReplay').addEventListener('change', (e) => { if (e.target.id === 'sbSpeed') { S.speed = Number(e.target.value); save(); } });
  // Delete a leg outright (as if it was never added): no exit trade, no P&L from it.
  function removeLeg(id, M) {
    const i = S.legs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const l = S.legs[i];
    S.legs.splice(i, 1);
    log(`Removed ${l.lots} × ${l.strike} ${l.type} (${l.action === 'B' ? 'long' : 'short'}) from the position`, M);
    if (!openLegs().length) { S.atmIvEntry = null; S.spotEntry = null; }
    record(); save(); render();
  }
  $('sbArb').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-arb]');
    const f = e.target.closest('button[data-af]');
    if (f) { S.arbType = f.dataset.af; save(); const Mv = market(viewedExp()); if (Mv) renderArb(Mv); return; }
    const a = b && arbsShown[Number(b.dataset.arb)];
    const M = market(viewedExp());
    if (!a || !M) return;
    let ok = true;
    for (const [act, k] of a.legs) ok = addLeg(act, a.type, k, chainLots(), M, `vertical-spread arbitrage ${a.lo}/${a.hi} ${a.type}`) && ok;
    record(); save(); render();
    if (!ok) flash('One leg has no price right now');
  });
  $('sbChain').addEventListener('click', async (e) => {
    const rm = e.target.closest('button[data-rm]');
    if (rm) {
      const M = market(viewedExp());
      const k = Number(rm.dataset.k);
      const l = S.legs.filter((x) => x.open && legExp(x) === viewedExp() && x.strike === k && x.type === rm.dataset.t).pop();
      if (l && M) removeLeg(l.id, M);
      return;
    }
    const b = e.target.closest('button[data-add]');
    if (!b) return;
    const M = market(viewedExp()); // the expiry shown in the chain, so legs of different expiries can be mixed
    if (!M) return;
    if (addLeg(b.dataset.add, b.dataset.t, Number(b.dataset.k), chainLots(), M)) { record(); save(); render(); }
  });
  $('sbChainLots').addEventListener('change', (e) => {
    const n = Math.floor(Number(e.target.value));
    S.chainLots = n >= 1 ? n : null; // empty / invalid -> follow the global Lots
    e.target.value = S.chainLots || '';
    save(); render();
  });
  $('sbChainExp').addEventListener('change', async (e) => {
    S.chainExp = e.target.value;
    save();
    render(); // shows "loading" and fetches the expiry's prices, then redraws
  });
  $('sbWidth').addEventListener('change', (e) => { S.width = Number(e.target.value); save(); render(); });
  function applyChainMin() {
    $('sbGrid').classList.toggle('chain-min', !!S.chainMin);
    $('sbChainToggle').textContent = S.chainMin ? '▸ Expand' : '▾ Minimize';
  }
  $('sbChainToggle').addEventListener('click', () => { S.chainMin = !S.chainMin; save(); applyChainMin(); render(); });
  applyChainMin();
  // keep Positions the same height as Payoff
  new ResizeObserver(() => {
    const h = document.querySelector('#sbGrid > .sb-payoff').offsetHeight;
    if (h) $('sbGrid').style.setProperty('--sb-pay-h', h + 'px');
  }).observe(document.querySelector('#sbGrid > .sb-payoff'));
  $('sbPos').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const M = market();
    if (!M) return;
    if (b.dataset.reopen) {
      const l = S.legs.find((x) => x.id === Number(b.dataset.reopen));
      if (l && !l.open) {
        if (!openLegs().length) { S.atmIvEntry = atmIv(M); S.spotEntry = M.spot; }
        l.open = true;
        delete l.exitPx;
        delete l.exitAt;
        log(`Re-open ${l.lots} × ${l.strike} ${l.type} (${l.action === 'B' ? 'long' : 'short'}) — exit undone`, M);
        record(); save(); render();
      }
    }
    if (b.dataset.remove) removeLeg(Number(b.dataset.remove), M);
    if (b.dataset.close) {
      const l = S.legs.find((x) => x.id === Number(b.dataset.close));
      if (!l) return;
      let n = l.lots;
      if (l.lots > 1) {
        const ans = prompt(`Exit how many of the ${l.lots} lots of ${l.strike} ${l.type}? (the rest stays open)`, String(l.lots));
        if (ans == null) return;
        n = Math.floor(Number(ans));
        if (!(n >= 1)) return;
        n = Math.min(l.lots, n);
      }
      if (closeLeg(l, M, n)) { record(); save(); render(); }
    }
    if (b.dataset.shift) {
      const l = S.legs.find((x) => x.id === Number(b.dataset.shift) && x.open);
      if (l) await shiftStrike(l, Number(b.dataset.d), M);
    }
    if (b.dataset.roll) {
      const l = S.legs.find((x) => x.id === Number(b.dataset.roll));
      const Ml = l && mk(l, M);
      const i = l ? Ml.ks.indexOf(l.strike) + Number(b.dataset.d) : -1;
      if (l && Ml.ks[i] != null && closeLeg(l, M, null, 'roll')) { addLeg(l.action, l.type, Ml.ks[i], l.lots, Ml, 'roll', { rule: l.rule, ruleStrike: l.ruleStrike, ruleExpiry: l.ruleExpiry }); record(); save(); render(); }
    }
  });
  // Expiry picker of an open leg: the expiries of the chain's picker (plus the leg's own).
  function expirySelect(l) {
    const cur = legExp(l);
    const list = [...new Set([cur, ...chainExpiries()])].sort();
    const mo = BT.meta.calendar?.monthly || [];
    return `<select class="sb-exp-sel" data-exp="${l.id}" title="Change the expiry of this leg (same strike, or the nearest one with a price; edits the leg as if entered there; no exit trade)">${list.map((e) => `<option value="${e}" ${e === cur ? 'selected' : ''}>${dayShort(e)}${mo.includes(e) ? ' (M)' : ''}</option>`).join('')}</select>`;
  }
  // Neighbouring strike of an open leg that has a price now (d = -1 below, +1 above), or null.
  function nextStrike(l, d, M) {
    const Ml = mk(l, M);
    const ks = Ml.ks.filter((k) => k === l.strike || Ml.px(k, l.type) != null);
    const k = ks[ks.indexOf(l.strike) + d];
    return k ?? null;
  }
  // − / + and the expiry picker in Positions: move an open leg to another strike / expiry in place, as if it had been
  // entered there (no exit trade, unlike roll). In the replay it is re-priced at its original entry minute when that
  // minute's prices are available; otherwise (and live) it is re-entered at the current price.
  async function shiftStrike(l, d, M) {
    const to = nextStrike(l, d, M);
    if (to == null) { flash(`No ${d < 0 ? 'lower' : 'higher'} ${l.type} strike with a price`); return; }
    await moveLeg(l, to, legExp(l), M);
  }
  async function changeExpiry(l, exp, M) {
    if (exp === legExp(l)) return;
    try { await ensureExp(exp); } catch { /* checked below */ }
    const Me = market(exp);
    const ks = Me ? Me.ks.filter((k) => Me.px(k, l.type) != null) : [];
    if (!ks.length) { flash(`No ${l.type} prices for ${dayShort(exp)} at ${M.label}`); render(); return; }
    const to = ks.reduce((b, k) => (Math.abs(k - l.strike) < Math.abs(b - l.strike) ? k : b), ks[0]); // same strike, or the nearest
    await moveLeg(l, to, exp, M);
  }
  async function moveLeg(l, to, exp, M) {
    const from = { strike: l.strike, expiry: legExp(l) };
    l.strike = to;
    l.expiry = exp;
    let px = null;
    if (S.src === 'hist' && l.entryDay && l.entryMin != null) {
      try {
        const d0 = await loadDay(l.entryDay, false, exp); // fetches the new strike for the entry day if it is missing
        const i = d0.ks.indexOf(to);
        const v = i >= 0 ? (l.type === 'CE' ? d0.ce : d0.pe)[i][l.entryMin] : null;
        if (v > 0) px = v;
      } catch { /* fall back to the current price */ }
    }
    if (px == null) {
      const Ml = market(exp);
      px = Ml?.px(to, l.type) ?? null;
      if (px == null) { Object.assign(l, from); flash(`${to} ${l.type} ${dayShort(exp)} has no price now`); render(); return; }
      Object.assign(l, { entryAt: Ml.label, entryDay: Ml.day, entryMin: Ml.minute, spotIn: Ml.spot });
    }
    l.entryPx = px;
    const what = [from.strike !== to ? `${from.strike} → ${to}` : `${to}`, from.expiry !== exp ? `${dayShort(from.expiry)} → ${dayShort(exp)}` : dayShort(exp)];
    log(`Moved ${l.action === 'B' ? 'long' : 'short'} ${l.lots} × ${what[0]} ${l.type} (${what[1]}) @ ${px.toFixed(2)}, entry ${l.entryAt}; no exit trade`, M);
    record(); save();
    forceRebuild = true;
    try { render(); } finally { forceRebuild = false; }
  }
  $('sbPos').addEventListener('change', async (e) => {
    const expId = e.target.dataset?.exp;
    if (expId) {
      const l = S.legs.find((x) => x.id === Number(expId) && x.open);
      const M = market();
      e.target.blur(); // let the table redraw
      if (l && M) await changeExpiry(l, e.target.value, M);
      return;
    }
    const lotsId = e.target.dataset?.lots;
    if (lotsId) { commitLots(Number(lotsId), e.target.value); return; }
    const id = e.target.dataset?.pick;
    if (!id) return;
    const l = S.legs.find((x) => x.id === Number(id));
    if (!l) return;
    l.off = !e.target.checked;
    save(); render();
  });
  // Apply a new lot count to an open leg (any number >= 1). The box keeps focus so arrow keys / spinner keep stepping.
  let lotsTimer;
  function commitLots(id, value) {
    const l = S.legs.find((x) => x.id === id);
    const n = Math.floor(Number(value));
    if (!l || !(n >= 1)) return;
    // each open leg has two lot boxes (Lots column + next to Exit): refocus the one being used
    const boxes = () => [...$('sbPos').querySelectorAll(`input[data-lots="${id}"]`)];
    const at = boxes().indexOf(document.activeElement);
    l.lots = n;
    record(); save();
    forceRebuild = true;
    try { render(); } finally { forceRebuild = false; }
    if (at >= 0) boxes()[at]?.focus();
  }
  $('sbPos').addEventListener('input', (e) => {
    if (e.target.dataset?.lots) { clearTimeout(lotsTimer); const { lots } = e.target.dataset; const v = e.target.value; lotsTimer = setTimeout(() => commitLots(Number(lots), v), 450); }
  });
  $('sbPnlHead').addEventListener('click', (e) => {
    if (e.target.id !== 'sbExitAll') return;
    const M = market();
    for (const l of openLegs()) closeLeg(l, M, null, 'exit all');
    record(); save(); render();
  });
  $('sbSugg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-apply]');
    if (!b) return;
    const s = lastSugg[Number(b.dataset.apply)];
    if (s?.ops) applyOps(s.ops, s.title);
  });
  $('sbResearch').addEventListener('click', runResearch);

  window.addEventListener('viewchange', (e) => { if (e.detail === 'sb') init(); else { pause(); } });
  if (window.app.state.view === 'sb') init();
})();
