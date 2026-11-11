// Small SVG line charts, drawn to the container's width. Touch (or drag) the chart to read every line's value there.
// lineChart(el, {
//   series: [{ pts: [[x, y], …], cls, label, area, hidden }],  cls picks the colour (css: .chart .line.<cls>)
//   height, xFmt, yFmt, zero (keep 0 in view),
//   area: true  → shade the series with area: true (or the first one) green above zero and red below it,
//   marks: [{ x, label, cls, row, dot }]  → a dashed line at x, its label on row `row` above the plot; dot: a series
//     label (or true: the first visible series) to mark with a dot at x,
//   legend: 'key' → a legend under the chart; tapping an entry hides or shows that line (remembered by key),
// })
let uid = 0;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hiddenBy = new Map(); // legend key -> Set of hidden series labels

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// y on a series at x (linear between its points)
function yAt(pts, x) {
  if (!pts.length) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [a, ya] = pts[i - 1];
      const [b, yb] = pts[i];
      return ya + ((yb - ya) * (x - a)) / (b - a || 1);
    }
  }
  return pts[pts.length - 1][1];
}

export function lineChart(el, opts) {
  const { series: all, height = 200, xFmt = String, yFmt = String, zero = false, area = false, marks = [], legend = null } = opts;
  const hidden = legend ? hiddenBy.get(legend) || new Set(all.filter((s) => s.hidden).map((s) => s.label)) : new Set();
  if (legend) hiddenBy.set(legend, hidden);
  const series = all.filter((s) => !hidden.has(s.label));
  const W = Math.max(260, Math.round(el.clientWidth || 340));
  const H = height;
  const rows = Math.max(1, ...marks.filter((m) => m.label).map((m) => (m.row || 0) + 1));
  const pad = { l: 56, r: 12, t: 6 + 14 * rows, b: 24 };
  const pts = (series.length ? series : all).flatMap((s) => s.pts);
  if (!pts.length) {
    el.innerHTML = `<div class="chart-empty" style="height:${H}px">No data</div>`;
    return;
  }
  let [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  let [y0, y1] = series.length ? [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))] : [-1, 1];
  if (zero) {
    y0 = Math.min(y0, 0);
    y1 = Math.max(y1, 0);
  }
  if (x1 === x0) x1 = x0 + 1;
  const yPad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.01 || 1;
  y0 -= yPad;
  y1 += yPad;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + ((y1 - y) / (y1 - y0)) * (H - pad.t - pad.b);
  const path = (p) => p.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
  const id = 'c' + ++uid;

  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"><clipPath id="${id}c"><rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></clipPath>`;
  for (const t of niceTicks(y0, y1, 5)) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`;
  const xt = niceTicks(x0, x1, Math.max(3, Math.floor((W - pad.l) / 80)));
  for (const t of xt) svg += `<line class="grid x" x1="${X(t)}" x2="${X(t)}" y1="${pad.t}" y2="${H - pad.b}"/><text class="tick" x="${X(t)}" y="${H - 6}" text-anchor="middle">${esc(xFmt(t))}</text>`;
  if (zero) svg += `<line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  const shade = series.find((s) => s.area) || (area && !all.some((s) => s.area) ? series[0] : null);
  if (area && shade) {
    const p = shade.pts;
    const a = `${path(p)}L${X(p[p.length - 1][0])},${Y(0)}L${X(p[0][0])},${Y(0)}Z`;
    svg += `<clipPath id="${id}p"><rect x="0" y="0" width="${W}" height="${Y(0)}"/></clipPath><clipPath id="${id}n"><rect x="0" y="${Y(0)}" width="${W}" height="${H}"/></clipPath>`;
    svg += `<path class="area-pos" d="${a}" clip-path="url(#${id}p)"/><path class="area-neg" d="${a}" clip-path="url(#${id}n)"/>`;
  }
  svg += `<g clip-path="url(#${id}c)">`;
  for (const s of series) svg += `<path class="line ${s.cls || ''}" d="${path(s.pts)}"/>`;
  svg += '</g>';
  // marks: a dashed line, a label on its own row at the top (kept inside the chart), a dot on the first line
  for (const m of marks) {
    const dotOn = typeof m.dot === 'string' ? series.find((x) => x.label === m.dot) : series[0];
    if (m.x < x0 || m.x > x1) continue;
    const top = pad.t - 4 - 14 * (rows - 1 - (m.row || 0));
    svg += `<line class="mark ${m.cls || ''}" x1="${X(m.x)}" x2="${X(m.x)}" y1="${top + 2}" y2="${H - pad.b}"/>`;
    if (m.label) {
      const right = X(m.x) > W / 2;
      svg += `<text class="mark-label ${m.cls || ''}" x="${X(m.x) + (right ? -4 : 4)}" y="${top}" text-anchor="${right ? 'end' : 'start'}">${esc(m.label)}</text>`;
    }
    if (m.dot && dotOn) {
      const y = yAt(dotOn.pts, m.x);
      if (y != null) svg += `<circle class="dot ${m.cls || ''}" cx="${X(m.x)}" cy="${Y(y)}" r="4"/>`;
    }
  }
  svg += `<line class="cursor" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/></svg>`;
  const leg = legend
    ? `<div class="chart-legend">${all
        .map((s) => `<button type="button" data-s="${esc(s.label)}" class="${hidden.has(s.label) ? 'off' : ''}" aria-pressed="${!hidden.has(s.label)}"><i class="${s.cls || ''}"></i>${esc(s.label)}</button>`)
        .join('')}</div>`
    : '';
  el.innerHTML = `<div class="chart-wrap">${svg}<div class="chart-tip" hidden></div></div>${leg}`;

  if (legend)
    el.querySelector('.chart-legend').onclick = (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const k = b.dataset.s;
      if (hidden.has(k)) hidden.delete(k);
      else if (hidden.size < all.length - 1) hidden.add(k); // keep one line
      lineChart(el, opts);
    };

  const wrap = el.firstElementChild;
  const cursor = wrap.querySelector('.cursor');
  const tip = wrap.querySelector('.chart-tip');
  if (!series.length) return;
  function show(ev) {
    const r = wrap.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const x = Math.min(x1, Math.max(x0, x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0)));
    const cx = X(x);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('visibility', 'visible');
    const lines = series.map((s) => `<span class="${s.cls || ''}"><i class="${s.cls || ''}"></i>${esc(s.label || '')} <b>${esc(yFmt(yAt(s.pts, x)))}</b></span>`);
    tip.innerHTML = `<b>${esc(xFmt(x))}</b>${lines.join('')}`;
    tip.hidden = false;
    const w = tip.offsetWidth || 170;
    tip.style.left = `${Math.min(Math.max(0, (cx / W) * r.width - w / 2), r.width - w)}px`;
  }
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  wrap.addEventListener('pointerdown', show);
  wrap.addEventListener('pointermove', (e) => (e.buttons || e.pointerType !== 'mouse') && show(e));
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('pointerup', (e) => e.pointerType === 'mouse' || setTimeout(hide, 2500));
}
