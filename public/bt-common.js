// Shared by the Backtest, Compare, Strategies and Data screens: API + job polling, formatting,
// the strategy editor, the period/costs bar, chart defaults and option maths.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('bt.' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('bt.' + k, JSON.stringify(v));
      } catch {}
    },
  };

  // ---------- formatting ----------
  const inr = (n, dec = 0) =>
    n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const inrS = (n, dec = 0) => (n > 0 ? '+' : '') + inr(n, dec);
  const kinr = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    const s = n < 0 ? '−₹' : '₹';
    if (a >= 1e7) return s + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(2) + ' L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + Math.round(a);
  };
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : x.toFixed(d) + '%');
  const num = (x, d = 2) => (x == null || isNaN(x) || !isFinite(x) ? '—' : x.toFixed(d));
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');
  const dayLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const dayShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // ---------- API ----------
  async function api(path, body) {
    const res = await fetch(
      path,
      body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  // ---------- events + meta ----------
  const handlers = {};
  const on = (ev, fn) => (handlers[ev] ||= []).push(fn);
  const emit = (ev, d) => (handlers[ev] || []).forEach((fn) => fn(d));
  const meta = { library: [], saved: [], originals: {}, anomalies: [], calendar: null, loaded: false };
  let metaPromise = null;
  function loadMeta(force) {
    if (meta.loaded && !force) return Promise.resolve(meta);
    if (metaPromise && !force) return metaPromise;
    metaPromise = api('/api/bt/meta')
      .then((m) => {
        Object.assign(meta, m, { loaded: true });
        metaPromise = null;
        emit('meta', meta);
        return meta;
      })
      .catch((e) => {
        metaPromise = null;
        throw e;
      });
    return metaPromise;
  }
  const allStrategies = () => [...meta.saved, ...meta.library];
  const findStrategy = (id) => allStrategies().find((s) => s.id === id) || null;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // override = true saves an edited built-in under its own id (it replaces the original until reset).
  async function saveStrategy(s, override = false) {
    const r = await api('/api/bt/strategies', { ...s, override });
    await loadMeta(true);
    return r.strategy;
  }
  async function resetStrategy(id) {
    const r = await api('/api/bt/strategies/reset', { id });
    await loadMeta(true);
    return r.strategy;
  }
  const anomalyType = (id) => meta.anomalies.find((t) => t.id === id) || null;
  async function deleteStrategy(id) {
    await api('/api/bt/strategies/delete', { id });
    await loadMeta(true);
  }

  // ---------- descriptions ----------
  const EXP_LABEL = { cur: 'This week', next: 'Next week', mcur: 'This month', mnext: 'Next month' };
  const EXP_SHORT = { cur: '', next: ' · next wk', mcur: ' · month', mnext: ' · next mth' };
  function strikeLabel(st) {
    const v = st.value;
    switch (st.by) {
      case 'atm':
        return v === 0 ? 'ATM' : v > 0 ? `OTM ${v}` : `ITM ${-v}`;
      case 'premium':
        return `${st.match === 'gte' ? '≥' : st.match === 'lte' ? '≤' : '≈'}₹${v}`;
      case 'delta':
        return `Δ ${v > 1 ? v / 100 : v}`;
      case 'pct':
        return `${v}% OTM`;
      case 'pts':
        return `${v} pts OTM`;
      case 'straddle':
        return `${v || 1}× straddle`;
      case 'signal':
        return `${st.ref === 'ref' ? 'pair' : 'signal'} strike${v ? (v > 0 ? ' +' : ' ') + v : ''}`;
      case 'sr':
        return `at ${st.lv && st.lv !== 'any' ? st.lv + ' ' : ''}S/R${v ? ' +' + v : ''}`;
      case 'leg':
        return `leg ${(st.ref ?? 0) + 1} ${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
      case 'pick':
        return `picked: ${{ m: 'centre', lo: 'low wing', hi: 'high wing', k1: 'back spread sold', k2: 'back spread bought' }[st.role] || st.role}`;
      default:
        return '?';
    }
  }
  const legLabel = (l) =>
    `${l.action === 'B' ? 'Buy' : 'Sell'}${l.lots > 1 ? ' ' + l.lots + '×' : ''} ${l.type} ${strikeLabel(l.strike)}${EXP_SHORT[l.expiry] || ''}${l.roll ? ' ⟳' : ''}`;
  const legChips = (s) => s.legs.map((l) => `<span class="leg-chip ${l.action === 'B' ? 'buy' : 'sell'}">${esc(legLabel(l))}</span>`).join('');
  const CLS_TXT = { any: '', major: 'major ', minor: 'minor ' };
  function condLabel(c) {
    switch (c.kind) {
      case 'anomaly': {
        const t = anomalyType(c.type);
        return `${t ? t.name : c.type}${c.side && c.side !== 'any' ? ' ' + c.side : ''}${c.dir && c.dir !== 'any' ? ' (' + c.dir + ')' : ''}`;
      }
      case 'sr-near':
        return `within ${c.within} pts of ${CLS_TXT[c.cls] || ''}${c.side === 'either' ? 'S/R' : c.side}`;
      case 'sr-break':
        return `breaks ${c.dir === 'up' ? 'above ' + (CLS_TXT[c.cls] || '') + 'resistance' : c.dir === 'down' ? 'below ' + (CLS_TXT[c.cls] || '') + 'support' : 'through ' + (CLS_TXT[c.cls] || '') + 'S/R'}`;
      case 'move':
        return `Nifty ${c.dir === 'up' ? 'up' : c.dir === 'down' ? 'down' : 'moved'} ${c.op === 'gte' ? '≥' : '≤'} ${c.value}${c.unit === 'pct' ? '%' : ' pts'} from ${c.from === 'open' ? 'open' : 'prev close'}`;
      case 'range':
        return `day range ${c.op === 'gte' ? '≥' : '≤'} ${c.value} pts`;
      default:
        return c.kind;
    }
  }
  // Adjustment on market movement (engine: strategy.adjust): what triggers it, and which legs get new strikes.
  const ADJ_DEF = {
    move: { on: 'move', value: 100, unit: 'pts', action: 'tested', max: 2 },
    near: { on: 'near', value: 0, unit: 'pts', action: 'tested', max: 2 },
    prem: { on: 'prem', value: 2, unit: 'x', action: 'tested', max: 2 },
  };
  const ADJ_ACT = { tested: 'roll the tested side out', untested: 'roll the untested side in', both: 're-centre every leg' };
  function adjustLabel(a) {
    if (!a) return '';
    const u = a.unit === 'pct' ? '%' : ' pts';
    const when =
      a.on === 'move'
        ? `Nifty moves ${a.value}${u}`
        : a.on === 'near'
          ? a.value
            ? `Nifty within ${a.value}${u} of a short strike`
            : 'Nifty reaches a short strike'
          : `a short leg at ${a.value}× its entry`;
    return `${when} → ${ADJ_ACT[a.action] || ADJ_ACT.tested} (max ${a.max})`;
  }
  function timingLabel(s) {
    if (s.entry?.when === 'signal') {
      const conds = (s.entry.conditions || []).map(condLabel).join(' + ') || 'no conditions';
      const where = s.mode === 'intraday' ? `${s.entry.time}–${s.entry.until}` : `${s.entry.dteDays}d before expiry ${s.entry.time}–${s.entry.until}`;
      return `On signal ${where}: ${conds}${s.entry.maxTrades > 1 ? ` · up to ${s.entry.maxTrades}/day` : ''} · exit ${s.mode === 'intraday' ? s.exit.time : (s.exit.dteDays ? s.exit.dteDays + 'd before ' : 'expiry ') + s.exit.time}`;
    }
    if (s.mode === 'intraday') {
      const days = s.entry.days.length === 5 ? 'every day' : s.entry.days.map((d) => WD[d]).join(', ');
      const dte = s.entry.dte?.length ? ` · DTE ${s.entry.dte.join(',')}` : '';
      return `Intraday ${s.entry.time}–${s.exit.time} · ${days}${dte} · ${s.expiry}${s.adjust ? ' · adjust: ' + adjustLabel(s.adjust) : ''}`;
    }
    const enter = s.entry.after
      ? `enter the day after the expiry ${s.entry.after} ${s.expiry === 'monthly' ? 'month' : 'week'}${s.entry.after > 1 ? 's' : ''} before`
      : `enter ${s.entry.dteDays}d before`;
    return `Positional · ${enter} ${s.expiry} expiry ${s.entry.time} → exit ${s.exit.dteDays ? s.exit.dteDays + 'd before' : 'expiry day'} ${s.exit.time}${s.entry.noOverlap ? ' · one at a time' : ''}${s.adjust ? ' · adjust: ' + adjustLabel(s.adjust) : ''}`;
  }

  // ---------- strategy editor ----------
  const blankLeg = (o = {}) => ({
    action: 'S',
    type: 'CE',
    lots: 1,
    expiry: 'cur',
    strike: { by: 'atm', value: 0, match: 'closest' },
    sl: { type: 'none', value: 0 },
    tgt: { type: 'none', value: 0 },
    trail: null,
    re: null,
    roll: null,
    ...o,
  });
  const blankStrategy = () => ({
    id: null,
    name: 'My strategy',
    desc: '',
    category: 'Custom',
    mode: 'intraday',
    expiry: 'weekly',
    entry: {
      time: '09:20',
      days: [1, 2, 3, 4, 5],
      dte: [],
      dteDays: 3,
      after: 0,
      noOverlap: false,
      when: 'time',
      until: '14:30',
      maxTrades: 1,
      conditions: [],
    },
    exit: { time: '15:15', dteDays: 0 },
    legs: [blankLeg({ type: 'CE' }), blankLeg({ type: 'PE' })],
    risk: {
      sl: null,
      tgt: null,
      slPrem: null,
      tgtPrem: null,
      lockAt: null,
      lockTo: 0,
      trailEvery: null,
      trailBy: null,
      onLegSl: 'all',
      slToCost: false,
      unit: 'inr',
      partialAt: null,
      partialPct: 60,
      partialFloor: null,
    },
    adjust: null,
    filters: { vixMin: null, vixMax: null, minCredit: null, maxLossDown: null, maxLossUp: null },
  });
  // Stops judge the whole strategy, never one leg (as bt/strategy.js wholeStrategyStops): a leg stop in % of its premium becomes
  // a stop on the whole position at that % of the entry premium; other leg stops, their trailing and re-entry after a stop go.
  function wholeStops(out) {
    const pcts = out.legs.filter((l) => l.sl?.type === 'pct' && l.sl.value > 0).map((l) => Number(l.sl.value));
    if (pcts.length) out.risk.slPrem = Math.min(out.risk.slPrem ?? Infinity, ...pcts);
    for (const l of out.legs) {
      l.sl = { type: 'none', value: 0 };
      l.trail = null;
      if (l.re?.on === 'sl') l.re = null;
      else if (l.re?.on === 'both') l.re = { ...l.re, on: 'tgt' };
    }
    out.risk.onLegSl = 'all';
    out.risk.slToCost = false;
    return out;
  }
  // Fill any missing fields (older saves, library entries).
  function complete(s) {
    const b = blankStrategy();
    const out = { ...b, ...clone(s) };
    out.entry = { ...b.entry, ...(s.entry || {}) };
    out.entry.conditions = clone(out.entry.conditions || []);
    out.exit = { ...b.exit, ...(s.exit || {}) };
    out.risk = { ...b.risk, ...(s.risk || {}) };
    out.filters = { ...b.filters, ...(s.filters || {}) };
    out.adjust = s.adjust ? { ...ADJ_DEF[s.adjust.on], ...clone(s.adjust) } : null;
    out.legs = (s.legs || []).map((l) => ({
      ...blankLeg(),
      ...l,
      strike: { ...blankLeg().strike, ...(l.strike || {}) },
      sl: l.sl || { type: 'none', value: 0 },
      tgt: l.tgt || { type: 'none', value: 0 },
    }));
    return wholeStops(out);
  }

  // ---------- charts ----------
  function chartTheme() {
    if (!window.Chart) return;
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue('--muted').trim();
    Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
    Chart.defaults.font.size = 11;
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    const tip = Chart.defaults.plugins.tooltip;
    tip.backgroundColor = css.getPropertyValue('--panel-2').trim();
    tip.borderColor = css.getPropertyValue('--line').trim();
    tip.borderWidth = 1;
    tip.titleColor = tip.bodyColor = css.getPropertyValue('--text').trim();
  }
  chartTheme();

  // ---------- payoff chart zoom ----------
  // A chart with options.plugins.payZoom = { on: true, home: [lo, hi] } zooms along its x axis (Nifty): + / − / ⟲
  // buttons in its corner, Ctrl (⌘) + wheel or a trackpad pinch at the cursor, drag to pan, double-click for the
  // starting view (home; default: all the data). The y axis fits what is in view. Charts compute their curve wider than
  // home, so zooming out shows more of it, as far as the data goes. The view is kept on the canvas, so it survives the
  // redraws of a live chart (BT.chart makes a new chart on the same canvas). A category x axis zooms by label index.
  // A dataset with pz_skip: true is left out of the fit and the limits (vertical marks...).
  const PZ_STEP = 1.25;
  const pzOn = (c) => c?.options?.plugins?.payZoom?.on;
  const pzCat = (c) => (c.config.options.scales?.x?.type || (c.data.labels?.length ? 'category' : 'linear')) === 'category';
  const pzPoints = (c, fn) => {
    c.data.datasets.forEach((d, i) => {
      if (d.pz_skip) return;
      (d.data || []).forEach((p, j) => (p != null && typeof p === 'object' ? fn(p.x, p.y, i) : fn(j, p, i)));
    });
  };
  function pzLimits(c) {
    if (pzCat(c)) return [0, Math.max(1, (c.data.labels?.length || 1) - 1)];
    let a = Infinity;
    let b = -Infinity;
    pzPoints(c, (x) => {
      if (Number.isFinite(x)) ((a = Math.min(a, x)), (b = Math.max(b, x)));
    });
    return a < b ? [a, b] : [0, 1];
  }
  // [min, max] in view: the saved one kept inside the data, else home
  function pzView(c) {
    const [la, lb] = pzLimits(c);
    const home = c.options.plugins.payZoom.home;
    let [a, b] = c.canvas._pz || (home && !pzCat(c) ? home : [la, lb]);
    const w = Math.min(b - a, lb - la);
    a = Math.max(la, Math.min(a, lb - w));
    return pzCat(c) ? [Math.round(a), Math.round(a + w)] : [a, a + w];
  }
  function pzSet(c, v) {
    c.canvas._pz = v;
    c.canvas.parentNode?.querySelector('.pz-ctl')?.classList.toggle('zoomed', !!v);
    c.update('none');
  }
  // f < 1 zooms in, around x (default: the middle of the view)
  function pzZoom(c, f, x) {
    const [a, b] = pzView(c);
    const [la, lb] = pzLimits(c);
    const home = c.options.plugins.payZoom.home || [la, lb];
    const at = Number.isFinite(x) ? x : (a + b) / 2;
    const w = Math.max((home[1] - home[0]) / (pzCat(c) ? 8 : 40), Math.min(lb - la, (b - a) * f));
    const na = at - ((at - a) / (b - a)) * w;
    pzSet(c, [na, na + w]);
  }
  function pzBind(canvas) {
    if (canvas._pzBound) return;
    canvas._pzBound = true;
    const box = canvas.parentNode;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.querySelector(':scope > .pz-ctl')?.remove(); // a canvas drawn again in the same box
    const ui = document.createElement('div');
    ui.className = 'pz-ctl';
    const how = 'Ctrl + scroll (or pinch) on the chart zooms at the cursor, drag pans, double-click goes back';
    ui.innerHTML = `<button type="button" data-pz="in" title="Zoom in. ${how}">+</button><button type="button" data-pz="out" title="Zoom out. ${how}">−</button><button type="button" data-pz="home" title="Back to the starting view (or double-click the chart)">⟲</button>`;
    box.appendChild(ui);
    const cur = () => (pzOn(Chart.getChart(canvas)) ? Chart.getChart(canvas) : null);
    ui.addEventListener('click', (e) => {
      const k = e.target.closest('[data-pz]')?.dataset.pz;
      const c = cur();
      if (!k || !c) return;
      e.stopPropagation();
      if (k === 'home') pzSet(c, null);
      else pzZoom(c, k === 'in' ? 1 / PZ_STEP : PZ_STEP);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        const c = cur();
        if (!c || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        pzZoom(c, e.deltaY < 0 ? 1 / PZ_STEP : PZ_STEP, c.scales.x.getValueForPixel(e.offsetX));
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', () => cur() && pzSet(cur(), null));
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      const c = cur();
      if (!c || e.button !== 0) return;
      const [a, b] = pzView(c);
      drag = { x: e.clientX, a, b, w: c.chartArea.right - c.chartArea.left, id: e.pointerId };
    });
    canvas.addEventListener('pointermove', (e) => {
      const c = cur();
      if (!drag || !c) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved)
        try {
          canvas.setPointerCapture(drag.id); // keeps the drag when the pointer leaves the chart
        } catch {
          /* no such pointer: the drag still works while over the chart */
        }
      drag.moved = true;
      const d = (dx / drag.w) * (drag.b - drag.a);
      pzSet(c, [drag.a - d, drag.b - d]);
    });
    const end = () => (drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
  const payZoom = {
    id: 'payZoom',
    defaults: { on: false },
    // The x axis is the plugin's from here on: the chart's own min / max (its home) would win over the limits set
    // below when the ticks are built, so they go, and a linear axis keeps exactly the limits it is given.
    beforeInit(c) {
      const x = pzOn(c) && c.config.options.scales?.x;
      if (!x) return;
      delete x.min;
      delete x.max;
      if (!pzCat(c)) x.bounds = 'data';
    },
    afterInit(c) {
      if (pzOn(c)) pzBind(c.canvas);
    },
    beforeUpdate(c) {
      if (pzOn(c)) c.canvas.parentNode?.querySelector('.pz-ctl')?.classList.toggle('zoomed', !!c.canvas._pz);
    },
    // a linear x axis: its two ends, and round values between them (a step of 1, 2, 2.5 or 5 × 10ⁿ, about 8 ticks)
    afterBuildTicks(c, { scale }) {
      if (!pzOn(c) || scale.id !== 'x' || pzCat(c)) return;
      const [a, b] = [scale.min, scale.max];
      const raw = (b - a) / 8;
      const p = 10 ** Math.floor(Math.log10(raw));
      const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
      const ticks = [{ value: a }];
      for (let v = Math.ceil(a / step) * step; v < b; v += step) if (v - a > step * 0.35 && b - v > step * 0.35) ticks.push({ value: v });
      ticks.push({ value: b });
      scale.ticks = ticks;
    },
    // x: the view; y: fits the points in view (and 0). Set on the scales as they take their limits, every update.
    afterDataLimits(c, { scale }) {
      if (!pzOn(c)) return;
      const [a, b] = pzView(c);
      if (scale.id === 'x') {
        scale.min = a;
        scale.max = b;
        return;
      }
      if (scale.id !== 'y') return;
      let lo = 0;
      let hi = 0;
      pzPoints(c, (x, y, i) => {
        if (x >= a && x <= b && Number.isFinite(y) && c.isDatasetVisible(i)) ((lo = Math.min(lo, y)), (hi = Math.max(hi, y)));
      });
      const pad = (hi - lo) * 0.08 || 1;
      scale.min = lo - pad;
      scale.max = hi + pad;
    },
  };
  if (window.Chart) Chart.register(payZoom);

  // The same zoom for payoff pictures drawn as SVG (Live Ideas cards): the page keeps no state, it asks view(key, home)
  // for the Nifty range to draw (home = its usual range) and puts ctl(key) beside the SVG in a positioned box. The SVG
  // carries data-pzk (its key) and data-x0 / data-x1 (the range it shows, mapped across its full width).
  // bind(root, redraw) once: the buttons, Ctrl (⌘) + wheel / pinch at the cursor, drag to pan, double-click to reset,
  // then redraw(key) paints that picture again.
  const svgViews = new Map(); // key -> { f: width ÷ home width, c: centre }
  const PZ_BTNS = `<button type="button" data-pz="in" title="Zoom in. Ctrl + scroll (or pinch) on the picture zooms at the cursor, drag pans, double-click goes back">+</button><button type="button" data-pz="out" title="Zoom out">−</button><button type="button" data-pz="home" title="Back to the starting view (or double-click the picture)">⟲</button>`;
  const svgZoom = {
    view(key, home) {
      const v = svgViews.get(key);
      if (!v) return home;
      const w = (home[1] - home[0]) * v.f;
      return [v.c - w / 2, v.c + w / 2];
    },
    ctl: (key) => `<div class="pz-ctl${svgViews.has(key) ? ' zoomed' : ''}" data-pzk="${esc(key)}">${PZ_BTNS}</div>`,
    // f < 1 zooms in, around x (default: the middle); from a quarter of a strike window to 4× the usual width
    zoom(key, home, f, x) {
      const [a, b] = svgZoom.view(key, home);
      const hw = home[1] - home[0];
      const w = Math.max(hw / 40, Math.min(hw * 4, (b - a) * f));
      const at = Number.isFinite(x) ? x : (a + b) / 2;
      const na = at - ((at - a) / (b - a)) * w;
      svgViews.set(key, { f: w / hw, c: na + w / 2 });
    },
    reset: (key) => svgViews.delete(key),
    bind(root, redraw) {
      const at = (svg, clientX) => {
        const r = svg.getBoundingClientRect();
        const [x0, x1] = [Number(svg.dataset.x0), Number(svg.dataset.x1)];
        return { x: x0 + ((clientX - r.left) / r.width) * (x1 - x0), home: [x0, x1], w: r.width };
      };
      // home of a key is not known here: the shown range and the saved view give it back
      const homeOf = (svg) => {
        const v = svgViews.get(svg.dataset.pzk);
        const [x0, x1] = [Number(svg.dataset.x0), Number(svg.dataset.x1)];
        if (!v) return [x0, x1];
        const hw = (x1 - x0) / v.f;
        return [(x0 + x1) / 2 - hw / 2, (x0 + x1) / 2 + hw / 2];
      };
      const svgOf = (key) => [...root.querySelectorAll('svg[data-pzk]')].find((s) => s.dataset.pzk === key);
      root.addEventListener('click', (e) => {
        const b = e.target.closest('.pz-ctl[data-pzk] [data-pz]');
        if (!b) return;
        e.stopPropagation();
        const key = b.closest('.pz-ctl').dataset.pzk;
        const svg = svgOf(key);
        if (!svg) return;
        if (b.dataset.pz === 'home') svgZoom.reset(key);
        else svgZoom.zoom(key, homeOf(svg), b.dataset.pz === 'in' ? 1 / PZ_STEP : PZ_STEP);
        redraw(key);
      });
      root.addEventListener(
        'wheel',
        (e) => {
          const svg = e.target.closest?.('svg[data-pzk]');
          if (!svg || !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          svgZoom.zoom(svg.dataset.pzk, homeOf(svg), e.deltaY < 0 ? 1 / PZ_STEP : PZ_STEP, at(svg, e.clientX).x);
          redraw(svg.dataset.pzk);
        },
        { passive: false },
      );
      root.addEventListener('dblclick', (e) => {
        const svg = e.target.closest?.('svg[data-pzk]');
        if (!svg) return;
        svgZoom.reset(svg.dataset.pzk);
        redraw(svg.dataset.pzk);
      });
      let drag = null;
      root.addEventListener('pointerdown', (e) => {
        const svg = e.target.closest?.('svg[data-pzk]');
        if (!svg || e.button !== 0) return;
        const h = homeOf(svg);
        drag = { key: svg.dataset.pzk, x: e.clientX, home: h, view: svgZoom.view(svg.dataset.pzk, h), w: svg.getBoundingClientRect().width };
      });
      window.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) < 4) return;
        drag.moved = true;
        const [a, b] = drag.view;
        const hw = drag.home[1] - drag.home[0];
        svgViews.set(drag.key, { f: (b - a) / hw, c: (a + b) / 2 - (dx / drag.w) * (b - a) });
        redraw(drag.key);
      });
      let dragged = false;
      window.addEventListener('pointerup', () => {
        dragged = !!drag?.moved;
        drag = null;
      });
      // the click that ends a drag is not a click on the page (it would select a card...)
      root.addEventListener(
        'click',
        (e) => {
          if (dragged) e.stopImmediatePropagation();
          dragged = false;
        },
        true,
      );
    },
  };
  const charts = new Map();
  function chart(canvas, config) {
    charts.get(canvas)?.destroy();
    const c = new Chart(canvas, config);
    charts.set(canvas, c);
    return c;
  }

  // ---------- option maths (Black-Scholes at r = 6.5%: /lib/pricing.js, the file the server prices with) ----------
  const { RATE, ncdf, bsm } = window.Pricing;
  // At expiry, or without a usable volatility, an option is worth its intrinsic value.
  const bs = (S, K, T, v, call) => (T <= 1e-6 || !(v > 0) ? Math.max(0, call ? S - K : K - S) : bsm(S, K, T, v, call, RATE, 0));

  window.BT = {
    $,
    esc,
    sleep,
    store,
    inr,
    inrS,
    kinr,
    pct,
    num,
    cls,
    dayLabel,
    dayShort,
    WD,
    api,
    on,
    emit,
    meta,
    loadMeta,
    allStrategies,
    findStrategy,
    clone,
    saveStrategy,
    deleteStrategy,
    resetStrategy,
    anomalyType,
    strikeLabel,
    legLabel,
    legChips,
    timingLabel,
    adjustLabel,
    condLabel,
    EXP_LABEL,
    blankStrategy,
    complete,
    chart,
    svgZoom,
    bs,
    ncdf,
    RATE,
  };

  // Load the strategy list and calendar once a screen other than the Chain is opened.
  const load = () => loadMeta().catch((e) => emit('meta-error', e));
  window.addEventListener('viewchange', (e) => {
    if (e.detail !== 'chain') load();
  });
  if (window.app?.state.view !== 'chain') load();
  // Keep the expiry calendar current while the page stays open (new weekly expiries get listed, old ones expire):
  // re-read it every 15 minutes and redraw only when it changed.
  setInterval(async () => {
    if (!meta.loaded || document.hidden || window.app?.marketClosed?.()) return;
    try {
      const m = await api('/api/bt/meta');
      if (!m.calendar || JSON.stringify(m.calendar) === JSON.stringify(meta.calendar)) return;
      meta.calendar = m.calendar;
      emit('meta', meta);
    } catch {}
  }, 15 * 60_000);
})();
