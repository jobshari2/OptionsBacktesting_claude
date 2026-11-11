// App shell: tabs, the refresh loop, status chip, Upstox sign-in return, theme and the service worker.
import * as store from './store.js';
import { createMarket, saveToken, tokenInfo } from './market.js';
import { exchangeCode } from './upstox.js';
import { marketOpen, fmtClock } from './time.js';
import { toast, esc } from './ui.js';
import market from './views/market.js';
import chain from './views/chain.js';
import strategies from './views/strategies.js';
import positions from './views/positions.js';
import settings, { appUrl } from './views/settings.js';

export const VERSION = '1.0.0';
const VIEWS = { market, chain, strategies, positions, settings };
const ICONS = {
  market: '<path d="M3 17l5-6 4 4 8-9"/><path d="M3 21h18"/>',
  chain: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M12 4v16"/>',
  strategies: '<path d="M3 18c4 0 5-12 9-12s5 12 9 12"/><path d="M3 12h18" stroke-dasharray="2 3"/>',
  positions: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};

const mkt = createMarket();
let current = null;
let timer = null;
let busy = false;
let status = { at: 0, stale: false, error: null };
let waitingSW = null;

const ctx = {
  version: VERSION,
  market: mkt,
  nav: (id) => (location.hash = '#' + id),
  refreshNow: () => tick(true),
  needsLogin: () => store.settings().source === 'upstox' && tokenInfo().state !== 'valid',
  setSource(src) {
    store.saveSettings({ source: src });
    status = { at: 0, stale: false, error: null };
    renderStatus();
    tick(true);
  },
  report(r) {
    if (!r || (!r.at && !r.error)) return;
    status = { at: r.at || status.at, stale: Boolean(r.stale || r.error), error: r.error || null };
    renderStatus();
  },
  applyTheme,
  checkUpdate,
};

function applyTheme() {
  const t = store.settings().theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function renderStatus() {
  const chip = document.getElementById('status');
  const src = store.settings().source;
  let cls = 'live';
  let text = src === 'demo' ? 'DEMO' : 'LIVE';
  if (src === 'demo') cls = 'demo';
  if (src === 'upstox' && tokenInfo().state !== 'valid') {
    cls = 'warn';
    text = 'LOG IN';
  } else if (status.error && !navigator.onLine) {
    cls = 'warn';
    text = 'OFFLINE';
  } else if (status.error) {
    cls = 'warn';
    text = 'ERROR';
  } else if (!marketOpen()) {
    text += ' · CLOSED';
  }
  chip.className = 'chip ' + cls;
  chip.textContent = text;
  chip.title = status.error ? status.error.message : '';
  document.getElementById('updated').textContent = status.at ? fmtClock(status.at) + (status.stale ? ' (saved)' : '') : '';
}

function show(id) {
  if (!VIEWS[id]) id = 'market';
  if (current === id) return;
  current = id;
  const main = document.getElementById('view');
  main.innerHTML = '';
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  const el = document.createElement('div');
  el.className = 'view view-' + id;
  main.appendChild(el);
  document.getElementById('title').textContent = VIEWS[id].title;
  document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === id ? 'page' : 'false'));
  VIEWS[id].mount(el, ctx);
  tick(true);
}

async function tick(now = false) {
  clearTimeout(timer);
  if (document.hidden && !now) return;
  if (!busy) {
    busy = true;
    const btn = document.getElementById('refresh');
    btn.classList.add('spin');
    try {
      await VIEWS[current]?.refresh(ctx);
    } catch (e) {
      ctx.report({ error: e });
    } finally {
      busy = false;
      btn.classList.remove('spin');
    }
  }
  const s = store.settings();
  const sec = marketOpen() || s.source === 'demo' ? s.refreshSec : 60;
  timer = setTimeout(() => tick(), Math.max(2, sec) * 1000);
}

// Upstox sends the browser back here with ?code=…&state=… after its login page.
async function finishLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code) return;
  const clean = () => history.replaceState(null, '', location.pathname + location.hash);
  const expected = store.get('oauthState');
  store.remove('oauthState');
  if (!expected || q.get('state') !== expected) {
    clean();
    toast('Ignored a login reply this app did not ask for');
    return;
  }
  const s = store.settings();
  try {
    const r = await exchangeCode({ code, apiKey: s.apiKey, apiSecret: s.apiSecret, redirectUri: s.redirectUri || appUrl() });
    saveToken(r.token, r.user);
    store.saveSettings({ source: 'upstox' });
    toast('Logged in to Upstox');
  } catch (e) {
    toast('Upstox login failed: ' + e.message, 5000);
  }
  clean();
}

// ---- service worker: offline start and updates ----
// Only a page that was already running under an older version is offered a reload (not the very first install).
const hadController = Boolean(globalThis.navigator?.serviceWorker?.controller);
function listenSW(reg) {
  const offer = (w) => {
    if (!hadController) return;
    waitingSW = w;
    const bar = document.getElementById('updateBar');
    bar.hidden = false;
  };
  if (reg.waiting) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
    });
  });
}

async function checkUpdate() {
  if (!('serviceWorker' in navigator)) return toast('Updates need a secure (https) address');
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return toast('Offline mode is not set up on this address');
  await reg.update().catch(() => {});
  if (reg.waiting || reg.installing) toast('Update found — tap “Reload” at the top');
  else toast(`Up to date (${VERSION})`);
}

function boot() {
  applyTheme();
  document.querySelector('.tabbar').innerHTML = Object.values(VIEWS)
    .map((v) => `<a href="#${v.id}" data-tab="${v.id}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[v.id]}</svg><span>${esc(v.title)}</span></a>`)
    .join('');
  document.getElementById('refresh').onclick = () => tick(true);
  document.getElementById('status').onclick = () => status.error && toast(status.error.message, 4000);
  document.getElementById('updateBtn').onclick = () => waitingSW?.postMessage('skipWaiting');
  mkt.onUnauthorized(() => {
    store.remove('token');
    renderStatus();
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  document.addEventListener('visibilitychange', () => document.hidden || tick(true));
  window.addEventListener('online', () => tick(true));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker
      .register('sw.js')
      .then(listenSW)
      .catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (waitingSW && !reloaded) {
        reloaded = true;
        location.reload();
      }
    });
  }

  // First run: no settings yet → demo data, so the screens show something; Settings explains how to log in.
  renderStatus();
  finishLogin().finally(() => show(location.hash.slice(1) || 'market'));
}

boot();
