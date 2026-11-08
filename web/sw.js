// Lugn always needs the live server. This worker never caches the API or the
// panel itself; it only shows a calm offline page when the server is gone.
const CACHE = 'lugn-shell-v1';
const OFFLINE_PAGE = '/ui/offline.html';
const SHELL = [
  OFFLINE_PAGE,
  '/ui/styles.css',
  '/ui/icons/mark-128.png',
  '/ui/fonts/familjen-grotesk.woff2',
  '/ui/fonts/newsreader.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)));
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && SHELL.includes(url.pathname))
    event.respondWith(fetch(request).catch(() => caches.match(url.pathname)));
});
