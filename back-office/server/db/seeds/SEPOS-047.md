# TICKET: SEPOS-047
## Mac-created reservations push to cloud

```
Priority: LOW
Status:   OPEN
Blocks:   restaurants who take walk-in / phone bookings primarily on the
          Mac desktop terminal but also want to see them on Chrome / iPad
Affects:  syncService push, server-side /api/sync/reservation endpoint
```

---

## Goal

Today the desktop's sync engine pulls reservations cloud → local every 5s
(SEPOS-PRO-001) but doesn't push the other way. A walk-in seated on the
Mac, or a phone booking taken at the Mac terminal, only exists locally.
It doesn't appear on the iPad floor map, the Chrome admin reports, or the
back-office customer CRM.

This is fine for some restaurants (one Mac terminal does everything) but
breaks the multi-device pattern.

---

## What to build

1. New `syncService` push action: `upsert_reservation`
   - Captured on every local INSERT / UPDATE on the `reservations` table
   - Cloud_id mapping the same as orders (SEPOS-PRO-002 pattern):
     `reservations.cloud_id INTEGER UNIQUE` on the SQLite mirror
2. New cloud endpoint `POST /api/sync/upsert-reservation`
   - SYNC_SECRET-gated (same as the other sync endpoints)
   - Accepts the full reservation payload, returns the cloud_id
3. Updated push handler in `syncService.applyToCloud` that sends the
   reservation row when the action is `upsert_reservation`
4. Idempotency — if a reservation already has a cloud_id, PUT the cloud
   row instead of POSTing a new one

---

## Acceptance criteria

- [ ] Add `cloud_id` to local SQLite `reservations` schema + an
      `addColumnIfMissing` migration
- [ ] Wrap every PG/SQLite reservations INSERT and UPDATE in routes that
      run on the Mac with an `offlineQueue.enqueue('upsert_reservation', ...)`
- [ ] Cloud endpoint mirrors the row; on first push it INSERTs and returns
      the new cloud_id, which the Mac stamps onto the local row
- [ ] Pull from cloud uses `cloud_id` as the match key (not local id) so
      we don't fight the existing pull's overwrites
- [ ] Status changes on Mac (e.g. mark a walk-in completed manually) push
      through too

---

## Notes / risks

- The existing pull is "cloud wins for matched rows, Mac wins for pending
  push" — same pattern as orders (SEPOS-PRO-002). Re-use the same
  `cloudIdsWithPendingPush` guard.
- This must NOT push reservations created via the cloud's booking widget
  (which already live on the cloud) — easy: those have cloud_id set on
  pull, so they're never enqueued for push.

---

*Tracked from CLAUDE.md "Known limitations / future tickets" as of May 2026.*
