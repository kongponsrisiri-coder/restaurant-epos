// Phase 3 — offline mutation queue. When the server is running in local mode,
// route handlers call enqueue() after the local SQLite write so syncService can
// push them to Railway once internet returns.
//
// In cloud mode every function is a no-op so production deploys are unaffected.

const pool = require('../db/dbAdapter');

const isLocal = (process.env.DB_MODE || 'cloud').toLowerCase() === 'local';

async function enqueue(actionType, payload) {
  if (!isLocal) return null;
  try {
    const r = await pool.query(
      'INSERT INTO sync_queue (action_type, payload) VALUES ($1, $2) RETURNING id',
      [actionType, JSON.stringify(payload)]
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[offlineQueue] enqueue failed:', actionType, err.message);
    return null;
  }
}

async function pending() {
  if (!isLocal) return [];
  const r = await pool.query(
    'SELECT id, action_type, payload, created_at, attempts FROM sync_queue WHERE synced = 0 ORDER BY id ASC'
  );
  return r.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    payload: JSON.parse(row.payload),
    created_at: row.created_at,
    attempts: Number(row.attempts) || 0,
  }));
}

async function pendingCount() {
  if (!isLocal) return 0;
  const r = await pool.query('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0');
  return r.rows[0]?.n || 0;
}

// Quarantined (synced=2) items — a push that will never succeed (already
// closed on cloud, bad data). Surfaced in the sync-queue inspector so a
// failed payment/order is visible, not silently dropped.
async function failed() {
  if (!isLocal) return [];
  const r = await pool.query(
    'SELECT id, action_type, payload, created_at, attempts, last_error, failed_at FROM sync_queue WHERE synced = 2 ORDER BY id ASC'
  );
  return r.rows.map((row) => ({
    id: row.id,
    action_type: row.action_type,
    payload: (() => { try { return JSON.parse(row.payload); } catch { return null; } })(),
    created_at: row.created_at,
    attempts: Number(row.attempts) || 0,
    last_error: row.last_error,
    failed_at: row.failed_at,
  }));
}

async function failedCount() {
  if (!isLocal) return 0;
  const r = await pool.query('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 2');
  return r.rows[0]?.n || 0;
}

async function markSynced(id) {
  if (!isLocal) return;
  await pool.query(
    'UPDATE sync_queue SET synced = 1, synced_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id]
  );
}

// Transient failure (network / 5xx) — leave it pending and bump the attempt
// counter so a server-side error on one item can't retry forever.
async function bumpAttempt(id, error) {
  if (!isLocal) return;
  await pool.query(
    'UPDATE sync_queue SET attempts = COALESCE(attempts,0) + 1, last_error = $2 WHERE id = $1',
    [id, String(error || '').slice(0, 500)]
  );
}

// Permanent failure — quarantine (synced=2) and record why, so the drain
// loop can move past it instead of blocking every action behind it.
async function markFailed(id, error) {
  if (!isLocal) return;
  await pool.query(
    `UPDATE sync_queue
        SET synced = 2, failed_at = CURRENT_TIMESTAMP,
            attempts = COALESCE(attempts,0) + 1, last_error = $2
      WHERE id = $1`,
    [id, String(error || '').slice(0, 500)]
  );
}

module.exports = {
  enqueue, pending, pendingCount, failed, failedCount,
  markSynced, bumpAttempt, markFailed, isLocal,
};
