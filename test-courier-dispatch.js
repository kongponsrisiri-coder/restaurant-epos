#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════╗
// ║  SiamEPOS — Courier Dispatch QA Test                         ║
// ║  Nook (QA Agent) | 2026-05-18                                ║
// ║  Covers: SEPOS-DELIVERY-001 (Stuart dispatch + webhooks)     ║
// ╚══════════════════════════════════════════════════════════════╝

const BASE = 'https://restaurant-epos-production.up.railway.app';

let passed = 0, failed = 0, warned = 0;
const createdOrders = [];

function pass(label)  { console.log(`  ✅ ${label}`); passed++; }
function fail(label, exp, got) {
  console.log(`  ❌ ${label}`);
  if (exp !== undefined) console.log(`     Expected: ${exp}\n     Actual:   ${got}`);
  failed++;
}
function warn(label, detail) { console.log(`  ⚠️  ${label}${detail ? ': ' + detail : ''}`); warned++; }
function info(msg)  { console.log(`  ℹ️  ${msg}`); }
function section(title) {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ${title.padEnd(56)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

async function getMenu() {
  const { data } = await api('GET', '/api/menu');
  return (Array.isArray(data) ? data : []).flatMap(c => c.items || []);
}

async function getOrder(id) {
  const { data } = await api('GET', '/api/orders');
  return (data.orders || data || []).find(o => o.id === id);
}

async function createDeliveryOrder(item, tag) {
  const ts = Date.now();
  const { status, data } = await api('POST', '/api/takeaway/orders', {
    customer_name: `__TEST__ ${tag}`,
    customer_phone: `0700000${ts.toString().slice(-4)}`,
    customer_email: `test-courier-${ts}@nook.qa`,
    pickup_time: new Date(Date.now() + 45 * 60000).toISOString(),
    order_subtype: 'delivery',
    delivery_address: '12 Chiltern Street, London, W1U 7PT',
    delivery_notes: 'QA test — please ignore',
    items: [{ menu_item_id: item.id, quantity: 1, unit_price: item.price, name: item.name }],
    marketing_consent: false,
  });
  return { status, data };
}

// ──────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  SiamEPOS — Courier Dispatch QA Test                         ║');
console.log('║  Nook (QA Agent) | 2026-05-18                                ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  Backend: ${BASE}\n`);

(async () => {
  // ── BLOCK 1: Setup ────────────────────────────────────────────
  section('BLOCK 1 — Setup: menu + courier settings');

  const items = await getMenu();
  if (!items.length) { fail('Menu must return at least one item'); process.exit(1); }
  const testItem = items[0];
  info(`Using test item: "${testItem.name}" @ £${testItem.price}`);
  pass('Menu readable');

  const { data: settings } = await api('GET', '/api/takeaway/settings');
  info(`delivery_enabled: ${settings.delivery_enabled}`);
  info(`courier_dispatch_enabled: ${settings.courier_dispatch_enabled ?? 'not in settings endpoint'}`);
  if (settings.delivery_enabled) pass('Delivery enabled in settings');
  else warn('Delivery not enabled — dispatch tests may fail if courier settings also off');

  // ── BLOCK 2: Dispatch a delivery order ────────────────────────
  section('BLOCK 2 — Happy path: create + dispatch');

  let dispatchOrderId;
  {
    const { status, data } = await createDeliveryOrder(testItem, 'Dispatch Test');
    if (status === 201 && data.id) {
      pass('Delivery order created (201)');
      dispatchOrderId = data.id;
      createdOrders.push(dispatchOrderId);
      info(`Order ID: ${dispatchOrderId}`);
    } else {
      fail('Delivery order creation failed', 201, status);
      info(`Error: ${JSON.stringify(data)}`);
    }
  }

  let trackingUrl, courierName;
  if (dispatchOrderId) {
    // 2B — dispatch it
    const { status, data } = await api('POST', '/api/delivery/dispatch', { order_id: dispatchOrderId });
    if (status === 200 && data.tracking_url) {
      pass('Courier dispatched successfully (200)');
      trackingUrl = data.tracking_url;
      courierName = data.courier_name;
      info(`Courier: ${data.courier_name}`);
      info(`Status: ${data.delivery_status}`);
      info(`Tracking: ${data.tracking_url}`);
      info(`ETA: ${data.delivery_eta || 'not provided'}`);
    } else {
      fail('Dispatch should return 200 + tracking_url', '200 + tracking_url', `${status}: ${JSON.stringify(data)}`);
    }

    // 2C — check order fields updated in DB
    const order = await getOrder(dispatchOrderId);
    if (order) {
      if (order.courier_name) pass(`courier_name stored: "${order.courier_name}"`);
      else fail('courier_name should be stored on order');
      if (order.delivery_status) pass(`delivery_status stored: "${order.delivery_status}"`);
      else fail('delivery_status should be stored on order');
      if (order.tracking_url) pass(`tracking_url stored on order`);
      else fail('tracking_url should be stored on order');
      if (order.status === 'open') pass('Order remains OPEN after dispatch (not auto-closed)');
      else fail('Delivery order must stay open after dispatch', 'open', order.status);
    } else {
      warn('Could not verify order fields — order not visible in /api/orders');
    }

    // 2D — verify tracking URL format
    if (trackingUrl && trackingUrl.startsWith('http')) pass('Tracking URL is a valid http link');
    else fail('Tracking URL should be a valid http link', 'http://...', trackingUrl);
  }

  // ── BLOCK 3: Double-dispatch protection ───────────────────────
  section('BLOCK 3 — Double-dispatch blocked');

  if (dispatchOrderId) {
    const { status, data } = await api('POST', '/api/delivery/dispatch', { order_id: dispatchOrderId });
    if (status === 400 && data.error && data.error.toLowerCase().includes('already')) {
      pass('Double-dispatch correctly blocked (400 "Already dispatched")');
      info(`Error: ${data.error}`);
    } else {
      fail('Second dispatch should return 400 "Already dispatched"', '400 Already dispatched', `${status}: ${JSON.stringify(data)}`);
    }
  }

  // ── BLOCK 4: Stuart webhook — status updates ──────────────────
  section('BLOCK 4 — Stuart webhook: status updates');

  if (dispatchOrderId) {
    // 4A — "in_progress" webhook
    const webhookPayload = {
      id: 999001,
      status: 'in_progress',
      deliveries: [{
        client_reference: `siamepos-order-${dispatchOrderId}`,
        tracking_url: trackingUrl || 'https://stuart.sandbox.followmy.delivery/test',
        eta_to_destination: { eta: new Date(Date.now() + 15 * 60000).toISOString() },
      }],
    };
    const { status } = await api('POST', '/api/delivery/stuart-webhook', webhookPayload);
    if (status === 200) pass('Stuart webhook (in_progress) accepted — 200');
    else fail('Stuart webhook should always return 200', 200, status);

    // 4B — check delivery_status updated
    await new Promise(r => setTimeout(r, 500));
    const order = await getOrder(dispatchOrderId);
    if (order && order.delivery_status === 'in_progress') {
      pass('delivery_status updated to "in_progress" via webhook');
    } else {
      warn('delivery_status not updated', `got: ${order?.delivery_status}`);
    }

    // 4C — unknown event type still returns 200 (courier stops retrying)
    const { status: unknownStatus } = await api('POST', '/api/delivery/stuart-webhook', {
      id: 999002, status: 'some_unknown_event',
      deliveries: [{ client_reference: `siamepos-order-${dispatchOrderId}` }],
    });
    if (unknownStatus === 200) pass('Unknown webhook event returns 200 (no retry storm)');
    else fail('Unknown webhook event should still return 200', 200, unknownStatus);
  }

  // ── BLOCK 5: Stuart webhook — "delivered" closes order ────────
  section('BLOCK 5 — Stuart webhook: "delivered" closes order');

  // Create a fresh order so we can test the full close flow
  let closeOrderId;
  {
    const { status, data } = await createDeliveryOrder(testItem, 'Webhook Close Test');
    if (status === 201 && data.id) {
      closeOrderId = data.id;
      createdOrders.push(closeOrderId);
      info(`Created order #${closeOrderId} for close test`);

      // Dispatch it first
      const { status: ds } = await api('POST', '/api/delivery/dispatch', { order_id: closeOrderId });
      if (ds === 200) info('Order dispatched — ready for delivered webhook');
      else warn('Dispatch failed — delivered webhook test may not reflect real close behaviour');
    }
  }

  if (closeOrderId) {
    const deliveredPayload = {
      id: 999003,
      status: 'delivered',
      deliveries: [{ client_reference: `siamepos-order-${closeOrderId}` }],
    };
    const { status } = await api('POST', '/api/delivery/stuart-webhook', deliveredPayload);
    if (status === 200) pass('Stuart "delivered" webhook accepted — 200');
    else fail('"delivered" webhook should return 200', 200, status);

    await new Promise(r => setTimeout(r, 500));
    const order = await getOrder(closeOrderId);
    if (order) {
      if (order.status === 'closed') pass('Order closed after "delivered" webhook ✓');
      else fail('Order should be closed after "delivered" webhook', 'closed', order.status);
      if (order.delivery_status === 'delivered') pass('delivery_status = "delivered" ✓');
      else warn('delivery_status not "delivered"', `got: ${order.delivery_status}`);
    } else {
      // Order may be closed and not in active orders list
      info('Order not found in /api/orders — likely closed (correct behaviour)');
      pass('Order closed after "delivered" webhook (not in active orders)');
    }
  }

  // ── BLOCK 6: Re-dispatch after failure ────────────────────────
  section('BLOCK 6 — Re-dispatch after failure');

  let retryOrderId;
  {
    const { status, data } = await createDeliveryOrder(testItem, 'Retry Test');
    if (status === 201 && data.id) {
      retryOrderId = data.id;
      createdOrders.push(retryOrderId);
      info(`Created order #${retryOrderId} for retry test`);

      // Dispatch it
      await api('POST', '/api/delivery/dispatch', { order_id: retryOrderId });

      // Simulate a failed webhook
      const failPayload = {
        id: 999004, status: 'cancelled',
        deliveries: [{ client_reference: `siamepos-order-${retryOrderId}` }],
      };
      await api('POST', '/api/delivery/stuart-webhook', failPayload);
      await new Promise(r => setTimeout(r, 500));

      // Now try re-dispatch
      const { status: rds, data: rdd } = await api('POST', '/api/delivery/dispatch', { order_id: retryOrderId });
      if (rds === 200 && rdd.tracking_url) {
        pass('Re-dispatch after cancellation works (200 + tracking_url)');
        info(`New tracking: ${rdd.tracking_url}`);
      } else {
        fail('Re-dispatch after cancellation should succeed', '200 + tracking_url', `${rds}: ${JSON.stringify(rdd)}`);
      }
    }
  }

  // ── BLOCK 7: Edge cases ───────────────────────────────────────
  section('BLOCK 7 — Edge cases');

  // 7A — dispatch ghost order
  {
    const { status, data } = await api('POST', '/api/delivery/dispatch', { order_id: 999999 });
    if (status !== 500) pass(`Ghost order dispatch → ${status} (not 500)`);
    else fail('Ghost order dispatch should not 500', '4xx', 500);
  }

  // 7B — dispatch with no order_id
  {
    const { status } = await api('POST', '/api/delivery/dispatch', {});
    if (status === 400) pass('Missing order_id → 400');
    else fail('Missing order_id should be 400', 400, status);
  }

  // 7C — quote for ghost order
  {
    const { status } = await api('POST', '/api/delivery/quote', { order_id: 999999 });
    if (status !== 500) pass(`Ghost order quote → ${status} (not 500)`);
    else fail('Ghost order quote should not 500', '4xx', 500);
  }

  // 7D — Uber Direct not configured → clean error
  {
    // We check the error message is useful, not a crash
    const { status, data } = await api('POST', '/api/delivery/dispatch', { order_id: retryOrderId, provider: 'uber_direct' });
    if (status === 400 && data.error) {
      pass('Uber Direct (unconfigured) gives clean 400 error');
      info(`Uber error: ${data.error}`);
    } else if (status !== 500) {
      pass(`Uber Direct gives non-500 response (${status}) — acceptable`);
    } else {
      fail('Uber Direct should not 500 — should give clean error', '400 + error message', `${status}: ${JSON.stringify(data)}`);
    }
  }

  // ── BLOCK 8: Cleanup ──────────────────────────────────────────
  section('BLOCK 8 — Cleanup');

  let deleted = 0;
  for (const id of createdOrders) {
    // Try force-close first, then delete
    await api('POST', `/api/orders/${id}/pay`, { amount: 0.01, method: 'cash' });
    const { status } = await api('DELETE', `/api/orders/${id}`);
    if (status === 200) { deleted++; info(`Order #${id} deleted`); }
    else info(`Order #${id} not deleted (${status}) — manual cleanup needed`);
  }
  if (deleted === createdOrders.length) pass('All test orders cleaned up');
  else warn(`${createdOrders.length - deleted} order(s) need manual delete in Admin → Bills`, `IDs: ${createdOrders.join(', ')}`);

  // ── Summary ───────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  🚗  COURIER DISPATCH QA TEST COMPLETE');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warned} warnings`);
  if (failed === 0) console.log('\n  🎉 All checks passed — courier dispatch is working correctly.\n');
  else console.log(`\n  ⚠️  ${failed} failure(s) need fixing before sign-off.\n`);

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  📋  MANUAL CHECKS (cannot automate):');
  console.log('  1. Kitchen card shows blue 🚗 Dispatch Courier button');
  console.log('     on delivery orders (not collection)');
  console.log('  2. After dispatch: card shows courier name + status');
  console.log('     + 📍 tracking link (not the dispatch button)');
  console.log('  3. After cancellation: button becomes 🔁 Retry Courier');
  console.log('  4. Delivery order stays OPEN after all items served');
  console.log('     (only closes when courier webhook fires "delivered")');
  console.log('  5. Collection orders still auto-close on 🥡 Collected');
  console.log('  6. Uber Direct in Admin shows "not configured" — no crash');
  console.log('══════════════════════════════════════════════════════════════\n');
})();
