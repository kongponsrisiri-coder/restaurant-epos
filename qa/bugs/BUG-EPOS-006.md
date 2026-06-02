## BUG-EPOS-006: Discount type picker always selects 'fixed £' in Electron
**Date:** 2026-06-03
**Project:** Restaurant EPOS
**Severity:** Medium
**Status:** Open
**Assigned To:** Krit
**Area:** OrderScreen — Discounts

**Steps to reproduce:**
1. Open SiamEPOS on the Mac desktop app (Electron)
2. Open an active order
3. Tap the Discount button
4. Try to apply a **percentage (%)** discount

**Expected:** A dialog appears asking "percentage or fixed amount?" — user picks percentage and a % discount is applied.

**Actual:** No dialog appears. The app silently always applies a **fixed £ amount** discount regardless of what the waiter intended. A waiter trying to give 10% off will always get a £10 fixed discount instead.

**Root Cause:**
```js
const type = window.confirm('OK = percentage %\nCancel = fixed £ amount') ? 'percent' : 'fixed'
```
`window.confirm()` always returns `false` in Electron 22+, so `type` is always `'fixed'`. The action still proceeds (unlike BUG-EPOS-004 where it cancels) — it just always picks the wrong type.

This is particularly dangerous because:
- The waiter doesn't see any error
- The discount IS applied — just as the wrong type
- On a large bill, a fixed £10 discount instead of 10% off £200 = staff giving the wrong amount back

**File to look at:**
- `src/components/OrderScreen.jsx` (lines ~367 and ~1042)

**Suggested fix:**
Replace with a two-button React modal: one button for "Percentage %" and one for "Fixed £". This is part of the same `window.confirm()` sweep needed for BUG-EPOS-004.
