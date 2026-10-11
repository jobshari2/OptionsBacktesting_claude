// Nifty candlestick chart: on the Chain and Market Pulse screens and, with the full tool set, in its own window (chart.html).
// History comes from /api/bt/candles (the cached 1-minute files, a block of sessions at a time: scrolling back
// loads more); today's candles are re-read every 30 s and in between the last candle follows the live tick
// from /api/nifty/ltp. Support / resistance levels are drawn across it (hover one for its details).
// The pop-out window adds indicators (overlays and separate panes), drawings, chart types, log scale and snapshots.
// Times on the chart are IST.
(() => {
  const LC = window.LightweightCharts;
  const TFS = [
    ['1', '1m'],
    ['3', '3m'],
    ['5', '5m'],
    ['10', '10m'],
    ['15', '15m'],
    ['60', '1h'],
    ['120', '2h'],
    ['D', 'D'],
    ['W', 'W'],
    ['M', 'M'],
  ];
  const TF_TITLE = {
    1: '1-minute candles',
    3: '3-minute candles',
    5: '5-minute candles',
    10: '10-minute candles',
    15: '15-minute candles',
    60: '1-hour candles',
    120: '2-hour candles',
    D: 'Daily candles',
    W: 'Weekly candles',
    M: 'Monthly candles',
  };
  const TYPES = [
    ['candle', 'Candles'],
    ['bar', 'Bars'],
    ['ha', 'Heikin Ashi'],
    ['line', 'Line'],
    ['area', 'Area'],
  ];
  const TICK_MS = 1000;
  const RELOAD_LIVE_MS = 30_000;
  const RELOAD_IDLE_MS = 5 * 60_000;
  const LEVELS_MS = 10 * 60_000;
  const FLOW_MS = 10_000; // how often the order flow is re-read while the market is open
  const OPEN_MIN = 555; // 09:15
  const MPD = 375;
  const PRICE2 = { type: 'price', precision: 2, minMove: 0.01 }; // axis labels with two decimals
  const NEAR_PX = 5; // how close the mouse must be to a line to count as hovering it
  const PALETTE = ['#e0a030', '#58a6ff', '#b392f0', '#39c5cf', '#f778ba', '#8bc34a'];

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const num = (x) => (x == null ? '—' : x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  async function api(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  // ---------- indicator maths: arrays aligned with the candles, null until there is enough history ----------
  // Running average of v: simple for the first n values, then smoothed with factor k (2/(n+1) = EMA, 1/n = Wilder).
  function smooth(v, n, k) {
    const out = new Array(v.length).fill(null);
    let s = 0;
    let cnt = 0;
    let e = null;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) continue;
      if (e == null) {
        s += v[i];
        if (++cnt === n) out[i] = e = s / n;
      } else out[i] = e = v[i] * k + e * (1 - k);
    }
    return out;
  }
  const ema = (v, n) => smooth(v, n, 2 / (n + 1));
  const rma = (v, n) => smooth(v, n, 1 / n);
  function sma(v, n) {
    const out = new Array(v.length).fill(null);
    let s = 0;
    let cnt = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) {
        s = 0;
        cnt = 0;
        continue;
      }
      s += v[i];
      if (++cnt > n) s -= v[i - n];
      if (cnt >= n) out[i] = s / n;
    }
    return out;
  }
  const trueRange = (b) =>
    b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  const closes = (b) => b.map((x) => x.close);

  // Each indicator: its parameters, the series it draws (kind 'line' / 'hist') and calc() returning one array per series.
  // A value is a number or { value, color }. pane = drawn below the price in its own pane; guides = fixed lines in it.
  const IND = {
    sma: { name: 'SMA', title: 'Simple moving average', params: { len: 20 }, series: ['line'], calc: (b, p) => [sma(closes(b), p.len)] },
    ema: { name: 'EMA', title: 'Exponential moving average', params: { len: 20 }, series: ['line'], calc: (b, p) => [ema(closes(b), p.len)] },
    bb: {
      name: 'BB',
      title: 'Bollinger Bands',
      params: { len: 20, mult: 2 },
      series: ['line', 'thin', 'thin'],
      calc(b, p) {
        const c = closes(b);
        const mid = sma(c, p.len);
        const up = mid.slice();
        const dn = mid.slice();
        for (let i = 0; i < c.length; i++) {
          if (mid[i] == null) continue;
          let v = 0;
          for (let j = i - p.len + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
          const sd = Math.sqrt(v / p.len) * p.mult;
          up[i] = mid[i] + sd;
          dn[i] = mid[i] - sd;
        }
        return [mid, up, dn];
      },
    },
    st: {
      name: 'Supertrend',
      title: 'Supertrend (ATR trailing stop: green below price = up-trend, red above = down-trend)',
      params: { len: 10, mult: 3 },
      series: ['line'],
      calc(b, p, col) {
        const atr = rma(trueRange(b), p.len);
        const out = new Array(b.length).fill(null);
        let up = null;
        let dn = null;
        let dir = 1;
        for (let i = 0; i < b.length; i++) {
          if (atr[i] == null) continue;
          const mid = (b[i].high + b[i].low) / 2;
          let ub = mid + p.mult * atr[i];
          let lb = mid - p.mult * atr[i];
          if (up != null) {
            const pc = b[i - 1].close;
            if (!(ub < up || pc > up)) ub = up;
            if (!(lb > dn || pc < dn)) lb = dn;
            dir = b[i].close > up ? 1 : b[i].close < dn ? -1 : dir;
          }
          up = ub;
          dn = lb;
          out[i] = { value: dir === 1 ? lb : ub, color: dir === 1 ? col.up : col.down };
        }
        return [out];
      },
    },
    rsi: {
      name: 'RSI',
      title: 'Relative Strength Index',
      params: { len: 14 },
      pane: true,
      series: ['line'],
      guides: [70, 30],
      calc(b, p) {
        const g = b.map((x, i) => (i ? Math.max(0, x.close - b[i - 1].close) : null));
        const l = b.map((x, i) => (i ? Math.max(0, b[i - 1].close - x.close) : null));
        const ag = rma(g, p.len);
        const al = rma(l, p.len);
        return [ag.map((x, i) => (x == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])))];
      },
    },
    macd: {
      name: 'MACD',
      title: 'MACD (fast EMA − slow EMA, its signal line and their difference)',
      params: { fast: 12, slow: 26, signal: 9 },
      pane: true,
      series: ['hist', 'line', 'line2'],
      calc(b, p, col) {
        const c = closes(b);
        const f = ema(c, p.fast);
        const s = ema(c, p.slow);
        const m = f.map((x, i) => (x == null || s[i] == null ? null : x - s[i]));
        const sig = ema(m, p.signal);
        const hist = m.map((x, i) => (x == null || sig[i] == null ? null : { value: x - sig[i], color: rgba(x - sig[i] >= 0 ? col.up : col.down, 0.6) }));
        return [hist, m, sig];
      },
    },
    atr: { name: 'ATR', title: 'Average True Range', params: { len: 14 }, pane: true, series: ['line'], calc: (b, p) => [rma(trueRange(b), p.len)] },
    stoch: {
      name: 'Stoch',
      title: 'Stochastic oscillator (%K and %D)',
      params: { k: 14, d: 3 },
      pane: true,
      series: ['line', 'line2'],
      guides: [80, 20],
      calc(b, p) {
        const k = b.map((x, i) => {
          if (i < p.k - 1) return null;
          let hi = -Infinity;
          let lo = Infinity;
          for (let j = i - p.k + 1; j <= i; j++) {
            hi = Math.max(hi, b[j].high);
            lo = Math.min(lo, b[j].low);
          }
          return hi === lo ? 50 : ((x.close - lo) / (hi - lo)) * 100;
        });
        return [k, sma(k, p.d)];
      },
    },
  };

  // store: prefix of this chart's saved settings (each place remembers its own); tf0: the timeframe it first opens on.
  // flow0: whether the order flow panes start switched on (each place remembers its own choice).
  function mount(root, { full = false, store = full ? 'ncw.' : 'nc.', tf0 = '5', flow0 = true } = {}) {
    const pre = store;
    const get = (k, d) => {
      try {
        return localStorage.getItem(pre + k) ?? d;
      } catch {
        return d;
      }
    };
    const set = (k, v) => {
      try {
        localStorage.setItem(pre + k, v);
      } catch {
        /* storage unavailable */
      }
    };
    const getJson = (k, d) => {
      try {
        return JSON.parse(get(k, '')) ?? d;
      } catch {
        return d;
      }
    };

    const indMenu = Object.entries(IND)
      .map(
        ([k, d]) =>
          `<div class="nc-menu-row" data-kind="${k}" title="${esc(d.title)}"><b>${d.name}</b><span>${Object.entries(d.params)
            .map(([p, v]) => `<label>${p} <input class="num xs" type="number" min="1" step="${p === 'mult' ? 0.1 : 1}" data-p="${p}" value="${v}"></label>`)
            .join('')}</span><button class="btn-sm" data-add="${k}">Add</button></div>`,
      )
      .join('');
    root.innerHTML = `
      <div class="panel-head nc-head">
        <h3>Nifty 50 <span class="nc-last" data-r="last"></span></h3>
        <div class="nc-tools">
          <span class="seg sm" data-r="tf">${TFS.map(([v, l]) => `<button data-tf="${v}" title="${TF_TITLE[v]}">${l}</button>`).join('')}</span>
          <select data-r="type" title="Chart type">${TYPES.filter(([v]) => full || v === 'candle' || v === 'line')
            .map(([v, l]) => `<option value="${v}">${l}</option>`)
            .join('')}</select>
          ${
            full
              ? `<span class="nc-dd"><button class="btn-sm ghost" data-r="indBtn" title="Add indicators: moving averages, Bollinger Bands, Supertrend, RSI, MACD, ATR, Stochastic">ƒx Indicators ▾</button>
            <div class="nc-menu hidden" data-r="indMenu"><div class="muted small">Set the parameters and press Add. The same indicator can be added more than once (e.g. EMA 20 and EMA 50). Remove one with ✕ in the legend at the top left of the chart.</div>${indMenu}</div></span>
          <span class="seg sm" data-r="draw"><button data-draw="h" title="Horizontal line: click the chart at the price">― Line</button><button data-draw="t" title="Trend line: click its two ends">╱ Trend</button><button data-draw="clear" title="Remove all drawings (right-click a single drawing to remove only that one)">Clear</button></span>
          <button class="btn-sm ghost" data-r="log" title="Logarithmic price scale">Log</button>`
              : ''
          }
          <button class="btn-sm ghost" data-r="sr" title="Show / hide the support and resistance levels">S/R</button>
          <button class="btn-sm ghost" data-r="fp" title="Footprint: beside each candle, the call (left) and put (right) volume traded at each Nifty level, with the candle's delta and total below">Order flow</button>
          <button class="btn-sm ghost" data-r="of" title="Show / hide the Δ and CVD panes under the candles: net buying vs selling in the Nifty options per candle, and its running total">Δ / CVD</button>
          <button class="btn-sm ghost" data-r="now" title="Jump back to the latest candle">Latest ▸</button>
          ${
            full
              ? `<button class="btn-sm ghost" data-r="shot" title="Save the chart as a PNG image">📷</button>
          <button class="btn-sm ghost" data-r="fs" title="Full screen">⛶</button>`
              : '<button class="btn-sm ghost" data-r="pop" title="Open the chart in its own window, with indicators and drawing tools">⧉ New window</button>'
          }
        </div>
      </div>
      <div class="nc-wrap">
        <div class="nc-chart" data-r="chart"></div>
        <div class="nc-ohlc small" data-r="ohlc"></div>
        <div class="nc-tip hidden" data-r="tip"></div>
      </div>
      <div class="muted small nc-legend"><span><i class="nc-sw r"></i>Resistance</span><span><i class="nc-sw s"></i>Support</span><span>solid = major · dotted = minor · hover a level for details</span><span>drag to move · wheel to zoom · scroll back for older candles</span><span data-r="fpKey"><b>Order flow</b> in lots, at the Nifty level it traded: calls left of the candle, puts right · green = bought / sold with the market going up, red = down (3:1 or more) · box = busiest level · <b>Delta</b> = calls bought + puts sold − calls sold − puts bought · recorded days only</span><span data-r="flowKey"><b>Δ</b> per candle, <b>CVD</b> running total for the day</span><span data-r="msg"></span></div>`;
    const el = {};
    root.querySelectorAll('[data-r]').forEach((n) => {
      el[n.dataset.r] = n;
    });

    let tf = TF_TITLE[get('tf', tf0)] ? get('tf', tf0) : tf0;
    let type =
      TYPES.some(([v]) => v === get('type', 'candle')) && el.type.querySelector(`[value="${get('type', 'candle')}"]`) ? get('type', 'candle') : 'candle';
    let showLevels = get('sr', '1') === '1';
    let showFp = get('fp', flow0 ? '1' : '0') === '1'; // footprint beside the candles
    let showFlow = get('of', '0') === '1'; // Δ / CVD panes
    // [time ms, callBuy, callSell, putBuy, putSell, bookLean, niftyClose, [level, callBuy, callSell, putBuy, putSell, ...]]
    // per minute, oldest first
    let flowRows = [];
    let fpBars = new Map(); // candle time -> Map(Nifty level -> [callBuy, callSell, putBuy, putSell])
    let flowLot = 65;
    let flowPending = false; // the server is still reading earlier days: ask for everything again
    let flowAt = 0;
    let flowBusy = false;
    let deltaSeries = null;
    let cvdSeries = null;
    let flowLast = null; // { delta, cvd } of the newest candle that has flow
    let logScale = full && get('log', '0') === '1';
    let bars = []; // { time, open, high, low, close }, oldest first
    let meta = null; // last /api/bt/candles response (without the candles)
    let more = false;
    let first = null; // oldest day loaded: the next block ends before it
    let levels = [];
    let levelsAt = 0;
    let lines = []; // price lines of the levels
    let series = null;
    let seq = 0; // bumps on every timeframe change, so late answers for the old one are dropped
    let loading = false;
    let loadingOlder = false;
    let nextLoadAt = 0;
    let live = false;
    let lastTick = null;
    let hover = null; // candle under the crosshair
    let hoverData = null; // series values under the crosshair (for the indicator legend)
    let dirty = false; // candles changed since the indicators were last computed
    const inds = []; // { id, kind, params, color, series: [], last: [] }
    let indSeq = 0;
    const draw = getJson('draw', null) || { h: [], t: [] }; // h: prices, t: { t1, p1, t2, p2 }
    let hLines = [];
    let mode = null; // 'h' / 't' while a drawing is being placed
    let pending = null; // first end of a trend line being drawn
    let cursor = null; // { time, price, x, y } of the crosshair
    let overDraw = null; // drawing under the mouse: { kind: 'h' | 't', i }
    let segs = []; // trend lines in pixels, for hit testing

    const chart = LC.createChart(el.chart, {
      autoSize: true,
      crosshair: { mode: LC.CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });

    const visible = () => !document.hidden && root.offsetParent !== null;
    const intraday = () => !isNaN(Number(tf));
    const toBar = (c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] });
    const last = () => bars[bars.length - 1] || null;
    const colours = () => ({ up: css('--up'), down: css('--down'), accent: css('--accent') });
    // Index of the last candle at or before `time` (-1 when it is older than everything loaded).
    function barAt(time) {
      let lo = 0;
      let hi = bars.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].time <= time) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found;
    }

    // ---------- price series ----------
    // What the series shows: the candles themselves, their closes (line / area) or Heikin Ashi candles.
    function viewData() {
      if (type === 'line' || type === 'area') return bars.map((b) => ({ time: b.time, value: b.close }));
      if (type !== 'ha') return bars;
      const out = [];
      let po = null;
      let pc = null;
      for (const b of bars) {
        const close = (b.open + b.high + b.low + b.close) / 4;
        const open = po == null ? (b.open + b.close) / 2 : (po + pc) / 2;
        out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) });
        po = open;
        pc = close;
      }
      return out;
    }
    // The footprint draws the candles itself (thin, between the cells), so the series is made invisible.
    const fpActive = () => showFp && intraday() && (type === 'candle' || type === 'bar' || type === 'ha');
    const CLEAR = 'rgba(0,0,0,0)';
    function seriesOptions() {
      const c = colours();
      if (fpActive())
        return {
          upColor: CLEAR,
          downColor: CLEAR,
          wickUpColor: CLEAR,
          wickDownColor: CLEAR,
          borderVisible: false,
          priceLineColor: c.accent,
          priceFormat: PRICE2,
        };
      if (type === 'line') return { color: c.accent, lineWidth: 2, priceLineColor: c.accent, priceFormat: PRICE2 };
      if (type === 'area')
        return {
          lineColor: c.accent,
          lineWidth: 2,
          topColor: rgba(c.accent, 0.28),
          bottomColor: rgba(c.accent, 0.02),
          priceLineColor: c.accent,
          priceFormat: PRICE2,
        };
      if (type === 'bar') return { upColor: c.up, downColor: c.down, priceLineColor: c.accent, priceFormat: PRICE2 };
      return {
        upColor: c.up,
        downColor: c.down,
        wickUpColor: c.up,
        wickDownColor: c.down,
        borderVisible: false,
        priceLineColor: c.accent,
        priceFormat: PRICE2,
      };
    }
    // (Re)creates the price series for the chosen type. The new one is added before the old one goes, so the
    // price pane is never empty (an empty pane is dropped, which would move the indicator panes up).
    function makeSeries() {
      const old = series;
      const def = type === 'line' ? LC.LineSeries : type === 'area' ? LC.AreaSeries : type === 'bar' ? LC.BarSeries : LC.CandlestickSeries;
      series = chart.addSeries(def, seriesOptions(), 0);
      series.setData(viewData());
      series.attachPrimitive(trendLines);
      series.attachPrimitive(footprint);
      if (old) chart.removeSeries(old);
      lines = [];
      hLines = [];
      drawLevels();
      drawHLines();
    }
    function render() {
      series.setData(viewData());
      refreshInds();
      drawFlow();
    }

    function applyTheme() {
      const line = css('--line');
      chart.applyOptions({
        layout: {
          background: { color: css('--panel') },
          textColor: css('--muted'),
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          panes: { separatorColor: line },
        },
        grid: { vertLines: { color: rgba(line, 0.35) }, horzLines: { color: rgba(line, 0.35) } },
        rightPriceScale: { borderColor: line },
        timeScale: { borderColor: line },
      });
      if (!series) return makeSeries();
      series.applyOptions(seriesOptions());
      drawLevels();
      drawHLines();
      refreshInds();
      cvdSeries?.applyOptions({ color: css('--accent') });
      drawFlow();
    }

    // ---------- support / resistance ----------
    // Levels above the last price are resistance, below it support; major ones carry a label on the price axis.
    function drawLevels() {
      for (const l of lines) series.removePriceLine(l);
      lines = [];
      const b = last();
      if (!showLevels || !b) return;
      for (const l of levels) {
        const major = l.cls === 'major';
        const res = l.price > b.close;
        lines.push(
          series.createPriceLine({
            price: l.price,
            color: rgba(css(res ? '--down' : '--up'), major ? 0.95 : 0.6),
            lineWidth: major ? 2 : 1,
            lineStyle: major ? LC.LineStyle.Solid : LC.LineStyle.Dotted,
            axisLabelVisible: major,
            title: major ? (res ? 'R' : 'S') : '',
          }),
        );
      }
    }
    async function loadLevels() {
      if (Date.now() - levelsAt < LEVELS_MS) return;
      levelsAt = Date.now();
      try {
        levels = (await api('/api/bt/levels')).levels || [];
        drawLevels();
      } catch {
        /* chart without levels */
      }
    }
    // The level under the mouse (y in pixels of the price pane), if any.
    function levelAt(y) {
      if (!showLevels) return null;
      let best = null;
      let bestD = NEAR_PX + 1;
      for (const l of levels) {
        const py = series.priceToCoordinate(l.price);
        if (py == null) continue;
        const d = Math.abs(py - y);
        if (d < bestD || (d === bestD && l.cls === 'major')) {
          best = l;
          bestD = d;
        }
      }
      return best;
    }

    // ---------- order flow ----------
    // Nifty is an index with no volume, so the flow is read from the options near the money (/api/orderflow, one row
    // per minute): who started each trade. Per candle, delta = calls bought + puts sold - calls sold - puts bought,
    // in lots, and CVD is its running total (restarting every day on intraday charts). Both sit in panes under the
    // candles; only recorded days have flow, so older candles stay empty.
    const lotsFmt = (v) => {
      const a = Math.abs(v);
      return (v < 0 ? '−' : '') + (a >= 1e5 ? (a / 1e5).toFixed(2) + 'L' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(0));
    };
    const lotsFormat = { type: 'custom', formatter: lotsFmt, minMove: 0.01 };
    function flowPoints() {
      const out = { delta: [], cvd: [] };
      if (!bars.length || !flowRows.length) return out;
      const span = intraday() ? Number(tf) * 60 : tf === 'D' ? 86400 : tf === 'W' ? 7 * 86400 : 32 * 86400;
      const sums = new Map(); // candle time -> net quantity
      for (const r of flowRows) {
        const t = Math.floor(r[0] / 1000) + 19800; // IST wall-clock seconds, like the candles
        const i = barAt(t);
        if (i < 0 || t - bars[i].time >= span) continue;
        sums.set(bars[i].time, (sums.get(bars[i].time) || 0) + (r[1] - r[2]) - (r[3] - r[4]));
      }
      const c = colours();
      let run = 0;
      let day = null;
      for (const b of bars) {
        if (!sums.has(b.time)) continue;
        const d = intraday() ? Math.floor(b.time / 86400) : 0;
        if (d !== day) {
          day = d;
          run = 0;
        }
        const net = sums.get(b.time) / flowLot;
        run += net;
        out.delta.push({ time: b.time, value: net, color: rgba(net >= 0 ? c.up : c.down, 0.75) });
        out.cvd.push({ time: b.time, value: run });
      }
      return out;
    }
    // Footprint data: each minute's volume by Nifty level, laid into the candle it belongs to.
    function buildFp() {
      fpBars = new Map();
      if (!fpActive() || !bars.length) return;
      const span = Number(tf) * 60;
      for (const r of flowRows) {
        const px = r[7];
        if (!px?.length) continue;
        const t = Math.floor(r[0] / 1000) + 19800;
        const i = barAt(t);
        if (i < 0 || t - bars[i].time >= span) continue;
        let m = fpBars.get(bars[i].time);
        if (!m) fpBars.set(bars[i].time, (m = new Map()));
        for (let k = 0; k < px.length; k += 5) {
          const c = m.get(px[k]);
          if (c) for (let j = 0; j < 4; j++) c[j] += px[k + 1 + j];
          else m.set(px[k], px.slice(k + 1, k + 5));
        }
      }
    }
    // A candle's levels merged into rows `step` points tall, lowest first.
    function fpRows(time, step) {
      const m = fpBars.get(time);
      if (!m) return null;
      const rows = new Map();
      for (const [price, v] of m) {
        const lo = Math.floor(price / step) * step;
        const r = rows.get(lo);
        if (r) for (let j = 0; j < 4; j++) r[j] += v[j];
        else rows.set(lo, v.slice());
      }
      return [...rows].map(([lo, v]) => ({ lo, v })).sort((a, b) => a.lo - b.lo);
    }
    const fpTotals = (time) => {
      const m = fpBars.get(time);
      if (!m) return null;
      const s = [0, 0, 0, 0];
      for (const v of m.values()) for (let j = 0; j < 4; j++) s[j] += v[j];
      return { delta: (s[0] - s[1] - (s[2] - s[3])) / flowLot, total: (s[0] + s[1] + s[2] + s[3]) / flowLot };
    };
    // Draws the candles (thin) and, either side of each, the volume at every level: calls left, puts right. A cell is
    // tinted when one side of it is 3:1 or more (calls bought / puts sold = green, calls sold / puts bought = red);
    // the busiest level of a candle is boxed; its delta and total are written underneath.
    function paintFp(ctx) {
      if (!fpActive() || !bars.length) return;
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      const xa = ts.logicalToCoordinate(0);
      const xb = ts.logicalToCoordinate(1);
      const ref = last().close;
      const ya = series.priceToCoordinate(ref);
      const yb = series.priceToCoordinate(ref + 1);
      if (!range || xa == null || xb == null || ya == null || yb == null) return;
      const S = xb - xa; // pixels per candle
      const ppp = Math.abs(ya - yb) || 1; // pixels per Nifty point
      const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => s * ppp >= 13) || 200;
      const bw = Math.max(3, Math.min(9, S * 0.07));
      const cw = Math.max(0, (S * 0.94 - bw) / 2);
      const fs = Math.max(8, Math.min(11, cw / 4));
      const c = colours();
      const text = css('--text');
      const muted = css('--muted');
      const y = (p) => series.priceToCoordinate(p);
      ctx.save();
      ctx.font = `${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const i0 = Math.max(0, Math.floor(range.from) - 1);
      const i1 = Math.min(bars.length - 1, Math.ceil(range.to) + 1);
      for (let i = i0; i <= i1; i++) {
        const b = bars[i];
        const x = ts.logicalToCoordinate(i);
        if (x == null) continue;
        const rows = fpRows(b.time, step);
        let bottom = y(b.low);
        if (rows?.length && cw >= 3) {
          let max = 0;
          let poc = null;
          for (const r of rows) {
            const t = r.v[0] + r.v[1] + r.v[2] + r.v[3];
            if (t > max) {
              max = t;
              poc = r;
            }
          }
          const cell = (r, side) => {
            const bought = side === 'ce' ? r.v[0] : r.v[2];
            const sold = side === 'ce' ? r.v[1] : r.v[3];
            const tot = bought + sold;
            const top = y(r.lo + step);
            const bot = y(r.lo);
            if (top == null || bot == null) return;
            const x0 = side === 'ce' ? x - bw / 2 - cw : x + bw / 2;
            // up when calls are bought or puts are sold, down the other way round
            const up = side === 'ce' ? bought : sold;
            const down = side === 'ce' ? sold : bought;
            const strong = tot >= 0.05 * max;
            const tint = strong && up >= 3 * down ? c.up : strong && down >= 3 * up ? c.down : null;
            ctx.fillStyle = tint ? rgba(tint, 0.55) : rgba(muted, 0.16);
            ctx.fillRect(x0, top + 0.5, cw, Math.max(1, bot - top - 1));
            if (cw >= 28 && bot - top >= 10) {
              ctx.fillStyle = text;
              ctx.fillText(lotsFmt(tot / flowLot), x0 + cw / 2, (top + bot) / 2);
            }
          };
          for (const r of rows) {
            cell(r, 'ce');
            cell(r, 'pe');
          }
          if (poc) {
            const top = y(poc.lo + step);
            const bot = y(poc.lo);
            if (top != null && bot != null) {
              ctx.strokeStyle = c.accent;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(x - bw / 2 - cw, top + 0.5, cw * 2 + bw, Math.max(1, bot - top - 1));
            }
          }
          const low = y(rows[0].lo);
          if (low != null) bottom = Math.max(bottom ?? 0, low);
        }
        // the candle itself
        const yh = y(b.high);
        const yl = y(b.low);
        const yo = y(b.open);
        const yc = y(b.close);
        if (yh != null && yl != null && yo != null && yc != null) {
          const col = b.close >= b.open ? c.up : c.down;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, yh);
          ctx.lineTo(x, yl);
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1.5, Math.abs(yo - yc)));
        }
        const tot = fpTotals(b.time);
        if (tot && bottom != null && cw >= 16) {
          const wide = cw >= 30;
          const lines = wide
            ? [
                ['Delta', lotsFmt(tot.delta), tot.delta >= 0 ? c.up : c.down],
                ['Total', lotsFmt(tot.total), text],
              ]
            : [['', lotsFmt(tot.delta), tot.delta >= 0 ? c.up : c.down]];
          lines.forEach(([label, value, col], n) => {
            const yy = bottom + 12 + n * (fs + 4);
            ctx.fillStyle = rgba(css('--panel'), 0.85);
            ctx.fillRect(x - cw, yy - fs / 2 - 1, cw * 2, fs + 2);
            if (label) {
              ctx.textAlign = 'left';
              ctx.fillStyle = muted;
              ctx.fillText(label, x - cw + 2, yy);
              ctx.textAlign = 'right';
              ctx.fillStyle = col;
              ctx.fillText(value, x + cw - 2, yy);
              ctx.textAlign = 'center';
            } else {
              ctx.fillStyle = col;
              ctx.fillText(value, x, yy);
            }
          });
        }
      }
      ctx.restore();
    }
    const footprint = {
      attached(p) {
        this.request = p.requestUpdate;
      },
      detached() {
        this.request = null;
      },
      paneViews() {
        return [
          {
            zOrder: () => 'top',
            renderer: () => ({
              draw: (target) => target.useMediaCoordinateSpace(({ context }) => paintFp(context)),
            }),
          },
        ];
      },
    };
    // Zooms to as many candles as fit across the chart with room for the numbers in their cells.
    function fitFp() {
      if (!fpActive() || !bars.length) return;
      const n = Math.max(2, Math.floor((el.chart.clientWidth - 70) / 112));
      chart.timeScale().setVisibleLogicalRange({ from: bars.length - n, to: bars.length + 0.5 });
    }
    function drawFlow() {
      buildFp();
      footprint.request?.();
      if (!deltaSeries) return;
      const p = flowPoints();
      deltaSeries.setData(p.delta);
      cvdSeries.setData(p.cvd);
      flowLast = p.delta.length ? { delta: p.delta[p.delta.length - 1].value, cvd: p.cvd[p.cvd.length - 1].value } : null;
    }
    function setFlowSeries() {
      if (showFlow && !deltaSeries) {
        const pane = chart.panes().length;
        deltaSeries = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, title: 'Δ lots', priceFormat: lotsFormat }, pane);
        cvdSeries = chart.addSeries(
          LC.LineSeries,
          { color: css('--accent'), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'CVD', priceFormat: lotsFormat },
          pane + 1,
        );
        chart.panes().forEach((p, i) => p.setStretchFactor(i ? 1 : 3)); // the price pane stays the tall one
        flowAt = 0;
        drawFlow();
        loadFlow();
      } else if (!showFlow && deltaSeries) {
        chart.removeSeries(deltaSeries);
        chart.removeSeries(cvdSeries);
        deltaSeries = cvdSeries = flowLast = null;
        chart.panes().forEach((p, i) => p.setStretchFactor(i ? 1 : 3));
      }
      info();
    }
    // Today's rows are re-read often (the last few minutes only); the first read and every read while the server is
    // still loading earlier days takes everything.
    async function loadFlow() {
      if (!(showFlow || showFp) || flowBusy || Date.now() < flowAt) return;
      flowBusy = true;
      try {
        const all = !flowRows.length || flowPending;
        const since = all ? 0 : flowRows[flowRows.length - 1][0] - 3 * 60_000;
        const d = await api('/api/orderflow?since=' + since);
        flowLot = d.lot || 65;
        flowPending = Boolean(d.pending);
        flowRows = all ? d.rows : flowRows.filter((r) => r[0] < since).concat(d.rows);
        drawFlow();
        info();
        flowAt = Date.now() + (flowPending ? 4000 : live ? FLOW_MS : 60_000);
      } catch {
        flowAt = Date.now() + 15_000; // chart without order flow until the server answers
      } finally {
        flowBusy = false;
      }
    }

    // ---------- indicators ----------
    function addInd(kind, params, save = true) {
      const def = IND[kind];
      if (!def) return;
      const id = ++indSeq;
      const color = PALETTE[(id - 1) % PALETTE.length];
      const pane = def.pane ? chart.panes().length : 0;
      const base = { priceLineVisible: false, lastValueVisible: Boolean(def.pane), crosshairMarkerVisible: false, priceFormat: PRICE2 };
      const ind = { id, kind, params, color, last: [] };
      ind.series = def.series.map((s) =>
        s === 'hist'
          ? chart.addSeries(LC.HistogramSeries, base, pane)
          : chart.addSeries(
              LC.LineSeries,
              { ...base, color: s === 'line' ? color : s === 'line2' ? css('--down') : rgba(color, 0.6), lineWidth: s === 'thin' ? 1 : 2 },
              pane,
            ),
      );
      for (const g of def.guides || [])
        ind.series[0].createPriceLine({ price: g, color: css('--muted'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: '' });
      inds.push(ind);
      chart.panes().forEach((p, i) => p.setStretchFactor(i ? 1 : 3)); // the price pane stays the tall one
      fillInd(ind);
      if (save) saveInds();
      info();
    }
    function fillInd(ind) {
      const out = IND[ind.kind].calc(bars, ind.params, colours());
      ind.series.forEach((s, j) => {
        const data = [];
        out[j].forEach((v, i) => {
          if (v != null) data.push(typeof v === 'object' ? { time: bars[i].time, ...v } : { time: bars[i].time, value: v });
        });
        s.setData(data);
        ind.last[j] = data.length ? data[data.length - 1].value : null;
      });
    }
    function refreshInds() {
      dirty = false;
      for (const ind of inds) fillInd(ind);
    }
    function removeInd(id) {
      const i = inds.findIndex((x) => x.id === id);
      if (i < 0) return;
      for (const s of inds[i].series) chart.removeSeries(s);
      inds.splice(i, 1);
      saveInds();
      info();
    }
    const saveInds = () => set('inds', JSON.stringify(inds.map((x) => ({ kind: x.kind, params: x.params }))));

    // ---------- drawings ----------
    const saveDraw = () => set('draw', JSON.stringify(draw));
    function drawHLines() {
      for (const l of hLines) series.removePriceLine(l);
      hLines = draw.h.map((price) =>
        series.createPriceLine({ price, color: css('--accent'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: '' }),
      );
    }
    // Pixel position of a drawing's point: on the candle that holds its time in the current timeframe.
    function pointPx(time, price) {
      const i = barAt(time);
      if (i < 0) return null;
      const x = chart.timeScale().timeToCoordinate(bars[i].time);
      const y = series.priceToCoordinate(price);
      return x == null || y == null ? null : { x, y };
    }
    // Trend lines are painted on the price pane by this primitive (the library has no drawing tools of its own).
    const trendLines = {
      attached(p) {
        this.request = p.requestUpdate;
      },
      detached() {
        this.request = null;
      },
      paneViews() {
        return [
          {
            renderer: () => ({
              draw: (target) =>
                target.useMediaCoordinateSpace(({ context: ctx }) => {
                  segs = [];
                  ctx.save();
                  ctx.strokeStyle = css('--accent');
                  ctx.lineWidth = 1.5;
                  const stroke = (a, b, dashed) => {
                    ctx.setLineDash(dashed ? [4, 4] : []);
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                  };
                  draw.t.forEach((t, i) => {
                    const a = pointPx(t.t1, t.p1);
                    const b = pointPx(t.t2, t.p2);
                    if (!a || !b) return;
                    stroke(a, b, false);
                    segs.push({ i, a, b });
                  });
                  if (pending && cursor) {
                    const a = pointPx(pending.time, pending.price);
                    if (a) stroke(a, cursor, true);
                  }
                  ctx.restore();
                }),
            }),
          },
        ];
      },
    };
    function drawingAt(x, y) {
      for (let i = 0; i < draw.h.length; i++) {
        const py = series.priceToCoordinate(draw.h[i]);
        if (py != null && Math.abs(py - y) <= NEAR_PX) return { kind: 'h', i };
      }
      for (const s of segs) {
        const dx = s.b.x - s.a.x;
        const dy = s.b.y - s.a.y;
        const k = Math.max(0, Math.min(1, ((x - s.a.x) * dx + (y - s.a.y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - (s.a.x + k * dx), y - (s.a.y + k * dy)) <= NEAR_PX) return { kind: 't', i: s.i };
      }
      return null;
    }
    function setMode(m) {
      mode = m;
      pending = null;
      el.draw?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.draw === mode));
      el.chart.style.cursor = mode ? 'crosshair' : '';
      trendLines.request?.();
    }

    // ---------- top-left legend and the hover tooltip ----------
    const when = (t) =>
      new Date(t * 1000).toLocaleString(
        'en-IN',
        intraday()
          ? { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
          : { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' },
      );

    function info() {
      const b = last();
      const pc = meta?.prevClose;
      const chg = b && pc ? b.close - pc : null;
      el.last.innerHTML = !b
        ? ''
        : `${num(b.close)}${chg == null ? '' : ` <span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${num(chg)} (${((chg / pc) * 100).toFixed(2)}%)</span>`}`;
      const s = hover || b;
      if (!s) {
        el.ohlc.innerHTML = '';
        return;
      }
      const c = s.close >= s.open ? 'pos' : 'neg';
      const i = barAt(s.time);
      const prev = i > 0 ? bars[i - 1].close : null;
      const d =
        prev == null
          ? ''
          : ` <span class="${s.close >= prev ? 'pos' : 'neg'}">${s.close >= prev ? '+' : ''}${num(s.close - prev)} (${(((s.close - prev) / prev) * 100).toFixed(2)}%)</span>`;
      let html = `<div><span class="muted">${when(s.time)}</span> O <b class="${c}">${num(s.open)}</b> H <b class="${c}">${num(s.high)}</b> L <b class="${c}">${num(s.low)}</b> C <b class="${c}">${num(s.close)}</b>${d}</div>`;
      const ft = fpActive() ? fpTotals(s.time) : null;
      if (ft)
        html += `<div class="nc-ind"><i style="background:${css('--accent')}"></i>Order flow Delta <b class="${ft.delta >= 0 ? 'pos' : 'neg'}">${(ft.delta > 0 ? '+' : '') + lotsFmt(ft.delta)}</b> · Total <b>${lotsFmt(ft.total)}</b> lots</div>`;
      if (deltaSeries) {
        const dv = hover ? hoverData?.get(deltaSeries)?.value : flowLast?.delta;
        const cv = hover ? hoverData?.get(cvdSeries)?.value : flowLast?.cvd;
        html += `<div class="nc-ind"><i style="background:${css('--accent')}"></i>Order flow Δ <b class="${dv == null ? '' : dv >= 0 ? 'pos' : 'neg'}">${dv == null ? '—' : (dv > 0 ? '+' : '') + lotsFmt(dv)}</b> · CVD <b>${cv == null ? '—' : lotsFmt(cv)}</b> lots</div>`;
      }
      for (const ind of inds) {
        const vals = ind.series.map((sr, j) => (hover ? hoverData?.get(sr)?.value : ind.last[j]));
        html += `<div class="nc-ind"><i style="background:${ind.color}"></i>${IND[ind.kind].name} ${Object.values(ind.params).join(', ')} <b>${vals.map((v) => (v == null ? '—' : num(v))).join(' · ')}</b><button data-rm="${ind.id}" title="Remove this indicator">✕</button></div>`;
      }
      el.ohlc.innerHTML = html;
    }
    function tip(html, pt) {
      el.tip.classList.toggle('hidden', !html);
      if (!html) return;
      el.tip.innerHTML = html;
      const w = el.chart.clientWidth;
      el.tip.style.left = Math.max(4, Math.min(pt.x + 14, w - el.tip.offsetWidth - 70)) + 'px';
      el.tip.style.top = Math.max(4, pt.y - el.tip.offsetHeight - 10 < 4 ? pt.y + 14 : pt.y - el.tip.offsetHeight - 10) + 'px';
    }
    function status(err) {
      if (err) {
        el.msg.textContent = 'chart unavailable: ' + err;
        el.msg.className = 'err';
        return;
      }
      el.msg.className = live ? 'pos' : '';
      el.msg.textContent = live
        ? '● live'
        : meta?.day
          ? `market closed · last session ${new Date(meta.day + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })}`
          : '';
    }

    // ---------- data ----------
    // The newest block of candles: the whole chart after a timeframe change, afterwards laid over what is shown.
    async function load(reset) {
      if (loading) return;
      loading = true;
      const my = seq;
      try {
        const d = await api('/api/bt/candles?tf=' + tf);
        if (my !== seq) return;
        const block = d.candles.map(toBar);
        if (reset || !bars.length || !block.length) {
          bars = block;
          more = d.more;
          first = d.first;
        } else {
          bars = bars.filter((b) => b.time < block[0].time).concat(block);
        }
        delete d.candles;
        meta = d;
        if (lastTick) applyTick(lastTick, true);
        render();
        if (reset) {
          const show = Math.max(60, Math.round(el.chart.clientWidth / 8));
          if (fpActive()) fitFp();
          else if (bars.length <= show) chart.timeScale().fitContent();
          else chart.timeScale().setVisibleLogicalRange({ from: bars.length - show, to: bars.length + 5 });
        }
        drawLevels();
        info();
        status(block.length ? null : 'no Nifty candles in the cache yet (log in to Upstox to download them)');
        nextLoadAt = Date.now() + (live ? RELOAD_LIVE_MS : RELOAD_IDLE_MS);
      } catch (e) {
        if (my === seq) {
          status(e.message);
          nextLoadAt = Date.now() + 10_000;
        }
      } finally {
        loading = false;
        if (my !== seq) load(true);
      }
    }

    // Scrolled near the left edge: put the block of sessions before the oldest one in front.
    async function loadOlder() {
      if (loadingOlder || !more || !first || !intraday()) return;
      loadingOlder = true;
      const my = seq;
      try {
        const d = await api(`/api/bt/candles?tf=${tf}&before=${first}`);
        if (my !== seq) return;
        more = d.more && d.candles.length > 0;
        if (d.candles.length) {
          first = d.first;
          const t0 = bars[0].time;
          bars = d.candles
            .map(toBar)
            .filter((b) => b.time < t0)
            .concat(bars);
          render();
        }
      } catch {
        /* try again on the next scroll */
      } finally {
        loadingOlder = false;
      }
    }

    // Start (IST wall-clock seconds) of the candle a live tick belongs to, or null outside 09:15-15:30.
    function bucketOf(atMs) {
      const ist = Math.floor(atMs / 1000) + 19800;
      const day = ist - (ist % 86400);
      const m = Math.min(MPD - 1, Math.floor((ist - day) / 60) - OPEN_MIN);
      if (m < 0 || ist - day > (OPEN_MIN + MPD) * 60 + 30) return null;
      if (intraday()) return day + (OPEN_MIN + Math.floor(m / Number(tf)) * Number(tf)) * 60;
      const b = last();
      if (!b || tf === 'D') return day;
      const week = (t) => t - ((Math.floor(t / 86400) + 3) % 7) * 86400; // Monday of that week
      const month = (t) => new Date(t * 1000).toISOString().slice(0, 7);
      return (tf === 'W' ? week(b.time) === week(day) : month(b.time) === month(day)) ? b.time : day;
    }

    // Folds a tick into the last candle (or starts the next one). `quiet` = the caller redraws everything itself.
    function applyTick(t, quiet) {
      const time = bucketOf(t.at);
      let b = last();
      if (time == null || !b || time < b.time) return;
      if (time === b.time) {
        if (t.ltp === b.close) return;
        b.close = t.ltp;
        if (t.ltp > b.high) b.high = t.ltp;
        if (t.ltp < b.low) b.low = t.ltp;
      } else {
        b = { time, open: t.ltp, high: t.ltp, low: t.ltp, close: t.ltp };
        bars.push(b);
      }
      if (quiet) return;
      dirty = true;
      if (type === 'ha') series.setData(viewData());
      else series.update(type === 'line' || type === 'area' ? { time: b.time, value: b.close } : b);
      info();
    }

    let ticking = false;
    async function tick() {
      if (!visible()) return;
      if (Date.now() >= nextLoadAt) load(!bars.length);
      loadLevels();
      loadFlow();
      if (ticking) return;
      ticking = true;
      try {
        const t = await api('/api/nifty/ltp');
        const was = live;
        live = Boolean(t.live && t.ltp != null);
        if (live) {
          lastTick = t;
          applyTick(t);
        } else lastTick = null;
        if (dirty) {
          refreshInds();
          info();
        }
        if (live !== was) {
          status();
          if (live) nextLoadAt = 0;
        } // market just opened: fetch today's candles now
      } catch {
        live = false;
      } finally {
        ticking = false;
      }
    }

    // ---------- controls ----------
    function setTf(v) {
      tf = v;
      series.applyOptions(seriesOptions()); // the footprint is for intraday candles only
      set('tf', v);
      seq++;
      bars = [];
      meta = null;
      hover = null;
      more = false;
      buttons();
      load(true);
    }
    function buttons() {
      el.tf.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tf === tf));
      el.type.value = type;
      el.sr.classList.toggle('on', showLevels);
      el.of.classList.toggle('on', showFlow);
      el.fp.classList.toggle('on', showFp);
      el.fpKey.classList.toggle('hidden', !showFp);
      el.flowKey.classList.toggle('hidden', !showFlow);
      el.log?.classList.toggle('on', logScale);
    }
    el.tf.addEventListener('click', (e) => {
      if (e.target.dataset.tf && e.target.dataset.tf !== tf) setTf(e.target.dataset.tf);
    });
    el.type.addEventListener('change', () => {
      type = el.type.value;
      set('type', type);
      makeSeries();
    });
    el.sr.addEventListener('click', () => {
      showLevels = !showLevels;
      set('sr', showLevels ? '1' : '0');
      buttons();
      drawLevels();
    });
    el.fp.addEventListener('click', () => {
      showFp = !showFp;
      set('fp', showFp ? '1' : '0');
      buttons();
      series.applyOptions(seriesOptions());
      flowAt = 0;
      drawFlow();
      loadFlow();
      if (showFp) fitFp();
    });
    el.of.addEventListener('click', () => {
      showFlow = !showFlow;
      set('of', showFlow ? '1' : '0');
      buttons();
      setFlowSeries();
    });
    el.now.addEventListener('click', () => chart.timeScale().scrollToRealTime());
    el.pop?.addEventListener('click', () => window.open('chart.html', 'niftyChart', 'popup,width=1400,height=820'));
    el.ohlc.addEventListener('pointerdown', (e) => {
      if (e.target.dataset.rm) removeInd(Number(e.target.dataset.rm));
    });

    if (full) {
      const applyLog = () => chart.priceScale('right').applyOptions({ mode: logScale ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal });
      el.log.addEventListener('click', () => {
        logScale = !logScale;
        set('log', logScale ? '1' : '0');
        buttons();
        applyLog();
      });
      el.indBtn.addEventListener('click', () => el.indMenu.classList.toggle('hidden'));
      document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.nc-dd')) el.indMenu.classList.add('hidden');
      });
      el.indMenu.addEventListener('click', (e) => {
        const kind = e.target.dataset.add;
        if (!kind) return;
        const params = {};
        e.target
          .closest('.nc-menu-row')
          .querySelectorAll('input')
          .forEach((i) => {
            params[i.dataset.p] = Math.max(i.dataset.p === 'mult' ? 0.1 : 1, Number(i.value) || IND[kind].params[i.dataset.p]);
          });
        addInd(kind, params);
      });
      el.draw.addEventListener('click', (e) => {
        const d = e.target.dataset.draw;
        if (!d) return;
        if (d === 'clear') {
          draw.h = [];
          draw.t = [];
          saveDraw();
          drawHLines();
          return setMode(null);
        }
        setMode(mode === d ? null : d);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMode(null);
      });
      chart.subscribeClick((p) => {
        if (!mode || !p.point || (p.paneIndex ?? 0) !== 0) return;
        const price = series.coordinateToPrice(p.point.y);
        if (price == null) return;
        if (mode === 'h') {
          draw.h.push(Math.round(price * 100) / 100);
          drawHLines();
        } else {
          const time = p.time ?? chart.timeScale().coordinateToTime(p.point.x);
          if (time == null) return; // right of the last candle
          if (!pending) {
            pending = { time, price };
            return;
          }
          draw.t.push({ t1: pending.time, p1: pending.price, t2: time, p2: price });
        }
        saveDraw();
        setMode(null);
      });
      el.chart.addEventListener('contextmenu', (e) => {
        if (!overDraw) return;
        e.preventDefault();
        draw[overDraw.kind].splice(overDraw.i, 1);
        overDraw = null;
        saveDraw();
        drawHLines();
        trendLines.request?.();
        tip(null);
      });
      el.shot.addEventListener('click', () =>
        chart.takeScreenshot().toBlob((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `nifty-${tf}-${new Date(Date.now() + 19800_000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }),
      );
      el.fs.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()));
      applyLog();
    }

    chart.subscribeCrosshairMove((p) => {
      const i = p.time == null ? -1 : barAt(p.time);
      hover = i >= 0 && bars[i].time === p.time ? bars[i] : null;
      hoverData = p.seriesData;
      info();
      const inPrice = p.point && (p.paneIndex ?? 0) === 0;
      cursor = inPrice ? { x: p.point.x, y: p.point.y } : null;
      if (pending) trendLines.request?.();
      if (!inPrice || mode) {
        overDraw = null;
        return tip(null);
      }
      overDraw = drawingAt(p.point.x, p.point.y);
      const b = last();
      const lv = overDraw ? null : levelAt(p.point.y);
      if (overDraw) {
        tip(
          `<b>${overDraw.kind === 'h' ? 'Horizontal line ' + num(draw.h[overDraw.i]) : 'Trend line'}</b><div class="muted">right-click to remove</div>`,
          p.point,
        );
      } else if (lv && b) {
        const res = lv.price > b.close;
        const d = lv.price - b.close;
        tip(
          `<b class="${res ? 'neg' : 'pos'}">${lv.cls === 'major' ? 'Major' : 'Minor'} ${res ? 'resistance' : 'support'} ${num(lv.price)}</b>
          <div>${Math.abs(d).toFixed(0)} pts ${res ? 'above' : 'below'} Nifty (${((d / b.close) * 100).toFixed(2)}%)</div>
          <div class="muted">${esc(lv.src)}</div>`,
          p.point,
        );
      } else tip(null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 30) loadOlder();
    });
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('viewchange', () => setTimeout(tick, 0));
    document.addEventListener('visibilitychange', tick);

    applyTheme();
    buttons();
    setFlowSeries();
    loadFlow();
    if (full) for (const s of getJson('inds', [])) addInd(s.kind, { ...IND[s.kind]?.params, ...s.params }, false);
    setInterval(tick, TICK_MS);
    tick();
  }

  const MISSING = '<div class="pad err">Chart library missing: run <code>npm install</code> and restart the server.</div>';
  const panel = document.getElementById('niftyPanel');
  if (panel && LC) mount(panel, { full: document.body.classList.contains('nc-window') });
  else if (panel) panel.innerHTML = MISSING;
  // Market Pulse: the same chart, opening on 1-minute candles.
  const pulsePanel = document.getElementById('pulseChart');
  if (pulsePanel && LC) mount(pulsePanel, { store: 'ncp.', tf0: '1', flow0: false });
  else if (pulsePanel) pulsePanel.innerHTML = MISSING;
})();
