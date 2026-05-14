# SEPOS-029 — Client Onboarding Package

**Author:** Korakot + Claude (Cowork Krit)
**Date:** 2026-05-14
**Priority:** 🟡 MEDIUM — blocks scaling past first 2–3 customers
**Status:** OPEN
**Owner:** Krit (Terminal)

---

## Goal

Reduce time-to-go-live for a new restaurant customer from **2–4 hours of manual work** down to **under 30 minutes**, with a repeatable, low-error process.

SiamEPOS is **per-tenant** — every customer gets their own Railway backend, their own PostgreSQL database, their own Netlify frontend, their own subdomain. We are not building multi-tenancy in the same DB. This ticket is about automating the provisioning of a fresh, isolated tenant stack.

---

## Why this matters now

- Manual onboarding is the #1 thing that will slow Korakot down once the first 3–4 paying customers land.
- Every manual step (env vars, DNS, menu import, staff PINs) is a place where a typo costs hours of debugging.
- The `back-office` already has a `clients` table (SEPOS-041 schema) — it's the natural home for this wizard.
- Without this, we can't run a real "sign up → go live in a day" sales pitch.

---

## Current state (manual checklist — what we do today)

For each new customer, Korakot currently has to:

1. Fork the `restaurant-epos` Railway project → rename → wait for build
2. Manually set ~12 env vars on Railway (BREVO_API_KEY, ANTHROPIC_API_KEY, SYNC_SECRET, RESTAURANT_NAME, RESTAURANT_EMAIL, RESTAURANT_ADDRESS, PUBLIC_API_URL, UNSUB_SECRET, MAKE_* webhooks)
3. Wait for Postgres to be provisioned + schema to auto-create on first boot
4. Deploy the `client/` build to a new Netlify site
5. Set `VITE_API_URL` on Netlify to the new Railway URL
6. Add a Netlify subdomain (e.g. `bangkok.siamepos.co.uk`) and CNAME it
7. Log in as admin, manually create tables (Admin → Table Plan)
8. Either import menu by AI scanner OR type it in by hand
9. Create staff PINs (owner manager PIN + a couple of placeholder staff)
10. Set VAT rate, service charge rate, service_charge_enabled
11. Configure Stripe Connect (if takeaway) — pk_live / sk_live in Railway env (SEPOS-040 dependency)
12. Build + send desktop installer to owner (Mac DMG or Windows EXE)
13. Add a row to `back-office.clients` with railway_url, plan, monthly_fee, trial_start
14. Send welcome email with login details, owner PIN, desktop installer link

This is ~2–4 hours and has zero error tolerance.

---

## Target state

A single **"New Client" wizard** in the back office (ops.siamepos.co.uk) that walks an operator through onboarding in 5 screens, automating as many of the 14 steps above as practical.

---

## Implementation plan — three phases

### Phase 1 — Onboarding Wizard + Email Automation (3–5 days)

The "make our lives 10x easier today even without infra automation" phase.

**Backend (`back-office/server/`)**

1. New endpoint `POST /api/clients/onboard` accepts:
   ```
   {
     restaurant_name, owner_name, owner_email, phone,
     vat_number, address, plan ('trial'|'starter'|'pro'),
     monthly_fee, trial_start_date,
     // wizard-only fields (not stored as columns — stuffed into metadata JSONB):
     subdomain_slug, brevo_api_key, anthropic_api_key,
     sync_secret, owner_pin, has_takeaway, has_reservations
   }
   ```
2. Endpoint:
   - INSERTs into `clients` table with `status='setup'`
   - Generates a **fresh `SYNC_SECRET`** via `crypto.randomBytes(32).toString('hex')` if not provided
   - Generates a **welcome email** via Brevo with all credentials, owner PIN, support contact, link to docs, link to desktop installer (latest GitHub Release)
   - Generates a **printable PDF "Owner's Quick Start"** (use pdfkit) attached to the email — 1 page, big print, covers: how to log in, how to add staff, how to fire an order, how to call support
   - Returns a **checklist JSON** showing which steps are automated vs still manual

3. New endpoint `GET /api/clients/:id/onboarding-checklist` — returns the same checklist so the operator can tick items off in the back office UI.

4. Add to `clients.metadata` JSONB a `onboarding` key:
   ```
   {
     railway_provisioned: false,
     netlify_provisioned: false,
     dns_pointed: false,
     menu_imported: false,
     staff_pins_created: false,
     stripe_connected: false,
     desktop_installer_sent: false,
     go_live_date: null
   }
   ```

**Frontend (`back-office/client/`)**

5. New page: `pages/NewClientWizard.jsx` — 5-step wizard:
   - **Step 1 — Restaurant details:** name, owner, email, phone, VAT, address, plan
   - **Step 2 — Tech setup:** subdomain slug (auto-generates from name), reserved env vars (show generated SYNC_SECRET, accept Brevo + Anthropic keys), select features (takeaway / reservations / inventory)
   - **Step 3 — Stripe Connect (if takeaway selected):** placeholder "we'll send the Stripe Connect link separately" until SEPOS-040
   - **Step 4 — Owner credentials:** set master PIN (default 9999, ask operator to change), set restaurant-default staff (chef PIN, waiter PIN), generates `staff_seed.sql` they can run against the new Railway DB
   - **Step 5 — Review + Send Welcome Email:** shows summary, send button, displays checklist of what's automated vs what the operator must still do manually (Railway clone, Netlify deploy, DNS)

6. New page: `pages/ClientDetail.jsx` — once a client exists, shows the onboarding checklist with tickboxes. Once all are ticked, client status flips `setup → live` and `go_live_date` is stamped.

**Welcome email template** (`back-office/server/templates/welcome.html`) — Brevo HTML email with:
- Big "Welcome to SiamEPOS" header
- Their backend URL, frontend URL, owner PIN
- "Download the desktop app" button → latest GitHub Release DMG/EXE
- Support contact: info@siamepos.co.uk
- Attached: `Owner-Quick-Start.pdf`

**Deliverable for Phase 1:** Operator (Korakot) fills the wizard in ~10 minutes. Welcome email + PDF goes out. Manual infra steps (Railway, Netlify, DNS) are listed clearly on the ClientDetail checklist so nothing is forgotten.

---

### Phase 2 — Railway Template + Provisioning Scripts (5–7 days)

The "stop touching the Railway dashboard" phase.

7. Create a **Railway template** for `restaurant-epos`:
   - Document at https://railway.app/new/template?template=...
   - All required env vars declared as `template variables` so Railway prompts for them on deploy
   - Includes Postgres add-on
   - Auto-runs `npm start`
   - One-click clone from the back office

8. Add **shell scripts** in `back-office/scripts/`:
   - `provision-netlify.sh {slug}` — uses Netlify CLI to create a new site, set `VITE_API_URL`, deploy `client/dist`, add subdomain
   - `seed-tenant-db.sh {railway_db_url} {staff_seed.sql}` — runs psql against the new Railway DB to insert owner staff row + default settings rows
   - `send-installer-link.js {email}` — sends a follow-up email with the desktop installer link

9. Back office UI gets **"Provision Now" buttons** next to each checklist item that wire to these scripts (executed server-side via child_process). Backend logs the output streamed to the wizard.

10. **Subdomain automation:** integrate Netlify API (`/api/sites/{site_id}/domain_aliases`) so the operator types the subdomain in Step 2 and it Just Works.

**Deliverable for Phase 2:** Operator fills the wizard, clicks "Provision", and 3–5 minutes later the new tenant is live at their subdomain with seeded admin + default settings.

---

### Phase 3 — Self-Service Sign-Up (long-term, 2+ weeks)

The "customer signs up themselves on siamepos.co.uk" phase. Out of scope for the first version of this ticket — but the schema and endpoints should not preclude it.

11. Public signup form on siamepos.co.uk → hits the same `POST /api/clients/onboard` endpoint
12. Stripe Checkout for plan subscription (£X/mo) → on successful payment, auto-provision
13. Self-service Stripe Connect onboarding for their takeaway widget (SEPOS-040 dependency)
14. Self-service menu import: upload menu PDF/photo → Anthropic API scans → preview → confirm

---

## Files to touch (Phase 1 minimum viable)

### Back office backend
- `back-office/server/db/schema.sql` — already has `clients` + `metadata`, nothing new needed
- `back-office/server/routes/clients.js` — add `POST /onboard`, `GET /:id/onboarding-checklist`, `PUT /:id/checklist`
- `back-office/server/services/welcomeEmail.js` — **new** — composes the welcome email + PDF attachment via Brevo
- `back-office/server/services/quickStartPdf.js` — **new** — pdfkit-based 1-page printable
- `back-office/server/templates/welcome.html` — **new** — Brevo HTML template

### Back office frontend
- `back-office/client/src/pages/NewClientWizard.jsx` — **new** — 5-step wizard
- `back-office/client/src/pages/ClientDetail.jsx` — extend with onboarding checklist UI
- `back-office/client/src/api.js` — add `onboardClient()`, `getOnboardingChecklist()`, `updateChecklistItem()`

### Seed data
- `back-office/server/db/seed_staff.sql.template` — **new** — `INSERT INTO staff` with `{{owner_pin}}`, `{{chef_pin}}`, `{{waiter_pin}}` placeholders
- `back-office/server/db/seed_settings.sql.template` — **new** — `INSERT INTO settings` with sensible UK defaults (VAT 20, service charge 12.5%, currency £)

### Docs
- `back-office/ONBOARDING.md` — **new** — internal runbook for the operator running the wizard. Step-by-step for Railway clone + Netlify deploy + DNS for the manual bits Phase 1 doesn't automate.

---

## Schema migration (additive only)

No new tables. The existing `clients.metadata` JSONB is enough for onboarding state.

If we want to query "which clients have not gone live in 7 days", we'd add a generated column or index — but that's a Phase 2 nice-to-have.

---

## Coding rules reminder (CLAUDE.md)

- ALWAYS complete files, never partial
- Postgres `$1 $2` params, `pool.query()` — Korakot is on Postgres in back-office (no SQLite mode there)
- Commit format: `feat: SEPOS-029 Phase 1 — onboarding wizard + welcome email`
- Explain every step in PR description — Korakot is learning

---

## Acceptance criteria — Phase 1

- [ ] Operator can complete the 5-step wizard for a new client in ~10 minutes
- [ ] Welcome email lands in owner's inbox within 30 seconds of "Send"
- [ ] `Owner-Quick-Start.pdf` is attached and looks professional
- [ ] `clients` row is created with `status='setup'` and `metadata.onboarding` populated
- [ ] ClientDetail page shows a tickable checklist of remaining manual steps
- [ ] Generated `staff_seed.sql` is downloadable from the wizard's Step 5
- [ ] All endpoints return useful error messages (no naked 500s)
- [ ] Wizard works on mobile (Korakot does ops from his phone sometimes)

## Acceptance criteria — Phase 2

- [ ] Railway template URL works and prompts for env vars correctly
- [ ] Netlify CLI script creates site + subdomain + deploys in one command
- [ ] "Provision Now" button in back office triggers the scripts and streams logs to the UI
- [ ] End-to-end: wizard → provision → owner can log in within 5 minutes

---

## Notes / gotchas

- **SYNC_SECRET must match** between Railway env var and the desktop app's `config.json`. The wizard must surface the generated secret prominently so Korakot doesn't lose it when configuring the owner's Mac/Windows install.
- **Brevo API key** — each tenant uses their OWN Brevo account (so emails come from the restaurant's domain, not SiamEPOS). The wizard should make clear this is required and explain how to get one.
- **Anthropic API key** — for the AI menu scanner. We could share SiamEPOS's key for trial customers and switch to theirs on upgrade.
- **PUBLIC_API_URL** must be set BEFORE the first booking email goes out (unsubscribe link is built from it). Default to `https://{railway_app_name}.up.railway.app` if not provided.
- **Stripe Connect** is SEPOS-040 — for Phase 1, just collect "intends to use takeaway?" boolean and flag the client in the checklist as "needs Stripe later".
- **Birthday capture** is not yet wired (per CLAUDE.md) — the welcome email should not promise birthday automation until that ships.
- **Desktop installer link** — point at `https://github.com/kongponsrisiri-coder/restaurant-epos/releases/latest`. The repo is private — confirm public release downloads still work for owners without a GitHub account (they should — GitHub Release assets are public even on private repos if you use the direct file URL).

---

## Out of scope for this ticket

- Multi-tenancy in the same DB — explicitly rejected
- Self-service signup form on siamepos.co.uk — Phase 3, separate ticket later
- Stripe billing for the SiamEPOS subscription itself — separate ticket (SEPOS-046 maybe)
- Automated DNS for custom domains (e.g. customer wants `epos.bangkokkitchen.co.uk`) — keep manual for now, document in ONBOARDING.md

---

## Quick test plan after Phase 1 ships

1. Korakot creates a fake test client "Test Kitchen" in the wizard
2. Welcome email lands in his inbox, PDF opens correctly
3. ClientDetail shows checklist with 7 unticked items
4. Manually tick through items as he provisions the real infra
5. When all ticked, status flips to `live` and `go_live_date` is set
6. Delete the test client cleanly — no orphaned rows
