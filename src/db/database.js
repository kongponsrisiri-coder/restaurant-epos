const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  min: 2,
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 3000,
});

// SEPOS-047l — store/serve all timestamps in UTC.
// The old `SET timezone='Europe/London'` made NOW()/CURRENT_TIMESTAMP write
// BST wall-clock into the tz-naive TIMESTAMP columns (opened_at, closed_at,
// fired_at, …), but the Node process reads them back as UTC — so during BST
// EVERY timestamp came out +1 hour. Visible bug: a freshly-opened table
// showed "0m" for up to an hour because its opened_at was ~1h in the future,
// so the floor-map timer read a negative elapsed time and clamped to 0.
// UK time-of-day logic no longer needs the connection TZ: SEPOS-048 moved
// the reservation/takeaway HH:MM validators to minutesInZone() using each
// restaurant's own IANA timezone, so UTC on the wire is both correct and
// safe. (Existing rows written under the old setting stay 1h off until they
// close out — only the live/open timers matter.)
pool.on('connect', client => {
  client.query("SET timezone='UTC'").catch(() => {});
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id SERIAL PRIMARY KEY,
        table_number INTEGER,
        name VARCHAR(100),
        capacity INTEGER DEFAULT 4,
        status VARCHAR(50) DEFAULT 'available',
        pos_x INTEGER DEFAULT 0,
        pos_y INTEGER DEFAULT 0,
        shape VARCHAR(50) DEFAULT 'square',
        width INTEGER DEFAULT 80,
        height INTEGER DEFAULT 80
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_bar INTEGER DEFAULT 0,
        default_course INTEGER DEFAULT 1
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        name_alt VARCHAR(255),
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        is_available INTEGER DEFAULT 1,
        is_online INTEGER DEFAULT 1,
        allergens TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);

    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_online INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_alt VARCHAR(255)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS modifier_groups (
        id SERIAL PRIMARY KEY,
        menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        required INTEGER DEFAULT 0,
        multi_select INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS modifiers (
        id SERIAL PRIMARY KEY,
        group_id INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        extra_price DECIMAL(10,2) DEFAULT 0,
        is_available INTEGER DEFAULT 1
      )
    `);

    // SEPOS-059 — shared modifier library. A modifier_groups row with
    // menu_item_id = NULL is a reusable "library" group (e.g. Meat choice,
    // Spice level); this join links it to many dishes. Per-dish (legacy)
    // groups keep their menu_item_id and still work — resolution UNIONs both.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
        id SERIAL PRIMARY KEY,
        menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        UNIQUE (menu_item_id, group_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
        status VARCHAR(50) DEFAULT 'open',
        covers INTEGER DEFAULT 1,
        total DECIMAL(10,2) DEFAULT 0,
        discount_type VARCHAR(50),
        discount_value DECIMAL(10,2),
        discount_reason TEXT,
        bill_printed INTEGER DEFAULT 0,
        opened_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        menu_item_id INTEGER,
        item_name VARCHAR(255),
        quantity INTEGER DEFAULT 1,
        unit_price DECIMAL(10,2),
        notes TEXT,
        course INTEGER DEFAULT 1,
        item_note TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        is_fired INTEGER DEFAULT 0,
        fired_at TIMESTAMP,
        cooking_started_at TIMESTAMP,
        served_at TIMESTAMP,
        voided INTEGER DEFAULT 0,
        void_reason TEXT,
        discount_type VARCHAR(50),
        discount_value DECIMAL(10,2)
      )
    `);

    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS resend_reason TEXT`);  // SEPOS-024
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS void_type VARCHAR(50)`); // SEPOS-023
    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5,2) DEFAULT 20.0`); // SEPOS-021

    // SEPOS-034: takeaway / delivery online ordering
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'dine_in'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_time TIMESTAMP`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS takeaway_status VARCHAR(20)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255)`);
    // SEPOS-053 — the trading session an order was closed under (EposNow-style
    // overnight shifts). NULL when no shift was open at close time; the
    // date-range Z-report still catches those.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id INTEGER`);
    // SEPOS-DELIVERY-002 — collection vs delivery for takeaway orders.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_subtype VARCHAR(20) DEFAULT 'collection'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_notes TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketing_consent INTEGER DEFAULT 0`);
    // SEPOS-046g — proper home for the widget's customer-level note
    // ("PEANUT ALLERGY", "extra spicy"). Used to be misfiled into
    // discount_reason, which polluted reports that expected discount text.
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_note TEXT`);
    // SEPOS-DELIVERY-001 — courier auto-dispatch (Stuart / Uber Direct)
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_name VARCHAR(50)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_job_id VARCHAR(255)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(40)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_eta TIMESTAMP`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deliveroo_order_id VARCHAR(255)`);
    await pool.query(`ALTER TABLE orders ALTER COLUMN table_id DROP NOT NULL`).catch(() => {});

    // SEPOS-033 Phase 2 — campaign audit log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        subject VARCHAR(500),
        body TEXT,
        segment VARCHAR(50),
        recipient_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // SEPOS-033 Phase 3 — Make.com webhook fire audit (dedupe)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_fires (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50),
        entity_key VARCHAR(255),
        fired_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_fires_event_entity ON webhook_fires(event_type, entity_key)`);
    await pool.query(`ALTER TABLE order_items ALTER COLUMN menu_item_id DROP NOT NULL`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_item_modifiers (
        id SERIAL PRIMARY KEY,
        order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
        modifier_id INTEGER,
        name VARCHAR(100),
        extra_price DECIMAL(10,2) DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        pin VARCHAR(10) UNIQUE NOT NULL,
        role VARCHAR(50) DEFAULT 'waiter',
        is_active INTEGER DEFAULT 1,
        start_date DATE,
        notes TEXT,
        employment_status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL`); // SEPOS-030

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        amount DECIMAL(10,2),
        method VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // SEPOS-042: audit log for manager-authorised order deletions.
    // The order itself disappears but this row is the paper trail —
    // who deleted it, when, the total at deletion time, and why.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_deletions (
        id              SERIAL PRIMARY KEY,
        order_id        INTEGER NOT NULL,
        staff_id        INTEGER,
        staff_name      TEXT,
        reason          TEXT,
        deleted_total   NUMERIC(10,2),
        order_type      TEXT,
        opened_at       TIMESTAMP,
        closed_at       TIMESTAMP,
        deleted_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    // SEPOS-022: staff clock-in / clock-out events
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clock_events (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
        event_type VARCHAR(10) NOT NULL,
        event_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clock_events_staff_at ON clock_events(staff_id, event_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT
      )
    `);

    await pool.query(`
      INSERT INTO settings (key, value) VALUES
        ('service_charge_enabled', 'true'),
        ('service_charge_rate', '12.5'),
        ('restaurant_name', 'SiamEPOS')
      ON CONFLICT (key) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS discount_reasons (
        id SERIAL PRIMARY KEY,
        reason VARCHAR(255) NOT NULL,
        is_active INTEGER DEFAULT 1
      )
    `);

    // SEPOS-KITCHEN-MSG-001 — pre-canned messages waiters can one-tap to
    // send to the kitchen (allergies, holds, VIP, birthday, etc.). Admin
    // can add/edit/delete in Settings → Kitchen Templates.
    // SEPOS-PAY-AMEND-001 — payments gain audit columns; full history
    // of every method change lives in payment_amendments (immutable).
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amended_at TIMESTAMP`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amended_by INTEGER REFERENCES staff(id)`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amend_reason TEXT`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amended_from VARCHAR(50)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_amendments (
        id SERIAL PRIMARY KEY,
        payment_id    INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        order_id      INTEGER NOT NULL,
        from_method   VARCHAR(50) NOT NULL,
        to_method     VARCHAR(50) NOT NULL,
        reason        TEXT,
        amended_by    INTEGER REFERENCES staff(id),
        amended_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kitchen_message_templates (
        id SERIAL PRIMARY KEY,
        label       VARCHAR(80)  NOT NULL,
        message     TEXT         NOT NULL,
        icon        VARCHAR(20),
        sort_order  INTEGER      DEFAULT 100,
        is_active   INTEGER      DEFAULT 1,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);

    // Seed common templates on first boot. Restaurant can edit / delete
    // any of these; new ones go above via Settings.
    const seedRes = await pool.query('SELECT COUNT(*) AS n FROM kitchen_message_templates');
    if (Number(seedRes.rows[0]?.n || 0) === 0) {
      await pool.query(`
        INSERT INTO kitchen_message_templates (label, message, icon, sort_order) VALUES
          ('Allergy: nuts',   'ALLERGY: NUTS — prepare with care',     '⚠️', 10),
          ('Allergy: gluten', 'GLUTEN-FREE for entire order',          '🌾', 20),
          ('Allergy: shellfish', 'ALLERGY: SHELLFISH — separate prep', '🦐', 30),
          ('Vegetarian',      'VEGETARIAN for entire order',           '🥬', 40),
          ('Vegan',           'VEGAN for entire order',                '🌱', 50),
          ('Hold mains',      'HOLD MAINS — wait for signal',          '⏸',  60),
          ('Fire mains',      'FIRE MAINS NOW',                        '🔥', 70),
          ('Birthday cake',   'BIRTHDAY CAKE — bring after mains',     '🎂', 80),
          ('VIP table',       'VIP — extra care please',               '⭐', 90),
          ('No spice',        'NO SPICE — sensitive customer',         '🌶️', 100)
      `);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS z_reports (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        opened_at TIMESTAMP,
        closed_at TIMESTAMP,
        total_sales DECIMAL(10,2),
        total_cash DECIMAL(10,2),
        total_card DECIMAL(10,2),
        total_other DECIMAL(10,2),
        total_covers INTEGER,
        total_orders INTEGER,
        discounts DECIMAL(10,2),
        voids DECIMAL(10,2),
        float_amount DECIMAL(10,2),
        petty_cash DECIMAL(10,2),
        petty_cash_reason TEXT,
        actual_cash DECIMAL(10,2),
        cash_difference DECIMAL(10,2),
        report_data JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // SEPOS-053 — till trading sessions (EposNow-style Open Shift → Close
    // Shift). At most ONE open session per restaurant (partial unique index
    // below); orders stamp their session_id at close, and Close Shift totals
    // the Z by session_id instead of a calendar date window — so a shift can
    // span midnight / two nights and is immune to the timezone day boundary.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS till_sessions (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'open',
        opened_at TIMESTAMP DEFAULT NOW(),
        opened_by INTEGER,
        closed_at TIMESTAMP,
        closed_by INTEGER,
        float_amount DECIMAL(10,2) DEFAULT 0,
        z_report_id INTEGER,
        cloud_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos',
        table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(50),
        customer_email VARCHAR(255),
        covers INTEGER NOT NULL DEFAULT 2,
        reservation_date DATE NOT NULL,
        reservation_time TIME NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        notes TEXT,
        source VARCHAR(50) DEFAULT 'epos',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS marketing_consent INTEGER DEFAULT 0`); // SEPOS-033 (GDPR)
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMP`); // SEPOS-033
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_ids TEXT`); // multi-table join — CSV of table ids, table_id stays the primary

    // SEPOS-PRO-008 — link a bill to the booking it belongs to, for accurate
    // per-customer spend. Placed AFTER the reservations table exists so the FK
    // resolves on a fresh database. ON DELETE SET NULL: deleting a reservation
    // must NEVER delete the bill (revenue stays; the link just clears).
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservation_reminders (
        id SERIAL PRIMARY KEY,
        reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
        type VARCHAR(50),
        sent_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS restaurant_settings (
        id SERIAL PRIMARY KEY,
        restaurant_id VARCHAR(100) UNIQUE NOT NULL DEFAULT 'siamepos',
        restaurant_name VARCHAR(255) DEFAULT 'My Restaurant',
        brand_colour VARCHAR(20) DEFAULT '#1a472a',
        opening_time TIME DEFAULT '11:00',
        last_booking_time TIME DEFAULT '21:30',
        slot_interval_mins INTEGER DEFAULT 15,
        max_covers_per_slot INTEGER DEFAULT 20,
        booking_lead_hours INTEGER DEFAULT 1,
        booking_advance_days INTEGER DEFAULT 60,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) DEFAULT 'all_day'`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS lunch_service_start TIME DEFAULT '11:00'`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS lunch_service_end TIME DEFAULT '14:30'`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS dinner_service_start TIME DEFAULT '17:30'`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS dinner_service_end TIME DEFAULT '21:30'`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS max_party_size INTEGER DEFAULT 8`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS restaurant_phone VARCHAR(30)`);
// SEPOS-048 — per-restaurant timezone so cloud validators don't depend on Railway's
// process TZ (defaults to Europe/London since current customers are UK).
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'Europe/London'`);
// SEPOS-047 — kitchen-load wait time for the takeaway widget
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS takeaway_busy_threshold      INTEGER DEFAULT 5`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS takeaway_very_busy_threshold INTEGER DEFAULT 10`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS takeaway_wait_quiet          INTEGER DEFAULT 20`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS takeaway_wait_busy           INTEGER DEFAULT 35`);
await pool.query(`ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS takeaway_wait_very_busy      INTEGER DEFAULT 50`);
    await pool.query(`
      INSERT INTO restaurant_settings (restaurant_id, restaurant_name)
      VALUES ('siamepos', 'SiamEPOS Restaurant')
      ON CONFLICT (restaurant_id) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS table_combinations (
        id SERIAL PRIMARY KEY,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos',
        table_id_a INTEGER REFERENCES tables(id) ON DELETE CASCADE,
        table_id_b INTEGER REFERENCES tables(id) ON DELETE CASCADE,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS table_walls (
        id SERIAL PRIMARY KEY,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos',
        pos_x INTEGER DEFAULT 0,
        pos_y INTEGER DEFAULT 0,
        width INTEGER DEFAULT 8,
        height INTEGER DEFAULT 80,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dining_duration_tiers (
        id SERIAL PRIMARY KEY,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos',
        covers_min INTEGER NOT NULL,
        covers_max INTEGER,
        duration_mins INTEGER NOT NULL DEFAULT 90
      )
    `);

    // Remove duplicate rows — keep only the lowest id per covers_min
    await pool.query(`
      DELETE FROM dining_duration_tiers WHERE id NOT IN (
        SELECT MIN(id) FROM dining_duration_tiers GROUP BY restaurant_id, covers_min
      )
    `);

    // Add unique constraint so duplicates can never happen again
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS dining_tiers_unique
      ON dining_duration_tiers(restaurant_id, covers_min)
    `);

    // SEPOS-047b — one Stripe PaymentIntent settles exactly one takeaway
    // order. Race-proof backstop behind the endpoint's friendly check.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_intent
      ON orders(payment_intent_id) WHERE payment_intent_id IS NOT NULL
    `);

    // Seed the 3 tiers — safe to re-run on every restart
    await pool.query(`
      INSERT INTO dining_duration_tiers (restaurant_id, covers_min, covers_max, duration_mins) VALUES
        ('siamepos', 1, 4, 90),
        ('siamepos', 5, 8, 120),
        ('siamepos', 9, NULL, 150)
      ON CONFLICT (restaurant_id, covers_min) DO NOTHING
    `);

    await pool.query(`
      UPDATE menu_items SET sort_order = id WHERE sort_order = 0 OR sort_order IS NULL
    `);

    // SEPOS-042 repair: an earlier PUT /api/staff/:id bug wrote
    // is_active = NULL whenever the edit form didn't include the field
    // (which it never did). That broke the manager-PIN check on the
    // order-delete endpoint AND made the staff look inactive in the UI.
    // The handler is now COALESCE-safe; this one-off restores any rows
    // that got NULL'd by the old code path.
    await pool.query(`UPDATE staff SET is_active = 1 WHERE is_active IS NULL`);

    // SEPOS-LITE-003 — email + password login (for Lite restaurant
    // owners using the full app). Optional columns on staff; PIN login
    // is unaffected — a staff member can have a PIN, an email login, or
    // both. pin becomes nullable so an email-only owner needs no PIN
    // (pin stays UNIQUE — Postgres allows multiple NULLs).
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await pool.query(`ALTER TABLE staff ALTER COLUMN pin DROP NOT NULL`).catch(() => {});

    // ── SEPOS-LITE-001 Phase 1 — multi-tenancy foundation ────────────
    // A `restaurants` registry plus a `restaurant_id` column on every
    // tenant-scoped table. Default 'siamepos' so single-tenant Pro
    // installs are untouched — restaurant_id is a no-op for them. The
    // shared multi-tenant Lite backend resolves restaurant_id per
    // request (Phase 2). ADD COLUMN with a constant default is a fast
    // metadata-only change in Postgres, safe on populated tables.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS restaurants (
        restaurant_id          VARCHAR(100) PRIMARY KEY,
        name                   VARCHAR(255),
        plan                   VARCHAR(30)  DEFAULT 'pro',
        api_key                VARCHAR(100) UNIQUE,
        status                 VARCHAR(20)  DEFAULT 'active',
        stripe_customer_id     VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        payment_failed_at      TIMESTAMP,
        created_at             TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      INSERT INTO restaurants (restaurant_id, name, plan)
      VALUES ('siamepos', 'SiamEPOS', 'pro')
      ON CONFLICT (restaurant_id) DO NOTHING
    `);
    // SEPOS-STRIPE-001 — flag set by the Stripe webhook on a failed
    // subscription invoice; cleared when the subscription recovers.
    await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMP`);
    const TENANT_TABLES = [
      'orders', 'order_items', 'payments', 'menu_items', 'categories',
      'subcategories', 'modifier_groups', 'modifiers', 'order_item_modifiers',
      'staff', 'tables', 'settings', 'campaigns', 'clock_events',
      'discount_reasons', 'z_reports', 'order_deletions', 'webhook_fires',
      'reservation_reminders', 'till_sessions',
    ];
    for (const t of TENANT_TABLES) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS restaurant_id VARCHAR(100) DEFAULT 'siamepos'`);
    }
    // SEPOS-053 — at most one OPEN till session per restaurant. Unique on
    // restaurant_id but only over open rows, so closed history is unbounded.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_open
      ON till_sessions(restaurant_id) WHERE status='open'
    `);
    // Indexes on the high-traffic tables — only meaningful for the
    // shared multi-tenant Lite DB; harmless on a single-tenant Pro DB.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_restaurant      ON orders(restaurant_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_restaurant ON order_items(restaurant_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant  ON menu_items(restaurant_id)`);

    // ── SEPOS-VOUCHER-001 — gift vouchers (monetary only) ──────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        original_amount NUMERIC(10,2) NOT NULL,
        balance NUMERIC(10,2) NOT NULL,
        recipient_name TEXT,
        recipient_email TEXT,
        sender_name TEXT,
        message TEXT,
        delivery_date DATE,
        expires_at DATE NOT NULL,
        payment_method VARCHAR(20) DEFAULT 'stripe',
        stripe_payment_intent_id TEXT,
        status VARCHAR(20) DEFAULT 'active',
        email_sent_at TIMESTAMP,
        voided_by TEXT,
        voided_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vouchers_code        ON vouchers (code)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vouchers_restaurant  ON vouchers (restaurant_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS voucher_redemptions (
        id SERIAL PRIMARY KEY,
        voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
        bill_id INTEGER,
        amount_used NUMERIC(10,2) NOT NULL,
        redeemed_by INTEGER,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher ON voucher_redemptions (voucher_id)`);

    // ── Inventory schema (SEPOS-031 / SEPOS-032 / SEPOS-046) ──
    // These tables were previously created manually via psql on the main
    // siamepos Railway and never codified — new tenant Railways (e.g.
    // baan-siam) couldn't run any inventory feature until someone ran
    // CREATE TABLE manually. Also caused sync-delete-order to fail on
    // those tenants because the stock_movements DELETE blew up before
    // the order rows got cleaned up (see SEPOS-046i).
    //
    // Adding CREATE TABLE IF NOT EXISTS so any future tenant
    // self-provisions on first server boot. Main siamepos's existing
    // tables are unaffected (IF NOT EXISTS guards each one).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ingredients (
        id SERIAL PRIMARY KEY,
        name_en VARCHAR(255) NOT NULL,
        name_th VARCHAR(255) DEFAULT '',
        unit VARCHAR(20) DEFAULT 'kg',
        cost_per_unit NUMERIC(10,4) DEFAULT 0,
        yield_percentage NUMERIC(5,2) DEFAULT 100,
        category VARCHAR(50) DEFAULT 'Other',
        current_stock NUMERIC(12,3) DEFAULT 0,
        par_level NUMERIC(12,3),
        supplier_name VARCHAR(255) DEFAULT '',
        allergens TEXT DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        ingredient_id INTEGER NOT NULL,
        movement_type VARCHAR(20) NOT NULL,
        quantity NUMERIC(12,3) NOT NULL,
        cost_at_time NUMERIC(10,4) DEFAULT 0,
        note TEXT,
        reference VARCHAR(100),
        order_item_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient ON stock_movements(ingredient_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item ON stock_movements(order_item_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_created    ON stock_movements(created_at DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recipes (
        id SERIAL PRIMARY KEY,
        menu_item_id INTEGER NOT NULL,
        name VARCHAR(255) NOT NULL,
        serves INTEGER DEFAULT 1,
        total_cost NUMERIC(10,2) DEFAULT 0,
        cost_per_portion NUMERIC(10,4) DEFAULT 0,
        last_calculated TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipes_menu_item ON recipes(menu_item_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recipe_lines (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL,
        quantity_used NUMERIC(10,4) NOT NULL,
        unit VARCHAR(20),
        line_cost NUMERIC(10,2) DEFAULT 0
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipe_lines_recipe ON recipe_lines(recipe_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS supplier_invoices (
        id SERIAL PRIMARY KEY,
        supplier_name VARCHAR(255),
        invoice_date DATE,
        invoice_number VARCHAR(100),
        total_amount NUMERIC(10,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'processed',
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_date ON supplier_invoices(invoice_date DESC)`);

    // SEPOS-046ac — `expenses` (Cost & Sales tab) was referenced by three
    // endpoints but never codified in CREATE TABLE — same class as the
    // SEPOS-046j inventory gap: worked on main siamepos via a manual psql
    // migration, 500'd on baan-siam / fresh tenants / desktop SQLite.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50) DEFAULT 'other',
        description TEXT NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        date DATE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date DESC)`);

    // ── SEPOS-BATCH-001 — kitchen batch prep ───────────────────────────
    // batch_recipes is the make-template (e.g. "Red Curry Paste: 5kg from
    // ingredients X+Y+Z, shelf life 5 days"). Creating a batch_recipe
    // also auto-creates a matching `ingredients` row with is_batch=true,
    // so menu recipes can use the batch as an ingredient like any other.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_recipes (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        output_quantity NUMERIC(10,3) NOT NULL,
        output_unit VARCHAR(20) NOT NULL,
        shelf_life_days INTEGER NOT NULL DEFAULT 3,
        total_cost NUMERIC(10,2) DEFAULT 0,
        cost_per_unit NUMERIC(10,4) DEFAULT 0,
        notes TEXT,
        last_calculated TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_recipe_lines (
        id SERIAL PRIMARY KEY,
        batch_recipe_id INTEGER NOT NULL REFERENCES batch_recipes(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL,
        quantity_used NUMERIC(10,3) NOT NULL,
        unit VARCHAR(20),
        line_cost NUMERIC(10,2) DEFAULT 0
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_batch_recipe_lines_recipe ON batch_recipe_lines(batch_recipe_id)`);

    // batches = actual physical instances of made batches. Each one has
    // its own cost-locked-at-make-time + expiry. Status flow:
    //   active → expired (auto on read after expires_on)
    //   active|expired → discarded (chef tick: subtract remaining from stock,
    //                                write stock_movements waste row)
    //   active|expired → active (chef tick "✓ Still good" → expires_on += 1)
    //   active → used_up (manual or computed when remaining hits 0)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batches (
        id SERIAL PRIMARY KEY,
        batch_recipe_id INTEGER REFERENCES batch_recipes(id) ON DELETE SET NULL,
        ingredient_id INTEGER NOT NULL,
        made_on DATE NOT NULL DEFAULT CURRENT_DATE,
        expires_on DATE NOT NULL,
        original_quantity NUMERIC(10,3) NOT NULL,
        locked_cost_per_unit NUMERIC(10,4) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        made_by INTEGER,
        notes TEXT,
        discarded_qty NUMERIC(10,3),
        discarded_at TIMESTAMP,
        discarded_by INTEGER,
        extended_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        restaurant_id VARCHAR(100) DEFAULT 'siamepos'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_recipe     ON batches(batch_recipe_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_ingredient ON batches(ingredient_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_status_exp ON batches(status, expires_on)`);

    // Tag ingredients that ARE batches so the recipe picker can show a 🥣
    // badge + UI can prevent direct edits (cost comes from batch makes,
    // not manual entry).
    await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS is_batch BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS batch_recipe_id INTEGER`);

    console.log('✅ Database ready');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

initDB();

module.exports = pool;
