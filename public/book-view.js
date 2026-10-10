// "Order Book" tab: bid/ask queues per strike, book pressure over time, who traded, and how Nifty
// reacted after the book leaned one way. Data from /api/book (refreshed every 2 s while open).
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const { state, compact } = window.app;
  const C = {
    ce: css('--ce-mark'), pe: css('--pe-mark'), up: css('--up'), down: css('--down'), muted: css('--muted'),
    text: css('--text'), atm: css('--atm'), accent: css('--accent'), surface: css('--panel'),
    grid: 'rgba(139,148,158,.12)', zero: 'rgba(139,148,158,.45)',
  };
  const fmt = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
  const local = (k, d) => { try { return localStorage.getItem('oc.book.' + k) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem('oc.book.' + k, v); } catch {} };
  const bs = { data: null, fetchedAt: 0, fetching: false, charts: {}, queueSide: local('queueSide', 'pe'), heatSide: local('heatSide', 'pe') };

  const make = (id, config) => (bs.charts[id] ||= new Chart($(id), config));
  const sgn = (n, d = 1) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}`);
  const cls = (n) => (n == null || Math.abs(n) < 0.05 ? '' : n > 0 ? 'pos' : 'neg');

  function seg(id, attr, value, onPick) {
    const el = $(id);
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', (e) => { if (e.target.dataset[attr]) onPick(e.target.dataset[attr]); });
    }
  }

  // ---------- tiles ----------
  function renderTiles(b) {
    const tile = (label, value, note, vc = '') => `<div class="st"><span class="s">${label}</span><span class="v ${vc}">${value}</span><span class="n">${note}</span></div>`;
    const n = b.now;
    const atm = b.strikes.find((s) => s.strike === b.atm);
    const spr = (o) => (o?.bid && o?.ask ? `${(o.ask - o.bid).toFixed(2)}` : '—');
    const sprPct = (o) => (o?.bid && o?.ask ? `${(((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100).toFixed(2)}% of price` : '');
    const m = b.lastMinute;
    const bullTr = m ? m.ceBuy + m.peSell : 0;
    const bearTr = m ? m.peBuy + m.ceSell : 0;
    const r = b.reaction;
    $('bTiles').innerHTML = [
      tile('Book pressure', n?.bull != null ? `${n.bull.toFixed(1)}%` : '—', n?.avg30 != null ? `bullish side · 30-min avg ${n.avg30.toFixed(1)}%` : 'bullish side of waiting qty'),
      tile('vs 30-min avg', n?.bull != null && n?.avg30 != null ? sgn(n.bull - n.avg30) : '—', 'pts · + = leaning bullish', cls(n?.bull - n?.avg30)),
      tile('Change 5 / 15 min', `${sgn(n?.chg5)} / ${sgn(n?.chg15)}`, 'pts of bullish share'),
      tile(`ATM ${b.atm ?? ''} CE spread`, spr(atm?.ce), sprPct(atm?.ce)),
      tile(`ATM ${b.atm ?? ''} PE spread`, spr(atm?.pe), sprPct(atm?.pe)),
      tile('Trades, last minute', bullTr + bearTr ? `${((bullTr / (bullTr + bearTr)) * 100).toFixed(0)}% bull` : '—', m ? `bull ${compact(bullTr)} · bear ${compact(bearTr)}` : 'needs tick feed', cls(bullTr - bearTr)),
      tile('Reaction today', r.leaned ? `${((r.right / r.leaned) * 100).toFixed(0)}%` : '—', r.leaned ? `${r.right}/${r.leaned} leans followed in 5m` : 'not enough data yet'),
    ].join('');
  }

  // ---------- 1 · buy share of queue per strike ----------
  function renderBuyPct(b) {
    const s = b.strikes;
    const pct = (o) => (o.tbq != null && o.tbq + o.tsq > 0 ? (o.tbq / (o.tbq + o.tsq)) * 100 : null);
    const ch = make('bBuyPct', {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'CE', showLine: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: C.ce, pointBorderColor: C.surface, pointBorderWidth: 2, borderColor: C.ce, data: [] },
        { label: 'PE', showLine: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: C.pe, pointBorderColor: C.surface, pointBorderWidth: 2, borderColor: C.pe, data: [] },
        { label: 'balanced', borderColor: C.muted, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, data: [] },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false } }, y: { min: 0, max: 100, grid: { color: C.grid }, border: { display: false }, ticks: { callback: (v) => `${v}%` } } },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { filter: (i) => i.text !== 'balanced' } },
          tooltip: { filter: (c) => c.datasetIndex < 2, callbacks: { label: (c) => {
            const o = s[c.dataIndex][c.datasetIndex ? 'pe' : 'ce'];
            return ` ${c.dataset.label} ${c.raw == null ? '—' : c.raw.toFixed(0) + '% buy'} · waiting buy ${compact(o.tbq)} / sell ${compact(o.tsq)}`;
          } } },
        },
      },
    });
    ch.data.labels = s.map((x) => x.strike);
    ch.data.datasets[0].data = s.map((x) => pct(x.ce));
    ch.data.datasets[1].data = s.map((x) => pct(x.pe));
    ch.data.datasets[2].data = s.map(() => 50);
    ch.options.scales.x.ticks = { color: (c) => (s[c.index]?.strike === b.atm ? C.atm : C.muted) };
    ch.update('none');
  }

  // ---------- 2 · queue size per strike ----------
  function renderQueue(b) {
    seg('bQueueSide', 's', bs.queueSide, (v) => { bs.queueSide = v; save('queueSide', v); renderQueue(bs.data); });
    const s = b.strikes;
    const side = bs.queueSide;
    const ch = make('bQueue', {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Waiting to buy', backgroundColor: C.up, borderRadius: 4, borderSkipped: 'start', data: [] },
        { label: 'Waiting to sell', backgroundColor: C.down, borderRadius: 4, borderSkipped: 'start', data: [] },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false }, ticks: { callback: (v) => compact(Math.abs(v)) } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => {
            const o = s[c.dataIndex][side];
            return c.datasetIndex === 0
              ? ` buy queue ${compact(o.tbq)} · best bid ${o.bid ?? '—'} × ${o.bidQ ?? '—'}`
              : ` sell queue ${compact(o.tsq)} · best ask ${o.ask ?? '—'} × ${o.askQ ?? '—'}`;
          } } },
        },
        datasets: { bar: { categoryPercentage: 0.8, barPercentage: 0.9 } },
      },
    });
    ch.data.labels = s.map((x) => x.strike);
    ch.data.datasets[0].data = s.map((x) => x[side].tbq);
    ch.data.datasets[1].data = s.map((x) => (x[side].tsq == null ? null : -x[side].tsq));
    ch.options.scales.x.ticks = { color: (c) => (s[c.index]?.strike === b.atm ? C.atm : C.muted) };
    ch.update('none');
  }

  // ---------- 3 · pressure vs Nifty ----------
  function renderPressure(b) {
    const ser = b.series;
    if (!ser.length) return;
    const x = { type: 'linear', min: ser[0].t, max: ser[ser.length - 1].t, grid: { display: false }, ticks: { maxTicksLimit: 6, callback: (v) => fmt(v) } };
    const spot = make('bSpot', {
      type: 'line',
      data: { datasets: [{ label: 'Nifty', data: [], borderColor: C.accent, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.2 }] },
      options: {
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: { ...x, ticks: { display: false } }, y: { grid: { color: C.grid }, border: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => fmt(i[0].raw.x), label: (c) => ` Nifty ${c.raw.y.toFixed(1)}` } } },
      },
    });
    spot.data.datasets[0].data = ser.map((p) => ({ x: p.t, y: p.spot }));
    spot.options.scales.x = { ...x, ticks: { display: false } };
    spot.update('none');

    const pr = make('bPressure', {
      type: 'line',
      data: { datasets: [
        { label: 'Book pressure', data: [], borderColor: C.text, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.2 },
        { label: '30-min average', data: [], borderColor: C.muted, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x, y: { grid: { color: C.grid }, border: { display: false }, ticks: { callback: (v) => `${v}%` } } },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { title: (i) => fmt(i[0].raw.x), label: (c) => ` ${c.dataset.label} ${c.raw.y.toFixed(1)}%` } },
        },
      },
    });
    pr.data.datasets[0].data = ser.filter((p) => p.bull != null).map((p) => ({ x: p.t, y: p.bull }));
    pr.data.datasets[1].data = ser.filter((p) => p.avg30 != null).map((p) => ({ x: p.t, y: p.avg30 }));
    pr.options.scales.x = x;
    pr.update('none');
  }

  // ---------- 4 · heatmap: buy share per strike per minute ----------
  function renderHeat(b) {
    seg('bHeatSide', 's', bs.heatSide, (v) => { bs.heatSide = v; save('heatSide', v); renderHeat(bs.data); });
    const h = b.heat;
    const el = $('bHeat');
    if (!h.strikes.length) { el.innerHTML = '<div class="muted small">Waiting for order-book data (needs the tick feed).</div>'; return; }
    const vals = h[bs.heatSide];
    const n = h.times.length;
    el.style.gridTemplateColumns = `44px repeat(${n}, minmax(0, 1fr))`;
    el.style.gridTemplateRows = `repeat(${h.strikes.length}, minmax(0, 1fr)) 14px 16px`;
    // diverging: red = sell-heavy, grey = balanced, green = buy-heavy
    const color = (v) => {
      if (v == null) return 'transparent';
      const d = (v - 50) / 50;
      if (Math.abs(d) < 0.04) return 'rgba(139,148,158,.18)';
      return d > 0 ? `rgba(63,182,139,${(0.15 + 0.85 * d).toFixed(2)})` : `rgba(240,113,107,${(0.15 + 0.85 * -d).toFixed(2)})`;
    };
    let html = '';
    for (let si = h.strikes.length - 1; si >= 0; si--) {
      const k = h.strikes[si];
      html += `<div class="hk${k === b.atm ? ' atm' : ''}">${k}</div>`;
      for (let ti = 0; ti < n; ti++) {
        const v = vals[si][ti];
        html += `<div class="hc" style="background:${color(v)}" title="${k} ${bs.heatSide.toUpperCase()} · ${fmt(h.times[ti])} · ${v == null ? 'no data' : v.toFixed(0) + '% of queue on the buy side'}"></div>`;
      }
    }
    html += '<div></div>';
    for (let ti = 0; ti < n; ti++) html += `<div class="ht">${ti % 15 === 0 || ti === n - 1 ? fmt(h.times[ti]) : ''}</div>`;
    html += `<div></div><div class="heat-legend" style="grid-column: 2 / -1"><span>sell-heavy</span>
      <span style="flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg, rgba(240,113,107,1), rgba(139,148,158,.25), rgba(63,182,139,1))"></span><span>buy-heavy</span></div>`;
    el.innerHTML = html;
  }

  // ---------- 5 · who traded, per minute ----------
  function renderTrades(b) {
    const mins = b.minutes.slice(-60);
    const ch = make('bTrades', {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'CE bought', backgroundColor: C.ce, stack: 's', data: [] },
        { label: 'PE sold', backgroundColor: C.pe + '99', stack: 's', data: [] },
        { label: 'PE bought', backgroundColor: C.pe, stack: 's', data: [] },
        { label: 'CE sold', backgroundColor: C.ce + '99', stack: 's', data: [] },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
          y: { stacked: true, grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false }, ticks: { callback: (v) => compact(Math.abs(v)) } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${compact(Math.abs(c.raw))}` } },
        },
        datasets: { bar: { categoryPercentage: 0.9, barPercentage: 0.95 } },
      },
    });
    ch.data.labels = mins.map((m) => fmt(m.t));
    ch.data.datasets[0].data = mins.map((m) => m.ceBuy);
    ch.data.datasets[1].data = mins.map((m) => m.peSell);
    ch.data.datasets[2].data = mins.map((m) => -m.peBuy);
    ch.data.datasets[3].data = mins.map((m) => -m.ceSell);
    ch.update('none');
  }

  // ---------- 6 · reaction scatter ----------
  function renderReaction(b) {
    const r = b.reaction;
    $('bReactNote').textContent = r.points.length
      ? `book lean vs next 5 min · ${r.points.length} minutes${r.corr != null ? ` · correlation ${r.corr.toFixed(2)}` : ''}`
      : 'needs ~35 min of order-book data';
    const color = (p) => (Math.abs(p.lean) < 3 ? C.muted : Math.sign(p.move) === Math.sign(p.lean) ? C.up : C.down);
    const ch = make('bReact', {
      type: 'scatter',
      data: { datasets: [{ label: 'minute', data: [], pointRadius: 4, pointHoverRadius: 6, borderWidth: 1 }] },
      options: {
        scales: {
          x: { title: { display: true, text: 'book lean vs 30-min avg (pts, + = bullish)', color: C.muted }, grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) } },
          y: { title: { display: true, text: 'Nifty, next 5 min (pts)', color: C.muted }, grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${fmt(c.raw.t)} · lean ${sgn(c.raw.x)} · Nifty ${sgn(c.raw.y)} pts` } },
        },
      },
    });
    const ds = ch.data.datasets[0];
    ds.data = r.points.map((p) => ({ x: p.lean, y: p.move, t: p.t }));
    ds.backgroundColor = r.points.map(color);
    ds.borderColor = C.surface;
    ch.update('none');
  }

  function renderAll() {
    const b = bs.data;
    if (!b) return;
    renderTiles(b);
    renderBuyPct(b);
    renderQueue(b);
    renderPressure(b);
    renderHeat(b);
    renderTrades(b);
    renderReaction(b);
  }

  async function load() {
    if (bs.fetching || Date.now() - bs.fetchedAt < 2000) return;
    bs.fetching = true;
    try {
      const r = await fetch('/api/book', { cache: 'no-store' });
      bs.data = await r.json();
      bs.fetchedAt = Date.now();
      if (state.view === 'book') renderAll();
    } catch {
      // the main refresh loop reports connection problems
    } finally {
      bs.fetching = false;
    }
  }

  window.onBookRender = () => {
    if (state.view !== 'book') return;
    load();
  };
})();
