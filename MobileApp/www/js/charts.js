// Small SVG line charts, drawn to the container's width. Touch (or drag) the chart to read values.
// lineChart(el, { series: [{ pts: [[x, y], …], cls, label }], height, xFmt, yFmt, zero, area, marks: [{ x, label, cls }] })
// `area: true` shades the first series green above zero and red below it (payoff charts).
let uid = 0;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function lineChart(el, opts) {
  const { series, height = 200, xFmt = String, yFmt = String, zero = false, area = false, marks = [] } = opts;
  const W = Math.max(260, Math.round(el.clientWidth || 340));
  const H = height;
  const pad = { l: 52, r: 10, t: 12, b: 24 };
  const all = series.flatMap((s) => s.pts);
  if (!all.length) {
    el.innerHTML = `<div class="chart-empty" style="height:${H}px">No data</div>`;
    return;
  }
  let [x0, x1] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  let [y0, y1] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  if (zero) {
    y0 = Math.min(y0, 0);
    y1 = Math.max(y1, 0);
  }
  if (x1 === x0) x1 = x0 + 1;
  const yPad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.01 || 1;
  y0 -= yPad;
  y1 += yPad;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + ((y1 - y) / (y1 - y0)) * (H - pad.t - pad.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const id = 'c' + ++uid;

  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
  for (const t of niceTicks(y0, y1)) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`;
  for (const t of niceTicks(x0, x1, 3)) svg += `<text class="tick" x="${X(t)}" y="${H - 6}" text-anchor="middle">${esc(xFmt(t))}</text>`;
  if (zero) svg += `<line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  if (area && series[0]) {
    const pts = series[0].pts;
    const a = `${path(pts)}L${X(pts[pts.length - 1][0])},${Y(0)}L${X(pts[0][0])},${Y(0)}Z`;
    svg += `<clipPath id="${id}p"><rect x="0" y="0" width="${W}" height="${Y(0)}"/></clipPath><clipPath id="${id}n"><rect x="0" y="${Y(0)}" width="${W}" height="${H}"/></clipPath>`;
    svg += `<path class="area-pos" d="${a}" clip-path="url(#${id}p)"/><path class="area-neg" d="${a}" clip-path="url(#${id}n)"/>`;
  }
  for (const m of marks) {
    if (m.x < x0 || m.x > x1) continue;
    svg += `<line class="mark ${m.cls || ''}" x1="${X(m.x)}" x2="${X(m.x)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    if (m.label) svg += `<text class="mark-label ${m.cls || ''}" x="${Math.min(W - pad.r - 2, Math.max(pad.l + 2, X(m.x)))}" y="${pad.t + 10}" text-anchor="middle">${esc(m.label)}</text>`;
  }
  for (const s of series) svg += `<path class="line ${s.cls || ''}" d="${path(s.pts)}"/>`;
  svg += `<line class="cursor" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/></svg>`;
  el.innerHTML = `<div class="chart-wrap">${svg}<div class="chart-tip" hidden></div></div>`;

  const wrap = el.firstElementChild;
  const cursor = wrap.querySelector('.cursor');
  const tip = wrap.querySelector('.chart-tip');
  const ref = series[0].pts;
  function show(ev) {
    const r = wrap.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const x = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let i = 0;
    for (let k = 1; k < ref.length; k++) if (Math.abs(ref[k][0] - x) < Math.abs(ref[i][0] - x)) i = k;
    const cx = X(ref[i][0]);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('visibility', 'visible');
    const lines = series.map((s) => {
      const p = s.pts[Math.min(i, s.pts.length - 1)];
      return `<span class="${s.cls || ''}">${esc(s.label || '')} ${esc(yFmt(p[1]))}</span>`;
    });
    tip.innerHTML = `<b>${esc(xFmt(ref[i][0]))}</b>${lines.join('')}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(0, (cx / W) * r.width - 70), r.width - 150)}px`;
  }
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  wrap.addEventListener('pointerdown', show);
  wrap.addEventListener('pointermove', (e) => (e.buttons || e.pointerType !== 'mouse') && show(e));
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('pointerup', (e) => e.pointerType === 'mouse' || setTimeout(hide, 1500));
}
