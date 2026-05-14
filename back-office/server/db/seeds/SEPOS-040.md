# TICKET: SEPOS-040
## Real Stripe Connect payments on online takeaway

```
Priority: HIGH
Status:   OPEN
Blocks:   onboarding restaurants that want online takeaway revenue
Affects:  takeaway widget, tenant Railway env, back-office Setup tab
```

---

## Goal

Replace the mock-payment placeholder in the online takeaway widget with real Stripe Connect, so orders placed at `{slug}.siamepos.co.uk/takeaway-widget.js` actually charge a card and credit the restaurant's Stripe account (not SiamEPOS's).

SiamEPOS never holds funds — every restaurant has their own Stripe Connect account; we collect a platform fee on top.

---

## What's already in place

Schema + plumbing prepped during SEPOS-034:

- `orders.payment_status` flips `mock → pending → paid` (currently only ever sees `mock`)
- `orders.payment_intent_id` column ready to store the Stripe ref
- Takeaway widget has a "mock pay" step — the only UI piece that needs replacement
- Back-office **🔐 Setup → Online takeaway / payments** already captures:
  - Stripe Connect account ID (`acct_…`)
  - Live publishable key
  - Live secret key

The data is all ready — only the widget + a new backend endpoint are missing.

---

## Acceptance criteria

- [ ] Tenant's Railway env: `STRIPE_PK_LIVE`, `STRIPE_SK_LIVE`, `STRIPE_CONNECT_ACCOUNT_ID`
- [ ] New endpoint `POST /api/takeaway/orders/:id/create-payment-intent`
      returns `{ client_secret }` from Stripe with `application_fee_amount` set
      and `transfer_data.destination` = tenant's Connect account ID
- [ ] Widget step 4 (mock pay) replaced with Stripe Elements card form
- [ ] On `payment_intent.succeeded` webhook, `orders.payment_status='paid'`
      and `orders.payment_intent_id` saved
- [ ] Failed payments don't create an order (or void the order on failure)
- [ ] Receipt shows last-4 card digits + Stripe ref

## Phase 2 (after MVP)

- [ ] Self-service Stripe Connect onboarding from the back-office Setup tab —
      operator pastes restaurant's email, back-office calls Stripe Connect
      Standard onboarding API, restaurant receives an email with the link.
      Currently we ask the operator to do this in the Stripe dashboard.

---

## Notes / gotchas

- **Connect Standard vs Express vs Custom** — go with Standard. Restaurant
  has their own Stripe dashboard, KYC handled by Stripe, payouts to their
  bank. We just take a platform fee.
- **Platform fee** — TBD with Korakot. Most card processors charge ~1.4%–2.9%;
  SiamEPOS could add a small flat percentage on top of Stripe's cut.
- **VAT on the platform fee** — UK SiamEPOS Ltd will need to add VAT to its
  fee invoice if turnover > £85k.
- **PCI compliance** — Stripe Elements handles this. As long as we don't
  proxy raw card details through our backend, we stay SAQ-A.

---

## Files to touch

- `public/takeaway-widget.js` (or `client/src/screens/admin/...` if rewritten in React)
- `src/server.js` — new endpoint + Stripe webhook handler
- `package.json` — `stripe` SDK dep
- `back-office/server/routes/clients.js` — Phase 2 Stripe Connect onboarding endpoint

---

*Tracked from CLAUDE.md "Known limitations / future tickets" as of May 2026.*
