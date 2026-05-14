# TICKET: SEPOS-046
## Orders → reservations linkage (accurate per-customer revenue)

```
Priority: MEDIUM
Status:   OPEN
Blocks:   accurate Customer total_spend in CRM, repeat-visit revenue analysis
Affects:  orders schema, /api/customers endpoint, ReservationPlanView, BookingPanel,
          OrderScreen seat flow, Mac sync (orders + reservations both)
```

---

## Goal

Today `orders` has no `reservation_id` column. The Customer CRM in admin
(SEPOS-033) shows total spend, which is computed by a heuristic:
*"orders on the same table_id + the same date as the booking"*. That mostly
works but fails for:

- Walk-ins (no booking at all → spend doesn't attribute to anyone)
- Table moves (order's table_id changes mid-service → join breaks)
- Linked-table parties where the order is on a different physical table than the booking

Add a real FK so total_spend is dead accurate.

---

## Schema change

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_id INT REFERENCES reservations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_reservation ON orders (reservation_id) WHERE reservation_id IS NOT NULL;
```

Same migration mirrored on `localDatabase.js` SQLite schema for desktop.

---

## Where to set reservation_id

| Flow | Where |
|---|---|
| Walk-in via tap-to-seat (SEPOS-044) | `/api/reservations/walk-in` already inserts both rows — set `orders.reservation_id` to the new reservation in the same transaction |
| Booking seated via tap-to-seat | `/api/reservations/:id/seat` already opens the order when `open_order=true` — pass the reservation id in alongside |
| Pre-existing seated booking → order opened on the table | Trickier — the order is opened from TableMapScreen with no booking context. Look up the seated reservation on the same table at create-order time and stamp the FK |
| Manual order create (no booking) | `reservation_id` stays NULL — fine, no CRM contribution |

---

## Acceptance criteria

- [ ] Schema migration on both PG + SQLite
- [ ] Walk-in flow stamps `reservation_id` on the order
- [ ] Booking-seat flow stamps `reservation_id` on the order
- [ ] Regular table-map "tap empty table → open order" flow looks up the
      seated reservation on that table (if any) and stamps it too
- [ ] `/api/customers` total_spend re-computed via the FK join instead of
      the table_id + date heuristic. Add a fallback so existing closed
      orders without `reservation_id` still attribute via the old logic.
- [ ] Mac sync: include `reservation_id` in the active-orders + closed-orders
      pull payloads + the create_order push action

---

## Notes

- This unblocks a much better CRM — we can compute "this customer's average
  cover spend", "their favourite dish", "how often they reorder", etc.
- After this lands, the booking widget can show "Welcome back, Sarah —
  your last visit was 2 weeks ago" on returning customers.

---

*Tracked from CLAUDE.md "Known limitations / future tickets" as of May 2026.*
