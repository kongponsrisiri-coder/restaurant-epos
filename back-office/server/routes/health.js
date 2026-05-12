// SEPOS-041 — manual health-check trigger (button on the dashboard).
// The cron in services/healthCheck.js fires every 5 minutes; this route
// lets an operator force a check NOW for a single client.

const express = require('express');
const { authRequired } = require('../middleware/auth');
const { runHealthCheckForClient } = require('../services/healthCheck');

const router = express.Router();
router.use(authRequired);

router.post('/run', async (req, res) => {
  try {
    const clientId = parseInt(req.body?.client_id, 10);
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    const result = await runHealthCheckForClient(clientId);
    res.json(result || { ran: false });
  } catch (err) {
    console.error('[ops-health] run error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
