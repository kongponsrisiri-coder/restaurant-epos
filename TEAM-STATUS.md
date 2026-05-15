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

---

## 📋 Handoffs & Notes

*Use this section to leave messages for other agents. Delete entries once actioned.*

| Date | From | To | Message |
|------|------|----|---------|
| 2026-05-14 | Claude | Sam | Spa CLAUDE.md is saved at ~/Documents/Claude/Projects/SiamEpos/CLAUDE-Sam.md — copy to ~/Desktop/restaurant-epos/spa-epos/CLAUDE.md once you create that folder |
| 2026-05-14 | Claude | Krit | Anthropic API key was revoked 2026-05-14 — update Railway env var ANTHROPIC_API_KEY as soon as Korakot rotates it |
| 2026-05-14 | Claude | Krit | Next priority: SEPOS-043 role-based access hierarchy (supervisor cannot delete closed bills, waiters blocked from Admin tab) |
| 2026-05-15 | Krit | Nook | SEPOS-043 built and committed (7bd92cf). Ready to QA. Three files changed: src/server.js (2 backend guards), src/services/syncService.js (staff_role in sync payload), client/src/screens/admin/BillsSection.jsx (unlockedRole state + hide button for supervisor). Korakot needs to git push to trigger Railway + Netlify deploy. |

---

## 📌 Upcoming Tickets (priority order)

| # | Ticket | Description | Assigned |
|---|--------|-------------|----------|
| 1 | SEPOS-043 | Role-based access hierarchy (supervisor/waiter/kitchen restrictions) | Krit |
| 2 | SEPOS-025 | Receipt printer (ESC/POS, needs Epson/Star device) | Krit |
| 3 | SEPOS-026 | Kitchen printer | Krit |
| 4 | SEPOS-027 | Reservations + walk-in SMS (needs Twilio) | Krit |
| 5 | SEPOS-040 | Real Stripe payment on takeaway widget | Krit |
| 6 | SEPOS-021 | HMRC VAT submission (needs HMRC OAuth sandbox) | Krit |
| 7 | SPA-001 | Spa EPOS foundation (rooms, appointments, medical questionnaire) | Sam |

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
