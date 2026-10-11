// Payoff engine shared by the Builder (sb-view.js) and the Strategies deploy panel (lib-view.js): one set of
// curves, KPIs, chart and what-if controls, so both screens show the same numbers for the same position.
//   legs: [{ action: 'B'|'S', type: 'CE'|'PE', strike, lots, lot, entryPx, iv (decimal), T (years to the leg's expiry), px (price now) }]
// Curves: at the horizon (the nearest expiry among the legs, or a chosen date; later-expiry legs valued by Black-Scholes there),
// today (T+0) and, with the "days ahead" control, T+N. The IV control shifts every leg's IV for the curves
// that still have time value. Greeks are Black-Scholes per leg, in rupees for the whole position.
(() => {
  const { inr, inrS, kinr, num, cls, bs, ncdf, RATE } = BT;
  const dirOf = (l) => (l.action === 'B' ? 1 : -1);
  const qty = (l) => dirOf(l) * l.lots * l.lot;
  const intrinsic = (l, x) => Math.max(0, l.type === 'CE' ? x - l.strike : l.strike - x);

  function greeks(Sx, K, T, v, call) {
    if (!v || T <= 1e-6) return { delta: call ? (Sx > K ? 1 : 0) : Sx < K ? -1 : 0, gamma: 0, theta: 0, vega: 0 };
    const x = (Math.log(Sx / K) + (RATE + (v * v) / 2) * T) / (v * Math.sqrt(T));
    const pdf = Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
    const p0 = bs(Sx, K, T, v, call);
    return {
      delta: call ? ncdf(x) : ncdf(x) - 1,
      gamma: pdf / (Sx * v * Math.sqrt(T)),
      theta: bs(Sx, K, Math.max(1e-6, T - 1 / 365), v, call) - p0, // per calendar day
      vega: bs(Sx, K, T, v + 0.01, call) - p0, // per 1 vol point
    };
  }

  // Capital to put the position on: margin for the short legs + premium paid for the long legs. Same rough rule as
  // the backtester (about 9% of notional per naked short lot, capped by the defined-risk loss when longs of the same
  // type cover it; straddles / strangles get partial offset). oneLot: every leg at 1 lot.
  function capital(legs, spot, oneLot) {
    const q = (l) => (oneLot ? 1 : l.lots) * l.lot;
    const side = (type) => {
      const ls = legs.filter((l) => l.type === type);
      const shortQty = ls.filter((l) => l.action === 'S').reduce((a, l) => a + q(l), 0);
      if (!shortQty) return 0;
      let worst = 0;
      for (let k = 0.6; k <= 1.4001; k += 0.01) {
        const x = spot * k;
        worst = Math.min(
          worst,
          ls.reduce((a, l) => a + dirOf(l) * q(l) * (intrinsic(l, x) - l.entryPx), 0),
        );
      }
      return Math.min(0.09 * spot * shortQty, -worst);
    };
    const ce = side('CE');
    const pe = side('PE');
    const margin = Math.max(ce, pe) + 0.3 * Math.min(ce, pe);
    const premium = legs.filter((l) => l.action === 'B').reduce((a, l) => a + l.entryPx * q(l), 0);
    return { margin, premium, total: margin + premium };
  }

  // opts: { spot, atmIv?, realised? (added to every curve), daysAhead?, ivShift? (vol points),
  //         horizon? (years from now: the main curve, max profit / loss, breakevens and chance of profit are taken on
  //         that date instead of the nearest expiry; legs expired by then count at intrinsic value, the rest by
  //         Black-Scholes; capped at the farthest expiry) }
  function analyse(legs, opts) {
    const spot = opts.spot;
    const realised = opts.realised || 0;
    const dv = (opts.ivShift || 0) / 100;
    const ivx = (l) => Math.max(0.01, l.iv + dv);
    const iv0 = opts.atmIv || (legs.length ? legs.reduce((s, l) => s + l.iv, 0) / legs.length : 0.12);
    const Th = !legs.length
      ? 1 / 365 // horizon: the nearest expiry among the legs, or the chosen date
      : opts.horizon != null
        ? Math.min(opts.horizon, Math.max(...legs.map((l) => l.T)))
        : Math.min(...legs.map((l) => l.T));
    const daysToNear = Th * 365;
    const daysAhead = Math.max(0, Math.min(opts.daysAhead || 0, Math.floor(daysToNear)));
    const valueAt = (x, dt) =>
      realised +
      legs.reduce((s, l) => {
        const t = l.T - dt;
        return s + qty(l) * ((t <= 1e-6 ? intrinsic(l, x) : bs(x, l.strike, t, ivx(l), l.type === 'CE')) - l.entryPx);
      }, 0);
    const atH = (x) => valueAt(x, Th);
    const sd = spot * iv0 * Math.sqrt(Math.max(Th, 0.5 / 365));
    const lo = spot - Math.max(4 * sd, spot * 0.03);
    const hi = spot + Math.max(4 * sd, spot * 0.03);
    const N = 241;
    const xs = Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1));
    const exp = xs.map(atH);
    const t0 = xs.map((x) => valueAt(x, 0));
    const tN = daysAhead > 0 ? xs.map((x) => valueAt(x, Math.min(daysAhead / 365, Th))) : null;
    // Wide grid for max profit / loss, "unlimited" and chance of profit.
    const wide = Array.from({ length: 401 }, (_, i) => spot * (0.5 + i / 400));
    const wv = wide.map(atH);
    const maxP = Math.max(...wv);
    const maxL = Math.min(...wv);
    const edge = (a, b) => Math.abs(a - b) > Math.max(1, Math.abs(maxP - maxL) * 0.002);
    const n = wv.length - 1;
    const unlimP = legs.length > 0 && ((wv[n] === maxP && edge(wv[n], wv[n - 1])) || (wv[0] === maxP && edge(wv[0], wv[1])));
    const unlimL = legs.length > 0 && ((wv[n] === maxL && edge(wv[n], wv[n - 1])) || (wv[0] === maxL && edge(wv[0], wv[1])));
    const be = [];
    for (let i = 1; i < N; i++) if (exp[i - 1] < 0 !== exp[i] < 0) be.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * -exp[i - 1]) / (exp[i] - exp[i - 1]));
    // Chance of finishing in profit at the horizon (lognormal at ATM IV).
    const T = Math.max(Th, 0.3 / 365);
    const cdf = (x) => ncdf(Math.log(x / spot) / (iv0 * Math.sqrt(T)) + (iv0 * Math.sqrt(T)) / 2);
    let pop = 0;
    for (let i = 1; i < wide.length; i++) if ((wv[i] + wv[i - 1]) / 2 > 0) pop += cdf(wide[i]) - cdf(wide[i - 1]);
    const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    const withG = legs.map((l) => {
      const lg = greeks(spot, l.strike, l.T, ivx(l), l.type === 'CE');
      const q = qty(l);
      g.delta += q * lg.delta;
      g.gamma += q * lg.gamma;
      g.theta += q * lg.theta;
      g.vega += q * lg.vega;
      return { ...l, g: lg };
    });
    const credit = -legs.reduce((s, l) => s + qty(l) * l.entryPx, 0);
    const pnlNow = legs.reduce((s, l) => s + qty(l) * ((l.px ?? l.entryPx) - l.entryPx), 0);
    const rr = !unlimP && !unlimL && maxL < 0 && maxP > 0 ? maxP / -maxL : null;
    return {
      legs: withG,
      spot,
      xs,
      exp,
      t0,
      tN,
      daysAhead,
      daysToNear,
      ivShift: opts.ivShift || 0,
      maxP,
      maxL,
      unlimP,
      unlimL,
      be,
      pop,
      sd,
      iv0,
      g,
      credit,
      pnlNow,
      rr,
      capLot: capital(legs, spot, true),
      capSel: capital(legs, spot, false),
    };
  }

  // KPI tiles (the .dep-kpis grid). opts.pnl overrides "P&L now" (the Builder adds realised P&L).
  function kpis(A, opts = {}) {
    if (!A.legs.length) return '';
    const lotsTxt = (() => {
      const s = [...new Set(A.legs.map((l) => l.lots))];
      return s.length === 1 ? `${s[0]} lot${s[0] > 1 ? 's' : ''}` : 'your lots';
    })();
    const pnl = opts.pnl ?? A.pnlNow;
    // Each rupee figure also as a share of the capital at the position's lots (Capital · N lots).
    const pc = (v, signed = true) =>
      A.capSel.total > 0 && isFinite(v)
        ? `<em class="kpi-pct" title="Share of the capital (${inr(A.capSel.total)})">${signed && v > 0 ? '+' : ''}${((v / A.capSel.total) * 100).toFixed(Math.abs(v / A.capSel.total) < 0.1 ? 2 : 1).replace('-', '−')}% of capital</em>`
        : '';
    return `
      <div><span>${A.credit >= 0 ? 'Net credit' : 'Net debit'}</span><b class="${cls(A.credit)}">${inr(Math.abs(A.credit))}</b>${pc(Math.abs(A.credit), false)}</div>
      <div title="Margin blocked for the short legs + premium paid for the long legs, with each leg at 1 lot. Rough estimate (about 9% of notional per naked short, less when covered): check with your broker.&#10;Margin ${inr(A.capLot.margin)} + premium paid ${inr(A.capLot.premium)}"><span>Capital / lot</span><b>${kinr(A.capLot.total)}</b>${pc(A.capLot.total, false)}</div>
      <div title="Same, at the lots in the position.&#10;Margin ${inr(A.capSel.margin)} + premium paid ${inr(A.capSel.premium)}"><span>Capital · ${lotsTxt}</span><b>${kinr(A.capSel.total)}</b>${A.capSel.total > 0 ? `<em class="kpi-pct">margin ${((A.capSel.margin / A.capSel.total) * 100).toFixed(0)}% · premium ${((A.capSel.premium / A.capSel.total) * 100).toFixed(0)}%</em>` : ''}</div>
      <div><span>Max profit</span><b class="pos">${A.unlimP ? 'Unlimited' : inr(A.maxP)}</b>${A.unlimP ? '' : pc(A.maxP)}</div>
      <div><span>Max loss</span><b class="neg">${A.unlimL ? 'Unlimited' : inr(A.maxL)}</b>${A.unlimL ? '' : pc(A.maxL)}</div>
      <div title="Max profit ÷ max loss at expiry"><span>Reward : risk</span><b>${A.rr == null ? '—' : '1 : ' + (1 / A.rr).toFixed(2)}</b></div>
      <div><span>Breakeven</span><b>${A.be.length ? A.be.map((x) => Math.round(x)).join(' · ') : '—'}</b></div>
      <div title="Lognormal model at ATM IV ${(A.iv0 * 100).toFixed(1)}%"><span>Chance of profit</span><b>${(A.pop * 100).toFixed(0)}%</b></div>
      <div title="Position delta in Nifty units"><span>Delta</span><b>${num(A.g.delta, 1)}</b></div>
      <div><span>Theta / day</span><b class="${cls(A.g.theta)}">${inrS(A.g.theta)}</b>${pc(A.g.theta)}</div>
      <div><span>Vega / vol pt</span><b class="${cls(A.g.vega)}">${inrS(A.g.vega)}</b>${pc(A.g.vega)}</div>
      <div><span>Gamma</span><b>${num(A.g.gamma, 3)}</b></div>
      <div><span>P&amp;L now</span><b class="${cls(pnl)}">${inrS(pnl)}</b>${pc(pnl)}</div>${
        A.ivShift
          ? `
      <div title="Curves and Greeks use every leg's IV shifted by this much"><span>IV what-if</span><b>${A.ivShift > 0 ? '+' : ''}${A.ivShift} vol</b></div>`
          : ''
      }`;
  }

  // What-if controls (days ahead, IV shift). Drawn once and then only updated, so a slider keeps working while dragged
  // even though the Builder redraws every few seconds. onChange({ daysAhead, ivShift }) fires as they move.
  function controls(el, A, st, onChange) {
    const max = Math.max(0, Math.floor(A.daysToNear));
    if (!el.querySelector('input')) {
      el.innerHTML = `<label class="muted small" title="Adds a curve for this many days from now, with time decay">Days ahead <input type="range" data-pc="days" min="0" step="1"> <span data-pv="days"></span></label>
        <label class="muted small" title="Shift every leg's implied volatility for the T+0 / T+N curves and the Greeks">IV <input type="range" data-pc="iv" min="-10" max="10" step="1"> <span data-pv="iv"></span></label>
        <button class="btn-sm ghost" data-pc="reset" title="Back to today and the market's IV">Reset</button>`;
      el.addEventListener('input', (e) => {
        const k = e.target.dataset.pc;
        if (k === 'days') st.daysAhead = Number(e.target.value);
        else if (k === 'iv') st.ivShift = Number(e.target.value);
        else return;
        label();
        onChange(st);
      });
      el.addEventListener('click', (e) => {
        if (e.target.dataset.pc === 'reset') {
          st.daysAhead = 0;
          st.ivShift = 0;
          sync();
          onChange(st);
        }
      });
    }
    const days = el.querySelector('[data-pc="days"]');
    const iv = el.querySelector('[data-pc="iv"]');
    function label() {
      el.querySelector('[data-pv="days"]').textContent = st.daysAhead ? `+${st.daysAhead}d` : 'today';
      el.querySelector('[data-pv="iv"]').textContent = st.ivShift ? `${st.ivShift > 0 ? '+' : ''}${st.ivShift}` : '±0';
    }
    function sync() {
      days.max = String(max);
      days.disabled = max === 0;
      if (document.activeElement !== days) days.value = String(Math.min(st.daysAhead || 0, max));
      if (document.activeElement !== iv) iv.value = String(st.ivShift || 0);
      label();
    }
    sync();
  }

  const vline = {
    id: 'payv',
    afterDatasetsDraw(chart, _, o) {
      const { ctx, chartArea: ca, scales } = chart;
      for (const m of o.marks || []) {
        const x = scales.x.getPixelForValue(m.x);
        if (x < ca.left || x > ca.right) continue;
        ctx.save();
        ctx.strokeStyle = m.color;
        ctx.setLineDash(m.dash || []);
        ctx.beginPath();
        ctx.moveTo(x, ca.top);
        ctx.lineTo(x, ca.bottom);
        ctx.stroke();
        ctx.fillStyle = m.color;
        ctx.font = '10px system-ui';
        ctx.fillText(m.label, x + 3, ca.top + 10 + (m.row || 0) * 11);
        ctx.restore();
      }
    },
  };
  // opts: { expiryLabel, horizonLabel (replaces "At expiry" when the main curve is on a chosen date), nowLabel,
  //         levels: { resistance, support } (nearest S/R, optional) }
  function draw(canvas, A, opts = {}) {
    const pts = (ys) => A.xs.map((x, i) => ({ x, y: ys[i] }));
    const has = A.legs.length;
    const ds = has
      ? [
          {
            label: opts.horizonLabel || `At expiry${opts.expiryLabel ? ` (${opts.expiryLabel})` : ''}`,
            data: pts(A.exp),
            borderColor: '#e6edf3',
            borderWidth: 1.8,
            pointRadius: 0,
            fill: { target: 'origin', above: 'rgba(63,182,139,.18)', below: 'rgba(240,113,107,.18)' },
          },
          {
            label: `Now (T+0${opts.nowLabel ? `, ${opts.nowLabel}` : ''})${A.ivShift ? ` IV ${A.ivShift > 0 ? '+' : ''}${A.ivShift}` : ''}`,
            data: pts(A.t0),
            borderColor: '#58a6ff',
            borderWidth: 1.4,
            pointRadius: 0,
            borderDash: [4, 3],
          },
        ]
      : [];
    if (has && A.tN)
      ds.push({ label: `+${A.daysAhead} day${A.daysAhead > 1 ? 's' : ''}`, data: pts(A.tN), borderColor: '#d6af4c', borderWidth: 1.4, pointRadius: 0 });
    const marks = [
      { x: A.spot, label: 'spot', color: '#d6af4c' },
      { x: A.spot - A.sd, label: '−1σ', color: '#8b949e', dash: [2, 3] },
      { x: A.spot + A.sd, label: '+1σ', color: '#8b949e', dash: [2, 3] },
      ...A.be.map((b) => ({ x: b, label: 'BE', color: '#b392f0', dash: [3, 3], row: 1 })),
    ];
    const lv = opts.levels;
    if (lv?.resistance) marks.push({ x: lv.resistance.price, label: `R${lv.resistance.cls === 'major' ? '★' : ''}`, color: '#f0716b', dash: [1, 3], row: 2 });
    if (lv?.support) marks.push({ x: lv.support.price, label: `S${lv.support.cls === 'major' ? '★' : ''}`, color: '#3fb68b', dash: [1, 3], row: 2 });
    BT.chart(canvas, {
      type: 'line',
      data: { datasets: ds },
      plugins: [vline],
      options: {
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (c) => `Nifty ${Math.round(c[0].raw.x)} (${(((c[0].raw.x - A.spot) / A.spot) * 100).toFixed(1)}%)`,
              label: (c) =>
                `${c.dataset.label}: ${inrS(c.raw.y)}${A.capSel.total > 0 ? ` (${c.raw.y > 0 ? '+' : ''}${((c.raw.y / A.capSel.total) * 100).toFixed(1).replace('-', '−')}% of capital)` : ''}`,
            },
          },
          payv: { marks },
        },
        scales: {
          x: { type: 'linear', min: A.xs[0], max: A.xs[A.xs.length - 1], ticks: { callback: (v) => Math.round(v) } },
          y: { ticks: { callback: (v) => kinr(v) } },
        },
      },
    });
  }

  // ---------- concrete position <-> relative strategy ----------
  // Strike step of a chain (smallest gap between listed strikes).
  function strikeStep(ks) {
    let s = Infinity;
    for (let i = 1; i < ks.length; i++) {
      const d = ks[i] - ks[i - 1];
      if (d > 0 && d < s) s = d;
    }
    return isFinite(s) ? s : 50;
  }
  // OTM offset (in strikes) of a strike from the ATM strike at that spot: calls count up, puts count down.
  const atmOffset = (strike, spot, step, type) => Math.round((strike - Math.round(spot / step) * step) / step) * (type === 'CE' ? 1 : -1);
  // Strategy expiry code of a concrete expiry, relative to the position's main expiry. null when it has no code.
  function expiryCode(exp, base, list, monthly, preferMonthly) {
    const isM = (e) => monthly.includes(e);
    if (exp === base) return preferMonthly && isM(base) ? 'mcur' : 'cur';
    const later = list.filter((e) => e >= base);
    if (later.indexOf(exp) === 1) return 'next';
    const ms = later.filter(isM);
    if (ms[0] === exp) return 'mcur';
    if (ms[1] === exp) return 'mnext';
    return null;
  }

  BT.payoff = { analyse, kpis, controls, draw, greeks, capital };
  Object.assign(BT, { strikeStep, atmOffset, expiryCode });
})();
