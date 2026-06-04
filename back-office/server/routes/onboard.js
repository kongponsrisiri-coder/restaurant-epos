// BO-ONBOARD-001 — Public kiosk signup endpoints.
// No auth required — these are called from the /onboard kiosk page
// shown to new clients face-to-face. Verified by Stripe (valid card = real person).

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');

// Lazy-init Stripe so missing key doesn't crash the whole server.
let _stripe = null;
function stripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured on this service');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

// Plan → Stripe price ID mapping (env vars set in Railway back-office service)
const PLAN_PRICE = {
  pro:           process.env.STRIPE_PRICE_PRO,
  lite_booking:  process.env.STRIPE_PRICE_LITE_BOOKING,
  lite_ordering: process.env.STRIPE_PRICE_LITE_ORDERING,
  lite_bundle:   process.env.STRIPE_PRICE_LITE_BUNDLE,
  spa:           process.env.STRIPE_PRICE_SPA,   // Korakot to create spa product
};

// Plan → monthly fee (£) for the client record
const PLAN_FEE = {
  pro: 89, lite_booking: 29, lite_ordering: 39, lite_bundle: 49, spa: 49,
};

// ── POST /api/onboard/start-payment ───────────────────────────────────────
// Creates a Stripe customer + subscription.
// Returns { clientSecret, subscriptionId, customerId } for the frontend
// to confirm payment via Stripe Elements.
router.post('/start-payment', async (req, res) => {
  try {
    const { email, name, plan } = req.body || {};

    if (!email || !name || !plan) {
      return res.status(400).json({ error: 'email, name, and plan are required' });
    }

    const priceId = PLAN_PRICE[plan];
    if (!priceId) {
      return res.status(400).json({
        error: `No Stripe price configured for plan "${plan}". Add STRIPE_PRICE_${plan.toUpperCase()} to Railway env vars.`,
      });
    }

    const s = stripe();

    // Create customer
    const customer = await s.customers.create({ email, name });

    // Create subscription (incomplete until payment confirmed)
    const subscription = await s.subscriptions.create({
      customer: customer.id,
      items:    [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    // Get the client secret — may need to finalize the invoice first if it's in draft
    let clientSecret = subscription.latest_invoice?.payment_intent?.client_secret;

    if (!clientSecret) {
      const invoiceId = typeof subscription.latest_invoice === 'string'
        ? subscription.latest_invoice
        : subscription.latest_invoice?.id;

      if (invoiceId) {
        const invoice = await s.invoices.finalizeInvoice(invoiceId, {
          expand: ['payment_intent'],
        });
        clientSecret = invoice.payment_intent?.client_secret;
      }
    }

    if (!clientSecret) {
      return res.status(500).json({ error: 'Stripe did not return a payment intent client secret' });
    }

    res.json({
      clientSecret,
      subscriptionId: subscription.id,
      customerId:     customer.id,
    });
  } catch (err) {
    console.error('[onboard] start-payment error', err.message);
    res.status(500).json({ error: err.message || 'Payment setup failed' });
  }
});

// ── POST /api/onboard/complete ────────────────────────────────────────────
// Called after Stripe payment is confirmed on the frontend.
// Verifies the subscription is active, creates the client record in our DB,
// and emails Korakot with the new client details.
router.post('/complete', async (req, res) => {
  try {
    const { subscriptionId, formData } = req.body || {};

    if (!subscriptionId || !formData) {
      return res.status(400).json({ error: 'subscriptionId and formData are required' });
    }

    // Derive plan — either from Stripe (real payment) or directly from formData (test/no-stripe mode)
    let plan = formData.plan || 'pro';

    // Only verify with Stripe when we have a real subscription ID
    if (subscriptionId !== 'test') {
      const s = stripe();
      const sub = await s.subscriptions.retrieve(subscriptionId);

      if (!['active', 'trialing'].includes(sub.status)) {
        return res.status(402).json({
          error: `Subscription status is "${sub.status}" — payment may not have completed yet.`,
        });
      }

      // Derive plan from the Stripe price ID
      plan = Object.keys(PLAN_PRICE).find(k => {
        const item = sub.items.data[0];
        return item && PLAN_PRICE[k] === item.price.id;
      }) || formData.plan || 'pro';
    }

    // Build metadata from form data
    const metadata = {
      stripe_customer_id:    sub.customer,
      stripe_subscription_id: subscriptionId,
      address:               formData.address || null,
      signed_up_via:         'kiosk',
      signed_up_at:          new Date().toISOString(),
    };

    // Insert client record
    const { rows } = await pool.query(
      `INSERT INTO clients
         (restaurant_name, owner_name, email, phone, plan, status,
          monthly_fee, sub_start, next_billing, product, metadata)
       VALUES ($1,$2,$3,$4,$5,'in_setup',$6,CURRENT_DATE,
               (CURRENT_DATE + INTERVAL '1 month'), $7, $8)
       RETURNING id, restaurant_name, email`,
      [
        formData.businessName,
        formData.ownerName   || null,
        formData.email,
        formData.phone       || null,
        plan,
        PLAN_FEE[plan] || null,
        formData.product     || 'restaurant',
        JSON.stringify(metadata),
      ]
    );

    const client = rows[0];

    // Email Korakot
    await notifyKorakot(client, plan, formData).catch(e =>
      console.error('[onboard] Korakot notify failed (non-fatal)', e.message)
    );

    res.json({ ok: true, clientId: client.id, clientName: client.restaurant_name });
  } catch (err) {
    console.error('[onboard] complete error', err.message);
    res.status(500).json({ error: err.message || 'Could not complete signup' });
  }
});

// ── GET /api/onboard/stripe-key ────────────────────────────────────────────
// Returns the Stripe publishable key so the frontend doesn't need it baked
// into the Netlify env (useful for dev).
router.get('/stripe-key', (req, res) => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) return res.status(503).json({ error: 'Stripe not configured' });
  res.json({ publishableKey: key });
});

// ── helpers ───────────────────────────────────────────────────────────────

const PLAN_LABEL = {
  pro: 'SiamEPOS Pro £89/mo',
  lite_booking: 'SiamEPOS Lite — Booking £29/mo',
  lite_ordering: 'SiamEPOS Lite — Ordering £39/mo',
  lite_bundle: 'SiamEPOS Lite — Bundle £49/mo',
  spa: 'SiamSpa £49/mo',
};

async function notifyKorakot(client, plan, formData) {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) {
    console.log('[onboard] BREVO_API_KEY not set — skipping Korakot notification');
    return;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#0D1B3E;">🚀 New SiamEPOS client signed up</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;width:140px;">Business</td><td>${formData.businessName}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Owner</td><td>${formData.ownerName || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Email</td><td>${formData.email}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Phone</td><td>${formData.phone || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Address</td><td>${formData.address || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Product</td><td>${formData.product === 'spa' ? '🌿 Spa' : '🍽 Restaurant'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:700;">Plan</td><td>${PLAN_LABEL[plan] || plan} — <strong>payment confirmed ✅</strong></td></tr>
      </table>
      <p style="margin-top:20px;">
        <a href="https://ops.siamepos.co.uk/clients/${client.id}"
           style="background:#0D1B3E;color:white;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700;">
          Open client in back office →
        </a>
      </p>
    </div>`;

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': brevoKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender:  { name: 'SiamEPOS Kiosk', email: 'info@siamepos.co.uk' },
      to:      [{ email: 'info@siamepos.co.uk', name: 'Korakot' }],
      subject: `🚀 New client signed up — ${formData.businessName}`,
      htmlContent: html,
    }),
  });
}

module.exports = router;
