# SiamEPOS v1.9.0 — Milestone Release
*Cut 9 Aug 2026 · the first X.Y.0 since v1.8 · declared by Korakot after field-testing the 1.8.35–1.8.40 series live*

## Why this is a milestone
The 1.8.x series ended with the platform doing something new in kind, not just degree: **a client's own website prints in their kitchen through their own till — hands-free, no marketplace, no commission.** Proven on paper with Akin Thai on 9 Aug.

## Headline features (since v1.8.34)

### 🏠 Host mode — tablet/device as the restaurant's own server (SEPOS-ANDROID-003, graduated from spike)
- One client codebase: any native till can become the **host** (runtime flag) — runs the full backend on-device, works offline, serves satellite tills over the LAN, optionally mirrors a SiamEPOS cloud (pull-only).
- Satellite joining by QR (`Add a till`), owner read-only dashboard, foreground-service server with battery-optimisation exemption.
- Deployment model: **one host till per restaurant, satellites by IP; any number of printers.**
- ⚠️ Operational rule: on a host till the app-level "Auto-print online orders" toggle stays OFF — the host's own relay prints (both on = double tickets).

### 📱 QR self-ordering, hardened (SEPOS-QR-PAY-REDO + AUDIT-002)
- Pay-first per round; **a customer's QR round never joins a waiter's bill** — every QR order is fully paid by construction.
- Payment replay-proof (payment_intent persisted + deduped, bound to its table), licence-gated payment intents, refund-on-failure.
- Per-round receipts (each person gets a receipt for exactly what they paid) + printed split-payment breakdown on the bill.

### 🖨 Printers
- Test slips **identify themselves** — printer name, IP:port, roles printed on the ticket.
- Unified station routing on every surface incl. online orders (food → kitchen, drinks → bar, categories → stations, from one order).
- Held-ticket/retry dedupe fixes; multi-subnet scan.

### 🧾 Till quality (the live-test batch)
- Table NAMES everywhere as a class (tickets, KDS, Bills, reports, exports).
- Un-sent cart survives interruptions (incl. brand-new tables).
- Sticky Save bars on long admin pages; on-screen keyboard for keyboard-less tills; payments mirrored to Pro tills (missing-bills fix + repair sweep).

### ☁️ Fleet
- Fresh-tenant provisioning fixed as a class (schema-order boot bug) — proven by provisioning **siamepos-akin-thai**, the 6th tenant.
- Verification culture: 7-round adversarial verify + full restaurant-day simulation (167/167) behind the audit batch.

## Builds
- **Desktop (Electron): v1.9.0** — Mac DMG + Windows EXE via GitHub Release; existing installs auto-update.
- **Android till APK: v1.5.0 (vc66)** — sideload, `~/Documents/SiamEPOS-Android/SiamEPOS-v1.5.0.apk`.
- **Host APK: v1.25 (vc31)** — sideload.
- PWA cache: v127 (browser tills need a refresh cycle to pick it up).

## Known holds
- SiamPay/real-card checkpoint per client before real money (Akin Thai currently mock-pay).
- `akin-thai.siamepos.co.uk` certificate pending the Railway dashboard TXT check.
- Satellite-over-Wi-Fi reachability to a host till: verify per venue (possible router AP isolation).
