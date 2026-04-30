const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db/database');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────────
// TABLES ROUTES
// ─────────────────────────────────────────────

app.get('/api/tables', (req, res) => {
  db.all('SELECT * FROM tables ORDER BY table_number', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/api/tables/:id', (req, res) => {
  const { status } = req.body;
  db.run('UPDATE tables SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.put('/api/tables/:id/plan', (req, res) => {
  const { pos_x, pos_y, shape, width, height, name, capacity, table_number } = req.body;
  db.run(
    'UPDATE tables SET pos_x = ?, pos_y = ?, shape = ?, width = ?, height = ?, name = ?, capacity = ?, table_number = ? WHERE id = ?',
    [pos_x, pos_y, shape, width, height, name, capacity, table_number, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.post('/api/tables', (req, res) => {
  const { table_number, capacity, pos_x, pos_y, shape } = req.body;
  db.run(
    'INSERT INTO tables (table_number, capacity, pos_x, pos_y, shape) VALUES (?, ?, ?, ?, ?)',
    [table_number, capacity || 4, pos_x || 0, pos_y || 0, shape || 'square'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.delete('/api/tables/:id', (req, res) => {
  db.run('DELETE FROM tables WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────
// CATEGORIES ROUTES
// ─────────────────────────────────────────────

app.get('/api/categories', (req, res) => {
  db.all('SELECT * FROM categories ORDER BY sort_order', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/api/categories/:id/bar', (req, res) => {
  const { is_bar } = req.body;
  db.run('UPDATE categories SET is_bar = ? WHERE id = ?', [is_bar, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────
// SUBCATEGORY ROUTES
// ─────────────────────────────────────────────

app.get('/api/subcategories', (req, res) => {
  db.all('SELECT * FROM subcategories ORDER BY category_id, sort_order', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/subcategories', (req, res) => {
  const { category_id, name } = req.body;
  db.run('INSERT INTO subcategories (category_id, name) VALUES (?, ?)', [category_id, name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.delete('/api/subcategories/:id', (req, res) => {
  db.run('UPDATE menu_items SET subcategory_id = NULL WHERE subcategory_id = ?', [req.params.id], () => {
    db.run('DELETE FROM subcategories WHERE id = ?', [req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// ─────────────────────────────────────────────
// MENU ROUTES
// ─────────────────────────────────────────────

app.get('/api/menu', (req, res) => {
  db.all('SELECT * FROM categories ORDER BY sort_order', (err, categories) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM subcategories ORDER BY sort_order', (err, subcategories) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all('SELECT * FROM menu_items WHERE is_available = 1', (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        const result = categories.map(cat => ({
          ...cat,
          subcategories: subcategories.filter(s => s.category_id === cat.id),
          items: items.filter(item => item.category_id === cat.id)
        }));
        res.json(result);
      });
    });
  });
});

app.get('/api/menu/all', (req, res) => {
  db.all('SELECT * FROM categories ORDER BY sort_order', (err, categories) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM subcategories ORDER BY sort_order', (err, subcategories) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all('SELECT * FROM menu_items', (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        const result = categories.map(cat => ({
          ...cat,
          subcategories: subcategories.filter(s => s.category_id === cat.id),
          items: items.filter(item => item.category_id === cat.id)
        }));
        res.json(result);
      });
    });
  });
});

app.post('/api/menu/items', (req, res) => {
  const { category_id, subcategory_id, name, description, price } = req.body;
  db.run(
    'INSERT INTO menu_items (category_id, subcategory_id, name, description, price) VALUES (?, ?, ?, ?, ?)',
    [category_id, subcategory_id || null, name, description, price],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.put('/api/menu/items/:id', (req, res) => {
  const { name, description, price, is_available, subcategory_id, category_id } = req.body;
  db.run(
    'UPDATE menu_items SET name = ?, description = ?, price = ?, is_available = ?, subcategory_id = ?, category_id = ? WHERE id = ?',
    [name, description, price, is_available, subcategory_id || null, category_id, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.get('/api/menu/items/:id/modifiers', (req, res) => {
  db.all('SELECT * FROM modifier_groups WHERE menu_item_id = ?', [req.params.id], (err, groups) => {
    if (err) return res.status(500).json({ error: err.message });
    if (groups.length === 0) return res.json([]);
    let done = 0;
    groups.forEach(group => {
      db.all('SELECT * FROM modifiers WHERE group_id = ? AND is_available = 1', [group.id], (err, modifiers) => {
        group.modifiers = modifiers;
        done++;
        if (done === groups.length) res.json(groups);
      });
    });
  });
});

app.post('/api/menu/items/:id/modifiers', (req, res) => {
  const { name, required, multi_select } = req.body;
  db.run(
    'INSERT INTO modifier_groups (menu_item_id, name, required, multi_select) VALUES (?, ?, ?, ?)',
    [req.params.id, name, required ? 1 : 0, multi_select ? 1 : 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.post('/api/modifier-groups/:id/options', (req, res) => {
  const { name, extra_price } = req.body;
  db.run(
    'INSERT INTO modifiers (group_id, name, extra_price) VALUES (?, ?, ?)',
    [req.params.id, name, extra_price || 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.delete('/api/modifier-groups/:id', (req, res) => {
  db.run('DELETE FROM modifiers WHERE group_id = ?', [req.params.id], () => {
    db.run('DELETE FROM modifier_groups WHERE id = ?', [req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.delete('/api/modifiers/:id', (req, res) => {
  db.run('DELETE FROM modifiers WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────
// ORDERS ROUTES
// ─────────────────────────────────────────────

app.get('/api/orders', (req, res) => {
  db.all(
    `SELECT orders.*, tables.table_number 
     FROM orders 
     LEFT JOIN tables ON orders.table_id = tables.id 
     WHERE orders.status = 'open' 
     ORDER BY orders.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Bar orders
app.get('/api/orders/bar', (req, res) => {
  db.all(
    `SELECT orders.*, tables.table_number 
     FROM orders 
     LEFT JOIN tables ON orders.table_id = tables.id 
     WHERE orders.status = 'open' 
     ORDER BY orders.created_at DESC`,
    (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!orders || orders.length === 0) return res.json([]);
      let done = 0;
      const result = [];
      orders.forEach(order => {
        db.all(
          `SELECT order_items.*, menu_items.name, categories.is_bar
           FROM order_items
           LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
           LEFT JOIN categories ON menu_items.category_id = categories.id
           WHERE order_items.order_id = ? 
           AND order_items.voided = 0
           AND order_items.status != 'served'
           AND categories.is_bar = 1`,
          [order.id],
          (err, items) => {
            if (items && items.length > 0) result.push({ ...order, items });
            done++;
            if (done === orders.length) res.json(result);
          }
        );
      });
    }
  );
});

// Get one order
app.get('/api/orders/:id', (req, res) => {
db.get(
    `SELECT orders.*, tables.table_number FROM orders 
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE orders.id = ?`,
    [req.params.id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    db.all(
      `SELECT order_items.*, menu_items.name, menu_items.category_id,
              categories.is_bar
       FROM order_items 
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ?`,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...order, items });
      }
    );
  });
});

// Create order
app.post('/api/orders', (req, res) => {
  const { table_id, covers } = req.body;
 db.run(
    'INSERT INTO orders (table_id, status, covers, opened_at) VALUES (?, "open", ?, datetime("now"))',
    [table_id, covers || 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE tables SET status = "occupied" WHERE id = ?', [table_id]);
      res.json({ id: this.lastID, success: true });
    }
  );
});

// Add items to order
app.post('/api/orders/:id/items', (req, res) => {
  const { items } = req.body;
  const orderId = req.params.id;

  const stmt = db.prepare(
    `INSERT INTO order_items 
     (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  items.forEach(item => {
    const isBar = item.is_bar ? 1 : 0;
    const firedAt = isBar ? new Date().toISOString() : null;
    stmt.run([
      orderId, item.menu_item_id, item.quantity, item.unit_price,
      item.notes || '', item.course || 1, item.item_note || '',
      isBar, firedAt, firedAt
    ]);
  });

  stmt.finalize(() => {
    db.get(
      'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id = ? AND voided = 0',
      [orderId],
      (err, row) => {
        db.run('UPDATE orders SET total = ? WHERE id = ?', [row.total || 0, orderId]);
        db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, order) => {
          db.all(
            `SELECT order_items.*, menu_items.name 
             FROM order_items 
             LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
             LEFT JOIN categories ON menu_items.category_id = categories.id
             WHERE order_items.order_id = ? AND order_items.is_fired = 1 
             AND order_items.status = 'cooking'`,
            [orderId],
            (err, newItems) => {
              io.emit('new_order_items', { order, items: newItems });
            }
          );
        });
        res.json({ success: true, total: row.total });
      }
    );
  });
});

// Fire a course
app.put('/api/orders/:id/fire-course/:course', (req, res) => {
  const { id, course } = req.params;
  const now = new Date().toISOString();
  db.run(
    `UPDATE order_items SET is_fired = 1, fired_at = ?, status = 'cooking', cooking_started_at = ?
     WHERE order_id = ? AND course = ? AND is_fired = 0 AND voided = 0
     AND menu_item_id IN (
       SELECT menu_items.id FROM menu_items
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE categories.is_bar = 0 OR categories.is_bar IS NULL
     )`,
    [now, now, id, course],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(
        `SELECT orders.*, tables.table_number FROM orders 
         LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = ?`,
        [id],
        (err, order) => {
          db.all(
            `SELECT order_items.*, menu_items.name FROM order_items
             LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
             WHERE order_items.order_id = ? AND order_items.course = ? AND order_items.is_fired = 1`,
            [id, course],
            (err, items) => {
              io.emit('course_fired', { order, course: Number(course), items });
            }
          );
        }
      );
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Update item status
app.put('/api/order-items/:id/status', (req, res) => {
  const { status } = req.body;
  const now = new Date().toISOString();
  db.get('SELECT * FROM order_items WHERE id = ?', [req.params.id], (err, item) => {
    if (err) return res.status(500).json({ error: err.message });
    const cooking_started_at = item.cooking_started_at || now;
    const served_at = status === 'served' ? now : item.served_at;
    db.run(
      'UPDATE order_items SET status = ?, cooking_started_at = ?, served_at = ? WHERE id = ?',
      [status, cooking_started_at, served_at, req.params.id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('item_status_changed', { item_id: req.params.id, status });
        res.json({ success: true });
      }
    );
  });
});

// Void item
app.put('/api/order-items/:id/void', (req, res) => {
  const { reason } = req.body;
  db.run(
    'UPDATE order_items SET voided = 1, void_reason = ? WHERE id = ?',
    [reason, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT order_id FROM order_items WHERE id = ?', [req.params.id], (err, item) => {
        if (item) {
          db.get(
            'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id = ? AND voided = 0',
            [item.order_id],
            (err, row) => {
              db.run('UPDATE orders SET total = ? WHERE id = ?', [row.total || 0, item.order_id]);
              io.emit('item_voided', { item_id: req.params.id });
              db.get(
                'SELECT COUNT(*) as remaining FROM order_items WHERE order_id = ? AND voided = 0',
                [item.order_id],
                (err, count) => {
                  if (count && count.remaining === 0) {
                    db.run('UPDATE orders SET status = "closed", closed_at = datetime("now") WHERE id = ?', [item.order_id], () => {
                      db.get('SELECT table_id FROM orders WHERE id = ?', [item.order_id], (err, order) => {
                        if (order) db.run('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
                      });
                    });
                  }
                }
              );
            }
          );
        }
      });
      res.json({ success: true });
    }
  );
});

// Apply discount
app.put('/api/orders/:id/discount', (req, res) => {
  const { discount_type, discount_value, discount_reason } = req.body;
  db.run(
    'UPDATE orders SET discount_type = ?, discount_value = ?, discount_reason = ? WHERE id = ?',
    [discount_type, discount_value, discount_reason, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Pay order
app.post('/api/orders/:id/pay', (req, res) => {
  const { amount, method } = req.body;
  const orderId = req.params.id;
  db.run(
    'INSERT INTO payments (order_id, amount, method) VALUES (?, ?, ?)',
    [orderId, amount, method],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run(
        'UPDATE orders SET status = "closed", closed_at = datetime("now") WHERE id = ?',
        [orderId],
        () => {
          db.get('SELECT table_id FROM orders WHERE id = ?', [orderId], (err, order) => {
            if (order) db.run('UPDATE tables SET status = "available" WHERE id = ?', [order.table_id]);
          });
          io.emit('order_closed', { order_id: orderId });
          res.json({ success: true });
        }
      );
    }
  );
});

// Bill route
app.get('/api/orders/:id/bill', (req, res) => {
  db.get(
    `SELECT orders.*, tables.table_number FROM orders
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE orders.id = ?`,
    [req.params.id],
    (err, order) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(
        `SELECT order_items.*, menu_items.name
         FROM order_items
         LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
         WHERE order_items.order_id = ? AND order_items.voided = 0`,
        [req.params.id],
        (err, items) => {
          if (err) return res.status(500).json({ error: err.message });
          db.all('SELECT * FROM settings', (err, settingRows) => {
            const settings = {};
            settingRows.forEach(r => settings[r.key] = r.value);
            res.json({ order: { ...order, items }, settings });
          });
        }
      );
    }
  );
});

// ─────────────────────────────────────────────
// STAFF ROUTES
// ─────────────────────────────────────────────

app.post('/api/staff/login', (req, res) => {
  const { pin } = req.body;
  db.get('SELECT * FROM staff WHERE pin = ? AND is_active = 1', [pin], (err, staff) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!staff) return res.status(401).json({ error: 'Invalid PIN' });
    res.json({ id: staff.id, name: staff.name, role: staff.role });
  });
});

app.get('/api/staff', (req, res) => {
  db.all('SELECT id, name, role, is_active, created_at FROM staff ORDER BY name', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/staff', (req, res) => {
  const { name, pin, role } = req.body;
  db.run('INSERT INTO staff (name, pin, role) VALUES (?, ?, ?)', [name, pin, role], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.put('/api/staff/:id', (req, res) => {
  const { name, pin, role, is_active } = req.body;
  if (pin) {
    db.run('UPDATE staff SET name = ?, pin = ?, role = ?, is_active = ? WHERE id = ?',
      [name, pin, role, is_active, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
  } else {
    db.run('UPDATE staff SET name = ?, role = ?, is_active = ? WHERE id = ?',
      [name, role, is_active, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
  }
});

// ─────────────────────────────────────────────
// SETTINGS ROUTES
// ─────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  db.all('SELECT * FROM settings', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  Object.entries(updates).forEach(([key, value]) => stmt.run([key, value]));
  stmt.finalize(() => res.json({ success: true }));
});

// ─────────────────────────────────────────────
// DISCOUNT REASONS ROUTES
// ─────────────────────────────────────────────

app.get('/api/discount-reasons', (req, res) => {
  db.all('SELECT * FROM discount_reasons WHERE is_active = 1', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/discount-reasons', (req, res) => {
  const { reason } = req.body;
  db.run('INSERT INTO discount_reasons (reason) VALUES (?)', [reason], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.delete('/api/discount-reasons/:id', (req, res) => {
  db.run('UPDATE discount_reasons SET is_active = 0 WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────
// REPORTS ROUTES
// ─────────────────────────────────────────────

app.get('/api/reports/daily', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  db.all(
    `SELECT orders.id, orders.total, orders.closed_at, 
            payments.method, tables.table_number
     FROM orders
     LEFT JOIN payments ON orders.id = payments.order_id
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE orders.status = 'closed' 
     AND date(orders.closed_at) = ?
     ORDER BY orders.closed_at DESC`,
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = rows.reduce((sum, r) => sum + (r.total || 0), 0);
      res.json({ date, orders: rows, total_sales: total, order_count: rows.length });
    }
  );
});

app.get('/api/reports/summary', (req, res) => {
  const { from, to } = req.query;
  db.all(
    `SELECT orders.id, orders.total, orders.closed_at, orders.covers,
            orders.discount_value, orders.discount_type,
            payments.method, tables.table_number
     FROM orders
     LEFT JOIN payments ON orders.id = payments.order_id
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE orders.status = 'closed'
     AND date(orders.closed_at) >= ? AND date(orders.closed_at) <= ?
     ORDER BY orders.closed_at DESC`,
    [from, to],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const total_sales = rows.reduce((sum, r) => sum + (r.total || 0), 0);
      const total_covers = rows.reduce((sum, r) => sum + (r.covers || 0), 0);
      const by_method = {};
      rows.forEach(r => {
        if (r.method) by_method[r.method] = (by_method[r.method] || 0) + (r.total || 0);
      });
      res.json({ orders: rows, total_sales, order_count: rows.length, total_covers, by_method });
    }
  );
});

app.get('/api/reports/items', (req, res) => {
  const { from, to } = req.query;
  db.all(
    `SELECT menu_items.name, menu_items.price,
            SUM(order_items.quantity) as qty_sold,
            SUM(order_items.quantity * order_items.unit_price) as total_revenue
     FROM order_items
     LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
     LEFT JOIN orders ON order_items.order_id = orders.id
     WHERE orders.status = 'closed' AND order_items.voided = 0
     AND date(orders.closed_at) >= ? AND date(orders.closed_at) <= ?
     GROUP BY menu_items.id
     ORDER BY qty_sold DESC`,
    [from, to],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Screen connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Screen disconnected:', socket.id);
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
// Kitchen completed items today
app.get('/api/kitchen/completed', (req, res) => {
  db.all(
    `SELECT order_items.*, menu_items.name,
            orders.covers, orders.id as order_id,
            tables.table_number,
            order_items.fired_at, order_items.served_at
     FROM order_items
     LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
     LEFT JOIN categories ON menu_items.category_id = categories.id
     LEFT JOIN orders ON order_items.order_id = orders.id
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE order_items.status = 'served'
     AND order_items.voided = 0
     AND (categories.is_bar = 0 OR categories.is_bar IS NULL)
     AND date(order_items.served_at) = date('now')
     ORDER BY order_items.order_id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});
// Mark bill as printed
app.put('/api/orders/:id/bill-printed', (req, res) => {
  db.run('UPDATE orders SET bill_printed = 1 WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get table status with course info for colour coding
app.get('/api/tables/status', (req, res) => {
  db.all(
    `SELECT orders.*, tables.table_number, tables.id as table_id
     FROM orders
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE orders.status = 'open'`,
    (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!orders || orders.length === 0) return res.json([]);

      let done = 0;
      const result = [];

      orders.forEach(order => {
        db.all(
          `SELECT order_items.*, categories.is_bar
           FROM order_items
           LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
           LEFT JOIN categories ON menu_items.category_id = categories.id
           WHERE order_items.order_id = ? AND order_items.voided = 0`,
          [order.id],
          (err, items) => {
            // Filter non-bar items only
            const kitchenItems = items ? items.filter(i => !i.is_bar) : [];

            // Course 1 — Starters
            const starters = kitchenItems.filter(i => i.course === 1);
            const startersFired = starters.some(i => i.is_fired);
            const startersDone = starters.length > 0 && starters.every(i => i.status === 'served');

            // Course 2 — Mains
            const mains = kitchenItems.filter(i => i.course === 2);
            const mainsFired = mains.some(i => i.is_fired);
            const mainsDone = mains.length > 0 && mains.every(i => i.status === 'served');

            // Course 3 — Desserts
            const desserts = kitchenItems.filter(i => i.course === 3);
            const dessertsFired = desserts.some(i => i.is_fired);
            const dessertsDone = desserts.length > 0 && desserts.every(i => i.status === 'served');

            // Determine colour status — most advanced wins
            let colourStatus = 'occupied';
            if (order.bill_printed) colourStatus = 'bill_printed';
            else if (dessertsDone) colourStatus = 'desserts_done';
            else if (dessertsFired) colourStatus = 'desserts_fired';
            else if (mainsDone) colourStatus = 'mains_done';
            else if (mainsFired) colourStatus = 'mains_fired';
            else if (startersDone) colourStatus = 'starters_done';
            else if (startersFired) colourStatus = 'starters_fired';

            result.push({
              ...order,
              colour_status: colourStatus
            });

            done++;
            if (done === orders.length) res.json(result);
          }
        );
      });
    }
  );
});
// Bar completed items today
app.get('/api/bar/completed', (req, res) => {
  db.all(
    `SELECT order_items.*, menu_items.name,
            orders.covers, orders.id as order_id,
            tables.table_number,
            order_items.fired_at, order_items.served_at
     FROM order_items
     LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
     LEFT JOIN categories ON menu_items.category_id = categories.id
     LEFT JOIN orders ON order_items.order_id = orders.id
     LEFT JOIN tables ON orders.table_id = tables.id
     WHERE order_items.status = 'served'
     AND order_items.voided = 0
     AND categories.is_bar = 1
     AND date(order_items.served_at) = date('now')
     ORDER BY order_items.order_id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});
// Move table — move order to a different table
app.put('/api/orders/:id/move', (req, res) => {
  const { new_table_id } = req.body;
  const orderId = req.params.id;

  db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const oldTableId = order.table_id;

    db.run('UPDATE orders SET table_id = ? WHERE id = ?', [new_table_id, orderId], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Free old table
      db.run('UPDATE tables SET status = "available" WHERE id = ?', [oldTableId]);
      // Mark new table as occupied
      db.run('UPDATE tables SET status = "occupied" WHERE id = ?', [new_table_id]);

      io.emit('table_moved', { order_id: orderId, old_table_id: oldTableId, new_table_id });
      res.json({ success: true });
    });
  });
});

// Merge table — merge one order into another
app.put('/api/orders/:id/merge', (req, res) => {
  const { merge_order_id } = req.body;
  const targetOrderId = req.params.id;

  // Move all items from merge_order into target order
  db.run(
    'UPDATE order_items SET order_id = ? WHERE order_id = ?',
    [targetOrderId, merge_order_id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Get merge order table to free it
      db.get('SELECT table_id FROM orders WHERE id = ?', [merge_order_id], (err, mergeOrder) => {
        if (mergeOrder) {
          db.run('UPDATE tables SET status = "available" WHERE id = ?', [mergeOrder.table_id]);
        }

        // Close the merged order
        db.run(
          'UPDATE orders SET status = "closed", closed_at = datetime("now") WHERE id = ?',
          [merge_order_id],
          (err) => {
            // Recalculate target order total
            db.get(
              'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id = ? AND voided = 0',
              [targetOrderId],
              (err, row) => {
                db.run('UPDATE orders SET total = ? WHERE id = ?', [row.total || 0, targetOrderId]);
                io.emit('table_merged', { target_order_id: targetOrderId, merged_order_id: merge_order_id });
                res.json({ success: true });
              }
            );
          }
        );
      });
    }
  );
});
// ─────────────────────────────────────────────
// Z REPORT ROUTES
// ─────────────────────────────────────────────

// Get Z report preview data
app.get('/api/z-report/preview', (req, res) => {
  const { from, to } = req.query;

  db.all(
    `SELECT orders.*, tables.table_number, payments.method, payments.amount as paid_amount
     FROM orders
     LEFT JOIN tables ON orders.table_id = tables.id
     LEFT JOIN payments ON orders.id = payments.order_id
     WHERE orders.status = 'closed'
     AND datetime(orders.closed_at) >= datetime(?)
     AND datetime(orders.closed_at) <= datetime(?)
     ORDER BY orders.closed_at DESC`,
    [from, to],
    (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });

      // Get open tables
      db.all(
        `SELECT orders.*, tables.table_number FROM orders
         LEFT JOIN tables ON orders.table_id = tables.id
         WHERE orders.status = 'open'`,
        [],
        (err, openOrders) => {
          if (err) return res.status(500).json({ error: err.message });

          // Get voids
          db.get(
            `SELECT COUNT(*) as void_count, SUM(order_items.unit_price * order_items.quantity) as void_value
             FROM order_items
             LEFT JOIN orders ON order_items.order_id = orders.id
             WHERE order_items.voided = 1
             AND datetime(orders.created_at) >= datetime(?)
             AND datetime(orders.created_at) <= datetime(?)`,
            [from, to],
            (err, voids) => {

              const totalSales = orders.reduce((s, o) => s + (o.total || 0), 0);
              const totalCovers = orders.reduce((s, o) => s + (o.covers || 0), 0);
              const totalCash = orders.filter(o => o.method === 'Cash').reduce((s, o) => s + (o.paid_amount || 0), 0);
              const totalCard = orders.filter(o => o.method === 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
              const totalOther = orders.filter(o => o.method !== 'Cash' && o.method !== 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
              const totalDiscounts = orders.reduce((s, o) => {
                if (!o.discount_value) return s;
                const disc = o.discount_type === 'percent'
                  ? (o.total || 0) * (o.discount_value / 100)
                  : o.discount_value;
                return s + disc;
              }, 0);

              res.json({
                orders,
                open_orders: openOrders,
                total_sales: totalSales,
                total_covers: totalCovers,
                total_orders: orders.length,
                total_cash: totalCash,
                total_card: totalCard,
                total_other: totalOther,
                total_discounts: totalDiscounts,
                void_count: voids?.void_count || 0,
                void_value: voids?.void_value || 0,
                avg_per_cover: totalCovers > 0 ? totalSales / totalCovers : 0,
                avg_per_order: orders.length > 0 ? totalSales / orders.length : 0,
              });
            }
          );
        }
      );
    }
  );
});

// Save Z report
app.post('/api/z-report/save', (req, res) => {
  const { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference } = req.body;
  db.run(
    `INSERT INTO z_reports (type, opened_at, closed_at, total_sales, total_cash, total_card, total_other, total_covers, total_orders, discounts, voids, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, report_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, from, to, data.total_sales, data.total_cash, data.total_card, data.total_other, data.total_covers, data.total_orders, data.total_discounts, data.void_count, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, JSON.stringify(data)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

// Get Z report history
app.get('/api/z-report/history', (req, res) => {
  db.all('SELECT * FROM z_reports ORDER BY closed_at DESC LIMIT 30', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
// Bills record
app.get('/api/bills', (req, res) => {
  const { from, to, method } = req.query;
  let query = `
    SELECT orders.id, orders.total, orders.covers, orders.closed_at,
           orders.discount_type, orders.discount_value, orders.discount_reason,
           tables.table_number, payments.method, payments.amount as paid_amount
    FROM orders
    LEFT JOIN tables ON orders.table_id = tables.id
    LEFT JOIN payments ON orders.id = payments.order_id
    WHERE orders.status = 'closed'
    AND orders.total > 0
    AND payments.method IS NOT NULL
    AND payments.method != 'cancelled'
  `;
  const params = [];
  if (from) { query += ` AND date(orders.closed_at) >= ?`; params.push(from); }
  if (to) { query += ` AND date(orders.closed_at) <= ?`; params.push(to); }
  if (method && method !== 'all') { query += ` AND payments.method = ?`; params.push(method); }
  query += ` ORDER BY orders.closed_at DESC`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});
// Get items for a specific bill
app.get('/api/bills/:id/items', (req, res) => {
  db.all(
    `SELECT order_items.*, menu_items.name
     FROM order_items
     LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
     WHERE order_items.order_id = ? AND order_items.voided = 0
     ORDER BY order_items.course ASC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

const PORT = 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('EPOS server is running!');
  console.log(`Open your browser at: http://localhost:${PORT}`);
  console.log('');
});