#!/usr/bin/env node
/**
 * SiamEPOS — full restaurant-day simulation + stress test
 *
 * Korakot, 2026-08-07: "run the simulation in every situation to make sure
 * there are no issue — open order, self-order, online order, online booking,
 * whatever situation that will happen to a restaurant, and stress test."
 *
 * Drives the REAL server over HTTP against a scratch SQLite database — no
 * mocks, no stubs. Every scenario is followed by invariant checks, because a
 * scenario that "works" while quietly leaving money unaccounted for is worse
 * than one that fails loudly.
 *
 *   node test-restaurant-day.js
 *
 * Exit code 0 = every scenario and invariant passed.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.SIM_PORT || 3391);
const B = `http://localhost:${PORT}`;
const SECRET = 'simsecret';
const DB = path.join(process.env.TMPDIR || '/tmp', `sim-${Date.now()}.db`);

let server = null;
const results = [];
let failures = 0;

// ── tiny harness ────────────────────────────────────────────────────────────
const j = (r) => r.json().catch(() => ({}));
const api = async (method, url, body, headers = {}) => {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': SECRET, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await j(r);
  return { status: r.status, ok: r.ok, data };
};
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b);
const PUT = (u, b) => api('PUT', u, b);

function check(name, condition, detail = '') {
  const pass = !!condition;
  if (!pass) failures++;
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
  return pass;
}
const money = (n) => `£${Number(n || 0).toFixed(2)}`;
const qrToken = (tableId) =>
  `${tableId}.${crypto.createHmac('sha256', SECRET).update(`qr-table:${tableId}`).digest('base64url').slice(0, 20)}`;

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  console.log(`\n🍽️  SiamEPOS restaurant-day simulation\n    db: ${DB}\n`);
  server = spawn('node', ['src/server.js'], {
    env: { ...process.env, DB_MODE: 'local', SQLITE_PATH: DB, PORT: String(PORT), NODE_ENV: 'test', SYNC_SECRET: SECRET },
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch(`${B}/api/health`); if (r.ok) { console.log('server up\n'); return log; } } catch {}
  }
  console.error('server failed to start:\n', log.join(''));
  process.exit(1);
}

async function seed() {
  process.env.DB_MODE = 'local'; process.env.SQLITE_PATH = DB;
  const pool = require('./src/db/localDatabase');
  await new Promise((r) => setTimeout(r, 500));
  // a plausible small Thai restaurant: 6 tables, 2 bar seats, 1 takeaway slot
  const tables = [
    [1, 1, 'Table 1', 2], [2, 2, 'Table 2', 4], [3, 3, 'Table 3', 4],
    [4, 4, 'Table 4', 6], [5, 5, 'Bar 1', 1], [6, 6, 'Bar 2', 1],
  ];
  for (const [id, n, name, cap] of tables) {
    await pool.query(`INSERT INTO tables (id,table_number,name,capacity,status) VALUES ($1,$2,$3,$4,'available')`, [id, n, name, cap]);
  }
  await pool.query(`INSERT INTO tables (id,table_number,name,capacity,status) VALUES (7,7,'Table 7',4,'available')`);
  await pool.query(`INSERT INTO tables (id,table_number,name,capacity,status,is_takeaway) VALUES (9,9,'Takeaway',1,'available',1)`);
  await pool.query(`INSERT INTO categories (id,name,sort_order,is_bar) VALUES (1,'Starters',1,0)`);
  await pool.query(`INSERT INTO categories (id,name,sort_order,is_bar) VALUES (2,'Mains',2,0)`);
  await pool.query(`INSERT INTO categories (id,name,sort_order,is_bar) VALUES (3,'Drinks',3,1)`);
  const items = [
    [1, 1, 'Spring Rolls', 6.50], [2, 1, 'Tom Yum Soup', 7.50],
    [3, 2, 'Pad Thai', 11.50], [4, 2, 'Green Curry', 12.50], [5, 2, 'Massaman Beef', 14.00],
    [6, 3, 'Singha Beer', 5.00], [7, 3, 'Thai Iced Tea', 4.00],
  ];
  for (const [id, cat, name, price] of items) {
    await pool.query(`INSERT INTO menu_items (id,category_id,name,price,is_available,is_online) VALUES ($1,$2,$3,$4,1,1)`, [id, cat, name, price]);
  }
  await pool.query(`INSERT INTO settings (key,value) VALUES ('qr_ordering_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
  await pool.query(`INSERT INTO settings (key,value) VALUES ('service_charge_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`);
  await pool.query(`INSERT INTO settings (key,value) VALUES ('service_charge_rate','12.5') ON CONFLICT(key) DO UPDATE SET value='12.5'`);
  console.log('seeded: 6 tables + 2 bar seats + takeaway slot, 7 dishes, 12.5% service charge\n');
  return pool;
}

// ── invariants — run after every scenario ───────────────────────────────────
async function invariants(pool, label) {
  console.log(`\n  — invariants after ${label} —`);
  // 1. every CLOSED order with a total is covered by its tenders
  const bad = (await pool.query(`
    SELECT o.id, o.total, COALESCE((SELECT SUM(amount) FROM payments p
      WHERE p.order_id = o.id AND COALESCE(p.method,'') <> 'cancelled'),0) AS paid
      FROM orders o WHERE o.status='closed' AND o.total > 0`)).rows
    .filter(r => Number(r.paid) + 0.005 < Number(r.total));
  check('every closed bill is covered by its tenders', bad.length === 0,
    bad.map(b => `#${b.id} ${money(b.paid)}/${money(b.total)}`).join(', '));

  // 2. no tender is attached to a non-existent order
  const orphanPays = (await pool.query(`SELECT p.id FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE o.id IS NULL`)).rows;
  check('no orphaned tenders', orphanPays.length === 0, `${orphanPays.length} orphan(s)`);

  // 3. a table is only 'occupied' while it actually holds an open order
  const ghosts = (await pool.query(`
    SELECT t.id, t.name FROM tables t WHERE t.status='occupied'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status='open')`)).rows;
  check('no table left occupied without an open order', ghosts.length === 0,
    ghosts.map(g => g.name).join(', '));

  // 4. one Stripe PaymentIntent settles at most one tender
  const dupPi = (await pool.query(`
    SELECT payment_intent_id, COUNT(*) n FROM payments
     WHERE payment_intent_id IS NOT NULL GROUP BY payment_intent_id HAVING COUNT(*) > 1`)).rows;
  check('no payment intent used twice', dupPi.length === 0, JSON.stringify(dupPi));

  // 5. a QR order only ever contains prepaid rounds (the redo's core rule)
  const qrUnpaid = (await pool.query(`
    SELECT o.id FROM orders o WHERE o.source='qr'
      AND COALESCE((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0) + 0.005 < o.total`)).rows;
  check('every QR order fully covered by its own tenders', qrUnpaid.length === 0,
    qrUnpaid.map(o => `#${o.id}`).join(', '));

  // 6. no closed order missing from the Bills view (needs a non-cancelled tender)
  const closedPaid = (await pool.query(`
    SELECT COUNT(*) n FROM orders o WHERE o.status='closed' AND o.total > 0
      AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND COALESCE(p.method,'') <> 'cancelled')`)).rows[0].n;
  const bills = (await GET(`/api/bills?from=2020-01-01&to=2100-01-01`)).data;
  const billCount = Array.isArray(bills) ? bills.length : (bills.bills || []).length;
  check('Bills shows every closed, paid order', Number(closedPaid) === Number(billCount),
    `db says ${closedPaid}, Bills shows ${billCount}`);
}

// ── scenarios ───────────────────────────────────────────────────────────────
async function scenarioDineIn(pool) {
  console.log('\n📋 SCENARIO 1 — ordinary dine-in: open, fire courses, add more, pay by card');
  const o = await POST('/api/orders', { table_id: 1, covers: 2 });
  check('order opened', o.data.id > 0);
  const orderId = o.data.id;
  await POST(`/api/orders/${orderId}/items`, { items: [
    { menu_item_id: 1, quantity: 2, unit_price: 6.50 },
    { menu_item_id: 3, quantity: 1, unit_price: 11.50 },
  ]});
  const t = (await GET(`/api/tables`)).data.find(x => x.id === 1);
  check('table shows occupied', t && t.status === 'occupied', t && t.status);
  // second round later in the meal
  await POST(`/api/orders/${orderId}/items`, { items: [{ menu_item_id: 6, quantity: 2, unit_price: 5.00 }] });
  const ord = (await GET(`/api/orders/${orderId}`)).data;
  const expected = 2 * 6.50 + 11.50 + 2 * 5.00;
  check('running total correct after two rounds', Math.abs(Number(ord.total) - expected) < 0.005,
    `${money(ord.total)} vs ${money(expected)}`);
  // pay including service charge
  const bill = (await GET(`/api/orders/${orderId}/bill`)).data;
  const sc = expected * 0.125;
  const pay = await POST(`/api/orders/${orderId}/pay`, { amount: expected + sc, method: 'Card' });
  check('payment accepted', pay.ok && pay.data.success, JSON.stringify(pay.data));
  const after = (await GET(`/api/orders/${orderId}`)).data;
  check('order closed', after.status === 'closed', after.status);
  const t2 = (await GET(`/api/tables`)).data.find(x => x.id === 1);
  check('table freed', t2 && t2.status === 'available', t2 && t2.status);
  void bill;
}

async function scenarioSelfOrder(pool) {
  console.log('\n📱 SCENARIO 2 — QR self-order: two rounds from one phone, then serve → auto-close');
  const tok = qrToken(2);
  const r1 = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 3, quantity: 1 }] });
  check('first QR round accepted', r1.ok && r1.data.success, JSON.stringify(r1.data));
  const r2 = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 7, quantity: 2 }] });
  check('second round joined the SAME QR order', r2.data.order_id === r1.data.order_id,
    `${r1.data.order_id} vs ${r2.data.order_id}`);
  check('each round returned its own tender', r1.data.payment_id !== r2.data.payment_id);
  const ord = (await GET(`/api/orders/${r1.data.order_id}`)).data;
  const paid = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [ord.id])).rows[0].s;
  check('QR order fully prepaid', Number(paid) + 0.005 >= Number(ord.total), `${money(paid)}/${money(ord.total)}`);
  // kitchen serves everything → prepaid auto-close
  for (const it of ord.items) await PUT(`/api/order-items/${it.id}/status`, { status: 'served' });
  await new Promise(r => setTimeout(r, 400));
  const after = (await GET(`/api/orders/${ord.id}`)).data;
  check('auto-closed once every item served', after.status === 'closed', after.status);
  const tb = (await GET(`/api/tables`)).data.find(x => x.id === 2);
  check('table freed by the auto-close', tb && tb.status === 'available', tb && tb.status);
  // the receipt the customer gets, scoped to their own payment
  const rec = (await GET(`/api/qr/receipt/${tok}?order_id=${ord.id}&payment_id=${r1.data.payment_id}`)).data;
  check('receipt scoped to that payment', rec.scoped_to_payment === true);
  check('receipt total = that round only', Math.abs(Number(rec.total) - 11.50) < 0.005, money(rec.total));
}

async function scenarioSharedTable(pool) {
  console.log('\n👥 SCENARIO 3 — shared table: 4 people self-order separately (Korakot\'s case)');
  const tok = qrToken(3);
  const dishes = [[1, 6.50], [2, 7.50], [4, 12.50], [6, 5.00]];
  const rounds = [];
  for (const [id] of dishes) {
    const r = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: id, quantity: 1 }] });
    rounds.push(r.data);
  }
  check('all four guests ordered', rounds.every(r => r.success));
  check('all four landed on ONE table order', new Set(rounds.map(r => r.order_id)).size === 1);
  check('four distinct tenders', new Set(rounds.map(r => r.payment_id)).size === 4);
  // each guest's receipt shows only their own food and their own total
  for (let i = 0; i < rounds.length; i++) {
    const rec = (await GET(`/api/qr/receipt/${tok}?order_id=${rounds[i].order_id}&payment_id=${rounds[i].payment_id}`)).data;
    const want = dishes[i][1];
    const ok = rec.items.length === 1 && Math.abs(Number(rec.total) - want) < 0.005;
    check(`guest ${i + 1} receipt = own item only (${money(want)})`, ok,
      `${rec.items.length} item(s), ${money(rec.total)}`);
  }
}

async function scenarioWaiterPlusQr(pool) {
  console.log('\n🤝 SCENARIO 4 — QR round on a table the waiter already opened');
  const o = await POST('/api/orders', { table_id: 4, covers: 4 });
  await POST(`/api/orders/${o.data.id}/items`, { items: [{ menu_item_id: 5, quantity: 2, unit_price: 14.00 }] });
  const before = (await GET(`/api/orders/${o.data.id}`)).data;
  const qr = await POST(`/api/qr/orders/${qrToken(4)}`, { items: [{ menu_item_id: 7, quantity: 1 }] });
  check('QR round accepted', qr.ok && qr.data.success);
  check('QR did NOT join the waiter bill', qr.data.order_id !== o.data.id,
    `waiter #${o.data.id} vs qr #${qr.data.order_id}`);
  const after = (await GET(`/api/orders/${o.data.id}`)).data;
  check('waiter bill total unchanged', Math.abs(Number(after.total) - Number(before.total)) < 0.005,
    `${money(before.total)} → ${money(after.total)}`);
  check('waiter bill not marked paid', !after.payment_status, String(after.payment_status));
  const waiterPays = (await pool.query(`SELECT COUNT(*) n FROM payments WHERE order_id=$1`, [o.data.id])).rows[0].n;
  check('no tender attached to the waiter bill', Number(waiterPays) === 0);
  // clean up: staff settle the waiter bill normally
  await POST(`/api/orders/${o.data.id}/pay`, { amount: 28.00 * 1.125, method: 'Cash' });
  const qrOrd = (await GET(`/api/orders/${qr.data.order_id}`)).data;
  for (const it of qrOrd.items) await PUT(`/api/order-items/${it.id}/status`, { status: 'served' });
}

async function scenarioOnlineTakeaway(pool) {
  console.log('\n🥡 SCENARIO 5 — online takeaway order (website)');
  // Pick a pickup slot inside opening hours — the server correctly refuses an
  // out-of-hours order, and this suite may run at any time of night.
  const pickup = new Date(Date.now() + 86400000);
  pickup.setUTCHours(12, 30, 0, 0);
  const r = await POST('/api/takeaway/orders', {
    pickup_time: pickup.toISOString(),
    customer_name: 'Jane Doe', customer_phone: '07700900123', customer_email: 'jane@example.com',
    items: [{ menu_item_id: 3, quantity: 2, unit_price: 11.50, name: 'Pad Thai' },
            { menu_item_id: 6, quantity: 1, unit_price: 5.00, name: 'Singha Beer' }],
    notes: 'No peanuts please — allergy',
  });
  check('takeaway order accepted', r.ok && (r.data.success || r.data.order_id || r.data.order_number), JSON.stringify(r.data).slice(0, 120));
  const id = r.data.order_id || r.data.id;
  if (id) {
    const ord = (await GET(`/api/orders/${id}`)).data;
    check('order is takeaway type', ord.order_type === 'takeaway', ord.order_type);
    check('allergy note preserved', /peanut/i.test(String(ord.customer_note || ord.notes || '')),
      String(ord.customer_note || ord.notes));
  }
}

async function scenarioBooking(pool) {
  console.log('\n📅 SCENARIO 6 — online booking (website widget)');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await POST('/api/reservations', {
    customer_name: 'Mr Smith', customer_phone: '07700900456', customer_email: 'smith@example.com',
    covers: 4, reservation_date: tomorrow, reservation_time: '19:30', notes: 'Window table if possible',
  });
  check('booking accepted', r.ok && (r.data.id || r.data.success), JSON.stringify(r.data).slice(0, 120));
  const list = (await GET(`/api/reservations?date=${tomorrow}`)).data;
  const arr = Array.isArray(list) ? list : (list.reservations || []);
  check('booking appears in the diary', arr.some(x => x.customer_name === 'Mr Smith'), `${arr.length} booking(s)`);
}

async function scenarioVoidsAndDiscounts(pool) {
  console.log('\n✂️  SCENARIO 7 — mistakes: void an item, discount a bill');
  const o = await POST('/api/orders', { table_id: 5, covers: 1 });
  await POST(`/api/orders/${o.data.id}/items`, { items: [
    { menu_item_id: 4, quantity: 1, unit_price: 12.50 },
    { menu_item_id: 5, quantity: 1, unit_price: 14.00 },
  ]});
  const ord = (await GET(`/api/orders/${o.data.id}`)).data;
  const wrong = ord.items[1];
  await PUT(`/api/order-items/${wrong.id}/void`, { reason: 'Wrong Order', void_type: 'wrong_order' });
  const afterVoid = (await GET(`/api/orders/${o.data.id}`)).data;
  check('void removed the item from the total', Math.abs(Number(afterVoid.total) - 12.50) < 0.005, money(afterVoid.total));
  await PUT(`/api/orders/${o.data.id}/discount`, { discount_type: 'percent', discount_value: 10, reason: 'Regular' });
  const afterDisc = (await GET(`/api/orders/${o.data.id}`)).data;
  check('discount recorded', Number(afterDisc.discount_value) === 10, String(afterDisc.discount_value));
  await POST(`/api/orders/${o.data.id}/pay`, { amount: 12.50 * 0.9 * 1.125, method: 'Cash' });
  const done = (await GET(`/api/orders/${o.data.id}`)).data;
  check('discounted bill closed', done.status === 'closed', done.status);
}

async function scenarioSplitPayment(pool) {
  console.log('\n💷 SCENARIO 8 — split payment (half cash, half card)');
  const o = await POST('/api/orders', { table_id: 6, covers: 2 });
  await POST(`/api/orders/${o.data.id}/items`, { items: [{ menu_item_id: 5, quantity: 2, unit_price: 14.00 }] });
  const total = 28.00 * 1.125;
  const r = await POST(`/api/orders/${o.data.id}/pay`, {
    amount: total, method: 'Split',
    payments: [{ amount: total / 2, method: 'Cash' }, { amount: total / 2, method: 'Card' }],
  });
  check('split payment accepted', r.ok && r.data.success, JSON.stringify(r.data));
  const pays = (await pool.query(`SELECT method, amount FROM payments WHERE order_id=$1`, [o.data.id])).rows;
  check('two tenders recorded with their real methods', pays.length === 2 && pays.some(p => p.method === 'Cash') && pays.some(p => p.method === 'Card'),
    JSON.stringify(pays));
  const sum = pays.reduce((a, p) => a + Number(p.amount), 0);
  check('tenders sum to the bill', Math.abs(sum - total) < 0.02, `${money(sum)} vs ${money(total)}`);
}

async function scenarioDoubleTap(pool) {
  console.log('\n👆 SCENARIO 9 — staff double-tap "Done": must never charge twice');
  const o = await POST('/api/orders', { table_id: 1, covers: 2 });
  await POST(`/api/orders/${o.data.id}/items`, { items: [{ menu_item_id: 3, quantity: 1, unit_price: 11.50 }] });
  const amount = 11.50 * 1.125;
  const [a, b] = await Promise.all([
    POST(`/api/orders/${o.data.id}/pay`, { amount, method: 'Card' }),
    POST(`/api/orders/${o.data.id}/pay`, { amount, method: 'Card' }),
  ]);
  const okCount = [a, b].filter(x => x.data && x.data.success).length;
  check('exactly one payment succeeded', okCount === 1, `a=${a.status} b=${b.status}`);
  const pays = (await pool.query(`SELECT COUNT(*) n FROM payments WHERE order_id=$1`, [o.data.id])).rows[0].n;
  check('only ONE tender recorded', Number(pays) === 1, `${pays} tenders`);
}

async function scenarioStress(pool) {
  console.log('\n🔥 SCENARIO 10 — STRESS: 20 simultaneous QR rounds across 3 tables');
  const before = (await pool.query(`SELECT COUNT(*) n FROM orders`)).rows[0].n;
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    const table = [1, 2, 3][i % 3];
    jobs.push(POST(`/api/qr/orders/${qrToken(table)}`, { items: [{ menu_item_id: (i % 7) + 1, quantity: 1 }] }));
  }
  const t0 = Date.now();
  const res = await Promise.all(jobs);
  const ms = Date.now() - t0;
  const okCount = res.filter(r => r.data && r.data.success).length;
  check('all 20 concurrent rounds accepted', okCount === 20, `${okCount}/20 in ${ms}ms`);
  console.log(`     (${ms}ms for 20 concurrent orders — ${Math.round(ms / 20)}ms each)`);
  // exactly one QR order per table, not one per request
  const perTable = (await pool.query(
    `SELECT table_id, COUNT(*) n FROM orders WHERE source='qr' AND status='open' GROUP BY table_id`)).rows;
  check('no duplicate orders created by the race', perTable.every(r => Number(r.n) === 1),
    JSON.stringify(perTable));
  // every tender recorded, none lost
  const totals = (await pool.query(`
    SELECT o.id, o.total, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0) paid
      FROM orders o WHERE o.source='qr' AND o.status='open'`)).rows;
  const mismatched = totals.filter(t => Math.abs(Number(t.paid) - Number(t.total)) > 0.005);
  check('every stressed order still fully paid', mismatched.length === 0,
    mismatched.map(m => `#${m.id} ${money(m.paid)}/${money(m.total)}`).join(', '));
  const after = (await pool.query(`SELECT COUNT(*) n FROM orders`)).rows[0].n;
  console.log(`     orders in system: ${before} → ${after}`);
}

async function scenarioReportsReconcile(pool) {
  console.log('\n📊 SCENARIO 11 — do the reports agree with the money actually taken?');
  // close everything still open so the day is complete
  const open = (await pool.query(`SELECT id, total FROM orders WHERE status='open'`)).rows;
  for (const o of open) {
    const paid = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [o.id])).rows[0].s;
    if (Number(paid) + 0.005 >= Number(o.total) && Number(o.total) > 0) {
      const ord = (await GET(`/api/orders/${o.id}`)).data;
      for (const it of (ord.items || [])) await PUT(`/api/order-items/${it.id}/status`, { status: 'served' });
    } else if (Number(o.total) > 0) {
      await POST(`/api/orders/${o.id}/pay`, { amount: Number(o.total) * 1.125, method: 'Cash' });
    } else {
      await POST(`/api/orders/${o.id}/pay`, { amount: 0, method: 'cancelled' });
    }
  }
  await new Promise(r => setTimeout(r, 600));
  const realMoney = (await pool.query(`
    SELECT COALESCE(SUM(amount),0) s FROM payments
     WHERE COALESCE(method,'') <> 'cancelled' AND COALESCE(method,'') NOT LIKE '%(mock)%'`)).rows[0].s;
  const mockMoney = (await pool.query(`
    SELECT COALESCE(SUM(amount),0) s FROM payments WHERE COALESCE(method,'') LIKE '%(mock)%'`)).rows[0].s;
  console.log(`     real tenders ${money(realMoney)} · demo/mock tenders ${money(mockMoney)}`);
  const today = new Date().toISOString().slice(0, 10);
  for (const [name, url] of [
    ['daily', `/api/reports/daily?date=${today}`],
    ['summary', `/api/reports/summary?from=${today}&to=${today}`],
    ['menu-performance', `/api/reports/menu-performance?from=${today}&to=${today}`],
  ]) {
    const r = await GET(url);
    check(`${name} report responds`, r.ok, `HTTP ${r.status}`);
  }
  const summary = (await GET(`/api/reports/summary?from=${today}&to=${today}`)).data;
  const reported = Number(summary.total_paid ?? summary.total_sales ?? 0);
  check('reports exclude demo/mock money from takings',
    Math.abs(reported - Number(realMoney)) < Math.max(0.05, Number(mockMoney)),
    `report ${money(reported)} vs real ${money(realMoney)} (mock ${money(mockMoney)} must NOT be counted)`);
}


// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TESTS — written BEFORE the fix, for the two criticals that the
// adversarial verification found in the batch I shipped on 2026-08-07. Both
// existed because this suite only drove the direction I had already thought
// of. They must FAIL against the shipped code and PASS after the fix.
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioWaiterOntoQrOrder(pool) {
  console.log('\n🔴 SCENARIO 12 — REGRESSION: waiter adds items to a PREPAID QR order');
  console.log('     (the reverse of scenario 4 — the direction I never tested)');
  // customer scans and pays for their own round
  const qr = await POST(`/api/qr/orders/${qrToken(6)}`, { items: [{ menu_item_id: 3, quantity: 1 }] });
  check('customer QR round placed', qr.ok && qr.data.success, JSON.stringify(qr.data));
  const qrOrderId = qr.data.order_id;
  const paidByCustomer = 11.50;

  // A) the floor must not hand a waiter the customer's prepaid order
  const opened = await POST('/api/orders', { table_id: 6, covers: 2 });
  check('opening the table does NOT reuse the prepaid QR order',
    opened.data.id !== qrOrderId,
    `table 6 handed back QR order #${qrOrderId}`);

  // B) even if items DO reach it, the bill must not close while money is owed
  const add = await POST(`/api/orders/${qrOrderId}/items`, {
    items: [{ menu_item_id: 5, quantity: 2, unit_price: 14.00 }],   // £28 of waiter food
  });
  // The money-loss path is now closed BY CONSTRUCTION: staff cannot add to a
  // customer's prepaid QR order at all, so un-tendered items can never reach it.
  check('adding waiter items to a prepaid QR order is refused', !add.ok || add.status === 409,
    `status ${add.status}`);
  const ord = (await GET(`/api/orders/${qrOrderId}`)).data;
  const tendered = (await pool.query(
    `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1 AND COALESCE(method,'') <> 'cancelled'`,
    [qrOrderId])).rows[0].s;
  check('QR order total unchanged (no waiter items landed)', Math.abs(Number(ord.total) - paidByCustomer) < 0.005,
    `${money(ord.total)} vs ${money(paidByCustomer)}`);
  check('customer charged exactly their own round', Math.abs(Number(tendered) - paidByCustomer) < 0.005, money(tendered));
}

async function scenarioHeldOnlyWhenActuallyHeld(pool) {
  console.log('\n🔴 SCENARIO 13 — REGRESSION: "held" must mean a ticket really was held');
  // point the kitchen at an unroutable address so the print genuinely fails
  await PUT('/api/settings', { printer_kitchen_ip: '192.0.2.1', printer_kitchen_port: '9100' });
  const o = await POST('/api/orders', { table_id: 3, covers: 2 });
  await POST(`/api/orders/${o.data.id}/items`, { items: [{ menu_item_id: 3, quantity: 1, unit_price: 11.50 }] });
  const printed = await POST(`/api/print/kitchen`, { order_id: o.data.id, course: 1 });
  const pending = (await pool.query(`SELECT COUNT(*) n FROM print_failures WHERE status='pending'`)).rows[0].n;
  // The contract: the response may only claim 'held' when a ticket is actually
  // sitting in the queue for staff to retry. Claiming it otherwise makes the
  // client stop its fallback chain and the ticket prints NOWHERE.
  const claimsHeld = printed.data && printed.data.held === true;
  check('"held" is only claimed when a ticket is actually queued',
    !claimsHeld || Number(pending) > 0,
    `held=${claimsHeld} but ${pending} ticket(s) queued`);
  // NOTE: this route currently holds nothing on a plain (station-less) kitchen
  // print failure — a separate pre-existing gap in SEPOS-PRINT-ALERT-001, logged
  // rather than asserted here so this suite stays about tonight's regressions.
  // Verify pass — this used to only log. Now assert the contract that broke in
  // production: the response's 'held' must reflect whether a ticket was really
  // queued, never claim held when nothing was kept.
  check('response held-flag matches the queue state',
    claimsHeld === (Number(pending) > 0),
    `held=${claimsHeld} but ${pending} queued`);
  await PUT('/api/settings', { printer_kitchen_ip: '', printer_kitchen_port: '' });
  await POST(`/api/orders/${o.data.id}/pay`, { amount: 11.50 * 1.125, method: 'Cash' });
}

async function scenarioCloudNeverClaimsHeld() {
  console.log('\n🔴 SCENARIO 14 — REGRESSION: a CLOUD install has no held-ticket queue at all');
  // printAlertService is local-only by design (a cloud server can't reach a
  // restaurant's LAN printer). Require it with DB_MODE=cloud and prove
  // recordFailure is a no-op — so nothing may report a ticket as "held".
  const { execFileSync } = require('child_process');
  const probe = `
    process.env.DB_MODE='cloud';
    const pa = require('${path.join(__dirname, 'src/services/printAlertService.js')}');
    pa.init({ pool: { query: async () => ({ rows: [] }) }, io: null, printService: {} });
    Promise.resolve(pa.recordFailure({ kind:'kitchen', printer:{name:'K'}, order:{id:1}, items:[], reason:'x' }))
      .then(v => { console.log(JSON.stringify({ recorded: v === true })); });
  `;
  let recorded = null;
  try {
    const out = execFileSync('node', ['-e', probe], { encoding: 'utf8', timeout: 20000 });
    recorded = JSON.parse(out.trim().split('\n').pop()).recorded;
  } catch (e) { recorded = `probe failed: ${e.message.slice(0, 60)}`; }
  check('recordFailure reports NOT-recorded on a cloud install', recorded === false,
    `returned ${JSON.stringify(recorded)} — the route must not claim held from this`);

  // THE ACTUAL DEFECT: the print routes set err.ticketHeld = true unconditionally,
  // right next to recordFailure — which is a no-op on cloud. So a cloud till
  // answers "held" for a ticket nobody kept, the client stops its fallback chain,
  // and the ticket prints NOWHERE. The route must derive 'held' FROM the
  // recording, never assert it independently.
  const src = fs.readFileSync(path.join(__dirname, 'src/server.js'), 'utf8');
  const unconditional = (src.match(/err\.ticketHeld\s*=\s*true/g) || []).length;
  const derived = (src.match(/ticketHeld\s*=\s*(await\s+)?printAlerts\.recordFailure/g) || []).length;
  check('print routes derive "held" from the recording, not assert it',
    unconditional === 0 && derived > 0,
    `${unconditional} unconditional assignment(s), ${derived} derived`);
}


async function scenarioConfirmCollectionNoDoubleTender(pool) {
  console.log('\n🔴 SCENARIO 15 — REGRESSION: "Confirm collection" must not tender a prepaid bill twice');
  const tok = qrToken(7);   // its own table — this scenario counts tenders exactly
  const r1 = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 4, quantity: 1 }] });
  const r2 = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 6, quantity: 1 }] });
  const orderId = r1.data.order_id;
  const ord = (await GET(`/api/orders/${orderId}`)).data;
  const beforePays = (await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [orderId])).rows[0];
  check('two prepaid rounds recorded', Number(beforePays.n) === 2, `${beforePays.n} tender(s)`);

  // this is exactly what the till's "✓ Confirm collection · £X" button posts
  await POST(`/api/orders/${orderId}/pay`, { amount: Number(ord.total), method: 'Online (Stripe)' });

  const afterPays = (await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [orderId])).rows[0];
  const after = (await GET(`/api/orders/${orderId}`)).data;
  check('closing a PREPAID bill adds no second tender',
    Number(afterPays.n) === Number(beforePays.n),
    `${beforePays.n} → ${afterPays.n} tenders, ${money(beforePays.s)} → ${money(afterPays.s)} on a ${money(ord.total)} bill`);
  check('tenders still equal the bill (not double)',
    Math.abs(Number(afterPays.s) - Number(ord.total)) < 0.005,
    `${money(afterPays.s)} vs ${money(ord.total)}`);
  check('the bill did close', after.status === 'closed', after.status);
  void r2;
}

async function scenarioQrFailureIsAtomic(pool) {
  console.log('\n🔴 SCENARIO 16 — REGRESSION: a QR round is all-or-nothing');
  // an item that exists but is 86'd mid-cart: the round must not half-land
  await PUT('/api/menu/items/2', { name: 'Tom Yum Soup', price: 7.50, category_id: 1, is_available: 0 });
  const before = (await pool.query(`SELECT COUNT(*) n FROM order_items`)).rows[0].n;
  const r = await POST(`/api/qr/orders/${qrToken(4)}`, {
    items: [{ menu_item_id: 3, quantity: 1 }, { menu_item_id: 2, quantity: 1 }],
  });
  const after = (await pool.query(`SELECT COUNT(*) n FROM order_items`)).rows[0].n;
  check('a rejected round fires NOTHING to the kitchen', Number(after) === Number(before),
    `${before} → ${after} item rows for a ${r.status} response`);
  const orphan = (await pool.query(
    `SELECT COUNT(*) n FROM orders o WHERE o.source='qr' AND o.status='open'
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id)`)).rows[0].n;
  check('no empty QR order left behind', Number(orphan) === 0, `${orphan} empty`);
  await PUT('/api/menu/items/2', { name: 'Tom Yum Soup', price: 7.50, category_id: 1, is_available: 1 });
}


async function scenarioQrOrderIsStaffReadOnly(pool) {
  console.log('\n🔴 SCENARIO 17 — REGRESSION: staff cannot pollute a customer\'s prepaid QR order');
  const tok = qrToken(5);
  const qr = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 4, quantity: 1 }] });
  const qrId = qr.data.order_id;
  const before = (await pool.query(`SELECT total FROM orders WHERE id=$1`, [qrId])).rows[0].total;

  // A) a waiter must not be able to add staff items onto the prepaid QR order
  const add = await POST(`/api/orders/${qrId}/items`, { items: [{ menu_item_id: 5, quantity: 2, unit_price: 14.00 }] });
  const afterAdd = (await pool.query(`SELECT total FROM orders WHERE id=$1`, [qrId])).rows[0].total;
  check('adding staff items to a QR order is refused', !add.ok || add.status === 409,
    `status ${add.status}`);
  check('QR order total unchanged by the attempt', Math.abs(Number(afterAdd) - Number(before)) < 0.005,
    `${money(before)} → ${money(afterAdd)}`);

  // B) a customer's prepaid QR order must not be merge-able into a staff bill
  //    (the real contract is PUT :targetId/merge with { merge_order_id }).
  const w = await POST('/api/orders', { table_id: 4, covers: 2 });
  await POST(`/api/orders/${w.data.id}/items`, { items: [{ menu_item_id: 3, quantity: 1, unit_price: 11.50 }] });
  const wPaysBefore = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [w.data.id])).rows[0].s;
  const mg = await PUT(`/api/orders/${w.data.id}/merge`, { merge_order_id: qrId });
  check('merging a prepaid QR order into a staff bill is refused', !mg.ok || mg.status === 409,
    `status ${mg.status}`);
  // whatever the outcome, the guest's £12 must never be billed a second time:
  const qrItems = (await pool.query(`SELECT COUNT(*) n FROM order_items WHERE order_id=$1`, [qrId])).rows[0].n;
  const qrPaid = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [qrId])).rows[0].s;
  check('the prepaid QR order is intact (items + its own tender)',
    Number(qrItems) > 0 && Number(qrPaid) + 0.005 >= Number(before),
    `${qrItems} items, ${money(qrPaid)} tendered vs ${money(before)}`);
  // clean up whatever remained open
  for (const id of [qrId, w.data.id]) {
    const o = (await GET(`/api/orders/${id}`)).data;
    if (o && o.status === 'open') {
      const paid = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`,[id])).rows[0].s;
      if (Number(paid) + 0.005 >= Number(o.total)) { for (const it of (o.items||[])) await PUT(`/api/order-items/${it.id}/status`,{status:'served'}); }
      else await POST(`/api/orders/${id}/pay`, { amount: Number(o.total)*1.125, method:'Cash' });
    }
  }
}


async function scenarioQrOrderFullyReadOnly(pool) {
  console.log('\n🔴 SCENARIO 18 — REGRESSION: EVERY staff money-mutation on a QR order is refused');
  const tok = qrToken(6);
  const r = await POST(`/api/qr/orders/${tok}`, { items: [{ menu_item_id: 4, quantity: 2 }] });
  const orderId = r.data.order_id;
  const ord = (await GET(`/api/orders/${orderId}`)).data;
  const before = Number(ord.total);
  const itemId = ord.items[0].id;

  const attempts = [
    ['order discount',   () => PUT(`/api/orders/${orderId}/discount`, { discount_type: 'percent', discount_value: 50, reason: 'x' })],
    ['service charge',   () => PUT(`/api/orders/${orderId}/service-charge`, { no_service_charge: 1 })],
    ['item void',        () => PUT(`/api/order-items/${itemId}/void`, { reason: 'Wastage', void_type: 'wastage' })],
    ['item discount',    () => PUT(`/api/order-items/${itemId}/discount`, { discount_type: 'percent', discount_value: 50 })],
  ];
  for (const [name, fn] of attempts) {
    const res = await fn().catch(() => ({ ok: false, status: 0 }));
    check(`${name} on a prepaid QR order is refused`, !res.ok || res.status === 409, `status ${res.status}`);
  }
  const after = (await GET(`/api/orders/${orderId}`)).data;
  const paid = (await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=$1`, [orderId])).rows[0].s;
  check('QR order total unchanged by all attempts', Math.abs(Number(after.total) - before) < 0.005,
    `${money(before)} → ${money(after.total)}`);
  check('tenders still exactly cover it', Math.abs(Number(paid) - before) < 0.005, `${money(paid)} vs ${money(before)}`);
}

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  await boot();
  const pool = await seed();
  try {
    await scenarioDineIn(pool);         await invariants(pool, 'dine-in');
    await scenarioSelfOrder(pool);      await invariants(pool, 'self-order');
    await scenarioSharedTable(pool);    await invariants(pool, 'shared table');
    await scenarioWaiterPlusQr(pool);   await invariants(pool, 'waiter + QR');
    await scenarioOnlineTakeaway(pool); await invariants(pool, 'online takeaway');
    await scenarioBooking(pool);
    await scenarioVoidsAndDiscounts(pool); await invariants(pool, 'voids/discounts');
    await scenarioSplitPayment(pool);   await invariants(pool, 'split payment');
    await scenarioDoubleTap(pool);      await invariants(pool, 'double-tap');
    await scenarioStress(pool);         await invariants(pool, 'stress');
    await scenarioWaiterOntoQrOrder(pool);   await invariants(pool, 'waiter onto QR order');
    await scenarioHeldOnlyWhenActuallyHeld(pool); await invariants(pool, 'held-ticket honesty');
    await scenarioCloudNeverClaimsHeld();
    await scenarioConfirmCollectionNoDoubleTender(pool); await invariants(pool, 'confirm collection');
    await scenarioQrFailureIsAtomic(pool);               await invariants(pool, 'atomic QR round');
    await scenarioQrOrderIsStaffReadOnly(pool);          await invariants(pool, 'QR order staff-safe');
    await scenarioQrOrderFullyReadOnly(pool);            await invariants(pool, 'QR fully read-only');
    await scenarioReportsReconcile(pool); await invariants(pool, 'end of day');
  } catch (err) {
    console.error('\n💥 simulation crashed:', err.stack || err.message);
    failures++;
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${passed}/${results.length} checks passed${failures ? `  —  ${failures} FAILURE(S)` : '  —  all clear'}`);
  if (failures) {
    console.log('\n  failed:');
    for (const r of results.filter(x => !x.pass)) console.log(`   ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`${'═'.repeat(64)}\n`);
  try { server.kill(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch {} }
  process.exit(failures ? 1 : 0);
})();
