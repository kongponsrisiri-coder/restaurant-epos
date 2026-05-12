// SEPOS-041 — Postgres pool for the back-office. Separate DATABASE_URL from
// the restaurant EPOS so the two systems can never accidentally see each
// other's data even if someone misconfigures Railway.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[ops-db] unexpected error on idle client', err);
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[ops-db] schema ensured');
}

async function ensureBootstrapAdmin() {
  // Seed an initial admin user from env vars on first boot. Skip if any
  // team_users already exist (idempotent).
  const seedEmail = process.env.OPS_BOOTSTRAP_EMAIL;
  const seedName  = process.env.OPS_BOOTSTRAP_NAME || 'SiamEPOS Admin';
  const seedPass  = process.env.OPS_BOOTSTRAP_PASSWORD;
  if (!seedEmail || !seedPass) return;
  const existing = await pool.query('SELECT id FROM team_users LIMIT 1');
  if (existing.rows.length > 0) return;
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash(seedPass, 10);
  await pool.query(
    'INSERT INTO team_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)',
    [seedName, seedEmail, hash, 'admin']
  );
  console.log(`[ops-db] bootstrap admin created: ${seedEmail}`);
}

module.exports = { pool, ensureSchema, ensureBootstrapAdmin };
