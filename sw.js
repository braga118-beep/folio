// Folio service worker: makes Folio installable and lets the app open even with a weak signal.
// Your own files are always fetched fresh when online (so updates show right away);
// the saved copy is only used when there's no connection.
const CACHE = 'folio-v3';
const SHELL = ['./', './index.html', './app.js', './render.js', './data.js', './styles.css', './config.js', './manifest.webmanifest', './icons/icon-192.png'];
const LIBS = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Libraries and fonts never change at a given version: use the saved copy first.
  if (LIBS.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  // Everything else from other sites (your database, photos) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // Folio's own files: always ask the server for the newest version, fall back to the saved copy offline.
  e.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname + url.search, copy)); }
        return res;
      })
      .catch(() => caches.match(url.pathname + url.search).then((hit) => hit || caches.match(req)).then((hit) => hit || caches.match('./index.html')))
  );
});
