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

-- SEPOS-WEB-001 onwards: a place to keep long-form engineering specs +
-- product roadmap items so they're not buried in chat history.
-- body is markdown; rendered on the frontend with marked + DOMPurify.
CREATE TABLE IF NOT EXISTS engineering_tickets (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,     -- e.g. "SEPOS-WEB-001"
  title           TEXT NOT NULL,
  status          TEXT DEFAULT 'open',      -- open / in_progress / shipped / parked
  priority        TEXT DEFAULT 'normal',    -- low / normal / high / critical
  author          TEXT,                     -- e.g. "Sandy + Korakot"
  body_markdown   TEXT NOT NULL,            -- full ticket content (markdown)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON engineering_tickets (status, updated_at DESC);

-- SEPOS-WEB-001 — Website Builder. One config per client (FK), plus a
-- "global" row with NULL client_id for SiamEPOS's own marketing demo.
-- Photos are stored as base64 data URIs in TEXT columns so the generated
-- HTML can be a single self-contained file (no CDN dependency).
CREATE TABLE IF NOT EXISTS website_configs (
  id               SERIAL PRIMARY KEY,
  client_id        INT UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  is_global        BOOLEAN DEFAULT FALSE,
  restaurant_name  TEXT,
  tagline          TEXT,
  address          TEXT,
  phone            TEXT,
  email            TEXT,
  about_text       TEXT,
  primary_colour   VARCHAR(7) DEFAULT '#7B1C2D',
  accent_colour    VARCHAR(7) DEFAULT '#C49030',
  photo_hero       TEXT,
  photo_story      TEXT,
  photo_gallery_1  TEXT,
  photo_gallery_2  TEXT,
  photo_gallery_3  TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
-- Only one global config row at a time (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_website_one_global
  ON website_configs (is_global) WHERE is_global = TRUE;
