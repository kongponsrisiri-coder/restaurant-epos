/**
 * SiamEPOS — Marketing Mock-up Seeder
 * Author: Nook (QA Agent)
 *
 * Populates the LIVE app with realistic-looking data so Korakot can take
 * marketing screenshots of three screens:
 *   1. Table map / seating  — occupied tables with covers + running timers
 *   2. Reservations         — a full evening of bookings (today)
 *   3. Kitchen Display (KDS) — live tickets (course 1 fired on every table)
 *
 * HOW TO RUN (on your PC, from the repo folder):
 *   cd ~/Desktop/restaurant-epos      (Windows: cd %USERPROFILE%\Desktop\restaurant-epos)
 *   node mockup-seed.js
 *
 * Every record it creates is written to  mockup-ids.json  so that
 *   node mockup-cleanup.js
 * can remove it all again after you've taken the screenshots.
 *
 * Optional:
 *   BASE=https://restaurant-epos-production.up.railway.app  (default)
 *   OCCUPY=0.65   fraction of tables to seat (default 0.65)
 */

const fs = require('fs');
const path = require('path');

const BASE   = process.env.BASE   || 'https://restaurant-epos-production.up.railway.app';
const OCCUPY = parseFloat(process.env.OCCUPY || '0.65');
const IDS_FILE = path.join(__dirname, 'mockup-ids.json');
const today  = new Date().toISOString().slice(0, 10);

// ── API helpers ────────────────────────────────────────────────────────────
async function api(method, p, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res  = await fetch(BASE + p, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}
const get  = (p)    => api('GET',    p);
const post = (p, b) => api('POST',   p, b);
const put  = (p, b) => api('PUT',    p, b);

const created = { reservationIds: [], orderIds: [], occupiedTableIds: [], createdAt: new Date().toISOString(), base: BASE };
const save = () => fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));

// ── Realistic marketing data ────────────────────────────────────────────────
const GUESTS = [
  { name: 'Emma Thompson',   phone: '07700900111', covers: 2, time: '18:00', notes: 'Window table if possible' },
  { name: 'James Wilson',    phone: '07700900112', covers: 4, time: '18:15', notes: '' },
  { name: 'Sophia Patel',    phone: '07700900113', covers: 2, time: '18:30', notes: 'Anniversary — celebrating 10 years' },
  { name: 'Oliver Davies',   phone: '07700900114', covers: 6, time: '18:30', notes: 'One guest has a peanut allergy' },
  { name: 'Grace Martin',    phone: '07700900115', covers: 3, time: '18:45', notes: '' },
  { name: 'Harry Brown',     phone: '07700900116', covers: 2, time: '19:00', notes: '' },
  { name: 'Isabella Clarke', phone: '07700900117', covers: 4, time: '19:15', notes: 'Birthday — please bring a candle with dessert' },
  { name: 'George Taylor',   phone: '07700900118', covers: 5, time: '19:30', notes: '' },
  { name: 'Amelia Harris',   phone: '07700900119', covers: 2, time: '19:45', notes: 'Vegetarian party' },
  { name: 'Charlie White',   phone: '07700900120', covers: 4, time: '20:00', notes: '' },
  { name: 'Lily Anderson',   phone: '07700900121', covers: 2, time: '20:15', notes: 'Quiet table please' },
  { name: 'Noah Green',      phone: '07700900122', covers: 7, time: '20:30', notes: 'Work celebration dinner' },
  { name: 'Mia Edwards',     phone: '07700900123', covers: 2, time: '20:45', notes: '' },
  { name: 'Lucas Sanders',   phone: '07700900124', covers: 4, time: '21:00', notes: '' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n========================================================');
  console.log('  SiamEPOS — Marketing Mock-up Seeder');
  console.log('  Backend:', BASE);
  console.log('  Date:   ', today);
  console.log('========================================================\n');

  // 1) Discover live tables, menu, staff -------------------------------------
  const tRes = await get('/api/tables');
  if (tRes.status !== 200 || !Array.isArray(tRes.data)) {
    console.error('❌ Could not read /api/tables (status ' + tRes.status + '). Is the backend reachable?');
    process.exit(1);
  }
  const tables = tRes.data;
  console.log(`Found ${tables.length} tables.`);

  const mRes = await get('/api/menu');
  const menuArr = Array.isArray(mRes.data) ? mRes.data : (mRes.data?.categories || []);
  const starters = [];
  const mains    = [];
  menuArr.forEach(cat => {
    const isBar = cat.is_bar === 1 || cat.is_bar === true;
    const catName = (cat.name || '').toLowerCase();
    const isStarter = /starter|appetis|appetiz|soup|side|salad/.test(catName);
    const pushItem = (it) => {
      if (!it.id || !(parseFloat(it.price) > 0) || isBar) return;
      (isStarter ? starters : mains).push({ id: it.id, name: it.name, price: parseFloat(it.price) });
    };
    (cat.items || []).forEach(pushItem);
    (cat.subcategories || []).forEach(sub => (sub.items || []).forEach(pushItem));
  });
  // Fallbacks so the script still works whatever the menu shape is
  if (starters.length === 0 && mains.length > 1) starters.push(mains.shift());
  if (mains.length === 0) { console.error('❌ No orderable food items found in /api/menu.'); process.exit(1); }
  console.log(`Found ${starters.length} starter-ish items and ${mains.length} main-ish items.`);

  const sRes = await get('/api/staff');
  const staff = Array.isArray(sRes.data) ? sRes.data : [];
  const server = staff.find(s => /waiter|server|manager|admin/i.test(s.role || '')) || staff[0] || {};
  console.log(`Using staff: ${server.name || '(none)'} ${server.role ? '(' + server.role + ')' : ''}\n`);

  // 2) Reservations for tonight ----------------------------------------------
  console.log('--- Creating reservations for tonight ---');
  let bookingsMade = 0;
  for (const g of GUESTS) {
    const { status, data } = await post('/api/reservations', {
      customer_name:    g.name,
      customer_phone:   g.phone,
      reservation_date: today,
      reservation_time: g.time,
      covers:           g.covers,
      notes:            g.notes,
      source:           'staff',     // staff source => created as confirmed, no party cap
      status:           'confirmed',
    });
    const id = data.booking_id || data.reservation?.id || data.id;
    if ((status === 200 || status === 201) && id) {
      created.reservationIds.push(id);
      bookingsMade++;
      console.log(`  ✅ ${g.time}  ${g.name} (×${g.covers})`);
    } else {
      console.log(`  ⚠️  ${g.time}  ${g.name} — ${status}: ${JSON.stringify(data).slice(0, 80)}`);
    }
    save();
    await sleep(80);
  }
  console.log(`  → ${bookingsMade} reservations created.\n`);

  // 3) Seat tables + add items + fire course 1 (for KDS) ---------------------
  console.log('--- Seating tables + opening orders ---');
  const nToSeat = Math.max(1, Math.round(tables.length * OCCUPY));
  // Seat a spread of tables (every other one) so the floor looks busy but not 100% full
  const toSeat = tables.filter((_, i) => i % 2 === 0).concat(tables.filter((_, i) => i % 2 === 1)).slice(0, nToSeat);

  let seated = 0, idx = 0;
  for (const table of toSeat) {
    const covers = Math.min(table.capacity || 4, [2, 2, 3, 4, 4, 5][idx % 6]);
    const oRes = await post('/api/orders', {
      table_id: table.id, covers, staff_id: server.id || null, order_type: 'dine_in',
    });
    const orderId = oRes.data?.id;
    if (!orderId) {
      console.log(`  ⚠️  Table "${table.name}" — order failed: ${oRes.status} ${JSON.stringify(oRes.data).slice(0,60)}`);
      idx++; continue;
    }
    created.orderIds.push(orderId);
    created.occupiedTableIds.push(table.id);

    // 1 starter (course 1) + 1-2 mains (course 2)
    const starter = starters[idx % starters.length];
    const main1   = mains[idx % mains.length];
    const main2   = mains[(idx + 1) % mains.length];
    const items = [
      { menu_item_id: starter.id, quantity: covers >= 4 ? 2 : 1, course: 1, notes: '' },
      { menu_item_id: main1.id,   quantity: covers >= 4 ? 2 : 1, course: 2, notes: '' },
    ];
    if (covers >= 3) items.push({ menu_item_id: main2.id, quantity: 1, course: 2, notes: '' });
    await post(`/api/orders/${orderId}/items`, { items });

    // Fire course 1 on every table so the KDS shows live tickets.
    await put(`/api/orders/${orderId}/fire-course/1`, {});
    // Fire course 2 on roughly half the tables — busier kitchen.
    if (idx % 2 === 0) await put(`/api/orders/${orderId}/fire-course/2`, {});

    seated++;
    console.log(`  ✅ Table "${table.name}" — order #${orderId}, ${covers} covers, course 1 fired${idx % 2 === 0 ? ' + course 2' : ''}`);
    save();
    await sleep(120);
  }
  console.log(`  → ${seated} tables seated.\n`);

  save();

  // Summary -------------------------------------------------------------------
  console.log('========================================================');
  console.log('  DONE — mock-up data is live.');
  console.log('  Reservations created :', created.reservationIds.length);
  console.log('  Tables seated        :', created.occupiedTableIds.length);
  console.log('  Open orders          :', created.orderIds.length);
  console.log('  IDs saved to         :', IDS_FILE);
  console.log('--------------------------------------------------------');
  console.log('  Now log into app.siamepos.co.uk and screenshot:');
  console.log('   • Table map  — occupied tables with covers + timers');
  console.log('   • Reservations (today) — full evening of bookings');
  console.log('   • Kitchen / KDS — live tickets');
  console.log('  Note: timers all start "now" (green) — the API stamps');
  console.log('  opened_at = current time, so all seats look freshly sat.');
  console.log('--------------------------------------------------------');
  console.log('  When finished, remove it all with:  node mockup-cleanup.js');
  console.log('========================================================\n');
}

main().catch(e => { console.error('💥 Fatal:', e); save(); process.exit(1); });
