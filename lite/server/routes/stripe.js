// Stripe subscription billing for SiamEPOS Lite.
// Creates / manages recurring subscriptions (not transaction payments — that's SEPOS-040).
// Writes plan + stripe_subscription_id back to the restaurants table.
const express = require('express');
const pool    = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Plan → Stripe price mapping. Price IDs are created once in the Stripe
// dashboard and set as Railway env vars (STRIPE_PRICE_LITE_BOOKING etc.)
const PLAN_PRICES = {
  lite_booking:  process.env.STRIPE_PRICE_LITE_BOOKING,
  lite_ordering: process.env.STRIPE_PRICE_LITE_ORDERING,
  lite_bundle:   process.env.STRIPE_PRICE_LITE_BUNDLE,
  pro:           process.env.STRIPE_PRICE_PRO,
};

const PLAN_AMOUNTS = {
  lite_booking:  2900,   // £29
  lite_ordering: 3900,   // £39
  lite_bundle:   4900,   // £49
  pro:           8900,   // £89
};

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// POST /api/stripe/create-checkout
// Creates a Stripe Checkout Session for a subscription plan.
// Returns { url } — the frontend redirects to it.
router.post('/create-checkout', authRequired, async (req, res) => {
  const { plan } = req.body || {};
  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Valid: lite_booking, lite_ordering, lite_bundle, pro' });
  }
  const priceId = PLAN_PRICES[plan];
  if (!priceId) {
    return res.status(500).json({ error: `STRIPE_PRICE_${plan.toUpperCase()} env var not set` });
  }

  try {
    const stripe = getStripe();
    const { rows } = await pool.query(
      'SELECT * FROM restaurants WHERE restaurant_id = $1',
      [req.user.restaurantId]
    );
    const restaurant = rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Create or reuse Stripe customer
    let customerId = restaurant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    restaurant.email || req.user.email,
        name:     restaurant.name,
        metadata: { restaurant_id: req.user.restaurantId },
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE restaurants SET stripe_customer_id = $1 WHERE restaurant_id = $2',
        [customerId, req.user.restaurantId]
      );
    }

    const origin = process.env.LITE_FRONTEND_URL || 'https://lite.siamepos.co.uk';
    const session = await stripe.checkout.sessions.create({
      mode:                'subscription',
      customer:            customerId,
      line_items:          [{ price: priceId, quantity: 1 }],
      success_url:         `${origin}/dashboard?subscribed=1`,
      cancel_url:          `${origin}/onboarding?step=plan`,
      subscription_data:   { metadata: { restaurant_id: req.user.restaurantId } },
      metadata:            { restaurant_id: req.user.restaurantId, plan },
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe] create-checkout error', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/portal
// Returns a Stripe Customer Portal URL so the customer can manage / cancel.
router.post('/portal', authRequired, async (req, res) => {
  try {
    const stripe = getStripe();
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM restaurants WHERE restaurant_id = $1',
      [req.user.restaurantId]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'No billing account found' });
    const origin = process.env.LITE_FRONTEND_URL || 'https://lite.siamepos.co.uk';
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${origin}/dashboard`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook — raw body required
// Updates restaurants.plan + stripe_subscription_id on subscription events.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not set' });

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe] webhook signature failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const restaurantId = session.metadata?.restaurant_id;
        const plan         = session.metadata?.plan;
        const subId        = session.subscription;
        if (restaurantId && plan && subId) {
          await pool.query(
            `UPDATE restaurants SET plan = $1, stripe_subscription_id = $2 WHERE restaurant_id = $3`,
            [plan, subId, restaurantId]
          );
          console.log(`[stripe] plan activated: ${restaurantId} → ${plan}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub  = event.data.object;
        const rid  = sub.metadata?.restaurant_id;
        if (rid) {
          // Map Stripe price back to plan name
          const priceId = sub.items?.data?.[0]?.price?.id;
          const plan = Object.entries(PLAN_PRICES).find(([, p]) => p === priceId)?.[0];
          const status = sub.status === 'active' ? 'active' : 'suspended';
          await pool.query(
            `UPDATE restaurants SET status = $1 ${plan ? ', plan = $3' : ''}
             WHERE restaurant_id = $2`,
            plan ? [status, rid, plan] : [status, rid]
          );
          console.log(`[stripe] subscription updated: ${rid} status=${status}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const rid = sub.metadata?.restaurant_id;
        if (rid) {
          await pool.query(
            `UPDATE restaurants SET status = 'suspended', stripe_subscription_id = NULL
             WHERE restaurant_id = $1`,
            [rid]
          );
          console.log(`[stripe] subscription cancelled: ${rid}`);
        }
        break;
      }
      default:
        break;
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook handler error', err);
    return res.status(500).json({ error: 'Handler error' });
  }
});

// GET /api/stripe/plans — public pricing info for the plan picker
router.get('/plans', (req, res) => {
  return res.json([
    { id: 'lite_booking',  label: 'Booking Only',    price: 29, description: 'Online reservations widget + bookings dashboard' },
    { id: 'lite_ordering', label: 'Ordering Only',   price: 39, description: 'Online takeaway/delivery widget + orders dashboard + KDS' },
    { id: 'lite_bundle',   label: 'Bundle',          price: 49, description: 'Both booking + ordering widgets — the best value' },
    { id: 'pro',           label: 'SiamEPOS Pro',    price: 89, description: 'Full dine-in EPOS + all widgets + desktop app' },
  ]);
});

module.exports = router;
