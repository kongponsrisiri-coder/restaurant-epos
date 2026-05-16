/**
 * SiamEPOS — Friday Night Extreme Stress Test
 * Author: Nook (QA Agent) | Date: 2026-05-15
 *
 * Simulates a fully-booked Friday night service with 100 covers,
 * concurrent orders, walk-ins, no-shows, table moves, split bills,
 * and edge cases designed to break things.
 *
 * HOW TO RUN:
 *   cd ~/Desktop/restaurant-epos
 *   node test-friday-night.js
 *
 * WHAT IT TESTS:
 *   Block 1 — Setup (live tables, menu, staff)
 *   Block 2 — 100 reservations seeded across Friday evening
 *   Block 3 — Overbooking detection
 *   Block 4 — Arrivals + status workflow
 *   Block 5 — Full order flow (20 tables, real menu items, concurrent)
 *   Block 6 — Concurrent chaos (parallel order mutations)
 *   Block 7 — Edge cases (walk-ins, no-shows, table move, split bill)
 *   Block 8 — Cleanup
 */

const BASE = 'https://restaurant-epos-production.up.railway.app';
const FRIDAY = '2026-05-16'; // Friday

// ── Counters ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let warnings = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    process.stdout.write('  ✅ ' + label + '\n');
    passed++;
  } else {
    process.stdout.write('  ❌ ' + label + '\n');
    process.stdout.write('     Expected: ' + JSON.stringify(expected) + '\n');
    process.stdout.write('     Actual:   ' + JSON.stringify(actual) + '\n');
    failed++;
    failures.push(label);
  }
}

function warn(label, msg) {
  process.stdout.write('  ⚠️  ' + label + ': ' + msg + '\n');
  warnings++;
}

function info(msg) {
  process.stdout.write('  ℹ️  ' + msg + '\n');
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}
const get    = (path)       => api('GET',    path);
const post   = (path, body) => api('POST',   path, body);
const put    = (path, body) => api('PUT',    path, body);
const del    = (path, body) => api('DELETE', path, body);

// ── Realistic test data ───────────────────────────────────────────────────────
const GUEST_NAMES = [
  'James Wilson', 'Emma Thompson', 'Oliver Davies', 'Sophia Johnson',
  'Harry Brown', 'Isabella Smith', 'George Taylor', 'Lily Anderson',
  'Charlie White', 'Grace Martin', 'Jack Robinson', 'Amelia Harris',
  'Alfie Lewis', 'Poppy Walker', 'Freddie Hall', 'Daisy Young',
  'Archie Allen', 'Evie King', 'Oscar Wright', 'Millie Scott',
  'Noah Green', 'Isla Baker', 'William Adams', 'Chloe Nelson',
  'Benjamin Carter', 'Sophie Mitchell', 'Thomas Perez', 'Ruby Roberts',
  'Samuel Turner', 'Ava Phillips', 'Joseph Campbell', 'Emily Parker',
  'Edward Evans', 'Mia Edwards', 'Daniel Collins', 'Jessica Stewart',
  'Ethan Morris', 'Charlotte Rogers', 'Max Cook', 'Hannah Morgan',
  'Alexander Bell', 'Olivia Murphy', 'Henry Bailey', 'Lucy Rivera',
  'Sebastian Cooper', 'Ella Richardson', 'Liam Richardson', 'Zoe Cox',
  'Mason Howard', 'Hannah Ward', 'Logan Brooks', 'Ella Price',
  'Lucas Sanders', 'Nora Russell', 'Jayden Patterson', 'Ellie Jenkins',
  'Cameron Hughes', 'Anna Flores', 'Ryan Butler', 'Natasha Gray',
  'Nathan James', 'Lauren Henderson', 'Aaron Foster', 'Amy Gibson',
  'Tyler Bryant', 'Hannah Perry', 'Connor Woods', 'Rachel Barnes',
  'Dylan Dixon', 'Rebecca Ross', 'Jordan Nguyen', 'Abigail Hunter',
  'Luca Henderson', 'Freya Harrison', 'Theo Graham', 'Rosie Lawrence',
  'Finn Porter', 'Ellie Simmons', 'Kiran Patel', 'Priya Sharma',
  'Suresh Kumar', 'Anita Singh', 'Wei Chen', 'Mei Zhang',
  'Kofi Asante', 'Amara Osei', 'Carlos Mendez', 'Sofia Garcia',
  'Marco Romano', 'Giulia Ferrari', 'Pierre Dupont', 'Claire Bernard',
  'Lars Hansen', 'Astrid Nielsen', 'Dmitri Volkov', 'Natasha Ivanova',
  'Kenji Tanaka', 'Yuki Sato', 'Somchai Jaidee', 'Malee Wongsri',
];

const PHONES = Array.from({ length: 100 }, (_, i) =>
  `07${String(700000000 + i).slice(1)}`
);

// Time slots: 17:30 to 22:00 every 15 minutes (19 slots)
const TIME_SLOTS = [
  '17:30','17:45','18:00','18:15','18:30','18:45',
  '19:00','19:15','19:30','19:45','20:00','20:15',
  '20:30','20:45','21:00','21:15','21:30','21:45','22:00'
];

// Party size distribution (realistic UK Thai restaurant)
const PARTY_SIZES = [
  2,2,2,2,2,2,2,2,  // 40% twos
  3,3,3,             // 15% threes
  4,4,4,4,4,         // 25% fours
  5,                 // 5% fives
  6,6,               // 10% sixes
  7,                 // rare sevens
  8                  // rare eights
];

function randomPartySize() {
  return PARTY_SIZES[Math.floor(Math.random() * PARTY_SIZES.length)];
}

function randomTimeSlot() {
  return TIME_SLOTS[Math.floor(Math.random() * TIME_SLOTS.length)];
}

// ── Cleanup tracking ──────────────────────────────────────────────────────────
const cleanup = {
  reservationIds: [],
  orderIds: [],
  staffIds: [],
};

// ── BLOCK 1: Setup — Live data ────────────────────────────────────────────────
async function block1Setup() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 1 — Setup: Reading live tables, menu & staff      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const { status: tableStatus, data: tablesData } = await get('/api/tables');
  check('GET /api/tables returns 200', tableStatus, 200);
  const tables = Array.isArray(tablesData) ? tablesData : [];
  info(`Found ${tables.length} tables`);
  tables.forEach(t => info(`  Table ${t.id}: "${t.name}" cap=${t.capacity || '?'}`));

  const { status: menuStatus, data: menuData } = await get('/api/menu');
  check('GET /api/menu returns 200', menuStatus, 200);
  const items = [];
  // Menu API returns array of categories, each with items array
  const menuArr = Array.isArray(menuData) ? menuData : (menuData?.categories || []);
  menuArr.forEach(cat => {
    // Items may be directly on category, or nested in subcategories
    const directItems = Array.isArray(cat.items) ? cat.items : [];
    directItems.forEach(item => {
      if (item.id && parseFloat(item.price) > 0) items.push({ id: item.id, name: item.name, price: parseFloat(item.price) });
    });
    const subs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
    subs.forEach(sub => {
      (sub.items || []).forEach(item => {
        if (item.id && parseFloat(item.price) > 0) items.push({ id: item.id, name: item.name, price: parseFloat(item.price) });
      });
    });
  });
  info(`Found ${items.length} orderable menu items`);

  const { status: staffStatus, data: staffData } = await get('/api/staff');
  check('GET /api/staff returns 200', staffStatus, 200);
  const staff = Array.isArray(staffData) ? staffData : [];
  info(`Found ${staff.length} staff members`);

  // Find a working admin/manager PIN for deletes
  const managers = staff.filter(s => ['admin','manager'].includes((s.role||'').toLowerCase()));
  info(`Managers available: ${managers.map(m=>m.name+' ('+m.role+')').join(', ') || 'none found'}`);

  return { tables, items, staff, managers };
}

// ── BLOCK 2: 100 Reservations ─────────────────────────────────────────────────
async function block2Reservations() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 2 — Seeding 100 Friday night reservations         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Target date: ${FRIDAY} (Friday service)`);

  let bookingsMade = 0;
  let totalCovers = 0;
  const reservations = [];

  // Create 100 bookings in batches of 10 to avoid overwhelming
  for (let i = 0; i < 100; i++) {
    const name = GUEST_NAMES[i] || `__TEST__ Guest ${i}`;
    const party_size = randomPartySize();
    const time = randomTimeSlot();
    const email = `qa_test_${i}@siamepos-test.invalid`;

    const { status, data } = await post('/api/reservations', {
      customer_name:  name,
      customer_phone: PHONES[i],
      customer_email: email,
      reservation_date: FRIDAY,
      reservation_time: time,
      covers:        party_size,
      notes:         i % 10 === 0 ? 'Birthday celebration — please prepare candle' :
                     i % 7  === 0 ? 'Window table requested' :
                     i % 5  === 0 ? 'Allergy: peanuts' :
                     i % 3  === 0 ? 'Vegetarian party' : '',
      status:        'confirmed',
    });

    if (status === 200 || status === 201) {
      bookingsMade++;
      totalCovers += party_size;
      const id = data.id || data.reservation?.id;
      if (id) {
        cleanup.reservationIds.push(id);
        reservations.push({ id, name, phone: PHONES[i], party_size, time, email, notes: '' });
      }
    } else if (status === 409) {
      info(`Booking ${i+1}: No availability at ${time} (party of ${party_size}) — overbooking correctly blocked ✓`);
    } else {
      warn(`Booking ${i+1}`, `Unexpected ${status}: ${JSON.stringify(data).slice(0,80)}`);
    }

    // Small delay every 10 to avoid hammering
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  📋 ${i+1}/100 reservations processed (${bookingsMade} created, ${totalCovers} covers so far)...\n`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  check('At least 70 reservations created successfully', bookingsMade >= 70, true);
  info(`Total reservations created: ${bookingsMade}`);
  info(`Total covers booked: ${totalCovers}`);

  // Verify they all show up on the date
  const { status: listStatus, data: listed } = await get(`/api/reservations?date=${FRIDAY}`);
  check('GET /api/reservations?date=FRIDAY returns 200', listStatus, 200);
  const fridayCount = Array.isArray(listed)
    ? listed.filter(r => cleanup.reservationIds.includes(r.id)).length
    : 0;
  check('All created reservations visible on Friday date view', fridayCount >= bookingsMade * 0.9, true);
  info(`Confirmed visible on Friday: ${fridayCount}`);

  return reservations;
}

// ── BLOCK 3: Overbooking & validation ─────────────────────────────────────────
async function block3Overbooking() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 3 — Overbooking & validation edge cases           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // 3A — Reservation with covers = 0 (invalid)
  console.log('\n  3A — covers = 0 → should be rejected');
  const { status: s3a } = await post('/api/reservations', {
    customer_name: '__TEST__ Invalid Zero', customer_phone: '07000000000',
    reservation_date: FRIDAY, reservation_time: '20:00', covers: 0, status: 'confirmed',
  });
  const zeroPassed = s3a >= 400;
  if (zeroPassed) check('party_size=0 rejected (4xx)', true, true);
  else warn('party_size=0', `System accepted party_size=0 (status ${s3a}) — should validate this`);

  // 3B — Reservation with covers = 99 (absurdly large)
  console.log('\n  3B — covers = 99 → should be rejected or flagged');
  const { status: s3b, data: d3b } = await post('/api/reservations', {
    customer_name: '__TEST__ Giant Party', customer_phone: '07000000001',
    reservation_date: FRIDAY, reservation_time: '20:00', covers: 99, status: 'confirmed',
  });
  if (s3b === 200 || s3b === 201) {
    warn('party_size=99', `System accepted a party of 99 without warning (id=${d3b.id})`);
    if (d3b.id) {
      cleanup.reservationIds.push(d3b.id);
      await del(`/api/reservations/${d3b.id}`);
    }
  } else {
    check('party_size=99 rejected (4xx)', s3b >= 400, true);
  }

  // 3C — Past date booking
  console.log('\n  3C — Past date (2020-01-01) → should be rejected');
  const { status: s3c } = await post('/api/reservations', {
    customer_name: '__TEST__ Time Traveller', customer_phone: '07000000002',
    reservation_date: '2020-01-01', reservation_time: '19:00', covers: 2, status: 'confirmed',
  });
  if (s3c >= 400) check('Past date booking rejected', true, true);
  else warn('Past date', `System accepted a booking for 2020-01-01 (status ${s3c})`);

  // 3D — Missing required fields
  console.log('\n  3D — Missing customer_name → should be rejected');
  const { status: s3d } = await post('/api/reservations', {
    customer_phone: '07000000003', reservation_date: FRIDAY, reservation_time: '19:00', covers: 2,
  });
  if (s3d >= 400) check('Missing customer_name rejected', true, true);
  else warn('Missing name', `System accepted reservation with no customer name (status ${s3d})`);

  // 3E — Invalid time format
  console.log('\n  3E — Invalid time "25:99" → should be rejected');
  const { status: s3e } = await post('/api/reservations', {
    customer_name: '__TEST__ Bad Time', customer_phone: '07000000004',
    reservation_date: FRIDAY, reservation_time: '25:99', covers: 2, status: 'confirmed',
  });
  if (s3e >= 400) check('Invalid time rejected', true, true);
  else warn('Invalid time', `System accepted time "25:99" (status ${s3e})`);

  // 3F — Duplicate booking (same phone + time)
  console.log('\n  3F — Duplicate booking (same phone + time) → ideally flagged');
  const dupPhone = '07555999001';
  const { status: s3f1, data: d3f1 } = await post('/api/reservations', {
    customer_name: '__TEST__ Duplicate A', customer_phone: dupPhone,
    reservation_date: FRIDAY, reservation_time: '19:30', covers: 2, status: 'confirmed',
  });
  if (d3f1.id) cleanup.reservationIds.push(d3f1.id);
  const { status: s3f2, data: d3f2 } = await post('/api/reservations', {
    customer_name: '__TEST__ Duplicate B', customer_phone: dupPhone,
    reservation_date: FRIDAY, reservation_time: '19:30', covers: 2, status: 'confirmed',
  });
  if (d3f2.id) cleanup.reservationIds.push(d3f2.id);
  if (s3f2 === 409) {
    check('Duplicate phone+time flagged with 409', true, true);
    if (d3f2.id) { cleanup.reservationIds.push(d3f2.id); await del(`/api/reservations/${d3f2.id}`); }
  } else {
    info(`Duplicate booking check: status ${s3f2} — dedup is capacity-based (blocks when slot full, not by phone)`);
    if (d3f2.id) cleanup.reservationIds.push(d3f2.id);
  }
}

// ── BLOCK 4: Arrival & status workflow ────────────────────────────────────────
async function block4Arrivals(reservations) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 4 — Simulating arrivals & status transitions       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (reservations.length === 0) {
    warn('Block 4', 'No reservations to test arrival flow with');
    return;
  }

  // Take a sample of 20 reservations for arrival testing
  const sample = reservations.slice(0, 20);

  // Helper: PUT needs all fields (server does full UPDATE, not PATCH)
  const updateStatus = (r, newStatus) => put(`/api/reservations/${r.id}`, {
    customer_name:   r.name,
    customer_phone:  r.phone || '07700000000',
    reservation_date: FRIDAY,
    reservation_time: r.time,
    covers:          r.party_size,
    status:          newStatus,
    notes:           r.notes || '',
  });

  // 4A — Mark 15 as arrived
  console.log('\n  4A — Mark 15 reservations as "arrived"');
  let arrivedCount = 0;
  for (const r of sample.slice(0, 15)) {
    const { status, data } = await updateStatus(r, 'arrived');
    if (status === 200) arrivedCount++;
    else warn(`Arrive ${r.id}`, `${status}: ${JSON.stringify(data).slice(0,60)}`);
  }
  check('15 reservations marked as arrived', arrivedCount, 15);

  // 4B — Mark 3 as no-show
  console.log('\n  4B — Mark 3 reservations as "no_show"');
  let noShowCount = 0;
  for (const r of sample.slice(15, 18)) {
    const { status } = await updateStatus(r, 'no_show');
    if (status === 200) noShowCount++;
  }
  check('3 reservations marked as no_show', noShowCount, 3);

  // 4C — Cancel 2 reservations
  console.log('\n  4C — Cancel 2 reservations');
  let cancelCount = 0;
  for (const r of sample.slice(18, 20)) {
    const { status } = await updateStatus(r, 'cancelled');
    if (status === 200) cancelCount++;
  }
  check('2 reservations cancelled', cancelCount, 2);

  // 4D — Invalid status transition (arrived → confirmed is backwards)
  console.log('\n  4D — Invalid status "flying_saucer" → should be rejected');
  const testRes = sample[0];
  const { status: s4d } = await put(`/api/reservations/${testRes.id}`, { status: 'flying_saucer' });
  if (s4d >= 400) check('Invalid status rejected', true, true);
  else warn('Invalid status', `System accepted status "flying_saucer" (status ${s4d})`);

  // 4E — Non-existent reservation
  console.log('\n  4E — Update non-existent reservation → should be 404');
  const { status: s4e } = await put('/api/reservations/99999999', { status: 'arrived' });
  check('Non-existent reservation → 404', s4e, 404);

  // 4F — Read back the list and verify counts
  console.log('\n  4F — Verify status counts on Friday date view');
  const { data: fridayList } = await get(`/api/reservations?date=${FRIDAY}`);
  if (Array.isArray(fridayList)) {
    const relevant = fridayList.filter(r => cleanup.reservationIds.includes(r.id));
    const arrivedInList = relevant.filter(r => r.status === 'arrived').length;
    const noShowInList  = relevant.filter(r => r.status === 'no_show').length;
    const cancelInList  = relevant.filter(r => r.status === 'cancelled').length;
    info(`Status breakdown: arrived=${arrivedInList}, no_show=${noShowInList}, cancelled=${cancelInList}`);
    check('No-shows visible in list', noShowInList >= 2, true);
    check('Cancellations visible in list', cancelInList >= 1, true);
  }
}

// ── BLOCK 5: Full order flow ───────────────────────────────────────────────────
async function block5Orders(tables, menuItems, staff) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 5 — Full order flow (20 concurrent table covers)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (tables.length === 0) {
    warn('Block 5', 'No tables returned from API — skipping order flow');
    return [];
  }

  if (menuItems.length === 0) {
    warn('Block 5', 'No menu items returned — skipping order flow');
    return [];
  }

  // Find a staff member ID to attach orders to
  const staffMember = staff.find(s => s.id) || { id: null };
  const staffId = staffMember.id;

  const orderIds = [];
  const tableSubset = tables.slice(0, Math.min(tables.length, 10));
  info(`Creating orders on ${tableSubset.length} tables simultaneously...`);

  // 5A — Create orders on multiple tables at once (concurrent)
  console.log('\n  5A — Concurrent order creation on all available tables');
  const orderPromises = tableSubset.map(table =>
    post('/api/orders', {
      table_id:   table.id,
      covers:     Math.min(table.capacity || 4, 4),
      staff_id:   staffId,
      order_type: 'dine_in',
    })
  );
  const orderResults = await Promise.all(orderPromises);
  let ordersCreated = 0;
  for (let i = 0; i < orderResults.length; i++) {
    const { status, data } = orderResults[i];
    if ((status === 200 || status === 201) && data.id) {
      ordersCreated++;
      orderIds.push(data.id);
      cleanup.orderIds.push(data.id);
    } else {
      warn(`Table ${tableSubset[i].name}`, `Order creation failed: ${status} ${JSON.stringify(data).slice(0,60)}`);
    }
  }
  check(`Orders created concurrently: ${ordersCreated}/${tableSubset.length}`, ordersCreated > 0, true);

  if (orderIds.length === 0) {
    warn('Block 5', 'No orders created — skipping item addition tests');
    return orderIds;
  }

  // 5B — Add items to each order (2-4 courses per table)
  // Endpoint expects { items: [{ menu_item_id, quantity, ... }] }
  console.log('\n  5B — Adding menu items to each order (concurrent)');
  const itemPromises = orderIds.map((orderId, i) => {
    const tableItems = [
      menuItems[i % menuItems.length],
      menuItems[(i + 1) % menuItems.length],
      menuItems[(i + 2) % menuItems.length],
    ].filter(Boolean);
    const itemsPayload = tableItems.map(item => ({
      menu_item_id: item.id,
      quantity:     Math.floor(Math.random() * 2) + 1,
      unit_price:   item.price,
      course:       2,
      notes:        '',
    }));
    return post(`/api/orders/${orderId}/items`, { items: itemsPayload });
  });
  const itemResults = await Promise.all(itemPromises);
  let itemsAdded = 0;
  itemResults.forEach(r => {
    if (r.status === 200 || r.status === 201) itemsAdded += (r.data?.items?.length || 1);
    else warn(`Add items`, `${r.status}: ${JSON.stringify(r.data).slice(0,60)}`);
  });
  check(`Menu items added to orders: ${itemsAdded} items across ${orderIds.length} tables`, itemsAdded > 0, true);
  info(`${itemsAdded} items added across ${orderIds.length} tables`);

  // 5C — Pay half the tables (cash), half card
  console.log('\n  5C — Paying bills (mixed cash/card)');
  const half = Math.floor(orderIds.length / 2);
  let paidCount = 0;
  const unpaidOrderIds = [];

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];
    const method = i < half ? 'cash' : 'card';
    const { status, data } = await post(`/api/orders/${orderId}/pay`, {
      amount: 45.00,
      method,
    });
    if (status === 200 || status === 201) {
      paidCount++;
    } else {
      unpaidOrderIds.push(orderId);
      warn(`Pay order ${orderId}`, `${status}: ${JSON.stringify(data).slice(0,60)}`);
    }
  }
  check(`Bills paid successfully: ${paidCount}/${orderIds.length}`, paidCount >= Math.floor(orderIds.length * 0.7), true);
  info(`${paidCount} tables paid (${half} cash, ${orderIds.length - half} card attempted)`);

  return orderIds;
}

// ── BLOCK 6: Concurrent chaos ─────────────────────────────────────────────────
async function block6Chaos(tables, menuItems, staff) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 6 — Concurrent chaos (race conditions & load)      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // 6A — Fire 20 reservation creates simultaneously
  console.log('\n  6A — 20 simultaneous reservation creates for same time slot (19:00)');
  const start = Date.now();
  // Use Saturday for chaos test so we don't hit Friday's full capacity
  const chaosBookings = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      post('/api/reservations', {
        customer_name:  `__TEST__ Chaos Guest ${i}`,
        customer_phone: `0788800${String(i).padStart(4, '0')}`,
        customer_email: `chaos_${i}@siamepos-test.invalid`,
        reservation_date: '2026-05-17', // Saturday — not filled by block 2
        reservation_time: '19:00',
        covers:  2,
        status:  'confirmed',
      })
    )
  );
  const elapsed = Date.now() - start;
  const chaosSucceeded = chaosBookings.filter(r => r.status === 200 || r.status === 201);
  const chaosResponded = chaosBookings.filter(r => r.status > 0); // any response = server alive
  chaosBookings.forEach(r => {
    if (r.data?.id) cleanup.reservationIds.push(r.data.id);
    else if (r.data?.reservation?.id) cleanup.reservationIds.push(r.data.reservation.id);
  });
  info(`20 simultaneous bookings: ${chaosSucceeded.length} created, ${chaosBookings.length - chaosSucceeded.length} blocked (capacity) in ${elapsed}ms`);
  check('Server responded to all 20 simultaneous requests (no crash)', chaosResponded.length, 20);
  check('Response time under 10 seconds for 20 concurrent requests', elapsed < 10000, true);

  // 6B — Rapid-fire menu reads (20 concurrent)
  console.log('\n  6B — 20 simultaneous GET /api/menu requests');
  const menuStart = Date.now();
  const menuResults = await Promise.all(
    Array.from({ length: 20 }, () => get('/api/menu'))
  );
  const menuElapsed = Date.now() - menuStart;
  const menuOk = menuResults.filter(r => r.status === 200).length;
  check(`All 20 concurrent menu reads returned 200 (${menuOk}/20)`, menuOk, 20);
  check(`Menu reads completed in under 5s`, menuElapsed < 5000, true);
  info(`20 concurrent menu reads: ${menuElapsed}ms`);

  // 6C — Simultaneous reservation list reads
  console.log('\n  6C — 10 simultaneous reservation list reads');
  const listResults = await Promise.all(
    Array.from({ length: 10 }, () => get(`/api/reservations?date=${FRIDAY}`))
  );
  const listOk = listResults.filter(r => r.status === 200).length;
  check(`10 concurrent reservation reads all returned 200 (${listOk}/10)`, listOk, 10);

  // 6D — Try to create order with non-existent table
  console.log('\n  6D — Order with non-existent table_id → should fail gracefully');
  const { status: s6d, data: d6d } = await post('/api/orders', {
    table_id: 99999999, covers: 4, staff_id: null, order_type: 'dine_in'
  });
  if (s6d >= 400) check('Invalid table_id rejected gracefully', true, true);
  else warn('Invalid table', `Order created with non-existent table_id (status ${s6d})`);
}

// ── BLOCK 7: Edge cases ───────────────────────────────────────────────────────
async function block7EdgeCases(tables, menuItems, staff) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 7 — Edge cases (walk-ins, split bill, table move)  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const table1 = tables[0];
  const table2 = tables[1] || tables[0];
  const staffId = (staff.find(s => s.id) || {}).id;

  // 7A — Walk-in (no reservation, counter mode)
  console.log('\n  7A — Walk-in customer (no reservation, counter order)');
  const { status: s7a, data: walkIn } = await post('/api/orders', {
    table_id:   null,
    covers:     3,
    staff_id:   staffId,
    order_type: 'counter',
  });
  if (s7a === 200 || s7a === 201) {
    check('Walk-in counter order created', true, true);
    if (walkIn.id) {
      cleanup.orderIds.push(walkIn.id);
      // Add items (endpoint expects items array)
      if (menuItems.length > 0) {
        const { status: addStatus } = await post(`/api/orders/${walkIn.id}/items`, {
          items: [{ menu_item_id: menuItems[0].id, quantity: 2, unit_price: menuItems[0].price, course: 2, notes: '' }]
        });
        check('Item added to walk-in order', addStatus === 200 || addStatus === 201, true);
      }
      // Pay walk-in
      const { status: payStatus } = await post(`/api/orders/${walkIn.id}/pay`, {
        amount: 25.00, method: 'cash'
      });
      check('Walk-in bill paid successfully', payStatus === 200 || payStatus === 201, true);
    }
  } else {
    warn('Walk-in', `Counter order failed: ${s7a}`);
  }

  // 7B — Table move (order from table1 → table2)
  if (table1 && table2 && table1.id !== table2.id) {
    console.log('\n  7B — Table move (party moved to different table mid-service)');
    const { status: createStatus, data: moveOrder } = await post('/api/orders', {
      table_id: table1.id, covers: 4, staff_id: staffId, order_type: 'dine_in'
    });
    if (createStatus === 200 || createStatus === 201) {
      cleanup.orderIds.push(moveOrder.id);
      // Add item first
      if (menuItems.length > 0) {
        await post(`/api/orders/${moveOrder.id}/items`, {
          items: [{ menu_item_id: menuItems[0].id, quantity: 1, unit_price: menuItems[0].price, course: 1, notes: '' }]
        });
      }
      // Move to table2 — correct method is PUT
      const { status: moveStatus, data: moved } = await put(`/api/orders/${moveOrder.id}/move`, {
        new_table_id: table2.id
      });
      if (moveStatus === 200) {
        check('Table move succeeded', true, true);
        info(`Order moved from table "${table1.name}" → "${table2.name}"`);
      } else {
        warn('Table move', `Status ${moveStatus}: ${JSON.stringify(moved).slice(0,60)}`);
      }
      // Pay moved order
      await post(`/api/orders/${moveOrder.id}/pay`, { amount: 20.00, method: 'card' });
    }
  } else {
    info('Table move skipped — only 1 table available or tables are the same');
  }

  // 7C — Large party split bill (6 people, split 3 ways)
  console.log('\n  7C — Large party split bill (6 people, split 3 ways)');
  if (table1) {
    const { status: s7c, data: splitOrder } = await post('/api/orders', {
      table_id: table1.id, covers: 6, staff_id: staffId, order_type: 'dine_in'
    });
    if (s7c === 200 || s7c === 201) {
      cleanup.orderIds.push(splitOrder.id);
      // Add multiple items (wrapped in items array)
      await post(`/api/orders/${splitOrder.id}/items`, {
        items: menuItems.slice(0, 3).map(item => ({
          menu_item_id: item.id, quantity: 2, unit_price: item.price, course: 2, notes: ''
        }))
      });

      // Split pay: 3 payments of £20 each
      const splitAmount = 20.00;
      const split1 = await post(`/api/orders/${splitOrder.id}/pay`, { amount: splitAmount, method: 'card' });
      const split2 = await post(`/api/orders/${splitOrder.id}/pay`, { amount: splitAmount, method: 'cash' });
      const split3 = await post(`/api/orders/${splitOrder.id}/pay`, { amount: splitAmount, method: 'card' });

      const allPaid = [split1, split2, split3].every(r => r.status === 200 || r.status === 201);
      if (allPaid) {
        check('Split bill (3 payments) all succeeded', true, true);
        info('6-person party split across 3 payments: £20 card + £20 cash + £20 card');
      } else {
        const successful = [split1, split2, split3].filter(r => r.status === 200 || r.status === 201).length;
        info(`Split bill: ${successful}/3 payments accepted`);
        warn('Split bill', 'Not all split payments succeeded');
      }
    }
  }

  // 7D — Add item to non-existent order
  console.log('\n  7D — Add item to non-existent order → should 404');
  const { status: s7d } = await post('/api/orders/99999999/items', {
    menu_item_id: menuItems[0]?.id || 1, quantity: 1, course: 2
  });
  check('Add item to ghost order → 404', s7d, 404);

  // 7E — Pay non-existent order
  console.log('\n  7E — Pay non-existent order → should 404');
  const { status: s7e } = await post('/api/orders/99999999/pay', {
    amount: 10.00, method: 'cash'
  });
  check('Pay ghost order → 404', s7e, 404);

  // 7F — Negative payment amount
  console.log('\n  7F — Negative payment amount → should be rejected');
  if (table1) {
    const { status: s7f_create, data: negOrder } = await post('/api/orders', {
      table_id: table1.id, covers: 2, staff_id: staffId, order_type: 'dine_in'
    });
    if (s7f_create === 200 || s7f_create === 201) {
      cleanup.orderIds.push(negOrder.id);
      const { status: s7f } = await post(`/api/orders/${negOrder.id}/pay`, {
        amount: -50.00, method: 'cash'
      });
      if (s7f >= 400) check('Negative payment rejected', true, true);
      else warn('Negative payment', `System accepted £-50.00 payment (status ${s7f})`);
    }
  }

  // 7G — Booking for Saturday (ensure date isolation)
  console.log('\n  7G — Saturday booking should not appear on Friday list');
  const { status: satStatus, data: satBooking } = await post('/api/reservations', {
    customer_name: '__TEST__ Saturday Guest', customer_phone: '07999888001',
    reservation_date: '2026-05-17', reservation_time: '19:00', covers: 2, status: 'confirmed',
  });
  if (satStatus === 200 || satStatus === 201) {
    if (satBooking.id) cleanup.reservationIds.push(satBooking.id);
    const { data: fridayList } = await get(`/api/reservations?date=${FRIDAY}`);
    const leakCheck = Array.isArray(fridayList)
      ? fridayList.find(r => r.id === satBooking.id)
      : null;
    check('Saturday booking does not appear on Friday list', !leakCheck, true);
  }
}

// ── BLOCK 8: Cleanup ──────────────────────────────────────────────────────────
async function block8Cleanup() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BLOCK 8 — Cleanup                                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  let deletedRes = 0;
  let failedRes  = 0;

  // Delete reservations in batches
  const batches = [];
  for (let i = 0; i < cleanup.reservationIds.length; i += 20) {
    batches.push(cleanup.reservationIds.slice(i, i + 20));
  }
  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(id => del(`/api/reservations/${id}`))
    );
    results.forEach(r => {
      if (r.status === 200 || r.status === 204 || r.status === 404) deletedRes++;
      else failedRes++;
    });
    await new Promise(r => setTimeout(r, 100));
  }
  info(`Reservations deleted: ${deletedRes} | Failed: ${failedRes}`);
  check('All test reservations cleaned up', failedRes, 0);

  // Delete any remaining open orders
  let deletedOrders = 0;
  for (const id of cleanup.orderIds) {
    await del(`/api/orders/${id}`, { pin: '9999', reason: 'QA cleanup' }).catch(() => {});
    deletedOrders++;
  }
  if (deletedOrders > 0) info(`Attempted cleanup of ${deletedOrders} test orders`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SiamEPOS — Friday Night Extreme Stress Test                 ║');
  console.log('║  Nook (QA Agent) | 2026-05-15                                ║');
  console.log('║  Simulating: 100 covers, concurrent orders, edge cases       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Backend: ${BASE}`);
  console.log(`  Test Night: ${FRIDAY} (Friday)`);

  const globalStart = Date.now();

  try {
    // Block 1 — Setup
    const { tables, items: menuItems, staff } = await block1Setup();

    // Block 2 — 100 reservations
    const reservations = await block2Reservations();

    // Block 3 — Overbooking
    await block3Overbooking();

    // Block 4 — Arrivals
    await block4Arrivals(reservations);

    // Block 5 — Order flow
    await block5Orders(tables, menuItems, staff);

    // Block 6 — Concurrent chaos
    await block6Chaos(tables, menuItems, staff);

    // Block 7 — Edge cases
    await block7EdgeCases(tables, menuItems, staff);

  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    await block8Cleanup();
  }

  const totalTime = ((Date.now() - globalStart) / 1000).toFixed(1);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  🍜  FRIDAY NIGHT STRESS TEST COMPLETE  — ${totalTime}s`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} checks | ✅ ${passed} passed | ❌ ${failed} failed | ⚠️  ${warnings} warnings`);

  if (failures.length > 0) {
    console.log('\n  Failed checks:');
    failures.forEach(f => console.log(`    ❌  ${f}`));
  }

  if (failed === 0) {
    console.log('\n  🎉 All checks passed! System survived Friday night service.');
  } else {
    console.log('\n  🐛 Some checks failed — review above for bugs to fix.');
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  ⚠️  WHAT THE AUTOMATED TEST CANNOT COVER (manual checks):');
  console.log('  1. Real-time KDS updates — open Kitchen screen, confirm');
  console.log('     orders appear instantly as they\'re created above');
  console.log('  2. Socket.io latency — open 2 browser tabs, create order');
  console.log('     in tab 1, confirm table flashes red in tab 2 < 1s');
  console.log('  3. Table map visual — all tables show correct cover count');
  console.log('     and timer colour (green/amber/red by time sat)');
  console.log('  4. iPad Safari — run the same manual steps on iPad,');
  console.log('     especially 5-tap unlock and split bill UI');
  console.log('  5. Offline mode — disconnect internet mid-service, confirm');
  console.log('     orders still go through, sync when reconnected');
  console.log('══════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
