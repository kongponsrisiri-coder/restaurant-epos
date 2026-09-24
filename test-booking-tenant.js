// SEPOS-BOOK-TENANT-001 regression test — a website booking must ALWAYS land
// under the server's own restaurant_id, whatever the widget sends.
//
// 24 Sep 2026: widget embeds without data-restaurant posted 'siamepos'; the
// server trusted it, so Yum Yum (18) and Baan Rao (2) bookings were saved but
// never shown on the till. This boots a throwaway local-SQLite server as
// venue 'testvenue' and checks every booking path.
//
// Run: node test-booking-tenant.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 4799;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booktenant-'));

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, DB_MODE: 'local', SQLITE_PATH: path.join(dir, 't.db'), RESTAURANT_ID: 'testvenue', PORT: String(PORT), NODE_ENV: 'development', MULTI_TENANT: '0', BREVO_API_KEY: '', CLOUD_API_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);

  // 1. Widget posts the WRONG id (the old default) — must land under testvenue.
  const wrong = await j('POST', '/api/reservations', { restaurant_id: 'siamepos', customer_name: 'Test Guest', customer_phone: '07700900123', covers: 2, reservation_date: day, reservation_time: '19:00' });
  assert.strictEqual(wrong.status, 201, `booking with wrong id should be accepted, got ${wrong.status} ${JSON.stringify(wrong.body)}`);

  // 2. Widget posts NO id at all.
  const none = await j('POST', '/api/reservations', { customer_name: 'Test Guest Two', customer_phone: '07700900124', covers: 2, reservation_date: day, reservation_time: '19:30' });
  assert.strictEqual(none.status, 201, `booking without id should be accepted, got ${none.status}`);

  // 3. The till's list shows both — with or without a (wrong) id in the query.
  const list = await j('GET', '/api/reservations');
  assert.strictEqual(list.body.length, 2, 'till list must show both bookings');
  assert.ok(list.body.every(r => r.restaurant_id === 'testvenue'), 'every booking must be filed under the server\'s own id');
  const listWrong = await j('GET', '/api/reservations?restaurant_id=siamepos');
  assert.strictEqual(listWrong.body.length, 2, 'a wrong ?restaurant_id must not hide or split the list');

  // 4. Availability uses the venue's own settings whatever the widget sends.
  const a1 = await j('GET', `/api/reservations/availability?date=${day}&covers=2&restaurant_id=siamepos`);
  const a2 = await j('GET', `/api/reservations/availability?date=${day}&covers=2`);
  assert.deepStrictEqual(a1.body, a2.body, 'availability must not depend on the widget\'s restaurant_id');

  console.log('SEPOS-BOOK-TENANT-001: all booking paths file under the server\'s own id ✓');
})().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(log.split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
}).finally(() => {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
