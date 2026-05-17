// Shared Lite Postgres pool.
// Connects to the same DATABASE_URL as the EPOS backend (same Railway Postgres
// instance with the restaurants + restaurant_id-scoped tables Krit created in
// Phase 1). In production this is the shared MULTI_TENANT Lite Railway Postgres.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('[lite-db] idle client error', err.message);
});

module.exports = pool;
