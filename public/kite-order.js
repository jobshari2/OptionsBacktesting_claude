// "Trade on Kite" from any screen that holds legs (Builder, Strategies › Deploy live, Covered call suggestions, Hedge,
// Arbitrage, Trades): one confirmation dialog that sends the legs to Zerodha Kite as a basket through kitebasket.js on the
// server (/api/kite/basket/preview, /api/kite/basket). The same rules as Live Ideas' own dialog: LIMIT orders at the price
// shown ± a buffer (or MARKET), the BUY legs first and the SELL legs only when every BUY has filled, a basket of SELLs
// only as an exit of longs Kite already holds, and nothing is sent before the "real orders" box is ticked.
//   KiteOrder.open({ title, sub, legs: [{ action: 'B' | 'S', type: 'CE' | 'PE', strike, expiry, lots, price }], exit })
//   KiteOrder.button(label?)  the orange button's HTML (data-kite-order), for screens that draw their own
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const f2 = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(2));
  const inr = (n) => (n == null || !Number.isFinite(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
  const FREEZE = 1800; // Nifty's freeze quantity for one order (kitebasket.js refuses more)
  const K = { spec: null, mult: 1, orderType: 'LIMIT', product: 'NRML', buffer: 0.5, ack: false, prev: null, err: null, busy: false, result: null, seq: 0 };

  const dlg = document.createElement('div');
  dlg.className = 'id-modal hidden';
  dlg.id = 'kiteOrderDlg';
  dlg.innerHTML = `<div class="id-modal-box" role="dialog" aria-modal="true" aria-label="Trade on Zerodha Kite">
      <div class="id-modal-head"><div><h3 id="koTitle">Trade on Zerodha Kite</h3><div class="muted small" id="koSub"></div></div><button class="icon" data-ko="close" title="Close">✕</button></div>
      <div id="koLogin" class="kd-login"></div>
      <div id="koBody"></div>
    </div>`;
  document.body.appendChild(dlg);
  const $ = (id) => document.getElementById(id);

  async function api(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }

  // The legs as the server wants them: K.mult times the position's own lots.
  const legsOut = () =>
    K.spec.legs.map((l) => ({
      action: l.action,
      type: l.type,
      strike: Number(l.strike),
      expiry: l.expiry,
      lots: K.mult * Math.max(1, Math.round(l.lots || 1)),
      price: Number(l.price),
    }));
  const lot = () => K.prev?.lot || window.BT?.meta?.calendar?.liveLot || null;
  const maxMult = () => {
    const per = Math.max(...K.spec.legs.map((l) => Math.max(1, Math.round(l.lots || 1))));
    return lot() ? Math.max(1, Math.floor(FREEZE / (lot() * per))) : 50;
  };

  // Max profit / loss at expiry of an entry whose legs share one expiry (piecewise linear: the strikes and both tails).
  function payoffFigures(legs, lotSize) {
    if (!lotSize || new Set(legs.map((l) => l.expiry)).size !== 1) return null;
    const val = (S) =>
      legs.reduce((a, l) => {
        const intr = Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S);
        return a + (l.action === 'B' ? 1 : -1) * (intr - l.price) * l.lots * lotSize;
      }, 0);
    const ks = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
    const pts = [0, ...ks, ks[ks.length - 1] * 3];
    const vals = pts.map(val);
    // beyond the highest strike the value keeps the slope of the calls held
    const slope = legs.reduce((a, l) => a + (l.type === 'CE' ? (l.action === 'B' ? 1 : -1) * l.lots : 0), 0);
    return {
      maxP: slope > 0 ? Infinity : Math.max(...vals),
      maxL: slope < 0 ? -Infinity : Math.min(...vals),
      net: legs.reduce((a, l) => a + (l.action === 'S' ? 1 : -1) * l.price * l.lots * lotSize, 0),
    };
  }

  async function preview() {
    const seq = ++K.seq;
    try {
      const prev = await api('/api/kite/basket/preview', {
        legs: legsOut(),
        product: K.product,
        buffer: K.buffer,
        orderType: K.orderType,
        strategyLots: K.mult,
      });
      if (seq === K.seq) Object.assign(K, { prev, err: null });
    } catch (e) {
      if (seq === K.seq) Object.assign(K, { prev: null, err: e.message });
    }
    render();
  }

  function open(spec) {
    const legs = (spec?.legs || []).filter((l) => l && (l.action === 'B' || l.action === 'S') && (l.type === 'CE' || l.type === 'PE') && Number(l.strike) > 0);
    if (!legs.length) return alert('There are no legs to send to Kite.');
    if (legs.some((l) => !(Number(l.price) > 0))) return alert('A leg has no price yet: wait for the live chain, then try again.');
    Object.assign(K, { spec: { ...spec, legs }, mult: 1, ack: false, prev: null, err: null, result: null, busy: false });
    dlg.classList.remove('hidden');
    window.KiteLogin?.refresh();
    render();
    preview();
  }
  function close() {
    if (!K.busy) dlg.classList.add('hidden');
  }

  function render() {
    if (dlg.classList.contains('hidden') || !K.spec) return;
    const S = K.spec;
    const P = K.prev;
    const k = window.KiteLogin?.status;
    const demo = window.KiteLogin?.demo();
    const loggedIn = demo || k?.loggedIn;
    const market = K.orderType === 'MARKET';
    $('koTitle').textContent = S.exit ? 'Close on Zerodha Kite' : 'Trade on Zerodha Kite';
    $('koSub').textContent = [S.title, S.sub].filter(Boolean).join(' · ');
    $('koLogin').classList.toggle('kd-in', !!loggedIn);
    const rows = (
      P?.legs || legsOut().map((l) => ({ ...l, action: l.action === 'B' ? 'BUY' : 'SELL', symbol: '…', qty: lot() ? l.lots * lot() : '…', limit: null }))
    )
      .slice()
      .sort((a, b) => (a.action === b.action ? 0 : a.action === 'BUY' ? -1 : 1));
    const hasBuy = rows.some((l) => l.action === 'BUY');
    const step = (a) => (a === 'BUY' ? '1 · first' : hasBuy ? '2 · after the buys fill' : 'exit of a long held');
    let body;
    if (K.result) {
      const R = K.result;
      body = `<div class="kd-banner ${R.status === 'done' ? 'ok' : 'bad'}"><b>${R.status === 'done' ? 'All legs filled' : R.status === 'stopped' ? 'Stopped: nothing was sold' : R.status === 'partial' ? 'Partly filled: check Kite' : 'Not placed'}</b> ${esc(R.message)}${R.demo ? ' <span class="muted">(demo: simulated)</span>' : ''}</div>
        ${
          R.legs?.length
            ? `<table class="grid-tbl kd-legs"><thead><tr><th class="l">Leg</th><th class="l">Instrument</th><th>Qty</th><th>${R.orderType === 'MARKET' ? 'Order' : 'Limit'}</th><th class="l">Order id</th><th class="l">Status</th><th>Filled</th><th>Avg</th></tr></thead><tbody>${R.legs
                .map(
                  (l) =>
                    `<tr><td class="l"><span class="id-act ${l.action === 'BUY' ? 'b' : 's'}">${l.action}</span></td><td class="l">${esc(l.symbol)}</td><td>${l.qty}</td><td>${R.orderType === 'MARKET' ? 'Market' : f2(l.limit)}</td><td class="l muted">${esc(l.id || '—')}</td><td class="l ${l.status === 'COMPLETE' ? 'pos' : l.status === 'PENDING' || l.status === 'PLACED' ? '' : 'neg'}">${esc(l.status)}${l.msg ? ` <span class="muted small">${esc(l.msg)}</span>` : ''}</td><td>${l.filled || 0}</td><td>${l.avg ? f2(l.avg) : '—'}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : ''
        }
        <div class="kd-foot"><button class="btn-sm" data-ko="close">Close</button></div>`;
    } else {
      const net = P ? P.legs.reduce((a, l) => a + (l.action === 'SELL' ? 1 : -1) * (l.limit ?? l.price) * l.qty, 0) : null;
      const charges =
        P && window.Costs
          ? window.Costs.orders({
              buy: P.legs.filter((l) => l.action === 'BUY').reduce((a, l) => a + (l.limit ?? l.price) * l.qty, 0),
              sell: P.legs.filter((l) => l.action === 'SELL').reduce((a, l) => a + (l.limit ?? l.price) * l.qty, 0),
              orders: P.legs.length,
            })
          : null;
      const F =
        !S.exit && lot()
          ? payoffFigures(
              legsOut().map((l) => ({ ...l })),
              lot(),
            )
          : null;
      const why = !loggedIn ? 'Log in to Kite above first.' : K.err || P?.gate || null;
      const can = !!(P && loggedIn && !P.gate && !K.err);
      const money = (v) => (v === Infinity ? 'Unlimited' : v === -Infinity ? 'Unlimited' : inr(Math.abs(v)));
      const funds =
        P?.funds?.available != null
          ? `Funds available <b>${inr(P.funds.available)}</b>`
          : demo
            ? 'Funds are not read in demo mode'
            : loggedIn
              ? 'Funds could not be read'
              : '';
      const margin =
        P?.margin?.total != null
          ? `Kite margin for this basket <b>${inr(P.margin.total)}</b> <span class="muted">(hedges counted)</span>`
          : P?.margin?.error
            ? `<span class="muted">Kite margin unavailable: ${esc(P.margin.error)}</span>`
            : '';
      body = `<div class="kd-idea">${
        F
          ? `<span>Max profit <b class="pos">${money(F.maxP)}</b></span><span>Max loss <b class="neg">${money(F.maxL)}</b></span><span>${F.net >= 0 ? 'Credit' : 'Debit'} <b>${inr(Math.abs(F.net))}</b> <span class="muted small">at the prices shown, at expiry</span></span>`
          : S.exit
            ? '<span>Closes the open legs: the reverse of each one.</span>'
            : ''
      }${P?.user ? `<span>Account <b>${esc(P.user)}</b></span>` : ''}</div>
        ${F && F.maxL === -Infinity ? '<div class="kd-banner bad">This position has <b>unlimited risk</b> at expiry: check it is what you want before sending it.</div>' : ''}
        <table class="grid-tbl kd-legs"><thead><tr><th class="l">Step</th><th class="l">Leg</th><th class="l">Kite instrument</th><th>Lots</th><th>Qty</th><th>Price shown</th><th>${market ? 'Order' : 'Limit order'}</th></tr></thead><tbody>${rows
          .map(
            (l) =>
              `<tr><td class="l muted small">${step(l.action)}</td><td class="l"><span class="id-act ${l.action === 'BUY' ? 'b' : 's'}">${l.action}</span> ${l.strike} ${l.type} <span class="muted small">${esc(l.expiry)}</span></td><td class="l">${esc(l.symbol)}</td><td>${l.lots}</td><td>${l.qty}</td><td>${f2(l.price)}</td><td><b>${market ? 'Market' : l.limit ? f2(l.limit) : '…'}</b></td></tr>`,
          )
          .join('')}</tbody></table>
        <div class="kd-set">
          <label class="id-ctl" title="Every leg's lots are multiplied by this">× <input class="num xs" type="number" id="koMult" min="1" max="${maxMult()}" step="1" value="${K.mult}"></label>
          <span class="id-ctl" title="Limit: at the price shown, moved by the buffer towards a fill. Market: fills at once at the best price on the book, which can be worse than the price shown.">Order <span class="seg sm"><button data-ko="otype" data-v="LIMIT" class="${market ? '' : 'on'}">Limit</button><button data-ko="otype" data-v="MARKET" class="${market ? 'on' : ''}">Market price</button></span></span>
          ${market ? '' : `<label class="id-ctl" title="Points added to a buy's price and taken off a sell's, so a quote that moved a tick still fills. Rounded to the 0.05 tick.">Limit buffer <input class="num xs" type="number" id="koBuffer" min="0" max="5" step="0.25" value="${K.buffer}"> pts</label>`}
          <label class="id-ctl">Product <select id="koProduct"><option value="NRML" ${K.product === 'NRML' ? 'selected' : ''}>NRML (carry)</option><option value="MIS" ${K.product === 'MIS' ? 'selected' : ''}>MIS (intraday)</option></select></label>
          ${net != null ? `<span class="kd-net">${net >= 0 ? 'Credit' : 'Debit'} ${market ? 'at the prices shown' : 'at the limits'} <b>${inr(Math.abs(net))}</b>${charges != null ? ` · charges ≈ <b>${inr(charges)}</b>` : ''}</span>` : ''}
        </div>
        ${funds || margin ? `<div class="kd-suggest"><div>${[funds, margin].filter(Boolean).join(' · ')}</div></div>` : ''}
        <div class="kd-note muted small">${market ? '<b>Market orders</b> fill at once at the best price on the book: the price paid can be worse than the price shown.' : 'Limit orders at the price shown ± the buffer.'} The <b>BUY legs go first</b>; the SELL legs are sent only when every BUY has filled, so no short is ever uncovered. A basket of SELLs alone is sent only when each one closes a long Kite already holds. A leg not filled after about 20 s is cancelled. These are <b>real orders</b> on your Kite account.</div>
        ${why ? `<div class="kd-banner bad">${esc(why)}</div>` : ''}
        <label class="kd-ack"><input type="checkbox" id="koAck" ${K.ack ? 'checked' : ''} ${can ? '' : 'disabled'}> I understand these are real orders${P?.user ? ` on Kite account <b>${esc(P.user)}</b>` : ''}${demo ? ' (demo: simulated)' : ''}</label>
        <div class="kd-foot"><button class="btn-sm ghost" data-ko="close">Cancel</button><button class="btn-sm kite" data-ko="place" ${can && K.ack && !K.busy ? '' : 'disabled'}>${K.busy ? 'Placing…' : `Place ${rows.length} ${market ? 'market ' : ''}order${rows.length === 1 ? '' : 's'} on Kite`}</button></div>`;
    }
    $('koBody').innerHTML = body;
  }

  async function place() {
    K.busy = true;
    render();
    try {
      K.result = await api('/api/kite/basket', {
        legs: legsOut(),
        product: K.product,
        buffer: K.buffer,
        orderType: K.orderType,
        confirmed: true,
        name: K.spec.title || null,
      });
    } catch (e) {
      K.result = { ok: false, status: 'error', message: e.message, legs: [] };
    }
    K.busy = false;
    render();
    window.dispatchEvent(new CustomEvent('kiteorders', { detail: K.result }));
  }

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return close();
    const b = e.target.closest('[data-ko]');
    if (!b) return;
    if (b.dataset.ko === 'close') close();
    else if (b.dataset.ko === 'place' && K.ack && !K.busy) place();
    else if (b.dataset.ko === 'otype') {
      K.orderType = b.dataset.v === 'MARKET' ? 'MARKET' : 'LIMIT';
      K.ack = false;
      render();
      preview();
    }
  });
  dlg.addEventListener('change', (e) => {
    if (e.target.id === 'koAck') K.ack = e.target.checked;
    else if (e.target.id === 'koMult') {
      K.mult = Math.min(maxMult(), Math.max(1, Math.floor(Number(e.target.value)) || 1));
      K.ack = false;
      preview();
    } else if (e.target.id === 'koProduct') {
      K.product = e.target.value === 'MIS' ? 'MIS' : 'NRML';
      K.ack = false;
      preview();
    } else if (e.target.id === 'koBuffer') {
      K.buffer = Math.min(5, Math.max(0, Number(e.target.value) || 0));
      K.ack = false;
      preview();
    } else return;
    render();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !dlg.classList.contains('hidden') && close());
  window.addEventListener('kitechange', () => {
    if (!dlg.classList.contains('hidden') && !K.result) preview();
  });
  window.KiteLogin?.mount($('koLogin'));

  // Any button carrying its legs as JSON (data-kite-legs, data-kite-title) opens the dialog with them.
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target.closest('[data-kite-legs]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        open({ title: b.dataset.kiteTitle || '', legs: JSON.parse(b.dataset.kiteLegs) });
      } catch (err) {
        alert('Could not read the legs: ' + err.message);
      }
    },
    true,
  );

  const button = (
    label = 'Trade on Kite',
    title = 'Send these legs to Zerodha Kite as real orders (limit orders: buys first, sells only after the buys fill). Asks you to confirm first.',
  ) => `<button type="button" class="btn-sm kite" data-kite-order="1" title="${esc(title)}">${esc(label)}</button>`;

  window.KiteOrder = { open, close, button, payoffFigures };
})();
