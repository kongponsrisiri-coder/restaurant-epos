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
const {
  seedTenantDatabase,
  provisionNetlifyTenant,
  buildRailwayTemplateUrl,
} = require('../services/provisioning');

const router = express.Router();
router.use(authRequired);

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
];

function defaultOnboardingState() {
  const out = {};
  for (const s of ONBOARDING_STEPS) out[s.key] = false;
  out.go_live_date = null;
  return out;
}

// Tiny templating helper for seed files — replaces {{placeholders}}.
function renderTemplate(filePath, vars) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v).replace(/'/g, "''");  // escape SQL single quotes
  });
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
    res.json(r.rows);
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
    } = req.body || {};
    if (!restaurant_name) return res.status(400).json({ error: 'restaurant_name required' });
    const r = await pool.query(
      `INSERT INTO clients (restaurant_name, owner_name, email, phone, railway_url,
                            plan, status, monthly_fee, trial_start, sub_start, next_billing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [restaurant_name, owner_name || null, email || null, phone || null, railway_url || null,
       plan || 'trial', status || 'setup', monthly_fee || null,
       trial_start || null, sub_start || null, next_billing || null]
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
    const [clientRes, healthRes, notesRes] = await Promise.all([
      pool.query('SELECT * FROM clients WHERE id = $1', [id]),
      pool.query('SELECT * FROM health_checks WHERE client_id = $1 ORDER BY checked_at DESC LIMIT 48', [id]),
      pool.query('SELECT * FROM support_notes WHERE client_id = $1 ORDER BY created_at DESC', [id]),
    ]);
    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({
      client: clientRes.rows[0],
      health: healthRes.rows,
      notes:  notesRes.rows,
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

    const r = await pool.query(
      `INSERT INTO clients
         (restaurant_name, owner_name, email, phone, plan, status, monthly_fee, trial_start, metadata)
       VALUES ($1,$2,$3,$4,$5,'setup',$6,$7,$8)
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

    // Auto-flip setup→live once every step is ticked. Stamping the date
    // here so reports can read it directly off the client row.
    const allDone = ONBOARDING_STEPS.every(s => state[s.key]);
    let nextStatus = cur.rows[0].status;
    if (allDone && nextStatus === 'setup') {
      nextStatus = 'live';
      state.go_live_date = new Date().toISOString().slice(0, 10);
    } else if (!allDone && nextStatus === 'live') {
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
      success: true,
      client:    updated.rows[0],
      checklist: buildChecklist(state),
      go_live:   allDone,
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
    const allDone = ONBOARDING_STEPS.every(s => state[s.key]);
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
    const allDone = ONBOARDING_STEPS.every(s => state[s.key]);
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
