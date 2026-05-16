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
| 2026-05-15 | Nook | Friday Night Stress Test v1 — 32/35 checks passed. 82 reservations, 277 covers, overbooking blocked, 5 bugs found for Krit. | SEPOS-STRESS |
| 2026-05-15 | Krit | BUG-001..005 — API hardening: 404 on add-items to ghost order, reject negative/zero payments, /api/tables name fallback, reject past reservation dates, 404 on PUT ghost reservation. Commit 937116d. | BUG-001..005 |
| 2026-05-15 | Nook | Friday Night Stress Test v2 — 35/37 passed. BUG-002,003,004,005 confirmed fixed. BUG-006 found. | SEPOS-STRESS |
| 2026-05-15 | Nook | Friday Night Stress Test v3 — 36/37 passed. BUG-006 found (pay ghost order→500). | SEPOS-STRESS |
| 2026-05-15 | Nook + Claude | Friday Night Stress Test v4 — 37/37 CLEAN. All bugs resolved. 82 reservations, 293 covers, 18 overbooking blocks, 0 crashes, 46.3s. System ready for production Friday service. | SEPOS-STRESS |
| 2026-05-15 | Krit | why-siamepos.html + book-demo.html refreshed — new hero, pain section (6 cards), generic-vs-SiamEPOS comparison table, founder story. Demo page: what-you'll-see checklist, 4-item trust signals, 3-step "What happens next" section, button copy updated to "See SiamEPOS in Action →". | MARKETING |
| 2026-05-16 | Maya | Nav consistency fixed across all 5 pages (features, why, book-demo, website-design) — SVG logo on all, uniform links: Features/Pricing/Why Us/Website Design/Book a Demo. website-design.html: prices £299→£199, £499→£299, Premium £799 removed. Portfolio section replaced with live www.siamepos.net Baan Siam showcase card. | MARKETING |
| 2026-05-16 | Maya | features.html: "Six features" section background fixed (white text was invisible on cream bg — now solid navy). "14 UK allergens" stat replaced with "AI / Scan invoice → stock & cost done" on index.html. Baan Siam portfolio card made bolder. OpenTable pricing corrected across features.html + pricing.html: removed false "£30/cover" — replaced with real published UK rates (£299/month + £1–2 per seated cover). | MARKETING |
| 2026-05-16 | Nick | Strategy: Uber Direct vs Uber Eats analysis. Uber Direct = white-label courier, zero commission, £3–6/delivery flat fee. Researched driver reliability risk — suburban Friday night peak is worst case (drivers busy elsewhere). Decision: Phase 1 = collection only (reliable, most UK Thai takeaway is collection anyway). Phase 2 = Uber Direct/Stuart as client opt-in, not a core feature. SEPOS-DELIVERY-001 deprioritised until Stripe live + real-world testing. SEPOS-ONBOARD-001 + Uber Direct API application tickets added to backlog. | STRATEGY |
| 2026-05-16 | Sandy | Baan Siam demo site (siamepos.net) — mobile nav fixed across all 7 pages (broken @media block causing burger menu to not show). Siam Kitchen portfolio page mobile nav built from scratch. Plern portfolio page: real photos (6 food shots + logo), gallery section, real address/phone/email from business plan. Accidentally overwritten plern.html restored from git. | DEMO SITE |
| 2026-05-16 | Sandy | Takeaway widget mobile UX overhaul — sticky cart bar at bottom of menu so users always see total without scrolling, horizontal scroll category tabs (no wrapping), 40px touch targets, iOS zoom fix (font-size:16px on all inputs), large tap-friendly pickup time cards, named step indicators, backdrop tap to close. | SEPOS-034 |
| 2026-05-16 | Krit | SEPOS-DELIVERY-002 — takeaway customers now flow into the Customers CRM (merged into /api/customers by email — note: there is NO customers table, CRM is derived from reservations + now takeaway orders). Widget Step 3 gets a Collection/Delivery toggle + address fields + consent checkbox. Kitchen shows 🚗 Online Delivery vs 🥡 Online Order. 4 new orders columns. Commits 94b75c5 + ed1336a. Phase 2 (Uber dispatch) NOT done — separate ticket. | SEPOS-DELIVERY-002 |
| 2026-05-16 | Krit | SEPOS-DELIVERY-002 radius check — takeaway widget geocodes the customer's postcode (postcodes.io, free, no key) and checks straight-line distance against the restaurant's delivery radius. Delivery toggle only appears once the operator sets a postcode + radius in Admin → Settings → 🚗 Online Delivery. Address fields are revealed only when the postcode is confirmed in-area; out-of-area customers get a one-tap "Order for Collection instead". New /api/takeaway/delivery-check endpoint + delivery_enabled flag on /api/takeaway/settings. | SEPOS-DELIVERY-002 |

---

## 📢 Announcements

| Date | From | Message |
|------|------|---------|
| 2026-05-16 | Sandy (Korakot directive) | **MOBILE FIRST — new rule for all web work.** Every website, widget, or page must be designed and tested on mobile before desktop. Min 44px tap targets, 16px+ form inputs, hamburger nav, no horizontal scroll, key actions above the fold on phone. Full checklist in CLAUDE-Sandy.md. This applies to: siamepos.co.uk, siamepos.net, booking widget, takeaway widget, and any future client sites. |

---

## 📋 Handoffs & Notes

*Use this section to leave messages for other agents. Delete entries once actioned.*

| Date | From | To | Message |
|------|------|----|---------|
| 2026-05-14 | Claude | Sam | Spa CLAUDE.md is saved at ~/Documents/Claude/Projects/SiamEpos/CLAUDE-Sam.md — copy to ~/Desktop/restaurant-epos/spa-epos/CLAUDE.md once you create that folder |
| 2026-05-15 | Nook | Krit | PERF-001 (LOW): Block 5B concurrent item-adds — 5/10 Railway requests timeout under burst load. Likely connection pool exhaustion. Not blocking production but worth increasing the DB pool size if it appears in real service. |
| 2026-05-16 | Nick | Krit | ACTION REQUIRED: Add ANTHROPIC_API_KEY to back-office Railway env vars — unlocks AI website import (scrape client URL → auto-populate name, tagline, address, about). This is already built in ops.siamepos.co.uk, just needs the key. |
| 2026-05-16 | Korakot | All | ✅ Anthropic API key rotated and updated. Restaurant EPOS Railway env + Finance settings page both updated. AI invoice scanner and AI summary should be working again. |
| 2026-05-16 | Nick | Nong | For client onboarding NOW: open a new Claude chat, paste NONG.md as context + client details (name, covers, tables, staff, menu categories, service charge). Claude walks through setup checklist in Thai + English. Use this until SEPOS-ONBOARD-001 is built. |
| 2026-05-16 | Nick | Korakot | ACTION: Apply for Uber Direct API access NOW at developer.uber.com/docs/deliveries/overview — approval takes 1–2 weeks. Start clock while Krit finishes Stripe (SEPOS-040). Uber Direct = white-label courier, zero commission, ~£3–6/delivery flat. Completely different from Uber Eats marketplace. |
| 2026-05-16 | Krit | Nook | SEPOS-DELIVERY-002 built + pushed (94b75c5). Ready to QA. Heads-up for the spec: there is NO `customers` table — the CRM is a derived view over `reservations`, so I extended /api/customers to merge takeaway orders by email instead of the customers/customer_id approach in the ticket. Same outcome. To test: place a takeaway order via the widget (try both Collection + Delivery), check it appears in Admin → Customers, and check the kitchen shows 🚗 for delivery. |
| 2026-05-16 | Krit | Nook | DELIVERY radius check shipped — to QA: in Admin → Settings → 🚗 Online Delivery set a restaurant postcode + radius (try 3 miles), Save. On the takeaway widget Step 3 a Delivery toggle should appear; pick Delivery, type an in-area postcode → Check → address fields appear; type a far-away postcode → Check → "outside our delivery area" + collection fallback. With both Settings fields blank, the Delivery toggle should NOT appear at all. Distance is straight-line via postcodes.io. |
| 2026-05-16 | Krit | Korakot | SEPOS-DELIVERY-002 is cloud-only so far (Railway + Netlify auto-deployed). 3 things now wait for a desktop installer tag: SEPOS-043, SEPOS-046, BUG-001..005 — plus this. Say when you want a v1.5.2 build to carry them all to the Mac. |

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
| 7 | SEPOS-ONBOARD-001 | AI-powered client setup wizard — 6-step onboarding (profile → menu import → table plan → staff → settings → allergen pre-fill). Target: 20–30 min setup vs 60–90 manual. Build after first 10 clients. | Krit |
| 8 | SEPOS-DELIVERY-001 | Uber Direct / Stuart integration — opt-in courier dispatch for clients who need it. NOT a core feature — reliability varies heavily by location and time (suburban Friday night = unreliable driver supply). Phase 1: keep takeaway as collection only. Phase 2: offer as client-activated option. Build only after SEPOS-040 Stripe is live and tested in real conditions. Apply for Uber Direct API when ready: developer.uber.com/docs/deliveries/overview | Krit |

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
