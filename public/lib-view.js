// Strategies screen: ready-made + saved strategies as cards, and "Deploy" — the strategy resolved on the
// live option chain for an upcoming expiry, with payoff, greeks and breakevens. Strikes can be nudged and
// the result saved back as a relative strategy (ATM offsets), so it applies to every future expiry, or handed to
// the Builder ("Customise in Builder") with the same strikes, lots, prices and what-if settings.
(() => {
  const { $, esc, inr, inrS, kinr, num, cls, dayShort, bs, ncdf } = BT;
  let cat = BT.store.get('libCat', 'All');
  let dep = null; // { strategy, live, legs, shift, pricing, daysAhead, ivShift }
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
          <button class="btn-sm ghost" data-act="builder" title="Open in the Builder on the live chain: paper trade it with payoff, adjustments and P&amp;L">Builder ▸</button>
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
    const legs = [];
    for (const l of s.legs) legs.push((() => {
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
        case 'leg': K = (legs[l.strike.ref]?.K ?? S0) + val / 250; break; // legs listed before it (refs to later legs fall back to ATM)
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
    })());
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
    if (b.dataset.act === 'builder') BT.emit('open-builder', { strategy: s, src: 'live' });
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
        strategy: live.strategy, live, shift, hit, pricing: dep?.pricing || 'ltp', daysAhead: 0, ivShift: dep?.ivShift || 0,
        legs: live.legs.map((l) => ({ ...l, orig: l.strikeValue })),
      };
      dep.strategy.id = strategy.id;
      if (!live.levels) { // only sent when the strategy uses S/R; fetched anyway for the payoff chart's S / R marks
        try {
          const lv = (await BT.api('/api/bt/levels')).levels || [];
          const by = (f) => lv.filter(f).sort((a, b) => Math.abs(a.price - live.spot) - Math.abs(b.price - live.spot))[0] || null;
          dep.chartLevels = { resistance: by((x) => x.price > live.spot), support: by((x) => x.price < live.spot) };
        } catch { /* optional */ }
      }
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

  // ATM IV of an expiry's chain (average of the call and put IV at the strike nearest spot).
  function atmIv(exp) {
    const rows = dep.live.chains[exp] || [];
    if (!rows.length) return null;
    const S0 = dep.live.spot;
    const r = rows.reduce((b, x) => (Math.abs(x.strike - S0) < Math.abs(b.strike - S0) ? x : b), rows[0]);
    const ivs = [r.ce?.iv, r.pe?.iv].filter((v) => v > 0);
    return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length / 100 : null;
  }
  // The shared payoff engine (payoff.js), the same one the Builder uses.
  function analyse() {
    const lot = dep.live.lot;
    const legs = dep.legs.map((l) => ({
      action: l.action, type: l.type, strike: l.strikeValue, lots: l.lots, lot, expiryDate: l.expiryDate,
      entryPx: entryPx(l), px: l.quote?.ltp || entryPx(l), iv: ivOf(l), T: Math.max(1e-6, yearsTo(l.expiryDate)),
    }));
    const near = legs.reduce((m, l) => (l.expiryDate < m ? l.expiryDate : m), legs[0].expiryDate);
    const A = BT.payoff.analyse(legs, { spot: dep.live.spot, atmIv: atmIv(near), daysAhead: dep.daysAhead, ivShift: dep.ivShift });
    return { ...A, near };
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
      <div class="dep-kpis" id="depKpis"></div>
      <div class="dep-chart-head"><span><b>Payoff</b> <span class="muted small">${esc(SBAdjust.structure(a.legs).name)}</span></span><div class="pay-ctl" id="depCtl"></div></div>
      <div class="chart-box dep-chart"><canvas id="depChart"></canvas></div>
      <div class="dep-actions">
        <button class="btn-sm" data-act="builder" title="Open these exact legs (strikes, lots, entry prices, what-if settings) in the Builder on the live chain, to paper trade, adjust and roll them">Customise in Builder ▸</button>
        <button class="btn-sm ghost" data-act="save" title="Save as a strategy defined relative to ATM, reusable on any expiry">Save as my strategy</button>
        <button class="btn-sm ghost" data-act="bt">Backtest it</button>
        <span class="muted small">* = strike changed from the rule; it is saved as an ATM offset.</span>
      </div>
      <div class="muted small pad">Chance of profit uses a lognormal model at ATM IV. Greeks are Black-Scholes at each leg's IV. Margin is a rough estimate: check with your broker. Not investment advice.</div>`;
    BT.payoff.controls($('depCtl'), a, dep, drawPayoff);
    drawPayoff();
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

  // KPIs and chart only (the what-if controls redraw these while they are dragged).
  function drawPayoff() {
    const a = analyse();
    $('depKpis').innerHTML = BT.payoff.kpis(a);
    const lv = dep.live.levels;
    BT.payoff.draw($('depChart'), a, { expiryLabel: dayShort(a.near), nowLabel: 'today', levels: lv ? { resistance: lv.resistance.any, support: lv.support.any } : dep.chartLevels });
  }

  // Convert the deployed legs back into a relative strategy: changed strikes become ATM offsets.
  function asStrategy() {
    const s = BT.clone(dep.strategy);
    s.legs = dep.legs.map((l) => {
      const def = { action: l.action, type: l.type, lots: l.lots, expiry: l.expiry, strike: l.strike, sl: l.sl, tgt: l.tgt, trail: l.trail, re: l.re };
      if (l.strikeValue !== l.orig) {
        const ks = dep.live.chains[l.expiryDate].map((r) => r.strike);
        def.strike = { by: 'atm', value: BT.atmOffset(l.strikeValue, dep.live.spot, BT.strikeStep(ks), l.type), match: 'closest' };
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
    else if (b.dataset.act === 'builder') {
      // Hand the exact position over: strikes, lots, expiries and the entry prices shown here (LTP or bid / ask),
      // each leg tagged with its strategy rule so saving from the Builder keeps the rule, SL and target.
      BT.emit('open-builder', {
        strategy: { ...dep.strategy, id: dep.strategy.id },
        src: 'live',
        expiry: dep.live.base,
        legs: dep.legs.map((l) => ({
          action: l.action, type: l.type, strike: l.strikeValue, lots: l.lots, expiry: l.expiryDate, px: entryPx(l),
          rule: { action: l.action, type: l.type, lots: l.lots, expiry: l.expiry, strike: l.strike, sl: l.sl, tgt: l.tgt, trail: l.trail, re: l.re }, ruleStrike: l.orig,
        })),
        pay: { daysAhead: dep.daysAhead, ivShift: dep.ivShift },
        note: `deployed for ${dayShort(dep.live.base)} at ${dep.pricing === 'market' ? 'bid / ask' : 'LTP'}`,
      });
    }
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

  window.addEventListener('viewchange', (e) => { if (e.detail === 'lib') init(); });
  if (window.app.state.view === 'lib') init();
})();
