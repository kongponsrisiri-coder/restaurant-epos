// SEPOS-LOCAL-001 Phase 3 — One-time Railway → SQLite history import.
//
// On first boot after the device-first update lands, paginate ALL closed
// orders from the cloud relay into local SQLite, then generate archive
// PDFs for every month touched. After that the device-first sync cadence
// (Phase 2) takes over — incremental pulls of only NEW closed orders.
//
// Idempotent: gated by `sync_state.device_first_migration_done`. Run once
// then never again on this install. Safe to re-run if flag manually
// cleared (each closed order is upserted by cloud_id).
//
// Progress is published to `sync_state` (key = 'migration_progress') as
// JSON so the React Settings card can poll a status endpoint and show a
// banner. We don't use Socket.io for this because the migration runs
// during early startup before the UI has even connected.

'use strict';

const pool          = require('../db/dbAdapter');
const offlineQueue  = require('./offlineQueue');
const archiveService = require('./archiveService');

const CLOUD_API_URL = process.env.CLOUD_API_URL;
const PAGE_LIMIT    = 500;
const FETCH_TIMEOUT_MS = 20000;

let _running = false;
let _state   = { status: 'idle', total: 0, imported: 0, archived_months: 0, started_at: null, finished_at: null, error: null };

function getState() { return { ..._state, running: _running }; }

async function readFlag(key) {
  try {
    const r = await pool.query('SELECT value FROM sync_state WHERE key = $1', [key]);
    return r.rows[0]?.value || null;
  } catch { return null; }
}

async function writeFlag(key, value) {
  try {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    const exists = await pool.query('SELECT 1 FROM sync_state WHERE key = $1', [key]);
    if (exists.rows[0]) {
      await pool.query('UPDATE sync_state SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = $2', [v, key]);
    } else {
      await pool.query(
        'INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
        [key, v]
      );
    }
  } catch (err) { console.warn('[migration] writeFlag failed:', err.message); }
}

async function publishProgress() {
  await writeFlag('migration_progress', JSON.stringify(_state));
}

// findLocalOrderByCloudId duplicated here (instead of imported from
// syncService) because syncService takes a tick on its own loop and we
// want this migration to be self-contained — easier to unit-test and
// less likely to deadlock with the sync engine running in parallel.
async function findLocalOrderByCloudId(cloudId) {
  const r = await pool.query('SELECT id FROM orders WHERE cloud_id = $1 LIMIT 1', [cloudId]);
  return r.rows[0]?.id;
}

async function insertClosedOrder(order, items, payments) {
  const orderCols = (await pool.query('PRAGMA table_info(orders)')).rows.map(r => r.name);
  const itemCols  = (await pool.query('PRAGMA table_info(order_items)')).rows.map(r => r.name);
  const payCols   = (await pool.query('PRAGMA table_info(payments)')).rows.map(r => r.name);

  const cloudId = order.id;
  if (!cloudId) return false;
  if (await findLocalOrderByCloudId(cloudId)) return false; // already have it

  const pick = (row, cols, extra) => {
    const f = { ...extra };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === 'order_id') continue;
      if (!cols.includes(k)) continue;
      if (v === null || v === undefined) continue;
      f[k] = v;
    }
    return f;
  };

  const f = pick(order, orderCols, { cloud_id: cloudId });
  const cols = Object.keys(f);
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const ins = await pool.query(
    `INSERT INTO orders (${cols.join(',')}) VALUES (${ph}) RETURNING id`,
    cols.map(c => f[c]),
  );
  const localId = ins.rows[0]?.id;
  if (!localId) return false;

  for (const it of (items || [])) {
    const itf = pick(it, itemCols, { order_id: localId });
    if (itemCols.includes('cloud_id') && it.id) itf.cloud_id = it.id;
    const c = Object.keys(itf);
    const p = c.map((_, i) => `$${i + 1}`).join(',');
    try { await pool.query(`INSERT INTO order_items (${c.join(',')}) VALUES (${p})`, c.map(k => itf[k])); }
    catch (err) { console.warn('[migration] item insert failed:', err.message); }
  }

  for (const py of (payments || [])) {
    const pf = pick(py, payCols, { order_id: localId });
    const c = Object.keys(pf);
    const p = c.map((_, i) => `$${i + 1}`).join(',');
    try { await pool.query(`INSERT INTO payments (${c.join(',')}) VALUES (${p})`, c.map(k => pf[k])); }
    catch (err) { console.warn('[migration] payment insert failed:', err.message); }
  }
  return true;
}

async function importAllClosedOrders() {
  if (!CLOUD_API_URL || !process.env.SYNC_SECRET) {
    throw new Error('cloud_api_url or sync_secret missing — cannot import history');
  }

  let since = '1970-01-01';
  const touchedMonths = new Set();
  for (let page = 0; page < 1000; page++) {  // hard cap — generous
    const url = `${CLOUD_API_URL}/api/sync/closed-orders?since=${encodeURIComponent(since)}&limit=${PAGE_LIMIT}`;
    const r = await fetch(url, {
      headers: { 'x-sync-secret': process.env.SYNC_SECRET },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`cloud returned HTTP ${r.status}`);
    const { orders = [], order_items = [], payments = [], max_closed_at, has_more } = await r.json();

    if (orders.length === 0) break;

    const itemsByOrder = {};
    for (const it of order_items) (itemsByOrder[it.order_id] ||= []).push(it);
    const paysByOrder = {};
    for (const py of payments) (paysByOrder[py.order_id] ||= []).push(py);

    for (const o of orders) {
      const inserted = await insertClosedOrder(o, itemsByOrder[o.id], paysByOrder[o.id]);
      if (inserted) {
        _state.imported++;
        if (o.closed_at) touchedMonths.add(String(o.closed_at).slice(0, 7));
      }
    }
    await publishProgress();

    since = max_closed_at;
    if (!has_more) break;
  }
  return touchedMonths;
}

async function generateHistoricalArchives(touchedMonths) {
  // Bills CSV is per-month, Z-report PDF is per-day. For each touched
  // month, archive each day in that month that has at least one closed
  // order. Idempotent — existing PDFs are skipped.
  for (const ym of [...touchedMonths].sort()) {
    // Find distinct close dates in that month
    const r = await pool.query(
      `SELECT DISTINCT closed_at::date AS d FROM orders
       WHERE status = 'closed' AND closed_at::date BETWEEN $1::date AND $2::date
       ORDER BY d ASC`,
      [`${ym}-01`, `${ym}-31`],
    ).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
      const dateStr = (row.d instanceof Date ? row.d.toISOString().slice(0, 10) : String(row.d).slice(0, 10));
      try {
        await archiveService.archiveForDate(pool, dateStr);
        _state.archived_months = touchedMonths.size; // coarse but informative
        await publishProgress();
      } catch (err) {
        console.warn(`[migration] archive ${dateStr} failed:`, err.message);
      }
    }
  }
}

async function runIfNeeded() {
  if (_running) return getState();
  if (!offlineQueue.isLocal) {
    return { skipped: true, reason: 'cloud install — migration is a desktop-only step' };
  }
  const done = await readFlag('device_first_migration_done');
  if (done === 'true' || done === true) {
    _state.status = 'done';
    return { skipped: true, reason: 'already migrated' };
  }

  _running = true;
  _state = { status: 'running', total: 0, imported: 0, archived_months: 0, started_at: new Date().toISOString(), finished_at: null, error: null };
  await publishProgress();
  console.log('[migration] starting first-boot history import…');

  try {
    const months = await importAllClosedOrders();
    console.log(`[migration] imported ${_state.imported} closed orders across ${months.size} months`);
    _state.status = 'archiving';
    await publishProgress();

    await generateHistoricalArchives(months);

    _state.status = 'done';
    _state.finished_at = new Date().toISOString();
    await writeFlag('device_first_migration_done', 'true');
    await publishProgress();
    console.log('[migration] ✓ complete');
  } catch (err) {
    _state.status = 'error';
    _state.error  = err.message;
    _state.finished_at = new Date().toISOString();
    await publishProgress();
    console.error('[migration] ✗ failed:', err.message);
  } finally {
    _running = false;
  }
  return getState();
}

module.exports = {
  runIfNeeded,
  getState,
};
