// Theme switcher: Night (default), Day, Large. The choice is stored in localStorage; themes.css holds the colours.
(() => {
  const root = document.documentElement;
  const btns = [...document.querySelectorAll('#themeSw button')];
  function apply(name, persist) {
    root.dataset.theme = name;
    if (persist) {
      try {
        localStorage.setItem('nifty-theme', name);
      } catch {
        /* storage unavailable */
      }
    }
    btns.forEach((b) => b.classList.toggle('on', b.dataset.theme === name));
    if (window.Chart) {
      const css = getComputedStyle(root);
      Chart.defaults.color = css.getPropertyValue('--muted').trim();
      Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
      Object.values(Chart.instances || {}).forEach((c) => {
        try {
          c.update('none');
        } catch {
          /* chart being torn down */
        }
      });
    }
  }
  btns.forEach((b) => b.addEventListener('click', () => apply(b.dataset.theme, true)));
  apply(root.dataset.theme || 'night', false);
})();
