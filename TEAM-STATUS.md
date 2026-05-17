# SiamEPOS Team Status Board

> Every agent reads this at the **start** of every session.
> Every agent updates this at the **end** of every session.
> This keeps the whole team on the same page.

---

## 🟢 Active Work

| Agent | Working On | Ticket | Started |
|-------|-----------|--------|---------|
| Krit | SiamEPOS Lite (SEPOS-LITE-001-design.md). Phase 1 + 2a DONE — multi-tenant DB schema; MULTI_TENANT flag + resolveRestaurantId; restaurant_id on takeaway writes; takeaway widget passes restaurant_id; plan-based feature gating (GET /api/restaurant + utils/plan.js — lite plans hide dine-in nav + limited Admin). Commit a3aebc0. 2b (endpoint read-scoping) held until the Lite backend is deployed; Phases 3–4 pending Korakot's §14 questions. | SEPOS-LITE-001 | 2026-05-17 |

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
| 2026-05-16 | Maya | why-siamepos.html: Added competitor comparison rows (support hours, invoice scanning, cost vs sales, CRM, VAT reporting, built for Thai restaurants). Removed clock-in/out row — VDIT does have that feature, kept comparison honest. | MARKETING |
| 2026-05-17 | Maya | Created lite.html — SiamEPOS Lite landing page. Hero, 3 pricing cards (Booking £29, Ordering £39, Bundle £49), ROI calculator strip, Pro upgrade comparison (£89, widgets included). Added "Lite" nav link across all 6 pages. | SEPOS-LITE |
| 2026-05-16 | Maya | Delivery messaging added to index.html + features.html — takeaway cards updated to "Collection or Delivery", mention Uber Direct or own driver. No promises made about how it works, just that SiamEPOS supports both options. | MARKETING |
| 2026-05-16 | Nick | Strategy: Uber Direct vs Uber Eats analysis. Uber Direct = white-label courier, zero commission, £3–6/delivery flat fee. Researched driver reliability risk — suburban Friday night peak is worst case (drivers busy elsewhere). Decision: Phase 1 = collection only (reliable, most UK Thai takeaway is collection anyway). Phase 2 = Uber Direct/Stuart as client opt-in, not a core feature. SEPOS-DELIVERY-001 deprioritised until Stripe live + real-world testing. SEPOS-ONBOARD-001 + Uber Direct API application tickets added to backlog. | STRATEGY |
| 2026-05-16 | Sandy | Baan Siam demo site (siamepos.net) — mobile nav fixed across all 7 pages (broken @media block causing burger menu to not show). Siam Kitchen portfolio page mobile nav built from scratch. Plern portfolio page: real photos (6 food shots + logo), gallery section, real address/phone/email from business plan. Accidentally overwritten plern.html restored from git. | DEMO SITE |
| 2026-05-16 | Sandy | Takeaway widget mobile UX overhaul — sticky cart bar at bottom of menu so users always see total without scrolling, horizontal scroll category tabs (no wrapping), 40px touch targets, iOS zoom fix (font-size:16px on all inputs), large tap-friendly pickup time cards, named step indicators, backdrop tap to close. | SEPOS-034 |
| 2026-05-16 | Sandy | Takeaway widget delivery UX — moved Collection/Delivery toggle + postcode radius check to Step 1 (before menu). Delivery: enter postcode → Check → confirmed ✅ → browse menu → address on details screen. Collection: one tap → straight to menu. Removed schedule/ASAP picker — always ASAP, shown at review. Order page updated with Collection + Delivery cards. | SEPOS-DELIVERY-002 |
| 2026-05-16 | Krit | SEPOS-025/026 printer round 2 — printService.js: TCP job queue (1.5s gap between connections to fix WAVLINK buffer overlap/garbled header), CAN byte, buildFireNotice (TABLE X / FIRE MAINS call card, no item list), name_alt below EN name in bilingual kitchen tickets. server.js: /api/print/kitchen-fire endpoint. api.js: serverPrintFireNotice. KitchenTicket.js: printFireNoticeTicket export + buildFireNoticeHTML. OrderScreen.jsx: Fire button now prints fire notice (not full ticket); kitchen+bar prints chained sequentially in background (fixes simultaneous TCP drop — only drink was printing). Bar popup pre-open fixed (Chrome 1-popup-per-gesture limit). | SEPOS-025/026 |
| 2026-05-16 | Krit | SEPOS-DELIVERY-002 — takeaway customers now flow into the Customers CRM (merged into /api/customers by email — note: there is NO customers table, CRM is derived from reservations + now takeaway orders). Widget Step 3 gets a Collection/Delivery toggle + address fields + consent checkbox. Kitchen shows 🚗 Online Delivery vs 🥡 Online Order. 4 new orders columns. Commits 94b75c5 + ed1336a. Phase 2 (Uber dispatch) NOT done — separate ticket. | SEPOS-DELIVERY-002 |
| 2026-05-16 | Krit | SEPOS-DELIVERY-002 radius check — takeaway widget geocodes the customer's postcode (postcodes.io, free, no key) and checks straight-line distance against the restaurant's delivery radius. Delivery toggle only appears once the operator sets a postcode + radius in Admin → Settings → 🚗 Online Delivery. Address fields are revealed only when the postcode is confirmed in-area; out-of-area customers get a one-tap "Order for Collection instead". New /api/takeaway/delivery-check endpoint + delivery_enabled flag on /api/takeaway/settings. | SEPOS-DELIVERY-002 |
| 2026-05-16 | Krit | Split bill print buttons — 🖨️ Print button added alongside Cash + Card on both Split Equally and Split by Item screens. Print marks person as paid + prints their individual receipt (split equally: all items, their share of total; split by item: only their assigned items). BillScreen.jsx only. | SPLIT-PRINT |
| 2026-05-16 | Krit | SEPOS-025/026 — Server-side ESC/POS network printing. New printService.js sends raw ESC/POS to printer IP:9100 via TCP. Works from iPad/browser/Electron on same WiFi. Settings UI: Admin → Settings → 🌐 Network Printers (IP + port for receipt/kitchen/bar + kitchen copies). ReceiptPrinter.jsx + KitchenTicket.js try server-side first, fall back to Electron/browser. 4 new endpoints: /api/print/test|receipt|kitchen|bar. | SEPOS-025/026 |
| 2026-05-17 | Krit | SEPOS-LITE-001 Phase 1 — Multi-tenant schema foundation. restaurants registry table (restaurant_id, name, plan, api_key, status, Stripe IDs) seeded with default 'siamepos'. restaurant_id column added to all 19 tenant-scoped tables (orders, order_items, payments, menu_items, categories, staff, settings, etc.) — default 'siamepos'. Indexes on orders/order_items/menu_items. Design doc committed: SEPOS-LITE-001-design.md. Safe for Pro — purely additive, existing installs unaffected. tenantQuery helper + MULTI_TENANT flag deferred to Phase 2. Phase 2–4 gated on Korakot's answers to §14 open questions (hosting, dashboard location, plan tiers, billing owner). | SEPOS-LITE-001 |
| 2026-05-16 | Krit | SEPOS-025/026 — Mac desktop-app silent printing. Electron `list-printers` + `print-html` IPC (webContents.print, no dialog); Admin → Settings → 🖨️ Printer card picks receipt + kitchen printers per-device (localStorage) with a Test print button. Receipts print silently to the chosen printer, browser print-dialog kept as fallback. Kitchen tickets auto-print an 80mm ticket when a course is fired (KitchenTicket.js). Works with any OS-installed thermal printer incl. cnfujun 80.E-Z04-AA. iPad/browser keeps the print dialog. | SEPOS-025/026 |
| 2026-05-16 | Krit | Receipt printing fix — diagnosed "prints raw code on paper" on the cnfujun POS80: the Mac printer queue was on the **Generic PostScript** driver. Switched the CUPS queue to the **POS-80** thermal driver (`lpadmin`), re-enabled + cleared the stuck queue. Browser receipt printing confirmed working. Printer gotcha documented in Announcements. | SEPOS-025 |
| 2026-05-16 | Krit | Cut desktop release **v1.5.2** — version bumped, tag pushed, GitHub Actions Release build running. Carries SEPOS-025/026 (printer), SEPOS-043, SEPOS-046, BUG-001..005 and SEPOS-DELIVERY-002 to the Mac + Windows desktop apps. | Release v1.5.2 |

---

## 📢 Announcements

| Date | From | Message |
|------|------|---------|
| 2026-05-16 | Sandy (Korakot directive) | **MOBILE FIRST — new rule for all web work.** Every website, widget, or page must be designed and tested on mobile before desktop. Min 44px tap targets, 16px+ form inputs, hamburger nav, no horizontal scroll, key actions above the fold on phone. Full checklist in CLAUDE-Sandy.md. This applies to: siamepos.co.uk, siamepos.net, booking widget, takeaway widget, and any future client sites. |
| 2026-05-16 | Korakot | All | **RECOMMENDED RECEIPT PRINTER for clients:** cnfujun 80mm thermal printer — under £30, ESC/POS (Epson compatible), USB + Ethernet built in, works on Mac + Windows + Linux. Model 80.E-Z04-AA. Driver download: cnfujun.com/d/33 (direct download, no page shown — just paste URL in browser). Korakot tested and confirmed working on Mac. Recommend this to all new SiamEPOS clients as the budget receipt printer option. |
| 2026-05-16 | Krit | All (esp. Nong / onboarding) | **⚠️ PRINTER SETUP GOTCHA — cnfujun / POS80 thermal printer.** Symptom: receipts print as raw HTML/code on paper while the on-screen preview looks fine. Cause: macOS auto-installs the printer with the **"Generic PostScript Printer"** driver — the thermal printer can't read PostScript so it prints the page code as text. FIX: install the cnfujun driver (cnfujun.com/d/33), then in System Settings → Printers & Scanners set the printer's driver/"Use" to the **POS-80** driver (NOT Generic PostScript, NOT Generic PCL). Verify with Terminal: `lpoptions -p <printer>` should show `printer-make-and-model=POS-80`. Every client installing this printer will hit this — make it a step in the onboarding checklist. |

---

## 📋 Handoffs & Notes

*Use this section to leave messages for other agents. Delete entries once actioned.*

| Date | From | To | Message |
|------|------|----|---------|
| 2026-05-16 | Krit | Nook | Please create a printer setup manual for clients. Cover: (1) What hardware to buy — WAVLINK USB 2.0 Network Print Server + compatible thermal printer (Epson TM-T20III or Star TSP143III recommended). (2) Physical setup — plug USB printer into WAVLINK, plug WAVLINK into router via Ethernet. (3) Finding the printer IP — log into router at 192.168.1.1, find WAVLINK in device list, assign it a static/fixed IP so it never changes. (4) SiamEPOS setup — Admin → Settings → 🌐 Network Printers → enter IP + port 9100 for receipt/kitchen/bar → Test → Save. (5) Troubleshooting — printer not found: check same WiFi, check IP hasn't changed, reboot WAVLINK. (6) ⚠️ IMPORTANT — Silent auto-print vs popup: When accessing SiamEPOS via app.siamepos.co.uk (cloud), print jobs go through Railway server which cannot reach a local printer IP — so a browser print dialog popup will appear. To get fully silent automatic kitchen tickets with NO popup, the till Mac must access SiamEPOS via the LOCAL network URL instead. Go to Admin → Settings → Network Setup, copy the URL shown (e.g. http://192.168.1.x:3001) or scan the QR code, and bookmark that URL on the till Mac. When using the local URL, the server runs on the Mac and can reach the printer directly — no dialog, fully automatic. iPads on the same WiFi should also use this local URL for silent printing. Keep it simple with screenshots if possible. Both English and Thai versions please. |
| 2026-05-14 | Claude | Sam | Spa CLAUDE.md is saved at ~/Documents/Claude/Projects/SiamEpos/CLAUDE-Sam.md — copy to ~/Desktop/restaurant-epos/spa-epos/CLAUDE.md once you create that folder |
| 2026-05-15 | Nook | Krit | PERF-001 (LOW): Block 5B concurrent item-adds — 5/10 Railway requests timeout under burst load. Likely connection pool exhaustion. Not blocking production but worth increasing the DB pool size if it appears in real service. |
| 2026-05-16 | Nick | Krit | ACTION REQUIRED: Add ANTHROPIC_API_KEY to back-office Railway env vars — unlocks AI website import (scrape client URL → auto-populate name, tagline, address, about). This is already built in ops.siamepos.co.uk, just needs the key. |
| 2026-05-16 | Korakot | All | ✅ Anthropic API key rotated and updated. Restaurant EPOS Railway env + Finance settings page both updated. AI invoice scanner and AI summary should be working again. |
| 2026-05-16 | Nick | Nong | For client onboarding NOW: open a new Claude chat, paste NONG.md as context + client details (name, covers, tables, staff, menu categories, service charge). Claude walks through setup checklist in Thai + English. Use this until SEPOS-ONBOARD-001 is built. |
| 2026-05-16 | Nick | Korakot | ACTION: Apply for Uber Direct API access NOW at developer.uber.com/docs/deliveries/overview — approval takes 1–2 weeks. Start clock while Krit finishes Stripe (SEPOS-040). Uber Direct = white-label courier, zero commission, ~£3–6/delivery flat. Completely different from Uber Eats marketplace. |
| 2026-05-16 | Krit | Nook | SEPOS-DELIVERY-002 built + pushed (94b75c5). Ready to QA. Heads-up for the spec: there is NO `customers` table — the CRM is a derived view over `reservations`, so I extended /api/customers to merge takeaway orders by email instead of the customers/customer_id approach in the ticket. Same outcome. To test: place a takeaway order via the widget (try both Collection + Delivery), check it appears in Admin → Customers, and check the kitchen shows 🚗 for delivery. |
| 2026-05-16 | Krit | Nook | SEPOS-025/026 printer (kitchen+bar simultaneous) still not fully resolved. Sequential chaining pushed. Next session: if still only drink prints, try extending printService `setTimeout` gap from 1500ms → 3000ms, or test with a printer on Ethernet direct (not WAVLINK USB). |
| 2026-05-16 | Krit | Nook | DELIVERY radius check shipped — to QA: in Admin → Settings → 🚗 Online Delivery set a restaurant postcode + radius (try 3 miles), Save. On the takeaway widget Step 3 a Delivery toggle should appear; pick Delivery, type an in-area postcode → Check → address fields appear; type a far-away postcode → Check → "outside our delivery area" + collection fallback. With both Settings fields blank, the Delivery toggle should NOT appear at all. Distance is straight-line via postcodes.io. |
| 2026-05-16 | Krit | Korakot | **v1.5.2 cut — CI building.** Tag `v1.5.2` pushed; GitHub Actions Release workflow building the Mac DMG + Windows EXE (~15–20 min). When CI finishes, a `SiamEPOS v1.5.2` GitHub Release appears with the installers. NEXT (Korakot, back later): reinstall the v1.5.2 DMG on the Mac to get onto the build, then the desktop-app silent printing is testable. Carries SEPOS-025/026, 043, 046, BUG-001..005, DELIVERY-002. |
| 2026-05-16 | Krit | Nook | SEPOS-025/026 printer QA — v1.5.2 desktop build now cut & building. Once released + installed on the Mac, test: Admin → Settings → 🖨️ Printer → pick Receipt + Kitchen printer → "Test print" prints silently (no dialog); pay a bill → receipt prints; add items to an order + hit 🔥 Fire → 80mm kitchen ticket prints. In a plain browser the Printer card shows a "desktop app only" note and receipts use the print dialog (correct). IMPORTANT: the Mac printer must be on the **POS-80** driver, not Generic PostScript — see the printer gotcha in Announcements. |
| 2026-05-16 | Claude | Maya | ✅ DONE — VDIT comparison added to why-siamepos.html. |
| 2026-05-17 | Claude | Nick | ACTION: Write a pitch document for SiamEPOS Lite (widgets-only product for restaurants already on another EPOS). Target audience: Thai restaurant owners locked into VDIT or other EPOS contracts. Pricing agreed by Korakot: Booking widget £29/month, Ordering widget £39/month, Bundle (both) £49/month, Full SiamEPOS Pro £89/month (widgets included). Core pitch angle: (1) ROI hook — a restaurant doing £3,000/month on Deliveroo pays £900 commission; our ordering widget at £39/month saves £861+/month even moving a third of orders. (2) Booking hook — replaces OpenTable (£299+/month) or FoodBooking.com (closing March 2027). (3) Switch trigger — they pay £49/month widgets + their EPOS fee (say £80-100). When EPOS contract expires: "Switch to full SiamEPOS at £89 — widgets included, no separate EPOS fee, you save £40-60/month." (4) VDIT angle — don't name them, but "already on another EPOS system? Start with just the widgets. Add the full system when you're ready." Deliverable: a sales pitch doc (Word or PDF) Korakot can use in demos and send to prospects. Also suggest what Nick should add to CLAUDE-Nick.md as ongoing competitive context. |
| 2026-05-17 | Claude | Maya | ✅ DONE — lite.html built and live. |
| 2026-05-17 | Claude | Krit | SEPOS-LITE-001 (new ticket): Build SiamEPOS Lite — widgets-only product for restaurants already on another EPOS. Needs: (1) Stripped-down onboarding: just restaurant name, address, phone, logo, menu upload, and basic settings (no table plan, no KDS, no staff setup). (2) Lite dashboard: show bookings and orders only — no EPOS tabs. Could be a simplified view of ops.siamepos.co.uk or a new lightweight page. (3) Account tier flag: a `plan` field on the restaurant record — 'lite_booking', 'lite_ordering', 'lite_bundle', 'pro'. Hide EPOS features for lite plans. (4) Stripe subscriptions (SEPOS-040) becomes prerequisite — lite plan needs billing before launch. (5) Widget embed codes: after setup, show the restaurant copy-paste embed codes for their existing website. Priority: design the DB schema + onboarding flow first, discuss with Korakot before building. |

---

## 📌 Upcoming Tickets (priority order)

| # | Ticket | Description | Assigned |
|---|--------|-------------|----------|
| 1 | SEPOS-027 | Reservations + walk-in SMS (needs Twilio) | Krit |
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
