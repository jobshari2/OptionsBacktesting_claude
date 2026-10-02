// Strategies screen: ready-made + saved strategies as cards, and "Deploy" — the strategy resolved on the
// live option chain for an upcoming expiry, with payoff, greeks and breakevens. Strikes can be nudged and
// the result saved back as a relative strategy (ATM offsets), so it applies to every future expiry.
(() => {
  const { $, esc, inr, inrS, kinr, num, cls, dayShort, bs, ncdf } = BT;
  let cat = BT.store.get('libCat', 'All');
  let dep = null; // { strategy, live, legs, shift, pricing, daysAhead }
  let inited = false;

  function init() {
    if (inited) return;
    inited = true;
    BT.on('meta', renderCards);
    if (BT.meta.loaded) renderCards();
    renderDeployEmpty();
  }

  // ---------- cards ----------
  function renderCards() {
    const cats = ['All', 'My strategies', ...new Set(BT.meta.library.map((s) => s.category))];
    if (!cats.includes(cat)) cat = 'All';
    $('libCats').innerHTML = cats.map((c) => `<button data-c="${esc(c)}" class="${c === cat ? 'on' : ''}">${esc(c)}${c === 'My strategies' ? ` (${BT.meta.saved.length})` : ''}</button>`).join('');
    const q = $('libSearch').value.trim().toLowerCase();
    let list = cat === 'All' ? [...BT.meta.saved, ...BT.meta.library] : cat === 'My strategies' ? BT.meta.saved : BT.meta.library.filter((s) => s.category === cat);
    if (q) list = list.filter((s) => (s.name + ' ' + s.desc + ' ' + s.category).toLowerCase().includes(q));
    $('libCards').innerHTML = list.map((s) => {
      const mine = s.id?.startsWith('my-');
      return `<div class="lib-card" data-id="${s.id}">
        <div class="lc-head"><span class="cat-pill c-${esc((mine ? 'mine' : s.category).toLowerCase())}">${mine ? 'Mine' : esc(s.category)}</span><b>${esc(s.name)}</b>${s.edited ? '<span class="cat-pill c-mine" title="You edited this built-in strategy">edited</span>' : ''}${s.entry?.when === 'signal' ? '<span class="cat-pill c-signal" title="Enters on a signal">signal</span>' : ''}</div>
        <div class="lc-body">
          <div class="lc-text"><div class="muted small">${esc(s.desc || '')}</div><div class="lc-legs">${BT.legChips(s)}</div></div>
          ${miniPayoff(s)}
        </div>
        <div class="lc-time muted small">${esc(BT.timingLabel(s))}</div>
        <div class="lc-actions">
          <button class="btn-sm" data-act="bt">Backtest</button>
          <button class="btn-sm ghost" data-act="edit">${mine ? 'Edit' : 'Customise'}</button>
          <button class="btn-sm ghost" data-act="deploy">Deploy live</button>
          ${mine ? '<button class="btn-sm ghost danger" data-act="del" title="Delete">✕</button>' : ''}
          ${s.edited ? '<button class="btn-sm ghost" data-act="reset" title="Restore the original built-in strategy">Reset</button>' : ''}
        </div>
      </div>`;
    }).join('') || `<div class="panel empty">${cat === 'My strategies' ? 'No saved strategies yet. Customise a ready-made one (or build one in Backtest) and press Save — it can then be backtested or deployed on any expiry.' : 'Nothing matches.'}</div>`;
  }

  // Schematic payoff at the near expiry: spot 100, 0.2-point strike step (≈ Nifty 50 / 25,000), 14% vol, 4 days.
  function miniPayoff(s) {
    const S0 = 100;
    const v = 0.14;
    const T = 4 / 365;
    const step = 0.2;
    const solveK = (call, f) => { // strike where f(K) crosses 0, searching OTM
      let lo = S0;
      let hi = call ? S0 * 1.3 : S0 * 0.7;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    const legs = s.legs.map((l) => {
      const call = l.type === 'CE';
      const otm = call ? 1 : -1;
      const val = l.strike.value;
      let K;
      switch (l.strike.by) {
        case 'atm': K = S0 + otm * step * val; break;
        case 'pct': K = S0 * (1 + (otm * val) / 100); break;
        case 'pts': K = S0 + (otm * val) / 250; break;
        case 'straddle': K = S0 + otm * (val || 1) * 2 * bs(S0, S0, T, v, true); break;
        case 'premium': K = solveK(call, (k) => bs(S0, k, T, v, call) - val / 250); break;
        case 'delta': {
          const d = Math.abs(val > 1 ? val / 100 : val);
          K = solveK(call, (k) => Math.abs(ncdf((Math.log(S0 / k) + (v * v / 2) * T) / (v * Math.sqrt(T))) - (call ? 0 : 1)) - d);
          break;
        }
        default: K = S0;
      }
      const far = l.expiry === 'next' || l.expiry === 'mnext' || (s.expiry === 'weekly' && l.expiry === 'mcur');
      const Tl = far ? T + 7 / 365 : T;
      return { call, K, q: (l.action === 'B' ? 1 : -1) * l.lots, p: bs(S0, K, Tl, v, call), far };
    });
    const xs = Array.from({ length: 61 }, (_, i) => S0 * (0.96 + (0.08 * i) / 60));
    const ys = xs.map((x) => legs.reduce((sum, l) => sum + l.q * ((l.far ? bs(x, l.K, 7 / 365, v, l.call) : Math.max(0, l.call ? x - l.K : l.K - x)) - l.p), 0));
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const W = 120;
    const H = 56;
    const X = (i) => (i / 60) * W;
    const Y = (y) => H - 4 - ((y - lo) / (hi - lo || 1)) * (H - 8);
    const pts = ys.map((y, i) => `${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const z = Y(0).toFixed(1);
    return `<svg class="mini-pay" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs><clipPath id="up-${s.id}"><rect x="0" y="0" width="${W}" height="${z}"/></clipPath><clipPath id="dn-${s.id}"><rect x="0" y="${z}" width="${W}" height="${H}"/></clipPath></defs>
      <polygon points="0,${z} ${pts} ${W},${z}" fill="rgba(63,182,139,.25)" clip-path="url(#up-${s.id})"/>
      <polygon points="0,${z} ${pts} ${W},${z}" fill="rgba(240,113,107,.22)" clip-path="url(#dn-${s.id})"/>
      <line x1="0" x2="${W}" y1="${z}" y2="${z}" stroke="var(--line)"/>
      <line x1="${W / 2}" x2="${W / 2}" y1="0" y2="${H}" stroke="var(--line)" stroke-dasharray="2 2"/>
      <polyline points="${pts}" fill="none" stroke="var(--text)" stroke-width="1.4"/></svg>`;
  }

  $('libCats').addEventListener('click', (e) => { if (e.target.dataset.c) { cat = e.target.dataset.c; BT.store.set('libCat', cat); renderCards(); } });
  $('libSearch').addEventListener('input', renderCards);
  $('libNew').addEventListener('click', () => BT.emit('open-backtest', { strategy: { ...BT.blankStrategy(), id: null }, run: false }));
  $('libCards').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    const card = e.target.closest('.lib-card');
    if (!b || !card) return;
    const s = BT.findStrategy(card.dataset.id);
    if (!s) return;
    if (b.dataset.act === 'bt') BT.emit('open-backtest', { strategy: s, run: true });
    if (b.dataset.act === 'edit') BT.emit('open-backtest', { strategy: s, run: false });
    if (b.dataset.act === 'deploy') deploy(s, 0);
    if (b.dataset.act === 'del' && confirm(`Delete "${s.name}"?`)) await BT.deleteStrategy(s.id);
    if (b.dataset.act === 'reset' && confirm(`Restore the original "${s.name}"? Your edits will be discarded.`)) await BT.resetStrategy(s.id);
  });

  // ---------- live deployment ----------
  function renderDeployEmpty() {
    $('libDeploy').innerHTML = `<div class="empty-in"><h3>Deploy on the live chain</h3>
      <p class="muted">Press <b>Deploy live</b> on any strategy to see exactly which strikes it would trade on an upcoming expiry, at today's prices: payoff, breakevens, greeks and margin.</p>
      <p class="muted">Strategies are stored relative to the market (ATM offsets, premium, delta), so a saved strategy works for every future expiry.</p></div>`;
  }

  async function deploy(strategy, shift, hit = dep?.hit || null) {
    $('libDeploy').innerHTML = `<div class="empty-in muted">Resolving ${esc(strategy.name)} on the live chain…</div>`;
    $('libDeploy').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    try {
      const live = await BT.api('/api/bt/resolve', { strategy, shift, hit });
      dep = {
        strategy: live.strategy, live, shift, hit, pricing: dep?.pricing || 'ltp', daysAhead: 0,
        legs: live.legs.map((l) => ({ ...l, orig: l.strikeValue })),
      };
      dep.strategy.id = strategy.id;
      renderDeploy();
    } catch (e) {
      $('libDeploy').innerHTML = `<div class="empty-in err"><b>Could not deploy:</b> ${esc(e.message)}<p class="muted small">Deploy needs the live option chain from Upstox.</p></div>`;
    }
  }
  BT.on('deploy', (d) => { init(); dep = null; deploy(d.legs ? d : d.strategy, 0, d.legs ? null : d.hit || null); }); // a strategy, or { strategy, hit }

  const now = () => Date.now();
  const yearsTo = (exp, plusDays = 0) => Math.max(0, (Date.parse(exp + 'T15:30:00+05:30') - now() - plusDays * 86400_000) / (365 * 86400_000));
  function ivOf(l) {
    const q = l.quote;
    if (q?.iv > 0) return q.iv / 100;
    // Solve from LTP if the chain had no IV.
    const S = dep.live.spot;
    const T = yearsTo(l.expiryDate);
    let lo = 0.01;
    let hi = 2;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bs(S, l.strikeValue, T, m, l.type === 'CE') > (q?.ltp || 0)) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  const entryPx = (l) => {
    const q = l.quote || {};
    if (dep.pricing === 'market') return (l.action === 'B' ? q.ask : q.bid) || q.ltp || 0;
    return q.ltp || 0;
  };

  function analyse() {
    const lot = dep.live.lot;
    const S0 = dep.live.spot;
    const legs = dep.legs.map((l) => ({ ...l, q: (l.action === 'B' ? 1 : -1) * l.lots * lot, px: entryPx(l), iv: ivOf(l), call: l.type === 'CE' }));
    const near = legs.reduce((m, l) => (l.expiryDate < m ? l.expiryDate : m), legs[0].expiryDate);
    const daysToNear = Math.max(0, (Date.parse(near + 'T15:30:00+05:30') - now()) / 86400_000);
    const value = (S, plusDays) => legs.reduce((sum, l) => sum + l.q * (bs(S, l.strikeValue, yearsTo(l.expiryDate, plusDays), l.iv, l.call) - l.px), 0);
    const atExpiry = (S) => value(S, daysToNear);
    const atmIv = legs.reduce((s, l) => s + l.iv, 0) / legs.length;
    const sd = S0 * atmIv * Math.sqrt(Math.max(daysToNear, 0.3) / 365);
    const lo = S0 - Math.max(4 * sd, S0 * 0.03);
    const hi = S0 + Math.max(4 * sd, S0 * 0.03);
    const N = 241;
    const xs = Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1));
    const exp = xs.map(atExpiry);
    const t0 = xs.map((x) => value(x, 0));
    const tN = dep.daysAhead > 0 ? xs.map((x) => value(x, Math.min(dep.daysAhead, daysToNear))) : null;
    // Wide grid for max profit / loss and unlimited detection
    const wide = Array.from({ length: 401 }, (_, i) => S0 * (0.5 + i / 400));
    const wv = wide.map(atExpiry);
    const maxP = Math.max(...wv);
    const maxL = Math.min(...wv);
    const edge = (a, b) => Math.abs(a - b) > Math.abs(maxP - maxL) * 0.002;
    const unlimitedP = (wv[400] === maxP && edge(wv[400], wv[399])) || (wv[0] === maxP && edge(wv[0], wv[1]));
    const unlimitedL = (wv[400] === maxL && edge(wv[400], wv[399])) || (wv[0] === maxL && edge(wv[0], wv[1]));
    const be = [];
    for (let i = 1; i < N; i++) if ((exp[i - 1] < 0) !== (exp[i] < 0)) be.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * -exp[i - 1]) / (exp[i] - exp[i - 1]));
    // Probability of finishing in profit (lognormal at the average IV)
    const T = Math.max(daysToNear, 0.3) / 365;
    const cdf = (x) => ncdf(Math.log(x / S0) / (atmIv * Math.sqrt(T)) + (atmIv * Math.sqrt(T)) / 2);
    let pop = 0;
    for (let i = 1; i < wide.length; i++) if ((wv[i] + wv[i - 1]) / 2 > 0) pop += cdf(wide[i]) - cdf(wide[i - 1]);
    const premium = legs.reduce((s, l) => s - l.q * l.px, 0);
    const g = (k) => legs.reduce((s, l) => s + l.q * (l.quote?.[k] ?? 0), 0);
    // Margin estimate (same rule as the backtester)
    const side = (type) => {
      const ls = legs.filter((l) => l.type === type);
      const shortQty = ls.filter((l) => l.q < 0).reduce((s, l) => s - l.q, 0);
      if (!shortQty) return 0;
      let worst = 0;
      for (let k = 0.6; k <= 1.4001; k += 0.01) {
        const S = S0 * k;
        worst = Math.min(worst, ls.reduce((s, l) => s + l.q * (Math.max(0, type === 'CE' ? S - l.strikeValue : l.strikeValue - S) - l.px), 0));
      }
      return Math.min(0.09 * S0 * shortQty, -worst);
    };
    const ce = side('CE');
    const pe = side('PE');
    const margin = Math.max(ce, pe) + 0.3 * Math.min(ce, pe) + legs.filter((l) => l.q > 0).reduce((s, l) => s + l.q * l.px, 0);
    return { legs, xs, exp, t0, tN, maxP, maxL, unlimitedP, unlimitedL, be, pop, premium, margin, daysToNear, near, sd,
      greeks: { delta: g('delta'), gamma: g('gamma'), theta: g('theta'), vega: g('vega') } };
  }

  function renderDeploy() {
    const L = dep.live;
    const a = analyse();
    const exps = L.expiries;
    const s = dep.strategy;
    const chainRows = (e) => L.chains[e] || [];
    $('libDeploy').innerHTML = `
      <div class="dep-head">
        <div><h3>${esc(s.name)}</h3><span class="muted small">Nifty ${num(L.spot)} · lot ${L.lot} · prices refresh on demand</span></div>
        <button class="icon" data-act="close" title="Close">✕</button>
      </div>
      <div class="dep-bar">
        <label title="The expiry that counts as &quot;this week&quot; for the strategy's legs">Deploy for <select id="depShift">${exps.slice(0, 10).map((x, i) => `<option value="${i}" ${i === dep.shift ? 'selected' : ''}>${dayShort(x.e)} ${x.e.slice(0, 4)} · ${x.monthly ? 'monthly' : 'weekly'}${i === 0 ? ' (nearest)' : ''}</option>`).join('')}</select></label>
        <div class="seg sm" id="depPricing"><button data-p="ltp" class="${dep.pricing === 'ltp' ? 'on' : ''}">LTP</button><button data-p="market" class="${dep.pricing === 'market' ? 'on' : ''}" title="Buy at ask, sell at bid">Bid / ask</button></div>
        <button class="btn-sm ghost" data-act="refresh">↻ Refresh</button>
      </div>
      ${depContext(L)}
      <div class="tbl-wrap"><table class="grid-tbl dep-legs">
        <thead><tr><th>Action</th><th>Lots</th><th>Strike</th><th>Expiry</th><th>Price</th><th>Bid / ask</th><th>IV</th><th>Δ</th></tr></thead>
        <tbody>${dep.legs.map((l, i) => {
          const ks = chainRows(l.expiryDate).map((r) => r.strike);
          const ki = ks.indexOf(l.strikeValue);
          const q = l.quote || {};
          return `<tr><td class="${l.action === 'B' ? 'pos' : 'neg'}"><b>${l.action === 'B' ? 'BUY' : 'SELL'}</b> ${l.type}</td>
            <td><input class="num xs" type="number" min="1" max="100" value="${l.lots}" data-lots="${i}"></td>
            <td class="strike-cell"><button class="icon" data-k="${i}" data-d="-1" ${ki <= 0 ? 'disabled' : ''}>−</button><b>${l.strikeValue}</b>${l.strikeValue !== l.orig ? '<span class="muted">*</span>' : ''}<button class="icon" data-k="${i}" data-d="1" ${ki >= ks.length - 1 ? 'disabled' : ''}>+</button></td>
            <td>${dayShort(l.expiryDate)}</td><td><b>${num(entryPx(l))}</b></td><td class="muted">${num(q.bid)} / ${num(q.ask)}</td>
            <td>${num(q.iv, 1)}</td><td>${num(q.delta)}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="dep-kpis">
        <div><span>${a.premium >= 0 ? 'Net credit' : 'Net debit'}</span><b class="${cls(a.premium)}">${inr(Math.abs(a.premium))}</b></div>
        <div><span>Max profit</span><b class="pos">${a.unlimitedP ? 'Unlimited' : inr(a.maxP)}</b></div>
        <div><span>Max loss</span><b class="neg">${a.unlimitedL ? 'Unlimited' : inr(a.maxL)}</b></div>
        <div><span>Breakeven</span><b>${a.be.length ? a.be.map((x) => Math.round(x)).join(' · ') : '—'}</b></div>
        <div><span>Chance of profit</span><b>${(a.pop * 100).toFixed(0)}%</b></div>
        <div><span>Est. margin</span><b>${kinr(a.margin)}</b></div>
        <div><span>Delta</span><b>${num(a.greeks.delta, 1)}</b></div>
        <div><span>Theta / day</span><b class="${cls(a.greeks.theta)}">${inrS(a.greeks.theta)}</b></div>
        <div><span>Vega</span><b>${num(a.greeks.vega, 0)}</b></div>
        <div><span>Gamma</span><b>${num(a.greeks.gamma, 3)}</b></div>
      </div>
      <div class="dep-chart-head"><b>Payoff</b>
        <label class="muted small">Day ahead <input type="range" id="depDays" min="0" max="${Math.max(0, Math.floor(a.daysToNear))}" step="1" value="${Math.min(dep.daysAhead, Math.floor(a.daysToNear))}"> <span id="depDaysV">${dep.daysAhead ? '+' + dep.daysAhead + 'd' : 'today'}</span></label></div>
      <div class="chart-box dep-chart"><canvas id="depChart"></canvas></div>
      <div class="dep-actions">
        <button class="btn-sm" data-act="save" title="Save as a strategy defined relative to ATM, reusable on any expiry">Save as my strategy</button>
        <button class="btn-sm ghost" data-act="bt">Backtest it</button>
        <span class="muted small">* = strike changed from the rule; it is saved as an ATM offset.</span>
      </div>
      <div class="muted small pad">Chance of profit uses a lognormal model at the legs' average IV. Margin is a rough estimate — check with your broker. Not investment advice.</div>`;
    drawPayoff(a);
  }

  // Live entry conditions, the anomaly behind "signal" strikes, and the nearest S/R levels.
  function depContext(L) {
    const parts = [];
    for (const w of L.warnings || []) parts.push(`<div class="dep-warn">⚠ ${esc(w)}</div>`);
    if (L.conditions) {
      parts.push(`<div class="dep-cond ${L.conditions.ok ? 'ok' : 'wait'}"><b>${L.conditions.ok ? '✔ Entry conditions met now' : '… Entry conditions not met yet'}</b>
        <span class="muted small">${L.conditions.notes.map(esc).join(' · ')}</span></div>`);
    }
    if (L.hit) parts.push(`<div class="dep-cond sig"><b>⚡ ${esc(BT.anomalyType(L.hit.type)?.name || L.hit.type)}</b> <span class="muted small">${esc(L.hit.text)}</span></div>`);
    if (L.levels) {
      const lv = (x) => (x ? `${x.price} <span class="muted">(${x.cls})</span>` : '—');
      parts.push(`<div class="dep-lv"><span>Resistance <b>${lv(L.levels.resistance.any)}</b></span><span>Support <b>${lv(L.levels.support.any)}</b></span><span class="muted small">major R ${L.levels.resistance.major?.price ?? '—'} · major S ${L.levels.support.major?.price ?? '—'}</span></div>`);
    }
    return parts.length ? `<div class="dep-ctx">${parts.join('')}</div>` : '';
  }

  const vline = {
    id: 'vline',
    afterDatasetsDraw(chart, _, o) {
      const { ctx, chartArea: ca, scales } = chart;
      for (const m of o.marks || []) {
        const x = scales.x.getPixelForValue(m.x);
        if (x < ca.left || x > ca.right) continue;
        ctx.save();
        ctx.strokeStyle = m.color;
        ctx.setLineDash(m.dash || []);
        ctx.beginPath(); ctx.moveTo(x, ca.top); ctx.lineTo(x, ca.bottom); ctx.stroke();
        ctx.fillStyle = m.color; ctx.font = '10px system-ui'; ctx.fillText(m.label, x + 3, ca.top + 10);
        ctx.restore();
      }
    },
  };

  function drawPayoff(a) {
    const pts = (ys) => a.xs.map((x, i) => ({ x, y: ys[i] }));
    const S0 = dep.live.spot;
    const ds = [
      { label: `At expiry (${dayShort(a.near)})`, data: pts(a.exp), borderColor: '#e6edf3', borderWidth: 1.8, pointRadius: 0,
        fill: { target: 'origin', above: 'rgba(63,182,139,.18)', below: 'rgba(240,113,107,.18)' } },
      { label: 'Today (T+0)', data: pts(a.t0), borderColor: '#58a6ff', borderWidth: 1.4, pointRadius: 0, borderDash: [4, 3] },
    ];
    if (a.tN) ds.push({ label: `+${dep.daysAhead} day${dep.daysAhead > 1 ? 's' : ''}`, data: pts(a.tN), borderColor: '#d6af4c', borderWidth: 1.4, pointRadius: 0 });
    BT.chart($('depChart'), {
      type: 'line',
      data: { datasets: ds },
      plugins: [vline],
      options: {
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { title: (c) => `Nifty ${Math.round(c[0].raw.x)} (${(((c[0].raw.x - S0) / S0) * 100).toFixed(1)}%)`, label: (c) => `${c.dataset.label}: ${inrS(c.raw.y)}` } },
          vline: { marks: [{ x: S0, label: 'spot', color: '#d6af4c' }, { x: S0 - a.sd, label: '−1σ', color: '#8b949e', dash: [2, 3] }, { x: S0 + a.sd, label: '+1σ', color: '#8b949e', dash: [2, 3] }] },
        },
        scales: { x: { type: 'linear', ticks: { callback: (v) => Math.round(v) } }, y: { ticks: { callback: (v) => kinr(v) } } },
      },
    });
  }

  // Convert the deployed legs back into a relative strategy: changed strikes become ATM offsets.
  function asStrategy() {
    const s = BT.clone(dep.strategy);
    s.legs = dep.legs.map((l) => {
      const def = { action: l.action, type: l.type, lots: l.lots, expiry: l.expiry, strike: l.strike, sl: l.sl, tgt: l.tgt, trail: l.trail, re: l.re };
      if (l.strikeValue !== l.orig) {
        const rows = dep.live.chains[l.expiryDate];
        const ks = rows.map((r) => r.strike);
        const atmI = ks.reduce((b, k, j) => (Math.abs(k - dep.live.spot) < Math.abs(ks[b] - dep.live.spot) ? j : b), 0);
        const off = (ks.indexOf(l.strikeValue) - atmI) * (l.type === 'CE' ? 1 : -1);
        def.strike = { by: 'atm', value: off, match: 'closest' };
      }
      return def;
    });
    return s;
  }

  $('libDeploy').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !dep) return;
    if (b.dataset.k != null) {
      const l = dep.legs[Number(b.dataset.k)];
      const rows = dep.live.chains[l.expiryDate];
      const i = rows.findIndex((r) => r.strike === l.strikeValue) + Number(b.dataset.d);
      if (rows[i]) { l.strikeValue = rows[i].strike; l.quote = l.type === 'CE' ? rows[i].ce : rows[i].pe; renderDeploy(); }
    } else if (b.dataset.p) { dep.pricing = b.dataset.p; renderDeploy(); }
    else if (b.dataset.act === 'refresh') deploy(asStrategy(), dep.shift);
    else if (b.dataset.act === 'close') { dep = null; renderDeployEmpty(); }
    else if (b.dataset.act === 'bt') BT.emit('open-backtest', { strategy: asStrategy(), run: false });
    else if (b.dataset.act === 'save') {
      const s = asStrategy();
      const name = prompt('Save as', s.id?.startsWith('my-') ? s.name : s.name + ' (mine)');
      if (!name) return;
      s.name = name;
      if (!s.id?.startsWith('my-')) s.id = null;
      try { const saved = await BT.saveStrategy(s); dep.strategy.id = saved.id; dep.strategy.name = saved.name; renderDeploy(); } catch (err) { alert(err.message); }
    }
  });
  $('libDeploy').addEventListener('change', (e) => {
    if (!dep) return;
    if (e.target.id === 'depShift') deploy(asStrategy(), Number(e.target.value));
    if (e.target.dataset.lots != null) { dep.legs[Number(e.target.dataset.lots)].lots = Math.max(1, Number(e.target.value) || 1); renderDeploy(); }
  });
  $('libDeploy').addEventListener('input', (e) => {
    if (e.target.id !== 'depDays' || !dep) return;
    dep.daysAhead = Number(e.target.value);
    $('depDaysV').textContent = dep.daysAhead ? '+' + dep.daysAhead + 'd' : 'today';
    drawPayoff(analyse());
  });

  window.addEventListener('viewchange', (e) => { if (e.detail === 'lib') init(); });
  if (window.app.state.view === 'lib') init();
})();
