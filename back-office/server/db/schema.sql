-- SEPOS-041 SiamEPOS Back Office — initial schema.
-- Idempotent: every CREATE TABLE / INDEX uses IF NOT EXISTS so this file
-- can be re-run on every server boot without dropping data.

CREATE TABLE IF NOT EXISTS clients (
  id              SERIAL PRIMARY KEY,
  restaurant_name TEXT NOT NULL,
  owner_name      TEXT,
  email           TEXT,
  phone           TEXT,
  railway_url     TEXT,
  plan            TEXT DEFAULT 'trial',
  status          TEXT DEFAULT 'setup',
  monthly_fee     NUMERIC(10,2),
  trial_start     DATE,
  sub_start       DATE,
  next_billing    DATE,
  notes_count     INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_checks (
  id              SERIAL PRIMARY KEY,
  client_id       INT REFERENCES clients(id) ON DELETE CASCADE,
  checked_at      TIMESTAMPTZ DEFAULT NOW(),
  is_online       BOOLEAN,
  response_ms     INT,
  orders_today    INT,
  last_order_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_health_client_time
  ON health_checks (client_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS support_notes (
  id              SERIAL PRIMARY KEY,
  client_id       INT REFERENCES clients(id) ON DELETE CASCADE,
  created_by      TEXT,
  category        TEXT,
  note            TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_notes_client
  ON support_notes (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT DEFAULT 'support',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
