const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const pool = require('./db/dbAdapter');
const offlineQueue = require('./services/offlineQueue');
const syncService = require('./services/syncService');
const cloudRelay = require('./services/cloudRelay');
const makeWebhooks = require('./services/makeWebhooks');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
  optionsSuccessStatus: 204,
}));
app.options(/.*/, cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// When the desktop shell sets CLIENT_DIST_PATH (Electron does — pointed at
// client/dist), serve the React bundle from the local server too. Lets
// kitchen / bar tablets on the same Wi-Fi load SiamEPOS from this host
// (e.g. via the QR code in the Electron setup window).
if (process.env.CLIENT_DIST_PATH) {
  app.use(express.static(process.env.CLIENT_DIST_PATH));
  console.log('Serving client bundle from', process.env.CLIENT_DIST_PATH);
}

let sendBookingConfirmation = async () => {};
let sendBookingSms = async () => {};
try {
  const emailSvc = require('./services/emailService');
  sendBookingConfirmation = emailSvc.sendBookingConfirmation;
  console.log('✅ Email service loaded');
} catch (e) {
  console.log('ℹ️  Email service not configured yet — skipping');
}

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
// TABLE COMBINATIONS
// ─────────────────────────────────────────────

app.get('/api/table-combinations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM table_combinations WHERE is_active = true ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/table-combinations', async (req, res) => {
  try {
    const { table_id_a, table_id_b } = req.body;
    if (!table_id_a || !table_id_b) return res.status(400).json({ error: 'table_id_a and table_id_b required' });
    const result = await pool.query(
      'INSERT INTO table_combinations (table_id_a, table_id_b) VALUES ($1,$2) RETURNING id',
      [table_id_a, table_id_b]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/table-combinations/:id', async (req, res) => {
  try {
    await pool.query('UPDATE table_combinations SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// TABLE WALLS
// ─────────────────────────────────────────────

app.get('/api/table-walls', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM table_walls ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/table-walls', async (req, res) => {
  try {
    const { pos_x, pos_y, width, height } = req.body;
    const result = await pool.query(
      'INSERT INTO table_walls (pos_x, pos_y, width, height) VALUES ($1,$2,$3,$4) RETURNING id',
      [pos_x || 0, pos_y || 0, width || 12, height || 100]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/table-walls/:id', async (req, res) => {
  try {
    const { pos_x, pos_y, width, height } = req.body;
    await pool.query(
      'UPDATE table_walls SET pos_x=$1, pos_y=$2, width=$3, height=$4 WHERE id=$5',
      [pos_x, pos_y, width, height, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/table-walls/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM table_walls WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// DINING DURATION TIERS
// ─────────────────────────────────────────────

app.get('/api/dining-duration-tiers', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM dining_duration_tiers WHERE restaurant_id = 'siamepos' ORDER BY covers_min"
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dining-duration-tiers/:id', async (req, res) => {
  try {
    const { duration_mins } = req.body;
    await pool.query('UPDATE dining_duration_tiers SET duration_mins = $1 WHERE id = $2', [duration_mins, req.params.id]);
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

app.get('/api/subcategories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subcategories ORDER BY category_id, sort_order');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/subcategories', async (req, res) => {
  try {
    const { category_id, name } = req.body;
    const result = await pool.query('INSERT INTO subcategories (category_id, name) VALUES ($1,$2) RETURNING id', [category_id, name]);
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

app.get('/api/menu', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items WHERE is_available = 1 ORDER BY sort_order ASC')
    ]);
    res.json(catRes.rows.map(cat => ({ ...cat, subcategories: subRes.rows.filter(s => s.category_id === cat.id), items: itemRes.rows.filter(i => i.category_id === cat.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu/all', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items ORDER BY sort_order ASC')
    ]);
    res.json(catRes.rows.map(cat => ({ ...cat, subcategories: subRes.rows.filter(s => s.category_id === cat.id), items: itemRes.rows.filter(i => i.category_id === cat.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/items', async (req, res) => {
  try {
    const { category_id, subcategory_id, name, name_alt, description, price, vat_rate } = req.body;
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, subcategory_id, name, name_alt, description, price, vat_rate) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [category_id, subcategory_id || null, name, name_alt || null, description, price, vat_rate ?? 20]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/menu/items/sort-order', async (req, res) => {
  try {
    const { items } = req.body;
    for (const item of items) {
      await pool.query('UPDATE menu_items SET sort_order = $1 WHERE id = $2', [item.sort_order, item.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/menu/items/:id', async (req, res) => {
  try {
    const { name, name_alt, description, price, is_available, subcategory_id, category_id, vat_rate } = req.body;
    await pool.query(
      'UPDATE menu_items SET name=$1, name_alt=$2, description=$3, price=$4, is_available=$5, subcategory_id=$6, category_id=$7, vat_rate=COALESCE($8, vat_rate) WHERE id=$9',
      [name, name_alt || null, description, price, is_available, subcategory_id || null, category_id, vat_rate ?? null, req.params.id]
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
    const result = await pool.query('INSERT INTO modifiers (group_id, name, extra_price) VALUES ($1,$2,$3) RETURNING id', [req.params.id, name, extra_price || 0]);
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
    await pool.query(`UPDATE order_items SET item_name = COALESCE(item_name, (SELECT name FROM menu_items WHERE id = $1)), menu_item_id = NULL WHERE menu_item_id = $1`, [req.params.id]);
    await pool.query('DELETE FROM modifiers WHERE group_id IN (SELECT id FROM modifier_groups WHERE menu_item_id = $1)', [req.params.id]);
    await pool.query('DELETE FROM modifier_groups WHERE menu_item_id = $1', [req.params.id]);
    await pool.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status = 'open' ORDER BY orders.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-041 — public health endpoint polled every 5 minutes by the
// SiamEPOS Back Office cron. Intentionally unauthenticated so the ops
// dashboard can ping any client URL without rotating per-client secrets.
// Returns only aggregate counts — no PII, no menu, no order details.
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS orders_today,
        MAX(created_at) AS last_order_at
      FROM orders
    `);
    res.json({
      status: 'ok',
      orders_today: parseInt(result.rows[0].orders_today, 10) || 0,
      last_order_at: result.rows[0].last_order_at,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/orders/bar', async (req, res) => {
  try {
    const ordersRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status = 'open' ORDER BY orders.created_at DESC`);
    const orders = ordersRes.rows;
    if (!orders.length) return res.json([]);
    const orderIds = orders.map(o => o.id);
    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id WHERE order_items.order_id = ANY($1) AND order_items.voided = 0 AND order_items.status != 'served' AND categories.is_bar = 1`,
      [orderIds]
    );
    res.json(orders.map(order => ({ ...order, items: itemsRes.rows.filter(i => i.order_id === order.id) })).filter(o => o.items.length > 0));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const itemsRes = await pool.query(
      `SELECT order_items.*, menu_items.name, menu_items.name_alt, menu_items.category_id, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id WHERE order_items.order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order, items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { table_id, covers, staff_id, order_type } = req.body;
    // SEPOS-045 — counter orders (and any tableless mode) skip the table
    // status flip and don't enforce covers.
    const type = order_type === 'counter' || order_type === 'takeaway'
      ? order_type : 'dine_in';
    const result = await pool.query(
      `INSERT INTO orders (table_id, staff_id, status, covers, order_type, opened_at)
       VALUES ($1, $2, 'open', $3, $4, NOW()) RETURNING id`,
      [table_id || null, staff_id || null, covers || 1, type]
    );
    if (table_id) {
      await pool.query("UPDATE tables SET status = 'occupied' WHERE id = $1", [table_id]);
    }
    const localOrderId = result.rows[0].id;
    await offlineQueue.enqueue('create_order', {
      localOrderId, table_id: table_id || null,
      covers: covers || 1, staff_id: staff_id || null,
      order_type: type,
    });
    res.json({ id: localOrderId, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/:id/items', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { items } = req.body;
    const orderId = req.params.id;
    const firedBarIds = []; // SEPOS-032: bar items deplete stock on add
    const queuedItems = [];  // SEPOS-PRO-002: paired with local row id for cloud_id mapping
    for (const item of items) {
      const isBar = item.is_bar ? 1 : 0;
      const firedAt = isBar ? new Date().toISOString() : null;
      const nameRes = await client.query('SELECT name FROM menu_items WHERE id = $1', [item.menu_item_id]);
      const itemName = nameRes.rows[0]?.name || item.name || 'Unknown item';
      const ins = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at, item_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [orderId, item.menu_item_id, item.quantity, item.unit_price, item.notes || '', item.course || 1, item.item_note || '', isBar, firedAt, firedAt, itemName]
      );
      const newRowId = ins.rows[0].id;
      if (isBar) firedBarIds.push(newRowId);
      queuedItems.push({ ...item, localItemId: newRowId });
    }
    const totalRes = await client.query('SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id = $1 AND voided = 0', [orderId]);
    const total = totalRes.rows[0].total || 0;
    await client.query('UPDATE orders SET total = $1 WHERE id = $2', [total, orderId]);
    await client.query('COMMIT');
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const newItemsRes = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id = $1 AND order_items.is_fired = 1 AND order_items.status = 'cooking'`, [orderId]);
    io.emit('new_order_items', { order: orderRes.rows[0], items: newItemsRes.rows });
    await offlineQueue.enqueue('add_items', { localOrderId: Number(orderId), items: queuedItems });
    // SEPOS-032: bar items go is_fired=1 immediately → deplete stock now
    if (firedBarIds.length > 0) await depleteStockForItems(firedBarIds, 'sale');
    // SEPOS-PRO-002: return the inserted items so the Mac's sync engine can
    // map local order_item ids → cloud order_item ids after a push.
    // (queuedItems is positionally aligned with what was inserted.)
    const insertedIds = queuedItems.map(qi => qi.localItemId).filter(Boolean);
    const insertedRows = insertedIds.length > 0
      ? (await pool.query(`SELECT id FROM order_items WHERE id = ANY($1::int[]) ORDER BY id ASC`, [insertedIds])).rows
      : [];
    res.json({ success: true, total, items: insertedRows });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.put('/api/orders/:id/fire-course/:course', async (req, res) => {
  try {
    const { id, course } = req.params;
    const now = new Date().toISOString();
    // SEPOS-032: capture ids about-to-be-fired before the UPDATE so we
    // can deplete stock for exactly that set.
    const aboutToFireRes = await pool.query(
      `SELECT id FROM order_items WHERE order_id=$1 AND course=$2 AND is_fired=0 AND voided=0 AND menu_item_id IN (SELECT menu_items.id FROM menu_items LEFT JOIN categories ON menu_items.category_id = categories.id WHERE categories.is_bar = 0 OR categories.is_bar IS NULL)`,
      [id, course]
    );
    const firedIds = aboutToFireRes.rows.map(r => r.id);
    const result = await pool.query(
      `UPDATE order_items SET is_fired=1, fired_at=$1, status='cooking', cooking_started_at=$2 WHERE order_id=$3 AND course=$4 AND is_fired=0 AND voided=0 AND menu_item_id IN (SELECT menu_items.id FROM menu_items LEFT JOIN categories ON menu_items.category_id = categories.id WHERE categories.is_bar = 0 OR categories.is_bar IS NULL)`,
      [now, now, id, course]
    );
    await depleteStockForItems(firedIds, 'sale');
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [id]);
    const itemsRes = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id = $1 AND order_items.course = $2 AND order_items.is_fired = 1`, [id, course]);
    io.emit('course_fired', { order: orderRes.rows[0], course: Number(course), items: itemsRes.rows });
    await offlineQueue.enqueue('fire_course', { localOrderId: Number(id), course: Number(course) });
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
    await pool.query('UPDATE order_items SET status=$1, cooking_started_at=$2, served_at=$3 WHERE id=$4', [status, cooking_started_at, served_at, req.params.id]);
    io.emit('item_status_changed', { item_id: req.params.id, status });

    // SEPOS-034 — when the last non-voided item on a takeaway order goes
    // to 'served', auto-flip takeaway_status='collected' so the order
    // closes and counts in reports. Without this the Collected button
    // is the only path, and it lives on the Pass tab card which has
    // already disappeared by the time everything is served.
    if (status === 'served' && item.order_id) {
      const orderRes = await pool.query(
        'SELECT id, order_type, status, takeaway_status FROM orders WHERE id = $1',
        [item.order_id]
      );
      const order = orderRes.rows[0];
      if (order && order.order_type === 'takeaway' && order.status === 'open' && order.takeaway_status !== 'collected') {
        const remainingRes = await pool.query(
          `SELECT COUNT(*) AS n FROM order_items
           WHERE order_id = $1 AND voided = 0 AND status <> 'served'`,
          [item.order_id]
        );
        if (parseInt(remainingRes.rows[0].n, 10) === 0) {
          await pool.query(
            `UPDATE orders SET takeaway_status='collected', status='closed', closed_at=NOW() WHERE id = $1`,
            [item.order_id]
          );
          io.emit('takeaway_status', { order_id: Number(item.order_id), status: 'collected' });
          console.log(`🥡 auto-collected takeaway order #${item.order_id} (all items served)`);
        }
      }
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/void', async (req, res) => {
  try {
    const { reason, quantity: voidQty, void_type } = req.body;
    // Look up the original item up front — partial void needs its quantity.
    const origRes = await pool.query('SELECT * FROM order_items WHERE id = $1', [req.params.id]);
    const orig = origRes.rows[0];
    if (!orig) return res.status(404).json({ error: 'Item not found' });

    const qtyToVoid = Number.isFinite(Number(voidQty)) ? Number(voidQty) : orig.quantity;
    if (qtyToVoid < orig.quantity && qtyToVoid >= 1) {
      // Partial void: shrink the original row, insert a voided-ghost copy
      // that carries the same per-item state (status/fired/served/etc.) so
      // reports and the kitchen screen treat it consistently.
      const remaining = orig.quantity - qtyToVoid;
      await pool.query('UPDATE order_items SET quantity=$1 WHERE id=$2', [remaining, req.params.id]);
      await pool.query(
        `INSERT INTO order_items
           (order_id, menu_item_id, item_name, quantity, unit_price, notes, course, item_note,
            status, is_fired, fired_at, cooking_started_at, served_at, voided, void_reason,
            void_type, discount_type, discount_value)
         SELECT order_id, menu_item_id, item_name, $1, unit_price, notes, course, item_note,
            status, is_fired, fired_at, cooking_started_at, served_at, 1, $2,
            $3, discount_type, discount_value
         FROM order_items WHERE id=$4`,
        [qtyToVoid, reason, void_type || null, req.params.id]
      );
    } else {
      // Full void — existing behaviour.
      await pool.query('UPDATE order_items SET voided=1, void_reason=$1, void_type=$2 WHERE id=$3', [reason, void_type || null, req.params.id]);
    }
    await offlineQueue.enqueue('void_item', { localItemId: Number(req.params.id), reason, quantity: qtyToVoid });
    const itemRes = await pool.query('SELECT order_id FROM order_items WHERE id = $1', [req.params.id]);
    const item = itemRes.rows[0];
    if (item) {
      const totalRes = await pool.query('SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id=$1 AND voided=0', [item.order_id]);
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, item.order_id]);
      io.emit('item_voided', { item_id: req.params.id });
      const countRes = await pool.query('SELECT COUNT(*) as remaining FROM order_items WHERE order_id=$1 AND voided=0', [item.order_id]);
      if (parseInt(countRes.rows[0].remaining) === 0) {
        await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [item.order_id]);
        const orderRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [item.order_id]);
        if (orderRes.rows[0]) await pool.query("UPDATE tables SET status='available' WHERE id=$1", [orderRes.rows[0].table_id]);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/discount', async (req, res) => {
  try {
    const { discount_type, discount_value, discount_reason } = req.body;
    await pool.query('UPDATE orders SET discount_type=$1, discount_value=$2, discount_reason=$3 WHERE id=$4', [discount_type, discount_value, discount_reason, req.params.id]);
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
    const tableId = orderRes.rows[0]?.table_id;
    if (tableId) {
      await pool.query("UPDATE tables SET status='available' WHERE id=$1", [tableId]);
      // SEPOS-044 — free linked partner tables ONLY if the order actually
      // spanned the group (covers > primary table capacity). Small parties
      // at a single linked table don't drag the rest of the group, so we
      // don't need to free anything else for them either.
      try {
        const [capRes, ordRes] = await Promise.all([
          pool.query('SELECT capacity FROM tables WHERE id=$1', [tableId]),
          pool.query('SELECT covers FROM orders WHERE id=$1', [orderId]),
        ]);
        const primaryCap = Number(capRes.rows[0]?.capacity) || 0;
        const orderCovers = Number(ordRes.rows[0]?.covers) || 0;
        if (orderCovers > primaryCap) {
          const linkedRes = await pool.query(
            `SELECT table_id_b AS id FROM table_combinations WHERE table_id_a=$1
             UNION SELECT table_id_a AS id FROM table_combinations WHERE table_id_b=$1`,
            [tableId]
          );
          for (const row of linkedRes.rows) {
            if (row.id && row.id !== tableId) {
              await pool.query("UPDATE tables SET status='available' WHERE id=$1", [row.id]);
            }
          }
        }
      } catch {}
      // SEPOS-044 — auto-complete the seated booking on this table.
      // Orders don't carry reservation_id today (known limitation), so we
      // pick the most recently updated 'seated' reservation on the same
      // table. Two queries (instead of one subquery) so the path works
      // identically on PG and SQLite. Reports + the booking timeline
      // both rely on this flip — also covers walk-ins.
      try {
        const seated = await pool.query(
          `SELECT id FROM reservations WHERE table_id=$1 AND status='seated'
           ORDER BY updated_at DESC LIMIT 1`,
          [tableId]
        );
        if (seated.rows[0]) {
          const completeRes = await pool.query(
            `UPDATE reservations SET status='completed', updated_at=NOW()
             WHERE id=$1 RETURNING *`,
            [seated.rows[0].id]
          );
          if (completeRes.rows[0]) io.emit('reservation_updated', completeRes.rows[0]);
        }
      } catch (err) {
        console.warn('[pay] auto-complete reservation skipped:', err.message);
      }
    }
    io.emit('order_closed', { order_id: orderId });
    await offlineQueue.enqueue('pay_order', { localOrderId: Number(orderId), amount, method });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id/bill', async (req, res) => {
  try {
    const [orderRes, itemsRes, settingsRes] = await Promise.all([
      pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id=$1`, [req.params.id]),
      pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, menu_items.vat_rate FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id=$1 AND order_items.voided=0`, [req.params.id]),
      pool.query('SELECT * FROM settings')
    ]);
    const settings = {};
    settingsRes.rows.forEach(r => settings[r.key] = r.value);
    res.json({ order: { ...orderRes.rows[0], items: itemsRes.rows }, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const result = await pool.query('INSERT INTO staff (name, pin, role, start_date, notes, employment_status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [name, pin, role, start_date || null, notes || null, employment_status || 'active']);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, pin, role, is_active, start_date, notes, employment_status } = req.body;
    // Normalise: when the client doesn't send is_active (or sends an empty
    // string), keep whatever's already in the DB — DON'T null it. The old
    // version would clobber a manager's is_active flag to NULL on every
    // edit, which then read as "inactive" everywhere AND broke the
    // manager-PIN gate on the order-delete endpoint.
    const activeParam = (is_active === undefined || is_active === null || is_active === '')
      ? null
      : (is_active ? 1 : 0);
    if (pin) {
      await pool.query(
        `UPDATE staff SET
           name = $1,
           pin = $2,
           role = $3,
           is_active = COALESCE($4::int, is_active),
           start_date = $5,
           notes = $6,
           employment_status = $7
         WHERE id = $8`,
        [name, pin, role, activeParam, start_date || null, notes || null, employment_status || 'active', req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE staff SET
           name = $1,
           role = $2,
           is_active = COALESCE($3::int, is_active),
           start_date = $4,
           notes = $5,
           employment_status = $6
         WHERE id = $7`,
        [name, role, activeParam, start_date || null, notes || null, employment_status || 'active', req.params.id]
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
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// Helper: split a list of closed-order rows into dine-in vs takeaway
// totals so every reports endpoint exposes the same shape.
function splitByOrderType(rows) {
  let total_takeaway = 0, total_dine_in = 0, total_counter = 0;
  let takeaway_count = 0, dine_in_count = 0, counter_count = 0;
  for (const r of rows) {
    const t = Number(r.total || 0);
    if (r.order_type === 'takeaway')      { total_takeaway += t; takeaway_count++; }
    else if (r.order_type === 'counter')  { total_counter  += t; counter_count++;  }
    else                                  { total_dine_in  += t; dine_in_count++;  }
  }
  return {
    total_takeaway, total_dine_in, total_counter,
    takeaway_count,  dine_in_count,  counter_count,
  };
}

app.get('/api/reports/daily', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.order_type, orders.customer_name, payments.method, tables.table_number FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at::date = $1::date ORDER BY orders.closed_at DESC`, [date]);
    const total = result.rows.reduce((sum, r) => sum + (r.total || 0), 0);
    res.json({ date, orders: result.rows, total_sales: total, order_count: result.rows.length, ...splitByOrderType(result.rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.covers, orders.discount_value, orders.discount_type, orders.order_type, orders.customer_name, payments.method, tables.table_number FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at::date >= $1::date AND orders.closed_at::date <= $2::date ORDER BY orders.closed_at DESC`, [from, to]);
    const rows = result.rows;
    const total_sales = rows.reduce((sum, r) => sum + (r.total || 0), 0);
    const total_covers = rows.reduce((sum, r) => sum + (r.covers || 0), 0);
    const by_method = {};
    rows.forEach(r => { if (r.method) by_method[r.method] = (by_method[r.method] || 0) + (r.total || 0); });
    res.json({ orders: rows, total_sales, order_count: rows.length, total_covers, by_method, ...splitByOrderType(rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/items', async (req, res) => {
  try {
    const { from, to } = req.query;
    const result = await pool.query(`SELECT menu_items.name, menu_items.price, SUM(order_items.quantity) as qty_sold, SUM(order_items.quantity * order_items.unit_price) as total_revenue FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN orders ON order_items.order_id = orders.id WHERE orders.status='closed' AND order_items.voided=0 AND orders.closed_at::date >= $1::date AND orders.closed_at::date <= $2::date GROUP BY menu_items.id, menu_items.name, menu_items.price ORDER BY qty_sold DESC`, [from, to]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/kitchen/completed', async (req, res) => {
  try {
    const result = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id, tables.table_number, order_items.fired_at, order_items.served_at, orders.order_type, orders.customer_name, orders.pickup_time FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id LEFT JOIN orders ON order_items.order_id = orders.id LEFT JOIN tables ON orders.table_id = tables.id WHERE order_items.status='served' AND order_items.voided=0 AND (categories.is_bar=0 OR categories.is_bar IS NULL) AND order_items.served_at::date = CURRENT_DATE ORDER BY order_items.order_id ASC`);
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
    const ordersRes = await pool.query(`SELECT orders.*, tables.table_number, tables.id as table_id FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='open'`);
    const orders = ordersRes.rows;
    if (!orders.length) return res.json([]);
    const orderIds = orders.map(o => o.id);
    const itemsRes = await pool.query(`SELECT order_items.*, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id WHERE order_items.order_id = ANY($1) AND order_items.voided=0`, [orderIds]);
    const itemsByOrder = {};
    itemsRes.rows.forEach(item => { if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = []; itemsByOrder[item.order_id].push(item); });
    const result = orders.map(order => {
      const items = itemsByOrder[order.id] || [];
      const kitchenItems = items.filter(i => !i.is_bar);
      const starters = kitchenItems.filter(i => Number(i.course) === 1);
      const mains = kitchenItems.filter(i => Number(i.course) === 2);
      const desserts = kitchenItems.filter(i => Number(i.course) === 3);
      const hasFiredItems = kitchenItems.some(i => i.is_fired);
      let colourStatus = 'occupied';
      if (desserts.length > 0 && desserts.every(i => i.status === 'served')) colourStatus = 'desserts_done';
      else if (desserts.some(i => i.is_fired)) colourStatus = 'desserts_fired';
      else if (mains.length > 0 && mains.every(i => i.status === 'served')) colourStatus = 'mains_done';
      else if (mains.some(i => i.is_fired)) colourStatus = 'mains_fired';
      else if (starters.length > 0 && starters.every(i => i.status === 'served')) colourStatus = 'starters_done';
      else if (starters.some(i => i.is_fired)) colourStatus = 'starters_fired';
      if (order.bill_printed && !hasFiredItems) colourStatus = 'bill_printed';
      return { ...order, colour_status: colourStatus };
    });

    // SEPOS-044 — propagate occupied state across linked tables ONLY when
    // the party actually needs the linked group. Linked-table groups are
    // primarily a booking-widget capacity hack (e.g. 26+27+28+29 linked so
    // an online party of 8 sees availability) — most of the time staff
    // seat smaller parties at a single table within the group and the
    // other tables in the group should stay free for other walk-ins.
    // Rule: propagate iff order.covers > primary table.capacity.
    try {
      const [combosRes, tablesRes] = await Promise.all([
        pool.query('SELECT table_id_a, table_id_b FROM table_combinations'),
        pool.query('SELECT id, capacity FROM tables'),
      ]);
      const capacityById = {};
      for (const t of tablesRes.rows) capacityById[t.id] = Number(t.capacity) || 0;
      // Union-find to compute connected components.
      const parent = {};
      const find = (x) => parent[x] == null ? x : (parent[x] = find(parent[x]));
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
      for (const c of combosRes.rows) union(c.table_id_a, c.table_id_b);
      // Group → component members.
      const members = {};
      const allIds = new Set();
      for (const c of combosRes.rows) { allIds.add(c.table_id_a); allIds.add(c.table_id_b); }
      for (const id of allIds) (members[find(id)] ||= []).push(id);
      // Existing per-table colour map so we don't double-up.
      const have = new Map(result.map(r => [r.table_id, r]));
      for (const seedRow of result) {
        const primaryCap = capacityById[seedRow.table_id] || 0;
        const orderCovers = Number(seedRow.covers) || 0;
        // Single-table sitting → don't drag the rest of the group along.
        if (orderCovers <= primaryCap) continue;
        const root = find(seedRow.table_id);
        const groupMembers = members[root];
        if (!groupMembers) continue;
        for (const mId of groupMembers) {
          if (have.has(mId)) continue;
          have.set(mId, { ...seedRow, id: null, table_id: mId, linked_from: seedRow.table_id });
          result.push(have.get(mId));
        }
      }
    } catch (err) {
      console.warn('[tables/status] linked-table propagation skipped:', err.message);
    }

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bar/completed', async (req, res) => {
  try {
    const result = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id, tables.table_number, order_items.fired_at, order_items.served_at, orders.order_type, orders.customer_name, orders.pickup_time FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id LEFT JOIN orders ON order_items.order_id = orders.id LEFT JOIN tables ON orders.table_id = tables.id WHERE order_items.status='served' AND order_items.voided=0 AND categories.is_bar=1 AND order_items.served_at::date = CURRENT_DATE ORDER BY order_items.order_id ASC`);
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
    if (mergeRes.rows[0]) await pool.query("UPDATE tables SET status='available' WHERE id=$1", [mergeRes.rows[0].table_id]);
    await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [merge_order_id]);
    const totalRes = await pool.query('SELECT SUM(quantity * unit_price) as total FROM order_items WHERE order_id=$1 AND voided=0', [targetOrderId]);
    await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, targetOrderId]);
    io.emit('table_merged', { target_order_id: targetOrderId, merged_order_id: merge_order_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-042 — manager-gated order deletion.
// Used by Admin → Bills → Delete to remove a fault transaction.
// Validates the supplied PIN belongs to a manager / admin / supervisor,
// writes an audit row to order_deletions BEFORE the destructive deletes,
// then wipes order_items + payments + sale-source stock_movements, then
// the order itself. Each delete is independent (no transaction) so the
// per-step result tells us exactly what cleared.
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'invalid order id' });

    const { pin, reason } = req.body || {};
    if (!pin)    return res.status(400).json({ error: 'Manager PIN required' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });

    // Manager check — role must be one of these AND the staff must be active.
    const staffRes = await pool.query(
      `SELECT id, name, role FROM staff
       WHERE pin = $1 AND is_active = 1
         AND LOWER(role) IN ('manager','admin','supervisor')
       LIMIT 1`,
      [String(pin).trim()]
    );
    if (staffRes.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid manager PIN' });
    }
    const staff = staffRes.rows[0];

    // Snapshot the order for the audit row — last chance to read it.
    // Also grab cloud_id so we can mirror the delete on the cloud after
    // the local row is gone (column exists only on the SQLite mirror;
    // safe to ask for via COALESCE — cloud Postgres just returns null).
    let order;
    try {
      const ordRes = await pool.query(
        `SELECT id, total, order_type, opened_at, closed_at, status, table_id, cloud_id
         FROM orders WHERE id = $1`,
        [orderId]
      );
      if (ordRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      order = ordRes.rows[0];
    } catch (err) {
      // Postgres errors on unknown column cloud_id — retry without it.
      const ordRes = await pool.query(
        `SELECT id, total, order_type, opened_at, closed_at, status, table_id
         FROM orders WHERE id = $1`,
        [orderId]
      );
      if (ordRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      order = ordRes.rows[0];
    }

    // Audit row goes in FIRST so we have the record even if a later
    // step partially fails.
    await pool.query(
      `INSERT INTO order_deletions
       (order_id, staff_id, staff_name, reason, deleted_total, order_type, opened_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [order.id, staff.id, staff.name, String(reason).trim(),
       order.total, order.order_type, order.opened_at, order.closed_at]
    );

    // Step-by-step cleanup. Errors logged per step; the final response
    // tells the UI what cleared.
    const step = async (label, sql) => {
      try { const r = await pool.query(sql, [orderId]); return { ok: true, deleted: r.rowCount }; }
      catch (err) { console.warn(`[delete-order ${orderId}] ${label} failed:`, err.message); return { ok: false, error: err.message }; }
    };
    const steps = {
      payments:        await step('payments',        `DELETE FROM payments WHERE order_id = $1`),
      order_items:     await step('order_items',     `DELETE FROM order_items WHERE order_id = $1`),
      stock_movements: await step('stock_movements', `DELETE FROM stock_movements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`),
      order:           await step('order',           `DELETE FROM orders WHERE id = $1`),
    };

    // If the table was occupied by this order, free it.
    if (order.table_id) {
      try {
        await pool.query("UPDATE tables SET status='available' WHERE id = $1", [order.table_id]);
      } catch {}
    }

    // Mirror the delete on the cloud. On Mac (DB_MODE=local) this enqueues
    // a sync action so the next tick POSTs to the cloud-side
    // /api/sync/delete-order endpoint. On cloud mode the offlineQueue
    // helper is a no-op, so this line just falls through silently and
    // the in-process delete above IS the cloud delete.
    await offlineQueue.enqueue('delete_order', {
      localOrderId: orderId,
      cloudOrderId: order.cloud_id || orderId,  // cloud Mode: cloud_id == orderId
      staff_name:   staff.name,
      reason:       String(reason).trim(),
    });

    console.log(`[delete-order] order #${orderId} deleted by ${staff.name} (id ${staff.id}) — reason: "${reason.trim()}" — total £${order.total}`);
    io.emit('order_deleted', { order_id: orderId, by: staff.name });

    res.json({ success: steps.order.ok, order_id: orderId, deleted_by: staff.name, steps });
  } catch (err) {
    console.error('DELETE /api/orders/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-042 — cloud-side delete-order feed for sync push from the Mac.
// Gated by SYNC_SECRET (the Mac already validated the manager PIN
// locally; we don't replay PIN here, just trust the authenticated sync
// channel). Mirrors the same cascade-delete + audit-row pattern as the
// public DELETE /api/orders/:id endpoint.
app.post('/api/sync/delete-order', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server — sync deletes disabled' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });

  try {
    const orderId = parseInt(req.body?.order_id, 10);
    if (!orderId) return res.status(400).json({ error: 'order_id required' });
    const staffName = String(req.body?.staff_name || 'unknown').trim();
    const reason    = String(req.body?.reason || '').trim() || '(synced from Mac)';

    const ordRes = await pool.query(
      `SELECT id, total, order_type, opened_at, closed_at, table_id FROM orders WHERE id = $1`,
      [orderId]
    );
    if (ordRes.rows.length === 0) {
      // Already gone — idempotent success.
      return res.json({ success: true, already_deleted: true, order_id: orderId });
    }
    const order = ordRes.rows[0];

    await pool.query(
      `INSERT INTO order_deletions (order_id, staff_id, staff_name, reason, deleted_total, order_type, opened_at, closed_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
      [order.id, `${staffName} (sync)`, reason, order.total, order.order_type, order.opened_at, order.closed_at]
    );

    await pool.query(`DELETE FROM payments      WHERE order_id = $1`, [orderId]);
    await pool.query(`DELETE FROM stock_movements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`, [orderId]);
    await pool.query(`DELETE FROM order_items   WHERE order_id = $1`, [orderId]);
    await pool.query(`DELETE FROM orders        WHERE id = $1`, [orderId]);

    if (order.table_id) {
      try { await pool.query("UPDATE tables SET status='available' WHERE id = $1", [order.table_id]); } catch {}
    }

    console.log(`[sync-delete-order] order #${orderId} deleted via sync from ${staffName} — reason: "${reason}"`);
    io.emit('order_deleted', { order_id: orderId, by: `${staffName} (sync)` });
    res.json({ success: true, order_id: orderId });
  } catch (err) {
    console.error('POST /api/sync/delete-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/z-report/preview', async (req, res) => {
  try {
    const { from, to } = req.query;
    const [ordersRes, openRes, voidsRes, voidsByTypeRes, vatRowsRes] = await Promise.all([
      pool.query(`SELECT orders.*, tables.table_number, payments.method, payments.amount as paid_amount FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.closed_at >= $1::timestamp AND orders.closed_at <= $2::timestamp ORDER BY orders.closed_at DESC`, [from, to]),
      pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='open'`),
      pool.query(`SELECT COUNT(*) as void_count, SUM(order_items.unit_price * order_items.quantity) as void_value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp`, [from, to]),
      // SEPOS-023: breakdown by void_type
      pool.query(`SELECT COALESCE(order_items.void_type, 'Uncategorised') AS void_type, COUNT(*) AS count, COALESCE(SUM(order_items.unit_price * order_items.quantity), 0) AS value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp GROUP BY order_items.void_type ORDER BY value DESC`, [from, to]),
      // SEPOS-021: rows for VAT breakdown (aggregated in JS)
      pool.query(`SELECT COALESCE(mi.vat_rate, 20) AS vat_rate, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id LEFT JOIN orders o ON o.id = oi.order_id WHERE o.status='closed' AND oi.voided=0 AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp`, [from, to]),
    ]);
    const orders = ordersRes.rows;
    const voids = voidsRes.rows[0];
    const voidsByType = voidsByTypeRes.rows;

    // VAT breakdown — same maths as /api/reports/vat
    const vatBuckets = new Map();
    for (const row of vatRowsRes.rows) {
      const rate = Number(row.vat_rate ?? 20);
      let gross = Number(row.quantity || 0) * Number(row.unit_price || 0);
      if (row.discount_type === 'percent') gross *= 1 - (Number(row.discount_value || 0) / 100);
      else if (row.discount_type === 'fixed') gross = Math.max(0, gross - Number(row.discount_value || 0));
      const net = rate > 0 ? gross * (100 / (100 + rate)) : gross;
      const vat = gross - net;
      const b = vatBuckets.get(rate) || { rate, net: 0, vat: 0, gross: 0 };
      b.net += net; b.vat += vat; b.gross += gross;
      vatBuckets.set(rate, b);
    }
    const vatBreakdown = [...vatBuckets.values()].sort((a, b) => a.rate - b.rate);
    const vatTotal = vatBreakdown.reduce((a, b) => a + b.vat, 0);
    const totalSales = orders.reduce((s, o) => s + (o.total || 0), 0);
    const totalCovers = orders.reduce((s, o) => s + (o.covers || 0), 0);
    const totalCash = orders.filter(o => o.method === 'Cash').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalCard = orders.filter(o => o.method === 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalOther = orders.filter(o => o.method !== 'Cash' && o.method !== 'Card').reduce((s, o) => s + (o.paid_amount || 0), 0);
    const totalDiscounts = orders.reduce((s, o) => { if (!o.discount_value) return s; return s + (o.discount_type === 'percent' ? (o.total || 0) * (o.discount_value / 100) : o.discount_value); }, 0);
    const orderTypeSplit = splitByOrderType(orders);
    res.json({ orders, open_orders: openRes.rows, total_sales: totalSales, total_covers: totalCovers, total_orders: orders.length, total_cash: totalCash, total_card: totalCard, total_other: totalOther, total_discounts: totalDiscounts, void_count: voids?.void_count || 0, void_value: voids?.void_value || 0, voids_by_type: voidsByType, vat_breakdown: vatBreakdown, vat_total: vatTotal, avg_per_cover: totalCovers > 0 ? totalSales / totalCovers : 0, avg_per_order: orders.length > 0 ? totalSales / orders.length : 0, ...orderTypeSplit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/z-report/save', async (req, res) => {
  try {
    const { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference } = req.body;
    const result = await pool.query(
      `INSERT INTO z_reports (type, opened_at, closed_at, total_sales, total_cash, total_card, total_other, total_covers, total_orders, discounts, voids, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, report_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [type, from, to, data.total_sales, data.total_cash, data.total_card, data.total_other, data.total_covers, data.total_orders, data.total_discounts, data.void_count, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, JSON.stringify(data)]
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

app.get('/api/bills', async (req, res) => {
  try {
    const { from, to, method } = req.query;
    let query = `SELECT orders.id, orders.total, orders.covers, orders.closed_at, orders.discount_type, orders.discount_value, orders.discount_reason, tables.table_number, payments.method, payments.amount as paid_amount FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.total > 0 AND payments.method IS NOT NULL AND payments.method != 'cancelled'`;
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
    const result = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name, 'Deleted item') AS name FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id=$1 AND order_items.voided=0 ORDER BY order_items.course ASC`, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/:id/resend', async (req, res) => {
  try {
    const { item_ids, reason } = req.body;
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE order_items SET status='cooking', fired_at=$1, cooking_started_at=$1, resend_reason=$2 WHERE id = ANY($3::int[])`,
      [now, reason || null, item_ids]
    );
    // SEPOS-032: resend = kitchen makes the dish again → consume ingredients again
    await depleteStockForItems(item_ids, 'sale');
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [req.params.id]);
    const itemsRes = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.id = ANY($1::int[])`, [item_ids]);
    io.emit('course_fired', { order: orderRes.rows[0], course: 0, items: itemsRes.rows });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/order-items/:id/discount', async (req, res) => {
  try {
    const { discount_type, discount_value } = req.body;
    await pool.query('UPDATE order_items SET discount_type=$1, discount_value=$2 WHERE id=$3', [discount_type, discount_value, req.params.id]);
    const itemRes = await pool.query('SELECT order_id FROM order_items WHERE id=$1', [req.params.id]);
    if (itemRes.rows[0]) {
      const totalRes = await pool.query(`SELECT SUM(CASE WHEN discount_type = 'percent' THEN quantity * unit_price * (1 - COALESCE(discount_value,0)/100) WHEN discount_type = 'fixed' THEN GREATEST(0, quantity * unit_price - COALESCE(discount_value,0)) ELSE quantity * unit_price END) as total FROM order_items WHERE order_id=$1 AND voided=0`, [itemRes.rows[0].order_id]);
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, itemRes.rows[0].order_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// RESERVATIONS
// ─────────────────────────────────────────────

const widgetCors = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
};

// Helper to convert "HH:MM" string to total minutes
function toMins(t) {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// ── Availability — supports all_day and split (lunch/dinner) service ──
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
      service_type: 'all_day',
    };

    const requestedDate = new Date(date + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + (s.booking_advance_days || 60));
    if (requestedDate < today) return res.json({ slots: [], message: 'Date is in the past' });
    if (requestedDate > maxDate) return res.json({ slots: [], message: 'Date too far in advance' });

    const interval = s.slot_interval_mins || 15;

    // Build all possible slots based on service type
    let slots = [];
    if (s.service_type === 'split') {
      // Lunch window
      const lunchStart = toMins(s.lunch_service_start  || '11:00');
      const lunchEnd   = toMins(s.lunch_service_end    || '14:30');
      let cur = lunchStart;
      while (cur <= lunchEnd) {
        const h = Math.floor(cur / 60), m = cur % 60;
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        cur += interval;
      }
      // Dinner window
      const dinnerStart = toMins(s.dinner_service_start || '17:30');
      const dinnerEnd   = toMins(s.dinner_service_end   || '21:30');
      cur = dinnerStart;
      while (cur <= dinnerEnd) {
        const h = Math.floor(cur / 60), m = cur % 60;
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        cur += interval;
      }
    } else {
      // All day — single window
      const openEnd = toMins(s.last_booking_time || '21:30');
      let cur = toMins(s.opening_time || '11:00');
      while (cur <= openEnd) {
        const h = Math.floor(cur / 60), m = cur % 60;
        slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        cur += interval;
      }
    }

    // Fetch bookings with dining duration
    const bookingsRes = await pool.query(
      `SELECT TO_CHAR(r.reservation_time, 'HH24:MI') AS time_str, r.covers,
              COALESCE(d.duration_mins, 90) AS duration_mins
       FROM reservations r
       LEFT JOIN dining_duration_tiers d
         ON r.covers >= d.covers_min
         AND (d.covers_max IS NULL OR r.covers <= d.covers_max)
         AND d.restaurant_id = $2
       WHERE r.reservation_date = $1 AND r.restaurant_id = $2
         AND r.status NOT IN ('cancelled','no-show')`,
      [date, restaurant_id]
    );

    const bookings = bookingsRes.rows.map(r => {
      const startMins = toMins(r.time_str);
      return { startMins, covers: parseInt(r.covers, 10), endMins: startMins + parseInt(r.duration_mins, 10) };
    });

    const maxCovers = s.max_covers_per_slot || 20;
    const isToday   = requestedDate.toDateString() === new Date().toDateString();
    const nowMins   = isToday ? (new Date().getHours() * 60 + new Date().getMinutes() + (s.booking_lead_hours || 1) * 60) : -1;

    const result = slots.map(time => {
      const slotMins = toMins(time);
      const activeCovers = bookings.reduce((sum, b) => (b.startMins <= slotMins && b.endMins > slotMins ? sum + b.covers : sum), 0);
      const remaining    = maxCovers - activeCovers;
      const pastCutoff   = isToday && slotMins < nowMins;
      return { time, available: !pastCutoff && remaining >= coversNum, remaining_covers: Math.max(0, remaining), past: pastCutoff };
    });

    res.json({ date, covers: coversNum, restaurant_id, slots: result });
  } catch (err) {
    console.error('GET /api/reservations/availability error:', err);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// ── GET reservation settings — includes all new fields ──
app.get('/api/reservations/settings/:restaurantId', widgetCors, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT restaurant_id, restaurant_name, brand_colour,
              TO_CHAR(opening_time, 'HH24:MI')         AS opening_time,
              TO_CHAR(last_booking_time, 'HH24:MI')    AS last_booking_time,
              service_type,
              TO_CHAR(lunch_service_start, 'HH24:MI')  AS lunch_service_start,
              TO_CHAR(lunch_service_end, 'HH24:MI')    AS lunch_service_end,
              TO_CHAR(dinner_service_start, 'HH24:MI') AS dinner_service_start,
              TO_CHAR(dinner_service_end, 'HH24:MI')   AS dinner_service_end,
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
    let query = `SELECT r.*, TO_CHAR(r.reservation_date, 'YYYY-MM-DD') AS reservation_date, TO_CHAR(r.reservation_time, 'HH24:MI') AS reservation_time, t.name AS table_name FROM reservations r LEFT JOIN tables t ON r.table_id = t.id WHERE r.restaurant_id = $1`;
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
    const { restaurant_id = 'siamepos', customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, notes, source = 'widget', table_id = null, status = 'pending', marketing_consent = 0 } = req.body;
    if (!customer_name?.trim()) return res.status(400).json({ error: 'Guest name is required' });
    if (!customer_phone?.trim()) return res.status(400).json({ error: 'Phone number is required' });
    if (!reservation_date) return res.status(400).json({ error: 'Date is required' });
    if (!reservation_time) return res.status(400).json({ error: 'Time is required' });
    const coversNum = parseInt(covers, 10);
    if (!coversNum || coversNum < 1) return res.status(400).json({ error: 'Covers must be at least 1' });
    const slotCheck = await pool.query(`SELECT COALESCE(SUM(covers), 0) AS booked FROM reservations WHERE reservation_date = $1 AND TO_CHAR(reservation_time, 'HH24:MI') = $2 AND restaurant_id = $3 AND status NOT IN ('cancelled','no-show')`, [reservation_date, reservation_time.slice(0, 5), restaurant_id]);
    const settingsRes = await pool.query('SELECT max_covers_per_slot FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]);
    const maxCovers = settingsRes.rows[0]?.max_covers_per_slot || 20;
    const alreadyBooked = parseInt(slotCheck.rows[0]?.booked || 0, 10);
    if (alreadyBooked + coversNum > maxCovers) return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
    const insertStatus = source === 'widget' ? 'pending' : (status || 'pending');
    const result = await pool.query(
      `INSERT INTO reservations (restaurant_id, table_id, customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, status, notes, source, marketing_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [restaurant_id, table_id, customer_name.trim(), customer_phone.trim(), customer_email?.trim() || null, coversNum, reservation_date, reservation_time, insertStatus, notes?.trim() || null, source, marketing_consent ? 1 : 0]
    );
    const reservation = result.rows[0];
    io.emit('new_reservation', { ...reservation, reservation_date: String(reservation.reservation_date).split('T')[0], reservation_time: String(reservation.reservation_time).slice(0, 5) });
    if (customer_email) sendBookingConfirmation(reservation).catch(err => console.error('❌ Email error:', err.message));
    if (customer_phone) sendBookingSms(reservation).catch(() => {});
    console.log(`📅 New booking [${source}]: ${customer_name} ×${coversNum} on ${reservation_date} at ${reservation_time}`);
    if (process.env.MAKE_BOOKING_WEBHOOK) {
      const webhookData = JSON.stringify({ booking_id: reservation.id, customer_name: reservation.customer_name, customer_email: reservation.customer_email || null, customer_phone: reservation.customer_phone || null, covers: reservation.covers, reservation_date: String(reservation.reservation_date).split('T')[0], reservation_time: String(reservation.reservation_time).slice(0, 5), source: reservation.source, restaurant_name: process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant', restaurant_email: process.env.RESTAURANT_EMAIL || null });
      const webhookHttps = require('https');
      const webhookUrl = new URL(process.env.MAKE_BOOKING_WEBHOOK);
      const webhookReq = webhookHttps.request({ hostname: webhookUrl.hostname, path: webhookUrl.pathname + webhookUrl.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(webhookData) } });
      webhookReq.on('error', e => console.log('Make.com webhook error:', e.message));
      webhookReq.write(webhookData);
      webhookReq.end();
    }
    res.status(201).json({ success: true, booking_id: reservation.id, message: 'Booking received!', reservation: { id: reservation.id, customer_name: reservation.customer_name, covers: reservation.covers, reservation_date: String(reservation.reservation_date).split('T')[0], reservation_time: String(reservation.reservation_time).slice(0, 5), status: reservation.status } });
  } catch (err) { console.error('POST /api/reservations error:', err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.put('/api/reservations/:id', async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, table_id, notes, status } = req.body;
    const result = await pool.query(`UPDATE reservations SET customer_name=$1, customer_phone=$2, customer_email=$3, covers=$4, reservation_date=$5, reservation_time=$6, table_id=$7, notes=$8, status=$9, updated_at=NOW() WHERE id=$10 RETURNING *`, [customer_name, customer_phone, customer_email || null, covers, reservation_date, reservation_time, table_id || null, notes || null, status, req.params.id]);
    io.emit('reservation_updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-044: seating a reservation can now also assign it to a table
// AND open an order in one call. If table_id is supplied, it's saved on
// the reservation. If open_order is true, a new dine-in order is opened
// on that table and its id is returned alongside the reservation.
app.post('/api/reservations/:id/seat', async (req, res) => {
  try {
    const { table_id, staff_id, open_order } = req.body || {};
    const params = [req.params.id];
    let tableAssign = '';
    if (table_id !== undefined) {
      params.push(table_id || null);
      tableAssign = `, table_id=$${params.length}`;
    }
    const result = await pool.query(
      `UPDATE reservations SET status='seated'${tableAssign}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      params
    );
    const reservation = result.rows[0];
    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

    let order = null;
    if (reservation.table_id) {
      await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [reservation.table_id]);
      io.emit('tableStatusChanged', { id: reservation.table_id, status: 'occupied' });
      if (open_order) {
        const orderRes = await pool.query(
          "INSERT INTO orders (table_id, staff_id, status, covers, opened_at) VALUES ($1, $2, 'open', $3, NOW()) RETURNING *",
          [reservation.table_id, staff_id || null, reservation.covers || 1]
        );
        order = orderRes.rows[0];
        await offlineQueue.enqueue('create_order', {
          localOrderId: order.id, table_id: reservation.table_id,
          covers: reservation.covers || 1, staff_id: staff_id || null,
        });
      }
    }
    io.emit('reservation_updated', reservation);
    res.json({ reservation, order });
  } catch (err) {
    console.error('POST /api/reservations/:id/seat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-044: walk-in — create an instant reservation with source='walk_in'
// + status='seated' on a chosen table, and open an order in one call.
app.post('/api/reservations/walk-in', async (req, res) => {
  try {
    const {
      restaurant_id = 'siamepos',
      table_id, covers,
      customer_name = 'Walk-in', customer_phone = null, customer_email = null,
      staff_id = null, notes = null,
    } = req.body || {};
    if (!table_id) return res.status(400).json({ error: 'table_id required' });
    const coversNum = parseInt(covers, 10);
    if (!coversNum || coversNum < 1) return res.status(400).json({ error: 'covers must be at least 1' });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hhmm  = now.toTimeString().slice(0, 5);

    const resvIns = await pool.query(
      `INSERT INTO reservations
         (restaurant_id, table_id, customer_name, customer_phone, customer_email,
          covers, reservation_date, reservation_time, status, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seated',$9,'walk_in') RETURNING *`,
      [restaurant_id, table_id, customer_name.trim() || 'Walk-in',
       customer_phone, customer_email, coversNum, today, hhmm, notes]
    );
    const reservation = resvIns.rows[0];

    const orderRes = await pool.query(
      "INSERT INTO orders (table_id, staff_id, status, covers, opened_at) VALUES ($1, $2, 'open', $3, NOW()) RETURNING *",
      [table_id, staff_id, coversNum]
    );
    const order = orderRes.rows[0];

    await pool.query("UPDATE tables SET status='occupied' WHERE id=$1", [table_id]);
    await offlineQueue.enqueue('create_order', {
      localOrderId: order.id, table_id, covers: coversNum, staff_id,
    });

    io.emit('new_reservation', reservation);
    io.emit('tableStatusChanged', { id: table_id, status: 'occupied' });
    res.json({ reservation, order });
  } catch (err) {
    console.error('POST /api/reservations/walk-in error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE reservations SET status='cancelled', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    io.emit('reservation_cancelled', { id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT reservation settings — saves all fields including lunch/dinner ──
app.put('/api/reservations/settings/:restaurantId', async (req, res) => {
  try {
    const {
      restaurant_name, brand_colour, opening_time, last_booking_time,
      service_type, lunch_service_start, lunch_service_end,
      dinner_service_start, dinner_service_end,
      slot_interval_mins, max_covers_per_slot,
      booking_lead_hours, booking_advance_days, is_active,
    } = req.body;
    await pool.query(
      `INSERT INTO restaurant_settings
         (restaurant_id, restaurant_name, brand_colour, opening_time, last_booking_time,
          service_type, lunch_service_start, lunch_service_end,
          dinner_service_start, dinner_service_end,
          slot_interval_mins, max_covers_per_slot, booking_lead_hours, booking_advance_days, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (restaurant_id) DO UPDATE SET
         restaurant_name      = EXCLUDED.restaurant_name,
         brand_colour         = EXCLUDED.brand_colour,
         opening_time         = EXCLUDED.opening_time,
         last_booking_time    = EXCLUDED.last_booking_time,
         service_type         = EXCLUDED.service_type,
         lunch_service_start  = EXCLUDED.lunch_service_start,
         lunch_service_end    = EXCLUDED.lunch_service_end,
         dinner_service_start = EXCLUDED.dinner_service_start,
         dinner_service_end   = EXCLUDED.dinner_service_end,
         slot_interval_mins   = EXCLUDED.slot_interval_mins,
         max_covers_per_slot  = EXCLUDED.max_covers_per_slot,
         booking_lead_hours   = EXCLUDED.booking_lead_hours,
         booking_advance_days = EXCLUDED.booking_advance_days,
         is_active            = EXCLUDED.is_active`,
      [req.params.restaurantId, restaurant_name, brand_colour, opening_time, last_booking_time,
       service_type || 'all_day', lunch_service_start || '11:00', lunch_service_end || '14:30',
       dinner_service_start || '17:30', dinner_service_end || '21:30',
       slot_interval_mins, max_covers_per_slot, booking_lead_hours, booking_advance_days, is_active]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/import-batch', async (req, res) => {
  const client = await pool.connect();
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No items provided' });
    const catRes = await client.query('SELECT id, name FROM categories');
    const categories = catRes.rows;
    function findCategoryId(categoryName) {
      if (!categoryName) return null;
      const search = categoryName.toLowerCase().trim();
      let match = categories.find(c => c.name.toLowerCase() === search);
      if (match) return match.id;
      match = categories.find(c => c.name.toLowerCase().includes(search) || search.includes(c.name.toLowerCase()));
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
        if (Array.isArray(item.allergens) && item.allergens.length > 0) allergensStr = JSON.stringify(item.allergens);
        else if (typeof item.allergens === 'string' && item.allergens.trim()) allergensStr = JSON.stringify([item.allergens]);
        const insertRes = await client.query(`INSERT INTO menu_items (category_id, name, name_alt, description, price, allergens, is_available) VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, name`, [categoryId, item.name_en.trim(), item.name_th ? item.name_th.trim() : null, item.description ? item.description.trim() : null, price, allergensStr]);
        results.inserted.push({ id: insertRes.rows[0].id, name: insertRes.rows[0].name, category_id: categoryId, category_name: item.category || null });
      } catch (itemErr) { results.errors.push({ item, error: itemErr.message }); }
    }
    await client.query('COMMIT');
    res.json({ success: true, summary: { total: items.length, inserted: results.inserted.length, skipped: results.skipped.length, errors: results.errors.length }, inserted: results.inserted, skipped: results.skipped, errors: results.errors });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.post('/api/ai/scan-menu', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on Railway' });
    const isImage = media_type && media_type.startsWith('image/');
    const contentItem = isImage ? { type: 'image', source: { type: 'base64', media_type, data: image_base64 } } : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } };
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: [contentItem, { type: 'text', text: `You are an expert restaurant menu reader and UK food safety specialist.\n\nAnalyse this menu image/document and extract ALL dishes. For each dish provide:\n1. English name\n2. Thai name (transliterate or translate)\n3. Short appetising description (1-2 sentences)\n4. Price in GBP — exact if visible, estimated if not. Mark assumed prices.\n5. UK 14 allergens — gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, nuts, celery, mustard, sesame, sulphites, lupin, molluscs. Fish sauce is in almost all Thai food.\n6. Category (Starters, Mains, Curries, Noodles, Rice Dishes, Salads, Desserts, Drinks, Sides)\n7. Confidence score 0-100\n\nReturn ONLY valid JSON, no markdown, no explanation:\n{\n  "restaurant_type": "Thai Restaurant",\n  "total_dishes": 0,\n  "categories": [\n    {\n      "name": "Category Name",\n      "dishes": [\n        {\n          "name_en": "English Name",\n          "name_th": "ชื่อภาษาไทย",\n          "description": "Description",\n          "price": 12.50,\n          "price_assumed": false,\n          "allergens": ["Fish","Soybeans"],\n          "confidence": 95\n        }\n      ]\n    }\n  ]\n}` }] }] });
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) { console.error('Anthropic error:', result.body); return res.status(502).json({ error: 'Anthropic API error' }); }
    const data = JSON.parse(result.body);
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    let menu;
    try { menu = JSON.parse(clean); } catch (parseErr) { return res.status(500).json({ error: 'AI returned invalid JSON — try again with a clearer image' }); }
    console.log(`🍜 Menu scan complete: ${menu.total_dishes || '?'} dishes`);
    res.json({ success: true, menu });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/scan-invoice', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });
    const INVOICE_PROMPT = `You are reading a supplier invoice or delivery note for a restaurant.\nExtract all information and return ONLY a valid JSON object — no other text, no markdown, no explanation.\n\nRequired JSON structure:\n{\n  "supplier_name": "string",\n  "invoice_date": "YYYY-MM-DD",\n  "invoice_number": "string",\n  "total_amount": number,\n  "line_items": [\n    { "name": "string", "quantity": number, "unit": "string", "unit_price": number, "line_total": number }\n  ]\n}\n\nRules: If a value is missing use null for strings and 0 for numbers. Convert prices to GBP. Return ONLY the JSON object.`;
    const https = require('https');
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } }, { type: 'text', text: INVOICE_PROMPT }] }] });
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) throw new Error(`Anthropic API error: ${result.body}`);
    const aiData = JSON.parse(result.body);
    const invoice = JSON.parse(aiData.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return res.json({ success: true, invoice });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/ai/scan-expense', async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });
    const EXPENSE_PROMPT = `You are reading a receipt, bill or expense document for a restaurant.\nExtract the key information and return ONLY a valid JSON object — no other text, no markdown.\n\nRequired JSON structure:\n{\n  "vendor": "string", "date": "YYYY-MM-DD", "total_amount": number,\n  "description": "string", "category": "overhead|labour|other",\n  "line_items": [{ "description": "string", "amount": number }]\n}\n\nCategory: overhead=rent/utilities/insurance/repairs, labour=wages/staff, other=equipment/misc. Return ONLY JSON.`;
    const https = require('https');
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } }, { type: 'text', text: EXPENSE_PROMPT }] }] });
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) throw new Error(`Anthropic API error: ${result.body}`);
    const aiData = JSON.parse(result.body);
    const expense = JSON.parse(aiData.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return res.json({ success: true, expense });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/expenses', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM expenses ORDER BY date DESC, created_at DESC`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!description || !amount) return res.status(400).json({ error: 'description and amount are required' });
    const result = await pool.query(`INSERT INTO expenses (category, description, amount, date) VALUES ($1,$2,$3,$4) RETURNING id`, [category || 'other', description, parseFloat(amount), date || new Date().toISOString().split('T')[0]]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try { const result = await pool.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]); res.json({ success: true, deleted: result.rowCount }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/supplier-invoices', async (req, res) => {
  try {
    const { supplier_name, invoice_date, invoice_number, total_amount, status } = req.body;
    const result = await pool.query(`INSERT INTO supplier_invoices (supplier_name, invoice_date, invoice_number, total_amount, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [supplier_name, invoice_date, invoice_number, parseFloat(total_amount) || 0, status || 'processed']);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supplier-invoices', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM supplier_invoices ORDER BY created_at DESC LIMIT 100`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ingredients', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM ingredients ORDER BY category, name_en`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ingredients/low-stock', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM ingredients WHERE par_level IS NOT NULL AND current_stock < par_level ORDER BY name_en`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ingredients', async (req, res) => {
  try {
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens } = req.body;
    const result = await pool.query(`INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id`, [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100, category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]']);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/ingredients/:id', async (req, res) => {
  try {
    const { name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, par_level, supplier_name, allergens } = req.body;
    const result = await pool.query(`UPDATE ingredients SET name_en=$1, name_th=$2, unit=$3, cost_per_unit=$4, yield_percentage=$5, category=$6, current_stock=$7, par_level=$8, supplier_name=$9, allergens=$10, updated_at=NOW() WHERE id=$11`, [name_en, name_th || '', unit || 'kg', parseFloat(cost_per_unit) || 0, parseFloat(yield_percentage) || 100, category || 'Other', parseFloat(current_stock) || 0, par_level ? parseFloat(par_level) : null, supplier_name || '', allergens || '[]', req.params.id]);
    res.json({ success: true, changes: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ingredients/:id', async (req, res) => {
  try { await pool.query(`DELETE FROM ingredients WHERE id = $1`, [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/recipes', async (req, res) => {
  try {
    const recipesRes = await pool.query(`SELECT * FROM recipes ORDER BY name`);
    const recipes = recipesRes.rows;
    if (!recipes.length) return res.json([]);
    const recipeIds = recipes.map(r => r.id);
    const linesRes = await pool.query(`SELECT rl.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.cost_per_unit, i.yield_percentage FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.recipe_id = ANY($1)`, [recipeIds]);
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
    const linesRes = await pool.query(`SELECT rl.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.cost_per_unit, i.yield_percentage FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.recipe_id = $1`, [recipe.id]);
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
    const recipeRes = await client.query(`INSERT INTO recipes (menu_item_id, name, serves, total_cost, cost_per_portion, last_calculated) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`, [menu_item_id, name, serves || 1, totalCost, costPerPortion]);
    const recipeId = recipeRes.rows[0].id;
    for (const l of (lines || [])) await client.query(`INSERT INTO recipe_lines (recipe_id, ingredient_id, quantity_used, unit, line_cost) VALUES ($1,$2,$3,$4,$5)`, [recipeId, l.ingredient_id, l.quantity_used, l.unit, l.line_cost]);
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
    await client.query(`UPDATE recipes SET name=$1, serves=$2, total_cost=$3, cost_per_portion=$4, last_calculated=NOW() WHERE id=$5`, [name, serves || 1, totalCost, costPerPortion, req.params.id]);
    await client.query(`DELETE FROM recipe_lines WHERE recipe_id = $1`, [req.params.id]);
    for (const l of (lines || [])) await client.query(`INSERT INTO recipe_lines (recipe_id, ingredient_id, quantity_used, unit, line_cost) VALUES ($1,$2,$3,$4,$5)`, [req.params.id, l.ingredient_id, l.quantity_used, l.unit, l.line_cost]);
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

app.get('/api/stock/movements', async (req, res) => {
  try { const result = await pool.query(`SELECT sm.*, i.name_en as ingredient_name, i.name_th as ingredient_name_th, i.unit FROM stock_movements sm LEFT JOIN ingredients i ON i.id = sm.ingredient_id ORDER BY sm.created_at DESC LIMIT 500`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stock/adjustment', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ingredient_id, quantity, movement_type, cost_at_time, note, reference } = req.body;
    if (!ingredient_id || quantity == null) return res.status(400).json({ error: 'ingredient_id and quantity required' });
    await client.query('BEGIN');
    const insertRes = await client.query(`INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ingredient_id, movement_type || 'adjustment', parseFloat(quantity), parseFloat(cost_at_time) || 0, note || '', reference || '']);
    const qty = parseFloat(quantity);
    const delta = (movement_type === 'waste' || qty < 0) ? -Math.abs(qty) : Math.abs(qty);
    await client.query(`UPDATE ingredients SET current_stock = GREATEST(0, current_stock + $1), updated_at=NOW() WHERE id=$2`, [delta, ingredient_id]);
    await client.query('COMMIT');
    res.json({ id: insertRes.rows[0].id, success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.get('/api/dish-allergens', async (req, res) => {
  try { const result = await pool.query(`SELECT * FROM dish_allergens`); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dish-allergens/:menuItemId', async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { allergens } = req.body;
    const result = await pool.query(`INSERT INTO dish_allergens (menu_item_id, allergens, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (menu_item_id) DO UPDATE SET allergens = EXCLUDED.allergens, updated_at = EXCLUDED.updated_at RETURNING id`, [menuItemId, allergens || '[]']);
    res.json({ success: true, id: result.rows[0]?.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
  console.log('Screen connected:', socket.id);
  socket.on('disconnect', () => console.log('Screen disconnected:', socket.id));
});

// LAN address of this server — used by the React Settings page to render
// a QR code that kitchen / bar tablets can scan. Prefers RFC1918 private
// ranges and skips VPN/tunnel interface names so a Tailscale or corp-VPN
// address isn't advertised by mistake.
app.get('/api/network-info', (req, res) => {
  const os = require('os');
  const port = process.env.PORT || 3001;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (/^(tun|utun|tap|ipsec|vpn|wg|zt)/i.test(name)) continue;
    for (const iface of (ifaces[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(iface.address)) {
        return res.json({ ip: iface.address, port, url: `http://${iface.address}:${port}` });
      }
    }
  }
  res.json({ ip: '127.0.0.1', port, url: `http://127.0.0.1:${port}` });
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-034 — Online takeaway ordering
// Public widget posts here. Mock payment for the sales demo;
// Stripe wiring deferred to SEPOS-040.
// ─────────────────────────────────────────────────────────────────────

// Public settings the widget needs — opening hours + restaurant name —
// without leaking the rest of restaurant_settings.
app.get('/api/takeaway/settings', widgetCors, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT restaurant_name, opening_time, last_booking_time,
             service_type, lunch_service_start, lunch_service_end,
             dinner_service_start, dinner_service_end
      FROM restaurant_settings WHERE restaurant_id = $1
    `, [process.env.RESTAURANT_ID || 'siamepos']);
    res.json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit a takeaway order from the public widget.
app.post('/api/takeaway/orders', widgetCors, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name, customer_phone, customer_email,
      pickup_time,    // ISO timestamp
      items = [],     // [{ menu_item_id, quantity, unit_price, name, item_note }]
      notes,
      marketing_consent,
    } = req.body;

    if (!customer_name || !customer_name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!customer_phone || !customer_phone.trim()) return res.status(400).json({ error: 'Phone is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    if (!pickup_time) return res.status(400).json({ error: 'Pickup time is required' });

    // Closed-hours check — pickup_time must fall within the restaurant's
    // opening_time .. last_booking_time window. Soft validation: if
    // restaurant_settings is missing we let it through.
    const settingsRes = await client.query(
      `SELECT opening_time, last_booking_time FROM restaurant_settings WHERE restaurant_id = $1`,
      [process.env.RESTAURANT_ID || 'siamepos']
    );
    const settings = settingsRes.rows[0];
    if (settings) {
      const pickupDate = new Date(pickup_time);
      if (isNaN(pickupDate.getTime())) return res.status(400).json({ error: 'Invalid pickup time' });
      const mins = pickupDate.getHours() * 60 + pickupDate.getMinutes();
      const openMins  = toMins(settings.opening_time      || '11:00');
      const closeMins = toMins(settings.last_booking_time || '21:30');
      if (mins < openMins || mins > closeMins) {
        return res.status(400).json({ error: `Pickup time must be between ${String(settings.opening_time).slice(0,5)} and ${String(settings.last_booking_time).slice(0,5)}.` });
      }
    }

    // Compute total from items × unit_price (server is the source of truth).
    const total = items.reduce((s, i) => s + Number(i.unit_price || 0) * Number(i.quantity || 0), 0);

    await client.query('BEGIN');
    const orderRes = await client.query(
      `INSERT INTO orders
         (table_id, status, covers, total, opened_at,
          order_type, customer_name, customer_phone, customer_email,
          pickup_time, takeaway_status, payment_status, discount_reason)
       VALUES (NULL, 'open', 1, $1, NOW(),
               'takeaway', $2, $3, $4,
               $5, 'pending', 'mock', $6)
       RETURNING id`,
      [total, customer_name.trim(), customer_phone.trim(), (customer_email || '').trim() || null,
       pickup_time, notes || null]
    );
    const orderId = orderRes.rows[0].id;

    // Each item goes in as fired (status='cooking') so the kitchen picks
    // it up immediately — takeaway flows skip the dine-in fire-course step.
    const now = new Date().toISOString();
    const insertedItemIds = [];
    for (const it of items) {
      const ins = await client.query(
        `INSERT INTO order_items
           (order_id, menu_item_id, item_name, quantity, unit_price, notes, course,
            item_note, is_fired, fired_at, cooking_started_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 1, $8, $8, 'cooking') RETURNING id`,
        [orderId, it.menu_item_id || null, it.name || 'Item',
         it.quantity || 1, it.unit_price || 0,
         it.modifiers ? (Array.isArray(it.modifiers) ? it.modifiers.map(m => m.name).join(', ') : String(it.modifiers)) : '',
         it.item_note || '', now]
      );
      insertedItemIds.push(ins.rows[0].id);
    }
    await client.query('COMMIT');

    // Stock depletion (best effort) — done outside the transaction so a
    // failure here doesn't roll back the order.
    try { await depleteStockForItems(insertedItemIds, 'sale'); } catch {}

    // Best-effort optional marketing consent capture (Phase 1 CRM).
    if (customer_email && marketing_consent) {
      // We don't have a "marketing_signups" table — the booking widget
      // captures consent on reservations. For takeaway we'd want a CRM
      // join too, but that's the next refinement. For now: log.
      console.log('[takeaway] marketing consent captured for', customer_email);
    }

    // Kitchen iPad listens to this — pops up the ticket instantly.
    io.emit('new_takeaway_order', {
      id: orderId,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      pickup_time,
      total,
      item_count: items.length,
    });

    // Fire-and-forget email confirmation via Brevo.
    if (customer_email) {
      sendTakeawayConfirmation({
        order_id: orderId,
        customer_name, customer_email,
        pickup_time, items, total,
      }).catch(err => console.error('[takeaway] email error:', err.message));
    }

    console.log(`🥡 New takeaway #${orderId} · ${customer_name} · £${total.toFixed(2)} · pickup ${pickup_time}`);
    res.status(201).json({
      success: true,
      order_id: orderId,
      // Reference number to show on the success page. Pads to 4 digits
      // so the customer has something to quote when collecting.
      order_number: 'T' + String(orderId).padStart(4, '0'),
      total,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/takeaway/orders error:', err);
    res.status(500).json({ error: 'Could not place order. Please try again.' });
  } finally {
    client.release();
  }
});

// Active takeaway orders — for kitchen view + Mac sync pull.
app.get('/api/takeaway/orders/active', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.id, o.customer_name, o.customer_phone, o.customer_email,
             o.pickup_time, o.takeaway_status, o.total, o.opened_at
      FROM orders o
      WHERE o.order_type = 'takeaway'
        AND COALESCE(o.takeaway_status, 'pending') <> 'collected'
        AND o.status <> 'closed'
      ORDER BY o.pickup_time ASC NULLS LAST, o.id ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Status transitions — kitchen / admin use.
app.put('/api/orders/:id/takeaway-status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'accepted', 'preparing', 'ready', 'collected'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await pool.query('UPDATE orders SET takeaway_status=$1 WHERE id=$2 AND order_type=\'takeaway\'', [status, req.params.id]);
    if (status === 'collected') {
      await pool.query("UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1", [req.params.id]);
      await pool.query("UPDATE order_items SET status='served', served_at=NOW() WHERE order_id=$1 AND status<>'served'", [req.params.id]);
    }
    io.emit('takeaway_status', { order_id: Number(req.params.id), status });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Brevo confirmation email — same template flavour as booking confirmation.
async function sendTakeawayConfirmation({ order_id, customer_name, customer_email, pickup_time, items, total }) {
  const { sendBrevoEmail } = require('./services/emailService');
  if (!process.env.BREVO_API_KEY) return;
  const restaurantName = process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant';
  const orderNumber = 'T' + String(order_id).padStart(4, '0');
  const pickupDate = new Date(pickup_time);
  // Pin to Europe/London — Railway runs in UTC so without timeZone the
  // email would render the underlying UTC value (1h behind BST in summer).
  const TZ = 'Europe/London';
  const pickupStr = pickupDate.toLocaleDateString('en-GB', { weekday:'long', day:'2-digit', month:'short', timeZone: TZ }) +
                    ' at ' + pickupDate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone: TZ });
  const itemRows = items.map(i => `
    <tr>
      <td style="padding:6px 0;">${i.quantity}× ${String(i.name || 'Item').replace(/[<>]/g,'')}</td>
      <td style="padding:6px 0;text-align:right;">£${(Number(i.unit_price || 0) * Number(i.quantity || 0)).toFixed(2)}</td>
    </tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,sans-serif;color:#1a1a2e;">
  <table cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:24px 0;"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <tr><td style="background:#0D1B3E;padding:24px 30px;color:#C9A84C;font-family:Georgia,serif;font-size:24px;font-weight:700;">${restaurantName}</td></tr>
      <tr><td style="padding:30px;font-size:15px;line-height:1.6;color:#1a1a2e;">
        <p>Hi ${String(customer_name).replace(/[<>]/g,'')},</p>
        <p>Thanks for your takeaway order. We'll have it ready for collection at:</p>
        <p style="background:#fef3c7;padding:14px 18px;border-radius:10px;font-weight:700;text-align:center;">🥡 ${pickupStr}</p>
        <p>Your order number is <strong style="font-size:18px;color:#C9A84C;">${orderNumber}</strong> — please quote this when collecting.</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">
          ${itemRows}
          <tr><td style="padding:10px 0 6px;border-top:2px solid #eee;font-weight:800;">Total</td>
              <td style="padding:10px 0 6px;border-top:2px solid #eee;text-align:right;font-weight:800;">£${Number(total).toFixed(2)}</td></tr>
        </table>
        <p style="color:#888;font-size:13px;">Payment on collection. Cash or card accepted.</p>
      </td></tr>
      <tr><td style="padding:20px 30px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#888;">
        ${restaurantName} — see you soon!
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  await sendBrevoEmail(customer_email, `Takeaway order ${orderNumber} confirmed`, html);
}

// Manual opt-in / opt-out toggle for a customer email. Used by the
// Customers tab when an operator gets legitimate consent off-widget
// (verbal at the table, phone booking, etc.) and wants the customer
// to start showing up in campaign segments.
app.put('/api/customers/marketing-consent', async (req, res) => {
  try {
    const { email, consent } = req.body;
    if (!email || !email.trim()) return res.status(400).json({ error: 'email required' });
    const optIn = !!consent;
    const emailKey = String(email).trim().toLowerCase();
    if (optIn) {
      // Flip every reservation row with this email to consented + clear any
      // prior unsubscribe so they're eligible immediately.
      await pool.query(
        `UPDATE reservations SET marketing_consent = 1, unsubscribed_at = NULL
         WHERE LOWER(TRIM(customer_email)) = $1`,
        [emailKey]
      );
    } else {
      await pool.query(
        `UPDATE reservations SET marketing_consent = 0
         WHERE LOWER(TRIM(customer_email)) = $1`,
        [emailKey]
      );
    }
    res.json({ success: true, email: emailKey, consent: optIn });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-033 Phase 2 — email campaigns + unsubscribe
// ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
function unsubscribeToken(email) {
  const secret = process.env.UNSUB_SECRET || 'siamepos-default-unsub-secret-change-me';
  const e = String(email || '').trim().toLowerCase();
  const hmac = crypto.createHmac('sha256', secret).update(e).digest('hex').slice(0, 16);
  return Buffer.from(e).toString('base64url') + '.' + hmac;
}
function parseUnsubscribeToken(token) {
  try {
    const [b64, hmac] = String(token || '').split('.');
    if (!b64 || !hmac) return null;
    const email = Buffer.from(b64, 'base64url').toString('utf8');
    const secret = process.env.UNSUB_SECRET || 'siamepos-default-unsub-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(email).digest('hex').slice(0, 16);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return null;
    return email;
  } catch { return null; }
}

function buildCampaignEmail({ subject, body, customer_name, customer_email, restaurantName, restaurantAddress }) {
  const safeName = (customer_name || 'there').replace(/[<>]/g, '');
  const personalisedBody = String(body || '').replace(/\{\{\s*name\s*\}\}/gi, safeName);
  const unsubUrl = `${process.env.PUBLIC_API_URL || 'https://restaurant-epos-production.up.railway.app'}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(customer_email))}`;
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a2e;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr><td style="background:#0D1B3E;padding:24px 30px;color:#C9A84C;font-family:Georgia,serif;font-size:24px;font-weight:700;">${restaurantName}</td></tr>
        <tr><td style="padding:30px;line-height:1.6;font-size:15px;color:#1a1a2e;">${personalisedBody}</td></tr>
        <tr><td style="padding:20px 30px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#888;line-height:1.5;">
          <div style="margin-bottom:6px;"><strong>${restaurantName}</strong>${restaurantAddress ? ' · ' + restaurantAddress : ''}</div>
          <div>You're receiving this because you booked a table with us and opted in to marketing emails.
            <a href="${unsubUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a> at any time.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
  return html;
}

async function fetchCustomersForSegment(segment) {
  // Reuse the same aggregation as /api/customers but inline so we can
  // filter at SQL level for consent + unsubscribed.
  const r = await pool.query(`
    SELECT LOWER(TRIM(r.customer_email)) AS email_key,
           MIN(r.customer_email) AS customer_email,
           MIN(r.customer_name) AS customer_name,
           COUNT(DISTINCT r.id) AS total_visits,
           MAX(r.reservation_date) AS last_visit,
           COALESCE(SUM(o.total), 0) AS total_spend,
           MAX(CASE WHEN r.unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed,
           MAX(COALESCE(r.marketing_consent, 0)) AS marketing_consent
    FROM reservations r
    LEFT JOIN orders o
      ON o.table_id = r.table_id
     AND DATE(o.opened_at) = r.reservation_date
     AND o.status = 'closed'
    WHERE r.customer_email IS NOT NULL AND TRIM(r.customer_email) <> ''
    GROUP BY LOWER(TRIM(r.customer_email))
  `);
  const today = new Date();
  return r.rows
    .filter(c => Number(c.unsubscribed) === 0 && Number(c.marketing_consent) === 1)
    .map(c => {
      const visits = Number(c.total_visits || 0);
      const spend  = Number(c.total_spend  || 0);
      const days   = c.last_visit ? Math.floor((today - new Date(c.last_visit)) / 86400000) : null;
      let status;
      if (days !== null && days > 60) status = 'Lapsed';
      else if (visits >= 5 || spend >= 200) status = 'VIP';
      else if (visits >= 2) status = 'Regular';
      else status = 'New';
      return { ...c, status };
    })
    .filter(c => segment === 'All' || c.status === segment);
}

// Public unsubscribe endpoint — clicked from inside an email
app.get('/api/unsubscribe', async (req, res) => {
  const email = parseUnsubscribeToken(req.query.token);
  if (!email) {
    return res.status(400).type('html').send(
      '<html><body style="font-family:sans-serif;padding:60px;text-align:center;color:#555;">Invalid unsubscribe link.</body></html>'
    );
  }
  try {
    await pool.query(
      `UPDATE reservations SET unsubscribed_at = NOW() WHERE LOWER(TRIM(customer_email)) = $1 AND unsubscribed_at IS NULL`,
      [email]
    );
    res.type('html').send(`
      <html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:60px;text-align:center;color:#1a1a2e;background:#f5f5f5;min-height:100vh;margin:0;">
        <div style="background:white;max-width:480px;margin:60px auto;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <h1 style="color:#C9A84C;font-family:Georgia,serif;">You're unsubscribed</h1>
          <p style="color:#555;line-height:1.6;">We've removed <strong>${email.replace(/[<>"]/g, '')}</strong> from our marketing list. You won't receive any more promotional emails from us.</p>
          <p style="color:#888;font-size:13px;margin-top:30px;">If this was a mistake, contact the restaurant to opt back in.</p>
        </div>
      </body></html>`);
  } catch (err) {
    res.status(500).type('html').send('<html><body>Something went wrong. Please try again later.</body></html>');
  }
});

// Count recipients for a segment before sending — let the UI show
// "Send to N people" without leaking the full list to the renderer.
app.get('/api/campaigns/recipient-count', async (req, res) => {
  try {
    const list = await fetchCustomersForSegment(req.query.segment || 'All');
    res.json({ count: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Past campaigns (newest first)
app.get('/api/campaigns', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, subject, segment, recipient_count, sent_count, failed_count, created_at FROM campaigns ORDER BY id DESC LIMIT 50');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send a campaign. Reads {subject, body, segment}, resolves recipient list,
// fires Brevo sends sequentially, records the campaign + counts.
app.post('/api/campaigns/send', async (req, res) => {
  try {
    const { subject, body, segment } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body    || !body.trim())    return res.status(400).json({ error: 'Body is required' });
    if (!process.env.BREVO_API_KEY)  return res.status(500).json({ error: 'BREVO_API_KEY is not set on the server' });
    const recipients = await fetchCustomersForSegment(segment || 'All');
    if (recipients.length === 0)     return res.status(400).json({ error: 'No opted-in customers in this segment' });

    const camp = await pool.query(
      `INSERT INTO campaigns (subject, body, segment, recipient_count) VALUES ($1,$2,$3,$4) RETURNING id`,
      [subject.trim(), body, segment || 'All', recipients.length]
    );
    const campaignId = camp.rows[0].id;

    const restaurantName    = process.env.RESTAURANT_NAME    || 'SiamEPOS Restaurant';
    const restaurantAddress = process.env.RESTAURANT_ADDRESS || '';
    const { sendBrevoEmail } = require('./services/emailService');

    let sent = 0, failed = 0;
    for (const c of recipients) {
      const html = buildCampaignEmail({
        subject, body,
        customer_name:  c.customer_name,
        customer_email: c.customer_email,
        restaurantName, restaurantAddress,
      });
      try {
        await sendBrevoEmail(c.customer_email, subject, html);
        sent++;
      } catch (err) {
        console.error('[campaign] send failed for', c.customer_email, err.message);
        failed++;
      }
    }
    await pool.query('UPDATE campaigns SET sent_count=$1, failed_count=$2 WHERE id=$3', [sent, failed, campaignId]);
    res.json({ success: true, campaign_id: campaignId, recipient_count: recipients.length, sent, failed });
  } catch (err) {
    console.error('POST /api/campaigns/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-033 — customer CRM
// Aggregates the reservations table by email (case-insensitive) to give
// the owner a customer list with visit counts, first/last visit, status
// (VIP / Regular / New / Lapsed) and an estimated total spend.
//
// Spend estimate uses a heuristic: orders on the reserved table on the
// reservation date. Marked "estimated" in the UI — accuracy needs a
// proper orders.reservation_id link (separate ticket).
// ─────────────────────────────────────────────────────────────────────
app.get('/api/customers', async (req, res) => {
  try {
    // Pull reservations + their estimated spend in one query. The spend
    // join is intentionally loose (table + date) — multiple reservations
    // at the same table on the same day will currently share the spend,
    // which we accept for v1.
    const r = await pool.query(`
      SELECT
        LOWER(TRIM(r.customer_email)) AS email_key,
        MIN(r.customer_email) AS customer_email,
        MIN(r.customer_name) AS customer_name,
        MIN(r.customer_phone) AS customer_phone,
        MAX(COALESCE(r.marketing_consent, 0)) AS marketing_consent,
        MAX(CASE WHEN r.unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed,
        COUNT(DISTINCT r.id) AS total_visits,
        MIN(r.reservation_date) AS first_visit,
        MAX(r.reservation_date) AS last_visit,
        COALESCE(SUM(o.total), 0) AS total_spend
      FROM reservations r
      LEFT JOIN orders o
        ON o.table_id = r.table_id
       AND DATE(o.opened_at) = r.reservation_date
       AND o.status = 'closed'
      WHERE r.customer_email IS NOT NULL AND TRIM(r.customer_email) <> ''
      GROUP BY LOWER(TRIM(r.customer_email))
      ORDER BY MAX(r.reservation_date) DESC
    `);

    const today = new Date();
    const customers = r.rows.map(c => {
      const visits = Number(c.total_visits || 0);
      const spend  = Number(c.total_spend  || 0);
      const lastVisitDate = c.last_visit ? new Date(c.last_visit) : null;
      const daysSinceLast = lastVisitDate
        ? Math.floor((today - lastVisitDate) / 86400000)
        : null;
      let status;
      if (daysSinceLast !== null && daysSinceLast > 60) status = 'Lapsed';
      else if (visits >= 5 || spend >= 200)             status = 'VIP';
      else if (visits >= 2)                             status = 'Regular';
      else                                              status = 'New';

      return {
        customer_email: c.customer_email,
        customer_name:  c.customer_name,
        customer_phone: c.customer_phone,
        total_visits:   visits,
        first_visit:    c.first_visit,
        last_visit:     c.last_visit,
        days_since_last: daysSinceLast,
        total_spend:    spend,
        marketing_consent: !!c.marketing_consent,
        unsubscribed:   !!c.unsubscribed,
        status,
      };
    });

    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-032 — stock depletion on sale
// Walks each given order_item → its recipe → recipe_lines, and inserts
// a negative-quantity stock_movement per ingredient plus decrements
// ingredients.current_stock. Caller-driven; we don't dedupe here, so
// callers must only invoke at genuine "ingredients consumed" moments
// (item added as bar, kitchen course fired, item resent).
// Items without a recipe are silently skipped (£0 cost is the same
// behaviour as the wastage report).
// ─────────────────────────────────────────────────────────────────────
async function depleteStockForItems(itemIds, source = 'sale') {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return;
  try {
    const rows = await pool.query(`
      SELECT oi.id AS order_item_id, oi.quantity AS dish_qty,
             rl.ingredient_id, rl.quantity_used,
             COALESCE(r.serves, 1) AS serves,
             COALESCE(i.cost_per_unit, 0) AS cost_per_unit
      FROM order_items oi
      JOIN recipes r       ON r.menu_item_id = oi.menu_item_id
      JOIN recipe_lines rl ON rl.recipe_id   = r.id
      JOIN ingredients i   ON i.id           = rl.ingredient_id
      WHERE oi.id = ANY($1::int[])
    `, [itemIds]);

    for (const row of rows.rows) {
      const serves     = Math.max(1, Number(row.serves || 1));
      const perPortion = Number(row.quantity_used || 0) / serves;
      const totalQty   = perPortion * Number(row.dish_qty || 0);
      if (totalQty <= 0) continue;
      await pool.query(
        `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, reference, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.ingredient_id, source, -totalQty, Number(row.cost_per_unit || 0),
         `order_item:${row.order_item_id}`, '']
      );
      await pool.query(
        `UPDATE ingredients SET current_stock = GREATEST(0, current_stock - $1) WHERE id = $2`,
        [totalQty, row.ingredient_id]
      );
    }
  } catch (err) {
    console.error('[stock] depleteStockForItems failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// SEPOS-031 — wastage cost report
// Voided order_items × recipes.cost_per_portion. Groups by void_type
// so reports separate true Wastage from Wrong Order / Comp / etc.
// Items with no recipe yet show cost 0 (no data) rather than crashing.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/reports/wastage', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from || '1970-01-01';
    const toTs   = to   || '2999-12-31';
    const r = await pool.query(`
      SELECT oi.id, oi.item_name, oi.menu_item_id,
             oi.quantity, oi.unit_price,
             oi.void_type, oi.void_reason,
             o.created_at AS voided_at, o.id AS order_id, o.table_id,
             COALESCE(r.cost_per_portion, 0) AS cost_per_portion
      FROM order_items oi
      LEFT JOIN orders o ON o.id = oi.order_id
      LEFT JOIN recipes r ON r.menu_item_id = oi.menu_item_id
      WHERE oi.voided=1
        AND o.created_at >= $1::timestamp AND o.created_at <= $2::timestamp
      ORDER BY o.created_at DESC, oi.id DESC
    `, [fromTs, toTs]);

    const items = r.rows.map(row => {
      const qty   = Number(row.quantity || 0);
      const cpp   = Number(row.cost_per_portion || 0);
      const price = Number(row.unit_price || 0);
      return {
        ...row,
        quantity: qty,
        cost_per_portion: cpp,
        wastage_cost:   qty * cpp,
        revenue_lost:   qty * price,
      };
    });

    // Group by void_type
    const byTypeMap = new Map();
    for (const it of items) {
      const t = it.void_type || 'Uncategorised';
      const b = byTypeMap.get(t) || { void_type: t, item_count: 0, dish_count: 0, wastage_cost: 0, revenue_lost: 0 };
      b.item_count   += 1;
      b.dish_count   += it.quantity;
      b.wastage_cost += it.wastage_cost;
      b.revenue_lost += it.revenue_lost;
      byTypeMap.set(t, b);
    }
    const by_type = [...byTypeMap.values()].sort((a, b) => b.wastage_cost - a.wastage_cost);

    // Top wasted dishes
    const dishMap = new Map();
    for (const it of items) {
      const k = it.menu_item_id || `n:${it.item_name}`;
      const d = dishMap.get(k) || { menu_item_id: it.menu_item_id, item_name: it.item_name || 'Unknown',
                                     dish_count: 0, wastage_cost: 0, revenue_lost: 0 };
      d.dish_count   += it.quantity;
      d.wastage_cost += it.wastage_cost;
      d.revenue_lost += it.revenue_lost;
      dishMap.set(k, d);
    }
    const top_dishes = [...dishMap.values()].sort((a, b) => b.wastage_cost - a.wastage_cost).slice(0, 10);

    const total = items.reduce((a, b) => ({
      dish_count:   a.dish_count   + b.quantity,
      wastage_cost: a.wastage_cost + b.wastage_cost,
      revenue_lost: a.revenue_lost + b.revenue_lost,
    }), { dish_count: 0, wastage_cost: 0, revenue_lost: 0 });

    res.json({ items, by_type, top_dishes, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-021 — VAT report (date range)
// Treats prices as VAT-inclusive (UK hospitality convention). For each
// closed order_item in the window, group by vat_rate and compute net /
// vat / gross from the item's quantity * unit_price (post any per-item
// discount). Service charge + bill-level discounts are out of scope.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/reports/vat', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from || '1970-01-01';
    const toTs   = to   || '2999-12-31';
    const r = await pool.query(`
      SELECT COALESCE(mi.vat_rate, 20) AS vat_rate,
             oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value
      FROM order_items oi
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.status='closed' AND oi.voided=0
        AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
    `, [fromTs, toTs]);

    const byRate = new Map();
    for (const row of r.rows) {
      const rate = Number(row.vat_rate ?? 20);
      let gross = Number(row.quantity || 0) * Number(row.unit_price || 0);
      if (row.discount_type === 'percent') gross *= 1 - (Number(row.discount_value || 0) / 100);
      else if (row.discount_type === 'fixed') gross = Math.max(0, gross - Number(row.discount_value || 0));
      const net = rate > 0 ? gross * (100 / (100 + rate)) : gross;
      const vat = gross - net;
      const bucket = byRate.get(rate) || { rate, net: 0, vat: 0, gross: 0, items: 0 };
      bucket.net   += net;
      bucket.vat   += vat;
      bucket.gross += gross;
      bucket.items += Number(row.quantity || 0);
      byRate.set(rate, bucket);
    }
    const breakdown = [...byRate.values()].sort((a, b) => a.rate - b.rate);
    const total = breakdown.reduce(
      (a, b) => ({ net: a.net + b.net, vat: a.vat + b.vat, gross: a.gross + b.gross, items: a.items + b.items }),
      { net: 0, vat: 0, gross: 0, items: 0 }
    );
    res.json({ from: fromTs, to: toTs, breakdown, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-030 — staff performance
// ─────────────────────────────────────────────────────────────────────
app.get('/api/reports/staff-performance', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from || '1970-01-01';
    const toTs   = to   || '2999-12-31';
    const [ordersRes, itemsRes] = await Promise.all([
      pool.query(`
        SELECT o.id, o.staff_id, s.name AS staff_name, s.role AS staff_role,
               o.total, o.covers, o.opened_at, o.closed_at
        FROM orders o LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.status='closed'
          AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
      `, [fromTs, toTs]),
      pool.query(`
        SELECT o.staff_id, oi.course, COUNT(*) AS cnt
        FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id
        WHERE o.status='closed' AND oi.voided=0
          AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
        GROUP BY o.staff_id, oi.course
      `, [fromTs, toTs]),
    ]);

    const byStaff = {};
    for (const o of ordersRes.rows) {
      const key = o.staff_id ?? 'unassigned';
      if (!byStaff[key]) byStaff[key] = {
        staff_id: o.staff_id || null,
        staff_name: o.staff_name || 'Unassigned',
        staff_role: o.staff_role || null,
        orders: 0, covers: 0, total_sales: 0,
        total_turn_mins: 0, turn_count: 0,
        starters: 0, mains: 0, desserts: 0, extras: 0,
      };
      const s = byStaff[key];
      s.orders += 1;
      s.covers += Number(o.covers || 0);
      s.total_sales += Number(o.total || 0);
      if (o.opened_at && o.closed_at) {
        const ms = new Date(o.closed_at) - new Date(o.opened_at);
        if (ms > 0 && ms < 24 * 3600 * 1000) {
          s.total_turn_mins += ms / 60000;
          s.turn_count += 1;
        }
      }
    }
    for (const r of itemsRes.rows) {
      const key = r.staff_id ?? 'unassigned';
      if (!byStaff[key]) continue;
      const c = Number(r.cnt || 0);
      const course = Number(r.course);
      if      (course === 1) byStaff[key].starters += c;
      else if (course === 2) byStaff[key].mains    += c;
      else if (course === 3) byStaff[key].desserts += c;
      else                   byStaff[key].extras   += c;
    }
    const summary = Object.values(byStaff).map(s => ({
      ...s,
      avg_turn_mins:  s.turn_count > 0 ? s.total_turn_mins / s.turn_count : 0,
      avg_per_cover:  s.covers > 0 ? s.total_sales / s.covers : 0,
      dessert_ratio:  s.starters > 0 ? s.desserts / s.starters : 0,
    })).sort((a, b) => b.total_sales - a.total_sales);
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-022 — staff clock-in / clock-out
// ─────────────────────────────────────────────────────────────────────
async function recordClockEvent(req, res, eventType) {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN required' });
    const staffRes = await pool.query('SELECT id, name FROM staff WHERE pin=$1 AND is_active=1', [pin]);
    const staff = staffRes.rows[0];
    if (!staff) return res.status(401).json({ error: 'Invalid PIN' });
    await pool.query('INSERT INTO clock_events (staff_id, event_type) VALUES ($1, $2)', [staff.id, eventType]);
    res.json({ success: true, staff_id: staff.id, name: staff.name, event_type: eventType, event_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
app.post('/api/clock/in',  (req, res) => recordClockEvent(req, res, 'in'));
app.post('/api/clock/out', (req, res) => recordClockEvent(req, res, 'out'));

// Returns staff who are currently clocked in (their latest event is 'in').
app.get('/api/clock/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name, s.role, ce.event_at AS clocked_in_at
      FROM staff s
      JOIN clock_events ce ON ce.id = (
        SELECT id FROM clock_events WHERE staff_id = s.id ORDER BY event_at DESC, id DESC LIMIT 1
      )
      WHERE ce.event_type = 'in'
      ORDER BY s.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw clock events in a window — client pairs them into sessions.
app.get('/api/clock/records', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from || '1970-01-01';
    const toTs   = to   || '2999-12-31';
    const result = await pool.query(`
      SELECT ce.id, ce.staff_id, s.name AS staff_name, s.role AS staff_role,
             ce.event_type, ce.event_at
      FROM clock_events ce
      LEFT JOIN staff s ON s.id = ce.staff_id
      WHERE ce.event_at >= $1::timestamp AND ce.event_at <= $2::timestamp
      ORDER BY ce.staff_id, ce.event_at, ce.id
    `, [fromTs, toTs]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-044 follow-up — sync health.
// Lets the UI surface a banner when the Mac is in local mode but
// SYNC_SECRET isn't configured (which silently blocks cloud writes
// like order delete). Also reports pending queue depth so a stuck
// install is visible.
app.get('/api/sync/health', async (req, res) => {
  const dbMode = (process.env.DB_MODE || 'cloud').toLowerCase();
  const syncSecretSet = !!process.env.SYNC_SECRET;
  let pending = 0;
  try {
    const r = await pool.query("SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0");
    pending = Number(r.rows[0]?.n || 0);
  } catch {}
  res.json({
    db_mode: dbMode,
    sync_secret_set: syncSecretSet,
    pending_actions: pending,
    // Healthy when in cloud mode (no sync needed) OR in local mode
    // with the secret set and no stuck items.
    healthy: dbMode === 'cloud' || (syncSecretSet && pending < 20),
  });
});

// SEPOS-044 follow-up — sync queue inspector.
// Local-mode only. Lets the UI list what's stuck in sync_queue and skip
// individual entries (mark them synced without actually pushing) when
// they're permanently failing — e.g. a delete_order for an order that
// no longer exists on cloud anyway.
app.get('/api/sync/queue', async (req, res) => {
  const dbMode = (process.env.DB_MODE || 'cloud').toLowerCase();
  if (dbMode !== 'local') return res.json({ db_mode: dbMode, entries: [] });
  try {
    const r = await pool.query(
      `SELECT id, action_type, payload, created_at
       FROM sync_queue WHERE synced = 0 ORDER BY id ASC`
    );
    const entries = r.rows.map(row => {
      let parsed = null;
      try { parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
      catch {}
      return {
        id: row.id, action_type: row.action_type,
        created_at: row.created_at, payload: parsed,
      };
    });
    res.json({ db_mode: dbMode, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-044 follow-up — manual sync trigger.
// Lets the UI fire a tick on demand instead of waiting for the next
// 5s interval. Useful right after the operator has configured
// SYNC_SECRET or restored network — they want to see the queue drain
// without waiting.
app.post('/api/sync/run-now', async (req, res) => {
  const dbMode = (process.env.DB_MODE || 'cloud').toLowerCase();
  if (dbMode !== 'local') return res.status(400).json({ error: 'manual sync is local-mode only' });
  try {
    // tick() is idempotent and self-guarded against overlap — safe to
    // fire even if the scheduled tick is mid-flight.
    await syncService.tick();
    res.json({ success: true, status: syncService.getStatus() });
  } catch (err) {
    console.error('POST /api/sync/run-now error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync/queue/:id/skip', async (req, res) => {
  const dbMode = (process.env.DB_MODE || 'cloud').toLowerCase();
  if (dbMode !== 'local') return res.status(400).json({ error: 'queue inspector is local-mode only' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const r = await pool.query(
      `UPDATE sync_queue SET synced = 1, synced_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND synced = 0`,
      [id]
    );
    res.json({ success: true, affected: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Closed-orders feed for the Electron pull. Gated by SYNC_SECRET header
// so order data isn't world-readable on a public Railway URL. Returns
// orders + order_items + payments in one round-trip, paginated by
// closed_at + id so the client can resume.
app.get('/api/sync/closed-orders', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) {
    return res.status(503).json({ error: 'SYNC_SECRET not set on this server — closed-orders sync is disabled' });
  }
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });

  try {
    const since = req.query.since || '1970-01-01';
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 1000);

    const ordersRes = await pool.query(`
      SELECT * FROM orders
      WHERE status='closed' AND closed_at > $1::timestamp
      ORDER BY closed_at ASC, id ASC
      LIMIT $2
    `, [since, limit]);
    const orders = ordersRes.rows;
    if (orders.length === 0) return res.json({ orders: [], order_items: [], payments: [], has_more: false, max_closed_at: since });

    const ids = orders.map(o => o.id);
    const [itemsRes, paymentsRes] = await Promise.all([
      pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::int[])', [ids]),
      pool.query('SELECT * FROM payments    WHERE order_id = ANY($1::int[])', [ids]),
    ]);

    const max_closed_at = orders[orders.length - 1].closed_at;
    res.json({
      orders,
      order_items: itemsRes.rows,
      payments:    paymentsRes.rows,
      max_closed_at,
      has_more: orders.length === limit,
    });
  } catch (err) {
    console.error('GET /api/sync/closed-orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPOS-PRO-002 — active-order sync feed.
// Returns ALL currently-open orders with their items + payments in a single
// payload so the desktop Mac app can mirror cloud state on its floor map.
// Open orders aren't paginated by closed_at since they don't have a
// closed_at yet; we just return the full set. Restaurants with more than
// a few hundred concurrent open tabs would need pagination, which we'll
// add when someone actually has that problem.
app.get('/api/sync/active-orders', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) {
    return res.status(503).json({ error: 'SYNC_SECRET not set on this server — active-orders sync is disabled' });
  }
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });

  try {
    const ordersRes = await pool.query(`
      SELECT * FROM orders
      WHERE status='open'
      ORDER BY id ASC
    `);
    const orders = ordersRes.rows;
    if (orders.length === 0) {
      return res.json({ orders: [], order_items: [], payments: [] });
    }

    const ids = orders.map(o => o.id);
    const [itemsRes, paymentsRes] = await Promise.all([
      pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::int[])', [ids]),
      pool.query('SELECT * FROM payments    WHERE order_id = ANY($1::int[])', [ids]),
    ]);

    res.json({
      orders,
      order_items: itemsRes.rows,
      payments:    paymentsRes.rows,
    });
  } catch (err) {
    console.error('GET /api/sync/active-orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Force a cloud→local pull immediately (operator can hit this if the menu
// looks stale without waiting for the next interval). No-op in cloud mode.
app.post('/api/sync/pull', async (req, res) => {
  try {
    await syncService.pullFromCloud();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Offline-mode sync status (consumed by Electron's title-bar indicator).
app.get('/api/sync-status', async (req, res) => {
  try {
    const queueSize = await offlineQueue.pendingCount();
    res.json({
      mode: offlineQueue.isLocal ? 'local' : 'cloud',
      status: syncService.getStatus(),
      queueSize: Number(queueSize),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual trigger for the Make.com cron (useful for testing). Returns
// the per-event results so the operator can see what fired.
app.post('/api/webhooks/run-now', async (req, res) => {
  try {
    const results = await makeWebhooks.runAll();
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('✅ EPOS server is running on port ' + PORT);
  console.log('');
  syncService.start();
  // SEPOS-PRO-003 — Mac local server subscribes to cloud Socket.io so
  // every cloud event lands on the Mac in real time. No-op in cloud mode.
  cloudRelay.start(io, syncService);
  makeWebhooks.start();
});
