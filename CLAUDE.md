# SiamEPOS — Developer Context for Krit (Claude Code Agent)

## ⚠️ START OF EVERY SESSION — DO THIS FIRST
1. Read `TEAM-STATUS.md` — see what the whole team is working on
2. Add yourself to the "Active Work" table if starting a ticket
3. Then proceed with whatever Korakot asks

## ⚠️ END OF EVERY SESSION — DO THIS BEFORE FINISHING
1. Move your row to "Recently Completed" in `TEAM-STATUS.md`
2. Add any handoff notes for Sam, Pose, or Nook
3. Remove outdated entries

**Auto-trigger:** If Korakot says anything like "thanks", "that's all", "done for today", "bye", "good night", "all done", "let's stop here", "ok done" — treat it as end of session and update TEAM-STATUS.md automatically before responding.

---

## Project
Cloud restaurant management system for Thai restaurants in the UK,
shipping as a desktop installer (SiamEPOS Pro) on top of the
existing browser POS.
Owner: Korakot Kongponsrisiri | info@siamepos.co.uk

## Stack
- Frontend: React + Vite → Netlify (app.siamepos.co.uk)
- Backend: Node.js + Express → Railway
- Cloud DB: PostgreSQL (Railway)
- Desktop shell: Electron 33 (Mac DMG + Windows EXE)
- Local DB: SQLite via better-sqlite3 (offline-capable)
- Real-time: Socket.io
- Automation: Make.com

## File Structure
- Backend: src/server.js, src/db/database.js (PG), src/db/localDatabase.js (SQLite), src/db/dbAdapter.js
- Sync engine: src/services/offlineQueue.js, src/services/syncService.js
- Cloud relay (Mac realtime): src/services/cloudRelay.js (SEPOS-PRO-003)
- Email: src/services/emailService.js (Brevo — exports sendBrevoEmail, sendBookingConfirmation)
- Make.com webhooks: src/services/makeWebhooks.js (hourly cron: lapsed/booking/birthday)
- Booking widget (public): public/widget.js
- Takeaway widget (public): public/takeaway-widget.js (SEPOS-034)
- Frontend: client/src/
- Screens: client/src/screens/
- Admin sections: client/src/screens/admin/
- Shared UI helpers: client/src/utils/ (orderLabel.js — single source for dine-in vs Online Order labelling across screens)
- API layer: client/src/api.js
- Electron: electron/main.js, electron/preload.js, electron/package.json
- Launcher: start-siamepos.sh (Desktop SiamEPOS.app shortcut + macOS Login Item)
- **Marketing site** (SiamEPOS company): client/Website/ — Netlify-deployed at siamepos.co.uk. Bilingual, mobile hamburger nav, "Five killer features" hero on features.html.
- **Demo restaurant site** (Baan Siam mockup): client/MockUp Website/ — Netlify-deployed at www.siamepos.net. English-only, live menu fetched from /api/menu, embedded takeaway + booking widgets, allergen chips. Used for sales demos showing the full website→EPOS→kitchen→CRM loop.
- Release notes: RELEASE_NOTES_2026-05.md (May 2026 feature update memo for team handoff)

## Deployment
- `git push` → Railway auto-deploys backend, Netlify auto-deploys frontend
- Desktop installers: `git tag vX.Y.Z && git push origin vX.Y.Z` triggers
  `.github/workflows/release.yml` (builds Mac DMG on macos-latest + Windows
  EXE on windows-latest, attaches both + `latest-mac.yml` + `latest.yml` +
  `.blockmap` files to a GitHub Release).
- **Desktop auto-update is live** via electron-updater hooked to the
  public GitHub repo. Once an install is on a build with the publish
  config, every subsequent tag push downloads silently in the background
  and applies on next restart. **First install on a machine still needs
  a manual reinstall** to get onto a build with the publish config.
- Manual local Mac build: `cd electron && npm run rebuild:native && npm run build:mac`
- PWA service worker (client/public/sw.js) — bump `CACHE_NAME` (vN) when
  a release contains UI changes you need iPads to pick up immediately;
  otherwise they hold the previous cache for days.
- Always commit with a clear message referencing the ticket number

## Critical Coding Rules
- PostgreSQL syntax: $1 $2 params, pool.query() — adapter translates for SQLite
- New DB column needs THREE edits:
  - PG (src/db/database.js): `ALTER TABLE x ADD COLUMN IF NOT EXISTS …`
  - SQLite (src/db/localDatabase.js): add to CREATE + `addColumnIfMissing()` in runMigrations
  - Update relevant SELECTs / endpoints
- `window.prompt()` is **disabled in Electron 22+** — always use a React modal.
  `window.alert()` and `window.confirm()` still work.
- Always give complete files — never partial snippets
- Test that imports exist before referencing them
- Socket.io: `{ transports: ['websocket','polling'] }`
- Vite must use `base: './'` so dist works under Electron's `file://` load
- better-sqlite3 native binary must match Electron's Node ABI — run
  `cd electron && npm run rebuild:native` after `npm install` at root,
  or after switching between system-Node testing and Electron testing.

## Key Settings
- Service charge key: service_charge_rate (not service_charge_percent)
- service_charge_enabled: stored as '1'/'0' string
- VAT rate per menu item: menu_items.vat_rate (default 20, prices VAT-inclusive)
- Sync tick interval (Mac local mode): `SYNC_PING_MS` env var, default `5000` (5s).
  Override per install if Railway egress needs throttling.
- Kitchen Direct Mode flag: `localStorage.kitchen_direct_mode` ('1' or '0').
  Per-device — restaurants without a Pass section let the chef tick items
  "off the kitchen" straight from the Kitchen tab.

## Railway env vars (production)
- `DATABASE_URL` — Postgres connection (auto-set by Railway)
- `BREVO_API_KEY` — booking confirmations + campaign sends
- `RESTAURANT_NAME`, `RESTAURANT_EMAIL`, `RESTAURANT_ADDRESS` — used in
  email headers, footers, webhook payloads
- `ANTHROPIC_API_KEY` — menu-photo extraction (InvoiceScanner)
- `UNSUB_SECRET` — HMAC secret for unsubscribe tokens (has insecure default)
- `PUBLIC_API_URL` — used to build absolute unsubscribe links in emails
- `MAKE_BOOKING_WEBHOOK` — fires on every new booking
- `MAKE_LAPSED_WEBHOOK` — fires when a customer's last visit > 60 days ago
- `MAKE_BOOKING_COMPLETED_WEBHOOK` — fires 24h after a reservation date
- `MAKE_BIRTHDAY_WEBHOOK` — wired but no-op until DOB capture lands
- `SYNC_SECRET` — HMAC for the auth-gated `/api/sync/closed-orders` feed.
  MUST match the same value in each Electron install's `config.json`
  (or `SYNC_SECRET` env) or the pull is silently skipped.

## DB Mode (Electron only)
- `DB_MODE=local` + `SQLITE_PATH` env var → src/db/dbAdapter.js routes to SQLite
- `DB_MODE=cloud` (default) → PostgreSQL (Railway)
- Sync engine pulls cloud → local (every `SYNC_PING_MS`, default 5s):
    • flat tables: menu, staff, settings, tables, walls, combinations,
      tiers, **reservations** (since cb0496d)
    • nested menu tree (categories + subcategories + items + modifiers)
    • **closed orders + items + payments** — paginated by `closed_at`,
      cursor in `sync_state` table, gated by `SYNC_SECRET` (silently skipped without it)
    • **active (open) orders + items + payments** (SEPOS-PRO-002) — full
      snapshot per tick, gated by `SYNC_SECRET`. Matched to local rows by
      `orders.cloud_id` / `order_items.cloud_id`. INSERT for cloud rows
      with no local match; UPDATE (cloud-wins) for matched rows;
      **SKIPPED** for orders/items that have unfinished entries in
      `sync_queue` — Mac is authoritative until its push lands.
- Push: queued mutations pushed to `CLOUD_API_URL` when reachable.
  Cloud's response is captured back into local `cloud_id` columns so
  subsequent ops use the right cloud id (replaces the old in-memory map).
  Reservations push not wired yet (Mac-created reservations stay local).
- **Realtime relay** (SEPOS-PRO-003) — Mac's local server also opens a
  socket.io CLIENT connection to the cloud and forwards 13 known events
  (new_order_items, course_fired, item_status_changed, item_voided,
  order_closed, table_moved, table_merged, new_reservation,
  reservation_updated, tableStatusChanged, reservation_cancelled,
  new_takeaway_order, takeaway_status) onto Mac's LOCAL socket.io. Each
  inbound event schedules a debounced (150 ms) pullActiveOrders so local
  SQLite has the new data before React's HTTP refetch arrives.
  Net effect: sub-second propagation Chrome→Mac and vice versa.
- Per-install config lives at electron/config.json (dev) or
  userData/config.json (packaged) — created by the first-launch wizard.
  Fields: restaurant_name, cloud_api_url, restaurant_id, sync_secret

## AdminScreen Structure (refactored 8 May 2026)
AdminScreen.jsx is a shell only. Always edit the specific section file:
client/src/screens/admin/SettingsSection.jsx
client/src/screens/admin/MenuSection.jsx
client/src/screens/admin/TradingSection.jsx
client/src/screens/admin/TablePlanSection.jsx
client/src/screens/admin/ReportsSection.jsx
client/src/screens/admin/BillsSection.jsx
client/src/screens/admin/ZReportSection.jsx
client/src/screens/admin/StaffSection.jsx
client/src/screens/admin/ClockRecordsSection.jsx           # SEPOS-022
client/src/screens/admin/StaffPerformanceSection.jsx       # SEPOS-030
client/src/screens/admin/VATReportSection.jsx              # SEPOS-021
client/src/screens/admin/CustomersSection.jsx              # SEPOS-033 P1
client/src/screens/admin/CampaignsSection.jsx              # SEPOS-033 P2
client/src/screens/admin/AllergenSection.jsx
client/src/screens/admin/ReservationSettingsSection.jsx
client/src/screens/admin/DiningDurationSettings.jsx
client/src/screens/admin/inventory/InventorySection.jsx
client/src/screens/admin/inventory/IngredientsTab.jsx
client/src/screens/admin/inventory/RecipesTab.jsx
client/src/screens/admin/inventory/StockTab.jsx
client/src/screens/admin/inventory/InvoiceScannerTab.jsx
client/src/screens/admin/inventory/InvoiceHistoryTab.jsx
client/src/screens/admin/inventory/CostSalesTab.jsx

## Tickets

### Recently shipped (May 2026 batch)
- SEPOS-021 (partial) — VAT rate per item + breakdown on bill/receipt/Z/report
  (HMRC submission deferred — separate ticket)
- SEPOS-022 — Staff clock in/out + weekly summary + CSV export
- SEPOS-023 — Void types (Wastage/Wrong Order/Customer Changed Mind/Comp)
  with manager-PIN gate for Comp
- SEPOS-024 — Resend reason picker (Not Cooked/Wrong Item/Missing Item/Remake)
- SEPOS-028 — Multi-device setup (QR + test connection + LAN auto-detect)
- SEPOS-030 — Staff performance report (orders, turn time, dessert ratio)
- SEPOS-031 — Wastage cost reporting (voided × recipe.cost_per_portion)
- SEPOS-032 — Auto stock depletion on sale + resend
- SEPOS-033 (3 phases) — Customer CRM, Brevo email campaigns, Make.com
  webhook triggers (lapsed / booking_completed / birthday_month), GDPR
  consent checkbox on the booking widget + HMAC-signed unsubscribe flow
- SEPOS-034 — Online takeaway ordering (mock payment for sales demo).
  Public widget at /takeaway-widget.js with 5-step modal (pickup time →
  menu+cart → contact → mock pay → success). New endpoints under
  /api/takeaway/*. Kitchen view tags takeaway orders 🥡 with customer
  name + pickup time. Stock depletion + Brevo confirmation email
  flow on through. Real Stripe deferred to SEPOS-040.
- SEPOS-PRO-001 (phases 1-4 + auto-update + closed-orders pull) —
  Electron shell, SQLite, offline queue, cloud↔local sync, electron-
  updater via GitHub Releases, reservations + closed-orders pulled
  to local for offline bill history

### Recently shipped (May 2026 follow-up batch — v1.1.x → v1.2.9)
- **SEPOS-PRO-002** — Bidirectional active-order sync. `cloud_id`
  columns on orders + order_items (with unique partial indexes) replace
  the old in-memory id map. New `/api/sync/active-orders` endpoint
  (SYNC_SECRET-gated) feeds the Mac. `pullActiveOrders` upserts by
  `cloud_id` and SKIPS rows with pending `sync_queue` entries to avoid
  the rollback-flash bug. Migration probe (table_id + opened_at) binds
  pre-existing local orders to their cloud counterparts on first run.
- **SEPOS-PRO-003** — Realtime cloud→Mac event relay via
  `src/services/cloudRelay.js`. Mac's local server subscribes to cloud
  socket.io and forwards events through its own local socket.io for
  React. Default sync tick dropped 30s → 5s alongside this, so the
  worst-case "missed event" catch-up is 5 seconds.
- **SEPOS-033 P4 — operator-managed consent** — `PUT /api/customers/marketing-consent`
  endpoint + clickable badge on the Customers tab so opt-in obtained
  off-widget (verbal, phone, paper) can be recorded.
- **SEPOS-034 polish** — Online Order #N labelling across Kitchen,
  Bar, Bill, Receipt (shared helper in `client/src/utils/orderLabel.js`).
  Green "🥡 Collected" button on Pass / Direct kitchen cards closes the
  takeaway order and stamps `closed_at` so it lands in reports.
  Reports + Z report split dine-in vs takeaway totals + counts using
  `splitByOrderType(rows)` helper on the server.
- **Kitchen Direct Mode** — Per-device toggle ("🍽️ Pass mode" ⇄
  "✓ Direct mode") in the kitchen header. In Direct Mode the Pass tab
  is hidden, cooked items stay on the Kitchen tab in a green "Ready
  to go" section, and an "✓ Off Kitchen ({n})" button on the order
  header marks the whole order served at once. Floor-map colour codes
  (starters_done / mains_done / desserts_done) flow through unchanged
  since both modes terminate at `order_items.status='served'`.
- **Timezone fix** — SQLite stores `CURRENT_TIMESTAMP` as naive UTC
  ("2026-05-12 10:00:00"). Mac timers were 1h ahead in UK BST because
  `new Date(...)` parses that string as local. `localDatabase.js`
  `query()` now post-processes every result row, rewriting any naive
  date-time string into ISO 8601 with Z suffix. Cloud mode untouched
  (pg driver already returns proper Date objects).
- **Pass tab cross-browser fix** — `OrderHeading` was declared inside
  the Kitchen tab's `.map()` callback, which Chromium block-scoped
  (per strict-mode spec) while Safari/WebKit hoisted under legacy
  "Web Compat" rules. Hoisted to module scope so the Pass and
  Completed tabs no longer render blank on Mac / Chrome.
- **Brand site overhaul** (`client/Website/`) — Removed live booking
  widget from index.html (demo moved to the Baan Siam mockup site);
  added "Five killer features that pay for SiamEPOS every month" hero
  block on features.html (Online Reservation, Table Map + KDS,
  Online Takeaway 0% fee, AI Sales-vs-Cost Analysis, Mobile as
  Terminal); homepage proof bar + 6-Reasons grid realigned to the
  same five; hero h1 reframed to "pays for itself"; mobile hamburger
  nav across all 7 pages.
- **Baan Siam demo site** (`client/MockUp Website/`) — English-only,
  mobile-friendly, deployed to www.siamepos.net (Netlify + Namecheap
  DNS). Live menu fetched from `/api/menu`. Takeaway widget + booking
  widget embedded. Allergen chips on each dish. About / Press /
  Sourcing / Team sections. Used for sales demos.
- **Release pipeline** — Added `--publish never` to `build:mac` /
  `build:win` / `build:all` scripts so electron-builder doesn't try to
  auto-publish from inside the build step (was failing without
  `GH_TOKEN`). The dedicated `release` job in `.github/workflows/
  release.yml` handles publishing via `softprops/action-gh-release@v2`.

### Known limitations / future tickets
- SEPOS-021 HMRC submission — needs HMRC OAuth sandbox creds
- SEPOS-025 — Receipt printer hardware (ESC/POS direct) — needs Epson/Star device
- SEPOS-026 — Kitchen printer — same device dependency
- SEPOS-027 — Reservations + walk-in management — SMS needs Twilio creds
- SEPOS-029 — Client onboarding package — Railway template + email service
- **SEPOS-033 birthday** — wired but no-op until customer_birthday is
  captured (separate ticket: add field to booking widget + reservations schema)
- **SEPOS-040** — Real Stripe payment on takeaway widget. Per-restaurant
  pk_live/sk_live in their own Railway env (SiamEPOS never holds funds).
  Schema already prepared: payment_status flips mock → pending → paid,
  payment_intent_id stores Stripe ref. Widget's mock-pay step is the
  only UI piece that needs replacement.
- **Orders ↔ reservations linkage** — orders don't carry reservation_id, so
  Customer total_spend is heuristic (table_id + date join). Add
  orders.reservation_id when accurate per-customer revenue matters.
- **Reservations push** — Mac-created bookings stay local. Cloud → local
  pull is wired, push isn't. Add to syncService when needed.
- **Incremental sync** — `pullFromCloud` and `pullActiveOrders` refetch
  full snapshots every tick. At 5s ticks across multiple restaurants this
  inflates Railway egress (~30-50 GB/month per Mac install). Trigger to
  build proper `updated_at`-driven incremental pulls is hitting ~10
  restaurants on the Pro plan; below that, the cost is comfortable.
- **Active-order conflict resolution** — pull is cloud-wins for matched
  rows, but Mac wins if there's a pending entry in `sync_queue` for the
  same row. Real simultaneous edits across Mac + Chrome on the same item
  inside the 5s window will still snap to whichever side pushed last.
  Restaurants typically run one primary terminal so this is rare in
  practice; locking would be the proper fix if it becomes a problem.

- **SEPOS-043 — role-based access hierarchy** (next update)
  Currently every staff PIN that reaches Admin can do everything,
  and the manager-PIN gate on order delete (SEPOS-042) only
  validates the role is one of `admin` / `manager` / `supervisor`.
  Desired hierarchy:
    - `admin` / `manager`: full access (status quo — no change needed)
    - `supervisor`: full Admin access, BUT cannot delete a closed
      bill (Admin → Bills 🗑️ button hidden + backend rejects).
      Supervisor can still delete OPEN orders (Order screen, Kitchen
      tab, Done tab).
    - `waiter`: cannot reach the Admin tab at all (currently the
      Admin section is reachable from the staff login UX with any
      PIN — gate the route by role).
    - `kitchen` / `bar`: same as waiter (no Admin access).
  Implementation will touch:
    - Frontend: AdminScreen route guard, BillsSection (hide 🗑️
      for non-admin/manager), and possibly the staff login flow.
    - Backend: tighten `DELETE /api/orders/:id` to reject
      supervisor when the order is `status='closed'`. Open orders
      stay allowed for supervisor.
    - Add the same role check to `/api/sync/delete-order` so a
      sync-pushed supervisor delete of a closed bill bounces too.
