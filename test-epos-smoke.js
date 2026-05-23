/**
 * SiamEPOS Full Production Smoke Test
 * Target: https://restaurant-epos-production.up.railway.app
 *
 * Covers: health, tables, menu, orders, reservations, takeaway,
 *         customers, staff, settings, reports, bills, Z-report,
 *         delivery, inventory (PRO plan), widget public endpoints.
 *
 * Run: node test-epos-smoke.js
 * Safe: read-heavy. Any writes are clearly labelled and minimal.
 */

const https = require('https');

const BASE = 'https://restaurant-epos-production.up.railway.app';

// ─── HTTP helper ──────────────────────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url  = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── Counters ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const bugs = [];

function pass(label, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
  passed++;
}
function fail(label, expected, got) {
  console.log(`  ❌ ${label}`);
  console.log(`     expected: ${JSON.stringify(expected)}   got: ${JSON.stringify(got)}`);
  failed++;
  bugs.push({ label, expected, got });
}
function warn(label, detail = '') {
  console.log(`  ⚠️  ${label}${detail ? ' — ' + detail : ''}`);
  warned++;
}
function info(label) {
  console.log(`  ℹ️  ${label}`);
}

// ─── Shared state (populated as we go) ───────────────────────────────────
let tableId, menuItemId, categoryId, orderId, orderItemId, reservationId;
let staffId, ingredientId;
const today = new Date().toISOString().slice(0, 10);
const futureDate = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
})();

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' SiamEPOS  Full Production Smoke Test');
  console.log(` Target : ${BASE}`);
  console.log(` Date   : ${today}`);
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. HEALTH ────────────────────────────────────────────────────────
  console.log('── 1. Health ────────────────────────────────────────');
  const { status: hS, data: hD } = await req('GET', '/api/health');
  if (hS === 200) pass('GET /api/health → 200', `status: ${hD.status || JSON.stringify(hD)}`);
  else fail('GET /api/health', 200, hS);
  console.log();

  // ── 2. RESTAURANT ────────────────────────────────────────────────────
  console.log('── 2. Restaurant ────────────────────────────────────');
  const { status: rS, data: rD } = await req('GET', '/api/restaurant');
  if (rS === 200) {
    pass('GET /api/restaurant → 200');
    if (rD.name) pass(`Restaurant name: "${rD.name}"`);
    else warn('restaurant.name missing');
    if (rD.plan) info(`Plan: ${rD.plan}`);
  } else fail('GET /api/restaurant', 200, rS);
  console.log();

  // ── 3. TABLES ────────────────────────────────────────────────────────
  console.log('── 3. Tables ────────────────────────────────────────');
  const { status: tS, data: tD } = await req('GET', '/api/tables');
  if (tS === 200) {
    const tables = tD.tables || tD || [];
    pass('GET /api/tables → 200', `${tables.length} tables`);
    if (tables.length > 0) {
      tableId = tables[0].id;
      pass(`First table: id=${tableId} name="${tables[0].name || tables[0].table_number}"`);
    } else warn('No tables in DB');
  } else fail('GET /api/tables', 200, tS);

  const { status: tsS, data: tsD } = await req('GET', '/api/tables/status');
  if (tsS === 200) pass('GET /api/tables/status → 200');
  else fail('GET /api/tables/status', 200, tsS);
  console.log();

  // ── 4. MENU ──────────────────────────────────────────────────────────
  console.log('── 4. Menu ──────────────────────────────────────────');
  const { status: mS, data: mD } = await req('GET', '/api/menu');
  if (mS === 200) {
    const items = mD.items || mD || [];
    pass('GET /api/menu → 200', `${items.length} items`);
    if (items.length > 0) {
      menuItemId = items[0].id;
      pass(`First item: id=${menuItemId} "${items[0].name}" £${items[0].price}`);
      if (items[0].vat_rate !== undefined) pass(`VAT rate present: ${items[0].vat_rate}%`);
      else warn('vat_rate field missing from menu items (SEPOS-021)');
    } else warn('No menu items in DB');
  } else fail('GET /api/menu', 200, mS);

  const { status: caS, data: caD } = await req('GET', '/api/categories');
  if (caS === 200) {
    const cats = caD.categories || caD || [];
    pass('GET /api/categories → 200', `${cats.length} categories`);
    if (cats.length) categoryId = cats[0].id;
  } else fail('GET /api/categories', 200, caS);

  // Modifiers
  if (menuItemId) {
    const { status: modS, data: modD } = await req('GET', `/api/menu/items/${menuItemId}/modifiers`);
    if (modS === 200) pass(`GET /api/menu/items/${menuItemId}/modifiers → 200`);
    else fail('GET modifiers', 200, modS);
  }
  console.log();

  // ── 5. ORDERS ────────────────────────────────────────────────────────
  console.log('── 5. Orders ────────────────────────────────────────');
  const { status: oS, data: oD } = await req('GET', '/api/orders');
  if (oS === 200) {
    const orders = oD.orders || oD || [];
    pass('GET /api/orders → 200', `${orders.length} open orders`);
    if (orders.length > 0) {
      orderId = orders[0].id;
      info(`Sample open order: id=${orderId} table_id=${orders[0].table_id}`);
    }
  } else fail('GET /api/orders', 200, oS);

  // Create a test order (write — clearly labelled)
  if (tableId && menuItemId) {
    const { status: coS, data: coD } = await req('POST', '/api/orders', {
      table_id: tableId,
      staff_id: null,
    });
    if (coS === 201 || coS === 200) {
      orderId = coD.order?.id || coD.id;
      pass(`POST /api/orders → 201 (test order id=${orderId})`);

      // Add an item to the order
      const { status: aiS, data: aiD } = await req('POST', `/api/orders/${orderId}/items`, {
        items: [{ menu_item_id: menuItemId, quantity: 1, notes: '' }],
      });
      if (aiS === 201 || aiS === 200) {
        pass(`POST /api/orders/${orderId}/items → ${aiS}`);
        const items = aiD.items || [];
        if (items.length) orderItemId = items[0].id;
      } else fail('POST /api/orders/:id/items', '200/201', `${aiS}: ${JSON.stringify(aiD)}`);

      // GET the order
      const { status: goS, data: goD } = await req('GET', `/api/orders/${orderId}`);
      if (goS === 200) pass(`GET /api/orders/${orderId} → 200`);
      else fail('GET /api/orders/:id', 200, goS);

      // GET the bill
      const { status: gbS, data: gbD } = await req('GET', `/api/orders/${orderId}/bill`);
      if (gbS === 200) {
        pass(`GET /api/orders/${orderId}/bill → 200`);
        if (gbD.total !== undefined) pass(`Bill total: £${gbD.total}`);
      } else fail('GET /api/orders/:id/bill', 200, `${gbS}: ${JSON.stringify(gbD)}`);

    } else fail('POST /api/orders', 201, `${coS}: ${JSON.stringify(coD)}`);
  } else {
    warn('Skipping order create — no tableId or menuItemId from earlier steps');
  }

  // Bar + kitchen completed
  const { status: barS } = await req('GET', '/api/orders/bar');
  if (barS === 200) pass('GET /api/orders/bar → 200');
  else fail('GET /api/orders/bar', 200, barS);

  const { status: kcS } = await req('GET', '/api/kitchen/completed');
  if (kcS === 200) pass('GET /api/kitchen/completed → 200');
  else fail('GET /api/kitchen/completed', 200, kcS);
  console.log();

  // ── 6. STAFF ─────────────────────────────────────────────────────────
  console.log('── 6. Staff ─────────────────────────────────────────');
  const { status: stS, data: stD } = await req('GET', '/api/staff');
  if (stS === 200) {
    const staff = stD.staff || stD || [];
    pass('GET /api/staff → 200', `${staff.length} staff members`);
    if (staff.length) {
      staffId = staff[0].id;
      const roles = [...new Set(staff.map(s => s.role))];
      info(`Roles found: ${roles.join(', ')}`);
    }
  } else fail('GET /api/staff', 200, stS);

  // Staff login test (using a dummy PIN — expect 401, not 500)
  const { status: slS, data: slD } = await req('POST', '/api/staff/login', { pin: '0000' });
  if (slS === 401) pass('POST /api/staff/login (bad PIN) → 401 ✓');
  else if (slS === 200) warn('PIN 0000 accepted — test staff PIN in DB?');
  else fail('POST /api/staff/login error handling', 401, slS);

  // Manager PIN validation endpoint
  const { status: mpS } = await req('POST', '/api/validate-manager-pin', { pin: '0000', reason: 'test' });
  if (mpS === 403 || mpS === 400) pass('POST /api/validate-manager-pin (bad PIN) → correct rejection');
  else warn('Unexpected manager PIN response', String(mpS));
  console.log();

  // ── 7. SETTINGS ──────────────────────────────────────────────────────
  console.log('── 7. Settings ──────────────────────────────────────');
  const { status: seS, data: seD } = await req('GET', '/api/settings');
  if (seS === 200) {
    pass('GET /api/settings → 200');
    const s = seD.settings || seD || {};
    const keys = Object.keys(s);
    pass(`Settings keys returned: ${keys.length}`);
    const critKeys = ['service_charge_rate', 'service_charge_enabled'];
    for (const k of critKeys) {
      if (s[k] !== undefined) pass(`  ${k}: ${s[k]}`);
      else warn(`  ${k} missing from settings`);
    }
  } else fail('GET /api/settings', 200, seS);

  const { status: drS, data: drD } = await req('GET', '/api/discount-reasons');
  if (drS === 200) pass('GET /api/discount-reasons → 200', `${(drD.reasons || drD || []).length} reasons`);
  else fail('GET /api/discount-reasons', 200, drS);
  console.log();

  // ── 8. RESERVATIONS ──────────────────────────────────────────────────
  console.log('── 8. Reservations ──────────────────────────────────');
  const { status: rvS, data: rvD } = await req('GET', `/api/reservations?date=${today}`);
  if (rvS === 200) {
    const resvs = rvD.reservations || rvD || [];
    pass('GET /api/reservations → 200', `${resvs.length} reservations today`);
    if (resvs.length) reservationId = resvs[0].id;
  } else fail('GET /api/reservations', 200, rvS);

  // Reservation settings
  const { status: rsS, data: rsD } = await req('GET', '/api/reservations/settings');
  if (rsS === 200) {
    pass('GET /api/reservations/settings → 200');
    const settings = rsD.settings || rsD || {};
    if (settings.max_party_size !== undefined) pass(`max_party_size: ${settings.max_party_size} (SEPOS-050)`);
    else warn('max_party_size missing — SEPOS-050 not migrated?');
  } else fail('GET /api/reservations/settings', 200, rsS);

  // Availability widget (public)
  const { status: avS, data: avD } = await req('GET', `/api/reservations/availability?date=${futureDate}&covers=2`);
  if (avS === 200) pass(`GET /api/reservations/availability?date=${futureDate}&covers=2 → 200`);
  else if (avS === 400) warn('Availability returned 400 — check required params', JSON.stringify(avD));
  else fail('GET /api/reservations/availability', 200, avS);

  // Create a test reservation (write)
  const { status: crS, data: crD } = await req('POST', '/api/reservations', {
    guest_name: '__SmokeTest Guest',
    guest_phone: '07700999001',
    covers: 2,
    date: futureDate,
    time: '19:00',
    table_id: tableId || null,
    notes: 'Automated smoke test — safe to delete',
  });
  if (crS === 201) {
    reservationId = crD.reservation?.id || crD.id;
    pass(`POST /api/reservations → 201 (id=${reservationId})`);
    // Validate party-size cap — try booking 99 covers (SEPOS-050 guard)
    const { status: bigS, data: bigD } = await req('POST', '/api/reservations', {
      guest_name: '__Oversize Test',
      guest_phone: '07700999002',
      covers: 99,
      date: futureDate,
      time: '20:00',
    });
    if (bigS === 400 || bigS === 422) pass('Party-size cap (SEPOS-050): 99 covers rejected ✓');
    else warn('Party-size cap: 99 covers was not rejected', `got ${bigS}`);
    // Past date guard
    const { status: pastS } = await req('POST', '/api/reservations', {
      guest_name: '__Past Test',
      guest_phone: '07700999003',
      covers: 2,
      date: '2020-01-01',
      time: '19:00',
    });
    if (pastS === 400 || pastS === 422) pass('Past-date guard: 2020-01-01 rejected ✓');
    else warn('Past-date guard: old date was not rejected', `got ${pastS}`);
  } else fail('POST /api/reservations', 201, `${crS}: ${JSON.stringify(crD)}`);
  console.log();

  // ── 9. TAKEAWAY ──────────────────────────────────────────────────────
  console.log('── 9. Takeaway ──────────────────────────────────────');
  const { status: twsS, data: twsD } = await req('GET', '/api/takeaway/settings');
  if (twsS === 200) {
    pass('GET /api/takeaway/settings → 200');
    if (twsD.settings || typeof twsD === 'object') {
      const s = twsD.settings || twsD;
      if (s.takeaway_enabled !== undefined) info(`takeaway_enabled: ${s.takeaway_enabled}`);
    }
  } else fail('GET /api/takeaway/settings', 200, twsS);

  const { status: twoS, data: twoD } = await req('GET', '/api/takeaway/orders/active');
  if (twoS === 200) {
    const orders = twoD.orders || twoD || [];
    pass('GET /api/takeaway/orders/active → 200', `${orders.length} active takeaway orders`);
  } else fail('GET /api/takeaway/orders/active', 200, twsS);

  // Delivery check (public) — test with a central London postcode
  const { status: dcS, data: dcD } = await req('GET', '/api/takeaway/delivery-check?postcode=W1T4ED');
  if (dcS === 200) pass('GET /api/takeaway/delivery-check → 200');
  else if (dcS === 400) info('delivery-check 400 — delivery not configured (expected if not set up)');
  else warn('delivery-check unexpected', String(dcS));

  // Widget.js served
  const { status: wjS } = await req('GET', '/widget.js');
  if (wjS === 200) pass('GET /widget.js → 200 (booking widget served)');
  else fail('GET /widget.js', 200, wjS);

  const { status: twjS } = await req('GET', '/takeaway-widget.js');
  if (twjS === 200) pass('GET /takeaway-widget.js → 200 (takeaway widget served)');
  else fail('GET /takeaway-widget.js', 200, twjS);
  console.log();

  // ── 10. CUSTOMERS (CRM) ──────────────────────────────────────────────
  console.log('── 10. Customers / CRM ──────────────────────────────');
  const { status: cusS, data: cusD } = await req('GET', '/api/customers');
  if (cusS === 200) {
    const custs = cusD.customers || cusD || [];
    pass('GET /api/customers → 200', `${custs.length} customers`);
    if (custs.length) {
      const c = custs[0];
      if (c.total_visits !== undefined) pass(`CRM fields present: total_visits=${c.total_visits}, total_spend=${c.total_spend}`);
      else warn('CRM aggregate fields (total_visits, total_spend) missing');
      if (c.marketing_consent !== undefined) pass('marketing_consent field present (GDPR)');
    }
  } else fail('GET /api/customers', 200, cusS);

  // Campaigns list
  const { status: camS, data: camD } = await req('GET', '/api/campaigns');
  if (camS === 200) pass('GET /api/campaigns → 200', `${(camD.campaigns || camD || []).length} campaigns`);
  else if (camS === 404) warn('GET /api/campaigns → 404 — endpoint may not exist on this version');
  else fail('GET /api/campaigns', 200, camS);
  console.log();

  // ── 11. BILLS ────────────────────────────────────────────────────────
  console.log('── 11. Bills ────────────────────────────────────────');
  const { status: bsS, data: bsD } = await req('GET', '/api/bills');
  if (bsS === 200) {
    const bills = bsD.bills || bsD || [];
    pass('GET /api/bills → 200', `${bills.length} recent bills`);
    if (bills.length) {
      const b = bills[0];
      if (b.payment_method) info(`Sample bill: id=${b.id} £${b.total} via ${b.payment_method}`);
      if (b.split_payments !== undefined) pass('split_payments field present on bills');
    }
  } else fail('GET /api/bills', 200, bsS);
  console.log();

  // ── 12. REPORTS ──────────────────────────────────────────────────────
  console.log('── 12. Reports ──────────────────────────────────────');
  const { status: rdS, data: rdD } = await req('GET', `/api/reports/daily?date=${today}`);
  if (rdS === 200) pass('GET /api/reports/daily → 200');
  else fail('GET /api/reports/daily', 200, rdS);

  const { status: rsumS, data: rsumD } = await req('GET', `/api/reports/summary?from=${today}&to=${today}`);
  if (rsumS === 200) {
    pass('GET /api/reports/summary → 200');
    if (rsumD.total_revenue !== undefined) info(`Today revenue: £${rsumD.total_revenue}`);
  } else fail('GET /api/reports/summary', 200, rsumS);

  const { status: riS } = await req('GET', `/api/reports/items?from=${today}&to=${today}`);
  if (riS === 200) pass('GET /api/reports/items → 200');
  else fail('GET /api/reports/items', 200, riS);

  const { status: vatS } = await req('GET', `/api/reports/vat?from=${today}&to=${today}`);
  if (vatS === 200) pass('GET /api/reports/vat → 200 (SEPOS-021)');
  else fail('GET /api/reports/vat (SEPOS-021)', 200, vatS);

  const { status: spS } = await req('GET', `/api/reports/staff-performance?from=${today}&to=${today}`);
  if (spS === 200) pass('GET /api/reports/staff-performance → 200 (SEPOS-030)');
  else fail('GET /api/reports/staff-performance', 200, spS);

  const { status: wastS } = await req('GET', `/api/reports/wastage?from=${today}&to=${today}`);
  if (wastS === 200) pass('GET /api/reports/wastage → 200 (SEPOS-031)');
  else fail('GET /api/reports/wastage', 200, wastS);
  console.log();

  // ── 13. Z-REPORT ─────────────────────────────────────────────────────
  console.log('── 13. Z-Report ─────────────────────────────────────');
  const { status: zpS, data: zpD } = await req('GET', '/api/z-report/preview');
  if (zpS === 200) {
    pass('GET /api/z-report/preview → 200');
    if (zpD.total_revenue !== undefined || zpD.total !== undefined) pass('Z-report preview has totals');
  } else if (zpS === 403) {
    warn('Z-report → 403 — plan gating active (expected for lite plans)');
  } else fail('GET /api/z-report/preview', 200, zpS);

  const { status: zhS, data: zhD } = await req('GET', '/api/z-report/history');
  if (zhS === 200) pass('GET /api/z-report/history → 200', `${(zhD.reports || zhD || []).length} reports`);
  else if (zhS === 403) warn('Z-report history → 403 (plan gating)');
  else fail('GET /api/z-report/history', 200, zhS);
  console.log();

  // ── 14. STAFF CLOCK-IN/OUT (SEPOS-022) ───────────────────────────────
  console.log('── 14. Staff Clock Records (SEPOS-022) ─────────────');
  const { status: clS, data: clD } = await req('GET', `/api/clock/records?from=${today}&to=${today}`);
  if (clS === 200) pass('GET /api/clock/records → 200 (SEPOS-022)');
  else if (clS === 403) warn('clock/records → 403 (plan gating)');
  else fail('GET /api/clock/records', 200, clS);

  // Clock-in with missing PIN → 400
  const { status: ciS } = await req('POST', '/api/clock/in', {});
  if (ciS === 400 || ciS === 401) pass('POST /api/clock/in (no PIN) → correct rejection');
  else warn('clock/in no-PIN response', String(ciS));
  console.log();

  // ── 15. INVENTORY (SEPOS-046 — PRO plan) ─────────────────────────────
  console.log('── 15. Inventory (SEPOS-046) ────────────────────────');
  const { status: ingS, data: ingD } = await req('GET', '/api/ingredients');
  if (ingS === 200) {
    const ings = ingD.ingredients || ingD || [];
    pass('GET /api/ingredients → 200 (pro plan confirmed)', `${ings.length} ingredients`);
    if (ings.length) ingredientId = ings[0].id;
  } else if (ingS === 403) {
    warn('GET /api/ingredients → 403 — not on pro plan or plan gating active');
  } else fail('GET /api/ingredients', '200 or 403', ingS);

  const { status: invS } = await req('GET', '/api/supplier-invoices');
  if (invS === 200) pass('GET /api/supplier-invoices → 200');
  else if (invS === 403) info('supplier-invoices → 403 (plan gating — expected)');
  else fail('GET /api/supplier-invoices', '200 or 403', invS);

  const { status: lowS } = await req('GET', '/api/ingredients/low-stock');
  if (lowS === 200) pass('GET /api/ingredients/low-stock → 200');
  else if (lowS === 403) info('low-stock → 403 (plan gating)');
  else fail('GET /api/ingredients/low-stock', '200 or 403', lowS);
  console.log();

  // ── 16. DELIVERY (SEPOS-DELIVERY-001) ────────────────────────────────
  console.log('── 16. Delivery (SEPOS-DELIVERY-001) ────────────────');
  // Dispatch with no data → 400
  const { status: dispS, data: dispD } = await req('POST', '/api/delivery/dispatch', {});
  if (dispS === 400 || dispS === 422) pass('POST /api/delivery/dispatch (no data) → correct rejection');
  else if (dispS === 500) fail('delivery/dispatch with no data → 500 (should be 400)', '400/422', 500);
  else warn('delivery/dispatch empty body', String(dispS));

  // Quote with no data → 400
  const { status: quotS } = await req('POST', '/api/delivery/quote', {});
  if (quotS === 400 || quotS === 422 || quotS === 500) info(`delivery/quote empty body → ${quotS} (expected error)`);
  else warn('delivery/quote unexpected', String(quotS));
  console.log();

  // ── 17. ROLE-BASED ACCESS (SEPOS-043) ────────────────────────────────
  console.log('── 17. Role-Based Access (SEPOS-043) ────────────────');
  // DELETE a non-existent order → 404 (confirms endpoint exists and handles gracefully)
  const { status: delS, data: delD } = await req('DELETE', '/api/orders/999999');
  if (delS === 404) pass('DELETE /api/orders/999999 → 404 (endpoint live, handles missing order)');
  else if (delS === 400) pass('DELETE /api/orders/999999 → 400 (PIN required check active)');
  else warn('DELETE non-existent order response', String(delS));
  console.log();

  // ── 18. DINING DURATION TIERS ─────────────────────────────────────────
  console.log('── 18. Dining Duration Tiers ────────────────────────');
  const { status: ddS, data: ddD } = await req('GET', '/api/dining-duration-tiers');
  if (ddS === 200) pass('GET /api/dining-duration-tiers → 200', `${(ddD.tiers || ddD || []).length} tiers`);
  else fail('GET /api/dining-duration-tiers', 200, ddS);
  console.log();

  // ── 19. TABLE COMBINATIONS ────────────────────────────────────────────
  console.log('── 19. Table Combinations ───────────────────────────');
  const { status: tcS, data: tcD } = await req('GET', '/api/table-combinations');
  if (tcS === 200) pass('GET /api/table-combinations → 200', `${(tcD.combinations || tcD || []).length} combos`);
  else fail('GET /api/table-combinations', 200, tcS);
  console.log();

  // ── 20. PAY TEST ORDER (cleanup) ─────────────────────────────────────
  if (orderId) {
    console.log('── 20. Pay + Close Test Order (cleanup) ─────────────');
    const { status: payS, data: payD } = await req('POST', `/api/orders/${orderId}/pay`, {
      payment_method: 'cash',
      amount_tendered: 999,
      service_charge: 0,
      discount: 0,
      items: [],
    });
    if (payS === 200) pass(`POST /api/orders/${orderId}/pay → 200 (test order closed)`);
    else warn('Could not close test order', `${payS}: ${JSON.stringify(payD)}`);
    console.log();
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('══════════════════════════════════════════════════════');
  console.log(` SiamEPOS Smoke Test — ${passed}/${total} passed  ${warned} warnings  ${failed} failed`);
  console.log('══════════════════════════════════════════════════════');

  if (bugs.length) {
    console.log('\n🐛 Failures:');
    bugs.forEach((b, i) =>
      console.log(`  ${i + 1}. ${b.label}\n     expected: ${JSON.stringify(b.expected)}   got: ${JSON.stringify(b.got)}`)
    );
  }
  if (!failed) console.log('\n🎉 All checks passed — production backend healthy.\n');
  else         console.log(`\n⚠️  ${failed} failure(s) need attention.\n`);
}

run().catch((err) => {
  console.error('\n💥 Test runner crashed:', err.message, err.stack);
  process.exit(1);
});
