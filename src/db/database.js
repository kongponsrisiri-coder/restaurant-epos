const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id SERIAL PRIMARY KEY,
        table_number INTEGER NOT NULL UNIQUE,
        name TEXT,
        capacity INTEGER DEFAULT 4,
        status TEXT DEFAULT 'available',
        pos_x REAL DEFAULT 0,
        pos_y REAL DEFAULT 0,
        shape TEXT DEFAULT 'square',
        width REAL DEFAULT 100,
        height REAL DEFAULT 100
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_bar INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id),
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id),
        subcategory_id INTEGER REFERENCES subcategories(id),
        name TEXT NOT NULL,
        name_alt TEXT,
        description TEXT,
        price REAL NOT NULL,
        is_available INTEGER DEFAULT 1
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS modifier_groups (
        id SERIAL PRIMARY KEY,
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
        name TEXT NOT NULL,
        required INTEGER DEFAULT 1,
        multi_select INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS modifiers (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES modifier_groups(id),
        name TEXT NOT NULL,
        extra_price REAL DEFAULT 0,
        is_available INTEGER DEFAULT 1
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        table_id INTEGER REFERENCES tables(id),
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP,
        opened_at TIMESTAMP DEFAULT NOW(),
        total REAL DEFAULT 0,
        notes TEXT,
        covers INTEGER DEFAULT 1,
        discount_type TEXT,
        discount_value REAL,
        discount_reason TEXT,
        bill_printed INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
        quantity INTEGER DEFAULT 1,
        unit_price REAL NOT NULL,
        notes TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        course INTEGER DEFAULT 1,
        item_note TEXT,
        is_fired INTEGER DEFAULT 0,
        fired_at TIMESTAMP,
        cooking_started_at TIMESTAMP,
        served_at TIMESTAMP,
        voided INTEGER DEFAULT 0,
        void_reason TEXT,
        discount_type TEXT,
        discount_value REAL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_item_modifiers (
        id SERIAL PRIMARY KEY,
        order_item_id INTEGER NOT NULL REFERENCES order_items(id),
        modifier_id INTEGER NOT NULL REFERENCES modifiers(id),
        name TEXT NOT NULL,
        extra_price REAL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'waiter',
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        start_date TEXT,
        notes TEXT,
        employment_status TEXT DEFAULT 'active'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        amount REAL NOT NULL,
        method TEXT DEFAULT 'cash',
        paid_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS discount_reasons (
        id SERIAL PRIMARY KEY,
        reason TEXT NOT NULL,
        is_active INTEGER DEFAULT 1
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS z_reports (
        id SERIAL PRIMARY KEY,
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
        voids INTEGER,
        float_amount REAL,
        petty_cash REAL,
        petty_cash_reason TEXT,
        actual_cash REAL,
        cash_difference REAL,
        report_data TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
// Restaurant settings for widget (brand, hours, capacity)
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

// Seed default row if none exists
await pool.query(`
  INSERT INTO restaurant_settings (restaurant_id, restaurant_name)
  VALUES ('siamepos', 'SiamEPOS Restaurant')
  ON CONFLICT (restaurant_id) DO NOTHING
`);

// Reservations table (if not already added)
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
// Add allergens column to menu_items if not exists
await pool.query(`
  ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS allergens TEXT DEFAULT NULL
`);
await pool.query(`
  ALTER TABLE order_items 
  ALTER COLUMN menu_item_id DROP NOT NULL
`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS reservation_reminders (
    id SERIAL PRIMARY KEY,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
    type VARCHAR(50),
    sent_at TIMESTAMP DEFAULT NOW()
  )
`);
    // ── Add new columns to existing tables if not exist ──
    await client.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_type TEXT`);
    await client.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_value REAL DEFAULT 0`);
    await client.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS start_date TEXT`);
    await client.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS notes TEXT`);
    await client.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS employment_status TEXT DEFAULT 'active'`);
    await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_alt TEXT`);
await client.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS default_course INTEGER DEFAULT 1`);
    // ── Seed starter data ──
    const tablesCount = await client.query('SELECT COUNT(*) as count FROM tables');
    if (parseInt(tablesCount.rows[0].count) === 0) {
      for (let i = 1; i <= 10; i++) {
        await client.query('INSERT INTO tables (table_number, capacity) VALUES ($1, $2)', [i, 4]);
      }
      console.log('Created 10 tables');
    }

    const categoriesCount = await client.query('SELECT COUNT(*) as count FROM categories');
    if (parseInt(categoriesCount.rows[0].count) === 0) {
      await client.query("INSERT INTO categories (name, sort_order) VALUES ('Starters', 1)");
      await client.query("INSERT INTO categories (name, sort_order) VALUES ('Mains', 2)");
      await client.query("INSERT INTO categories (name, sort_order) VALUES ('Desserts', 3)");
      await client.query("INSERT INTO categories (name, sort_order) VALUES ('Drinks', 4)");
      console.log('Created starter categories');
    }

    const staffCount = await client.query('SELECT COUNT(*) as count FROM staff');
    if (parseInt(staffCount.rows[0].count) === 0) {
      await client.query("INSERT INTO staff (name, pin, role) VALUES ('Admin', '0000', 'admin')");
      await client.query("INSERT INTO staff (name, pin, role) VALUES ('Waiter 1', '1111', 'waiter')");
      console.log('Created default staff');
    }

    console.log('✅ Database ready');
  } catch (err) {
    console.error('Database init error:', err);
    throw err;
  } finally {
    client.release();
  }
}

initDB().catch(console.error);

module.exports = pool;