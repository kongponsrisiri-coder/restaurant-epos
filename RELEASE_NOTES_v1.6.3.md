# SiamEPOS Pro — v1.6.3

**For:** SiamEPOS team + restaurant operators
**Date:** 28 May 2026
**Previous release:** v1.6.2 (27 May — same-day filename-stamping fix; no feature payload)
**Installs auto-update on next restart.** New installs get a filename like `SiamEPOS-1.6.3-Setup.dmg` so it's unambiguous which build is which.

---

## TL;DR

A full evening of live printer testing on a real cnfujun POS80 + WAVLINK + then-direct-Ethernet setup, with the bugs fixed live and hardened so a new client's first-day setup doesn't repeat any of tonight's pain. Receipt printing now works end-to-end including logo, £ symbol, table number, item grouping, centered layout, and the kitchen ticket only prints what was just added instead of the entire order history.

---

## Receipt + kitchen ticket fixes

| Bug | Cause | Fix |
|---|---|---|
| Item names showed as `undefined` | `/api/print/receipt` did `SELECT * FROM order_items` (no JOIN); buildReceipt used `item.name` without fallback | JOIN `menu_items` + frontend fallback chain `item.name \|\| item.item_name \|\| 'Item #N'` |
| `£` printed as `Тú` | UK thermal printer interpreted UTF-8 multi-byte 0xC2 0xA3 as garbage under default codepage | `CMD.INIT` now sends `ESC t 19` (CP858); `txt()` pre-maps `£` → byte `0x9C`; encoding switched utf8 → latin1 so 1 codepoint = 1 byte |
| Table number blank on receipt / `?` on kitchen ticket | All 5 `/api/print/*` endpoints did `SELECT * FROM orders` — `orders.table_id` present, `tables.table_number` not | All 5 endpoints now `LEFT JOIN tables ON orders.table_id = tables.id` |
| Thai text printed as `ดูดัดดูดัน` (mojibake) | UK printers have no Thai glyphs; UTF-8 multi-byte sequences render as garbage under default codepage | Strip codepoints > 0xFF (`txt()` filter); flip default `kitchen_language` from `'en_th'` to `'en'` so the optional Thai line is opt-in only |
| Receipt sat to the left side of the paper | After header, body switched to ALIGN_LEFT, leaving a visibly bigger margin on the right | Keep ALIGN_CENTER for the whole receipt — body, totals, footer all centered on the paper |
| Logo didn't print | (1) Client-side bitmap conversion produced all-zeros silently; (2) macOS CUPS queue name mismatch (POS80 vs auto-named `_192_168_68_57`); (3) 384-dot logo exceeded firmware's single-command limit | (1) `img.decode()` + threshold escalation 180 → 200 → 220 → 240 + ink% validation + preview thumbnail; (2) auto-detect CUPS queue by IP via `lpstat -v`; (3) centered padding to 384 dots; (4) single-command emit (after confirming chunked emit caused PARTIAL prints on cnfujun) |
| Wrapping on right edge at 48 cols | cnfujun POS80 native width is 44, not 48 — but 42 was overly conservative | `LINE_WIDTH = 42` (proven safe on this printer); configurable per-install via `settings.printer_line_width` (24-80 range accepted) |
| Send Order re-printed already-cooking items | `OrderScreen.sendOrder` passed `[...existingItems, ...cartAsItems]` to the kitchen — re-printed everything every time | Pass only `cartAsItems` (just-added items). Receipt / Bill still shows full order |
| Same item × N printed as N separate lines | No grouping logic on receipt | Group by `menu_item_id + discount + unit_price + course` — `1x Pad Thai + 1x Pad Thai + 1x Pad Thai` = `3x Pad Thai £25.50` |
| Notes printed on customer receipt | Per-item note line rendered under each item | Notes hidden on receipt (kitchen ticket still shows them where chef needs them) |
| Course headers (STARTERS/MAINS) printed on customer receipt | Cosmetic noise on the customer's bill | Course-header lines removed from receipt; items still sort starters → mains → desserts → extras |

---

## Print path hardening (so a client's first day doesn't replay tonight)

Three robustness measures added to make the printer setup self-healing for restaurants we'll never be on-site for:

### 1. Bulletproof logo conversion (client-side)
- `await img.decode()` instead of `img.onload` — large data URLs decode reliably across browsers
- Threshold auto-escalation: try 180 → 200 → 220 → 240, first one producing ≥ 100 inked dots wins (most brand colours render at 180; pastel logos need higher)
- Preview thumbnail in Settings shows the exact 1-bit bitmap that'll print, with ink% indicator + advice ("looks light — that is what will print" / "⚠️ very faint — try a darker / higher-contrast logo")
- Auto-centering padding to 384 dots so the printed image sits on the paper centerline (`GS v 0` ignores the `ESC a 1` text-align on most ESC/POS firmwares)

### 2. CUPS queue auto-detection
- New `GET /api/print/cups-queue-for-ip?ip=192.168.x.x` endpoint shells out to `lpstat -v` and returns the queue name whose device URI matches that IP
- Settings page calls this on IP-input blur — auto-populates the CUPS name field
- Server-side cache in `printService.js` (`_cupsQueueCache`) avoids repeated `lpstat` calls during a session
- Means new clients never need to know macOS's auto-naming convention (`_192_168_68_57` for a printer at 192.168.68.57)

### 3. Realistic mock receipt as Test button
- The "Test" button on Admin → Settings → Network Printers now prints a **complete mock receipt** instead of the old tiny "Printer test OK" page
- Mock receipt has: logo + restaurant header + table 5 / 2 covers / 3 mock items (spring rolls + pad thai + mango sticky rice) + £24.90 subtotal + 12.5% service + £28.01 total
- Exercises the entire receipt build path — operators see at setup time exactly what real receipts will look like, instead of discovering bugs at first service

---

## CUPS fallback (carried over from v1.6.0+)

`printService.js` now does TCP-first / CUPS-fallback per print:
- TCP port 9100 attempted first (works with any direct-Ethernet ESC/POS printer)
- On TCP failure (timeout, connection refused), falls back to `lpr -P <queue> -o raw` via `child_process.exec`
- Required for WAVLINK USB-to-LAN print servers (TCP fails silently, CUPS works)
- Required for printers that only expose LPD port 515 (not 9100) — exactly the cnfujun setup we hit tonight

---

## Operator action required

### Pro / Lite installs
1. **Redeploy Railway backend** if not already done since v1.6.2 — picks up the new print endpoints (`/api/print/cups-queue-for-ip`, the new mock-receipt logic in `/api/print/test`).
2. **Reload the Mac desktop install** by quitting and relaunching SiamEPOS — auto-update pulls v1.6.3 silently on next start.
3. **For restaurants with logos already uploaded** — open Admin → Settings → 🌐 Network Printers → re-click the logo size button (S/M/L/Full) once. This triggers the new bulletproof conversion + saves a centered bitmap. (Or just re-upload the logo file.)
4. **For restaurants on a printer-without-port-9100** (most WAVLINK + some Chinese thermal models): leave the CUPS name field blank in Settings — it auto-populates from the IP on blur.

### Backend env vars
- No new env vars needed in v1.6.3.

---

## Compatibility

- **No breaking changes.** All earlier flows (orders, kitchen, bar, receipt, takeaway, vouchers, batch prep) untouched.
- **Auto-update** lands on next desktop restart for any Mac on v1.6.2+ with the publish config.
- **artifactName** still includes `${version}` — DMG/EXE will be `SiamEPOS-1.6.3-Setup.dmg` so it can't be confused with v1.6.2 cached in Downloads (fix from v1.6.2).

---

## Tickets shipped in this release

- PRINT-RECEIPT-ITEMS — JOIN menu_items + fallback chain for item names
- PRINT-RECEIPT-POUND — CP858 codepage + £ remap
- PRINT-TABLE-NUMBER — JOIN tables on all 5 print endpoints
- PRINT-THAI-STRIP — Strip non-Latin-1 + flip kitchen_language default to 'en'
- PRINT-LOGO — Logo printing with chunked emit + centered padding (replaced with single-command emit after testing)
- PRINT-CENTER-ALIGN — Whole receipt centered on paper
- PRINT-LINE-WIDTH — 42 cols (configurable via settings.printer_line_width)
- PRINT-ITEM-GROUPING — Identical items merge into one line on receipt
- PRINT-HIDE-NOTES — Notes hidden on receipt (kitchen unchanged)
- PRINT-HIDE-COURSE-HEADERS — Course labels removed from receipt
- PRINT-SEND-ORDER-DELTA — Kitchen ticket only prints newly-added items
- PRINT-LOGO-ROBUST — img.decode() + threshold escalation + preview + ink validation
- PRINT-CUPS-AUTODETECT — Auto-find queue name by IP
- PRINT-MOCK-TEST — Test button prints realistic mock receipt

Full commit log: `git log v1.6.2..v1.6.3`.

---

*🤖 Generated alongside the v1.6.3 build by Krit.*
