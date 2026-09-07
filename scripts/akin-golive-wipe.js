#!/usr/bin/env node
// Akin Thai go-live wipe — deletes ALL test orders (open + closed) on the
// akin-thai cloud so the tenant is clean for live trading.
// Inventory at time of writing (31 Aug 2026): 21 open test orders + 3 closed
// £0 test orders; 0 reservations, 0 active takeaway.
//
// Usage:  node scripts/akin-golive-wipe.js <ADMIN_PIN>
//
// Keeps: menu (103 items), tables, settings, staff, printers, weekly hours.
// Removes: orders + order_items + payments (standard DELETE /api/orders/:id
// cascade — audit rows are written, tables freed).
// STEP 1 backs everything up to scripts/.secrets-akin-testdata-backup-<date>.json
// BEFORE any delete; the file is gitignored (scripts/.secrets-*).

const BASE = 'https://siamepos-akin-thai-production.up.railway.app';
const PIN = process.argv[2];
if (!PIN) { console.error('Usage: node scripts/akin-golive-wipe.js <ADMIN_PIN>'); process.exit(1); }

const REASON = 'Go-live wipe of install/test data (Krit, 2026-08-31)';

async function main() {
  // Sanity check we are talking to the right tenant before deleting anything.
  const settings = await (await fetch(`${BASE}/api/settings`)).json();
  const name = settings.company_name || settings.restaurant_name;
  if (!/akin/i.test(name || '')) {
    console.error(`ABORT: tenant identifies as "${name}", not Akin Thai.`);
    process.exit(1);
  }
  console.log(`Tenant confirmed: ${name}`);

  const open = await (await fetch(`${BASE}/api/orders`)).json();
  const bills = await (await fetch(`${BASE}/api/bills?from=2026-01-01&to=2026-12-31&method=all`)).json();
  const ids = [...new Set([...open.map(o => o.id), ...bills.map(b => b.id)])];
  console.log(`Found ${ids.length} orders (${open.length} open + ${bills.length} closed): ${ids.join(', ')}`);

  // ── STEP 1: backup before deleting ──
  const backup = { taken_at: new Date().toISOString(), tenant: name, orders: [] };
  for (const id of ids) {
    const o = await (await fetch(`${BASE}/api/orders/${id}`)).json().catch(() => null);
    if (o) backup.orders.push(o);
  }
  const fs = require('fs');
  const out = `scripts/.secrets-akin-testdata-backup-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(out, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${out} (${backup.orders.length} orders)`);

  // ── STEP 2: delete via the audited API ──
  let ok = 0, fail = 0;
  for (const id of ids) {
    const res = await fetch(`${BASE}/api/orders/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PIN, reason: REASON }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { ok++; console.log(`  deleted #${id}`); }
    else { fail++; console.log(`  FAILED #${id}: ${body.error || res.status}`); }
  }
  console.log(`Done: ${ok} deleted, ${fail} failed.`);

  const after = await (await fetch(`${BASE}/api/orders`)).json();
  console.log(`Open orders remaining on cloud: ${after.length}`);
}

main().catch((e) => { console.error('wipe failed:', e.message); process.exit(1); });
