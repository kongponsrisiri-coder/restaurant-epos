# SEPOS-LITE-001 — SiamEPOS Lite: Design Proposal

**Author:** Krit  ·  **Date:** 2026-05-17  ·  **Status:** Draft for Korakot review — no code yet

---

## 1. Goal
SiamEPOS **Lite** is a low-cost product for restaurants that already run another
EPOS for dine-in but want SiamEPOS's online **booking** + online **ordering**.
They get the widgets, the kitchen-facing pipeline for online orders, and a
simple dashboard — without the full dine-in EPOS.

## 2. Product scope

**Lite includes:**
- Booking widget + Takeaway/Delivery widget (embedded on the restaurant's own site)
- Menu management (the widgets need a menu)
- **KDS** — the Kitchen screen, online orders only (takeaway/delivery)
- **Kitchen printing for online orders** — see §7; needs a print bridge because
  the Lite backend is in the cloud
- Customer CRM — their own customers
- Basic settings (name, address, phone, logo, opening hours, service charge, delivery radius)
- Copy-paste widget embed codes

**Lite excludes (Pro-only):**
- Table plan / floor map
- Dine-in order screen + bill / payment
- Staff PINs & management, clock-in/out
- Inventory, invoice scanner, Z-report, full reports
- The Electron desktop app + offline sync — **Lite is cloud-only**. They already
  have a till; there is no need for an offline-capable local server.

## 3. Plan tiers
A `plan` field on the restaurant record:

| plan | Unlocks |
|------|---------|
| `lite_booking` | Booking widget + reservations dashboard |
| `lite_ordering` | Takeaway/Delivery widget + KDS + kitchen printer |
| `lite_bundle` | Both of the above |
| `pro` | Everything (the current full product) |

Feature gating reads `plan` and hides / blocks Pro-only routes + UI.

## 4. Architecture — multi-tenancy (the key decision)
Today SiamEPOS is **single-tenant**: one restaurant per deployment, per database
(each Pro client gets their own Railway Postgres). Lite cannot justify a
dedicated backend + DB per customer at a low price point.

**Proposal: one shared multi-tenant "Lite" backend + database.** Every
tenant-scoped row carries `restaurant_id`; every query filters on it.

Two deployment modes, **same codebase**, switched by an env flag (e.g. `MULTI_TENANT=1`):
- **Pro (single-tenant):** unchanged. `restaurant_id` is fixed from env; queries
  still filter by it but it is always one value — effectively a no-op. Own DB,
  Electron, offline sync exactly as today.
- **Lite (multi-tenant):** one shared backend serves many restaurants;
  `restaurant_id` is resolved per request.

Because of this, the schema retrofit below is **safe for Pro** — it is additive
and Pro behaviour does not change.

## 5. Database schema changes
Tables that **already** carry `restaurant_id`: `reservations`,
`restaurant_settings`, `table_combinations`, `table_walls`,
`dining_duration_tiers`. Multi-tenancy was anticipated — this continues it.

**5a. New `restaurants` registry table** — the tenant list:
`restaurant_id` (PK, slug), `name`, `plan`, `api_key` (widget + dashboard auth),
`status` (active / suspended), `stripe_customer_id`, `stripe_subscription_id`,
`created_at`.

**5b. Add `restaurant_id` to every tenant-scoped table that lacks it:**
`orders`, `order_items`, `payments`, `menu_items`, `categories`,
`subcategories`, `modifier_groups`, `modifiers`, `order_item_modifiers`,
`staff`, `tables`, `settings`, `campaigns`, `clock_events`, `discount_reasons`,
`z_reports`, `order_deletions`, `webhook_fires`, `reservation_reminders`.
- Default `'siamepos'` so existing Pro data is untouched.
- Composite index on `(restaurant_id, …)` where query volume matters.

**5c. Scoped-query discipline.** A shared DB means one query that forgets the
`restaurant_id` filter leaks one restaurant's data to another. Mitigation: a
single `tenantQuery(restaurantId, sql, params)` helper used for all
tenant-scoped reads/writes, so the filter cannot be forgotten. Review rule: no
raw `pool.query` on tenant tables in multi-tenant code paths.

## 6. Tenant resolution — how a request knows which restaurant
- **Widgets (public):** the embed code carries `restaurant_id`. The **booking
  widget already does this**; the **takeaway widget must be updated to pass
  `restaurant_id`** (it currently does not — built single-tenant).
- **Lite dashboard + KDS (authenticated):** each restaurant gets login
  credentials; the session token carries `restaurant_id`; middleware injects it
  into every query.
- **Kitchen tablet:** a browser on the kitchen iPad, logged in as that
  restaurant, KDS scoped to its `restaurant_id`.

## 7. Printing for Lite — the cloud / LAN gap ⚠️
This is the one genuinely hard part of Lite, and it does **not** work the way
Pro printing works. (The new `lite.siamepos.co.uk` domain itself is *not* the
problem — the issue is network topology, explained below.)

**Why Pro printing works:** in Pro the SiamEPOS server runs *on the restaurant's
premises* (the Mac / a local server). It sits on the same LAN as the thermal
printer, so it can open a TCP socket straight to `printer_ip:9100` and send
ESC/POS — or the Electron app prints silently through the OS driver.

**Why that breaks for Lite:** Lite's backend is a **shared cloud server**
(Railway). A cloud server **cannot reach a printer at `192.168.1.100`** — that
is a private address inside the restaurant's network, with no route from the
internet. A browser also cannot open raw TCP to port 9100. So for a Lite
restaurant (cloud backend + browser + no desktop app):
- ❌ Server-side TCP printing — the cloud can't see the LAN printer
- ❌ Electron silent print — there is no desktop app
- ⚠️ Browser print dialog — works, but it is a manual tap per ticket (no auto-print)

**Recommended solution — a small "print bridge" agent.** A lightweight app the
Lite restaurant runs on any always-on device on their LAN (a cheap mini-PC, a
spare laptop, or a Raspberry Pi). It:
- makes an **outbound** connection to the cloud — outbound works even though
  inbound does not, because the restaurant's router allows it — holding a
  WebSocket / long-poll open;
- receives print jobs (kitchen tickets) from the cloud;
- sends ESC/POS to the local printer over TCP `printer_ip:9100` or USB.

It is essentially a print-only version of what the Pro Electron app's
`cloudRelay` already does — much smaller, since it only relays print jobs. The
ESC/POS is already generated server-side (`printService.js`), so the bridge can
be a dumb pipe: receive bytes → write to printer.

**Alternatives:**
- **CloudPRNT printers** (Star mC-Print, etc.) — the printer itself polls a
  cloud URL for jobs. Zero local install, but it constrains Lite customers to a
  specific (pricier) printer model — not the cheap cnfujun.
- **Browser print dialog only** — zero install, but a manual tap per kitchen
  ticket. Acceptable as a fallback or for very low-volume sites.

**DECIDED (2026-05-17, Korakot):** go with the **print bridge** as the primary
path — a small bridge install is acceptable, since the restaurant is already
set up with a kitchen tablet for the KDS. The browser print dialog stays as the
no-install fallback; CloudPRNT is a possible future option.

The bridge needs a device that can do raw TCP / USB — a mini-PC, a spare
laptop, or an Android / Windows tablet. Note that an **iPad cannot host the
bridge itself** (no raw sockets in iOS Safari), so if the kitchen KDS tablet is
an iPad, the bridge runs on a separate small co-located device. Sales framing:
Lite is "no *EPOS* install" — there is just one tiny print-bridge install for
automatic kitchen tickets.

## 8. Lite onboarding
A short flow — a subset of SEPOS-ONBOARD-001. **Recommendation: one onboarding
wizard, with a "Lite" mode** that skips the EPOS steps — do not build a second
wizard.
1. Restaurant profile — name, address, phone, logo
2. Menu upload (the AI menu-photo extractor already exists)
3. Basic settings — opening hours, service charge, delivery radius (if ordering)
4. Plan selection + Stripe checkout
5. Done → show widget embed codes (and the print-bridge download, if ordering)

## 9. Lite dashboard
The ticket says "simplified ops.siamepos.co.uk or a new page." **Important:**
ops.siamepos.co.uk is the *internal* SiamEPOS ops tool — Lite **customers must
not log into it**. Lite needs a **customer-facing dashboard** served at
`lite.siamepos.co.uk`: a new lightweight page (bookings list, orders list, KDS
link, settings, embed codes). **Recommendation:** build a new lightweight
customer area; do not expose the internal ops tool.

## 10. Widget embed codes
After setup the dashboard shows copy-paste snippets, e.g.:
`<script src="https://lite.siamepos.co.uk/widget.js" data-restaurant="<id>"></script>`
Most of this already exists — the widgets just need `restaurant_id` wired
through consistently (see §6).

## 11. Billing — SEPOS-040 dependency
Lite is a paid subscription, so recurring billing must exist **before launch**.
Note: SEPOS-040 (Stripe on the takeaway widget) is *transaction* payment, not
*subscription* billing — Lite needs **Stripe subscriptions** (a per-restaurant
recurring plan). This is a distinct piece of work, most likely a back-office
concern.

## 12. Krit / Pose split
- **Krit (customer EPOS repo):** schema retrofit (§5), the `tenantQuery` helper,
  the multi-tenant mode flag, tenant-resolution middleware, takeaway widget
  `restaurant_id`, plan-based feature gating, embed codes, **the print bridge
  agent (§7)**.
- **Pose (back-office):** Lite onboarding mode, the customer-facing Lite
  dashboard, plan management, Stripe subscription billing.
- **Shared decision:** where the Lite dashboard lives and how it authenticates.

## 13. Suggested phasing
1. **Phase 1 — Foundation:** `restaurants` table + `restaurant_id` retrofit +
   `tenantQuery` helper + multi-tenant flag. No user-visible change for Pro. *(Krit)*
2. **Phase 2 — Tenancy live:** tenant resolution, takeaway widget
   `restaurant_id`, plan gating. *(Krit)*
3. **Phase 3 — Lite UX + printing:** onboarding mode, customer dashboard *(Pose)*;
   the print bridge agent *(Krit)*.
4. **Phase 4 — Billing & launch:** Stripe subscriptions, then go live. *(Pose + Krit)*

## 14. Open questions for Korakot
1. **Hosting:** one shared Railway instance + Postgres for all Lite tenants —
   agreed? Rough scale expectation for year one (how many Lite restaurants)?
2. **Lite dashboard:** new customer-facing page at `lite.siamepos.co.uk`
   (recommended) vs simplified ops view — confirm.
3. **Plan tiers:** are the four (`lite_booking` / `lite_ordering` /
   `lite_bundle` / `pro`) right? Pricing per tier?
4. **Billing owner:** who builds Stripe subscriptions — and does it block Phase 1,
   or can the foundation work start now in parallel?
5. ✅ **RESOLVED (2026-05-17):** Printing — go with the **print bridge** (§7). A
   small bridge install is acceptable; the restaurant already has a kitchen
   tablet for the KDS.

## 15. Risks
- **Cross-tenant data leak** — the headline risk. Mitigated by the `tenantQuery`
  helper + review discipline + data-isolation tests before launch.
- **Retrofit size** — `restaurant_id` touches ~19 tables and many endpoints.
  Phase 1 is the bulk of the engineering effort.
- **Shared-backend blast radius** — one bug or outage affects every Lite
  restaurant at once (unlike Pro's isolated deployments). Needs monitoring + the
  `status` suspend flag.
- **Printing reachability** — the cloud cannot reach LAN printers (§7). The
  print bridge is the mitigation; without it, Lite ordering customers only get
  manual browser-dialog printing.
