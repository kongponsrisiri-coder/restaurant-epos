// SEPOS-041 — clients CRUD + per-client health timeline.
// All routes require auth. Only admins can delete.

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

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
    ];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        params.push(req.body[k] === '' ? null : req.body[k]);
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
