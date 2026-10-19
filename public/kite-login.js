// The one place to log in to Zerodha Kite, shared by the top bar's Kite chip, the Feeds screen and the order dialog of
// Live Ideas. Three ways, as before on the Feeds screen: the Kite Connect redirect (KITE_API_KEY / KITE_API_SECRET in
// .env), the enctoken of a Kite web login sent by the "Send Kite login here" bookmarklet (kite-link.html), or a pasted
// token. The login itself lives on the server (/api/kite/*); this file only draws it and keeps the screens in step:
//   KiteLogin.mount(el)      draws the login controls in el (any number of places at once)
//   KiteLogin.status         the latest /api/kite/status (null until it has arrived)
//   'kitechange' event       fired on window whenever the login changes
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const AUTO_KEY = 'oc.feeds.autoLogin'; // the Feeds screen's setting, kept under its old name
  const local = (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  };
  const mounts = [];
  const KL = { status: null, demo: () => window.app?.state?.data?.source === 'demo' };

  async function api(url, body) {
    const res = await fetch(
      url,
      body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }

  // The bookmark: on kite.zerodha.com it reads the enctoken cookie and hands it to this app (kite-link.html checks the
  // sender's origin, and the server checks the token with Kite before keeping it).
  function bookmarklet() {
    const origin = location.origin;
    const src = `(()=>{if(location.host!=='kite.zerodha.com'){alert('Open kite.zerodha.com, log in, then click this bookmark there.');return}
const c={};document.cookie.split('; ').forEach(s=>{const i=s.indexOf('=');c[s.slice(0,i)]=decodeURIComponent(s.slice(i+1))});
const e=c.enctoken;if(!e){alert('No enctoken cookie could be read here. Copy it from DevTools > Application > Cookies and paste it into the token box.');return}
const u=c.user_id||prompt('Your Kite user ID');if(!u)return;const o=${JSON.stringify(origin)};
const w=window.open(o+'/kite-link.html','kitelink','width=440,height=240');
addEventListener('message',function h(ev){if(ev.origin!==o||ev.data!=='ready')return;removeEventListener('message',h);w.postMessage({enctoken:e,userId:u},o)})})()`;
    return 'javascript:' + encodeURIComponent(src.replace(/\n/g, ''));
  }

  function lineOf(k) {
    if (KL.demo()) return '<i class="fd-dot on"></i><b>Kite</b> simulated (demo mode): orders are simulated too';
    if (!k) return '<i class="fd-dot"></i><b>Kite</b> checking…';
    if (!k.loggedIn) return `<i class="fd-dot warn"></i><b>Kite</b> not logged in${k.error ? ` · <span class="neg">${esc(k.error)}</span>` : ''}`;
    const how = k.mode === 'enctoken' ? 'web session (enctoken)' : 'Kite Connect';
    const orders =
      k.mode === 'enctoken' && !k.ordersEnctoken
        ? ' · <span class="neg" title="Set KITE_ORDERS_ENCTOKEN=1 in .env and restart the server to allow orders through a web session">orders need a Kite Connect login, or KITE_ORDERS_ENCTOKEN=1 in .env</span>'
        : '';
    return `<i class="fd-dot on"></i><b>Kite</b> logged in · ${how} · ${esc(k.userId || '')}${k.userName ? ' ' + esc(k.userName) : ''}${orders}`;
  }

  // One set of login controls. The form is built once, so a token being typed survives the status refreshes.
  function mount(el, { status = true } = {}) {
    el.classList.add('kl');
    el.innerHTML = `
      ${status ? '<div class="fd-status kl-line"></div>' : ''}
      <div class="fd-actions">
        <a class="btn-sm kl-connect" href="/kite/login" title="Kite Connect login. If you are already logged in to Kite in this browser, Kite usually sends you straight back.">Login with Kite</a>
        <button type="button" class="btn-sm ghost kl-tokbtn">Use a token…</button>
        <a class="btn-sm ghost fd-bm kl-bm" title="Drag this to your bookmarks bar. Then, on kite.zerodha.com (logged in), click it: it hands this app your Kite web session (enctoken).">⇢ Send Kite login here</a>
        <button type="button" class="btn-sm ghost danger kl-logout">Log out of Kite here</button>
        <label class="mini" title="When a screen opens and Kite is not logged in, go through the Kite Connect login by itself (returns at once if you are already logged in to Kite in this browser)"><input type="checkbox" class="kl-auto"> Auto-login</label>
      </div>
      <form class="fd-token kl-form hidden" autocomplete="off">
        <select class="kl-mode">
          <option value="enctoken">Kite web enctoken (unofficial)</option>
          <option value="connect">Kite Connect access token</option>
        </select>
        <input class="txt fd-tok kl-tok" type="password" placeholder="token" autocomplete="off">
        <input class="txt fd-uid kl-uid" type="text" placeholder="user ID (enctoken)">
        <input class="txt fd-uid kl-key hidden" type="text" placeholder="api_key (blank = .env)">
        <button type="submit" class="btn-sm">Save</button>
        <span class="muted small kl-msg"></span>
      </form>`;
    const q = (s) => el.querySelector(s);
    const m = { el, line: q('.kl-line'), connect: q('.kl-connect'), logout: q('.kl-logout'), auto: q('.kl-auto'), form: q('.kl-form') };
    q('.kl-bm').href = bookmarklet();
    q('.kl-bm').onclick = (e) => {
      e.preventDefault();
      alert('Drag this button to your bookmarks bar. Then open kite.zerodha.com (logged in) and click the bookmark there.');
    };
    q('.kl-tokbtn').onclick = () => {
      m.form.classList.toggle('hidden');
      q('.kl-tokbtn').textContent = m.form.classList.contains('hidden') ? 'Use a token…' : 'Hide token box';
    };
    const mode = () => {
      const enc = q('.kl-mode').value === 'enctoken';
      q('.kl-uid').classList.toggle('hidden', !enc);
      q('.kl-key').classList.toggle('hidden', enc);
    };
    q('.kl-mode').onchange = mode;
    mode();
    m.connect.onclick = () => {
      try {
        sessionStorage.setItem('oc.kite.back', window.app.state.view); // the redirect comes back to this screen
      } catch {}
    };
    m.auto.checked = local(AUTO_KEY, '0') === '1';
    m.auto.onchange = (e) => {
      try {
        localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0');
      } catch {}
    };
    m.logout.onclick = async () => {
      await api('/api/kite/logout', {}).catch((e) => alert(e.message));
      refresh();
    };
    m.form.onsubmit = async (e) => {
      e.preventDefault();
      const enc = q('.kl-mode').value === 'enctoken';
      const body = enc
        ? { mode: 'enctoken', enctoken: q('.kl-tok').value, userId: q('.kl-uid').value }
        : { mode: 'connect', accessToken: q('.kl-tok').value, apiKey: q('.kl-key').value };
      q('.kl-msg').textContent = 'Checking with Kite…';
      try {
        const j = await api('/api/kite/session', body);
        q('.kl-tok').value = '';
        q('.kl-msg').textContent = `Logged in as ${j.kite.userId || ''}`;
        m.form.classList.add('hidden');
        q('.kl-tokbtn').textContent = 'Use a token…';
        refresh();
      } catch (err) {
        q('.kl-msg').textContent = err.message;
      }
    };
    mounts.push(m);
    paint(m);
    return m;
  }

  function paint(m) {
    const k = KL.status;
    if (m.line) m.line.innerHTML = lineOf(k);
    m.connect.classList.toggle('hidden', !k?.apiKey || KL.demo());
    m.logout.classList.toggle('hidden', !k?.loggedIn || KL.demo());
    m.auto.disabled = !k?.apiKey;
  }

  // ---------- the top bar chip ----------
  function paintChip() {
    const chip = $('kiteChip');
    if (!chip) return;
    const k = KL.status;
    const on = KL.demo() || k?.loggedIn;
    chip.innerHTML = `<i class="fd-dot ${on ? 'on' : 'warn'}"></i>Kite ${KL.demo() ? '<span class="muted">demo</span>' : k?.loggedIn ? esc(k.userId || '') : '<span class="muted">log in</span>'}`;
    chip.title = k?.loggedIn
      ? `Logged in to Zerodha Kite as ${k.userId || ''} (${k.mode === 'enctoken' ? 'web session' : 'Kite Connect'}): click to manage`
      : 'Log in to Zerodha Kite (used by the Feeds screen and the Trade with Zerodha Kite buttons)';
  }

  let last = '';
  async function refresh() {
    try {
      KL.status = await api('/api/kite/status');
    } catch {
      return;
    }
    mounts.forEach(paint);
    paintChip();
    const key = JSON.stringify([KL.status.loggedIn, KL.status.userId, KL.status.mode]);
    if (key !== last) {
      last = key;
      window.dispatchEvent(new CustomEvent('kitechange', { detail: KL.status }));
    }
  }
  KL.mount = mount;
  KL.refresh = refresh;
  window.KiteLogin = KL;

  const chip = $('kiteChip');
  const pop = $('kitePop');
  if (chip && pop) {
    mount($('kitePopLogin'));
    chip.onclick = (e) => {
      e.stopPropagation();
      pop.classList.toggle('hidden');
    };
    document.addEventListener('click', (e) => {
      if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== chip) pop.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && pop.classList.add('hidden'));
  }
  paintChip();
  refresh();
  setInterval(() => !document.hidden && refresh(), 15_000);
  window.addEventListener('viewchange', () => refresh());
})();
