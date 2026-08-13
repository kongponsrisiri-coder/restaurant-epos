// SEPOS-REVIEWS-001 — client review data for the ops UI.
//   GET  /api/reviews/clients/:id           latest snapshot + 90-day series
//   POST /api/reviews/clients/:id/refresh   snapshot now (finds place_id first time)

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const gr = require('../services/googleReviews');

const router = express.Router();
router.use(authRequired);

router.get('/clients/:id', async (req, res) => {
  try {
    if (!gr.enabled()) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });
    const latest = await pool.query(
      `SELECT rating, review_count, reviews, fetched_at FROM reviews_snapshots
        WHERE client_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [req.params.id]);
    const series = await pool.query(
      `SELECT DATE(fetched_at) AS day, MAX(rating) AS rating, MAX(review_count) AS review_count
         FROM reviews_snapshots
        WHERE client_id = $1 AND fetched_at > NOW() - INTERVAL '90 days'
        GROUP BY DATE(fetched_at) ORDER BY day`, [req.params.id]);
    const c = await pool.query('SELECT place_id FROM clients WHERE id = $1', [req.params.id]);
    res.json({
      place_id: c.rows[0]?.place_id || null,
      latest: latest.rows[0] || null,
      series: series.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/clients/:id/refresh', async (req, res) => {
  try {
    if (!gr.enabled()) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });
    const c = await pool.query('SELECT id, restaurant_name, place_id, metadata FROM clients WHERE id = $1', [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Client not found' });
    const r = await gr.snapshotClient(c.rows[0]);
    if (r.skipped) return res.status(404).json({ error: r.skipped });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
