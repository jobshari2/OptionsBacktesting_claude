// Settings: data source, Upstox sign-in (on the phone), refresh, trading costs, theme, backup.
import * as store from '../store.js';
import * as positions from '../positions.js';
import { loginUrl } from '../upstox.js';
import { tokenInfo, saveToken } from '../market.js';
import { esc, toast, confirmSheet } from '../ui.js';
import { fmtClock, fmtDate, ist } from '../time.js';

let root;

export const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');

function tokenLine() {
  const t = tokenInfo();
  if (t.state === 'none') return '<span class="badge warn">Not logged in</span>';
  if (t.state === 'expired') return '<span class="badge warn">Token expired (Upstox tokens end at 03:30 IST)</span>';
  const e = ist(t.expiresAt);
  return `<span class="badge ok">Logged in${t.user ? ' as ' + esc(t.user) : ''}</span> <span class="muted small">valid until ${fmtDate(e.date)} 03:30 IST · saved ${fmtClock(t.savedAt)}</span>`;
}

function render(ctx) {
  const s = store.settings();
  root.innerHTML = `
  <section class="card">
    <h2>Data source</h2>
    <div class="seg" id="seSource"><button data-src="upstox" class="${s.source === 'upstox' ? 'on' : ''}">Upstox (live)</button><button data-src="demo" class="${s.source === 'demo' ? 'on' : ''}">Demo (simulated)</button></div>
    <p class="muted small">The app talks to api.upstox.com only, straight from this phone. Demo makes up prices on the phone, for trying the app with no account.</p>
  </section>

  <section class="card">
    <h2>Upstox</h2>
    <p id="seToken">${tokenLine()}</p>
    <details ${s.apiKey ? '' : 'open'}><summary>Log in with Upstox (API key)</summary>
      <label class="field"><span>API key</span><input id="seKey" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(s.apiKey)}"></label>
      <label class="field"><span>API secret</span><input id="seSecret" type="password" autocomplete="off" value="${esc(s.apiSecret)}"></label>
      <label class="field"><span>Redirect URL (must match the Upstox app exactly)</span><input id="seRedirect" autocapitalize="off" spellcheck="false" placeholder="${esc(appUrl())}" value="${esc(s.redirectUri)}"></label>
      <p class="muted small">Key and secret stay in this browser on this phone. Create the app at account.upstox.com/developer/apps with the Redirect URL above.</p>
      <button class="btn primary block" id="seLogin">Log in with Upstox</button>
    </details>
    <details><summary>Paste an access token instead</summary>
      <label class="field"><span>Access token</span><textarea id="seTokenIn" rows="3" autocapitalize="off" spellcheck="false" placeholder="eyJ0eXAiOiJKV1Qi…"></textarea></label>
      <button class="btn block" id="seTokenSave">Use this token</button>
    </details>
    <button class="btn block" id="seLogout" ${tokenInfo().state === 'none' ? 'hidden' : ''}>Forget the token</button>
  </section>

  <section class="card">
    <h2>Refresh and trading costs</h2>
    <div class="form-grid">
      <label class="field"><span>Refresh every (s, market hours)</span><input id="seRefresh" type="number" inputmode="numeric" min="2" max="120" value="${s.refreshSec}"></label>
      <label class="field"><span>Lot size (0 = from Upstox)</span><input id="seLot" type="number" inputmode="numeric" min="0" max="500" value="${s.lotSize}"></label>
      <label class="field"><span>Slippage % of premium</span><input id="seSlip" type="number" inputmode="decimal" step="0.1" min="0" max="5" value="${s.slipPct}"></label>
      <label class="field"><span>Brokerage ₹ / order</span><input id="seBrk" type="number" inputmode="decimal" min="0" max="100" value="${s.brokerage}"></label>
    </div>
  </section>

  <section class="card">
    <h2>Appearance</h2>
    <div class="seg" id="seTheme">${['system', 'light', 'dark'].map((t) => `<button data-theme="${t}" class="${s.theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
  </section>

  <section class="card">
    <h2>Backup</h2>
    <p class="muted small">${positions.list().length} paper position(s) on this phone${store.persistent() ? '' : ' — <b>storage is off in this browser mode; nothing will be kept after closing</b>'}.</p>
    <div class="row gap wrap"><button class="btn" id="seExport">Export backup</button><label class="btn file">Import backup<input id="seImport" type="file" accept="application/json,.json" hidden></label></div>
    <button class="btn danger block" id="seReset">Erase everything on this phone</button>
  </section>

  <section class="card about">
    <h2>About</h2>
    <p class="muted small">Nifty Options Mobile <span id="seVer"></span>. Paper positions only — no orders are placed. Not investment advice.</p>
    <button class="btn block" id="seUpdate">Check for update</button>
  </section>`;

  root.querySelector('#seSource').onclick = (e) => {
    const src = e.target.closest('[data-src]')?.dataset.src;
    if (src) {
      ctx.setSource(src);
      render(ctx);
    }
  };
  const saveCreds = () =>
    store.saveSettings({ apiKey: root.querySelector('#seKey').value.trim(), apiSecret: root.querySelector('#seSecret').value.trim(), redirectUri: root.querySelector('#seRedirect').value.trim() });
  ['#seKey', '#seSecret', '#seRedirect'].forEach((id) => root.querySelector(id).addEventListener('change', saveCreds));
  root.querySelector('#seLogin').onclick = () => {
    saveCreds();
    const st = store.settings();
    if (!st.apiKey || !st.apiSecret) return toast('Enter the API key and secret first');
    const state = Math.random().toString(36).slice(2);
    store.set('oauthState', state);
    location.href = loginUrl({ apiKey: st.apiKey, redirectUri: st.redirectUri || appUrl(), state });
  };
  root.querySelector('#seTokenSave').onclick = () => {
    const t = root.querySelector('#seTokenIn').value.trim();
    if (t.length < 20) return toast('That does not look like an Upstox token');
    saveToken(t);
    ctx.setSource('upstox');
    toast('Token saved');
    render(ctx);
  };
  root.querySelector('#seLogout').onclick = async () => {
    if (await confirmSheet('Forget the Upstox token on this phone?', 'Forget')) {
      store.remove('token');
      render(ctx);
      ctx.refreshNow();
    }
  };
  const nums = () =>
    store.saveSettings({
      refreshSec: Math.min(120, Math.max(2, +root.querySelector('#seRefresh').value || 5)),
      lotSize: Math.max(0, Math.round(+root.querySelector('#seLot').value || 0)),
      slipPct: Math.min(5, Math.max(0, +root.querySelector('#seSlip').value || 0)),
      brokerage: Math.min(100, Math.max(0, +root.querySelector('#seBrk').value || 0)),
    });
  ['#seRefresh', '#seLot', '#seSlip', '#seBrk'].forEach((id) => root.querySelector(id).addEventListener('change', nums));
  root.querySelector('#seTheme').onclick = (e) => {
    const t = e.target.closest('[data-theme]')?.dataset.theme;
    if (!t) return;
    store.saveSettings({ theme: t });
    ctx.applyTheme();
    render(ctx);
  };
  root.querySelector('#seExport').onclick = () => {
    const blob = new Blob([JSON.stringify(positions.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nifty-mobile-backup-${ist().date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup saved to Downloads (the API secret is left out)');
  };
  root.querySelector('#seImport').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const n = positions.importAll(JSON.parse(await f.text()));
      toast(`Imported ${n} position(s)`);
      ctx.applyTheme();
      render(ctx);
    } catch (err) {
      toast('Import failed: ' + err.message);
    }
  };
  root.querySelector('#seReset').onclick = async () => {
    if (!(await confirmSheet('Erase settings, token and every paper position on this phone? This cannot be undone.', 'Erase', true))) return;
    for (const k of store.keys()) store.remove(k);
    ctx.applyTheme();
    toast('Everything erased');
    render(ctx);
  };
  root.querySelector('#seVer').textContent = ctx.version;
  root.querySelector('#seUpdate').onclick = () => ctx.checkUpdate();
}

export default {
  id: 'settings',
  title: 'Settings',
  mount(el, ctx) {
    root = el;
    render(ctx);
  },
  refresh(ctx) {
    const t = root.querySelector('#seToken');
    if (t) t.innerHTML = tokenLine();
    ctx.report({});
  },
};
