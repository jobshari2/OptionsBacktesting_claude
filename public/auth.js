// Sign-in for the page: a request the server answers with 401 (session ended or server restarted) sends the browser
// to the login page, and the top bar gets a Sign out button when the server asks for a login.
(() => {
  const toLogin = () => {
    if (location.pathname !== '/login.html') location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) toLogin();
    return res;
  };
  nativeFetch('/api/auth/status', { cache: 'no-store' })
    .then((r) => r.json())
    .then((s) => {
      if (s.enabled && !s.authenticated) return toLogin();
      const btn = document.getElementById('logoutBtn');
      if (!btn || !s.enabled) return;
      btn.title = `Signed in as ${s.user}. Click to sign out`;
      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        await nativeFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        toLogin();
      });
    })
    .catch(() => {});
})();
