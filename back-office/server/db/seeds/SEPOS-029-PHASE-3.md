# TICKET: SEPOS-029-PHASE-3
## Public self-service signup at siamepos.co.uk

```
Priority: LATER
Status:   OPEN
Blocks:   nothing right now — Phase 2 already gets onboarding to ~10 min
Affects:  siamepos.co.uk marketing site, back-office /api/clients/onboard,
          new Stripe billing for the SiamEPOS subscription itself
```

---

## Goal

Currently a customer signs up by emailing Korakot, who logs into
ops.siamepos.co.uk and runs the 5-step onboarding wizard. Phase 3 puts
that wizard on the public siamepos.co.uk site so customers self-onboard.

This becomes meaningful once we're closing 5+ new customers a month —
below that, doing it by hand is fine.

---

## What to build

### Public signup form on siamepos.co.uk

- New page on `client/Website/` (the marketing site)
- Same 5-step wizard layout as the back-office, but skinned for the
  marketing site brand
- Step 1–4 collect the same data; Step 5 redirects to Stripe Checkout
- On successful payment, Stripe webhook hits `POST /api/clients/onboard`
  on the back-office with `stripe_subscription_id` in the metadata

### Stripe billing for SiamEPOS itself

This is SEPARATE from the per-tenant Stripe Connect for takeaway (SEPOS-040).
Plans (TBD with Korakot, suggested):

| Plan | Price | What's included |
|---|---|---|
| Cloud  | £49/mo  | EPOS web app, bookings, takeaway, basic reports |
| Pro    | £99/mo  | + desktop app, offline mode, advanced reports, inventory |

On successful Stripe Checkout → back-office gets the webhook → creates
the client row → triggers the auto-provision flow (Railway template +
Netlify) — same path as the manual wizard, just kicked off by the
webhook instead of an ops click.

### Self-service Stripe Connect onboarding for takeaway

Independent of plan signup: from the new tenant's admin, click "Enable
online takeaway" → background opens Stripe Connect's hosted onboarding
flow → KYC handled by Stripe → tenant comes back with `acct_…` already
saved.

### Self-service menu import

Already exists via the AI menu scanner — but currently lives behind admin
login. New tenants on the public signup should land directly on the
"upload your menu" page right after signup completes.

---

## Acceptance criteria

- [ ] Public signup form on siamepos.co.uk with the same 5 steps
- [ ] Stripe Checkout integration for the SiamEPOS subscription
- [ ] Webhook → onboard endpoint → auto-provision Phase 2 scripts run
- [ ] New tenant lands on `{slug}.siamepos.co.uk` admin within 5 min of
      completing checkout
- [ ] Self-service Stripe Connect link for takeaway from tenant admin
- [ ] First-run menu import prompt (uses existing AI scanner)

---

## Out of scope

- **Cancellation flow** — for v1 customers email Korakot to cancel. Later
  ticket for full subscription self-management.
- **Plan upgrades / downgrades mid-period** — same.
- **Multi-location restaurants** — keep one Railway service per location
  for now. Later ticket if a chain needs proper grouping.

---

*Phase 3 of SEPOS-029 — see ../../../SEPOS-029-client-onboarding.md for the
full ticket.*
