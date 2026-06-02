## BUG-EPOS-005: `/api/reports/daily` excludes service charge from totals
**Date:** 2026-06-03
**Project:** Restaurant EPOS
**Severity:** Medium
**Status:** Open
**Assigned To:** Krit
**Area:** Reports — Daily View

**Steps to reproduce:**
1. Place several dine-in orders with 12.5% service charge applied
2. Navigate to Reports → Daily view in the EPOS
3. Compare the Daily total against the Z-Report or Summary total for the same day

**Expected:** Daily report total matches Z-Report and Summary — i.e. includes service charge in the total revenue figure.

**Actual:** Daily report total is lower than Z-Report / Summary by ~11%. It uses `orders.total` (subtotal before service charge) instead of the actual amount paid.

**Root Cause:**
The `/api/reports/daily` endpoint was not updated when the service-charge fix was applied to `/api/reports/summary` and `/api/z-report/preview`. It still:
1. SELECTs `orders.total` only — no JOIN to `payments` for `paid_amount`
2. Reduces with `(sum, r) => sum + (r.total || 0)` — uses subtotal
3. Passes these rows to `splitByOrderType()` which also falls back to `r.total`

**File to look at:**
- `src/server.js` — `/api/reports/daily` handler (approx. line 1438–1443)

**Suggested fix:**
Add a LEFT JOIN to `payments` and select `payments.amount AS paid_amount` in the daily query. Switch the total reduction to `paid_amount ?? total` (so it gracefully falls back if no payment row exists). Mirror the fix already applied to `/api/reports/summary`.
