// BO-FOUNDER-002 — Stripe webhook. Keeps the back-office client status in
// sync with Stripe so failed / cancelled payments flip the client without
// anyone watching the Stripe dashboard.
//
// IMPORTANT: this router is mounted in server.js BEFORE the global
// express.json() middleware and uses express.raw() so the raw request body
// is available for signature verification. Stripe's constructEvent() rejects
// a body that has already been JSON-parsed.
//
// Requires STRIPE_WEBHOOK_SECRET (the "Signing secret" shown when you create
// the endpoint in the Stripe Dashboard → Developers → Webhooks). Without it
// we can't verify authenticity, so we reject every event.

const express = require('express');
const router  = express.Router();
const { pool } = require('../db/pool');
const { stripe } = require('../services/stripeClient');

// Map a client row from either the subscription id (preferred) or the
// customer id, then set its status. Returns the affected row count.
async function setClientStatus({ subscriptionId, customerId }, status) {
  let result;
  if (subscriptionId) {
    result = await pool.query(
      'UPDATE clients SET status = $1 WHERE stripe_subscription_id = $2 RETURNING id, restaurant_name',
      [status, subscriptionId]
    );
    if (result.rows.length) return result;
  }
  if (customerId) {
    result = await pool.query(
      'UPDATE clients SET status = $1 WHERE stripe_customer_id = $2 RETURNING id, restaurant_name',
      [status, customerId]
    );
    if (result.rows.length) return result;
  }
  return { rows: [] };
}

router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting event');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    const sig = req.get('stripe-signature');
    event = stripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed` });
  }

  try {
    const obj = event.data.object;

    switch (event.type) {
      // Recurring charge failed → flag the client so the team can chase it.
      case 'invoice.payment_failed': {
        const r = await setClientStatus(
          { subscriptionId: obj.subscription, customerId: obj.customer },
          'past_due'
        );
        console.log(`[stripe-webhook] invoice.payment_failed → past_due (${r.rows.length} client matched)`);
        break;
      }

      // Payment recovered → move the client back to active.
      case 'invoice.payment_succeeded': {
        // Only react to subscription invoices (skip the one-off first-month PI).
        if (obj.billing_reason && obj.billing_reason.startsWith('subscription')) {
          const r = await setClientStatus(
            { subscriptionId: obj.subscription, customerId: obj.customer },
            'active'
          );
          console.log(`[stripe-webhook] invoice.payment_succeeded → active (${r.rows.length} client matched)`);
        }
        break;
      }

      // Subscription cancelled (by us, by Stripe after dunning, or by the customer).
      case 'customer.subscription.deleted': {
        const r = await setClientStatus(
          { subscriptionId: obj.id, customerId: obj.customer },
          'churned'
        );
        console.log(`[stripe-webhook] subscription.deleted → churned (${r.rows.length} client matched)`);
        break;
      }

      // Status transitions (past_due, unpaid, canceled, active…).
      case 'customer.subscription.updated': {
        const map = { active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'churned' };
        const next = map[obj.status];
        if (next) {
          const r = await setClientStatus({ subscriptionId: obj.id, customerId: obj.customer }, next);
          console.log(`[stripe-webhook] subscription.updated status=${obj.status} → ${next} (${r.rows.length} client matched)`);
        }
        break;
      }

      default:
        // Ignore everything else — Stripe sends many event types we don't use.
        break;
    }
  } catch (err) {
    // Log but still 200 so Stripe doesn't hammer us with retries for a bug
    // on our side — the event is already verified and recorded in Stripe.
    console.error('[stripe-webhook] handler error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
