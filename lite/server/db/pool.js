// Shared Lite Postgres pool.
// Connects to the same DATABASE_URL as the EPOS backend (same Railway Postgres
// instance with the restaurants + restaurant_id-scoped tables Krit created in
// Phase 1). In production this is the shared MULTI_TENANT Lite Railway Postgres.
const { Pool } = require('pg');

// Use LITE_DATABASE_URL if set (avoids Railway auto-overriding DATABASE_URL
// with the internal postgres.railway.internal hostname when the Lite server
// is in a different Railway project from the shared Postgres).
const connStr = process.env.LITE_DATABASE_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connStr,
  ssl: connStr && !connStr.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('[lite-db] idle client error', err.message);
});

module.exports = pool;
