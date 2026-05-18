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
// Uses the EPOS `settings` table (setting_key / setting_value columns)
router.get('/settings', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT setting_key AS key, setting_value AS value
       FROM settings WHERE restaurant_id = $1`,
      [req.user.restaurantId]
    );
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    return res.json(settings);
  } catch (err) {
    // Fall back to empty settings rather than 500
    console.error('[settings get]', err.message);
    return res.json({});
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
        `INSERT INTO settings (restaurant_id, setting_key, setting_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (restaurant_id, setting_key) DO UPDATE SET setting_value = $3`,
        [req.user.restaurantId, key, String(value)]
      );
    }
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[settings patch]', err.message);
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

// GET /api/restaurant/orders?status=open,pending,...&limit=50
router.get('/orders', authRequired, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    // Online orders are identified by order_type IN ('takeaway','delivery')
    let sql = `SELECT o.*, COUNT(oi.id) AS item_count
               FROM orders o
               LEFT JOIN order_items oi ON oi.order_id = o.id
               WHERE o.restaurant_id = $1
                 AND o.order_type IN ('takeaway','delivery')`;
    const params = [req.user.restaurantId];

    // status may be a single value or comma-separated list
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ` AND o.status = $${params.length + 1}`;
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
        sql += ` AND o.status IN (${placeholders})`;
        params.push(...statuses);
      }
    }

    sql += ` GROUP BY o.id ORDER BY o.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error('[orders]', err.message);
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

// ── Revenue history ───────────────────────────────────────────────────────────

// GET /api/restaurant/revenue?days=30
// Returns daily revenue + order count for the last N days (default 30).
router.get('/revenue', authRequired, async (req, res) => {
  const rid  = req.user.restaurantId;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
  try {
    const { rows } = await pool.query(
      `SELECT
         DATE(created_at)                          AS date,
         COUNT(*)::int                             AS orders,
         COALESCE(SUM(total_amount), 0)::numeric   AS revenue
       FROM orders
       WHERE restaurant_id = $1
         AND order_type IN ('takeaway','delivery')
         AND created_at >= NOW() - ($2 * INTERVAL '1 day')
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [rid, days]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[revenue]', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
