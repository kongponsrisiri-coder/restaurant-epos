# SiamEPOS — May 2026 Feature Update

**For:** SiamEPOS team (sales, support, ops, dev)
**Date:** 11 May 2026
**Demo:** [www.siamepos.net](https://www.siamepos.net) — fully working Baan Siam restaurant demo, end-to-end

---

## TL;DR

In the last quarter we shipped the desktop app (offline-capable), a customer CRM with email campaigns, an online takeaway ordering widget, staff time-tracking, and a public marketing site for sales demos. The whole stack — browser POS, iPad terminals, Mac/Windows app, customer website — now talks to the same cloud backend. **A prospect can sit through a 10-minute demo and see every flow live, including taking a real order.**

---

## What's new

### 🖥️ Desktop app — SiamEPOS Pro *(SEPOS-PRO-001)*

- Mac DMG + Windows EXE installers, signed and published to GitHub Releases
- Local SQLite — keeps trading even when the internet drops
- Two-way sync: pulls menu, staff, tables, reservations + closed orders from cloud; pushes local mutations back
- Auto-update via electron-updater — every release lands silently on installed machines
- First-launch wizard sets restaurant ID, cloud URL, sync secret

### 👥 Customer CRM + email marketing *(SEPOS-033)*

- Customers auto-aggregated from reservations, tiered VIP / Regular / New / Lapsed
- Email campaigns via Brevo with segment picker, preview, send history
- Make.com webhooks fire on: lapsed customer (60+ days), booking completed (24h after visit), birthday month *(birthday flow wired pending DOB capture)*
- GDPR consent capture on booking widget + HMAC-signed unsubscribe flow
- Manual opt-in toggle on the Customers tab — for verbal / phone consent

### 🥡 Online takeaway ordering *(SEPOS-034)*

- Drop-in widget — one `<script>` tag + a button, works on any website
- Five-step flow: pickup time → menu + cart → contact → payment → success
- Kitchen view tags 🥡 orders with customer name + pickup time
- Stock depletes automatically on order; Brevo confirmation email fires
- Payment is mocked for demos — real Stripe ramping in SEPOS-040 (per-restaurant Stripe keys, SiamEPOS never holds funds)

### 🕒 Staff operations

- **Clock in/out** with PIN, weekly summary, CSV export *(SEPOS-022)*
- **Staff performance report** — orders, average turn time, dessert attach rate *(SEPOS-030)*
- **Void types** — Wastage / Wrong Order / Customer Changed Mind / Comp, with manager-PIN gate on Comp *(SEPOS-023)*
- **Resend reasons** — Not Cooked / Wrong Item / Missing Item / Remake *(SEPOS-024)*
- **Multi-device LAN setup** with QR code + connection test *(SEPOS-028)*

### 📊 Inventory + reporting

- **VAT per menu item** + breakdown on bill, receipt and Z-report *(SEPOS-021, partial)*
- **Wastage cost reporting** — voided items × recipe cost per portion *(SEPOS-031)*
- **Auto stock depletion** on every sale and resend *(SEPOS-032)*

### 🎨 Settings + UX polish

- Logo upload, Google Review URL, receipt preview
- Receipt printer via the browser's print dialog
- Service charge maths fixed (correct change, correct totals)
- DB connection keep-alive

### 🌐 Demo / marketing site

- Live at [www.siamepos.net](https://www.siamepos.net) (Netlify, Namecheap DNS)
- Menu page fetches live data from the EPOS — change a price in Admin → Menu, the site reflects it next refresh
- Booking widget + takeaway widget both wired to the live backend
- Allergen chips on every dish (heuristic for now, real data when EPOS allergens column is populated)
- About page with chef bio, sourcing partners, press quotes, team

---

## What you can show a prospect in 10 minutes

1. Open [www.siamepos.net](https://www.siamepos.net) → browse the menu.
2. In a second window, open the EPOS Admin → Menu → toggle one dish unavailable → refresh the site → dish disappears.
3. Click **Order Takeaway** on the site → run through the mock-pay flow → switch to the EPOS Kitchen view → the 🥡 order shows up tagged with customer name + pickup time.
4. Click **Reserve a Table** on the site → tick the marketing consent box → confirm → switch to Admin → Customers → that customer is now opted-in and shows up in campaign segments.
5. From Admin → Campaigns → write a subject + body → preview → send. Customer receives a Brevo email.

That's the full loop: website → EPOS → kitchen → CRM → email. Real backend, real database, only the Stripe step is mocked.

---

## Known limitations to flag

| Item | Status | Ticket |
|---|---|---|
| HMRC MTD submission | Deferred — needs HMRC OAuth sandbox creds | SEPOS-021 (remainder) |
| Real Stripe on takeaway | Schema ready, widget swap pending | SEPOS-040 |
| Receipt / kitchen printer (ESC/POS direct) | Deferred — needs Epson/Star device for testing | SEPOS-025 / 026 |
| Customer DOB capture for birthday campaigns | Make.com webhook wired but no-op until field exists | — |
| Reservations Mac → cloud push | Pull works, push pending | — |
| Persistent local→cloud order-item ID mapping | In-memory now; workaround `DELETE FROM sync_queue` periodically | — |

---

## Sales talking points (one-liners)

- *"Zero commission on takeaway. Just Eat takes up to 35%. We take 0%."*
- *"Customer data stays yours — email, phone, order history. Yours to market to directly."*
- *"Keeps working when the internet drops — every order, every payment, every receipt."*
- *"One install, every device synced — desktop, iPad, browser, customer website."*
- *"GDPR-compliant out of the box — consent captured at booking, HMAC-signed unsubscribe."*
