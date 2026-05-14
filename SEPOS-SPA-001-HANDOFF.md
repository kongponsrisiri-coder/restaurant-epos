# SiamEPOS Spa — Phase 1 MVP Handoff

**For:** SiamEPOS team (Korakot, Claude, Krit, sales, ops)
**Date:** 14 May 2026
**Developer:** Sam (Spa Dev)
**Ticket:** SEPOS-SPA-001 — Phase 1 MVP Build
**Status:** Code complete · not yet deployed · awaiting first push to GitHub

---

## TL;DR

A brand-new product, **SiamEPOS Spa**, is now feature-complete for Phase 1.
It is a cloud EPOS + appointment management system for Thai massage / spa
businesses in the UK — fully separate from the restaurant EPOS, with its own
backend, frontend, database and public booking widget.

Everything in Section 9 of the SEPOS-SPA-001 ticket (10 steps) is built.
Korakot can `npm install` and run the whole stack locally today. Deployment
to `spa.siamepos.co.uk` + `spa-api.siamepos.co.uk` is the next step.

---

## Where the code lives

`~/Desktop/restaurant-epos/spa-epos/` — **own project, own GitHub repo
(to be created)**, deploys to its own Railway + Netlify. Must NOT share
the restaurant repo or database. The restaurant `.gitignore` should add
`spa-epos/` so GitHub Desktop stops mixing the two.

---

## What's built

### 🛠 Backend — Express + PostgreSQL on Railway
- 10-table schema (treatments, categories, therapists, availability, rooms,
  clients, **client_medical**, appointments, bills, settings) — all created
  idempotently on every boot via `initSchema()`.
- **35 REST endpoints** across 11 route files covering treatments, therapists
  + availability, rooms, appointments + slot computation, clients + medical,
  bills + tip + pay, Stripe (intent + webhook), reports, settings, and the
  public booking widget.
- JWT staff auth via PIN keypad (bcrypt-hashed). Default admin (`PIN 1234`)
  auto-seeded on first boot — **must be changed in production**.
- Socket.io live updates (`new_appointment`, `appointment_updated`,
  `appointment_status`) so multiple terminals stay in sync.
- Brevo email service ready for booking confirmations.

### 💻 Frontend — React + Vite on Netlify
- **6 main screens** — Login (PIN keypad), Appointments (day list with
  Start / Cancel / Checkout), Checkout (tip suggestions + Cash / Card /
  Split), Client Search, Client Profile (with appointment history), Admin.
- **Client medical questionnaire** — full contraindications checklist,
  medications, allergies, areas to avoid, **digital signature pad**, GDPR
  consent gate. Required by UK law before any treatment.
- **8 admin sections** — Trading, Reports, Z Report, Treatment Menu,
  Therapists (with weekly availability editor), Rooms, Booking Settings,
  General Settings.
- **GDPR erasure** — Admin-only permanent delete with audit log.
- **Stripe Elements** card payment modal — opens on "Card" at checkout,
  webhook flips bill to paid server-side.

### 🌐 Public booking widget
- Embeddable from the backend domain — one `<script>` tag works on any
  external site (the spa's own marketing page, partner directories, etc.).
- 5-step modal: treatment → date/slot → therapist → contact + GDPR →
  confirmation + Brevo email.
- Race-safe: re-checks availability inside the booking transaction so two
  simultaneous bookings can't grab the same slot.

---

## What everyone needs to know

**Sales / Demo:** When this is deployed, the demo flow is:
1. Customer books on a "spa website" via the embedded widget.
2. Booking instantly appears in the staff EPOS (Appointments screen, via
   Socket.io — sub-second).
3. Therapist taps Start → Checkout → Card → enters card in Stripe → paid.
4. Trading + Z-report figures update in Admin.

**Ops / Onboarding:** First-deploy steps are in `spa-epos/CLAUDE.md` under
**Deployment Runbook** — Railway env vars, Stripe webhook setup, custom
domains. Default admin PIN `1234` must be replaced via Admin → Therapists
immediately after first login.

**Dev (Krit):** Do not touch `spa-epos/`. It is a separate codebase from the
restaurant. The two products do not share schema, code, or auth.

---

## What is NOT yet done (Phase 2 / SEPOS-SPA-002+)

- Loyalty + gift vouchers
- Package deals (pre-paid blocks of N treatments)
- SMS reminders (needs Twilio creds)
- No-show deposits via Stripe pre-auth
- Multi-site / chain support
- Desktop (Electron) shell — Phase 1 is cloud-only, browser + iPad

---

## Next actions

1. **Korakot** — push `spa-epos/` to its own GitHub repo (see steps in our
   chat / `spa-epos/CLAUDE.md`).
2. **Korakot / Claude** — provision Railway project + Postgres + custom
   domain `spa-api.siamepos.co.uk`.
3. **Korakot / Claude** — provision Netlify site + custom domain
   `spa.siamepos.co.uk`. Build config already in `spa-epos/client/netlify.toml`.
4. **Korakot** — get a per-spa Stripe account, paste `STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` into Railway. Add the
   webhook in Stripe pointing at `…/api/stripe/webhook`.
5. **Sam** — start Phase 2 once a real spa is live and giving feedback.

— Sam
