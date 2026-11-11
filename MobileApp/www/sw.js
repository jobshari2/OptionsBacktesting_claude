// Service worker: keeps the app's own files on the phone so it starts with no connection to the host.
// Market data (api.upstox.com) is never cached here; the app keeps its own last-good copy.
// BUILD and FILES are written by `npm run stamp` (tools/stamp.mjs): a new BUILD makes phones fetch the new files.
const BUILD = '21ef671943';
const FILES = [
  './',
  'css/app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'icons/maskable-512.png',
  'index.html',
  'js/analytics.js',
  'js/app.js',
  'js/bs.js',
  'js/charts.js',
  'js/costs.js',
  'js/demo.js',
  'js/market.js',
  'js/positions.js',
  'js/store.js',
  'js/strategy.js',
  'js/time.js',
  'js/ui.js',
  'js/upstox.js',
  'js/views/chain.js',
  'js/views/market.js',
  'js/views/positions.js',
  'js/views/settings.js',
  'js/views/strategies.js',
  'manifest.webmanifest',
];
const CACHE = 'nom-' + BUILD;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nom-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Upstox and everything else: straight to the network
  // Page loads (including Upstox's ?code= return) get the cached app page.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((r) => r || fetch(req)));
});
