// SIAMPAY-002 Phase B — ops onboarding for SiamPay (Stripe Connect Express).
//
// Flow: [Enable SiamPay] on a client → creates an Express connected account
// (Stripe does the client's KYC) → hosted onboarding link to send/copy →
// status chip polled from Stripe → once charges are enabled, paste the three
// env vars on the client's Railway and their online payments run through
// SiamPay (flat 10p application fee, deducted from the client's settlement —
// the customer always pays the menu price only; Nick's direct-charge rule).
//
// Keys: this uses the SIAMPAY PLATFORM key, which is deliberately a SEPARATE
// env from this service's STRIPE_SECRET_KEY (that one is the LIVE billing
// key for subscriptions). While SiamPay stays in TEST mode the two must not
// be conflated. Dormant without the env — the UI shows "not configured".
//   SIAMPAY_PLATFORM_SECRET_KEY       sk_test_… (platform, NOT a connected acct)
//   SIAMPAY_PLATFORM_PUBLISHABLE_KEY  pk_test_… (returned to the UI for the
//                                     tenant env-var copy block; pk is public)

const express = require('express');
const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

let _sp = null;
function siampayStripe() {
  if (!_sp) {
    const key = process.env.SIAMPAY_PLATFORM_SECRET_KEY;
    if (!key) throw new Error('SIAMPAY_PLATFORM_SECRET_KEY not configured on this service');
    _sp = require('stripe')(key);
  }
  return _sp;
}

function siampayMode() {
  const key = process.env.SIAMPAY_PLATFORM_SECRET_KEY || '';
  if (!key) return null;
  return key.startsWith('sk_test_') ? 'test' : 'live';
}

const OPS_URL = process.env.OPS_PUBLIC_URL || 'https://ops.siamepos.co.uk';

async function getClient(id) {
  const r = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// GET /api/siampay/config — is the platform key present, and which mode?
router.get('/config', (req, res) => {
  const mode = siampayMode();
  res.json({ configured: !!mode, mode });
});

// POST /api/siampay/clients/:id/enable — create the Express connected
// account (idempotent: returns the existing one if already created).
router.post('/clients/:id/enable', async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.siampay_account) {
      return res.json({ account: client.siampay_account, existing: true });
    }
    const acct = await siampayStripe().accounts.create({
      type: 'express',
      country: 'GB',
      email: client.email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
      business_profile: {
        name: client.restaurant_name,
        // MCC by product: restaurants 5812, spas/massage 7297.
        mcc: (client.product || 'restaurant') === 'spa' ? '7297' : '5812',
      },
      metadata: { bo_client_id: String(client.id), slug: client.slug || '' },
    });
    await pool.query('UPDATE clients SET siampay_account = $1 WHERE id = $2', [acct.id, client.id]);
    res.json({ account: acct.id, existing: false });
  } catch (err) {
    console.error('[siampay] enable', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/siampay/clients/:id/onboarding-link — fresh hosted KYC link.
// Links expire after a few minutes of non-use, so mint on demand rather
// than storing one.
router.post('/clients/:id/onboarding-link', async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.siampay_account) return res.status(400).json({ error: 'SiamPay not enabled for this client yet' });
    const link = await siampayStripe().accountLinks.create({
      account: client.siampay_account,
      type: 'account_onboarding',
      return_url:  `${OPS_URL}/clients/${client.id}?siampay=done`,
      refresh_url: `${OPS_URL}/clients/${client.id}?siampay=refresh`,
    });
    res.json({ url: link.url, expires_at: link.expires_at });
  } catch (err) {
    console.error('[siampay] onboarding-link', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/siampay/clients/:id/status — live KYC/capability state + the
// tenant env-var block (publishable key only — the secret key is never
// sent to the browser; it's pasted from .infra-keys / the Stripe dashboard).
router.get('/clients/:id/status', async (req, res) => {
  try {
    const client = await getClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.siampay_account) return res.json({ enabled: false });
    const acct = await siampayStripe().accounts.retrieve(client.siampay_account);
    res.json({
      enabled: true,
      account: acct.id,
      mode: siampayMode(),
      details_submitted: !!acct.details_submitted,
      charges_enabled:   !!acct.charges_enabled,
      payouts_enabled:   !!acct.payouts_enabled,
      requirements_due:  (acct.requirements && acct.requirements.currently_due) || [],
      disabled_reason:   (acct.requirements && acct.requirements.disabled_reason) || null,
      tenant_env: {
        SIAMPAY_ACCOUNT: acct.id,
        PLATFORM_STRIPE_PUBLISHABLE_KEY: process.env.SIAMPAY_PLATFORM_PUBLISHABLE_KEY || '(set SIAMPAY_PLATFORM_PUBLISHABLE_KEY on ops to show it here)',
        PLATFORM_STRIPE_SECRET_KEY: '(paste from .infra-keys — never shown here)',
      },
    });
  } catch (err) {
    console.error('[siampay] status', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
