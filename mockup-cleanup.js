/**
 * SiamEPOS — Marketing Mock-up Cleanup
 * Author: Nook (QA Agent)
 *
 * Removes everything mockup-seed.js created (reads mockup-ids.json).
 * Deleting an order also frees its table back to "available".
 *
 * HOW TO RUN (on your PC, from the repo folder):
 *   node mockup-cleanup.js
 *
 * Deleting an order needs a manager/admin/supervisor PIN. Set it if your
 * PIN is not 0000:
 *   PIN=1234 node mockup-cleanup.js          (Windows: set PIN=1234 && node mockup-cleanup.js)
 */

const fs = require('fs');
const path = require('path');

const IDS_FILE = path.join(__dirname, 'mockup-ids.json');
const PIN  = process.env.PIN || '0000';

if (!fs.existsSync(IDS_FILE)) {
  console.error('❌ mockup-ids.json not found. Nothing to clean up (or run mockup-seed.js first).');
  process.exit(1);
}
const ids  = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
const BASE = process.env.BASE || ids.base || 'https://restaurant-epos-production.up.railway.app';

async function api(method, p, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res  = await fetch(BASE + p, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { error: e.message } }; }
}
const del = (p, b) => api('DELETE', p, b);

async function main() {
  console.log('\n=== SiamEPOS Mock-up Cleanup ===');
  console.log('Backend:', BASE);
  console.log(`Removing ${ids.orderIds.length} orders and ${ids.reservationIds.length} reservations...\n`);

  // Orders first (also frees the tables)
  let okOrders = 0, pinFail = 0;
  for (const id of ids.orderIds) {
    const { status, data } = await del(`/api/orders/${id}`, { pin: PIN, reason: 'Marketing mock-up cleanup' });
    if (status === 200) { okOrders++; }
    else if (status === 403) { pinFail++; console.log(`  ⚠️  Order ${id}: PIN rejected`); }
    else if (status === 404) { okOrders++; /* already gone */ }
    else console.log(`  ⚠️  Order ${id}: ${status} ${JSON.stringify(data).slice(0,60)}`);
  }
  console.log(`Orders removed: ${okOrders}/${ids.orderIds.length}`);
  if (pinFail > 0) {
    console.log(`\n❌ ${pinFail} order(s) could not be deleted — the PIN "${PIN}" was rejected.`);
    console.log(`   Re-run with a valid manager PIN, e.g.:  PIN=1234 node mockup-cleanup.js`);
  }

  // Reservations
  let okRes = 0;
  for (const id of ids.reservationIds) {
    const { status } = await del(`/api/reservations/${id}`, {});
    if (status === 200 || status === 204 || status === 404) okRes++;
    else console.log(`  ⚠️  Reservation ${id}: ${status}`);
  }
  console.log(`Reservations removed: ${okRes}/${ids.reservationIds.length}`);

  if (okOrders === ids.orderIds.length && okRes === ids.reservationIds.length) {
    fs.renameSync(IDS_FILE, IDS_FILE + '.done');
    console.log('\n✅ All clean. Tables freed. (mockup-ids.json archived as .done)');
  } else {
    console.log('\n⚠️  Some records remain — mockup-ids.json kept so you can re-run cleanup.');
  }
  console.log('================================\n');
}

main().catch(e => { console.error('💥 Fatal:', e); process.exit(1); });
