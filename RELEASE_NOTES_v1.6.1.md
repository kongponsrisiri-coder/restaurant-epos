# SiamEPOS Pro — v1.6.0

**For:** SiamEPOS team (sales, support, ops, dev) + restaurant operators
**Date:** 27 May 2026
**Previous release:** v1.5.2 (11 May)
**Installs auto-update on next restart.** First-time installs still need a manual download from the GitHub Release.

---

## TL;DR

Two real new features — **gift voucher selling** (online widget + at-till) and **kitchen batch prep with expiry tracking** (Thai-kitchen pastes / stocks / sauces) — plus a class of latent UI crashes that have been quietly biting multi-tenant installs got swept up. If you only read one section, read **Operator action required** below — the new schemas need a Railway backend redeploy on Pro/Lite installs.

---

## What's new

### 🎁 Gift voucher selling — **SEPOS-VOUCHER-001**

Restaurants can now sell gift vouchers online (public website widget) AND at the till (admin → 🎁 Vouchers tab). Customers redeem at checkout. Full accounting through Trading + Reports + Z-Report.

**Policy (defaults):**
- £10 minimum, £500 maximum, 24-month expiry, no refunds

**Three flows:**
1. **Online sale via embed widget** — drop `<script src="https://[your-site]/voucher-widget.js"></script>` + `<div id="siamepos-voucher"></div>` into a restaurant's site, customer picks amount + recipient details + pays via Stripe (or mock-pay fallback if Stripe creds aren't set). Branded navy/gold gift email fires to recipient with the `GIFT-XXXXXXXX` code.
2. **At-till sale (operator)** — admin → 🎁 Vouchers → "+ Sell voucher" → amount + recipient + Cash/Card. Operator takes payment at till like any sale; code reveal screen lets them read aloud or write on a printed gift card if no email.
3. **Redemption at checkout** — BillScreen → 💳 Take Payment → 🎁 Voucher → enter code → live balance preview → **full** (closes bill as `method='voucher'`) or **partial** (applies balance as discount, customer pays remainder with Cash/Card).

**Reporting:**
- Trading Summary + Reports both show a cream "🎁 Gift Vouchers" block with `Sold total`, `via till`, `online (Stripe)`, `Redeemed` breakdown
- Z-Report shows "Gift vouchers — settled to Stripe, not the till" block so owners don't double-count Stripe revenue against till cash
- Reports CSV export appends the voucher activity for the period
- Standalone Vouchers tab is the source of truth for individual vouchers (status, expiry, redemption history, manual void, resend email)

**Atomic safety:** redemption uses `FOR UPDATE` locking so two terminals can't double-spend the same voucher.

---

### 🥣 Kitchen batch prep + expiry — **SEPOS-BATCH-001**

Thai-kitchen-focused inventory addition. Chef defines batch recipes (curry pastes, stocks, sauces, marinated meats), system tracks physical batches with shelf-life expiry + locked cost-per-unit, and menu recipes consume the batch like any other ingredient.

**Where it lives:** admin → 🥬 Inventory → 🥣 **Batches** tab (new, between Recipes and Stock Log).

**How it works:**
1. **Define a batch recipe** — "Red Curry Paste", output 2 kg, shelf life 5 days, ingredient lines (red chilli, garlic, shrimp paste, lemongrass, etc.). Saving auto-creates a matching ingredient row tagged `is_batch=true`.
2. **Make a batch** — tap "🥣 Make" on the recipe. System atomically: deducts every raw ingredient from stock, writes a `batch_prep` stock movement per line, computes total cost from current ingredient prices, locks it (so paste cost stays stable when chilli prices move next week), adds output to batch-ingredient stock, snaps `cost_per_unit`, inserts a batches row with `expires_on = today + shelf_life_days`.
3. **Use in menu recipes** — the batch shows up in the ingredient picker with a 🥣 prefix (admin → Inventory → 📋 Recipes & Costs). Cost flows through to dish cost-per-portion.
4. **Sell dishes** — existing stock depletion deducts the batch ingredient just like raws.
5. **Expiry tick-off** — batches auto-flip `active → expired` on read after `expires_on`. Expired rows go RED in the Batches tab with two tick-off actions:
   - **🗑 Discard** — prompts "how much was left?" (defaults to original quantity) + optional reason. Subtracts from stock + writes a `waste` stock movement with `cost_at_time = locked cost`, so the **wastage report sees the cost loss**.
   - **✓ Still good (+1 day)** — chef's judgement override. Bumps `expires_on` by 1 day, flips back to active. Capped at 3 extensions to prevent indefinite deferral.

**Why locked cost matters:** the price of red chilli might go up next week, but the curry sold on Monday should still be costed against the price Monday's paste was actually made with. Each batch carries its own immutable cost-per-unit.

**v1 known limitation:** total stock tracked at the ingredient level — no per-batch FIFO at sale time. Batches table is parallel tracking for expiry + discard management. Strict per-batch FIFO accounting is a v2 only if a restaurant specifically needs it.

---

### 🌿 Allergen chips — confirmed-only

The red allergen chips on Order screen menu buttons used to fall back to raw AI-scanner output when no manual confirmation existed — meaning unreviewed AI guesses were shown to waiters as authoritative. **Now the chips render ONLY from the Allergen Matrix (confirmed source of truth).**

AI-scanned values stay visible in the matrix tagged `🤖 AI scan` with blue ticks. Operator either bulk-promotes via "🤖 Confirm AI Allergens (N)" button (existing) or taps individual cells to confirm.

**One-time action after upgrading:** each restaurant with existing AI-scanned dishes should open admin → 🌿 Allergen Menu → click "🤖 Confirm AI Allergens" once to lock in current suggestions. Otherwise chips will temporarily disappear on the order screen until reviewed. (This is the safety behaviour we want for new scans; just feels regressive for already-trusted data.)

**Why this matters:** UK Natasha's Law (2021) — a wrong allergen chip is a real liability. The matrix is now the only legitimate source for what waiters see.

---

## Bug fixes

### TableMapScreen blank-page crash
Tapping an online/takeaway order on the floor map was blanking the entire page. Root cause: `.toFixed(2)` called on `tableActionPopup.order.total`, which is a string from PostgreSQL `NUMERIC`. TypeError unmounted TableMapScreen. Fixed in commit `b395dd9`. Same class of bug as the admin "flash then blank" symptom from earlier this week.

### Admin `.toFixed`-on-PG-string audit
Audited every admin section + inventory tab. Wrapped 25+ unsafe `.toFixed` call sites in `Number()` across `ReportsSection`, `BillsSection`, `ZReportSection`, `CostSalesTab`, `MenuSection`, `OrderScreen`, `TradingSection` (already fixed earlier). PostgreSQL returns `SUM/AVG NUMERIC` as a string via the `pg` driver; any naked `.toFixed` on it raised TypeError. These were latent bugs that only surfaced once a tenant's first SUM became non-zero — which is what hit Baan Siam two days ago.

### Bill endpoint 404 when order missing
`GET /api/orders/:id/bill` used to return `200 {order:{items:[]}, settings:...}` if the order didn't exist (spread of undefined). Frontend's `bill?.order` guard passed because `{items:[]}` is truthy, so the bill panel rendered blank. Now returns `404 {error:'Order not found'}` and the frontend's existing `.catch` surfaces the error.

### Scanner: AI-scanned allergens now persist
The AI menu scanner extracted allergens correctly (chips visible on the scanner preview) but tapping **+** to add the dish dropped the allergens — `POST /api/menu/items` ignored the field server-side AND `handleAddItem` didn't send it. Both fixed. New scans now land with allergens stored; matrix shows them as 🤖 AI scan ready for one-tap promotion.

### Active-order pull skip on pending sync_queue
Pre-existing belt-and-braces from PRO-002 reinforced — Mac is authoritative for rows with unfinished push entries, preventing the rollback-flash bug from edge cases.

---

## Operator action required

### Pro installs (cloud database — Railway)
1. **Redeploy Railway backend** so the new schemas migrate on boot:
   - `vouchers`, `voucher_redemptions` (already shipped 25 May — may already be live)
   - `batch_recipes`, `batch_recipe_lines`, `batches`
   - `ingredients.is_batch`, `ingredients.batch_recipe_id`
2. **Allergen Matrix:** open admin → 🌿 Allergen Menu → click "🤖 Confirm AI Allergens" to lock in any existing AI-scanned suggestions (one-time per restaurant).
3. **Vouchers via Stripe** (optional): set `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` on Railway. Without them, the widget still works but uses mock-pay (voucher tagged `payment_method='mock'`, excluded from Z-Report's Stripe revenue line).
4. **Drag-and-drop redeploy** any client mockup sites (siamepos.net etc.) to pick up the `voucher-widget.js` embed if those sites carry it. The widget itself auto-serves from the backend — only the embed `<script>` tag on the marketing site needs the redeploy.

### Mac local installs (DB_MODE=local, SQLite)
- **Vouchers schema is in SQLite migrations** — auto-creates on next launch.
- **Batches schema is NOT in SQLite** — Pro plan runs cloud-direct for inventory, so batch tables only exist in PG. Mac installs running `DB_MODE=local` won't see Batches tab data until v2 adds local schema. If a customer specifically asks, switch them to `DB_MODE=cloud` for now.

### Lite installs
- Vouchers tab is open to all plans (Lite restaurants can sell vouchers as well).
- Batches tab follows Inventory plan gate — Pro only.

---

## Compatibility

- **No breaking changes.** All existing menu items, orders, bills, customers, reservations, takeaway flows untouched.
- **Auto-update** lands on the next desktop restart for any Mac/Windows install already on v1.5.x with the publish config. First-time installs need a manual download.
- **PWA cache** bumped v4 → v5 in the web build so iPads flush cleanly.
- **Database migrations** are additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — safe to re-run.

---

## Tickets shipped in this release

- SEPOS-VOUCHER-001 — Gift voucher selling (monetary v1) + at-till sell flow + Trading/Reports visibility
- SEPOS-BATCH-001 — Kitchen batch prep + expiry with chef tick-off
- ALLERGEN-CONFIRMED-ONLY — Order screen chips now confirmed-only
- TABLEMAP-BLANK-FIX — `.toFixed`-on-string crash on takeaway tap-popup
- ADMIN-TOFIXED-AUDIT — 8 admin sections + OrderScreen wrapped in `Number()`
- BILL-404 — Bill endpoint returns proper 404 instead of blank panel
- Scanner allergen persistence fix (server `POST /api/menu/items` + handleAddItem)

Full commit log: `git log v1.5.2..v1.6.0`.

---

*🤖 Generated alongside the v1.6.0 build by Krit.*
