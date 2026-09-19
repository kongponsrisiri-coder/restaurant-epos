// SEPOS-LOYALTY-001 — the 🎁 Loyalty card in ops. Ops is the only thing that
// talks to the loyalty service's ops API (X-Ops-Key); the browser never sees
// the key. Enabling a client passes its cloud URL + sync secret from the
// provisioning metadata straight to the service — nobody types a secret.
const express = require('express');
const { pool } = require('../db/pool');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);   // every loyalty route needs an ops login
const LOYALTY_URL = (process.env.LOYALTY_API_URL || '').replace(/\/$/, '');
const LOYALTY_KEY = process.env.LOYALTY_OPS_KEY || '';

async function svc(path, method = 'GET', body) {
  if (!LOYALTY_URL || !LOYALTY_KEY) throw Object.assign(new Error('Loyalty service not configured on ops (LOYALTY_API_URL + LOYALTY_OPS_KEY)'), { status: 503 });
  const r = await fetch(LOYALTY_URL + path, {
    method, headers: { 'Content-Type': 'application/json', 'x-ops-key': LOYALTY_KEY },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `loyalty ${r.status}`), { status: r.status });
  return d;
}

async function clientRow(id) {
  const r = await pool.query('SELECT id, restaurant_name, email, railway_url, slug, product, metadata FROM clients WHERE id = $1', [id]);
  return r.rows[0] || null;
}
const slugOf = (c) => c.slug || (c.metadata && c.metadata.subdomain_slug) || String(c.restaurant_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

router.get('/config', (req, res) => res.json({ configured: !!(LOYALTY_URL && LOYALTY_KEY), public_url: process.env.LOYALTY_PUBLIC_URL || LOYALTY_URL }));

// Status + stats for one client (404 from the service = not enabled)
router.get('/clients/:id/status', async (req, res) => {
  try {
    const c = await clientRow(req.params.id);
    if (!c) return res.status(404).json({ error: 'client not found' });
    try {
      const t = await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}`);
      res.json({ enabled: true, ...t, customer_url: `${process.env.LOYALTY_PUBLIC_URL || LOYALTY_URL}/${t.slug}` });
    } catch (e) {
      if (e.status === 404) return res.json({ enabled: false, slug: slugOf(c) });
      throw e;
    }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Enable (or re-point) — uses metadata.sync_secret + railway_url; never echoes the secret
router.post('/clients/:id/enable', adminOnly, async (req, res) => {
  try {
    const c = await clientRow(req.params.id);
    if (!c) return res.status(404).json({ error: 'client not found' });
    const secret = c.metadata && c.metadata.sync_secret;
    const cloud = (c.railway_url || '').trim();
    if (!secret) return res.status(400).json({ error: 'This client has no sync_secret in its setup data — add it on the Setup tab first.' });
    if (!/^https?:\/\//.test(cloud)) return res.status(400).json({ error: 'This client has no cloud URL (railway_url).' });
    const status = (req.body && req.body.status) || 'pilot';
    const t = await svc('/api/ops/tenants', 'POST', { slug: slugOf(c), name: c.restaurant_name, cloud_url: cloud, sync_secret: secret, status, owner_email: c.email || null });
    res.json({ enabled: true, ...t });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Status switch: off | pilot | on (+ optional rule reset)
router.put('/clients/:id', adminOnly, async (req, res) => {
  try {
    const c = await clientRow(req.params.id);
    if (!c) return res.status(404).json({ error: 'client not found' });
    const b = req.body || {};
    const allowed = {};
    for (const k of ['status', 'mode', 'min_spend', 'points_per_pound', 'ladder', 'reward_expiry_days', 'launch_at', 'feed_cursor']) if (k in b) allowed[k] = b[k];
    res.json(await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}`, 'PUT', allowed));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/clients/:id/sync', adminOnly, async (req, res) => {
  try { const c = await clientRow(req.params.id); res.json(await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}/sync`, 'POST')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/clients/:id/owner-link', adminOnly, async (req, res) => {
  try { const c = await clientRow(req.params.id); res.json(await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}/owner-link`, 'POST')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/clients/:id/members', async (req, res) => {
  try { const c = await clientRow(req.params.id); res.json(await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}/members?q=${encodeURIComponent(req.query.q || '')}`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/clients/:id/members/:mid/adjust', adminOnly, async (req, res) => {
  try { const c = await clientRow(req.params.id); res.json(await svc(`/api/ops/tenants/${encodeURIComponent(slugOf(c))}/members/${req.params.mid}/adjust`, 'POST', { ...(req.body || {}), by: (req.user && req.user.email) || 'ops' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Fleet view for the dashboard tile
router.get('/fleet', async (req, res) => {
  try { res.json(await svc('/api/ops/tenants')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
