const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// This creates the database file in your project folder
// If it already exists, it just opens it
const DB_PATH = path.join(__dirname, '../../restaurant.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Create all tables if they don't exist yet
db.serialize(() => {

  // TABLES — the physical tables in your restaurant
  db.run(`
    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL UNIQUE,
      name TEXT,
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'available'
    )
  `);

  // CATEGORIES — e.g. Starters, Mains, Drinks, Desserts
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // MENU ITEMS — every dish or drink you sell
  db.run(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      is_available INTEGER DEFAULT 1,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  // ORDERS — one order per table visit
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      total REAL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (table_id) REFERENCES tables(id)
    )
  `);

  // ORDER ITEMS — each dish inside an order
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      menu_item_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
    )
  `);

  // STAFF — waiters and admins
  db.run(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      role TEXT DEFAULT 'waiter',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // PAYMENTS — how each order was paid
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'cash',
      paid_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);

  // Seed some starter data so the app works straight away
  db.get("SELECT COUNT(*) as count FROM tables", (err, row) => {
    if (row && row.count === 0) {
      for (let i = 1; i <= 10; i++) {
        db.run(`INSERT INTO tables (table_number, capacity) VALUES (?, ?)`, [i, 4]);
      }
      console.log('Created 10 tables');
    }
  });

  db.get("SELECT COUNT(*) as count FROM categories", (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO categories (name, sort_order) VALUES ('Starters', 1)`);
      db.run(`INSERT INTO categories (name, sort_order) VALUES ('Mains', 2)`);
      db.run(`INSERT INTO categories (name, sort_order) VALUES ('Desserts', 3)`);
      db.run(`INSERT INTO categories (name, sort_order) VALUES ('Drinks', 4)`);
      console.log('Created starter categories');
    }
  });

  db.get("SELECT COUNT(*) as count FROM staff", (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO staff (name, pin, role) VALUES ('Admin', '0000', 'admin')`);
      db.run(`INSERT INTO staff (name, pin, role) VALUES ('Waiter 1', '1111', 'waiter')`);
      console.log('Created default staff — remember to change the PINs!');
    }
  });

});
// MODIFIER GROUPS — e.g. "Choose Meat", "Choose Size"
  db.run(`
    CREATE TABLE IF NOT EXISTS modifier_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      required INTEGER DEFAULT 1,
      multi_select INTEGER DEFAULT 0,
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
    )
  `);

  // MODIFIERS — e.g. Chicken, Beef, Prawn
  db.run(`
    CREATE TABLE IF NOT EXISTS modifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      extra_price REAL DEFAULT 0,
      is_available INTEGER DEFAULT 1,
      FOREIGN KEY (group_id) REFERENCES modifier_groups(id)
    )
  `);

  // ORDER ITEM MODIFIERS — records which options were chosen
  db.run(`
    CREATE TABLE IF NOT EXISTS order_item_modifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL,
      modifier_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      extra_price REAL DEFAULT 0,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id),
      FOREIGN KEY (modifier_id) REFERENCES modifiers(id)
    )
  `);
module.exports = db;