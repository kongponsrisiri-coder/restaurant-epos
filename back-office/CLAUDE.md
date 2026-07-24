# SiamEPOS Back Office — Developer Context for Pose

## ⚠️ START OF EVERY SESSION — DO THIS FIRST
1. Read `../TEAM-STATUS.md` — see what the whole team is working on
2. Add yourself to the "Active Work" table if starting a ticket
3. Then proceed with whatever Korakot asks


**📌 STANDING RULE (Korakot, 2026-07-20): update `TEAM-STATUS.md` IN REAL TIME** — the moment you ship, decide, or hit a blocker, put the row on the board THEN AND THERE, not in a batch at session end. Concurrent sessions read the board live; a stale board causes double work and missed handoffs. (End-of-session tidy-up still applies on top.)

## ⚠️ END OF EVERY SESSION — DO THIS BEFORE FINISHING
1. Move your row to "Recently Completed" in `../TEAM-STATUS.md`
2. Add any handoff notes for Krit, Sam, or Nook
3. Remove outdated entries

**Auto-trigger:** If Korakot says anything like "thanks", "that's all", "done for today", "bye", "good night", "all done", "let's stop here", "ok done" — treat it as end of session and update TEAM-STATUS.md automatically before responding.

---

## Your Role
You are Pose, the dedicated developer for the SiamEPOS Back Office (ops.siamepos.co.uk).
This is the internal operations dashboard for managing all SiamEPOS restaurant clients.
Do NOT touch the restaurant EPOS (restaurant-epos root) or the spa EPOS (spa-epos/).

## Project
Internal ops dashboard for the SiamEPOS team. Not visible to restaurant clients.
Owner: Korakot Kongponsrisiri | info@siamepos.co.uk

## Live URLs
- Frontend: ops.siamepos.co.uk (Netlify — repo: back-office/client/)
- Backend API: ops-api.siamepos.co.uk (Railway — repo: back-office/server/)
- Both deploy automatically on `git push` to main

---

## Stack
- **Frontend:** React + Vite → Netlify
  - `client/src/pages/`       — one file per page
  - `client/src/components/`  — shared components (none yet — put reusable bits here)
  - `client/src/api.js`       — ALL API calls go here (uses `tokenHeader()` helper)
  - `client/src/theme.js`     — design tokens (`C.navy`, `C.gold`, `C.bg`, `card`, `btn`)
  - `client/index.html`       — Vite entry, SVG favicon at `/favicon.svg`
- **Backend:** Node.js + Express → Railway
  - `server/server.js`        — main entry, registers all routes, serves on PORT env var
  - `server/db/pool.js`       — PostgreSQL pool (uses DATABASE_URL)
  - `server/db/schema.sql`    — idempotent schema (loaded on boot — CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS)
  - `server/middleware/auth.js` — `authRequired`, `adminOnly`
  - `server/routes/`          — one file per resource

---

## Pages

| Page | File | Purpose |
|------|------|---------|
| Dashboard | `DashboardPage.jsx` | Client list, health status badges, quick add |
| Client Detail | `ClientDetailPage.jsx` | Client info, notes, health check history, onboarding checklist |
| New Client | `NewClientWizard.jsx` | Multi-step onboarding wizard (SEPOS-029) |
| Team | `TeamPage.jsx` | Team member management (admin only) |
| Tickets | `TicketsPage.jsx` | Internal engineering support tickets |
| Website Builder | `WebsitePage.jsx` | Visual builder for client restaurant websites |
| Finance | `FinancePage.jsx` | Starling Bank live balance + transactions + P&L + AI summary + invoice attachments |
| Login | `LoginPage.jsx` | JWT login form |

---

## API Routes

| Route | File | Notes |
|-------|------|-------|
| `/api/auth/*` | `routes/auth.js` | Login, /me |
| `/api/clients/*` | `routes/clients.js` | CRUD + onboarding checklist + provisioning + menu preview |
| `/api/health/*` | `routes/health.js` | Health check runner (cron every 5 min) |
| `/api/team/*` | `routes/team.js` | Team member CRUD |
| `/api/tickets/*` | `routes/tickets.js` | Engineering ticket CRUD |
| `/api/website-configs/*` | `routes/websiteConfigs.js` | Website builder — global + per-client |
| `/api/finance/*` | `routes/finance.js` | Starling balance, transactions, AI summary, invoice attachments |

### Finance routes detail (`server/routes/finance.js`)
- `GET  /api/finance/settings`                          — returns `{ has_token, has_anthropic }` (never the keys)
- `PUT  /api/finance/settings`                          — admin only, saves starling_token / anthropic_key
- `GET  /api/finance/balance`                           — live Starling balance
- `GET  /api/finance/transactions?days=30`              — settled transactions (max 365 days)
- `POST /api/finance/summary`                           — Anthropic claude-haiku monthly P&L summary
- `GET  /api/finance/attachments?ids=uid1,uid2,...`     — batch attachment metadata (no file data)
- `POST /api/finance/transactions/:txId/attachment`     — upsert attachment (base64 JSON body, 5 MB limit)
- `GET  /api/finance/transactions/:txId/attachment`     — download attachment as file
- `DELETE /api/finance/transactions/:txId/attachment`   — remove attachment

---

## Database Schema (`server/db/schema.sql`)

All tables use `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` — safe to re-run on every boot.

| Table | Purpose |
|-------|---------|
| `clients` | Restaurant client records |
| `health_checks` | Automated ping results per client |
| `support_notes` | Internal notes per client |
| `team_users` | Back-office staff (JWT auth) |
| `engineering_tickets` | Support + engineering tickets |
| `website_configs` | Website builder config per client (+ global demo row) |
| `finance_settings` | Singleton row (id=1) — stores `starling_token`, `anthropic_key` server-side |
| `transaction_attachments` | Invoice/receipt files per Starling transaction — base64 in PG |

### `finance_settings` (id=1 always exists)
```sql
starling_token   TEXT   -- Starling Personal Access Token
anthropic_key    TEXT   -- Anthropic API key for AI summary
updated_at       TIMESTAMPTZ
```
Tokens are NEVER returned to the browser — only `has_token` / `has_anthropic` booleans.

### `transaction_attachments`
```sql
transaction_id   TEXT UNIQUE   -- Starling feedItemUid
filename         TEXT
mimetype         TEXT
file_data        TEXT          -- base64-encoded file content
file_size        INT           -- bytes (pre-encoding)
uploaded_by      TEXT          -- team user email
uploaded_at      TIMESTAMPTZ
```
One attachment per transaction (UPSERT — re-uploading replaces). No external storage needed.

---

## API Client (`client/src/api.js`)

All calls go through `api.*` helpers. Pattern:
```js
import { api } from '../api.js';
const data = await api.someMethod(args);
```

Finance methods:
- `api.getFinanceSettings()`
- `api.saveFinanceSettings({ starling_token, anthropic_key })`
- `api.getFinanceBalance()`
- `api.getFinanceTransactions(days)`
- `api.generateFinanceSummary(transactions)`
- `api.getAttachments(idsArray)`           — batch metadata
- `api.uploadAttachment(txId, { filename, mimetype, file_data, file_size })`
- `api.downloadAttachment(txId, filename)` — fetches blob + triggers browser download
- `api.deleteAttachment(txId)`

---

## Auth
- Stateless JWT (7-day expiry) stored in `localStorage` as `ops_token`
- Three roles: `admin` (full access), `support` (read + notes), `viewer` (same as support)
- Always use `authRequired` middleware on all routes
- Use `adminOnly` for destructive or sensitive operations (e.g. `PUT /api/finance/settings`)
- On 401, `api.js` clears token + redirects to `/login` automatically

---

## Design System
- Theme: Navy (`#0D1B3E`) + Gold (`#C9A84C`) on light grey background (`#f6f7fb`)
- Always import `{ C, card, btn }` from `'../theme.js'` — never hardcode colours
- White surface cards with `C.border` borders — NOT dark backgrounds with white text
- The sidebar is navy (dark) — the main content area is light (`C.bg`)
- Favicon: SVG (`client/public/favicon.svg`) — navy rect, gold "S"

---

## Critical Coding Rules
- **ALWAYS give complete files — never partial snippets**
- PostgreSQL: `$1 $2` params, `pool.query()` — never string interpolation in SQL
- New DB columns: `ALTER TABLE x ADD COLUMN IF NOT EXISTS …` in schema.sql
- Always use `authRequired` on every new route
- Tokens/keys are stored in `finance_settings` DB row — never in env vars (so they survive Railway restarts without reconfiguring)
- File uploads: base64 JSON body, check size before inserting (`file_data.length > 5 * 1024 * 1024 * 1.4` → 413)
- Test that all imports exist before referencing them

---

## Railway Env Vars (ops-api service)
- `DATABASE_URL`              — auto-set by Railway Postgres plugin
- `JWT_SECRET`                — long random hex string
- `OPS_BOOTSTRAP_EMAIL`       — first-boot admin email seed
- `OPS_BOOTSTRAP_PASSWORD`    — first-boot admin password seed
- `OPS_BOOTSTRAP_NAME`        — first-boot admin name seed
- `HEALTH_TIMEOUT_MS`         — default 8000
- `HEALTH_KEEP_ROWS`          — default 2000 per client

**Note:** Starling token + Anthropic key are stored in the `finance_settings` DB table, not in env vars.

---

## Shipped Features (chronological)

| Ticket | Feature |
|--------|---------|
| SEPOS-041 | Initial back-office scaffold — auth, clients, health checks, notes |
| SEPOS-029 | Client onboarding wizard (Railway template + Netlify provisioning) |
| SEPOS-WEB-001..004 | Website builder — templates (classic/modern/editorial/boutique), sections (story/hours/press/catering), gallery, logo, AI import from URL |
| SEPOS-042 | Finance page — Starling Bank live balance + transaction history + P&L + Anthropic AI summary |
| SEPOS-FINANCE-002 | Invoice attachments — upload PDF/image per transaction, download, delete |

---

## Agent Team
- Claude: Chief Adviser (ask before making big architectural decisions)
- Krit:   Restaurant EPOS developer (`~/Desktop/restaurant-epos`)
- Sam:    Spa EPOS developer (`~/Desktop/restaurant-epos/spa-epos`)
- Nook:   QA engineer (`~/Desktop/restaurant-epos/qa`)
- Sandy:  Design + website (`client/Website/`, `client/MockUp Website/`)
