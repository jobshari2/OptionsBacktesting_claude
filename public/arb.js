// Vertical-spread arbitrage: the scan and its list, shared by the Builder (replay or live chain) and the Chain
// screen (live chain), plus the Chain screen's own panel under the option chain.
//
// For one expiry and one option type, a vertical spread can never be worth less than 0 or more than its width
// (strike gap). Prices that break those bounds are a risk-free gain at expiry, before costs:
//   calls: C(lo) < C(hi)  -> buy lo, sell hi (paid to take a spread that cannot lose)
//          C(lo) - C(hi) > hi - lo -> sell lo, buy hi (credit above the most it can ever cost)
//   puts : P(lo) > P(hi)  -> sell lo, buy hi
//          P(hi) - P(lo) > hi - lo -> sell hi, buy lo
// Live prices use what you would really get (sell at bid, buy at ask) when the book is there, or the last traded
// prices when the LTP basis is picked (what the chain shows, but a stale print is not a price you can trade at);
// replay uses closes.
(() => {
  const { $, inr, inrS, dayShort } = BT;
  const MIN = 0.05; // smallest edge (index points) that counts: one tick past the no-arbitrage bound
  const WIDTHS = [10, 20, 30]; // strikes either side of ATM that can be scanned
  const SHOWN = 8;
  const nq = (n) => (n == null ? '—' : window.app?.compact ? window.app.compact(n) : String(n));
  const atmOf = (M) => M.ks.reduce((b, k) => (Math.abs(k - M.spot) < Math.abs(b - M.spot) ? k : b), M.ks[0]);

  const NEAR = 5; // pairs closest to an arbitrage, listed when none clears MIN
  const REACH = WIDTHS[WIDTHS.length - 1]; // every scan covers ATM ± 30; the width buttons pick which part is listed
  // M: { spot, ks, lot, expiry, px(k, type), quote(k, type) }. o: { live, basis: 'ba' (bid/ask, default) | 'ltp' }.
  // Returns every arbitrage (edge >= MIN) within ATM ± 30, each with reach = strikes its farther leg is from ATM.
  // .near[w] holds the closest of the rest within ATM ± w (edge below MIN, may be negative = points short of
  // break-even), so a quiet market still shows how far it is from a gap.
  function find(M, o) {
    const out = [];
    const rest = Object.fromEntries(WIDTHS.map((w) => [w, []]));
    const live = !!o.live;
    const ltpOnly = live && o.basis === 'ltp';
    const book = (k, t) => (live && !ltpOnly ? M.quote(k, t) : null);
    const sellPx = (k, t) => {
      const q = book(k, t);
      return q?.bid > 0 ? q.bid : M.px(k, t);
    };
    const buyPx = (k, t) => {
      const q = book(k, t);
      return q?.ask > 0 ? q.ask : M.px(k, t);
    };
    // Order-book depth behind a leg: selling needs buyers at the bid, buying needs sellers at the ask.
    const leg = (act, k, t) => {
      const q = book(k, t);
      return {
        act,
        k,
        px: act === 'S' ? sellPx(k, t) : buyPx(k, t),
        qty: q ? ((act === 'S' ? q.bidQ : q.askQ) ?? null) : null,
        buyers: q?.tbq ?? null,
        sellers: q?.tsq ?? null,
      };
    };
    // A strike is usable when it has a firm two-sided quote (a stale last trade does not matter then). Without one:
    // on the LTP basis any traded price, as the chain shows it; otherwise not a print below intrinsic value (an
    // illiquid in-the-money strike's old trade).
    const sane = (k, t) => {
      const q = book(k, t);
      if (q?.bid > 0 && q?.ask > 0) return true;
      const p = M.px(k, t);
      if (ltpOnly) return p > 0;
      return p > 0.05 && p >= Math.max(0, t === 'CE' ? M.spot - k : k - M.spot) - 0.5;
    };
    const at = M.ks.indexOf(atmOf(M));
    const reachOf = (k) => Math.abs(M.ks.indexOf(k) - at);
    for (const t of ['CE', 'PE']) {
      const ks = M.ks.slice(Math.max(0, at - REACH), at + REACH + 1).filter((k) => sane(k, t));
      for (let i = 0; i < ks.length; i++) {
        for (let j = i + 1; j < ks.length; j++) {
          const lo = ks[i];
          const hi = ks[j];
          const w = hi - lo;
          let a;
          if (t === 'CE') {
            const order = sellPx(hi, t) - buyPx(lo, t); // buy lo, sell hi for a credit
            const width = sellPx(lo, t) - buyPx(hi, t) - w; // sell lo, buy hi for more than the width
            a =
              order >= width
                ? {
                    kind: 'free credit',
                    edge: order,
                    legs: [
                      ['B', lo],
                      ['S', hi],
                    ],
                  }
                : {
                    kind: 'credit above width',
                    edge: width,
                    legs: [
                      ['S', lo],
                      ['B', hi],
                    ],
                  };
          } else {
            const order = sellPx(lo, t) - buyPx(hi, t); // sell lo, buy hi for a credit
            const width = sellPx(hi, t) - buyPx(lo, t) - w; // sell hi, buy lo for more than the width
            a =
              order >= width
                ? {
                    kind: 'free credit',
                    edge: order,
                    legs: [
                      ['S', lo],
                      ['B', hi],
                    ],
                  }
                : {
                    kind: 'credit above width',
                    edge: width,
                    legs: [
                      ['S', hi],
                      ['B', lo],
                    ],
                  };
          }
          const reach = Math.max(reachOf(lo), reachOf(hi));
          if (a.edge >= MIN) {
            out.push(full(a, t, lo, hi, reach));
            continue;
          }
          // a near miss: kept without its order-book detail until it makes the closest few of a range
          for (const wd of WIDTHS) {
            const r = rest[wd];
            if (reach > wd || (r.length >= NEAR && a.edge <= r[r.length - 1].a.edge)) continue;
            r.push({ a, t, lo, hi, reach });
            r.sort((x, y) => y.a.edge - x.a.edge);
            r.length = Math.min(r.length, NEAR);
          }
        }
      }
    }
    // lots both legs can fill at the quoted price (live only; the replay has no order book)
    function full(a, t, lo, hi, reach) {
      const info = a.legs.map(([act, k]) => leg(act, k, t));
      const qtys = info.map((x) => x.qty);
      const fit = live && qtys.every((x) => x != null) ? Math.floor(Math.min(...qtys) / M.lot) : null;
      return { ...a, type: t, lo, hi, reach, expiry: M.expiry, info, fit, dist: Math.min(Math.abs(lo - M.spot), Math.abs(hi - M.spot)) };
    }
    // nearest the money first, then the bigger edge
    out.sort((x, y) => x.dist - y.dist || y.edge - x.edge);
    out.near = Object.fromEntries(WIDTHS.map((wd) => [wd, rest[wd].map((x) => full(x.a, x.t, x.lo, x.hi, x.reach))]));
    return out;
  }

  // ---------- P&L of one spread ----------
  // Held to expiry, the spread pays between edge (Nifty past both strikes the wrong way) and edge + strike gap (Nifty
  // on the right side of both), whatever Nifty does. Charges are the Arbitrage screen's (an-view.js money()): ₹20 an
  // order, STT on the sell, exchange + SEBI fees, GST on brokerage and fees, stamp duty on the buy, plus the STT a
  // long option pays when exercised in the money (taken at today's Nifty). Only the two entry orders are charged.
  const COST = { brokerage: 20, stt: 0.001, txn: 0.0003503, sebi: 0.000001, gst: 0.18, stamp: 0.00003, exStt: 0.00125 };
  function pnl(a, lots, M) {
    const q = lots * M.lot;
    let buy = 0;
    let sell = 0;
    let ex = 0;
    for (const x of a.info) {
      const turn = (x.px || 0) * q;
      if (x.act === 'B') {
        buy += turn;
        ex += Math.max(0, a.type === 'CE' ? M.spot - x.k : x.k - M.spot) * q * COST.exStt;
      } else sell += turn;
    }
    const brk = a.info.length * COST.brokerage;
    const fees = (buy + sell) * (COST.txn + COST.sebi);
    const cost = brk + sell * COST.stt + fees + COST.gst * (brk + fees) + buy * COST.stamp + ex;
    const min = a.edge * q;
    const max = (a.edge + a.hi - a.lo) * q;
    return { q, min, max, cost, netMin: min - cost, netMax: max - cost, debit: sell - buy < 0 ? buy - sell : 0 };
  }

  // The list for find()'s result. o: { live, basis ('ba' | 'ltp', as passed to find), width (ATM ± width is listed), type: 'ALL' | 'CE' | 'PE', lots, btn, btnTip }.
  // Returns { html, shown }: shown is the filtered list in the order listed; a row's button carries data-arb = its
  // index in it, the filter buttons data-af and the width buttons data-aw.
  function html(found, M, o) {
    const f = o.type || 'ALL';
    const live = !!o.live;
    const ltpOnly = live && o.basis === 'ltp';
    const inW = (w) => found.filter((a) => a.reach <= w);
    const ofType = (list) => list.filter((a) => f === 'ALL' || a.type === f);
    const arbs = inW(o.width);
    const cnt = { ALL: arbs.length, CE: arbs.filter((a) => a.type === 'CE').length, PE: arbs.filter((a) => a.type === 'PE').length };
    const filt =
      `<span class="seg sm">${['ALL', 'CE', 'PE'].map((v) => `<button data-af="${v}" class="${f === v ? 'on' : ''}">${v === 'ALL' ? 'All' : v} ${cnt[v]}</button>`).join('')}</span> <span class="seg sm" title="ATM ± 10, ± 20 and ± 30 are all scanned on every update; the number is the arbitrages found within each. Click one to list it.">${WIDTHS.map((w) => `<button data-aw="${w}" class="${o.width === w ? 'on' : ''}">ATM ± ${w} · ${ofType(inW(w)).length}</button>`).join('')}</span>` +
      (live
        ? ` <span class="seg sm" title="Bid/Ask: the prices you can trade at now (sell at the bid, buy at the ask). LTP: the last traded prices shown in the chain; a stale print can show a gap you cannot fill.">${[
            ['ba', 'Bid/Ask'],
            ['ltp', 'LTP'],
          ]
            .map(([v, l]) => `<button data-ab="${v}" class="${(o.basis || 'ba') === v ? 'on' : ''}">${l}</button>`)
            .join('')}</span>`
        : '');
    // how many strikes each leg is from the at-the-money strike: ATM, ATM+2, ATM-3 …
    const atmK = atmOf(M);
    const atmI = M.ks.indexOf(atmK);
    const atmTag = (k) => {
      const d = M.ks.indexOf(k) - atmI;
      return d === 0 ? 'ATM' : `ATM${d > 0 ? '+' : '-'}${Math.abs(d)}`;
    };
    const money = (n) => `<b class="${n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted'}">${inrS(n)}</b>`;
    // P&L at expiry for the lots chosen, before and after charges
    const pnlLine = (a) => {
      const p = pnl(a, o.lots, M);
      return (
        `<div class="arb-pnl small" title="At expiry, holding both legs: the spread is worth between its worst case (Nifty past both strikes the wrong way) and its best case (Nifty on the right side of both). Charges: ₹20 an order, STT, exchange and SEBI fees, GST and stamp duty, plus STT on exercise of the long leg if it ends in the money (at today's Nifty). Slippage not included.">` +
        `<span class="muted">P&amp;L at expiry · ${o.lots} lot${o.lots === 1 ? '' : 's'} (${p.q} qty):</span> ` +
        `worst ${money(p.min)} · best ${money(p.max)} <span class="muted">· charges</span> ${inr(p.cost)} ` +
        `<span class="muted">→ net</span> ${money(p.netMin)} <span class="muted">to</span> ${money(p.netMax)}` +
        (p.debit ? ` <span class="muted">· pays ${inr(p.debit)} up front</span>` : '') +
        '</div>'
      );
    };
    const row = (a, i) => {
      const depth = a.info
        .map(
          (x) =>
            `<span class="${x.act === 'B' ? 'pos' : 'neg'}">${x.act === 'S' ? 'SELL' : 'BUY'} ${x.k}</span> ${x.act === 'S' ? 'buyers' : 'sellers'} at ${x.px?.toFixed(2)}: <b>${nq(x.qty)}</b> <span class="muted">(book ${nq(x.buyers)} buy / ${nq(x.sellers)} sell)</span>`,
        )
        .join(' · ');
      const badge = ltpOnly
        ? '<span class="arb-fit thin" title="Found on last traded prices: check the bid / ask before trading">⚠ LTP, check bid/ask</span>'
        : !live
          ? '<span class="arb-fit na" title="The replay has no order book">depth n/a (replay)</span>'
          : a.fit == null
            ? '<span class="arb-fit na" title="No depth in the quote">depth unknown</span>'
            : `<span class="arb-fit ${a.fit >= o.lots ? 'ok' : a.fit > 0 ? 'thin' : 'none'}" title="Lots both legs can fill at the quoted price">${a.fit >= o.lots ? '✔' : '⚠'} ${a.fit} lot${a.fit === 1 ? '' : 's'} fillable</span>`;
      return `<div class="arb-row"><span class="arb-leg">${a.legs.map(([act, k]) => `<b class="${act === 'B' ? 'pos' : 'neg'}">${act === 'B' ? 'BUY' : 'SELL'}</b> ${k} ${a.type} <span class="muted small" title="Strikes away from the at-the-money strike (${atmK})">(${atmTag(k)})</span>`).join(' + ')}</span>
        <span class="muted small">${a.kind} · ${a.dist === 0 ? 'at the money' : `${Math.round(a.dist)} pts from Nifty`}</span> ${a.edge >= MIN ? `<b class="pos" title="Guaranteed minimum gain per lot">+${a.edge.toFixed(2)} pts · ${inr(a.edge * M.lot)}/lot</b>` : `<b class="neg" title="Points this spread is short of a ${MIN}-point arbitrage edge at today's prices (negative = it would cost this much)">${a.edge >= 0 ? '+' : ''}${a.edge.toFixed(2)} pts · ${(MIN - a.edge).toFixed(2)} short</b>`} ${badge}
        <button class="btn-sm ghost" data-arb="${i}" title="${o.btnTip}">${o.btn}</button>
        ${pnlLine(a)}
        ${live && !ltpOnly ? `<div class="arb-depth small">${depth}</div>` : ''}</div>`;
    };
    if (!arbs.length) {
      const near = ofType(found.near?.[o.width] || []);
      return {
        shown: near,
        html:
          `<div class="arb-head">${filt} <span class="muted small">No vertical-spread arbitrage within ATM ± ${o.width} strikes on this expiry${ltpOnly ? ' at last traded prices' : live ? ' at bid/ask' : ''}: prices respect the no-arbitrage bounds.${near.length ? ` Closest pairs (edge needed: +${MIN} pts):` : ''}</span></div>` +
          near.map((a, i) => row(a, i).replace('class="arb-row"', 'class="arb-row near"')).join(''),
      };
    }
    const all = ofType(arbs);
    const shown = all.slice(0, SHOWN);
    return {
      shown: all,
      html:
        `<div class="arb-head">${filt} <b>⚡ ${all.length} vertical-spread arbitrage${all.length === 1 ? '' : 's'}</b> <span class="muted small">nearest the money first · risk-free at expiry before brokerage and slippage${ltpOnly ? '; on last traded prices, so a stale print can look like an arbitrage: check the bid/ask' : live ? '; priced at bid/ask' : '; replay uses last traded prices, so a stale print can look like an arbitrage'}</span></div>` +
        (shown.length ? shown.map(row).join('') : '<div class="muted small">None of this type.</div>') +
        (all.length > shown.length ? `<div class="muted small">+${all.length - shown.length} farther from the money</div>` : ''),
    };
  }

  BT.arb = { WIDTHS, find, html };

  // ---------- Chain screen: live vertical spreads of the expiry shown in the chain ----------
  // app.js calls BT.chainArb(data) on every new snapshot of the live chain.
  const el = $('chArb');
  if (!el) return; // chart.html has no chain
  const C = { type: 'ALL', width: 10, lots: 1, basis: 'ba', collapsed: false, ...BT.store.get('chainArb', {}) };
  const save = () => BT.store.set('chainArb', C);
  const width = () => (WIDTHS.includes(C.width) ? C.width : 10);
  const lots = () => Math.max(1, Math.floor(Number(C.lots)) || 1);
  let last = null; // the chain snapshot on screen
  let shown = [];
  let drawn = '';
  let pressed = false; // a mouse button is down in the list: redrawing now would swallow the click
  BT.loadMeta()
    .then(() => last && draw(last))
    .catch(() => {}); // the Nifty lot size comes with the calendar

  function marketOf(d) {
    const by = new Map(d.rows.filter((r) => [r.ce, r.pe].some((q) => q.ltp || (q.bid && q.ask))).map((r) => [r.strike, r]));
    const side = (k, t) => {
      const r = by.get(k);
      return r ? (t === 'CE' ? r.ce : r.pe) : null;
    };
    return {
      spot: d.spot,
      ks: [...by.keys()],
      lot: BT.meta.calendar?.liveLot || 65,
      expiry: d.expiry,
      px: (k, t) => {
        const v = side(k, t)?.ltp;
        return v > 0 ? v : null;
      },
      quote: side,
    };
  }
  function draw(d) {
    last = d;
    if (C.collapsed || pressed || window.app.state.view !== 'chain') return;
    $('chArbInfo').textContent = d.expiry ? `expiry ${dayShort(d.expiry)} · live` : '';
    const M = marketOf(d);
    if (d.spot == null || !M.ks.length) {
      shown = [];
      el.innerHTML = '<div class="muted small">Waiting for the option chain…</div>';
      drawn = '';
      return;
    }
    const r = html(find(M, { live: true, basis: C.basis }), M, {
      live: true,
      basis: C.basis,
      width: width(),
      type: C.type,
      lots: lots(),
      btn: 'Open in Builder ▸',
      btnTip: 'Open both legs as a paper position in the Builder on the live chain (payoff, P&L and adjustments)',
    });
    shown = r.shown;
    if (r.html !== drawn) {
      el.innerHTML = r.html;
      drawn = r.html;
    }
  }
  BT.chainArb = draw;

  function setCollapsed(on) {
    C.collapsed = on;
    save();
    $('chArbPanel').classList.toggle('collapsed', on);
    $('chArbCaret').textContent = on ? '▸' : '▾';
    if (last) window.app.render(); // redraws this list, and the chain refits the height it gained or lost
  }
  $('chArbHead').addEventListener('click', (e) => {
    if (!e.target.closest('label')) setCollapsed(!C.collapsed);
  });
  $('chArbLots').value = lots();
  $('chArbLots').addEventListener('input', (e) => {
    C.lots = Number(e.target.value);
    save();
    if (last) draw(last);
  });
  el.addEventListener('pointerdown', () => {
    pressed = true;
  });
  window.addEventListener('pointerup', () =>
    setTimeout(() => {
      if (pressed) {
        pressed = false;
        if (last) draw(last);
      }
    }, 0),
  );
  el.addEventListener('click', (e) => {
    const aw = e.target.closest('button[data-aw]');
    const af = e.target.closest('button[data-af]');
    const ab = e.target.closest('button[data-ab]');
    const b = e.target.closest('button[data-arb]');
    pressed = false;
    if (aw) C.width = Number(aw.dataset.aw);
    else if (af) C.type = af.dataset.af;
    else if (ab) C.basis = ab.dataset.ab;
    if (aw || af || ab) {
      save();
      if (last) draw(last);
      return;
    }
    const a = b && shown[Number(b.dataset.arb)];
    if (!a) return;
    if (BT.store.get('sb', {}).legs?.some((l) => l.open) && !confirm('The Builder already holds a position. Replace it with this spread?')) return;
    const note = `vertical-spread arbitrage ${a.lo}/${a.hi} ${a.type}`;
    BT.emit('open-builder', {
      src: 'live',
      expiry: a.expiry,
      note,
      legs: a.info.map((x) => ({ action: x.act, type: a.type, strike: x.k, expiry: a.expiry, lots: lots() })),
    });
  });
  setCollapsed(!!C.collapsed);
})();
