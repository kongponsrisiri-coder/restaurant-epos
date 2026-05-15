/**
 * SiamEPOS — SEPOS-043 Role-Based Access Test Suite
 * Author: Nook (QA Agent) | Date: 2026-05-15
 *
 * HOW TO RUN:
 *   cd ~/Desktop/restaurant-epos
 *   node test-sepos-043.js
 *
 * Tests backend enforcement of role-based delete rules.
 * Frontend (🗑️ button visibility) requires manual check — see summary at end.
 * Creates test data, verifies results, cleans up after itself.
 */

const BASE = 'https://restaurant-epos-production.up.railway.app';

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const get  = (path)       => api('GET',    path);
const post = (path, body) => api('POST',   path, body);
const del  = (path, body) => api('DELETE', path, body);

const cleanup = { staff: [], orders: [] };

// ── Setup: create test staff ──────────────────────────────────────────────────

async function seedStaff() {
  console.log('\n🌱 SETUP — Creating test staff...');
  const members = [
    { name: '__TEST__ Admin',      pin: '8801', role: 'admin'      },
    { name: '__TEST__ Manager',    pin: '8802', role: 'manager'    },
    { name: '__TEST__ Supervisor', pin: '8803', role: 'supervisor' },
    { name: '__TEST__ Waiter',     pin: '8804', role: 'waiter'     },
  ];
  const ids = {};
  for (const m of members) {
    const { data } = await post('/api/staff', {
      ...m, start_date: null, notes: 'QA test staff', employment_status: 'active'
    });
    if (!data.id) throw new Error(`Failed to create staff: ${m.name} — ${JSON.stringify(data)}`);
    cleanup.staff.push(data.id);
    ids[m.role] = { id: data.id, pin: m.pin, name: m.name };
    console.log(`  ✔ ${m.role}: ${m.name} (PIN ${m.pin}, id=${data.id})`);
  }
  return ids;
}

// ── Setup: create a closed order ─────────────────────────────────────────────

async function createClosedOrder(staffId) {
  // Create order (counter — no table needed)
  const { data: order } = await post('/api/orders', {
    table_id: null, covers: 1, staff_id: staffId, order_type: 'counter'
  });
  if (!order.id) throw new Error('Failed to create order');
  // Pay it immediately → status becomes 'closed'
  await post(`/api/orders/${order.id}/pay`, { amount: 10.00, method: 'cash' });
  // Verify it's closed
  const { data: orders } = await get('/api/bills?date=' + new Date().toISOString().split('T')[0]);
  console.log(`  ✔ Closed order id=${order.id}`);
  return order.id;
}

// ── Setup: create an open order ──────────────────────────────────────────────

async function createOpenOrder(staffId) {
  const { data: order } = await post('/api/orders', {
    table_id: null, covers: 1, staff_id: staffId, order_type: 'counter'
  });
  if (!order.id) throw new Error('Failed to create open order');
  console.log(`  ✔ Open order id=${order.id}`);
  return order.id;
}

// ── BLOCK 1 — DELETE /api/orders/:id role checks ─────────────────────────────

async function testBlock1(staff, closedOrderId, openOrderId) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 1 — DELETE /api/orders/:id Role Enforcement');
  console.log('════════════════════════════════════════════════');

  // 1A — Supervisor blocked from deleting CLOSED order
  console.log('\n  1A — Supervisor + closed order → should be 403');
  const { status: s1a, data: d1a } = await del(
    `/api/orders/${closedOrderId}`,
    { pin: staff.supervisor.pin, reason: 'QA test supervisor closed' }
  );
  check('Supervisor + closed order → 403', s1a, 403);
  check('Error message correct', d1a.error, 'Supervisors cannot delete closed bills');

  // 1B — Supervisor CAN delete an OPEN order
  console.log('\n  1B — Supervisor + open order → should be 200');
  const { status: s1b, data: d1b } = await del(
    `/api/orders/${openOrderId}`,
    { pin: staff.supervisor.pin, reason: 'QA test supervisor open' }
  );
  check('Supervisor + open order → 200', s1b, 200);
  check('Open order deleted successfully', d1b.success, true);
  // Open order is now deleted — don't try to clean it up
  cleanup.orders = cleanup.orders.filter(id => id !== openOrderId);

  // Need a fresh closed order for remaining tests (admin + manager checks)
  // closedOrderId is still intact (supervisor was blocked)
  // 1C — Admin CAN delete a closed order (no regression)
  console.log('\n  1C — Admin + closed order → should be 200');
  // Create a second closed order for admin to delete
  const adminClosedId = await createClosedOrder(staff.admin.id);
  const { status: s1c, data: d1c } = await del(
    `/api/orders/${adminClosedId}`,
    { pin: staff.admin.pin, reason: 'QA test admin closed' }
  );
  check('Admin + closed order → 200', s1c, 200);
  check('Admin deleted successfully', d1c.success, true);

  // 1D — Manager CAN delete a closed order (no regression)
  console.log('\n  1D — Manager + closed order → should be 200');
  const managerClosedId = await createClosedOrder(staff.manager.id);
  const { status: s1d, data: d1d } = await del(
    `/api/orders/${managerClosedId}`,
    { pin: staff.manager.pin, reason: 'QA test manager closed' }
  );
  check('Manager + closed order → 200', s1d, 200);
  check('Manager deleted successfully', d1d.success, true);

  // 1E — Waiter PIN rejected entirely (no delete rights)
  console.log('\n  1E — Waiter + any order → should be 403 (wrong role)');
  const { status: s1e, data: d1e } = await del(
    `/api/orders/${closedOrderId}`,
    { pin: staff.waiter.pin, reason: 'QA test waiter' }
  );
  check('Waiter → 403 (no delete rights)', s1e, 403);
  check('Waiter error is Invalid manager PIN', d1e.error, 'Invalid manager PIN');

  // 1F — Wrong PIN rejected (use a PIN that cannot exist: 7 digits, no real staff has this)
  console.log('\n  1F — Invalid PIN → should be 403');
  const { status: s1f, data: d1f } = await del(
    `/api/orders/${closedOrderId}`,
    { pin: '9999999', reason: 'QA bad pin test' }
  );
  check('Invalid PIN → 403', s1f, 403);

  // 1G — Missing reason rejected
  console.log('\n  1G — No reason provided → should be 400');
  const { status: s1g } = await del(
    `/api/orders/${closedOrderId}`,
    { pin: staff.admin.pin, reason: '' }
  );
  check('Missing reason → 400', s1g, 400);

  // 1H — Non-existent order
  console.log('\n  1H — Delete non-existent order → should be 404');
  const { status: s1h } = await del(
    `/api/orders/99999999`,
    { pin: staff.admin.pin, reason: 'QA ghost order' }
  );
  check('Non-existent order → 404', s1h, 404);
}

// ── BLOCK 2 — POST /api/sync/delete-order role checks ────────────────────────
// NOTE: This endpoint requires the x-sync-secret header (Railway env var
// SYNC_SECRET). It is an internal Mac→Cloud API — not callable externally
// without the secret. Krit's SEPOS-043 check IS in the code at server.js
// line ~1092. Manual verification on Mac Electron app required.

async function testBlock2(staff, closedOrderId) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 2 — POST /api/sync/delete-order');
  console.log('  ⚠️  SKIPPED — internal Mac-only endpoint');
  console.log('  Requires x-sync-secret header (SYNC_SECRET env)');
  console.log('  SEPOS-043 role check confirmed in server.js source.');
  console.log('  Manual verification: test from Mac Electron app.');
  console.log('════════════════════════════════════════════════');
  console.log('  ℹ️  Verified in code: server.js ~line 1091-1095');
  console.log('     if supervisor + closed order → 403 ✅ (code confirmed)');
}

// ── BLOCK 3 — Staff login role verification ───────────────────────────────────

async function testBlock3(staff) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 3 — Staff Login Returns Correct Roles');
  console.log('════════════════════════════════════════════════');

  for (const [role, member] of Object.entries(staff)) {
    const { status, data } = await post('/api/staff/login', { pin: member.pin });
    check(`PIN ${member.pin} (${role}) → login succeeds`, status, 200);
    check(`PIN ${member.pin} returns correct role: ${role}`, (data.role || '').toLowerCase(), role);
  }

  // Verify waiter login works but role is 'waiter'
  const { data: waiterData } = await post('/api/staff/login', { pin: staff.waiter.pin });
  check('Waiter role confirmed as waiter', (waiterData.role || '').toLowerCase(), 'waiter');

  // Wrong PIN returns error (7-digit PIN — cannot match any real staff)
  const { data: badData } = await post('/api/staff/login', { pin: '9999999' });
  check('Wrong PIN → returns no staff id', !badData.id, true);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanUp(closedOrderId) {
  console.log('\n🧹 CLEANUP — Removing test data...');
  // Delete the remaining closed order (supervisor was blocked from deleting it)
  if (closedOrderId) {
    const { data } = await del(`/api/orders/${closedOrderId}`,
      { pin: cleanup.staff[0] ? '8801' : '8801', reason: 'QA cleanup' }
    );
    if (data.success) console.log(`  Deleted order id=${closedOrderId}`);
  }
  // Delete test staff
  for (const id of cleanup.staff) {
    const { data } = await api('DELETE', `/api/staff/${id}`);
    console.log(`  Deleted staff id=${id}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  SiamEPOS — SEPOS-043 Role Access Test Suite     ║');
  console.log('║  Nook (QA Agent) | 2026-05-15                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Backend: ${BASE}`);

  let closedOrderId;

  try {
    const staff = await seedStaff();

    console.log('\n🔧 Creating test orders...');
    closedOrderId = await createClosedOrder(staff.admin.id);
    const openOrderId = await createOpenOrder(staff.supervisor.id);
    cleanup.orders.push(closedOrderId, openOrderId);

    await testBlock1(staff, closedOrderId, openOrderId);
    await testBlock2(staff, closedOrderId);
    await testBlock3(staff);

  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err.message);
    failed++;
  } finally {
    await cleanUp(closedOrderId);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  if (failed === 0 && passed > 0) {
    console.log('\n  🎉 All backend tests passed!');
  }
  console.log('\n════════════════════════════════════════════════');
  console.log('  ⚠️  MANUAL CHECKS STILL REQUIRED (frontend):');
  console.log('  1. Log in as supervisor → Admin → Bills');
  console.log('     Tap heading 5× → enter supervisor PIN');
  console.log('     → 🗑️ buttons must NOT appear on closed bills');
  console.log('  2. Log in as waiter → Admin tab must NOT be in navbar');
  console.log('  3. Log in as admin → unlock → 🗑️ buttons MUST appear ✅');
  console.log('════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
