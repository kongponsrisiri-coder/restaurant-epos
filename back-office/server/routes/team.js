// SEPOS-041 — team user management. Admin-only for everything.

const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);
router.use(adminOnly);

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, role, created_at FROM team_users ORDER BY created_at ASC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name + email + password required' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO team_users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name, String(email).toLowerCase().trim(), hash, role || 'support']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    console.error('[ops-team] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, role, password } = req.body || {};
    const sets = [];
    const params = [];
    if (name) { params.push(name); sets.push(`name = $${params.length}`); }
    if (role) { params.push(role); sets.push(`role = $${params.length}`); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      sets.push(`password_hash = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(id);
    const r = await pool.query(
      `UPDATE team_users SET ${sets.join(',')} WHERE id = $${params.length}
       RETURNING id, name, email, role, created_at`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Team user not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
    await pool.query('DELETE FROM team_users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
