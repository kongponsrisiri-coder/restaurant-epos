// SEPOS-029 Phase 2 — Provisioning services.
//
// Wrappers around the external APIs the back-office needs to drive
// during a new-client onboarding:
//   • seedTenantDatabase  → pg-direct connection to the tenant's
//     Railway Postgres, runs the two seed SQL files
//   • provisionNetlifyTenant (chunk 2)
//   • railwayTemplateUrl    (chunk 3) — pure URL builder, no API call
//
// Each function returns a structured result the route handler can
// pass back to the UI verbatim:
//   { ok: true,  details: { ... }            }
//   { ok: false, error:   'human message',
//                hint?:   'how to fix' }

const fs   = require('fs');
const path = require('path');
const { Client: PgClient } = require('pg');

// Tiny templating — matches the helper in routes/clients.js so the
// downloaded seed.sql and the auto-run seed produce identical output.
function renderTemplate(filePath, vars) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v).replace(/'/g, "''");
  });
}

/**
 * Connect to a tenant's Postgres and run the staff + settings seeds.
 *
 * @param {string} databaseUrl  e.g. postgresql://user:pass@host:5432/railway
 * @param {object} client       row from back-office.clients
 * @returns {Promise<{ok:boolean, details?:object, error?:string, hint?:string}>}
 */
async function seedTenantDatabase(databaseUrl, client) {
  if (!databaseUrl) {
    return {
      ok: false,
      error: 'Tenant DATABASE_URL is not set on the client',
      hint:  'Paste the new Railway Postgres connection string into Setup → Restaurant profile → DATABASE_URL, then retry.',
    };
  }

  const m = client.metadata || {};
  const vars = {
    owner_name:       client.owner_name      || 'Owner',
    owner_email:      client.email           || '',
    restaurant_name:  client.restaurant_name || '',
    address:          m.full_address        || '',
    owner_pin:        m.owner_pin           || '9999',
    chef_pin:         m.chef_pin            || '1111',
    waiter_pin:       m.waiter_pin          || '2222',
  };

  // Render both files.
  const staffSql    = renderTemplate(path.join(__dirname, '..', 'db', 'seed_staff.sql.template'),    vars);
  const settingsSql = renderTemplate(path.join(__dirname, '..', 'db', 'seed_settings.sql.template'), vars);

  // Connect with a short statement timeout — if Railway hasn't finished
  // provisioning Postgres yet, the connection just hangs forever otherwise.
  const pg = new PgClient({
    connectionString:    databaseUrl,
    ssl:                 { rejectUnauthorized: false },   // Railway needs SSL but uses self-signed
    statement_timeout:   15_000,
    connectionTimeoutMillis: 8_000,
  });

  try {
    await pg.connect();
  } catch (err) {
    return {
      ok:    false,
      error: `Could not connect to the tenant database: ${err.message}`,
      hint:  'Check the DATABASE_URL is correct and Railway has finished provisioning the Postgres add-on (~30 sec after clone).',
    };
  }

  const out = { staff: null, settings: null };

  try {
    // Single transaction so a half-run doesn't leave half-seeded state.
    // ON CONFLICT in both templates means re-runs are safe — the
    // transaction is mostly belt-and-braces here.
    await pg.query('BEGIN');
    const staffRes    = await pg.query(staffSql);
    const settingsRes = await pg.query(settingsSql);
    await pg.query('COMMIT');
    out.staff    = { rowCount: staffRes.rowCount    ?? 0 };
    out.settings = { rowCount: settingsRes.rowCount ?? 0 };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch {}
    return {
      ok:    false,
      error: `Seed failed: ${err.message}`,
      hint:  'Most often this means the tenant\'s schema hasn\'t initialised yet. Open their Railway service log and confirm you see "✅ Server listening on 3001" before retrying.',
    };
  } finally {
    try { await pg.end(); } catch {}
  }

  return { ok: true, details: out };
}

// ── Netlify provisioning ────────────────────────────────────────
//
// Talks to Netlify's REST API directly (no CLI in the Docker image
// needed). Auth is a personal access token stored on the back-office
// service as NETLIFY_AUTH_TOKEN; team is optional via NETLIFY_TEAM_SLUG
// — without it the site lands on your personal team.
//
// Three steps in one call:
//   1. POST /api/v1/sites          → create the site
//   2. PATCH                        → set env var VITE_API_URL
//   3. POST /api/v1/sites/{id}/ssl  → request Let's Encrypt
//   (subdomain alias is set as part of step 1)
//
// Returns { ok, details: { site_id, ssl_url, admin_url }, error?, hint? }.

async function netlifyApi(path, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const err = new Error('NETLIFY_AUTH_TOKEN not configured on the back-office service');
    err.hint = 'Add a personal access token from app.netlify.com → User settings → Applications → Personal access tokens, then restart the back-office service.';
    throw err;
  }
  const res = await fetch(`https://api.netlify.com${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const err = new Error(`Netlify ${res.status}: ${body.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Provision a Netlify site for a tenant.
 *
 *   @param {object} client  the clients row
 *   @returns {Promise<{ok:boolean, details?:object, error?:string, hint?:string}>}
 */
async function provisionNetlifyTenant(client) {
  const m = client.metadata || {};
  const slug = m.subdomain_slug;
  const railwayUrl = m.tenant_railway_url;
  if (!slug) {
    return { ok: false, error: 'subdomain_slug not set on client metadata' };
  }
  if (!railwayUrl) {
    return {
      ok: false,
      error: 'Tenant Railway URL not set',
      hint:  'Add the tenant\'s Railway service URL to Setup → Tenant infrastructure → Railway service URL, then retry.',
    };
  }

  const siteName = `siamepos-${slug}`;
  const customDomain = `${slug}.siamepos.co.uk`;
  const teamSlug = process.env.NETLIFY_TEAM_SLUG || null;

  try {
    // Step 1 — create the site. Pre-populate VITE_API_URL in
    // build_settings.env so the first deploy already has the right value.
    const createPath = teamSlug ? `/api/v1/${teamSlug}/sites` : '/api/v1/sites';
    const site = await netlifyApi(createPath, {
      method: 'POST',
      body: JSON.stringify({
        name:          siteName,
        custom_domain: customDomain,
        repo: {
          provider:     'github',
          repo:         'kongponsrisiri-coder/restaurant-epos',
          branch:       'main',
          dir:          'client',                 // base directory
          cmd:          'npm run build',
          deploy_key_id: undefined,
          public_repo:  false,
        },
        // Site-level env var. Netlify reads these when running the build.
        build_settings: {
          env: {
            VITE_API_URL: railwayUrl,
          },
        },
      }),
    });

    // Step 2 — best-effort SSL provision for the subdomain alias.
    let ssl = null;
    try { ssl = await netlifyApi(`/api/v1/sites/${site.id}/ssl`, { method: 'POST' }); }
    catch (sslErr) { console.warn('[provisioning] SSL request soft-failed:', sslErr.message); }

    return {
      ok: true,
      details: {
        site_id:     site.id,
        site_name:   site.name,
        admin_url:   site.admin_url,
        url:         `https://${customDomain}`,
        ssl_state:   ssl?.state || 'pending',
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, hint: err.hint };
  }
}

// ── Railway template URL ────────────────────────────────────────
//
// Korakot creates the template ONCE in railway.com → New project →
// Template → "Save as template". Railway gives a URL like
// https://railway.app/new/template/{id}. We store that as
// RAILWAY_TEMPLATE_URL on the back-office service, then build per-client
// links with the template variables already prefilled — Korakot clicks
// "Deploy" once and Railway provisions the whole stack.
//
// Returns null if RAILWAY_TEMPLATE_URL isn't configured so the UI can
// show a "create the template first" hint instead of a broken button.

function buildRailwayTemplateUrl(client) {
  const base = process.env.RAILWAY_TEMPLATE_URL;
  if (!base) return null;

  const m = client.metadata || {};
  // Template variables — these names must match the template's
  // declared variables in the Railway template editor.
  const vars = {
    SYNC_SECRET:       m.sync_secret       || '',
    BREVO_API_KEY:     m.brevo_api_key     || '',
    ANTHROPIC_API_KEY: m.anthropic_api_key || '',
    RESTAURANT_NAME:   client.restaurant_name || '',
    RESTAURANT_EMAIL:  client.email           || '',
    RESTAURANT_ADDRESS: m.full_address        || '',
  };

  const url = new URL(base);
  for (const [k, v] of Object.entries(vars)) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

module.exports = { seedTenantDatabase, provisionNetlifyTenant, buildRailwayTemplateUrl };
