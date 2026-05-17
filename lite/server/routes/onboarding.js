// Lite onboarding — creates the restaurant record + owner user account.
// Called from the 5-step wizard on lite.siamepos.co.uk/onboarding.
// No auth required on the create step (the user doesn't exist yet).
const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

// Slugify a name into a safe restaurant_id
function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'restaurant';
}

async function uniqueSlug(base) {
  let slug = base;
  let attempt = 0;
  while (true) {
    const { rows } = await pool.query(
      'SELECT 1 FROM restaurants WHERE restaurant_id = $1', [slug]
    );
    if (!rows.length) return slug;
    attempt++;
    slug = `${base}-${attempt}`;
  }
}

// POST /api/onboarding/start
// Step 1+2: create restaurant + owner account.
// Body: { name, email, password, address, phone, plan }
router.post('/start', async (req, res) => {
  const { name, email, password, address, phone, plan } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const validPlans = ['lite_booking', 'lite_ordering', 'lite_bundle'];
  if (plan && !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check email not already registered
    const existing = await client.query(
      'SELECT 1 FROM lite_users WHERE email = $1', [email.trim().toLowerCase()]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered' });
    }

    const restaurantId = await uniqueSlug(slugify(name));
    const passwordHash = await bcrypt.hash(password, 12);

    // Create restaurant row
    await client.query(
      `INSERT INTO restaurants
         (restaurant_id, name, plan, status, email, phone, address, created_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, NOW())`,
      [restaurantId, name.trim(), plan || 'lite_bundle', email.trim().toLowerCase(), phone || '', address || '']
    );

    // Seed default restaurant_settings row
    await client.query(
      `INSERT INTO restaurant_settings (restaurant_id, key, value)
       VALUES ($1, 'restaurant_name', $2)
       ON CONFLICT (restaurant_id, key) DO NOTHING`,
      [restaurantId, name.trim()]
    );

    // Create owner user
    const { rows } = await client.query(
      `INSERT INTO lite_users (restaurant_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'owner')
       RETURNING id`,
      [restaurantId, email.trim().toLowerCase(), passwordHash, name.trim()]
    );

    await client.query('COMMIT');

    const token = signToken({
      userId:       rows[0].id,
      restaurantId,
      email:        email.trim().toLowerCase(),
      name:         name.trim(),
      role:         'owner',
    });

    return res.status(201).json({
      token,
      restaurantId,
      plan: plan || 'lite_bundle',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[onboarding] start error', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/onboarding/complete — mark onboarding done
router.patch('/complete', authRequired, async (req, res) => {
  try {
    await pool.query(
      'UPDATE restaurants SET onboarding_complete = true WHERE restaurant_id = $1',
      [req.user.restaurantId]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
