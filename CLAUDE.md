# SiamEPOS — Developer Context for Krit (Claude Code Agent)

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
- Email: src/services/emailService.js (Brevo — exports sendBrevoEmail, sendBookingConfirmation)
- Make.com webhooks: src/services/makeWebhooks.js (hourly cron: lapsed/booking/birthday)
- Booking widget (public): public/widget.js
- Frontend: client/src/
- Screens: client/src/screens/
- Admin sections: client/src/screens/admin/
- API layer: client/src/api.js
- Electron: electron/main.js, electron/preload.js, electron/package.json
- Launcher: start-siamepos.sh (Desktop SiamEPOS.app shortcut + macOS Login Item)

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

## DB Mode (Electron only)
- `DB_MODE=local` + `SQLITE_PATH` env var → src/db/dbAdapter.js routes to SQLite
- `DB_MODE=cloud` (default) → PostgreSQL (Railway)
- Sync engine pushes queued mutations to `CLOUD_API_URL` when reachable,
  pulls menu / staff / settings / tables back to local SQLite
- Per-install config lives at electron/config.json (dev) or
  userData/config.json (packaged) — created by the first-launch wizard

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
- SEPOS-PRO-001 (phases 1-4 + auto-update) — Electron shell, SQLite,
  offline queue, cloud↔local sync, electron-updater via GitHub Releases

### Known limitations / future tickets
- SEPOS-021 HMRC submission — needs HMRC OAuth sandbox creds
- SEPOS-025 — Receipt printer hardware (ESC/POS direct) — needs Epson/Star device
- SEPOS-026 — Kitchen printer — same device dependency
- SEPOS-027 — Reservations + walk-in management — SMS needs Twilio creds
- SEPOS-029 — Client onboarding package — Railway template + email service
- **SEPOS-033 birthday** — wired but no-op until customer_birthday is
  captured (separate ticket: add field to booking widget + reservations schema)
- **Persistent order-item ID mapping** — sync engine has in-memory
  local→cloud order id translation; voids of items from earlier sessions
  can stick in sync_queue. Workaround: `DELETE FROM sync_queue` periodically.
  Proper fix is a `id_map` table in SQLite.
- **Orders ↔ reservations linkage** — orders don't carry reservation_id, so
  Customer total_spend is heuristic (table_id + date join). Add
  orders.reservation_id when accurate per-customer revenue matters.
