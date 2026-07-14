const CACHE_NAME = 'siamepos-shell-v99'; // v99: SEPOS-046 complete — invoice history shows itemised lines, price-change alert on confirm, recipe costs auto-recalculate on supplier price change // v98: Close Shift is now the hero on the Z screen (Z demoted to a quiet view-only card) + printed Z header shows local times, not raw UTC ISO strings // v97: stability-audit batch (22 confirmed + 9 verify-pass findings) — unsent-cart pay guard, voucher/deposit caps + over-tender split, split-count restart, full-cover voucher marker, Z drawer incl. till voucher cash sales // v96: cash change no longer counted as money taken — mixed-pay cash tender records the bill portion, not the amount tendered (change is given back). Card tips still count. // v95: login "Loading your restaurant…" spinner on cold start (no more "no restaurant" flash); desktop Exit button on the login screen (+ single-instance guard); ghost-table fix (double-tap can't spawn an empty twin order); first-login-of-the-day "Open the day" prompt so sales always land in a Z report // v94: receipt body centred + new "Medium" (taller, single-width) receipt text size that fills the paper without truncating item names // v93: receipt logo size now applies to the PRINTED logo (was preview-only); kitchen-ticket head room matches the Sunmi (4 lines); mobile "View bill & pay" no longer hidden behind the bottom tab bar // v92: client-adjustable login logo size (Admin → Settings → App logo size) // v91: reports reconcile (exclude cancelled, money-taken headline), Bills total no longer hidden, Ask AI moved to top bar, Options modal bigger/no-clip, tenant-leak guard, bigger login logo + owner-editable name wins // v90: "Ask AI" helper now ONLY in Admin (was floating on every screen, clashed with View bill & pay) // v89: in-app "Ask AI" help assistant (SEPOS-AI-HELP-001) — floating helper grounded in the app map + this restaurant's live settings // v88: in-store takeaway labelled "Takeaway" (not "Online Takeaway"/"Online") in Reports so it's not confused with real online orders // v87: self-healing sync queue — a poison action (e.g. re-pay of an already-closed bill) can no longer freeze all sync; failed items quarantine + surface in the Sync-queue modal/pill instead of blocking live orders
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
