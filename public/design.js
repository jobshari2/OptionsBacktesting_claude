// Which design the portal wears: Classic (the original) or Terminal (public/terminal/). Chosen on the sign-in page
// and in either design's own controls; kept in localStorage, as the colour theme is.
//
// Loaded in the <head>, after the Classic stylesheets and before anything is drawn: for the Terminal design it adds
// the two Terminal stylesheets, so they come last and the page is never shown half-dressed. The Classic design gets
// nothing added: its pages load exactly the files they always did.
//
// The Terminal design has its own settings (below). Its Night and Day themes use the same data-theme values as the
// Classic ones, because the Classic stylesheets and the charts key their dark / light rules on that attribute.
(() => {
  const root = document.documentElement;
  const KEYS = { design: 'nifty-design', theme: 'nifty-tm-theme', accent: 'nifty-tm-accent', size: 'nifty-tm-size', face: 'nifty-tm-face' };
  // the first of each list is the default
  const OPTIONS = {
    design: ['classic', 'terminal'],
    theme: ['night', 'day'], // black screen or white paper; the first time, the one the Classic design is set to
    accent: ['amber', 'blue'], // the colour of what you can act on: terminal amber or blue
    size: ['m', 's', 'l', 'xl'], // text size
    face: ['segoe', 'din', 'tahoma'], // typeface
  };
  const read = (name) => {
    let v = null;
    try {
      v = localStorage.getItem(KEYS[name]);
    } catch {
      /* storage unavailable */
    }
    return OPTIONS[name].includes(v) ? v : OPTIONS[name][0];
  };
  const state = { design: read('design'), theme: read('theme'), accent: read('accent'), size: read('size'), face: read('face') };
  try {
    if (localStorage.getItem(KEYS.theme) == null && localStorage.getItem('nifty-theme') === 'day') state.theme = 'day';
  } catch {
    /* storage unavailable */
  }

  function apply() {
    root.dataset.design = state.design;
    if (state.design !== 'terminal') return;
    root.dataset.accent = state.accent;
    root.dataset.tsize = state.size;
    root.dataset.face = state.face;
    root.dataset.theme = state.theme;
  }
  apply();
  if (state.design === 'terminal') {
    document.write('<link rel="stylesheet" href="terminal/terminal-gen.css" /><link rel="stylesheet" href="terminal/terminal.css" />');
  }

  window.NiftyDesign = {
    options: OPTIONS,
    get: (name) => state[name],
    // A new design needs the page loaded again (other stylesheets, another top bar); the rest applies at once.
    set(name, value) {
      if (!OPTIONS[name]?.includes(value) || state[name] === value) return;
      try {
        localStorage.setItem(KEYS[name], value);
      } catch {
        /* storage unavailable: the choice lasts until the page is closed */
      }
      if (name === 'design') return location.reload();
      state[name] = value;
      apply();
      window.dispatchEvent(new CustomEvent('designchange', { detail: { name, value } }));
    },
  };

  // Another window of the portal changed the choice (the pop-out chart follows the main window).
  window.addEventListener('storage', (e) => {
    const name = Object.keys(KEYS).find((k) => KEYS[k] === e.key);
    if (!name) return;
    if (name === 'design') return location.reload();
    state[name] = read(name);
    apply();
    window.dispatchEvent(new CustomEvent('designchange', { detail: { name, value: state[name] } }));
  });
})();
