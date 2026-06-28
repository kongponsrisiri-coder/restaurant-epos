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
