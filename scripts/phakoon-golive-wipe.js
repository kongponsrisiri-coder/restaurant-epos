#!/usr/bin/env node
// Phakoon go-live wipe — deletes ALL test orders (open + closed) on the
// phakoon cloud so the tenant is clean for the till install.
// Backup already taken: scripts/.secrets-phakoon-testdata-backup-2026-08-27.json
//
// Usage:  node scripts/phakoon-golive-wipe.js <ADMIN_PIN>
//
// Keeps: menu (95 items), tables (10), settings, staff.
// Removes: orders + order_items + payments + stock movements (via the
// standard DELETE /api/orders/:id cascade — audit rows are written).
// Customers/reservations tabs empty themselves once the orders are gone.

const BASE = 'https://phakoon.siamepos.co.uk';
const PIN = process.argv[2];
if (!PIN) { console.error('Usage: node scripts/phakoon-golive-wipe.js <ADMIN_PIN>'); process.exit(1); }

const REASON = 'Go-live wipe of demo/test data (Krit, 2026-08-27)';

async function main() {
  // Sanity check we are talking to the right tenant before deleting anything.
  const settings = await (await fetch(`${BASE}/api/settings`)).json();
  const name = settings.company_name || settings.restaurant_name;
  if (!/phakoon/i.test(name || '')) {
    console.error(`ABORT: tenant identifies as "${name}", not Phakoon.`);
    process.exit(1);
  }
  console.log(`Tenant confirmed: ${name}`);

  const open = await (await fetch(`${BASE}/api/orders`)).json();
  const bills = await (await fetch(`${BASE}/api/bills`)).json();
  const ids = [...open.map(o => o.id), ...bills.map(b => b.id)];
  console.log(`Deleting ${ids.length} orders (${open.length} open + ${bills.length} closed): ${ids.join(', ')}`);

  for (const id of ids) {
    const res = await fetch(`${BASE}/api/orders/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN, reason: REASON }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`  order ${id}: ${res.status} ${res.ok ? 'deleted' : JSON.stringify(body)}`);
    if (res.status === 403) { console.error('Wrong PIN — stopping.'); process.exit(1); }
  }

  // Verify clean.
  const openAfter = await (await fetch(`${BASE}/api/orders`)).json();
  const billsAfter = await (await fetch(`${BASE}/api/bills`)).json();
  console.log(`\nVerify: open orders = ${openAfter.length}, closed bills = ${billsAfter.length}`);
  console.log(openAfter.length === 0 && billsAfter.length === 0
    ? '✅ Phakoon cloud is CLEAN — ready for the till install.'
    : '⚠️ Something remains — tell Krit.');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
