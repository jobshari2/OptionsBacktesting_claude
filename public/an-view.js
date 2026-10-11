// Arbitrage screen (the anomaly scanner). On top: the types as chips (numbered by how easy each is to trade), a strictness
// preset, a Tune drawer with every threshold and the shared quality gates, and alerts. Below either the live scanner
// (arbitrage candidates and relative-value signals kept apart; one card per opportunity with the legs at bid / ask,
// the edge, what is left after costs and for how many lots; the scanner's health, the rejected signals with their
// reason, put-call parity by strike, today's log) or a history scan: every occurrence over a period taken through
// the checks that tell a real mispricing from prices that were only out of step — on 1-minute candles of last
// trades, or on the app's own recordings of the bid and ask.
(() => {
  const { $, esc, inrS, num, cls, dayShort, dayLabel } = BT;
  let inited = false;
  let mode = BT.store.get('anMode', 'live');
  let cfg = BT.store.get('anCfg', null); // { enabled: {id: bool}, params: {id: {...}}, quality: {...} }
  let settings = null;
  let liveTimer = null;
  let liveState = null;
  const scans = {}; // last history scan per source ('candles' | 'quotes')
  let tapes = null; // sessions with recorded quotes
  let scanCtl = null; // the running scan: { stop } (see BT.runJob)
  let hitFilter = 'all';
  let occFilter = 'all'; // occurrences shown: all | fill | pay
  let alertOn = BT.store.get('anAlert', false);
  let minNet = Number(BT.store.get('anMinNet', 0)) || 0;
  let saveTimer = null;
  const scanOpts = { source: 'candles', start: '09:20', end: '15:15', step: 1, lots: 10, day: 'all', every: 5, latency: 3, ...BT.store.get('anScanOpts', {}) };

  // easiest to trade first
  const types = () => (BT.meta.anomalies || []).slice().sort((a, b) => (a.ease?.rank ?? 9) - (b.ease?.rank ?? 9));
  const typeOf = (id) => (BT.meta.anomalies || []).find((t) => t.id === id);
  const shortName = (t) => t.name.replace(' arbitrage', '');
  // a type's own thresholds, and the quality gates every type shares (marked q in the catalogue)
  const own = (t) => t.params.filter((p) => !p.q);
  const gates = () => (BT.meta.anomalies?.[0]?.params || []).filter((p) => p.q);
  // 'arb' (a no-arbitrage bound) or 'rv' (a relative-value signal): the two are never ranked together
  const clsOf = (h) => h.cls || typeOf(h.type)?.cls || 'arb';
  const UNIT = { pts: ' pts', vol: ' vol', '%': '%', '₹': '', '×': '×' };
  const fmtVal = (h) => `${h.unit === '₹' ? '₹' : ''}${num(h.value, Math.abs(h.value) >= 100 ? 0 : 2)}${UNIT[h.unit] ?? ''}`;
  const lotSize = () => liveState?.lot || BT.meta.calendar?.liveLot || 65;
  const lotsTxt = (n) => `${n} lot${n === 1 ? '' : 's'}`;
  const pctOf = (n, d) => (d ? ` <span class="muted small">${Math.round((n / d) * 100)}%</span>` : '');

  function init() {
    if (!inited) {
      inited = true;
      settings = BT.createSettings($('anSettings'), {
        onRun: runScan,
        onStop: () => {
          if (scanCtl) scanCtl.stop = true;
        },
        runLabel: 'Scan history',
        key: 'settings',
      });
      BT.on('meta', () => {
        ensureCfg();
        renderTypes();
      });
      $('anTune').classList.toggle('hidden', !BT.store.get('anTune', false));
      $('anMinNet').value = minNet || '';
      renderAlertBtn();
    }
    if (BT.meta.loaded) {
      ensureCfg();
      renderTypes();
    }
    settings.reload();
    setMode(mode);
  }

  async function ensureCfg() {
    if (cfg && types().length) {
      for (const t of types()) if (cfg.enabled[t.id] == null) cfg.enabled[t.id] = true; // types added since this browser saved its settings start enabled
      cfg.params ||= {};
      cfg.quality ||= {};
      // the quality gates used to be kept per type: they are one shared set now
      for (const p of Object.values(cfg.params)) for (const g of gates()) delete p?.[g.k];
    }
    if (cfg || !types().length) return;
    cfg = { enabled: Object.fromEntries(types().map((t) => [t.id, true])), params: {}, quality: {} };
    try {
      const st = await BT.api('/api/an/live');
      if (st.config?.enabled) cfg = { enabled: { ...st.config.enabled }, params: { ...st.config.params }, quality: { ...st.config.quality } };
    } catch {}
    BT.store.set('anCfg', cfg);
    renderTypes();
  }
  const pval = (t, k, def) => cfg?.params?.[t.id]?.[k] ?? def;
  const qval = (k) => cfg?.quality?.[k] ?? gates().find((p) => p.k === k)?.def;

  // ---------- strictness presets ----------
  // The size of the edge and the quantity that must be on the book; the other thresholds stay as they are.
  const PRESETS = { strict: { edge: 2, pct: 1.5, lots: 3 }, balanced: { edge: 1, pct: 1, lots: 1 }, loose: { edge: 0.5, pct: 0.6, lots: 1 } };
  const presetVal = (p, m) => (p.k === 'minEdge' ? p.def * m.edge : p.k === 'minPct' ? p.def * m.pct : null);
  function applyPreset(name) {
    for (const t of types())
      for (const p of own(t)) {
        const v = presetVal(p, PRESETS[name]);
        if (v != null) (cfg.params[t.id] ||= {})[p.k] = v;
      }
    cfg.quality.minLots = PRESETS[name].lots;
  }
  const presetNow = () =>
    Object.keys(PRESETS).find(
      (name) =>
        Number(qval('minLots')) === PRESETS[name].lots &&
        types().every((t) =>
          own(t).every((p) => {
            const v = presetVal(p, PRESETS[name]);
            return v == null || Number(pval(t, p.k, p.def)) === v;
          }),
        ),
    );

  // ---------- types: chips on the bar, thresholds in the Tune drawer ----------
  function renderChips() {
    if (!cfg) return;
    const firing = {};
    for (const h of liveState?.active || []) if (!h.pending) firing[h.type] = (firing[h.type] || 0) + 1;
    $('anChips').innerHTML = types()
      .map(
        (t) => `<button class="an-chip${cfg.enabled[t.id] ? ' on' : ''}" data-chip="${t.id}" title="${esc(t.desc)}&#10;&#10;${esc(t.ease?.why || '')}">
      <i class="an-rank">${t.ease?.rank ?? ''}</i>${esc(shortName(t))}${mode === 'live' && cfg.enabled[t.id] && firing[t.id] ? ` <i class="an-n">${firing[t.id]}</i>` : ''}</button>`,
      )
      .join('');
    const pn = presetNow();
    $('anPreset')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.p === pn));
  }
  const paramIn = (attr, p, v) =>
    `<label class="mini">${esc(p.label)} <input class="num" type="number" step="${p.step}" min="${p.min}" ${attr} value="${v}"><span class="muted">${esc(p.unit)}</span></label>`;
  function renderTypes() {
    if (!cfg) return;
    renderChips();
    $('anTypes').innerHTML =
      `<div class="an-type on an-quality">
        <div class="an-type-head"><b>Data quality and liquidity</b><span class="muted small">every leg of every type</span></div>
        <div class="muted small">Live, a leg counts only with a two-sided, uncrossed quote that is tight, fresh and deep enough, on a contract that has traded today and has open interest; an opportunity must also stay for the "Seen for" time, because the quotes of one snapshot arrive a few hundred milliseconds apart. What fails a gate is listed under <b>Rejected signals</b> with the reason. A spread passes on either limit (points or % of premium). History has no order book: a leg must have traded within the minutes set here.</div>
        <div class="an-params">${gates()
          .map((p) => paramIn(`data-q="${p.k}"`, p, qval(p.k)))
          .join('')}</div>
      </div>` +
      types()
        .map(
          (t) => `<div class="an-type${cfg.enabled[t.id] ? ' on' : ''}" data-id="${t.id}">
        <label class="an-type-head"><input type="checkbox" data-en="${t.id}" ${cfg.enabled[t.id] ? 'checked' : ''}><i class="an-rank" title="How easy it is to trade: 1 = easiest">${t.ease?.rank ?? ''}</i><b>${esc(t.name)}</b><span class="cat-pill ${t.cls === 'rv' ? 'c-volatility' : 'c-neutral'}">${t.cls === 'rv' ? 'relative value' : 'arbitrage'}</span></label>
        <div class="muted small">${esc(t.desc)}</div>
        <div class="an-params">${own(t)
          .map((p) => paramIn(`data-param="${t.id}.${p.k}"`, p, pval(t, p.k, p.def)))
          .join('')}
          <label class="mini" title="One entry in the log per opportunity and strike every this many minutes">Cooldown <input class="num" type="number" min="1" step="5" data-param="${t.id}.cooldown" value="${pval(t, 'cooldown', t.cooldown)}"><span class="muted">min</span></label></div>
        ${t.formula ? `<div class="small an-how"><b>Bound:</b> ${esc(t.formula)}</div>` : ''}
        ${t.assumes ? `<div class="small an-how"><b>Assumes:</b> ${esc(t.assumes)}</div>` : ''}
        <div class="small an-how"><b>Trade:</b> ${esc(t.how)}</div>
        ${t.ease ? `<div class="small an-how"><b>Tradability:</b> ${esc(t.ease.why)} <b>Watch:</b> ${esc(t.ease.watch)}</div>` : ''}
        <div class="an-type-actions">
          <select data-btdir="${t.id}">${t.dirs.flatMap((d) => (t.sided ? ['CE', 'PE'].map((sd) => `<option value="${d}|${sd}">${d} · ${sd}</option>`) : [`<option value="${d}|">${d}</option>`])).join('')}</select>
          <button class="btn-sm ghost" data-bt="${t.id}" title="Open a signal strategy for this type in the Backtest editor">Backtest as strategy ▸</button>
        </div>
      </div>`,
        )
        .join('');
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
      } catch (e) {
        $('anCfgMsg').textContent = '· could not save: ' + e.message;
      }
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
  $('anMinNet').addEventListener('input', (e) => {
    minNet = Math.max(0, Number(e.target.value) || 0);
    BT.store.set('anMinNet', minNet);
    if (mode === 'live' && liveState) renderLive();
  });
  $('anTypes').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.en) {
      cfg.enabled[t.dataset.en] = t.checked;
      t.closest('.an-type').classList.toggle('on', t.checked);
      persist();
    }
  });
  $('anTypes').addEventListener('input', (e) => {
    const t = e.target;
    const v = t.value === '' ? null : Number(t.value);
    if (t.dataset.q) cfg.quality[t.dataset.q] = v;
    else if (t.dataset.param) {
      const [id, k] = t.dataset.param.split('.');
      (cfg.params[id] ||= {})[k] = v;
    } else return;
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
    const legs = (legsIn || tpl.legs).map((l) => ({
      action: l.action,
      type: l.type,
      lots: l.lots || 1,
      expiry: l.expiry || 'cur',
      strike: l.strike,
      sl: l.sl || { type: 'none', value: 0 },
      tgt: l.tgt || { type: 'none', value: 0 },
      trail: null,
      re: null,
    }));
    const params = { ...(cfg?.params?.[id] || {}), ...(cfg?.quality || {}) };
    delete params.cooldown;
    return {
      ...BT.blankStrategy(),
      id: null,
      category: 'Custom',
      name: `${t.name} — ${dir}${side ? ' ' + side : ''}`,
      desc: `${t.desc} ${t.how}`,
      entry: {
        time: '09:20',
        days: [1, 2, 3, 4, 5],
        dte: [],
        dteDays: 3,
        when: 'signal',
        until: '15:00',
        maxTrades: 2,
        conditions: [{ kind: 'anomaly', type: id, params, side: t.sided && side ? side : 'any', dir }],
      },
      exit: { time: '15:15', dteDays: 0 },
      legs,
      risk: { ...BT.blankStrategy().risk, ...(tpl.risk || {}) },
    };
  }
  function openBacktest(id, dir, side) {
    BT.emit('open-backtest', { strategy: strategyFor(id, dir, side), run: false });
  }

  // ---------- mode ----------
  function setMode(m) {
    mode = m;
    BT.store.set('anMode', m);
    $('anMode')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('anLive').classList.toggle('hidden', m !== 'live');
    $('anHist').classList.toggle('hidden', m !== 'hist');
    $('anModeHint').textContent =
      m === 'live'
        ? 'The server scans the nearest expiry every 5 s during market hours, also when this page is closed. Nothing here places an order.'
        : 'Runs the types that are switched on over past sessions and checks each occurrence against the prices that followed.';
    clearTimeout(liveTimer);
    renderChips();
    if (m === 'live') pollLive();
    else {
      renderScanOpts();
      showScan();
      loadTapes();
    }
  }
  $('anMode').addEventListener('click', (e) => {
    if (e.target.dataset.m) setMode(e.target.dataset.m);
  });

  // ---------- costs ----------
  // Today's charges (lib/costs.js, the file the history scan uses): brokerage per order, STT on sells, exchange and
  // SEBI fees, GST on those and stamp duty on buys. An arbitrage is held to expiry, so only its entry orders are
  // charged, plus the STT a bought option pays when it settles in the money — on its value with Nifty at `settle`
  // (today's level unless given). A relative-value trade is closed again, so it pays both ways.
  const legPx = (l) => (l.action === 'B' ? l.ask : l.bid) || l.ltp || null;
  // { gross, cost, net } in ₹ for `lots` structures of the hit's suggested trade, or null when a leg has no price.
  function money(h, lots, settle = h.spot) {
    const legs = h.legs || [];
    if (!legs.length || legs.some((l) => !legPx(l))) return null;
    const round = clsOf(h) === 'rv';
    const q = lots * lotSize();
    let buy = 0;
    let sell = 0;
    let ex = 0; // ₹ of intrinsic value on bought legs that settle in the money
    let later = 0; // ₹ of next-expiry legs, sold at the near expiry (the calendar's long call)
    for (const l of legs) {
      const turn = legPx(l) * l.lots * q;
      if (l.action === 'B') {
        buy += turn;
        if (l.expiry === 'next') later += turn;
        else if (!round && settle) ex += Math.max(0, l.type === 'CE' ? settle - l.strike : l.strike - settle) * l.lots * q;
      } else sell += turn;
    }
    if (round) buy = sell = buy + sell;
    const cost =
      Costs.orders({ buy, sell, orders: legs.length * (round ? 2 : 1) }) +
      Costs.exercise(ex) +
      (later ? Costs.orders({ sell: later, orders: legs.filter((l) => l.expiry === 'next').length }) : 0);
    const gross = h.value * q;
    return { gross, cost, net: gross - cost };
  }
  // What the hit is worth to a trader: state 'good' (pays after costs on one lot), 'size' (pays from a number of
  // lots the book can fill), 'wait' (would pay, but has not been there long enough to count) or 'bad' (not
  // executable, or costs exceed the edge at the fillable size).
  function verdict(h) {
    const fit = h.fit || 1;
    const one = money(h, 1);
    const all = money(h, fit);
    let be = null; // smallest size that pays
    if (one)
      for (let n = 1; n <= 500; n++)
        if (money(h, n).net > 0) {
          be = n;
          break;
        }
    // an arbitrage's exercise STT grows as Nifty moves away from its strikes: what is left if it settles 3 % either side
    const stress = one && clsOf(h) === 'arb' && h.spot ? Math.min(money(h, fit, h.spot * 0.97).net, money(h, fit, h.spot * 1.03).net) : null;
    const v = { fit, one, all, be, stress, state: 'bad', label: 'Costs exceed the edge' };
    if (!one) v.label = 'No quote on a leg';
    else if (h.exec != null && h.exec <= 0) v.label = 'Not executable at bid / ask';
    else if (one.net > 0) Object.assign(v, { state: 'good', label: 'Profitable after costs' });
    else if (be && be <= fit) Object.assign(v, { state: 'size', label: `Profitable from ${lotsTxt(be)}` });
    else if (be) v.label = `Needs ${lotsTxt(be)}, book fills ${fit}`;
    if (h.pending && v.state !== 'bad') Object.assign(v, { state: 'wait', label: `Confirming · seen ${h.held} s` });
    return v;
  }
  const pays = (v) => v.state === 'good' || v.state === 'size';

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
    if (alertOn) {
      beep();
      if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
    }
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
  // An opportunity that starts paying after costs (and has been confirmed) alerts once; again only after it has
  // been gone for 10 minutes.
  function alertNew(rows) {
    const now = Date.now();
    const fresh = [];
    for (const [h, , v] of rows) {
      if (!pays(v)) continue;
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
      try {
        new Notification(`${clsOf(h) === 'rv' ? 'Relative value' : 'Arbitrage'}: ${headline(h)}`, {
          body: `${v.label} · ${inrS(Math.round(v.all.net))} on ${lotsTxt(v.fit)}${fresh.length > 1 ? ` · and ${fresh.length - 1} more` : ''}`,
        });
      } catch {}
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
      case 'box':
        return `${k} box is ${h.dir === 'cheap' ? 'underpriced: buy it' : 'overpriced: sell it'}`;
      case 'fly':
        return `${h.strike} ${h.side} butterfly pays a credit`;
      case 'bwfly':
        return `${h.strike} ${h.side} broken-wing butterfly pays a credit`;
      case 'varb':
        return `${k} ${h.side} spread: ${h.dir === 'free-credit' ? 'free credit' : 'credit above its width'}`;
      case 'cal':
        return `${h.strike} CE: next expiry cheaper than this one`;
      case 'fv':
        return `${h.strike} ${h.side} is ${h.dir === 'rich' ? 'overpriced' : 'underpriced'} by ${num(h.pct, 1)}%`;
      default:
        return `${typeOf(h.type)?.name || h.type} ${k}`;
    }
  }
  function legsHtml(h) {
    return (h.legs || [])
      .map(
        (l) =>
          `<span class="leg-chip ${l.action === 'B' ? 'buy' : 'sell'}" title="bid ${num(l.bid)}${l.bidQ ? ' × ' + l.bidQ : ''} / ask ${num(l.ask)}${l.askQ ? ' × ' + l.askQ : ''}">${l.action === 'B' ? 'B' : 'S'}${l.lots > 1 ? l.lots + '×' : ''} ${l.strike}${l.type}${l.expiry === 'next' ? ' nxt' : ''} ${l.ltp ? '@' + num(l.ltp) : ''}</span>`,
      )
      .join(' ');
  }
  // The legs as an order ticket: what to do, at which side of the book, how many lots wait there, and the raw
  // quote behind it (spread, how old it is, volume and open interest in the tooltip).
  function ticket(h) {
    return `<div class="an-legs">${(h.legs || [])
      .map((l) => {
        const buy = l.action === 'B';
        const q = buy ? l.askQ : l.bidQ;
        const sp = l.bid && l.ask ? l.ask - l.bid : null;
        const lot = lotSize();
        const tip = `bid ${num(l.bid)} × ${l.bidQ ?? '—'} · ask ${num(l.ask)} × ${l.askQ ?? '—'} · last ${num(l.ltp)}${l.vol != null ? ` · volume ${Math.round(l.vol / lot).toLocaleString('en-IN')} lots` : ''}${l.oi != null ? ` · open interest ${Math.round(l.oi / lot).toLocaleString('en-IN')} lots` : ''}`;
        return `<b class="${buy ? 'pos' : 'neg'}">${buy ? 'BUY' : 'SELL'}</b><span>${l.lots > 1 ? l.lots + ' × ' : ''}${l.strike} ${l.type}${l.expiry === 'next' ? ' <span class="muted">next expiry</span>' : ''}</span>
        <span class="p">${legPx(l) ? num(legPx(l)) : '—'} <span class="muted small">${buy ? 'ask' : 'bid'}</span></span>
        <span class="q" title="${esc(tip)}">${q ? lotsTxt(Math.floor(q / (lot * l.lots))) : ''}${sp != null ? ` · spread ${num(sp)}` : ''}${l.age != null ? ` · ${l.age} s` : ''}</span>`;
      })
      .join('')}</div>`;
  }
  const money0 = (x) => `<b class="${cls(x)}">${inrS(Math.round(x))}</b>`;
  function card(h, i, v) {
    const t = typeOf(h.type);
    const rv = clsOf(h) === 'rv';
    const tiles = !v.one
      ? ''
      : `<div class="an-nums">
        <div title="${rv ? 'Distance to fair value' : "The least it is worth at expiry, in today's money"}, before brokerage and taxes"><span>Edge before costs</span><b>${fmtVal(h)}</b><i>${inrS(Math.round(v.one.gross))} per lot</i></div>
        <div title="Brokerage, STT, exchange fees, GST and stamp duty${rv ? ' for the entry and the exit' : "; held to expiry, so no exit orders, plus the STT on bought legs that settle in the money (at today's Nifty)"}"><span>After costs · 1 lot</span>${money0(v.one.net)}<i>costs ${inrS(Math.round(v.one.cost))}</i></div>
        ${
          v.fit > 1
            ? `<div title="The most the best bid / ask can fill on every leg"><span>After costs · ${lotsTxt(v.fit)}</span>${money0(v.all.net)}<i>all the book fills</i></div>`
            : `<div title="The fixed brokerage is spread over more lots as the size grows"><span>Pays from</span><b>${v.be ? lotsTxt(v.be) : 'never'}</b><i>book fills ${lotsTxt(v.fit)}</i></div>`
        }
      </div>`;
    const notes = [];
    if (rv)
      notes.push(
        `Market ${num(h.mkt)} vs fair value ${num(h.fair)}${h.ivMkt == null ? '' : ` · IV ${num(h.ivMkt, 1)}% vs ${num(h.ivFair, 1)}% at the neighbouring strikes`}. Exit when it is back at fair value.`,
      );
    else {
      if (h.exec > 0) notes.push(`Locks ${num(h.exec)} pts at bid / ask wherever Nifty expires.`);
      // only when it reads as an interest rate: days from expiry any mispricing annualises to hundreds of percent
      if (h.rate != null && Math.abs(h.rate) < 100)
        notes.push(`The box trades at ${num(h.rate, 1)}% a year (${h.dir === 'cheap' ? 'you lend' : 'you borrow'}).`);
      if (v.stress != null && v.one) notes.push(`If Nifty settles 3% away the exercise STT leaves ${inrS(Math.round(v.stress))} on ${lotsTxt(v.fit)}.`);
    }
    return `<div class="an-card ${v.state}">
      <div class="an-card-top"><i class="an-rank" title="How easy this type is to trade: 1 = easiest. ${esc(t?.ease?.why || '')}">${t?.ease?.rank ?? ''}</i>${esc(t ? shortName(t) : h.type)}${rv ? ' · not risk-free' : ''}<span class="an-badge ${v.state}" title="${h.held != null ? `seen for ${h.held} s` : ''}">${esc(v.label)}</span></div>
      <h4>${esc(headline(h))}</h4>
      ${ticket(h)}
      ${tiles}
      <div class="an-watch" title="${esc(t?.formula || '')}"><b>Check:</b> ${esc(h.text || '')}</div>
      <div class="an-watch">${notes.length ? esc(notes.join(' ')) + ' ' : ''}${t?.ease ? '<b>Watch:</b> ' + esc(t.ease.watch) : ''}</div>
      <div class="an-card-foot"><button class="btn-sm" data-dep="${i}" data-list="active" title="Resolve this trade on the live chain as a paper position (Strategies tab). No order is sent.">Deploy ▸</button>
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
      <td class="nowrap"><button class="btn-sm ghost" data-dep="${i}" data-list="log" title="Resolve this trade on the live chain as a paper position (Strategies tab)">Deploy ▸</button>
        <button class="btn-sm ghost" data-hbt="${i}" data-list="log" title="Backtest this as a signal strategy">Backtest ▸</button></td>
    </tr>`;
  }

  // Scanner health: how good the data behind this scan is.
  function healthHtml(hl) {
    if (!hl) return '';
    const chip = (state, label, value, title) => `<span class="an-hc ${state}" title="${esc(title)}"><i></i>${label} <b>${value}</b></span>`;
    const share = hl.sides ? hl.twoSided / hl.sides : 0;
    const out = [
      chip(hl.chainAge <= 10 ? 'ok' : hl.chainAge <= 30 ? 'warn' : 'bad', 'Chain', `${hl.chainAge} s old`, 'Age of the chain snapshot the scan ran on'),
      hl.feed
        ? chip(
            hl.feed.connected ? 'ok' : 'warn',
            'Tick feed',
            hl.feed.connected ? `live${hl.feed.age != null ? ` · last tick ${hl.feed.age} s ago` : ''}` : 'down — quotes from polling',
            'With the feed down, quotes are refreshed by polling the chain every 1.5 s and all carry the same time',
          )
        : chip('warn', 'Tick feed', 'none (demo)', 'Demo data: made-up quotes'),
      chip(
        share >= 0.9 ? 'ok' : share >= 0.6 ? 'warn' : 'bad',
        'Two-sided quotes',
        `${hl.twoSided} / ${hl.sides}`,
        `Calls and puts of the ${hl.strikes} strikes around the money that carry both a bid and an ask`,
      ),
      chip(hl.crossed ? 'bad' : 'ok', 'Crossed', hl.crossed, 'Contracts whose bid is above their ask: bad data, never used'),
      chip(hl.stale ? 'warn' : 'ok', 'Stale', hl.stale, 'Quotes older than the "Quote age" gate'),
      chip('ok', 'Spread near ATM', hl.spread == null ? '—' : `${num(hl.spread)} pts`, 'Median bid-ask spread of the 5 strikes either side of the money'),
    ];
    if (hl.next)
      out.push(
        chip(
          hl.next.age == null ? 'bad' : hl.next.age <= 15 ? 'ok' : 'warn',
          'Next expiry',
          hl.next.age == null ? 'no chain' : `${hl.next.age} s old`,
          "The next expiry's chain (for the calendar) is fetched every 10 s; its quotes are that old",
        ),
      );
    out.push(
      chip(
        'ok',
        'Rejected',
        hl.rejected,
        'Structures that looked like an arbitrage at quote mids or last trades but failed a gate (the biggest are listed below)',
      ),
    );
    out.push(chip(hl.ms < 500 ? 'ok' : 'warn', 'Scan', `${hl.ms} ms`, 'Time the detectors took on this snapshot'));
    return `<div class="an-health">${out.join('')}</div>`;
  }
  const CODE = {
    touch: 'not at bid / ask',
    quote: 'no quote',
    crossed: 'crossed',
    spread: 'spread',
    stale: 'stale',
    depth: 'depth',
    volume: 'volume',
    oi: 'open interest',
    price: 'premium',
    data: 'no data',
  };
  function rejectedHtml(list, total) {
    if (!list.length) return '<div class="muted pad">Nothing looked like an arbitrage at quote mids or last-traded prices on this snapshot.</div>';
    return `<div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th class="l">Type</th><th class="l">Structure</th><th title="The edge it seemed to have, and at which prices">Looked like</th><th class="l">Rejected because</th></tr></thead>
      <tbody>${list
        .map(
          (r) => `<tr><td class="l">${esc(typeOf(r.type) ? shortName(typeOf(r.type)) : r.type)}</td><td class="l">${esc(r.label)}</td>
        <td>+${num(r.apparent)} pts <span class="muted small">at ${r.basis === 'mid' ? 'quote mids' : 'last trades'}</span></td>
        <td class="l wrap"><span class="dir-pill">${esc(CODE[r.code] || r.code)}</span> ${esc(r.why)}</td></tr>`,
        )
        .join('')}</tbody></table></div>
      ${total > list.length ? `<div class="muted small pad">The ${list.length} biggest of ${total}.</div>` : ''}`;
  }
  function parityHtml(p) {
    if (!p) return '<div class="muted pad">No strike near the money has a two-sided quote on both the call and the put.</div>';
    const gap = p.gap;
    return `<div class="muted small pad">Through each strike the forward (Nifty at expiry) can be bought with a synthetic — call at the ask, put sold at the bid — and sold with the reverse. Parity holds while the dearest sale is below the cheapest purchase.
        Here it can be bought at <b>${num(p.buy.f)}</b> (through ${p.buy.k}) and sold at <b>${num(p.sell.f)}</b> (through ${p.sell.k}):
        ${gap > 0 ? `<b class="pos">${num(gap)} pts apart in your favour — a box between those strikes, before costs</b>` : `<b>${num(-gap)} pts the wrong way round — no box arbitrage</b>`}. Consensus forward ${num(p.forward)}.</div>
      <div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Strike</th><th>Call bid</th><th>Call ask</th><th>Put bid</th><th>Put ask</th><th title="K + (call ask − put bid)·e^(rT)">Buy forward at</th><th title="K + (call bid − put ask)·e^(rT)">Sell forward at</th><th title="How far this strike's band sits from the consensus forward">Mid vs consensus</th></tr></thead>
      <tbody>${p.rows
        .map(
          (
            r,
          ) => `<tr${r.k === p.atm ? ' class="atm"' : ''}><td class="b">${r.k}</td><td>${num(r.cb)}</td><td>${num(r.ca)}</td><td>${num(r.pb)}</td><td>${num(r.pa)}</td>
        <td class="${r.k === p.buy.k ? 'b pos' : ''}">${num(r.buy)}</td><td class="${r.k === p.sell.k ? 'b pos' : ''}">${num(r.sell)}</td><td class="${cls((r.buy + r.sell) / 2 - p.forward)}">${num((r.buy + r.sell) / 2 - p.forward)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  }

  const ORDER = { good: 0, size: 1, wait: 2, bad: 3 };
  const openD = { log: true, rej: false, par: false }; // which of the live screen's fold-away panels are open
  function renderLive() {
    const s = liveState;
    const m = s.metrics;
    const st = s.status || {};
    renderChips();
    for (const d of $('anLive').querySelectorAll('details[data-d]')) openD[d.dataset.d] = d.open;
    // what pays after costs first, then the bigger gain at the size the book fills
    const rows = s.active
      .map((h, i) => [h, i, verdict(h)])
      .sort((a, b) => ORDER[a[2].state] - ORDER[b[2].state] || (b[2].all?.net ?? -Infinity) - (a[2].all?.net ?? -Infinity));
    alertNew(rows);
    const shown = rows.filter((r) => !(minNet > 0) || (r[2].all?.net ?? -Infinity) >= minNet);
    const hidden = rows.length - shown.length;
    const arb = shown.filter((r) => clsOf(r[0]) === 'arb');
    const rv = shown.filter((r) => clsOf(r[0]) === 'rv');
    const pay = rows.filter((r) => pays(r[2]));
    const payArb = pay.filter((r) => clsOf(r[0]) === 'arb').length;
    const anyOn = types().some((t) => s.config?.enabled?.[t.id]);
    const tile = (l, v, sub = '') => `<div class="kpi"><span class="k-l">${l}</span><span class="k-v">${v}</span><span class="k-s">${sub}</span></div>`;
    const rej = s.rejected || [];
    const cards = (list) => `<div class="an-cards">${list.map(([h, i, v]) => card(h, i, v)).join('')}</div>`;
    const none = (what) =>
      `<div class="muted pad">${!anyOn ? 'Every type is switched off: click a type above to scan for it.' : hidden ? `${hidden} hidden by "Net ≥ ₹${minNet}" on the bar above.` : what}</div>`;
    $('anLive').innerHTML = `
      <div class="panel res-head">
        <div class="res-title"><h3>${pay.length ? `${pay.length} opportunit${pay.length === 1 ? 'y pays' : 'ies pay'} after costs` : 'Nothing pays after costs right now'} ${m ? `<span class="muted small">· expiry ${dayShort(m.expiry)}</span>` : ''}</h3>
          <span class="muted small">${st.ok ? `last scan ${window.app.istClock(st.at)}` : esc(st.reason || 'waiting')}${st.ok && st.reason ? ' · ' + esc(st.reason) : ''}</span></div>
        ${
          m
            ? `<div class="kpis">
          ${tile('Arbitrage that pays', payArb, `${rows.filter((r) => clsOf(r[0]) === 'arb').length} at the bid / ask · ${rej.length ? (s.health?.rejected ?? rej.length) + ' rejected' : 'none rejected'}`)}
          ${tile('Relative value that pays', pay.length - payArb, `${rows.filter((r) => clsOf(r[0]) === 'rv').length} found · ${s.log.length} logged today`)}
          ${tile('Nifty / forward', num(m.spot, 1), `forward ${num(m.forward, 1)} · basis ${num(m.basis, 1)}`)}
          ${tile('ATM IV', m.atmIv == null ? '—' : m.atmIv + '%', `at 09:20 ${m.dayIv ?? '—'}%`)}
          ${tile('Skew (RR 4)', m.rr == null ? '—' : num(m.rr, 1), 'OTM put IV − OTM call IV')}
          ${tile('IV / RV', m.ivrv == null ? '—' : num(m.ivrv) + '×', `5-day realised ${m.rv5 ?? '—'}%`)}
        </div>`
            : ''
        }
        ${healthHtml(s.health)}
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Arbitrage candidates</h3><span class="muted small">a no-arbitrage bound broken at the bid / ask on every leg, with the quality gates passed · best first · costs at today's rates (₹${Costs.BROKERAGE} an order, STT ${num(Costs.rates().stt * 100, 2)}%), lot ${lotSize()}</span></div>
        ${arb.length ? cards(arb) : none('No bound is broken at the bid / ask with the current thresholds. That is the normal state of this market: see Rejected signals below for what came close, and the history scan for how rarely one lasts.')}
      </div>
      <div class="panel">
        <div class="chart-head"><h3>Relative value</h3><span class="muted small">prices out of line with the rest of the chain · a statistical edge, not a locked-in profit · entry and exit costs included</span></div>
        ${rv.length ? cards(rv) : none('No option is far enough from its fair value with the current thresholds.')}
      </div>
      <details class="panel an-logd" data-d="rej" ${openD.rej ? 'open' : ''}>
        <summary>Rejected signals <span class="muted small">· ${s.health?.rejected ?? rej.length} on this snapshot · looked like an arbitrage at quote mids or last trades, failed a check</span></summary>
        ${rejectedHtml(rej, s.health?.rejected ?? rej.length)}
      </details>
      <details class="panel an-logd" data-d="par" ${openD.par ? 'open' : ''}>
        <summary>Put-call parity by strike <span class="muted small">· ${s.parity ? (s.parity.gap > 0 ? `the forward sells ${num(s.parity.gap)} pts above where it buys, before costs` : `holds at the bid / ask, ${num(-s.parity.gap)} pts to spare`) : 'no quotes'} · the synthetic forward through each strike</span></summary>
        ${parityHtml(s.parity)}
      </details>
      <details class="panel an-logd" data-d="log" ${openD.log ? 'open' : ''}>
        <summary>Today's log <span class="muted small">· ${s.log.length} entries · each confirmed opportunity once per cooldown · saved to bt-data/anomaly-log/</span></summary>
        ${
          s.log.length
            ? `<div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Time</th><th class="l">Type</th><th class="l">Opportunity and trade</th><th>Edge</th><th title="For one lot, at the prices when it was logged">After costs · 1 lot</th><th>Fillable</th><th></th></tr></thead>
          <tbody>${s.log.map((h, i) => logRow(h, i)).join('')}</tbody></table></div>`
            : '<div class="muted pad">Nothing logged today yet (logging runs during market hours).</div>'
        }
      </details>`;
  }

  // Strategy from a concrete hit: its suggested legs with "signal" / ATM strikes, so it also backtests.
  const hitStrategy = (h) => strategyFor(h.type, h.dir, h.side, h.template?.legs || h.legs);
  $('anLive').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-list]');
    if (!b || !liveState) return;
    const h = liveState[b.dataset.list][Number(b.dataset.dep ?? b.dataset.hbt)];
    if (!h) return;
    if (b.dataset.dep != null) {
      BT.emit('deploy', { strategy: hitStrategy(h), hit: { type: h.type, strike: h.strike, ref: h.ref, side: h.side, dir: h.dir, text: h.text } });
      window.app.setView('lib');
    } else BT.emit('open-backtest', { strategy: hitStrategy(h), run: false });
  });

  // ---------- history scan ----------
  const quotes = () => scanOpts.source === 'quotes';
  function renderScanOpts() {
    const q = quotes();
    const sel = (k, list, unit) =>
      `<select data-o="${k}">${list.map((x) => `<option value="${x}" ${Number(scanOpts[k]) === x ? 'selected' : ''}>${x} ${unit}</option>`).join('')}</select>`;
    $('anScanOpts').innerHTML = `<div class="set-row">
      <span class="lbl">Prices</span><span class="seg sm" id="anSrc">
        <button type="button" data-src="candles" class="${q ? '' : 'on'}" title="Last-traded prices from 1-minute candles: about two years of history, but no bid / ask and no depth">1-minute candles</button>
        <button type="button" data-src="quotes" class="${q ? 'on' : ''}" title="The best bid and ask the app recorded, one snapshot a second: real quotes, but only on the days it was running">Recorded quotes${tapes ? ` (${tapes.length})` : ''}</button></span>
      ${
        q
          ? `<span class="lbl">Sessions</span><select data-o="day"><option value="all">All ${tapes?.length ?? ''} recorded</option>${(tapes || []).map((d) => `<option value="${d}" ${scanOpts.day === d ? 'selected' : ''}>${dayLabel(d)}</option>`).join('')}</select>
        <span class="lbl">Every</span>${sel('every', [1, 2, 5, 10], 's')}
        <span class="lbl" title="Seconds between seeing an opportunity and being filled: it must stay on every snapshot until then, and is priced at the quotes at the end">Act after</span><input class="num" type="number" data-o="latency" min="0" max="60" step="1" value="${scanOpts.latency}"><span class="muted">s</span>`
          : `<span class="lbl">Scan window</span><input type="time" data-o="start" value="${scanOpts.start}" step="60"><span class="muted">→</span><input type="time" data-o="end" value="${scanOpts.end}" step="60">
        <span class="lbl">Every</span>${sel('step', [1, 2, 3, 5, 10], 'min')}`
      }
      <span class="lbl" title="Lots per structure the costs are worked out for: the fixed brokerage needs size to be covered">Size</span><input class="num" type="number" data-o="lots" min="1" max="500" step="1" value="${scanOpts.lots}"><span class="muted">lots</span>
      </div>
      <div class="muted small">${
        q
          ? 'Each signal was executable at the bid / ask when it was seen. It counts as <b>fillable</b> if it stays on every snapshot for the "Act after" seconds, priced at the quotes at the end of them, and <b>pays</b> if what it locks in there exceeds the costs. Quotes are recorded on the days the app runs during market hours; the period in the bar above is not used (lot size and brokerage are).'
          : "Candles are last trades: two closes a few seconds apart look like a mispricing. A signal counts as <b>robust</b> if it holds at the worst prices traded in its minute (buys at the high, sells at the low), <b>fillable</b> if it does so again in the next minute, and <b>pays</b> if what it locks in there exceeds the costs. Fair-value signals are entered at the next minute's open and marked 5 / 15 / 30 / 60 minutes later and at the end of the window. Period, expiries, lot size and brokerage come from the bar above."
      }</div>`;
  }
  $('anScanOpts').addEventListener('change', (e) => {
    const k = e.target.dataset.o;
    if (!k) return;
    scanOpts[k] = ['start', 'end', 'day'].includes(k) ? e.target.value : Number(e.target.value);
    BT.store.set('anScanOpts', scanOpts);
  });
  $('anScanOpts').addEventListener('click', (e) => {
    const src = e.target.closest('[data-src]')?.dataset.src;
    if (!src || src === scanOpts.source || scanCtl) return;
    scanOpts.source = src;
    BT.store.set('anScanOpts', scanOpts);
    hitFilter = occFilter = 'all';
    renderScanOpts();
    showScan();
  });
  async function loadTapes() {
    try {
      tapes = (await BT.api('/api/bt/scan/tapes')).days;
      if (scanOpts.day !== 'all' && !tapes.includes(scanOpts.day)) scanOpts.day = 'all';
      if (mode === 'hist') {
        renderScanOpts();
        if (!scans[scanOpts.source]) showScan();
      }
    } catch {}
  }

  // The scan of the source picked, the one saved on the server when none was run in this page yet, or the intro.
  const asked = {};
  async function showScan() {
    const src = scanOpts.source;
    if (scans[src]) return renderScan();
    $('anHistRes').innerHTML = quotes()
      ? `<div class="panel empty"><h3>What did the bid and ask really allow?</h3>
        <p>${tapes == null ? 'Looking for recordings…' : tapes.length ? `Quotes of <b>${tapes.length}</b> session${tapes.length === 1 ? '' : 's'} are recorded (${tapes.slice(0, 6).map(dayShort).join(', ')}${tapes.length > 6 ? ', …' : ''}). Switch on the types above and press <b>Scan history</b>.` : "No session has been recorded yet. The app records the nearest expiry's bid and ask every second while it runs during market hours; come back after it has."}</p>
        <p class="muted">This is the strongest evidence the app has: real quotes, every leg at the side it would trade on. It still cannot show how long your own orders would take, which is what "Act after" stands in for.</p></div>`
      : `<div class="panel empty"><h3>How often does each mispricing happen, and is it real?</h3>
        <p>Switch on the types above, choose a period and press <b>Scan history</b>. The first scan of a period downloads the option candles it needs (strikes around the Nifty path); later scans are instant.</p>
        <p class="muted">Use <b>Backtest as strategy</b> on a type (under ⚙ Tune) for a full simulation with stops, costs and re-entries.</p></div>`;
    if (asked[src]) return;
    asked[src] = true;
    try {
      const r = await BT.api('/api/bt/scan/last' + (src === 'quotes' ? '?source=quotes' : ''));
      if (r.scan && !scans[src]) {
        scans[src] = r.scan;
        if (scanOpts.source === src && mode === 'hist') renderScan();
      }
    } catch {}
  }

  async function runScan() {
    const src = scanOpts.source;
    let o = {};
    try {
      o = settings.get();
    } catch (e) {
      if (src === 'candles') {
        $('anHistRes').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
        return;
      }
    }
    const sel = types()
      .filter((t) => cfg?.enabled[t.id])
      .map((t) => ({ id: t.id, params: cfg.params[t.id] || {} }));
    if (!sel.length) {
      $('anHistRes').innerHTML = '<div class="panel empty err">Switch on at least one type above.</div>';
      return;
    }
    const common = { types: sel, quality: cfg.quality || {}, lots: scanOpts.lots, brokerage: o.brokerage };
    const body =
      src === 'quotes'
        ? {
            ...common,
            source: 'quotes',
            days: scanOpts.day === 'all' ? null : [scanOpts.day],
            every: scanOpts.every,
            latency: scanOpts.latency,
            lotSize: o.lotMode === 'fixed' ? o.lotSize : null,
          }
        : {
            ...common,
            from: o.from,
            to: o.to,
            expiries: o.expiries,
            lotSize: o.lotSize,
            lotMode: o.lotMode,
            start: scanOpts.start,
            end: scanOpts.end,
            step: scanOpts.step,
          };
    settings.setBusy(true);
    scanCtl = { stop: false };
    try {
      const job = await BT.runJob('/api/bt/scan', body, settings.progress, scanCtl);
      scans[src] = job.result;
      hitFilter = occFilter = 'all';
      if (scanOpts.source === src) renderScan();
    } catch (e) {
      $('anHistRes').innerHTML = `<div class="panel empty err"><b>Scan failed:</b> ${esc(e.message)}</div>`;
    } finally {
      scanCtl = null;
      settings.setBusy(false);
    }
  }

  // An arbitrage occurrence that passed the scan's strongest check, and one that also pays after costs.
  const isFill = (h, q) => (q ? h.out?.at > 0 : h.robust > 0 && h.out?.ew > 0);
  const isPay = (h, q) => isFill(h, q) && h.out.lock > 0;

  // Open an occurrence in the Builder's historical replay: the suggested legs at the scan's entry minute and prices.
  function replayHit(h, r) {
    const [hh, mm] = h.time.split(':').map(Number);
    const t = hh * 60 + mm + (r.opts.source === 'quotes' ? 0 : 1); // a candle signal is entered at the next minute's open
    const time = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const name = typeOf(h.type)?.name || h.type;
    BT.emit('open-builder', {
      strategy: strategyFor(h.type, h.dir, h.side, h.legs),
      src: 'hist',
      expiry: h.expiry,
      day: h.day,
      time,
      session: 'intraday',
      lot: h.lot || r.opts.lot,
      legs: h.out.entry.map((l) => ({ action: l.d > 0 ? 'B' : 'S', type: l.t, strike: l.s, expiry: l.e || h.expiry, lots: Math.abs(l.d), px: l.px })),
      note: `${name} · ${dayShort(h.day)} ${h.time} · ${h.text}`,
    });
  }
  const canReplay = (h) => Boolean(h.out?.entry) && (BT.meta.calendar?.expired || []).includes(h.expiry);

  const td = (v, d = 2) => (v == null ? '<td class="muted">—</td>' : `<td class="${cls(v)}">${num(v, d)}</td>`);
  const tdInr = (v, bold) => (v == null ? '<td class="muted">—</td>' : `<td class="${cls(v)}${bold ? ' b' : ''}">${inrS(Math.round(v))}</td>`);
  const hoursHtml = (s) => {
    const hours = ['09', '10', '11', '12', '13', '14', '15'];
    const maxH = Math.max(1, ...Object.values(s.hours));
    return `<div class="hours">${hours.map((hr) => `<i style="height:${(((s.hours[hr] || 0) / maxH) * 100).toFixed(0)}%" title="${hr}:00 — ${s.hours[hr] || 0} signals"></i>`).join('')}</div>`;
  };
  const btBtn = (s) =>
    `<button class="btn-sm ghost" data-sbt="${s.type}" data-dir="${esc(Object.entries(s.dirs).sort((a, b) => b[1] - a[1])[0]?.[0] || '')}">Backtest ▸</button>`;
  const nameOf = (id) => esc(typeOf(id)?.name || id);

  function renderScan() {
    const r = scans[scanOpts.source];
    if (!r) return;
    const q = r.opts.source === 'quotes';
    const H = r.horizons;
    const hl = (h) => (h === 'eod' ? 'to end' : h + 'm');
    const lots = r.opts.lots;
    const sum = r.summary.slice().sort((a, b) => b.hits - a.hits);
    const arbS = sum.filter((s) => s.cls === 'arb');
    const rvS = sum.filter((s) => s.cls !== 'arb');
    const fillAll = arbS.reduce((n, s) => n + s.fill, 0);
    const payAll = arbS.reduce((n, s) => n + s.pay, 0);
    const sigAll = arbS.reduce((n, s) => n + s.hits, 0);
    const when = `scanned ${dayShort(new Date(r.savedAt + 5.5 * 3600_000).toISOString().slice(0, 10))} ${window.app.istClock(r.savedAt)} in ${(r.ms / 1000).toFixed(1)} s, saved`;
    const head = `<div class="panel res-head"><div class="res-title"><h3>${arbS.length ? `${sigAll.toLocaleString('en-IN')} arbitrage signals → ${fillAll} fillable → ${payAll} pay after costs` : `${r.hitsTotal} signals`} <span class="muted small">over ${r.days} session${r.days === 1 ? '' : 's'}</span>${r.stopped ? ` <span class="cat-pill c-mine" title="Stop was pressed: only the sessions scanned until then are included, and occurrences whose outcome was not measured yet show —">stopped early · ${r.days} of ${r.daysTotal} sessions</span>` : ''}</h3>
        <span class="muted small">${dayLabel(r.opts.from)} → ${dayLabel(r.opts.to)} · ${q ? `every ${r.opts.every} s · act after ${r.opts.latency} s` : `${r.opts.start}–${r.opts.end} every ${r.opts.step} min`} · ${lots} lots of ${r.opts.lot || 'the lot as traded'} · ₹${r.opts.brokerage} an order · ${when}${r.skipped.length ? ` · ${r.skipped.length} sessions skipped` : ''}</span></div>
      <div class="an-evidence"><b>Evidence:</b> ${
        q
          ? `recorded best bid and ask, one snapshot a second — every leg priced at the side it would trade on. ${r.opts.depth ? 'The quantity at the best bid / ask was recorded, so "Fillable ≥ N lots" applies.' : 'These recordings carry no quantities, so size could not be checked.'} A snapshot joins quotes that arrived a few hundred milliseconds apart: a signal that is gone on the next snapshot was usually just that, which is what "fillable" filters out.`
          : 'last-traded prices from 1-minute candles — <b>no bid / ask, no depth, no volume</b>. A signal is closes out of line with each other; most are trades a few seconds apart or prints at different sides of a wide spread. Only "fillable" ones were really printed for two minutes running, and even those say nothing about how many lots were on offer. Run the scan on <b>Recorded quotes</b> for evidence at the bid and ask.'
      }</div></div>`;

    const arbTable = !arbS.length
      ? ''
      : `<div class="panel">
      <div class="chart-head"><h3>Arbitrage types</h3><span class="muted small">how many signals survive each check · edges in points per structure · ₹ on ${lots} lots after costs</span></div>
      <div class="tbl-wrap"><table class="grid-tbl an-sum">
        <thead><tr><th class="l">Type</th><th title="The bound was broken at ${q ? 'the bid / ask with every quality gate passed' : 'the closing prices of a minute'}">Signals</th><th>Days</th><th class="l">Directions</th>
          ${q ? '' : '<th title="Still broken at the worst prices traded in the same minute: buys at the high, sells at the low">Robust</th>'}
          <th title="${q ? 'Stayed on every snapshot for the latency, priced at the quotes at the end of it' : 'Robust, and broken again at the worst prices traded in the next minute'}">Fillable</th>
          <th title="Fillable, and what it locks in exceeds brokerage and taxes on ${lots} lots">Pays</th>
          <th title="Average edge when the signal was seen">Edge at signal</th>
          ${q ? '<th title="Average edge of the fillable ones at the quotes after the latency">Edge when filled</th><th title="Median time a signal stayed at the bid / ask">Lasted</th>' : '<th title="Average edge of all signals at the next minute\'s opening prices: below zero means that, on average, nothing was locked in">At next open</th><th title="Average edge of all signals at the next minute\'s worst prices">At next worst</th>'}
          <th title="What the fillable ones lock in after costs, in total">Locked ₹</th>${q ? '' : '<th title="What the fillable ones made at the expiry\'s settlement after costs, in total">At expiry ₹</th>'}
          <th class="l" title="Signals → fillable → paying in the last 30 % of the sessions (${r.opts.cut ? 'from ' + dayShort(r.opts.cut) : '—'}): does it hold up out of sample?">Latest 30%</th>
          <th class="l" title="Signals → fillable → paying on expiry days">Expiry days</th><th class="l">By hour</th><th></th></tr></thead>
        <tbody>${arbS
          .map(
            (s) => `<tr><td class="l"><a href="#" data-f="${s.type}">${nameOf(s.type)}</a></td><td>${s.hits.toLocaleString('en-IN')}</td><td>${s.days}</td>
          <td class="l small">${Object.entries(s.dirs)
            .map(([d, n]) => `${esc(d)} ${n}`)
            .join(' · ')}</td>
          ${q ? '' : `<td>${s.robust}${pctOf(s.robust, s.hits)}</td>`}
          <td class="b">${s.fill}${pctOf(s.fill, s.hits)}</td><td class="b ${s.pay ? 'pos' : ''}">${s.pay}${pctOf(s.pay, s.hits)}</td>
          <td>${num(s.avgEdge)}</td>
          ${q ? `${td(s.avgAt)}<td>${s.medLife == null ? '—' : s.medLife + ' s'}</td>` : `${td(s.avgEo)}${td(s.avgEw)}`}
          ${tdInr(s.fill ? s.valid.lock : null, true)}${q ? '' : tdInr(s.fill ? s.valid.net : null)}
          <td class="l small">${s.late.hits} → ${s.late.fill} → ${s.late.pay}</td><td class="l small">${s.dte0.hits} → ${s.dte0.fill} → ${s.dte0.pay}</td>
          <td class="l">${hoursHtml(s)}</td><td>${btBtn(s)}</td></tr>`,
          )
          .join('')}</tbody>
      </table></div></div>`;

    const rvTable = !rvS.length
      ? ''
      : `<div class="panel">
      <div class="chart-head"><h3>Relative value</h3><span class="muted small">${q ? 'the suggested trade entered and closed at the bid / ask' : "the suggested trade entered at the next minute's open, at last-traded prices"} · avg points per structure · win % · not risk-free</span></div>
      <div class="tbl-wrap"><table class="grid-tbl an-sum">
        <thead><tr><th class="l">Type</th><th>Signals</th><th>Days</th><th class="l">Directions</th><th>Avg deviation</th>${H.map((h) => `<th>${hl(h)}</th>`).join('')}<th title="All the trades held to the end, after entry and exit costs on ${lots} lots each">₹ total (to end)</th><th class="l">By hour</th><th></th></tr></thead>
        <tbody>${rvS
          .map(
            (s) => `<tr><td class="l"><a href="#" data-f="${s.type}">${nameOf(s.type)}</a></td><td>${s.hits}</td><td>${s.days}</td>
          <td class="l small">${Object.entries(s.dirs)
            .map(([d, n]) => `${esc(d)} ${n}`)
            .join(' · ')}</td><td>${num(s.avgEdge)}</td>
          ${H.map((h) => {
            const b = s.horizons[h];
            return b
              ? `<td class="${cls(b.avgPts)}">${num(b.avgPts)}<span class="muted small"> · ${Math.round(b.winRate)}% of ${b.n}</span></td>`
              : '<td class="muted">—</td>';
          }).join('')}
          ${tdInr(s.netN ? s.net : null, true)}<td class="l">${hoursHtml(s)}</td><td>${btBtn(s)}</td></tr>`,
          )
          .join('')}</tbody>
      </table></div></div>`;

    const typed = hitFilter === 'all' ? r.hits : r.hits.filter((h) => h.type === hitFilter);
    const arbHits = typed.filter((h) => h.cls === 'arb' && (occFilter === 'all' || (occFilter === 'fill' ? isFill(h, q) : isPay(h, q))));
    const rvHits = typed.filter((h) => h.cls !== 'arb');
    const idx = (h) => r.hits.indexOf(h);
    const replay = (h) =>
      `<td class="nowrap"><button class="btn-sm ghost" data-rp="${idx(h)}" ${canReplay(h) ? '' : 'disabled'} title="Replay this occurrence in the Builder: same expiry, day, entry minute, strikes and prices${canReplay(h) ? '' : ' (needs an expired expiry and an entry)'}">▶ Replay</button></td>`;
    const mark = (h) => (isPay(h, q) ? '<span class="an-badge good">pays</span>' : isFill(h, q) ? '<span class="an-badge size">fillable</span>' : '');
    const arbOcc = !arbS.length
      ? ''
      : `<div class="panel">
      <div class="chart-head"><h3>Arbitrage occurrences</h3>
        <select id="anHitFilter"><option value="all">All types</option>${sum.map((s) => `<option value="${s.type}" ${hitFilter === s.type ? 'selected' : ''}>${nameOf(s.type)}</option>`).join('')}</select>
        <span class="seg sm" id="anOcc">${[
          ['all', 'All'],
          ['fill', 'Fillable'],
          ['pay', 'Pays'],
        ]
          .map(([k, l]) => `<button type="button" data-occ="${k}" class="${occFilter === k ? 'on' : ''}">${l}</button>`)
          .join('')}</span>
        <span class="muted small">${arbHits.length > 400 ? 'latest 400 of ' + arbHits.length : arbHits.length} shown${r.hitsTotal > r.hits.length ? ` · the scan kept ${r.hits.length.toLocaleString('en-IN')} of ${r.hitsTotal.toLocaleString('en-IN')} (every fillable one)` : ''}</span></div>
      <div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Day</th><th>Time</th><th class="l">Type</th><th class="l">Structure and check</th><th></th><th title="Edge when the signal was seen">Signal</th>
        ${
          q
            ? `<th title="Lots the best bid / ask could fill">Book</th><th title="How long it stayed at the bid / ask">Lasted</th><th title="Edge at the quotes after the latency (— = gone before then)">After ${r.opts.latency} s</th>`
            : '<th title="Edge at the worst prices traded in the same minute">Same min. worst</th><th title="Edge at the next minute\'s opening prices">Next open</th><th title="Edge at the next minute\'s worst prices">Next worst</th>'
        }
        <th title="Brokerage and taxes on ${lots} lots${q ? ', with the STT on bought legs estimated at the Nifty level then' : ', with the STT on bought legs at the actual settlement'}">Costs ₹</th><th title="What the fill locks in after costs on ${lots} lots">Locked ₹</th>${q ? '' : '<th title="What it made at the expiry\'s settlement after costs (fillable ones only: otherwise it is market direction)">At expiry ₹</th>'}<th></th></tr></thead>
        <tbody>${
          arbHits
            .slice(-400)
            .reverse()
            .map((h) => {
              const o = h.out;
              const ok = isFill(h, q);
              return `<tr><td>${dayShort(h.day)}</td><td>${h.time}</td><td class="l">${esc(typeOf(h.type) ? shortName(typeOf(h.type)) : h.type)} <span class="dir-pill">${esc(h.dir)}</span></td>
            <td class="l wrap">${esc(h.text)}</td><td>${mark(h)}</td><td>${num(h.value)}</td>
            ${q ? `<td>${h.fit == null ? '—' : lotsTxt(h.fit)}</td><td>${o ? `${o.alive ? '≥ ' : ''}${o.life} s` : '—'}</td>${td(o?.at)}` : `${td(h.robust)}${td(o?.eo)}${td(o?.ew)}`}
            ${o?.cost == null ? '<td class="muted">—</td>' : `<td>${inrS(o.cost)}</td>`}${tdInr(ok ? o.lock : null, true)}${q ? '' : tdInr(ok ? o.net : null)}${replay(h)}</tr>`;
            })
            .join('') ||
          `<tr><td colspan="14" class="muted l">${occFilter === 'all' ? 'No arbitrage signal with these thresholds.' : 'None: no signal passed that check.'}</td></tr>`
        }</tbody></table></div></div>`;

    const rvOcc = !rvS.length
      ? ''
      : `<div class="panel">
      <div class="chart-head"><h3>Relative-value occurrences</h3>${arbS.length ? '' : `<select id="anHitFilter"><option value="all">All types</option>${sum.map((s) => `<option value="${s.type}" ${hitFilter === s.type ? 'selected' : ''}>${nameOf(s.type)}</option>`).join('')}</select>`}
        <span class="muted small">${rvHits.length > 400 ? 'latest 400 of ' + rvHits.length : rvHits.length} shown</span></div>
      <div class="tbl-wrap an-log"><table class="grid-tbl an-tbl"><thead><tr><th>Day</th><th>Time</th><th class="l">Type</th><th>Strike</th><th>Dir</th><th>Deviation</th><th class="l">Detail</th><th>ATM IV</th>${H.map((h) => `<th>${hl(h)}</th>`).join('')}${q ? '' : '<th>Best / worst</th>'}<th title="${lots} lots of the suggested trade held to the end, after entry and exit costs">After costs ₹</th><th></th></tr></thead>
        <tbody>${
          rvHits
            .slice(-400)
            .reverse()
            .map(
              (h) => `<tr><td>${dayShort(h.day)}</td><td>${h.time}</td><td class="l">${nameOf(h.type)}</td>
          <td>${h.strike}${h.side ? ' ' + h.side : ''}</td><td><span class="dir-pill">${esc(h.dir)}</span></td><td>${fmtVal(h)}</td><td class="l wrap">${esc(h.text)}</td><td>${h.atmIv ?? '—'}</td>
          ${H.map((x) => td(h.out?.[x])).join('')}
          ${q ? '' : `<td class="small">${h.out?.best != null ? `<span class="pos">${num(h.out.best)}</span> / <span class="neg">${num(h.out.worst)}</span>` : '—'}</td>`}
          ${tdInr(h.out?.net, true)}${replay(h)}</tr>`,
            )
            .join('') || '<tr><td colspan="16" class="muted l">None of this type.</td></tr>'
        }</tbody></table></div></div>`;

    $('anHistRes').innerHTML =
      head +
      (sum.length
        ? arbTable + rvTable + arbOcc + rvOcc
        : '<div class="panel"><div class="muted pad">Nothing found with these thresholds: try the Loose strictness.</div></div>');
  }
  $('anHistRes').addEventListener('click', (e) => {
    const r = scans[scanOpts.source];
    if (!r) return;
    const a = e.target.closest('[data-f]');
    if (a) {
      e.preventDefault();
      hitFilter = a.dataset.f;
      renderScan();
      return;
    }
    const occ = e.target.closest('[data-occ]');
    if (occ) {
      occFilter = occ.dataset.occ;
      renderScan();
      return;
    }
    const rp = e.target.closest('[data-rp]');
    if (rp) {
      replayHit(r.hits[Number(rp.dataset.rp)], r);
      return;
    }
    const b = e.target.closest('[data-sbt]');
    if (b) {
      const t = typeOf(b.dataset.sbt);
      const h = r.hits.find((x) => x.type === t.id && x.dir === b.dataset.dir);
      openBacktest(t.id, b.dataset.dir || t.dirs[0], t.sided ? h?.side || 'CE' : null);
    }
  });
  $('anHistRes').addEventListener('change', (e) => {
    if (e.target.id === 'anHitFilter') {
      hitFilter = e.target.value;
      renderScan();
    }
  });

  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'an') init();
    else clearTimeout(liveTimer);
  });
  if (window.app.state.view === 'an') init();
})();
