// SEPOS-ANDROID-002 — on-device offline cache (Path B, Phase 1).
//
// Additive + safe: the app always tries the cloud first. Every successful GET is
// cached here; when the network is down, reads fall back to the last cached copy
// so the till still opens and shows the floor / menu / staff with no internet.
// Native-only — on web/desktop these are no-ops and the cloud path is unchanged.
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { isNativeApp } from './printer';

let _db = null;
let _initPromise = null;

async function getDb() {
  if (!isNativeApp()) return null;
  if (_db) return _db;
  if (!_initPromise) {
    _initPromise = (async () => {
      const sqlite = new SQLiteConnection(CapacitorSQLite);
      const conn = await sqlite.createConnection('siampos', false, 'no-encryption', 1, false);
      await conn.open();
      await conn.execute(
        'CREATE TABLE IF NOT EXISTS api_cache (url TEXT PRIMARY KEY, json TEXT, ts INTEGER);'
      );
      // Offline PIN login — keyed by a HASH of the PIN (never the raw PIN),
      // value is the last successful online login result for that PIN.
      await conn.execute(
        'CREATE TABLE IF NOT EXISTS staff_auth (pin_hash TEXT PRIMARY KEY, staff_json TEXT, ts INTEGER);'
      );
      // Orders created/edited offline, stored as JSON docs. id is a temp 'L…'
      // string. synced=0 until replayed to the cloud.
      await conn.execute(
        'CREATE TABLE IF NOT EXISTS local_orders (id TEXT PRIMARY KEY, data TEXT, ts INTEGER, synced INTEGER DEFAULT 0);'
      );
      _db = conn;
      return conn;
    })().catch((e) => { _initPromise = null; throw e; });
  }
  return _initPromise;
}

// Store a GET response (best-effort, fire-and-forget — never blocks a read).
export async function cachePut(url, value) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.run('INSERT OR REPLACE INTO api_cache (url, json, ts) VALUES (?,?,?)', [
      url, JSON.stringify(value), Date.now(),
    ]);
  } catch { /* cache is best-effort */ }
}

// Return the last cached response for a URL, or undefined if none.
export async function cacheGet(url) {
  try {
    const db = await getDb();
    if (!db) return undefined;
    const res = await db.query('SELECT json FROM api_cache WHERE url = ?', [url]);
    const row = res?.values?.[0];
    return row ? JSON.parse(row.json) : undefined;
  } catch { return undefined; }
}

// Store a successful online login so the same PIN works offline (hashed key).
export async function cacheLogin(pinHash, staff) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.run('INSERT OR REPLACE INTO staff_auth (pin_hash, staff_json, ts) VALUES (?,?,?)', [
      pinHash, JSON.stringify(staff), Date.now(),
    ]);
  } catch { /* best-effort */ }
}

// Look up a cached login by PIN hash (for offline login). undefined if none.
export async function lookupLogin(pinHash) {
  try {
    const db = await getDb();
    if (!db) return undefined;
    const res = await db.query('SELECT staff_json FROM staff_auth WHERE pin_hash = ?', [pinHash]);
    const row = res?.values?.[0];
    return row ? JSON.parse(row.staff_json) : undefined;
  } catch { return undefined; }
}

// ── Offline orders (JSON docs) ────────────────────────────────────────
export async function localOrderCreate(doc) {
  const db = await getDb(); if (!db) return null;
  await db.run('INSERT OR REPLACE INTO local_orders (id, data, ts, synced) VALUES (?,?,?,0)', [
    doc.id, JSON.stringify(doc), Date.now(),
  ]);
  return doc.id;
}
export async function localOrderGet(id) {
  try {
    const db = await getDb(); if (!db) return undefined;
    const res = await db.query('SELECT data FROM local_orders WHERE id = ?', [id]);
    const row = res?.values?.[0];
    return row ? JSON.parse(row.data) : undefined;
  } catch { return undefined; }
}
export async function localOrderUpdate(id, doc) {
  const db = await getDb(); if (!db) return;
  await db.run('UPDATE local_orders SET data = ?, ts = ? WHERE id = ?', [JSON.stringify(doc), Date.now(), id]);
}
// Patch a single item inside whichever open local order contains it (by local
// item id 'LI…'). Recomputes the order total. Returns true if the item was found.
export async function localItemPatch(itemId, patch) {
  try {
    const db = await getDb(); if (!db) return false;
    const res = await db.query('SELECT id, data FROM local_orders WHERE synced = 0', []);
    for (const row of (res?.values || [])) {
      const doc = JSON.parse(row.data);
      const it = (doc.items || []).find(x => x.id === itemId);
      if (!it) continue;
      Object.assign(it, patch);
      doc.total = (doc.items || []).filter(x => !x.voided)
        .reduce((s, x) => s + (Number(x.unit_price) || 0) * (Number(x.quantity) || 1), 0);
      await db.run('UPDATE local_orders SET data = ?, ts = ? WHERE id = ?', [JSON.stringify(doc), Date.now(), row.id]);
      return true;
    }
    return false;
  } catch { return false; }
}

// Open, not-yet-synced local orders (for floor merge + sync).
export async function localOrderListOpen() {
  try {
    const db = await getDb(); if (!db) return [];
    const res = await db.query('SELECT data FROM local_orders WHERE synced = 0', []);
    return (res?.values || []).map(r => JSON.parse(r.data)).filter(o => o && o.status === 'open');
  } catch { return []; }
}
// ALL not-yet-synced local orders (open AND closed) — for the replay engine.
export async function localOrderListUnsynced() {
  try {
    const db = await getDb(); if (!db) return [];
    const res = await db.query('SELECT data FROM local_orders WHERE synced = 0', []);
    return (res?.values || []).map(r => JSON.parse(r.data)).filter(Boolean);
  } catch { return []; }
}
// Mark a local order as synced to the cloud (records the real cloud id).
export async function localOrderMarkSynced(id, cloudId) {
  try {
    const db = await getDb(); if (!db) return;
    const doc = await localOrderGet(id);
    if (doc) { doc.synced = 1; doc.cloud_id = cloudId; await db.run('UPDATE local_orders SET data = ?, synced = 1, ts = ? WHERE id = ?', [JSON.stringify(doc), Date.now(), id]); }
    else { await db.run('UPDATE local_orders SET synced = 1 WHERE id = ?', [id]); }
  } catch { /* best-effort; retried next tick */ }
}
