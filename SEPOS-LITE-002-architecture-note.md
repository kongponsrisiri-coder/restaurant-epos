# SEPOS-LITE-002 — Lite Architecture & Pricing Decision Note

**For:** Korakot + Nick to settle  ·  **Author:** Krit  ·  **Date:** 2026-05-18
**Companion file:** `SEPOS-LITE-002-running-costs.csv`

---

## The decision
SEPOS-LITE-002 puts Lite customers on the **full SiamEPOS app**, not a
separate dashboard. That forces one architectural choice — how each Lite
customer's data is kept separate from every other's:

- **Model A — "Lite as Pro":** each Lite customer gets their **own backend +
  own database**, exactly like a Pro client.
- **Model B — Shared multi-tenant:** one backend + one database for all Lite
  customers, kept apart by `restaurant_id` + Postgres Row-Level Security.

## Recommendation — Model A ("Lite as Pro")
1. **Eliminates the cross-tenant data-leak risk entirely.** Separate
   databases — there is no shared table to leak from. No RLS, and no Phase 2b
   endpoint retrofit (the large, risky workstream).
2. **Reuses infrastructure that already exists** — SiamEPOS already
   auto-provisions per-client deployments for Pro (SEPOS-029).
3. **Ships sooner.** The only Lite-specific code is plan-based feature gating,
   most of which is already built (Phase 2a).
4. **Multi-tenancy is a scale optimisation.** Building it before there is a
   single Lite customer is premature — and premature in a way that carries
   security risk. Migrate to shared infra later *if* Lite volume ever makes the
   per-tenant cost hurt.

## Running cost — the headline
With Korakot now on the **Railway Pro plan** ($20/mo, $20 usage included),
Model A costs roughly **£5–11 per customer per month** in infrastructure (own
small backend + small Postgres; light widget-only traffic). Full line-by-line
breakdown — and the "why" behind each number — is in
`SEPOS-LITE-002-running-costs.csv`.

## Pricing — is £29 too cheap?
**On infrastructure grounds: no.** Model A leaves **~£18–24/month margin** on
the £29 `lite_booking` plan — healthy for an acquisition product.

Two caveats:
- **Support time per customer is the real unknown** — not infra. It needs to
  be filled in (see the CSV); it can dwarf the infra cost.
- **`lite_ordering` at £39 is underpriced for the value** — online takeaway at
  0% commission vs Just Eat's ~14% saves a restaurant doing £2,000/mo online
  about £280+/mo. At £39 it is such a good deal it risks becoming a *permanent
  home* rather than a *bait* — undercutting the convert-to-Pro strategy.
  Consider £49–59, or consciously accept it as a deliberately sticky product.
  This is a positioning call for **Nick**.

## What Model A changes for the build
- **Phase 2b (endpoint read-scoping / RLS) — CANCELLED.** The risky workstream
  is removed.
- Phase 1 / 2a tenancy code (`restaurant_id` columns, `resolveRestaurantId`) —
  goes dormant, harmless (already a no-op in single-tenant mode).
- **Plan-based feature gating** (Phase 2a + the SEPOS-LITE-002 matrix) remains
  and is the whole job — safe, small.
- Pose's Lite onboarding shifts to: *provision a Pro-style deployment, set
  `plan = lite_*`.*

## Decisions needed from Korakot + Nick
1. **Confirm Model A** ("Lite as Pro").
2. **Fill in support-time-per-customer** in the CSV — the one cost unknown.
3. **Nick:** revisit `lite_ordering` pricing (£39 vs ~£49–59).
4. Confirm "the full app" means **`app.siamepos.co.uk`** (the EPOS), not the
   internal `ops.siamepos.co.uk` tool.
