// Trading Ideas › Covered call › Modified covered call › Live trade (drawn by mcc-view.js's tab, /api/mcc/live*,
// bt/mcclive.js): a trade saved in the Builder (Trades › Saved trades) or the paper trade's series, with the NIFTYBEES
// bought against it. Where Nifty was at the entry and where it is now, the legs and payoff, the P&L of NIFTYBEES +
// options for Nifty moves of 0.3 % … 20 % either way, and suggestions tested on past Nifty moves. Nothing is ordered.
// While the market is open the prices (the streamed chain and NIFTYBEES) are read every LIVE_MS and the figures are
// updated in place (the NIFTYBEES form, the chart's zoom and the scroll are left alone); the suggestions are tested
// again every SUG_MS.
(() => {
  const { $, esc, inr, inrS, kinr, cls, dayLabel } = BT;
  const num0 = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-IN'));
  const sgnPct = (x, d = 1) => (x == null || isNaN(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)} %`);
  const kvol = (v) => (v >= 1e7 ? (v / 1e7).toFixed(1) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(1) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v));
  const legLine = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`;
  const GROUP = { call: 'Call ratio', put: 'Put butterfly', both: 'Both', protect: 'NIFTYBEES protection' };

  let key = BT.store.get('mcclive-key', null);
  let st = null; // /api/mcc/live
  let sug = null; // /api/mcc/live/suggest, for st.key
  let sugBusy = false;
  let pick = null; // the suggestion shown in the grid and payoff
  let el = null;
  let pollT = null;
  let chartObj = null;
  let sugAt = 0; // when the suggestions were last tested
  const LIVE_MS = 5_000;
  const CLOSED_MS = 60_000;
  const SUG_MS = 120_000;

  const shown = () =>
    window.app?.state.view === 'cc' && !$('mccMain')?.classList.contains('hidden') && $('mccTabs')?.querySelector('button.on')?.dataset.tab === 'live';

  async function load(k = key) {
    try {
      st = await BT.api('/api/mcc/live' + (k ? '?key=' + encodeURIComponent(k) : ''));
      if (st.key && st.key !== key) {
        key = st.key;
        BT.store.set('mcclive-key', key);
      }
    } catch (e) {
      st = { error: e.message };
    }
    if (sug && sug.key !== st?.key) {
      sug = null;
      pick = null;
    }
  }
  const allSug = () => (sug && !sug.error ? [...sug.list, ...(sug.protect || []), ...(sug.risky || [])] : []);
  async function findSuggestions() {
    if (sugBusy || !st?.key || st.closed) return;
    sugBusy = true;
    drawSug();
    try {
      sug = await BT.api('/api/mcc/live/suggest', { key: st.key });
      pick = pick ? allSug().find((v) => v.id === pick.id) || null : null; // the one shown stays, re-priced, while still listed
    } catch (e) {
      sug = { error: e.message, key: st.key };
    }
    sugBusy = false;
    sugAt = Date.now();
    drawSug();
    refresh(); // the suggestion shown, re-priced, into the grid and the payoff
  }
  // Only the suggestions panel again (the rest keeps its zoom and scroll); the whole screen when it is not drawn yet.
  function drawSug() {
    const w = $('mclSugWrap');
    if (!w || shape() !== drawnShape) return draw();
    w.innerHTML = suggestHtml();
    bindSug();
  }

  async function render(target) {
    el = target;
    el.innerHTML = '<div class="panel empty">Loading the live trade…</div>';
    await load();
    draw();
    if (st?.pos && !st.closed && !sug) findSuggestions();
    poll();
  }
  function poll() {
    clearTimeout(pollT);
    pollT = setTimeout(
      async () => {
        if (!shown()) return; // the tab draws again (and polls) when it is opened
        if (!document.hidden) {
          await load();
          refresh();
          if (st?.marketOpen && st.pos && !st.closed && !sugBusy && Date.now() - sugAt >= SUG_MS) findSuggestions();
        }
        poll();
      },
      st?.marketOpen ? LIVE_MS : CLOSED_MS,
    );
  }
  // What a redraw in place cannot change: the trade, its legs and the NIFTYBEES / entry settings.
  const shape = () =>
    st?.pos
      ? JSON.stringify([
          st.closed ? 'closed' : 'open',
          st.key,
          st.pos.legs.map((l) => [l.type, l.strike, l.lots, l.side, l.entry]),
          st.pos.closed.length,
          st.bees?.qty,
          st.bees?.set,
          st.bees?.exitPx,
          st.entrySpot,
          st.trades.length,
        ])
      : null;
  let drawnShape = null;
  // The new prices into the screen: in place when the same trade is on it, else drawn again.
  function refresh() {
    if (!el || !shown()) return;
    if (st?.error && st.error === el.dataset.err) return; // the same error is on screen: its trade picker is left open
    if (st?.closed) return shape() !== drawnShape ? draw() : undefined; // a closed trade: nothing moves
    if (!st?.pos || st.error || shape() !== drawnShape || !$('mclKpis')) return draw();
    const n = nowPnl();
    $('mclStatus').innerHTML = statusHtml();
    $('mclKpis').innerHTML = kpisHtml(n);
    if ($('mclCoverBody') && st.cover) {
      $('mclCoverBody').innerHTML = coverBody(coverQ ?? st.cover.held);
      if ($('mclCqMin') && st.cover.minUnits != null) $('mclCqMin').textContent = `Minimum (${num0(st.cover.minUnits)})`;
    } else {
      $('mclCover').innerHTML = coverHtml();
      bindCover();
    }
    $('mclTrack').innerHTML = trackHtml();
    $('mclLegsBody').innerHTML = legsBodyHtml(n);
    $('mclGridBody').innerHTML = gridRows();
    $('mclGridNow').innerHTML = gridNowHtml();
    const age = $('mclSugAge');
    if (age && sug) age.innerHTML = sugAgeHtml();
    const cmp = $('mclCmpBody');
    if (cmp && pick) cmp.innerHTML = cmpRows();
    sugChart(true);
    payoff(true);
  }

  // ---------- the position now ----------
  const lot = () => st.pos.lot;
  function nowPnl() {
    const P = st.pos;
    const by = { CE: P.realised.CE - (P.costs?.CE || 0), PE: P.realised.PE - (P.costs?.PE || 0) };
    const priced = { CE: true, PE: true };
    for (const l of P.legs) {
      if (l.ltp == null) priced[l.type] = false;
      else by[l.type] += l.side * (l.ltp - l.entry) * l.lots * lot();
    }
    const ok = priced.CE && priced.PE;
    const bees = st.bees.qty > 0 ? st.bees.qty * (st.bees.now - st.bees.price) : 0;
    // a structure with a leg that has no LTP has no P&L now
    const call = priced.CE ? by.CE : null;
    const put = priced.PE ? by.PE : null;
    return { call, put, opt: ok ? by.CE + by.PE : null, bees, total: ok ? by.CE + by.PE + bees : null, ok };
  }

  function draw() {
    if (!el || !shown()) return;
    if (st?.closed) return drawClosed();
    const top = el.querySelector('.mcl-grid')?.scrollTop; // the grid keeps its scroll through the redraws
    // values typed in the NIFTYBEES form and not saved yet survive a redraw of the same trade
    const typed = drawnShape === shape() ? FORM.map((id) => $(id)?.dataset.typed && $(id).value) : null;
    el.dataset.err = st?.error || '';
    if (st?.error) {
      drawnShape = null;
      const pickTrade = st.trades?.length > 1 ? `<div class="set-row">${pickerHtml()}</div>` : '';
      el.innerHTML = `<div class="panel cc-doc mcl-head">${pickTrade}<div class="err small">${esc(st.error)}</div></div>`;
      bindPick();
      return;
    }
    if (!st?.pos) {
      el.innerHTML = `<div class="panel empty"><h3>No live trade</h3><p>Build the position in the <b>Builder</b> (call ratio 1 × 2 and put 2-3-1) and press <b>Save trade</b>: it is listed in <b>Trades › Saved trades</b> and shown here. The Modified covered call paper trade's open series is shown here too.</p></div>`;
      return;
    }
    const P = st.pos;
    const E = st.entrySpot;
    const n = nowPnl();
    if (shape() !== drawnShape) coverQ = null;
    drawnShape = shape();
    const head = `<div class="panel cc-doc mcl-head">
      <div class="set-row"><h3>Live trade</h3>
        ${pickerHtml()}
        <button class="btn-sm ghost" id="mclRefresh" title="Price the trade at the live chain again">↻ Refresh</button>
        ${P.src === 'builder' ? `<button class="btn-sm ${closing ? '' : 'ghost'} danger" id="mclCloseBtn" title="Close every option leg and sell the NIFTYBEES: recorded in the saved trade (Builder › Trades) at the prices you confirm">${closing ? 'Cancel close' : 'Close entire trade…'}</button>` : ''}
        <span class="muted small" id="mclStatus">${statusHtml()}</span></div>
      <div class="muted small">${esc(P.legs.map(legLine).join(' · '))} · expiry ${dayLabel(P.expiry)} (${st.market.daysLeft} trading day${st.market.daysLeft === 1 ? '' : 's'} left)${P.closed.length ? ` · closed: ${esc(P.closed.map((c) => `${c.side > 0 ? 'B' : 'S'} ${c.lots}× ${c.strike} ${c.type} ${c.entry.toFixed(1)} → ${c.exit.toFixed(1)}`).join(', '))}` : ''}${P.otherExpiry ? ` · ${P.otherExpiry} leg(s) of another expiry left out` : ''}${P.src === 'builder' ? ' · P&amp;L before charges, as the Builder shows it' : ' · P&amp;L after costs, as the paper trade counts it'}</div>
      <div class="kpis cc-kpis-main" id="mclKpis">${kpisHtml(n)}</div>
      <div id="mclCover">${coverHtml()}</div>
      <div id="mclTrack">${trackHtml()}</div>
      <div id="mclClosePanel">${closing ? closePanelHtml() : ''}</div>
      <div class="set-row mcl-bees">
        <b>NIFTYBEES entry</b>
        <label>Units <input id="mclQty" class="txt num" type="number" min="0" step="1" value="${st.bees.qty || ''}" placeholder="e.g. 6500"></label>
        <label>Bought at ₹ <input id="mclPx" class="txt num" type="number" min="1" step="0.01" value="${st.bees.set || st.bees.fromPaper ? st.bees.price.toFixed(2) : ''}" placeholder="${st.bees.now.toFixed(2)}"></label>
        <label title="Where Nifty was when the trade was entered (the start marked on the track, the grid and the payoff)">Entry Nifty <input id="mclEntry" class="txt num" type="number" min="1000" step="0.05" value="${E ? E.toFixed(2) : ''}"></label>
        <button class="btn-sm" id="mclSave">Save</button>
        <span id="mclMsg" class="muted small">${
          st.bees.fromPaper
            ? 'From the paper trade (change it to override).'
            : st.bees.fromBuilder
              ? 'Kept in the saved trade: the Builder shows and edits them too.'
              : st.bees.set
                ? ''
                : 'Not entered yet: the totals count the options only (or enter them in the Builder: Modified covered call).'
        }${st.entryFromTrade ? " Entry Nifty: the trade's legs at entry (change it if you entered at another level)." : ''} NIFTYBEES now: ${st.bees.live ? 'its LTP' : "estimated from Nifty's move since the entry"}.</span>
      </div></div>`;

    el.innerHTML =
      head +
      `<div class="panel cc-doc"><h3>Legs and payoff <button class="btn-sm ghost" id="mclToSb" title="${P.src === 'builder' ? 'Open this saved trade in the Builder: its open and closed legs, log and P&amp;L, to adjust it there' : "Open the paper series's open legs in the Builder as a live paper position at their entry prices"}">Load in Builder ▸</button></h3><div class="cc-pos-grid">
        <div class="tbl-wrap"><table class="grid-tbl mcl-legs"><thead><tr><th class="l">Leg</th><th class="l">Status</th><th>Entry</th><th title="Open legs: the last traded price now. Closed legs: the price they were closed at">LTP / exit</th><th title="Implied volatility at this strike now (used for the 'if today' P&amp;L)">IV</th><th>P&amp;L</th></tr></thead><tbody id="mclLegsBody">${legsBodyHtml(n)}</tbody></table><div class="muted small">ATM IV ${(st.market.atmIv * 100).toFixed(1)} % · lot ${lot()}${P.closed.length ? ' · closed legs count with the P&amp;L they were closed at, in every figure on this screen (a fixed amount at any Nifty)' : ''}</div></div>
        <div class="cc-pay"><div class="cc-pay-chart"><canvas id="mclPay"></canvas></div><div class="muted small">Solid: at expiry. Dotted: if Nifty moved there today.${st.pos.closed.length ? ' Closed legs included at their booked P&amp;L.' : ''} ${pick ? `Red: after “${esc(pick.title)}”.` : 'Pick a suggestion below to see it here.'}</div></div>
      </div></div>` +
      gridHtml() +
      `<div id="mclSugWrap">${suggestHtml()}</div>`;
    payoff();
    bind(top);
    typed?.forEach((v, i) => {
      if (v === false || v == null) return;
      const inp = $(FORM[i]);
      inp.value = v;
      inp.dataset.typed = '1';
    });
  }
  const FORM = ['mclQty', 'mclPx', 'mclEntry'];

  function pickerHtml() {
    return `<select id="mclPick" title="Trades saved in the Builder (Trades › Saved trades) with open legs, and the paper trade's series">${st.trades
      .map(
        (t) =>
          `<option value="${esc(t.key)}" ${t.key === st.key ? 'selected' : ''}>${esc(t.name)}${t.closed ? ' (closed)' : t.mcc ? '' : ' (not a call ratio + put butterfly)'} · ${dayLabel(t.expiry)}</option>`,
      )
      .join('')}</select>`;
  }

  // How much NIFTYBEES the upside needs (bt/mcclive.js beesCover), worked out step by step with the trade's numbers, for
  // a quantity picked on the slider (coverQ; null = the units held). What-if only: units above those held count as
  // bought now at NIFTYBEES' price now, units below as sold now; nothing is saved.
  let coverQ = null;
  const COVER_PCTS = [0, 1, 2, 5, 10, 20];
  // the trade at expiry with Nifty at x and q units of NIFTYBEES (the difference from those held at today's price)
  function coverAt(x, q) {
    const c = st.cover;
    return expiryAt(st.pos.legs, st.pos.realised, x) + (q - c.held) * c.beesNow * (x / st.market.spot - 1);
  }
  const coverMax = (c) => Math.ceil(Math.max(c.slopeUnits * 2, c.held * 1.5, (c.minUnits || 0) * 1.3, 1000) / 100) * 100;
  function coverHtml() {
    const c = st.cover;
    if (!c || !(c.netShortLots > 0)) return '';
    const q = coverQ ?? c.held;
    return `<div class="mcl-cover" id="mclCoverBox">
      <div id="mclCoverBody">${coverBody(q)}</div>
      <div class="mcl-cover-q">
        <label for="mclCoverQ"><b>Try a NIFTYBEES quantity</b></label>
        <input type="range" id="mclCoverQ" min="0" max="${coverMax(c)}" step="1" value="${q}">
        <input type="number" id="mclCoverQn" class="txt num" min="0" step="1" value="${q}">
        <button class="btn-sm ghost" data-cq="held" id="mclCqHeld">Held (${num0(c.held)})</button>
        ${c.minUnits != null ? `<button class="btn-sm ghost" data-cq="min" id="mclCqMin">Minimum (${num0(c.minUnits)})</button>` : ''}
        <span class="muted small">What-if only, nothing is saved: units above the ${num0(c.held)} held count as bought now at ₹${c.beesNow.toFixed(2)}, units below as sold now. After buying, enter the real units in <b>NIFTYBEES entry</b>.</span>
      </div></div>`;
  }
  function coverBody(q) {
    const c = st.cover;
    const P = st.pos;
    const sold = P.legs.filter((l) => l.type === 'CE' && l.side < 0);
    const bought = P.legs.filter((l) => l.type === 'CE' && l.side > 0);
    const lots = (a) => a.reduce((n, l) => n + l.lots, 0);
    const strikes = (a) => a.map((l) => l.strike).join('/');
    const hi = Math.max(...sold.map((l) => l.strike));
    const S = st.market.spot;
    const pu = c.perUnit;
    const rs = (v) => (v == null ? '—' : `<span class="${cls(v)}">${inrS(Math.round(v))}</span>`);
    const slope = q * pu - c.perPoint; // ₹ a point far up with q units
    const covers = c.minUnits != null && q >= c.minUnits;
    const diff = q - c.held;
    const what =
      q === c.held
        ? `Your ${num0(q)} NIFTYBEES`
        : `${num0(q)} NIFTYBEES (${diff > 0 ? 'buy' : 'sell'} ${num0(Math.abs(diff))} now, ≈ ${inr(Math.round(Math.abs(diff) * c.beesNow))})`;
    const head = covers
      ? `<b class="pos">${what} cover the upside</b>: at expiry the trade does not lose anywhere above Nifty now.`
      : c.minUnits == null
        ? '<b class="neg">No NIFTYBEES quantity makes the upside safe here</b> (the trade is in a loss NIFTYBEES cannot make up).'
        : `<b class="neg">${what} do not cover the upside.</b> Minimum: <b>${num0(c.minUnits)} units</b>${c.toBuy > 0 ? `: buy <b>${num0(c.toBuy)} more</b> than you hold (≈ ${inr(Math.round(c.cost))} at ₹${c.beesNow.toFixed(2)})` : ''}.`;
    const steps = [
      `Calls: ${lots(sold)} sold (${strikes(sold)}) − ${lots(bought)} bought (${strikes(bought)}) = <b>${c.netShortLots} lot${c.netShortLots === 1 ? '' : 's'} sold net</b> = ${c.netShortLots * c.lot} units of Nifty. Above ${num0(hi)} the options lose <b>₹${num0(c.perPoint)} for every point</b> Nifty rises.`,
      `One NIFTYBEES unit moves in % with Nifty: ₹${c.beesNow.toFixed(2)} ÷ ${num0(S)} = <b>₹${pu.toFixed(5)} per Nifty point</b>.`,
      `To cancel ₹${num0(c.perPoint)} a point: ${num0(c.perPoint)} ÷ ${pu.toFixed(5)} = <b>${num0(c.slopeUnits)} units</b> (worth ${inr(Math.round(c.slopeUnits * c.beesNow))}).`,
      `With <b>${num0(q)}</b> units: they gain ${num0(q)} × ${pu.toFixed(5)} = ₹${(q * pu).toFixed(2)} a point, so far up the trade ${slope >= 0 ? 'gains' : 'loses'} <b class="${cls(slope)}">₹${Math.abs(slope).toFixed(2)} a point</b>: ${rs(coverAt(S * 1.1, q))} at +10 %, ${rs(coverAt(S * 1.2, q))} at +20 %.`,
    ];
    if (c.minUnits != null && c.minUnits > c.slopeUnits)
      steps.push(
        `The minimum is above ${num0(c.slopeUnits)} because at Nifty now the trade is ${rs(c.now)} at expiry: the extra units bought now make that up as Nifty rises.`,
      );
    if (c.held && st.bees.price && Math.abs(st.bees.price - c.beesNow) >= 0.01)
      steps.push(
        `Typing a bigger quantity in <b>Units</b> instead counts every unit at <b>Bought at ₹${st.bees.price.toFixed(2)}</b>, though units you add now cost ₹${c.beesNow.toFixed(2)}: use this slider to try quantities.`,
      );
    // columns: the units held, the quantity tried, the minimum (each once)
    const cols = [
      { q: c.held, label: `With ${num0(c.held)} <span class="muted">held</span>` },
      ...(q !== c.held ? [{ q, label: `With <b>${num0(q)}</b> <span class="muted">tried</span>`, tried: true }] : []),
      ...(c.minUnits != null && c.minUnits !== c.held && c.minUnits !== q
        ? [{ q: c.minUnits, label: `With ${num0(c.minUnits)} <span class="muted">minimum</span>` }]
        : []),
    ];
    const rows = COVER_PCTS.map((pct) => {
      const x = S * (1 + pct / 100);
      return `<tr><td class="l">${pct === 0 ? 'Now' : '+' + pct + ' %'}</td><td>${num0(x)}</td>${cols.map((k) => `<td class="${k.tried ? 'mcl-tried' : ''}">${k.tried ? '<b>' : ''}${rs(coverAt(x, k.q))}${k.tried ? '</b>' : ''}</td>`).join('')}</tr>`;
    }).join('');
    const far = `<tr class="mcl-far"><td class="l" colspan="2">Each further point up</td>${cols.map((k) => `<td class="${cls(k.q * pu - c.perPoint)}">${inrS(k.q * pu - c.perPoint, 2)}</td>`).join('')}</tr>`;
    return `<div class="mcl-cover-in ${covers ? 'ok' : 'short'}"><div class="mcl-cover-h">NIFTYBEES needed so the upside does not lose: ${head}</div>
      <div class="mcl-cover-b"><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
      <div class="mcl-cover-t"><table class="grid-tbl"><thead><tr><th class="l">Nifty from now</th><th>Nifty</th>${cols.map((k) => `<th>${k.label}</th>`).join('')}</tr></thead><tbody>${rows}${far}</tbody></table></div></div>
      <div class="muted small">At expiry: NIFTYBEES + options, closed legs included; NIFTYBEES at ₹${c.beesNow.toFixed(2)}${c.beesLive ? ' (live)' : ' (estimated)'} moving with Nifty.</div></div>`;
  }
  // the slider, its number box and the Held / Minimum buttons
  function bindCover() {
    const set = (v, from) => {
      const c = st.cover;
      if (!c) return;
      const q = Math.max(0, Math.round(Number(v) || 0));
      coverQ = q === c.held ? null : q;
      const r = $('mclCoverQ');
      const n = $('mclCoverQn');
      if (r && from !== 'range') {
        if (q > Number(r.max)) r.max = String(Math.ceil(q / 100) * 100);
        r.value = String(q);
      }
      if (n && from !== 'number') n.value = String(q);
      $('mclCoverBody').innerHTML = coverBody(q);
    };
    $('mclCoverQ')?.addEventListener('input', (e) => set(e.target.value, 'range'));
    $('mclCoverQn')?.addEventListener('input', (e) => set(e.target.value, 'number'));
    $('mclCoverBox')?.addEventListener('click', (e) => {
      const k = e.target.closest('[data-cq]')?.dataset.cq;
      if (k) set(k === 'min' ? st.cover.minUnits : st.cover.held);
    });
  }

  // The status line: live (and how fresh the prices are) or the market closed.
  function statusHtml() {
    const t = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-IN') : '—');
    const b = st.bees;
    const beesTxt = !b.qty ? '' : b.live ? ` · NIFTYBEES ${b.how === 'tick' ? 'streamed' : 'LTP'} ${t(b.at)}` : ' · NIFTYBEES estimated from Nifty';
    const when = st.marketOpen
      ? `<span class="mcl-live"></span> <b>Live</b>, every ${LIVE_MS / 1000} s · prices ${t(st.market.at)}${st.market.feed ? ' (ticks)' : ''}`
      : `market closed: last traded prices · ${t(st.market.at)}`;
    return `${when}${beesTxt}${st.demo ? ' · demo mode: synthetic prices' : ''} · nothing is sent to a broker`;
  }
  function kpisHtml(n) {
    const P = st.pos;
    const S = st.market.spot;
    const E = st.entrySpot;
    const moved = E > 0 ? (S / E - 1) * 100 : null;
    return `
        <div class="kpi"><span class="k-l">Nifty now</span><span class="k-v">${num0(S)}</span><span class="muted small">entry ${num0(E)} · <b class="${cls(moved)}">${sgnPct(moved, 2)}</b></span></div>
        <div class="kpi"><span class="k-l">Call ratio spread</span><span class="k-v ${cls(n.call)}">${n.call == null ? '—' : inrS(Math.round(n.call))}</span><span class="muted small">at LTP</span></div>
        <div class="kpi"><span class="k-l">Put butterfly</span><span class="k-v ${cls(n.put)}">${n.put == null ? '—' : inrS(Math.round(n.put))}</span><span class="muted small">at LTP${P.realised.PE || P.realised.CE ? ', closed legs included' : ''}</span></div>
        <div class="kpi"><span class="k-l">Options</span><span class="k-v ${cls(n.opt)}">${n.opt == null ? '—' : inrS(Math.round(n.opt))}</span><span class="muted small">${n.ok ? 'every leg priced' : 'a leg has no LTP'}</span></div>
        <div class="kpi"><span class="k-l">NIFTYBEES</span><span class="k-v ${cls(n.bees)}">${st.bees.qty > 0 ? inrS(Math.round(n.bees)) : '—'}</span><span class="muted small">${st.bees.qty > 0 ? `${num0(st.bees.qty)} × ₹${st.bees.price.toFixed(2)} → ₹${st.bees.now.toFixed(2)}${st.bees.live ? '' : ' (estimated)'}` : 'enter it below'}</span></div>
        <div class="kpi"><span class="k-l">Total</span><span class="k-v ${cls(n.total)}">${n.total == null ? '—' : inrS(Math.round(n.total))}</span><span class="muted small">NIFTYBEES + options now</span></div>`;
  }
  function legsBodyHtml(n) {
    const P = st.pos;
    return `${['CE', 'PE'].map((t) => legRows(t, t === 'CE' ? n.call : n.put)).join('')}
        <tr class="mcl-tot"><td class="l" colspan="5"><b>Options: open + closed legs</b>${P.closed.length ? ` <span class="muted small">closed ${inrS(Math.round(P.realised.CE + P.realised.PE))}</span>` : ''}</td><td class="${cls(n.opt)}"><b>${n.opt == null ? '—' : inrS(Math.round(n.opt))}</b></td></tr>`;
  }

  // One structure's rows in Legs and payoff: its open legs (entry → LTP now), then its closed legs (entry → exit, the
  // P&L booked), and costs so far (paper trade); v = the structure's P&L, open + closed.
  function legRows(t, v) {
    const P = st.pos;
    const open = P.legs.filter((l) => l.type === t);
    const closed = P.closed.filter((l) => l.type === t);
    const side = (l) => `<b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sell' : 'Buy'}</b> ${l.lots} × ${l.strike} ${l.type}`;
    const rows = [
      ...open.map((l) => {
        const pnl = l.ltp != null ? (l.ltp - l.entry) * l.side * l.lots * lot() : null;
        return `<tr><td class="l">${side(l)}</td><td class="l"><span class="cat-pill c-bullish">open</span></td><td>${l.entry.toFixed(2)}</td><td>${l.ltp != null ? l.ltp.toFixed(2) : '—'}</td><td class="muted">${l.ltp != null && l.iv ? (l.iv * 100).toFixed(1) + ' %' : '—'}</td><td class="${cls(pnl)}">${pnl == null ? '—' : inrS(Math.round(pnl))}</td></tr>`;
      }),
      ...closed.map(
        (l) =>
          `<tr class="mcl-closed"><td class="l">${side(l)}</td><td class="l"><span class="cat-pill">closed</span>${l.exitDay ? ` <span class="muted small">${dayLabel(l.exitDay)}${l.exitAt ? ' ' + esc(l.exitAt) : ''}</span>` : ''}</td><td>${l.entry.toFixed(2)}</td><td>${l.exit.toFixed(2)}</td><td class="muted">—</td><td class="${cls(l.pnl)}">${inrS(Math.round(l.pnl))}</td></tr>`,
      ),
    ];
    const cost = P.costs?.[t] || 0;
    if (cost)
      rows.push(
        `<tr class="mcl-closed"><td class="l muted" colspan="5">Costs so far (fills, charges)</td><td class="neg">${inrS(-Math.round(cost))}</td></tr>`,
      );
    return (
      `<tr class="mcl-grp"><td class="l" colspan="5"><b>${t === 'CE' ? 'Call ratio spread' : 'Put butterfly'}</b> <span class="muted small">${open.length} open${closed.length ? ` · ${closed.length} closed ${inrS(Math.round(P.realised[t]))}` : ''}</span></td><td class="${cls(v)}"><b>${v == null ? '—' : inrS(Math.round(v))}</b></td></tr>` +
      rows.join('')
    );
  }

  // Where it started and where it is: the strikes on a line with the entry and Nifty now marked.
  function trackHtml() {
    const P = st.pos;
    const S = st.market.spot;
    const E = st.entrySpot;
    const ks = P.legs.map((l) => l.strike);
    const all = [...ks, ...P.closed.map((l) => l.strike)];
    const lo = Math.min(...all, S, E || S) * 0.985;
    const hi = Math.max(...all, S, E || S) * 1.015;
    const at = (x) => (((x - lo) / (hi - lo)) * 100).toFixed(2) + '%';
    // open strikes and closed-only strikes (faded), labels staggered on up to 3 rows where they would overlap
    const pos = (x) => ((x - lo) / (hi - lo)) * 100;
    const lotsText = (legs) => legs.map((l) => `${l.side > 0 ? '+' : '−'}${l.lots} ${l.type}`).join(' ');
    const ticks = [
      ...[...new Set(ks)].map((k) => {
        const legs = P.legs.filter((l) => l.strike === k);
        return { k, cls: legs.reduce((s, l) => s + l.side * l.lots, 0) < 0 ? 'neg' : 'pos', t: lotsText(legs), closed: false };
      }),
      ...[...new Set(P.closed.map((l) => l.strike))]
        .filter((k) => !ks.includes(k))
        .map((k) => ({ k, cls: 'closed', t: lotsText(P.closed.filter((l) => l.strike === k)), closed: true })),
    ].sort((x, y) => x.k - y.k);
    const lastAt = [-Infinity, -Infinity, -Infinity];
    const strikes = ticks
      .map((x) => {
        let row = lastAt.findIndex((p) => pos(x.k) - p >= 6);
        if (row < 0) row = lastAt.indexOf(Math.min(...lastAt));
        lastAt[row] = pos(x.k);
        return `<span class="mcl-k ${x.cls} r${row}" style="left:${at(x.k)}" title="${x.k}: ${esc(x.t)}${x.closed ? ', closed' : ''}"><i></i><em>${x.k}</em><small>${x.closed ? 'closed' : esc(x.t)}</small></span>`;
      })
      .join('');
    const lowPut = Math.min(...P.legs.filter((l) => l.type === 'PE').map((l) => l.strike));
    const hiCall = Math.max(...P.legs.filter((l) => l.type === 'CE' && l.side < 0).map((l) => l.strike));
    const zone =
      Number.isFinite(lowPut) && Number.isFinite(hiCall) && hiCall > lowPut
        ? `<span class="mcl-zone" style="left:${at(lowPut)};width:calc(${at(hiCall)} - ${at(lowPut)})" title="Between the lowest put and the sold calls"></span>`
        : '';
    const dir = E > 0 ? (S >= E ? 'up' : 'down') : '';
    return `<div class="mcl-track" style="padding-bottom:${40 + 28 * (lastAt.filter(Number.isFinite).length - 1)}px" title="The trade's strikes, where Nifty was at the entry and where it is now">
      <div class="mcl-line">${zone}${strikes}
        ${E > 0 ? `<span class="mcl-arrow ${dir}" style="left:${S >= E ? at(E) : at(S)};width:calc(${at(Math.max(S, E))} - ${at(Math.min(S, E))})"></span>` : ''}
        ${E > 0 ? `<span class="mcl-m entry ${pos(E) > 50 ? 'l' : 'r'}" style="left:${at(E)}"><span><b>Started</b> ${num0(E)}${st.pos.entryDay ? ' · ' + dayLabel(st.pos.entryDay) : ''}</span></span>` : ''}
        <span class="mcl-m now hi ${pos(S) > 50 ? 'l' : 'r'}" style="left:${at(S)}"><span><b>Now</b> ${num0(S)}${E > 0 ? ` · ${sgnPct((S / E - 1) * 100, 2)}` : ''}</span></span>
      </div></div>`;
  }

  // ---------- the move grid ----------
  // The suggestion shown, at expiry with Nifty at x (as bt/mcclive.js optExpiry: realised + open legs at intrinsic −
  // costs so far − STT on bought legs in the money) + NIFTYBEES.
  function afterAt(x) {
    return expiryAt(pick.after.legs, pick.after.realised, x);
  }
  // Nifty x lies between the start and now (the way Nifty has come)
  const between = (x) => {
    const [a, b] = [Math.min(st.entrySpot || st.market.spot, st.market.spot), Math.max(st.entrySpot || st.market.spot, st.market.spot)];
    return x > a && x < b;
  };
  // Where Nifty is against the start, for the grid's title; NIFTYBEES' own move since its purchase beside it.
  function gridNowHtml() {
    const S = st.market.spot;
    const E = st.entrySpot || S;
    const b = st.bees;
    const bees =
      b.qty > 0 && b.live
        ? ` · NIFTYBEES ₹${b.price.toFixed(2)} → ₹${b.now.toFixed(2)} (${sgnPct((b.now / b.price - 1) * 100, 2)} since bought, Nifty ${sgnPct((S / E - 1) * 100, 2)} since the start)`
        : '';
    return `started at <b>${num0(E)}</b>, now <b>${num0(S)}</b> (<b class="${cls(S - E)}">${sgnPct((S / E - 1) * 100, 2)}</b>)${bees}`;
  }
  function gridRows() {
    const td = (v, b) => `<td class="${cls(v)}">${b ? '<b>' : ''}${inrS(Math.round(v))}${b ? '</b>' : ''}</td>`;
    return st.grid
      .map((r) => {
        const a = pick ? { total: afterAt(r.x) } : null;
        const label =
          r.mark === 'now'
            ? `<b>Now</b> <b class="${cls(r.m)}">${sgnPct(r.m, 2)}</b>`
            : r.mark === 'entry'
              ? '<b>Started</b> <span class="muted">0 %</span>'
              : sgnPct(r.m, 1);
        const path = r.mark ? '' : between(r.x) ? ' mcl-path' : '';
        return `<tr class="${r.mark === 'now' ? 'sel' : r.mark === 'entry' ? 'mcl-entry' : ''}${path}"><td class="l">${label}</td><td><b>${num0(r.x)}</b></td><td class="muted">${r.mark === 'now' ? '—' : sgnPct(r.fromNow, 1)}</td>
          <td>${r.beesPx != null ? '₹' + r.beesPx.toFixed(2) : '—'}</td>${st.bees.qty > 0 ? td(r.bees) : '<td class="muted">—</td>'}
          <td class="mcl-g1 ${cls(r.callToday)}">${inrS(Math.round(r.callToday))}</td>${td(r.putToday)}${td(r.optToday)}${td(r.totalToday, true)}
          <td class="mcl-g2 ${cls(r.call)}">${inrS(Math.round(r.call))}</td>${td(r.put)}${td(r.opt)}${td(r.total, true)}
          ${a ? `${td(a.total, true)}<td class="${cls(a.total - r.total)}">${inrS(Math.round(a.total - r.total))}</td>` : ''}</tr>`;
      })
      .join('');
  }
  function gridHtml() {
    return `<div class="panel cc-doc"><h3>P&amp;L for Nifty moves from where the trade started <span class="muted small" id="mclGridNow">${gridNowHtml()}</span></h3>
      <div class="muted small">Every % is Nifty's move from the start; every P&amp;L is the trade's since the start: options from their entry premiums (closed legs as booked, costs so far included), NIFTYBEES from its buy price (moving with Nifty from its price now). <b>If Nifty is there today</b>: the options keep their time value (Black-76 on the chain's forward at each strike's IV now, each leg calibrated to its LTP), so the <b>Now</b> row is exactly the P&amp;L at the top. <b>At expiry</b>: the options at intrinsic value (STT on bought legs in the money included). Shaded: the way Nifty has come from the start to now.</div>
      <div class="tbl-wrap mcc-scen mcl-grid"><table class="grid-tbl"><thead>
        <tr class="mcl-ghead"><th colspan="5"></th><th colspan="4" class="mcl-g1">If Nifty is there today</th><th colspan="4" class="mcl-g2">At expiry (${dayLabel(st.pos.expiry)})</th>${pick ? '<th colspan="2" class="mcl-after">After the suggestion</th>' : ''}</tr>
        <tr><th class="l" title="Nifty's move from where the trade started">From start</th><th>Nifty</th><th title="How far that level is from Nifty now">From now</th><th>NIFTYBEES</th><th>NIFTYBEES P&amp;L</th>
        <th class="mcl-g1">Call ratio</th><th>Put butterfly</th><th>Options</th><th>Total</th>
        <th class="mcl-g2">Call ratio</th><th>Put butterfly</th><th>Options</th><th>Total</th>${
          pick ? `<th class="mcl-after" title="${esc(pick.title)}">Total at expiry</th><th>Change</th>` : ''
        }</tr></thead><tbody id="mclGridBody">${gridRows()}</tbody></table></div></div>`;
  }

  // ---------- suggestions ----------
  function suggestHtml() {
    const head = `<div class="panel cc-doc"><h3>Suggestions to improve the result <button class="btn-sm ghost" id="mclSug" ${sugBusy ? 'disabled' : ''}>${sugBusy ? 'Testing…' : sug ? '↻ Test again at the live prices' : 'Find suggestions'}</button></h3>`;
    if (sugBusy && !sug) return head + '<div class="muted small">Pricing the changes at the live chain and testing them on past Nifty moves…</div></div>';
    if (!sug) return head + '</div>';
    if (sug.error) return head + `<div class="err small">${esc(sug.error)}</div></div>`;
    const s = sug.sample;
    const h = sug.hold;
    const pctOf = (x) => Math.round(x * 100) + ' %';
    const intro = `<p class="small">Every change is priced at the live chain (buys at LTP + ${s.slipPct} %, sells at LTP − ${s.slipPct} %, charges on every order) and tested at expiry on <b>${num0(s.n)}</b> past ${s.days}-trading-day Nifty moves (${dayLabel(s.from)} – ${dayLabel(s.to)}, each scaled to today's ATM IV ${(s.ivNow * 100).toFixed(1)} % over India VIX that day). Only strikes <b>traded today (volume above 0)</b>, with a price and a bid–ask spread no wider than ₹2 or 10 % are entered; a price outside its bid–ask is taken at the quote's mid. Kept only when it <b>raises the average result</b> and does not make the worst past outcome worse by more than ₹5,000 / 5 % or the average it gains; defined risk always (no extra sold calls, never more puts sold than bought).</p>
      <div class="kpis"><div class="kpi"><span class="k-l">Held as it is</span><span class="k-v">${pctOf(h.profitable)}</span><span class="muted small">of the past moves end in profit (NIFTYBEES + options)</span></div>
        <div class="kpi"><span class="k-l">Average at expiry</span><span class="k-v ${cls(h.avg)}">${inrS(h.avg)}</span><span class="muted small">best ${inrS(h.best)}</span></div>
        <div class="kpi"><span class="k-l">Worst 5 %</span><span class="k-v ${cls(h.p5)}">${inrS(h.p5)}</span><span class="muted small">worst ${inrS(h.worst)}</span></div>
        <div class="kpi"><span class="k-l">Changes tested</span><span class="k-v">${sug.tried}</span><span class="muted small">${sug.improving} raise the average · ${sug.reliable} better in ≥ 90 % of moves${sug.riskier ? ` · ${sug.riskier} more left out: riskier` : ''}</span></div></div>`;
    const sk = sug.skipped || { volume: [], spread: [] };
    const few = (a) => (a.length > 12 ? `${a.slice(0, 12).join(', ')} and ${a.length - 12} more` : a.join(', '));
    const leftOut =
      sk.volume.length || sk.spread.length
        ? `<p class="muted small">Left out: ${sk.volume.length ? `<b>${sk.volume.length}</b> strike${sk.volume.length === 1 ? '' : 's'} with no volume today (${esc(few(sk.volume))})` : ''}${sk.volume.length && sk.spread.length ? '; ' : ''}${sk.spread.length ? `<b>${sk.spread.length}</b> with a wide bid–ask spread (${esc(few(sk.spread))})` : ''}.</p>`
        : '';
    const protect = sug.protect || [];
    const risky = sug.risky || [];
    const verdict = !sug.list.length
      ? `<p class="small"><b>No change raises the expected result without adding much more worst-case loss</b> at these prices: holding the trade as it is beats every change tested on that test.${protect.length ? ' To cut the risk instead, see <b>Protection</b> below: it costs a little on average.' : ''}${risky.length ? ` ${sug.riskier} changes do raise the average but make the worst outcome much worse: listed, collapsed, at the end, not suggested.` : ''}</p>`
      : sug.reliable
        ? `<p class="small">Marked <span class="cc-kind k-book">✓ 90 %+</span>: better than holding in at least 90 % of the past moves, and better on average.</p>`
        : '<p class="small"><b>None of the changes is better in 90 % of past moves today.</b> The ones below raise the average result but do worse in some moves: the “better in” column says how often each one helped.</p>';
    const rowsOf = (list) =>
      list
        .map((v, i) => {
          const st2 = v.stats;
          const noisy = st2.avg < st2.se;
          return `<tr class="${pick?.id === v.id ? 'sel' : ''}" data-sug="${esc(v.id)}"><td>${i + 1}</td>
          <td class="l"><b>${esc(v.title)}</b> ${v.reliable ? '<span class="cc-kind k-book">✓ 90 %+</span>' : ''} <span class="muted small">${GROUP[v.group] || ''}</span>${ordersHtml(v)}</td>
          <td class="${cls(v.costNow)}" title="Slippage against the LTPs and charges: what doing it costs the moment it is done">${inrS(v.costNow)}</td>
          <td><b>${pctOf(st2.better)}</b></td>
          <td class="${cls(st2.avg)}"><b>${inrS(st2.avg)}</b><div class="muted small">± ${inr(st2.se)}${noisy ? ' · too close to call' : ''}</div></td>
          <td class="${cls(st2.p5)}">${inrS(st2.p5)}</td><td class="${cls(st2.p95)}">${inrS(st2.p95)}</td>
          <td class="small">${inrS(st2.worstBefore)} → <span class="${cls(st2.worstAfter - st2.worstBefore)}">${inrS(st2.worstAfter)}</span></td>
          <td><button class="btn-sm ${pick?.id === v.id ? '' : 'ghost'}" data-show="${esc(v.id)}" title="What the trade looks like after this change: its legs, P&amp;L for Nifty moves and payoff, next to the trade as it is">${pick?.id === v.id ? 'Hide' : 'Show'}</button></td></tr>${pick?.id === v.id ? `<tr class="mcl-sug-detail"><td colspan="9" id="mclSugDetail">${detailHtml(v)}</td></tr>` : ''}`;
        })
        .join('');
    const tableOf = (list) =>
      `<div class="tbl-wrap"><table class="grid-tbl mcl-sug"><thead><tr><th>#</th><th class="l">Change: legs to exit and legs to enter <span class="muted">(at about these prices)</span></th><th>Cost now</th><th title="Share of the past moves in which the trade ends better with the change than without it">Better in</th><th title="Average gain at expiry over the past moves, ± its standard error">Average gain</th><th title="The change's result in the worst 5 % of past moves">Worst 5 %</th><th title="The change's result in the best 5 % of past moves">Best 5 %</th><th title="The trade's worst past outcome (NIFTYBEES + options) without → with the change">Worst outcome</th><th></th></tr></thead><tbody>${rowsOf(list)}</tbody></table></div>`;
    const table =
      (sug.list.length ? tableOf(sug.list) : '') +
      (protect.length
        ? `<h4>Protection <span class="muted small">not a gain: each one costs a little on average (its “Average gain” is negative) but lifts the worst past outcome by at least ₹5,000 / 10 %; the most protection per ₹ first</span></h4>${tableOf(protect)}`
        : '') +
      (risky.length
        ? `<details class="mcl-risky" ${risky.some((v) => v.id === pick?.id) ? 'open' : ''}><summary>Not suggested: ${sug.riskier} change${sug.riskier === 1 ? '' : 's'} that raise the average but make the worst outcome much worse (the ${risky.length} best shown)</summary><p class="muted small">Their average gain is small next to the extra loss in the worst past moves: compare the “Worst outcome” column.</p>${tableOf(risky)}</details>`
        : '');
    const rules = sug.rules?.length
      ? `<h4>Rules from the backtest study <span class="muted small">options only, each month from its first day (Backtest tab › adjustment study); not this trade's prices</span></h4>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Rule</th><th>Backtest total</th><th>Months better than no adjustments</th><th class="l">On this trade now</th></tr></thead><tbody>
        ${sug.rules
          .slice(0, 10)
          .map(
            (r) =>
              `<tr><td class="l">${esc(r.label)}</td><td class="${cls(r.total - r.noneTotal)}">${inrS(r.total)} <span class="muted small">(none: ${inrS(r.noneTotal)})</span></td><td>${r.beat} of ${r.months}</td><td class="l small">${r.due ? `<b>Due:</b> ${esc(r.due)}` : '<span class="muted">not due</span>'}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : '';
    return (
      head +
      intro +
      leftOut +
      verdict +
      table +
      rules +
      `<p class="muted small"><span id="mclSugAge">${sugAgeHtml()}</span> Past moves are not a promise: a change that helped in 90 % of them can still lose this month, and prices move — test again before acting. Nothing here places orders.</p></div>`
    );
  }

  // The change's orders in two tables side by side: the legs to exit (closed now) and the legs to enter (opened now).
  function ordersHtml(v) {
    const tbl = (list, exit) =>
      list.length
        ? `<table class="mcl-ord"><thead><tr><th class="l">Order</th><th>Lots</th><th>Strike</th><th>Price</th><th title="Quantity traded today in this strike (units, as the feed reports it)">Vol</th></tr></thead><tbody>${list
            .map(
              (o) =>
                `<tr><td class="l"><b class="${o.action === 'B' ? 'pos' : 'neg'}">${exit ? (o.action === 'B' ? 'Buy back' : 'Sell') : o.action === 'B' ? 'Buy' : 'Sell'}</b></td><td>${o.lots}</td><td><b>${o.strike} ${o.type}</b></td><td title="LTP ${o.ltp != null ? o.ltp.toFixed(2) : '—'}${o.bid && o.ask ? ` · bid ${o.bid.toFixed(2)} / ask ${o.ask.toFixed(2)}` : ''}; the fill counted (slippage included)">~${o.fill.toFixed(1)}</td><td class="muted">${o.vol ? kvol(o.vol) : '0'}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<div class="muted small mcl-ord-none">${exit ? 'nothing to exit' : 'nothing new to enter'}</div>`;
    const ex = v.orders.filter((o) => o.close);
    const en = v.orders.filter((o) => !o.close);
    return `<div class="mcl-orders"><div class="mcl-ord-side exit"><div class="mcl-ord-h">Exit <span class="muted">(close)</span></div>${tbl(ex, true)}</div><div class="mcl-ord-side enter"><div class="mcl-ord-h">Enter <span class="muted">(open)</span></div>${tbl(en, false)}</div></div>`;
  }

  // Under the suggestion shown: the position after it (legs kept, reduced, new), the P&L for some Nifty moves as it is
  // and after the change, and both payoffs.
  const DETAIL_MOVES = [10, 5, 3, 2, 1, 0, -1, -2, -3, -5, -10];
  function detailHtml(v) {
    const P = st.pos;
    const before = new Map(P.legs.map((l) => [l.id, l]));
    const rows = v.after.legs
      .map((l) => {
        const was = before.get(l.id);
        const tag = !was
          ? '<span class="cat-pill c-bullish">new</span>'
          : was.lots !== l.lots
            ? `<span class="cat-pill">${was.lots} → ${l.lots} lots</span>`
            : '<span class="cat-pill c-neutral">kept</span>';
        return `<tr><td class="l"><b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sell' : 'Buy'}</b> ${l.lots} × ${l.strike} ${l.type}</td><td class="l">${tag}</td><td>${l.entry.toFixed(2)}</td></tr>`;
      })
      .join('');
    const gone = P.legs.filter((l) => !v.after.legs.some((a) => a.id === l.id));
    return `<div class="mcl-detail">
      <div><h4>Position after the change</h4><table class="grid-tbl"><thead><tr><th class="l">Leg</th><th class="l"></th><th title="Kept legs: their entry; new legs: the fill counted">Entry</th></tr></thead><tbody>${rows}${gone
        .map(
          (l) =>
            `<tr class="mcl-closed"><td class="l"><s>${l.side < 0 ? 'Sell' : 'Buy'} ${l.lots} × ${l.strike} ${l.type}</s></td><td class="l"><span class="cat-pill">exited</span></td><td>${l.entry.toFixed(2)}</td></tr>`,
        )
        .join('')}</tbody></table>
        <div class="muted small">Doing it now costs ${inr(-v.costNow)} (slippage + charges ${inr(v.charges)}); legs closed by it keep their P&amp;L in the totals.</div>
        <div class="set-row"><button class="btn-sm" data-sb="after" title="Open the position after this change in the Builder as a live paper position, at the prices counted here (options only)">Load this change in the Builder ▸</button><button class="btn-sm ghost" data-show="${esc(v.id)}">Hide</button></div></div>
      <div><h4>At expiry: as it is → after the change</h4><table class="grid-tbl"><thead><tr><th class="l" title="From where the trade started">From start</th><th>Nifty</th><th>As it is</th><th>After</th><th>Change</th></tr></thead><tbody id="mclCmpBody">${cmpRows()}</tbody></table>
        <div class="muted small">NIFTYBEES + options, closed legs included.</div></div>
      <div class="mcl-detail-chart"><h4>Payoff at expiry</h4><div class="cc-pay-chart"><canvas id="mclSugPay"></canvas></div></div>
    </div>`;
  }
  function cmpRows() {
    const S = st.market.spot;
    const E = st.entrySpot || S;
    const mNow = (S / E - 1) * 100;
    const ms = [...DETAIL_MOVES.filter((m) => Math.abs(m - mNow) >= 0.05), mNow].sort((a, b) => b - a);
    return ms
      .map((m) => {
        const now = m === mNow;
        const x = now ? S : E * (1 + m / 100);
        const e = expiryAt(st.pos.legs, st.pos.realised, x);
        const a = afterAt(x);
        const label = now ? `<b>Now</b> <b class="${cls(m)}">${sgnPct(m, 2)}</b>` : m === 0 ? '<b>Started</b>' : sgnPct(m, 0);
        return `<tr class="${now ? 'sel' : m === 0 ? 'mcl-entry' : ''}"><td class="l">${label}</td><td>${num0(x)}</td><td class="${cls(e)}">${inrS(Math.round(e))}</td><td class="${cls(a)}"><b>${inrS(Math.round(a))}</b></td><td class="${cls(a - e)}">${inrS(Math.round(a - e))}</td></tr>`;
      })
      .join('');
  }
  let sugChartObj = null;
  function sugChart(update = false) {
    const canvas = $('mclSugPay');
    if (!canvas || !pick) return;
    const S = st.market.spot;
    const xs = [];
    for (let x = Math.floor((S * 0.9) / 25) * 25; x <= S * 1.1; x += 25) xs.push(x);
    const sets = [
      {
        label: 'As it is',
        data: xs.map((x) => ({ x, y: Math.round(expiryAt(st.pos.legs, st.pos.realised, x)) })),
        borderColor: '#58a6ff',
        borderWidth: 2,
        pointRadius: 0,
      },
      {
        label: 'After the change',
        data: xs.map((x) => ({ x, y: Math.round(afterAt(x)) })),
        borderColor: '#f0616d',
        borderWidth: 2,
        borderDash: [6, 3],
        pointRadius: 0,
      },
    ];
    const ys = sets.flatMap((d) => d.data.map((p) => p.y));
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    sets.push({
      label: `Now ${num0(S)}`,
      data: [
        { x: S, y: y0 },
        { x: S, y: y1 },
      ],
      borderColor: '#9aa5b1',
      borderDash: [4, 4],
      borderWidth: 1,
      pointRadius: 0,
    });
    if (update && sugChartObj && sugChartObj.canvas === canvas) {
      sets.forEach((d, i) => Object.assign(sugChartObj.data.datasets[i], { data: d.data, label: d.label }));
      sugChartObj.update('none');
      return;
    }
    sugChartObj = BT.chart(canvas, {
      type: 'line',
      data: { datasets: sets },
      options: {
        parsing: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: { x: { type: 'linear', title: { display: true, text: 'Nifty at expiry' } }, y: { ticks: { callback: (y) => kinr(y) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}`, title: (c) => 'Nifty ' + num0(c[0].parsed.x) } } },
      },
    });
  }
  // NIFTYBEES + options at expiry with Nifty at x, for legs + realised (bt/mcclive.js optExpiry, plus NIFTYBEES).
  function expiryAt(legs, realised, x) {
    const L = lot();
    const intr = (l) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
    let v = 0;
    for (const t of ['CE', 'PE']) {
      const ls = legs.filter((l) => l.type === t);
      const stt = window.Costs ? Costs.exercise(ls.filter((l) => l.side > 0).reduce((s2, l) => s2 + intr(l) * l.lots * L, 0)) : 0;
      v += realised[t] + ls.reduce((s2, l) => s2 + l.side * (intr(l) - l.entry) * l.lots * L, 0) - (st.pos.costs?.[t] || 0) - stt;
    }
    return v + (st.bees.qty > 0 ? st.bees.qty * (st.bees.now * (x / st.market.spot) - st.bees.price) : 0);
  }

  // ---------- the Builder ----------
  // legs: [{ side, type, strike, lots, entry }] into the Builder as a live paper position at those entry prices.
  function toBuilder(legs, note) {
    const sb = BT.store.get('sb', {});
    if (sb.legs?.some((l) => l.open) && !sb.tradeId && !confirm('The Builder holds a position that is not saved. Replace it with this one?')) return;
    BT.emit('open-builder', {
      src: 'live',
      expiry: st.pos.expiry,
      note,
      legs: legs.map((l) => ({ action: l.side > 0 ? 'B' : 'S', type: l.type, strike: l.strike, expiry: st.pos.expiry, lots: l.lots, px: l.entry })),
    });
  }
  // The trade itself: a saved Builder trade is opened as saved (its closed legs, log and P&L curve too); the paper
  // trade's series as a live paper position at its entry prices.
  function loadTrade() {
    const P = st.pos;
    if (P.src === 'builder') return BT.emit('open-trade', P.id);
    toBuilder(P.legs, `${P.name} (options only; the NIFTYBEES are not in the Builder)`);
  }

  // When the suggestions were priced, against Nifty now (tested again every SUG_MS while the market is open).
  function sugAgeHtml() {
    const d = st.market.spot - sug.spot;
    return `Tested ${new Date(sug.at).toLocaleTimeString('en-IN')} with Nifty at ${num0(sug.spot)}${Math.abs(d) >= 1 ? ` (now ${d > 0 ? '+' : '−'}${num0(Math.abs(d))})` : ''}${st.marketOpen ? `, again every ${SUG_MS / 60000} min` : ''}.`;
  }

  // ---------- payoff ----------
  // A leg's value if Nifty were at x now, as the server prices the grid's "today" (bt/mcclive.js valueToday):
  // Black-76 on the chain's forward moved with Nifty, the strike's IV now, plus the leg's calibration (worth its LTP at
  // Nifty now).
  function valueToday(l, x) {
    const m = st.market;
    if (!(m.T > 0)) return Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
    return Math.max(0, window.Pricing.b76((m.F * x) / m.spot, l.strike, m.T, l.iv || m.atmIv, l.type === 'CE', m.df ?? Math.exp(-0.065 * m.T)) + (l.cal || 0)); // df: a server not restarted yet sends none
  }
  // Labels at the top of the Started / Now lines, and their dots (chart.$mclMarks: [{ x, y, text, color }]).
  const marksPlugin = {
    id: 'mclMarks',
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a, scales } = c;
      for (const m of c.$mclMarks || []) {
        const px = scales.x.getPixelForValue(m.x);
        if (px < a.left || px > a.right) continue;
        ctx.save();
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(px, a.top);
        ctx.lineTo(px, a.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 11px system-ui, sans-serif';
        const w = ctx.measureText(m.text).width + 10;
        const left = Math.min(Math.max(a.left, px - w / 2), a.right - w);
        ctx.fillStyle = m.color;
        ctx.fillRect(left, a.top + m.row * 20, w, 17);
        ctx.fillStyle = '#0e1117';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.text, left + 5, a.top + m.row * 20 + 9);
        if (m.y != null) {
          const py = scales.y.getPixelForValue(m.y);
          if (py >= a.top && py <= a.bottom) {
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fillStyle = m.color;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#0e1117';
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    },
  };

  // update: new prices into the chart drawn (its zoom kept), else drawn anew.
  function payoff(update = false) {
    const canvas = $('mclPay');
    if (!canvas) return;
    const P = st.pos;
    const S = st.market.spot;
    const E = st.entrySpot;
    const L = lot();
    const intr = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);
    const optAt = (legs, realised, x, today, types = ['CE', 'PE']) =>
      types.reduce((s, t) => s + (realised[t] || 0) - (P.costs?.[t] || 0), 0) +
      legs.filter((l) => types.includes(l.type)).reduce((s, l) => s + l.side * ((today ? valueToday(l, x) : intr(l, x)) - l.entry) * l.lots * L, 0);
    const bees = (x) => (st.bees.qty > 0 ? st.bees.qty * (st.bees.now * (x / S) - st.bees.price) : 0);
    const home = [Math.floor((S * 0.9) / 50) * 50, Math.ceil((S * 1.1) / 50) * 50];
    const xs = [];
    for (let x = Math.floor((S * 0.8) / 25) * 25; x <= S * 1.2; x += 25) xs.push(x);
    const line = (label, f, color, extra = {}) => ({
      label,
      data: xs.map((x) => ({ x, y: Math.round(f(x)) })),
      borderColor: color,
      borderWidth: 2,
      pointRadius: 0,
      ...extra,
    });
    const sets = [
      line('Options at expiry', (x) => optAt(P.legs, P.realised, x, false), '#b392f0'),
      line('Call ratio', (x) => optAt(P.legs, P.realised, x, false, ['CE']), '#d6af4c', { borderWidth: 1.5, borderDash: [5, 3] }),
      line('Put butterfly', (x) => optAt(P.legs, P.realised, x, false, ['PE']), '#3fb68b', { borderWidth: 1.5, borderDash: [5, 3] }),
    ];
    if (st.bees.qty > 0) {
      sets.push(line('NIFTYBEES + options at expiry', (x) => optAt(P.legs, P.realised, x, false) + bees(x), '#58a6ff'));
      sets.push(line('NIFTYBEES + options today', (x) => optAt(P.legs, P.realised, x, true) + bees(x), '#58a6ff', { borderWidth: 1.5, borderDash: [2, 3] }));
    } else sets.push(line('Options today', (x) => optAt(P.legs, P.realised, x, true), '#b392f0', { borderWidth: 1.5, borderDash: [2, 3] }));
    if (pick)
      sets.push(
        line(`After: ${pick.title}`, (x) => optAt(pick.after.legs, pick.after.realised, x, false) + bees(x), '#f0616d', { borderWidth: 2, borderDash: [6, 3] }),
      );
    // Now: the dot on today's total = the Total at the top; Started: today's total if Nifty went back there now
    const totalToday = (x) => optAt(P.legs, P.realised, x, true) + bees(x);
    const marks = [
      {
        x: S,
        y: totalToday(S),
        text: `Now ${num0(S)} · ${E > 0 ? sgnPct((S / E - 1) * 100, 2) + ' · ' : ''}P&L ${inrS(Math.round(totalToday(S)))}`,
        color: '#58a6ff',
        row: 0,
      },
    ];
    if (E > 0 && Math.abs(E - S) >= 1) marks.push({ x: E, y: totalToday(E), text: `Started ${num0(E)}`, color: '#e3b341', row: 1 });
    if (update && chartObj && chartObj.canvas === canvas && chartObj.data.datasets.length === sets.length) {
      sets.forEach((d, i) => {
        chartObj.data.datasets[i].data = d.data;
        chartObj.data.datasets[i].label = d.label;
      });
      chartObj.$mclMarks = marks;
      chartObj.update('none');
      return;
    }
    chartObj = BT.chart(canvas, {
      plugins: [marksPlugin],
      type: 'line',
      data: { datasets: sets },
      options: {
        parsing: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: { x: { type: 'linear', min: home[0], max: home[1], title: { display: true, text: 'Nifty' } }, y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: {
          payZoom: { on: true, home },
          tooltip: {
            filter: (i) => !i.dataset.pz_skip,
            callbacks: { label: (c) => `${c.dataset.label}: ${inrS(c.parsed.y)}`, title: (c) => 'Nifty ' + num0(c[0].parsed.x) },
          },
        },
      },
    });
    chartObj.$mclMarks = marks;
    chartObj.update('none');
  }

  function bindPick() {
    $('mclPick')?.addEventListener('change', async (e) => {
      key = e.target.value;
      BT.store.set('mcclive-key', key);
      sug = null;
      pick = null;
      closing = false;
      closeVals = {};
      el.innerHTML = '<div class="panel empty">Loading the live trade…</div>';
      await load(key);
      draw();
      findSuggestions();
    });
  }
  function bind(top) {
    bindPick();
    bindCover();
    $('mclToSb')?.addEventListener('click', loadTrade);
    $('mclRefresh')?.addEventListener('click', async () => {
      await load();
      refresh();
    });
    for (const id of FORM) $(id)?.addEventListener('input', (e) => (e.target.dataset.typed = '1'));
    $('mclSave')?.addEventListener('click', async () => {
      const msg = $('mclMsg');
      try {
        msg.textContent = 'Saving…';
        st = await BT.api('/api/mcc/live/config', { key: st.key, bees: { qty: $('mclQty').value, price: $('mclPx').value }, entrySpot: $('mclEntry').value });
        sug = null; // the totals changed: test again
        pick = null;
        draw();
        findSuggestions();
      } catch (e) {
        msg.textContent = e.message;
        msg.classList.add('neg');
      }
    });
    bindSug();
    bindClose();
    // the grid opens with Nifty now in the middle
    const g = el.querySelector('.mcl-grid');
    const now = g?.querySelector('tr.sel');
    if (g) g.scrollTop = top ?? (now ? now.offsetTop - (g.clientHeight - now.offsetHeight) / 2 : 0);
  }

  function bindSug() {
    $('mclSug')?.addEventListener('click', findSuggestions);
    el.querySelectorAll('[data-show]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = allSug().find((x) => x.id === b.dataset.show);
        const sel = `tr[data-sug="${CSS.escape(v.id)}"]`;
        const y = el.querySelector(sel)?.getBoundingClientRect().top;
        pick = pick?.id === v.id ? null : v;
        draw(); // the detail opens under its row; the grid and the payoff gain the "after" line and columns
        // the row clicked stays where it was on screen (the redraw changes the heights above it), its detail under it
        const row = el.querySelector(sel);
        let box = el.parentElement;
        while (box && box !== document.body && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
          box = box.parentElement;
        if (row && y != null) (box && box !== document.body ? box : document.scrollingElement).scrollTop += row.getBoundingClientRect().top - y;
        if (pick) el.querySelector('.mcl-sug-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }),
    );
    el.querySelector('[data-sb="after"]')?.addEventListener(
      'click',
      () => pick && toBuilder(pick.after.legs, `${st.pos.name} after: ${pick.title} (options only)`),
    );
    sugChart();
  }

  // ---------- closing the whole trade ----------
  // A saved Builder trade: every open leg (this expiry's and any other's) and the NIFTYBEES, at prices prefilled from
  // the live chain and editable to the real fills. Recorded in the saved trade (/api/mcc/live/close) the way the Builder
  // records exits; nothing is sent to a broker (the options can be sent to Kite from here, through its own dialog).
  let closing = false;
  let closeVals = {}; // prices typed in the close panel: leg id / 'bees' -> text (kept through the live refreshes)
  const closeLegs = () => [...st.pos.legs, ...(st.pos.others || [])];
  const beesToSell = () => st.bees?.qty > 0 && st.bees.set && !st.bees.exitPx;
  // the boxes filled with the live prices now (they stay put while the screen refreshes, until "Live prices")
  function liveCloseVals() {
    closeVals = {};
    for (const l of closeLegs()) closeVals[l.id] = l.ltp != null ? l.ltp.toFixed(2) : '';
    if (beesToSell()) closeVals.bees = st.bees.now.toFixed(2);
  }
  const closeVal = (k, dflt) => (k in closeVals ? closeVals[k] : dflt == null ? '' : Number(dflt).toFixed(2));
  // the P&L of closing at the panel's prices: options (this close + legs closed before), NIFTYBEES, total; ok: every price given
  function closeTotals() {
    const P = st.pos;
    let opt = P.realised.CE + P.realised.PE - (P.costs?.CE || 0) - (P.costs?.PE || 0);
    let ok = true;
    for (const l of closeLegs()) {
      const v = closeVal(l.id, l.ltp);
      if (v === '' || !(Number(v) >= 0)) ok = false;
      else opt += l.side * (Number(v) - l.entry) * l.lots * lot();
    }
    let bees = 0;
    if (beesToSell()) {
      const v = closeVal('bees', st.bees.now);
      if (!(Number(v) > 0)) ok = false;
      else bees = st.bees.qty * (Number(v) - st.bees.price);
    } else if (st.bees?.exitPx && st.bees.qty > 0) bees = st.bees.qty * (st.bees.exitPx - st.bees.price);
    return { ok, opt, bees, total: opt + bees };
  }
  function closePanelHtml() {
    const P = st.pos;
    const t = closeTotals();
    const legRow = (l) => {
      const v = closeVal(l.id, l.ltp);
      const pnl = v !== '' && Number(v) >= 0 ? l.side * (Number(v) - l.entry) * l.lots * lot() : null;
      return `<tr><td class="l"><b class="${l.side < 0 ? 'pos' : 'neg'}">${l.side < 0 ? 'Buy back' : 'Sell'}</b> ${l.lots} × ${l.strike} ${l.type}${l.expiry !== P.expiry ? ` <span class="muted small">${dayLabel(l.expiry)}</span>` : ''}</td>
        <td>${l.entry.toFixed(2)}</td><td class="muted">${l.ltp != null ? l.ltp.toFixed(2) : '—'}</td>
        <td><input class="txt num" type="number" min="0" step="0.05" data-cpx="${l.id}" value="${esc(v)}" placeholder="price"></td>
        <td class="${cls(pnl)}" data-cpnl="${l.id}">${pnl == null ? '—' : inrS(Math.round(pnl))}</td></tr>`;
    };
    const b = st.bees;
    const bv = closeVal('bees', b?.now);
    const beesRow = beesToSell()
      ? `<tr class="mcl-grp"><td class="l"><b class="neg">Sell</b> ${num0(b.qty)} NIFTYBEES</td><td>${b.price.toFixed(2)}</td><td class="muted">${b.now.toFixed(2)}${b.live ? '' : ' (est.)'}</td>
        <td><input class="txt num" type="number" min="0.01" step="0.01" data-cpx="bees" value="${esc(bv)}" placeholder="price"></td>
        <td class="${cls(t.bees)}" data-cpnl="bees">${Number(bv) > 0 ? inrS(Math.round(b.qty * (Number(bv) - b.price))) : '—'}</td></tr>`
      : b?.exitPx && b.qty > 0
        ? `<tr class="mcl-closed"><td class="l">${num0(b.qty)} NIFTYBEES <span class="muted small">already sold</span></td><td>${b.price.toFixed(2)}</td><td></td><td>${b.exitPx.toFixed(2)}</td><td class="${cls(t.bees)}">${inrS(Math.round(t.bees))}</td></tr>`
        : `<tr class="mcl-closed"><td class="l muted" colspan="5">No NIFTYBEES entered for this trade: only the options are closed.</td></tr>`;
    return `<div class="mcl-close">
      <div class="set-row"><b>Close the entire trade</b> <span class="muted small">exit prices prefilled from the live LTP${b && !b.live && beesToSell() ? ' (NIFTYBEES estimated: type its real price)' : ''}; change them to the prices you actually got.</span>
        <button class="btn-sm ghost" id="mclCloseLive" title="Put the live prices back in every box">↻ Live prices</button></div>
      <div class="tbl-wrap"><table class="grid-tbl mcl-close-tbl"><thead><tr><th class="l">Exit</th><th>Entry</th><th>LTP</th><th>Exit price</th><th>P&amp;L</th></tr></thead>
        <tbody>${closeLegs().map(legRow).join('')}${beesRow}</tbody></table></div>
      <div class="set-row mcl-close-tot" id="mclCloseTot">${closeTotHtml(t)}</div>
      <div class="set-row">
        <button class="btn-sm danger" id="mclCloseGo">Record the close</button>
        ${window.KiteOrder ? '<button class="btn-sm kite" id="mclCloseKite" title="Send the option legs to Zerodha Kite as real exit orders (its own dialog asks you to confirm). NIFTYBEES is not sent: sell it in Kite yourself.">Close the options on Kite…</button>' : ''}
        <button class="btn-sm ghost" id="mclCloseCancel">Cancel</button>
        <span class="muted small" id="mclCloseMsg">Records the exits in the saved trade (Builder › Trades: the legs closed, the NIFTYBEES sold). Nothing is sent to a broker. You can undo it afterwards.</span>
      </div></div>`;
  }
  const closeTotHtml = (t) =>
    `<span>Options <span class="muted small">(legs closed before included)</span> <b class="${cls(t.opt)}">${inrS(Math.round(t.opt))}</b></span>
     <span>NIFTYBEES <b class="${cls(t.bees)}">${inrS(Math.round(t.bees))}</b></span>
     <span>Total <b class="${cls(t.total)}">${t.ok ? inrS(Math.round(t.total)) : '— a price is missing'}</b></span> <span class="muted small">before charges, as the Builder counts it</span>`;
  function bindClose() {
    $('mclCloseBtn')?.addEventListener('click', () => {
      closing = !closing;
      liveCloseVals();
      $('mclCloseBtn').textContent = closing ? 'Cancel close' : 'Close entire trade…';
      $('mclCloseBtn').classList.toggle('ghost', !closing);
      $('mclClosePanel').innerHTML = closing ? closePanelHtml() : '';
      bindClosePanel();
      if (closing) $('mclClosePanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    bindClosePanel();
  }
  function bindClosePanel() {
    const box = $('mclClosePanel');
    if (!box || !closing) return;
    box.querySelectorAll('[data-cpx]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const k = inp.dataset.cpx;
        closeVals[k] = inp.value;
        const v = Number(inp.value);
        let pnl = null;
        if (inp.value !== '' && v >= 0) {
          if (k === 'bees') pnl = v > 0 ? st.bees.qty * (v - st.bees.price) : null;
          else {
            const l = closeLegs().find((x) => String(x.id) === k);
            pnl = l ? l.side * (v - l.entry) * l.lots * lot() : null;
          }
        }
        const cell = box.querySelector(`[data-cpnl="${k}"]`);
        if (cell) {
          cell.className = cls(pnl);
          cell.textContent = pnl == null ? '—' : inrS(Math.round(pnl));
        }
        $('mclCloseTot').innerHTML = closeTotHtml(closeTotals());
      }),
    );
    $('mclCloseLive')?.addEventListener('click', () => {
      liveCloseVals();
      box.innerHTML = closePanelHtml();
      bindClosePanel();
    });
    $('mclCloseCancel')?.addEventListener('click', () => $('mclCloseBtn')?.click());
    $('mclCloseKite')?.addEventListener('click', () =>
      window.KiteOrder.open({
        title: 'Close the live trade on Kite',
        sub: `${st.pos.name} · the option legs only (sell the NIFTYBEES in Kite yourself)`,
        legs: closeLegs().map((l) => ({
          action: l.side > 0 ? 'S' : 'B',
          type: l.type,
          strike: l.strike,
          expiry: l.expiry,
          lots: l.lots,
          price: Number(closeVal(l.id, l.ltp)) || l.ltp,
        })),
        exit: true,
      }),
    );
    $('mclCloseGo')?.addEventListener('click', async () => {
      const t = closeTotals();
      const msg = $('mclCloseMsg');
      if (!t.ok) {
        msg.textContent = 'Enter an exit price for every leg' + (beesToSell() ? ' and the NIFTYBEES' : '') + '.';
        msg.className = 'small neg';
        return;
      }
      const lines = closeLegs().map((l) => `${l.side > 0 ? 'Sell' : 'Buy back'} ${l.lots} × ${l.strike} ${l.type} @ ${Number(closeVal(l.id, l.ltp)).toFixed(2)}`);
      if (beesToSell()) lines.push(`Sell ${st.bees.qty} NIFTYBEES @ ${Number(closeVal('bees', st.bees.now)).toFixed(2)}`);
      const sure = confirm(
        `Record the close of "${st.pos.name}"?\n\n${lines.join('\n')}\n\nTotal ${inrS(Math.round(t.total))} (options ${inrS(Math.round(t.opt))}, NIFTYBEES ${inrS(Math.round(t.bees))}).\nNothing is sent to a broker.`,
      );
      if (!sure) return;
      const px = Object.fromEntries(closeLegs().map((l) => [l.id, Number(closeVal(l.id, l.ltp))]));
      try {
        msg.textContent = 'Saving…';
        st = await BT.api('/api/mcc/live/close', { key: st.key, px, beesPx: beesToSell() ? Number(closeVal('bees', st.bees.now)) : null, confirm: true });
        closing = false;
        closeVals = {};
        sug = null;
        pick = null;
        draw();
      } catch (e) {
        msg.textContent = e.message;
        msg.className = 'small neg';
      }
    });
  }

  // A closed trade: its result as booked (options from the saved trade, NIFTYBEES bought → sold), no live prices.
  function drawClosed() {
    drawnShape = shape();
    const P = st.pos;
    const b = st.bees;
    const opt = P.realised.CE + P.realised.PE - (P.costs?.CE || 0) - (P.costs?.PE || 0);
    const bees = b?.qty > 0 && b.exitPx ? b.qty * (b.exitPx - b.price) : null;
    const total = opt + (bees || 0);
    const when = P.closedAt
      ? new Date(P.closedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : null;
    const legRows = ['CE', 'PE']
      .map((t) => {
        const ls = P.closed.filter((l) => l.type === t);
        if (!ls.length) return '';
        return (
          `<tr class="mcl-grp"><td class="l" colspan="4"><b>${t === 'CE' ? 'Call ratio spread' : 'Put butterfly'}</b></td><td class="${cls(P.realised[t])}"><b>${inrS(Math.round(P.realised[t]))}</b></td></tr>` +
          ls
            .map(
              (l) =>
                `<tr class="mcl-closed"><td class="l"><b class="${l.side < 0 ? 'neg' : 'pos'}">${l.side < 0 ? 'Sell' : 'Buy'}</b> ${l.lots} × ${l.strike} ${l.type}</td><td class="l muted small">${l.exitDay ? dayLabel(l.exitDay) + (l.exitAt ? ' ' + esc(l.exitAt) : '') : ''}</td><td>${l.entry.toFixed(2)}</td><td>${l.exit.toFixed(2)}</td><td class="${cls(l.pnl)}">${inrS(Math.round(l.pnl))}</td></tr>`,
            )
            .join('')
        );
      })
      .join('');
    const beesRow =
      b?.qty > 0
        ? `<tr class="mcl-grp"><td class="l"><b>NIFTYBEES</b> ${num0(b.qty)} units</td><td class="l muted small">${b.exitDay ? dayLabel(b.exitDay) + (b.exitAt ? ' ' + esc(b.exitAt) : '') : ''}</td><td>${b.price.toFixed(2)}</td><td>${b.exitPx ? b.exitPx.toFixed(2) : '<span class="muted">not sold</span>'}</td><td class="${cls(bees)}"><b>${bees == null ? '—' : inrS(Math.round(bees))}</b></td></tr>`
        : '';
    el.innerHTML = `<div class="panel cc-doc mcl-head">
      <div class="set-row"><h3>Live trade</h3>${pickerHtml()} <span class="cat-pill">closed</span>
        <button class="btn-sm ghost" id="mclToSb" title="Open this saved trade in the Builder">Load in Builder ▸</button>
        ${P.closeBatch ? '<button class="btn-sm ghost" id="mclReopen" title="Undo the close recorded on this tab: the legs it closed open again and the NIFTYBEES sale is removed">Undo close</button>' : ''}</div>
      <div class="muted small">${esc(P.name)} · expiry ${dayLabel(P.expiry)}${when ? ` · closed ${esc(when)}` : ''} · P&amp;L before charges, as the Builder shows it</div>
      <div class="kpis cc-kpis-main">
        <div class="kpi"><span class="k-l">Call ratio spread</span><span class="k-v ${cls(P.realised.CE)}">${inrS(Math.round(P.realised.CE))}</span></div>
        <div class="kpi"><span class="k-l">Put butterfly</span><span class="k-v ${cls(P.realised.PE)}">${inrS(Math.round(P.realised.PE))}</span></div>
        <div class="kpi"><span class="k-l">Options</span><span class="k-v ${cls(opt)}">${inrS(Math.round(opt))}</span></div>
        <div class="kpi"><span class="k-l">NIFTYBEES</span><span class="k-v ${cls(bees)}">${bees == null ? '—' : inrS(Math.round(bees))}</span><span class="muted small">${b?.qty > 0 ? `${num0(b.qty)} × ₹${b.price.toFixed(2)} → ${b.exitPx ? '₹' + b.exitPx.toFixed(2) : 'not sold'}` : 'none entered'}</span></div>
        <div class="kpi"><span class="k-l">Total</span><span class="k-v ${cls(total)}">${inrS(Math.round(total))}</span><span class="muted small">NIFTYBEES + options, booked</span></div>
      </div>
      ${b?.qty > 0 && !b.exitPx ? '<div class="muted small">The NIFTYBEES sale is not recorded: enter it in the Builder (Modified covered call › Sold at ₹) and save the trade.</div>' : ''}
      <span class="small" id="mclMsg"></span></div>
      <div class="panel cc-doc"><h3>Legs</h3><div class="tbl-wrap"><table class="grid-tbl mcl-legs"><thead><tr><th class="l">Leg</th><th class="l">Closed</th><th>Entry</th><th>Exit</th><th>P&amp;L</th></tr></thead><tbody>${legRows}${beesRow}
        <tr class="mcl-tot"><td class="l" colspan="4"><b>Total</b></td><td class="${cls(total)}"><b>${inrS(Math.round(total))}</b></td></tr></tbody></table></div></div>`;
    bindPick();
    $('mclToSb')?.addEventListener('click', () => BT.emit('open-trade', P.id));
    $('mclReopen')?.addEventListener('click', async () => {
      if (!confirm(`Undo the close of "${P.name}"? The legs closed on this tab open again at their entry prices, and the NIFTYBEES sale recorded with them is removed.`)) return;
      try {
        st = await BT.api('/api/mcc/live/reopen', { key: st.key, confirm: true });
        sug = null;
        pick = null;
        draw();
        if (st?.pos && !st.closed) findSuggestions();
      } catch (e) {
        $('mclMsg').textContent = e.message;
        $('mclMsg').className = 'small neg';
      }
    });
  }

  // Back on this screen from another (the Builder may have changed the trade): read it again and poll again (the poll
  // stops while the tab is not shown).
  window.addEventListener('viewchange', (e) => {
    if (e.detail !== 'cc' || !el) return;
    setTimeout(async () => {
      if (!shown()) return;
      await load();
      refresh();
      poll();
    }, 0);
  });

  window.MccLive = { render };
})();
