## BUG-EPOS-004: `window.confirm()` silently fails throughout app in Electron
**Date:** 2026-06-03
**Project:** Restaurant EPOS
**Severity:** High
**Status:** Open
**Assigned To:** Krit
**Area:** Whole App (Desktop / Electron)

**Steps to reproduce:**
1. Open SiamEPOS on the Mac desktop app (Electron)
2. Try any action that triggers a confirmation dialog, e.g.:
   - Remove a voucher from a bill
   - Mark an order as collected
   - Close a table at £0
   - Seat a customer / mark as no-show / cancel a booking
   - Void a voucher
   - Delete a menu item

**Expected:** A confirmation dialog appears asking the user to confirm or cancel the action.

**Actual:** Nothing happens. The action silently does nothing. No dialog, no error, no feedback.

**Root Cause:**
`window.confirm()` is disabled in Electron 22+. It always returns `false` immediately without showing any dialog. Because most confirmation flows treat `false` as "user cancelled", the action is silently aborted.

**Files affected:**
- `src/components/OrderScreen.jsx`
- `src/components/BillScreen.jsx`
- `src/components/KitchenScreen.jsx`
- `src/components/ReservationsScreen.jsx`
- `src/components/ReservationPlanView.jsx`
- `src/components/ZReportSection.jsx`
- `src/components/MenuSection.jsx`
- `src/components/VouchersSection.jsx`
- `src/components/TablePlanSection.jsx`
- `src/components/CampaignsSection.jsx`
- `src/components/AllergenSection.jsx`
- `src/components/BatchesTab.jsx`
- `src/components/SettingsSection.jsx`
- `src/components/CustomersSection.jsx`

**Suggested fix:**
Replace ALL `window.confirm()` calls with a shared React confirmation modal component (e.g. `<ConfirmModal>`). A pattern already exists in the codebase for the manager PIN modal — follow the same approach. The modal should accept `message`, `onConfirm`, and `onCancel` props.
