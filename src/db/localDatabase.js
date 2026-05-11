// SQLite backend for SiamEPOS Pro local/offline mode.
// Mirrors the pg.Pool interface (query, connect) so src/server.js stays unchanged.
//
// Translation handled:
//   $1, $2 ...                  → ?
//   NOW()                       → CURRENT_TIMESTAMP
//   col::date  /  $N::date      → date(col)  /  date(?)
//   col::timestamp / $N::ts     → datetime(col) / datetime(?)
//   = ANY($N::int[])            → IN (?,?,...) with the array flattened into params
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
      height INTEGER DEFAULT 80
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_bar INTEGER DEFAULT 0,
      default_course INTEGER DEFAULT 1
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
      allergens TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      vat_rate REAL DEFAULT 20.0
    );

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      required INTEGER DEFAULT 0,
      multi_select INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS modifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES modifier_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      extra_price REAL DEFAULT 0,
      is_available INTEGER DEFAULT 1
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
      bill_printed INTEGER DEFAULT 0,
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      void_reason TEXT,
      void_type TEXT,
      discount_type TEXT,
      discount_value REAL,
      resend_reason TEXT
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
      report_data TEXT,
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

    -- SEPOS — sync engine state (e.g. cursor for closed-orders pull)
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Offline action queue (Phase 3 consumer)
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT,
      payload TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced INTEGER DEFAULT 0,
      synced_at TIMESTAMP
    );
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
  // SEPOS-024: resend reason on order_items
  addColumnIfMissing('order_items', 'resend_reason', 'TEXT');
  // SEPOS-023: void type on order_items
  addColumnIfMissing('order_items', 'void_type', 'TEXT');
  // SEPOS-030: staff attribution on orders
  addColumnIfMissing('orders', 'staff_id', 'INTEGER');
  // SEPOS-021: VAT rate per menu item
  addColumnIfMissing('menu_items', 'vat_rate', 'REAL DEFAULT 20.0');
  // SEPOS-033: marketing consent + unsubscribe (GDPR)
  addColumnIfMissing('reservations', 'marketing_consent', 'INTEGER DEFAULT 0');
  addColumnIfMissing('reservations', 'unsubscribed_at', 'TIMESTAMP');
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
  // `expr::date` → `date(expr)` (works for column refs and $N placeholders)
  out = out.replace(/([\w.]+|\$\d+)\s*::\s*date\b/gi, 'date($1)');
  // `expr::timestamp` → `datetime(expr)`
  out = out.replace(/([\w.]+|\$\d+)\s*::\s*timestamp\b/gi, 'datetime($1)');
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
async function query(text, params = []) {
  if (typeof text !== 'string') {
    // pg supports { text, values } config-object form; not exercised in server.js today.
    throw new Error('[db:local] config-object query form not supported');
  }
  const pre = preTranslate(text);
  const { sql, params: flat } = translateParams(pre, params || []);

  try {
    if (shouldReturnRows(sql)) {
      const rows = db.prepare(sql).all(...flat);
      return { rows, rowCount: rows.length };
    }
    const info = db.prepare(sql).run(...flat);
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
