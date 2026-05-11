const CACHE_NAME = 'siamepos-shell-v3'; // bump to invalidate stale caches
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
];

// HTML navigations use network-first so UI changes propagate the moment
// Netlify is updated; hashed JS / CSS / images stay cache-first (immutable
// per Vite's content-hashing, no point re-fetching).
function isHtmlNavigation(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (e.g. Railway API) — let the network handle it.
  if (url.origin !== self.location.origin) return;

  // Never cache API routes — always go to network.
  if (url.pathname.startsWith('/api/')) return;

  // Socket.io traffic should never be intercepted.
  if (url.pathname.startsWith('/socket.io/')) return;

  // ── Network-first for HTML navigations ───────────────────────────
  // Keeps the shell fresh so a new deploy is picked up on next reload
  // without waiting for a SW update cycle. Falls back to cache only
  // when offline.
  if (isHtmlNavigation(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // ── Cache-first for hashed assets ────────────────────────────────
  // Vite content-hashes JS / CSS so the URL changes whenever the bytes
  // change — once we have a file by URL it's safe to serve forever.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
    })
  );
});
