const express  = require('express');
const bcrypt   = require('bcryptjs');
const pool     = require('../db/pool');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query(
      `SELECT u.*, r.name AS restaurant_name, r.plan, r.status
       FROM lite_users u
       JOIN restaurants r ON r.restaurant_id = u.restaurant_id
       WHERE u.email = $1`,
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    const token = signToken({
      userId:        user.id,
      restaurantId:  user.restaurant_id,
      email:         user.email,
      name:          user.name,
      role:          user.role,
    });
    return res.json({
      token,
      user: {
        id:              user.id,
        email:           user.email,
        name:            user.name,
        role:            user.role,
        restaurantId:    user.restaurant_id,
        restaurantName:  user.restaurant_name,
        plan:            user.plan,
        onboardingComplete: user.onboarding_complete,
      },
    });
  } catch (err) {
    console.error('[auth] login error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — refresh user info
router.get('/me', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.restaurant_id,
              r.name AS restaurant_name, r.plan, r.status, r.onboarding_complete
       FROM lite_users u
       JOIN restaurants r ON r.restaurant_id = u.restaurant_id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    return res.json({
      id:              u.id,
      email:           u.email,
      name:            u.name,
      role:            u.role,
      restaurantId:    u.restaurant_id,
      restaurantName:  u.restaurant_name,
      plan:            u.plan,
      onboardingComplete: u.onboarding_complete,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
