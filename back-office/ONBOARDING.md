# SiamEPOS — Client Onboarding Handbook

**For:** Korakot + ops team
**Last updated:** 2026-05-14
**Owner:** [SEPOS-029](../SEPOS-029-client-onboarding.md)

---

## What this handbook is

The step-by-step runbook for taking a new restaurant from **"yes, sign me up"** to **fully live** on SiamEPOS.

After SEPOS-029 Phase 2 the back-office automates **everything except the Railway click**: one click to seed the database, one click to provision Netlify + subdomain. Manual fallbacks (download seed SQL, paste URLs by hand) are still there for when something doesn't go to plan.

**Time budget**: ~10 minutes per client when nothing surprises you. Most of that is waiting for Railway to build.

---

## Quick map

```
┌──────────────────────────────────────────────────────────────┐
│  0. One-time setup (per ops machine) — see "Before you start"│
│                                                              │
│  1. Wizard (5 min) ──── data side, fully automated           │
│                                                              │
│  2. Open in Railway → Deploy (2–3 min)                       │
│  3. Paste Railway URL + DATABASE_URL into Setup tab          │
│                                                              │
│  4. 🚀 Provision Netlify (one click)                          │
│  5. 🚀 Run seed SQL (one click)                               │
│  6. Menu import + Stripe (still manual)                      │
│  7. Send installer + secret to owner                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Before you start

### One-time setup (do once per back-office install)

These need to land in **back-office Railway → Variables** before the automation works:

| Env var | What it is | Where to get it |
|---|---|---|
| `BREVO_API_KEY` | Sends the welcome email from SiamEPOS HQ | Brevo → SMTP & API → API Keys |
| `NETLIFY_AUTH_TOKEN` | Provisions the tenant Netlify site | Netlify → User settings → Applications → Personal access tokens |
| `NETLIFY_TEAM_SLUG` | *(Optional)* Puts new sites in the SiamEPOS team | Netlify URL: `app.netlify.com/teams/{slug}` |
| `RAILWAY_TEMPLATE_URL` | The "Open in Railway →" deep-link target | See "Creating the Railway template" below |

### Creating the Railway template (do once)

1. In Railway, open the canonical `restaurant-epos` project
2. ⋮ → **Save as template**
3. Mark these as **template variables** (Railway prompts on each deploy):
   `SYNC_SECRET`, `BREVO_API_KEY`, `ANTHROPIC_API_KEY`, `RESTAURANT_NAME`, `RESTAURANT_EMAIL`, `RESTAURANT_ADDRESS`, `UNSUB_SECRET`
4. Save → Railway gives you a URL like `https://railway.app/new/template/abc123`
5. Paste that into back-office env: `RAILWAY_TEMPLATE_URL = https://railway.app/new/template/abc123`

The back-office now builds per-client deep-links with each tenant's secrets pre-filled.

### What you need for each new client

- ✅ Owner's full details (restaurant name, email, phone, VAT, address)
- ✅ Preferred subdomain — e.g. `bangkok` → `bangkok.siamepos.co.uk`
- ✅ Their **Brevo API key** (preferred) OR confirm you'll use yours for trial
- ✅ Access to Namecheap for `siamepos.co.uk` DNS (still manual unless their subdomain is already pointed at Netlify)

---

## Step 1 — Run the wizard

Go to **`ops.siamepos.co.uk`** → Dashboard → **🚀 Onboard new client**.

Fill the 5 steps:

| Step | What | Notes |
|---|---|---|
| 1. Restaurant | Name, owner, email, phone, VAT, address, plan | Owner email is required |
| 2. Tech setup | Subdomain slug (auto-fills), Brevo + Anthropic keys, features | Skip keys if not yet provided |
| 3. Stripe | Nothing unless takeaway is on | SEPOS-040 will automate |
| 4. PINs | Owner / chef / waiter (4–6 digits) | Defaults: 9999 / 1111 / 2222 |
| 5. Review | Confirm + send welcome email | |

**What happens on submit:**

- Client row inserted with `status='setup'`
- 32-byte hex `SYNC_SECRET` generated and stored
- Welcome email goes to the owner via Brevo with Quick Start PDF attached
- Success card shows the SYNC_SECRET — **copy it now** for the desktop install later

> 🔐 The SYNC_SECRET is also retrievable any time from the client's **📋 Onboarding tab**.

---

## Step 2 — Provision Railway (click → deploy)

On the client's **📋 Onboarding tab**, the first card is **Step 1 · Railway backend**.

Click **🚂 Open in Railway →**.

A new tab opens with the SiamEPOS template, every variable pre-filled with this client's values (sync key, restaurant name, Brevo key, etc.). Click Railway's **Deploy** button.

Railway:
- Provisions a Postgres add-on (~30 sec)
- Builds + boots the app (~2 min)

When you see the service log `✅ SiamEPOS server listening on 3001`, you're done with Railway's side.

---

## Step 3 — Paste back the connection strings

In Railway, grab two values:

1. **Service URL** — the auto-generated `…up.railway.app` URL on the service page
2. **`DATABASE_URL`** — Variables tab, click on the Postgres add-on, copy the connection string

In the back office → **🔐 Setup → Tenant infrastructure**, paste:

- **Railway service URL** → the `…up.railway.app` URL
- **Tenant database URL** → the `postgresql://…` connection string

Both save on tab-out.

---

## Step 4 — 🚀 Provision Netlify (one click)

Back on the **📋 Onboarding tab** → **Netlify provisioning** card → click **🚀 Provision Netlify now**.

The back-office calls Netlify's API to:
- Create a new site `siamepos-{slug}`
- Link it to the GitHub repo (`kongponsrisiri-coder/restaurant-epos`, `main` branch, `client/` dir)
- Set `VITE_API_URL` to the Railway URL you just pasted
- Attach the `{slug}.siamepos.co.uk` custom domain
- Request a Let's Encrypt cert

You get back a success card with the live URL + a link to the Netlify admin.

**Netlify auto-ticks** the `netlify_provisioned` + `dns_pointed` checklist items.

> 💡 If the subdomain doesn't already have a CNAME pointing at Netlify, add one on Namecheap (target = the random Netlify hostname, visible in the admin). Netlify won't issue SSL until DNS resolves. ~5 min propagation typically.

---

## Step 5 — 🚀 Run seed SQL (one click)

Same tab → **Database seeds** card → click **🚀 Run seed SQL now**.

The back-office connects to the tenant's Postgres (via the DATABASE_URL you pasted in Step 3) and runs both files in one transaction:

- `staff_seed.sql` — owner / chef / waiter rows with the PINs from the wizard
- `settings_seed.sql` — UK defaults (VAT 20, service 12.5 disabled, £ currency, 2h booking lead)

Both files use `ON CONFLICT DO NOTHING` so re-runs are safe.

Both **`staff_seeded`** + **`settings_seeded`** checklist items auto-tick on success.

> If the run fails, the success card includes a hint (e.g. "Railway hasn't finished provisioning Postgres yet — check the service log first"). Download buttons (⬇ staff_seed.sql, ⬇ settings_seed.sql) still work as a fallback.

---

## Step 6 — Menu import (still manual)

Open the new tenant frontend at `{slug}.siamepos.co.uk` → log in as owner.

**Admin → Menu → 📸 Scan Menu** — upload a photo or PDF of their existing menu. Claude extracts categories + items + prices. Review on screen, fix anything wrong, hit **Import**.

For tiny menus or AI failures, type them in via **Admin → Menu**.

Set per-item:
- VAT rate (default 20%)
- `is_bar` flag on Drinks categories
- `default_course` (Starters 1 / Mains 2 / Desserts 3)

Tick **Menu imported** on the Onboarding tab.

---

## Step 7 — Stripe Connect (only if takeaway is on)

Still manual — SEPOS-040 will automate this. For now:

1. Create a Standard Stripe Connect account for the restaurant
2. Paste their `acct_…` ID into **Setup → Online takeaway / payments → Stripe Connect account ID**
3. Paste their `pk_live_…` + `sk_live_…` into the same section (masked)
4. In their Railway service → Variables, add `STRIPE_PK_LIVE` + `STRIPE_SK_LIVE` matching these values

Tick **Stripe Connect linked**.

---

## Step 8 — Send the desktop installer

If the owner asked for the SiamEPOS Pro desktop app:

- Direct link: `https://github.com/kongponsrisiri-coder/restaurant-epos/releases/latest`
- The **SYNC_SECRET** from their Onboarding tab (🔐 → Show → Copy)
- Note that on first launch the wizard asks for:
  - Restaurant name (matches wizard)
  - Cloud API URL (their Railway service URL)
  - Restaurant ID (`siamepos` default)
  - SYNC_SECRET (paste from above)

Tick **Desktop installer + SYNC_SECRET sent to owner**.

---

## Done

When all 8 boxes are ticked, status flips from **Setup** → **Live** and `go_live_date` is stamped automatically. Hero shows a green ✓ Live pill.

🎉 Bookmark their Railway + Netlify URLs in your password manager for future support.

---

## Troubleshooting

### "Could not connect to the tenant database"
- The DATABASE_URL in Setup is missing or wrong. Copy it again from Railway → Postgres add-on → Connect.
- Railway's Postgres provision can take up to a minute on a busy region — wait, then retry.

### "Netlify 422: name has already been taken"
- Two different clients shouldn't share a slug. Change the subdomain in Setup, retry.
- If the previous failed run partly created a site, delete it from the Netlify dashboard first.

### Netlify provision works but SSL stays pending forever
- DNS isn't resolving yet. Check the CNAME on Namecheap (target = the random `…netlify.app` hostname, not Railway).
- `dig {slug}.siamepos.co.uk CNAME +short` — should return the Netlify hostname.

### Welcome email never arrived
- `BREVO_API_KEY` not set on the **back-office** Railway service (not the tenant's).
- Back-office log line `[welcomeEmail] STUB` confirms it's missing.
- Check spam — Brevo lands there on first contact occasionally.

### "Open in Railway" button errors with 503
- `RAILWAY_TEMPLATE_URL` not set. See **Before you start → Creating the Railway template**.

### Owner can't log in
- Did you run **🚀 Run seed SQL**? The default DB is empty.
- Check `SELECT pin, name FROM staff;` in Railway's query tab.

### "Status didn't flip to Live"
- All 8 boxes must be ticked. Auto-flip only happens when the last one ticks.

---

## What still requires hands

After Phase 2, the genuinely-still-manual steps are:

1. **Initial Railway template setup** — one-time per back-office install
2. **Clicking Deploy on Railway** — Railway doesn't expose a public-template "auto-deploy" API
3. **Pasting the Railway URL + DATABASE_URL back into Setup** — ~30 sec of copy-paste
4. **Menu import** — until we auto-scan in the wizard
5. **Stripe Connect** — until SEPOS-040

Total hands-on time per client is now **~10 minutes** (most of which is the Railway deploy spinner). 90% of the manual work from Phase 1 is gone.

---

## Files involved

| File | Purpose |
|---|---|
| `back-office/server/routes/clients.js` | Wizard + provisioning endpoints |
| `back-office/server/services/provisioning.js` | `seedTenantDatabase`, `provisionNetlifyTenant`, `buildRailwayTemplateUrl` |
| `back-office/server/services/welcomeEmail.js` | Welcome email via Brevo |
| `back-office/server/services/quickStartPdf.js` | Owner Quick Start PDF (pdfkit) |
| `back-office/server/db/seed_*.sql.template` | Staff + settings seed templates |
| `back-office/client/src/pages/NewClientWizard.jsx` | 5-step wizard UI |
| `back-office/client/src/pages/ClientDetailPage.jsx` | Onboarding + Setup tabs |

---

## Phase 3 preview — what's still coming

- **Public signup form on siamepos.co.uk** → hits the same `POST /api/clients/onboard` endpoint
- **Stripe Checkout** for the SiamEPOS subscription itself (separate from per-tenant Stripe Connect for their takeaway)
- **Self-service menu import** via the wizard (no operator needed)
- **DNS automation** — once we're operating on `*.siamepos.co.uk`, ditch Namecheap clicks entirely

---

*Questions or fixes — message Krit, or open a PR on this file.*
