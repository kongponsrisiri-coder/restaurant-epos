#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════╗
// ║  SiamEPOS — Reservations QA Test                             ║
// ║  Nook (QA Agent) | 2026-05-18                                ║
// ║  Covers: SEPOS-049 (Timeline) + SEPOS-050 (Party size cap)   ║
// ╚══════════════════════════════════════════════════════════════╝

const BASE = 'https://restaurant-epos-production.up.railway.app';
const RESTAURANT_ID = 'siamepos';

let passed = 0, failed = 0, warned = 0;
const createdReservations = [];

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

// Future date for bookings — a Tuesday 3 weeks out at 13:00 (low traffic slot)
function futureDate() {
  const d = new Date();
  d.setDate(d.getDate() + 21);
  // Move to Tuesday if needed
  const day = d.getDay();
  if (day !== 2) d.setDate(d.getDate() + ((2 - day + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const bookingDate = futureDate();
const bookingTime = '13:00';

// ──────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  SiamEPOS — Reservations QA Test                             ║');
console.log('║  Nook (QA Agent) | 2026-05-18                                ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  Backend: ${BASE}\n`);

(async () => {
  // ── BLOCK 1: Settings ─────────────────────────────────────────
  section('BLOCK 1 — Reservation settings (SEPOS-050)');

  let maxPartySize = 8;
  let restaurantPhone = null;

  const { status: sStatus, data: settings } = await api('GET', `/api/reservations/settings/${RESTAURANT_ID}`);
  if (sStatus === 200) {
    pass('Reservation settings endpoint returns 200');
    maxPartySize = settings.max_party_size || 8;
    restaurantPhone = settings.restaurant_phone || null;
    info(`max_party_size: ${maxPartySize}`);
    info(`restaurant_phone: ${restaurantPhone || '(not set)'}`);

    if (typeof settings.max_party_size === 'number') pass('max_party_size is a number in settings');
    else fail('max_party_size should be a number', 'number', typeof settings.max_party_size);

    if (settings.restaurant_phone !== undefined) pass('restaurant_phone field present in settings');
    else fail('restaurant_phone field missing from settings');
  } else {
    fail('Settings endpoint should return 200', 200, sStatus);
  }

  // ── BLOCK 2: Availability — party size cap ────────────────────
  section('BLOCK 2 — Availability cap (SEPOS-050)');

  // 2A — party AT the cap → slots returned normally
  {
    const { status, data } = await api('GET', `/api/reservations/availability?date=${bookingDate}&covers=${maxPartySize}&restaurant_id=${RESTAURANT_ID}`);
    if (status === 200 && Array.isArray(data.slots)) {
      pass(`Party of ${maxPartySize} (at cap) returns slots array`);
      info(`Slots available: ${data.slots.length}`);
    } else {
      fail(`Party of ${maxPartySize} should return slots`, '200 + slots[]', `${status}: ${JSON.stringify(data)}`);
    }
  }

  // 2B — party OVER the cap → empty slots + message
  const overCap = maxPartySize + 1;
  {
    const { status, data } = await api('GET', `/api/reservations/availability?date=${bookingDate}&covers=${overCap}&restaurant_id=${RESTAURANT_ID}`);
    if (status === 200 && Array.isArray(data.slots) && data.slots.length === 0) {
      pass(`Party of ${overCap} (over cap) returns empty slots []`);
    } else {
      fail(`Party of ${overCap} should return empty slots`, '200 + slots:[]', `${status}: ${JSON.stringify(data)}`);
    }
    if (data.max_party_size === maxPartySize) pass('max_party_size returned in over-cap response');
    else fail('max_party_size should be in over-cap response', maxPartySize, data.max_party_size);
    if (data.message && data.message.includes(String(maxPartySize))) pass('Over-cap message contains the cap number');
    else fail('Over-cap message should mention the cap', `includes "${maxPartySize}"`, data.message);
    if (restaurantPhone && data.restaurant_phone === restaurantPhone) pass('restaurant_phone returned in over-cap response');
    else if (!restaurantPhone) info('restaurant_phone not configured — phone not shown in message (expected)');
    else fail('restaurant_phone should be in over-cap response', restaurantPhone, data.restaurant_phone);
    info(`Over-cap message: "${data.message}"`);
  }

  // 2C — large party way over cap
  {
    const { status, data } = await api('GET', `/api/reservations/availability?date=${bookingDate}&covers=50&restaurant_id=${RESTAURANT_ID}`);
    if (status === 200 && data.slots?.length === 0) pass('Party of 50 correctly blocked by cap');
    else fail('Party of 50 should be blocked', '200 + slots:[]', `${status}`);
  }

  // ── BLOCK 3: Booking POST — widget cap enforcement ────────────
  section('BLOCK 3 — Booking POST: widget cap (SEPOS-050)');

  // 3A — widget booking AT cap → allowed
  {
    const { status, data } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ At Cap Widget',
      customer_phone: '07700900001',
      customer_email: 'nook-test-atcap@nook.qa',
      covers: maxPartySize,
      reservation_date: bookingDate,
      reservation_time: bookingTime,
      source: 'widget',
      notes: 'QA test — please delete',
    });
    const id = data.id || data.booking_id || data.reservation?.id || data.reservation_id;
    if (status === 201 && id) {
      pass(`Widget booking at cap (${maxPartySize} covers) → 201 allowed`);
      createdReservations.push(id);
      info(`Reservation ID: ${id}`);
    } else {
      fail(`Widget booking at cap should be allowed`, 201, `${status}: ${JSON.stringify(data)}`);
    }
  }

  // 3B — widget booking OVER cap → rejected
  {
    const { status, data } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ Over Cap Widget',
      customer_phone: '07700900002',
      customer_email: 'nook-test-overcap@nook.qa',
      covers: overCap,
      reservation_date: bookingDate,
      reservation_time: bookingTime,
      source: 'widget',
      notes: 'QA test — should be rejected',
    });
    if (status === 400) {
      pass(`Widget booking over cap (${overCap} covers) → 400 rejected`);
      if (data.error && data.error.includes(String(maxPartySize))) pass('Rejection error message contains cap number');
      else fail('Rejection error should mention the cap', `includes "${maxPartySize}"`, data.error);
      if (restaurantPhone && data.error && data.error.includes(restaurantPhone)) pass('Rejection error includes restaurant phone');
      else if (!restaurantPhone) info('No restaurant phone configured — phone not in error (expected)');
      info(`Rejection message: "${data.error}"`);
    } else {
      fail(`Widget booking over cap should be rejected (400)`, 400, `${status}: ${JSON.stringify(data)}`);
      const id = data.id || data.booking_id || data.reservation?.id || data.reservation_id;
      if (id) createdReservations.push(id);
    }
  }

  // 3C — staff booking OVER cap → allowed (staff are uncapped)
  {
    const { status, data } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ Staff Over Cap',
      customer_phone: '07700900003',
      customer_email: 'nook-test-staff@nook.qa',
      covers: overCap,
      reservation_date: bookingDate,
      reservation_time: bookingTime,
      source: 'staff',
      notes: 'QA test — staff booking, should be allowed',
    });
    const id = data.id || data.booking_id || data.reservation?.id || data.reservation_id;
    if (status === 201 && id) {
      pass(`Staff booking over cap (${overCap} covers) → 201 allowed (uncapped)`);
      createdReservations.push(id);
      info(`Staff reservation ID: ${id}`);
    } else {
      fail('Staff booking over cap should NOT be blocked', 201, `${status}: ${JSON.stringify(data)}`);
    }
  }

  // 3D — no source defaults to widget — should be capped
  {
    const { status, data } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ No Source Over Cap',
      customer_phone: '07700900004',
      customer_email: 'nook-test-nosource@nook.qa',
      covers: overCap,
      reservation_date: bookingDate,
      reservation_time: bookingTime,
      // no source field — defaults to 'widget'
      notes: 'QA test',
    });
    if (status === 400) pass('No source field defaults to widget — over-cap booking rejected');
    else {
      warn('No-source over-cap booking not rejected — check default source value', `${status}`);
      const id = data.id || data.booking_id || data.reservation?.id || data.reservation_id;
      if (id) createdReservations.push(id);
    }
  }

  // ── BLOCK 4: Past date rejection (BUG-004 regression) ────────
  section('BLOCK 4 — Past date rejection (BUG-004 regression)');

  {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pastDate = yesterday.toISOString().slice(0, 10);
    const { status } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ Past Date',
      customer_phone: '07700900005',
      covers: 2,
      reservation_date: pastDate,
      reservation_time: '19:00',
      source: 'widget',
    });
    if (status === 400) pass('Past date reservation rejected (400)');
    else fail('Past date should be rejected', 400, status);
  }

  // ── BLOCK 5: Core reservation flow ───────────────────────────
  section('BLOCK 5 — Core reservation flow');

  // 5A — valid widget booking
  let testResId;
  {
    const { status, data } = await api('POST', '/api/reservations', {
      restaurant_id: RESTAURANT_ID,
      customer_name: '__TEST__ Valid Booking',
      customer_phone: '07700900006',
      customer_email: 'nook-valid@nook.qa',
      covers: 2,
      reservation_date: bookingDate,
      reservation_time: bookingTime,
      source: 'widget',
      notes: 'QA test — please delete',
    });
    const id = data.id || data.booking_id || data.reservation?.id || data.reservation_id;
    if (status === 201 && id) {
      pass('Valid widget booking (2 covers) → 201');
      testResId = id;
      createdReservations.push(id);
    } else {
      fail('Valid booking should return 201 + id', 201, `${status}: ${JSON.stringify(data)}`);
    }
  }

  // 5B — reservation appears in GET /api/reservations
  if (testResId) {
    const { status, data } = await api('GET', `/api/reservations?restaurant_id=${RESTAURANT_ID}&date=${bookingDate}`);
    const found = Array.isArray(data) && data.find(r => r.id === testResId);
    if (found) {
      pass('Reservation visible in GET /api/reservations');
      if (found.covers == 2) pass('Covers stored correctly');
      else fail('Covers should be 2', 2, found.covers);
      if (found.reservation_date === bookingDate) pass('Date stored correctly');
      else fail('Date mismatch', bookingDate, found.reservation_date);
      if (found.status === 'pending') pass('Status defaults to "pending"');
      else fail('Status should default to "pending"', 'pending', found.status);
    } else {
      fail('Reservation should appear in GET /api/reservations');
    }
  }

  // 5C — update reservation status (PUT requires all fields — fetch first then send back with updated status)
  if (testResId) {
    const { data: allRes } = await api('GET', `/api/reservations?restaurant_id=${RESTAURANT_ID}&date=${bookingDate}`);
    const existing = Array.isArray(allRes) && allRes.find(r => r.id === testResId);
    if (existing) {
      const { status } = await api('PUT', `/api/reservations/${testResId}`, {
        customer_name: existing.customer_name,
        customer_phone: existing.customer_phone,
        customer_email: existing.customer_email || null,
        covers: existing.covers,
        reservation_date: existing.reservation_date,
        reservation_time: existing.reservation_time,
        table_id: existing.table_id || null,
        notes: existing.notes || null,
        status: 'confirmed',
      });
      if (status === 200) pass('Reservation status updated to "confirmed"');
      else fail('PUT reservation should return 200', 200, status);
    } else {
      warn('Could not fetch reservation to test PUT — skipping status update check');
    }
  }

  // ── BLOCK 6: Cleanup ──────────────────────────────────────────
  section('BLOCK 6 — Cleanup');

  let deleted = 0;
  for (const id of createdReservations) {
    const { status } = await api('DELETE', `/api/reservations/${id}`);
    if (status === 200) { deleted++; info(`Reservation #${id} deleted`); }
    else {
      // Try cancelling instead
      await api('PUT', `/api/reservations/${id}`, { status: 'cancelled', restaurant_id: RESTAURANT_ID });
      warn(`Reservation #${id} could not be deleted — cancelled instead`);
    }
  }
  if (deleted === createdReservations.length) pass('All test reservations cleaned up');
  else warn(`${createdReservations.length - deleted} reservation(s) cancelled (not deleted) — check Admin → Reservations`);

  // ── Summary ───────────────────────────────────────────────────
  const total = passed + failed + warned;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  📅  RESERVATIONS QA TEST COMPLETE');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warned} warnings`);
  if (failed === 0) console.log('\n  🎉 All checks passed — SEPOS-049 + SEPOS-050 ready for sign-off.\n');
  else console.log(`\n  ⚠️  ${failed} failure(s) need fixing before sign-off.\n`);

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  📋  MANUAL CHECKS (SEPOS-049 — Timeline UI):');
  console.log('  These require the Reservations → Timeline view in the app:');
  console.log('  1. With linked tables set up (e.g. four 2-tops linked),');
  console.log('     book a party of 2 on ONE table — only that row fills,');
  console.log('     sibling rows stay empty.');
  console.log('  2. Book a party of 8 across the linked group — booking');
  console.log('     spans all linked rows with a dashed "ghost" on siblings.');
  console.log('  3. Booking widget: guest stepper stops at max_party_size');
  console.log(`     (currently ${maxPartySize}) with a "call us" note.`);
  console.log(`  4. Booking widget: phone shown as ${restaurantPhone || '020 7935 0000'} in the call-us note.`);
  console.log('  5. Staff-created bookings in Admin are NOT limited by cap.');
  console.log('══════════════════════════════════════════════════════════════\n');
})();
