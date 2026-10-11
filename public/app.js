const REFRESH_MS = 400; // the server folds ticks into a snapshot every 500 ms
const STALE_MS = 15000;

const $ = (id) => document.getElementById(id);
const state = {
  expiry: localGet('expiry'),
  range: localGet('range') || 'auto', // 'auto' = as many strikes as fit on screen, else a number
  autoRange: 10,
  view: localGet('view') || 'chain',
  win: Number(localGet('win') || 5),
  metric: localGet('metric') || 'qty', // surge bars sized by 'qty' or 'pct'
  threshold: Number(localGet('threshold') ?? 10), // highlight strikes whose volume grew ≥ this %
  sidePane: localGet('sidePane') || 'chart', // chain screen, right column: 'chart' (Nifty chart + levels) or 'signals'
  bottomPane: localGet('bottomPane') || 'arb', // chain screen, under the chain: 'arb' or 'surge'
  data: null,
  signals: null,
  seenEvents: null,
  unseenSignals: 0, // signals raised while the Signals pane was hidden
  unseenHigh: false, // ...one of them a high-probability one
  levels: null, // support / resistance from /api/bt/levels
  levelsAt: 0,
  prevLtp: {},
  scrolledFor: null,
  windowsBuilt: false,
};
$('range').value = String(state.range);

// ---------- formatting ----------
function compact(n) {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e7) return s + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return s + (a / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + ' K';
  return s + Math.round(a);
}
const price = (n) => (n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (n) => (n > 0 ? '+' : '') + compact(n);
// Volume growth % (null = strike had no volume at the start of the window).
function pctText(p, added) {
  if (p == null) return added > 0 ? 'new' : '';
  return (p < 10 ? p.toFixed(1) : Math.round(p)) + '%';
}
const dur = (sec) => (sec < 90 ? `${sec}s` : `${Math.round(sec / 60)}m`);
const istClock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
// HH:MM:SS.mmm in IST
const istClockMs = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 23);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function expiryLabel(e) {
  const d = new Date(e + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', weekday: 'short' });
}
function localGet(k) {
  try {
    return localStorage.getItem('oc.' + k);
  } catch {
    return null;
  }
}
function localSet(k, v) {
  try {
    localStorage.setItem('oc.' + k, v);
  } catch {}
}

// ---------- data loop ----------
const API_VERSION = 19; // must match API_VERSION in server.js

async function refresh() {
  let json;
  try {
    const q = state.expiry ? `?expiry=${encodeURIComponent(state.expiry)}` : '';
    const res = await fetch('/api/chain' + q, { cache: 'no-store' });
    json = await res.json();
  } catch (e) {
    setError('Cannot reach local server — is `npm start` running? (' + e.message + ')');
    updateStatus();
    scheduleRefresh(REFRESH_MS);
    return;
  }

  try {
    if (json.apiVersion !== API_VERSION) {
      setError('The server is running older code than this page. Restart it (Ctrl+C, then npm start) and reload.');
      return;
    }
    if (!json.loggedIn) {
      showLogin(json);
      return;
    }
    $('login').classList.add('hidden');
    if (state.loggedOut) {
      state.loggedOut = false;
      showViews();
    }
    // Chain errors only matter on the live screens; the other screens report their own.
    setError(groupOf(state.view) === 'live' ? json.error : null);
    if (json.expiries) renderExpiries(json.expiries, json.data?.expiry);
    state.feed = json.feed;
    if (json.data && json.data.updatedAt !== state.data?.updatedAt) {
      state.data = json.data;
      state.signals = json.signals;
      state.flow = json.flow;
      state.pulse = json.pulse;
      showViews();
      render();
    }
  } catch (e) {
    setError('Display error: ' + e.message + ' (logged to logs/errors.log)');
    reportError(e, 'render');
  } finally {
    updateStatus();
    scheduleRefresh(REFRESH_MS);
  }
}

// Send browser-side errors to the server's log file (same message at most once per minute).
const reported = new Map();
function reportError(err, where) {
  const message = err?.message || String(err);
  const now = Date.now();
  if (now - (reported.get(message) || 0) < 60_000) return;
  reported.set(message, now);
  fetch('/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, where, stack: err?.stack || '' }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.error || e.message, 'window'));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));

let refreshTimer;
function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

function showLogin(json) {
  state.loggedOut = true;
  showViews();
  $('login').classList.toggle('hidden', NO_LOGIN.has(state.view));
  $('loginMsg').textContent = json.error
    ? `${json.error}. Check UPSTOX_ACCESS_TOKEN in .env (restart the server after changing it) or log in again.`
    : json.configured
      ? 'Log in once per day to start streaming the Nifty option chain.'
      : 'Put your Upstox analytics token in UPSTOX_ACCESS_TOKEN in the .env file (or add UPSTOX_API_KEY and UPSTOX_API_SECRET to log in), then restart the server.';
  setError(null);
}

function setError(msg) {
  $('errorBar').textContent = msg || '';
  $('errorBar').classList.toggle('hidden', !msg);
}

// NSE F&O trading hours: Mon–Fri 09:15–15:30 IST (exchange holidays not accounted for).
function isMarketOpen(ts) {
  const ist = new Date(ts + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function updateStatus() {
  const el = $('status');
  const d = state.data;
  el.className = 'status';
  if (!d) {
    $('statusText').textContent = 'Waiting for data…';
    return;
  }

  const src = $('source');
  src.classList.remove('hidden');
  src.className = 'source ' + d.source;
  src.textContent = d.source === 'demo' ? 'DEMO DATA' : 'UPSTOX';
  src.title = d.source === 'demo' ? 'Synthetic data — not real prices' : 'Real market data from the Upstox API';

  const age = Date.now() - d.updatedAt;
  if (!$('errorBar').classList.contains('hidden')) {
    el.classList.add('err');
    $('statusText').textContent = 'Error';
  } else if (age >= STALE_MS) {
    el.classList.add('stale');
    $('statusText').textContent = 'Delayed';
  } else if (d.source !== 'demo' && !isMarketOpen(Date.now())) {
    el.classList.add('stale');
    $('statusText').textContent = 'Market closed · last session prices';
  } else {
    el.classList.add('live');
    const f = state.feed;
    $('statusText').textContent = f?.connected ? `Live · ticks (${f.instruments})` : d.source === 'demo' ? 'Live' : 'Live · polling (tick feed connecting…)';
  }
}

function renderExpiries(list, current) {
  const sel = $('expiry');
  const key = list.join(',');
  if (sel.dataset.key !== key) {
    sel.innerHTML = list.map((e) => `<option value="${e}">${expiryLabel(e)}</option>`).join('');
    sel.dataset.key = key;
  }
  if (current) {
    sel.value = current;
    state.expiry = current;
  }
}

// ---------- rendering ----------
function visibleRows(d) {
  const n = state.range === 'auto' ? state.autoRange : Number(state.range);
  const idx = d.rows.findIndex((r) => r.strike === d.atm);
  if (idx < 0 || n >= 999) return d.rows;
  return d.rows.slice(Math.max(0, idx - n), idx + n + 1);
}

// "Fit screen": how many strikes either side of ATM fit in the chain panel without scrolling.
function fitRange() {
  const wrap = $('tableWrap');
  const row = $('chainBody').querySelector('tr:not(.spot-row)');
  if (!wrap.clientHeight || !row) return state.autoRange;
  const head = wrap.querySelector('thead').offsetHeight;
  const rows = Math.floor((wrap.clientHeight - head - 4) / row.offsetHeight);
  return Math.max(3, Math.floor((rows - 2) / 2)); // minus the ATM row and the spot line
}

function render() {
  const d = state.data;
  $('spot').textContent = price(d.spot);
  $('atm').textContent = d.atm ?? '—';
  $('pcr').textContent = d.pcr == null ? '—' : d.pcr.toFixed(2);
  $('pcr').className = 'value ' + (d.pcr > 1 ? 'pos' : d.pcr < 0.8 ? 'neg' : '');
  buildWindowButtons(d.windows);
  document.querySelectorAll('.win-label').forEach((el) => (el.textContent = state.win + 'm'));

  window.BT?.chainArb?.(d); // before the chain: "Fit screen" measures the height this list leaves it
  let rows = visibleRows(d);
  renderChain(d, rows);
  if (state.range === 'auto' && state.view === 'chain') {
    const fit = fitRange();
    if (fit !== state.autoRange) {
      state.autoRange = fit;
      rows = visibleRows(d);
      renderChain(d, rows);
    }
  }
  $('windowSeg')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', Number(b.dataset.w) === state.win));
  renderLevels(d);
  renderSurge(d, rows);
  renderSignals(state.signals, d.source);
  renderPulseLine();
  runScreenHooks();
}

// The live-analysis screens (charts.js, flow-view.js, …) draw themselves from `state` on every refresh; each hook
// returns at once unless its screen is the one showing.
const SCREEN_HOOKS = ['onAppRender', 'onFlowRender', 'onPulseRender', 'onBookRender', 'onHedgeRender', 'onSignalTestRender'];
function runScreenHooks() {
  for (const h of SCREEN_HOOKS) window[h]?.();
}

function renderChain(d, rows) {
  const w = state.win;
  const maxCeOi = Math.max(1, ...rows.map((r) => r.ce.oi));
  const maxPeOi = Math.max(1, ...rows.map((r) => r.pe.oi));
  const maxDv = Math.max(1, ...rows.flatMap((r) => [r.ce.dVol[w], r.pe.dVol[w]]));
  const nextPrev = {};

  const ltpCell = (o, key, itm) => {
    const chg = o.close ? ((o.ltp - o.close) / o.close) * 100 : null;
    const prev = state.prevLtp[key];
    nextPrev[key] = o.ltp;
    const flash = prev == null || prev === o.ltp ? '' : o.ltp > prev ? ' flash-up' : ' flash-down';
    const chgHtml = chg == null ? '' : `<span class="chg ${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span>`;
    return `<td class="ltp${flash}${itm}">${price(o.ltp)}${chgHtml}</td>`;
  };
  const heat = (v, color) => {
    const a = v > 0 ? 0.08 + 0.55 * (v / maxDv) : 0;
    return a ? `style="background-color:rgba(${color},${a.toFixed(2)})"` : '';
  };
  const oiCell = (o, sideCls, max, isMax) => {
    const pct = ((o.oi / max) * 100).toFixed(0);
    return `<td class="oi ${sideCls}${isMax ? ' maxoi' : ''}"><div class="bar" style="width:${pct}%"></div><span>${compact(o.oi)}</span></td>`;
  };
  const oiChg = (o, itm) => {
    const c = o.oi - o.prevOi;
    return `<td class="${c > 0 ? 'pos' : c < 0 ? 'neg' : 'muted'}${itm}">${signed(c)}</td>`;
  };
  // Best bid / ask, tinted by order-book pressure (total qty waiting to buy vs to sell).
  const bookCell = (o, itm) => {
    if (!o.bid && !o.ask) return `<td class="ba muted${itm}">—</td>`;
    const fmt = (v) => (v ? v.toFixed(v >= 100 ? 1 : 2) : '—');
    let style = '';
    let tip = `Bid ${fmt(o.bid)} × ${o.bidQ ?? '—'} · Ask ${fmt(o.ask)} × ${o.askQ ?? '—'}`;
    if (o.bid && o.ask) tip += ` · spread ${(o.ask - o.bid).toFixed(2)}`;
    if (o.tbq != null && o.tsq != null && o.tbq + o.tsq > 0) {
      const buyPct = (o.tbq / (o.tbq + o.tsq)) * 100;
      const a = Math.min(0.45, (Math.abs(buyPct - 50) / 50) * 0.45);
      style = ` style="background-color:rgba(${buyPct >= 50 ? '63,182,139' : '240,113,107'},${a.toFixed(2)})"`;
      tip += ` · waiting to buy ${compact(o.tbq)} vs to sell ${compact(o.tsq)} (${buyPct.toFixed(0)}% buy)`;
    }
    return `<td class="ba${itm}"${style} title="${tip}">${fmt(o.bid)}<span class="sep">/</span>${fmt(o.ask)}</td>`;
  };
  const volDelta = (o, itm, color) => {
    const v = o.dVol[w];
    if (!v) return `<td class="vd${itm}"><span class="muted">0</span></td>`;
    return `<td class="vd${itm}" ${heat(v, color)}>+${compact(v)}<span class="chg">${pctText(o.pVol[w], v)}</span></td>`;
  };

  let html = '';
  let spotLineDone = false;
  for (const r of rows) {
    if (!spotLineDone && d.spot != null && r.strike > d.spot) {
      html += '<tr class="spot-row"><td colspan="15"></td></tr>';
      spotLineDone = true;
    }
    const ceItm = d.spot != null && r.strike < d.spot ? ' itm' : '';
    const peItm = d.spot != null && r.strike > d.spot ? ' itm' : '';
    const k = r.strike;
    html += `<tr class="${k === d.atm ? 'atm' : ''}" data-strike="${k}">
      ${oiCell(r.ce, 'ce' + ceItm, maxCeOi, r.ce.oi === maxCeOi)}
      ${oiChg(r.ce, ceItm)}
      <td class="${ceItm}">${compact(r.ce.vol)}</td>
      ${volDelta(r.ce, ceItm, '240,113,107')}
      <td class="muted${ceItm}">${r.ce.iv == null ? '—' : r.ce.iv.toFixed(1)}</td>
      ${bookCell(r.ce, ceItm)}
      ${ltpCell(r.ce, 'c' + k, ceItm)}
      <td class="strike">${k}${lvBadge(k, rows)}</td>
      ${ltpCell(r.pe, 'p' + k, peItm)}
      ${bookCell(r.pe, peItm)}
      <td class="muted${peItm}">${r.pe.iv == null ? '—' : r.pe.iv.toFixed(1)}</td>
      ${volDelta(r.pe, peItm, '63,182,139')}
      <td class="${peItm}">${compact(r.pe.vol)}</td>
      ${oiChg(r.pe, peItm)}
      ${oiCell(r.pe, 'pe' + peItm, maxPeOi, r.pe.oi === maxPeOi)}
    </tr>`;
  }
  $('chainBody').innerHTML = html;
  state.prevLtp = nextPrev;

  // Centre the ATM strike once per expiry/range selection (and the strike column, when the table is wider than its panel).
  const scrollKey = d.expiry + ':' + state.range;
  if (state.scrolledFor !== scrollKey) {
    const atmRow = $('chainBody').querySelector('tr.atm');
    const wrap = $('tableWrap');
    if (atmRow) wrap.scrollTop = atmRow.offsetTop - wrap.clientHeight / 2;
    wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
    state.scrolledFor = scrollKey;
  }
}

function buildWindowButtons(windows) {
  if (state.windowsBuilt) return;
  if (!windows.includes(state.win)) state.win = windows[0];
  $('windowSeg').innerHTML = windows.map((w) => `<button type="button" data-w="${w}">${w}m</button>`).join('');
  $('windowSeg').addEventListener('click', (e) => {
    const w = Number(e.target.dataset.w);
    if (!w) return;
    state.win = w;
    localSet('win', w);
    render();
  });
  state.windowsBuilt = true;
}

// ---------- volume surge + signals ----------
function renderSurge(d, rows) {
  const w = state.win;
  const tracked = d.trackingSec;
  const need = w * 60;
  const since = new Date(d.updatedAt - tracked * 1000).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  $('tracking').textContent =
    tracked < need
      ? `Filling ${w}m window: ${Math.floor(tracked / 60)}m ${tracked % 60}s so far (since ${since})`
      : `Volume added per strike, last ${w} min · numbers = top 3`;

  $('metricSeg')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.m === state.metric));
  $('thSeg')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', Number(b.dataset.t) === state.threshold));

  // Calls vs puts totals use the whole chain.
  const ceTotal = d.rows.reduce((s, r) => s + r.ce.dVol[w], 0);
  const peTotal = d.rows.reduce((s, r) => s + r.pe.dVol[w], 0);
  $('ceTotal').textContent = compact(ceTotal);
  $('peTotal').textContent = compact(peTotal);
  const sum = ceTotal + peTotal;
  $('ceShare').style.width = sum ? (ceTotal / sum) * 100 + '%' : '50%';
  $('peShare').style.width = sum ? (peTotal / sum) * 100 + '%' : '50%';

  // Ranking, bars and highlights use the visible strikes, by the selected metric.
  const byPct = state.metric === 'pct';
  const metric = (o) => {
    if (!byPct) return o.dVol[w];
    if (o.pVol[w] == null) return o.dVol[w] > 0 ? Infinity : 0;
    return o.pVol[w];
  };
  const isHit = (o) => state.threshold > 0 && o.dVol[w] > 0 && (o.pVol[w] == null || o.pVol[w] >= state.threshold);

  $('topBy').textContent = byPct ? '(by %)' : '(by qty)';
  const top = (key) =>
    rows
      .filter((r) => r[key].dVol[w] > 0)
      .sort((a, b) => metric(b[key]) - metric(a[key]))
      .slice(0, 3);
  const topCe = top('ce');
  const topPe = top('pe');
  const li = (list, key) =>
    list.length
      ? list
          .map(
            (r) =>
              `<li><b>${r.strike}</b> +${compact(r[key].dVol[w])}<span class="p">${pctText(r[key].pVol[w], r[key].dVol[w])}</span>${priceChange(r[key], w)}</li>`,
          )
          .join('')
      : '<li class="muted">No new volume yet</li>';
  $('topCe').innerHTML = li(topCe, 'ce');
  $('topPe').innerHTML = li(topPe, 'pe');

  const hitsCe = rows.filter((r) => isHit(r.ce)).length;
  const hitsPe = rows.filter((r) => isHit(r.pe)).length;
  $('thCount').textContent = state.threshold > 0 ? `CE ${hitsCe} · PE ${hitsPe} strikes` : '';

  // Column chart: CE volume added grows up, PE grows down, strikes along the bottom.
  // Only the top 3 per side carry a value label; every column has a hover tooltip.
  const rankCe = new Map(topCe.map((r, i) => [r.strike, i + 1]));
  const rankPe = new Map(topPe.map((r, i) => [r.strike, i + 1]));
  const finite = rows.flatMap((r) => [metric(r.ce), metric(r.pe)]).filter(Number.isFinite);
  const max = Math.max(byPct ? 0.0001 : 1, ...finite);
  const height = (o) => Math.min(100, (metric(o) / max) * 100);
  const bar = (o, rank) => {
    const h = height(o);
    const cls = isHit(o) ? 'hit' : rank ? '' : 'dim';
    return `<div class="bar ${cls}" style="height:${h}%"></div>${rank ? `<span class="lbl" style="--h:${h}%">${rank}</span>` : ''}`;
  };
  const tip = (r) =>
    `${r.strike} · last ${w}m&#10;CE +${compact(r.ce.dVol[w])} (${pctText(r.ce.pVol[w], r.ce.dVol[w]) || '0%'})&#10;PE +${compact(r.pe.dVol[w])} (${pctText(r.pe.pVol[w], r.pe.dVol[w]) || '0%'})`;
  $('bars').innerHTML = rows
    .map(
      (r) => `<div class="col${r.strike === d.atm ? ' atm' : ''}" title="${tip(r)}">
      <div class="up">${bar(r.ce, rankCe.get(r.strike))}</div>
      <div class="k">${r.strike % 100 === 0 || r.strike === d.atm ? r.strike : String(r.strike).slice(-3)}</div>
      <div class="down">${bar(r.pe, rankPe.get(r.strike))}</div>
    </div>`,
    )
    .join('');
}

// One-line Market Pulse headline in the Signals panel (click to open the full screen).
function renderPulseLine() {
  const p = state.pulse;
  const el = $('pulseLine');
  if (!el) return;
  el.classList.toggle('hidden', !p);
  if (!p) return;
  el.className = `pulse-line ${p.bias}`;
  el.innerHTML = `<span class="pl-label">Market pulse</span> ${esc(p.headline)}`;
}

// LTP change over the selected window, e.g. "₹ +12.40 (+8.3%)".
function priceChange(o, w) {
  const d = o.dLtp?.[w];
  if (d == null) return '';
  const base = o.ltp - d;
  const pct = base > 0 ? ` (${d >= 0 ? '+' : ''}${((d / base) * 100).toFixed(1)}%)` : '';
  const cls = d > 0 ? 'pos' : d < 0 ? 'neg' : 'muted';
  return `<div class="px ${cls}">₹ ${d >= 0 ? '+' : ''}${d.toFixed(2)}${pct}</div>`;
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// e.g. "1:20 · calm 12/30s" — a recording stops after the minimum time once nothing has fired for calmSec.
function recordingStatus(rec, now) {
  const running = mmss((now - rec.startedAt) / 1000);
  const minLeft = rec.minAfterSec - (now - rec.lastSignalAt) / 1000;
  if (minLeft > 0) return `${running} · min ${Math.ceil(minLeft)}s left`;
  const calm = Math.min(rec.calmSec, Math.floor((now - rec.lastHotAt) / 1000));
  return `${running} · ${calm > 0 ? `calm ${calm}/${rec.calmSec}s` : 'still active'}`;
}

const TYPE_LABEL = {
  'strike-spike': 'VOLUME SPIKE',
  'broad-surge': 'BROAD SURGE',
  'premium-up': 'PREMIUM ▲',
  'premium-down': 'PREMIUM ▼',
  'premium-spike': 'PREMIUM JUMP', // older recordings
  'both-rising': 'CE + PE RISING',
  'spot-up': 'NIFTY ▲',
  'spot-down': 'NIFTY ▼',
  'spot-move': 'SPOT MOVE', // older recordings
};

// ATM call/put/straddle premium change over the last minute.
function renderPremium(p, r) {
  const el = $('premium');
  if (!p) {
    el.innerHTML = '<span class="muted">Premiums (1m): collecting…</span>';
    return;
  }
  const v = (x) => (x == null ? '—' : `<b class="${x > 0 ? 'pos' : x < 0 ? 'neg' : ''}">${x >= 0 ? '+' : ''}${x.toFixed(1)}%</b>`);
  el.innerHTML = `<span class="muted">Premiums (1m) · ATM ${p.atm}</span>
    <span>CE ${v(p.ce)}</span><span>PE ${v(p.pe)}</span><span>Straddle ${v(p.straddle)}</span>
    <span class="pill both-rising${p.bothRising ? '' : ' off'}" title="Strikes around ATM where calls and puts are both up ≥${r.bothRisePct}% in the last minute">
      CE + PE rising ${p.both}/${p.pairs}</span>`;
}

// Track record of this kind of signal on earlier days (from sigstats.js), e.g. "▼ 81%  Nifty fell 10 pts before ...".
function oddsText(o) {
  const [did, other] = o.dir === 'up' ? ['rose', 'falling'] : ['fell', 'rising'];
  return (
    `Nifty ${did} ${o.pts} pts before ${other} ${o.pts}, within ${o.min} min, in ${o.hits} of ${o.n} past cases` +
    ` (any moment: ${Math.round(o.base * 100)}%) · ${o.days} day${o.days === 1 ? '' : 's'} of data`
  );
}
function oddsLine(o) {
  if (!o) return '';
  const pct = `${o.dir === 'up' ? '▲' : '▼'} ${Math.round(o.p * 100)}%`;
  return `<div class="ev-odds${o.high ? ' high ' + o.dir : ''}"><b>${o.high ? 'HIGH PROBABILITY ' : ''}${pct}</b> ${esc(oddsText(o))}</div>`;
}

// While a high-probability signal is still inside its outcome window, show it as a banner.
function renderOddsBanner(sig) {
  const now = state.data.updatedAt;
  const e = sig.events.find((x) => x.odds?.high && now - x.t < x.odds.min * 60_000);
  const el = $('oddsBanner');
  el.classList.toggle('hidden', !e);
  if (!e) return;
  const o = e.odds;
  el.className = `odds-banner ${o.dir}`;
  el.innerHTML = `<span class="pct">${o.dir === 'up' ? '▲' : '▼'} ${Math.round(o.p * 100)}%</span>
    <span><b>${esc(o.label)}</b> at ${istClock(e.t)} · ${esc(oddsText(o))}
    <span class="muted">· ${mmss(Math.max(0, o.min * 60 - (now - e.t) / 1000))} left</span></span>`;
}

function renderSignals(sig, source) {
  if (!sig) return;
  const b = sig.breadth;
  const r = sig.rules;
  $('signalsExpiry').textContent = '· ' + expiryLabel(sig.expiry);
  $('eventsDir').textContent = source === 'demo' ? 'events-demo/' : 'events/';

  renderPremium(b.premium, r);

  // Breadth meter + broad surge banner
  $('breadthMark').style.left = r.broadPct + '%';
  const fill = $('breadthFill');
  if (!b.ready) {
    $('breadthVal').textContent = '—';
    fill.style.width = '0';
    $('breadthNote').textContent = `Learning normal volume — volume signals start in ~${Math.max(1, Math.ceil(b.readyInSec / 60))} min.`;
    $('broadBanner').classList.add('hidden');
  } else {
    $('breadthVal').textContent = Math.round(b.pct) + '%';
    fill.style.width = Math.min(100, b.pct) + '%';
    fill.classList.toggle('hot', b.active);
    $('breadthNote').textContent =
      `${b.elevated} of ${b.legs} strikes at ≥${r.broadRatio}× normal volume (CE ${b.ce} · PE ${b.pe}). Signal fires at ${r.broadPct}%.`;
    $('broadBanner').classList.toggle('hidden', !b.active);
    $('broadBanner').textContent =
      `⚡ BROAD VOLUME SURGE — ${Math.round(b.pct)}% of strikes near ATM trading ≥${r.broadRatio}× normal volume (CE ${b.ce} · PE ${b.pe})`;
  }

  renderOddsBanner(sig);

  $('rec').classList.toggle('hidden', !sig.recording);
  if (sig.recording) $('rec').textContent = 'REC ' + recordingStatus(sig.recording, state.data.updatedAt);

  // Event log
  const firstLoad = state.seenEvents == null;
  const seen = state.seenEvents || new Set();
  const fresh = sig.events.filter((e) => !seen.has(e.id));
  if (!firstLoad && fresh.length) {
    const panel = $('signalsPanel');
    panel.classList.remove('alert');
    void panel.offsetWidth; // restart the animation
    panel.classList.add('alert');
    if (state.sidePane !== 'signals') {
      state.unseenSignals += fresh.length;
      state.unseenHigh ||= fresh.some((e) => e.odds?.high);
      renderSignalBadge();
    }
  }
  sig.events.forEach((e) => seen.add(e.id));
  state.seenEvents = seen;

  if (!sig.events.length) {
    $('events').innerHTML = `<li class="muted small">No spikes yet today. Watching for: a strike trading ≥${r.spikeRatio}× its normal volume,
      ≥${r.broadPct}% of strikes trading ≥${r.broadRatio}× normal at once, a CE or PE premium rising or falling ≥${r.priceSpikePct}% in 1 min,
      calls and puts both rising ≥${r.bothRisePct}% on ${r.bothRisePairs}+ strikes around ATM,
      and Nifty rising or falling ≥${r.spotFastPts} pts in 20 s or ≥${r.spotMovePts} pts in 1 min.
      Each spike saves ${r.beforeMin} min before and ${r.afterMin} min after to a file.</li>`;
    return;
  }
  const freshIds = new Set(firstLoad ? [] : fresh.map((e) => e.id));
  $('events').innerHTML = sig.events
    .map((e) => {
      const a = e.after;
      let after = sig.recording ? `<span class="muted">recording ${mmss((state.data.updatedAt - e.t) / 1000)}</span>` : '<span class="muted">recording…</span>';
      let summary = '';
      if (a) {
        const chg = a.change ?? 0;
        after = `<span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)} pts</span> <span class="muted">in ${dur(a.afterSec)}</span>`;
        summary = `<div class="ev-detail">Before → after: CE vol +${compact(a.ceBefore)} → +${compact(a.ceAfter)},
        PE vol +${compact(a.peBefore)} → +${compact(a.peAfter)} · max ↑${(a.maxUp ?? 0).toFixed(1)} ↓${Math.abs(a.maxDown ?? 0).toFixed(1)}
        · <code>${esc(e.file || '')}</code></div>`;
      }
      const hp = e.odds?.high ? ` hp ${e.odds.dir}` : '';
      return `<li class="${freshIds.has(e.id) ? 'new' : ''}${hp}">
      <div class="ev-top"><span class="ev-time">${istClock(e.t)}</span><span class="pill ${e.type}">${TYPE_LABEL[e.type] || e.type}</span><span class="ev-after">${after}</span></div>
      <div class="ev-detail">${esc(e.detail)}</div>${oddsLine(e.odds)}${summary}
    </li>`;
    })
    .join('');
}

// New signals raised while the Signals pane is hidden are counted on its switch.
function renderSignalBadge() {
  const el = $('sigBadge');
  el.textContent = state.unseenSignals || '';
  el.classList.toggle('hidden', !state.unseenSignals);
  el.classList.toggle('hp', state.unseenHigh);
  el.title = state.unseenHigh ? 'New signals, one of them high-probability' : 'New signals';
}

// ---------- support / resistance ----------
// Price levels come from the server (computed from Nifty history before today); OI levels from this chain.
async function loadLevels() {
  if (Date.now() - state.levelsAt < 5 * 60_000) return;
  state.levelsAt = Date.now();
  try {
    const res = await fetch('/api/bt/levels', { cache: 'no-store' });
    const j = await res.json();
    state.levels = res.ok ? j : { error: j.error };
  } catch (e) {
    state.levels = { error: e.message };
  }
  if (state.data && state.view === 'chain') render();
}

// The two highest-OI call strikes (resistance) and put strikes (support) on this expiry.
function oiLevels(d) {
  const top = (side) =>
    d.rows
      .filter((r) => r[side].oi > 0)
      .sort((a, b) => b[side].oi - a[side].oi)
      .slice(0, 2);
  return [
    ...top('ce').map((r, i) => ({ price: r.strike, cls: i ? 'minor' : 'major', src: `${i ? '2nd' : 'max'} call OI ${compact(r.ce.oi)}`, oi: 'ce' })),
    ...top('pe').map((r, i) => ({ price: r.strike, cls: i ? 'minor' : 'major', src: `${i ? '2nd' : 'max'} put OI ${compact(r.pe.oi)}`, oi: 'pe' })),
  ];
}

// Levels that fall on this strike (between it and the next one down), for the badge in the strike cell.
function lvBadge(k, rows) {
  const lv = state.levels?.levels;
  if (!lv || state.data?.spot == null) return '';
  const i = rows.findIndex((r) => r.strike === k);
  const step = i > 0 ? k - rows[i - 1].strike : rows[1] ? rows[1].strike - k : 50;
  const here = lv.filter((l) => Math.abs(l.price - k) < step / 2);
  if (!here.length) return '';
  const major = here.some((l) => l.cls === 'major');
  const res = here[0].price > state.data.spot;
  const tip = here.map((l) => `${l.price} ${l.cls} ${res ? 'resistance' : 'support'} · ${l.src}`).join('&#10;');
  return `<span class="lv-tag ${res ? 'r' : 's'}${major ? ' major' : ''}" title="${esc(tip)}">${res ? 'R' : 'S'}</span>`;
}

// The nearest major and minor resistance and support around `spot` (price levels, not OI), as the four cells of a
// .lv-nearest grid. Shown on the Chain screen and on Market Pulse.
function nearestLevelsHtml(spot) {
  const lv = state.levels?.levels || [];
  const near = (side, cls) =>
    lv.filter((l) => l.cls === cls && (side === 'S' ? l.price < spot : l.price > spot)).sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0];
  const cell = (label, l, side) =>
    `<div class="lvn ${side === 'S' ? 's' : 'r'}"><span>${label}</span><b>${l ? l.price : '—'}</b><span class="muted">${l ? (l.price - spot >= 0 ? '+' : '') + Math.round(l.price - spot) + ' pts' : ''}</span></div>`;
  return (
    cell('Major R', near('R', 'major'), 'R') +
    cell('Minor R', near('R', 'minor'), 'R') +
    cell('Minor S', near('S', 'minor'), 'S') +
    cell('Major S', near('S', 'major'), 'S')
  );
}

function renderLevels(d) {
  loadLevels();
  const L = state.levels;
  const spot = d.spot;
  if (!L) {
    $('lvLadder').innerHTML = '<div class="muted small pad">Loading levels…</div>';
    return;
  }
  $('lvAsOf').textContent = L.error ? 'price levels unavailable' : `from ${L.sessions} sessions to ${L.basedOn}`;
  const all = [...(L.levels || []).map((l) => ({ ...l })), ...oiLevels(d).map((l) => ({ ...l, cls: l.cls, isOi: true }))];
  $('lvNearest').innerHTML = nearestLevelsHtml(spot);
  all.sort((a, b) => b.price - a.price);
  let html = '';
  let spotDone = false;
  for (const l of all) {
    if (!spotDone && l.price < spot) {
      html += `<div class="lv-spot">Nifty ${price(spot)}</div>`;
      spotDone = true;
    }
    const side = l.price > spot ? 'r' : 's';
    html += `<div class="lv-row ${side} ${l.cls}${l.isOi ? ' oi' : ''}"><span class="lv-p">${l.price}</span><span class="lv-c">${l.isOi ? 'OI' : l.cls}</span><span class="lv-src" title="${esc(l.src)}">${esc(l.src)}</span><span class="lv-d">${l.price - spot >= 0 ? '+' : ''}${Math.round(l.price - spot)}</span></div>`;
  }
  if (!spotDone) html += `<div class="lv-spot">Nifty ${price(spot)}</div>`;
  $('lvLadder').innerHTML = (L.error ? `<div class="err small">Price levels: ${esc(L.error)}</div>` : '') + html;
}

// The panel folds down to its header, which leaves its height to the Nifty chart above it.
function setLevelsCollapsed(on) {
  $('levelsPanel').classList.toggle('collapsed', on);
  $('lvCaret').textContent = on ? '▸' : '▾';
  localSet('lvCollapsed', on ? '1' : '');
}
$('lvHead').addEventListener('click', (e) => {
  const tab = e.target.closest('#lvTabs button');
  if (tab) {
    setLevelsTab(tab.dataset.t);
    setLevelsCollapsed(false);
  } else setLevelsCollapsed(!$('levelsPanel').classList.contains('collapsed'));
});
setLevelsCollapsed(localGet('lvCollapsed') === '1');

// ---------- order flow ----------
// The panel under the chart has two tabs: the support / resistance ladder and a read of the order flow of the
// Nifty options (server: orderflow.js). The chart draws the same flow in its own panes (chain-chart.js).
function setLevelsTab(t) {
  if (t !== 'flow') t = 'levels';
  state.lvTab = t;
  localSet('lvTab', t);
  $('lvLevels').classList.toggle('hidden', t !== 'levels');
  $('lvFlow').classList.toggle('hidden', t !== 'flow');
  $('lvAsOf').classList.toggle('hidden', t !== 'levels');
  $('lvTabs')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'flow') loadFlowRead(true);
}

const TONE_WORD = { bull: 'bullish', bear: 'bearish', neutral: 'neutral' };
let flowReadAt = 0;
async function loadFlowRead(force) {
  if (!force && (Date.now() - flowReadAt < 5000 || document.hidden || state.view !== 'chain')) return;
  flowReadAt = Date.now();
  try {
    // `since` in the future: only the read itself, no minute rows
    const res = await fetch('/api/orderflow?since=' + Date.now(), { cache: 'no-store' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    state.flowRead = j;
  } catch (e) {
    state.flowRead = { error: e.message };
  }
  renderFlowRead();
}

function renderFlowRead() {
  const j = state.flowRead;
  const a = j?.analysis;
  const dot = $('ofDot');
  dot.classList.toggle('hidden', !a?.ready);
  if (a?.ready) dot.className = 'of-dot ' + a.verdict.tone;
  if (state.lvTab !== 'flow') return;
  const lot = j?.lot || 65;
  const lots = (x) =>
    x == null
      ? '—'
      : (x > 0 ? '+' : x < 0 ? '−' : '') +
        compact(Math.abs(x) / lot)
          .replace(' K', 'k')
          .replace(' L', 'L');
  const qty = (x) =>
    compact(x / lot)
      .replace(' K', 'k')
      .replace(' L', 'L');
  if (!j) {
    $('ofVerdict').innerHTML = '<div class="muted small pad">Loading order flow…</div>';
    return;
  }
  if (j.error) {
    $('ofVerdict').innerHTML = `<div class="err small pad">Order flow: ${esc(j.error)}</div>`;
    $('ofReasons').innerHTML = $('ofTable').innerHTML = '';
    return;
  }
  if (!a?.ready) {
    $('ofVerdict').innerHTML =
      `<div class="muted small pad">${esc(a?.note || 'No order flow recorded yet.')}${j.pending ? ' Reading earlier days…' : ''}</div>`;
    $('ofReasons').innerHTML = $('ofTable').innerHTML = '';
    return;
  }
  const old = a.day !== j.today;
  const v = a.verdict;
  const pos = 50 + v.score * 50; // −1…+1 across the meter
  $('ofVerdict').innerHTML = `<div class="of-head"><span class="of-label ${v.tone}">${esc(v.label)}</span>
      <span class="muted small">${old ? `last session ${esc(a.day)} · ` : ''}as of ${istClock(a.asOf)} · ${a.minutes} min of flow${a.book != null ? ` · book lean ${a.book.toFixed(0)}%` : ''}</span></div>
    <div class="of-meter" title="Strength ${v.strength}%: left = selling, right = buying"><i class="mid"></i><b style="left:${pos.toFixed(1)}%" class="${v.tone}"></b></div>
    <div class="of-meter-labels"><span>Sellers</span><span>Balanced</span><span>Buyers</span></div>`;
  $('ofReasons').innerHTML = a.reasons
    .map((r) => `<div class="of-reason ${r.tone}"><b>${esc(r.title)}</b> <span class="muted small">${TONE_WORD[r.tone]}</span><div>${esc(r.text)}</div></div>`)
    .join('');
  $('ofTable').innerHTML =
    `<table class="of-tbl"><thead><tr><th></th><th title="Calls bought at the ask">Call buy</th><th title="Calls sold at the bid">Call sell</th><th title="Puts bought at the ask">Put buy</th><th title="Puts sold at the bid">Put sell</th><th title="Calls bought + puts sold − calls sold − puts bought">Delta</th><th title="Delta as a share of everything traded">Bias</th></tr></thead><tbody>${a.windows
      .map(
        (w) =>
          `<tr><th>${esc(w.label)}</th><td>${qty(w.cb)}</td><td>${qty(w.cs)}</td><td>${qty(w.pb)}</td><td>${qty(w.ps)}</td><td class="${w.net >= 0 ? 'pos' : 'neg'}">${lots(w.net)}</td><td class="${w.bias >= 0 ? 'pos' : 'neg'}">${w.bias >= 0 ? '+' : '−'}${Math.abs(w.bias * 100).toFixed(1)}%</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table><div class="muted small pad">Lots (1 lot = ${lot}). Cumulative delta for the session: <b class="${a.cvd >= 0 ? 'pos' : 'neg'}">${lots(a.cvd)}</b>${a.chg15 != null ? ` · Nifty ${a.chg15 >= 0 ? '+' : '−'}${Math.abs(a.chg15).toFixed(1)} pts in 15 min` : ''}</div>`;
}
setInterval(() => loadFlowRead(false), 1000);
setLevelsTab(localGet('lvTab') || 'levels');

// ---------- controls ----------
$('expiry').addEventListener('change', (e) => {
  state.expiry = e.target.value;
  localSet('expiry', state.expiry);
  state.prevLtp = {};
  scheduleRefresh(0);
});
$('metricSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.m) return;
  state.metric = e.target.dataset.m;
  localSet('metric', state.metric);
  if (state.data) render();
});
$('thSeg').addEventListener('click', (e) => {
  if (e.target.dataset.t == null) return;
  state.threshold = Number(e.target.dataset.t);
  localSet('threshold', state.threshold);
  if (state.data) render();
});
$('range').addEventListener('change', (e) => {
  state.range = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
  localSet('range', state.range);
  if (state.data) render();
});

window.addEventListener('resize', () => {
  if (state.data) render();
});

// Chain screen: the right column shows the Nifty chart with support / resistance or the signals; the panel under
// the chain shows the spread arbitrage or the volume surge.
const PANES = {
  side: { seg: 'chSideSeg', key: 'sidePane', panes: { chart: ['niftyPanel', 'levelsPanel'], signals: ['signalsPanel'] } },
  bottom: { seg: 'chBottomSeg', key: 'bottomPane', panes: { arb: ['chArbPanel'], surge: ['surgePanel'] } },
};
function setPane(which, name) {
  const P = PANES[which];
  if (!P.panes[name]) name = Object.keys(P.panes)[0];
  state[P.key] = name;
  localSet(P.key, name);
  for (const [p, ids] of Object.entries(P.panes)) ids.forEach((id) => $(id).classList.toggle('hidden', p !== name));
  $(P.seg)
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.p === name));
  if (state.sidePane === 'signals') {
    state.unseenSignals = 0;
    state.unseenHigh = false;
    renderSignalBadge();
  }
  if (state.data && state.view === 'chain') render(); // "Fit screen" depends on the height the bottom pane leaves
}
for (const [which, P] of Object.entries(PANES)) {
  $(P.seg).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setPane(which, b.dataset.p);
  });
  setPane(which, state[P.key]);
}

// Screens, grouped as in the top bar: the groups and their screens are read from the page (#subtabs).
const GROUPS = Object.fromEntries(
  [...document.querySelectorAll('#subtabs .sub-group')].map((g) => [g.dataset.group, [...g.querySelectorAll('button')].map((b) => b.dataset.view)]),
);
const VIEWS = Object.fromEntries(
  Object.values(GROUPS)
    .flat()
    .map((v) => [v, v === 'chain' ? 'app' : v]),
); // screen -> its <main>
const NO_LOGIN = new Set(['sigtest']); // reads recorded days only, so it also works before logging in
const NEEDS_DATA = new Set(GROUPS.live.filter((v) => !NO_LOGIN.has(v))); // drawn from the live chain: shown once it has arrived
function groupOf(view) {
  return Object.keys(GROUPS).find((g) => GROUPS[g].includes(view));
}
function showViews() {
  for (const [v, id] of Object.entries(VIEWS)) {
    const show = v === state.view && (!state.loggedOut || NO_LOGIN.has(v)) && (!NEEDS_DATA.has(v) || state.data);
    $(id).classList.toggle('hidden', !show);
  }
  // ATM, PCR, expiry and strike range describe the live chain.
  const live = groupOf(state.view) === 'live';
  document.querySelectorAll('.chain-only').forEach((el) => el.classList.toggle('hidden', !live));
}
function setView(view) {
  if (view === 'backtest') view = 'sigtest'; // what this screen was called in OptionLiveData (still in localStorage)
  if (!VIEWS[view]) view = 'chain';
  state.view = view;
  localSet('view', view);
  const group = groupOf(view);
  localSet('view.' + group, view); // a group reopens on the screen last used in it
  $('tabs')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.group === group));
  $('subtabs').classList.toggle('hidden', GROUPS[group].length < 2);
  $('subtabs')
    .querySelectorAll('.sub-group')
    .forEach((g) => g.classList.toggle('hidden', g.dataset.group !== group));
  $('subtabs')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  showViews();
  if (state.loggedOut) $('login').classList.toggle('hidden', NO_LOGIN.has(view));
  if (group === 'live' && state.data) render();
  else runScreenHooks();
  if (group !== 'live') setError(null);
  window.dispatchEvent(new CustomEvent('viewchange', { detail: view }));
}
$('tabs').addEventListener('click', (e) => {
  const g = e.target.dataset.group;
  if (g) setView(localGet('view.' + g) || GROUPS[g][0]);
});
$('subtabs').addEventListener('click', (e) => {
  if (e.target.dataset.view) setView(e.target.dataset.view);
});

window.app = { state, compact, pctText, render, istClock, esc, setView, setError, price, TYPE_LABEL, nearestLevelsHtml };
setView(state.view);

// Top-bar clock with milliseconds, plus how old the last fetched data is.
function tickClock() {
  const now = Date.now();
  $('clock').textContent = istClockMs(now);
  const d = state.data;
  if (d) {
    const age = ((now - d.updatedAt) / 1000).toFixed(1);
    $('fetchedAt').innerHTML = `${istClockMs(d.updatedAt)}<span class="age">${age}s ago</span>`;
  }
  requestAnimationFrame(tickClock);
}
requestAnimationFrame(tickClock);

refresh();
