const CACHE_NAME = 'siamepos-shell-v159'; // v159: SEPOS-DEVICE-AUTH-001b — Email field on the staff card (Admin → Staff): owners/managers save their email there for owner sign-in links AND to authorise new till devices (the field existed in the DB for office sign-in but had no UI). Shown on the expanded staff card; PUTs without the field can't clobber a saved email (old bundles safe) // v158: SEPOS-DEVICE-AUTH-001 — optional per-restaurant device authorisation for browser tills (flag OFF by default): when enabled, the first visit from a new device must be approved via an emailed link (owner/manager staff email or SiamEPOS support) before the PIN pad will sign anyone in; approved devices stay trusted 180 days. Login screen gains the "Authorise this device" card + consumes ?device_token= links // v157: v1.9.37 — 💵 Drawer button in the top bar (floor/counter): one-tap no-sale drawer open for change-making, stamped with the staff name; drawer still opens automatically on payment as before. Ask AI button retired from Admin (unused) // v156: v1.9.36 — the SELECTED category/sub-category now looks unmistakably selected: full-strength navy ring on coloured buttons (was a faint 35%-alpha smudge), gold ring on navy-filled ones, bolder text while active // v155: v1.9.35 — denser dish grid on the order screen: ~6 cards per row instead of 4 (auto-fit columns), slightly tighter cards — big menus need far less scrolling; phones keep 2-up // v154: v1.9.34 — long category names WRAP to a second line on the order screen instead of being cut off with '…' (2-line clamp; short names stay centred; rows stay level) // v153: v1.9.33 — typing works everywhere on a keyboard-less till: the on-screen keyboard now also comes on for the desktop till app (many POS touchscreens report as a mouse, so touch-only auto never fired), price/quantity boxes get a NUMBER PAD (they had no way to type at all), and it gained English+ไทย layouts (🌐), a ?123 symbols layer and an ⏎ key. Order screen: category buttons in a tidy same-size grid (slightly smaller — Fern), and the Order tab has its own ← Back (sending on a narrow screen switched to a tab with no way back) // v152: v1.9.29 — table rename saves when you FINISH typing (Enter/pause/tap-away) instead of every keystroke (typing '12' no longer trips the duplicate guard on the intermediate '1') + dragging tables counts as activity so the idle sign-out can't kick you mid-setup // v151b: v1.9.28 hotfix — the duplicate-table-number guard no longer blocks tables that ALREADY shared a number from before the guard existed (they save normally and can be fixed by renumbering); only CHANGING a number onto a collision is refused // v151: v1.9.27 — signing out returns the till to the floor map, so the next person always starts from home instead of wherever the previous person was (e.g. inheriting the Kitchen tab) // v150: v1.9.26 — kitchen & bar staff sign in as WAITERS by default (land on the floor with the normal navbar; the Kitchen/Bar screens stay one tap away — venues that want forced KDS landing untick it in Till Security; Fern's ask) + the Tables grid view separates dine-in and Takeaway into two labelled sections + the app now REFUSES a duplicate table number (two tables sharing a number made the plan editor re-bind to the wrong twin after every save) // v149: v1.9.25 — brand colours apply from the moment the till starts (the boot-time theme fetch raced the embedded server's cold start and failed silently, so the saved colour only appeared after a manual Settings save — Yum Yum install, 23 Aug; now retries until settings load) // v148: v1.9.24 — the customer-facing display stays in the RESTAURANT's branding at all times: the idle screen keeps their logo + name instead of reverting to the SiamEPOS mark after 30 quiet seconds, and the display now wears the restaurant's own brand colours (settings.brand_primary/brand_accent) on the background, welcome line, quantities and TOTAL (SiamEPOS navy/gold stays as the fallback) // v147: v1.9.23 — 'Today' on Trading/Reports can no longer go stale on a till left running overnight (report dates computed at view time in LOCAL time; Monthly preset no longer starts a day early during BST) + the day's FIRST SALE auto-opens the shift when staff forget, so no paid bill can ever fall outside the Z's window again (Fern 22 Aug: 18 pre-shift bills £492.45 missing from the combined Z) // v146: v1.9.22 — 🖥️ Customer-Facing Display (open <till-url>/#display on the 2nd screen or a tablet: idle branding + live order with running total as staff ring items; server-brokered relay, additive-only) + menu reorder finally works on TOUCHSCREENS (tap ◀▶ on Arrange-menu cards, tap ▲▼ in Admin → Menu — HTML5 drag never fires on touch; mouse-drag kept) // v145: v1.9.21 — ✏️ draft badge on the floor map (a table holding typed-but-unsent items on THIS device shows a pencil; 0-item orders still read as available) + Resend button appears as soon as anything is SENT (the old is_fired gate hid it until a course was called — venues without course calls had no resend at all) // v144: SEPOS-OFFICE-001 — owner Back Office: <till-url>/#office goes straight to email sign-in (Back Office badge, no PIN grid), 📧 one-tap emailed sign-in link (works once, 15-min expiry, SHA-256-stored, atomic single-use), email/link sign-ins land managers straight on Admin, and the email login endpoint now carries the same brute-force lockout as the PIN pad // v143: v1.9.20 — Allergen sheet saves on desktop/host tills (local DB was missing the dish_allergens table + NOW() is PG-only; ticks also replicate to the cloud for QR menu chips, queued when offline) // v142: v1.9.19 — crash screen names the component (top of componentStack shown + full detail kept in localStorage siamepos_last_crash) so one photo is enough to debug // v141: v1.9.18 — staff name actually prints on tickets (print payload now stamped; DB was, paper wasn't), tap a basket line to add/edit its kitchen note, ↻ Resend order modal (tick items, default Reprint = paper-only; reasons/stock unchanged when picked) // v140: v1.9.17 — Log out button on the Kitchen + Bar screens (those roles have no navbar and no idle auto sign-out; only exit was quitting the app) // v139: v1.9.16 — gift vouchers on the PRINTED Z (HTML sheet + thermal ticket + CSV) and Expected-drawer now includes voucher cash on paper (screen already did — sheet/screen no longer disagree) // v138: v1.9.15 — 💷 'Money into the till' story card on Trading (bills + till voucher sales in one figure, voucher-paid bills explained with the day-basis rule, £0.00 method rows hidden) // v137: v1.9.14 Fern-polish batch — ghost-tap-proof modal dismissal (keyboard Done can't discard a typed card), compact category buttons (25+ category venues), voucher sales excl. voided/mock/deposits on Reports (matches Z), printer beep toggle for kitchen/bar tickets // v136: v1.9.11 — stale pre-token sessions SELF-HEAL (restore requires a token; a 'sign out and sign in again' 401 clears the session + reloads to login once, instead of alerting forever — Fern) // v135: v1.9.10 hotfix — order-screen deposit prints on the bill again (Print button overrode the model-A amount with the old tender sum = £0; both models now add up) // v134: v1.9.9 — SEPOS-RECEIPT-FONT-001: customer bills + settled receipts in the rendered typeface (one fixed size, no order-number row; logo + review QR + paper-saver unchanged; Thai/render-failure auto-falls back to classic; Sunmi native untouched) // v133: v1.9.8 — ticket font SIZES (Standard/Large/XL/Huge picker replaces Modern/Classic; rendered font is the only mode, classic auto-fallback), delivery on the direct /order page (postcode check + address, settings-gated), lead-capture SMS + initDB crasher fix // // v132: v1.9.7 — VIP batch: 'Sent: NAME' on every kitchen/bar ticket + KDS chip, staff hierarchy (can-void/can-close-Z flags, supervisor Admin matrix, Close-Day door), sales-by-category in Reports, 🎁 Complimentary settlement (manager PIN, own Z line, excluded from takings) + comp voucher sales, Modern/Classic ticket-font picker, birthday sync host↔cloud // v131: v1.9.6 — discount by scope (All/Food/Drinks pills, is_bar-driven, labelled receipts + scoped Z/VAT/service), 📷 scan everywhere with auto-lookup + balance prefill, customer birthdays (🎂 Customers panel w/ 1wk/2wk/1mo reminder + booking-widget birthday box, MAKE_BIRTHDAY_WEBHOOK live) // v130: v1.9.5 — ticket font default, one-tap pay, amount pads, compact colour menu, deposits full flow (12 canary + 18 review fixes) // v129: PIN-only sign-in (Till Security toggle) + per-staff can-discount/can-redeem-deposit + Add Deposit on the order screen (redeem-on-tap, bill shows Deposit paid/Balance due) + double-size Send button + held tickets can reroute to ANY chosen printer // v128: resend fixed on local/host tills (was a silent no-op); booking deposit shows on the printed bill (Deposit paid + Balance due); paste works in the main till, not just setup wizard // v123: AUDIT-002 batch — till now receives customer-paid tenders (QR bills were missing from Bills + Z); QR rounds never join a waiter's bill; payment-replay guard + refund-on-failure; held tickets stop printing twice; native tickets carry the allergy note + bar items; owner can upload dish photos; customers can get a receipt for THEIR payment; order number in Bills // v122: receipt branding — blanked restaurant name stays blank (logo-only receipts; no more legacy-name leak) + receipt QR caption is now a setting (Settings → Receipt QR Caption) // v121: table-name SWEEP — every remaining surface (Order screen headers, Bills/Reports/Z/Trading rows, table popups, browser+native printed tickets & receipts, kitchen messages, print alerts) prefers the table NAME over the raw number // v120: table NAMES everywhere — KDS cards, floor labels, kitchen tickets say 'Bar 3' not 'Table 9'; QR orders auto-print in the kitchen via the relay // v119: SEPOS-BILL-STATIONS-001 — per-device bill station (Admin → Printers → Bill station card); printer scan sweeps every attached subnet, 3-pass + chunked (travel-kit reliable) // v118: QR orders — options/modifiers picker on the customer page + PAID-ONLINE banners on Order + Bill screens (staff can't double-charge a prepaid QR table) // v117: SEPOS-QR-ORDER-001 — QR self-ordering at the table (⎙ QR codes button in Table Plan, 📱 badge on customer-placed orders) // v116: editor + floor share ONE room — a table at the left wall in Table Plan sits at the left on Tables too (no more cluster-centring); Table Plan gets the same −/Fit/+ zoom so big rooms are designable // v115: floor map zoom buttons (+/Fit/−, per-device remembered) + auto-fit cap softened 2.2→1.5 // v114: floor map auto-zooms to fill the screen (SEPOS-FLOOR-FIT) — plan scales+centres to the viewport, bigger tap targets, same layout as the editor // v113: table-plan saves fail LOUD when the cloud is unreachable (no more silent revert/"pop back"); wall edits sync to cloud; ghost tables cleaned up // v112: print text sizes — full width×height matrix (Tall, Extra tall, Wide, Large+extra-tall) per role // v111: Receipt Preview shows the ACTUAL review QR code (redraws live as the link is typed) // v110: table drags save reliably (sub-pixel drag coords were rejected by the integer position columns, blocking every later edit of that table); repeated error toasts collapse // v109: tables can carry a text label ("Bar 1") — digits stay the table number, text becomes the display name shown on the plan + floor; save errors now surface as a toast instead of failing silently // v108: table rename saves as you type (was lost if the panel closed before the box lost focus) // v107: table-plan rename no longer reverted when Save Layout is clicked right after typing (blur/save race) // v106: floor map renders tables saved at position 0 correctly (edge-flush tables no longer shift 40px vs the Table Plan editor) // v105: SEPOS-SEC-002 prep — every API write now carries the staff login token (additive, no behaviour change; readies the auth gate) // v104: // v104: Till Security (SEPOS-TILL-LOCK-001) — after sending an order the screen flashes "✓ sent" and returns to the PIN sign-in screen; idle tills auto sign-out after a configurable time (default 2 min, 20s warning first; unsent basket kept as a draft on the table; Kitchen/Bar displays exempt). Both settings in Admin → Settings → Till Security // v103: clock in/out is now tap-FIRST on the login screen (SEPOS-CLOCK-002) — tap the Clock button, enter your code, one entry clocks you in OR out automatically with a big confirmation; PIN login itself is unchanged // v102: penny entry now ALSO on the typed amount boxes in the Payment screen (cash/card/voucher/deposit) — typing 3201 gives £32.01, not £3201.00 // v101: Z CSV export dates in local time (was raw UTC ISO) // v100: payment numpad is now ATM-style penny entry — type 2-9-1-9 for £29.19, no decimal key (replaced with a 00 key for round amounts) // v99: SEPOS-046 complete — invoice history shows itemised lines, price-change alert on confirm, recipe costs auto-recalculate on supplier price change // v98: Close Shift is now the hero on the Z screen (Z demoted to a quiet view-only card) + printed Z header shows local times, not raw UTC ISO strings // v97: stability-audit batch (22 confirmed + 9 verify-pass findings) — unsent-cart pay guard, voucher/deposit caps + over-tender split, split-count restart, full-cover voucher marker, Z drawer incl. till voucher cash sales // v96: cash change no longer counted as money taken — mixed-pay cash tender records the bill portion, not the amount tendered (change is given back). Card tips still count. // v95: login "Loading your restaurant…" spinner on cold start (no more "no restaurant" flash); desktop Exit button on the login screen (+ single-instance guard); ghost-table fix (double-tap can't spawn an empty twin order); first-login-of-the-day "Open the day" prompt so sales always land in a Z report // v94: receipt body centred + new "Medium" (taller, single-width) receipt text size that fills the paper without truncating item names // v93: receipt logo size now applies to the PRINTED logo (was preview-only); kitchen-ticket head room matches the Sunmi (4 lines); mobile "View bill & pay" no longer hidden behind the bottom tab bar // v92: client-adjustable login logo size (Admin → Settings → App logo size) // v91: reports reconcile (exclude cancelled, money-taken headline), Bills total no longer hidden, Ask AI moved to top bar, Options modal bigger/no-clip, tenant-leak guard, bigger login logo + owner-editable name wins // v90: "Ask AI" helper now ONLY in Admin (was floating on every screen, clashed with View bill & pay) // v89: in-app "Ask AI" help assistant (SEPOS-AI-HELP-001) — floating helper grounded in the app map + this restaurant's live settings // v88: in-store takeaway labelled "Takeaway" (not "Online Takeaway"/"Online") in Reports so it's not confused with real online orders // v87: self-healing sync queue — a poison action (e.g. re-pay of an already-closed bill) can no longer freeze all sync; failed items quarantine + surface in the Sync-queue modal/pill instead of blocking live orders
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
