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
const AMOUNT_TO_PLAN = { 5900: 'founder', 8900: 'pro', 4900: 'spa', 3900: 'ordering', 500: 'website' };
const LIVE = new Set(['active', 'trialing', 'past_due']);

// Korakot's hand-verified Stripe customer → ops slug map (the Control Room's
// "Your reference" column, client-notes.json, 18 Sep 2026). Used ONLY when a
// card can't be matched by subscription id, customer id or email — the
// customers below pay from a different email than the one on their card.
// The Attach button on the card supersedes this; add here when a new client
// pays from an unrelated email.
const CUSTOMER_TO_SLUG = {
  cus_VHTyEZbirSIydt: 'baanrao',      // On-anan Davies — Baan Rao Thai Cuisine
  cus_VD5KehGqGbgjcY: 'akin-thai',    // Jaranthon Intapad — Akin Thai (Lite Ordering £39)
  cus_V8h3s4uhHZaz2n: 'yumyum',       // Den Vachum — Yum Yum Thai Bath
  cus_V667MJl8AJseLK: 'fern',         // CJ Allen — Fern Modern Sushi
  cus_Urnio6Ci6qFcRw: 'thannthai',    // Thann Thai Ltd
  cus_Uo61rGaAFG3T8I: 'chart-thai',   // Chart Thai Pinner
  cus_UwOujs00lCbSKC: 'highbury-massage',
  cus_UwMjaaEVEu1t0O: 'jinta',
};

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
 * The LIVE subscription for a client — never a canceled one (Akin's card was
 * linked to its canceled £5 website sub while the £39 ordering sub was live).
 * Order: the linked sub if live → another live sub on the same customer →
 * a live sub on any Stripe customer with the client's email.
 */
async function findLiveSubscription(c) {
  const s = stripe();
  const expand = ['items.data.price'];
  if (c.stripe_subscription_id) {
    try {
      const sub = await s.subscriptions.retrieve(c.stripe_subscription_id, { expand });
      if (LIVE.has(sub.status)) return sub;
      const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
      if (cust) {
        const list = await s.subscriptions.list({ customer: cust, status: 'all', limit: 20, expand: ['data.items.data.price'] });
        const live = list.data.find(x => LIVE.has(x.status));
        if (live) return live;
      }
    } catch (e) { console.warn(`[billing-sync] linked sub ${c.stripe_subscription_id} unreadable: ${e.message}`); }
  }
  if (c.stripe_customer_id) {
    const list = await s.subscriptions.list({ customer: c.stripe_customer_id, status: 'all', limit: 20, expand: ['data.items.data.price'] });
    const live = list.data.find(x => LIVE.has(x.status));
    if (live) return live;
  }
  if (c.email) {
    const customers = await s.customers.list({ email: String(c.email).trim(), limit: 10 });
    for (const cu of customers.data) {
      const list = await s.subscriptions.list({ customer: cu.id, status: 'all', limit: 20, expand: ['data.items.data.price'] });
      const live = list.data.find(x => LIVE.has(x.status));
      if (live) return live;
    }
  }
  // Last resort: the verified customer → slug map.
  if (c.slug) {
    const cust = Object.keys(CUSTOMER_TO_SLUG).find(k => CUSTOMER_TO_SLUG[k] === c.slug);
    if (cust) {
      const list = await s.subscriptions.list({ customer: cust, status: 'all', limit: 20, expand: ['data.items.data.price'] });
      const live = list.data.find(x => LIVE.has(x.status));
      if (live) return live;
    }
  }
  return null;
}

/**
 * Sync one client's plan / monthly_fee / next_billing from its LIVE Stripe
 * subscription (and re-point the card at it if the linked one went stale).
 * Returns { synced, monthly_fee, plan } or { synced:false, reason }.
 * Never throws — billing sync must not break a webhook or boot.
 */
async function syncClientBilling(clientId) {
  try {
    const { rows } = await pool.query(
      'SELECT id, restaurant_name, email, slug, plan, monthly_fee, stripe_subscription_id, stripe_customer_id FROM clients WHERE id = $1',
      [clientId]);
    const c = rows[0];
    if (!c) return { synced: false, reason: 'no such client' };

    const sub = await findLiveSubscription(c);
    if (!sub) return { synced: false, reason: 'no live Stripe subscription for this client (card left untouched)' };
    const items = (sub.items && sub.items.data) || [];
    if (!items.length) return { synced: false, reason: 'subscription has no items' };

    const pence = items.reduce((t, it) => t + monthlyPence(it), 0);
    const monthly_fee = Math.round(pence) / 100;
    const first = items[0].price || {};
    // Plan slug: Stripe lookup_key → known amount → the price id (UI shows the fee for those).
    const plan = first.lookup_key || AMOUNT_TO_PLAN[pence] || first.id;
    const periodEnd = sub.current_period_end || items[0].current_period_end;
    const next_billing = periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null;
    const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null;

    await pool.query(
      `UPDATE clients SET monthly_fee = $2, plan = $3,
         next_billing = COALESCE($4, next_billing),
         stripe_subscription_id = $5,
         stripe_customer_id = COALESCE($6, stripe_customer_id),
         status = CASE WHEN status IN ('setup', 'trial', 'churned', 'past_due') THEN 'active' ELSE status END
       WHERE id = $1`,
      [c.id, monthly_fee, plan, next_billing, sub.id, customerId]);
    if (c.stripe_subscription_id && c.stripe_subscription_id !== sub.id)
      console.log(`[billing-sync] ${c.restaurant_name}: re-linked ${c.stripe_subscription_id} → ${sub.id} (live)`);
    console.log(`[billing-sync] ${c.restaurant_name}: plan=${plan} £${monthly_fee}/mo next=${next_billing || '—'}`);
    return { synced: true, monthly_fee, plan, next_billing, subscription_id: sub.id };
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
 * Backfill at boot and behind the admin "sync all" endpoint: every card is
 * re-read from its LIVE subscription; cards with none are left untouched.
 */
async function syncAllStale({ all = false } = {}) {
  if (!process.env.STRIPE_SECRET_KEY) return { skipped: 'no STRIPE_SECRET_KEY' };
  // Every card that could have a subscription: linked, or matchable by email.
  // Cards with no live sub are left exactly as they are.
  const { rows } = await pool.query(
    `SELECT id FROM clients WHERE stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL OR email IS NOT NULL OR slug IS NOT NULL`);
  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await syncClientBilling(r.id)) });
  const n = results.filter(x => x.synced).length;
  if (rows.length) console.log(`[billing-sync] backfill: ${n}/${rows.length} clients synced`);
  return { checked: rows.length, synced: n, results };
}

module.exports = { syncClientBilling, syncBySubscription, syncAllStale, findLiveSubscription };
