// "Feeds" tab: the same Nifty options streamed by Upstox and by Zerodha Kite, side by side. Shows where their prices
// differ right now, every difference of the day (when, how long, which feed changed first and which one later), and
// which feed is faster overall. Also the Kite login: Kite Connect redirect, a pasted token, or the enctoken of a Kite
// web login sent by a bookmarklet. Data from /api/feedcmp/state (every 500 ms while the tab is open).
(function () {
  const $ = (id) => document.getElementById(id);
  const { esc } = window.app;
  const POLL_MS = 500;
  const NAME = { u: 'Upstox', k: 'Kite' };
  const local = (k, d) => {
    try {
      return localStorage.getItem('oc.feeds.' + k) ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem('oc.feeds.' + k, v);
    } catch {}
  };
  const fs = {
    data: null,
    timer: null,
    fetching: false,
    cfgKey: null,
    filter: {
      date: '',
      minMs: local('minMs', '0'),
      minDiff: local('minDiff', '0'),
      field: '',
      inst: '',
      lead: '',
      how: '',
      pfeed: local('pfeed', ''),
    },
    tokenForm: false,
  };

  // ---------- formatting ----------
  const clockMs = (ts) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 23);
  const px = (n) => (n == null ? '—' : n.toFixed(2));
  function dur(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
    const s = Math.round(ms / 1000);
    return s < 3600
      ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
      : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  const feedTag = (src) => (src === 'u' || src === 'k' ? `<span class="fd-src ${src}">${NAME[src]}</span>` : '—');
  const instLabel = (id) => (id === 'NIFTY' ? 'NIFTY 50' : id.replace(/(CE|PE)$/, ' $1'));

  // ---------- data ----------
  async function load() {
    if (fs.fetching) return;
    fs.fetching = true;
    try {
      const q = new URLSearchParams(Object.entries(fs.filter).filter(([, v]) => v !== '' && v != null));
      const res = await fetch('/api/feedcmp/state?' + q, { cache: 'no-store' });
      const d = await res.json();
      if (d.error && !d.config) throw new Error(d.error);
      fs.data = d;
      render(d);
    } catch (e) {
      $('fdCfgNote').textContent = 'Error: ' + e.message;
    } finally {
      fs.fetching = false;
    }
  }

  function schedule() {
    clearTimeout(fs.timer);
    if (window.app.state.view !== 'feeds') return;
    fs.timer = setTimeout(async () => {
      if (!(fs.data && window.app.marketClosed())) await load(); // shut: nothing to compare, no more requests
      schedule();
    }, POLL_MS);
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }

  // ---------- Kite login card ----------
  function bookmarklet() {
    const origin = location.origin;
    const src = `(()=>{if(location.host!=='kite.zerodha.com'){alert('Open kite.zerodha.com, log in, then click this bookmark there.');return}
const c={};document.cookie.split('; ').forEach(s=>{const i=s.indexOf('=');c[s.slice(0,i)]=decodeURIComponent(s.slice(i+1))});
const e=c.enctoken;if(!e){alert('No enctoken cookie could be read here. Copy it from DevTools > Application > Cookies and paste it on the Feeds screen.');return}
const u=c.user_id||prompt('Your Kite user ID');if(!u)return;const o=${JSON.stringify(origin)};
const w=window.open(o+'/kite-link.html','kitelink','width=440,height=240');
addEventListener('message',function h(ev){if(ev.origin!==o||ev.data!=='ready')return;removeEventListener('message',h);w.postMessage({enctoken:e,userId:u},o)})})()`;
    return 'javascript:' + encodeURIComponent(src.replace(/\n/g, ''));
  }

  function renderKite(d) {
    const k = d.kite;
    const f = k.feed || {};
    const up = d.upstox || {};
    const ago = (t) => (t ? `${((d.now - t) / 1000).toFixed(1)} s ago` : 'none yet');
    const dot = (on, warn) => `<i class="fd-dot ${on ? 'on' : warn ? 'warn' : ''}"></i>`;
    let kiteLine;
    if (d.demo) kiteLine = `${dot(f.connected)}<b>Kite</b> simulated (demo mode)`;
    else if (!k.loggedIn) kiteLine = `${dot(false, true)}<b>Kite</b> not logged in${k.error ? ` · <span class="neg">${esc(k.error)}</span>` : ''}`;
    else
      kiteLine = `${dot(f.connected, !f.connected)}<b>Kite</b> ${f.connected ? 'streaming' : f.enabled ? 'connecting…' : 'idle'} · ${k.mode === 'enctoken' ? 'web session (enctoken)' : 'Kite Connect'} · ${esc(k.userId || '')}${k.userName ? ' ' + esc(k.userName) : ''}${f.connected ? ` · ${f.instruments} instruments · last tick ${ago(f.lastTickAt)}` : ''}${f.error ? ` · <span class="neg">${esc(f.error)}</span>` : ''}`;
    const upLine = d.demo
      ? `${dot(true)}<b>Upstox</b> simulated (demo mode)`
      : `${dot(up.connected, !up.connected)}<b>Upstox</b> ${up.connected ? `streaming · ${up.instruments} instruments · last tick ${ago(up.lastTickAt)}` : d.marketOpen ? 'tick feed connecting…' : 'tick feed off (market closed)'}`;

    const html = `
      <div class="fd-status">${upLine}</div>
      <div class="fd-status">${kiteLine}</div>
      <div class="fd-actions">
        ${k.apiKey ? `<a class="btn-sm" href="/kite/login" title="Kite Connect login. If you are already logged in to Kite in this browser, Kite usually sends you straight back.">Login with Kite</a>` : ''}
        <button type="button" class="btn-sm ghost" id="fdTokBtn">${fs.tokenForm ? 'Hide token box' : 'Use a token…'}</button>
        <a class="btn-sm ghost fd-bm" id="fdBm" title="Drag this to your bookmarks bar. Then, on kite.zerodha.com (logged in), click it: it hands this app your Kite web session (enctoken).">⇢ Send Kite login here</a>
        ${k.loggedIn && !d.demo ? `<button type="button" class="btn-sm ghost danger" id="fdLogout">Log out of Kite here</button>` : ''}
        <label class="mini" title="When this tab opens and Kite is not logged in, go through the Kite Connect login by itself (returns at once if you are already logged in to Kite in this browser)"><input type="checkbox" id="fdAuto" ${local('autoLogin', '0') === '1' ? 'checked' : ''} ${k.apiKey ? '' : 'disabled'}> Auto-login</label>
      </div>
      <form class="fd-token ${fs.tokenForm ? '' : 'hidden'}" id="fdTokForm" autocomplete="off">
        <select id="fdTokMode">
          <option value="connect">Kite Connect access token</option>
          <option value="enctoken">Kite web enctoken (unofficial)</option>
        </select>
        <input class="txt fd-tok" type="password" id="fdTok" placeholder="token" autocomplete="off">
        <input class="txt fd-uid" type="text" id="fdUid" placeholder="user ID (enctoken)">
        <input class="txt fd-uid" type="text" id="fdKey" placeholder="api_key (blank = .env)">
        <button type="submit" class="btn-sm">Save</button>
        <span class="muted small" id="fdTokMsg"></span>
      </form>`;
    // Rebuild only when the text changes, so the token box keeps its typing and focus.
    const key = html.replace(/last tick [\d.]+ s ago/g, '');
    const box = $('fdKite');
    if (box.dataset.key !== key || !box.innerHTML) {
      const keepForm = box.querySelector('#fdTokForm');
      const vals = keepForm ? ['fdTokMode', 'fdTok', 'fdUid', 'fdKey'].map((id) => $(id).value) : null;
      box.innerHTML = html;
      box.dataset.key = key;
      if (vals) ['fdTokMode', 'fdTok', 'fdUid', 'fdKey'].forEach((id, i) => ($(id).value = vals[i]));
      $('fdBm').href = bookmarklet();
      bindKite();
      tokModeChanged();
    } else {
      box.querySelectorAll('.fd-status').forEach((el, i) => (el.innerHTML = i ? kiteLine : upLine));
    }
  }

  function tokModeChanged() {
    const enc = $('fdTokMode')?.value === 'enctoken';
    $('fdUid')?.classList.toggle('hidden', !enc);
    $('fdKey')?.classList.toggle('hidden', enc);
  }

  function bindKite() {
    $('fdTokBtn').onclick = () => {
      fs.tokenForm = !fs.tokenForm;
      $('fdTokForm').classList.toggle('hidden', !fs.tokenForm);
      $('fdTokBtn').textContent = fs.tokenForm ? 'Hide token box' : 'Use a token…';
    };
    $('fdBm').onclick = (e) => {
      e.preventDefault();
      alert('Drag this button to your bookmarks bar. Then open kite.zerodha.com (logged in) and click the bookmark there.');
    };
    $('fdTokMode').onchange = tokModeChanged;
    $('fdAuto').onchange = (e) => save('autoLogin', e.target.checked ? '1' : '0');
    if ($('fdLogout'))
      $('fdLogout').onclick = async () => {
        await post('/api/kite/logout').catch((e) => alert(e.message));
        load();
      };
    $('fdTokForm').onsubmit = async (e) => {
      e.preventDefault();
      const mode = $('fdTokMode').value;
      const body =
        mode === 'enctoken'
          ? { mode, enctoken: $('fdTok').value, userId: $('fdUid').value }
          : { mode, accessToken: $('fdTok').value, apiKey: $('fdKey').value };
      $('fdTokMsg').textContent = 'Checking with Kite…';
      try {
        const j = await post('/api/kite/session', body);
        $('fdTok').value = '';
        fs.tokenForm = false;
        $('fdTokMsg').textContent = `Logged in as ${j.kite.userId || ''}`;
        load();
      } catch (err) {
        $('fdTokMsg').textContent = err.message;
      }
    };
  }

  // Auto-login: once per 10 minutes at most, so a failing login can't loop.
  function maybeAutoLogin(d) {
    if (d.demo || d.kite.loggedIn || !d.kite.apiKey || local('autoLogin', '0') !== '1') return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem('oc.feeds.autoAt') || 0);
      if (Date.now() - last < 10 * 60_000) return;
      sessionStorage.setItem('oc.feeds.autoAt', String(Date.now()));
    } catch {
      return;
    }
    location.href = '/kite/login';
  }

  // ---------- settings ----------
  function renderConfig(d) {
    const c = d.config;
    const key = JSON.stringify([c, d.expiries]);
    if (key === fs.cfgKey) return;
    fs.cfgKey = key;
    $('fdOn').checked = c.enabled;
    $('fdExpiry').innerHTML =
      `<option value="nearest">Nearest${d.expiries?.[0] ? ' (' + d.expiries[0] + ')' : ''}</option>` +
      (d.expiries || []).map((e) => `<option value="${e}">${e}</option>`).join('');
    $('fdExpiry').value = c.expiry;
    if (document.activeElement !== $('fdAround')) $('fdAround').value = c.around;
    if (document.activeElement !== $('fdExtra')) $('fdExtra').value = c.extra.join(', ');
    $('fdIndex').checked = c.index;
    $('fdFields')
      .querySelectorAll('.chip')
      .forEach((b) => b.classList.toggle('on', c.fields.includes(b.dataset.f)));
    const p = c.paper;
    $('fpOn').checked = p.enabled;
    $('fpConv').checked = p.exitOnConverge;
    $('fpTarget').disabled = p.exitOnConverge;
    $('fpSide').value = p.side;
    $('fpSurgeOn').checked = p.surgeGate;
    for (const [id, k] of Object.entries(PAPER_INPUTS)) if (document.activeElement !== $(id)) $(id).value = p[k];
    $('flProduct').value = c.live.product;
    $('flKiteOnly').checked = c.live.kiteOnly;
    $('flBudget').checked = c.live.budget;
    $('flLots').disabled = c.live.budget;
    for (const [id, k] of Object.entries(LIVE_INPUTS)) if (document.activeElement !== $(id)) $(id).value = c.live[k];
  }

  // ---------- paper trades on big gaps ----------
  const PAPER_INPUTS = { fpGap: 'minGap', fpTarget: 'target', fpStop: 'stop', fpHold: 'maxHoldSec', fpLots: 'lots', fpSurgePct: 'surgePct' };
  for (const [id, k] of Object.entries(PAPER_INPUTS)) $(id).onchange = (e) => saveConfig({ paper: { [k]: Number(e.target.value) } });
  $('fpOn').onchange = (e) => saveConfig({ paper: { enabled: e.target.checked } });
  $('fpConv').onchange = (e) => saveConfig({ paper: { exitOnConverge: e.target.checked } });
  $('fpSurgeOn').onchange = (e) => saveConfig({ paper: { surgeGate: e.target.checked } });
  $('fpSide').onchange = (e) => saveConfig({ paper: { side: e.target.value } });
  $('fpFeed').value = fs.filter.pfeed;
  $('fpFeed').onchange = (e) => {
    fs.filter.pfeed = e.target.value;
    save('pfeed', e.target.value);
    load();
  };

  // ---------- live orders on Kite (feedlive.js) ----------
  const LIVE_INPUTS = { flLots: 'lots', flMaxEntries: 'maxEntries', flMaxOpen: 'maxOpen', flBudgetPct: 'budgetPct', flMaxLots: 'maxLots' };
  for (const [id, k] of Object.entries(LIVE_INPUTS)) $(id).onchange = (e) => saveConfig({ live: { [k]: Number(e.target.value) } });
  $('flProduct').onchange = (e) => saveConfig({ live: { product: e.target.value } });
  $('flKiteOnly').onchange = (e) => saveConfig({ live: { kiteOnly: e.target.checked } });
  $('flBudget').onchange = (e) => saveConfig({ live: { budget: e.target.checked } });
  $('flFunds').addEventListener('click', async (e) => {
    if (!e.target.closest('#flFundsRefresh')) return;
    try {
      await post('/api/feedcmp/funds');
    } catch (err) {
      alert(err.message);
    }
    load();
  });

  $('flOn').onchange = async (e) => {
    const box = e.target;
    const d = fs.data;
    if (box.checked && d?.trading && !d.trading.allowed) {
      box.checked = false;
      return alert("Live trading can't be switched on: " + d.trading.why);
    }
    if (box.checked) {
      const L = d?.config.live || {};
      const p = d?.config.paper || {};
      const acct = d?.kite.userId || '?';
      const ok = confirm(
        `Switch LIVE trading on for Kite account ${acct}?\n\n` +
          `Every paper trade that opens from now on sends a real MARKET order: ${L.budget ? `lots sized by budget (${L.budgetPct}% of the Kite funds available, max ${L.maxLots} lots)` : `${L.lots} lot(s)`}, ${L.product}, ${p.side === 'both' ? 'buys and sells' : p.side + ' only'}, on gaps of ₹${p.minGap} or more${L.kiteOnly ? ', only when Kite moved first' : ''}.\n` +
          `Each is closed with the opposite MARKET order ${p.exitOnConverge ? 'when the Upstox and Kite LTPs match again' : `at +₹${p.target}`}${p.stop ? `, at −₹${p.stop}` : ''} or after ${p.maxHoldSec} s, and by 15:15 at the latest.\n` +
          `At most ${L.maxEntries} entries today and ${L.maxOpen} open at a time.\n\nReal money. Continue?`,
      );
      if (!ok) {
        box.checked = false;
        return;
      }
    }
    try {
      await post('/api/feedcmp/live', { on: box.checked, confirm: box.checked });
    } catch (err) {
      box.checked = false;
      alert(err.message);
    }
    load();
  };

  $('flTest').onclick = async () => {
    const T = fs.data?.trading;
    if (T && !T.allowed) return alert("The test order can't be sent: " + T.why);
    const kind = $('flTestKind').value;
    const type = kind === 'PE' ? 'PE' : 'CE';
    const atm = fs.data?.instruments.find((i) => i.atm && i.type === type);
    const lot = fs.data?.paper.trades[0]?.lot;
    const msg =
      kind === 'check'
        ? `Send a test order to Kite?\n\nA 1-lot LIMIT BUY of the ATM call${atm ? ' (' + instLabel(atm.id) + ')' : ''} at ₹0.05. It can't fill at that price; if Kite accepts it, it is cancelled at once.`
        : `BUY 1 lot${lot ? ' (' + lot + ' qty)' : ''} of the ATM ${type}${atm ? ' (' + instLabel(atm.id) + ', LTP about ₹' + px(atm.k?.ltp ?? atm.u?.ltp) + ')' : ''} at MARKET on Kite, ${fs.data?.config.live.product}?\n\nThis is a real position. Close it with "Square off all" (or it is closed at 15:15).`;
    if (!confirm(msg)) return;
    $('flTest').disabled = true;
    try {
      const r = await post('/api/feedcmp/live-test', { kind });
      alert(
        !r.ok
          ? 'The test order failed: ' + r.error
          : kind === 'check'
            ? `The test order reached Kite.\n\nOrder ${r.id} · ${r.symbol} BUY ${r.qty} @ ₹0.05\nStatus: ${r.status}${r.msg ? ' — ' + r.msg : ''}${r.cancelled ? '\nCancelled.' : ''}`
            : `Test buy sent to Kite.\n\nOrder ${r.id} · ${r.symbol} BUY ${r.qty} at market\nStatus: ${r.status}${r.avg ? ' · filled at ₹' + r.avg : ''}${r.msg ? ' — ' + r.msg : ''}${r.filled ? '\n\nThe position is open: close it with Square off all.' : ''}`,
      );
    } catch (err) {
      alert('The test order failed: ' + err.message);
    } finally {
      $('flTest').disabled = false;
      load();
    }
  };

  async function closeLive(id) {
    if (!confirm('Close this position on Kite now, at market?')) return;
    try {
      await post('/api/feedcmp/live-close', { id });
    } catch (err) {
      alert(err.message);
    }
    load();
  }
  for (const box of ['fpTable', 'flLog']) {
    $(box).addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button[data-close]');
      if (!b) return;
      e.preventDefault();
      closeLive(b.dataset.close);
    });
  }

  $('flSquare').onclick = async () => {
    if (!confirm('Close every live position opened from this screen, now, at market?')) return;
    try {
      const r = await post('/api/feedcmp/squareoff');
      if (!r.closing) alert('No live position open from this screen. Positions opened elsewhere have to be closed in Kite.');
    } catch (err) {
      alert(err.message);
    }
    load();
  };

  function renderTrading(d) {
    const T = d.trading;
    if (!T) return;
    renderFunds(d, T);
    if (document.activeElement !== $('flOn')) $('flOn').checked = T.on;
    $('flBar').classList.toggle('on', T.on);
    $('flAcct').innerHTML = T.on
      ? `<b class="neg">ON</b> · ${esc(T.account || '')} · ${T.entries} / ${d.config.live.maxEntries} entries today · ${T.open} open`
      : T.allowed
        ? `<span class="muted">off · ${T.entries} live entries today</span>`
        : `<span class="fd-why">⚠ ${esc(T.why || 'Log in to Kite to trade')}</span>`;
    const ev = T.events.map((e) => `<div class="fd-ev ${e.level}"><span class="mono">${clockMs(e.at).slice(0, 8)}</span> ${esc(e.msg)}</div>`).join('');
    const pos = T.positions?.length
      ? `<table class="flow-table fd-table fd-pos"><thead><tr><th>Kite position</th><th>Product</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th></tr></thead><tbody>${T.positions
          .map(
            (p) =>
              `<tr><td>${esc(p.symbol)}</td><td>${p.product}</td><td class="${p.qty > 0 ? 'pos' : p.qty < 0 ? 'neg' : 'muted'}">${p.qty}</td><td>${px(p.avg)}</td><td>${px(p.ltp)}</td>${pnlCell(p.pnl)}</tr>`,
          )
          .join('')}</tbody></table>`
      : T.positionsError
        ? `<div class="fd-ev error">Kite positions: ${esc(T.positionsError)}</div>`
        : '';
    const STATE = { entering: 'buying…', open: 'open', exiting: 'selling…', closed: 'closed', failed: 'not filled', 'exit-failed': 'SELL FAILED: still open' };
    const tests = (T.tests || [])
      .map(
        (t) =>
          `<tr><td class="mono">${clockMs(t.at).slice(0, 8)}</td><td>${esc(t.symbol)}</td><td>BUY ${t.entry?.filled || t.qty}${t.entry?.avg ? ' @ ' + px(t.entry.avg) : ''}</td><td class="${t.state === 'exit-failed' || t.state === 'failed' ? 'neg' : ''}">${STATE[t.state] || t.state}${t.entry?.msg && t.state === 'failed' ? ' — ' + esc(t.entry.msg) : ''}</td>${t.state === 'closed' ? `<td>${t.closedInKite ? 'closed in Kite' : 'sold'} @ ${px(t.exitAvg)}</td>${pnlCell(t.net)}<td></td>` : t.state === 'open' || t.state === 'exit-failed' ? `<td class="muted">now ${px(t.mark)}</td>${pnlCell(t.upnl)}<td>${closeBtn(t.id)}</td>` : '<td></td><td></td><td></td>'}</tr>`,
      )
      .join('');
    const testTable = tests
      ? `<table class="flow-table fd-table fd-pos"><thead><tr><th>Test buy</th><th>Option</th><th>Entry</th><th>State</th><th>Exit / now</th><th title="Net after charges once closed; while open, the P&amp;L at the current price">P&amp;L</th><th></th></tr></thead><tbody>${tests}</tbody></table>`
      : '';
    $('flLog').innerHTML = ev || pos || testTable ? `<div class="fd-evs">${ev}</div>${testTable}${pos}` : '';
  }

  const closeBtn = (id) =>
    `<button type="button" class="btn-sm ghost danger fd-close" data-close="${esc(id)}" title="Close this position on Kite now, at market">Close</button>`;
  // the live P&L of an open position: at the current price, before charges
  const openPnl = (L) => (L.upnl == null ? '' : ` · now ${px(L.mark)} <b class="${L.upnl > 0 ? 'pos' : L.upnl < 0 ? 'neg' : ''}">${rupees(L.upnl)}</b>`);

  // Kite's funds and how many lots of the ATM options they buy now.
  function renderFunds(d, T) {
    const F = T.funds || {};
    const L = d.config.live;
    const money = (n) => (n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
    if (!T.allowed && !T.demo) {
      $('flFunds').innerHTML = '';
      return;
    }
    const afford = (T.afford || [])
      .filter((a) => a.symbol)
      .map(
        (a) =>
          `<span title="${esc(a.symbol)}: ${px(a.price)} × lot = ${money(a.perLot)} a lot">ATM ${instLabel(a.id)} ${money(a.perLot)}/lot → <b>${F.available == null || a.lots == null ? '—' : a.lots} lot${a.lots === 1 ? '' : 's'}</b></span>`,
      )
      .join(' · ');
    $('flFunds').innerHTML =
      `<span><b>Kite funds</b> ${F.error ? `<span class="neg">${esc(F.error)}</span>` : `available <span class="fd-funds-amt">${money(F.available)}</span>${F.cash != null ? ` · cash ${money(F.cash)}` : ''}${F.used ? ` · used ${money(F.used)}` : ''}`}</span>` +
      `<span class="muted">${F.at ? 'as of ' + clockMs(F.at).slice(0, 8) : ''}</span><button type="button" class="btn-sm ghost fd-close" id="flFundsRefresh" title="Read the funds from Kite again">↻</button>` +
      (afford ? `<span class="muted">buys, at ${L.budgetPct}% (max ${L.maxLots}):</span> ${afford}` : '') +
      (L.budget ? '<span class="fd-why">Size by budget is on: live entries use this, not Lots</span>' : '');
  }

  // What happened to a trade's live order on Kite.
  function liveCell(t) {
    const L = t.live;
    if (!L) return '<td class="muted">—</td>';
    const leg = (g) => (g ? `${g.side} ${g.filled || g.qty}${g.avg ? ' @ ' + px(g.avg) : ''}` : '');
    switch (L.state) {
      case 'skipped':
        return `<td class="muted" title="${esc(L.why)}">skipped</td>`;
      case 'entering':
        return L.sizing ? '<td>sizing by budget…</td>' : `<td>sending ${leg(L.entry)}… <span class="muted small">${esc(L.entry?.status || '')}</span></td>`;
      case 'open':
        return `<td title="${esc(L.symbol)} · order ${esc(L.entry.id)} · P&L at the current price, before charges"><b>${leg(L.entry)}</b> open${openPnl(L)} ${closeBtn(t.id)}</td>`;
      case 'exiting':
        return `<td>${leg(L.entry)} → closing…${openPnl(L)}</td>`;
      case 'closed':
        return `<td class="${L.net > 0 ? 'pos' : L.net < 0 ? 'neg' : ''}" title="${esc(L.symbol)} · ${L.lots} lot(s) · gross ${rupees(L.gross)} − charges ₹${L.costs}">${leg(L.entry)} → ${L.closedInKite ? `closed in Kite @ ${px(L.exitAvg)}${L.kitePriceEstimated ? ' (est.)' : ''}` : px(L.exitAvg)} · <b>${rupees(L.net)}</b></td>`;
      case 'failed':
        return `<td class="neg" title="${esc(L.entry?.msg || '')}">entry ${esc((L.entry?.status || 'failed').toLowerCase())}</td>`;
      case 'exit-failed':
        return `<td class="neg" title="${esc(L.exit?.msg || '')}"><b>EXIT FAILED</b> · still open on Kite${openPnl(L)} ${closeBtn(t.id)}</td>`;
      default:
        return '<td class="neg" title="The server restarted while this position was open">unknown: check Kite</td>';
    }
  }

  const rupees = (n) => (n == null ? '—' : `${n < 0 ? '−' : n > 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  const pnlCell = (n) => `<td class="${n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted'}">${n == null ? '—' : rupees(n)}</td>`;
  const REASON = { target: 'target hit', stop: 'stop', time: 'max hold', converge: 'feeds matched', eod: '15:25 close', lost: 'lost (restart)' };

  // Profit had the trade been closed when the feeds first matched again: net of charges, with the details on hover.
  function convCell(t) {
    const c = t.conv;
    if (!c) return `<td class="muted" title="The feeds have not shown the same LTP since entry">${t.status === 'open' ? 'waiting' : '—'}</td>`;
    const title = `Feeds matched at ${px(c.ltp)} after ${dur(c.at - t.at)}. Closing then: ${px(c.px)} = ${rupees(c.pnl)} per unit · gross ${rupees(c.gross)} · net ${rupees(c.net)}`;
    return `<td class="${c.net > 0 ? 'pos' : c.net < 0 ? 'neg' : 'muted'}" title="${esc(title)}"><b>${rupees(c.net)}</b> <span class="muted small">${dur(c.at - t.at)}</span></td>`;
  }

  // The day's paper trades split by the volume breadth they opened in (the same split the optional gate uses).
  function renderSurge(d) {
    const b = d.paper.bySurge;
    const cfg = d.config.paper;
    const now = d.paper.surgeNow;
    const nowTxt = d.live
      ? now?.ready
        ? `Volume breadth now <b class="${now.pct >= cfg.surgePct ? 'pos' : ''}">${Math.round(now.pct)}%</b> of strikes surging`
        : 'Volume breadth not ready yet'
      : '';
    const gateTxt = cfg.surgeGate ? `<b>Gate on:</b> trades open only at ≥ ${cfg.surgePct}%` : 'Gate off: every trade is still tagged with the breadth';
    const sgn = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
    const line = (label, s, title) => {
      const per = s.closed ? Math.round(s.net / s.closed) : null;
      return `<tr title="${title}"><td>${label}</td><td>${s.trades}</td><td>${s.closed ? Math.round((s.wins / s.closed) * 100) + '%' : '—'}</td><td class="${sgn(s.avg)}">${rupees(s.avg)}</td><td class="${sgn(s.net)}">${rupees(s.net)}</td><td class="${sgn(per)}">${rupees(per)}</td></tr>`;
    };
    $('fpSurge').innerHTML =
      `<span class="muted">${[nowTxt, gateTxt].filter(Boolean).join(' · ')}</span>` +
      '<table><thead><tr><th>Opened when…</th><th>Trades</th><th>In profit</th><th>Avg P&amp;L / unit</th><th>Net ₹</th><th>Net ₹ / trade</th></tr></thead><tbody>' +
      line(
        `Volume surge (≥ ${b.minPct}% of strikes)`,
        b.surge,
        'Trades that opened while at least this share of strikes near ATM traded at 2× their normal volume or more',
      ) +
      line('Calmer volume', b.calm, 'Trades that opened below that level') +
      (b.untagged.trades ? line('Not tagged', b.untagged, 'Opened before the breadth was recorded with each trade, or while it was not ready') : '') +
      '</tbody></table>';
  }

  function renderPaper(d) {
    const p = d.paper;
    const s = p.summary;
    const tile = (label, value, note, cls = '') =>
      `<div class="st"><span class="s">${label}</span><span class="v ${cls}">${value}</span><span class="n">${note}</span></div>`;
    const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
    $('fpTiles').innerHTML = [
      tile(
        'Trades',
        String(s.trades),
        `${s.open} open · ${s.closed} closed${s.trades - s.open - s.closed ? ` · ${s.trades - s.open - s.closed} lost to a restart` : ''}`,
      ),
      tile(
        'Target hit',
        s.closed ? `${s.target} / ${s.closed}` : '—',
        s.closed ? `${Math.round((s.wins / s.closed) * 100)}% closed in profit` : 'no closed trades yet',
      ),
      tile('Avg P&L per unit', rupees(s.avg), 'at the live quote', cls(s.avg)),
      tile('If filled at stale price', rupees(s.avgStale), 'per unit · not possible in reality', 'muted'),
      tile('Gross', rupees(s.gross), 'all closed trades, lots × lot size', cls(s.gross)),
      tile('Charges', s.costs ? '−₹' + s.costs.toLocaleString('en-IN') : '—', 'brokerage, STT, exchange, GST, stamp'),
      tile('Net', rupees(s.net), 'after charges', cls(s.net)),
      tile(
        'Live on Kite',
        p.live.sent ? rupees((p.live.net || 0) + (p.live.openPnl || 0)) : '—',
        p.live.sent
          ? `closed ${rupees(p.live.net)} (${p.live.closed}, after charges)${p.live.open ? ` · open ${rupees(p.live.openPnl)} on ${p.live.open} now` : ''}${p.live.failed ? ` · ${p.live.failed} failed` : ''}`
          : 'no live orders',
        cls((p.live.net || 0) + (p.live.openPnl || 0)),
      ),
    ].join('');
    renderSurge(d);
    const later = (t, s) => pnlCell(t.later?.[s]);
    const head = `<thead><tr><th>Opened (IST)</th><th>Instrument</th><th>Side</th><th title="Upstox LTP / Kite LTP when the trade opened">Upstox / Kite</th><th>Moved first</th><th title="Share of strikes near ATM trading at 2× their normal volume or more when the trade opened">Surge</th><th>Entry</th><th title="The slow feed's price: what the gap seemed to offer">Stale price</th><th>Exit</th><th>Why closed</th><th>Held</th><th>P&amp;L / unit</th><th title="P&amp;L per unit had the entry been at the stale price (not possible)">At stale price</th><th>Net ₹</th><th title="Profit after charges had the trade been closed the first time Upstox and Kite showed the same LTP again (shown for every trade, whether or not it exits there)">At convergence</th><th title="The real order on Kite, when live trading was on">Kite order</th><th title="Best / worst P&amp;L per unit while open">Best / worst</th><th title="P&amp;L per unit at these times after entry, held or not: what happened later">+30s</th><th>+1m</th><th>+5m</th><th>+15m</th></tr></thead>`;
    const rows = p.trades.map((t) => {
      const held = t.status === 'lost' ? null : (t.exitAt || d.now) - t.at;
      return `<tr class="${t.status === 'open' ? 'fd-open' : ''}">
        <td class="mono">${clockMs(t.at)}</td>
        <td>${instLabel(t.i)}${t.x && t.x !== d.expiry ? ` <span class="muted small">${t.x}</span>` : ''}</td>
        <td class="${t.side === 'BUY' ? 'pos' : 'neg'}"><b>${t.side}</b></td>
        <td>${px(t.uLtp)} / ${px(t.kLtp)} <span class="muted small">gap ₹${px(t.gap)}</span></td>
        <td>${feedTag(t.lead)}</td>
        <td class="${t.surge >= d.config.paper.surgePct ? 'pos' : 'muted'}">${t.surge == null ? '—' : Math.round(t.surge) + '%'}</td>
        <td title="${t.quoted ? `${NAME[t.entryFeed]} bid ${px(t.entryQuote.bid)} / ask ${px(t.entryQuote.ask)}` : 'no quote: filled at LTP'}">${px(t.entry)}${t.quoted ? '' : ' <span class="muted small">LTP</span>'}</td>
        <td class="muted">${px(t.stale)}</td>
        <td>${t.status === 'open' ? `<span class="muted">now ${px(t.mark)}</span>` : px(t.exit)}</td>
        <td>${t.status === 'open' ? '<b>open</b>' : REASON[t.reason] || t.status}</td>
        <td>${dur(held)}</td>
        ${pnlCell(t.pnl)}
        <td class="muted">${t.stalePnl == null ? '—' : rupees(t.stalePnl)}</td>
        ${pnlCell(t.net)}
        ${convCell(t)}
        ${liveCell(t)}
        <td><span class="pos">${rupees(t.mfe)}</span> / <span class="neg">${rupees(t.mae)}</span></td>
        ${later(t, 30)}${later(t, 60)}${later(t, 300)}${later(t, 900)}
      </tr>`;
    });
    $('fpTable').innerHTML =
      head +
      '<tbody>' +
      (rows.length
        ? rows.join('')
        : `<tr><td class="muted" colspan="21">${d.live ? `No gap of ₹${d.config.paper.minGap} or more yet${d.config.paper.enabled ? '' : ' (paper trading is off)'}.` : 'No paper trades on this day.'}</td></tr>`) +
      '</tbody>';
  }

  async function saveConfig(patch) {
    try {
      await post('/api/feedcmp/config', patch);
      fs.cfgKey = null;
      load();
    } catch (e) {
      $('fdCfgNote').textContent = 'Error: ' + e.message;
    }
  }

  $('fdOn').onchange = (e) => saveConfig({ enabled: e.target.checked });
  $('fdExpiry').onchange = (e) => saveConfig({ expiry: e.target.value });
  $('fdAround').onchange = (e) => saveConfig({ around: Number(e.target.value) });
  $('fdExtra').onchange = (e) =>
    saveConfig({
      extra: e.target.value
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number),
    });
  $('fdIndex').onchange = (e) => saveConfig({ index: e.target.checked });
  $('fdFields').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const cur = new Set(fs.data?.config.fields || ['ltp']);
    if (cur.has(b.dataset.f)) cur.delete(b.dataset.f);
    else cur.add(b.dataset.f);
    if (!cur.size) return;
    saveConfig({ fields: [...cur] });
  };

  // ---------- filters ----------
  const FILTER_IDS = { fdDay: 'date', fdMinMs: 'minMs', fdMinDiff: 'minDiff', fdField: 'field', fdInst: 'inst', fdLead: 'lead', fdHow: 'how' };
  for (const [id, k] of Object.entries(FILTER_IDS)) {
    $(id).value = fs.filter[k];
    $(id).addEventListener('change', (e) => {
      fs.filter[k] = e.target.value;
      if (k === 'minMs' || k === 'minDiff') save(k, e.target.value);
      load();
    });
  }

  function renderFilterLists(d) {
    const days = [d.today, ...(fs.days || []).filter((x) => x !== d.today)];
    const dk = days.join(',');
    if ($('fdDay').dataset.key !== dk) {
      $('fdDay').innerHTML = days.map((x) => `<option value="${x}">${x === d.today ? 'Today' : x}</option>`).join('');
      $('fdDay').dataset.key = dk;
      $('fdDay').value = d.date;
    }
    const ids = [...new Set([...(d.instruments || []).map((i) => i.id), ...d.stats.inst.map((i) => i.i), fs.filter.inst].filter(Boolean))];
    const ik = ids.join(',');
    if ($('fdInst').dataset.key !== ik) {
      $('fdInst').innerHTML = '<option value="">All</option>' + ids.map((i) => `<option value="${i}">${instLabel(i)}</option>`).join('');
      $('fdInst').dataset.key = ik;
      $('fdInst').value = fs.filter.inst;
    }
  }

  // ---------- tiles ----------
  function renderTiles(d) {
    const s = d.stats;
    const tile = (label, value, note, cls = '') =>
      `<div class="st"><span class="s">${label}</span><span class="v ${cls}">${value}</span><span class="n">${note}</span></div>`;
    const led = s.u.follow + s.k.follow;
    const faster = led ? (s.u.follow >= s.k.follow ? 'u' : 'k') : null;
    const share = led ? Math.round((Math.max(s.u.follow, s.k.follow) / led) * 100) : null;
    $('fdTiles').innerHTML = [
      tile('Faster feed', faster ? feedTag(faster) : '—', faster ? `changed first in ${share}% of differences the other feed followed` : 'no differences yet'),
      tile(
        'Upstox first',
        s.u.follow.toLocaleString('en-IN'),
        s.u.med != null ? `Kite followed after ${dur(s.u.med)} median · 90% within ${dur(s.u.p90)}` : 'times Kite followed later',
      ),
      tile(
        'Kite first',
        s.k.follow.toLocaleString('en-IN'),
        s.k.med != null ? `Upstox followed after ${dur(s.k.med)} median · 90% within ${dur(s.k.p90)}` : 'times Upstox followed later',
      ),
      tile('Only on Upstox', s.u.revert.toLocaleString('en-IN'), 'prices Kite never showed (Upstox went back)'),
      tile('Only on Kite', s.k.revert.toLocaleString('en-IN'), 'prices Upstox never showed (Kite went back)'),
      tile(
        'Differences',
        d.matched.toLocaleString('en-IN'),
        `apart ${dur(s.ms)} in all${d.matched !== d.total ? ` · ${d.total.toLocaleString('en-IN')} before the filter` : ''}`,
      ),
      tile('Longest', dur(s.maxMs), `${s.u.cross + s.k.cross} both moved · ${s.cut} cut short`),
      tile('Apart now', d.live ? String(d.open) : '—', d.live ? 'instrument prices differing this moment' : 'past day', d.open ? 'neg' : ''),
    ].join('');
  }

  // ---------- live table ----------
  function renderLive(d) {
    const fields = d.config.fields;
    const per = new Map(d.stats.inst.map((r) => [r.i, r]));
    const showBA = fields.includes('bid') || fields.includes('ask');
    if (!d.live) {
      $('fdLive').innerHTML = `<tbody><tr><td class="muted">Showing ${esc(d.date)}: live prices are on Today.</td></tr></tbody>`;
      return;
    }
    if (!d.instruments.length) {
      const why = !d.config.enabled ? 'Compare is switched off.' : d.error ? esc(d.error) : 'Waiting for the option chain…';
      $('fdLive').innerHTML = `<tbody><tr><td class="muted">${why}</td></tr></tbody>`;
      return;
    }
    const head = `<thead><tr><th>Instrument</th><th>Upstox LTP</th><th>Kite LTP</th><th>Gap</th><th>Apart for</th><th>Changed first</th>${
      showBA ? '<th>Upstox bid / ask</th><th>Kite bid / ask</th>' : ''
    }<th title="Differences today that pass the filter">Diffs</th><th>Upstox first</th><th>Kite first</th><th title="Median time the other feed took to show the same price">Median lag</th></tr></thead>`;
    const rows = d.instruments.map((i) => {
      const u = i.u || {};
      const k = i.k || {};
      const openF = Object.entries(i.open || {});
      const first = openF.reduce((a, [, ep]) => (!a || ep.s < a.s ? ep : a), null);
      const gap = u.ltp != null && k.ltp != null ? u.ltp - k.ltp : null;
      const r = per.get(i.id);
      const cell = (side, f) => {
        const v = side[f];
        const apart = i.open?.[f];
        return `<span class="${apart ? 'fd-apart' : ''}">${px(v)}</span>`;
      };
      const missing = !i.mapped?.k ? ' <span class="muted small" title="No Kite instrument found for this contract">no Kite token</span>' : '';
      return `<tr class="${first ? 'fd-open' : ''} ${i.atm ? 'fd-atm' : ''} ${fs.filter.inst === i.id ? 'fd-sel' : ''}" data-id="${i.id}">
        <td><b>${instLabel(i.id)}</b>${missing}</td>
        <td title="changed ${u.ltp != null && i.uAt?.ltp ? clockMs(i.uAt.ltp) : '—'}">${cell(u, 'ltp')}</td>
        <td title="changed ${k.ltp != null && i.kAt?.ltp ? clockMs(i.kAt.ltp) : '—'}">${cell(k, 'ltp')}</td>
        <td class="${gap ? (gap > 0 ? 'pos' : 'neg') : 'muted'}">${gap == null ? '—' : (gap > 0 ? '+' : '') + gap.toFixed(2)}</td>
        <td>${first ? `<b data-since="${first.s}">${dur(d.now - first.s)}</b>${openF.length > 1 || openF[0]?.[0] !== 'ltp' ? ` <span class="muted small">${openF.map(([f]) => f).join(', ')}</span>` : ''}` : '<span class="muted">—</span>'}</td>
        <td>${first ? feedTag(first.l) : '<span class="muted">—</span>'}</td>
        ${showBA ? `<td>${cell(u, 'bid')} / ${cell(u, 'ask')}</td><td>${cell(k, 'bid')} / ${cell(k, 'ask')}</td>` : ''}
        <td>${r ? r.n : 0}</td><td>${r ? r.u : 0}</td><td>${r ? r.k : 0}</td><td>${r?.med != null ? dur(r.med) : '—'}</td>
      </tr>`;
    });
    $('fdLive').innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
  }

  // ---------- who is faster ----------
  function renderLag(d) {
    const s = d.stats;
    const max = Math.max(1, ...s.u.hist, ...s.k.hist);
    const bar = (src, n) => `<div class="fd-bar ${src}" style="width:${((n / max) * 100).toFixed(1)}%"></div>`;
    $('fdHist').innerHTML = `
      <div class="fd-hrow head"><span></span><span>${feedTag('u')} first → Kite followed</span><span>${feedTag('k')} first → Upstox followed</span></div>
      ${s.buckets
        .map(
          (b, i) => `<div class="fd-hrow"><span class="muted">${b}</span>
            <span class="fd-cell">${bar('u', s.u.hist[i])}<em>${s.u.hist[i] || ''}</em></span>
            <span class="fd-cell">${bar('k', s.k.hist[i])}<em>${s.k.hist[i] || ''}</em></span></div>`,
        )
        .join('')}
      <div class="fd-hrow foot"><span class="muted">median · avg</span><span>${dur(s.u.med)} · ${dur(s.u.avg)}</span><span>${dur(s.k.med)} · ${dur(s.k.avg)}</span></div>`;
    const rows = [...s.inst].sort((a, b) => b.n - a.n);
    $('fdPer').innerHTML =
      `<thead><tr><th>Instrument</th><th>Diffs</th><th>Apart</th><th>Longest</th><th>Biggest gap</th><th>Upstox first</th><th>Kite first</th><th title="Prices one feed showed and the other never did">Only U / only K</th><th>Median lag</th></tr></thead><tbody>` +
      (rows.length
        ? rows
            .map(
              (r) =>
                `<tr data-id="${r.i}" class="${fs.filter.inst === r.i ? 'fd-sel' : ''}"><td>${instLabel(r.i)}</td><td>${r.n}</td><td>${dur(r.ms)}</td><td>${dur(r.maxMs)}</td><td>₹${r.maxDiff.toFixed(2)}</td><td>${r.u}</td><td>${r.k}</td><td>${r.revU} / ${r.revK}</td><td>${dur(r.med)}</td></tr>`,
            )
            .join('')
        : `<tr><td class="muted" colspan="9">${d.total ? 'No differences pass the filter.' : 'No differences yet.'}</td></tr>`) +
      '</tbody>';
  }

  // ---------- episodes ----------
  const HOW = {
    follow: (e) => `${feedTag(e.b)} <span class="muted small">+${dur(e.lag)}</span>`,
    revert: (e) =>
      `<span class="muted" title="${NAME[e.l]} went back to the old price; ${NAME[e.l === 'u' ? 'k' : 'u']} never showed ${NAME[e.l]}'s price">never (went back)</span>`,
    cross: () => '<span class="muted" title="Both feeds moved while apart and met at another price">both moved</span>',
    cut: () => '<span class="muted" title="A feed dropped, the instrument left the watch list, or the expiry changed">cut short</span>',
  };
  function renderEpisodes(d) {
    $('fdCount').textContent =
      `${d.matched.toLocaleString('en-IN')} of ${d.total.toLocaleString('en-IN')}${d.matched > d.episodes.length ? ` · newest ${d.episodes.length} shown` : ''}`;
    const head = `<thead><tr><th>Started (IST)</th><th>Instrument</th><th>Field</th><th>Upstox at start</th><th>Kite at start</th><th>Biggest gap</th><th>Changed first</th><th>Changed later</th><th>Lasted</th><th>Ended (IST)</th><th>Agreed at</th></tr></thead>`;
    const rows = d.episodes.map(
      (e) => `<tr>
        <td class="mono">${clockMs(e.s)}</td>
        <td>${instLabel(e.i)}${e.x && e.x !== d.expiry ? ` <span class="muted small">${e.x}</span>` : ''}</td>
        <td>${e.f.toUpperCase()}</td>
        <td class="${e.l === 'u' ? 'fd-moved' : ''}">${px(e.u0)}</td>
        <td class="${e.l === 'k' ? 'fd-moved' : ''}">${px(e.k0)}</td>
        <td>₹${px(e.m)}</td>
        <td>${feedTag(e.l)}</td>
        <td>${HOW[e.h]?.(e) ?? e.h}</td>
        <td><b>${dur(e.e - e.s)}</b></td>
        <td class="mono">${clockMs(e.e)}</td>
        <td>${px(e.v)}</td>
      </tr>`,
    );
    $('fdEps').innerHTML =
      head +
      '<tbody>' +
      (rows.length
        ? rows.join('')
        : `<tr><td class="muted" colspan="11">${d.total ? 'No differences pass the filter.' : 'No differences recorded on this day.'}</td></tr>`) +
      '</tbody>';
  }

  function render(d) {
    renderKite(d);
    renderConfig(d);
    renderFilterLists(d);
    renderTiles(d);
    renderLive(d);
    renderLag(d);
    renderPaper(d);
    renderTrading(d);
    renderEpisodes(d);
    const notes = [];
    if (d.expiry) notes.push(`expiry ${d.expiry}`);
    if (!d.demo && !d.marketOpen) notes.push('market closed: the Upstox feed is off, so there is nothing to compare');
    if (d.error) notes.push(d.error);
    $('fdCfgNote').textContent = notes.join(' · ');
    maybeAutoLogin(d);
  }

  // A click on an instrument (live table or per-instrument table) filters the episodes to it; again to clear.
  for (const id of ['fdLive', 'fdPer']) {
    $(id).addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      fs.filter.inst = fs.filter.inst === tr.dataset.id ? '' : tr.dataset.id;
      $('fdInst').dataset.key = '';
      load();
    });
  }

  async function loadDays() {
    try {
      fs.days = await (await fetch('/api/feedcmp/days', { cache: 'no-store' })).json();
    } catch {}
  }

  window.addEventListener('viewchange', (e) => {
    if (e.detail !== 'feeds') return clearTimeout(fs.timer);
    loadDays();
    load().then(schedule);
  });

  // Back from the Kite Connect login (/kite/callback redirects to /?kite=ok): open this tab.
  if (new URLSearchParams(location.search).get('kite') === 'ok') {
    history.replaceState(null, '', '/');
    window.app.setView('feeds');
  } else if (window.app.state.view === 'feeds') {
    loadDays();
    load().then(schedule);
  }
})();
