// Простой service worker: кэширует приложение, чтобы Трекер целей открывался офлайн
// и мог быть установлен как отдельное приложение (PWA).
//
// Версия кэша = версия приложения (см. APP_VERSION в index.html): каждый бамп версии
// гарантированно сносит старый кэш у всех, кто уже установил приложение, и тянет свежие файлы.
const CACHE_NAME = 'goal-tracker-v1.0.29';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './quotes.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const isPage = event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html');

  if (isPage) {
    // Network-first for the HTML page itself: always try to fetch the latest version first, so
    // code updates (like this one) show up on the very next reload instead of needing two.
    // Only falls back to the cached copy when there's no network (offline use).
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest) — fine for these to lag a beat since they
  // change rarely; the cache is refreshed in the background on every fetch.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
