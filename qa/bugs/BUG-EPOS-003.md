## BUG-EPOS-003: Smoke test script uses wrong field name for reservations (test script bug)

**Date:** 2026-06-02
**Project:** Restaurant EPOS
**Severity:** Low (test script issue, not product bug)
**Status:** Open (test script needs fix)
**Assigned To:** Nook (test script fix)
**Area:** Reservations / Test Scripts

**Steps to reproduce:**
1. Run `test-epos-smoke.js`
2. Section 8 — POST /api/reservations → 400 "Guest name is required"

**Expected:** 201 Created
**Actual:** 400 — Guest name is required

**Root cause:**
The smoke test sends `guest_name` but the API expects `customer_name`.

Test script (line ~281):
```js
{ guest_name: '__SmokeTest Guest', ... }
```

API validation (server.js line ~2480):
```js
const { customer_name, ... } = req.body;
if (!customer_name?.trim()) return res.status(400).json({ error: 'Guest name is required' });
```

**This is NOT a product bug** — the API is correct. The smoke test script needs updating.

**Fix:**
In `test-epos-smoke.js`, change `guest_name` → `customer_name` on all reservation POST payloads.
