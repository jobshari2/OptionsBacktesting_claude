// Shared by the Backtest, Compare, Strategies and Data screens: API + job polling, formatting,
// the strategy editor, the period/costs bar, chart defaults and option maths.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('bt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('bt.' + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- formatting ----------
  const inr = (n, dec = 0) => (n == null || isNaN(n) ? '—' : (n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  const inrS = (n, dec = 0) => (n > 0 ? '+' : '') + inr(n, dec);
  const kinr = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    const s = n < 0 ? '−₹' : '₹';
    if (a >= 1e7) return s + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(2) + ' L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + Math.round(a);
  };
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : x.toFixed(d) + '%');
  const num = (x, d = 2) => (x == null || isNaN(x) || !isFinite(x) ? '—' : x.toFixed(d));
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');
  const dayLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const dayShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REASON = { sl: 'Stop-loss', tgt: 'Target', 'exit-time': 'Exit time', 'mtm-sl': 'Overall SL', 'mtm-tgt': 'Overall target', 'lock-trail': 'Locked profit', 'leg-sl-all': 'Leg SL → exit all', expiry: 'Expired', 'legs-closed': 'All legs closed', roll: 'Rolled', partial: 'Partial booking' };

  // ---------- API ----------
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }
  // ctl (optional): set ctl.stop = true to ask the server to stop the job (kinds that support it end early with what they have).
  async function runJob(path, body, onProgress, ctl) {
    let job = await api(path, body);
    while (job.status === 'running') {
      onProgress?.(job.progress);
      if (ctl?.stop && !ctl.sent) { ctl.sent = true; await api('/api/bt/job/stop', { id: job.id }); }
      await sleep(200);
      job = await api('/api/bt/job?id=' + job.id);
    }
    if (job.status === 'error') throw new Error(job.error);
    return job;
  }

  // ---------- events + meta ----------
  const handlers = {};
  const on = (ev, fn) => (handlers[ev] ||= []).push(fn);
  const emit = (ev, d) => (handlers[ev] || []).forEach((fn) => fn(d));
  const meta = { library: [], saved: [], originals: {}, anomalies: [], calendar: null, loaded: false };
  let metaPromise = null;
  function loadMeta(force) {
    if (meta.loaded && !force) return Promise.resolve(meta);
    if (metaPromise && !force) return metaPromise;
    metaPromise = api('/api/bt/meta').then((m) => {
      Object.assign(meta, m, { loaded: true });
      metaPromise = null;
      emit('meta', meta);
      return meta;
    }).catch((e) => { metaPromise = null; throw e; });
    return metaPromise;
  }
  const allStrategies = () => [...meta.saved, ...meta.library];
  const findStrategy = (id) => allStrategies().find((s) => s.id === id) || null;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // override = true saves an edited built-in under its own id (it replaces the original until reset).
  async function saveStrategy(s, override = false) {
    const r = await api('/api/bt/strategies', { ...s, override });
    await loadMeta(true);
    return r.strategy;
  }
  async function resetStrategy(id) {
    const r = await api('/api/bt/strategies/reset', { id });
    await loadMeta(true);
    return r.strategy;
  }
  const anomalyType = (id) => meta.anomalies.find((t) => t.id === id) || null;
  async function deleteStrategy(id) {
    await api('/api/bt/strategies/delete', { id });
    await loadMeta(true);
  }

  // ---------- descriptions ----------
  const EXP_LABEL = { cur: 'This week', next: 'Next week', mcur: 'This month', mnext: 'Next month' };
  const EXP_SHORT = { cur: '', next: ' · next wk', mcur: ' · month', mnext: ' · next mth' };
  function strikeLabel(st) {
    const v = st.value;
    switch (st.by) {
      case 'atm': return v === 0 ? 'ATM' : v > 0 ? `OTM ${v}` : `ITM ${-v}`;
      case 'premium': return `${st.match === 'gte' ? '≥' : st.match === 'lte' ? '≤' : '≈'}₹${v}`;
      case 'delta': return `Δ ${v > 1 ? v / 100 : v}`;
      case 'pct': return `${v}% OTM`;
      case 'pts': return `${v} pts OTM`;
      case 'straddle': return `${v || 1}× straddle`;
      case 'signal': return `${st.ref === 'ref' ? 'pair' : 'signal'} strike${v ? (v > 0 ? ' +' : ' ') + v : ''}`;
      case 'sr': return `at ${st.lv && st.lv !== 'any' ? st.lv + ' ' : ''}S/R${v ? ' +' + v : ''}`;
      case 'leg': return `leg ${(st.ref ?? 0) + 1} ${v >= 0 ? '+' : '−'}${Math.abs(v)}`;
      default: return '?';
    }
  }
  const legLabel = (l) => `${l.action === 'B' ? 'Buy' : 'Sell'}${l.lots > 1 ? ' ' + l.lots + '×' : ''} ${l.type} ${strikeLabel(l.strike)}${EXP_SHORT[l.expiry] || ''}${l.roll ? ' ⟳' : ''}`;
  const legChips = (s) => s.legs.map((l) => `<span class="leg-chip ${l.action === 'B' ? 'buy' : 'sell'}">${esc(legLabel(l))}</span>`).join('');
  const CLS_TXT = { any: '', major: 'major ', minor: 'minor ' };
  function condLabel(c) {
    switch (c.kind) {
      case 'anomaly': {
        const t = anomalyType(c.type);
        return `${t ? t.name : c.type}${c.side && c.side !== 'any' ? ' ' + c.side : ''}${c.dir && c.dir !== 'any' ? ' (' + c.dir + ')' : ''}`;
      }
      case 'sr-near': return `within ${c.within} pts of ${CLS_TXT[c.cls] || ''}${c.side === 'either' ? 'S/R' : c.side}`;
      case 'sr-break': return `breaks ${c.dir === 'up' ? 'above ' + (CLS_TXT[c.cls] || '') + 'resistance' : c.dir === 'down' ? 'below ' + (CLS_TXT[c.cls] || '') + 'support' : 'through ' + (CLS_TXT[c.cls] || '') + 'S/R'}`;
      case 'move': return `Nifty ${c.dir === 'up' ? 'up' : c.dir === 'down' ? 'down' : 'moved'} ${c.op === 'gte' ? '≥' : '≤'} ${c.value}${c.unit === 'pct' ? '%' : ' pts'} from ${c.from === 'open' ? 'open' : 'prev close'}`;
      case 'range': return `day range ${c.op === 'gte' ? '≥' : '≤'} ${c.value} pts`;
      default: return c.kind;
    }
  }
  function timingLabel(s) {
    if (s.entry?.when === 'signal') {
      const conds = (s.entry.conditions || []).map(condLabel).join(' + ') || 'no conditions';
      const where = s.mode === 'intraday' ? `${s.entry.time}–${s.entry.until}` : `${s.entry.dteDays}d before expiry ${s.entry.time}–${s.entry.until}`;
      return `On signal ${where}: ${conds}${s.entry.maxTrades > 1 ? ` · up to ${s.entry.maxTrades}/day` : ''} · exit ${s.mode === 'intraday' ? s.exit.time : (s.exit.dteDays ? s.exit.dteDays + 'd before ' : 'expiry ') + s.exit.time}`;
    }
    if (s.mode === 'intraday') {
      const days = s.entry.days.length === 5 ? 'every day' : s.entry.days.map((d) => WD[d]).join(', ');
      const dte = s.entry.dte?.length ? ` · DTE ${s.entry.dte.join(',')}` : '';
      return `Intraday ${s.entry.time}–${s.exit.time} · ${days}${dte} · ${s.expiry}`;
    }
    const enter = s.entry.after ? `enter the day after the expiry ${s.entry.after} week${s.entry.after > 1 ? 's' : ''} before` : `enter ${s.entry.dteDays}d before`;
    return `Positional · ${enter} ${s.expiry} expiry ${s.entry.time} → exit ${s.exit.dteDays ? s.exit.dteDays + 'd before' : 'expiry day'} ${s.exit.time}${s.entry.noOverlap ? ' · one at a time' : ''}`;
  }

  // ---------- strategy editor ----------
  const blankLeg = (o = {}) => ({ action: 'S', type: 'CE', lots: 1, expiry: 'cur', strike: { by: 'atm', value: 0, match: 'closest' }, sl: { type: 'none', value: 0 }, tgt: { type: 'none', value: 0 }, trail: null, re: null, roll: null, ...o });
  const blankStrategy = () => ({
    id: null, name: 'My strategy', desc: '', category: 'Custom', mode: 'intraday', expiry: 'weekly',
    entry: { time: '09:20', days: [1, 2, 3, 4, 5], dte: [], dteDays: 3, after: 0, noOverlap: false, when: 'time', until: '14:30', maxTrades: 1, conditions: [] }, exit: { time: '15:15', dteDays: 0 },
    legs: [blankLeg({ type: 'CE' }), blankLeg({ type: 'PE' })],
    risk: { sl: null, tgt: null, slPrem: null, tgtPrem: null, lockAt: null, lockTo: 0, trailEvery: null, trailBy: null, onLegSl: 'leg', slToCost: false, unit: 'inr', partialAt: null, partialPct: 60, partialFloor: null },
    filters: { vixMin: null, vixMax: null, minCredit: null, maxLossDown: null, maxLossUp: null },
  });
  // Fill any missing fields (older saves, library entries).
  function complete(s) {
    const b = blankStrategy();
    const out = { ...b, ...clone(s) };
    out.entry = { ...b.entry, ...(s.entry || {}) };
    out.entry.conditions = clone(out.entry.conditions || []);
    out.exit = { ...b.exit, ...(s.exit || {}) };
    out.risk = { ...b.risk, ...(s.risk || {}) };
    out.filters = { ...b.filters, ...(s.filters || {}) };
    out.legs = (s.legs || []).map((l) => ({ ...blankLeg(), ...l, strike: { ...blankLeg().strike, ...(l.strike || {}) }, sl: l.sl || { type: 'none', value: 0 }, tgt: l.tgt || { type: 'none', value: 0 } }));
    return out;
  }

  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) {
    const ks = p.split('.');
    let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }

  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const seg = (path, cur, items, rerender = true) => `<div class="seg sm">${items.map(([v, l]) => `<button type="button" data-set="${path}" data-val="${esc(JSON.stringify(v))}"${rerender ? ' data-rerender' : ''} class="${JSON.stringify(cur) === JSON.stringify(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const numIn = (path, v, attrs = '') => `<input class="num" type="number" data-path="${path}" data-type="num" value="${v ?? ''}" ${attrs}>`;

  function createEditor(el, onChange) {
    let S = blankStrategy();

    function render() {
      const s = S;
      const legHtml = s.legs.map((l, i) => {
        const p = `legs.${i}`;
        const st = l.strike;
        let strikeCtl;
        if (st.by === 'atm') {
          strikeCtl = `<select data-path="${p}.strike.value" data-type="num">${Array.from({ length: 36 }, (_, j) => j - 10).map((v) => opt(v, v === 0 ? 'ATM' : v > 0 ? `OTM ${v}` : `ITM ${-v}`, st.value)).join('')}</select>`;
        } else if (st.by === 'signal') {
          strikeCtl = `<select data-path="${p}.strike.ref" title="Which strike of the anomaly: the one it flagged, or its pair (the higher strike of a vertical)">${opt('hit', 'flagged strike', st.ref || 'hit')}${opt('ref', 'paired strike', st.ref)}</select>
            <select data-path="${p}.strike.value" data-type="num" title="Strikes above (+) or below (−) it">${Array.from({ length: 13 }, (_, j) => j - 6).map((v) => opt(v, v === 0 ? '± 0' : v > 0 ? `+${v} higher` : `${v} lower`, st.value)).join('')}</select>`;
        } else if (st.by === 'sr') {
          strikeCtl = `<select data-path="${p}.strike.lv" title="Calls: nearest resistance above spot · puts: nearest support below">${opt('any', 'nearest level', st.lv || 'any')}${opt('major', 'nearest major', st.lv)}${opt('minor', 'nearest minor', st.lv)}</select>
            <select data-path="${p}.strike.value" data-type="num">${Array.from({ length: 9 }, (_, j) => j - 2).map((v) => opt(v, v === 0 ? 'at the level' : v > 0 ? `+${v} beyond` : `${-v} inside`, st.value)).join('')}</select>`;
        } else if (st.by === 'leg') {
          strikeCtl = `<select data-path="${p}.strike.ref" data-type="num" title="The leg whose strike this one is measured from">${s.legs.map((_, j) => (j === i ? '' : opt(j, `leg ${j + 1}`, st.ref ?? 0))).join('')}</select>
            ${numIn(`${p}.strike.value`, st.value, 'step="50"')} <span class="muted">pts (+ above, − below)</span>`;
        } else if (st.by === 'premium') {
          strikeCtl = `<select data-path="${p}.strike.match">${opt('closest', 'closest to', st.match)}${opt('gte', 'at least', st.match)}${opt('lte', 'at most', st.match)}</select> ₹${numIn(`${p}.strike.value`, st.value, 'min="0.5" step="1"')}`;
        } else {
          const unit = { delta: 'Δ', pct: '% OTM', pts: 'pts OTM', straddle: '× ATM straddle' }[st.by];
          const step = { delta: '0.05', pct: '0.25', pts: '50', straddle: '0.25' }[st.by];
          strikeCtl = `${numIn(`${p}.strike.value`, st.value, `step="${step}" min="0"`)} <span class="muted">${unit}</span>`;
        }
        const lvlSel = (k, cur) => `<select data-path="${p}.${k}.type" data-rerender>${opt('none', 'None', cur.type)}${opt('pct', '% of premium', cur.type)}${opt('pts', '₹ points', cur.type)}${opt('upct', 'Nifty move %', cur.type)}${opt('upts', 'Nifty move pts', cur.type)}${opt('srb', k === 'sl' ? 'Nifty through S/R' : 'Nifty reaches S/R', cur.type)}</select>${cur.type === 'srb'
          ? `<select data-path="${p}.${k}.lv">${opt('any', 'nearest level', cur.lv || 'any')}${opt('major', 'nearest major', cur.lv)}${opt('minor', 'nearest minor', cur.lv)}</select> <span class="muted" title="${k === 'sl' ? 'Exit once Nifty closes this many points beyond the level against the leg' : 'Exit once Nifty closes within this many points of the level in the leg\'s favour'}">±</span>${numIn(`${p}.${k}.value`, cur.value, 'min="0" step="5"')}<span class="muted">pts</span>`
          : cur.type !== 'none' ? numIn(`${p}.${k}.value`, cur.value, 'min="0" step="any"') : ''}`;
        const canTrail = ['pct', 'pts'].includes(l.sl.type);
        const re = l.re || { on: 'off', mode: 'asap', max: 1 };
        return `<div class="leg-card ${l.action === 'B' ? 'buy' : 'sell'}">
          <div class="leg-top">
            <span class="leg-no">${i + 1}</span>
            ${seg(`${p}.action`, l.action, [['B', 'Buy'], ['S', 'Sell']])}
            ${seg(`${p}.type`, l.type, [['CE', 'CE'], ['PE', 'PE']])}
            <label class="mini">Lots ${numIn(`${p}.lots`, l.lots, 'min="1" max="100" step="1"')}</label>
            <select data-path="${p}.expiry" title="Which expiry this leg trades">${Object.entries(EXP_LABEL).map(([v, t]) => opt(v, t, l.expiry)).join('')}</select>
            <span class="leg-tools"><button type="button" class="icon" data-act="dup" data-i="${i}" title="Duplicate leg">⧉</button><button type="button" class="icon" data-act="del" data-i="${i}" title="Remove leg">✕</button></span>
          </div>
          <div class="leg-row"><span class="lbl">Strike</span>
            <select data-path="${p}.strike.by" data-rerender>${opt('atm', 'ATM ± strikes', st.by)}${opt('premium', 'Premium ₹', st.by)}${opt('delta', 'Delta', st.by)}${opt('pct', '% from spot', st.by)}${opt('pts', 'Points from spot', st.by)}${opt('straddle', 'Straddle width', st.by)}${opt('signal', 'Anomaly strike', st.by)}${opt('sr', 'Support / resistance', st.by)}${s.legs.length > 1 ? opt('leg', 'From another leg', st.by) : ''}</select>
            ${strikeCtl}</div>
          <div class="leg-row"><span class="lbl">Stop-loss</span>${lvlSel('sl', l.sl)}</div>
          <div class="leg-row"><span class="lbl">Target</span>${lvlSel('tgt', l.tgt)}</div>
          <div class="leg-row${canTrail ? '' : ' off'}"><span class="lbl">Trail SL</span>
            <label class="chk"><input type="checkbox" data-act="trail" data-i="${i}" ${l.trail ? 'checked' : ''} ${canTrail ? '' : 'disabled'}> every</label>
            ${l.trail ? `${numIn(`${p}.trail.x`, l.trail.x, 'min="0" step="any"')} <span class="muted">move SL</span> ${numIn(`${p}.trail.y`, l.trail.y, 'min="0" step="any"')} <span class="muted">${l.sl.type === 'pct' ? '%' : 'pts'}</span>` : `<span class="muted small">${canTrail ? 'off' : 'needs a % or points stop'}</span>`}
          </div>
          <div class="leg-row"><span class="lbl">Re-entry</span>
            <select data-act="re-on" data-i="${i}">${opt('off', 'Off', re.on)}${opt('sl', 'After SL', re.on)}${opt('tgt', 'After target', re.on)}${opt('both', 'After SL or target', re.on)}</select>
            ${l.re ? `<select data-path="${p}.re.mode">${opt('asap', 'Immediately, same strike', re.mode)}${opt('cost', 'When price returns to entry', re.mode)}${opt('atm', 'Immediately, fresh strike', re.mode)}</select> <label class="mini">max ${numIn(`${p}.re.max`, re.max, 'min="1" max="10" step="1"')}</label>` : ''}
          </div>
          ${s.mode === 'positional' ? `<div class="leg-row"><span class="lbl">Roll</span>
            <label class="chk" title="Close this leg and open the same strike in the next weekly expiry before it expires (e.g. a near-week hedge moved into the main expiry)"><input type="checkbox" data-act="roll" data-i="${i}" ${l.roll ? 'checked' : ''}> into the next expiry</label>
            ${l.roll ? `${numIn(`${p}.roll.dteDays`, l.roll.dteDays, 'min="0" max="5" step="1"')} <span class="muted">trading days before its expiry at</span> <input type="time" data-path="${p}.roll.time" value="${l.roll.time}" step="60">` : ''}
          </div>` : ''}
        </div>`;
      }).join('');

      const r = s.risk;
      const days = [1, 2, 3, 4, 5];
      const dtes = [0, 1, 2, 3, 4, 5, 6];
      el.innerHTML = `
        <div class="ed-sec">
          <input class="txt name" data-path="name" value="${esc(s.name)}" placeholder="Strategy name" maxlength="80">
          <textarea class="txt desc" data-path="desc" rows="2" placeholder="Notes (optional)">${esc(s.desc)}</textarea>
          <div class="ed-row"><span class="lbl">Type</span>${seg('mode', s.mode, [['intraday', 'Intraday'], ['positional', 'Positional (multi-day)']])}</div>
          <div class="ed-row"><span class="lbl">Expiry cycle</span>${seg('expiry', s.expiry, [['weekly', 'Weekly'], ['monthly', 'Monthly']])}
            <span class="muted small">${s.mode === 'intraday' ? 'DTE is counted to this expiry' : 'one trade per expiry'}</span></div>
        </div>
        <div class="ed-sec">
          <h4>Entry &amp; exit</h4>
          ${s.mode === 'intraday' ? `
            <div class="ed-row"><span class="lbl">Entry</span><input type="time" data-path="entry.time" value="${s.entry.time}" min="09:15" max="15:29" step="60">
              <span class="lbl r">Exit</span><input type="time" data-path="exit.time" value="${s.exit.time}" min="09:16" max="15:30" step="60"></div>
            <div class="ed-row"><span class="lbl">Weekdays</span><div class="chips">${days.map((d) => `<button type="button" class="chip${s.entry.days.includes(d) ? ' on' : ''}" data-act="day" data-v="${d}">${WD[d]}</button>`).join('')}</div></div>
            <div class="ed-row"><span class="lbl">Days to expiry</span><div class="chips">${dtes.map((d) => `<button type="button" class="chip${s.entry.dte.includes(d) ? ' on' : ''}" data-act="dte" data-v="${d}" title="${d === 0 ? 'Expiry day' : d + ' trading day(s) before expiry'}">${d === 0 ? 'Expiry' : d}</button>`).join('')}</div>
              <span class="muted small">${s.entry.dte.length ? '' : 'none selected = all days'}</span></div>`
          : `
            <div class="ed-row"><span class="lbl">Enter on</span>${seg('entry.after', s.entry.after ? 2 : 0, [[0, 'Days before expiry'], [2, 'Start of a series']])}</div>
            ${s.entry.after ? `<div class="ed-row wrap"><span class="lbl">Enter</span><span class="muted">the trading day after the expiry</span>${numIn('entry.after', s.entry.after, 'min="1" max="6" step="1"')}<span class="muted">weeks before this one, at</span><input type="time" data-path="entry.time" value="${s.entry.time}" step="60"></div>`
              : `<div class="ed-row"><span class="lbl">Enter</span>${numIn('entry.dteDays', s.entry.dteDays, 'min="0" max="40" step="1"')}<span class="muted">trading days before expiry at</span><input type="time" data-path="entry.time" value="${s.entry.time}" step="60"></div>`}
            <div class="ed-row"><span class="lbl">Exit</span>${numIn('exit.dteDays', s.exit.dteDays, 'min="0" max="40" step="1"')}<span class="muted">days before expiry (0 = expiry day) at</span><input type="time" data-path="exit.time" value="${s.exit.time}" step="60"></div>
            <div class="ed-row"><span class="lbl"></span><label class="chk" title="Skip a trade whose entry falls while the previous trade is still open"><input type="checkbox" data-path="entry.noOverlap" data-type="bool" ${s.entry.noOverlap ? 'checked' : ''}> One position at a time</label></div>
            <div class="muted small ed-hint">Held overnight. With a ${s.expiry} cycle this places one trade per ${s.expiry === 'weekly' ? 'week' : 'month'}; ${s.entry.after > 1 || s.entry.dteDays >= 5 ? 'spanning multiple weeks' : 'within the expiry week'}.${s.entry.after ? ' "This week" legs then trade the first expiry after entry, "next week" the one after.' : ''}</div>`}
        </div>
        ${triggerHtml(s)}
        <div class="ed-sec">
          <h4>Legs <span class="muted small">${s.legs.length}/12</span></h4>
          ${legHtml || '<div class="muted small">No legs yet.</div>'}
          <div class="add-legs">
            <button type="button" class="btn-sm ghost" data-act="add">+ Add leg</button>
            <button type="button" class="btn-sm ghost" data-act="add-straddle" title="Add an ATM call and put">+ Straddle</button>
            <button type="button" class="btn-sm ghost" data-act="add-wings" title="Add OTM 6 buy wings for protection">+ Hedge wings</button>
          </div>
        </div>
        <div class="ed-sec">
          <h4>Overall position</h4>
          <div class="ed-row"><span class="lbl">Amounts in</span>${seg('risk.unit', r.unit || 'inr', [['inr', '₹'], ['pct', '% of capital']])}
            <span class="muted small">${r.unit === 'pct' ? 'capital = the Capital box in the settings, else the trade\'s estimated margin' : ''}</span></div>
          <div class="ed-row"><span class="lbl">Stop-loss</span>${numIn('risk.sl', r.sl, `min="0" step="${r.unit === 'pct' ? '0.5' : '500'}" placeholder="none"`)}
            <span class="lbl r">Target</span>${numIn('risk.tgt', r.tgt, `min="0" step="${r.unit === 'pct' ? '0.5' : '500'}" placeholder="none"`)}</div>
          <div class="ed-row wrap" title="Overall stop / target as a % of the net premium at entry: the credit received or the debit paid. These are the rules the scenario table tests."><span class="lbl">% of premium</span><span class="muted">stop</span>${numIn('risk.slPrem', r.slPrem, 'min="0" step="5" placeholder="none"')}
            <span class="muted">target</span>${numIn('risk.tgtPrem', r.tgtPrem, 'min="0" step="5" placeholder="none"')}<span class="muted small">of the entry credit / debit</span></div>
          <div class="ed-row wrap"><span class="lbl">Partial booking</span><span class="muted">when MTM reaches</span>${numIn('risk.partialAt', r.partialAt, `min="0" step="${r.unit === 'pct' ? '0.1' : '500'}" placeholder="—"`)}
            <span class="muted">book</span>${numIn('risk.partialPct', r.partialPct ?? 60, 'min="1" max="99" step="5"')}<span class="muted">% of the lots, then keep a floor of</span>${numIn('risk.partialFloor', r.partialFloor, `step="${r.unit === 'pct' ? '0.1' : '500'}" placeholder="—"`)}</div>
          <div class="ed-row wrap"><span class="lbl">Lock profit</span><span class="muted">when MTM reaches</span>${numIn('risk.lockAt', r.lockAt, 'min="0" step="500" placeholder="—"')}
            <span class="muted">lock</span>${numIn('risk.lockTo', r.lockTo || null, 'step="500" placeholder="0"')}</div>
          <div class="ed-row wrap"><span class="lbl">Then trail</span><span class="muted">every</span>${numIn('risk.trailEvery', r.trailEvery, 'min="0" step="500" placeholder="—"')}
            <span class="muted">raise lock by</span>${numIn('risk.trailBy', r.trailBy, 'min="0" step="100" placeholder="—"')}</div>
          <div class="ed-row"><span class="lbl">Leg stop hit</span>${seg('risk.onLegSl', r.onLegSl, [['leg', 'Exit that leg'], ['all', 'Exit all legs']], false)}</div>
          <div class="ed-row"><span class="lbl"></span><label class="chk"><input type="checkbox" data-path="risk.slToCost" data-type="bool" ${r.slToCost ? 'checked' : ''}> Move other legs' stop to cost after a leg stop</label></div>
        </div>
        <div class="ed-sec">
          <h4>Filters</h4>
          <div class="ed-row"><span class="lbl">India VIX</span><span class="muted">from</span>${numIn('filters.vixMin', s.filters.vixMin, 'min="0" step="0.5" placeholder="any"')}<span class="muted">to</span>${numIn('filters.vixMax', s.filters.vixMax, 'min="0" step="0.5" placeholder="any"')}<span class="muted small">at entry</span></div>
          <div class="ed-row wrap"><span class="lbl">Net credit</span><span class="muted">at least</span>${numIn('filters.minCredit', s.filters.minCredit, 'min="0" step="5" placeholder="any"')}<span class="muted">pts per lot at entry</span></div>
          <div class="ed-row wrap"><span class="lbl">Max loss far</span><span class="muted">below</span>${numIn('filters.maxLossDown', s.filters.maxLossDown, 'min="0" step="5" placeholder="any"')}<span class="muted">above</span>${numIn('filters.maxLossUp', s.filters.maxLossUp, 'min="0" step="5" placeholder="any"')}<span class="muted small">pts per lot at expiry (every leg at intrinsic): skip the trade otherwise</span></div>
        </div>`;
    }

    // Entry trigger: at the entry time, or on the first minute (from the entry time until "until") where all
    // conditions hold.
    function triggerHtml(s) {
      const e = s.entry;
      const sigOn = e.when === 'signal';
      const condHtml = (e.conditions || []).map((c, i) => {
        const p = `entry.conditions.${i}`;
        const del = `<button type="button" class="icon" data-act="cond-del" data-i="${i}" title="Remove condition">✕</button>`;
        const clsSel = `<select data-path="${p}.cls">${opt('any', 'any level', c.cls)}${opt('major', 'major', c.cls)}${opt('minor', 'minor', c.cls)}</select>`;
        let body = '';
        if (c.kind === 'anomaly') {
          const t = anomalyType(c.type);
          const types = (t ? '' : opt(c.type, `${c.type} (removed — never fires)`, c.type)) + meta.anomalies.map((x) => opt(x.id, x.name, c.type)).join('');
          body = `<div class="cond-row"><b>Anomaly</b><select data-path="${p}.type" data-rerender data-cond-type>${types}</select>
            <select data-path="${p}.side" title="Option side the anomaly is on">${opt('any', 'any side', c.side)}${opt('CE', 'CE', c.side)}${opt('PE', 'PE', c.side)}</select>
            <select data-path="${p}.dir">${opt('any', 'any direction', c.dir)}${(t?.dirs || []).map((d) => opt(d, d, c.dir)).join('')}</select>${del}</div>
            ${t ? `<div class="cond-params">${t.params.map((q) => `<label class="mini" title="${esc(q.label)}">${esc(q.label)} ${numIn(`${p}.params.${q.k}`, c.params?.[q.k] ?? q.def, `step="${q.step}"`)}<span class="muted">${esc(q.unit)}</span></label>`).join('')}</div>
            <div class="muted small">${esc(t.desc)}</div>` : ''}`;
        } else if (c.kind === 'sr-near') {
          body = `<div class="cond-row"><b>Near S/R</b>Nifty within ${numIn(`${p}.within`, c.within, 'min="0" step="5"')} pts of ${clsSel}
            <select data-path="${p}.side">${opt('either', 'support or resistance', c.side)}${opt('support', 'support (below)', c.side)}${opt('resistance', 'resistance (above)', c.side)}</select>${del}</div>`;
        } else if (c.kind === 'sr-break') {
          body = `<div class="cond-row"><b>S/R break</b>Nifty closes <select data-path="${p}.dir">${opt('up', 'above resistance', c.dir)}${opt('down', 'below support', c.dir)}${opt('either', 'through a level', c.dir)}</select> ${clsSel}
            by ${numIn(`${p}.buffer`, c.buffer, 'min="0" step="5"')} pts${del}</div>`;
        } else if (c.kind === 'move') {
          body = `<div class="cond-row"><b>Nifty move</b><select data-path="${p}.dir">${opt('up', 'up', c.dir)}${opt('down', 'down', c.dir)}${opt('abs', 'either way', c.dir)}</select>
            <select data-path="${p}.op">${opt('gte', 'at least', c.op)}${opt('lte', 'at most', c.op)}</select>${numIn(`${p}.value`, c.value, 'min="0" step="any"')}
            <select data-path="${p}.unit">${opt('pts', 'pts', c.unit)}${opt('pct', '%', c.unit)}</select> from <select data-path="${p}.from">${opt('open', 'open', c.from)}${opt('prevClose', 'prev close', c.from)}</select>${del}</div>`;
        } else if (c.kind === 'range') {
          body = `<div class="cond-row"><b>Day range</b>high − low since open <select data-path="${p}.op">${opt('gte', 'at least', c.op)}${opt('lte', 'at most', c.op)}</select>${numIn(`${p}.value`, c.value, 'min="0" step="10"')} pts${del}</div>`;
        }
        return `<div class="cond-card">${body}</div>`;
      }).join('');
      return `<div class="ed-sec">
        <h4>Entry trigger</h4>
        <div class="ed-row"><span class="lbl">Enter</span>${seg('entry.when', e.when || 'time', [['time', 'At the entry time'], ['signal', 'On a signal']])}</div>
        ${sigOn ? `
          <div class="ed-row"><span class="lbl">Watch</span><span class="muted">from the entry time${s.mode === 'intraday' ? '' : ' on the entry day'} until</span><input type="time" data-path="entry.until" value="${e.until || '14:30'}" step="60">
            <label class="mini">max ${numIn('entry.maxTrades', e.maxTrades || 1, 'min="1" max="5" step="1"')} trades/day</label></div>
          <div class="muted small ed-hint">Enters at the next minute's open once every condition below holds. After an intraday trade closes, it keeps watching for the next signal.</div>
          ${condHtml || '<div class="muted small">Add at least one condition.</div>'}
          <div class="add-legs">
            <button type="button" class="btn-sm ghost" data-act="cond-add" data-kind="anomaly">+ Anomaly</button>
            <button type="button" class="btn-sm ghost" data-act="cond-add" data-kind="sr-near">+ Near S/R</button>
            <button type="button" class="btn-sm ghost" data-act="cond-add" data-kind="sr-break">+ S/R break</button>
            <button type="button" class="btn-sm ghost" data-act="cond-add" data-kind="move">+ Nifty move</button>
            <button type="button" class="btn-sm ghost" data-act="cond-add" data-kind="range">+ Day range</button>
          </div>` : ''}
      </div>`;
    }

    const changed = () => onChange?.(S);

    el.addEventListener('input', (e) => {
      const t = e.target;
      const p = t.dataset.path;
      if (!p) return;
      let v = t.value;
      if (t.dataset.type === 'num') v = v === '' ? null : Number(v);
      if (t.dataset.type === 'bool') v = t.checked;
      setPath(S, p, v);
      changed();
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.rerender !== undefined) {
        if (t.dataset.condType !== undefined) {
          const c = getPath(S, t.dataset.path.replace(/\.type$/, ''));
          c.params = {};
          c.dir = 'any';
          c.side = 'any';
        }
        if (t.dataset.path.endsWith('.strike.by')) {
          const leg = getPath(S, t.dataset.path.replace(/\.strike\.by$/, ''));
          leg.strike.value = { atm: 0, premium: 50, delta: 0.25, pct: 1, pts: 200, straddle: 1, signal: 0, sr: 0, leg: 100 }[t.value];
          if (t.value === 'leg') { const i = Number(t.dataset.path.split('.')[1]); leg.strike.ref = i > 0 ? i - 1 : 1; leg.strike.value = leg.type === 'CE' ? 100 : -100; }
          if (t.value === 'signal') leg.strike.ref = 'hit';
          if (t.value === 'sr') leg.strike.lv = 'any';
        }
        if (/\.(sl|tgt)\.type$/.test(t.dataset.path)) {
          const lvl = getPath(S, t.dataset.path.replace(/\.type$/, ''));
          if (!lvl.value || t.value === 'srb') lvl.value = { pct: 25, pts: 20, upct: 0.5, upts: 100, none: 0, srb: 10 }[t.value];
          if (t.value === 'srb') lvl.lv = lvl.lv || 'any';
          const leg = getPath(S, t.dataset.path.replace(/\.(sl|tgt)\.type$/, ''));
          if (!['pct', 'pts'].includes(leg.sl.type)) leg.trail = null;
        }
        render();
        changed();
      }
      if (t.dataset.act === 're-on') {
        const leg = S.legs[Number(t.dataset.i)];
        leg.re = t.value === 'off' ? null : { mode: 'asap', max: 1, ...(leg.re || {}), on: t.value };
        render();
        changed();
      }
      if (t.dataset.act === 'roll') {
        const leg = S.legs[Number(t.dataset.i)];
        leg.roll = t.checked ? { dteDays: 1, time: '15:15' } : null;
        render();
        changed();
      }
      if (t.dataset.act === 'trail') {
        const leg = S.legs[Number(t.dataset.i)];
        leg.trail = t.checked ? { x: leg.sl.type === 'pct' ? 10 : 10, y: leg.sl.type === 'pct' ? 5 : 5 } : null;
        render();
        changed();
      }
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.set) {
        setPath(S, b.dataset.set, JSON.parse(b.dataset.val));
        if (b.dataset.set === 'expiry') S.legs.forEach((l) => { if (S.expiry === 'monthly' && l.expiry === 'cur') l.expiry = 'mcur'; if (S.expiry === 'weekly' && l.expiry === 'mcur') l.expiry = 'cur'; });
        if (b.dataset.set === 'mode' && S.mode === 'positional' && !S.entry.dteDays) S.entry.dteDays = 3;
        if (b.dataset.set === 'entry.when' && S.entry.when === 'signal' && !S.entry.conditions.length) S.entry.conditions.push({ kind: 'sr-near', cls: 'any', side: 'either', within: 30 });
        render();
        changed();
        return;
      }
      const act = b.dataset.act;
      const i = Number(b.dataset.i);
      const exp = S.expiry === 'monthly' ? 'mcur' : 'cur';
      if (act === 'add') S.legs.push(blankLeg({ expiry: exp }));
      else if (act === 'add-straddle') S.legs.push(blankLeg({ type: 'CE', expiry: exp }), blankLeg({ type: 'PE', expiry: exp }));
      else if (act === 'add-wings') S.legs.push(blankLeg({ action: 'B', type: 'CE', expiry: exp, strike: { by: 'atm', value: 6, match: 'closest' } }), blankLeg({ action: 'B', type: 'PE', expiry: exp, strike: { by: 'atm', value: 6, match: 'closest' } }));
      else if (act === 'dup') S.legs.splice(i + 1, 0, clone(S.legs[i]));
      else if (act === 'del') S.legs.splice(i, 1);
      else if (act === 'cond-del') S.entry.conditions.splice(i, 1);
      else if (act === 'cond-add') {
        const k = b.dataset.kind;
        const first = meta.anomalies[0]?.id || 'varb';
        S.entry.conditions.push({
          anomaly: { kind: k, type: first, params: {}, side: 'any', dir: 'any' },
          'sr-near': { kind: k, cls: 'any', side: 'either', within: 30 },
          'sr-break': { kind: k, cls: 'any', dir: 'up', buffer: 5 },
          move: { kind: k, from: 'open', dir: 'abs', op: 'gte', unit: 'pts', value: 80 },
          range: { kind: k, op: 'gte', value: 120 },
        }[k]);
        S.entry.conditions = S.entry.conditions.slice(0, 6);
      }
      else if (act === 'day' || act === 'dte') {
        const list = act === 'day' ? S.entry.days : S.entry.dte;
        const v = Number(b.dataset.v);
        const k = list.indexOf(v);
        if (k >= 0) list.splice(k, 1); else list.push(v);
        list.sort((x, y) => x - y);
        if (act === 'day' && !list.length) list.push(v);
      } else return;
      S.legs = S.legs.slice(0, 12);
      render();
      changed();
    });

    return {
      get: () => clone(S),
      set(s) { S = complete(s); render(); },
    };
  }

  // ---------- period / costs bar ----------
  // onStop (optional): adds a Stop button next to the run button while a run is busy.
  function createSettings(el, { runLabel = 'Run backtest', onRun, onStop, key = 'settings' }) {
    const def = { from: null, to: null, expiries: null, slippage: 0.5, brokerage: 20, taxes: true, lotMode: 'fixed', lotSize: null, capital: null };
    const S = { ...def, ...store.get(key, {}) };
    let busy = false;

    function cal() { return meta.calendar; }
    function bounds() {
      const c = cal();
      if (!c?.expired?.length) return null;
      return { first: addDays(c.expired[0], -7), last: c.expired[c.expired.length - 1] };
    }
    function addDays(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10); }
    function ensure() {
      const b = bounds();
      if (!b) return;
      if (!S.to || S.to > b.last) S.to = b.last;
      if (!S.from || S.from < b.first) S.from = addDays(S.to, -182) < b.first ? b.first : addDays(S.to, -182);
      if (!S.lotSize) S.lotSize = cal().liveLot || 65;
    }
    const inPeriod = () => (cal()?.expired || []).filter((e) => e >= S.from && e <= S.to);
    function expLabel() {
      if (!S.expiries) return `All expiries (${inPeriod().length})`;
      const n = S.expiries.filter((e) => e >= S.from && e <= S.to).length;
      return `${n} selected expir${n === 1 ? 'y' : 'ies'}`;
    }

    function render() {
      ensure();
      const b = bounds();
      el.innerHTML = `
        <div class="set-row">
          <span class="lbl">Period</span>
          <input type="date" data-k="from" value="${S.from || ''}" min="${b?.first || ''}" max="${b?.last || ''}">
          <span class="muted">→</span>
          <input type="date" data-k="to" value="${S.to || ''}" min="${b?.first || ''}" max="${b?.last || ''}">
          <div class="seg sm" data-quick>${[['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365], ['All', 0]].map(([l, d]) => `<button type="button" data-days="${d}">${l}</button>`).join('')}</div>
          <div class="exp-pick">
            <button type="button" class="btn-sm ghost" data-act="exp">${esc(expLabel())} ▾</button>
            <div class="exp-pop hidden"></div>
          </div>
          <span class="spacer"></span>
          ${onStop ? `<button type="button" class="btn-sm ghost danger${busy ? '' : ' hidden'}" data-act="stop" title="Stop now and keep what has been found so far">■ Stop</button>` : ''}
          <button type="button" class="btn-sm run" data-act="run" ${busy ? 'disabled' : ''}>▶ ${esc(runLabel)}</button>
        </div>
        <div class="set-row costs">
          <span class="lbl">Lot size</span>
          <div class="seg sm">${[['fixed', 'Fixed'], ['historical', 'As traded']].map(([v, l]) => `<button type="button" data-k="lotMode" data-v="${v}" class="${S.lotMode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          ${S.lotMode === 'fixed' ? `<input class="num" type="number" data-k="lotSize" value="${S.lotSize}" min="1" step="1" title="Quantity per lot used for every trade (today's Nifty lot: ${cal()?.liveLot || '—'})">` : '<span class="muted small" title="Lot size from each expiry\'s contract data (it went 25 → 75 → 65 over this history)">from contract data</span>'}
          <span class="lbl">Slippage</span><input class="num" type="number" data-k="slippage" value="${S.slippage}" min="0" max="5" step="0.1"><span class="muted">%</span>
          <span class="lbl">Brokerage</span><span class="muted">₹</span><input class="num" type="number" data-k="brokerage" value="${S.brokerage}" min="0" step="1"><span class="muted">/order</span>
          <label class="chk"><input type="checkbox" data-k="taxes" ${S.taxes ? 'checked' : ''}> STT, exchange &amp; GST</label>
          <span class="lbl">Capital</span><span class="muted">₹</span><input class="num wide" type="number" data-k="capital" value="${S.capital ?? ''}" min="0" step="10000" placeholder="auto (margin)">
        </div>
        <div class="progress hidden"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>`;
    }

    function renderPop() {
      const pop = el.querySelector('.exp-pop');
      const list = inPeriod();
      const sel = new Set(S.expiries || list);
      const monthly = new Set(cal()?.monthly || []);
      const byMonth = {};
      for (const e of list) (byMonth[e.slice(0, 7)] ||= []).push(e);
      pop.innerHTML = `
        <div class="pop-tools">
          <button type="button" class="btn-sm ghost" data-pick="all">All</button>
          <button type="button" class="btn-sm ghost" data-pick="none">None</button>
          <button type="button" class="btn-sm ghost" data-pick="monthly">Monthly only</button>
          <button type="button" class="btn-sm ghost" data-pick="weekly">Weekly only</button>
          <button type="button" class="btn-sm ghost" data-pick="last4">Last 4</button>
        </div>
        <div class="pop-list">${Object.entries(byMonth).reverse().map(([m, es]) => `
          <div class="pop-month"><span class="muted">${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</span>
            ${es.map((e) => `<label class="exp-chip${monthly.has(e) ? ' monthly' : ''}"><input type="checkbox" value="${e}" ${sel.has(e) ? 'checked' : ''}> ${dayShort(e)}${monthly.has(e) ? ' <b>M</b>' : ''}</label>`).join('')}
          </div>`).join('') || '<div class="muted">No expiries in this period</div>'}</div>
        <div class="muted small">Pick the weeks to test: one week, several, or only monthly expiries. <b>M</b> = monthly expiry.</div>`;
    }

    function save() { store.set(key, S); }

    el.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (k) {
        if (k === 'taxes') S.taxes = e.target.checked;
        else if (k === 'from' || k === 'to') S[k] = e.target.value;
        else S[k] = e.target.value === '' ? null : Number(e.target.value);
        save();
        if (k === 'from' || k === 'to') render();
      }
      if (e.target.closest('.exp-pop') && e.target.type === 'checkbox') {
        const checked = [...el.querySelectorAll('.exp-pop input:checked')].map((x) => x.value);
        S.expiries = checked.length === inPeriod().length ? null : checked;
        el.querySelector('[data-act="exp"]').textContent = expLabel() + ' ▾';
        save();
      }
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.days != null) {
        const bd = bounds();
        const d = Number(b.dataset.days);
        S.to = bd.last;
        S.from = d ? addDays(bd.last, -d) : bd.first;
        if (S.from < bd.first) S.from = bd.first;
        S.expiries = null;
        save();
        render();
      } else if (b.dataset.k === 'lotMode') {
        S.lotMode = b.dataset.v;
        save();
        render();
      } else if (b.dataset.act === 'exp') {
        const pop = el.querySelector('.exp-pop');
        if (pop.classList.toggle('hidden')) return;
        renderPop();
      } else if (b.dataset.pick) {
        const list = inPeriod();
        const monthly = new Set(cal()?.monthly || []);
        const pick = b.dataset.pick;
        const chosen = pick === 'all' ? list : pick === 'none' ? [] : pick === 'monthly' ? list.filter((x) => monthly.has(x)) : pick === 'weekly' ? list.filter((x) => !monthly.has(x)) : list.slice(-4);
        S.expiries = chosen.length === list.length ? null : chosen;
        save();
        renderPop();
        el.querySelector('[data-act="exp"]').textContent = expLabel() + ' ▾';
      } else if (b.dataset.act === 'stop') {
        b.disabled = true;
        b.textContent = 'Stopping…';
        onStop();
      } else if (b.dataset.act === 'run') {
        el.querySelector('.exp-pop')?.classList.add('hidden');
        onRun?.();
      }
    });
    document.addEventListener('click', (e) => {
      if (!el.contains(e.target)) el.querySelector('.exp-pop')?.classList.add('hidden');
    });

    on('meta', render);
    if (meta.loaded) render(); else el.innerHTML = '<div class="muted">Loading expiry calendar…</div>';
    return {
      // Pick up changes made in the other screen's bar (both share the same saved settings).
      reload() {
        if (busy) return;
        Object.assign(S, def, store.get(key, {}));
        if (meta.loaded) render();
      },
      get() {
        ensure();
        const expiries = S.expiries ? S.expiries.filter((x) => x >= S.from && x <= S.to) : null;
        if (expiries && !expiries.length) throw new Error('No expiries selected in this period');
        return { from: S.from, to: S.to, expiries, slippage: S.slippage, brokerage: S.brokerage, taxes: S.taxes, lotMode: S.lotMode, lotSize: S.lotSize, capital: S.capital };
      },
      setBusy(v) {
        busy = v;
        const btn = el.querySelector('[data-act="run"]');
        if (btn) btn.disabled = v;
        const stop = el.querySelector('[data-act="stop"]');
        if (stop) { stop.classList.toggle('hidden', !v); stop.disabled = false; stop.textContent = '■ Stop'; }
        el.querySelector('.progress')?.classList.toggle('hidden', !v);
      },
      progress(p) {
        const box = el.querySelector('.progress');
        if (!box || !p) return;
        const frac = p.total ? p.done / p.total : 0;
        box.querySelector('.fill').style.width = (frac * 100).toFixed(1) + '%';
        const api = p.api || {};
        const wait = api.waitingSec ? ` · waiting ${api.waitingSec}s for Upstox rate limit` : '';
        box.querySelector('.ptext').textContent = `${p.phase || ''}${p.total ? ` ${p.done}/${p.total}` : ''} · ${api.requests ?? 0} downloads${wait}`;
      },
    };
  }

  // ---------- charts ----------
  function chartTheme() {
    if (!window.Chart) return;
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue('--muted').trim();
    Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
    Chart.defaults.font.size = 11;
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.animation = false;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
  }
  chartTheme();
  const charts = new Map();
  function chart(canvas, config) {
    charts.get(canvas)?.destroy();
    const c = new Chart(canvas, config);
    charts.set(canvas, c);
    return c;
  }
  const COLORS = ['#58a6ff', '#d6af4c', '#3fb68b', '#f0716b', '#b392f0', '#56d4dd', '#ff9f43', '#e86fb5', '#9aa5b1', '#7ee787'];

  // ---------- option maths (Black-Scholes, r = 6.5%) ----------
  const RATE = 0.065;
  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function bs(S, K, T, v, call) {
    if (T <= 1e-6 || !(v > 0)) return Math.max(0, call ? S - K : K - S);
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (RATE + (v * v) / 2) * T) / sq;
    const d2 = d1 - sq;
    return call ? S * ncdf(d1) - K * Math.exp(-RATE * T) * ncdf(d2) : K * Math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1);
  }

  window.BT = {
    $, esc, sleep, store, inr, inrS, kinr, pct, num, cls, dayLabel, dayShort, WD, MONTHS, REASON,
    api, runJob, on, emit, meta, loadMeta, allStrategies, findStrategy, clone, saveStrategy, deleteStrategy, resetStrategy, anomalyType,
    strikeLabel, legLabel, legChips, timingLabel, condLabel, EXP_LABEL, createEditor, createSettings, blankStrategy, complete,
    chart, COLORS, bs, ncdf,
  };

  // Load the strategy list and calendar once a backtest screen is opened.
  const load = () => loadMeta().catch((e) => emit('meta-error', e));
  window.addEventListener('viewchange', (e) => { if (e.detail !== 'chain') load(); });
  if (window.app?.state.view !== 'chain') load();
  // Keep the expiry calendar current while the page stays open (new weekly expiries get listed, old ones expire):
  // re-read it every 15 minutes and redraw only when it changed.
  setInterval(async () => {
    if (!meta.loaded || document.hidden) return;
    try {
      const m = await api('/api/bt/meta');
      if (!m.calendar || JSON.stringify(m.calendar) === JSON.stringify(meta.calendar)) return;
      meta.calendar = m.calendar;
      emit('meta', meta);
    } catch {}
  }, 15 * 60_000);
})();
