// SIAMPAY-002 — per-tenant SiamPay platform mode (Stripe Connect, direct
// charges). Shared by the takeaway flow (server.js) and voucherService so
// the two can never drift.
//
// A tenant's own STRIPE_SECRET_KEY always wins (existing clients unchanged).
// Platform mode needs all three env vars; the flat fee (default 10p) is
// application_fee_amount — deducted from the client's settlement, never
// added to what the customer pays. Direct charges only: the PaymentIntent
// lives ON the connected account ({ stripeAccount } request options), the
// client is merchant of record. Never transfer_data / destination charges.

function siampayCfg() {
  if (process.env.STRIPE_SECRET_KEY) return null; // own-keys tenants keep today's flow
  const key = process.env.PLATFORM_STRIPE_SECRET_KEY;
  const pk = process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY;
  const account = process.env.SIAMPAY_ACCOUNT;
  if (!key || !pk || !account) return null;
  const feePence = Math.max(0, Math.min(100, Number(process.env.SIAMPAY_FEE_PENCE ?? 10) || 0));
  return { key, pk, account, feePence };
}

module.exports = { siampayCfg };
