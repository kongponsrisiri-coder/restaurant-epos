// Phase 3 — offline mutation queue. When the server is running in local mode,
// route handlers call enqueue() after the local SQLite write so syncService can
// push them to Railway once internet returns.
//
// In cloud mode every function is a no-op so production deploys are unaffected.

const pool = require('../db/dbAdapter');

const isLocal = (process.env.DB_MODE || 'cloud').toLowerCase() === 'local';

async function enqueue(actionType, payload) {
  if (!isLocal) return;
  try {
    await pool.query(
      'INSERT INTO sync_queue (action_type, payload) VALUES ($1, $2)',
      [actionType, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('[offlineQueue] enqueue failed:', actionType, err.message);
  }
}

async function pending() {
  if (!isLocal) return [];
  const r = await pool.query(
    'SELECT id, action_type, payload, created_at FROM sync_queue WHERE synced = 0 ORDER BY id ASC'
  );
  return r.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    payload: JSON.parse(row.payload),
    created_at: row.created_at,
  }));
}

async function pendingCount() {
  if (!isLocal) return 0;
  const r = await pool.query('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0');
  return r.rows[0]?.n || 0;
}

async function markSynced(id) {
  if (!isLocal) return;
  await pool.query(
    'UPDATE sync_queue SET synced = 1, synced_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id]
  );
}

module.exports = { enqueue, pending, pendingCount, markSynced, isLocal };
