// The Terminal design's shell (see terminal.css for the look and design.js for how a design is picked).
//
// The page's markup is the Classic one. For the Terminal design this script rearranges its top bar, without
// re-creating anything app.js holds on to:
//   - the group tabs (#tabs) move into a rail down the left edge and get icons
//   - connection, last update and market state move into a status bar along the bottom
//   - a command line (Ctrl K or /) reaches every screen and setting by name or by its short code
//   - a Night / Day switch in the top strip; the other display settings (accent, text size, typeface, design)
//     open from the rail
// In the Classic design it only adds the button that switches to this one.
(() => {
  const D = window.NiftyDesign;
  if (!D) return;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const make = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const tabs = $('tabs');
  const subtabs = $('subtabs');
  const topbar = document.querySelector('.topbar');
  if (!tabs || !subtabs || !topbar) return;

  if (D.get('design') !== 'terminal') {
    const b = make('button', 'logout', 'Terminal design');
    b.type = 'button';
    b.id = 'designBtn';
    b.title = 'Switch to the Terminal design: sharper, larger text, a navigation rail and a command line. You can switch back from its Display settings.';
    b.addEventListener('click', () => D.set('design', 'terminal'));
    $('themeSw')?.after(b);
    return;
  }

  const svg = (d) => `<svg viewBox="0 0 22 22" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    live: '<path d="M1 12h4l2.5-7 4 13 3-9 1.5 3H21"/>',
    strat: '<path d="M3 3h7v7H3zM12 3h7v7h-7zM3 12h7v7H3zM12 12h7v7h-7z"/>',
    builder: '<path d="M2 19h18M3 14h6l9-10"/><path d="M14 4h4v4"/>',
    trades: '<path d="M4 3h14v16l-3.5-2-3.5 2-3.5-2L4 19zM8 8h6M8 12h6"/>',
    tideas: '<path d="M12.5 2 5 12.5h5L9 20l8-11h-5z"/>',
    port: '<path d="M11 2l7 2.5V10c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V4.5z"/><path d="M8 10.5l2.2 2.2L14.5 8"/>',
    data: '<path d="M4 5.5C4 3.8 7.1 3 11 3s7 .8 7 2.5S14.9 8 11 8 4 7.2 4 5.5zM4 5.5v11C4 18.2 7.1 19 11 19s7-.8 7-2.5v-11M4 11c0 1.7 3.1 2.5 7 2.5s7-.8 7-2.5"/>',
    display: '<path d="M3 6h9M17 6h2M3 16h2M10 16h9"/><path d="M12.5 3.5h4v5h-4zM5.5 13.5h4v5h-4z"/>',
    exit: '<path d="M9 3H4v16h5M13 7l4 4-4 4M17 11H8"/>',
    search: '<circle cx="9.5" cy="9.5" r="6"/><path d="M14 14l6 6"/>',
    night: '<path d="M18 13.5A8 8 0 0 1 8.5 4a8 8 0 1 0 9.5 9.5z"/>',
    day: '<circle cx="11" cy="11" r="4"/><path d="M11 1.5v3M11 17.5v3M1.5 11h3M17.5 11h3M4.3 4.3l2.1 2.1M15.6 15.6l2.1 2.1M4.3 17.7l2.1-2.1M15.6 6.4l2.1-2.1"/>',
  };
  const SHORT = { live: 'Live', strat: 'Strategies', builder: 'Builder', trades: 'Trades', tideas: 'Ideas', port: 'Portfolio', data: 'Data' };
  // short codes for the command line, as a terminal's function mnemonics
  const CODES = {
    chain: 'OC',
    ideas: 'LI',
    lib: 'STR',
    sb: 'BLD',
    tr: 'TRD',
    cc: 'MCC',
    psc: 'PSC',
    bpc: 'BPC',
    nbo: 'NBO',
    lab: 'LAB',
    tadj: 'ADJ',
    hedge: 'HDG',
    data: 'DATA',
  };
  const LABELS = {
    theme: { night: 'Night', day: 'Day' },
    accent: { amber: 'Amber', blue: 'Blue' },
    size: { s: 'Small', m: 'Medium', l: 'Large', xl: 'X-Large' },
    face: { segoe: 'Segoe', din: 'DIN', tahoma: 'Tahoma' },
    design: { terminal: 'Terminal', classic: 'Classic' },
  };

  // ---------- rail ----------
  const rail = make('aside', 'tm-rail');
  rail.id = 'tmRail';
  rail.append(make('div', 'tm-logo', 'NIFTY<small>LAB</small>'));
  const groupButtons = [...tabs.querySelectorAll('button')];
  groupButtons.forEach((b, i) => {
    const name = b.textContent.trim();
    b.dataset.full = name;
    b.title = `${name}: ${b.title}  (Alt+${i + 1})`;
    b.innerHTML = svg(ICONS[b.dataset.group] || ICONS.strat) + `<span>${esc(SHORT[b.dataset.group] || name)}</span>`;
  });
  rail.append(tabs);
  const foot = make('div', 'tm-rail-foot');
  const setBtn = make('button', '', svg(ICONS.display) + '<span>Display</span>');
  setBtn.type = 'button';
  setBtn.id = 'tmSetBtn';
  setBtn.title = 'Display settings: theme, accent, text size, typeface, design';
  foot.append(setBtn);
  const logout = $('logoutBtn');
  if (logout) {
    logout.innerHTML = svg(ICONS.exit) + '<span>Sign out</span>';
    foot.append(logout);
  }
  rail.append(foot);
  document.body.prepend(rail);

  // ---------- top strip: the command line's button ----------
  const cmdBtn = make('button', 'tm-cmdk', svg(ICONS.search) + '<span>Go to a screen or setting</span><kbd>Ctrl K</kbd>');
  cmdBtn.type = 'button';
  cmdBtn.title = 'Command line: type a screen, a code (OC, BLD, HDG ...) or a setting. Ctrl K, or / when not typing.';
  topbar.querySelector('.spacer')?.after(cmdBtn);
  // Night / Day, where the Classic design has its theme buttons
  const themeSw = make(
    'div',
    'tm-theme',
    `<span class="seg sm" data-opt="theme" title="Theme: Night (black screen) or Day (white paper)"><button type="button" data-v="night">${svg(ICONS.night)}Night</button><button type="button" data-v="day">${svg(ICONS.day)}Day</button></span>`,
  );
  themeSw.id = 'tmTheme';
  cmdBtn.after(themeSw);
  themeSw.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) D.set('theme', b.dataset.v);
  });

  // ---------- status bar ----------
  const bar = make('footer', 'tm-status');
  bar.id = 'tmStatus';
  const status = $('status');
  if (status) bar.append(status);
  const fetched = $('fetchedAt')?.closest('.stat');
  if (fetched) bar.append(fetched);
  const market = make('div', '', '');
  bar.append(market);
  bar.append(make('div', 'spacer'));
  bar.append(
    make(
      'div',
      'tm-hints',
      '<span><kbd>Ctrl K</kbd> command line</span><span><kbd>Alt</kbd><kbd>1</kbd>–<kbd>7</kbd> sections</span><span><kbd>[</kbd><kbd>]</kbd> screens</span>',
    ),
  );
  const dispBtn = make('button', '', '');
  dispBtn.type = 'button';
  dispBtn.title = 'Display settings';
  bar.append(dispBtn);
  document.body.append(bar);

  function drawMarket() {
    const closed = window.app?.marketClosed?.();
    market.innerHTML =
      closed == null ? '' : `<span class="label">NSE</span><span class="${closed ? 'tm-closed' : 'tm-open'}">${closed ? 'CLOSED' : 'OPEN'}</span>`;
    market.classList.toggle('hidden', closed == null);
  }
  drawMarket();
  setInterval(drawMarket, 20_000);

  // ---------- display settings ----------
  const pop = make('div', 'tm-pop hidden');
  pop.id = 'tmSettings';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Display settings');
  const segHtml = (name) =>
    `<span class="seg sm" data-opt="${name}">${Object.entries(LABELS[name])
      .map(([v, label]) => `<button type="button" data-v="${v}">${label}</button>`)
      .join('')}</span>`;
  pop.innerHTML = `
    <div class="tm-pop-head"><span>Display</span><button type="button" data-close title="Close (Esc)">✕</button></div>
    <div class="tm-pop-body">
      <div class="tm-row"><span>Theme</span>${segHtml('theme')}</div>
      <div class="tm-row"><span>Accent</span>${segHtml('accent')}</div>
      <div class="tm-row"><span>Text size</span>${segHtml('size')}</div>
      <div class="tm-row"><span>Typeface</span>${segHtml('face')}</div>
      <div class="tm-row"><span>Design</span>${segHtml('design')}</div>
      <div class="tm-note">Every text size is a whole number of pixels and never under 12, and the three typefaces are the ones Windows draws sharpest. Pick the pair that reads best on your screen.</div>
      <div class="tm-keys">
        <span><kbd>Ctrl</kbd><kbd>K</kbd> or <kbd>/</kbd></span><span>Command line: any screen or setting</span>
        <span><kbd>Alt</kbd><kbd>1</kbd> … <kbd>7</kbd></span><span>Sections of the rail</span>
        <span><kbd>[</kbd> <kbd>]</kbd></span><span>Previous / next screen of the section</span>
        <span><kbd>Esc</kbd></span><span>Close</span>
      </div>
    </div>`;
  document.body.append(pop);

  function drawSettings() {
    document.querySelectorAll('#tmSettings [data-opt], #tmTheme [data-opt]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', D.get(seg.dataset.opt) === b.dataset.v));
    });
    dispBtn.innerHTML = `<i class="tm-swatch"></i>${LABELS.theme[D.get('theme')]} · ${LABELS.accent[D.get('accent')]} · ${LABELS.size[D.get('size')]} · ${LABELS.face[D.get('face')]}`;
  }
  const toggleSettings = (show) => pop.classList.toggle('hidden', show === undefined ? !pop.classList.contains('hidden') : !show);
  pop.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return toggleSettings(false);
    const b = e.target.closest('[data-opt] button');
    if (b) D.set(b.closest('[data-opt]').dataset.opt, b.dataset.v);
  });
  setBtn.addEventListener('click', () => toggleSettings());
  dispBtn.addEventListener('click', () => toggleSettings());
  document.addEventListener('mousedown', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !setBtn.contains(e.target) && !dispBtn.contains(e.target)) toggleSettings(false);
  });

  // Chart.js reads its colours and font once; hand it the design's, and redraw what is on screen after a change.
  function themeCharts() {
    if (!window.Chart) return;
    const css = getComputedStyle(root);
    const v = (name) => css.getPropertyValue(name).trim();
    Chart.defaults.color = v('--muted');
    Chart.defaults.borderColor = v('--line');
    Chart.defaults.font.family = v('--font-ui');
    Chart.defaults.font.size = parseInt(v('--fs-2'), 10) || 12;
    const tip = Chart.defaults.plugins.tooltip;
    tip.backgroundColor = v('--panel-2');
    tip.borderColor = v('--line-strong');
    tip.titleColor = tip.bodyColor = v('--text');
    tip.cornerRadius = 0;
    Object.values(Chart.instances || {}).forEach((c) => {
      try {
        c.update('none');
      } catch {
        /* chart being torn down */
      }
    });
  }
  window.addEventListener('designchange', () => {
    drawSettings();
    themeCharts();
    window.dispatchEvent(new Event('resize')); // screens that measure text (the chain's "Fit screen") lay out again
  });
  drawSettings();
  themeCharts();

  // ---------- command line ----------
  const ov = make('div', 'tm-cmd-ov hidden');
  ov.innerHTML = `
    <div class="tm-cmd" role="dialog" aria-label="Command line">
      <div class="tm-cmd-in"><b>&gt;</b><input type="text" id="tmCmdIn" autocomplete="off" spellcheck="false" placeholder="Screen, code or setting — e.g. OC, builder, hedge, day, large" /></div>
      <ul id="tmCmdList"></ul>
      <div class="tm-cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> go</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.append(ov);
  const input = ov.querySelector('input');
  const list = ov.querySelector('ul');
  let shown = [];
  let at = 0;

  function commands() {
    const out = [];
    subtabs.querySelectorAll('.sub-group').forEach((g) => {
      const group = tabs.querySelector(`[data-group="${g.dataset.group}"]`)?.dataset.full || '';
      g.querySelectorAll('button').forEach((b) => {
        const title = b.textContent.trim();
        out.push({
          kind: 'Screens',
          code: CODES[b.dataset.view] || '',
          title,
          hint: (group && group !== title ? group + ' › ' : '') + (b.title || ''),
          run: () => window.app?.setView(b.dataset.view),
        });
      });
    });
    for (const name of ['theme', 'accent', 'size', 'face']) {
      const what = { theme: 'Theme', accent: 'Accent', size: 'Text size', face: 'Typeface' }[name];
      for (const [v, label] of Object.entries(LABELS[name])) {
        out.push({ kind: 'Display', code: '', title: `${what}: ${label}`, hint: D.get(name) === v ? 'in use' : '', run: () => D.set(name, v) });
      }
    }
    out.push({ kind: 'Display', code: '', title: 'Display settings', hint: 'theme, accent, text size, typeface, design', run: () => toggleSettings(true) });
    out.push({
      kind: 'Display',
      code: 'CLS',
      title: 'Switch to the Classic design',
      hint: 'the original look; switch back from its top bar',
      run: () => D.set('design', 'classic'),
    });
    document.querySelectorAll('#srcSw button[data-src]').forEach((b) => {
      out.push({
        kind: 'Actions',
        code: '',
        title: `Live data: ${b.textContent.trim()}`,
        hint: 'where the live screens get their prices',
        run: () => b.click(),
      });
    });
    if (logout && !logout.classList.contains('hidden')) out.push({ kind: 'Actions', code: '', title: 'Sign out', hint: '', run: () => logout.click() });
    return out;
  }
  function score(c, q) {
    if (!q) return 1;
    const code = c.code.toLowerCase();
    const title = c.title.toLowerCase();
    const all = `${title} ${c.hint.toLowerCase()} ${code}`;
    if (code === q) return 100;
    if (code && code.startsWith(q)) return 70;
    if (title.startsWith(q)) return 60;
    const words = q.split(/\s+/).filter(Boolean);
    if (words.every((w) => title.includes(w))) return 40;
    if (words.every((w) => all.includes(w))) return 10;
    return 0;
  }
  function drawList() {
    const q = input.value.trim().toLowerCase();
    shown = commands()
      .map((c, i) => ({ c, s: score(c, q), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.c);
    at = Math.min(at, Math.max(0, shown.length - 1));
    let html = '';
    let kind = '';
    shown.forEach((c, i) => {
      if (!q && c.kind !== kind) html += `<li class="sep">${(kind = c.kind)}</li>`;
      html += `<li data-i="${i}" class="${i === at ? 'on' : ''}"><span class="c">${esc(c.code)}</span><span class="t">${esc(c.title)}</span><span class="h">${esc(c.hint)}</span></li>`;
    });
    list.innerHTML = html || '<li class="none">Nothing matches. Try a screen name (chain, builder, hedge) or a setting (day, blue, large, tahoma).</li>';
    list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }
  function openCmd() {
    toggleSettings(false);
    ov.classList.remove('hidden');
    input.value = '';
    at = 0;
    drawList();
    input.focus();
  }
  const closeCmd = () => ov.classList.add('hidden');
  function run(i) {
    const c = shown[i];
    if (!c) return;
    closeCmd();
    c.run();
  }
  input.addEventListener('input', () => {
    at = 0;
    drawList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      drawList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(at);
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) run(Number(li.dataset.i));
  });
  ov.addEventListener('mousedown', (e) => e.target === ov && closeCmd());
  cmdBtn.addEventListener('click', openCmd);

  // ---------- keys ----------
  function stepScreen(by) {
    const group = subtabs.querySelector('.sub-group:not(.hidden)');
    const btns = group ? [...group.querySelectorAll('button')] : [];
    const i = btns.findIndex((b) => b.classList.contains('on'));
    if (btns.length > 1 && i >= 0) btns[(i + by + btns.length) % btns.length].click();
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return ov.classList.contains('hidden') ? openCmd() : closeCmd();
    }
    if (e.key === 'Escape') {
      closeCmd();
      toggleSettings(false);
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const b = groupButtons[Number(e.key) - 1];
      if (b) {
        e.preventDefault();
        b.click();
      }
      return;
    }
    const t = e.target;
    const typing = t instanceof Element && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      openCmd();
    } else if (e.key === '[') stepScreen(-1);
    else if (e.key === ']') stepScreen(1);
  });

  window.dispatchEvent(new Event('resize')); // the rail and the status bar changed the room the screens have
})();
