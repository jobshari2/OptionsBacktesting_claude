// "Market Pulse" screen: renders the live market read computed on the server (state.pulse). Its Nifty chart is the
// Chain screen's (chain-chart.js mounts it on #pulseChart).
(function () {
  const $ = (id) => document.getElementById(id);
  const { state, compact, istClock, esc } = window.app;
  const ACT = { 'long-buildup': 'Long build-up', 'short-buildup': 'Writing', 'short-covering': 'Short covering', 'long-unwinding': 'Unwinding' };
  const pts = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(0)}`);
  const cls = (n) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');

  function tile(label, value, note, valueCls = '') {
    return `<div class="st"><span class="s">${label}</span><span class="v ${valueCls}">${value}</span><span class="n">${note}</span></div>`;
  }

  function renderHead(p) {
    $('pHeadline').textContent = p.headline;
    $('pBias').className = `bias-pill ${p.bias}`;
    $('pBias').textContent = p.bias;
    const names = { trend: 'Trend', 'OI build-up': 'Option writers/buyers', 'order flow': 'Order flow' };
    const all = ['trend', 'OI build-up', 'order flow'];
    $('pVotes').innerHTML = all
      .map((w) => {
        const v = p.votes.find((x) => x.what === w);
        return v ? `<span class="vote ${v.dir > 0 ? 'up' : 'down'}">${names[w]} ${v.dir > 0 ? '▲' : '▼'}</span>` : `<span class="vote">${names[w]} –</span>`;
      })
      .join('');

    const t = p.trend;
    const st = p.straddle;
    const vol = p.vol;
    $('pTiles').innerHTML = [
      tile('5 min', pts(t.chg[5]), 'Nifty pts', cls(t.chg[5])),
      tile('15 min', pts(t.chg[15]), t.accelerating ? 'accelerating' : t.reversing ? 'reversing' : t.stalling ? 'pausing' : 'Nifty pts', cls(t.chg[15])),
      tile('30 min', pts(t.chg[30]), 'Nifty pts', cls(t.chg[30])),
      tile('60 min', pts(t.chg[60]), t.dayLow != null ? `day ${t.dayLow.toFixed(0)}–${t.dayHigh.toFixed(0)}` : 'Nifty pts', cls(t.chg[60])),
      tile('1-min move', vol.now == null ? '—' : vol.now.toFixed(1), vol.before ? `was ${vol.before.toFixed(1)} pts` : 'pts (RMS)'),
      tile(
        'ATM straddle',
        st.now ? st.now.value.toFixed(0) : '—',
        st.chg30 == null ? '' : `${st.chg30 > 0 ? '+' : ''}${st.chg30.toFixed(1)}% in 30m`,
        cls(st.chg30),
      ),
      tile('ATM IV', p.iv.now == null ? '—' : p.iv.now.toFixed(1), p.iv.ago30 == null ? '' : `${pts(p.iv.now - p.iv.ago30)} vs 30m ago`),
      tile(
        'Order flow',
        p.flow ? `${p.flow.bullShare.toFixed(0)}% bull` : '—',
        p.flow ? `last 1m · ${p.flow.mode}` : 'waiting',
        p.flow ? cls(p.flow.bullShare - 50) : '',
      ),
    ].join('');
    $('pTiles').style.gridTemplateColumns = 'repeat(5, minmax(100px, 1fr))';
    $('pTiles').insertAdjacentHTML(
      'beforeend',
      [
        tile(
          'Order book',
          p.book ? `${p.book.bullShare.toFixed(0)}% bull` : '—',
          p.book
            ? p.book.chg5 != null
              ? `${p.book.chg5 >= 0 ? '+' : ''}${p.book.chg5.toFixed(1)} vs 5m · info only`
              : 'waiting qty · info only'
            : 'needs tick feed',
        ),
        tile('ATM spread', p.book?.atmSpreadPct != null ? `${p.book.atmSpreadPct.toFixed(2)}%` : '—', 'ask − bid, % of price'),
      ].join(''),
    );
  }

  function renderBullets(p) {
    $('pBullets').innerHTML = p.bullets.map((b) => `<li>${esc(b)}</li>`).join('');
    $('pAsOf').textContent = `as of ${istClock(p.t)} · ${p.coverMin} min of history`;
  }

  function renderOi(p) {
    $('pOiTitle').textContent = `Option writers & buyers · last ${p.oi.windowMin} min`;
    if (!p.oi.ready) {
      $('pOiBody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:left">Needs ${p.oi.windowMin} minutes of history.</td></tr>`;
      return;
    }
    const atm = p.oi.buildup.reduce((b, r) => (Math.abs(r.strike - p.spot) < Math.abs(b.strike - p.spot) ? r : b), p.oi.buildup[0])?.strike;
    const act = (x) => (x?.cls ? `<span class="act ${x.cls}">${ACT[x.cls]}</span>` : '<span class="muted">—</span>');
    const doi = (x) => (x ? `<span class="${cls(x.doi)}">${x.doi > 0 ? '+' : ''}${compact(x.doi)}</span>` : '—');
    const px = (x) => (x ? `${x.ltpFrom.toFixed(1)} → ${x.ltp.toFixed(1)}` : '—');
    $('pOiBody').innerHTML = [...p.oi.buildup]
      .reverse()
      .map(
        (r) => `<tr class="${r.strike === atm ? 'atm' : ''}">
      <td>${act(r.CE)}</td><td>${doi(r.CE)}</td><td>${px(r.CE)}</td>
      <td class="k">${r.strike}</td>
      <td>${px(r.PE)}</td><td>${doi(r.PE)}</td><td style="text-align:left">${act(r.PE)}</td>
    </tr>`,
      )
      .join('');
  }

  function renderLevels(p) {
    const l = p.levels;
    $('pRange').textContent = p.trend.dayLow != null ? `day range ${p.trend.dayLow.toFixed(0)}–${p.trend.dayHigh.toFixed(0)}` : '';
    $('pNearest').innerHTML = window.app.nearestLevelsHtml(p.spot);
    const list = (a) => a.map((x) => `${x.strike} <span class="muted">(${x.added > 0 ? '+' : ''}${compact(x.added)})</span>`).join(', ');
    $('pLevels').innerHTML = `
      <span class="lk">Fresh call writing</span><span>${l.resistance ? `${l.resistance.strike} <span class="muted">+${compact(l.resistance.doi)} in ${p.oi.windowMin}m</span>` : '—'}</span>
      <span class="lk">Fresh put writing</span><span>${l.support ? `${l.support.strike} <span class="muted">+${compact(l.support.doi)} in ${p.oi.windowMin}m</span>` : '—'}</span>
      <span class="lk">Largest call OI</span><span>${l.maxCe.strike} <span class="muted">(${compact(l.maxCe.oi)})</span></span>
      <span class="lk">Largest put OI</span><span>${l.maxPe.strike} <span class="muted">(${compact(l.maxPe.oi)})</span></span>
      <span class="lk">Calls added today</span><span>${list(l.addedCe)}</span>
      <span class="lk">Puts added today</span><span>${list(l.addedPe)}</span>`;
  }

  window.onPulseRender = () => {
    if (state.view !== 'pulse') return;
    const p = state.pulse;
    if (!p) {
      $('pHeadline').textContent = 'Collecting data…';
      return;
    }
    renderHead(p);
    renderBullets(p);
    renderOi(p);
    renderLevels(p);
  };

  // The one-line pulse on the chain screen opens this screen.
  document.getElementById('pulseLine').addEventListener('click', () => {
    window.app.setView('pulse');
  });
})();
