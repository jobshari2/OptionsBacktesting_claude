// Arbitrage screen (the anomaly scanner): pick anomaly types and thresholds on the left; on the right either the live scanner
// (what is firing on the chain now, today's log, suggested trades with Deploy / Backtest) or a history scan
// (every occurrence over a period and what its suggested trade made afterwards).
(() => {
  const { $, esc, inrS, num, cls, dayShort, dayLabel } = BT;
  let inited = false;
  let mode = BT.store.get('anMode', 'live');
  let cfg = BT.store.get('anCfg', null); // { enabled: {id: bool}, params: {id: {...}} }
  let settings = null;
  let liveTimer = null;
  let liveState = null;
  let scan = null; // last history scan result
  let hitFilter = 'all';
  const scanOpts = { start: '09:20', end: '15:15', step: 1, ...BT.store.get('anScanOpts', {}) };

  const types = () => BT.meta.anomalies || [];
  const typeOf = (id) => types().find((t) => t.id === id);
  const UNIT = { pts: ' pts', vol: ' vol', '%': '%', '₹': '', '×': '×' };
  const fmtVal = (h) => `${h.unit === '₹' ? '₹' : ''}${num(h.value, Math.abs(h.value) >= 100 ? 0 : 2)}${UNIT[h.unit] ?? ''}`;

  function init() {
    if (!inited) {
      inited = true;
      settings = BT.createSettings($('anSettings'), { onRun: runScan, runLabel: 'Scan history', key: 'settings' });
      BT.on('meta', () => { ensureCfg(); renderTypes(); });
    }
    if (BT.meta.loaded) { ensureCfg(); renderTypes(); }
    settings.reload();
    setMode(mode);
  }

  async function ensureCfg() {
    if (cfg && types().length) { // types added since this browser saved its settings start enabled
      for (const t of types()) if (cfg.enabled[t.id] == null) cfg.enabled[t.id] = true;
    }
    if (cfg || !types().length) return;
    cfg = { enabled: Object.fromEntries(types().map((t) => [t.id, true])), params: {} };
    try {
      const st = await BT.api('/api/an/live');
      if (st.config?.enabled) cfg = { enabled: { ...st.config.enabled }, params: { ...st.config.params } };
    } catch {}
    BT.store.set('anCfg', cfg);
    renderTypes();
  }
  const pval = (t, k, def) => cfg?.params?.[t.id]?.[k] ?? def;

  // ---------- type list ----------
  function renderTypes() {
    if (!cfg) return;
    const groups = {};
    for (const t of types()) (groups[t.group] ||= []).push(t);
    $('anTypes').innerHTML = Object.entries(groups).map(([g, list]) => `
      <div class="an-group"><div class="cmp-g-head"><span>${esc(g)}</span></div>
      ${list.map((t) => `<div class="an-type${cfg.enabled[t.id] ? ' on' : ''}" data-id="${t.id}">
        <label class="an-type-head"><input type="checkbox" data-en="${t.id}" ${cfg.enabled[t.id] ? 'checked' : ''}><b>${esc(t.name)}</b></label>
        <div class="muted small">${esc(t.desc)}</div>
        <details><summary class="small">Thresholds &amp; trade</summary>
          <div class="an-params">${t.params.map((p) => `<label class="mini">${esc(p.label)} <input class="num" type="number" step="${p.step}" data-param="${t.id}.${p.k}" value="${pval(t, p.k, p.def)}"><span class="muted">${esc(p.unit)}</span></label>`).join('')}
            <label class="mini">Cooldown <input class="num" type="number" min="1" step="5" data-param="${t.id}.cooldown" value="${pval(t, 'cooldown', t.cooldown)}"><span class="muted">min</span></label></div>
          <div class="small an-how"><b>Trade:</b> ${esc(t.how)}</div>
          <div class="an-type-actions">
            <select data-btdir="${t.id}">${t.dirs.flatMap((d) => (t.sided ? ['CE', 'PE'].map((sd) => `<option value="${d}|${sd}">${d} · ${sd}</option>`) : [`<option value="${d}|">${d}</option>`])).join('')}</select>
            <button class="btn-sm ghost" data-bt="${t.id}" title="Open a signal strategy for this anomaly in the Backtest editor">Backtest as strategy ▸</button>
          </div>
        </details>
      </div>`).join('')}</div>`).join('');
  }
  const persist = () => { BT.store.set('anCfg', cfg); $('anCfgMsg').textContent = 'changed — press to apply live'; };

  $('anTypes').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.en) { cfg.enabled[t.dataset.en] = t.checked; t.closest('.an-type').classList.toggle('on', t.checked); persist(); }
  });
  $('anTypes').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.param) return;
    const [id, k] = t.dataset.param.split('.');
    (cfg.params[id] ||= {})[k] = t.value === '' ? null : Number(t.value);
    persist();
  });
  $('anTypes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bt]');
    if (!b) return;
    const id = b.dataset.bt;
    const [dir, side] = $('anTypes').querySelector(`[data-btdir="${id}"]`).value.split('|');
    openBacktest(id, dir, side || null);
  });
  $('anAll').addEventListener('click', () => { types().forEach((t) => (cfg.enabled[t.id] = true)); persist(); renderTypes(); });
  $('anNone').addEventListener('click', () => { types().forEach((t) => (cfg.enabled[t.id] = false)); persist(); renderTypes(); });
  $('anSaveCfg').addEventListener('click', async () => {
    try {
      await BT.api('/api/an/config', cfg);
      $('anCfgMsg').textContent = 'live scanner updated ✓';
      pollLive();
    } catch (e) { $('anCfgMsg').textContent = 'failed: ' + e.message; }
  });

  // A signal strategy for an anomaly: enter when it fires (09:20–15:00, up to 2 a day), its suggested legs,
  // exit 15:15. Opens in the Backtest editor to adjust and save.
  function strategyFor(id, dir, side, legsIn) {
    const t = typeOf(id);
    const tpl = t.templates[dir]?.[side || 'CE'] || { legs: [] };
    const legs = (legsIn || tpl.legs).map((l) => ({ action: l.action, type: l.type, lots: l.lots || 1, expiry: l.expiry || 'cur', strike: l.strike, sl: l.sl || { type: 'none', value: 0 }, tgt: l.tgt || { type: 'none', value: 0 }, trail: null, re: null }));
    const params = { ...(cfg?.params?.[id] || {}) };
    delete params.cooldown;
    return {
      ...BT.blankStrategy(), id: null, category: 'Custom', name: `${t.name} — ${dir}${side ? ' ' + side : ''}`,
      desc: `${t.desc} ${t.how}`,
      entry: { time: '09:20', days: [1, 2, 3, 4, 5], dte: [], dteDays: 3, when: 'signal', until: '15:00', maxTrades: 2, conditions: [{ kind: 'anomaly', type: id, params, side: t.sided && side ? side : 'any', dir }] },
      exit: { time: '15:15', dteDays: 0 },
      legs,
      risk: { ...BT.blankStrategy().risk, ...(tpl.risk || {}) },
    };
  }
  function openBacktest(id, dir, side) { BT.emit('open-backtest', { strategy: strategyFor(id, dir, side), run: false }); }

  // ---------- mode ----------
  function setMode(m) {
    mode = m;
    BT.store.set('anMode', m);
    $('anMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('anLive').classList.toggle('hidden', m !== 'live');
    $('anHist').classList.toggle('hidden', m !== 'hist');
    $('anModeHint').textContent = m === 'live'
      ? 'Scans the nearest expiry every 5 s on the server (also when this page is closed, during market hours). Uses the types applied with "Use for live scanner".'
      : 'Rebuilds the nearest weekly chain minute by minute from 1-minute history and runs the ticked types with the thresholds on the left.';
    clearTimeout(liveTimer);
    if (m === 'live') pollLive(); else renderScanOpts();
  }
  $('anMode').addEventListener('click', (e) => { if (e.target.dataset.m) setMode(e.target.dataset.m); });

  // ---------- live ----------
  async function pollLive() {
    clearTimeout(liveTimer);
    if (mode !== 'live' || window.app.state.view !== 'an') return;
    try {
      liveState = await BT.api('/api/an/live');
      renderLive();
    } catch (e) {
      $('anLive').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
    }
    liveTimer = setTimeout(pollLive, 3000);
  }

  function legsHtml(h) {
    return (h.legs || []).map((l) => `<span class="leg-chip ${l.action === 'B' ? 'buy' : 'sell'}" title="bid ${num(l.bid)}${l.bidQ ? ' × ' + l.bidQ : ''} / ask ${num(l.ask)}${l.askQ ? ' × ' + l.askQ : ''}">${l.action === 'B' ? 'B' : 'S'}${l.lots > 1 ? l.lots + '×' : ''} ${l.strike}${l.type}${l.expiry === 'next' ? ' nxt' : ''} ${l.ltp ? '@' + num(l.ltp) : ''}</span>`).join(' ');
  }
  function hitRow(h, i, list, withTime) {
    const t = typeOf(h.type);
    const exec = h.exec == null ? '' : `<div class="small ${h.exec > 0 ? 'pos' : 'muted'}" title="Worst value at expiry with buys at ask and sells at bid, per 1-unit quantity">${h.exec > 0 ? '✔ executable: locks ' + num(h.exec) + ' pts at bid/ask' : 'not executable at bid/ask (' + num(h.exec) + ')'}</div>`;
    return `<tr>
      ${withTime ? `<td>${window.app.istClock(h.t)}</td>` : ''}
      <td class="l"><b>${esc(t?.name || h.type)}</b><div class="muted small">${esc(t?.group || '')}</div></td>
      <td>${h.strike}${h.side ? ' ' + h.side : ''}${h.ref != null ? `<span class="muted">/${h.ref}</span>` : ''}</td>
      <td><span class="dir-pill">${esc(h.dir)}</span></td>
      <td class="b">${fmtVal(h)}</td>
      <td class="l wrap">${esc(h.text)}${exec}</td>
      <td class="l wrap">${legsHtml(h)}</td>
      <td class="nowrap"><button class="btn-sm ghost" data-dep="${i}" data-list="${list}" title="Resolve this trade on the live chain (Strategies tab)">Deploy ▸</button>
        <button class="btn-sm ghost" data-hbt="${i}" data-list="${list}" title="Backtest this anomaly as a signal strategy">Backtest ▸</button></td>
    </tr>`;
  }

  // One fair-value deviation: what to do with it and what it is worth per lot if the price comes back to fair.
  function fvRow(h, i) {
    const rich = h.dir === 'rich';
    const lot = BT.meta.calendar?.liveLot || 65;
    const hedge = (h.legs || [])[1];
    return `<tr>
      <td class="l"><b>${h.strike} ${h.side}</b></td>
      <td><span class="dir-pill ${rich ? 'neg' : 'pos'}">${rich ? 'Overpriced' : 'Underpriced'}</span></td>
      <td>${num(h.mkt)}<div class="muted small">${rich ? 'bid' : 'ask'}</div></td>
      <td>${num(h.fair)}</td>
      <td class="b ${rich ? 'neg' : 'pos'}">${rich ? '+' : '−'}${num(h.value)} pts</td>
      <td>${num(h.pct, 1)}%</td>
      <td>${h.ivMkt == null ? '—' : num(h.ivMkt, 1) + '%'} <span class="muted">vs ${num(h.ivFair, 1)}%</span></td>
      <td>${h.fit == null ? '—' : h.fit + ' lot' + (h.fit === 1 ? '' : 's')}</td>
      <td class="l wrap"><b class="${rich ? 'neg' : 'pos'}">${rich ? 'SELL' : 'BUY'}</b> ${h.strike} ${h.side} at ${num(h.mkt)}${hedge ? ` and <b class="${rich ? 'pos' : 'neg'}">${rich ? 'BUY' : 'SELL'}</b> ${hedge.strike} ${hedge.type} to cap the risk` : ''}.
        <div class="muted small">Worth about <b>${inrS(Math.round(h.value * lot))}</b> per lot if it returns to fair value (${num(h.fair)}); exit there.</div></td>
      <td class="nowrap"><button class="btn-sm ghost" data-dep="${i}" data-list="active" title="Resolve this trade on the live chain (Strategies tab)">Deploy ▸</button>
        <button class="btn-sm ghost" data-hbt="${i}" data-list="active" title="Backtest this as a signal strategy">Backtest ▸</button></td>
    </tr>`;
  }

  function renderLive() {
    const s = liveState;
    const m = s.metrics;
    const st = s.status || {};
    // fair-value deviations get their own table; the rest are the risk-free arbitrages
    const fvType = typeOf('fv');
    const all = s.active.map((h, i) => [h, i]);
    const fvs = all.filter(([h]) => h.type === 'fv');
    const arbs = all.filter(([h]) => h.type !== 'fv');
    const tile = (l, v, sub = '') => `<div class="kpi"><span class="k-l">${l}</span><span class="k-v">${v}</span><span class="k-s">${sub}</span></div>`;
    $('anLive').innerHTML = `
      <div class="panel res-head">
        <div class="res-title"><h3>Live scan ${m ? `· expiry ${dayShort(m.expiry)}` : ''}</h3>
          <span class="muted small">${st.ok ? `last scan ${window.app.istClock(st.at)}` : esc(st.reason || 'waiting')}${st.ok && st.reason ? ' · ' + esc(st.reason) : ''}${m ? ` · ${m.minutes} min of samples` : ''}</span></div>
        ${m ? `<div class="kpis">
          ${tile('Nifty / forward', num(m.spot, 1), `forward ${num(m.forward, 1)} · basis ${num(m.basis, 1)}`)}
          ${tile('ATM IV', m.atmIv == null ? '—' : m.atmIv + '%', `at 09:20 ${m.dayIv ?? '—'}%`)}
          ${tile('Skew (RR 4)', m.rr == null ? '—' : num(m.rr, 1), 'OTM put IV − OTM call IV')}
          ${tile('IV / RV', m.ivrv == null ? '—' : num(m.ivrv) + '×', `5-day realised ${m.rv5 ?? '—'}%`)}
          ${tile('Active now', s.active.length, `${s.log.length} logged today`)}
        </div>` : ''}
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Firing now</h3><span class="muted small">re-evaluated every 5 s · IV figures use trading time</span></div>
        ${arbs.length ? `<div class="tbl-wrap"><table class="grid-tbl an-tbl"><thead><tr><th class="l">Anomaly</th><th>Strike</th><th>Dir</th><th>Size</th><th class="l">Detail</th><th class="l">Suggested trade</th><th></th></tr></thead>
          <tbody>${arbs.map(([h, i]) => hitRow(h, i, 'active', false)).join('')}</tbody></table></div>` : '<div class="muted pad">No arbitrage firing with the current thresholds.</div>'}
      </div>
      ${fvType && s.config?.enabled?.fv !== false ? `<div class="panel">
        <div class="chart-head"><h3>Fair value deviations</h3><span class="muted small">options priced away from fair value now · biggest deviation first · ${fvs.length} found</span></div>
        ${fvs.length ? `<div class="tbl-wrap"><table class="grid-tbl an-tbl"><thead><tr><th class="l">Option</th><th>Status</th><th title="Price you can trade at: the bid when selling a rich option, the ask when buying a cheap one">Market</th><th title="Black-76 price on the chain's forward at the volatility of the neighbouring strikes">Fair value</th><th>Deviation</th><th>%</th><th title="Implied volatility at the market price vs the neighbouring strikes">IV vs fair IV</th><th title="Lots that can be filled at that price">Fillable</th><th class="l">How to benefit</th><th></th></tr></thead>
          <tbody>${fvs.map(([h, i]) => fvRow(h, i)).join('')}</tbody></table></div>` : '<div class="muted pad">Every option within the scanned strikes is at its fair value (within the thresholds on the left).</div>'}
        <div class="an-benefit small"><b>How to benefit:</b> ${esc(fvType.how)}</div>
      </div>` : ''}
      <div class="panel">
        <div class="chart-head"><h3>Today's log</h3><span class="muted small">each anomaly once per cooldown · saved to bt-data/anomaly-log/</span></div>
        ${s.log.length ? `<div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Time</th><th class="l">Anomaly</th><th>Strike</th><th>Dir</th><th>Size</th><th class="l">Detail</th><th class="l">Suggested trade</th><th></th></tr></thead>
          <tbody>${s.log.map((h, i) => hitRow(h, i, 'log', true)).join('')}</tbody></table></div>` : '<div class="muted pad">No anomalies logged today yet (logging runs during market hours).</div>'}
      </div>`;
  }

  // Strategy from a concrete hit: its suggested legs with "signal" / ATM strikes, so it also backtests.
  const hitStrategy = (h) => strategyFor(h.type, h.dir, h.side, h.template?.legs || h.legs);
  $('anLive').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-list]');
    if (!b || !liveState) return;
    const h = liveState[b.dataset.list][Number(b.dataset.dep ?? b.dataset.hbt)];
    if (!h) return;
    if (b.dataset.dep != null) { BT.emit('deploy', { strategy: hitStrategy(h), hit: { type: h.type, strike: h.strike, ref: h.ref, side: h.side, dir: h.dir, text: h.text } }); window.app.setView('lib'); }
    else BT.emit('open-backtest', { strategy: hitStrategy(h), run: false });
  });

  // ---------- history scan ----------
  function renderScanOpts() {
    $('anScanOpts').innerHTML = `<div class="set-row">
      <span class="lbl">Scan window</span><input type="time" data-o="start" value="${scanOpts.start}" step="60"><span class="muted">→</span><input type="time" data-o="end" value="${scanOpts.end}" step="60">
      <span class="lbl">Every</span><select data-o="step">${[1, 2, 3, 5, 10].map((x) => `<option value="${x}" ${Number(scanOpts.step) === x ? 'selected' : ''}>${x} min</option>`).join('')}</select>
      <span class="muted small">Outcomes: the suggested trade entered at the next minute's open and held 5 / 15 / 30 / 60 minutes or to the end of the window — before costs, no stops. Period, expiries and lot size come from the bar above.</span></div>`;
    if (!scan) $('anHistRes').innerHTML = `<div class="panel empty"><h3>How often does each anomaly happen, and does it pay?</h3>
      <p>Tick the types on the left, choose a period above and press <b>Scan history</b>. The first scan of a period downloads the option candles it needs (strikes around the Nifty path); later scans are instant.</p>
      <p class="muted">Use <b>Backtest as strategy</b> on a type for a full simulation with stops, costs and re-entries.</p></div>`;
  }
  $('anScanOpts').addEventListener('change', (e) => {
    const k = e.target.dataset.o;
    if (!k) return;
    scanOpts[k] = k === 'step' ? Number(e.target.value) : e.target.value;
    BT.store.set('anScanOpts', scanOpts);
  });

  async function runScan() {
    let o;
    try { o = settings.get(); } catch (e) { $('anHistRes').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; return; }
    const sel = types().filter((t) => cfg?.enabled[t.id]).map((t) => ({ id: t.id, params: cfg.params[t.id] || {} }));
    if (!sel.length) { $('anHistRes').innerHTML = '<div class="panel empty err">Tick at least one anomaly type on the left.</div>'; return; }
    settings.setBusy(true);
    const t0 = performance.now();
    try {
      const job = await BT.runJob('/api/bt/scan', { from: o.from, to: o.to, expiries: o.expiries, lotSize: o.lotSize, types: sel, ...scanOpts }, settings.progress);
      scan = job.result;
      scan.ms = performance.now() - t0;
      hitFilter = 'all';
      renderScan();
    } catch (e) {
      $('anHistRes').innerHTML = `<div class="panel empty err"><b>Scan failed:</b> ${esc(e.message)}</div>`;
    } finally {
      settings.setBusy(false);
    }
  }

  function renderScan() {
    const r = scan;
    const H = r.horizons;
    const hl = (h) => (h === 'eod' ? 'to end' : h + 'm');
    const rows = r.summary.slice().sort((a, b) => b.hits - a.hits);
    const hours = ['09', '10', '11', '12', '13', '14', '15'];
    const hits = hitFilter === 'all' ? r.hits : r.hits.filter((h) => h.type === hitFilter);
    $('anHistRes').innerHTML = `
      <div class="panel res-head"><div class="res-title"><h3>${r.hitsTotal} anomalies over ${r.days} sessions</h3>
        <span class="muted small">${dayLabel(r.opts.from)} → ${dayLabel(r.opts.to)} · ${r.opts.start}–${r.opts.end} every ${r.opts.step} min · lot ${r.opts.lot} · ${(r.ms / 1000).toFixed(1)} s${r.skipped.length ? ` · ${r.skipped.length} sessions skipped` : ''}</span></div></div>
      <div class="panel">
        <div class="chart-head"><h3>By type</h3><span class="muted small">avg points per 1-lot unit of the suggested trade · win % · ₹ total per lot to the end of the window</span></div>
        <div class="tbl-wrap"><table class="grid-tbl an-sum">
          <thead><tr><th class="l">Anomaly</th><th>Hits</th><th>Days</th><th class="l">Directions</th>${H.map((h) => `<th>${hl(h)}</th>`).join('')}<th>₹ total (to end)</th><th class="l">By hour</th><th></th></tr></thead>
          <tbody>${rows.map((s) => {
            const t = typeOf(s.type);
            const maxH = Math.max(1, ...Object.values(s.hours));
            const best = Object.entries(s.dirs).sort((a, b) => b[1] - a[1])[0]?.[0];
            return `<tr><td class="l"><a href="#" data-f="${s.type}">${esc(t?.name || s.type)}</a></td><td>${s.hits}</td><td>${s.days}</td>
              <td class="l small">${Object.entries(s.dirs).map(([d, n]) => `${esc(d)} ${n}`).join(' · ')}</td>
              ${H.map((h) => { const b = s.horizons[h]; return b ? `<td class="${cls(b.avgPts)}">${num(b.avgPts)}<span class="muted small"> · ${Math.round(b.winRate)}%</span></td>` : '<td class="muted">—</td>'; }).join('')}
              <td class="${cls(s.horizons.eod?.totalInr)} b">${s.horizons.eod ? inrS(s.horizons.eod.totalInr) : '—'}</td>
              <td class="l"><div class="hours">${hours.map((hr) => `<i style="height:${(((s.hours[hr] || 0) / maxH) * 100).toFixed(0)}%" title="${hr}:00 — ${s.hours[hr] || 0} hits"></i>`).join('')}</div></td>
              <td><button class="btn-sm ghost" data-sbt="${s.type}" data-dir="${esc(best || '')}">Backtest ▸</button></td></tr>`;
          }).join('') || `<tr><td colspan="${H.length + 7}" class="muted l">No anomalies with these thresholds — loosen them on the left.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Occurrences</h3>
          <select id="anHitFilter"><option value="all">All types</option>${rows.map((s) => `<option value="${s.type}" ${hitFilter === s.type ? 'selected' : ''}>${esc(typeOf(s.type)?.name || s.type)}</option>`).join('')}</select>
          <span class="muted small">${hits.length > 400 ? 'latest 400 of ' + hits.length : hits.length} shown</span></div>
        <div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Day</th><th>Time</th><th class="l">Anomaly</th><th>Strike</th><th>Dir</th><th>Size</th><th class="l">Detail</th><th>ATM IV</th>${H.map((h) => `<th>${hl(h)}</th>`).join('')}<th>Best / worst</th></tr></thead>
          <tbody>${hits.slice(-400).reverse().map((h) => `<tr><td>${dayShort(h.day)}</td><td>${h.time}</td><td class="l">${esc(typeOf(h.type)?.name || h.type)}</td>
            <td>${h.strike}${h.side ? ' ' + h.side : ''}</td><td><span class="dir-pill">${esc(h.dir)}</span></td><td>${fmtVal(h)}</td><td class="l wrap">${esc(h.text)}</td><td>${h.atmIv ?? '—'}</td>
            ${H.map((x) => { const v = h.out?.[x]; return v == null ? '<td class="muted">—</td>' : `<td class="${cls(v)}">${num(v)}</td>`; }).join('')}
            <td class="small">${h.out ? `<span class="pos">${num(h.out.best)}</span> / <span class="neg">${num(h.out.worst)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>
      </div>`;
  }
  $('anHistRes').addEventListener('click', (e) => {
    const a = e.target.closest('[data-f]');
    if (a) { e.preventDefault(); hitFilter = a.dataset.f; renderScan(); return; }
    const b = e.target.closest('[data-sbt]');
    if (b) {
      const t = typeOf(b.dataset.sbt);
      const h = scan.hits.find((x) => x.type === t.id && x.dir === b.dataset.dir);
      openBacktest(t.id, b.dataset.dir || t.dirs[0], t.sided ? h?.side || 'CE' : null);
    }
  });
  $('anHistRes').addEventListener('change', (e) => { if (e.target.id === 'anHitFilter') { hitFilter = e.target.value; renderScan(); } });

  window.addEventListener('viewchange', (e) => { if (e.detail === 'an') init(); else clearTimeout(liveTimer); });
  if (window.app.state.view === 'an') init();
})();
