// SEPOS — engineering tickets CRUD.
// Auth required for reads + writes. Delete is admin-only (we don't
// want a support user nuking a long-form spec).

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// List — return the columns useful for a card/row, not the full
// body. Saves bandwidth when there are dozens of tickets.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, code, title, status, priority, author, created_at, updated_at,
             LENGTH(body_markdown) AS body_length
      FROM engineering_tickets
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'open'        THEN 1
          WHEN 'shipped'     THEN 2
          WHEN 'parked'      THEN 3
          ELSE 4
        END,
        updated_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[ops-tickets] list error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get one — full body included.
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT * FROM engineering_tickets WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { code, title, status, priority, author, body_markdown } = req.body || {};
    if (!code || !title || !body_markdown) {
      return res.status(400).json({ error: 'code, title, body_markdown required' });
    }
    const r = await pool.query(
      `INSERT INTO engineering_tickets (code, title, status, priority, author, body_markdown)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, title, status || 'open', priority || 'normal', author || req.user.name, body_markdown]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ticket code already exists' });
    console.error('[ops-tickets] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['title', 'status', 'priority', 'author', 'body_markdown'];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        params.push(req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no updatable fields supplied' });
    sets.push('updated_at = NOW()');
    params.push(id);
    const r = await pool.query(
      `UPDATE engineering_tickets SET ${sets.join(',')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[ops-tickets] update error', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM engineering_tickets WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
