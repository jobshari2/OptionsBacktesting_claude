// "Hedge" tab: protect the holdings in your .xlsx with Nifty options. Every input change re-runs the
// search on the server (POST /api/hedge/plan) against live option chains; prices refresh every minute.
// Left: a board of strategies (A–G, each tuned for its own purpose) or the cheapest overall.
// Middle: the selected hedge — legs, payoff chart, scenarios, comparison — and "Your structure" editor.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const { state, esc } = window.app;
  const C = {
    up: css('--up'),
    down: css('--down'),
    muted: css('--muted'),
    text: css('--text'),
    accent: css('--accent'),
    atm: css('--atm'),
    grid: 'rgba(139,148,158,.12)',
    zero: 'rgba(139,148,158,.45)',
  };

  const local = (k, d) => {
    try {
      return JSON.parse(localStorage.getItem('oc.hedge.' + k)) ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem('oc.hedge.' + k, JSON.stringify(v));
    } catch {}
  };
  const hs = {
    overrides: local('overrides', {}),
    excluded: local('excluded', []),
    manual: local('manual', { value: null, exposure: null }), // ₹ typed into the Portfolio / exposure tiles
    holdMin: local('holdMin', false),
    listMode: local('listMode', 'board'),
    selected: null, // a hedge you clicked ('custom' = your structure); otherwise the cheapest is shown
    custom: local('custom', null), // { expiry, legs: [{ action, type, strike, lots }] }
    customMeta: local('customMeta', { savedId: null, name: '' }), // which saved structure the draft came from
    dirty: false, // draft changed since it was last saved
    editing: false,
    data: null,
    busy: false,
    queued: false,
    lastAt: 0,
    chart: null,
    timer: null,
  };
  const LETTERS = 'ABCDEFGH'; // A–G strategies, H = your structure

  // ₹ in lakh / crore
  const inr = (n, d = 2) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n),
      s = n < 0 ? '−' : '';
    if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(d)} Cr`;
    if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(d)} L`;
    return `${s}₹${Math.round(a).toLocaleString('en-IN')}`;
  };
  // "₹1.25 Cr", "50L", "75 lakh", "12,00,000" → rupees; '' → null; anything else → NaN
  const parseInr = (s) => {
    const t = String(s)
      .replace(/[₹,\s]/g, '')
      .toLowerCase();
    if (!t) return null;
    const m = t.match(/^(\d*\.?\d+)(k|l|lac|lakhs?|cr|crores?)?$/);
    if (!m) return NaN;
    return Number(m[1]) * ({ k: 1e3, l: 1e5, lac: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 }[m[2]] || 1);
  };
  const pct = (n, d = 1) => (n == null || isNaN(n) ? '—' : `${n.toFixed(d)}%`);
  const days = (e) => `${e.days != null ? Math.round(e.days) : '?'}d`;
  const dateLabel = (e) => new Date(e + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  const legText = (l) => `${l.action === 'buy' ? 'Buy' : 'Sell'} ${l.lots}× ${l.strike} ${l.type} @ ${l.price.toFixed(2)}`;
  const nameOf = (c, d) => c.name || d.families[c.family];
  const gainsStop = (c) =>
    c?.capsAt ? `${c.capsAt.strike} (+${c.capsAt.pct.toFixed(0)}%)${c.capsAt.share < 0.99 ? `, on ${Math.round(c.capsAt.share * 100)}%` : ''}` : 'never';

  // ---------- controls ----------
  const controls = ['hFall', 'hMaxLoss', 'hPeriod', 'hCap', 'hBeta', 'hPricing', 'hMaxRatio'];
  const changed = () => {
    hs.selected = hs.editing ? 'custom' : null;
    plan();
  };
  for (const id of controls) {
    const el = $(id);
    const saved = local('ctl.' + id, null);
    if (saved != null) el.value = saved;
    el.addEventListener('change', () => {
      save('ctl.' + id, el.value);
      changed();
    });
    if (el.tagName === 'INPUT')
      el.addEventListener('input', () => {
        clearTimeout(hs.timer);
        hs.timer = setTimeout(() => {
          save('ctl.' + id, el.value);
          changed();
        }, 500);
      });
  }

  function params() {
    const [minDays, maxDays] = $('hPeriod').value.split('-').map(Number);
    return {
      fallPct: Number($('hFall').value),
      maxLossPct: Number($('hMaxLoss').value),
      minDays,
      maxDays,
      capPct: $('hCap').value === '' ? null : Number($('hCap').value),
      betaType: $('hBeta').value,
      pricing: $('hPricing').value,
      maxHedgeRatio: Number($('hMaxRatio').value),
      portfolioValue: hs.manual.value,
      exposure: hs.manual.exposure,
      overrides: hs.overrides,
      excluded: hs.excluded,
      selected: hs.selected,
      custom: hs.custom,
    };
  }

  async function plan() {
    if (hs.busy) {
      hs.queued = true;
      return;
    }
    hs.busy = true;
    $('hStatus').textContent = 'Searching…';
    try {
      const r = await fetch('/api/hedge/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params()) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      hs.data = j;
      hs.lastAt = Date.now();
      render();
      $('hStatus').textContent = j.empty
        ? `Waiting for holdings or a portfolio value${j.betasComputing ? ' · computing betas…' : ''}`
        : `Prices as of ${new Date().toLocaleTimeString('en-IN', { hour12: false })}${j.betasComputing ? ' · computing betas…' : ''}`;
    } catch (e) {
      $('hStatus').textContent = 'Error: ' + e.message;
    } finally {
      hs.busy = false;
      if (hs.queued) {
        hs.queued = false;
        plan();
      }
    }
  }

  // ---------- render ----------
  function render() {
    const d = hs.data;
    if (!d) return;
    renderTiles(d);
    if (d.empty) {
      renderEmpty(d);
      renderHoldings(d);
      return;
    }
    renderList(d);
    renderSelected(d);
    renderEditor(d);
    renderCompare(d);
    renderHoldings(d);
  }

  // Tiles are built once so the two editable inputs keep focus while the plan re-runs.
  function buildTiles() {
    const tile = (k, label, input) =>
      `<div class="st"><span class="s" id="hT${k}s">${label}</span>${
        input
          ? `<input class="tv" id="hIn${k}" type="text" inputmode="decimal" spellcheck="false" placeholder="type ₹, e.g. 50L or 1.2Cr" title="Type a value (₹, 50L, 1.2Cr) to replace the one from holdings; clear it to go back">`
          : `<span class="v" id="hT${k}v"></span>`
      }<span class="n" id="hT${k}n"></span></div>`;
    $('hTiles').innerHTML = [
      tile('value', 'Portfolio', true),
      tile('exposure', 'Nifty-equivalent exposure', true),
      tile('lots', 'Lots to cover it'),
      tile('unhedged', 'Unhedged'),
      tile('limit', 'Your loss limit'),
      tile('best', 'Cheapest that meets it'),
    ].join('');
    for (const k of ['value', 'exposure']) {
      const el = $('hIn' + k);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
        if (e.key === 'Escape') {
          el.value = hs.data ? inr(hs.data.portfolio[k]) : '';
          el.blur();
        }
      });
      el.addEventListener('change', () => {
        const v = parseInr(el.value);
        if (Number.isNaN(v) || v === 0) {
          $('hStatus').textContent = `Couldn't read “${el.value}” — use e.g. 2500000, 25L or 1.2Cr`;
          if (hs.data) renderTiles(hs.data);
          return;
        }
        setManual(k, v);
      });
    }
    $('hTiles').addEventListener('click', (e) => {
      const k = e.target.dataset.reset;
      if (k) setManual(k, null);
    });
  }
  const setManual = (k, v) => {
    hs.manual = { ...hs.manual, [k]: v };
    save('manual', hs.manual);
    changed();
  };

  function renderTiles(d) {
    if (!$('hInvalue')) buildTiles();
    const set = (k, v, n, vc = '') => {
      const el = $(`hT${k}v`);
      el.textContent = v;
      el.className = `v ${vc}`;
      $(`hT${k}n`).innerHTML = n;
    };
    const p = d.params;
    const P = d.portfolio.value;
    const fh = d.portfolio.fromHoldings;
    const nHold = d.holdings.filter((h) => h.included).length;
    const reset = (k) =>
      nHold
        ? ` · <button data-reset="${k}" title="Use the value from your holdings">holdings ${inr(fh[k])} ↺</button>`
        : ` · <button data-reset="${k}">clear</button>`;
    for (const k of ['value', 'exposure']) {
      const el = $('hIn' + k);
      if (document.activeElement !== el) el.value = d.portfolio[k] > 0 ? inr(d.portfolio[k]) : '';
      el.classList.toggle('ov', d.portfolio.manual[k]);
    }
    $('hTvaluen').innerHTML = d.portfolio.manual.value
      ? `typed in${reset('value')}`
      : nHold
        ? `${nHold} holdings · as on ${d.asOf || '—'}`
        : 'type a value or upload holdings';
    $('hTexposuren').innerHTML = d.portfolio.manual.exposure
      ? `typed in · beta ${d.portfolio.beta.toFixed(2)} × portfolio${reset('exposure')}`
      : P > 0
        ? `${nHold ? d.portfolio.betaType : 'assumed'} beta ${d.portfolio.beta.toFixed(2)} × portfolio`
        : 'portfolio × beta';
    $('hTunhedgeds').textContent = `Unhedged, Nifty −${p.fallPct}%`;
    if (d.empty) {
      for (const k of ['lots', 'unhedged', 'limit', 'best']) set(k, '—', '');
      return;
    }
    const best = d.search.shortlist[0];
    set('lots', d.search.fullLots.toFixed(2), `Nifty ${d.spot.toFixed(0)} × lot ${d.lot} = ${inr(d.lotValue)}`);
    set('unhedged', inr(d.search.unhedged.target), `${pct((d.search.unhedged.target / P) * 100)} of portfolio`, 'neg');
    set('limit', inr(-(p.maxLossPct / 100) * P), `${p.maxLossPct}% of portfolio`);
    set(
      'best',
      best ? `${pct(best.annualPct, 2)} / yr` : 'none',
      best ? `${inr(best.cost)} for ${days(best)} · ${esc(d.families[best.family])}` : 'loosen the target or period',
    );
  }

  // Nothing to hedge yet: clear the plan panels and say how to start.
  function renderEmpty() {
    hs.editing = false;
    $('hFound').textContent = '';
    $('hList').innerHTML =
      '<div class="muted small h-empty">Nothing to hedge yet. <b>Upload your holdings .xlsx</b> to calculate everything from it, or type a <b>Portfolio</b> value (and optionally its <b>Nifty-equivalent exposure</b>) in the tiles above.</div>';
    $('hSelTitle').textContent = 'No hedge selected';
    $('hSelSub').textContent = '';
    $('hLegs').innerHTML = '';
    $('hCustomise').classList.add('hidden');
    $('hBuilder').classList.add('hidden');
    $('hEditor').classList.add('hidden');
    if (hs.chart) {
      hs.chart.data.labels = [];
      hs.chart.data.datasets.forEach((x) => {
        x.data = [];
      });
      hs.chart.update('none');
    }
    for (const id of ['hScenHead', 'hScenBody', 'hFamHead', 'hFamily', 'hMoveVal', 'hMoveSum']) $(id).innerHTML = '';
  }

  function metrics(c, d) {
    return `<div class="m">
      <span>Cost<b>${inr(c.cost)}</b><span class="muted">${pct(c.annualPct, 2)} / yr</span></span>
      <span>At −${d.params.fallPct}%<b class="neg">${inr(c.loss.target)}</b><span class="muted">at −25%: ${inr(c.loss.m25, 1)}</span></span>
      <span>Upside kept<b class="${c.upsideKept10 >= 95 ? 'pos' : ''}">${pct(c.upsideKept10, 0)}</b><span class="muted">at +10%</span></span>
    </div>`;
  }

  function renderList(d) {
    $('hListMode')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.m === hs.listMode));
    const selId = d.selected?.id;
    if (hs.listMode === 'cheapest') {
      const list = d.search.shortlist;
      $('hFound').textContent = `${d.search.feasible} of ${d.search.tried} meet the target · by cost per year`;
      if (!list.length) {
        $('hList').innerHTML =
          `<div class="muted small">Nothing in this period meets a ${d.params.maxLossPct}% loss limit in a ${d.params.fallPct}% fall without over-hedging. Try a longer period, a higher loss limit, a bigger max hedge, or allowing an upside cap — or see the Strategies view for the best each can do.</div>`;
        return;
      }
      $('hList').innerHTML = list
        .map(
          (c, i) => `
        <div class="h-card${c.id === selId ? ' on' : ''}" data-id="${esc(c.id)}">
          <div class="t"><span class="fam"><span class="rank">${i + 1}</span>${esc(d.families[c.family])}</span><span class="exp">${dateLabel(c.expiry)} · ${days(c)}</span></div>
          ${c.capsAt ? `<div class="warn small">Sold call: needs margin; gains stop above ${gainsStop(c)}</div>` : ''}
          <div class="legs">${c.legs.map(legText).join(' · ')}</div>
          ${metrics(c, d)}
        </div>`,
        )
        .join('');
      return;
    }

    // Strategy board: one card per strategy type, each tuned for its own purpose
    $('hFound').textContent =
      `${d.search.strategies.filter((s) => s.meets && s.allowed && !s.crashOnly).length} of ${d.search.strategies.filter((s) => !s.crashOnly).length} strategies meet your target`;
    const cards = d.search.strategies.map((s, i) => {
      const c = s.option;
      let pill;
      if (!c) pill = '<span class="pill2 no">No liquid strikes in this period</span>';
      else if (!s.allowed) pill = `<span class="pill2 cap">Caps upside — allow it in “Upside”</span>`;
      else if (s.crashOnly) pill = `<span class="pill2 crash">Crash cover: removes ${pct(c.crashCut * 100, 0)} of a −25% loss</span>`;
      else if (s.meets) pill = '<span class="pill2 ok">Meets your target</span>';
      else pill = '<span class="pill2 no">Best it can do — misses target</span>';
      return `
        <div class="h-card${c && c.id === selId ? ' on' : ''}${!c || !s.allowed ? ' dim' : ''}" ${c ? `data-id="${esc(c.id)}"` : ''}>
          <div class="t"><span class="fam"><span class="letter">${LETTERS[i]}</span>${esc(s.name)}</span>${c ? `<span class="exp">${dateLabel(c.expiry)} · ${days(c)}</span>` : ''}</div>
          <div class="note">${esc(s.note)}</div>
          <div style="margin:4px 0">${pill}</div>
          ${c ? `<div class="legs">${c.legs.map(legText).join(' · ')}</div>${metrics(c, d)}` : ''}
        </div>`;
    });
    const cu = d.custom;
    cards.push(`
      <div class="h-card${selId === 'custom' ? ' on' : ''}" data-id="custom">
        <div class="t"><span class="fam"><span class="letter">H</span>Your structure</span>${cu ? `<span class="exp">${dateLabel(cu.expiry)} · ${days(cu)}</span>` : ''}</div>
        <div class="note">Any legs you choose, priced live and judged the same way. Pick a strategy and press <b>Customise</b> to start from it.</div>
        ${cu ? `<div style="margin:4px 0"><span class="pill2 ${cu.meets ? 'ok' : 'no'}">${cu.meets ? 'Meets your target' : 'Misses your target'}</span></div><div class="legs">${cu.legs.map(legText).join(' · ')}</div>${metrics(cu, d)}` : ''}
      </div>`);
    // saved structures: S1, S2, …
    (d.saved || []).forEach((s, i) => {
      cards.push(`
      <div class="h-card${selId === s.id ? ' on' : ''}${s.error ? ' dim' : ''}" data-id="${esc(s.id)}">
        <div class="t"><span class="fam"><span class="letter">S${i + 1}</span>${esc(s.name)}</span><span class="exp">${dateLabel(s.expiry)}${s.days != null ? ` · ${days(s)}` : ''}<button class="h-del" data-del-saved="${esc(s.savedId)}" title="Delete this saved structure">✕</button></span></div>
        ${
          s.error
            ? `<div style="margin:4px 0"><span class="pill2 no">Can't price: ${esc(s.error)}</span></div><div class="legs">${s.savedLegs.map((l) => `${l.action === 'buy' ? 'Buy' : 'Sell'} ${l.lots}× ${l.strike} ${l.type}`).join(' · ')}</div>`
            : `<div style="margin:4px 0"><span class="pill2 ${s.meets ? 'ok' : 'no'}">${s.meets ? 'Meets your target' : 'Misses your target'}</span></div><div class="legs">${s.legs.map(legText).join(' · ')}</div>${metrics(s, d)}`
        }
      </div>`);
    });
    $('hList').innerHTML = cards.join('');
  }

  function renderSelected(d) {
    const c = d.selected;
    if (!c) {
      $('hSelTitle').textContent = 'No hedge selected';
      $('hSelSub').textContent = '';
      $('hLegs').innerHTML = '';
    } else {
      $('hSelTitle').textContent = `${c.id === 'custom' && hs.customMeta.name ? hs.customMeta.name : nameOf(c, d)} · ${dateLabel(c.expiry)}`;
      $('hSelSub').textContent =
        `${days(c)} · puts cover ${pct(c.hedgeRatio * 100, 0)} of exposure (whole lots) · cost ${inr(c.cost)} = ${pct(c.costPct, 2)} of portfolio, ${pct(c.annualPct, 2)} a year · incl. ≈₹${d.chargesPerLeg}/leg charges${c.capsAt ? ` · gains stop above ${gainsStop(c)}` : ''}`;
      $('hLegs').innerHTML = c.legs
        .map((l) => {
          const qty = l.lots * d.lot;
          return `<tr>
          <td class="act-${l.action}">${l.action === 'buy' ? 'BUY' : 'SELL'}</td>
          <td>${qty.toLocaleString('en-IN')} <span class="muted">(${l.lots} lot${l.lots > 1 ? 's' : ''})</span></td>
          <td><b>${l.strike} ${l.type}</b></td>
          <td>${dateLabel(c.expiry)}</td>
          <td>${l.price.toFixed(2)}</td>
          <td class="muted">${l.bid ?? '—'} / ${l.ask ?? '—'}</td>
          <td class="muted">${l.oi != null ? Math.round(l.oi).toLocaleString('en-IN') : '—'}</td>
          <td class="${l.action === 'buy' ? 'neg' : 'pos'}">${l.action === 'buy' ? '−' : '+'}${inr(l.price * qty)}</td>
        </tr>`;
        })
        .join('');
    }
    $('hLegs').closest('.h-legs-wrap').classList.toggle('hidden', hs.editing);
    $('hCustomise').classList.toggle('hidden', hs.editing || !c);
    $('hBuilder').classList.toggle('hidden', hs.editing || !c);
    renderChart(d);
    renderScenarios(d);
  }

  // ---------- your structure (leg editor) ----------
  const openDraft = (custom, meta) => {
    hs.custom = custom;
    hs.customMeta = meta;
    hs.dirty = false;
    save('custom', hs.custom);
    save('customMeta', hs.customMeta);
    hs.editing = true;
    hs.selected = 'custom';
    plan();
  };

  function startEditing() {
    const d = hs.data;
    const c = d?.selected;
    if (!c) return;
    if (c.id === 'custom') {
      hs.editing = true;
      render();
      return;
    }
    openDraft(
      { expiry: c.expiry, legs: c.legs.map((l) => ({ action: l.action, type: l.type, strike: l.strike, lots: l.lots })) },
      c.savedId ? { savedId: c.savedId, name: c.name } : { savedId: null, name: `My ${d.families[c.family]}` },
    );
  }

  // A structure from scratch: one ATM put on the first expiry in your period, sized to your exposure.
  function startNew() {
    const d = hs.data;
    if (!d || d.empty) return;
    const exps = d.editor.expiries;
    const exp = exps.find((e) => e.days >= d.params.minDays) || exps[0];
    if (!exp) return;
    openDraft(
      {
        expiry: exp.expiry,
        legs: [
          { action: 'buy', type: 'PE', strike: Math.round(d.spot / 100) * 100, lots: Math.max(1, Math.round(d.search.fullLots * d.params.maxHedgeRatio)) },
        ],
      },
      { savedId: null, name: '' },
    );
  }

  async function saveDraft(asNew) {
    const name = $('hEdName').value.trim();
    if (!name) {
      $('hEdName').focus();
      $('hEdErr').textContent = 'Give the structure a name to save it.';
      return;
    }
    $('hEdSave').disabled = true;
    try {
      const r = await fetch('/api/hedge/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: asNew ? null : hs.customMeta.savedId, name, ...hs.custom }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      hs.customMeta = { savedId: j.saved.id, name: j.saved.name };
      save('customMeta', hs.customMeta);
      hs.dirty = false;
      $('hStatus').textContent = `Saved “${j.saved.name}”`;
      plan();
    } catch (e) {
      $('hEdErr').textContent = 'Save failed: ' + e.message;
    } finally {
      $('hEdSave').disabled = false;
    }
  }

  async function deleteSaved(id) {
    const s = hs.data?.saved?.find((x) => x.savedId === id);
    if (!s || !confirm(`Delete saved structure “${s.name}”?`)) return;
    try {
      const r = await fetch('/api/hedge/saved/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      if (hs.customMeta.savedId === id) {
        hs.customMeta = { ...hs.customMeta, savedId: null };
        save('customMeta', hs.customMeta);
      }
      if (hs.selected === s.id) hs.selected = null;
      plan();
    } catch (e) {
      $('hStatus').textContent = 'Error: ' + e.message;
    }
  }

  function renderEditor(d) {
    $('hEditor').classList.toggle('hidden', !hs.editing);
    if (!hs.editing || !hs.custom) return;
    const nameEl = $('hEdName');
    if (document.activeElement !== nameEl) nameEl.value = hs.customMeta.name || '';
    const isSaved = Boolean(hs.customMeta.savedId && d.saved?.some((s) => s.savedId === hs.customMeta.savedId));
    $('hEdSave').textContent = isSaved ? (hs.dirty ? 'Save changes' : 'Saved ✓') : 'Save';
    $('hEdSaveNew').classList.toggle('hidden', !isSaved);
    const exps = d.editor.expiries;
    const sel = $('hEdExpiry');
    const key = exps.map((e) => e.expiry).join(',');
    if (sel.dataset.key !== key) {
      sel.innerHTML = exps.map((e) => `<option value="${e.expiry}">${dateLabel(e.expiry)} · ${e.days}d</option>`).join('');
      sel.dataset.key = key;
    }
    sel.value = hs.custom.expiry;
    // warn about structures that add risk instead of removing it
    const lotsOf = (type, action) => hs.custom.legs.filter((l) => l.type === type && l.action === action).reduce((s, l) => s + Number(l.lots || 0), 0);
    const warns = [];
    if (lotsOf('PE', 'sell') > lotsOf('PE', 'buy')) warns.push('You sell more puts than you buy: in a deep fall the extra sold puts lose money.');
    if (lotsOf('CE', 'sell') > 0) warns.push('Sold calls need margin and stop your gains above their strike.');
    $('hEdErr').textContent = [d.customError ? `Can't price this: ${d.customError}` : '', ...warns].filter(Boolean).join(' ');
    const strikes = d.editor.strikes[hs.custom.expiry];
    const priced = d.custom?.legs || [];
    $('hEdLegs').innerHTML = hs.custom.legs
      .map((l, i) => {
        const pl = priced[i];
        const strikeField = strikes?.length
          ? `<select data-f="strike">${(strikes.includes(Number(l.strike)) ? strikes : [...strikes, Number(l.strike)].sort((a, b) => a - b)).map((k) => `<option value="${k}"${k === Number(l.strike) ? ' selected' : ''}>${k}</option>`).join('')}</select>`
          : `<input data-f="strike" type="number" step="50" value="${l.strike}">`;
        return `<tr data-i="${i}">
        <td><select data-f="action"><option value="buy"${l.action === 'buy' ? ' selected' : ''}>Buy</option><option value="sell"${l.action === 'sell' ? ' selected' : ''}>Sell</option></select></td>
        <td><select data-f="type"><option value="PE"${l.type === 'PE' ? ' selected' : ''}>PE</option><option value="CE"${l.type === 'CE' ? ' selected' : ''}>CE</option></select></td>
        <td>${strikeField}</td>
        <td><input data-f="lots" type="number" min="1" step="1" value="${l.lots}"></td>
        <td>${pl ? pl.price.toFixed(2) : '—'}</td>
        <td class="muted">${pl ? `${pl.bid ?? '—'} / ${pl.ask ?? '—'}` : '—'}</td>
        <td><button class="h-ed-del" data-del="${i}" title="Remove leg">✕</button></td>
      </tr>`;
      })
      .join('');
  }

  const editAndPlan = () => {
    save('custom', hs.custom);
    hs.dirty = true;
    hs.selected = 'custom';
    clearTimeout(hs.timer);
    hs.timer = setTimeout(plan, 250);
  };
  $('hCustomise').addEventListener('click', startEditing);
  // The selected hedge as a paper position in the Builder, on the live chain of its expiry.
  $('hBuilder').addEventListener('click', () => {
    const c = hs.data?.selected;
    if (!c?.legs?.length) return;
    window.BT.emit('open-builder', {
      src: 'live',
      expiry: c.expiry,
      note: `Hedge: ${nameOf(c, hs.data)}`,
      legs: c.legs.map((l) => ({ action: l.action === 'buy' ? 'B' : 'S', type: l.type, strike: l.strike, expiry: c.expiry, lots: l.lots })),
    });
  });
  // The selected hedge to Zerodha Kite as real orders, after the dialog's confirmation (kite-order.js).
  $('hKite').addEventListener('click', () => {
    const c = hs.data?.selected;
    if (!c?.legs?.length) return;
    window.KiteOrder?.open({
      title: `Hedge: ${nameOf(c, hs.data)}`,
      sub: dateLabel(c.expiry),
      legs: c.legs.map((l) => ({ action: l.action === 'buy' ? 'B' : 'S', type: l.type, strike: l.strike, expiry: c.expiry, lots: l.lots, price: l.price })),
    });
  });
  $('hNew').addEventListener('click', startNew);
  $('hEdSave').addEventListener('click', () => saveDraft(false));
  $('hEdSaveNew').addEventListener('click', () => saveDraft(true));
  $('hEdName').addEventListener('input', (e) => {
    hs.customMeta = { ...hs.customMeta, name: e.target.value };
    save('customMeta', hs.customMeta);
    hs.dirty = true;
    if (hs.data) {
      renderEditor(hs.data);
      $('hSelTitle').textContent = `${hs.customMeta.name || 'Your structure'} · ${dateLabel(hs.custom.expiry)}`;
    }
  });
  $('hEdName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveDraft(false);
  });
  $('hEdClose').addEventListener('click', () => {
    hs.editing = false;
    render();
  });
  $('hEdExpiry').addEventListener('change', (e) => {
    hs.custom.expiry = e.target.value;
    editAndPlan();
  });
  $('hEdAdd').addEventListener('click', () => {
    const last = hs.custom.legs[hs.custom.legs.length - 1];
    hs.custom.legs.push({ action: 'buy', type: 'PE', strike: last ? last.strike - 500 : Math.round(hs.data.spot / 100) * 100, lots: last?.lots || 1 });
    editAndPlan();
  });
  $('hEdLegs').addEventListener('change', (e) => {
    const i = Number(e.target.closest('tr')?.dataset.i);
    const f = e.target.dataset.f;
    if (Number.isNaN(i) || !f) return;
    hs.custom.legs[i][f] = f === 'strike' || f === 'lots' ? Number(e.target.value) : e.target.value;
    editAndPlan();
  });
  $('hEdLegs').addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    if (del == null || hs.custom.legs.length <= 1) return;
    hs.custom.legs.splice(Number(del), 1);
    editAndPlan();
  });

  // ---------- chart, scenarios, comparison ----------
  function renderChart(d) {
    const pts = d.curve;
    if (!hs.chart) {
      hs.chart = new Chart($('cHedge'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: 'No hedge', data: [], borderColor: C.muted, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 3 },
            { label: 'With hedge', data: [], borderColor: C.accent, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4 },
            { label: 'Loss limit', data: [], borderColor: C.down, borderWidth: 1, borderDash: [2, 3], pointRadius: 0, pointHoverRadius: 0 },
            {
              label: 'Slider · no hedge',
              data: [],
              showLine: false,
              pointRadius: 6,
              pointHoverRadius: 7,
              pointBackgroundColor: C.muted,
              pointBorderColor: C.text,
              pointBorderWidth: 1.5,
            },
            {
              label: 'Slider · with hedge',
              data: [],
              showLine: false,
              pointRadius: 6,
              pointHoverRadius: 7,
              pointBackgroundColor: C.accent,
              pointBorderColor: C.text,
              pointBorderWidth: 1.5,
            },
          ],
        },
        options: {
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              grid: { display: false },
              title: { display: true, text: 'Nifty move by expiry', color: C.muted },
              ticks: {
                callback: function (v) {
                  const m = this.getLabelForValue(v);
                  return m % 5 === 0 ? `${m > 0 ? '+' : ''}${m}%` : '';
                },
                autoSkip: false,
                maxRotation: 0,
              },
            },
            y: {
              grid: { color: (c) => (c.tick.value === 0 ? C.zero : C.grid) },
              border: { display: false },
              title: { display: true, text: 'Portfolio P&L', color: C.muted },
              ticks: { callback: (v) => inr(v, 0) },
            },
          },
          plugins: {
            legend: { position: 'top', align: 'end', labels: { filter: (l) => l.datasetIndex < 3 } },
            tooltip: {
              filter: (c) => c.datasetIndex < 2,
              callbacks: { title: (i) => `Nifty ${i[0].label > 0 ? '+' : ''}${i[0].label}%`, label: (c) => ` ${c.dataset.label}: ${inr(c.raw)}` },
            },
          },
        },
      });
    }
    const ch = hs.chart;
    ch.data.labels = pts.map((p) => p.move);
    ch.data.datasets[0].data = pts.map((p) => p.unhedged);
    ch.data.datasets[1].data = pts.map((p) => p.hedged);
    ch.data.datasets[2].data = pts.map(() => -(d.params.maxLossPct / 100) * d.portfolio.value);
    renderMarker(d);
  }

  function renderScenarios(d) {
    const moves = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 20, 30, 40];
    const byMove = new Map(d.curve.map((p) => [p.move, p]));
    $('hScenHead').innerHTML = `<tr><th>Nifty by expiry</th>${moves.map((m) => `<th>${m > 0 ? '+' : ''}${m}%</th>`).join('')}</tr>`;
    const row = (label, key) =>
      `<tr><td>${label}</td>${moves
        .map((m) => {
          const v = byMove.get(m)?.[key];
          return `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v == null ? '—' : inr(v, 1)}</td>`;
        })
        .join('')}</tr>`;
    $('hScenBody').innerHTML = row('No hedge', 'unhedged') + (d.selected ? row('With hedge', 'hedged') : '');
  }

  // ---------- market slider: "what if Nifty is here at expiry" ----------
  // Portfolio + hedge P&L (₹) at a Nifty move of m %, same model as the server (hedge/engine.js pnl()).
  const pnlAt = (c, m, d) => {
    const port = d.portfolio.exposure * (m / 100);
    if (!c) return port;
    const s1 = d.spot * (1 + m / 100);
    const payoff = c.legs.reduce((t, l) => {
      const intrinsic = l.type === 'PE' ? Math.max(0, l.strike - s1) : Math.max(0, s1 - l.strike);
      return t + (l.action === 'buy' ? 1 : -1) * intrinsic * l.lots * d.lot;
    }, 0);
    return port + payoff - c.cost;
  };
  hs.move = local('move', -10);
  const moveEl = $('hMove');
  moveEl.value = hs.move;
  moveEl.addEventListener('input', () => {
    hs.move = Number(moveEl.value);
    save('move', hs.move);
    if (!hs.data || hs.data.empty) return;
    renderCompare(hs.data);
    renderMarker(hs.data);
  });
  $('hMoveTicks').addEventListener('click', (e) => {
    const m = e.target.dataset.m;
    if (m == null) return;
    moveEl.value = m;
    moveEl.dispatchEvent(new Event('input'));
  });

  // All options the table shows, with their labels (for the "best at this level" summary)
  function allOptions(d) {
    const list = [];
    const seen = new Set();
    d.search.strategies.forEach((s, i) => {
      if (s.option) {
        seen.add(s.option.id);
        list.push({ label: `${LETTERS[i]} ${s.name}`, c: s.option });
      }
    });
    if (d.custom) list.push({ label: 'H Your structure', c: d.custom });
    (d.saved || []).forEach((s, i) => {
      if (!s.error) list.push({ label: `S${i + 1} ${s.name}`, c: s });
    });
    d.search.shortlist.forEach((c, i) => {
      if (!seen.has(c.id)) list.push({ label: `#${i + 1} ${d.families[c.family]}`, c });
    });
    return list;
  }

  function renderMoveSummary(d) {
    const m = hs.move;
    const P = d.portfolio.value;
    const mv = `${m > 0 ? '+' : ''}${m}%`;
    $('hMoveVal').innerHTML =
      `<b class="${m > 0 ? 'pos' : m < 0 ? 'neg' : ''}">${mv}</b> <span class="muted">Nifty ${Math.round(d.spot).toLocaleString('en-IN')} → <b>${Math.round(d.spot * (1 + m / 100)).toLocaleString('en-IN')}</b></span>`;
    const box = (label, v, sub) =>
      `<div class="mv"><span class="s">${label}</span><b class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${inr(v, 1)}</b><span class="n">${sub}</span></div>`;
    const un = pnlAt(null, m, d);
    const sel = d.selected;
    const opts = allOptions(d).map((o) => ({ ...o, v: pnlAt(o.c, m, d) }));
    const best = opts.reduce((b, o) => (!b || o.v > b.v ? o : b), null);
    $('hMoveSum').innerHTML = [
      box('No hedge', un, `${pct((un / P) * 100)} · portfolio ${inr(P + un, 1)}`),
      sel
        ? box(
            `Selected: ${esc(nameOf(sel, d))}`,
            pnlAt(sel, m, d),
            `${pct((pnlAt(sel, m, d) / P) * 100)} · ${pnlAt(sel, m, d) - un >= 0 ? 'saves' : 'costs'} ${inr(Math.abs(pnlAt(sel, m, d) - un), 1)} vs no hedge`,
          )
        : '',
      best
        ? best.v >= un
          ? box(`Best here: ${esc(best.label)}`, best.v, `${pct((best.v / P) * 100)} · ${inr(best.v - un, 1)} better than no hedge`)
          : box('Best here: No hedge', un, `every hedge costs more than it pays at ${mv}`)
        : '',
    ].join('');
  }

  // Dots on the payoff chart where the slider sits
  function renderMarker(d) {
    const ch = hs.chart;
    if (!ch) return;
    const at = (v) => ch.data.labels.map((x) => (x === hs.move ? v : null));
    ch.data.datasets[3].data = at(pnlAt(null, hs.move, d));
    ch.data.datasets[4].data = d.selected ? at(pnlAt(d.selected, hs.move, d)) : [];
    ch.update('none');
  }

  // One table with every option: No hedge, strategies A–G, your structure (H), and the cheapest list.
  function renderCompare(d) {
    const fall = -d.params.fallPct;
    const moves = [...new Set([...(d.scenMoves?.includes(40) ? d.scenMoves : [-30, -25, -20, -15, -10, -5, 0, 5, 10, 20, 30, 40]), fall])].sort(
      (a, b) => a - b,
    );
    const limit = -(d.params.maxLossPct / 100) * d.portfolio.value;
    const P = d.portfolio.value;
    const mv = (m) => `${m > 0 ? '+' : ''}${m}%`;
    const unAt = pnlAt(null, hs.move, d);
    renderMoveSummary(d);
    $('hFamHead').innerHTML =
      `<tr><th>Option</th><th>Expiry</th><th>Legs</th><th>Cost</th><th>Cost / yr</th><th class="mk">At ${mv(hs.move)}</th><th class="mk">% of port.</th><th class="mk">vs no hedge</th>${moves.map((m) => `<th${m === fall ? ' class="tgt"' : ''}>${mv(m)}</th>`).join('')}<th>Meets</th><th>Gains stop</th></tr>`;

    const cell = (v, m) => {
      const cls = [v > 0 ? 'pos' : v < 0 ? 'neg' : '', m === fall ? 'tgt' : '', m < 0 && v < limit ? 'over' : ''].filter(Boolean).join(' ');
      return `<td class="${cls}">${inr(v, 1)}</td>`;
    };
    const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const atSlider = (v) =>
      `<td class="mk ${sign(v)}${v < limit ? ' over' : ''}"><b>${inr(v, 1)}</b></td><td class="mk ${sign(v)}">${pct((v / P) * 100)}</td><td class="mk ${sign(v - unAt)}">${v === unAt ? '—' : `${v > unAt ? '+' : ''}${inr(v - unAt, 1)}`}</td>`;
    const blank = `<td colspan="${moves.length + 9}" class="muted" style="text-align:left">no liquid strikes in this period</td>`;

    // baseline: no hedge
    const exp = d.portfolio.exposure;
    const out = [
      `<tr class="base"><td><b>—</b> No hedge</td><td class="muted">—</td><td class="muted">—</td><td>₹0</td><td>0.00%</td>${atSlider(unAt)}${moves.map((m) => cell(exp * (m / 100), m)).join('')}<td>${exp * (fall / 100) >= limit ? '✓' : '✗'}</td><td class="muted">never</td></tr>`,
    ];

    const row = (label, c, note = '') => {
      if (!c) return `<tr><td>${label}</td>${blank}</tr>`;
      const sc = c.scen || {};
      return `<tr data-id="${esc(c.id)}"${d.selected?.id === c.id ? ' class="on"' : ''}>
        <td>${label}${note}</td><td>${dateLabel(c.expiry)} <span class="muted">${days(c)}</span></td>
        <td class="muted legs-c" title="${esc(c.legs.map(legText).join(' · '))}">${c.legs.map((l) => `${l.action === 'buy' ? 'B' : 'S'}${l.lots} ${l.strike}${l.type}`).join(', ')}</td>
        <td>${inr(c.cost, 1)}</td><td>${pct(c.annualPct, 2)}</td>
        ${atSlider(pnlAt(c, hs.move, d))}
        ${moves.map((m) => cell(sc[m] ?? pnlAt(c, m, d), m)).join('')}
        <td>${c.meets ? '✓' : '✗'}</td><td class="muted">${gainsStop(c)}</td></tr>`;
    };

    const shown = new Set();
    d.search.strategies.forEach((s, i) => {
      if (s.option) shown.add(s.option.id);
      const note = !s.allowed ? ' <span class="muted">(caps upside)</span>' : s.crashOnly ? ' <span class="muted">(crash only)</span>' : '';
      out.push(row(`<b>${LETTERS[i]}</b> ${esc(s.name)}`, s.option, note));
    });
    if (d.custom) out.push(row('<b>H</b> Your structure', d.custom));
    (d.saved || []).forEach((s, i) =>
      out.push(
        s.error
          ? `<tr><td><b>S${i + 1}</b> ${esc(s.name)}</td><td colspan="${moves.length + 9}" class="muted" style="text-align:left">can't price: ${esc(s.error)}</td></tr>`
          : row(`<b>S${i + 1}</b> ${esc(s.name)}`, s),
      ),
    );
    const extra = d.search.shortlist.map((c, i) => ({ c, i })).filter(({ c }) => !shown.has(c.id));
    if (extra.length) {
      out.push(`<tr class="sep"><td colspan="${moves.length + 10}">Other options that meet your target (cheapest first)</td></tr>`);
      for (const { c, i } of extra) out.push(row(`<b>#${i + 1}</b> ${esc(d.families[c.family])}`, c));
    }
    $('hFamily').innerHTML = out.join('');
  }

  function renderHoldings(d) {
    $('hHoldSub').textContent = d.file ? `${d.holdings.length} from upload · beta from 3y weekly returns` : 'none uploaded';
    for (const id of ['hClear', 'hReload', 'hBetas']) $(id).classList.toggle('hidden', !d.file);
    const manualNote =
      d.portfolio.manual.value || d.portfolio.manual.exposure
        ? `<tr><td colspan="5" class="muted small" style="text-align:left;white-space:normal">${d.portfolio.manual.exposure ? 'Exposure' : 'Portfolio value'} is typed in above, so it is used instead of these totals.</td></tr>`
        : '';
    if (!d.holdings.length) {
      $('hHoldings').innerHTML =
        '<tr><td colspan="5" class="muted small" style="text-align:left;white-space:normal">No holdings yet. Upload a broker holdings .xlsx (columns Symbol, ISIN, Quantity Available, Previous Closing Price) to work out value, betas and exposure from it.</td></tr>';
      return;
    }
    $('hHoldings').innerHTML =
      manualNote +
      d.holdings
        .map((h) => {
          const s = h.stats;
          const src = s ? `${s.source}${s.weeks ? `, ${s.weeks} wks, R² ${s.r2 ?? '—'}` : ''}` : 'estimate';
          const ov = hs.overrides[h.isin];
          return `<tr class="${h.included ? '' : 'off'}" data-isin="${h.isin}">
        <td><input type="checkbox" class="inc" ${h.included ? 'checked' : ''} title="Include in the hedge"></td>
        <td><div class="nm">${esc(h.symbol)}</div><div class="sub">${esc(h.category || h.kind)} · ${src}</div></td>
        <td>${inr(h.value, 1)}</td>
        <td><input class="beta${ov != null && ov !== '' ? ' ov' : ''}" type="number" step="0.05" value="${(ov != null && ov !== '' ? Number(ov) : h.autoBeta).toFixed(2)}" title="Measured: beta ${s?.beta ?? '—'} · downside ${s?.downBeta ?? '—'}. Edit to override; clear to reset."></td>
        <td>${inr(h.exposure, 1)}</td>
      </tr>`;
        })
        .join('');
  }

  // ---------- interactions ----------
  const pick = (id) => {
    if (!id) return;
    if (id === 'custom' && !hs.custom) {
      hs.listMode = 'board';
      return;
    }
    hs.selected = id;
    hs.editing = id === 'custom';
    plan();
  };
  $('hList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-saved]')?.dataset.delSaved;
    if (del) {
      e.stopPropagation();
      deleteSaved(del);
      return;
    }
    pick(e.target.closest('.h-card')?.dataset.id);
  });
  $('hFamily').addEventListener('click', (e) => pick(e.target.closest('tr')?.dataset.id));
  $('hListMode').addEventListener('click', (e) => {
    if (!e.target.dataset.m) return;
    hs.listMode = e.target.dataset.m;
    save('listMode', hs.listMode);
    if (hs.data) renderList(hs.data);
  });
  $('hHoldings').addEventListener('change', (e) => {
    const isin = e.target.closest('tr')?.dataset.isin;
    if (!isin) return;
    if (e.target.classList.contains('inc')) {
      hs.excluded = e.target.checked ? hs.excluded.filter((x) => x !== isin) : [...new Set([...hs.excluded, isin])];
      save('excluded', hs.excluded);
    } else if (e.target.classList.contains('beta')) {
      const v = e.target.value.trim();
      if (v === '') delete hs.overrides[isin];
      else hs.overrides[isin] = Number(v);
      save('overrides', hs.overrides);
    }
    changed();
  });

  const post = async (url, body, label) => {
    $('hStatus').textContent = label;
    try {
      const r = await fetch(url, { method: 'POST', body });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      plan();
    } catch (e) {
      $('hStatus').textContent = 'Error: ' + e.message;
    }
  };
  $('hReload').addEventListener('click', () => post('/api/hedge/reload', null, 'Reloading holdings…'));
  $('hBetas').addEventListener('click', () => post('/api/hedge/betas', null, 'Recalculating betas (about a minute)…'));
  $('hClear').addEventListener('click', () => {
    if (confirm('Remove the uploaded holdings?')) post('/api/hedge/clear-upload', null, 'Removing holdings…');
  });
  $('hFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // a new file means everything is calculated from it, so drop values typed into the tiles
    hs.manual = { value: null, exposure: null };
    save('manual', hs.manual);
    await post('/api/hedge/upload', await f.arrayBuffer(), `Reading ${f.name} and computing betas…`);
    e.target.value = '';
  });

  // Minimise / show the holdings panel
  const applyHoldMin = () => {
    $('hHold').classList.toggle('min', hs.holdMin);
    $('hGrid').classList.toggle('hold-min', hs.holdMin);
    if (hs.chart) hs.chart.resize();
  };
  const setHoldMin = (v) => {
    hs.holdMin = v;
    save('holdMin', v);
    applyHoldMin();
  };
  $('hHoldHide').addEventListener('click', () => setHoldMin(true));
  $('hHoldShow').addEventListener('click', () => setHoldMin(false));
  applyHoldMin();

  // Called by app.js on each refresh: first open → search; then refresh prices every 60 s.
  // (Not while the Backtest tab is showing.)
  window.onHedgeRender = () => {
    if (state.view !== 'hedge' || !$('hPlanPane') || $('hPlanPane').classList.contains('hidden')) return;
    if (!hs.data || Date.now() - hs.lastAt > 60_000) plan();
    else if (hs.chart) hs.chart.resize();
  };

  // Shared with hedge-backtest.js (the Backtest tab starts from the planner's portfolio and hedges).
  window.hedgePlanner = { data: () => hs.data, selectedId: () => hs.data?.selected?.id ?? null, LETTERS, inr, parseInr };
})();
