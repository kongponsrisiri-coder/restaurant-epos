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
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Optional: email + SMS services (won't crash if not set up yet)
let sendBookingConfirmation = async () => {};
let sendBookingSms = async () => {};
try {
  const emailSvc = require('./services/emailService');
  sendBookingConfirmation = emailSvc.sendBookingConfirmation;
  console.log('✅ Email service loaded');
} catch (e) {
  console.log('ℹ️  Email service not configured yet — skipping');
}

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

app.put('/api/categories/:id/default-course', async (req, res) => {
  try {
    const { default_course } = req.body;
    await pool.query('UPDATE categories SET default_course = $1 WHERE id = $2', [default_course, req.params.id]);
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
// MENU ROUTES — includes name_alt
// ─────────────────────────────────────────────

app.get('/api/menu', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items WHERE is_available = 1 ORDER BY sort_order ASC')
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
      pool.query('SELECT * FROM menu_items ORDER BY sort_order ASC')
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
    const { category_id, subcategory_id, name, name_alt, description, price } = req.body;
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, subcategory_id, name, name_alt, description, price) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [category_id, subcategory_id || null, name, name_alt || null, description, price]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ MUST BE BEFORE /:id — otherwise Express treats "sort-order" as an id
app.put('/api/menu/items/sort-order', async (req, res) => {
  try {
    const { items } = req.body;
    for (const item of items) {
      await pool.query(
        'UPDATE menu_items SET sort_order = $1 WHERE id = $2',
        [item.sort_order, item.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/menu/items/:id', async (req, res) => {
  try {
    const { name, name_alt, description, price, is_available, subcategory_id, category_id } = req.body;
    await pool.query(
      'UPDATE menu_items SET name=$1, name_alt=$2, description=$3, price=$4, is_available=$5, subcategory_id=$6, category_id=$7 WHERE id=$8',
      [name, name_alt || null, description, price, is_available, subcategory_id || null, category_id, req.params.id]
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

app.delete('/api/menu/items/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE order_items 
       SET item_name = COALESCE(item_name, (
         SELECT name FROM menu_items WHERE id = $1
       )),
       menu_item_id = NULL
       WHERE menu_item_id = $1`,
      [req.params.id]
    );
    await pool.query(
      'DELETE FROM modifiers WHERE group_id IN (SELECT id FROM modifier_groups WHERE menu_item_id = $1)',
      [req.params.id]
    );
    await pool.query('DELETE FROM modifier_groups WHERE menu_item_id = $1', [req.params.id]);
    await pool.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, categories.is_bar
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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, menu_items.category_id, categories.is_bar
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
      const nameRes = await client.query(
        'SELECT name FROM menu_items WHERE id = $1',
        [item.menu_item_id]
      );
      const itemName = nameRes.rows[0]?.name || item.name || 'Unknown item';
      await client.query(
        `INSERT INTO order_items 
         (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at, item_name) 
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId, item.menu_item_id, item.quantity, item.unit_price,
         item.notes || '', item.course || 1, item.item_note || '',
         isBar, firedAt, firedAt, itemName]
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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items 
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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items
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
        `SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items
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
    const result = await pool.query('SELECT id, name, role, is_active, created_at, start_date, notes, employment_status FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', async (req, res) => {
  try {
    const { name, pin, role, start_date, notes, employment_status } = req.body;
    const result = await pool.query(
      'INSERT INTO staff (name, pin, role, start_date, notes, employment_status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, pin, role, start_date || null, notes || null, employment_status || 'active']
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, pin, role, is_active, start_date, notes, employment_status } = req.body;
    if (pin) {
      await pool.query(
        'UPDATE staff SET name=$1, pin=$2, role=$3, is_active=$4, start_date=$5, notes=$6, employment_status=$7 WHERE id=$8',
        [name, pin, role, is_active, start_date || null, notes || null, employment_status || 'active', req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE staff SET name=$1, role=$2, is_active=$3, start_date=$4, notes=$5, employment_status=$6 WHERE id=$7',
        [name, role, is_active, start_date || null, notes || null, employment_status || 'active', req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id,
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

      const hasFiredItems = kitchenItems.some(i => i.is_fired);

      let colourStatus = 'occupied';
      if (dessertsDone) colourStatus = 'desserts_done';
      else if (dessertsFired) colourStatus = 'desserts_fired';
      else if (mainsDone) colourStatus = 'mains_done';
      else if (mainsFired) colourStatus = 'mains_fired';
      else if (startersDone) colourStatus = 'starters_done';
      else if (startersFired) colourStatus = 'starters_fired';

      if (order.bill_printed && !hasFiredItems) {
        colourStatus = 'bill_printed';
      }

      return { ...order, colour_status: colourStatus };
    });

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bar/completed', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id,
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
      `SELECT order_items.*,
       COALESCE(menu_items.name, order_items.item_name, 'Deleted item') AS name
       FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id=$1 AND order_items.voided=0
       ORDER BY order_items.course ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      `SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items
       LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.id = ANY($1::int[])`,
      [item_ids]
    );
    io.emit('course_fired', { order: orderRes.rows[0], course: 0, items: itemsRes.rows });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/discount', async (req, res) => {
  try {
    const { discount_type, discount_value } = req.body;
    await pool.query(
      'UPDATE order_items SET discount_type=$1, discount_value=$2 WHERE id=$3',
      [discount_type, discount_value, req.params.id]
    );
    const itemRes = await pool.query('SELECT order_id FROM order_items WHERE id=$1', [req.params.id]);
    if (itemRes.rows[0]) {
      const totalRes = await pool.query(
        `SELECT SUM(
          CASE 
            WHEN discount_type = 'percent' THEN quantity * unit_price * (1 - COALESCE(discount_value,0)/100)
            WHEN discount_type = 'fixed' THEN GREATEST(0, quantity * unit_price - COALESCE(discount_value,0))
            ELSE quantity * unit_price
          END
        ) as total FROM order_items WHERE order_id=$1 AND voided=0`,
        [itemRes.rows[0].order_id]
      );
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2',
        [totalRes.rows[0].total || 0, itemRes.rows[0].order_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// RESERVATIONS — WIDGET PUBLIC API
// ─────────────────────────────────────────────

const widgetCors = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
};

app.get('/api/reservations/availability', widgetCors, async (req, res) => {
  try {
    const { date, covers = 2, restaurant_id = 'siamepos' } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    const coversNum = parseInt(covers, 10);
    if (isNaN(coversNum) || coversNum < 1) return res.status(400).json({ error: 'covers must be a positive number' });
    const settingsRes = await pool.query('SELECT * FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]);
    const s = settingsRes.rows[0] || {
      opening_time: '11:00', last_booking_time: '21:30',
      slot_interval_mins: 15, max_covers_per_slot: 20,
      booking_lead_hours: 1, booking_advance_days: 60,
    };
    const requestedDate = new Date(date + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + (s.booking_advance_days || 60));
    if (requestedDate < today) return res.json({ slots: [], message: 'Date is in the past' });
    if (requestedDate > maxDate) return res.json({ slots: [], message: 'Date too far in advance' });
    const [openH, openM]   = String(s.opening_time).slice(0,5).split(':').map(Number);
    const [closeH, closeM] = String(s.last_booking_time).slice(0,5).split(':').map(Number);
    const interval = s.slot_interval_mins || 15;
    const slots = [];
    let cur = openH * 60 + openM;
    const end = closeH * 60 + closeM;
    while (cur <= end) {
      const h = Math.floor(cur / 60), m = cur % 60;
      slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
      cur += interval;
    }
    const bookingsRes = await pool.query(
      `SELECT TO_CHAR(reservation_time, 'HH24:MI') AS time_str, SUM(covers) AS booked_covers
       FROM reservations
       WHERE reservation_date = $1 AND restaurant_id = $2
         AND status NOT IN ('cancelled','no-show')
       GROUP BY time_str`,
      [date, restaurant_id]
    );
    const bookedMap = {};
    bookingsRes.rows.forEach(r => { bookedMap[r.time_str] = parseInt(r.booked_covers, 10); });
    const isToday = requestedDate.toDateString() === new Date().toDateString();
    const nowMins = isToday ? (new Date().getHours() * 60 + new Date().getMinutes() + (s.booking_lead_hours || 1) * 60) : -1;
    const result = slots.map(time => {
      const [h, m] = time.split(':').map(Number);
      const slotMins = h * 60 + m;
      const booked = bookedMap[time] || 0;
      const remaining = (s.max_covers_per_slot || 20) - booked;
      const pastCutoff = isToday && slotMins < nowMins;
      return { time, available: !pastCutoff && remaining >= coversNum, remaining_covers: Math.max(0, remaining), past: pastCutoff };
    });
    res.json({ date, covers: coversNum, restaurant_id, slots: result });
  } catch (err) {
    console.error('GET /api/reservations/availability error:', err);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

app.get('/api/reservations/settings/:restaurantId', widgetCors, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT restaurant_id, restaurant_name, brand_colour,
              TO_CHAR(opening_time, 'HH24:MI')      AS opening_time,
              TO_CHAR(last_booking_time, 'HH24:MI') AS last_booking_time,
              slot_interval_mins, max_covers_per_slot,
              booking_lead_hours, booking_advance_days, is_active
       FROM restaurant_settings WHERE restaurant_id = $1`,
      [req.params.restaurantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
    const s = result.rows[0];
    if (!s.is_active) return res.status(403).json({ error: 'Online booking is currently disabled' });
    res.json(s);
  } catch (err) {
    console.error('GET /api/reservations/settings error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    const { date, status, restaurant_id = 'siamepos' } = req.query;
    let query = `
      SELECT r.*,
             TO_CHAR(r.reservation_date, 'YYYY-MM-DD') AS reservation_date,
             TO_CHAR(r.reservation_time, 'HH24:MI')    AS reservation_time,
             t.name AS table_name
      FROM reservations r
      LEFT JOIN tables t ON r.table_id = t.id
      WHERE r.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND r.reservation_date = $${params.length}`; }
    if (status && status !== 'all') { params.push(status); query += ` AND r.status = $${params.length}`; }
    query += ' ORDER BY r.reservation_date ASC, r.reservation_time ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations', widgetCors, async (req, res) => {
  try {
    const {
      restaurant_id = 'siamepos', customer_name, customer_phone, customer_email,
      covers, reservation_date, reservation_time, notes,
      source = 'widget', table_id = null, status = 'pending',
    } = req.body;
    const safeStatus = 'pending';
    if (!customer_name?.trim()) return res.status(400).json({ error: 'Guest name is required' });
    if (!customer_phone?.trim()) return res.status(400).json({ error: 'Phone number is required' });
    if (!reservation_date) return res.status(400).json({ error: 'Date is required' });
    if (!reservation_time) return res.status(400).json({ error: 'Time is required' });
    const coversNum = parseInt(covers, 10);
    if (!coversNum || coversNum < 1) return res.status(400).json({ error: 'Covers must be at least 1' });
    const slotCheck = await pool.query(
      `SELECT COALESCE(SUM(covers), 0) AS booked
       FROM reservations
       WHERE reservation_date = $1
         AND TO_CHAR(reservation_time, 'HH24:MI') = $2
         AND restaurant_id = $3
         AND status NOT IN ('cancelled','no-show')`,
      [reservation_date, reservation_time.slice(0,5), restaurant_id]
    );
    const settingsRes = await pool.query(
      'SELECT max_covers_per_slot FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]
    );
    const maxCovers = settingsRes.rows[0]?.max_covers_per_slot || 20;
    const alreadyBooked = parseInt(slotCheck.rows[0]?.booked || 0, 10);
    if (alreadyBooked + coversNum > maxCovers) {
      return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
    }
    const insertStatus = source === 'widget' ? 'pending' : (status || 'pending');
    const result = await pool.query(
      `INSERT INTO reservations
         (restaurant_id, table_id, customer_name, customer_phone, customer_email,
          covers, reservation_date, reservation_time, status, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [restaurant_id, table_id, customer_name.trim(), customer_phone.trim(),
       customer_email?.trim() || null, coversNum, reservation_date,
       reservation_time, insertStatus, notes?.trim() || null, source]
    );
    const reservation = result.rows[0];
    io.emit('new_reservation', {
      ...reservation,
      reservation_date: String(reservation.reservation_date).split('T')[0],
      reservation_time: String(reservation.reservation_time).slice(0,5),
    });
    if (customer_email) sendBookingConfirmation(reservation).catch(err => console.error('❌ Email error:', err.message));
    if (customer_phone) sendBookingSms(reservation).catch(() => {});
    console.log(`📅 New booking [${source}]: ${customer_name} ×${coversNum} on ${reservation_date} at ${reservation_time}`);
    if (process.env.MAKE_BOOKING_WEBHOOK) {
      const webhookData = JSON.stringify({
        booking_id:        reservation.id,
        customer_name:     reservation.customer_name,
        customer_email:    reservation.customer_email || null,
        customer_phone:    reservation.customer_phone || null,
        covers:            reservation.covers,
        reservation_date:  String(reservation.reservation_date).split('T')[0],
        reservation_time:  String(reservation.reservation_time).slice(0,5),
        source:            reservation.source,
        restaurant_name:   process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant',
        restaurant_email:  process.env.RESTAURANT_EMAIL || null,
      });
      const webhookHttps = require('https');
      const webhookUrl   = new URL(process.env.MAKE_BOOKING_WEBHOOK);
      const webhookReq   = webhookHttps.request({
        hostname: webhookUrl.hostname,
        path:     webhookUrl.pathname + webhookUrl.search,
        method:   'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(webhookData) },
      });
      webhookReq.on('error', e => console.log('Make.com webhook error:', e.message));
      webhookReq.write(webhookData);
      webhookReq.end();
    }
    res.status(201).json({
      success: true,
      booking_id: reservation.id,
      message: 'Booking received!',
      reservation: {
        id: reservation.id,
        customer_name: reservation.customer_name,
        covers: reservation.covers,
        reservation_date: String(reservation.reservation_date).split('T')[0],
        reservation_time: String(reservation.reservation_time).slice(0,5),
        status: reservation.status,
      },
    });
  } catch (err) {
    console.error('POST /api/reservations error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/reservations/:id', async (req, res) => {
  try {
    const {
      customer_name, customer_phone, customer_email,
      covers, reservation_date, reservation_time,
      table_id, notes, status,
    } = req.body;
    const result = await pool.query(
      `UPDATE reservations SET
         customer_name=$1, customer_phone=$2, customer_email=$3,
         covers=$4, reservation_date=$5, reservation_time=$6,
         table_id=$7, notes=$8, status=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [customer_name, customer_phone, customer_email || null,
       covers, reservation_date, reservation_time,
       table_id || null, notes || null, status, req.params.id]
    );
    io.emit('reservation_updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations/:id/seat', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE reservations SET status='seated', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    const reservation = result.rows[0];
    if (reservation.table_id) {
      await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [reservation.table_id]);
      io.emit('tableStatusChanged', { id: reservation.table_id, status: 'occupied' });
    }
    io.emit('reservation_updated', reservation);
    res.json(reservation);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE reservations SET status='cancelled', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    io.emit('reservation_cancelled', { id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reservations/settings/:restaurantId', async (req, res) => {
  try {
    const {
      restaurant_name, brand_colour, opening_time, last_booking_time,
      slot_interval_mins, max_covers_per_slot, booking_lead_hours,
      booking_advance_days, is_active,
    } = req.body;
    await pool.query(
      `INSERT INTO restaurant_settings
         (restaurant_id, restaurant_name, brand_colour, opening_time,
          last_booking_time, slot_interval_mins, max_covers_per_slot,
          booking_lead_hours, booking_advance_days, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (restaurant_id) DO UPDATE SET
         restaurant_name      = EXCLUDED.restaurant_name,
         brand_colour         = EXCLUDED.brand_colour,
         opening_time         = EXCLUDED.opening_time,
         last_booking_time    = EXCLUDED.last_booking_time,
         slot_interval_mins   = EXCLUDED.slot_interval_mins,
         max_covers_per_slot  = EXCLUDED.max_covers_per_slot,
         booking_lead_hours   = EXCLUDED.booking_lead_hours,
         booking_advance_days = EXCLUDED.booking_advance_days,
         is_active            = EXCLUDED.is_active`,
      [req.params.restaurantId, restaurant_name, brand_colour, opening_time,
       last_booking_time, slot_interval_mins, max_covers_per_slot,
       booking_lead_hours, booking_advance_days, is_active]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// MENU BATCH IMPORT — AI Scanner
// ─────────────────────────────────────────────

app.post('/api/menu/import-batch', async (req, res) => {
  const client = await pool.connect();
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }
    const catRes = await client.query('SELECT id, name FROM categories');
    const categories = catRes.rows;
    function findCategoryId(categoryName) {
      if (!categoryName) return null;
      const search = categoryName.toLowerCase().trim();
      let match = categories.find(c => c.name.toLowerCase() === search);
      if (match) return match.id;
      match = categories.find(c =>
        c.name.toLowerCase().includes(search) || search.includes(c.name.toLowerCase())
      );
      return match ? match.id : null;
    }
    await client.query('BEGIN');
    const results = { inserted: [], skipped: [], errors: [] };
    for (const item of items) {
      try {
        if (!item.name_en || !item.name_en.trim()) { results.skipped.push({ item, reason: 'Missing name_en' }); continue; }
        const price = parseFloat(item.price);
        if (isNaN(price) || price < 0) { results.skipped.push({ item, reason: 'Invalid price' }); continue; }
        const categoryId = findCategoryId(item.category);
        let allergensStr = null;
        if (Array.isArray(item.allergens) && item.allergens.length > 0) {
          allergensStr = JSON.stringify(item.allergens);
        } else if (typeof item.allergens === 'string' && item.allergens.trim()) {
          allergensStr = JSON.stringify([item.allergens]);
        }
        const insertRes = await client.query(
          `INSERT INTO menu_items (category_id, name, name_alt, description, price, allergens, is_available)
           VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, name`,
          [categoryId, item.name_en.trim(), item.name_th ? item.name_th.trim() : null,
           item.description ? item.description.trim() : null, price, allergensStr]
        );
        results.inserted.push({ id: insertRes.rows[0].id, name: insertRes.rows[0].name, category_id: categoryId, category_name: item.category || null });
      } catch (itemErr) {
        results.errors.push({ item, error: itemErr.message });
      }
    }
    await client.query('COMMIT');
    console.log(`📥 Batch import: ${results.inserted.length} inserted, ${results.skipped.length} skipped, ${results.errors.length} errors`);
    res.json({ success: true, summary: { total: items.length, inserted: results.inserted.length, skipped: results.skipped.length, errors: results.errors.length }, inserted: results.inserted, skipped: results.skipped, errors: results.errors });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/menu/import-batch error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// AI MENU SCANNER
// ─────────────────────────────────────────────

app.post('/api/ai/scan-menu', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on Railway' });
    const isImage = media_type && media_type.startsWith('image/');
    const contentItem = isImage
      ? { type: 'image', source: { type: 'base64', media_type, data: image_base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } };
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          contentItem,
          {
            type: 'text',
            text: `You are an expert restaurant menu reader and UK food safety specialist.

Analyse this menu image/document and extract ALL dishes. For each dish provide:
1. English name
2. Thai name (transliterate or translate)
3. Short appetising description (1-2 sentences)
4. Price in GBP — exact if visible, estimated if not. Mark assumed prices.
5. UK 14 allergens — gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, nuts, celery, mustard, sesame, sulphites, lupin, molluscs. Fish sauce is in almost all Thai food.
6. Category (Starters, Mains, Curries, Noodles, Rice Dishes, Salads, Desserts, Drinks, Sides)
7. Confidence score 0-100

Return ONLY valid JSON, no markdown, no explanation:
{
  "restaurant_type": "Thai Restaurant",
  "total_dishes": 0,
  "categories": [
    {
      "name": "Category Name",
      "dishes": [
        {
          "name_en": "English Name",
          "name_th": "ชื่อภาษาไทย",
          "description": "Description",
          "price": 12.50,
          "price_assumed": false,
          "allergens": ["Fish","Soybeans"],
          "confidence": 95
        }
      ]
    }
  ]
}`
          }
        ]
      }]
    });
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data }));
      });
      apiReq.on('error', reject);
      apiReq.write(requestBody);
      apiReq.end();
    });
    if (result.status !== 200) {
      console.error('Anthropic error:', result.body);
      return res.status(502).json({ error: 'Anthropic API error — check ANTHROPIC_API_KEY on Railway' });
    }
    const data  = JSON.parse(result.body);
    const raw   = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    let menu;
    try {
      menu = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse failed. AI returned:', clean.slice(0, 300));
      return res.status(500).json({ error: 'AI returned invalid JSON — try again with a clearer image' });
    }
    console.log(`🍜 Menu scan complete: ${menu.total_dishes || '?'} dishes`);
    res.json({ success: true, menu });
  } catch (err) {
    console.error('POST /api/ai/scan-menu error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// INVENTORY ROUTES — SEPOS-016
// ═══════════════════════════════════════════════════════════════════

// AI INVOICE SCANNER
app.post('/api/ai/scan-invoice', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });

    const INVOICE_PROMPT = `You are reading a supplier invoice or delivery note for a restaurant.
Extract all information and return ONLY a valid JSON object — no other text, no markdown, no explanation.

Required JSON structure:
{
  "supplier_name": "string",
  "invoice_date": "YYYY-MM-DD",
  "invoice_number": "string",
  "total_amount": number,
  "line_items": [
    { "name": "string", "quantity": number, "unit": "string", "unit_price": number, "line_total": number }
  ]
}

Rules: If a value is missing use null for strings and 0 for numbers. Convert prices to GBP. Return ONLY the JSON object.`;

    const isImage     = media_type && media_type.startsWith('image/');
    const contentItem = isImage
      ? { type: 'image',    source: { type: 'base64', media_type: media_type, data: image_base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } };

    const https = require('https');
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{ role: 'user', content: [
        contentItem,
        { type: 'text', text: INVOICE_PROMPT }
      ]}]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data }));
      });
      apiReq.on('error', reject);
      apiReq.write(requestBody);
      apiReq.end();
    });

    if (result.status !== 200) throw new Error(`Anthropic API error: ${result.body}`);
    const aiData  = JSON.parse(result.body);
    const invoice = JSON.parse(aiData.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return res.json({ success: true, invoice });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
// AI EXPENSE SCANNER
app.post('/api/ai/scan-expense', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });

    const EXPENSE_PROMPT = `You are reading a receipt, bill or expense document for a restaurant.
Extract the key information and return ONLY a valid JSON object — no other text, no markdown.

Required JSON structure:
{
  "vendor": "string", "date": "YYYY-MM-DD", "total_amount": number,
  "description": "string", "category": "overhead|labour|other",
  "line_items": [{ "description": "string", "amount": number }]
}

Category: overhead=rent/utilities/insurance/repairs, labour=wages/staff, other=equipment/misc. Return ONLY JSON.`;

    const isImage     = media_type && media_type.startsWith('image/');
    const contentItem = isImage
      ? { type: 'image',    source: { type: 'base64', media_type: media_type, data: image_base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } };

    const https = require('https');
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{ role: 'user', content: [
        contentItem,
        { type: 'text', text: EXPENSE_PROMPT }
      ]}]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data }));
      });
      apiReq.on('error', reject);
      apiReq.write(requestBody);
      apiReq.end();
    });

    if (result.status !== 200) throw new Error(`Anthropic API error: ${result.body}`);
    const aiData  = JSON.parse(result.body);
    const expense = JSON.parse(aiData.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return res.json({ success: true, expense });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
// EXPENSES CRUD
app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM expenses ORDER BY date DESC, created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'description and amount are required' });
    const result = await pool.query(
      `INSERT INTO expenses (category, description, amount, date) VALUES ($1,$2,$3,$4) RETURNING id`,
      [category || 'other', description, parseFloat(amount), date || new Date().toISOString().split('T')[0]]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUPPLIER INVOICES
app.post('/api/supplier-invoices', async (req, res) => {
  try {
    const { supplier_name, invoice_date, invoice_number, total_amount, status } = req.body;
    const result = await pool.query(
      `INSERT INTO supplier_invoices (supplier_name, invoice_date, invoice_number, total_amount, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [supplier_name, invoice_date, invoice_number, parseFloat(total_amount) || 0, status || 'processed']
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supplier-invoices', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM supplier_invoices ORDER BY created_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// INGREDIENTS CRUD
app.get('/api/ingredients', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM ingredients ORDER BY category, name_en`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ingredients/low-stock', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM ingredients WHERE par_level IS NOT NULL AND current_stock < par_level ORDER BY name_en`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ingredients', async (req, res) => {
  try {
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens } = req.body;
    const result = await pool.query(
      `INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id`,
      [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100,
       category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]']
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/ingredients/:id', async (req, res) => {
  try {
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens } = req.body;
    const result = await pool.query(
      `UPDATE ingredients SET name_en=$1, name_th=$2, unit=$3, cost_per_unit=$4, yield_percentage=$5,
       category=$6, current_stock=$7, par_level=$8, supplier_name=$9, allergens=$10, updated_at=NOW() WHERE id=$11`,
      [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100,
       category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]', req.params.id]
    );
    res.json({ success: true, changes: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ingredients/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM ingredients WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RECIPES CRUD
app.get('/api/recipes', async (req, res) => {
  try {
    const recipesRes = await pool.query(`SELECT * FROM recipes ORDER BY name`);
    const recipes = recipesRes.rows;
    if (!recipes.length) return res.json([]);
    const recipeIds = recipes.map(r => r.id);
    const linesRes = await pool.query(
      `SELECT rl.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.cost_per_unit, i.yield_percentage
       FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.recipe_id = ANY($1)`,
      [recipeIds]
    );
    const linesByRecipe = {};
    linesRes.rows.forEach(line => { if (!linesByRecipe[line.recipe_id]) linesByRecipe[line.recipe_id] = []; linesByRecipe[line.recipe_id].push(line); });
    res.json(recipes.map(r => ({ ...r, lines: linesByRecipe[r.id] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/recipes/menu-item/:menuItemId', async (req, res) => {
  try {
    const recipeRes = await pool.query(`SELECT * FROM recipes WHERE menu_item_id = $1`, [req.params.menuItemId]);
    if (!recipeRes.rows.length) return res.json(null);
    const recipe = recipeRes.rows[0];
    const linesRes = await pool.query(
      `SELECT rl.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.cost_per_unit, i.yield_percentage
       FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.recipe_id = $1`,
      [recipe.id]
    );
    recipe.lines = linesRes.rows;
    res.json(recipe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/recipes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { menu_item_id, name, serves, lines } = req.body;
    const totalCost = (lines || []).reduce((s, l) => s + (parseFloat(l.line_cost) || 0), 0);
    const costPerPortion = serves > 0 ? totalCost / serves : totalCost;
    await client.query('BEGIN');
    const recipeRes = await client.query(
      `INSERT INTO recipes (menu_item_id, name, serves, total_cost, cost_per_portion, last_calculated) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`,
      [menu_item_id, name, serves || 1, totalCost, costPerPortion]
    );
    const recipeId = recipeRes.rows[0].id;
    for (const l of (lines || [])) {
      await client.query(`INSERT INTO recipe_lines (recipe_id, ingredient_id, quantity_used, unit, line_cost) VALUES ($1,$2,$3,$4,$5)`,
        [recipeId, l.ingredient_id, l.quantity_used, l.unit, l.line_cost]);
    }
    await client.query('COMMIT');
    res.json({ id: recipeId, success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.put('/api/recipes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, serves, lines } = req.body;
    const totalCost = (lines || []).reduce((s, l) => s + (parseFloat(l.line_cost) || 0), 0);
    const costPerPortion = serves > 0 ? totalCost / serves : totalCost;
    await client.query('BEGIN');
    await client.query(`UPDATE recipes SET name=$1, serves=$2, total_cost=$3, cost_per_portion=$4, last_calculated=NOW() WHERE id=$5`,
      [name, serves || 1, totalCost, costPerPortion, req.params.id]);
    await client.query(`DELETE FROM recipe_lines WHERE recipe_id = $1`, [req.params.id]);
    for (const l of (lines || [])) {
      await client.query(`INSERT INTO recipe_lines (recipe_id, ingredient_id, quantity_used, unit, line_cost) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, l.ingredient_id, l.quantity_used, l.unit, l.line_cost]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.delete('/api/recipes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM recipe_lines WHERE recipe_id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM recipes WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// STOCK MOVEMENTS
app.get('/api/stock/movements', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sm.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.unit
       FROM stock_movements sm LEFT JOIN ingredients i ON i.id = sm.ingredient_id
       ORDER BY sm.created_at DESC LIMIT 500`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stock/adjustment', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ingredient_id, quantity, movement_type, cost_at_time, note, reference } = req.body;
    if (!ingredient_id || quantity == null) return res.status(400).json({ error: 'ingredient_id and quantity required' });
    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ingredient_id, movement_type || 'adjustment', parseFloat(quantity), parseFloat(cost_at_time) || 0, note || '', reference || '']
    );
    const qty = parseFloat(quantity);
    const delta = (movement_type === 'waste' || qty < 0) ? -Math.abs(qty) : Math.abs(qty);
    await client.query(`UPDATE ingredients SET current_stock = GREATEST(0, current_stock + $1), updated_at=NOW() WHERE id=$2`, [delta, ingredient_id]);
    await client.query('COMMIT');
    res.json({ id: insertRes.rows[0].id, success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════════
// END INVENTORY ROUTES — SEPOS-016
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// ALLERGEN ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/dish-allergens', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM dish_allergens`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dish-allergens/:menuItemId', async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { allergens } = req.body;
    const result = await pool.query(
      `INSERT INTO dish_allergens (menu_item_id, allergens, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (menu_item_id) DO UPDATE SET
         allergens = EXCLUDED.allergens,
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [menuItemId, allergens || '[]']
    );
    res.json({ success: true, id: result.rows[0]?.id });
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