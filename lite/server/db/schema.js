// Idempotent schema bootstrap for the Lite server.
// Assumes Phase 1 (Krit) has already created the `restaurants` table and
// added restaurant_id to all tenant tables. We only create what Pose owns:
// lite_users — login credentials for Lite dashboard customers.
const pool = require('./pool');

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lite_users (
      id            SERIAL PRIMARY KEY,
      restaurant_id TEXT        NOT NULL REFERENCES restaurants(restaurant_id) ON DELETE CASCADE,
      email         TEXT        NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      name          TEXT        NOT NULL DEFAULT '',
      role          TEXT        NOT NULL DEFAULT 'owner',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS lite_users_restaurant ON lite_users(restaurant_id);

    -- Ensure restaurants table has all the fields we write to
    -- (safe no-ops if Phase 1 already created them)
    ALTER TABLE restaurants
      ADD COLUMN IF NOT EXISTS email         TEXT,
      ADD COLUMN IF NOT EXISTS phone         TEXT,
      ADD COLUMN IF NOT EXISTS address       TEXT,
      ADD COLUMN IF NOT EXISTS logo_url      TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('[lite-db] migrations OK');
}

module.exports = { runMigrations };
