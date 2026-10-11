// "Surge Charts" tab: five views of the volume surge, built with Chart.js (served from /vendor).
// Uses the live chain from app.js (window.app.state.data) plus /api/surge-history for time buckets.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const { state, compact } = window.app;

  const C = {
    ce: css('--ce-mark'),
    pe: css('--pe-mark'),
    seq: '88,166,255', // sequential hue for the heatmap (rgb of --seq-hi)
    text: css('--text'),
    muted: css('--muted'),
    grid: 'rgba(139,148,158,.12)',
    zero: 'rgba(139,148,158,.45)',
    surface: css('--panel'),
    atm: css('--atm'),
  };

  Chart.defaults.color = C.muted;
  Chart.defaults.font.size = 11;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.animation = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = css('--panel-2');
  Chart.defaults.plugins.tooltip.borderColor = css('--line');
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = C.text;
  Chart.defaults.plugins.tooltip.bodyColor = C.text;

  const local = (k, d) => {
    try {
      return localStorage.getItem('oc.chart.' + k) ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem('oc.chart.' + k, v);
    } catch {}
  };
  const cs = {
    bucket: Number(local('bucket', 60)),
    around: Number(local('around', 10)),
    heatSide: local('heatSide', 'total'),
    history: null,
    historyKey: '',
    fetching: false,
    charts: {},
  };

  const fmtTime = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
  const signedPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
  const grid = { color: C.grid, drawTicks: false };
  const zeroGrid = { color: (ctx) => (ctx.tick.value === 0 ? C.zero : C.grid), drawTicks: false };

  // ---------- controls ----------
  function seg(id, attr, value, onPick) {
    const el = $(id);
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(value)));
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', (e) => {
        if (e.target.dataset[attr] != null) onPick(e.target.dataset[attr]);
      });
    }
  }

  function renderControls(d) {
    const winSeg = $('chartWinSeg');
    if (!winSeg.dataset.built) {
      winSeg.innerHTML = d.windows.map((w) => `<button data-w="${w}">${w}m</button>`).join('');
      winSeg.dataset.built = '1';
    }
    seg('chartWinSeg', 'w', state.win, (w) => {
      state.win = Number(w);
      save('win', w);
      window.app.render();
    });
    seg('bucketSeg', 'b', cs.bucket, (b) => {
      cs.bucket = Number(b);
      save('bucket', b);
      cs.history = null;
      window.app.render();
    });
    seg('aroundSeg', 'a', cs.around, (a) => {
      cs.around = Number(a);
      save('around', a);
      cs.history = null;
      window.app.render();
    });
    seg('heatSideSeg', 's', cs.heatSide, (s) => {
      cs.heatSide = s;
      save('heatSide', s);
      renderHeatmap();
    });
    $('chartsNote').textContent =
      d.trackingSec < state.win * 60 ? `Collecting data — ${Math.floor(d.trackingSec / 60)}m ${d.trackingSec % 60}s of history so far.` : '';
  }

  // ---------- data ----------
  function nearRows(d) {
    const idx = d.rows.findIndex((r) => r.strike === d.atm);
    if (idx < 0) return d.rows;
    return d.rows.slice(Math.max(0, idx - cs.around), idx + cs.around + 1);
  }

  async function loadHistory(d) {
    const key = `${d.expiry}|${cs.bucket}|${cs.around}`;
    const fresh = cs.history && cs.historyKey === key && Date.now() - cs.history.fetchedAt < 2000;
    if (fresh || cs.fetching) return;
    cs.fetching = true;
    try {
      const q = new URLSearchParams({ expiry: d.expiry, bucket: cs.bucket, strikes: cs.around });
      const h = await (await fetch('/api/surge-history?' + q, { cache: 'no-store' })).json();
      h.fetchedAt = Date.now();
      cs.history = h;
      cs.historyKey = key;
      renderTimeline();
      renderHeatmap();
    } catch {
      // the main refresh loop reports connection problems
    } finally {
      cs.fetching = false;
    }
  }

  function make(id, config) {
    if (!cs.charts[id]) cs.charts[id] = new Chart($(id), config);
    return cs.charts[id];
  }

  const strikeTickColor = (rows, d) => (ctx) => (rows[ctx.index]?.strike === d.atm ? C.atm : C.muted);

  // ---------- 1 · diverging bars ----------
  function renderDiverging(d, rows) {
    const w = state.win;
    const chart = make('cDiverging', {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'CE', backgroundColor: C.ce, borderRadius: 4, borderSkipped: 'start', data: [] },
          { label: 'PE', backgroundColor: C.pe, borderRadius: 4, borderSkipped: 'start', data: [] },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, grid: zeroGrid, border: { display: false }, ticks: { callback: (v) => compact(Math.abs(v)) } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} +${compact(Math.abs(c.raw))}` } },
        },
        datasets: { bar: { categoryPercentage: 0.8, barPercentage: 0.9 } },
      },
    });
    chart.data.labels = rows.map((r) => r.strike);
    chart.data.datasets[0].data = rows.map((r) => r.ce.dVol[w]);
    chart.data.datasets[1].data = rows.map((r) => -r.pe.dVol[w]);
    chart.options.scales.x.ticks = { color: strikeTickColor(rows, d) };
    chart.update('none');
  }

  // ---------- 2 · heatmap (strike × time) ----------
  function renderHeatmap() {
    const h = cs.history;
    const el = $('heatmap');
    if (!h || !h.buckets.length) {
      el.innerHTML = '<div class="muted small">Collecting history…</div>';
      return;
    }
    const nB = h.buckets.length;
    const val = (si, bi) => {
      const c = h.ce[si][bi];
      const p = h.pe[si][bi];
      if (cs.heatSide === 'ce') return c;
      if (cs.heatSide === 'pe') return p;
      return c == null && p == null ? null : (c || 0) + (p || 0);
    };
    let max = 1;
    h.strikes.forEach((_, si) => {
      for (let bi = 0; bi < nB; bi++) max = Math.max(max, val(si, bi) || 0);
    });

    el.style.gridTemplateColumns = `44px repeat(${nB}, minmax(0, 1fr))`;
    el.style.gridTemplateRows = `repeat(${h.strikes.length}, minmax(0, 1fr)) 14px 16px`;
    const side = cs.heatSide === 'total' ? 'CE+PE' : cs.heatSide.toUpperCase();
    let html = '';
    // highest strike at the top, like a price axis
    for (let si = h.strikes.length - 1; si >= 0; si--) {
      const k = h.strikes[si];
      html += `<div class="hk${k === h.atm ? ' atm' : ''}">${k}</div>`;
      for (let bi = 0; bi < nB; bi++) {
        const v = val(si, bi);
        const bg = v == null ? 'transparent' : `rgba(${C.seq},${(0.06 + 0.94 * Math.sqrt(v / max)).toFixed(2)})`;
        const t1 = fmtTime(h.buckets[bi] - h.bucketSec * 1000);
        const t2 = fmtTime(h.buckets[bi]);
        const tip = v == null ? `${k} · ${t1}–${t2} · no data yet` : `${k} · ${t1}–${t2} · ${side} +${compact(v)}`;
        html += `<div class="hc" style="background:${bg}" title="${tip}"></div>`;
      }
    }
    html += '<div></div>';
    for (let bi = 0; bi < nB; bi++) {
      const show = bi === nB - 1 || (nB - 1 - bi) % Math.ceil(nB / 5) === 0;
      html += `<div class="ht">${show ? fmtTime(h.buckets[bi]) : ''}</div>`;
    }
    html += `<div></div><div class="heat-legend" style="grid-column: 2 / -1">
      <span>low</span><span style="flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg, rgba(${C.seq},.06), rgba(${C.seq},1))"></span>
      <span>high (${compact(max)} per ${h.bucketSec >= 60 ? h.bucketSec / 60 + 'm' : h.bucketSec + 's'})</span></div>`;
    el.innerHTML = html;
  }

  // ---------- 3 · timeline (lines) ----------
  function renderTimeline() {
    const h = cs.history;
    if (!h) return;
    const sum = (side, bi) => {
      let t = null;
      for (const row of h[side]) if (row[bi] != null) t = (t || 0) + row[bi];
      return t;
    };
    const chart = make('cTimeline', {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'CE', borderColor: C.ce, backgroundColor: C.ce, borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, tension: 0.25, data: [] },
          { label: 'PE', borderColor: C.pe, backgroundColor: C.pe, borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, tension: 0.25, data: [] },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
          y: { beginAtZero: true, grid, border: { display: false }, ticks: { callback: (v) => compact(v) } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} +${c.raw == null ? '—' : compact(c.raw)}` } },
        },
      },
    });
    chart.data.labels = h.buckets.map(fmtTime);
    chart.data.datasets[0].data = h.buckets.map((_, bi) => sum('ce', bi));
    chart.data.datasets[1].data = h.buckets.map((_, bi) => sum('pe', bi));
    chart.update('none');
  }

  // ---------- 4 · bubble: volume vs premium change ----------
  function renderBubble(d, rows) {
    const w = state.win;
    const maxVol = Math.max(1, ...rows.flatMap((r) => [r.ce.dVol[w], r.pe.dVol[w]]));
    const pts = (key) =>
      rows
        .filter((r) => r[key].dVol[w] > 0 && r[key].dLtp?.[w] != null && r[key].ltp - r[key].dLtp[w] > 0)
        .map((r) => {
          const o = r[key];
          const base = o.ltp - o.dLtp[w];
          return { x: r.strike, y: (o.dLtp[w] / base) * 100, r: 3 + 17 * Math.sqrt(o.dVol[w] / maxVol), vol: o.dVol[w], ltp: o.ltp, chg: o.dLtp[w] };
        });
    const chart = make('cBubble', {
      type: 'bubble',
      data: {
        datasets: [
          { label: 'CE', backgroundColor: C.ce + 'b3', borderColor: C.surface, borderWidth: 2, data: [] },
          { label: 'PE', backgroundColor: C.pe + 'b3', borderColor: C.surface, borderWidth: 2, data: [] },
        ],
      },
      options: {
        scales: {
          x: { type: 'linear', grid: { display: false }, ticks: { stepSize: 100, callback: (v) => v } },
          y: { grid: zeroGrid, border: { display: false }, ticks: { callback: (v) => `${v}%` } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              label: (c) =>
                ` ${c.raw.x} ${c.dataset.label} · vol +${compact(c.raw.vol)} · ₹${c.raw.ltp.toFixed(2)} (${c.raw.chg >= 0 ? '+' : ''}${c.raw.chg.toFixed(2)}, ${signedPct(c.raw.y)})`,
            },
          },
        },
      },
    });
    chart.data.datasets[0].data = pts('ce');
    chart.data.datasets[1].data = pts('pe');
    chart.options.scales.x.min = rows[0]?.strike - 25;
    chart.options.scales.x.max = rows[rows.length - 1]?.strike + 25;
    chart.update('none');
  }

  // ---------- 5 · growth % dot plot ----------
  function renderGrowth(d, rows) {
    const w = state.win;
    const chart = make('cGrowth', {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'CE',
            showLine: false,
            pointRadius: 5,
            pointHoverRadius: 7,
            pointBackgroundColor: C.ce,
            pointBorderColor: C.surface,
            pointBorderWidth: 2,
            borderColor: C.ce,
            data: [],
          },
          {
            label: 'PE',
            showLine: false,
            pointRadius: 5,
            pointHoverRadius: 7,
            pointBackgroundColor: C.pe,
            pointBorderColor: C.surface,
            pointBorderWidth: 2,
            borderColor: C.pe,
            data: [],
          },
          { label: 'Highlight threshold', borderColor: C.atm, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, data: [] },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid, border: { display: false }, ticks: { callback: (v) => `${v}%` } },
        },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { filter: (item) => item.text !== 'Highlight threshold' || state.threshold > 0 } },
          tooltip: {
            filter: (c) => c.datasetIndex < 2,
            callbacks: { label: (c) => ` ${c.dataset.label} ${c.raw == null ? 'new / no volume before' : signedPct(c.raw)}` },
          },
        },
      },
    });
    chart.data.labels = rows.map((r) => r.strike);
    chart.data.datasets[0].data = rows.map((r) => (r.ce.dVol[w] > 0 ? r.ce.pVol[w] : 0));
    chart.data.datasets[1].data = rows.map((r) => (r.pe.dVol[w] > 0 ? r.pe.pVol[w] : 0));
    chart.data.datasets[2].data = rows.map(() => (state.threshold > 0 ? state.threshold : null));
    chart.options.scales.x.ticks = { color: strikeTickColor(rows, d) };
    chart.update('none');
  }

  // Called by app.js after every render.
  window.onAppRender = () => {
    if (state.view !== 'charts' || !state.data) return;
    const d = state.data;
    const rows = nearRows(d);
    renderControls(d);
    renderDiverging(d, rows);
    renderBubble(d, rows);
    renderGrowth(d, rows);
    loadHistory(d);
  };
})();
