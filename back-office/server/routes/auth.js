// POST /api/auth/login — exchange email + password for a JWT.
// POST /api/auth/me    — verify token, return current user (sanity check
//                        for the frontend to redirect if expired).

const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    const r = await pool.query('SELECT * FROM team_users WHERE email = $1', [String(email).toLowerCase().trim()]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[ops-auth] login error', err);
    res.status(500).json({ error: 'login failed' });
  }
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
