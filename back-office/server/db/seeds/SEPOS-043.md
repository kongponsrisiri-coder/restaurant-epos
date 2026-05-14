# TICKET: SEPOS-043
## Role-based access hierarchy

```
Priority: MEDIUM
Status:   OPEN
Blocks:   restaurants that want to give junior staff EPOS access without
          letting them touch closed bills or admin
Affects:  Admin route guard, BillsSection, DELETE /api/orders, sync delete-order
```

---

## Goal

Today every staff PIN that reaches Admin can do everything. The manager-PIN
gate on order delete (SEPOS-042) only checks the role is one of
`admin / manager / supervisor` — but a supervisor can still delete a
closed bill, and a waiter can still reach the Admin tab from the login UX.

Restaurants want clearer privilege tiers.

---

## Target hierarchy

| Role | Admin access | Delete closed bill | Delete open order |
|---|---|---|---|
| `admin`      | ✅ full     | ✅ | ✅ |
| `manager`    | ✅ full     | ✅ | ✅ |
| `supervisor` | ✅ full     | ❌ | ✅ |
| `waiter`     | ❌          | ❌ | ❌ |
| `kitchen`    | ❌          | ❌ | ❌ |
| `bar`        | ❌          | ❌ | ❌ |

Supervisor can still do everything else admins can (table plan edits,
menu edits, reports, etc.) — they just can't nuke a paid bill.

---

## Acceptance criteria

### Frontend

- [ ] Route guard on AdminScreen — `staff.role` must be one of
      `admin/manager/supervisor`, otherwise redirect to TableMapScreen
      with a toast "Admin access requires a manager PIN"
- [ ] BillsSection — hide the 🗑️ delete button when
      `staff.role === 'supervisor'`
- [ ] Login flow — same role gate already filters which routes appear in
      the nav; double-check waiter/kitchen/bar can't deep-link to /admin

### Backend

- [ ] `DELETE /api/orders/:id` — when the order's `status='closed'`,
      reject if the supplied manager PIN belongs to a `supervisor` (keep
      `admin / manager` allowed). Currently it lets all three through.
- [ ] `POST /api/sync/delete-order` — same role check, so a Mac-pushed
      supervisor delete of a closed bill bounces back too.
- [ ] Both endpoints return a clear error message + suggested action
      ("Only managers can delete a closed bill — ask a manager to do it.")

---

## Notes

- The role values are already on `staff.role` and stable — no schema migration
- The desktop banner introduced in SEPOS-044 will surface any failed sync
  deletes so a misbehaving Mac can't silently retry forever
- A few existing screens implicitly rely on "admin reached this page = full
  trust" — check ReportsSection, ZReportSection, ClockRecordsSection. Should
  still work for supervisor (no destructive admin-only ops in those)

---

*Tracked from CLAUDE.md "Known limitations / future tickets" as of May 2026.*
