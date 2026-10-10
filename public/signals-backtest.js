// "Backtest" tab: runs recorded days through the signal logic as it is now (/api/signal-backtest) and shows,
// per kind of signal, how often Nifty then moved the indicated way, next to what was recorded live.
// It only needs the recorded files, so it works outside market hours and before logging in.
(function () {
  const $ = (id) => document.getElementById(id);
  const { state, esc, TYPE_LABEL } = window.app;
  const bt = { result: null, kind: null, daysLoaded: false, inputsFilled: false, running: false };
  const INPUTS = {
    spikeRatio: 'sbtSpikeRatio', spikeMinQty: 'sbtSpikeMinQty', priceSpikePct: 'sbtPricePct',
    spotFastPts: 'sbtFastPts', spotMovePts: 'sbtMovePts', cooldownMin: 'sbtCooldown',
  };
  const MAX_LISTED = 500;
  const hhmm = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
  const hhmmss = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 19);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const arrow = (dir) => (dir === 'up' ? '▲' : '▼');

  async function loadDays() {
    if (bt.daysLoaded) return;
    bt.daysLoaded = true;
    try {
      const days = await (await fetch('/api/flow-days', { cache: 'no-store' })).json();
      $('sbtDay').innerHTML = '<option value="all">All recorded days</option>' + days.map((d) => `<option value="${d}">${d}</option>`).join('');
    } catch { bt.daysLoaded = false; }
  }

  // Start the threshold inputs at the values in use (live rules, or what the last run reported).
  function fillInputs(rules) {
    if (bt.inputsFilled || !rules) return;
    bt.inputsFilled = true;
    for (const [k, id] of Object.entries(INPUTS)) if ($(id).value === '') $(id).value = rules[k] ?? '';
  }

  async function run() {
    if (bt.running) return;
    const q = new URLSearchParams({ date: $('sbtDay').value });
    for (const [k, id] of Object.entries(INPUTS)) if ($(id).value !== '') q.set(k, $(id).value);
    bt.running = true;
    $('sbtRun').disabled = true;
    $('sbtNote').textContent = 'Running… (a few seconds per day)';
    try {
      const r = await (await fetch('/api/signal-backtest?' + q, { cache: 'no-store' })).json();
      if (r.error) throw new Error(r.error);
      if (!r.days.length) {
        $('sbtNote').textContent = 'No market-hours tape recorded for that day.';
        return;
      }
      bt.result = r;
      bt.kind = null;
      $('sbtNote').textContent = '';
      fillInputs(r.settings);
      render();
    } catch (e) {
      $('sbtNote').textContent = 'Backtest failed: ' + e.message;
    } finally {
      bt.running = false;
      $('sbtRun').disabled = false;
    }
  }

  const byDayText = (o) => o.perDay.map((d) => `${d.day.slice(5)} ${d.hits}/${d.n} (any moment ${pct(d.base)})`).join(' · ');

  function renderTiles(r) {
    const total = r.days.reduce((s, d) => s + d.signals, 0);
    const withLive = r.days.filter((d) => d.recorded != null);
    const liveTotal = withLive.reduce((s, d) => s + d.recorded, 0);
    const base = r.days.reduce((s, d) => ({ n: s.n + d.base.n, up: s.up + d.base.up, down: s.down + d.base.down }), { n: 0, up: 0, down: 0 });
    const high = r.kinds.filter((o) => o.high);
    const perDay = r.days.map((d) => `${d.day.slice(5)} ${hhmm(d.from)}–${hhmm(d.to)}`).join(' · ');
    const perDaySignals = r.days.map((d) => `${d.day.slice(5)}: ${d.signals}${d.recorded != null ? ` (live ${d.recorded})` : ''}`).join(' · ');
    const tile = (label, value, note) => `<div class="st"><span class="s">${label}</span><span class="v">${value}</span><span class="s">${esc(note)}</span></div>`;
    $('sbtTiles').classList.remove('hidden');
    $('sbtTiles').innerHTML =
      tile('Days tested', r.days.length, perDay)
      + tile('Signals with the current logic', total, [withLive.length ? `recorded live: ${liveTotal}` : '', r.days.length > 1 || !withLive.length ? perDaySignals : ''].filter(Boolean).join(' · '))
      + tile('High-probability kinds', high.length, high.length ? high.map((o) => `${o.label} ${arrow(o.dir)} ${pct(o.p)}`).join(' · ') : 'none clears the bar on these days')
      + tile('Any moment', base.n ? `<span class="neg">▼ ${pct(base.down / base.n)}</span> <span class="pos">▲ ${pct(base.up / base.n)}</span>` : '—',
        `how often Nifty moves ${r.rule.pts} pts down / up first within ${r.rule.min} min, at any time of these days`);
  }

  function renderKinds(r) {
    const s = r.settings;
    $('sbtRule').textContent = `spike ≥${s.spikeRatio}× and ≥${s.spikeMinQty} · premium ≥${s.priceSpikePct}% · Nifty ≥${s.spotFastPts} pts/20s or ≥${s.spotMovePts} pts/1m · cooldown ${s.cooldownMin} min`;
    if (!r.kinds.length) {
      $('sbtKinds').innerHTML = '<p class="muted sbt-hint">No signals fired with these settings.</p>';
      return;
    }
    const live = Object.fromEntries(r.recorded.map((o) => [o.kind, o]));
    const rows = r.kinds.map((o) => {
      const l = live[o.kind];
      const was = l ? `<span class="${l.dir === 'up' ? 'pos' : 'neg'}">${arrow(l.dir)} ${pct(l.p)}</span> <span class="sub">${l.hits}/${l.n}</span>` : '<span class="muted">—</span>';
      const ahead = o.perDay.filter((d) => d.hits / d.n > d.base).length;
      return `<tr data-kind="${esc(o.kind)}" title="${esc(byDayText(o))}" class="${o.high ? 'high' : ''}${bt.kind === o.kind ? ' sel' : ''}">
        <td>${o.high ? '★ ' : ''}${esc(o.label)}</td>
        <td class="${o.dir === 'up' ? 'pos' : 'neg'}">${arrow(o.dir)} ${o.dir === 'up' ? 'rises' : 'falls'}</td>
        <td><b>${pct(o.p)}</b></td><td>${o.hits}/${o.n}</td><td>${o.against}</td><td class="muted">${pct(o.base)}</td>
        <td>${was}</td><td>${ahead}/${o.perDay.length}</td></tr>`;
    }).join('');
    $('sbtKinds').innerHTML = `<table class="flow-table sbt-kinds">
        <thead><tr><th>Signal kind</th><th>Then Nifty</th><th>Hit rate</th><th>Cases</th><th>Against</th><th>Any moment</th><th>Recorded live</th><th title="Days on which the hit rate was above that day's any-moment rate">Days ahead</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div class="muted small sbt-foot">Hit = Nifty moved ${r.rule.pts} pts that way before ${r.rule.pts} pts the other, within ${r.rule.min} min of the signal.
        Signals of one kind under ${r.rule.gapMin} min apart count once. Any moment = the same outcome at any time of these days.
        ★ = clears the high-probability bar (hit rate ≥ ${r.rule.high.p * 100}%, ≥ ${r.rule.high.cases} cases, above any moment on ≥ ${r.rule.high.days} days).
        Recorded live = what the signals saved on those days scored. Days ahead = days on which the hit rate beat that day's any-moment rate.
        Click a row to list only that kind and see its day-by-day split.</div>
      ${r.errors.length ? `<div class="neg small sbt-foot">${esc(r.errors.join(' · '))}</div>` : ''}`;
  }

  function renderList(r) {
    const multi = r.days.length > 1;
    const list = r.events.filter((e) => !bt.kind || e.kind === bt.kind);
    const shown = list.slice(0, MAX_LISTED);
    const kind = bt.kind ? r.kinds.find((o) => o.kind === bt.kind) : null;
    const picked = kind?.label;
    $('sbtListSub').textContent = kind ? `By day: ${byDayText(kind)}` : '';
    const outcome = (o) => (o == null ? '<span class="muted">tape ends</span>'
      : o > 0 ? `<span class="pos">▲ rose ${r.rule.pts} first</span>`
        : o < 0 ? `<span class="neg">▼ fell ${r.rule.pts} first</span>` : '<span class="muted">neither</span>');
    $('sbtListTitle').textContent = `${picked || 'All signals'} · ${list.length}${list.length > shown.length ? ` (first ${shown.length} shown)` : ''}`;
    $('sbtAll').classList.toggle('hidden', !picked);
    $('sbtList').innerHTML = shown.map((e) => `<li>
      <div class="ev-top"><span class="ev-time">${multi ? e.day.slice(5) + ' ' : ''}${hhmmss(e.t)}</span><span class="pill ${e.type}">${TYPE_LABEL[e.type] || e.type}</span><span class="ev-after">${outcome(e.o)}</span></div>
      <div class="ev-detail">${esc(e.detail)}</div></li>`).join('');
  }

  function render() {
    renderTiles(bt.result);
    renderKinds(bt.result);
    renderList(bt.result);
  }

  $('sbtKinds').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-kind]');
    if (!tr) return;
    bt.kind = bt.kind === tr.dataset.kind ? null : tr.dataset.kind;
    renderKinds(bt.result);
    renderList(bt.result);
  });
  $('sbtAll').addEventListener('click', (e) => {
    e.preventDefault();
    bt.kind = null;
    renderKinds(bt.result);
    renderList(bt.result);
  });
  $('sbtRun').addEventListener('click', run);
  $('sbtDay').addEventListener('change', run);

  // Called from app.js when the tab is opened and on every data refresh.
  window.onBacktestRender = () => {
    if (state.view !== 'backtest') return;
    loadDays();
    fillInputs(state.signals?.rules);
  };
  window.onBacktestRender();
})();
