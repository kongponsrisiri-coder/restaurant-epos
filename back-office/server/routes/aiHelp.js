// SEPOS-AI-HELP-001 — in-app "Ask AI" assistant logs.
//
// POST /  — machine ingest. A tenant restaurant cloud forwards each answered
//           Q&A with its `x-sync-secret`. We authenticate AND identify the
//           client by matching that secret to clients.metadata->>'sync_secret'
//           (the same secret ops generated at onboarding). NOT JWT-gated.
// GET  /   — the ops "AI Help" section (human, authRequired).
// GET /stats — quick counts for the section header (human, authRequired).

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// ── Ingest (machine-authed by shared sync_secret) ──────────────────────
router.post('/', async (req, res) => {
  try {
    const secret = req.get('x-sync-secret') || '';
    if (!secret) return res.status(401).json({ error: 'missing x-sync-secret' });
    const { question, reply, platform, staff_role, escalated, restaurant_name } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }
    // The secret both authenticates the caller AND tells us which client it is.
    const c = await pool.query(
      `SELECT id, restaurant_name FROM clients WHERE metadata->>'sync_secret' = $1 LIMIT 1`,
      [secret]
    );
    if (c.rowCount === 0) return res.status(401).json({ error: 'unrecognised secret' });
    const client = c.rows[0];
    await pool.query(
      `INSERT INTO ai_help_logs
         (client_id, restaurant_name, question, reply, platform, staff_role, escalated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        client.id,
        client.restaurant_name || restaurant_name || null,
        String(question).slice(0, 4000),
        reply ? String(reply).slice(0, 8000) : null,
        platform || null,
        staff_role || null,
        !!escalated,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[ops-ai-help] ingest error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── List (human) — newest first, optional ?client=<id> filter ──────────
router.get('/', authRequired, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 250, 1000);
    const clientId = req.query.client ? parseInt(req.query.client, 10) : null;
    const params = [];
    let where = '';
    if (clientId) { params.push(clientId); where = `WHERE l.client_id = $1`; }
    params.push(limit);
    const r = await pool.query(
      `SELECT l.id, l.client_id,
              COALESCE(c.restaurant_name, l.restaurant_name) AS restaurant_name,
              l.question, l.reply, l.platform, l.staff_role, l.escalated, l.created_at
         FROM ai_help_logs l
         LEFT JOIN clients c ON c.id = l.client_id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[ops-ai-help] list error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats (human) — header counts ──────────────────────────────────────
router.get('/stats', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last_7d,
              COUNT(DISTINCT client_id)::int AS restaurants,
              COUNT(*) FILTER (WHERE escalated)::int AS escalated
         FROM ai_help_logs`
    );
    res.json(r.rows[0] || { total: 0, last_7d: 0, restaurants: 0, escalated: 0 });
  } catch (err) {
    console.error('[ops-ai-help] stats error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
