// Restaurant profile + settings for the Lite dashboard.
// Also exposes the embed-code snippets and proxies bookings/orders
// from the shared EPOS backend.
const express = require('express');
const pool    = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// ── Profile ───────────────────────────────────────────────────────────────────

// GET /api/restaurant
router.get('/', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT restaurant_id, name, plan, status, email, phone, address,
              logo_url, onboarding_complete, stripe_subscription_id,
              stripe_customer_id, created_at
       FROM restaurants WHERE restaurant_id = $1`,
      [req.user.restaurantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/restaurant — update profile fields
router.patch('/', authRequired, async (req, res) => {
  const { name, email, phone, address, logo_url } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE restaurants
       SET name      = COALESCE($2, name),
           email     = COALESCE($3, email),
           phone     = COALESCE($4, phone),
           address   = COALESCE($5, address),
           logo_url  = COALESCE($6, logo_url)
       WHERE restaurant_id = $1
       RETURNING *`,
      [req.user.restaurantId, name || null, email || null, phone || null, address || null, logo_url || null]
    );
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Settings (key-value store from restaurant_settings) ───────────────────────

// GET /api/restaurant/settings
router.get('/settings', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM restaurant_settings WHERE restaurant_id = $1',
      [req.user.restaurantId]
    );
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return res.json(settings);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/restaurant/settings — upsert key-value pairs
router.patch('/settings', authRequired, async (req, res) => {
  const updates = req.body || {};
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(updates)) {
      await client.query(
        `INSERT INTO restaurant_settings (restaurant_id, key, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (restaurant_id, key) DO UPDATE SET value = $3`,
        [req.user.restaurantId, key, String(value)]
      );
    }
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Embed codes ───────────────────────────────────────────────────────────────

// GET /api/restaurant/embed-codes
// Returns copy-paste HTML snippets for the booking + takeaway widgets.
// The widget scripts live on the EPOS backend; we tell the Lite customer
// to load from LITE_EPOS_API_URL (set in Railway env).
router.get('/embed-codes', authRequired, async (req, res) => {
  const rid = req.user.restaurantId;
  const base = process.env.LITE_EPOS_API_URL || 'https://restaurant-epos-production.up.railway.app';

  const booking = `<!-- SiamEPOS Booking Widget -->
<div id="siamepos-booking-widget"></div>
<script
  src="${base}/widget.js"
  data-restaurant="${rid}"
  defer>
</script>`;

  const takeaway = `<!-- SiamEPOS Takeaway Widget -->
<div id="siamepos-takeaway-widget"></div>
<script
  src="${base}/takeaway-widget.js"
  data-restaurant="${rid}"
  defer>
</script>`;

  return res.json({ booking, takeaway, restaurantId: rid, base });
});

// ── Bookings (proxy from EPOS backend) ────────────────────────────────────────

// GET /api/restaurant/bookings?date=YYYY-MM-DD&limit=50
router.get('/bookings', authRequired, async (req, res) => {
  try {
    const { date, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT * FROM reservations WHERE restaurant_id = $1`;
    const params = [req.user.restaurantId];
    if (date) {
      sql += ` AND DATE(reservation_date) = $${params.length + 1}`;
      params.push(date);
    }
    sql += ` ORDER BY reservation_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Online orders (takeaway + delivery) ───────────────────────────────────────

// GET /api/restaurant/orders?status=open&limit=50
router.get('/orders', authRequired, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    // Online orders are identified by order_type IN ('takeaway','delivery')
    let sql = `SELECT o.*,
                 COUNT(oi.id) AS item_count,
                 SUM(oi.price * oi.quantity) AS subtotal
               FROM orders o
               LEFT JOIN order_items oi ON oi.order_id = o.id
               WHERE o.restaurant_id = $1
                 AND o.order_type IN ('takeaway','delivery')`;
    const params = [req.user.restaurantId];
    if (status === 'open') {
      sql += ` AND o.status = 'open'`;
    } else if (status === 'closed') {
      sql += ` AND o.status = 'closed'`;
    }
    sql += ` GROUP BY o.id ORDER BY o.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Dashboard stats ───────────────────────────────────────────────────────────

// GET /api/restaurant/stats — quick summary for the dashboard header
router.get('/stats', authRequired, async (req, res) => {
  const rid = req.user.restaurantId;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [bookings, orders] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total FROM reservations
         WHERE restaurant_id = $1 AND DATE(reservation_date) = $2 AND status != 'cancelled'`,
        [rid, today]
      ),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(total_amount),0) AS revenue
         FROM orders
         WHERE restaurant_id = $1 AND order_type IN ('takeaway','delivery')
           AND DATE(created_at) = $2`,
        [rid, today]
      ),
    ]);
    return res.json({
      bookings_today: Number(bookings.rows[0].total),
      orders_today:   Number(orders.rows[0].total),
      revenue_today:  Number(orders.rows[0].revenue),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
