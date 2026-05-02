const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const pool = require('./db/database');

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

app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tables ORDER BY table_number');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tables/:id', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE tables SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tables/:id/plan', async (req, res) => {
  try {
    const { pos_x, pos_y, shape, width, height, name, capacity, table_number } = req.body;
    await pool.query(
      'UPDATE tables SET pos_x=$1, pos_y=$2, shape=$3, width=$4, height=$5, name=$6, capacity=$7, table_number=$8 WHERE id=$9',
      [pos_x, pos_y, shape, width, height, name, capacity, table_number, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables', async (req, res) => {
  try {
    const { table_number, capacity, pos_x, pos_y, shape } = req.body;
    const result = await pool.query(
      'INSERT INTO tables (table_number, capacity, pos_x, pos_y, shape) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [table_number, capacity || 4, pos_x || 0, pos_y || 0, shape || 'square']
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tables/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tables WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// CATEGORIES ROUTES
// ─────────────────────────────────────────────

app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY sort_order');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/categories/:id/bar', async (req, res) => {
  try {
    const { is_bar } = req.body;
    await pool.query('UPDATE categories SET is_bar = $1 WHERE id = $2', [is_bar, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SUBCATEGORY ROUTES
// ─────────────────────────────────────────────

app.get('/api/subcategories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subcategories ORDER BY category_id, sort_order');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/subcategories', async (req, res) => {
  try {
    const { category_id, name } = req.body;
    const result = await pool.query(
      'INSERT INTO subcategories (category_id, name) VALUES ($1,$2) RETURNING id',
      [category_id, name]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/subcategories/:id', async (req, res) => {
  try {
    await pool.query('UPDATE menu_items SET subcategory_id = NULL WHERE subcategory_id = $1', [req.params.id]);
    await pool.query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// MENU ROUTES
// ─────────────────────────────────────────────

app.get('/api/menu', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items WHERE is_available = 1')
    ]);
    const result = catRes.rows.map(cat => ({
      ...cat,
      subcategories: subRes.rows.filter(s => s.category_id === cat.id),
      items: itemRes.rows.filter(i => i.category_id === cat.id)
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu/all', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items')
    ]);
    const result = catRes.rows.map(cat => ({
      ...cat,
      subcategories: subRes.rows.filter(s => s.category_id === cat.id),
      items: itemRes.rows.filter(i => i.category_id === cat.id)
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/items', async (req, res) => {
  try {
    const { category_id, subcategory_id, name, description, price } = req.body;
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, subcategory_id, name, description, price) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [category_id, subcategory_id || null, name, description, price]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/menu/items/:id', async (req, res) => {
  try {
    const { name, description, price, is_available, subcategory_id, category_id } = req.body;
    await pool.query(
      'UPDATE menu_items SET name=$1, description=$2, price=$3, is_available=$4, subcategory_id=$5, category_id=$6 WHERE id=$7',
      [name, description, price, is_available, subcategory_id || null, category_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu/items/:id/modifiers', async (req, res) => {
  try {
    const groupRes = await pool.query('SELECT * FROM modifier_groups WHERE menu_item_id = $1', [req.params.id]);
    if (groupRes.rows.length === 0) return res.json([]);
    const groupsWithMods = await Promise.all(groupRes.rows.map(async group => {
      const modRes = await pool.query('SELECT * FROM modifiers WHERE group_id = $1 AND is_available = 1', [group.id]);
      return { ...group, modifiers: modRes.rows };
    }));
    res.json(groupsWithMods);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/items/:id/modifiers', async (req, res) => {
  try {
    const { name, required, multi_select } = req.body;
    const result = await pool.query(
      'INSERT INTO modifier_groups (menu_item_id, name, required, multi_select) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.id, name, required ? 1 : 0, multi_select ? 1 : 0]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/modifier-groups/:id/options', async (req, res) => {
  try {
    const { name, extra_price } = req.body;
    const result = await pool.query(
      'INSERT INTO modifiers (group_id, name, extra_price) VALUES ($1,$2,$3) RETURNING id',
      [req.params.id, name, extra_price || 0]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/modifier-groups/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM modifiers WHERE group_id = $1', [req.params.id]);
    await pool.query('DELETE FROM modifier_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/modifiers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM modifiers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// ORDERS ROUTES
// ─────────────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT orders.*, tables.table_number 
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id 
       WHERE orders.status = 'open' ORDER BY orders.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/bar', async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT orders.*, tables.table_number FROM orders 
       LEFT JOIN tables ON orders.table_id = tables.id 
       WHERE orders.status = 'open' ORDER BY orders.created_at DESC`
    );
    const orders = ordersRes.rows;
    if (!orders.length) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name, categories.is_bar
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ANY($1)
       AND order_items.voided = 0
       AND order_items.status != 'served'
       AND categories.is_bar = 1`,
      [orderIds]
    );

    const result = orders
      .map(order => ({ ...order, items: itemsRes.rows.filter(i => i.order_id === order.id) }))
      .filter(o => o.items.length > 0);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number FROM orders 
       LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`,
      [req.params.id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name, menu_items.category_id, categories.is_bar
       FROM order_items 
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order, items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { table_id, covers } = req.body;
    const result = await pool.query(
      "INSERT INTO orders (table_id, status, covers, opened_at) VALUES ($1, 'open', $2, NOW()) RETURNING id",
      [table_id, covers || 1]
    );
    await pool.query("UPDATE tables SET status = 'occupied' WHERE id = $1", [table_id]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/:id/items', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { items } = req.body;
    const orderId = req.params.id;

    for (const item of items) {
      const isBar = item.is_bar ? 1 : 0;
      const firedAt = isBar ? new Date().toISOString() : null;
      await client.query(
        `INSERT INTO order_items 
         (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at) 
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orderId, item.menu_item_id, item.quantity, item.unit_price,
         item.notes || '', item.course || 1, item.item_note || '',
         isBar, firedAt, firedAt]
      );
    }

    const totalRes = await client.query(
      'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id = $1 AND voided = 0',
      [orderId]
    );
    const total = totalRes.rows[0].total || 0;
    await client.query('UPDATE orders SET total = $1 WHERE id = $2', [total, orderId]);
    await client.query('COMMIT');

    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const newItemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name FROM order_items 
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id = $1 AND order_items.is_fired = 1 AND order_items.status = 'cooking'`,
      [orderId]
    );
    io.emit('new_order_items', { order: orderRes.rows[0], items: newItemsRes.rows });
    res.json({ success: true, total });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/orders/:id/fire-course/:course', async (req, res) => {
  try {
    const { id, course } = req.params;
    const now = new Date().toISOString();
    const result = await pool.query(
      `UPDATE order_items SET is_fired=1, fired_at=$1, status='cooking', cooking_started_at=$2
       WHERE order_id=$3 AND course=$4 AND is_fired=0 AND voided=0
       AND menu_item_id IN (
         SELECT menu_items.id FROM menu_items
         LEFT JOIN categories ON menu_items.category_id = categories.id
         WHERE categories.is_bar = 0 OR categories.is_bar IS NULL
       )`,
      [now, now, id, course]
    );
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number FROM orders 
       LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [id]
    );
    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id = $1 AND order_items.course = $2 AND order_items.is_fired = 1`,
      [id, course]
    );
    io.emit('course_fired', { order: orderRes.rows[0], course: Number(course), items: itemsRes.rows });
    res.json({ success: true, changes: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const now = new Date().toISOString();
    const itemRes = await pool.query('SELECT * FROM order_items WHERE id = $1', [req.params.id]);
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const cooking_started_at = item.cooking_started_at || now;
    const served_at = status === 'served' ? now : item.served_at;
    await pool.query(
      'UPDATE order_items SET status=$1, cooking_started_at=$2, served_at=$3 WHERE id=$4',
      [status, cooking_started_at, served_at, req.params.id]
    );
    io.emit('item_status_changed', { item_id: req.params.id, status });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/void', async (req, res) => {
  try {
    const { reason } = req.body;
    await pool.query('UPDATE order_items SET voided=1, void_reason=$1 WHERE id=$2', [reason, req.params.id]);

    const itemRes = await pool.query('SELECT order_id FROM order_items WHERE id = $1', [req.params.id]);
    const item = itemRes.rows[0];
    if (item) {
      const totalRes = await pool.query(
        'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id=$1 AND voided=0',
        [item.order_id]
      );
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, item.order_id]);
      io.emit('item_voided', { item_id: req.params.id });

      const countRes = await pool.query(
        'SELECT COUNT(*) as remaining FROM order_items WHERE order_id=$1 AND voided=0',
        [item.order_id]
      );
      if (parseInt(countRes.rows[0].remaining) === 0) {
        await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [item.order_id]);
        const orderRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [item.order_id]);
        if (orderRes.rows[0]) {
          await pool.query("UPDATE tables SET status='available' WHERE id=$1", [orderRes.rows[0].table_id]);
        }
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/discount', async (req, res) => {
  try {
    const { discount_type, discount_value, discount_reason } = req.body;
    await pool.query(
      'UPDATE orders SET discount_type=$1, discount_value=$2, discount_reason=$3 WHERE id=$4',
      [discount_type, discount_value, discount_reason, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/:id/pay', async (req, res) => {
  try {
    const { amount, method } = req.body;
    const orderId = req.params.id;
    await pool.query('INSERT INTO payments (order_id, amount, method) VALUES ($1,$2,$3)', [orderId, amount, method]);
    await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [orderId]);
    const orderRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [orderId]);
    if (orderRes.rows[0]) {
      await pool.query("UPDATE tables SET status='available' WHERE id=$1", [orderRes.rows[0].table_id]);
    }
    io.emit('order_closed', { order_id: orderId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id/bill', async (req, res) => {
  try {
    const [orderRes, itemsRes, settingsRes] = await Promise.all([
      pool.query(
        `SELECT orders.*, tables.table_number FROM orders
         LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id=$1`, [req.params.id]
      ),
      pool.query(
        `SELECT order_items.*, menu_items.name FROM order_items
         LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
         WHERE order_items.order_id=$1 AND order_items.voided=0`, [req.params.id]
      ),
      pool.query('SELECT * FROM settings')
    ]);
    const settings = {};
    settingsRes.rows.forEach(r => settings[r.key] = r.value);
    res.json({ order: { ...orderRes.rows[0], items: itemsRes.rows }, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// STAFF ROUTES
// ─────────────────────────────────────────────

app.post('/api/staff/login', async (req, res) => {
  try {
    const { pin } = req.body;
    const result = await pool.query('SELECT * FROM staff WHERE pin=$1 AND is_active=1', [pin]);
    const staff = result.rows[0];
    if (!staff) return res.status(401).json({ error: 'Invalid PIN' });
    res.json({ id: staff.id, name: staff.name, role: staff.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, role, is_active, created_at FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', async (req, res) => {
  try {
    const { name, pin, role } = req.body;
    const result = await pool.query(
      'INSERT INTO staff (name, pin, role) VALUES ($1,$2,$3) RETURNING id', [name, pin, role]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, pin, role, is_active } = req.body;
    if (pin) {
      await pool.query('UPDATE staff SET name=$1, pin=$2, role=$3, is_active=$4 WHERE id=$5',
        [name, pin, role, is_active, req.params.id]);
    } else {
      await pool.query('UPDATE staff SET name=$1, role=$2, is_active=$3 WHERE id=$4',
        [name, role, is_active, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SETTINGS ROUTES
// ─────────────────────────────────────────────

app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// DISCOUNT REASONS ROUTES
// ─────────────────────────────────────────────

app.get('/api/discount-reasons', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM discount_reasons WHERE is_active=1');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/discount-reasons', async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await pool.query('INSERT INTO discount_reasons (reason) VALUES ($1) RETURNING id', [reason]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/discount-reasons/:id', async (req, res) => {
  try {
    await pool.query('UPDATE discount_reasons SET is_active=0 WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// REPORTS ROUTES
// ─────────────────────────────────────────────

app.get('/api/reports/daily', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT orders.id, orders.total, orders.closed_at, payments.method, tables.table_number
       FROM orders
       LEFT JOIN payments ON orders.id = payments.order_id
       LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.status='closed' AND orders.closed_at::date = $1::date
       ORDER BY orders.closed_at DESC`,
      [date]
    );
    const total = result.rows.reduce((sum, r) => sum + (r.total || 0), 0);
    res.json({ date, orders: result.rows, total_sales: total, order_count: result.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await pool.query(
      `SELECT orders.id, orders.total, orders.closed_at, orders.covers,
              orders.discount_value, orders.discount_type,
              payments.method, tables.table_number
       FROM orders
       LEFT JOIN payments ON orders.id = payments.order_id
       LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.status='closed'
       AND orders.closed_at::date >= $1::date AND orders.closed_at::date <= $2::date
       ORDER BY orders.closed_at DESC`,
      [from, to]
    );
    const rows = result.rows;
    const total_sales = rows.reduce((sum, r) => sum + (r.total || 0), 0);
    const total_covers = rows.reduce((sum, r) => sum + (r.covers || 0), 0);
    const by_method = {};
    rows.forEach(r => { if (r.method) by_method[r.method] = (by_method[r.method] || 0) + (r.total || 0); });
    res.json({ orders: rows, total_sales, order_count: rows.length, total_covers, by_method });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/items', async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await pool.query(
      `SELECT menu_items.name, menu_items.price,
              SUM(order_items.quantity) as qty_sold,
              SUM(order_items.quantity * order_items.unit_price) as total_revenue
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN orders ON order_items.order_id = orders.id
       WHERE orders.status='closed' AND order_items.voided=0
       AND orders.closed_at::date >= $1::date AND orders.closed_at::date <= $2::date
       GROUP BY menu_items.id, menu_items.name, menu_items.price
       ORDER BY qty_sold DESC`,
      [from, to]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// KITCHEN / BAR / TABLE STATUS
// ─────────────────────────────────────────────

app.get('/api/kitchen/completed', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_items.*, menu_items.name, orders.covers, orders.id as order_id,
              tables.table_number, order_items.fired_at, order_items.served_at
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       LEFT JOIN orders ON order_items.order_id = orders.id
       LEFT JOIN tables ON orders.table_id = tables.id
       WHERE order_items.status='served' AND order_items.voided=0
       AND (categories.is_bar=0 OR categories.is_bar IS NULL)
       AND order_items.served_at::date = CURRENT_DATE
       ORDER BY order_items.order_id ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/bill-printed', async (req, res) => {
  try {
    await pool.query('UPDATE orders SET bill_printed=1 WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tables/status', async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT orders.*, tables.table_number, tables.id as table_id
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.status='open'`
    );
    const orders = ordersRes.rows;
    if (!orders.length) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const itemsRes = await pool.query(
      `SELECT order_items.*, categories.is_bar
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       WHERE order_items.order_id = ANY($1) AND order_items.voided=0`,
      [orderIds]
    );

    const itemsByOrder = {};
    itemsRes.rows.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    });

    const result = orders.map(order => {
      const items = itemsByOrder[order.id] || [];
      const kitchenItems = items.filter(i => !i.is_bar);

     const starters = kitchenItems.filter(i => Number(i.course) === 1);
const startersFired = starters.some(i => i.is_fired);
const startersDone = starters.length > 0 && starters.every(i => i.status === 'served');

const mains = kitchenItems.filter(i => Number(i.course) === 2);
const mainsFired = mains.some(i => i.is_fired);
const mainsDone = mains.length > 0 && mains.every(i => i.status === 'served');

const desserts = kitchenItems.filter(i => Number(i.course) === 3);
const dessertsFired = desserts.some(i => i.is_fired);
const dessertsDone = desserts.length > 0 && desserts.every(i => i.status === 'served');

// Find the MOST RECENT course state
let colourStatus = 'occupied';
if (dessertsDone) colourStatus = 'desserts_done';
else if (dessertsFired) colourStatus = 'desserts_fired';
else if (mainsDone) colourStatus = 'mains_done';
else if (mainsFired) colourStatus = 'mains_fired';
else if (startersDone) colourStatus = 'starters_done';
else if (startersFired) colourStatus = 'starters_fired';

// Show White ONLY when bill printed AND every single kitchen item is served
const allKitchenServed = kitchenItems.length > 0 && 
  kitchenItems.every(i => i.status === 'served');
const noUnfiredItems = kitchenItems.every(i => i.is_fired);

if (order.bill_printed && allKitchenServed && noUnfiredItems) {
  colourStatus = 'bill_printed';
}
// If bill printed but food still not all served — keep course colour
// This means: Orange/Navy/Grey stays until ALL food is served

      return { ...order, colour_status: colourStatus };
    });

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bar/completed', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_items.*, menu_items.name, orders.covers, orders.id as order_id,
              tables.table_number, order_items.fired_at, order_items.served_at
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       LEFT JOIN categories ON menu_items.category_id = categories.id
       LEFT JOIN orders ON order_items.order_id = orders.id
       LEFT JOIN tables ON orders.table_id = tables.id
       WHERE order_items.status='served' AND order_items.voided=0
       AND categories.is_bar=1
       AND order_items.served_at::date = CURRENT_DATE
       ORDER BY order_items.order_id ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/move', async (req, res) => {
  try {
    const { new_table_id } = req.body;
    const orderId = req.params.id;
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const oldTableId = order.table_id;
    await pool.query('UPDATE orders SET table_id=$1 WHERE id=$2', [new_table_id, orderId]);
    await pool.query("UPDATE tables SET status='available' WHERE id=$1", [oldTableId]);
    await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [new_table_id]);
    io.emit('table_moved', { order_id: orderId, old_table_id: oldTableId, new_table_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/merge', async (req, res) => {
  try {
    const { merge_order_id } = req.body;
    const targetOrderId = req.params.id;
    await pool.query('UPDATE order_items SET order_id=$1 WHERE order_id=$2', [targetOrderId, merge_order_id]);
    const mergeRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [merge_order_id]);
    if (mergeRes.rows[0]) {
      await pool.query("UPDATE tables SET status='available' WHERE id=$1", [mergeRes.rows[0].table_id]);
    }
    await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [merge_order_id]);
    const totalRes = await pool.query(
      'SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id=$1 AND voided=0',
      [targetOrderId]
    );
    await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, targetOrderId]);
    io.emit('table_merged', { target_order_id: targetOrderId, merged_order_id: merge_order_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// Z REPORT ROUTES
// ─────────────────────────────────────────────

app.get('/api/z-report/preview', async (req, res) => {
  try {
    const { from, to } = req.query;
    const [ordersRes, openRes, voidsRes] = await Promise.all([
      pool.query(
        `SELECT orders.*, tables.table_number, payments.method, payments.amount as paid_amount
         FROM orders
         LEFT JOIN tables ON orders.table_id = tables.id
         LEFT JOIN payments ON orders.id = payments.order_id
         WHERE orders.status='closed'
         AND orders.closed_at >= $1::timestamp AND orders.closed_at <= $2::timestamp
         ORDER BY orders.closed_at DESC`,
        [from, to]
      ),
      pool.query(
        `SELECT orders.*, tables.table_number FROM orders
         LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='open'`
      ),
      pool.query(
        `SELECT COUNT(*) as void_count, SUM(order_items.unit_price * order_items.quantity) as void_value
         FROM order_items
         LEFT JOIN orders ON order_items.order_id = orders.id
         WHERE order_items.voided=1
         AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp`,
        [from, to]
      )
    ]);

    const orders = ordersRes.rows;
    const voids = voidsRes.rows[0];
    const totalSales = orders.reduce((s, o) => s + (o.total || 0), 0);
    const totalCovers = orders.reduce((s, o) => s + (o.covers || 0), 0);
    const totalCash = orders.filter(o => o.method === 'Cash').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalCard = orders.filter(o => o.method === 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalOther = orders.filter(o => o.method !== 'Cash' && o.method !== 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalDiscounts = orders.reduce((s, o) => {
      if (!o.discount_value) return s;
      return s + (o.discount_type === 'percent' ? (o.total || 0) * (o.discount_value / 100) : o.discount_value);
    }, 0);

    res.json({
      orders, open_orders: openRes.rows,
      total_sales: totalSales, total_covers: totalCovers,
      total_orders: orders.length, total_cash: totalCash,
      total_card: totalCard, total_other: totalOther,
      total_discounts: totalDiscounts,
      void_count: voids?.void_count || 0,
      void_value: voids?.void_value || 0,
      avg_per_cover: totalCovers > 0 ? totalSales / totalCovers : 0,
      avg_per_order: orders.length > 0 ? totalSales / orders.length : 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/z-report/save', async (req, res) => {
  try {
    const { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference } = req.body;
    const result = await pool.query(
      `INSERT INTO z_reports (type, opened_at, closed_at, total_sales, total_cash, total_card, total_other, total_covers, total_orders, discounts, voids, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, report_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [type, from, to, data.total_sales, data.total_cash, data.total_card, data.total_other,
       data.total_covers, data.total_orders, data.total_discounts, data.void_count,
       float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, JSON.stringify(data)]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/z-report/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM z_reports ORDER BY closed_at DESC LIMIT 30');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// BILLS ROUTES
// ─────────────────────────────────────────────

app.get('/api/bills', async (req, res) => {
  try {
    const { from, to, method } = req.query;
    let query = `
      SELECT orders.id, orders.total, orders.covers, orders.closed_at,
             orders.discount_type, orders.discount_value, orders.discount_reason,
             tables.table_number, payments.method, payments.amount as paid_amount
      FROM orders
      LEFT JOIN tables ON orders.table_id = tables.id
      LEFT JOIN payments ON orders.id = payments.order_id
      WHERE orders.status='closed' AND orders.total > 0
      AND payments.method IS NOT NULL AND payments.method != 'cancelled'
    `;
    const params = [];
    let n = 1;
    if (from) { query += ` AND orders.closed_at::date >= $${n}::date`; params.push(from); n++; }
    if (to) { query += ` AND orders.closed_at::date <= $${n}::date`; params.push(to); n++; }
    if (method && method !== 'all') { query += ` AND payments.method = $${n}`; params.push(method); n++; }
    query += ' ORDER BY orders.closed_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bills/:id/items', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_items.*, menu_items.name FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id=$1 AND order_items.voided=0
       ORDER BY order_items.course ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Resend items to kitchen
app.post('/api/orders/:id/resend', async (req, res) => {
  try {
    const { item_ids } = req.body;
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE order_items SET status='cooking', fired_at=$1, cooking_started_at=$1 
       WHERE id = ANY($2::int[])`,
      [now, item_ids]
    );
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number FROM orders 
       LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`,
      [req.params.id]
    );
    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.id = ANY($1::int[])`,
      [item_ids]
    );
    io.emit('course_fired', { order: orderRes.rows[0], course: 0, items: itemsRes.rows });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Screen connected:', socket.id);
  socket.on('disconnect', () => console.log('Screen disconnected:', socket.id));
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('✅ EPOS server is running on port ' + PORT);
  console.log('');
});