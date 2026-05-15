# SiamEPOS Team Status Board

> Every agent reads this at the **start** of every session.
> Every agent updates this at the **end** of every session.
> This keeps the whole team on the same page.

---

## 🟢 Active Work

| Agent | Working On | Ticket | Started |
|-------|-----------|--------|---------|

---

## ✅ Recently Completed (last 14 days)

| Date | Agent | Completed | Ticket |
|------|-------|-----------|--------|
| 2026-05-14 | Krit | VAT per item, staff clock-in/out, void types, resend reasons, multi-device setup, staff performance report, wastage cost, auto stock depletion, Customer CRM + Brevo campaigns, Make.com webhooks, takeaway widget | SEPOS-021 to 034 |
| 2026-05-14 | Krit | Bidirectional active-order sync, realtime cloud→Mac relay, kitchen direct mode, timezone fix, Pass tab cross-browser fix | SEPOS-PRO-002, PRO-003 |
| 2026-05-14 | Pose | Finance page built (Starling Bank API integration, P&L, AI summary) | Back Office |
| 2026-05-14 | Claude | Back Office CLAUDE.md, Spa CLAUDE.md (Sam), QA CLAUDE.md (Nook), Agent Guide updated | Setup |
| 2026-05-15 | Krit + Nook | SEPOS-046 — Invoice scanner now processes line_items: stock update, cost update, price change detection, auto-create new ingredients. 52/53 tests passed. | SEPOS-046 |
| 2026-05-15 | Krit + Nook | SEPOS-043 — Role-based access. Backend 23/23 tests passed. Supervisor blocked from closed bill delete. Admin/Manager unaffected. 3 manual frontend checks remain. | SEPOS-043 |
| 2026-05-15 | Claude | Created TEAM-STATUS.md shared board, CLAUDE.md files for all 10 agents (Krit, Sam, Pose, Nook, Sandy, Kai, Maya, Nick, Nong + Krit-Cowork), auto-trigger end-of-session phrases added to all files | Team Infrastructure |
| 2026-05-15 | Nook | QA Report (Word doc) covering SEPOS-046 + SEPOS-043 — 76/76 tests passed, 3 manual checks pending. Saved to ~/Documents/Claude/Projects/SiamEpos/SiamEPOS-QA-Report-May2026.docx | Reporting |
| 2026-05-15 | Nook | Friday Night Stress Test — 32/35 checks passed. 82 reservations seeded, 277 covers, overbooking blocked correctly, concurrent load 20 req/448ms no crash. 3 fails = confirmed bugs for Krit. Run: node test-friday-night.js | SEPOS-STRESS |
| 2026-05-15 | Krit | BUG-001..005 — API hardening: 404 on add-items to a ghost order, reject negative/zero payment amounts, GET /api/tables name fallback, reject past reservation dates, 404 on PUT to a non-existent reservation. Committed 937116d, pushed — Railway auto-deploying. | BUG-001..005 |

---

## 📋 Handoffs & Notes

*Use this section to leave messages for other agents. Delete entries once actioned.*

| Date | From | To | Message |
|------|------|----|---------|
| 2026-05-14 | Claude | Sam | Spa CLAUDE.md is saved at ~/Documents/Claude/Projects/SiamEpos/CLAUDE-Sam.md — copy to ~/Desktop/restaurant-epos/spa-epos/CLAUDE.md once you create that folder |
| 2026-05-15 | Krit | Nook | BUG-001..005 all fixed + pushed (commit 937116d). Backend only — Railway auto-deploys. Please re-run the Friday-night stress test against the cloud to confirm: ghost order add-items → 404, negative pay → 400, /api/tables name populated, past reservation date → 400, PUT ghost reservation → 404. |

---

## 📌 Upcoming Tickets (priority order)

| # | Ticket | Description | Assigned |
|---|--------|-------------|----------|
| 1 | SEPOS-025 | Receipt printer (ESC/POS, needs Epson/Star device) | Krit |
| 2 | SEPOS-026 | Kitchen printer | Krit |
| 3 | SEPOS-027 | Reservations + walk-in SMS (needs Twilio) | Krit |
| 4 | SEPOS-040 | Real Stripe payment on takeaway widget | Krit |
| 5 | SEPOS-021 | HMRC VAT submission (needs HMRC OAuth sandbox) | Krit |
| 6 | SPA-001 | Spa EPOS foundation (rooms, appointments, medical questionnaire) | Sam |

---

## 🧠 How to Update This File

**At the start of your session:**
1. Read this file
2. Note what others have completed or are working on
3. Add yourself to "Active Work" if you're starting something

**At the end of your session:**
1. Move your active work row to "Recently Completed"
2. Add any handoff notes for other agents
3. Remove any outdated entries

**Format for a completed row:**
```
| 2026-05-14 | Krit | Short description of what was done | SEPOS-XXX |
```
