// "Volume Flow" tab: live CE vs PE 1-minute volume balance, the predictions it produced, and how
// the market actually reacted. Data comes from /api/chain (state.flow) and /api/flow-series.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const { state, compact, istClock, esc } = window.app;

  const C = {
    ce: css('--ce-mark'), pe: css('--pe-mark'), up: css('--up'), down: css('--down'),
    muted: css('--muted'), surface: css('--panel'), grid: 'rgba(139,148,158,.12)', zero: 'rgba(139,148,158,.45)',
    spot: css('--accent'),
  };
  const fmtTime = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
  const secs = (a, b) => (a && b ? Math.round((b - a) / 1000) : null);
  const dur = (s) => (s == null ? '—' : s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
  const pts = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}`);
  const fs = { series: [], fetchedAt: 0, fetching: false, charts: {}, replay: null, daysLoaded: false, inputsFilled: false };

  // ---------- live gauge ----------
  function renderLive(f) {
    const l = f.live;
    const r = f.rules;
    $('flowScope').textContent = `ATM ±${r.strikesAround} strikes, nearest expiry`;
    $('fgMarkLo').style.left = `${100 - r.sharePct}%`;
    $('fgMarkHi').style.left = `${r.sharePct}%`;
    $('fgRule').textContent = `signal at ≥${r.sharePct.toFixed(0)}% for ${r.holdSec}s · min ${compact(r.minQty)} in 1m`;
    if (!l.ready) {
      $('fgCe').textContent = $('fgPe').textContent = '—';
      $('fgCeShare').textContent = $('fgPeShare').textContent = '';
      $('fgFill').style.width = '50%';
      $('flowStatus').innerHTML = '<span class="muted">Collecting the first minute of data…</span>';
      return;
    }
    const share = l.bullShare ?? 50;
    $('flowTitle').textContent = `Live flow · last 1 min · ${MODE_TEXT[l.mode]}`;
    $('fgLeft').textContent = l.mode === 'volume' ? 'CE' : 'Bullish';
    $('fgRight').textContent = l.mode === 'volume' ? 'PE' : 'Bearish';
    $('fgCe').textContent = '+' + compact(l.bull);
    $('fgPe').textContent = '+' + compact(l.bear);
    $('fgCeShare').textContent = l.bullShare == null ? '' : `${share.toFixed(0)}%`;
    $('fgPeShare').textContent = l.bullShare == null ? '' : `${(100 - share).toFixed(0)}%`;
    $('fgFill').style.width = `${share}%`;
    $('fgRaw').textContent = `${MODE_HELP[l.mode]} Raw volume: CE +${compact(l.ce)} · PE +${compact(l.pe)}.`;

    const lead = l.leader ? `${l.leader.side === 'up' ? 'Bullish' : 'Bearish'} flow leading since ${istClock(l.leader.since)} (${dur(secs(l.leader.since, Date.now()))})` : '';
    let msg;
    if (l.quiet) msg = `<span class="big muted">Quiet</span> · under ${compact(r.minQty)} traded near ATM in the last minute`;
    else if (l.zone === 'neutral') msg = `<span class="big muted">Balanced</span> · neither side has ${r.sharePct.toFixed(0)}%`;
    else {
      const up = l.zone === 'up';
      const c = l.candidate;
      const wait = c && !c.armed ? ' · already signalled this flow — waits for it to flip' : c && c.heldSec < r.holdSec ? ` · signal in ${r.holdSec - c.heldSec}s` : '';
      msg = `<span class="big dir ${l.zone}">${up ? 'Bullish flow → UP bias ▲' : 'Bearish flow → DOWN bias ▼'}</span>${wait}`;
    }
    $('flowStatus').innerHTML = `${msg}<div class="muted small" style="margin-top:4px">${lead}</div>`;
  }

  // ---------- stats ----------
  function renderStats(f) {
    const s = f.stats;
    const rate = (x) => (x == null ? '—' : `${x.toFixed(0)}%`);
    const cell = (label, v, sub) => `<div class="st"><span class="s">${label}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
    $('flowStats').innerHTML = [
      cell('Predictions today', s.total, `${s.pending} still being tracked`),
      cell('Hit rate', rate(s.hitRate), `${s.hit} hit · ${s.miss} miss · ${s.flat} flat`),
      cell('UP calls', rate(s.up.hitRate), `${s.up.hit}/${s.up.hit + s.up.miss} right · ${s.up.flat} flat`),
      cell('DOWN calls', rate(s.down.hitRate), `${s.down.hit}/${s.down.hit + s.down.miss} right · ${s.down.flat} flat`),
      cell('Reaction starts', s.avgReactionSec == null ? '—' : dur(Math.round(s.avgReactionSec)), `avg time to first ±${f.rules.reactionStartPts} pt move`),
      cell('Time to HIT', s.avgSecToHit == null ? '—' : dur(Math.round(s.avgSecToHit)), `avg, to reach ±${f.rules.reactPts} pts`),
      cell('Avg best move', pts(s.avgFav), 'pts in predicted direction'),
      cell('Avg worst move', pts(s.avgAdv), `pts against, within ${f.rules.horizonMin}m`),
    ].join('');
  }

  const MODE_TEXT = { aggressor: 'buyers vs sellers (bid/ask)', premium: 'by premium direction', volume: 'raw CE vs PE volume' };
  const MODE_HELP = {
    aggressor: 'Bullish = CE bought + PE sold; bearish = PE bought + CE sold (trade at ask = buy, at bid = sell).',
    premium: 'Bullish = CE volume while CE premium rose + PE volume while PE premium fell; bearish = the reverse.',
    volume: 'Raw call volume vs put volume (does not tell buying from writing).',
  };
  // Which measure a prediction used, and how one-sided it was.
  function flowCell(p) {
    const mode = p.mode || 'volume';
    const bullPct = p.bull != null && p.bull + p.bear > 0 ? (p.bull / (p.bull + p.bear)) * 100 : p.share;
    const side = p.dir === 'up' ? bullPct : 100 - bullPct;
    const short = { aggressor: 'bid/ask', premium: 'premium', volume: 'CE/PE vol' }[mode];
    return `${side.toFixed(0)}% ${p.dir === 'up' ? 'bull' : 'bear'}<span class="sub">${short}</span>`;
  }

  // ---------- table ----------
  function renderTable(f) {
    if (!f.predictions.length) {
      $('flowBody').innerHTML = `<tr><td colspan="14" class="muted" style="text-align:left;padding:12px">No predictions yet today. A prediction is made when one side has ≥${f.rules.sharePct.toFixed(0)}% of the volume added near ATM in the last minute, for ${f.rules.holdSec}s in a row. It is a HIT if Nifty moves ${f.rules.reactPts} pts that way before ${f.rules.reactPts} pts the other way, and FLAT if neither happens within ${f.rules.horizonMin} min.</td></tr>`;
      return;
    }
    const prem = (a, b) => (a == null ? '—' : b == null ? `${a.toFixed(2)}` : `${a.toFixed(2)} → ${b.toFixed(2)}<span class="sub ${b >= a ? 'pos' : 'neg'}">${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(1)}%</span>`);
    const after = (v, p) => (v == null ? '—' : `${v.toFixed(1)}<span class="sub ${v - p.spot >= 0 ? 'pos' : 'neg'}">${pts(v - p.spot)}</span>`);
    $('flowBody').innerHTML = f.predictions.map((p) => {
      const build = secs(p.buildStartAt, p.at);
      const react = p.reactionAt
        ? `${istClock(p.reactionAt)}<span class="sub">${dur(secs(p.at, p.reactionAt))} · ${p.reactionDir === 'up' ? '▲' : '▼'}</span>`
        : '<span class="muted">—</span>';
      const res = `<span class="res ${p.result}">${p.result.toUpperCase()}</span>${p.resultAt && p.result !== 'flat' && p.result !== 'interrupted' ? `<span class="sub">in ${dur(secs(p.at, p.resultAt))}</span>` : ''}`;
      return `<tr>
        <td>${istClock(p.buildStartAt)}<span class="sub">${build ? dur(build) + ' before' : ''}</span></td>
        <td>${istClock(p.at)}</td>
        <td><span class="dir ${p.dir}">${p.dir === 'up' ? '▲ UP' : '▼ DOWN'}</span></td>
        <td>${flowCell(p)}</td>
        <td>+${compact(p.ce)}${p.buildCe != null ? `<span class="sub">from +${compact(p.buildCe)}</span>` : ''}</td>
        <td>+${compact(p.pe)}${p.buildPe != null ? `<span class="sub">from +${compact(p.buildPe)}</span>` : ''}</td>
        <td>${p.spot?.toFixed(1) ?? '—'}</td>
        <td>${react}</td>
        <td>${res}</td>
        <td><span class="pos">${pts(p.fav)}</span> / <span class="neg">${pts(p.adv)}</span></td>
        <td>${after(p.spot1m, p)}</td>
        <td>${after(p.spotEnd, p)}</td>
        <td>${prem(p.atmCe, p.atmCeAfter)}</td>
        <td>${prem(p.atmPe, p.atmPeAfter)}</td>
      </tr>`;
    }).join('');
  }

  // ---------- charts ----------
  function make(id, config) {
    if (!fs.charts[id]) fs.charts[id] = new Chart($(id), config);
    return fs.charts[id];
  }

  function renderCharts(f) {
    const s = fs.series;
    if (!s.length) return;
    const minX = s[0].t;
    const maxX = s[s.length - 1].t;
    const timeAxis = { type: 'linear', min: minX, max: maxX, grid: { display: false }, ticks: { maxTicksLimit: 8, callback: (v) => fmtTime(v) } };

    const preds = f.predictions.filter((p) => p.at >= minX && p.spot != null);
    const markerColor = (p) => (p.result === 'hit' ? (p.dir === 'up' ? C.up : C.down) : p.result === 'miss' ? 'transparent' : C.muted);
    const spot = make('cFlowSpot', {
      type: 'line',
      data: { datasets: [
        { label: 'Nifty', data: [], borderColor: C.spot, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.2 },
        { label: 'Predictions', type: 'scatter', data: [], pointRadius: 8, pointHoverRadius: 10, borderWidth: 2 },
      ] },
      options: {
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: timeAxis, y: { grid: { color: C.grid }, border: { display: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => fmtTime(items[0].raw.x) + (items[0].raw.p ? ' · prediction' : ''),
            label: (c) => {
              const p = c.raw.p;
              if (!p) return ` Nifty ${c.raw.y.toFixed(1)}`;
              return ` ${p.dir.toUpperCase()} at ${p.spot.toFixed(1)} · CE ${p.share.toFixed(0)}% · ${p.result.toUpperCase()} · best ${pts(p.fav)} / worst ${pts(p.adv)}`;
            },
          } },
        },
      },
    });
    spot.data.datasets[0].data = s.filter((x) => x.spot != null).map((x) => ({ x: x.t, y: x.spot }));
    const m = spot.data.datasets[1];
    m.data = preds.map((p) => ({ x: p.at, y: p.spot, p }));
    m.pointStyle = 'triangle';
    m.rotation = preds.map((p) => (p.dir === 'up' ? 0 : 180));
    m.backgroundColor = preds.map(markerColor);
    m.borderColor = preds.map((p) => (p.result === 'flat' || p.result === 'pending' || p.result === 'interrupted' ? C.muted : p.dir === 'up' ? C.up : C.down));
    spot.options.scales.x = timeAxis;
    spot.update('none');

    const lim = f.rules.imbalance * 100;
    const imb = make('cFlowImb', {
      type: 'bar',
      data: { datasets: [
        { label: 'CE − PE share of 1m volume', data: [], backgroundColor: [], barPercentage: 1, categoryPercentage: 1, borderRadius: 2 },
        { label: 'UP threshold', type: 'line', data: [], borderColor: C.muted, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
        { label: 'DOWN threshold', type: 'line', data: [], borderColor: C.muted, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      ] },
      options: {
        scales: {
          x: timeAxis,
          y: { suggestedMin: -50, suggestedMax: 50, grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: (v) => (v > 0 ? `CE +${v}` : v < 0 ? `PE +${-v}` : '0') } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { filter: (c) => c.datasetIndex === 0, callbacks: {
            title: (items) => fmtTime(items[0].raw.x),
            label: (c) => ` CE ${(50 + c.raw.y / 2).toFixed(0)}% · PE ${(50 - c.raw.y / 2).toFixed(0)}% of 1m volume`,
          } },
        },
      },
    });
    const bars = s.filter((x) => x.imb != null);
    imb.data.datasets[0].data = bars.map((x) => ({ x: x.t, y: x.imb * 100 }));
    imb.data.datasets[0].backgroundColor = bars.map((x) => (x.imb >= 0 ? C.ce : C.pe));
    imb.data.datasets[1].data = [{ x: minX, y: lim }, { x: maxX, y: lim }];
    imb.data.datasets[2].data = [{ x: minX, y: -lim }, { x: maxX, y: -lim }];
    imb.options.scales.x = timeAxis;
    imb.update('none');
  }

  async function loadSeries() {
    if (fs.fetching || Date.now() - fs.fetchedAt < 2500) return;
    fs.fetching = true;
    try {
      const series = await (await fetch('/api/flow-series', { cache: 'no-store' })).json();
      if (fs.replay) return;
      fs.series = series;
      fs.fetchedAt = Date.now();
      if (state.flow) renderCharts(state.flow);
    } catch {
      // connection problems are reported by the main refresh loop
    } finally {
      fs.fetching = false;
    }
  }

  // ---------- replay ----------
  async function loadDays() {
    if (fs.daysLoaded) return;
    fs.daysLoaded = true;
    try {
      const days = await (await fetch('/api/flow-days', { cache: 'no-store' })).json();
      $('flowDay').innerHTML = '<option value="live">Live (today)</option>' + days.map((d) => `<option value="${d}">${d}</option>`).join('');
    } catch { fs.daysLoaded = false; }
  }

  function fillInputs(r) {
    if (fs.inputsFilled) return;
    fs.inputsFilled = true;
    $('rpMode').value = r.mode || 'aggressor';
    $('rpShare').value = Math.round(r.sharePct);
    $('rpHold').value = r.holdSec;
    $('rpMin').value = r.minQty;
    $('rpReact').value = r.reactPts;
    $('rpHorizon').value = r.horizonMin;
  }

  async function runReplay() {
    const day = $('flowDay').value === 'live' ? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10) : $('flowDay').value;
    const q = new URLSearchParams({
      date: day,
      mode: $('rpMode').value,
      imbalance: (Number($('rpShare').value) - 50) / 50,
      holdSec: $('rpHold').value,
      minQty: $('rpMin').value,
      reactPts: $('rpReact').value,
      horizonMin: $('rpHorizon').value,
    });
    $('rpRun').disabled = true;
    $('flowMode').textContent = 'Replaying…';
    try {
      const r = await (await fetch('/api/flow-replay?' + q, { cache: 'no-store' })).json();
      if (r.error) throw new Error(r.error);
      if (!r.tape.snapshots) {
        $('flowMode').textContent = `No tape recorded for ${day}.`;
        return;
      }
      fs.replay = r;
      renderReplay();
    } catch (e) {
      $('flowMode').textContent = 'Replay failed: ' + e.message;
    } finally {
      $('rpRun').disabled = false;
    }
  }

  function renderReplay() {
    const r = fs.replay;
    const t = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
    const live = r.recorded ? ` · live run recorded ${r.recorded.total} (${r.recorded.hit} hit, ${r.recorded.miss} miss)` : '';
    $('flowMode').innerHTML = `<span class="replay-tag">REPLAY ${r.day}</span> ${r.tape.snapshots} snapshots, ${t(r.tape.from)}–${t(r.tape.to)} IST${live}`;
    const f = { live: null, stats: r.stats, predictions: r.predictions, rules: r.rules };
    $('flowStatus').innerHTML = `<span class="big">Replay of ${r.day}</span><div class="muted small" style="margin-top:4px">Same logic as live, run over the recorded tape with the settings above. Pick “Live (today)” to go back.</div>`;
    $('fgCe').textContent = $('fgPe').textContent = '—';
    $('fgCeShare').textContent = $('fgPeShare').textContent = '';
    $('fgFill').style.width = '50%';
    renderStats(f);
    renderTable(f);
    fs.series = r.series;
    renderCharts(f);
  }

  $('rpRun').addEventListener('click', runReplay);
  $('flowDay').addEventListener('change', () => {
    if ($('flowDay').value === 'live') {
      fs.replay = null;
      fs.fetchedAt = 0;
      $('flowMode').textContent = '';
      window.onFlowRender();
    } else {
      runReplay();
    }
  });

  window.onFlowRender = () => {
    if (state.view !== 'flow' || !state.flow) return;
    loadDays();
    fillInputs(state.flow.rules);
    $('flowFile').textContent = `${state.data?.source === 'demo' ? 'events-demo' : 'events'}/<date>/predictions.csv`;
    if (fs.replay) return; // a replay is on screen; live updates resume when "Live" is picked
    renderLive(state.flow);
    renderStats(state.flow);
    renderTable(state.flow);
    loadSeries();
  };
})();
