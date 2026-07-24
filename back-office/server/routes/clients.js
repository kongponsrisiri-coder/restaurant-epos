// SEPOS-041 — clients CRUD + per-client health timeline.
// SEPOS-029 — onboarding wizard endpoints layered on top.
// All routes require auth. Only admins can delete.

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');
const { sendWelcomeEmail }        = require('../services/welcomeEmail');
const { stripe }                  = require('../services/stripeClient');
const {
  seedTenantDatabase,
  provisionNetlifyTenant,
  buildRailwayTemplateUrl,
} = require('../services/provisioning');

const router = express.Router();
router.use(authRequired);

// ── BO-SLUG-001 helpers ───────────────────────────────────────────────────

const STOP_WORDS = new Set(['the','and','&','restaurant','thai','kitchen',
  'london','takeaway','cafe','bar','house','garden','uk','ltd','limited']);

function generateSlug(name) {
  return (name || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w && !STOP_WORDS.has(w))
    .slice(0, 2)
    .join('-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20) || 'client';
}

// Returns a slug that's unique in the DB — appends -2/-3 etc. if needed.
// Optionally exclude a specific client id (for PUT updates).
async function uniqueSlug(base, excludeId = null) {
  let candidate = base;
  let n = 2;
  while (true) {
    const q = excludeId
      ? await pool.query('SELECT id FROM clients WHERE slug=$1 AND id!=$2', [candidate, excludeId])
      : await pool.query('SELECT id FROM clients WHERE slug=$1', [candidate]);
    if (q.rows.length === 0) return candidate;
    candidate = `${base.slice(0, 17)}-${n++}`;
    if (n > 99) return `${base.slice(0, 14)}-${Date.now().toString().slice(-4)}`; // fallback
  }
}

// SEPOS-029 — the manual-step checklist the operator works through
// after the wizard. Each item maps to a real-world action that can't
// (yet) be fully automated in Phase 1.
const ONBOARDING_STEPS = [
  { key: 'railway_provisioned',     label: 'Railway backend cloned + env vars set' },
  { key: 'netlify_provisioned',     label: 'Netlify frontend deployed' },
  { key: 'dns_pointed',             label: 'Subdomain DNS pointed at Netlify' },
  { key: 'staff_seeded',            label: 'Staff seed SQL run against new Postgres' },
  { key: 'settings_seeded',         label: 'Settings seed SQL run against new Postgres' },
  { key: 'menu_imported',           label: 'Menu imported (AI scanner or manual)' },
  { key: 'stripe_connected',        label: 'Stripe Connect linked (skip if no takeaway)' },
  { key: 'desktop_installer_sent',  label: 'Desktop installer + SYNC_SECRET sent to owner' },
  // SEPOS-SPA-OWNER-001 v2 — provision the owner's remote email+password sign-in
  // (matches the restaurant web-app login). Automated by the "Provision owner
  // login" button → POSTs the tenant's /api/auth/set-credentials. Requires
  // JWT_SECRET (or SETUP_SECRET) set on the tenant Railway first.
  { key: 'owner_access',            label: 'Owner mobile login provisioned (email + password) — needs JWT_SECRET on tenant Railway' },
];

function defaultOnboardingState() {
  const out = {};
  for (const s of ONBOARDING_STEPS) out[s.key] = false;
  out.go_live_date = null;
  return out;
}

// ── SEPOS-SECGATE-001 — Go-live security gate ──────────────────────────────
// A client must NOT flip setup→live until these pass. The AUTH_SECRET check is
// VERIFIED LIVE (we probe the tenant), not merely attested — a checkbox can be
// lied to, a 403 from the tenant cannot. The other two are operator
// attestations for things we can't safely probe from here.
const SECURITY_CHECKS = [
  { key: 'auth_secret',    auto: true,  label: 'Tenant secret set — public default AUTH_SECRET/JWT_SECRET rejected (verified live)' },
  { key: 'admin_pin',      auto: false, label: 'Default 0000 admin PIN changed' },
  { key: 'tokens_revoked', auto: false, label: 'Temporary provisioning / Railway CLI tokens revoked' },
];

// Public default secrets baked into the open-source repos — what the probe uses.
const DEFAULT_SECRETS = {
  restaurant: 'siamepos-dev-auth-secret-change-me',
  spa:        'dev-only-change-me',
};

function defaultSecurityState() {
  const out = {};
  for (const c of SECURITY_CHECKS) out[c.key] = false;
  out.auth_secret_checked_at = null;
  out.auth_secret_detail = null;
  return out;
}

function securityGatePassed(securityState) {
  const s = { ...defaultSecurityState(), ...(securityState || {}) };
  return SECURITY_CHECKS.every(c => s[c.key] === true);
}

function buildSecurityChecklist(securityState) {
  const s = { ...defaultSecurityState(), ...(securityState || {}) };
  return {
    checks: SECURITY_CHECKS.map(c => ({
      key:        c.key,
      label:      c.label,
      auto:       c.auto,
      done:       s[c.key] === true,
      detail:     c.key === 'auth_secret' ? s.auth_secret_detail : null,
      checked_at: c.key === 'auth_secret' ? s.auth_secret_checked_at : null,
    })),
    gate_passed: securityGatePassed(s),
  };
}

// Single source of truth for "ready to go live": every onboarding step done
// AND the security gate passed. Used to GATE the forward setup→live flip
// everywhere (it never demotes an already-live client — that stays driven by
// the onboarding checklist alone).
function goLiveReady(onboardingState, securityState) {
  return ONBOARDING_STEPS.every(s => onboardingState[s.key]) && securityGatePassed(securityState);
}

// Probe a tenant's set-credentials endpoint with the known PUBLIC default
// secret. 403 = default rejected → a real (or random-per-boot) secret is in
// force → PASS. 400/200 = default ACCEPTED → AUTH_SECRET unset/default →
// forgeable tokens → FAIL. Unreachable → unknown (can't pass the gate).
async function probeAuthSecret(url, product) {
  const base = String(url).replace(/\/$/, '');
  const defaults = product && DEFAULT_SECRETS[product]
    ? [DEFAULT_SECRETS[product]]
    : Object.values(DEFAULT_SECRETS); // unknown product → fail if EITHER default works
  for (const secret of defaults) {
    let resp;
    try {
      resp = await fetch(base + '/api/auth/set-credentials', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Setup-Secret': secret },
        body:    '{}',
        signal:  AbortSignal.timeout(10000),
      });
    } catch (e) {
      return { status: 'unknown', pass: false, detail: `Could not reach tenant: ${e.message}` };
    }
    if (resp.status === 404) {
      return { status: 'unknown', pass: false, detail: 'Tenant has no /api/auth/set-credentials route (wrong URL, or an older build).' };
    }
    if (resp.status !== 403) {
      return { status: 'fail', pass: false, detail: `Public default secret ACCEPTED (HTTP ${resp.status}) — AUTH_SECRET/JWT_SECRET is unset or default. Set a unique secret on the tenant Railway, then re-check.` };
    }
  }
  return { status: 'pass', pass: true, detail: 'Public default secret rejected (403) — a real secret is set.' };
}

// Tiny templating helper for seed files — replaces {{placeholders}}.
function renderTemplate(filePath, vars) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v).replace(/'/g, "''");  // escape SQL single quotes
  });
}

// ── SEC-2026-07 — redact tenant secrets from the metadata bag before it
// leaves the server. The bag legitimately holds provisioning credentials
// (sync_secret, tenant DB URL, PINs, API keys, setup/jwt secrets) that the
// UI displays MASKED on the Setup tab — but they were being shipped in full
// to every authenticated ops user (incl. read-only support/viewer roles) and
// for EVERY client in the list. We strip them from the list unconditionally
// and from the detail view for non-admins. Pattern-based so new secret-ish
// keys are caught automatically; benign fields (slugs, urls, account_ref,
// stripe_account_id, pk_live, addresses, onboarding flags) are preserved.
const SECRET_META_RE = /secret|password|(^|_)pin$|(^|_)sk_|sk_live|sk_test|api[_-]?key|database_url|(^|_)token$|jwt|webhook|admin_login/i;
function redactMetadata(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const k of Object.keys(meta)) {
    out[k] = SECRET_META_RE.test(k) ? '••••••••' : meta[k];
  }
  return out;
}

// List all clients with their LATEST health-check row joined in. One round
// trip — DISTINCT ON gives us the most recent row per client_id.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
             h.is_online      AS last_is_online,
             h.response_ms    AS last_response_ms,
             h.orders_today   AS last_orders_today,
             h.last_order_at  AS last_order_at,
             h.checked_at     AS last_checked_at
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT * FROM health_checks
        WHERE client_id = c.id
        ORDER BY checked_at DESC
        LIMIT 1
      ) h ON TRUE
      ORDER BY c.created_at DESC
    `);
    // SEC-2026-07 — never ship tenant secrets in the all-clients list.
    res.json(r.rows.map(row => (row && row.metadata) ? { ...row, metadata: redactMetadata(row.metadata) } : row));
  } catch (err) {
    console.error('[ops-clients] list error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      restaurant_name, owner_name, email, phone, railway_url,
      plan, status, monthly_fee, trial_start, sub_start, next_billing,
      product, slug: slugInput,
    } = req.body || {};
    if (!restaurant_name) return res.status(400).json({ error: 'restaurant_name required' });
    const slug = await uniqueSlug(slugInput || generateSlug(restaurant_name));
    const r = await pool.query(
      `INSERT INTO clients (restaurant_name, owner_name, email, phone, railway_url,
                            plan, status, monthly_fee, trial_start, sub_start, next_billing, product, slug)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [restaurant_name, owner_name || null, email || null, phone || null, railway_url || null,
       plan || 'trial', status || 'setup', monthly_fee || null,
       trial_start || null, sub_start || null, next_billing || null,
       product || 'restaurant', slug]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[ops-clients] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [clientRes, healthRes, notesRes, tillsRes] = await Promise.all([
      pool.query('SELECT * FROM clients WHERE id = $1', [id]),
      pool.query('SELECT * FROM health_checks WHERE client_id = $1 ORDER BY checked_at DESC LIMIT 48', [id]),
      pool.query('SELECT * FROM support_notes WHERE client_id = $1 ORDER BY created_at DESC', [id]),
      // SEPOS-PRO-009 — desktop tills reported by this client's install(s).
      pool.query('SELECT device_id, app_version, platform, last_seen FROM client_tills WHERE client_id = $1 ORDER BY last_seen DESC', [id]),
    ]);
    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    // SEC-2026-07 — only admins see the raw provisioning secrets on the Setup
    // tab; support/viewer roles get them masked. Admins (e.g. Korakot) keep the
    // full setup/credentials workflow unchanged.
    const clientRow = clientRes.rows[0];
    if (!(req.user && req.user.role === 'admin') && clientRow.metadata) {
      clientRow.metadata = redactMetadata(clientRow.metadata);
    }
    res.json({
      client: clientRow,
      health: healthRes.rows,
      notes:  notesRes.rows,
      tills:  tillsRes.rows,
    });
  } catch (err) {
    console.error('[ops-clients] detail error', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Whitelisted updatable fields — keeps the endpoint safe from
    // arbitrary column injection via the request body.
    const allowed = [
      'restaurant_name', 'owner_name', 'email', 'phone', 'railway_url',
      'plan', 'status', 'monthly_fee', 'trial_start', 'sub_start', 'next_billing',
      'metadata',  // SEPOS-WEB-002 — flexible setup / credentials bag.
      'product',   // BO-SPA-001 — 'restaurant' | 'spa'
      'slug',      // BO-SLUG-001 — subdomain slug
    ];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        let val = req.body[k];
        if (k === 'metadata') val = JSON.stringify(val || {});
        else if (val === '') val = null;
        params.push(val);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no updatable fields supplied' });
    params.push(id);
    const r = await pool.query(
      `UPDATE clients SET ${sets.join(',')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[ops-clients] update error', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ops-clients] delete error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── BO-FOUNDER-002 — cancel a client's Stripe subscription ─────────
// Cancels the recurring subscription in Stripe and marks the client churned.
// Admin only. Idempotent-ish: if the subscription is already gone in Stripe
// we still flip the local status so the dashboard ends up correct.
router.post('/:id/cancel-subscription', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      'SELECT id, restaurant_name, stripe_subscription_id FROM clients WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    const subId = rows[0].stripe_subscription_id;
    if (!subId) {
      return res.status(400).json({
        error: 'No Stripe subscription on file for this client. If they pay another way, set the status manually.',
      });
    }

    let stripeResult = 'canceled';
    try {
      await stripe().subscriptions.cancel(subId);
    } catch (err) {
      // resource_missing → already cancelled/deleted in Stripe. Anything else
      // is a real failure we should surface rather than silently churn.
      if (err.code === 'resource_missing') {
        stripeResult = 'already_gone';
      } else {
        console.error('[ops-clients] stripe cancel error', err.message);
        return res.status(502).json({ error: `Stripe cancel failed: ${err.message}` });
      }
    }

    const upd = await pool.query(
      `UPDATE clients SET status = 'churned' WHERE id = $1
       RETURNING id, restaurant_name, status, stripe_subscription_id`,
      [id]
    );
    res.json({ success: true, stripe: stripeResult, client: upd.rows[0] });
  } catch (err) {
    console.error('[ops-clients] cancel-subscription error', err);
    res.status(500).json({ error: err.message });
  }
});

// BO-BILLING-001 — create a Stripe Checkout link for a client's subscription.
// Covers both flows: send the URL to a remote client, OR open it on your iPad
// on-site and enter their card there. On payment, the webhook
// (checkout.session.completed) writes the Stripe ids back to this client row
// and flips them to 'active'. Skippable — nothing is charged until they pay.
// Legacy env-var → price mapping. Still honoured for existing plan keys, but
// plans are now primarily discovered LIVE from Stripe (see GET /billing/plans
// and resolvePriceId) so adding a product in Stripe needs no code/env change.
const BILLING_PLAN_PRICE = {
  pro:           process.env.STRIPE_PRICE_PRO,
  founder:       process.env.STRIPE_PRICE_FOUNDER,
  lite_booking:  process.env.STRIPE_PRICE_LITE_BOOKING,
  lite_ordering: process.env.STRIPE_PRICE_LITE_ORDERING,
  lite_bundle:   process.env.STRIPE_PRICE_LITE_BUNDLE,
  spa:           process.env.STRIPE_PRICE_SPA,
  test:          process.env.STRIPE_PRICE_TEST,
};

// Resolve a plan value to a Stripe price id, most specific first:
//   1. it already IS a price id ("price_…")   2. a Stripe lookup_key
//   3. a legacy env-mapped key                 → else null (caller 400s)
async function resolvePriceId(plan) {
  if (!plan) return null;
  const v = String(plan);
  if (v.startsWith('price_')) return v;
  try {
    const r = await stripe().prices.list({ lookup_keys: [v], active: true, limit: 1 });
    if (r.data[0]) return r.data[0].id;
  } catch (e) { console.warn('[billing] lookup_key resolve failed:', e.message); }
  return BILLING_PLAN_PRICE[v] || null;
}

// GET /api/clients/billing/plans — live list of billable plans straight from
// Stripe. Adding a recurring product/price in Stripe makes it appear here (and
// in the ops dropdowns) automatically. Two-segment path can't collide with the
// one-segment /:id routes.
router.get('/billing/plans', async (req, res) => {
  try {
    const r = await stripe().prices.list({ active: true, type: 'recurring', limit: 100, expand: ['data.product'] });
    const plans = r.data
      .filter(p => p.product && p.product.active !== false && p.unit_amount != null)
      .map(p => ({
        value:    p.lookup_key || p.id,      // stored on the client + sent to checkout-link
        price_id: p.id,
        name:     (p.product && p.product.name) || p.nickname || p.id,
        amount:   p.unit_amount,             // pence
        currency: p.currency,
        interval: p.recurring && p.recurring.interval,
      }))
      .sort((a, b) => (a.amount || 0) - (b.amount || 0));
    res.json({ plans });
  } catch (err) {
    console.error('[ops-clients] billing/plans error', err.message);
    res.status(500).json({ error: err.message || 'Could not load plans from Stripe' });
  }
});

router.post('/:id/billing/checkout-link', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      'SELECT id, restaurant_name, owner_name, email, plan FROM clients WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = rows[0];

    const plan = (req.body && req.body.plan) || client.plan;
    const priceId = await resolvePriceId(plan);
    if (!priceId) {
      return res.status(400).json({
        error: `No Stripe price found for plan "${plan}". Create a recurring product in Stripe (optionally give it lookup_key "${plan}") — it'll appear in the plan list automatically.`,
      });
    }

    const base = process.env.OPS_PUBLIC_URL || 'https://ops.siamepos.co.uk';
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: client.email || undefined,
      client_reference_id: String(id),
      metadata: { client_id: String(id), plan },
      subscription_data: { metadata: { client_id: String(id), plan } },
      success_url: `${base}/clients/${id}?paid=1`,
      cancel_url:  `${base}/clients/${id}?paid=0`,
    });

    res.json({ url: session.url, plan });
  } catch (err) {
    console.error('[ops-clients] checkout-link error', err.message);
    res.status(500).json({ error: err.message || 'Could not create payment link' });
  }
});

// BO-BILLING-001 — link an EXISTING Stripe subscription (created outside ops,
// e.g. by hand in the dashboard) to this client, matched by the client's email.
// Fixes clients billed before the payment-link flow — their row had no Stripe
// ids so ops showed "no subscription". Writes the ids (+ next billing) only;
// leaves the client's status untouched so the go-live label isn't disturbed.
router.post('/:id/billing/link-subscription', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query('SELECT id, email FROM clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const email = rows[0].email;
    if (!email) return res.status(400).json({ error: 'Client has no email to match against Stripe.' });

    const s = stripe();
    const customers = await s.customers.list({ email, limit: 20 });
    let found = null, customerId = null;
    for (const c of customers.data) {
      const subs = await s.subscriptions.list({ customer: c.id, status: 'all', limit: 20 });
      const live = subs.data.find(su => ['active', 'trialing', 'past_due'].includes(su.status));
      if (live) { found = live; customerId = c.id; break; }
    }
    if (!found) {
      return res.status(404).json({ error: `No active Stripe subscription found for ${email}. Check the customer's email in Stripe matches this client.` });
    }

    // current_period_end lives on the sub (older APIs) or its first item (newer).
    const periodEnd = found.current_period_end
      || (found.items && found.items.data && found.items.data[0] && found.items.data[0].current_period_end);
    const nextBilling = periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null;

    const upd = await pool.query(
      `UPDATE clients SET stripe_customer_id = $2, stripe_subscription_id = $3,
         next_billing = COALESCE($4, next_billing),
         sub_start = COALESCE(sub_start, CURRENT_DATE)
       WHERE id = $1 RETURNING id, restaurant_name`,
      [id, customerId, found.id, nextBilling]
    );
    res.json({ linked: true, client: upd.rows[0], subscription_id: found.id, customer_id: customerId });
  } catch (err) {
    console.error('[ops-clients] link-subscription error', err.message);
    res.status(500).json({ error: err.message || 'Could not link subscription' });
  }
});

// ── SEPOS-029 — onboarding wizard endpoints ────────────────────────

/**
 * Kick off a new tenant.
 *
 * Inserts a clients row in status='setup', generates a fresh SYNC_SECRET,
 * populates metadata.onboarding with an unticked checklist, and fires the
 * welcome email (stubbed in chunk 1 — sends for real after chunk 5).
 *
 * Wizard-only fields land in clients.metadata as a flat bag so we don't
 * have to ALTER TABLE for every new question we ever want to ask.
 */
router.post('/onboard', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.restaurant_name?.trim()) {
      return res.status(400).json({ error: 'restaurant_name required' });
    }
    if (b.owner_email && !/^\S+@\S+\.\S+$/.test(b.owner_email)) {
      return res.status(400).json({ error: 'owner_email looks invalid' });
    }

    // Generate the sync key now so it can be surfaced in the wizard's
    // Step 5 immediately AND stored on the client row for retrieval.
    const syncSecret = (b.sync_secret && b.sync_secret.length >= 16)
      ? b.sync_secret
      : crypto.randomBytes(32).toString('hex');

    // Auto-slug from restaurant_name if not supplied. We only use this
    // for display ("your subdomain will be …") — Netlify automation
    // lands in Phase 2.
    const subdomainSlug = (b.subdomain_slug || b.restaurant_name)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const metadata = {
      // surfaced + retrievable from the ClientDetail Onboarding tab
      sync_secret:        syncSecret,
      subdomain_slug:     subdomainSlug,
      // wizard inputs we want to keep around
      vat_number:         b.vat_number  || null,
      full_address:       b.address     || null,
      owner_pin:          b.owner_pin   || '9999',
      chef_pin:           b.chef_pin    || '1111',
      waiter_pin:         b.waiter_pin  || '2222',
      has_takeaway:       !!b.has_takeaway,
      has_reservations:   b.has_reservations !== false,  // default on
      has_inventory:      !!b.has_inventory,
      brevo_api_key:      b.brevo_api_key     || null,
      anthropic_api_key:  b.anthropic_api_key || null,
      onboarding:         defaultOnboardingState(),
    };

    const slug = await uniqueSlug(b.subdomain_slug || generateSlug(b.restaurant_name));

    const r = await pool.query(
      `INSERT INTO clients
         (restaurant_name, owner_name, email, phone, plan, status, monthly_fee, trial_start, metadata, product, slug)
       VALUES ($1,$2,$3,$4,$5,'setup',$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        b.restaurant_name.trim(),
        b.owner_name?.trim() || null,
        b.owner_email?.trim() || null,
        b.phone?.trim() || null,
        b.plan || 'trial',
        b.monthly_fee || null,
        b.trial_start_date || null,
        JSON.stringify(metadata),
        b.product || 'restaurant',
        slug,
      ]
    );
    const client = r.rows[0];

    // Fire-and-don't-await the welcome email. Stub right now; chunk 5
    // wires the real Brevo call. We deliberately don't block the
    // wizard response on email — the operator sees the success card
    // immediately and the email lands separately.
    sendWelcomeEmail(client).catch(err => console.warn('[clients/onboard] welcome email failed:', err.message));

    res.status(201).json({
      success: true,
      client,
      sync_secret: syncSecret,
      checklist:   buildChecklist(metadata.onboarding),
    });
  } catch (err) {
    console.error('[ops-clients] onboard error', err);
    res.status(500).json({ error: err.message });
  }
});

function buildChecklist(onboardingState) {
  return ONBOARDING_STEPS.map(s => ({
    key:     s.key,
    label:   s.label,
    done:    !!onboardingState[s.key],
  }));
}

/**
 * Fetch the onboarding checklist for a client. Returns the canonical
 * step definitions joined with the per-client done flags so the UI
 * doesn't have to know the step list itself.
 */
router.get('/:id/onboarding-checklist', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT id, restaurant_name, status, metadata FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const c = r.rows[0];
    const state = (c.metadata && c.metadata.onboarding) || defaultOnboardingState();
    res.json({
      client_id:     c.id,
      restaurant:    c.restaurant_name,
      status:        c.status,
      go_live_date:  state.go_live_date,
      checklist:     buildChecklist(state),
      security:      buildSecurityChecklist(c.metadata && c.metadata.security),
    });
  } catch (err) {
    console.error('[ops-clients] checklist read error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tick (or untick) an onboarding step. When the last unticked step
 * flips to done, the client's status auto-moves setup → live and
 * go_live_date is stamped.
 */
router.put('/:id/checklist', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { key, done } = req.body || {};
    if (!key || !ONBOARDING_STEPS.find(s => s.key === key)) {
      return res.status(400).json({ error: 'unknown checklist key' });
    }

    const cur = await pool.query('SELECT metadata, status FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const metadata = cur.rows[0].metadata || {};
    const state = { ...defaultOnboardingState(), ...(metadata.onboarding || {}) };
    state[key] = !!done;

    // Auto-flip setup→live once every step is ticked AND the security gate
    // passes (SEPOS-SECGATE-001). Forward flip needs both; the back-out to
    // setup stays driven by the onboarding checklist alone, so the gate never
    // surprise-demotes an already-live client.
    const onboardingDone = ONBOARDING_STEPS.every(s => state[s.key]);
    const ready = goLiveReady(state, metadata.security);
    let nextStatus = cur.rows[0].status;
    if (ready && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = new Date().toISOString().slice(0, 10);
    } else if (!onboardingDone && nextStatus === 'live') {
      // Untick takes us back to setup — defensive in case ops mis-clicks.
      nextStatus = 'setup';
      state.go_live_date = null;
    }
    metadata.onboarding = state;

    const updated = await pool.query(
      `UPDATE clients SET metadata = $1, status = $2 WHERE id = $3 RETURNING *`,
      [JSON.stringify(metadata), nextStatus, id]
    );
    res.json({
      success:   true,
      client:    updated.rows[0],
      checklist: buildChecklist(state),
      security:  buildSecurityChecklist(metadata.security),
      go_live:   ready,
      // Help the UI explain "all steps ticked but still not live".
      blocked_by_security: onboardingDone && !securityGatePassed(metadata.security),
    });
  } catch (err) {
    console.error('[ops-clients] checklist update error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-029 Phase 2 — automated DB seeding.
// POST /:id/provision/seed-db connects to the tenant's Postgres via
// the URL stored in clients.metadata.tenant_database_url and runs
// the same staff + settings SQL the /seed.sql download produces.
// On success it ticks staff_seeded + settings_seeded automatically.
router.post('/:id/provision/seed-db', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = cur.rows[0];
    const m = client.metadata || {};
    const databaseUrl = m.tenant_database_url || req.body?.database_url || null;

    const result = await seedTenantDatabase(databaseUrl, client);
    if (!result.ok) {
      return res.status(400).json({ error: result.error, hint: result.hint });
    }

    // Auto-tick the two seed checklist items.
    const state = { ...defaultOnboardingState(), ...(m.onboarding || {}) };
    state.staff_seeded    = true;
    state.settings_seeded = true;
    const allDone = goLiveReady(state, m.security);  // SEPOS-SECGATE-001 — gate on security too
    let nextStatus = client.status;
    if (allDone && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = new Date().toISOString().slice(0, 10);
    }
    m.onboarding = state;
    await pool.query(
      `UPDATE clients SET metadata = $1, status = $2 WHERE id = $3`,
      [JSON.stringify(m), nextStatus, id]
    );

    res.json({
      success:  true,
      details:  result.details,
      checklist: buildChecklist(state),
    });
  } catch (err) {
    console.error('[ops-clients] provision seed-db error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-WEB-004 — proxy the tenant's live menu for the Website
// Builder. Browser can't fetch the tenant's railway URL directly
// (CORS), so the back-office does the round-trip server-side. The
// operator then picks 6–8 items to feature on the generated home page.
//
// Returns a flat list of { id, name, name_alt, description, price,
// photo, category } — only what the website needs.
router.get('/:id/menu-preview', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT metadata FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const url = r.rows[0].metadata?.tenant_railway_url;
    if (!url) {
      return res.status(400).json({
        error: 'Tenant Railway URL not set on this client',
        hint:  'Paste the URL into Setup → Tenant infrastructure → Railway service URL.',
      });
    }
    const resp = await fetch(url.replace(/\/$/, '') + '/api/menu', {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return res.status(502).json({ error: `Tenant API ${resp.status}` });
    const cats = await resp.json();
    // Flatten + project — the builder only needs a small subset of fields.
    const items = [];
    for (const cat of (Array.isArray(cats) ? cats : [])) {
      for (const item of (cat.items || [])) {
        items.push({
          id:          item.id,
          name:        item.name,
          name_alt:    item.name_alt || null,
          description: item.description || null,
          price:       Number(item.price) || 0,
          photo:       item.photo_url || item.image_url || null,
          category:    cat.name,
        });
      }
    }
    res.json({ items });
  } catch (err) {
    console.error('[ops-clients] menu-preview error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-029 Phase 2 — Railway template deep-link.
// Operator clicks this on the Onboarding tab and Railway opens with
// all template variables pre-filled (SYNC_SECRET / BREVO / Anthropic /
// restaurant identity). They click Deploy once on Railway, come back,
// paste the new service URL + DATABASE_URL into Setup → Tenant
// infrastructure, then run the Netlify + Seed buttons.
router.get('/:id/provision/railway-template', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const url = buildRailwayTemplateUrl(cur.rows[0]);
    if (!url) {
      return res.status(503).json({
        error: 'RAILWAY_TEMPLATE_URL not configured on the back-office service',
        hint:  'Create the template once at railway.com → New project → Template, then set RAILWAY_TEMPLATE_URL on the back-office Railway service.',
      });
    }
    res.json({ url });
  } catch (err) {
    console.error('[ops-clients] railway-template error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-029 Phase 2 — Netlify automation.
// POST /:id/provision/netlify creates the site, sets VITE_API_URL,
// attaches the {slug}.siamepos.co.uk subdomain, and ticks
// netlify_provisioned + dns_pointed on success. SSL is requested
// best-effort and stamped on the response.
router.post('/:id/provision/netlify', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = cur.rows[0];

    const result = await provisionNetlifyTenant(client);
    if (!result.ok) {
      return res.status(400).json({ error: result.error, hint: result.hint });
    }

    // Persist the new Netlify URL + tick the two relevant checklist
    // items. railway_provisioned + the rest are still manual.
    const m = client.metadata || {};
    m.tenant_netlify_url = m.tenant_netlify_url || result.details.url;
    m.netlify_site_id    = result.details.site_id;
    const state = { ...defaultOnboardingState(), ...(m.onboarding || {}) };
    state.netlify_provisioned = true;
    state.dns_pointed         = true;   // custom_domain on site-create handles the CNAME side
    m.onboarding = state;
    const allDone = goLiveReady(state, m.security);  // SEPOS-SECGATE-001 — gate on security too
    const nextStatus = allDone ? 'live' : client.status;
    if (allDone && client.status === 'setup') state.go_live_date = new Date().toISOString().slice(0, 10);

    await pool.query('UPDATE clients SET metadata = $1, status = $2 WHERE id = $3',
      [JSON.stringify(m), nextStatus, id]);

    res.json({
      success: true,
      details: result.details,
      checklist: buildChecklist(state),
    });
  } catch (err) {
    console.error('[ops-clients] provision netlify error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-SPA-OWNER-001 v2 — provision the owner's remote login (email + password)
// on the tenant by calling its secret-gated POST /api/auth/set-credentials.
// Mirrors the restaurant web-app login so both products work the same way.
//
//   body: { setup_secret?, email?, password?, name? }
//
// The tenant's setup secret is its JWT_SECRET (or a dedicated SETUP_SECRET) —
// set on the tenant Railway FIRST. We read it from client.metadata
// (tenant_setup_secret / tenant_jwt_secret) or accept it once via body. The
// owner email defaults to the client's email on file. A strong temp password is
// generated when one isn't supplied and returned ONCE so the operator can hand
// it to the owner (we never store it).
//
// Pre-req: tenant_railway_url must be set, and the tenant must have a real
// JWT_SECRET/SETUP_SECRET on Railway — otherwise set-credentials uses a random
// per-boot secret and (correctly) rejects every call with 403.
router.post('/:id/provision/owner-login', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = cur.rows[0];
    const m = client.metadata || {};

    const url = m.tenant_railway_url;
    if (!url) {
      return res.status(400).json({
        error: 'Tenant Railway URL not set on this client',
        hint:  'Paste the URL into Setup → Tenant infrastructure → Railway service URL.',
      });
    }
    const setupSecret = req.body?.setup_secret || m.tenant_setup_secret || m.tenant_jwt_secret || '';
    if (!setupSecret) {
      return res.status(400).json({
        error: 'Tenant setup secret missing',
        hint:  'Set JWT_SECRET (or SETUP_SECRET) on the tenant Railway, then paste it here. It is the only key that can provision an owner login.',
      });
    }
    const email = (req.body?.email || client.email || '').trim();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid owner email is required (none on file for this client).' });
    }
    // A strong temp password if the operator didn't choose one. No ambiguous
    // chars; returned once for the operator to relay to the owner.
    const tempPassword = req.body?.password
      || ('Spa-' + crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9));

    let resp, body;
    try {
      resp = await fetch(url.replace(/\/$/, '') + '/api/auth/set-credentials', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Setup-Secret': setupSecret },
        body:    JSON.stringify({ email, password: tempPassword, name: client.owner_name || 'Owner' }),
        signal:  AbortSignal.timeout(10000),
      });
      body = await resp.json().catch(() => ({}));
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach the tenant API', hint: e.message });
    }
    if (resp.status === 403) {
      return res.status(400).json({
        error: 'Tenant rejected the setup secret (403)',
        hint:  'The secret must match JWT_SECRET/SETUP_SECRET on the tenant Railway. If JWT_SECRET is unset, the tenant uses a random per-boot secret — set it on Railway first, then retry.',
      });
    }
    if (!resp.ok) {
      return res.status(502).json({ error: `Tenant set-credentials failed (${resp.status})`, detail: body });
    }

    // Persist the owner email + remember the secret so the operator doesn't
    // have to paste it again, and tick the checklist step.
    m.owner_email = email;
    if (req.body?.setup_secret) m.tenant_setup_secret = req.body.setup_secret;
    const state = { ...defaultOnboardingState(), ...(m.onboarding || {}) };
    state.owner_access = true;
    const allDone = goLiveReady(state, m.security);  // SEPOS-SECGATE-001 — gate on security too
    let nextStatus = client.status;
    if (allDone && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = new Date().toISOString().slice(0, 10);
    }
    m.onboarding = state;
    await pool.query('UPDATE clients SET metadata = $1, status = $2 WHERE id = $3',
      [JSON.stringify(m), nextStatus, id]);

    res.json({
      success:       true,
      email,
      temp_password: tempPassword,   // shown ONCE — relay to the owner, not stored
      tenant_result: body,           // { created, pin } or { updated }
      checklist:     buildChecklist(state),
    });
  } catch (err) {
    console.error('[ops-clients] provision owner-login error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SEPOS-SECGATE-001 — Go-live security gate routes ───────────────────────

// Current gate state (auto + manual checks + overall pass/fail).
router.get('/:id/security', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT metadata FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(buildSecurityChecklist((r.rows[0].metadata || {}).security));
  } catch (err) {
    console.error('[ops-clients] security read error', err);
    res.status(500).json({ error: err.message });
  }
});

// Run the live AUTH_SECRET probe against the tenant + persist the result.
// This is the one check that cannot be hand-ticked — it must be proven.
router.post('/:id/security/verify', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = cur.rows[0];
    const m = client.metadata || {};
    const url = m.tenant_railway_url;
    if (!url) {
      return res.status(400).json({
        error: 'Tenant Railway URL not set on this client',
        hint:  'Paste it into Setup → Tenant infrastructure → Railway service URL.',
      });
    }

    const result = await probeAuthSecret(url, client.product);
    const sec = { ...defaultSecurityState(), ...(m.security || {}) };
    sec.auth_secret            = result.pass;
    sec.auth_secret_checked_at = new Date().toISOString();
    sec.auth_secret_detail     = result.detail;
    m.security = sec;

    // A passing probe can complete the gate → flip setup→live if everything
    // else is done. Never demote here.
    const state = { ...defaultOnboardingState(), ...(m.onboarding || {}) };
    let nextStatus = client.status;
    if (goLiveReady(state, sec) && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = state.go_live_date || new Date().toISOString().slice(0, 10);
      m.onboarding = state;
    }
    await pool.query('UPDATE clients SET metadata = $1, status = $2 WHERE id = $3',
      [JSON.stringify(m), nextStatus, id]);

    res.json({ check: result, ...buildSecurityChecklist(sec) });
  } catch (err) {
    console.error('[ops-clients] security verify error', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle a MANUAL attestation (admin_pin, tokens_revoked). Auto checks are
// rejected here — they can only be proven via /security/verify.
router.put('/:id/security', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { key, value } = req.body || {};
    const def = SECURITY_CHECKS.find(c => c.key === key);
    if (!def) return res.status(400).json({ error: 'unknown security check key' });
    if (def.auto) return res.status(400).json({ error: `'${key}' is verified automatically — use "Run security check"; it can't be ticked by hand.` });

    const cur = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = cur.rows[0];
    const m = client.metadata || {};
    const sec = { ...defaultSecurityState(), ...(m.security || {}) };
    sec[key] = !!value;
    m.security = sec;

    const state = { ...defaultOnboardingState(), ...(m.onboarding || {}) };
    let nextStatus = client.status;
    if (goLiveReady(state, sec) && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = state.go_live_date || new Date().toISOString().slice(0, 10);
      m.onboarding = state;
    } else if (!securityGatePassed(sec) && nextStatus === 'live' && ONBOARDING_STEPS.every(s => state[s.key])) {
      // If the only thing holding the client 'live' was the gate and an
      // attestation is now un-ticked, pull it back to setup.
      nextStatus = 'setup';
      state.go_live_date = null;
      m.onboarding = state;
    }
    await pool.query('UPDATE clients SET metadata = $1, status = $2 WHERE id = $3',
      [JSON.stringify(m), nextStatus, id]);

    res.json(buildSecurityChecklist(sec));
  } catch (err) {
    console.error('[ops-clients] security toggle error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stream the populated staff seed SQL for this tenant. Operator runs
 * it against the new Railway Postgres once the backend is up.
 */
router.get('/:id/seed.sql', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const which = (req.query.kind || 'staff').toLowerCase();
    if (which !== 'staff' && which !== 'settings') {
      return res.status(400).json({ error: 'kind must be staff or settings' });
    }

    const r = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const c = r.rows[0];
    const m = c.metadata || {};

    const file = path.join(__dirname, '..', 'db', `seed_${which}.sql.template`);
    const sql = renderTemplate(file, {
      owner_name:       c.owner_name      || 'Owner',
      owner_email:      c.email           || '',
      restaurant_name:  c.restaurant_name || '',
      address:          m.full_address    || '',
      owner_pin:        m.owner_pin       || '9999',
      chef_pin:         m.chef_pin        || '1111',
      waiter_pin:       m.waiter_pin      || '2222',
    });

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${which}_seed_${m.subdomain_slug || c.id}.sql"`);
    res.send(sql);
  } catch (err) {
    console.error('[ops-clients] seed.sql error', err);
    res.status(500).json({ error: err.message });
  }
});

// Full health timeline (up to 48 most recent checks).
router.get('/:id/health', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM health_checks WHERE client_id = $1 ORDER BY checked_at DESC LIMIT 48',
      [parseInt(req.params.id, 10)]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Notes — read here, mutations on routes/notes.js
router.get('/:id/notes', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM support_notes WHERE client_id = $1 ORDER BY created_at DESC',
      [parseInt(req.params.id, 10)]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id, 10);
    const { category, note } = req.body || {};
    if (!note) return res.status(400).json({ error: 'note required' });
    const r = await pool.query(
      `INSERT INTO support_notes (client_id, created_by, category, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [clientId, req.user.name || req.user.email, category || 'general', note]
    );
    await pool.query(
      'UPDATE clients SET notes_count = (SELECT COUNT(*) FROM support_notes WHERE client_id = $1) WHERE id = $1',
      [clientId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[ops-notes] create error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.generateSlug = generateSlug;
module.exports.uniqueSlug   = uniqueSlug;
