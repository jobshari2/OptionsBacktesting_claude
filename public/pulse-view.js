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

  // ---------- paper trades of the idea (pulse-signals.js) ----------
  // Bought at the ask + slippage, sold at the bid, net of charges, per lot. Today's come live with the pulse; earlier days
  // are the saved files (<events>/<day>/pulse-signals.jsonl), picked in the date box and read once.
  const rs = (n) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  const istDay = (t) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
  let days = []; // saved days with their totals, newest first: { day, n, wins, pnl, open }
  let daysKey = '';
  let picked = null; // the day shown in the ledger; null = today (live)
  const saved = new Map(); // day -> that day's saved trades
  let daysBusy = false;

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  // The list of saved days: read when the screen first shows and whenever today's ledger has changed.
  async function loadDays(today) {
    if (daysBusy) return;
    daysBusy = true;
    try {
      days = (await getJson('/api/pulse/days')).days;
      if (today && !days.some((d) => d.day === today)) days = [{ day: today, n: 0, wins: 0, pnl: 0, open: 0 }, ...days];
      renderDays(today);
      renderLedger(today);
    } catch (e) {
      $('pDays').innerHTML = `<div class="muted small pad">Could not read the saved signals: ${esc(e.message)}</div>`;
    } finally {
      daysBusy = false;
    }
  }

  // The date box and the per-day profit / loss list under "What's happening".
  function renderDays(today) {
    const want = picked || today;
    const key = days.map((d) => `${d.day}|${d.n}|${d.pnl}|${d.open}`).join(',') + `@${today}@${want}`;
    if (key === daysKey) return;
    daysKey = key;
    const sel = $('pDay');
    sel.innerHTML = days
      .map((d) => `<option value="${d.day}">${d.day}${d.day === today ? ' · today (live)' : ''} · ${d.n} trade${d.n === 1 ? '' : 's'} · ${rs(d.pnl)}</option>`)
      .join('');
    if (days.some((d) => d.day === want)) sel.value = want;
    const tot = days.reduce((a, d) => ({ n: a.n + d.n, wins: a.wins + d.wins, pnl: a.pnl + d.pnl }), { n: 0, wins: 0, pnl: 0 });
    $('pDays').innerHTML = days.length
      ? `<table class="p-oi p-days-tbl"><thead><tr><th>Day</th><th>Trades</th><th>Won</th><th>Net P&amp;L</th></tr></thead><tbody>${days
          .map(
            (d) =>
              `<tr data-day="${d.day}" class="${d.day === want ? 'on' : ''}"><td>${d.day}${d.day === today ? ' <span class="muted">today</span>' : ''}</td><td>${d.n}${d.open ? ` <span class="muted">+${d.open} open</span>` : ''}</td><td>${d.wins}</td><td class="${cls(d.pnl)}"><b>${rs(d.pnl)}</b></td></tr>`,
          )
          .join(
            '',
          )}</tbody><tfoot><tr><td>All days</td><td>${tot.n}</td><td>${tot.wins}</td><td class="${cls(tot.pnl)}"><b>${rs(tot.pnl)}</b></td></tr></tfoot></table>`
      : '<div class="muted small pad">No saved signals yet — they are written to pulse-signals.jsonl while the market is open.</div>';
  }

  // Rows of the ledger for the picked day, newest first. Today's come live with the pulse, unless the saved file holds more
  // finished trades than the server's memory does (a restart empties it): then the file is the better record.
  const failed = new Map(); // day -> why its file could not be read
  const fetching = new Set();
  function fetchDay(day) {
    if (fetching.has(day)) return;
    fetching.add(day);
    getJson(`/api/pulse/signals?day=${day}`)
      .then((d) => saved.set(day, d))
      .catch((e) => failed.set(day, e.message))
      .finally(() => {
        fetching.delete(day);
        renderLedger(todayNow());
      });
  }

  function ledgerRows(today) {
    const day = picked || today;
    const live = state.pulse?.trades;
    const inFile = days.find((d) => d.day === today)?.n ?? 0;
    if (day === today && live && live.n >= inFile) return [...live.open.map((x) => ({ ...x, open: true })), ...[...live.closed].reverse()];
    if (failed.has(day)) return { error: failed.get(day) };
    const s = saved.get(day);
    if (!s) {
      fetchDay(day);
      return null;
    }
    return [...s.trades].reverse();
  }

  function renderLedger(today) {
    const day = picked || today;
    const rows = ledgerRows(today);
    const el = $('pLedger');
    if (!rows || rows.error) $('pDaySum').innerHTML = '';
    if (!rows) {
      el.innerHTML = '<div class="muted small">Loading…</div>';
      return;
    }
    if (rows.error) {
      el.innerHTML = `<div class="muted small">Could not load ${day}: ${esc(rows.error)}</div>`;
      return;
    }
    const done = rows.filter((x) => !x.open && x.pnl != null);
    const pnl = done.reduce((a, x) => a + x.pnl, 0);
    const wins = done.filter((x) => x.pnl > 0).length;
    $('pDaySum').innerHTML = `<span class="${cls(pnl)}"><b>${done.length ? `${wins}/${done.length} won · ${rs(pnl)}` : 'no finished trades'}</b></span>`;
    const row = (x) =>
      `<tr><td>${istClock(x.t)}</td><td>${x.side} ${x.strike}</td><td>${x.px.toFixed(1)} → ${x.open ? `<span class="muted">target ${x.target.toFixed(1)} / stop ${x.stop.toFixed(1)}</span>` : x.exitPx == null ? '—' : x.exitPx.toFixed(1)}</td><td>${x.open ? 'open' : x.reason}</td><td class="${x.open || x.pnl == null ? '' : cls(x.pnl)}">${x.open || x.pnl == null ? '' : rs(x.pnl)}</td></tr>`;
    el.innerHTML = rows.length
      ? `<table class="p-oi pp-tbl"><tbody>${rows.map(row).join('')}</tbody></table>`
      : `<div class="muted small">${day === today ? 'No paper trades yet today.' : 'No trades saved for this day.'}</div>`;
  }

  function pickDay(day, today) {
    picked = day === today ? null : day;
    failed.delete(day);
    renderDays(today); // moves the highlight
    renderLedger(today); // loads the day's file when it is not held yet
  }

  let lastCount = -1;
  function renderTrades(p) {
    const today = istDay(p.t);
    const count = p.trades ? p.trades.n + p.trades.open.length : 0;
    if (count !== lastCount || !days.length) {
      lastCount = count;
      saved.delete(today);
      failed.delete(today);
      loadDays(today); // also redraws the ledger
    } else renderLedger(today);
  }

  const todayNow = () => istDay(state.pulse?.t ?? Date.now());
  $('pDay').addEventListener('change', (e) => pickDay(e.target.value, todayNow()));
  $('pDays').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-day]');
    if (tr) pickDay(tr.dataset.day, todayNow());
  });

  // "Trade idea": call or put, and which strike, for a quick rise in the option's price.
  function renderPlay(p) {
    const el = $('pPlay');
    const y = p.play;
    if (!y) {
      el.innerHTML = '';
      return;
    }
    const f = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
    const word =
      y.action === 'BUY'
        ? `BUY ${y.side === 'CE' ? 'CALL (CE)' : 'PUT (PE)'}`
        : y.action === 'WATCH'
          ? `WATCH ${y.leanSide === 'CE' ? 'CALLS' : 'PUTS'}`
          : 'WAIT — no trade';
    const kind = y.action === 'BUY' ? (y.side === 'CE' ? 'buy-ce' : 'buy-pe') : y.action === 'WATCH' ? 'watch' : '';
    const k = y.pick;
    const strikeBlock =
      k && y.action !== 'WAIT'
        ? `<div class="pp-grid">
        <span class="lk">Strike</span><span><b>${k.strike} ${y.side}</b> <span class="muted">(${k.label})</span></span>
        <span class="lk">Price now</span><span>${f(k.ltp)} <span class="muted">· bid ${f(k.bid)} / ask ${f(k.ask)}${k.spreadPct != null ? ` · spread ${f(k.spreadPct)}%` : ''}</span></span>
        <span class="lk">Why this strike</span><span>${k.why.length ? esc(k.why.join('; ')) : 'closest to the money — moves most for the premium paid'}</span>
        <span class="lk">Nifty target</span><span>${f(k.niftyTarget, 0)} <span class="muted">→ option ≈ ${f(k.premiumTarget)}${k.targetCapped ? ` · wall at ${k.targetCapped} may cap it` : ''}</span></span>
        <span class="lk">Exit if Nifty</span><span>${y.side === 'CE' ? 'falls below' : 'rises above'} ${f(k.niftyStop, 0)} <span class="muted">→ option ≈ ${f(k.premiumStop)}</span></span>
      </div>`
        : '';
    el.innerHTML = `
      <div class="pp-head"><span class="muted small">TRADE IDEA · quick move in option price</span><span class="pp-call ${kind}">${word}</span></div>
      ${y.happening.length ? `<div><span class="lk">What’s happening: </span>${y.happening.map(esc).join(' ')}</div>` : ''}
      ${strikeBlock}
      ${y.reasons.length ? `<ul class="${y.action === 'BUY' ? '' : 'pp-warn'}">${y.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="muted small">Rule-based read of trend, writers/buyers and order flow — <b>no proven edge</b>: replays on the recorded days did not make money after costs (run <code>node pulse-backtest.js</code>). Judge it by the paper record below, saved day by day to <code>pulse-signals.jsonl</code> in the events folder. Option buying loses fast if the move stalls.</div>`;
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
    renderPlay(p);
    renderTrades(p);
    renderLevels(p);
  };

  // The one-line pulse on the chain screen opens this screen.
  document.getElementById('pulseLine').addEventListener('click', () => {
    window.app.setView('pulse');
  });
})();
