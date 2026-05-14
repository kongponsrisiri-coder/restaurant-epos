# SiamEPOS — Client Onboarding Handbook

**For:** Korakot + ops team
**Last updated:** 2026-05-14
**Owner:** [SEPOS-029](../SEPOS-029-client-onboarding.md)

---

## What this handbook is

The step-by-step runbook for taking a new restaurant from **"yes, sign me up"** to **fully live** on SiamEPOS.

The new-client wizard in the back-office automates the data side (creating the client row, generating sync keys, sending welcome emails, downloading staff seed SQL). The infrastructure side (Railway clone, Netlify deploy, DNS) is still manual in Phase 1 — this handbook walks through that part.

**Time budget**: ~30 minutes per client when nothing surprises you. Most of that is waiting for builds.

---

## Quick map

```
┌─────────────────────────────────────────────────────────────┐
│  1. Wizard (5 min)        ──── data side, fully automated   │
│  2. Railway clone (8 min)                                   │
│  3. Netlify deploy (5 min)                                  │
│  4. DNS cutover (5 min)                                     │  ← manual
│  5. Run seed SQL (2 min)                                    │
│  6. Menu import (5 min)                                     │
│  7. Send installer + secret to owner (2 min)                │
│  8. Tick off checklist → status auto-flips to LIVE          │
└─────────────────────────────────────────────────────────────┘
```

---

## Before you start

You will need:

- ✅ Owner's full details (restaurant name, email, phone, VAT number, address)
- ✅ Their preferred subdomain — e.g. `bangkok` → `bangkok.siamepos.co.uk`
- ✅ Either **their own Brevo API key** (preferred — emails come from their domain) OR confirm with them you'll use SiamEPOS's shared key for trial
- ✅ Access to:
  - Railway (`railway.com` → SiamEPOS workspace)
  - Netlify (`app.netlify.com` → SiamEPOS team)
  - Domain registrar with control over `siamepos.co.uk` DNS (currently Namecheap)
- ✅ The latest desktop installer link: `https://github.com/kongponsrisiri-coder/restaurant-epos/releases/latest`

> 💡 **First time?** Make a fake "Test Kitchen" client and walk the whole flow once before doing it for a real customer. Delete the test row from the dashboard when you're done — it's a clean delete with CASCADE on all foreign keys.

---

## Step 1 — Run the wizard

Go to **`ops.siamepos.co.uk`** → Dashboard → **🚀 Onboard new client**.

Fill the 5 steps:

| Step | What to fill in | Notes |
|---|---|---|
| **1. Restaurant** | Name, owner, email, phone, VAT, address, plan | Owner email is required — that's where the welcome email lands |
| **2. Tech setup** | Subdomain slug (auto-fills from name — edit if needed), Brevo + Anthropic keys, feature toggles | Skip the keys if they don't have them — you can add later from the Setup tab |
| **3. Stripe** | Nothing to do unless takeaway is on | SEPOS-040 will automate this |
| **4. PINs** | Owner PIN + chef PIN + waiter PIN (4–6 digits) | Defaults are 9999 / 1111 / 2222 — change for real clients |
| **5. Review** | One last check, then **Create + send welcome email** | |

**What happens on submit:**

- A row is INSERTed in `back_office.clients` with `status='setup'`
- A fresh 32-byte hex `SYNC_SECRET` is generated and stored on the client row
- The welcome email is queued via Brevo (or stubbed if `BREVO_API_KEY` isn't on the back-office service — see [Troubleshooting](#troubleshooting))
- The success card shows you the SYNC_SECRET — **copy it now** if the owner is going to use the desktop app

> 🔐 **SYNC_SECRET is critical.** It's also retrievable later from the client's **📋 Onboarding tab** — but the owner's desktop app needs this same value in their `config.json` or syncing won't work.

---

## Step 2 — Clone the Railway backend

Open the **template Railway project** (`restaurant-epos`) → click **⋯** → **Duplicate Project**.

Rename it: `restaurant-epos-{slug}` — e.g. `restaurant-epos-bangkok`.

Wait for the initial Postgres provision + first deploy (~5 min). Watch the deploy logs for `Server listening on 3001`.

### Set the env vars

Open the new project → **Variables** tab. Set everything below:

```bash
# Always required
DATABASE_URL              # auto-set by Railway when you added Postgres
SYNC_SECRET               # PASTE FROM WIZARD — must match config.json on desktop
BREVO_API_KEY             # their own Brevo key (or yours for trial)
RESTAURANT_NAME           # for booking + receipt emails
RESTAURANT_EMAIL          # owner email
RESTAURANT_ADDRESS        # short version for email signatures
PUBLIC_API_URL            # https://restaurant-epos-{slug}.up.railway.app
UNSUB_SECRET              # 32 hex chars — generate with: openssl rand -hex 16
ANTHROPIC_API_KEY         # for AI menu scanner (theirs or SiamEPOS's)

# Optional — Make.com webhooks for CRM automation
MAKE_BOOKING_WEBHOOK
MAKE_LAPSED_WEBHOOK
MAKE_BOOKING_COMPLETED_WEBHOOK
MAKE_BIRTHDAY_WEBHOOK     # wired but no-op until DOB capture lands
```

> ⚠️ **PUBLIC_API_URL must be set before the first booking email fires** — unsubscribe links are built from it. If it's missing, customers can't unsubscribe and you'll be GDPR-exposed.

Once everything's set, the service should restart and log:

```
[ops-api] env check:
  DATABASE_URL             ✓ set (host=…)
  SYNC_SECRET              ✓ set (64 chars)
  ...
✅ SiamEPOS server listening on 3001
```

Tick **Railway backend cloned + env vars set** in the back-office Onboarding tab.

---

## Step 3 — Deploy the Netlify frontend

In the SiamEPOS Netlify team, click **Add new site** → **Import from existing repo**.

- Repository: `kongponsrisiri-coder/restaurant-epos`
- Branch: `main`
- Base directory: `client`
- Build command: `npm run build`
- Publish directory: `client/dist`

After it imports, go to **Site configuration → Environment variables** and add:

```
VITE_API_URL = https://restaurant-epos-{slug}.up.railway.app
```

Then **Deploys → Trigger deploy → Deploy site**.

Site goes live at `random-name.netlify.app` first. We'll point the subdomain in the next step.

Tick **Netlify frontend deployed**.

---

## Step 4 — Point the subdomain

In the new Netlify site → **Domain management → Add a domain alias**.

Add: `{slug}.siamepos.co.uk` (e.g. `bangkok.siamepos.co.uk`).

Netlify will tell you which DNS record to add. Usually:

```
Type: CNAME
Host: {slug}
Value: random-name.netlify.app
TTL:   3600
```

Open **Namecheap** → `siamepos.co.uk` → **Advanced DNS** → Add new record with the values above. Save.

DNS propagates in 5–30 minutes. Check with:

```bash
dig {slug}.siamepos.co.uk CNAME +short
```

When you see the netlify hostname returned, you're good. Netlify auto-provisions the Let's Encrypt SSL cert ~2 min after DNS resolves.

Tick **Subdomain DNS pointed at Netlify**.

---

## Step 5 — Seed the database

On the client's **📋 Onboarding tab**, click:

- **⬇ staff_seed.sql** — downloads with owner / chef / waiter PINs filled in
- **⬇ settings_seed.sql** — UK defaults (VAT 20%, service 12.5% disabled, £ currency, 2h booking lead)

Open the new Railway project → Postgres add-on → **Data** tab → **Query**.

Paste each SQL file and run. You should see two `INSERT 0 N` rows per file (or `INSERT 0 0` if a row already existed — `ON CONFLICT DO NOTHING` handles re-runs safely).

Verify the owner can log in:

```bash
curl -X POST https://{slug}.siamepos.co.uk/api/staff/login \
  -H 'Content-Type: application/json' \
  -d '{"pin":"<owner_pin>"}'
```

Should return `{"id":1,"name":"<owner>","role":"admin"}`.

Tick **Staff seed SQL run** and **Settings seed SQL run**.

---

## Step 6 — Menu import

Two options. Pick whichever's faster for the customer.

### Option A — AI menu scanner (preferred)

1. Have the customer email you a clear photo or PDF of their existing menu
2. Open `{slug}.siamepos.co.uk` → log in as owner → **Admin → Menu → 📸 Scan Menu**
3. Upload the file → Claude extracts categories + items + prices
4. Review on screen, fix anything wrong, hit **Import**

Usually takes ~30s for a 50-item menu. AI is good at categories + names + prices; it's less reliable on modifier groups, so add those manually.

### Option B — Manual entry

For tiny menus (<20 items) or if AI scan fails, type them in via **Admin → Menu**.

Either way, set:

- Each item's **VAT rate** (default 20%, lower for cold takeaway food)
- **is_bar** flag on Drinks category if they have one (so it routes to Bar screen not Kitchen)
- **default_course** per category (Starters = 1, Mains = 2, Desserts = 3)

Tick **Menu imported**.

---

## Step 7 — Stripe Connect (only if takeaway is on)

> Skip this entire step if the client doesn't want online takeaway. SEPOS-040 will fully automate this — for now it's manual.

1. Sign them up for a **Standard Stripe Connect account** at `dashboard.stripe.com`
2. Copy their `acct_…` ID into the client's **Setup → Online takeaway / payments → Stripe Connect account ID**
3. In their Stripe dashboard → **Developers → API keys**, copy:
   - `pk_live_…` → Railway env `STRIPE_PK_LIVE`
   - `sk_live_…` → Railway env `STRIPE_SK_LIVE`
4. Restart the Railway service

Test by placing a £0.50 mock order on `{slug}.siamepos.co.uk/takeaway-widget.js` — should hit Stripe in test mode first.

Tick **Stripe Connect linked**.

---

## Step 8 — Send the desktop installer

If the owner asked for the **SiamEPOS Pro desktop app** (Mac DMG or Windows EXE), send them:

- Direct link: `https://github.com/kongponsrisiri-coder/restaurant-epos/releases/latest`
- The **SYNC_SECRET** from their Onboarding tab (📋 → 🔐 Show → Copy)
- A note that on first launch the wizard will ask for:
  - Restaurant name → matches what's in the wizard
  - Cloud API URL → `https://restaurant-epos-{slug}.up.railway.app`
  - Restaurant ID → `siamepos` (default — or their slug)
  - SYNC_SECRET → paste the value

> 🔐 **The SYNC_SECRET on the Mac MUST match the Railway env var.** If they don't match, deletes and bill history won't sync to cloud and the in-app banner will warn the operator.

Tick **Desktop installer + SYNC_SECRET sent to owner**.

---

## Done

When all 8 checkboxes are ticked:

- Status flips from **Setup** → **Live** automatically
- `go_live_date` is stamped on `clients.metadata.onboarding`
- The hero on the client detail page shows a green ✓ Live pill

🎉 You're done. Bookmark their Railway + Netlify URLs in your password manager for future support.

---

## Troubleshooting

### Welcome email never arrived

- Check `BREVO_API_KEY` is set on the **back-office** Railway service (not just the tenant's). The welcome-from-SiamEPOS email uses SiamEPOS's Brevo account.
- Look at the back-office Railway logs for `[welcomeEmail] STUB` — that means the key is missing.
- Check the owner's spam folder. Brevo sometimes lands in spam on first contact.

### Owner can't log in

- Did you run **staff_seed.sql** in Step 5? The default DB is empty.
- Check the PIN in the seed file matches what the owner expects (`SELECT pin, name FROM staff;` in Railway query tab).
- Confirm `is_active = 1` on the staff row.

### "Sync queue backing up" banner on the owner's desktop

- SYNC_SECRET mismatch between their `config.json` and the Railway env. They must match exactly.
- See the Mac → 🔐 banner on Table Map for the diagnostic message.

### DNS not resolving after 30 min

- Check the CNAME record on Namecheap is exactly the random Netlify hostname (not your tenant's railway URL).
- DNS cache: `dig +trace {slug}.siamepos.co.uk` shows the real propagation status.
- If still stuck after an hour, delete + re-add the CNAME — usually fixes it.

### Stuck order on cloud after desktop delete

- Likely SYNC_SECRET mismatch. See the desktop Onboarding banner.
- Workaround: delete the order again from the cloud (Chrome) → cloud and Mac will reconcile on next sync.

### "Status didn't flip to Live"

- All 8 checkboxes must be ticked. The status only flips when the last one ticks.
- If you ticked one then unticked it, the auto-flip reverses too — by design.

---

## Files involved

| File | Purpose |
|---|---|
| `back-office/server/routes/clients.js` | Wizard endpoints (`POST /onboard`, `GET/PUT /:id/checklist`, `GET /:id/seed.sql`) |
| `back-office/server/services/welcomeEmail.js` | Welcome email composer (Brevo) |
| `back-office/server/services/quickStartPdf.js` | Owner Quick Start PDF (pdfkit) |
| `back-office/server/db/seed_staff.sql.template` | Staff seed SQL template |
| `back-office/server/db/seed_settings.sql.template` | Settings seed SQL template |
| `back-office/client/src/pages/NewClientWizard.jsx` | 5-step wizard UI |
| `back-office/client/src/pages/ClientDetailPage.jsx` | Onboarding tab + Setup tab |

---

## Phase 2 preview — what we're automating next

These steps are coming in [SEPOS-029 Phase 2](../SEPOS-029-client-onboarding.md):

- **Railway template URL** — clone with one click instead of duplicating from the dashboard
- **`provision-netlify.sh` script** — creates the Netlify site + subdomain + deploys in one command
- **`seed-tenant-db.sh` script** — runs both SQL seeds via `psql` against the new tenant
- **"Provision Now" buttons** on the Onboarding tab that wire the scripts and stream logs live

Once Phase 2 ships, the entire post-wizard flow becomes **5 minutes** instead of 30.

Phase 3 (much later) puts the wizard on the public siamepos.co.uk site so customers can self-onboard with Stripe checkout.

---

*Questions / corrections — message Krit, or open a PR on `SEPOS-029-client-onboarding.md`.*
