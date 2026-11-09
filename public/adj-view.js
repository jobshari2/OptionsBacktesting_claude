// Trading Ideas › Adjustments (lib/adjladder.js, bt/adjust.js, /api/adj/*): Michael Catolico's "Trade adjustment
// basics" (2007) explained and turned into rules for Nifty options. Three tabs: the PDF section by section with its
// dollar examples redone in Nifty; an animated simulation of the rules on a live expiry (Black-Scholes at each
// strike's implied volatility taken from that expiry's chain); and a backtest on the option history whose series
// replay with the same animation. Models and history only: nothing here places orders.
(() => {
  const { $, esc, inr, inrS, kinr, cls, dayLabel } = BT;
  const AL = window.AdjLadder;
  const TABS = [
    ['guide', 'The PDF, explained'],
    ['sim', 'Simulate: current expiry'],
    ['bt', 'Backtest'],
  ];
  const SCEN = [
    ['rally', 'Rally', 'Nifty climbs steadily: the winning side of the tree (vertical → fly → condor)'],
    ['fall', 'Fall', 'Nifty slides steadily: the losing side (ratio → fly rolls → close)'],
    ['zigzag', 'Zigzag', 'Up, down and up again: the path the PDF says markets usually take'],
    ['chop', 'Sideways', 'Small moves inside the band: no trigger, time decay works on the position'],
    ['random', 'Random walk', 'A random path at the chain’s implied volatility (change the seed for another)'],
    ['manual', 'Manual ▲▼', 'You move Nifty one check at a time'],
  ];
  const CHECKS = { hourly: [60, 120, 180, 240, 300, 360], daily: [345], weekly: [345] };
  const FRAME_TXT = { hourly: 'hour', daily: 'day', weekly: 'week' };
  const YEAR_MS = 365 * 86400_000;
  const reduced = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  let tab = BT.store.get('adj-tab', 'guide');
  if (!TABS.some(([id]) => id === tab)) tab = 'guide';
  let meta = null;
  let metaErr = '';
  let params = null;
  let started = false;
  let mk = null; // the chain the simulation and the guide's Nifty numbers use
  let mkErr = '';
  let simExpiry = BT.store.get('adj-exp', null);
  let scen = BT.store.get('adj-scen', 'rally');
  let seed = BT.store.get('adj-seed', 7);
  let manual = []; // Manual mode: 'up' | 'down' | 'flat' per check
  let saved = null;
  let job = null;
  let openRow = null;
  const players = new Set();

  // ---------- small helpers ----------
  const n0 = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
  const lot = () => meta?.lot || 65;
  const usd = (v, signed) =>
    v == null || !isFinite(v)
      ? '—'
      : `${signed && v > 0 ? '+' : ''}${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 0 })}`;
  const money = (cur, v, signed = false) => (cur === 'usd' ? usd(v, signed) : signed ? inrS(Math.round(v)) : inr(Math.round(v)));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  let uid = 0;
  function tween(owner, ms, fn) {
    const id = (owner._tw = (owner._tw || 0) + 1);
    return new Promise((res) => {
      if (reduced || ms <= 0 || document.hidden) {
        fn(1);
        return res();
      }
      const t0 = performance.now();
      const tick = (now) => {
        if (owner._tw !== id) return res();
        const t = Math.min(1, (now - t0) / ms);
        fn(ease(t));
        if (t < 1) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
  }
  function ticks(a, b, n = 5) {
    const span = b - a || 1;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const istNow = () => {
    const d = new Date(Date.now() + 5.5 * 3600e3);
    return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() - 555 };
  };
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const isWeekday = (d) => {
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    return w > 0 && w < 6;
  };
  const wdLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const hhmm = (m) => {
    const t = 555 + m;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const yearsLeft = (d, m, E) => Math.max(0, (Date.parse(E + 'T15:30:00Z') - (Date.parse(d + 'T09:15:00Z') + m * 60000)) / YEAR_MS);
  // When a trade entered now starts: now during the session, else 09:30 on the next weekday.
  function entryPoint() {
    const { day, min } = istNow();
    if (isWeekday(day) && min < 345) return { day, min: Math.max(15, min) };
    let d = addDays(day, 1);
    while (!isWeekday(d)) d = addDays(d, 1);
    return { day: d, min: 15 };
  }
  function tradingDays(expiry) {
    let n = 0;
    for (let d = entryPoint().day; d <= expiry; d = addDays(d, 1)) if (isWeekday(d)) n++;
    return n;
  }
  const legName = (l, cur = 'inr') => `${l.lots > 0 ? '+' : '−'}${Math.abs(l.lots)} ${cur === 'usd' ? l.strike : n0(l.strike)}${l.type === 'CE' ? 'C' : 'P'}`;
  const legsLine = (legs, cur) => (legs.length ? legs.map((l) => legName(l, cur)).join(' / ') : 'nothing open');
  const tradeLine = (t, cur) =>
    `${t.lots > 0 ? 'Buy' : 'Sell'} ${Math.abs(t.lots)}× ${cur === 'usd' ? t.strike : n0(t.strike)} ${t.type === 'CE' ? 'call' : 'put'}${t.px != null ? ` @ ${cur === 'usd' ? '$' + t.px.toFixed(2) : t.px.toFixed(1)}` : ''}`;
  // the most a position can make / lose at expiry, and whether a side is open-ended
  function riskOf(legs, c, L) {
    if (!legs.length) return { worst: c, best: c, openLoss: null, openGain: null };
    const ks = legs.map((l) => l.strike);
    const lo = Math.min(...ks);
    const hi = Math.max(...ks);
    const callNet = legs.filter((l) => l.type === 'CE').reduce((s, l) => s + l.lots, 0);
    const putNet = legs.filter((l) => l.type === 'PE').reduce((s, l) => s + l.lots, 0);
    const vals = [Math.max(0, lo - (hi - lo) - 1), ...ks, hi + (hi - lo) + 1].map((x) => AL.atExpiry(legs, x, c, L));
    return {
      worst: Math.min(...vals),
      best: Math.max(...vals),
      openLoss: callNet < 0 ? 'rally' : putNet < 0 ? 'fall' : null,
      openGain: callNet > 0 ? 'rally' : putNet > 0 ? 'fall' : null,
    };
  }
  // Books a fill into a list of open legs (signed lots): averages the price when adding, keeps it when reducing,
  // the new price when the leg flips side. Returns the list without empty legs, lowest strike first.
  function addFill(legs, type, strike, lots, px) {
    const l = legs.find((x) => x.type === type && x.strike === strike);
    if (!l) legs.push({ type, strike, lots, entry: px });
    else if (Math.sign(l.lots) === Math.sign(lots)) {
      l.entry = (l.entry * Math.abs(l.lots) + px * Math.abs(lots)) / (Math.abs(l.lots) + Math.abs(lots));
      l.lots += lots;
    } else {
      const left = l.lots + lots;
      if (left && Math.sign(left) !== Math.sign(l.lots)) l.entry = px;
      l.lots = left;
    }
    return legs.filter((x) => x.lots).sort((a, b) => a.strike - b.strike || (a.type < b.type ? -1 : 1));
  }
  const sameLegs = (a, b) => JSON.stringify(a.map((l) => [l.type, l.strike, l.lots])) === JSON.stringify(b.map((l) => [l.type, l.strike, l.lots]));
  const DECISION = new Set(['entry', 'adjust', 'hold', 'close', 'stop', 'target']);

  // ---------- payoff chart (SVG, morphs between positions) ----------
  function payoffChart(svg, o = {}) {
    const W = o.w || 720;
    const H = o.h || 300;
    const ml = o.small ? 50 : 66;
    const mr = 12;
    const mt = 22;
    const mb = o.small ? 24 : 32;
    const N = o.small ? 90 : 150;
    const clip = 'adjclip' + ++uid;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('adj-svg', 'adj-paysvg');
    svg.innerHTML = `<defs><clipPath id="${clip}"><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}"></rect></clipPath></defs>
      <g class="ax"></g><rect class="band" visibility="hidden"></rect><text class="band-l" visibility="hidden"></text>
      <g clip-path="url(#${clip})"><g class="ghosts"></g><path class="area pos"></path><path class="area neg"></path><path class="today"></path><path class="curve"></path></g>
      <g class="marks"></g><g class="pmark" visibility="hidden"><line></line><circle r="4"></circle><text></text></g>`;
    const q = (s) => svg.querySelector(s);
    const st = { dom: null, ys: null, yt: null, S: null, band: null };
    let xs = [];
    const sx = (x) => ml + ((x - st.dom.x0) / (st.dom.x1 - st.dom.x0)) * (W - ml - mr);
    const sy = (y) => mt + (1 - (y - st.dom.y0) / (st.dom.y1 - st.dom.y0)) * (H - mt - mb);
    const fmtY = (v) => (o.cur === 'usd' ? usd(v) : kinr(v));
    function axes() {
      const d = st.dom;
      const yt = ticks(d.y0, d.y1, o.small ? 4 : 6);
      const xt = ticks(d.x0, d.x1, o.small ? 4 : 7);
      q('.ax').innerHTML =
        yt
          .map(
            (v) =>
              `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${sy(v)}" y2="${sy(v)}"></line><text class="yl" x="${ml - 6}" y="${sy(v) + 3.5}">${esc(fmtY(v))}</text>`,
          )
          .join('') +
        xt
          .map(
            (v) =>
              `<line class="grid" x1="${sx(v)}" x2="${sx(v)}" y1="${mt}" y2="${H - mb}"></line><text class="xl" x="${sx(v)}" y="${H - mb + 14}">${o.cur === 'usd' ? v : n0(v)}</text>`,
          )
          .join('') +
        (d.y0 < 0 && d.y1 > 0 ? `<line class="zero" x1="${ml}" x2="${W - mr}" y1="${sy(0)}" y2="${sy(0)}"></line>` : '') +
        (o.small ? '' : `<text class="axt" x="${W - mr}" y="${H - 3}">${o.cur === 'usd' ? 'Stock at expiry ($)' : 'Nifty at expiry'}</text>`);
    }
    function setDomain(d) {
      st.dom = { ...d };
      xs = Array.from({ length: N + 1 }, (_, i) => d.x0 + ((d.x1 - d.x0) * i) / N);
      axes();
    }
    const linePath = (ys) => ys.map((y, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(y).toFixed(1)}`).join('');
    function areaPath(ys, sign) {
      const z = sy(0).toFixed(1);
      let s = `M${sx(xs[0]).toFixed(1)},${z}`;
      ys.forEach((y, i) => (s += `L${sx(xs[i]).toFixed(1)},${sy(sign > 0 ? Math.max(0, y) : Math.min(0, y)).toFixed(1)}`));
      return s + `L${sx(xs[N]).toFixed(1)},${z}Z`;
    }
    function curvesOf(fr) {
      const legs = fr.drawLegs || fr.legs;
      const c = (fr.drawCash ?? fr.cash) - (fr.drawCosts ?? fr.costs);
      const ys = xs.map((x) => AL.atExpiry(legs, x, c, o.lot));
      let yt = null;
      if (o.today && fr.T > 1e-4 && legs.length)
        yt = xs.map((x) => c + legs.reduce((s, l) => s + l.lots * o.lot * AL.bs(x, l.strike, fr.T, o.ivOf(l), l.type === 'CE'), 0));
      return { ys, yt };
    }
    function paint() {
      q('.curve').setAttribute('d', st.ys ? linePath(st.ys) : '');
      q('.area.pos').setAttribute('d', st.ys ? areaPath(st.ys, 1) : '');
      q('.area.neg').setAttribute('d', st.ys ? areaPath(st.ys, -1) : '');
      q('.today').setAttribute('d', st.yt ? linePath(st.yt) : '');
      const b = q('.band');
      const bl = q('.band-l');
      if (st.band && st.band[1] > st.band[0]) {
        const x0 = sx(Math.max(st.dom.x0, st.band[0]));
        const x1 = sx(Math.min(st.dom.x1, st.band[1]));
        b.setAttribute('visibility', x1 > x0 ? 'visible' : 'hidden');
        b.setAttribute('x', x0);
        b.setAttribute('width', Math.max(0, x1 - x0));
        b.setAttribute('y', mt);
        b.setAttribute('height', H - mt - mb);
        bl.setAttribute('visibility', x1 - x0 > 70 ? 'visible' : 'hidden');
        bl.setAttribute('x', (x0 + x1) / 2);
        bl.setAttribute('y', H - mb - 6);
        bl.textContent = 'no-adjustment band';
      } else {
        b.setAttribute('visibility', 'hidden');
        bl.setAttribute('visibility', 'hidden');
      }
      const pm = q('.pmark');
      if (st.S != null && st.S >= st.dom.x0 && st.S <= st.dom.x1) {
        const x = sx(st.S);
        pm.setAttribute('visibility', 'visible');
        const ln = pm.querySelector('line');
        ln.setAttribute('x1', x);
        ln.setAttribute('x2', x);
        ln.setAttribute('y1', mt);
        ln.setAttribute('y2', H - mb);
        // the dot sits on the expiry curve
        const i = Math.max(0, Math.min(N, Math.round(((st.S - st.dom.x0) / (st.dom.x1 - st.dom.x0)) * N)));
        const yv = st.ys ? st.ys[i] : 0;
        const c = pm.querySelector('circle');
        c.setAttribute('cx', x);
        c.setAttribute('cy', Math.max(mt, Math.min(H - mb, sy(yv))));
        const t = pm.querySelector('text');
        t.setAttribute('x', Math.max(ml + 40, Math.min(W - mr - 40, x)));
        t.setAttribute('y', mt - 7);
        t.textContent = `${o.cur === 'usd' ? 'Stock' : 'Nifty'} ${o.cur === 'usd' ? st.S.toFixed(2) : n0(st.S)}`;
      } else pm.setAttribute('visibility', 'hidden');
    }
    function marks(fr) {
      const legs = fr.drawLegs || fr.legs;
      const seenK = new Map(); // legs at the same strike (a box's call and put) stack upwards
      q('.marks').innerHTML = legs
        .filter((l) => l.strike >= st.dom.x0 && l.strike <= st.dom.x1)
        .map((l) => {
          const j = seenK.get(l.strike) || 0;
          seenK.set(l.strike, j + 1);
          const x = sx(l.strike);
          const y = H - mb - j * 22;
          const tri = l.lots > 0 ? `M${x - 5},${y}L${x + 5},${y}L${x},${y - 8}Z` : `M${x - 5},${y - 8}L${x + 5},${y - 8}L${x},${y}Z`;
          const both = legs.some((m) => m.type !== l.type);
          return `<path class="${l.lots > 0 ? 'mk-b' : 'mk-s'}" d="${tri}"><title>${esc(legName(l, o.cur))}</title></path><text class="mk-t ${l.lots > 0 ? 'mk-b' : 'mk-s'}" x="${x}" y="${y - 11}">${l.lots > 0 ? '+' : '−'}${Math.abs(l.lots)}${both ? (l.type === 'CE' ? 'C' : 'P') : ''}</text>`;
        })
        .join('');
    }
    function ghosts(list) {
      q('.ghosts').innerHTML = list
        .map((g, i) => {
          const { ys } = curvesOf(g);
          return `<path class="ghost" style="opacity:${(0.25 + (0.45 * (i + 1)) / list.length).toFixed(2)}" d="${linePath(ys)}"></path>`;
        })
        .join('');
    }
    function domainFor(frames, xr) {
      setDomain({ x0: xr[0], x1: xr[1], y0: -1, y1: 1 });
      let lo = 0;
      let hi = 0;
      for (const fr of frames) {
        const { ys, yt } = curvesOf(fr);
        for (const v of ys) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
        if (yt) for (const v of yt) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
      }
      const pad = (hi - lo || 1) * 0.12;
      return { x0: xr[0], x1: xr[1], y0: lo - pad, y1: hi + pad };
    }
    // Move to frame fr: curves, the Nifty marker, the no-adjustment band and (if given) the domain glide there.
    function to(fr, { ms = 0, dom = null, ghostList = [] } = {}) {
      const from = { ...st, dom: { ...st.dom } };
      if (dom) setDomain(dom);
      const nx = curvesOf(fr);
      const band = fr.trig > 0 && fr.nextRef != null ? [fr.nextRef - fr.nextTrig, fr.nextRef + fr.nextTrig] : null;
      ghosts(ghostList);
      marks(fr);
      if (!from.ys || ms <= 0) {
        Object.assign(st, { ys: nx.ys, yt: nx.yt, S: fr.S, band });
        paint();
        return Promise.resolve();
      }
      const a = { ys: from.ys, yt: from.yt || nx.yt, S: from.S ?? fr.S, band: from.band || band };
      const d0 = from.dom;
      const d1 = { ...st.dom };
      return tween(svg, ms, (t) => {
        if (dom) {
          st.dom = { x0: lerp(d0.x0, d1.x0, t), x1: lerp(d0.x1, d1.x1, t), y0: lerp(d0.y0, d1.y0, t), y1: lerp(d0.y1, d1.y1, t) };
          axes();
        }
        st.ys = nx.ys.map((y, i) => lerp(a.ys[i], y, t));
        st.yt = nx.yt && a.yt ? nx.yt.map((y, i) => lerp(a.yt[i], y, t)) : nx.yt;
        st.S = lerp(a.S, fr.S, t);
        st.band = band && a.band ? [lerp(a.band[0], band[0], t), lerp(a.band[1], band[1], t)] : band;
        paint();
      });
    }
    return {
      setDomain,
      domainFor,
      to,
      get dom() {
        return st.dom;
      },
    };
  }

  // ---------- decision tree (SVG): the PDF's tree, the path taken lit up ----------
  const PDF_TREE = {
    nodes: [
      [0, 0, 'Long call'],
      [1, 1, 'Vertical'],
      [1, -1, 'Ratio'],
      [2, 2, 'Fly'],
      [2, 0, 'Long call'],
      [2, -2, 'Fly roll (ratio)'],
      [3, 3, 'Fly roll (condor)'],
      [3, 1, 'Vertical'],
      [3, -1, 'Reverse fly roll (ratio)'],
      [3, -3, 'Fly roll (open condor ratio)'],
    ],
    edges: [
      [0, 0, 1, 1],
      [0, 0, 1, -1],
      [1, 1, 2, 2],
      [1, 1, 2, 0],
      [1, -1, 2, 0],
      [1, -1, 2, -2],
      [2, 2, 3, 3],
      [2, 2, 3, 1],
      [2, 0, 3, 1],
      [2, 0, 3, -1],
      [2, -2, 3, -1],
      [2, -2, 3, -3],
    ],
  };
  const SHORT_NAME = { '-3': 'Fly roll ×2', '-2': 'Fly roll', '-1': 'Ratio', 0: 'Long', 1: 'Vertical', 2: 'Fly', 3: 'Condor' };
  const shortName = (lv, bias) =>
    lv === 0 ? (bias === 'bear' ? 'Long put' : 'Long call') : SHORT_NAME[lv] || (lv > 0 ? `Roll ×${lv - 2}` : `Roll ×${-lv - 1}`);
  function treeChart(svg, o = {}) {
    const W = o.w || 520;
    const H = o.h || 280;
    const top = Math.max(3, o.maxUp || 3);
    const bot = Math.max(3, o.maxDown || 3);
    const rowH = (H - 16) / (top + bot + 1);
    const y = (lv) => 8 + (top - lv + 0.5) * rowH;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('adj-svg', 'adj-treesvg');
    function label(text, x, yy, bw, cl) {
      const parts = o.full && text.length > 14 && text.includes(' (') ? [text.slice(0, text.indexOf(' (')), text.slice(text.indexOf(' (') + 1)] : [text];
      const bh = parts.length > 1 ? 30 : o.full ? 22 : 18;
      return `<g class="${cl}"><rect x="${x - bw / 2}" y="${yy - bh / 2}" width="${bw}" height="${bh}" rx="5"></rect>${parts
        .map((p, i) => `<text x="${x}" y="${yy + (parts.length > 1 ? (i ? 10 : -3) : 3.5)}">${esc(p)}</text>`)
        .join('')}</g>`;
    }
    // dec: [{ level, dir, kind }] — the entry and every decision after it
    function draw(dec, { animate = false, ms = 600 } = {}) {
      const n = dec.length;
      const cols = Math.max(4, n);
      const vis = Math.min(cols, o.full ? 4 : 7);
      const c0 = Math.max(0, cols - vis);
      const pad = o.full ? 66 : 40;
      const colW = (W - 2 * pad) / (vis - 1);
      const x = (c) => pad + (c - c0) * colW;
      const bw = Math.min(colW - 10, o.full ? 128 : 70);
      const nm = (c, lv, pdf) => (o.full && pdf ? pdf.replace('call', o.bias === 'bear' ? 'put' : 'call') : shortName(lv, o.bias));
      let s = '';
      if (c0 === 0) {
        for (const [a, la, b, lb] of PDF_TREE.edges)
          s += `<line class="te" x1="${x(a) + bw / 2}" y1="${y(la)}" x2="${x(b) - bw / 2}" y2="${y(lb)}"></line><text class="tsg" x="${(x(a) + x(b)) / 2}" y="${(y(la) + y(lb)) / 2 - 3}">${lb > la ? '+' : '−'}</text>`;
        for (const [c, lv, t] of PDF_TREE.nodes) s += label(nm(c, lv, t), x(c), y(lv), bw, 'tn');
      }
      for (let i = Math.max(1, c0); i < n; i++) {
        const a = dec[i - 1];
        const b = dec[i];
        const cl = `pe${i === n - 1 && animate ? ' new' : ''}${b.dir > 0 ? ' up' : b.dir < 0 ? ' dn' : ''}`;
        s += `<line class="${cl}" x1="${x(i - 1) + bw / 2}" y1="${y(a.level)}" x2="${x(i) - bw / 2}" y2="${y(b.level)}"></line>`;
      }
      for (let i = c0; i < n; i++) {
        const d = dec[i];
        const pdf = PDF_TREE.nodes.find(([c, lv]) => c === i && lv === d.level)?.[2];
        const t = d.kind === 'close' || d.kind === 'stop' || d.kind === 'target' ? '✕ Closed' : nm(i, d.level, pdf);
        s += label(
          t,
          x(i),
          y(d.level),
          bw,
          `pn${i === n - 1 ? ' cur' : ''}${i === n - 1 && animate ? ' pop' : ''}${d.kind === 'close' || d.kind === 'stop' ? ' closed' : ''}${d.kind === 'hold' ? ' held' : ''}`,
        );
      }
      if (c0 > 0) s += `<text class="tmore" x="8" y="${H / 2}">…</text>`;
      svg.innerHTML = s;
      if (animate && !reduced) {
        const e = svg.querySelector('.pe.new');
        if (e) {
          const len = e.getTotalLength();
          e.style.strokeDasharray = len;
          e.style.strokeDashoffset = len;
          e.getBoundingClientRect();
          e.style.transition = `stroke-dashoffset ${ms}ms ease`;
          e.style.strokeDashoffset = 0;
        }
      }
    }
    return { draw };
  }
  // The ladder underneath: the same tree flattened, a token slides along it.
  function ladderHtml(o) {
    const out = [];
    for (let lv = -o.maxDown; lv <= o.maxUp; lv++)
      out.push(`<div class="rung${lv === 0 ? ' home' : ''}" data-l="${lv}" title="${esc(AL.nodeName(lv, o.bias))}">${esc(shortName(lv, o.bias))}</div>`);
    return `<div class="adj-ladder"><span class="end">− against</span>${out.join('')}<span class="end">+ your way</span><div class="tok"></div></div>`;
  }
  function ladderSet(el, level, seen) {
    if (!el) return;
    el.querySelectorAll('.rung').forEach((r) => {
      const lv = Number(r.dataset.l);
      r.classList.toggle('on', lv === level);
      r.classList.toggle('seen', seen.has(lv));
    });
    const r = el.querySelector(`.rung[data-l="${level}"]`);
    const tok = el.querySelector('.tok');
    if (r && tok) {
      tok.style.width = r.offsetWidth + 'px';
      tok.style.transform = `translateX(${r.offsetLeft}px)`;
    }
  }

  // ---------- Nifty path with the trigger band ----------
  function pathChart(svg, o = {}) {
    const W = 720;
    const H = 210;
    const ml = 58;
    const mr = 74;
    const mt = 12;
    const mb = 26;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('adj-svg', 'adj-pathsvg');
    let F = [];
    let dom = null;
    const sx = (i) => ml + (i / Math.max(1, F.length - 1)) * (W - ml - mr);
    const sy = (v) => mt + (1 - (v - dom.y0) / (dom.y1 - dom.y0)) * (H - mt - mb);
    function load(frames) {
      F = frames;
      let lo = Infinity;
      let hi = -Infinity;
      for (const f of F) {
        lo = Math.min(lo, f.S, f.trig > 0 ? f.ref - f.trig : f.S);
        hi = Math.max(hi, f.S, f.trig > 0 ? f.ref + f.trig : f.S);
      }
      const pad = (hi - lo || 100) * 0.08;
      dom = { y0: lo - pad, y1: hi + pad };
    }
    function draw(i, frac = 1) {
      if (!F.length) return;
      let s = '';
      for (const v of ticks(dom.y0, dom.y1, 4))
        s += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${sy(v)}" y2="${sy(v)}"></line><text class="yl" x="${ml - 6}" y="${sy(v) + 3.5}">${n0(v)}</text>`;
      let lastDay = null;
      let lastX = -Infinity;
      F.forEach((f, j) => {
        if (f.day === lastDay) return;
        lastDay = f.day;
        const x = sx(j);
        s += `<line class="gridx" x1="${x}" x2="${x}" y1="${mt}" y2="${H - mb}"></line>`;
        // a day label only where there is room for it (about 60 px)
        if (x - lastX >= 60 && x <= W - mr - 30) {
          s += `<text class="xl l" x="${x + 2}" y="${H - mb + 14}">${esc(wdLabel(f.day).replace(',', ''))}</text>`;
          lastX = x;
        }
      });
      // the no-adjustment band each check was judged against
      for (let j = 1; j <= i; j++) {
        const f = F[j];
        if (!(f.trig > 0)) continue;
        const x0 = sx(j - 1);
        const x1 = sx(j - 1 + (j === i ? frac : 1));
        s += `<rect class="bandr" x="${x0}" width="${Math.max(0, x1 - x0)}" y="${sy(f.ref + f.trig)}" height="${Math.max(0, sy(f.ref - f.trig) - sy(f.ref + f.trig))}"></rect><line class="refl" x1="${x0}" x2="${x1}" y1="${sy(f.ref)}" y2="${sy(f.ref)}"></line>`;
      }
      // open strikes of the position now
      const legs = F[i].drawLegs || F[i].legs;
      for (const l of legs) {
        if (l.strike < dom.y0 || l.strike > dom.y1) continue;
        s += `<line class="kline ${l.lots > 0 ? 'b' : 's'}" x1="${ml}" x2="${W - mr}" y1="${sy(l.strike)}" y2="${sy(l.strike)}"></line><text class="kl ${l.lots > 0 ? 'b' : 's'}" x="${W - mr + 4}" y="${sy(l.strike) + 3.5}">${legName(l)}</text>`;
      }
      const pts = F.slice(0, i + 1).map((f, j) => [sx(j), sy(f.S)]);
      if (i > 0 && frac < 1) {
        const [px, py] = pts[i - 1];
        pts[i] = [lerp(px, sx(i), frac), lerp(py, sy(F[i].S), frac)];
      }
      s += `<polyline class="pline" points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"></polyline>`;
      for (let j = 0; j <= i; j++) {
        const f = F[j];
        if (j === i && frac < 1) break;
        if (!DECISION.has(f.kind) && f.kind !== 'skip') continue;
        const [x, yy] = [sx(j), sy(f.S)];
        if (f.kind === 'entry') s += `<circle class="ev entry" cx="${x}" cy="${yy}" r="5"><title>Entry</title></circle>`;
        else if (f.kind === 'adjust')
          s += `<path class="ev ${f.stall ? 'stall' : f.dir * (o.bias === 'bear' ? -1 : 1) > 0 ? 'up' : 'dn'}" d="${f.S >= f.ref ? `M${x - 6},${yy + 5}L${x + 6},${yy + 5}L${x},${yy - 6}Z` : `M${x - 6},${yy - 5}L${x + 6},${yy - 5}L${x},${yy + 6}Z`}"><title>${esc(f.text || '')}</title></path>`;
        else s += `<rect class="ev ${f.kind}" x="${x - 4.5}" y="${yy - 4.5}" width="9" height="9"><title>${esc(f.text || '')}</title></rect>`;
      }
      const [cx, cy] = pts[pts.length - 1];
      s += `<circle class="pdot" cx="${cx}" cy="${cy}" r="4.5"></circle>`;
      svg.innerHTML = s;
    }
    function to(i, ms) {
      return tween(svg, ms, (t) => draw(i, t));
    }
    return { load, draw, to };
  }

  // ---------- the player: payoff + tree + path + position + log, frame by frame ----------
  // A frame: { day, min, label?, S, ref, trig, nextRef, nextTrig, T, kind, dir, from, to, text, trades, level, legs (signed),
  // cash, costs, drawLegs/drawCash/drawCosts (what to draw when the legs were just settled), mtm, base, final }.
  function makePlayer(root, o) {
    root.classList.add('adj-player');
    const speed0 = BT.store.get('adj-speed', 1);
    root.innerHTML = `
      <div class="adj-ctrl">
        <button class="btn-sm ghost" data-c="first" title="Back to the start">⏮</button>
        <button class="btn-sm ghost" data-c="prev" title="One step back">◀</button>
        <button class="btn-sm adj-play" data-c="play">▶ Play</button>
        <button class="btn-sm ghost" data-c="next" title="One step forward">▶|</button>
        <button class="btn-sm ghost" data-c="last" title="Jump to the end">⏭</button>
        <span class="seg sm adj-speed" title="Animation speed">${[0.5, 1, 2, 4].map((s) => `<button data-s="${s}" class="${s === speed0 ? 'on' : ''}">${s}×</button>`).join('')}</span>
        <span class="adj-clock small"></span>
        <span class="spacer"></span>${o.extraCtrl || ''}
      </div>
      <div class="adj-progress"><div></div></div>
      <div class="adj-grid${o.tree === false ? ' no-tree' : ''}">
        <div class="adj-box adj-paybox"><div class="adj-h">${o.cur === 'usd' ? 'Profit / loss at expiry, per contract (100 shares)' : `Profit / loss at expiry (₹, ${o.lotLabel || 'lot of ' + o.lot})`}<span class="adj-legend"></span></div><svg class="adj-pay"></svg><div class="adj-callouts"></div></div>
        ${
          o.tree === false
            ? ''
            : `<div class="adj-box adj-treebox"><div class="adj-h">Decision tree <span class="muted small">— the path taken (+ = Nifty moved your way)</span></div><svg class="adj-tree"></svg><div class="adj-ladder-wrap">${ladderHtml(o)}</div></div>`
        }
        ${o.path === false ? '' : `<div class="adj-box adj-pathbox"><div class="adj-h">Nifty and the trigger band <span class="muted small">— inside the shaded band is noise; a check outside it is a decision point</span></div><svg class="adj-path"></svg></div>`}
        <div class="adj-box adj-posbox"><div class="adj-h">Position <span class="adj-node"></span></div><div class="adj-kpis"></div><div class="adj-legs"></div></div>
      </div>
      <div class="adj-box adj-logbox"><div class="adj-h">What happened <span class="muted small">— newest first</span></div><ol class="adj-log"></ol></div>`;
    const q = (s) => root.querySelector(s);
    const pay = payoffChart(q('.adj-pay'), { lot: o.lot, cur: o.cur, today: o.today !== false, ivOf: o.ivOf || (() => 0.13) });
    const tree = o.tree === false ? null : treeChart(q('.adj-tree'), { maxUp: o.maxUp, maxDown: o.maxDown, bias: o.bias });
    const path = o.path === false ? null : pathChart(q('.adj-path'), { bias: o.bias });
    const P = { frames: [], i: -1, playing: false, speed: speed0, alive: true };

    function xRange(frames) {
      const xs = [];
      for (const f of frames) {
        for (const l of f.drawLegs || f.legs) xs.push(l.strike);
        xs.push(f.S);
      }
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      const w = o.W || (hi - lo) / 4 || 100;
      return [lo - w * 1.2, hi + w * 1.2];
    }
    function load(frames, { at = 0 } = {}) {
      P.frames = frames;
      pause();
      const dom = pay.domainFor(frames, xRange(frames));
      pay.setDomain(dom);
      path?.load(frames);
      P.i = -1;
      show(Math.min(at, frames.length - 1), false);
    }
    const decisionsUpTo = (i) =>
      P.frames
        .slice(0, i + 1)
        .filter((f) => DECISION.has(f.kind))
        .map((f) => ({ level: f.kind === 'adjust' ? f.to : f.level, dir: f.dir || 0, kind: f.kind }));
    function ghostsUpTo(i) {
      const out = [];
      let last = null;
      for (let j = 0; j < i; j++) {
        const f = P.frames[j];
        const legs = f.drawLegs || f.legs;
        if (!legs.length) continue;
        if (last && sameLegs(legs, last.drawLegs || last.legs) && (f.drawCash ?? f.cash) === (last.drawCash ?? last.cash)) continue;
        out.push(f);
        last = f;
      }
      const cur = P.frames[i];
      const curLegs = cur.drawLegs || cur.legs;
      return out.filter((f) => !(sameLegs(f.drawLegs || f.legs, curLegs) && (f.drawCash ?? f.cash) === (cur.drawCash ?? cur.cash))).slice(-3);
    }
    function lastPositionBefore(i) {
      const cur = P.frames[i];
      for (let j = i - 1; j >= 0; j--) {
        const f = P.frames[j];
        if (!sameLegs(f.drawLegs || f.legs, cur.drawLegs || cur.legs) || (f.drawCash ?? f.cash) !== (cur.drawCash ?? cur.cash)) return f;
      }
      return null;
    }
    function callouts(fr, prev) {
      const el = q('.adj-callouts');
      if (!prev || !fr.trades?.length || fr.kind === 'expiry') {
        el.innerHTML = '';
        return;
      }
      const L = o.lot;
      const net = (f) => -((f.drawCash ?? f.cash) - (f.drawCosts ?? f.costs)); // + debit paid, − credit in hand
      const a = net(prev);
      const b = net(fr);
      const out = [];
      if (fr.kind === 'close' || fr.kind === 'stop' || fr.kind === 'target') {
        el.innerHTML = `<div class="adj-co ${cls(fr.final)}"><b>Closed</b><span>booked ${esc(money(o.cur, fr.final ?? 0, true))}</span></div>`;
        return;
      }
      const nt = (v) => (v < 0 ? `${money(o.cur, -v)} credit` : `${money(o.cur, v)} paid`);
      if (b <= 0 && a > 0) out.push(['Trade becomes a credit', `${money(o.cur, -b)} in hand`, 'pos']);
      else if (b < a) out.push(['Cost basis shrinks', `${nt(a)} → ${nt(b)}`, 'pos']);
      else if (b > a) out.push(['Cost basis increases', `${nt(a)} → ${nt(b)}`, 'neg']);
      if (fr.legs.length && prev.legs.length) {
        const peak = (f) => {
          const legs = f.drawLegs || f.legs;
          const ks = [...new Set(legs.map((l) => l.strike))];
          let best = -Infinity;
          let at = [];
          for (const k of ks) {
            const v = AL.atExpiry(legs, k, 0, L);
            if (v > best + 1e-6) ((best = v), (at = [k]));
            else if (Math.abs(v - best) < 1e-6) at.push(k);
          }
          return at.reduce((s, k) => s + k, 0) / at.length;
        };
        const pa = peak(prev);
        const pb = peak(fr);
        if (Math.abs(pb - pa) > 1e-6) out.push([`Profit zone shifts ${pb > pa ? '→' : '←'}`, `peak near ${o.cur === 'usd' ? pb.toFixed(0) : n0(pb)}`, '']);
        const ra = riskOf(prev.legs, (prev.cash ?? 0) - (prev.costs ?? 0), L);
        const rb = riskOf(fr.legs, fr.cash - fr.costs, L);
        if (rb.openLoss && !ra.openLoss) out.push(['Risk now open-ended', `on a ${rb.openLoss}: one sold option uncovered`, 'neg']);
        else if (!rb.openLoss && !ra.openLoss && Math.round(rb.worst) !== Math.round(ra.worst))
          out.push(['Worst at expiry', `${money(o.cur, ra.worst, true)} → ${money(o.cur, rb.worst, true)}`, rb.worst > ra.worst ? 'pos' : 'neg']);
      }
      el.innerHTML = out.map(([h, t, c]) => `<div class="adj-co ${c}"><b>${esc(h)}</b><span>${esc(t)}</span></div>`).join('');
    }
    function legsTable(fr, prev) {
      const L = o.lot;
      const legs = fr.drawLegs || fr.legs;
      const prevLegs = prev ? prev.drawLegs || prev.legs : [];
      const key = (l) => l.type + l.strike;
      const pm = new Map(prevLegs.map((l) => [key(l), l]));
      const nm = new Map(legs.map((l) => [key(l), l]));
      const nowPx = (l) => (o.priceNow ? o.priceNow(l, fr) : null);
      const rows = legs.map((l) => {
        const p = pm.get(key(l));
        const chg = !p ? 'new' : p.lots !== l.lots ? 'chg' : '';
        const now = nowPx(l);
        const pnl = now != null ? l.lots * L * (now - l.entry) : null;
        return `<tr class="${chg}"><td class="l ${l.lots > 0 ? 'pos' : 'neg'}">${l.lots > 0 ? 'Bought' : 'Sold'} ${Math.abs(l.lots)}</td><td>${o.cur === 'usd' ? l.strike : n0(l.strike)} ${l.type === 'CE' ? 'call' : 'put'}</td><td>${o.cur === 'usd' ? '$' + l.entry.toFixed(2) : l.entry.toFixed(1)}</td>${o.priceNow ? `<td>${now == null ? '—' : o.cur === 'usd' ? '$' + now.toFixed(2) : now.toFixed(1)}</td><td class="${cls(pnl)}">${pnl == null ? '—' : money(o.cur, pnl, true)}</td>` : ''}</tr>`;
      });
      const gone = prevLegs
        .filter((l) => !nm.has(key(l)))
        .map(
          (l) =>
            `<tr class="gone"><td class="l">${l.lots > 0 ? 'Bought' : 'Sold'} ${Math.abs(l.lots)}</td><td>${o.cur === 'usd' ? l.strike : n0(l.strike)} ${l.type === 'CE' ? 'call' : 'put'}</td><td colspan="${o.priceNow ? 3 : 1}">closed</td></tr>`,
        );
      q('.adj-legs').innerHTML =
        legs.length || gone.length
          ? `<table class="grid-tbl adj-legtbl"><thead><tr><th class="l">Leg</th><th>Strike</th><th>Avg price</th>${o.priceNow ? '<th>Now</th><th>P&amp;L</th>' : ''}</tr></thead><tbody>${rows.join('')}${gone.join('')}</tbody></table>`
          : '<div class="muted small">Nothing open.</div>';
    }
    function kpis(fr) {
      const L = o.lot;
      const c = (fr.drawCash ?? fr.cash) - (fr.drawCosts ?? fr.costs);
      const legs = fr.drawLegs || fr.legs;
      const r = riskOf(legs, c, L);
      const netPaid = -c;
      const k = [];
      const box = (l, v, s, cl = '') =>
        `<div class="kpi"><span class="k-l">${l}</span><span class="k-v ${cl}">${v}</span><span class="k-s">${s || ''}</span></div>`;
      k.push(
        box(
          netPaid >= 0 ? 'Net paid' : 'Net received',
          money(o.cur, Math.abs(netPaid)),
          o.cur === 'usd' ? 'premiums so far' : `premiums so far, costs ${inr(Math.round(fr.drawCosts ?? fr.costs))}`,
        ),
      );
      if (fr.final != null) k.push(box('Result', money(o.cur, fr.final, true), 'settled at expiry', cls(fr.final)));
      else if (fr.mtm != null) k.push(box('P&amp;L now', money(o.cur, fr.mtm, true), 'marked at model prices', cls(fr.mtm)));
      if (fr.final == null)
        k.push(
          box(
            'If it ends here',
            money(o.cur, AL.atExpiry(legs, fr.S, c, L), true),
            `Nifty ${o.cur === 'usd' ? fr.S.toFixed(2) : n0(fr.S)} at expiry`,
            cls(AL.atExpiry(legs, fr.S, c, L)),
          ),
        );
      k.push(
        box(
          'Worst at expiry',
          r.openLoss ? 'open-ended' : money(o.cur, r.worst, true),
          r.openLoss ? `loss on a ${r.openLoss}` : r.worst >= 0 ? 'cannot end in a loss' : 'the most it can lose',
          r.openLoss ? 'neg' : cls(r.worst),
        ),
      );
      k.push(
        box('Best at expiry', r.openGain ? 'open-ended' : money(o.cur, r.best, true), r.openGain ? `on a ${r.openGain}` : 'the most it can make', cls(r.best)),
      );
      if (fr.base != null)
        k.push(
          box(
            o.bias === 'bear' ? 'Long put held' : 'Long call held',
            money(o.cur, fr.base, true),
            fr.final != null ? 'no adjustments, same entry' : 'the same entry, never adjusted',
            cls(fr.base),
          ),
        );
      q('.adj-kpis').innerHTML = `<div class="kpis">${k.join('')}</div>`;
    }
    function log(i) {
      const items = [];
      for (let j = i; j >= 0; j--) {
        const f = P.frames[j];
        if (!DECISION.has(f.kind) && f.kind !== 'expiry' && f.kind !== 'skip') continue;
        items.push(
          `<li class="${f.kind}${j === i ? ' fresh' : ''}" data-j="${j}"><span class="when">${esc(f.label || `${wdLabel(f.day)} ${hhmm(f.min)}`)}</span><span class="what">${
            f.kind === 'adjust' ? `<b>${esc(AL.nodeName(f.from, o.bias))} → ${esc(AL.nodeName(f.to, o.bias))}</b> · ` : ''
          }${esc(f.text || '')}${f.trades?.length ? `<span class="trades">${f.trades.map((t) => esc(tradeLine(t, o.cur))).join(' · ')}</span>` : ''}</span></li>`,
        );
      }
      q('.adj-log').innerHTML = items.join('') || '<li class="muted">Nothing yet.</li>';
    }
    async function show(i, animate = true) {
      if (!P.frames.length) return;
      i = Math.max(0, Math.min(P.frames.length - 1, i));
      const step = i === P.i + 1;
      P.i = i;
      const fr = P.frames[i];
      const prev = lastPositionBefore(i);
      const moved = Boolean(fr.trades?.length) || fr.kind === 'expiry';
      const ms = animate && step ? (moved ? 950 : 420) / P.speed : 0;
      const seen = new Set(P.frames.slice(0, i + 1).map((f) => f.level));
      q('.adj-node').textContent = fr.kind === 'close' || fr.kind === 'stop' || fr.kind === 'target' ? '— closed' : `— ${AL.nodeName(fr.level, o.bias)}`;
      q('.adj-clock').innerHTML =
        `${esc(fr.label || `${wdLabel(fr.day)} ${hhmm(fr.min)}`)} · step ${i + 1} of ${P.frames.length}${fr.T != null && fr.T > 0 ? ` · ${(fr.T * 365).toFixed(1)} days left` : ''}`;
      q('.adj-progress > div').style.width = `${((i + 1) / P.frames.length) * 100}%`;
      const legend = ghostsUpTo(i);
      q('.adj-legend').innerHTML =
        `<span class="lg cur">${esc(legsLine(fr.drawLegs || fr.legs, o.cur))}</span>${legend.length ? '<span class="lg gh">earlier positions</span>' : ''}${o.today !== false ? '<span class="lg td">today (model)</span>' : ''}`;
      callouts(fr, prev);
      legsTable(fr, prev);
      kpis(fr);
      log(i);
      tree?.draw(decisionsUpTo(i), { animate: animate && step && DECISION.has(fr.kind) && fr.kind !== 'entry', ms: ms * 0.9 });
      ladderSet(q('.adj-ladder'), fr.level, seen);
      const jobs = [pay.to(fr, { ms, ghostList: legend })];
      if (path) jobs.push(path.to(i, animate && step ? ms * 0.8 : 0));
      root.querySelectorAll('.adj-paybox, .adj-treebox').forEach((b) => b.classList.toggle('flash', animate && step && moved));
      await Promise.all(jobs);
      if (o.onShow) o.onShow(fr, i, P.frames);
    }
    const playBtn = q('.adj-play');
    function pause() {
      P.playing = false;
      playBtn.textContent = '▶ Play';
    }
    async function play() {
      if (P.playing) return pause();
      if (P.i >= P.frames.length - 1) await show(0, false);
      P.playing = true;
      playBtn.textContent = '❚❚ Pause';
      while (P.playing && P.alive && P.i < P.frames.length - 1) {
        await show(P.i + 1, true);
        const f = P.frames[P.i];
        const dwell = f.trades?.length || f.kind === 'expiry' ? 1500 : DECISION.has(f.kind) ? 1000 : 260;
        await BT.sleep(dwell / P.speed);
      }
      pause();
    }
    q('.adj-ctrl').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.s) {
        P.speed = Number(b.dataset.s);
        BT.store.set('adj-speed', P.speed);
        root.querySelectorAll('.adj-speed button').forEach((x) => x.classList.toggle('on', x === b));
        return;
      }
      const c = b.dataset.c;
      if (!c) return;
      if (c === 'play') return play();
      pause();
      if (c === 'first') show(0, false);
      else if (c === 'prev') show(P.i - 1, false);
      else if (c === 'next') show(P.i + 1, true);
      else if (c === 'last') show(P.frames.length - 1, false);
    });
    q('.adj-log').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-j]');
      if (li) {
        pause();
        show(Number(li.dataset.j), false);
      }
    });
    const api = {
      load,
      show,
      play,
      pause,
      get i() {
        return P.i;
      },
      destroy() {
        P.alive = false;
        pause();
        players.delete(api);
      },
    };
    players.add(api);
    return api;
  }

  // ---------- the live chain (simulation, and the guide's Nifty numbers) ----------
  async function loadMarket(expiry) {
    let j = null;
    mkErr = '';
    try {
      j = await BT.api('/api/live?expiry=' + encodeURIComponent(expiry));
    } catch (e) {
      mkErr = e.message;
    }
    const Tnow = Math.max(1 / 365 / 24, (Date.parse(expiry + 'T15:30:00+05:30') - Date.now()) / YEAR_MS);
    const spot = j?.spot || window.app?.state?.data?.spot || 24000;
    const rows = (j?.rows || []).filter((r) => r.strike > 0);
    const ivs = { CE: new Map(), PE: new Map() };
    for (const r of rows)
      for (const [t, side] of [
        ['CE', r.ce],
        ['PE', r.pe],
      ]) {
        const px = side?.ltp > 0 ? side.ltp : null;
        const v = px ? AL.impliedVol(px, spot, r.strike, Tnow, t === 'CE') : null;
        if (v && v > 0.03 && v < 1.5) ivs[t].set(r.strike, v);
      }
    const strikes = rows.map((r) => r.strike).sort((a, b) => a - b);
    const A = Math.round(spot / 50) * 50;
    const near = (t, k) => {
      const m = ivs[t];
      if (m.has(k)) return m.get(k);
      let best = null;
      let bd = Infinity;
      for (const [s, v] of m) if (Math.abs(s - k) < bd) ((bd = Math.abs(s - k)), (best = v));
      return best;
    };
    const atmIvs = [near('CE', A), near('PE', A)].filter(Boolean);
    const ivAtm = atmIvs.length ? atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length : 0.13;
    const ltp = new Map();
    for (const r of rows) {
      if (r.ce?.ltp > 0) ltp.set(r.strike + 'CE', r.ce.ltp);
      if (r.pe?.ltp > 0) ltp.set(r.strike + 'PE', r.pe.ltp);
    }
    return {
      expiry,
      spot,
      strikes,
      ivAtm,
      ivOf: (t, k) => near(t, k) || ivAtm,
      ltp,
      Tnow,
      live: Boolean(j?.rows?.length),
      updatedAt: j?.updatedAt || null,
    };
  }
  const snapK = (m, k) => {
    if (!m?.strikes?.length) return Math.round(k / 50) * 50;
    let best = m.strikes[0];
    for (const s of m.strikes) if (Math.abs(s - k) < Math.abs(best - k)) best = s;
    // a strike past the chain's last one stays on the 50 grid (priced at the nearest strike's volatility)
    return Math.abs(best - k) > 100 ? Math.round(k / 50) * 50 : best;
  };

  // ---------- simulation (browser) ----------
  function schedule(expiry, p) {
    const ep = entryPoint();
    const out = [];
    let di = 0;
    for (let d = ep.day; d <= expiry; d = addDays(d, 1)) {
      if (!isWeekday(d)) continue;
      if (d === expiry && !p.expiryDay) break;
      const skip = p.frame === 'weekly' && (di === 0 || di % 5 !== 0) && d !== expiry;
      if (!skip) for (const m of CHECKS[p.frame]) if (!(d === ep.day && m <= ep.min)) out.push({ day: d, min: m });
      di++;
    }
    return { entry: ep, checks: out };
  }
  // trend = how far Rally / Fall go by the expiry, swing = Zigzag's amplitude (points)
  function scenarioPath(kind, n, S0, sdF, trend, swing, sd) {
    const rnd = mulberry32(sd);
    const gauss = () => {
      let u = 0;
      while (!u) u = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
    };
    const out = [];
    let S = S0;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const w = 0.2 * sdF * Math.sin(i * 1.9);
      if (kind === 'rally') S = S0 + trend * f + w;
      else if (kind === 'fall') S = S0 - trend * f + w;
      else if (kind === 'zigzag') S = S0 + swing * Math.sin(2 * Math.PI * 1.5 * f) + w;
      else if (kind === 'chop') S = S0 + 0.45 * sdF * Math.sin(i * 2.3) + 0.3 * sdF * Math.sin(i * 0.9);
      else S = S + sdF * gauss();
      out.push(S);
    }
    return out;
  }
  // Runs the rules over Nifty path `path` (one price a check, the last one the expiry close; shorter = Manual mode in
  // progress). Prices: Black-Scholes at each strike's implied volatility from the chain, 0.5 % slippage, charges.
  function simulate(m, p, path, sched) {
    const L = lot();
    const bear = p.bias === 'bear';
    const type = bear ? 'PE' : 'CE';
    const call = !bear;
    const E = m.expiry;
    const S0 = m.spot;
    const e = sched.entry;
    const T0 = yearsLeft(e.day, e.min, E);
    const iv = m.ivAtm;
    const K = snapK(m, Math.round(S0 / 50) * 50);
    const W = p.width > 0 ? p.width : AL.autoWidth(S0, iv, T0, p.widthSigma);
    const ivOf = (k) => m.ivOf(type, k);
    const price = (k, S, T) => AL.bs(S, k, T, ivOf(k), call);
    const slip = 0.005;
    const book = { cash: 0, costs: 0, legs: [] };
    const fill = (t, px, day) => {
      const f = t.lots > 0 ? px * (1 + slip) : px * (1 - slip);
      const qty = Math.abs(t.lots) * L;
      book.cash += t.lots > 0 ? -f * qty : f * qty;
      book.costs += window.Costs ? window.Costs.orders({ [t.lots > 0 ? 'buy' : 'sell']: f * qty, orders: 1, day }) : 20;
      book.legs = addFill(book.legs, t.type, t.strike, t.lots, f);
      return f;
    };
    const snapLegs = () => book.legs.map((l) => ({ ...l }));
    const mtm = (S, T) => book.cash - book.costs + book.legs.reduce((s, l) => s + l.lots * L * price(l.strike, S, T), 0);
    const baseFill = price(K, S0, T0) * (1 + slip);
    const baseCost = window.Costs ? window.Costs.orders({ buy: baseFill * L * p.lots, orders: 1, day: e.day }) : 20;
    const baseAt = (S, T) => p.lots * L * (price(K, S, T) - baseFill) - baseCost;
    const st = { level: 0, ref: S0, quiet: 0 };
    const nextTrig = (S, T) => {
      const th = AL.theta(book.legs, S, T, ivOf, L);
      return (th < 0 ? p.kLong : p.kShort) * AL.sigmaPts(st.ref, iv, p.frame);
    };
    const frames = [];
    const px0 = fill({ type, strike: K, lots: p.lots }, price(K, S0, T0), e.day);
    frames.push({
      day: e.day,
      min: e.min,
      label: `${wdLabel(e.day)} ${hhmm(e.min)} · entry`,
      S: S0,
      ref: S0,
      trig: 0,
      T: T0,
      kind: 'entry',
      level: 0,
      text: `Buy the at-the-money ${bear ? 'put' : 'call'}. Rung ${n0(W)} pts (${p.width > 0 ? 'set by you' : `auto: ${p.widthSigma} σ to expiry at ${(iv * 100).toFixed(1)} % IV`}).`,
      trades: [{ type, strike: K, lots: p.lots, px: px0 }],
      legs: snapLegs(),
      cash: book.cash,
      costs: book.costs,
      mtm: mtm(S0, T0),
      base: baseAt(S0, T0),
      nextRef: S0,
      nextTrig: nextTrig(S0, T0),
    });
    frames[0].trig = 0;
    let closed = false;
    const nChecks = Math.min(sched.checks.length, path.length);
    for (let i = 0; i < nChecks && !closed; i++) {
      const c = sched.checks[i];
      const S = path[i];
      const T = yearsLeft(c.day, c.min, E);
      const th = AL.theta(book.legs, S, T, ivOf, L);
      const locked = st.level >= 2 && book.cash - book.costs >= 0;
      const ref0 = st.ref;
      const dec = AL.decide(st, S, p, { iv, theta: th, locked });
      const f = { day: c.day, min: c.min, S, ref: ref0, trig: dec.trig, T, kind: dec.kind, dir: dec.dir, from: st.level };
      const mv = `${S >= ref0 ? '+' : '−'}${n0(Math.abs(S - ref0))} pts from ${n0(ref0)}`;
      if (dec.kind === 'adjust') {
        const target = AL.legsFor(dec.to, K, W, p, (k) => snapK(m, k));
        f.trades = AL.trades(book.legs, target).map((t) => ({ ...t, px: fill(t, price(t.strike, S, T), c.day) }));
        Object.assign(f, { to: dec.to, stall: Boolean(dec.stall) });
        f.text = dec.stall
          ? `No trigger for ${p.stall.checks} checks while long premium (time decay): ${dec.why}`
          : `${mv} ≥ the ${dec.k} σ trigger (${n0(dec.trig)}): ${dec.why}`;
        Object.assign(st, { level: dec.to, ref: S, quiet: 0 });
      } else if (dec.kind === 'hold') {
        f.text = `${mv}: ${dec.why}`;
        Object.assign(st, { ref: S, quiet: 0 });
      } else if (dec.kind === 'close') {
        f.trades = book.legs.map((l) => ({ type: l.type, strike: l.strike, lots: -l.lots }));
        f.drawLegs = snapLegs();
        f.drawCash = book.cash;
        f.drawCosts = book.costs;
        f.trades = f.trades.map((t) => ({ ...t, px: fill(t, price(t.strike, S, T), c.day) }));
        f.text = `${mv}: ${dec.why}`;
        closed = true;
      } else {
        st.quiet++;
        f.text = `${mv}, inside ±${n0(dec.trig)} (${dec.k} σ of a ${FRAME_TXT[p.frame]} while ${dec.longPrem ? 'long' : 'short'} premium): nothing to do`;
      }
      Object.assign(f, {
        level: st.level,
        legs: snapLegs(),
        cash: book.cash,
        costs: book.costs,
        mtm: mtm(S, T),
        base: baseAt(S, T),
        nextRef: st.ref,
        nextTrig: nextTrig(S, T),
      });
      if (closed) f.final = book.cash - book.costs;
      frames.push(f);
    }
    const done = path.length > sched.checks.length || closed;
    if (done && !closed) {
      const SE = path[sched.checks.length];
      const drawLegs = snapLegs();
      const drawCash = book.cash;
      const drawCosts = book.costs;
      for (const l of book.legs) {
        const v = AL.intrinsic(l, SE);
        book.cash += l.lots * L * v;
        if (l.lots > 0 && v > 0 && window.Costs) book.costs += window.Costs.exercise(v * l.lots * L, E);
      }
      const settled = book.legs.length ? legsLine(book.legs) + ' settled at intrinsic' : 'nothing open';
      book.legs = [];
      const bv = AL.intrinsic({ type, strike: K }, SE);
      frames.push({
        day: E,
        min: 375,
        label: `${wdLabel(E)} 15:30 · expiry`,
        S: SE,
        ref: st.ref,
        trig: 0,
        T: 0,
        kind: 'expiry',
        level: st.level,
        text: `Expiry at Nifty ${n0(SE)}: ${settled}.`,
        legs: [],
        drawLegs,
        drawCash,
        drawCosts,
        cash: book.cash,
        costs: book.costs,
        final: book.cash - book.costs,
        base: p.lots * L * (bv - baseFill) - baseCost - (bv > 0 && window.Costs ? window.Costs.exercise(bv * p.lots * L, E) : 0),
      });
    }
    const last = frames[frames.length - 1];
    return { frames, K, W, iv, done, closed, result: last.final, base: last.base, nextRef: st.ref, nextTrig: last.nextTrig };
  }

  // ---------- load + tabs ----------
  async function init() {
    if (started) return render();
    started = true;
    try {
      meta = await BT.api('/api/adj/meta');
    } catch (e) {
      metaErr = e.message;
    }
    const st = BT.store.get('adj-params', {});
    params = AL.merge({ cycle: 'monthly', entryDays: 0, ...(meta?.defaults || {}), ...st });
    params.exit = { stopRs: 0, targetRs: 0, ...(st.exit || {}) };
    try {
      saved = (await BT.api('/api/adj/backtest')).saved;
    } catch {}
    render();
  }
  const save = () => BT.store.set('adj-params', params);
  function render() {
    for (const p of [...players]) p.destroy();
    const tabsEl = $('adjTabs');
    tabsEl.innerHTML = TABS.map(([id, label]) => `<button data-t="${id}" class="${id === tab ? 'on' : ''}">${label}</button>`).join('');
    tabsEl.onclick = (e) => {
      const t = e.target.closest('button')?.dataset.t;
      if (!t || t === tab) return;
      tab = t;
      BT.store.set('adj-tab', t);
      render();
    };
    $('adjStatus').textContent = metaErr
      ? 'Could not load: ' + metaErr
      : meta?.demo
        ? 'Demo mode: the chain is synthetic; the backtest uses the cached history.'
        : '';
    if (!meta) {
      $('adjBody').innerHTML = `<div class="panel empty err">${esc(metaErr || 'Loading…')}</div>`;
      return;
    }
    ({ guide: renderGuide, sim: renderSim, bt: renderBt })[tab]();
  }
  const liveExpiries = () => (meta?.live || []).filter((e) => e >= istNow().day).sort();
  function defaultExpiry(list) {
    return list.find((e) => tradingDays(e) >= 3) || list[0] || null;
  }
  async function ensureMarket(expiry) {
    if (mk && mk.expiry === expiry && Date.now() - mk.at < 60_000) return mk;
    mk = { ...(await loadMarket(expiry)), at: Date.now() };
    return mk;
  }

  // ---------- rules (shared by the simulation and the backtest) ----------
  function rulesHtml(where) {
    const p = params;
    const sel = (k, cur, list, t = '') =>
      `<select data-r="${k}" title="${esc(t)}">${list.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const inp = (k, cur, w = 46, ph = '') => `<input class="txt num" data-r="${k}" value="${cur ?? ''}" placeholder="${ph}" style="width:${w}px">`;
    const chk = (k, on) => `<input type="checkbox" data-r="${k}" ${on ? 'checked' : ''}>`;
    const open = BT.store.get('adj-rules-open', where === 'sim');
    return `<details class="adj-rules" ${open ? 'open' : ''}><summary><b>Rules</b> <span class="muted small">${esc(rulesSummary(p))}</span></summary>
      <div class="lab-set">
        <label title="The PDF works an initially bullish trade with calls; bearish mirrors it with puts (+ = Nifty down)">Bias ${sel('bias', p.bias, [
          ['bull', 'Bullish: calls (the PDF)'],
          ['bear', 'Bearish: puts (mirrored)'],
        ])}</label>
        <label title="Points between the strikes of the ladder. Empty = auto: 0.72 of a standard deviation to expiry, the PDF's $5 gap on an $80 stock at 30% IV and 30 days">Rung ${inp('width', p.width || '', 56, 'auto')} pts</label>
        <label title="How often Nifty is looked at (the PDF: daily for front-month options, hourly at the open for long premium, never longer than a week)">Look every ${sel(
          'frame',
          p.frame,
          [
            ['hourly', 'hour'],
            ['daily', 'day (15:00)'],
            ['weekly', 'week'],
          ],
        )}</label>
        <label title="Adjust when Nifty is this many standard deviations of one look from the last decision point while the position loses from time decay (the PDF: 1.5σ, 86.6% of moves are smaller)">Trigger, long premium ${inp('kLong', p.kLong, 40)} σ</label>
        <label title="...while it earns from time decay: wait longer, 2–2.5σ (the PDF)">short premium ${inp('kShort', p.kShort, 40)} σ</label>
        <label title="The ratio sells two options against one: the PDF leaves the second uncovered (unlimited loss on a rally). Capped buys one further out so the risk stays defined">Ratio’s extra short ${sel(
          'cap',
          p.cap,
          [
            ['capped', 'capped (defined risk)'],
            ['naked', 'naked, as the PDF'],
          ],
        )}</label>
        <label title="How far above the sold strike the cap is bought, in rungs">cap ${inp('capRungs', p.capRungs, 34)} rungs up</label>
        <label title="Rungs the ladder may climb on + moves: 3 = the PDF's tree (condor)">Rungs up ${inp('maxUp', p.maxUp, 34)}</label>
        <label title="Rungs it may fall on − moves: 3 = the PDF's last box">down ${inp('maxDown', p.maxDown, 34)}</label>
        <label>Past the top ${sel('beyondUp', p.beyondUp, [
          ['hold', 'hold'],
          ['close', 'close (take profit)'],
        ])}</label>
        <label title="The PDF: at the bottom it is prudent to consider closing rather than adjusting">Past the bottom ${sel('beyondDown', p.beyondDown, [
          ['close', 'close (the PDF)'],
          ['hold', 'hold'],
        ])}</label>
        <label title="The PDF: once a butterfly is held for a credit (locked profit) it is often prudent to hold it with no more adjustments">${chk('lockHold', p.lockHold)} hold a fly once it is a credit</label>
        <label title="The PDF's note on time: when the price stalls and decay eats a long-premium position, turn it into a position that earns from time (the butterfly)">${chk('stall.on', p.stall.on)} stall rule: fly after ${inp('stall.checks', p.stall.checks, 34)} quiet looks</label>
        <label>${chk('expiryDay', p.expiryDay)} adjust on the expiry day</label>
        <label>Lots ${inp('lots', p.lots, 34)}</label>
        ${
          where === 'bt'
            ? `<label title="Monthly: the PDF's front-month series (about 30 days). Weekly: every expiry to the next">Series ${sel('cycle', p.cycle, [
                ['monthly', 'monthly'],
                ['weekly', 'weekly'],
              ])}</label>
        <label title="0 = at 09:30 on the series' first trading day; N = N trading days before its expiry">Enter ${inp('entryDays', p.entryDays || 0, 34)} trading days before expiry (0 = series start)</label>
        <label title="Whole trade (your rule: stops only on the whole strategy). 0 = off">Stop ₹ ${inp('exit.stopRs', p.exit?.stopRs || 0, 60)}</label>
        <label title="Whole trade, 0 = off">Target ₹ ${inp('exit.targetRs', p.exit?.targetRs || 0, 60)}</label>`
            : ''
        }
        <button class="btn-sm ghost" data-r="reset" title="Back to the defaults (the PDF's tree, capped ratio, 1.5σ / 2σ daily)">Reset rules</button>
      </div></details>`;
  }
  function rulesSummary(p) {
    return `— ${p.bias === 'bear' ? 'puts' : 'calls'}, rung ${p.width ? p.width + ' pts' : 'auto'}, every ${FRAME_TXT[p.frame]}, ${p.kLong}σ / ${p.kShort}σ, ratio ${p.cap}, ${p.maxUp} up / ${p.maxDown} down${p.stall.on ? ', stall rule' : ''}${p.lockHold ? ', hold credit fly' : ''}`;
  }
  function bindRules(root, onChange) {
    const det = root.querySelector('.adj-rules');
    det?.addEventListener('toggle', () => BT.store.set('adj-rules-open', det.open));
    root.querySelectorAll('[data-r]').forEach((el) => {
      const k = el.dataset.r;
      if (k === 'reset') {
        el.onclick = () => {
          params = AL.merge({ ...(meta.defaults || {}), cycle: params.cycle, entryDays: params.entryDays, exit: { stopRs: 0, targetRs: 0 } });
          save();
          onChange(true);
        };
        return;
      }
      el.addEventListener('change', () => {
        const v = el.type === 'checkbox' ? el.checked : el.value;
        const [a, b] = k.split('.');
        const val = typeof v === 'boolean' ? v : v === '' ? 0 : !isNaN(v) ? Number(v) : v;
        if (b) params[a] = { ...params[a], [b]: val };
        else params[a] = val;
        params = AL.merge(params);
        save();
        onChange(false);
      });
    });
  }

  // ---------- Simulate ----------
  async function renderSim() {
    const body = $('adjBody');
    const lives = liveExpiries();
    if (!lives.length) {
      body.innerHTML =
        '<div class="panel empty"><h3>No live expiry</h3><p>The expiry calendar has no upcoming Nifty expiry yet (log in to Upstox or Kite).</p></div>';
      return;
    }
    if (!simExpiry || !lives.includes(simExpiry)) simExpiry = defaultExpiry(lives);
    body.innerHTML = `
      <div class="panel cc-doc adj-top">
        <div class="lab-row">
          <label class="small">Expiry <select id="adjExp">${lives
            .map(
              (e, i) =>
                `<option value="${e}" ${e === simExpiry ? 'selected' : ''}>${dayLabel(e)}${i === 0 ? ' (current)' : ''} · ${tradingDays(e)} trading day${tradingDays(e) === 1 ? '' : 's'}</option>`,
            )
            .join('')}</select></label>
          <span class="muted small">Nifty path</span>
          <div class="seg sm" id="adjScen">${SCEN.map(([id, l, t]) => `<button data-s="${id}" class="${id === scen ? 'on' : ''}" title="${esc(t)}">${l}</button>`).join('')}</div>
          <span id="adjSeed" class="${scen === 'random' ? '' : 'hidden'}"><button class="btn-sm ghost" id="adjNewSeed" title="Another random path">🎲 New path</button> <span class="muted small">seed ${seed}</span></span>
          <span class="spacer"></span>
          <button class="btn-sm ghost" id="adjReload" title="Read the chain again">↻ Live prices</button>
        </div>
        <div id="adjMk" class="small adj-mk">Loading the chain…</div>
        ${rulesHtml('sim')}
      </div>
      <div class="panel cc-doc" id="adjSimOut"><div class="muted">Loading…</div></div>`;
    $('adjExp').onchange = () => {
      simExpiry = $('adjExp').value;
      BT.store.set('adj-exp', simExpiry);
      manual = [];
      buildSim(true);
    };
    $('adjScen').onclick = (e) => {
      const s = e.target.closest('button')?.dataset.s;
      if (!s) return;
      scen = s;
      BT.store.set('adj-scen', s);
      manual = [];
      $('adjScen')
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.s === s));
      $('adjSeed').classList.toggle('hidden', s !== 'random');
      buildSim(false, true);
    };
    $('adjNewSeed').onclick = () => {
      seed = Math.floor(Math.random() * 1e6);
      BT.store.set('adj-seed', seed);
      $('adjSeed').querySelector('span').textContent = 'seed ' + seed;
      buildSim(false, true);
    };
    $('adjReload').onclick = () => {
      mk = null;
      buildSim(true);
    };
    bindRules(body, (reset) => (reset ? renderSim() : buildSim(false)));
    await buildSim(true);
  }
  let simPlayer = null;
  async function buildSim(reload, autoplay = false, animateLast = false) {
    if (tab !== 'sim') return;
    const out = $('adjSimOut');
    if (reload || !mk || mk.expiry !== simExpiry) {
      out.innerHTML = '<div class="muted">Reading the chain…</div>';
      await ensureMarket(simExpiry);
      if (tab !== 'sim') return;
    }
    const p = params;
    const sched = schedule(simExpiry, p);
    const S0 = mk.spot;
    const T0 = yearsLeft(sched.entry.day, sched.entry.min, simExpiry);
    const sdF = AL.sigmaPts(S0, mk.ivAtm, p.frame);
    const sdLife = S0 * mk.ivAtm * Math.sqrt(Math.max(T0, 1 / 365));
    const W = p.width > 0 ? p.width : AL.autoWidth(S0, mk.ivAtm, T0, p.widthSigma);
    const td = tradingDays(simExpiry);
    $('adjMk').innerHTML =
      `<span class="adj-pill">${mk.live ? (window.app?.marketClosed?.() ? 'Last session’s chain' : meta.demo ? 'Demo chain' : 'Live chain') : 'No chain: model only'}</span>
      Nifty <b>${n0(S0)}</b> · ATM implied volatility <b>${(mk.ivAtm * 100).toFixed(1)} %</b> (from the ${dayLabel(simExpiry)} chain) · entry ${wdLabel(sched.entry.day)} ${hhmm(sched.entry.min)}, ${td} trading day${td === 1 ? '' : 's'} to the expiry ·
      rung <b>${n0(W)} pts</b> · 1σ of a ${FRAME_TXT[p.frame]} = ${n0(sdF)} pts, so the trigger is <b>±${n0(p.kLong * sdF)}</b> while long premium and <b>±${n0(p.kShort * sdF)}</b> while short premium ·
      ${sched.checks.length} look${sched.checks.length === 1 ? '' : 's'} at Nifty before the expiry${mkErr ? ` <span class="neg">(${esc(mkErr)})</span>` : ''}`;
    if (!sched.checks.length) {
      out.innerHTML = `<div class="empty"><h3>No look at Nifty left before this expiry</h3><p>With looks every ${FRAME_TXT[p.frame]} there is no check before ${dayLabel(simExpiry)}${p.expiryDay ? '' : ' (adjusting on the expiry day is off)'}. Pick a later expiry, look every hour, or allow adjusting on the expiry day.</p></div>`;
      return;
    }
    const run = (arr) => simulate(mk, p, arr, sched);
    const isManual = scen === 'manual';
    let res;
    if (isManual) {
      // the path from the clicks: ▲ / ▼ move Nifty just past the trigger from the last decision point, ≈ stays inside
      let arr = [];
      for (const mv of manual) {
        if (mv === 'end') {
          const ls = arr.length ? arr[arr.length - 1] : S0;
          while (arr.length < sched.checks.length + 1) arr.push(ls);
          break;
        }
        const r = run(arr);
        if (r.done) break;
        const ls = r.frames[r.frames.length - 1].S;
        const step = r.nextTrig * 1.08;
        arr.push(mv === 'up' ? r.nextRef + step : mv === 'down' ? r.nextRef - step : ls + (arr.length % 2 ? -1 : 1) * 0.3 * r.nextTrig);
      }
      res = run(arr);
    } else {
      // big enough to cross the trigger about three times whatever the look frequency, so the tree is walked
      const k = Math.max(p.kLong, p.kShort);
      const trend = Math.max(1.8 * sdLife, 3.4 * k * sdF);
      const swing = Math.max(1.25 * sdLife, 1.6 * k * sdF);
      res = run(scenarioPath(scen, sched.checks.length + 1, S0, sdF, trend, swing, seed));
    }
    const used = Math.min(manual.filter((m) => m !== 'end').length, sched.checks.length);
    const head = `<div class="adj-simhead"><h3>${esc(SCEN.find((s) => s[0] === scen)[1])} <span class="muted small">— ${esc(SCEN.find((s) => s[0] === scen)[2])}</span></h3>${
      isManual
        ? `<div class="adj-manual"><button class="btn-sm" data-m="up" ${res.done ? 'disabled' : ''}>Nifty ▲ past the trigger</button><button class="btn-sm" data-m="down" ${res.done ? 'disabled' : ''}>Nifty ▼ past the trigger</button><button class="btn-sm ghost" data-m="flat" ${res.done ? 'disabled' : ''}>≈ small move</button><button class="btn-sm ghost" data-m="end" ${res.done ? 'disabled' : ''} title="No more moves: Nifty stays where it is to the expiry">Go to expiry</button><button class="btn-sm ghost" data-m="undo" ${manual.length ? '' : 'disabled'}>Undo</button><button class="btn-sm ghost" data-m="clear" ${manual.length ? '' : 'disabled'}>Start again</button><span class="muted small">look ${used} of ${sched.checks.length}</span></div>`
        : ''
    }</div><div id="adjSimPlayer"></div><div id="adjSimRes"></div>`;
    simPlayer?.destroy();
    out.innerHTML = head;
    simPlayer = makePlayer($('adjSimPlayer'), {
      cur: 'inr',
      lot: lot(),
      lotLabel: `${p.lots} lot${p.lots > 1 ? 's' : ''} of ${lot()}`,
      bias: p.bias,
      maxUp: p.maxUp,
      maxDown: p.maxDown,
      W: res.W,
      ivOf: (l) => mk.ivOf(l.type, l.strike),
      priceNow: (l, fr) => (fr.T > 0 ? AL.bs(fr.S, l.strike, fr.T, mk.ivOf(l.type, l.strike), l.type === 'CE') : AL.intrinsic(l, fr.S)),
      onShow: (fr, i, frames) => i === frames.length - 1 && showSimResult(res, p),
    });
    if (isManual) {
      out.querySelector('.adj-manual').onclick = (e) => {
        const m = e.target.closest('button')?.dataset.m;
        if (!m || e.target.closest('button').disabled) return;
        if (m === 'undo') manual.pop();
        else if (m === 'clear') manual = [];
        else manual.push(m);
        buildSim(false, false, m !== 'undo' && m !== 'clear');
      };
      const n = res.frames.length;
      simPlayer.load(res.frames, { at: animateLast && n > 1 ? n - 2 : n - 1 });
      if (animateLast && n > 1) {
        if (manual[manual.length - 1] === 'end') simPlayer.play();
        else simPlayer.show(n - 1, true);
      }
      if (!manual.length)
        $('adjSimRes').innerHTML =
          `<p class="small muted">Press <b>Nifty ▲</b> or <b>Nifty ▼</b>: each press moves Nifty just past the trigger from the last decision point, so you can walk any path through the tree. <b>≈ small move</b> stays inside the band (time passes, nothing is adjusted). <b>Go to expiry</b> keeps Nifty where it is to the end.</p>`;
    } else {
      simPlayer.load(res.frames);
      if (autoplay) simPlayer.play();
      $('adjSimRes').innerHTML =
        `<p class="small muted">Press <b>▶ Play</b> to run the ${sched.checks.length} looks at Nifty to the expiry, or step through them with ▶|. Click a line in “What happened” to jump to it.</p>`;
    }
  }
  function showSimResult(res, p) {
    const el = $('adjSimRes');
    if (!el || res.result == null) return;
    const name = p.bias === 'bear' ? 'long put' : 'long call';
    const diff = res.result - res.base;
    el.innerHTML = `<div class="kpis adj-final">
      <div class="kpi"><span class="k-l">With the adjustments</span><span class="k-v ${cls(res.result)}">${inrS(Math.round(res.result))}</span><span class="k-s">after 0.5 % slippage and charges</span></div>
      <div class="kpi"><span class="k-l">The ${name} held</span><span class="k-v ${cls(res.base)}">${inrS(Math.round(res.base))}</span><span class="k-s">same entry, never adjusted</span></div>
      <div class="kpi"><span class="k-l">Difference</span><span class="k-v ${cls(diff)}">${inrS(Math.round(diff))}</span><span class="k-s">${diff >= 0 ? 'the adjustments helped on this path' : 'doing nothing was better on this path'}</span></div></div>
      <p class="small muted">One made-up path priced by Black-Scholes at each strike’s volatility from the chain (sticky strike: real smiles move): an illustration of how the rules act, not a forecast. The Backtest tab runs them on real option prices.</p>`;
  }

  // ---------- Backtest ----------
  function renderBt() {
    const body = $('adjBody');
    const list = params.cycle === 'weekly' ? meta.expired : meta.monthly;
    const opts = (cur) => list.map((e) => `<option value="${e}" ${e === cur ? 'selected' : ''}>${dayLabel(e)}</option>`).join('');
    const from = BT.store.get('adj-from-' + params.cycle, list[1] || list[0] || '');
    const to = BT.store.get('adj-to-' + params.cycle, list[list.length - 1] || '');
    const one = BT.store.get('adj-one-' + params.cycle, list[list.length - 1] || '');
    body.innerHTML = `
      <div class="panel cc-doc">
        <h3>Backtest the rules on the Nifty option history</h3>
        <p class="small">Each ${params.cycle} series: buy the at-the-money ${params.bias === 'bear' ? 'put' : 'call'} at 09:30 ${params.entryDays ? `${params.entryDays} trading days before the expiry` : 'on the series’ first trading day'}, look at Nifty every ${FRAME_TXT[params.frame]}, step the ladder at that minute’s real option prices when the trigger is crossed, settle what is open at the expiry. 0.5 % slippage a fill, ₹20 an order, taxes by date. Every series is also run as the plain ${params.bias === 'bear' ? 'long put' : 'long call'} held to expiry — the trade the rules start from — so you can see what the adjustments add.</p>
        ${rulesHtml('bt')}
        ${
          list.length
            ? `<div class="lab-set"><label>From expiry <select id="adjFrom">${opts(from)}</select></label><label>To expiry <select id="adjTo">${opts(to)}</select></label></div>
        <div class="lab-row"><button class="btn-sm run" id="adjRun">Run backtest</button>
          <div class="progress ${job ? '' : 'hidden'}" id="adjProg"><div class="bar"><div class="fill"></div></div><span class="ptext"></span><button class="btn-sm ghost" id="adjStop">Stop</button></div>
          <span class="spacer"></span>
          <label class="small">One series <select id="adjOne">${opts(one)}</select></label><button class="btn-sm ghost" id="adjOneRun" title="Run this one expiry with the rules above and replay it (not saved)">▶ Replay one series</button></div>`
            : '<p class="muted">No expired series in the calendar yet: log in to Upstox and download the history (Data screen).</p>'
        }
      </div>
      <div id="adjReplay"></div>
      <div id="adjRes"></div>`;
    bindRules(body, () => renderBt());
    if (list.length) {
      $('adjFrom').onchange = () => BT.store.set('adj-from-' + params.cycle, $('adjFrom').value);
      $('adjTo').onchange = () => BT.store.set('adj-to-' + params.cycle, $('adjTo').value);
      $('adjOne').onchange = () => BT.store.set('adj-one-' + params.cycle, $('adjOne').value);
      $('adjRun').onclick = runBacktest;
      $('adjOneRun').onclick = async () => {
        const b = $('adjOneRun');
        b.disabled = true;
        b.textContent = 'Running…';
        try {
          const r = await BT.api('/api/adj/series', { expiry: $('adjOne').value, params });
          replayMonth(r.month, r.params);
        } catch (e) {
          $('adjReplay').innerHTML = `<div class="panel empty err">${esc(e.message)}</div>`;
        } finally {
          b.disabled = false;
          b.textContent = '▶ Replay one series';
        }
      };
    }
    renderResults();
  }
  function showProgress(pr) {
    const box = $('adjProg');
    if (!box) return;
    box.classList.toggle('hidden', !job);
    if (!pr) return;
    const frac = pr.total ? pr.done / pr.total : 0;
    box.querySelector('.fill').style.width = (frac * 100).toFixed(1) + '%';
    box.querySelector('.ptext').textContent = `${pr.phase || ''} ${pr.total ? `${pr.done}/${pr.total}` : ''} · ${pr.api?.requests ?? 0} downloads`;
    $('adjStop').onclick = () => job?.id && BT.api('/api/adj/job/stop', { id: job.id }).catch(() => {});
  }
  async function runBacktest() {
    if (job) return;
    try {
      job = { progress: null };
      showProgress({ phase: 'Starting', done: 0, total: 0 });
      const r = await BT.api('/api/adj/backtest', { params, from: $('adjFrom')?.value, to: $('adjTo')?.value });
      job.id = r.id;
      for (;;) {
        await BT.sleep(400);
        const j = await BT.api('/api/adj/job?id=' + job.id);
        job.progress = j.progress;
        showProgress(j.progress);
        if (j.status === 'done') {
          saved = j.result;
          break;
        }
        if (j.status === 'error') throw new Error(j.error);
      }
      job = null;
      openRow = null;
      if (tab === 'bt') renderBt();
    } catch (e) {
      job = null;
      showProgress(null);
      const el = $('adjRes');
      if (el) el.innerHTML = `<div class="panel empty err">Backtest failed: ${esc(e.message)}</div>`;
    }
  }
  function framesFromMonth(m) {
    const E = m.expiry;
    const frames = [];
    let last = m.events[0];
    let prevEv = last;
    const sg = (legs) => legs.map((l) => ({ type: l.type, strike: l.strike, lots: l.side * l.lots, entry: l.entry }));
    for (const [d, mi, S, ref, trig, ei] of m.path) {
      const ev = ei != null ? m.events[ei] : null;
      if (ev) {
        prevEv = last;
        last = ev;
      }
      const f = {
        day: d,
        min: mi,
        S,
        ref,
        trig,
        T: yearsLeft(d, mi, E),
        kind: ev ? ev.kind : 'none',
        dir: ev?.dir,
        from: ev?.from,
        to: ev?.to,
        stall: ev?.stall,
        text: ev ? ev.text : `${S >= ref ? '+' : '−'}${n0(Math.abs(S - ref))} pts from ${n0(ref)}, inside ±${n0(trig)}: nothing to do`,
        trades: ev?.trades,
        level: last.level,
        legs: sg(last.legs),
        cash: last.cash,
        costs: last.costs,
      };
      if (ev && (ev.kind === 'expiry' || ev.kind === 'close' || ev.kind === 'stop' || ev.kind === 'target')) {
        Object.assign(f, { drawLegs: sg(prevEv.legs), drawCash: prevEv.cash, drawCosts: prevEv.costs, final: ev.cash - ev.costs, base: m.base });
        if (ev.kind !== 'expiry') f.trades = prevEv.legs.map((l) => ({ type: l.type, strike: l.strike, lots: -l.side * l.lots }));
      }
      if (ev?.kind === 'entry') f.trades = last.legs.map((l) => ({ type: l.type, strike: l.strike, lots: l.side * l.lots, px: l.entry }));
      frames.push(f);
    }
    // the band drawn at each frame: the one the next look is judged against
    for (let i = 0; i < frames.length; i++) {
      const nx = frames[i + 1];
      frames[i].nextRef = nx ? nx.ref : frames[i].ref;
      frames[i].nextTrig = nx ? nx.trig : 0;
    }
    return frames;
  }
  let btPlayer = null;
  function replayMonth(m, p) {
    const el = $('adjReplay');
    btPlayer?.destroy();
    if (!m.ok) {
      el.innerHTML = `<div class="panel empty">${dayLabel(m.expiry)}: ${esc(m.skip || 'not run')}</div>`;
      return;
    }
    el.innerHTML = `<div class="panel cc-doc"><div class="adj-simhead"><h3>Replay: the ${dayLabel(m.expiry)} series on real prices</h3><span class="muted small">Nifty ${n0(m.spot0)} → ${n0(m.spotE)} (${m.move >= 0 ? '+' : ''}${m.move.toFixed(1)} %) · ATM IV at entry ${(m.iv * 100).toFixed(1)} % · rung ${n0(m.W)} pts · ${m.adjustments} adjustment${m.adjustments === 1 ? '' : 's'} · result ${inrS(m.opt)} vs ${inrS(m.base)} for the long ${p.bias === 'bear' ? 'put' : 'call'} held</span><button class="btn-sm ghost" id="adjReplayX">✕ Close</button></div><div id="adjReplayP"></div></div>`;
    $('adjReplayX').onclick = () => {
      btPlayer?.destroy();
      el.innerHTML = '';
    };
    btPlayer = makePlayer($('adjReplayP'), {
      cur: 'inr',
      lot: p.lotSize || lot(),
      lotLabel: `${p.lots} lot${p.lots > 1 ? 's' : ''} of ${p.lotSize || lot()}`,
      bias: p.bias,
      maxUp: p.maxUp,
      maxDown: p.maxDown,
      W: m.W,
      ivOf: () => m.iv,
    });
    btPlayer.load(framesFromMonth(m));
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }
  function kpi(label, v, sub, c) {
    return `<div class="kpi"><span class="k-l">${label}</span><span class="k-v ${c ?? cls(v)}">${typeof v === 'number' ? inrS(v) : v}</span><span class="k-s">${sub || ''}</span></div>`;
  }
  function renderResults() {
    const el = $('adjRes');
    const B = saved;
    if (!B) {
      el.innerHTML = '<div class="panel empty"><h3>No backtest yet</h3><p>Pick the period and press Run backtest, or replay one series.</p></div>';
      return;
    }
    const s = B.summary;
    const p = B.params;
    const name = p.bias === 'bear' ? 'Long put' : 'Long call';
    const lvRows = Object.entries(s.levels)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([lv, n]) => `<tr><td class="l">${esc(AL.nodeName(Number(lv), p.bias))}</td><td>${n}</td></tr>`)
      .join('');
    const b = s.byMove;
    const dir = (k, label) =>
      `<tr><td class="l">${label}</td><td>${b[k].n}</td><td class="${cls(b[k].opt)}">${inrS(b[k].opt)}</td><td class="${cls(b[k].base)}">${inrS(b[k].base)}</td><td>${b[k].n ? `${b[k].better}/${b[k].n}` : '—'}</td></tr>`;
    el.innerHTML = `
      <div class="panel cc-doc">
        <h3>${s.from ? `${dayLabel(s.from)} – ${dayLabel(s.to)}` : 'No series'}: ${s.months} ${p.cycle} series${s.skipped.length ? `, ${s.skipped.length} left out` : ''}</h3>
        <div class="muted small">${esc(rulesSummary(p))} · ${p.lots} lot${p.lots > 1 ? 's' : ''} · run ${new Date(B.at).toLocaleString('en-IN')}</div>
        <div class="kpis">
          ${kpi('With adjustments', s.opt.total, `${s.opt.win}/${s.months} series won · avg ${kinr(s.opt.avg)}`)}
          ${kpi(name + ' held', s.base.total, `${s.base.win}/${s.months} won · the trade without adjustments`)}
          ${kpi('Adjustments beat it', `${s.better}/${s.months}`, `series · difference ${inrS(s.opt.total - s.base.total)}`, cls(s.opt.total - s.base.total))}
          ${kpi('Worst series', s.opt.worst, `held: ${kinr(s.base.worst)}`)}
          ${kpi('Max drawdown', s.opt.maxDD, `held: ${kinr(s.base.maxDD)}`)}
          ${kpi('Adjustments', `${s.adjustments}`, `${(s.adjustments / Math.max(1, s.months)).toFixed(1)} a series · costs ${inr(s.costs)}${s.closes ? ` · ${s.closes} closed at the bottom` : ''}`, '')}
        </div>
        ${s.skipped.length ? `<p class="muted small">Left out: ${s.skipped.map((x) => `${dayLabel(x.expiry)} (${esc(x.why)})`).join(', ')}.</p>` : ''}
      </div>
      <div class="adj-two">
        <div class="panel cc-doc"><h3>By market direction</h3><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Nifty entry → expiry</th><th>Series</th><th>Adjusted</th><th>${name}</th><th>Adjusted better</th></tr></thead><tbody>
          ${dir('down', `Down more than ${s.band} %`)}${dir('flat', `Within ±${s.band} %`)}${dir('up', `Up more than ${s.band} %`)}</tbody></table></div>
          <p class="muted small">The PDF’s claim to test: adjustments give up some of a big win (row “Up” for calls) to lose less when the market zigzags or turns.</p></div>
        <div class="panel cc-doc"><h3>Where the ladder ended</h3><div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Final position</th><th>Series</th></tr></thead><tbody>${lvRows}</tbody></table></div></div>
      </div>
      <div class="panel cc-doc"><h3>Running total</h3><div class="cc-pay-chart"><canvas id="adjEq"></canvas></div></div>
      <div class="panel cc-doc"><h3>Series by series</h3><div class="muted small" style="margin-bottom:6px">Click a row for its decisions; ▶ replays it with the animation.</div>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th class="l">Expiry</th><th>Nifty entry → expiry</th><th>Move</th><th>IV</th><th>Rung</th><th class="l">Path through the tree</th><th>Adjusted</th><th>${name}</th><th>Difference</th><th></th></tr></thead><tbody>
        ${B.months
          .map((m) => {
            if (!m.ok) return `<tr><td class="l">${dayLabel(m.expiry)}</td><td colspan="9" class="muted l">${esc(m.skip)}</td></tr>`;
            const open = openRow === m.expiry;
            const route = m.events
              .filter((e) => e.kind === 'adjust' || e.kind === 'close' || e.kind === 'stop' || e.kind === 'target')
              .map((e) =>
                e.kind === 'adjust'
                  ? `<span class="adj-chip ${e.dir > 0 ? 'up' : e.dir < 0 ? 'dn' : 'st'}">${esc(shortName(e.to, p.bias))}</span>`
                  : '<span class="adj-chip x">✕</span>',
              )
              .join('');
            return `<tr class="cc-click${open ? ' on' : ''}" data-m="${m.expiry}"><td class="l">${dayLabel(m.expiry)}</td><td>${n0(m.spot0)} → ${n0(m.spotE)}</td><td class="${cls(m.move)}">${m.move.toFixed(1)} %</td><td>${(m.iv * 100).toFixed(1)} %</td><td>${n0(m.W)}</td>
              <td class="l"><span class="adj-chip">${esc(shortName(0, p.bias))}</span>${route}</td><td class="${cls(m.opt)}"><b>${inrS(m.opt)}</b></td><td class="${cls(m.base)}">${inrS(m.base)}</td><td class="${cls(m.opt - m.base)}">${inrS(m.opt - m.base)}</td><td><button class="btn-sm ghost" data-rp="${m.expiry}" title="Replay this series">▶</button></td></tr>
              ${open ? `<tr class="cc-detail"><td colspan="10" class="l"><ul class="small">${m.events.map((e) => `<li>${dayLabel(e.day)} ${e.time || ''} · Nifty ${n0(e.spot)} · ${esc(e.text)}</li>`).join('')}</ul><div class="small muted">Costs ${inr(m.costs)} · gross ${inrS(m.gross)}</div></td></tr>` : ''}`;
          })
          .join('')}</tbody></table></div>
        <p class="muted small">Past series only, and few of them: a guide to how the rules behave, not a forecast. The rung, trigger and limits are the PDF’s ideas made mechanical by this screen — the author himself says the art of adjusting cannot be fully written as rules.</p></div>`;
    el.querySelectorAll('tr[data-m]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-rp]')) return;
        openRow = openRow === tr.dataset.m ? null : tr.dataset.m;
        renderResults();
      }),
    );
    el.querySelectorAll('[data-rp]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = B.months.find((x) => x.expiry === b.dataset.rp);
        if (m) replayMonth(m, p);
      }),
    );
    const ok = B.months.filter((m) => m.ok);
    const run = (k) => {
      let t = 0;
      return ok.map((m) => (t += m[k]));
    };
    BT.chart($('adjEq'), {
      type: 'line',
      data: {
        labels: ok.map((m) => dayLabel(m.expiry)),
        datasets: [
          { label: 'With adjustments', data: run('opt'), borderColor: '#b392f0', borderWidth: 2, pointRadius: 2 },
          { label: name + ' held', data: run('base'), borderColor: '#9aa5b1', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
        ],
      },
      options: {
        animation: reduced ? false : { duration: 900 },
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: (v) => kinr(v) } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${inrS(Math.round(c.parsed.y))}` } } },
      },
    });
  }

  // ---------- Guide: the PDF explained ----------
  // The PDF's two worked examples, exactly as printed ($, per share; one contract = 100 shares).
  const PDF_EX = {
    up: {
      title: 'Example 1: uptrend',
      steps: [
        {
          dte: 30,
          P: 80,
          level: 0,
          tr: [[1, 80, 2.9]],
          net: 2.9,
          say: 'Buy one 80 call for $2.90. A bullish hunch with no idea how far it will go, so a fixed-risk vanilla call.',
        },
        {
          dte: 28,
          P: 82,
          level: 1,
          tr: [[-1, 85, 1.6]],
          net: 1.3,
          say: 'Stock 82. Sell the 85 call for $1.60 → 80/85 vertical for a net $1.30 debit. Cost and risk shrink; profits past 85 are traded away for a position that now sits in its profit zone.',
        },
        {
          dte: 26,
          P: 84,
          level: 2,
          tr: [
            [-1, 85, 2.4],
            [1, 90, 0.8],
          ],
          net: -0.3,
          say: 'Stock 84. Sell another 85 call ($2.40), buy the 90 ($0.80) → 80/85/90 butterfly for a net $0.30 credit: nothing left to lose, a profit locked in, the fattest profit right where the stock trades. Often best simply held from here.',
        },
        {
          dte: 22,
          P: 88,
          level: 3,
          tr: [
            [1, 85, 4.5],
            [-2, 90, 1.8],
            [1, 95, 0.6],
          ],
          net: 1.2,
          say: 'Stock 88, about to run out of the fly’s profit zone. Buy an 85, sell two 90s, buy a 95 → 80/85/90/95 condor for a net $1.20 debit: some risk taken back to stretch the profit zone to the price. The plain call would now have done better — the method bets on zigzags, not on one-way runs.',
        },
      ],
    },
    down: {
      title: 'Example 2: downtrend',
      steps: [
        { dte: 30, P: 80, level: 0, tr: [[1, 80, 2.9]], net: 2.9, say: 'The same start: buy one 80 call for $2.90.' },
        {
          dte: 28,
          P: 78,
          level: -1,
          tr: [[-2, 85, 0.6]],
          net: 1.7,
          say: 'Stock 78, against you. Sell two 85 calls at $0.60 → 1×2 ratio for a net $1.70 debit: cheaper to hold, and the profit zone pulled back toward the price. The extra short call is upside risk — you want a rally back toward 85, just not too fast.',
        },
        {
          dte: 26,
          P: 76,
          level: -2,
          tr: [
            [1, 75, 3.1],
            [-2, 80, 1.1],
            [1, 85, 0.3],
          ],
          net: 2.9,
          say: 'Stock 76. Add a 75/80/85 butterfly (buy 75 $3.10, sell two 80 $1.10, buy 85 $0.30) → +75 / −80 / −85, an “open ratio condor”, net $2.90: back to the original cost but positioned to profit from a smaller bounce.',
        },
        {
          dte: 22,
          P: 72,
          level: -3,
          tr: [
            [1, 70, 3.4],
            [-2, 75, 1.0],
            [1, 80, 0.2],
          ],
          net: 4.5,
          say: 'Stock 72, flushing down. Closing is now the prudent choice; to salvage something, add one more fly (buy 70 $3.40, sell two 75 $1.00, buy 80 $0.20) → +70 / −75 / −85 for a net $4.50.',
        },
      ],
    },
  };
  function guideNums() {
    const S = Math.round(mk?.spot || window.app?.state?.data?.spot || 24000);
    const iv = mk?.ivAtm || 0.13;
    const K = Math.round(S / 50) * 50;
    const W = AL.autoWidth(K, iv, 30 / 365);
    return { S, iv, K, W, L: lot(), toN: (x) => K + ((x - 80) / 5) * W };
  }
  // Frames of a PDF example: in $ exactly as printed, or in Nifty (same rungs, Black-Scholes at today's IV).
  function exampleFrames(ex, cur) {
    const g = guideNums();
    const frames = [];
    let legs = [];
    let cash = 0;
    for (const s of ex.steps) {
      if (cur === 'usd') {
        for (const [q, k, px] of s.tr) {
          cash -= q * px;
          legs = addFill(legs, 'CE', k, q, px);
        }
        frames.push({
          label: `${s.dte} days to expiry · stock ${s.P}`,
          S: s.P,
          T: s.dte / 365,
          kind: s.level === 0 && !frames.length ? 'entry' : 'adjust',
          from: frames.length ? frames[frames.length - 1].level : 0,
          to: s.level,
          dir: frames.length ? Math.sign(s.level - frames[frames.length - 1].level) : 0,
          level: s.level,
          legs: legs.map((l) => ({ ...l })),
          cash: cash * 100, // per contract of 100 shares, as the PDF's charts
          costs: 0,
          text: `${s.say} (net ${s.net >= 0 ? 'debit' : 'credit'} $${Math.abs(s.net).toFixed(2)} a share)`,
          trades: s.tr.map(([q, k, px]) => ({ type: 'CE', strike: k, lots: q, px })),
        });
      } else {
        const S = g.toN(s.P);
        const T = s.dte / 365;
        const target = AL.legsFor(s.level, g.K, g.W, { cap: 'naked' });
        const tr = AL.trades(legs, target).map((t) => ({ ...t, px: AL.bs(S, t.strike, T, g.iv, true) }));
        for (const t of tr) {
          cash -= t.lots * t.px;
          legs = addFill(legs, 'CE', t.strike, t.lots, t.px);
        }
        frames.push({
          label: `${s.dte} days to expiry · Nifty ${n0(S)}`,
          S,
          T,
          kind: !frames.length ? 'entry' : 'adjust',
          from: frames.length ? frames[frames.length - 1].level : 0,
          to: s.level,
          dir: frames.length ? Math.sign(s.level - frames[frames.length - 1].level) : 0,
          level: s.level,
          legs: legs.map((l) => ({ ...l })),
          cash: cash * g.L,
          costs: 0,
          text: `${frames.length ? AL.stepText(frames[frames.length - 1].level, s.level) : 'Buy the at-the-money call'} (net ${cash >= 0 ? 'credit' : 'debit'} ${Math.abs(cash).toFixed(1)} pts = ${inr(Math.abs(Math.round(cash * g.L)))} a lot)`,
          trades: tr,
        });
      }
    }
    return frames;
  }
  function exampleTable(ex) {
    const g = guideNums();
    const nf = exampleFrames(ex, 'inr');
    return `<div class="tbl-wrap"><table class="grid-tbl adj-ex"><thead><tr><th class="l">Days left</th><th class="l">In the PDF ($80 stock, 30 % IV)</th><th>Net</th><th class="l">In Nifty (ATM ${n0(g.K)}, rung ${n0(g.W)}, IV ${(g.iv * 100).toFixed(1)} %)</th><th>Net / lot</th></tr></thead><tbody>${ex.steps
      .map((s, i) => {
        const f = nf[i];
        const netN = -f.cash;
        return `<tr><td class="l">${s.dte}</td><td class="l">Stock ${s.P}: ${s.tr.map(([q, k, px]) => `${q > 0 ? 'buy' : 'sell'} ${Math.abs(q)}× ${k}C $${px.toFixed(2)}`).join(', ')}</td><td>${s.net >= 0 ? 'Dr' : 'Cr'} $${Math.abs(s.net).toFixed(2)}</td>
          <td class="l">Nifty ${n0(f.S)}: ${f.trades.map((t) => `${t.lots > 0 ? 'buy' : 'sell'} ${Math.abs(t.lots)}× ${n0(t.strike)}C ${t.px.toFixed(1)}`).join(', ')}</td><td>${netN >= 0 ? 'Dr' : 'Cr'} ${inr(Math.abs(Math.round(netN)))}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  }
  // a small payoff with a "draw" animation, for the building blocks
  function miniPay(legs, S, T, iv, cur = 'inr') {
    const g = guideNums();
    const cash = -legs.reduce((s, l) => s + l.lots * AL.bs(S, l.strike, T, iv, l.type === 'CE'), 0) * g.L;
    const ks = legs.map((l) => l.strike);
    const x0 = Math.min(...ks) - g.W * 1.5;
    const x1 = Math.max(...ks) + g.W * 1.5;
    const N = 80;
    const W = 300;
    const H = 130;
    const ys = Array.from({ length: N + 1 }, (_, i) => AL.atExpiry(legs, x0 + ((x1 - x0) * i) / N, cash, g.L));
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const pad = (hi - lo || 1) * 0.15;
    const sx = (i) => 8 + (i / N) * (W - 16);
    const sy = (v) => 10 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 28);
    const d = ys.map((y, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join('');
    const kx = (k) => sx(((k - x0) / (x1 - x0)) * N);
    return `<svg class="adj-svg adj-mini" viewBox="0 0 ${W} ${H}"><line class="zero" x1="8" x2="${W - 8}" y1="${sy(0)}" y2="${sy(0)}"></line>${legs
      .map(
        (l) =>
          `<text class="mk-t ${l.lots > 0 ? 'mk-b' : 'mk-s'}" x="${kx(l.strike)}" y="${H - 4}">${l.lots > 0 ? '+' : '−'}${Math.abs(l.lots)}${l.type === 'CE' ? 'C' : 'P'}</text>`,
      )
      .join(
        '',
      )}<path class="curve draw" d="${d}" pathLength="1"></path><text class="yl" x="${W - 8}" y="${sy(hi) - 2}">${esc(cur === 'usd' ? usd(hi) : kinr(hi))}</text><text class="yl" x="${W - 8}" y="${Math.min(H - 16, sy(lo) + 11)}">${esc(cur === 'usd' ? usd(lo) : kinr(lo))}</text></svg>`;
  }
  function guideTree(svgEl) {
    const t = treeChart(svgEl, { w: 620, h: 300, full: true, maxUp: 3, maxDown: 3, bias: 'bull' });
    t.draw([{ level: 0, dir: 0, kind: 'entry' }]);
    return t;
  }
  function drawGuide() {
    const g = guideNums();
    const sd1 = AL.sigmaPts(g.S, g.iv, 'daily');
    const sdH = AL.sigmaPts(g.S, g.iv, 'hourly');
    const sdW = AL.sigmaPts(g.S, g.iv, 'weekly');
    const T30 = 30 / 365;
    const c = (k, S = g.K, T = T30, v = g.iv) => AL.bs(S, k, T, v, true);
    // Nifty version of the PDF's "volatility = time" table
    const drop = 1.5 * sd1;
    const c1 = c(g.K, g.K - drop, 29 / 365);
    const solveIv = (S, T, target) => AL.impliedVol(target, S, g.K, T, true);
    const ivFlat = solveIv(g.K, 29 / 365, c1);
    const S4 = g.K - drop * 0.43;
    const iv4 = solveIv(S4, 29 / 365, c1);
    const vt = [
      [30, g.K, g.iv],
      [29, g.K - drop, g.iv],
      [29, g.K, ivFlat],
      [29, S4, iv4],
    ];
    const B = {
      vertical: [
        { type: 'CE', strike: g.K, lots: 1 },
        { type: 'CE', strike: g.K + g.W, lots: -1 },
      ],
      fly: [
        { type: 'CE', strike: g.K, lots: 1 },
        { type: 'CE', strike: g.K + g.W, lots: -2 },
        { type: 'CE', strike: g.K + 2 * g.W, lots: 1 },
      ],
      ratio: [
        { type: 'CE', strike: g.K, lots: 1 },
        { type: 'CE', strike: g.K + g.W, lots: -2 },
      ],
      box: [
        { type: 'CE', strike: g.K, lots: 1 },
        { type: 'CE', strike: g.K + g.W, lots: -1 },
        { type: 'PE', strike: g.K, lots: -1 },
        { type: 'PE', strike: g.K + g.W, lots: 1 },
      ],
    };
    const condor = AL.legsFor(3, g.K, g.W, {});
    const toc = [
      ['why', '1 · Why adjust'],
      ['blocks', '2 · The four building blocks'],
      ['gym', '3 · Option gymnastics'],
      ['time', '4 · A note on time'],
      ['tree', '5 · The decision tree'],
      ['ex1', '6 · Example 1: uptrend'],
      ['ex2', '7 · Example 2: downtrend'],
      ['box', '8 · Box trades'],
      ['when', '9 · When to adjust: the σ trigger'],
      ['frame', '10 · Which time frame'],
      ['voltime', '11 · Volatility = time'],
      ['rules', '12 · How this screen turns it into rules'],
    ];
    $('adjBody').innerHTML = `
      <div class="panel cc-doc adj-guide-head">
        <h3>“Trade adjustment basics” — Michael Catolico, 2007 (24 pages)</h3>
        <p>The document argues that options profits come less from picking direction than from <b>adjusting</b> a position as the market zigzags: turning one structure into another to bank gains, cut cost and move the profit zone to where the price now is. It answers four questions in order — <b>why</b> adjust, <b>what</b> to adjust into, <b>how</b> (a decision tree, worked through two examples) and <b>when</b> (a trigger based on standard deviations). The examples use an $80 stock with $5 strikes at 30 % implied volatility; every one of them is redone below for Nifty with today’s numbers.</p>
        <div class="adj-conv">
          <div class="adj-conv-h">How the dollars become Nifty <span class="muted small">(Nifty ${n0(g.S)}, ATM IV ${(g.iv * 100).toFixed(1)} % from the ${mk?.expiry ? dayLabel(mk.expiry) : 'current'} chain${mk?.live ? '' : ' — no chain loaded, a 13 % model'})</span></div>
          <table class="grid-tbl"><thead><tr><th class="l">In the PDF</th><th class="l">For Nifty</th><th class="l">Why</th></tr></thead><tbody>
            <tr><td class="l">Stock at $80, buy the 80 call</td><td class="l">Nifty ${n0(g.S)}, buy the ${n0(g.K)} call (at the money)</td><td class="l">the starting strike is at the money in both</td></tr>
            <tr><td class="l">Strikes $5 apart (75 / 80 / 85 / 90 / 95)</td><td class="l">A rung of <b>${n0(g.W)} pts</b>: ${[-1, 0, 1, 2, 3].map((r) => n0(g.K + r * g.W)).join(' / ')}</td><td class="l">$5 is 0.72 of a standard deviation to expiry for an $80 stock at 30 % IV with 30 days left; the same 0.72 σ for Nifty at ${(g.iv * 100).toFixed(1)} % keeps the premiums in the same proportions (the cheap 85 call stays cheap)</td></tr>
            <tr><td class="l">Prices 82, 84, 88 / 78, 76, 72</td><td class="l">${[82, 84, 88].map((x) => n0(g.toN(x))).join(', ')} / ${[78, 76, 72].map((x) => n0(g.toN(x))).join(', ')}</td><td class="l">the same position between the strikes (a $2 move = 0.4 of a rung)</td></tr>
            <tr><td class="l">1 contract = 100 shares; $2.90 = $290</td><td class="l">1 lot = ${g.L} units; premium points × ${g.L} = ₹</td><td class="l">NSE lot size</td></tr>
            <tr><td class="l">30 % IV, 1σ a day = $1.51, trigger 1.5σ = $2.27</td><td class="l">${(g.iv * 100).toFixed(1)} % IV, 1σ a day = <b>${n0(sd1)} pts</b>, trigger 1.5σ = <b>${n0(1.5 * sd1)} pts</b></td><td class="l">the PDF’s formula P × V ÷ √252 with Nifty’s P and V</td></tr>
          </tbody></table>
        </div>
        <div class="adj-toc">${toc.map(([id, t]) => `<a href="#adj-${id}" data-go="${id}">${t}</a>`).join('')}</div>
      </div>

      <div class="panel cc-doc" id="adj-why">
        <h3>1 · Why adjust: the two objectives</h3>
        <p>Markets rarely travel in straight lines to a target, so the author treats a position as something to keep reshaping as the market moves. Every adjustment serves one or both of two goals:</p>
        <ol><li><b>Lock in gains or lower the position’s cost.</b></li><li><b>Reduce or shift risk while improving leverage</b> — more reward for the risk left, around where the price actually is.</li></ol>
        <p>When a trade works, instead of choosing between letting it ride and cashing out, take part of the gain and keep some of the upside. When it does not, instead of taking the loss, look for an adjustment that cuts cost and re-centres the profit zone. Adjustments cannot turn a loser into a winner by themselves; they set up the conditions in which a turn back pays more.</p>
        <div class="adj-two">
          <div class="adj-card"><h4>Winning: call → vertical</h4><p class="small">PDF: buy the 50 call for $2; next day it is $3. Sell the 55 call for $1 → a 50/55 call spread that cost a net $1. Cost halved (objective 1), risk halved (objective 2).</p><p class="small"><b>Nifty:</b> buy the ${n0(g.K)} call for ${c(g.K).toFixed(0)}; Nifty rises ${n0(0.6 * g.W)} and it is worth ${c(g.K, g.K + 0.6 * g.W, 29 / 365).toFixed(0)}; sell the ${n0(g.K + g.W)} call for ${c(g.K + g.W, g.K + 0.6 * g.W, 29 / 365).toFixed(0)} → the spread now cost ${(c(g.K) - c(g.K + g.W, g.K + 0.6 * g.W, 29 / 365)).toFixed(0)} pts (${inr(Math.round((c(g.K) - c(g.K + g.W, g.K + 0.6 * g.W, 29 / 365)) * g.L))} a lot) instead of ${inr(Math.round(c(g.K) * g.L))}.</p></div>
          <div class="adj-card"><h4>Losing: call → ratio</h4><p class="small">PDF: the 50 call bought for $2 falls to $1. Sell two 55 calls at $0.50 → +1 50 / −2 55 for a net $1. Cost halved, and the profit zone pulled toward the price: a rally back pays sooner from a $1 cost than from $2. The extra short call adds upside risk (see section 12).</p><p class="small"><b>Nifty:</b> the ${n0(g.K)} call bought for ${c(g.K).toFixed(0)} is worth ${c(g.K, g.K - 0.6 * g.W, 29 / 365).toFixed(0)} after a ${n0(0.6 * g.W)}-pt fall; two ${n0(g.K + g.W)} calls bring ${(2 * c(g.K + g.W, g.K - 0.6 * g.W, 29 / 365)).toFixed(0)} → net cost ${(c(g.K) - 2 * c(g.K + g.W, g.K - 0.6 * g.W, 29 / 365)).toFixed(0)} pts.</p></div>
        </div>
        <p class="small muted">Nifty figures: Black-Scholes at ${(g.iv * 100).toFixed(1)} %, 30 → 29 days, one volatility for every strike as the PDF does.</p>
      </div>

      <div class="panel cc-doc" id="adj-blocks">
        <h3>2 · The four building blocks</h3>
        <p>Any position can be turned into almost any other with four basic structures. Calls and puts are interchangeable through put-call parity, so the author thinks in calls.</p>
        <div class="adj-blocks">
          <div class="adj-card"><h4>Vertical</h4>${miniPay(B.vertical, g.K, T30, g.iv)}<p class="small">Equal long and short at different strikes (long lower = bullish). <b>Directional</b>, with <b>regional leverage</b>: by cutting the cost and moving the breakeven, it pays far more for the risk within the likely range than a plain call does.</p><p class="small muted">Nifty: +${n0(g.K)} / −${n0(g.K + g.W)} call</p></div>
          <div class="adj-card"><h4>Butterfly (and condor)</h4>${miniPay(B.fly, g.K, T30, g.iv)}<p class="small">A long and a short vertical, long strikes outside: +1 / −2 / +1. <b>Fixed risk</b> and <b>neutral over a zone</b> (earns from time, theta positive). The tool for floating the fattest profit to wherever the market is. A condor splits the short strikes.</p><p class="small muted">Nifty: +${n0(g.K)} / −2 ${n0(g.K + g.W)} / +${n0(g.K + 2 * g.W)}; condor ${legsLine(condor)}</p></div>
          <div class="adj-card"><h4>Ratio</h4>${miniPay(B.ratio, g.K, T30, g.iv)}<p class="small">A vertical with an extra short: +1 / −2. <b>Cost reduction</b> and <b>risk displacement</b> — the defence when the market goes against you: sell out-of-the-money options against the core position to shed what it costs to hold.</p><p class="small muted">Nifty: +${n0(g.K)} / −2 ${n0(g.K + g.W)} (one call uncovered)</p></div>
          <div class="adj-card"><h4>Box</h4>${miniPay(B.box, g.K, T30, g.iv)}<p class="small">A long call spread plus a long put spread at the same strikes: worth the strike gap at expiry whatever happens. Used on a <b>profitable vertical</b> to lock the profit and get breathing room, then trade the two halves separately (like splitting pairs in blackjack).</p><p class="small muted">Nifty: ${n0(g.K)}/${n0(g.K + g.W)} call spread + put spread</p></div>
        </div>
      </div>

      <div class="panel cc-doc" id="adj-gym">
        <h3>3 · Option gymnastics: turning one into another</h3>
        <p>The exercise: ignore prices and practise which pieces turn any of the four into any other. From a long ${n0(g.K)} / short ${n0(g.K + g.W)} call vertical, as in the PDF: a <b>ratio</b> is one more short call; a <b>butterfly</b> is one more short call and one bought a rung higher; a <b>box</b> is selling the lower put and buying the higher put. Click to morph:</p>
        <div class="adj-gym">
          <div><div class="seg sm" id="adjGymTo">${['vertical', 'ratio', 'fly', 'box'].map((k) => `<button data-k="${k}" class="${k === 'vertical' ? 'on' : ''}">${k === 'fly' ? 'Butterfly' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
            <div id="adjGymTr" class="small adj-gymtr"></div></div>
          <svg id="adjGymSvg"></svg>
        </div>
      </div>

      <div class="panel cc-doc" id="adj-time">
        <h3>4 · A note on time</h3>
        <p>Price is not the only thing that moves a position. If the market stalls after you buy, <b>time decay</b> eats long premium as surely as a move against you. The answer uses the same blocks: turn the position into one that <b>earns from time</b> — the butterfly or the ratio (both theta positive). On this screen that is the optional <b>stall rule</b>: no trigger for N looks while the position is long premium → make it the butterfly.</p>
        <p class="small muted">Today, a ${n0(g.K)} call with 30 days left loses about ${inr(Math.round(-AL.theta([{ type: 'CE', strike: g.K, lots: 1 }], g.K, T30, () => g.iv, g.L)))} a lot a day to time; the ${n0(g.K)}/${n0(g.K + g.W)}/${n0(g.K + 2 * g.W)} butterfly ${AL.theta(B.fly, g.K + g.W, T30, () => g.iv, g.L) >= 0 ? 'earns' : 'loses'} about ${inr(Math.abs(Math.round(AL.theta(B.fly, g.K + g.W, T30, () => g.iv, g.L))))} a day with Nifty at its centre.</p>
      </div>

      <div class="panel cc-doc" id="adj-tree">
        <h3>5 · The decision tree</h3>
        <p>From any position, a move up (+) or down (−) points to the next one. The tree in the PDF starts from a long call; it applies to any trade as the price zigzags, a chess-like plan of moves and counter-moves:</p>
        <div class="adj-treewrap"><svg id="adjGTree"></svg>
          <div class="adj-treebtns"><div class="small muted">Walk a path:</div>
            <button class="btn-sm ghost" data-p="1,1,1">+ + + (Example 1)</button><button class="btn-sm ghost" data-p="-1,-1,-1">− − − (Example 2)</button><button class="btn-sm ghost" data-p="1,-1,1">+ − +</button><button class="btn-sm ghost" data-p="-1,1,1">− + +</button><button class="btn-sm ghost" data-p="1,1,-1">+ + −</button><button class="btn-sm ghost" data-p="-1,-1,1">− − +</button>
            <p class="small muted">Green edges: the market moved your way (+); red: against you (−). The same walk on the ladder below.</p></div></div>
        <div class="adj-gladder">${ladderHtml({ maxUp: 3, maxDown: 3, bias: 'bull' })}</div>
        <p><b>The key to making it a rule:</b> the tree is a ladder. Every “+” moves one step right (long call → vertical → butterfly → condor), every “−” one step left (long call → ratio → fly roll → fly roll again), and each box is just how far along the ladder you are: a vertical that falls goes back to the long call, a ratio that rallies goes back to the long call, a fly roll that rallies is reversed to the ratio. So the position follows from one number, and the screen’s rules are exactly the PDF’s boxes:</p>
        <div class="tbl-wrap"><table class="grid-tbl"><thead><tr><th>Rung</th><th class="l">Name</th><th class="l">PDF ($)</th><th class="l">Nifty now (rung ${n0(g.W)})</th></tr></thead><tbody>${[
          3, 2, 1, 0, -1, -2, -3,
        ]
          .map(
            (lv) =>
              `<tr><td>${lv > 0 ? '+' : ''}${lv}</td><td class="l">${esc(AL.nodeName(lv))}</td><td class="l">${esc(legsLine(AL.legsFor(lv, 80, 5, { cap: 'naked' }), 'usd'))}</td><td class="l">${esc(legsLine(AL.legsFor(lv, g.K, g.W, { cap: 'naked' })))}</td></tr>`,
          )
          .join('')}</tbody></table></div>
      </div>

      <div class="panel cc-doc" id="adj-ex1">
        <h3>6 · ${PDF_EX.up.title}</h3>
        <p>30 days to expiry, the stock at $80, 30 % IV. Watch how each adjustment changes the cost and moves the profit zone (earlier positions stay as faint lines, as in the PDF’s charts).</p>
        <div class="lab-row"><span class="muted small">Show</span><div class="seg sm" data-exu="up"><button data-cur="usd" class="on">The PDF ($)</button><button data-cur="inr">Nifty (₹ a lot)</button></div></div>
        <div id="adjEx1"></div>
        ${exampleTable(PDF_EX.up)}
      </div>

      <div class="panel cc-doc" id="adj-ex2">
        <h3>7 · ${PDF_EX.down.title}</h3>
        <p>The same start, and the market keeps going the wrong way “with gale force”. The ratio and fly rolls keep pulling the profit zone down, at the price of a growing cost — and the extra short call.</p>
        <div class="lab-row"><span class="muted small">Show</span><div class="seg sm" data-exu="down"><button data-cur="usd" class="on">The PDF ($)</button><button data-cur="inr">Nifty (₹ a lot)</button></div></div>
        <div id="adjEx2"></div>
        ${exampleTable(PDF_EX.down)}
        <p class="small">The examples show two extremes on purpose — relentless up and relentless down — where adjustments look worst against simply holding. The method is built for the more usual zigzag. Try both on the Simulate tab, and the Zigzag path.</p>
      </div>

      <div class="panel cc-doc" id="adj-box">
        <h3>8 · Box trades</h3>
        <p>The fourth block is left out of the tree. It is the tool for locking in profit when you have no view: in Example 1 the third step (vertical → butterfly) could equally have been a box. Say a ${n0(g.K)}/${n0(g.K + g.W)} call spread is in profit: buy the ${n0(g.K + g.W)}/${n0(g.K)} put spread and the box is worth the full ${n0(g.W)} points at expiry whatever happens (minus what was paid). If the price then falls back to where the spread was bought, sell the put spread at a profit and you hold the original call spread again for less; if it rises again, box again — each round chips at the cost.</p>
        <p class="small muted">Caveats from the PDF: understand boxes fully — early exercise around dividends (US stock options; Nifty options are European and cash-settled, so this one does not apply) and pin risk at expiry.</p>
      </div>

      <div class="panel cc-doc" id="adj-when">
        <h3>9 · When to adjust: the σ trigger</h3>
        <p>No one knows the best moment; if they did, a computer would print money. The author’s answer: adjust only <b>because the value of the position changes</b>, and only when it changes <b>much more or much less than random noise</b> would explain. Markets meander, then burst: moves of more than 2–3 standard deviations come far more often than a bell curve predicts — “fat tails”, roughly once every 100–200 units of time at any scale (Mandelbrot’s point about the 1987 crash). So:</p>
        <div class="adj-formula">1σ = P × V ÷ √t <span class="muted small">P = price at entry or at the last decision point · V = the position’s implied volatility · t = time units in a year (252 trading days)</span></div>
        <div class="adj-two">
          <div class="adj-card"><h4>The PDF</h4><p class="small">$80 stock, 30 % IV, one day: 80 × 0.30 ÷ √252 = <b>$1.51</b>. Call moves under 1.5σ (86.6 % of days) noise: <b>±$2.27</b>. Tomorrow at $82.30 → adjust (e.g. sell the 85 call → vertical).</p>
            <table class="grid-tbl"><thead><tr><th>σ</th><th>Share of moves inside</th></tr></thead><tbody>${[
              [1, 68.3],
              [1.5, 86.6],
              [2, 95.4],
              [2.5, 98.8],
              [3, 99.7],
            ]
              .map(([k, p]) => `<tr><td>${k}</td><td>${p} %</td></tr>`)
              .join('')}</tbody></table></div>
          <div class="adj-card"><h4>Nifty — try it</h4>
            <div class="lab-set"><label>Nifty <input class="txt num" id="adjCP" value="${g.S}" style="width:70px"></label><label>IV % <input class="txt num" id="adjCV" value="${(g.iv * 100).toFixed(1)}" style="width:46px"></label><label>Every <select id="adjCF"><option value="hourly">hour</option><option value="daily" selected>day</option><option value="weekly">week</option></select></label><label>k <input class="txt num" id="adjCK" value="1.5" style="width:40px"> σ</label></div>
            <div id="adjCalc" class="small"></div></div>
        </div>
      </div>

      <div class="panel cc-doc" id="adj-frame">
        <h3>10 · Which time frame, and how wide a trigger</h3>
        <ul>
          <li><b>Trading days, not calendar days</b>: nothing can be done while the market is shut.</li>
          <li><b>How closely you can watch.</b> A retail trader can rarely watch all day, so a day is the practical unit; alerts and contingent orders can cover the rest.</li>
          <li><b>The position decides most.</b> The PDF assumes front-month options: daily decision points. For longer positions stretch to a few days or a week — never longer than a week.</li>
          <li><b>Long premium</b> (long gamma) has to pay for itself by capturing movement: use short frames — a day, an hour, less. At a gap open (e.g. Monday) use the hourly threshold. For Nifty an hour is 1/√(252 × 6.25): 1σ = <b>${n0(sdH)} pts</b> (the PDF’s US example, 6.5 hours: $0.59 — its own formula gives that as 1σ, though the text calls it the 1.5σ figure).</li>
          <li><b>Short premium</b> earns while it waits: adjust as late as possible — a week (1σ = ${n0(sdW)} pts for Nifty) and/or 2 to 2.5σ on the daily figure (±${n0(2 * sd1)} to ±${n0(2.5 * sd1)} pts).</li>
        </ul>
        <p class="small">On this screen: “Look every” sets the frame; the trigger is k_long × σ while the position loses from time decay and k_short × σ while it earns from it (measured with Black-Scholes theta at each look).</p>
      </div>

      <div class="panel cc-doc" id="adj-voltime">
        <h3>11 · Volatility = time</h3>
        <p>An option’s extrinsic value (what it is worth beyond its in-the-money amount) can be read as volatility or as time: $3 of time value with one day left implies huge volatility, with a year left very little. So a position can lose value with no price move at all — from time passing or volatility falling — and that deserves a decision as much as a price trigger. The practical rule: work out what your position would be worth at the price triggers, then <b>react when the position trades at that value, whatever the cause</b>. The PDF’s table, and the same idea for Nifty:</p>
        <div class="adj-two">
          <div><table class="grid-tbl"><thead><tr><th>Days</th><th>Stock</th><th>IV</th><th>80 call</th><th>75 call</th><th>85 call</th></tr></thead><tbody>
            <tr><td>30</td><td>80.00</td><td>30 %</td><td>2.90</td><td>6.10</td><td>1.10</td></tr><tr><td>29</td><td>77.70</td><td>30 %</td><td><b>1.80</b></td><td>4.40</td><td>0.60</td></tr><tr><td>29</td><td>80.00</td><td>19 %</td><td><b>1.80</b></td><td>5.50</td><td>0.30</td></tr><tr><td>29</td><td>79.00</td><td>25 %</td><td><b>1.80</b></td><td>4.90</td><td>0.40</td></tr></tbody></table><p class="small muted">The PDF: a 1.5σ drop, a volatility crush, or a bit of both put the 80 call at the same $1.80.</p></div>
          <div><table class="grid-tbl"><thead><tr><th>Days</th><th>Nifty</th><th>IV</th><th>${n0(g.K)} call</th><th>${n0(g.K - g.W)} call</th><th>${n0(g.K + g.W)} call</th></tr></thead><tbody>${vt
            .map(
              ([d, S, v], i) =>
                `<tr><td>${d}</td><td>${n0(S)}</td><td>${v ? (v * 100).toFixed(1) + ' %' : '—'}</td><td>${i ? '<b>' : ''}${v ? c(g.K, S, d / 365, v).toFixed(1) : '—'}${i ? '</b>' : ''}</td><td>${v ? c(g.K - g.W, S, d / 365, v).toFixed(1) : '—'}</td><td>${v ? c(g.K + g.W, S, d / 365, v).toFixed(1) : '—'}</td></tr>`,
            )
            .join(
              '',
            )}</tbody></table><p class="small muted">Nifty, Black-Scholes: a 1.5σ one-day drop (${n0(drop)} pts), the volatility that does the same with no move, and half-and-half.</p></div>
        </div>
        <p>Keep the focus simple: set the triggers from the price alone, see what the position is worth there, and during the day watch what the position trades at. The author ends with a caution — formulas give discipline, which is necessary, but without a feel for what the market is doing even precise discipline falters.</p>
      </div>

      <div class="panel cc-doc" id="adj-rules">
        <h3>12 · How this screen turns it into rules</h3>
        <ul>
          <li><b>What</b>: the ladder of section 5, from the at-the-money call (put if bearish), strikes a rung apart. <b>Rung</b> = 0.72 σ to expiry unless you set it (${n0(g.W)} pts for 30 days at today’s IV; a weekly with a few days left gets 200–300).</li>
          <li><b>When</b>: the σ trigger of section 9 with P = Nifty at the last decision point and V = the implied volatility of the at-the-money option when the trade was opened (“what I have locked myself into”); k = 1.5 while long premium, 2 while short (section 10).</li>
          <li><b>Where the tree ends</b>: up past the condor → hold (or take the profit); down past the third box → <b>close</b>, the PDF’s advice; both adjustable.</li>
          <li><b>Defined risk</b>: the PDF’s ratio leaves one sold call uncovered — unlimited loss if the market rips. Your rule is defined-risk trades only, so by default the second sold call is <b>capped</b> by buying one 2 rungs higher when the ratio is opened (sold again when it is closed). Switch to “naked” to follow the PDF exactly.</li>
          <li><b>Optional</b>: the stall rule (section 4), holding a butterfly once it is a credit (Example 1’s “often prudent to simply hold”), a whole-trade stop / target in the backtest.</li>
          <li><b>Not automated</b>: the box (the PDF leaves it out of the tree) and the position-value trigger of section 11 (the price trigger stands in for it); the author’s “art” — reading the market — is beyond any rule.</li>
        </ul>
        <p class="small"><b>Be careful with expectations.</b> The PDF shows the mechanics, not results. The Backtest tab runs the rules on real Nifty option prices and always next to the plain long call: buying at-the-money options loses money on average after decay and costs, and the adjustments change the shape of the losses and wins more than the sign. Judge it on the backtest, not on the examples.</p>
        <div class="lab-row"><button class="btn-sm" data-go-tab="sim">Simulate on the current expiry ▸</button><button class="btn-sm ghost" data-go-tab="bt">Backtest on history ▸</button></div>
      </div>`;
    // contents links
    $('adjBody')
      .querySelectorAll('[data-go]')
      .forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('adj-' + a.dataset.go)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        }),
      );
    $('adjBody')
      .querySelectorAll('[data-go-tab]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          tab = b.dataset.goTab;
          BT.store.set('adj-tab', tab);
          render();
        }),
      );
    // gymnastics
    const gym = payoffChart($('adjGymSvg'), { lot: g.L, cur: 'inr', today: false, small: true, w: 460, h: 220 });
    const pr = (legs) => -legs.reduce((s, l) => s + l.lots * AL.bs(g.K, l.strike, T30, g.iv, l.type === 'CE'), 0) * g.L;
    const gf = (k) => ({
      S: g.K,
      legs: B[k].map((l) => ({ ...l, entry: AL.bs(g.K, l.strike, T30, g.iv, l.type === 'CE') })),
      cash: pr(B[k]),
      costs: 0,
      trig: 0,
    });
    const allF = Object.keys(B).map(gf);
    gym.setDomain(gym.domainFor(allF, [g.K - 1.5 * g.W, g.K + 3.5 * g.W]));
    let gymAt = 'vertical';
    gym.to(gf('vertical'));
    const gymText = (from, to) => {
      const tr = AL.trades(B[from], B[to]);
      return from === to
        ? `${legsLine(B[to])}`
        : `<b>${from} → ${to === 'fly' ? 'butterfly' : to}:</b> ${tr.map((t) => tradeLine(t)).join(' · ')} → ${legsLine(B[to])}`;
    };
    $('adjGymTr').innerHTML = gymText('vertical', 'vertical');
    $('adjGymTo').onclick = (e) => {
      const k = e.target.closest('button')?.dataset.k;
      if (!k || k === gymAt) return;
      $('adjGymTr').innerHTML = gymText(gymAt, k);
      gymAt = k;
      $('adjGymTo')
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      gym.to(gf(k), { ms: 800 });
    };
    // the tree, walked
    const gt = guideTree($('adjGTree'));
    const gl = $('adjBody').querySelector('.adj-gladder .adj-ladder');
    requestAnimationFrame(() => ladderSet(gl, 0, new Set([0])));
    let walking = 0;
    $('adjBody')
      .querySelector('.adj-treebtns')
      .addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-p]');
        if (!b) return;
        const id = ++walking;
        const dirs = b.dataset.p.split(',').map(Number);
        const dec = [{ level: 0, dir: 0, kind: 'entry' }];
        gt.draw(dec);
        ladderSet(gl, 0, new Set([0]));
        const seen = new Set([0]);
        for (const d of dirs) {
          await BT.sleep(reduced ? 0 : 650);
          if (id !== walking) return;
          const lv = dec[dec.length - 1].level + d;
          dec.push({ level: lv, dir: d, kind: 'adjust' });
          seen.add(lv);
          gt.draw(dec, { animate: true, ms: 550 });
          ladderSet(gl, lv, seen);
        }
      });
    // the two examples
    for (const [key, elId] of [
      ['up', 'adjEx1'],
      ['down', 'adjEx2'],
    ]) {
      let cur = 'usd';
      let pl = null;
      const mount = () => {
        const at = pl ? pl.i : 0;
        pl?.destroy();
        pl = makePlayer($(elId), {
          cur,
          lot: cur === 'usd' ? 100 : g.L,
          bias: 'bull',
          maxUp: 3,
          maxDown: 3,
          path: false,
          today: false,
          W: cur === 'usd' ? 5 : g.W,
        });
        pl.load(exampleFrames(PDF_EX[key], cur), { at: Math.max(0, at) });
      };
      mount();
      $('adjBody')
        .querySelector(`[data-exu="${key}"]`)
        .addEventListener('click', (e) => {
          const b = e.target.closest('button[data-cur]');
          if (!b || b.dataset.cur === cur) return;
          cur = b.dataset.cur;
          e.currentTarget.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          mount();
        });
    }
    // σ calculator
    const calc = () => {
      const P = Number($('adjCP').value) || g.S;
      const V = (Number($('adjCV').value) || g.iv * 100) / 100;
      const F = $('adjCF').value;
      const k = Number($('adjCK').value) || 1.5;
      const sd = AL.sigmaPts(P, V, F);
      const t = AL.FRAMES[F];
      const call0 = AL.bs(P, Math.round(P / 50) * 50, T30, V, true);
      const step = { hourly: 1 / (252 * 6.25), daily: 1 / 252, weekly: 1 / 52 }[F] * (365 / 252);
      const callDn = AL.bs(P - k * sd, Math.round(P / 50) * 50, Math.max(0, T30 - step), V, true);
      $('adjCalc').innerHTML =
        `<p>1σ in one ${FRAME_TXT[F]} = ${n0(P)} × ${V.toFixed(3)} ÷ √${t % 1 ? t.toFixed(0) : t} = <b>${sd.toFixed(1)} pts</b> (${((sd / P) * 100).toFixed(2)} %).</p>
        <p>Trigger ${k}σ = <b>±${n0(k * sd)} pts</b>: ignore anything between <b>${n0(P - k * sd)}</b> and <b>${n0(P + k * sd)}</b>; a look outside it is a decision point.</p>
        <p class="muted">Position-value form (section 11): the ${n0(Math.round(P / 50) * 50)} call with 30 days left is ${call0.toFixed(1)}; at the lower trigger one ${FRAME_TXT[F]} later it would be about ${callDn.toFixed(1)} — react if it trades there, whatever the cause.</p>`;
    };
    ['adjCP', 'adjCV', 'adjCF', 'adjCK'].forEach((id) => $(id).addEventListener('input', calc));
    calc();
  }

  // The guide's Nifty numbers come from the chain of the expiry the simulation defaults to.
  async function renderGuide() {
    if (!mk) {
      $('adjBody').innerHTML = '<div class="panel empty">Reading today’s Nifty and implied volatility…</div>';
      const lives = liveExpiries();
      const e = simExpiry && lives.includes(simExpiry) ? simExpiry : defaultExpiry(lives);
      if (e) {
        try {
          await ensureMarket(e);
        } catch {}
      }
      if (tab !== 'guide') return;
    }
    drawGuide();
  }

  window.addEventListener('viewchange', (e) => {
    if (e.detail === 'tadj') init();
    else for (const p of players) p.pause();
  });
  if (window.app?.state.view === 'tadj') init();
})();
