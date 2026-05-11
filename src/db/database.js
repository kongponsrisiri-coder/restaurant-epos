const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  min: 2,
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 3000,
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
        allergens TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);

    await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens TEXT DEFAULT NULL`);
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
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL`); // SEPOS-030
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        amount DECIMAL(10,2),
        method VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
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

    console.log('✅ Database ready');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

initDB();

module.exports = pool;
