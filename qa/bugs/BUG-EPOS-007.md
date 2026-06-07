BUG-EPOS-007: Customer "Anything we should know?" note (allergy info) never shows on the Kitchen SCREEN — print-only

Date: 2026-06-07
Project: Restaurant EPOS
Severity: High (food-safety relevant)
Status: Verified + Deployed in v1.6.37
Assigned To: Nook (found + fixed) → Krit (verified + shipped 2026-06-07)
Area: KDS / Kitchen screen, online takeaway, allergens

## Summary
v1.6.34 added the order-level customer note ("no peanut", "extra spicy",
"allergic to shellfish") from the takeaway widget's "Anything we should
know?" textarea. It was wired to the **printed** kitchen ticket
(`printService.buildFullKitchenTicket` + `KitchenTicket.js` popup) but
NEVER to the on-screen KDS (`KitchenScreen.jsx`).

Result: any restaurant running screen-only — no kitchen printer, or
Kitchen Direct Mode, or printer offline — never sees the customer's
allergy note. The chef reads per-item notes (📝) on screen but the
order-level allergy warning is invisible. This is why it looked like
"no bug": the print path works, so it was only missing on the path a
lot of small restaurants actually use.

## Steps to reproduce
1. Place an online takeaway order via the widget.
2. In "Anything we should know?" type "ALLERGIC TO SHELLFISH".
3. Kitchen device set to KDS / no kitchen printer configured (or Kitchen
   Direct Mode).
4. Open the Kitchen screen.

Expected: the allergy note is clearly visible on the order card.
Actual: nothing — the note only exists on a printed ticket that never
prints in a screen-only setup.

## Root cause
`KitchenScreen.jsx` renders `item.item_note` (per-item) in three places
but has zero references to the order-level `order.customer_note`. The
data was already present on the order object (`GET /api/orders` does
`SELECT orders.*`, which includes `customer_note`) — the screen simply
never displayed it.

## Fix (applied)
File: client/src/screens/KitchenScreen.jsx
Added an always-visible amber "⚠️ Note:" strip directly under the card
header, right after the existing delivery-address strip, shown whenever
`order.customer_note || order.notes` is present. Mirrors how the
delivery address is surfaced so it can't wrap out of view. Client-only
change — no schema or API change needed (data already flows).

JSX validated with @babel/parser (parses clean).

## Follow-ups / not in this fix
- Pass tab card: currently only the main cooking card shows the note.
  Cooking is the safety-critical moment so this is covered; consider
  echoing it on the Pass card for plating double-check.
- KitchenScreen line 38-39 hardcodes `timeZone: 'Europe/London'` for
  pickup-time display — fine for UK, wrong for the future Bangkok tenant
  SEPOS-048 is preparing for. Logged here, not fixed (out of scope).
