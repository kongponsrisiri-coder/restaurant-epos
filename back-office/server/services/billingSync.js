// BO-BILLING-002 (Korakot, 18 Sep 2026) — the MRR tile was under-counting.
// The Stripe webhook activated clients and stored the subscription id, but
// never wrote the PRICE onto the card: `plan` held a raw price id (from the
// checkout link) and `monthly_fee` stayed NULL, so the card showed "—" and the
// tile summed nothing for it (Baan Rao, Baanrai). The Control Room reads Stripe
// directly and was right; ops was not.
//
// One function, called from every path that touches a subscription (webhook
// events, link-subscription, an admin "sync" button, and a boot-time backfill):
// read the live subscription, derive the monthly amount + a human plan slug +
// next billing date, and write them to the client row.
const { pool } = require('../db/pool');
const { stripe } = require('./stripeClient');

// Known monthly amounts → plan slug (what PLAN_LABEL in the UI understands).
// A Stripe price with a lookup_key wins over this table.
const AMOUNT_TO_PLAN = { 5900: 'founder', 8900: 'pro', 4900: 'spa', 500: 'website' };

function monthlyPence(item) {
  const price = item.price || {};
  const qty = item.quantity || 1;
  const amt = (price.unit_amount != null ? price.unit_amount : 0) * qty;
  const rec = price.recurring || {};
  const per = rec.interval_count || 1;
  if (rec.interval === 'year')  return Math.round(amt / (12 * per));
  if (rec.interval === 'week')  return Math.round(amt * 52 / 12 / per);
  if (rec.interval === 'day')   return Math.round(amt * 365 / 12 / per);
  return Math.round(amt / per);                      // month
}

/**
 * Sync one client's plan / monthly_fee / next_billing from its live Stripe
 * subscription. Returns { synced, monthly_fee, plan } or { synced:false, reason }.
 * Never throws — billing sync must not break a webhook or boot.
 */
async function syncClientBilling(clientId) {
  try {
    const { rows } = await pool.query(
      'SELECT id, restaurant_name, plan, monthly_fee, stripe_subscription_id, stripe_customer_id FROM clients WHERE id = $1',
      [clientId]);
    const c = rows[0];
    if (!c) return { synced: false, reason: 'no such client' };
    if (!c.stripe_subscription_id) return { synced: false, reason: 'no subscription id' };

    const sub = await stripe().subscriptions.retrieve(c.stripe_subscription_id, { expand: ['items.data.price'] });
    const items = (sub.items && sub.items.data) || [];
    if (!items.length) return { synced: false, reason: 'subscription has no items' };

    const pence = items.reduce((s, it) => s + monthlyPence(it), 0);
    const monthly_fee = Math.round(pence) / 100;
    const first = items[0].price || {};
    // Plan slug: Stripe lookup_key → known amount → keep whatever the card has
    // (a raw price id is still resolvable by the UI's fallback label).
    const plan = first.lookup_key || AMOUNT_TO_PLAN[pence] || c.plan || first.id;
    const periodEnd = sub.current_period_end || items[0].current_period_end;
    const next_billing = periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null;

    await pool.query(
      `UPDATE clients SET monthly_fee = $2, plan = $3,
         next_billing = COALESCE($4, next_billing),
         stripe_customer_id = COALESCE(stripe_customer_id, $5)
       WHERE id = $1`,
      [c.id, monthly_fee, plan, next_billing, typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null]);
    console.log(`[billing-sync] ${c.restaurant_name}: plan=${plan} £${monthly_fee}/mo next=${next_billing || '—'}`);
    return { synced: true, monthly_fee, plan, next_billing };
  } catch (err) {
    console.warn(`[billing-sync] client ${clientId}: ${err.message}`);
    return { synced: false, reason: err.message };
  }
}

/** Find the client row for a Stripe subscription/customer and sync it. */
async function syncBySubscription({ subscriptionId, customerId }) {
  const r = subscriptionId
    ? await pool.query('SELECT id FROM clients WHERE stripe_subscription_id = $1', [subscriptionId])
    : { rows: [] };
  const rows = r.rows.length || !customerId ? r.rows
    : (await pool.query('SELECT id FROM clients WHERE stripe_customer_id = $1', [customerId])).rows;
  const out = [];
  for (const row of rows) out.push(await syncClientBilling(row.id));
  return out;
}

/**
 * Backfill: every client with a subscription id whose card has no fee (or a
 * raw price id as the plan). Runs once at boot, and behind the admin
 * "sync all" endpoint. Cheap — one Stripe read per affected client.
 */
async function syncAllStale({ all = false } = {}) {
  if (!process.env.STRIPE_SECRET_KEY) return { skipped: 'no STRIPE_SECRET_KEY' };
  const { rows } = await pool.query(all
    ? `SELECT id FROM clients WHERE stripe_subscription_id IS NOT NULL`
    : `SELECT id FROM clients WHERE stripe_subscription_id IS NOT NULL
        AND (monthly_fee IS NULL OR monthly_fee = 0 OR plan LIKE 'price_%')`);
  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await syncClientBilling(r.id)) });
  const n = results.filter(x => x.synced).length;
  if (rows.length) console.log(`[billing-sync] backfill: ${n}/${rows.length} clients synced`);
  return { checked: rows.length, synced: n, results };
}

module.exports = { syncClientBilling, syncBySubscription, syncAllStale };
