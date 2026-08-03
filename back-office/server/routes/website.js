// SEPOS-WEB-001 — Website Builder API.
// Two surfaces:
//   - global config (SiamEPOS marketing demo): is_global = TRUE, client_id NULL
//   - per-client config:                       client_id = N
// Photos are stored as base64 data URIs in TEXT columns so the generated
// HTML can be fully self-contained (no CDN dependency).

const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');
const { netlifyApi } = require('../services/provisioning');

const router = express.Router();
router.use(authRequired);

const UPDATABLE = [
  'restaurant_name', 'tagline', 'address', 'phone', 'email', 'about_text',
  'primary_colour', 'accent_colour',
  'photo_hero', 'photo_story', 'photo_gallery_1', 'photo_gallery_2', 'photo_gallery_3',
  'photo_gallery_4', 'photo_gallery_5', 'photo_gallery_6',  // SEPOS-WEB-005
  'photo_gallery_7', 'photo_gallery_8', 'photo_gallery_9',  // SEPOS-WEB-006
  'photo_gallery_10', 'photo_gallery_11', 'photo_gallery_12',
  'sections',  // SEPOS-WEB-002 — JSON blob of toggleable section content.
  'template',  // SEPOS-WEB-003 — design template key.
  'logo_url',  // SEPOS-WEB-003 — base64 or URL of logo for nav.
];

function pickFields(body) {
  const out = {};
  for (const k of UPDATABLE) {
    if (k in (body || {})) {
      out[k] = k === 'sections' ? JSON.stringify(body[k] || {}) : body[k];
    }
  }
  return out;
}

async function upsertConfig(matcher, fields) {
  // matcher: { client_id: N } or { is_global: true }
  const whereCol = 'is_global' in matcher ? 'is_global' : 'client_id';
  const whereVal = matcher[whereCol];
  const existing = await pool.query(
    `SELECT id FROM website_configs WHERE ${whereCol} = $1 LIMIT 1`,
    [whereVal]
  );
  if (existing.rows.length === 0) {
    // Insert. Build a SET fragment from the matcher + fields.
    const insertCols = [whereCol, ...Object.keys(fields)];
    const insertVals = [whereVal, ...Object.values(fields)];
    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(',');
    const r = await pool.query(
      `INSERT INTO website_configs (${insertCols.join(',')}) VALUES (${placeholders}) RETURNING *`,
      insertVals
    );
    return r.rows[0];
  }
  // Update.
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    const r = await pool.query(`SELECT * FROM website_configs WHERE id = $1`, [existing.rows[0].id]);
    return r.rows[0];
  }
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  sets.push(`updated_at = NOW()`);
  const params = [...Object.values(fields), existing.rows[0].id];
  const r = await pool.query(
    `UPDATE website_configs SET ${sets.join(',')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0];
}

// ── Global (SiamEPOS marketing) ────────────────────────────────────
router.get('/global', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM website_configs WHERE is_global = TRUE LIMIT 1`);
    res.json(r.rows[0] || { is_global: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/global', async (req, res) => {
  try {
    const row = await upsertConfig({ is_global: true }, pickFields(req.body));
    res.json(row);
  } catch (err) {
    console.error('[ops-website] global upsert error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Per-client ─────────────────────────────────────────────────────
router.get('/client/:clientId', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const r = await pool.query(`SELECT * FROM website_configs WHERE client_id = $1 LIMIT 1`, [clientId]);
    res.json(r.rows[0] || { client_id: clientId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/client/:clientId', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const row = await upsertConfig({ client_id: clientId }, pickFields(req.body));
    res.json(row);
  } catch (err) {
    console.error('[ops-website] client upsert error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI import: scrape a URL → extract restaurant details ──────────
router.post('/ai-import', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on the back-office service' });
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You extract restaurant details from websites.
Visit the given URL and extract restaurant information.
Return ONLY a valid JSON object — no markdown fences, no extra prose.
Fields:
  restaurant_name — restaurant name
  tagline         — one-line description of cuisine and location
  address         — full postal address
  phone           — phone number with area code
  email           — contact email if present
  about_text      — 2-3 sentence about-us paragraph in the restaurant's own voice
Use an empty string for any field not found.`,
      messages: [{
        role:    'user',
        content: `Extract restaurant details from this website: ${url}`,
      }],
    });

    const text  = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in AI response');
    const data = JSON.parse(match[0]);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[ops-website] ai-import error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SEPOS-WEB-007 — one-click publish to Netlify ───────────────────
// The browser generates the pages (it owns the template lib) and POSTs
// them here; we create/reuse the client's WEBSITE Netlify site (separate
// from the EPOS app site), push a file-digest deploy, and record a
// publish row with a full config snapshot for history/restore.
router.post('/client/:clientId/publish', adminOnly, async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const files = (req.body || {}).files;
    if (!files || typeof files !== 'object' || !files['index.html']) {
      return res.status(400).json({ error: 'files object with at least index.html required' });
    }

    const cfgQ = await pool.query(`SELECT * FROM website_configs WHERE client_id = $1 LIMIT 1`, [clientId]);
    if (!cfgQ.rows.length) return res.status(400).json({ error: 'No website config saved for this client yet' });
    const cfgRow = cfgQ.rows[0];
    const clientQ = await pool.query(`SELECT * FROM clients WHERE id = $1`, [clientId]);
    if (!clientQ.rows.length) return res.status(404).json({ error: 'Client not found' });
    const client = clientQ.rows[0];

    // 1. Ensure the website's Netlify site exists (and still exists).
    let siteId = cfgRow.netlify_site_id;
    let site = null;
    if (siteId) {
      try { site = await netlifyApi(`/api/v1/sites/${siteId}`); }
      catch (e) { if (e.status === 404) { siteId = null; } else throw e; }
    }
    if (!siteId) {
      const slugBase = (client.slug || client.restaurant_name || `client-${clientId}`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let name = `siamepos-web-${slugBase}`;
      try {
        site = await netlifyApi('/api/v1/sites', { method: 'POST', body: JSON.stringify({ name }) });
      } catch (e) {
        if (e.status === 422) { // name taken on Netlify — suffix with the client id
          name = `${name}-${clientId}`;
          site = await netlifyApi('/api/v1/sites', { method: 'POST', body: JSON.stringify({ name }) });
        } else throw e;
      }
      siteId = site.id;
    }

    // 2. File-digest deploy: announce sha1s, then upload whatever Netlify
    //    doesn't already have from a previous deploy.
    const sha = {};
    for (const [fname, content] of Object.entries(files)) {
      sha[`/${fname}`] = crypto.createHash('sha1').update(String(content), 'utf8').digest('hex');
    }
    const deploy = await netlifyApi(`/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      body: JSON.stringify({ files: sha }),
    });
    const required = new Set(deploy.required || []);
    for (const [fname, content] of Object.entries(files)) {
      const path = `/${fname}`;
      if (!required.has(sha[path])) continue;
      const up = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files${encodeURI(path)}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
          'Content-Type': 'application/octet-stream',
        },
        body: String(content),
      });
      if (!up.ok) throw new Error(`Netlify upload ${path} failed: ${up.status} ${(await up.text()).slice(0, 200)}`);
    }

    const url = site?.ssl_url || site?.url || deploy.ssl_url || deploy.url || '';
    const by = req.user?.email || req.user?.name || 'ops';

    // 3. Record the publish. Deliberately NOT touching updated_at so the
    //    draft-vs-live comparison stays meaningful.
    await pool.query(
      `UPDATE website_configs SET netlify_site_id = $1, published_at = NOW(), published_by = $2 WHERE id = $3`,
      [siteId, by, cfgRow.id]
    );
    const snap = {};
    for (const k of UPDATABLE) if (k in cfgRow) snap[k] = cfgRow[k];
    const ins = await pool.query(
      `INSERT INTO website_publishes (client_id, published_by, netlify_site_id, netlify_deploy_id, url, config_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, published_at`,
      [clientId, by, siteId, deploy.id, url, JSON.stringify(snap)]
    );

    res.json({
      success: true, url, site_id: siteId, deploy_id: deploy.id,
      publish_id: ins.rows[0].id, published_at: ins.rows[0].published_at, published_by: by,
    });
  } catch (err) {
    console.error('[ops-website] publish error', err);
    res.status(500).json({ error: err.message, hint: err.hint });
  }
});

// Publish history — metadata only, snapshots stay server-side.
router.get('/client/:clientId/publishes', async (req, res) => {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const r = await pool.query(
      `SELECT id, published_by, published_at, url, netlify_site_id
         FROM website_publishes WHERE client_id = $1
        ORDER BY published_at DESC LIMIT 20`,
      [clientId]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore a published snapshot into the draft config. Does NOT republish —
// the operator reviews in the builder, then hits Publish again.
router.post('/client/:clientId/restore/:publishId', adminOnly, async (req, res) => {
  try {
    const clientId  = parseInt(req.params.clientId, 10);
    const publishId = parseInt(req.params.publishId, 10);
    const r = await pool.query(
      `SELECT config_snapshot FROM website_publishes WHERE id = $1 AND client_id = $2`,
      [publishId, clientId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Publish not found for this client' });
    const row = await upsertConfig({ client_id: clientId }, pickFields(r.rows[0].config_snapshot || {}));
    res.json(row);
  } catch (err) {
    console.error('[ops-website] restore error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI copywriting assist: draft a section from the config facts ──
// SEPOS-WEB-005. kinds: about | philosophy | catering | seo_description | tagline
const AI_COPY_KINDS = {
  about: {
    instruction: 'Write a 2-4 sentence "Our Story" / about-us paragraph in the restaurant\'s own warm first-person-plural voice ("we"). No headings, no quotes around it.',
    max: 600,
  },
  philosophy: {
    instruction: 'Write a 3-5 sentence brand-philosophy paragraph — the restaurant\'s soul and what eating there should feel like. Evocative but not purple. No headings.',
    max: 700,
  },
  catering: {
    instruction: 'Write a 2-3 sentence private-dining / catering pitch inviting event enquiries. End with an implicit invitation to get in touch. No headings.',
    max: 500,
  },
  seo_description: {
    instruction: 'Write ONE meta description of 140-158 characters: cuisine, location, and a reason to visit. Plain text, no quotes.',
    max: 200,
  },
  tagline: {
    instruction: 'Write ONE short tagline (max 10 words) capturing the cuisine and feel. Plain text, no quotes, no full stop.',
    max: 100,
  },
};

router.post('/ai-copy', async (req, res) => {
  const { kind, facts } = req.body || {};
  const spec = AI_COPY_KINDS[kind];
  if (!spec) return res.status(400).json({ error: `kind must be one of: ${Object.keys(AI_COPY_KINDS).join(', ')}` });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on the back-office service' });
  }
  try {
    const f = facts || {};
    const factLines = [
      f.restaurant_name && `Restaurant name: ${f.restaurant_name}`,
      f.tagline && `Tagline: ${f.tagline}`,
      f.address && `Address: ${f.address}`,
      f.about_text && `Existing about text (improve on it, keep true facts): ${f.about_text}`,
      f.existing && `Existing draft to improve: ${f.existing}`,
      `Cuisine: ${f.cuisine || 'Thai'}`,
    ].filter(Boolean).join('\n');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: `You write website copy for independent restaurants in the UK. British English. Never invent specific facts (awards, dates, named dishes, family history) that are not in the provided facts — stay generic where facts are missing. Return ONLY the copy itself: no markdown, no preamble, no quotation marks around the output.`,
      messages: [{
        role: 'user',
        content: `${spec.instruction}\n\nFacts:\n${factLines}`,
      }],
    });

    let text = message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (text.length > spec.max) text = text.slice(0, spec.max).trim();
    res.json({ success: true, text });
  } catch (err) {
    console.error('[ops-website] ai-copy error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
