// BO-FOUNDER-002 — shared lazy-init Stripe client.
// Single source so the onboard kiosk, the cancel-subscription endpoint, and
// the webhook all use the same configured instance. Lazy so a missing
// STRIPE_SECRET_KEY doesn't crash the whole server on boot — it only throws
// when a Stripe call is actually attempted.

let _stripe = null;

function stripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured on this service');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

module.exports = { stripe };
