// Market: Nifty, India VIX, NIFTYBEES, today's Nifty chart, and a read of the nearest expiry's chain.
import { NIFTY, VIX, BEES } from '../market.js';
import { summary } from '../analytics.js';
import { lineChart } from '../charts.js';
import { num, signed, tone, esc } from '../ui.js';
import { fmtDate, daysTo, ist, marketOpen } from '../time.js';

let root;

function quoteCard(name, q, d = 2, big = false) {
  if (!q) return `<div class="card quote"><div class="q-name">${name}</div><div class="q-ltp">—</div></div>`;
  const p = q.prevClose ? (q.change / q.prevClose) * 100 : null;
  return `<div class="card quote ${big ? 'big' : ''}">
    <div class="q-name">${name}</div>
    <div class="q-ltp">${num(q.ltp, d)}</div>
    <div class="q-chg ${tone(q.change)}">${signed(q.change, d)} (${signed(p, 2)}%)</div>
    ${big ? `<div class="q-ohl"><span>O ${num(q.open, 0)}</span><span>H ${num(q.high, 0)}</span><span>L ${num(q.low, 0)}</span><span>PC ${num(q.prevClose, 0)}</span></div>` : ''}
  </div>`;
}

export default {
  id: 'market',
  title: 'Market',
  mount(el) {
    root = el;
    el.innerHTML = `
      <div id="mkLogin"></div>
      <div id="mkQuotes" class="quotes"><div class="card skeleton" style="height:120px"></div></div>
      <section class="card">
        <div class="card-head"><h2>Nifty today</h2><span class="muted small" id="mkSession"></span></div>
        <div id="mkChart" class="chart-box"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Nearest expiry</h2><span class="muted small" id="mkExp"></span></div>
        <div id="mkSnap" class="stats"></div>
      </section>`;
  },
  async refresh(ctx) {
    const login = root.querySelector('#mkLogin');
    login.innerHTML = ctx.needsLogin()
      ? `<div class="card notice"><b>Not logged in to Upstox.</b> Prices below are the last ones saved on this phone. <button class="btn small primary" data-go="settings">Log in</button> <button class="btn small" data-demo>Use demo data</button></div>`
      : '';
    login.querySelector('[data-go]')?.addEventListener('click', () => ctx.nav('settings'));
    login.querySelector('[data-demo]')?.addEventListener('click', () => ctx.setSource('demo'));

    const [qr, ir, cr] = await Promise.allSettled([ctx.market.quotes(), ctx.market.intraday(), ctx.market.contracts()]);
    if (qr.status === 'fulfilled') {
      const q = qr.value.data;
      ctx.report(qr.value);
      root.querySelector('#mkQuotes').innerHTML = quoteCard('NIFTY 50', q[NIFTY], 2, true) + `<div class="quotes-row">${quoteCard('INDIA VIX', q[VIX])}${quoteCard('NIFTYBEES', q[BEES])}</div>`;
    } else {
      ctx.report({ error: qr.reason });
      root.querySelector('#mkQuotes').innerHTML = `<div class="card error">${esc(qr.reason?.message)}</div>`;
    }
    root.querySelector('#mkSession').textContent = marketOpen() ? 'market open' : 'market closed';
    if (ir.status === 'fulfilled' && ir.value.data.length) {
      const c = ir.value.data;
      const prev = qr.status === 'fulfilled' ? qr.value.data[NIFTY]?.prevClose : null;
      lineChart(root.querySelector('#mkChart'), {
        series: [{ pts: c.map((k) => [k.t, k.c]), cls: tone(c[c.length - 1].c - (prev ?? c[0].o)) === 'down' ? 's-down' : 's-up', label: 'Nifty' }],
        height: 180,
        xFmt: (t) => {
          const x = ist(t);
          return `${x.hh}:${String(x.mm).padStart(2, '0')}`;
        },
        yFmt: (v) => num(v, 0),
        marks: [],
      });
    } else {
      root.querySelector('#mkChart').innerHTML = `<div class="chart-empty">${esc(ir.reason?.message || 'No candles yet today')}</div>`;
    }

    if (cr.status !== 'fulfilled') return;
    const exp = cr.value.data.expiries[0];
    if (!exp) return;
    try {
      const ch = await ctx.market.chain(exp);
      const s = summary(ch.data);
      root.querySelector('#mkExp').textContent = `${fmtDate(exp)} · ${daysTo(exp)} d`;
      root.querySelector('#mkSnap').innerHTML = [
        ['ATM', num(s.atm, 0)],
        ['ATM straddle', num(s.price, 2)],
        ['Implied move', s.move ? `±${num(s.move, 0)} (${num(s.movePct, 2)}%)` : '—'],
        ['PCR (OI)', num(s.pcr, 2)],
        ['Max pain', num(s.maxPain, 0)],
        ['Support · resistance', `${num(s.support, 0)} · ${num(s.resistance, 0)}`],
      ]
        .map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`)
        .join('');
    } catch (e) {
      root.querySelector('#mkSnap').innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  },
};
