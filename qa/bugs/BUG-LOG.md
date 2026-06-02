# SiamEPOS Bug Log

All bugs found by Nook. Updated every session.

| ID | Title | Project | Severity | Status | Assigned To | Date |
|----|-------|---------|----------|--------|-------------|------|
| BUG-EPOS-001 | `GET /api/reservations/settings` returns HTTP 500 (deprecated column names) | Restaurant EPOS | High | ✅ Fixed by Krit | Krit | 2026-05-22 |
| BUG-EPOS-002 | `POST /api/orders/:id/items` → 500 when `unit_price` missing from payload; server should fetch price from DB server-side | Restaurant EPOS | High | ✅ Fixed by Krit — **Nook QA PASSED** commit `099f6db`, verified `server.js:533-540` live 2026-06-03 | Krit | 2026-06-02 |
| BUG-EPOS-003 | Smoke test script sends `guest_name` but API expects `customer_name` for reservations (test script bug, not product bug) | Restaurant EPOS | Low | 🔴 Open (fix test script) | Nook | 2026-06-02 |
| BUG-EPOS-004 | `window.confirm()` silently fails throughout app in Electron — confirmations do nothing on desktop | Restaurant EPOS | High | ✅ Fixed by Krit — **Nook QA PASSED** commit `099f6db`, grep confirms 0 `window.confirm` callsites in `client/src/` (except util), verified 2026-06-03 | Krit | 2026-06-03 |
| BUG-EPOS-005 | `/api/reports/daily` excludes service charge from totals — ~11% undercount every day | Restaurant EPOS | Medium | ✅ Fixed by Krit — **Nook QA PASSED** commits `099f6db`+`2b8e303`, live: `order_count=132`, keys=8 correct fields, verified 2026-06-03 | Krit | 2026-06-03 |
| BUG-EPOS-006 | Discount type picker always selects 'fixed £' in Electron — percentage discount impossible on desktop | Restaurant EPOS | Medium | ✅ Fixed by Krit — **Nook QA PASSED** commit `099f6db`, `window.confirm` util covers discount confirm flow, verified 2026-06-03 | Krit | 2026-06-03 |
| SECURITY-001 | PIN "0000" accepted on production (trivially guessable) | Restaurant EPOS | High | ⚠️ Reported to Korakot | Korakot | 2026-05-22 |
| PERF-001 | 5/10 Railway requests timeout under concurrent burst load (connection pool exhaustion) | Restaurant EPOS | Low | 📋 Logged | Krit | 2026-05-22 |
| BUG-SPA-001 | Medical questionnaire COALESCE bug on NOT NULL columns | Spa EPOS | High | ✅ Fixed by Sam | Sam | 2026-05-22 |
