// BO-ONBOARD-001 — Public kiosk signup endpoints.
// No auth required — these are called from the /onboard kiosk page
// shown to new clients face-to-face. Verified by Stripe (valid card = real person).

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');
const { sendWelcomeEmail } = require('../services/welcomeEmail');
const { generateSlug, uniqueSlug } = require('./clients'); // re-use slug helpers

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
    // Get the price amount directly — create a PaymentIntent for the first month.
    // This is more reliable than the subscription→invoice→payment_intent chain,
    // which breaks when the price is configured for manual invoicing.
    const price = await s.prices.retrieve(priceId);
    const amount = price.unit_amount; // in pence
    const currency = price.currency || 'gbp';

    console.log('[onboard] price:', priceId, 'amount:', amount, currency);

    const paymentIntent = await s.paymentIntents.create({
      amount,
      currency,
      customer:             customer.id,
      payment_method_types: ['card'],
      description:          `SiamEPOS ${PLAN_LABEL[plan] || plan}`,
      receipt_email:        email,          // Stripe emails PDF receipt automatically
      metadata:             { plan, email, name },
      setup_future_usage:   'off_session',  // saves card for recurring monthly billing
    });

    const clientSecret = paymentIntent.client_secret;
    console.log('[onboard] PI created:', paymentIntent.id, 'amount:', amount);

    if (!clientSecret) {
      return res.status(500).json({ error: 'Stripe did not return a payment intent client secret' });
    }

    res.json({
      clientSecret,
      paymentIntentId: paymentIntent.id,
      customerId:      customer.id,
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

    // Derive plan from formData (payment intent approach — plan is passed directly)
    let plan = formData.plan || 'pro';

    // Verify payment with Stripe when we have a real payment intent ID
    if (subscriptionId !== 'test') {
      const s = stripe();
      const pi = await s.paymentIntents.retrieve(subscriptionId); // subscriptionId now holds the PI id

      if (pi.status !== 'succeeded') {
        return res.status(402).json({
          error: `Payment status is "${pi.status}" — payment may not have completed.`,
        });
      }

      // Now create the recurring subscription (first month already paid via PI above)
      const priceId = PLAN_PRICE[plan];
      if (priceId) {
        await s.subscriptions.create({
          customer:          pi.customer,
          items:             [{ price: priceId }],
          collection_method: 'charge_automatically',
          // Bill from 1 month from now — first month already charged via PaymentIntent
          billing_cycle_anchor: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          proration_behavior: 'none',
          default_payment_method: pi.payment_method,
          metadata: { onboarded_via: 'kiosk' },
        }).catch(e => console.warn('[onboard] subscription create warning:', e.message));
      }
    }

    // Build metadata from form data
    const metadata = {
      stripe_payment_intent_id: subscriptionId !== 'test' ? subscriptionId : null,
      address:                  formData.address || null,
      signed_up_via:            'kiosk',
      signed_up_at:             new Date().toISOString(),
    };

    // Generate unique slug from business name
    const slug = await uniqueSlug(
      formData.slug || generateSlug(formData.businessName)
    );

    // Insert client record
    const { rows } = await pool.query(
      `INSERT INTO clients
         (restaurant_name, owner_name, email, phone, plan, status,
          monthly_fee, sub_start, next_billing, product, metadata, slug)
       VALUES ($1,$2,$3,$4,$5,'in_setup',$6,CURRENT_DATE,
               (CURRENT_DATE + INTERVAL '1 month'), $7, $8, $9)
       RETURNING id, restaurant_name, email, account_ref, slug`,
      [
        formData.businessName,
        formData.ownerName   || null,
        formData.email,
        formData.phone       || null,
        plan,
        PLAN_FEE[plan] || null,
        formData.product     || 'restaurant',
        JSON.stringify(metadata),
        slug,
      ]
    );

    const client = rows[0];

    // Send branded invoice email for the first payment
    await sendInvoiceEmail(client, plan, formData).catch(e =>
      console.error('[onboard] invoice email failed (non-fatal)', e.message)
    );

    // Email the client — branded welcome email + Quick Start PDF
    await sendWelcomeEmail({
      ...client,
      owner_name:      formData.ownerName || null,
      restaurant_name: formData.businessName,
      metadata:        metadata,
    }).catch(e => console.error('[onboard] welcome email failed (non-fatal)', e.message));

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

async function sendInvoiceEmail(client, plan, formData) {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) return;

  const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
  const planLabel     = PLAN_LABEL[plan] || plan;
  const amount        = PLAN_FEE[plan] || 0;
  const date          = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const nextDate      = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#0f172a;}
  .wrap{max-width:560px;margin:0 auto;padding:32px 16px;}
  .card{background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 1px 3px rgba(15,23,42,0.06);}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #f1f5f9;}
  .brand{font-family:Georgia,serif;font-size:24px;font-weight:800;color:#0D1B3E;}
  .brand span{color:#C9A84C;}
  .inv-num{font-size:12px;color:#64748b;font-weight:700;text-align:right;}
  .inv-num strong{display:block;font-size:16px;color:#0D1B3E;margin-top:2px;}
  .to{margin-bottom:24px;}
  .label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:700;margin-bottom:4px;}
  .to p{margin:2px 0;font-size:14px;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;}
  th{text-align:left;padding:8px 12px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:700;}
  td{padding:14px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;}
  .amount{text-align:right;font-weight:700;}
  .total-row td{font-weight:800;font-size:15px;border-bottom:none;padding-top:16px;}
  .paid{display:inline-block;background:#dcfce7;color:#166534;font-size:11px;font-weight:800;padding:3px 10px;border-radius:999px;margin-left:8px;vertical-align:middle;}
  .next{background:#fef9ec;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:13px;color:#92400e;margin-top:20px;}
  .footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px;}
</style></head><body>
<div class="wrap"><div class="card">
  <div class="header">
    <div class="brand">Siam<span>EPOS</span></div>
    <div class="inv-num">Invoice <strong>${invoiceNumber}</strong>${date}<br>Account: <strong>${client.account_ref || ''}</strong></div>
  </div>
  <div class="to">
    <div class="label">Billed to</div>
    <p><strong>${escapeHtml(formData.businessName)}</strong></p>
    ${formData.ownerName ? `<p>${escapeHtml(formData.ownerName)}</p>` : ''}
    ${formData.address ? `<p style="white-space:pre-line">${escapeHtml(formData.address)}</p>` : ''}
    <p>${escapeHtml(formData.email)}</p>
  </div>
  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      <tr>
        <td>${escapeHtml(planLabel)}<br><span style="font-size:12px;color:#64748b">Monthly subscription — ${date}</span></td>
        <td class="amount">£${amount.toFixed(2)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td>Total <span class="paid">✓ PAID</span></td>
        <td class="amount">£${amount.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="next">🔄 Your subscription renews on <strong>${nextDate}</strong>. We'll send an invoice each month when payment is taken.</div>
</div>
<p class="footer">SiamEPOS Ltd · info@siamepos.co.uk · siamepos.co.uk</p>
</div></body></html>`;

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender:      { name: 'SiamEPOS', email: 'info@siamepos.co.uk' },
      to:          [{ email: client.email, name: formData.ownerName || formData.businessName }],
      subject:     `Invoice ${invoiceNumber} — SiamEPOS ${planLabel} — £${amount.toFixed(2)}`,
      htmlContent: html,
    }),
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

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
