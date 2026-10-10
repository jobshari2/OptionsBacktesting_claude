const REFRESH_MS = 400; // the server folds ticks into a snapshot every 500 ms
const STALE_MS = 15000;

const $ = (id) => document.getElementById(id);
const state = {
  expiry: localGet('expiry'),
  range: localGet('range') || 'auto', // 'auto' = as many strikes as fit on screen, else a number
  autoRange: 10,
  view: localGet('view') || 'chain',
  win: Number(localGet('win') || 5),
  data: null,
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
function localGet(k) { try { return localStorage.getItem('oc.' + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem('oc.' + k, v); } catch {} }

// ---------- data loop ----------
const API_VERSION = 16; // must match API_VERSION in server.js

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
    if (state.loggedOut) { state.loggedOut = false; showViews(); }
    // Chain errors only matter on the chain screen; the backtest screens report their own.
    setError(state.view === 'chain' ? json.error : null);
    if (json.expiries) renderExpiries(json.expiries, json.data?.expiry);
    state.feed = json.feed;
    if (json.data && json.data.updatedAt !== state.data?.updatedAt) {
      state.data = json.data;
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
  $('login').classList.remove('hidden');
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
  if (!d) { $('statusText').textContent = 'Waiting for data…'; return; }

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
    $('statusText').textContent = f?.connected
      ? `Live · ticks (${f.instruments})`
      : d.source === 'demo' ? 'Live' : 'Live · polling (tick feed connecting…)';
  }
}

function renderExpiries(list, current) {
  const sel = $('expiry');
  const key = list.join(',');
  if (sel.dataset.key !== key) {
    sel.innerHTML = list.map((e) => `<option value="${e}">${expiryLabel(e)}</option>`).join('');
    sel.dataset.key = key;
  }
  if (current) { sel.value = current; state.expiry = current; }
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
  $('windowSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.w) === state.win));
  renderLevels(d);
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
      const a = Math.min(0.45, Math.abs(buyPct - 50) / 50 * 0.45);
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
  const top = (side) => d.rows.filter((r) => r[side].oi > 0).sort((a, b) => b[side].oi - a[side].oi).slice(0, 2);
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

function renderLevels(d) {
  loadLevels();
  const L = state.levels;
  const spot = d.spot;
  if (!L) { $('lvLadder').innerHTML = '<div class="muted small pad">Loading levels…</div>'; return; }
  $('lvAsOf').textContent = L.error ? 'price levels unavailable' : `from ${L.sessions} sessions to ${L.basedOn}`;
  const all = [...(L.levels || []).map((l) => ({ ...l })), ...oiLevels(d).map((l) => ({ ...l, cls: l.cls, isOi: true }))];
  const near = (side, cls) => all.filter((l) => !l.isOi && (cls === 'any' || l.cls === cls) && (side === 'S' ? l.price < spot : l.price > spot))
    .sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))[0];
  const cell = (label, l, side) => `<div class="lvn ${side === 'S' ? 's' : 'r'}"><span>${label}</span><b>${l ? l.price : '—'}</b><span class="muted">${l ? (l.price - spot >= 0 ? '+' : '') + Math.round(l.price - spot) + ' pts' : ''}</span></div>`;
  $('lvNearest').innerHTML = cell('Major R', near('R', 'major'), 'R') + cell('Minor R', near('R', 'minor'), 'R') + cell('Minor S', near('S', 'minor'), 'S') + cell('Major S', near('S', 'major'), 'S');
  all.sort((a, b) => b.price - a.price);
  let html = '';
  let spotDone = false;
  for (const l of all) {
    if (!spotDone && l.price < spot) { html += `<div class="lv-spot">Nifty ${price(spot)}</div>`; spotDone = true; }
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
$('lvHead').addEventListener('click', () => setLevelsCollapsed(!$('levelsPanel').classList.contains('collapsed')));
setLevelsCollapsed(localGet('lvCollapsed') === '1');

// ---------- controls ----------
$('expiry').addEventListener('change', (e) => {
  state.expiry = e.target.value;
  localSet('expiry', state.expiry);
  state.prevLtp = {};
  scheduleRefresh(0);
});
$('range').addEventListener('change', (e) => {
  state.range = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
  localSet('range', state.range);
  if (state.data) render();
});

window.addEventListener('resize', () => { if (state.data) render(); });

// Tabs. The chain needs live data; the backtest screens work on their own once logged in.
const VIEWS = { chain: 'app', an: 'an', sb: 'sb', tr: 'tr', bt: 'bt', bw: 'bw', cmp: 'cmp', lib: 'lib', data: 'data' };
function showViews() {
  for (const [v, id] of Object.entries(VIEWS)) {
    const show = v === state.view && !state.loggedOut && (v !== 'chain' || state.data);
    $(id).classList.toggle('hidden', !show);
  }
  document.querySelectorAll('.chain-only').forEach((el) => el.classList.toggle('hidden', state.view !== 'chain'));
}
function setView(view) {
  if (!VIEWS[view]) view = 'chain';
  state.view = view;
  localSet('view', view);
  $('tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  showViews();
  if (view === 'chain' && state.data) render();
  if (view !== 'chain') setError(null);
  window.dispatchEvent(new CustomEvent('viewchange', { detail: view }));
}
$('tabs').addEventListener('click', (e) => { if (e.target.dataset.view) setView(e.target.dataset.view); });

window.app = { state, compact, pctText, render, istClock, esc, setView, setError, price };
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
