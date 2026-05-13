// SEPOS-WEB-001 — Website Builder API.
// Two surfaces:
//   - global config (SiamEPOS marketing demo): is_global = TRUE, client_id NULL
//   - per-client config:                       client_id = N
// Photos are stored as base64 data URIs in TEXT columns so the generated
// HTML can be fully self-contained (no CDN dependency).

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const UPDATABLE = [
  'restaurant_name', 'tagline', 'address', 'phone', 'email', 'about_text',
  'primary_colour', 'accent_colour',
  'photo_hero', 'photo_story', 'photo_gallery_1', 'photo_gallery_2', 'photo_gallery_3',
];

function pickFields(body) {
  const out = {};
  for (const k of UPDATABLE) if (k in (body || {})) out[k] = body[k];
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

module.exports = router;
