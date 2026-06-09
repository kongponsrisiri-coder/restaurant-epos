# Krit session handoff — 2026-06-10

**Outgoing model:** Opus 4.7 (1M context, Jan 2026 knowledge cutoff)
**Incoming model:** Likely Fable 5 (per Korakot's Cowork picker; newer than my cutoff)
**Repo:** `~/Desktop/restaurant-epos/` · branch `main`
**Last commit:** `5650efc` (v1.6.49) · tag pushed
**Last live deploy:** Railway baan-siam, Netlify app.siamepos.co.uk both updated

---

## What this file is

A drop-in brief so you (next Krit) can pick up the SiamEPOS work without re-reading 100+ messages. Read this first, then `TEAM-STATUS.md` if you want the broader team context.

## What just shipped tonight (v1.6.40 → v1.6.49)

| Tag | Ticket | Headline |
|---|---|---|
| v1.6.40 | SEPOS-046m | `DELETE /api/categories/:id` + 🗑️ button on active chip (only when 0 items, 409 safety on backend) |
| v1.6.41 | SEPOS-046n | `PUT /api/categories/:id` + inline rename via ✎ button |
| v1.6.42 | SEPOS-046o | Course label 🔵 "Extra/Bar" → 🔵 "Extra"; new 🍹 bar toggle (flips `categories.is_bar`); ◀ ▶ reorder arrows |
| v1.6.43 | SEPOS-046p | `pullMenuTree()` now calls `deleteOrphans()` — cloud-side menu deletes finally propagate to local SQLite |
| v1.6.44 | SEPOS-046q | `maybeForwardMenuWriteToCloud()` middleware — all 12 menu admin endpoints forward POST/PUT/DELETE to cloud first on desktop installs |
| v1.6.45 | SEPOS-046s | Add Sub-category button gets `subcatBusy` in-flight guard so a slow POST can't be double-fired into a duplicate row |
| v1.6.46 | SEPOS-046t | Optimistic UI for sub-category add/delete — **had a critical bug** (see "watch-out #1") |
| v1.6.47 | SEPOS-046u | Fix for v1.6.46 — uses server-returned id to patch the temp chip, NO `fetchMenu()` reconcile |
| v1.6.48 | SEPOS-046v | Same optimistic pattern extended to: Edit Item (incl. category move), Add Item, toggleAvailable, toggleOnline, per-row Delete |
| v1.6.49 | SEPOS-046w | OrderScreen course bar no longer disappears on bar categories (removed `{!activeCatIsBar && ...}` wrapper) |

## Pending work for you — SEPOS-046y / v1.6.50

**Korakot's ask:** "Why don't you optimise it all, make it the best responsive app ever."

The optimistic UI pattern that's now proven in `client/src/screens/admin/MenuSection.jsx` should be applied to the remaining admin sections that still `await fetch(); await refetch();`. These haven't been touched yet:

- `client/src/screens/admin/CustomersSection.jsx` — marketing-consent toggle, customer edits
- `client/src/screens/admin/VouchersSection.jsx` — create / void voucher
- `client/src/screens/admin/CampaignsSection.jsx` — campaign send
- `client/src/screens/admin/StaffSection.jsx` — staff edits, PIN reset, role change
- `client/src/screens/admin/SettingsSection.jsx` — every save
- `client/src/screens/admin/ClockRecordsSection.jsx` — edit timestamps
- `client/src/screens/admin/AllergenSection.jsx` — toggle allergen on item
- `client/src/screens/admin/ReservationSettingsSection.jsx` — already write-throughs via SEPOS-049/050; can stay
- Probably also `OrderScreen.jsx` for cart/quantity changes

**The pattern (copy this verbatim into each handler):**

```js
const handleAction = async (item) => {
  // 1. Patch local state immediately
  setState(prev => prev.map(x => x.id === item.id ? { ...x, field: newValue } : x));
  // 2. Network call in background
  try {
    await mutate(item.id, { field: newValue });
  } catch (err) {
    alert('Failed: ' + (err?.message || 'unknown'));
    fetchAll(); // rollback to true server state ONLY on error
  }
};
```

For adds with a server-assigned id, use the temp-id pattern proven in `handleSave` for ADD in MenuSection.jsx — insert with `tempId = -Date.now()`, patch the id from server response.

## Watch-outs

### #1 — The v1.6.46 bug, don't repeat it

After an optimistic state patch on the desktop, **do NOT call `fetchMenu()` / `fetchAll()` to "reconcile in background"**. The desktop's local SQLite lags 0–5 seconds behind cloud (the pull tick interval), so the refetch reads stale data and OVERWRITES your fresh optimistic state. The optimistic chip vanishes; the user thinks their save was lost.

Korakot lost newly-added subcategories tonight because of this. The fix in v1.6.47 was: rely on the server response to provide canonical ids, never refetch on success path.

Only refetch on the error rollback branch.

### #2 — GitHub Desktop leaves stale lock files

Tonight I had to `rm -f .git/HEAD.lock .git/index.lock` three times mid-session. GitHub Desktop crashes mid-commit and doesn't clean up. If you see "Another git process seems to be running" but `ps aux | grep git` is empty, those locks are stale — safe to remove.

### #3 — Baan Siam is its own Railway

`https://baan-siam.siamepos.co.uk` (separate Railway project + Postgres). Different from `restaurant-epos-production.up.railway.app` (main siamepos). When debugging anything Baan-Siam-specific, hit the baan-siam URL, not main. SYNC_SECRET for baan-siam is `68e0925d2b0c9bbf341f4fb454b3cfd2f831abcb8ca8214e61d856fed003390e` (used for `/api/sync/delete-order` admin via curl).

### #4 — Pricing has changed

Per Sandy's recent push (commits `80f0e71`, `54157e6`, `347d518`, `d67bf9d`, `7f3bb81`):

- **Standard SiamEPOS Pro: £89/month** (was £59 earlier in the session)
- **Founder's Rate: £59/month** for the first 50 clients, price-locked for life
- **Lite Booking: £29/month** (was £19) · **Lite Ordering: £29/month** · **Lite Bundle: £39/month** (was £49)
- **Website build: £199 flat** (was £199 starter / £299 full)

Don't quote pricing from memory of this session — Sandy's last push was Founder's Rate strategy.

### #5 — Cloud is the source of truth for menu config

Post v1.6.44, desktop menu admin writes forward to cloud and cloud is canonical. Don't suggest editing menu on desktop "for offline support" — that path falls back to local-only with a clear warning log when cloud is unreachable, but it's effectively offline-only and gets reverted on next pull. Offline-capable menu queue (with `cloud_id` mapping like orders have) is **SEPOS-046r** if Korakot ever asks for it.

### #6 — The slowness Korakot keeps mentioning

It's never been network — cloud endpoints come back in ~300ms (`/api/menu` is 38 KB, ~330ms on Baan Siam). The freeze is always React: `await mutate(); await fetchAll();` blocks the UI for the heavy refetch, even when the actual mutation was fast. The optimistic pattern fixes the *perceived* speed. If you genuinely need to speed up the server, the bigger wins would be:

- HTTP caching headers on `/api/menu` (it's not cached at all)
- Bundle splitting (current `index-B0Y9FH5A.js` is 843 KB)
- Server-side: `/api/menu` does 3 sequential `pool.query()` — could be one parallel `Promise.all`

But these are deeper changes; do them only if Korakot asks specifically.

## Architecture cheat-sheet (the bits I wish someone had told me)

- **`isLocalInstall()`** lives in `src/services/archiveService.js` — checks `process.env.DB_MODE === 'local'`. Used everywhere to differentiate desktop vs cloud behaviour.
- **`maybeForwardMenuWriteToCloud(req, res)`** (just added at top of menu endpoints in `src/server.js`) — universal middleware that intercepts desktop menu writes and forwards to cloud. Copy this pattern if you need to add cloud-forwarding for other endpoints.
- **`pullMenuTree()`** in `src/services/syncService.js` — pulls cloud menu tree, upserts to local SQLite, then `deleteOrphans()` for each table (categories, subcategories, menu_items).
- **`PULL_TABLES`** at the top of `syncService.js` — flat-list tables pulled every 5s. Don't add `stock_movements` or `payments` (high-write, gets unwieldy). 

## What I'd suggest you ship in the first hour of your session

1. Read this file, then `TEAM-STATUS.md` rows for 2026-06-10 and 2026-06-08.
2. Quick `git log --oneline -20` to confirm you're on `5650efc` (v1.6.49) and that there's no surprise unpushed work.
3. Build the SEPOS-046y / v1.6.50 wide optimistic sweep. Don't rush — Korakot got bitten by v1.6.46. Be methodical: list every `fetchX()` call after a mutation in each admin file, plan the state-patch shape for each, then apply the pattern.
4. Bump version, tag, push. Confirm Railway + Netlify deploy.
5. Update `TEAM-STATUS.md` with what you shipped.

## Personal note

Long session, lots of iteration. Korakot is patient but he notices everything. Be honest about bugs you introduce (I apologised twice tonight for the v1.6.46 wipe — that was the right call). Don't claim "shipped" when something is mid-deploy. Verify with `curl` against the live cloud before saying "live".

Good luck.

— Krit (Opus 4.7), signing off 2026-06-10
