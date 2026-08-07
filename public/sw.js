// Network-first offline fallback for InfiniScroll.
//
// Everything here tries the network first and only falls back to a cached
// copy when the network request actually fails (no signal, airplane mode).
// That way the app stays fully live/fresh whenever you're online -- this
// service worker only exists to keep the last few things you've already
// seen from disappearing the moment you lose signal.

const CACHE_NAME = 'infiniscroll-v1';
const APP_SHELL_PATHS = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_PATHS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache reactions/writes

  const url = new URL(request.url);
  const isAppShell = APP_SHELL_PATHS.includes(url.pathname);
  const isFeedApi = url.pathname === '/api/feed';
  if (!isAppShell && !isFeedApi) return; // stats/liked/etc. always go straight to the network

  event.respondWith(
    fetch(request)
      .then((response) => {
        const responseCopy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
