// SEPOS-ANDROID-002 spike — prove on-device SQLite works on the Sunmi.
// Opens a local DB, inserts a row, returns the running count. The count rising
// on each launch proves the data PERSISTS locally (the basis for offline mode).
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { isNativeApp } from './printer';

export async function runSqliteSpike() {
  if (!isNativeApp()) return 'skipped (web/desktop)';
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const name = 'siampos_spike';
  const db = await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(
    'CREATE TABLE IF NOT EXISTS spike (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, ts TEXT);'
  );
  await db.run('INSERT INTO spike (v, ts) VALUES (?, ?);', ['offline-test', new Date().toISOString()]);
  const res = await db.query('SELECT COUNT(*) AS n FROM spike;');
  const n = res?.values?.[0]?.n;
  await sqlite.closeConnection(name, false);
  return `SQLite OK — local rows now: ${n}`;
}
