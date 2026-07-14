# SiamEPOS — July 2026 Milestone: v1.7.0

**For:** SiamEPOS team (sales, support, ops, dev)
**Date:** 14 July 2026
**Client note:** `~/Documents/SiamEPOS-Docs/manuals/WHATS-NEW-2026-07.md` (send/quote that one to clients — this file is the team version with tickets)

---

## TL;DR

v1.7.0 is the **stability milestone**: two paying restaurants (Chart Thai + Thann Thai) have been live for weeks, and this release closes out the deep-audit hardening run plus the July feature batch. Headline: a 60-agent stability audit → **31 confirmed defects fixed and adversarially re-verified** (sync engine, pay flows, reports); timezone correctness everywhere; the Close Shift / Z hierarchy fixed per client feedback; card-machine-style amount entry; the inventory invoice loop completed; roles enforced; real Stripe on takeaway. Every deploy channel is current (Railway all tenants, app.siamepos auto, both Baan Siam sites + Thann Thai browser POS manually rolled, desktop OTA).

---

## What's new (since the June run / v1.6.12x)

### 🛡️ Stability audit batch *(SEPOS-AUDIT-001, v1.6.138)*
- 22 CONFIRMED findings from a 60-agent adversarial audit fixed, then a 5-agent
  verify pass on the fix batch itself found 9 more — all fixed. Report:
  `~/Documents/SiamEPOS-Docs/qa-reports/Stability-Audit-2026-07-14.md`.
- Sync criticals: no raw-local-id fallback (money can't land on a stranger's
  bill), a locally-paid bill can never be reopened by the pull, money/state
  actions never quarantine on 5xx (Railway redeploys are safe), head-of-line
  blocks surface as a 'stuck' status instead of eternal healthy 'syncing'.
- Vouchers + deposits are cloud-authoritative from local tills (lookup/redeem/
  sell/remove forward with id translation; offline sale replays with the same
  printed code; balances can't be double-redeemed).
- 12 previously one-way writes now push till→cloud: order/item discounts,
  service-charge + bill-printed flags, move/merge/resend, takeaway collected,
  cancel, close-zero, payment amendments (PIN-free SYNC_SECRET replay),
  till-session open/close.
- Pay flows: unsent-cart undercharge blocked, voucher/deposit tender caps,
  mixed over-tender split change-vs-tip, split-count restart, full-cover
  voucher marker.
- Reports: service charge snapshotted at close (rate changes can't rewrite
  history), Z drawer includes till voucher cash, written-off bills excluded
  everywhere, merge shells zeroed + excluded, voids windowed on voided_at.

### 🔐 Close Shift hero + 🕐 timezone *(SEPOS-ZHERO-001 + SEPOS-048, v1.6.139)*
- Clients were running the read-only Z instead of Close Shift because the Z
  button looked more important. Hierarchy flipped: brand-navy **Open a Shift**
  / green **Close Shift & Count Till** hero; Z demoted to a quiet view-only
  card; title now "Close Shift / Z Report".
- Railway's UTC clock no longer leaks into anything operator-facing: walk-in
  stamps, daily-report day boundaries (restaurant midnight→midnight, DST-safe),
  reservation past-date validation, archive CSV, printed Z headers. All read
  the tenant's `settings.timezone` (default Europe/London).

### 📦 Inventory invoice loop complete *(SEPOS-046, v1.6.140)*
- Confirming a supplier invoice updates stock + ingredient costs, writes
  delivery movements, auto-creates unmatched ingredients (all in one
  transaction — shipped in June), and now also: **recalculates recipe costs**
  when a supplier price changes, shows a **price-change alert** on the done
  screen, and serves **itemised invoice history** (from the delivery
  movements — retroactive, no new table). Nook's inventory test plan
  (`NOOK-INVENTORY-TEST-PLAN.md`) is fully unblocked.

### 💷 Penny entry *(SEPOS-PENNY-001, v1.6.141)*
- Payment numpad is ATM/card-machine style: digits push from the right
  (2-9-1-9 → £29.19), no decimal key, new `00` key, £9,999.99 cap. Applies to
  cash tendered, editable card amount and mixed-payment tenders.

### Also shipped in the window
- **SEPOS-043** — role hierarchy enforced (waiter/kitchen/bar: no Admin;
  supervisor: no closed-bill delete).
- **SEPOS-040** — real Stripe on the takeaway widget (per-restaurant keys,
  hardened verify).
- **v1.6.136 till batch** — device-owned printer settings, login loader,
  Exit + single-instance, ghost-table mutex/dedupe, open-the-day prompt.
- **v1.6.137** — cash change no longer counted as money taken.

---

## Deploy state at tag time

| Channel | Version |
|---|---|
| Railway backends (all tenants) | commit at `v1.7.0` tag |
| app.siamepos.co.uk | auto (sw v100) |
| Baan Siam POS ×2 + Thann Thai browser POS | manually rolled (sw v100) |
| Desktop tills | v1.7.0 OTA on next restart |
| Sunmi APK | **parked** (Thann Thai moved to the PC till) — line stays at v1.4.31 |

## Known-and-deferred (documented, not bugs to chase)
- 3 PLAUSIBLE audit findings + 4 LOW verify findings — in the audit report.
- Cloud-side payment amendments don't re-deliver to the till (till→cloud works).
- Offline multi-terminal session id collision (LOW, rare topology).
- Incremental sync — revisit near ~10 restaurants.
