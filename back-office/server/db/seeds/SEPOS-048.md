# TICKET: SEPOS-048
## Incremental sync (cut Railway egress 80%+)

```
Priority: TRIGGERED-AT-10-RESTAURANTS
Status:   OPEN
Blocks:   scaling past 10 Pro-plan desktop installs without egress costs
          becoming material
Affects:  syncService pullFromCloud + pullActiveOrders, cloud endpoints
```

---

## Goal

`pullFromCloud` and `pullActiveOrders` refetch the full snapshots every 5
seconds. At 12-tick/min × ~50KB per pull × 10 restaurants × 24/7 ≈
**30–50 GB/month per Mac install** of Railway egress. That's fine today
(we have 2 installs) but stops being affordable around 10 active Pro-plan
installs.

Replace the full-snapshot pull with an incremental `updated_at`-driven
pull. Each tick only fetches rows that changed since the last successful
pull.

---

## What changes

### Cloud endpoints

- `GET /api/sync/pull-tables?since=<iso-timestamp>` — returns only rows
  with `updated_at > since` for each of: menu_items, categories,
  subcategories, modifier_groups, modifiers, tables, walls, combinations,
  tiers, reservations, settings, staff
- `GET /api/sync/active-orders` already paginated by `closed_at` — needs
  an equivalent `?since=` filter for the in-flight rows
- All these endpoints need an `updated_at` column on every pulled table
  (most already have one — audit)

### Mac side

- `syncService` keeps a per-table cursor in `sync_state` (key/value)
  with the last successful `updated_at` it saw
- On each tick, request only rows newer than that cursor
- Persist the new high-water-mark after a successful upsert pass
- First-launch / blank install: cursor empty → fetches everything (current
  behaviour)

### Deletes

- The current pull just upserts — deleted-on-cloud rows would never get
  removed locally. Add a soft-delete column `deleted_at` to every synced
  table, OR a separate `GET /api/sync/deletions?since=<iso>` feed.
- Soft-delete is simpler; the EPOS code already filters most lists by
  `is_available=1` / `status != 'cancelled'` so adding `WHERE deleted_at IS NULL`
  is a small touch.

---

## Acceptance criteria

- [ ] Every synced cloud table has `updated_at` (audit + add where missing)
- [ ] `sync_state` table records the per-table cursor on the Mac
- [ ] New incremental endpoint(s) deployed on cloud
- [ ] `pullFromCloud` and `pullActiveOrders` switched to incremental
- [ ] Deletions propagate (soft-delete column + WHERE filter)
- [ ] Egress drops dramatically — verify on Railway metrics for a week

---

## Risks

- Clock skew between Mac and cloud could leave a tiny window of missed rows.
  Add a small "lookback buffer" — fetch rows newer than `cursor - 30s`
  rather than strict `> cursor`. Duplicates are harmless (upsert).
- Anything we add to the synced schema later must include `updated_at`
  triggered on every UPDATE. Add a trigger or enforce via app code.

---

## When to actually build this

Per CLAUDE.md: "Trigger to build proper `updated_at`-driven incremental
pulls is hitting ~10 restaurants on the Pro plan; below that, the cost
is comfortable." Watch Railway egress monthly.

---

*Tracked from CLAUDE.md "Known limitations / future tickets" as of May 2026.*
