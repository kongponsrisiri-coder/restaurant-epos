#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════╗
// ║  SiamEPOS — Delivery QA Test                                 ║
// ║  Nook (QA Agent) | 2026-05-18                                ║
// ║  Covers: SEPOS-DELIVERY-002 + radius check                   ║
// ╚══════════════════════════════════════════════════════════════╝

const BASE = 'https://restaurant-epos-production.up.railway.app';

let passed = 0, failed = 0, warned = 0;
const createdOrders = [];

function pass(label) { console.log(`  ✅ ${label}`); passed++; }
function fail(label, exp, got) {
  console.log(`  ❌ ${label}`);
  if (exp !== undefined) console.log(`     Expected: ${exp}\n     Actual:   ${got}`);
  failed++;
}
function warn(label, detail) { console.log(`  ⚠️  ${label}${detail ? ': ' + detail : ''}`); warned++; }
function info(msg) { console.log(`  ℹ️  ${msg}`); }
function section(title) {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ${title.padEnd(56)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

// ── Helpers ───────────────────────────────────────────────────
async function getSettings() {
  const { data } = await api('GET', '/api/takeaway/settings');
  return data;
}

async function getMenu() {
  const { data } = await api('GET', '/api/menu');
  const items = (Array.isArray(data) ? data : [])
    .flatMap(c => c.items || []);
  return items;
}

async function getCustomers() {
  const { data } = await api('GET', '/api/customers');
  return data.customers || data || [];
}

// ── MAIN ──────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SiamEPOS — Delivery QA Test                                 ║');
  console.log('║  Nook (QA Agent) | 2026-05-18                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Backend: ${BASE}`);

  // ── BLOCK 1: Read live settings ───────────────────────────
  section('BLOCK 1 — Read delivery settings & menu');

  const settings = await getSettings();
  info(`delivery_enabled: ${settings.delivery_enabled}`);
  info(`delivery_radius_miles: ${settings.delivery_radius_miles}`);

  if (settings.delivery_enabled) {
    pass('Delivery is enabled (restaurant_postcode + radius configured)');
  } else {
    warn('Delivery toggle is OFF — radius check tests will use a forced postcode pair');
    info('Set Admin → Settings → 🚗 Online Delivery to enable delivery for full test');
  }

  const menuItems = await getMenu();
  if (menuItems.length > 0) {
    pass(`Menu readable — ${menuItems.length} orderable items`);
  } else {
    fail('Menu returned no orderable items');
  }

  const testItem = menuItems[0];
  info(`Using test item: "${testItem.name}" @ £${testItem.price}`);

  // ── BLOCK 2: Delivery radius check ────────────────────────
  section('BLOCK 2 — Delivery radius check (GET /api/takeaway/delivery-check)');

  // 2A — no postcode
  {
    const { status } = await api('GET', '/api/takeaway/delivery-check');
    if (status === 400) pass('No postcode → 400 Bad Request');
    else fail('No postcode should be 400', 400, status);
  }

  // 2B — invalid postcode
  {
    const { status, data } = await api('GET', '/api/takeaway/delivery-check?postcode=ZZZZZZ');
    if (status === 200 && data.deliverable === false) pass('Invalid postcode → deliverable: false');
    else fail('Invalid postcode should return deliverable:false', 'deliverable:false', JSON.stringify(data));
  }

  // 2C — in-area postcode (nearby street, ~0.4 miles from a Soho restaurant)
  {
    const { status, data } = await api('GET', '/api/takeaway/delivery-check?postcode=W1B%203HH');
    info(`W1B3HH (Oxford Circus): deliverable=${data.deliverable}, distance=${data.distance_miles} miles, radius=${data.radius_miles} miles`);
    if (status === 200 && typeof data.deliverable === 'boolean') pass('Radius check returns deliverable boolean + distance');
    else fail('Radius check response malformed', 'deliverable boolean', JSON.stringify(data));
    if (data.deliverable) pass('W1B3HH is within delivery radius');
    else info('W1B3HH is outside delivery radius (expected if restaurant postcode differs)');
  }

  // 2D — far postcode (Canary Wharf — ~5 miles, same city but clearly outside a local delivery radius)
  {
    const { status, data } = await api('GET', '/api/takeaway/delivery-check?postcode=E14%205AB');
    info(`E145AB (Canary Wharf): deliverable=${data.deliverable}, distance=${data.distance_miles} miles`);
    if (status === 200 && data.deliverable === false) pass('Canary Wharf postcode correctly outside local delivery radius');
    else if (!settings.delivery_enabled) info('Delivery not configured — cannot test out-of-area rejection');
    else fail('Canary Wharf (~5 miles) should be outside local delivery radius', false, data.deliverable);
  }

  // ── BLOCK 3: Collection order ─────────────────────────────
  section('BLOCK 3 — Collection order (order_subtype = collection)');

  const collectionPhone = `0799901${Date.now().toString().slice(-4)}`;
  const collectionEmail = `__test__collection_${Date.now()}@nook.qa`;

  const { status: colStatus, data: colData } = await api('POST', '/api/takeaway/orders', {
    customer_name: '__TEST__ Collection Customer',
    customer_phone: collectionPhone,
    customer_email: collectionEmail,
    pickup_time: new Date(Date.now() + 30 * 60000).toISOString(),
    order_subtype: 'collection',
    items: [{ menu_item_id: testItem.id, quantity: 1, unit_price: testItem.price, name: testItem.name }],
    marketing_consent: false,
  });

  if (colStatus === 201) {
    pass('Collection order created (201)');
    createdOrders.push(colData.order_id || colData.id);
    info(`Collection order ID: ${colData.order_id || colData.id}`);
  } else {
    fail('Collection order should return 201', 201, colStatus);
    info(JSON.stringify(colData));
  }

  // 3A — check it appears in kitchen orders
  await new Promise(r => setTimeout(r, 500));
  {
    const { data: orders } = await api('GET', '/api/orders');
    const found = (orders || []).find(o =>
      o.customer_phone === collectionPhone || o.customer_name === '__TEST__ Collection Customer'
    );
    if (found) {
      pass('Collection order visible in /api/orders');
      info(`order_type=${found.order_type}, order_subtype=${found.order_subtype}`);
      if (found.order_subtype === 'collection') pass('order_subtype = "collection" ✓');
      else fail('order_subtype should be collection', 'collection', found.order_subtype);
    } else {
      warn('Collection order not found in active orders (may have been cleaned up or uses different endpoint)');
    }
  }

  // 3B — check customer appears in CRM
  {
    const customers = await getCustomers();
    const found = customers.find(c =>
      c.customer_email === collectionEmail || c.customer_phone === collectionPhone
    );
    if (found) pass('Collection customer appears in /api/customers CRM');
    else warn('Collection customer not found in CRM');
  }

  // ── BLOCK 4: Delivery order ───────────────────────────────
  section('BLOCK 4 — Delivery order (order_subtype = delivery)');

  const deliveryPhone = `0799902${Date.now().toString().slice(-4)}`;
  const deliveryEmail = `__test__delivery_${Date.now()}@nook.qa`;

  const { status: delStatus, data: delData } = await api('POST', '/api/takeaway/orders', {
    customer_name: '__TEST__ Delivery Customer',
    customer_phone: deliveryPhone,
    customer_email: deliveryEmail,
    pickup_time: new Date(Date.now() + 45 * 60000).toISOString(),
    order_subtype: 'delivery',
    delivery_address: '42 Baker Street, London, W1U 7BW',
    delivery_notes: 'Leave at the door',
    items: [{ menu_item_id: testItem.id, quantity: 2, unit_price: testItem.price, name: testItem.name }],
    marketing_consent: true,
  });

  let deliveryOrderId = null;
  if (delStatus === 201) {
    pass('Delivery order created (201)');
    deliveryOrderId = delData.order_id || delData.id;
    createdOrders.push(deliveryOrderId);
    info(`Delivery order ID: ${deliveryOrderId}`);
  } else {
    fail('Delivery order should return 201', 201, delStatus);
    info(JSON.stringify(delData));
  }

  // 4A — check subtype + address stored
  await new Promise(r => setTimeout(r, 500));
  {
    const { data: orders } = await api('GET', '/api/orders');
    const found = (orders || []).find(o => o.customer_phone === deliveryPhone);
    if (found) {
      pass('Delivery order visible in /api/orders (kitchen view)');
      info(`order_type=${found.order_type}, order_subtype=${found.order_subtype}`);
      if (found.order_subtype === 'delivery') pass('order_subtype = "delivery" ✓');
      else fail('order_subtype should be delivery', 'delivery', found.order_subtype);
      if (found.delivery_address) pass(`delivery_address stored: "${found.delivery_address}"`);
      else fail('delivery_address should be stored', '42 Baker Street...', found.delivery_address);
    } else {
      warn('Delivery order not found in active orders');
    }
  }

  // 4B — check customer in CRM
  {
    const customers = await getCustomers();
    const found = customers.find(c =>
      c.customer_email === deliveryEmail || c.customer_phone === deliveryPhone
    );
    if (found) pass('Delivery customer appears in /api/customers CRM');
    else warn('Delivery customer not found in CRM');
  }

  // ── BLOCK 5: Validation edge cases ────────────────────────
  section('BLOCK 5 — Delivery validation edge cases');

  // 5A — delivery with no address → should 400
  {
    const { status, data } = await api('POST', '/api/takeaway/orders', {
      customer_name: '__TEST__ No Address',
      customer_phone: '07000000001',
      pickup_time: new Date(Date.now() + 30 * 60000).toISOString(),
      order_subtype: 'delivery',
      delivery_address: '',
      items: [{ menu_item_id: testItem.id, quantity: 1, unit_price: testItem.price, name: testItem.name }],
    });
    if (status === 400) pass('Delivery with no address → 400 Bad Request');
    else fail('Delivery without address should be 400', 400, status);
  }

  // 5B — delivery with only whitespace address → should 400
  {
    const { status } = await api('POST', '/api/takeaway/orders', {
      customer_name: '__TEST__ Whitespace Address',
      customer_phone: '07000000002',
      pickup_time: new Date(Date.now() + 30 * 60000).toISOString(),
      order_subtype: 'delivery',
      delivery_address: '   ',
      items: [{ menu_item_id: testItem.id, quantity: 1, unit_price: testItem.price, name: testItem.name }],
    });
    if (status === 400) pass('Delivery with whitespace-only address → 400');
    else fail('Whitespace delivery address should be 400', 400, status);
  }

  // 5C — collection order should NOT store delivery_address
  if (createdOrders[0]) {
    const { data: orders } = await api('GET', '/api/orders');
    const found = (orders || []).find(o => o.customer_phone === collectionPhone);
    if (found) {
      if (!found.delivery_address) pass('Collection order has no delivery_address stored');
      else fail('Collection order should not store delivery_address', null, found.delivery_address);
    }
  }

  // ── BLOCK 6: Courier dispatch check ───────────────────────
  section('BLOCK 6 — Courier dispatch (Stuart sandbox)');

  if (deliveryOrderId) {
    // 6A — get a quote
    const { status: qStatus, data: qData } = await api('POST', '/api/delivery/quote', {
      order_id: deliveryOrderId,
    });
    if (qStatus === 200 && qData.price !== undefined) {
      pass(`Delivery quote returned: £${qData.price} (${qData.currency || 'GBP'})`);
      if (qData.eta) info(`ETA: ${qData.eta}`);
    } else if (qStatus === 400) {
      info(`Quote returned 400: ${JSON.stringify(qData)} — may need courier credentials configured`);
      warn('Delivery quote not available — check STUART_CLIENT_ID/SECRET in Railway');
    } else {
      warn(`Quote returned ${qStatus}: ${JSON.stringify(qData)}`);
    }

    // 6B — attempt dispatch
    const { status: dStatus, data: dData } = await api('POST', '/api/delivery/dispatch', {
      order_id: deliveryOrderId,
    });
    if (dStatus === 200 && dData.tracking_url) {
      pass(`Courier dispatched: ${dData.courier_name || 'Stuart'}`);
      pass(`Tracking link returned: ${dData.tracking_url}`);
      info(`Job ID: ${dData.job_id}`);
    } else if (dStatus === 400 || dStatus === 422) {
      info(`Dispatch returned ${dStatus}: ${JSON.stringify(dData)}`);
      warn('Courier dispatch not available — Stuart sandbox credentials may not be configured');
    } else {
      warn(`Dispatch returned ${dStatus}: ${JSON.stringify(dData).slice(0, 120)}`);
    }

    // 6C — ghost order dispatch → should not 500
    const { status: ghostStatus } = await api('POST', '/api/delivery/dispatch', { order_id: 999999 });
    if (ghostStatus !== 500) pass(`Ghost order dispatch → ${ghostStatus} (not 500)`);
    else fail('Ghost order dispatch should not 500', '4xx', 500);
  } else {
    warn('Skipping courier dispatch — no delivery order was created');
  }

  // ── BLOCK 7: Cleanup ──────────────────────────────────────
  section('BLOCK 7 — Cleanup');

  let deleted = 0;
  for (const id of createdOrders) {
    if (!id) continue;
    // Delivery orders stay open until courier webhook fires — force-close first
    await api('PUT', `/api/orders/${id}/status`, { status: 'closed' });
    const { status } = await api('DELETE', `/api/orders/${id}`);
    if (status === 200 || status === 204) deleted++;
    else info(`Order ${id} not deleted (${status}) — may need manual cleanup in Admin → Bills`);
  }
  info(`Test orders deleted: ${deleted}/${createdOrders.filter(Boolean).length}`);
  if (deleted > 0) pass(`${deleted} test order(s) cleaned up`);
  else warn('Test orders could not be auto-deleted — clean up IDs ' + createdOrders.filter(Boolean).join(', ') + ' manually in Admin → Bills');

  // ── SUMMARY ───────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  🚗  DELIVERY QA TEST COMPLETE');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${passed + failed + warned} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warned} warnings`);

  if (failed === 0) {
    console.log('\n  🎉 All checks passed — delivery flow is working correctly.');
  } else {
    console.log('\n  🐛 Some checks failed — review above for bugs to fix.');
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  ⚠️  MANUAL CHECKS (cannot automate):');
  console.log('  1. Takeaway widget Step 1 shows Collection/Delivery toggle');
  console.log('     only when delivery is enabled in Admin → Settings');
  console.log('  2. Delivery toggle hidden when no postcode/radius configured');
  console.log('  3. In-area postcode → address fields appear');
  console.log('  4. Out-of-area postcode → "outside delivery area" message');
  console.log('     + one-tap switch to Collection');
  console.log('  5. Kitchen card shows 🚗 for delivery, 🥡 for collection');
  console.log('  6. Delivery order stays OPEN after payment (not auto-closed)');
  console.log('     — only closes when Stuart webhook fires "delivered"');
  console.log('  7. Collection order still auto-closes on payment');
  console.log('  8. Uber Direct shows "not configured" error (no crash)');
  console.log('══════════════════════════════════════════════════════════════\n');

})().catch(err => { console.error(err); process.exit(1); });
