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
  -- SEPOS-WEB-002 — flexible bag for setup credentials + extra details:
  -- VAT number, companies house, address, hours, payment processor IDs,
  -- domain/hosting info, API keys, internal onboarding notes, etc.
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent migrations for existing installs.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
-- BO-SPA-001 — multi-product support: 'restaurant' | 'spa'
ALTER TABLE clients ADD COLUMN IF NOT EXISTS product TEXT DEFAULT 'restaurant';
-- BO-ONBOARD-001 — human-readable account reference (SE-0001, SE-0002…)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_ref TEXT UNIQUE;
-- BO-SLUG-001 — short unique slug for subdomain + Railway service name
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slug VARCHAR(20) UNIQUE;
-- BO-FOUNDER-002 — Stripe linkage so we can find/cancel a client's
-- subscription and the webhook can flip status on payment failure/cancel.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer     ON clients (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_clients_stripe_subscription ON clients (stripe_subscription_id);
-- SIAMPAY-002 Phase B — Connect Express account for clients on SiamPay rails
ALTER TABLE clients ADD COLUMN IF NOT EXISTS siampay_account TEXT;
-- Backfill existing rows using a slugified version of restaurant_name
UPDATE clients SET slug = LOWER(REGEXP_REPLACE(
  SUBSTRING(TRIM(restaurant_name) FROM 1 FOR 20), '[^a-z0-9]+', '-', 'g'))
WHERE slug IS NULL;

-- Trigger: auto-set account_ref = SE-XXXX after every INSERT if not already set.
CREATE OR REPLACE FUNCTION set_account_ref() RETURNS TRIGGER AS $$
BEGIN
  UPDATE clients SET account_ref = 'SE-' || LPAD(NEW.id::text, 4, '0')
  WHERE id = NEW.id AND account_ref IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_clients_account_ref ON clients;
CREATE TRIGGER tr_clients_account_ref
  AFTER INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION set_account_ref();

-- Backfill any existing rows that don't have a ref yet.
UPDATE clients SET account_ref = 'SE-' || LPAD(id::text, 4, '0') WHERE account_ref IS NULL;

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

-- SEPOS-PRO-009 — desktop till telemetry. The health-check cron reads the
-- tenant's /api/health `tills:[…]` and upserts one row per device here, so the
-- dashboard can show which tills exist, their app version + last-seen. One row
-- per (client, device); stale rows pruned after 30 days of silence.
CREATE TABLE IF NOT EXISTS client_tills (
  id          SERIAL PRIMARY KEY,
  client_id   INT REFERENCES clients(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  app_version TEXT,
  platform    TEXT,
  last_seen   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_client_tills_client ON client_tills (client_id);

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

-- SEPOS-WEB-002 — toggleable sections (story / hours / press / catering)
-- with their content. The generator renders each only if `*_enabled` is
-- true, so restaurants can ship a one-pager OR a richer multi-section
-- site from the same builder.
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS sections JSONB DEFAULT '{}'::jsonb;

-- SEPOS-WEB-003 — design layer:
--  - template: which CSS layout the generator uses (classic / modern /
--    editorial / boutique). Defaults to classic.
--  - logo_url: optional base64 (or external URL) for the nav wordmark.
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS template TEXT DEFAULT 'classic';
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- SEPOS-WEB-005 — gallery slots 4-6. The builder UI and the generator
-- already supported six gallery photos; only the first three had columns,
-- so slots 4-6 were silently dropped on save.
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_4 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_5 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_6 TEXT;

-- SEPOS-WEB-006 — dedicated gallery page: 12 slots total. Captions live
-- in sections.photo_captions (JSONB), keyed by the photo column name.
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_7 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_8 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_9 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_10 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_11 TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS photo_gallery_12 TEXT;

-- SEPOS-WEB-007 — one-click publish to Netlify + publish history.
-- netlify_site_id ties the client's WEBSITE to its Netlify site (separate
-- from the EPOS app site provisioned by SEPOS-029). published_at vs
-- updated_at tells the UI whether the draft has unpublished changes.
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS netlify_site_id TEXT;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE website_configs ADD COLUMN IF NOT EXISTS published_by TEXT;

-- Every publish stores a full config snapshot — audit trail + restore.
CREATE TABLE IF NOT EXISTS website_publishes (
  id                SERIAL PRIMARY KEY,
  client_id         INT REFERENCES clients(id) ON DELETE CASCADE,
  published_by      TEXT,
  published_at      TIMESTAMPTZ DEFAULT NOW(),
  netlify_site_id   TEXT,
  netlify_deploy_id TEXT,
  url               TEXT,
  config_snapshot   JSONB
);
CREATE INDEX IF NOT EXISTS idx_website_publishes_client
  ON website_publishes (client_id, published_at DESC);

-- SEPOS-042 — Finance / Starling Bank integration. Stores API tokens for
-- the Starling Personal Access Token and Anthropic API key server-side so
-- they are never exposed to the browser. One singleton row (id=1).
CREATE TABLE IF NOT EXISTS finance_settings (
  id               SERIAL PRIMARY KEY,
  starling_token   TEXT,
  anthropic_key    TEXT,
  updated_at       TIMESTAMPTZ DEFAULT now()
);
-- Ensure exactly one row exists.
INSERT INTO finance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- SEPOS-FINANCE-002 — Invoice attachments. One file per Starling transaction
-- (identified by feedItemUid). File stored as base64 text so no external
-- storage service is needed. Typical receipt PDFs are 50–500 KB; fine in PG.
CREATE TABLE IF NOT EXISTS transaction_attachments (
  id               SERIAL PRIMARY KEY,
  transaction_id   TEXT NOT NULL UNIQUE,   -- Starling feedItemUid
  filename         TEXT NOT NULL,
  mimetype         TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_data        TEXT NOT NULL,           -- base64-encoded file content
  file_size        INT,                     -- bytes (original, pre-encoding)
  uploaded_by      TEXT,                   -- team user email
  uploaded_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_attach_txid ON transaction_attachments (transaction_id);

-- SEPOS-AI-HELP-001 — questions clients ask the in-app "Ask AI" assistant,
-- forwarded from each tenant cloud (authed by matching the tenant's
-- x-sync-secret to a client's stored sync_secret → client_id). Gold data on
-- what clients struggle with; feeds the assistant's knowledge base back.
CREATE TABLE IF NOT EXISTS ai_help_logs (
  id               SERIAL PRIMARY KEY,
  client_id        INT REFERENCES clients(id) ON DELETE SET NULL,
  restaurant_name  TEXT,                    -- denormalised label (survives client delete)
  question         TEXT NOT NULL,
  reply            TEXT,
  platform         TEXT,                    -- Mac / Windows / iPad / Sunmi / web
  staff_role       TEXT,
  escalated        BOOLEAN DEFAULT FALSE,   -- reply told them to contact support
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_help_logs_client ON ai_help_logs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_help_logs_time   ON ai_help_logs (created_at DESC);
