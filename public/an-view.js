// Arbitrage screen (the anomaly scanner). On top: the types as chips (numbered by how easy each is to trade), a strictness
// preset, a Tune drawer with every threshold, and alerts. Below either the live scanner (one card per opportunity:
// the legs at bid / ask, the edge, what is left after costs and for how many lots; today's log) or a history scan
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
  let scanCtl = null; // the running scan: { stop } (see BT.runJob)
  let hitFilter = 'all';
  let alertOn = BT.store.get('anAlert', false);
  let saveTimer = null;
  const scanOpts = { start: '09:20', end: '15:15', step: 1, ...BT.store.get('anScanOpts', {}) };

  // easiest to trade first
  const types = () => (BT.meta.anomalies || []).slice().sort((a, b) => (a.ease?.rank ?? 9) - (b.ease?.rank ?? 9));
  const typeOf = (id) => (BT.meta.anomalies || []).find((t) => t.id === id);
  const shortName = (t) => t.name.replace(' arbitrage', '');
  const UNIT = { pts: ' pts', vol: ' vol', '%': '%', '₹': '', '×': '×' };
  const fmtVal = (h) => `${h.unit === '₹' ? '₹' : ''}${num(h.value, Math.abs(h.value) >= 100 ? 0 : 2)}${UNIT[h.unit] ?? ''}`;
  const lotSize = () => BT.meta.calendar?.liveLot || 65;
  const lotsTxt = (n) => `${n} lot${n === 1 ? '' : 's'}`;

  function init() {
    if (!inited) {
      inited = true;
      settings = BT.createSettings($('anSettings'), { onRun: runScan, onStop: () => { if (scanCtl) scanCtl.stop = true; }, runLabel: 'Scan history', key: 'settings' });
      BT.on('meta', () => { ensureCfg(); renderTypes(); });
      $('anTune').classList.toggle('hidden', !BT.store.get('anTune', false));
      renderAlertBtn();
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

  // ---------- strictness presets ----------
  // The size of the edge and the quantity that must be on the book; the other thresholds stay as they are.
  const PRESETS = { strict: { edge: 2, pct: 1.5, lots: 3 }, balanced: { edge: 1, pct: 1, lots: 1 }, loose: { edge: 0.5, pct: 0.6, lots: 1 } };
  const presetVal = (p, m) => (p.k === 'minEdge' ? p.def * m.edge : p.k === 'minPct' ? p.def * m.pct : p.k === 'minLots' ? m.lots : null);
  function applyPreset(name) {
    for (const t of types()) for (const p of t.params) {
      const v = presetVal(p, PRESETS[name]);
      if (v != null) (cfg.params[t.id] ||= {})[p.k] = v;
    }
  }
  const presetNow = () => Object.keys(PRESETS).find((name) => types().every((t) => t.params.every((p) => {
    const v = presetVal(p, PRESETS[name]);
    return v == null || Number(pval(t, p.k, p.def)) === v;
  })));

  // ---------- types: chips on the bar, thresholds in the Tune drawer ----------
  function renderChips() {
    if (!cfg) return;
    const firing = {};
    for (const h of liveState?.active || []) firing[h.type] = (firing[h.type] || 0) + 1;
    $('anChips').innerHTML = types().map((t) => `<button class="an-chip${cfg.enabled[t.id] ? ' on' : ''}" data-chip="${t.id}" title="${esc(t.desc)}&#10;&#10;${esc(t.ease?.why || '')}">
      <i class="an-rank">${t.ease?.rank ?? ''}</i>${esc(shortName(t))}${mode === 'live' && cfg.enabled[t.id] && firing[t.id] ? ` <i class="an-n">${firing[t.id]}</i>` : ''}</button>`).join('');
    const pn = presetNow();
    $('anPreset').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === pn));
  }
  function renderTypes() {
    if (!cfg) return;
    renderChips();
    $('anTypes').innerHTML = types().map((t) => `<div class="an-type${cfg.enabled[t.id] ? ' on' : ''}" data-id="${t.id}">
        <label class="an-type-head"><input type="checkbox" data-en="${t.id}" ${cfg.enabled[t.id] ? 'checked' : ''}><i class="an-rank" title="How easy it is to trade: 1 = easiest">${t.ease?.rank ?? ''}</i><b>${esc(t.name)}</b></label>
        <div class="muted small">${esc(t.desc)}</div>
        <div class="an-params">${t.params.map((p) => `<label class="mini">${esc(p.label)} <input class="num" type="number" step="${p.step}" data-param="${t.id}.${p.k}" value="${pval(t, p.k, p.def)}"><span class="muted">${esc(p.unit)}</span></label>`).join('')}
          <label class="mini" title="One entry in the log per opportunity and strike every this many minutes">Cooldown <input class="num" type="number" min="1" step="5" data-param="${t.id}.cooldown" value="${pval(t, 'cooldown', t.cooldown)}"><span class="muted">min</span></label></div>
        <div class="small an-how"><b>Trade:</b> ${esc(t.how)}</div>
        ${t.ease ? `<div class="small an-how"><b>Tradability:</b> ${esc(t.ease.why)} <b>Watch:</b> ${esc(t.ease.watch)}</div>` : ''}
        <div class="an-type-actions">
          <select data-btdir="${t.id}">${t.dirs.flatMap((d) => (t.sided ? ['CE', 'PE'].map((sd) => `<option value="${d}|${sd}">${d} · ${sd}</option>`) : [`<option value="${d}|">${d}</option>`])).join('')}</select>
          <button class="btn-sm ghost" data-bt="${t.id}" title="Open a signal strategy for this type in the Backtest editor">Backtest as strategy ▸</button>
        </div>
      </div>`).join('');
  }
  // Every change is kept in this browser and applied to the live scanner (saved on the server) straight away.
  function persist() {
    BT.store.set('anCfg', cfg);
    renderChips();
    $('anCfgMsg').textContent = '· saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await BT.api('/api/an/config', cfg);
        $('anCfgMsg').textContent = '· settings applied to the live scanner ✓';
        if (mode === 'live') pollLive();
      } catch (e) { $('anCfgMsg').textContent = '· could not save: ' + e.message; }
    }, 500);
  }

  $('anChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b || !cfg) return;
    cfg.enabled[b.dataset.chip] = !cfg.enabled[b.dataset.chip];
    persist();
    renderTypes();
  });
  $('anPreset').addEventListener('click', (e) => {
    if (!e.target.dataset.p || !cfg) return;
    applyPreset(e.target.dataset.p);
    persist();
    renderTypes();
  });
  $('anTuneBtn').addEventListener('click', () => BT.store.set('anTune', !$('anTune').classList.toggle('hidden')));
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
      ? 'The server scans the nearest expiry every 5 s during market hours, also when this page is closed.'
      : 'Rebuilds the nearest weekly chain minute by minute from 1-minute history and runs the types that are switched on.';
    clearTimeout(liveTimer);
    renderChips();
    if (m === 'live') pollLive(); else { renderScanOpts(); loadSavedScan(); }
  }
  $('anMode').addEventListener('click', (e) => { if (e.target.dataset.m) setMode(e.target.dataset.m); });

  // ---------- costs ----------
  // The backtester's charges (bt/engine.js execCost): ₹20 an order, STT on sells, exchange and SEBI fees, GST on
  // those and stamp duty on buys. An arbitrage is held to expiry, so only its entry orders are charged, plus the
  // STT a long option pays when it is exercised in the money (on its value, taken at today's Nifty). A fair-value
  // trade is closed again, so it pays both ways.
  const COST = { brokerage: 20, stt: 0.001, txn: 0.0003503, sebi: 0.000001, gst: 0.18, stamp: 0.00003, exStt: 0.00125 };
  const legPx = (l) => (l.action === 'B' ? l.ask : l.bid) || l.ltp || null;
  // { gross, cost, net } in ₹ for `lots` structures of the hit's suggested trade, or null when a leg has no price.
  function money(h, lots) {
    const legs = h.legs || [];
    if (!legs.length || legs.some((l) => !legPx(l))) return null;
    const round = h.type === 'fv';
    const q = lots * lotSize();
    let buy = 0;
    let sell = 0;
    let ex = 0;
    for (const l of legs) {
      const turn = legPx(l) * l.lots * q;
      if (l.action === 'B') {
        buy += turn;
        if (!round && h.spot) ex += Math.max(0, l.type === 'CE' ? h.spot - l.strike : l.strike - h.spot) * l.lots * q * COST.exStt;
      } else sell += turn;
    }
    if (round) buy = sell = buy + sell;
    const orders = legs.length * (round ? 2 : 1) + (legs.some((l) => l.expiry === 'next') ? 1 : 0); // the calendar's long call is sold later
    const brk = orders * COST.brokerage;
    const fees = (buy + sell) * (COST.txn + COST.sebi);
    const cost = brk + sell * COST.stt + fees + COST.gst * (brk + fees) + buy * COST.stamp + ex;
    const gross = h.value * q;
    return { gross, cost, net: gross - cost };
  }
  // What the hit is worth to a trader: state 'good' (pays after costs on one lot), 'size' (pays from a number of
  // lots the book can fill) or 'bad' (not executable, or costs exceed the edge at the fillable size).
  function verdict(h) {
    const fit = h.fit || 1;
    const one = money(h, 1);
    const all = money(h, fit);
    let be = null; // smallest size that pays
    if (one) for (let n = 1; n <= 500; n++) if (money(h, n).net > 0) { be = n; break; }
    const v = { fit, one, all, be, state: 'bad', label: 'Costs exceed the edge' };
    if (!one) v.label = 'No quote on a leg';
    else if (h.exec != null && h.exec <= 0) v.label = 'Not executable at bid / ask';
    else if (one.net > 0) Object.assign(v, { state: 'good', label: 'Profitable after costs' });
    else if (be && be <= fit) Object.assign(v, { state: 'size', label: `Profitable from ${lotsTxt(be)}` });
    else if (be) v.label = `Needs ${lotsTxt(be)}, book fills ${fit}`;
    return v;
  }

  // ---------- alerts ----------
  const alerted = new Map(); // opportunity -> when it was last seen paying
  let primed = false; // what is already there when the page opens does not alert
  function renderAlertBtn() {
    $('anAlertBtn').textContent = alertOn ? '🔔 Alerts on' : '🔕 Alerts off';
    $('anAlertBtn').classList.toggle('on', alertOn);
  }
  $('anAlertBtn').addEventListener('click', () => {
    alertOn = !alertOn;
    BT.store.set('anAlert', alertOn);
    renderAlertBtn();
    if (alertOn) { beep(); if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); }
  });
  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.35);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.35);
      o.onended = () => ac.close();
    } catch {}
  }
  // An opportunity that starts paying after costs alerts once; again only after it has been gone for 10 minutes.
  function alertNew(rows) {
    const now = Date.now();
    const fresh = [];
    for (const [h, , v] of rows) {
      if (v.state === 'bad') continue;
      const key = `${h.type}|${h.side}|${h.dir}|${h.strike}|${h.ref}`;
      const last = alerted.get(key);
      alerted.set(key, now);
      if (primed && (!last || now - last > 600_000)) fresh.push([h, v]);
    }
    primed = true;
    if (!alertOn || !fresh.length) return;
    beep();
    if (window.Notification && Notification.permission === 'granted') {
      const [h, v] = fresh[0];
      try { new Notification(`Arbitrage: ${headline(h)}`, { body: `${v.label} · ${inrS(Math.round(v.all.net))} on ${lotsTxt(v.fit)}${fresh.length > 1 ? ` · and ${fresh.length - 1} more` : ''}` }); } catch {}
    }
  }

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

  // The opportunity in plain words.
  function headline(h) {
    const k = `${h.strike}${h.ref != null ? ' / ' + h.ref : ''}`;
    switch (h.type) {
      case 'box': return `${k} box is ${h.dir === 'cheap' ? 'underpriced: buy it' : 'overpriced: sell it'}`;
      case 'fly': return `${h.strike} ${h.side} butterfly pays a credit`;
      case 'varb': return `${k} ${h.side} spread: ${h.dir === 'free-credit' ? 'free credit' : 'credit above its width'}`;
      case 'cal': return `${h.strike} CE: next expiry cheaper than this one`;
      case 'fv': return `${h.strike} ${h.side} is ${h.dir === 'rich' ? 'overpriced' : 'underpriced'} by ${num(h.pct, 1)}%`;
      default: return `${typeOf(h.type)?.name || h.type} ${k}`;
    }
  }
  function legsHtml(h) {
    return (h.legs || []).map((l) => `<span class="leg-chip ${l.action === 'B' ? 'buy' : 'sell'}" title="bid ${num(l.bid)}${l.bidQ ? ' × ' + l.bidQ : ''} / ask ${num(l.ask)}${l.askQ ? ' × ' + l.askQ : ''}">${l.action === 'B' ? 'B' : 'S'}${l.lots > 1 ? l.lots + '×' : ''} ${l.strike}${l.type}${l.expiry === 'next' ? ' nxt' : ''} ${l.ltp ? '@' + num(l.ltp) : ''}</span>`).join(' ');
  }
  // The legs as an order ticket: what to do, at which side of the book, and how many lots wait there.
  function ticket(h) {
    return `<div class="an-legs">${(h.legs || []).map((l) => {
      const buy = l.action === 'B';
      const q = buy ? l.askQ : l.bidQ;
      return `<b class="${buy ? 'pos' : 'neg'}">${buy ? 'BUY' : 'SELL'}</b><span>${l.lots > 1 ? l.lots + ' × ' : ''}${l.strike} ${l.type}${l.expiry === 'next' ? ' <span class="muted">next expiry</span>' : ''}</span>
        <span class="p">${legPx(l) ? num(legPx(l)) : '—'} <span class="muted small">${buy ? 'ask' : 'bid'}</span></span><span class="q">${q ? lotsTxt(Math.floor(q / (lotSize() * l.lots))) + ' there' : ''}</span>`;
    }).join('')}</div>`;
  }
  const money0 = (x) => `<b class="${cls(x)}">${inrS(Math.round(x))}</b>`;
  function card(h, i, v) {
    const t = typeOf(h.type);
    const fv = h.type === 'fv';
    const tiles = !v.one ? '' : `<div class="an-nums">
        <div title="${fv ? 'Distance to fair value' : 'Locked in at expiry'}, before brokerage and taxes"><span>Edge before costs</span><b>${fmtVal(h)}</b><i>${inrS(Math.round(v.one.gross))} per lot</i></div>
        <div title="Brokerage, STT, exchange fees, GST and stamp duty${fv ? ' for the entry and the exit' : '; held to expiry, so no exit orders'}"><span>After costs · 1 lot</span>${money0(v.one.net)}<i>costs ${inrS(Math.round(v.one.cost))}</i></div>
        ${v.fit > 1
          ? `<div title="The most the best bid / ask can fill on every leg"><span>After costs · ${lotsTxt(v.fit)}</span>${money0(v.all.net)}<i>all the book fills</i></div>`
          : `<div title="The fixed brokerage is spread over more lots as the size grows"><span>Pays from</span><b>${v.be ? lotsTxt(v.be) : 'never'}</b><i>book fills ${lotsTxt(v.fit)}</i></div>`}
      </div>`;
    const note = fv
      ? `Market ${num(h.mkt)} vs fair value ${num(h.fair)}${h.ivMkt == null ? '' : ` · IV ${num(h.ivMkt, 1)}% vs ${num(h.ivFair, 1)}% at the neighbouring strikes`}. Exit when it is back at fair value.`
      : h.exec > 0 ? `Locks ${num(h.exec)} pts at bid / ask wherever Nifty expires.` : '';
    return `<div class="an-card ${v.state}">
      <div class="an-card-top"><i class="an-rank" title="How easy this type is to trade: 1 = easiest. ${esc(t?.ease?.why || '')}">${t?.ease?.rank ?? ''}</i>${esc(t ? shortName(t) : h.type)}${fv ? ' · not risk-free' : ''}<span class="an-badge ${v.state}">${esc(v.label)}</span></div>
      <h4>${esc(headline(h))}</h4>
      ${ticket(h)}
      ${tiles}
      <div class="an-watch">${note ? esc(note) + ' ' : ''}${t?.ease ? '<b>Watch:</b> ' + esc(t.ease.watch) : ''}</div>
      <div class="an-card-foot"><button class="btn-sm" data-dep="${i}" data-list="active" title="Resolve this trade on the live chain (Strategies tab)">Deploy ▸</button>
        <button class="btn-sm ghost" data-hbt="${i}" data-list="active" title="Backtest this as a signal strategy">Backtest ▸</button></div>
    </div>`;
  }
  function logRow(h, i) {
    const t = typeOf(h.type);
    const one = money(h, 1);
    return `<tr>
      <td>${window.app.istClock(h.t)}</td>
      <td class="l">${esc(t ? shortName(t) : h.type)}</td>
      <td class="l wrap"><b>${esc(headline(h))}</b><div>${legsHtml(h)}</div></td>
      <td class="b">${fmtVal(h)}</td>
      <td class="${one ? cls(one.net) : 'muted'}">${one ? inrS(Math.round(one.net)) : '—'}</td>
      <td>${h.fit == null ? '—' : lotsTxt(h.fit)}</td>
      <td class="nowrap"><button class="btn-sm ghost" data-dep="${i}" data-list="log" title="Resolve this trade on the live chain (Strategies tab)">Deploy ▸</button>
        <button class="btn-sm ghost" data-hbt="${i}" data-list="log" title="Backtest this as a signal strategy">Backtest ▸</button></td>
    </tr>`;
  }

  const ORDER = { good: 0, size: 1, bad: 2 };
  function renderLive() {
    const s = liveState;
    const m = s.metrics;
    const st = s.status || {};
    renderChips();
    // what pays after costs first, then the bigger gain at the size the book fills
    const rows = s.active.map((h, i) => [h, i, verdict(h)])
      .sort((a, b) => ORDER[a[2].state] - ORDER[b[2].state] || (b[2].all?.net ?? -Infinity) - (a[2].all?.net ?? -Infinity));
    alertNew(rows);
    const pay = rows.filter((r) => r[2].state !== 'bad').length;
    const anyOn = types().some((t) => s.config?.enabled?.[t.id]);
    const tile = (l, v, sub = '') => `<div class="kpi"><span class="k-l">${l}</span><span class="k-v">${v}</span><span class="k-s">${sub}</span></div>`;
    const logOpen = $('anLive').querySelector('.an-logd')?.open;
    $('anLive').innerHTML = `
      <div class="panel res-head">
        <div class="res-title"><h3>${pay ? `${pay} opportunit${pay === 1 ? 'y pays' : 'ies pay'} after costs` : 'Nothing pays after costs right now'} ${m ? `<span class="muted small">· expiry ${dayShort(m.expiry)}</span>` : ''}</h3>
          <span class="muted small">${st.ok ? `last scan ${window.app.istClock(st.at)}` : esc(st.reason || 'waiting')}${st.ok && st.reason ? ' · ' + esc(st.reason) : ''}</span></div>
        ${m ? `<div class="kpis">
          ${tile('Pays after costs', pay, `${rows.length} found · ${s.log.length} logged today`)}
          ${tile('Nifty / forward', num(m.spot, 1), `forward ${num(m.forward, 1)} · basis ${num(m.basis, 1)}`)}
          ${tile('ATM IV', m.atmIv == null ? '—' : m.atmIv + '%', `at 09:20 ${m.dayIv ?? '—'}%`)}
          ${tile('Skew (RR 4)', m.rr == null ? '—' : num(m.rr, 1), 'OTM put IV − OTM call IV')}
          ${tile('IV / RV', m.ivrv == null ? '—' : num(m.ivrv) + '×', `5-day realised ${m.rv5 ?? '—'}%`)}
        </div>` : ''}
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Opportunities now</h3><span class="muted small">best first · sells priced at the bid, buys at the ask · costs as in the backtester (₹${COST.brokerage} an order plus taxes), lot ${lotSize()}</span></div>
        ${rows.length ? `<div class="an-cards">${rows.map(([h, i, v]) => card(h, i, v)).join('')}</div>`
          : `<div class="muted pad">${anyOn ? 'No mispricing on the chain with the current thresholds. Try the Loose strictness to see smaller edges.' : 'Every type is switched off: click a type above to scan for it.'}</div>`}
      </div>
      <details class="panel an-logd" ${logOpen === false ? '' : 'open'}>
        <summary>Today's log <span class="muted small">· ${s.log.length} entries · each opportunity once per cooldown · saved to bt-data/anomaly-log/</span></summary>
        ${s.log.length ? `<div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Time</th><th class="l">Type</th><th class="l">Opportunity and trade</th><th>Edge</th><th title="For one lot, at the prices when it was logged">After costs · 1 lot</th><th>Fillable</th><th></th></tr></thead>
          <tbody>${s.log.map((h, i) => logRow(h, i)).join('')}</tbody></table></div>` : '<div class="muted pad">Nothing logged today yet (logging runs during market hours).</div>'}
      </details>`;
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
      <p>Switch on the types above, choose a period and press <b>Scan history</b>. The first scan of a period downloads the option candles it needs (strikes around the Nifty path); later scans are instant.</p>
      <p class="muted">Use <b>Backtest as strategy</b> on a type (under ⚙ Tune) for a full simulation with stops, costs and re-entries.</p></div>`;
  }
  $('anScanOpts').addEventListener('change', (e) => {
    const k = e.target.dataset.o;
    if (!k) return;
    scanOpts[k] = k === 'step' ? Number(e.target.value) : e.target.value;
    BT.store.set('anScanOpts', scanOpts);
  });

  // The last scan is saved on the server: show it when the screen opens, until a new one is run.
  let savedAsked = false;
  async function loadSavedScan() {
    if (scan || savedAsked) return;
    savedAsked = true;
    try {
      const r = await BT.api('/api/bt/scan/last');
      if (r.scan && !scan) { scan = r.scan; renderScan(); }
    } catch {}
  }

  async function runScan() {
    let o;
    try { o = settings.get(); } catch (e) { $('anHistRes').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`; return; }
    const sel = types().filter((t) => cfg?.enabled[t.id]).map((t) => ({ id: t.id, params: cfg.params[t.id] || {} }));
    if (!sel.length) { $('anHistRes').innerHTML = '<div class="panel empty err">Switch on at least one type above.</div>'; return; }
    settings.setBusy(true);
    scanCtl = { stop: false };
    try {
      const job = await BT.runJob('/api/bt/scan', { from: o.from, to: o.to, expiries: o.expiries, lotSize: o.lotSize, types: sel, ...scanOpts }, settings.progress, scanCtl);
      scan = job.result;
      hitFilter = 'all';
      renderScan();
    } catch (e) {
      $('anHistRes').innerHTML = `<div class="panel empty err"><b>Scan failed:</b> ${esc(e.message)}</div>`;
    } finally {
      scanCtl = null;
      settings.setBusy(false);
    }
  }

  // ₹ for one lot of an occurrence's trade to the end of the window: before costs, and after the charges of
  // entering and closing it (exit turnover taken as the entry's, as the scan keeps only the entry prices).
  function scanPnl(h, lot) {
    if (h.out?.eod == null) return null;
    const gross = h.out.eod * lot;
    const turn = (h.out.entry || []).reduce((s, l) => s + Math.abs(l.d) * l.px * lot, 0);
    const brk = 2 * (h.out.entry || []).length * COST.brokerage;
    const fees = 2 * turn * (COST.txn + COST.sebi);
    return { gross, net: gross - (brk + turn * COST.stt + fees + COST.gst * (brk + fees) + turn * COST.stamp) };
  }
  // Open an occurrence in the Builder's historical replay: the suggested legs at the scan's entry minute and prices.
  function replayHit(h) {
    const [hh, mm] = h.time.split(':').map(Number);
    const t = hh * 60 + mm + 1; // entered at the next minute's open
    const time = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const name = typeOf(h.type)?.name || h.type;
    BT.emit('open-builder', {
      strategy: strategyFor(h.type, h.dir, h.side, h.legs), src: 'hist', expiry: h.expiry, day: h.day, time, session: 'intraday', lot: scan.opts.lot,
      legs: h.out.entry.map((l) => ({ action: l.d > 0 ? 'B' : 'S', type: l.t, strike: l.s, expiry: l.e || h.expiry, lots: Math.abs(l.d), px: l.px })),
      note: `${name} · ${dayShort(h.day)} ${h.time} · ${h.text}`,
    });
  }

  function renderScan() {
    const r = scan;
    const H = r.horizons;
    const hl = (h) => (h === 'eod' ? 'to end' : h + 'm');
    const rows = r.summary.slice().sort((a, b) => b.hits - a.hits);
    const hours = ['09', '10', '11', '12', '13', '14', '15'];
    const hits = hitFilter === 'all' ? r.hits : r.hits.filter((h) => h.type === hitFilter);
    $('anHistRes').innerHTML = `
      <div class="panel res-head"><div class="res-title"><h3>${r.hitsTotal} anomalies over ${r.days} sessions${r.stopped ? ` <span class="cat-pill c-mine" title="Stop was pressed: only the sessions scanned until then are included, and occurrences whose outcome was not measured yet show —">stopped early · ${r.days} of ${r.daysTotal} sessions</span>` : ''}</h3>
        <span class="muted small">${dayLabel(r.opts.from)} → ${dayLabel(r.opts.to)} · ${r.opts.start}–${r.opts.end} every ${r.opts.step} min · lot ${r.opts.lot} · scanned ${dayShort(new Date(r.savedAt + 5.5 * 3600_000).toISOString().slice(0, 10))} ${window.app.istClock(r.savedAt)} in ${(r.ms / 1000).toFixed(1)} s, saved${r.skipped.length ? ` · ${r.skipped.length} sessions skipped` : ''}</span></div></div>
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
          }).join('') || `<tr><td colspan="${H.length + 7}" class="muted l">Nothing found with these thresholds: try the Loose strictness.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Occurrences</h3>
          <select id="anHitFilter"><option value="all">All types</option>${rows.map((s) => `<option value="${s.type}" ${hitFilter === s.type ? 'selected' : ''}>${esc(typeOf(s.type)?.name || s.type)}</option>`).join('')}</select>
          <span class="muted small">${hits.length > 400 ? 'latest 400 of ' + hits.length : hits.length} shown</span></div>
        <div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Day</th><th>Time</th><th class="l">Anomaly</th><th>Strike</th><th>Dir</th><th>Size</th><th class="l">Detail</th><th>ATM IV</th>${H.map((h) => `<th>${hl(h)}</th>`).join('')}<th>Best / worst</th><th title="One lot of the suggested trade, entered at the next minute's open and held to the end of the scan window, before costs">P&amp;L ₹ / lot</th><th title="The same after brokerage (₹${COST.brokerage} an order, entry and exit), STT, exchange fees, GST and stamp duty">After costs</th><th></th></tr></thead>
          <tbody>${hits.slice(-400).reverse().map((h) => `<tr><td>${dayShort(h.day)}</td><td>${h.time}</td><td class="l">${esc(typeOf(h.type)?.name || h.type)}</td>
            <td>${h.strike}${h.side ? ' ' + h.side : ''}</td><td><span class="dir-pill">${esc(h.dir)}</span></td><td>${fmtVal(h)}</td><td class="l wrap">${esc(h.text)}</td><td>${h.atmIv ?? '—'}</td>
            ${H.map((x) => { const v = h.out?.[x]; return v == null ? '<td class="muted">—</td>' : `<td class="${cls(v)}">${num(v)}</td>`; }).join('')}
            <td class="small">${h.out ? `<span class="pos">${num(h.out.best)}</span> / <span class="neg">${num(h.out.worst)}</span>` : '—'}</td>
            ${(() => { const p = scanPnl(h, r.opts.lot); return p ? `<td class="${cls(p.gross)} b">${inrS(Math.round(p.gross))}</td><td class="${cls(p.net)}">${inrS(Math.round(p.net))}</td>` : '<td class="muted">—</td><td class="muted">—</td>'; })()}
            <td class="nowrap"><button class="btn-sm ghost" data-rp="${r.hits.indexOf(h)}" ${h.out?.entry ? '' : 'disabled'} title="Replay this occurrence in the Builder: same expiry, day, entry minute, strikes and prices">▶ Replay</button></td></tr>`).join('')}</tbody></table></div>
      </div>`;
  }
  $('anHistRes').addEventListener('click', (e) => {
    const a = e.target.closest('[data-f]');
    if (a) { e.preventDefault(); hitFilter = a.dataset.f; renderScan(); return; }
    const rp = e.target.closest('[data-rp]');
    if (rp) { replayHit(scan.hits[Number(rp.dataset.rp)]); return; }
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
