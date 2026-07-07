const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const pool = require('./db/dbAdapter');
const offlineQueue = require('./services/offlineQueue');
const syncService = require('./services/syncService');
const cloudRelay = require('./services/cloudRelay');
const licenseService = require('./services/licenseService');  // SEPOS-060
const licenseClient = require('./services/licenseClient');    // SEPOS-060 phase 2 (desktop offline lock)
const heartbeatClient = require('./services/heartbeatClient'); // SEPOS-PRO-009 (desktop till → ops telemetry)
const tableAllocator = require('./services/tableAllocator');   // SEPOS-027 table-aware reservations
const makeWebhooks = require('./services/makeWebhooks');
const printService = require('./services/printService');
const stuartService = require('./services/stuartService');
const uberDirectService = require('./services/uberDirectService');
const deliverooService = require('./services/deliverooService');

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
// SEPOS-STRIPE-001 — the Stripe webhook needs the raw, unparsed request
// body for signature verification, so its raw parser must be registered
// before the global express.json() (which would otherwise consume it).
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// SEPOS-SUPPORT-LINE-001 — LINE webhook signature verification needs the
// raw, unparsed body. Same constraint as Stripe — register before
// express.json so the global JSON parser doesn't consume it first.
app.use('/api/line/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// SEPOS-047c — single source of truth for an order's live total: the sum
// of non-voided item line totals WITH per-item discounts applied. Every
// path that recomputes orders.total (add items, void, merge, item
// discount) MUST use this — otherwise add/void/merge silently revert a
// discounted total to the raw undiscounted sum, corrupting the bill and
// the Z-report subtotal/discount figures. GREATEST → max() and the
// arithmetic both translate cleanly to SQLite (verified in translateSql).
const ORDER_TOTAL_EXPR = `SUM(CASE
  WHEN discount_type = 'percent' THEN quantity * unit_price * (1 - COALESCE(discount_value,0)/100)
  WHEN discount_type = 'fixed'   THEN GREATEST(0, quantity * unit_price - COALESCE(discount_value,0))
  ELSE quantity * unit_price END)`;

// SEPOS-047j — VAT reports compute gross per item (after the per-ITEM
// discount) but used to ignore the per-ORDER (bill-level) discount, so a
// bill-level comp/discount left VAT reported on money never taken. This
// distributes each order's bill discount proportionally across its items
// (by item-gross) and returns order_id -> multiplicative factor in [0,1].
// Rows must carry order_id, discount_type/discount_value (item) and
// bill_discount_type/bill_discount_value (order).
function billDiscountFactors(rows) {
  const grossByOrder = new Map();
  for (const row of rows) {
    let g = Number(row.quantity || 0) * Number(row.unit_price || 0);
    if (row.discount_type === 'percent') g *= 1 - (Number(row.discount_value || 0) / 100);
    else if (row.discount_type === 'fixed') g = Math.max(0, g - Number(row.discount_value || 0));
    grossByOrder.set(row.order_id, (grossByOrder.get(row.order_id) || 0) + g);
  }
  const factor = new Map();
  for (const row of rows) {
    if (factor.has(row.order_id)) continue;
    const og = grossByOrder.get(row.order_id) || 0;
    const bdv = Number(row.bill_discount_value || 0);
    let f = 1;
    if (bdv > 0 && og > 0) {
      if (row.bill_discount_type === 'percent') f = Math.max(0, 1 - bdv / 100);
      else if (row.bill_discount_type === 'fixed') f = Math.max(0, (og - bdv) / og);
    }
    factor.set(row.order_id, f);
  }
  return factor;
}

// SEPOS-SVCFIX-001 — service charge must be computed PER BILL, not derived from
// (money-taken − subtotal). The old derivation swept tips / overpayments / a
// double-charge into "service" (Thann Thai showed £124.18 where the real 10%
// on dine-in was £46.04). Service applies to DINE-IN only (takeaway + counter
// never carry it) and honours the per-order no_service_charge opt-out.
function orderIsDineIn(o) {
  const t = o.order_type || 'dine_in';
  return t !== 'takeaway' && t !== 'counter';
}
function serviceChargeForOrder(o, scEnabled, scRatePct) {
  if (!scEnabled) return 0;
  if (o.no_service_charge) return 0;
  if (!orderIsDineIn(o)) return 0;
  // SEPOS-SVCFIX-001 fix — charge on the base AFTER any bill-level discount,
  // matching what the till actually took (BillScreen applies service to
  // subtotal − bill discount). Using o.total (pre-bill-discount) overstated
  // service on discounted bills. Per-item discounts are already baked into total.
  let base = Number(o.total ?? 0);
  if (o.discount_value > 0) {
    base = o.discount_type === 'percent'
      ? base * (1 - Number(o.discount_value) / 100)
      : Math.max(0, base - Number(o.discount_value));
  }
  return base * (Number(scRatePct || 0) / 100);
}

// SEPOS-VATMODE-001 — VAT is computed one of two ways per restaurant, chosen by
// the `vat_mode` setting (default 'inclusive' so every existing tenant is
// unchanged). Service charge is always OUTSIDE the VAT base either way.
//   'inclusive' — UK convention: menu prices already contain VAT.
//                 net = gross × 100/(100+rate),  vat = gross − net.
//   'exclusive' — menu prices are net of VAT; VAT is 20% ON TOP of the sale.
//                 net = gross,  vat = gross × rate/100.
function vatLine(gross, rate, mode) {
  const g = Number(gross || 0);
  const r = Number(rate || 0);
  if (r <= 0) return { net: g, vat: 0 };
  if (mode === 'exclusive') return { net: g, vat: g * (r / 100) };
  const net = g * (100 / (100 + r));
  return { net, vat: g - net };
}

// When the desktop shell sets CLIENT_DIST_PATH (Electron does — pointed at
// client/dist), serve the React bundle from the local server too. Lets
// kitchen / bar tablets on the same Wi-Fi load SiamEPOS from this host
// (e.g. via the QR code in the Electron setup window).
if (process.env.CLIENT_DIST_PATH) {
  app.use(express.static(process.env.CLIENT_DIST_PATH));
  console.log('Serving client bundle from', process.env.CLIENT_DIST_PATH);
}

// ── SEPOS-LITE-001 Phase 2a — multi-tenancy ──────────────────────────
// MULTI_TENANT off (the Pro default): every request resolves to the one
// configured restaurant — behaviour is identical to before this change.
// On the shared Lite backend (MULTI_TENANT=1) the restaurant is resolved
// per request: widgets pass restaurant_id, authenticated calls send an
// X-Restaurant-Id header. Endpoint queries get scoped by restaurant_id
// in Phase 2b; for now resolveRestaurantId tags newly-created rows.
const MULTI_TENANT = process.env.MULTI_TENANT === '1';
function resolveRestaurantId(req) {
  if (!MULTI_TENANT) return process.env.RESTAURANT_ID || 'siamepos';
  return (
    (req.body && req.body.restaurant_id) ||
    (req.query && req.query.restaurant_id) ||
    req.get('X-Restaurant-Id') ||
    process.env.RESTAURANT_ID || 'siamepos'
  );
}

// SEPOS-053 — stamp an order with the till session that's open at close time
// (NULL if none). Correlated on the order's own restaurant_id so it's correct
// single- and multi-tenant. Appended to the SET clause of every close/cancel
// UPDATE; Close Shift then totals the Z by session_id instead of a date window,
// so a shift can span midnight / two nights free of the timezone day boundary.
const OPEN_SESSION_SUBQ = "(SELECT ts.id FROM till_sessions ts WHERE ts.status='open' AND ts.restaurant_id = orders.restaurant_id ORDER BY ts.opened_at DESC LIMIT 1)";

// ── SEPOS-LITE-002 — backend plan gate ───────────────────────────────
// Server-side backstop for the in-app feature gating: blocks Pro-only
// API routes on a lite-plan deployment. Under "Lite as Pro" each
// deployment is single-tenant, so the plan is read once from the
// restaurants registry and cached (10-min TTL so an upgrade is picked
// up without a restart). Fail-open to 'pro' — a Pro deployment, or any
// deployment whose plan can't be read, keeps full access; the
// middleware is completely inert for them.
let _deploymentPlan = null;
let _deploymentPlanAt = 0;
async function getDeploymentPlan() {
  if (_deploymentPlan && Date.now() - _deploymentPlanAt < 600000) return _deploymentPlan;
  try {
    const rid = process.env.RESTAURANT_ID || 'siamepos';
    const r = await pool.query(`SELECT plan FROM restaurants WHERE restaurant_id = $1`, [rid]);
    _deploymentPlan = (r.rows[0] && r.rows[0].plan) || 'pro';
  } catch (e) {
    _deploymentPlan = 'pro';
  }
  _deploymentPlanAt = Date.now();
  return _deploymentPlan;
}
// Pro-only route families with clean, unambiguous prefixes — dine-in
// inventory, Z-report and clock records. (Order + staff routes are
// intentionally not gated here: they are shared with lite-tier flows.)
const PRO_ONLY_API = /^\/api\/(z-?report|ingredients|recipes|stock|supplier-invoices|clock)\b/i;
app.use(async (req, res, next) => {
  if (!PRO_ONLY_API.test(req.path)) return next();
  const plan = await getDeploymentPlan();
  if (plan === 'pro') return next();
  return res.status(403).json({ error: 'This feature is not included in your plan. Upgrade to unlock it.' });
});

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
    // BUG-003 — tables created via the Table Plan editor never get a
    // `name` set, so the column is NULL and clients rendered "null".
    // Fall back to "Table {number}" so the API always returns a usable
    // display name.
    const rows = result.rows.map(t => ({
      ...t,
      name: (t.name && String(t.name).trim()) ? t.name : `Table ${t.table_number}`,
    }));
    res.json(rows);
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
  if (await maybeForwardTableWriteToCloud(req, res)) return;
  try {
    const { pos_x, pos_y, shape, width, height, name, capacity, table_number, is_takeaway } = req.body;
    // COALESCE keeps the existing is_takeaway flag when a partial plan update
    // (e.g. drag/resize) doesn't include it — only an explicit toggle changes it.
    await pool.query(
      'UPDATE tables SET pos_x=$1, pos_y=$2, shape=$3, width=$4, height=$5, name=$6, capacity=$7, table_number=$8, is_takeaway=COALESCE($9, is_takeaway) WHERE id=$10',
      [pos_x, pos_y, shape, width, height, name, capacity, table_number, (is_takeaway == null ? null : (is_takeaway ? 1 : 0)), req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tables', async (req, res) => {
  if (await maybeForwardTableWriteToCloud(req, res)) return;
  try {
    const { table_number, capacity, pos_x, pos_y, shape, is_takeaway } = req.body;
    const result = await pool.query(
      'INSERT INTO tables (table_number, capacity, pos_x, pos_y, shape, is_takeaway) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [table_number, capacity || 4, pos_x || 0, pos_y || 0, shape || 'square', is_takeaway ? 1 : 0]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tables/:id', async (req, res) => {
  if (await maybeForwardTableWriteToCloud(req, res)) return;
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
  if (await maybeForwardTableWriteToCloud(req, res)) return;
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
  if (await maybeForwardTableWriteToCloud(req, res)) return;
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
    const rid = resolveRestaurantId(req);
    const result = await pool.query(
      'SELECT * FROM dining_duration_tiers WHERE restaurant_id = $1 ORDER BY covers_min',
      [rid]
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

// SEPOS-046q — desktop installs forward menu admin writes to cloud so the
// operator's edits become the new cloud truth (instead of being silently
// erased by the next pull tick). On success, the next 5s pull brings the
// cloud-acknowledged shape into local SQLite. On failure, the request falls
// back to the local handler so the operator's UI still updates — the
// caveat (logged) is that the change is local-only and will be reverted
// on next pull. Phase 2 (offline-capable menu queue) is a separate
// SEPOS-046r if connectivity gaps become a real operator complaint.
// Generic desktop write-through: forward an admin write to the cloud, then
// pull the affected table back into local SQLite before replying so the
// client's refetch sees the cloud-acknowledged state immediately. `label`
// is for logs; `afterPull` is the targeted snapshot pull (menu / staff).
async function forwardWriteToCloud(req, res, label, afterPull) {
  try {
    const archiveService = require('./services/archiveService');
    if (!archiveService.isLocalInstall() || !process.env.CLOUD_API_URL) return false;
  } catch { return false; }
  try {
    const url = `${process.env.CLOUD_API_URL}${req.originalUrl}`;
    const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      init.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, init);
    const body = await r.text();
    console.log(`[${label}] forwarded ${req.method} ${req.originalUrl} → cloud ${r.status}`);
    // Pull the affected table back into local SQLite BEFORE replying so the
    // client's follow-up refetch sees the change immediately instead of on
    // the next 5s tick. Failure is non-fatal: the regular tick catches up.
    if (r.ok && afterPull) {
      try { await afterPull(); }
      catch (pullErr) { console.warn(`[${label}] instant pull-back failed: ${pullErr.message}`); }
    }
    res.status(r.status).type('application/json').send(body);
    return true;
  } catch (err) {
    console.warn(`[${label}] cloud unreachable for ${req.method} ${req.originalUrl}: ${err.message} — falling back to local (change will be lost on next pull)`);
    return false;
  }
}

// SEPOS-046q — desktop installs forward menu admin writes to cloud so the
// operator's edits become the new cloud truth (instead of being silently
// erased by the next pull tick). On success, an instant menu pull brings
// the cloud-acknowledged shape into local SQLite. On failure, the request
// falls back to the local handler so the operator's UI still updates.
function maybeForwardMenuWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'menu-write', () => syncService.pullMenuSnapshot());
}

// SEPOS-059 — modifier-library writes pull the flat modifier tables back (not the
// menu tree), so the till admin's refetch shows the new/removed option instantly
// instead of only after the next 5s tick (the "had to close & reopen" bug).
function maybeForwardModifierWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'modifier-write', () => syncService.pullModifiersSnapshot());
}

// SEPOS-027 — floor-plan writes (tables + linked groups) forward to cloud so the
// cloud (which online booking uses for table-aware availability) stays in sync
// with the till, which is the only place the floor plan is edited.
function maybeForwardTableWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'table-write', () => syncService.pullTablesSnapshot());
}

// SEPOS-047g — same write-through for staff/PIN edits. Before this, staff
// endpoints wrote ONLY to local SQLite on desktop — no cloud forward, no
// push queue — so a PIN added/changed/deleted on the till never reached
// the cloud, the website, or any other device (and could later be clobbered
// when the 5s pull's upsert-by-id collided with a different cloud staff id).
// Now a desktop staff write becomes the cloud truth and the instant staff
// pull (with orphan-delete) reflects it locally + everywhere on next tick.
function maybeForwardStaffWriteToCloud(req, res) {
  return forwardWriteToCloud(req, res, 'staff-write', () => syncService.pullStaffSnapshot());
}

app.post('/api/categories', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
    const existing = await pool.query('SELECT MAX(sort_order) as max_order FROM categories');
    const nextOrder = (existing.rows[0].max_order || 0) + 1;
    const result = await pool.query(
      'INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING *',
      [name.trim(), nextOrder]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-046o — reorder categories. Frontend sends [{id, sort_order}, ...]
// after every arrow-button tap; backend persists each row's position.
// MUST be declared before '/api/categories/:id' — Express matches in
// declaration order, so the param route would otherwise swallow this
// path with id='sort-order' (SEPOS-046ae: it did, and reorder 400'd
// against the rename handler from the day it shipped).
app.put('/api/categories/sort-order', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    for (const it of items) {
      await pool.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [Number(it.sort_order) || 0, it.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-046n — rename a category. Pair with the SEPOS-046m delete so
// the Menu Manager finally has full CRUD on categories. Trims + rejects
// empty names so the chip never collapses to blank.
app.put('/api/categories/:id', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    await pool.query('UPDATE categories SET name = $1 WHERE id = $2', [name, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/categories/:id/bar', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { is_bar } = req.body;
    await pool.query('UPDATE categories SET is_bar = $1 WHERE id = $2', [is_bar, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/categories/:id/default-course', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { default_course } = req.body;
    await pool.query('UPDATE categories SET default_course = $1 WHERE id = $2', [default_course, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-STATION-001 — assign a category to an extra printer station (or NULL to
// fall back to the default kitchen/bar routing by is_bar).
app.put('/api/categories/:id/printer', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const pid = req.body.printer_id ? Number(req.body.printer_id) : null;
    await pool.query('UPDATE categories SET printer_id = $1 WHERE id = $2', [pid, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEPOS-STATION-001 — extra printer stations (wok/grill/cold…) ──────────
// The built-in receipt/kitchen/bar printers stay in settings; these are ADDED
// stations a category can be routed to. Kitchen printing groups items by their
// resolved printer (see routing rework).
// SEPOS-PRINT-UNIFY-001 — overlay the unified printers table onto the legacy
// settings.printer_<role>_* keys the print paths read. Default per role =
// settings.default_<role>_printer_id, else the first active printer flagged with
// that role. No unified printer for a role → legacy settings untouched
// (migration-safe: today's output is unchanged until the operator sets it up).
async function applyPrinterRouting(settings) {
  let printers;
  try { printers = (await pool.query('SELECT * FROM printers WHERE is_active = 1 ORDER BY sort_order, id')).rows; }
  catch { return settings; }
  if (!printers || !printers.length) return settings;
  const byId = new Map(printers.map(p => [String(p.id), p]));
  for (const role of ['receipt', 'kitchen', 'bar']) {
    const defId = settings[`default_${role}_printer_id`];
    const p = (defId && byId.get(String(defId))) || printers.find(x => Number(x[`role_${role}`]) === 1);
    if (!p || !(p.ip || p.name)) continue;
    settings[`printer_${role}_ip`]        = p.ip || '';
    settings[`printer_${role}_port`]      = p.port || 9100;
    settings[`printer_${role}_name`]      = p.name || '';
    settings[`printer_${role}_lpr_queue`] = p.lpr_queue || settings[`printer_${role}_lpr_queue`] || 'lp';
    if (role === 'kitchen' && p.copies) settings.printer_kitchen_copies = String(p.copies);
  }
  return settings;
}

// One-time: surface the operator's existing fixed Receipt/Kitchen/Bar config as
// rows in the unified list so it isn't empty on first open. Runs only until any
// printer carries a role flag; after that the operator's list is authoritative.
async function ensurePrintersSeeded() {
  try {
    const existing = (await pool.query('SELECT * FROM printers')).rows;
    if (existing.some(p => Number(p.role_receipt) || Number(p.role_kitchen) || Number(p.role_bar))) return;
    const s = {};
    (await pool.query(`SELECT key, value FROM settings WHERE key LIKE 'printer_%'`)).rows.forEach(r => { s[r.key] = r.value; });
    for (const role of ['receipt', 'kitchen', 'bar']) {
      const ip = s[`printer_${role}_ip`], name = s[`printer_${role}_name`];
      if (!ip && !name) continue;
      const roleCol = `role_${role}`;
      const match = existing.find(p => (ip && p.ip === ip) || (name && p.name === name));
      if (match) { await pool.query(`UPDATE printers SET ${roleCol} = 1 WHERE id = $1`, [match.id]); }
      else {
        const label = role[0].toUpperCase() + role.slice(1) + ' printer';
        await pool.query(
          `INSERT INTO printers (name, ip, port, lpr_queue, copies, ${roleCol}) VALUES ($1,$2,$3,$4,$5,1)`,
          [name || label, ip || null, Number(s[`printer_${role}_port`]) || 9100, s[`printer_${role}_lpr_queue`] || null, Number(s[`printer_${role}_copies`]) || 1]
        );
      }
    }
  } catch (e) { console.warn('[printers] seed skipped:', e.message); }
}

app.get('/api/printers', async (req, res) => {
  try {
    await ensurePrintersSeeded();
    const r = await pool.query('SELECT * FROM printers WHERE is_active = 1 ORDER BY sort_order, id');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/printers', async (req, res) => {
  try {
    const { name, ip, port, mac, kind, copies, sort_order, role_receipt, role_kitchen, role_bar, lpr_queue } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Printer name required' });
    const r = await pool.query(
      `INSERT INTO printers (name, ip, port, mac, kind, copies, sort_order, restaurant_id, role_receipt, role_kitchen, role_bar, lpr_queue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [String(name).trim(), ip || null, Number(port) || 9100, mac || null,
       kind === 'receipt' ? 'receipt' : 'kitchen', Math.max(1, Math.min(5, Number(copies) || 1)),
       Number(sort_order) || 0, resolveRestaurantId(req),
       role_receipt ? 1 : 0, role_kitchen ? 1 : 0, role_bar ? 1 : 0, lpr_queue || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/printers/:id', async (req, res) => {
  try {
    const { name, ip, port, mac, kind, copies, sort_order, role_receipt, role_kitchen, role_bar, lpr_queue } = req.body || {};
    await pool.query(
      `UPDATE printers SET name=COALESCE($1,name), ip=$2, port=$3, mac=$4,
         kind=COALESCE($5,kind), copies=$6, sort_order=$7,
         role_receipt=$8, role_kitchen=$9, role_bar=$10, lpr_queue=$11 WHERE id=$12`,
      [name != null ? String(name).trim() : null, ip || null, Number(port) || 9100, mac || null,
       kind, Math.max(1, Math.min(5, Number(copies) || 1)), Number(sort_order) || 0,
       role_receipt ? 1 : 0, role_kitchen ? 1 : 0, role_bar ? 1 : 0, lpr_queue || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Set the default printer for a role (receipt|kitchen|bar). Body: { role, printer_id }.
app.post('/api/printers/set-default', async (req, res) => {
  try {
    const role = String(req.body?.role || '');
    if (!['receipt', 'kitchen', 'bar'].includes(role)) return res.status(400).json({ error: 'role must be receipt|kitchen|bar' });
    const pid = req.body?.printer_id != null ? String(Number(req.body.printer_id)) : '';
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [`default_${role}_printer_id`, pid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// SEPOS-PRINT-UNIFY-001 — "Scan for printers". Probes this server's own /24
// subnet on the RAW print port (9100) and returns whatever answers, so the
// operator doesn't have to hunt for IPs. Only meaningful when the server is ON
// the restaurant's LAN — i.e. the desktop (Electron) / Sunmi local install. On
// the cloud backend it can't reach a private LAN, so we return local:false and
// the UI tells the operator to run it from the till app or type the IP.
app.get('/api/printers/scan', async (req, res) => {
  if (!archiveService.isLocalInstall()) {
    return res.json({ local: false, printers: [], message: 'Scanning finds printers on the same network — run it from the till / desktop app, or enter the IP manually.' });
  }
  try {
    const os = require('os'), net = require('net');
    // Find this machine's LAN IPv4 → derive the /24 to sweep.
    let base = null;
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const ni of ifaces || []) {
        if (ni.family === 'IPv4' && !ni.internal) { base = ni.address.split('.').slice(0, 3).join('.'); break; }
      }
      if (base) break;
    }
    if (!base) return res.json({ local: true, printers: [], message: 'No LAN connection found on this device.' });
    const port = 9100;
    const probe = (host) => new Promise((resolve) => {
      const s = new net.Socket();
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok ? host : null); };
      s.setTimeout(500);
      s.once('connect', () => finish(true));
      s.once('timeout', () => finish(false));
      s.once('error', () => finish(false));
      s.connect(port, host);
    });
    const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    const found = (await Promise.all(hosts.map(probe))).filter(Boolean);
    res.json({ local: true, subnet: `${base}.0/24`, printers: found.map(ip => ({ ip, port })) });
  } catch (err) { res.status(500).json({ local: true, printers: [], error: err.message }); }
});
app.delete('/api/printers/:id', async (req, res) => {
  try {
    // Detach any categories pointed here (they fall back to default kitchen/bar).
    await pool.query('UPDATE categories SET printer_id = NULL WHERE printer_id = $1', [req.params.id]);
    await pool.query('DELETE FROM printers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Test-print to a specific station.
app.post('/api/printers/:id/test', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM printers WHERE id = $1', [req.params.id]);
    const p = r.rows[0];
    if (!p) return res.status(404).json({ error: 'Printer not found' });
    if (!p.ip) return res.status(400).json({ error: 'This station has no IP set' });
    // testPrint's 3rd arg is a CUPS/named-printer fallback, NOT a MAC — passing
    // the MAC made the fallback try to print to a queue named after the MAC.
    // A station is IP-addressed, so leave the named-printer arg empty.
    await printService.testPrint(p.ip, p.port || 9100, '');
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
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { category_id, name } = req.body;
    const result = await pool.query('INSERT INTO subcategories (category_id, name) VALUES ($1,$2) RETURNING id', [category_id, name]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-046ab — reorder sub-categories, same contract as the categories
// endpoint: frontend sends [{id, sort_order}, ...] after every arrow tap.
app.put('/api/subcategories/sort-order', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    for (const it of items) {
      await pool.query('UPDATE subcategories SET sort_order = $1 WHERE id = $2', [Number(it.sort_order) || 0, it.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/subcategories/:id', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    await pool.query('UPDATE menu_items SET subcategory_id = NULL WHERE subcategory_id = $1', [req.params.id]);
    await pool.query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-046m — delete category. Safety: refuse if the category still
// has menu_items (Starter has 168 — must never accidentally vanish).
// Cascades to its subcategories. UI shows the button only on the
// active category when items_count === 0, so the 409 path is mostly
// belt-and-braces.
app.delete('/api/categories/:id', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const itemsRes = await pool.query('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = $1', [req.params.id]);
    const itemCount = parseInt(itemsRes.rows[0].n, 10) || 0;
    if (itemCount > 0) {
      return res.status(409).json({
        error: `Cannot delete — this category still has ${itemCount} item${itemCount === 1 ? '' : 's'}. Move them to another category first.`,
        item_count: itemCount,
      });
    }
    await pool.query('DELETE FROM subcategories WHERE category_id = $1', [req.params.id]);
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items WHERE is_available = 1 ORDER BY sort_order ASC, id ASC')
    ]);
    res.json(catRes.rows.map(cat => ({ ...cat, subcategories: subRes.rows.filter(s => s.category_id === cat.id), items: itemRes.rows.filter(i => i.category_id === cat.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu/all', async (req, res) => {
  try {
    const [catRes, subRes, itemRes] = await Promise.all([
      pool.query('SELECT * FROM categories ORDER BY sort_order'),
      pool.query('SELECT * FROM subcategories ORDER BY sort_order'),
      pool.query('SELECT * FROM menu_items ORDER BY sort_order ASC, id ASC')
    ]);
    res.json(catRes.rows.map(cat => ({ ...cat, subcategories: subRes.rows.filter(s => s.category_id === cat.id), items: itemRes.rows.filter(i => i.category_id === cat.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/items', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { category_id, subcategory_id, name, name_alt, description, price, vat_rate, allergens, default_course } = req.body;
    // AI scanner sends allergens as ["Fish","Soybeans"]; normalise to JSON
    // string for the column so the Allergen Matrix sees the scanned source.
    let allergensStr = null;
    if (Array.isArray(allergens) && allergens.length > 0) allergensStr = JSON.stringify(allergens);
    else if (typeof allergens === 'string' && allergens.trim()) allergensStr = JSON.stringify([allergens]);
    const dc = (default_course == null || default_course === '') ? null : (Number(default_course) || null);
    // Append to the end of the category so a new item gets a real position
    // (not sort_order=0, which sorts to the top and the boot migration rewrites).
    const soRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM menu_items WHERE category_id = $1', [category_id]);
    const nextSort = Number(soRes.rows[0]?.next) || 1;
    const result = await pool.query(
      'INSERT INTO menu_items (category_id, subcategory_id, name, name_alt, description, price, vat_rate, allergens, default_course, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [category_id, subcategory_id || null, name, name_alt || null, description, price, vat_rate ?? 20, allergensStr, dc, nextSort]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/menu/items/sort-order', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { items } = req.body;
    for (const item of items) {
      await pool.query('UPDATE menu_items SET sort_order = $1 WHERE id = $2', [item.sort_order, item.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/menu/items/:id', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
  try {
    const { name, name_alt, description, price, is_available, is_online, subcategory_id, category_id, vat_rate, default_course } = req.body;
    // NULL / '' → inherit the category course; 1-4 → per-item override.
    const dc = (default_course == null || default_course === '') ? null : (Number(default_course) || null);
    await pool.query(
      'UPDATE menu_items SET name=$1, name_alt=$2, description=$3, price=$4, is_available=$5, is_online=COALESCE($6, is_online), subcategory_id=$7, category_id=$8, vat_rate=COALESCE($9, vat_rate), default_course=$10 WHERE id=$11',
      [name, name_alt || null, description, price, is_available, is_online ?? null, subcategory_id || null, category_id, vat_rate ?? null, dc, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/menu/items/:id/modifiers', async (req, res) => {
  try {
    // SEPOS-059 — resolve BOTH per-dish (legacy) groups AND attached library
    // groups (shared, linked via menu_item_modifier_groups). A library group
    // is reusable, so the same group id can appear on many dishes.
    // SEPOS-ALLERGEN-OPT-001 — also union GLOBAL groups (is_global=1), which apply
    // to every item with no per-item link (e.g. the dietary/allergen group). Item-
    // specific groups sort first, global ones (dietary) after.
    const groupRes = await pool.query(
      `SELECT * FROM modifier_groups
        WHERE menu_item_id = $1
           OR id IN (SELECT group_id FROM menu_item_modifier_groups WHERE menu_item_id = $1)
           OR COALESCE(is_global, 0) = 1
        ORDER BY COALESCE(is_global, 0), id`, [req.params.id]);
    if (groupRes.rows.length === 0) return res.json([]);
    const groupsWithMods = await Promise.all(groupRes.rows.map(async group => {
      const modRes = await pool.query('SELECT * FROM modifiers WHERE group_id = $1 AND is_available = 1', [group.id]);
      return { ...group, modifiers: modRes.rows };
    }));
    res.json(groupsWithMods);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/menu/items/:id/modifiers', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
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
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    const { name, extra_price } = req.body;
    const result = await pool.query('INSERT INTO modifiers (group_id, name, extra_price) VALUES ($1,$2,$3) RETURNING id', [req.params.id, name, extra_price || 0]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-ALLERGEN-OPT-001 — one-tap standard GLOBAL dietary/allergen group.
// Idempotent: creates it once (menu_item_id NULL so it's a library group,
// is_global=1 so getItemModifiers unions it onto EVERY item, is_allergen=1 so
// it prints with emphasis + its options are free, multi_select=1). Operators
// edit its options afterwards via the normal options endpoints.
app.post('/api/menu/dietary-preset', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    const existing = await pool.query('SELECT id FROM modifier_groups WHERE is_allergen = 1 AND is_global = 1 LIMIT 1');
    if (existing.rows[0]) return res.json({ id: existing.rows[0].id, created: false });
    const g = await pool.query(
      `INSERT INTO modifier_groups (menu_item_id, name, required, multi_select, is_global, is_allergen)
       VALUES (NULL, $1, 0, 1, 1, 1) RETURNING id`,
      ['Dietary / Allergen requests']
    );
    const gid = g.rows[0].id;
    const opts = ['No nuts', 'No peanuts', 'No gluten / wheat', 'No shellfish', 'No dairy', 'No egg', 'No fish sauce', 'Vegan', 'Vegetarian'];
    for (const name of opts) {
      await pool.query('INSERT INTO modifiers (group_id, name, extra_price) VALUES ($1,$2,0)', [gid, name]);
    }
    res.status(201).json({ id: gid, created: true, options: opts.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/modifier-groups/:id', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    await pool.query('DELETE FROM modifiers WHERE group_id = $1', [req.params.id]);
    await pool.query('DELETE FROM modifier_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/modifiers/:id', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    await pool.query('DELETE FROM modifiers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEPOS-059 — Shared Modifier Library ───────────────────────────────────
// Reusable option groups (Meat choice, Spice level…) defined once and
// attached to many dishes. A library group is a modifier_groups row with
// menu_item_id = NULL; menu_item_modifier_groups links it to dishes.

// All shared (library) groups + their options.
app.get('/api/modifier-library', async (req, res) => {
  try {
    const groupRes = await pool.query('SELECT * FROM modifier_groups WHERE menu_item_id IS NULL ORDER BY id');
    const groups = await Promise.all(groupRes.rows.map(async group => {
      const modRes = await pool.query('SELECT * FROM modifiers WHERE group_id = $1 ORDER BY id', [group.id]);
      return { ...group, modifiers: modRes.rows };
    }));
    res.json(groups);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a shared (library) group — menu_item_id stays NULL.
app.post('/api/modifier-library', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    const { name, required, multi_select } = req.body;
    const result = await pool.query(
      'INSERT INTO modifier_groups (menu_item_id, name, required, multi_select) VALUES (NULL,$1,$2,$3) RETURNING id',
      [name, required ? 1 : 0, multi_select ? 1 : 0]);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach / detach a library group to/from a dish.
app.post('/api/menu/items/:id/modifier-groups/:groupId', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    await pool.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, group_id) VALUES ($1,$2)
       ON CONFLICT (menu_item_id, group_id) DO NOTHING`,
      [req.params.id, req.params.groupId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/menu/items/:id/modifier-groups/:groupId', async (req, res) => {
  if (await maybeForwardModifierWriteToCloud(req, res)) return;
  try {
    await pool.query('DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND group_id = $2',
      [req.params.id, req.params.groupId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Flat feeds for desktop sync (cloud-wins upsert). Pulling shared groups +
// the join lets the till resolve identically to cloud (the old per-item pull
// duplicated a shared group id across dishes and lost all but the last).
app.get('/api/modifier-groups-all', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM modifier_groups')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/modifiers-all', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM modifiers')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/menu-item-modifier-groups', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM menu_item_modifier_groups')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/menu/items/:id', async (req, res) => {
  if (await maybeForwardMenuWriteToCloud(req, res)) return;
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
// Captured once at boot so /api/health can prove which build + when a tenant
// last redeployed (ops verification — no build-version marker existed before).
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || process.env.GIT_COMMIT || null;
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS orders_today,
        MAX(created_at) AS last_order_at
      FROM orders
    `);
    // SEPOS-PRO-009 — surface desktop tills so ops can track installs + versions.
    // Wrapped separately so a missing devices table (older deploy) never breaks health.
    let tills = [];
    try {
      const d = await pool.query(`SELECT device_id, app_version, platform, last_seen FROM devices ORDER BY last_seen DESC`);
      tills = d.rows.map(r => ({
        device_id: r.device_id,
        app_version: r.app_version,
        platform: r.platform,
        last_seen: r.last_seen,
      }));
    } catch (_) { /* devices table not present yet */ }
    res.json({
      status: 'ok',
      commit: SERVER_COMMIT,
      started_at: SERVER_STARTED_AT,
      orders_today: parseInt(result.rows[0].orders_today, 10) || 0,
      last_order_at: result.rows[0].last_order_at,
      tills,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// SEPOS-PRO-009 — desktop till heartbeat. The Electron app POSTs this on launch
// + every few minutes so ops can see which tills exist, their version, platform
// and last-seen. Ungated telemetry (device_id is the PK → repeated calls just
// upsert one row). Field lengths capped defensively.
app.post('/api/device/heartbeat', async (req, res) => {
  try {
    const { device_id, app_version, platform } = req.body || {};
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const rid = (req.body && req.body.restaurant_id) || resolveRestaurantId(req) || null;
    await pool.query(
      `INSERT INTO devices (device_id, restaurant_id, app_version, platform, last_seen)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT(device_id) DO UPDATE SET
         restaurant_id = EXCLUDED.restaurant_id,
         app_version   = EXCLUDED.app_version,
         platform      = EXCLUDED.platform,
         last_seen     = CURRENT_TIMESTAMP`,
      [String(device_id).slice(0, 64), rid ? String(rid).slice(0, 100) : null,
       String(app_version || '').slice(0, 20), String(platform || '').slice(0, 20)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/bar', async (req, res) => {
  try {
    const ordersRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status = 'open' ORDER BY orders.created_at DESC`);
    const orders = ordersRes.rows;
    if (!orders.length) return res.json([]);
    const orderIds = orders.map(o => o.id);
    const itemsRes = await pool.query(
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON categories.id = COALESCE(menu_items.category_id, order_items.dest_category_id) WHERE order_items.order_id = ANY($1) AND order_items.voided = 0 AND order_items.status != 'served' AND categories.is_bar = 1`,
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
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt, menu_items.category_id, categories.is_bar FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON categories.id = COALESCE(menu_items.category_id, order_items.dest_category_id) WHERE order_items.order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order, items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', requireActiveSubscription, requireValidLicense, async (req, res) => {
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

app.post('/api/orders/:id/items', requireValidLicense, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { items } = req.body;
    const orderId = req.params.id;
    // BUG-001 — adding items to a non-existent order used to throw a
    // raw FK violation → 500. Check the order exists first and return
    // a clean 404.
    const orderCheck = await client.query('SELECT id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    // Never add items to an already-closed/cancelled order — that created the
    // "closed order with items but no payment" phantom (inflates the sales
    // report, never appears in Bills). The floor should open a fresh order.
    const st = orderCheck.rows[0].status;
    if (st === 'closed' || st === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This order is already closed — start a new order for the table.' });
    }
    const firedBarIds = []; // SEPOS-032: bar items deplete stock on add
    const queuedItems = [];  // SEPOS-PRO-002: paired with local row id for cloud_id mapping
    for (const item of items) {
      const isBar = item.is_bar ? 1 : 0;
      const firedAt = isBar ? new Date().toISOString() : null;
      // BUG-EPOS-002 (Nook): never trust the client-side unit_price.
      // Pull the canonical price from menu_items in the same lookup
      // that already gives us the name. Fall back to client value only
      // if the menu row is missing (custom / deleted items) so legacy
      // flows don't 500.
      const lookup = await client.query('SELECT name, price FROM menu_items WHERE id = $1', [item.menu_item_id]);
      const itemName  = lookup.rows[0]?.name || item.name || 'Unknown item';
      let unitPrice = lookup.rows[0]?.price ?? item.unit_price;
      // BUG-EPOS-MODPRICE — add the chosen modifiers' surcharges. Prices are
      // looked up server-side (anti-tamper, same reason we re-price the base),
      // falling back to the client value only when the modifier row is missing
      // (custom / deleted options). Without this, "Chicken +£1" was dropped.
      if (Array.isArray(item.modifiers) && item.modifiers.length) {
        let extra = 0;
        for (const m of item.modifiers) {
          if (!m) continue;
          if (m.id != null) {
            const mr = await client.query('SELECT extra_price FROM modifiers WHERE id = $1', [m.id]);
            extra += Number(mr.rows[0]?.extra_price ?? m.extra_price ?? 0) || 0;
          } else {
            extra += Number(m.extra_price) || 0;
          }
        }
        unitPrice = (Number(unitPrice) || 0) + extra;
      }
      // SEPOS-MISC-001 — Misc/open lines carry a chosen destination category so
      // routing (kitchen/bar + printer) + name + VAT resolve through it. Normal
      // lines leave it null and route via menu_items.category_id as before.
      const destCategoryId = item.category_id != null ? Number(item.category_id) : null;
      const ins = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, notes, course, item_note, is_fired, fired_at, cooking_started_at, item_name, dest_category_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [orderId, item.menu_item_id, item.quantity, unitPrice, item.notes || '', item.course || 1, item.item_note || '', isBar, firedAt, firedAt, itemName, destCategoryId]
      );
      const newRowId = ins.rows[0].id;
      if (isBar) firedBarIds.push(newRowId);
      queuedItems.push({ ...item, localItemId: newRowId });
    }
    const totalRes = await client.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id = $1 AND voided = 0`, [orderId]); // SEPOS-047c — keep per-item discounts
    const total = totalRes.rows[0].total || 0;
    await client.query('UPDATE orders SET total = $1 WHERE id = $2', [total, orderId]);
    await client.query('COMMIT');
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const newItemsRes = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id = $1 AND order_items.is_fired = 1 AND order_items.status = 'cooking'`, [orderId]);
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
      `SELECT id FROM order_items WHERE order_id=$1 AND course=$2 AND is_fired=0 AND voided=0 AND (menu_item_id IN (SELECT menu_items.id FROM menu_items LEFT JOIN categories ON menu_items.category_id = categories.id WHERE categories.is_bar = 0 OR categories.is_bar IS NULL) OR (menu_item_id IS NULL AND (dest_category_id IS NULL OR dest_category_id IN (SELECT id FROM categories WHERE is_bar = 0))))`,
      [id, course]
    );
    const firedIds = aboutToFireRes.rows.map(r => r.id);
    const result = await pool.query(
      `UPDATE order_items SET is_fired=1, fired_at=$1, status='cooking', cooking_started_at=$2 WHERE order_id=$3 AND course=$4 AND is_fired=0 AND voided=0 AND (menu_item_id IN (SELECT menu_items.id FROM menu_items LEFT JOIN categories ON menu_items.category_id = categories.id WHERE categories.is_bar = 0 OR categories.is_bar IS NULL) OR (menu_item_id IS NULL AND (dest_category_id IS NULL OR dest_category_id IN (SELECT id FROM categories WHERE is_bar = 0))))`,
      [now, now, id, course]
    );
    await depleteStockForItems(firedIds, 'sale');
    const orderRes = await pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id = $1`, [id]);
    const itemsRes = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id = $1 AND order_items.course = $2 AND order_items.is_fired = 1`, [id, course]);
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
    // SEPOS-LOCAL-001 — push to cloud so the next active-orders pull
    // doesn't revert this local change. Without this enqueue the pass
    // tap "Done" worked for ~5s, then the cloud pull (still showing
    // status='cooked') overwrote it and the order popped back to the
    // chef's screen. No-op in cloud mode.
    await offlineQueue.enqueue('update_item_status', {
      localItemId: Number(req.params.id),
      status,
      served_at,
      cooking_started_at,
    });

    // SEPOS-034 — when the last non-voided item on a takeaway order goes
    // to 'served', auto-flip takeaway_status='collected' so the order
    // closes and counts in reports. Without this the Collected button
    // is the only path, and it lives on the Pass tab card which has
    // already disappeared by the time everything is served.
    if (status === 'served' && item.order_id) {
      const orderRes = await pool.query(
        'SELECT id, order_type, order_subtype, status, takeaway_status FROM orders WHERE id = $1',
        [item.order_id]
      );
      const order = orderRes.rows[0];
      // Collection takeaway orders flip to 'ready' once every item is
      // served — staff close the bill manually from the TakeawayStrip
      // to keep takeaway in the same close-and-pay flow as dine-in.
      // Delivery orders stay open until the courier webhook reports
      // delivered (SEPOS-DELIVERY-001) — untouched here.
      if (order && order.order_type === 'takeaway' && order.order_subtype !== 'delivery'
          && order.status === 'open' && order.takeaway_status !== 'collected'
          && order.takeaway_status !== 'ready') {
        const remainingRes = await pool.query(
          `SELECT COUNT(*) AS n FROM order_items
           WHERE order_id = $1 AND voided = 0 AND status <> 'served'`,
          [item.order_id]
        );
        if (parseInt(remainingRes.rows[0].n, 10) === 0) {
          await pool.query(
            `UPDATE orders SET takeaway_status='ready' WHERE id = $1`,
            [item.order_id]
          );
          io.emit('takeaway_status', { order_id: Number(item.order_id), status: 'ready' });
          console.log(`🥡 takeaway #${item.order_id} ready (all items served — awaiting staff close)`);
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
    let ghostItemId = null;
    if (qtyToVoid < orig.quantity && qtyToVoid >= 1) {
      // Partial void: shrink the original row, insert a voided-ghost copy
      // that carries the same per-item state (status/fired/served/etc.) so
      // reports and the kitchen screen treat it consistently.
      const remaining = orig.quantity - qtyToVoid;
      await pool.query('UPDATE order_items SET quantity=$1 WHERE id=$2', [remaining, req.params.id]);
      const ghostRes = await pool.query(
        `INSERT INTO order_items
           (order_id, menu_item_id, item_name, quantity, unit_price, notes, course, item_note,
            status, is_fired, fired_at, cooking_started_at, served_at, voided, void_reason,
            void_type, discount_type, discount_value)
         SELECT order_id, menu_item_id, item_name, $1, unit_price, notes, course, item_note,
            status, is_fired, fired_at, cooking_started_at, served_at, 1, $2,
            $3, discount_type, discount_value
         FROM order_items WHERE id=$4 RETURNING id`,
        [qtyToVoid, reason, void_type || null, req.params.id]
      );
      ghostItemId = ghostRes.rows[0]?.id ?? null;
    } else {
      // Full void — existing behaviour.
      await pool.query('UPDATE order_items SET voided=1, void_reason=$1, void_type=$2 WHERE id=$3', [reason, void_type || null, req.params.id]);
    }
    // SEPOS-047c — forward quantity + void_type so the cloud voids the SAME
    // amount (was sending only {reason}, so the cloud defaulted to a FULL
    // void of the line — corrupting cloud revenue/wastage). ghostLocalId
    // lets the sync bind the local partial-void ghost to the cloud ghost
    // so the next pull doesn't INSERT a duplicate ghost (double-count).
    await offlineQueue.enqueue('void_item', {
      localItemId: Number(req.params.id), reason,
      quantity: qtyToVoid, void_type: void_type || null,
      ghostLocalId: ghostItemId,
    });
    const itemRes = await pool.query('SELECT order_id FROM order_items WHERE id = $1', [req.params.id]);
    const item = itemRes.rows[0];
    if (item) {
      const totalRes = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id=$1 AND voided=0`, [item.order_id]); // SEPOS-047c — keep per-item discounts
      await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, item.order_id]);
      io.emit('item_voided', { item_id: req.params.id });
      const countRes = await pool.query('SELECT COUNT(*) as remaining FROM order_items WHERE order_id=$1 AND voided=0', [item.order_id]);
      if (parseInt(countRes.rows[0].remaining) === 0) {
        await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [item.order_id]);
        const orderRes = await pool.query('SELECT table_id FROM orders WHERE id=$1', [item.order_id]);
        if (orderRes.rows[0]) await pool.query("UPDATE tables SET status='available' WHERE id=$1", [orderRes.rows[0].table_id]);
      }
    }
    // SEPOS-047c — return the ghost id so a desktop sync push can bind its
    // local ghost to this cloud ghost (prevents duplicate on next pull).
    res.json({ success: true, ghost_item_id: ghostItemId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/discount', async (req, res) => {
  try {
    const { discount_type, discount_value, discount_reason } = req.body;
    await pool.query('UPDATE orders SET discount_type=$1, discount_value=$2, discount_reason=$3 WHERE id=$4', [discount_type, discount_value, discount_reason, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS — persist the Order screen's "Remove service charge" toggle per order.
// Was local React state only, so the Bill / receipt / splits re-added service
// charge from the global setting. Body: { no_service_charge: 0 | 1 }.
app.put('/api/orders/:id/service-charge', async (req, res) => {
  try {
    const flag = req.body.no_service_charge ? 1 : 0;
    await pool.query('UPDATE orders SET no_service_charge = $1 WHERE id = $2', [flag, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-CLOSE-ZERO — close an order that's at £0 (everything voided OR
// fully discounted by manager). Operators were stuck after voiding every
// item because the "View Bill & Pay" button hid itself at £0 and there
// was no way to mark the table available again without re-opening the
// last voided item or hitting an admin force-close.
//
// Defended by:
//   1. Order must be status='open' (409 otherwise)
//   2. Live bill total (non-voided items minus discounts) must be ≤ £0.01
//      so an accidental tap on this endpoint with a real bill outstanding
//      bounces with a clear error rather than silently writing off the
//      revenue.
// Records a £0 payment with method='zero' so the row still appears in
// reports (avoids an order with status='closed' but no payment which
// would break joins on the closed-orders endpoint).
app.post('/api/orders/:id/close-zero', async (req, res) => {
  const orderId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT id, status, discount_type, discount_value FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const order = ord.rows[0];
    if (!order)                  { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Order is ${order.status}` }); }

    const itemsRes = await client.query(
      `SELECT unit_price, quantity, discount_type, discount_value, voided FROM order_items WHERE order_id=$1`,
      [orderId]
    );
    let subtotal = 0;
    for (const it of itemsRes.rows) {
      if (it.voided) continue;
      let p = Number(it.unit_price || 0) * Number(it.quantity || 0);
      if (it.discount_value > 0) {
        if (it.discount_type === 'percent') p *= (1 - Number(it.discount_value) / 100);
        else p = Math.max(0, p - Number(it.discount_value));
      }
      subtotal += p;
    }
    let total = subtotal;
    if (order.discount_value > 0) {
      if (order.discount_type === 'percent') total *= (1 - Number(order.discount_value) / 100);
      else total = Math.max(0, total - Number(order.discount_value));
    }
    if (total > 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Bill total is £${total.toFixed(2)}, not £0 — use the normal pay flow` });
    }

    await client.query('INSERT INTO payments (order_id, amount, method) VALUES ($1, 0, $2)', [orderId, 'zero']);
    await client.query(`UPDATE orders SET status='closed', closed_at=NOW(), total=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [orderId]);
    await client.query('COMMIT');
    io.emit('order_closed', { order_id: Number(orderId) });
    res.json({ success: true, total: 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[close-zero]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/orders/:id/pay', requireValidLicense, async (req, res) => {
  const { amount, method } = req.body;
  const orderId = req.params.id;
  const isCancel = String(method).toLowerCase() === 'cancelled' && Number(amount) === 0;
  // SEPOS-062 — split payments. When the bill is settled with more than one
  // tender (e.g. £50 cash + £50 card), the client sends `payments: [{amount,
  // method}, …]` and we record ONE payments row per tender with its REAL
  // method. Previously a split wrote a single row with method 'Split', which
  // the Z-report buckets into "Other" — so cash-drawer reconciliation was
  // wrong on any day with split bills. Single-tender stays on {amount,method}.
  // BUG-002 — reject non-positive / non-numeric amounts (a negative used to
  // record 200 OK, a way to quietly reduce takings). Validated up front (pure,
  // no DB) so a bad request fails before we open a transaction.
  const tenders = Array.isArray(req.body.payments) && req.body.payments.length ? req.body.payments : null;
  let paymentRows = null;
  if (!isCancel) {
    if (tenders) {
      paymentRows = [];
      for (const t of tenders) {
        const a = Number(t.amount);
        if (!Number.isFinite(a) || a <= 0) {
          return res.status(400).json({ error: 'Each split payment amount must be a positive number' });
        }
        paymentRows.push({ amount: a, method: t.method || 'Other' });
      }
    } else {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Payment amount must be a positive number' });
      }
      paymentRows = [{ amount: amt, method }];
    }
  }
  // SEPOS-DBLPAY-001 — transactional, row-locked payment. The old flow only
  // checked the order EXISTED, not that it was still open, so a double-tapped
  // "Done — Close" button (or a retried request) wrote a SECOND payment row
  // and closed the order twice → the Thann Thai T1 £78.14 double-charge
  // (05 Jul 2026). Now we lock the row (FOR UPDATE serialises concurrent
  // requests on PG; SQLite is single-writer) and gate on status='open': the
  // first request closes the bill, any later request finds it already closed
  // and is rejected with 409 — no duplicate payment can ever be recorded.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT id, status, table_id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const order = ord.rows[0];
    // BUG-006 — 404 if the order does not exist (was a raw 500 on FK violation).
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }

    // SEPOS-047c — explicit cancel of an empty/all-voided order. The
    // OrderScreen Back button sends amount=0, method='cancelled'; honour the
    // cancel here (no payment row) then free the table below.
    if (isCancel) {
      if (order.status !== 'open') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `This bill is already ${order.status}.`, alreadyClosed: true });
      }
      await client.query(`UPDATE orders SET status='cancelled', closed_at=NOW(), session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [orderId]);
      await client.query('COMMIT');
      if (order.table_id) await pool.query("UPDATE tables SET status='available' WHERE id=$1", [order.table_id]);
      return res.json({ success: true, cancelled: true });
    }

    // Double-charge guard — only an OPEN bill can be paid.
    if (order.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This bill has already been paid.', alreadyPaid: true });
    }

    for (const p of paymentRows) {
      await client.query('INSERT INTO payments (order_id, amount, method) VALUES ($1,$2,$3)', [orderId, p.amount, p.method]);
    }
    await client.query(`UPDATE orders SET status='closed', closed_at=NOW(), session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [orderId]);
    await client.query('COMMIT');

    // ---- post-commit side effects (the order is now closed) ----
    const tableId = order.table_id;
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
      // SEPOS-PRO-008 — and stamp orders.reservation_id so the bill is tied
      // EXACTLY to that booking (and its customer), replacing the old
      // table_id+date guess in the CRM spend aggregation. We pick the most
      // recently updated 'seated' reservation on the same table. Two queries
      // (instead of one subquery) so the path works identically on PG and
      // SQLite. Reports + the booking timeline both rely on this flip —
      // walk-ins (no seated booking) simply stay unlinked.
      try {
        const seated = await pool.query(
          `SELECT id FROM reservations WHERE table_id=$1 AND status='seated'
           ORDER BY updated_at DESC LIMIT 1`,
          [tableId]
        );
        if (seated.rows[0]) {
          // Link the just-paid bill to the booking for accurate spend.
          await pool.query(`UPDATE orders SET reservation_id=$1 WHERE id=$2`, [seated.rows[0].id, orderId]);
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
    await offlineQueue.enqueue('pay_order', { localOrderId: Number(orderId), amount, method, payments: tenders || undefined });
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/orders/:id/bill', async (req, res) => {
  try {
    const [orderRes, itemsRes, settingsRes] = await Promise.all([
      pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.id=$1`, [req.params.id]),
      pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt, menu_items.vat_rate FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.order_id=$1 AND order_items.voided=0`, [req.params.id]),
      pool.query('SELECT * FROM settings')
    ]);
    // Missing order used to return 200 with `{order:{items:[]}}` — the
    // frontend's `bill?.order` check passes because `{items:[]}` is truthy,
    // and BillPeek/BillScreen then render with no order data → blank panel.
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const settings = {};
    settingsRes.rows.forEach(r => settings[r.key] = r.value);
    res.json({ order: { ...order, items: itemsRes.rows }, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff/login', async (req, res) => {
  try {
    const { pin } = req.body;
    const result = await pool.query('SELECT * FROM staff WHERE pin=$1 AND is_active=1', [pin]);
    const staff = result.rows[0];
    if (!staff) return res.status(401).json({ error: 'Invalid PIN' });
    // SEPOS-047a — PIN login now issues the same HMAC session token as
    // email login (signToken below), so staff-gated endpoints can verify
    // the caller. Old clients ignore the extra fields harmlessly.
    const exp = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const token = signToken({ sid: staff.id, name: staff.name, role: staff.role, exp });
    res.json({ id: staff.id, name: staff.name, role: staff.role, token, expires_at: exp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEPOS-LITE-003 — email + password login ──────────────────────────
// An additional login path for Lite restaurant owners using the full
// app. Credentials live on the staff table; the PIN login above is
// untouched. Built on Node's `crypto` — no extra dependencies.
// password_hash format: "<saltHex>:<scrypt(password,salt,64)Hex>".
// SEPOS-061 security fix — never run on the PUBLIC default secret in production.
// The default is in the open-source repo, so if a deploy forgets AUTH_SECRET an
// attacker could forge admin Bearer tokens AND hit the X-Setup-Secret-gated
// endpoints (set-credentials → mint an admin owner). When unset/default in
// production we substitute a RANDOM per-boot secret: tokens become unforgeable
// (the public default no longer validates) and the setup endpoints can't be
// called with the known default. Side effect — sessions reset on restart and
// the provisioner must use the real AUTH_SECRET — both correct/intended.
const DEFAULT_AUTH_SECRET = 'siamepos-dev-auth-secret-change-me';
let AUTH_SECRET = process.env.AUTH_SECRET || DEFAULT_AUTH_SECRET;
if ((!process.env.AUTH_SECRET || AUTH_SECRET === DEFAULT_AUTH_SECRET) && process.env.NODE_ENV === 'production') {
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Self-expiring HMAC-signed session token (a minimal JWT-style token).
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// SEPOS-047a — verify a signToken() token: HMAC signature + expiry.
// Returns the {sid, name, role, exp} payload, or null.
function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// SEPOS-060 — subscription gate. Blocks cloud-dependent actions for a churned
// client (online ordering/booking, login, sync). `active` + `past_due` pass
// (past_due gets a grace window + a warning shown elsewhere). Fail OPEN on any
// DB/lookup error — never block a paying client over a transient glitch.
async function requireActiveSubscription(req, res, next) {
  try {
    const rid = resolveRestaurantId(req);
    const r = await pool.query('SELECT status FROM restaurants WHERE restaurant_id = $1', [rid]);
    const status = (r.rows[0] && r.rows[0].status) || 'active';
    if (status === 'churned' || status === 'cancelled' || status === 'suspended') {
      return res.status(403).json({
        error: 'subscription_inactive',
        status,
        message: 'This SiamEPOS subscription is inactive. Please contact SiamEPOS to reactivate.',
      });
    }
    next();
  } catch (err) {
    console.warn('[license] subscription gate check failed (allowing):', err.message);
    next();
  }
}

// SEPOS-060 phase 2 — desktop OFFLINE license gate. Backstop to the React lock
// screen so a UI-only bypass can't keep trading on a lapsed till. ONLY enforces
// on the desktop (local mode); the cloud uses requireActiveSubscription above.
// Fails OPEN (licenseClient is fail-open by design — never locks until a signed
// token has been seen, i.e. until LICENSE_PRIVATE_KEY is deployed).
function requireValidLicense(req, res, next) {
  try {
    if (!offlineQueue.isLocal) return next();
    const st = licenseClient.getLicenseState();
    if (st && st.locked) {
      return res.status(403).json({
        error: 'license_locked',
        reason: st.reason,
        message: 'SiamEPOS subscription has lapsed. Please contact SiamEPOS to reactivate this till.',
      });
    }
  } catch (e) {
    // Any glitch → allow (a paying till must never be locked by a bug here).
  }
  next();
}

// SEPOS-047a — route gate for staff-only endpoints. Both login paths
// (PIN and email) now issue Bearer tokens; api.js attaches them to every
// request. The 401 message doubles as guidance for stale cached clients
// that don't send a token yet.
function requireStaffAuth(roles = null) {
  return (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const payload = m ? verifyToken(m[1]) : null;
    if (!payload) {
      return res.status(401).json({ error: 'Please sign out and sign in again to use this section (session expired or app needs a refresh)' });
    }
    if (roles && !roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Your role does not have access to this section' });
    }
    req.staffAuth = payload;
    next();
  };
}

// SEPOS-047a — variant for endpoints the desktop relays server-to-server
// (AI scans: the till has no ANTHROPIC_API_KEY and forwards to cloud).
// The relay can't mint a Bearer token the cloud would trust (different
// AUTH_SECRET), so it authenticates with the install's SYNC_SECRET —
// the same shared secret that already gates the order-sync feeds.
function requireStaffAuthOrSyncSecret(roles = null) {
  const gate = requireStaffAuth(roles);
  return (req, res, next) => {
    const provided = req.get('x-sync-secret') || '';
    const expected = process.env.SYNC_SECRET || '';
    if (expected && provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req.staffAuth = { sid: null, name: 'desktop-relay', role: 'admin' };
        return next();
      }
    }
    return gate(req, res, next);
  };
}

if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === DEFAULT_AUTH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('🔒 AUTH_SECRET unset/default in production — using a RANDOM per-boot secret. Tokens reset on restart and the setup/credential endpoints are unusable until you set AUTH_SECRET in the environment.');
  } else {
    console.warn('⚠️  AUTH_SECRET not set — using the dev default. Set AUTH_SECRET on any internet-facing deployment.');
  }
}

// Owner signs in with email + password. Returns a 14-day token.
app.post('/api/auth/email-login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const r = await pool.query(
      `SELECT * FROM staff WHERE LOWER(email) = LOWER($1) AND is_active = 1`,
      [String(email).trim()]
    );
    const staff = r.rows[0];
    if (!staff || !staff.password_hash || !verifyPassword(password, staff.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const exp = Date.now() + 14 * 24 * 60 * 60 * 1000; // 14-day session
    const token = signToken({ sid: staff.id, name: staff.name, role: staff.role, exp });
    res.json({
      token,
      expires_at: exp,
      staff: { id: staff.id, name: staff.name, role: staff.role },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create / update an email + password login on the staff table. Called
// by the Lite onboarding when a deployment is provisioned. Secret-gated
// (X-Setup-Secret must match AUTH_SECRET) so it can't be abused to mint
// admin logins.
app.post('/api/auth/set-credentials', async (req, res) => {
  try {
    if ((req.get('X-Setup-Secret') || '') !== AUTH_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { email, password, name, pin } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const clean = String(email).trim();
    const hash = hashPassword(password);
    // SEPOS-054 fix — the owner MUST carry a PIN. The till's local staff.pin is
    // NOT NULL and PIN login keys on it, so a pin-less owner row silently never
    // syncs to a freshly-provisioned till (this blocked Chart Thai's first
    // login). Use the PIN the provisioner passed, else allocate a free one.
    const requestedPin = pin != null ? String(pin).replace(/\D/g, '').slice(0, 6) : '';
    const freePin = async () => {
      const used = await pool.query(`SELECT pin FROM staff WHERE pin IS NOT NULL`);
      const taken = new Set(used.rows.map((r) => String(r.pin)));
      for (let p = 1234; p <= 9999; p++) { const s = String(p); if (!taken.has(s)) return s; }
      for (let p = 1000; p < 1234; p++) { const s = String(p); if (!taken.has(s)) return s; }
      return null;
    };
    const existing = await pool.query(`SELECT id, pin FROM staff WHERE LOWER(email) = LOWER($1)`, [clean]);
    if (existing.rows[0]) {
      const ownerPin = requestedPin || existing.rows[0].pin || (await freePin());
      await pool.query(`UPDATE staff SET password_hash = $1, is_active = 1, pin = $2 WHERE id = $3`, [hash, ownerPin, existing.rows[0].id]);
      return res.json({ id: existing.rows[0].id, updated: true, pin: ownerPin });
    }
    const ownerPin = requestedPin || (await freePin());
    const ins = await pool.query(
      `INSERT INTO staff (name, pin, role, email, password_hash, is_active) VALUES ($1, $2, 'admin', $3, $4, 1) RETURNING id`,
      [name || 'Owner', ownerPin, clean, hash]
    );
    res.json({ id: ins.rows[0].id, created: true, pin: ownerPin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Seed the restaurants registry row for a new client deployment.
// Called by provision-client.sh after deployment — secret-gated.
app.post('/api/setup/seed-categories', async (req, res) => {
  try {
    if ((req.get('X-Setup-Secret') || '') !== AUTH_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const existing = await pool.query('SELECT COUNT(*) as n FROM categories');
    if (parseInt(existing.rows[0].n) > 0) {
      return res.json({ skipped: true, message: 'Categories already exist' });
    }
    // Accept categories passed in from the provision script (copied from main system)
    const categories = req.body.categories;
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'categories array required' });
    }
    for (const cat of categories) {
      await pool.query(
        'INSERT INTO categories (name, sort_order, is_bar, default_course) VALUES ($1, $2, $3, $4)',
        [cat.name, cat.sort_order, cat.is_bar ?? 0, cat.default_course ?? 1]
      );
    }
    res.json({ seeded: true, count: categories.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Migrate all rows stamped with a stale restaurant_id to the correct one.
// Safe to call multiple times — only touches rows with the old id.
// Usage: POST /api/setup/migrate-restaurant-id { from: 'siamepos', to: 'baan-siam' }
app.post('/api/setup/migrate-restaurant-id', async (req, res) => {
  try {
    if ((req.get('X-Setup-Secret') || '') !== AUTH_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const from = req.body.from || 'siamepos';
    const to   = req.body.to   || (process.env.RESTAURANT_ID || 'siamepos');
    if (from === to) return res.json({ skipped: true, message: 'from and to are the same' });

    const tables = [
      'reservations', 'orders', 'order_items', 'payments',
      'menu_items', 'categories', 'staff', 'tables',
      'settings', 'dining_duration_tiers', 'restaurant_settings',
    ];
    const results = {};
    for (const table of tables) {
      try {
        const r = await pool.query(
          `UPDATE ${table} SET restaurant_id = $1 WHERE restaurant_id = $2`,
          [to, from]
        );
        results[table] = r.rowCount;
      } catch (e) {
        results[table] = `skipped (${e.message})`;
      }
    }
    res.json({ migrated: true, from, to, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/setup/restaurant', async (req, res) => {
  try {
    if ((req.get('X-Setup-Secret') || '') !== AUTH_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { restaurant_id, name, plan, status } = req.body || {};
    if (!restaurant_id || !name) return res.status(400).json({ error: 'restaurant_id and name required' });
    const existing = await pool.query(`SELECT restaurant_id FROM restaurants WHERE restaurant_id = $1`, [restaurant_id]);
    if (existing.rows[0]) {
      await pool.query(
        `UPDATE restaurants SET name=$1, plan=$2, status=$3 WHERE restaurant_id=$4`,
        [name, plan || 'pro', status || 'active', restaurant_id]
      );
      return res.json({ updated: true, restaurant_id });
    }
    await pool.query(
      `INSERT INTO restaurants (restaurant_id, name, plan, status, created_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [restaurant_id, name, plan || 'pro', status || 'active']
    );
    res.json({ created: true, restaurant_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-STRIPE-001 — Stripe subscription billing webhook
// The central SiamEPOS Stripe account posts subscription lifecycle
// events here. We map the subscription's price ID to a SiamEPOS plan,
// write it onto the restaurants registry, and flag payment failures.
// Raw body parser is registered up top (next to express.json).
// ─────────────────────────────────────────────────────────────────────

// Stripe price ID → SiamEPOS plan name. Price IDs come from the four
// Stripe Products, supplied as Railway env vars.
const STRIPE_PLAN_PRICES = {
  lite_booking:  process.env.STRIPE_PRICE_LITE_BOOKING,
  lite_ordering: process.env.STRIPE_PRICE_LITE_ORDERING,
  lite_bundle:   process.env.STRIPE_PRICE_LITE_BUNDLE,
  pro:           process.env.STRIPE_PRICE_PRO,
};
function planForPriceId(priceId) {
  if (!priceId) return null;
  const hit = Object.entries(STRIPE_PLAN_PRICES).find(([, id]) => id && id === priceId);
  return hit ? hit[0] : null;
}

// SEPOS-060 fix — map Stripe's subscription.status to our internal
// restaurants.status that requireActiveSubscription understands. The webhook
// used to hard-code 'active' for every subscription.updated event, so a
// past_due/canceled sub stayed 'active' and the gate never fired. Note Stripe
// spells it 'canceled' (one L) → our blocking status is 'churned'. Unknown
// states fail OPEN (treated active) so a paying client is never wrongly locked.
function mapStripeStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';       // serve + warning, grace window — no hard lock
    case 'canceled':
    case 'incomplete_expired':
      return 'churned';        // blocked by the gate
    case 'paused':
      return 'suspended';      // blocked by the gate
    default:
      return 'active';
  }
}

// Resolve which restaurant a Stripe object belongs to. The Lite checkout
// stamps subscription_data.metadata.restaurant_id, so events usually
// carry it; otherwise fall back to the Stripe customer / subscription id
// already stored on the restaurants registry.
async function restaurantIdForStripe({ metadataRestaurantId, customerId, subscriptionId }) {
  if (metadataRestaurantId) return metadataRestaurantId;
  if (subscriptionId) {
    const r = await pool.query(`SELECT restaurant_id FROM restaurants WHERE stripe_subscription_id = $1`, [subscriptionId]);
    if (r.rows[0]) return r.rows[0].restaurant_id;
  }
  if (customerId) {
    const r = await pool.query(`SELECT restaurant_id FROM restaurants WHERE stripe_customer_id = $1`, [customerId]);
    if (r.rows[0]) return r.rows[0].restaurant_id;
  }
  return null;
}

app.post('/api/stripe/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not set — cannot verify webhook');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    // constructEvent is pure HMAC verification — it never calls the Stripe
    // API, so no real secret key is needed here; the SDK constructor just
    // requires *some* key string to instantiate.
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_webhook_verify_only');
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const rid = await restaurantIdForStripe({
          metadataRestaurantId: sub.metadata?.restaurant_id,
          customerId: sub.customer,
          subscriptionId: sub.id,
        });
        const plan = planForPriceId(sub.items?.data?.[0]?.price?.id);
        if (!rid) {
          console.warn(`[stripe] ${event.type}: no matching restaurant (customer=${sub.customer}, sub=${sub.id})`);
        } else if (!plan) {
          console.warn(`[stripe] ${event.type}: price not mapped to a plan for ${rid}`);
        } else {
          // Map Stripe's status to our internal status (active/past_due/
          // churned/suspended) so the subscription gate actually fires.
          const mappedStatus = mapStripeStatus(sub.status);
          // A recovered subscription (back to active) clears any earlier
          // payment-failure flag.
          const clearFailure = mappedStatus === 'active' ? ', payment_failed_at = NULL' : '';
          await pool.query(
            `UPDATE restaurants
                SET plan = $1,
                    status = $2,
                    stripe_customer_id = $3,
                    stripe_subscription_id = $4${clearFailure}
              WHERE restaurant_id = $5`,
            [plan, mappedStatus, sub.customer || null, sub.id, rid]
          );
          console.log(`[stripe] ${event.type}: ${rid} → plan=${plan} stripe=${sub.status} status=${mappedStatus}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const rid = await restaurantIdForStripe({
          metadataRestaurantId: sub.metadata?.restaurant_id,
          customerId: sub.customer,
          subscriptionId: sub.id,
        });
        if (rid) {
          await pool.query(
            `UPDATE restaurants SET plan = 'suspended', status = 'suspended' WHERE restaurant_id = $1`,
            [rid]
          );
          console.log(`[stripe] subscription cancelled: ${rid} → suspended`);
        } else {
          console.warn(`[stripe] subscription.deleted: no matching restaurant (sub=${sub.id})`);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const rid = await restaurantIdForStripe({
          metadataRestaurantId: invoice.metadata?.restaurant_id,
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
        });
        if (rid) {
          await pool.query(
            `UPDATE restaurants SET payment_failed_at = CURRENT_TIMESTAMP WHERE restaurant_id = $1`,
            [rid]
          );
          console.warn(`[stripe] payment failed: ${rid} flagged (invoice=${invoice.id})`);
        } else {
          console.warn(`[stripe] invoice.payment_failed: no matching restaurant (customer=${invoice.customer})`);
        }
        break;
      }
      case 'payment_intent.succeeded': {
        // SEPOS-040 — takeaway order has been paid. Look up the order
        // by payment_intent_id and flip payment_status to 'paid'.
        // Vouchers also use payment_intents, but they're verified
        // synchronously in /api/widget/voucher/confirm — so the webhook
        // is belt-and-braces, not the primary path. Only takeaway uses
        // the metadata.product='siamepos_takeaway' tag.
        const pi = event.data.object;
        if (pi.metadata?.product === 'siamepos_takeaway') {
          const r = await pool.query(
            `UPDATE orders
                SET payment_status = 'paid'
              WHERE payment_intent_id = $1
                AND COALESCE(payment_status, '') != 'paid'`,
            [pi.id]
          );
          if (r.rowCount > 0) {
            console.log(`[stripe] takeaway paid: pi=${pi.id} → order flipped to paid`);
            // Notify kitchen view so the order moves to the paid lane
            // without waiting for the next poll. Same socket pattern the
            // existing takeaway flow uses.
            try { io.emit('takeaway_status', { payment_intent_id: pi.id, payment_status: 'paid' }); } catch {}
          }
        }
        break;
      }
      default:
        // Other event types are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    // Log but still 200 — a non-2xx makes Stripe retry the same failing
    // event for days. The event stays recoverable from the Stripe
    // dashboard if a handler bug needs fixing.
    console.error(`[stripe] handler error for ${event.type}:`, err.message);
  }
  return res.json({ received: true });
});

app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, role, is_active, created_at, start_date, notes, employment_status FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', async (req, res) => {
  if (await maybeForwardStaffWriteToCloud(req, res)) return;
  try {
    const { name, pin, role, start_date, notes, employment_status } = req.body;
    // SEPOS-047k — PINs are UNIQUE (staff_pin_key / staff.pin UNIQUE). A
    // collision used to surface as a raw 500 "duplicate key value violates
    // unique constraint" → the Staff screen just said "Save failed!" with
    // no clue. Pre-check and return a clear, actionable 409 instead.
    const dup = await pool.query('SELECT name FROM staff WHERE pin = $1', [pin]);
    if (dup.rows[0]) {
      return res.status(409).json({ error: `PIN ${pin} is already used by ${dup.rows[0].name}. Please choose a different 4-digit PIN.` });
    }
    const result = await pool.query('INSERT INTO staff (name, pin, role, start_date, notes, employment_status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [name, pin, role, start_date || null, notes || null, employment_status || 'active']);
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) {
    if (/unique|duplicate/i.test(err.message || '')) {
      return res.status(409).json({ error: `That PIN is already used by another staff member. Please choose a different 4-digit PIN.` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', async (req, res) => {
  if (await maybeForwardStaffWriteToCloud(req, res)) return;
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
    // SEPOS-047k — same friendly duplicate-PIN guard as create, excluding
    // this staff member's own row.
    if (pin) {
      const dup = await pool.query('SELECT name FROM staff WHERE pin = $1 AND id <> $2', [pin, req.params.id]);
      if (dup.rows[0]) {
        return res.status(409).json({ error: `PIN ${pin} is already used by ${dup.rows[0].name}. Please choose a different 4-digit PIN.` });
      }
    }
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
  } catch (err) {
    if (/unique|duplicate/i.test(err.message || '')) {
      return res.status(409).json({ error: `That PIN is already used by another staff member. Please choose a different 4-digit PIN.` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  if (await maybeForwardStaffWriteToCloud(req, res)) return;
  try {
    await pool.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-047k — SYNC_SECRET-gated staff feed WITH pins, for the desktop
// cloud→local pull. The public GET /api/staff omits pin (so PINs aren't
// exposed on an unauthenticated endpoint), but the till NEEDS pins to
// (a) show the real staff list and (b) authenticate staff login locally.
// Without this the pull tried to INSERT cloud staff with no pin and hit
// the local `pin NOT NULL` constraint, so staff created on the cloud never
// reached the till — the operator saw a stale list and kept colliding with
// PINs they couldn't see. Same trust model as the closed/active-order feeds.
app.get('/api/sync/staff', async (req, res) => {
  const provided = req.get('x-sync-secret') || '';
  const expected = process.env.SYNC_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'SYNC_SECRET not set on this server' });
  if (provided !== expected) return res.status(401).json({ error: 'invalid sync secret' });
  try {
    const result = await pool.query('SELECT * FROM staff');
    res.json(result.rows);
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

app.put('/api/settings', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    }

    // SEPOS-049 part-2 — same write-through pattern for the KV settings
    // table. Without this, desktop saves to e.g. printer_kitchen_ip,
    // restaurant_postcode, delivery_radius_miles, kitchen_print_mode,
    // service_charge_rate land in local SQLite and get overwritten on
    // the next pull tick (cloud is authoritative). Enqueue first so
    // offline saves can't be silently lost, then immediate push.
    const archiveService = require('./services/archiveService');
    const isLocal = archiveService.isLocalInstall();
    const cloudUrl = process.env.CLOUD_API_URL;
    if (isLocal) {
      const offlineQueue = require('./services/offlineQueue');
      const queueId = await offlineQueue.enqueue('update_kv_settings', { updates });
      console.log(`[sync] KV settings PUT enqueued as queueId=${queueId} (${Object.keys(updates).length} keys)`);
      if (queueId && cloudUrl && process.env.SYNC_SECRET) {
        fetch(`${cloudUrl}/api/settings`, {
          method: 'PUT',
          // PUT /api/settings is gated (requireStaffAuthOrSyncSecret) — the
          // desktop relay can't mint a cloud Bearer token, so it authenticates
          // with the install's SYNC_SECRET like the other sync feeds. Without
          // SYNC_SECRET the push is skipped (stays queued) — same as closed/
          // active-order sync — and the drain retries once it's set.
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': process.env.SYNC_SECRET },
          body: JSON.stringify(updates),
        })
          .then(async r => {
            if (r.ok) {
              await offlineQueue.markSynced(queueId);
              console.log(`[sync] ✓ KV settings pushed to cloud (${Object.keys(updates).length} keys)`);
            } else {
              console.warn(`[sync] ✗ KV settings push ${r.status} — left in queue for retry`);
            }
          })
          .catch(err => console.warn('[sync] KV settings push failed, queued for retry:', err.message));
      }
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LITE-001 Phase 2a — the restaurant's subscription plan. The
// frontend uses `plan` to gate features (Pro = everything; lite tiers =
// widgets + matching fulfilment screens). Fail-open to 'pro' on any
// error or missing registry row so a Pro install can never be locked
// out of its own EPOS.
app.get('/api/restaurant', async (req, res) => {
  const rid = resolveRestaurantId(req);
  try {
    const r = await pool.query(
      `SELECT restaurant_id, name, plan, status FROM restaurants WHERE restaurant_id = $1`,
      [rid]
    );
    if (r.rows[0] && r.rows[0].name) return res.json(r.rows[0]);
    // On a desktop till the restaurants registry isn't synced locally, so the
    // local row has no name. Fall back to the cloud's record so the app can show
    // WHICH restaurant this till is (otherwise every till reads as 'SiamEPOS').
    if (offlineQueue.isLocal && process.env.CLOUD_API_URL) {
      try {
        const cr = await fetch(process.env.CLOUD_API_URL + '/api/restaurant', { signal: AbortSignal.timeout(4000) });
        if (cr.ok) {
          const data = await cr.json();
          if (data && (data.name || data.restaurant_id)) return res.json(data);
        }
      } catch { /* offline — fall through to whatever we have locally */ }
    }
    if (r.rows[0]) return res.json(r.rows[0]);
    res.json({ restaurant_id: rid, name: null, plan: 'pro', status: 'active' });
  } catch (err) {
    console.error('GET /api/restaurant error:', err.message);
    res.json({ restaurant_id: rid, name: null, plan: 'pro', status: 'active' });
  }
});

// SEPOS-060 — license check. The desktop calls this on launch + periodically.
// When the subscription is active/past_due it returns a SIGNED token the till
// caches and verifies offline (valid for GRACE_DAYS); when churned it returns
// { active:false } so the till locks once its cached token expires. If
// LICENSE_PRIVATE_KEY isn't set, we "fail open" (active, unsigned) so licensing
// can be rolled out without bricking tills before the key is deployed.
app.get('/api/license', async (req, res) => {
  try {
    const rid = resolveRestaurantId(req);
    const r = await pool.query('SELECT restaurant_id, plan, status FROM restaurants WHERE restaurant_id = $1', [rid]);
    const row = r.rows[0] || { restaurant_id: rid, plan: 'pro', status: 'active' };
    const status = row.status || 'active';
    if (status === 'churned' || status === 'cancelled' || status === 'suspended') {
      return res.json({ active: false, status });
    }
    const now = Date.now();
    const payload = {
      restaurant_id: row.restaurant_id,
      plan: row.plan || 'pro',
      status,                                   // active | past_due
      issued_at: now,
      valid_until: now + licenseService.GRACE_DAYS * 24 * 60 * 60 * 1000,
    };
    const token = licenseService.signLicense(payload);
    if (!token) return res.json({ active: true, status, unsigned: true, valid_until: payload.valid_until });
    res.json({ active: true, status, token, valid_until: payload.valid_until });
  } catch (err) {
    // Fail open — a glitch must never lock a paying client out.
    res.json({ active: true, status: 'active', error: err.message });
  }
});

// SEPOS-060 phase 2 — the DESKTOP till's cached offline lock decision. The React
// lock screen polls this (it reads the local licenseClient cache, not the cloud,
// so it works offline). On the cloud this returns not-enforced (unlocked).
app.get('/api/license-state', (req, res) => {
  try {
    res.json(licenseClient.getLicenseState());
  } catch (e) {
    res.json({ locked: false, reason: 'error', error: e.message });
  }
});

// SEPOS-060 phase 2 — force an immediate cloud check-in (the lock screen's
// "I've paid — re-check" button), then return the fresh lock decision.
app.post('/api/license-recheck', async (req, res) => {
  try {
    await licenseClient.checkIn();
    res.json(licenseClient.getLicenseState());
  } catch (e) {
    res.json({ locked: false, reason: 'error', error: e.message });
  }
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

// ── SEPOS-KITCHEN-MSG-001 — kitchen-message templates + send ─────────
app.get('/api/kitchen-templates', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM kitchen_message_templates WHERE is_active=1 ORDER BY sort_order ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/kitchen-templates', async (req, res) => {
  try {
    const { label, message, icon, sort_order } = req.body || {};
    if (!label || !message) return res.status(400).json({ error: 'label and message required' });
    const result = await pool.query(
      'INSERT INTO kitchen_message_templates (label, message, icon, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [label, message, icon || null, Number(sort_order) || 100]
    );
    res.json({ id: result.rows[0].id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/kitchen-templates/:id', async (req, res) => {
  try {
    const { label, message, icon, sort_order } = req.body || {};
    await pool.query(
      'UPDATE kitchen_message_templates SET label=$1, message=$2, icon=$3, sort_order=$4 WHERE id=$5',
      [label, message, icon || null, Number(sort_order) || 100, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/kitchen-templates/:id', async (req, res) => {
  try {
    await pool.query('UPDATE kitchen_message_templates SET is_active=0 WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-KITCHEN-MSG-001 — send a kitchen message: prints the distinctive
// 📢 ticket to the kitchen printer (if configured) AND emits a
// `kitchen_message` socket event so the KDS shows a banner. Optional
// order_id ties the message to a specific bill so the chef knows which
// table it's for; otherwise it's a generic floor-wide announcement.
app.post('/api/print/kitchen-message', async (req, res) => {
  try {
    const { order_id, table_number, customer_name, message, waiter_name } = req.body || {};
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: 'message required' });

    let resolvedTable = table_number || '';
    let resolvedType  = 'dine_in';
    let resolvedCustomer = customer_name || '';
    if (order_id && !resolvedTable) {
      const r = await pool.query(
        `SELECT o.id, o.order_type, o.customer_name, t.table_number
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id
         WHERE o.id = $1`, [order_id]
      ).catch(() => ({ rows: [] }));
      const o = r.rows[0];
      if (o) {
        resolvedTable    = o.table_number || '';
        resolvedType     = o.order_type || 'dine_in';
        resolvedCustomer = o.customer_name || customer_name || '';
      }
    }

    // Try to print — failure is non-fatal because the KDS banner still
    // gets the message and the chef will see it.
    const settings = await loadSettings();
    let printed = false;
    try {
      await printService.printKitchenMessage(settings, {
        order_id, table_number: resolvedTable, order_type: resolvedType,
        customer_name: resolvedCustomer, message: text, waiter_name: waiter_name || '',
      });
      printed = true;
    } catch (err) {
      console.warn('[kitchen-message] print failed:', err.message);
    }

    io.emit('kitchen_message', {
      order_id,
      table_number: resolvedTable,
      order_type:   resolvedType,
      customer_name: resolvedCustomer,
      message: text,
      waiter_name: waiter_name || '',
      at: new Date().toISOString(),
    });

    res.json({ success: true, printed });
  } catch (err) {
    console.error('[kitchen-message]', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: split a list of closed-order rows into dine-in vs takeaway
// totals so every reports endpoint exposes the same shape.
function splitByOrderType(rows) {
  // Korakot 2026-06-02: per-channel splits feed Reports + Z Report headline
  // cards. Totals = money taken (paid_amount, includes service charge),
  // falling back to orders.total for legacy rows without a joined payment.
  // 2026-06-02 follow-up: SELECT ... LEFT JOIN payments emits one row per
  // payment, so a split-pay order appears N times. Per-channel TOTALS stay
  // right (each payment row is correctly attributed to its order_type), but
  // counts must dedupe by orders.id.
  let total_takeaway = 0, total_dine_in = 0, total_counter = 0;
  const seenTakeaway = new Set(), seenDineIn = new Set(), seenCounter = new Set();
  for (const r of rows) {
    const t = Number(r.paid_amount ?? r.total ?? 0);
    if (r.order_type === 'takeaway')      { total_takeaway += t; seenTakeaway.add(r.id); }
    else if (r.order_type === 'counter')  { total_counter  += t; seenCounter.add(r.id);  }
    else                                  { total_dine_in  += t; seenDineIn.add(r.id);   }
  }
  return {
    total_takeaway, total_dine_in, total_counter,
    takeaway_count: seenTakeaway.size,
    dine_in_count:  seenDineIn.size,
    counter_count:  seenCounter.size,
  };
}

app.get('/api/reports/daily', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    // BUG-EPOS-005 (Nook): /reports/daily was reporting orders.total
    // (the bare subtotal) where /reports/summary was already reporting
    // payments.amount (the money actually taken, including 12.5%
    // service charge). Mirror the summary pattern so the two reports
    // agree to the penny.
    const result = await pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.order_type, orders.customer_name, payments.method, payments.amount AS paid_amount, tables.table_number FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at::date = $1::date AND (payments.method IS NOT NULL OR orders.order_type = 'takeaway') ORDER BY orders.closed_at DESC`, [date]);
    const total = result.rows.reduce((sum, r) => sum + Number(r.paid_amount ?? r.total ?? 0), 0);
    // Dedupe order_count by orders.id — LEFT JOIN payments multiplies rows
    // on split-pay orders.
    const uniqueOrderIds = new Set(result.rows.map(r => r.id));
    res.json({ date, orders: result.rows, total_sales: total, order_count: uniqueOrderIds.size, ...splitByOrderType(result.rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const [result, foodDrinkRes, voucherSoldRes, voucherRedeemedRes, settingsRes] = await Promise.all([
      // Korakot 2026-06-02: pull payments.amount as paid_amount so the
      // Reports tab can show what was actually collected (incl. service
      // charge) instead of the bare subtotal.
      pool.query(`SELECT orders.id, orders.total, orders.closed_at, orders.covers, orders.discount_value, orders.discount_type, orders.order_type, orders.no_service_charge, orders.customer_name, payments.method, payments.amount AS paid_amount, tables.table_number FROM orders LEFT JOIN payments ON orders.id = payments.order_id LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='closed' AND orders.closed_at::date >= $1::date AND orders.closed_at::date <= $2::date AND (payments.method IS NOT NULL OR orders.order_type = 'takeaway') ORDER BY orders.closed_at DESC`, [from, to]),
      // Korakot 2026-06-02: food vs drink split based on categories.is_bar.
      // Per-item discounts applied. Service charge + bill-level discounts
      // are handled separately above.
      pool.query(`
        SELECT COALESCE(c.is_bar, 0) AS is_bar,
               SUM(
                 CASE
                   WHEN oi.discount_type = 'percent' THEN oi.quantity * oi.unit_price * (1 - COALESCE(oi.discount_value,0)/100.0)
                   WHEN oi.discount_type = 'fixed'   THEN GREATEST(0, oi.quantity * oi.unit_price - COALESCE(oi.discount_value,0))
                   ELSE oi.quantity * oi.unit_price
                 END
               ) AS subtotal
        FROM order_items oi
        LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        LEFT JOIN categories  c  ON c.id  = mi.category_id
        LEFT JOIN orders      o  ON o.id  = oi.order_id
        WHERE o.status='closed' AND oi.voided=0
          AND o.closed_at::date >= $1::date AND o.closed_at::date <= $2::date
        GROUP BY COALESCE(c.is_bar, 0)
      `, [from, to]),
      // SEPOS-VOUCHER-001 — vouchers sold in the date range, split by method
      pool.query(`SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE created_at::date >= $1::date AND created_at::date <= $2::date GROUP BY payment_method`, [from, to]).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_used), 0) AS total FROM voucher_redemptions WHERE used_at::date >= $1::date AND used_at::date <= $2::date`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      pool.query(`SELECT key, value FROM settings WHERE key IN ('service_charge_enabled','service_charge_rate','service_charge_percent')`),
    ]);
    const rows = result.rows;
    const cfg = {}; for (const r of (settingsRes?.rows || [])) cfg[r.key] = r.value;
    const scEnabled = String(cfg.service_charge_enabled ?? 'true') !== '0' && String(cfg.service_charge_enabled ?? 'true') !== 'false';
    const scRate    = Number(cfg.service_charge_rate ?? cfg.service_charge_percent ?? 12.5) || 0;
    // 2026-06-02 follow-up: LEFT JOIN payments multiplies orders on
    // split-pay days. Sums that read PER PAYMENT (total_paid, by_method)
    // stay on the flat row set; sums that read PER ORDER
    // (total_subtotal/covers/count/service) dedupe by orders.id.
    const total_paid = rows.reduce((sum, r) => sum + Number(r.paid_amount ?? r.total ?? 0), 0);
    const byOrder = new Map();
    for (const r of rows) if (!byOrder.has(r.id)) byOrder.set(r.id, r);
    const uniqueOrders = [...byOrder.values()];
    const total_subtotal = uniqueOrders.reduce((sum, r) => sum + Number(r.total ?? 0), 0);
    const total_discounts = uniqueOrders.reduce((s, r) => { if (!r.discount_value) return s; return s + (r.discount_type === 'percent' ? (r.total || 0) * (r.discount_value / 100) : r.discount_value); }, 0);
    // SEPOS-SVCFIX-001 — service charge summed PER BILL (dine-in only × rate),
    // not money-taken − subtotal. total_sales foots to items − discounts + service.
    const total_service  = uniqueOrders.reduce((sum, r) => sum + serviceChargeForOrder(r, scEnabled, scRate), 0);
    const total_sales    = Math.max(0, total_subtotal - total_discounts) + total_service;
    const total_covers   = uniqueOrders.reduce((sum, r) => sum + (r.covers || 0), 0);
    const by_method = {};
    rows.forEach(r => { if (r.method) by_method[r.method] = (by_method[r.method] || 0) + Number(r.paid_amount ?? r.total ?? 0); });

    // Voucher sales — exposed both as a single total and broken down by
    // payment_method (cash / card / stripe / mock) so Trading + Reports
    // can render the right "till vs off-till" framing.
    const vouchersByMethod = {};
    let voucherCount = 0, voucherTotal = 0, voucherTillTotal = 0, voucherStripeTotal = 0;
    for (const r of voucherSoldRes.rows) {
      const m = r.payment_method || 'unknown';
      const t = Number(r.total || 0);
      vouchersByMethod[m] = { count: Number(r.count || 0), total: t };
      voucherCount += Number(r.count || 0);
      voucherTotal += t;
      if (m === 'cash' || m === 'card') voucherTillTotal += t;
      else if (m === 'stripe')          voucherStripeTotal += t;
    }
    const vRedeemed = voucherRedeemedRes.rows[0] || { count: 0, total: 0 };

    let total_food = 0, total_drink = 0;
    for (const r of foodDrinkRes.rows) {
      if (Number(r.is_bar) === 1) total_drink += Number(r.subtotal || 0);
      else                        total_food  += Number(r.subtotal || 0);
    }

    res.json({
      orders: rows, total_sales, total_paid, total_subtotal, total_service, total_discounts,
      service_charge_rate: scRate, service_charge_enabled: scEnabled,
      total_food, total_drink,
      order_count: byOrder.size, total_covers, by_method,
      vouchers_sold: {
        count: voucherCount,
        total: voucherTotal,
        till_total:   voucherTillTotal,   // cash+card — physically went through the till
        stripe_total: voucherStripeTotal, // off-till
        by_method:    vouchersByMethod,
      },
      vouchers_redeemed: { count: Number(vRedeemed.count || 0), total: Number(vRedeemed.total || 0) },
      ...splitByOrderType(rows),
    });
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
    const result = await pool.query(`SELECT order_items.*, menu_items.name, menu_items.name_alt, orders.covers, orders.id as order_id, tables.table_number, order_items.fired_at, order_items.served_at, orders.order_type, orders.customer_name, orders.pickup_time, orders.order_subtype, orders.delivery_address, orders.takeaway_status FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id LEFT JOIN categories ON menu_items.category_id = categories.id LEFT JOIN orders ON order_items.order_id = orders.id LEFT JOIN tables ON orders.table_id = tables.id WHERE order_items.status='served' AND order_items.voided=0 AND (categories.is_bar=0 OR categories.is_bar IS NULL) AND order_items.served_at::date = CURRENT_DATE ORDER BY order_items.order_id ASC`);
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

    // SEPOS-044 (reverted 2026-07-04 per Korakot): NO auto-occupy of linked
    // tables. Only the table the staff actually seats is marked occupied — the
    // floor never grabs linked partners on its own. Linked-table combinations
    // still exist, but only for booking capacity (reservation availability);
    // they no longer drive floor occupancy. If a party needs more tables, staff
    // seat/merge those tables themselves.

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
    // Zero the merged (source) order's total — its items moved to the target,
    // so leaving the old total made it a "closed, no payment" phantom that
    // inflated the sales report. total=0 keeps it out of the figures.
    await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), total=0, session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [merge_order_id]);
    const totalRes = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id=$1 AND voided=0`, [targetOrderId]); // SEPOS-047c — keep per-item discounts
    await pool.query('UPDATE orders SET total=$1 WHERE id=$2', [totalRes.rows[0].total || 0, targetOrderId]);
    io.emit('table_merged', { target_order_id: targetOrderId, merged_order_id: merge_order_id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-042 — manager-gated order deletion.
// Used by Admin → Bills → Delete to remove a fault transaction.
// Validates the supplied PIN belongs to a manager / admin / supervisor,
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

    // SEPOS-043 — supervisor cannot delete closed bills.
    // Peek at the order status before any destructive work.
    if ((staff.role || '').toLowerCase() === 'supervisor') {
      const peekRes = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      if (peekRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      if (peekRes.rows[0].status === 'closed') {
        return res.status(403).json({ error: 'Supervisors cannot delete closed bills' });
      }
    }

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
    // SEPOS-047c — NEVER fall back to the local id here. cloud_id is the
    // cloud's primary key for this order; the local SQLite id is a
    // DIFFERENT number. The old `order.cloud_id || orderId` sent the local
    // id whenever cloud_id was unbound (order made offline, or deleted
    // inside the ~5s window before its create push bound cloud_id), and
    // the cloud then cascade-deleted whichever order happened to own that
    // id — a wrong, unrecoverable delete. null means "never reached the
    // cloud"; applyToCloud skips the push rather than guess. (This payload
    // is only read in DB_MODE=local; the enqueue is a no-op on cloud.)
    await offlineQueue.enqueue('delete_order', {
      localOrderId: orderId,
      cloudOrderId: order.cloud_id || null,
      // SEPOS-PRO-002 follow-up — fallback match keys. When cloud_id was never
      // bound (order made offline, or the link was lost on a restart) the cloud
      // copy used to be orphaned forever and pullActiveOrders kept re-seeding it
      // (the zombie-table bug). These let the cloud resolve the open order by
      // (table_id, opened_at) — the SAME heuristic the pull trusts — so the
      // delete still lands. Safe: table_id is dine-in-only and one table has one
      // open order, matched within a tight time window.
      matchTableId:  order.table_id ?? null,
      matchOpenedAt: order.opened_at ?? null,
      staff_name:   staff.name,
      staff_role:   staff.role,
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
    let orderId = parseInt(req.body?.order_id, 10) || 0;
    const match = req.body?.match;
    if (!orderId && !(match && match.table_id != null && match.opened_at)) {
      return res.status(400).json({ error: 'order_id or match required' });
    }
    // SEPOS-PRO-002 follow-up — resolve an orphaned cloud order by (table_id,
    // opened_at) when the Mac couldn't bind a cloud_id, instead of leaving it to
    // resurrect via pullActiveOrders. Same heuristic the pull uses to bind.
    // DB-agnostic time math (no EXTRACT/julianday) so it's safe on PG + SQLite.
    // A table holds one open order, matched within 120s, so it can't hit a
    // different live order.
    if (!orderId && match) {
      const cand = await pool.query(
        `SELECT id, opened_at FROM orders WHERE status='open' AND table_id = $1`,
        [match.table_id]
      );
      const target = new Date(match.opened_at).getTime();
      let best = null, bestDiff = Infinity;
      for (const row of cand.rows) {
        const diff = Math.abs(new Date(row.opened_at).getTime() - target);
        if (diff < 120000 && diff < bestDiff) { best = row.id; bestDiff = diff; }
      }
      if (best) orderId = best;
      if (!orderId) return res.json({ success: true, already_deleted: true, matched: false });
    }
    const staffName = String(req.body?.staff_name || 'unknown').trim();
    const staffRole = String(req.body?.staff_role || '').trim();
    const reason    = String(req.body?.reason || '').trim() || '(synced from desktop app)';

    // SEPOS-043 — supervisor cannot delete closed bills via sync either.
    if (staffRole.toLowerCase() === 'supervisor') {
      const peekRes = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      if (peekRes.rows.length > 0 && peekRes.rows[0].status === 'closed') {
        return res.status(403).json({ error: 'Supervisors cannot delete closed bills' });
      }
    }

    const ordRes = await pool.query(
      `SELECT id, total, order_type, opened_at, closed_at, table_id FROM orders WHERE id = $1`,
      [orderId]
    );
    if (ordRes.rows.length === 0) {
      // Already gone — idempotent success.
      return res.json({ success: true, already_deleted: true, order_id: orderId });
    }
    const order = ordRes.rows[0];

    // SEPOS-046i — per-step try/catch so a missing table (e.g. tenant
    // never had stock_movements migrated) doesn't strand the order in a
    // zombie state with payments deleted but order + order_items still
    // present. Matches the PIN-gated /api/orders/:id pattern.
    const safeStep = async (label, sql) => {
      try { const r = await pool.query(sql, [orderId]); return { ok: true, deleted: r.rowCount }; }
      catch (err) {
        console.warn(`[sync-delete-order ${orderId}] ${label} failed:`, err.message);
        return { ok: false, error: err.message };
      }
    };
    const steps = {
      payments:        await safeStep('payments',        `DELETE FROM payments WHERE order_id = $1`),
      stock_movements: await safeStep('stock_movements', `DELETE FROM stock_movements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`),
      order_items:     await safeStep('order_items',     `DELETE FROM order_items WHERE order_id = $1`),
      order:           await safeStep('order',           `DELETE FROM orders WHERE id = $1`),
    };

    if (order.table_id) {
      try { await pool.query("UPDATE tables SET status='available' WHERE id = $1", [order.table_id]); } catch {}
    }

    console.log(`[sync-delete-order] order #${orderId} deleted via sync from ${staffName} — reason: "${reason}"`);
    io.emit('order_deleted', { order_id: orderId, by: `${staffName} (sync)` });
    res.json({ success: steps.order.ok, order_id: orderId, steps });
  } catch (err) {
    console.error('POST /api/sync/delete-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SEPOS-053 — till trading sessions (EposNow-style Open / Close Shift) ──
// The open session is the boundary for the Z-report instead of a calendar
// date, so a shift can span midnight / two nights with no timezone edge.
// On a desktop install the open/close forwards to cloud (reusing the
// SEPOS-047g write-through) so every terminal agrees on the one open shift.
app.get('/api/till-sessions/current', async (req, res) => {
  try {
    const rid = resolveRestaurantId(req);
    const r = await pool.query(
      "SELECT * FROM till_sessions WHERE status='open' AND restaurant_id=$1 ORDER BY opened_at DESC LIMIT 1",
      [rid]
    );
    const session = r.rows[0] || null;
    if (!session) return res.json({ session: null });
    // Live tally for the header banner — orders closed since the shift opened.
    // Keyed on the closed_at instant (the same window the Z uses), NOT on
    // orders.session_id, so it stays correct even if a cloud→local sync
    // overwrites the locally-stamped session_id on a multi-terminal install.
    const t = await pool.query(
      `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(p.amount), 0) AS takings
         FROM orders o LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.status='closed' AND o.closed_at >= $1::timestamp`,
      [session.opened_at]
    );
    res.json({ session, orders: Number(t.rows[0].orders || 0), takings: Number(t.rows[0].takings || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk GET for the sync engine (cloud→desktop) and session history.
app.get('/api/till-sessions', async (req, res) => {
  try {
    const rid = resolveRestaurantId(req);
    const r = await pool.query(
      "SELECT * FROM till_sessions WHERE restaurant_id=$1 ORDER BY opened_at DESC LIMIT 100", [rid]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/till-sessions/open', async (req, res) => {
  if (await forwardWriteToCloud(req, res, 'session-open', () => syncService.pullSessionsSnapshot())) return;
  try {
    const rid = resolveRestaurantId(req);
    const { staff_id, float_amount } = req.body || {};
    const existing = await pool.query(
      "SELECT * FROM till_sessions WHERE status='open' AND restaurant_id=$1 ORDER BY opened_at DESC LIMIT 1", [rid]
    );
    if (existing.rows[0]) return res.status(409).json({ error: 'A shift is already open.', session: existing.rows[0] });
    const r = await pool.query(
      `INSERT INTO till_sessions (status, opened_at, opened_by, float_amount, restaurant_id)
       VALUES ('open', NOW(), $1, $2, $3) RETURNING *`,
      [staff_id || null, Number(float_amount) || 0, rid]
    );
    res.json({ session: r.rows[0], success: true });
  } catch (err) {
    // Unique partial index race — another terminal opened first. Return theirs.
    if (String(err.code) === '23505' || /idx_till_sessions_open|UNIQUE/i.test(err.message)) {
      const rid = resolveRestaurantId(req);
      const ex = await pool.query("SELECT * FROM till_sessions WHERE status='open' AND restaurant_id=$1 LIMIT 1", [rid]);
      return res.status(409).json({ error: 'A shift is already open.', session: ex.rows[0] || null });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/till-sessions/close', async (req, res) => {
  if (await forwardWriteToCloud(req, res, 'session-close', () => syncService.pullSessionsSnapshot())) return;
  try {
    const rid = resolveRestaurantId(req);
    const { closed_by, z_report_id } = req.body || {};
    const open = await pool.query(
      "SELECT * FROM till_sessions WHERE status='open' AND restaurant_id=$1 ORDER BY opened_at DESC LIMIT 1", [rid]
    );
    if (!open.rows[0]) return res.status(409).json({ error: 'No open shift to close.' });
    const r = await pool.query(
      "UPDATE till_sessions SET status='closed', closed_at=NOW(), closed_by=$1, z_report_id=$2 WHERE id=$3 RETURNING *",
      [closed_by || null, z_report_id || null, open.rows[0].id]
    );
    res.json({ session: r.rows[0], success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/z-report/preview', async (req, res) => {
  try {
    let { from, to } = req.query;
    // SEPOS-053 — session mode: derive the window from the session's own
    // open/close instants instead of a calendar date. Because the bounds are
    // exact stored timestamps (not ::date), the Z spans midnight / two nights
    // and is immune to the timezone day boundary. An order opened before the
    // shift but paid during it keys on closed_at, so it lands in this Z —
    // matching the session_id stamped at close.
    let sessionMeta = null;
    if (req.query.session_id) {
      const sres = await pool.query("SELECT * FROM till_sessions WHERE id=$1", [req.query.session_id]);
      if (!sres.rows[0]) return res.status(404).json({ error: 'Session not found' });
      sessionMeta = sres.rows[0];
      from = sessionMeta.opened_at;
      to   = sessionMeta.closed_at || new Date().toISOString(); // open shift → up to now
    }
    const [ordersRes, openRes, voidsRes, voidsByTypeRes, vatRowsRes, foodDrinkRes, vouchersSoldRes, vouchersRedeemedRes, settingsRes, depTakenRes, depRedeemedRes, depForfeitedRes, depHeldRes] = await Promise.all([
      pool.query(`SELECT orders.*, tables.table_number, payments.method, payments.amount as paid_amount FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.closed_at >= $1::timestamp AND orders.closed_at <= $2::timestamp ORDER BY orders.closed_at DESC`, [from, to]),
      pool.query(`SELECT orders.*, tables.table_number FROM orders LEFT JOIN tables ON orders.table_id = tables.id WHERE orders.status='open'`),
      pool.query(`SELECT COUNT(*) as void_count, SUM(order_items.unit_price * order_items.quantity) as void_value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp`, [from, to]),
      // SEPOS-023: breakdown by void_type
      pool.query(`SELECT COALESCE(order_items.void_type, 'Uncategorised') AS void_type, COUNT(*) AS count, COALESCE(SUM(order_items.unit_price * order_items.quantity), 0) AS value FROM order_items LEFT JOIN orders ON order_items.order_id = orders.id WHERE order_items.voided=1 AND orders.created_at >= $1::timestamp AND orders.created_at <= $2::timestamp GROUP BY order_items.void_type ORDER BY value DESC`, [from, to]),
      // SEPOS-021: rows for VAT breakdown (aggregated in JS)
      pool.query(`SELECT COALESCE(mi.vat_rate, 20) AS vat_rate, oi.order_id, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value, o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id LEFT JOIN orders o ON o.id = oi.order_id WHERE o.status='closed' AND oi.voided=0 AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp`, [from, to]),
      // Korakot 2026-06-02: food vs drink split via categories.is_bar.
      pool.query(`
        SELECT COALESCE(c.is_bar, 0) AS is_bar,
               SUM(
                 CASE
                   WHEN oi.discount_type = 'percent' THEN oi.quantity * oi.unit_price * (1 - COALESCE(oi.discount_value,0)/100.0)
                   WHEN oi.discount_type = 'fixed'   THEN GREATEST(0, oi.quantity * oi.unit_price - COALESCE(oi.discount_value,0))
                   ELSE oi.quantity * oi.unit_price
                 END
               ) AS subtotal
        FROM order_items oi
        LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
        LEFT JOIN categories  c  ON c.id  = mi.category_id
        LEFT JOIN orders      o  ON o.id  = oi.order_id
        WHERE o.status='closed' AND oi.voided=0
          AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
        GROUP BY COALESCE(c.is_bar, 0)
      `, [from, to]),
      // SEPOS-VOUCHER-001: vouchers sold in the range (Stripe — off till)
      // SEPOS-DEPOSIT-001: GIFT vouchers only (deposits excluded — reported separately below).
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp AND payment_method != 'mock' AND COALESCE(type,'gift') != 'deposit'`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      // SEPOS-VOUCHER-001: GIFT vouchers redeemed in the range (off till — already paid for at sale time)
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(vr.amount_used), 0) AS total FROM voucher_redemptions vr JOIN vouchers v ON v.id = vr.voucher_id WHERE vr.used_at >= $1::timestamp AND vr.used_at <= $2::timestamp AND COALESCE(v.type,'gift') != 'deposit'`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      // Service-charge + VAT + deposits-flag settings.
      pool.query(`SELECT key, value FROM settings WHERE key IN ('service_charge_enabled','service_charge_rate','service_charge_percent','vat_mode','deposits_enabled')`),
      // SEPOS-DEPOSIT-001 — deposit flows. Taken today = money in the bank now but
      // NOT in today's sales (future revenue). Redeemed = the non-cash tender applied
      // to bills today (excluded from till cash). Forfeited = no-shows kept as income.
      // Held = current outstanding deposit liability (closing held).
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE type='deposit' AND created_at >= $1::timestamp AND created_at <= $2::timestamp`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(vr.amount_used), 0) AS total FROM voucher_redemptions vr JOIN vouchers v ON v.id = vr.voucher_id WHERE v.type='deposit' AND vr.used_at >= $1::timestamp AND vr.used_at <= $2::timestamp`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(original_amount), 0) AS total FROM vouchers WHERE type='deposit' AND status='forfeited' AND voided_at >= $1::timestamp AND voided_at <= $2::timestamp`, [from, to]).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) AS count FROM vouchers WHERE type='deposit' AND status='active' AND balance > 0`).catch(() => ({ rows: [{ count: 0, total: 0 }] })),
    ]);
    const orders = ordersRes.rows;
    const voids = voidsRes.rows[0];
    const voidsByType = voidsByTypeRes.rows;
    const cfg = {}; for (const r of (settingsRes?.rows || [])) cfg[r.key] = r.value;
    const scEnabled = String(cfg.service_charge_enabled ?? 'true') !== '0' && String(cfg.service_charge_enabled ?? 'true') !== 'false';
    const scRate    = Number(cfg.service_charge_rate ?? cfg.service_charge_percent ?? 12.5) || 0;
    const vatMode   = cfg.vat_mode === 'exclusive' ? 'exclusive' : 'inclusive';
    // SEPOS-DEPOSIT-001 — deposit flows + liability (0/empty unless the tenant uses them).
    const depositsEnabled = String(cfg.deposits_enabled ?? '0') === '1';
    const depTaken     = depTakenRes.rows[0]     || { count: 0, total: 0 };
    const depRedeemed  = depRedeemedRes.rows[0]  || { count: 0, total: 0 };
    const depForfeited = depForfeitedRes.rows[0] || { count: 0, total: 0 };
    const depHeld      = depHeldRes.rows[0]      || { count: 0, total: 0 };

    // VAT breakdown — SEPOS-VATMODE-001: service charge is OUTSIDE the VAT
    // base (this loop only sees order_items), and the per-rate net/vat split
    // follows the restaurant's vat_mode ('exclusive' = VAT 20% on top of the
    // sale, 'inclusive' = VAT backed out of a VAT-inclusive price).
    const vatBuckets = new Map();
    const vatFactors = billDiscountFactors(vatRowsRes.rows); // SEPOS-047j — bill-level discount
    for (const row of vatRowsRes.rows) {
      const rate = Number(row.vat_rate ?? 20);
      let gross = Number(row.quantity || 0) * Number(row.unit_price || 0);
      if (row.discount_type === 'percent') gross *= 1 - (Number(row.discount_value || 0) / 100);
      else if (row.discount_type === 'fixed') gross = Math.max(0, gross - Number(row.discount_value || 0));
      gross *= (vatFactors.get(row.order_id) ?? 1); // distribute the order's bill-level discount
      const { net, vat } = vatLine(gross, rate, vatMode);
      const b = vatBuckets.get(rate) || { rate, net: 0, vat: 0, gross: 0 };
      b.net += net; b.vat += vat; b.gross += (net + vat);
      vatBuckets.set(rate, b);
    }
    const vatBreakdown = [...vatBuckets.values()].sort((a, b) => a.rate - b.rate);
    const vatTotal = vatBreakdown.reduce((a, b) => a + b.vat, 0);
    // Per-order sums dedupe by orders.id; per-payment sums (paid / Cash / Card /
    // Other) stay on the flat LEFT JOIN payments row set (split-pay = N rows).
    const byOrder = new Map();
    for (const o of orders) if (!byOrder.has(o.id)) byOrder.set(o.id, o);
    const uniqueOrders = [...byOrder.values()];
    const totalSubtotal  = uniqueOrders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const totalDiscounts = uniqueOrders.reduce((s, o) => { if (!o.discount_value) return s; return s + (o.discount_type === 'percent' ? (o.total || 0) * (o.discount_value / 100) : o.discount_value); }, 0);
    // SEPOS-SVCFIX-001 — service charge is the SUM of each dine-in bill's own
    // charge (subtotal × rate), NOT money-taken − subtotal. Immune to tips,
    // overpayments and double-charges leaking into the service line.
    const totalService   = uniqueOrders.reduce((s, o) => s + serviceChargeForOrder(o, scEnabled, scRate), 0);
    // Sales value = item sales − bill-level discounts + service. This FOOTS to
    // the Food+Drink+Service breakdown. Money actually taken is total_paid;
    // any gap between the two (e.g. a double-charge) is now visible, not hidden.
    const totalSales     = Math.max(0, totalSubtotal - totalDiscounts) + totalService;
    const totalPaid      = orders.reduce((s, o) => s + Number(o.paid_amount ?? o.total ?? 0), 0);
    const totalCovers    = uniqueOrders.reduce((s, o) => s + (o.covers || 0), 0);
    const totalCash      = orders.filter(o => o.method === 'Cash').reduce((s, o) => s + Number(o.paid_amount ?? o.total ?? 0), 0);
    const totalCard      = orders.filter(o => o.method === 'Card').reduce((s, o) => s + Number(o.paid_amount ?? o.total ?? 0), 0);
    const totalOther     = orders.filter(o => o.method !== 'Cash' && o.method !== 'Card').reduce((s, o) => s + Number(o.paid_amount ?? o.total ?? 0), 0);
    const totalOrders    = byOrder.size;
    const orderTypeSplit = splitByOrderType(orders);
    let totalFood = 0, totalDrink = 0;
    for (const r of foodDrinkRes.rows) {
      if (Number(r.is_bar) === 1) totalDrink += Number(r.subtotal || 0);
      else                        totalFood  += Number(r.subtotal || 0);
    }
    const vouchersSold     = vouchersSoldRes.rows[0]     || { count: 0, total: 0 };
    const vouchersRedeemed = vouchersRedeemedRes.rows[0] || { count: 0, total: 0 };
    res.json({ orders, open_orders: openRes.rows, total_sales: totalSales, total_paid: totalPaid, total_subtotal: totalSubtotal, total_service: totalService, service_charge_rate: scRate, service_charge_enabled: scEnabled, vat_mode: vatMode, total_food: totalFood, total_drink: totalDrink, total_covers: totalCovers, total_orders: totalOrders, total_cash: totalCash, total_card: totalCard, total_other: totalOther, total_discounts: totalDiscounts, void_count: voids?.void_count || 0, void_value: voids?.void_value || 0, voids_by_type: voidsByType, vat_breakdown: vatBreakdown, vat_total: vatTotal, avg_per_cover: totalCovers > 0 ? totalSales / totalCovers : 0, avg_per_order: totalOrders > 0 ? totalSales / totalOrders : 0, vouchers_sold: { count: Number(vouchersSold.count || 0), total: Number(vouchersSold.total || 0) }, vouchers_redeemed: { count: Number(vouchersRedeemed.count || 0), total: Number(vouchersRedeemed.total || 0) }, deposits_enabled: depositsEnabled, deposits_taken: { count: Number(depTaken.count || 0), total: Number(depTaken.total || 0) }, deposits_redeemed: { count: Number(depRedeemed.count || 0), total: Number(depRedeemed.total || 0) }, deposits_forfeited: { count: Number(depForfeited.count || 0), total: Number(depForfeited.total || 0) }, deposits_held: { count: Number(depHeld.count || 0), total: Number(depHeld.total || 0) }, session: sessionMeta, from, to, ...orderTypeSplit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/z-report/save', async (req, res) => {
  try {
    const { type, from, to, data, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card, card_difference } = req.body;
    const result = await pool.query(
      `INSERT INTO z_reports (type, opened_at, closed_at, total_sales, total_cash, total_card, total_other, total_covers, total_orders, discounts, voids, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card, card_difference, report_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [type, from, to, data.total_sales, data.total_cash, data.total_card, data.total_other, data.total_covers, data.total_orders, data.total_discounts, data.void_count, float_amount, petty_cash, petty_cash_reason, actual_cash, cash_difference, actual_card ?? null, card_difference ?? null, JSON.stringify(data)]
    );

    // SEPOS-LOCAL-001 Phase 1 — Z-report close is the natural end-of-day
    // moment, so write today's HMRC archive (bills CSV + branded PDF) to
    // ~/Documents/SiamEPOS-Records/ now. Idempotent. Silent skip on
    // Railway (DB_MODE != 'local'). Errors don't fail the save — the
    // operator's primary action (saving the Z-report) must always
    // succeed regardless of disk problems.
    let archive_path = null;
    try {
      const archiveService = require('./services/archiveService');
      if (archiveService.isLocalInstall()) {
        const r = await archiveService.archiveForDate(pool, archiveService.todayStr(), { force: true });
        if (r?.ok) archive_path = r.pdf?.path || null;
      }
    } catch (e) {
      console.warn('[archive] z-report-close trigger failed:', e.message);
    }

    res.json({ id: result.rows[0].id, success: true, archive_path });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 1 — archive status for the Settings card. Tells
// the operator where files are saved + the last archive timestamp + a
// short list of recent files so they can sanity-check that records are
// landing on disk as expected.
app.get('/api/local/archive-status', (req, res) => {
  try {
    const archiveService = require('./services/archiveService');
    const status = archiveService.getArchiveStatus();
    res.json({
      local_install: archiveService.isLocalInstall(),
      ...status,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 1 — operator clicks "📂 Open folder" in Settings;
// frontend posts here, backend shells out to `open` / `explorer` to bring
// up the archive root in Finder/Explorer. Local-install only — no-op on
// Railway since there's no GUI.
app.post('/api/local/archive-open-folder', async (req, res) => {
  try {
    const archiveService = require('./services/archiveService');
    if (!archiveService.isLocalInstall()) {
      return res.status(400).json({ error: 'not a local install' });
    }
    const dir = archiveService.getRootDir();
    require('fs').mkdirSync(dir, { recursive: true });
    const cmd = process.platform === 'darwin' ? `open "${dir}"`
              : process.platform === 'win32'  ? `start "" "${dir}"`
              : `xdg-open "${dir}"`;
    require('child_process').exec(cmd);
    res.json({ ok: true, dir });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 3 — first-boot migration progress for the UI
// banner. Polled every ~2s by the Settings card; returns {status,
// imported, total, started_at, finished_at, error} so the operator
// sees a live count while history flows in from the cloud.
app.get('/api/local/migration-status', (req, res) => {
  try {
    const migrationService = require('./services/migrationService');
    res.json(migrationService.getState());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 5 — combined storage stats for the Data Storage
// card. Counts local SQLite rows + reaches into the cloud for the same
// counts. Used by the operator to verify "Yes, all my history is
// actually on this Mac" before relying on the local archive.
app.get('/api/local/storage-stats', async (req, res) => {
  try {
    const archiveService = require('./services/archiveService');
    const isLocal = archiveService.isLocalInstall();

    const local = { closed_orders: 0, open_orders: 0, payments: 0, vouchers: 0, reservations: 0 };
    if (isLocal) {
      const q = async (sql) => { try { const r = await pool.query(sql); return Number(r.rows[0]?.n || 0); } catch { return 0; } };
      local.closed_orders = await q(`SELECT COUNT(*) AS n FROM orders WHERE status='closed'`);
      local.open_orders   = await q(`SELECT COUNT(*) AS n FROM orders WHERE status='open'`);
      local.payments      = await q(`SELECT COUNT(*) AS n FROM payments`);
      local.vouchers      = await q(`SELECT COUNT(*) AS n FROM vouchers`);
      local.reservations  = await q(`SELECT COUNT(*) AS n FROM reservations`);
    }

    let cloud = null;
    if (isLocal && process.env.CLOUD_API_URL && process.env.SYNC_SECRET) {
      try {
        const r = await fetch(`${process.env.CLOUD_API_URL}/api/local/storage-stats-cloud`, {
          headers: { 'x-sync-secret': process.env.SYNC_SECRET },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) cloud = await r.json();
      } catch { /* cloud unreachable — leave null */ }
    } else if (!isLocal) {
      // Cloud-side request — we ARE the cloud. Return counts directly.
      const q = async (sql) => { try { const r = await pool.query(sql); return Number(r.rows[0]?.n || 0); } catch { return 0; } };
      cloud = {
        closed_orders: await q(`SELECT COUNT(*) AS n FROM orders WHERE status='closed'`),
        open_orders:   await q(`SELECT COUNT(*) AS n FROM orders WHERE status='open'`),
        payments:      await q(`SELECT COUNT(*) AS n FROM payments`),
        vouchers:      await q(`SELECT COUNT(*) AS n FROM vouchers`),
        reservations:  await q(`SELECT COUNT(*) AS n FROM reservations`),
        device_first_mode: process.env.DEVICE_FIRST_MODE === 'true',
      };
    }

    let archive = null;
    try { archive = archiveService.getArchiveStatus(); } catch { /* ignore */ }

    res.json({
      local_install:    isLocal,
      device_first_mode: process.env.DEVICE_FIRST_MODE === 'true',
      local, cloud, archive,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 6 — Cloudflare Tunnel status read from the
// status file the Electron main process writes whenever it spawns,
// observes log output, or sees cloudflared exit. Used by the Settings
// Remote Access card to render 🟢 active / 🟡 starting / 🔴 error.
app.get('/api/local/tunnel-status', (req, res) => {
  try {
    // The status file lives in Electron's userData dir. We can't import
    // electron from this spawned Node process, so we resolve the dir by
    // mirroring what app.getPath('userData') would return per-platform.
    const home = require('os').homedir();
    const userDataDir = process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'siamepos-electron')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'siamepos-electron')
        : path.join(home, '.config', 'siamepos-electron');
    const statePath = path.join(userDataDir, 'tunnel-status.json');
    if (!require('fs').existsSync(statePath)) {
      return res.json({ enabled: false, status: 'disabled', remote_url: '', last_error: null });
    }
    const raw = require('fs').readFileSync(statePath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 5 — cloud-side stats fetched by local installs
// via /storage-stats. Same SYNC_SECRET gate as the closed-orders feed.
// Cloud-relay endpoint for desktop installs that don't hold
// BREVO_API_KEY locally. Forwards { to, subject, html } through the
// cloud-side BREVO_API_KEY. SYNC_SECRET-gated so only known restaurants
// can use the relay (caps abuse to the same trust boundary as
// active-order sync).
app.post('/api/local/send-email', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.BREVO_API_KEY) {
    return res.status(500).json({ error: 'cloud BREVO_API_KEY not set' });
  }
  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'to, subject and html are required' });
  }
  try {
    const { sendBrevoEmail } = require('./services/emailService');
    await sendBrevoEmail(to, subject, html);
    res.json({ ok: true });
  } catch (err) {
    console.error('[local/send-email] relay failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/local/storage-stats-cloud', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const q = async (sql) => { try { const r = await pool.query(sql); return Number(r.rows[0]?.n || 0); } catch { return 0; } };
    res.json({
      closed_orders: await q(`SELECT COUNT(*) AS n FROM orders WHERE status='closed'`),
      open_orders:   await q(`SELECT COUNT(*) AS n FROM orders WHERE status='open'`),
      payments:      await q(`SELECT COUNT(*) AS n FROM payments`),
      vouchers:      await q(`SELECT COUNT(*) AS n FROM vouchers`),
      reservations:  await q(`SELECT COUNT(*) AS n FROM reservations`),
      device_first_mode: process.env.DEVICE_FIRST_MODE === 'true',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-LOCAL-001 Phase 1 — manual re-archive for a given date. Used by
// the Settings card "Re-archive today" / "Re-archive yesterday" buttons
// and by Nook's QA test pass.
app.post('/api/local/archive-run', async (req, res) => {
  try {
    const archiveService = require('./services/archiveService');
    if (!archiveService.isLocalInstall()) {
      return res.status(400).json({ error: 'not a local install' });
    }
    const date  = (req.body?.date  || archiveService.todayStr()).trim();
    const force = !!req.body?.force;
    const r = await archiveService.archiveForDate(pool, date, { force });
    res.json(r);
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
    // SEPOS-SPLITBILL-001 — one row per PAYMENT still comes back from the JOIN,
    // but we GROUP by order so a split-tender bill (e.g. £50 cash + £50 card)
    // shows as a SINGLE "Split" line carrying a `tenders` array, instead of two
    // separate rows. The method filter is applied at the ORDER level (keep any
    // bill that has a matching tender) so a split bill still appears under its
    // Cash or Card filter. Single-payment bills keep their real method.
    let query = `SELECT orders.id, orders.total, orders.covers, orders.closed_at, orders.discount_type, orders.discount_value, orders.discount_reason, orders.order_type, orders.no_service_charge, tables.table_number, payments.method, payments.amount as paid_amount, payments.id AS payment_id FROM orders LEFT JOIN tables ON orders.table_id = tables.id LEFT JOIN payments ON orders.id = payments.order_id WHERE orders.status='closed' AND orders.total > 0 AND payments.method IS NOT NULL AND payments.method != 'cancelled'`;
    const params = [];
    let n = 1;
    if (from) { query += ` AND orders.closed_at::date >= $${n}::date`; params.push(from); n++; }
    if (to) { query += ` AND orders.closed_at::date <= $${n}::date`; params.push(to); n++; }
    query += ' ORDER BY orders.closed_at DESC, payments.id ASC';
    const [result, scRes] = await Promise.all([
      pool.query(query, params),
      pool.query(`SELECT key, value FROM settings WHERE key IN ('service_charge_enabled','service_charge_rate','service_charge_percent')`),
    ]);
    const scCfg = {}; for (const r of scRes.rows) scCfg[r.key] = r.value;
    const scEnabled = String(scCfg.service_charge_enabled ?? 'true') !== '0' && String(scCfg.service_charge_enabled ?? 'true') !== 'false';
    const scRate    = Number(scCfg.service_charge_rate ?? scCfg.service_charge_percent ?? 12.5) || 0;

    const byOrder = new Map();
    for (const r of result.rows) {
      let b = byOrder.get(r.id);
      if (!b) {
        b = { id: r.id, total: r.total, covers: r.covers, closed_at: r.closed_at,
              discount_type: r.discount_type, discount_value: r.discount_value,
              discount_reason: r.discount_reason, table_number: r.table_number,
              order_type: r.order_type, no_service_charge: r.no_service_charge,
              service_charge_rate: scRate,
              service_charge: serviceChargeForOrder(r, scEnabled, scRate),
              tenders: [], paid_amount: 0 };
        byOrder.set(r.id, b);
      }
      b.tenders.push({ id: r.payment_id, method: r.method, amount: Number(r.paid_amount || 0) });
      b.paid_amount += Number(r.paid_amount || 0);
    }
    let bills = [...byOrder.values()].map(b => ({
      ...b,
      is_split: b.tenders.length > 1,
      // Single tender → its real method; multiple → "Split" (details in tenders[]).
      method: b.tenders.length > 1 ? 'Split' : (b.tenders[0]?.method || ''),
    }));
    // Order-level method filter: keep bills that have at least one matching tender.
    if (method && method !== 'all') {
      bills = bills.filter(b => b.tenders.some(t => t.method === method));
    }
    res.json(bills);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-PAY-AMEND-001 — change the payment method on a closed bill.
// Cashier mis-keys Cash for Card on close-out → Z-report cash/card
// split is wrong. Pre-this ticket the only fix was delete + re-create
// which broke bill numbering continuity. Now: PIN-gated amendment that
// preserves the original method in payment_amendments + flags the
// payments row with amended_* columns.
//
// Voucher amendments are blocked here because they'd require restoring
// the voucher balance (double-spend risk) — the operator is routed to
// Admin → Vouchers → Void if the voucher redemption itself was wrong.
app.put('/api/bills/:id/amend-method', async (req, res) => {
  const client = await pool.connect();
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'invalid order id' });
    const { new_method, reason, pin } = req.body || {};
    if (!new_method) return res.status(400).json({ error: 'new_method required' });
    if (!pin)        return res.status(400).json({ error: 'Manager PIN required' });

    const allowed = ['Cash', 'Card', 'Other', 'Stripe'];
    if (!allowed.includes(new_method)) {
      return res.status(400).json({ error: `new_method must be one of ${allowed.join(', ')}` });
    }

    // PIN gate — admin / manager / supervisor only (mirrors SEPOS-042).
    const staffRes = await client.query(
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

    await client.query('BEGIN');

    // Order must be closed — amending an open bill makes no sense (operator
    // should just pay it with the right method instead).
    const ordRes = await client.query('SELECT id, status FROM orders WHERE id = $1', [orderId]);
    const order = ordRes.rows[0];
    if (!order)                  { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status !== 'closed'){ await client.query('ROLLBACK'); return res.status(409).json({ error: 'Bill is not closed — pay with the right method instead' }); }

    // Find the latest non-cancelled payment for this order.
    const payRes = await client.query(
      `SELECT id, method, amount FROM payments
       WHERE order_id = $1 AND COALESCE(method,'') != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
      [orderId]
    );
    const payment = payRes.rows[0];
    if (!payment) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No payment to amend on this bill' }); }
    const fromMethod = payment.method;
    if (fromMethod === new_method) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Already ${new_method}` }); }
    if (fromMethod === 'voucher' || fromMethod === 'Voucher') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Voucher payments cannot be amended — use Admin → Vouchers → Void if the redemption was wrong' });
    }

    // Audit row first so we never lose the original.
    await client.query(
      `INSERT INTO payment_amendments
         (payment_id, order_id, from_method, to_method, reason, amended_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [payment.id, orderId, fromMethod, new_method, reason || null, staff.id]
    );

    // Update payments row + flag with amended_* columns.
    await client.query(
      `UPDATE payments
         SET method        = $1,
             amended_at    = CURRENT_TIMESTAMP,
             amended_by    = $2,
             amend_reason  = $3,
             amended_from  = COALESCE(amended_from, $4)
       WHERE id = $5`,
      [new_method, staff.id, reason || null, fromMethod, payment.id]
    );

    await client.query('COMMIT');
    io.emit('payment_amended', { order_id: orderId, payment_id: payment.id, from: fromMethod, to: new_method, by: staff.name });
    res.json({
      ok: true,
      order_id: orderId,
      payment_id: payment.id,
      from_method: fromMethod,
      to_method: new_method,
      amended_by: staff.name,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[amend-method]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// SEPOS-BILLEDIT-001 — closed-bill payment editor. Corrects a wrong/duplicate
// PAID amount on a closed bill (e.g. the Thann Thai T1 double £78.14). Operates
// on the EXISTING payment rows: edits amounts in place, and "remove" marks a
// row cancelled (reports exclude cancelled) rather than DELETE — a delete would
// cascade-wipe the payment_amendments audit trail. PIN-gated to admin/manager
// (money edit — stricter than the method amend). NOTE: this fixes the SYSTEM
// record only; refunding a genuine card double-charge is done on the terminal.
app.put('/api/bills/:id/edit-payment', async (req, res) => {
  const client = await pool.connect();
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'invalid order id' });
    const { payments: edits, reason, pin } = req.body || {};
    if (!Array.isArray(edits) || edits.length === 0) return res.status(400).json({ error: 'payments[] required' });
    if (!pin) return res.status(400).json({ error: 'Manager PIN required' });

    // PIN gate — admin / manager only (editing money on a closed bill is as
    // sensitive as deleting one; supervisors are excluded, mirroring delete).
    const staffRes = await client.query(
      `SELECT id, name, role FROM staff WHERE pin = $1 AND is_active = 1
         AND LOWER(role) IN ('manager','admin') LIMIT 1`,
      [String(pin).trim()]
    );
    if (staffRes.rows.length === 0) return res.status(403).json({ error: 'Invalid manager PIN (admin or manager only)' });
    const staff = staffRes.rows[0];

    const allowed = ['Cash', 'Card', 'Other', 'Stripe'];

    await client.query('BEGIN');
    const ordRes = await client.query('SELECT id, status FROM orders WHERE id = $1', [orderId]);
    const order = ordRes.rows[0];
    if (!order)                   { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status !== 'closed'){ await client.query('ROLLBACK'); return res.status(409).json({ error: 'Bill is not closed' }); }

    // Snapshot current non-cancelled payment rows for this order.
    const curRes = await client.query(
      `SELECT id, method, amount FROM payments WHERE order_id = $1 AND COALESCE(method,'') != 'cancelled'`,
      [orderId]
    );
    const current = new Map(curRes.rows.map(p => [Number(p.id), p]));

    let changed = 0;
    for (const e of edits) {
      const pid = Number(e.id);
      const row = current.get(pid);
      if (!row) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Payment ${e.id} is not on this bill` }); }
      if (String(row.method).toLowerCase() === 'voucher') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Voucher payments cannot be edited — void the voucher redemption instead' });
      }
      const oldAmt = Number(row.amount || 0), oldMethod = row.method;
      const remove = !!e.remove;
      let newAmt = remove ? 0 : Number(e.amount);
      let newMethod = remove ? 'cancelled' : (e.method || oldMethod);
      if (!remove) {
        if (!Number.isFinite(newAmt) || newAmt <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Each amount must be a positive number' }); }
        if (!allowed.includes(newMethod)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `method must be one of ${allowed.join(', ')}` }); }
      }
      // Skip no-ops.
      if (!remove && newMethod === oldMethod && Math.abs(newAmt - oldAmt) < 0.005) continue;

      // Audit BEFORE mutating (survives because we never DELETE the row).
      const note = remove
        ? `Removed payment: £${oldAmt.toFixed(2)} ${oldMethod}`
        : `Payment corrected: £${oldAmt.toFixed(2)} ${oldMethod} → £${newAmt.toFixed(2)} ${newMethod}`;
      await client.query(
        `INSERT INTO payment_amendments (payment_id, order_id, from_method, to_method, reason, amended_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pid, orderId, oldMethod, newMethod, [reason, note].filter(Boolean).join(' — '), staff.id]
      );
      await client.query(
        `UPDATE payments SET amount = $1, method = $2, amended_at = CURRENT_TIMESTAMP,
             amended_by = $3, amend_reason = $4, amended_from = COALESCE(amended_from, $5)
         WHERE id = $6`,
        [newAmt, newMethod, staff.id, [reason, note].filter(Boolean).join(' — '), oldMethod, pid]
      );
      changed++;
    }

    if (changed === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No changes to apply' }); }
    await client.query('COMMIT');
    io.emit('payment_amended', { order_id: orderId, by: staff.name });
    const after = await pool.query(
      `SELECT id, method, amount FROM payments WHERE order_id = $1 AND COALESCE(method,'') != 'cancelled' ORDER BY id ASC`,
      [orderId]
    );
    res.json({ ok: true, order_id: orderId, changed, tenders: after.rows, amended_by: staff.name });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[edit-payment]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// SEPOS-PAY-AMEND-001 — history of method changes for a single bill,
// surfaced in the Bills detail panel as an "amended" pill + tooltip.
app.get('/api/bills/:id/amendments', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pa.*, s.name AS amended_by_name
       FROM payment_amendments pa
       LEFT JOIN staff s ON s.id = pa.amended_by
       WHERE pa.order_id = $1
       ORDER BY pa.amended_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
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
    const itemsRes = await pool.query(`SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id WHERE order_items.id = ANY($1::int[])`, [item_ids]);
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
      const totalRes = await pool.query(`SELECT ${ORDER_TOTAL_EXPR} as total FROM order_items WHERE order_id=$1 AND voided=0`, [itemRes.rows[0].order_id]); // SEPOS-047c — shared discounted-total expr
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

// WEBSITE-POLISH-003 — demo-request lead capture for siamepos.co.uk.
// The marketing site's Book-a-Demo form POSTs here; we email the lead
// to info@siamepos.co.uk via Brevo. `website` is a hidden honeypot —
// bots that fill it get a silent success and no email.
app.post('/api/website/demo-request', widgetCors, async (req, res) => {
  try {
    const { first_name, last_name, restaurant, phone, email, language, current_system, notes, website } = req.body || {};
    if (website) return res.json({ success: true });
    if (!first_name?.trim() || !restaurant?.trim() || !phone?.trim() || !email?.trim()) {
      return res.status(400).json({ error: 'missing required fields' });
    }
    const esc = (s) => String(s || '').slice(0, 300).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const row = (k, v) => v ? `<tr><td style="padding:6px 12px;color:#888;font-size:13px;">${k}</td><td style="padding:6px 12px;font-size:14px;font-weight:600;color:#0D1B3E;">${esc(v)}</td></tr>` : '';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;">
        <div style="background:#0D1B3E;color:#C9A84C;padding:16px 22px;font-size:18px;font-weight:700;">🎯 New demo request — siamepos.co.uk</div>
        <table style="width:100%;border-collapse:collapse;background:#fafafa;">
          ${row('Name', `${first_name} ${last_name || ''}`.trim())}
          ${row('Restaurant', restaurant)}
          ${row('Phone / WhatsApp', phone)}
          ${row('Email', email)}
          ${row('Demo language', language)}
          ${row('Current system', current_system)}
          ${row('Notes', notes)}
        </table>
        <div style="padding:12px 22px;font-size:12px;color:#888;">Promised response time on the site: within 2 hours.</div>
      </div>`;
    const { sendBrevoEmail } = require('./services/emailService');
    await sendBrevoEmail('info@siamepos.co.uk', `🎯 Demo request — ${esc(restaurant)}`, html);
    console.log(`🎯 demo request: ${first_name} — ${restaurant} (${email})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[demo-request]', err.message);
    res.status(500).json({ error: 'failed to send' });
  }
});

// Helper to convert "HH:MM" string to total minutes
function toMins(t) {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// SEPOS-048 — minutes-of-day in a given IANA timezone. Replaces raw
// new Date().getHours() math which used the Node process's timezone
// (Railway defaults to UTC, so was off by 1h in BST). All restaurant
// time-of-day checks must use this so the cloud server's locale
// can't poison restaurant-local validation.
function minutesInZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Europe/London',
      hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(date);
    const hh = Number(parts.find(p => p.type === 'hour')?.value || 0);
    const mm = Number(parts.find(p => p.type === 'minute')?.value || 0);
    return hh * 60 + mm;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

// SEPOS-027 — parse a reservation's assigned tables (table_ids CSV, or table_id).
function parseTableIds(table_id, table_ids) {
  if (table_ids) return String(table_ids).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  if (table_id) return [parseInt(table_id, 10)].filter(Boolean);
  return [];
}

// SEPOS-027 — load seating units + the day's live bookings (with their assigned
// tables + dining durations) for table-aware availability / auto-assignment.
async function loadSeating(restaurant_id, date) {
  const [tablesRes, combosRes, bookingsRes] = await Promise.all([
    pool.query('SELECT id, table_number, capacity FROM tables'),
    pool.query('SELECT table_id_a, table_id_b, is_active FROM table_combinations WHERE is_active = true'),
    pool.query(
      `SELECT TO_CHAR(r.reservation_time,'HH24:MI') AS time_str, r.covers, r.table_id, r.table_ids,
              COALESCE(d.duration_mins, 90) AS duration_mins
         FROM reservations r
         LEFT JOIN dining_duration_tiers d
           ON r.covers >= d.covers_min AND (d.covers_max IS NULL OR r.covers <= d.covers_max) AND d.restaurant_id = $2
        WHERE r.reservation_date = $1 AND r.restaurant_id = $2 AND r.status NOT IN ('cancelled','no-show')`,
      [date, restaurant_id]
    ),
  ]);
  const units = tableAllocator.buildUnits(tablesRes.rows, combosRes.rows);
  const bookings = bookingsRes.rows.map(r => {
    const startMins = toMins(r.time_str);
    return { startMins, endMins: startMins + parseInt(r.duration_mins, 10), covers: parseInt(r.covers, 10), tableIds: parseTableIds(r.table_id, r.table_ids) };
  });
  return { units, bookings };
}

async function durationForCovers(restaurant_id, covers) {
  try {
    const r = await pool.query(
      `SELECT duration_mins FROM dining_duration_tiers
        WHERE restaurant_id=$1 AND covers_min<=$2 AND (covers_max IS NULL OR covers_max>=$2)
        ORDER BY covers_min DESC LIMIT 1`,
      [restaurant_id, covers]
    );
    return r.rows[0]?.duration_mins ? parseInt(r.rows[0].duration_mins, 10) : 90;
  } catch { return 90; }
}

// ── Availability — supports all_day and split (lunch/dinner) service ──
app.get('/api/reservations/availability', widgetCors, async (req, res) => {
  try {
    const { date, covers = 2 } = req.query;
    const restaurant_id = req.query.restaurant_id || process.env.RESTAURANT_ID || 'siamepos';
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    const coversNum = parseInt(covers, 10);
    if (isNaN(coversNum) || coversNum < 1) return res.status(400).json({ error: 'covers must be a positive number' });

    const settingsRes = await pool.query('SELECT * FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]);
    const s = settingsRes.rows[0] || {
      opening_time: '11:00', last_booking_time: '21:30',
      slot_interval_mins: 15, max_covers_per_slot: 20, max_party_size: 8,
      booking_lead_hours: 1, booking_advance_days: 60,
      service_type: 'all_day',
    };

    // SEPOS-050 — per-restaurant cap on online party size. Larger parties
    // can't self-serve a slot; the widget tells them to phone instead.
    const maxPartySize = s.max_party_size || 8;
    if (coversNum > maxPartySize) {
      return res.json({
        date, covers: coversNum, restaurant_id, slots: [],
        max_party_size: maxPartySize, restaurant_phone: s.restaurant_phone || null,
        message: `For parties larger than ${maxPartySize}, please call the restaurant directly to book.`,
      });
    }

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

    // Fetch bookings with dining duration + assigned tables (table-aware).
    const bookingsRes = await pool.query(
      `SELECT TO_CHAR(r.reservation_time, 'HH24:MI') AS time_str, r.covers, r.table_id, r.table_ids,
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
      return { startMins, covers: parseInt(r.covers, 10), endMins: startMins + parseInt(r.duration_mins, 10), tableIds: parseTableIds(r.table_id, r.table_ids) };
    });

    // SEPOS-027 — table-aware availability: a slot is only open if a table (or
    // linked group) big enough is actually free then. Falls back to the
    // covers-only rule when no unit can fit the party (covers > maxUnit) so an
    // incomplete floor plan never wrongly rejects.
    const tablesRes = await pool.query('SELECT id, table_number, capacity FROM tables');
    const combosRes = await pool.query('SELECT table_id_a, table_id_b, is_active FROM table_combinations WHERE is_active = true');
    const units = tableAllocator.buildUnits(tablesRes.rows, combosRes.rows);
    const maxUnit = units.reduce((m, u) => Math.max(m, u.capacity), 0);
    const newDuration = await durationForCovers(restaurant_id, coversNum);
    const tableAware = units.length > 0 && coversNum <= maxUnit;

    const maxCovers = s.max_covers_per_slot || 20;
    const isToday   = requestedDate.toDateString() === new Date().toDateString();
    // SEPOS-048 — use restaurant's timezone for "now" so the slot generator
    // doesn't skip valid slots because the server's wall clock is UTC.
    const tz = s.timezone || 'Europe/London';
    const nowMins   = isToday ? (minutesInZone(new Date(), tz) + (s.booking_lead_hours || 1) * 60) : -1;

    const result = slots.map(time => {
      const slotMins = toMins(time);
      const activeCovers = bookings.reduce((sum, b) => (b.startMins <= slotMins && b.endMins > slotMins ? sum + b.covers : sum), 0);
      const remaining    = maxCovers - activeCovers;
      const pastCutoff   = isToday && slotMins < nowMins;
      // A table/group big enough must be free for the party's whole stay.
      let tableOk = true;
      if (tableAware) {
        const overlap = bookings.filter(b => b.startMins < slotMins + newDuration && b.endMins > slotMins);
        tableOk = tableAllocator.canSeat(units, overlap, coversNum).ok;
      }
      return { time, available: !pastCutoff && remaining >= coversNum && tableOk, remaining_covers: Math.max(0, remaining), past: pastCutoff };
    });

    res.json({ date, covers: coversNum, restaurant_id, slots: result });
  } catch (err) {
    console.error('GET /api/reservations/availability error:', err);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// ── GET reservation settings (no-param version — uses RESTAURANT_ID env) ──
app.get('/api/reservations/settings', async (req, res) => {
  req.params = { restaurantId: resolveRestaurantId(req) };
  // fall through to the parameterised handler below via direct call
  const rid = resolveRestaurantId(req);
  try {
    // BUG-EPOS-001 — the previous SELECT named deprecated columns
    // (slot_interval, default_duration, service_start/end, lunch_start/end,
    // dinner_start/end, use_split_service, confirmation_email) that don't
    // exist on the current restaurant_settings schema → 500. Mirror the
    // SELECT from the widget handler below; only the fallback behaviour
    // differs (admin returns defaults if no row, widget 404s).
    const result = await pool.query(
      `SELECT restaurant_id, restaurant_name, brand_colour,
              TO_CHAR(opening_time, 'HH24:MI')         AS opening_time,
              TO_CHAR(last_booking_time, 'HH24:MI')    AS last_booking_time,
              service_type,
              TO_CHAR(lunch_service_start, 'HH24:MI')  AS lunch_service_start,
              TO_CHAR(lunch_service_end, 'HH24:MI')    AS lunch_service_end,
              TO_CHAR(dinner_service_start, 'HH24:MI') AS dinner_service_start,
              TO_CHAR(dinner_service_end, 'HH24:MI')   AS dinner_service_end,
              slot_interval_mins, max_covers_per_slot, max_party_size,
              restaurant_phone,
              booking_lead_hours, booking_advance_days, is_active,
              takeaway_busy_threshold, takeaway_very_busy_threshold,
              takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy,
              timezone
       FROM restaurant_settings WHERE restaurant_id = $1`, [rid]
    );
    const s = result.rows[0] || { restaurant_id: rid, is_active: true };
    res.json(s);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
              slot_interval_mins, max_covers_per_slot, max_party_size,
              restaurant_phone,
              booking_lead_hours, booking_advance_days, is_active,
              takeaway_busy_threshold, takeaway_very_busy_threshold,
              takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy,
              timezone
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
    const { date, status } = req.query;
    const restaurant_id = req.query.restaurant_id || process.env.RESTAURANT_ID || 'siamepos';
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
    const { customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, notes, source = 'widget', table_id = null, status = 'pending', marketing_consent = 0 } = req.body;
    const restaurant_id = req.body.restaurant_id || process.env.RESTAURANT_ID || 'siamepos';
    if (!customer_name?.trim()) return res.status(400).json({ error: 'Guest name is required' });
    if (!customer_phone?.trim()) return res.status(400).json({ error: 'Phone number is required' });
    if (!reservation_date) return res.status(400).json({ error: 'Date is required' });
    if (!reservation_time) return res.status(400).json({ error: 'Time is required' });
    // BUG-004 — reject bookings for a date already in the past.
    // reservation_date arrives as 'YYYY-MM-DD'; lexical compare against
    // today works for that format. Same-day bookings are allowed.
    if (String(reservation_date).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'Reservation date cannot be in the past' });
    }
    const coversNum = parseInt(covers, 10);
    if (!coversNum || coversNum < 1) return res.status(400).json({ error: 'Covers must be at least 1' });
    const slotCheck = await pool.query(`SELECT COALESCE(SUM(covers), 0) AS booked FROM reservations WHERE reservation_date = $1 AND TO_CHAR(reservation_time, 'HH24:MI') = $2 AND restaurant_id = $3 AND status NOT IN ('cancelled','no-show')`, [reservation_date, reservation_time.slice(0, 5), restaurant_id]);
    const settingsRes = await pool.query('SELECT max_covers_per_slot, max_party_size, restaurant_phone FROM restaurant_settings WHERE restaurant_id = $1', [restaurant_id]);
    // SEPOS-050 — online (widget) bookings are capped to the restaurant's
    // max party size. Staff-created bookings are NOT capped — staff can
    // link tables and judge their own floor.
    const maxPartySize = settingsRes.rows[0]?.max_party_size || 8;
    if (source === 'widget' && coversNum > maxPartySize) {
      const phone = settingsRes.rows[0]?.restaurant_phone;
      return res.status(400).json({
        error: phone
          ? `For parties larger than ${maxPartySize}, please call us on ${phone} to book.`
          : `For parties larger than ${maxPartySize}, please contact the restaurant directly to book.`,
      });
    }
    const maxCovers = settingsRes.rows[0]?.max_covers_per_slot || 20;
    const alreadyBooked = parseInt(slotCheck.rows[0]?.booked || 0, 10);
    if (alreadyBooked + coversNum > maxCovers) return res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });

    // SEPOS-027 — table-aware auto-assign + block for ONLINE (widget) bookings.
    // Find the best-fit free table/linked-group for the party at that time; if
    // none is free, refuse the booking (don't accept what we can't seat). Staff
    // bookings keep whatever table they chose (they manage the floor manually).
    let assignTableId = table_id;
    let assignTableIds = null;
    if (source === 'widget') {
      try {
        const { units, bookings } = await loadSeating(restaurant_id, reservation_date);
        const maxUnit = units.reduce((m, u) => Math.max(m, u.capacity), 0);
        if (units.length > 0 && coversNum <= maxUnit) {
          const startMins = toMins(reservation_time);
          const newDuration = await durationForCovers(restaurant_id, coversNum);
          const overlap = bookings.filter(b => b.startMins < startMins + newDuration && b.endMins > startMins);
          const fit = tableAllocator.canSeat(units, overlap, coversNum);
          if (!fit.ok) {
            const phone = settingsRes.rows[0]?.restaurant_phone;
            return res.status(409).json({ error: phone
              ? `Sorry, we don't have a table for ${coversNum} at that time. Please pick another time or call us on ${phone}.`
              : `Sorry, we don't have a table for ${coversNum} at that time. Please pick another time.` });
          }
          assignTableId  = fit.tableIds[0] || null;
          assignTableIds = fit.tableIds.join(',');
        }
      } catch (e) { console.warn('[reservations] table allocation skipped:', e.message); }
    }

    const insertStatus = source === 'widget' ? 'pending' : (status || 'pending');
    const result = await pool.query(
      `INSERT INTO reservations (restaurant_id, table_id, table_ids, customer_name, customer_phone, customer_email, covers, reservation_date, reservation_time, status, notes, source, marketing_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [restaurant_id, assignTableId, assignTableIds, customer_name.trim(), customer_phone.trim(), customer_email?.trim() || null, coversNum, reservation_date, reservation_time, insertStatus, notes?.trim() || null, source, marketing_consent ? 1 : 0]
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
    // Multi-table join — `table_ids` is the full set of tables for this
    // booking; `table_id` is kept as the primary (first) table for order
    // creation and legacy single-table reads. Callers may send either.
    let tableIdsArr;
    if (Array.isArray(req.body.table_ids)) {
      tableIdsArr = req.body.table_ids.map(Number).filter(Boolean);
    } else if (typeof req.body.table_ids === 'string' && req.body.table_ids.trim() !== '') {
      // SEPOS-047h — accept the CSV form ("5,6") too. GET returns table_ids
      // as a CSV string, so a client that echoes the row back (e.g. an
      // optimistic status PUT) was failing the Array check and collapsing a
      // multi-table booking to just its primary table. Defence in depth.
      tableIdsArr = req.body.table_ids.split(',').map(Number).filter(Boolean);
    } else if (table_id != null && table_id !== '') {
      tableIdsArr = [Number(table_id)].filter(Boolean);
    } else {
      tableIdsArr = [];
    }
    const primaryId   = tableIdsArr[0] || null;
    const tableIdsCsv = tableIdsArr.length ? tableIdsArr.join(',') : null;
    const result = await pool.query(`UPDATE reservations SET customer_name=$1, customer_phone=$2, customer_email=$3, covers=$4, reservation_date=$5, reservation_time=$6, table_id=$7, table_ids=$8, notes=$9, status=$10, updated_at=NOW() WHERE id=$11 RETURNING *`, [customer_name, customer_phone, customer_email || null, covers, reservation_date, reservation_time, primaryId, tableIdsCsv, notes || null, status, req.params.id]);
    // BUG-005 — a PUT for a non-existent reservation used to UPDATE 0
    // rows and still return 200 with an empty body (silent no-op).
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
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
      table_id, covers,
      customer_name = 'Walk-in', customer_phone = null, customer_email = null,
      staff_id = null, notes = null,
    } = req.body || {};
    const restaurant_id = (req.body || {}).restaurant_id || process.env.RESTAURANT_ID || 'siamepos';
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

// SEPOS-049 — bulk GET for the sync engine. Returns ALL restaurant_settings
// rows as an array so the Mac sync engine can pull and upsert by
// restaurant_id. Single-tenant installs see one row.
app.get('/api/restaurant-settings', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT restaurant_id, restaurant_name, brand_colour,
              TO_CHAR(opening_time, 'HH24:MI')         AS opening_time,
              TO_CHAR(last_booking_time, 'HH24:MI')    AS last_booking_time,
              service_type,
              TO_CHAR(lunch_service_start, 'HH24:MI')  AS lunch_service_start,
              TO_CHAR(lunch_service_end, 'HH24:MI')    AS lunch_service_end,
              TO_CHAR(dinner_service_start, 'HH24:MI') AS dinner_service_start,
              TO_CHAR(dinner_service_end, 'HH24:MI')   AS dinner_service_end,
              slot_interval_mins, max_covers_per_slot, max_party_size,
              restaurant_phone,
              booking_lead_hours, booking_advance_days, is_active,
              takeaway_busy_threshold, takeaway_very_busy_threshold,
              takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy,
              timezone
         FROM restaurant_settings`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /api/restaurant-settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT reservation settings — saves all fields including lunch/dinner ──
app.put('/api/reservations/settings/:restaurantId', async (req, res) => {
  try {
    const {
      restaurant_name, brand_colour, opening_time, last_booking_time,
      service_type, lunch_service_start, lunch_service_end,
      dinner_service_start, dinner_service_end,
      slot_interval_mins, max_covers_per_slot, max_party_size, restaurant_phone,
      booking_lead_hours, booking_advance_days, is_active,
      takeaway_busy_threshold, takeaway_very_busy_threshold,
      takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy,
      // SEPOS-048 — IANA timezone (e.g. 'Europe/London', 'Asia/Bangkok')
      timezone,
    } = req.body;
    await pool.query(
      `INSERT INTO restaurant_settings
         (restaurant_id, restaurant_name, brand_colour, opening_time, last_booking_time,
          service_type, lunch_service_start, lunch_service_end,
          dinner_service_start, dinner_service_end,
          slot_interval_mins, max_covers_per_slot, max_party_size, restaurant_phone,
          booking_lead_hours, booking_advance_days, is_active,
          takeaway_busy_threshold, takeaway_very_busy_threshold,
          takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
         max_party_size       = EXCLUDED.max_party_size,
         restaurant_phone     = EXCLUDED.restaurant_phone,
         booking_lead_hours   = EXCLUDED.booking_lead_hours,
         booking_advance_days = EXCLUDED.booking_advance_days,
         is_active            = EXCLUDED.is_active,
         takeaway_busy_threshold      = EXCLUDED.takeaway_busy_threshold,
         takeaway_very_busy_threshold = EXCLUDED.takeaway_very_busy_threshold,
         takeaway_wait_quiet          = EXCLUDED.takeaway_wait_quiet,
         takeaway_wait_busy           = EXCLUDED.takeaway_wait_busy,
         takeaway_wait_very_busy      = EXCLUDED.takeaway_wait_very_busy,
         timezone                     = EXCLUDED.timezone`,
      [req.params.restaurantId, restaurant_name, brand_colour, opening_time, last_booking_time,
       service_type || 'all_day', lunch_service_start || '11:00', lunch_service_end || '14:30',
       dinner_service_start || '17:30', dinner_service_end || '21:30',
       slot_interval_mins, max_covers_per_slot, max_party_size || 8, restaurant_phone || null,
       booking_lead_hours, booking_advance_days,
       // SQLite better-sqlite3 rejects JS booleans as bind params (cloud PG
       // accepts them transparently). Coerce 1/0 so the same payload works
       // on both backends.
       is_active ? 1 : 0,
       takeaway_busy_threshold      ?? 5,
       takeaway_very_busy_threshold ?? 10,
       takeaway_wait_quiet          ?? 20,
       takeaway_wait_busy           ?? 35,
       takeaway_wait_very_busy      ?? 50,
       timezone || 'Europe/London']
    );

    // SEPOS-049 + SEPOS-050 — durable write-through to cloud. On a desktop
    // install (DB_MODE=local), the local SQLite write happened above. We
    // ALSO need the cloud Railway to learn about it (so the public takeaway
    // widget sees the change). Pattern:
    //   1. Enqueue first so an offline save can't be silently lost on the
    //      next pull tick.
    //   2. Try the cloud PUT immediately for instant reflection when online.
    //   3. On success, markSynced so the queue drain doesn't double-push.
    //   4. On failure (offline, 5xx), leave it in the queue — syncService's
    //      drainQueue will retry it on the next tick.
    const archiveService = require('./services/archiveService');
    const isLocal = archiveService.isLocalInstall();
    const cloudUrl = process.env.CLOUD_API_URL;
    console.log(`[sync] settings PUT received for ${req.params.restaurantId} · isLocal=${isLocal} · cloudUrl=${cloudUrl ? 'set' : 'unset'}`);
    if (isLocal) {
      const offlineQueue = require('./services/offlineQueue');
      const queueId = await offlineQueue.enqueue('update_restaurant_settings', {
        restaurantId: req.params.restaurantId,
        body: req.body,
      });
      console.log(`[sync] settings enqueued as queueId=${queueId}`);
      if (queueId && cloudUrl) {
        const pushUrl = `${cloudUrl}/api/reservations/settings/${encodeURIComponent(req.params.restaurantId)}`;
        console.log(`[sync] immediate push → ${pushUrl}`);
        fetch(pushUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        })
          .then(async r => {
            if (r.ok) {
              await offlineQueue.markSynced(queueId);
              console.log(`[sync] ✓ settings pushed to cloud for ${req.params.restaurantId}`);
            } else {
              const body = await r.text().catch(() => '');
              console.warn(`[sync] ✗ settings push ${r.status} — body: ${body.slice(0, 200)}`);
            }
          })
          .catch(err => console.warn('[sync] settings push failed, queued for retry:', err.message));
      } else if (!cloudUrl) {
        console.warn('[sync] CLOUD_API_URL is unset — settings stuck in local DB only. Check electron/main.js env injection.');
      }
    }

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
    // Ensure a category exists for every item. Previously the importer only
    // matched EXISTING categories; a scanned menu's categories rarely match the
    // seeded ones, so items were inserted with category_id=NULL and vanished
    // from the menu tree. Create the category on the fly (keeps the in-memory
    // list in sync so we don't duplicate within a batch).
    async function ensureCategoryId(categoryName) {
      const existing = findCategoryId(categoryName);
      if (existing) return existing;
      const name = (categoryName && String(categoryName).trim()) || 'Menu';
      const dup = categories.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (dup) return dup.id;
      const created = await client.query('INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING id, name', [name, categories.length + 1]);
      categories.push({ id: created.rows[0].id, name: created.rows[0].name });
      return created.rows[0].id;
    }
    const results = { inserted: [], skipped: [], errors: [] };
    for (const item of items) {
      try {
        // Name: prefer English, fall back to Thai / generic name so a Thai-only
        // menu still imports (was silently dropping "Missing name_en").
        const nameEn = (item.name_en && item.name_en.trim())
          || (item.name_th && item.name_th.trim())
          || (item.name && String(item.name).trim()) || '';
        if (!nameEn) { results.skipped.push({ item, reason: 'Missing name' }); continue; }
        // Price: strip currency symbols / spaces (฿, £, "120.-") before parsing.
        const price = parseFloat(String(item.price == null ? '' : item.price).replace(/[^0-9.]/g, ''));
        if (isNaN(price) || price < 0) { results.skipped.push({ item, reason: 'Invalid price' }); continue; }
        const categoryId = await ensureCategoryId(item.category);
        const nameTh = (item.name_th && item.name_th.trim()) || null;
        const nameAlt = (nameTh && nameTh !== nameEn) ? nameTh : null;
        let allergensStr = null;
        if (Array.isArray(item.allergens) && item.allergens.length > 0) allergensStr = JSON.stringify(item.allergens);
        else if (typeof item.allergens === 'string' && item.allergens.trim()) allergensStr = JSON.stringify([item.allergens]);
        const insertRes = await client.query(`INSERT INTO menu_items (category_id, name, name_alt, description, price, allergens, is_available) VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, name`, [categoryId, nameEn, nameAlt, item.description ? item.description.trim() : null, price, allergensStr]);
        results.inserted.push({ id: insertRes.rows[0].id, name: insertRes.rows[0].name, category_id: categoryId, category_name: item.category || null });
      } catch (itemErr) { results.errors.push({ item, error: itemErr.message }); }
    }
    await client.query('COMMIT');
    res.json({ success: true, summary: { total: items.length, inserted: results.inserted.length, skipped: results.skipped.length, errors: results.errors.length }, inserted: results.inserted, skipped: results.skipped, errors: results.errors });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// SEPOS-046h — translate Anthropic upstream error into an operator-friendly
// message. The previous code returned a generic "Anthropic API error" with
// no clue what went wrong (auth fail vs overloaded vs bad image), which
// burned an entire pitch demo. Pattern-match on status code + body to
// surface the most useful first line.
function anthropicErrorMessage(status, body) {
  const txt = String(body || '').toLowerCase();
  if (status === 401 || txt.includes('authentication_error') || txt.includes('invalid x-api-key')) {
    return 'Anthropic key rejected (401) — set or rotate ANTHROPIC_API_KEY on Railway.';
  }
  if (status === 403 || txt.includes('permission_error')) {
    return 'Anthropic permission denied (403) — your key may not have access to this model.';
  }
  if (status === 404 || txt.includes('not_found_error')) {
    return 'Anthropic model not found (404) — the model name may have been retired. Update the model id in the handler.';
  }
  if (status === 429 || txt.includes('rate_limit')) {
    return 'Anthropic rate limit hit (429) — wait a minute and retry, or upgrade your plan.';
  }
  if (status === 529 || txt.includes('overloaded')) {
    return 'Anthropic overloaded (529) — usually transient. Retry in a minute.';
  }
  if (status >= 500) {
    return `Anthropic upstream error (${status}) — typically transient, retry shortly.`;
  }
  if (status === 400 && txt.includes('image')) {
    return 'Anthropic rejected the image (400) — try a larger / clearer / different-format file.';
  }
  return `Anthropic error (${status}) — see upstream_body field for details.`;
}

// SEPOS-046f — desktop installs don't hold ANTHROPIC_API_KEY (kept on
// Railway only). When the local server gets an AI request and has no key,
// forward the same body to the cloud's equivalent endpoint, which DOES
// have the key. Returns the cloud's response verbatim. Falls back to the
// old "not set" error only if cloud isn't reachable either.
async function relayAiToCloud(path, body) {
  const cloudUrl = process.env.CLOUD_API_URL;
  if (!cloudUrl) return null;
  try {
    // SEPOS-047a — the cloud's AI endpoints are auth-gated; the relay
    // authenticates with the install's SYNC_SECRET (same shared secret
    // as the order-sync feeds, from config.json / env).
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SYNC_SECRET) headers['x-sync-secret'] = process.env.SYNC_SECRET;
    const r = await fetch(`${cloudUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  } catch (err) {
    console.warn(`[ai-relay] ${path} failed:`, err.message);
    return null;
  }
}

app.post('/api/ai/scan-menu', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      const relayed = await relayAiToCloud('/api/ai/scan-menu', req.body);
      if (relayed) return res.status(relayed.status).json(relayed.json);
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set locally and no cloud relay configured' });
    }
    const isImage = media_type && media_type.startsWith('image/');
    const contentItem = isImage ? { type: 'image', source: { type: 'base64', media_type, data: image_base64 } } : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } };
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: [contentItem, { type: 'text', text: `You are an expert restaurant menu reader and UK food safety specialist.\n\nAnalyse this menu image/document and extract ALL dishes. For each dish provide:\n1. English name\n2. Thai name (transliterate or translate)\n3. Short appetising description (1-2 sentences)\n4. Price in GBP — exact if visible, estimated if not. Mark assumed prices.\n5. UK 14 allergens — gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, nuts, celery, mustard, sesame, sulphites, lupin, molluscs. Fish sauce is in almost all Thai food.\n6. Category (Starters, Mains, Curries, Noodles, Rice Dishes, Salads, Desserts, Drinks, Sides)\n7. Confidence score 0-100\n\nReturn ONLY valid JSON, no markdown, no explanation:\n{\n  "restaurant_type": "Thai Restaurant",\n  "total_dishes": 0,\n  "categories": [\n    {\n      "name": "Category Name",\n      "dishes": [\n        {\n          "name_en": "English Name",\n          "name_th": "ชื่อภาษาไทย",\n          "description": "Description",\n          "price": 12.50,\n          "price_assumed": false,\n          "allergens": ["Fish","Soybeans"],\n          "confidence": 95\n        }\n      ]\n    }\n  ]\n}` }] }] });
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) {
      console.error('Anthropic error:', result.status, result.body);
      // SEPOS-046h — pass the upstream error through so operators see
      // "401 invalid x-api-key" / "404 model not found" / "529 overloaded"
      // in the admin UI instead of "Anthropic API error" with no clue.
      return res.status(502).json({
        error: anthropicErrorMessage(result.status, result.body),
        upstream_status: result.status,
        upstream_body: String(result.body || '').slice(0, 500),
      });
    }
    const data = JSON.parse(result.body);
    const raw = data.content.map(b => b.text || '').join('');
    // Extract the JSON object robustly: strip markdown fences, then slice from
    // the first '{' to the last '}' so any surrounding prose is dropped.
    let clean = raw.replace(/```json|```/g, '').trim();
    const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
    if (first >= 0 && last > first) clean = clean.slice(first, last + 1);
    let menu;
    try { menu = JSON.parse(clean); } catch (parseErr) {
      // stop_reason === 'max_tokens' means the menu was too long for one pass
      // and the JSON was cut off — guide the operator to split it.
      const truncated = data.stop_reason === 'max_tokens';
      return res.status(500).json({ error: truncated
        ? 'This menu is too long to read in one go — scan one page/section at a time.'
        : 'AI returned invalid JSON — try again with a clearer image' });
    }
    console.log(`🍜 Menu scan complete: ${menu.total_dishes || '?'} dishes`);
    res.json({ success: true, menu });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/scan-invoice', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });
    if (!process.env.ANTHROPIC_API_KEY) {
      const relayed = await relayAiToCloud('/api/ai/scan-invoice', req.body);
      if (relayed) return res.status(relayed.status).json(relayed.json);
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not set locally and no cloud relay configured' });
    }
    const INVOICE_PROMPT = `You are reading a supplier invoice or delivery note for a restaurant.\nExtract all information and return ONLY a valid JSON object — no other text, no markdown, no explanation.\n\nRequired JSON structure:\n{\n  "supplier_name": "string",\n  "invoice_date": "YYYY-MM-DD",\n  "invoice_number": "string",\n  "total_amount": number,\n  "line_items": [\n    { "name": "string", "quantity": number, "unit": "string", "unit_price": number, "line_total": number }\n  ]\n}\n\nRules: If a value is missing use null for strings and 0 for numbers. Convert prices to GBP. Return ONLY the JSON object.`;
    const https = require('https');
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } }, { type: 'text', text: INVOICE_PROMPT }] }] });
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) {
      console.error('Anthropic error:', result.status, result.body);
      return res.status(502).json({
        success: false,
        error: anthropicErrorMessage(result.status, result.body),
        upstream_status: result.status,
        upstream_body: String(result.body || '').slice(0, 500),
      });
    }
    const aiData = JSON.parse(result.body);
    const invoice = JSON.parse(aiData.content?.[0]?.text?.replace(/```json|```/g, '').trim() || '{}');
    return res.json({ success: true, invoice });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/ai/scan-expense', requireStaffAuthOrSyncSecret(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const { image_base64, media_type } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, error: 'No image provided' });
    if (!process.env.ANTHROPIC_API_KEY) {
      const relayed = await relayAiToCloud('/api/ai/scan-expense', req.body);
      if (relayed) return res.status(relayed.status).json(relayed.json);
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not set locally and no cloud relay configured' });
    }
    const EXPENSE_PROMPT = `You are reading a receipt, bill or expense document for a restaurant.\nExtract the key information and return ONLY a valid JSON object — no other text, no markdown.\n\nRequired JSON structure:\n{\n  "vendor": "string", "date": "YYYY-MM-DD", "total_amount": number,\n  "description": "string", "category": "overhead|labour|other",\n  "line_items": [{ "description": "string", "amount": number }]\n}\n\nCategory: overhead=rent/utilities/insurance/repairs, labour=wages/staff, other=equipment/misc. Return ONLY JSON.`;
    const https = require('https');
    const requestBody = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } }, { type: 'text', text: EXPENSE_PROMPT }] }] });
    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };
      const apiReq = https.request(options, (apiRes) => { let data = ''; apiRes.on('data', chunk => { data += chunk; }); apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data })); });
      apiReq.on('error', reject); apiReq.write(requestBody); apiReq.end();
    });
    if (result.status !== 200) {
      console.error('Anthropic error:', result.status, result.body);
      return res.status(502).json({
        success: false,
        error: anthropicErrorMessage(result.status, result.body),
        upstream_status: result.status,
        upstream_body: String(result.body || '').slice(0, 500),
      });
    }
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
  const client = await pool.connect();
  try {
    // SEPOS-046 fix — wrap the whole invoice (header + every stock/cost update)
    // in ONE transaction. Without it, an error partway through the line_items
    // loop left the header + already-applied stock increments committed while
    // the rest weren't; the operator re-submitted and double-counted stock.
    await client.query('BEGIN');
    const { supplier_name, invoice_date, invoice_number, total_amount, status, line_items } = req.body;

    // 1. Save the invoice header
    const invoiceResult = await client.query(
      `INSERT INTO supplier_invoices (supplier_name, invoice_date, invoice_number, total_amount, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [supplier_name, invoice_date, invoice_number, parseFloat(total_amount) || 0, status || 'processed']
    );
    const invoiceId = invoiceResult.rows[0].id;

    const created = [];
    const updated = [];
    const price_changes = [];

    // 2. Process each line item
    for (const item of (line_items || [])) {
      const qty       = parseFloat(item.quantity)   || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      if (qty <= 0) continue;

      if (item.matched_ingredient_id) {
        // Matched to an existing ingredient
        const ingRes = await client.query(
          `SELECT id, name_en, cost_per_unit FROM ingredients WHERE id = $1`,
          [item.matched_ingredient_id]
        );
        if (ingRes.rows.length === 0) continue;
        const ing = ingRes.rows[0];
        const oldCost = parseFloat(ing.cost_per_unit) || 0;

        await client.query(
          `UPDATE ingredients
           SET current_stock = current_stock + $1,
               cost_per_unit = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [qty, unitPrice, ing.id]
        );

        await client.query(
          `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
           VALUES ($1, 'delivery', $2, $3, $4, $5)`,
          [ing.id, qty, unitPrice, `Invoice ${invoice_number || ''}`, `invoice:${invoiceId}`]
        );

        updated.push(ing.name_en);

        if (Math.abs(unitPrice - oldCost) > 0.001) {
          price_changes.push({ name: ing.name_en, old_cost: oldCost, new_cost: unitPrice });
        }

      } else {
        // No match — auto-create a new ingredient
        const newName = item.name_extracted || item.name || 'Unknown Item';
        const newIng = await client.query(
          `INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, supplier_name, updated_at)
           VALUES ($1, '', $2, $3, 100, 'Other', $4, $5, NOW())
           RETURNING id, name_en`,
          [newName, item.unit || 'unit', unitPrice, qty, supplier_name || '']
        );

        await client.query(
          `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
           VALUES ($1, 'delivery', $2, $3, $4, $5)`,
          [newIng.rows[0].id, qty, unitPrice, `Invoice ${invoice_number || ''} (auto-created)`, `invoice:${invoiceId}`]
        );

        created.push(newName);
      }
    }

    // 3. Return everything the frontend needs for the done screen
    await client.query('COMMIT');
    res.json({ id: invoiceId, success: true, created, updated, price_changes });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// SEPOS-046k — flat list endpoints for the sync engine. /api/recipes and
// /api/batch-recipes return parent rows with their lines nested for the
// admin UI; the syncService PULL_TABLES upsert needs a separate flat list
// per child table. Restaurant_id filter is honoured implicitly by the
// existing single-tenant convention (pool isn't restaurant-scoped here).
app.get('/api/recipe-lines', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM recipe_lines`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/batch-recipe-lines', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM batch_recipe_lines`);
    res.json(r.rows);
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

// ── SEPOS-BATCH-001 — Batch recipes + batch instances ──────────────
// batch_recipes is the "how to make it" template. Each one auto-creates
// a matching ingredients row tagged is_batch=true so menu recipes can
// reference the batch as an ingredient.

app.get('/api/batch-recipes', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM batch_recipes ORDER BY name`);
    if (!r.rows.length) return res.json([]);
    const ids = r.rows.map(x => x.id);
    const linesRes = await pool.query(`SELECT rl.*, i.name_en AS ingredient_name, i.unit AS ingredient_unit, i.cost_per_unit FROM batch_recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.batch_recipe_id = ANY($1)`, [ids]);
    const byRecipe = {};
    linesRes.rows.forEach(l => { (byRecipe[l.batch_recipe_id] ||= []).push(l); });
    res.json(r.rows.map(br => ({ ...br, lines: byRecipe[br.id] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/batch-recipes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, output_quantity, output_unit, shelf_life_days, lines, notes } = req.body || {};
    if (!name || !output_quantity || !output_unit) return res.status(400).json({ error: 'name, output_quantity, output_unit required' });
    const totalCost = (lines || []).reduce((s, l) => s + (parseFloat(l.line_cost) || 0), 0);
    const costPerUnit = Number(output_quantity) > 0 ? totalCost / Number(output_quantity) : 0;
    await client.query('BEGIN');
    const brRes = await client.query(
      `INSERT INTO batch_recipes (name, output_quantity, output_unit, shelf_life_days, total_cost, cost_per_unit, notes, last_calculated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *`,
      [name, output_quantity, output_unit, shelf_life_days || 3, totalCost, costPerUnit, notes || null],
    );
    const br = brRes.rows[0];
    // Auto-create matching ingredient row so menu recipes can pick it up
    const ingRes = await client.query(
      `INSERT INTO ingredients (name_en, name_th, unit, cost_per_unit, yield_percentage, category, current_stock, is_batch, batch_recipe_id, updated_at)
       VALUES ($1,'',$2,$3,100,'Batch',0,TRUE,$4,NOW()) RETURNING id`,
      [name, output_unit, costPerUnit, br.id],
    );
    for (const l of (lines || [])) {
      await client.query(
        `INSERT INTO batch_recipe_lines (batch_recipe_id, ingredient_id, quantity_used, unit, line_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [br.id, l.ingredient_id, l.quantity_used, l.unit, l.line_cost],
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ...br, ingredient_id: ingRes.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batch-recipes] create', err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/batch-recipes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, output_quantity, output_unit, shelf_life_days, lines, notes } = req.body || {};
    const totalCost = (lines || []).reduce((s, l) => s + (parseFloat(l.line_cost) || 0), 0);
    const costPerUnit = Number(output_quantity) > 0 ? totalCost / Number(output_quantity) : 0;
    await client.query('BEGIN');
    await client.query(
      `UPDATE batch_recipes SET name=$1, output_quantity=$2, output_unit=$3, shelf_life_days=$4, total_cost=$5, cost_per_unit=$6, notes=$7, last_calculated=NOW() WHERE id=$8`,
      [name, output_quantity, output_unit, shelf_life_days || 3, totalCost, costPerUnit, notes || null, req.params.id],
    );
    // Keep matching ingredient in step with the new name / unit / cost
    await client.query(
      `UPDATE ingredients SET name_en=$1, unit=$2, cost_per_unit=$3, updated_at=NOW() WHERE batch_recipe_id=$4`,
      [name, output_unit, costPerUnit, req.params.id],
    );
    await client.query(`DELETE FROM batch_recipe_lines WHERE batch_recipe_id=$1`, [req.params.id]);
    for (const l of (lines || [])) {
      await client.query(
        `INSERT INTO batch_recipe_lines (batch_recipe_id, ingredient_id, quantity_used, unit, line_cost) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, l.ingredient_id, l.quantity_used, l.unit, l.line_cost],
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batch-recipes] update', err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/batch-recipes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Refuse if the matching ingredient is used in any menu recipe — the
    // chef would lose links to dishes silently otherwise.
    const used = await client.query(
      `SELECT COUNT(*)::int AS n FROM recipe_lines rl
       JOIN ingredients i ON i.id = rl.ingredient_id
       WHERE i.batch_recipe_id = $1`,
      [req.params.id],
    );
    if (used.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `In use on ${used.rows[0].n} menu recipe line(s) — remove those first or hide instead.` });
    }
    await client.query(`DELETE FROM batch_recipe_lines WHERE batch_recipe_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM batches            WHERE batch_recipe_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM ingredients        WHERE batch_recipe_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM batch_recipes      WHERE id=$1`,              [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// List physical batches. Auto-flips active→expired on read so the UI
// always sees current state without a separate cron.
app.get('/api/batches', async (req, res) => {
  try {
    await pool.query(`UPDATE batches SET status='expired' WHERE status='active' AND expires_on < CURRENT_DATE`);
    const r = await pool.query(
      `SELECT b.*, br.name AS recipe_name, br.output_unit AS unit, i.name_en AS ingredient_name, s.name AS made_by_name
       FROM batches b
       LEFT JOIN batch_recipes br ON br.id = b.batch_recipe_id
       LEFT JOIN ingredients   i  ON i.id  = b.ingredient_id
       LEFT JOIN staff         s  ON s.id  = b.made_by
       ORDER BY (b.status = 'active') DESC, b.expires_on ASC, b.created_at DESC
       LIMIT 500`,
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/batches/make — chef physically made a batch. Atomic:
//   1. Deduct raw ingredients from stock (using current cost per unit
//      to lock the total cost at make-time — paste cost stays stable
//      even if ingredient prices change next week).
//   2. Write a stock_movements row per consumed ingredient.
//   3. Compute cost_per_unit = total_cost / output_quantity.
//   4. Bump the batch ingredient's current_stock by output_quantity.
//   5. INSERT batches row with locked cost + expires_on.
app.post('/api/batches/make', async (req, res) => {
  const client = await pool.connect();
  try {
    const { batch_recipe_id, made_by, notes } = req.body || {};
    if (!batch_recipe_id) return res.status(400).json({ error: 'batch_recipe_id required' });
    await client.query('BEGIN');

    const brRes = await client.query(`SELECT * FROM batch_recipes WHERE id=$1`, [batch_recipe_id]);
    const br = brRes.rows[0];
    if (!br) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Batch recipe not found' }); }

    const linesRes = await client.query(
      `SELECT rl.*, i.cost_per_unit, i.current_stock, i.name_en
       FROM batch_recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id
       WHERE rl.batch_recipe_id = $1`,
      [batch_recipe_id],
    );

    let totalCost = 0;
    for (const l of linesRes.rows) {
      const qty       = Number(l.quantity_used || 0);
      const costPerU  = Number(l.cost_per_unit || 0);
      const lineCost  = qty * costPerU;
      totalCost += lineCost;
      // Deduct raw stock (don't block on underflow — production realities;
      // chef can fix with a manual adjustment if it goes negative).
      await client.query(`UPDATE ingredients SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2`, [qty, l.ingredient_id]);
      await client.query(
        `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
         VALUES ($1, 'batch_prep', $2, $3, $4, $5)`,
        [l.ingredient_id, -qty, costPerU, `Used in batch: ${br.name}`, `batch_recipe:${br.id}`],
      );
    }
    const outQty       = Number(br.output_quantity);
    const costPerUnit  = outQty > 0 ? totalCost / outQty : 0;

    // Find the matching batch-as-ingredient row
    const ingRes = await client.query(`SELECT id FROM ingredients WHERE batch_recipe_id = $1`, [br.id]);
    if (!ingRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Matching batch ingredient row missing — re-create the batch recipe' });
    }
    const batchIngredientId = ingRes.rows[0].id;

    // Update the batch ingredient's stock + cost (weighted avg of recent
    // make would be ideal; for v1 we just snap to latest make cost, which
    // is what most kitchens want for forward-looking menu costing).
    await client.query(
      `UPDATE ingredients SET current_stock = current_stock + $1, cost_per_unit = $2, updated_at = NOW() WHERE id = $3`,
      [outQty, costPerUnit, batchIngredientId],
    );

    // Compute expires_on. shelf_life_days is INCLUSIVE — made today,
    // 3-day shelf life → expires_on = today + 3.
    // SEPOS-046ac — computed in JS: the old `($3 || ' days')::INTERVAL`
    // is PG-only and made every batch make 500 on desktop SQLite installs.
    const shelfDays = br.shelf_life_days || 3;
    const expiresOn = new Date(Date.now() + shelfDays * 86400000).toISOString().slice(0, 10);
    const batchRes = await client.query(
      `INSERT INTO batches
         (batch_recipe_id, ingredient_id, made_on, expires_on,
          original_quantity, locked_cost_per_unit, status, made_by, notes)
       VALUES ($1,$2,CURRENT_DATE,$3,
               $4,$5,'active',$6,$7) RETURNING *`,
      [br.id, batchIngredientId, expiresOn, outQty, costPerUnit, made_by || null, notes || null],
    );

    // Log a positive movement on the batch ingredient too, so the stock
    // movements report shows "5kg batch produced".
    await client.query(
      `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
       VALUES ($1, 'batch_made', $2, $3, $4, $5)`,
      [batchIngredientId, outQty, costPerUnit, `Made batch #${batchRes.rows[0].id} of ${br.name}`, `batch:${batchRes.rows[0].id}`],
    );

    await client.query('COMMIT');
    res.status(201).json({ batch: batchRes.rows[0], total_cost: totalCost, cost_per_unit: costPerUnit });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batches] make', err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Discard a batch. quantity defaults to the full original — chef can
// override if they used some before throwing the rest out.
app.post('/api/batches/:id/discard', async (req, res) => {
  const client = await pool.connect();
  try {
    const { quantity, reason, discarded_by } = req.body || {};
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM batches WHERE id=$1 FOR UPDATE`, [req.params.id]);
    const b = r.rows[0];
    if (!b) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Batch not found' }); }
    if (b.status === 'discarded') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already discarded' }); }

    const discardQty = Number(quantity != null ? quantity : b.original_quantity);
    const cost       = Number(b.locked_cost_per_unit || 0);

    // Subtract from the batch ingredient's stock (don't go below 0)
    await client.query(
      `UPDATE ingredients SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW() WHERE id = $2`,
      [discardQty, b.ingredient_id],
    );
    // Wastage log — uses the same 'waste' movement_type wastage reports already read
    await client.query(
      `INSERT INTO stock_movements (ingredient_id, movement_type, quantity, cost_at_time, note, reference)
       VALUES ($1, 'waste', $2, $3, $4, $5)`,
      [b.ingredient_id, -discardQty, cost, `Batch #${b.id} discarded${reason ? ` — ${reason}` : ''}`, `batch:${b.id}`],
    );
    await client.query(
      `UPDATE batches SET status='discarded', discarded_qty=$1, discarded_at=NOW(), discarded_by=$2, notes=COALESCE(notes||' / ','') || $3 WHERE id=$4`,
      [discardQty, discarded_by || null, reason || 'discarded', b.id],
    );
    await client.query('COMMIT');
    res.json({ success: true, discarded_qty: discardQty, cost_lost: +(discardQty * cost).toFixed(2) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[batches] discard', err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Extend a batch by 1 day. Useful when the chef judges it's still good
// past the system's shelf-life estimate. Capped at +3 extensions to
// avoid indefinitely deferring a real waste.
app.post('/api/batches/:id/extend', async (req, res) => {
  try {
    const r = await pool.query(`SELECT expires_on, extended_count FROM batches WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Batch not found' });
    if ((r.rows[0].extended_count || 0) >= 3) return res.status(400).json({ error: 'Already extended 3 times — discard if past use' });
    // SEPOS-046ac — +1 day computed in JS (PG-only INTERVAL 500'd on SQLite).
    // SEPOS-047j — but `new Date(dateValue).getTime() + 86400000` then
    // toISOString() was a NO-OP on cloud Postgres during BST: pg parses a
    // DATE column at LOCAL midnight, so '2026-06-14' → 2026-06-13T23:00:00Z,
    // +24h → 2026-06-14T23:00:00Z, and .slice(0,10) yields '2026-06-14' —
    // the SAME date (while still burning one of the 3 allowed extensions).
    // Fix: read the Y/M/D components (local for a pg Date, or the leading 10
    // chars for a SQLite string) and add a day in pure UTC so no timezone
    // can collapse it.
    const raw = r.rows[0].expires_on;
    const ymd = raw instanceof Date
      ? `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`
      : String(raw).slice(0, 10);
    const [yy, mm, dd] = ymd.split('-').map(Number);
    const nextExpiry = new Date(Date.UTC(yy, mm - 1, dd + 1)).toISOString().slice(0, 10);
    const u = await pool.query(
      `UPDATE batches
         SET expires_on = $1,
             status = 'active',
             extended_count = COALESCE(extended_count, 0) + 1
       WHERE id = $2 RETURNING *`,
      [nextExpiry, req.params.id],
    );
    res.json({ success: true, batch: u.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
// SEPOS-034 / SEPOS-040 — Online takeaway ordering + real Stripe payment
// Each restaurant's own STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY go in
// their Railway env. If not set the widget falls back to demo/mock mode.
// ─────────────────────────────────────────────────────────────────────

// Public settings the widget needs — opening hours + restaurant name —
// without leaking the rest of restaurant_settings.
// SEPOS-047 — kitchen-load wait time. Widget hits this on load to show
// the busy chip ("🟢 Quiet · 20 min") and to learn what pickup_time to
// stamp when the customer hits Place Order (no picker on the widget).
//
// Backlog = count of OPEN orders (one ticket per order, not per item) —
// matches operator mental model of "how many tickets is the kitchen
// working on right now". Dine-in tables + takeaway count equally.
//
// Tiers: backlog < busy_threshold → 'quiet'
//        backlog < very_busy_threshold → 'busy'
//        otherwise → 'very_busy'
app.get('/api/takeaway/availability', widgetCors, async (req, res) => {
  try {
    const restaurantId = resolveRestaurantId(req);
    const [settingsRes, backlogRes] = await Promise.all([
      pool.query(
        `SELECT takeaway_busy_threshold, takeaway_very_busy_threshold,
                takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy
           FROM restaurant_settings WHERE restaurant_id = $1`,
        [restaurantId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM orders
          WHERE restaurant_id = $1 AND status = 'open'`,
        [restaurantId]
      ),
    ]);
    const s = settingsRes.rows[0] || {};
    const busyN     = Number(s.takeaway_busy_threshold      ?? 5);
    const veryBusyN = Number(s.takeaway_very_busy_threshold ?? 10);
    const waitQ     = Number(s.takeaway_wait_quiet          ?? 20);
    const waitB     = Number(s.takeaway_wait_busy           ?? 35);
    const waitV     = Number(s.takeaway_wait_very_busy      ?? 50);
    const backlog   = Number(backlogRes.rows[0]?.n || 0);
    let tier, wait_minutes;
    if      (backlog < busyN)     { tier = 'quiet';     wait_minutes = waitQ; }
    else if (backlog < veryBusyN) { tier = 'busy';      wait_minutes = waitB; }
    else                          { tier = 'very_busy'; wait_minutes = waitV; }
    const pickup_iso = new Date(Date.now() + wait_minutes * 60000).toISOString();
    res.json({ tier, wait_minutes, pickup_iso, backlog });
  } catch (err) {
    console.error('GET /api/takeaway/availability', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/takeaway/settings', widgetCors, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT restaurant_name, opening_time, last_booking_time,
             service_type, lunch_service_start, lunch_service_end,
             dinner_service_start, dinner_service_end
      FROM restaurant_settings WHERE restaurant_id = $1
    `, [resolveRestaurantId(req)]);
    // SEPOS-DELIVERY-002 — delivery is offered only when the operator has
    // set both a restaurant postcode and a radius. The widget uses this
    // flag to decide whether to show the Delivery toggle at all.
    const dr = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('restaurant_postcode','delivery_radius_miles')`
    );
    const cfg = {};
    dr.rows.forEach(row => { cfg[row.key] = row.value; });
    const deliveryEnabled = !!(cfg.restaurant_postcode && Number(cfg.delivery_radius_miles) > 0);
    res.json({
      ...(r.rows[0] || {}),
      delivery_enabled: deliveryEnabled,
      delivery_radius_miles: deliveryEnabled ? Number(cfg.delivery_radius_miles) : 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-040 stripe-config + payment-intent routes live further down
// (search "SEPOS-040 — Stripe payment on the takeaway widget"). An
// earlier unhardened duplicate pair used to sit HERE and shadowed the
// hardened pair below it (Express matches in declaration order) — the
// £500 cap, 50p minimum and restaurant_id metadata were all dead code.
// Removed in SEPOS-047b; same bug class as SEPOS-046ae.

// SEPOS-DELIVERY-002 — postcode radius check for the takeaway widget.
// Resolves the customer postcode + the restaurant postcode to lat/lng
// via postcodes.io (free, no API key), measures the great-circle
// distance, and compares it to the operator's delivery_radius_miles.
//
// The restaurant's resolved coordinates are cached in-process keyed by
// the postcode string so repeated checks don't re-hit postcodes.io for
// the (unchanging) restaurant location.
let _restaurantGeoCache = { postcode: null, lat: null, lng: null };

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // mean earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodePostcode(postcode) {
  const clean = String(postcode || '').trim();
  if (!clean) return null;
  const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return null;  // 404 = postcode not found
  const j = await r.json();
  if (!j || !j.result) return null;
  return { lat: j.result.latitude, lng: j.result.longitude };
}

app.get('/api/takeaway/delivery-check', widgetCors, async (req, res) => {
  try {
    const postcode = String(req.query.postcode || '').trim();
    if (!postcode) return res.status(400).json({ deliverable: false, error: 'Postcode required' });

    // Operator config.
    const cfgRes = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('restaurant_postcode','delivery_radius_miles')`
    );
    const cfg = {};
    cfgRes.rows.forEach(row => { cfg[row.key] = row.value; });
    const restaurantPostcode = (cfg.restaurant_postcode || '').trim();
    const radiusMiles = Number(cfg.delivery_radius_miles) || 0;
    if (!restaurantPostcode || radiusMiles <= 0) {
      return res.json({ deliverable: false, error: 'Delivery is not available from this restaurant.' });
    }

    // Resolve the restaurant location (cached).
    if (_restaurantGeoCache.postcode !== restaurantPostcode) {
      const g = await geocodePostcode(restaurantPostcode);
      if (!g) return res.status(500).json({ deliverable: false, error: 'Restaurant postcode is misconfigured — contact the restaurant.' });
      _restaurantGeoCache = { postcode: restaurantPostcode, lat: g.lat, lng: g.lng };
    }

    // Resolve the customer postcode.
    const cust = await geocodePostcode(postcode);
    if (!cust) {
      return res.json({ deliverable: false, error: "We couldn't find that postcode — please check it." });
    }

    const distance = haversineMiles(
      _restaurantGeoCache.lat, _restaurantGeoCache.lng, cust.lat, cust.lng
    );
    const distanceRounded = Math.round(distance * 10) / 10;
    res.json({
      deliverable: distance <= radiusMiles,
      distance_miles: distanceRounded,
      radius_miles: radiusMiles,
    });
  } catch (err) {
    console.error('GET /api/takeaway/delivery-check error:', err);
    res.status(500).json({ deliverable: false, error: 'Could not check your postcode — please try again.' });
  }
});

// Submit a takeaway order from the public widget.
app.post('/api/takeaway/orders', widgetCors, requireActiveSubscription, requireValidLicense, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name, customer_phone, customer_email,
      // SEPOS-047 — pickup_time is now optional. When missing, the server
      // computes it from current kitchen backlog (same logic as the
      // /api/takeaway/availability endpoint). Keeping the optional input
      // means staff / admin tools can still place a takeaway at a chosen
      // time without going through the load-aware widget flow.
      pickup_time: pickup_time_input,
      items = [],     // [{ menu_item_id, quantity, unit_price, name, item_note }]
      notes,
      marketing_consent,
      // SEPOS-DELIVERY-002 — collection (default) vs delivery.
      order_subtype = 'collection',
      delivery_address,
      delivery_notes,
      // SEPOS-040 — real Stripe payment. Absent in demo/mock mode.
      payment_intent_id,
    } = req.body;
    let pickup_time = pickup_time_input;

    if (!customer_name || !customer_name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!customer_phone || !customer_phone.trim()) return res.status(400).json({ error: 'Phone is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
    // pickup_time is optional — server-side computation happens after
    // restaurant_id is resolved below.
    // Normalise + validate the subtype. Delivery requires an address.
    const subtype = order_subtype === 'delivery' ? 'delivery' : 'collection';
    if (subtype === 'delivery' && (!delivery_address || !delivery_address.trim())) {
      return res.status(400).json({ error: 'Delivery address is required for delivery orders' });
    }

    // SEPOS-040 — if a payment_intent_id was submitted, verify with Stripe
    // before touching the DB. This prevents orders being created for failed
    // or tampered payments.
    let paymentStatus = 'mock';
    let verifiedPaymentIntentId = null;
    let verifiedPaymentPence = null;
    if (payment_intent_id) {
      if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(400).json({ error: 'Stripe not configured — cannot verify payment' });
      }
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
        if (pi.status !== 'succeeded') {
          return res.status(402).json({ error: `Payment not completed (${pi.status})` });
        }
        // SEPOS-047b — the amount itself is verified against the
        // server-priced order total further down, once it's computed.
        if (pi.currency !== 'gbp') {
          return res.status(402).json({ error: 'Payment currency mismatch' });
        }
        paymentStatus = 'paid';
        verifiedPaymentIntentId = pi.id;
        verifiedPaymentPence = pi.amount;
      } catch (stripeErr) {
        console.error('[takeaway] Stripe verify error:', stripeErr.message);
        return res.status(402).json({ error: 'Could not verify payment — please try again.' });
      }
    }

    // Closed-hours check — pickup_time must fall within the restaurant's
    // operating windows. Honours service_type: all-day restaurants validate
    // against opening_time..last_booking_time, split-service restaurants
    // require pickup inside either the lunch window OR the dinner window
    // (so the 14:30-17:30 closure gap rejects orders, not silently accepts).
    // Soft validation: if restaurant_settings is missing we let it through.
    const restaurantId = resolveRestaurantId(req);
    const settingsRes = await client.query(
      `SELECT service_type, opening_time, last_booking_time,
              lunch_service_start, lunch_service_end,
              dinner_service_start, dinner_service_end,
              takeaway_busy_threshold, takeaway_very_busy_threshold,
              takeaway_wait_quiet, takeaway_wait_busy, takeaway_wait_very_busy,
              timezone
         FROM restaurant_settings WHERE restaurant_id = $1`,
      [restaurantId]
    );

    // SEPOS-047 — load-aware pickup_time. If the widget didn't send one
    // (new flow), compute it from current kitchen backlog. Keeps the
    // server as the source of truth so a stale widget can't underquote.
    if (!pickup_time) {
      const s = settingsRes.rows[0] || {};
      const busyN     = Number(s.takeaway_busy_threshold      ?? 5);
      const veryBusyN = Number(s.takeaway_very_busy_threshold ?? 10);
      const waitQ     = Number(s.takeaway_wait_quiet          ?? 20);
      const waitB     = Number(s.takeaway_wait_busy           ?? 35);
      const waitV     = Number(s.takeaway_wait_very_busy      ?? 50);
      const backlogRes = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM orders
          WHERE restaurant_id = $1 AND status = 'open'`,
        [restaurantId]
      );
      const backlog = Number(backlogRes.rows[0]?.n || 0);
      const waitMinutes = backlog < busyN ? waitQ : backlog < veryBusyN ? waitB : waitV;
      pickup_time = new Date(Date.now() + waitMinutes * 60000).toISOString();
    }
    const settings = settingsRes.rows[0];
    if (settings) {
      const pickupDate = new Date(pickup_time);
      if (isNaN(pickupDate.getTime())) return res.status(400).json({ error: 'Invalid pickup time' });
      // SEPOS-048 — compare pickup against opening hours in the RESTAURANT's
      // timezone, not the Node process's. Otherwise Railway-UTC sees London
      // 02:00 BST as 01:00 and silently flips the dinner-window check.
      const tz = settings.timezone || 'Europe/London';
      const mins = minutesInZone(pickupDate, tz);
      const hhmm = (t) => String(t || '').slice(0, 5);
      // Handle windows that wrap past midnight (e.g. 17:30–07:30 for
      // late-night service). Normal window: end >= start, simple range.
      // Wrapped window: end < start, match anywhere from start onward
      // OR up to end the following morning.
      const inWindow = (start, end) => {
        const s = toMins(start);
        const e = toMins(end);
        if (e >= s) return mins >= s && mins <= e;
        return mins >= s || mins <= e;
      };
      if (settings.service_type === 'split') {
        const okLunch  = inWindow(settings.lunch_service_start  || '11:00', settings.lunch_service_end  || '14:30');
        const okDinner = inWindow(settings.dinner_service_start || '17:30', settings.dinner_service_end || '21:30');
        if (!okLunch && !okDinner) {
          return res.status(400).json({
            error: `Pickup time must be ${hhmm(settings.lunch_service_start)}–${hhmm(settings.lunch_service_end)} or ${hhmm(settings.dinner_service_start)}–${hhmm(settings.dinner_service_end)}.`,
          });
        }
      } else {
        if (!inWindow(settings.opening_time || '11:00', settings.last_booking_time || '21:30')) {
          return res.status(400).json({
            error: `Pickup time must be between ${hhmm(settings.opening_time)} and ${hhmm(settings.last_booking_time)}.`,
          });
        }
      }
    }

    // SEPOS-047b — price every line from menu_items, NOT from the
    // client-sent unit_price (which a tampered widget controls; same
    // class as the dine-in BUG-EPOS-002 fix). The takeaway widget has
    // no priced modifiers, so menu price × quantity is the exact total.
    const menuIds = [...new Set(items.map(i => Number(i.menu_item_id)).filter(Boolean))];
    if (menuIds.length === 0 || items.some(i => !Number(i.menu_item_id))) {
      return res.status(400).json({ error: 'Invalid cart — please refresh the menu and try again' });
    }
    const priceRes = await client.query(
      `SELECT id, name, price, is_available FROM menu_items WHERE id = ANY($1)`,
      [menuIds]
    );
    const priceById = new Map(priceRes.rows.map(r => [Number(r.id), r]));
    let total = 0;
    for (const it of items) {
      const mi = priceById.get(Number(it.menu_item_id));
      if (!mi) return res.status(400).json({ error: `"${it.name || 'An item'}" is no longer on the menu — please refresh and try again` });
      if (Number(mi.is_available) === 0) {
        return res.status(400).json({ error: `"${mi.name}" is sold out — please remove it from your cart` });
      }
      it.server_price = Number(mi.price) || 0;
      // BUG-EPOS-MODPRICE — include chosen modifier surcharges (server-side
      // prices, anti-tamper), same as the dine-in add-items path.
      if (Array.isArray(it.modifiers) && it.modifiers.length) {
        for (const m of it.modifiers) {
          if (!m) continue;
          if (m.id != null) {
            const mr = await pool.query('SELECT extra_price FROM modifiers WHERE id = $1', [m.id]);
            it.server_price += Number(mr.rows[0]?.extra_price ?? m.extra_price ?? 0) || 0;
          } else {
            it.server_price += Number(m.extra_price) || 0;
          }
        }
      }
      total += it.server_price * (Number(it.quantity) || 1);
    }

    // SEPOS-047b — the paid amount must match the server-priced total.
    // A mismatch means menu prices changed mid-checkout or the widget
    // was tampered with; either way the order must not land as 'paid'.
    if (verifiedPaymentIntentId !== null && verifiedPaymentPence !== Math.round(total * 100)) {
      console.warn(`[takeaway] PI ${verifiedPaymentIntentId} amount ${verifiedPaymentPence}p != order total ${Math.round(total * 100)}p — rejected`);
      return res.status(402).json({ error: 'Payment amount does not match the order total — please refresh and try again' });
    }

    await client.query('BEGIN');

    // SEPOS-047b — one PaymentIntent settles exactly one order. Backed
    // by a unique partial index on orders.payment_intent_id; this check
    // gives a friendly error instead of a raw constraint violation.
    if (verifiedPaymentIntentId) {
      const dup = await client.query(
        `SELECT id FROM orders WHERE payment_intent_id = $1`,
        [verifiedPaymentIntentId]
      );
      if (dup.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This payment has already been used for another order' });
      }
    }
    // SEPOS-046g — customer_note column replaces the discount_reason
    // misuse that polluted Z / Trading reports. Legacy data in existing
    // discount_reason cells is left intact; only new orders go in the
    // right place.
    const orderRes = await client.query(
      `INSERT INTO orders
         (table_id, status, covers, total, opened_at,
          order_type, customer_name, customer_phone, customer_email,
          pickup_time, takeaway_status, payment_status, payment_intent_id, customer_note,
          order_subtype, delivery_address, delivery_notes, marketing_consent,
          restaurant_id)
       VALUES (NULL, 'open', 1, $1, NOW(),
               'takeaway', $2, $3, $4,
               $5, 'pending', $6, $7, $8,
               $9, $10, $11, $12, $13)
       RETURNING id`,
      [total, customer_name.trim(), customer_phone.trim(), (customer_email || '').trim() || null,
       pickup_time, paymentStatus, verifiedPaymentIntentId, notes || null,
       subtype,
       subtype === 'delivery' ? delivery_address.trim() : null,
       subtype === 'delivery' ? (delivery_notes || '').trim() || null : null,
       marketing_consent ? 1 : 0,
       restaurantId]
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
            item_note, is_fired, fired_at, cooking_started_at, status, restaurant_id)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 1, $8, $8, 'cooking', $9) RETURNING id`,
        [orderId, it.menu_item_id || null, it.name || 'Item',
         it.quantity || 1, it.server_price, // SEPOS-047b — server-priced, never client input
         it.modifiers ? (Array.isArray(it.modifiers) ? it.modifiers.map(m => m.name).join(', ') : String(it.modifiers)) : '',
         it.item_note || '', now, restaurantId]
      );
      insertedItemIds.push(ins.rows[0].id);
    }
    await client.query('COMMIT');

    // Stock depletion (best effort) — done outside the transaction so a
    // failure here doesn't roll back the order.
    try { await depleteStockForItems(insertedItemIds, 'sale'); } catch {}

    // SEPOS-DELIVERY-002 — marketing_consent is now persisted on the
    // order row itself; GET /api/customers reads it back so takeaway
    // customers flow into the CRM with the right consent flag.

    // Kitchen iPad listens to this — pops up the ticket instantly.
    io.emit('new_takeaway_order', {
      id: orderId,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      pickup_time,
      total,
      item_count: items.length,
      order_subtype: subtype,
      delivery_address: subtype === 'delivery' ? delivery_address.trim() : null,
      // SEPOS-046d — single order-level customer note ("no peanut",
      // "allergies: shellfish", "leave at door"). Surfaced on the
      // kitchen ticket so the chef sees it immediately.
      notes: notes || null,
    });

    // Fire-and-forget auto kitchen + bar print. Runs server-side (not
    // from the browser) so one print fires per order regardless of how
    // many tablets / Macs are open. Items are split by their category's
    // is_bar flag so drinks go to the bar printer and food to the
    // kitchen printer — matches the dine-in routing. Each printer call
    // honours its own copies setting (printer_kitchen_copies /
    // printer_bar_copies) inside printService.
    (async () => {
      try {
        const printSettings = await loadSettings();
        const mode = printSettings.kitchen_print_mode || 'print';

        // SEPOS-STATION-001 — resolve each item's target: its category's assigned
        // printer station, else the default (bar printer if is_bar, else kitchen).
        // Look up is_bar + printer_id per menu_item, and load active stations.
        const menuIds = items.map(it => it.menu_item_id).filter(Boolean);
        const metaById = new Map(); // menu_item_id -> { is_bar, printer_id }
        if (menuIds.length) {
          const rows = await pool.query(
            `SELECT mi.id, COALESCE(c.is_bar, 0) AS is_bar, c.printer_id
               FROM menu_items mi LEFT JOIN categories c ON mi.category_id = c.id
              WHERE mi.id = ANY($1)`,
            [menuIds]
          );
          rows.rows.forEach(r => metaById.set(r.id, { is_bar: Number(r.is_bar) === 1, printer_id: r.printer_id }));
        }
        const stationRows = (await pool.query('SELECT * FROM printers WHERE is_active = 1 AND ip IS NOT NULL').catch(() => ({ rows: [] }))).rows;
        const stationById = new Map(stationRows.map(p => [p.id, p]));

        const toPrintItem = (it) => ({
          course: 1,
          quantity: it.quantity || 1,
          name: it.name || 'Item',
          notes: it.modifiers
            ? (Array.isArray(it.modifiers) ? it.modifiers.map(m => m.name).join(', ') : String(it.modifiers))
            : '',
        });

        // Group items by target key: 'kitchen' | 'bar' | station:<id>.
        const groups = new Map(); // key -> { station|null, items[] }
        for (const it of items) {
          const meta = metaById.get(it.menu_item_id) || {};
          const station = meta.printer_id != null ? stationById.get(meta.printer_id) : null;
          const key = station ? `station:${station.id}` : (meta.is_bar ? 'bar' : 'kitchen');
          if (!groups.has(key)) groups.set(key, { station: station || null, items: [] });
          groups.get(key).items.push(toPrintItem(it));
        }

        const printOrder = {
          id: orderId,
          order_type: 'takeaway',
          order_subtype: subtype,
          customer_name: customer_name.trim(),
          customer_phone: (customer_phone || '').trim(),
          delivery_address: subtype === 'delivery' ? (delivery_address || '').trim() : null,
          notes: notes || null,
          table_number: null,
        };

        for (const [key, grp] of groups) {
          if (!grp.items.length) continue;
          if (grp.station) {
            // Assigned station (extra printer) — SEPOS-STATION-001.
            printService.printKitchenToPrinter(grp.station, printSettings, printOrder, grp.items)
              .then(() => console.log(`🖨️ Station "${grp.station.name}" auto-printed for takeaway #${orderId}`))
              .catch(err => console.error(`[takeaway] station "${grp.station.name}" print failed:`, err.message));
          } else if (key === 'bar') {
            // Default bar printer — unchanged path.
            if (printSettings.printer_bar_ip) {
              printService.printBarTicket(printSettings, printOrder, grp.items)
                .then(() => console.log(`🍹 Bar ticket auto-printed for takeaway #${orderId}`))
                .catch(err => console.error('[takeaway] bar print failed:', err.message));
            }
          } else {
            // Default kitchen printer — unchanged path (gated by kitchen_print_mode).
            if (mode !== 'kds' && (printSettings.printer_kitchen_ip || printSettings.printer_kitchen_name)) {
              printService.printFullKitchenTicket(printSettings, printOrder, grp.items)
                .then(() => console.log(`🖨️ Kitchen ticket auto-printed for takeaway #${orderId}`))
                .catch(err => console.error('[takeaway] kitchen print failed:', err.message));
            }
          }
        }
      } catch (err) {
        console.error('[takeaway] auto print setup failed:', err.message);
      }
    })();

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
      // SEPOS-047 — return the canonical pickup_time so the widget shows
      // the server-computed wait, not whatever it had cached.
      pickup_time,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/takeaway/orders error:', err);
    res.status(500).json({ error: 'Could not place order. Please try again.' });
  } finally {
    client.release();
  }
});

// ── SEPOS-040 — Stripe payment on the takeaway widget ──────────────
// The widget calls /api/takeaway/stripe-config on open to learn whether
// real Stripe is available (sets state.stripeConfigured + caches the
// publishable key). If yes, the widget mounts Stripe's PaymentElement —
// which auto-includes Apple Pay (iOS Safari) and Google Pay (Android
// Chrome) when the customer's device supports them, plus card form as
// fallback. The widget creates a PaymentIntent server-side just before
// confirm, then confirms client-side, then posts the order with the
// verified payment_intent_id.

app.get('/api/takeaway/stripe-config', widgetCors, async (req, res) => {
  // A restaurant can force mock/demo pay (no card field) even with Stripe keys
  // present, via the `takeaway_mock_pay` setting ('1'). Used for the sales-demo
  // tenant (Baan Siam) so any prospect can complete a takeaway order — the order
  // still reaches the till + sends the confirmation email, just no card charge —
  // regardless of ad blockers that block Stripe.js. Per-restaurant: real client
  // deployments (no flag) keep real Stripe untouched.
  let mock = false;
  try { const s = await loadSettings(); mock = String(s.takeaway_mock_pay || '') === '1'; } catch {}
  const configured = !mock && !!process.env.STRIPE_PUBLISHABLE_KEY && !!process.env.STRIPE_SECRET_KEY;
  res.json({
    configured,
    publishable_key: configured ? (process.env.STRIPE_PUBLISHABLE_KEY || null) : null,
  });
});

app.post('/api/takeaway/payment-intent', widgetCors, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured on this restaurant. Please ask the restaurant to switch to demo mode.' });
  }
  const amountPence = Number(req.body?.amount_pence);
  const description = String(req.body?.order_description || 'Takeaway order').slice(0, 200);
  if (!Number.isInteger(amountPence) || amountPence < 50) {
    return res.status(400).json({ error: 'Invalid amount (minimum 50p)' });
  }
  if (amountPence > 50000) {
    // £500 sanity cap — defends against widget tampering before customer
    // checks out. Real maximum is the restaurant's menu price total.
    return res.status(400).json({ error: 'Amount too large for online takeaway' });
  }
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.create({
      amount:   amountPence,
      currency: 'gbp',
      description,
      // automatic_payment_methods is what unlocks Apple Pay + Google Pay
      // (and Klarna / Link / whatever else the restaurant enabled in
      // their Stripe dashboard) — alongside card.
      automatic_payment_methods: { enabled: true },
      metadata: {
        product:       'siamepos_takeaway',
        restaurant_id: resolveRestaurantId(req),
      },
    });
    res.json({
      client_secret:     pi.client_secret,
      payment_intent_id: pi.id,
    });
  } catch (err) {
    console.error('[stripe] takeaway payment-intent', err);
    res.status(500).json({ error: err.message });
  }
});

// Apple Pay domain verification — Stripe gives the restaurant a
// specific file content when they register their domain in the Stripe
// dashboard. We serve it from the env var so each per-client Railway
// deployment can set its own value (verification is per-domain).
// Without this, Apple Pay button never appears on iOS Safari even
// though the device supports it.
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  const content = process.env.STRIPE_APPLE_PAY_DOMAIN_FILE;
  if (!content) {
    return res.status(404).type('text/plain').send('Apple Pay not configured for this domain');
  }
  res.type('text/plain').send(content);
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
        AND o.status NOT IN ('closed', 'cancelled')
        AND o.table_id IS NULL
      ORDER BY o.pickup_time ASC NULLS LAST, o.id ASC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEPOS-VOUCHER-001 — Gift voucher endpoints ─────────────────────
const voucherSvc = require('./services/voucherService');

// Public — widget config (min/max/expiry + publishable key if Stripe set)
app.get('/api/widget/voucher/config', widgetCors, (req, res) => {
  res.json({
    min:                 voucherSvc.VOUCHER_MIN_AMOUNT,
    max:                 voucherSvc.VOUCHER_MAX_AMOUNT,
    expiry_months:       voucherSvc.VOUCHER_EXPIRY_MONTHS,
    stripe_publishable:  process.env.STRIPE_PUBLISHABLE_KEY || null,
    stripe_enabled:      !!process.env.STRIPE_SECRET_KEY,
    restaurant_name:     process.env.RESTAURANT_NAME || 'SiamEPOS Restaurant',
  });
});

// Public — create the Stripe PI (or mock PI). Doesn't create the voucher
// yet; the voucher is born on /confirm once payment verifies, so failed
// purchases don't leave phantom vouchers in the DB.
app.post('/api/widget/voucher/purchase', widgetCors, async (req, res) => {
  try {
    const v = voucherSvc.validateAmount(req.body?.amount);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const pi = await voucherSvc.createPaymentIntent(v.amount);
    res.json({ ...pi, amount: v.amount });
  } catch (err) {
    console.error('[voucher] purchase', err);
    res.status(500).json({ error: err.message });
  }
});

// Public — verify payment + create voucher + fire gift email
app.post('/api/widget/voucher/confirm', widgetCors, async (req, res) => {
  try {
    const {
      payment_intent_id, amount,
      recipient_name, recipient_email, sender_name, message, delivery_date,
    } = req.body || {};
    const v = voucherSvc.validateAmount(amount);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const verify = await voucherSvc.verifyPaymentIntent(payment_intent_id, v.amount);
    if (!verify.ok) return res.status(402).json({ error: verify.error });
    // Re-trust server's amount_paid over client's amount — defends
    // against the client submitting a £500 PI then asking for a £1000
    // voucher in /confirm.
    if (Math.abs(verify.amount_paid - v.amount) > 0.01) {
      return res.status(400).json({ error: `Paid amount (£${verify.amount_paid}) doesn't match voucher amount (£${v.amount})` });
    }

    // Ensure unique code (collision astronomical, but loop a few times)
    let code;
    for (let i = 0; i < 10; i++) {
      code = voucherSvc.generateCode();
      const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    const expires = voucherSvc.defaultExpiryDate();
    const rid = resolveRestaurantId(req);
    const result = await pool.query(
      `INSERT INTO vouchers
         (code, original_amount, balance, recipient_name, recipient_email,
          sender_name, message, delivery_date, expires_at,
          payment_method, stripe_payment_intent_id, restaurant_id)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [code, v.amount,
       recipient_name || null, recipient_email || null,
       sender_name || null, message || null,
       delivery_date || null, expires,
       verify.mode === 'mock' ? 'mock' : 'stripe',
       payment_intent_id, rid],
    );
    const voucher = result.rows[0];

    // Fire-and-forget gift email. If delivery_date is today/past we send
    // now; future dates are also sent immediately for v1 (no scheduler
    // yet — recipient can read it now and use it any time before expiry).
    if (voucher.recipient_email) {
      voucherSvc.sendVoucherGiftEmail(voucher, { baseUrl: `${req.protocol}://${req.get('host')}` })
        .then(async (r) => {
          if (r && r.ok) {
            await pool.query('UPDATE vouchers SET email_sent_at = NOW() WHERE id = $1', [voucher.id]);
          }
        })
        .catch((e) => console.error('[voucher] gift email failed', e));
    }

    res.status(201).json({
      voucher: { ...voucher, balance: Number(voucher.balance), original_amount: Number(voucher.original_amount) },
    });
  } catch (err) {
    console.error('[voucher] confirm', err);
    res.status(500).json({ error: err.message });
  }
});

// Public-ish — lookup by code. Used by widget success screen + EPOS
// redemption modal to preview balance before applying.
app.get('/api/widget/voucher/:code', widgetCors, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });
    const r = await pool.query('SELECT * FROM vouchers WHERE code = $1', [code]);
    const v = r.rows[0];
    if (!v) return res.status(404).json({ error: 'Voucher not found' });
    // Auto-expire on read
    if (v.status === 'active' && voucherSvc.isExpired(v.expires_at)) {
      await pool.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [v.id]);
      v.status = 'expired';
    }
    res.json({
      code: v.code,
      original_amount: Number(v.original_amount),
      balance:         Number(v.balance),
      expires_at:      v.expires_at,
      status:          v.status,
      recipient_name:  v.recipient_name,
      type:            v.type || 'gift',            // SEPOS-DEPOSIT-001 — gift vs deposit
      reservation_id:  v.reservation_id ?? null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEPOS-WALLET-001 — Apple Wallet pass download. Returns a signed
// .pkpass for the voucher; the recipient's iPhone (or Mac Safari)
// recognises the MIME type and offers "Add to Wallet". Open to anyone
// holding the code — guessing it is computationally infeasible
// (32^8 ≈ 1.1 × 10^12 combinations).
const voucherWalletPass = require('./services/voucherWalletPass');
app.get('/api/widget/voucher/:code/wallet-pass', widgetCors, async (req, res) => {
  try {
    if (!voucherWalletPass.isConfigured()) {
      return res.status(503).json({ error: 'Wallet pass not configured on server' });
    }
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });

    const r = await pool.query('SELECT * FROM vouchers WHERE code = $1', [code]);
    const v = r.rows[0];
    if (!v) return res.status(404).json({ error: 'Voucher not found' });
    if (v.status === 'active' && voucherSvc.isExpired(v.expires_at)) {
      await pool.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [v.id]);
      v.status = 'expired';
    }
    if (v.status !== 'active') {
      return res.status(410).json({ error: `Voucher is ${v.status}` });
    }

    const buf = await voucherWalletPass.buildVoucherPass(v);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename="${code}.pkpass"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err) {
    console.error('[voucher] wallet-pass', err);
    res.status(500).json({ error: err.message });
  }
});

// EPOS — redeem against a bill. Atomic decrement under FOR UPDATE so two
// terminals can't double-spend the same voucher. Returns the new balance
// + amount_used so the caller can compose the discount line.
app.post('/api/vouchers/:code/redeem', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const { amount, bill_id, redeemed_by } = req.body || {};
  const amtNum = Number(amount);
  if (!amtNum || amtNum <= 0) return res.status(400).json({ error: 'amount required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM vouchers WHERE code = $1 FOR UPDATE', [code]);
    const v = rows[0];
    if (!v) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Voucher not found' }); }
    if (v.status !== 'active') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Voucher is ${v.status}` }); }
    if (voucherSvc.isExpired(v.expires_at)) {
      await client.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [v.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Voucher has expired' });
    }
    const deduct       = Math.min(amtNum, Number(v.balance));
    const newBalance   = +(Number(v.balance) - deduct).toFixed(2);
    const newStatus    = newBalance <= 0 ? 'depleted' : 'active';
    await client.query(
      'UPDATE vouchers SET balance = $1, status = $2 WHERE id = $3',
      [newBalance, newStatus, v.id],
    );
    const r = await client.query(
      `INSERT INTO voucher_redemptions
         (voucher_id, bill_id, amount_used, redeemed_by, restaurant_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [v.id, bill_id || null, deduct, redeemed_by || null, v.restaurant_id],
    );
    await client.query('COMMIT');
    res.json({
      redemption:   r.rows[0],
      amount_used:  deduct,
      balance:      newBalance,
      voucher_code: v.code,
      depleted:     newBalance <= 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[voucher] redeem', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// SEPOS-VOUCHER-REMOVE-001 — undo a partial voucher redemption while the
// bill is still open. Restores voucher balance + clears the discount row
// on the order. Refuses to act on closed bills (those need a proper
// refund/reverse flow which v1 leaves to admin).
app.post('/api/orders/:id/voucher-remove', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderId = req.params.id;
    // SEPOS-DEPOSIT-001 fix — a bill can now carry BOTH a voucher AND a deposit
    // redemption (both write voucher_redemptions rows). Restoring "most-recent"
    // would credit back the wrong one. When the caller names a specific code,
    // restore THAT redemption; otherwise keep the legacy most-recent behaviour.
    const targetCode = (req.body && req.body.code) ? String(req.body.code).trim().toUpperCase() : null;

    // Bill must still be open — undoing a closed bill needs a different
    // flow (refund payment + reopen) so we punt that to admin.
    const ord = await client.query('SELECT id, status, discount_reason FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = ord.rows[0];
    if (!order)             { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (order.status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Bill is already closed — use refund flow' }); }

    // Find the redemption to undo — the named code's if given, else most-recent.
    const r = await client.query(
      `SELECT vr.id, vr.voucher_id, vr.amount_used, v.code, v.status AS voucher_status
       FROM voucher_redemptions vr
       JOIN vouchers v ON v.id = vr.voucher_id
       WHERE vr.bill_id = $1 ${targetCode ? 'AND UPPER(v.code) = $2' : ''}
       ORDER BY vr.used_at DESC LIMIT 1`,
      targetCode ? [orderId, targetCode] : [orderId]
    );
    const vr = r.rows[0];
    if (!vr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No voucher on this bill' }); }

    // Restore voucher balance + bring it back from depleted if needed.
    await client.query(
      `UPDATE vouchers
         SET balance = balance + $1,
             status  = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
       WHERE id = $2`,
      [vr.amount_used, vr.voucher_id]
    );

    // Drop the redemption row.
    await client.query('DELETE FROM voucher_redemptions WHERE id = $1', [vr.id]);

    // Clear the discount on the order — but only if it's THIS voucher's
    // discount (defends against a stray non-voucher discount being wiped).
    if (order.discount_reason && order.discount_reason.startsWith(`Voucher ${vr.code}`)) {
      await client.query(
        `UPDATE orders SET discount_type = NULL, discount_value = NULL, discount_reason = NULL WHERE id = $1`,
        [orderId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, restored: Number(vr.amount_used), voucher_code: vr.code });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[voucher] remove', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin — list (auto-expires any active+past while reading)
app.get('/api/vouchers', async (req, res) => {
  try {
    const { q, status } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (code ILIKE $${params.length} OR recipient_email ILIKE $${params.length} OR recipient_name ILIKE $${params.length} OR sender_name ILIKE $${params.length})`;
    }
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const r = await pool.query(`SELECT * FROM vouchers ${where} ORDER BY created_at DESC LIMIT 500`, params);
    // Auto-expire pass — cheap because the index on status filters fast
    const toExpire = r.rows.filter(v => v.status === 'active' && voucherSvc.isExpired(v.expires_at));
    if (toExpire.length > 0) {
      await pool.query(`UPDATE vouchers SET status = 'expired' WHERE id = ANY($1::int[])`, [toExpire.map(v => v.id)]);
      toExpire.forEach(v => { v.status = 'expired'; });
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin — voucher detail + redemption history
app.get('/api/vouchers/:id', async (req, res) => {
  try {
    const v = await pool.query('SELECT * FROM vouchers WHERE id = $1', [req.params.id]);
    if (!v.rows[0]) return res.status(404).json({ error: 'not found' });
    const r = await pool.query(
      `SELECT vr.*, s.name AS redeemed_by_name
       FROM voucher_redemptions vr
       LEFT JOIN staff s ON s.id = vr.redeemed_by
       WHERE vr.voucher_id = $1
       ORDER BY vr.used_at DESC`,
      [req.params.id],
    );
    res.json({ voucher: v.rows[0], redemptions: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin — soft-void (manager-PIN gated by frontend; backend trusts staff_id)
app.post('/api/vouchers/:id/void', async (req, res) => {
  try {
    const { voided_by } = req.body || {};
    const r = await pool.query(
      `UPDATE vouchers SET status = 'voided', voided_by = $1, voided_at = NOW()
       WHERE id = $2 AND status IN ('active','depleted') RETURNING *`,
      [voided_by || null, req.params.id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Voucher not found or already voided/expired' });
    res.json({ voucher: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin — at-till voucher sale. Customer walks in wanting to buy a £50
// gift voucher with cash/card. No Stripe involved — payment is taken at
// the EPOS till the same way Cash/Card on a normal order is. The voucher
// row records payment_method='cash' or 'card' so the Z-Report shows
// it as on-till revenue (not the off-till Stripe block).
app.post('/api/vouchers/sell', async (req, res) => {
  try {
    const {
      amount, payment_method,
      recipient_name, recipient_email, sender_name, message, delivery_date,
      sold_by,
    } = req.body || {};
    const v = voucherSvc.validateAmount(amount);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const method = String(payment_method || '').toLowerCase();
    if (!['cash', 'card'].includes(method)) {
      return res.status(400).json({ error: 'payment_method must be cash or card' });
    }
    let code;
    for (let i = 0; i < 10; i++) {
      code = voucherSvc.generateCode();
      const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    const expires = voucherSvc.defaultExpiryDate();
    const rid = resolveRestaurantId(req);
    const result = await pool.query(
      `INSERT INTO vouchers
         (code, original_amount, balance, recipient_name, recipient_email,
          sender_name, message, delivery_date, expires_at,
          payment_method, restaurant_id)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code, v.amount,
       recipient_name || null, recipient_email || null,
       sender_name || null, message || null,
       delivery_date || null, expires,
       method, rid],
    );
    const voucher = result.rows[0];
    if (voucher.recipient_email) {
      voucherSvc.sendVoucherGiftEmail(voucher, { baseUrl: `${req.protocol}://${req.get('host')}` })
        .then(async (r) => {
          if (r && r.ok) await pool.query('UPDATE vouchers SET email_sent_at = NOW() WHERE id = $1', [voucher.id]);
        })
        .catch((e) => console.error('[voucher] gift email failed', e));
    }
    res.status(201).json({
      voucher: { ...voucher, balance: Number(voucher.balance), original_amount: Number(voucher.original_amount) },
    });
  } catch (err) {
    console.error('[voucher] sell', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin — resend gift email (operator-initiated, e.g. lost-in-spam)
app.post('/api/vouchers/:id/resend-email', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM vouchers WHERE id = $1', [req.params.id]);
    const v = r.rows[0];
    if (!v) return res.status(404).json({ error: 'not found' });
    if (!v.recipient_email) return res.status(400).json({ error: 'no recipient email on file' });
    const out = await voucherSvc.sendVoucherGiftEmail(v, { baseUrl: `${req.protocol}://${req.get('host')}` });
    if (out.ok) await pool.query('UPDATE vouchers SET email_sent_at = NOW() WHERE id = $1', [v.id]);
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEPOS-DEPOSIT-001 — booking deposits (typed vouchers) ──────────
// A deposit is a PREPAID TENDER: taken now, redeemed on the day against the
// bill's balance owed (never a discount). Stored as a vouchers row
// type='deposit' with a DEP- code, linked to a reservation, expiry =
// reservation date + 7 grace. Redemption reuses /api/vouchers/:code/redeem
// (the same atomic decrement + voucher_redemptions ledger as gift vouchers);
// the Bill screen applies it as a 'Deposit' tender. Phase A = manual create
// (deposit taken by phone / card machine); Stripe capture = Phase B (widget).
app.post('/api/deposits', async (req, res) => {
  try {
    const { amount, payment_method, reservation_id, customer_name, customer_email } = req.body || {};
    const v = voucherSvc.validateAmount(amount);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const method = String(payment_method || 'card').toLowerCase();
    if (!['cash', 'card', 'mock'].includes(method)) {
      return res.status(400).json({ error: 'payment_method must be cash, card or mock' });
    }
    // Expiry = reservation date + 7 days grace (fallback to default if unlinked).
    let expires = voucherSvc.defaultExpiryDate();
    let resId = reservation_id ? Number(reservation_id) : null;
    if (resId) {
      const rres = await pool.query('SELECT reservation_date FROM reservations WHERE id = $1', [resId]);
      const rdate = rres.rows[0]?.reservation_date;
      if (rdate) {
        const d = new Date(rdate); d.setDate(d.getDate() + 7);
        expires = d.toISOString().slice(0, 10);
      } else {
        resId = null; // unknown reservation → don't link a phantom id
      }
    }
    let code;
    for (let i = 0; i < 10; i++) {
      code = voucherSvc.generateCode('DEP-');
      const exists = await pool.query('SELECT id FROM vouchers WHERE code = $1', [code]);
      if (!exists.rows[0]) break;
    }
    const rid = resolveRestaurantId(req);
    const result = await pool.query(
      `INSERT INTO vouchers
         (code, original_amount, balance, recipient_name, recipient_email,
          expires_at, payment_method, restaurant_id, type, reservation_id, take_date)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'deposit',$8, CURRENT_DATE) RETURNING *`,
      [code, v.amount, customer_name || null, customer_email || null,
       expires, method, rid, resId],
    );
    const dep = result.rows[0];
    res.status(201).json({ ...dep, balance: Number(dep.balance), original_amount: Number(dep.original_amount) });
  } catch (err) {
    console.error('[deposit] create', err);
    res.status(500).json({ error: err.message });
  }
});

// Auto-suggest the active deposit for a bill, matched via the order's booking.
app.get('/api/orders/:id/deposit', async (req, res) => {
  try {
    const ordRes = await pool.query('SELECT reservation_id FROM orders WHERE id = $1', [req.params.id]);
    const resId = ordRes.rows[0]?.reservation_id;
    if (!resId) return res.json({ deposit: null });
    const d = await pool.query(
      `SELECT code, balance, original_amount, reservation_id FROM vouchers
        WHERE type='deposit' AND reservation_id=$1 AND status='active' AND balance > 0
        ORDER BY created_at DESC LIMIT 1`,
      [resId],
    );
    const dep = d.rows[0];
    res.json({ deposit: dep ? { ...dep, balance: Number(dep.balance), original_amount: Number(dep.original_amount) } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual forfeit — a no-show's deposit is kept as income (own report line).
app.post('/api/deposits/:code/forfeit', async (req, res) => {
  const client = await pool.connect();
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    await client.query('BEGIN');
    const r = await client.query("SELECT * FROM vouchers WHERE code=$1 AND type='deposit' FOR UPDATE", [code]);
    const dep = r.rows[0];
    if (!dep) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Deposit not found' }); }
    if (dep.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Deposit is already ${dep.status}` }); }
    // Reuse voided_at as the forfeit timestamp so "forfeited today" is date-scoped.
    await client.query("UPDATE vouchers SET status='forfeited', voided_at=NOW() WHERE id=$1", [dep.id]);
    await client.query('COMMIT');
    res.json({ ok: true, code, forfeited: Number(dep.balance) });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Status transitions — kitchen / admin use.
app.put('/api/orders/:id/takeaway-status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'accepted', 'preparing', 'ready', 'collected'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await pool.query('UPDATE orders SET takeaway_status=$1 WHERE id=$2 AND order_type=\'takeaway\'', [status, req.params.id]);
    if (status === 'collected') {
      await pool.query(`UPDATE orders SET status='closed', closed_at=NOW(), session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`, [req.params.id]);
      await pool.query("UPDATE order_items SET status='served', served_at=NOW() WHERE order_id=$1 AND status<>'served'", [req.params.id]);
    }
    io.emit('takeaway_status', { order_id: Number(req.params.id), status });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-DELIVERY-001 — courier auto-dispatch (Stuart live, Uber Direct
// scaffolded). The kitchen taps "Dispatch Courier" on a delivery order
// → POST /api/delivery/dispatch. The chosen courier job is created, the
// tracking URL stored, and the order is held OPEN until the courier
// webhook reports the parcel delivered.
// ─────────────────────────────────────────────────────────────────────
const COURIER_SERVICES = { stuart: stuartService, uber_direct: uberDirectService };

async function readSettings(keys) {
  const ph = keys.map((_, i) => `$${i + 1}`).join(',');
  const r = await pool.query(`SELECT key, value FROM settings WHERE key IN (${ph})`, keys);
  const out = {};
  r.rows.forEach((row) => { out[row.key] = row.value; });
  return out;
}

async function dispatchCourier(orderId) {
  const oRes = await pool.query(
    `SELECT id, order_type, order_subtype, status, takeaway_status,
            delivery_address, delivery_notes, customer_name, customer_phone,
            courier_job_id, courier_name, delivery_status
       FROM orders WHERE id = $1`,
    [orderId]
  );
  const order = oRes.rows[0];
  if (!order) throw new Error('Order not found');
  if (order.order_type !== 'takeaway' || order.order_subtype !== 'delivery') {
    throw new Error('Order is not an online delivery order');
  }
  if (!order.delivery_address) throw new Error('Order has no delivery address');
  // Block a double dispatch — but allow re-dispatch after a failure/cancel.
  if (order.courier_job_id &&
      !['failed', 'cancelled', 'canceled'].includes(String(order.delivery_status || ''))) {
    throw new Error(`Already dispatched via ${order.courier_name || 'a courier'}`);
  }

  const cfg = await readSettings([
    'courier_dispatch_enabled', 'courier_provider',
    'courier_pickup_address', 'courier_pickup_phone', 'restaurant_postcode',
  ]);
  if (cfg.courier_dispatch_enabled !== '1') {
    throw new Error('Courier dispatch is turned off in Settings');
  }
  const service = COURIER_SERVICES[cfg.courier_provider || 'stuart'];
  if (!service) throw new Error('Unknown courier provider: ' + cfg.courier_provider);
  if (!service.isConfigured()) {
    throw new Error(`${service.PROVIDER} is not configured — add its API credentials in Railway`);
  }
  if (!cfg.courier_pickup_address) {
    throw new Error('Set the restaurant pickup address in Settings → Courier Dispatch');
  }

  const itRes = await pool.query(
    `SELECT item_name AS name, quantity FROM order_items WHERE order_id = $1 AND voided = 0`,
    [orderId]
  );
  const pickup = {
    address: [cfg.courier_pickup_address, cfg.restaurant_postcode].filter(Boolean).join(', '),
    phone: cfg.courier_pickup_phone || '',
    name: process.env.RESTAURANT_NAME || 'Restaurant',
  };

  let job;
  try {
    job = await service.createJob({ order: { ...order, items: itRes.rows }, pickup });
  } catch (err) {
    await pool.query(`UPDATE orders SET delivery_status = 'failed' WHERE id = $1`, [orderId]);
    io.emit('delivery_status', { order_id: Number(orderId), delivery_status: 'failed' });
    throw err;
  }

  await pool.query(
    `UPDATE orders SET courier_name = $1, courier_job_id = $2, delivery_status = $3,
            tracking_url = $4, delivery_eta = $5, takeaway_status = 'ready'
      WHERE id = $6`,
    [service.PROVIDER, job.jobId, job.status || 'dispatched',
     job.trackingUrl || null, job.eta || null, orderId]
  );
  io.emit('delivery_status', {
    order_id: Number(orderId), delivery_status: job.status || 'dispatched',
    courier_name: service.PROVIDER, tracking_url: job.trackingUrl || null,
  });
  io.emit('takeaway_status', { order_id: Number(orderId), status: 'ready' });
  console.log(`🚗 dispatched order #${orderId} via ${service.PROVIDER} (job ${job.jobId})`);
  return {
    courier_name: service.PROVIDER, courier_job_id: job.jobId,
    delivery_status: job.status || 'dispatched',
    tracking_url: job.trackingUrl || null, delivery_eta: job.eta || null,
  };
}

// Apply a courier webhook status update to the matching order.
async function applyCourierWebhook(providerLabel, parsed) {
  if (!parsed || (!parsed.jobId && !parsed.clientReference)) return;
  let order = null;
  if (parsed.jobId) {
    const r = await pool.query(`SELECT id, status FROM orders WHERE courier_job_id = $1`, [String(parsed.jobId)]);
    order = r.rows[0] || null;
  }
  if (!order && parsed.clientReference) {
    const m = String(parsed.clientReference).match(/(\d+)/);
    if (m) {
      const r = await pool.query(`SELECT id, status FROM orders WHERE id = $1`, [Number(m[1])]);
      order = r.rows[0] || null;
    }
  }
  if (!order) {
    console.warn(`[courier] ${providerLabel} webhook — no matching order (job ${parsed.jobId})`);
    return;
  }
  const status = String(parsed.status || 'updated').toLowerCase();
  const svc = COURIER_SERVICES[providerLabel === 'Uber Direct' ? 'uber_direct' : 'stuart'];
  await pool.query(
    `UPDATE orders SET delivery_status = $1,
            tracking_url = COALESCE($2, tracking_url),
            delivery_eta = COALESCE($3, delivery_eta)
      WHERE id = $4`,
    [status, parsed.trackingUrl || null, parsed.eta || null, order.id]
  );
  if (svc && svc.DELIVERED_STATUSES.includes(status) && order.status === 'open') {
    await pool.query(
      `UPDATE orders SET status='closed', closed_at=NOW(), takeaway_status='collected', session_id=${OPEN_SESSION_SUBQ} WHERE id=$1`,
      [order.id]
    );
    await pool.query(
      `UPDATE order_items SET status='served', served_at=NOW() WHERE order_id=$1 AND status<>'served'`,
      [order.id]
    );
    io.emit('takeaway_status', { order_id: order.id, status: 'collected' });
    console.log(`✅ courier delivered order #${order.id} — order closed`);
  }
  io.emit('delivery_status', { order_id: order.id, delivery_status: status });
}

// Manual / kitchen-triggered dispatch.
app.post('/api/delivery/dispatch', async (req, res) => {
  try {
    const orderId = Number(req.body && req.body.order_id);
    if (!orderId) return res.status(400).json({ error: 'order_id is required' });
    const result = await dispatchCourier(orderId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Live price quote for a delivery order.
app.post('/api/delivery/quote', async (req, res) => {
  try {
    const orderId = Number(req.body && req.body.order_id);
    if (!orderId) return res.status(400).json({ error: 'order_id is required' });
    const oRes = await pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [orderId]);
    const order = oRes.rows[0];
    if (!order || !order.delivery_address) {
      return res.status(400).json({ error: 'Order has no delivery address' });
    }
    const cfg = await readSettings(['courier_provider', 'courier_pickup_address', 'restaurant_postcode']);
    const service = COURIER_SERVICES[cfg.courier_provider || 'stuart'];
    if (!service || !service.isConfigured()) {
      return res.status(400).json({ error: 'Courier provider not configured' });
    }
    const pickupAddress = [cfg.courier_pickup_address, cfg.restaurant_postcode].filter(Boolean).join(', ');
    const quote = await service.getQuote({ pickupAddress, dropoffAddress: order.delivery_address });
    res.json({ success: true, provider: service.PROVIDER, ...quote });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Courier status webhooks — always 200 so the courier stops retrying.
app.post('/api/delivery/stuart-webhook', async (req, res) => {
  try {
    await applyCourierWebhook('Stuart', stuartService.parseWebhook(req.body));
  } catch (err) {
    console.error('[courier] Stuart webhook error:', err.message);
  }
  res.json({ received: true });
});

app.post('/api/delivery/uber-webhook', async (req, res) => {
  try {
    await applyCourierWebhook('Uber Direct', uberDirectService.parseWebhook(req.body));
  } catch (err) {
    console.error('[courier] Uber Direct webhook error:', err.message);
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────
// SEPOS-DELIVEROO-001 — Deliveroo Partner Platform webhook + kitchen
// ready endpoint. Deliveroo pushes order.placed events to
// POST /api/deliveroo/webhook. We auto-accept, create a SiamEPOS
// takeaway order tagged 🛵 Deliveroo, and hold it open until the
// kitchen marks it ready (POST /api/deliveroo/ready/:orderId).
// ─────────────────────────────────────────────────────────────────────

app.post('/api/deliveroo/webhook', async (req, res) => {
  // Always 200 immediately — Deliveroo retries on non-200.
  res.json({ received: true });
  try {
    const parsed = deliverooService.parseWebhook(req.body);
    if (!parsed) {
      console.log('[deliveroo] webhook received but no order found in payload');
      return;
    }
    console.log(`[deliveroo] order.placed: Deliveroo #${parsed.displayId} (${parsed.customerName})`);

    // Deduplicate — ignore if this Deliveroo order ID already exists.
    const exists = await pool.query(
      `SELECT id FROM orders WHERE deliveroo_order_id = $1`,
      [parsed.deliverooOrderId]
    );
    if (exists.rows.length > 0) {
      console.log(`[deliveroo] order ${parsed.deliverooOrderId} already imported — skipping`);
      return;
    }

    // Insert the order as a takeaway delivery order.
    const orderRes = await pool.query(
      `INSERT INTO orders
         (order_type, order_subtype, status, takeaway_status,
          customer_name, customer_phone, delivery_notes,
          pickup_time, deliveroo_order_id, courier_name,
          opened_at, created_at)
       VALUES ('takeaway','delivery','open','received',
               $1,$2,$3,$4,$5,'Deliveroo',NOW(),NOW())
       RETURNING id`,
      [
        parsed.customerName,
        parsed.customerPhone,
        parsed.customerNotes,
        parsed.pickupTime,
        parsed.deliverooOrderId,
      ]
    );
    const orderId = orderRes.rows[0].id;

    // Insert order items.
    for (const item of parsed.items) {
      await pool.query(
        `INSERT INTO order_items (order_id, item_name, quantity, unit_price, notes, status, fired_at)
         VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
        [orderId, item.name, item.quantity, item.unit_price, item.notes || null]
      );
    }

    // Auto-accept the order back to Deliveroo (required within ~10 min).
    if (deliverooService.isConfigured()) {
      try {
        await deliverooService.acceptOrder(parsed.deliverooOrderId);
      } catch (err) {
        console.error('[deliveroo] accept order error:', err.message);
      }
    }

    // Notify kitchen via socket.
    io.emit('new_order_items', { order_id: orderId });
    console.log(`🛵 Deliveroo order #${parsed.displayId} → SiamEPOS #${orderId}`);
  } catch (err) {
    console.error('[deliveroo] webhook processing error:', err.message);
  }
});

// Kitchen marks a Deliveroo order ready for collection.
app.post('/api/deliveroo/ready/:orderId', async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    const oRes = await pool.query(
      `SELECT id, deliveroo_order_id, takeaway_status FROM orders WHERE id = $1`,
      [orderId]
    );
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.deliveroo_order_id) return res.status(400).json({ error: 'Not a Deliveroo order' });

    // Tell Deliveroo the order is ready.
    if (deliverooService.isConfigured()) {
      await deliverooService.markReady(order.deliveroo_order_id);
    }

    // Update status in our DB.
    await pool.query(
      `UPDATE orders SET takeaway_status = 'ready' WHERE id = $1`,
      [orderId]
    );
    io.emit('takeaway_status', { order_id: orderId, status: 'ready' });
    res.json({ success: true });
  } catch (err) {
    console.error('[deliveroo] ready error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
app.put('/api/customers/marketing-consent', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
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
// (crypto is required once at the top of the file)
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
      ON o.status = 'closed'
     AND (
           o.reservation_id = r.id
        OR (o.reservation_id IS NULL AND o.table_id = r.table_id AND DATE(o.opened_at) = r.reservation_date)
         )
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
app.get('/api/campaigns/recipient-count', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const list = await fetchCustomersForSegment(req.query.segment || 'All');
    res.json({ count: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Past campaigns (newest first)
app.get('/api/campaigns', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, subject, segment, recipient_count, sent_count, failed_count, created_at FROM campaigns ORDER BY id DESC LIMIT 50');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send a campaign. Reads {subject, body, segment}, resolves recipient list,
// fires Brevo sends sequentially, records the campaign + counts.
app.post('/api/campaigns/send', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    const { subject, body, segment } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body    || !body.trim())    return res.status(400).json({ error: 'Body is required' });
    // Email config check — accept either a local BREVO_API_KEY OR
    // a configured cloud relay (CLOUD_API_URL + SYNC_SECRET). Desktop
    // installs typically have the relay; cloud installs have the key
    // directly. If neither is available, email genuinely can't fire.
    const _brevoLocal = !!process.env.BREVO_API_KEY;
    const _brevoRelay = !!(process.env.CLOUD_API_URL && process.env.SYNC_SECRET);
    if (!_brevoLocal && !_brevoRelay) {
      return res.status(500).json({ error: 'Email is not configured. Set BREVO_API_KEY on the server, or configure CLOUD_API_URL + SYNC_SECRET for cloud-relay (desktop installs).' });
    }
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
// (VIP / Regular / New / Lapsed) and total spend.
//
// SEPOS-PRO-008 — spend is now EXACT for bills linked to their booking via
// orders.reservation_id (stamped when the bill is paid on a seated table).
// Older/unlinked bills fall back to the legacy heuristic (orders on the
// reserved table on the reservation date). Takeaway spend is exact (customer
// is on the order row).
// ─────────────────────────────────────────────────────────────────────
app.get('/api/customers', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    // Pull reservations + their estimated spend in one query. The spend
    // join is intentionally loose (table + date) — multiple reservations
    // at the same table on the same day will currently share the spend,
    // which we accept for v1.
    const r = await pool.query(`
      SELECT
        COALESCE(NULLIF(LOWER(TRIM(r.customer_email)), ''), 'p:' || NULLIF(TRIM(r.customer_phone), '')) AS contact_key,
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
        ON o.status = 'closed'
       AND (
             o.reservation_id = r.id
          OR (o.reservation_id IS NULL AND o.table_id = r.table_id AND DATE(o.opened_at) = r.reservation_date)
           )
      WHERE (r.customer_email IS NOT NULL AND TRIM(r.customer_email) <> '')
         OR (r.customer_phone IS NOT NULL AND TRIM(r.customer_phone) <> '')
      GROUP BY COALESCE(NULLIF(LOWER(TRIM(r.customer_email)), ''), 'p:' || NULLIF(TRIM(r.customer_phone), ''))
      ORDER BY MAX(r.reservation_date) DESC
    `);

    // SEPOS-DELIVERY-002 — takeaway customers. Takeaway orders carry
    // customer_name/phone/email directly on the order row, so we
    // aggregate them the same way and merge into the reservation-derived
    // list by email. No customers table needed — the CRM stays a
    // derived view, now spanning both bookings AND takeaway.
    const takeawayRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(LOWER(TRIM(customer_email)), ''), 'p:' || NULLIF(TRIM(customer_phone), '')) AS contact_key,
        MIN(customer_email) AS customer_email,
        MIN(customer_name)  AS customer_name,
        MIN(customer_phone) AS customer_phone,
        MAX(COALESCE(marketing_consent, 0)) AS marketing_consent,
        COUNT(*) AS total_visits,
        MIN(DATE(opened_at)) AS first_visit,
        MAX(DATE(opened_at)) AS last_visit,
        COALESCE(SUM(total), 0) AS total_spend
      FROM orders
      WHERE order_type = 'takeaway'
        AND ((customer_email IS NOT NULL AND TRIM(customer_email) <> '')
          OR (customer_phone IS NOT NULL AND TRIM(customer_phone) <> ''))
      GROUP BY COALESCE(NULLIF(LOWER(TRIM(customer_email)), ''), 'p:' || NULLIF(TRIM(customer_phone), ''))
    `);

    // Merge: reservation customers first, then fold takeaway in.
    const byEmail = new Map();
    for (const row of r.rows) byEmail.set(row.contact_key, { ...row });
    for (const t of takeawayRes.rows) {
      const ex = byEmail.get(t.contact_key);
      if (ex) {
        ex.total_visits = Number(ex.total_visits || 0) + Number(t.total_visits || 0);
        ex.total_spend  = Number(ex.total_spend  || 0) + Number(t.total_spend  || 0);
        if (t.first_visit && (!ex.first_visit || new Date(t.first_visit) < new Date(ex.first_visit))) ex.first_visit = t.first_visit;
        if (t.last_visit  && (!ex.last_visit  || new Date(t.last_visit)  > new Date(ex.last_visit)))  ex.last_visit  = t.last_visit;
        ex.marketing_consent = (ex.marketing_consent || t.marketing_consent) ? 1 : 0;
        ex.customer_name  = ex.customer_name  || t.customer_name;
        ex.customer_phone = ex.customer_phone || t.customer_phone;
      } else {
        byEmail.set(t.contact_key, { ...t, unsubscribed: 0 });
      }
    }
    const merged = [...byEmail.values()].sort((a, b) =>
      new Date(b.last_visit || 0) - new Date(a.last_visit || 0)
    );

    const today = new Date();
    const customers = merged.map(c => {
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

// SEPOS-056 — delete customers from the CRM. There is no customers table:
// the CRM is a view derived from reservations + takeaway orders keyed by
// email. So "delete a customer" means erasing their identity from those
// underlying rows:
//   • reservations carry no money → hard-delete them for that email
//     (children cascade via reservation_id ... ON DELETE CASCADE)
//   • takeaway orders carry revenue → anonymise (NULL the PII) so the
//     sale + Z-report stay intact but the person leaves the CRM
// Accepts one or many emails ({ emails: [...] }) so the same endpoint
// powers the per-row delete and the "delete all matching filter" button.
app.post('/api/customers/delete', requireStaffAuth(['admin', 'manager', 'supervisor']), async (req, res) => {
  try {
    // Accept the new contacts:[{email,phone}] shape; fall back to the legacy
    // emails:[...] array. A customer is identified by email, or by phone when
    // they have no email (phone-only / walk-in bookings).
    let contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    if (contacts.length === 0 && Array.isArray(req.body?.emails)) {
      contacts = req.body.emails.map(e => ({ email: e }));
    }
    const norm = contacts.map(c => ({
      email: String(c?.email || '').trim().toLowerCase(),
      phone: String(c?.phone || '').trim(),
    })).filter(c => c.email || c.phone);
    if (norm.length === 0) return res.status(400).json({ error: 'No customers provided' });

    let deleted = 0, reservationsRemoved = 0, ordersAnonymised = 0;
    for (const c of norm) {
      if (c.email) {
        const del = await pool.query(
          `DELETE FROM reservations WHERE LOWER(TRIM(customer_email)) = $1`, [c.email]);
        reservationsRemoved += del.rowCount || 0;
        const anon = await pool.query(
          `UPDATE orders SET customer_name = NULL, customer_email = NULL, customer_phone = NULL
            WHERE order_type = 'takeaway' AND LOWER(TRIM(customer_email)) = $1`, [c.email]);
        ordersAnonymised += anon.rowCount || 0;
      } else {
        // Phone-only: target rows with that phone AND no email (its CRM grouping).
        const del = await pool.query(
          `DELETE FROM reservations WHERE TRIM(customer_phone) = $1
             AND (customer_email IS NULL OR TRIM(customer_email) = '')`, [c.phone]);
        reservationsRemoved += del.rowCount || 0;
        const anon = await pool.query(
          `UPDATE orders SET customer_name = NULL, customer_email = NULL, customer_phone = NULL
            WHERE order_type = 'takeaway' AND TRIM(customer_phone) = $1
              AND (customer_email IS NULL OR TRIM(customer_email) = '')`, [c.phone]);
        ordersAnonymised += anon.rowCount || 0;
      }
      deleted++;
    }

    res.json({ deleted, reservations_removed: reservationsRemoved, orders_anonymised: ordersAnonymised });
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
        AND o.created_at::date >= $1::date AND o.created_at::date <= $2::date
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
// SEPOS-021 / SEPOS-VATMODE-001 — VAT report (date range)
// vat_mode='inclusive' (default): prices contain VAT, net = gross ÷ (1+rate).
// vat_mode='exclusive': prices are net, VAT is rate% ON TOP (Thann Thai).
// For each closed order_item in the window, group by vat_rate. Service charge
// + bill-level discounts are out of the VAT base either way.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/reports/vat', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from || '1970-01-01';
    const toTs   = to   || '2999-12-31';
    // Korakot 2026-06-02: extended to surface is_bar (food vs drink) per
    // line so we can render the breakdown split by category type on the
    // VAT report. Per-item AND bill-level discounts are both applied
    // (SEPOS-047j) so the VAT figure matches money actually taken.
    const [r, vatModeRes] = await Promise.all([
      pool.query(`
      SELECT COALESCE(mi.vat_rate, 20) AS vat_rate,
             COALESCE(c.is_bar, 0) AS is_bar,
             oi.order_id, oi.quantity, oi.unit_price, oi.discount_type, oi.discount_value,
             o.discount_type AS bill_discount_type, o.discount_value AS bill_discount_value
      FROM order_items oi
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      LEFT JOIN categories  c  ON c.id  = mi.category_id
      LEFT JOIN orders      o  ON o.id  = oi.order_id
      WHERE o.status='closed' AND oi.voided=0
        AND o.closed_at >= $1::timestamp AND o.closed_at <= $2::timestamp
    `, [fromTs, toTs]),
      pool.query(`SELECT value FROM settings WHERE key='vat_mode'`),
    ]);
    const vatMode = vatModeRes.rows[0]?.value === 'exclusive' ? 'exclusive' : 'inclusive';

    const byRate = new Map();
    const byKind = { food: { net: 0, vat: 0, gross: 0, items: 0 }, drink: { net: 0, vat: 0, gross: 0, items: 0 } };
    const vatFactors = billDiscountFactors(r.rows); // SEPOS-047j — bill-level discount
    for (const row of r.rows) {
      const rate = Number(row.vat_rate ?? 20);
      let base = Number(row.quantity || 0) * Number(row.unit_price || 0);
      if (row.discount_type === 'percent') base *= 1 - (Number(row.discount_value || 0) / 100);
      else if (row.discount_type === 'fixed') base = Math.max(0, base - Number(row.discount_value || 0));
      base *= (vatFactors.get(row.order_id) ?? 1); // distribute the order's bill-level discount
      const { net, vat } = vatLine(base, rate, vatMode); // SEPOS-VATMODE-001
      const gross = net + vat;
      const qty = Number(row.quantity || 0);
      const bucket = byRate.get(rate) || { rate, net: 0, vat: 0, gross: 0, items: 0 };
      bucket.net   += net;
      bucket.vat   += vat;
      bucket.gross += gross;
      bucket.items += qty;
      byRate.set(rate, bucket);

      const kind = Number(row.is_bar) === 1 ? 'drink' : 'food';
      byKind[kind].net   += net;
      byKind[kind].vat   += vat;
      byKind[kind].gross += gross;
      byKind[kind].items += qty;
    }
    const breakdown = [...byRate.values()].sort((a, b) => a.rate - b.rate);
    const total = breakdown.reduce(
      (a, b) => ({ net: a.net + b.net, vat: a.vat + b.vat, gross: a.gross + b.gross, items: a.items + b.items }),
      { net: 0, vat: 0, gross: 0, items: 0 }
    );
    res.json({ from: fromTs, to: toTs, breakdown, total, by_kind: byKind, vat_mode: vatMode });
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

// ── SEPOS-025/026 Network Printing ──────────────────────────────────────────
// Helper: load all settings as a plain object
async function loadSettings() {
  const result = await pool.query('SELECT key, value FROM settings');
  const s = {};
  result.rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

// Test any printer by printing a REALISTIC mock receipt. Exercises the
// full receipt build path (logo, header, £ symbol, table number, items,
// totals, alignment) so operators see at setup time exactly what real
// receipts will look like — instead of finding bugs at first service.
// Either ip OR printer_name (or both) must be supplied.
// SEPOS-PRINT-THAI-PROBE — print a single test ticket with "ทดสอบ" under
// each common Thai codepage. The operator visually picks the one that
// rendered correctly and sets settings.kitchen_thai_codepage to its ID.
app.post('/api/print/thai-test', async (req, res) => {
  try {
    const settings = await loadSettings();
    // SEPOS-058 — a USB printer is addressed by name (no IP). Let the client
    // pass its selected device so the Thai-codepage probe reaches it without
    // requiring settings.printer_*_name to be saved first (avoids NO_IP).
    if (req.body?.printer_name) {
      settings.printer_kitchen_name = req.body.printer_name;
      settings.printer_kitchen_ip = '';
      settings.printer_receipt_ip = '';
    }
    // Optional ?cp=255 OR { cp: 255 } in body → focus the test on a
    // single codepage instead of sweeping the full candidate list.
    // Useful when an operator already knows the printer's spec value.
    const customCp = req.body?.cp || req.query?.cp || null;
    await printService.printThaiTest(settings, customCp ? Number(customCp) : null);
    res.json({ success: true, codepage: customCp || 'sweep' });
  } catch (err) {
    console.error('[print/thai-test]', err.message);
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/print/test', async (req, res) => {
  const { ip, port, printer_name } = req.body;
  if (!ip && !printer_name) {
    return res.status(400).json({ success: false, error: 'ip or printer_name required' });
  }
  try {
    const settings = await loadSettings();
    // Override the configured receipt printer with what the operator
    // just typed in the Test field — so they can test BEFORE saving.
    const testSettings = {
      ...settings,
      printer_receipt_ip:    ip || settings.printer_receipt_ip,
      printer_receipt_port:  port || settings.printer_receipt_port || 9100,
      printer_receipt_name:  printer_name || settings.printer_receipt_name || '',
    };
    const mockOrder = {
      id: 'TEST',
      order_type: 'dine_in',
      table_number: 5,
      covers: 2,
      discount_value: 0,
    };
    const mockItems = [
      { quantity: 2, name: 'Spring Rolls',  unit_price: 4.95, course: 1, voided: 0 },
      { quantity: 1, name: 'Pad Thai',      unit_price: 9.50, course: 2, voided: 0 },
      { quantity: 1, name: 'Mango Sticky Rice', unit_price: 5.50, course: 3, voided: 0 },
    ];
    const subtotal     = 24.90;
    const service      = +(subtotal * 0.125).toFixed(2);
    const billTotal    = +(subtotal + service).toFixed(2);
    const mockPayment  = {
      subtotal,
      discountAmount: 0,
      serviceCharge: service,
      billTotal,
      amountPaid: billTotal,
      tip: 0,
      change: 0,
      method: 'Cash',
    };
    await printService.printReceipt(testSettings, mockOrder, mockItems, mockPayment);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// SEPOS-PRINT-HEALTH-001 — TCP reachability + latency probe.
// Opens a connect-only socket to ip:port with a 2.5s timeout, measures
// time-to-connect, closes immediately. Used by Settings → Network
// Printers to surface "🟢 12ms / 🟡 350ms / 🔴 offline" badges so the
// operator can see signal health BEFORE they fire a print and wait 30s
// for a stuck job. Doesn't send any ESC/POS bytes, so safe to spam.
app.get('/api/print/health', (req, res) => {
  const ip   = String(req.query.ip || '').trim();
  const port = parseInt(req.query.port || '9100', 10) || 9100;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  const net = require('net');
  const TIMEOUT_MS = 2500;
  const start = Date.now();
  const sock  = new net.Socket();
  let done = false;
  const finish = (payload) => {
    if (done) return; done = true;
    try { sock.destroy(); } catch {}
    res.json(payload);
  };

  sock.setTimeout(TIMEOUT_MS);
  sock.once('connect', () => finish({ ok: true,  latency_ms: Date.now() - start }));
  sock.once('timeout', () => finish({ ok: false, error: 'timeout', latency_ms: TIMEOUT_MS }));
  sock.once('error',   (err) => finish({ ok: false, error: err.code || err.message || 'error', latency_ms: Date.now() - start }));
  sock.connect(port, ip);
});

// SEPOS-PRINT-MAC-001 — MAC ↔ IP lookups via the local ARP cache. Used
// by the Settings Printers card to:
//   1) capture the printer's MAC once after operator types its IP, then
//   2) on every health-probe failure, look up where the MAC has moved
//      to and silently auto-update settings.printer_*_ip.
// Only meaningful when the backend is on the same LAN as the printer
// (Electron-local install). On Railway the ARP cache contains only
// containers/load-balancers and returns nothing useful.
function _normalizeMac(m) {
  return String(m || '').toLowerCase()
    .replace(/-/g, ':')
    .split(':').map(p => p.padStart(2, '0')).join(':');
}

function _parseArpTable(stdout) {
  // Three platform formats — all from a single `arp -a` invocation:
  //   Mac/BSD format: `? (192.168.68.57) at 96:3b:d7:f8:f9:89 on en0 ifscope`
  //   Linux format:   `192.168.68.57 dev en0 lladdr 96:3b:d7:f8:f9:89 REACHABLE`
  //   Windows format: `  192.168.68.57          96-3b-d7-f8-f9-89     dynamic`
  // Windows uses hyphens in the MAC (normalised to colons downstream).
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    let m = line.match(/\(([0-9.]+)\) at ([0-9a-f:]+)/i);
    if (m) { out.push({ ip: m[1], mac: _normalizeMac(m[2]) }); continue; }
    m = line.match(/^([0-9.]+)\s+.*lladdr\s+([0-9a-f:]+)/i);
    if (m) { out.push({ ip: m[1], mac: _normalizeMac(m[2]) }); continue; }
    // Windows: leading whitespace, then IP, whitespace, MAC with hyphens (exactly 17 chars).
    m = line.match(/^\s+([0-9.]+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+/i);
    if (m) { out.push({ ip: m[1], mac: _normalizeMac(m[2]) }); continue; }
  }
  return out;
}

function _arpTable() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('arp -a', { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(_parseArpTable(stdout));
    });
  });
}

app.get('/api/print/get-mac', async (req, res) => {
  const ip = String(req.query.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  const rows = await _arpTable();
  const row = rows.find(r => r.ip === ip);
  if (!row) return res.json({ ok: false, error: 'IP not in ARP cache' });
  res.json({ ok: true, ip, mac: row.mac });
});

app.get('/api/print/discover', async (req, res) => {
  const mac = _normalizeMac(req.query.mac);
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'valid MAC required' });
  }
  const rows = await _arpTable();
  const row = rows.find(r => r.mac === mac);
  if (!row) {
    return res.json({ ok: false, error: 'MAC not in ARP cache — try pinging the printer or wait 30s' });
  }
  res.json({ ok: true, mac, ip: row.ip });
});

// Auto-detect the macOS CUPS queue name for a given printer IP.
// Used by Settings → Network Printers to pre-fill the CUPS name field
// after the operator types the IP, so they never have to look up the
// (auto-generated) queue name themselves.
app.get('/api/print/cups-queue-for-ip', async (req, res) => {
  try {
    const ip = String(req.query.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'ip required' });
    const queue = await printService.findCupsQueueForIp(ip);
    res.json({ queue });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Print a receipt for a given order
// SEPOS-REPORTS-001 — generic admin-report ESC/POS print. Takes a
// simple line DSL from the client (see printService.buildReportText)
// and prints to the configured receipt printer via the same RAW → LPR
// → CUPS fallback chain that bill receipts use.
app.post('/api/print/report-text', async (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ success: false, error: 'lines[] required' });
  }
  try {
    const settings = await loadSettings();
    if (!settings.printer_receipt_ip && !settings.printer_receipt_name) {
      return res.json({ success: false, reason: 'no_ip' });
    }
    await printService.printReportText(settings, lines);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── SEPOS-ANDROID-001 — ESC/POS buffers for the native Android app ──────────
// The cloud can't reach a LAN printer, so the Android app PULLS the bytes and
// sends them to the printer itself (native TCP plugin). Same builders as the
// desktop path → byte-identical formatting (Thai, £, logo, cut). Returns base64.
app.get('/api/print/buffers/test', async (req, res) => {
  try {
    const buf = printService.buildTestPage();
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/print/buffers/receipt', async (req, res) => {
  const { order_id, payment_details } = req.body || {};
  try {
    const settings = await loadSettings();
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });
    const itemsRes = await pool.query(
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt
       FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id = $1`, [order_id]);
    const buf = printService.buildReceipt({
      order: orderRes.rows[0], items: itemsRes.rows, settings, paymentDetails: payment_details || {},
    });
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    console.error('[print/buffers/receipt]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Kitchen ticket buffer (same builder/settings as printFullKitchenTicket) — for
// the Android app to auto-print incoming online orders to its kitchen printer.
app.post('/api/print/buffers/kitchen', async (req, res) => {
  const { order_id } = req.body || {};
  try {
    const settings = await loadSettings();
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });
    const itemsRes = await pool.query(
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt
       FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id = $1`, [order_id]);
    const bilingual    = settings.kitchen_language === 'en_th';
    const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
    const buf = printService.buildFullKitchenTicket({ order: orderRes.rows[0], items: itemsRes.rows, bilingual, thaiCodepage });
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    console.error('[print/buffers/kitchen]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SEPOS-ANDROID-001 — dine-in kitchen/bar/fire-notice ESC/POS buffers (base64)
// for the native app's FIRING device to push to its LAN printer itself. Mirrors
// the serverPrint* endpoints exactly (same builders, same client-supplied delta
// items) but returns the bytes instead of printing from the cloud — Railway
// can't reach a printer on the restaurant's LAN. `kind`: course | full | bar |
// fire-notice. Order is re-fetched server-side for the authoritative heading /
// table number; the items list is the delta the firing screen already passes to
// serverPrintKitchen, so the chef sees only what was just fired.
app.post('/api/print/buffers/kitchen-ticket', async (req, res) => {
  const { order_id, items, course, kind } = req.body || {};
  try {
    const settings = await loadSettings();
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ ok: false, error: 'Order not found' });
    const order        = orderRes.rows[0];
    const list         = items || [];
    const bilingual    = settings.kitchen_language === 'en_th';
    const thaiCodepage = parseInt(settings.kitchen_thai_codepage, 10) || 30;
    let buf;
    switch (kind) {
      case 'full':
        buf = printService.buildFullKitchenTicket({ order, items: list, bilingual, thaiCodepage });
        break;
      case 'bar':
        buf = printService.buildKitchenTicket({ order, items: list, course: 4, bilingual, thaiCodepage });
        break;
      case 'fire-notice':
        buf = printService.buildFireNotice({ order, course: course || 1, bilingual });
        break;
      case 'course':
      default:
        buf = printService.buildKitchenTicket({ order, items: list, course: course || 1, bilingual, thaiCodepage });
    }
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    console.error('[print/buffers/kitchen-ticket]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SEPOS-ANDROID-001 — kitchen-message ESC/POS buffer (base64) so the native
// app's device prints the 📢 message itself (cloud can't reach the LAN printer).
// The KDS banner is still emitted by POST /api/print/kitchen-message as usual.
app.post('/api/print/buffers/kitchen-message', async (req, res) => {
  try {
    const { order_id, table_number, customer_name, message, waiter_name } = req.body || {};
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'message required' });
    let resolvedTable = table_number || '', resolvedType = 'dine_in', resolvedCustomer = customer_name || '';
    if (order_id && !resolvedTable) {
      const r = await pool.query(
        `SELECT o.order_type, o.customer_name, t.table_number
         FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = $1`, [order_id]
      ).catch(() => ({ rows: [] }));
      const o = r.rows[0];
      if (o) { resolvedTable = o.table_number || ''; resolvedType = o.order_type || 'dine_in'; resolvedCustomer = o.customer_name || customer_name || ''; }
    }
    const buf = printService.buildKitchenMessage({
      order_id, table_number: resolvedTable, order_type: resolvedType,
      customer_name: resolvedCustomer, message: text, waiter_name: waiter_name || '',
    });
    res.json({ ok: true, data: Buffer.from(buf).toString('base64'), bytes: buf.length });
  } catch (err) {
    console.error('[print/buffers/kitchen-message]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/print/receipt', async (req, res) => {
  const { order_id, payment_details, printer_name } = req.body;
  try {
    const settings = await loadSettings();
    // SEPOS-058 — a USB printer is addressed by NAME (no IP). When the client
    // passes printer_name (the desktop's selected device), print by name via
    // the platform raw path (Windows spooler RAW / CUPS) instead of requiring
    // an IP. This gives crisp ESC/POS black + silent, vs the faint HTML/GDI path.
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_receipt_name = printer_name; settings.printer_receipt_ip = ''; }
    if (!settings.printer_receipt_ip && !settings.printer_receipt_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = orderRes.rows[0];
    // JOIN menu_items so item.name is populated (order_items only carries
    // item_name as a denormalised snapshot — old data may have it blank).
    const itemsRes = await pool.query(
      `SELECT order_items.*, COALESCE(menu_items.name, order_items.item_name) AS name, menu_items.name_alt
       FROM order_items LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id
       WHERE order_items.order_id = $1`, [order_id]);
    await printService.printReceipt(settings, order, itemsRes.rows, payment_details || {});
    res.json({ success: true });
  } catch (err) {
    console.error('[print/receipt]', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Print a kitchen ticket for a given order + course
app.post('/api/print/kitchen', async (req, res) => {
  const { order_id, items, course, printer_name, copies } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_kitchen_name = printer_name; settings.printer_kitchen_ip = ''; }
    if (copies) settings.printer_kitchen_copies = String(copies); // client-resolved copies (per-device or system)
    if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    await printService.printKitchenTicket(settings, orderRes.rows[0], items || [], course || 1);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen]', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Print a bar ticket
app.post('/api/print/bar', async (req, res) => {
  const { order_id, items, printer_name } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_bar_name = printer_name; settings.printer_bar_ip = ''; }
    if (!settings.printer_bar_ip && !settings.printer_bar_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    await printService.printBarTicket(settings, orderRes.rows[0], items || []);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/bar]', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Print a course fire notice (TABLE X / FIRE MAINS — no item list)
app.post('/api/print/kitchen-fire', async (req, res) => {
  const { order_id, course, printer_name } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_kitchen_name = printer_name; settings.printer_kitchen_ip = ''; }
    if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    await printService.printFireNotice(settings, orderRes.rows[0], course || 1);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen-fire]', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Print a full-order kitchen ticket (all courses combined — fired on Send Order)
app.post('/api/print/kitchen-full', async (req, res) => {
  const { order_id, items, printer_name, copies } = req.body;
  try {
    const settings = await loadSettings();
    await applyPrinterRouting(settings);   // SEPOS-PRINT-UNIFY-001 — unified list → role default (legacy fallback)
    if (printer_name) { settings.printer_kitchen_name = printer_name; settings.printer_kitchen_ip = ''; }
    if (copies) settings.printer_kitchen_copies = String(copies); // client-resolved copies (per-device or system)
    if (!settings.printer_kitchen_ip && !settings.printer_kitchen_name) return res.json({ success: false, reason: 'no_printer' });
    const orderRes = await pool.query(
      `SELECT orders.*, tables.table_number
       FROM orders LEFT JOIN tables ON orders.table_id = tables.id
       WHERE orders.id = $1`, [order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    await printService.printFullKitchenTicket(settings, orderRes.rows[0], items || []);
    res.json({ success: true });
  } catch (err) {
    console.error('[print/kitchen-full]', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── SEPOS-SUPPORT-LINE-001 — LINE AI support bot ─────────────────────
// Restaurant owners message the SiamEPOS LINE Official Account → this
// handler replies via Claude using the support knowledge base. After 2
// failed attempts (or any hard-fail case Claude flags) the conversation
// is escalated to Korakot via a LINE DM.
//
// Stays dormant until LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN
// are set on Railway — without them the route logs and 200s so LINE
// doesn't keep retrying the webhook.
const line = require('@line/bot-sdk');
const lineConfig = {
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineEnabled  = Boolean(lineConfig.channelSecret && lineConfig.channelAccessToken);
// @line/bot-sdk v11 replaced the old `line.Client(...)` constructor with
// the `messagingApi.MessagingApiClient(...)` class. Wrap in try/catch as
// defence so a bad token shape never takes down the server boot.
let lineClient = null;
if (lineEnabled) {
  try {
    lineClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: lineConfig.channelAccessToken,
    });
  } catch (err) {
    console.error('[line] failed to init MessagingApiClient:', err.message);
  }
}
// Conversation memory keyed by LINE userId. Resets after 1h of inactivity
// to keep the support history fresh without persisting anything to DB.
const lineConvos = new Map();
// Per-user escalation counter so we only DM Korakot after 2 unresolved
// turns (or immediately if Claude self-flags escalate=true).
function _lineSession(userId) {
  if (!lineConvos.has(userId)) {
    lineConvos.set(userId, { history: [], lastActive: Date.now(), unresolvedTurns: 0 });
  }
  const s = lineConvos.get(userId);
  s.lastActive = Date.now();
  return s;
}
// Garbage-collect inactive sessions every 30 min.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of lineConvos.entries()) {
    if (s.lastActive < cutoff) lineConvos.delete(id);
  }
}, 30 * 60 * 1000);

// Manual-handover mute table — userId → expiresAt timestamp. While a
// customer is muted, Claude doesn't auto-reply (Korakot is handling
// the conversation directly via LINE OA Manager). Korakot toggles
// this by DMing the bot /handover <userId> [duration].
const lineMuted = new Map();
function _isMuted(userId) {
  const exp = lineMuted.get(userId);
  if (!exp) return false;
  if (exp <= Date.now()) { lineMuted.delete(userId); return false; }
  return true;
}
function _parseDuration(s) {
  // "2h" → 7200000ms, "30m" → 1800000ms, "1d" → 86400000ms. Default 24h.
  const m = String(s || '').match(/^(\d+)([hmd])$/);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  return n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}
function _fmtDuration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60)   return `${m}m`;
  if (m < 1440) return `${Math.round(m/60)}h`;
  return `${Math.round(m/1440)}d`;
}

// Admin commands DMed to the bot from Korakot's LINE account. Returns
// the reply text (or null if the message wasn't a command).
function _handleAdminCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [cmd, ...args] = trimmed.split(/\s+/);

  if (cmd === '/help') {
    return [
      'SiamEPOS bot admin commands:',
      '',
      '/list — show recent customer conversations',
      '/handover <userId> [duration] — mute bot for that customer',
      '    duration default 24h, e.g. 2h, 30m, 1d',
      '/release <userId> — un-mute (or /release all)',
      '/status — show how many users are muted right now',
      '/help — this help',
    ].join('\n');
  }

  if (cmd === '/status') {
    const active = [...lineMuted.entries()].filter(([, exp]) => exp > Date.now());
    if (!active.length) return 'No customers currently in handover mode.';
    return [
      `${active.length} customer(s) in handover mode:`,
      ...active.map(([id, exp]) =>
        `  ${id.slice(0, 10)}… releases in ${_fmtDuration(exp - Date.now())}`),
    ].join('\n');
  }

  if (cmd === '/list') {
    // Active conversations within the last hour, newest first.
    const now = Date.now();
    const rows = [...lineConvos.entries()]
      .filter(([, s]) => now - s.lastActive < 60 * 60 * 1000)
      .sort((a, b) => b[1].lastActive - a[1].lastActive)
      .slice(0, 10);
    if (!rows.length) return 'No active customer conversations in the last hour.';
    return [
      `${rows.length} active conversation(s):`,
      '',
      ...rows.map(([id, s]) => {
        const muted = _isMuted(id) ? ' 🔇' : '';
        const mins  = Math.round((now - s.lastActive) / 60_000);
        const last  = s.history[s.history.length - 1]?.content?.slice(0, 40) || '';
        return `${id}${muted}\n  ${mins}m ago — "${last}"`;
      }),
    ].join('\n');
  }

  if (cmd === '/handover') {
    const targetId = args[0];
    if (!targetId || !targetId.startsWith('U')) {
      return 'Usage: /handover <userId> [duration]\nuserId starts with U.';
    }
    const dur = _parseDuration(args[1]);
    lineMuted.set(targetId, Date.now() + dur);
    return `✓ Bot muted for ${targetId.slice(0, 10)}… for ${_fmtDuration(dur)}.\nReply to them directly in LINE OA Manager. /release ${targetId} to un-mute.`;
  }

  if (cmd === '/release') {
    if (args[0] === 'all') {
      const n = lineMuted.size;
      lineMuted.clear();
      return `✓ Released all ${n} muted conversation(s).`;
    }
    const targetId = args[0];
    if (!targetId) return 'Usage: /release <userId>  or  /release all';
    const had = lineMuted.delete(targetId);
    return had
      ? `✓ Released ${targetId.slice(0, 10)}… — bot will auto-reply again.`
      : `${targetId.slice(0, 10)}… was not muted.`;
  }

  return `Unknown command: ${cmd}\nType /help for the command list.`;
}

const LINE_SYSTEM_PROMPT = `You are the SiamEPOS support assistant on LINE.
You help Thai restaurant owners who use SiamEPOS fix problems with their system.
Be friendly, patient, and concise — this is a LINE chat, not an email. Use
numbered steps for instructions. If the customer writes in Thai, reply in
Thai. If you don't know the answer, escalate honestly — don't invent steps.

## Tone — keep it tight
Talk like a calm tech-savvy colleague, not a customer-service script. Skip
the padding:
- ❌ "That's great to hear! 😊 Feel free to message anytime if you need help.
   We're always here! 🤚"
- ✅ "Sorted 👍" (or just "Glad it worked.")
- ❌ "Hello! Thank you so much for reaching out to SiamEPOS support!"
- ✅ Just answer.
Other rules:
- One emoji per reply max, often zero.
- No "let me know if you have any other questions" closers — they can
  just message again.
- Match the customer's energy: terse user → terse reply; chatty user →
  one extra friendly sentence is fine.
- When the issue is fixed, a short acknowledgement is plenty
  ("Glad that worked." / "ดีใจที่ใช้ได้แล้วครับ/ค่ะ"). Don't try to
  re-engage with offers of further help.

## First-message introduction — set expectations
If the conversation history you've been given contains ONLY ONE message
(i.e. this is the customer's very first message in this session), begin
your reply with a short 1–2 sentence self-introduction so they know
they're talking to an AI assistant and that a human (Korakot) is
available. Examples:
- English: "Hi! I'm SiamEPOS's AI support assistant 🤖 — I can usually
  fix things quickly, but I can hand you over to Korakot any time. Now,
  let's look at your issue:"
- Thai: "สวัสดีค่ะ ฉันเป็นผู้ช่วย AI ของ SiamEPOS 🤖 ตอบได้เกือบทุกเรื่องเลย
  แต่ถ้าอยากคุยกับคุณกรกรตโดยตรงก็บอกได้ตลอดนะคะ มาดูปัญหากันค่ะ:"
Then immediately go into the actual help for whatever they asked.
On every subsequent message in the same session, skip the introduction
and answer directly — they already know who you are.

## Platform awareness — IMPORTANT
SiamEPOS Pro runs on Mac (DMG) AND Windows (EXE). Front-of-house is often
iPad or Android tablet in the browser. DO NOT assume the OS/device — ask
"Are you on Mac, Windows, or iPad?" when the fix differs by platform, OR
give both paths labelled. Hard refresh: Mac Cmd+Shift+R · Win Ctrl+Shift+R
· iPad clear Safari cache via Settings → Safari → Clear History.

Config file location is identical structure on both:
- Mac:  ~/Library/Application Support/siamepos-electron/config.json
- Win:  %APPDATA%\\siamepos-electron\\config.json
(Folder is "siamepos-electron" on both, NOT "SiamEPOS".)

## When to escalate (set escalate: true)
- **Customer explicitly asks to speak with Korakot, the owner, or a human
  agent** (English: "talk to a human", "speak to owner", "real person",
  "I want Korakot"; Thai: "ขอคุยกับกรกรต", "อยากคุยกับคน", "เจ้าของ",
  "พนักงานจริง"). Escalate IMMEDIATELY, don't try to fix anything first.
- Fix needs a code change, Railway env var, deployment, or DB access
- Payment is genuinely stuck or money is missing
- Customer reports possible data loss
- You've tried twice and the problem is still not resolved
- You don't know the answer (don't guess)

## When you escalate, your reply MUST tell the customer
Always include a sentence like:
- English: "I've let Korakot know — he'll message you here shortly."
- Thai: "ส่งต่อให้คุณกรกรตแล้วครับ/ค่ะ เดี๋ยวเขาจะตอบกลับใน LINE นี้เร็วๆ นี้นะคะ"
Don't leave the customer wondering whether anyone is coming.

## Knowledge base

### A. Printers (80mm thermal, ESC/POS)
- **Gibberish / raw codes printing:** wrong driver. Ask OS first, then:
  Mac → System Settings → Printers → Edit → driver "POS-80" (NOT Generic
  PostScript). Win → Settings → Printers → Printer properties → Advanced
  → "Generic / Text Only" or POS-80.
- **Receipt prints blank or very short feed:** printer codepage/driver
  mismatch or HTML being sent to a thermal device. Re-test from Admin
  → Settings → 🖨️ Printers → click "Test" — this sends a proper ESC/POS
  job. If still blank, check printer is on, networked, ping its IP.
- **Logo missing or bottom half faded:** re-upload PNG/JPG (100–300px,
  high contrast). Watch the preview in Settings — if it says "⚠️ very
  faint" use a darker image. Make sure you're on v1.6.22+ (the bottom-
  dropout fix shipped in that release).
- **Thai prints garbled on kitchen tickets:** kitchen printer probably
  doesn't support Thai font. Either set Admin → Settings → Kitchen
  Language to "English only", or upgrade to a Thai-capable thermal
  printer (CP874 / TIS-620 compatible).
- **Thai too small / too thin:** fixed in v1.6.23 — Thai now prints at
  SIZE_BIG matching English. Update the desktop app.
- **Cannot reach printer over network:** try TCP port 9100 first, then
  LPR 515 (older WAVLINK USB print servers only expose LPR). System
  auto-falls-back; check 🟢/🟡/🔴 health badge in Admin → Printers.
  From a browser on Railway cloud, the badge always shows 🔴 because
  Railway can't reach your private LAN — use the SiamEPOS desktop app
  to check reachability properly.
- **Line wraps awkwardly:** default width 42 chars. Adjust per-printer
  in Admin → Printers if your paper is wider/narrower.
- **Items print twice on kitchen ticket after adding to existing order:**
  fixed in v1.6.3+. Update via Help → About.

### B. Desktop app (Electron, Mac + Windows)
- **First-launch "Developer cannot be verified" (Mac):** only on builds
  older than v1.6.4. Download latest DMG from siamepos.co.uk/downloads.
- **App won't start after an OS update:**
  - **Mac:** quit, remove from System Settings → General → Login Items,
    relaunch manually.
  - **Windows:** quit, right-click the tray icon → Exit (if running),
    relaunch from Start menu. If it still won't start, reinstall the
    latest EXE from siamepos.co.uk/downloads.
- **Updates not arriving:** the FIRST install on a machine needs a
  manual reinstall to get on the publish-config build. After that,
  auto-update is silent — quit + relaunch downloads new versions; quit
  + relaunch again applies them.
- **Switching restaurants (e.g. main → Baan Siam):** quit app → edit
  config.json (path above) with new restaurant_name / cloud_api_url /
  restaurant_id / sync_secret → delete siamepos-local.db + .db-journal
  in the same folder → relaunch (first sync repopulates from new cloud).
- **window.prompt() doesn't work in Electron 22+:** it's blocked for
  security. The app uses React modals instead. If a prompt is missing,
  escalate — it's likely a missed code path.

### C. Sync (cloud ↔ local)
- **Banner says "Syncing..." or "No connection":** open Help → Sync
  Status for the exact error. Most common: SYNC_SECRET missing/mismatched.
  Customer should verify the four config.json fields (restaurant_name,
  cloud_api_url, restaurant_id, sync_secret) match what was provided
  at install. Escalate if values look right but error persists.
- **Old bills/closed orders not syncing to the desktop app:** that pull
  is gated by sync_secret. Check config.json has it set — without it
  menu/staff/settings still sync, but closed-orders silently skip.
- **Orders appear then vanish ("rollback-flash"):** rare — the desktop
  app pulled cloud state while a local change was still pending. Wait
  5–10s for push, refresh; order returns.
- **iPad / browser shows different orders than the desktop app:** wait
  5–10s and refresh both; sync tick is 5s. If still diverged after 30s,
  sync is genuinely broken — check Sync Status.
- **First sync taking 30–60s:** normal — pulling full menu/orders/
  reservations history. Subsequent syncs are sub-second.

### D. PWA / cache / iPad
- **iPad shows stale menu or old prices:** service worker cache. Fix:
  Settings → Safari → Clear History and Website Data → delete entries
  for siamepos.co.uk → reload. After a fresh release, iPads sometimes
  need TWO hard refreshes before the new service worker activates.
- **iPad blank white screen:** close the tab fully (swipe up), reopen.
  If still blank, restart the iPad.
- **Offline orders on iPad:** queued locally, render pale/greyed. They
  push automatically when internet returns.

### E. Bookings / reservations
- **Widget not appearing on the website:** confirm two snippets are in
  the site HTML: \`<script src="https://[your-cloud-url]/widget.js"></script>\`
  and \`<div id="siamepos-booking"></div>\`. Cloud URL is the same one
  in their config.json (\`cloud_api_url\`).
- **Booking confirmation emails not arriving:** check spam first. If
  systemic (all bookings), Brevo isn't wired — escalate to set
  BREVO_API_KEY on Railway.
- **Floor-map pre-claim badge (📅 Smith · 19:00) disappears:** it only
  shows bookings within the next 2 hours — fades after the slot passes,
  by design. The booking record stays in Admin → Reservations.
- **"No-show" marked by mistake:** Admin → Reservations → find booking
  → change status back to Completed.
- **Walk-in:** tap the table on the floor map → "Walk in" (not "Dine in")
  → creates an order without a pre-booking; no email is sent.
- **Each linked table now shows its own timeline row:** SEPOS-049 (v1.6.x).

### F. Online ordering (takeaway widget)
- **Widget not appearing:** \`<script src="…/takeaway-widget.js"></script>\`
  + \`<div id="siamepos-takeaway"></div>\` (or
  \`<button id="siamepos-takeaway-button">Order Takeaway</button>\`).
- **Order tagged 🥡 not appearing in kitchen:** kitchen tablet needs a
  refresh (swipe down / Cmd+R). If still missing, check Admin → Orders
  — if it's there, kitchen view is just stale.
- **Customer never collected:** on Kitchen / Pass card tap green
  "🥡 Collected" — closes the order, stamps closed_at so it lands in
  reports + Z-report. Stock was already depleted at order time.
- **Customer can't pay in widget:** real Stripe is not live yet
  (SEPOS-040). Widget uses a mock-pay flow for demos. Collect in person.
- **Pickup time wrong / customer wants to change:** Admin → Orders,
  find the takeaway order; or contact customer directly.

### G. Menu management
- **New item not showing on order screen:** refresh (Cmd+R / swipe on
  iPad). Check it isn't marked Unavailable, and the category is the
  correct one.
- **Price change not on iPad:** iPad cache — do the hard refresh from
  section D. Browser updates immediately; iPad needs the SW dance.
- **Modifier added but not appearing in modifier picker:** Admin → Menu
  → item → Modifiers tab → ensure the modifier is **ticked**, not just
  listed, then Save.
- **Allergen chips not showing:** Admin → 🌿 Allergens → click item →
  tick allergens → Confirm (AI scans alone don't count — owner must
  confirm).
- **VAT rate per item:** Admin → Menu → item → VAT rate (UK food usually
  20%, some items 0%). Affects bill / receipt / Z / VAT report.
- **Menu photo won't upload:** JPG/PNG/WebP, under 2 MB, roughly 1:1 or
  4:3. Try a different photo or check connection.
- **Category order wrong:** Admin → Menu → Categories → drag-and-drop.

### H. Payments / Stripe / vouchers / amendments
- **Split payment (cash + card):** during payment, tap split, enter
  first amount → second auto-fills the remainder.
- **Refund:** Admin → Bills → open the closed bill → 🗑️ Refund (admin
  or manager role only). Choose method, confirm.
- **Voucher redemption:** BillScreen → 💳 Take Payment → 🎁 Voucher →
  enter code (GIFT-XXXXXXX) → choose Full or Partial. Receipt shows
  remaining balance, customer gets confirmation email.
- **Customer lost voucher code:** Admin → 🎁 Vouchers → find voucher →
  📧 Resend Email.
- **Undo voucher applied to an open order:** OrderScreen / Method-stage
  shows a gold "🎁 Voucher applied · −£X · [✕ Remove]" banner. Tap
  Remove → restores balance + status → clears the discount.
- **Payment method amendment (cash entered, should have been card):**
  Admin → Bills → 🔄 Change button per payment row. Enter Manager PIN
  in the modal (that PIN IS the gate — button is always visible).
  Audit row recorded in payment_amendments. Voucher rows can't be
  amended this way.
- **Manager PIN gate on Comp voids:** Wastage / Wrong Order / Changed
  Mind don't need a PIN. Comp does — a manager must enter theirs to
  approve.

### I. Inventory / stock
- **Item sold but stock didn't deplete:** no recipe links the menu
  item to ingredients yet. Admin → Inventory → Recipes & Costs → add
  recipe. Next sale will deplete.
- **Record wastage on a sold item:** Kitchen → tap item → Void →
  Wastage. Doesn't double-deduct (already deducted at sale); appears
  in wastage cost report.
- **Wastage on a raw ingredient (not sold):** Admin → Inventory →
  Stock Log → Manual adjustment → "waste" → quantity.
- **Supplier invoice uploaded but stock didn't update:** invoice line
  items need confirming. Admin → Inventory → Supplier Invoices → open
  → Confirm. Match each line to an ingredient (auto-matched by name,
  may need adjustment). NOTE: BUG-EPOS-046 — confirming may not yet
  actually write stock movements; if stock doesn't move after confirm,
  escalate.
- **AI invoice scanner missed lines:** photograph in good light,
  printed invoices only (not handwritten). Otherwise add lines manually
  in the Confirm step.
- **Batch expired:** Admin → Inventory → Batches → 🗑️ Discard, or
  "✓ Still good (+1 day)" if chef approves (max 3 extensions).

### J. Staff / PINs / roles
- **New staff can't log in:** Admin → Staff → ➕ Add Staff → name, role,
  4–6 digit PIN, Save. They log in by tapping role + entering PIN.
- **Reset forgotten PIN:** Admin → Staff → Edit → new PIN → Save. (You
  can't view the old one, only replace it.)
- **Forgot the admin/owner PIN:** there's no self-serve reset for the
  master admin PIN — escalate, Korakot resets it via database.
- **Role hierarchy:** Admin / Manager = full access. Supervisor = full
  Admin access EXCEPT delete closed bills. Waiter / Kitchen / Bar =
  cannot reach Admin at all (gated route).
- **Clock in/out:** Admin → Staff → ⏰ Clock tab → Clock in / Clock
  out. Weekly summaries + CSV export under Admin → Clock Records.
  Missed clock-out: edit the row manually in Clock Records.

### K. Reports / Z-report / VAT / Bills
- **Totals don't match till feeling:** check date range. Defaults are
  device-local time (BST handled correctly since v1.6.16). Orders are
  counted by closed_at (when paid), not when opened.
- **Service charge missing on report headlines:** ensure on v1.6.14+
  (headlines now sum payments.amount = paid_amount, not orders.total
  which was subtotal-only). Update the app.
- **Food vs Drink split looks wrong:** the split is by VAT rate +
  categories.is_bar. Make sure menu items have correct VAT and
  categories are tagged is_bar where appropriate.
- **Z-report Cash / Card split wrong after a payment-method amend:**
  fixed in v1.6.14 — payment amendments flip the split correctly.
- **Bills tab shows more bills than Z-report counts:** normal — Z only
  counts fully-paid bills.
- **CSV export not downloading:** browser pop-up blocker. Allow
  pop-ups for siamepos.co.uk and try again.
- **Re-print receipt for an old bill:** Admin → Bills → open the bill
  → 🖨️ Re-print (available since v1.6.21).
- **Print any report (Trading / Reports / Z / VAT / Bills) on the
  thermal printer:** there's a Print button on every report tab as of
  v1.6.21 — uses ESC/POS so it formats correctly on 80mm paper.

### L. Multi-device / iPad / kitchen tablet
- **Adding a new iPad/tablet to the system:** open Safari → cloud URL
  → log in with staff PIN. Settings → Multi-Device Setup gives a QR
  + LAN auto-detect. Same WiFi as the till is required.
- **Kitchen tablet not showing new orders:** refresh (swipe down).
  Sync is 5s — wait 10s before assuming it's broken. Check it's logged
  in (restaurant name top-left).
- **Bar tablet not showing items:** items appear once mains fire. Tap
  "Serve table" removes them.
- **Two iPads on same network showing different state:** confirm both
  on the same WiFi, refresh both.
- **Kitchen Direct Mode toggle:** restaurants without a Pass section
  can flip Kitchen header toggle "🍽️ Pass mode" ⇄ "✓ Direct mode".
  In Direct mode the Pass tab is hidden and cooked items stay on
  Kitchen tab with an "✓ Off Kitchen ({n})" header button. Per-device.

### M. Loyalty / vouchers / customers / campaigns
- **Customer enters voucher code:** at till during payment — section H.
- **Voucher email never arrived:** check spam, then resend (Admin →
  Vouchers → 📧 Resend). If systemic, Brevo isn't wired — escalate.
- **Apple Wallet voucher:** customer's gift email has "🍎 Add to Apple
  Wallet" CTA → tap → pass appears in Wallet with QR + balance. Staff
  can scan the QR via the 📷 button on the voucher modal at the till
  (BillScreen). Active since v1.6.5.
- **Marketing consent for a customer who opted in verbally:** Admin →
  Customers → click the marketing-consent badge → toggle. Records it
  as operator-confirmed (GDPR-aware).
- **Email campaign "Send" button greyed out:** select at least one
  segment, fill subject + body, click Preview, then Send.
- **Unsubscribe is permanent (HMAC-signed link).** Operator can re-opt
  in via the badge if customer asks verbally.

### N. Network / offline
- **Internet down at the restaurant:**
  • Mac desktop app keeps working — orders + KDS + bills + printing
    all run locally, queue syncs when internet returns.
  • iPad / browser: continues with cached menu but new staff / menu
    changes won't sync until online.
  • Public booking + takeaway widgets stop working (need cloud).
- **"Cloud is slow":** check WiFi first — Help → Sync Status shows
  last successful sync. If recent, your WiFi is fine. If old, restart
  router. If Railway itself is down it's reported on status pages —
  escalate.

### O. Other known issues
- **Mac timer showed 1h ahead during BST:** fixed in v1.6.x — update.
- **Pass tab blank on Safari/Mac (was a JS hoisting issue):** fixed —
  update to latest.
- **Reservations created on Mac stay local until pushed:** push isn't
  wired yet (cloud → Mac pull works). If a Mac-created reservation
  isn't on the cloud-side admin yet, that's why — escalate if urgent.

## Response format
Reply in JSON only:
{"reply": "your reply text here", "escalate": false}

Set escalate to true only when one of the escalation triggers above
genuinely fires. False otherwise.`;

// Calls Anthropic via the same raw-https pattern already used elsewhere
// in server.js (InvoiceScanner) so no new SDK dependency is needed.
function _callLineClaude(history) {
  return new Promise((resolve) => {
    const https = require('https');
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: LINE_SYSTEM_PROMPT,
      messages: history,
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(chunks);
          const text = data?.content?.[0]?.text || '';
          // Strip any markdown fence Claude sometimes wraps JSON in.
          const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
          try {
            const parsed = JSON.parse(cleaned);
            if (typeof parsed.reply === 'string') {
              return resolve({ reply: parsed.reply, escalate: !!parsed.escalate });
            }
          } catch {}
          // Fallback: hand back the raw text, don't escalate.
          resolve({ reply: text || 'Sorry, I had trouble processing that. Could you rephrase?', escalate: false });
        } catch (err) {
          console.error('[line] Claude parse failed:', err.message);
          resolve({ reply: 'Sorry, I had a technical problem. I will flag this to Korakot.', escalate: true });
        }
      });
    });
    req.on('error', (err) => {
      console.error('[line] Claude request failed:', err.message);
      resolve({ reply: 'Sorry, I had a technical problem. I will flag this to Korakot.', escalate: true });
    });
    req.write(body);
    req.end();
  });
}

async function _notifyKorakotLine(userId, history, latestMessage) {
  const korakotId = process.env.LINE_KORAKOT_USER_ID;
  if (!korakotId || !lineClient) return;
  let clientName = 'A client';
  try {
    const profile = await lineClient.getProfile(userId);
    clientName = profile.displayName || clientName;
  } catch {}
  const recap = history.slice(-6)
    .map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`)
    .join('\n');
  try {
    await lineClient.pushMessage({
      to: korakotId,
      messages: [{
        type: 'text',
        // Include a ready-to-copy /handover line so Korakot can mute
        // the bot for this customer with one tap before he takes over.
        text: `⚠️ Support escalation\n\n👤 ${clientName}\n💬 "${latestMessage}"\n\n${recap}\n\nTo take over:  /handover ${userId}\nTo see the chat: open LINE OA Manager.`,
      }],
    });
  } catch (err) {
    console.error('[line] escalation push failed:', err.message);
  }
}

// Reply directly to a message (used for admin command responses).
async function _replyLine(replyToken, text) {
  if (!lineClient) return;
  try {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text }],
    });
  } catch (err) {
    console.error('[line] reply failed:', err.message);
  }
}

async function _handleLineMessage(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  const userText = event.message.text;

  // (1) If this message is from Korakot AND starts with "/", treat it
  //     as an admin command — don't run Claude on it.
  if (userId === process.env.LINE_KORAKOT_USER_ID && userText.trim().startsWith('/')) {
    const adminReply = _handleAdminCommand(userText);
    if (adminReply !== null) {
      await _replyLine(event.replyToken, adminReply);
      return;
    }
  }

  const session = _lineSession(userId);
  session.history.push({ role: 'user', content: userText });

  // (2) If this customer is in handover mode, do NOT auto-reply —
  //     Korakot is handling them directly via LINE OA Manager. Keep
  //     tracking history so when /release fires, context resumes.
  if (_isMuted(userId)) {
    console.log(`[line] ${userId.slice(0,10)}… muted — skipping auto-reply`);
    return;
  }

  const recent = session.history.slice(-10);
  const reply = await _callLineClaude(recent);
  session.history.push({ role: 'assistant', content: reply.reply });

  await _replyLine(event.replyToken, reply.reply);

  // (3) Escalate when Claude self-flags. Auto-mute the customer for
  //     2h so the bot stops chiming in while Korakot takes over — he
  //     can extend with /handover or release early with /release.
  //
  //     SKIP both when Korakot is testing from his own LINE account
  //     (userId === LINE_KORAKOT_USER_ID). Otherwise the "DM Korakot"
  //     push lands in the same chat thread he's testing from, and the
  //     auto-mute would silence the bot on his own LINE for 2h.
  if (reply.escalate) {
    session.unresolvedTurns += 1;
    if (session.unresolvedTurns >= 1) {
      if (userId !== process.env.LINE_KORAKOT_USER_ID) {
        await _notifyKorakotLine(userId, session.history, userText);
        lineMuted.set(userId, Date.now() + 2 * 60 * 60 * 1000);
      } else {
        console.log('[line] escalation skipped — self-test from Korakot');
      }
      session.unresolvedTurns = 0;
    }
  } else {
    session.unresolvedTurns = 0;
  }
}

app.post('/api/line/webhook', (req, res, next) => {
  if (!lineEnabled) {
    // Dormant until env vars are set. Acknowledge so LINE doesn't retry.
    console.log('[line] webhook hit but LINE_CHANNEL_* env vars not set — skipping');
    return res.sendStatus(200);
  }
  return line.middleware(lineConfig)(req, res, next);
}, async (req, res) => {
  // Always 200 immediately — handlers run async, LINE will retry if 5xx.
  res.sendStatus(200);
  for (const event of (req.body.events || [])) {
    if (event.type === 'message' && event.message?.type === 'text') {
      try { await _handleLineMessage(event); }
      catch (err) { console.error('[line] handler error:', err.message); }
    }
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('✅ EPOS server is running on port ' + PORT);
  console.log('');
  syncService.start();
  // SEPOS-060 phase 2 — desktop offline license lock. No-op in cloud mode
  // (no SQLITE_PATH). Fails open until LICENSE_PRIVATE_KEY is deployed.
  licenseClient.start();
  // SEPOS-PRO-009 — desktop till telemetry to ops. No-op in cloud mode.
  heartbeatClient.start();
  // SEPOS-PRO-003 — Mac local server subscribes to cloud Socket.io so
  // every cloud event lands on the Mac in real time. No-op in cloud mode.
  cloudRelay.start(io, syncService);
  makeWebhooks.start();
  // SEPOS-LOCAL-001 Phase 1 — morning catchup. If yesterday's archive
  // wasn't run (Mac was off after service, Z-report not closed cleanly,
  // first launch after install, etc.) generate it silently now.
  // Skipped on Railway (DB_MODE != 'local'). Wrapped in setTimeout so
  // the listen callback returns immediately and the catchup runs after
  // syncService has had a tick to settle.
  setTimeout(() => {
    try {
      const archiveService = require('./services/archiveService');
      if (!archiveService.isLocalInstall()) return;
      archiveService.archiveForDate(pool, archiveService.yesterdayStr())
        .then(r => {
          if (r?.ok && !r.pdf_skipped) console.log('[archive] catchup ✓', r.date, r.pdf?.path);
          else if (r?.pdf_skipped)     console.log('[archive] catchup —', r.date, 'already done');
        })
        .catch(err => console.warn('[archive] catchup failed:', err.message));
    } catch (e) { console.warn('[archive] catchup boot error:', e.message); }
  }, 5000);

  // SEPOS-LOCAL-001 Phase 3 — first-boot history migration. Imports
  // ALL closed orders from cloud into local SQLite, then generates
  // archive files for every historical month. Idempotent — gated by
  // sync_state.device_first_migration_done. Skipped on Railway and on
  // re-runs. Wait 8s after listen so the initial menu/staff/settings
  // sync has had a tick.
  setTimeout(() => {
    try {
      const migrationService = require('./services/migrationService');
      migrationService.runIfNeeded()
        .then(r => { if (r?.skipped) return; console.log('[migration] kickoff →', r.status); })
        .catch(err => console.warn('[migration] kickoff failed:', err.message));
    } catch (e) { console.warn('[migration] boot error:', e.message); }
  }, 8000);

  // SEPOS-LOCAL-001 Phase 4 — daily Railway slim cleanup. Deletes closed
  // orders older than 30 days. Gated on DEVICE_FIRST_MODE=true so
  // Korakot must explicitly opt-in per Railway service AFTER the client's
  // Mac has completed Phase 3 migration (otherwise cleanup would wipe
  // history before the Mac fetched it).
  if (process.env.DEVICE_FIRST_MODE === 'true' && process.env.DB_MODE !== 'local') {
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
    const runCleanup = async () => {
      try {
        const r = await pool.query(
          `DELETE FROM orders
            WHERE status = 'closed'
              AND closed_at < NOW() - INTERVAL '30 days'`
        );
        if (r.rowCount > 0) console.log(`[cleanup] removed ${r.rowCount} closed orders older than 30 days`);
      } catch (err) { console.warn('[cleanup] failed:', err.message); }
    };
    setInterval(runCleanup, CLEANUP_INTERVAL_MS);
    setTimeout(runCleanup, 30 * 1000); // first run 30s after boot
    console.log('[cleanup] DEVICE_FIRST_MODE=true — Railway 30-day cleanup armed');
  }
});
