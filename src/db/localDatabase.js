// SQLite backend for SiamEPOS Pro local/offline mode.
// Mirrors the pg.Pool interface (query, connect) so src/server.js stays unchanged.
//
// Translation handled:
//   $1, $2 ...                  → ?
//   NOW()                       → CURRENT_TIMESTAMP
//   col::date  /  $N::date      → date(col)  /  date(?)
//   col::timestamp / $N::ts     → datetime(col) / datetime(?)
//   = ANY($N::int[])            → IN (?,?,...) with the array flattened into params
//   GREATEST(a, b, ...)         → max(a, b, ...)   — SQLite's scalar max
//   LEAST(a, b, ...)            → min(a, b, ...)   — SQLite's scalar min
//
// Known unsupported by the schema below (intentionally — SQLite limitations):
//   ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL  — caller-side .catch() in server.js
//   protects us. All columns that need to be nullable are declared that way at CREATE time.

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), 'restaurant-local.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('[db:local] SQLite at', dbPath, '— version', db.prepare('SELECT sqlite_version() AS v').get().v);

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER,
      name TEXT,
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'available',
      pos_x INTEGER DEFAULT 0,
      pos_y INTEGER DEFAULT 0,
      shape TEXT DEFAULT 'square',
      width INTEGER DEFAULT 80,
      height INTEGER DEFAULT 80,
      is_takeaway INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_bar INTEGER DEFAULT 0,
      default_course INTEGER DEFAULT 1,
      printer_id INTEGER
    );
    -- SEPOS-STATION-001 — flexible multi-printer routing (category -> printer).
    CREATE TABLE IF NOT EXISTS printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT,
      port INTEGER DEFAULT 9100,
      mac TEXT,
      kind TEXT DEFAULT 'kitchen',
      copies INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      restaurant_id TEXT DEFAULT 'siamepos',
      role_receipt INTEGER DEFAULT 0,
      role_kitchen INTEGER DEFAULT 0,
      role_bar INTEGER DEFAULT 0,
      lpr_queue TEXT
    );

    CREATE TABLE IF NOT EXISTS subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      name_alt TEXT,
      description TEXT,
      price REAL NOT NULL,
      is_available INTEGER DEFAULT 1,
      is_online INTEGER DEFAULT 1,
      allergens TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      vat_rate REAL DEFAULT 20.0,
      default_course INTEGER
    );

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      required INTEGER DEFAULT 0,
      multi_select INTEGER DEFAULT 0,
      is_global INTEGER DEFAULT 0,
      is_allergen INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS modifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      extra_price REAL DEFAULT 0,
      is_available INTEGER DEFAULT 1
    );

    -- SEPOS-059 — shared modifier library link (see database.js for rationale)
    CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      UNIQUE (menu_item_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
      staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'open',
      covers INTEGER DEFAULT 1,
      total REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      no_service_charge INTEGER DEFAULT 0,
      service_charge REAL,
      bill_printed INTEGER DEFAULT 0,
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      order_type TEXT DEFAULT 'dine_in',
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      pickup_time TIMESTAMP,
      takeaway_status TEXT,
      payment_status TEXT,
      payment_intent_id TEXT,
      reservation_id INTEGER,
      cloud_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER,
      item_name TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price REAL,
      notes TEXT,
      course INTEGER DEFAULT 1,
      item_note TEXT,
      status TEXT DEFAULT 'pending',
      is_fired INTEGER DEFAULT 0,
      fired_at TIMESTAMP,
      cooking_started_at TIMESTAMP,
      served_at TIMESTAMP,
      voided INTEGER DEFAULT 0,
      voided_at TIMESTAMP,
      void_reason TEXT,
      void_type TEXT,
      discount_type TEXT,
      discount_value REAL,
      resend_reason TEXT,
      dest_category_id INTEGER,
      cloud_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS order_item_modifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
      modifier_id INTEGER,
      name TEXT,
      extra_price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'waiter',
      is_active INTEGER DEFAULT 1,
      start_date TEXT,
      notes TEXT,
      employment_status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      amount REAL,
      method TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS-042: audit log for manager-authorised order deletions.
    -- Mirrors the cloud schema (src/db/database.js). SQLite is loose
    -- with column types so NUMERIC/REAL etc. are equivalent here.
    CREATE TABLE IF NOT EXISTS order_deletions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL,
      staff_id        INTEGER,
      staff_name      TEXT,
      reason          TEXT,
      deleted_total   REAL,
      order_type      TEXT,
      opened_at       TIMESTAMP,
      closed_at       TIMESTAMP,
      deleted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS-022: staff clock-in / clock-out events
    CREATE TABLE IF NOT EXISTS clock_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_clock_events_staff_at ON clock_events(staff_id, event_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS discount_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    -- SEPOS-KITCHEN-MSG-001 — pre-canned messages waiters one-tap to send
    -- to the kitchen (allergies, holds, VIP, birthday). Mirrors PG schema.
    -- SEPOS-PAY-AMEND-001 — mirrors PG schema.
    CREATE TABLE IF NOT EXISTS payment_amendments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id    INTEGER NOT NULL,
      order_id      INTEGER NOT NULL,
      from_method   TEXT NOT NULL,
      to_method     TEXT NOT NULL,
      reason        TEXT,
      amended_by    INTEGER,
      amended_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );

    CREATE TABLE IF NOT EXISTS kitchen_message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      message     TEXT NOT NULL,
      icon        TEXT,
      sort_order  INTEGER DEFAULT 100,
      is_active   INTEGER DEFAULT 1,
      restaurant_id TEXT DEFAULT 'siamepos'
    );

    CREATE TABLE IF NOT EXISTS z_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      opened_at TIMESTAMP,
      closed_at TIMESTAMP,
      total_sales REAL,
      total_cash REAL,
      total_card REAL,
      total_other REAL,
      total_covers INTEGER,
      total_orders INTEGER,
      discounts REAL,
      voids REAL,
      float_amount REAL,
      petty_cash REAL,
      petty_cash_reason TEXT,
      actual_cash REAL,
      cash_difference REAL,
      actual_card REAL,
      card_difference REAL,
      report_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS till_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'open',
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      opened_by INTEGER,
      closed_at TIMESTAMP,
      closed_by INTEGER,
      float_amount REAL DEFAULT 0,
      z_report_id INTEGER,
      cloud_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'siamepos',
      table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      customer_email TEXT,
      covers INTEGER NOT NULL DEFAULT 2,
      reservation_date TEXT NOT NULL,
      reservation_time TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      source TEXT DEFAULT 'epos',
      marketing_consent INTEGER DEFAULT 0,
      unsubscribed_at TIMESTAMP,
      table_ids TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reservation_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
      type TEXT,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS restaurant_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT UNIQUE NOT NULL DEFAULT 'siamepos',
      restaurant_name TEXT DEFAULT 'My Restaurant',
      brand_colour TEXT DEFAULT '#1a472a',
      opening_time TEXT DEFAULT '11:00',
      last_booking_time TEXT DEFAULT '21:30',
      slot_interval_mins INTEGER DEFAULT 15,
      max_covers_per_slot INTEGER DEFAULT 20,
      booking_lead_hours INTEGER DEFAULT 1,
      booking_advance_days INTEGER DEFAULT 60,
      is_active INTEGER DEFAULT 1,
      service_type TEXT DEFAULT 'all_day',
      lunch_service_start TEXT DEFAULT '11:00',
      lunch_service_end TEXT DEFAULT '14:30',
      dinner_service_start TEXT DEFAULT '17:30',
      dinner_service_end TEXT DEFAULT '21:30',
      max_party_size INTEGER DEFAULT 8,
      restaurant_phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS table_combinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'siamepos',
      table_id_a INTEGER REFERENCES tables(id) ON DELETE CASCADE,
      table_id_b INTEGER REFERENCES tables(id) ON DELETE CASCADE,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS table_walls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'siamepos',
      pos_x INTEGER DEFAULT 0,
      pos_y INTEGER DEFAULT 0,
      width INTEGER DEFAULT 8,
      height INTEGER DEFAULT 80,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dining_duration_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT DEFAULT 'siamepos',
      covers_min INTEGER NOT NULL,
      covers_max INTEGER,
      duration_mins INTEGER NOT NULL DEFAULT 90
    );

    CREATE UNIQUE INDEX IF NOT EXISTS dining_tiers_unique
      ON dining_duration_tiers(restaurant_id, covers_min);

    -- SEPOS-033 Phase 2 — campaign audit log
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      body TEXT,
      segment TEXT,
      recipient_count INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS-033 Phase 3 — Make.com webhook fire audit (dedupe)
    CREATE TABLE IF NOT EXISTS webhook_fires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      entity_key TEXT,
      fired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_fires_event_entity ON webhook_fires(event_type, entity_key);

    -- SEPOS-LITE-001 Phase 1 — multi-tenancy registry (mirrors cloud schema)
    CREATE TABLE IF NOT EXISTS restaurants (
      restaurant_id TEXT PRIMARY KEY,
      name TEXT,
      plan TEXT DEFAULT 'pro',
      api_key TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      payment_failed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS — sync engine state (e.g. cursor for closed-orders pull)
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- SEPOS-PRO-009 — device telemetry (mirrors PG; inert locally since tills
    -- POST their heartbeat to the CLOUD, not the local server).
    CREATE TABLE IF NOT EXISTS devices (
      device_id     TEXT PRIMARY KEY,
      restaurant_id TEXT,
      app_version   TEXT,
      platform      TEXT,
      last_seen     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Offline action queue (Phase 3 consumer)
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT,
      payload TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced INTEGER DEFAULT 0,          -- 0 = pending, 1 = done, 2 = failed/quarantined
      synced_at TIMESTAMP,
      attempts INTEGER DEFAULT 0,        -- push attempts so a poison item can't retry forever
      last_error TEXT,                   -- last push error (for the sync-queue inspector)
      failed_at TIMESTAMP                -- when it was quarantined
    );

    -- SEPOS-VOUCHER-001 — gift vouchers
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      original_amount REAL NOT NULL,
      balance REAL NOT NULL,
      recipient_name TEXT,
      recipient_email TEXT,
      sender_name TEXT,
      message TEXT,
      delivery_date TEXT,
      expires_at TEXT NOT NULL,
      payment_method TEXT DEFAULT 'stripe',
      stripe_payment_intent_id TEXT,
      status TEXT DEFAULT 'active',
      email_sent_at TIMESTAMP,
      voided_by TEXT,
      voided_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos',
      type TEXT DEFAULT 'gift',
      reservation_id INTEGER,
      take_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vouchers_code        ON vouchers (code);
    CREATE INDEX IF NOT EXISTS idx_vouchers_restaurant  ON vouchers (restaurant_id);

    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      bill_id INTEGER,
      amount_used REAL NOT NULL,
      redeemed_by INTEGER,
      used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher ON voucher_redemptions (voucher_id);

    -- ── SEPOS-046k — Inventory + Batch Prep schema (SQLite parity) ──
    -- These 8 tables exist in Postgres (src/db/database.js) but were
    -- absent from the offline SQLite layer until v1.6.39. Without them
    -- every Inventory and Batch-Prep endpoint on a DB_MODE=local install
    -- threw "no such table". Schema validated by Nook's mock test before
    -- being landed here.
    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_en TEXT NOT NULL,
      name_th TEXT DEFAULT '',
      unit TEXT DEFAULT 'kg',
      cost_per_unit REAL DEFAULT 0,
      yield_percentage REAL DEFAULT 100,
      category TEXT DEFAULT 'Other',
      current_stock REAL DEFAULT 0,
      par_level REAL,
      supplier_name TEXT DEFAULT '',
      allergens TEXT DEFAULT '[]',
      is_batch INTEGER DEFAULT 0,
      batch_recipe_id INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients (category);

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_at_time REAL DEFAULT 0,
      note TEXT,
      reference TEXT,
      order_item_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient ON stock_movements (ingredient_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item ON stock_movements (order_item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_created    ON stock_movements (created_at DESC);

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      serves INTEGER DEFAULT 1,
      total_cost REAL DEFAULT 0,
      cost_per_portion REAL DEFAULT 0,
      last_calculated TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_menu_item ON recipes (menu_item_id);

    CREATE TABLE IF NOT EXISTS recipe_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_id INTEGER NOT NULL,
      quantity_used REAL NOT NULL,
      unit TEXT,
      line_cost REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_lines_recipe ON recipe_lines (recipe_id);

    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT,
      invoice_date TEXT,
      invoice_number TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'processed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_date ON supplier_invoices (invoice_date DESC);

    -- SEPOS-046ac — expenses (Cost & Sales tab); was never codified, see
    -- the matching CREATE in database.js for the history.
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT 'other',
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date DESC);

    CREATE TABLE IF NOT EXISTS concierge_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_concierge_session ON concierge_messages (profile, session_id, id);

    CREATE TABLE IF NOT EXISTS concierge_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL,
      session_id TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      treatment TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      deposit_gbp REAL DEFAULT 0,
      status TEXT DEFAULT 'paid_demo',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_concierge_bookings ON concierge_bookings (profile, start_at);

    CREATE TABLE IF NOT EXISTS batch_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      output_quantity REAL NOT NULL,
      output_unit TEXT NOT NULL,
      shelf_life_days INTEGER NOT NULL DEFAULT 3,
      total_cost REAL DEFAULT 0,
      cost_per_unit REAL DEFAULT 0,
      notes TEXT,
      last_calculated TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );

    CREATE TABLE IF NOT EXISTS batch_recipe_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_recipe_id INTEGER NOT NULL REFERENCES batch_recipes(id) ON DELETE CASCADE,
      ingredient_id INTEGER NOT NULL,
      quantity_used REAL NOT NULL,
      unit TEXT,
      line_cost REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_batch_recipe_lines_recipe ON batch_recipe_lines (batch_recipe_id);

    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_recipe_id INTEGER REFERENCES batch_recipes(id) ON DELETE SET NULL,
      ingredient_id INTEGER NOT NULL,
      made_on TEXT NOT NULL DEFAULT CURRENT_DATE,
      expires_on TEXT NOT NULL,
      original_quantity REAL NOT NULL,
      locked_cost_per_unit REAL NOT NULL,
      status TEXT DEFAULT 'active',
      made_by INTEGER,
      notes TEXT,
      discarded_qty REAL,
      discarded_at TEXT,
      discarded_by INTEGER,
      extended_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      restaurant_id TEXT DEFAULT 'siamepos'
    );
    CREATE INDEX IF NOT EXISTS idx_batches_recipe     ON batches (batch_recipe_id);
    CREATE INDEX IF NOT EXISTS idx_batches_ingredient ON batches (ingredient_id);
    CREATE INDEX IF NOT EXISTS idx_batches_status_exp ON batches (status, expires_on);
  `);
}

// SQLite's ADD COLUMN doesn't support IF NOT EXISTS, so we check first.
// Used to bring already-deployed local DBs up to the latest schema.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db:local] added column ${table}.${column}`);
  } catch (err) {
    console.warn(`[db:local] could not add ${table}.${column}:`, err.message);
  }
}

function runMigrations() {
  // SEPOS-SYNC-HEAL-001: self-healing sync queue — a poison action must not
  // block the whole queue. attempts caps retries; last_error/failed_at back
  // the quarantine surfaced in the sync-queue inspector.
  addColumnIfMissing('sync_queue', 'attempts',   'INTEGER DEFAULT 0');
  addColumnIfMissing('sync_queue', 'last_error', 'TEXT');
  addColumnIfMissing('sync_queue', 'failed_at',  'TIMESTAMP');
  // SEPOS-024: resend reason on order_items
  addColumnIfMissing('order_items', 'resend_reason', 'TEXT');
  // Card reconciliation on the Z report (actual card-machine takings + variance)
  addColumnIfMissing('z_reports', 'actual_card',     'REAL');
  addColumnIfMissing('z_reports', 'card_difference', 'REAL');
  // Per-item course override (NULL = inherit the category default_course)
  addColumnIfMissing('menu_items', 'default_course', 'INTEGER');
  // SEPOS-PAY-AMEND-001: audit columns on the payments row
  addColumnIfMissing('payments', 'amended_at',     'TIMESTAMP');
  addColumnIfMissing('payments', 'amended_by',     'INTEGER');
  addColumnIfMissing('payments', 'amend_reason',   'TEXT');
  addColumnIfMissing('payments', 'amended_from',   'TEXT');
  // SEPOS-023: void type on order_items
  addColumnIfMissing('order_items', 'void_type', 'TEXT');
  // SEPOS-030: staff attribution on orders
  addColumnIfMissing('orders', 'staff_id', 'INTEGER');
  // SEPOS-AUDIT-001 — close-time service-charge snapshot + real void instant
  // (see database.js for why). Mirrored here so both backends carry them.
  addColumnIfMissing('orders', 'service_charge', 'REAL');
  addColumnIfMissing('order_items', 'voided_at', 'TIMESTAMP');
  // SEPOS-PRO-008: link a bill to its booking for accurate per-customer spend
  addColumnIfMissing('orders', 'reservation_id', 'INTEGER');
  // SEPOS-021: VAT rate per menu item
  addColumnIfMissing('menu_items', 'vat_rate', 'REAL DEFAULT 20.0');
  addColumnIfMissing('menu_items', 'is_online', 'INTEGER DEFAULT 1');
  // SEPOS-033: marketing consent + unsubscribe (GDPR)
  addColumnIfMissing('reservations', 'marketing_consent', 'INTEGER DEFAULT 0');
  addColumnIfMissing('reservations', 'unsubscribed_at', 'TIMESTAMP');
  addColumnIfMissing('reservations', 'table_ids', 'TEXT'); // multi-table join
  // SEPOS-050: per-restaurant online-booking party-size cap + contact phone
  addColumnIfMissing('restaurant_settings', 'max_party_size', 'INTEGER DEFAULT 8');
  addColumnIfMissing('restaurant_settings', 'restaurant_phone', 'TEXT');
  addColumnIfMissing('tables', 'is_takeaway', 'INTEGER DEFAULT 0'); // SEPOS-TAKEAWAY-TABLE
  addColumnIfMissing('restaurant_settings', 'timezone',                     "TEXT DEFAULT 'Europe/London'");
  addColumnIfMissing('restaurant_settings', 'closed_days', 'TEXT');  // SEPOS-051
  addColumnIfMissing('restaurant_settings', 'takeaway_busy_threshold',      'INTEGER DEFAULT 5');
  addColumnIfMissing('restaurant_settings', 'takeaway_very_busy_threshold', 'INTEGER DEFAULT 10');
  addColumnIfMissing('restaurant_settings', 'takeaway_wait_quiet',          'INTEGER DEFAULT 20');
  addColumnIfMissing('restaurant_settings', 'takeaway_wait_busy',           'INTEGER DEFAULT 35');
  addColumnIfMissing('restaurant_settings', 'takeaway_wait_very_busy',      'INTEGER DEFAULT 50');
  // SEPOS-STRIPE-001: Stripe webhook payment-failure flag
  addColumnIfMissing('restaurants', 'payment_failed_at', 'TIMESTAMP');
  // SEPOS-046k: inventory column upgrades for installs that pre-date
  // the inventory CREATE TABLE block. Safe no-ops on fresh installs.
  addColumnIfMissing('ingredients', 'is_batch',        'INTEGER DEFAULT 0');
  addColumnIfMissing('ingredients', 'batch_recipe_id', 'INTEGER');
  addColumnIfMissing('stock_movements', 'order_item_id', 'INTEGER');
  // SEPOS-034: takeaway / delivery online ordering
  addColumnIfMissing('orders', 'order_type', "TEXT DEFAULT 'dine_in'");
  addColumnIfMissing('orders', 'customer_name', 'TEXT');
  addColumnIfMissing('orders', 'customer_phone', 'TEXT');
  addColumnIfMissing('orders', 'customer_email', 'TEXT');
  addColumnIfMissing('orders', 'pickup_time', 'TIMESTAMP');
  addColumnIfMissing('orders', 'takeaway_status', 'TEXT');
  addColumnIfMissing('orders', 'payment_status', 'TEXT');
  addColumnIfMissing('orders', 'payment_intent_id', 'TEXT');
  // SEPOS-DELIVERY-002 — collection vs delivery for takeaway orders.
  addColumnIfMissing('orders', 'order_subtype', "TEXT DEFAULT 'collection'");
  addColumnIfMissing('orders', 'delivery_address', 'TEXT');
  addColumnIfMissing('orders', 'delivery_notes', 'TEXT');
  addColumnIfMissing('orders', 'marketing_consent', 'INTEGER DEFAULT 0');
  // SEPOS-046g — proper home for the widget's customer-level note.
  addColumnIfMissing('orders', 'customer_note', 'TEXT');
  // SEPOS-DELIVERY-001 — courier auto-dispatch fields
  addColumnIfMissing('orders', 'courier_name', 'TEXT');
  addColumnIfMissing('orders', 'courier_job_id', 'TEXT');
  addColumnIfMissing('orders', 'delivery_status', 'TEXT');
  addColumnIfMissing('orders', 'tracking_url', 'TEXT');
  addColumnIfMissing('orders', 'delivery_eta', 'TIMESTAMP');
  // SEPOS — per-order service-charge removal (persists the Order screen toggle).
  addColumnIfMissing('orders', 'no_service_charge', 'INTEGER DEFAULT 0');

  // SEPOS-DEPOSIT-001 — booking deposits as typed vouchers (default 'gift' = unchanged).
  addColumnIfMissing('vouchers', 'type', "TEXT DEFAULT 'gift'");
  addColumnIfMissing('vouchers', 'reservation_id', 'INTEGER');
  addColumnIfMissing('vouchers', 'take_date', 'TEXT');

  // SEPOS-ALLERGEN-OPT-001 — global (applies to every item) + allergen (⚠️ + free) modifier groups.
  addColumnIfMissing('modifier_groups', 'is_global', 'INTEGER DEFAULT 0');
  addColumnIfMissing('modifier_groups', 'is_allergen', 'INTEGER DEFAULT 0');

  // SEPOS-STATION-001 — category -> printer routing (NULL = today's is_bar rule).
  addColumnIfMissing('categories', 'printer_id', 'INTEGER');

  // SEPOS-PRO-002: bidirectional active-order sync.
  // cloud_id maps a local row to its mirror on the cloud Postgres backend.
  //   - Mac creates an order → INSERT local, push to cloud, capture returned id → UPDATE local.cloud_id
  //   - Chrome creates an order → cloud INSERT, sync pull → INSERT local with cloud_id set
  // Lookups go cloud_id ↔ local id so the in-memory map can finally be retired.
  addColumnIfMissing('orders',      'cloud_id', 'INTEGER');
  addColumnIfMissing('order_items', 'dest_category_id', 'INTEGER');  // SEPOS-MISC-001 — Misc line destination category
  addColumnIfMissing('printers', 'role_receipt', 'INTEGER DEFAULT 0'); // SEPOS-PRINT-UNIFY-001
  addColumnIfMissing('printers', 'role_kitchen', 'INTEGER DEFAULT 0');
  addColumnIfMissing('printers', 'role_bar', 'INTEGER DEFAULT 0');
  addColumnIfMissing('printers', 'lpr_queue', 'TEXT');
  addColumnIfMissing('order_items', 'cloud_id', 'INTEGER');
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cloud_id      ON orders(cloud_id)      WHERE cloud_id IS NOT NULL'); } catch (err) { console.warn('[db:local] orders.cloud_id index:', err.message); }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_cloud_id ON order_items(cloud_id) WHERE cloud_id IS NOT NULL'); } catch (err) { console.warn('[db:local] order_items.cloud_id index:', err.message); }
  // SEPOS-047b — one Stripe PaymentIntent settles exactly one takeaway order.
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_intent ON orders(payment_intent_id) WHERE payment_intent_id IS NOT NULL'); } catch (err) { console.warn('[db:local] orders.payment_intent index:', err.message); }
  // SEPOS-053 — the trading session an order closed under + its cloud binding.
  addColumnIfMissing('orders', 'session_id', 'INTEGER');
  addColumnIfMissing('till_sessions', 'cloud_id', 'INTEGER');
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_cloud_id ON till_sessions(cloud_id) WHERE cloud_id IS NOT NULL'); } catch (err) { console.warn('[db:local] till_sessions.cloud_id index:', err.message); }

  // SEPOS-LITE-001 Phase 1 — multi-tenancy. restaurant_id mirrors the
  // cloud schema so cloud→local sync stays column-aligned; Pro installs
  // keep the default 'siamepos' (single-tenant, so it's a no-op here).
  for (const t of [
    'orders', 'order_items', 'payments', 'menu_items', 'categories',
    'subcategories', 'modifier_groups', 'modifiers', 'order_item_modifiers',
    'staff', 'tables', 'settings', 'campaigns', 'clock_events',
    'discount_reasons', 'z_reports', 'order_deletions', 'webhook_fires',
    'reservation_reminders', 'till_sessions',
  ]) {
    addColumnIfMissing(t, 'restaurant_id', "TEXT DEFAULT 'siamepos'");
  }
  // SEPOS-053 — at most one OPEN till session per restaurant (mirrors PG).
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_open ON till_sessions(restaurant_id) WHERE status='open'"); } catch (err) { console.warn('[db:local] till_sessions open index:', err.message); }

  // SEPOS-LITE-003 — email + password login on the staff table.
  addColumnIfMissing('staff', 'email', 'TEXT');
  addColumnIfMissing('staff', 'password_hash', 'TEXT');
}

function seedDefaults() {
  // Settings — same defaults as PG initDB
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run('service_charge_enabled', 'true');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run('service_charge_rate', '12.5');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run('vat_mode', 'inclusive');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run('deposits_enabled', '0');
  for (const [k, v] of [['kitchen_font_scale', 'large'], ['receipt_font_scale', 'normal'], ['bar_font_scale', 'large']]) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`).run(k, v);
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run('restaurant_name', 'SiamEPOS');

  db.prepare(`
    INSERT INTO restaurant_settings (restaurant_id, restaurant_name)
    VALUES (?, ?)
    ON CONFLICT (restaurant_id) DO NOTHING
  `).run('siamepos', 'SiamEPOS Restaurant');

  const tiers = [
    ['siamepos', 1, 4, 90],
    ['siamepos', 5, 8, 120],
    ['siamepos', 9, null, 150],
  ];
  const tierIns = db.prepare(`
    INSERT INTO dining_duration_tiers (restaurant_id, covers_min, covers_max, duration_mins)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (restaurant_id, covers_min) DO NOTHING
  `);
  for (const t of tiers) tierIns.run(...t);

  // Minimum staff so the operator can log in before the first cloud→local pull (Phase 4).
  // Once sync runs this will be overwritten / supplemented with the real cloud staff list.
  const staffCount = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  if (staffCount === 0) {
    db.prepare(`
      INSERT INTO staff (name, pin, role, is_active, employment_status)
      VALUES (?, ?, ?, ?, ?)
    `).run('Admin', '1234', 'admin', 1, 'active');
    console.log('[db:local] seeded default admin staff (pin 1234) — change after first sync');
  }
}

// ─────────────────────────────────────────────────────────────
// PG → SQLite SQL translation
// ─────────────────────────────────────────────────────────────
function preTranslate(sql) {
  let out = sql;
  // PG `NOW()` → SQLite `CURRENT_TIMESTAMP`
  out = out.replace(/\bNOW\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');
  // PG `FOR UPDATE` row-level lock → SQLite has no row locks; the
  // enclosing BEGIN/COMMIT transaction already serialises access
  // (SQLite uses a whole-DB lock, not row locks). Strip it so SQLite
  // doesn't choke on syntax it doesn't recognise. Without this fix
  // every endpoint that uses SELECT … FOR UPDATE for atomic mutations
  // (voucher redeem, voucher-remove, close-zero, batch make/discard)
  // returns a syntax error on Mac installs running the local backend.
  out = out.replace(/\s+FOR\s+UPDATE(?=\s*$|\s|;)/gi, '');
  // `expr::date` → `date(expr)` (works for column refs and $N placeholders)
  out = out.replace(/([\w.]+|\$\d+)\s*::\s*date\b/gi, 'date($1)');
  // SEPOS-AUDIT-001 — canonicalise BOTH sides of a timestamp comparison.
  // Local rows store naive UTC ('2026-07-08 22:15:00') but rows seeded from
  // the cloud (upsertClosedOrders / pullActiveOrders) carry pg's ISO form
  // ('2026-07-08T13:00:00.000Z'). As raw strings 'T' sorts after ' ', so
  // `closed_at <= datetime(?)` silently dropped every cloud-seeded bill from
  // the till's Z / VAT / report windows. Wrapping the COLUMN side too makes
  // both operands canonical ('YYYY-MM-DD HH:MM:SS') regardless of stored
  // format. Must run BEFORE the generic ::timestamp rule below.
  // Inequality operators ONLY — a bare `=` could be an UPDATE … SET
  // assignment, which must not become `datetime(col) = …`. Every real
  // window comparison in server.js uses >=, <=, or >.
  out = out.replace(
    /([\w.]+)\s*(>=|<=|<>|!=|>|<)\s*(\$\d+)\s*::\s*timestamp\b/gi,
    'datetime($1) $2 datetime($3)'
  );
  // `expr::timestamp` → `datetime(expr)`
  out = out.replace(/([\w.]+|\$\d+)\s*::\s*timestamp\b/gi, 'datetime($1)');
  // SEPOS-047e — `expr::int` → `CAST(expr AS INTEGER)`. SQLite has no `::`
  // cast syntax, so untranslated `::int` was a hard syntax error that 500'd
  // (per the bug hunt) every staff edit (COALESCE($N::int,…)), the voucher
  // sold/redeemed report figures (COUNT(*)::int — silently £0 via .catch),
  // and batch-recipe deletes (COUNT(*)::int guard). Operand may be a
  // placeholder ($N), a function call (COUNT(*), SUM(…)), or a column. The
  // negative lookahead leaves `::int[]` untouched for translateParams' ANY
  // array expansion below.
  out = out.replace(
    /(\$\d+|[A-Za-z_]\w*\s*\([^()]*\)|[\w.]+)\s*::\s*int\b(?!\s*\[)/gi,
    'CAST($1 AS INTEGER)'
  );
  // SEPOS-047e — PG `ILIKE` (case-insensitive LIKE) → SQLite `LIKE`, which
  // is already case-insensitive for ASCII. Without this, voucher search
  // (GET /api/vouchers?q=…) 500'd on desktop the moment the operator typed.
  out = out.replace(/\bILIKE\b/gi, 'LIKE');
  // Korakot 2026-06-02: PG's GREATEST/LEAST aren't in SQLite, but SQLite's
  // max()/min() act as scalar comparators when given >1 argument. The
  // /api/reports/summary + /api/z-report/preview food-vs-drink query
  // in v1.6.16 was using GREATEST(0, ...) and silently 500ing on Mac
  // installs, blanking Trading + Reports + Z Report. Translating here
  // keeps server.js cross-DB.
  out = out.replace(/\bGREATEST\s*\(/gi, 'max(');
  out = out.replace(/\bLEAST\s*\(/gi,    'min(');
  // PG `TO_CHAR(col, 'fmt')` → SQLite `strftime('fmt', col)`.
  // Translate the format string (PG uses YYYY/MM/DD/HH24/MI/SS;
  // strftime uses %Y/%m/%d/%H/%M/%S). Common patterns we hit:
  // 'YYYY-MM-DD', 'HH24:MI', 'HH24:MI:SS'.
  out = out.replace(
    /\bTO_CHAR\s*\(\s*([^,]+?)\s*,\s*'([^']+)'\s*\)/gi,
    (_, expr, fmt) => {
      const sfmt = fmt
        .replace(/YYYY/g, '%Y').replace(/MM/g, '%m').replace(/DD/g, '%d')
        .replace(/HH24/g, '%H').replace(/MI/g, '%M').replace(/SS/g, '%S');
      return `strftime('${sfmt}', ${expr.trim()})`;
    }
  );
  return out;
}

// Walk SQL char-by-char, replacing $N with ? and expanding `= ANY($N::int[])`
// into `IN (?,?,...)`. Returns { sql, params } both ready for better-sqlite3.
function translateParams(sql, params) {
  let out = '';
  const flat = [];
  let i = 0;
  while (i < sql.length) {
    const tail = sql.slice(i);
    const m = tail.match(/^\$(\d+)/);
    if (!m) { out += sql[i++]; continue; }

    const idx = parseInt(m[1], 10) - 1;
    const val = params[idx];

    // Lookahead/lookback to detect `= ANY($N ...)` pattern.
    const anyMatch = out.match(/=\s*ANY\s*\(\s*$/);
    if (anyMatch && Array.isArray(val)) {
      // Replace the trailing `= ANY(` with `IN (`
      out = out.slice(0, out.length - anyMatch[0].length) + 'IN (';
      const placeholders = val.map(() => '?').join(', ');
      out += placeholders;
      flat.push(...val);
      i += m[0].length;
      // Consume optional `::xxx[]` suffix
      const suffix = sql.slice(i).match(/^\s*::\s*[a-z]+\[\]/i);
      if (suffix) i += suffix[0].length;
      // The original `)` after the cast/$N stays in the SQL — leave for normal copy.
      continue;
    }

    out += '?';
    flat.push(val);
    i += m[0].length;
  }
  return { sql: out, params: flat };
}

function shouldReturnRows(sql) {
  // SELECT/WITH/VALUES — yes. Anything with RETURNING — yes.
  return /^\s*(SELECT|WITH|VALUES|EXPLAIN|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

// ─────────────────────────────────────────────────────────────
// pg.Pool-compatible interface
// ─────────────────────────────────────────────────────────────
// SQLite stores CURRENT_TIMESTAMP as a naive UTC string like
// "2026-05-12 10:00:00" — no Z, no offset. JavaScript's `new Date(...)` then
// parses it as LOCAL time, which throws timers off by exactly the local TZ
// offset (1 hour during UK BST, hence the "table timer is 1h ahead" bug).
// Normalising rows on the way out converts every such string to ISO 8601 UTC
// ("2026-05-12T10:00:00Z") so any consumer parsing with `new Date()` gets the
// correct instant. The pattern only matches FULL date-time strings; pure
// dates ("2026-05-12") and pure times ("18:30") are untouched.
const NAIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
function normaliseTimestamps(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v === 'string' && NAIVE_TIMESTAMP_RE.test(v)) {
        row[key] = v.replace(' ', 'T') + 'Z';
      }
    }
  }
  return rows;
}

async function query(text, params = []) {
  if (typeof text !== 'string') {
    // pg supports { text, values } config-object form; not exercised in server.js today.
    throw new Error('[db:local] config-object query form not supported');
  }
  const pre = preTranslate(text);
  const { sql, params: flat } = translateParams(pre, params || []);
  // SEPOS-AUDIT-001 — coerce JS booleans to 1/0 at the choke point.
  // Cloud PG BOOLEAN columns (table_combinations.is_active,
  // restaurant_settings.is_active, …) arrive through res.json as JS
  // true/false; better-sqlite3 refuses to bind booleans ("can only bind
  // numbers, strings, bigints, buffers, and null"), so every sync upsert
  // carrying one silently failed each 5s tick — linked-table groups and
  // reservation settings never reached the till. One map fixes every
  // current and future feed.
  const bound = flat.map((v) => (v === true ? 1 : v === false ? 0 : v));

  try {
    if (shouldReturnRows(sql)) {
      const rows = normaliseTimestamps(db.prepare(sql).all(...bound));
      return { rows, rowCount: rows.length };
    }
    const info = db.prepare(sql).run(...bound);
    return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
  } catch (err) {
    err.message = `[db:local] ${err.message}\n  sql: ${sql}\n  params: ${JSON.stringify(flat)}`;
    throw err;
  }
}

// Transactions: server.js does `pool.connect()` → BEGIN/COMMIT on the returned client.
// better-sqlite3 is a single synchronous connection, so we just route everything through query().
async function connect() {
  return {
    query: (text, params) => query(text, params),
    release: () => {},
  };
}

async function end() {
  db.close();
}

// Init on require
try {
  initSchema();
  runMigrations();
  seedDefaults();
  console.log('[db:local] ✅ schema ready');
} catch (err) {
  console.error('[db:local] init error:', err);
}

module.exports = { query, connect, end };
