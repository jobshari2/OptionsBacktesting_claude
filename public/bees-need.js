// NIFTYBEES to buy against a strategy: the help line shown on the Trading Ideas tabs, the Live trade tab with no trade,
// the Suggestion popup and the Builder. Sized as "Enter new trade" sizes them (bt/mcc.js etfQty): the budget's worth
// when one is set, else one lot of Nifty's worth per lot of the strategy (lot × lots × Nifty), at NIFTYBEES' price now.
//   BeesNeed.calc({ budget, lots, lot }, spot, px) -> { qty, cost, px, ... } | null   (no fetch)
//   BeesNeed.get({ budget, lots, lot })            -> /api/mcc/bees-need (Nifty and NIFTYBEES now), cached 20 s
//   BeesNeed.html(r, { title, note, big })         -> the highlighted box
//   BeesNeed.fill(el, o)                           -> get + html into el
(function () {
  const TTL = 20_000;
  const cache = new Map();
  const n0 = (v) => Math.round(v).toLocaleString('en-IN');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function calc(o, spot, px) {
    const budget = o?.budget > 0 ? Number(o.budget) : 0;
    const lots = Math.max(1, Number(o?.lots) || 1);
    const lot = Number(o?.lot) > 0 ? Number(o.lot) : 65;
    if (!(px > 0) || (!budget && !(spot > 0))) return null;
    const qty = Math.round((budget > 0 ? budget : lot * lots * spot) / px);
    return qty > 0 ? { budget, lots, lot, spot: spot > 0 ? spot : null, px, qty, cost: Math.round(qty * px), est: Boolean(o?.est), how: o?.how || null } : null;
  }

  function get(o = {}) {
    const q = new URLSearchParams({ budget: String(o.budget > 0 ? o.budget : 0), lots: String(o.lots || 1), ...(o.lot > 0 ? { lot: String(o.lot) } : {}) });
    const key = q.toString();
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c.p;
    const p = window.BT.api('/api/mcc/bees-need?' + key).catch(() => null);
    cache.set(key, { at: Date.now(), p });
    return p;
  }

  // How the units were sized, in words
  function basis(r) {
    if (r.budget > 0) return `your budget ₹${n0(r.budget)} ÷ ₹${r.px.toFixed(2)}`;
    return `${r.lots > 1 ? `${r.lots} lots × ` : 'one lot of Nifty: '}${r.lot} × Nifty ${n0(r.spot)} ÷ ₹${r.px.toFixed(2)}`;
  }
  function priceTxt(r) {
    if (r.est) return 'NIFTYBEES price estimated (Nifty ÷ 100)';
    return r.how === 'tick' ? 'NIFTYBEES streamed now' : r.how === 'ltp' ? 'NIFTYBEES last traded price' : r.how || 'NIFTYBEES price now';
  }

  function html(r, o = {}) {
    const title = o.title || 'NIFTYBEES to buy';
    const cls = `bees-need${o.big ? ' big' : ''}${o.cls ? ' ' + o.cls : ''}`;
    const act = o.action || ''; // extra HTML at the box's right (a button)
    if (!r?.qty) {
      return `<div class="${cls} none"><span class="bn-ico">🛒</span><div class="bn-txt"><div class="bn-main">${esc(title)}: <b>one lot of Nifty's worth</b> per lot of the strategy (65 × Nifty ÷ NIFTYBEES price)${o.budget > 0 ? `, or your budget ₹${n0(o.budget)}` : ''}</div><div class="bn-sub">${
        r && r.loggedIn === false ? 'Log in to Upstox or Kite to see the units and the cost at the prices now.' : 'No Nifty / NIFTYBEES price yet to work out the units.'
      }${o.note ? ' ' + o.note : ''}</div></div></div>`;
    }
    return `<div class="${cls}"><span class="bn-ico">🛒</span><div class="bn-txt"><div class="bn-main">${esc(title)}: <b class="bn-qty">${n0(r.qty)} units</b> at ₹${r.px.toFixed(2)} ≈ <b class="bn-cost">₹${n0(r.cost)}</b></div><div class="bn-sub">${o.basis || basis(r)} · ${priceTxt(r)}${r.demo ? ' · demo prices' : ''}${o.note ? ' · ' + o.note : ''}</div></div>${act}</div>`;
  }

  async function fill(el, o = {}) {
    if (!el) return null;
    const r = await get(o);
    el.innerHTML = html(r, o);
    return r;
  }

  window.BeesNeed = { calc, get, html, fill };
})();
