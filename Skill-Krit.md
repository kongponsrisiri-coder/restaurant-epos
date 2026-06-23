# Skill-Krit.md — Hard-Won Know-How for the SiamEPOS System

> My working playbook as Krit (Claude Code dev agent). **CLAUDE.md** is the
> reference manual and **KRIT.md** is my role; this file is the *experience layer* —
> the gotchas, instincts, and verification habits that aren't obvious from the code
> and that have actually bitten us. Read this when you want to move fast without
> breaking the things that are easy to break here.

---

## 0. The instinct that matters most: **verify on the live target, not in the repo**
The single most recurring class of bug here is "fixed in the repo but not live."
Causes: manual-deploy sites, stale caches, broken auto-update, multi-tenant
deploys. So:
- After any deploy, **curl the live asset** (cache-busted) or hit the live endpoint — don't stop at "build passed" / "committed."
- When a customer says "I don't see it," **diff live vs repo first** before debugging code. Half the time the code is fine and the deploy never happened.
- For desktop, **inspect the actual artifact** (download the DMG/zip, `codesign`/`spctl` it) — CI logs lie by omission.

---

## 1. Deploy map — WHO auto-deploys and who doesn't (memorise this)
This is the #1 source of "ghost fixes." `git push` does NOT deploy everything.

| Target | URL | Deploys how |
|---|---|---|
| Backend (EPOS app, `/api/*`, public widgets in `public/`) | Railway | ✅ **auto on `git push`** |
| `client/` main EPOS frontend | app.siamepos.co.uk | ✅ auto (git-connected Netlify) |
| `client/Website/` company marketing site | **siamepos.co.uk** | ❌ **MANUAL** (Netlify `grand-muffin-b3a2d3`, id `b5e0221f-a067-4888-86da-84e15da6e5e1`) |
| `client/MockUp Website/` Baan Siam demo | **siamepos.net** | ❌ **MANUAL** (Netlify `transcendent-mochi-b78ba5`, id `71d19263-fe6c-4c15-8bcc-ed8f0bf76ef0`) |
| Desktop app (Mac/Win) | GitHub Releases | ✅ on `git tag vX.Y.Z && git push origin vX.Y.Z` |

**Manual Netlify deploy:**
```bash
netlify deploy --prod --dir "client/Website"      --site b5e0221f-a067-4888-86da-84e15da6e5e1   # siamepos.co.uk
netlify deploy --prod --dir "client/MockUp Website" --site 71d19263-fe6c-4c15-8bcc-ed8f0bf76ef0  # siamepos.net
```
The **takeaway/booking widgets** (`public/*.js`) are served by the **backend**, so they
auto-deploy on push even though they appear on the static sites. Don't confuse them
with the inline `sw-*` booking form baked into the MockUp site (that's manual).

---

## 2. Desktop releases — the lessons that cost us the most
- **macOS auto-update REQUIRES a `zip` target, not just `dmg`.** Squirrel.Mac consumes a `.zip`; a DMG-only `latest-mac.yml` makes every Mac update silently fail (looks like the till "never updates" and gets hand-reinstalled). `build.mac.target` must include both `dmg` (manual install) **and** `zip` (OTA), and `release.yml` must attach `*.zip` + `*.zip.blockmap`. **Verify:** `latest-mac.yml`'s `path:` must be the `.zip`.
- The fix lives **in the published feed**, not the client — an already-installed (zip-capable) updater starts working the moment a release publishes a zip. So you often DON'T need a manual reinstall to recover; try **Settings → App & Updates → Check for updates** first.
- **Windows** auto-updates fine from the `.exe` (NSIS). `nsis.perMachine:false` is what keeps updates silent (no UAC). Windows is **unsigned** → SmartScreen warning on first manual install only (not an auto-update blocker; removing it needs a paid OV/EV cert).
- **Signing/notarization is real** and gated on the 5 `MAC_*`/`APPLE_*` GitHub secrets. Confirm against the artifact, not the log:
  ```bash
  curl -sL -o a.zip <release>/SiamEPOS-<ver>-Setup.zip && unzip -q a.zip
  codesign -dvv SiamEPOS.app | grep -E "Authority=Developer|TeamIdentifier"
  spctl -a -t exec -vv SiamEPOS.app    # want: source=Notarized Developer ID
  ```
  (A suspiciously fast Mac build isn't proof notarization was skipped — notarytool is just fast some days. Check the artifact.)
- **Version-bump discipline:** the tag MUST equal `electron/package.json` version (electron-updater compares versions). A `verify-version` CI job enforces this. **Never chain the version edit and the tag in one command** — bump, verify it landed, *then* tag.
- **Updater is logged** to `~/Library/Logs/SiamEPOS/updater.log` (Win: `%APPDATA%\SiamEPOS\logs`) and the real error shows in the Settings card — use it instead of guessing.
- **Release monitor pattern** (no `gh` CLI on this Mac — use curl + REST, run in background):
  ```bash
  RUN_ID=$(curl -s ".../actions/runs?per_page=10" | python3 -c "...head_branch=='vX.Y.Z'...")
  # poll .../actions/runs/$RUN_ID/jobs until all 'completed'
  curl -s ".../releases/tags/vX.Y.Z"   # confirm dmg+zip+exe+blockmaps+manifests
  ```

---

## 3. Database changes — the 3-edit rule + the FK ordering trap
A new column needs **three** edits or it 500s on SQLite/desktop:
1. **PG** (`src/db/database.js`): `ALTER TABLE x ADD COLUMN IF NOT EXISTS …`
2. **SQLite** (`src/db/localDatabase.js`): add to the `CREATE` **and** `addColumnIfMissing()` in `runMigrations` (covers existing tills)
3. Update the SELECTs/endpoints that use it.

Traps I've hit:
- **FK ordering on a FRESH DB:** an `ALTER … REFERENCES other_table(id)` placed *before* `other_table`'s `CREATE` in `database.js` works on existing DBs (table already there) but **fails on a brand-new tenant**. Put the ALTER *after* the referenced table is created.
- **FK delete behaviour matters:** use `ON DELETE SET NULL` for links like `orders.reservation_id` so deleting a parent (a booking) never deletes the child (the bill/revenue).
- **dbAdapter translation:** PG-only SQL (`GREATEST`, `::date`, `NOW()`, `ANY`, `LATERAL`, `jsonb_*`) silently 500s on SQLite unless `translateSql()` handles it. `DATE(x)`, `IS NULL`, `OR`, params `$1` work natively on both — those need no translation. When in doubt, check `src/db/dbAdapter.js` before shipping a new query.
- PG uses `$1 $2` params + `pool.query()` everywhere; the adapter rewrites for SQLite.

---

## 4. Front-end gotchas
- **`api.js` helpers DON'T throw on HTTP errors** — they resolve with `{error}` on 4xx/5xx. Optimistic UI handlers must wrap responses in `assertOk()` or the rollback `catch` never fires (you get a silent fail that looks like success).
- **Inline styles everywhere** (~2000 hardcoded hex, no CSS vars). Theming = swap the brand colours only (navy `#0D1B3E`/`#1a1a2e`, gold `#C9A84C`); leave functional colours (green=ok, red=danger) alone.
- **PWA cache:** bump `CACHE_NAME` in `client/public/sw.js` when shipping UI you need iPads to pick up. Bumping installs the new SW but it activates only after one refresh cycle — tell Korakot how to hard-refresh.
- **AdminScreen is a shell** — always edit the specific `client/src/screens/admin/*Section.jsx`, never the shell.
- **Desktop vs web detection:** `window.siamepos` exists only in the Electron app. Gate desktop-only UI (update card, etc.) on it so the web POS renders nothing.
- `window.prompt()` is dead in Electron — use a React modal. `alert`/`confirm` still work.

---

## 5. Copy & settings rules (these are product correctness, not style)
- **OS-agnostic copy by default:** customer-facing strings run on Mac AND Windows. Say "your device"/"your till", not "your Mac". When OS genuinely differs, label both (`Mac: Cmd+Shift+R · Windows: Ctrl+Shift+R`). Same for "tablet" vs "iPad".
- **Never hardcode operational values** — dining durations, party sizes, turn times, service charge etc. come from restaurant settings (e.g. Dining Duration tiers via `getDuration`). Baking in `150` minutes is a bug.
- **Spell "MAC address"** in full on first mention — Korakot reads bare "MAC" as the Apple computer.
- Group owner-facing admin UI **by workflow** (CUSTOMERS = Customers+Vouchers+Campaigns; STAFF = Staff+Clock+Performance), not generic buckets.
- Baan Siam customer site is **English-only** — no Thai toggle.

---

## 6. Multi-tenant + concurrent-session reality
- Each client = **own Railway service + Postgres + subdomain**. Baan Siam has its **own Railway** (`baan-siam.siamepos.co.uk`) and is **desktop-only** (the Mac SiamEPOS Pro app is the only operator UI — no web admin). So features Baan Siam uses (e.g. CRM) must reach them via a **desktop release**, not just a backend push.
- **The repo is edited by multiple live Claude sessions at once.** Re-read shared files (`TEAM-STATUS.md`) right before editing; commit **only my own files** (exclude others' in-flight work). Atomic python read-write avoids the "modified since read" race.
- **SiamSpa moved to its OWN repo** (`~/Desktop/siamepos-spa`, `kongponsrisiri-coder/siamepos-spa`) — it's no longer `restaurant-epos/spa-epos/`. Launch Sam from the new path. Spa releases publish there now.
- **Session-recovery trick** (learned when the spa repo moved mid-session): Claude files a session under the dir it was *launched* in. If `claude --resume` shows nothing after a folder move, copy the latest `~/.claude/projects/<old-encoded-path>/*.jsonl` into `~/.claude/projects/<new-encoded-path>/` and resume.
- **One CLI login "seat":** concurrent sessions share one credential; each `/login` rotates the token and bumps the others to "Not logged in." To fix: quit all, single `/login`, then reopen. Re-logging-in elsewhere can knock the active session out.

---

## 7. Money / records correctness (subtle, high-stakes)
- **Per-customer spend** is exact for takeaway (customer on the order) and, since SEPOS-PRO-008, for dine-in via `orders.reservation_id` (stamped at pay-on-seated-table). Walk-ins with no booking are still uncredited (needs "attach customer at till"). The CRM is a **derived view** (group reservations + takeaway orders by email) — there's no `customers` table.
- **Split payments:** one payment row **per tender** (last tender absorbs rounding) so the Z-report reconciles by method. A single `'Split'` row breaks cash-drawer reconciliation.
- **Service charge key** is `service_charge_rate` (not `_percent`); `service_charge_enabled` is `'1'`/`'0'` strings. VAT per item is `menu_items.vat_rate` (prices VAT-inclusive).
- **Timezone:** Railway containers default to UTC — set `TZ=Europe/London` per service or HH:MM validations are 1h off in BST. SQLite stores naive UTC; `localDatabase.js` rewrites rows to ISO-Z on read.

---

## 8. Security / safety reflexes
- Never commit scripts holding secrets / `.secrets-*.txt`.
- `AUTH_SECRET` must be set on every Railway (the default is forgeable). Same for `SYNC_SECRET` (gates closed/active-order sync; header `x-sync-secret`).
- Stripe is in **TEST mode** — pk/sk/price IDs + webhook endpoint must all match mode.
- Destructive admin actions → **truly hidden gesture** (multi-tap/long-press), never a visible lock icon.
- Don't pre-stage test pages/fixtures — **Nook does QA**; that's their lane.
- Manuals + QA reports live **outside the repo** at `~/Documents/SiamEPOS-Docs/`; ticket specs at `~/Documents/Claude/Projects/SiamEpos/`.

---

## 9. Session ritual (don't skip)
1. **Start:** read `TEAM-STATUS.md`, add myself to Active Work.
2. **End / any "thanks/done/bye" signal:** move my row to Recently Completed, add handoff notes for Sam/Pose/Nook, remove stale entries — *before* replying.
3. Commit messages reference the ticket and end with the `Co-Authored-By` trailer.
4. Run multi-step approved tickets **straight through** — don't pause between independent steps.

---

## 10. My standing verification checklist (paste-ready habits)
- [ ] Backend change → `git push`, then **curl the live endpoint** (not just "deployed").
- [ ] New DB column → all **3 edits** + dbAdapter check + FK ordering on fresh DB.
- [ ] Static marketing site change → **manual Netlify deploy** + cache-busted curl.
- [ ] Desktop change → bump version, verify it landed, tag, **confirm Release has dmg+zip+exe+blockmaps+manifests**, and that `latest-mac.yml` `path:` = the zip.
- [ ] Customer-facing string → OS-agnostic, uses settings not constants.
- [ ] Optimistic UI → response wrapped in `assertOk()`.
- [ ] TEAM-STATUS updated; only my files committed.
