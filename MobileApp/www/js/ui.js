// Formatting and small UI pieces shared by the screens.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = (d) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF = [nf(0), nf(1), nf(2)];

export function num(x, d = 2) {
  if (x == null || !Number.isFinite(+x)) return '—';
  return NF[d].format(+x);
}

// ₹ with Indian grouping; big amounts as lakhs (₹1.25 L).
export function inr(x, { sign = false, lakh = true } = {}) {
  if (x == null || !Number.isFinite(+x)) return '—';
  const v = +x;
  const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (lakh && a >= 100_000) return `${s}₹${num(a / 100_000, 2)} L`;
  return `${s}₹${num(a, 0)}`;
}

export function signed(x, d = 2) {
  if (x == null || !Number.isFinite(+x)) return '—';
  return (x > 0 ? '+' : x < 0 ? '−' : '') + num(Math.abs(x), d);
}

export const pct = (x, d = 2) => (x == null || !Number.isFinite(+x) ? '—' : signed(x, d) + '%');
export const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');

export function compact(x) {
  if (!Number.isFinite(+x)) return '—';
  const a = Math.abs(x);
  if (a >= 1e7) return num(x / 1e7, 2) + ' Cr';
  if (a >= 1e5) return num(x / 1e5, 1) + ' L';
  if (a >= 1e3) return num(x / 1e3, 1) + ' K';
  return num(x, 0);
}

export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, ms);
}

// A bottom sheet: html is its body; bind(root, close) wires its buttons. Returns close().
export function sheet(html, bind = () => {}) {
  const host = document.getElementById('sheet');
  host.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
  host.hidden = false;
  void host.offsetHeight; // lay out the closed state first so the slide-up animates
  host.classList.add('open');
  const close = () => {
    host.classList.remove('open');
    setTimeout(() => {
      host.hidden = true;
      host.innerHTML = '';
    }, 200);
  };
  host.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  bind(host.querySelector('.sheet-panel'), close);
  return close;
}

export function confirmSheet(text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const close = sheet(
      `<p class="sheet-text">${esc(text)}</p><div class="row gap"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`,
      (root) => {
        root.querySelector('[data-yes]').onclick = () => {
          done = true;
          resolve(true);
          close();
        };
        root.querySelector('[data-no]').onclick = () => {
          done = true;
          resolve(false);
          close();
        };
      },
    );
    document.querySelector('#sheet .sheet-backdrop')?.addEventListener('click', () => done || resolve(false));
  });
}

export const legLabel = (l) => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.lots} × ${l.strike} ${l.type}`;
