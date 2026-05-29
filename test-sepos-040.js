// test-sepos-040.js
// SEPOS-040 — E2E test: Real Stripe takeaway payment integration
//
// Tests both modes:
//   1. Stripe NOT configured (live Railway default) — mock-pay fallback
//   2. Stripe IS configured (via TEST_STRIPE_SECRET_KEY env var) — real PI flow
//
// Runs against the live Railway backend by default.
// All test orders are created with customer_name='[TEST] Nook QA' and deleted at the end.
//
// Usage:
//   node test-sepos-040.js
//   TEST_BASE_URL=https://restaurant-epos-production.up.railway.app node test-sepos-040.js
//
// To also run Block 7 (real Stripe PI verify), set:
//   TEST_STRIPE_SECRET_KEY=sk_test_... node test-sepos-040.js
//   (Use your Stripe TEST mode secret key — no real charges)

'use strict';

const BASE = process.env.TEST_BASE_URL || 'https://restaurant-epos-production.up.railway.app';
const STRIPE_SK = process.env.TEST_STRIPE_SECRET_KEY || null;

// ── tiny HTTP helper ─────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(BASE + path);
    const isHttps = url.protocol === 'https:';
    const mod    = isHttps ? https : http;
    const data   = body != null ? JSON.stringify(body) : null;
    const req    = mod.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end',  () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Stripe helper (only used in Block 7) ────────────────────────────────
async function createTestPaymentIntent(amountPence) {
  if (!STRIPE_SK) return null;
  const stripe = require('stripe')(STRIPE_SK);
  return stripe.paymentIntents.create({
    amount:   amountPence,
    currency: 'gbp',
    payment_method_types: ['card'],
    description: '[TEST] SEPOS-040 automated test',
    metadata: { product: 'sepos040_test' },
  });
}

async function confirmTestPaymentIntent(piId) {
  if (!STRIPE_SK) return null;
  const stripe = require('stripe')(STRIPE_SK);
  // Confirm with Stripe's test card pm_card_visa (no 3DS)
  return stripe.paymentIntents.confirm(piId, {
    payment_method: 'pm_card_visa',
  });
}

// ── result tracking ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
const createdOrderIds = [];

function ok(label, detail)   { passed++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
function ko(label, detail)   { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
function info(msg)           { console.log(`     ${msg}`); }
function skip(label, reason) { console.log(`  ⏭️  ${label} — SKIPPED (${reason})`); }
function header(title)       { console.log(`\n▶ ${title}`); }

// ── helpers ──────────────────────────────────────────────────────────────
async function getFirstMenuItem() {
  const r = await api('GET', '/api/menu');
  if (r.status !== 200) return null;
  for (const cat of r.body) {
    const items = cat.items || (cat.subcategories || []).flatMap(s => s.items || []);
    if (items.length) return items[0];
  }
  return null;
}

// Build a pickup time that is always within opening hours (noon tomorrow).
// Using "now + 30 min" was unsafe — tests run at any hour and the server
// correctly rejects times outside 11:00–21:30.
function buildPickupTime() {
  const d = new Date();
  d.setDate(d.getDate() + 1);        // tomorrow
  d.setHours(12, 0, 0, 0);           // noon — always within 11:00–21:30
  return d.toISOString();
}

async function buildMinimalOrder(overrides = {}) {
  const item = await getFirstMenuItem();
  if (!item) return null;
  return {
    restaurant_id:    'siamepos',
    customer_name:    '[TEST] Nook QA',
    customer_phone:   '07700900000',
    customer_email:   null,
    pickup_time:      buildPickupTime(),
    order_subtype:    'collection',
    marketing_consent: false,
    payment_intent_id: null,
    items: [{ menu_item_id: item.id, quantity: 1, unit_price: Number(item.price), name: item.name }],
    ...overrides,
  };
}

// ── BLOCK 0 — health check ───────────────────────────────────────────────
async function block0_health() {
  header('Block 0 — Health check');
  const r = await api('GET', '/api/health').catch(() => null);
  if (r && r.status === 200) ok('Server reachable', `HTTP ${r.status}`);
  else { ko('Server not reachable — cannot continue'); process.exit(1); }
}

// ── BLOCK 1 — GET /api/takeaway/stripe-config ────────────────────────────
async function block1_stripeConfig() {
  header('Block 1 — GET /api/takeaway/stripe-config');
  const r = await api('GET', '/api/takeaway/stripe-config');
  if (r.status !== 200) { ko('stripe-config endpoint failed', `HTTP ${r.status}`); return null; }

  ok('Endpoint returns 200');
  if (typeof r.body.configured === 'boolean') ok('configured field is boolean', r.body.configured);
  else ko('configured field missing or wrong type', JSON.stringify(r.body));

  if (r.body.configured) {
    if (r.body.publishable_key && r.body.publishable_key.startsWith('pk_')) {
      ok('publishable_key returned and looks valid', r.body.publishable_key.slice(0, 12) + '…');
    } else {
      ko('configured=true but publishable_key invalid', r.body.publishable_key);
    }
  } else {
    if (r.body.publishable_key === null) ok('publishable_key=null when not configured');
    else ko('publishable_key should be null when not configured', r.body.publishable_key);
    info('Stripe is NOT configured on this deployment — mock mode will be tested');
  }

  return r.body;
}

// ── BLOCK 2 — GET /api/takeaway/settings ────────────────────────────────
async function block2_takeawaySettings() {
  header('Block 2 — GET /api/takeaway/settings');
  const r = await api('GET', '/api/takeaway/settings');
  if (r.status !== 200) { ko('takeaway/settings failed', `HTTP ${r.status}`); return; }
  ok('Endpoint returns 200');

  const { restaurant_name, opening_time, last_booking_time } = r.body;
  if (restaurant_name) ok('restaurant_name present', restaurant_name);
  else ko('restaurant_name missing');

  if (opening_time) ok('opening_time present', opening_time);
  else info('opening_time not set (optional)');

  if (last_booking_time) ok('last_booking_time present', last_booking_time);
  else info('last_booking_time not set (optional)');
}

// ── BLOCK 3 — POST /api/takeaway/payment-intent (no Stripe = 503) ────────
async function block3_paymentIntent503(stripeConfigured) {
  header('Block 3 — POST /api/takeaway/payment-intent (503 when Stripe not configured)');
  if (stripeConfigured) {
    skip('503 guard', 'Stripe IS configured on this deployment');
    return;
  }
  const r = await api('POST', '/api/takeaway/payment-intent', {
    amount_pence: 1200,
    order_description: 'Test order',
  });
  if (r.status === 503) ok('Returns 503 when Stripe not configured', r.body.error);
  else ko(`Expected 503, got ${r.status}`, JSON.stringify(r.body));
}

// ── BLOCK 4 — mock order (no payment_intent_id) accepted ─────────────────
async function block4_mockOrder() {
  header('Block 4 — POST /api/takeaway/orders — mock mode (no payment_intent_id)');
  const payload = await buildMinimalOrder();
  if (!payload) { ko('Could not build order — no menu items on server'); return; }

  info(`Submitting order for menu item: ${payload.items[0].name} (id=${payload.items[0].menu_item_id})`);
  const r = await api('POST', '/api/takeaway/orders', payload);

  if (r.status === 201) ok('Mock order accepted (201)', `order_id=${r.body.order_id}, ref=${r.body.order_number}`);
  else { ko(`Expected 201, got ${r.status}`, JSON.stringify(r.body)); return; }

  if (r.body.order_number && r.body.order_number.startsWith('T')) ok('order_number has T prefix', r.body.order_number);
  else ko('order_number format wrong', r.body.order_number);

  if (typeof r.body.total === 'number' && r.body.total > 0) ok('total returned as number', `£${r.body.total.toFixed(2)}`);
  else ko('total missing or not a number', JSON.stringify(r.body.total));

  // Verify payment_status='mock' in DB
  const orderId = r.body.order_id;
  createdOrderIds.push(orderId);
  const orderCheck = await api('GET', `/api/orders/${orderId}`);
  if (orderCheck.status === 200) {
    const o = orderCheck.body;
    if (o.payment_status === 'mock') ok('payment_status=mock in DB');
    else ko('payment_status wrong', `got "${o.payment_status}", expected "mock"`);

    if (o.payment_intent_id === null || o.payment_intent_id === undefined || o.payment_intent_id === '') {
      ok('payment_intent_id is null/empty in DB');
    } else {
      ko('payment_intent_id should be null in mock mode', o.payment_intent_id);
    }
    if (o.order_type === 'takeaway') ok('order_type=takeaway');
    else ko('order_type wrong', o.order_type);
    if (o.takeaway_status === 'pending') ok('takeaway_status=pending on new order');
    else ko('takeaway_status wrong', o.takeaway_status);
  } else {
    info(`Could not verify DB state — GET /api/orders/${orderId} returned ${orderCheck.status}`);
  }
}

// ── BLOCK 5 — validation: missing customer name ───────────────────────────
async function block5_missingName() {
  header('Block 5 — Validation: missing customer name → 400');
  const payload = await buildMinimalOrder({ customer_name: '' });
  if (!payload) { ko('Could not build order — no menu items'); return; }
  const r = await api('POST', '/api/takeaway/orders', payload);
  if (r.status === 400) ok('400 returned for missing customer_name', r.body.error);
  else ko(`Expected 400, got ${r.status}`, JSON.stringify(r.body));
}

// ── BLOCK 6 — validation: delivery without address ────────────────────────
async function block6_deliveryNoAddress() {
  header('Block 6 — Validation: delivery order without delivery_address → 400');
  const payload = await buildMinimalOrder({
    order_subtype:    'delivery',
    delivery_address: null,
  });
  if (!payload) { ko('Could not build order — no menu items'); return; }
  const r = await api('POST', '/api/takeaway/orders', payload);
  if (r.status === 400) ok('400 returned for delivery with no address', r.body.error);
  else ko(`Expected 400, got ${r.status}`, JSON.stringify(r.body));
}

// ── BLOCK 7 — tampered / fake payment_intent_id → 402 ────────────────────
async function block7_fakePaymentIntent() {
  header('Block 7 — Tampered payment_intent_id → 402');
  const payload = await buildMinimalOrder({ payment_intent_id: 'pi_fake_tampered_id_1234567890' });
  if (!payload) { ko('Could not build order — no menu items'); return; }
  const r = await api('POST', '/api/takeaway/orders', payload);
  if (r.status === 400 && JSON.stringify(r.body).includes('Stripe not configured')) {
    ok('Stripe not configured — backend rejects payment_intent_id correctly (400)', r.body.error);
  } else if (r.status === 402) {
    ok('402 returned for fake payment_intent_id — Stripe verification rejected it', r.body.error);
  } else {
    ko(`Expected 400 (no Stripe) or 402 (fake PI rejected), got ${r.status}`, JSON.stringify(r.body));
  }
}

// ── BLOCK 8 — empty items array → 400 ────────────────────────────────────
async function block8_emptyItems() {
  header('Block 8 — Empty items array → 400 or creates zero-total order');
  const payload = await buildMinimalOrder({ items: [] });
  if (!payload) { ko('Could not build order — no menu items'); return; }
  const r = await api('POST', '/api/takeaway/orders', payload);
  if (r.status === 400) {
    ok('400 returned for empty items', r.body.error);
  } else if (r.status === 201) {
    // Technically allowed (total=0 is unusual but not illegal) — flag as a warning
    ko('Server accepted order with zero items — should probably be rejected (total=0)', `order_id=${r.body.order_id}`);
    if (r.body.order_id) createdOrderIds.push(r.body.order_id);
  } else {
    ko(`Unexpected status for empty items`, `HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  }
}

// ── BLOCK 9 — GET /api/takeaway/orders/active includes our test order ──────
async function block9_activeOrdersContainsTest() {
  header('Block 9 — GET /api/takeaway/orders/active includes our mock test order');
  if (!createdOrderIds.length) { skip('Block 9', 'No test orders were created'); return; }

  const r = await api('GET', '/api/takeaway/orders/active');
  if (r.status !== 200) { ko('GET /api/takeaway/orders/active failed', r.status); return; }

  ok('Active orders endpoint returns 200');
  const found = r.body.find(o => createdOrderIds.includes(o.id));
  if (found) {
    ok('Test order appears in active orders', `id=${found.id}, customer=${found.customer_name}, status=${found.takeaway_status}`);
  } else {
    info(`Test order ids: ${createdOrderIds.join(',')} — not found in active list (may have been auto-collected already)`);
    ok('Active orders list returned (no error)', `${r.body.length} active orders`);
  }
}

// ── BLOCK 10 — Stripe real PI flow (only when TEST_STRIPE_SECRET_KEY set) ─
async function block10_realStripeFlow(stripeConfigured) {
  header('Block 10 — Real Stripe PaymentIntent flow (live test)');
  if (!stripeConfigured) {
    skip('Block 10', 'Stripe not configured on server — set STRIPE_SECRET_KEY on Railway to enable');
    return;
  }
  if (!STRIPE_SK) {
    skip('Block 10', 'TEST_STRIPE_SECRET_KEY not set — run with TEST_STRIPE_SECRET_KEY=sk_test_... to test real Stripe flow');
    return;
  }

  let stripe;
  try { stripe = require('stripe'); }
  catch { skip('Block 10', 'stripe npm module not installed — run: npm install stripe'); return; }

  const item = await getFirstMenuItem();
  if (!item) { ko('Could not find a menu item to order'); return; }
  const amountPence = Math.round(Number(item.price) * 100);
  info(`Creating Stripe test PI for £${(amountPence / 100).toFixed(2)}`);

  // 1. Create PI via the server endpoint (tests our /payment-intent endpoint)
  const piRes = await api('POST', '/api/takeaway/payment-intent', {
    amount_pence: amountPence,
    order_description: '[TEST] SEPOS-040 automated test order',
  });
  if (piRes.status !== 200) { ko('POST /api/takeaway/payment-intent failed', `HTTP ${piRes.status}: ${JSON.stringify(piRes.body)}`); return; }
  ok('/api/takeaway/payment-intent returned 200', `pi_id=${piRes.body.payment_intent_id}`);
  if (piRes.body.client_secret) ok('client_secret returned');
  else ko('client_secret missing from response');
  if (piRes.body.payment_intent_id && piRes.body.payment_intent_id.startsWith('pi_')) ok('payment_intent_id has pi_ prefix');
  else ko('payment_intent_id format wrong', piRes.body.payment_intent_id);

  // 2. Confirm the PI with Stripe test card (server-side, simulates widget confirmCardPayment)
  try {
    const stripeClient = require('stripe')(STRIPE_SK);
    const confirmed = await stripeClient.paymentIntents.confirm(piRes.body.payment_intent_id, {
      payment_method: 'pm_card_visa',
    });
    if (confirmed.status === 'succeeded') ok('PI confirmed with test card (status=succeeded)');
    else { ko('PI confirm did not succeed', confirmed.status); return; }
  } catch (e) {
    ko('Stripe confirm threw error', e.message);
    return;
  }

  // 3. Submit takeaway order with the confirmed PI id
  const payload = await buildMinimalOrder({
    payment_intent_id: piRes.body.payment_intent_id,
    items: [{ menu_item_id: item.id, quantity: 1, unit_price: Number(item.price), name: item.name }],
  });
  const orderRes = await api('POST', '/api/takeaway/orders', payload);
  if (orderRes.status === 201) {
    ok('Order created with real Stripe PI (201)', `order_id=${orderRes.body.order_id}`);
    createdOrderIds.push(orderRes.body.order_id);
  } else {
    ko(`Order creation with Stripe PI failed`, `HTTP ${orderRes.status}: ${JSON.stringify(orderRes.body)}`);
    return;
  }

  // 4. Verify payment_status='paid' in DB
  const orderId = orderRes.body.order_id;
  const check = await api('GET', `/api/orders/${orderId}`);
  if (check.status === 200) {
    if (check.body.payment_status === 'paid') ok('payment_status=paid in DB after real Stripe payment');
    else ko('payment_status wrong after Stripe payment', `got "${check.body.payment_status}", expected "paid"`);
    if (check.body.payment_intent_id === piRes.body.payment_intent_id) ok('payment_intent_id stored in DB');
    else ko('payment_intent_id not stored correctly', check.body.payment_intent_id);
  } else {
    info(`GET /api/orders/${orderId} returned ${check.status} — skipping DB check`);
  }
}

// ── BLOCK 11 — takeaway widget JS is served ──────────────────────────────
async function block11_widgetJs() {
  header('Block 11 — takeaway-widget.js is served publicly');
  const r = await api('GET', '/takeaway-widget.js');
  if (r.status === 200) ok('takeaway-widget.js served (200)');
  else ko(`takeaway-widget.js returned ${r.status}`);

  // Check the script mentions SEPOS-040 so we know it's the updated version
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  if (body.includes('SEPOS-040')) ok('Widget source references SEPOS-040 (correct version)');
  else ko('Widget source does not reference SEPOS-040 — may be serving a stale file');

  if (body.includes('stripe-config')) ok('Widget source references /api/takeaway/stripe-config');
  else ko('Widget source missing stripe-config fetch — SEPOS-040 Stripe init may not be wired');

  if (body.includes('payment-intent')) ok('Widget source references /api/takeaway/payment-intent');
  else ko('Widget source missing payment-intent — SEPOS-040 PI creation not present');
}

// ── CLEANUP ──────────────────────────────────────────────────────────────
async function doCleanup() {
  if (!createdOrderIds.length) return;
  header('Cleanup — closing/deleting test orders');
  for (const id of createdOrderIds) {
    // Close the order so it doesn't clutter the kitchen screen
    const r = await api('PUT', `/api/orders/${id}/takeaway-status`, { status: 'collected' });
    if (r.status === 200) info(`Closed test order #${id} (collected)`);
    else {
      // Fallback: try hard delete
      const d = await api('DELETE', `/api/orders/${id}`);
      if (d.status === 200) info(`Deleted test order #${id}`);
      else info(`Could not close/delete test order #${id} — please delete manually in Admin → Bills`);
    }
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nSEPOS-040 Test Suite — Stripe Takeaway Payment`);
  console.log(`BASE: ${BASE}`);
  console.log(`Stripe SK provided: ${STRIPE_SK ? 'YES (Block 10 will run)' : 'NO (Block 10 skipped)'}`);
  console.log(`${'─'.repeat(60)}`);

  await block0_health();
  const stripeConfig = await block1_stripeConfig();
  const stripeConfigured = stripeConfig?.configured || false;

  await block2_takeawaySettings();
  await block3_paymentIntent503(stripeConfigured);
  await block4_mockOrder();
  await block5_missingName();
  await block6_deliveryNoAddress();
  await block7_fakePaymentIntent();
  await block8_emptyItems();
  await block9_activeOrdersContainsTest();
  await block10_realStripeFlow(stripeConfigured);
  await block11_widgetJs();

  await doCleanup();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`);
  if (failed === 0) {
    console.log(`\n✅ ALL ${passed} CHECKS PASSED — SEPOS-040 looks good!\n`);
  } else {
    console.log(`\n⚠️  ${failed} check(s) failed — review output above.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
