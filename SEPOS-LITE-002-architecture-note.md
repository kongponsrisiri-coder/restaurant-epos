# SEPOS-LITE-002 — Architecture Decision Note

**Date:** 2026-05-18  
**Author:** Korakot (with Claude)  
**Reviewers:** Nick  
**Status:** Model A CONFIRMED by Korakot 2026-05-18 — Nick still to confirm Lite Ordering price  

---

## Context

SiamEPOS Lite is a new widget-only product targeting restaurants already on another EPOS. It offers booking and/or online ordering widgets at £39–69/month, with the explicit goal of being a "land and convert" strategy — restaurants on Lite that outgrow it upgrade to SiamEPOS Pro (£89/month).

SEPOS-LITE-001 Phase 1 added a multi-tenant schema to the existing backend (restaurant_id on 19 tables, restaurants registry). This note decides what happens next: do we **keep building on the shared architecture**, or **spin each Lite customer their own backend**?

---

## The Two Models

### Model A — "Lite as Pro" (recommended)

Each Lite customer gets:
- Their own Railway service (cloned from the Pro backend)
- Their own Railway Postgres instance
- A subdomain (e.g., `baan-siam.lite.siamepos.co.uk`)

This is identical to how Pro customers are onboarded today.

**Running cost: ~£5–11/customer/month infra** (ex-support)  
**Margin on £39 plan (Booking): ~£28–34/month** (ex-support)  
**Margin on £49 plan (Ordering): ~£38–44/month** (ex-support)  
**Margin on £69 plan (Bundle): ~£57–64/month** (ex-support)

### Model B — Multi-tenant (shared backend + DB)

All Lite customers share one Railway service and one Postgres database. Data is isolated by `restaurant_id` on every query. This is what the Phase 1 schema work was building toward.

**Running cost: ~£1.30–3.70/customer/month infra** (ex-support, ex-Phase 2b dev cost)  
**Margin on £39 plan (Booking): ~£35–38/month** (ex-support)

---

## Why Model A Wins

### 1. Cost difference is smaller than it looks

Model B saves ~£3–7/customer/month on infra. On a £29 plan both models are profitable. The saving is real but not the deciding factor.

### 2. Phase 2b is risky and slow

To make Model B production-safe, all ~40 backend endpoints need retrofitting with tenant middleware. That is 2–4 weeks of Krit's time touching every route in a live production server. One missed `WHERE restaurant_id = $1` sends a customer's booking data to another restaurant. That is a GDPR incident, not a bug.

Model A avoids Phase 2b entirely. We deploy a fresh instance — the same way we'd onboard a Pro customer — and Phase 2b never needs to happen.

### 3. Model A deletes the GDPR data-leak risk

With separate databases, cross-tenant data leakage is architecturally impossible. With a shared DB it requires perfect query discipline, forever, across every future endpoint. ICO fines for a GDPR breach are up to 4% of annual turnover or £17.5M. Model A eliminates this exposure at the cost of ~£3–7/month of Railway spend.

### 4. Onboarding is simpler and already understood

We know how to spin up a new Railway service. We've done it for Pro. A Lite onboarding script (`scripts/provision-lite.sh`) can clone the service, set environment variables, and run migrations in under 10 minutes. No new middleware, no tenant-awareness code, no regression risk to existing Pro customers.

### 5. Conversion to Pro is seamless

When a Lite customer upgrades to Pro, their database already has the right schema. We update their plan in Stripe, point them to the full app, and done. With a shared DB we'd need to extract and migrate their rows out of the multi-tenant tables — more work at the moment we most want the conversion to be frictionless.

---

## What This Means for Phase 1 Work

The multi-tenant schema Krit built in Phase 1 is not wasted:

- The `restaurants` registry table stays — used to track all Lite customers and their plan status.
- The `restaurant_id` default `'siamepos'` on existing tables is harmless — it simply never gets used for routing.
- Phase 2a (tenant middleware, tenantQuery helper) can be built as dead code for a future decision. It is safe and non-breaking.
- **Phase 2b (endpoint retrofit) is cancelled.** Do not start it.

---

## Open Questions — Korakot + Nick to Resolve

### Q1: Support time cost (blocking — FILL IN before launch)

The running-cost CSV has a "Support time — FILL IN" line. Infra is cheap. The unknown is: how long does Korakot (or a future support hire) spend per Lite customer per month? At early stage this could be 30–60 mins/month per new customer while they learn the widgets.

**Action:** Estimate hours × your effective hourly rate and add to the CSV. This changes the break-even customer count significantly.

### Q2: Pricing confirmed — Korakot's decision

Pricing locked:
- **Lite Booking: £39/month**
- **Lite Ordering: £49/month**
- **Lite Bundle: £69/month** (£88 separately → £19 saving; premium anchor tier)

At £49/month, a restaurant on Just Eat paying 7% on £4,000/month saves **£280/month** by switching. The widget costs them £49. That is a 5.7× ROI. Nick: make sure the pricing page leads with this number.

### Q3: At what customer count do we revisit Model B?

Model B becomes worth the risk at very high scale (100+ Lite customers) where the per-customer Railway cost becomes material. Suggested trigger: revisit when Lite has 50 paying customers and Railway costs exceed £500/month.

---

## Decision

| Question | Decision |
|---|---|
| Model A vs Model B | **Model A — "Lite as Pro"** |
| Phase 2b (endpoint retrofit) | **Cancelled** |
| Phase 2a (tenant middleware) | Proceed — safe, non-breaking |
| Lite Ordering price | **Nick to decide: £39 (current) or £49–59** |
| Support time | **Korakot to fill in before launch** |
| Lite customer management | **Back office (ops.siamepos.co.uk)** — same as Pro |

---

## Lite customer management — the back office

**Decided 2026-05-18:** Lite customers are managed from the existing
**back office (ops.siamepos.co.uk)** — the same place the team already
manages Pro clients. Under Model A a Lite customer *is* a client like any
other: their own deployment, an entry in the back-office client list, with
`plan` set to a lite tier instead of `pro`.

This means:
- **No separate Lite admin system.** The back-office client list, per-client
  provisioning (SEPOS-029), health monitoring, notes and billing all apply to
  Lite customers unchanged.
- Onboarding a Lite customer = the back-office `NewClientWizard` with a plan
  picker; provisioning spins up a Lite deployment the same way it does for Pro.
- **Important boundary:** the back office is the *team's* tool. Lite
  *customers* never log into `ops.siamepos.co.uk` — they use the main EPOS app
  (`app.siamepos.co.uk`), with features gated by their plan. ops = how the
  team runs the business; app = what the customer uses.

This further supersedes Pose's separate Lite dashboard/client at
`siamepos-lite.netlify.app` — see the Pose handoff in `TEAM-STATUS.md`.

---

## Next Steps

- [ ] **Korakot:** Fill in support time estimate in `SEPOS-LITE-002-running-costs.csv`
- [ ] **Nick:** Decision on Lite Ordering price (£39 vs £49–59) — update pricing page + business plan v5
- [ ] **Krit:** Build `scripts/provision-lite.sh` — clone Railway service, set env vars, run migrations, create `restaurants` row
- [ ] **Krit:** Phase 2a only — tenant middleware + tenantQuery helper + MULTI_TENANT flag (dead code until wired)
- [ ] **Korakot:** Create 4 Stripe Products (Lite Booking, Lite Ordering, Lite Bundle, Pro) to get STRIPE_PRICE_* IDs
- [ ] **All:** Once first real Lite customer onboards, run the provision script end-to-end and document time taken
