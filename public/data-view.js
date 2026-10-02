// Data screen: what history Upstox provides, what is cached locally, and a bulk prefetch.
(() => {
  const { $, esc, dayLabel, dayShort } = BT;
  let inited = false;
  let busy = false;

  const mb = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';

  async function render() {
    let cache = null;
    try { cache = await BT.api('/api/bt/cache'); } catch {}
    const cal = BT.meta.calendar;
    const exp = cal?.expired || [];
    const monthly = new Set(cal?.monthly || []);
    const cached = new Map((cache?.expiries || []).map((e) => [e.expiry, e.contracts]));
    const maxC = Math.max(1, ...cached.values());
    const byYear = {};
    for (const e of exp) (byYear[e.slice(0, 4)] ||= []).push(e);
    $('dataBody').innerHTML = `
      <section class="panel data-card">
        <h3>Historical data from Upstox</h3>
        ${cal ? `<table class="kv">
          <tr><th>Expired Nifty options</th><td><b>${exp.length} expiries</b>, ${dayLabel(exp[0])} → ${dayLabel(exp[exp.length - 1])} (${exp.filter((e) => monthly.has(e)).length} monthly, ${exp.filter((e) => !monthly.has(e)).length} weekly)</td></tr>
          <tr><th>Resolution</th><td>1-minute OHLC + open interest for every strike (call and put), via <code>/v2/expired-instruments</code></td></tr>
          <tr><th>Nifty 50 &amp; India VIX</th><td>1-minute candles since Jan 2022 via <code>/v3/historical-candle</code></td></tr>
          <tr><th>Live expiries</th><td>${(cal.live || []).slice(0, 6).map(dayShort).join(' · ')}${cal.live.length > 6 ? ' …' : ''} — usable for <b>Deploy live</b>; they become backtestable once expired</td></tr>
          <tr><th>Lot size</th><td>today ${cal.liveLot || '—'}; over this history it went 25 → 75 → 65 ("As traded" takes it from each expiry's contract data). Backtests use a fixed lot by default so years compare fairly.</td></tr>
          <tr><th>Rate limits</th><td>Upstox allows ~500 requests/min and 2,000 per 30 min. One request downloads a contract's whole last month, so a 6-month ATM straddle test needs ~300 requests the first time and none after.</td></tr>
        </table>` : `<div class="err">${esc(BT.meta.calError || 'Calendar not loaded — log in to Upstox.')}</div>`}
      </section>
      <section class="panel data-card">
        <h3>Local cache <span class="muted small">bt-cache/</span></h3>
        ${cache ? `<table class="kv">
          <tr><th>Option candles</th><td><b>${cache.options.files.toLocaleString('en-IN')}</b> contracts across ${cache.expiries.length} expiries · ${mb(cache.options.bytes)}</td></tr>
          <tr><th>Index candles</th><td>${cache.index.files} month files · ${mb(cache.index.bytes)}</td></tr>
          <tr><th>In memory</th><td>${cache.memContracts} contracts (fastest re-runs)</td></tr>
          <tr><th>This session</th><td>${cache.api.requests} Upstox requests · ${cache.api.lastMinute} in the last minute</td></tr>
        </table>
        <div class="data-actions"><button class="btn-sm ghost danger" data-clear="options">Clear option cache</button> <button class="btn-sm ghost danger" data-clear="index">Clear index cache</button></div>` : '<div class="muted">—</div>'}
      </section>
      <section class="panel data-card wide">
        <h3>Coverage by expiry <span class="muted small">bar = contracts cached · M = monthly</span></h3>
        <div class="cov">${Object.entries(byYear).reverse().map(([y, es]) => `<div class="cov-year"><span class="muted">${y}</span><div class="cov-row">${es.map((e) => {
          const n = cached.get(e) || 0;
          return `<div class="cov-cell${monthly.has(e) ? ' m' : ''}" title="${dayLabel(e)}${monthly.has(e) ? ' (monthly)' : ''}: ${n} contracts cached"><div class="cov-fill" style="height:${((n / maxC) * 100).toFixed(0)}%"></div><span>${dayShort(e).split(' ')[0]}</span></div>`;
        }).join('')}</div></div>`).join('')}</div>
      </section>
      <section class="panel data-card wide">
        <h3>Prefetch</h3>
        <p class="muted small">Backtests download what they need automatically. To make first runs instant too (or to work offline later), download every strike around the Nifty path for a range of expiries.</p>
        <div class="set-row">
          <span class="lbl">Expiries</span>
          <select id="pfFrom">${exp.map((e) => `<option value="${e}">${dayLabel(e)}</option>`).join('')}</select>
          <span class="muted">→</span>
          <select id="pfTo">${exp.map((e) => `<option value="${e}" ${e === exp[exp.length - 1] ? 'selected' : ''}>${dayLabel(e)}</option>`).join('')}</select>
          <span class="lbl">Strikes</span><span class="muted">±</span><input id="pfBand" class="num" type="number" value="20" min="2" max="80"><span class="muted">around the Nifty range</span>
          <span class="lbl">Days before expiry</span><input id="pfDays" class="num" type="number" value="5" min="0" max="30">
          <button class="btn-sm" id="pfRun" ${busy ? 'disabled' : ''}>Download</button>
        </div>
        <div class="progress hidden" id="pfProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
        <div id="pfMsg" class="muted small"></div>
      </section>`;
    const from = $('pfFrom');
    if (from && exp.length) from.value = exp[Math.max(0, exp.length - 8)];
  }

  async function prefetch() {
    const body = { from: $('pfFrom').value, to: $('pfTo').value, band: Number($('pfBand').value), daysBefore: Number($('pfDays').value) };
    if (body.from > body.to) { $('pfMsg').textContent = 'The first expiry must be before the last.'; return; }
    busy = true;
    $('pfRun').disabled = true;
    const prog = $('pfProg');
    prog.classList.remove('hidden');
    try {
      const job = await BT.runJob('/api/bt/prefetch', body, (p) => {
        prog.querySelector('.fill').style.width = (p.total ? (p.done / p.total) * 100 : 0).toFixed(1) + '%';
        const wait = p.api?.waitingSec ? ` · waiting ${p.api.waitingSec}s for the Upstox rate limit` : '';
        prog.querySelector('.ptext').textContent = `${p.phase} ${p.total ? p.done + '/' + p.total : ''}${p.failed ? ' · ' + p.failed + ' failed' : ''}${wait}`;
      });
      busy = false;
      await render();
      $('pfMsg').textContent = `Done: ${job.result.contracts} contracts for ${job.result.expiries} expiries${job.result.failed ? `, ${job.result.failed} failed (see logs/errors.log)` : ''}.`;
    } catch (e) {
      busy = false;
      $('pfMsg').textContent = 'Prefetch failed: ' + e.message;
      $('pfRun').disabled = false;
    }
  }

  $('dataBody').addEventListener('click', async (e) => {
    if (e.target.id === 'pfRun') prefetch();
    const what = e.target.dataset.clear;
    if (what && confirm(`Delete the cached ${what} data? It will be downloaded again when needed.`)) {
      await BT.api('/api/bt/cache/clear', { what });
      render();
    }
  });

  function init() {
    if (!inited) { inited = true; BT.on('meta', () => { if (!busy) render(); }); }
    if (!busy) render();
  }
  window.addEventListener('viewchange', (e) => { if (e.detail === 'data') init(); });
  if (window.app.state.view === 'data') init();
})();
